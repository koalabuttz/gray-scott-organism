/**
 * §7.4 spatial spectrum (Phase 3, tier-2).
 *
 * The reduced presentation V field (256²) is area-averaged to **128²**, its mean is subtracted, a
 * separable Hann window is applied, and a small **dependency-free radix-2 2D FFT** runs over reusable
 * arrays (no per-sample allocation). Radial power is integrated into four fixed bands measured in
 * cycles/domain — 1–4 / 4–12 / 12–28 / 28–64 — with DC excluded from the bands; powers are normalised
 * by the total **non-DC** energy, with an explicit near-zero branch that returns zero bands (a quiet
 * field is never reported as a meaningful infinity). The characteristic frequency is a power-weighted
 * geometric mean whose reciprocal is `featureScaleUV` when valid.
 *
 * The transform is a plain complex FFT: it measures resolved reduced detail only, and nothing above
 * the reduced-grid Nyquist limit is claimed.
 */

/** Four normalized band energies plus the characteristic feature scale. */
export interface SpectrumResult {
  bands: [number, number, number, number];
  /** `1 / characteristicFrequency` when the field has measurable non-DC energy; otherwise 0. */
  featureScaleUV: number;
  /** Total non-DC power (unnormalised). Near-zero means the field was flat. */
  totalEnergy: number;
}

/** The band edges in cycles/domain (matches `PRESENTATION.spectralBands`). */
const BANDS: readonly (readonly [number, number])[] = [
  [1, 4],
  [4, 12],
  [12, 28],
  [28, 64],
];

/** Total non-DC energy below which the field is treated as flat (bands = 0). */
const NEAR_ZERO_ENERGY = 1e-9;

/**
 * A reusable spectral analyzer. `analyze` accepts a square source of any size and area-averages it to
 * the fixed transform size, so it works on the 256² reduced field or on a synthetic 128² fixture.
 */
export class SpectrumAnalyzer {
  readonly size: number;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly block: Float32Array;
  private readonly hann: Float32Array;
  private readonly rowRe: Float32Array;
  private readonly rowIm: Float32Array;
  private readonly colRe: Float32Array;
  private readonly colIm: Float32Array;

  constructor(size = 128) {
    if ((size & (size - 1)) !== 0) throw new Error(`spectrum size must be a power of two, got ${size}`);
    this.size = size;
    this.re = new Float32Array(size * size);
    this.im = new Float32Array(size * size);
    this.block = new Float32Array(size * size);
    this.hann = hannWindow(size);
    this.rowRe = new Float32Array(size);
    this.rowIm = new Float32Array(size);
    this.colRe = new Float32Array(size);
    this.colIm = new Float32Array(size);
  }

