/**
 * §7.1/AC.10 reduction contract (Phase 3).
 *
 * Runs the real reduction/pack/readback shaders on deterministic fields and decodes **both** regions
 * of the combined sample buffer:
 *  - center-only activity (inside the support envelope) produces a strong tier-2 presentation signal
 *    and a tier-1 health reading;
 *  - hidden-periphery activity (outside the envelope) is seen by tier 1 but produces **no** strong
 *    presentation signal, and the two tiers differ materially — the visibility discipline of §7.1.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';

interface ReductionSampleShape {
  epoch: number;
  health: { occupiedFraction: number; flux: number; change: number };
  presentation: { meanU: number; meanV: number; occupancy: number; activity: number };
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

test.describe('§7.1 reduction contract (AC.10)', () => {
  test('center-only activity is strong in tier 2; hidden-periphery activity is invisible to tier 2', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Manual path, transport frozen: the CPU reference and the readback cannot drift.
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    // (a) Center-only activity: fully inside the support envelope. Use a growth regime and let the
    //     organism spread so the reduced-field occupancy is a meaningful fraction of the domain.
    await hook(page, 'setParameters', [{ F: 0.026, k: 0.045, Du: 0.16, Dv: 0.08 }]);
    await hook(page, 'reset');
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 12 }]);
    await hook(page, 'simulate', [8000]);
    const center = await hook<ReductionSampleShape | null>(page, 'reductionSampleForTest', [4000]);
    expect(center, 'a center-only sample completed').not.toBeNull();
    console.info(
      `[reduction] center: tier1 occ=${center!.health.occupiedFraction.toFixed(5)} flux=${center!.health.flux.toFixed(5)} | ` +
        `tier2 occ=${center!.presentation.occupancy.toFixed(4)} meanV=${center!.presentation.meanV.toFixed(4)}`,
    );
    expect(center!.presentation.occupancy, 'envelope-weighted occupancy is substantial').toBeGreaterThan(0.01);
    expect(center!.presentation.meanV).toBeGreaterThan(0.01);
    expect(center!.health.occupiedFraction).toBeGreaterThan(0.001);
    await hook(page, 'releaseParameters');

    // (b) Hidden-periphery activity: outside the envelope (radius > 1.0), so tier 2 must not see it.
    await hook(page, 'reset');
    await hook(page, 'seed', [{ center: [0.02, 0.02], radiusCells: 6 }]);
    const hidden = await hook<ReductionSampleShape | null>(page, 'reductionSampleForTest', [4000]);
    expect(hidden, 'a hidden-periphery sample completed').not.toBeNull();
    console.info(
      `[reduction] hidden: tier1 occ=${hidden!.health.occupiedFraction.toExponential(2)} | ` +
        `tier2 occ=${hidden!.presentation.occupancy.toFixed(5)} meanV=${hidden!.presentation.meanV.toExponential(2)}`,
    );
    // Tier 1 (full-domain) sees the organism.
    expect(hidden!.health.occupiedFraction, 'tier 1 sees the hidden organism').toBeGreaterThan(0.0001);
    // Tier 2 (envelope-weighted) does not: no strong presentation-facing signal.
    expect(hidden!.presentation.occupancy, 'tier 2 does not see the hidden organism').toBeLessThan(0.01);
    expect(hidden!.presentation.meanV).toBeLessThan(0.005);
    // Material tier-1/tier-2 separation.
    expect(hidden!.health.occupiedFraction).toBeGreaterThan(hidden!.presentation.occupancy + 0.0001);

    const diagnostics = await hook<AnalyzerDiagnosticsShape>(page, 'analysisDiagnostics');
    expect(['RGBA32F', 'RGBA16F']).toContain(diagnostics.floatFormat);

    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('identical raw chemistry is attenuated monotonically by the support envelope', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'setParameters', [{ F: 0.026, k: 0.045, Du: 0.16, Dv: 0.08 }]);

    // The solver wraps toroidally, so the *same* seed advanced the *same* number of steps at an
    // integer-cell vertical offset is an exact translated copy of the raw chemistry: tier 1 (no
    // envelope) is unchanged while tier 2 sees the centered §5.4 envelope move across the blob.
    const GRID = 768;
    const RADIUS_CELLS = 16;
    // A pure seed (no growth) keeps the blob compact relative to the envelope's 0.65–1.0 transition,
    // so the average envelope weight across it moves strongly with radius.
    const STEPS = 0;
    const positions = [
      { radius: 0.0, offsetCells: 0 },
      { radius: 0.5, offsetCells: 192 },
      { radius: 0.703, offsetCells: 270 },
      { radius: 0.833, offsetCells: 320 },
      { radius: 0.938, offsetCells: 360 },
    ];

    interface Row {
      radius: number;
      meanV: number;
      occupancy: number;
      healthOccupied: number;
    }
    const rows: Row[] = [];
    for (const position of positions) {
      await hook(page, 'reset');
      const center: [number, number] = [0.5, 0.5 - position.offsetCells / GRID];
      await hook(page, 'seed', [{ center, radiusCells: RADIUS_CELLS }]);
      await hook(page, 'simulate', [STEPS]);
      const sample = await hook<ReductionSampleShape | null>(page, 'reductionSampleForTest', [4000]);
      expect(sample, `a sample completed at radius ${position.radius}`).not.toBeNull();
      rows.push({
        radius: position.radius,
        meanV: sample!.presentation.meanV,
        occupancy: sample!.presentation.occupancy,
        healthOccupied: sample!.health.occupiedFraction,
      });
    }
    await hook(page, 'releaseParameters');

    for (const row of rows) {
      console.info(
        `[reduction-attenuation] r=${row.radius.toFixed(3)} meanV=${row.meanV.toExponential(3)} ` +
          `occ=${row.occupancy.toFixed(5)} tier1=${row.healthOccupied.toExponential(3)}`,
      );
    }

    // Tier 1 (full-domain, unweighted) sees the same translated chemistry: it must barely move, which
    // proves the tier-2 decay below is envelope-driven rather than a change in the raw field.
    const baseHealth = rows[0]!.healthOccupied;
    for (const row of rows) {
      expect(row.healthOccupied, 'raw (tier-1) chemistry is translation-invariant').toBeGreaterThan(baseHealth * 0.85);
      expect(row.healthOccupied).toBeLessThan(baseHealth * 1.2);
    }

    // Tier 2 decays monotonically with radius: the attenuation is real and tracks the envelope.
    for (let i = 1; i < rows.length; i += 1) {
      expect(
        rows[i]!.meanV,
        `presentation meanV is non-increasing with radius (r=${rows[i]!.radius})`,
      ).toBeLessThanOrEqual(rows[i - 1]!.meanV * 1.02 + 1e-6);
    }
    // Center is materially stronger than the fade annulus (the regression the review found).
    expect(rows[0]!.meanV, 'center is materially stronger than the outermost annulus').toBeGreaterThan(
      rows[rows.length - 1]!.meanV * 3,
    );
    expect(rows[0]!.meanV, 'center exceeds the first annulus sample').toBeGreaterThan(rows[2]!.meanV * 1.02);

    // Annulus-only activity cannot cross the §7.2 occupancy threshold, so the reduced-V field the
    // §7.3 topology/event tier consumes has no foreground at all — no component, no birth, no salient
    // event — however many samples are taken. Sample the far annulus repeatedly.
    await hook(page, 'reset');
    await hook(page, 'seed', [{ center: [0.5, 0.5 - 366 / GRID], radiusCells: 12 }]);
    for (let s = 0; s < 3; s += 1) {
      const sample = await hook<ReductionSampleShape | null>(page, 'reductionSampleForTest', [4000]);
      expect(sample, `annulus-only sample ${s} completed`).not.toBeNull();
      console.info(
        `[reduction-attenuation] annulus-only sample ${s}: meanV=${sample!.presentation.meanV.toExponential(3)} ` +
          `occ=${sample!.presentation.occupancy.toFixed(5)}`,
      );
      expect(
        sample!.presentation.occupancy,
        'annulus-only activity never becomes a reduced-V foreground, so no component/birth can form',
      ).toBe(0);
      expect(sample!.health.occupiedFraction, 'tier 1 still sees the annulus activity').toBeGreaterThan(0);
    }

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
