/**
 * Application lifecycle and update order (§3.2, §4.1, §2.3).
 *
 * Per frame:
 *   1. real delta -> FixedStepClock.advance -> integer steps (bounded, never enlarged dt)
 *   2. N simulation steps at the current parameters
 *   3. publish a WorldState snapshot at 2 Hz of performance time
 *   4. derive fields -> material -> bloom -> tone map -> screen
 *   5. update laboratory diagnostics (laboratory-only, never rendered into the frame)
 *
 * `app.ts` owns lifecycle, update order, commands, and quality policy. It does not own
 * chemistry, camera policy, or analysis: those belong to their modules.
 */
import { CADENCE, DEFAULT_PARAMS, EXPLORATION_GRID, GENESIS, PRESENTATION, SCENE, SIMULATION_GRID, TIME, UX } from './config.ts';
import { FixedStepClock } from './core/clock.ts';
import { advanceCompositionBatch } from './core/composition-batch.ts';
import { clampSpeed, speedPolicyForResolution, type ResolutionSpeedPolicy } from './core/longform.ts';
import { Analyzer, HEALTH_OFFSET, type CoarseField, type ChemistryHealthSample } from './analysis/analyzer.ts';
import { PresentationWorker, type WorkerLike } from './analysis/presentation-worker.ts';
import type { AnalysisEvent, PresentationDescriptors } from './analysis/protocol.ts';
import { TopologyAnalyzer } from './analysis/topology.ts';
import { Curator, type CuratorEnvironment, type ExtinctionDecision } from './curator/curator.ts';
import { parseTrajectoryDocument, serializeTrajectoryDocument, validateTrajectoryDocument, type TrajectoryDocument } from './curator/schema.ts';
import { VisualDirector } from './visual/director.ts';
import bundledTrajectory from '../public/trajectories/default.json';

/** Where the active composition document came from (§12.2 bootstrap, deviation 39). */
type TrajectorySource = 'bundled' | 'fetched' | 'imported';
/** §3.3/§7.1: real seconds a presentation-worker request may stay unanswered before recovery. */
const PRESENTER_STALL_SECONDS = 5;
import { validateCommand, validateParameters } from './core/commands.ts';
import type { AppCommand, CameraOverride } from './core/commands.ts';
import { Rng, randomRootSeed } from './core/random.ts';
import type {
  AnalysisState,
  CameraState,
  Diagnostics,
  EventState,
  GenesisCommand,
  GLResourceCounts,
  LightState,
  MaterialState,
  Params,
  PhaseState,
  SampleStamp,
  WorldInput,
  WorldState,
} from './core/types.ts';
import { SnapshotWorldStore, neutralAnalysisState, neutralEventState, neutralPhaseState } from './core/world.ts';
import { capabilityReportMarkdown, createContext } from './gpu/context.ts';
import type { CapabilityReport } from './gpu/context.ts';
import { ResourceTracker, createColorTarget, deleteColorTarget } from './gpu/resources.ts';
import type { ColorTarget } from './gpu/resources.ts';
import { imageStats } from './gpu/readback.ts';
import type { ImageStats } from './gpu/readback.ts';
import { FrameTimeRing } from './lab/diagnostics.ts';
import { Lab } from './lab/lab.ts';
import type { CaptureResult, LabApi, LabSnapshot } from './lab/lab.ts';
import { createSingleSeedCommand } from './simulation/genesis.ts';
import { fieldStats } from './simulation/reference.ts';
import type { FieldStats } from './simulation/reference.ts';
import { Simulation } from './simulation/simulation.ts';
import type { ClippingReport } from './simulation/simulation.ts';
import { pickRecordingMimeType, blobToBase64, startCanvasRecording } from './visual/capture.ts';
import type { CanvasRecording } from './visual/capture.ts';
import { Renderer } from './visual/renderer.ts';
import { AudioSystem } from './audio/audio.ts';
import { renderOfflineScenario, type OfflineMeasurements, type OfflineScenarioName } from './audio/offline.ts';

export interface AppOptions {
  canvas: HTMLCanvasElement;
  simulationGrid?: { width: number; height: number };
}


export interface SmallGridRun {
  width: number;
  height: number;
  u: number[];
  v: number[];
  saturatedCells: number;
  feedbackViolations: number;
  attachmentFeedbackOk: boolean;
  steps: number;
  /** Validation-only pre-clamp instrumentation, when the run enabled it. */
  clipping: ClippingReport | null;
}

export interface ArtworkTestHook {
  report(): CapabilityReport;
  capabilityMarkdown(): string;
  canvasSize(): { width: number; height: number };
  sceneSize(): { width: number; height: number };
  steps(): number;
  epoch(): number;
  simulationTime(): number;
  parameters(): Params;
  clock(): { performanceSeconds: number; simulationTime: number; steps: number; paused: boolean; speed: number };
  setParameters(value: Params): void;
  releaseParameters(): void;
  setAutoSeed(enabled: boolean): void;
  setSpeed(value: number): void;
  setPaused(value: boolean): void;
  /** §10: enable/disable the lab-only coarser-grid exploration mode (restarts the organism). */
  setExploration(value: boolean): void;
  /** §10: the active simulation grid edge in cells. */
  simulationSize(): { width: number; height: number };
  /**
   * §10: the dimensions of the renderer's simulation-sized derived-field targets, read from the live
   * GL target (so a switch that failed to re-create them is observable, not just reported).
   */
  rendererSimulationSize(): { width: number; height: number };
  /** Verification/tuning only: light and material overrides used to calibrate the material. */
  setLight(value: Partial<LightState>): void;
  setMaterial(value: Partial<MaterialState>): void;
  light(): LightState;
  material(): MaterialState;
  reset(): void;
  seed(options?: { center?: [number, number]; radiusCells?: number; mode?: 'replace' | 'inject' }): void;
  simulate(steps: number): number;
  renderOnce(): void;
  readField(): { width: number; height: number; u: number[]; v: number[] };
  fieldStats(threshold?: number): FieldStats;
  compositeStats(): ImageStats;
  feedbackOk(): boolean;
  feedbackViolations(): number;
  smallGridRun(options: {
    width: number;
    height: number;
    steps: number;
    parameters?: Params;
    seed?: { center: [number, number]; radiusCells: number } | null;
    /** Enable the validation-only pre-clamp instrumentation for this run. */
    validate?: boolean;
  }): SmallGridRun;
  dispatch(command: AppCommand): { ok: boolean; reason?: string };
  labOpen(): boolean;
  toggleLab(): void;
  labSnapshot(): LabSnapshot;
  cursorIdle(): boolean;
  updateWorld(deltaSeconds: number): void;
  publishNow(): void;
  /** The published snapshot the renderer actually consumed (gate provenance). */
  publishedState(): {
    epoch: number;
    tick: number;
    parameters: Params;
    material: MaterialState;
    light: LightState;
    camera: CameraState;
  };
  /** Exposure and bloom gain the composite pass last used (gate provenance). */
  appliedToneState(): { exposure: number; bloomGain: number };
  /** Apply an explicit, fully specified genesis command (gate provenance). */
  applyGenesis(command: GenesisCommand): void;
  /** Translational symmetry score of the V field at the given period fraction. */
  fieldSymmetry(periodFraction?: number): {
    score: number;
    periodCells: [number, number];
    meanV: number;
    meanAbsoluteDeviation: number;
    meanAbsoluteDifference: number;
  };
  /** Compact in-page summary: occupancy, extent, centroid, and symmetry at one period. */
  fieldSummary(threshold?: number, periodFraction?: number): {
    threshold: number;
    occupiedFraction: number;
    meanU: number;
    meanV: number;
    maxV: number;
    centroidUV: [number, number];
    boundsUV: [number, number, number, number];
    extentUV: [number, number];
    symmetry: {
      score: number;
      periodCells: [number, number];
      meanAbsoluteDifference: number;
      meanAbsoluteDeviation: number;
    };
  };
  enableValidation(enabled: boolean): void;
  clipping(): ClippingReport | null;
  resetValidation(): void;
  /** Depth-renderbuffer/resource lifecycle verification, including validation on/off toggling. */
  lifecycleCheck(): {
    before: GLResourceCounts;
    afterResizeChurn: GLResourceCounts;
    resizeIterations: number;
    scratchTrackerAfterChurn: GLResourceCounts;
    scratchTargets: number;
    throwawayAfterConstruct: GLResourceCounts;
    throwawayAfterDispose: GLResourceCounts;
    /** Counts on a dedicated tracker *after* the simulation is constructed, before validation. */
    validationBaseline: GLResourceCounts;
    /** One entry per enable/disable toggle: counts with validation on, then after it is released. */
    validationCycles: number;
    validationEnabledCounts: GLResourceCounts[];
    validationDisabledCounts: GLResourceCounts[];
    /** Counts on that same tracker after `dispose()` — must be all zeros. */
    validationAfterDispose: GLResourceCounts;
  };
  /**
   * Construction-failure accounting: force `createColorTarget` to fail and report the tracker
   * before/after each attempt, so unbalanced decrements are visible.
   */
  colorTargetFailureProbe(): {
    probes: Array<{
      label: string;
      /** The constructor's error message, or null when the target was constructed successfully. */
      message: string | null;
      before: GLResourceCounts;
      after: GLResourceCounts;
    }>;
    /** Counts on the probe's fresh tracker after every probe — must be all zeros. */
    final: GLResourceCounts;
  };
  /** §6.4/§7.1 live Phase-2 probe: the curator's current phase (§3.4 `PhaseState`). */
  curatorPhase(): PhaseState;
  /**
   * §7.1/§3.4: the tier-1 chemistry health the director last consumed, in the published shape, or
   * null before the first completed readback.
   */
  chemistryHealth(): AnalysisState['chemistryHealth'] | null;
  /** §7.1 tier-2 presentation descriptors (envelope-weighted), whether or not the tier is valid. */
  presentationAnalysis(): AnalysisState['presentation'];
  /** §3.4 the latest recognized event (serial-numbered). */
  events(): EventState;
  /** §3.4 the bounded retained event log. */
  eventLog(): EventState[];
  /** §8 the truthful audio status (suspended/unlocked/running/unavailable) and mute state. */
  audioStatus(): { status: string; unlocked: boolean; muted: boolean; available: boolean };
  /** §8.3 the live silence acknowledgement the curator reads each tick. */
  silenceStatus(): { satisfied: boolean; terminalZeroAt: number | null };
  /** §8.3 verification-only: issue the stillness silence override directly. */
  prepareSilence(): void;
  /** §10 verification-only: drive the mute command surface directly. */
  setMuted(value: boolean): void;
  /** §2.3 verification-only: unlock audio without requesting fullscreen. */
  audioUnlock(): Promise<void>;
  /** §8.3/§10 verification-only: how many audio tracks the recorder's MediaStream destination carries. */
  audioRecordingTrackCount(): number;
  /**
   * §4.4 verification-only: the live sound substream (root seed, noise/IR/grain seeds and a material
   * checksum) so a restart's deterministic reseed can be asserted.
   */
  audioSoundSignature(): {
    root: number;
    noise: number;
    ir: number;
    grains: number;
    checksum: number;
  } | null;
  /** §8.2 graph instrumentation (bounded node/voice counts) + the silence state machine. */
  audioStats(): {
    nodes: {
      nodeCreated: number;
      nodeStopped: number;
      liveNodes: number;
      grainsStarted: number;
      eventsFired: number;
      maxLiveNodes: number;
    };
    phase: string;
    quietSeconds: number;
    eventsSkipped: number;
    terminalZeroAt: number | null;
    armed: boolean;
    masterGain: number;
  } | null;
  /** §12.3 AC.12: render a deterministic offline scenario and return its measurements. */
  audioOfflineProbe(options: {
    scenario: OfflineScenarioName;
    seconds?: number;
    tickHz?: number;
    render?: boolean;
    /** §4.4 recorded root seed whose `sound` substream to render (MAJOR 3 determinism). */
    rootSeed?: number;
  }): Promise<OfflineMeasurements>;
  /** §9.2 the director's horizon state machine (state / usedThisArc / moments). */
  horizonState(): { state: 'idle' | 'engaged' | 'returned'; usedThisArc: boolean; moments: number };
  /** §7.1 presentation-worker client statistics (pool, statuses, terminations, skips). */
  presenterStats(): {
    requests: number;
    results: number;
    stale: number;
    errors: number;
    skips: number;
    terminations: number;
    ignored: number;
    slots: number;
    free: number;
  };
  /** §7.1/§9.1: coarse full-domain occupancy (16x16) used for framing; null before the first sample. */
  coarseOccupancy(): { size: number; occupiedFraction: number; centroidUV: [number, number] } | null;
  /** §12.2: provenance of the active composition document. */
  trajectoryInfo(): { source: TrajectorySource; error: string | null; id: string; movements: string[] };
  /**
   * §6.3/§6.4 (MAJOR 1): curator provenance — arc, movement, stillness state, the per-arc rescue
   * budget, the last genesis origin and the stillness timeline. A fresh curator resets all of them.
   */
  curatorState(): {
    arc: number;
    movement: string;
    stillState: PhaseState['stillnessState'];
    rescueUsed: boolean;
    genesisOrigin: [number, number] | null;
    timeline: {
      killWaitEnteredAt: number | null;
      chemistryConfirmedAt: number | null;
      audioZeroAt: number | null;
      blackHoldStartedAt: number | null;
      blackHoldCompletedAt: number | null;
      genesisAt: number | null;
    };
  };
  /** MAJOR 1: the genesis commands applied since the last restart / resolution switch. */
  genesisLog(): GenesisCommand[];
  /**
   * §6.4 MAJOR 3: every premature-extinction decision since the last restart / resolution switch —
   * the movement and intention that went extinct, the tier-1 health read, the dead-duration
   * accumulator that triggered the decision, and the action taken (rescue / recovery / none).
   */
  extinctionLog(): ExtinctionDecision[];
  /**
   * MAJOR 1/3: advance the automatic composition synchronously by `steps` delivered steps (no
   * render), exactly as the frame loop would, and **account those steps to the clock** so the clock's
   * delivered-step and delivered-time counters are the exact mark the caller drove to. The solver's
   * own step/time counters are *since the last field replacement* (`Simulation.seed` resets them on a
   * `replace` genesis), so they are not a cumulative mark; the clock is.
   */
  advanceComposition(steps: number): { steps: number; phase: PhaseState; epoch: number; simulationTime: number };
  /**
   * MINOR 3: advance a batch and record, per step, whether the analysis view handed to the curator
   * carried valid chemistry health, injecting one field replacement before step `replaceAfterStep`.
   */
  advanceCompositionTraced(
    steps: number,
    replaceAfterStep: number,
  ): { trace: boolean[]; epoch: number; healthValid: boolean };
  /** MAJOR 2: the director's bounded per-arc light-azimuth target (radians) currently in force. */
  directorAzimuthTarget(): number;
  /** MAJOR 3: publication and analysis-request counts with both clocks (cadence evidence). */
  cadenceCounters(): { publications: number; analysisRequests: number; realSeconds: number; performanceSeconds: number };
  /** MAJOR 5/A: analyzer diagnostics (float format, drops, saturation). */
  analysisDiagnostics(): {
    floatFormat: 'RGBA32F' | 'RGBA16F';
    requests: number;
    samples: number;
    staleDrops: number;
    nullFenceDrops: number;
    packSaturatedSamples: number;
    packSaturated: boolean;
  };
  /** MAJOR 5: issue one tier-1 sample now and return its raw decoded values (fixture hook). */
  analysisSampleForTest(timeoutMs?: number): Promise<{
    epoch: number;
    occupiedFraction: number;
    flux: number;
    change: number;
    packSaturated: boolean;
  } | null>;
  /** MAJOR 2/Minor A: issue a tier-1 request without polling; returns whether it was accepted. */
  requestAnalysisOnly(): boolean;
  /** §7.1/AC.11 verification-only: force the next completed fence to be treated as WAIT_FAILED. */
  analyzerSimulateWaitFailed(value: boolean): void;
  /** §7.1/AC.10: issue one sample and read both tiers directly from the combined buffer (no worker). */
  reductionSampleForTest(timeoutMs?: number): Promise<{
    epoch: number;
    health: { occupiedFraction: number; flux: number; change: number };
    presentation: { meanU: number; meanV: number; occupancy: number; activity: number };
  } | null>;
  /**
   * §7.1/§7.3 end-to-end fixture hook: feed `samples` real presentation samples through the **full**
   * worker path (analyzer readback → pooled combined buffer → `PresentationWorker` → topology/event
   * tier) — the same path `pollAnalysis` drives in the frame loop — and return the app's event serial
   * and the last published tier-2 topology state, so a browser spec can assert (rather than infer)
   * that a sub-threshold field never retains a component and never fires a salient event.
   */
  presentationEventProbeForTest(samples: number, timeoutMs?: number): Promise<{
    requested: number;
    completed: number;
    eventSerialBefore: number;
    eventSerialAfter: number;
    eventKinds: string[];
    descriptors: {
      occupiedFraction: number;
      meanV: number;
      beta0Approx: number;
      beta1Approx: number;
      largestComponentFraction: number;
      topologyConfidence: number;
      persistenceSeconds: number;
    } | null;
    tier1OccupiedFraction: number;
  }>;
  /** §7.1/AC.11: run `iterations` request/poll cycles and report the retained-buffer balance. */
  analyzerRingProbe(iterations: number): Promise<{
    iterations: number;
    requests: number;
    samples: number;
    buffersBefore: number;
    buffersAfter: number;
    diagnostics: {
      floatFormat: 'RGBA32F' | 'RGBA16F';
      requests: number;
      samples: number;
      staleDrops: number;
      nullFenceDrops: number;
      packSaturatedSamples: number;
      packSaturated: boolean;
    };
  }>;
  /**
   * MAJOR 2: issue a request, then advance the analyzer's accepted epoch without clearing the slot
   * (the exact race the poll-time guard defends) and report whether the completed-but-stale sample was
   * discarded rather than returned.
   */
  analysisPollGuardProbe(): Promise<{ ok: boolean; reason?: string; discarded: boolean; staleDrops: number }>;
  /** MAJOR 7: explicit unpin for each field, so a released override resumes under the director. */
  unpinCamera(): void;
  unpinLight(): void;
  unpinMaterial(): void;
  cameraPins(): { camera: boolean; light: boolean };
  /** §3.3 `AppControl.exportTrajectory`. */
  exportTrajectory(): string;
  /** §12.2 import path; returns a reason rather than throwing so the lab can surface it. */
  loadTrajectoryDocument(text: string): { ok: boolean; reason?: string };
  diagnostics(): Diagnostics;
  /** Drained-frame throughput benchmark: renders `count` frames of `stepsPerFrame` steps each. */
  benchmarkFrames(count: number, stepsPerFrame: number): {
    canvas: string;
    scene: string;
    count: number;
    stepsPerFrame: number;
    totalMs: number;
    msPerFrame: number;
    impliedFps: number;
  };
  capturePngBase64(): Promise<string>;
  startRecording(): Promise<{ mimeType: string }>;
  stopRecordingBase64(): Promise<{ base64: string; mimeType: string; bytes: number }>;
}

