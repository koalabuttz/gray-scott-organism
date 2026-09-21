/**
 * §8 audio architecture (Phase 3): the concrete §8.2 graph, the §8.1 signal engine, the §8.3 silence
 * gate, and the §3.3 `AudioSystem`.
 *
 * The module is split so the graph and the engine are usable with **both** an `AudioContext` and an
 * `OfflineAudioContext` (Test Strategy: "Audio graph factory usable with both"), which is what lets
 * `browser/audio-offline.spec.ts` render deterministic output and measure peaks, terminal zero and
 * voice bounds in-page without an audio device.
 *
 * Graph (§8.2), one instance per context:
 *
 *   4 sine/triangle voices → gain → low-pass ─┐
 *   reusable noise grains → high/band-pass → texture gain ├→ dry bus ─┐
 *   rare noise impulse → 3 resonant band-passes → event gain ─────────┘ │
 *                            └→ shared send → convolver → wet gain ────┘
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
import type { WorldState } from '../core/types.ts';
import { createImpulseResponse, createNoiseBuffer } from './buffers.ts';
import { deriveSoundSeeds, type SoundSubstreamSeeds } from './substream.ts';
import {
  DETUNE_SIGN,
  EVENT_RATIOS,
  VOICE_RATIOS,
  clamp,
  deriveAudioControls,
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

export interface AudioGraphOptions {
  /** §4.4 recorded root seed; the `sound` substream is derived from it (MAJOR 3). */
  rootSeed?: number;
  noiseSeed?: number;
  irSeed?: number;
  noiseSeconds?: number;
  irSeconds?: number;
  /** The master gain the silence gate restores to when not silent. */
  masterLevel?: number;
}

