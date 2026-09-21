/**
 * §8.1 six signal mappings (Phase 3, pure and unit-testable), palette per the Sunlit Porcelain Garden
 * sound-design record (§2 warm body, §4 soft shimmer, §5 small luminous space).
 *
 * Every mapping consumes only the **presentation tier** of the analysis snapshot
 * (`analysis.presentation`), never image pixels or GPU resources, and is a total, bounded function of
 * plain numbers. The graph in `audio.ts` smooths these targets over time; the mapping itself is
 * instantaneous so the offline and live paths share one definition and `tests/mapping.test.ts` can
 * assert boundedness and monotonicity on injected synthetic sequences directly.
 *
 * The six controls of §8.1:
 *   1. scale        → `mapFundamentalHz`         (feature scale + low band → deeper fundamental)
 *   2. fine detail  → `mapGrainRate` / filter     (high band + edge density → sparse shimmer)
 *   3. intensity    → `mapVoiceCount`/`mapPadLevel` (flux × occupancy → density + warm body)
 *   4. coherence    → `mapDetuneCents`/`thirdColorGain` (tighter ratios, hidden third revealed)
 *   5. fragmentation→ `mapVoiceCount`/`mapTextureLevel` (progressive removal of upper voices/bandwidth)
 *   6. event serial → the engine's refractory porcelain bloom (one excitation per serial)
 */
import { AUDIO } from '../config.ts';
import type { PresentationAnalysis } from '../core/types.ts';

/** §2 just-interval voice ratios, declared once (the config value is the source of truth). */
export const VOICE_RATIOS: readonly number[] = AUDIO.voiceRatios;

/**
 * §2 detune multipliers per voice: the root never detunes (`0`), the upper voices alternate direction
 * so non-just detuning beats rather than shifting the whole stack.
 */
export const DETUNE_MULTIPLIERS: readonly number[] = AUDIO.detuneMultipliers;

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

/**
 * (1) Scale: large-scale structure and low-band energy pull the fundamental **down**. Logarithmic in
 * the §2 110–165 Hz register (deviation 58 supersedes deviation 57's 55–110 Hz band) so equal ratio
 * changes are equal perceptions; large structures still sound lower. Bounded, monotone decreasing in
 * both inputs.
 */
export function mapFundamentalHz(featureScaleUV: number, lowBandEnergy: number): number {
  const size = clamp01(0.65 * featureScaleNorm(featureScaleUV) + 0.35 * clamp01(lowBandEnergy));
  const ratio = AUDIO.fundamentalMinHz / AUDIO.fundamentalMaxHz;
  return AUDIO.fundamentalMaxHz * Math.pow(ratio, size);
}

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

/** (4) Coherence tightens detuning toward the just ratios; zero coherence leaves the 3-cent ceiling. */
export function mapDetuneCents(coherence: number): number {
  return AUDIO.maxDetuneCents * (1 - clamp01(coherence));
}

