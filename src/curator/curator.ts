/**
 * §6.3/§6.4 curator: a bounded movement-graph walker plus the stillness state machine.
 *
 * This module is **pure, GPU-free, injectable policy**. It never touches a texture, the DOM, or
 * `app.ts`; it reads a `WorldState` snapshot and returns parameters, phase, and any genesis
 * commands issued this tick. Everything is driven by `advance(dt, environment, previous)`, so a
 * test can walk a complete arc deterministically at an arbitrary `dt`.
 *
 * Covered behavioural requirements:
 *  - bounded movement graph walk (`next[0]` default edge, extra edges as declared recoveries)
 *  - dwell min/max = `.75`/`1.25` x nominal, plus correlated duration jitter within bounds (§6.3)
 *  - `durationScaleRange`, correlated `parameterJitter` bounded to the trajectory envelope (§6.4)
 *  - `stillnessState` machine `none -> kill-wait -> black-hold -> none` (§6.4/§8.3)
 *  - one injection rescue per arc, then the declared collapse edge (§6.4)
 *  - exit hints honoured after min dwell, never required beyond max dwell (§6.4)
 *  - analysis progress-rate scaling in [.7, 1.3] with smoothing + hysteresis (§6.4)
 */
import { clamp } from '../core/clock.ts';
import { Rng, createSubstream, SUBSTREAM_IDS } from '../core/random.ts';
import type { GenesisCommand, Params, PhaseState, Vec2, WorldState } from '../core/types.ts';
import type { GenesisLibraryEntry, MovementSpec, TrajectoryDocument } from './schema.ts';
import {
  DEFAULT_CROSSFADE_SECONDS,
  advanceProgress,
  effectiveDurationSeconds,
  evaluateMovement,
  paramsFromTuple,
  tupleFromParams,
  type ParamTuple,
} from './trajectory.ts';

// -------------------------------------------------------------------------------------------------
// §3.3 interfaces (Curator is not part of WorldState; only CuratorOutput is).
// -------------------------------------------------------------------------------------------------

export interface CuratorEnvironment {
  /** `AudioSystem.silenceStatus()`, sampled by the app this tick. */
  silence: { satisfied: boolean; terminalZeroAt: number | null };
}

export interface CuratorOutput {
  parameters: Params;
  phase: PhaseState;
  genesis: readonly GenesisCommand[];
}

export type CuratorCommand =
  | { type: 'skip-movement' }
  | { type: 'load-trajectory'; document: TrajectoryDocument }
  | { type: 'parameters-override'; value: Params }
  | { type: 'parameters-release' }
  | { type: 'reseed'; genesis: GenesisCommand };

export interface StillnessTimeline {
  killWaitEnteredAt: number | null;
  chemistryConfirmedAt: number | null;
  audioZeroAt: number | null;
  blackHoldStartedAt: number | null;
  blackHoldCompletedAt: number | null;
  genesisAt: number | null;
}

/**
 * §6.4 premature-extinction decision telemetry.
 *
 * One record each time the dead-duration accumulator reaches the extinction window. It is emitted so
 * the arc evidence can state *why* a rescue or an early recovery fired — which movement and
 * intention, the tier-1 health the decision read, how long the field had been below the dead
 * thresholds, and what the curator did — instead of only showing that a genesis command appeared in
 * the command log.
 */
export interface ExtinctionDecision {
  /** Performance seconds when the decision was made (§4.1 delivered-work time). */
  performanceSeconds: number;
  arc: number;
  movement: string;
  intention: string;
  /** The parameter vector in force at the decision (the movement's own path value). */
  parameters: Params;
  /** Whether the tier-1 health sample the decision read was fresh. */
  healthValid: boolean;
  healthAgeSeconds: number;
  healthOccupiedFraction: number;
  healthReactionActivity: number;
  /**
   * Whether the full-domain occupancy was *rising* over the window at the decision (§6.4 trend
   * refinement). A rising field below the dead thresholds is not extinguished.
   */
  occupancyGrowing: boolean;
  /** Accumulated below-dead-threshold duration that triggered the decision, in performance seconds. */
  deadSeconds: number;
  /** What the curator did: an injection rescue, the declared recovery edge, or neither (dwell). */
  action: 'rescue' | 'recovery' | 'none';
  /** The recovery movement entered when `action` is `'recovery'`. */
  recoveryMovement: string | null;
}

export interface CuratorOptions {
  /** Recorded root seed; the curator substream is derived from it (§4.4). */
  rootSeed?: number;
  /** §6.4/§10 crossfade window for skip/release/load and stillness exit. */
  crossfadeSeconds?: number;
  /** Movement id treated as the stillness gate (default 'stillness'). */
  stillnessMovementId?: string;
  /** §6.4 calibrated dead thresholds on tier-1 chemistry health. */
  deadOccupancy?: number;
  deadActivity?: number;
  /** Age beyond which a chemistry sample is stale and ignored. */
  freshAnalysisSeconds?: number;
  /** §6.4 premature-extinction window (default 20 s). */
  extinctionSeconds?: number;
  /** §6.4 kill-wait negligible-chemistry confirm window (default 8 s). */
  chemistryConfirmSeconds?: number;
  /** §6.4 concealed black hold (default 20 s). */
  blackHoldSeconds?: number;
  /** §6.4 kill-wait timeout as a multiple of the stillness movement's max dwell (default 3). */
  timeoutFactor?: number;
  /** §4.4 duration jitter fraction (default 0.08). */
  durationJitterFraction?: number;
  /** Progress-rate smoothing time constant in seconds (5–15, default 10). */
  progressSmoothingSeconds?: number;
  /** Progress-rate bounds (default [.7, 1.3]). */
  progressRange?: readonly [number, number];
  /** Hysteresis deadband on the progress-rate target. */
  progressHysteresis?: number;
  /** Genesis library key used by an injection rescue when the movement declares none. */
  rescueGenesisKey?: string;
}

