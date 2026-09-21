/**
 * §3.3/§3.4 WorldStore: publishes immutable plain-data snapshots and does no policy.
 *
 * Phase 1 publishes the clock/parameters/camera/light/material/health fields that the renderer
 * consumes, with neutral analysis descriptors and an empty event record (§3.4: "Before analysis
 * is implemented, publish neutral descriptors with both tiers valid:false").
 */
import type {
  AnalysisState,
  EventState,
  PhaseState,
  WorldInput,
  WorldState,
} from './types.ts';

export function neutralAnalysisState(): AnalysisState {
  return {
    samplePerformanceSeconds: 0,
    sampleSimulationTime: 0,
    chemistryHealth: {
      valid: false,
      ageSeconds: Number.POSITIVE_INFINITY,
      fullOccupiedFraction: 0,
      fullReactionActivity: 0,
      fullChangeRate: 0,
    },
    presentation: {
      valid: false,
      ageSeconds: Number.POSITIVE_INFINITY,
      meanU: 0,
      meanV: 0,
      occupiedFraction: 0,
      reactionActivity: 0,
      changeRate: 0,
      edgeDensity: 0,
      entropy: 0,
      featureScaleUV: 0,
      spectralBands: [0, 0, 0, 0],
      beta0Approx: 0,
      beta1Approx: 0,
      largestComponentFraction: 0,
      topologyConfidence: 0,
      persistenceSeconds: 0,
      centroidUV: [0.5, 0.5],
      boundsUV: [0, 0, 0, 0],
      orientationRadians: 0,
      coherence: 0,
      symmetry: 0,
    },
  };
}

export function neutralPhaseState(): PhaseState {
  return {
    arc: 0,
    movement: 'phase1',
    elapsedSeconds: 0,
    progress: 0,
    intention: 'emerge',
    stillnessState: 'none',
  };
}

export function neutralEventState(): EventState {
  return { serial: 0, kind: 'none', strength: 0, atPerformanceSeconds: 0 };
}

export interface WorldStore {
  publish(input: WorldInput): WorldState;
  latest(): WorldState;
}

export class SnapshotWorldStore implements WorldStore {
  private tickCounter = 0;
  private current: WorldState;

  constructor(initial: WorldState) {
    this.current = initial;
  }

  publish(input: WorldInput): WorldState {
    this.tickCounter += 1;
    this.current = {
      version: 1,
      epoch: input.epoch,
      tick: this.tickCounter,
      performanceSeed: input.performanceSeed,
      clock: { ...input.clock },
      phase: { ...input.phase },
      parameters: { ...input.parameters },
      analysis: input.analysis,
      events: { ...input.event },
      camera: { ...input.visualTargets.camera },
      light: { ...input.visualTargets.light },
      material: { ...input.visualTargets.material },
      health: { ...input.health },
    };
    return this.current;
  }

  latest(): WorldState {
    return this.current;
  }
}
