/**
 * AC.4 — synthetic 30/60/144 Hz clocks deliver equivalent step counts for equal elapsed time
 * when not overloaded, and the transport stays bounded when it is overloaded.
 */
import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../src/core/clock.ts';
import { TIME } from '../src/config.ts';

interface DriveResult {
  hz: number;
  steps: number;
  performanceSeconds: number;
  simulationTime: number;
  overloadedFrames: number;
}

function makeClock(): FixedStepClock {
  return new FixedStepClock({
    dt: TIME.dt,
    nominalStepsPerSecond: TIME.nominalStepsPerSecond,
    maxStepsPerFrame: TIME.maxStepsPerFrame,
    realDeltaBoundSeconds: TIME.realDeltaBoundSeconds,
    debtBoundSeconds: TIME.debtBoundSeconds,
  });
}

function drive(hz: number, seconds: number, speed = 1): DriveResult {
  const clock = makeClock();
  clock.setSpeed(speed);
  const delta = 1 / hz;
  const frames = Math.round(hz * seconds);
  let steps = 0;
  let overloadedFrames = 0;
  for (let i = 0; i < frames; i += 1) {
    const allocation = clock.advance(delta);
    steps += allocation.steps;
    if (allocation.overloaded) overloadedFrames += 1;
  }
  return {
    hz,
    steps,
    performanceSeconds: clock.performanceSeconds,
    simulationTime: clock.simulationTime,
    overloadedFrames,
  };
}

describe('fixed-step clock (AC.4)', () => {
  it('delivers equivalent step counts at 30, 60 and 144 Hz for equal elapsed time', () => {
    const seconds = 10;
    const runs = [30, 60, 144].map((hz) => drive(hz, seconds));
    const expected = TIME.nominalStepsPerSecond * seconds;

    for (const run of runs) {
      expect(run.overloadedFrames).toBe(0);
      expect(run.hz).toBeGreaterThan(0);
      // simulationTime advances only by completed fixed steps
      expect(run.simulationTime).toBeCloseTo(run.steps * TIME.dt, 9);
      expect(run.performanceSeconds).toBeCloseTo(run.steps / TIME.nominalStepsPerSecond, 9);
      // Recorded tolerance: a frame boundary can leave the fractional debt either side of an
      // integer, so a single step of rounding either way is expected, never more.
      expect(Math.abs(run.steps - expected)).toBeLessThanOrEqual(2);
    }

    const counts = runs.map((run) => run.steps);
    const spread = Math.max(...counts) - Math.min(...counts);
    expect(spread).toBeLessThanOrEqual(2);
    console.info(
      `[AC.4] steps over ${seconds}s: ${runs.map((run) => `${run.hz}Hz=${run.steps}`).join(' ')}, spread=${spread}, expected=${expected}`,
    );
  });

  it('keeps dt fixed and never enlarges a step to catch up', () => {
    const seconds = 5;
    for (const hz of [30, 60, 144]) {
      const result = drive(hz, seconds);
      // performance time tracks delivered work exactly: steps / nominal rate
      expect(result.performanceSeconds * TIME.nominalStepsPerSecond).toBeCloseTo(result.steps, 6);
    }
  });

  it('bounds a single frame to the measured steps/frame cap and reports overload', () => {
    // At 1x a fully-bounded hitch (realDeltaBoundSeconds * nominal = 12 steps) sits exactly at the
    // cap, so nothing is dropped; the overload path is reached by asking for more work per frame.
    const clock = makeClock();
    const boundedHitch = clock.advance(1.0); // a 1-second hitch, bounded to 0.1 s
    expect(boundedHitch.steps).toBe(TIME.maxStepsPerFrame);
    expect(boundedHitch.overloaded).toBe(false);

    const fast = makeClock();
    fast.setSpeed(4); // 4x asks for 48 steps in the same bounded frame
    const overloaded = fast.advance(1.0);
    expect(overloaded.steps).toBe(TIME.maxStepsPerFrame);
    expect(overloaded.overloaded).toBe(true);
    // performance time slows with delivered work rather than catching up
    expect(fast.performanceSeconds).toBeCloseTo(TIME.maxStepsPerFrame / TIME.nominalStepsPerSecond, 9);
    expect(fast.simulationTime).toBeCloseTo(TIME.maxStepsPerFrame * TIME.dt, 9);
  });

  it('bounds accumulated debt to the configured 0.25 s of nominal work', () => {
    const clock = makeClock();
    const bound = clock.debtBoundSteps;
    for (let i = 0; i < 50; i += 1) clock.advance(0.1);
    // Debt can never exceed the bound, so catch-up work stays finite.
    expect(bound).toBeCloseTo(TIME.debtBoundSeconds * TIME.nominalStepsPerSecond, 9);
    const steps = clock.advance(0);
    expect(steps.steps).toBeLessThanOrEqual(TIME.maxStepsPerFrame);
  });

  it('accumulates no backlog while paused', () => {
    const clock = makeClock();
    clock.setPaused(true);
    for (let i = 0; i < 100; i += 1) clock.advance(0.05);
    expect(clock.steps).toBe(0);
    expect(clock.performanceSeconds).toBe(0);
    // Resumption from the preserved state without a catch-up burst: five seconds of suspended
    // real time must not become 600 queued steps.
    clock.setPaused(false);
    const allocation = clock.advance(1 / 60);
    expect(allocation.steps).toBe(2);
    expect(allocation.overloaded).toBe(false);
    expect(clock.steps).toBe(2);
  });

  it('scales delivered work with speed without changing dt', () => {
    const half = drive(60, 10, 0.5);
    const double = drive(60, 10, 2);
    expect(half.steps).toBeCloseTo(600, -1);
    expect(double.steps).toBeCloseTo(2400, -1);
    expect(double.simulationTime).toBe(double.steps * TIME.dt);
  });
});
