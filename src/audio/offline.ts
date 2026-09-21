/**
 * §12.3 offline audio scenarios (Phase 3).
 *
 * A deterministic driver that builds an `OfflineAudioContext`, runs the **same** `AudioEngine` the
 * live system uses, feeds a synthetic `WorldState` sequence at a fixed tick rate, renders to a buffer
 * and measures it. Everything here is headless-safe: `OfflineAudioContext` needs no output device, so
 * AC.12 (finite output, bounded voices, fades to digital zero, conservative peaks, hidden fields
 * inaudible) is verifiable on a machine with no audio hardware.
 *
 * The synthetic worlds carry only the fields the audio engine reads (presentation tier, event record,
 * clock, phase), so the fixtures are explicit and hermetic — they never touch the simulation or GPU.
 */
import { AudioEngine } from './audio.ts';
import { AUDIO } from '../config.ts';
import { neutralAnalysisState, neutralEventState, neutralPhaseState } from '../core/world.ts';
import { deriveAudioControls } from './voices.ts';
import type { EventState, Params, PresentationAnalysis, WorldState } from '../core/types.ts';

export type OfflineScenarioName =
  | 'quiet-fade'
  | 'active'
  | 'hidden-periphery'
  | 'event-refractory'
  | 'long-run'
  | 'stillness'
  | 'stillness-rearm'
  | 'restart';

export interface OfflineScenarioOptions {
  scenario: OfflineScenarioName;
  seconds?: number;
  tickHz?: number;
  sampleRate?: number;
  /** When false, skip `startRendering` and only collect the graph/engine counters (fast boundedness). */
  render?: boolean;
  /**
   * §4.4 recorded root seed (MAJOR 3). The noise/IR/grain material is derived from its `sound`
   * substream, so the same seed renders identical material and a different seed renders different
   * material. Defaults to the fixed config seed when omitted.
   */
  rootSeed?: number;
}

export interface OfflineMeasurements {
  scenario: OfflineScenarioName;
  durationSeconds: number;
  sampleRate: number;
  /** Linear peak across both channels (1.0 = 0 dBFS). */
  peak: number;
  rms: number;
  finite: boolean;
  /** Audio-context time the engine first reported the `silent` phase, or null. */
  silentAt: number | null;
  /** §8.3 (MAJOR 1) audio-context time the terminal fade *began*, or null. */
  fadeStartedAt: number | null;
  /** §8.3 (MAJOR 1) max |sample| inside the fade window (fade start → +fadeSeconds); > 0 proves a ramp. */
  fadeWindowPeak: number;
  /**
   * §8.3 (MAJOR 2) the largest |x[i] − x[i−1]| across the render — an inter-sample envelope-continuity
   * bound (a hard master cut shows up as a large step; a bounded de-click ramp does not).
   */
  maxInterSampleStep: number;
  /** Max |sample| strictly after `silentAt` — must be exactly 0 (terminal assignment). */
  postDeadlinePeak: number;
  postDeadlineSamples: number;
  /** Highest voice count the presentation requested during the run (bounded by §8.2's four). */
  maxVoices: number;
  maxLiveNodes: number;
  nodeCreated: number;
  nodeStopped: number;
  liveNodes: number;
  grainsStarted: number;
  eventsFired: number;
  eventsSkipped: number;
  silencePhase: string;
  /** `AudioEngine.silenceStatus().satisfied` at the end of the run. */
  satisfied: boolean;
  terminalZeroAt: number | null;
  /** §4.4 the recorded root seed whose `sound` substream was rendered. */
  rootSeed: number | null;
  /** §4.4 deterministic fingerprint of the live noise/IR material (for same-vs-different-seed checks). */
  soundChecksum: number;
}

const PARAMS: Params = { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 };

