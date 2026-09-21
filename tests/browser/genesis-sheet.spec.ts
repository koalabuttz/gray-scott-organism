/**
 * GENESIS=1 — §4.4 genesis-kind contact sheet (§12.2 "export a discovery contact sheet").
 *
 * Grows one representative field for every one of the seven §4.4 genesis kinds from the *same*
 * recorded seed, pauses, and captures the composite plus the field/descriptor summary. The images
 * and the JSON beside them are the contact sheet: they answer "does each declared genesis condition
 * actually produce a distinct, living field on this solver?" before any of them is trusted by the
 * trajectory.
 *
 * Resolution choice: **512² (lab exploration grid)**. §6.5's discovery tooling is explicitly a
 * lab/exploration activity, the exploration grid is the documented faster discovery regime
 * (deviation 34), and seed geometry is specified in chemical *cells* (§4.2) — so at 512² each pattern
 * covers proportionally more of the 2-world-unit domain, which makes the kind differences easier to
 * read in a contact sheet. The 768² presentation grid stays the production target; this sheet is a
 * discovery artifact, not a presentation claim.
 *
 * Run: `GENESIS=1 npx playwright test --project=headless-gpu genesis-sheet.spec.ts`
 * (or `npm run test:genesis`). Writes `artifacts/genesis-sheet/`.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import { writeJson, writePng } from '../support/evidence.ts';
import { createLabGenesisCommand } from '../../src/lab/genesis-lab.ts';
import type {
  FieldStatsShape,
  GenesisCommandShape,
  ImageStatsShape,
  ParamsShape,
  SummaryShape,
} from '../support/types.ts';

const ENABLED = process.env['GENESIS'] === '1';

/** All seven §4.4 kinds, in the plan's declaration order. */
const KINDS = ['single', 'competing', 'line', 'ring', 'sparse', 'radial', 'structured'] as const;
type Kind = (typeof KINDS)[number];

const GRID = 512;
/** One recorded seed for the whole sheet, so the only variable is the kind. */
const SEED = 2_026_0921;
/** The tune-selected living point on this solver (`artifacts/phase1-tune.txt`); §6.2 envelope-safe. */
const PARAMETERS: ParamsShape = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };
/**
 * A representative growth budget: enough delivered steps for each pattern's *characteristic*
 * morphology to be legible (a disk becomes a blob, competing disks stay separated, a ring stays an
 * annulus) without every kind saturating into the same mature labyrinth. `radial` is the §4.4
 * near-threshold kind ("the diffuse component alone need not nucleate"), so it is allowed to be
 * near-dead; at 512² it does nucleate (its core is viable).
 *
 * The 8000-step budget that was rejected is not left as an assertion: `REJECTED_STEPS` runs each kind
 * to that budget and records occupancy-only metrics in `sheet.json` (`rejectedRuns`, no PNGs), so the
 * rejection is auditable rather than an author claim.
 */
const STEPS: Record<Kind, number> = {
  single: 4000,
  competing: 4000,
  line: 4000,
  ring: 4000,
  sparse: 4000,
  radial: 4000,
  structured: 4000,
};

/** The rejected growth budget, recorded occupancy-only so the choice of 4000 is auditable. */
const REJECTED_STEPS = 8000;

interface SheetRow {
  kind: Kind;
  file: string;
  steps: number;
  command: GenesisCommandShape;
  field: FieldStatsShape;
  summary: SummaryShape;
  image: ImageStatsShape;
  alive: boolean;
  nearThreshold: boolean;
}

