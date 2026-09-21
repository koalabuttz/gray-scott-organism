/**
 * §8.1 six signal mappings (Phase 3, pure and unit-testable).
 *
 * Every mapping consumes only the **presentation tier** of the analysis snapshot
 * (`analysis.presentation`), never image pixels or GPU resources, and is a total, bounded function of
 * plain numbers. The graph in `audio.ts` smooths these targets over time; the mapping itself is
 * instantaneous so the offline and live paths share one definition and `tests/mapping.test.ts` can
 * assert boundedness and monotonicity on injected synthetic sequences directly.
 *
 * The six controls of §8.1:
 *   1. scale        → `mapFundamentalHz`         (feature scale + low band → deeper fundamental)
 *   2. fine detail  → `mapGrainRate` / filter     (high band + edge density → sparse grains)
 *   3. intensity    → `mapVoiceCount`/`mapVoiceLevel` (flux × occupancy → density + modest amplitude)
 *   4. coherence    → `mapDetuneCents`            (tighter ratios, less detuning)
 *   5. fragmentation→ `mapVoiceCount`/`mapTextureLevel` (progressive removal of upper voices/bandwidth)
 *   6. event serial → the engine's refractory excitation (one resonant event per serial)
 */
import { AUDIO } from '../config.ts';
import type { PresentationAnalysis } from '../core/types.ts';

/** §8.2 just-interval voice ratios, declared once (the config value is the source of truth). */
export const VOICE_RATIOS: readonly number[] = AUDIO.voiceRatios;

/**
 * §8.2 event excitation resonances (MINOR 5): exactly three band-passes at f, 2f, 3f — *not* the four
 * drone ratios. §8.2's graph line is "rare noise impulse → 3 resonant band-pass filters", so the event
 * subgraph is defined by this three-ratio list rather than by looping every drone voice.
 */
export const EVENT_RATIOS: readonly number[] = AUDIO.eventRatios;

/** Alternate detune direction per voice so non-just detuning beats rather than shifts the whole stack. */
export const DETUNE_SIGN: readonly number[] = [-1, 1, -1, 1];

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

/** Normalized "largeness" of the characteristic feature scale (0 = finest, 1 = coarsest), log-scale. */
export function featureScaleNorm(featureScaleUV: number): number {
  if (!Number.isFinite(featureScaleUV) || featureScaleUV <= 0) return 0;
  const lo = Math.log(FEATURE_SCALE_FINE_UV);
  const hi = Math.log(FEATURE_SCALE_COARSE_UV);
  return clamp01((Math.log(featureScaleUV) - lo) / (hi - lo));
}

/**
 * (1) Scale: large-scale structure and low-band energy pull the fundamental **down**. Logarithmic in
 * the 55–110 Hz band (deviation 57: raised from §8.2's literal 38–82 Hz for audibility on real
 * speakers) so equal ratio changes are equal perceptions. Bounded, monotone decreasing in both inputs.
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
 * removes upper voices progressively. Rounded and clamped to `[1, maxVoices]`, monotone increasing in
 * intensity and decreasing in fragmentation.
 */
export function mapVoiceCount(intensity: number, fragmentation: number): number {
  const density = 1 + (AUDIO.maxVoices - 1) * clamp01(intensity);
  const effective = density * (1 - clamp01(fragmentation));
  return clamp(Math.round(effective), 1, AUDIO.maxVoices);
}

/** (4) Coherence tightens detuning toward the just ratios; zero coherence leaves the ceiling. */
export function mapDetuneCents(coherence: number): number {
  return AUDIO.maxDetuneCents * (1 - clamp01(coherence));
}

/** (2) Fine detail: high band + edge density → grains per second in [0, 3]. */
export function mapFineDetail(highBandEnergy: number, edgeDensity: number): number {
  const band = clamp01(highBandEnergy);
  const edge = clamp01(edgeDensity / AUDIO.edgeDensityRef);
  return clamp01(0.6 * band + 0.4 * edge);
}

export function mapGrainRate(fineDetail: number): number {
  return AUDIO.maxGrainsPerSecond * clamp01(fineDetail);
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

/** (4) Wet send follows coherence and intensity within the §8.2 .12–.2 window. */
export function mapWetGain(coherence: number, intensity: number): number {
  return AUDIO.wetMin + (AUDIO.wetMax - AUDIO.wetMin) * clamp01(0.5 * coherence + 0.5 * intensity);
}

/** (3) Modest amplitude: zero intensity is silence, not a floor (hidden fields are inaudible). */
export function mapVoiceLevel(intensity: number): number {
  return AUDIO.voiceLevelMax * clamp01(intensity);
}

/** (5) Texture bandwidth reduces with fragmentation: collapse removes the fine upper layer. */
export function mapTextureLevel(fineDetail: number, fragmentation: number): number {
  return AUDIO.textureLevelMax * clamp01(fineDetail) * (1 - clamp01(fragmentation));
}

/** Fine detail moves the granular band-pass centre from 400 Hz (coarse) to 3200 Hz. */
export function mapTextureFilterHz(fineDetail: number): number {
  const t = clamp01(fineDetail);
  return AUDIO.grainFilterMinHz * Math.pow(AUDIO.grainFilterMaxHz / AUDIO.grainFilterMinHz, t);
}

/** A voice's low-pass sits above its own partial, opening slightly with intensity. Bounded. */
export function mapVoiceFilterHz(fundamentalHz: number, voiceIndex: number, intensity: number): number {
  const ratio = VOICE_RATIOS[Math.max(0, Math.min(VOICE_RATIOS.length - 1, voiceIndex))] ?? 1;
  const centre = fundamentalHz * ratio;
  return clamp(centre * (3 + 6 * clamp01(intensity)), 60, 8000);
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
  voiceLevel: number;
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
    voiceFilters: VOICE_RATIOS.map((ratio) => fundamentalHz * ratio * 3) as [number, number, number, number],
    detuneCents: 0,
    voiceCount: 1,
    voiceLevel: 0,
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
    voiceCount: mapVoiceCount(intensity, fragmentation),
    voiceLevel: mapVoiceLevel(intensity),
    grainRate: mapGrainRate(fineDetail),
    textureLevel: mapTextureLevel(fineDetail, fragmentation),
    textureFilterHz: mapTextureFilterHz(fineDetail),
    wetGain: mapWetGain(coherence, intensity),
  };
}
