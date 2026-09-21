/**
 * §3.3/AC.11 worker protocol: all three `result` statuses, combined-sample offsets, buffer identity
 * returned on every branch, worker termination/pool recreation and bounded slot reuse — synthetic and
 * GPU-free, so it exercises the real `processRequest` handler and the real `PresentationWorker` client.
 */
import { describe, expect, it } from 'vitest';
import { analysisSlotLayout } from '../src/analysis/analyzer.ts';
import type { AnalyzeRequest, AnalyzeResult, WorkerRequest } from '../src/analysis/protocol.ts';
import { PresentationWorker, type WorkerLike } from '../src/analysis/presentation-worker.ts';
import { createWorkerModel, processRequest, type WorkerModel } from '../src/analysis/worker-model.ts';
import type { SampleStamp } from '../src/core/types.ts';

const WIDTH = 256;
const HEIGHT = 256;
const LAYOUT = analysisSlotLayout(16);
const HEALTH_OFFSET = LAYOUT.healthOffset;
const SLOT_BYTES = LAYOUT.slotBytes;

function stamp(epoch: number, sequence = 1, performanceSeconds = epoch): SampleStamp {
  return {
    epoch,
    step: sequence * 10,
    simulationTime: sequence * 10,
    performanceSeconds,
    parameters: { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 },
  };
}

/** A combined buffer with a central disk in the presentation region and known health floats. */
function combinedBuffer(epoch = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(SLOT_BYTES);
  const bytes = new Uint8Array(buffer);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= 40 * 40;
      const i = (y * WIDTH + x) * 4;
      bytes[i] = inside ? 40 : 0; // R = envelope-weighted U
      bytes[i + 1] = inside ? 200 : 0; // G = envelope-weighted V
      bytes[i + 2] = inside ? 60 : 0; // B = flux/.04
      bytes[i + 3] = 0; // A = residual/.02
    }
  }
  new Float32Array(buffer, HEALTH_OFFSET, 4).set([0.3, 0.05, 0.01, 0]);
  void epoch;
  return buffer;
}

function analyzeRequest(buffer: ArrayBuffer, epoch = 0, overrides: Partial<AnalyzeRequest> = {}): AnalyzeRequest {
  return {
    type: 'analyze',
    epoch,
    sequence: 1,
    stamp: stamp(epoch),
    presentationWidth: WIDTH,
    presentationHeight: HEIGHT,
    healthOffset: HEALTH_OFFSET,
    healthFormat: 'RGBA32F',
    buffer,
    ...overrides,
  };
}

describe('§3.3 combined-sample layout (deviation 46)', () => {
  it('puts the presentation map at 0 and the health record at the canonical 0x40000', () => {
    expect(HEALTH_OFFSET).toBe(0x40000);
    expect(LAYOUT.framingOffset).toBe(0x40010);
    expect(LAYOUT.slotBytes).toBe(0x40010 + 16 * 16 * 4);
    // The framing offset is stable across float formats (16 bytes are reserved for the health record).
    expect(analysisSlotLayout(8).healthOffset).toBe(0x40000);
    expect(analysisSlotLayout(8).framingOffset).toBe(0x40010);
    expect(analysisSlotLayout(8).slotBytes).toBe(LAYOUT.slotBytes);
  });
});

