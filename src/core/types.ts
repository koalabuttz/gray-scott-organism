/**
 * Transport types shared across modules (§3.3 and §3.4).
 *
 * Phase 1 populates a subset of `WorldState`; the remaining fields (analysis, phase, events)
 * are present with neutral values so later phases extend rather than reshape the contract.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export type Params = Readonly<{ F: number; k: number; Du: number; Dv: number }>;

export type GenesisKind =
  | 'single'
  | 'competing'
  | 'line'
  | 'ring'
  | 'sparse'
  | 'radial'
  | 'structured';

export type GenesisMode = 'replace' | 'inject';

export interface GenesisCommand {
  readonly id: number;
  readonly kind: GenesisKind;
  readonly mode: GenesisMode;
  readonly seed: number;
  readonly center: Vec2;
  readonly radiusCells: number;
  readonly strength: number;
}

/** §3.3: opaque texture handle plus the metadata each consumer needs. */
export interface FieldView {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** Invalidates all cached analysis on reset/replace. */
  readonly epoch: number;
  /** Delivered simulation steps. */
  readonly step: number;
  /** Numerical time at this field state. */
  readonly simulationTime: number;
}

/**
 * §3.3 `SampleStamp`: the full provenance carried with every analysis sample. The tier-1 analyzer
 * stores it per in-flight slot and rejects a completed sample whose `epoch` is no longer current, so a
 * field replacement can never deliver a stale readback (MAJOR 2).
 */
export interface SampleStamp {
  epoch: number;
  step: number;
  simulationTime: number;
  performanceSeconds: number;
  parameters: Params;
}

export interface CameraState {
  mode: 'overhead' | 'approach' | 'horizon' | 'retreat';
  focusUV: Vec2;
  yawRadians: number;
  elevationRadians: number;
  distance: number;
  verticalFovRadians: number;
  transitionSeconds: number;
}

export interface LightState {
  azimuthRadians: number;
  elevationRadians: number;
  intensity: number;
  colorLinear: Vec3;
  environment: number;
  emissionGain: number;
  transitionSeconds: number;
}

export interface MaterialState {
  relief: number;
  roughness: number;
  emissionTintLinear: Vec3;
  exposure: number;
  bloomGain: number;
}

export interface HealthState {
  qualityTier: 0 | 1 | 2;
  overload: boolean;
  audioUnlocked: boolean;
}

export interface ClockState {
  realSeconds: number;
  performanceSeconds: number;
  simulationTime: number;
  paused: boolean;
  speed: number;
}

export interface PhaseState {
  arc: number;
  movement: string;
  elapsedSeconds: number;
  progress: number;
  intention: 'quiet' | 'emerge' | 'expand' | 'connect' | 'saturate' | 'release';
  stillnessState: 'none' | 'kill-wait' | 'black-hold';
}

export interface ChemistryHealth {
  valid: boolean;
  ageSeconds: number;
  fullOccupiedFraction: number;
  fullReactionActivity: number;
  fullChangeRate: number;
}

export interface PresentationAnalysis {
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
  spectralBands: readonly [number, number, number, number];
  beta0Approx: number;
  beta1Approx: number;
  largestComponentFraction: number;
  topologyConfidence: number;
  persistenceSeconds: number;
  centroidUV: Vec2;
  boundsUV: readonly [number, number, number, number];
  orientationRadians: number;
  coherence: number;
  symmetry: number;
}

export interface AnalysisState {
  samplePerformanceSeconds: number;
  sampleSimulationTime: number;
  chemistryHealth: ChemistryHealth;
  presentation: PresentationAnalysis;
}

export interface EventState {
  serial: number;
  kind: 'none' | 'birth' | 'merge' | 'fragment' | 'collapse' | 'surge';
  strength: number;
  atPerformanceSeconds: number;
}

/** §3.4 WorldState. Phase 1 renders from clock/camera/light/material/health directly. */
export interface WorldState {
  version: 1;
  epoch: number;
  tick: number;
  performanceSeed: number;
  clock: ClockState;
  phase: PhaseState;
  parameters: Params;
  analysis: AnalysisState;
  events: EventState;
  camera: CameraState;
  light: LightState;
  material: MaterialState;
  health: HealthState;
}

export interface WorldInput {
  epoch: number;
  performanceSeed: number;
  clock: ClockState;
  phase: PhaseState;
  parameters: Params;
  analysis: AnalysisState;
  event: EventState;
  health: HealthState;
  visualTargets: VisualTargets;
}

export interface VisualTargets {
  camera: CameraState;
  light: LightState;
  material: MaterialState;
}

/** Laboratory-only diagnostics; never part of WorldState. */
export interface Diagnostics {
  frameTimesMs: number[];
  simulationMsAvg: number;
  renderMsAvg: number;
  qualityTier: 0 | 1 | 2;
  overload: boolean;
  rendererInfo: string;
  softwareRenderer: boolean;
  simStepsPerSecond: number;
  deliveredFps: number;
  /** §4.1: work the transport is asking for at the current speed (speed * nominal steps/s). */
  desiredStepsPerSecond: number;
  /** §3.3/§7.1 Phase-3 readback ring: analysis samples waiting on the worker (0 or 1; never queues). */
  analysisBacklog: number;
}

export interface GLResourceCounts {
  textures: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
  shaders: number;
  vertexArrays: number;
  buffers: number;
}
