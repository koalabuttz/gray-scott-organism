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

/** Decode an IEEE-754 binary16 (as stored by an RGBA16F attachment) to a JS number. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * Read a colour target as RGBA floats for verification. The read format is taken from the driver's
 * own `IMPLEMENTATION_COLOR_READ_TYPE` for the bound attachment, so a float attachment served as
 * `HALF_FLOAT` (the common case for RGBA16F) is decoded rather than silently returning zeros from a
 * rejected `FLOAT` read.
 */
export function readColorTargetRGBA(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  width: number,
  height: number,
  out?: Float32Array,
): Float32Array {
  const count = width * height * 4;
  const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
  const result = out ?? new Float32Array(count);
  if (readType === gl.FLOAT) {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, result);
  } else {
    const half = new Uint16Array(count);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, half);
    for (let i = 0; i < count; i += 1) result[i] = halfToFloat(half[i]!);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
  return result;
}

/**
 * §12.4 round-2 luminance statistics over the **lit** pixels only.
 *
 * `imageStats`' percentiles are over the whole frame, which is dominated by the black background, so
 * they cannot see how stratified the *organism* is. This reports the lit-pixel distribution directly;
 * `spread` is the thickness-variation proxy the round-2 sweep is judged on: `p90 / p50` within lit
 * pixels — how far the bright rims/catch-light stand above the typical lit pixel.
 */
export interface LitLuminanceStats {
  width: number;
  height: number;
  litPixels: number;
  litFraction: number;
  mean: number;
  stdev: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  max: number;
  /** `p90 / max(p50, 1)` over lit pixels. */
  spread: number;
}

export function imageLitStats(pixels: Uint8Array, width: number, height: number): LitLuminanceStats {
  const count = width * height;
  const histogram = new Uint32Array(256);
  let lit = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < count; i += 1) {
    const luma = Math.max(pixels[i * 4]!, pixels[i * 4 + 1]!, pixels[i * 4 + 2]!);
    if (luma <= 2) continue;
    lit += 1;
    sum += luma;
    sumSq += luma * luma;
    histogram[luma]! += 1;
  }
  const at = (p: number): number => {
    if (lit === 0) return 0;
    const target = (p / 100) * lit;
    let running = 0;
    for (let value = 0; value < 256; value += 1) {
      running += histogram[value]!;
      if (running >= target) return value;
    }
    return 255;
  };
  const mean = lit > 0 ? sum / lit : 0;
  const variance = lit > 0 ? Math.max(0, sumSq / lit - mean * mean) : 0;
  const p50 = at(50);
  const p90 = at(90);
  return {
    width,
    height,
    litPixels: lit,
    litFraction: count > 0 ? lit / count : 0,
    mean,
    stdev: Math.sqrt(variance),
    p10: at(10),
    p25: at(25),
    p50,
    p75: at(75),
    p90,
    p99: at(99),
    max: lit > 0 ? at(100) : 0,
    spread: p90 / Math.max(p50, 1),
  };
}

/**
 * §12.4 round-2 statistics over the derived **height field** (surface target R), restricted to the
 * organism (support above `supportThreshold`). This is the direct view of lever #1: does a thick core
 * actually stand above a thin filament, and by how much. `spread` = `p90 / max(min, eps)` — how far
 * the deepest relief sits above the shallowest part of the body.
 */
export interface HeightFieldStats {
  /** Organism cells counted (support above the threshold). */
  cells: number;
  min: number;
  max: number;
  mean: number;
  stdev: number;
  p50: number;
  p90: number;
  p99: number;
  /** `max / max(p50, eps)`. */
  spread: number;
  /** `p90 / max(p50, eps)`. */
  p90OverP50: number;
  /** `(max - min) / reliefAmplitude` — the fraction of the relief budget actually used. */
  reliefFraction: number;
}

export function heightFieldStats(
  data: Float32Array,
  width: number,
  height: number,
  supportThreshold = 0.5,
  reliefAmplitude = 0.006,
): HeightFieldStats {
  const count = width * height;
  const values: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    if (data[i * 4 + 2]! < supportThreshold) continue;
    const h = data[i * 4]!;
    values.push(h);
    sum += h;
  }
  if (values.length === 0) {
    return { cells: 0, min: 0, max: 0, mean: 0, stdev: 0, p50: 0, p90: 0, p99: 0, spread: 0, p90OverP50: 0, reliefFraction: 0 };
  }
  values.sort((a, b) => a - b);
  const at = (p: number): number => values[Math.min(values.length - 1, Math.max(0, Math.round((p / 100) * (values.length - 1))))]!;
  const mean = sum / values.length;
  let sumSq = 0;
  for (const v of values) sumSq += (v - mean) * (v - mean);
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const p50 = at(50);
  const p90 = at(90);
  return {
    cells: values.length,
    min,
    max,
    mean,
    stdev: Math.sqrt(sumSq / values.length),
    p50,
    p90,
    p99: at(99),
    spread: max / Math.max(p50, 1e-9),
    p90OverP50: p90 / Math.max(p50, 1e-9),
    reliefFraction: reliefAmplitude > 0 ? (max - min) / reliefAmplitude : 0,
  };
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
