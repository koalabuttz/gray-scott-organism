/**
 * §10/§12.2 laboratory composition controls and reviewer-round-3 fixes (default suite).
 *
 * These specs drive the real laboratory DOM (the panel only exists while it is open) against the live
 * GPU app and assert the composition readouts/controls that the Phase-2 lab layer adds:
 *
 *   - the movement/arc readout shows the running composition after boot;
 *   - the §4.4 genesis selector reseeds a viable pattern through the ordinary `reseed` command;
 *   - a malformed trajectory import is rejected visibly and leaves the running piece intact;
 *   - export → import is an identity round-trip (through a real download);
 *   - skipping a movement advances the composition without a chemistry reset.
 *
 * Fix A (trajectory provenance in the lab snapshot/status) and Fix B (manual-mode camera release)
 * have their own cases here too. Presentation purity (AC.15) is asserted in `smoke.spec.ts` and stays
 * green: everything below is lab-DOM only and removed on close.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CAMERA } from '../../src/config.ts';
import { hook, openArtwork } from '../support/browser.ts';
import type {
  LabSnapshotShape,
  PhaseShape,
  PublishedStateShape,
  SummaryShape,
  TrajectoryInfoShape,
} from '../support/types.ts';

const MATURE_PARAMETERS = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };

test.describe('§10 laboratory composition controls', () => {
  test('the lab shows the running movement and composition readouts after boot', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    // Movement/arc readout: populated and shaped like `movement <id> · arc <n> · progress …`.
    const movement = page.locator('.lab-movement');
    await expect(movement).toContainText('movement');
    await expect(movement).toContainText('arc');
    await expect(movement).toContainText('intention');
    await expect(movement).toContainText('stillness');

    // The composition controls are present: skip/restart, the seven §4.4 genesis kinds, and the
    // trajectory + chemistry readouts.
    await expect(page.getByRole('button', { name: 'skip movement' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'restart arc' })).toHaveCount(1);
    await expect(page.locator('[data-genesis-kind]')).toHaveCount(7);
    await expect(page.locator('.lab-trajectory-input')).toHaveCount(1);
    await expect(page.locator('.lab-trajectory')).toContainText('trajectory');
    await expect(page.locator('.lab-chem')).toContainText('chemistry occupied');

    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.phase.movement.length).toBeGreaterThan(0);
    expect(snapshot.phase.arc).toBe(0);
    expect(['none', 'kill-wait', 'black-hold']).toContain(snapshot.phase.stillnessState);
    expect(snapshot.trajectory.id.length).toBeGreaterThan(0);
    expect(snapshot.trajectory.movements.length).toBeGreaterThan(0);
  });

  test('the genesis selector applies a viable seed (epoch bump, occupancy grows)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Phase-1 manual path so the curator cannot overwrite the reseeded chemistry between steps.
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'setParameters', [MATURE_PARAMETERS]);
    await hook(page, 'reset');

    const before = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(before.phase.arc).toBe(0);

    await page.keyboard.press('Backquote');
    await page.locator('[data-genesis-kind="single"]').click();

    const after = await hook<LabSnapshotShape>(page, 'labSnapshot');
    // A `replace` genesis bumps the field epoch.
    expect(after.epoch).toBeGreaterThan(before.epoch);

    await hook(page, 'simulate', [2000]);
    const stats = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
    console.info(`[lab] genesis 'single' occupancy after 2000 steps: ${stats.occupiedFraction.toFixed(4)}`);
    expect(stats.occupiedFraction).toBeGreaterThan(0.005);
  });

  test('a malformed trajectory import is rejected visibly and leaves the piece running', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    const before = await hook<LabSnapshotShape>(page, 'labSnapshot');
    const stepsBefore = before.steps;

    await page.locator('.lab-trajectory-input').fill('{ "version": 1, not valid json');
    await page.getByRole('button', { name: 'import (validated JSON)' }).click();

    await expect(page.locator('.lab-trajectory')).toContainText('import failed');
    // The active document is unchanged and the transport keeps delivering steps.
    const after = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(after.trajectory.id).toBe(before.trajectory.id);
    expect(after.trajectory.source).toBe(before.trajectory.source);
    await page.waitForTimeout(1500);
    const later = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(later.steps).toBeGreaterThan(stepsBefore);
  });

  test('export → import round-trip is identity (through a real download)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    const original = await hook<string>(page, 'exportTrajectory');
    expect(original.length).toBeGreaterThan(0);

    // The export button produces a real download whose bytes are the active document.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'export document' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const downloaded = readFileSync(downloadPath as string, 'utf8');
    expect(downloaded).toBe(original);

    // Importing the exported text through the lab DOM reparses to the same document and leaves the
    // composition an identity round-trip.
    await page.locator('.lab-trajectory-input').fill(original);
    await page.getByRole('button', { name: 'import (validated JSON)' }).click();
    await expect(page.locator('.lab-trajectory')).toContainText('import ok');

    const afterImport = await hook<TrajectoryInfoShape>(page, 'trajectoryInfo');
    expect(afterImport.source).toBe('imported');
    expect(await hook<string>(page, 'exportTrajectory')).toBe(original);
  });

  test('skipping a movement advances the composition without a chemistry reset', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Pause and walk the automatic composition out of dormancy deterministically, in 500-step
    // increments, so the state between hook calls cannot drift.
    await hook(page, 'setPaused', [true]);
    await expect
      .poll(
        async () =>
          (await hook<{ phase: PhaseShape }>(page, 'advanceComposition', [500])).phase.movement,
        { timeout: 120_000, intervals: [200] },
      )
      .not.toBe('dormancy');

    const before = await hook<{ movement: string }>(page, 'curatorState');
    const beforeEpoch = await hook<number>(page, 'epoch');

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'skip movement' }).click();

    // Read the *live* curator movement, not the app's published phase: the transport is paused, so no
    // delivered step republishes `phase`, but the skip acts on the curator immediately.
    const after = await hook<{ movement: string }>(page, 'curatorState');
    console.info(
      `[lab] skip: ${before.movement} -> ${after.movement} (epoch ${beforeEpoch} -> ${await hook<number>(page, 'epoch')})`,
    );
    expect(after.movement).not.toBe(before.movement);
    // Skip crossfades parameters; it must not reset the chemistry (no `replace` genesis on the way in).
    expect(await hook<number>(page, 'epoch')).toBe(beforeEpoch);
  });
});

test.describe('Fix A: trajectory provenance surfaced in the laboratory', () => {
  test('a failed bootstrap is visible in the lab status with source bundled', async ({ page }) => {
    await page.route('**/trajectories/default.json', (route) => route.abort());

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // The background bootstrap is asynchronous: wait until the failure has been recorded.
    await expect
      .poll(async () => (await hook<TrajectoryInfoShape>(page, 'trajectoryInfo')).error, { timeout: 20_000 })
      .not.toBeNull();

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    const status = page.locator('.lab-trajectory');
    await expect(status).toContainText('trajectory bundled');
    await expect(status).toContainText('trajectory fetch failed');

    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.trajectory.source).toBe('bundled');
    expect(snapshot.trajectory.error).not.toBeNull();
    expect(snapshot.trajectory.id.length).toBeGreaterThan(0);
  });

  test('a successful bootstrap clears the error and the lab status shows fetched', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await expect
      .poll(async () => (await hook<TrajectoryInfoShape>(page, 'trajectoryInfo')).source, { timeout: 30_000 })
      .toBe('fetched');

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    const status = page.locator('.lab-trajectory');
    await expect(status).toContainText('trajectory fetched');
    await expect(status).not.toContainText('fetch failed');

    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.trajectory.source).toBe('fetched');
    expect(snapshot.trajectory.error).toBeNull();
  });
});

