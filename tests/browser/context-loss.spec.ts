/**
 * §11.3 recovery / AC.11 + AC.13: WebGL context loss and restoration.
 *
 * Forces a real context loss through the `WEBGL_lose_context` extension and drives the whole
 * recovery path:
 *  - on loss the piece must `preventDefault()` (so restoration is possible), stop GPU work, mute the
 *    audio and discard pending analysis — with no page errors and the presentation DOM intact;
 *  - on restore **every** GL resource must be recreated through the construction paths (the shared
 *    resource tracker returns to exactly the pre-loss counts, so nothing leaked and nothing was
 *    reused), and the piece must resume as a running simulation on a quiet new arc (monotonic epoch,
 *    steps advancing again, audio restored to the operator's mute preference).
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { LabSnapshotShape } from '../support/types.ts';

interface ClockShape {
  performanceSeconds: number;
  steps: number;
  paused: boolean;
  speed: number;
}

interface AudioStatusShape {
  status: string;
  unlocked: boolean;
  /** The effective mute gate: operator preference OR the transient context-loss forced mute. */
  muted: boolean;
  /** The operator's own mute preference, ignoring any forced gate. */
  mutePreference: boolean;
  available: boolean;
}

interface ResourceCountsShape {
  textures: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
  shaders: number;
  vertexArrays: number;
  buffers: number;
}

const LOSE_CONTEXT = 'WEBGL_lose_context';

