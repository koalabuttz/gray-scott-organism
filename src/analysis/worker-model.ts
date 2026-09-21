/**
 * §3.3 worker protocol handler, factored out of the worker entry so it is unit-testable in Node
 * without a real `Worker`. The model holds the accepted epoch and the reusable presentation engine;
 * an `analyze` whose epoch is not the accepted one answers `stale` (buffer returned), a decode failure
 * answers `error` (buffer returned), and a success answers `ok` with descriptors (+ an event when one
 * was recognized). Every branch returns the same buffer so pooled slots recycle.
 */
import { PresentationEngine } from './presentation.ts';
import type { AnalyzeRequest, AnalyzeResult, WorkerRequest } from './protocol.ts';

export interface WorkerModel {
  acceptedEpoch: number;
  engine: PresentationEngine | null;
  width: number;
  height: number;
}

export function createWorkerModel(epoch = 0): WorkerModel {
  return { acceptedEpoch: epoch, engine: null, width: 0, height: 0 };
}

function defaultClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Handle one request. `reset` returns null (no reply); `analyze` always returns a result. */
export function processRequest(
  request: WorkerRequest,
  model: WorkerModel,
  now: () => number = defaultClock,
): AnalyzeResult | null {
  if (request.type === 'reset') {
    model.acceptedEpoch = request.epoch;
    model.engine?.reset();
    return null;
  }
  const started = now();
  const analyze = request as AnalyzeRequest;
  const elapsed = (): number => now() - started;
  if (analyze.epoch !== model.acceptedEpoch) {
    return {
      type: 'result',
      epoch: analyze.epoch,
      sequence: analyze.sequence,
      stamp: analyze.stamp,
      status: 'stale',
      diagnostics: { reason: 'epoch-mismatch', packSaturated: false, workerMs: elapsed() },
      buffer: analyze.buffer,
    };
  }
  try {
    if (
      model.engine === null ||
      model.width !== analyze.presentationWidth ||
      model.height !== analyze.presentationHeight
    ) {
      model.engine = new PresentationEngine(analyze.presentationWidth, analyze.presentationHeight);
      model.width = analyze.presentationWidth;
      model.height = analyze.presentationHeight;
    }
    const bytes = new Uint8Array(analyze.buffer);
    const result = model.engine.analyze(bytes, analyze.stamp, analyze.healthOffset, analyze.healthFormat);
    return {
      type: 'result',
      epoch: analyze.epoch,
      sequence: analyze.sequence,
      stamp: analyze.stamp,
      status: 'ok',
      descriptors: result.payload,
      event: result.event,
      diagnostics: { packSaturated: result.packSaturated, workerMs: elapsed() },
      buffer: analyze.buffer,
    };
  } catch (error) {
    return {
      type: 'result',
      epoch: analyze.epoch,
      sequence: analyze.sequence,
      stamp: analyze.stamp,
      status: 'error',
      diagnostics: { reason: String(error), packSaturated: false, workerMs: elapsed() },
      buffer: analyze.buffer,
    };
  }
}
