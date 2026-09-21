/**
 * §4.1 long-form transport clock.
 *
 * Phase 1's `FixedStepClock` already owns the fixed-step arithmetic. `LongFormClock` wraps it to
 * add the two things the long-form (10–30 minute) use needs on top:
 *
 *   1. **speed is clamped to the documented 0.25–6 range.** §10 originally said 0.25–4; the ceiling
 *      was raised on measured headroom (`artifacts/pacing.json`) in response to operator pacing
 *      feedback, and recorded as deviation 31. The upper bound is the step-budget-derived cap at
 *      60 fps: `speedCeiling(maxStepsPerFrame)` (12 steps/frame -> 6x).
 *   2. **arc-time derivation.** `performanceSeconds` is the transport; the piece's composition
 *      runs in "arcs" whose boundary is an event, not a wall clock. The clock records the
 *      performance-seconds value at which the current arc began and derives the arc elapsed time
 *      and index from it, so the curator and director can both ask "how far into this arc are we?"
 *      without inventing a second timeline.
 *
 * All of it is pure logic: no `requestAnimationFrame`, no wall-clock reads, no DOM.
 */
import { FixedStepClock, clamp } from './clock.ts';
import { EXPLORATION, EXPLORATION_GRID, SIMULATION_GRID, TIME } from '../config.ts';
import type { ClockState } from './types.ts';

/** §4.1/§10: playback speed range. Values outside are clamped, never honoured. */
export const SPEED_RANGE = [0.25, 6] as const;

export interface LongFormClockOptions {
  dt?: number;
  nominalStepsPerSecond?: number;
  maxStepsPerFrame?: number;
  realDeltaBoundSeconds?: number;
  debtBoundSeconds?: number;
  speed?: number;
  speedRange?: readonly [number, number];
}

export interface LongFormAllocation {
  /** Integer steps the caller must execute this frame (0..maxStepsPerFrame). */
  steps: number;
  /** True when the requested work exceeded the per-frame maximum. */
  overloaded: boolean;
  /** Real delta after bounding, in seconds. */
  boundedDelta: number;
}

// -------------------------------------------------------------------------------------------------
// Step-budget guard (§4.1: "integer steps under an eight-step/frame maximum *and measured simulation
// budget*"). The cap is a measured quantity, not a guess: `artifacts/pacing.json` records the
// drained cost of a 1080p frame at the production grid for several bursts, from which a fixed
// per-frame cost and a marginal per-step cost are fitted.
// -------------------------------------------------------------------------------------------------

/** A measured per-frame cost model: `fixedFrameMs + steps * perStepMs`. */
export interface StepBudget {
  /** Measured fixed per-frame cost (publish + render + post + the drain readback), ms. */
  fixedFrameMs: number;
  /** Measured marginal cost of one simulation step at the production grid, ms. */
  perStepMs: number;
  /** The frame period the total frame cost must fit inside, ms. */
  framePeriodMs: number;
  /** Fraction of the frame period reserved for browser/driver variance and presentation. */
  safetyMargin: number;
}

/**
 * Largest steps/frame whose predicted *total* frame cost stays inside the safety-margined frame
 * period. Returns 0 when even the fixed cost alone cannot fit, so a caller can tell "no room" from
 * "one step".
 */
export function maxStepsWithinBudget(budget: StepBudget): number {
  if (!(budget.perStepMs > 0)) return 0;
  const usableMs = budget.framePeriodMs * (1 - budget.safetyMargin) - budget.fixedFrameMs;
  return Math.max(0, Math.floor(usableMs / budget.perStepMs));
}

/**
 * The budget guard: the number of steps a frame may actually run — never more than the caller
 * requested, never more than the hard `cap`, and never more than the measured budget allows.
 */
export function budgetedSteps(requested: number, cap: number, budget: StepBudget): number {
  const bounded = Math.max(0, Math.floor(requested));
  return Math.min(bounded, cap, maxStepsWithinBudget(budget));
}

/**
 * Playback speed a steps/frame cap supports at `fps` frames per second (§10's ceiling conversion).
 * At the nominal 120 steps/s, a frame at speed S needs `S * 120 / fps` steps.
 */
export function speedCeiling(cap: number, nominalStepsPerSecond = 120, fps = 60): number {
  return (cap * fps) / nominalStepsPerSecond;
}

/** Work the transport is asking for at a given speed, in steps per second. */
export function desiredStepsPerSecond(speed: number, nominalStepsPerSecond = 120): number {
  return speed * nominalStepsPerSecond;
}

export interface TempoReading {
  /** Requested playback speed (the slider value). */
  speed: number;
  /**
   * Measured delivered simulation steps per second. 0 or undefined before a delivery window has
   * populated (the app reports 0 until its first one-second window closes).
   */
  deliveredStepsPerSecond?: number;
  nominalStepsPerSecond?: number;
}