/** Build a synthetic `WorldState` carrying only the fields the audio engine reads. */
export function syntheticWorld(
  presentation: Partial<PresentationAnalysis> & { valid: boolean },
  extra: { event?: Partial<EventState>; phase?: Partial<WorldState['phase']>; performanceSeconds?: number; speed?: number } = {},
): WorldState {
  const neutral = neutralAnalysisState();
  const phase = neutralPhaseState();
  const camera = {
    mode: 'overhead' as const,
    focusUV: [0.5, 0.5] as [number, number],
    yawRadians: 0,
    elevationRadians: 0,
    distance: 1,
    verticalFovRadians: 0.5,
    transitionSeconds: 0,
  };
  const clock = {
    realSeconds: extra.performanceSeconds ?? 0,
    performanceSeconds: extra.performanceSeconds ?? 0,
    simulationTime: 0,
    paused: false,
    speed: extra.speed ?? 1,
  };
  return {
    version: 1,
    epoch: 0,
    tick: 0,
    performanceSeed: 1,
    clock,
    phase: { ...phase, ...(extra.phase ?? {}) },
    parameters: PARAMS,
    analysis: {
      ...neutral,
      presentation: { ...neutral.presentation, ...presentation },
    },
    events: { ...neutralEventState(), ...(extra.event ?? {}) },
    camera,
    light: {
      azimuthRadians: 0,
      elevationRadians: 0,
      intensity: 1,
      colorLinear: [1, 1, 1] as [number, number, number],
      environment: 0,
      emissionGain: 0,
      transitionSeconds: 0,
    },
    material: {
      relief: 0,
      roughness: 0.3,
      emissionTintLinear: [1, 1, 1] as [number, number, number],
      exposure: 1,
      bloomGain: 0,
    },
    health: { qualityTier: 0, overload: false, audioUnlocked: true },
  };
}

/** A presentation sample for an "active" field: enough intensity/detail to drive the whole graph. */
function activePresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return {
    valid: true,
    meanU: 0.4,
    meanV: 0.3,
    occupiedFraction: 0.32,
    reactionActivity: 0.022,
    changeRate: 0.01,
    edgeDensity: 0.11,
    entropy: 0.6,
    featureScaleUV: 0.12,
    spectralBands: [0.4, 0.3, 0.2, 0.1],
    beta0Approx: 3,
    beta1Approx: 2,
    largestComponentFraction: 0.62,
    topologyConfidence: 0.7,
    persistenceSeconds: 20,
    centroidUV: [0.5, 0.5],
    boundsUV: [0.2, 0.2, 0.8, 0.8],
    orientationRadians: 0,
    coherence: 0.45,
    symmetry: 0.2,
  };
}

/** A hidden-periphery field the §5.4 envelope suppresses: every presentation signal is zero. */
function hiddenPresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return {
    valid: true,
    occupiedFraction: 0,
    reactionActivity: 0,
    changeRate: 0,
    edgeDensity: 0,
    featureScaleUV: 0,
    spectralBands: [0, 0, 0, 0],
    beta0Approx: 0,
    largestComponentFraction: 0,
    topologyConfidence: 0,
    coherence: 0,
  };
}

function quietPresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return { ...hiddenPresentation(), valid: true };
}

/**
 * §8.3 (MAJOR 2) a **tonal** active field: enough occupancy to drive the drone voices and stay above the
 * silence gate, but zero high band / edge density (no grains), zero change rate (no events) and a
 * coherent single mass. The rendered output is a smooth three-voice drone, so a restart's master
 * continuity can be measured on the samples themselves (a hard master cut shows as a large inter-sample
 * step; a bounded de-click ramp does not). `restart` uses it.
 */
function tonalPresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return {
    valid: true,
    meanU: 0.4,
    meanV: 0.3,
    occupiedFraction: 0.5,
    reactionActivity: 0.01,
    changeRate: 0,
    edgeDensity: 0,
    entropy: 0.5,
    featureScaleUV: 0.3,
    spectralBands: [0.5, 0, 0, 0],
    beta0Approx: 1,
    beta1Approx: 1,
    largestComponentFraction: 0.6,
    topologyConfidence: 0.5,
    persistenceSeconds: 20,
    centroidUV: [0.5, 0.5],
    boundsUV: [0.2, 0.2, 0.8, 0.8],
    orientationRadians: 0,
    coherence: 0.5,
    symmetry: 0.2,
  };
}

interface ScenarioOutput {
  world: (timeSeconds: number) => WorldState;
  prepareSilenceAt?: number;
  /** §8.3 (MAJOR 2) when set, the driver aborts the episode with `resetPerformance()` at this time. */
  restartAt?: number;
}

