/**
 * AC.8 Phase-2 half — integrated stillness reachability (MINOR B).
 *
 * Drives the *real* pipeline to the stillness gate and proves the silence-bypass end to end:
 * kill-wait -> concealed black-hold (>= 20 performance seconds, near-black luminance) -> concealed
 * rebirth genesis with an arc increment. Phase 2 has no audio system, so `CuratorEnvironment.silence`
 * is satisfied by construction (deviation 40) — full active-audio instrumentation stays Phase 3.
 *
 * Gated behind `STILLNESS=1` (run: `STILLNESS=1 npm run test:browser -- stillness-hold.spec.ts`)
 * because it is a long-form run. The unit-level half of AC.8 lives in `curator.test.ts`.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { ImageStatsShape } from '../support/types.ts';

const ENABLED = process.env['STILLNESS'] === '1';
/** Dormancy -> nucleation is at most 30 perf s * 1.25 * 120 steps/s; 9 skips reach stillness. */
const SKIP_LIMIT = 16;
/**
 * 2x keeps the analysis cadence comfortably inside the curator's 1.5 performance-second freshness
 * window (at 2x it is ~2 Hz performance), so the chemistry-negligible confirm does not chase the
 * freshness boundary. It is still accelerated: the 20 performance-second hold runs in ~10 real s.
 */
const SPEED = 2;

interface CuratorStateShape {
  arc: number;
  movement: string;
  stillState: string;
  rescueUsed: boolean;
  genesisOrigin: [number, number] | null;
  timeline: {
    killWaitEnteredAt: number | null;
    chemistryConfirmedAt: number | null;
    audioZeroAt: number | null;
    blackHoldStartedAt: number | null;
    blackHoldCompletedAt: number | null;
    genesisAt: number | null;
  };
}

test.describe('AC.8 Phase-2 stillness bypass', () => {
  test.skip(!ENABLED, 'set STILLNESS=1 to run the long-form stillness reachability spec');

  test('reaches a silence-bypass black-hold and rebirths into the next arc', async ({ page }) => {
    test.setTimeout(240_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    // Pause so the skip commands take the curator deterministically to the stillness gate.
    await hook(page, 'setPaused', [true]);
    let state = await hook<CuratorStateShape>(page, 'curatorState');
    for (let i = 0; i < SKIP_LIMIT && state.movement !== 'stillness'; i += 1) {
      await hook(page, 'dispatch', [{ type: 'skip-movement' }]);
      state = await hook<CuratorStateShape>(page, 'curatorState');
    }
    expect(state.movement, 'reached the stillness movement').toBe('stillness');
    expect(state.stillState, 'the stillness gate opens in kill-wait').toBe('kill-wait');
    expect(state.arc).toBe(0);

    // Run the organism. The field is made inert so the chemistry-negligible confirm is quick and the
    // hold is reached well before the 3x-dwell timeout.
    await hook(page, 'setSpeed', [SPEED]);
    await hook(page, 'setPaused', [false]);
    await page.waitForTimeout(250);
    await hook(page, 'reset');

    // kill-wait -> black-hold on the silence bypass.
    await expect
      .poll(async () => (await hook<CuratorStateShape>(page, 'curatorState')).stillState, {
        timeout: 120_000,
        intervals: [200],
      })
      .toBe('black-hold');
    const atHold = await hook<CuratorStateShape>(page, 'curatorState');
    expect(atHold.timeline.blackHoldStartedAt, 'the black-hold entry is timestamped').not.toBeNull();

    // Sample the composite while the hold runs: the performance-paced fade must reach near-black.
    let darkestMax = 255;
    let darkestMean = 255;
    let samples = 0;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const s = await hook<CuratorStateShape>(page, 'curatorState');
      if (s.arc >= 1 || s.stillState !== 'black-hold') break;
      const stats = await hook<ImageStatsShape>(page, 'compositeStats');
      darkestMax = Math.min(darkestMax, stats.max);
      darkestMean = Math.min(darkestMean, stats.mean);
      samples += 1;
      await page.waitForTimeout(120);
    }
    expect(samples, 'the hold was sampled').toBeGreaterThan(0);

    // Rebirth: arc incremented and the concealed return genesis issued.
    await expect
      .poll(async () => (await hook<CuratorStateShape>(page, 'curatorState')).arc, {
        timeout: 90_000,
        intervals: [250],
      })
      .toBeGreaterThanOrEqual(1);
    const after = await hook<CuratorStateShape>(page, 'curatorState');
    const holdSeconds = (after.timeline.genesisAt ?? 0) - (after.timeline.blackHoldStartedAt ?? 0);
    console.info(
      `[stillness] black-hold ${holdSeconds.toFixed(2)} performance s; darkest composite max=${darkestMax} ` +
        `mean=${darkestMean.toFixed(3)} over ${samples} samples; arc=${after.arc}`,
    );
    expect(holdSeconds, 'the concealed black hold lasts >= 20 performance seconds').toBeGreaterThanOrEqual(19.9);
    expect(darkestMax, 'the hold reaches near-black luminance').toBeLessThanOrEqual(8);
    expect(darkestMean).toBeLessThanOrEqual(1.5);

    // Silence bypass is intact: there is no audio system in Phase 2 (active-audio stays Phase 3).
    expect(await page.evaluate(() => document.querySelectorAll('audio').length)).toBe(0);

    // The rebirth is the 'return' entry genesis (a replace at the recorded origin), so the field
    // epoch advanced and an arc-1 origin exists.
    const log = await hook<Array<{ mode: string; kind: string; center: [number, number] }>>(page, 'genesisLog');
    const rebirth = log.filter(
      (c) => c.mode === 'replace' && Math.abs(c.center[0] - 0.61) < 0.06 && Math.abs(c.center[1] - 0.43) < 0.06,
    );
    expect(rebirth.length, 'a rebirth genesis was issued at the return origin').toBeGreaterThan(0);
    expect(after.genesisOrigin, 'arc 1 has its own genesis origin').not.toBeNull();

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
