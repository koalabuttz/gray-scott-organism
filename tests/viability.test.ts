/**
 * §10 laboratory viability projection (Phase-4 guardrail; review fix MAJOR).
 *
 * The danger-off rule must be a **coupled** `(F, k)` predicate, not two independent clamps: the old
 * rectangle's corner `(.014, .045)` is a project-measured dead anchor, so "the sliders are clamped to
 * a viable envelope" would have been a false claim. These assertions pin the projection's guarantees:
 * every proposed pair is mapped onto a pair the regime oracle classifies viable, and the mapping never
 * lands outside the danger-off envelope.
 */
import { describe, expect, it } from 'vitest';
import { DEATH_K, describeRegime } from '../src/core/regime.ts';
import {
  VIABLE_ANCHOR_KS,
  VIABLE_ENVELOPE,
  isViablePair,
  nearestViableK,
  projectViableParameters,
} from '../src/lab/viability.ts';
import { DEFAULT_PARAMS } from '../src/config.ts';
import type { Params } from '../src/core/types.ts';

const D = DEFAULT_PARAMS.Du;
const Dv = DEFAULT_PARAMS.Dv;
const pair = (F: number, k: number): Params => ({ F, k, Du: D, Dv: Dv });

function viable(params: Params): boolean {
  const description = describeRegime(params);
  return !description.nonviable && description.regime !== 'dying' && !description.unmapped;
}

function insideEnvelope(params: Params): boolean {
  return (
    params.F >= VIABLE_ENVELOPE.F[0] &&
    params.F <= VIABLE_ENVELOPE.F[1] &&
    params.k >= VIABLE_ENVELOPE.k[0] &&
    params.k <= VIABLE_ENVELOPE.k[1]
  );
}

describe('§10 coupled (F,k) viability projection', () => {
  it('the old rectangle corner (.014, .045) is dead, and the projection makes it viable', () => {
    // The reviewer's finding: this corner is a measured `dying` anchor, so a rectangle clamp is unsound.
    expect(isViablePair(0.014, 0.045), 'the corner is a measured dead pair').toBe(false);
    expect(describeRegime(pair(0.014, 0.045)).regime).toBe('dying');
    const projected = projectViableParameters(pair(0.014, 0.045));
    expect(viable(projected), 'the projected pair is viable').toBe(true);
    expect(projected.F, 'F is preserved (only k moves)').toBeCloseTo(0.014, 9);
    expect(projected.k, 'k moved to the nearest evidence-backed living value at F').toBeCloseTo(0.054, 6);
    expect(insideEnvelope(projected)).toBe(true);
  });

  it('all four danger-off envelope corners project to viable pairs inside the envelope', () => {
    const corners: Array<[number, number]> = [
      [VIABLE_ENVELOPE.F[0], VIABLE_ENVELOPE.k[0]],
      [VIABLE_ENVELOPE.F[0], VIABLE_ENVELOPE.k[1]],
      [VIABLE_ENVELOPE.F[1], VIABLE_ENVELOPE.k[0]],
      [VIABLE_ENVELOPE.F[1], VIABLE_ENVELOPE.k[1]],
    ];
    for (const [F, k] of corners) {
      const projected = projectViableParameters(pair(F, k));
      expect(viable(projected), `corner (${F}, ${k}) projects to a viable pair`).toBe(true);
      expect(insideEnvelope(projected), `corner (${F}, ${k}) stays inside the envelope`).toBe(true);
    }
  });

  it('projects a death-boundary k (the danger-off sanitize case) down to a living anchor', () => {
    // Danger on -> k = .075 (>= DEATH_K) -> danger off must restore a safe pair immediately.
    expect(describeRegime(pair(0.03, 0.075)).nonviable).toBe(true);
    const projected = projectViableParameters(pair(0.03, 0.075));
    expect(viable(projected)).toBe(true);
    expect(projected.k, 'k is the nearest living anchor at F = .03').toBeCloseTo(0.062, 6);
    expect(projected.k).toBeLessThan(DEATH_K);
  });

  it('never leaves the danger-off envelope, for a dense sample of the plane', () => {
    for (let F = 0; F <= 0.1 + 1e-9; F += 0.001) {
      for (let k = 0; k <= 0.09 + 1e-9; k += 0.001) {
        const projected = projectViableParameters(pair(F, k));
        expect(viable(projected), `project(${F.toFixed(3)}, ${k.toFixed(3)}) is viable`).toBe(true);
        expect(insideEnvelope(projected), `project(${F.toFixed(3)}, ${k.toFixed(3)}) inside envelope`).toBe(true);
      }
    }
  });

  it('passes an already-viable pair through unchanged (includes the calibrated defaults)', () => {
    expect(projectViableParameters({ ...DEFAULT_PARAMS })).toEqual({ ...DEFAULT_PARAMS });
    const worms = pair(0.03, 0.062);
    expect(isViablePair(0.03, 0.062)).toBe(true);
    expect(projectViableParameters(worms)).toEqual(worms);
  });

  it('clamps an out-of-envelope F into the danger-off envelope and stays viable', () => {
    // At an extreme F every anchor is `unmapped`, so there is no evidence-backed living k there.
    expect(nearestViableK(0.1, 0.06)).toBeNull();
    const projected = projectViableParameters(pair(0.1, 0.06));
    expect(projected.F, 'F is clamped into the danger-off envelope').toBe(VIABLE_ENVELOPE.F[1]);
    expect(viable(projected)).toBe(true);
    expect(insideEnvelope(projected)).toBe(true);
  });

  it('every in-envelope F has an evidence-backed viable k (the projection never needs the fallback there)', () => {
    for (let F = VIABLE_ENVELOPE.F[0]; F <= VIABLE_ENVELOPE.F[1] + 1e-9; F += 0.0005) {
      expect(nearestViableK(F, 0.07), `an anchor k is viable at F = ${F.toFixed(4)}`).not.toBeNull();
    }
  });

  it('the evidence-backed living k set excludes the dying anchors', () => {
    expect(VIABLE_ANCHOR_KS).toEqual([0.045, 0.054, 0.057, 0.06, 0.062]);
    for (const k of VIABLE_ANCHOR_KS) expect(k).toBeLessThan(DEATH_K);
  });
});
