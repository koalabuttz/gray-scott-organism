/**
 * AC.2 (CPU half) and AC.5 (CPU half).
 *
 * - the CPU reference solver is checked against an independently written implementation of the
 *   §4.2 equations, so the reference itself is not the only definition under test;
 * - toroidal wrapping is verified by translation invariance across the seam;
 * - a 10,000-step smoke run records the clipping frequency.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, TIME } from '../src/config.ts';
import { ReferenceSolver, maxAbsDiff, smoothstep } from '../src/simulation/reference.ts';
import { applyGenesisCPU, createSingleSeedCommand } from '../src/simulation/genesis.ts';
import { CLIPPING_FREQUENCY_BOUND, GPU_CPU_TOLERANCE_10_STEPS, GPU_CPU_TOLERANCE_1_STEP } from './support/tolerances.ts';

/** A deliberately naive, independently structured evaluation of the same equations. */
function naiveStep(
  u: Float64Array,
  v: Float64Array,
  width: number,
  height: number,
  params: { F: number; k: number; Du: number; Dv: number },
  dt: number,
): { u: Float64Array; v: Float64Array } {
  const next = { u: new Float64Array(u.length), v: new Float64Array(v.length) };
  const at = (field: Float64Array, x: number, y: number): number =>
    field[((y % height) + height) % height * width + (((x % width) + width) % width)]!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const cu = u[index]!;
      const cv = v[index]!;
      const laplaceU = at(u, x - 1, y) + at(u, x + 1, y) + at(u, x, y - 1) + at(u, x, y + 1) - 4 * cu;
      const laplaceV = at(v, x - 1, y) + at(v, x + 1, y) + at(v, x, y - 1) + at(v, x, y + 1) - 4 * cv;
      const reaction = cu * cv * cv;
      next.u[index] = Math.min(1, Math.max(0, cu + dt * (params.Du * laplaceU - reaction + params.F * (1 - cu))));
      next.v[index] = Math.min(1, Math.max(0, cv + dt * (params.Dv * laplaceV + reaction - (params.F + params.k) * cv)));
    }
  }
  return next;
}

function seedField(width: number, height: number, center: readonly [number, number], radius: number): ReferenceSolver {
  const solver = new ReferenceSolver(width, height);
  solver.setUniform(1, 0);
  applyGenesisCPU(
    solver,
    createSingleSeedCommand({ center: [center[0] / width, center[1] / height], seed: 3, perturb: false, radiusCells: radius, strength: 1, mode: 'replace' }),
  );
  return solver;
}

