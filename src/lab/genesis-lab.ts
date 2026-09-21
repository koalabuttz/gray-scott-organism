/**
 * §10 genesis selector geometry (§4.4).
 *
 * The laboratory's genesis selector offers all seven §4.4 kinds as buttons. Each button builds a
 * complete `GenesisCommand` and dispatches it through the ordinary `reseed` command surface — the
 * same interface application transport uses — so the laboratory never reaches into a solver.
 *
 * The command's `center`/`radiusCells` are read back from `genesis-geometry.ts`'s generated seed
 * geometry rather than being guessed here, so the number the command carries is the geometry the
 * shader will actually draw (for the disc kinds, which honour the command's own centre/radius; the
 * line/ring/radial/structured kinds regenerate their full geometry inside `commandToUniforms` from
 * the same seed, grid and centre). `strength` is fixed at 1 — a laboratory seed is a seed, not a
 * partial mix.
 */
import type { GenesisCommand, GenesisKind, Vec2 } from '../core/types.ts';
import { GENESIS_GEOMETRY, generateGeometry, type SeedGeometry } from '../simulation/genesis-geometry.ts';

let labGenesisCounter = 1;

export interface LabGenesisOptions {
  /** Recorded uint32 seed; the geometry (and the shader's own regeneration) derives from it. */
  seed: number;
  /** Pattern centre in normalized UV; default [0.5, 0.5]. */
  center?: Vec2;
  /** The active simulation grid edge in cells, so cell-scaled patterns match the field. */
  gridWidth?: number;
  gridHeight?: number;
  /** `replace` (default; bumps the field epoch) or `inject` (leaves the field in place). */
  mode?: 'replace' | 'inject';
}

/** The primary centre/radius a `GenesisCommand` carries for each kind's generated geometry. */
function primaryCenterRadius(geometry: SeedGeometry): { center: Vec2; radiusCells: number } {
  switch (geometry.kind) {
    case 'single':
    case 'competing':
    case 'sparse': {
      const disk = geometry.disks[0]!;
      return { center: disk.center, radiusCells: disk.radiusCells };
    }
    case 'line':
      return {
        center: [(geometry.line.a[0] + geometry.line.b[0]) / 2, (geometry.line.a[1] + geometry.line.b[1]) / 2],
        radiusCells: geometry.line.widthCells,
      };
    case 'ring':
      return { center: geometry.ring.center, radiusCells: geometry.ring.radiusCells };
    case 'radial':
      return { center: geometry.radial.center, radiusCells: geometry.radial.coreRadiusCells };
    case 'structured':
      return { center: geometry.structured.center, radiusCells: geometry.structured.core.radiusCells };
  }
}

/**
 * Build a lab-chosen genesis command for one of the seven §4.4 kinds. Geometry comes from
 * `genesis-geometry.ts`; `strength` is 1.
 */
export function createLabGenesisCommand(kind: GenesisKind, options: LabGenesisOptions): GenesisCommand {
  const gridWidth = options.gridWidth ?? GENESIS_GEOMETRY.defaultGrid;
  const gridHeight = options.gridHeight ?? gridWidth;
  const geometry = generateGeometry(kind, {
    seed: options.seed >>> 0,
    gridWidth,
    gridHeight,
    center: options.center ?? [0.5, 0.5],
  });
  const { center, radiusCells } = primaryCenterRadius(geometry);
  return {
    id: labGenesisCounter++,
    kind,
    mode: options.mode ?? 'replace',
    seed: options.seed >>> 0,
    center,
    radiusCells: Math.max(0.5, radiusCells),
    strength: 1,
  };
}