const PARAM_RELEASE_SECONDS = 15;

export class App {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly report: CapabilityReport;
  readonly tracker = new ResourceTracker();
  /**
   * Re-created when the lab toggles §10 exploration mode: a different simulation grid needs a new
   * `Simulation`, renderer targets at that grid, and a clock carrying that resolution's measured
   * steps/frame cap.
   */
  simulation: Simulation;
  renderer: Renderer;
  clock: FixedStepClock;

  private readonly store: SnapshotWorldStore;
  /** §10 bounded exploration mode: the lab-only coarser grid. Off is the presentation default. */
  private explorationActive = false;
  /** Active simulation grid edge in cells (768 presentation, 512 exploration). */
  private simulationResolution: number;

  /**
   * Phase-2 composition. The curator owns movement/trajectory progress and is advanced once per
   * *delivered simulation step* (§4.1), so trajectory parameters are evaluated at each step's
   * performance time rather than stair-stepped once per frame.
   */
  private curator: Curator;
  /** The document the active curator was built from (for trajectory export). */
  private trajectory: TrajectoryDocument;
  private trajectorySource: TrajectorySource = 'bundled';
  private trajectoryError: string | null = null;
  /** Latest parameters the curator produced; the lab's manual override still takes precedence. */
  private curatorParameters: Params;
  /** §7.1 tier-1 analysis: full-domain chemistry health + coarse bounds, at ~2 Hz performance time. */
  private analyzer: Analyzer;
  private health: ChemistryHealthSample | null = null;
  private coarse: CoarseField | null = null;
  /**
   * §3.3/§7.1 the presentation-tier worker client (§7.1 combined-sample slot pool + worker). Tier-2
   * descriptors arrive asynchronously; both tiers carry their own validity.
   */
  private presenter: PresentationWorker;
  private presentation: PresentationDescriptors | null = null;
  private presentationEpoch = -1;
  private presentationPerformanceSeconds = 0;
  /** §3.3/§7.1 real seconds the presentation worker has been busy (0 = idle); bounds a stall. */
  private presenterBusySince: number | null = null;
  /** §3.4 monotonic event serial assigned by the app (the worker returns an event candidate). */
  private eventSerial = 0;
  /** Bounded retained event log for the laboratory readout. */
  private readonly eventLog: EventState[] = [];
  private static readonly EVENT_LOG_LIMIT = 64;
  /** Accumulators in delivered *performance* time; the real-time ceilings bound the observed rate. */
  private analysisPerfAccumulator = 0;
  private realSinceAnalysisRequest = 0;
  private analysisRequests = 0;
  /** True when the last completed sample had to clamp the presentation packing (diagnostic). */
  private analysisPackSaturated = false;
  /** §9.1/§9.3 camera + light policy. */
  private readonly director: VisualDirector;
  private worldState: WorldState;

  private camera: CameraState;
  private light: LightState;
  private material: MaterialState;
  private phase: PhaseState;
  private events: EventState;
  private neutralAnalysis = neutralAnalysisState();

  private baseParams: Params;
  private overrideParams: Params | null = null;
  private blend: { from: Params; to: Params; elapsed: number } | null = null;

  private rootSeed: number;
  private performanceSeed: number;
  private rng: Rng;

  private lab: Lab;
  private diagnostics: Diagnostics;
  private frameRing = new FrameTimeRing(240);
  private simulationMsEma = 0;
  private renderMsEma = 0;
  private overloaded = false;
  private windowSeconds = 0;
  private windowSteps = 0;
  private windowFrames = 0;
  private deliveredStepsPerSecond = 0;
  private deliveredFps = 0;
  private emaFrameMs = 16.7;

  private autoSeedEnabled = true;
  private publishPerfAccumulator = 0;
  private realSincePublish = 0;
  private publications = 0;
  /** Bounded ring of the genesis commands this app has applied, for provenance/tests. */
  private readonly genesisLog: GenesisCommand[] = [];
  /** Cap on the retained genesis log. */
  private static readonly GENESIS_LOG_LIMIT = 128;
  /**
   * §6.4 premature-extinction decision telemetry drained from the curator: why each rescue or early
   * recovery fired (movement, intention, health, dead-duration accumulator, action). Retained so the
   * arc evidence can report the *cause* of an injection, not only that a command appeared.
   */
  private readonly extinctionLog: ExtinctionDecision[] = [];
  /** Cap on the retained extinction-decision log. */
  private static readonly EXTINCTION_LOG_LIMIT = 256;

  private running = false;
  private disposed = false;
  private rafHandle = 0;
  private lastTime = 0;
  private userPaused = false;

  private cursorTimer = 0;
  private activationStatus = 'not activated (click or press Enter for fullscreen)';
  private recording: CanvasRecording | null = null;
  /** §3.3/§8 the generative ambient audio system (constructed suspended; unlocked by a gesture). */
  private readonly audio: AudioSystem;
  /** §6.4/§8.3: the previous stillness state, so `prepareSilence()` fires exactly once per episode. */
  private lastStillnessState: PhaseState['stillnessState'] = 'none';
  private diagnosticsView: LabSnapshot['diagnosticsView'] = 'none';
  // §10 laboratory-only diagnostic overlay state (never on the presentation path).
  private readonly diagnosticBuffer = new Uint8Array(PRESENTATION.width * PRESENTATION.height * 4);
  private diagnosticImageCache: { width: number; height: number; pixels: Uint8ClampedArray } | null = null;
  private diagnosticImageAt = Number.NEGATIVE_INFINITY;
  private diagnosticTopology: TopologyAnalyzer | null = null;
  /** The verification hook this instance installed, if any (see `dispose`). */
  private installedHook: ArtworkTestHook | null = null;

  constructor(options: AppOptions) {
    this.canvas = options.canvas;
    const context = createContext(this.canvas);
    this.gl = context.gl;
    this.report = context.report;

    const grid = options.simulationGrid ?? SIMULATION_GRID;
    this.simulationResolution = grid.width;

    this.simulation = new Simulation({
      gl: this.gl,
      tracker: this.tracker,
      width: grid.width,
      height: grid.height,
      dt: TIME.dt,
    });

    this.canvas.width = Math.max(2, this.canvas.width || 1280);
    this.canvas.height = Math.max(2, this.canvas.height || 720);
    this.renderer = new Renderer({
      gl: this.gl,
      tracker: this.tracker,
      canvas: this.canvas,
      simulationWidth: grid.width,
      simulationHeight: grid.height,
      width: this.canvas.width,
      height: this.canvas.height,
    });

    this.clock = new FixedStepClock({
      dt: TIME.dt,
      nominalStepsPerSecond: TIME.nominalStepsPerSecond,
      maxStepsPerFrame: TIME.maxStepsPerFrame,
      realDeltaBoundSeconds: TIME.realDeltaBoundSeconds,
      debtBoundSeconds: TIME.debtBoundSeconds,
      // §4.1/§10 (deviation 44): the presentation default is 3× (operator showcase pacing). The lab
      // slider still owns the full 0.25–6× range, and a resolution switch preserves the live speed.
      speed: TIME.defaultSpeed,
    });

    this.director = new VisualDirector();
    this.analyzer = new Analyzer({
      gl: this.gl,
      tracker: this.tracker,
      width: grid.width,
      height: grid.height,
      epoch: this.simulation.epoch,
    });
    // §3.3 module worker (Vite classic `new Worker(new URL(...), {type:'module'})`), with the §7.1
    // combined-sample slot layout the analyzer just resolved.
    this.presenter = new PresentationWorker({
      createWorker: () => new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
      width: PRESENTATION.width,
      height: PRESENTATION.height,
      healthOffset: HEALTH_OFFSET,
      healthFormat: this.analyzer.floatFormat,
      slotBytes: this.analyzer.slotBytes,
      epoch: this.simulation.epoch,
    });

    const targets = this.director.targets;
    this.camera = targets.camera;
    this.light = targets.light;
    // The live initial material state is the single source of truth for composition: exposure and
    // bloom gain come from the same config constants the calibration measured. A hardcoded literal
    // here previously made the rendered image disagree with what the gate metadata reported.
    this.material = targets.material;
    this.phase = neutralPhaseState();
    this.events = neutralEventState();
    this.baseParams = { ...DEFAULT_PARAMS };

    this.rootSeed = randomRootSeed();
    this.performanceSeed = this.rootSeed;
    this.rng = new Rng(this.rootSeed);
    // §2.3/§8: the audio system is constructed suspended (before the gesture) so the laboratory can
    // report its state truthfully; `activate()` resumes it. A machine without an `AudioContext` or an
    // output device degrades to a truthful `unavailable` state rather than failing the artwork. The
    // recorded root seed is passed here so the §4.4 `sound` substream is derived from the performance's
    // seed (MAJOR 3); `restart()`/`applyResolution()` reseed it.
    this.audio = new AudioSystem({ rootSeed: this.rootSeed });
    // §12.2/§6.4: the active composition document and its curator are built once the root seed
    // exists, so the curator's movement RNG is derived from the same seed.
    this.trajectory = validateTrajectoryDocument(bundledTrajectory);
    this.curator = new Curator(this.trajectory, { rootSeed: this.rootSeed });
    this.curatorParameters = this.curator.parameters;
    this.diagnostics = {
      frameTimesMs: [],
      simulationMsAvg: 0,
      renderMsAvg: 0,
      qualityTier: 0,
      overload: false,
      rendererInfo: this.report.renderer,
      softwareRenderer: this.report.softwareRenderer,
      simStepsPerSecond: 0,
      deliveredFps: 0,
      desiredStepsPerSecond: TIME.nominalStepsPerSecond,
      analysisBacklog: 0,
    };

    this.worldState = this.storeInitialWorld();
    this.store = new SnapshotWorldStore(this.worldState);
    this.worldState = this.store.publish({
      epoch: this.simulation.epoch,
      performanceSeed: this.performanceSeed,
      clock: this.clock.state(),
      phase: this.phase,
      parameters: this.baseParams,
      analysis: this.neutralAnalysis,
      event: this.events,
      health: { qualityTier: 0, overload: false, audioUnlocked: this.audio.audioUnlocked() },
      visualTargets: { camera: this.camera, light: this.light, material: this.material },
    });
    this.lab = new Lab(this.labApi());
  }

