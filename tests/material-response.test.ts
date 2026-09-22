/**
 * §12.4-B #4 material-response band (deviation 60).
 *
 * The shader varies local roughness with boundary activity; this pins the two properties the
 * deviation claims: the variation only ever *reduces* roughness from the calibrated top, and the
 * result stays inside the plan's §5.3 documented band [0.24, 0.36] — including the calibrated base
 * 0.36 with the shipped variation 0.35, which is 0.234 unclamped and therefore needs the clamp.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL, REFINEMENT } from '../src/config.ts';
import { boundaryActivity, localRoughness } from '../src/visual/material-response.ts';

const BAND = MATERIAL.roughnessRange;

describe('§12.4-B #4 local roughness', () => {
  it('boundary activity is the clamped blur remap', () => {
    expect(boundaryActivity(0)).toBe(0);
    expect(boundaryActivity(0.5)).toBe(1);
    expect(boundaryActivity(1)).toBe(1);
    // Negative or oversized inputs cannot escape [0, 1].
    expect(boundaryActivity(-3)).toBe(0);
    expect(boundaryActivity(7)).toBe(1);
  });

  it('activity 0 and 1 keep the local roughness inside the documented band', () => {
    // Activity 0 → the smooth end; the unclamped value would be 0.234, below the floor, so this
    // assertion is exactly what the clamp exists for.
    const smooth = localRoughness(MATERIAL.roughness, REFINEMENT.roughnessVariation, 0, BAND);
    const active = localRoughness(MATERIAL.roughness, REFINEMENT.roughnessVariation, 1, BAND);
    expect(MATERIAL.roughness * (1 - REFINEMENT.roughnessVariation)).toBeLessThan(BAND[0]);
    expect(smooth).toBeGreaterThanOrEqual(BAND[0]);
    expect(smooth).toBeLessThanOrEqual(BAND[1]);
    expect(active).toBeGreaterThanOrEqual(BAND[0]);
    expect(active).toBeLessThanOrEqual(BAND[1]);
    // The fronts keep the calibrated roughness; the calm material is the smooth end of the band.
    expect(active).toBe(MATERIAL.roughness);
    expect(smooth).toBe(BAND[0]);
  });

  it('stays inside the band for every activity and every variation in [0, 0.5]', () => {
    for (let variation = 0; variation <= 0.5; variation += 0.05) {
      for (let activity = 0; activity <= 1; activity += 0.05) {
        const local = localRoughness(MATERIAL.roughness, variation, activity, BAND);
        expect(local, `activity ${activity}, variation ${variation}`).toBeGreaterThanOrEqual(BAND[0]);
        expect(local, `activity ${activity}, variation ${variation}`).toBeLessThanOrEqual(BAND[1]);
      }
    }
  });

  it('is the identity when the variation is off', () => {
    expect(localRoughness(MATERIAL.roughness, 0, 0, BAND)).toBe(MATERIAL.roughness);
    expect(localRoughness(MATERIAL.roughness, 0, 1, BAND)).toBe(MATERIAL.roughness);
  });

  it('clamps a base roughness above the band rather than exceeding it', () => {
    expect(localRoughness(0.5, 0.35, 1, BAND)).toBe(BAND[1]);
  });
});
