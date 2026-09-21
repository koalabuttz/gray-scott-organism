/**
 * RESCUE=1 — §6.4 premature-extinction evidence (repurposed post deviation-48 trend refinement).
 *
 * The three legacy 1× arcs (`arcs.spec.ts`, ARCS=1) predate both the extinction-decision telemetry and
 * the deviation-48 trend refinement; they each recorded exactly one injection rescue during NUCLEATION.
 * After the refinement, a *rising* young field below the dead thresholds is no longer rescued, so the
 * retuned presentation arc is rescue-free (`artifacts/arcs/arc-tuned/summary.json` records
 * `rescueCount: 0`). This focused run therefore no longer claims to reproduce a nucleation rescue.
 * Instead it records two things against the live app:
 *
 *   1. **No spurious rescue while the field is rising.** Under the tuned arc conditions (the shipped
 *      deviation-45 trajectory, auto-seed, the presentation default speed) the arc walks
 *      dormancy → nucleation → cellular-growth with **zero** rescue actions, because the nucleation
 *      field is below the dead thresholds but rising (deviation 48's "below threshold **and** not
 *      growing" rule).
 *   2. **A genuine dead field is still rescued within the one-rescue budget.** A deliberate dead
 *      fixture — the tuned seed run at a dead `k` (0.07, above the measured ≈.0649 death boundary) —
 *      still reaches the 20 s extinction decision and fires its single bounded injection rescue, with
 *      `occupancyGrowing: false`. This is the flat/decaying case the refinement must preserve.
 *
 * It also regenerates `artifacts/arcs/summary.json`'s §6.4 narrative (shared with `arcs.spec.ts`) and
 * per-arc `rescueMovements`. The three legacy 1× arcs are deliberately **not** re-run (a full arc is
 * ≈16 minutes at 1×); their measured rows are preserved exactly.
 *
 * Run: `RESCUE=1 npx playwright test --project=headless-gpu nucleation-rescue.spec.ts`
 * (or `npm run test:rescue`). Writes `artifacts/arcs/nucleation-rescue.json` and refreshes
 * `artifacts/arcs/summary.json`.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hook, openArtwork } from '../support/browser.ts';
import { ARCS_SUMMARY_NARRATIVE, ARCS_SUMMARY_NOTE } from '../support/arcs.ts';
import { writeJson } from '../support/evidence.ts';

const ENABLED = process.env['RESCUE'] === '1';

/** The same seed as the first recorded arc, so the run is comparable with the legacy rows. */
const SEED = 8_100_001;
const BASE_URL = 'http://127.0.0.1:5199';
const POLL_MS = 300;

/** A dead regime: k above the measured ≈.0649 death boundary, so a fresh seed decays. */
const DEAD_PARAMS = { F: 0.03, k: 0.07, Du: 0.16, Dv: 0.08 } as const;

const ARTIFACTS_DIR = resolve(process.cwd(), 'artifacts');

interface PhaseShape {
  movement: string;
  intention: string;
  arc: number;
}

interface MovementEvent {
  movement: string;
  intention: string;
  arc: number;
  performanceSeconds: number;
  realSeconds: number;
}

interface ExtinctionDecisionShape {
  performanceSeconds: number;
  arc: number;
  movement: string;
  intention: string;
  parameters: { F: number; k: number; Du: number; Dv: number };
  healthValid: boolean;
  healthAgeSeconds: number;
  healthOccupiedFraction: number;
  healthReactionActivity: number;
  occupancyGrowing: boolean;
  deadSeconds: number;
  action: 'rescue' | 'recovery' | 'none';
  recoveryMovement: string | null;
}

interface RecordedSummaryRow {
  seed: number;
  rescueCount?: number;
  [key: string]: unknown;
}

interface RecordedSummary {
  arcs: RecordedSummaryRow[];
  [key: string]: unknown;
}