/** Absolute floor of the "requested ≈ delivered" tolerance, in steps/s. */
export const TEMPO_TOLERANCE_STEPS_PER_SECOND = 1;
/** Fractional part of the "requested ≈ delivered" tolerance (2% of the requested rate). */
export const TEMPO_TOLERANCE_FRACTION = 0.02;

/**
 * §10 laboratory tempo readout.
 *
 * The displayed real-time multiple is derived from the **measured delivered** steps/s (÷ nominal),
 * never from the requested speed alone. The single-multiple form is used *only* when the delivery is
 * within tolerance of the request (`|delivered − requested| ≤ max(1 step/s, 2% of the request)`);
 * otherwise both are shown, with the reason:
 *
 *  - under-delivery (the steps/frame cap binds): `6.00x requested · 5.00x delivered (600 of 720
 *    steps/s — cap binds)`
 *  - over-delivery, which is what a *stale* delivery window looks like in the second after the speed
 *    is lowered (the window still reports the old, higher rate): `1.00x requested · 5.00x delivered
 *    (600 of 120 steps/s — stale measurement)`
 *
 * Collapsing over-delivery into a single misleading multiple is exactly the bug this replaces: with
 * `{speed: 1, deliveredStepsPerSecond: 600}` the old code printed "1.00x (600 of 120 steps/s)".
 * Before any delivery window has populated it reports the request and says it is still measuring.
 */
export function formatSimTempo(reading: TempoReading): string {
  const nominal = reading.nominalStepsPerSecond ?? 120;
  const requested = reading.speed;
  const desired = desiredStepsPerSecond(requested, nominal);
  const delivered = reading.deliveredStepsPerSecond;
  if (delivered === undefined || !(delivered > 0)) {
    return `sim tempo: ${requested.toFixed(2)}× requested (${desired.toFixed(0)} steps/s, measuring…)`;
  }
  const deliveredMultiple = delivered / nominal;
  const tolerance = Math.max(TEMPO_TOLERANCE_STEPS_PER_SECOND, TEMPO_TOLERANCE_FRACTION * desired);
  if (Math.abs(delivered - desired) <= tolerance) {
    return `sim tempo: ${requested.toFixed(2)}× (${delivered.toFixed(0)} of ${desired.toFixed(0)} steps/s)`;
  }
  const reason = delivered > desired ? 'stale measurement' : 'cap binds';
  return (
    `sim tempo: ${requested.toFixed(2)}× requested · ${deliveredMultiple.toFixed(2)}× delivered ` +
    `(${delivered.toFixed(0)} of ${desired.toFixed(0)} steps/s — ${reason})`
  );
}

/** The configured hard cap and its 60 fps speed ceiling, kept in one place. */
export const STEP_CAP = TIME.maxStepsPerFrame;
export const SPEED_CEILING = speedCeiling(STEP_CAP, TIME.nominalStepsPerSecond, 60);

/**
 * §10 resolution-dependent speed policy.
 *
 * The steps/frame cap is a *measured* quantity that depends on the simulation grid: a coarser grid
 * costs less per step, so the same frame budget buys more steps. Rather than scattering that fact
 * across conditionals, each supported resolution owns a policy that bundles the grid, the measured
 * cap, the speed range it supports and the measured budget behind the cap.
 */
export interface ResolutionSpeedPolicy {
  /** Square simulation grid edge, in chemical cells. */
  readonly resolution: number;
  /** Hard steps/frame cap measured for this resolution. */
  readonly stepCap: number;
  /** Playback speed range this resolution supports. */
  readonly speedRange: readonly [number, number];
  /** The measured `StepBudget` model behind `stepCap` (provenance; see `artifacts/pacing.json`). */
  readonly budget: StepBudget;
  /** 60 fps speed ceiling implied by `stepCap` (`stepCap * 60 / nominal`). */
  readonly speedCeiling: number;
}

function makePolicy(
  resolution: number,
  stepCap: number,
  speedRange: readonly [number, number],
  budget: StepBudget,
): ResolutionSpeedPolicy {
  return { resolution, stepCap, speedRange, budget, speedCeiling: speedCeiling(stepCap, TIME.nominalStepsPerSecond, 60) };
}

/** 768²: the presentation grid (deviation 31). */
export const PRESENTATION_SPEED_POLICY: ResolutionSpeedPolicy = makePolicy(
  SIMULATION_GRID.width,
  TIME.maxStepsPerFrame,
  TIME.speedRange,
  { fixedFrameMs: 10.5, perStepMs: 0.5, framePeriodMs: 1000 / 49.95, safetyMargin: 0.15 },
);

