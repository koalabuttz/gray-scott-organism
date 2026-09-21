/**
 * §7.4/AC.10 spectrum fixtures: a constant field yields zero non-DC power; known sinusoids land in the
 * expected bands; translation preserves band energy within window tolerance; and the near-zero branch
 * returns zero bands rather than a meaningless feature scale.
 */
import { describe, expect, it } from 'vitest';
import { SpectrumAnalyzer } from '../src/analysis/spectrum.ts';

const SIZE = 128;

function sinusoid(frequencyX: number, frequencyY = 0, phase = 0): Float32Array {
  const field = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      field[y * SIZE + x] = Math.sin(
        (2 * Math.PI * frequencyX * x) / SIZE + (2 * Math.PI * frequencyY * y) / SIZE + phase,
      );
    }
  }
  return field;
}

describe('§7.4 spatial spectrum (AC.10)', () => {
  it('constant field: near-zero non-DC energy, zero bands, no feature scale', () => {
    const field = new Float32Array(SIZE * SIZE).fill(0.4);
    const result = new SpectrumAnalyzer(SIZE).analyze(field, SIZE);
    expect(result.totalEnergy).toBeLessThan(1e-6);
    expect(result.bands).toEqual([0, 0, 0, 0]);
    expect(result.featureScaleUV).toBe(0);
  });

  it('low-frequency sinusoid lands in band 1 (1–4 cycles/domain)', () => {
    const result = new SpectrumAnalyzer(SIZE).analyze(sinusoid(2), SIZE);
    expect(result.bands[0]).toBeGreaterThan(0.5);
    expect(result.bands[0]).toBeGreaterThan(result.bands[1]);
    // Characteristic frequency ~2 -> feature scale ~0.5 domain units.
    expect(result.featureScaleUV).toBeGreaterThan(0.3);
    expect(result.featureScaleUV).toBeLessThan(0.7);
  });

  it('mid-frequency sinusoid lands in band 2 (4–12)', () => {
    const result = new SpectrumAnalyzer(SIZE).analyze(sinusoid(6), SIZE);
    expect(result.bands[1]).toBeGreaterThan(0.5);
    expect(result.bands[1]).toBeGreaterThan(result.bands[0]);
    expect(result.bands[1]).toBeGreaterThan(result.bands[2]);
  });

  it('high-frequency sinusoid lands in band 3 (12–28)', () => {
    const result = new SpectrumAnalyzer(SIZE).analyze(sinusoid(20), SIZE);
    expect(result.bands[2]).toBeGreaterThan(0.5);
    expect(result.bands[2]).toBeGreaterThan(result.bands[1]);
  });

  it('very-high-frequency sinusoid lands in band 4 (28–64 cycles/domain)', () => {
    const result = new SpectrumAnalyzer(SIZE).analyze(sinusoid(32), SIZE);
    expect(result.bands[3]).toBeGreaterThan(0.85);
    expect(result.bands[3]).toBeGreaterThan(result.bands[2]);
    expect(result.bands[3]).toBeGreaterThan(result.bands[1]);
    // Characteristic frequency 32 -> feature scale ~1/32 domain units.
    expect(result.featureScaleUV).toBeGreaterThan(0.025);
    expect(result.featureScaleUV).toBeLessThan(0.04);
  });

  it('translation preserves band energy within Hann-window tolerance', () => {
    const analyzer = new SpectrumAnalyzer(SIZE);
    const base = analyzer.analyze(sinusoid(6), SIZE);
    const shifted = analyzer.analyze(sinusoid(6, 0, Math.PI / 3), SIZE);
    for (let b = 0; b < 4; b += 1) {
      expect(Math.abs(shifted.bands[b] - base.bands[b])).toBeLessThan(0.15);
    }
    expect(Math.abs(shifted.featureScaleUV - base.featureScaleUV)).toBeLessThan(0.1);
  });

  it('downsamples a 256² source (the reduced presentation field) without changing the band', () => {
    const source = new Float32Array(256 * 256);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) source[y * 256 + x] = Math.sin((2 * Math.PI * 6 * x) / 256);
    }
    const result = new SpectrumAnalyzer(SIZE).analyze(source, 256);
    expect(result.bands[1]).toBeGreaterThan(result.bands[0]);
    expect(result.bands[1]).toBeGreaterThan(result.bands[2]);
  });
});