  /**
   * §12.2 bootstrap: load `public/trajectories/default.json` as the active document.
   *
   * The bundled copy is already in use before this runs — the constructor builds the curator from it
   * — so the first frames are composed even if the fetch is slow, hanging or refused; a successful
   * fetch replaces it live through the §6.4 `load-trajectory` crossfade (picked up on reload if the
   * file is edited) **without touching the field or the epoch**, and a failure is surfaced in the
   * laboratory rather than swallowed (deviation 39). This runs *after* `init()` has started the app,
   * and a completion that lands after `dispose()` is dropped so it cannot write to a dead instance.
   */
  private async bootstrapTrajectory(): Promise<void> {
    try {
      const response = await fetch('trajectories/default.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const document = parseTrajectoryDocument(await response.text());
      if (this.disposed) return; // late completion after teardown: no post-dispose writes
      this.applyTrajectory(document, 'fetched');
      console.info('[artwork] trajectory loaded from public/trajectories/default.json');
    } catch (error) {
      if (this.disposed) return;
      this.trajectoryError = `trajectory fetch failed (${String(error)}); using the bundled copy`;
      console.warn('[artwork]', this.trajectoryError);
    }
  }

  /**
   * §2.3/§12.2 startup. Everything the first frame needs happens synchronously: the bundled document
   * is already the active composition (its curator is built in the constructor), so canvas sizing,
   * input handlers, the verification hook, capability reporting and `start()` are never gated on the
   * network (MAJOR 1). The `trajectories/default.json` fetch is fired *afterwards* and runs in the
   * background, so a slow or hanging response can no longer leave the artwork black and unstarted.
   */
  async init(): Promise<void> {
    this.applyCanvasSize();
    this.installInputHandlers();
    this.installTestHook();
    // Report capabilities before the first frame so the operator sees them immediately.
    console.info('[artwork] renderer:', this.report.renderer);
    console.info('[artwork] software renderer:', this.report.softwareRenderer);
    console.info(
      '[artwork] formats:',
      this.report.formats
        .map((format) => `${format.name}=${format.complete ? 'complete' : format.status}${format.attachment === 'color' ? (format.writeVerified ? '/write-ok' : '/write-FAILED') : ''}`)
        .join(' '),
    );
    console.info('[artwork] problems:', this.report.problems.length === 0 ? 'none' : this.report.problems.join('; '));
    if (this.report.softwareRenderer) {
      console.warn(
        '[artwork] running on a software rasteriser; correctness is still exercised but target-GPU performance and final material appearance are not.',
      );
    }
    this.start();
    // §12.2 bootstrap runs in the background: the bundled document is already live, so a slow or
    // hanging fetch can never delay the first frame (deviation 39).
    void this.bootstrapTrajectory();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = 0;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.lab.dispose();
    this.removeInputHandlers();
    this.renderer.dispose();
    this.simulation.dispose();
    // §7.1: the tier-1 analyzer owns its reduction targets, programs, quad and pixel-pack-buffer ring.
    this.analyzer.dispose();
    // §3.3: terminate the presentation worker (its pooled buffers go with it).
    this.presenter.dispose();
    // §8: stop the audio scheduler, tear down the graph and close the context.
    this.audio.dispose();
    // Only remove the verification hook if this instance installed it: a throwaway instance used
    // by the resource-lifecycle check must not uninstall the live page's hook.
    const scope = window as unknown as { __artwork?: ArtworkTestHook };
    if (this.installedHook && scope.__artwork === this.installedHook) {
      delete scope.__artwork;
    }
    this.installedHook = null;
  }

  /** §2.3: one explicit gesture resumes audio and requests fullscreen; silence still works. */
  async activate(): Promise<void> {
    let fullscreen = false;
    let note = '';
    try {
      if (!document.fullscreenElement) {
        await this.canvas.requestFullscreen({ navigationUI: 'hide' });
      }
      fullscreen = true;
    } catch (error) {
      note = `fullscreen request denied (${String(error)})`;
    }
    // §2.3/§8.3: the same gesture unlocks audio. The status is reported truthfully — including when
    // the context cannot run on this machine — rather than claiming sound that does not exist.
    await this.audio.unlock();
    const audio = this.audio.status();
    this.activationStatus =
      `${fullscreen ? 'activated; fullscreen granted' : `activated; fullscreen not granted: ${note}`}; ` +
      `audio: ${audio}${audio === 'running' ? '' : ' (click again after granting audio permission)'}`;
    this.applyCanvasSize();
  }

  /** Apply a validated command at the next update boundary. */
  dispatch(command: AppCommand): { ok: boolean; reason?: string } {
    // Speed is validated against the *active* resolution's range, so §10 exploration mode can use the
    // higher ceiling it measured without widening the presentation range.
    const validation = validateCommand(command, { speedRange: this.activeSpeedPolicy().speedRange });
    if (!validation.ok) return validation;
    switch (command.type) {
      case 'restart':
        this.restart(command.seed);
        break;
      case 'exploration':
        this.setExplorationMode(command.value);
        break;
      case 'skip-movement':
        // §6.4/§10: laboratory skip. The curator crossfades parameters over the skip window without
        // touching chemistry, so the field keeps evolving through the change.
        this.curator.command({ type: 'skip-movement' });
        break;
      case 'load-trajectory':
        this.applyTrajectory(command.document, 'imported');
        break;
      case 'reseed':
        this.applyGenesis(command.genesis);
        break;
      case 'pause':
        this.userPaused = command.value;
        this.clock.setPaused(command.value);
        // §8.3: pause smoothly mutes audio (and resume brings it back without a backlog).
        this.audio.setTransport(this.userPaused || document.hidden);
        break;
      case 'speed':
        this.clock.setSpeed(command.value);
        break;
      case 'parameters':
        if (command.mode === 'override') {
          const check = validateParameters(command.value);
          if (!check.ok) return check;
          this.overrideParams = command.value;
          this.baseParams = command.value;
        } else {
          const from = this.effectiveParameters();
          this.overrideParams = null;
          this.blend = { from, to: this.baseParams, elapsed: 0 };
        }
        break;
      case 'camera':
        this.applyCameraOverride(command.value);
        break;
      case 'diagnostics':
        // Phase 1 accepts and records the requested view; overlay rendering arrives with the
        // analysis tier in Phase 3, so nothing is faked here.
        this.diagnosticsView = command.view;
        this.diagnosticImageCache = null; // a view change invalidates the throttled overlay image
        break;
      case 'mute':
        // §8.3/§10: the laboratory mute — a smooth mute of the master path.
        this.audio.setMuted(command.value);
        break;
      default:
        break;
    }
    return { ok: true };
  }

  /** Explicit genesis for tests and the laboratory. Routes through the genesis surface (MAJOR 2). */
  applyGenesis(command: GenesisCommand): void {
    this.seedField(command);
  }

  capture(): Promise<CaptureResult> {
    return this.renderer.capture().then((blob) => ({
      blob,
      filename: `organism-${Date.now()}.png`,
    }));
  }

  async startRecording(): Promise<{ mimeType: string }> {
    if (this.recording) return { mimeType: this.recording.mimeType };
    // §8.3/§10: mux the audio system's MediaStream destination into the canvas recording, so the
    // recorded WebM carries the generative soundtrack alongside the image. Only a *running* context
    // contributes a track; a suspended/unavailable one leaves the recording video-only.
    const audioTracks = this.audio.audioUnlocked()
      ? this.audio.recordingStream()?.getAudioTracks() ?? []
      : [];
    this.recording = startCanvasRecording(this.canvas, { fps: 30, audioTracks });
    return { mimeType: this.recording.mimeType };
  }

  async stopRecording(): Promise<CaptureResult> {
    const recording = this.recording;
    this.recording = null;
    if (!recording) throw new Error('no recording in progress');
    const blob = await recording.stop();
    return { blob, filename: `organism-${Date.now()}.webm` };
  }

  // ---------------------------------------------------------------- frame

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.frame);
    const realDelta = this.lastTime === 0 ? 0 : Math.max(0, Math.min((now - this.lastTime) / 1000, 0.5));
    this.lastTime = now;

    const allocation = this.clock.advance(realDelta);
    // §4.1/§7.1: cadence is driven by *delivered performance time*, not wall time (MAJOR 3). At 6x a
    // real-time schedule would request three times as much work per real second for no new
    // information; the real-time ceilings below bound the observed rate instead.
    const deliveredPerformanceDelta = allocation.steps / TIME.nominalStepsPerSecond;

    // §4.1: evaluate the trajectory at each delivered step's performance time. The curator is
    // advanced once per delivered step, so movement progress, dwell, the stillness clock and the
    // genesis it issues all advance with delivered numerical work rather than with wall time.
    const simStart = performance.now();
    // MINOR 3: a `replace` genesis inside the batch invalidates the analysis view for the remaining
    // steps (the epoch bumps and health/coarse are cleared), so the batch helper rebuilds it.
    advanceCompositionBatch(
      allocation.steps,
      () => this.simulation.epoch,
      () => this.curatorWorldView(),
      (view) => this.composeStep(view),
    );
    const simMs = performance.now() - simStart;

    this.advanceBlend(realDelta);
    this.updateAudio();
    if (this.autoSeedEnabled) {
      // §7.1/§9.1: the tier-1 analysis and the camera/light director are part of the automatic
      // Phase-2 composition. With automatic composition disabled (the Phase-1 laboratory path, which
      // the gate's deterministic captures use) neither runs, so camera/light stay exactly where the
      // laboratory put them and no analysis readback perturbs the frame.
      this.pollAnalysis(deliveredPerformanceDelta, realDelta);
      this.updateDirector();
    }

    // §4.1: publication is scheduled on delivered performance time at 2 Hz, with an explicit 4 Hz
    // real-time ceiling so acceleration cannot multiply the snapshot rate without bound (MAJOR 3).
    this.publishPerfAccumulator += deliveredPerformanceDelta;
    this.realSincePublish += realDelta;
    if (
      this.publishPerfAccumulator >= 1 / CADENCE.performanceHz &&
      this.realSincePublish >= 1 / CADENCE.realCeilingHz
    ) {
      this.publishPerfAccumulator = 0;
      this.realSincePublish = 0;
      this.publish();
      this.publications += 1;
    }

    const field = this.simulation.fieldWithPrevious();
    const renderStart = performance.now();
    // The 2 Hz snapshot carries the director's targets for consumers, but the renderer is handed the
    // live targets so camera/light motion is smooth at frame rate without a second smoothing layer
    // (§9.1 "snapshot rate must not be visible"). When the director ran this frame it has already
    // written its targets into `this.camera/light/material`; when automatic composition is off the
    // Phase-1 laboratory path owns those fields and the director must not have touched them, so
    // rendering them keeps the frozen gate captures reproducible under camera/light overrides.
    const targets = { camera: this.camera, light: this.light, material: this.material };
    this.worldState = {
      ...this.worldState,
      camera: targets.camera,
      light: targets.light,
      material: targets.material,
    };
    this.renderer.render(field, this.worldState);
    const renderMs = performance.now() - renderStart;

