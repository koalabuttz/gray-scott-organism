/**
 * §4.1 long-form clock: speed scaling (0.25–6, deviation 31), pause, debt bounds, arc-time
 * derivation, and the measured step-budget guard.
 * Extends AC.4's fixed-step coverage with the long-form transport and arc timeline.
 */
import { describe, expect, it } from 'vitest';
import {
  LongFormClock,
  SPEED_CEILING,
  SPEED_RANGE,
  STEP_CAP,
  budgetedSteps,
  clampSpeed,
  deriveArcTime,
  desiredStepsPerSecond,
  EXPLORATION_SPEED_POLICY,
  formatSimTempo,
  maxStepsWithinBudget,
  PRESENTATION_SPEED_POLICY,
  SPEED_POLICIES,
  speedCeiling,
  speedPolicyForResolution,
  TEMPO_TOLERANCE_FRACTION,
  TEMPO_TOLERANCE_STEPS_PER_SECOND,
  type StepBudget,
} from '../src/core/longform.ts';
import { EXPLORATION, TIME } from '../src/config.ts';

function makeClock(speed = 1): LongFormClock {
  return new LongFormClock({
    dt: TIME.dt,
    nominalStepsPerSecond: TIME.nominalStepsPerSecond,
    maxStepsPerFrame: TIME.maxStepsPerFrame,
    realDeltaBoundSeconds: TIME.realDeltaBoundSeconds,
    debtBoundSeconds: TIME.debtBoundSeconds,
    speed,
  });
}

function drive(clock: LongFormClock, hz: number, seconds: number): number {
  let steps = 0;
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i += 1) steps += clock.advance(1 / hz).steps;
  return steps;
}

describe('long-form clock: speed scaling', () => {
  it('derives performance time from delivered steps at the nominal rate', () => {
    const clock = makeClock(1);
    drive(clock, 60, 10);
    expect(clock.performanceSeconds).toBeCloseTo(clock.steps / TIME.nominalStepsPerSecond, 9);
    expect(clock.simulationTime).toBeCloseTo(clock.steps * TIME.dt, 9);
  });

  it('halves and doubles delivered work with playback speed', () => {
    const half = makeClock(0.5);
    const double = makeClock(2);
    const halfSteps = drive(half, 60, 10);
    const doubleSteps = drive(double, 60, 10);
    expect(halfSteps).toBeCloseTo(600, -1);
    expect(doubleSteps).toBeCloseTo(2400, -1);
    expect(doubleSteps / halfSteps).toBeCloseTo(4, 0);
  });

  it('clamps speed into the supported 0.25–6 range', () => {
    expect(SPEED_RANGE).toEqual([0.25, 6]);
    expect(clampSpeed(10)).toBe(6);
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(2)).toBe(2);
    expect(clampSpeed(Number.NaN)).toBe(0.25);

    const clock = makeClock(1);
    clock.setSpeed(100);
    expect(clock.speed).toBe(6);
    clock.setSpeed(-1);
    expect(clock.speed).toBe(0.25);
    const stepsAtMax = drive(clock, 60, 1);
    expect(stepsAtMax).toBeCloseTo(0.25 * TIME.nominalStepsPerSecond, -1);
  });

  it('bounds a single frame and accumulated debt like the fixed-step clock', () => {
    const clock = makeClock(1);
    // At 1x the bounded hitch (0.1 s * 120 = 12 steps) sits exactly at the cap, so it is delivered
    // whole; the cap binds — and reports overload — only once more work is requested per frame.
    const atOneX = clock.advance(1.0);
    expect(atOneX.steps).toBe(TIME.maxStepsPerFrame);
    expect(atOneX.overloaded).toBe(false);

    const fast = makeClock(4);
    const hitch = fast.advance(1.0);
    expect(hitch.steps).toBe(TIME.maxStepsPerFrame);
    expect(hitch.overloaded).toBe(true);
    expect(fast.debtBoundSteps).toBeCloseTo(TIME.debtBoundSeconds * TIME.nominalStepsPerSecond, 9);
    for (let i = 0; i < 50; i += 1) fast.advance(0.1);
    expect(fast.advance(0).steps).toBeLessThanOrEqual(TIME.maxStepsPerFrame);
  });

  it('suspends transport while paused and resumes without backlog', () => {
    const clock = makeClock(1);
    clock.setPaused(true);
    for (let i = 0; i < 100; i += 1) clock.advance(0.05);
    expect(clock.steps).toBe(0);
    expect(clock.performanceSeconds).toBe(0);
    clock.setPaused(false);
    expect(clock.advance(1 / 60).steps).toBe(2);
  });
});