function scenario(name: OfflineScenarioName): ScenarioOutput {
  switch (name) {
    case 'quiet-fade': {
      // Loud for 4 s, then below the off thresholds; the general gate fades at ~12 s and reaches
      // digital zero at ~20 s.
      return {
        world: (t) => (t < 4 ? syntheticWorld(activePresentation()) : syntheticWorld(quietPresentation())),
      };
    }
    case 'active':
      return { world: () => syntheticWorld(activePresentation()) };
    case 'hidden-periphery':
      return { world: () => syntheticWorld(hiddenPresentation()) };
    case 'event-refractory': {
      // A new event serial every 1 s, stepping by 3 so obsolete serials are visibly skipped: the
      // ≥ 15 s refractory lets only the first and the one after 15 s through.
      return {
        world: (t) =>
          syntheticWorld(activePresentation(), {
            event: { serial: 1 + 3 * Math.floor(t), kind: 'merge', strength: 0.8, atPerformanceSeconds: t },
          }),
      };
    }
    case 'long-run': {
      // A sustained active run with a new event serial every 5 s: exercises grain scheduling and the
      // one-shot source lifecycle over a long timeline (boundedness evidence).
      return {
        world: (t) =>
          syntheticWorld(activePresentation(), {
            event: { serial: 1 + Math.floor(t / 5), kind: 'fragment', strength: 0.6, atPerformanceSeconds: t },
          }),
      };
    }
    case 'stillness': {
      // Active, then `kill-wait` with a dying field at t = 2 s and a forced `prepareSilence()`: the
      // override fade runs [2, 10] and reaches terminal zero ≈ 10 s (the general 8 s gate would not
      // fire until ≈ 10 s and would not complete until ≈ 18 s, so the deadline proves the override).
      return {
        world: (t) =>
          t < 2
            ? syntheticWorld(activePresentation())
            : syntheticWorld(hiddenPresentation(), { phase: { stillnessState: 'kill-wait' } }),
        prepareSilenceAt: 2,
      };
    }
    case 'stillness-rearm': {
      // Episode 1 completes (fade [2, 10]); stillness returns to `none` at 12 s (re-arm) and a second
      // episode opens at 14 s *without* a fresh `prepareSilence()`. The acknowledgement stays cleared,
      // so `satisfied` is false and no second black-hold can begin on the stale zero.
      return {
        world: (t) => {
          if (t < 2) return syntheticWorld(activePresentation());
          if (t < 12) return syntheticWorld(hiddenPresentation(), { phase: { stillnessState: 'kill-wait' } });
          if (t < 14) return syntheticWorld(hiddenPresentation(), { phase: { stillnessState: 'none' } });
          return syntheticWorld(activePresentation(), { phase: { stillnessState: 'kill-wait' } });
        },
        prepareSilenceAt: 2,
      };
    }
    case 'restart': {
      // A tonal (grain-free, event-free) active field drives the drone voices. At t = 2 s `kill-wait`
      // opens the terminal fade (deadline 10 s) and at t = 4 s a fresh performance aborts it via
      // `resetPerformance()`: the restart holds the live level, de-clicks to zero, reseeds at zero and
      // fades back up, so the rendered samples stay continuous and the abandoned 10 s deadline never
      // fires (measured by `maxInterSampleStep` and a null `terminalZeroAt`).
      return {
        world: (t) =>
          t < 2
            ? syntheticWorld(tonalPresentation())
            : syntheticWorld(tonalPresentation(), { phase: { stillnessState: 'kill-wait' } }),
        prepareSilenceAt: 2,
        restartAt: 4,
      };
    }
  }
}

function measure(
  buffer: AudioBuffer,
  silentAt: number | null,
  fadeStartedAt: number | null,
): {
  peak: number;
  rms: number;
  finite: boolean;
  fadeWindowPeak: number;
  maxInterSampleStep: number;
  postDeadlinePeak: number;
  postDeadlineSamples: number;
} {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const rate = buffer.sampleRate;
  let peak = 0;
  let sumSquares = 0;
  let finite = true;
  let postPeak = 0;
  let postSamples = 0;
  let fadePeak = 0;
  let maxStep = 0;
  const postStart = silentAt === null ? length : Math.floor(silentAt * rate);
  // The fade window runs from the fade start to `fadeSeconds` later (the terminal deadline).
  const fadeStart = fadeStartedAt === null ? -1 : Math.floor(fadeStartedAt * rate);
  const fadeEnd = fadeStartedAt === null ? -1 : Math.floor((fadeStartedAt + AUDIO.fadeSeconds) * rate);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    let prev = 0;
    for (let i = 0; i < length; i += 1) {
      const value = data[i]!;
      if (!Number.isFinite(value)) {
        finite = false;
        prev = 0;
        continue;
      }
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += value * value;
      if (i > fadeStart && (fadeEnd < 0 || i < fadeEnd)) {
        if (magnitude > fadePeak) fadePeak = magnitude;
      }
      if (i > 0) {
        const step = Math.abs(value - prev);
        if (step > maxStep) maxStep = step;
      }
      prev = value;
      if (i > postStart) {
        postSamples += 1;
        if (magnitude > postPeak) postPeak = magnitude;
      }
    }
  }
  return {
    peak,
    rms: Math.sqrt(sumSquares / Math.max(1, length * channels)),
    finite,
    fadeWindowPeak: fadePeak,
    maxInterSampleStep: maxStep,
    postDeadlinePeak: postPeak,
    postDeadlineSamples: postSamples,
  };
}

