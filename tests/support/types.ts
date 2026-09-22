/** Shared shapes for the in-page verification hook (mirrors src/ JSDoc-visible types). */

export interface CapabilityReportShape {
  ok: boolean;
  createdAt: string;
  userAgent: string;
  vendor: string;
  renderer: string;
  softwareRenderer: boolean;
  unmaskedRendererSupported: boolean;
  glVersion: string;
  glslVersion: string;
  extensions: Record<string, boolean>;
  limits: Record<string, number>;
  contextAttributes: Record<string, unknown>;
  formats: Array<{
    name: string;
    attachment: 'color' | 'depth';
    complete: boolean;
    status: string;
    writeVerified: boolean;
    writeError: string | null;
  }>;
  problems: string[];
}

export interface ClippingReportShape {
  clippedU: number;
  clippedV: number;
  maxExcursion: number;
  significantCellSteps: number;
  steps: number;
  cells: number;
  frequency: number;
}

export interface SmallGridRunShape {
  width: number;
  height: number;
  u: number[];
  v: number[];
  saturatedCells: number;
  feedbackViolations: number;
  attachmentFeedbackOk: boolean;
  steps: number;
  clipping: ClippingReportShape | null;
}

export interface ResourceCountsShape {
  textures: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
  shaders: number;
  vertexArrays: number;
  buffers: number;
}

export interface LifecycleCheckShape {
  before: ResourceCountsShape;
  afterResizeChurn: ResourceCountsShape;
  resizeIterations: number;
  scratchTrackerAfterChurn: ResourceCountsShape;
  scratchTargets: number;
  throwawayAfterConstruct: ResourceCountsShape;
  throwawayAfterDispose: ResourceCountsShape;
  validationBaseline: ResourceCountsShape;
  validationCycles: number;
  validationEnabledCounts: ResourceCountsShape[];
  validationDisabledCounts: ResourceCountsShape[];
  validationAfterDispose: ResourceCountsShape;
}

export interface TargetFailureProbeShape {
  label: string;
  /** The constructor's error message, or null when the target was constructed successfully. */
  message: string | null;
  before: ResourceCountsShape;
  after: ResourceCountsShape;
}

export interface ColorTargetFailureShape {
  probes: TargetFailureProbeShape[];
  final: ResourceCountsShape;
}

export interface PublishedStateShape {
  epoch: number;
  tick: number;
  parameters: ParamsShape;
  material: {
    relief: number;
    roughness: number;
    emissionTintLinear: [number, number, number];
    exposure: number;
    bloomGain: number;
  };
  light: {
    azimuthRadians: number;
    elevationRadians: number;
    intensity: number;
    colorLinear: [number, number, number];
    environment: number;
    emissionGain: number;
    transitionSeconds: number;
  };
  camera: {
    mode: string;
    focusUV: [number, number];
    yawRadians: number;
    elevationRadians: number;
    distance: number;
    verticalFovRadians: number;
    transitionSeconds: number;
  };
}

export interface SymmetryShape {
  score: number;
  periodCells: [number, number];
  meanV: number;
  meanAbsoluteDeviation: number;
  meanAbsoluteDifference: number;
}

export interface SummaryShape {
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
}

/** A fully specified genesis command as it crosses the page boundary (plain data). */
export interface GenesisCommandShape {
  id: number;
  kind: string;
  mode: 'replace' | 'inject';
  seed: number;
  center: [number, number];
  radiusCells: number;
  strength: number;
}

export interface ImageStatsShape {
  width: number;
  height: number;
  min: number;
  max: number;
  mean: number;
  nonBlackFraction: number;
  anyNonZeroFraction: number;
  aboveThresholdFraction: number;
  clippedFraction: number;
  percentiles: [number, number, number];
  channelMean: [number, number, number];
}

export interface FieldStatsShape {
  meanU: number;
  meanV: number;
  minV: number;
  maxV: number;
  occupiedFraction: number;
  reactionActivity: number;
  edgeDensity: number;
  nonFinite: number;
  saturatedCells: number;
}

/** §12.4-B refinement knobs as they cross the page boundary (`refinement()`). */
export interface RefinementShape {
  interiorDarkening: number;
  absorptionChroma: number;
  chromaGateLow: number;
  chromaGateHigh: number;
  roughnessVariation: number;
  /** Round 2: normalized thickness remap for the height (0 = round-B saturating remap). */
  heightThicknessRef: number;
  heightThicknessPower: number;
  frontBoost: number;
  frontThinGate: number;
  glossThin: number;
}

/** §12.4-B lit-pixel colour statistics (`colorStats()`). */
export interface ColorStatsShape {
  width: number;
  height: number;
  litPixels: number;
  litFraction: number;
  meanLitRGB: [number, number, number];
  warmMinusCool: number;
  meanSaturation: number;
  warmFraction: number;
  maxWarmth: number;
  hueHistogram: number[];
}

