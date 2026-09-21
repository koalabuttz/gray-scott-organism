/**
 * §6.5 discovery driver — `scripts/explore.ts`.
 *
 * A Playwright driver, **not a second solver** (§6.5): it loads the real page, switches it into the
 * lab-only 512² exploration grid, and for every transition in the shipped trajectory
 * (source endpoint → destination start) it:
 *
 *   1. settles the source field — an inert field is re-seeded with a single viable disk at the
 *      source movement's endpoint parameters and grown for `SETTLE_STEPS` delivered steps;
 *   2. continues *that same field* into the destination movement's start parameters (§6.5:
 *      "transition tests continue the source field into the destination path") and observes for
 *      `OBSERVATION_PERFORMANCE_SECONDS` performance seconds;
 *   3. records per-run descriptors from the real tier-1 reduction and the real field, plus a contact
 *      sheet of the destination state;
 *   4. exports JSON and CSV beside a contact-sheet PNG per transition.
 *
 * It is run for three fixed seeds per transition. Nothing here computes chemistry itself.
 *
 * Usage:
 *   npm run explore
 *   EXPLORE_URL=http://127.0.0.1:5199 npm run explore   # use an already-running server
 *
 * Writes `artifacts/discovery/`. The planner/reducer lives in `src/lab/explorer.ts`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { hook, openArtwork, writeArtifact } from '../tests/support/browser.ts';
import { montagePng, writeJson, writePng } from '../tests/support/evidence.ts';
import { validateTrajectoryDocument } from '../src/curator/schema.ts';
import type { TrajectoryDocument } from '../src/curator/schema.ts';
import type { GenesisCommand } from '../src/core/types.ts';
import { createSingleSeedCommand } from '../src/simulation/genesis.ts';
import {
  DISCOVERY_GRID,
  DISCOVERY_SEEDS,
  OBSERVATION_PERFORMANCE_SECONDS,
  OBSERVATION_SLICE_STEPS,
  SETTLE_STEPS,
  genesisCommandSignature,
  requireExploration,
  shippedTransitions,
  summarizeSamples,
  transitionEntryGenesis,
  type DescriptorSample,
  type RunDescriptors,
  type TransitionSpec,
} from '../src/lab/explorer.ts';

const PORT = Number(process.env['EXPLORE_PORT'] ?? 5198);
const BASE_URL = process.env['EXPLORE_URL'] ?? `http://127.0.0.1:${PORT}`;
/** Same launch recipe as the default Playwright project (playwright.config.ts, deviation 19). */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
  '--use-angle=vulkan',
];

const SLICES_PER_RUN = (OBSERVATION_PERFORMANCE_SECONDS * 120) / OBSERVATION_SLICE_STEPS;

interface HealthSample {
  occupiedFraction: number;
  flux: number;
  change: number;
}

interface SummaryShape {
  occupiedFraction: number;
  meanV: number;
  maxV: number;
  centroidUV: [number, number];
}

interface RunResult {
  transition: TransitionSpec;
  seed: number;
  grid: number;
  settleSteps: number;
  sourceOccupancy: number;
  /** The settle-seed origin the destination entry genesis displaces from (§6.4). */
  priorOrigin: [number, number];
  /**
   * The command the curator would issue when entering the destination movement, built with the
   * curator's own construction semantics (root-seeded perturbation + rebirth displacement), or null
   * when the destination declares no `enterGenesis`.
   */
  entryGenesisCommand: GenesisCommand | null;
  /** Stable one-line signature of `entryGenesisCommand` (auditable per-run). */
  entryGenesisSignature: string | null;
  /** True when the destination movement's `enterGenesis` was applied on entry (as the curator does). */
  entryGenesisIssued: boolean;
  descriptors: RunDescriptors;
  samples: DescriptorSample[];
  file: string;
  png: string;
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`dev server at ${url} did not become ready in ${timeoutMs}ms`);
}

function startServer(): ReturnType<typeof spawn> {
  const vite = resolve('node_modules/.bin/vite');
  return spawn(vite, ['--host', '127.0.0.1', '--port', String(PORT)], { stdio: 'inherit' });
}