/** Drive the engine over the scenario timeline and render. Never touches a live output device. */
export async function renderOfflineScenario(
  options: OfflineScenarioOptions,
): Promise<OfflineMeasurements> {
  const Ctor = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (typeof Ctor !== 'function') throw new Error('OfflineAudioContext is unavailable in this browser');
  const sampleRate = options.sampleRate ?? 48_000;
  const tickHz = options.tickHz ?? 20;
  const seconds = options.seconds ?? 26;
  const render = options.render !== false;
  // A non-rendering run (the boundedness check) never plays, so allocate a minimal buffer instead of a
  // multi-second one; node creation and time-based reaping are unaffected.
  const frames = render ? Math.ceil(seconds * sampleRate) : sampleRate;
  const context = new Ctor(2, frames, sampleRate);
  const engine = new AudioEngine(context, { unlocked: true, rootSeed: options.rootSeed });
  const plan = scenario(options.scenario);

  let silentAt: number | null = null;
  let maxVoices = 0;
  let preparedFor = false;
  let restarted = false;
  const ticks = Math.ceil(seconds * tickHz);
  for (let i = 0; i <= ticks; i += 1) {
    const now = i / tickHz;
    const world = plan.world(now);
    engine.consume(world);
    if (plan.prepareSilenceAt !== undefined && !preparedFor && now >= plan.prepareSilenceAt) {
      engine.prepareSilence(plan.prepareSilenceAt);
      preparedFor = true;
    }
    if (plan.restartAt !== undefined && !restarted && now >= plan.restartAt) {
      engine.resetPerformance(plan.restartAt, options.rootSeed);
      restarted = true;
    }
    engine.tick(now);
    const controls = deriveAudioControls(world.analysis.presentation);
    if (controls.valid && controls.voiceCount > maxVoices) maxVoices = controls.voiceCount;
    if (silentAt === null && engine.silencePhase === 'silent') silentAt = now;
  }

  const stats = engine.stats();
  const buffer = render ? await context.startRendering() : null;
  const measured =
    buffer === null
      ? {
          peak: 0,
          rms: 0,
          finite: true,
          fadeWindowPeak: 0,
          maxInterSampleStep: 0,
          postDeadlinePeak: 0,
          postDeadlineSamples: 0,
        }
      : measure(buffer, silentAt, stats.fadeStartedAt);
  const status = engine.silenceStatus();
  const signature = engine.soundSignature();
  engine.dispose();
  return {
    scenario: options.scenario,
    durationSeconds: seconds,
    sampleRate,
    peak: measured.peak,
    rms: measured.rms,
    finite: measured.finite,
    silentAt,
    fadeStartedAt: stats.fadeStartedAt,
    fadeWindowPeak: measured.fadeWindowPeak,
    maxInterSampleStep: measured.maxInterSampleStep,
    postDeadlinePeak: measured.postDeadlinePeak,
    postDeadlineSamples: measured.postDeadlineSamples,
    maxVoices,
    maxLiveNodes: stats.nodes.maxLiveNodes,
    nodeCreated: stats.nodes.nodeCreated,
    nodeStopped: stats.nodes.nodeStopped,
    liveNodes: stats.nodes.liveNodes,
    grainsStarted: stats.nodes.grainsStarted,
    eventsFired: stats.nodes.eventsFired,
    eventsSkipped: stats.eventsSkipped,
    silencePhase: stats.phase,
    satisfied: status.satisfied,
    terminalZeroAt: status.terminalZeroAt,
    rootSeed: options.rootSeed ?? null,
    soundChecksum: signature.checksum,
  };
}