interface RecordedArc {
  movementTimeline: MovementEvent[];
  genesisLog: Array<{ mode: string; performanceSeconds: number }>;
}

/** The movement active at a given performance time, from a recorded movement timeline. */
function movementAt(timeline: MovementEvent[], performanceSeconds: number): string | null {
  let active: string | null = null;
  for (const event of timeline) {
    if (event.performanceSeconds <= performanceSeconds) active = event.movement;
    else break;
  }
  return active;
}

/**
 * Regenerate `artifacts/arcs/summary.json`'s narrative from the recorded arcs: preserve every measured
 * row, add per-arc `rescueMovements` derived from each arc's own genesis log + timeline, and write the
 * corrected §6.4 narrative. The legacy 1× rows are never re-run. Returns the regenerated rows.
 */
function regenerateSummary(): RecordedSummaryRow[] {
  let summary: RecordedSummary;
  try {
    summary = JSON.parse(readFileSync(resolve(ARTIFACTS_DIR, 'arcs/summary.json'), 'utf8')) as RecordedSummary;
  } catch (error) {
    console.warn(`[rescue] no recorded arcs/summary.json to refresh: ${String(error)}`);
    return [];
  }
  const rows = summary.arcs.map((row): RecordedSummaryRow => {
    let rescueMovements: string[] = [];
    let rescueCount = row.rescueCount ?? 0;
    try {
      const arc = JSON.parse(
        readFileSync(resolve(ARTIFACTS_DIR, `arcs/arc-${row.seed}/arc.json`), 'utf8'),
      ) as RecordedArc;
      const injections = arc.genesisLog.filter((genesis) => genesis.mode === 'inject');
      rescueCount = injections.length;
      rescueMovements = [
        ...new Set(
          injections
            .map((genesis) => movementAt(arc.movementTimeline, genesis.performanceSeconds))
            .filter((movement): movement is string => movement !== null),
        ),
      ];
    } catch {
      // No recorded arc JSON beside the row: keep the recorded rescueCount and an empty derivation.
    }
    return {
      ...row,
      rescueCount,
      // These rows predate both the telemetry and the deviation-48 refinement.
      extinctionTelemetryRecorded: false,
      extinctionDecisionCount: 0,
      rescueMovements,
    };
  });

  writeJson('arcs/summary.json', {
    ...summary,
    generatedBy:
      'tests/browser/arcs.spec.ts (ARCS=1) rows, narrative regenerated by '
      + 'tests/browser/nucleation-rescue.spec.ts (RESCUE=1)',
    speed: 1,
    note: ARCS_SUMMARY_NOTE,
    narrative: ARCS_SUMMARY_NARRATIVE,
    narrativeRegeneratedBy: 'tests/browser/nucleation-rescue.spec.ts (RESCUE=1)',
    arcs: rows,
    nucleationRescue: {
      file: 'arcs/nucleation-rescue.json',
      note:
        'The three rows above are the legacy pre-refinement 1× arcs (preserved, not re-run). '
        + '`npm run test:rescue` (RESCUE=1) now records the post-refinement evidence instead: no spurious '
        + 'rescue while the tuned field rises, and a deliberate dead fixture that still fires its one '
        + 'bounded rescue.',
    },
  });
  return rows;
}

