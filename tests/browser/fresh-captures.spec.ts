import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hook, openArtwork } from '../support/browser.ts';
import type { FieldStatsShape, ImageStatsShape, PublishedStateShape } from '../support/types.ts';

/** On-demand public artifact capture; the normal browser suite must never rewrite evidence. */
const enabled = process.env['FRESH_CAPTURE'] === '1';
const folder = resolve('artifacts', 'fresh-growth-2026-09');
const frames = resolve(folder, 'frames');
const stepPoints = [800, 1200, 1700, 2300, 3100, 4100, 5300, 6700, 8300, 10100, 12000, 14000, 16000];
const parameters = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };
const seedOptions = { center: [0.44, 0.53] as [number, number], radiusCells: 6, mode: 'replace' as const };

const png = (name: string, bytes: Buffer): void => writeFileSync(resolve(folder, name), bytes);

test('one seeded organism: fresh overhead + grazing stills and GIF source frames', async ({ page }) => {
  test.skip(!enabled, 'set FRESH_CAPTURE=1 to produce new visual artifacts');
  test.setTimeout(12 * 60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const probe = await openArtwork(page);
  expect(probe.ok, probe.reason).toBe(true);
  if (!probe.ok) return;
  mkdirSync(frames, { recursive: true });
  await hook(page, 'setAutoSeed', [false]);
  await hook(page, 'setPaused', [true]);
  await hook(page, 'reset');
  await hook(page, 'setParameters', [parameters]);
  await hook(page, 'seed', [seedOptions]);
  const canvas = page.locator('#stage');
  const records: Array<{ steps: number; file: string; occupiedFraction: number; meanV: number; imageMean: number }> = [];
  let delivered = 0;
  for (const [index, steps] of stepPoints.entries()) {
    await hook(page, 'simulate', [steps - delivered]);
    delivered = steps;
    await hook(page, 'renderOnce');
    const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
    const image = await hook<ImageStatsShape>(page, 'compositeStats');
    const file = `frame-${String(index).padStart(3, '0')}.png`;
    await canvas.screenshot({ path: resolve(frames, file) });
    records.push({ steps, file: `frames/${file}`, occupiedFraction: field.occupiedFraction, meanV: field.meanV, imageMean: image.mean });
    console.info(`[fresh-capture] ${steps} steps occupied=${field.occupiedFraction.toFixed(4)} imageMean=${image.mean.toFixed(3)}`);
    if (steps === 4100) png('01-developing-overhead.png', await canvas.screenshot());
    if (steps === 10100) png('02-growing-overhead.png', await canvas.screenshot());
    if (steps === 16000) png('03-mature-overhead.png', await canvas.screenshot());
  }
  expect(records.at(-1)!.occupiedFraction).toBeGreaterThan(0.2);
  await hook(page, 'dispatch', [{ type: 'camera', value: {
    mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.5, 0.5], transitionSeconds: 0,
  } }]);
  await hook(page, 'renderOnce');
  png('04-mature-grazing-close.png', await canvas.screenshot());
  const camera = (await hook<PublishedStateShape>(page, 'publishedState')).camera;
  writeFileSync(resolve(folder, 'captures.json'), JSON.stringify({
    source: 'real WebGL2 artwork, single continuous manual-lab Gray–Scott run',
    grid: 'default', viewport: '1280x720', parameters, seedOptions,
    stepPoints, gifFrameCount: stepPoints.length, records, grazingCamera: camera,
    note: 'GIF frames sample simulation development at unequal step intervals and will be displayed at a fixed rate; not real-time footage.',
  }, null, 2));
});
