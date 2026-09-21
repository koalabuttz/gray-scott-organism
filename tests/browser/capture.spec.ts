/**
 * AC.6 — composite output is exactly black with no seed, and a viable seed produces a nonzero
 * structured response.
 *
 * "Structured" is asserted two ways: the image must contain both lit and unlit pixels (so a
 * uniformly filled rectangle fails), and the underlying chemical field must be alive and
 * non-uniform. Pixels are read from the composite framebuffer in the same task as the draw,
 * which is exact rather than a compositor round-trip.
 */
import { expect, test } from '@playwright/test';
import { DEFAULT_PARAMS } from '../../src/config.ts';
import { openArtwork, hook } from '../support/browser.ts';
import type { FieldStatsShape, ImageStatsShape } from '../support/types.ts';

test.describe('composite capture', () => {
  test('AC.6 no seed produces an exactly black background', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'renderOnce');

    const stats = await hook<ImageStatsShape>(page, 'compositeStats');
    console.info(
      `[AC.6] unseeded composite: max=${stats.max} mean=${stats.mean.toFixed(6)} ` +
        `anyNonZero=${stats.anyNonZeroFraction} nonBlack=${stats.nonBlackFraction}`,
    );

    // Exact black: no pixel has a nonzero channel anywhere in the chain (renderer clear,
    // material pass, bloom, tone map, sRGB transfer).
    expect(stats.max).toBe(0);
    expect(stats.anyNonZeroFraction).toBe(0);
    expect(stats.nonBlackFraction).toBe(0);
    expect(stats.channelMean).toEqual([0, 0, 0]);
  });

  test('AC.6 a viable seed produces a nonzero structured response', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [DEFAULT_PARAMS]);
    // A viable but modest organism: nine injected seeds grown for 4000 steps. A single seed is
    // legitimate too, but this keeps the structural assertion meaningful without a long run.
    for (let j = 0; j < 3; j += 1) {
      for (let i = 0; i < 3; i += 1) {
        await hook(page, 'seed', [
          {
            center: [0.25 + i * 0.25, 0.25 + j * 0.25],
            radiusCells: 5,
            mode: i === 0 && j === 0 ? 'replace' : 'inject',
          },
        ]);
      }
    }

    const started = Date.now();
    await hook(page, 'simulate', [4000]);
    const simulatedMs = Date.now() - started;
    await hook(page, 'renderOnce');

    const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
    const stats = await hook<ImageStatsShape>(page, 'compositeStats');
    console.info(
      `[AC.6] seeded composite after 4000 steps (${simulatedMs}ms): max=${stats.max} mean=${stats.mean.toFixed(3)} ` +
        `p50=${stats.percentiles[0]} p95=${stats.percentiles[1]} p99=${stats.percentiles[2]} ` +
        `nonBlack=${stats.nonBlackFraction.toFixed(4)} bright=${stats.aboveThresholdFraction.toFixed(4)} ` +
        `clipped=${stats.clippedFraction.toFixed(6)} channelMean=[${stats.channelMean.map((v) => v.toFixed(2)).join(', ')}] ` +
        `field occupied=${field.occupiedFraction.toFixed(4)} edgeDensity=${field.edgeDensity.toFixed(5)}`,
    );

    // The chemistry is alive and non-uniform.
    expect(field.nonFinite).toBe(0);
    expect(field.occupiedFraction).toBeGreaterThan(0.005);
    expect(field.occupiedFraction).toBeLessThan(0.95);

    // The image responds: there is light, and the light is structured rather than a filled sheet
    // (black still dominates: the median pixel stays at zero).
    expect(stats.max).toBeGreaterThan(60);
    expect(stats.mean).toBeGreaterThan(0.25);
    expect(stats.nonBlackFraction).toBeGreaterThan(0.001);
    expect(stats.nonBlackFraction).toBeLessThan(0.9);
    expect(stats.percentiles[0]).toBe(0);
  });

  test('the PNG capture path returns a decodable image of the composite', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [DEFAULT_PARAMS]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 6, mode: 'replace' }]);
    await hook(page, 'simulate', [1500]);

    // §10: capture reads the renderer's final composite in the same task as the draw, so no
    // preserveDrawingBuffer is needed. Verify the bytes really are a PNG of the canvas.
    const base64 = await hook<string>(page, 'capturePngBase64');
    console.info(`[capture] PNG payload ${base64.length} chars, magic ${base64.slice(0, 12)}`);
    expect(base64.startsWith('iVBORw0KGgo')).toBe(true);
    expect(base64.length).toBeGreaterThan(10_000);

    const bytes = Buffer.from(base64, 'base64');
    // PNG header: signature, IHDR with 1920-style dimensions from the 1280x720 viewport.
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const canvas = await hook<{ width: number; height: number }>(page, 'canvasSize');
    console.info(`[capture] PNG ${width}x${height}, canvas ${canvas.width}x${canvas.height}`);
    expect(width).toBe(canvas.width);
    expect(height).toBe(canvas.height);
  });
});
