/**
 * §7.3/AC.10 topology fixtures: empty, disk, two disks, ring, figure-eight, diagonal contact,
 * edge-crossing and noisy isolated pixels, asserting both the component/hole counts and the
 * confidence behavior (seam involvement and sub-minimum artifacts lower it; a clean interior shape
 * does not), plus cross-sample merge tracking.
 */
import { describe, expect, it } from 'vitest';
import { TopologyAnalyzer } from '../src/analysis/topology.ts';

const SIZE = 48;

type Grid = Float32Array;

function empty(): Grid {
  return new Float32Array(SIZE * SIZE);
}

function fillRect(grid: Grid, x0: number, y0: number, x1: number, y1: number, value = 1): void {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) grid[y * SIZE + x] = value;
}

function disk(grid: Grid, cx: number, cy: number, r: number, value = 1): void {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) grid[y * SIZE + x] = value;
    }
  }
}

function ring(grid: Grid, cx: number, cy: number, outer: number, inner: number): void {
  disk(grid, cx, cy, outer);
  disk(grid, cx, cy, inner, 0);
}

function analyze(grid: Grid) {
  return new TopologyAnalyzer(SIZE).analyze(grid, 0);
}

describe('§7.3 topology fixtures (AC.10)', () => {
  it('empty field: no components, no holes, confident', () => {
    const r = analyze(empty());
    expect(r.beta0Approx).toBe(0);
    expect(r.beta1Approx).toBe(0);
    expect(r.topologyConfidence).toBeCloseTo(1, 6);
    expect(r.seamInvolved).toBe(false);
  });

  it('one disk: one component, no holes, high confidence', () => {
    const grid = empty();
    disk(grid, SIZE / 2, SIZE / 2, 10);
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(1);
    expect(r.beta1Approx).toBe(0);
    expect(r.largestComponentFraction).toBeCloseTo(1, 3);
    expect(r.topologyConfidence).toBeCloseTo(1, 3);
    expect(r.seamInvolved).toBe(false);
  });

  it('two disks: two components, no holes', () => {
    const grid = empty();
    disk(grid, 12, 12, 6);
    disk(grid, 36, 36, 6);
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(2);
    expect(r.beta1Approx).toBe(0);
  });

  it('ring: one component, one hole', () => {
    const grid = empty();
    ring(grid, SIZE / 2, SIZE / 2, 14, 7);
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(1);
    expect(r.beta1Approx).toBe(1);
  });

  it('figure-eight: one component, two holes', () => {
    const grid = empty();
    // Two square frames joined by a bridge at mid-height: one connected component, two holes.
    fillRect(grid, 4, 8, 22, 40);
    fillRect(grid, 7, 11, 19, 37, 0);
    fillRect(grid, 26, 8, 44, 40);
    fillRect(grid, 29, 11, 41, 37, 0);
    fillRect(grid, 20, 22, 28, 26); // bridge
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(1);
    expect(r.beta1Approx).toBe(2);
  });

  it('diagonal contact: two components under 4-connectivity, no manufactured join', () => {
    const grid = empty();
    fillRect(grid, 8, 8, 14, 14);
    fillRect(grid, 14, 14, 20, 20); // touches only diagonally at (13,13)-(14,14)
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(2);
    expect(r.beta1Approx).toBe(0);
  });

  it('edge-crossing object: one component and lowered confidence from seam involvement', () => {
    const grid = empty();
    fillRect(grid, 0, 20, SIZE, 28); // spans left to right edges
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(1);
    expect(r.seamInvolved).toBe(true);
    expect(r.topologyConfidence).toBeLessThanOrEqual(0.4);
  });

  it('noisy isolated pixels: removed as artifacts, zero components, low confidence', () => {
    const grid = empty();
    let seed = 1;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 80; i += 1) {
      const x = Math.floor(rand() * SIZE);
      const y = Math.floor(rand() * SIZE);
      grid[y * SIZE + x] = 1;
    }
    const r = analyze(grid);
    expect(r.beta0Approx).toBe(0);
    expect(r.counts[1].artifacts).toBeGreaterThan(0);
    expect(r.topologyConfidence).toBeLessThan(0.2);
  });
});

describe('§7.3 component tracking across samples', () => {
  it('preserves IDs for stable shapes and flags a merge when two sources enter one destination', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const first = empty();
    disk(first, 12, 24, 6);
    disk(first, 36, 24, 6);
    const r1 = analyzer.analyze(first, 0);
    expect(r1.labelCount).toBe(2);
    expect(r1.mergeCandidates).toBe(0);

    // The two disks grow until they fuse into a single component: one destination, two sources.
    const second = empty();
    disk(second, 12, 24, 6);
    disk(second, 36, 24, 6);
    fillRect(second, 17, 21, 31, 27); // bridge that joins them
    const r2 = analyzer.analyze(second, 1);
    expect(r2.labelCount).toBe(1);
    expect(r2.mergeCandidates).toBeGreaterThanOrEqual(1);
  });

  it('reports a new persistent component after the birth-persistence sample count', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const emptyGrid = empty();
    expect(analyzer.analyze(emptyGrid, 0).hasNewPersistentComponent).toBe(false);
    const one = empty();
    disk(one, 24, 24, 6);
    expect(analyzer.analyze(one, 1).hasNewPersistentComponent).toBe(false);
    expect(analyzer.analyze(one, 2).hasNewPersistentComponent).toBe(false);
    // Third consecutive sample with the same component: it has persisted.
    expect(analyzer.analyze(one, 3).hasNewPersistentComponent).toBe(true);
  });

  it('does not track an isolated pixel, so it never becomes a persistent component (MAJOR 2)', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const grid = empty();
    grid[24 * SIZE + 24] = 1;
    for (let sample = 0; sample < 5; sample += 1) {
      const r = analyzer.analyze(grid, sample);
      expect(r.hasNewPersistentComponent, `no persistent component at sample ${sample}`).toBe(false);
      expect(r.labelCount, `no tracked component at sample ${sample}`).toBe(0);
      expect(r.counts[1].artifacts, 'the pixel is still recorded as a filtered artifact').toBeGreaterThan(0);
    }
  });

  it('births a retained component exactly once after the persistence sample count (MAJOR 2)', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const grid = empty();
    fillRect(grid, 23, 23, 26, 26); // 3x3, above the 3-pixel minimum
    const births: number[] = [];
    for (let sample = 0; sample < 6; sample += 1) {
      if (analyzer.analyze(grid, sample).hasNewPersistentComponent) births.push(sample);
    }
    expect(births, 'the retained component births exactly once').toHaveLength(1);
  });
});
