/**
 * §12.3 audio mappings (AC.12 half): the six §8.1 controls are bounded and monotone where specified,
 * with the §2/§4/§5 Sunlit Porcelain Garden palette (deviation 58).
 *
 * These are pure functions of plain numbers, so they are tested directly (no graph, no DOM, no
 * context) and again through `deriveAudioControls` on injected synthetic presentation samples that
 * walk a plausible arc, which is where a mapping that is individually fine but jointly unbounded
 * would show up.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO } from '../src/config.ts';
import type { PresentationAnalysis } from '../src/core/types.ts';
import {
  DETUNE_MULTIPLIERS,
  VOICE_RATIOS,
  deriveAudioControls,
  mapDetuneCents,
  mapFineDetail,
  mapFragmentation,
  mapFundamentalHz,
  mapGrainRate,
  mapIntensity,
  mapPadLevel,
  mapTextureFilterHz,
  mapTextureLevel,
  mapVoiceCount,
  mapVoiceFilterHz,
  mapWetGain,
  neutralAudioControls,
  thirdColorGain,
  voiceLevels,
} from '../src/audio/voices.ts';
import { neutralAnalysisState } from '../src/core/world.ts';

/** A presentation sample builder: only the descriptors the audio mappings read are meaningful. */
function presentation(overrides: Partial<PresentationAnalysis>): PresentationAnalysis {
  return { ...neutralAnalysisState().presentation, valid: true, ...overrides };
}

describe('§2 voice ratios and register', () => {
  it('are the just intervals [1, 2, 3, 5/2] in removal-priority order', () => {
    expect(VOICE_RATIOS).toEqual([1, 2, 3, 2.5]);
    expect(AUDIO.maxVoices).toBe(4);
    expect(DETUNE_MULTIPLIERS).toEqual([0, 1, -1, 0.5]);
    expect(DETUNE_MULTIPLIERS[0], 'the root never detunes').toBe(0);
  });

  it('carries the §2 harmonic tables (a warm body, restrained even harmonics)', () => {
    expect(AUDIO.voice0Harmonics).toEqual([1, 0.28, 0.1]);
    expect(AUDIO.voiceHarmonics).toEqual([1, 0.1]);
  });

  it('pins the 110–165 Hz register and the ≤ 3-cent detune ceiling', () => {
    expect(AUDIO.fundamentalMinHz).toBe(110);
    expect(AUDIO.fundamentalMaxHz).toBe(165);
    // Highest carrier is 3 × fundamentalMax = 495 Hz.
    expect(AUDIO.fundamentalMaxHz * 3).toBe(495);
    expect(AUDIO.maxDetuneCents).toBe(3);
  });

  it('pins the §4 texture recipe and the §8.2 scheduler tick', () => {
    expect(AUDIO.tickMs).toBe(50);
    expect(AUDIO.lookaheadMs).toBe(150);
    expect(AUDIO.tickMs).toBeLessThan(AUDIO.lookaheadMs);
    expect(AUDIO.maxGrainsPerSecond).toBeCloseTo(1.4, 6);
    expect(AUDIO.maxConcurrentGrains).toBe(4);
    expect(AUDIO.grainMinSeconds).toBeCloseTo(0.65, 6);
    expect(AUDIO.grainMaxSeconds).toBeCloseTo(1.2, 6);
    expect(AUDIO.grainPeak).toBeCloseTo(0.85, 6);
    expect(AUDIO.eventRefractorySeconds).toBeGreaterThanOrEqual(15);
    // §5 wet window and the silence policy are retained.
    expect(AUDIO.wetMin).toBeCloseTo(0.07, 6);
    expect(AUDIO.wetMax).toBeCloseTo(0.11, 6);
    expect(AUDIO.fadeSeconds).toBeGreaterThanOrEqual(8);
    expect(AUDIO.fadeSeconds).toBeLessThanOrEqual(15);
    expect(AUDIO.offSeconds).toBe(8);
    // §6 presence thresholds and the unified reveal.
    expect(AUDIO.supportOnFraction).toBeCloseTo(0.001, 6);
    expect(AUDIO.supportOffFraction).toBeCloseTo(0.00025, 6);
    expect(AUDIO.supportConfirmSamples).toBe(2);
    expect(AUDIO.supportConfirmSeconds).toBeCloseTo(0.5, 6);
    expect(AUDIO.revealSeconds).toBeCloseTo(1.5, 6);
    expect(AUDIO.activationFadeSeconds).toBeCloseTo(AUDIO.revealSeconds, 6);
  });
});

