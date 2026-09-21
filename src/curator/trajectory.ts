/**
 * §6.4 interpolation.
 *
 * Each waypoint segment is interpolated with the quintic smootherstep `6t^5 - 15t^4 + 10t^3`,
 * which is bounded on [0, 1] and has zero first *and second* derivative at both ends, so it does
 * not overshoot delicate F/k regions and deliberately slows at waypoints.
 *
 * A movement's evaluation can start from an arbitrary parameter vector ("the actual current
 * parameter vector"), not blindly from the imported first waypoint: the caller supplies a
 * `transitionFrom` vector and a crossfade window, and the output is blended from that vector into
 * the path over the window. Skip and release use a 15-second window; ordinary continuous
 * transitions use a zero-length window.
 *
 * Path progress is accumulated **incrementally** by `advanceProgress` (§6.4), never recomputed from
 * an instantaneous rate multiplied by the whole elapsed time, so a falling analysis rate or a
 * lengthening duration jitter can never move a movement backward.
 */
import type { Params } from '../core/types.ts';
import type { MovementSpec, WaypointTuple } from './schema.ts';

export type ParamTuple = WaypointTuple;

/** §6.4/§10: laboratory skip and parameter release crossfade window. */
export const DEFAULT_CROSSFADE_SECONDS = 15;

/** Quintic smootherstep, clamped to the unit interval. */
export function smootherstep(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function tupleFromParams(p: Params): ParamTuple {
  return [p.F, p.k, p.Du, p.Dv];
}

export function paramsFromTuple(p: ParamTuple): Params {
  return { F: p[0], k: p[1], Du: p[2], Dv: p[3] };
}

/** Component-wise linear blend; `w = 0` yields `a`, `w = 1` yields `b`. */
export function blendTuple(a: ParamTuple, b: ParamTuple, w: number): ParamTuple {
  return [
    lerp(a[0], b[0], w),
    lerp(a[1], b[1], w),
    lerp(a[2], b[2], w),
    lerp(a[3], b[3], w),
  ];
}

/**
 * Evaluate a waypoint list at normalized time `t` in [0, 1].
 *
 * Endpoints are returned exactly: `t <= 0` gives the first waypoint, `t >= 1` the last, with no
 * smootherstep rounding. Assumes `at` is strictly ascending with endpoints 0 and 1 (guaranteed by
 * `validateTrajectoryDocument`).
 */
export function evaluateWaypoints(
  waypoints: readonly { at: number; p: WaypointTuple }[],
  t: number,
): ParamTuple {
  if (waypoints.length === 0) throw new Error('evaluateWaypoints requires at least one waypoint');
  const first = waypoints[0]!;
  const last = waypoints[waypoints.length - 1]!;
  if (t <= first.at) return first.p;
  if (t >= last.at) return last.p;

  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const a = waypoints[i]!;
    const b = waypoints[i + 1]!;
    if (t >= a.at && t <= b.at) {
      const span = b.at - a.at;
      const local = span <= 0 ? 0 : (t - a.at) / span;
      return blendTuple(a.p, b.p, smootherstep(local));
    }
  }
  return last.p;
}

/** Effective (dwell-scaled) movement duration in performance seconds. */
export function effectiveDurationSeconds(spec: MovementSpec, durationScale = 1): number {
  return spec.seconds * durationScale;
}

/**
 * Advance normalized path progress by one tick (§6.4).
 *
 * Progress is accumulated **incrementally** — `progress += dt * progressRate / effectiveDuration`
 * — and never recomputed as an instantaneous rate times the whole elapsed time. Because `dt >= 0`,
 * `progressRate > 0` and `effectiveDuration > 0`, the increment is non-negative, so progress is
 * **monotone non-decreasing**: a drop in the analysis progress rate (say 1.2 -> 0.8) or a lengthening
 * duration jitter changes only the *rate* of future progress, never the value already accumulated,
 * and can never pull a movement backward.
 *
 * Duration jitter is therefore treated monotonically: `effectiveDuration` is sampled fresh each tick
 * and divided into that tick's increment only. A movement whose duration target rises mid-flight
 * simply accumulates slower from that tick on; it does not re-derive (and cannot shorten) past
 * progress.
 */
export function advanceProgress(
  previousProgress: number,
  dt: number,
  progressRate: number,
  effectiveDuration: number,
): number {
  const increment = effectiveDuration > 0 ? (dt * progressRate) / effectiveDuration : 0;
  const next = previousProgress + increment;
  return next <= 0 ? 0 : next >= 1 ? 1 : next;
}

export interface MovementEvaluationInput {
  spec: MovementSpec;
  /**
   * Normalized path position in [0, 1], accumulated incrementally by the caller via
   * `advanceProgress`. Clamped here as a guard.
   */
  progress: number;
  /** Actual parameter vector at transition start (default: the path's own start). */
  transitionFrom?: ParamTuple | null;
  /** Seconds since the transition started. */
  transitionElapsedSeconds?: number;
  /** Crossfade window; 0 disables the blend (default 0). */
  transitionSeconds?: number;
}

export interface MovementEvaluation {
  parameters: Params;
  /** Normalized path progress in [0, 1]. */
  progress: number;
}

/**
 * Evaluate a movement's parameter vector at an already-accumulated `progress`, blending from
 * `transitionFrom` when a crossfade window is active. The caller owns progress accumulation
 * (`advanceProgress`); this function is a pure map from progress to parameters.
 */
export function evaluateMovement(input: MovementEvaluationInput): MovementEvaluation {
  const progress = input.progress <= 0 ? 0 : input.progress >= 1 ? 1 : input.progress;

  const pathParams = evaluateWaypoints(input.spec.waypoints, progress);

  const transitionSeconds = input.transitionSeconds ?? 0;
  const transitionFrom = input.transitionFrom ?? null;
  const transitionElapsed = input.transitionElapsedSeconds ?? 0;
  let params = pathParams;
  if (transitionFrom !== null && transitionSeconds > 0 && transitionElapsed < transitionSeconds) {
    const w = smootherstep(transitionElapsed / transitionSeconds);
    params = blendTuple(transitionFrom, pathParams, w);
  }

  return { parameters: paramsFromTuple(params), progress };
}