    this.updateDiagnostics(realDelta * 1000, simMs, renderMs, allocation.steps, realDelta);
    this.lab.update(this.worldState, this.diagnostics);
  };

  /**
   * Frame-time statistics are rAF *intervals*, not the duration of the callback: GL work is
   * submitted asynchronously, so callback duration measures command submission only and would
   * report ~0.2 ms while the display runs at 50 fps. §11.1's percentiles are about delivered
   * frame time, which is what the display cadence measures.
   */
  private updateDiagnostics(
    frameMs: number,
    simMs: number,
    renderMs: number,
    steps: number,
    realDelta: number,
  ): void {
    this.frameRing.push(frameMs);
    this.simulationMsEma = this.simulationMsEma * 0.9 + simMs * 0.1;
    this.renderMsEma = this.renderMsEma * 0.9 + renderMs * 0.1;
    this.emaFrameMs = this.emaFrameMs * 0.9 + frameMs * 0.1;
    this.windowSeconds += realDelta;
    this.windowSteps += steps;
    this.windowFrames += 1;
    if (this.windowSeconds >= 1) {
      this.deliveredStepsPerSecond = this.windowSteps / this.windowSeconds;
      this.deliveredFps = this.windowFrames / this.windowSeconds;
      this.windowSeconds = 0;
      this.windowSteps = 0;
      this.windowFrames = 0;
    }

    // §11.1 overload detection is a rolling average; the degradation order itself is later work.
    this.overloaded = this.clock.overloaded || this.emaFrameMs > 33;

    this.diagnostics = {
      frameTimesMs: this.frameRing.snapshot(),
      simulationMsAvg: this.simulationMsEma,
      renderMsAvg: this.renderMsEma,
      qualityTier: 0,
      overload: this.overloaded,
      rendererInfo: this.report.renderer,
      softwareRenderer: this.report.softwareRenderer,
      simStepsPerSecond: this.deliveredStepsPerSecond,
      deliveredFps: this.deliveredFps,
      desiredStepsPerSecond: this.clock.speed * TIME.nominalStepsPerSecond,
      analysisBacklog: this.presenter.busy ? 1 : 0,
    };
  }

  private effectiveParameters(): Params {
    if (this.overrideParams) return this.overrideParams;
    if (this.blend) {
      const t = Math.min(1, this.blend.elapsed / PARAM_RELEASE_SECONDS);
      const eased = t * t * (3 - 2 * t);
      return {
        F: this.blend.from.F + (this.blend.to.F - this.blend.from.F) * eased,
        k: this.blend.from.k + (this.blend.to.k - this.blend.from.k) * eased,
        Du: this.blend.from.Du + (this.blend.to.Du - this.blend.from.Du) * eased,
        Dv: this.blend.from.Dv + (this.blend.to.Dv - this.blend.from.Dv) * eased,
      };
    }
    // §6.3: with no manual override in force the curator's trajectory decides the parameters.
    return this.curatorParameters;
  }

  private advanceBlend(realDelta: number): void {
    if (!this.blend) return;
    this.blend.elapsed += realDelta;
    if (this.blend.elapsed >= PARAM_RELEASE_SECONDS) this.blend = null;
  }

  /**
   * §3.3/§6.4/§8.3 audio handshake, once per frame.
   *
   * Stores the live world snapshot (with the current stillness state) for the scheduler, and issues
   * `AudioSystem.prepareSilence()` **exactly once** on entry to `kill-wait`, so the terminally bounded
   * fade starts on the entry rather than on the general 8 s chemistry threshold. The episode-scoped
   * re-arm lives inside the audio engine (it clears its acknowledgement when it observes `none`).
   */
  private updateAudio(): void {
    // Consume the live clock (not the 2 Hz published one) so the audio's performance-time mapping is
    // as fresh as the frame, and the current stillness state so the engine can re-arm.
    this.audio.consume({ ...this.curatorWorldView(), clock: this.clock.state(), phase: this.phase });
    const stillness = this.phase.stillnessState;
    if (stillness === 'kill-wait' && this.lastStillnessState !== 'kill-wait') {
      this.audio.prepareSilence();
    }
    this.lastStillnessState = stillness;
  }

  /**
   * §3.3/§6.4/§8.3: the live silence acknowledgement. `AudioSystem.silenceStatus()` is sampled into
   * `CuratorEnvironment.silence` on every tick, so the black-hold gate is driven by the **real**
   * terminal-zero state: `satisfied` only once the master has reached digital zero (or the audio is
   * locked/muted/unavailable, which the plan defines as satisfied with no timestamp).
   */
  private curatorEnvironment(): CuratorEnvironment {
    return { silence: this.audio.silenceStatus() };
  }

  /**
   * §4.1/§7.1 (MAJOR 3): issue an analysis sample at 2 Hz of *delivered performance time* with an
   * explicit 4 Hz real-time ceiling, and collect whatever completed. Both halves stay off the hot
   * path: the GPU ring only renders small passes and adds a fence, the worker decodes the presentation
   * tier off-thread, and `poll` never blocks.
   *
   * The presentation-tier pipeline is one request in flight: a completed GPU readback is written into a
   * pooled combined buffer, its framing/health regions decoded on the main thread, and the buffer
   * transferred to the worker. A completed worker result (matching epoch) becomes the published
   * presentation tier; a recognized event is assigned the app's monotonic serial.
   */
  private pollAnalysis(deliveredPerformanceDelta: number, realDelta: number): void {
    // 1. feed a completed GPU readback to the presentation worker (one in flight; skip otherwise).
    //    While a request is in flight the completed readback waits in its slot (bounded ring), so
    //    normal worker latency costs no samples; a worker that never answers would stall tier-1 too,
    //    so a bounded stall recovers it (§3.3 termination/recovery).
    if (this.presenter.busy) {
      if (this.presenterBusySince === null) this.presenterBusySince = this.clock.realSeconds;
      else if (this.clock.realSeconds - this.presenterBusySince > PRESENTER_STALL_SECONDS) {
        this.presenter.recover();
        this.presenterBusySince = null;
      }
    } else {
      this.presenterBusySince = null;
      const buffer = this.presenter.acquire();
      if (buffer) {
        const sample = this.analyzer.poll(new Uint8Array(buffer));
        if (sample && sample.stamp.epoch === this.simulation.epoch) {
          this.health = sample.health;
          this.coarse = sample.coarse;
          this.analysisPackSaturated = sample.packSaturated;
          this.presenter.submit(sample.stamp, buffer);
        } else {
          this.presenter.release(buffer);
        }
      }
    }

    // 2. collect a completed worker result and publish the presentation tier.
    const result = this.presenter.poll();
    if (result && result.status === 'ok' && result.descriptors && result.epoch === this.simulation.epoch) {
      this.presentation = result.descriptors.presentation;
      this.presentationEpoch = result.epoch;
      this.presentationPerformanceSeconds = result.stamp.performanceSeconds;
      if (result.event) this.publishEvent(result.event);
    }

    // 3. request the next sample at the cadence.
    this.analysisPerfAccumulator += deliveredPerformanceDelta;
    this.realSinceAnalysisRequest += realDelta;
    if (
      this.analysisPerfAccumulator >= 1 / CADENCE.performanceHz &&
      this.realSinceAnalysisRequest >= 1 / CADENCE.realCeilingHz
    ) {
      this.analysisPerfAccumulator = 0;
      this.realSinceAnalysisRequest = 0;
      const issued = this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp());
      if (issued) this.analysisRequests += 1;
    }
  }

  /** §3.4: record a recognized event with a fresh monotonic serial and keep a bounded log. */
  private publishEvent(event: AnalysisEvent): void {
    this.eventSerial += 1;
    this.events = {
      serial: this.eventSerial,
      kind: event.kind,
      strength: event.strength,
      atPerformanceSeconds: event.atPerformanceSeconds,
    };
    this.eventLog.push(this.events);
    if (this.eventLog.length > App.EVENT_LOG_LIMIT) this.eventLog.shift();
  }

  /** §3.3 `SampleStamp`: full provenance carried through the analyzer slot. */
  private buildSampleStamp(): SampleStamp {
    return {
      epoch: this.simulation.epoch,
      step: this.simulation.steps,
      simulationTime: this.simulation.numericalTime,
      performanceSeconds: this.clock.performanceSeconds,
      parameters: this.effectiveParameters(),
    };
  }

  /** §9.1/§9.3: update camera/light targets for this frame. */
  private updateDirector(): void {
    const targets = this.director.derive({
      analysis: this.analysisStateAt(this.clock.performanceSeconds),
      coarse: this.coarse,
      phase: this.phase,
      latestEvent: this.events,
      clock: {
        performanceSeconds: this.clock.performanceSeconds,
        realSeconds: this.clock.realSeconds,
        speed: this.clock.speed,
      },
      performanceSeed: this.performanceSeed,
      arc: this.phase.arc,
      health: { qualityTier: 0, overload: this.overloaded, audioUnlocked: this.audio.audioUnlocked() },
    });
    this.camera = targets.camera;
    this.light = targets.light;
    this.material = targets.material;
  }

  /**
   * §3.4: the tier-1 health record is live in Phase 2; the presentation tier stays explicitly
   * invalid until Phase 3 analysis exists. `ageSeconds` is **recomputed against the current
   * performance time at consumption** (MAJOR 3) rather than read from the last published snapshot, so
   * a sample cannot appear fresh for longer than it is: between publications the age keeps growing.
   */
  private analysisStateAt(atPerformanceSeconds: number): AnalysisState {
    const health = this.health;
    const presentation = this.presentation;
    const presentationValid = presentation !== null && this.presentationEpoch === this.simulation.epoch;
    return {
      ...this.neutralAnalysis,
      samplePerformanceSeconds: health ? health.performanceSeconds : 0,
      sampleSimulationTime: health ? health.simulationTime : 0,
      chemistryHealth: health
        ? {
            valid: true,
            ageSeconds: Math.max(0, atPerformanceSeconds - health.performanceSeconds),
            fullOccupiedFraction: health.fullOccupiedFraction,
            fullReactionActivity: health.fullReactionActivity,
            fullChangeRate: health.fullChangeRate,
          }
        : { ...this.neutralAnalysis.chemistryHealth },
      presentation:
        presentation !== null && presentationValid
          ? {
              valid: true,
              ageSeconds: Math.max(0, atPerformanceSeconds - this.presentationPerformanceSeconds),
              ...presentation,
            }
          : { ...this.neutralAnalysis.presentation },
    };
  }

  /** Published analysis state, measured against the clock at the moment of publication. */
  private analysisState(): AnalysisState {
    return this.analysisStateAt(this.clock.performanceSeconds);
  }

  /**
   * The per-frame `WorldState` the curator reads. The analysis ages are refreshed against the current
   * performance time (MAJOR 3) so the curator's freshness gate is exact rather than frozen at the last
   * publication.
   */
  private curatorWorldView(): WorldState {
    return { ...this.worldState, analysis: this.analysisStateAt(this.clock.performanceSeconds) };
  }

  /**
   * One delivered composition step (§4.1/§6.4): advance the curator by one step's performance time,
   * apply any genesis it issues, then step the chemistry at whatever parameters are in force. With
   * automatic composition disabled it is exactly the Phase-1 manual step.
   */
  private composeStep(view: WorldState): void {
    if (!this.autoSeedEnabled) {
      this.simulation.step(this.effectiveParameters(), TIME.dt);
      return;
    }
    const output = this.curator.advance(1 / TIME.nominalStepsPerSecond, this.curatorEnvironment(), view);
    this.phase = output.phase;
    this.curatorParameters = output.parameters;
    // §6.4: drain any extinction-decision telemetry the tick produced into the app's retained log, so
    // the arc evidence can report why a rescue or early recovery fired.
    for (const decision of this.curator.drainExtinctionLog()) {
      this.extinctionLog.push(decision);
      if (this.extinctionLog.length > App.EXTINCTION_LOG_LIMIT) this.extinctionLog.shift();
    }
    // §6.4: genesis commands (movement entries, rescues, hard clears, rebirth) reach the solver through
    // the same surface as a laboratory reseed; a `replace` bumps the field epoch.
    for (const command of output.genesis) this.seedField(command);
    this.simulation.step(this.effectiveParameters(), TIME.dt); // §4.1: never enlarge dt to catch up
  }

  /**
   * The single genesis surface (MAJOR 2). Every path that applies a genesis command goes through here
   * so that a `replace` — which bumps the field epoch — also resets the analyzer and clears the
   * health/coarse state; an `inject` leaves the field in place and needs no reset.
   */
  private seedField(command: GenesisCommand): void {
    this.simulation.seed(command);
    this.genesisLog.push(command);
    if (this.genesisLog.length > App.GENESIS_LOG_LIMIT) this.genesisLog.shift();
    if (command.mode === 'replace') this.resetAnalysis(this.simulation.epoch);
  }

  /**
   * Field-replacement cleanup (MAJOR 2): move the analyzer to `epoch`, drop any pending readbacks, and
   * clear the health/coarse state so the director and the stillness gate see "no valid sample" until a
   * fresh-epoch sample completes. Called on every replacement path — manual reseed, curator replace,
   * restart and resolution switch.
   */
  private resetAnalysis(epoch: number): void {
    this.analyzer.reset(epoch);
    this.presenter.reset(epoch);
    this.health = null;
    this.coarse = null;
    this.presentation = null;
    this.presentationEpoch = -1;
    this.presenterBusySince = null;
    this.analysisPackSaturated = false;
    this.analysisPerfAccumulator = 0;
    this.realSinceAnalysisRequest = 0;
  }

  /** Reset both cadence accumulators and their counters (restart/resolution switch). */
  private resetCadence(): void {
    this.publishPerfAccumulator = 0;
    this.realSincePublish = 0;
    this.analysisPerfAccumulator = 0;
    this.realSinceAnalysisRequest = 0;
  }

  /** A brand-new curator over the active document, derived from the current root seed (§6.4). */
  private buildCurator(): Curator {
    return new Curator(this.trajectory, { rootSeed: this.rootSeed });
  }

  /**
   * §6.4/§10 restart (MAJOR 1). A restart starts a **fresh composition arc**: a brand-new `Curator`
   * is constructed from the active document with the (possibly new) root seed, rather than reloading
   * the trajectory into the existing curator. That resets the curator's PRNG substream, arc counter,
   * rescue budget, last genesis origin and stillness timeline, so arc 0 / dormancy and a deterministic
   * command sequence for the seed are guaranteed instead of resuming mid-movement. All sample/history
   * state (health, coarse, cadence accumulators, genesis log) is cleared with the field.
   */
  private restart(seed?: number): void {
    this.rootSeed = seed !== undefined ? seed >>> 0 : randomRootSeed();
    this.performanceSeed = this.rootSeed;
    this.rng = new Rng(this.rootSeed);
    this.simulation.reset();
    this.clock.reset();
    this.frameRing = new FrameTimeRing(240);
    this.overrideParams = null;
    this.blend = null;
    this.phase = neutralPhaseState();
    this.events = neutralEventState();
    this.curator = this.buildCurator();
    this.curatorParameters = this.curator.parameters;
    this.genesisLog.length = 0;
    this.extinctionLog.length = 0;
    // MAJOR 2: the director is re-armed for the new performance explicitly. The clock reset alone is
    // not enough — a restart returns to arc 0, which `derive`'s `arc !== arcSeen` guard treats as
    // already-seen, so without this the new seed would keep the previous performance's light target.
    this.director.restartPerformance(this.performanceSeed, this.phase.arc);
    // §8.3 (MAJOR 1/3): abort the previous audio episode at the audio boundary and reseed the §4.4
    // sound substream from the new root seed. A restart that lands during a `kill-wait` fade can no
    // longer be silenced by the abandoned episode's terminal deadline, and the fresh field's stochastic
    // material is the new seed's. Synchronise the app-side stillness edge too, so the next `kill-wait`
    // entry issues exactly one fresh `prepareSilence()`.
    this.audio.resetPerformance(this.rootSeed);
    this.lastStillnessState = 'none';
    this.resetCadence();
    this.resetAnalysis(this.simulation.epoch);
    this.publish();
  }

  /**
   * §6.4/§10: make `document` the active trajectory. The active curator is told to load it (which
   * crossfades from the current parameters rather than jumping), and the app keeps the document so
   * the laboratory can export it. This is *not* a restart: it changes the composition without
   * replacing the field, so the arc and the chemistry continue (use `restart()` for a fresh arc).
   *
   * §8.3 (MAJOR 1): a `load-trajectory` that replaces the active document with a **different id**
   * aborts the audio episode (as `restart()` does) — the composition has been replaced, so an
   * abandoned episode's terminal fade must not be inherited by the new document's performance. The
   * silent bootstrap that fetches the *same* bundled document (`document.id === this.trajectory.id`)
   * is the intended crossfade and does **not** abort, so the first frames are not disturbed.
   */
  applyTrajectory(document: TrajectoryDocument, source: TrajectorySource): void {
    const replaced = document.id !== this.trajectory.id;
    this.curator.command({ type: 'load-trajectory', document });
    this.trajectory = document;
    this.trajectorySource = source;
    this.trajectoryError = null;
    this.curatorParameters = this.curator.parameters;
    this.phase = neutralPhaseState();
    if (replaced) {
      this.audio.resetPerformance();
      this.lastStillnessState = 'none';
    }
  }

  /** §3.3 `AppControl.exportTrajectory`. */
  exportTrajectory(): string {
    return serializeTrajectoryDocument(this.trajectory);
  }

  /** The measured speed policy for the active simulation grid (§10). */
  activeSpeedPolicy(): ResolutionSpeedPolicy {
    return speedPolicyForResolution(this.simulationResolution);
  }

  get isExploring(): boolean {
    return this.explorationActive;
  }

  get resolution(): number {
    return this.simulationResolution;
  }

  /**
   * §10 bounded exploration mode. On: switch to the coarser lab-only grid (512²), which delivers more
   * numerical steps per frame and therefore supports a higher measured speed ceiling. Off: back to
   * the 768² presentation grid.
   *
   * **Either way the organism restarts**, and the lab says so: the grid changes how many chemical
   * cells exist, and seed radii are specified in cells (§4.2), so continuing an existing field across
   * the change would silently mean something different rather than showing the same organism at a
   * different resolution. The camera and light are left alone — the domain stays 2 world units wide
   * however many cells tile it — and the paused flag is preserved.
   */
  setExplorationMode(enabled: boolean): void {
    if (enabled === this.explorationActive) return;
    this.explorationActive = enabled;
    this.applyResolution(enabled ? EXPLORATION_GRID.width : SIMULATION_GRID.width);
  }

  private applyResolution(resolution: number): void {
    const policy = speedPolicyForResolution(resolution);

    // Replace the field: a new Simulation at the new grid, epoch kept monotonic for cache consumers.
    const previousEpoch = this.simulation.epoch;
    this.simulation.dispose();
    this.simulation = new Simulation({
      gl: this.gl,
      tracker: this.tracker,
      width: policy.resolution,
      height: policy.resolution,
      dt: TIME.dt,
    });
    this.simulation.setEpoch(previousEpoch + 1);
    this.renderer.setSimulationSize(policy.resolution, policy.resolution);

    // A fresh clock carrying this resolution's measured cap; keep paused, clamp the speed.
    const speed = clampSpeed(this.clock.speed, policy.speedRange);
    this.clock = new FixedStepClock({
      dt: TIME.dt,
      nominalStepsPerSecond: TIME.nominalStepsPerSecond,
      maxStepsPerFrame: policy.stepCap,
      realDeltaBoundSeconds: TIME.realDeltaBoundSeconds,
      debtBoundSeconds: TIME.debtBoundSeconds,
    });
    this.clock.setPaused(this.userPaused);
    this.clock.setSpeed(speed);

    // Restart the organism (§10 exploration semantics) and re-arm the automatic genesis. Like
    // `restart()`, this starts a **fresh composition arc** (MAJOR 1): a coarser grid changes how many
    // chemical cells exist and how many steps a frame delivers, but the *performance* — the document,
    // the seed and its policy — is unchanged, so the curator is rebuilt from the **retained** root
    // seed rather than re-randomized. That keeps a 768->512->768 round trip an identical, coherent
    // restart instead of a new performance.
    this.simulationResolution = policy.resolution;
    this.overrideParams = null;
    this.blend = null;
    this.windowSeconds = 0;
    this.windowSteps = 0;
    this.windowFrames = 0;
    this.phase = neutralPhaseState();
    this.events = neutralEventState();
    this.curator = this.buildCurator();
    this.curatorParameters = this.curator.parameters;
    this.genesisLog.length = 0;
    this.extinctionLog.length = 0;
    // MAJOR 2: the same explicit director re-arm as `restart()`, with the *retained* root seed (a grid
    // change is not a new performance) and arc 0.
    this.director.restartPerformance(this.performanceSeed, this.phase.arc);
    // §8.3 (MAJOR 1/3): the resolution switch also restarts the organism, so abort the audio episode and
    // reseed the sound substream from the *retained* root seed (a grid change keeps the performance).
    // The still field starts fresh, so synchronise the app-side stillness edge as in `restart()`.
    this.audio.resetPerformance(this.performanceSeed);
    this.lastStillnessState = 'none';
    this.resetCadence();
    this.resetAnalysis(this.simulation.epoch);
    this.publish();
  }

  private publish(): void {
    const input: WorldInput = {
      epoch: this.simulation.epoch,
      performanceSeed: this.performanceSeed,
      clock: this.clock.state(),
      phase: this.phase,
      parameters: this.effectiveParameters(),
      analysis: this.analysisState(),
      event: this.events,
      health: { qualityTier: 0, overload: this.overloaded, audioUnlocked: this.audio.audioUnlocked() },
      visualTargets: { camera: this.camera, light: this.light, material: this.material },
    };
    this.worldState = this.store.publish(input);
  }

  private storeInitialWorld(): WorldState {
    return {
      version: 1,
      epoch: 0,
      tick: 0,
      performanceSeed: this.performanceSeed,
      clock: this.clock.state(),
      phase: this.phase,
      parameters: this.baseParams,
      analysis: this.neutralAnalysis,
      events: this.events,
      camera: this.camera,
      light: this.light,
      material: this.material,
      health: { qualityTier: 0, overload: false, audioUnlocked: this.audio.audioUnlocked() },
    };
  }

  /**
   * Returning to the Phase-1 manual composition path (`setAutoSeed(false)`): discard the automatic
   * director's accumulated state and restore the calibrated Phase-1 defaults exactly, so the frozen
   * gate captures stay byte-reproducible under the laboratory overrides that follow. Analysis
   * readback stops too — `frame` gates `pollAnalysis`/`updateDirector` on `autoSeedEnabled`.
   *
   * MAJOR 7: the *director's* state is reset in step with the app's, and its time origin is cleared,
   * so re-enabling automatic composition later cannot resume a stale target with a huge accumulated
   * delta (the one-frame jump).
   */
  private restorePhase1VisualState(): void {
    this.director.reset();
    const targets = this.director.targets;
    this.camera = targets.camera;
    this.light = targets.light;
    this.material = targets.material;
  }

  /**
   * §10 camera command (MAJOR 7). The override is routed **through the director** as an explicit pin
   * (or an explicit unpin for `null`) rather than mutated on a local copy the director would overwrite
   * on the next frame. The app's live camera is then synchronized from the director's targets so the
   * Phase-1 manual path (which does not run `derive`) also sees it.
   *
   * **Manual-mode release target (reviewer round 3).** On release (`null`) while automatic composition
   * is OFF, `command(null)` would only clear the pin and leave `this.camera` at the last override —
   * and because nothing runs `derive` on the Phase-1 path, it would stay there indefinitely (a
   * laboratory grazing view would be inherited by the gate's clip/control/candidates and the next
   * regeneration). So the Phase-1 manual path restores the **calibrated** camera explicitly, via
   * `director.resetCamera()` (camera only; light/material handling unchanged). With automatic
   * composition ON the director's next `derive` resumes driving the camera smoothly, which is the
   * documented smooth-resume semantics, so no snap is applied.
   */
  private applyCameraOverride(override: CameraOverride | null): void {
    if (override === null && !this.autoSeedEnabled) {
      this.director.resetCamera();
    } else {
      this.director.command({ type: 'override', value: override });
    }
    this.camera = this.director.targets.camera;
  }

  // --------------------------------------------------------------- resize

  private applyCanvasSize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(2, Math.round(rect.width || window.innerWidth));
    const cssHeight = Math.max(2, Math.round(rect.height || window.innerHeight));
    const requested = cssWidth * cssHeight * dpr * dpr;
    const clamp = Math.min(1, Math.sqrt(SCENE.pixelBudget / requested));
    const width = Math.max(2, Math.floor(cssWidth * dpr * clamp));
    const height = Math.max(2, Math.floor(cssHeight * dpr * clamp));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.renderer.resize(width, height);
  }

  // --------------------------------------------------------------- input

  private installInputHandlers(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('click', this.onCanvasClick);
    document.addEventListener('mousemove', this.onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.onPointerMove();
  }

  private removeInputHandlers(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    document.removeEventListener('mousemove', this.onPointerMove);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.cursorTimer !== 0) window.clearTimeout(this.cursorTimer);
    document.documentElement.classList.remove('cursor-idle');
  }

  private onResize = (): void => {
    this.applyCanvasSize();
  };

  private onCanvasClick = (): void => {
    void this.activate();
  };

  private onPointerMove = (): void => {
    document.documentElement.classList.remove('cursor-idle');
    if (this.cursorTimer !== 0) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => {
      if (!this.lab.isOpen) document.documentElement.classList.add('cursor-idle');
    }, UX.cursorIdleSeconds * 1000);
  };

  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.userPaused = this.clock.paused;
      this.clock.setPaused(true);
      // §8.3: a hidden tab smoothly mutes audio; the visual loop is free to continue.
      this.audio.setTransport(true);
    } else {
      this.clock.setPaused(this.userPaused);
      this.audio.setTransport(this.userPaused);
      this.lastTime = 0; // no catch-up burst after a suspended tab
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const editable =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (event.code === 'Backquote' && !editable) {
      if (event.repeat) return;
      event.preventDefault();
      this.lab.toggle();
      return;
    }
    if (editable) return; // composition-changing hotkeys are ignored while a field has focus
    if (event.code === 'Enter') {
      event.preventDefault();
      void this.activate();
    }
  };

  // --------------------------------------------------------------- lab api

  private labApi(): LabApi {
    return {
      dispatch: (command) => {
        this.dispatch(command);
      },
      reseed: (radiusCells) => {
        const command = createSingleSeedCommand({
          center: [this.rng.range(0.3, 0.7), this.rng.range(0.3, 0.7)],
          seed: this.rng.fork('genesis-manual').nextUint32(),
          perturb: true,
          radiusCells: radiusCells ?? GENESIS.defaultRadiusCells,
          strength: 1,
          mode: 'replace',
        });
        this.applyGenesis(command);
      },
      restart: () => this.restart(),
      capture: () => this.capture(),
      startRecording: () => this.startRecording(),
      stopRecording: () => this.stopRecording(),
      recordingInfo: () => ({
        supported: pickRecordingMimeType().length > 0,
        mimeType: pickRecordingMimeType(),
      }),
      mimeForCapture: () => pickRecordingMimeType(),
      importTrajectory: (text) => {
        try {
          // §12.2/§6.2: validated without evaluation; a rejection leaves the active composition alone.
          this.applyTrajectory(parseTrajectoryDocument(text), 'imported');
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: String(error) };
        }
      },
      exportTrajectoryText: () => this.exportTrajectory(),
      diagnosticImage: () => this.diagnosticImage(),
      snapshot: () => ({
        parameters: this.baseParams,
        effectiveParameters: this.effectiveParameters(),
        overrideActive: this.overrideParams !== null,
        steps: this.simulation.steps,
        epoch: this.simulation.epoch,
        simulationTime: this.simulation.numericalTime,
        performanceSeconds: this.clock.performanceSeconds,
        speed: this.clock.speed,
        paused: this.clock.paused,
        rendererInfo: this.report.renderer,
        resourceCounts: this.tracker.snapshot(),
        activation: this.activationStatus,
        seed: this.rootSeed,
        autoSeed: this.autoSeedEnabled,
        scene: `${this.renderer.sceneDimensions.width}x${this.renderer.sceneDimensions.height}`,
        diagnosticsView: this.diagnosticsView,
        genesisRadiusCells: GENESIS.defaultRadiusCells,
        simulationResolution: this.simulationResolution,
        explorationActive: this.explorationActive,
        speedRange: this.activeSpeedPolicy().speedRange,
        speedCeiling: this.activeSpeedPolicy().speedCeiling,
        // §6.3/§6.4 composition progress (movement/arc readout) and §12.2 document provenance, so the
        // laboratory status surfaces the trajectory source/error the bootstrap records (Fix A).
        phase: {
          arc: this.phase.arc,
          movement: this.phase.movement,
          elapsedSeconds: this.phase.elapsedSeconds,
          progress: this.phase.progress,
          intention: this.phase.intention,
          stillnessState: this.phase.stillnessState,
        },
        trajectory: {
          source: this.trajectorySource,
          error: this.trajectoryError,
          id: this.trajectory.id,
          movements: this.trajectory.movements.map((movement) => movement.id),
        },
        chemistryHealth: this.analysisState().chemistryHealth,
        presentation: this.analysisState().presentation,
        event: { ...this.events },
        eventLog: this.eventLog.map((entry) => ({ ...entry })),
        // §8 audio: the truthful status plus the live silence acknowledgement the curator reads.
        audio: {
          status: this.audio.status(),
          unlocked: this.audio.audioUnlocked(),
          muted: this.audio.isMuted(),
          available: this.audio.available(),
          silence: this.audio.silenceStatus(),
        },
      }),
    };
  }

  // --------------------------------------------------------------- lab overlays (§10)

  /**
   * §10 laboratory-only diagnostic overlay image for the selected view. `analysis` shows the reduced
   * envelope-weighted field, `topology` shows the label/hole proxy map, and `spectrum` shows the four
   * normalized band energies with the characteristic feature scale. The readback is throttled and only
   * runs while the laboratory is open with a view selected; `none`/`camera` return null.
   */
  private diagnosticImage(): { width: number; height: number; pixels: Uint8ClampedArray } | null {
    const view = this.diagnosticsView;
    if (view === 'none' || view === 'camera') return null;
    const now = this.clock.realSeconds;
    if (this.diagnosticImageCache && now - this.diagnosticImageAt < 0.5) return this.diagnosticImageCache;
    let image: { width: number; height: number; pixels: Uint8ClampedArray } | null = null;
    if (view === 'spectrum') {
      image = this.spectrumImage();
    } else {
      this.analyzer.readPresentationRGBA8(this.diagnosticBuffer);
      image = view === 'topology' ? this.topologyImage() : this.reducedFieldImage();
    }
    if (image) {
      this.diagnosticImageCache = image;
      this.diagnosticImageAt = now;
    }
    return image;
  }

  /** The reduced field as a grayscale image (G channel = envelope-weighted V). */
  private reducedFieldImage(): { width: number; height: number; pixels: Uint8ClampedArray } {
    const width = PRESENTATION.width;
    const height = PRESENTATION.height;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const source = this.diagnosticBuffer;
    for (let i = 0; i < width * height; i += 1) {
      const v = source[i * 4 + 1]!;
      const flux = source[i * 4 + 2]!;
      pixels[i * 4] = Math.min(255, Math.round(v * 1.15 + flux * 0.4));
      pixels[i * 4 + 1] = v;
      pixels[i * 4 + 2] = flux;
      pixels[i * 4 + 3] = 255;
    }
    return { width, height, pixels };
  }

  /** The label/hole proxy map: components coloured by tracked id, holes highlighted, seam in cyan. */
  private topologyImage(): { width: number; height: number; pixels: Uint8ClampedArray } {
    const width = PRESENTATION.width;
    const height = PRESENTATION.height;
    const size = width * height;
    const field = new Float32Array(size);
    const source = this.diagnosticBuffer;
    for (let i = 0; i < size; i += 1) field[i] = source[i * 4 + 1]! / 255;
    if (this.diagnosticTopology === null) this.diagnosticTopology = new TopologyAnalyzer(width);
    const result = this.diagnosticTopology.analyze(field, this.clock.performanceSeconds);
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < size; i += 1) {
      const label = result.labels[i]!;
      let r = 8;
      let g = 8;
      let b = 12;
      if (result.holeMask[i] === 1) {
        r = 230;
        g = 70;
        b = 70;
      } else if (label !== 0) {
        // Deterministic per-id colour; the largest component is brightest.
        const h = (Math.imul(label, 2654435761) >>> 0) / 4294967296;
        r = 60 + Math.round(150 * h);
        g = 60 + Math.round(150 * (1 - h));
        b = 90 + Math.round(120 * h);
      }
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }
    return { width, height, pixels };
  }

  /** A small spectrum strip: the four normalized band energies as bars, on a dark background. */
  private spectrumImage(): { width: number; height: number; pixels: Uint8ClampedArray } {
    const width = 256;
    const height = 96;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      pixels[i * 4] = 10;
      pixels[i * 4 + 1] = 10;
      pixels[i * 4 + 2] = 14;
      pixels[i * 4 + 3] = 255;
    }
    const bands = this.presentation?.spectralBands ?? [0, 0, 0, 0];
    const gap = 8;
    const barWidth = Math.floor((width - gap * (bands.length + 1)) / bands.length);
    for (let bIndex = 0; bIndex < bands.length; bIndex += 1) {
      const value = Math.max(0, Math.min(1, bands[bIndex]!));
      const x0 = gap + bIndex * (barWidth + gap);
      const barHeight = Math.round(value * (height - 2 * gap));
      for (let y = height - gap - barHeight; y < height - gap; y += 1) {
        for (let x = x0; x < x0 + barWidth; x += 1) {
          const i = (y * width + x) * 4;
          pixels[i] = 90 + 40 * bIndex;
          pixels[i + 1] = 200 - 40 * bIndex;
          pixels[i + 2] = 160;
        }
      }
    }
    return { width, height, pixels };
  }

  // The verification hook is intentionally tiny and read-only except where a test must control
  // the simulation deterministically. It is not UI and is never attached to the DOM.
  private installTestHook(): void {
    const hook: ArtworkTestHook = {
      report: () => this.report,
      capabilityMarkdown: () => capabilityReportMarkdown(this.report),
      canvasSize: () => ({ width: this.canvas.width, height: this.canvas.height }),
      sceneSize: () => this.renderer.sceneDimensions,
      steps: () => this.simulation.steps,
      epoch: () => this.simulation.epoch,
      simulationTime: () => this.simulation.numericalTime,
      parameters: () => this.effectiveParameters(),
      clock: () => ({
        performanceSeconds: this.clock.performanceSeconds,
        simulationTime: this.clock.simulationTime,
        steps: this.clock.steps,
        paused: this.clock.paused,
        speed: this.clock.speed,
      }),
      setParameters: (value) => {
        this.overrideParams = { ...value };
        this.baseParams = { ...value };
      },
      releaseParameters: () => {
        this.dispatch({ type: 'parameters', value: this.baseParams, mode: 'release' });
      },
      setAutoSeed: (enabled) => {
        if (this.autoSeedEnabled === enabled) return;
        this.autoSeedEnabled = enabled;
        // Either direction resets the director's state and time origin and synchronizes the app's
        // camera/light/material with it (MAJOR 7). Disabling returns the calibrated Phase-1 defaults
        // exactly (the frozen gate captures assert against the light-azimuth drift that would
        // otherwise remain); enabling resumes from the current state with a cleared time origin, so
        // there is no one-frame jump from an accumulated real-time delta.
        this.restorePhase1VisualState();
      },
      setSpeed: (value) => this.clock.setSpeed(value),
      setExploration: (value) => this.setExplorationMode(value),
      simulationSize: () => ({ width: this.simulation.width, height: this.simulation.height }),
      rendererSimulationSize: () => this.renderer.simulationDimensions,
      curatorPhase: () => this.phase,
      chemistryHealth: () => (this.health ? this.analysisState().chemistryHealth : null),
      presentationAnalysis: () => this.analysisState().presentation,
      events: () => ({ ...this.events }),
      eventLog: () => this.eventLog.map((entry) => ({ ...entry })),
      audioStatus: () => ({
        status: this.audio.status(),
        unlocked: this.audio.audioUnlocked(),
        muted: this.audio.isMuted(),
        available: this.audio.available(),
      }),
      silenceStatus: () => this.audio.silenceStatus(),
      prepareSilence: () => this.audio.prepareSilence(),
      setMuted: (value) => this.audio.setMuted(value),
      audioUnlock: () => this.audio.unlock(),
      audioRecordingTrackCount: () => this.audio.recordingStream()?.getAudioTracks().length ?? 0,
      audioSoundSignature: () => this.audio.soundSignature(),
      audioStats: () => this.audio.stats(),
      audioOfflineProbe: (options) =>
        renderOfflineScenario({
          scenario: options.scenario,
          seconds: options.seconds,
          tickHz: options.tickHz,
          render: options.render,
          rootSeed: options.rootSeed,
        }),
      horizonState: () => this.director.horizon,
      presenterStats: () => this.presenter.stats(),
      coarseOccupancy: () =>
        this.coarse
          ? {
              size: this.coarse.size,
              occupiedFraction: this.coarse.occupiedFraction,
              centroidUV: [this.coarse.centroidUV[0], this.coarse.centroidUV[1]] as [number, number],
            }
          : null,
      trajectoryInfo: () => ({
        source: this.trajectorySource,
        error: this.trajectoryError,
        id: this.trajectory.id,
        movements: this.trajectory.movements.map((movement) => movement.id),
      }),
      exportTrajectory: () => this.exportTrajectory(),
      loadTrajectoryDocument: (text: string) => {
        try {
          this.applyTrajectory(parseTrajectoryDocument(text), 'imported');
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: String(error) };
        }
      },
      setPaused: (value) => {
        this.userPaused = value;
        this.clock.setPaused(value);
      },
      setLight: (value) => {
        // MAJOR 7: pin through the director so the override survives `derive`; sync the live field.
        this.director.pinLight(value);
        this.light = this.director.targets.light;
      },
      setMaterial: (value) => {
        this.director.pinMaterial(value);
        this.material = this.director.targets.material;
      },
      unpinLight: () => {
        this.director.pinLight(null);
      },
      unpinMaterial: () => {
        this.director.pinMaterial(null);
      },
      unpinCamera: () => {
        // Same release path as the laboratory's camera command, so the manual-mode release target
        // (Fix B) is exercised by the hook too: with automatic composition off the camera returns to
        // the calibrated Phase-1 default instead of staying at the last override.
        this.applyCameraOverride(null);
      },
      cameraPins: () => this.director.pinned,
      directorAzimuthTarget: () => this.director.azimuthTargetRadians,
      light: () => ({ ...this.light }),
      material: () => ({ ...this.material }),
      reset: () => {
        // `Simulation.reset` clears the field and bumps the epoch, so it is a field-replacement path
        // for the analyzer too (MAJOR 2).
        this.simulation.reset();
        this.resetAnalysis(this.simulation.epoch);
      },
      /**
       * Convenience genesis for tests that want a fixed, reproducible fixture seed (AC.6 and the
       * calibration sweep). This is deliberately NOT the gate path: the gate builds a fully
       * specified command in Node and applies it through `applyGenesis`, so the command it records
       * is by construction the command that ran. Do not treat this fixture seed as gate provenance.
       */
      seed: (options) => {
        const command = createSingleSeedCommand({
          center: options?.center ?? [0.5, 0.5],
          seed: 1_000_003,
          perturb: false,
          radiusCells: options?.radiusCells ?? GENESIS.defaultRadiusCells,
          strength: 1,
          mode: options?.mode ?? 'replace',
        });
        this.seedField(command);
      },
      simulate: (steps) => {
        const parameters = this.effectiveParameters();
        for (let i = 0; i < steps; i += 1) this.simulation.step(parameters, TIME.dt);
        return this.simulation.steps;
      },
      /**
       * MAJOR 1/3 deterministic composition driver: advance the automatic composition synchronously
       * by `steps` delivered steps exactly as a frame would (curator per step -> genesis -> chemistry
       * step), without rendering; each batch is accounted to the clock via `accountSteps` (unlike a
       * real frame, batches here are uncapped). Used to walk a restart to a known point and to
       * compare the genesis command sequence for a fixed seed.
       */
      advanceComposition: (steps) => {
        advanceCompositionBatch(
          steps,
          () => this.simulation.epoch,
          () => this.curatorWorldView(),
          (view) => this.composeStep(view),
        );
        // The clock's `accountSteps` is the delivered-work record for a driver that does not run the
        // frame loop (the solver's own counters reset on a `replace` genesis). Accounting here makes
        // the clock the exact delivered-step/time mark the caller advanced to.
        this.clock.accountSteps(steps);
        return {
          steps,
          phase: this.phase,
          epoch: this.simulation.epoch,
          simulationTime: this.simulation.numericalTime,
        };
      },
      /**
       * MINOR 3 verification: advance a batch while recording the analysis validity handed to each
       * step, injecting one field replacement (through the same genesis surface) *before* step
       * `replaceAfterStep`. Without the epoch-driven refresh the steps after the replacement would
       * keep the pre-replacement sample, so their recorded validity would stay true.
       */
      advanceCompositionTraced: (steps, replaceAfterStep) => {
        const trace: boolean[] = [];
        advanceCompositionBatch(
          steps,
          () => this.simulation.epoch,
          () => this.curatorWorldView(),
          (view) => this.composeStep(view),
          (view) => trace.push(view.analysis.chemistryHealth.valid),
          (index) => {
            if (index === replaceAfterStep) {
              this.seedField(
                createSingleSeedCommand({
                  center: [0.35, 0.65],
                  seed: 1_000_003,
                  perturb: false,
                  radiusCells: GENESIS.defaultRadiusCells,
                  strength: 1,
                  mode: 'replace',
                }),
              );
            }
          },
        );
        // Same delivered-work accounting as `advanceComposition`, so both batch drivers keep the clock
        // the authoritative delivered-step record.
        this.clock.accountSteps(steps);
        return { trace, epoch: this.simulation.epoch, healthValid: this.analysisState().chemistryHealth.valid };
      },
      curatorState: () => ({
        arc: this.curator.arcIndex,
        movement: this.curator.movementId,
        stillState: this.curator.stillState,
        rescueUsed: this.curator.rescueUsed,
        genesisOrigin: this.curator.genesisOrigin ? [this.curator.genesisOrigin[0], this.curator.genesisOrigin[1]] : null,
        timeline: this.curator.stillnessTimeline(),
      }),
      genesisLog: () => this.genesisLog.map((command) => ({ ...command, center: [command.center[0], command.center[1]] as [number, number] })),
      /**
       * §6.4 MAJOR 3 evidence: every premature-extinction decision recorded since the last restart /
       * resolution switch — movement, intention, parameters, the tier-1 health read, the dead-duration
       * accumulator and what the curator did.
       */
      extinctionLog: () => this.extinctionLog.map((decision) => ({ ...decision, parameters: { ...decision.parameters } })),
      cadenceCounters: () => ({
        publications: this.publications,
        analysisRequests: this.analysisRequests,
        realSeconds: this.clock.realSeconds,
        performanceSeconds: this.clock.performanceSeconds,
      }),
      analysisDiagnostics: () => ({ ...this.analyzer.diagnostics(), packSaturated: this.analysisPackSaturated }),
      /**
       * MAJOR 5 fixture hook: issue exactly one tier-1 sample now and return its raw decoded values,
       * so a browser spec can compare the real shader reduction against a CPU full-domain mean.
       */
      analysisSampleForTest: async (timeoutMs = 4000) => {
        const requested = this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp());
        if (!requested) return null;
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          const sample = this.analyzer.poll();
          if (sample) {
            return {
              epoch: sample.stamp.epoch,
              occupiedFraction: sample.health.fullOccupiedFraction,
              flux: sample.health.fullReactionActivity,
              change: sample.health.fullChangeRate,
              packSaturated: sample.packSaturated,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return null;
      },
      requestAnalysisOnly: () => this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp()),
      /** §7.1/AC.11 verification-only: force the next completed fence to be treated as WAIT_FAILED. */
      analyzerSimulateWaitFailed: (value: boolean) => this.analyzer.forceWaitFailed(value),
      /**
       * §7.1/AC.10 fixture hook: issue one analysis sample and return both tiers read directly from the
       * combined buffer — the tier-1 health record and the tier-2 reduced presentation statistics
       * (envelope-weighted mean U/V, occupancy, activity) — so a browser spec can verify the real
       * reduction shaders without waiting on the worker.
       */
      reductionSampleForTest: async (timeoutMs = 4000) => {
        const requested = this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp());
        if (!requested) return null;
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
          const sample = this.analyzer.poll();
          if (sample) {
            const bytes = sample.bytes;
            const size = PRESENTATION.width * PRESENTATION.height;
            let sumU = 0;
            let sumV = 0;
            let flux = 0;
            let occupied = 0;
            for (let i = 0; i < size; i += 1) {
              const r = bytes[i * 4]! / 255;
              const g = bytes[i * 4 + 1]! / 255;
              const b = bytes[i * 4 + 2]! / 255;
              sumU += r;
              sumV += g;
              flux += b;
              if (g > PRESENTATION.occupancyThreshold) occupied += 1;
            }
            return {
              epoch: sample.stamp.epoch,
              health: {
                occupiedFraction: sample.health.fullOccupiedFraction,
                flux: sample.health.fullReactionActivity,
                change: sample.health.fullChangeRate,
              },
              presentation: {
                meanU: sumU / size,
                meanV: sumV / size,
                occupancy: occupied / size,
                activity: (flux / size) * PRESENTATION.fluxScale,
              },
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return null;
      },
      /**
       * §7.1/§7.3 end-to-end fixture hook: drive `samples` real presentation samples through the full
       * worker path — acquire a pooled combined buffer, fill it from the analyzer readback, transfer it
       * to the `PresentationWorker`, and publish the returned descriptors/event exactly as the frame
       * loop's `pollAnalysis` does — then report the event serial and the last tier-2 topology state.
       * This is the *real* event path, so a spec can assert (not infer) that no retained component and
       * no salient event arise from a sub-threshold field however many samples are fed.
       */
      presentationEventProbeForTest: async (samples, timeoutMs = 10_000) => {
        const eventSerialBefore = this.eventSerial;
        const eventKinds: string[] = [];
        let completed = 0;
        let tier1OccupiedFraction = Number.NaN;
        let last: PresentationDescriptors | null = null;
        for (let i = 0; i < samples; i += 1) {
          const buffer = this.presenter.acquire();
          if (!buffer) break;
          if (!this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp())) {
            this.presenter.release(buffer);
            break;
          }
          const readbackDeadline = performance.now() + timeoutMs;
          let submitted = false;
          while (performance.now() < readbackDeadline) {
            const sample = this.analyzer.poll(new Uint8Array(buffer));
            if (sample) {
              if (sample.stamp.epoch === this.simulation.epoch) {
                this.health = sample.health;
                this.coarse = sample.coarse;
                this.analysisPackSaturated = sample.packSaturated;
                tier1OccupiedFraction = sample.health.fullOccupiedFraction;
                this.presenter.submit(sample.stamp, buffer);
                submitted = true;
              } else {
                this.presenter.release(buffer);
              }
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          if (!submitted) break;
          const resultDeadline = performance.now() + timeoutMs;
          let collected = false;
          while (performance.now() < resultDeadline) {
            const result = this.presenter.poll();
            if (result) {
              collected = true;
              if (result.status === 'ok' && result.descriptors && result.epoch === this.simulation.epoch) {
                this.presentation = result.descriptors.presentation;
                this.presentationEpoch = result.epoch;
                this.presentationPerformanceSeconds = result.stamp.performanceSeconds;
                last = result.descriptors.presentation;
                if (result.event) {
                  eventKinds.push(result.event.kind);
                  this.publishEvent(result.event);
                }
              }
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          if (!collected) break;
          completed += 1;
        }
        return {
          requested: samples,
          completed,
          eventSerialBefore,
          eventSerialAfter: this.eventSerial,
          eventKinds,
          descriptors: last
            ? {
                occupiedFraction: last.occupiedFraction,
                meanV: last.meanV,
                beta0Approx: last.beta0Approx,
                beta1Approx: last.beta1Approx,
                largestComponentFraction: last.largestComponentFraction,
                topologyConfidence: last.topologyConfidence,
                persistenceSeconds: last.persistenceSeconds,
              }
            : null,
          tier1OccupiedFraction,
        };
      },
      /**
       * §7.1/AC.11 readback-ring probe: run `iterations` request/poll cycles synchronously and report
       * the retained-buffer balance, so a browser spec can confirm the PBO ring is bounded and that a
       * dropped fence recycles its slot rather than leaking.
       */
      analyzerRingProbe: async (iterations: number) => {
        const buffersBefore = this.tracker.snapshot().buffers;
        let requests = 0;
        let samples = 0;
        for (let i = 0; i < iterations; i += 1) {
          if (!this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp())) continue;
          requests += 1;
          const deadline = performance.now() + 3000;
          while (performance.now() < deadline) {
            const sample = this.analyzer.poll();
            if (sample) {
              samples += 1;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
        return {
          iterations,
          requests,
          samples,
          buffersBefore,
          buffersAfter: this.tracker.snapshot().buffers,
          diagnostics: { ...this.analyzer.diagnostics(), packSaturated: this.analysisPackSaturated },
        };
      },
      analysisPollGuardProbe: async () => {
        const before = this.analyzer.diagnostics().staleDrops;
        const requested = this.analyzer.request(this.simulation.fieldWithPrevious(), this.buildSampleStamp());
        if (!requested) return { ok: false, reason: 'request rejected', discarded: false, staleDrops: before };
        // Move the accepted epoch forward WITHOUT clearing the slot: the pending sample now carries a
        // stale epoch, which is exactly what the poll-time guard must reject.
        this.analyzer.retargetEpoch(this.simulation.epoch + 1);
        const deadline = performance.now() + 4000;
        let discarded = false;
        try {
          while (performance.now() < deadline) {
            const sample = this.analyzer.poll();
            if (sample) return { ok: false, reason: 'a stale sample was returned', discarded: false, staleDrops: this.analyzer.diagnostics().staleDrops };
            if (this.analyzer.diagnostics().staleDrops > before) {
              discarded = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } finally {
          // Restore the analyzer to the app's real epoch (clears the slots).
          this.analyzer.reset(this.simulation.epoch);
        }
        return { ok: true, discarded, staleDrops: this.analyzer.diagnostics().staleDrops };
      },
      renderOnce: () => {
        this.publish();
        this.renderer.render(this.simulation.fieldWithPrevious(), this.worldState);
      },
      readField: () => {
        const data = this.simulation.readField();
        const count = this.simulation.width * this.simulation.height;
        const u = new Array<number>(count);
        const v = new Array<number>(count);
        for (let i = 0; i < count; i += 1) {
          u[i] = data[i * 2]!;
          v[i] = data[i * 2 + 1]!;
        }
        return { width: this.simulation.width, height: this.simulation.height, u, v };
      },
      fieldStats: (threshold) => {
        const field = this.hookField();
        return fieldStats(field.u, field.v, field.width, field.height, threshold ?? 0.1);
      },
      compositeStats: () => {
        const pixels = this.renderer.readComposite();
        const { width, height } = this.canvas;
        return imageStats(pixels, width, height);
      },
      feedbackOk: () => this.simulation.verifyAttachmentFeedback() && this.simulation.feedbackViolations === 0,
      feedbackViolations: () => this.simulation.feedbackViolations,
      smallGridRun: (options) => this.smallGridRun(options),
      dispatch: (command) => this.dispatch(command),
      labOpen: () => this.lab.isOpen,
      toggleLab: () => this.lab.toggle(),
      labSnapshot: () => this.labApi().snapshot(),
      cursorIdle: () => document.documentElement.classList.contains('cursor-idle'),
      diagnostics: () => ({ ...this.diagnostics, frameTimesMs: [...this.diagnostics.frameTimesMs] }),
      benchmarkFrames: (count, stepsPerFrame) => this.benchmarkFrames(count, stepsPerFrame),
      capturePngBase64: () => this.renderer.capture().then((blob) => blobToBase64(blob)),
      startRecording: () => this.startRecording(),
      stopRecordingBase64: async () => {
        const { blob } = await this.stopRecording();
        return { base64: await blobToBase64(blob), mimeType: blob.type, bytes: blob.size };
      },
      updateWorld: (deltaSeconds) => {
        // Advances the clock and chemistry exactly as a frame would, without rendering. Used by
        // the clock-equivalence check to compare 30/60/144 Hz delivery on the real pipeline.
        const allocation = this.clock.advance(deltaSeconds);
        const parameters = this.effectiveParameters();
        for (let i = 0; i < allocation.steps; i += 1) this.simulation.step(parameters, TIME.dt);
      },
      publishNow: () => this.publish(),
      publishedState: () => ({
        epoch: this.worldState.epoch,
        tick: this.worldState.tick,
        parameters: { ...this.worldState.parameters },
        material: { ...this.worldState.material },
        light: { ...this.worldState.light },
        camera: { ...this.worldState.camera },
      }),
      appliedToneState: () => this.renderer.appliedToneState(),
      applyGenesis: (command) => {
        this.seedField(command);
      },
      fieldSymmetry: (periodFraction) => this.fieldSymmetry(periodFraction ?? 0.25),
      fieldSummary: (threshold, periodFraction) =>
        this.fieldSummary(threshold ?? 0.1, periodFraction ?? 0.25),
      enableValidation: (enabled) => this.simulation.enableValidation(enabled),
      clipping: () => this.simulation.readClipping(),
      resetValidation: () => this.simulation.resetValidation(),
      lifecycleCheck: () => this.lifecycleCheck(),
      colorTargetFailureProbe: () => this.colorTargetFailureProbe(),
    };
    this.installedHook = hook;
    (window as unknown as { __artwork?: ArtworkTestHook }).__artwork = hook;
  }

  /**
   * Translational symmetry of the V field at a given period, as a scale-free score:
   *   1 - mean|V(p) - V(p + period)| / mean|V(p) - mean(V)|
   * A score near 1 means the field repeats exactly at that period (a lattice composition grown on a
   * translation-invariant torus); a score near 0 means it does not. On a dead or uniform field both
   * terms are zero, so the score is reported as 1 and callers must check occupancy themselves
   * before drawing a conclusion.
   */
  private fieldSymmetry(periodFraction: number): {
    score: number;
    periodCells: [number, number];
    meanV: number;
    meanAbsoluteDeviation: number;
    meanAbsoluteDifference: number;
  } {
    const field = this.hookField();
    const { width, height, v } = field;
    const dx = Math.max(1, Math.round(width * periodFraction));
    const dy = Math.max(1, Math.round(height * periodFraction));
    const count = width * height;
    let mean = 0;
    for (let i = 0; i < count; i += 1) mean += v[i]!;
    mean /= count;
    let deviation = 0;
    let difference = 0;
    for (let y = 0; y < height; y += 1) {
      const shiftedRow = ((y + dy) % height) * width;
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const value = v[row + x]!;
        difference += Math.abs(value - v[shiftedRow + ((x + dx) % width)]!);
        deviation += Math.abs(value - mean);
      }
    }
    const meanAbsoluteDifference = difference / count;
    const meanAbsoluteDeviation = deviation / count;
    const score =
      meanAbsoluteDeviation > 1e-9 ? 1 - meanAbsoluteDifference / meanAbsoluteDeviation : 1;
    return {
      score,
      periodCells: [dx, dy],
      meanV: mean,
      meanAbsoluteDeviation,
      meanAbsoluteDifference,
    };
  }

  /**
   * Compact summary of the live field for capture provenance and composition checks: occupancy,
   * occupied extent and centroid in normalized UV, and translational symmetry at one period.
   * Computed in-page so no large readback crosses the driver boundary.
   */
  private fieldSummary(
    threshold: number,
    periodFraction: number,
  ): {
    threshold: number;
    occupiedFraction: number;
    meanU: number;
    meanV: number;
    maxV: number;
    centroidUV: [number, number];
    boundsUV: [number, number, number, number];
    extentUV: [number, number];
    symmetry: {
      score: number;
      periodCells: [number, number];
      meanAbsoluteDifference: number;
      meanAbsoluteDeviation: number;
    };
  } {
    const field = this.hookField();
    const { width, height, u, v } = field;
    const count = width * height;
    let occupied = 0;
    let sumU = 0;
    let sumV = 0;
    let maxV = 0;
    let centroidX = 0;
    let centroidY = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const cu = u[row + x]!;
        const cv = v[row + x]!;
        sumU += cu;
        sumV += cv;
        if (cv > maxV) maxV = cv;
        if (cv > threshold) {
          occupied += 1;
          centroidX += x;
          centroidY += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const denominator = occupied > 0 ? occupied : 1;
    const boundsUV: [number, number, number, number] =
      occupied > 0
        ? [minX / width, minY / height, (maxX + 1) / width, (maxY + 1) / height]
        : [0, 0, 0, 0];
    const symmetry = this.fieldSymmetry(periodFraction);
    return {
      threshold,
      occupiedFraction: occupied / count,
      meanU: sumU / count,
      meanV: sumV / count,
      maxV,
      centroidUV: [centroidX / denominator / width, centroidY / denominator / height],
      boundsUV,
      extentUV: [boundsUV[2] - boundsUV[0], boundsUV[3] - boundsUV[1]],
      symmetry: {
        score: symmetry.score,
        periodCells: symmetry.periodCells,
        meanAbsoluteDifference: symmetry.meanAbsoluteDifference,
        meanAbsoluteDeviation: symmetry.meanAbsoluteDeviation,
      },
    };
  }

  /**
   * Resource-lifecycle check (depth renderbuffer ownership, validation instrumentation ownership).
   * Four independent checks:
   *  1. resize churn on the live renderer — counts must return to the pre-churn baseline;
   *  2. create/delete churn of depth targets on a fresh tracker — counts must return to zero;
   *  3. construct and dispose a throwaway App — its tracker must end at exactly zero;
   *  4. toggle the validation instrumentation on/off repeatedly on one throwaway simulation — the
   *     counts must return to the pre-validation baseline after *every* disable (the instrumentation
   *     is allocated lazily and released on disable, so a disable that merely dropped the reference
   *     would show up here as growth), and `dispose()` must then reach exactly zero.
   */
  private lifecycleCheck(): {
    before: GLResourceCounts;
    afterResizeChurn: GLResourceCounts;
    resizeIterations: number;
    scratchTrackerAfterChurn: GLResourceCounts;
    scratchTargets: number;
    throwawayAfterConstruct: GLResourceCounts;
    throwawayAfterDispose: GLResourceCounts;
    validationBaseline: GLResourceCounts;
    validationCycles: number;
    validationEnabledCounts: GLResourceCounts[];
    validationDisabledCounts: GLResourceCounts[];
    validationAfterDispose: GLResourceCounts;
  } {
    const before = this.tracker.snapshot();
    const sizes: Array<[number, number]> = [
      [640, 360],
      [960, 540],
      [1280, 720],
      [1024, 576],
    ];
    const resizeIterations = 200;
    for (let i = 0; i < resizeIterations; i += 1) {
      const [w, h] = sizes[i % sizes.length]!;
      this.renderer.resize(w, h);
    }
    // Restore the live canvas size so the rest of the session is unaffected.
    this.renderer.resize(this.canvas.width, this.canvas.height);
    const afterResizeChurn = this.tracker.snapshot();

    const scratchTracker = new ResourceTracker();
    const scratchTargets = 25;
    for (let i = 0; i < scratchTargets; i += 1) {
      const target = createColorTarget(
        this.gl,
        scratchTracker,
        64 + i,
        64 + i,
        this.gl.RGBA16F,
        this.gl.RGBA,
        this.gl.HALF_FLOAT,
        this.gl.NEAREST,
        i % 2 === 0,
      );
      deleteColorTarget(this.gl, scratchTracker, target);
    }
    const scratchTrackerAfterChurn = scratchTracker.snapshot();

    const throwawayCanvas = document.createElement('canvas');
    throwawayCanvas.width = 320;
    throwawayCanvas.height = 180;
    const throwaway = new App({ canvas: throwawayCanvas });
    const throwawayAfterConstruct = throwaway.tracker.snapshot();
    throwaway.dispose();
    const throwawayAfterDispose = throwaway.tracker.snapshot();

    // 4. Validation instrumentation toggling. It is allocated lazily on first enable, so the
    //    baseline is the count of a constructed-but-not-validating simulation, and every disable
    //    must return to that same baseline.
    const validationTracker = new ResourceTracker();
    const validationSimulation = new Simulation({
      gl: this.gl,
      tracker: validationTracker,
      width: 128,
      height: 128,
      dt: TIME.dt,
    });
    const validationBaseline = validationTracker.snapshot();
    const validationCycles = 6;
    const validationEnabledCounts: GLResourceCounts[] = [];
    const validationDisabledCounts: GLResourceCounts[] = [];
    for (let i = 0; i < validationCycles; i += 1) {
      validationSimulation.enableValidation(true);
      // One instrumented step per cycle submits the validation pass and the counter targets, so a
      // leaked target is not merely allocated but actually written to before being released.
      validationSimulation.step(this.effectiveParameters(), TIME.dt);
      validationEnabledCounts.push(validationTracker.snapshot());
      validationSimulation.enableValidation(false);
      validationDisabledCounts.push(validationTracker.snapshot());
    }
    validationSimulation.dispose();
    const validationAfterDispose = validationTracker.snapshot();

    return {
      before,
      afterResizeChurn,
      resizeIterations,
      scratchTrackerAfterChurn,
      scratchTargets,
      throwawayAfterConstruct,
      throwawayAfterDispose,
      validationBaseline,
      validationCycles,
      validationEnabledCounts,
      validationDisabledCounts,
      validationAfterDispose,
    };
  }

  /**
   * Construction-failure accounting. `createColorTarget` takes tracker ownership of each object as
   * it is created and releases everything it owns when construction fails, so a failed attempt must
   * leave the counts exactly where they started. Before the fix the framebuffer counter was only
   * incremented after the completeness check, so a failed attempt left it at -1.
   *
   * Each probe runs on one fresh tracker and is released either way (a probe that unexpectedly
   * completes is deleted normally), so the essential assertion — the counts return to their starting
   * values — holds on every driver; the zero-sized probe additionally guarantees the failure path
   * itself is exercised, since it cannot be a complete framebuffer on any implementation.
   */
  private colorTargetFailureProbe(): {
    probes: Array<{
      label: string;
      message: string | null;
      before: GLResourceCounts;
      after: GLResourceCounts;
    }>;
    final: GLResourceCounts;
  } {
    const gl = this.gl;
    const tracker = new ResourceTracker();
    const probes: Array<{
      label: string;
      message: string | null;
      before: GLResourceCounts;
      after: GLResourceCounts;
    }> = [];

    const attempt = (label: string, build: () => ColorTarget): void => {
      const before = tracker.snapshot();
      let message: string | null = null;
      try {
        const target = build();
        deleteColorTarget(gl, tracker, target);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // A deliberately invalid allocation leaves GL error flags set; clear them so the driver's
      // error state cannot leak into a later check in the same context.
      while (gl.getError() !== gl.NO_ERROR) {
        /* drain */
      }
      probes.push({ label, message, before, after: tracker.snapshot() });
    };

    // No storage at level 0 (texStorage2D rejects a zero extent), with a depth attachment:
    // FRAMEBUFFER_INCOMPLETE_ATTACHMENT on every implementation, and both decrement paths taken.
    attempt('zero-extent colour attachment + depth renderbuffer', () =>
      createColorTarget(gl, tracker, 0, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, true),
    );

    // An unsupported internal format combination (a shared-exponent packed format, which is not
    // colour-renderable in WebGL2 core). Whether the driver rejects the format or the completeness
    // check catches it, the counts must still balance.
    attempt('non-colour-renderable internal format', () =>
      createColorTarget(gl, tracker, 32, 32, gl.RGB9_E5, gl.RGB, gl.HALF_FLOAT, gl.NEAREST, false),
    );

    return { probes, final: tracker.snapshot() };
  }

  /**
   * Drained-frame throughput benchmark. Each iteration runs `stepsPerFrame` simulation steps,
   * publishes a snapshot and renders one full frame, then drains the GPU queue with a one-pixel
   * readback. That serialises the pipeline, so the result is a genuine per-frame cost rather than
   * an asynchronous submission time — the only way to answer §11.1's budget question on a display
   * whose refresh (49.95 Hz here) caps the ordinary frame-rate measurement.
   */
  private benchmarkFrames(count: number, stepsPerFrame: number): {
    canvas: string;
    scene: string;
    count: number;
    stepsPerFrame: number;
    totalMs: number;
    msPerFrame: number;
    impliedFps: number;
  } {
    const parameters = this.effectiveParameters();
    const renderOne = (): void => {
      for (let s = 0; s < stepsPerFrame; s += 1) this.simulation.step(parameters, TIME.dt);
      this.publish();
      this.renderer.render(this.simulation.fieldWithPrevious(), this.worldState);
      this.renderer.syncPoint();
    };
    for (let i = 0; i < 5; i += 1) renderOne(); // warm up shader/pipeline state
    const started = performance.now();
    for (let i = 0; i < count; i += 1) renderOne();
    const totalMs = performance.now() - started;
    const msPerFrame = totalMs / count;
    const scene = this.renderer.sceneDimensions;
    return {
      canvas: `${this.canvas.width}x${this.canvas.height}`,
      scene: `${scene.width}x${scene.height}`,
      count,
      stepsPerFrame,
      totalMs,
      msPerFrame,
      impliedFps: msPerFrame > 0 ? 1000 / msPerFrame : 0,
    };
  }

  private hookField(): { u: Float32Array; v: Float32Array; width: number; height: number } {
    const data = this.simulation.readField();
    const count = this.simulation.width * this.simulation.height;
    const u = new Float32Array(count);
    const v = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      u[i] = data[i * 2]!;
      v[i] = data[i * 2 + 1]!;
    }
    return { u, v, width: this.simulation.width, height: this.simulation.height };
  }

  private smallGridRun(options: {
    width: number;
    height: number;
    steps: number;
    parameters?: Params;
    seed?: { center: [number, number]; radiusCells: number } | null;
    validate?: boolean;
  }): SmallGridRun {
    const tracker = new ResourceTracker();
    const simulation = new Simulation({
      gl: this.gl,
      tracker,
      width: options.width,
      height: options.height,
      dt: TIME.dt,
    });
    try {
      if (options.validate) simulation.enableValidation(true);
      if (options.seed) {
        simulation.seed(
          createSingleSeedCommand({
            center: options.seed.center,
            seed: 1,
            perturb: false,
            radiusCells: options.seed.radiusCells,
            strength: 1,
            mode: 'replace',
          }),
        );
      }
      const parameters = options.parameters ?? this.effectiveParameters();
      for (let i = 0; i < options.steps; i += 1) simulation.step(parameters, TIME.dt);
      const clipping = options.validate ? simulation.readClipping() : null;
      const data = simulation.readField();
      const count = options.width * options.height;
      const u = new Array<number>(count);
      const v = new Array<number>(count);
      let saturated = 0;
      for (let i = 0; i < count; i += 1) {
        const uValue = data[i * 2]!;
        const vValue = data[i * 2 + 1]!;
        u[i] = uValue;
        v[i] = vValue;
        if (uValue === 0 || uValue === 1 || vValue === 0 || vValue === 1) saturated += 1;
      }
      return {
        width: options.width,
        height: options.height,
        u,
        v,
        saturatedCells: saturated,
        feedbackViolations: simulation.feedbackViolations,
        attachmentFeedbackOk: simulation.verifyAttachmentFeedback(),
        steps: simulation.steps,
        clipping,
      };
    } finally {
      simulation.dispose();
    }
  }
}
