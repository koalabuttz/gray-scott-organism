/**
 * §7.1 analysis readback: the GPU half of the two-tier system.
 *
 * One analysis tick runs four small passes sharing a single full-domain per-cell read:
 *   1. `reduce-coarse.frag` — one box average of the whole grid into a 16×16 **float** grid of raw,
 *      unclamped block means;
 *   2. `reduce-health.frag` — the exact float mean of that grid into the 1×1 **float** health record
 *      (tier 1; never passes through an 8-bit stage — deviation 35);
 *   3. `reduce-framing.frag` — packs the coarse grid into the 16×16 RGBA8 camera-framing map
 *      (deviation 36);
 *   4. `reduce-presentation.frag` — envelope-weighted 256×256 RGBA8 presentation pack (tier 2, §7.1).
 *
 * **Combined sample buffer (§3.3 canonical layout; deviation 46).** A slot is
 * `presentation 256² RGBA8 (0 … 0x40000) ‖ health 1×1 float (0x40000) ‖ framing 16×16 RGBA8 (0x40010)`.
 * The presentation map starts at 0 and the health record sits at the canonical `0x40000`; the small
 * framing map is appended after a 16-byte reserved health area so the offset is stable across the
 * RGBA32F/16F formats. `tests/worker-protocol.test.ts` and `tests/analyzer-layout.test.ts` pin this.
 *
 * **Readback ring.** Both (all three) regions are read into a **three-slot PBO ring**; a fence is
 * added, flushed once, and polled later with a zero-timeout `clientWaitSync`. The GPU is never waited
 * on synchronously. `poll(destination)` decodes the framing map and the float health record on the
 * main thread, and hands the raw combined bytes to the caller — which transfers them to the
 * presentation worker. A `null` fence is a dropped request (MINOR A); a sample whose epoch is no
 * longer current is discarded (MAJOR 2).
 */
import { ANALYSIS_LAYOUT, PRESENTATION } from '../config.ts';
import { FULLSCREEN_VERTEX_SHADER, FullscreenQuad } from '../gpu/fullscreen.ts';
import { Program, ResourceTracker, createColorTarget, deleteColorTarget } from '../gpu/resources.ts';
import type { ColorTarget } from '../gpu/resources.ts';
import type { FieldView, SampleStamp, Vec2 } from '../core/types.ts';
import { decodeHalf, decodeHealthRecordAt, type FloatFormat } from './float-format.ts';
import coarseSource from './shaders/reduce-coarse.frag?raw';
import framingSource from './shaders/reduce-framing.frag?raw';
import healthSource from './shaders/reduce-health.frag?raw';
import presentationSource from './shaders/reduce-presentation.frag?raw';

/** Coarse grid edge. Must match `COARSE` in `shaders/reduce-health.frag`. */
export const COARSE_SIZE = ANALYSIS_LAYOUT.framingSize;
const PRESENTATION_SIZE = PRESENTATION.width;
/** §3.3: the 1×1 float health record's canonical offset in the combined sample slot. */
export const HEALTH_OFFSET = ANALYSIS_LAYOUT.healthOffset;
/** The 16×16 framing map's offset, after a fixed 16-byte reserved health area. */
export const FRAMING_OFFSET = HEALTH_OFFSET + ANALYSIS_LAYOUT.healthReserveBytes;

/** A slot's byte layout: presentation map ‖ health record (reserved 16 bytes) ‖ framing map. */
export interface AnalysisSlotLayout {
  healthOffset: number;
  healthBytes: number;
  framingOffset: number;
  framingBytes: number;
  slotBytes: number;
}

/**
 * Slot layout for a health record of `bytesPerTexel` (16 on RGBA32F, 8 on the RGBA16F fallback). The
 * health offset is the canonical `0x40000` and the framing offset is fixed at `0x40010` in both
 * formats (16 bytes are reserved for the health record), so the only format-dependent quantity is the
 * slot's total size.
 */
export function analysisSlotLayout(bytesPerTexel: number): AnalysisSlotLayout {
  return {
    healthOffset: HEALTH_OFFSET,
    healthBytes: bytesPerTexel,
    framingOffset: FRAMING_OFFSET,
    framingBytes: ANALYSIS_LAYOUT.framingBytes,
    slotBytes: FRAMING_OFFSET + ANALYSIS_LAYOUT.framingBytes,
  };
}

