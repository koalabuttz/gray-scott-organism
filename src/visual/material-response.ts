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
 *   float localRoughness   = clamp(roughness * (1.0 - variation * (1.0 - boundaryActivity)),
 *                                  uRoughnessBand.x, uRoughnessBand.y);
 *
 * The clamp is load-bearing: at the calibrated base roughness 0.36 and the shipped variation 0.35 the
 * unclamped value at zero boundary activity is 0.36 × (1 − 0.35) = 0.234, *below* the plan's §5.3
 * floor of 0.24, so the local roughness would leave the documented band. With the clamp the local
 * roughness spans exactly [0.24, 0.36] — the plan's band itself.
 */
import { MATERIAL } from '../config.ts';

/** The blur→boundary-activity remap: blur is small in calm material and rises at active fronts. */
export function boundaryActivity(boundaryMagnitude: number): number {
  return Math.min(1, Math.max(0, boundaryMagnitude * 2));
}

/**
 * The local (varied) roughness, clamped into `band` (§5.3 [0.24, 0.36] by default). Boundary activity
 * 0 gives the smooth (band-floor) end, activity 1 the calibrated base roughness — the variation only
 * ever reduces roughness, so the calibrated top is the maximum.
 */
export function localRoughness(
  roughness: number,
  variation: number,
  activity: number,
  band: readonly [number, number] = MATERIAL.roughnessRange,
): number {
  const varied = roughness * (1 - variation * (1 - Math.min(1, Math.max(0, activity))));
  return Math.min(band[1], Math.max(band[0], varied));
}
