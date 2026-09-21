/**
 * §4.4 genesis geometry as data: determinism, ±5% bounds, pattern ranges, and asymmetry
 * (no regular lattices for competing/sparse).
 */
import { describe, expect, it } from 'vitest';
import {
  GENESIS_GEOMETRY,
  collectDisks,
  generateCompeting,
  generateGeometry,
  generateLine,
  generateRadial,
  generateRing,
  generateSingle,
  generateSparse,
  generateStructured,
  type SeedDisk,
} from '../src/simulation/genesis-geometry.ts';

const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

describe('genesis geometry: determinism', () => {
  it('produces identical geometry for the same seed', () => {
    for (const kind of ['single', 'competing', 'line', 'ring', 'sparse', 'radial', 'structured'] as const) {
      const a = generateGeometry(kind, { seed: 4242 });
      const b = generateGeometry(kind, { seed: 4242 });
      expect(a).toEqual(b);
    }
  });

  it('produces different geometry for different seeds', () => {
    expect(generateGeometry('competing', { seed: 1 })).not.toEqual(generateGeometry('competing', { seed: 2 }));
    expect(generateGeometry('structured', { seed: 1 })).not.toEqual(generateGeometry('structured', { seed: 2 }));
  });

  it('dispatches by kind to the specific generator', () => {
    expect(generateGeometry('single', { seed: 9 })).toEqual(generateSingle({ seed: 9 }));
    expect(generateGeometry('competing', { seed: 9 })).toEqual(generateCompeting({ seed: 9 }));
    expect(generateGeometry('line', { seed: 9 })).toEqual(generateLine({ seed: 9 }));
    expect(generateGeometry('ring', { seed: 9 })).toEqual(generateRing({ seed: 9 }));
    expect(generateGeometry('sparse', { seed: 9 })).toEqual(generateSparse({ seed: 9 }));
    expect(generateGeometry('radial', { seed: 9 })).toEqual(generateRadial({ seed: 9 }));
    expect(generateGeometry('structured', { seed: 9 })).toEqual(generateStructured({ seed: 9 }));
  });
});

describe('genesis geometry: ±5% variation bounds', () => {
  it('position, radius, and strength stay within ±5% of the un-jittered nominal', () => {
    const positionBound = GENESIS_GEOMETRY.variation * GENESIS_GEOMETRY.positionJitterUV + 1e-9;
    for (const seed of SEEDS) {
      const nominal = generateCompeting({ seed, variation: 0 });
      const jittered = generateCompeting({ seed, variation: GENESIS_GEOMETRY.variation });
      expect(jittered.disks).toHaveLength(nominal.disks.length);
      nominal.disks.forEach((disk, index) => {
        const other = jittered.disks[index]!;
        expect(Math.abs(other.center[0] - disk.center[0])).toBeLessThanOrEqual(positionBound);
        expect(Math.abs(other.center[1] - disk.center[1])).toBeLessThanOrEqual(positionBound);
        expect(other.radiusCells).toBeGreaterThanOrEqual(disk.radiusCells * 0.95 - 1e-9);
        expect(other.radiusCells).toBeLessThanOrEqual(disk.radiusCells * 1.05 + 1e-9);
        expect(other.strength).toBeGreaterThanOrEqual(0);
        expect(other.strength).toBeLessThanOrEqual(1);
      });
    }
  });

  it('variation 0 returns exactly the nominal geometry', () => {
    const a = generateRing({ seed: 5, variation: 0 });
    const b = generateRing({ seed: 5, variation: 0 });
    expect(a).toEqual(b);
  });

  it('keeps ring radius and wall inside the documented ±5% ranges (§4.4)', () => {
    for (const seed of SEEDS) {
      const geometry = generateRing({ seed });
      if (geometry.kind !== 'ring') throw new Error('kind mismatch');
      expect(geometry.ring.radiusCells).toBeGreaterThanOrEqual(18 * 0.95 - 1e-9);
      expect(geometry.ring.radiusCells).toBeLessThanOrEqual(30 * 1.05 + 1e-9);
      expect(geometry.ring.wallCells).toBeGreaterThanOrEqual(3 * 0.95 - 1e-9);
      expect(geometry.ring.wallCells).toBeLessThanOrEqual(5 * 1.05 + 1e-9);
    }
  });
});