/** §2 the just major third (voice 3) becomes audible only as coherence rises (smoothstep 0.25→0.75). */
export function thirdColorGain(coherence: number): number {
  return smoothstep(AUDIO.thirdCoherenceLow, AUDIO.thirdCoherenceHigh, clamp01(coherence));
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
 * eligibility (MAJOR 2): the floor stays through the hysteresis band `[supportOff, supportOn)` and is
 * removed only when presence clears, so this function must not re-gate on the raw on-threshold (which
 * would chatter the pad to zero inside the band). Gating on `supportFraction > 0` keeps the floor from
 * leaking into an empty fixture.
 */
export function mapPadLevel(intensity: number, supportFraction: number): number {
  if (!(supportFraction > 0)) return 0;
  return AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain * Math.sqrt(clamp01(intensity));
}

/**
 * §2 per-voice target levels: base weights, the §2 coherence colour applied to voice 3, then normalise
 * the **active** weights by `max(1, sqrt(sum(weight²)))` before scaling by the pad level. Density
 * therefore increases spectral richness without loudness jumps. Inactive voices are exactly zero.
 */
export function voiceLevels(
  voiceCount: number,
  padLevel: number,
  coherence: number,
): [number, number, number, number] {
  const weights = AUDIO.voiceWeights.map((weight, index) =>
    index === 3 ? weight * thirdColorGain(coherence) : weight,
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

/** §2 a voice's low-pass sits above its own partial: `clamp(carrier·(3 + 2·intensity), 500, 2400)`. */
export function mapVoiceFilterHz(fundamentalHz: number, voiceIndex: number, intensity: number): number {
  const ratio = VOICE_RATIOS[Math.max(0, Math.min(VOICE_RATIOS.length - 1, voiceIndex))] ?? 1;
  const centre = fundamentalHz * ratio;
  return clamp(
    centre * (AUDIO.voiceFilterBase + AUDIO.voiceFilterIntensityGain * clamp01(intensity)),
    AUDIO.voiceFilterMinHz,
    AUDIO.voiceFilterMaxHz,
  );
}

/** The complete per-tick control bundle derived from one presentation sample. */
export interface AudioControls {
  /** False when the presentation tier is invalid/stale — the engine then holds its last targets. */
  valid: boolean;
  intensity: number;
  fineDetail: number;
  fragmentation: number;
  coherence: number;
  fundamentalHz: number;
  voiceFrequencies: [number, number, number, number];
  voiceFilters: [number, number, number, number];
  detuneCents: number;
  voiceCount: number;
  /** §2 active pad level for a supported field (`0.18 + 0.06·√intensity`), exactly 0 when support is absent. */
  voiceLevel: number;
  /** §2 per-voice target levels (base weights, coherence colour on voice 3, normalised). */
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
  const fundamentalHz = (AUDIO.fundamentalMinHz + AUDIO.fundamentalMaxHz) / 2;
  return {
    valid: false,
    intensity: 0,
    fineDetail: 0,
    fragmentation: 0,
    coherence: 0,
    fundamentalHz,
    voiceFrequencies: VOICE_RATIOS.map((ratio) => fundamentalHz * ratio) as [number, number, number, number],
    voiceFilters: VOICE_RATIOS.map((_, index) =>
      mapVoiceFilterHz(fundamentalHz, index, 0),
    ) as [number, number, number, number],
    detuneCents: 0,
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

/** Derive the six §8.1 controls from one presentation sample. Pure. */
export function deriveAudioControls(presentation: PresentationAnalysis): AudioControls {
  if (!presentation.valid) return neutralAudioControls();
  const bands = presentation.spectralBands;
  const lowBand = bands[0] ?? 0;
  const highBand = bands[3] ?? 0;
  const intensity = mapIntensity(presentation.occupiedFraction, presentation.reactionActivity);
  const fragmentation = mapFragmentation(
    presentation.largestComponentFraction,
    presentation.beta0Approx,
  );
  const coherence = clamp01(presentation.coherence);
  const fineDetail = mapFineDetail(highBand, presentation.edgeDensity);
  const fundamentalHz = mapFundamentalHz(presentation.featureScaleUV, lowBand);
  const voiceCount = mapVoiceCount(intensity, fragmentation);
  const supportFraction = clamp01(presentation.supportFraction);
  const padLevel = mapPadLevel(intensity, supportFraction);
  return {
    valid: true,
    intensity,
    fineDetail,
    fragmentation,
    coherence,
    fundamentalHz,
    voiceFrequencies: VOICE_RATIOS.map((ratio) => fundamentalHz * ratio) as [number, number, number, number],
    voiceFilters: VOICE_RATIOS.map((_, index) =>
      mapVoiceFilterHz(fundamentalHz, index, intensity),
    ) as [number, number, number, number],
    detuneCents: mapDetuneCents(coherence),
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
