/**
 * Single-seed growth curve (§12.1 "one strong genesis condition").
 *
 * The mandatory Phase 1 gate evidence must come from the plan's genesis condition — a single seed
 * growing into one organism — not from a lattice of identical seeds, because a uniform lattice
 * grown on a translation-invariant torus stays periodic and reads as tiled wallpaper. A single seed
 * needs far longer to fill the frame, so this spec measures how occupancy, extent and translational
 * symmetry evolve, which is how the mature capture's step budget was chosen.
 *
 * Run with: GROWTH=1 npx playwright test --project=headless-gpu growth.spec.ts
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork, writeArtifact } from '../support/browser.ts';
import { createSingleSeedCommand } from '../../src/simulation/genesis.ts';
import type { GenesisCommandShape, ParamsShape, SummaryShape } from '../support/types.ts';

const ENABLED = process.env['GROWTH'] === '1';

/** The documented Phase 1 genesis: one seed, perturbed per §4.4, recorded by seed number. */
const GENESIS_SEED = 2_026_031;
const GENESIS_CENTER: [number, number] = [0.44, 0.53];
const GENESIS_RADIUS_CELLS = 6;
const PARAMETERS: ParamsShape = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };
const MILESTONES = [2_000, 4_000, 8_000, 16_000, 24_000, 32_000, 40_000, 50_000];

test.describe('single-seed growth curve', () => {
  test.skip(!ENABLED, 'set GROWTH=1 to measure the single-seed growth curve');

  test('occupancy, extent and translational symmetry vs delivered steps', async ({ page }) => {
    test.setTimeout(40 * 60_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const probe = await openArtwork(page);
    expect(probe.ok, probe.reason).toBe(true);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [PARAMETERS]);

    const command = createSingleSeedCommand({
      center: GENESIS_CENTER,
      seed: GENESIS_SEED,
      perturb: true,
      radiusCells: GENESIS_RADIUS_CELLS,
      strength: 1,
      mode: 'replace',
    }) as unknown as GenesisCommandShape;
    await hook(page, 'applyGenesis', [command]);
    console.info(
      `[growth] genesis applied: kind=${command.kind} mode=${command.mode} seed=${command.seed} ` +
        `center=[${command.center.map((n) => n.toFixed(5)).join(', ')}] radiusCells=${command.radiusCells.toFixed(3)} ` +
        `strength=${command.strength.toFixed(5)}`,
    );

    const rows: Array<Record<string, unknown>> = [];
    let delivered = 0;
    for (const milestone of MILESTONES) {
      const started = Date.now();
      await hook(page, 'simulate', [milestone - delivered]);
      const seconds = (Date.now() - started) / 1000;
      delivered = milestone;
      await hook(page, 'renderOnce');
      const summary = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
      const image = await hook<{ max: number; mean: number; nonBlackFraction: number; percentiles: number[] }>(
        page,
        'compositeStats',
      );
      rows.push({
        steps: milestone,
        seconds,
        occupiedFraction: summary.occupiedFraction,
        extentUV: summary.extentUV,
        centroidUV: summary.centroidUV,
        maxV: summary.maxV,
        symmetryAtQuarter: summary.symmetry.score,
        imageMax: image.max,
        imageMean: image.mean,
        litFraction: image.nonBlackFraction,
        imageP50: image.percentiles[0],
      });
      console.info(
        `[growth] ${String(milestone).padStart(6)} steps (${seconds.toFixed(1)}s): occupied=${summary.occupiedFraction.toFixed(4)} ` +
          `extent=${summary.extentUV.map((n) => n.toFixed(3)).join('x')} maxV=${summary.maxV.toFixed(3)} ` +
          `symmetry(1/4)=${summary.symmetry.score.toFixed(3)} | image max=${image.max} mean=${image.mean.toFixed(2)} ` +
          `lit=${(image.nonBlackFraction * 100).toFixed(2)}% p50=${image.percentiles[0]}`,
      );
    }

    writeArtifact(
      'phase1-growth.json',
      JSON.stringify(
        {
          note:
            'Single-seed growth at 768x768. symmetryAtQuarter is 1 - mean|V(p)-V(p+192 cells)| / mean|V(p)-mean(V)|: ' +
            'near 1 would mean the field repeats at a 4x4 lattice period (wallpaper), near 0 means it does not.',
          genesis: command,
          parameters: PARAMETERS,
          rows,
        },
        null,
        2,
      ),
    );
    expect(rows.length).toBe(MILESTONES.length);
  });
});