describe('CPU reference solver (AC.2)', () => {
  it('records the GPU-vs-CPU tolerances used by the browser comparison', () => {
    console.info(
      `[AC.2] recorded tolerances: 1 step <= ${GPU_CPU_TOLERANCE_1_STEP}, 10 steps <= ${GPU_CPU_TOLERANCE_10_STEPS}`,
    );
    expect(GPU_CPU_TOLERANCE_1_STEP).toBeGreaterThan(0);
    expect(GPU_CPU_TOLERANCE_10_STEPS).toBeGreaterThan(GPU_CPU_TOLERANCE_1_STEP);
  });

  it('agrees with an independent implementation of the equations', () => {
    const width = 32;
    const height = 32;
    const solver = seedField(width, height, [16, 16], 5);

    const double: { u: Float64Array; v: Float64Array } = {
      u: new Float64Array(solver.u),
      v: new Float64Array(solver.v),
    };
    let current = double;
    const floatSolver = new ReferenceSolver(width, height);
    floatSolver.u.set(solver.u);
    floatSolver.v.set(solver.v);

    for (let step = 0; step < 10; step += 1) {
      current = naiveStep(current.u, current.v, width, height, DEFAULT_PARAMS, TIME.dt);
      floatSolver.step(DEFAULT_PARAMS, TIME.dt);
    }

    const diffU = maxAbsDiff(floatSolver.u, Float32Array.from(current.u));
    const diffV = maxAbsDiff(floatSolver.v, Float32Array.from(current.v));
    console.info(`[AC.2] float32-vs-float64 after 10 steps: maxdU=${diffU.max.toExponential(3)} maxdV=${diffV.max.toExponential(3)}`);
    // float32 accumulation against a float64 evaluation of the same equations
    expect(diffU.max).toBeLessThan(1e-4);
    expect(diffV.max).toBeLessThan(1e-4);
  });

  it('is invariant in the uniform (U=1, V=0) state', () => {
    const solver = new ReferenceSolver(24, 24);
    solver.setUniform(1, 0);
    for (let i = 0; i < 500; i += 1) {
      const outcome = solver.step(DEFAULT_PARAMS, TIME.dt);
      expect(outcome.clippedU).toBe(0);
      expect(outcome.clippedV).toBe(0);
    }
    for (let i = 0; i < solver.u.length; i += 1) {
      expect(solver.u[i]).toBe(1);
      expect(solver.v[i]).toBe(0);
    }
  });

  it('wraps toroidally: a seed on the seam evolves as a translated copy of a central seed', () => {
    const width = 32;
    const height = 32;
    const central = seedField(width, height, [16, 16], 5);
    const seam = seedField(width, height, [0, 16], 5);

    for (let step = 0; step < 25; step += 1) {
      central.step(DEFAULT_PARAMS, TIME.dt);
      seam.step(DEFAULT_PARAMS, TIME.dt);
    }

    // Compare the seam run shifted by half the domain: with correct wrapping the two fields
    // must be identical (an implementation without wrapping shows edge artifacts here).
    let maxShifted = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const centralIndex = y * width + x;
        const shiftedIndex = y * width + ((x + width / 2) % width);
        maxShifted = Math.max(maxShifted, Math.abs(central.u[centralIndex]! - seam.u[shiftedIndex]!));
        maxShifted = Math.max(maxShifted, Math.abs(central.v[centralIndex]! - seam.v[shiftedIndex]!));
      }
    }
    console.info(`[AC.2] toroidal translation invariance after 25 steps: max difference ${maxShifted.toExponential(3)}`);
    expect(maxShifted).toBeLessThan(1e-6);
  });

  it('handles toroidal edges without seeding', () => {
    // A single non-uniform cell adjacent to both seams must diffuse across them.
    const width = 16;
    const height = 16;
    const solver = new ReferenceSolver(width, height);
    solver.setUniform(1, 0);
    solver.v[0] = 0.5;
    solver.u[0] = 0.5;
    solver.step(DEFAULT_PARAMS, TIME.dt);
    // (0,0) has neighbours (15,0), (1,0), (0,15), (0,1): the wrap must move chemistry there.
    expect(solver.v[15 * width + 0]!).toBeGreaterThan(0);
    expect(solver.v[0 * width + 15]!).toBeGreaterThan(0);
  });

  it('matches the smoothstep mask form used by the genesis shader', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('10,000-step smoke run (AC.5)', () => {
  it('stays finite and bounded, and records the clipping frequency', () => {
    const width = 128;
    const height = 128;
    const solver = seedField(width, height, [64, 64], 6);

    const steps = 10_000;
    let clippedU = 0;
    let clippedV = 0;
    let maxExcursion = 0;
    for (let i = 0; i < steps; i += 1) {
      const outcome = solver.step(DEFAULT_PARAMS, TIME.dt);
      clippedU += outcome.clippedU;
      clippedV += outcome.clippedV;
      if (outcome.maxExcursion > maxExcursion) maxExcursion = outcome.maxExcursion;
    }

    const updates = steps * width * height * 2;
    const clippingFrequency = (clippedU + clippedV) / updates;
    const stats = solver.stats(0.1);

    console.info(
      `[AC.5] 10,000 steps @ ${width}x${height}: clipping frequency ${clippingFrequency.toExponential(3)} ` +
        `(u=${clippedU}, v=${clippedV}), maxExcursion=${maxExcursion.toExponential(2)}, ` +
        `occupied=${stats.occupiedFraction.toFixed(4)}, meanV=${stats.meanV.toFixed(4)}, ` +
        `edgeDensity=${stats.edgeDensity.toFixed(5)}, activity=${stats.reactionActivity.toFixed(6)}`,
    );

    expect(stats.nonFinite).toBe(0);
    expect(clippingFrequency).toBeLessThan(CLIPPING_FREQUENCY_BOUND);
    expect(stats.minV).toBeGreaterThanOrEqual(0);
    expect(stats.maxV).toBeLessThanOrEqual(1);
    // The organism must actually be alive: a dead field would trivially satisfy "bounded".
    expect(stats.occupiedFraction).toBeGreaterThan(0.05);
    expect(stats.occupiedFraction).toBeLessThan(0.9);
    expect(stats.edgeDensity).toBeGreaterThan(0.001);
  });
});
