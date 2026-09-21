/**
 * CPU reference solver.
 *
 * This is the numerical definition of the system, mirrored operation-for-operation from
 * `shaders/step.frag` in float32 (`Math.fround`) so that GPU-vs-CPU comparison at 1 and 10
 * steps measures real agreement rather than a precision artefact (§12.1, AC.2).
 *
 * It is also the source of the 10,000-step smoke test and of the offline parameter search in
 * `scripts/tune.ts`. The renderer never uses it.
 */
import type { Params } from '../core/types.ts';

const f = Math.fround;

export interface StepOutcome {
  /** Cells where the unclamped update left [0,1] (i.e. the clamp guard bound). */
  clippedU: number;
  clippedV: number;
  /** Largest unclamped excursion, for laboratory validation. */
  maxExcursion: number;
}

export interface FieldStats {
  meanU: number;
  meanV: number;
  minV: number;
  maxV: number;
  occupiedFraction: number;
  reactionActivity: number;
  edgeDensity: number;
  nonFinite: number;
  /**
   * Cells whose value sits exactly on a clamp bound. On the GPU this is the only observable
   * clipping proxy: it includes the untouched empty region where U is exactly 1, so it is a
   * conservative witness, not a count. The authoritative clipping frequency comes from the CPU
   * reference's `StepOutcome.clippedU/clippedV`, which counts pre-clamp excursions.
   */
  saturatedCells: number;
}

export class ReferenceSolver {
  readonly width: number;
  readonly height: number;
  u: Float32Array;
  v: Float32Array;
  private nextU: Float32Array;
  private nextV: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.u = new Float32Array(width * height);
    this.v = new Float32Array(width * height);
    this.nextU = new Float32Array(width * height);
    this.nextV = new Float32Array(width * height);
  }

  /** Uniform (U=1, V=0): the invariant state §12.1 requires to survive stepping. */
  setUniform(uValue = 1, vValue = 0): void {
    this.u.fill(uValue);
    this.v.fill(vValue);
  }

  /**
   * §4.4 `single`: disk of target chemistry, replace or inject, toroidal distance.
   * Mirrors `shaders/genesis.frag`.
   */
  seedSingle(options: {
    centerCells: readonly [number, number];
    radiusCells: number;
    softnessCells: number;
    strength: number;
    target: readonly [number, number];
    mode: 'replace' | 'inject';
  }): void {
    const { centerCells, radiusCells, softnessCells, strength, target, mode } = options;
    const [cx, cy] = centerCells;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const index = y * this.width + x;
        const baseU = mode === 'replace' ? 1 : this.u[index]!;
        const baseV = mode === 'replace' ? 0 : this.v[index]!;
        const mask = diskMask(
          x + 0.5,
          y + 0.5,
          cx,
          cy,
          radiusCells,
          softnessCells,
          this.width,
          this.height,
        );
        const mix = mask * strength;
        this.u[index] = f(baseU + (target[0] - baseU) * mix);
        this.v[index] = f(baseV + (target[1] - baseV) * mix);
      }
    }
  }

  /** One Gray-Scott step over the full field, in place, with the same clamp guard. */
  step(params: Params, dt: number): StepOutcome {
    const { width, height, u, v, nextU, nextV } = this;
    const { F, k, Du, Dv } = params;
    let clippedU = 0;
    let clippedV = 0;
    let maxExcursion = 0;

    for (let y = 0; y < height; y += 1) {
      const yUp = ((y - 1 + height) % height) * width;
      const yDown = ((y + 1) % height) * width;
      const yRow = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = yRow + x;
        const xLeft = (x - 1 + width) % width;
        const xRight = (x + 1) % width;

        const cu = u[index]!;
        const cv = v[index]!;
        // Shader order is left to right: ((left + right) + (y-1)) + (y+1) - 4 * center.
        const lu = f(
          f(f(f(u[yRow + xLeft]! + u[yRow + xRight]!) + u[yUp + x]!) + u[yDown + x]!) - f(4 * cu),
        );
        const lv = f(
          f(f(f(v[yRow + xLeft]! + v[yRow + xRight]!) + v[yUp + x]!) + v[yDown + x]!) - f(4 * cv),
        );

        const reaction = f(f(cu * cv) * cv);

        const innerU = f(f(f(Du * lu) - reaction) + f(F * f(1 - cu)));
        const innerV = f(f(f(Dv * lv) + reaction) - f(f(F + k) * cv));

        const uRaw = f(cu + f(dt * innerU));
        const vRaw = f(cv + f(dt * innerV));

        if (uRaw < 0 || uRaw > 1) {
          clippedU += 1;
          maxExcursion = Math.max(maxExcursion, uRaw < 0 ? -uRaw : uRaw - 1);
        }
        if (vRaw < 0 || vRaw > 1) {
          clippedV += 1;
          maxExcursion = Math.max(maxExcursion, vRaw < 0 ? -vRaw : vRaw - 1);
        }

        nextU[index] = uRaw < 0 ? 0 : uRaw > 1 ? 1 : uRaw;
        nextV[index] = vRaw < 0 ? 0 : vRaw > 1 ? 1 : vRaw;
      }
    }

    // Swap the buffers by reference; fields are read through `u`/`v`.
    const tmpU = this.u;
    const tmpV = this.v;
    this.u = this.nextU;
    this.v = this.nextV;
    this.nextU = tmpU;
    this.nextV = tmpV;

    return { clippedU, clippedV, maxExcursion };
  }

  stats(vThreshold = 0.1): FieldStats {
    return fieldStats(this.u, this.v, this.width, this.height, vThreshold);
  }
}

