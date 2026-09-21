/**
 * §3.3/§7.1 presentation worker **client**: owns the bounded combined-sample buffer pool and the
 * worker lifecycle. One request is in flight at a time (no unbounded queue); a combined buffer is
 * reserved, filled through the analyzer's readback, then transferred to the worker and returned on
 * **every** branch so the pool recycles instead of allocating per sample. `reset(epoch)` moves the
 * worker's accepted epoch without dropping an in-flight request (it answers `stale` and the buffer
 * still returns); worker termination — the recovery path when the worker is unresponsive — recreates
 * the pool with fresh buffers and a hard bound preserved.
 *
 * **Recovery association (review fix MAJOR 3).** Every wired worker carries a **generation** token and
 * every in-flight request is stamped with its generation, sequence, epoch and stamp. `recover()` first
 * detaches the old worker's handlers, then bumps the generation and creates the new worker, so a late
 * reply from a terminated worker can neither run the live handler nor match the tracked request. A
 * result is accepted — and frees the in-flight slot — only when generation *and* sequence *and* epoch
 * *and* echoed stamp *and* returned buffer size all match the tracked request; any unsolicited,
 * duplicate, stale-generation or mismatched reply is ignored/quarantined without touching slot
 * ownership (counted as `ignored`). A synchronous `postMessage` failure recycles the reserved slot the
 * same way, rather than stranding it.
 *
 * The class is deliberately GPU-free and worker-library-free (a `WorkerLike` is injected), so the
 * whole protocol is unit-testable in Node (`worker-protocol.test.ts`).
 */
import type { SampleStamp } from '../core/types.ts';
import type { AnalyzeRequest, AnalyzeResult, ResetRequest, WorkerRequest } from './protocol.ts';

export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: AnalyzeResult }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export interface PresentationWorkerOptions {
  createWorker: () => WorkerLike;
  width: number;
  height: number;
  healthOffset: number;
  healthFormat: 'RGBA32F' | 'RGBA16F';
  slotBytes: number;
  slotCount?: number;
  epoch?: number;
}

export interface PresentationWorkerStats {
  requests: number;
  results: number;
  stale: number;
  errors: number;
  skips: number;
  terminations: number;
  /** Replies ignored/quarantined (unsolicited, duplicate, stale-generation or mismatched) + post failures. */
  ignored: number;
  slots: number;
  free: number;
}

interface Slot {
  buffer: ArrayBuffer;
  state: 'free' | 'reserved' | 'worker';
}

/** The identity of the single in-flight request, captured at submit time for reply validation. */
interface InFlightMeta {
  generation: number;
  sequence: number;
  epoch: number;
  stamp: SampleStamp;
}

const DEFAULT_SLOT_COUNT = 3;

export class PresentationWorker {
  private readonly options: PresentationWorkerOptions;
  private worker: WorkerLike;
  private slots: Slot[];
  private readonly slotCount: number;
  private epochValue: number;
  private sequence = 0;
  private latest: AnalyzeResult | null = null;
  private disposed = false;
  /** Bumped on every `recover()`; a wired worker only accepts replies of its own generation. */
  private generation = 0;
  /** The single in-flight slot (one request at a time). Identity is not preserved across a transfer. */
  private inFlightSlot: Slot | null = null;
  /** Identity of the in-flight request, used to validate (and quarantine) worker replies. */
  private inFlightMeta: InFlightMeta | null = null;
  /** Count of pooled buffers ever allocated (bounded per worker generation; recovery adds one pool). */
  private createdBuffers = 0;

  private requestCount = 0;
  private resultCount = 0;
  private staleCount = 0;
  private errorCount = 0;
  private skipCount = 0;
  private terminationCount = 0;
  private ignoredCount = 0;

  constructor(options: PresentationWorkerOptions) {
    this.options = options;
    this.slotCount = options.slotCount ?? DEFAULT_SLOT_COUNT;
    this.epochValue = options.epoch ?? 0;
    this.worker = options.createWorker();
    this.wire();
    this.slots = this.allocateSlots();
  }

  get acceptedEpoch(): number {
    return this.epochValue;
  }

  /** True while a request is in flight (the app skips rather than queueing). */
  get busy(): boolean {
    return this.inFlightSlot !== null;
  }

  /** The number of pooled buffers ever allocated (bounded per worker generation). */
  get bufferIdentityCount(): number {
    return this.createdBuffers;
  }

  /**
   * Reserve a free pooled buffer, or null when busy / none free. The caller fills it (via the
   * analyzer readback) and either `submit`s it or `release`s it.
   */
  acquire(): ArrayBuffer | null {
    if (this.disposed || this.busy) return null;
    const slot = this.slots.find((candidate) => candidate.state === 'free');
    if (!slot) return null;
    slot.state = 'reserved';
    return slot.buffer;
  }

  /** Return a reserved (unsubmitted) buffer to the pool. */
  release(buffer: ArrayBuffer): void {
    const slot = this.slots.find((candidate) => candidate.buffer === buffer);
    if (slot && slot.state === 'reserved') slot.state = 'free';
  }