/** §12.4-B pixelwise difference between two composites (`bloomContribution()`/`diffAgainstStash()`). */
export interface ImageDifferenceShape {
  changedFraction: number;
  maxDelta: number;
  meanDelta: number;
  meanDeltaOnChanged: number;
}

/** §12.4 round-2 lit-pixel luminance distribution (`litStats()`). */
export interface LitLuminanceStatsShape {
  width: number;
  height: number;
  litPixels: number;
  litFraction: number;
  mean: number;
  stdev: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  spread: number;
}

/** §12.4 round-2 derived height-field distribution over the organism (`heightStats()`). */
export interface HeightFieldStatsShape {
  cells: number;
  min: number;
  max: number;
  mean: number;
  stdev: number;
  p50: number;
  p90: number;
  p99: number;
  spread: number;
  p90OverP50: number;
  reliefFraction: number;
}

export interface DiagnosticsShape {
  frameTimesMs: number[];
  simulationMsAvg: number;
  renderMsAvg: number;
  qualityTier: number;
  overload: boolean;
  rendererInfo: string;
  softwareRenderer: boolean;
  simStepsPerSecond: number;
  deliveredFps: number;
  desiredStepsPerSecond: number;
  analysisBacklog: number;
}

export interface ParamsShape {
  F: number;
  k: number;
  Du: number;
  Dv: number;
}

/** §3.4 `PhaseState` as it crosses the page boundary. */
export interface PhaseShape {
  arc: number;
  movement: string;
  elapsedSeconds: number;
  progress: number;
  intention: 'quiet' | 'emerge' | 'expand' | 'connect' | 'saturate' | 'release';
  stillnessState: 'none' | 'kill-wait' | 'black-hold';
}

/** §7.1 tier-1 chemistry health in the published shape (`chemistryHealth()`). */
export interface ChemistryHealthShape {
  valid: boolean;
  ageSeconds: number;
  fullOccupiedFraction: number;
  fullReactionActivity: number;
  fullChangeRate: number;
}

/** §7.1 tier-2 presentation descriptors (`presentationAnalysis()`). */
export interface PresentationShape {
  valid: boolean;
  ageSeconds: number;
  meanU: number;
  meanV: number;
  occupiedFraction: number;
  reactionActivity: number;
  changeRate: number;
  edgeDensity: number;
  entropy: number;
  featureScaleUV: number;
  spectralBands: [number, number, number, number];
  beta0Approx: number;
  beta1Approx: number;
  largestComponentFraction: number;
  topologyConfidence: number;
  persistenceSeconds: number;
  centroidUV: [number, number];
  boundsUV: [number, number, number, number];
  orientationRadians: number;
  coherence: number;
  symmetry: number;
  /** §6 (deviation 58) mean `smoothstep(supportVLow, supportVHigh, reducedV)` — the presence signal. */
  supportFraction: number;
}

/** §3.4 a recognized event as it crosses the page boundary. */
export interface EventShape {
  serial: number;
  kind: string;
  strength: number;
  atPerformanceSeconds: number;
}

/** §9.2 the director's horizon state machine (`horizonState()`). */
export interface HorizonShape {
  state: string;
  usedThisArc: boolean;
  moments: number;
}

/** §8 audio status (`audioStatus()`). */
export interface AudioStatusShape {
  status: string;
  unlocked: boolean;
  muted: boolean;
  available: boolean;
}

/** §8.3 the live silence acknowledgement (`silenceStatus()`). */
export interface SilenceStatusShape {
  satisfied: boolean;
  terminalZeroAt: number | null;
}

/** §8.2 graph instrumentation + silence state machine (`audioStats()`). */
export interface AudioStatsShape {
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
  /** §8.3 (MAJOR 1) the context time the current terminal fade began, or null. */
  fadeStartedAt: number | null;
  /** §8.3 (MAJOR 2) the live master level a restart held from before its de-click, or null. */
  masterHeldAtRestart: number | null;
  armed: boolean;
  masterGain: number;
  /** §6 whether the pad floor is currently eligible (support confirmed, hysteresis held). */
  presence: boolean;
  /** §6 distinct qualifying support samples counted toward the current (unconfirmed) crossing. */
  supportSamples: number;
  /** §6 the context time the current reveal window ends, or null. */
  revealUntil: number | null;
}

/** §8 live-path audibility: a destination-tapped output measurement (`audioOutput()`). */
export interface AudioOutputShape {
  /** Time-domain RMS over the analyser window (linear). */
  rms: number;
  /** Time-domain peak over the analyser window (linear). */
  peak: number;
  /** Strongest magnitude bin — an estimate of the sounding fundamental. */
  dominantHz: number;
  /** Width of one FFT bin in Hz. */
  binHz: number;
  /** The full magnitude spectrum in dBFS. */
  spectrumDb: number[];
}

