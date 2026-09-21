/**
 * §7.2/§7.3/§7.4 presentation-tier engine (Phase 3, tier-2).
 *
 * Given the combined sample buffer, the engine decodes the **256² envelope-weighted RGBA8** pack
 * (R=envelope-weighted U, G=envelope-weighted V, B=flux/.04, A=residual/.02) and the 1×1 float health
 * record, and computes the presentation descriptors in real units: mean U/V, envelope-weighted
 * occupancy/flux, a change rate measured against the previous sample's reduced V **divided by the
 * sampled numerical time interval** (never inferred from arrival time), edge density (mean
 * central-difference magnitude), 32-bin V-histogram entropy, a 2×2 gradient structure-tensor
 * coherence/orientation (the previous angle is kept when the orientation is ill-defined), reflection
 * correlation about the occupied centroid at high occupancy confidence, centroid/bounds, the §7.3
 * topology proxies with cross-sample tracking, the §7.4 spectral bands, and the §7.3/§3.4 event.
 *
 * All arrays are preallocated per engine; `reset(epoch)` clears the cross-sample history.
 */
import { PRESENTATION, SURFACE } from '../config.ts';
import type { SampleStamp } from '../core/types.ts';
import { EventRecognizer } from './events.ts';
import { decodeHealthRecordAt } from './float-format.ts';
import type { AnalysisEvent, AnalysisPayload, PresentationDescriptors } from './protocol.ts';
import { SpectrumAnalyzer } from './spectrum.ts';
import { TopologyAnalyzer } from './topology.ts';

export interface PresentationEngineResult {
  payload: AnalysisPayload;
  event?: AnalysisEvent;
  packSaturated: boolean;
}

export class PresentationEngine {
  readonly width: number;
  readonly height: number;

  private readonly v: Float32Array;
  private readonly prevV: Float32Array;
  private readonly histogram: Uint32Array;
  private readonly spectrum: SpectrumAnalyzer;
  private readonly topology: TopologyAnalyzer;
  private readonly events = new EventRecognizer();