describe('long-form clock: arc-time derivation', () => {
  it('derives arc elapsed time and increments the arc index', () => {
    const clock = makeClock(1);
    expect(clock.arc).toBe(0);
    expect(clock.arcSeconds).toBe(0);

    drive(clock, 60, 10);
    const elapsedBefore = clock.performanceSeconds;
    expect(clock.arcSeconds).toBeCloseTo(elapsedBefore, 9);

    clock.beginArc();
    expect(clock.arc).toBe(1);
    expect(clock.arcSeconds).toBeCloseTo(0, 9);

    drive(clock, 60, 5);
    expect(clock.arcSeconds).toBeCloseTo(5, 1);
    // arcTimeAt is pure and agrees with arcSeconds.
    expect(clock.arcTimeAt(clock.performanceSeconds)).toBeCloseTo(clock.arcSeconds, 9);
  });

  it('deriveArcTime is a pure, non-negative difference', () => {
    expect(deriveArcTime(100, 40)).toBe(60);
    expect(deriveArcTime(30, 40)).toBe(0);
    expect(deriveArcTime(0, 0)).toBe(0);
  });

  it('reset clears transport and arc state', () => {
    const clock = makeClock(1);
    drive(clock, 60, 3);
    clock.beginArc();
    clock.reset();
    expect(clock.steps).toBe(0);
    expect(clock.performanceSeconds).toBe(0);
    expect(clock.arc).toBe(0);
    expect(clock.arcSeconds).toBe(0);
  });
});

describe('§4.1 step-budget guard and speed ceiling (deviation 31)', () => {
  const generous: StepBudget = { fixedFrameMs: 0, perStepMs: 0.01, framePeriodMs: 100, safetyMargin: 0 };

  it('ties the configured cap to its 60 fps speed ceiling', () => {
    expect(STEP_CAP).toBe(TIME.maxStepsPerFrame);
    expect(SPEED_CEILING).toBe(speedCeiling(STEP_CAP, TIME.nominalStepsPerSecond, 60));
    expect(SPEED_CEILING).toBe(TIME.speedRange[1]);
    expect(speedCeiling(8, 120, 60)).toBe(4);
    expect(desiredStepsPerSecond(TIME.speedRange[1])).toBe(SPEED_CEILING * TIME.nominalStepsPerSecond);
    expect(desiredStepsPerSecond(1)).toBe(TIME.nominalStepsPerSecond);
  });

  it('derives the largest steps/frame that fits the frame period, with margin', () => {
    // 16.7 ms period, 0.15 margin, 10 ms fixed, 0.5 ms/step -> (14.17 - 10) / 0.5 = 8.3 -> 8
    expect(
      maxStepsWithinBudget({ fixedFrameMs: 10, perStepMs: 0.5, framePeriodMs: 1000 / 60, safetyMargin: 0.15 }),
    ).toBe(8);
    // No room at all when the fixed cost already fills the margined period.
    expect(
      maxStepsWithinBudget({ fixedFrameMs: 20, perStepMs: 0.5, framePeriodMs: 1000 / 60, safetyMargin: 0.15 }),
    ).toBe(0);
    // A non-positive step cost is not a licence to run forever.
    expect(maxStepsWithinBudget({ fixedFrameMs: 0, perStepMs: 0, framePeriodMs: 100, safetyMargin: 0 })).toBe(0);
  });

  it('refuses to exceed the cap, however much work is requested', () => {
    expect(budgetedSteps(10_000, TIME.maxStepsPerFrame, generous)).toBe(TIME.maxStepsPerFrame);
    expect(budgetedSteps(4, TIME.maxStepsPerFrame, generous)).toBe(4);
    expect(budgetedSteps(-5, TIME.maxStepsPerFrame, generous)).toBe(0);
    // The measured budget can bind below the cap too.
    const tight: StepBudget = { fixedFrameMs: 10, perStepMs: 1, framePeriodMs: 1000 / 60, safetyMargin: 0.15 };
    expect(budgetedSteps(1000, TIME.maxStepsPerFrame, tight)).toBe(4);
    expect(budgetedSteps(1000, TIME.maxStepsPerFrame, tight)).toBeLessThan(TIME.maxStepsPerFrame);
  });

  it('degrades gracefully when the cap binds: delivered tracks work, never the request', () => {
    const clock = makeClock(TIME.speedRange[1]);
    // At 30 Hz the request is speed * 120 / 30 = 24 steps/frame, above the 12-step cap.
    const allocation = clock.advance(1 / 30);
    expect(allocation.steps).toBe(TIME.maxStepsPerFrame);
    expect(allocation.overloaded).toBe(true);
    // Performance time (and simulation time) track *delivered* work exactly — dt is never enlarged.
    expect(clock.performanceSeconds).toBeCloseTo(allocation.steps / TIME.nominalStepsPerSecond, 9);
    expect(clock.simulationTime).toBeCloseTo(allocation.steps * TIME.dt, 9);
    const requestedStepsThisFrame = (TIME.speedRange[1] * TIME.nominalStepsPerSecond) / 30;
    expect(requestedStepsThisFrame).toBeGreaterThan(allocation.steps);

    // At 60 Hz the same speed fits exactly in the cap, so nothing is lost.
    const atSixty = makeClock(TIME.speedRange[1]);
    const frame = atSixty.advance(1 / 60);
    expect(frame.steps).toBe(TIME.maxStepsPerFrame);
    expect(frame.overloaded).toBe(false);
  });
});

