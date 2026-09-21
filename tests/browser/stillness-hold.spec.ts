/**
 * AC.8 — integrated stillness reachability with the **real** audio silence handshake (Phase 3B).
 *
 * Drives the *actual* pipeline to the stillness gate and proves the audio acknowledgement end to end:
 * a real gesture unlocks audio, `kill-wait` entry issues `prepareSilence()`, the terminally bounded
 * fade drives the master gain to **digital zero**, the curator's silence-gate opens only then, the
 * concealed black-hold holds ≥ 20 performance seconds at near-black luminance, and an arc increment
 * rebirths. The acknowledgement is then re-armed (`satisfied` false again), so a second stillness would
 * need its own fade — the browser half of the episode-scoped re-arm case.
 *
 * Unlike the Phase-2 version this is no longer the *bypass*: `CuratorEnvironment.silence` now carries
 * the live `silenceStatus()`. If this machine cannot start an audio device the test skips with that
 * diagnostic rather than asserting sound it cannot produce (the offline suite covers the graph headless).
 *
 * Gated behind `STILLNESS=1` (run: `STILLNESS=1 npm run test:browser -- stillness-hold.spec.ts`)
 * because it is a long-form run. The unit-level half of AC.8 lives in `curator.test.ts`.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { AudioStatsShape, AudioStatusShape, ImageStatsShape, SilenceStatusShape } from '../support/types.ts';

const ENABLED = process.env['STILLNESS'] === '1';
/** Dormancy -> nucleation is at most 30 perf s * 1.25 * 120 steps/s; 16 skips reach stillness. */
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

test.describe('AC.8 stillness with the real audio silence handshake', () => {
  test.skip(!ENABLED, 'set STILLNESS=1 to run the long-form stillness reachability spec');

  test('kill-wait fades audio to terminal zero, black-hold runs, and the next arc re-arms', async ({ page }) => {
    test.setTimeout(300_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    // §2.3: unlock audio with a real gesture so `silenceStatus()` must observe a *real* terminal zero
    // (a suspended context would take the locked bypass instead).
    await page.locator('#stage').click();
    await page.waitForTimeout(400);
    const audio = await hook<AudioStatusShape>(page, 'audioStatus');
    console.info(`[stillness] audio status after gesture: ${JSON.stringify(audio)}`);
    test.skip(
      audio.status !== 'running',
      `this machine did not start an audio device (status=${audio.status}); the active-audio hold ` +
        'cannot be exercised — the offline suite covers the graph headless',
    );

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
    await page.waitForTimeout(400);
    await hook(page, 'reset');

    // The override fade begins on kill-wait entry: the acknowledgement is not yet satisfied.
    const early = await hook<SilenceStatusShape>(page, 'silenceStatus');
    console.info(`[stillness] silence at kill-wait entry: ${JSON.stringify(early)}`);

    // Assert the fade reaches terminal zero while still in kill-wait (before the hold opens).
    await expect
      .poll(async () => (await hook<SilenceStatusShape>(page, 'silenceStatus')).satisfied, {
        timeout: 90_000,
        intervals: [250],
      })
      .toBe(true);
    const terminal = await hook<SilenceStatusShape>(page, 'silenceStatus');
    expect(terminal.terminalZeroAt, 'a real terminal-zero timestamp was recorded').not.toBeNull();

    // kill-wait -> black-hold once the chemistry condition is confirmed and silence is satisfied.
    await expect
      .poll(async () => (await hook<CuratorStateShape>(page, 'curatorState')).stillState, {
        timeout: 120_000,
        intervals: [200],
      })
      .toBe('black-hold');
    const atHold = await hook<CuratorStateShape>(page, 'curatorState');
    expect(atHold.timeline.blackHoldStartedAt, 'the black-hold entry is timestamped').not.toBeNull();
    expect(atHold.timeline.audioZeroAt, 'the audio zero was acknowledged by the curator').not.toBeNull();
    expect(
      atHold.timeline.audioZeroAt!,
      'audio reached zero no later than the black-hold began',
    ).toBeLessThanOrEqual(atHold.timeline.blackHoldStartedAt! + 1.5);

    // Sample the composite while the hold runs: the performance-paced fade must reach near-black, and
    // the instrumented master gain must be at exact digital zero throughout.
    let darkestMax = 255;
    let darkestMean = 255;
    let masterAtZero = true;
    let samples = 0;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = await hook<CuratorStateShape>(page, 'curatorState');
      if (s.arc >= 1 || s.stillState !== 'black-hold') break;
      const stats = await hook<ImageStatsShape>(page, 'compositeStats');
      const audioStats = await hook<AudioStatsShape>(page, 'audioStats');
      darkestMax = Math.min(darkestMax, stats.max);
      darkestMean = Math.min(darkestMean, stats.mean);
      if (audioStats && audioStats.masterGain !== 0) masterAtZero = false;
      samples += 1;
      await page.waitForTimeout(120);
    }
    expect(samples, 'the hold was sampled').toBeGreaterThan(0);
    expect(masterAtZero, 'the instrumented master gain is at exact digital zero during the hold').toBe(true);

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
        `mean=${darkestMean.toFixed(3)} over ${samples} samples; arc=${after.arc}; ` +
        `audioZeroAt=${after.timeline.audioZeroAt}`,
    );
    expect(
      after.timeline.chemistryConfirmedAt!,
      'chemistry was confirmed no later than the black-hold began',
    ).toBeLessThanOrEqual(after.timeline.blackHoldStartedAt! + 1);
    expect(holdSeconds, 'the concealed black hold lasts >= 20 performance seconds').toBeGreaterThanOrEqual(19.9);
    expect(darkestMax, 'the hold reaches near-black luminance').toBeLessThanOrEqual(8);
    expect(darkestMean).toBeLessThanOrEqual(1.5);

    // §8.3 re-arm: once stillness returns to `none` the acknowledgement is cleared, so the next
    // stillness must issue its own fade rather than reusing the stale zero.
    await expect
      .poll(async () => (await hook<CuratorStateShape>(page, 'curatorState')).stillState, {
        timeout: 20_000,
        intervals: [200],
      })
      .toBe('none');
    await page.waitForTimeout(500);
    const rearmed = await hook<SilenceStatusShape>(page, 'silenceStatus');
    console.info(`[stillness] after rebirth (re-arm): ${JSON.stringify(rearmed)}`);
    expect(rearmed.satisfied, 'the episode was re-armed: a fresh acknowledgement is required').toBe(false);

    // WebAudio creates no <audio> elements; the soundtrack is not a media tag.
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