  private hasPrev = false;
  private prevSimTime = 0;
  private prevOrientation = 0;
  private prevSymmetry = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.v = new Float32Array(width * height);
    this.prevV = new Float32Array(width * height);
    this.histogram = new Uint32Array(PRESENTATION.histogramBins);
    this.spectrum = new SpectrumAnalyzer(PRESENTATION.spectrumSize);
    this.topology = new TopologyAnalyzer(width, { birthPersistenceSamples: 3 });
  }

  /** Clear the cross-sample history (epoch change / field replacement). */
  reset(): void {
    this.hasPrev = false;
    this.prevSimTime = 0;
    this.prevOrientation = 0;
    this.prevSymmetry = 0;
    this.topology.reset();
    this.events.reset();
  }

  analyze(bytes: Uint8Array, stamp: SampleStamp, healthOffset: number, healthFormat: 'RGBA32F' | 'RGBA16F'): PresentationEngineResult {
    const width = this.width;
    const height = this.height;
    const n = width * height;
    const v = this.v;
    const threshold = PRESENTATION.occupancyThreshold;

    let sumU = 0;
    let sumV = 0;
    let flux = 0;
    let weightSum = 0;
    let weightedU = 0;
    let weightedV = 0;
    let occupied = 0;
    let occupiedTexels = 0;
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    let supportSum = 0;
    let packSaturated = false;
    for (let i = 0; i < n; i += 1) {
      const r = bytes[i * 4]! / 255;
      const g = bytes[i * 4 + 1]! / 255;
      const b = bytes[i * 4 + 2]! / 255;
      if (bytes[i * 4 + 2]! === 255 || bytes[i * 4 + 3]! === 255) packSaturated = true;
      v[i] = g;
      sumU += r;
      sumV += g;
      flux += b;
      weightSum += g;
      // §6 support: the mean smoothstep of the envelope-weighted reduced V across the support ramp.
      supportSum += smoothstep(SURFACE.supportVLow, SURFACE.supportVHigh, g);
      const x = i % width;
      const y = (i - x) / width;
      const u = (x + 0.5) / width;
      const vv = (y + 0.5) / height;
      weightedU += u * g;
      weightedV += vv * g;
      if (g > threshold) {
        occupied += 1;
        occupiedTexels += 1;
        if (u < minU) minU = u;
        if (vv < minV) minV = vv;
        if (u > maxU) maxU = u;
        if (vv > maxV) maxV = vv;
      }
    }

    const meanU = sumU / n;
    const meanV = sumV / n;
    const occupiedFraction = occupied / n;
    const reactionActivity = (flux / n) * PRESENTATION.fluxScale;
    const centroidUV: [number, number] = weightSum > 0 ? [weightedU / weightSum, weightedV / weightSum] : [0.5, 0.5];
    const boundsUV: [number, number, number, number] =
      occupiedTexels > 0 ? [minU, minV, maxU, maxV] : [0, 0, 0, 0];

    const changeRate = this.computeChangeRate(stamp.simulationTime);

    // Edge density + structure tensor (central differences, planar with clamped borders).
    let edgeSum = 0;
    let jxx = 0;
    let jyy = 0;
    let jxy = 0;
    for (let y = 0; y < height; y += 1) {
      const yt = y > 0 ? y - 1 : 0;
      const yb = y < height - 1 ? y + 1 : height - 1;
      for (let x = 0; x < width; x += 1) {
        const xl = x > 0 ? x - 1 : 0;
        const xr = x < width - 1 ? x + 1 : width - 1;
        const gx = (v[y * width + xr]! - v[y * width + xl]!) * 0.5;
        const gy = (v[yb * width + x]! - v[yt * width + x]!) * 0.5;
        edgeSum += Math.sqrt(gx * gx + gy * gy);
        if (v[y * width + x]! > threshold) {
          jxx += gx * gx;
          jyy += gy * gy;
          jxy += gx * gy;
        }
      }
    }
    const edgeDensity = edgeSum / n;
    const trace = jxx + jyy;
    const diff = jxx - jyy;
    const disc = Math.sqrt(diff * diff + 4 * jxy * jxy);
    const coherence = trace > 1e-12 ? (disc) / (trace) : 0;
    let orientation: number;
    if (coherence > 0.1 && disc > 1e-12) {
      orientation = 0.5 * Math.atan2(2 * jxy, diff);
      this.prevOrientation = orientation;
    } else {
      orientation = this.prevOrientation; // keep the previous angle when ill-defined
    }

    // 32-bin V histogram entropy.
    this.histogram.fill(0);
    for (let i = 0; i < n; i += 1) {
      let bin = Math.floor(v[i]! * PRESENTATION.histogramBins);
      if (bin < 0) bin = 0;
      if (bin >= PRESENTATION.histogramBins) bin = PRESENTATION.histogramBins - 1;
      this.histogram[bin] += 1;
    }
    let entropySum = 0;
    for (let b = 0; b < PRESENTATION.histogramBins; b += 1) {
      const p = this.histogram[b]! / n;
      if (p > 0) entropySum -= p * Math.log(p);
    }
    const entropy = entropySum / Math.log(PRESENTATION.histogramBins);

    let symmetry = this.prevSymmetry;
    if (coherence >= PRESENTATION.symmetryMinCoherence && occupiedFraction >= PRESENTATION.symmetryMinOccupied) {
      const cx = centroidUV[0] * width - 0.5;
      const cy = centroidUV[1] * height - 0.5;
      const corrX = this.reflectCorrelation(cx, cy, true);
      const corrY = this.reflectCorrelation(cx, cy, false);
      symmetry = Math.max(0, (corrX + corrY) * 0.5);
      this.prevSymmetry = symmetry;
    }

    const topology = this.topology.analyze(this.v, stamp.simulationTime);
    const spectrum = this.spectrum.analyze(this.v, width);

    const presentation: PresentationDescriptors = {
      meanU,
      meanV,
      occupiedFraction,
      reactionActivity,
      changeRate,
      edgeDensity,
      entropy,
      featureScaleUV: spectrum.featureScaleUV,
      spectralBands: spectrum.bands,
      beta0Approx: topology.beta0Approx,
      beta1Approx: topology.beta1Approx,
      largestComponentFraction: topology.largestComponentFraction,
      topologyConfidence: topology.topologyConfidence,
      persistenceSeconds: topology.persistenceSeconds,
      centroidUV,
      boundsUV,
      orientationRadians: orientation,
      coherence,
      symmetry,
      supportFraction: supportSum / n,
    };

    const event =
      this.events.update({
        beta0: topology.beta0Approx,
        beta1: topology.beta1Approx,
        largestComponentFraction: topology.largestComponentFraction,
        occupancy: occupiedFraction,
        activity: reactionActivity,
        topologyConfidence: topology.topologyConfidence,
        mergeCandidates: topology.mergeCandidates,
        hasNewPersistentComponent: topology.hasNewPersistentComponent,
        performanceSeconds: stamp.performanceSeconds,
      }) ?? undefined;

    // Update the previous-sample history for the next change-rate.
    this.prevV.set(v);
    this.hasPrev = true;
    this.prevSimTime = stamp.simulationTime;

    return { payload: { health: decodeHealthRecordAtHealth(bytes, healthOffset, healthFormat), presentation }, event, packSaturated };
  }

  private computeChangeRate(simulationTime: number): number {
    if (!this.hasPrev) return 0;
    const delta = simulationTime - this.prevSimTime;
    if (!(delta > 0)) return 0;
    let sum = 0;
    for (let i = 0; i < this.v.length; i += 1) sum += Math.abs(this.v[i]! - this.prevV[i]!);
    return sum / this.v.length / delta;
  }

  /** Normalized correlation of V with its reflection about (cx,cy) — horizontally or vertically. */
  private reflectCorrelation(cx: number, cy: number, horizontal: boolean): number {
    const width = this.width;
    const height = this.height;
    const v = this.v;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let y = 0; y < height; y += 1) {
      const my = horizontal ? y : Math.round(2 * cy - y);
      if (my < 0 || my >= height) continue;
      for (let x = 0; x < width; x += 1) {
        const mx = horizontal ? Math.round(2 * cx - x) : x;
        if (mx < 0 || mx >= width) continue;
        const a = v[y * width + x]!;
        const b = v[my * width + mx]!;
        dot += a * b;
        normA += a * a;
        normB += b * b;
      }
    }
    const denom = Math.sqrt(normA * normB);
    return denom > 1e-12 ? dot / denom : 0;
  }
}

/** Hermite smoothstep on `[lo, hi]`; flat at both ends, monotone, bounded to `[0, 1]`. */
function smoothstep(lo: number, hi: number, value: number): number {
  const span = hi - lo;
  if (!(span > 0)) return value >= hi ? 1 : 0;
  let t = (value - lo) / span;
  if (!Number.isFinite(t)) return 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

/** Decode the 1×1 float health record from the combined buffer at the stamped offset. */
function decodeHealthRecordAtHealth(
  bytes: Uint8Array,
  healthOffset: number,
  healthFormat: 'RGBA32F' | 'RGBA16F',
): { fullOccupiedFraction: number; fullReactionActivity: number; fullChangeRate: number } {
  const [o, a, c] = decodeHealthRecordAt(bytes, healthOffset, healthFormat);
  return { fullOccupiedFraction: o, fullReactionActivity: a, fullChangeRate: c };
}
