/**
 * §6.5 discovery tooling — the lab-gated exploration-mode helper.
 *
 * This is the *planning and reduction* half of the §6.5 tooling: it enumerates the transitions of the
 * shipped trajectory (source endpoint → destination start), names the recorded seeds and the
 * lab-only exploration grid, and reduces a run's descriptor samples into a compact per-run summary.
 * It owns no solver and no GL: the observation is driven through the real page by
 * `scripts/explore.ts` (a Playwright driver), and the descriptors come from the real tier-1 reduction
 * and the real field. §6.5's rule — "it is not a second solver" — is why nothing here steps chemistry.
 *
 * **Lab-gated.** Exploration mode is the documented lab-only coarser grid (§10 / deviation 34) with
 * the higher measured speed ceiling. `requireExploration` refuses to let a caller pretend it is in
 * that mode, so a run cannot silently capture presentation-grid numbers under an "exploration" label.
 *
 * β note: the plan's `beta0Approx`/`beta1Approx`/`largestComponentFraction` are **presentation-tier**
 * descriptors, which arrive with the Phase-3 analysis worker. Until then the β-relevant *health*
 * fields exported here are the tier-1 full-domain occupancy, reaction activity and change rate — the
 * substitution is stated in the export rather than left implicit.
 *
 * This module deliberately does **not** import the trajectory JSON: `scripts/explore.ts` runs under
 * `node --experimental-strip-types`, where a bare ESM JSON import is not allowed, so the caller passes
 * the parsed document in. It *does* import the curator's pure, GPU-free movement-entry genesis
 * construction (`buildEntryGenesisCommand`), so the driver emits destination seeds with the curator's
 * own semantics rather than a second implementation of the §4.4 perturbation.
 */
import { buildEntryGenesisCommand } from '../curator/curator.ts';
import type { GenesisCommand, Params, Vec2 } from '../core/types.ts';
import type { GenesisLibraryEntry, MovementSpec, TrajectoryDocument } from '../curator/schema.ts';

/** The §10 exploration grid ("for finding regimes, not for viewing the final piece"). */
export const DISCOVERY_GRID = 512;
/** Three fixed seeds per transition (§6.5 asks for at least three). */
export const DISCOVERY_SEEDS = [11_000_011, 11_000_022, 11_000_033] as const;
/** Settling interval: grow the source field before the observed transition. */
export const SETTLE_STEPS = 4000;
/** Observation interval, in performance seconds (§6.5: 60–120). */
export const OBSERVATION_PERFORMANCE_SECONDS = 60;
/** Observation granularity, in delivered steps (5 performance seconds at 120 steps/s). */
export const OBSERVATION_SLICE_STEPS = 600;

export interface TransitionEndpoint {
  movement: string;
  params: Params;
}

export interface TransitionSpec {
  /** Stable id, e.g. `03-cellular-growth-to-replication`. */
  id: string;
  index: number;
  source: TransitionEndpoint;
  destination: TransitionEndpoint;
  /**
   * The destination movement's declared `enterGenesis`, resolved from the document's genesis library,
   * or null when the movement has none. The curator issues this command when it *enters* the movement,
   * so a faithful transition test must too — otherwise the rebirth edge (whose source field is the
   * genuinely empty stillness state) would be tested as a bare parameter change and could only ever
   * read dead.
   */
  destinationGenesis: GenesisLibraryEntry | null;
}

/** `[F, k, Du, Dv]` → the named `Params` tuple. */
export function paramsFromWaypoint(p: readonly [number, number, number, number]): Params {
  return { F: p[0], k: p[1], Du: p[2], Dv: p[3] };
}

function firstWaypoint(movement: MovementSpec): Params {
  return paramsFromWaypoint(movement.waypoints[0]!.p);
}

function lastWaypoint(movement: MovementSpec): Params {
  return paramsFromWaypoint(movement.waypoints[movement.waypoints.length - 1]!.p);
}

/**
 * Every edge of the shipped trajectory as a `source endpoint → destination start` transition. The
 * destination's *start* is its first waypoint, because a transition test continues the source field
 * into the destination path rather than dropping it onto the destination's mature endpoint.
 */