test.describe('Fix B: manual-mode camera release restores the calibrated camera', () => {
  test('releasing a grazing override with composition off returns to the overhead camera', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Phase-1 manual path (the gate's path): automatic composition off, transport paused — the only
    // thing that would move the camera is the laboratory override itself.
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    const calibrated = await hook<PublishedStateShape>(page, 'publishedState');
    expect(calibrated.camera.elevationRadians).toBeCloseTo(CAMERA.elevationRadians, 6);
    expect(calibrated.camera.mode).toBe('overhead');

    // The gate's documented grazing override.
    await hook(page, 'dispatch', [
      {
        type: 'camera',
        value: { mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.5, 0.5], transitionSeconds: 0 },
      },
    ]);
    await expect
      .poll(async () => (await hook<PublishedStateShape>(page, 'publishedState')).camera.elevationRadians, {
        timeout: 5_000,
        intervals: [100],
      })
      .toBeCloseTo(0.21, 6);
    const grazing = await hook<PublishedStateShape>(page, 'publishedState');
    expect(grazing.camera.distance).toBeCloseTo(1.75, 6);

    // Release: with composition OFF nothing runs `derive`, so the camera must be restored explicitly.
    await hook(page, 'dispatch', [{ type: 'camera', value: null }]);
    await expect
      .poll(async () => (await hook<PublishedStateShape>(page, 'publishedState')).camera.mode, {
        timeout: 5_000,
        intervals: [100],
      })
      .toBe('overhead');
    const released = await hook<PublishedStateShape>(page, 'publishedState');
    expect(released.camera.elevationRadians).toBeCloseTo(CAMERA.elevationRadians, 6);
    expect(released.camera.distance).toBeCloseTo(calibrated.camera.distance, 6);
    expect(await hook<{ camera: boolean; light: boolean }>(page, 'cameraPins')).toEqual({
      camera: false,
      light: false,
    });
  });
});
