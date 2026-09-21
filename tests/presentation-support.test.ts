/**
 * §6 support descriptor (deviation 58): `PresentationEngine` computes `supportFraction` as the mean
 * `smoothstep(SURFACE.supportVLow, SURFACE.supportVHigh, reducedV)` over the envelope-weighted reduced-V
 * field — the presence signal the audio engine keys on. These fixtures drive the *real* engine on a
 * synthetic 256² combined buffer (empty, hidden-periphery, subthreshold, small patch, broad patch).
 */
import { describe, expect, it } from 'vitest';
import { PRESENTATION, SURFACE } from '../src/config.ts';
import { PresentationEngine } from '../src/analysis/presentation.ts';
import type { SampleStamp } from '../src/core/types.ts';

const WIDTH = PRESENTATION.width;
const HEIGHT = PRESENTATION.height;
const HEALTH_OFFSET = WIDTH * HEIGHT * 4;

const STAMP: SampleStamp = {
  epoch: 0,
  step: 0,
  simulationTime: 0,
  performanceSeconds: 0,
  parameters: { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 },
};

/** A combined buffer whose reduced-V (green) channel is set by `value(x, y)`. */
function buildBytes(value: (x: number, y: number) => number): Uint8Array {
  const bytes = new Uint8Array(HEALTH_OFFSET + 16);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = y * WIDTH + x;
      bytes[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(value(x, y) * 255)));
    }
  }
  return bytes;
}

function supportOf(value: (x: number, y: number) => number): number {
  const engine = new PresentationEngine(WIDTH, HEIGHT);
  return engine.analyze(buildBytes(value), STAMP, HEALTH_OFFSET, 'RGBA32F').payload.presentation
    .supportFraction;
}

describe('§6 supportFraction presentation descriptor', () => {
  it('is exactly zero for an empty field', () => {
    expect(supportOf(() => 0)).toBe(0);
  });

  it('is zero for the hidden periphery (every reduced-V below the support ramp)', () => {
    expect(supportOf(() => SURFACE.supportVLow * 0.5)).toBe(0);
  });

  it('is zero just below the ramp and grows once reduced V crosses it', () => {
    const justBelow = supportOf(() => SURFACE.supportVLow - 0.002);
    expect(justBelow).toBe(0);
    const atLow = supportOf(() => SURFACE.supportVLow);
    expect(atLow).toBe(0);
    const mid = supportOf(() => (SURFACE.supportVLow + SURFACE.supportVHigh) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  it('saturates to one for a broad, fully supported field', () => {
    expect(supportOf(() => SURFACE.supportVHigh)).toBeCloseTo(1, 6);
    expect(supportOf(() => 1)).toBeCloseTo(1, 6);
  });

  it('scales with the supported area for a small patch', () => {
    // A 1/16-area high-V patch contributes ≈ 1/16 of the mean.
    const patch = supportOf((x, y) => (x < WIDTH / 4 && y < HEIGHT / 4 ? SURFACE.supportVHigh : 0));
    expect(patch).toBeGreaterThan(0.05);
    expect(patch).toBeLessThan(0.08);
    const quarter = supportOf((x, y) => (x < WIDTH / 2 && y < HEIGHT / 2 ? SURFACE.supportVHigh : 0));
    expect(quarter).toBeGreaterThan(0.22);
    expect(quarter).toBeLessThan(0.28);
  });
});
