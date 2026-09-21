/**
 * §4.4 genesis command geometry **as data**.
 *
 * Pure functions that turn a `GenesisKind` plus a recorded seed into a seed-geometry descriptor
 * (positions, radii, strengths) drawn from the chemistry PRNG substream. Nothing here touches a
 * shader, a texture, or `app.ts`: `genesis.frag` and the live wiring remain Phase-2 stubs that
 * throw (deviation 12), and this module only produces the numbers they will eventually consume.
 *
 * §4.4 pattern sizes and the ±5% variation bound are honoured: radii and strengths vary
 * multiplicatively by `variation` (default 5%), and positions by `variation` of the placement
 * region (`positionJitterUV`), so repeated performances are recognisably related but never
 * identical.
 *
 * Determinism is explicit: base geometry is drawn from `substream(seed, 'chemistry')`, and the
 * jitter is drawn from a **fork** of that generator taken after the base draws. Setting
 * `variation: 0` therefore returns the un-jittered nominal geometry for the same seed, which is
 * what makes the ±5% bound directly assertable in tests.
 */
import type { GenesisKind, Vec2 } from '../core/types.ts';
import { Rng, SUBSTREAM_IDS, substream } from '../core/random.ts';

export interface SeedDisk {
  center: Vec2;
  radiusCells: number;
  strength: number;
}

export interface SeedLine {
  a: Vec2;
  b: Vec2;
  widthCells: number;
  strength: number;
}

export interface SeedRing {
  center: Vec2;
  radiusCells: number;
  wallCells: number;
  strength: number;
}

export interface SeedRadial {
  center: Vec2;
  coreRadiusCells: number;
  radiusCells: number;
  coreStrength: number;
  haloStrength: number;
}

export interface SeedStructured {
  center: Vec2;
  semiMajorCells: number;
  semiMinorCells: number;
  rotationRadians: number;
  amplitude: number;
  core: SeedDisk;
}

export interface SingleGeometry {
  kind: 'single';
  disks: SeedDisk[];
}
export interface CompetingGeometry {
  kind: 'competing';
  disks: SeedDisk[];
}
export interface SparseGeometry {
  kind: 'sparse';
  disks: SeedDisk[];
}
export interface LineGeometry {
  kind: 'line';
  line: SeedLine;
}
export interface RingGeometry {
  kind: 'ring';
  ring: SeedRing;
}
export interface RadialGeometry {
  kind: 'radial';
  radial: SeedRadial;
}
export interface StructuredGeometry {
  kind: 'structured';
  structured: SeedStructured;
}

export type SeedGeometry =
  | SingleGeometry
  | CompetingGeometry
  | SparseGeometry
  | LineGeometry
  | RingGeometry
  | RadialGeometry
  | StructuredGeometry;

/** §4.4 pattern ranges (cells unless stated) and the placement-region size in UV. */
export const GENESIS_GEOMETRY = {
  /** Default ±5% variation bound (§4.4). */
  variation: 0.05,
  /** Position jitter is `variation * positionJitterUV` in UV (5% of the placement region). */
  positionJitterUV: 0.2,
  defaultGrid: 768,
  single: { radiusCells: 6 },
  competing: { countMin: 3, countMax: 5, regionUV: 0.4, radiusMin: 4, radiusMax: 9, minSeparationCells: 12 },
  line: { widthMin: 2, widthMax: 4, lengthFractionMin: 0.08, lengthFractionMax: 0.15 },
  ring: { radiusMin: 18, radiusMax: 30, wallMin: 3, wallMax: 5 },
  sparse: { countMin: 8, countMax: 20, regionUV: 0.7, radiusMin: 2, radiusMax: 4, minSeparationCells: 24 },
  radial: {
    coreRadiusMin: 3,
    coreRadiusMax: 5,
    radiusMin: 40,
    radiusMax: 80,
    coreStrength: 1,
    haloStrengthMin: 0.05,
    haloStrengthMax: 0.15,
  },
  structured: {
    semiMajorMin: 60,
    semiMajorMax: 120,
    semiMinorMin: 30,
    semiMinorMax: 70,
    amplitudeMin: 0.05,
    amplitudeMax: 0.2,
    coreRadiusCells: 6,
  },
} as const;