/** §7.1: a three-slot ring, matching the number of samples that may be in flight. */
const SLOT_COUNT = 3;
/** A coarse texel counts as occupied above this mean-V threshold when deriving bounds. */
const COARSE_OCCUPIED_THRESHOLD = 0.02;

/** §7.1 packing scales (presentation + framing; the health record is unquantized). */
export const ANALYSIS_SCALES = {
  occupiedThreshold: 0.1,
  fluxScale: PRESENTATION.fluxScale,
  changeScale: PRESENTATION.changeScale,
} as const;

export interface ChemistryHealthSample {
  valid: true;
  epoch: number;
  fullOccupiedFraction: number;
  fullReactionActivity: number;
  fullChangeRate: number;
  simulationTime: number;
  performanceSeconds: number;
}

export interface CoarseField {
  size: number;
  /** Per-texel occupied fraction, row-major, 0..1. */
  occupancy: Float32Array;
  occupiedFraction: number;
  centroidUV: Vec2;
  /** [minU, minV, maxU, maxV] over occupied texels; zeroed when nothing is occupied. */
  boundsUV: readonly [number, number, number, number];
}

/**
 * A collected sample: full provenance, the decoded tier-1 health + framing map, and the raw combined
 * buffer (owned by the caller after `poll(destination)` — typically a pooled worker slot).
 */
export interface AnalysisSample {
  stamp: SampleStamp;
  bytes: Uint8Array;
  health: ChemistryHealthSample;
  coarse: CoarseField;
  /** True when the framing packing clamped at least one texel (the health value is exact). */
  packSaturated: boolean;
}

export interface AnalyzerDiagnostics {
  floatFormat: 'RGBA32F' | 'RGBA16F';
  requests: number;
  samples: number;
  staleDrops: number;
  nullFenceDrops: number;
  packSaturatedSamples: number;
}

export interface AnalyzerOptions {
  gl: WebGL2RenderingContext;
  tracker: ResourceTracker;
  width: number;
  height: number;
  epoch?: number;
}

export type { FloatFormat };

export class Analyzer {
  readonly coarseSize = COARSE_SIZE;
  readonly presentationSize = PRESENTATION_SIZE;
  readonly floatFormat: 'RGBA32F' | 'RGBA16F';
  readonly slotBytes: number;

  private readonly gl: WebGL2RenderingContext;
  private readonly tracker: ResourceTracker;
  private readonly coarseProgram: Program;
  private readonly framingProgram: Program;
  private readonly healthProgram: Program;
  private readonly presentationProgram: Program;
  private readonly quad: FullscreenQuad;
  private readonly coarseTarget: ColorTarget;
  private readonly framingTarget: ColorTarget;
  private readonly healthTarget: ColorTarget;
  private readonly presentationTarget: ColorTarget;
  private readonly readType: number;
  private readonly slots: PboSlot[];
  private readonly occupancyScratch = new Float32Array(COARSE_SIZE * COARSE_SIZE);
  private fallbackScratch: Uint8Array | null = null;
  private epochValue: number;
  private disposed = false;

  private requestCount = 0;
  private sampleCount = 0;
  private staleDrops = 0;
  private nullFenceDrops = 0;
  private packSaturatedSamples = 0;
  private waitFailedInjected = false;