export interface ProgressSignals {
  /** True when fresh presentation-tier analysis is available. */
  valid: boolean;
  changeRate: number;
  occupiedFraction: number;
  reactionActivity: number;
  recentMerge: boolean;
  /** True once the movement has exceeded its nominal (unscaled) duration. */
  beyondNominalDwell: boolean;
}

export interface ProgressThresholds {
  highNovelty: number;
  lowNovelty: number;
  livingOccupancy: number;
  livingActivity: number;
}

/** Exit-hint thresholds (§6.4). Calibration values; presentation-tier descriptors. */
export const DEFAULT_EXIT_HINT_THRESHOLDS = {
  livingOccupancy: 0.02,
  emptyOccupancy: 0.02,
  replicatingOccupancy: 0.05,
  replicatingBeta0: 3,
  connectingBeta1: 2,
  connectingLargest: 0.3,
  complexBeta0: 4,
  complexBeta1: 3,
} as const;

export const CURATOR_DEFAULTS = {
  crossfadeSeconds: DEFAULT_CROSSFADE_SECONDS,
  stillnessMovementId: 'stillness',
  deadOccupancy: 0.01,
  deadActivity: 0.001,
  freshAnalysisSeconds: 1.5,
  extinctionSeconds: 20,
  chemistryConfirmSeconds: 8,
  blackHoldSeconds: 20,
  timeoutFactor: 3,
  durationJitterFraction: 0.08,
  progressSmoothingSeconds: 10,
  progressRange: [0.7, 1.3] as const,
  progressHysteresis: 0.05,
  progressThresholds: {
    highNovelty: 0.02,
    lowNovelty: 0.002,
    livingOccupancy: 0.05,
    livingActivity: 0.01,
  } as ProgressThresholds,
} as const;

/** §6.4: a merge event keeps progress slowed for this long after it is observed. */
export const MERGE_WINDOW_SECONDS = 10;

/** §6.4 trend refinement: occupancy fraction-per-second slope above which a field counts as rising. */
export const OCCUPANCY_GROWTH_SLOPE = 1e-4;
/** §6.4 trend refinement: absolute occupancy growth over the window that also counts as rising. */
export const OCCUPANCY_GROWTH_ABSOLUTE = 1e-5;

/** §6.4: minimum toroidal domain displacement of a rebirth origin from the prior origin. */
export const MIN_REBIRTH_DISPLACEMENT = 0.12;

// -------------------------------------------------------------------------------------------------
// Small reusable serializable PRNG helpers.
// -------------------------------------------------------------------------------------------------

/**
 * A correlated scalar in `[min, max]` driven by the PRNG substream: the target is redrawn every
 * `correlationSeconds`, and the value relaxes toward it with a time constant of a third of that.
 * Used for duration jitter and the smooth §4.4 F/k parameter perturbation (30–90 s).
 */
export class CorrelatedSignal {
  private readonly rng: Rng;
  private readonly min: number;
  private readonly max: number;
  private readonly correlationSeconds: number;
  private valueInternal: number;
  private target: number;
  private timer: number;

  constructor(
    rng: Rng,
    options: { min: number; max: number; correlationSeconds: number; initial?: number },
  ) {
    if (!(options.max >= options.min)) throw new Error('CorrelatedSignal: max must be >= min');
    if (!(options.correlationSeconds > 0)) throw new Error('CorrelatedSignal: correlationSeconds must be > 0');
    this.rng = rng;
    this.min = options.min;
    this.max = options.max;
    this.correlationSeconds = options.correlationSeconds;
    const initial = options.initial ?? (options.min + options.max) / 2;
    this.valueInternal = clamp(initial, options.min, options.max);
    this.target = this.valueInternal;
    this.timer = options.correlationSeconds;
  }

  get value(): number {
    return this.valueInternal;
  }

  update(dt: number): number {
    this.timer += dt;
    if (this.timer >= this.correlationSeconds) {
      this.timer = 0;
      this.target = this.min + (this.max - this.min) * this.rng.next();
    }
    const tau = this.correlationSeconds / 3;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.valueInternal = clamp(this.valueInternal + (this.target - this.valueInternal) * alpha, this.min, this.max);
    return this.valueInternal;
  }
}

/**
 * §6.4 analysis-driven progress-rate scaler.
 *
 * Sustained novelty/change or a recent merge slows progress; stable living states get extra dwell;
 * low novelty beyond the nominal dwell gently hastens progress. The output is smoothed over
 * `progressSmoothingSeconds` (5–15 s) and hysteresis is applied to the target so a signal hovering
 * near a threshold cannot make the rate oscillate. With invalid analysis the rate reverts to 1.0
 * (elapsed-time behaviour).
 */
export class ProgressScaler {
  private readonly min: number;
  private readonly max: number;
  private readonly smoothingSeconds: number;
  private readonly hysteresis: number;
  private readonly thresholds: ProgressThresholds;
  private rateInternal = 1;
  private held = 1;

  constructor(options: {
    min?: number;
    max?: number;
    smoothingSeconds?: number;
    hysteresis?: number;
    thresholds?: ProgressThresholds;
  } = {}) {
    this.min = options.min ?? CURATOR_DEFAULTS.progressRange[0];
    this.max = options.max ?? CURATOR_DEFAULTS.progressRange[1];
    this.smoothingSeconds = options.smoothingSeconds ?? CURATOR_DEFAULTS.progressSmoothingSeconds;
    this.hysteresis = options.hysteresis ?? CURATOR_DEFAULTS.progressHysteresis;
    this.thresholds = options.thresholds ?? CURATOR_DEFAULTS.progressThresholds;
  }

  get rate(): number {
    return this.rateInternal;
  }

  /** The target the hysteresis filter currently holds (exposed for tests). */
  get heldTarget(): number {
    return this.held;
  }

  reset(): void {
    this.rateInternal = 1;
    this.held = 1;
  }