async function runTransition(
  browser: Browser,
  document: TrajectoryDocument,
  transition: TransitionSpec,
  seed: number,
): Promise<RunResult> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    const probe = await openArtwork(page);
    if (!probe.ok) throw new Error(`transition ${transition.id} seed ${seed}: WebGL2 did not start: ${probe.reason}`);

    await hook(page, 'setExploration', [true]);
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    const snapshot = await hook<{ explorationActive: boolean; simulationResolution: number }>(page, 'labSnapshot');
    requireExploration(snapshot.explorationActive);

    // 1) Settle the source field at the source endpoint's parameters.
    await hook(page, 'reset');
    await hook(page, 'setParameters', [transition.source.params]);
    const genesis = createSingleSeedCommand({
      center: [0.5, 0.5],
      seed,
      perturb: true,
      radiusCells: 6,
      strength: 1,
      mode: 'replace',
    });
    await hook(page, 'applyGenesis', [genesis]);
    await hook(page, 'simulate', [SETTLE_STEPS]);
    const sourceHealth = await hook<HealthSample | null>(page, 'analysisSampleForTest', [8000]);

    // 2) Continue the source field into the destination start parameters and observe. If the
    //    destination movement declares an `enterGenesis`, issue it exactly as the curator would on
    //    entry: a `replace` at a root-seeded perturbation of the library entry, displaced from the
    //    settle seed's origin (§6.4). The command is built by the curator's shared construction and
    //    recorded below, so the trial is auditable and genuinely differs across seeds.
    await hook(page, 'setParameters', [transition.destination.params]);
    const priorOrigin: [number, number] = [genesis.center[0], genesis.center[1]];
    const entryGenesisCommand = transitionEntryGenesis(document, transition, seed, priorOrigin);
    let entryGenesisIssued = false;
    if (entryGenesisCommand) {
      await hook(page, 'applyGenesis', [entryGenesisCommand]);
      entryGenesisIssued = true;
    }
    const samples: DescriptorSample[] = [];
    for (let slice = 1; slice <= SLICES_PER_RUN; slice += 1) {
      await hook(page, 'simulate', [OBSERVATION_SLICE_STEPS]);
      const health = await hook<HealthSample | null>(page, 'analysisSampleForTest', [8000]);
      const summary = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
      samples.push({
        performanceSeconds: (slice * OBSERVATION_SLICE_STEPS) / 120,
        steps: SETTLE_STEPS + slice * OBSERVATION_SLICE_STEPS,
        occupiedFraction: health ? health.occupiedFraction : summary.occupiedFraction,
        activity: health ? health.flux : 0,
        changeRate: health ? health.change : 0,
        centroidUV: summary.centroidUV,
      });
    }

    await hook(page, 'renderOnce');
    const png = await hook<string>(page, 'capturePngBase64');
    const file = `discovery/${transition.id}/seed-${seed}.png`;
    writePng(file, png);

    return {
      transition,
      seed,
      grid: DISCOVERY_GRID,
      settleSteps: SETTLE_STEPS,
      sourceOccupancy: sourceHealth ? sourceHealth.occupiedFraction : 0,
      priorOrigin,
      entryGenesisCommand,
      entryGenesisSignature: entryGenesisCommand ? genesisCommandSignature(entryGenesisCommand) : null,
      entryGenesisIssued,
      descriptors: summarizeSamples(samples),
      samples,
      file,
      png,
    };
  } finally {
    await context.close();
  }
}

function csvHeader(): string {
  return [
    'transition',
    'source',
    'destination',
    'seed',
    'sample',
    'performanceSeconds',
    'steps',
    'occupiedFraction',
    'activity',
    'changeRate',
    'centroidU',
    'centroidV',
  ].join(',');
}

function csvRow(run: RunResult, sample: DescriptorSample, index: number): string {
  return [
    run.transition.id,
    run.transition.source.movement,
    run.transition.destination.movement,
    run.seed,
    index,
    sample.performanceSeconds.toFixed(3),
    sample.steps,
    sample.occupiedFraction.toFixed(6),
    sample.activity.toExponential(6),
    sample.changeRate.toExponential(6),
    sample.centroidUV[0].toFixed(4),
    sample.centroidUV[1].toFixed(4),
  ].join(',');
}

