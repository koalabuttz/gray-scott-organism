/**
 * Phase-2 integration integrity (MAJOR 1, 2, 3, 5, 7, MINOR 3, MINOR A).
 *
 * These are the reviewer's integration findings that only a live run can exercise:
 *  - restart / resolution switch must start a **fresh composition arc** (a new Curator), not reload the
 *    trajectory into the existing one;
 *  - a same-arc restart must also re-arm the **director** to the new seed's bounded light target;
 *  - the §12.2 bootstrap fetch must never gate startup (a hanging response still leaves the app running
 *    on the bundled document) and a late success must crossfade in without an epoch bump;
 *  - the analysis view handed to the curator must be refreshed after a **mid-batch** replace, so later
 *    steps in the batch do not consume a stale pre-replacement sample;
 *  - analyzer samples carry epoch provenance and stale samples are rejected; `reset(epoch)` runs on
 *    every field-replacement path;
 *  - analysis/publication cadence is scheduled on **delivered performance time** (2 Hz) with an
 *    explicit 4 Hz real-time ceiling under acceleration;
 *  - the tier-1 health reduction is exact (float through the global average), so a real shader fixture
 *    matches a CPU full-domain mean to well within one final-byte quantization step;
 *  - a `null` `fenceSync()` is a dropped request, not a success.
 */
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { hook, openArtwork } from '../support/browser.ts';
import type {
  CoarseOccupancyShape,
  EventShape,
  LabSnapshotShape,
  PhaseShape,
  PresentationShape,
  PublishedStateShape,
} from '../support/types.ts';

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

interface GenesisCommandShape {
  id: number;
  kind: string;
  mode: 'replace' | 'inject';
  seed: number;
  center: [number, number];
  radiusCells: number;
  strength: number;
}

interface CadenceShape {
  publications: number;
  analysisRequests: number;
  realSeconds: number;
  performanceSeconds: number;
}

interface AnalyzerDiagnosticsShape {
  floatFormat: 'RGBA32F' | 'RGBA16F';
  requests: number;
  samples: number;
  staleDrops: number;
  nullFenceDrops: number;
  packSaturatedSamples: number;
  packSaturated: boolean;
}

interface AnalysisSampleShape {
  epoch: number;
  occupiedFraction: number;
  flux: number;
  change: number;
  packSaturated: boolean;
}

interface FieldShape {
  width: number;
  height: number;
  u: number[];
  v: number[];
}

// Dormancy->nucleation is at most 30 perf s * max duration scale (1.25) * 120 steps/s = 4500 steps;
// the spec below advances by exact step counts well past that.

function signature(log: GenesisCommandShape[]): string[] {
  return log.map(
    (c) =>
      `${c.kind}|${c.mode}|${c.seed}|${c.center[0].toFixed(9)}|${c.center[1].toFixed(9)}|` +
      `${c.radiusCells.toFixed(9)}|${c.strength.toFixed(9)}`,
  );
}

function cpuMeans(current: FieldShape, previous: FieldShape): { occ: number; flux: number; change: number } {
  const count = current.width * current.height;
  let occ = 0;
  let flux = 0;
  let change = 0;
  for (let i = 0; i < count; i += 1) {
    const u = current.u[i]!;
    const v = current.v[i]!;
    if (v > 0.1) occ += 1;
    flux += u * v * v;
    change += Math.abs(v - previous.v[i]!);
  }
  return { occ: occ / count, flux: flux / count, change: change / count };
}