  constructor(options: AnalyzerOptions) {
    const { gl, tracker } = options;
    this.gl = gl;
    this.tracker = tracker;
    this.epochValue = options.epoch ?? 0;

    const format = pickFloatFormat(gl, tracker);
    this.floatFormat = format.name;
    this.readType = format.readType;
    const layout = analysisSlotLayout(format.bytesPerTexel);
    this.slotBytes = layout.slotBytes;

    this.coarseProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, coarseSource, 'analysis.reduce-coarse', tracker);
    this.framingProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, framingSource, 'analysis.reduce-framing', tracker);
    this.healthProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, healthSource, 'analysis.reduce-health', tracker);
    this.presentationProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, presentationSource, 'analysis.reduce-presentation', tracker);
    this.quad = new FullscreenQuad(gl, tracker);

    this.coarseTarget = createColorTarget(
      gl, tracker, COARSE_SIZE, COARSE_SIZE, format.internalFormat, gl.RGBA, format.readType, gl.NEAREST, false,
    );
    this.framingTarget = createColorTarget(gl, tracker, COARSE_SIZE, COARSE_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, false);
    this.healthTarget = createColorTarget(
      gl, tracker, 1, 1, format.internalFormat, gl.RGBA, format.readType, gl.NEAREST, false,
    );
    this.presentationTarget = createColorTarget(
      gl, tracker, PRESENTATION_SIZE, PRESENTATION_SIZE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, false,
    );

    this.slots = [];
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const pbo = gl.createBuffer();
      if (pbo === null) throw new Error('analysis readback could not allocate a pixel-pack buffer');
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.slotBytes, gl.DYNAMIC_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      tracker.increment('buffers', 1);
      this.slots.push({ pbo, fence: null, stamp: null });
    }
  }

  get epoch(): number {
    return this.epochValue;
  }

  diagnostics(): AnalyzerDiagnostics {
    return {
      floatFormat: this.floatFormat,
      requests: this.requestCount,
      samples: this.sampleCount,
      staleDrops: this.staleDrops,
      nullFenceDrops: this.nullFenceDrops,
      packSaturatedSamples: this.packSaturatedSamples,
    };
  }

  /**
   * Issue one sample. Returns false when every slot is in flight (§7.1 skip), when the stamp epoch is
   * not current, or when the fence could not be created (a null fence is a *dropped* request).
   */
  request(field: { current: FieldView; previous: FieldView }, stamp: SampleStamp): boolean {
    if (this.disposed) return false;
    if (stamp.epoch !== this.epochValue) return false;
    const gl = this.gl;
    const slot = this.slots.find((candidate) => candidate.fence === null);
    if (!slot) return false;

    this.coarseProgram.use();
    this.coarseProgram.u2i('uGrid', field.current.width, field.current.height);
    this.coarseProgram.u1i('uOutSize', COARSE_SIZE);
    this.coarseProgram.u1f('uOccupiedThreshold', ANALYSIS_SCALES.occupiedThreshold);
    this.coarseProgram.texture('uField', 0, field.current.texture);
    this.coarseProgram.texture('uPrevious', 1, field.previous.texture);
    this.bindTarget(this.coarseTarget);
    this.quad.draw();

    this.framingProgram.use();
    this.framingProgram.u1f('uFluxScale', ANALYSIS_SCALES.fluxScale);
    this.framingProgram.u1f('uChangeScale', ANALYSIS_SCALES.changeScale);
    this.framingProgram.texture('uCoarse', 0, this.coarseTarget.texture);
    this.bindTarget(this.framingTarget);
    this.quad.draw();

    this.healthProgram.use();
    this.healthProgram.texture('uCoarse', 0, this.coarseTarget.texture);
    this.bindTarget(this.healthTarget);
    this.quad.draw();

    // Tier 2: envelope-weighted 256² presentation pack, read straight from the field + previous.
    this.presentationProgram.use();
    this.presentationProgram.u2i('uGrid', field.current.width, field.current.height);
    this.presentationProgram.u1i('uOutSize', PRESENTATION_SIZE);
    this.presentationProgram.u1f('uFluxScale', ANALYSIS_SCALES.fluxScale);
    this.presentationProgram.u1f('uChangeScale', ANALYSIS_SCALES.changeScale);
    this.presentationProgram.u1f('uEnvelopeFullStrengthRadius', PRESENTATION_ENVELOPE_FULL_RADIUS);
    this.presentationProgram.texture('uField', 0, field.current.texture);
    this.presentationProgram.texture('uPrevious', 1, field.previous.texture);
    this.bindTarget(this.presentationTarget);
    this.quad.draw();

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.presentationTarget.framebuffer);
    gl.readPixels(0, 0, PRESENTATION_SIZE, PRESENTATION_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.healthTarget.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, this.readType, HEALTH_OFFSET);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framingTarget.framebuffer);
    gl.readPixels(0, 0, COARSE_SIZE, COARSE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, FRAMING_OFFSET);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (fence === null) {
      slot.fence = null;
      slot.stamp = null;
      this.nullFenceDrops += 1;
      return false;
    }
    slot.fence = fence;
    slot.stamp = stamp;
    gl.flush();
    this.requestCount += 1;
    return true;
  }

  /**
   * Collect a completed sample into `destination` (a combined buffer of `slotBytes`), or null. Never
   * blocks; a `WAIT_FAILED` fence drops the sample, and a stale-epoch sample is discarded (MAJOR 2).
   * With no `destination` an internal scratch buffer is used (verification hooks).
   */
  poll(destination?: Uint8Array): AnalysisSample | null {
    if (this.disposed) return null;
    const gl = this.gl;
    for (const slot of this.slots) {
      if (slot.fence === null || slot.stamp === null) continue;
      const status = this.waitFailedInjected ? gl.WAIT_FAILED : gl.clientWaitSync(slot.fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) continue;
      gl.deleteSync(slot.fence);
      slot.fence = null;
      const stamp = slot.stamp;
      slot.stamp = null;
      if (status === gl.WAIT_FAILED) continue;
      if (stamp.epoch !== this.epochValue) {
        this.staleDrops += 1;
        continue;
      }
      const target = destination ?? this.scratch();
      if (target.length < this.slotBytes) throw new Error(`analysis destination is ${target.length} bytes, need ${this.slotBytes}`);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sample = this.decode(target, stamp);
      this.sampleCount += 1;
      if (sample.packSaturated) this.packSaturatedSamples += 1;
      return sample;
    }
    return null;
  }

  reset(epoch: number): void {
    this.epochValue = epoch;
    for (const slot of this.slots) {
      if (slot.fence !== null) this.gl.deleteSync(slot.fence);
      slot.fence = null;
      slot.stamp = null;
    }
  }

  /** Verification only: move the accepted epoch without touching the slots (poll-time guard). */
  retargetEpoch(epoch: number): void {
    this.epochValue = epoch;
  }

  /**
   * Verification only (AC.11): force the next completed fence to be treated as `WAIT_FAILED`, so the
   * drop-and-recycle path can be exercised deterministically without monkey-patching the GL context.
   */
  forceWaitFailed(value: boolean): void {
    this.waitFailedInjected = value;
  }

  /**
   * §10 laboratory-only diagnostic readback: copy the reduced presentation map (256² RGBA8, G = V)
   * into `out`. Synchronous, so it is gated by the lab's overlay selection and throttled by the app;
   * it is never used on the presentation path.
   */
  readPresentationRGBA8(out: Uint8Array): void {
    if (this.disposed) return;
    if (out.length < PRESENTATION_SIZE * PRESENTATION_SIZE * 4) {
      throw new Error('presentation diagnostic buffer is too small');
    }
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.presentationTarget.framebuffer);
    gl.readPixels(0, 0, PRESENTATION_SIZE, PRESENTATION_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      if (slot.fence !== null) this.gl.deleteSync(slot.fence);
      this.gl.deleteBuffer(slot.pbo);
      this.tracker.increment('buffers', -1);
    }
    this.slots.length = 0;
    this.coarseProgram.dispose();
    this.framingProgram.dispose();
    this.healthProgram.dispose();
    this.presentationProgram.dispose();
    this.quad.dispose();
    deleteColorTarget(this.gl, this.tracker, this.coarseTarget);
    deleteColorTarget(this.gl, this.tracker, this.framingTarget);
    deleteColorTarget(this.gl, this.tracker, this.healthTarget);
    deleteColorTarget(this.gl, this.tracker, this.presentationTarget);
  }

  private scratch(): Uint8Array {
    if (this.fallbackScratch === null || this.fallbackScratch.length !== this.slotBytes) {
      this.fallbackScratch = new Uint8Array(this.slotBytes);
    }
    return this.fallbackScratch;
  }

  private bindTarget(target: ColorTarget): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  private decode(bytes: Uint8Array, stamp: SampleStamp): AnalysisSample {
    const [occupiedFraction, flux, change] = decodeHealthRecord(bytes, this.floatFormat);

    const occupancy = this.occupancyScratch;
    let sum = 0;
    let weightedU = 0;
    let weightedV = 0;
    let minU = 1;
    let minV = 1;
    let maxU = 0;
    let maxV = 0;
    let occupiedTexels = 0;
    let packSaturated = false;
    for (let y = 0; y < COARSE_SIZE; y += 1) {
      for (let x = 0; x < COARSE_SIZE; x += 1) {
        const index = FRAMING_OFFSET + (y * COARSE_SIZE + x) * 4;
        const value = bytes[index]! / 255;
        if (bytes[index + 3]! > 0) packSaturated = true;
        occupancy[y * COARSE_SIZE + x] = value;
        sum += value;
        const u = (x + 0.5) / COARSE_SIZE;
        const v = (y + 0.5) / COARSE_SIZE;
        weightedU += u * value;
        weightedV += v * value;
        if (value > COARSE_OCCUPIED_THRESHOLD) {
          occupiedTexels += 1;
          if (u < minU) minU = u;
          if (v < minV) minV = v;
          if (u > maxU) maxU = u;
          if (v > maxV) maxV = v;
        }
      }
    }

    const texels = COARSE_SIZE * COARSE_SIZE;
    return {
      stamp,
      bytes,
      packSaturated,
      health: {
        valid: true,
        epoch: stamp.epoch,
        fullOccupiedFraction: occupiedFraction,
        fullReactionActivity: flux,
        fullChangeRate: change,
        simulationTime: stamp.simulationTime,
        performanceSeconds: stamp.performanceSeconds,
      },
      coarse: {
        size: COARSE_SIZE,
        occupancy,
        occupiedFraction: sum / texels,
        centroidUV: sum > 0 ? [weightedU / sum, weightedV / sum] : [0.5, 0.5],
        boundsUV: occupiedTexels > 0 ? [minU, minV, maxU, maxV] : [0, 0, 0, 0],
      },
    };
  }
}

