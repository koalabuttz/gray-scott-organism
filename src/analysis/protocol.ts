/**
 * §3.3 worker protocol types (Phase 3, tier-2). One transferable combined-sample buffer per request;
 * the reply returns the *same* buffer as a transferable on **every** branch (`ok`/`stale`/`error`) so
 * pooled slots recycle. The worker never queues: the analyzer keeps at most one request in flight.
 */
import type { SampleStamp } from '../core/types.ts';

/** Tier-1 full-domain chemistry health, decoded by the worker from the combined buffer. */
export interface HealthValues {
  fullOccupiedFraction: number;
  fullReactionActivity: number;
  fullChangeRate: number;
}

/** §7.2/§7.3/§7.4 presentation-tier descriptors (numeric; ages are assigned by the app publisher). */
export interface PresentationDescriptors {
  meanU: number;
  meanV: number;
  occupiedFraction: number;
  reactionActivity: number;
  changeRate: number;
  edgeDensity: number;
  entropy: number;
  featureScaleUV: number;
  spectralBands: [number, number, number, number];
  beta0Approx: number;
  beta1Approx: number;
  largestComponentFraction: number;
  topologyConfidence: number;
  persistenceSeconds: number;
  centroidUV: [number, number];
  boundsUV: [number, number, number, number];
  orientationRadians: number;
  coherence: number;
  symmetry: number;
}

/** The numeric payload carried by an `ok` result (both tiers). */
export interface AnalysisPayload {
  health: HealthValues;
  presentation: PresentationDescriptors;
}

export type EventKind = 'birth' | 'merge' | 'fragment' | 'collapse' | 'surge';

/** A recognized salient event candidate (the app assigns the monotonic serial). */
export interface AnalysisEvent {
  kind: EventKind;
  strength: number;
  atPerformanceSeconds: number;
}

export interface AnalyzeRequest {
  type: 'analyze';
  epoch: number;
  sequence: number;
  stamp: SampleStamp;
  presentationWidth: number;
  presentationHeight: number;
  healthOffset: number;
  healthFormat: 'RGBA32F' | 'RGBA16F';
  /** The combined sample: presentation (RGBA8) ‖ health (float) ‖ framing (RGBA8). */
  buffer: ArrayBuffer;
}

/** Moves the worker's accepted epoch; any in-flight request carrying an older epoch answers `stale`. */
export interface ResetRequest {
  type: 'reset';
  epoch: number;
}

export type WorkerRequest = AnalyzeRequest | ResetRequest;

export interface AnalyzeResult {
  type: 'result';
  epoch: number;
  sequence: number;
  stamp: SampleStamp;
  status: 'ok' | 'stale' | 'error';
  /** Present only when `status === 'ok'`. */
  descriptors?: AnalysisPayload;
  /** Present only when `status === 'ok'` and a salient event was recognized this sample. */
  event?: AnalysisEvent;
  /** Present on `stale`/`error` (a reason string) and on `ok` (pack saturation + worker time). */
  diagnostics?: { reason?: string; packSaturated: boolean; workerMs: number };
  /** Returned on every branch so the pooled slot recycles. */
  buffer: ArrayBuffer;
}

/** Total combined-sample bytes for a layout: presentation ‖ reserved health ‖ framing. */
export function combinedBufferBytes(
  presentationWidth: number,
  presentationHeight: number,
  healthReserveBytes: number,
  framingBytes: number,
): number {
  return presentationWidth * presentationHeight * 4 + healthReserveBytes + framingBytes;
}
