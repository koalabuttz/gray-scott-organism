/**
 * §12.3 audio mappings (AC.12 half): the six §8.1 controls are bounded and monotone where specified,
 * with the **TAKE-4 musicalization** layer on top (fixed A-major-pentatonic key, activity-band pad
 * degrees, coherence-led bloom degrees, scale-aware voicings, zero detuning).
 *
 * These are pure functions of plain numbers, so they are tested directly (no graph, no DOM, no
 * context) and again through `deriveAudioControls` on injected synthetic presentation samples.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO } from '../src/config.ts';
import type { PresentationAnalysis } from '../src/core/types.ts';
import {
  NEUTRAL_DEGREE,
  PAD_VOICINGS,
  SCALE_RATIOS,
  activityForX,
  activityX,
  bandOf,
  bloomBaseHz,
  chordColorGain,
  deriveAudioControls,
  featureScaleNorm,
  hystereticBand,
  mapFineDetail,
  mapFragmentation,
  mapGrainRate,
  mapIntensity,
  mapPadLevel,
  mapTextureFilterHz,
  mapTextureLevel,
  mapVoiceCount,
  mapVoiceFilterHz,
  mapWetGain,
  neutralAudioControls,
  scaleHz,
  voiceLevels,
  voicingCarriers,
} from '../src/audio/voices.ts';
import { neutralAnalysisState } from '../src/core/world.ts';

/** A presentation sample builder: only the descriptors the audio mappings read are meaningful. */
function presentation(overrides: Partial<PresentationAnalysis>): PresentationAnalysis {
  return { ...neutralAnalysisState().presentation, valid: true, ...overrides };
}

/** Cents between two frequencies (the perceptual distance a degree change represents). */
function cents(a: number, b: number): number {
  return 1200 * Math.log2(b / a);
}

describe('§2 (TAKE-4) the fixed A-major-pentatonic key', () => {
  it('is A2 = 110 Hz with the just pentatonic ratios', () => {
    expect(AUDIO.tonicHz).toBe(110);
    expect(SCALE_RATIOS).toEqual([1, 9 / 8, 5 / 4, 3 / 2, 5 / 3]);
  });

  it('converts absolute scale indices exactly (ratio × 2^floor(k/5))', () => {
    const expected = [110, 123.75, 137.5, 165, 110 * (5 / 3)];
    for (let k = 0; k < 5; k += 1) expect(scaleHz(k)).toBeCloseTo(expected[k]!, 9);
    // Octave 1 repeats the ratios at exactly 2× the base register.
    for (let k = 0; k < 5; k += 1) expect(scaleHz(k + 5)).toBeCloseTo(2 * expected[k]!, 9);
    // Octave 2 → the bloom's fine register.
    for (let k = 0; k < 5; k += 1) expect(scaleHz(k + 10)).toBeCloseTo(4 * expected[k]!, 9);
  });

  it('is total for hostile indices (never NaN, always in key)', () => {
    for (const index of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3, 3.7]) {
      const hz = scaleHz(index);
      expect(Number.isFinite(hz)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(AUDIO.tonicHz);
    }
  });
});