/** §8 the live value of every gain in the graph (`audioGains()`). */
export interface AudioGainsShape {
  master: number;
  mute: number;
  voices: number[];
  texture: number;
  event: number;
  wet: number;
  dry: number;
  mix: number;
  send: number;
}

/** §12.3 AC.12 offline audio measurements (`audioOfflineProbe`). */
export interface OfflineAudioShape {
  scenario: string;
  durationSeconds: number;
  sampleRate: number;
  peak: number;
  rms: number;
  /** §7 band-limited RMS in the 150–2000 Hz band (linear, from rendered samples). */
  bandRms: number;
  /** MINOR 5: full-band RMS of each aligned 1-second window. */
  windowRms: number[];
  /** MAJOR 1: max |sample| in the scenario's reset silence window (0 when it declares none). */
  resetSilencePeak: number;
  finite: boolean;
  silentAt: number | null;
  /** §8.3 (MAJOR 1) audio-context time the terminal fade began, or null. */
  fadeStartedAt: number | null;
  /** §8.3 (MAJOR 1) max |sample| inside the fade window (proves the fade is a ramp, not a cut). */
  fadeWindowPeak: number;
  /** §8.3 (MAJOR 2) largest inter-sample step across the render (envelope-continuity bound). */
  maxInterSampleStep: number;
  postDeadlinePeak: number;
  postDeadlineSamples: number;
  maxVoices: number;
  maxLiveNodes: number;
  nodeCreated: number;
  nodeStopped: number;
  liveNodes: number;
  grainsStarted: number;
  eventsFired: number;
  eventsSkipped: number;
  silencePhase: string;
  satisfied: boolean;
  terminalZeroAt: number | null;
  /** §4.4 recorded root seed whose `sound` substream was rendered (null when omitted). */
  rootSeed: number | null;
  /** §4.4 deterministic fingerprint of the live noise/IR material. */
  soundChecksum: number;
  /** §9.5 (TAKE-4) musicality diagnostics: selectors, degrees, carriers and accept/drop counters. */
  pitch: {
    activityX: number | null;
    observedBand: number;
    padDegree: number;
    coherenceX: number | null;
    bloomDegree: number;
    bloomRegister: string;
    carriers: number[];
    lastCommitAt: number | null;
    crossings: number;
    eligibleCrossings: number;
    acceptedChanges: number;
    droppedRefractory: number;
    droppedProhibited: number;
    lastBloom: { at: number; baseHz: number; degree: number; register: string } | null;
  };
  /** §9.5 the bounded pad-degree change log (oldest first). */
  pitchLog: Array<{ at: number; band: number; degree: number; accepted: boolean; reason: string }>;
}

/** §4.4 the live sound substream (`audioSoundSignature()`), for restart-determinism checks. */
export interface SoundSignatureShape {
  root: number;
  noise: number;
  ir: number;
  grains: number;
  checksum: number;
}

/** §7.1/§9.1 coarse full-domain occupancy (`coarseOccupancy()`). */
export interface CoarseOccupancyShape {
  size: number;
  occupiedFraction: number;
  centroidUV: [number, number];
}

/** §12.2 composition-document provenance (`trajectoryInfo()`). */
export interface TrajectoryInfoShape {
  source: string;
  error: string | null;
  id: string;
  movements: string[];
}

export interface LabSnapshotShape {
  parameters: ParamsShape;
  effectiveParameters: ParamsShape;
  overrideActive: boolean;
  steps: number;
  epoch: number;
  simulationTime: number;
  performanceSeconds: number;
  speed: number;
  paused: boolean;
  rendererInfo: string;
  activation: string;
  seed: number;
  autoSeed: boolean;
  scene: string;
  diagnosticsView: string;
  resourceCounts: ResourceCountsShape;
  simulationResolution: number;
  explorationActive: boolean;
  speedRange: readonly [number, number];
  speedCeiling: number;
  /** §6.3/§6.4 composition progress carried in the lab snapshot. */
  phase: {
    arc: number;
    movement: string;
    elapsedSeconds: number;
    progress: number;
    intention: string;
    stillnessState: string;
  };
  /** §12.2 document provenance surfaced in the lab snapshot (Fix A). */
  trajectory: {
    source: string;
    error: string | null;
    id: string;
    movements: string[];
  };
  /** §7.1 tier-1 chemistry health in the lab snapshot. */
  chemistryHealth: ChemistryHealthShape;
  /** §7.1 tier-2 presentation tier + §3.4 events in the lab snapshot. */
  presentation: PresentationShape;
  event: EventShape;
  eventLog: EventShape[];
  /** §8 audio: truthful status plus the live silence acknowledgement. */
  audio: {
    status: string;
    unlocked: boolean;
    muted: boolean;
    available: boolean;
    silence: { satisfied: boolean; terminalZeroAt: number | null };
  };
}
