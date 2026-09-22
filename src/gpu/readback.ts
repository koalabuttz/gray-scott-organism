/**
 * Readback helpers.
 *
 * Phase 1 uses these only for verification (GPU-vs-CPU comparison, clipping instrumentation,
 * composite screenshots). No per-frame CPU readback exists in the render path.
 */

/** Read an RG32F field as (U, V) floats, interleaved. */
export function readFieldRG(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  width: number,
  height: number,
  out?: Float32Array,
): Float32Array {
  const buffer = out ?? new Float32Array(width * height * 2);
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  // ES3 allows the (RG, FLOAT) and (RGBA, FLOAT) combinations for integer-format float
  // textures. RGBA/FLOAT keeps alignment trivial and is accepted on both Mesa and SwiftShader.
  const scratch = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, scratch);
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 2] = scratch[i * 4]!;
    buffer[i * 2 + 1] = scratch[i * 4 + 1]!;
  }
  return buffer;
}

/** Read the default framebuffer as tightly packed RGBA8. */
export function readCompositeRGBA8(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  out?: Uint8Array,
): Uint8Array {
  const buffer = out ?? new Uint8Array(width * height * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
  return buffer;
}

export interface ImageStats {
  width: number;
  height: number;
  min: number;
  max: number;
  mean: number;
  nonBlackFraction: number;
  /** Fraction of pixels above 1/255 in any channel. */
  anyNonZeroFraction: number;
  /** Fraction of pixels whose luma exceeds 32/255 (legibility aid, not a gate). */
  aboveThresholdFraction: number;
  /** Fraction of pixels at or above 250/255 (highlight clipping, watched during calibration). */
  clippedFraction: number;
  /** Luma percentiles p50, p95, p99 (0..255). */
  percentiles: [number, number, number];
  channelMean: [number, number, number];
}

export function imageStats(pixels: Uint8Array, width: number, height: number): ImageStats {
  let min = 255;
  let max = 0;
  let sum = 0;
  let nonBlack = 0;
  let anyNonZero = 0;
  let aboveThreshold = 0;
  let clipped = 0;
  const histogram = new Uint32Array(256);
  const channelSum: [number, number, number] = [0, 0, 0];
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const r = pixels[i * 4]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    const luma = Math.max(r, g, b);
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    sum += luma;
    histogram[luma] += 1;
    if (luma > 2) nonBlack += 1;
    if (luma > 32) aboveThreshold += 1;
    if (luma >= 250) clipped += 1;
    if (r > 1 || g > 1 || b > 1) anyNonZero += 1;
    channelSum[0] += r;
    channelSum[1] += g;
    channelSum[2] += b;
  }

  const atPercentile = (p: number): number => {
    const target = (p / 100) * count;
    let running = 0;
    for (let value = 0; value < 256; value += 1) {
      running += histogram[value]!;
      if (running >= target) return value;
    }
    return 255;
  };

  return {
    width,
    height,
    min,
    max,
    mean: sum / count,
    nonBlackFraction: nonBlack / count,
    anyNonZeroFraction: anyNonZero / count,
    aboveThresholdFraction: aboveThreshold / count,
    clippedFraction: clipped / count,
    percentiles: [atPercentile(50), atPercentile(95), atPercentile(99)],
    channelMean: [channelSum[0] / count, channelSum[1] / count, channelSum[2] / count],
  };
}

/**
 * §12.4-B colour statistics over the *lit* pixels of a composite frame, so a refinement can be shown
 * to have shifted hue **without** raising saturation or the neutral floor. "Lit" is the same luma>2
 * test `imageStats` uses; hue/saturation are measured in the sRGB-encoded output, which is what an
 * operator actually sees. A perfectly neutral frame reports `meanSaturation` 0, `warmMinusCool` 0
 * and an all-zero `hueHistogram` — that is the control the palette-restraint claim is checked against.
 */
export interface ImageColorStats {
  width: number;
  height: number;
  litPixels: number;
  litFraction: number;
  /** Mean R, G, B over lit pixels, 0..255. */
  meanLitRGB: [number, number, number];
  /** Mean (R − B) over lit pixels, 0..255: positive is warmer, 0 is neutral. */
  warmMinusCool: number;
  /** Mean HSV saturation over lit pixels (0 = perfectly neutral). */
  meanSaturation: number;
  /** Fraction of lit pixels with R − B ≥ 2 (a just-noticeable warm cast). */
  warmFraction: number;
  /** Largest R − B over lit pixels (0..255). */
  maxWarmth: number;
  /** 12-bin hue histogram (30° each) over lit pixels with saturation ≥ 0.05. */
  hueHistogram: number[];
}

export function imageColorStats(pixels: Uint8Array, width: number, height: number): ImageColorStats {
  const count = width * height;
  const hueHistogram = new Array<number>(12).fill(0);
  let lit = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumWarmth = 0;
  let sumSaturation = 0;
  let warm = 0;
  let maxWarmth = 0;
  for (let i = 0; i < count; i += 1) {
    const r = pixels[i * 4]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    if (Math.max(r, g, b) <= 2) continue;
    lit += 1;
    sumR += r;
    sumG += g;
    sumB += b;
    const warmth = r - b;
    sumWarmth += warmth;
    if (warmth > maxWarmth) maxWarmth = warmth;
    if (warmth >= 2) warm += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max > 0 ? (max - min) / max : 0;
    sumSaturation += saturation;
    if (saturation >= 0.05) {
      const delta = max - min;
      let hue: number;
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
      hueHistogram[Math.min(11, Math.floor(hue / 30))]! += 1;
    }
  }
  return {
    width,
    height,
    litPixels: lit,
    litFraction: count > 0 ? lit / count : 0,
    meanLitRGB: lit > 0 ? [sumR / lit, sumG / lit, sumB / lit] : [0, 0, 0],
    warmMinusCool: lit > 0 ? sumWarmth / lit : 0,
    meanSaturation: lit > 0 ? sumSaturation / lit : 0,
    warmFraction: lit > 0 ? warm / lit : 0,
    maxWarmth: maxWarmth,
    hueHistogram,
  };
}

/** Pixelwise difference between two RGBA8 frames of identical size. */
export interface ImageDifference {
  /** Fraction of pixels whose largest per-channel |difference| exceeds `threshold`. */
  changedFraction: number;
  /** Largest per-channel |difference| (0..255). */
  maxDelta: number;
  /** Mean per-channel |difference| over every pixel (0..255). */
  meanDelta: number;
  /** Mean per-channel |difference| over the pixels that changed (0..255). */
  meanDeltaOnChanged: number;
}

export function imageDifference(a: Uint8Array, b: Uint8Array, threshold = 0): ImageDifference {
  if (a.length !== b.length) throw new Error('imageDifference: size mismatch');
  const pixels = a.length / 4;
  let changed = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let sumDeltaChanged = 0;
  for (let i = 0; i < pixels; i += 1) {
    let pixelDelta = 0;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a[i * 4 + c]! - b[i * 4 + c]!);
      sumDelta += d;
      if (d > pixelDelta) pixelDelta = d;
    }
    if (pixelDelta > maxDelta) maxDelta = pixelDelta;
    if (pixelDelta > threshold) {
      changed += 1;
      sumDeltaChanged += pixelDelta;
    }
  }
  return {
    changedFraction: pixels > 0 ? changed / pixels : 0,
    maxDelta,
    meanDelta: pixels > 0 ? sumDelta / (pixels * 3) : 0,
    meanDeltaOnChanged: changed > 0 ? sumDeltaChanged / changed : 0,
  };
}