/** 512²: the lab-only exploration grid (deviation 34). */
export const EXPLORATION_SPEED_POLICY: ResolutionSpeedPolicy = makePolicy(
  EXPLORATION_GRID.width,
  EXPLORATION.maxStepsPerFrame,
  EXPLORATION.speedRange,
  { fixedFrameMs: 11.0, perStepMs: 0.22, framePeriodMs: 1000 / 49.95, safetyMargin: 0.15 },
);

export const SPEED_POLICIES: readonly ResolutionSpeedPolicy[] = [
  PRESENTATION_SPEED_POLICY,
  EXPLORATION_SPEED_POLICY,
];

/** The policy for a simulation grid edge, falling back to presentation for anything unrecognised. */
export function speedPolicyForResolution(resolution: number): ResolutionSpeedPolicy {
  return SPEED_POLICIES.find((policy) => policy.resolution === resolution) ?? PRESENTATION_SPEED_POLICY;
}

/** Clamp a speed request into the supported playback range. */
export function clampSpeed(speed: number, range: readonly [number, number] = SPEED_RANGE): number {
  if (!Number.isFinite(speed)) return range[0];
  return clamp(speed, range[0], range[1]);
}

/**
 * Pure arc-time derivation: performance seconds elapsed since the arc began.
 * A negative start (no arc yet) is treated as zero elapsed.
 */
export function deriveArcTime(performanceSeconds: number, arcStartPerformanceSeconds: number): number {
  return Math.max(0, performanceSeconds - arcStartPerformanceSeconds);
}

export class LongFormClock {
  private readonly clock: FixedStepClock;
  private readonly speedRange: readonly [number, number];
  private arcStartPerformanceSeconds = 0;
  private arcIndex = 0;

  constructor(options: LongFormClockOptions = {}) {
    this.speedRange = options.speedRange ?? SPEED_RANGE;
    this.clock = new FixedStepClock({
      dt: options.dt,
      nominalStepsPerSecond: options.nominalStepsPerSecond,
      maxStepsPerFrame: options.maxStepsPerFrame,
      realDeltaBoundSeconds: options.realDeltaBoundSeconds,
      debtBoundSeconds: options.debtBoundSeconds,
      speed: clampSpeed(options.speed ?? 1, this.speedRange),
    });
  }

  get dt(): number {
    return this.clock.dt;
  }

  get nominalStepsPerSecond(): number {
    return this.clock.nominalStepsPerSecond;
  }

  get maxStepsPerFrame(): number {
    return this.clock.maxStepsPerFrame;
  }

  get debtBoundSeconds(): number {
    return this.clock.debtBoundSeconds;
  }

  get debtBoundSteps(): number {
    return this.clock.debtBoundSteps;
  }

  get realSeconds(): number {
    return this.clock.realSeconds;
  }

  /** Delivered work converted back to the nominal rate. */
  get performanceSeconds(): number {
    return this.clock.performanceSeconds;
  }

  get simulationTime(): number {
    return this.clock.simulationTime;
  }

  get steps(): number {
    return this.clock.steps;
  }

  get paused(): boolean {
    return this.clock.paused;
  }

  get speed(): number {
    return this.clock.speed;
  }

  get overloaded(): boolean {
    return this.clock.overloaded;
  }

  /** Arc index; incremented by `beginArc()`. */
  get arc(): number {
    return this.arcIndex;
  }

  /** Performance seconds elapsed since the current arc began. */
  get arcSeconds(): number {
    return deriveArcTime(this.performanceSeconds, this.arcStartPerformanceSeconds);
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
  }

  /** Set playback speed, clamped to the supported range. */
  setSpeed(speed: number): void {
    this.clock.setSpeed(clampSpeed(speed, this.speedRange));
  }

  advance(realDelta: number): LongFormAllocation {
    return this.clock.advance(realDelta);
  }

  /** Attribute delivered steps without advancing real time (tests and replays). */
  accountSteps(steps: number): void {
    this.clock.accountSteps(steps);
  }

  /**
   * Mark the start of a new arc at the current performance time. Called by the app at the arc
   * boundary (`phase.arc` increment) so `arcSeconds` restarts from zero.
   */
  beginArc(): void {
    this.arcStartPerformanceSeconds = this.performanceSeconds;
    this.arcIndex += 1;
  }

  /** Arc time at an arbitrary performance-seconds value (pure; no state mutation). */
  arcTimeAt(performanceSeconds: number): number {
    return deriveArcTime(performanceSeconds, this.arcStartPerformanceSeconds);
  }

  reset(): void {
    this.clock.reset();
    this.arcStartPerformanceSeconds = 0;
    this.arcIndex = 0;
  }

  state(): ClockState {
    return this.clock.state();
  }
}
