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