/**
 * Descriptor-lite statistics over a (U,V) field. Shared by the CPU reference tests and by the
 * browser GPU run so both report the same numbers (AC.5).
 */
export function fieldStats(
  u: Float32Array,
  v: Float32Array,
  width: number,
  height: number,
  vThreshold = 0.1,
): FieldStats {
  let sumU = 0;
  let sumV = 0;
  let minV = Infinity;
  let maxV = -Infinity;
  let occupied = 0;
  let activity = 0;
  let edges = 0;
  let nonFinite = 0;
  let saturated = 0;
  const count = width * height;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const cu = u[index]!;
      const cv = v[index]!;
      if (!Number.isFinite(cu) || !Number.isFinite(cv)) nonFinite += 1;
      if (cu === 0 || cu === 1 || cv === 0 || cv === 1) saturated += 1;
      sumU += cu;
      sumV += cv;
      if (cv < minV) minV = cv;
      if (cv > maxV) maxV = cv;
      if (cv > vThreshold) occupied += 1;
      activity += cu * cv * cv;

      const xRight = (x + 1) % width;
      const yDown = (y + 1) % height;
      const dvx = v[y * width + xRight]! - cv;
      const dvy = v[yDown * width + x]! - cv;
      edges += Math.hypot(dvx, dvy);
    }
  }

  return {
    meanU: sumU / count,
    meanV: sumV / count,
    minV,
    maxV,
    occupiedFraction: occupied / count,
    reactionActivity: activity / count,
    edgeDensity: edges / count,
    nonFinite,
    saturatedCells: saturated,
  };
}

/**
 * Soft disk mask with toroidal distance, identical to the shader's smoothstep form.
 * `smoothstep(a, b, t)` = 0 below a, 1 above b, Hermite in between.
 */
export function diskMask(
  px: number,
  py: number,
  cx: number,
  cy: number,
  radius: number,
  softness: number,
  width: number,
  height: number,
): number {
  let dx = px - cx;
  let dy = py - cy;
  dx -= width * Math.floor(dx / width + 0.5);
  dy -= height * Math.floor(dy / height + 0.5);
  const dist = Math.hypot(dx, dy);
  return 1 - smoothstep(radius - softness, radius + softness, dist);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Largest absolute difference between two fields, with the offending index. */
export function maxAbsDiff(
  a: Float32Array,
  b: Float32Array,
): { max: number; index: number; aValue: number; bValue: number } {
  let max = 0;
  let index = -1;
  for (let i = 0; i < a.length; i += 1) {
    const diff = Math.abs(a[i]! - b[i]!);
    if (diff > max) {
      max = diff;
      index = i;
    }
  }
  return { max, index, aValue: index >= 0 ? a[index]! : 0, bValue: index >= 0 ? b[index]! : 0 };
}
