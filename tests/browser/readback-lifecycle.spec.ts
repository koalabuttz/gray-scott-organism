/**
 * §7.1/AC.11 readback lifecycle (Phase 3).
 *
 * Exercises the real PBO/fence ring: it stays balanced over many samples (no per-sample buffer growth,
 * no stale drops), a `WAIT_FAILED` fence drops the sample and recycles its slot so the ring keeps
 * working, and a field replacement while a fence is pending drops the pending work cleanly.
 *
 * Note: a full `WEBGL_lose_context` cleanup path is **not** implemented in the app (there is no
 * context-loss handler — a Phase-4 item), so this spec covers the drop/cleanup the analyzer does own
 * rather than claiming context-loss recovery it cannot exercise.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';

interface RingProbeShape {
  iterations: number;
  requests: number;
  samples: number;
  buffersBefore: number;
  buffersAfter: number;
  diagnostics: {
    floatFormat: 'RGBA32F' | 'RGBA16F';
    requests: number;
    samples: number;
    staleDrops: number;
    nullFenceDrops: number;
    packSaturatedSamples: number;
    packSaturated: boolean;
  };
}

test.describe('§7.1 readback lifecycle (AC.11)', () => {
  test('the PBO/fence ring stays balanced over many samples', async ({ page }) => {
    test.setTimeout(120_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 8 }]);
    await hook(page, 'simulate', [200]);

    const run = await hook<RingProbeShape>(page, 'analyzerRingProbe', [40]);
    console.info(
      `[readback] ring: requests=${run.requests} samples=${run.samples} buffers ${run.buffersBefore} -> ${run.buffersAfter} ` +
        `format=${run.diagnostics.floatFormat}`,
    );
    expect(run.requests, 'the ring accepted requests').toBeGreaterThan(0);
    expect(run.samples, 'every accepted request completed').toBe(run.requests);
    expect(run.buffersAfter, 'no per-sample buffer growth').toBe(run.buffersBefore);
    expect(run.diagnostics.staleDrops, 'no stale drops in a steady run').toBe(0);
  });

  test('a WAIT_FAILED fence drops the sample and recycles the slot', async ({ page }) => {
    test.setTimeout(120_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 8 }]);
    await hook(page, 'simulate', [120]);

    // Force every fence wait to fail: the completed sample must be dropped, never reported.
    await hook(page, 'analyzerSimulateWaitFailed', [true]);
    const dropped = await hook<RingProbeShape>(page, 'analyzerRingProbe', [1]);
    expect(dropped.samples, 'a WAIT_FAILED fence never yields a sample').toBe(0);
    expect(dropped.requests, 'the request was still accepted').toBeGreaterThan(0);

    // Clear the injection: the ring must still work (the slot was recycled, not leaked).
    await hook(page, 'analyzerSimulateWaitFailed', [false]);
    const recovered = await hook<RingProbeShape>(page, 'analyzerRingProbe', [5]);
    expect(recovered.samples, 'the ring recovers after the injection').toBe(recovered.requests);
    expect(recovered.buffersAfter).toBe(recovered.buffersBefore);
  });

  test('a field replacement while work is pending drops it and keeps the ring balanced', async ({ page }) => {
    test.setTimeout(120_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 8 }]);
    await hook(page, 'simulate', [120]);

    // Leave a fence pending, then replace the field (bumps the epoch and resets the analyzer).
    expect(await hook<boolean>(page, 'requestAnalysisOnly'), 'a request is accepted').toBe(true);
    await hook(page, 'reset');

    const after = await hook<RingProbeShape>(page, 'analyzerRingProbe', [6]);
    expect(after.samples, 'the ring works after the replacement dropped the pending work').toBe(after.requests);
    expect(after.buffersAfter).toBe(after.buffersBefore);
  });
});
