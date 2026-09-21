/**
 * §4.4 deterministic PRNG substreams.
 *
 * A recorded uint32 root seed plus a label-hashed substream keeps chemistry, curator, and sound
 * independent while staying reproducible.
 *
 * **Algorithm.** State advance is **SplitMix32** (Steele/Lea/Flood, as used to seed xoshiro):
 * each draw adds the golden-ratio constant `0x9e3779b9`, then applies the two-`Math.imul`
 * avalanche. It is small, integer-only, and has no floating-point instability, so replaying a
 * recorded seed reproduces the exact same stream on any engine (`Math.imul` is exact int32).
 *
 * **Substreams.** `substream(rootSeed, label)` mixes a FNV-1a hash of the label into the root.
 * `Rng.fork(label)` derives a substream from the *current* state, so forking does not disturb the
 * parent sequence. §4.4 names three substreams — chemistry, curator, sound — via
 * `SUBSTREAM_IDS`; the strings are stable identifiers, never renumbered.
 *
 * **Serialization.** `Rng.state()` / `Rng.fromState()` round-trip the algorithm tag, the uint32
 * state, and the draw count so a replay can checkpoint and resume exactly.
 */

export const UINT32_MAX = 0xffffffff;

/** §4.4: the three named substreams. Values are stable identifiers, never renumbered. */
export const SUBSTREAM_IDS = {
  chemistry: 'chemistry',
  curator: 'curator',
  sound: 'sound',
} as const;
export type SubstreamId = (typeof SUBSTREAM_IDS)[keyof typeof SUBSTREAM_IDS];

const GOLDEN_RATIO_32 = 0x9e3779b9;
const SCALE = 4294967296; // 2^32

/**
 * SplitMix32 step. Consecutive applications are the PRNG stream; the initial call also seeds the
 * generator, so `new Rng(seed)` stores `mix32(seed)`.
 */
export function mix32(x: number): number {
  let z = x >>> 0;
  z = (z + GOLDEN_RATIO_32) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** FNV-1a over the label, then mixed. Gives a stable substream seed per label. */
export function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return mix32(h);
}

/** Combine a root seed with a label into a stable substream seed. */
export function substream(rootSeed: number, label: string): number {
  return mix32((rootSeed >>> 0) ^ hashLabel(label));
}

/** Serializable generator state. */
export interface RngState {
  readonly algorithm: 'splitmix32';
  readonly state: number;
  readonly draws: number;
}

export class Rng {
  private stateInternal: number;
  private drawsInternal = 0;

  constructor(seed: number) {
    this.stateInternal = mix32(seed >>> 0);
  }

  /** Restore a generator from a previously captured state. */
  static fromState(state: RngState): Rng {
    const rng = new Rng(0);
    rng.restore(state);
    return rng;
  }

  /** Next uint32 in [0, 2^32). */
  nextUint32(): number {
    this.stateInternal = mix32(this.stateInternal);
    this.drawsInternal += 1;
    return this.stateInternal;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / SCALE;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform in [-magnitude, magnitude). */
  symmetric(magnitude: number): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  /** Number of draws taken since construction (or restoration). */
  get draws(): number {
    return this.drawsInternal;
  }

  /** Capture the full generator state for serialization/replay. */
  state(): RngState {
    return { algorithm: 'splitmix32', state: this.stateInternal, draws: this.drawsInternal };
  }

  /** Restore a previously captured state in place. */
  restore(state: RngState): void {
    if (state.algorithm !== 'splitmix32') {
      throw new Error(`unsupported PRNG algorithm '${String(state.algorithm)}'`);
    }
    this.stateInternal = state.state >>> 0;
    this.drawsInternal = Math.max(0, Math.floor(state.draws));
  }

  /** Copy the generator without disturbing this one. */
  clone(): Rng {
    return Rng.fromState(this.state());
  }

  /** Derive an independent substream from the current state. */
  fork(substreamId: string): Rng {
    return new Rng(substream(this.stateInternal, substreamId));
  }
}

export function randomRootSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! >>> 0;
  }
  return Math.floor(Math.random() * SCALE) >>> 0;
}

/** §4.4: convenience constructor for one of the named substreams (or any label). */
export function createSubstream(rootSeed: number, id: SubstreamId | string): Rng {
  return new Rng(substream(rootSeed, id));
}

/**
 * §4.4 bounded perturbations: vary seed position, asymmetry, strength by roughly ±5%,
 * duration by ±8%, and F/k offsets within ±0.0004. Kept generic so any caller can request a
 * documented fractional bound rather than hard-coding the numbers.
 */
export interface PerturbationBounds {
  positionFraction: number;
  radiusFraction: number;
  strengthFraction: number;
  durationFraction: number;
  parameterOffset: number;
}

export const DEFAULT_PERTURBATION: PerturbationBounds = {
  positionFraction: 0.05,
  radiusFraction: 0.05,
  strengthFraction: 0.05,
  durationFraction: 0.08,
  parameterOffset: 0.0004,
};

/** Multiplicative jitter within `1 ± fraction`, i.e. ±5% for `fraction = 0.05`. */
export function jitterMultiplier(rng: Rng, fraction: number): number {
  return 1 + rng.symmetric(fraction);
}

/** Apply a ±`fraction` multiplicative jitter to a nominal value. */
export function jitterValue(rng: Rng, nominal: number, fraction: number): number {
  return nominal * jitterMultiplier(rng, fraction);
}

/** §4.4: smooth parameter perturbation, correlated over 30–90 seconds (Phase 2 uses it). */
export function smoothParameterOffset(
  rng: Rng,
  bounds: PerturbationBounds,
): { F: number; k: number } {
  return {
    F: rng.symmetric(bounds.parameterOffset),
    k: rng.symmetric(bounds.parameterOffset),
  };
}
