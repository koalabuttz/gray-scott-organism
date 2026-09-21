/**
 * The analysis module worker (§3.3). A classic Vite module worker: it is created by the analyzer as
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`. It owns one
 * `WorkerModel` and relays each reply with the sample buffer transferred back, so the pool recycles.
 */
import type { AnalyzeResult, WorkerRequest } from './protocol.ts';
import { createWorkerModel, processRequest } from './worker-model.ts';

interface WorkerScope {
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
  postMessage(message: AnalyzeResult, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const model = createWorkerModel();

scope.onmessage = (event): void => {
  const response = processRequest(event.data, model);
  if (response) scope.postMessage(response, [response.buffer]);
};
