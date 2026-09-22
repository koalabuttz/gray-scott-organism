/**
 * §8 audio architecture (Phase 3): the concrete §8.2 graph, the §8.1 signal engine, the §8.3 silence
 * gate, and the §3.3 `AudioSystem`.
 *
 * The module is split so the graph and the engine are usable with **both** an `AudioContext` and an
 * `OfflineAudioContext` (Test Strategy: "Audio graph factory usable with both"), which is what lets
 * `browser/audio-offline.spec.ts` render deterministic output and measure peaks, terminal zero and
 * voice bounds in-page without an audio device.
 *
 * Graph (§8.2/§2/§3/§4, palette per the Sunlit Porcelain Garden record):
 *
 *   4 PeriodicWave voices → gain → low-pass ──┐
 *   reusable noise grains → high/band/low-pass → texture gain ├→ dry bus ─┐
 *   rare 3-partial porcelain bloom → event gain ──────────────┘          │
 *                            └→ shared send → convolver → wet gain ─────┘
 *                                                        ↓
 *                       high-pass 25 Hz → compressor → master gain → mute gain
 *                                                        ├→ audio destination
 *                                                        └→ MediaStream destination
 *
 * The master gain is the **final** gain before the destinations rather than sitting before the
 * compressor (deviation 54a): Chromium's `DynamicsCompressorNode` look-ahead would otherwise leave a
 * −94 dBFS tail past the §8.3 terminal-zero deadline. A separate `muteGain` carries transport mute so
 * pause/mute never fights the silence state machine over one `AudioParam` (deviation 54b).
 *
 * Nothing is created per cell: four oscillators exist for the whole performance, grains are windowed
 * slices of one reusable noise buffer, and every one-shot source is disconnected once it ends (its
 * nodes are reaped by time in `reap`, so the live count is bounded with or without rendering).
 */
import { AUDIO } from '../config.ts';
import { Rng } from '../core/random.ts';
import type { PresentationAnalysis, WorldState } from '../core/types.ts';
import { createImpulseResponse, createNoiseBuffer } from './buffers.ts';
import { deriveSoundSeeds, type SoundSubstreamSeeds } from './substream.ts';
import {
  NEUTRAL_DEGREE,
  bandOf,
  bloomBaseHz,
  clamp,
  deriveAudioControls,
  featureScaleNorm,
  hystereticBand,
  mapVoiceFilterHz,
  neutralAudioControls,
  voicingCarriers,
  type AudioControls,
} from './voices.ts';

// ---------------------------------------------------------------------------------------------
// §8.2 graph
// ---------------------------------------------------------------------------------------------

export interface VoiceNodes {
  readonly oscillator: OscillatorNode;
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
}

interface PendingSource {
  readonly nodes: AudioNode[];
  readonly stopAt: number;
  readonly kind: 'grain' | 'event';
}

export interface GraphStats {
  /** One-shot nodes (grain/event subgraphs) created since construction. */
  nodeCreated: number;
  /** One-shot nodes disconnected by `reap`/`dispose` since construction. */
  nodeStopped: number;
  /** One-shot nodes still connected (bounded). */
  liveNodes: number;
  grainsStarted: number;
  eventsFired: number;
  maxLiveNodes: number;
}

/** §8.2 verification-only bus isolation (a render matrix measures one source group at a time). */
export type BusName = 'pad' | 'texture' | 'event';

export interface AudioGraphOptions {
  /** §4.4 recorded root seed; the `sound` substream is derived from it (MAJOR 3). */
  rootSeed?: number;
  noiseSeed?: number;
  irSeed?: number;
  noiseSeconds?: number;
  irSeconds?: number;
  /** The master gain the silence gate restores to when not silent. */
  masterLevel?: number;
  /**
   * Verification-only: bus names to **mute**, so an offline render can measure one source group in
   * isolation (`pad`/`texture`/`event`). Never set in the live system, where all three sound.
   */
  muteBuses?: readonly BusName[];
  /** Verification-only: omit the dry path so only the reverb send reaches the mix (wet-vs-dry guard). */
  wetOnly?: boolean;
  /** Verification-only: multiply the bloom peak (MINOR 5's deliberately over-loud fixture). */
  eventBoost?: number;
}

function setTarget(param: AudioParam, value: number, now: number, tau: number): void {
  param.setTargetAtTime(value, now, Math.max(1e-3, tau));
}

/**
 * §2 a voice's `PeriodicWave`: voice 0 carries harmonics `[1, 0.28, 0.10]` (a warm, softly resonant
 * body); voices 1–3 carry `[1, 0.10]`. All sine phase, divided by the absolute harmonic sum, and
 * `disableNormalization:true` so the defined waveform bound stays ≤ 1.
 */
function createVoiceWave(context: BaseAudioContext, index: number): PeriodicWave {
  const harmonics = index === 0 ? AUDIO.voice0Harmonics : AUDIO.voiceHarmonics;
  const sum = harmonics.reduce((total, value) => total + Math.abs(value), 0) || 1;
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  for (let k = 0; k < harmonics.length; k += 1) imag[k + 1] = harmonics[k]! / sum;
  return context.createPeriodicWave(real, imag, { disableNormalization: true });
}

/** §4 a full Hann window `sin²(π·t/duration)` scaled to `peak`; first and last values are exactly 0. */
function hannWindow(seconds: number, rate: number, peak: number): Float32Array {
  const length = Math.max(2, Math.round(seconds * rate));
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / (length - 1);
    const w = Math.sin(Math.PI * t);
    curve[i] = peak * w * w;
  }
  return curve;
}

/** §3 a raised-cosine attack `peak·(1 − cos(π·t))/2`; first value exactly 0, last exactly `peak`. */
function raisedCosineAttack(seconds: number, rate: number, peak: number): Float32Array {
  const length = Math.max(2, Math.round(seconds * rate));
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / (length - 1);
    curve[i] = peak * 0.5 * (1 - Math.cos(Math.PI * t));
  }
  return curve;
}

/**
 * §4.4 (MAJOR 3) resolve the sound-substream seeds for a graph. With a `rootSeed` the three seeds are
 * the `sound` substream's; without one the graph falls back to explicit `noiseSeed`/`irSeed` options or
 * the fixed config constants (a deterministic default for callers that have no performance seed).
 */
function resolveSoundSeeds(options: AudioGraphOptions): SoundSubstreamSeeds {
  if (options.rootSeed !== undefined) return deriveSoundSeeds(options.rootSeed);
  const noise = options.noiseSeed ?? AUDIO.noiseSeed;
  const ir = options.irSeed ?? AUDIO.irSeed;
  return { root: 0, noise, ir, grains: noise ^ 0x2545f491 };
}

/**
 * One scheduled leg of the intended master envelope (MAJOR 1). Kept in plain JS mirror of the
 * automation scheduled on `master.gain` so the engine can read the *intended* level at any context
 * time without trusting `AudioParam.value` — which, per the Web Audio spec, is the **intrinsic** value
 * and is never updated by `setValueAtTime`/`linearRampToValueAtTime`/`setTargetAtTime`. An offline
 * driver queues every tick against a context whose clock has not advanced, so `param.value` is stale
 * (0) and a level inferred from it collapses a terminal fade to an instant cut. The envelope mirror is
 * identical for the live and offline paths.
 */
interface MasterSegment {
  readonly start: number;
  readonly end: number;
  readonly from: number;
  readonly to: number;
  readonly curve: 'linear' | 'target';
  readonly tau?: number;
}

/** Value of one envelope leg at context time `t` (linear interpolation, or an exponential approach). */
function masterSegmentValue(segment: MasterSegment, t: number): number {
  if (segment.curve === 'linear') {
    const span = segment.end - segment.start;
    if (!(span > 0)) return segment.to;
    const f = clamp((t - segment.start) / span, 0, 1);
    return segment.from + (segment.to - segment.from) * f;
  }
  const tau = Math.max(1e-3, segment.tau ?? 1e-3);
  return segment.to + (segment.from - segment.to) * Math.exp(-(t - segment.start) / tau);
}

/**
 * §6 (MINOR 4) one leg of the **root voice's** intended gain, mirrored in plain JS exactly like the
 * master envelope. It is recorded as a real segment — including an in-flight *linear ramp* with its
 * true `from`/`to`/`end` — so `rootLevelAt` reports the actual value during a ramp rather than jumping
 * to the final endpoint, which is what let a mid-ramp presence loss keep rising and let a rapid
 * re-confirm start from a falsely-reported target.
 */
interface RootSegment {
  readonly start: number;
  readonly end: number;
  readonly from: number;
  readonly to: number;
  readonly curve: 'linear' | 'target';
  readonly tau: number;
}

/**
 * §2/§4 (TAKE-4) one hysteretic band selector — the pad's **reaction-activity** bands and the bloom's
 * **coherence** bands share it. State is deliberately plain data so it can be reasoned about across the
 * live and offline paths and reset as a unit.
 */
interface BandSelector {
  /** τ-smoothed selector value in [0,1]; null until the first valid sample initializes it. */
  smoothed: number | null;
  /** Context time of the last smoothing update (the elapsed step is capped at 1 s per fresh sample). */
  lastUpdateAt: number;
  /** The latched observed band (`0..edges.length`). */
  observed: number;
  /** The candidate band currently being confirmed, or null. */
  candidate: { band: number; since: number; samples: number; mark: number } | null;
  /** The sample mark of the last counted fresh sample — duplicates never advance anything. */
  mark: number | null;
}

/** A selector that has never seen a sample: uninitialized, latched to band 0, no candidate. */
function freshBandSelector(observed = 0): BandSelector {
  return { smoothed: null, lastUpdateAt: 0, observed, candidate: null, mark: null };
}

/**
 * Advance one band selector by one tick and report a **confirmed** band crossing.
 *
 * - `raw` is the normalized selector input; it is smoothed with `AUDIO.selectorTau` **only** on a fresh
 *   sample mark, with the elapsed step capped at 1 s (a stalled tab cannot integrate a huge step, and
 *   repeated ticks on one snapshot never advance the smoothing).
 * - The band is derived with Schmitt hysteresis, so a value sitting on a boundary cannot chatter.
 * - A candidate band must persist `AUDIO.confirmSeconds` of **real** time *and* `AUDIO.confirmSamples`
 *   distinct fresh samples; reverting to the observed band clears it, and a different candidate restarts.
 * - On confirmation the observed band is latched **regardless** of any musical permission — the caller
 *   decides separately whether the crossing may commit.
 */
function advanceBandSelector(
  selector: BandSelector,
  raw: number,
  mark: number,
  now: number,
  edges: readonly number[],
  hysteresis: number,
): number | null {
  const fresh = mark !== selector.mark;
  if (selector.smoothed === null) {
    // Initialize from the current sample.
    selector.smoothed = raw;
    selector.lastUpdateAt = now;
    selector.mark = mark;
  } else if (fresh) {
    // MAJOR 1: the smoothing step is the elapsed time since the previous **fresh** sample, not the
    // scheduler tick gap. Fresh marks can arrive every 0.5 s while ticks fire every 50 ms, so using the
    // tick gap would stretch τ = 1.5 s into ≈ 15 s and recreate the static drone the revision exists to
    // fix. Duplicates return without touching `lastUpdateAt`, so they contribute no elapsed time either.
    const elapsed = Math.min(Math.max(0, now - selector.lastUpdateAt), 1);
    const alpha = 1 - Math.exp(-elapsed / AUDIO.selectorTau);
    selector.smoothed += (raw - selector.smoothed) * alpha;
    selector.lastUpdateAt = now;
    selector.mark = mark;
  }

  const band = hystereticBand(selector.smoothed, selector.observed, edges, hysteresis);
  if (band === selector.observed) {
    selector.candidate = null;
    return null;
  }
  if (!selector.candidate || selector.candidate.band !== band) {
    selector.candidate = { band, since: now, samples: 1, mark };
    return null;
  }
  // MAJOR 3: confirmation is evaluated **only while processing a distinct fresh sample**. A duplicate
  // tick carries no new evidence, so it may never be the state-changing event that latches the band —
  // otherwise three rapid samples plus scheduler time would commit on a stale snapshot.
  if (!fresh) return null;
  selector.candidate.samples += 1;
  selector.candidate.mark = mark;
  if (
    selector.candidate.samples >= AUDIO.confirmSamples &&
    now - selector.candidate.since >= AUDIO.confirmSeconds
  ) {
    selector.observed = band;
    selector.candidate = null;
    return band;
  }
  return null;
}

/** §3 (TAKE-4) one committed pad pitch glide, mirrored in plain JS (never a read of `AudioParam.value`). */
interface PitchGlide {
  readonly from: number[];
  readonly to: number[];
  readonly start: number;
  readonly end: number;
}

/** Why a confirmed crossing did or did not move the pad degree (§9.5 diagnostics). */
export type PitchChangeReason = 'accepted' | 'refractory' | 'prohibited' | 'held';

/** One entry of the bounded pad-degree change log. */
export interface PitchChangeLogEntry {
  /** Context time of the confirmed crossing. */
  at: number;
  /** The observed band the crossing moved to. */
  band: number;
  /** The pad degree after the tick (unchanged unless accepted). */
  degree: number;
  accepted: boolean;
  reason: PitchChangeReason;
}

