/**
 * §10 bounded exploration mode (deviation 34).
 *
 * Exploration mode is a **lab-only** affordance: it switches the simulation to the coarser 512² grid,
 * which delivers more numerical steps per frame and therefore supports a higher measured speed
 * ceiling. It is off by default, it restarts the organism in both directions, and it must never touch
 * presentation purity — AC.15 and the "laboratory leaves no DOM behind" assertions live in
 * `smoke.spec.ts` and still pass unchanged.
 *
 * This spec also covers the parts that only a browser can: that the *renderer's* simulation-sized
 * intermediates follow the switch (read from the live GL target), that repeated switches do not leak
 * GL objects, and that the higher 512² speed is accepted through the real command path (`dispatch` →
 * `validateCommand`) while the same request is rejected at 768².
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import { TIME } from '../../src/config.ts';
import type { FieldStatsShape, LabSnapshotShape } from '../support/types.ts';

const CYCLES = 6;

test.describe('§10 exploration mode', () => {
  test('is off by default, restarts on every switch, and cycles without leaking', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A failed resolution switch (bad FBO, stale program, GL error) must surface rather than pass.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    // ---- default: presentation grid, exploration off, presentation ceiling ----
    const before = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(before.explorationActive).toBe(false);
    expect(before.simulationResolution).toBe(768);
    expect(before.speedCeiling).toBe(6);
    expect(await hook<{ width: number; height: number }>(page, 'simulationSize')).toEqual({
      width: 768,
      height: 768,
    });
    expect(await hook<{ width: number; height: number }>(page, 'rendererSimulationSize')).toEqual({
      width: 768,
      height: 768,
    });

    // Establish a field so the restart is observable, with the transport paused so the clock cannot
    // advance steps between a toggle and the snapshot (the restart assertions must be deterministic).
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 6 }]);
    await hook(page, 'simulate', [400]);
    const established = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(established.steps).toBeGreaterThan(0);
    expect(established.simulationTime).toBeGreaterThan(0);
    expect(established.paused).toBe(true);

    // ---- the 512² speed is rejected at 768² through the real command path ----
    const rejected = await hook<{ ok: boolean; reason?: string }>(page, 'dispatch', [
      { type: 'speed', value: 12 },
    ]);
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain('speed must be within');
    // Unchanged: the clock keeps whatever the presentation default is (3× since deviation 44), so a
    // rejected command never mutates the live speed.
    expect((await hook<{ speed: number }>(page, 'clock')).speed).toBe(TIME.defaultSpeed);

    // ---- toggle ON: 512², higher ceiling, organism restarted ----
    await hook(page, 'setExploration', [true]);
    const during = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(during.explorationActive).toBe(true);
    expect(during.simulationResolution).toBe(512);
    expect(during.speedCeiling).toBe(12);
    expect(during.speedRange).toEqual([0.25, 12]);
    expect(await hook<{ width: number; height: number }>(page, 'simulationSize')).toEqual({
      width: 512,
      height: 512,
    });
    // The renderer's derived-field targets followed the switch (read from the live GL target).
    expect(await hook<{ width: number; height: number }>(page, 'rendererSimulationSize')).toEqual({
      width: 512,
      height: 512,
    });
    // The organism restarted: field replaced (epoch bumped) and reset (zero steps/time); paused kept.
    expect(during.simulationTime).toBe(0);
    expect(during.steps).toBe(0);
    expect(during.paused).toBe(true);
    expect(during.epoch).toBeGreaterThan(established.epoch);

    // ---- and the same 12× request is accepted at 512², through the command path ----
    const accepted = await hook<{ ok: boolean; reason?: string }>(page, 'dispatch', [
      { type: 'speed', value: 12 },
    ]);
    expect(accepted.ok, accepted.reason).toBe(true);
    expect((await hook<{ speed: number }>(page, 'clock')).speed).toBe(12);
    // The 512² cap is real: 12x at 60 fps is 24 steps/frame, and the clock accepts that burst.
    await hook(page, 'setPaused', [true]);

    // The panel names the active grid.
    await page.keyboard.press('Backquote');
    await expect(page.locator('.lab-resolution')).toContainText('512²');
    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(0);

    // ---- toggle OFF: presentation grid restored, also restarting, speed clamped back ----
    await hook(page, 'setExploration', [false]);
    const after = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(after.explorationActive).toBe(false);
    expect(after.simulationResolution).toBe(768);
    expect(after.speedCeiling).toBe(6);
    expect(after.speedRange).toEqual([0.25, 6]);
    expect(after.speed).toBe(6); // 12x clamped into the presentation range
    expect(after.simulationTime).toBe(0);
    expect(after.steps).toBe(0);
    expect(after.paused).toBe(true);
    expect(after.epoch).toBeGreaterThan(during.epoch);
    expect(await hook<{ width: number; height: number }>(page, 'rendererSimulationSize')).toEqual({
      width: 768,
      height: 768,
    });

    // ---- repeated switches must not leak GL objects ----
    // Each switch disposes a Simulation (its ping-pong textures, framebuffers, programs and quad) and
    // releases/re-creates the renderer's five simulation-sized targets, so after every full cycle the
    // app's own tracker must be back at exactly the same counts.
    const baseline = (await hook<LabSnapshotShape>(page, 'labSnapshot')).resourceCounts;
    expect(baseline.textures).toBeGreaterThan(0);
    const seen: string[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await hook(page, 'setExploration', [true]);
      expect(await hook<{ width: number; height: number }>(page, 'rendererSimulationSize')).toEqual({
        width: 512,
        height: 512,
      });
      // A render plus a read after every switch: a stale or wrongly sized target would fail here.
      await hook(page, 'renderOnce');
      const exploringStats = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
      expect(Number.isFinite(exploringStats.occupiedFraction)).toBe(true);

      await hook(page, 'setExploration', [false]);
      expect(await hook<{ width: number; height: number }>(page, 'rendererSimulationSize')).toEqual({
        width: 768,
        height: 768,
      });
      await hook(page, 'renderOnce');
      const presentingStats = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
      expect(Number.isFinite(presentingStats.occupiedFraction)).toBe(true);

      const counts = (await hook<LabSnapshotShape>(page, 'labSnapshot')).resourceCounts;
      seen.push(JSON.stringify(counts));
      expect(counts, `GL resource counts drifted on cycle ${cycle + 1}`).toEqual(baseline);
    }
    // Every cycle ended at the same counts (belt and braces on the per-cycle assertion above).
    expect(new Set(seen).size).toBe(1);

    // No page or console errors from any of the switches, renders or reads.
    expect(errors).toEqual([]);

    // Presentation purity is untouched by any of this: still exactly one canvas child.
    expect(await page.evaluate(() => document.body.children.length)).toBe(1);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
  });
});
