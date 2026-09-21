/**
 * Material calibration sweep (§6.5/B2: material thresholds and light levels are calibration
 * values, not architecture).
 *
 * B2 says these are set during discovery and confirmed at the operator gate. This spec makes the
 * calibration explicit and repeatable instead of guesswork: it builds one mature field on the GPU
 * and walks a staged sweep of roughness, light intensity, exposure and emission gain, printing
 * the luminance statistics of each. The chosen values are baked into `src/config.ts`.
 *
 * Run with: CALIBRATE=1 npx playwright test calibrate.spec.ts
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { FieldStatsShape, ImageStatsShape } from '../support/types.ts';

const ENABLED = process.env['CALIBRATE'] === '1';
const STEPS = 12_000;
const PARAMS = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };

interface Sample {
  label: string;
  intensity: number;
  exposure: number;
  roughness: number;
  emissionGain: number;
  image: ImageStatsShape;
}

function formatSample(sample: Sample): string {
  const { image } = sample;
  return (
    `${sample.label.padEnd(26)} intensity=${String(sample.intensity).padStart(4)} exposure=${String(sample.exposure).padStart(4)} ` +
    `roughness=${sample.roughness.toFixed(2)} emission=${sample.emissionGain.toFixed(2)} | ` +
    `max=${String(image.max).padStart(3)} mean=${image.mean.toFixed(3)} p50=${image.percentiles[0]} p95=${image.percentiles[1]} p99=${image.percentiles[2]} ` +
    `lit=${(image.nonBlackFraction * 100).toFixed(3)}% bright=${(image.aboveThresholdFraction * 100).toFixed(3)}%`
  );
}

test.describe('material calibration', () => {
  test.skip(!ENABLED, 'set CALIBRATE=1 to run the material calibration sweep');

  test('staged sweep of roughness, intensity, exposure and emission on a mature field', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const probe = await openArtwork(page);
    expect(probe.ok, probe.reason).toBe(true);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [PARAMS]);
    for (let j = 0; j < 4; j += 1) {
      for (let i = 0; i < 4; i += 1) {
        await hook(page, 'seed', [
          {
            center: [0.125 + i * 0.25, 0.125 + j * 0.25],
            radiusCells: 5,
            mode: i === 0 && j === 0 ? 'replace' : 'inject',
          },
        ]);
      }
    }
    const started = Date.now();
    await hook(page, 'simulate', [STEPS]);
    console.info(`[calibrate] mature field built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
    console.info(
      `[calibrate] field: occupied=${field.occupiedFraction.toFixed(4)} meanV=${field.meanV.toFixed(4)} edge=${field.edgeDensity.toFixed(5)} activity=${field.reactionActivity.toFixed(6)}`,
    );

    const samples: Sample[] = [];
    const measure = async (label: string, intensity: number, exposure: number, roughness: number, emissionGain: number): Promise<void> => {
      await hook(page, 'setLight', [{ intensity, emissionGain }]);
      await hook(page, 'setMaterial', [{ exposure, roughness }]);
      await hook(page, 'renderOnce');
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      const sample: Sample = { label, intensity, exposure, roughness, emissionGain, image };
      samples.push(sample);
      console.info(`[calibrate] ${formatSample(sample)}`);
    };

    const baseIntensity = 20;
    const baseExposure = 1;
    const baseRoughness = 0.36;
    const baseEmission = 0.05;

    console.info('[calibrate] --- stage 1: roughness (relief 0.006, intensity 20, exposure 1)');
    for (const roughness of [0.24, 0.3, 0.36]) {
      await hook(page, 'setMaterial', [{ relief: 0.006 }]);
      await measure(`roughness ${roughness}`, baseIntensity, baseExposure, roughness, baseEmission);
    }

    console.info('[calibrate] --- stage 2: light intensity (relief 0.006, roughness 0.36, exposure 1)');
    for (const intensity of [10, 20, 30, 45, 70]) {
      await hook(page, 'setMaterial', [{ relief: 0.006 }]);
      await measure(`intensity ${intensity}`, intensity, baseExposure, baseRoughness, baseEmission);
    }

    console.info('[calibrate] --- stage 3: exposure (relief 0.006, roughness 0.36, intensity 30)');
    for (const exposure of [0.5, 1, 1.5, 2, 3]) {
      await hook(page, 'setMaterial', [{ relief: 0.006 }]);
      await measure(`exposure ${exposure}`, 30, exposure, baseRoughness, baseEmission);
    }

    console.info('[calibrate] --- stage 4: emission gain (relief 0.006, intensity 30, exposure 1.5, roughness 0.36)');
    for (const emissionGain of [0.0, 0.05, 0.2, 0.5]) {
      await hook(page, 'setMaterial', [{ relief: 0.006 }]);
      await measure(`emission ${emissionGain}`, 30, 1.5, baseRoughness, emissionGain);
    }

    console.info('[calibrate] --- stage 5: relief (intensity 30, exposure 1.5, roughness 0.36)');
    for (const relief of [0.002, 0.004, 0.006, 0.008]) {
      await hook(page, 'setMaterial', [{ relief, exposure: 1.5, roughness: baseRoughness }]);
      await hook(page, 'setLight', [{ intensity: 30, emissionGain: baseEmission }]);
      await hook(page, 'renderOnce');
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      console.info(
        `[calibrate] relief ${relief} -> max=${image.max} mean=${image.mean.toFixed(3)} p99=${image.percentiles[2]} lit=${(image.nonBlackFraction * 100).toFixed(3)}% bright=${(image.aboveThresholdFraction * 100).toFixed(3)}% clipped=${(image.clippedFraction * 100).toFixed(4)}%`,
      );
    }

    console.info('[calibrate] --- stage 6: bloom gain at the chosen point');
    for (const bloomGain of [0.0, 0.04, 0.12]) {
      await hook(page, 'setMaterial', [{ relief: 0.006, exposure: 1.5, roughness: baseRoughness, bloomGain }]);
      await hook(page, 'setLight', [{ intensity: 30, emissionGain: baseEmission }]);
      await hook(page, 'renderOnce');
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      console.info(
        `[calibrate] bloomGain ${bloomGain} -> max=${image.max} mean=${image.mean.toFixed(3)} p99=${image.percentiles[2]} bright=${(image.aboveThresholdFraction * 100).toFixed(3)}%`,
      );
    }

    expect(samples.length).toBeGreaterThan(10);
  });
});