async function main(): Promise<void> {
  const document = validateTrajectoryDocument(
    JSON.parse(readFileSync(resolve('public/trajectories/default.json'), 'utf8')) as unknown,
  );
  const transitions = shippedTransitions(document);
  console.info(`[explore] ${transitions.length} transitions x ${DISCOVERY_SEEDS.length} seeds at ${DISCOVERY_GRID}²`);

  const server = process.env['EXPLORE_URL'] ? null : startServer();
  try {
    await waitForServer(BASE_URL);
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args: LAUNCH_ARGS });
    // One long-lived montage page: the contact sheet is composed in-page from decoded PNG tiles.
    const montageContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const montagePage: Page = await montageContext.newPage();
    try {
      const runs: RunResult[] = [];
      for (const transition of transitions) {
        const transitionRuns: RunResult[] = [];
        for (const seed of DISCOVERY_SEEDS) {
          const run = await runTransition(browser, document, transition, seed);
          transitionRuns.push(run);
          runs.push(run);
          console.info(
            `[explore] ${transition.id} seed=${seed}: src occ=${run.sourceOccupancy.toFixed(4)}` +
              `${run.entryGenesisIssued ? ' +entryGenesis' : ''} -> ` +
              `dest occ ${run.descriptors.occupancy.min.toFixed(4)}..${run.descriptors.occupancy.max.toFixed(4)} ` +
              `(mean ${run.descriptors.occupancy.mean.toFixed(4)}, trend ${run.descriptors.occupancyTrend >= 0 ? '+' : ''}${run.descriptors.occupancyTrend.toFixed(4)}), ` +
              `activity mean ${run.descriptors.activity.mean.toExponential(2)}`,
          );
        }

        const sheet = await montagePng(montagePage, transitionRuns.map((run) => run.png), transitionRuns.length, 512);
        const sheetPath = `discovery/${transition.id}/contact-sheet.png`;
        writePng(sheetPath, sheet);

        writeJson(`discovery/${transition.id}/runs.json`, {
          transition,
          grid: DISCOVERY_GRID,
          seeds: DISCOVERY_SEEDS,
          settleSteps: SETTLE_STEPS,
          observationPerformanceSeconds: OBSERVATION_PERFORMANCE_SECONDS,
          observationSliceSteps: OBSERVATION_SLICE_STEPS,
          contactSheet: sheetPath,
          note:
            'Descriptors are tier-1 full-domain health fields (occupancy, reaction activity, change '
            + 'rate) plus the coarse occupied centroid; `beta0Approx`/`beta1Approx` are presentation-'
            + 'tier (Phase 3) and are not available here. `entryGenesisCommand` is built by the '
            + 'curator\'s own construction (`buildEntryGenesisCommand`): a root-seeded perturbation of '
            + 'the destination movement\'s `enterGenesis` library entry, displaced from the settle-seed '
            + 'origin by `MIN_REBIRTH_DISPLACEMENT`; `entryGenesisSignature` is its stable one-line form.',
          runs: transitionRuns.map((run) => ({
            seed: run.seed,
            sourceOccupancy: run.sourceOccupancy,
            priorOrigin: run.priorOrigin,
            entryGenesisCommand: run.entryGenesisCommand,
            entryGenesisSignature: run.entryGenesisSignature,
            entryGenesisIssued: run.entryGenesisIssued,
            descriptors: run.descriptors,
            samples: run.samples,
            file: run.file,
          })),
        });
      }

      writeJson('discovery/descriptors.json', {
        generatedBy: 'scripts/explore.ts (§6.5 discovery driver)',
        trajectoryId: document.id,
        grid: DISCOVERY_GRID,
        seeds: DISCOVERY_SEEDS,
        settleSteps: SETTLE_STEPS,
        observationPerformanceSeconds: OBSERVATION_PERFORMANCE_SECONDS,
        transitions: transitions.map((t) => ({ id: t.id, index: t.index, source: t.source, destination: t.destination })),
        runs: runs.map((run) => ({
          transition: run.transition.id,
          seed: run.seed,
          sourceOccupancy: run.sourceOccupancy,
          priorOrigin: run.priorOrigin,
          entryGenesisCommand: run.entryGenesisCommand,
          entryGenesisSignature: run.entryGenesisSignature,
          entryGenesisIssued: run.entryGenesisIssued,
          descriptors: run.descriptors,
        })),
      });

      const rows: string[] = [csvHeader()];
      for (const run of runs) {
        run.samples.forEach((sample, index) => rows.push(csvRow(run, sample, index)));
      }
      writeArtifact('discovery/descriptors.csv', `${rows.join('\n')}\n`);
      writeJson('discovery/README.json', {
        note: 'See descriptors.json (per-run descriptors) and descriptors.csv (per-sample series).',
        contactSheets: transitions.map((t) => `discovery/${t.id}/contact-sheet.png`),
      });

      console.info(`[explore] wrote ${transitions.length} contact sheets and ${runs.length} runs to artifacts/discovery/`);
    } finally {
      await montageContext.close();
      await browser.close();
    }
  } finally {
    if (server) server.kill('SIGTERM');
  }
}

main().catch((error: unknown) => {
  console.error('[explore] failed:', error);
  process.exitCode = 1;
});