describe('§8.1 (1) scale — fundamental', () => {
  it('stays inside the 110–165 Hz logarithmic band for any input', () => {
    const samples = [
      [0, 0],
      [1, 1],
      [0.02, 0],
      [0.66, 1],
      [-5, 99],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
    ];
    for (const [scale, low] of samples) {
      const hz = mapFundamentalHz(scale!, low!);
      expect(Number.isFinite(hz)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(AUDIO.fundamentalMinHz - 1e-9);
      expect(hz).toBeLessThanOrEqual(AUDIO.fundamentalMaxHz + 1e-9);
    }
  });

  it('is monotone decreasing in feature scale and in low-band energy', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const scale of [0, 0.05, 0.1, 0.2, 0.4, 0.66, 1]) {
      const hz = mapFundamentalHz(scale, 0);
      expect(hz).toBeLessThanOrEqual(previous);
      previous = hz;
    }
    let previousLow = Number.POSITIVE_INFINITY;
    for (const low of [0, 0.2, 0.5, 0.8, 1]) {
      const hz = mapFundamentalHz(0.2, low);
      expect(hz).toBeLessThanOrEqual(previousLow);
      previousLow = hz;
    }
  });

  it('reaches the low end for a large smooth mass and the high end for fine texture', () => {
    expect(mapFundamentalHz(0.66, 1)).toBeLessThan(mapFundamentalHz(0.02, 0));
    expect(mapFundamentalHz(0.66, 1)).toBeCloseTo(AUDIO.fundamentalMinHz, 3);
    expect(mapFundamentalHz(0.0, 0)).toBeCloseTo(AUDIO.fundamentalMaxHz, 3);
  });
});

