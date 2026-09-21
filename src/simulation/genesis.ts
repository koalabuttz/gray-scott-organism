/**
 * §4.4 Genesis construction and validation.
 *
 * `commandToUniforms` packs a `GenesisCommand` for `shaders/genesis.frag`; `applyGenesisCPU` mirrors
 * that shader for GPU-free tests; `assertNoFeedback` is the read/write attachment guard used both by
 * unit tests and by the GPU setup validation (AC.3).
 *
 * All seven declared patterns are implemented. The *geometry* (positions, radii, strengths) comes from
 * `genesis-geometry.ts`, which draws it from the chemistry PRNG substream; this module only packs it
 * for the shader. `single` deliberately bypasses the geometry generator so that a Phase-1 command's
 * own centre/radius/strength are honoured exactly — every gate capture and its recorded provenance
 * depend on that.
 */
import { GENESIS } from '../config.ts';
import type { GenesisCommand, GenesisKind, Vec2 } from '../core/types.ts';
import { Rng } from '../core/random.ts';
import { generateGeometry } from './genesis-geometry.ts';
import { clamp01, smoothstep } from './reference.ts';

/** Must match `MAX_DISCS` in `shaders/genesis.frag`. */
export const MAX_GENESIS_DISCS = 24;

export const SUPPORTED_PATTERNS: readonly GenesisKind[] = [
  'single',
  'competing',
  'line',
  'ring',
  'sparse',
  'radial',
  'structured',
];

/** Shader pattern index per kind; must match the branches in `shaders/genesis.frag`. */
export const PATTERN_INDEX: Readonly<Record<GenesisKind, number>> = {
  single: 0,
  competing: 1,
  sparse: 2,
  line: 3,
  ring: 4,
  radial: 5,
  structured: 6,
};

export interface GenesisUniforms {
  patternIndex: number;
  modeIndex: number;
  softnessCells: number;
  target: Vec2;
  /** Scales the pattern's own line/ring masks; 1 for the others, which carry their strength per disc/item. */
  shapeStrength: number;
  /**
   * The command's `strength` as a single global final mask multiplier (§3.3, deviation 41). Applied
   * last, after every pattern's own structure, so `strength: 0` is inert for *every* kind — including
   * `radial` and `structured`, whose viable cores previously bypassed it.
   */
  strength: number;
  seed: number;
  discCount: number;
  discCenters: Float32Array;
  discRadii: Float32Array;
  discStrengths: Float32Array;
  /** Centre/radius of the primary disc (disc patterns); kept for the Phase-1 `single` contract. */
  centerCells: Vec2;
  radiusCells: number;
  lineA: Vec2;
  lineB: Vec2;
  lineWidthCells: number;
  ringCenter: Vec2;
  ringRadiusCells: number;
  ringWallCells: number;
  radialCenter: Vec2;
  radialCoreCells: number;
  radialRadiusCells: number;
  radialCoreStrength: number;
  radialHaloStrength: number;
  structCenter: Vec2;
  structSemiMajorCells: number;
  structSemiMinorCells: number;
  structRotation: number;
  structAmplitude: number;
  structCoreCells: number;
}

/**
 * Convert a command into shader uniforms. `center` is clamped into the domain; `radiusCells` must be
 * positive. Geometry for the multi-shape patterns is generated from `command.seed`, so a replay of
 * the same seed reproduces the same seed geometry.
 */