test.describe('GENESIS=1 genesis-kind contact sheet', () => {
  test.skip(!ENABLED, 'set GENESIS=1 to build the §4.4 genesis contact sheet');

  test('all seven §4.4 kinds, grown and captured at 512²', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    // Deterministic manual control at the exploration grid: the curator must not re-seed the field.
    await hook(page, 'setExploration', [true]);
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    const resolution = await hook<{ width: number; height: number }>(page, 'simulationSize');
    expect(resolution, 'the sheet runs on the 512² exploration grid').toEqual({ width: 512, height: 512 });

    const rows: SheetRow[] = [];
    for (const kind of KINDS) {
      await hook(page, 'reset');
      await hook(page, 'setParameters', [PARAMETERS]);
      const command = createLabGenesisCommand(kind, {
        seed: SEED,
        gridWidth: GRID,
        gridHeight: GRID,
      }) as unknown as GenesisCommandShape;
      await hook(page, 'applyGenesis', [command]);
      await hook(page, 'simulate', [STEPS[kind]]);
      await hook(page, 'renderOnce');

      const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
      const summary = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      const png = await hook<string>(page, 'capturePngBase64');
      const file = `genesis-sheet/${kind}.png`;
      writePng(file, png);

      const alive = field.nonFinite === 0 && summary.occupiedFraction > 0 && field.reactionActivity > 0;
      rows.push({
        kind,
        file,
        steps: STEPS[kind],
        command,
        field,
        summary,
        image,
        alive,
        nearThreshold: kind === 'radial',
      });
      console.info(
        `[genesis] ${kind.padEnd(10)} steps=${STEPS[kind]} occ=${summary.occupiedFraction.toFixed(4)} ` +
          `activity=${field.reactionActivity.toExponential(3)} maxV=${summary.maxV.toFixed(3)} ` +
          `nonFinite=${field.nonFinite} alive=${alive} image(max=${image.max} mean=${image.mean.toFixed(2)})`,
      );
      // Every kind must stay finite; that is not a near-threshold exemption.
      expect(field.nonFinite, `${kind}: no non-finite cells`).toBe(0);
    }

    // Sanity: each kind is alive except the §4.4 near-threshold `radial`, documented when it is not.
    const dead = rows.filter((row) => !row.alive);
    const unexpectedDead = dead.filter((row) => !row.nearThreshold);
    expect(
      unexpectedDead.map((row) => row.kind),
      'every non-near-threshold kind produces a living field',
    ).toEqual([]);
    const radial = rows.find((row) => row.kind === 'radial')!;

    // MINOR 4: audit the rejected 8000-step budget. Run each kind to `REJECTED_STEPS` and record the
    // occupancy only (no PNG), so the "alive but no longer distinctive" reason for choosing 4000 is an
    // artifact rather than an assertion.
    const rejectedRuns: Array<{
      kind: Kind;
      steps: number;
      occupancy: number;
      maxV: number;
      activity: number;
      nonFinite: number;
    }> = [];
    for (const kind of KINDS) {
      await hook(page, 'reset');
      await hook(page, 'setParameters', [PARAMETERS]);
      const command = createLabGenesisCommand(kind, { seed: SEED, gridWidth: GRID, gridHeight: GRID });
      await hook(page, 'applyGenesis', [command]);
      await hook(page, 'simulate', [REJECTED_STEPS]);
      const summary = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
      const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
      rejectedRuns.push({
        kind,
        steps: REJECTED_STEPS,
        occupancy: summary.occupiedFraction,
        maxV: summary.maxV,
        activity: field.reactionActivity,
        nonFinite: field.nonFinite,
      });
      expect(field.nonFinite, `${kind} at ${REJECTED_STEPS} steps: no non-finite cells`).toBe(0);
    }
    const rejectedOccupancies = rejectedRuns.map((run) => run.occupancy);

    writeJson('genesis-sheet/sheet.json', {
      generatedBy: 'tests/browser/genesis-sheet.spec.ts (GENESIS=1)',
      resolution: { grid: GRID, note: '512² lab exploration grid; §4.2 seed radii are in chemical cells' },
      seed: SEED,
      parameters: PARAMETERS,
      stepsPerKind: STEPS,
      note:
        'One representative field per §4.4 genesis kind at a single recorded seed. `radial` is the ' +
        'near-threshold kind and is allowed to be near-dead. `alive` = finite field with nonzero ' +
        'occupancy and nonzero reaction activity.',
      rejectedRuns: {
        steps: REJECTED_STEPS,
        note:
          'Metrics-only record of the rejected longer growth budget (no PNGs): at 8000 delivered steps ' +
          'every kind is alive but has grown toward the same mature labyrinth, so the shapes are no ' +
          'longer distinctive and the sheet uses 4000 steps.',
        rows: rejectedRuns,
      },
      rows,
    });

    console.info(
      `[genesis] rejected ${REJECTED_STEPS}-step budget: occupancy ` +
        `${Math.min(...rejectedOccupancies).toFixed(4)}–${Math.max(...rejectedOccupancies).toFixed(4)} across kinds`,
    );

    console.info(
      `[genesis] ${rows.length} kinds captured; radial ${radial.alive ? 'nucleated' : 'near-threshold (not nucleated)'} ` +
        `(occ=${radial.summary.occupiedFraction.toFixed(4)})`,
    );

    expect(rows.length).toBe(KINDS.length);
    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
