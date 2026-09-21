/**
 * TEMPORARY probe (not part of the suite): measures the live visible→audible timeline so the wake-lag
 * fix can be quantified before/after. Delete before finishing.
 */
import { test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { AudioOutputShape, AudioStatusShape } from '../support/types.ts';

interface SummaryShape {
  occupiedFraction: number;
  maxV: number;
}

test.describe('PROBE visible->audible', () => {
  test('log timeline', async ({ page }) => {
    test.setTimeout(240_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.locator('#stage').click();
    await page.waitForTimeout(300);
    const status = await hook<AudioStatusShape>(page, 'audioStatus');
    test.skip(status.status !== 'running', `no audio device (status=${status.status})`);

    await hook(page, 'dispatch', [{ type: 'speed', value: 6 }]);

    const rows: string[] = [];
    let firstVisible: number | null = null;
    let firstAudible: number | null = null;
    const VISIBLE_FRACTION = 1e-3;
    const AUDIBLE_PEAK = 0.05;

    for (let i = 0; i < 240; i += 1) {
      await page.waitForTimeout(1000);
      const clock = await hook<{ performanceSeconds: number }>(page, 'clock');
      const vis = await hook<SummaryShape>(page, 'fieldSummary', [0.025, 0.25]);
      const pres = await hook<{ valid: boolean; occupiedFraction: number }>(page, 'presentationAnalysis');
      const out = await hook<AudioOutputShape | null>(page, 'audioOutput');
      const peak = out?.peak ?? 0;
      const t = clock.performanceSeconds;
      if (firstVisible === null && vis.occupiedFraction >= VISIBLE_FRACTION) firstVisible = t;
      if (firstAudible === null && peak > AUDIBLE_PEAK) firstAudible = t;
      rows.push(
        `${t.toFixed(1)},${vis.occupiedFraction.toExponential(3)},${vis.maxV.toFixed(3)},` +
          `${pres.valid ? pres.occupiedFraction.toExponential(3) : 'inv'},${peak.toFixed(4)}`,
      );
      if (firstAudible !== null && t > firstAudible + 6) break;
    }
    console.info('[probe] t,fieldVis0.025,maxV,presOccupancy,audioPeak');
    for (const row of rows) console.info(`[probe] ${row}`);
    console.info(`[probe] firstVisible=${firstVisible} firstAudible=${firstAudible}`);
  });
});
