/**
 * §8.1 six signal mappings (Phase 3, pure and unit-testable), palette per the Sunlit Porcelain Garden
 * sound-design record and its **TAKE-4 REVISION** (musicalization).
 *
 * Every mapping consumes only the **presentation tier** of the analysis snapshot
 * (`analysis.presentation`), never image pixels or GPU resources, and is a total, bounded function of
 * plain numbers. The graph in `audio.ts` smooths these targets over time; the mapping itself is
 * instantaneous so the offline and live paths share one definition and `tests/mapping.test.ts` can
 * assert boundedness and monotonicity on injected synthetic sequences directly.
 *
 * The six controls of §8.1:
 *   1. scale        → the **activity-band pad-degree selector** (TAKE-4): the pitch *scale* is a fixed
 *                     A-major-pentatonic key whose degree is chosen by reaction activity; feature scale
 *                     survives causally through bloom octave selection only.
 *   2. fine detail  → `mapGrainRate` / filter     (high band + edge density → sparse shimmer)
 *   3. intensity    → `mapVoiceCount`/`mapPadLevel` (flux × occupancy → density + warm body)
 *   4. coherence    → `chordColorGain` / bloom degree / wet (colour revealed, no detuning)
 *   5. fragmentation→ `mapVoiceCount`/`mapTextureLevel` (progressive removal of upper voices/bandwidth)
 *   6. event serial → the engine's refractory porcelain bloom (one excitation per serial)
 *
 * All of the stateful parts (fresh-sample identity, smoothed selectors, confirmed bands, the accepted
 * degree, the commit clock and the frequency mirrors) live in `AudioEngine`; everything here is pure.
 */
import { AUDIO } from '../config.ts';
import type { PresentationAnalysis } from '../core/types.ts';

/** §2 just-interval major-pentatonic ratios, declared once (the config value is the source of truth). */
export const SCALE_RATIOS: readonly number[] = AUDIO.scaleRatios;

/** §3 the absolute-scale-index voicing table (rows = pad degree, columns = voice in removal order). */
export const PAD_VOICINGS: readonly (readonly number[])[] = AUDIO.padVoicings;

/** §2 the pad's degree before any valid sample and after a reset: the tonic, A. */
export const NEUTRAL_DEGREE = 0;

/** Feature scale below which the field reads as fine texture, and above which as a large smooth mass. */
const FEATURE_SCALE_FINE_UV = 0.02;
const FEATURE_SCALE_COARSE_UV = 0.66;