  analyze(source: Float32Array, sourceSize: number): SpectrumResult {
    const n = this.size;
    this.downsample(source, sourceSize);

    // Mean subtract + separable Hann window, written into re/im (im = 0).
    const block = this.block;
    let mean = 0;
    for (let i = 0; i < block.length; i += 1) mean += block[i]!;
    mean /= block.length;
    const hann = this.hann;
    const re = this.re;
    const im = this.im;
    for (let y = 0; y < n; y += 1) {
      const wy = hann[y]!;
      for (let x = 0; x < n; x += 1) {
        const index = y * n + x;
        re[index] = (block[index]! - mean) * hann[x]! * wy;
        im[index] = 0;
      }
    }

    // Separable 2D FFT: transform each row, then each column (preallocated scratch).
    const rowRe = this.rowRe;
    const rowIm = this.rowIm;
    for (let y = 0; y < n; y += 1) {
      const base = y * n;
      for (let x = 0; x < n; x += 1) {
        rowRe[x] = re[base + x]!;
        rowIm[x] = im[base + x]!;
      }
      fftRadix2(rowRe, rowIm);
      for (let x = 0; x < n; x += 1) {
        re[base + x] = rowRe[x]!;
        im[base + x] = rowIm[x]!;
      }
    }
    const colRe = this.colRe;
    const colIm = this.colIm;
    for (let x = 0; x < n; x += 1) {
      for (let y = 0; y < n; y += 1) {
        colRe[y] = re[y * n + x]!;
        colIm[y] = im[y * n + x]!;
      }
      fftRadix2(colRe, colIm);
      for (let y = 0; y < n; y += 1) {
        re[y * n + x] = colRe[y]!;
        im[y * n + x] = colIm[y]!;
      }
    }

    const bands: [number, number, number, number] = [0, 0, 0, 0];
    let totalEnergy = 0;
    let weightedLogFreq = 0;
    let measuredEnergy = 0;
    const half = n / 2;
    for (let ky = 0; ky < n; ky += 1) {
      const sy = ky <= half ? ky : ky - n;
      for (let kx = 0; kx < n; kx += 1) {
        if (kx === 0 && ky === 0) continue; // DC excluded
        const sx = kx <= half ? kx : kx - n;
        const radial = Math.sqrt(sx * sx + sy * sy);
        const index = ky * n + kx;
        const power = re[index]! * re[index]! + im[index]! * im[index]!;
        totalEnergy += power;
        for (let b = 0; b < BANDS.length; b += 1) {
          const [lo, hi] = BANDS[b]!;
          if (radial >= lo && radial < hi) {
            bands[b] += power;
            break;
          }
        }
        if (radial > 0 && radial <= 64) {
          weightedLogFreq += power * Math.log(radial);
          measuredEnergy += power;
        }
      }
    }

    if (totalEnergy < NEAR_ZERO_ENERGY) {
      return { bands: [0, 0, 0, 0], featureScaleUV: 0, totalEnergy };
    }
    for (let b = 0; b < 4; b += 1) bands[b] /= totalEnergy;
    let featureScaleUV = 0;
    if (measuredEnergy > 0) {
      const characteristic = Math.exp(weightedLogFreq / measuredEnergy);
      if (characteristic > 0 && Number.isFinite(characteristic)) featureScaleUV = 1 / characteristic;
    }
    return { bands, featureScaleUV, totalEnergy };
  }

  /** Area-average `source` (sourceSize²) down to the transform size. */
  private downsample(source: Float32Array, sourceSize: number): void {
    const n = this.size;
    const block = this.block;
    const step = sourceSize / n;
    for (let y = 0; y < n; y += 1) {
      const y0 = Math.floor(y * step);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * step));
      for (let x = 0; x < n; x += 1) {
        const x0 = Math.floor(x * step);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * step));
        let sum = 0;
        let count = 0;
        for (let sy = y0; sy < y1 && sy < sourceSize; sy += 1) {
          for (let sx = x0; sx < x1 && sx < sourceSize; sx += 1) {
            sum += source[sy * sourceSize + sx]!;
            count += 1;
          }
        }
        block[y * n + x] = count > 0 ? sum / count : 0;
      }
    }
  }
}

function hannWindow(n: number): Float32Array {
  const window = new Float32Array(n);
  for (let i = 0; i < n; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return window;
}

/**
 * In-place radix-2 complex FFT. `re`/`im` must be a power-of-two length; `im` is zero for a real
 * input. The twiddle recurrence is exact enough for descriptor-level band energies.
 */
export function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const halfLen = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < halfLen; k += 1) {
        const evenIndex = i + k;
        const oddIndex = i + k + halfLen;
        const oddRe = re[oddIndex]! * cwr - im[oddIndex]! * cwi;
        const oddIm = re[oddIndex]! * cwi + im[oddIndex]! * cwr;
        re[oddIndex] = re[evenIndex]! - oddRe;
        im[oddIndex] = im[evenIndex]! - oddIm;
        re[evenIndex] += oddRe;
        im[evenIndex] += oddIm;
        const nextWr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nextWr;
      }
    }
  }
}