  update(signals: ProgressSignals, dt: number): number {
    if (!signals.valid) {
      this.rateInternal = 1;
      this.held = 1;
      return 1;
    }

    const living =
      signals.occupiedFraction >= this.thresholds.livingOccupancy &&
      signals.reactionActivity >= this.thresholds.livingActivity;

    let target: number;
    if (signals.recentMerge || signals.changeRate >= this.thresholds.highNovelty) {
      target = this.min; // sustained novelty / merge slows progress
    } else if (living) {
      target = this.min + (1 - this.min) * 0.4; // stable living: extra dwell, less extreme
    } else if (signals.changeRate <= this.thresholds.lowNovelty) {
      target = signals.beyondNominalDwell ? this.max : 1.05; // low novelty gently hastens
    } else {
      target = 1;
    }

    if (Math.abs(target - this.held) > this.hysteresis) this.held = target;

    const tau = this.smoothingSeconds;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    this.rateInternal = clamp(this.rateInternal + (this.held - this.rateInternal) * alpha, this.min, this.max);
    return this.rateInternal;
  }
}

function clampTuple(p: ParamTuple): ParamTuple {
  return [
    clamp(p[0], 0, 0.1),
    clamp(p[1], 0, 0.09),
    clamp(p[2], 0.0001, 0.2),
    clamp(p[3], 0.0001, 0.2),
  ];
}