/** §9.5 musicality diagnostics: exactly what a reviewer needs to see *why* the pad moved or did not. */
export interface PitchDiagnostics {
  activityX: number | null;
  observedBand: number;
  padDegree: number;
  coherenceX: number | null;
  bloomDegree: number;
  bloomRegister: 'coarse' | 'fine';
  /** The settled (target) carriers of the current pad degree, in voice order. */
  carriers: number[];
  lastCommitAt: number | null;
  /** Confirmed crossings observed (all of them, permitted or not). */
  crossings: number;
  /** Crossings that were admissible, i.e. eligible to commit (accepted + refractory-dropped + held). */
  eligibleCrossings: number;
  acceptedChanges: number;
  droppedRefractory: number;
  droppedProhibited: number;
  /** §4 the most recent bloom: its scale note, degree, register and context time (null before any). */
  lastBloom: { at: number; baseHz: number; degree: number; register: 'coarse' | 'fine' } | null;
}

/**
 * §3 (TAKE-4) resolution of one pad pitch glide: 129 points over the 1.25 s glide is ≈ 10 ms per step,
 * so the linearly-interpolated `setValueCurveAtTime` curve tracks the exact `f0·(f1/f0)^u` logarithm
 * far more closely than any pitch perception threshold.
 */
const PITCH_CURVE_POINTS = 129;

/** §9.5 how many pad-degree change-log entries are retained for diagnostics. */
const PITCH_LOG_LIMIT = 64;

/**
 * §8 live-path instrumentation: the default FFT size for the destination-tapped analyser. 8192 gives a
 * 5.9 Hz bin at 48 kHz — fine enough to resolve the deep fundamental band (≈55–110 Hz) — over a 170 ms
 * window that is short enough to catch a drone as it rises.
 */
const OUTPUT_FFT_SIZE = 8192;

/** One destination-tapped output sample (see `AudioGraph.outputMeasurement`). */
export interface OutputMeasurement {
  /** Time-domain RMS of the last FFT window (linear, 1.0 = full scale). */
  rms: number;
  /** Time-domain peak of the last FFT window (linear). */
  peak: number;
  /** Frequency of the strongest magnitude bin, i.e. an estimate of the sounding fundamental. */
  dominantHz: number;
  /** Width of one FFT bin in Hz (`sampleRate / fftSize`). */
  binHz: number;
  /** The full magnitude spectrum in dBFS, index * `binHz` = frequency. */
  spectrumDb: number[];
}

/**
 * The fixed §8.2 node graph. Constructed once; the engine drives its parameters and schedules its
 * one-shot grains and events. `realtime` contexts also get a `MediaStreamAudioDestinationNode` for
 * the recorder; an `OfflineAudioContext` does not (and needs none).
 */
export class AudioGraph {
  readonly context: BaseAudioContext;
  readonly voices: VoiceNodes[] = [];
  readonly dryBus: GainNode;
  readonly textureBus: GainNode;
  readonly textureHighpass: BiquadFilterNode;
  readonly textureBandpass: BiquadFilterNode;
  readonly textureLowpass: BiquadFilterNode;
  readonly textureGain: GainNode;
  readonly eventGain: GainNode;
  readonly sendGain: GainNode;
  readonly convolver: ConvolverNode;
  readonly wetGain: GainNode;
  readonly mixBus: GainNode;
  readonly highpass: BiquadFilterNode;
  readonly master: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly muteGain: GainNode;
  readonly mediaStreamDestination: MediaStreamAudioDestinationNode | null;
  /** The reusable noise buffer (grains + event impulse). Replaced on a fresh-performance reseed. */
  noiseBuffer: AudioBuffer;

  private readonly masterLevel: number;
  private readonly noiseSeconds: number;
  private readonly irSeconds: number;
  /**
   * §8.2 verification-only bus isolation: false for a bus named in `muteBuses`. A muted bus is forced
   * to silence wherever it would otherwise contribute, so an offline render can measure one group.
   */
  private readonly busEnabled = { pad: true, texture: true, event: true };
  /**
   * §6 (MINOR 4) the root voice's intended gain, mirrored in plain JS like the master envelope, so the
   * bounded reveal raise can start from the *intended* level rather than a stale `AudioParam.value`.
   */
  /**
   * §6 (MINOR 4) the root voice's intended gain, mirrored in plain JS like the master envelope, so the
   * bounded reveal raise can start from the *intended* level rather than a stale `AudioParam.value` and
   * an in-flight ramp is reported truthfully.
   */
  private rootSegment: RootSegment | null = null;
  /** Verification-only event-level multiplier (MINOR 5: an over-loud fixture that must fail the guard). */
  private readonly eventBoost: number;
  // §4.4 sound substream: the seeds the noise/IR were generated from. Kept so a reseed can rebuild
  // them and the signature can report which substream is live.
  private soundSeeds: SoundSubstreamSeeds;
  private pending: PendingSource[] = [];
  /**
   * One-shot nodes already retired from the live accounting whose `disconnect()` is deferred to
   * `dispose()` because the context has not rendered them yet (see `reap`).
   */
  private retired: AudioNode[] = [];
  private nodeCreated = 0;
  private nodeStopped = 0;
  private grainsStarted = 0;
  private eventsFired = 0;
  private maxLiveNodes = 0;
  private disposed = false;
  // MAJOR 1: the intended master envelope, mirrored in plain JS (see `MasterSegment`). The anchor is
  // the level the envelope starts from; the segments are the scheduled legs after it. Initialised to
  // the graph's zero so `masterLevelAt` is correct before any scheduling.
  private masterAnchor = { time: Number.NEGATIVE_INFINITY, level: 0 };
  /**
   * §5 (TAKE-5) per-voice end of the last scheduled pitch-glide **curve**. A value curve whose start
   * precedes a later `cancelScheduledValues(t)` survives that cancel, so an immediate pitch set placed
   * inside it would hit the same `NotSupportedError` the bloom did. Tracking the mirrored curve end
   * lets the immediate set land at or after it instead.
   */
  private readonly pitchCurveEnd: number[] = [];
  private masterSegments: MasterSegment[] = [];
  /** §8 live-path instrumentation: lazily-created destination tap (`attachOutputAnalyser`). */
  private analyser: AnalyserNode | null = null;

  constructor(context: BaseAudioContext, options: AudioGraphOptions = {}) {
    this.context = context;
    this.masterLevel = options.masterLevel ?? AUDIO.masterLevel;
    this.noiseSeconds = options.noiseSeconds ?? AUDIO.noiseSeconds;
    this.irSeconds = options.irSeconds ?? AUDIO.irSeconds;
    // §4.4 (MAJOR 3): the noise/IR/grain seeds come from the recorded root seed's `sound` substream
    // when one is supplied; the explicit seeds / fixed constants remain as a fallback for callers that
    // have no performance seed (e.g. a one-off graph probe).
    this.soundSeeds = resolveSoundSeeds(options);
    // §8.2 verification-only bus isolation (offline render matrix); never set in the live system.
    if (options.muteBuses) {
      for (const bus of options.muteBuses) this.busEnabled[bus] = false;
    }
    this.eventBoost = options.eventBoost ?? 1;

    // The dry bus is the single merge point for the three source groups (§8.2).
    this.dryBus = context.createGain();
    this.dryBus.gain.value = 1;

    // --- §2 four logical voices ---------------------------------------------
    // Removal-priority order from the §3 scale-aware voicing table. Each is a `PeriodicWave` on the
    // existing built-in `OscillatorNode` — a warm body of restrained even harmonics, never a
    // triangle/saw drone, and never detuned (TAKE-4: `maxDetuneCents = 0`, no beating). Non-finite
    // pitch is impossible: `voicingCarriers` is a total function of the integer degree.
    const neutralCarriers = voicingCarriers(NEUTRAL_DEGREE);
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      const oscillator = context.createOscillator();
      oscillator.setPeriodicWave(createVoiceWave(context, i));
      oscillator.frequency.value = neutralCarriers[i] ?? AUDIO.tonicHz;
      const gain = context.createGain();
      gain.gain.value = 0;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = AUDIO.voiceFilterMaxHz;
      filter.Q.value = AUDIO.voiceFilterQ;
      oscillator.connect(gain).connect(filter).connect(this.dryBus);
      oscillator.start();
      this.voices.push({ oscillator, gain, filter });
    }

    // --- §4 soft shimmer: grains → high/band/low-pass → texture gain --------
    this.textureBus = context.createGain();
    this.textureHighpass = context.createBiquadFilter();
    this.textureHighpass.type = 'highpass';
    this.textureHighpass.frequency.value = AUDIO.textureHighpassHz;
    this.textureHighpass.Q.value = AUDIO.textureHighpassQ;
    this.textureBandpass = context.createBiquadFilter();
    this.textureBandpass.type = 'bandpass';
    this.textureBandpass.frequency.value = AUDIO.grainFilterMinHz;
    this.textureBandpass.Q.value = AUDIO.textureBandpassQ;
    this.textureLowpass = context.createBiquadFilter();
    this.textureLowpass.type = 'lowpass';
    this.textureLowpass.frequency.value = AUDIO.textureLowpassHz;
    this.textureLowpass.Q.value = AUDIO.textureLowpassQ;
    this.textureGain = context.createGain();
    this.textureGain.gain.value = 0;
    this.textureBus
      .connect(this.textureHighpass)
      .connect(this.textureBandpass)
      .connect(this.textureLowpass)
      .connect(this.textureGain)
      .connect(this.dryBus);

    // --- rare porcelain bloom: three sine partials → event gain (see `spawnEvent`)
    this.eventGain = context.createGain();
    this.eventGain.gain.value = 1;
    this.eventGain.connect(this.dryBus);

    // --- shared send → convolver → wet gain ----------------------------------
    this.convolver = context.createConvolver();
    this.convolver.buffer = createImpulseResponse(
      context,
      this.irSeconds,
      this.soundSeeds.ir,
    );
    this.convolver.normalize = true;
    this.sendGain = context.createGain();
    this.sendGain.gain.value = 1;
    this.wetGain = context.createGain();
    this.wetGain.gain.value = AUDIO.wetMin;
    this.dryBus.connect(this.sendGain).connect(this.convolver).connect(this.wetGain);

    // --- mix bus → high-pass 25 Hz → master → compressor → destinations ------
    this.mixBus = context.createGain();
    this.mixBus.gain.value = 1;
    // §5 wet-vs-dry verification: `wetOnly` omits the dry path so only the reverb send reaches the mix.
    if (!options.wetOnly) this.dryBus.connect(this.mixBus);
    this.wetGain.connect(this.mixBus);
    this.highpass = context.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = AUDIO.highpassHz;
    this.highpass.Q.value = 0.5;
    this.master = context.createGain();
    // §8.3/§2.3 (MAJOR 2): the master starts at exactly zero. A locked context produces no sound, and
    // the locked→running activation edge fades up from zero, so resuming never jumps to the live level
    // (or plays a catch-up burst). A graph constructed already-unlocked is anchored at the live level
    // by the engine, which has nothing scheduled to burst.
    this.master.gain.value = 0;
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = AUDIO.compressor.thresholdDb;
    this.compressor.knee.value = AUDIO.compressor.kneeDb;
    this.compressor.ratio.value = AUDIO.compressor.ratio;
    this.compressor.attack.value = AUDIO.compressor.attackSeconds;
    this.compressor.release.value = AUDIO.compressor.releaseSeconds;
    this.muteGain = context.createGain();
    this.muteGain.gain.value = 1;
    // §8.3 requires the master's terminal assignment to yield *digitally zero* output. Chromium's
    // DynamicsCompressorNode has a ~6 ms look-ahead delay, so a master gain placed before it would
    // leave a −94 dBFS tail past the deadline. The master gain is therefore the final gain in the
    // chain (compressor → master → mute), which keeps the §8.2 signal order intact and makes the
    // sample-inspection assertion exact (deviation 54).
    this.mixBus
      .connect(this.highpass)
      .connect(this.compressor)
      .connect(this.master)
      .connect(this.muteGain);
    this.muteGain.connect(context.destination);
    this.mediaStreamDestination =
      typeof (context as AudioContext).createMediaStreamDestination === 'function'
        ? (context as AudioContext).createMediaStreamDestination()
        : null;
    if (this.mediaStreamDestination) this.muteGain.connect(this.mediaStreamDestination);

