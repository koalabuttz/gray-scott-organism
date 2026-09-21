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
import { AudioEngine, type BusName } from './audio.ts';
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
  | 'restart'
  | 'wake-reveal'
  | 'single-voice'
  | 'coherence-sweep'
  | 'sustained'
  | 'collapse'
  | 'silence-cycle'
  | 'fine-detail'
  | 'reset-silence'
  | 'reset-clean'
  | 'reset-bloom'
  | 'reset-grain'
  | 'reset-grain-clean';

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
  /**
   * §8.2 render-matrix bus isolation: mute one or more source groups so a single group can be measured
   * (pad-only / texture-only / event-only). Never set in the live system.
   */
  muteBuses?: readonly BusName[];
  /** §5 verification-only: render only the reverb send (wet-vs-dry guard). */
  wetOnly?: boolean;
  /** MINOR 5 verification-only: multiply the bloom peak (an over-loud fixture that must fail the guard). */
  eventBoost?: number;
}

export interface OfflineMeasurements {
  scenario: OfflineScenarioName;
  durationSeconds: number;
  sampleRate: number;
  /** Linear peak across both channels (1.0 = 0 dBFS). */
  peak: number;
  rms: number;
  /** §7 band-limited RMS in the 150–2000 Hz presentation band (linear, from rendered samples). */
  bandRms: number;
  /** MINOR 5: full-band RMS of each aligned 1-second window, for the paired-event guard. */
  windowRms: number[];
  /** MAJOR 1: max |sample| inside the scenario's reset silence window (0 when it declares none). */
  resetSilencePeak: number;
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
  extra: {
    event?: Partial<EventState>;
    phase?: Partial<WorldState['phase']>;
    performanceSeconds?: number;
    speed?: number;
    /** §6 the sample's performance-seconds mark (a fresh-sample identity for support confirmation). */
    sampleSeconds?: number;
  } = {},
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
      // §6 the "green" of a fresh analysis sample: distinct ticks advance the support confirmation.
      samplePerformanceSeconds: extra.sampleSeconds ?? extra.performanceSeconds ?? 0,
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
    supportFraction: 0.9,
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
    supportFraction: 0,
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
    supportFraction: 0.8,
  };
}

/** §4 a mature fine-detail field (the shimmer layer fully populated). */
function fineDetailPresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return {
    ...activePresentation(),
    occupiedFraction: 0.3,
    reactionActivity: 0.02,
    edgeDensity: 0.3,
    spectralBands: [0.1, 0.1, 0.1, 1],
    largestComponentFraction: 0.6,
    beta0Approx: 1,
    supportFraction: 0.9,
  };
}

/**
 * The same fine-detail field but with **no support**: every texture descriptor (and therefore the grain
 * rate, texture level and band-pass target) is identical, but presence never confirms, so no grain is
 * ever scheduled. This is the exact no-old-grain control for `reset-grain` — the two fixtures differ
 * *only* in whether grains were in flight before the reset.
 */
function noSupportPresentation(): Partial<PresentationAnalysis> & { valid: boolean } {
  return { ...fineDetailPresentation(), supportFraction: 0 };
}