export function commandToUniforms(command: GenesisCommand, gridWidth: number, gridHeight: number): GenesisUniforms {
  const patternIndex = PATTERN_INDEX[command.kind];
  if (patternIndex === undefined) {
    throw new Error(
      `genesis pattern '${command.kind}' is not implemented (supported: ${SUPPORTED_PATTERNS.join(', ')})`,
    );
  }

  const centerCells: Vec2 = [
    clamp01(command.center[0]) * gridWidth,
    clamp01(command.center[1]) * gridHeight,
  ];
  const discCenters = new Float32Array(MAX_GENESIS_DISCS * 2);
  const discRadii = new Float32Array(MAX_GENESIS_DISCS);
  const discStrengths = new Float32Array(MAX_GENESIS_DISCS);

  const uniforms: GenesisUniforms = {
    patternIndex,
    modeIndex: command.mode === 'replace' ? 0 : 1,
    softnessCells: GENESIS.edgeSoftnessCells,
    target: [GENESIS.targetU, GENESIS.targetV],
    shapeStrength: 1,
    strength: clamp01(command.strength),
    seed: command.seed >>> 0,
    discCount: 0,
    discCenters,
    discRadii,
    discStrengths,
    centerCells,
    radiusCells: Math.max(0.5, command.radiusCells),
    lineA: [0, 0],
    lineB: [0, 0],
    lineWidthCells: 3,
    ringCenter: centerCells,
    ringRadiusCells: Math.max(1, command.radiusCells),
    ringWallCells: 4,
    radialCenter: centerCells,
    radialCoreCells: Math.max(1, command.radiusCells),
    radialRadiusCells: Math.max(2, command.radiusCells * 10),
    radialCoreStrength: 1,
    radialHaloStrength: 0.1,
    structCenter: centerCells,
    structSemiMajorCells: Math.max(2, command.radiusCells * 12),
    structSemiMinorCells: Math.max(2, command.radiusCells * 7),
    structRotation: 0,
    structAmplitude: 0.12,
    structCoreCells: Math.max(1, command.radiusCells),
  };

  const geometry = generateGeometry(command.kind, {
    seed: command.seed,
    gridWidth,
    gridHeight,
    center: command.center,
  });

  switch (geometry.kind) {
    case 'single': {
      // Phase-1 contract: honour the command's own centre/radius/strength. The strength now travels
      // as the global `uStrength` multiplier (deviation 41), so the disc carries its full structural
      // strength of 1 here and `single`'s Phase-1 mask is unchanged (1 * 1 * command.strength).
      const disk = geometry.disks[0]!;
      discCenters[0] = centerCells[0];
      discCenters[1] = centerCells[1];
      discRadii[0] = uniforms.radiusCells;
      discStrengths[0] = 1;
      uniforms.discCount = 1;
      void disk;
      break;
    }
    case 'competing':
    case 'sparse': {
      const count = Math.min(MAX_GENESIS_DISCS, geometry.disks.length);
      for (let i = 0; i < count; i += 1) {
        const disk = geometry.disks[i]!;
        discCenters[i * 2] = clamp01(disk.center[0]) * gridWidth;
        discCenters[i * 2 + 1] = clamp01(disk.center[1]) * gridHeight;
        discRadii[i] = Math.max(0.5, disk.radiusCells);
        discStrengths[i] = clamp01(disk.strength);
      }
      uniforms.discCount = count;
      uniforms.centerCells = [discCenters[0]!, discCenters[1]!];
      uniforms.radiusCells = discRadii[0]!;
      break;
    }
    case 'line': {
      const line = geometry.line;
      uniforms.lineA = [clamp01(line.a[0]) * gridWidth, clamp01(line.a[1]) * gridHeight];
      uniforms.lineB = [clamp01(line.b[0]) * gridWidth, clamp01(line.b[1]) * gridHeight];
      uniforms.lineWidthCells = Math.max(1, line.widthCells);
      uniforms.shapeStrength = clamp01(line.strength);
      break;
    }
    case 'ring': {
      const ring = geometry.ring;
      uniforms.ringCenter = [clamp01(ring.center[0]) * gridWidth, clamp01(ring.center[1]) * gridHeight];
      uniforms.ringRadiusCells = Math.max(1, ring.radiusCells);
      uniforms.ringWallCells = Math.max(1, ring.wallCells);
      uniforms.shapeStrength = clamp01(ring.strength);
      break;
    }
    case 'radial': {
      const radial = geometry.radial;
      uniforms.radialCenter = [clamp01(radial.center[0]) * gridWidth, clamp01(radial.center[1]) * gridHeight];
      uniforms.radialCoreCells = Math.max(1, radial.coreRadiusCells);
      uniforms.radialRadiusCells = Math.max(uniforms.radialCoreCells + 1, radial.radiusCells);
      uniforms.radialCoreStrength = clamp01(radial.coreStrength);
      uniforms.radialHaloStrength = clamp01(radial.haloStrength);
      break;
    }
    case 'structured': {
      const structured = geometry.structured;
      uniforms.structCenter = [
        clamp01(structured.center[0]) * gridWidth,
        clamp01(structured.center[1]) * gridHeight,
      ];
      uniforms.structSemiMajorCells = Math.max(1, structured.semiMajorCells);
      uniforms.structSemiMinorCells = Math.max(1, structured.semiMinorCells);
      uniforms.structRotation = structured.rotationRadians;
      uniforms.structAmplitude = clamp01(structured.amplitude);
      uniforms.structCoreCells = Math.max(1, structured.core.radiusCells);
      break;
    }
  }

  return uniforms;
}