describe('§10 sim tempo readout (requested vs delivered)', () => {
  it('reports the delivered multiple when the cap binds', () => {
    const text = formatSimTempo({ speed: 6, deliveredStepsPerSecond: 600 });
    expect(text).toBe('sim tempo: 6.00× requested · 5.00× delivered (600 of 720 steps/s — cap binds)');
  });

  it('reports a single multiple when the request is met', () => {
    expect(formatSimTempo({ speed: 1, deliveredStepsPerSecond: 120 })).toBe(
      'sim tempo: 1.00× (120 of 120 steps/s)',
    );
    expect(formatSimTempo({ speed: 4, deliveredStepsPerSecond: 480 })).toBe(
      'sim tempo: 4.00× (480 of 480 steps/s)',
    );
  });

  it('says it is still measuring before a delivery window has populated', () => {
    expect(formatSimTempo({ speed: 1 })).toBe('sim tempo: 1.00× requested (120 steps/s, measuring…)');
    expect(formatSimTempo({ speed: 1, deliveredStepsPerSecond: 0 })).toBe(
      'sim tempo: 1.00× requested (120 steps/s, measuring…)',
    );
    expect(formatSimTempo({ speed: 1 })).toContain('measuring');
  });

  it('never presents the requested multiple as the delivered one', () => {
    const capped = formatSimTempo({ speed: 6, deliveredStepsPerSecond: 480 });
    expect(capped).toContain('6.00× requested');
    expect(capped).toContain('4.00× delivered');
    expect(capped).not.toContain('6.00× delivered');
    // The panel ceiling case: 12 steps * 49.95 Hz = 599.4 steps/s, i.e. ~600 of 720.
    expect(formatSimTempo({ speed: 6, deliveredStepsPerSecond: 600 })).toContain('5.00× delivered');
  });

  it('does not present requested as delivered under over-delivery (stale window)', () => {
    // The old code took the "uncapped" branch for any delivered + 0.5 >= desired and printed only
    // the requested multiple, so a stale window read "1.00x (600 of 120 steps/s)".
    const text = formatSimTempo({ speed: 1, deliveredStepsPerSecond: 600 });
    expect(text).toBe('sim tempo: 1.00× requested · 5.00× delivered (600 of 120 steps/s — stale measurement)');
    expect(text).not.toContain('(600 of 120 steps/s)');
  });

  it('handles a 6x -> 1x stale transition', () => {
    // Right after lowering 6x -> 1x the delivery window still reports the 6x rate for up to a second.
    const stale = formatSimTempo({ speed: 1, deliveredStepsPerSecond: 660 });
    expect(stale).toContain('1.00× requested');
    expect(stale).toContain('5.50× delivered');
    expect(stale).toContain('stale measurement');
    // Once the window catches up it is a plain uncapped readout.
    expect(formatSimTempo({ speed: 1, deliveredStepsPerSecond: 121 })).toBe(
      'sim tempo: 1.00× (121 of 120 steps/s)',
    );
  });

  it('uses a documented tolerance around the requested rate, on both sides', () => {
    // Tolerance = max(1 step/s, 2% of the request). Speed 4 -> 480 steps/s, tolerance 9.6.
    expect(formatSimTempo({ speed: 4, deliveredStepsPerSecond: 480 + 9 })).toContain('4.00× (489 of 480');
    expect(formatSimTempo({ speed: 4, deliveredStepsPerSecond: 480 - 9 })).toContain('4.00× (471 of 480');
    expect(formatSimTempo({ speed: 4, deliveredStepsPerSecond: 480 + 11 })).toContain('stale measurement');
    expect(formatSimTempo({ speed: 4, deliveredStepsPerSecond: 480 - 11 })).toContain('cap binds');
    // Speed 0.25 -> 30 steps/s, where the 1 step/s absolute floor dominates the 2% term.
    expect(TEMPO_TOLERANCE_STEPS_PER_SECOND).toBe(1);
    expect(TEMPO_TOLERANCE_FRACTION).toBe(0.02);
    expect(formatSimTempo({ speed: 0.25, deliveredStepsPerSecond: 31 })).toContain('0.25× (31 of 30');
    expect(formatSimTempo({ speed: 0.25, deliveredStepsPerSecond: 32 })).toContain('stale measurement');
  });
});