export interface GenesisGeometryOptions {
  /** Recorded uint32 root seed. */
  seed?: number;
  gridWidth?: number;
  gridHeight?: number;
  /** ±variation fractional bounds (default 0.05). 0 disables jitter. */
  variation?: number;
  /** Pattern centre in normalized UV; default [0.5, 0.5]. */
  center?: Vec2;
  /** Reuse an existing PRNG (drawn from it as-is); a chemistry substream otherwise. */
  rng?: Rng;
}

interface ResolvedOptions {
  rng: Rng;
  gridWidth: number;
  gridHeight: number;
  variation: number;
  center: Vec2;
}

function resolve(options: GenesisGeometryOptions): ResolvedOptions {
  const gridWidth = options.gridWidth ?? GENESIS_GEOMETRY.defaultGrid;
  const gridHeight = options.gridHeight ?? GENESIS_GEOMETRY.defaultGrid;
  const rng = options.rng ?? new Rng(substream((options.seed ?? 1) >>> 0, SUBSTREAM_IDS.chemistry));
  return {
    rng,
    gridWidth,
    gridHeight,
    variation: options.variation ?? GENESIS_GEOMETRY.variation,
    center: options.center ?? [0.5, 0.5],
  };
}

/**
 * Produce the un-jittered base geometry, then the jitter generator forked from the *post-base*
 * state so `variation: 0` returns exactly the nominal numbers for a given seed.
 */
function withJitter<T>(
  resolved: ResolvedOptions,
  base: (rng: Rng) => T,
  apply: (nominal: T, jitter: Rng, variation: number) => T,
): T {
  const nominal = base(resolved.rng);
  const jitter = resolved.rng.fork('genesis-jitter');
  return apply(nominal, jitter, resolved.variation);
}

function jitterRadius(value: number, jitter: Rng, variation: number): number {
  return variation === 0 ? value : value * (1 + jitter.symmetric(variation));
}

function jitterStrength(value: number, jitter: Rng, variation: number): number {
  if (variation === 0) return value;
  return Math.min(1, Math.max(0, value * (1 + jitter.symmetric(variation))));
}

function jitterCenter(center: Vec2, jitter: Rng, variation: number): Vec2 {
  if (variation === 0) return center;
  const d = variation * GENESIS_GEOMETRY.positionJitterUV;
  return [
    Math.min(1, Math.max(0, center[0] + jitter.symmetric(d))),
    Math.min(1, Math.max(0, center[1] + jitter.symmetric(d))),
  ];
}

function integerBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