test.describe('§11.3 WebGL context loss and restoration', () => {
  test('a forced loss stops GPU work and mutes audio; restoration rebuilds every GL resource and resumes', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Unlock audio with the real gesture so the mute-on-loss assertion is meaningful (an unavailable
    // context would report muted anyway, and would not exercise the running→muted transition).
    await page.locator('#stage').click();
    await page.waitForTimeout(2500);

    // Grab the loss extension from the *same* context the app created. Stored on `window` so the
    // restore call can use the identical extension object after the loss.
    const extensionPresent = await page.evaluate((name) => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
      const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      const extension = gl?.getExtension(name) ?? null;
      (window as unknown as { __contextLossExt?: unknown }).__contextLossExt = extension;
      return Boolean(extension);
    }, LOSE_CONTEXT);
    test.skip(!extensionPresent, `${LOSE_CONTEXT} is unavailable in this browser`);
    if (!extensionPresent) return;

    const countsBefore = await hook<ResourceCountsShape>(page, 'resourceCounts');
    const clockBefore = await hook<ClockShape>(page, 'clock');
    const epochBefore = await hook<number>(page, 'epoch');
    const audioBefore = await hook<AudioStatusShape>(page, 'audioStatus');
    console.info(
      `[context-loss] before: steps=${clockBefore.steps} epoch=${epochBefore} ` +
        `counts=${JSON.stringify(countsBefore)} audio=${JSON.stringify(audioBefore)}`,
    );
    expect(clockBefore.steps, 'the loop delivered steps before the loss').toBeGreaterThan(0);
    expect(audioBefore.muted, 'audio starts unmuted (the operator has not muted it)').toBe(false);

    // --- force the loss -------------------------------------------------
    await page.evaluate(() => {
      (window as unknown as { __contextLossExt: { loseContext(): void } }).__contextLossExt.loseContext();
    });
    await expect
      .poll(async () => hook<boolean>(page, 'contextLost'), { timeout: 15_000, intervals: [100] })
      .toBe(true);
    expect(await hook<number>(page, 'contextLossCount')).toBeGreaterThanOrEqual(1);

    // Audio is muted, GPU work has stopped (steps frozen), and the UI is untouched.
    const audioLost = await hook<AudioStatusShape>(page, 'audioStatus');
    expect(audioLost.muted, 'audio is muted while the context is lost').toBe(true);

    const stepsAtLoss = (await hook<ClockShape>(page, 'clock')).steps;
    await page.waitForTimeout(1000);
    const stepsStillLost = (await hook<ClockShape>(page, 'clock')).steps;
    expect(stepsStillLost, 'no simulated steps are delivered while the context is lost').toBe(stepsAtLoss);

    const domIntact = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      bodyChildren: document.body.children.length,
      hasErrorOverlay: document.querySelector('.artwork-error') !== null,
    }));
    expect(domIntact.canvases, 'the presentation canvas is still present').toBe(1);
    expect(domIntact.hasErrorOverlay, 'no fatal error overlay was shown').toBe(false);
    expect(domIntact.bodyChildren, 'presentation purity is preserved through the loss').toBe(1);

    // --- force the restoration ------------------------------------------
    await page.evaluate(() => {
      (window as unknown as { __contextLossExt: { restoreContext(): void } }).__contextLossExt.restoreContext();
    });
    await expect
      .poll(async () => hook<boolean>(page, 'contextLost'), { timeout: 30_000, intervals: [100] })
      .toBe(false);

    // The simulation is running again on a **fresh** arc.
    await expect
      .poll(async () => (await hook<ClockShape>(page, 'clock')).steps, { timeout: 20_000, intervals: [200] })
      .toBeGreaterThan(stepsStillLost);

    const epochAfter = await hook<number>(page, 'epoch');
    const countsAfter = await hook<ResourceCountsShape>(page, 'resourceCounts');
    const audioAfter = await hook<AudioStatusShape>(page, 'audioStatus');
    console.info(
      `[context-loss] after: epoch=${epochAfter} counts=${JSON.stringify(countsAfter)} ` +
        `audio=${JSON.stringify(audioAfter)}`,
    );

    expect(epochAfter, 'restoration begins a new field epoch (a quiet new arc)').toBeGreaterThan(epochBefore);
    // Every GL resource was recreated through the ordinary construction paths, so the tracker returns
    // to exactly the pre-loss counts: nothing leaked and no stale object survived.
    expect(countsAfter, 'the rebuilt GL resource set matches the pre-loss set (no leak)').toEqual(countsBefore);
    for (const [name, value] of Object.entries(countsAfter)) {
      expect(value, `${name} count is not negative after the rebuild`).toBeGreaterThanOrEqual(0);
    }
    // The mute-on-loss is not sticky: the operator's own mute preference is restored.
    expect(audioAfter.muted, 'audio returns to the operator’s mute preference after restoration').toBe(false);

    // The laboratory still opens on the restored instance (the UI is genuinely intact).
    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);
    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.resourceCounts).toEqual(countsBefore);
    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(0);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the context-loss forced mute is independent of the operator mute preference', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.locator('#stage').click();
    await page.waitForTimeout(2000);

    const extensionPresent = await page.evaluate((name) => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
      const gl = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
      const extension = gl?.getExtension(name) ?? null;
      (window as unknown as { __contextLossExt?: unknown }).__contextLossExt = extension;
      return Boolean(extension);
    }, LOSE_CONTEXT);
    test.skip(!extensionPresent, `${LOSE_CONTEXT} is unavailable in this browser`);
    if (!extensionPresent) return;

    const status = (): Promise<AudioStatusShape> => hook<AudioStatusShape>(page, 'audioStatus');
    const lose = (): Promise<void> =>
      page.evaluate(() => {
        (window as unknown as { __contextLossExt: { loseContext(): void } }).__contextLossExt.loseContext();
      });
    const restore = (): Promise<void> =>
      page.evaluate(() => {
        (window as unknown as { __contextLossExt: { restoreContext(): void } }).__contextLossExt.restoreContext();
      });
    const expectLost = (lost: boolean): Promise<void> =>
      expect
        .poll(async () => hook<boolean>(page, 'contextLost'), { timeout: 30_000, intervals: [100] })
        .toBe(lost);

    // --- cycle 1: initially unmuted; the operator toggles on then off during the outage ---------
    await hook(page, 'setMuted', [false]);
    expect((await status()).muted, 'starts unmuted').toBe(false);
    await lose();
    await expectLost(true);
    let s = await status();
    expect(s.muted, 'the loss forces silence').toBe(true);
    expect(s.mutePreference, 'without touching the operator preference').toBe(false);

    await hook(page, 'setMuted', [true]);
    s = await status();
    expect(s.mutePreference, 'a mute during the outage updates the preference').toBe(true);
    expect(s.muted, 'but the effective gate stays forced-muted').toBe(true);
    await hook(page, 'setMuted', [false]);
    s = await status();
    expect(s.mutePreference, 'an unmute during the outage updates the preference').toBe(false);
    expect(s.muted, 'and still cannot defeat the forced silence').toBe(true);

    await restore();
    await expectLost(false);
    s = await status();
    expect(s.muted, 'restoration drops the forced gate; the latest preference (unmuted) applies').toBe(false);
    expect(s.mutePreference).toBe(false);

    // --- cycle 2: initially muted; the operator toggles off then on during the outage -----------
    await hook(page, 'setMuted', [true]);
    expect((await status()).muted, 'starts muted by preference').toBe(true);
    await lose();
    await expectLost(true);
    s = await status();
    expect(s.mutePreference).toBe(true);
    expect(s.muted, 'forced silence on top of a muted preference').toBe(true);

    await hook(page, 'setMuted', [false]);
    s = await status();
    expect(s.mutePreference, 'an unmute during the outage updates the preference').toBe(false);
    expect(s.muted, 'but the effective gate stays forced-muted').toBe(true);
    await hook(page, 'setMuted', [true]);
    s = await status();
    expect(s.mutePreference, 'a mute during the outage updates the preference').toBe(true);
    expect(s.muted).toBe(true);

    await restore();
    await expectLost(false);
    s = await status();
    expect(s.muted, 'the latest preference (muted) applies after restoration').toBe(true);
    expect(s.mutePreference).toBe(true);
  });
});