function setTarget(param: AudioParam, value: number, now: number, tau: number): void {
  param.setTargetAtTime(value, now, Math.max(1e-3, tau));
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
  // §4.4 sound substream: the seeds the noise/IR were generated from. Kept so a reseed can rebuild
  // them and the signature can report which substream is live.
  private soundSeeds: SoundSubstreamSeeds;
  private pending: PendingSource[] = [];
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
  private masterSegments: MasterSegment[] = [];

  constructor(context: BaseAudioContext, options: AudioGraphOptions = {}) {
    this.context = context;
    this.masterLevel = options.masterLevel ?? AUDIO.masterLevel;
    this.noiseSeconds = options.noiseSeconds ?? AUDIO.noiseSeconds;
    this.irSeconds = options.irSeconds ?? AUDIO.irSeconds;
    // §4.4 (MAJOR 3): the noise/IR/grain seeds come from the recorded root seed's `sound` substream
    // when one is supplied; the explicit seeds / fixed constants remain as a fallback for callers that
    // have no performance seed (e.g. a one-off graph probe).
    this.soundSeeds = resolveSoundSeeds(options);

    // The dry bus is the single merge point for the three source groups (§8.2).
    this.dryBus = context.createGain();
    this.dryBus.gain.value = 1;

    // --- four drone voices ---------------------------------------------------
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      const oscillator = context.createOscillator();
      // A sine fundamental floor with a slightly brighter triangle on the upper partials: still a
      // drone, never a "spectrum analyzer".
      oscillator.type = i === 0 ? 'sine' : 'triangle';
      oscillator.frequency.value = 55 * (VOICE_RATIOS[i] ?? 1);
      oscillator.detune.value = 0;
      const gain = context.createGain();
      gain.gain.value = 0;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 800;
      filter.Q.value = 0.4;
      oscillator.connect(gain).connect(filter).connect(this.dryBus);
      oscillator.start();
      this.voices.push({ oscillator, gain, filter });
    }

    // --- granular texture layer: grains → high/band-pass → texture gain ------
    this.textureBus = context.createGain();
    this.textureHighpass = context.createBiquadFilter();
    this.textureHighpass.type = 'highpass';
    this.textureHighpass.frequency.value = AUDIO.grainFilterMinHz;
    this.textureHighpass.Q.value = 0.5;
    this.textureBandpass = context.createBiquadFilter();
    this.textureBandpass.type = 'bandpass';
    this.textureBandpass.frequency.value = AUDIO.grainFilterMinHz;
    this.textureBandpass.Q.value = 1.2;
    this.textureGain = context.createGain();
    this.textureGain.gain.value = 0;
    this.textureBus
      .connect(this.textureHighpass)
      .connect(this.textureBandpass)
      .connect(this.textureGain)
      .connect(this.dryBus);

    // --- rare event excitation: impulse → 3 resonant band-passes → event gain
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
    this.dryBus.connect(this.mixBus);
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

  applyVoice(
    index: number,
    values: { frequencyHz: number; detuneCents: number; level: number; filterHz: number },
    now: number,
    taus: { frequencyTau: number; detuneTau: number; levelTau: number },
  ): void {
    const voice = this.voices[index];
    if (!voice) return;
    setTarget(voice.oscillator.frequency, values.frequencyHz, now, taus.frequencyTau);
    setTarget(voice.oscillator.detune, values.detuneCents, now, taus.detuneTau);
    setTarget(voice.gain.gain, values.level, now, taus.levelTau);
    setTarget(voice.filter.frequency, values.filterHz, now, taus.frequencyTau);
  }

  applyTexture(values: { level: number; filterHz: number }, now: number, tau: number): void {
    setTarget(this.textureGain.gain, values.level, now, tau);
    setTarget(this.textureBandpass.frequency, values.filterHz, now, tau);
    setTarget(this.textureHighpass.frequency, Math.min(AUDIO.grainFilterMinHz, values.filterHz * 0.5), now, tau);
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

  /** Wake from zero (§8.3): anchor at 0 and glide up; never a catch-up burst. */
  wakeFromZero(now: number, tau: number): void {
    const param = this.master.gain;
    const targetTau = Math.max(1e-3, tau);
    param.cancelScheduledValues(now);
    param.setValueAtTime(0, now);
    param.setTargetAtTime(this.masterLevel, now, targetTau);
    this.anchorEnvelope(now, 0);
    this.masterSegments.push({
      start: now,
      end: Number.POSITIVE_INFINITY,
      from: 0,
      to: this.masterLevel,
      curve: 'target',
      tau: targetTau,
    });
  }

  /** Smooth mute for pause/hidden-tab/context loss; no backlog is ever replayed. */
  setMuted(muted: boolean, now: number, tau = 0.15): void {
    setTarget(this.muteGain.gain, muted ? 0 : 1, now, tau);
  }

  // --- fresh-performance / activation master transitions --------------------

  /**
   * §8.3 fresh-performance anchor: synchronously cancel **all** scheduled master automation (so a stale
   * terminal fade from an abandoned episode can never reach its deadline and silence the new
   * performance) while **holding the computed live level** (MAJOR 1/2) rather than stepping to zero.
   * Used by the silent/armed activation paths and the locked fresh-performance abort, which do not ramp;
   * the audible restart path uses `declickMaster`.
   */
  cancelMasterAutomation(now: number): void {
    const param = this.master.gain;
    const live = this.masterLevelAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(live, now);
    this.anchorEnvelope(now, live);
  }

  /**
   * §2.3/§8.3 (MAJOR 2) bounded activation fade: anchor at exactly zero and ramp linearly up to the
   * live master level over `fadeSeconds`, ending with an assignment so the level is exact. Used on the
   * locked→running activation edge and, as the second half of `declickMaster`, for a restarted
   * performance.
   */
  fadeMasterIn(now: number, fadeSeconds: number): number {
    const param = this.master.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(0, now);
    const end = now + Math.max(1e-3, fadeSeconds);
    param.linearRampToValueAtTime(this.masterLevel, end);
    param.setValueAtTime(this.masterLevel, end);
    this.anchorEnvelope(now, 0);
    this.masterSegments.push({ start: now, end, from: 0, to: this.masterLevel, curve: 'linear' });
    return end;
  }

  /**
   * §8.3 (MAJOR 2) de-clicked fresh-performance transition: hold the computed live level at `now`, ramp
   * linearly to exactly zero over `declickSeconds` (80–150 ms), then ramp back up to the live level over
   * `fadeSeconds`. Returns the **zero instant** — the moment the master reaches zero — so the caller can
   * defer the buffer/IR swap to it. A restart therefore never steps a live master to zero: the
   * transition is continuous and the reseed happens while the master is at zero.
   */
  declickMaster(now: number, declickSeconds: number, fadeSeconds: number): number {
    const param = this.master.gain;
    const live = this.masterLevelAt(now);
    param.cancelScheduledValues(now);
    param.setValueAtTime(live, now);
    this.anchorEnvelope(now, live);
    const zeroAt = now + Math.max(1e-3, declickSeconds);
    param.linearRampToValueAtTime(0, zeroAt);
    param.setValueAtTime(0, zeroAt);
    this.masterSegments.push({ start: now, end: zeroAt, from: live, to: 0, curve: 'linear' });
    const end = zeroAt + Math.max(1e-3, fadeSeconds);
    param.linearRampToValueAtTime(this.masterLevel, end);
    param.setValueAtTime(this.masterLevel, end);
    this.masterSegments.push({ start: zeroAt, end, from: 0, to: this.masterLevel, curve: 'linear' });
    return zeroAt;
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

  // --- one-shot sources -----------------------------------------------------

  spawnGrain(when: number, spec: { seconds: number; offset: number; level: number }): void {
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const env = this.context.createGain();
    env.gain.value = 0;
    source.connect(env).connect(this.textureBus);

    const attack = Math.min(0.06, spec.seconds * 0.25);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(spec.level, when + attack);
    env.gain.linearRampToValueAtTime(0, when + spec.seconds);
    source.start(when, spec.offset, spec.seconds);
    source.stop(when + spec.seconds + 0.02);
    this.track([source, env], when + spec.seconds + 0.02, 'grain');
    this.grainsStarted += 1;
  }

  /**
   * One subtle resonant excitation from the current fundamental (§8.2): the impulse is fed into the
   * **three** §8.2 event resonances f/2f/3f (`EVENT_RATIOS`), each a band-pass at Q = 8, summed 1/3 each.
   */
  spawnEvent(when: number, spec: { fundamentalHz: number; level: number; seconds?: number }): void {
    const seconds = spec.seconds ?? 0.5;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const mix = this.context.createGain();
    mix.gain.value = 1 / EVENT_RATIOS.length;
    const nodes: AudioNode[] = [source, mix];
    for (const ratio of EVENT_RATIOS) {
      const band = this.context.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = clamp(spec.fundamentalHz * ratio, 20, 12000);
      band.Q.value = 8;
      source.connect(band).connect(mix);
      nodes.push(band);
    }
    const env = this.context.createGain();
    env.gain.value = 0;
    mix.connect(env).connect(this.eventGain);
    nodes.push(env);

    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(spec.level, when + 0.012);
    env.gain.linearRampToValueAtTime(0, when + seconds);
    source.start(when, 0, seconds);
    source.stop(when + seconds + 0.02);
    this.track(nodes, when + seconds + 0.02, 'event');
    this.eventsFired += 1;
  }

  private track(nodes: AudioNode[], stopAt: number, kind: 'grain' | 'event'): void {
    this.nodeCreated += nodes.length;
    this.pending.push({ nodes, stopAt, kind });
    if (this.pending.length > this.maxLiveNodes) this.maxLiveNodes = this.pending.length;
  }

  /** Disconnect every one-shot source whose stop time has passed. Bounds the live node count. */
  reap(now: number): void {
    if (this.pending.length === 0) return;
    const remaining: PendingSource[] = [];
    for (const entry of this.pending) {
      if (entry.stopAt <= now) {
        for (const node of entry.nodes) {
          try {
            node.disconnect();
          } catch {
            // Already torn down with the context; nothing to do.
          }
          this.nodeStopped += 1;
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
    this.textureBus.disconnect();
    this.textureHighpass.disconnect();
    this.textureBandpass.disconnect();
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
  private wakeSeconds = 0;
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
  private pendingReseed: { seeds: SoundSubstreamSeeds; at: number } | null = null;
  /**
   * §8.3 (MAJOR 2) the live master level the most recent `resetPerformance()` held from before its
   * de-click, or null before any restart. Instrumentation: the browser lifecycle fixture asserts a
   * restart held a live level (a de-click) rather than stepping to zero (a cut).
   */
  private masterHeldAtRestart: number | null = null;

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
    // Stay silent if stillness is armed or the gate is already at terminal zero (§8.3: quiet intent may
    // not create a loud sound from a dead field); otherwise fade up from exact zero.
    if (this.armed || this.phase === 'silent') {
      this.graph.cancelMasterAutomation(now);
      return;
    }
    this.graph.fadeMasterIn(now, AUDIO.activationFadeSeconds);
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
    // §8.3 (MAJOR 2) apply a reseed deferred to the de-click's zero instant, now that the master has
    // reached zero — the buffer/IR swap is inaudible here. (Independent of the world snapshot.)
    if (this.pendingReseed && now >= this.pendingReseed.at) {
      const { seeds } = this.pendingReseed;
      this.pendingReseed = null;
      this.graph.reseedSound(seeds);
      this.rng = new Rng(seeds.grains);
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
    const quiet =
      presentation.valid &&
      presentation.occupiedFraction < AUDIO.offOccupancy &&
      presentation.reactionActivity < AUDIO.offActivity;
    const active =
      presentation.valid &&
      (presentation.occupiedFraction >= AUDIO.wakeOccupancy ||
        presentation.reactionActivity >= AUDIO.wakeActivity);

    this.updateSilence(now, dt, quiet, active);
    this.updateEvent(now, world, controls);
    if (this.phase !== 'silent') this.applyControls(now, controls);
    this.scheduleGrains(now, rawGap, controls);
    this.graph.reap(now);
  }

  /**
   * §8.3 (MAJOR 1/2) fresh-performance / episode abort. Cancels the stale master automation and
   * deadlines, resets the stillness episode state and every counter, drops the granular scheduling
   * debt, and establishes a **de-clicked** new master transition: it holds the computed live level,
   * ramps to zero over `AUDIO.declickSeconds`, swaps the §4.4 sound substream while the master is at
   * zero, and then fades back up. A restart therefore never steps a live master to zero (MAJOR 2, no
   * click), and the stale terminal deadline from an abandoned episode can never fire (MAJOR 1). Called
   * by the app on `restart()` and `applyResolution()` (and on a `load-trajectory` that replaces the
   * active document).
   *
   * When `reseedTo` is supplied the §4.4 sound substream is rebuilt from that root seed. For an audible
   * (unlocked, unmuted, unpaused) graph the buffer/IR swap is deferred to the de-click's zero instant
   * (applied on the next tick) so it is inaudible; an inaudible graph swaps immediately.
   */
  resetPerformance(now?: number, reseedTo?: number): void {
    if (this.disposed) return;
    const at = now ?? this.graph.context.currentTime;
    const audible = this.unlocked && !this.muted && !this.paused;
    // The live level this restart holds from (MAJOR 2): the de-click ramps down from exactly here.
    this.masterHeldAtRestart = this.graph.masterLevelAt(at);
    // 1. Establish the new master transition: an audible graph holds the live level and de-clicks to
    //    zero before fading back up; a locked graph cancels outright and stays at zero for the
    //    activation edge to fade up.
    let zeroAt = at;
    if (audible) {
      zeroAt = this.graph.declickMaster(at, AUDIO.declickSeconds, AUDIO.activationFadeSeconds);
    } else {
      this.graph.cancelMasterAutomation(at);
    }
    // 2. Reset the stillness episode state and counters.
    this.phase = 'live';
    this.fadeDeadline = null;
    this.terminalZeroAt = null;
    this.armed = false;
    this.fadeStartedAt = null;
    this.quietSeconds = 0;
    this.wakeSeconds = 0;
    this.lastStillness = 'none';
    this.obsoleteEventsSkipped = 0;
    this.lastEventAt = Number.NEGATIVE_INFINITY;
    // 3. Drop the scheduling time/debt.
    this.lastTickTime = null;
    this.grainCursor = null;
    // 4. Reseed the §4.4 sound substream. An audible graph defers the buffer/IR swap to the de-click's
    //    zero instant; an inaudible graph swaps immediately.
    if (reseedTo !== undefined) {
      const seeds = deriveSoundSeeds(reseedTo);
      this.rootSeed = reseedTo >>> 0;
      if (audible) {
        this.pendingReseed = { seeds, at: zeroAt };
      } else {
        this.pendingReseed = null;
        this.graph.reseedSound(seeds);
        this.rng = new Rng(seeds.grains);
      }
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
   * physical master may still be gliding and the general wake path brings it back — and it is *not*
   * what a restart uses (MAJOR 1: `restart()`/`applyResolution()` call `resetPerformance()`, which
   * cancels the stale fade outright).
   */
  private rearm(): void {
    this.armed = false;
    this.terminalZeroAt = null;
  }

  private updateSilence(now: number, dt: number, quiet: boolean, active: boolean): void {
    if (this.phase === 'live') {
      this.quietSeconds = quiet ? this.quietSeconds + dt : 0;
      if (this.quietSeconds >= AUDIO.offSeconds) this.beginFade(now);
    } else if (this.phase === 'silent') {
      this.wakeSeconds = active ? this.wakeSeconds + dt : 0;
      if (this.wakeSeconds >= AUDIO.wakeSeconds) this.beginWake(now);
    }
    if (this.fadeDeadline !== null && now >= this.fadeDeadline) {
      this.phase = 'silent';
      // §8.3: `terminalZeroAt` is recorded when the deadline is *observed* (converted through the app's
      // real/performance clock), not projected from the nominal speed — the delivered performance rate
      // can lag `speed`, so a projection would disagree with the curator's own performance clock.
      this.terminalZeroAt = this.performanceAt(now);
      this.fadeDeadline = null;
      this.quietSeconds = 0;
      this.wakeSeconds = 0;
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

  private beginWake(now: number): void {
    this.phase = 'live';
    this.quietSeconds = 0;
    this.wakeSeconds = 0;
    // Audio is no longer at digital zero, so a later stillness must re-earn the acknowledgement.
    this.terminalZeroAt = null;
    this.graph.wakeFromZero(now, AUDIO.levelTau);
  }

  private updateEvent(now: number, world: WorldState, controls: AudioControls): void {
    const serial = world.events.serial;
    if (serial <= this.lastEventSerial) return;
    // Obsolete serials (a jump after a stall) are skipped, not replayed.
    this.obsoleteEventsSkipped += serial - this.lastEventSerial - 1;
    this.lastEventSerial = serial;
    if (world.events.kind === 'none') return;
    if (this.phase === 'silent') return;
    if (now - this.lastEventAt < AUDIO.eventRefractorySeconds) return;
    this.lastEventAt = now;
    this.graph.spawnEvent(now, {
      fundamentalHz: controls.fundamentalHz,
      level: AUDIO.eventLevelMax * clamp(0.4 + world.events.strength, 0.4, 1),
    });
  }

  private applyControls(now: number, controls: AudioControls): void {
    if (!controls.valid) return; // §3.4: invalid/stale tier → hold the last smoothed values.
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      const on = i < controls.voiceCount;
      this.graph.applyVoice(
        i,
        {
          frequencyHz: controls.voiceFrequencies[i] ?? controls.fundamentalHz,
          detuneCents: controls.detuneCents * (DETUNE_SIGN[i] ?? 1),
          level: on ? controls.voiceLevel * (AUDIO.voiceWeights[i] ?? 1) : 0,
          filterHz: controls.voiceFilters[i] ?? 600,
        },
        now,
        {
          frequencyTau: AUDIO.frequencyTau,
          detuneTau: AUDIO.detuneTau,
          // Removing a voice is a harmonic change (10–30 s); an audible voice follows descriptor τ.
          levelTau: on ? AUDIO.levelTau : AUDIO.harmonicTau,
        },
      );
    }
    this.graph.applyTexture(
      { level: controls.textureLevel, filterHz: controls.textureFilterHz },
      now,
      AUDIO.textureTau,
    );
    this.graph.applyWet(controls.wetGain, now, AUDIO.wetTau);
  }

  /**
   * §8.2 (MAJOR 4) granular scheduling with a short-horizon cursor.
   *
   * Rather than spawning every due grain at the tick's `now` — which batches a stalled tick's grains at
   * one instant — the engine keeps `grainCursor`, the context time of the next due grain, and each tick
   * emits grains only while the cursor is inside the §8.2 lookahead window `[now, now + lookaheadMs]`.
   * A material stall, an activation, or a transport resume resyncs the cursor to `now`, dropping overdue
   * debt instead of replaying it, so no burst is released at a resume timestamp. The ≤ 12 concurrent
   * grain bound (§8.2) is enforced on every spawn.
   */
  private scheduleGrains(now: number, rawGap: number, controls: AudioControls): void {
    // Not scheduling: silent, paused/muted transport, or an invalid/zero-rate tier. Pin the cursor to
    // `now` so no debt accumulates while nothing is emitted.
    if (
      this.phase === 'silent' ||
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
    const spacing = 1 / controls.grainRate;
    while (this.graph.liveNodes('grain') < AUDIO.maxConcurrentGrains && this.grainCursor <= horizon) {
      // Never schedule in the past: an overdue cursor is resynced to `now` — one grain, never a batch.
      const when = Math.max(this.grainCursor, now);
      const seconds =
        AUDIO.grainMinSeconds + this.rng.next() * (AUDIO.grainMaxSeconds - AUDIO.grainMinSeconds);
      const offset = this.rng.next() * Math.max(0, AUDIO.noiseSeconds - seconds);
      this.graph.spawnGrain(when, { seconds, offset, level: 0.9 + this.rng.next() * 0.1 });
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
  private muted = false;
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
  }

  isMuted(): boolean {
    return this.muted;
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
