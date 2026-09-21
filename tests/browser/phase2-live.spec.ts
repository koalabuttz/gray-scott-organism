/**
 * Phase-2 live loop on the real GPU (§4.1, §6.3/§6.4, §7.1, §9.1).
 *
 * Boots the app at accelerated speed with the automatic composition enabled (the default) and lets the
 * *real* frame loop drive the curator, the tier-1 analysis reduction and the camera/light director.
 * This is the one test that proves the Phase-2 modules are wired into the live path rather than merely
 * unit-tested: the curator must leave `dormancy` and issue the nucleation genesis (a `replace` seed,
 * which bumps the field epoch), the chemistry-health readback must populate, the coarse occupancy grid
 * must decode, and the director's camera/light targets must move over time — with no NaNs and no
 * page/console errors.
 *
 * Phase-1 behaviour with automatic composition off is covered elsewhere: every spec that drives the
 * field manually calls `setAutoSeed(false)` first, which now returns the app to the exact Phase-1
 * manual path (no curator, no director, no analysis readback; camera/light/material restored to the
 * calibrated defaults).
 */
import { expect, test } from '@playwright/test';
import { openArtwork, hook } from '../support/browser.ts';
import type {
  ChemistryHealthShape,
  CoarseOccupancyShape,
  EventShape,
  HorizonShape,
  LabSnapshotShape,
  PhaseShape,
  PresentationShape,
  PublishedStateShape,
  TrajectoryInfoShape,
} from '../support/types.ts';

/** §10's measured presentation ceiling; the dormancy (30 performance-s) then passes in a few seconds. */
const SPEED = 6;
const LATER_MOVEMENTS = [
  'nucleation',
  'cellular-growth',
  'replication',
  'connection',
  'labyrinth',
  'overgrowth',
  'collapse',
  'stillness',
  'rebirth',
];