describe('§3.3 processRequest statuses', () => {
  it('returns ok with descriptors and the same buffer when the epoch matches', () => {
    const model = createWorkerModel(3);
    const buffer = combinedBuffer(3);
    const result = processRequest(analyzeRequest(buffer, 3), model)!;
    expect(result.status).toBe('ok');
    expect(result.buffer).toBe(buffer);
    expect(result.descriptors).toBeDefined();
    expect(result.descriptors!.presentation.occupiedFraction).toBeGreaterThan(0);
    expect(Number.isFinite(result.descriptors!.presentation.meanV)).toBe(true);
    // Health decoded from the combined buffer at the stamped offset.
    expect(result.descriptors!.health.fullOccupiedFraction).toBeCloseTo(0.3, 5);
  });

  it('returns stale with the buffer when the request epoch is not accepted, and never creates an engine', () => {
    const model = createWorkerModel(3);
    const buffer = combinedBuffer(4);
    const result = processRequest(analyzeRequest(buffer, 4), model)!;
    expect(result.status).toBe('stale');
    expect(result.buffer).toBe(buffer);
    expect(result.descriptors).toBeUndefined();
    expect(result.diagnostics?.reason).toBe('epoch-mismatch');
    expect(model.engine).toBeNull();
  });

  it('returns error with the buffer when processing throws', () => {
    const model = createWorkerModel(0);
    const buffer = combinedBuffer(0);
    // Negative dimensions make the engine constructor throw: exercises the error branch.
    const result = processRequest(analyzeRequest(buffer, 0, { presentationWidth: -1, presentationHeight: 4 }), model)!;
    expect(result.status).toBe('error');
    expect(result.buffer).toBe(buffer);
    expect(result.descriptors).toBeUndefined();
    expect(typeof result.diagnostics?.reason).toBe('string');
  });

  it('reset moves the accepted epoch and answers the next mismatched analyze as stale', () => {
    const model = createWorkerModel(0);
    expect(processRequest({ type: 'reset', epoch: 7 }, model)).toBeNull();
    expect(model.acceptedEpoch).toBe(7);
    const result = processRequest(analyzeRequest(combinedBuffer(0), 0), model)!;
    expect(result.status).toBe('stale');
  });
});