// ------------------------------------------------------------------------------------------------
// CPU mirror (GPU-free tests). Mirrors `shaders/genesis.frag` operation-for-operation.
// ------------------------------------------------------------------------------------------------

function toroidalDelta(px: number, py: number, cx: number, cy: number, width: number, height: number): [number, number] {
  let dx = px - cx;
  let dy = py - cy;
  dx -= width * Math.floor(dx / width + 0.5);
  dy -= height * Math.floor(dy / height + 0.5);
  return [dx, dy];
}

function discMaskCPU(
  px: number,
  py: number,
  cx: number,
  cy: number,
  radius: number,
  softness: number,
  width: number,
  height: number,
): number {
  const [dx, dy] = toroidalDelta(px, py, cx, cy, width, height);
  return 1 - smoothstep(radius - softness, radius + softness, Math.hypot(dx, dy));
}

/** Deterministic 0..1 hash, matching `hash11` in the shader. */
function hash11(x: number): number {
  const value = Math.sin(x * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** The pattern mask at one point (0..1), mirroring the shader's `mask` (incl. the global `strength`). */
export function genesisMaskCPU(uniforms: GenesisUniforms, x: number, y: number, width: number, height: number): number {
  const soft = uniforms.softnessCells;
  const px = x + 0.5;
  const py = y + 0.5;
  let mask = 0;

  if (uniforms.patternIndex <= 2) {
    for (let i = 0; i < uniforms.discCount; i += 1) {
      const m = discMaskCPU(
        px,
        py,
        uniforms.discCenters[i * 2]!,
        uniforms.discCenters[i * 2 + 1]!,
        uniforms.discRadii[i]!,
        soft,
        width,
        height,
      );
      mask = Math.max(mask, m * uniforms.discStrengths[i]!);
    }
  } else if (uniforms.patternIndex === 3) {
    const [abx, aby] = toroidalDelta(
      uniforms.lineB[0],
      uniforms.lineB[1],
      uniforms.lineA[0],
      uniforms.lineA[1],
      width,
      height,
    );
    const [apx, apy] = toroidalDelta(px, py, uniforms.lineA[0], uniforms.lineA[1], width, height);
    const abLenSq = Math.max(abx * abx + aby * aby, 1e-6);
    const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / abLenSq));
    const dist = Math.hypot(apx - abx * t, apy - aby * t);
    const halfWidth = Math.max(uniforms.lineWidthCells * 0.5, 0.5);
    mask = 1 - smoothstep(halfWidth - soft, halfWidth + soft, dist);
  } else if (uniforms.patternIndex === 4) {
    const [dx, dy] = toroidalDelta(px, py, uniforms.ringCenter[0], uniforms.ringCenter[1], width, height);
    const dist = Math.hypot(dx, dy);
    const halfWall = Math.max(uniforms.ringWallCells * 0.5, 0.5);
    mask = 1 - smoothstep(halfWall - soft, halfWall + soft, Math.abs(dist - uniforms.ringRadiusCells));
  } else if (uniforms.patternIndex === 5) {
    const [dx, dy] = toroidalDelta(px, py, uniforms.radialCenter[0], uniforms.radialCenter[1], width, height);
    const dist = Math.hypot(dx, dy);
    const core = 1 - smoothstep(
      uniforms.radialCoreCells - soft,
      uniforms.radialCoreCells + soft,
      dist,
    );
    const halo =
      1 - smoothstep(uniforms.radialCoreCells, Math.max(uniforms.radialRadiusCells, uniforms.radialCoreCells + 1), dist);
    mask = Math.max(core * uniforms.radialCoreStrength, halo * uniforms.radialHaloStrength);
  } else {
    const [dx, dy] = toroidalDelta(px, py, uniforms.structCenter[0], uniforms.structCenter[1], width, height);
    const c = Math.cos(uniforms.structRotation);
    const s = Math.sin(uniforms.structRotation);
    const rx = c * dx - s * dy;
    const ry = s * dx + c * dy;
    const semiMajor = Math.max(uniforms.structSemiMajorCells, 1);
    const semiMinor = Math.max(uniforms.structSemiMinorCells, 1);
    const ellipse = Math.hypot(rx / semiMajor, ry / semiMinor);
    const support = 1 - smoothstep(0.85, 1, ellipse);
    const phase = hash11(uniforms.seed * 0.001) * 6.2831853;
    const wave =
      Math.sin(rx * 0.35 + phase) +
      Math.sin(ry * 0.41 + phase * 1.7) +
      Math.sin((rx + ry) * 0.23 + phase * 2.3);
    const perturbation = Math.min(1, Math.max(0, 0.5 + wave / 6));
    const structured = support * perturbation * uniforms.structAmplitude;
    mask = Math.max(structured, discMaskCPU(px, py, uniforms.structCenter[0], uniforms.structCenter[1], uniforms.structCoreCells, soft, width, height));
  }

  return Math.min(1, Math.max(0, mask * uniforms.shapeStrength * uniforms.strength));
}

