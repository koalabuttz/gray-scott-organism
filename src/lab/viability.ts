/**
 * §10 laboratory viability projection (Phase-4 guardrail; review fix MAJOR).
 *
 * The F/k sliders used to be clamped as two **independent** ranges — a rectangle
 * `F [.014, .055] × k [.045, .0634]`. But viability is a **coupled** property of the pair: the corner
 * `(.014, .045)` is a project-measured dead anchor (`regime.ts` label `dying`; `artifacts/phase1-tune.txt`
 * gives occupied 0.000, and `tests/regime.test.ts` asserts it dies). A rectangle that contains a dead
 * corner can therefore still dial a dead field, which is exactly the operator caveat this guardrail
 * exists to remove.
 *
 * This module makes viability an explicit, evidence-backed predicate with a projection:
 *
 *  - A pair is **viable** when `describeRegime` maps it to a *living* anchor: not `nonviable` (k at or
 *    above the measured death boundary `DEATH_K`) and not labelled `dying`, and not `unmapped`
 *    (outside the documented anchors' neighbourhood — an untested point is not evidence of life).
 *  - `projectViableParameters` is the danger-off rule applied to every proposed pair: a pair that is
 *    already viable passes through unchanged; otherwise `k` is projected to the **nearest
 *    evidence-backed living k** at that F (the anchor table's non-`dying` k values, filtered to those
 *    that stay viable at this F); when no anchor k is viable at that F the whole pair falls back to
 *    the calibrated defaults.
 *
 * The projection always lands on a pair that classifies viable, so "dangerous values off" cannot
 * produce a dead field, and a sanitize can write the projected pair back to the sliders with the DOM,
 * the native range and the internal model all agreeing.
 */
import { DEFAULT_PARAMS } from '../config.ts';
import { describeRegime, REGIME_ANCHORS, type RegimeDescription } from '../core/regime.ts';
import type { Params } from '../core/types.ts';

/**
 * The danger-off slider envelope. `F` spans the documented anchors' feed range and `k` spans the
 * **evidence-backed living anchor band** `[.045, .062]` — its ceiling is the highest k we have
 * actually measured alive (`.062`; the tune row `.029/.062` is occupancy 0.3612 and the death bracket
 * is `.062` alive against `.0649` dead), rather than the death-boundary midpoint `.0634`. That keeps a
 * danger-off sanitize on a measured living value instead of hugging the boundary. The envelope is only
 * the *slider* range; the real guarantee comes from `projectViableParameters`, which rejects the dead
 * pairs (e.g. the low-F/high-k region around `(.014, .045)`) that a plain rectangle would admit.
 */
export const VIABLE_ENVELOPE = {
  F: [0.014, 0.055] as const,
  k: [0.045, 0.062] as const,
} as const;

/**
 * The evidence-backed **living** k values from the anchor table: every anchor k whose label is not the
 * nonviable `dying` outcome (`.045, .054, .057, .060, .062`). These are the only points the projection
 * may land on, so it can never snap `k` onto an unmeasured value that merely sits under `DEATH_K`.
 */
export const VIABLE_ANCHOR_KS: readonly number[] = Array.from(
  new Set(REGIME_ANCHORS.filter((anchor) => anchor.label !== 'dying').map((anchor) => anchor.k)),
).sort((a, b) => a - b);

/** A regime readout is viable when it maps to a living, well-documented anchor. */
export function isViableRegime(description: RegimeDescription): boolean {
  return !description.nonviable && description.regime !== 'dying' && !description.unmapped;
}

/** True when the `(F, k)` pair classifies as viable (see `isViableRegime`). */
export function isViablePair(F: number, k: number): boolean {
  return isViableRegime(describeRegime({ F, k, Du: DEFAULT_PARAMS.Du, Dv: DEFAULT_PARAMS.Dv }));
}

/**
 * The nearest evidence-backed living `k` that stays viable at `F`, or null when no anchor k is viable
 * at that feed (e.g. an extreme F where every anchor is `unmapped`). Ties resolve to the lower k.
 */
export function nearestViableK(F: number, k: number): number | null {
  let best: number | null = null;
  for (const candidate of VIABLE_ANCHOR_KS) {
    if (!isViablePair(F, candidate)) continue;
    if (best === null || Math.abs(candidate - k) < Math.abs(best - k)) best = candidate;
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * The danger-off projection: return a pair inside `VIABLE_ENVELOPE` that classifies viable.
 *
 * 1. `F` and `k` are clamped into `VIABLE_ENVELOPE` (the danger-off slider ranges), so the result can
 *    always be written back to the sliders with the native range agreeing.
 * 2. If the clamped pair is already viable, it passes through.
 * 3. Otherwise `k` moves to the nearest evidence-backed living k at that F.
 * 4. When no anchor k is viable at that F (e.g. an extreme F where every anchor is `unmapped`), the
 *    whole pair falls back to the calibrated defaults — a defensive branch, since every in-envelope F
 *    has a viable anchor k (`tests/viability.test.ts` scans it).
 *
 * `Du`/`Dv` are preserved except in the fallback. The result is guaranteed viable **and** inside the
 * danger-off envelope, which is what lets the lab sanitize a live override and write it back to the
 * sliders with the DOM, the native ranges, the readout and the internal model all in agreement.
 */
export function projectViableParameters(params: Params): Params {
  const F = clamp(params.F, VIABLE_ENVELOPE.F[0], VIABLE_ENVELOPE.F[1]);
  const clamped = clamp(params.k, VIABLE_ENVELOPE.k[0], VIABLE_ENVELOPE.k[1]);
  if (isViablePair(F, clamped)) {
    return F === params.F && clamped === params.k ? { ...params } : { ...params, F, k: clamped };
  }
  const k = nearestViableK(F, clamped);
  if (k === null) return { ...DEFAULT_PARAMS };
  return { ...params, F, k };
}

/** True when the projection would change at least one parameter. */
export function needsProjection(params: Params): boolean {
  const projected = projectViableParameters(params);
  return (
    projected.F !== params.F ||
    projected.k !== params.k ||
    projected.Du !== params.Du ||
    projected.Dv !== params.Dv
  );
}
