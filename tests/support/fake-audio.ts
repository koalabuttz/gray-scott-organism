/**
 * A minimal, dependency-free fake of the parts of the Web Audio API the §8 audio graph uses.
 *
 * Node has no `AudioContext`/`OfflineAudioContext`, so the engine's state machine and the graph's
 * scheduling cannot be unit-tested against a real context. This fake implements exactly the node
 * surface `AudioGraph`/`AudioEngine` touch and **records** everything a test needs to assert on: the
 * scheduled automation of every `AudioParam` (so a stale fade can be shown to be cancelled), the
 * `start()` times of the one-shot buffer sources (so the §8.2 lookahead spread and stall behaviour can
 * be measured), and the filter types/parameters (so the §8.2 three-ratio event subgraph can be pinned).
 *
 * It is deliberately faithful about the two behaviours the MAJOR 1 fix depends on:
 * `cancelScheduledValues(t)` **removes** scheduled events at or after `t` (so "the old deadline can no
 * longer silence the fresh performance" is a real assertion, not a no-op), and scheduling never updates
 * an `AudioParam`'s intrinsic `value` (so a reader that infers the scheduled level from `param.value` is
 * caught, exactly as it would be against a real/offline context).
 */

export interface FakeParamEvent {
  kind: 'set' | 'linear' | 'target' | 'curve';
  value: number;
  time: number;
  tau?: number;
  /** For `curve` events: the scheduled curve samples and its duration. */
  curve?: Float32Array;
  duration?: number;
  /**
   * For `curve` events only: the start Chromium actually renders the curve from. It equals `time`
   * unless the requested time was at or behind the clock, in which case the browser snaps it forward to
   * the current render quantum (see `FakeAudioParam`). The overlap rule is checked against this, not
   * against the requested time — that difference *is* the bloom-envelope defect.
   */
  effectiveStart?: number;
}

/**
 * One 128-frame render quantum at 48 kHz (2.67 ms) — the granularity Chromium snaps a value curve's
 * start to. The fake's default sample rate is 48 kHz, so every fake context uses this quantum.
 */
const RENDER_QUANTUM_SECONDS = 128 / 48_000;

export class FakeAudioParam {
  value = 0;
  events: FakeParamEvent[] = [];
  cancels: number[] = [];

  /**
   * @param clock Reads the owning context's `currentTime`; needed only to model the value-curve snap.
   *   A param built without one behaves as if its clock never advanced.
   */
  constructor(private readonly clock: () => number = () => 0) {}

  /**
   * Chromium snaps a `setValueCurveAtTime` start forward to the current render quantum when the
   * requested time is at or behind the audio clock (a start a few ms ahead is still snapped). Anything
   * scheduled from the *requested* time then lands inside the curve's real interval and the browser
   * throws `NotSupportedError`.
   */
  private snapToQuantum(time: number): number {
    const now = this.clock();
    return time < now + RENDER_QUANTUM_SECONDS ? now + RENDER_QUANTUM_SECONDS : time;
  }

  /**
   * Faithful to Chromium's value-curve rule: no automation event may be scheduled **strictly inside** a
   * `setValueCurveAtTime` interval — `NotSupportedError` is thrown — while an event exactly at the
   * curve's end is accepted. Enforcing it here means a regression of the bloom-envelope overlap (or any
   * future curve/follow-up pair) fails in the unit suite, not only in a live browser.
   */
  private guardCurveOverlap(time: number, kind: string): void {
    for (const event of this.events) {
      if (event.kind !== 'curve' || event.duration === undefined) continue;
      const start = event.effectiveStart ?? event.time;
      if (time > start && time < start + event.duration) {
        throw new Error(
          `NotSupportedError: Failed to execute '${kind}' on 'AudioParam': ${kind}(..., ${time}) ` +
            `overlaps setValueCurveAtTime(..., ${start}, ${event.duration})`,
        );
      }
    }
  }