interface ScenarioOutput {
  world: (timeSeconds: number) => WorldState;
  prepareSilenceAt?: number;
  /** §8.3 (MAJOR 2) when set, the driver aborts the episode with `resetPerformance()` at this time. */
  restartAt?: number;
  /**
   * MAJOR 1: a context-time window in which the destination must be **exactly zero** after a
   * field-replacing reset (measured as `resetSilencePeak`).
   */
  silenceWindow?: readonly [number, number];
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
        // MAJOR 1: from the de-click's zero instant until the new field confirms presence, the
        // destination must be exactly zero (the old tone must not survive into the fresh field).
        silenceWindow: [4 + AUDIO.declickSeconds + 0.05, 4 + 0.45],
      };
    }
    case 'wake-reveal': {
      // §6 locked/dormant → a small supported body appears at 2 s: presence confirms (~0.5 s) and the
      // unified 1.5 s reveal brings the pad to level, so the output guard can measure the 150–2000 Hz
      // band and full-band RMS by the reveal deadline. Never starts pre-live.
      return {
        world: (t) => (t < 2 ? syntheticWorld(quietPresentation()) : syntheticWorld(activePresentation())),
      };
    }
    case 'single-voice': {
      // §7 a small, low-intensity, fragmented mass: `mapVoiceCount` is exactly 1, so audibility cannot
      // depend on the upper voices.
      return {
        world: () =>
          syntheticWorld({
            valid: true,
            occupiedFraction: 0.03,
            reactionActivity: 0.001,
            edgeDensity: 0.02,
            featureScaleUV: 0.5,
            spectralBands: [0.2, 0.1, 0.05, 0.02],
            beta0Approx: 6,
            largestComponentFraction: 0.1,
            topologyConfidence: 0.3,
            coherence: 0.4,
            supportFraction: 0.5,
          }),
      };
    }
    case 'coherence-sweep': {
      // §8 coherence rising over 20 s: the just major third (voice 3) becomes audible as it coheres.
      return {
        world: (t) => syntheticWorld({ ...activePresentation(), coherence: Math.min(1, t / 20) }),
      };
    }
    case 'sustained': {
      // A dense, high-intensity sustained body (deeper occupancy than `active`).
      return {
        world: () => syntheticWorld({ ...activePresentation(), occupiedFraction: 0.6, reactionActivity: 0.03 }),
      };
    }
    case 'collapse': {
      // §7 collapse: detail disappears, the upper voices/texture are removed, warmth remains.
      return {
        world: (t) =>
          syntheticWorld(
            t < 6
              ? activePresentation()
              : {
                  ...activePresentation(),
                  largestComponentFraction: 0.05,
                  beta0Approx: 9,
                  edgeDensity: 0.3,
                  spectralBands: [0.1, 0.2, 0.3, 0.4],
                },
          ),
      };
    }
    case 'silence-cycle': {
      // §7 / §8.3 an active body, then dormancy: the general gate fades to exact zero and stays there.
      return {
        world: (t) => (t < 4 ? syntheticWorld(activePresentation()) : syntheticWorld(quietPresentation())),
      };
    }
    case 'reset-silence': {
      // MAJOR 1: a mature audible field, then a field-replacing reset at 3 s into an **invalid** (fresh,
      // empty) field that lasts until 6 s, then support returns. The destination must be exactly zero
      // from the de-click end until the new field confirms presence, with no stale root or reverb tail,
      // and then exactly one 1.5 s reveal.
      return {
        world: (t) => {
          if (t < 3) return syntheticWorld(activePresentation());
          if (t < 6) return syntheticWorld({ valid: false });
          return syntheticWorld(activePresentation());
        },
        restartAt: 3,
        silenceWindow: [3 + AUDIO.declickSeconds + 0.05, 5.9],
      };
    }
    case 'fine-detail': {
      // §4 a mature fine-detail field: the shimmer layer is fully populated, for the texture-vs-pad guard.
      return { world: () => syntheticWorld(fineDetailPresentation()) };
    }
    case 'reset-clean': {
      // MAJOR 2 control: a mature field, a field-replacing reset at 7 s, then the same field continues.
      // The post-reveal windows are the baseline the leak fixtures are compared against.
      return {
        world: () => syntheticWorld(activePresentation()),
        restartAt: 7,
        silenceWindow: [7 + AUDIO.declickSeconds + 0.05, 7.5],
      };
    }
    case 'reset-bloom': {
      // MAJOR 2: a porcelain bloom is fired just *before* the reset (a serial change at 6.8 s, reset at
      // 7.0 s), and none after. Neither the bloom's dry tail nor the reverb history it fed may leak into
      // the new field's reveal — its post-reveal windows must match `reset-clean`.
      return {
        world: (t) =>
          syntheticWorld(activePresentation(), {
            event: { serial: t < 6.8 ? 1 : 2, kind: 'merge', strength: 0.8, atPerformanceSeconds: t },
          }),
        restartAt: 7,
        silenceWindow: [7 + AUDIO.declickSeconds + 0.05, 7.5],
      };
    }
    case 'reset-grain': {
      // MAJOR 2: grains are flowing right up to the reset at 7 s, so a grain (up to 1.2 s) is in flight.
      // The driver reseeds the grain substream at the reset, so the post-reset schedule is identical to
      // `reset-grain-clean`.
      return {
        world: () => syntheticWorld(fineDetailPresentation()),
        restartAt: 7,
        silenceWindow: [7 + AUDIO.declickSeconds + 0.05, 7.5],
      };
    }
    case 'reset-grain-clean': {
      // The no-old-grain control: identical descriptors, but no support before the reset, so presence
      // never confirms and no grain is scheduled. After the reset it is the same fine-detail field, so
      // the only difference between this and `reset-grain` is whether grains were in flight pre-reset.
      return {
        world: (t) => syntheticWorld(t < 7 ? noSupportPresentation() : fineDetailPresentation()),
        restartAt: 7,
        silenceWindow: [7 + AUDIO.declickSeconds + 0.05, 7.5],
      };
    }
  }
}