/** The evidence file written by the rising-suppression test, so the dead-fixture test can merge into it. */
function readExistingEvidence(): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(resolve(ARTIFACTS_DIR, 'arcs/nucleation-rescue.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

test.describe('RESCUE=1 §6.4 premature-extinction evidence', () => {
  test.skip(!ENABLED, 'set RESCUE=1 to record the §6.4 premature-extinction evidence');

  test('the retuned field rises through nucleation with no spurious rescue', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      const probe = await openArtwork(page);
      expect(probe.ok, `WebGL2 did not start: ${probe.reason}`).toBe(true);

      await hook(page, 'setAutoSeed', [true]);
      await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
      // Leave the presentation default speed in force (deviation 44: 3×).
      await hook(page, 'setPaused', [false]);

      const movementTimeline: MovementEvent[] = [];
      const nucleationHealth: number[] = [];
      let decisions: ExtinctionDecisionShape[] = [];
      let rescues: ExtinctionDecisionShape[] = [];
      let lastMovement: string | null = null;
      let growthAt: number | null = null;
      const started = Date.now();

      while (Date.now() - started < 150_000) {
        const phase = await hook<PhaseShape>(page, 'curatorPhase');
        const clock = await hook<{ performanceSeconds: number }>(page, 'clock');
        const realSeconds = (Date.now() - started) / 1000;
        if (phase.movement !== lastMovement) {
          movementTimeline.push({
            movement: phase.movement,
            intention: phase.intention,
            arc: phase.arc,
            performanceSeconds: clock.performanceSeconds,
            realSeconds,
          });
          lastMovement = phase.movement;
          if (phase.movement === 'cellular-growth') growthAt = clock.performanceSeconds;
        }
        if (phase.movement === 'nucleation') {
          const health = await hook<{ valid: boolean; fullOccupiedFraction: number } | null>(page, 'chemistryHealth');
          if (health?.valid) nucleationHealth.push(health.fullOccupiedFraction);
        }
        decisions = await hook<ExtinctionDecisionShape[]>(page, 'extinctionLog');
        rescues = decisions.filter((decision) => decision.action === 'rescue');
        if (rescues.length > 0) break; // fail fast to the assertion below
        if (growthAt !== null && clock.performanceSeconds > growthAt + 15) break;
        if (phase.arc >= 1) break;
        await page.waitForTimeout(POLL_MS);
      }

      const risingEvidence =
        nucleationHealth.length >= 2
          ? Math.max(...nucleationHealth) >= nucleationHealth[0]!
          : null;

      writeJson('arcs/nucleation-rescue.json', {
        generatedBy: 'tests/browser/nucleation-rescue.spec.ts (RESCUE=1)',
        seed: SEED,
        note:
          'Post-refinement (deviation 48) §6.4 evidence. `risingSuppression` shows the tuned arc rising '
          + 'through nucleation with zero rescues; `deadFixture` shows a deliberate dead `k` still firing '
          + 'its one bounded rescue. The legacy pre-refinement 1× arcs in arcs/summary.json are preserved, '
          + 'not re-run.',
        risingSuppression: {
          speed: 3,
          movementTimeline,
          rescues: rescues.length,
          extinctionDecisions: decisions,
          cellularGrowthEnteredAt: growthAt,
          nucleationOccupancySamples: nucleationHealth,
          nucleationOccupancyRising: risingEvidence,
        },
      });

      expect(errors, errors.join(' | ')).toEqual([]);
      expect(rescues.length, 'no spurious rescue while the retuned field rises').toBe(0);
      expect(growthAt, 'cellular growth was reached after nucleation').not.toBeNull();
      console.info(
        `[rescue] rising: movements=${movementTimeline.map((m) => m.movement).join('>')} rescues=0 ` +
          `growth@${growthAt?.toFixed(1) ?? 'n/a'} perf s decisions=${decisions.length}`,
      );

      const rows = regenerateSummary();
      for (const row of rows) {
        if (row.seed === SEED) {
          expect(row.rescueMovements, 'the legacy recorded arc rescue is still attributed to nucleation').toEqual([
            'nucleation',
          ]);
        }
      }
    } finally {
      await context.close();
    }
  });

  test('a deliberate dead field still fires its one bounded rescue within the window', async ({ browser }) => {
    test.setTimeout(6 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      const probe = await openArtwork(page);
      expect(probe.ok, `WebGL2 did not start: ${probe.reason}`).toBe(true);

      await hook(page, 'setAutoSeed', [true]);
      await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
      // Pin a dead regime *after* restart (restart clears the override), so a fresh seed decays.
      await hook(page, 'setParameters', [DEAD_PARAMS]);
      await hook(page, 'setPaused', [false]);

      const movementTimeline: MovementEvent[] = [];
      let decisions: ExtinctionDecisionShape[] = [];
      let rescues: ExtinctionDecisionShape[] = [];
      let lastMovement: string | null = null;
      const started = Date.now();

      while (Date.now() - started < 150_000) {
        const phase = await hook<PhaseShape>(page, 'curatorPhase');
        const clock = await hook<{ performanceSeconds: number }>(page, 'clock');
        const realSeconds = (Date.now() - started) / 1000;
        if (phase.movement !== lastMovement) {
          movementTimeline.push({
            movement: phase.movement,
            intention: phase.intention,
            arc: phase.arc,
            performanceSeconds: clock.performanceSeconds,
            realSeconds,
          });
          lastMovement = phase.movement;
        }
        decisions = await hook<ExtinctionDecisionShape[]>(page, 'extinctionLog');
        rescues = decisions.filter((decision) => decision.action === 'rescue');
        if (rescues.length >= 1) break;
        if (phase.arc >= 1) break;
        await page.waitForTimeout(POLL_MS);
      }

      // Give the arc a grace window: a second rescue action must be impossible within the arc budget.
      let rescuesAfterGrace = rescues.length;
      if (rescues.length >= 1) {
        await page.waitForTimeout(4000);
        const after = await hook<ExtinctionDecisionShape[]>(page, 'extinctionLog');
        rescuesAfterGrace = after.filter((decision) => decision.action === 'rescue').length;
        decisions = after;
      }
      await hook(page, 'releaseParameters');

      const rescue = rescues[0];
      writeJson('arcs/nucleation-rescue.json', {
        ...readExistingEvidence(),
        generatedBy: 'tests/browser/nucleation-rescue.spec.ts (RESCUE=1)',
        seed: SEED,
        note:
          'Post-refinement (deviation 48) §6.4 evidence. `risingSuppression` shows the tuned arc rising '
          + 'through nucleation with zero rescues; `deadFixture` shows a deliberate dead `k` still firing '
          + 'its one bounded rescue. The legacy pre-refinement 1× arcs in arcs/summary.json are preserved, '
          + 'not re-run.',
        deadFixture: {
          parameters: DEAD_PARAMS,
          movementTimeline,
          rescues: decisions.filter((decision) => decision.action === 'rescue'),
          extinctionDecisions: decisions,
          observations: {
            rescueAt: rescue?.performanceSeconds ?? null,
            rescueDeadSeconds: rescue?.deadSeconds ?? null,
            rescueIntention: rescue?.intention ?? null,
            rescueOccupancyGrowing: rescue?.occupancyGrowing ?? null,
            hOccupiedFraction: rescue?.healthOccupiedFraction ?? null,
            rescuesAfterGrace,
          },
        },
      });

      expect(errors, errors.join(' | ')).toEqual([]);
      expect(rescues.length, 'a genuinely dead field is still rescued').toBe(1);
      const recorded = rescues[0]!;
      expect(recorded.action, 'the decision is a rescue, not a recovery').toBe('rescue');
      expect(recorded.intention, 'the rescue fires on the emerging intention').toBe('emerge');
      expect(recorded.deadSeconds, 'the dead-duration accumulator reached the 20 s window').toBeGreaterThanOrEqual(19.9);
      expect(recorded.occupancyGrowing, 'the dead field was not rising').toBe(false);
      expect(rescuesAfterGrace, 'the one-rescue-per-arc budget holds').toBe(1);
      console.info(
        `[rescue] dead fixture: rescue @${recorded.performanceSeconds.toFixed(2)} perf s ` +
          `(deadSeconds=${recorded.deadSeconds.toFixed(2)}, intention=${recorded.intention}, ` +
          `occupancyGrowing=${recorded.occupancyGrowing}), decisions=${decisions.length}`,
      );
    } finally {
      await context.close();
    }
  });
});
