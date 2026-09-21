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
  kind: 'set' | 'linear' | 'target';
  value: number;
  time: number;
  tau?: number;
}

export class FakeAudioParam {
  value = 0;
  events: FakeParamEvent[] = [];
  cancels: number[] = [];

  /**
   * Schedules a value **without** touching the intrinsic `value` — faithful to the Web Audio spec, where
   * `setValueAtTime`/`linearRampToValueAtTime`/`setTargetAtTime` schedule automation but never update the
   * `value` attribute. This is exactly why the MAJOR 1 fix must not infer the scheduled master level from
   * `param.value`: against a real (and an offline) context it is stale.
   */
  setValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'linear', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    this.events.push({ kind: 'target', value, time, tau });
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
  readonly gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();
  start(): void {}
  stop(): void {}
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = new FakeAudioParam();
}

class FakeConvolverNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
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
  /** Every `createGain()` result, in creation order (voice gains, buses, …). */
  readonly gains: FakeGainNode[] = [];

  constructor(sampleRate = 48_000) {
    this.sampleRate = sampleRate;
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode();
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  createConvolver(): FakeConvolverNode {
    return new FakeConvolverNode();
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return new FakeDynamicsCompressorNode();
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