describe('§3 (TAKE-4) scale-aware voicings', () => {
  it('has five degrees × four voices, every carrier an exact scale note', () => {
    expect(PAD_VOICINGS).toHaveLength(5);
    for (const voicing of PAD_VOICINGS) {
      expect(voicing).toHaveLength(4);
      for (const index of voicing) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps every carrier in key (its Hz equals scaleHz of its own table index)', () => {
    for (let degree = 0; degree < 5; degree += 1) {
      const voicing = PAD_VOICINGS[degree]!;
      const carriers = voicingCarriers(degree);
      for (let i = 0; i < 4; i += 1) expect(carriers[i]).toBeCloseTo(scaleHz(voicing[i]!), 9);
    }
  });

  it('brackets the key: roots 110–183.333 Hz and no carrier above 550 Hz', () => {
    const roots = [0, 1, 2, 3, 4].map((degree) => voicingCarriers(degree)[0]!);
    expect(Math.min(...roots)).toBeCloseTo(AUDIO.fundamentalMinHz, 9);
    expect(Math.max(...roots)).toBeCloseTo(AUDIO.fundamentalMaxHz, 9);
    expect(AUDIO.fundamentalMaxHz).toBeCloseTo(110 * (5 / 3), 9);
    const all = [0, 1, 2, 3, 4].flatMap((degree) => [...voicingCarriers(degree)]);
    expect(Math.max(...all)).toBeLessThanOrEqual(550 + 1e-9);
  });

  it('moves at most one adjacent degree, and no adjacent step exceeds 315.642 cents', () => {
    for (const degree of [0, 1, 2, 3]) {
      const step = cents(voicingCarriers(degree)[0]!, voicingCarriers(degree + 1)[0]!);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(315.642);
    }
    // The table is strictly increasing in the root, so there is no wrap 4 → 0.
    for (const degree of [0, 1, 2, 3]) {
      expect(voicingCarriers(degree + 1)[0]!).toBeGreaterThan(voicingCarriers(degree)[0]!);
    }
  });

  it('the neutral degree is A (the tonic), the silent default', () => {
    expect(NEUTRAL_DEGREE).toBe(0);
    expect(voicingCarriers(NEUTRAL_DEGREE)[0]).toBeCloseTo(AUDIO.tonicHz, 9);
    // Every voicing degree is an integer in [0, 4] even for hostile input.
    expect(voicingCarriers(9.4)[0]).toBeCloseTo(voicingCarriers(4)[0]!, 9);
    expect(voicingCarriers(-2)[0]).toBeCloseTo(voicingCarriers(0)[0]!, 9);
  });
});

describe('§2 (TAKE-4) the activity-band selector', () => {
  it('normalizes reaction activity exactly over [0, 1] with the .03 ceiling / .001 knee', () => {
    expect(AUDIO.activityCeiling).toBeCloseTo(0.03, 9);
    expect(AUDIO.activityKnee).toBeCloseTo(0.001, 9);
    expect(activityX(0)).toBe(0);
    expect(activityX(AUDIO.activityCeiling)).toBeCloseTo(1, 9);
    expect(activityX(AUDIO.activityCeiling * 4)).toBeCloseTo(1, 9);
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      expect(activityX(activityForX(x))).toBeCloseTo(x, 9);
    }
  });

  it('is finite and bounded for adversarial input', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const x = activityX(value);
      expect(Number.isFinite(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('places the five band edges exactly at .2/.4/.6/.8', () => {
    expect([...AUDIO.activityBandEdges]).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(bandOf(0, AUDIO.activityBandEdges)).toBe(0);
    expect(bandOf(0.199999, AUDIO.activityBandEdges)).toBe(0);
    expect(bandOf(0.2, AUDIO.activityBandEdges)).toBe(1);
    expect(bandOf(0.4, AUDIO.activityBandEdges)).toBe(2);
    expect(bandOf(0.6, AUDIO.activityBandEdges)).toBe(3);
    expect(bandOf(0.8, AUDIO.activityBandEdges)).toBe(4);
    expect(bandOf(1, AUDIO.activityBandEdges)).toBe(4);
    expect(bandOf(Number.NaN, AUDIO.activityBandEdges)).toBe(0);
  });

  it('applies the Schmitt deadband: ±.025 around each boundary', () => {
    const edges = AUDIO.activityBandEdges;
    const h = AUDIO.selectorHysteresis;
    expect(h).toBeCloseTo(0.025, 9);
    // Upward: a value under edge + hysteresis does not move the band up…
    expect(hystereticBand(0.21, 0, edges, h)).toBe(0);
    expect(hystereticBand(0.224999, 0, edges, h)).toBe(0);
    // …and just at/above the boundary it does.
    expect(hystereticBand(0.226, 0, edges, h)).toBe(1);
    // Downward: a value above edge − hysteresis stays in the upper band…
    expect(hystereticBand(0.19, 1, edges, h)).toBe(1);
    expect(hystereticBand(0.176, 1, edges, h)).toBe(1);
    // …and just below it falls back.
    expect(hystereticBand(0.174, 1, edges, h)).toBe(0);
    // A hostile value never moves the band.
    expect(hystereticBand(Number.NaN, 2, edges, h)).toBe(2);
  });

  it('feature scale alone cannot move the pad; activity alone can', () => {
    const base = { occupiedFraction: 0.3, reactionActivity: 0.004, coherence: 0.45 };
    const fine = deriveAudioControls(presentation({ ...base, featureScaleUV: 0.02 }));
    const coarse = deriveAudioControls(presentation({ ...base, featureScaleUV: 0.66 }));
    // Feature scale is only audible through the bloom register now — never through the pad selector.
    expect(fine.activityX).toBe(coarse.activityX);
    expect(featureScaleNorm(0.02)).toBe(0);
    expect(featureScaleNorm(0.66)).toBe(1);

    const quiet = deriveAudioControls(presentation({ ...base, reactionActivity: activityForX(0.1) }));
    const busy = deriveAudioControls(presentation({ ...base, reactionActivity: activityForX(0.7) }));
    expect(busy.activityX).toBeGreaterThan(quiet.activityX);
    expect(bandOf(quiet.activityX, AUDIO.activityBandEdges)).toBe(0);
    expect(bandOf(busy.activityX, AUDIO.activityBandEdges)).toBe(3);
  });
});

describe('§4 (TAKE-4) bloom scale notes', () => {
  it('maps degree + register to the coarse (220–366.667) and fine (440–733.333) octaves', () => {
    expect(AUDIO.bloomOctaveOffsetCoarse).toBe(5);
    expect(AUDIO.bloomOctaveOffsetFine).toBe(10);
    const coarse = [0, 1, 2, 3, 4].map((degree) => bloomBaseHz(degree, 'coarse'));
    const fine = [0, 1, 2, 3, 4].map((degree) => bloomBaseHz(degree, 'fine'));
    expect(coarse[0]).toBeCloseTo(220, 9);
    expect(coarse[4]).toBeCloseTo(366.6666667, 4);
    expect(fine[0]).toBeCloseTo(440, 9);
    expect(fine[4]).toBeCloseTo(733.3333333, 4);
    for (let degree = 0; degree < 5; degree += 1) {
      expect(coarse[degree]).toBeCloseTo(2 * scaleHz(degree), 9);
      expect(fine[degree]).toBeCloseTo(4 * scaleHz(degree), 9);
      // Every bloom note is an exact scale note (in-key).
      expect(coarse[degree]).toBeCloseTo(scaleHz(degree + 5), 9);
      expect(fine[degree]).toBeCloseTo(scaleHz(degree + 10), 9);
    }
  });

  it('is total and bounded for hostile degrees', () => {
    for (const degree of [Number.NaN, -5, 12]) {
      const hz = bloomBaseHz(degree, 'coarse');
      expect(Number.isFinite(hz)).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(220 - 1e-9);
      expect(hz).toBeLessThanOrEqual(366.6666667 + 1e-6);
    }
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
    // The floor is *not* re-gated on the raw on-threshold — presence is the stateful latch, so any
    // support at all keeps the floor computable (it is held through the hysteresis band).
    expect(mapPadLevel(1, AUDIO.supportOffFraction)).toBeGreaterThan(0);
    expect(mapPadLevel(1, AUDIO.supportOnFraction)).toBeGreaterThan(0);
    expect(mapPadLevel(1, AUDIO.supportOnFraction * 0.5)).toBeGreaterThan(0);
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
    // Voice 3 carries the chord colour: silent at coherence 0, present as it coheres.
    expect(voiceLevels(4, pad, 0)[3]).toBeCloseTo(
      (pad * AUDIO.voiceWeights[3]! * chordColorGain(0)) / norm,
      9,
    );
    expect(chordColorGain(0)).toBe(0);
    expect(chordColorGain(1)).toBe(1);
    expect(chordColorGain(0.5)).toBeGreaterThan(0);
    expect(chordColorGain(0.5)).toBeLessThan(1);
  });
});

describe('§8.1 (4) coherence', () => {
  it('the chord-colour gain is monotone and bounded (and there is no detuning at all)', () => {
    let previous = -1;
    for (const coherence of [0, 0.25, 0.5, 0.75, 1]) {
      const gain = chordColorGain(coherence);
      expect(gain).toBeGreaterThanOrEqual(previous);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
      previous = gain;
    }
    // TAKE-4 §3: zero detuning — coherence controls colour gain and wet only.
    expect(AUDIO.maxDetuneCents).toBe(0);
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

  it('the per-voice low-pass is clamp(carrier·(3 + 2·intensity), 500, 2400)', () => {
    expect(mapVoiceFilterHz(110, 0)).toBeCloseTo(500, 6); // 110·3 = 330 → clamped up
    expect(mapVoiceFilterHz(110, 1)).toBeCloseTo(550, 6); // 110·5
    expect(mapVoiceFilterHz(550, 1)).toBeCloseTo(2400, 6); // 550·5 → clamped down
    expect(mapVoiceFilterHz(220, 0.5)).toBeGreaterThanOrEqual(500);
    expect(mapVoiceFilterHz(Number.NaN, 1)).toBeGreaterThanOrEqual(AUDIO.voiceFilterMinHz);
    expect(mapVoiceFilterHz(1e9, 1)).toBeLessThanOrEqual(AUDIO.voiceFilterMaxHz);
  });

  it('the granular band-pass centre stays within [1100, 2400] Hz and rises with detail', () => {
    expect(AUDIO.grainFilterMinHz).toBe(1100);
    expect(AUDIO.grainFilterMaxHz).toBe(2400);
    expect(mapTextureFilterHz(0)).toBeCloseTo(AUDIO.grainFilterMinHz, 6);
    expect(mapTextureFilterHz(1)).toBeCloseTo(AUDIO.grainFilterMaxHz, 6);
    expect(mapTextureFilterHz(0.8)).toBeGreaterThan(mapTextureFilterHz(0.2));
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
      expect(controls.activityX).toBeGreaterThanOrEqual(0);
      expect(controls.activityX).toBeLessThanOrEqual(1);
      expect(controls.intensity).toBeGreaterThanOrEqual(0);
      expect(controls.intensity).toBeLessThanOrEqual(1);
      expect(controls.voiceCount).toBeGreaterThanOrEqual(1);
      expect(controls.voiceCount).toBeLessThanOrEqual(4);
      expect(controls.grainRate).toBeGreaterThanOrEqual(0);
      expect(controls.grainRate).toBeLessThanOrEqual(AUDIO.maxGrainsPerSecond);
      expect(controls.wetGain).toBeGreaterThanOrEqual(AUDIO.wetMin - 1e-12);
      expect(controls.wetGain).toBeLessThanOrEqual(AUDIO.wetMax + 1e-12);
      expect(Number.isFinite(controls.activityX)).toBe(true);
    }
  });

  it('an invalid tier yields the bounded silent neutral bundle', () => {
    const neutral = neutralAudioControls();
    expect(neutral.valid).toBe(false);
    expect(neutral.voiceLevel).toBe(0);
    expect(neutral.grainRate).toBe(0);
    expect(neutral.activityX).toBe(0);
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
