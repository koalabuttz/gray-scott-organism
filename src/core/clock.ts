/**
 * §4.1 Independent clocks.
 *
 * Three times are tracked:
 *   1. realSeconds        — monotonic wall time (presentation interpolation, audio alignment)
 *   2. simulationTime      — advanced only by completed fixed steps (`steps * dt`)
 *   3. performanceSeconds  — delivered work converted back to nominal rate
 *
 * A request for `realDelta * speed * nominalStepsPerSecond` steps is bounded by
 * `maxStepsPerFrame` per frame; unspent debt accumulates up to `debtBoundSeconds`. When
 * overloaded, performance time simply slows with delivered work — the step size is never
 * enlarged to catch up.
 */
import type { ClockState } from './types.ts';

export interface ClockOptions {
  dt?: number;
  nominalStepsPerSecond?: number;
  maxStepsPerFrame?: number;
  realDeltaBoundSeconds?: number;
  debtBoundSeconds?: number;
  speed?: number;
}

export interface StepAllocation {
  /** Integer steps the caller must execute this frame (0..maxStepsPerFrame). */
  steps: number;
  /** True when the requested work exceeded the per-frame maximum. */
  overloaded: boolean;
  /** Real delta after bounding, in seconds. */
  boundedDelta: number;
}

export class FixedStepClock {
  readonly dt: number;
  readonly nominalStepsPerSecond: number;
  readonly maxStepsPerFrame: number;
  readonly realDeltaBoundSeconds: number;
  readonly debtBoundSeconds: number;

  private realSecondsInternal = 0;
  private performanceSecondsInternal = 0;
  private simulationTimeInternal = 0;
  private stepsInternal = 0;
  private debt = 0;
  private pausedInternal = false;
  private speedInternal: number;
  private lastOverloaded = false;

  constructor(options: ClockOptions = {}) {
    this.dt = options.dt ?? 1;
    this.nominalStepsPerSecond = options.nominalStepsPerSecond ?? 120;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 8;
    this.realDeltaBoundSeconds = options.realDeltaBoundSeconds ?? 0.1;
    this.debtBoundSeconds = options.debtBoundSeconds ?? 0.25;
    this.speedInternal = options.speed ?? 1;
  }

  get realSeconds(): number {
    return this.realSecondsInternal;
  }

  get performanceSeconds(): number {
    return this.performanceSecondsInternal;
  }

  get simulationTime(): number {
    return this.simulationTimeInternal;
  }

  get steps(): number {
    return this.stepsInternal;
  }

  get paused(): boolean {
    return this.pausedInternal;
  }

  get speed(): number {
    return this.speedInternal;
  }

  get overloaded(): boolean {
    return this.lastOverloaded;
  }

  /** Maximum debt in steps, derived from the §4.1 seconds bound. */
  get debtBoundSteps(): number {
    return this.debtBoundSeconds * this.nominalStepsPerSecond;
  }

  setPaused(paused: boolean): void {
    this.pausedInternal = paused;
    if (paused) {
      // Do not accumulate debt while suspended; resumption starts from the preserved state.
      this.debt = 0;
    }
  }

  setSpeed(speed: number): void {
    this.speedInternal = speed;
  }

  /**
   * Register elapsed real time and allocate work.
   *
   * `realDelta` is expected in seconds and is bounded internally; a tab that was suspended for
   * minutes therefore cannot demand minutes of catch-up.
   */
  advance(realDelta: number): StepAllocation {
    const boundedDelta = clamp(realDelta, 0, this.realDeltaBoundSeconds);
    this.realSecondsInternal += realDelta;
    if (this.pausedInternal) {
      this.lastOverloaded = false;
      return { steps: 0, overloaded: false, boundedDelta };
    }

    const requested = boundedDelta * this.speedInternal * this.nominalStepsPerSecond;
    this.debt = Math.min(this.debt + requested, this.debtBoundSteps);

    const available = Math.floor(this.debt);
    const steps = Math.min(available, this.maxStepsPerFrame);
    const overloaded = available > this.maxStepsPerFrame;
    this.debt -= steps;
    this.lastOverloaded = overloaded;

    if (steps <= 0) {
      return { steps: 0, overloaded, boundedDelta };
    }

    this.stepsInternal += steps;
    this.simulationTimeInternal += steps * this.dt;
    this.performanceSecondsInternal += steps / this.nominalStepsPerSecond;
    return { steps, overloaded, boundedDelta };
  }

  /** Attribute delivered steps without advancing real time (used by tests and replays). */
  accountSteps(steps: number): void {
    this.stepsInternal += steps;
    this.simulationTimeInternal += steps * this.dt;
    this.performanceSecondsInternal += steps / this.nominalStepsPerSecond;
  }

  reset(): void {
    this.realSecondsInternal = 0;
    this.performanceSecondsInternal = 0;
    this.simulationTimeInternal = 0;
    this.stepsInternal = 0;
    this.debt = 0;
    this.lastOverloaded = false;
  }

  state(): ClockState {
    return {
      realSeconds: this.realSecondsInternal,
      performanceSeconds: this.performanceSecondsInternal,
      simulationTime: this.simulationTimeInternal,
      paused: this.pausedInternal,
      speed: this.speedInternal,
    };
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