/** A fake worker that routes messages through the real handler, replying synchronously. */
class SyncWorker implements WorkerLike {
  onmessage: ((event: { data: AnalyzeResult }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  constructor(readonly model: WorkerModel) {}
  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
    const reply = processRequest(message, this.model);
    if (reply) this.onmessage?.({ data: reply });
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** A fake worker that queues messages until the test delivers them (to hold a request in flight). */
class DeferredWorker implements WorkerLike {
  onmessage: ((event: { data: AnalyzeResult }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly pending: WorkerRequest[] = [];
  terminated = false;
  /** The handler attached when the first message was posted; survives a later detach (MAJOR 3). */
  private captured: ((event: { data: AnalyzeResult }) => void) | null = null;

  deliver(model: WorkerModel): void {
    const message = this.pending.shift();
    if (!message) return;
    const reply = processRequest(message, model);
    if (reply) this.onmessage?.({ data: reply });
  }

  /** The reply a pending message would produce, without delivering it (MAJOR 3 fixtures). */
  replyFor(model: WorkerModel, index = 0): AnalyzeResult | null {
    const message = this.pending[index];
    return message ? processRequest(message, model) : null;
  }

  postMessage(message: WorkerRequest): void {
    if (this.captured === null) this.captured = this.onmessage;
    this.pending.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Emit through the handler currently attached (exercises the live generation guard). */
  emitCurrent(result: AnalyzeResult | null): void {
    if (result) this.onmessage?.({ data: result });
  }

  /** Emit through the handler captured at post time, even though it has since been detached. */
  emitCaptured(result: AnalyzeResult | null): void {
    if (result) this.captured?.({ data: result });
  }
}

function makeClient(createWorker: () => WorkerLike): PresentationWorker {
  return new PresentationWorker({
    createWorker,
    width: WIDTH,
    height: HEIGHT,
    healthOffset: HEALTH_OFFSET,
    healthFormat: 'RGBA32F',
    slotBytes: SLOT_BYTES,
  });
}

describe('AC.11 worker client: pool, lifecycle and bounded reuse', () => {
  it('recycles a bounded set of slot buffers across many samples', () => {
    const models: WorkerModel[] = [];
    const client = makeClient(() => {
      const model = createWorkerModel(0);
      models.push(model);
      return new SyncWorker(model);
    });
    const seen = new Set<ArrayBuffer>();
    let first: ArrayBuffer | null = null;
    for (let i = 0; i < 30; i += 1) {
      const buffer = client.acquire();
      expect(buffer).not.toBeNull();
      if (first === null) first = buffer;
      seen.add(buffer!);
      expect(client.submit(stamp(0, i + 1, i), buffer!)).toBe(true);
      const result = client.poll();
      expect(result?.status).toBe('ok');
      expect(result?.buffer).toBe(buffer);
    }
    // Bounded slot reuse: the identity set never exceeds the pool, and the same buffer is handed back.
    expect(seen.size).toBeLessThanOrEqual(3);
    expect(client.bufferIdentityCount).toBeLessThanOrEqual(3);
    expect(seen.has(first!)).toBe(true);
    expect(models.length).toBe(1);
  });

  it('skips (rather than queueing) when a request is already in flight', () => {
    const model = createWorkerModel(0);
    const worker = new DeferredWorker();
    const client = makeClient(() => worker);
    const buffer = client.acquire()!;
    expect(client.submit(stamp(0), buffer)).toBe(true);
    expect(client.busy).toBe(true);
    expect(client.acquire()).toBeNull();
    // A second submit while busy is skipped and counted, not queued.
    expect(client.submit(stamp(0, 2), buffer)).toBe(false);
    expect(client.stats().skips).toBe(1);
    // Deliver the in-flight request: the buffer returns and the slot frees.
    worker.deliver(model);
    expect(client.busy).toBe(false);
    expect(client.poll()?.buffer).toBe(buffer);
  });

  it('keeps an in-flight buffer through reset (epoch move) and returns it', () => {
    const model = createWorkerModel(0);
    const worker = new DeferredWorker();
    const client = makeClient(() => worker);
    const buffer = client.acquire()!;
    client.submit(stamp(0), buffer);
    client.reset(1);
    expect(client.acceptedEpoch).toBe(1);
    // The analyze posted before the reset is processed first (old epoch) -> ok, buffer returned.
    worker.deliver(model);
    const result = client.poll();
    expect(result?.status).toBe('ok');
    expect(result?.buffer).toBe(buffer);
    expect(client.busy).toBe(false);
    // Then the reset is processed.
    worker.deliver(model);
    expect(model.acceptedEpoch).toBe(1);
  });

  it('recreates the worker and pool on termination recovery', () => {
    const workers: SyncWorker[] = [];
    const client = makeClient(() => {
      const worker = new SyncWorker(createWorkerModel(0));
      workers.push(worker);
      return worker;
    });
    const before = new Set<ArrayBuffer>();
    for (let i = 0; i < 6; i += 1) {
      const buffer = client.acquire()!;
      before.add(buffer);
      client.submit(stamp(0, i + 1), buffer);
      client.poll();
    }
    expect(workers.length).toBe(1);
    const identitiesBefore = client.bufferIdentityCount;

    client.recover();
    expect(workers.length).toBe(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(client.stats().terminations).toBe(1);
    // Fresh pool: a newly acquired buffer is not one of the previous generation's buffers.
    const fresh = client.acquire()!;
    expect(before.has(fresh)).toBe(false);
    expect(client.bufferIdentityCount).toBeGreaterThan(identitiesBefore);
    // The recreated worker received the epoch reset and still processes requests.
    expect(workers[1]!.posted.some((message) => message.type === 'reset')).toBe(true);
    client.submit(stamp(0, 99), fresh);
    expect(client.poll()?.status).toBe('ok');
  });
});

describe('AC.11 worker recovery association (MAJOR 3)', () => {
  it('a late reply from a terminated worker cannot free or misassociate the new request', () => {
    const model = createWorkerModel(0);
    const workerA = new DeferredWorker();
    const workerB = new DeferredWorker();
    const queue = [workerA, workerB];
    let next = 0;
    const client = makeClient(() => queue[next++]!);

    // Submit to worker A.
    const bufferA = client.acquire()!;
    expect(client.submit(stamp(0, 1), bufferA)).toBe(true);
    expect(client.busy).toBe(true);
    const aReply = workerA.replyFor(model)!;
    expect(aReply.status).toBe('ok');

    // Recover: A is terminated with its handlers detached, B takes over.
    client.recover();
    expect(workerA.terminated).toBe(true);
    const bufferB = client.acquire()!;
    expect(bufferB).not.toBe(bufferA);
    expect(client.submit(stamp(0, 2), bufferB)).toBe(true);
    expect(client.busy).toBe(true);

    // A's late reply is dead letter: the live handler was detached, and the captured handler's
    // generation guard drops it — counted as `ignored` (deviation 53/MAJOR 3) without touching the
    // new request's slot ownership.
    const ignoredBefore = client.stats().ignored;
    workerA.emitCurrent(aReply);
    workerA.emitCaptured(aReply);
    expect(client.busy, 'worker B stays busy').toBe(true);
    expect(client.poll(), 'no old result is publishable').toBeNull();
    expect(client.acquire(), 'the new request still owns its slot').toBeNull();
    expect(client.stats().results).toBe(0);
    expect(
      client.stats().ignored,
      'the stale-generation reply from the terminated worker is counted as exactly one `ignored`',
    ).toBe(ignoredBefore + 1);

    // B's own reply (after its epoch reset) alone recycles the slot.
    const bReply = workerB.replyFor(model, 1)!;
    expect(bReply.status).toBe('ok');
    workerB.emitCaptured(bReply);
    expect(client.busy).toBe(false);
    expect(client.poll()?.status).toBe('ok');
  });

  it('quarantines a duplicate reply and a mismatched-sequence reply without touching the slot', () => {
    const model = createWorkerModel(0);
    const worker = new DeferredWorker();
    const client = makeClient(() => worker);

    const buffer = client.acquire()!;
    client.submit(stamp(0, 1), buffer);
    const reply = worker.replyFor(model)!;
    worker.emitCurrent(reply);
    expect(client.busy).toBe(false);
    expect(client.poll()?.status).toBe('ok');
    const resultsAfterFirst = client.stats().results;

    // Duplicate: the slot is already recycled, so the repeated reply is quarantined, not published.
    worker.emitCurrent(reply);
    expect(client.busy).toBe(false);
    expect(client.poll(), 'a duplicate reply is not published again').toBeNull();
    expect(client.stats().results).toBe(resultsAfterFirst);
    expect(client.stats().ignored).toBeGreaterThanOrEqual(1);

    // Mismatched sequence: a fresh request stays in flight until its own matching reply arrives.
    const buffer2 = client.acquire()!;
    client.submit(stamp(0, 2), buffer2);
    const reply2 = worker.replyFor(model, 1)!;
    worker.emitCurrent({ ...reply2, sequence: reply2.sequence + 7 });
    expect(client.busy, 'a mismatched-sequence reply leaves the request in flight').toBe(true);
    expect(client.poll()).toBeNull();
    worker.emitCurrent(reply2);
    expect(client.busy).toBe(false);
    expect(client.poll()?.status).toBe('ok');
  });

  it('accepts a stale reply that matches the tracked request and recycles the slot', () => {
    const worker = new DeferredWorker();
    const client = makeClient(() => worker);
    const buffer = client.acquire()!;
    client.submit(stamp(0, 1), buffer);
    client.reset(1); // the accepted epoch moves; the posted analyze still carries epoch 0
    const stale = worker.replyFor(createWorkerModel(1))!; // a worker accepting epoch 1 answers stale
    expect(stale.status).toBe('stale');
    worker.emitCurrent(stale);
    expect(client.busy).toBe(false);
    expect(client.poll()?.status).toBe('stale');
    expect(client.stats().stale).toBe(1);
  });

  it('recycles the reserved slot when postMessage throws synchronously', () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage() {
        throw new Error('clone failed');
      },
      terminate() {
        /* no-op */
      },
    };
    const client = makeClient(() => worker);
    const buffer = client.acquire()!;
    expect(client.submit(stamp(0, 1), buffer)).toBe(false);
    expect(client.busy, 'the failed post leaves no request in flight').toBe(false);
    // The reserved buffer returned to the pool rather than being stranded in the 'worker' state.
    expect(client.acquire(), 'the slot is available again').not.toBeNull();
    expect(client.stats().ignored).toBeGreaterThanOrEqual(1);
  });
});
