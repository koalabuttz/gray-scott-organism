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
}