describe('genesis geometry: pattern ranges (§4.4)', () => {
  it('single is one disk of nominal radius 6 cells', () => {
    const geometry = generateSingle({ seed: 3, variation: 0 });
    expect(geometry.disks).toHaveLength(1);
    const disk = geometry.disks[0]!;
    expect(disk.radiusCells).toBeGreaterThanOrEqual(6 * 0.95 - 1e-9);
    expect(disk.radiusCells).toBeLessThanOrEqual(6 * 1.05 + 1e-9);
    expect(disk.center).toEqual([0.5, 0.5]);
  });

  it('competing places 3–5 disks inside the central 40% of the domain', () => {
    for (const seed of SEEDS) {
      const geometry = generateCompeting({ seed });
      expect(geometry.disks.length).toBeGreaterThanOrEqual(3);
      expect(geometry.disks.length).toBeLessThanOrEqual(5);
      for (const disk of geometry.disks) {
        expect(disk.center[0]).toBeGreaterThanOrEqual(0.3 - 0.02);
        expect(disk.center[0]).toBeLessThanOrEqual(0.7 + 0.02);
        expect(disk.center[1]).toBeGreaterThanOrEqual(0.3 - 0.02);
        expect(disk.center[1]).toBeLessThanOrEqual(0.7 + 0.02);
      }
    }
  });

  it('sparse places 8–20 small, deliberately separated disks', () => {
    for (const seed of SEEDS) {
      const geometry = generateSparse({ seed });
      expect(geometry.disks.length).toBeGreaterThanOrEqual(8);
      expect(geometry.disks.length).toBeLessThanOrEqual(20);
      for (const disk of geometry.disks) {
        expect(disk.radiusCells).toBeGreaterThanOrEqual(2 * 0.95 - 1e-9);
        expect(disk.radiusCells).toBeLessThanOrEqual(4 * 1.05 + 1e-9);
      }
    }
  });

  it('line is 2–4 cells wide and 8–15% of the domain long', () => {
    for (const seed of SEEDS) {
      const geometry = generateLine({ seed, gridWidth: 768, gridHeight: 768 });
      if (geometry.kind !== 'line') throw new Error('kind mismatch');
      const { a, b, widthCells } = geometry.line;
      const lengthCells = Math.hypot((b[0] - a[0]) * 768, (b[1] - a[1]) * 768);
      const fraction = lengthCells / 768;
      expect(fraction).toBeGreaterThanOrEqual(0.08 * 0.95 - 1e-9);
      expect(fraction).toBeLessThanOrEqual(0.15 * 1.05 + 1e-9);
      expect(widthCells).toBeGreaterThanOrEqual(2 * 0.95 - 1e-9);
      expect(widthCells).toBeLessThanOrEqual(4 * 1.05 + 1e-9);
    }
  });

  it('radial is a near-threshold halo around a small viable core', () => {
    for (const seed of SEEDS) {
      const geometry = generateRadial({ seed });
      if (geometry.kind !== 'radial') throw new Error('kind mismatch');
      const { coreRadiusCells, radiusCells, coreStrength, haloStrength } = geometry.radial;
      expect(coreRadiusCells).toBeGreaterThanOrEqual(3 * 0.95 - 1e-9);
      expect(coreRadiusCells).toBeLessThanOrEqual(5 * 1.05 + 1e-9);
      expect(radiusCells).toBeGreaterThanOrEqual(40 * 0.95 - 1e-9);
      expect(radiusCells).toBeLessThanOrEqual(80 * 1.05 + 1e-9);
      expect(coreStrength).toBeGreaterThan(haloStrength);
      expect(haloStrength).toBeLessThanOrEqual(0.2);
    }
  });

  it('structured confines a low-amplitude perturbation to an elliptical support plus one core', () => {
    for (const seed of SEEDS) {
      const geometry = generateStructured({ seed });
      if (geometry.kind !== 'structured') throw new Error('kind mismatch');
      const { semiMajorCells, semiMinorCells, amplitude, core } = geometry.structured;
      expect(semiMajorCells).toBeGreaterThanOrEqual(60 * 0.95 - 1e-9);
      expect(semiMajorCells).toBeLessThanOrEqual(120 * 1.05 + 1e-9);
      expect(semiMinorCells).toBeGreaterThanOrEqual(30 * 0.95 - 1e-9);
      expect(semiMinorCells).toBeLessThanOrEqual(70 * 1.05 + 1e-9);
      expect(amplitude).toBeLessThanOrEqual(0.25);
      expect(core.radiusCells).toBeGreaterThan(0);
    }
  });
});

describe('genesis geometry: asymmetry (no regular lattices)', () => {
  function nearestNeighbourDistances(disks: SeedDisk[], grid: number): number[] {
    return disks.map((disk, i) => {
      let best = Number.POSITIVE_INFINITY;
      disks.forEach((other, j) => {
        if (i === j) return;
        const d = Math.hypot((disk.center[0] - other.center[0]) * grid, (disk.center[1] - other.center[1]) * grid);
        if (d < best) best = d;
      });
      return best;
    });
  }

  function variance(values: number[]): number {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  }

  it('competing spacing is non-uniform (nearest-neighbour distances are not all equal)', () => {
    let sawNonUniform = false;
    for (const seed of SEEDS) {
      const geometry = generateCompeting({ seed, gridWidth: 768, gridHeight: 768, variation: 0 });
      const distances = nearestNeighbourDistances(geometry.disks, 768);
      expect(distances.every((d) => d >= 12 * 0.8)).toBe(true);
      if (variance(distances) > 1e-3) sawNonUniform = true;
    }
    expect(sawNonUniform).toBe(true);
  });

  it('sparse spacing is non-uniform and every pair is well separated', () => {
    let sawNonUniform = false;
    for (const seed of SEEDS) {
      const geometry = generateSparse({ seed, gridWidth: 768, gridHeight: 768, variation: 0 });
      const distances = nearestNeighbourDistances(geometry.disks, 768);
      expect(distances.every((d) => d >= 24 * 0.8)).toBe(true);
      if (variance(distances) > 1e-3) sawNonUniform = true;
    }
    expect(sawNonUniform).toBe(true);
  });

  it('collectDisks flattens disk patterns and is empty for the others', () => {
    expect(collectDisks(generateCompeting({ seed: 1 })).length).toBeGreaterThanOrEqual(3);
    expect(collectDisks(generateSparse({ seed: 1 })).length).toBeGreaterThanOrEqual(8);
    expect(collectDisks(generateRing({ seed: 1 }))).toHaveLength(0);
    expect(collectDisks(generateLine({ seed: 1 }))).toHaveLength(0);
  });
});
