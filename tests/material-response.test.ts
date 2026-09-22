/**
 * §12.4-B #4 material-response band (deviation 60).
 *
 * The shader varies local roughness with boundary activity; this pins the two properties the
 * deviation claims: the variation only ever *reduces* roughness from the calibrated top, and the
 * result stays inside the plan's §5.3 documented band [0.24, 0.36] — including the calibrated base
 * 0.36 with the shipped variation 0.35, which is 0.234 unclamped and therefore needs the clamp.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL, REFINEMENT, SURFACE } from '../src/config.ts';
import { boundaryActivity, heightShape, heightThickness, localRoughness } from '../src/visual/material-response.ts';

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

  it('round-2 thin-gloss (rejected, shipped at 0) only reduces roughness and stays in the band', () => {
    // Identity at gloss 0 — the shipped value.
    expect(localRoughness(MATERIAL.roughness, 0.35, 1, BAND, 0, 1)).toBe(MATERIAL.roughness);
    for (let gloss = 0; gloss <= 0.5; gloss += 0.05) {
      for (let thinness = 0; thinness <= 1; thinness += 0.1) {
        const plain = localRoughness(MATERIAL.roughness, 0.35, 1, BAND, 0, thinness);
        const glossed = localRoughness(MATERIAL.roughness, 0.35, 1, BAND, gloss, thinness);
        expect(glossed, `gloss ${gloss}, thinness ${thinness}`).toBeLessThanOrEqual(plain);
        expect(glossed, `gloss ${gloss}, thinness ${thinness}`).toBeGreaterThanOrEqual(BAND[0]);
        expect(glossed, `gloss ${gloss}, thinness ${thinness}`).toBeLessThanOrEqual(BAND[1]);
      }
    }
  });
});

describe('§12.4 round-2 #1 height thickness', () => {
  it('the normalized remap is monotonic, lands in [0, 1] and uses more of the range than the saturating one', () => {
    const ref = 0.36;
    const power = 1.3;
    // Both branches are bounded, so `shape <= 1` and the §5.2 relief budget can never be exceeded.
    for (let v = -0.2; v <= 0.6; v += 0.01) {
      const normalized = heightThickness(v, ref, power);
      const saturating = heightThickness(v, 0, 1);
      expect(normalized).toBeGreaterThanOrEqual(0);
      expect(normalized).toBeLessThanOrEqual(1);
      expect(saturating).toBeGreaterThanOrEqual(0);
      expect(saturating).toBeLessThanOrEqual(1);
      expect(heightShape(normalized, 0.5)).toBeLessThanOrEqual(1);
      expect(heightShape(saturating, 0.5)).toBeLessThanOrEqual(1);
    }
    // Monotonic non-decreasing on both branches.
    for (const [r, p] of [[0, 1], [ref, power]] as const) {
      let previous = -1;
      for (let v = 0; v <= 0.8; v += 0.01) {
        const t = heightThickness(v, r, p);
        expect(t).toBeGreaterThanOrEqual(previous);
        previous = t;
      }
    }
    // The measured claim: over the mature field's own V range (0.05 … 0.38) the normalized remap
    // spans more shape than the saturating one — that is the stratification gain.
    const span = (r: number, p: number): number =>
      heightThickness(0.38, r, p) - heightThickness(0.05, r, p);
    expect(span(ref, power)).toBeGreaterThan(span(0, 1));
    // `ref = 0` is exactly the round-B branch: the toggle really is off.
    expect(heightThickness(0.2, 0, 1)).toBe(1 - Math.exp(-0.2 / SURFACE.softenedVScale));
  });
});