export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Hermite smoothstep on `[lo, hi]`; flat at both ends, monotone, bounded to `[0, 1]`. */
export function smoothstep(lo: number, hi: number, value: number): number {
  const t = clamp01((value - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/** Normalized "largeness" of the characteristic feature scale (0 = finest, 1 = coarsest), log-scale. */
export function featureScaleNorm(featureScaleUV: number): number {
  if (!Number.isFinite(featureScaleUV) || featureScaleUV <= 0) return 0;
  const lo = Math.log(FEATURE_SCALE_FINE_UV);
  const hi = Math.log(FEATURE_SCALE_COARSE_UV);
  return clamp01((Math.log(featureScaleUV) - lo) / (hi - lo));
}

// ---------------------------------------------------------------------------------------------
// §2 (TAKE-4) the fixed A-major-pentatonic key
// ---------------------------------------------------------------------------------------------

/**
 * §2 absolute scale index → Hz: `tonic · 2^floor(k/5) · ratios[k mod 5]`. Ratios are the source of
 * truth, so every settled carrier is exactly in-key regardless of octave. Non-finite or fractional
 * indices are floored and clamped so a hostile input can never produce NaN.
 */
export function scaleHz(index: number): number {
  if (!Number.isFinite(index)) return AUDIO.tonicHz;
  const k = Math.max(0, Math.floor(index));
  const octave = Math.floor(k / SCALE_RATIOS.length);
  const ratio = SCALE_RATIOS[k % SCALE_RATIOS.length] ?? 1;
  return AUDIO.tonicHz * Math.pow(2, octave) * ratio;
}

/** §2 normalized reaction-activity selector input `x ∈ [0, 1]` (log-compressed, knee at `AUDIO.activityKnee`). */
export function activityX(reactionActivity: number): number {
  const a = clamp(reactionActivity, 0, AUDIO.activityCeiling);
  const span = Math.log(1 + AUDIO.activityCeiling / AUDIO.activityKnee);
  if (!(span > 0)) return 0;
  return clamp01(Math.log(1 + a / AUDIO.activityKnee) / span);
}

/**
 * The exact inverse of `activityX`: the raw reaction activity whose normalized selector value is `x`.
 * Used by the offline fixtures and the calibration documentation to place a fixture squarely inside a
 * target band rather than guessing a raw number.
 */
export function activityForX(x: number): number {
  const span = Math.log(1 + AUDIO.activityCeiling / AUDIO.activityKnee);
  return AUDIO.activityKnee * (Math.exp(clamp01(x) * span) - 1);
}

/** The band index `0..edges.length` of a selector value against ascending band edges. */
export function bandOf(value: number, edges: readonly number[]): number {
  if (!Number.isFinite(value)) return 0;
  let band = 0;
  for (const edge of edges) if (value >= edge) band += 1;
  return band;
}

/**
 * §2/§4 Schmitt band: the band only moves **up** when the value clears `edge + hysteresis` and only
 * **down** when it falls below `edge − hysteresis`, so a value sitting on a boundary cannot chatter.
 */
export function hystereticBand(
  value: number,
  current: number,
  edges: readonly number[],
  hysteresis: number,
): number {
  if (!Number.isFinite(value)) return current;
  let band = clamp(Math.round(current), 0, edges.length);
  while (band < edges.length && value >= edges[band]! + hysteresis) band += 1;
  while (band > 0 && value < edges[band - 1]! - hysteresis) band -= 1;
  return band;
}

/** §3 the four absolute scale indices for a pad degree (clamped to the table). */
export function padVoicing(degree: number): readonly number[] {
  const index = clamp(Math.round(degree), 0, PAD_VOICINGS.length - 1);
  return PAD_VOICINGS[index]!;
}

/** §3 the four carrier frequencies (Hz) for a pad degree — every one exactly in-key. */
export function voicingCarriers(degree: number): [number, number, number, number] {
  const voicing = padVoicing(degree);
  return [scaleHz(voicing[0]!), scaleHz(voicing[1]!), scaleHz(voicing[2]!), scaleHz(voicing[3]!)] as [
    number,
    number,
    number,
    number,
  ];
}

// ---------------------------------------------------------------------------------------------
// §8.1 continuous controls
// ---------------------------------------------------------------------------------------------

/** (3) Intensity: reaction flux × occupancy, each against a calibrated reference. Bounded 0–1. */
export function mapIntensity(occupiedFraction: number, reactionActivity: number): number {
  const occupancy = clamp01(occupiedFraction / AUDIO.intensityOccupancyRef);
  const activity = clamp01(reactionActivity / AUDIO.intensityActivityRef);
  return clamp01(0.55 * occupancy + 0.45 * activity);
}

/**
 * (3)/(5) Harmonic density: intensity raises a continuous 1–4 density, fragmentation (collapse) then
 * removes upper voices progressively (voice 3, then 2, then 1; the root survives). Rounded and clamped
 * to `[1, maxVoices]`, monotone increasing in intensity and decreasing in fragmentation.
 */
export function mapVoiceCount(intensity: number, fragmentation: number): number {
  const density = 1 + (AUDIO.maxVoices - 1) * clamp01(intensity);
  const effective = density * (1 - clamp01(fragmentation));
  return clamp(Math.round(effective), 1, AUDIO.maxVoices);
}

/** §3 coherence reveals the chord colour on voice 3 (which is not universally a major third). */
export function chordColorGain(coherence: number): number {
  return smoothstep(AUDIO.chordColorLow, AUDIO.chordColorHigh, clamp01(coherence));
}

/** (2) Fine detail: high band + edge density → a normalized detail amount in [0, 1]. */
export function mapFineDetail(highBandEnergy: number, edgeDensity: number): number {
  const band = clamp01(highBandEnergy);
  const edge = clamp01(edgeDensity / AUDIO.edgeDensityRef);
  return clamp01(0.6 * band + 0.4 * edge);
}

/** (2) Grain rate `1.4 · fineDetail² · (1 − fragmentation)`; zero detail or full collapse → zero. */
export function mapGrainRate(fineDetail: number, fragmentation: number): number {
  const detail = clamp01(fineDetail);
  return AUDIO.maxGrainsPerSecond * detail * detail * (1 - clamp01(fragmentation));
}

/**
 * (5) Fragmentation/collapse: many components with a small largest-component fraction reads as
 * fragmented. Bounded 0–1, monotone decreasing in the largest-component fraction.
 */
export function mapFragmentation(largestComponentFraction: number, beta0Approx: number): number {
  const spread = clamp01((beta0Approx - 1) / 6);
  const split = clamp01(1 - largestComponentFraction / 0.6);
  return clamp01(0.5 * spread + 0.5 * split);
}

/** (4) Wet send follows coherence and intensity within the §5 .07–.11 window. */
export function mapWetGain(coherence: number, intensity: number): number {
  return AUDIO.wetMin + (AUDIO.wetMax - AUDIO.wetMin) * clamp01(0.5 * coherence + 0.5 * intensity);
}

/**
 * §2 active pad level: `0.18 + 0.06·√intensity` for a field that carries **any** support, and exactly
 * zero for an absent field. The *stateful* decision belongs to the engine's latched presence
 * eligibility: the floor stays through the hysteresis band `[supportOff, supportOn)` and is removed
 * only when presence clears, so this function must not re-gate on the raw on-threshold (which would
 * chatter the pad to zero inside the band). Gating on `supportFraction > 0` keeps the floor from
 * leaking into an empty fixture.
 */
export function mapPadLevel(intensity: number, supportFraction: number): number {
  if (!(supportFraction > 0)) return 0;
  return AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain * Math.sqrt(clamp01(intensity));
}

/**
 * §2 per-voice target levels: base weights, the §3 chord colour applied to voice 3, then normalise the
 * **active** weights by `max(1, sqrt(sum(weight²)))` before scaling by the pad level. Density therefore
 * increases spectral richness without loudness jumps. Inactive voices are exactly zero (unchanged from
 * the pre-TAKE-4 design — the level plan is an untouched invariant, §6).
 */
export function voiceLevels(
  voiceCount: number,
  padLevel: number,
  coherence: number,
): [number, number, number, number] {
  const weights = AUDIO.voiceWeights.map((weight, index) =>
    index === 3 ? weight * chordColorGain(coherence) : weight,
  );
  const count = clamp(Math.round(voiceCount), 1, AUDIO.maxVoices);
  let sumSquares = 0;
  for (let i = 0; i < count; i += 1) sumSquares += weights[i]! * weights[i]!;
  const norm = Math.max(1, Math.sqrt(sumSquares));
  return weights.map((weight, index) => (index < count ? (padLevel * weight) / norm : 0)) as [
    number,
    number,
    number,
    number,
  ];
}

/** (5) Texture bandwidth reduces with fragmentation: collapse removes the fine upper layer. */
export function mapTextureLevel(fineDetail: number, fragmentation: number): number {
  return AUDIO.textureLevelMax * clamp01(fineDetail) * (1 - clamp01(fragmentation));
}

/** Fine detail moves the granular band-pass centre logarithmically 1100 Hz (coarse) → 2400 Hz (fine). */
export function mapTextureFilterHz(fineDetail: number): number {
  const t = clamp01(fineDetail);
  return AUDIO.grainFilterMinHz * Math.pow(AUDIO.grainFilterMaxHz / AUDIO.grainFilterMinHz, t);
}

/** §2 a voice's low-pass sits above its **selected carrier**: `clamp(carrier·(3 + 2·intensity), 500, 2400)`. */
export function mapVoiceFilterHz(carrierHz: number, intensity: number): number {
  return clamp(
    carrierHz * (AUDIO.voiceFilterBase + AUDIO.voiceFilterIntensityGain * clamp01(intensity)),
    AUDIO.voiceFilterMinHz,
    AUDIO.voiceFilterMaxHz,
  );
}

/**
 * §4 (TAKE-4) the bloom's base frequency: the scale note for the current bloom degree in the coarse
 * (`degree + 5` → 220–366.667 Hz) or fine (`degree + 10` → 440–733.333 Hz) register.
 */
export function bloomBaseHz(degree: number, register: 'coarse' | 'fine'): number {
  const offset =
    register === 'coarse' ? AUDIO.bloomOctaveOffsetCoarse : AUDIO.bloomOctaveOffsetFine;
  return scaleHz(clamp(Math.round(degree), 0, 4) + offset);
}

// ---------------------------------------------------------------------------------------------
// §7.1 control bundle
// ---------------------------------------------------------------------------------------------

/** The complete per-tick control bundle derived from one presentation sample. */
export interface AudioControls {
  /** False when the presentation tier is invalid/stale — the engine then holds its last targets. */
  valid: boolean;
  intensity: number;
  fineDetail: number;
  fragmentation: number;
  coherence: number;
  /**
   * §2 (TAKE-4) normalized reaction-activity selector input `x ∈ [0,1]`. The engine smooths it, derives
   * the hysteretic band and decides whether a pad-degree change is admitted; the *carriers* come from
   * the engine's accepted degree, not from this bundle.
   */
  activityX: number;
  voiceCount: number;
  /** §2 active pad level for a supported field (`0.18 + 0.06·√intensity`), exactly 0 when support is absent. */
  voiceLevel: number;
  /** §2 per-voice target levels (base weights, chord colour on voice 3, normalised). */
  voiceLevels: [number, number, number, number];
  /** The raw §6 support descriptor carried through for the presence state machine. */
  supportFraction: number;
  grainRate: number;
  textureLevel: number;
  textureFilterHz: number;
  wetGain: number;
}

/** A bounded, silent control bundle used before any valid sample and while the tier is stale. */
export function neutralAudioControls(): AudioControls {
  return {
    valid: false,
    intensity: 0,
    fineDetail: 0,
    fragmentation: 0,
    coherence: 0,
    activityX: 0,
    voiceCount: 1,
    voiceLevel: 0,
    voiceLevels: [0, 0, 0, 0],
    supportFraction: 0,
    grainRate: 0,
    textureLevel: 0,
    textureFilterHz: AUDIO.grainFilterMinHz,
    wetGain: AUDIO.wetMin,
  };
}

/** Derive the six §8.1 continuous controls from one presentation sample. Pure. */
export function deriveAudioControls(presentation: PresentationAnalysis): AudioControls {
  if (!presentation.valid) return neutralAudioControls();
  const bands = presentation.spectralBands;
  const highBand = bands[3] ?? 0;
  const intensity = mapIntensity(presentation.occupiedFraction, presentation.reactionActivity);
  const fragmentation = mapFragmentation(
    presentation.largestComponentFraction,
    presentation.beta0Approx,
  );
  const coherence = clamp01(presentation.coherence);
  const fineDetail = mapFineDetail(highBand, presentation.edgeDensity);
  const voiceCount = mapVoiceCount(intensity, fragmentation);
  const supportFraction = clamp01(presentation.supportFraction);
  const padLevel = mapPadLevel(intensity, supportFraction);
  return {
    valid: true,
    intensity,
    fineDetail,
    fragmentation,
    coherence,
    activityX: activityX(presentation.reactionActivity),
    voiceCount,
    voiceLevel: padLevel,
    voiceLevels: voiceLevels(voiceCount, padLevel, coherence),
    supportFraction,
    grainRate: mapGrainRate(fineDetail, fragmentation),
    textureLevel: mapTextureLevel(fineDetail, fragmentation),
    textureFilterHz: mapTextureFilterHz(fineDetail),
    wetGain: mapWetGain(coherence, intensity),
  };
}