test.describe('Phase-2 live loop', () => {
  test('curator, analysis and director run on the real GPU without errors', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // The automatic composition is the default Phase-2 path; assert it really is on, and record the
    // field epoch so the nucleation genesis (a `replace`) can be observed as an epoch bump.
    const initial = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(initial.autoSeed, 'automatic composition on by default').toBe(true);
    expect(initial.paused).toBe(false);
    const genesisEpoch = initial.epoch;

    await hook(page, 'setSpeed', [SPEED]);

    // 1. the curator leaves dormancy (30 performance-seconds) and issues the nucleation genesis.
    await expect
      .poll(async () => (await hook<PhaseShape>(page, 'curatorPhase')).movement, {
        timeout: 150_000,
        intervals: [500],
      })
      .not.toBe('dormancy');

    const phase = await hook<PhaseShape>(page, 'curatorPhase');
    console.info(
      `[phase2] curator left dormancy: movement=${phase.movement} intention=${phase.intention} arc=${phase.arc}`,
    );
    expect(LATER_MOVEMENTS).toContain(phase.movement);
    expect(phase.arc).toBe(0);
    expect(['quiet', 'emerge', 'expand', 'connect', 'saturate', 'release']).toContain(phase.intention);
    expect(Number.isFinite(phase.elapsedSeconds)).toBe(true);
    expect(Number.isFinite(phase.progress)).toBe(true);

    // The nucleation movement's entry genesis is a `replace` seed, so the field epoch must have risen.
    await expect
      .poll(async () => hook<number>(page, 'epoch'), { timeout: 60_000, intervals: [500] })
      .toBeGreaterThan(genesisEpoch);

    // 2. the tier-1 chemistry-health readback populates with valid, finite values.
    await expect
      .poll(async () => (await hook<ChemistryHealthShape | null>(page, 'chemistryHealth')) !== null, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(true);
    const health = (await hook<ChemistryHealthShape | null>(page, 'chemistryHealth'))!;
    console.info(
      `[phase2] chemistryHealth: occupied=${health.fullOccupiedFraction.toFixed(4)} ` +
        `flux=${health.fullReactionActivity.toFixed(6)} change=${health.fullChangeRate.toFixed(6)} ` +
        `age=${health.ageSeconds.toFixed(2)}s`,
    );
    expect(health.valid).toBe(true);
    for (const [name, value] of Object.entries(health)) {
      if (typeof value === 'number') expect(Number.isFinite(value), `chem.${name} finite`).toBe(true);
    }
    expect(health.fullOccupiedFraction).toBeGreaterThanOrEqual(0);
    expect(health.fullOccupiedFraction).toBeLessThanOrEqual(1);
    expect(health.ageSeconds).toBeGreaterThanOrEqual(0);

    // 2b. the tier-2 presentation tier populates: both tiers are live, with finite descriptors. This
    //     proves the presentation worker (§3.3) is wired into the live path, not merely unit-tested.
    await expect
      .poll(async () => (await hook<PresentationShape>(page, 'presentationAnalysis')).valid, {
        timeout: 90_000,
        intervals: [500],
      })
      .toBe(true);
    const presentation = await hook<PresentationShape>(page, 'presentationAnalysis');
    console.info(
      `[phase2] presentation: occ=${presentation.occupiedFraction.toFixed(4)} β0=${presentation.beta0Approx} ` +
        `β1=${presentation.beta1Approx} bands=[${presentation.spectralBands.map((b) => b.toFixed(2)).join(', ')}] ` +
        `coh=${presentation.coherence.toFixed(3)} sym=${presentation.symmetry.toFixed(3)} ` +
        `conf=${presentation.topologyConfidence.toFixed(3)} age=${presentation.ageSeconds.toFixed(1)}s`,
    );
    for (const [name, value] of Object.entries(presentation)) {
      if (typeof value === 'number') expect(Number.isFinite(value), `presentation.${name} finite`).toBe(true);
    }
    expect(presentation.occupiedFraction).toBeGreaterThanOrEqual(0);
    expect(presentation.occupiedFraction).toBeLessThanOrEqual(1);
    expect(presentation.coherence).toBeGreaterThanOrEqual(0);
    expect(presentation.coherence).toBeLessThanOrEqual(1);
    expect(presentation.ageSeconds).toBeGreaterThanOrEqual(0);

    // 2c. events are serial-numbered records (§3.4). At least the record shape is present and finite;
    //     the horizon is unlikely to engage in a single accelerated arc (log it either way).
    const events = await hook<EventShape>(page, 'events');
    const horizon = await hook<HorizonShape>(page, 'horizonState');
    console.info(
      `[phase2] events: serial=${events.serial} latest=${events.kind}; horizon: state=${horizon.state} ` +
        `moments=${horizon.moments}`,
    );
    expect(events.serial).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(events.strength)).toBe(true);

    // 3. the coarse 16x16 occupancy grid decodes (§7.1/§9.1 framing input).
    await expect
      .poll(async () => (await hook<CoarseOccupancyShape | null>(page, 'coarseOccupancy')) !== null, {
        timeout: 60_000,
        intervals: [500],
      })
      .toBe(true);
    const coarse = (await hook<CoarseOccupancyShape | null>(page, 'coarseOccupancy'))!;
    console.info(
      `[phase2] coarseOccupancy: size=${coarse.size} occupied=${coarse.occupiedFraction.toFixed(4)} ` +
        `centroid=[${coarse.centroidUV.map((v) => v.toFixed(3)).join(', ')}]`,
    );
    expect(coarse.size).toBe(16);
    expect(Number.isFinite(coarse.occupiedFraction)).toBe(true);
    expect(coarse.occupiedFraction).toBeGreaterThanOrEqual(0);
    expect(coarse.occupiedFraction).toBeLessThanOrEqual(1);
    for (const component of coarse.centroidUV) {
      expect(Number.isFinite(component)).toBe(true);
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(1);
    }

    // 4. the organism actually grew: the nucleation genesis took and the field is alive. This also
    //    confirms the curator's parameters reached the solver (occupancy rises only once F/k move).
    await expect
      .poll(
        async () => (await hook<ChemistryHealthShape | null>(page, 'chemistryHealth'))?.fullOccupiedFraction ?? 0,
        { timeout: 120_000, intervals: [1000] },
      )
      .toBeGreaterThan(0.005);

    // 5. the director's camera and light targets move over time (§9.1/§9.3): the light's slow azimuth
    //    drift and the camera's occupancy-driven distance change are the observable signs that the
    //    director — not a static Phase-1 rig — is driving the view.
    const before = await hook<PublishedStateShape>(page, 'publishedState');
    await page.waitForTimeout(6000);
    const after = await hook<PublishedStateShape>(page, 'publishedState');
    const azimuthMoved = Math.abs(after.light.azimuthRadians - before.light.azimuthRadians) > 1e-4;
    const distanceMoved = Math.abs(after.camera.distance - before.camera.distance) > 1e-4;
    console.info(
      `[phase2] director targets: azimuth ${before.light.azimuthRadians.toFixed(5)} -> ` +
        `${after.light.azimuthRadians.toFixed(5)} (moved=${azimuthMoved}), distance ` +
        `${before.camera.distance.toFixed(5)} -> ${after.camera.distance.toFixed(5)} (moved=${distanceMoved})`,
    );
    expect(azimuthMoved, 'light azimuth drifts over time').toBe(true);
    expect(distanceMoved, 'camera distance follows the organism').toBe(true);

    // 6. no NaNs anywhere in the published visual state, no feedback violations, composition provenance
    //    intact, and no page/console errors from the whole run.
    expect(Number.isFinite(after.camera.distance)).toBe(true);
    expect(Number.isFinite(after.camera.focusUV[0])).toBe(true);
    expect(Number.isFinite(after.camera.focusUV[1])).toBe(true);
    expect(Number.isFinite(after.light.intensity)).toBe(true);
    expect(Number.isFinite(after.light.azimuthRadians)).toBe(true);
    expect(Number.isFinite(after.material.exposure)).toBe(true);
    expect(await hook<number>(page, 'feedbackViolations')).toBe(0);

    const trajectory = await hook<TrajectoryInfoShape>(page, 'trajectoryInfo');
    expect(['bundled', 'fetched', 'imported']).toContain(trajectory.source);
    expect(trajectory.movements.length).toBe(10);

    expect(errors, `page/console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