interface PboSlot {
  pbo: WebGLBuffer;
  fence: WebGLSync | null;
  stamp: SampleStamp | null;
}

/** §5.4 support-envelope full-strength radius, applied inside the presentation reduction. */
const PRESENTATION_ENVELOPE_FULL_RADIUS = 0.65;

/**
 * RGBA32F when the device can render it (EXT_color_buffer_float), else RGBA16F. `allocate` is
 * injectable so the fallback path is unit-testable without a GL context (MINOR 4).
 */
export function pickFloatFormat(
  gl: WebGL2RenderingContext,
  tracker: ResourceTracker,
  allocate: (candidate: FloatFormat, gl: WebGL2RenderingContext, tracker: ResourceTracker) => void = allocateProbeTarget,
): FloatFormat {
  const candidates: FloatFormat[] = [
    { name: 'RGBA32F', internalFormat: gl.RGBA32F, readType: gl.FLOAT, bytesPerTexel: 16 },
    { name: 'RGBA16F', internalFormat: gl.RGBA16F, readType: gl.HALF_FLOAT, bytesPerTexel: 8 },
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    try {
      allocate(candidate, gl, tracker);
      return candidate;
    } catch {
      while (gl.getError() !== gl.NO_ERROR) {
        /* drain */
      }
    }
  }
  throw new Error('analysis health reduction requires a float-renderable format (RGBA32F or RGBA16F)');
}

/** The default probe: allocate a 1x1 target in the candidate format and immediately free it. */
function allocateProbeTarget(candidate: FloatFormat, gl: WebGL2RenderingContext, tracker: ResourceTracker): void {
  const probe = createColorTarget(gl, tracker, 1, 1, candidate.internalFormat, gl.RGBA, candidate.readType, gl.NEAREST, false);
  deleteColorTarget(gl, tracker, probe);
}

/**
 * Read the 1×1 float health record from a combined sample buffer (RGBA32F -> 4 floats; RGBA16F -> 4
 * decoded halves). Pure, so the fallback decode is unit-testable (MINOR 4).
 */
export function decodeHealthRecord(bytes: Uint8Array, format: 'RGBA32F' | 'RGBA16F'): [number, number, number] {
  return decodeHealthRecordAt(bytes, HEALTH_OFFSET, format);
}

export { decodeHalf };
