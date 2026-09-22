/**
 * AC.15 presentation purity, §2.3 activation and cursor behaviour, and the two browser
 * behaviours of §4.1 that Phase 1 already implements (pause without backlog, truthful status).
 */
import { expect, test } from '@playwright/test';
import { openArtwork, hook, sleep } from '../support/browser.ts';
import { TIME } from '../../src/config.ts';
import type { LabSnapshotShape } from '../support/types.ts';

test.describe('presentation purity and startup', () => {
  test('AC.15 presentation mode contains no UI nodes and no visible text', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.waitForTimeout(2000);
    const dom = await page.evaluate(() => ({
      bodyChildren: Array.from(document.body.children).map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: element.className,
      })),
      laboratoryNodes: document.querySelectorAll('[data-role="laboratory"], [data-role="lab-control"]').length,
      visibleText: (document.body.innerText ?? '').replace(/\s+/g, '').length,
      canvasCount: document.querySelectorAll('canvas').length,
      // Any element that could present UI: nothing may exist outside the canvas.
      uiCandidates: Array.from(
        document.querySelectorAll('div, span, p, button, input, label, pre, h1, h2, h3, a, form, select, textarea'),
      ).length,
    }));

    console.info(`[AC.15] presentation DOM: ${JSON.stringify(dom)}`);
    expect(dom.canvasCount).toBe(1);
    expect(dom.laboratoryNodes).toBe(0);
    expect(dom.uiCandidates).toBe(0);
    expect(dom.visibleText).toBe(0);
    expect(dom.bodyChildren).toHaveLength(1);
    expect(dom.bodyChildren[0]!.tag).toBe('canvas');
    expect(dom.bodyChildren[0]!.id).toBe('stage');
  });

  test('AC.15 the cursor hides after 3 s of stillness and returns on movement', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.mouse.move(320, 240);
    await expect
      .poll(async () => hook<boolean>(page, 'cursorIdle'), { timeout: 5_000, intervals: [200] })
      .toBe(false);

    // The idle class must appear without any further input; poll rather than sleep a fixed
    // interval so a stray window-manager event cannot make the assertion flaky.
    await expect
      .poll(async () => hook<boolean>(page, 'cursorIdle'), { timeout: 8_000, intervals: [250] })
      .toBe(true);

    await page.mouse.move(340, 260);
    await expect
      .poll(async () => hook<boolean>(page, 'cursorIdle'), { timeout: 5_000, intervals: [200] })
      .toBe(false);
  });

  test('laboratory opens only behind the backquote key and leaves no DOM behind', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(0);
    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);
    expect(await hook<boolean>(page, 'labOpen')).toBe(true);
    // The laboratory is a normal DOM panel above the canvas, never drawn into the frame.
    const controls = await page.locator('[data-role="lab-control"]').count();
    console.info(`[smoke] laboratory controls: ${controls}`);
    expect(controls).toBeGreaterThan(5);

    // §10 labelling: each parameter names its meaning, the panel explains the model, and the
    // approximate regime + tempo readouts are present and populated.
    const labels = await page.locator('.lab-row label').allTextContents();
    for (const meaning of ['feed rate', 'kill rate', 'U diffusion', 'V diffusion']) {
      expect(labels.some((label) => label.includes(meaning)), `parameter label for ${meaning}`).toBe(true);
    }
    const regimeText = (await page.locator('.lab-regime').textContent()) ?? '';
    const tempoText = (await page.locator('.lab-tempo').textContent()) ?? '';
    console.info(`[smoke] lab regime: "${regimeText}" | tempo: "${tempoText}"`);
    expect(regimeText).toContain('approximate regime:');
    expect(tempoText).toContain('sim tempo:');
    expect(tempoText).toContain('steps/s');
    expect(await page.locator('.lab-help').count()).toBeGreaterThan(0);

    // ...and it does not replace the canvas.
    await expect(page.locator('#stage')).toHaveCount(1);

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(0);
    expect(await hook<boolean>(page, 'labOpen')).toBe(false);
    const bodyChildren = await page.evaluate(() => document.body.children.length);
    expect(bodyChildren).toBe(1);
  });

  test('the loop runs, delivers simulation steps, and raises no page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Poll for the loop rather than a single fixed-interval read: the loop delivering steps is the
    // thing under test, so wait for it to have delivered at least one step instead of assuming 5 s of
    // wall time guarantees it (a reload mid-test previously made this a single undefined read).
    let clock!: { steps: number; performanceSeconds: number };
    await expect
      .poll(
        async () => {
          clock = await hook<{ steps: number; performanceSeconds: number }>(page, 'clock');
          return clock?.steps ?? 0;
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBeGreaterThan(0);
    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    console.info(
      `[smoke] loop running: steps=${clock.steps} performanceSeconds=${clock.performanceSeconds.toFixed(2)} ` +
        `scene=${snapshot.scene} renderer=${snapshot.rendererInfo}`,
    );

    expect(clock.steps).toBeGreaterThan(0);
    expect(snapshot.scene).toMatch(/^\d+x\d+$/);
    expect(await hook<number>(page, 'feedbackViolations')).toBe(0);
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('pause suspends transport and resumes without a catch-up burst', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.waitForTimeout(1500);
    await hook(page, 'dispatch', [{ type: 'pause', value: true }]);
    const paused = await hook<{ steps: number }>(page, 'clock');
    await sleep(2000);
    const stillPaused = await hook<{ steps: number }>(page, 'clock');
    expect(stillPaused.steps - paused.steps).toBeLessThanOrEqual(2);

    await hook(page, 'dispatch', [{ type: 'pause', value: false }]);
    await sleep(500);
    const resumed = await hook<{ steps: number; paused: boolean }>(page, 'clock');
    console.info(`[smoke] resume after 2 s paused: +${resumed.steps - stillPaused.steps} steps`);
    expect(resumed.paused).toBe(false);
    // Two seconds paused at the current speed would be `2 * speed * 120` steps of debt; the clock must
    // not replay it. The sample window is 0.5 s, so normal delivery is `speed * 120 / 2`; the bound is
    // one full second of nominal work at the presentation default speed (deviation 44 — 3×), which is
    // twice the expected 0.5 s delivery and still far below a debt replay.
    const oneSecondOfWork = TIME.nominalStepsPerSecond * TIME.defaultSpeed;
    expect(resumed.steps - stillPaused.steps).toBeLessThan(oneSecondOfWork);
    expect(resumed.steps - stillPaused.steps).toBeGreaterThan(0);
  });

  test('the activation gesture is reported truthfully', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const before = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(before.activation).toContain('not activated');
    // §2.3: audio exists but is suspended before the gesture (truthfully reported, not faked).
    expect(before.audio.status).toBe('suspended');
    expect(before.audio.unlocked).toBe(false);
    expect(before.audio.available).toBe(true);

    await page.locator('#stage').click();
    await page.waitForTimeout(1200);
    const after = await hook<LabSnapshotShape>(page, 'labSnapshot');
    console.info(`[smoke] activation status: ${after.activation}`);
    // Whatever the browser decided, the report must be explicit and must name the real audio state.
    expect(after.activation).toContain('audio: ');
    expect(after.activation.length).toBeGreaterThan(20);
    expect(['running', 'suspended', 'unavailable', 'unlocked']).toContain(after.audio.status);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  });
});