function floatBetween(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

/** Euclidean distance between two UV points expressed in chemical cells. */
function cellDistance(a: Vec2, b: Vec2, gridWidth: number, gridHeight: number): number {
  return Math.hypot((a[0] - b[0]) * gridWidth, (a[1] - b[1]) * gridHeight);
}

/**
 * Deterministically place `count` points inside a square region (half-width `regionUV/2`) around
 * the resolved centre, rejecting candidates closer than `minSeparationCells`. Rejection sampling
 * makes the *spacing* non-uniform, which is what "asymmetrically spaced" (§4.4) requires.
 */
function placeSeparated(
  rng: Rng,
  count: number,
  regionUV: number,
  minSeparationCells: number,
  center: Vec2,
  gridWidth: number,
  gridHeight: number,
): Vec2[] {
  const half = regionUV / 2;
  const accepted: Vec2[] = [];
  const maxAttempts = count * 64;
  for (let attempt = 0; attempt < maxAttempts && accepted.length < count; attempt += 1) {
    const candidate: Vec2 = [
      Math.min(1, Math.max(0, center[0] + rng.symmetric(half))),
      Math.min(1, Math.max(0, center[1] + rng.symmetric(half))),
    ];
    const tooClose = accepted.some(
      (existing) => cellDistance(existing, candidate, gridWidth, gridHeight) < minSeparationCells,
    );
    // Accept after the last attempts regardless, so a caller always gets `count` points.
    if (!tooClose || attempt >= maxAttempts - (count - accepted.length)) accepted.push(candidate);
  }
  while (accepted.length < count) {
    accepted.push([center[0], center[1]]);
  }
  return accepted;
}

// -------------------------------------------------------------------------------------------------
// Per-pattern generators.
// -------------------------------------------------------------------------------------------------

export function generateSingle(options: GenesisGeometryOptions = {}): SingleGeometry {
  const resolved = resolve(options);
  const base: SeedDisk = {
    center: resolved.center,
    radiusCells: GENESIS_GEOMETRY.single.radiusCells,
    strength: 1,
  };
  const disk = withJitter(
    resolved,
    () => base,
    (nominal, jitter, variation) => ({
      center: jitterCenter(nominal.center, jitter, variation),
      radiusCells: jitterRadius(nominal.radiusCells, jitter, variation),
      strength: jitterStrength(nominal.strength, jitter, variation),
    }),
  );
  return { kind: 'single', disks: [disk] };
}

export function generateCompeting(options: GenesisGeometryOptions = {}): CompetingGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.competing;
  const base = (rng: Rng): SeedDisk[] => {
    const count = integerBetween(rng, cfg.countMin, cfg.countMax);
    const centers = placeSeparated(
      rng,
      count,
      cfg.regionUV,
      cfg.minSeparationCells,
      resolved.center,
      resolved.gridWidth,
      resolved.gridHeight,
    );
    return centers.map((center) => ({
      center,
      radiusCells: floatBetween(rng, cfg.radiusMin, cfg.radiusMax),
      strength: 1,
    }));
  };
  const disks = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) =>
      nominal.map((disk) => ({
        center: jitterCenter(disk.center, jitter, variation),
        radiusCells: jitterRadius(disk.radiusCells, jitter, variation),
        strength: jitterStrength(disk.strength, jitter, variation),
      })),
  );
  return { kind: 'competing', disks };
}

export function generateSparse(options: GenesisGeometryOptions = {}): SparseGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.sparse;
  const base = (rng: Rng): SeedDisk[] => {
    const count = integerBetween(rng, cfg.countMin, cfg.countMax);
    const centers = placeSeparated(
      rng,
      count,
      cfg.regionUV,
      cfg.minSeparationCells,
      resolved.center,
      resolved.gridWidth,
      resolved.gridHeight,
    );
    return centers.map((center) => ({
      center,
      radiusCells: floatBetween(rng, cfg.radiusMin, cfg.radiusMax),
      strength: 1,
    }));
  };
  const disks = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) =>
      nominal.map((disk) => ({
        center: jitterCenter(disk.center, jitter, variation),
        radiusCells: jitterRadius(disk.radiusCells, jitter, variation),
        strength: jitterStrength(disk.strength, jitter, variation),
      })),
  );
  return { kind: 'sparse', disks };
}

export function generateLine(options: GenesisGeometryOptions = {}): LineGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.line;
  const base = (rng: Rng): SeedLine => {
    const angle = rng.range(0, Math.PI * 2);
    const lengthCells = resolved.gridWidth * floatBetween(rng, cfg.lengthFractionMin, cfg.lengthFractionMax);
    const widthCells = floatBetween(rng, cfg.widthMin, cfg.widthMax);
    const halfUV: Vec2 = [
      (Math.cos(angle) * lengthCells) / resolved.gridWidth / 2,
      (Math.sin(angle) * lengthCells) / resolved.gridHeight / 2,
    ];
    const a: Vec2 = [resolved.center[0] - halfUV[0], resolved.center[1] - halfUV[1]];
    const b: Vec2 = [resolved.center[0] + halfUV[0], resolved.center[1] + halfUV[1]];
    return { a, b, widthCells, strength: 1 };
  };
  const line = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) => ({
      a: jitterCenter(nominal.a, jitter, variation),
      b: jitterCenter(nominal.b, jitter, variation),
      widthCells: jitterRadius(nominal.widthCells, jitter, variation),
      strength: jitterStrength(nominal.strength, jitter, variation),
    }),
  );
  return { kind: 'line', line };
}

