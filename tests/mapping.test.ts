/**
 * §12.3 audio mappings (AC.12 half): the six §8.1 controls are bounded and monotone where specified.
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
  DETUNE_SIGN,
  VOICE_RATIOS,
  deriveAudioControls,
  mapDetuneCents,
  mapFineDetail,
  mapFragmentation,
  mapFundamentalHz,
  mapGrainRate,
  mapIntensity,
  mapTextureFilterHz,
  mapTextureLevel,
  mapVoiceCount,
  mapVoiceLevel,
  mapWetGain,
  neutralAudioControls,
} from '../src/audio/voices.ts';
import { neutralAnalysisState } from '../src/core/world.ts';

/** A presentation sample builder: only the descriptors the audio mappings read are meaningful. */
function presentation(overrides: Partial<PresentationAnalysis>): PresentationAnalysis {
  return { ...neutralAnalysisState().presentation, valid: true, ...overrides };
}

describe('§8.2 voice ratios', () => {
  it('are the just intervals [1, 3/2, 2, 3]', () => {
    expect(VOICE_RATIOS).toEqual([1, 1.5, 2, 3]);
    expect(AUDIO.maxVoices).toBe(4);
    expect(DETUNE_SIGN).toHaveLength(4);
  });

  it('pins the 50 ms scheduler tick and 150 ms lookahead (the tick stays inside the lookahead)', () => {
    expect(AUDIO.tickMs).toBe(50);
    expect(AUDIO.lookaheadMs).toBe(150);
    expect(AUDIO.tickMs).toBeLessThan(AUDIO.lookaheadMs);
    // The §8.2 bounds that the granular layer is defined against.
    expect(AUDIO.maxGrainsPerSecond).toBe(3);
    expect(AUDIO.maxConcurrentGrains).toBe(12);
    expect(AUDIO.grainMinSeconds).toBe(0.15);
    expect(AUDIO.grainMaxSeconds).toBe(0.8);
    expect(AUDIO.eventRefractorySeconds).toBeGreaterThanOrEqual(15);
    // Deviation 57 (audibility recalibration): the band moved from §8.2's literal ≈38–82 Hz to
    // 55–110 Hz after the live path proved a 38–82 Hz drone is below laptop-speaker reproduction.
    expect(AUDIO.fundamentalMinHz).toBe(55);
    expect(AUDIO.fundamentalMaxHz).toBe(110);
    expect(AUDIO.wetMin).toBeGreaterThanOrEqual(0.12);
    expect(AUDIO.wetMax).toBeLessThanOrEqual(0.2);
    expect(AUDIO.fadeSeconds).toBeGreaterThanOrEqual(8);
    expect(AUDIO.fadeSeconds).toBeLessThanOrEqual(15);
    expect(AUDIO.offSeconds).toBe(8);
    expect(AUDIO.wakeSeconds).toBe(3);
  });
});

describe('§8.1 (1) scale — fundamental', () => {
  it('stays inside the 55–110 Hz logarithmic band for any input', () => {
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

  it('reaches the deep end for a large smooth mass and the bright end for fine texture', () => {
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

  it('voice level is zero at zero intensity (a hidden field is silent) and bounded', () => {
    expect(mapVoiceLevel(0)).toBe(0);
    expect(mapVoiceLevel(1)).toBeCloseTo(AUDIO.voiceLevelMax, 9);
    expect(mapVoiceLevel(9)).toBeLessThanOrEqual(AUDIO.voiceLevelMax + 1e-12);
  });
});

describe('§8.1 (4) coherence', () => {
  it('detuning falls from the ceiling to zero as coherence rises', () => {
    expect(mapDetuneCents(0)).toBeCloseTo(AUDIO.maxDetuneCents, 9);
    expect(mapDetuneCents(1)).toBe(0);
    let previous = Number.POSITIVE_INFINITY;
    for (const coherence of [0, 0.25, 0.5, 0.75, 1]) {
      const cents = mapDetuneCents(coherence);
      expect(cents).toBeLessThanOrEqual(previous);
      expect(cents).toBeGreaterThanOrEqual(0);
      previous = cents;
    }
  });

  it('wet gain stays inside the §8.2 .12–.2 window', () => {
    for (const [coherence, intensity] of [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const wet = mapWetGain(coherence!, intensity!);
      expect(wet).toBeGreaterThanOrEqual(AUDIO.wetMin - 1e-12);
      expect(wet).toBeLessThanOrEqual(AUDIO.wetMax + 1e-12);
    }
  });
});

describe('§8.1 (2) fine detail — granular texture', () => {
  it('grain rate stays in [0, 3] and rises with fine detail', () => {
    let previous = -1;
    for (const detail of [0, 0.1, 0.3, 0.6, 1]) {
      const rate = mapGrainRate(detail);
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(AUDIO.maxGrainsPerSecond);
      expect(rate).toBeGreaterThanOrEqual(previous);
      previous = rate;
    }
  });

  it('fine detail combines high band and edge density, bounded to [0,1]', () => {
    expect(mapFineDetail(1, 1)).toBe(1);
    expect(mapFineDetail(0, 0)).toBe(0);
    expect(mapFineDetail(0.5, 0.05)).toBeGreaterThan(mapFineDetail(0.2, 0.05));
    expect(mapFineDetail(Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('the granular band-pass centre stays within [400, 3200] Hz and rises with detail', () => {
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

  it('texture bandwidth is removed by fragmentation and bounded', () => {
    expect(mapTextureLevel(1, 1)).toBeCloseTo(0, 12);
    expect(mapTextureLevel(1, 0)).toBeCloseTo(AUDIO.textureLevelMax, 9);
    expect(mapTextureLevel(0, 0)).toBe(0);
  });
});

describe('deriveAudioControls — the joint bundle', () => {
  it('is bounded across a synthetic arc from dead to saturated to fragmented', () => {
    const arc: Partial<PresentationAnalysis>[] = [
      { occupiedFraction: 0, reactionActivity: 0, spectralBands: [0, 0, 0, 0], featureScaleUV: 0, coherence: 0 },
      { occupiedFraction: 0.05, reactionActivity: 0.002, spectralBands: [0.7, 0.2, 0.08, 0.02], featureScaleUV: 0.3, coherence: 0.3, largestComponentFraction: 0.8, beta0Approx: 1 },
      { occupiedFraction: 0.3, reactionActivity: 0.02, spectralBands: [0.3, 0.3, 0.25, 0.15], featureScaleUV: 0.1, coherence: 0.6, largestComponentFraction: 0.4, beta0Approx: 5, edgeDensity: 0.15 },
      { occupiedFraction: 0.1, reactionActivity: 0.004, spectralBands: [0.1, 0.2, 0.3, 0.4], featureScaleUV: 0.03, coherence: 0.1, largestComponentFraction: 0.08, beta0Approx: 9, edgeDensity: 0.3 },
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

  it('a dead-but-valid field maps to silence, not to a floor', () => {
    const controls = deriveAudioControls(
      presentation({ occupiedFraction: 0, reactionActivity: 0, spectralBands: [0, 0, 0, 0], featureScaleUV: 0 }),
    );
    expect(controls.voiceLevel).toBe(0);
    expect(controls.grainRate).toBe(0);
    expect(controls.textureLevel).toBe(0);
  });
});