export function shippedTransitions(doc: TrajectoryDocument): TransitionSpec[] {
  const transitions: TransitionSpec[] = [];
  for (let index = 1; index < doc.movements.length; index += 1) {
    const previous = doc.movements[index - 1]!;
    const movement = doc.movements[index]!;
    const entry = movement.enterGenesis ? doc.genesisLibrary[movement.enterGenesis] ?? null : null;
    transitions.push({
      id: `${String(index).padStart(2, '0')}-${previous.id}-to-${movement.id}`,
      index,
      source: { movement: previous.id, params: lastWaypoint(previous) },
      destination: { movement: movement.id, params: firstWaypoint(movement) },
      destinationGenesis: entry,
    });
  }
  return transitions;
}

/** Refuse to run discovery outside the lab-only exploration mode. */
export function requireExploration(active: boolean): void {
  if (!active) {
    throw new Error(
      'discovery tooling is lab-gated: enable §10 exploration mode (512²) before running a transition',
    );
  }
}

/** Stable one-line signature of a genesis command, so a trial's emitted command is auditable. */
export function genesisCommandSignature(command: GenesisCommand): string {
  return (
    `kind=${command.kind}|mode=${command.mode}|seed=${command.seed >>> 0}|` +
    `center=[${command.center[0].toFixed(9)},${command.center[1].toFixed(9)}]|` +
    `radiusCells=${command.radiusCells.toFixed(9)}|strength=${command.strength.toFixed(9)}`
  );
}

/**
 * §6.4/§6.5: the genesis command the curator issues when it *enters* a transition's destination
 * movement, built through the live curator's own construction semantics
 * (`buildEntryGenesisCommand`): a root-seeded centre/radius/strength perturbation of the library
 * entry followed by the §6.4 `MIN_REBIRTH_DISPLACEMENT` projection from `priorOrigin`. Returns null
 * for a destination that declares no `enterGenesis`.
 *
 * The previous driver built this command from the library's exact recorded centre/radius/strength
 * and varied only `command.seed`. For `single` — the kind both entry edges use — that is inert:
 * `commandToUniforms` honours a `single` command's own centre/radius/strength and discards the
 * seed-generated geometry, so all three seeds produced a byte-identical organism. Routing through
 * the curator's shared construction is what makes the seeded trials genuinely differ.
 */
export function transitionEntryGenesis(
  doc: TrajectoryDocument,
  transition: TransitionSpec,
  seed: number,
  priorOrigin: Vec2 | null,
): GenesisCommand | null {
  if (transition.destinationGenesis === null) return null;
  return buildEntryGenesisCommand({
    doc,
    movementId: transition.destination.movement,
    rootSeed: seed,
    priorOrigin,
  });
}

/** One descriptor observation during the observation interval. */
export interface DescriptorSample {
  performanceSeconds: number;
  steps: number;
  /** Tier-1 full-domain occupied fraction (β-relevant health field). */
  occupiedFraction: number;
  /** Tier-1 full-domain mean reaction flux UV² (β-relevant health field). */
  activity: number;
  /** Tier-1 full-domain change rate per sampled numerical second. */
  changeRate: number;
  /** Coarse centroid of the occupied region (normalized UV). */
  centroidUV: [number, number];
}

export interface RunDescriptors {
  samples: number;
  occupancy: { min: number; max: number; mean: number; first: number; last: number };
  activity: { min: number; max: number; mean: number; first: number; last: number };
  changeRate: { min: number; max: number; mean: number; first: number; last: number };
  /** Occupancy trend over the observation window (last − first); sign says grow/shrink. */
  occupancyTrend: number;
}

function reduce(values: number[]): RunDescriptors['occupancy'] {
  if (values.length === 0) return { min: 0, max: 0, mean: 0, first: 0, last: 0 };
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: sum / values.length,
    first: values[0]!,
    last: values[values.length - 1]!,
  };
}

/** Reduce a run's samples into descriptors. Deliberately keeps the series; no universal score (§6.5). */
export function summarizeSamples(samples: readonly DescriptorSample[]): RunDescriptors {
  const occupancy = reduce(samples.map((sample) => sample.occupiedFraction));
  return {
    samples: samples.length,
    occupancy,
    activity: reduce(samples.map((sample) => sample.activity)),
    changeRate: reduce(samples.map((sample) => sample.changeRate)),
    occupancyTrend: occupancy.last - occupancy.first,
  };
}