/** Wrap a normalized coordinate into [0, 1). */
export function wrapUV(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * §4.3 toroidal distance between two normalized domain points: the minimum-image Euclidean distance
 * on the unit torus. The chemical domain wraps in both axes (integer coordinate wrapping in the
 * shader), so "displacement" is measured toroidally, not on a clamped square.
 */
export function toroidalDistanceUV(a: Vec2, b: Vec2): number {
  const rawX = Math.abs(a[0] - b[0]);
  const rawY = Math.abs(a[1] - b[1]);
  return Math.hypot(Math.min(rawX, 1 - rawX), Math.min(rawY, 1 - rawY));
}

/**
 * Project `center` so its toroidal distance from `prior` is at least `minDistance`, preserving the
 * direction of the minimum-image displacement (a deterministic `+x` direction when the two coincide).
 * The result is wrapped into [0, 1); for `minDistance < 0.5` the projected displacement is exact,
 * because each component of the scaled delta stays below 0.5 and is therefore its own minimum image.
 */
export function enforceMinDisplacement(center: Vec2, prior: Vec2, minDistance: number): Vec2 {
  let dx = center[0] - prior[0];
  let dy = center[1] - prior[1];
  dx -= Math.round(dx);
  dy -= Math.round(dy);
  let dist = Math.hypot(dx, dy);
  if (dist >= minDistance) return [wrapUV(center[0]), wrapUV(center[1])];
  if (dist < 1e-9) {
    dx = 1;
    dy = 0;
    dist = 1;
  }
  const scale = minDistance / dist;
  return [wrapUV(prior[0] + dx * scale), wrapUV(prior[1] + dy * scale)];
}

// -------------------------------------------------------------------------------------------------
// §4.4 genesis construction — shared by the live curator and the §6.5 lab driver.
// -------------------------------------------------------------------------------------------------

/** The PRNG surface the genesis construction draws from (`Rng` satisfies it). */
export interface GenesisRng {
  nextUint32(): number;
  symmetric(magnitude: number): number;
}

/**
 * Build a genesis command from a library entry, optionally perturbing centre/radius/strength from
 * `rng` (§4.4: position, radius and strength vary by roughly ±5%).
 *
 * This is the *single* construction the live curator uses for every movement-entry, rescue and
 * hard-clear seed, and it is exported so the §6.5 discovery driver can emit a **curator-faithful**
 * command rather than reimplementing the perturbation — or, worse, only varying `command.seed`,
 * which the `single` shader branch ignores because `commandToUniforms` honours a `single` command's
 * own centre/radius/strength and discards the generator's geometry for that kind.
 *
 * Draw order is part of the contract and must not change: centre x, centre y, radius, strength, then
 * the command seed.
 */
export function buildGenesisCommandFromEntry(
  entry: GenesisLibraryEntry,
  rng: GenesisRng,
  options: { mode: 'replace' | 'inject'; id: number; perturb: boolean },
): GenesisCommand {
  let center = entry.center;
  let radiusCells = entry.radiusCells;
  let strength = entry.strength;
  if (options.perturb) {
    const jitter = 0.05; // §4.4: position, radius and strength vary by roughly ±5%
    center = [
      clamp(entry.center[0] + rng.symmetric(0.004), 0, 1),
      clamp(entry.center[1] + rng.symmetric(0.004), 0, 1),
    ] as Vec2;
    radiusCells = entry.radiusCells * (1 + rng.symmetric(jitter));
    strength = clamp(entry.strength * (1 + rng.symmetric(0.05)), 0, 1);
  }
  return {
    id: options.id,
    kind: entry.kind,
    mode: options.mode,
    seed: rng.nextUint32(),
    center,
    radiusCells,
    strength,
  };
}

/** §6.4 rebirth displacement: push `center` out along its own minimum-image direction from `prior`. */
export function displaceEntryCenter(center: Vec2, prior: Vec2 | null): Vec2 {
  return prior === null ? center : enforceMinDisplacement(center, prior, MIN_REBIRTH_DISPLACEMENT);
}

export interface EntryGenesisRequest {
  /** The active trajectory document (passed in, so the helper stays import-free of the JSON). */
  doc: TrajectoryDocument;
  /** The destination movement whose declared `enterGenesis` should be built. */
  movementId: string;
  /** The root seed the curator substream is derived from (§4.4). */
  rootSeed: number;
  /** The origin the entry genesis must displace from, or null for an arc's first origin. */
  priorOrigin: Vec2 | null;
  /** Stable command id for the emitted command (default 1). */
  id?: number;
}

/**
 * §6.4/§6.5 movement-entry genesis construction, exported for the lab driver.
 *
 * The live curator builds its entry genesis from the *shared* curator substream, whose position has
 * already advanced through its correlated-policy draws and any earlier commands. The lab driver has
 * no such stream state, so this helper derives a **fresh** curator substream from `rootSeed` and
 * applies the same construction (`buildGenesisCommandFromEntry` with perturbation) and the same
 * `MIN_REBIRTH_DISPLACEMENT` projection from `priorOrigin`. It is therefore a *representative*
 * curator-faithful trial: deterministic for the seed, and — unlike the previous fixed command —
 * varying centre/radius/strength as the curator does, across seeds.
 *
 * Returns null when the movement declares no `enterGenesis` (no spurious seed), matching the
 * curator's `enterMovement`.
 */
export function buildEntryGenesisCommand(request: EntryGenesisRequest): GenesisCommand | null {
  const movement = request.doc.movements.find((spec) => spec.id === request.movementId);
  if (!movement || movement.enterGenesis === undefined) return null;
  const entry = request.doc.genesisLibrary[movement.enterGenesis];
  if (!entry) return null;
  const rng = createSubstream(request.rootSeed, SUBSTREAM_IDS.curator);
  const command = buildGenesisCommandFromEntry(entry, rng, {
    mode: 'replace',
    id: request.id ?? 1,
    perturb: true,
  });
  return { ...command, center: displaceEntryCenter(command.center, request.priorOrigin) };
}

// -------------------------------------------------------------------------------------------------
// Curator.
// -------------------------------------------------------------------------------------------------

export class Curator {
  private readonly options: Required<Omit<CuratorOptions, 'rootSeed' | 'rescueGenesisKey'>> & {
    rootSeed: number;
    rescueGenesisKey: string | null;
  };
  private readonly rng: Rng;
  private doc: TrajectoryDocument;

  private currentMovement!: MovementSpec;
  private elapsedSeconds = 0;
  private progress = 0;
  /** Normalized path progress, accumulated incrementally (§6.4). Reset on movement entry. */
  private pathProgress = 0;
  private currentParams: ParamTuple;

  private transitionFrom: ParamTuple | null = null;
  private transitionElapsed = 0;
  private transitionSeconds = 0;

  // Document-dependent correlated policy state; rebuilt from `this.doc` by `rebuildDocumentState`.
  private durationSignal!: CorrelatedSignal;
  private jitterF!: CorrelatedSignal;
  private jitterK!: CorrelatedSignal;
  private readonly progressScaler: ProgressScaler;

  private arc = 0;
  private rescueUsedThisArc = false;
  private deadSeconds = 0;
  private mergeRecentSeconds = 0;
  private lastEventSerial = 0;
  /**
   * §6.4 trend refinement: a short history of full-domain occupancy samples used to decide whether a
   * below-threshold field is *rising* (and therefore not extinct). Sampled at most every 0.5 s and
   * trimmed to the extinction window so it stays bounded.
   */
  private readonly occupancyHistory: { t: number; occ: number }[] = [];
  /** Centre of the most recent movement-entry genesis — the origin a rebirth must displace from. */
  private lastGenesisOrigin: Vec2 | null = null;

  private overrideActive = false;
  private overrideParams: Params | null = null;

  private stillnessState: PhaseState['stillnessState'] = 'none';
  private killWaitNegligibleSeconds = 0;
  private chemistryConfirmed = false;
  private chemistryCleared = false;
  private blackHoldElapsed = 0;

  private performanceSeconds = 0;
  private genesisIdCounter = 1;

  private readonly diagnosticsLog: string[] = [];
  private diagnosticCount = 0;
  /** §6.4 extinction-decision telemetry, drained by the app into the arc evidence log. */
  private readonly extinctionLog: ExtinctionDecision[] = [];

  private activeSink: GenesisCommand[] | null = null;
  private queuedGenesis: GenesisCommand[] = [];

  private readonly timeline: StillnessTimeline = {
    killWaitEnteredAt: null,
    chemistryConfirmedAt: null,
    audioZeroAt: null,
    blackHoldStartedAt: null,
    blackHoldCompletedAt: null,
    genesisAt: null,
  };

  constructor(document: TrajectoryDocument, options: CuratorOptions = {}) {
    this.doc = document;
    this.options = {
      rootSeed: options.rootSeed ?? document.seed ?? 1,
      crossfadeSeconds: options.crossfadeSeconds ?? CURATOR_DEFAULTS.crossfadeSeconds,
      stillnessMovementId: options.stillnessMovementId ?? CURATOR_DEFAULTS.stillnessMovementId,
      deadOccupancy: options.deadOccupancy ?? CURATOR_DEFAULTS.deadOccupancy,
      deadActivity: options.deadActivity ?? CURATOR_DEFAULTS.deadActivity,
      freshAnalysisSeconds: options.freshAnalysisSeconds ?? CURATOR_DEFAULTS.freshAnalysisSeconds,
      extinctionSeconds: options.extinctionSeconds ?? CURATOR_DEFAULTS.extinctionSeconds,
      chemistryConfirmSeconds: options.chemistryConfirmSeconds ?? CURATOR_DEFAULTS.chemistryConfirmSeconds,
      blackHoldSeconds: options.blackHoldSeconds ?? CURATOR_DEFAULTS.blackHoldSeconds,
      timeoutFactor: options.timeoutFactor ?? CURATOR_DEFAULTS.timeoutFactor,
      durationJitterFraction: options.durationJitterFraction ?? CURATOR_DEFAULTS.durationJitterFraction,
      progressSmoothingSeconds: options.progressSmoothingSeconds ?? CURATOR_DEFAULTS.progressSmoothingSeconds,
      progressRange: options.progressRange ?? CURATOR_DEFAULTS.progressRange,
      progressHysteresis: options.progressHysteresis ?? CURATOR_DEFAULTS.progressHysteresis,
      rescueGenesisKey: options.rescueGenesisKey ?? null,
    };

    this.rng = createSubstream(this.options.rootSeed, SUBSTREAM_IDS.curator);
    this.progressScaler = new ProgressScaler({
      min: this.options.progressRange[0],
      max: this.options.progressRange[1],
      smoothingSeconds: this.options.progressSmoothingSeconds,
      hysteresis: this.options.progressHysteresis,
    });
    this.rebuildDocumentState();

    const first = document.movements[0]!;
    this.currentParams = tupleFromParams(evaluateMovement({ spec: first, progress: 0 }).parameters);
    this.enterMovement(first, 0, /*initial*/ true);
  }

  /**
   * (Re)build the document-dependent correlated policy state from `this.doc`.
   *
   * Called from the constructor and from `load-trajectory`, so a loaded document's `parameterJitter`
   * amplitudes and `correlationSeconds` take effect immediately instead of leaving the previous
   * document's amplitudes in force. The generators draw from the curator substream but construction
   * takes **no** draws, so this is deterministic and does not perturb the genesis/parameter draw
   * sequence. The duration-jitter amplitude is an option (`durationJitterFraction`), not a document
   * field, so only the F/k amplitudes are document-derived.
   */
  private rebuildDocumentState(): void {
    const correlation = this.doc.parameterJitter.correlationSeconds;
    this.durationSignal = new CorrelatedSignal(this.rng, {
      min: -this.options.durationJitterFraction,
      max: this.options.durationJitterFraction,
      correlationSeconds: correlation,
      initial: 0,
    });
    this.jitterF = new CorrelatedSignal(this.rng, {
      min: -this.doc.parameterJitter.F,
      max: this.doc.parameterJitter.F,
      correlationSeconds: correlation,
      initial: 0,
    });
    this.jitterK = new CorrelatedSignal(this.rng, {
      min: -this.doc.parameterJitter.k,
      max: this.doc.parameterJitter.k,
      correlationSeconds: correlation,
      initial: 0,
    });
  }

  // -- public read-only accessors -----------------------------------------------------------------

  get document(): TrajectoryDocument {
    return this.doc;
  }

  get arcIndex(): number {
    return this.arc;
  }

  get movementId(): string {
    return this.currentMovement.id;
  }

  get stillState(): PhaseState['stillnessState'] {
    return this.stillnessState;
  }

  get parameters(): Params {
    return paramsFromTuple(this.currentParams);
  }

  /** Current analysis-driven progress-rate scale in [.7, 1.3] (§6.4); exposed for tests. */
  get progressRate(): number {
    return this.progressScaler.rate;
  }

  /** True while a merge event is still inside its §6.4 slowdown window. */
  recentMergeActive(): boolean {
    return this.mergeRecentSeconds > 0;
  }

  /** §6.4: whether the current arc's one injection rescue has been spent (exposed for tests). */
  get rescueUsed(): boolean {
    return this.rescueUsedThisArc;
  }

  /** §6.4/§4.3: the origin of the most recent entry genesis; a rebirth must displace from it. */
  get genesisOrigin(): Vec2 | null {
    return this.lastGenesisOrigin;
  }

  /** Telemetry for the most recent stillness episode. */
  stillnessTimeline(): StillnessTimeline {
    return { ...this.timeline };
  }

  /** Drain the laboratory-only diagnostic log emitted so far. */
  drainDiagnostics(): string[] {
    return this.diagnosticsLog.splice(0, this.diagnosticsLog.length);
  }

  /**
   * §6.4: drain the extinction-decision telemetry emitted so far. The app accumulates it so the arc
   * evidence can report *why* each rescue/recovery fired, not only that a command was issued.
   */
  drainExtinctionLog(): ExtinctionDecision[] {
    return this.extinctionLog.splice(0, this.extinctionLog.length);
  }

  get diagnosticsEmitted(): number {
    return this.diagnosticCount;
  }

  // -- command surface ----------------------------------------------------------------------------

  command(command: CuratorCommand): void {
    switch (command.type) {
      case 'skip-movement': {
        // The stillness gate owns its own exit; a lab skip does not bypass the concealed hold.
        if (this.stillnessState !== 'none') return;
        const next = this.resolveMovement(this.currentMovement.next[0]!);
        if (next) this.enterMovement(next, this.options.crossfadeSeconds, false);
        return;
      }
      case 'load-trajectory': {
        // Snapshot the actual current vector BEFORE anything document-dependent is rebuilt: it is
        // the crossfade origin, so the loaded trajectory must start from where the parameters
        // really are, not from the new document's first waypoint.
        const prior = this.currentParams;
        this.doc = command.document;
        this.stillnessState = 'none';
        this.resetStillnessEpisode();
        this.resetStillnessTimeline();
        this.rebuildDocumentState();
        this.progressScaler.reset();
        this.mergeRecentSeconds = 0;
        this.deadSeconds = 0;
        this.currentParams = prior;
        const first = command.document.movements[0]!;
        this.enterMovement(first, this.options.crossfadeSeconds, true);
        return;
      }
      case 'parameters-override': {
        this.overrideActive = true;
        this.overrideParams = command.value;
        return;
      }
      case 'parameters-release': {
        if (!this.overrideActive || this.overrideParams === null) return;
        this.transitionFrom = tupleFromParams(this.overrideParams);
        this.transitionElapsed = 0;
        this.transitionSeconds = this.options.crossfadeSeconds;
        this.overrideActive = false;
        this.overrideParams = null;
        return;
      }
      case 'reseed': {
        this.emitGenesis(command.genesis);
        return;
      }
    }
  }

  // -- the tick -----------------------------------------------------------------------------------

  advance(dt: number, environment: CuratorEnvironment, previous: WorldState): CuratorOutput {
    this.performanceSeconds += dt;
    const issued: GenesisCommand[] = [];
    this.activeSink = issued;
    // Genesis queued by command() since the last tick surfaces on this tick.
    while (this.queuedGenesis.length > 0) issued.push(this.queuedGenesis.shift()!);

    // §6.4 merge slowdown: decrement every tick (even under a parameter override or the stillness
    // gate) and re-arm on a newly observed merge, so the window always expires ~MERGE_WINDOW_SECONDS
    // after the event instead of persisting until the arc reset.
    this.mergeRecentSeconds = Math.max(0, this.mergeRecentSeconds - dt);
    if (previous.events.serial !== this.lastEventSerial) {
      this.lastEventSerial = previous.events.serial;
      if (previous.events.kind === 'merge') this.mergeRecentSeconds = MERGE_WINDOW_SECONDS;
    }

    if (this.overrideActive) {
      this.activeSink = null;
      return {
        parameters: this.overrideParams!,
        phase: this.phaseSnapshot(this.progress),
        genesis: issued,
      };
    }

    if (this.isStillnessMovement(this.currentMovement)) {
      this.advanceStillness(dt, environment, previous);
    } else {
      this.advanceMovement(dt, previous);
    }

    this.activeSink = null;
    return {
      parameters: paramsFromTuple(this.currentParams),
      phase: this.phaseSnapshot(this.progress),
      genesis: issued,
    };
  }

  // -- ordinary movement --------------------------------------------------------------------------

  private advanceMovement(dt: number, previous: WorldState): void {
    const spec = this.currentMovement;
    this.elapsedSeconds += dt;

    // Correlated §4.4 perturbations (bounded to the trajectory envelope after applying).
    this.durationSignal.update(dt);
    const durationScale = this.durationScaleFor(spec);
    const effectiveDuration = effectiveDurationSeconds(spec, durationScale);

    const signals = this.collectSignals(previous, effectiveDuration);
    const progressRate = this.progressScaler.update(signals, dt);

    // Incremental, monotone progress accumulation (§6.4): never rate × total elapsed.
    this.pathProgress = advanceProgress(this.pathProgress, dt, progressRate, effectiveDuration);

    const evaluation = evaluateMovement({
      spec,
      progress: this.pathProgress,
      transitionFrom: this.transitionFrom,
      transitionElapsedSeconds: this.transitionElapsed,
      transitionSeconds: this.transitionSeconds,
    });
    this.progress = evaluation.progress;
    this.currentParams = this.applyJitter(tupleFromParams(evaluation.parameters), dt);
    this.transitionElapsed += dt;

    // Premature-extinction safety (§6.4).
    this.updateExtinction(previous, dt);
    // A rescue/collapse transition may have moved us into another movement this tick.
    if (this.currentMovement !== spec) return;

    // Dwell bounds: end at max dwell, or after min dwell when the path completes or the exit hint
    // fires. The exit hint is never required beyond max dwell.
    const { minDwell, maxDwell } = this.dwellBounds(spec);
    const hintSatisfied = this.exitHintSatisfied(spec, previous);
    const pathComplete = this.pathProgress >= 1;
    const ended =
      this.elapsedSeconds >= maxDwell ||
      (this.elapsedSeconds >= minDwell && (pathComplete || hintSatisfied));

    if (ended) {
      const next = this.resolveMovement(spec.next[0]!);
      if (next) this.enterMovement(next, 0, false);
    }
  }

  // -- stillness gate -----------------------------------------------------------------------------

  private advanceStillness(dt: number, environment: CuratorEnvironment, previous: WorldState): void {
    const spec = this.currentMovement;
    this.elapsedSeconds += dt;
    this.durationSignal.update(dt);

    const durationScale = this.durationScaleFor(spec);
    this.pathProgress = advanceProgress(this.pathProgress, dt, 1, effectiveDurationSeconds(spec, durationScale));
    const evaluation = evaluateMovement({
      spec,
      progress: this.pathProgress,
      transitionFrom: this.transitionFrom,
      transitionElapsedSeconds: this.transitionElapsed,
      transitionSeconds: this.transitionSeconds,
    });
    this.progress = evaluation.progress;
    this.currentParams = clampTuple(this.applyJitter(tupleFromParams(evaluation.parameters), dt));
    this.transitionElapsed += dt;

    const { maxDwell } = this.dwellBounds(spec);

    if (this.stillnessState === 'kill-wait') {
      const negligible = this.chemistryNegligible(previous);
      this.killWaitNegligibleSeconds = negligible ? this.killWaitNegligibleSeconds + dt : 0;
      if (!this.chemistryConfirmed && this.killWaitNegligibleSeconds >= this.options.chemistryConfirmSeconds) {
        this.chemistryConfirmed = true;
        this.timeline.chemistryConfirmedAt = this.performanceSeconds;
      }

      const killWaitElapsed = this.performanceSeconds - (this.timeline.killWaitEnteredAt ?? this.performanceSeconds);
      if (
        !this.chemistryConfirmed &&
        !this.chemistryCleared &&
        killWaitElapsed >= this.options.timeoutFactor * maxDwell
      ) {
        // Exactly one diagnostic and one hard-clear on the timeout path.
        this.emitDiagnostic(
          'stillness: chemistry never became negligible within 3x max dwell; issuing one hard clear',
        );
        this.emitHardClear();
        this.chemistryCleared = true;
        this.timeline.chemistryConfirmedAt = this.performanceSeconds;
      }

      const chemistryReady = this.chemistryConfirmed || this.chemistryCleared;
      if (chemistryReady && environment.silence.satisfied) {
        this.stillnessState = 'black-hold';
        this.blackHoldElapsed = 0;
        this.timeline.blackHoldStartedAt = this.performanceSeconds;
        this.timeline.audioZeroAt = environment.silence.terminalZeroAt;
      }
      return;
    }

    // black-hold
    this.blackHoldElapsed += dt;
    if (this.blackHoldElapsed >= this.options.blackHoldSeconds) {
      this.completeStillness();
    }
  }

  /** Black hold complete: concealed rebirth genesis, arc increment, per-arc state reset (§6.4). */
  private completeStillness(): void {
    this.timeline.blackHoldCompletedAt = this.performanceSeconds;
    this.timeline.genesisAt = this.performanceSeconds;

    this.arc += 1;
    this.rescueUsedThisArc = false;
    this.deadSeconds = 0;
    this.mergeRecentSeconds = 0;
    this.occupancyHistory.length = 0;
    this.progressScaler.reset();
    this.stillnessState = 'none';
    this.resetStillnessEpisode();

    const next = this.resolveMovement(this.currentMovement.next[0]!);
    if (next) {
      // The rebirth parameters differ from the collapse-end hold, so start from actual params.
      this.enterMovement(next, this.options.crossfadeSeconds, false);
    }
  }

  // -- movement entry / transitions ---------------------------------------------------------------

  private enterMovement(spec: MovementSpec, crossfadeSeconds: number, _initial: boolean): void {
    this.currentMovement = spec;
    this.elapsedSeconds = 0;
    this.progress = 0;
    this.pathProgress = 0;
    // §6.4: transitions start from the actual current parameter vector.
    this.transitionFrom = this.currentParams;
    this.transitionElapsed = 0;
    this.transitionSeconds = crossfadeSeconds;

    if (this.isStillnessMovement(spec)) {
      this.resetStillnessTimeline();
      this.resetStillnessEpisode();
      this.stillnessState = 'kill-wait';
      this.timeline.killWaitEnteredAt = this.performanceSeconds;
    }

    if (spec.enterGenesis !== undefined) {
      const entry = this.doc.genesisLibrary[spec.enterGenesis];
      if (entry) this.emitGenesis(this.buildEntryGenesis(entry));
    }
  }

  private resolveMovement(id: string): MovementSpec | null {
    return this.doc.movements.find((movement) => movement.id === id) ?? null;
  }

  private isStillnessMovement(spec: MovementSpec): boolean {
    return spec.id === this.options.stillnessMovementId;
  }

  private dwellBounds(spec: MovementSpec): { minDwell: number; maxDwell: number } {
    const [minScale, maxScale] = this.doc.durationScaleRange;
    return { minDwell: spec.seconds * minScale, maxDwell: spec.seconds * maxScale };
  }

  private durationScaleFor(spec: MovementSpec): number {
    const [minScale, maxScale] = this.doc.durationScaleRange;
    if (spec.intention === 'quiet') return maxScale; // quiet dwell is honoured at the top bound
    return clamp(1 + this.durationSignal.value, minScale, maxScale);
  }

  private applyJitter(p: ParamTuple, dt: number): ParamTuple {
    const f = this.jitterF.update(dt);
    const k = this.jitterK.update(dt);
    return clampTuple([p[0] + f, p[1] + k, p[2], p[3]]);
  }

  // -- analysis signals ---------------------------------------------------------------------------

  private collectSignals(previous: WorldState, durationBucket: number): ProgressSignals {
    const presentation = previous.analysis.presentation;
    // The merge window is advanced once per tick in `advance`, not here.
    const fresh = presentation.valid && presentation.ageSeconds <= this.options.freshAnalysisSeconds;
    return {
      valid: fresh,
      changeRate: presentation.changeRate,
      occupiedFraction: presentation.occupiedFraction,
      reactionActivity: presentation.reactionActivity,
      recentMerge: this.mergeRecentSeconds > 0,
      beyondNominalDwell: this.elapsedSeconds > durationBucket,
    };
  }

  private exitHintSatisfied(spec: MovementSpec, previous: WorldState): boolean {
    if (spec.exitHint === undefined) return false;
    const presentation = previous.analysis.presentation;
    if (!presentation.valid || presentation.ageSeconds > this.options.freshAnalysisSeconds) return false;
    const t = DEFAULT_EXIT_HINT_THRESHOLDS;
    switch (spec.exitHint) {
      case 'living':
        return presentation.occupiedFraction > t.livingOccupancy;
      case 'empty':
        return presentation.occupiedFraction <= t.emptyOccupancy;
      case 'replicating':
        return (
          presentation.occupiedFraction >= t.replicatingOccupancy &&
          presentation.beta0Approx >= t.replicatingBeta0
        );
      case 'connecting':
        return (
          presentation.beta1Approx >= t.connectingBeta1 ||
          presentation.largestComponentFraction >= t.connectingLargest
        );
      case 'complex':
        return presentation.beta0Approx >= t.complexBeta0 && presentation.beta1Approx >= t.complexBeta1;
      default:
        return false;
    }
  }

  /**
   * §6.4 trend refinement: is the full-domain occupancy rising over the extinction window? Records at
   * most one sample every 0.5 s, trims to the window, and returns true on a positive slope (or clear
   * relative growth). A rising young field is not extinguished even while it is below the dead
   * thresholds.
   */
  private occupancyRising(occupancy: number): boolean {
    const history = this.occupancyHistory;
    const now = this.performanceSeconds;
    const last = history[history.length - 1];
    if (last === undefined || now - last.t >= 0.5) history.push({ t: now, occ: occupancy });
    const window = this.options.extinctionSeconds;
    while (history.length > 2 && history[0]!.t < now - window) history.shift();
    if (history.length < 2) return false;
    const first = history[0]!;
    const newest = history[history.length - 1]!;
    const dt = newest.t - first.t;
    if (!(dt > 0)) return false;
    const slope = (newest.occ - first.occ) / dt;
    if (slope > OCCUPANCY_GROWTH_SLOPE) return true;
    return newest.occ > first.occ + OCCUPANCY_GROWTH_ABSOLUTE && newest.occ > first.occ * 1.05;
  }

  private chemistryNegligible(previous: WorldState): boolean {
    const health = previous.analysis.chemistryHealth;
    if (!health.valid || health.ageSeconds > this.options.freshAnalysisSeconds) return false;
    return (
      health.fullOccupiedFraction < this.options.deadOccupancy &&
      health.fullReactionActivity < this.options.deadActivity
    );
  }

  /**
   * §6.4 premature-extinction safety. Only active during living intentions (never during intentional
   * quiet or collapse). One injection rescue per arc; a repeat follows the declared collapse edge
   * instead of seeding again.
   *
   * **Trend refinement (Phase 3).** The domain-scale dead threshold (≈0.01–0.02) is below where a fresh
   * radius-6 nucleation seed starts, so a *rising* young field would otherwise accumulate the full
   * premature-extinction window before it crosses the threshold and fire a spurious rescue. A field is
   * therefore treated as dead only when it is **both** below the dead thresholds **and not growing**:
   * a positive occupancy slope over the window (or clear relative growth) keeps it alive. A flat or
   * decaying field below the thresholds is still rescued.
   */
  private updateExtinction(previous: WorldState, dt: number): void {
    const intention = this.currentMovement.intention;
    const livingIntent =
      intention === 'emerge' || intention === 'expand' || intention === 'connect' || intention === 'saturate';
    if (!livingIntent) {
      this.deadSeconds = 0;
      this.occupancyHistory.length = 0;
      return;
    }

    const health = previous.analysis.chemistryHealth;
    const fresh = health.valid && health.ageSeconds <= this.options.freshAnalysisSeconds;
    const belowThresholds =
      fresh &&
      health.fullOccupiedFraction < this.options.deadOccupancy &&
      health.fullReactionActivity < this.options.deadActivity;
    const growing = fresh ? this.occupancyRising(health.fullOccupiedFraction) : false;
    const dead = belowThresholds && !growing;
    this.deadSeconds = dead ? this.deadSeconds + dt : 0;
    if (this.deadSeconds < this.options.extinctionSeconds) return;

    const rescueKey = this.currentMovement.enterGenesis ?? this.options.rescueGenesisKey;
    const entry = rescueKey !== null ? this.doc.genesisLibrary[rescueKey] : undefined;
    const canRescue = !this.rescueUsedThisArc && intention === 'emerge' && entry !== undefined;
    // Declared recovery alternative only: a movement with a single edge has none, so an
    // extinction there lets the movement's own dwell proceed rather than skipping ahead.
    const recoveryId = this.currentMovement.next.length > 1 ? this.currentMovement.next[1]! : null;
    const action: ExtinctionDecision['action'] = canRescue ? 'rescue' : recoveryId !== null ? 'recovery' : 'none';

    // Record the decision *before* acting, so `movement`/`intention` are the ones that went extinct
    // (a recovery edge moves us into the next movement) and the health/accumulator are the ones read.
    this.extinctionLog.push({
      performanceSeconds: this.performanceSeconds,
      arc: this.arc,
      movement: this.currentMovement.id,
      intention,
      parameters: this.parameters,
      healthValid: health.valid,
      healthAgeSeconds: health.ageSeconds,
      healthOccupiedFraction: health.fullOccupiedFraction,
      healthReactionActivity: health.fullReactionActivity,
      occupancyGrowing: growing,
      deadSeconds: this.deadSeconds,
      action,
      recoveryMovement: action === 'recovery' ? recoveryId : null,
    });

    this.deadSeconds = 0;
    if (canRescue) {
      this.emitGenesis(this.buildGenesisCommand(entry, 'inject', true));
      this.rescueUsedThisArc = true;
      return;
    }
    if (recoveryId !== null) {
      const next = this.resolveMovement(recoveryId);
      if (next) this.enterMovement(next, this.options.crossfadeSeconds, false);
    }
  }

  // -- genesis ------------------------------------------------------------------------------------

  private buildGenesisCommand(
    entry: GenesisLibraryEntry,
    mode: 'replace' | 'inject',
    perturb: boolean,
  ): GenesisCommand {
    return buildGenesisCommandFromEntry(entry, this.rng, {
      mode,
      id: this.genesisIdCounter++,
      perturb,
    });
  }

  /**
   * Build a movement-entry genesis and enforce §6.4's rebirth displacement: the centre of every
   * origin genesis must be at least `MIN_REBIRTH_DISPLACEMENT` (toroidal distance, §4.3) from the
   * previous origin. The shipped §6.3 base centres are only ~0.1304 apart, so a ±0.004 coordinate
   * jitter can shrink a realized rebirth below 0.12; the projection pushes it back out along its own
   * displacement direction. `public/trajectories/default.json`'s base values are left untouched.
   *
   * The construction itself (`buildGenesisCommandFromEntry`) and the displacement projection
   * (`displaceEntryCenter`) are shared with the exported `buildEntryGenesisCommand` the §6.5 lab
   * driver calls, so the driver cannot drift from the live curator's entry semantics.
   */
  private buildEntryGenesis(entry: GenesisLibraryEntry): GenesisCommand {
    const command = this.buildGenesisCommand(entry, 'replace', true);
    const center = displaceEntryCenter(command.center, this.lastGenesisOrigin);
    this.lastGenesisOrigin = center;
    return { ...command, center };
  }

  private emitHardClear(): void {
    // A replace with zero strength leaves the whole domain at (U=1, V=0) — inert.
    const entry =
      this.doc.genesisLibrary[this.options.rescueGenesisKey ?? ''] ??
      (Object.values(this.doc.genesisLibrary)[0] as GenesisLibraryEntry | undefined);
    const kind = entry?.kind ?? 'single';
    const center: Vec2 = entry?.center ?? [0.5, 0.5];
    this.emitGenesis({
      id: this.genesisIdCounter++,
      kind,
      mode: 'replace',
      seed: this.rng.nextUint32(),
      center,
      radiusCells: entry?.radiusCells ?? 6,
      strength: 0,
    });
  }

  private emitGenesis(command: GenesisCommand): void {
    if (this.activeSink) this.activeSink.push(command);
    else this.queuedGenesis.push(command);
  }

  private emitDiagnostic(message: string): void {
    this.diagnosticsLog.push(message);
    this.diagnosticCount += 1;
  }

  // -- misc ---------------------------------------------------------------------------------------

  private resetStillnessTimeline(): void {
    this.timeline.killWaitEnteredAt = null;
    this.timeline.chemistryConfirmedAt = null;
    this.timeline.audioZeroAt = null;
    this.timeline.blackHoldStartedAt = null;
    this.timeline.blackHoldCompletedAt = null;
    this.timeline.genesisAt = null;
  }

  private resetStillnessEpisode(): void {
    this.killWaitNegligibleSeconds = 0;
    this.chemistryConfirmed = false;
    this.chemistryCleared = false;
    this.blackHoldElapsed = 0;
  }

  private phaseSnapshot(progress: number): PhaseState {
    return {
      arc: this.arc,
      movement: this.currentMovement.id,
      elapsedSeconds: this.elapsedSeconds,
      progress,
      intention: this.currentMovement.intention,
      stillnessState: this.stillnessState,
    };
  }
}