  /** Transfer a reserved buffer to the worker. Returns false (and keeps it reserved) if busy. */
  submit(stamp: SampleStamp, buffer: ArrayBuffer): boolean {
    if (this.disposed) return false;
    if (this.busy) {
      this.skipCount += 1;
      return false;
    }
    const slot = this.slots.find((candidate) => candidate.buffer === buffer);
    if (!slot || slot.state !== 'reserved') return false;
    this.sequence += 1;
    const request: AnalyzeRequest = {
      type: 'analyze',
      epoch: this.epochValue,
      sequence: this.sequence,
      stamp,
      presentationWidth: this.options.width,
      presentationHeight: this.options.height,
      healthOffset: this.options.healthOffset,
      healthFormat: this.options.healthFormat,
      buffer,
    };
    // Track the request *before* posting: a synchronous (fake/worker) reply must validate against it.
    slot.state = 'worker';
    this.inFlightSlot = slot;
    this.inFlightMeta = { generation: this.generation, sequence: this.sequence, epoch: this.epochValue, stamp };
    try {
      this.worker.postMessage(request, [buffer]);
    } catch {
      // Synchronous failure: the buffer was not handed off. Recycle the reserved slot and ignore it.
      this.inFlightSlot = null;
      this.inFlightMeta = null;
      slot.state = 'free';
      this.ignoredCount += 1;
      return false;
    }
    this.requestCount += 1;
    return true;
  }

  /** The latest completed result, or null. Clears the stored result. */
  poll(): AnalyzeResult | null {
    const result = this.latest;
    this.latest = null;
    return result;
  }

  /**
   * Move the worker's accepted epoch. An in-flight request is **not** dropped: it answers `stale`
   * against the new epoch and its buffer still returns to the pool.
   */
  reset(epoch: number): void {
    this.epochValue = epoch;
    const message: ResetRequest = { type: 'reset', epoch };
    if (this.disposed) return;
    try {
      this.worker.postMessage(message, []);
    } catch {
      this.ignoredCount += 1;
    }
  }

  /**
   * Terminate and recreate the worker (unresponsive recovery). Old handlers are detached first and the
   * generation is bumped, so a late reply from the terminated worker cannot free the new request's slot
   * or publish an old result. The pool is reinitialized with fresh buffers; the hard slot bound is
   * preserved. Any in-flight buffer is lost with the old worker.
   */
  recover(): void {
    this.terminationCount += 1;
    this.detach();
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
    this.generation += 1;
    this.worker = this.options.createWorker();
    this.wire();
    this.slots = this.allocateSlots();
    this.inFlightSlot = null;
    this.inFlightMeta = null;
    this.latest = null;
    try {
      this.worker.postMessage({ type: 'reset', epoch: this.epochValue }, []);
    } catch {
      this.ignoredCount += 1;
    }
  }

  stats(): PresentationWorkerStats {
    return {
      requests: this.requestCount,
      results: this.resultCount,
      stale: this.staleCount,
      errors: this.errorCount,
      skips: this.skipCount,
      terminations: this.terminationCount,
      ignored: this.ignoredCount,
      slots: this.slots.length,
      free: this.slots.filter((slot) => slot.state === 'free').length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    try {
      this.worker.terminate();
    } catch {
      /* already gone */
    }
  }

  /** Clear the current worker's handlers (called before termination so no late reply can run them). */
  private detach(): void {
    try {
      this.worker.onmessage = null;
      this.worker.onerror = null;
    } catch {
      /* nothing to detach */
    }
  }

  private wire(): void {
    const generation = this.generation;
    this.worker.onmessage = (event): void => {
      if (generation !== this.generation) return; // a reply from a superseded worker generation
      this.onResult(event.data);
    };
    this.worker.onerror = (): void => {
      // A worker error drops the in-flight buffer; the app recreates on the next stall check.
    };
  }

  private onResult(result: AnalyzeResult): void {
    const slot = this.inFlightSlot;
    const meta = this.inFlightMeta;
    const accepted =
      slot !== null &&
      meta !== null &&
      meta.generation === this.generation &&
      result.sequence === meta.sequence &&
      result.epoch === meta.epoch &&
      result.buffer.byteLength === this.options.slotBytes &&
      result.stamp.epoch === meta.stamp.epoch &&
      result.stamp.step === meta.stamp.step &&
      result.stamp.simulationTime === meta.stamp.simulationTime;
    if (!accepted) {
      // Unsolicited, duplicate, stale-generation or mismatched reply: quarantine it without touching
      // slot ownership (the tracked in-flight request, if any, remains in flight).
      this.ignoredCount += 1;
      return;
    }
    this.resultCount += 1;
    if (result.status === 'stale') this.staleCount += 1;
    if (result.status === 'error') this.errorCount += 1;
    // A transfer re-creates the ArrayBuffer, so identity lookup is unreliable: use the tracked
    // in-flight slot. The returned buffer recycles it (the pool never grows per sample).
    slot.buffer = result.buffer;
    slot.state = 'free';
    this.inFlightSlot = null;
    this.inFlightMeta = null;
    this.latest = result;
  }

  private allocateSlots(): Slot[] {
    const slots: Slot[] = [];
    for (let i = 0; i < this.slotCount; i += 1) {
      slots.push({ buffer: new ArrayBuffer(this.options.slotBytes), state: 'free' });
      this.createdBuffers += 1;
    }
    return slots;
  }
}