describe('§8.1 (3) intensity and harmonic density', () => {
  it('intensity is bounded to [0,1] and monotone increasing in both inputs', () => {
    let previous = -1;
    for (const occupancy of [0, 0.05, 0.1, 0.3, 1]) {
      const value = mapIntensity(occupancy, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(mapIntensity(5, 5)).toBe(1);
    expect(mapIntensity(-1, -1)).toBe(0);
    expect(Number.isFinite(mapIntensity(Number.NaN, 0.1))).toBe(true);
  });

  it('voice count is an integer in [1, 4], rising with intensity and falling with fragmentation', () => {
    let previous = 0;
    for (const intensity of [0, 0.1, 0.3, 0.5, 0.75, 1]) {
      const count = mapVoiceCount(intensity, 0);
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(4);
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(mapVoiceCount(1, 1)).toBe(1); // collapse removes the upper voices
    expect(mapVoiceCount(1, 0)).toBe(4);
    expect(mapVoiceCount(0, 0)).toBe(1);
  });
});

describe('§2 pad level and per-voice levels', () => {
  it('is the 0.18 + 0.06·√intensity living-field floor for a supported field', () => {
    expect(mapPadLevel(0, 1)).toBeCloseTo(AUDIO.padLevelFloor, 9);
    expect(mapPadLevel(1, 1)).toBeCloseTo(AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain, 9);
    for (const intensity of [0, 0.25, 0.5, 1]) {
      const level = mapPadLevel(intensity, 1);
      expect(level).toBeGreaterThanOrEqual(AUDIO.padLevelFloor - 1e-12);
      expect(level).toBeLessThanOrEqual(AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain + 1e-12);
    }
  });

  it('is exactly zero when support is absent (the floor cannot leak into an empty fixture)', () => {
    expect(mapPadLevel(0, 0)).toBe(0);
    expect(mapPadLevel(1, 0)).toBe(0);
    // MAJOR 2: the floor is *not* re-gated on the raw on-threshold — presence is the stateful latch, so
    // any support at all keeps the floor computable (it is held through the hysteresis band).
    expect(mapPadLevel(1, AUDIO.supportOffFraction)).toBeGreaterThan(0);
    expect(mapPadLevel(1, AUDIO.supportOnFraction)).toBeGreaterThan(0);
    expect(mapPadLevel(1, AUDIO.supportOnFraction * 0.5)).toBeGreaterThan(0);
    // Adversarial inputs stay finite and bounded.
    expect(mapPadLevel(Number.NaN, 1)).toBeGreaterThanOrEqual(0);
    expect(mapPadLevel(Number.NaN, 1)).toBeLessThanOrEqual(AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain);
    expect(mapPadLevel(Number.POSITIVE_INFINITY, 1)).toBeLessThanOrEqual(
      AUDIO.padLevelFloor + AUDIO.padLevelIntensityGain + 1e-12,
    );
    expect(mapPadLevel(Number.NaN, Number.NaN)).toBe(0);
  });

  it('normalizes the active weights by max(1, sqrt(sum(weight²))) and removes upper voices', () => {
    const pad = 0.24;
    const one = voiceLevels(1, pad, 0.5);
    expect(one[0], 'a lone root is its own weight').toBeCloseTo(pad, 9);
    expect(one[1]).toBe(0);
    expect(one[2]).toBe(0);
    expect(one[3]).toBe(0);
    const four = voiceLevels(4, pad, 1);
    const norm = Math.sqrt(AUDIO.voiceWeights.reduce((sum, weight) => sum + weight * weight, 0));
    expect(four[0]).toBeCloseTo((pad * AUDIO.voiceWeights[0]!) / Math.max(1, norm), 9);
    // Voice 3 carries the coherence colour: silent at coherence 0, present as it coheres.
    expect(voiceLevels(4, pad, 0)[3]).toBeCloseTo((pad * AUDIO.voiceWeights[3]! * thirdColorGain(0)) / norm, 9);
    expect(thirdColorGain(0)).toBe(0);
    expect(thirdColorGain(1)).toBe(1);
    expect(thirdColorGain(0.5)).toBeGreaterThan(0);
    expect(thirdColorGain(0.5)).toBeLessThan(1);
  });
});

describe('§8.1 (4) coherence', () => {
  it('detuning falls from the 3-cent ceiling to zero as coherence rises', () => {
    expect(mapDetuneCents(0)).toBeCloseTo(AUDIO.maxDetuneCents, 9);
    expect(AUDIO.maxDetuneCents).toBeLessThanOrEqual(3);
    expect(mapDetuneCents(1)).toBe(0);
    let previous = Number.POSITIVE_INFINITY;
    for (const coherence of [0, 0.25, 0.5, 0.75, 1]) {
      const cents = mapDetuneCents(coherence);
      expect(cents).toBeLessThanOrEqual(previous);
      expect(cents).toBeGreaterThanOrEqual(0);
      previous = cents;
    }
  });

  it('the third-coherence color is monotone and bounded', () => {
    let previous = -1;
    for (const coherence of [0, 0.25, 0.5, 0.75, 1]) {
      const gain = thirdColorGain(coherence);
      expect(gain).toBeGreaterThanOrEqual(previous);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
      previous = gain;
    }
  });

  it('wet gain stays inside the §5 .07–.11 window', () => {
    for (const [coherence, intensity] of [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const wet = mapWetGain(coherence!, intensity!);
      expect(wet).toBeGreaterThanOrEqual(AUDIO.wetMin - 1e-12);
      expect(wet).toBeLessThanOrEqual(AUDIO.wetMax + 1e-12);
    }
    expect(mapWetGain(0, 0)).toBeCloseTo(AUDIO.wetMin, 9);
    expect(mapWetGain(1, 1)).toBeCloseTo(AUDIO.wetMax, 9);
  });
});

describe('§8.1 (2) fine detail — granular texture', () => {
  it('grain rate is 1.4·detail²·(1−fragmentation), in [0, 1.4], rising with detail', () => {
    let previous = -1;
    for (const detail of [0, 0.1, 0.3, 0.6, 1]) {
      const rate = mapGrainRate(detail, 0);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(AUDIO.maxGrainsPerSecond + 1e-12);
      expect(rate).toBeGreaterThanOrEqual(previous);
      previous = rate;
    }
    expect(mapGrainRate(0, 0), 'zero detail → exactly zero').toBe(0);
    expect(mapGrainRate(1, 1), 'complete fragmentation → exactly zero').toBe(0);
    expect(mapGrainRate(1, 0)).toBeCloseTo(AUDIO.maxGrainsPerSecond, 9);
    expect(Number.isFinite(mapGrainRate(Number.NaN, Number.NaN))).toBe(true);
  });

  it('fine detail combines high band and edge density, bounded to [0,1]', () => {
    expect(mapFineDetail(1, 1)).toBe(1);
    expect(mapFineDetail(0, 0)).toBe(0);
    expect(mapFineDetail(0.5, 0.05)).toBeGreaterThan(mapFineDetail(0.2, 0.05));
    expect(mapFineDetail(Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('the granular band-pass centre stays within [1100, 2400] Hz and rises with detail', () => {
    expect(AUDIO.grainFilterMinHz).toBe(1100);
    expect(AUDIO.grainFilterMaxHz).toBe(2400);
    expect(mapTextureFilterHz(0)).toBeCloseTo(AUDIO.grainFilterMinHz, 6);
    expect(mapTextureFilterHz(1)).toBeCloseTo(AUDIO.grainFilterMaxHz, 6);
    expect(mapTextureFilterHz(0.8)).toBeGreaterThan(mapTextureFilterHz(0.2));
  });

  it('the per-voice low-pass is clamp(carrier·(3 + 2·intensity), 500, 2400)', () => {
    expect(mapVoiceFilterHz(110, 0, 0)).toBeCloseTo(500, 6); // 110·3 = 330 → clamped up to 500
    expect(mapVoiceFilterHz(110, 0, 1)).toBeCloseTo(550, 6); // 110·5 = 550
    expect(mapVoiceFilterHz(165, 2, 1)).toBeCloseTo(2400, 6); // 495·5 → clamped to 2400
    expect(mapVoiceFilterHz(110, 0, 0.5)).toBeGreaterThanOrEqual(500);
  });
});

describe('§8.1 (5) fragmentation / collapse', () => {
  it('fragmentation is bounded and falls as the largest component grows', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const largest of [0, 0.15, 0.3, 0.45, 0.6, 1]) {
      const fragmentation = mapFragmentation(largest, 3);
      expect(fragmentation).toBeGreaterThanOrEqual(0);
      expect(fragmentation).toBeLessThanOrEqual(1);
      expect(fragmentation).toBeLessThanOrEqual(previous);
      previous = fragmentation;
    }
    expect(mapFragmentation(0.9, 1)).toBe(0);
    expect(mapFragmentation(0, 8)).toBe(1);
    expect(Number.isFinite(mapFragmentation(Number.NaN, Number.NaN))).toBe(true);
  });

  it('texture bandwidth is removed by fragmentation and bounded to the .07 bus gain', () => {
    expect(mapTextureLevel(1, 1)).toBeCloseTo(0, 12);
    expect(mapTextureLevel(1, 0)).toBeCloseTo(AUDIO.textureLevelMax, 9);
    expect(AUDIO.textureLevelMax).toBeCloseTo(0.07, 6);
    expect(mapTextureLevel(0, 0)).toBe(0);
  });
});

describe('deriveAudioControls — the joint bundle', () => {
  it('is bounded across a synthetic arc from dead to saturated to fragmented', () => {
    const arc: Partial<PresentationAnalysis>[] = [
      { occupiedFraction: 0, reactionActivity: 0, spectralBands: [0, 0, 0, 0], featureScaleUV: 0, coherence: 0, supportFraction: 0 },
      { occupiedFraction: 0.05, reactionActivity: 0.002, spectralBands: [0.7, 0.2, 0.08, 0.02], featureScaleUV: 0.3, coherence: 0.3, largestComponentFraction: 0.8, beta0Approx: 1, supportFraction: 0.2 },
      { occupiedFraction: 0.3, reactionActivity: 0.02, spectralBands: [0.3, 0.3, 0.25, 0.15], featureScaleUV: 0.1, coherence: 0.6, largestComponentFraction: 0.4, beta0Approx: 5, edgeDensity: 0.15, supportFraction: 0.6 },
      { occupiedFraction: 0.1, reactionActivity: 0.004, spectralBands: [0.1, 0.2, 0.3, 0.4], featureScaleUV: 0.03, coherence: 0.1, largestComponentFraction: 0.08, beta0Approx: 9, edgeDensity: 0.3, supportFraction: 0.4 },
    ];
    for (const sample of arc) {
      const controls = deriveAudioControls(presentation(sample));
      expect(controls.valid).toBe(true);
      expect(controls.fundamentalHz).toBeGreaterThanOrEqual(AUDIO.fundamentalMinHz - 1e-9);
      expect(controls.fundamentalHz).toBeLessThanOrEqual(AUDIO.fundamentalMaxHz + 1e-9);
      expect(controls.intensity).toBeGreaterThanOrEqual(0);
      expect(controls.intensity).toBeLessThanOrEqual(1);
      expect(controls.voiceCount).toBeGreaterThanOrEqual(1);
      expect(controls.voiceCount).toBeLessThanOrEqual(4);
      expect(controls.detuneCents).toBeGreaterThanOrEqual(0);
      expect(controls.detuneCents).toBeLessThanOrEqual(AUDIO.maxDetuneCents);
      expect(controls.grainRate).toBeGreaterThanOrEqual(0);
      expect(controls.grainRate).toBeLessThanOrEqual(AUDIO.maxGrainsPerSecond);
      expect(controls.wetGain).toBeGreaterThanOrEqual(AUDIO.wetMin - 1e-12);
      expect(controls.wetGain).toBeLessThanOrEqual(AUDIO.wetMax + 1e-12);
      expect(controls.voiceFrequencies).toHaveLength(4);
      for (const frequency of controls.voiceFrequencies) {
        expect(Number.isFinite(frequency)).toBe(true);
        expect(frequency).toBeGreaterThanOrEqual(AUDIO.fundamentalMinHz - 1e-9);
        expect(frequency).toBeLessThanOrEqual(AUDIO.fundamentalMaxHz * 3 + 1e-9);
      }
    }
  });

  it('an invalid tier yields the bounded silent neutral bundle', () => {
    const neutral = neutralAudioControls();
    expect(neutral.valid).toBe(false);
    expect(neutral.voiceLevel).toBe(0);
    expect(neutral.grainRate).toBe(0);
    const invalid = deriveAudioControls({ ...neutralAnalysisState().presentation, valid: false });
    expect(invalid.valid).toBe(false);
    expect(invalid.voiceLevel).toBe(0);
    expect(invalid.grainRate).toBe(0);
  });

  it('a valid field with absent support maps to silence, not to the floor', () => {
    const controls = deriveAudioControls(
      presentation({
        occupiedFraction: 0,
        reactionActivity: 0,
        spectralBands: [0, 0, 0, 0],
        featureScaleUV: 0,
        supportFraction: 0,
      }),
    );
    expect(controls.voiceLevel).toBe(0);
    expect(controls.grainRate).toBe(0);
    expect(controls.textureLevel).toBe(0);
    expect(controls.voiceLevels.every((level) => level === 0)).toBe(true);
  });

  it('a valid, zero-intensity but supported field maps to the warm floor, not to zero', () => {
    const controls = deriveAudioControls(
      presentation({
        occupiedFraction: 0,
        reactionActivity: 0,
        spectralBands: [0, 0, 0, 0],
        featureScaleUV: 0.5,
        supportFraction: 0.5,
      }),
    );
    expect(controls.voiceLevel).toBeCloseTo(AUDIO.padLevelFloor, 9);
    expect(controls.voiceLevels[0]).toBeGreaterThan(0);
  });
});