test.describe('Phase-2 integration integrity', () => {
  test('MAJOR 1: restart and resolution switch start a fresh composition arc', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Deterministic composition driving: pause the transport so the frame loop delivers no steps, then
    // advance the composition synchronously through the hook.
    await hook(page, 'setPaused', [true]);

    // Advance well past dormancy into a later movement.
    const later = await hook<{ phase: PhaseShape }>(page, 'advanceComposition', [9000]);
    expect(later.phase.movement, 'a later movement was reached').not.toBe('dormancy');
    expect((await hook<CuratorStateShape>(page, 'curatorState')).arc).toBe(0);

    const SEED = 123456;
    // Restart with a fixed new seed -> a fresh arc.
    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    const afterRestart = await hook<CuratorStateShape>(page, 'curatorState');
    expect(afterRestart.arc).toBe(0);
    expect(afterRestart.movement).toBe('dormancy');
    expect(afterRestart.stillState).toBe('none');
    expect(afterRestart.rescueUsed, 'the rescue budget is re-armed').toBe(false);
    expect(afterRestart.genesisOrigin, 'no origin is inherited').toBeNull();
    for (const [key, value] of Object.entries(afterRestart.timeline)) {
      expect(value, `timeline.${key} must be cleared`).toBeNull();
    }
    expect(await hook<GenesisCommandShape[]>(page, 'genesisLog'), 'the genesis log is cleared').toEqual([]);

    // Deterministic command sequence for the seed: restart twice with the same seed and compare.
    await hook(page, 'advanceComposition', [6000]);
    const sequenceA = signature(await hook<GenesisCommandShape[]>(page, 'genesisLog'));
    expect(sequenceA.length, 'the fresh arc issues genesis commands').toBeGreaterThan(0);

    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    await hook(page, 'advanceComposition', [6000]);
    const sequenceB = signature(await hook<GenesisCommandShape[]>(page, 'genesisLog'));
    expect(sequenceB, 'the same seed reproduces the same command sequence').toEqual(sequenceA);

    // A resolution switch during a later movement is the *same coherent restart* (retained seed).
    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    await hook(page, 'advanceComposition', [9000]);
    expect((await hook<CuratorStateShape>(page, 'curatorState')).movement).not.toBe('dormancy');

    await hook(page, 'setExploration', [true]);
    const exploringState = await hook<CuratorStateShape>(page, 'curatorState');
    expect(exploringState.movement).toBe('dormancy');
    expect(exploringState.arc).toBe(0);
    expect(exploringState.genesisOrigin).toBeNull();
    expect(await hook<LabSnapshotShape>(page, 'labSnapshot')).toMatchObject({
      simulationResolution: 512,
      explorationActive: true,
    });
    await hook(page, 'advanceComposition', [6000]);
    const sequence512 = signature(await hook<GenesisCommandShape[]>(page, 'genesisLog'));
    expect(sequence512).toEqual(sequenceA);

    await hook(page, 'setExploration', [false]);
    expect((await hook<CuratorStateShape>(page, 'curatorState')).movement).toBe('dormancy');
    await hook(page, 'advanceComposition', [6000]);
    const sequence768 = signature(await hook<GenesisCommandShape[]>(page, 'genesisLog'));
    expect(sequence768, '768 -> 512 -> 768 is a coherent, identical restart').toEqual(sequence512);

    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('MAJOR 2 / MINOR A: epoch provenance, stale rejection, and null-fence drops', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Manual path so the frame loop never polls the analyzer; we drive it by hand.
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 6 }]);
    await hook(page, 'simulate', [400]);

    // A field replacement clears the health/coarse state: nothing valid until a fresh-epoch sample.
    expect(await hook<unknown>(page, 'chemistryHealth')).toBeNull();

    // Fence pending, then replace the field (epoch bumped + analyzer reset).
    expect(await hook<boolean>(page, 'requestAnalysisOnly'), 'the first request is accepted').toBe(true);
    await hook(page, 'seed', [{ center: [0.3, 0.3], radiusCells: 5 }]);
    const epochAfterReplace = await hook<number>(page, 'epoch');
    const staleHealth = await hook<unknown>(page, 'chemistryHealth');
    const staleCoarse = await hook<CoarseOccupancyShape | null>(page, 'coarseOccupancy');
    expect(staleHealth, 'health is invalid after the field replacement').toBeNull();
    expect(staleCoarse, 'coarse occupancy is cleared after the field replacement').toBeNull();

    // A fresh sample completes for the *new* epoch and is accepted.
    const sample = await hook<AnalysisSampleShape | null>(page, 'analysisSampleForTest', [4000]);
    expect(sample, 'a fresh-epoch sample completes').not.toBeNull();
    expect(sample!.epoch).toBe(epochAfterReplace);

    // The poll-time guard discards a completed sample whose epoch is no longer current.
    const guard = await hook<{ ok: boolean; reason?: string; discarded: boolean; staleDrops: number }>(
      page,
      'analysisPollGuardProbe',
    );
    expect(guard.ok, guard.reason ?? '').toBe(true);
    expect(guard.discarded, 'the stale completed sample is discarded').toBe(true);
    expect(guard.staleDrops).toBeGreaterThan(0);

    // A null fence is a dropped request, not a success (MINOR A).
    const before = await hook<AnalyzerDiagnosticsShape>(page, 'analysisDiagnostics');
    await page.evaluate(() => {
      const proto = WebGL2RenderingContext.prototype as unknown as { fenceSync: () => unknown };
      const scope = window as unknown as { __origFenceSync?: () => unknown };
      scope.__origFenceSync = proto.fenceSync;
      proto.fenceSync = () => null;
    });
    const rejected = await hook<boolean>(page, 'requestAnalysisOnly');
    expect(rejected, 'a null fence drops the request').toBe(false);
    const after = await hook<AnalyzerDiagnosticsShape>(page, 'analysisDiagnostics');
    expect(after.nullFenceDrops).toBeGreaterThan(before.nullFenceDrops);
    await page.evaluate(() => {
      const proto = WebGL2RenderingContext.prototype as unknown as { fenceSync: () => unknown };
      const scope = window as unknown as { __origFenceSync?: () => unknown };
      if (scope.__origFenceSync) proto.fenceSync = scope.__origFenceSync;
    });
    // The slot was recycled, so a normal request is accepted again.
    expect(await hook<boolean>(page, 'requestAnalysisOnly')).toBe(true);

    // Through the real path: re-enabling automatic composition lets a new-epoch sample populate.
    await hook(page, 'setAutoSeed', [true]);
    await expect
      .poll(async () => (await hook<{ valid: boolean } | null>(page, 'chemistryHealth'))?.valid ?? false, {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(true);
  });

  test('MAJOR 3: analysis and publication follow performance time with a real-time ceiling', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'setPaused', [false]);

    const measure = async (seconds: number): Promise<{ pubPerReal: number; pubPerPerf: number; reqPerReal: number }> => {
      const start = await hook<CadenceShape>(page, 'cadenceCounters');
      await page.waitForTimeout(seconds * 1000);
      const end = await hook<CadenceShape>(page, 'cadenceCounters');
      const real = end.realSeconds - start.realSeconds;
      const perf = end.performanceSeconds - start.performanceSeconds;
      const pub = end.publications - start.publications;
      const req = end.analysisRequests - start.analysisRequests;
      return { pubPerReal: pub / real, pubPerPerf: pub / perf, reqPerReal: req / real };
    };

    // 1x: performance time advances with real time, so 2 Hz performance == 2 Hz real.
    await hook(page, 'setSpeed', [1]);
    await page.waitForTimeout(1500);
    const atOne = await measure(5);
    console.info(`[cadence] 1x: pub/real=${atOne.pubPerReal.toFixed(2)} pub/perf=${atOne.pubPerPerf.toFixed(2)} req/real=${atOne.reqPerReal.toFixed(2)}`);
    expect(atOne.pubPerReal).toBeGreaterThan(1.5);
    expect(atOne.pubPerReal).toBeLessThan(2.6);
    expect(atOne.pubPerPerf).toBeGreaterThan(1.5);
    expect(atOne.pubPerPerf).toBeLessThan(2.6);

    // 6x: performance time advances 6x faster; the 4 Hz real ceiling binds, so we see ~4 Hz real and
    // NOT the ~12 Hz real an uncapped performance schedule would produce.
    await hook(page, 'setSpeed', [6]);
    await page.waitForTimeout(1500);
    const atSix = await measure(5);
    console.info(`[cadence] 6x: pub/real=${atSix.pubPerReal.toFixed(2)} pub/perf=${atSix.pubPerPerf.toFixed(2)} req/real=${atSix.reqPerReal.toFixed(2)}`);
    expect(atSix.pubPerReal).toBeGreaterThan(3.0);
    expect(atSix.pubPerReal, 'the 4 Hz real ceiling binds (not the uncapped ~12 Hz)').toBeLessThan(5.0);
    expect(atSix.pubPerPerf, 'fewer publications per performance second under acceleration').toBeLessThan(1.2);
    expect(atSix.reqPerReal).toBeLessThan(5.0);

    await hook(page, 'setSpeed', [1]);
  });

  test('MAJOR 5: the real-shader health reduction matches a CPU full-domain mean', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Manual path AND paused: with automatic composition off the frame loop still steps the chemistry,
    // so the CPU reference field would drift between reads unless the transport is halted.
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    const measureFixture = async (label: string, tolerance: { occ: number; flux: number; change: number }) => {
      // The analyzer's `previous` is the ping-pong target one step back, so read the current field,
      // step once, and read again: `previous` is the pre-step field, `current` the post-step field.
      const previous = await hook<FieldShape>(page, 'readField');
      await hook(page, 'simulate', [1]);
      const current = await hook<FieldShape>(page, 'readField');
      const reference = cpuMeans(current, previous);
      const sample = await hook<AnalysisSampleShape | null>(page, 'analysisSampleForTest', [4000]);
      expect(sample, `${label}: sample completed`).not.toBeNull();
      const dOcc = Math.abs(sample!.occupiedFraction - reference.occ);
      const dFlux = Math.abs(sample!.flux - reference.flux);
      const dChange = Math.abs(sample!.change - reference.change);
      console.info(
        `[MAJOR 5] ${label}: cpu occ=${reference.occ.toFixed(6)} flux=${reference.flux.toFixed(6)} change=${reference.change.toFixed(6)} | ` +
          `gpu occ=${sample!.occupiedFraction.toFixed(6)} flux=${sample!.flux.toFixed(6)} change=${sample!.change.toFixed(6)} | ` +
          `dOcc=${dOcc.toExponential(2)} dFlux=${dFlux.toExponential(2)} dChange=${dChange.toExponential(2)}`,
      );
      expect(dOcc, `${label}: occupancy within one byte step`).toBeLessThanOrEqual(tolerance.occ);
      expect(dFlux, `${label}: flux within one byte step`).toBeLessThanOrEqual(tolerance.flux);
      expect(dChange, `${label}: change within one byte step`).toBeLessThanOrEqual(tolerance.change);
      return sample!;
    };

    // (a) uniform (U=1, V=0): every channel is exactly zero.
    await hook(page, 'reset');
    const uniform = await measureFixture('uniform', { occ: 1 / 255, flux: 0.04 / 255, change: 0.02 / 255 });
    expect(uniform.occupiedFraction).toBeCloseTo(0, 6);
    expect(uniform.flux).toBeCloseTo(0, 6);

    // (b) a grown, sparse field: the ordinary living case.
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 8 }]);
    await hook(page, 'simulate', [3000]);
    await measureFixture('grown-sparse', { occ: 1 / 255, flux: 0.04 / 255, change: 0.02 / 255 });

    // (c) localized high flux: an overgrowth parameter point saturates the *presentation* packing, but
    // the health value must still equal the CPU domain mean (the old path clipped it before the mean).
    await hook(page, 'setParameters', [{ F: 0.026, k: 0.045, Du: 0.16, Dv: 0.08 }]);
    await hook(page, 'reset');
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 10 }]);
    await hook(page, 'simulate', [6000]);
    const saturated = await measureFixture('high-flux', { occ: 1 / 255, flux: 0.04 / 255, change: 0.02 / 255 });
    const diagnostics = await hook<AnalyzerDiagnosticsShape>(page, 'analysisDiagnostics');
    console.info(
      `[MAJOR 5] float format=${diagnostics.floatFormat} packSaturated(last)=${saturated.packSaturated} saturatedSamples=${diagnostics.packSaturatedSamples}`,
    );
    expect(['RGBA32F', 'RGBA16F']).toContain(diagnostics.floatFormat);

    await hook(page, 'releaseParameters');
  });

  test('MAJOR 7: overrides route through the director (pin/unpin, no re-enable jump)', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Automatic composition on and running: the director is driving camera/light every frame. Pause
    // the transport and advance the composition past dormancy, because a quiet movement (`dormancy`)
    // is one the director deliberately does not re-frame — the pin/unpin assertions need a live one.
    await hook(page, 'setPaused', [true]);
    const advanced = await hook<{ phase: PhaseShape }>(page, 'advanceComposition', [10000]);
    expect(advanced.phase.movement, 'a living movement is active').not.toBe('dormancy');
    expect(['quiet', 'release']).not.toContain(advanced.phase.intention);

    // Pin each field through the real command/hook surfaces.
    await hook(page, 'dispatch', [{ type: 'camera', value: { distance: 9, focusUV: [0.42, 0.58] } }]);
    await hook(page, 'setLight', [{ intensity: 7 }]);
    await hook(page, 'setMaterial', [{ exposure: 0.5 }]);
    await page.waitForTimeout(1500);

    const pinned = await hook<PublishedStateShape>(page, 'publishedState');
    expect(pinned.camera.distance, 'camera pin survives derive').toBeCloseTo(9, 6);
    expect(pinned.camera.focusUV[0]).toBeCloseTo(0.42, 6);
    expect(pinned.light.intensity, 'light pin survives derive').toBeCloseTo(7, 6);
    expect(pinned.material.exposure, 'material pin survives derive').toBeCloseTo(0.5, 6);

    await page.waitForTimeout(1500);
    const stillPinned = await hook<PublishedStateShape>(page, 'publishedState');
    expect(stillPinned.camera.distance).toBeCloseTo(9, 6);
    expect(stillPinned.light.intensity).toBeCloseTo(7, 6);
    expect(stillPinned.material.exposure).toBeCloseTo(0.5, 6);

    // Release: the director resumes driving both fields.
    await hook(page, 'unpinCamera');
    await hook(page, 'unpinLight');
    await page.waitForTimeout(2000);
    const resumed = await hook<PublishedStateShape>(page, 'publishedState');
    expect(Math.abs(resumed.camera.distance - 9), 'camera resumes after unpin').toBeGreaterThan(1e-3);
    expect(Math.abs(resumed.light.intensity - 7), 'light resumes after unpin').toBeGreaterThan(1e-3);

    // Toggle automatic composition off (Phase-1 defaults restored), wait, then back on: the first
    // frames after re-enable must not jump (the time origin was cleared), so the camera/light stay at
    // the Phase-1 state rather than snapping to a stale target.
    await hook(page, 'setAutoSeed', [false]);
    await page.waitForTimeout(6000);
    const offState = await hook<PublishedStateShape>(page, 'publishedState');
    await hook(page, 'setAutoSeed', [true]);
    await page.waitForTimeout(200);
    const onAgain = await hook<PublishedStateShape>(page, 'publishedState');
    console.info(
      `[MAJOR 7] re-enable: distance ${offState.camera.distance.toFixed(4)} -> ${onAgain.camera.distance.toFixed(4)}, ` +
        `azimuth ${offState.light.azimuthRadians.toFixed(4)} -> ${onAgain.light.azimuthRadians.toFixed(4)}`,
    );
    // A stale-origin snap (dt = the whole 6 s off-period, alpha ~ 0.18) would move the camera by ~1
    // world unit and the azimuth by the rate limit at once; ordinary smoothing over 200 ms moves it by
    // well under 0.1.
    expect(Math.abs(onAgain.camera.distance - offState.camera.distance), 'no camera jump on re-enable').toBeLessThan(0.5);
    expect(Math.abs(onAgain.light.azimuthRadians - offState.light.azimuthRadians), 'no light jump on re-enable').toBeLessThan(0.05);
  });

  test('MAJOR 1: a hanging trajectory fetch never blocks startup, and a late success crossfades in', async ({ page }) => {
    test.setTimeout(120_000);
    // Hold the §12.2 bootstrap fetch open for the whole test. With the old `await this.bootstrapTrajectory()`
    // in `init()` this would leave the artwork black and unstarted, so `openArtwork` would time out
    // waiting for the hook; with the fix the hook installs immediately.
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await page.route('**/trajectories/default.json', async (route) => {
      await gate;
      await route.fulfill({
        path: resolve(process.cwd(), 'public/trajectories/default.json'),
        contentType: 'application/json',
      });
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // The hook installed with the fetch still pending; the app runs on the bundled document.
    const info = await hook<{ source: string; error: string | null; movements: string[] }>(page, 'trajectoryInfo');
    expect(info.source, 'startup must not be gated on the fetch').toBe('bundled');
    expect(info.movements.length).toBeGreaterThan(0);

    // Clock/frames advance promptly on the bundled document.
    const before = await hook<CadenceShape>(page, 'cadenceCounters');
    await expect
      .poll(async () => (await hook<CadenceShape>(page, 'cadenceCounters')).performanceSeconds, { timeout: 10_000, intervals: [100] })
      .toBeGreaterThan(before.performanceSeconds + 0.5);

    // Stop the transport so no composition step (which can bump the epoch) can race the crossfade.
    await hook(page, 'setPaused', [true]);
    const epochBefore = await hook<number>(page, 'epoch');

    // Fulfil the fetch: the document is applied through the §6.4 `load-trajectory` crossfade.
    release();
    await expect
      .poll(async () => (await hook<{ source: string }>(page, 'trajectoryInfo')).source, { timeout: 15_000, intervals: [100] })
      .toBe('fetched');
    expect(await hook<number>(page, 'epoch'), 'the crossfade must not reset the field/epoch').toBe(epochBefore);
    const fetched = await hook<{ error: string | null; movements: string[] }>(page, 'trajectoryInfo');
    expect(fetched.error, 'no fetch error is surfaced on success').toBeNull();
    expect(fetched.movements.length, 'the fetched document reports its movements').toBeGreaterThan(0);
  });

  test("MAJOR 2: a same-arc restart re-arms the director to the new seed's light target", async ({ page }) => {
    test.setTimeout(120_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const targetFor = async (seed: number): Promise<number> => {
      await hook(page, 'dispatch', [{ type: 'restart', seed }]);
      return hook<number>(page, 'directorAzimuthTarget');
    };

    const seedA = 111_111;
    const seedB = 222_222;
    const seedC = 333_333;
    const targetA = await targetFor(seedA);
    const targetB = await targetFor(seedB);
    const targetC = await targetFor(seedC);
    expect(targetA, 'seed A and B select different bounded targets').not.toBeCloseTo(targetB, 6);
    expect(targetC, 'seed C and B select different bounded targets').not.toBeCloseTo(targetB, 6);

    // The target is a function of the *new* (seed, arc 0), not of the previous performance's state.
    // Without the explicit re-arm the director keeps whichever target it first derived.
    const afterC = await targetFor(seedB); // prior state: seed C
    expect(afterC, 'restart into B after C selects B').toBeCloseTo(targetB, 9);
    await targetFor(seedA);
    const afterA = await targetFor(seedB); // prior state: seed A
    expect(afterA, 'restart into B after A selects B').toBeCloseTo(targetB, 9);
    expect(afterA, 'the two prior seeds give the same B target').toBeCloseTo(afterC, 12);

    // The §10 resolution switch retains the root seed and re-arms identically (same operation, same
    // seed): 768 -> 512 -> 768 keeps seed B's target unaffected by the grid change.
    await hook(page, 'dispatch', [{ type: 'restart', seed: seedB }]);
    const beforeSwitch = await hook<number>(page, 'directorAzimuthTarget');
    await hook(page, 'setExploration', [true]);
    expect(await hook<number>(page, 'directorAzimuthTarget'), '512 grid re-arm keeps seed B').toBeCloseTo(beforeSwitch, 9);
    await hook(page, 'setExploration', [false]);
    expect(await hook<number>(page, 'directorAzimuthTarget'), '768 grid re-arm keeps seed B').toBeCloseTo(beforeSwitch, 9);
  });

  test('Phase 3: the presentation tier populates live and is cleared on a field replacement', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    // Automatic composition on: both tiers populate through the real frame loop and worker.
    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'setPaused', [false]);
    await expect
      .poll(async () => (await hook<PresentationShape>(page, 'presentationAnalysis')).valid, {
        timeout: 90_000,
        intervals: [500],
      })
      .toBe(true);

    // The lab snapshot carries both tiers and the event record.
    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.presentation.valid).toBe(true);
    expect(Number.isFinite(snapshot.presentation.occupiedFraction)).toBe(true);
    expect(snapshot.event.serial).toBeGreaterThanOrEqual(0);

    // A field replacement (epoch bump) invalidates the presentation tier until a fresh-epoch sample
    // completes: a stale-epoch worker result must never be adopted.
    await hook(page, 'reset');
    const afterReset = await hook<PresentationShape>(page, 'presentationAnalysis');
    expect(afterReset.valid, 'the presentation tier is invalid after a field replacement').toBe(false);

    // A fresh-epoch sample repopulates it.
    await expect
      .poll(async () => (await hook<PresentationShape>(page, 'presentationAnalysis')).valid, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(true);

    const event = await hook<EventShape>(page, 'events');
    expect(Number.isFinite(event.strength)).toBe(true);
    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('MINOR 3: a mid-batch replace makes every later composition step see invalid health', async ({ page }) => {
    test.setTimeout(120_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Automatic composition on with an inert field, so a real tier-1 sample populates valid,
    // negligible (empty) health.
    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'reset');
    await expect
      .poll(async () => (await hook<{ valid: boolean } | null>(page, 'chemistryHealth'))?.valid ?? false, {
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(true);

    // Freeze the transport so the frame loop cannot poll a fresh sample inside the batch, then advance
    // a batch that injects one field replacement before step 1.
    await hook(page, 'setPaused', [true]);
    const before = await hook<number>(page, 'epoch');
    const traced = await hook<{ trace: boolean[]; epoch: number; healthValid: boolean }>(page, 'advanceCompositionTraced', [24, 1]);

    expect(traced.trace[0], 'step 0 consumed the valid pre-batch sample').toBe(true);
    expect(traced.epoch, 'a replacement happened inside the batch').toBeGreaterThan(before);
    // Once invalidated, no later step in the same batch may see valid health again (no sample can
    // arrive mid-batch): a stale view would keep consuming the pre-replacement sample instead.
    for (let i = 1; i < traced.trace.length; i += 1) {
      if (!traced.trace[i - 1]) expect(traced.trace[i], `step ${i} must stay invalid`).toBe(false);
    }
    expect(traced.trace[traced.trace.length - 1], 'the batch ends on invalid health').toBe(false);
    expect(traced.healthValid, 'the live health state is invalid after the replacement').toBe(false);
  });
});