function measure(
  buffer: AudioBuffer,
  silentAt: number | null,
  fadeStartedAt: number | null,
  silenceWindow: readonly [number, number] | undefined,
): {
  peak: number;
  rms: number;
  bandRms: number;
  windowRms: number[];
  resetSilencePeak: number;
  finite: boolean;
  fadeWindowPeak: number;
  maxInterSampleStep: number;
  postDeadlinePeak: number;
  postDeadlineSamples: number;
} {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const rate = buffer.sampleRate;
  const windowLen = Math.max(1, Math.round(rate));
  const windowCount = Math.max(1, Math.floor(length / windowLen));
  const windowRms = new Array<number>(windowCount).fill(0);
  let peak = 0;
  let sumSquares = 0;
  let finite = true;
  let postPeak = 0;
  let postSamples = 0;
  let fadePeak = 0;
  let maxStep = 0;
  let resetSilencePeak = 0;
  const postStart = silentAt === null ? length : Math.floor(silentAt * rate);
  // The fade window runs from the fade start to `fadeSeconds` later (the terminal deadline).
  const fadeStart = fadeStartedAt === null ? -1 : Math.floor(fadeStartedAt * rate);
  const fadeEnd = fadeStartedAt === null ? -1 : Math.floor((fadeStartedAt + AUDIO.fadeSeconds) * rate);
  // MAJOR 1: the reset silence window (exclusive of the de-click ramp itself).
  const silenceStart = silenceWindow === undefined ? -1 : Math.floor(silenceWindow[0] * rate);
  const silenceEnd = silenceWindow === undefined ? -1 : Math.floor(silenceWindow[1] * rate);
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
      const window = Math.min(windowCount - 1, Math.floor(i / windowLen));
      windowRms[window] = windowRms[window]! + value * value;
      if (i > fadeStart && (fadeEnd < 0 || i < fadeEnd)) {
        if (magnitude > fadePeak) fadePeak = magnitude;
      }
      if (silenceStart >= 0 && i >= silenceStart && i <= silenceEnd && magnitude > resetSilencePeak) {
        resetSilencePeak = magnitude;
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
  for (let window = 0; window < windowCount; window += 1) {
    const count = Math.min(windowLen, length - window * windowLen) * channels;
    windowRms[window] = Math.sqrt(windowRms[window]! / Math.max(1, count));
  }
  return {
    peak,
    rms: Math.sqrt(sumSquares / Math.max(1, length * channels)),
    bandRms: bandRms(buffer, 150, 2000),
    windowRms,
    resetSilencePeak,
    finite,
    fadeWindowPeak: fadePeak,
    maxInterSampleStep: maxStep,
    postDeadlinePeak: postPeak,
    postDeadlineSamples: postSamples,
  };
}

/** A direct-form-I RBJ biquad (used only by the offline band-RMS measurement; no Web Audio needed). */
class Biquad {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(kind: 'lowpass' | 'highpass', fc: number, q: number, rate: number) {
    const w0 = (2 * Math.PI * fc) / rate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
    const b1 = kind === 'lowpass' ? 1 - cos : -(1 + cos);
    const b2 = kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** §7 band-limited RMS of a rendered buffer in `[lowHz, highHz]` (a high-pass then a low-pass biquad). */
function bandRms(buffer: AudioBuffer, lowHz: number, highHz: number): number {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const low = new Biquad('highpass', lowHz, 0.707, rate);
  const high = new Biquad('lowpass', highHz, 0.707, rate);
  let sum = 0;
  let count = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const y = high.process(low.process(data[i]!));
      sum += y * y;
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
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
  const engine = new AudioEngine(context, {
    unlocked: true,
    rootSeed: options.rootSeed,
    muteBuses: options.muteBuses,
    wetOnly: options.wetOnly,
    eventBoost: options.eventBoost,
  });
  const plan = scenario(options.scenario);

  let silentAt: number | null = null;
  let maxVoices = 0;
  let preparedFor = false;
  let restarted = false;
  const ticks = Math.ceil(seconds * tickHz);
  for (let i = 0; i <= ticks; i += 1) {
    const now = i / tickHz;
    const world = plan.world(now);
    // §6 every driver tick carries a *fresh* sample mark, so the support confirmation can advance.
    world.analysis.samplePerformanceSeconds = now;
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
          bandRms: 0,
          windowRms: [],
          resetSilencePeak: 0,
          finite: true,
          fadeWindowPeak: 0,
          maxInterSampleStep: 0,
          postDeadlinePeak: 0,
          postDeadlineSamples: 0,
        }
      : measure(buffer, silentAt, stats.fadeStartedAt, plan.silenceWindow);
  const status = engine.silenceStatus();
  const signature = engine.soundSignature();
  engine.dispose();
  return {
    scenario: options.scenario,
    durationSeconds: seconds,
    sampleRate,
    peak: measured.peak,
    rms: measured.rms,
    bandRms: measured.bandRms,
    windowRms: measured.windowRms,
    resetSilencePeak: measured.resetSilencePeak,
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
