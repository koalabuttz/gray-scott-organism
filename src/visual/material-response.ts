/**
 * §12.4-B #4 material-response model.
 *
 * The fragment shader's boundary-driven roughness variation (`material.frag`) is mirrored here
 * **exactly**, in TypeScript, so the arithmetic — in particular the clamp into the plan's documented
 * §5.3 roughness band — is unit-tested rather than only asserted in a comment. If the shader and this
 * module ever disagree, `tests/material-response.test.ts` fails.
 *
 * Shader, verbatim:
 *   float boundaryActivity = clamp(smoothed.z * 2.0, 0.0, 1.0);
 *   float heightThickness  = ref > 0.0
 *     ? pow(clamp(max(V, 0.0) / ref, 0.0, 1.0), max(power, 1e-3))
 *     : 1.0 - exp(-max(V, 0.0) / scale);
 *   float thinness         = clamp(1.0 - heightThickness, 0.0, 1.0);
 *   float localRoughness   = clamp(roughness * (1.0 - variation * (1.0 - boundaryActivity))
 *                                          * (1.0 - gloss * thinness),
 *                                  uRoughnessBand.x, uRoughnessBand.y);
 *
 * The clamp is load-bearing: at the calibrated base roughness 0.36 and the shipped variation 0.35 the
 * unclamped value at zero boundary activity is 0.36 × (1 − 0.35) = 0.234, *below* the plan's §5.3
 * floor of 0.24, so the local roughness would leave the documented band. With the clamp the local
 * roughness spans exactly [0.24, 0.36] — the plan's band itself.
 *
 * The `gloss`/`thinness` factor is round 2's #4 lever, **measured and rejected** (it lowers the
 * lit-pixel spread: a smoother surface throws a narrower specular lobe, so fewer thin pixels catch the
 * grazing light). It ships at 0 and is kept here so the model still describes the shader exactly and
 * the rejection stays re-runnable.
 */
import { MATERIAL, SURFACE } from '../config.ts';

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * §5.2 height thickness. Round 2 replaces the saturating remap `1 − exp(−V/scale)` with a normalized
 * `clamp(V/ref, 0, 1) ^ power` (ref > 0); either branch lands in [0, 1], so `shape ≤ 1` and the height
 * can never exceed the §5.2 relief bound.
 */
export function heightThickness(
  v: number,
  ref: number,
  power: number,
  saturatingScale: number = SURFACE.softenedVScale,
): number {
  if (ref > 0) return Math.pow(clamp01(Math.max(v, 0) / ref), Math.max(power, 1e-3));
  return 1 - Math.exp(-Math.max(v, 0) / saturatingScale);
}

/** The §5.2 `shape` (≤ 1), before the relief amplitude and the support gate. */
export function heightShape(thickness: number, boundary: number): number {
  return SURFACE.smoothedVWeight * clamp01(thickness) + SURFACE.boundaryWeight * clamp01(boundary);
}

/** The blur→boundary-activity remap: blur is small in calm material and rises at active fronts. */
export function boundaryActivity(boundaryMagnitude: number): number {
  return Math.min(1, Math.max(0, boundaryMagnitude * 2));
}

/**
 * The local (varied) roughness, clamped into `band` (§5.3 [0.24, 0.36] by default). Boundary activity
 * 0 gives the smooth (band-floor) end, activity 1 the calibrated base roughness — the variation only
 * ever reduces roughness, so the calibrated top is the maximum. `gloss` (round 2's rejected #4 lever,
 * shipped at 0) only reduces it further, so the band clamp still holds.
 */
export function localRoughness(
  roughness: number,
  variation: number,
  activity: number,
  band: readonly [number, number] = MATERIAL.roughnessRange,
  gloss = 0,
  thinness = 0,
): number {
  const varied =
    roughness * (1 - variation * (1 - clamp01(activity))) * (1 - gloss * clamp01(thinness));
  return Math.min(band[1], Math.max(band[0], varied));
}