export function generateRing(options: GenesisGeometryOptions = {}): RingGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.ring;
  const base = (rng: Rng): SeedRing => ({
    center: resolved.center,
    radiusCells: floatBetween(rng, cfg.radiusMin, cfg.radiusMax),
    wallCells: floatBetween(rng, cfg.wallMin, cfg.wallMax),
    strength: 1,
  });
  const ring = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) => ({
      center: jitterCenter(nominal.center, jitter, variation),
      radiusCells: jitterRadius(nominal.radiusCells, jitter, variation),
      wallCells: jitterRadius(nominal.wallCells, jitter, variation),
      strength: jitterStrength(nominal.strength, jitter, variation),
    }),
  );
  return { kind: 'ring', ring };
}

export function generateRadial(options: GenesisGeometryOptions = {}): RadialGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.radial;
  const base = (rng: Rng): SeedRadial => ({
    center: resolved.center,
    coreRadiusCells: floatBetween(rng, cfg.coreRadiusMin, cfg.coreRadiusMax),
    radiusCells: floatBetween(rng, cfg.radiusMin, cfg.radiusMax),
    coreStrength: cfg.coreStrength,
    haloStrength: floatBetween(rng, cfg.haloStrengthMin, cfg.haloStrengthMax),
  });
  const radial = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) => ({
      center: jitterCenter(nominal.center, jitter, variation),
      coreRadiusCells: jitterRadius(nominal.coreRadiusCells, jitter, variation),
      radiusCells: jitterRadius(nominal.radiusCells, jitter, variation),
      coreStrength: jitterStrength(nominal.coreStrength, jitter, variation),
      haloStrength: jitterStrength(nominal.haloStrength, jitter, variation),
    }),
  );
  return { kind: 'radial', radial };
}

export function generateStructured(options: GenesisGeometryOptions = {}): StructuredGeometry {
  const resolved = resolve(options);
  const cfg = GENESIS_GEOMETRY.structured;
  const base = (rng: Rng): SeedStructured => ({
    center: resolved.center,
    semiMajorCells: floatBetween(rng, cfg.semiMajorMin, cfg.semiMajorMax),
    semiMinorCells: floatBetween(rng, cfg.semiMinorMin, cfg.semiMinorMax),
    rotationRadians: rng.range(0, Math.PI),
    amplitude: floatBetween(rng, cfg.amplitudeMin, cfg.amplitudeMax),
    core: { center: resolved.center, radiusCells: cfg.coreRadiusCells, strength: 1 },
  });
  const structured = withJitter(
    resolved,
    base,
    (nominal, jitter, variation) => ({
      center: jitterCenter(nominal.center, jitter, variation),
      semiMajorCells: jitterRadius(nominal.semiMajorCells, jitter, variation),
      semiMinorCells: jitterRadius(nominal.semiMinorCells, jitter, variation),
      rotationRadians: nominal.rotationRadians,
      amplitude: jitterStrength(nominal.amplitude, jitter, variation),
      core: {
        center: jitterCenter(nominal.core.center, jitter, variation),
        radiusCells: jitterRadius(nominal.core.radiusCells, jitter, variation),
        strength: jitterStrength(nominal.core.strength, jitter, variation),
      },
    }),
  );
  return { kind: 'structured', structured };
}

/** Dispatch by `GenesisKind`. */
export function generateGeometry(kind: GenesisKind, options: GenesisGeometryOptions = {}): SeedGeometry {
  switch (kind) {
    case 'single':
      return generateSingle(options);
    case 'competing':
      return generateCompeting(options);
    case 'sparse':
      return generateSparse(options);
    case 'line':
      return generateLine(options);
    case 'ring':
      return generateRing(options);
    case 'radial':
      return generateRadial(options);
    case 'structured':
      return generateStructured(options);
  }
}

/** Flatten a descriptor into `{ disks }` where that is meaningful (empty for the others). */
export function collectDisks(geometry: SeedGeometry): SeedDisk[] {
  switch (geometry.kind) {
    case 'single':
    case 'competing':
    case 'sparse':
      return geometry.disks;
    default:
      return [];
  }
}