/** CPU mirror of `shaders/genesis.frag` used for GPU-free assertions in `genesis.test.ts`. */
export function applyGenesisCPU(
  field: { u: Float32Array; v: Float32Array; width: number; height: number },
  command: GenesisCommand,
): void {
  const uniforms = commandToUniforms(command, field.width, field.height);
  const replace = uniforms.modeIndex === 0;
  const [targetU, targetV] = uniforms.target;
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      const index = y * field.width + x;
      const baseU = replace ? 1 : field.u[index]!;
      const baseV = replace ? 0 : field.v[index]!;
      const mix = genesisMaskCPU(uniforms, x, y, field.width, field.height);
      field.u[index] = clamp01(baseU + (targetU - baseU) * mix);
      field.v[index] = baseV + (targetV - baseV) * mix;
    }
  }
}

/**
 * §12.1 "no sample/write attachment feedback".
 *
 * The simulation must never sample a texture that is attached to the framebuffer it is drawing
 * into. This is a plain identity check on the opaque handles, so it is testable without a GPU
 * and can also be asserted against live bindings (`verifyAttachmentFeedback`).
 */
export function assertNoFeedback(
  inputTexture: WebGLTexture | null,
  writeAttachment: WebGLTexture | null,
  label: string,
): void {
  if (inputTexture !== null && inputTexture === writeAttachment) {
    throw new Error(`read/write attachment feedback detected in ${label}`);
  }
}

let genesisIdCounter = 1;

export interface SingleSeedOptions {
  /** Normalized UV center. */
  center: Vec2;
  seed: number;
  /** Perturb radius/strength by roughly ±5% and position slightly (§4.4). */
  perturb?: boolean;
  radiusCells?: number;
  strength?: number;
  mode?: 'replace' | 'inject';
}

/** Build a `single` seed command: one strong seed disk. */
export function createSingleSeedCommand(options: SingleSeedOptions): GenesisCommand {
  const rng = new Rng(options.seed);
  const perturb = options.perturb ?? true;
  const baseRadius = options.radiusCells ?? GENESIS.defaultRadiusCells;
  const baseStrength = options.strength ?? 1;
  const radiusCells = perturb ? baseRadius * rng.range(0.95, 1.05) : baseRadius;
  const strength = clamp01(perturb ? baseStrength * rng.range(0.95, 1.05) : baseStrength);
  const jitter = perturb ? 0.004 : 0;
  const center: Vec2 = [
    clamp01(options.center[0] + rng.symmetric(jitter)),
    clamp01(options.center[1] + rng.symmetric(jitter)),
  ];
  return {
    id: genesisIdCounter++,
    kind: 'single',
    mode: options.mode ?? 'replace',
    seed: options.seed >>> 0,
    center,
    radiusCells,
    strength,
  };
}

/** True when the command's pattern is implemented by the shader (all seven are). */
export function isSupportedGenesis(command: GenesisCommand): boolean {
  return SUPPORTED_PATTERNS.includes(command.kind);
}