  /**
   * Schedules a value **without** touching the intrinsic `value` — faithful to the Web Audio spec, where
   * `setValueAtTime`/`linearRampToValueAtTime`/`setTargetAtTime` schedule automation but never update the
   * `value` attribute. This is exactly why the MAJOR 1 fix must not infer the scheduled master level from
   * `param.value`: against a real (and an offline) context it is stale.
   */
  setValueAtTime(value: number, time: number): this {
    this.guardCurveOverlap(time, 'setValueAtTime');
    this.events.push({ kind: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.guardCurveOverlap(time, 'linearRampToValueAtTime');
    this.events.push({ kind: 'linear', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    this.guardCurveOverlap(time, 'setTargetAtTime');
    this.events.push({ kind: 'target', value, time, tau });
    return this;
  }

  /**
   * §4/§3 `setValueCurveAtTime` (grain Hann windows and the bloom's raised-cosine attack). Records the
   * curve (first value, last value and the samples) so a test can assert the window shape and that the
   * endpoints are exactly zero. Faithful about not updating the intrinsic `value`, and about the
   * render-quantum snap.
   */
  setValueCurveAtTime(curve: Float32Array, time: number, duration: number): this {
    const last = curve.length > 0 ? curve[curve.length - 1]! : 0;
    const effectiveStart = this.snapToQuantum(time);
    this.guardCurveOverlap(effectiveStart, 'setValueCurveAtTime');
    this.events.push({ kind: 'curve', value: last, time, duration, curve: curve.slice(), effectiveStart });
    return this;
  }

  /** Removes every scheduled event at or after `time` (faithful to the Web Audio spec). */
  cancelScheduledValues(time: number): this {
    this.cancels.push(time);
    this.events = this.events.filter((event) => event.time < time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    return this.cancelScheduledValues(time);
  }

  /** The last scheduled event, or null. Convenience for assertions. */
  last(): FakeParamEvent | null {
    return this.events.length > 0 ? this.events[this.events.length - 1]! : null;
  }

  /** Scheduled (non-cancel) events at or after `time`. */
  eventsAtOrAfter(time: number): FakeParamEvent[] {
    return this.events.filter((event) => event.time >= time);
  }
}

class FakeAudioNode {
  connect(target: unknown): unknown {
    return target;
  }

  disconnect(): void {
    // no-op
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain: FakeAudioParam;

  constructor(clock: () => number = () => 0) {
    super();
    this.gain = new FakeAudioParam(clock);
  }
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  readonly frequency: FakeAudioParam;
  readonly detune: FakeAudioParam;
  /** The `PeriodicWave` set by `setPeriodicWave`, if any (a `PeriodicWave`-voiced drone). */
  wave: FakePeriodicWave | null = null;

  constructor(clock: () => number = () => 0) {
    super();
    this.frequency = new FakeAudioParam(clock);
    this.detune = new FakeAudioParam(clock);
  }

  setPeriodicWave(wave: FakePeriodicWave): void {
    this.wave = wave;
  }
  start(): void {}
  stop(): void {}
}

/** A fake `PeriodicWave` carrying the real/imag coefficient arrays and the normalization flag. */
export class FakePeriodicWave {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
    readonly disableNormalization: boolean,
  ) {}
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency: FakeAudioParam;
  readonly Q: FakeAudioParam;

  constructor(clock: () => number = () => 0) {
    super();
    this.frequency = new FakeAudioParam(clock);
    this.Q = new FakeAudioParam(clock);
  }
}

class FakeConvolverNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold: FakeAudioParam;
  readonly knee: FakeAudioParam;
  readonly ratio: FakeAudioParam;
  readonly attack: FakeAudioParam;
  readonly release: FakeAudioParam;

  constructor(clock: () => number = () => 0) {
    super();
    this.threshold = new FakeAudioParam(clock);
    this.knee = new FakeAudioParam(clock);
    this.ratio = new FakeAudioParam(clock);
    this.attack = new FakeAudioParam(clock);
    this.release = new FakeAudioParam(clock);
  }
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0]!;
  }
}

export class FakeBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  /** Every `start(when, offset, duration)` the graph issued on this source. */
  readonly starts: { when: number; offset: number; duration: number | null }[] = [];
  readonly stops: number[] = [];

  start(when = 0, offset = 0, duration?: number): void {
    this.starts.push({ when, offset, duration: duration ?? null });
  }

  stop(when = 0): void {
    this.stops.push(when);
  }
}

/**
 * A fake `BaseAudioContext`. `currentTime` is writable so a test can model a stalled or suspended
 * context, and every created node is retained in a registry for inspection.
 */
export class FakeAudioContext {
  currentTime = 0;
  sampleRate: number;
  readonly destination = new FakeAudioNode();
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  /** Every `createOscillator()` result, in creation order (the four §2 pad voices, plus bloom partials). */
  readonly oscillators: FakeOscillatorNode[] = [];
  /** Every `createPeriodicWave()` result, in creation order. */
  readonly periodicWaves: FakePeriodicWave[] = [];
  /** Every `createGain()` result, in creation order (voice gains, buses, …). */
  readonly gains: FakeGainNode[] = [];

  constructor(sampleRate = 48_000) {
    this.sampleRate = sampleRate;
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode(() => this.currentTime);
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode(() => this.currentTime);
    this.oscillators.push(node);
    return node;
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array, options?: { disableNormalization?: boolean }): FakePeriodicWave {
    const wave = new FakePeriodicWave(real, imag, options?.disableNormalization ?? false);
    this.periodicWaves.push(wave);
    return wave;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode(() => this.currentTime);
    this.filters.push(node);
    return node;
  }

  createConvolver(): FakeConvolverNode {
    return new FakeConvolverNode();
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return new FakeDynamicsCompressorNode(() => this.currentTime);
  }

  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  /** All buffer-source `start` times recorded so far, in order. */
  startTimes(): number[] {
    return this.bufferSources.flatMap((source) => source.starts.map((start) => start.when));
  }

  /** Filters created since `since` (an index into `filters`), for per-event assertions. */
  filtersSince(since: number): FakeBiquadFilterNode[] {
    return this.filters.slice(since);
  }
}

/** Cast the fake to the `BaseAudioContext` the graph expects (structural typing is not enough here). */
export function asBaseAudioContext(fake: FakeAudioContext): BaseAudioContext {
  return fake as unknown as BaseAudioContext;
}