describe('§10 resolution-dependent speed policy (deviation 34)', () => {
  it('exposes exactly one policy per supported grid, keyed by resolution', () => {
    expect(SPEED_POLICIES.map((policy) => policy.resolution)).toEqual([768, 512]);
    expect(speedPolicyForResolution(768)).toBe(PRESENTATION_SPEED_POLICY);
    expect(speedPolicyForResolution(512)).toBe(EXPLORATION_SPEED_POLICY);
    // An unrecognised resolution falls back to presentation — never to a silent widening.
    expect(speedPolicyForResolution(1024)).toBe(PRESENTATION_SPEED_POLICY);
    expect(speedPolicyForResolution(64)).toBe(PRESENTATION_SPEED_POLICY);
  });

  it('ties each cap to its own 60 fps ceiling and speed range', () => {
    for (const policy of SPEED_POLICIES) {
      expect(policy.speedCeiling).toBe(speedCeiling(policy.stepCap, TIME.nominalStepsPerSecond, 60));
      expect(policy.speedRange[1]).toBe(policy.speedCeiling);
      expect(policy.speedRange[0]).toBe(0.25);
    }
    expect(PRESENTATION_SPEED_POLICY.stepCap).toBe(TIME.maxStepsPerFrame);
    expect(PRESENTATION_SPEED_POLICY.speedRange).toEqual(TIME.speedRange);
    expect(EXPLORATION_SPEED_POLICY.stepCap).toBe(EXPLORATION.maxStepsPerFrame);
    expect(EXPLORATION_SPEED_POLICY.speedRange).toEqual(EXPLORATION.speedRange);
  });

  it('gives the coarser exploration grid a strictly higher cap, ceiling and range', () => {
    expect(EXPLORATION_SPEED_POLICY.resolution).toBe(512);
    expect(EXPLORATION_SPEED_POLICY.stepCap).toBeGreaterThan(PRESENTATION_SPEED_POLICY.stepCap);
    expect(EXPLORATION_SPEED_POLICY.speedCeiling).toBeGreaterThan(PRESENTATION_SPEED_POLICY.speedCeiling);
    expect(EXPLORATION_SPEED_POLICY.speedRange[1]).toBeGreaterThan(PRESENTATION_SPEED_POLICY.speedRange[1]);
  });

  it('keeps every cap inside its own measured budget and frame period', () => {
    for (const policy of SPEED_POLICIES) {
      // The cap is still bounded by the measured budget it was derived from...
      expect(maxStepsWithinBudget(policy.budget)).toBeGreaterThanOrEqual(policy.stepCap);
      // ...and its predicted frame cost fits the period the policy was measured on.
      const predicted = policy.budget.fixedFrameMs + policy.stepCap * policy.budget.perStepMs;
      expect(predicted).toBeLessThan(policy.budget.framePeriodMs);
    }
  });

  it('records the measured 512² per-step cost as cheaper than 768², by roughly the cell ratio', () => {
    const ratio =
      EXPLORATION_SPEED_POLICY.budget.perStepMs / PRESENTATION_SPEED_POLICY.budget.perStepMs;
    expect(ratio).toBeLessThan(1);
    // The 512² budget floor is ~0.44x of the 768² floor, tracking their cell counts (0.444x).
    expect(ratio).toBeGreaterThan(0.2);
  });

  it('clamps a speed request into the range of the resolution that is active', () => {
    // This is the pure part of "switching resolution changes the permitted speed": the same request
    // is accepted at 512² and clamped at 768².
    expect(clampSpeed(12, EXPLORATION_SPEED_POLICY.speedRange)).toBe(12);
    expect(clampSpeed(12, PRESENTATION_SPEED_POLICY.speedRange)).toBe(6);
    expect(clampSpeed(99, EXPLORATION_SPEED_POLICY.speedRange)).toBe(12);
    expect(clampSpeed(0.1, EXPLORATION_SPEED_POLICY.speedRange)).toBe(0.25);
    // A clock built for each policy delivers at most that policy's cap.
    const exploring = new LongFormClock({
      speed: 12,
      speedRange: EXPLORATION_SPEED_POLICY.speedRange,
      maxStepsPerFrame: EXPLORATION_SPEED_POLICY.stepCap,
    });
    expect(exploring.advance(1 / 60).steps).toBe(EXPLORATION_SPEED_POLICY.stepCap);
    const presenting = new LongFormClock({ speed: 6, maxStepsPerFrame: PRESENTATION_SPEED_POLICY.stepCap });
    expect(presenting.advance(1 / 60).steps).toBe(PRESENTATION_SPEED_POLICY.stepCap);
  });
});
