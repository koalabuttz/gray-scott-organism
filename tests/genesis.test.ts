/**
 * AC.3 — uniform (U=1,V=0) invariance, genesis scope, and the read/write attachment guard.
 *
 * The GPU half of AC.3 (a live attachment check plus a stepped uniform field on the real
 * device) runs in `browser/gpu-correctness.spec.ts`; this file covers the same properties on the
 * CPU mirror and on the pure guard functions so a regression is caught without a GPU.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, GENESIS, TIME } from '../src/config.ts';
import {
  PATTERN_INDEX,
  SUPPORTED_PATTERNS,
  applyGenesisCPU,
  assertNoFeedback,
  commandToUniforms,
  createSingleSeedCommand,
  genesisMaskCPU,
  isSupportedGenesis,
} from '../src/simulation/genesis.ts';
import type { GenesisKind } from '../src/core/types.ts';
import { ReferenceSolver, diskMask } from '../src/simulation/reference.ts';

describe('uniform invariance (AC.3)', () => {
  it('keeps (U=1, V=0) exactly invariant under stepping', () => {
    const solver = new ReferenceSolver(48, 48);
    solver.setUniform(1, 0);
    for (let i = 0; i < 1000; i += 1) solver.step(DEFAULT_PARAMS, TIME.dt);
    const stats = solver.stats();
    expect(stats.meanU).toBe(1);
    expect(stats.meanV).toBe(0);
    expect(stats.minV).toBe(0);
    expect(stats.maxV).toBe(0);
  });

  it('does not disturb the invariance at other parameter points in the envelope', () => {
    for (const params of [
      { F: 0.026, k: 0.06, Du: 0.16, Dv: 0.08 },
      { F: 0.0545, k: 0.062, Du: 0.16, Dv: 0.08 },
      { F: 0.005, k: 0.075, Du: 0.16, Dv: 0.08 },
    ]) {
      const solver = new ReferenceSolver(16, 16);
      solver.setUniform(1, 0);
      for (let i = 0; i < 50; i += 1) solver.step(params, TIME.dt);
      expect(solver.v.every((value) => value === 0)).toBe(true);
      expect(solver.u.every((value) => value === 1)).toBe(true);
    }
  });
});

describe('genesis scope (AC.3)', () => {
  it('only changes the intended support in inject mode', () => {
    const width = 64;
    const height = 64;
    const solver = new ReferenceSolver(width, height);
    solver.setUniform(1, 0);
    const before = Float32Array.from(solver.u);
    const command = createSingleSeedCommand({
      center: [0.5, 0.5],
      seed: 5,
      perturb: false,
      radiusCells: 8,
      strength: 1,
      mode: 'inject',
    });
    applyGenesisCPU(solver, command);

    const uniforms = commandToUniforms(command, width, height);
    const outerRadius = uniforms.radiusCells + GENESIS.edgeSoftnessCells + 0.5;
    let changedOutside = 0;
    let changedInside = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const mask = diskMask(x + 0.5, y + 0.5, uniforms.centerCells[0], uniforms.centerCells[1], uniforms.radiusCells, uniforms.softnessCells, width, height);
        const changed = solver.u[index] !== before[index] || solver.v[index] !== 0;
        if (mask > 0) {
          if (changed) changedInside += 1;
        } else if (changed) {
          changedOutside += 1;
        }
      }
    }
    console.info(`[AC.3] genesis support: radius<=${outerRadius} cells, changedInside=${changedInside}, changedOutside=${changedOutside}`);
    expect(changedOutside).toBe(0);
    expect(changedInside).toBeGreaterThan(0);
    // The seed moves chemistry toward the target, not away from it.
    const centerIndex = (height / 2) * width + width / 2;
    expect(solver.v[centerIndex]!).toBeCloseTo(GENESIS.targetV, 3);
    expect(solver.u[centerIndex]!).toBeCloseTo(GENESIS.targetU, 3);
  });

  it('replace mode resets the surrounding field to (1,0)', () => {
    const width = 48;
    const height = 48;
    const solver = new ReferenceSolver(width, height);
    solver.setUniform(0.3, 0.7);
    applyGenesisCPU(
      solver,
      createSingleSeedCommand({ center: [0.5, 0.5], seed: 1, perturb: false, radiusCells: 6, strength: 1, mode: 'replace' }),
    );
    const corner = 0;
    expect(solver.u[corner]).toBe(1);
    expect(solver.v[corner]).toBe(0);
    const center = (height / 2) * width + width / 2;
    expect(solver.v[center]!).toBeGreaterThan(0.2);
  });

  it('wraps a seed placed across the seam so it stays a single disk', () => {
    const width = 64;
    const height = 64;
    const solver = new ReferenceSolver(width, height);
    solver.setUniform(1, 0);
    const command = createSingleSeedCommand({
      center: [0, 0.5],
      seed: 2,
      perturb: false,
      radiusCells: 6,
      strength: 1,
      mode: 'replace',
    });
    applyGenesisCPU(solver, command);
    // The disk is present on both sides of the seam and nowhere else.
    expect(solver.v[32 * width + 0]!).toBeGreaterThan(0.2);
    expect(solver.v[32 * width + width - 1]!).toBeGreaterThan(0.2);
    expect(solver.v[32 * width + 20]!).toBe(0);
    // Column 1 must be a continuation of column width-1, not a second seed centre.
    expect(Math.abs(solver.v[32 * width + 1]! - solver.v[32 * width + width - 1]!)).toBeLessThan(0.05);
  });

  it('implements every declared pattern (§4.4, deviation 12 replaced)', () => {
    expect(SUPPORTED_PATTERNS).toEqual([
      'single',
      'competing',
      'line',
      'ring',
      'sparse',
      'radial',
      'structured',
    ]);
    // Shader pattern indices are distinct and contiguous (they select a branch in genesis.frag).
    const indices = SUPPORTED_PATTERNS.map((kind) => PATTERN_INDEX[kind]);
    expect(new Set(indices).size).toBe(7);
    expect(Math.min(...indices)).toBe(0);
    expect(Math.max(...indices)).toBe(6);
    for (const kind of SUPPORTED_PATTERNS) {
      const command = { ...createSingleSeedCommand({ center: [0.5, 0.5], seed: 1, perturb: false }), kind };
      expect(isSupportedGenesis(command)).toBe(true);
      expect(() => commandToUniforms(command, 64, 64)).not.toThrow();
    }
  });

  it('changes exactly the masked support of each pattern, and nothing outside it', () => {
    const size = 128;
    for (const kind of SUPPORTED_PATTERNS) {
      const command = {
        ...createSingleSeedCommand({ center: [0.5, 0.5], seed: 991, perturb: false, radiusCells: 8 }),
        kind,
      };
      const uniforms = commandToUniforms(command, size, size);
      const field = {
        u: new Float32Array(size * size).fill(1),
        v: new Float32Array(size * size),
        width: size,
        height: size,
      };
      applyGenesisCPU(field, command);

      let insideTotal = 0;
      let insideChanged = 0;
      let outsideChanged = 0;
      let viableCells = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const index = y * size + x;
          const mask = genesisMaskCPU(uniforms, x, y, size, size);
          if (mask > 0.5) {
            insideTotal += 1;
            if (field.v[index]! > 1e-6) insideChanged += 1;
          }
          if (mask === 0 && (field.u[index] !== 1 || field.v[index] !== 0)) outsideChanged += 1;
          if (field.v[index]! > 0.2) viableCells += 1;
        }
      }
      expect(insideTotal, `${kind}: must place some support`).toBeGreaterThan(0);
      expect(insideChanged, `${kind}: must change its masked support`).toBeGreaterThan(0);
      expect(outsideChanged, `${kind}: must leave everything outside the support at (1,0)`).toBe(0);
      expect(viableCells, `${kind}: must reach a viable concentration somewhere`).toBeGreaterThan(0);
    }
  });

  it('is deterministic per seed, and seed-dependent where the geometry is', () => {
    const size = 64;
    const run = (kind: GenesisKind, seed: number): number[] => {
      const command = { ...createSingleSeedCommand({ center: [0.5, 0.5], seed, perturb: false }), kind };
      const field = {
        u: new Float32Array(size * size).fill(1),
        v: new Float32Array(size * size),
        width: size,
        height: size,
      };
      applyGenesisCPU(field, command);
      return Array.from(field.v);
    };
    for (const kind of SUPPORTED_PATTERNS) {
      expect(run(kind, 7), `${kind}: same seed must reproduce`).toEqual(run(kind, 7));
      // `single` honours the command's own centre/radius/strength, so its geometry is seed-independent.
      if (kind !== 'single') {
        expect(run(kind, 7), `${kind}: a different seed must change the geometry`).not.toEqual(run(kind, 8));
      }
    }
  });

  it('builds deterministic, bounded commands', () => {
    const first = createSingleSeedCommand({ center: [0.4, 0.6], seed: 777, perturb: true });
    const second = createSingleSeedCommand({ center: [0.4, 0.6], seed: 777, perturb: true });
    expect(second.radiusCells).toBeCloseTo(first.radiusCells, 12);
    expect(second.strength).toBeCloseTo(first.strength, 12);
    expect(second.center).toEqual(first.center);
    // §4.4: strength and radius vary by roughly ±5%, position only slightly.
    expect(Math.abs(first.strength - 1)).toBeLessThanOrEqual(0.050001);
    expect(Math.abs(first.radiusCells - GENESIS.defaultRadiusCells)).toBeLessThanOrEqual(0.050001 * GENESIS.defaultRadiusCells);
    expect(Math.abs(first.center[0] - 0.4)).toBeLessThanOrEqual(0.005);
  });
});

describe('genesis strength is a global mask multiplier (MAJOR 4, deviation 41)', () => {
  const size = 96;
  const inertField = (): { u: Float32Array; v: Float32Array; width: number; height: number } => {
    // A live, non-uniform field the command has to actively wipe.
    const u = new Float32Array(size * size).fill(0.35);
    const v = new Float32Array(size * size).fill(0.62);
    return { u, v, width: size, height: size };
  };

  it('strength: 0 replace leaves exactly (1, 0) everywhere, for every supported kind', () => {
    for (const kind of SUPPORTED_PATTERNS) {
      const command = {
        ...createSingleSeedCommand({ center: [0.5, 0.5], seed: 4242, perturb: false, radiusCells: 8 }),
        kind,
        strength: 0,
        mode: 'replace' as const,
      };
      const field = inertField();
      applyGenesisCPU(field, command);
      let nonInert = 0;
      let maxV = 0;
      for (let i = 0; i < field.u.length; i += 1) {
        if (field.u[i] !== 1 || field.v[i] !== 0) nonInert += 1;
        if (field.v[i]! > maxV) maxV = field.v[i]!;
      }
      // This is the reported bug: radial/structured used to leave a viable core at full strength.
      expect(nonInert, `${kind}: strength-0 replace must be exactly inert`).toBe(0);
      expect(maxV, `${kind}: no viable core may survive a strength-0 replace`).toBe(0);
    }
  });

  it('strength: 0 inject leaves the field completely unchanged, for every supported kind', () => {
    for (const kind of SUPPORTED_PATTERNS) {
      const command = {
        ...createSingleSeedCommand({ center: [0.5, 0.5], seed: 91, perturb: false, radiusCells: 8 }),
        kind,
        strength: 0,
        mode: 'inject' as const,
      };
      const field = inertField();
      const beforeU = Float32Array.from(field.u);
      const beforeV = Float32Array.from(field.v);
      applyGenesisCPU(field, command);
      expect(Array.from(field.u), `${kind}: inject must not change U`).toEqual(Array.from(beforeU));
      expect(Array.from(field.v), `${kind}: inject must not change V`).toEqual(Array.from(beforeV));
    }
  });

  it('scales the assembled mask linearly with strength for every kind (single preserved at 1)', () => {
    // mask(s) = clamp(raw * shape * s) and raw*shape <= 1, so for s in [0, 1] mask(s) === s * mask(1).
    for (const kind of SUPPORTED_PATTERNS) {
      const base = createSingleSeedCommand({ center: [0.5, 0.5], seed: 31337, perturb: false, radiusCells: 8 });
      const full = commandToUniforms({ ...base, kind, strength: 1 }, size, size);
      const samples: Array<[number, number]> = [
        [48, 48],
        [20, 30],
        [70, 60],
        [5, 90],
        [90, 5],
      ];
      for (const [x, y] of samples) {
        const reference = genesisMaskCPU(full, x, y, size, size);
        for (const strength of [0, 0.25, 0.5, 0.75, 1]) {
          const scaled = commandToUniforms({ ...base, kind, strength }, size, size);
          const value = genesisMaskCPU(scaled, x, y, size, size);
          expect(value, `${kind}@s=${strength} at (${x},${y})`).toBeCloseTo(strength * reference, 5);
        }
      }
    }
  });
});

describe('read/write attachment feedback guard (AC.3)', () => {
  const textureA = { name: 'A' } as unknown as WebGLTexture;
  const textureB = { name: 'B' } as unknown as WebGLTexture;

  it('accepts distinct read and write attachments', () => {
    expect(() => assertNoFeedback(textureA, textureB, 'unit')).not.toThrow();
    expect(() => assertNoFeedback(null, textureB, 'unit')).not.toThrow();
  });

  it('rejects sampling the texture attached as the write target', () => {
    expect(() => assertNoFeedback(textureA, textureA, 'step')).toThrowError(/read\/write attachment feedback/);
  });
});
