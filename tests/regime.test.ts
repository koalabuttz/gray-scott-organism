/**
 * §10 laboratory regime readout.
 *
 * The map is deliberately approximate, but the properties that matter must hold:
 *  - it is a **2-D nearest-reference lookup** (not a 1-D k−F ladder);
 *  - the documented anchors resolve to their own labels, but **only points that survived** may be
 *    anchors — every production (`candidate`) anchor is cross-checked against the frozen gate
 *    evidence, and the textbook mitosis point is a documented `KNOWN_DEAD` exclusion;
 *  - equal-gap points in different regions get different labels;
 *  - far-from-anchor points are reported `unmapped`;
 *  - the one non-anchor rule (the measured death boundary) behaves.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEATH_K,
  KNOWN_DEAD,
  MAX_ANCHOR_DISTANCE,
  REGIME_ANCHORS,
  anchorDistance,
  describeRegime,
  formatRegime,
  nearestAnchor,
  type Regime,
  type RegimeProvenance,
} from '../src/core/regime.ts';
import type { Params } from '../src/core/types.ts';

function p(F: number, k: number): Params {
  return { F, k, Du: 0.16, Dv: 0.08 };
}

const LABELS: Regime[] = [
  'labyrinth',
  'solitons',
  'mitosis',
  'worms',
  'dense',
  'coral',
  'overgrowth',
  'dying',
];

interface CaptureEntry {
  label: string;
  file: string;
  role: string;
  parameters: { F: number; k: number };
  image: { max: number; mean: number };
  field: { occupiedFraction: number };
}

/** The frozen gate evidence (read-only): our record of what actually survived on this solver. */
function readGateCaptures(): CaptureEntry[] {
  const path = resolve('artifacts/phase1-gate/captures.json');
  if (!existsSync(path)) {
    throw new Error(`the frozen gate evidence ${path} is required to validate regime-anchor provenance`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown as CaptureEntry[];
}

const CAPTURES = readGateCaptures();

describe('describeRegime: anchors resolve to their own labels', () => {
  it('maps the literature/candidate anchors the review named', () => {
    expect(describeRegime(p(0.029, 0.057)).regime).toBe('labyrinth'); // classic maze
    expect(describeRegime(p(0.0545, 0.062)).regime).toBe('coral'); // flower/coral
    expect(describeRegime(p(0.028, 0.062)).regime).toBe('mitosis'); // literature mitosis (alive at k=.062)
    expect(describeRegime(p(0.03, 0.06)).regime).toBe('solitons');
  });

  it('resolves every anchor to its own label at zero distance', () => {
    for (const anchor of REGIME_ANCHORS) {
      const description = describeRegime(p(anchor.F, anchor.k));
      expect(description.regime).toBe(anchor.label);
      expect(description.distance).toBeCloseTo(0, 12);
      expect(description.unmapped).toBe(false);
      expect(description.nonviable).toBe(false);
    }
  });

  it('documents every anchor with a known label, a provenance class and a source', () => {
    expect(REGIME_ANCHORS.length).toBeGreaterThanOrEqual(6);
    for (const anchor of REGIME_ANCHORS) {
      expect(LABELS).toContain(anchor.label);
      expect(anchor.source.length).toBeGreaterThan(0);
      expect(Number.isFinite(anchor.F)).toBe(true);
      expect(Number.isFinite(anchor.k)).toBe(true);
      expect(['literature', 'candidate', 'tune'] satisfies RegimeProvenance[]).toContain(anchor.provenance);
    }
    const classes = new Set(REGIME_ANCHORS.map((anchor) => anchor.provenance));
    expect([...classes].sort()).toEqual(['candidate', 'literature', 'tune']);
  });
});

describe('describeRegime: anchors are points that survived', () => {
  it('every production (candidate) anchor has a recorded capture with nonzero occupancy', () => {
    const candidateAnchors = REGIME_ANCHORS.filter((anchor) => anchor.provenance === 'candidate');
    expect(candidateAnchors.length).toBeGreaterThanOrEqual(3);
    for (const anchor of candidateAnchors) {
      const match = CAPTURES.find(
        (capture) =>
          capture.role === 'candidate' &&
          capture.parameters.F === anchor.F &&
          capture.parameters.k === anchor.k,
      );
      expect(match, `captures.json candidate capture for ${anchor.label} @ ${anchor.F}/${anchor.k}`).toBeDefined();
      expect(match!.field.occupiedFraction).toBeGreaterThan(0);
      // ...and the classifier must call that anchor living, with its own label.
      expect(describeRegime(p(anchor.F, anchor.k)).nonviable).toBe(false);
      expect(describeRegime(p(anchor.F, anchor.k)).regime).toBe(anchor.label);
    }
  });

  it('the mandatory production captures are alive too', () => {
    const mandatory = CAPTURES.filter((capture) => capture.role === 'mandatory');
    expect(mandatory.length).toBeGreaterThanOrEqual(3);
    for (const capture of mandatory) {
      expect(capture.field.occupiedFraction).toBeGreaterThan(0);
    }
  });

  it('excludes the dead mitosis point and reports it nonviable', () => {
    // The textbook mitosis point is NOT an anchor...
    expect(REGIME_ANCHORS.some((anchor) => anchor.F === 0.0367 && anchor.k === 0.0649)).toBe(false);
    const dead = KNOWN_DEAD.find((entry) => entry.F === 0.0367 && entry.k === 0.0649);
    expect(dead).toBeDefined();
    expect(dead!.literatureLabel).toBe('mitosis');
    expect(dead!.note).toContain('did **not** survive');

    // ...because its own production capture is black.
    const match = CAPTURES.find(
      (capture) => capture.parameters.F === 0.0367 && capture.parameters.k === 0.0649,
    );
    expect(match).toBeDefined();
    expect(match!.field.occupiedFraction).toBe(0);
    expect(match!.image.max).toBe(0);
    expect(match!.image.mean).toBe(0);

    // ...so the classifier reports it nonviable rather than as a living mitosis.
    const description = describeRegime(p(0.0367, 0.0649));
    expect(description.nonviable).toBe(true);
    expect(description.regime).toBe('dying');
  });

  it('has no anchor the classifier itself would call nonviable', () => {
    for (const anchor of REGIME_ANCHORS) {
      expect(describeRegime(p(anchor.F, anchor.k)).nonviable).toBe(false);
    }
  });
});

describe('describeRegime: two-dimensional, not a 1-D k-F ladder', () => {
  it('gives different labels to equal-gap points in different regions', () => {
    // gap = 0.028 for both, but (.050,.078) is above the measured death boundary.
    const maze = describeRegime(p(0.029, 0.057));
    const dead = describeRegime(p(0.05, 0.078));
    expect(maze.gap).toBeCloseTo(dead.gap, 12);
    expect(maze.regime).not.toBe(dead.regime);
    expect(dead.regime).toBe('dying');
    expect(dead.nonviable).toBe(true);

    // ...and an alive equal-gap pair: (.022,.054) is dense, (.030,.062) is worms.
    const dense = describeRegime(p(0.022, 0.054));
    const worms = describeRegime(p(0.03, 0.062));
    expect(dense.gap).toBeCloseTo(worms.gap, 12);
    expect(dense.regime).not.toBe(worms.regime);
  });

  it('is not a blanket "high F implies overgrowth" cutoff', () => {
    // The old F >= 0.042 cutoff called (.0545,.062) overgrowth; the 2-D map calls it coral, as our
    // own candidate sheet does.
    expect(describeRegime(p(0.0545, 0.062)).regime).toBe('coral');
    expect(describeRegime(p(0.0545, 0.062)).regime).not.toBe('overgrowth');
  });
});

describe('describeRegime: the measured death boundary', () => {
  it('sits at the midpoint of the measured alive/dead bracket', () => {
    // alive: the tune run's (.029, .062) row (occupancy 0.3612; tune.txt line 50).
    // dead:  every k = .0649 point, including our own production capture of the mitosis preset.
    expect(DEATH_K).toBe(0.0635);
    expect(DEATH_K).toBeGreaterThan(0.062);
    expect(DEATH_K).toBeLessThan(0.0649);
    expect(describeRegime(p(0.03, 0.062)).nonviable).toBe(false);
    expect(describeRegime(p(0.0367, 0.0649)).nonviable).toBe(true);
    expect(describeRegime(p(0.03, DEATH_K)).nonviable).toBe(true);
    expect(describeRegime(p(0.03, DEATH_K - 1e-6)).nonviable).toBe(false);

    const nonviable = describeRegime(p(0.05, 0.078));
    expect(nonviable.distance).toBeNull();
    expect(nonviable.nearest).toBeNull();
    expect(formatRegime(nonviable)).toBe(
      'dying (nonviable: k above the measured death boundary 0.0635)',
    );
  });

  it('agrees with the tune run on the cells it tabulated', () => {
    // artifacts/phase1-tune.txt: (0.018,0.062) and (0.014,0.045) are occupied 0.000 (dead).
    expect(describeRegime(p(0.018, 0.062)).regime).toBe('dying');
    expect(describeRegime(p(0.014, 0.045)).regime).toBe('dying');
    // ...and its clearly saturated low-k rows are the overgrowth anchor.
    expect(describeRegime(p(0.026, 0.045)).regime).toBe('overgrowth');
  });
});

describe('describeRegime: unmapped when far from every anchor', () => {
  it('reports unmapped and still names the nearest anchor', () => {
    const far = describeRegime(p(0.09, 0.01));
    expect(far.unmapped).toBe(true);
    expect(far.distance).toBeGreaterThan(MAX_ANCHOR_DISTANCE);
    expect(far.nearest).not.toBeNull();
    const text = formatRegime(far);
    expect(text).toContain('unmapped (nearest: ');
    expect(text).toMatch(/unmapped \(nearest: \w+ @ \.\d{3}\/\.\d{3}, d=\d\.\d{3}\)/);
  });

  it('agrees with the nearestAnchor helper', () => {
    const { anchor, distance } = nearestAnchor(0.05, 0.03);
    expect(distance).toBeCloseTo(anchorDistance(0.05, 0.03, anchor), 12);
    const manual = Math.min(...REGIME_ANCHORS.map((candidate) => anchorDistance(0.05, 0.03, candidate)));
    expect(distance).toBeLessThanOrEqual(manual + 1e-12);
  });
});

describe('describeRegime: totality, shape and purity', () => {
  it('is total over the §6.2 envelope', () => {
    for (let F = 0; F <= 0.1; F += 0.002) {
      for (let k = 0; k <= 0.09; k += 0.002) {
        const description = describeRegime(p(F, k));
        expect(LABELS).toContain(description.regime);
        expect(description.gap).toBeCloseTo(k - F, 12);
        if (description.nonviable) {
          expect(description.distance).toBeNull();
          expect(description.nearest).toBeNull();
        } else {
          expect(description.distance).not.toBeNull();
          expect(description.nearest).not.toBeNull();
          expect(description.unmapped).toBe(description.distance! > MAX_ANCHOR_DISTANCE);
        }
      }
    }
  });

  it('reads the shipped candidate trajectory as a coherent arc', () => {
    expect(describeRegime(p(0.005, 0.075)).regime).toBe('dying'); // stillness / collapse end
    expect(describeRegime(p(0.026, 0.06)).regime).toBe('mitosis'); // dormancy / nucleation start
    expect(describeRegime(p(0.03, 0.062)).regime).toBe('worms'); // nucleation end
    // Deviation 45: the cellular-growth/replication endpoint band was retuned INSIDE the viable
    // region (k = .0600 -> .0608 -> .0610), so both endpoints are now viable, not dying.
    expect(describeRegime(p(0.035, 0.0608)).nonviable).toBe(false); // cellular growth end
    expect(describeRegime(p(0.0367, 0.061)).nonviable).toBe(false); // replication end
    expect(describeRegime(p(0.029, 0.057)).regime).toBe('labyrinth'); // labyrinth
    // The `overgrowth` movement's own parameters sit nearest the coral/flower anchor — the movement
    // names are *intentions*, not regimes (§6.3).
    expect(describeRegime(p(0.045, 0.058)).regime).toBe('coral');
    // The measured death boundary still reads as dying: k = .0649 is the textbook mitosis point that
    // DIED on this solver, which is why the shipped trajectory no longer touches it (deviation 45).
    expect(describeRegime(p(0.0367, 0.0649)).regime).toBe('dying');
  });

  it('formats readable one-liners', () => {
    expect(formatRegime(describeRegime(p(0.029, 0.057)))).toBe('labyrinth (nearest @ .029/.057, d=0.000)');
    expect(formatRegime(describeRegime(p(0.005, 0.075)))).toBe(
      'dying (nonviable: k above the measured death boundary 0.0635)',
    );
    const far = formatRegime(describeRegime(p(0.09, 0.01)));
    expect(far.startsWith('unmapped (nearest: coral @ .05')).toBe(true);
    expect(far.endsWith(', d=0.063)')).toBe(true);
  });

  it('is pure: it never mutates its input', () => {
    const params = p(0.03, 0.062);
    const frozen = Object.freeze(params);
    expect(() => describeRegime(frozen)).not.toThrow();
    expect(params).toEqual({ F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 });
  });
});