    this.noiseBuffer = createNoiseBuffer(context, this.noiseSeconds, this.soundSeeds.noise);
  }

  // --- parameter application ------------------------------------------------

  /**
   * §2/§6 apply a voice's **gain** and **filter** targets. Pitch is deliberately *not* handled here: it
   * has its own idempotent path (`applyPitchGlide` / `applyPitchImmediate`), so a per-tick control pass
   * can never overwrite a scheduled glide (TAKE-4 §5).
   */
  applyVoice(
    index: number,
    values: { level: number; filterHz: number },
    now: number,
    taus: { levelTau: number; filterTau: number },
  ): void {
    const voice = this.voices[index];
    if (!voice) return;
    setTarget(voice.filter.frequency, values.filterHz, now, taus.filterTau);
    const level = this.busEnabled.pad ? values.level : 0;
    // §6 (MINOR 4) mirror the root's intended gain so a later bounded reveal can start from it.
    if (index === 0) {
      this.rootSegment = {
        start: now,
        end: Number.POSITIVE_INFINITY,
        from: this.rootLevelAt(now),
        to: level,
        curve: 'target',
        tau: taus.levelTau,
      };
    }
    setTarget(voice.gain.gain, level, now, taus.levelTau);
  }

  /**
   * The root voice's intended gain at `t`, from the JS mirror (never a scheduled `AudioParam.value`).
   * Reports the true **in-flight** value of a linear ramp, not its endpoint (MINOR 4).
   */
  rootLevelAt(t: number): number {
    const segment = this.rootSegment;
    if (!segment) return 0;
    if (t <= segment.start) return segment.from;
    if (t >= segment.end && segment.curve === 'linear') return segment.to;
    return masterSegmentValue(segment, t);
  }

  /**
   * §6 (MINOR 4) abandon an in-flight root reveal: cancel the scheduled ramp (including its positive
   * endpoint) and re-anchor the mirror and the param at the **mirrored in-flight level**, so the caller
   * can then apply a bounded *downward* transition — no continuing upward automation, and no
   * instantaneous upward set.
   */
  abandonRootReveal(now: number): void {
    const voice = this.voices[0];
    if (!voice) return;
    const held = this.rootLevelAt(now);
    const param = voice.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(held, now);
    this.rootSegment = { start: now, end: now, from: held, to: held, curve: 'linear', tau: 1e-3 };
  }

  /** §2/§6 glide a voice's filter only (used while a dedicated root envelope drives its gain). */
  applyVoiceTone(
    index: number,
    values: { filterHz: number },
    now: number,
    taus: { filterTau: number },
  ): void {
    const voice = this.voices[index];
    if (!voice) return;
    setTarget(voice.filter.frequency, values.filterHz, now, taus.filterTau);
  }

  /**
   * §3 (TAKE-4) the pad's own **pitch** path: one bounded logarithmic glide per committed degree change,
   * shared start/end across all four voices, scheduled once as a `setValueCurveAtTime` curve so it is
   * idempotent — a per-tick control pass can never fight or restart it. No phase retrigger, no gain
   * boost, no vibrato: the curve is exactly `f0 · (f1/f0)^u`.
   */
  applyPitchGlide(from: readonly number[], to: readonly number[], now: number, seconds: number): number {
    const duration = Math.max(1e-3, seconds);
    // §5 (TAKE-5) guarded start (see `curveWindow`), and never inside an earlier glide's still-pending
    // curve: the ≥ 12 s degree refractory with a 1.25 s glide already makes an overlap impossible, and
    // this clamp keeps that true whatever the constants become.
    const { start } = this.curveWindow(now, duration);
    const glideStart = Math.max(start, ...this.voices.map((_, index) => this.pitchCurveEnd[index] ?? Number.NEGATIVE_INFINITY));
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      if (!voice) continue;
      const f0 = clamp(from[i] ?? to[i] ?? AUDIO.tonicHz, 1, 20000);
      const f1 = clamp(to[i] ?? f0, 1, 20000);
      const curve = new Float32Array(PITCH_CURVE_POINTS);
      for (let point = 0; point < PITCH_CURVE_POINTS; point += 1) {
        const u = point / (PITCH_CURVE_POINTS - 1);
        curve[point] = f0 * Math.pow(f1 / f0, u);
      }
      const param = voice.oscillator.frequency;
      param.cancelScheduledValues(glideStart);
      param.setValueCurveAtTime(curve, glideStart, duration);
      this.pitchCurveEnd[i] = glideStart + duration;
    }
    // The caller builds its glide mirror from this, so the mirror and the scheduled curve agree.
    return glideStart;
  }

  /**
   * §5 (TAKE-4) set all four carriers **immediately** — the silent preparation before a reveal, or the
   * post-reset neutral A target. Never a glide: this is the "no change without a crossing" endpoint.
   */
  applyPitchImmediate(carriers: readonly number[], now: number): void {
    // §5 (TAKE-5) guarded instant: a pending glide curve survives `cancelScheduledValues` when its start
    // precedes the cancel time, so the immediate set is placed at or after that curve's mirrored end and
    // can never land strictly inside it (the bloom's overlap class, in the pitch path).
    const { start } = this.curveWindow(now, 0);
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      if (!voice) continue;
      const hz = clamp(carriers[i] ?? AUDIO.tonicHz, 1, 20000);
      const param = voice.oscillator.frequency;
      const at = Math.max(start, this.pitchCurveEnd[i] ?? Number.NEGATIVE_INFINITY);
      param.cancelScheduledValues(at);
      param.setValueAtTime(hz, at);
      this.pitchCurveEnd[i] = at;
    }
  }

  /**
   * §6 from exact silence: prepare the root behind the **zero** master — set its filter and gain
   * immediately so the reveal does not glide from a placeholder and there is no second root envelope in
   * series with the master reveal. Pitch is initialized separately (`applyPitchImmediate`).
   */
  prepareRoot(values: { level: number; filterHz: number }, now: number): void {
    const voice = this.voices[0];
    if (!voice) return;
    const level = this.busEnabled.pad ? values.level : 0;
    voice.filter.frequency.cancelScheduledValues(now);
    voice.filter.frequency.setValueAtTime(values.filterHz, now);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(level, now);
    this.rootSegment = { start: now, end: now, from: level, to: level, curve: 'linear', tau: 1e-3 };
  }

  applyTexture(values: { level: number; filterHz: number }, now: number, tau: number): void {
    const level = this.busEnabled.texture ? values.level : 0;
    setTarget(this.textureGain.gain, level, now, tau);
    setTarget(this.textureBandpass.frequency, values.filterHz, now, AUDIO.filterTau);
  }

  applyWet(gain: number, now: number, tau: number): void {
    setTarget(this.wetGain.gain, gain, now, tau);
  }

  // --- master envelope (MAJOR 1) --------------------------------------------

  /**
   * The intended master level at context time `t`, from the plain-JS envelope mirror rather than from
   * `AudioParam.value` (which is the intrinsic value and is never updated by scheduling). Every master
   * transition anchors from this, so the live and offline paths behave identically and a stale
   * `param.value` can never collapse a terminal fade to an instant cut.
   */
  masterLevelAt(t: number): number {
    const segments = this.masterSegments;
    if (segments.length === 0) return this.masterAnchor.level;
    for (const segment of segments) {
      if (t < segment.start) return segment.from;
      if (t <= segment.end) return masterSegmentValue(segment, t);
    }
    return segments[segments.length - 1]!.to;
  }

  /** Discard the envelope mirror and re-anchor it at `level` from `time` (after a cancel). */
  private anchorEnvelope(time: number, level: number): void {
    this.masterAnchor = { time, level };
    this.masterSegments = [];
  }

  setMasterLevel(level: number, now: number, tau: number): void {
    const param = this.master.gain;
    const from = this.masterLevelAt(now);
    const targetTau = Math.max(1e-3, tau);
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    param.setTargetAtTime(level, now, targetTau);
    this.anchorEnvelope(now, from);
    this.masterSegments.push({
      start: now,
      end: Number.POSITIVE_INFINITY,
      from,
      to: level,
      curve: 'target',
      tau: targetTau,
    });
  }

  /**
   * Terminally bounded fade (§8.3): hold the **tracked** live level, ramp to 0 and then **assign** 0 at
   * the deadline with `setValueAtTime`, because `setTargetAtTime` only approaches its target
   * asymptotically. After the deadline the rendered samples are digitally zero. MAJOR 1: the starting
   * level comes from the envelope mirror, never `param.value`, so a fade queued against a future context
   * time (the offline driver) fades from the real level rather than collapsing to an instant cut; the
   * returned deadline is the true fade end.
   */
  beginTerminalFade(now: number, fadeSeconds: number): number {
    const param = this.master.gain;
    const live = this.masterLevelAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(live, now);
    if (live <= 1e-6) {
      param.setValueAtTime(0, now);
      this.anchorEnvelope(now, 0);
      return now;
    }
    const deadline = now + fadeSeconds;
    param.linearRampToValueAtTime(0, deadline);
    param.setValueAtTime(0, deadline);
    this.anchorEnvelope(now, live);
    this.masterSegments.push({ start: now, end: deadline, from: live, to: 0, curve: 'linear' });
    return deadline;
  }

  /**
   * §6 unified reveal/activation: cancel a **general absence fade** (never a stillness/kill-wait fade —
   * the engine refuses to reveal when stillness is armed), re-anchor from the mirrored current gain and
   * ramp **linearly** to the live master level over `seconds`, ending with an assignment so the level is
   * exact. Reveal and activation are this one envelope operation, never serial fades.
   */
  revealMaster(now: number, seconds: number): number {
    const param = this.master.gain;
    const from = this.masterLevelAt(now);
    const end = now + Math.max(1e-3, seconds);
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    param.linearRampToValueAtTime(this.masterLevel, end);
    param.setValueAtTime(this.masterLevel, end);
    this.anchorEnvelope(now, from);
    this.masterSegments.push({ start: now, end, from, to: this.masterLevel, curve: 'linear' });
    return end;
  }

  /** Smooth mute for pause/hidden-tab/context loss; no backlog is ever replayed. */
  setMuted(muted: boolean, now: number, tau = 0.15): void {
    setTarget(this.muteGain.gain, muted ? 0 : 1, now, tau);
  }

  // --- fresh-performance / activation master transitions --------------------

  /**
   * §8.3 fresh-performance anchor: synchronously cancel **all** scheduled master automation (so a stale
   * terminal fade from an abandoned episode can never reach its deadline and silence the new
   * performance) while **holding the computed live level** rather than stepping to zero. Used by the
   * activation edge's silent branches, which do not ramp. A field-replacing reset does **not** use this:
   * an audible reset de-clicks to zero (`declickToZero`) and an inaudible one anchors zero
   * (`anchorMasterAtZero`).
   */
  cancelMasterAutomation(now: number): void {
    const param = this.master.gain;
    const live = this.masterLevelAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(live, now);
    this.anchorEnvelope(now, live);
  }

  /**
   * §6 (MAJOR 1) anchor the master at **exactly zero** — both the scheduled param and the JS mirror.
   * This is what an *inaudible* reset (paused, muted or locked) must do instead of merely cancelling:
   * `cancelMasterAutomation` would **hold** the prior mirrored level (~0.75) in the mirror, so a later
   * resume/unmute would see a nonzero master and take the "master already live" branch — only the 0.75 s
   * root raise, with the mute release (~0.15 s) bringing the fresh field back fast and loud instead of
   * through the unified 1.5 s reveal. Anchoring zero keeps the exact-silence branch (and therefore the
   * unified reveal) reachable once support re-confirms.
   */
  anchorMasterAtZero(now: number): void {
    const param = this.master.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(0, now);
    this.anchorEnvelope(now, 0);
  }

  /**
   * §8.3/§6 (MAJOR 1) de-clicked fresh-performance transition: hold the computed live level at `now`,
   * ramp linearly to exactly zero over `declickSeconds` (80–150 ms) and **stay at zero**. Returns the
   * zero instant so the caller can defer the buffer/IR swap and the source silencing to it. A restart
   * therefore never steps a live master to zero (no click) and — crucially — does **not** ramp back up:
   * a field-replacing reset leaves the master at zero until the *new* field confirms presence, at which
   * point the unified 1.5 s reveal brings it back (the presence state machine owns that rise).
   */
  declickToZero(now: number, declickSeconds: number): number {
    const param = this.master.gain;
    const live = this.masterLevelAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(live, now);
    this.anchorEnvelope(now, live);
    const zeroAt = now + Math.max(1e-3, declickSeconds);
    param.linearRampToValueAtTime(0, zeroAt);
    param.setValueAtTime(0, zeroAt);
    this.masterSegments.push({ start: now, end: zeroAt, from: live, to: 0, curve: 'linear' });
    return zeroAt;
  }

  /**
   * §6 (MAJOR 1/2) clear every piece of episode-scoped state at the reset's zero instant (the master is
   * exactly zero there, so all of this is inaudible):
   *
   *  - retire **every** in-flight one-shot: the `pending` sources (porcelain blooms live up to 3.42 s,
   *    grains up to 1.2 s) are stopped and disconnected, and the already-retired nodes are disconnected;
   *  - force the four pad voices, the texture bus **and the event bus** to exactly zero, so no stale pad
   *    target, bloom or grain survives into the freshly seeded field (a new bloom re-asserts unity on the
   *    event bus at its own start time, so the event path keeps working);
   *  - flush the wet path by reassigning the convolver's impulse response (a fresh, deterministic buffer
   *    from the current sound substream), which resets the convolver's **internal history** so its tail
   *    — up to the full 2.4 s IR — cannot leak into the new field's reveal.
   *
   * This is the guaranteed-state-clear for the "no old event/tail leaks into the new reveal" contract
   * (spec §10.5).
   */
  clearEpisodeState(now: number): void {
    for (const entry of this.pending) {
      for (const node of entry.nodes) {
        const source = node as Partial<AudioScheduledSourceNode>;
        if (typeof source.stop === 'function') {
          try {
            source.stop(now);
          } catch {
            // Never started, or already stopped: nothing to do.
          }
        }
        try {
          node.disconnect();
        } catch {
          // Already torn down with the context; nothing to do.
        }
      }
      this.nodeStopped += entry.nodes.length;
    }
    this.pending = [];
    for (const node of this.retired) {
      try {
        node.disconnect();
      } catch {
        // Already torn down with the context; nothing to do.
      }
    }
    this.retired = [];
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
      // §5 (TAKE-4) pitch automation is part of the episode state too: a glide in flight is cancelled
      // here so a reset can never leave the fresh field sliding from the old key.
      voice.oscillator.frequency.cancelScheduledValues(now);
    }
    this.textureGain.gain.cancelScheduledValues(now);
    this.textureGain.gain.setValueAtTime(0, now);
    this.eventGain.gain.cancelScheduledValues(now);
    this.eventGain.gain.setValueAtTime(0, now);
    this.rootSegment = null;
    // Flush the convolver's internal history with a fresh, deterministic IR.
    this.convolver.buffer = createImpulseResponse(this.context, this.irSeconds, this.soundSeeds.ir);
  }

  /**
   * §6 (MINOR 4) the dedicated root raise with an explicit endpoint: ramp the root voice linearly from
   * its **mirrored** current level to `level` over `seconds` and assign the endpoint exactly, returning
   * the end time. Used when the master is already live and presence turns eligible, so a source gain is
   * never stepped and the raise is a bounded 0.75 s transition rather than an asymptotic approach. The
   * caller suppresses the ordinary per-tick root gain target until the returned time.
   */
  revealVoice(index: number, level: number, now: number, seconds: number): number {
    const voice = this.voices[index];
    if (!voice) return now;
    const target = this.busEnabled.pad ? level : 0;
    const from = this.rootLevelAt(now);
    const param = voice.gain.gain;
    const end = now + Math.max(1e-3, seconds);
    param.cancelScheduledValues(now);
    param.setValueAtTime(from, now);
    param.linearRampToValueAtTime(target, end);
    param.setValueAtTime(target, end);
    // MINOR 4: record the *true* linear segment (start/end/from/to), not a constant at the endpoint, so
    // `rootLevelAt` reports the real in-flight value during the ramp.
    if (index === 0) {
      this.rootSegment = { start: now, end, from, to: target, curve: 'linear', tau: 1e-3 };
    }
    return end;
  }

  /** Anchor the master at the live level immediately (a fresh, unlocked context with nothing scheduled). */
  anchorMasterLevel(now: number): void {
    const param = this.master.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(this.masterLevel, now);
    this.anchorEnvelope(now, this.masterLevel);
  }

  // --- §4.4 sound-substream reseed ------------------------------------------

  /**
   * Rebuild the reusable noise buffer and the convolver impulse response from the supplied §4.4 sound
   * substream seeds, without touching any live voice (MAJOR 3). Existing grain/event sources keep the
   * buffer they were started with and finish out; new ones use the replacement, and the convolver
   * swaps its IR. A fresh-performance reseed is deferred to the de-click's zero instant (§8.3, MAJOR 2),
   * so the swap happens while the master is at zero and is inaudible.
   */
  reseedSound(seeds: SoundSubstreamSeeds): void {
    this.soundSeeds = seeds;
    this.noiseBuffer = createNoiseBuffer(this.context, this.noiseSeconds, seeds.noise);
    this.convolver.buffer = createImpulseResponse(this.context, this.irSeconds, seeds.ir);
  }

  /** The §4.4 sound substream the graph is currently generating from. */
  soundSubstream(): SoundSubstreamSeeds {
    return this.soundSeeds;
  }

  /**
   * A cheap deterministic fingerprint of the live stochastic material (first 64 samples of each IR
   * channel and of the noise buffer, plus the seeds), so a test can assert that the same root seed
   * produces identical material and a different seed produces different material.
   */
  soundSignature(): { root: number; noise: number; ir: number; grains: number; checksum: number } {
    const sum = (buffer: AudioBuffer, channel: number, count: number): number => {
      const data = buffer.getChannelData(channel);
      let total = 0;
      const limit = Math.min(count, data.length);
      for (let i = 0; i < limit; i += 1) total += data[i]!;
      return total;
    };
    const checksum =
      sum(this.noiseBuffer, 0, 64) +
      sum(this.convolver.buffer ?? this.noiseBuffer, 0, 64) +
      sum(this.convolver.buffer ?? this.noiseBuffer, 1, 64);
    return { ...this.soundSeeds, checksum };
  }

  // --- live-path instrumentation --------------------------------------------

  /**
   * §8 verification instrumentation: a destination-tapped `AnalyserNode`. `muteGain` is the **final**
   * node before the audio destination (deviation 54a), so an analyser connected to it measures exactly
   * what the hardware would receive — after the compressor, master envelope and mute. Created lazily on
   * first use, so normal playback and the offline render pay nothing for it.
   */
  attachOutputAnalyser(fftSize = OUTPUT_FFT_SIZE): AnalyserNode {
    if (!this.analyser) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = fftSize;
      // No smoothing: the caller averages over its own sampling window, and a smoothed spectrum would
      // make a just-started drone read as present before it really is.
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -140;
      this.muteGain.connect(analyser);
      this.analyser = analyser;
    }
    return this.analyser;
  }

  /**
   * The most recent destination-tapped output measurement: time-domain RMS/peak and the full magnitude
   * spectrum plus its dominant bin. Null until `attachOutputAnalyser()` has run. This is the live
   * analogue of `offline.ts`'s `measure()` — it is how `audio-audible.spec.ts` proves real sound
   * reaches the destination rather than trusting a gain *value*.
   */
  outputMeasurement(): OutputMeasurement | null {
    const analyser = this.analyser;
    if (!analyser) return null;
    const time = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(time);
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < time.length; i += 1) {
      const value = time[i]!;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      sumSquares += value * value;
    }
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spectrum);
    let bestBin = 0;
    let bestDb = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < spectrum.length; i += 1) {
      const db = spectrum[i]!;
      if (db > bestDb) {
        bestDb = db;
        bestBin = i;
      }
    }
    const binHz = this.context.sampleRate / analyser.fftSize;
    return {
      rms: Math.sqrt(sumSquares / Math.max(1, time.length)),
      peak,
      dominantHz: bestBin * binHz,
      binHz,
      spectrumDb: Array.from(spectrum),
    };
  }

  /**
   * §8 verification: the live `AudioParam.value` of every gain in the graph — master, mute, each voice,
   * texture, event, wet, dry and the mix/send buses. Read straight from the scheduled params, so a
   * caller can see *where* a chain is losing signal (e.g. master at 0, or voices never opened).
   */
  gainSnapshot(): {
    master: number;
    mute: number;
    voices: number[];
    texture: number;
    event: number;
    wet: number;
    dry: number;
    mix: number;
    send: number;
  } {
    return {
      master: this.master.gain.value,
      mute: this.muteGain.gain.value,
      voices: this.voices.map((voice) => voice.gain.gain.value),
      texture: this.textureGain.gain.value,
      event: this.eventGain.gain.value,
      wet: this.wetGain.gain.value,
      dry: this.dryBus.gain.value,
      mix: this.mixBus.gain.value,
      send: this.sendGain.gain.value,
    };
  }

  // --- one-shot sources -----------------------------------------------------

  /**
   * §3/§4 (TAKE-5) the guarded scheduling window for a value curve of `duration` seconds — the single
   * place the envelope-mirror guard lives, so every curve in the graph is scheduled consistently.
   *
   * Chromium snaps a `setValueCurveAtTime` start forward to the current render quantum when the
   * requested time is at or behind the audio clock. A later leg of the same envelope anchored to the
   * *requested* time (the bloom's `setTargetAtTime` decay at `when + 0.18`) then falls strictly inside
   * the curve's **real** interval, and the browser throws
   * `NotSupportedError: setTargetAtTime(...) overlaps setValueCurveAtTime(...)`, aborting the rest of
   * the envelope (43 uncaught exceptions in a 120-minute soak; the decay and the terminal fade to exact
   * zero were never scheduled).
   *
   * `start` is pushed to at least `curveLeadMs` ahead of the clock — never pulled earlier, so a caller's
   * future time is passed through untouched (the offline driver queues ticks against a context whose
   * clock does not advance, and must keep its queued times). With `start` comfortably ahead of the clock
   * no snap can occur, so the curve's analytic end **is** its real end; `end` additionally takes the
   * clock-anchored bound so the mirror stays truthful even if `curveLeadMs` were ever reduced to zero.
   */
  private curveWindow(when: number, duration: number): { start: number; end: number } {
    const clock = this.context.currentTime;
    const start = Math.max(when, clock + AUDIO.curveLeadMs / 1000);
    const end = Math.max(start + duration, clock + AUDIO.curveMarginMs / 1000 + duration);
    return { start, end };
  }

  /**
   * §4 a softly-shimmering grain: a full-Hann-windowed slice of the reusable noise buffer (first and
   * last values exactly zero, peak `AUDIO.grainPeak`), scheduled with `setValueCurveAtTime`. Grains
   * route through the shared high/band/low-pass chain.
   */
  spawnGrain(when: number, spec: { seconds: number; offset: number; level: number }): void {
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const env = this.context.createGain();
    env.gain.value = 0;
    source.connect(env).connect(this.textureBus);
    const level = this.busEnabled.texture ? spec.level : 0;
    // §3/§4 (TAKE-5) guarded window. A grain's Hann curve is the only automation on this envelope (no
    // follow-up leg can overlap it), but the curve is still scheduled from a clock-anchored time so the
    // window is never snapped and `start`/`stop`/reap all name the same instant.
    const { start, end } = this.curveWindow(when, spec.seconds);
    env.gain.setValueCurveAtTime(
      hannWindow(spec.seconds, this.context.sampleRate, level),
      start,
      spec.seconds,
    );
    source.start(start, spec.offset, spec.seconds);
    source.stop(end + 0.02);
    this.track([source, env], end + 0.02, 'grain');
    this.grainsStarted += 1;
  }

  /**
   * §3 a soft porcelain bloom — a three-partial additive resonant excitation (an intentional palette
   * amendment to the old §8.2 Q = 8 noise-burst subgraph). Three temporary sine oscillators at
   * `[1, 2, 3] × bellBaseHz` with normalised amplitudes `[0.72, 0.21, 0.07]` all start together, take a
   * raised-cosine 120 ms attack and then an exponential decay τ 0.85 / 0.55 / 0.35 s; from 3.3 s a
   * 100 ms bounded terminal fade brings them to exact zero and every node is stopped by 3.42 s. Peak
   * gain is `AUDIO.eventLevelMax · clamp(0.4 + strength, 0.4, 1)` — no noise transient, detune, pitch
   * bend or mallet click. The pitch is sampled **once** and held, so unchanged geometry gives the same
   * pitch and a different geometry a different one. Three partials count as one event.
   */
  spawnEvent(when: number, spec: { baseHz: number; strength: number }): void {
    if (!this.busEnabled.event) return;
    // §4 (TAKE-4) the engine selects the scale note (bloom degree + register) and hands over an exact
    // base frequency; the graph never derives pitch from a smoothed pad root, so an in-flight pad glide
    // can never be quantized by a bloom.
    const baseHz = clamp(spec.baseHz, AUDIO.fundamentalMinHz, 20000);
    const eventPeak = AUDIO.eventLevelMax * clamp(0.4 + spec.strength, 0.4, 1) * this.eventBoost;
    const attack = AUDIO.bloomAttackSeconds;
    // §3/§4 (TAKE-5) guarded window (see `curveWindow`). The decay is referenced to the attack curve's
    // **mirrored real end**, so its τ is still measured from the true end of the attack — the audible
    // shape is preserved exactly — while the decay can no longer be scheduled inside the curve.
    const { start, end: curveEnd } = this.curveWindow(when, attack);
    const fadeStart = AUDIO.bloomTerminalFadeStart;
    const fadeEnd = fadeStart + AUDIO.bloomTerminalFadeSeconds;
    // MAJOR 2: `clearEpisodeState` muzzles the event bus at a reset's zero instant; every new bloom
    // re-asserts unity at its own start time so the event path keeps working after a reset.
    this.eventGain.gain.setValueAtTime(1, start);
    const nodes: AudioNode[] = [];
    for (let index = 0; index < AUDIO.bloomPartialRatios.length; index += 1) {
      const amplitude = AUDIO.bloomPartialAmplitudes[index] ?? 0;
      const tau = AUDIO.bloomDecayTaus[index] ?? 0.5;
      const oscillator = this.context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.value = baseHz * (AUDIO.bloomPartialRatios[index] ?? 1);
      const env = this.context.createGain();
      env.gain.value = 0;
      const peakAmp = eventPeak * amplitude;
      // Raised-cosine attack: a coarse curve is a faithful raised cosine; its endpoints are exact.
      env.gain.setValueCurveAtTime(
        raisedCosineAttack(attack, this.context.sampleRate, peakAmp),
        start,
        attack,
      );
      // The decay starts at the curve's real end — never inside it. With the guarded start this is
      // exactly `start + attack`, so the exponential τ keeps its designed reference point.
      env.gain.setTargetAtTime(0, curveEnd, tau);
      // 100 ms bounded terminal fade from the analytic decay value to exactly zero.
      const atFade = peakAmp * Math.exp(-(fadeStart - attack) / tau);
      env.gain.setValueAtTime(atFade, start + fadeStart);
      env.gain.linearRampToValueAtTime(0, start + fadeEnd);
      env.gain.setValueAtTime(0, start + fadeEnd);
      oscillator.connect(env).connect(this.eventGain);
      oscillator.start(start);
      oscillator.stop(start + AUDIO.bloomLifetimeSeconds);
      nodes.push(oscillator, env);
    }
    this.track(nodes, start + AUDIO.bloomLifetimeSeconds, 'event');
    this.eventsFired += 1;
  }

  private track(nodes: AudioNode[], stopAt: number, kind: 'grain' | 'event'): void {
    this.nodeCreated += nodes.length;
    this.pending.push({ nodes, stopAt, kind });
    if (this.pending.length > this.maxLiveNodes) this.maxLiveNodes = this.pending.length;
  }

  /**
   * Retire every one-shot source whose scheduled stop time has passed, bounding the live node count.
   *
   * On a **realtime** context the nodes are disconnected immediately (the audio has already been
   * rendered). On an `OfflineAudioContext` the whole timeline is scheduled *before* `startRendering()`,
   * so a `disconnect()` here would remove a source that has not been rendered yet and silence it — the
   * disconnection is therefore deferred to `dispose()` while the node is still retired from the live
   * accounting. (Found via the offline render matrix: it made every finished bloom and most grains
   * silent, e.g. the isolated texture measured ≈ −47 dBFS instead of ≈ −40.)
   */
  reap(now: number): void {
    if (this.pending.length === 0) return;
    const realtime = this.mediaStreamDestination !== null;
    const remaining: PendingSource[] = [];
    for (const entry of this.pending) {
      if (entry.stopAt <= now) {
        this.nodeStopped += entry.nodes.length;
        if (realtime) {
          for (const node of entry.nodes) {
            try {
              node.disconnect();
            } catch {
              // Already torn down with the context; nothing to do.
            }
          }
        } else {
          for (const node of entry.nodes) this.retired.push(node);
        }
      } else {
        remaining.push(entry);
      }
    }
    this.pending = remaining;
  }

  liveNodes(kind?: 'grain' | 'event'): number {
    if (kind === undefined) return this.pending.length;
    let count = 0;
    for (const entry of this.pending) if (entry.kind === kind) count += 1;
    return count;
  }

  stats(): GraphStats {
    let live = 0;
    for (const entry of this.pending) live += entry.nodes.length;
    return {
      nodeCreated: this.nodeCreated,
      nodeStopped: this.nodeStopped,
      liveNodes: live,
      grainsStarted: this.grainsStarted,
      eventsFired: this.eventsFired,
      maxLiveNodes: this.maxLiveNodes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of this.voices) {
      try {
        voice.oscillator.stop();
      } catch {
        // Never started or already stopped.
      }
      voice.oscillator.disconnect();
      voice.gain.disconnect();
      voice.filter.disconnect();
    }
    for (const entry of this.pending) {
      for (const node of entry.nodes) node.disconnect();
      this.nodeStopped += entry.nodes.length;
    }
    this.pending = [];
    for (const node of this.retired) node.disconnect();
    this.retired = [];
    this.textureBus.disconnect();
    this.textureHighpass.disconnect();
    this.textureBandpass.disconnect();
    this.textureLowpass.disconnect();
    this.textureGain.disconnect();
    this.eventGain.disconnect();
    this.sendGain.disconnect();
    this.convolver.disconnect();
    this.wetGain.disconnect();
    this.mixBus.disconnect();
    this.highpass.disconnect();
    this.master.disconnect();
    this.compressor.disconnect();
    this.muteGain.disconnect();
    this.dryBus.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// §8.1/§8.3 engine (context-agnostic: works on AudioContext and OfflineAudioContext)
// ---------------------------------------------------------------------------------------------

export type SilencePhase = 'live' | 'fading' | 'silent';

export interface SilenceStatus {
  satisfied: boolean;
  terminalZeroAt: number | null;
}

export interface AudioEngineOptions extends AudioGraphOptions {
  /** Whether a real user gesture has unlocked the context (§2.3). */
  unlocked?: boolean;
  muted?: boolean;
  paused?: boolean;
}

/**
 * The §8.1 signal engine and §8.3 silence gate. `consume` stores the latest world snapshot; `tick`
 * is called at the scheduler cadence with the context time and applies the smoothed controls,
 * schedules short-horizon grains/events and advances the silence state machine. It holds no timers,
 * so the live `AudioSystem` and the offline scenario driver both drive the *same* code.
 */
export class AudioEngine {
  readonly graph: AudioGraph;
  private latest: WorldState | null = null;
  private lastTickTime: number | null = null;
  private quietSeconds = 0;
  private phase: SilencePhase = 'live';
  private fadeDeadline: number | null = null;
  private terminalZeroAt: number | null = null;
  private armed = false;
  private lastStillness = 'none';
  private lastEventSerial = 0;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private obsoleteEventsSkipped = 0;
  private unlocked: boolean;
  private muted: boolean;
  private paused: boolean;
  private disposed = false;
  private rng: Rng;
  /**
   * §8.2 (MAJOR 4) granular scheduling cursor: the context time the next due grain is scheduled for.
   * Each tick emits grains only while the cursor is inside `[now, now + lookaheadMs]`, so a stalled or
   * batched tick spreads its grains over the lookahead window instead of stacking them all at `now`.
   * `null` means "unset — start from `now`" (fresh performance / activation / transport resume).
   */
  private grainCursor: number | null = null;
  /** The recorded root seed whose `sound` substream the engine is currently using (§4.4), if any. */
  private rootSeed: number | null;
  /** §8.3 (MAJOR 1) the context time the current terminal fade began, for offline measurement. */
  private fadeStartedAt: number | null = null;
  /**
   * §8.3 (MAJOR 2) a reseed deferred to a de-click's zero instant. A restart holds the live master
   * level and de-clicks to zero, so the buffer/IR swap must wait until the master is actually at zero;
   * it is applied on the first tick at or after `at`. Never set for an inaudible (locked/muted/paused)
   * graph, which swaps immediately.
   */
  private pendingReset: { seeds: SoundSubstreamSeeds | null; at: number; silence: boolean } | null = null;
  /**
   * §8.3 (MAJOR 2) the live master level the most recent `resetPerformance()` held from before its
   * de-click, or null before any restart. Instrumentation: the browser lifecycle fixture asserts a
   * restart held a live level (a de-click) rather than stepping to zero (a cut).
   */
  private masterHeldAtRestart: number | null = null;
  /**
   * §6 presence eligibility: false at startup/reset; true after a **confirmed** support crossing (two
   * fresh valid samples at/above the on-threshold and ≥ 0.5 real seconds); held through hysteresis and
   * cleared immediately when support falls below support-off. It gates the pad floor, grains and
   * one-shot events, so a visually empty field is exactly silent.
   */
  private presenceEligible = false;
  /**
   * §6 whether the pad floor has already been revealed for the current presence episode. The reveal is
   * retried on every tick until it succeeds (a stillness/black-hold or pause may deny it once), then
   * latched; it is cleared when presence clears or on a reset, so a later re-crossing reveals again.
   */
  private presenceRevealed = false;
  private supportSamples = 0;
  private supportStartAt = 0;
  /** The performance-seconds mark of the last sample counted toward confirmation (dedupes repeats). */
  private lastSupportMark: number | null = null;
  /** §6 the context time the current reveal window ends (grains/events are suppressed until then). */
  private revealUntil: number | null = null;
  /**
   * §6 (MINOR 4) the context time the bounded root-raise envelope (live master, presence turning
   * eligible) ends. While it is active the ordinary per-tick root gain target is suppressed so the
   * explicit 0.75 s ramp is not fought by τ smoothing.
   */
  private rootRevealUntil: number | null = null;
  /**
   * §6 (MAJOR) whether the bounded root raise was interrupted by a **prohibited** interval (pause, mute,
   * stillness, lock) while presence stayed eligible. While set, `applyControls` drives the root **down**
   * through the ordinary bounded τ and never schedules a positive target, and the unified reveal
   * restarts exactly once when permission returns. Presence *clearing* does not set it (that path simply
   * abandons and glides down).
   */
  private rootRevealPending = false;
  /** §2 which voices sounded on the previous tick (to pick the admit/remove smoothing τ = 10 s). */
  private voiceOn = [false, false, false, false];

  // --- §2/§3/§4 (TAKE-4) musicalization state ---------------------------------
  /** The pad's reaction-activity band selector (smoothed x, hysteretic band, confirmation). */
  private activitySelector = freshBandSelector();
  /** The accepted pad degree (0–4) — what actually sounds. */
  private padDegree = NEUTRAL_DEGREE;
  /** Context time of the last **committed** degree change (the 12 s gate). */
  private lastCommitAt = Number.NEGATIVE_INFINITY;
  /** The in-flight pad pitch glide mirror, or null when settled. */
  private pitch: PitchGlide | null = null;
  /** Whether the previous tick admitted pitch changes (used to detect entering a prohibition). */
  private pitchAdmissibleLast = false;
  /** The bloom's coherence band selector — a *silent latch* that gates nothing. */
  private coherenceSelector = freshBandSelector();
  /** The settled bloom degree taken from the coherence latch. */
  private bloomDegree = 0;
  /** The bloom register (octave) with its own hysteresis and confirmation. */
  private bloomRegister: 'coarse' | 'fine' = 'coarse';
  private bloomRegisterSet = false;
  private registerCandidate: { value: 'coarse' | 'fine'; since: number; samples: number; mark: number } | null =
    null;
  /** §9.5 bounded musicality counters and change log. */
  private pitchCounters = { crossings: 0, eligible: 0, accepted: 0, refractory: 0, prohibited: 0 };
  private pitchLog: PitchChangeLogEntry[] = [];
  /** §4 the last bloom's note/degree/register, for the offline and live musicality diagnostics. */
  private lastBloom: { at: number; baseHz: number; degree: number; register: 'coarse' | 'fine' } | null = null;

  constructor(context: BaseAudioContext, options: AudioEngineOptions = {}) {
    this.graph = new AudioGraph(context, options);
    this.unlocked = options.unlocked ?? false;
    this.muted = options.muted ?? false;
    this.paused = options.paused ?? false;
    this.rootSeed = options.rootSeed ?? null;
    this.rng = new Rng(this.graph.soundSubstream().grains);
    // A graph built already-unlocked (the offline driver, or a context that autoplayed) has nothing
    // scheduled, so it is anchored at the live level; a locked graph stays at the graph's zero and the
    // locked→running edge fades it up (MAJOR 2).
    if (this.unlocked) this.graph.anchorMasterLevel(context.currentTime);
  }

  /**
   * §2.3 (MAJOR 2) the locked→running activation edge. When audio becomes unlocked from a locked state
   * the engine anchors the master at exactly zero and fades up over a bounded window (only when the
   * current stillness state permits sound), baselines the event serial to the latest *published* serial
   * so a retained pre-activation event does not fire on the first tick, and resets the scheduling time
   * and granular debt.
   */
  setUnlocked(unlocked: boolean): void {
    const wasLocked = !this.unlocked;
    this.unlocked = unlocked;
    if (unlocked && wasLocked) this.activateEdge();
  }

  /** The §2.3 activation edge (locked→running): see `setUnlocked`. */
  private activateEdge(): void {
    const now = this.graph.context.currentTime;
    // Drop any retained scheduling time/debt: the first post-activation tick has dt = 0 and no backlog.
    this.lastTickTime = null;
    this.grainCursor = null;
    // Only post-activation serials excite: baseline past whatever the app already published.
    if (this.latest) this.lastEventSerial = Math.max(this.lastEventSerial, this.latest.events.serial);
    // §6 activation fades up over 1.5 s **only when presence is eligible**; activation in dormancy stays
    // silent (as does a stillness/black-hold lock). Reveal and activation are one envelope operation.
    if (!this.presenceEligible || !this.revealPermitted()) {
      this.graph.cancelMasterAutomation(now);
      return;
    }
    const controls = this.latest
      ? deriveAudioControls(this.latest.analysis.presentation)
      : neutralAudioControls();
    this.beginReveal(now, controls);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.graph.setMuted(this.muted || this.paused, this.graph.context.currentTime);
  }

  setPaused(paused: boolean): void {
    const resumed = this.paused && !paused;
    this.paused = paused;
    this.graph.setMuted(this.muted || this.paused, this.graph.context.currentTime);
    // §8.3 (MAJOR 4) transport resume drops the granular debt: no batch is released at the resume
    // timestamp, and the first post-resume tick starts with fresh scheduling state.
    if (resumed) {
      this.lastTickTime = null;
      this.grainCursor = null;
    }
  }

  consume(world: WorldState): void {
    this.latest = world;
  }

  get silencePhase(): SilencePhase {
    return this.phase;
  }

  /**
   * §8.3 stillness override: issue the terminally bounded fade on entry to `kill-wait`, once per
   * episode. Idempotent while the episode is active; re-armed when `stillnessState` returns to `none`.
   * `now` overrides the context time for the offline scenario driver (which never advances
   * `OfflineAudioContext.currentTime` while it ticks).
   */
  prepareSilence(now?: number): void {
    if (this.disposed) return;
    if (this.armed) return;
    this.armed = true;
    const at = now ?? this.graph.context.currentTime;
    if (this.phase === 'silent') {
      this.terminalZeroAt = this.performanceAt(at);
      return;
    }
    this.beginFade(at);
  }

  silenceStatus(): SilenceStatus {
    if (this.disposed || !this.unlocked || this.muted || this.paused) {
      // Locked/muted/unavailable audio reads as satisfied with no timestamp (§3.3/§8.3).
      return { satisfied: true, terminalZeroAt: null };
    }
    return { satisfied: this.terminalZeroAt !== null, terminalZeroAt: this.terminalZeroAt };
  }

  tick(now: number): void {
    if (this.disposed) return;
    // §8.3/§6 (MAJOR 1) apply a reset deferred to the de-click's zero instant, now that the master has
    // reached zero: the buffer/IR swap and the source silencing are inaudible here.
    if (this.pendingReset && now >= this.pendingReset.at) {
      const { seeds, silence } = this.pendingReset;
      this.pendingReset = null;
      if (seeds) {
        this.graph.reseedSound(seeds);
        this.rng = new Rng(seeds.grains);
      }
      if (silence) this.graph.clearEpisodeState(now);
    }
    const world = this.latest;
    if (!world) return;
    // `rawGap` is the true tick spacing (for stall detection); `dt` is bounded so a long stall cannot
    // integrate a huge descriptor step (the silence gate uses performance seconds via `dt`).
    const rawGap = this.lastTickTime === null ? 0 : now - this.lastTickTime;
    const dt = this.lastTickTime === null ? 0 : clamp(rawGap, 0, 1);
    this.lastTickTime = now;

    // Episode-scoped re-arm: a return to `none` clears the acknowledgement so a later stillness needs
    // its own `prepareSilence()` and a fresh terminal zero.
    const stillness = world.phase.stillnessState;
    if (stillness !== this.lastStillness) {
      if (stillness === 'none') this.rearm();
      this.lastStillness = stillness;
    }

    const presentation = world.analysis.presentation;
    const controls = deriveAudioControls(presentation);

    // §8.3 quiet requires **support below support-off** as well as low occupancy/activity: a visually
    // supported low-activity body is not empty dormancy.
    const quiet =
      presentation.valid &&
      presentation.occupiedFraction < AUDIO.offOccupancy &&
      presentation.reactionActivity < AUDIO.offActivity &&
      presentation.supportFraction < AUDIO.supportOffFraction;

    // §6 presence: advance the confirmation/hysteresis machine, then reveal on a false→true crossing
    // that the current state permits (never during stillness, pause/mute, or a pre-gesture lock). The
    // reveal is retried each tick until it succeeds, then latched until presence clears.
    const eligible = this.advancePresence(now, presentation, world.analysis.samplePerformanceSeconds);
    if (!eligible) this.presenceRevealed = false;
    if (eligible && !this.presenceRevealed && this.revealPermitted()) this.beginReveal(now, controls);
    this.presenceEligible = eligible;

    // §6 (MAJOR) root-reveal interruption. Two distinct cases:
    //  - presence **cleared** while the bounded root raise is in flight → abandon it and let the ordinary
    //    τ glide the root down (there is nothing left to reveal);
    //  - the reveal became **prohibited** while presence is still eligible (pause, mute, stillness, lock) →
    //    abandon the in-flight ramp and mark the reveal *pending* for the prohibited interval. Previously
    //    `applyControls` then took its ordinary branch and scheduled a *positive* root target, so the root
    //    kept rising behind the mute / under the stillness fade and returned already-raised on resume.
    if (this.rootRevealUntil !== null) {
      if (!eligible) {
        this.graph.abandonRootReveal(now);
        this.rootRevealUntil = null;
        this.rootRevealPending = false;
      } else if (!this.revealPermitted()) {
        this.graph.abandonRootReveal(now);
        this.rootRevealUntil = null;
        this.rootRevealPending = true;
      }
    }
    if (this.rootRevealPending) {
      if (!eligible || !this.presenceRevealed) {
        this.rootRevealPending = false; // presence cleared (or the reveal was never latched)
      } else if (this.revealPermitted()) {
        // Permission returned with presence still eligible: restart the reveal exactly once. The root
        // returns through the dedicated bounded 0.75 s ramp from its mirrored held/decayed value — no
        // upward step, and `revealVoice` guarantees the ramp is not fought by the ordinary τ.
        this.rootRevealPending = false;
        this.beginReveal(now, controls);
      }
    }

    // §2/§3 (TAKE-4) the musical tick: advance the band selectors and admit at most one adjacent pad
    // degree change. Deliberately **before** the event gate, so a tick carrying both a crossing and an
    // event accepts the pad change first.
    this.updatePitch(now, rawGap, world.analysis.samplePerformanceSeconds, presentation, controls);

    this.updateSilence(now, dt, quiet);
    this.updateEvent(now, world, presentation, controls);
    if (this.phase !== 'silent') this.applyControls(now, controls);
    this.scheduleGrains(now, rawGap, controls);
    this.graph.reap(now);
  }

  /**
   * §5 (TAKE-4) reset every piece of musical state: both selectors, the accepted degree, the commit
   * clock, the glide mirror and the bloom-register latch. Called from `resetPerformance`, so a fresh
   * performance always starts on a silent neutral A.
   */
  private resetPitchState(): void {
    this.activitySelector = freshBandSelector();
    this.padDegree = NEUTRAL_DEGREE;
    this.lastCommitAt = Number.NEGATIVE_INFINITY;
    this.pitch = null;
    this.pitchAdmissibleLast = false;
    this.coherenceSelector = freshBandSelector();
    this.bloomDegree = 0;
    this.bloomRegisterSet = false;
    this.registerCandidate = null;
    // A fresh performance starts a fresh §9.5 diagnostic window too.
    this.pitchCounters = { crossings: 0, eligible: 0, accepted: 0, refractory: 0, prohibited: 0 };
    this.pitchLog = [];
    this.lastBloom = null;
  }

  /**
   * MAJOR 2 / spec §"Degree acceptance, not queued motion" ("At silent preparation both = current
   * nominal activity band"): snap the activity selector's smoothed value and observed band, and the pad
   * degree, onto the descriptors as they stand now. Called only while the master is at exact zero, so
   * the resulting voicing is applied inaudibly. Deliberately writes **no** candidate, counter or log
   * entry — a silent baseline is neither a crossing nor a commit.
   */
  private baselinePitchFromActivity(now: number, controls: AudioControls): void {
    const nominalBand = bandOf(controls.activityX, AUDIO.activityBandEdges);
    this.activitySelector.smoothed = controls.activityX;
    this.activitySelector.observed = nominalBand;
    this.activitySelector.candidate = null;
    this.activitySelector.lastUpdateAt = now;
    // Force the next driver tick to be treated as fresh so the smoothing clock is refreshed from a real
    // sample rather than left anchored at the preparation instant.
    this.activitySelector.mark = null;
    this.padDegree = nominalBand;
    this.pitch = null;
  }

  /** §2/§5 whether a confirmed crossing may move the pad right now. */
  private pitchAdmissible(now: number): boolean {
    if (!this.presenceEligible) return false; // absent support
    if (this.revealActive(now)) return false; // suppressed during the reveal — never replayed
    return this.revealPermitted(); // pause / mute / stillness / pre-gesture lock
  }

  /** §3 the four carriers currently sounding: the glide's in-flight value, else the settled degree. */
  pitchCarriersAt(t: number): number[] {
    const glide = this.pitch;
    if (!glide) return voicingCarriers(this.padDegree);
    const span = glide.end - glide.start;
    const u = span > 0 ? clamp((t - glide.start) / span, 0, 1) : 1;
    return glide.to.map((f1, i) => {
      const f0 = glide.from[i] ?? f1;
      return f0 * Math.pow(f1 / f0, u);
    });
  }

  /**
   * §2/§4/§5 the musical tick: advance the pad's activity-band selector and the bloom's coherence-band
   * latch, then admit **at most one adjacent** pad-degree change.
   *
   * Crossing policy (§2): a confirmed crossing is *consumed* when prohibited, dropped inside the 12 s
   * degree refractory, and otherwise moves `padDegree` one step toward the observed band. There is no
   * pending destination and no catch-up, so a large jump still takes one step per crossing and a missed
   * crossing is never replayed. The observed band is latched regardless of permission.
   */
  private updatePitch(
    now: number,
    rawGap: number,
    mark: number,
    presentation: PresentationAnalysis,
    controls: AudioControls,
  ): void {
    const admissible = this.pitchAdmissible(now);
    if (this.pitchAdmissibleLast && !admissible) {
      // §5 entering a prohibited interval clears candidate debt — a new post-return crossing is required.
      this.activitySelector.candidate = null;
      this.coherenceSelector.candidate = null;
      this.registerCandidate = null;
    } else if (!this.pitchAdmissibleLast && admissible) {
      // MAJOR 4: permission *return* rebaselines too. While already prohibited the selectors keep
      // advancing, so a candidate formed inside the interval would otherwise keep its pre-return `since`
      // and sample count and commit on the first fresh admissible sample using evidence gathered while
      // the pad was forbidden to move. Clearing here means only a candidate that fully forms *after*
      // the return can commit. A crossing that **fully confirmed** while prohibited already latched
      // `observed` (its candidate was nulled by confirmation), so that consumption is preserved.
      this.activitySelector.candidate = null;
      this.coherenceSelector.candidate = null;
      this.registerCandidate = null;
    }
    this.pitchAdmissibleLast = admissible;

    if (!presentation.valid) {
      // §5 invalid/stale: hold the last valid pitch (never NaN → degree 0) and clear candidates.
      this.activitySelector.candidate = null;
      this.coherenceSelector.candidate = null;
      this.registerCandidate = null;
      return;
    }

    if (rawGap > AUDIO.stallSeconds) {
      // §5 a stall drops candidates; the observed bands are rebaselined **after** this tick's selector
      // update (below) so the latch agrees with the value it is compared against.
      this.activitySelector.candidate = null;
      this.coherenceSelector.candidate = null;
      this.registerCandidate = null;
    }

    const crossing = advanceBandSelector(
      this.activitySelector,
      controls.activityX,
      mark,
      now,
      AUDIO.activityBandEdges,
      AUDIO.selectorHysteresis,
    );
    // §4 the coherence selector is a *silent latch*: it gates nothing, it only picks the bloom degree.
    const coherenceCrossing = advanceBandSelector(
      this.coherenceSelector,
      controls.coherence,
      mark,
      now,
      AUDIO.coherenceBandEdges,
      AUDIO.coherenceHysteresis,
    );

    if (rawGap > AUDIO.stallSeconds) {
      // §5 rebaseline both observed bands to the current smoothed value's band. The held degree is
      // preserved, and this tick's crossings are *discarded*: a stall is not a crossing event, so it can
      // never queue or release a pad change.
      this.activitySelector.observed =
        this.activitySelector.smoothed === null
          ? 0
          : bandOf(this.activitySelector.smoothed, AUDIO.activityBandEdges);
      this.coherenceSelector.observed =
        this.coherenceSelector.smoothed === null
          ? 0
          : bandOf(this.coherenceSelector.smoothed, AUDIO.coherenceBandEdges);
      return;
    }

    if (coherenceCrossing !== null) this.bloomDegree = coherenceCrossing;
    this.updateBloomRegister(now, presentation, mark);

    if (crossing === null) return;
    this.pitchCounters.crossings += 1;
    let accepted = false;
    let reason: PitchChangeReason = 'accepted';
    if (!admissible) {
      reason = 'prohibited';
      this.pitchCounters.prohibited += 1;
    } else {
      this.pitchCounters.eligible += 1;
      if (now - this.lastCommitAt < AUDIO.degreeRefractorySeconds) {
        reason = 'refractory';
        this.pitchCounters.refractory += 1;
      } else {
        const direction = Math.sign(crossing - this.padDegree);
        if (direction !== 0) {
          this.commitDegree(this.padDegree + direction, now);
          accepted = true;
        } else {
          reason = 'held';
        }
      }
    }
    if (this.pitchLog.length >= PITCH_LOG_LIMIT) this.pitchLog.shift();
    this.pitchLog.push({ at: now, band: crossing, degree: this.padDegree, accepted, reason });
  }

  /** §2/§3 one committed degree change: one adjacent step and exactly one bounded logarithmic glide. */
  private commitDegree(degree: number, now: number): void {
    const target = clamp(Math.round(degree), 0, 4);
    const from = this.pitchCarriersAt(now);
    const to = voicingCarriers(target);
    this.padDegree = target;
    this.lastCommitAt = now;
    // §5 (TAKE-5) the mirror records the time the glide was **actually** scheduled at (the guard never
    // pulls a future time earlier, and pushes a time that is behind the clock forward), so the in-flight
    // carriers read from `pitchCarriersAt` can never disagree with the scheduled frequency curve.
    const start = this.graph.applyPitchGlide(from, to, now, AUDIO.glideSeconds);
    this.pitch = { from, to, start, end: start + AUDIO.glideSeconds };
    this.pitchCounters.accepted += 1;
  }

  /** §4 the bloom register: `featureScaleNorm` with hysteresis (.55 / .45) and the standard confirmation. */
  private updateBloomRegister(now: number, presentation: PresentationAnalysis, mark: number): void {
    const norm = featureScaleNorm(presentation.featureScaleUV);
    if (!this.bloomRegisterSet) {
      // Coarse if ≥ .5 on the first valid sample.
      this.bloomRegister = norm >= AUDIO.registerInitialPivot ? 'coarse' : 'fine';
      this.bloomRegisterSet = true;
      this.registerCandidate = null;
      return;
    }
    let target = this.bloomRegister;
    if (target === 'fine' && norm >= AUDIO.registerFineToCoarse) target = 'coarse';
    else if (target === 'coarse' && norm <= AUDIO.registerCoarseToFine) target = 'fine';
    if (target === this.bloomRegister) {
      this.registerCandidate = null;
      return;
    }
    if (!this.registerCandidate || this.registerCandidate.value !== target) {
      this.registerCandidate = { value: target, since: now, samples: 1, mark };
      return;
    }
    // MAJOR 3: a duplicate tick carries no fresh evidence and may never be the state-changing event that
    // latches the register — otherwise three rapid samples plus scheduler time would commit on a stale
    // snapshot.
    if (mark === this.registerCandidate.mark) return;
    this.registerCandidate.samples += 1;
    this.registerCandidate.mark = mark;
    if (
      this.registerCandidate.samples >= AUDIO.confirmSamples &&
      now - this.registerCandidate.since >= AUDIO.confirmSeconds
    ) {
      this.bloomRegister = target;
      this.registerCandidate = null;
    }
  }

  /** §9.5 the musicality diagnostics snapshot (why the pad did or did not move). */
  pitchDiagnostics(): PitchDiagnostics {
    return {
      activityX: this.activitySelector.smoothed,
      observedBand: this.activitySelector.observed,
      padDegree: this.padDegree,
      coherenceX: this.coherenceSelector.smoothed,
      bloomDegree: this.bloomDegree,
      bloomRegister: this.bloomRegister,
      carriers: voicingCarriers(this.padDegree),
      lastCommitAt: this.lastCommitAt === Number.NEGATIVE_INFINITY ? null : this.lastCommitAt,
      crossings: this.pitchCounters.crossings,
      eligibleCrossings: this.pitchCounters.eligible,
      acceptedChanges: this.pitchCounters.accepted,
      droppedRefractory: this.pitchCounters.refractory,
      droppedProhibited: this.pitchCounters.prohibited,
      lastBloom: this.lastBloom ? { ...this.lastBloom } : null,
    };
  }

  /** The bounded pad-degree change log, oldest first. */
  pitchChangeLog(): PitchChangeLogEntry[] {
    return this.pitchLog.map((entry) => ({ ...entry }));
  }

  /**
   * §6 support confirmation: two consecutive fresh valid samples at/above the on-threshold **and** at
   * least 0.5 real seconds of persistence to become eligible; hysteresis (support-off) to stay; cleared
   * immediately below support-off. Repeated ticks on the same snapshot (same `mark`) do not count
   * again, and invalid/stale presentation can never establish presence.
   */
  private advancePresence(now: number, presentation: PresentationAnalysis, mark: number): boolean {
    if (!presentation.valid) {
      // MAJOR 3: an invalid/stale sample can never *establish* presence; it also breaks an unconfirmed
      // candidate sequence (so a stale interval cannot count toward the 0.5 s persistence). Already
      // eligible presence keeps its hold behaviour.
      if (this.presenceEligible) return true;
      this.resetSupportConfirmation();
      return false;
    }
    const support = presentation.supportFraction;
    if (this.presenceEligible) {
      if (support < AUDIO.supportOffFraction) {
        this.resetSupportConfirmation();
        return false;
      }
      return true;
    }
    if (support >= AUDIO.supportOnFraction) {
      if (mark !== this.lastSupportMark) {
        if (this.supportSamples === 0) this.supportStartAt = now;
        this.supportSamples += 1;
        this.lastSupportMark = mark;
      }
      return (
        this.supportSamples >= AUDIO.supportConfirmSamples &&
        now - this.supportStartAt >= AUDIO.supportConfirmSeconds
      );
    }
    this.resetSupportConfirmation();
    return false;
  }

  private resetSupportConfirmation(): void {
    this.supportSamples = 0;
    this.lastSupportMark = null;
  }

  /** §6 whether the current state permits a reveal (stillness, pause/mute and pre-gesture lock forbid). */
  private revealPermitted(): boolean {
    if (!this.unlocked || this.muted || this.paused) return false;
    if (this.armed) return false;
    return (this.latest?.phase.stillnessState ?? 'none') === 'none';
  }

  /** §6 whether the initial reveal window is still active (grains/events are suppressed during it). */
  private revealActive(now: number): boolean {
    return this.revealUntil !== null && now < this.revealUntil;
  }

  /**
   * §6 the unified reveal/activation: cancel a general absence fade (or reveal from exact silence) with
   * one 1.5 s linear master ramp. From exact silence the root's pitch/filter/gain targets are prepared
   * **behind the zero master** first (never audibly gliding from a placeholder pitch); with the master
   * already live the root instead regains its floor through the bounded root envelope (see
   * `applyControls`), never a second master fade in series.
   */
  private beginReveal(now: number, controls: AudioControls): void {
    const master = this.graph.masterLevelAt(now);
    if (master <= 1e-4 && controls.valid) {
      // MAJOR 2 / spec §"Degree acceptance, not queued motion" ("At silent preparation both = current
      // nominal activity band"): while the master is still at *exact* zero, seed the activity selector's
      // smoothed value and observed band **and** the pad degree from the descriptors as they stand now,
      // so the pad reveals on the band the organism is actually in rather than the neutral A — otherwise
      // a high-activity organism reveals on A and stays there (its confirmed crossings are consumed while
      // the reveal window is prohibited). Applied while inaudible, and deliberately not a crossing, a
      // glide, or a commit: no candidate survives, no counter or log entry is written.
      this.baselinePitchFromActivity(now, controls);
    }
    const carriers = voicingCarriers(this.padDegree);
    const rootValues = {
      filterHz: mapVoiceFilterHz(carriers[0]!, controls.intensity),
      level: controls.voiceLevels[0] ?? controls.voiceLevel,
    };
    if (this.phase === 'fading' || master <= 1e-4) {
      if (master <= 1e-4 && controls.valid) {
        // §5 (TAKE-4) from exact silence: initialize the pad pitch from the current descriptors behind
        // the zero master (an immediate set, never a glide), prepare the root, then one 1.5 s master
        // reveal. The reveal is a pitch *endpoint*, so no glide may run across it.
        this.graph.applyPitchImmediate(carriers, now);
        this.pitch = null;
        this.graph.prepareRoot(rootValues, now);
      } else if (controls.valid && this.rootRevealUntil === null) {
        // A *live-ish* mid-fade master: the root additionally returns through its own bounded 0.75 s ramp,
        // concurrently with (never in series with) the master reveal, so it does not reappear at its floor
        // through the ordinary τ. From exact silence it was already prepared behind the zero master, where a
        // second root envelope in series would be forbidden.
        this.rootRevealUntil = this.graph.revealVoice(0, rootValues.level, now, AUDIO.rootRevealSeconds);
      }
      this.graph.revealMaster(now, AUDIO.revealSeconds);
    } else if (controls.valid) {
      // Master already live: **hold the pitch and wait** (§5) — only the root regains its floor, through
      // the dedicated bounded 0.75 s envelope rather than an asymptotic step.
      this.rootRevealUntil = this.graph.revealVoice(0, rootValues.level, now, AUDIO.rootRevealSeconds);
    }
    this.phase = 'live';
    this.fadeDeadline = null;
    this.terminalZeroAt = null;
    this.quietSeconds = 0;
    this.revealUntil = now + AUDIO.revealSeconds;
    this.presenceRevealed = true;
  }

  /**
   * §8.3/§6 (MAJOR 1/2) fresh-performance / episode abort. Cancels the stale master automation and
   * deadlines, resets the stillness episode state and every counter, drops the granular scheduling debt,
   * and establishes a **de-clicked** new master transition: it holds the computed live level and ramps
   * linearly to zero over `AUDIO.declickSeconds`, then **stays at zero**. While the master is at zero the
   * §4.4 sound substream is swapped and every persistent source (the four pad voices and the texture
   * bus) is forced to exactly zero, so no pre-reset pad target can sound into the freshly seeded empty
   * field; the master rises again only through the ordinary §6 presence reveal once the *new* field
   * confirms support. A restart therefore never steps a live master to zero (no click), never re-exposes
   * the old organism's tone, and the abandoned episode's terminal deadline can never fire.
   *
   * Called by the app on `restart()`, `applyResolution()` and a `load-trajectory` that replaces the
   * active document. A trajectory load that *preserves* the current field does not call this at all, so
   * it keeps its current semantics (a crossfade, no reset).
   *
   * When `reseedTo` is supplied the §4.4 sound substream is rebuilt from that root seed. For an audible
   * (unlocked, unmuted, unpaused) graph the buffer/IR swap and the source silencing are deferred to the
   * de-click's zero instant (applied on the next tick) so they are inaudible; an inaudible graph applies
   * them immediately.
   */
  resetPerformance(now?: number, reseedTo?: number): void {
    if (this.disposed) return;
    const at = now ?? this.graph.context.currentTime;
    const audible = this.unlocked && !this.muted && !this.paused;
    // The live level this restart holds from (MAJOR 2): the de-click ramps down from exactly here.
    this.masterHeldAtRestart = this.graph.masterLevelAt(at);
    // 1. Establish the new master transition: an audible graph holds the live level and de-clicks to
    //    zero (and stays there); a locked graph cancels outright and stays at zero.
    let zeroAt = at;
    if (audible) {
      zeroAt = this.graph.declickToZero(at, AUDIO.declickSeconds);
    } else {
      // MAJOR 1: an inaudible reset (paused, muted or locked) anchors the master at **exactly zero**
      // (param + mirror) rather than holding the live level, so a later resume/unmute sees exact silence
      // and takes the unified 1.5 s reveal — not the fast/loud return through the mute release.
      this.graph.anchorMasterAtZero(at);
    }
    // 2. Reset the stillness episode state and counters.
    this.phase = 'live';
    this.fadeDeadline = null;
    this.terminalZeroAt = null;
    this.armed = false;
    this.fadeStartedAt = null;
    this.quietSeconds = 0;
    // §6 presence is false at reset — the freshly seeded field must re-earn a confirmed support crossing.
    this.presenceEligible = false;
    this.presenceRevealed = false;
    this.resetSupportConfirmation();
    this.revealUntil = null;
    this.rootRevealUntil = null;
    this.rootRevealPending = false;
    // §5 (TAKE-4) the fresh performance starts on a silent neutral A: pitch state and its automation are
    // cleared with the episode (the reset's zero instant already cancels any in-flight glide).
    this.resetPitchState();
    this.voiceOn = [false, false, false, false];
    this.lastStillness = 'none';
    this.obsoleteEventsSkipped = 0;
    this.lastEventAt = Number.NEGATIVE_INFINITY;
    // 3. Drop the scheduling time/debt.
    this.lastTickTime = null;
    this.grainCursor = null;
    // 4. Swap the §4.4 sound substream and clear every episode-scoped source, at the de-click's zero
    //    instant for an audible graph (inaudible there), immediately otherwise.
    const seeds = reseedTo !== undefined ? deriveSoundSeeds(reseedTo) : null;
    if (reseedTo !== undefined) this.rootSeed = reseedTo >>> 0;
    // MINOR 4: coalesce with a reset still pending inside its de-click window. A newer explicit seed
    // supersedes, but a *seedless* reset preserves the latest pending seeds and just moves the swap to
    // the newest zero instant — an unconditional replace would silently drop the pending reseed while
    // `recordedRootSeed` already reported the new seed.
    const preservedSeeds = seeds ?? this.pendingReset?.seeds ?? null;
    const swapAt = Math.max(zeroAt, this.pendingReset?.at ?? zeroAt);
    if (audible) {
      this.pendingReset = { seeds: preservedSeeds, at: swapAt, silence: true };
    } else {
      this.pendingReset = null;
      if (preservedSeeds) {
        this.graph.reseedSound(preservedSeeds);
        this.rng = new Rng(preservedSeeds.grains);
      }
      this.graph.clearEpisodeState(at);
    }
  }

  /** The §4.4 sound substream the engine is generating from (seeds + a material checksum). */
  soundSignature(): { root: number; noise: number; ir: number; grains: number; checksum: number } {
    return this.graph.soundSignature();
  }

  /** The recorded root seed currently in use, or null when the engine has no performance seed. */
  get recordedRootSeed(): number | null {
    return this.rootSeed;
  }

  /**
   * §8.3 *natural* episode re-arm: stillness returned to `none` on its own, so the acknowledgement is
   * cleared and a later stillness must re-earn it. This is deliberately **not** an episode abort — the
   * physical master may still be gliding and the presence reveal brings it back — and it is *not* what a
   * restart uses (MAJOR 1: `restart()`/`applyResolution()` call `resetPerformance()`).
   */
  private rearm(): void {
    this.armed = false;
    this.terminalZeroAt = null;
  }

  private updateSilence(now: number, dt: number, quiet: boolean): void {
    if (this.phase === 'live') {
      this.quietSeconds = quiet ? this.quietSeconds + dt : 0;
      if (this.quietSeconds >= AUDIO.offSeconds) this.beginFade(now);
    }
    if (this.fadeDeadline !== null && now >= this.fadeDeadline) {
      this.phase = 'silent';
      // §8.3: `terminalZeroAt` is recorded when the deadline is *observed* (converted through the app's
      // real/performance clock), not projected from the nominal speed — the delivered performance rate
      // can lag `speed`, so a projection would disagree with the curator's own performance clock.
      this.terminalZeroAt = this.performanceAt(now);
      this.fadeDeadline = null;
      this.quietSeconds = 0;
    }
  }

  private beginFade(now: number): void {
    this.fadeStartedAt = now;
    const deadline = this.graph.beginTerminalFade(now, AUDIO.fadeSeconds);
    if (deadline <= now) {
      this.phase = 'silent';
      this.fadeDeadline = null;
      this.terminalZeroAt = this.performanceAt(now);
      return;
    }
    this.fadeDeadline = deadline;
    this.phase = 'fading';
  }

  /**
   * §3 porcelain blooms: only a newly accepted topology serial may trigger one. Obsolete-serial
   * skipping, the engine-assigned serial and the ≥ 15 s refractory are preserved. A serial is consumed
   * even when the bloom is suppressed, and a bloom is **dropped, never queued**, when it arrives during
   * the reveal, a terminal fade, invalid analysis, pause/mute, stillness, absent support, or while one
   * event group is already live.
   */
  private updateEvent(
    now: number,
    world: WorldState,
    presentation: PresentationAnalysis,
    controls: AudioControls,
  ): void {
    const serial = world.events.serial;
    if (serial <= this.lastEventSerial) return;
    // Obsolete serials (a jump after a stall) are skipped, not replayed.
    this.obsoleteEventsSkipped += serial - this.lastEventSerial - 1;
    this.lastEventSerial = serial; // consumed even when suppressed
    if (world.events.kind === 'none') return;
    if (!controls.valid || !presentation.valid) return;
    if (!this.presenceEligible) return;
    if (this.phase !== 'live' || this.revealActive(now)) return;
    if (this.paused || this.muted || this.armed) return;
    if (world.phase.stillnessState !== 'none') return;
    if (now - this.lastEventAt < AUDIO.eventRefractorySeconds) return;
    if (this.graph.liveNodes('event') > 0) return; // at most one live bloom group
    this.lastEventAt = now;
    const baseHz = bloomBaseHz(this.bloomDegree, this.bloomRegister);
    this.lastBloom = { at: now, baseHz, degree: this.bloomDegree, register: this.bloomRegister };
    this.graph.spawnEvent(now, {
      // §4 (TAKE-4) the bloom's note is a scale degree (coherence latch) in a register chosen by feature
      // scale — never derived from an in-flight pad glide.
      baseHz,
      strength: world.events.strength,
    });
  }

  private applyControls(now: number, controls: AudioControls): void {
    if (!controls.valid) return; // §3.4: invalid/stale tier → hold the last smoothed values.
    if (this.rootRevealUntil !== null && now >= this.rootRevealUntil) this.rootRevealUntil = null;
    const rootReveal = this.rootRevealUntil !== null;
    // §3 (TAKE-4) every filter follows the **selected carrier target** of the accepted degree, so it
    // steps with the chord rather than chasing an in-flight glide.
    const carriers = voicingCarriers(this.padDegree);
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      const on = i < controls.voiceCount;
      // §6 the pad floor is gated by presence eligibility (the latched §6 state, MAJOR 2): absent
      // support → exactly zero, and the floor is held through the hysteresis band.
      const level = this.presenceEligible && on ? (controls.voiceLevels[i] ?? 0) : 0;
      const values = {
        level,
        filterHz: mapVoiceFilterHz(carriers[i] ?? AUDIO.tonicHz, controls.intensity),
      };
      if (i === 0 && rootReveal) {
        // §6 (MINOR 4) the dedicated bounded root raise owns the root gain for its 0.75 s; the filter
        // follows normally, so the explicit ramp is never fought by the ordinary τ smoothing.
        this.graph.applyVoiceTone(0, values, now, { filterTau: AUDIO.filterTau });
      } else if (i === 0 && this.rootRevealPending) {
        // §6 (MAJOR) the reveal is pending through a prohibited interval: hold the root **down** with the
        // ordinary bounded τ and never schedule a positive target, so it cannot rise behind the mute or
        // under the stillness fade. `applyVoice` keeps the gain mirror in sync for the restart's
        // `from = rootLevelAt(now)`.
        this.graph.applyVoice(0, { ...values, level: 0 }, now, {
          levelTau: AUDIO.levelTau,
          filterTau: AUDIO.filterTau,
        });
      } else {
        // §2 the root follows the ordinary pad τ; an upper voice newly admitted/removed uses τ = 10 s.
        const transitioning = on !== this.voiceOn[i];
        const levelTau = i === 0 ? AUDIO.levelTau : transitioning ? AUDIO.upperVoiceTau : AUDIO.levelTau;
        this.graph.applyVoice(i, values, now, { levelTau, filterTau: AUDIO.filterTau });
      }
      this.voiceOn[i] = on;
    }
    this.graph.applyTexture(
      { level: controls.textureLevel, filterHz: controls.textureFilterHz },
      now,
      AUDIO.textureTau,
    );
    this.graph.applyWet(controls.wetGain, now, AUDIO.wetTau);
  }

  /**
   * §4 (MAJOR 4) granular scheduling with a short-horizon cursor.
   *
   * Rather than spawning every due grain at the tick's `now` — which batches a stalled tick's grains at
   * one instant — the engine keeps `grainCursor`, the context time of the next due grain, and each tick
   * emits grains only while the cursor is inside the §8.2 lookahead window `[now, now + lookaheadMs]`.
   * A material stall, an activation, or a transport resume resyncs the cursor to `now`, dropping overdue
   * debt instead of replaying it, so no burst is released at a resume timestamp. Grains are disabled
   * during the reveal and whenever support is ineligible; after the reveal the schedule begins from the
   * current time, never from accumulated debt. The ≤ 4 concurrent-grain bound (§4) is enforced.
   */
  private scheduleGrains(now: number, rawGap: number, controls: AudioControls): void {
    // Not scheduling: not present, during the reveal, paused/muted transport, or an invalid/zero-rate
    // tier. Pin the cursor to `now` so no debt accumulates while nothing is emitted.
    if (
      this.phase !== 'live' ||
      !this.unlocked ||
      !this.presenceEligible ||
      this.revealActive(now) ||
      this.paused ||
      this.muted ||
      !controls.valid ||
      controls.grainRate <= 0
    ) {
      this.grainCursor = now;
      return;
    }
    // A material stall (or the first tick after activation/resume) drops overdue debt.
    if (this.grainCursor === null || rawGap > AUDIO.stallSeconds) this.grainCursor = now;

    const horizon = now + AUDIO.lookaheadMs / 1000;
    while (this.graph.liveNodes('grain') < AUDIO.maxConcurrentGrains && this.grainCursor <= horizon) {
      // Never schedule in the past: an overdue cursor is resynced to `now` — one grain, never a batch.
      const when = Math.max(this.grainCursor, now);
      const seconds =
        AUDIO.grainMinSeconds + this.rng.next() * (AUDIO.grainMaxSeconds - AUDIO.grainMinSeconds);
      const offset = this.rng.next() * Math.max(0, AUDIO.noiseSeconds - seconds);
      this.graph.spawnGrain(when, { seconds, offset, level: AUDIO.grainPeak });
      // §4 next-grain spacing `(0.75 + 0.5·rng.next())/rate`.
      const spacing = (AUDIO.grainSpacingLow + AUDIO.grainSpacingRange * this.rng.next()) / controls.grainRate;
      this.grainCursor = when + spacing;
    }
  }

  /** Performance-seconds projection of an audio-clock time, using the last consumed clock (§3.3). */
  private performanceAt(contextTime: number): number {
    const clock = this.latest?.clock;
    if (!clock) return 0;
    const speed = safeSpeed(clock.speed);
    const delta = contextTime - this.graph.context.currentTime;
    return clock.performanceSeconds + delta * speed;
  }

  stats(): {
    nodes: GraphStats;
    phase: SilencePhase;
    quietSeconds: number;
    eventsSkipped: number;
    terminalZeroAt: number | null;
    /** §8.3 (MAJOR 1) the context time the current terminal fade began, or null. */
    fadeStartedAt: number | null;
    /**
     * §8.3 (MAJOR 2) the live master level the most recent `resetPerformance()` held from before its
     * de-click (null before any restart) — a restart holds this level rather than stepping to zero.
     */
    masterHeldAtRestart: number | null;
    armed: boolean;
    /** The live master-gain value (0 exactly once the silence gate has reached terminal zero). */
    masterGain: number;
    /** §6 whether the pad floor is currently eligible (support confirmed, hysteresis held). */
    presence: boolean;
    /** §6 distinct qualifying support samples counted toward the current (unconfirmed) crossing. */
    supportSamples: number;
    /** §6 the context time the current reveal window ends, or null. */
    revealUntil: number | null;
    /** §9.5 (TAKE-4) musicality diagnostics: selectors, degrees, carriers and accept/drop counters. */
    pitch: PitchDiagnostics;
  } {
    return {
      nodes: this.graph.stats(),
      phase: this.phase,
      quietSeconds: this.quietSeconds,
      eventsSkipped: this.obsoleteEventsSkipped,
      terminalZeroAt: this.terminalZeroAt,
      fadeStartedAt: this.fadeStartedAt,
      masterHeldAtRestart: this.masterHeldAtRestart,
      armed: this.armed,
      masterGain: this.graph.master.gain.value,
      presence: this.presenceEligible,
      supportSamples: this.supportSamples,
      revealUntil: this.revealUntil,
      pitch: this.pitchDiagnostics(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.graph.dispose();
  }
}

/** A positive playback speed, or 1 when the clock reports a non-finite value. */
function safeSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

// ---------------------------------------------------------------------------------------------
// §3.3 AudioSystem (live driver: context lifecycle, scheduler, transport, recording)
// ---------------------------------------------------------------------------------------------

export type AudioStatus = 'unavailable' | 'suspended' | 'unlocked' | 'running';

/** Construction options for the live driver: the recorded root seed seeds the §4.4 sound substream. */
export interface AudioSystemOptions {
  /** §4.4 recorded root seed; the noise/IR/grain material is derived from its `sound` substream. */
  rootSeed?: number;
}

/**
 * §3.3 `AudioSystem`. Owns the live `AudioContext`, the 50 ms scheduler that pumps the `AudioEngine`,
 * the §2.3 activation, transport mute and the MediaStream destination for the recorder. When audio
 * is unavailable (no `AudioContext`, a construction failure, or a machine with no output device) it
 * degrades to a truthful `unavailable` state and `silenceStatus()` reports the locked bypass.
 */
export class AudioSystem {
  private context: AudioContext | null = null;
  private engine: AudioEngine | null = null;
  private timer: ReturnType<typeof setInterval> | 0 = 0;
  private statusValue: AudioStatus = 'unavailable';
  /** The operator's own mute preference (the lab `mute` toggle / a mute command). */
  private muted = false;
  /**
   * A transient, non-operator mute gate: the §11.3 context-loss forced silence. Kept separate from the
   * preference so the two never overwrite each other (review fix MINOR 3).
   */
  private contextForcedMute = false;
  private disposed = false;

  constructor(options: AudioSystemOptions = {}) {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (typeof Ctor !== 'function') {
      this.statusValue = 'unavailable';
      return;
    }
    try {
      this.context = new Ctor({ latencyHint: 'playback' });
      this.engine = new AudioEngine(this.context, { unlocked: false, rootSeed: options.rootSeed });
      this.statusValue = this.context.state === 'running' ? 'running' : 'suspended';
      this.context.addEventListener?.('statechange', () => this.refreshStatus());
    } catch {
      this.context = null;
      this.engine = null;
      this.statusValue = 'unavailable';
    }
  }

  /** §2.3: one explicit gesture resumes the suspended context. Truthful about the outcome. */
  async unlock(): Promise<void> {
    if (!this.context || !this.engine) return;
    try {
      if (this.context.state === 'suspended') await this.context.resume();
    } catch {
      // No output device / denied: stay suspended — the truth is reported, not faked.
    }
    this.engine.setUnlocked(this.context.state === 'running');
    this.refreshStatus();
    if (this.context.state === 'running') this.startTimer();
  }

  private refreshStatus(): void {
    if (!this.context) {
      this.statusValue = 'unavailable';
      return;
    }
    this.statusValue =
      this.context.state === 'running' ? 'running' : this.context.state === 'closed' ? 'unavailable' : 'suspended';
    this.engine?.setUnlocked(this.statusValue === 'running');
  }

  private startTimer(): void {
    if (this.timer !== 0 || !this.engine || !this.context) return;
    this.timer = setInterval(() => {
      if (this.context && this.engine) this.engine.tick(this.context.currentTime);
    }, AUDIO.tickMs);
  }

  status(): AudioStatus {
    return this.statusValue;
  }

  audioUnlocked(): boolean {
    return this.statusValue === 'running';
  }

  available(): boolean {
    return this.engine !== null;
  }

  consume(world: WorldState): void {
    this.engine?.consume(world);
  }

  setTransport(paused: boolean): void {
    this.engine?.setPaused(paused);
  }

  /**
   * §8.3/§10 the **operator's** mute preference. The effective silence gate is
   * `preference OR context-forced`, so toggling the preference while the context is lost updates only
   * the preference (it cannot defeat the forced silence), and dropping the forced gate on restoration
   * leaves the latest preference in force.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMute();
  }

  /**
   * §11.3 the transient context-loss forced silence: independent of the operator preference and
   * dropped on restoration. `isMuted()` reports the OR of the two.
   */
  setContextMuted(value: boolean): void {
    this.contextForcedMute = value;
    this.applyMute();
  }

  /** The effective mute state (preference OR forced) — what the graph and every readout report. */
  isMuted(): boolean {
    return this.muted || this.contextForcedMute;
  }

  /** The operator's own mute preference, ignoring any transient forced gate. */
  mutePreference(): boolean {
    return this.muted;
  }

  private applyMute(): void {
    this.engine?.setMuted(this.isMuted());
  }

  prepareSilence(): void {
    this.engine?.prepareSilence();
  }

  /**
   * §8.3 (MAJOR 1/3) fresh-performance / episode abort at the audio boundary. Cancels the stale master
   * automation and deadlines, resets the stillness episode state and counters, and (when `rootSeed` is
   * supplied) reseeds the §4.4 sound substream, then establishes the new master transition. Called by
   * the app on `restart()` and `applyResolution()` (and on a `load-trajectory` that replaces the
   * document); a restart landing during a `kill-wait` fade can no longer inherit the abandoned
   * episode's terminal fade.
   */
  resetPerformance(rootSeed?: number): void {
    this.engine?.resetPerformance(undefined, rootSeed);
  }

  /** §4.4 the live sound substream (seeds + a material checksum), for verification. */
  soundSignature(): { root: number; noise: number; ir: number; grains: number; checksum: number } | null {
    return this.engine?.soundSignature() ?? null;
  }

  silenceStatus(): SilenceStatus {
    if (!this.engine) return { satisfied: true, terminalZeroAt: null };
    return this.engine.silenceStatus();
  }

  recordingStream(): MediaStream | null {
    return this.engine?.graph.mediaStreamDestination?.stream ?? null;
  }

  stats(): ReturnType<AudioEngine['stats']> | null {
    return this.engine?.stats() ?? null;
  }

  /**
   * §8 live-path verification: attach the destination-tapped analyser (idempotent). Returns whether an
   * audio graph exists to tap.
   */
  attachOutputAnalyser(): boolean {
    if (!this.engine) return false;
    this.engine.graph.attachOutputAnalyser();
    return true;
  }

  /**
   * The most recent destination-tapped output measurement (RMS/peak/spectrum), or null when audio is
   * unavailable or the analyser has not been attached. `audio-audible.spec.ts` uses this to prove real
   * sound reaches the destination.
   */
  outputMeasurement(): OutputMeasurement | null {
    return this.engine?.graph.outputMeasurement() ?? null;
  }

  /** §8 verification: every live gain value in the graph (see `AudioGraph.gainSnapshot`). */
  gainSnapshot(): ReturnType<AudioGraph['gainSnapshot']> | null {
    return this.engine?.graph.gainSnapshot() ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== 0) {
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      this.timer = 0;
    }
    this.engine?.dispose();
    this.engine = null;
    const context = this.context;
    this.context = null;
    this.statusValue = 'unavailable';
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
