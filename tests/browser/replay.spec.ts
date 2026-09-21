/**
 * REPLAY=1 — fixed-seed replay on the same GPU (§12.2, AC.9).
 *
 * Runs the *same* recorded seed twice in two **fresh, independent browser contexts** (separate App
 * instances, separate GL contexts) and records, for both runs, the configuration, the full genesis
 * command sequence with its performance-time brackets, and descriptor checkpoints (tier-1 chemistry
 * health + coarse full-domain occupancy) at exact delivered-step marks. It then asserts the command
 * sequences are byte-identical and the descriptor checkpoints agree within a documented tolerance.
 *
 * Determinism strategy. The transport is **paused before the restart** and stays paused for the whole
 * run, so no frame can deliver a step between the restart and a checkpoint: a fresh page is already
 * stepping chemistry from its first frame, and `restart` resets the clock but not the paused flag. The
 * composition is then driven through the deterministic synchronous driver (`advanceComposition`) in
 * fixed 500-step chunks, which accounts each batch to the clock so the clock's delivered-step and
 * delivered-time counters are the exact mark. Because the transport is paused no *new* analysis is
 * requested by the frame loop, but a sample published at one checkpoint stays valid and is consumed
 * by the curator on the following batch under a frozen performance clock — a deliberate synthetic
 * schedule, not production frame fidelity. Progress advances on **elapsed performance time only**
 * between fresh samples — one more source of cross-run drift removed.
 *
 * State alignment is asserted, not tolerated. Immediately after setup both runs must be at delivered
 * step 0 / numerical time 0, and at every checkpoint the delivered-step mark and delivered numerical
 * time must **exactly** equal the intended mark; a mismatch fails before any descriptor delta is
 * computed, so the reported deltas are only ever between genuinely equal states. Two further exact
 * checks tie the run to that mark: the solver's *own* step counter (which legitimately resets on a
 * `replace` genesis) must advance by exactly `CHUNK_STEPS` between checkpoints unless a replacement
 * bumped the epoch — which is what catches the frame-loop drift the previous revision tolerated — and
 * the solver's step/time state and field epoch must be exactly equal between the two runs at every
 * checkpoint. (The previous revision tolerated a persistent 3-step offset between the runs, which made
 * its 2e-3 descriptor bound unjustified.)
 *
 * The descriptor checkpoints are still *real*: each one issues the genuine tier-1 GPU reduction
 * readback and reads the genuine field, so a numerical divergence in the solver would show up in the
 * deltas even though the composition path is deterministic.
 *
 * Tolerance. Identical seed, identical parameters, identical *asserted-equal* delivered-step marks,
 * same GPU: the chemistry is a deterministic function of the step count, so the expected delta is
 * exactly zero. The bound is an engineering margin of two occupied cells in the 768² (589 824-cell)
 * full-domain count — see `DESCRIPTOR_TOLERANCE` — and the measured maxima are recorded in the report
 * so the bound is justified by data rather than asserted.
 *
 * Run: `REPLAY=1 npx playwright test --project=headless-gpu replay.spec.ts` (or `npm run test:replay`).
 * Writes `artifacts/replay/`.
 */
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import { writeJson } from '../support/evidence.ts';
import type {
  CoarseOccupancyShape,
  GenesisCommandShape,
  PhaseShape,
  SummaryShape,
} from '../support/types.ts';

const ENABLED = process.env['REPLAY'] === '1';

const SEED = 4_242_042;
const CHUNK_STEPS = 500;
const CHUNKS = 40; // 20 000 delivered steps ≈ 166.7 performance seconds.

/** The fixed simulation step size (`TIME.dt`), which the delivered numerical time is a multiple of. */
const DT = 1;

/** One occupied cell in the 768² full-domain occupancy count (768 × 768 = 589 824 cells). */
const SINGLE_CELL = 1 / (768 * 768);

/**
 * Descriptor tolerance, re-derived from the aligned observations (this replaces the inherited 2e-3).
 *
 * With both runs at exactly the same delivered-step mark and delivered numerical time (asserted
 * above, failing before any delta is computed), and with the solver's own step/time state and field
 * epoch asserted equal between the runs at every checkpoint, the chemistry is a deterministic
 * function of the step count and the reduction is the same GPU program on the same device — so the
 * expected delta is exactly zero. The bound is therefore a stated engineering margin of **two occupied
 * cells**: it absorbs a hypothetical one-cell difference in the occupancy reduction while being far too
 * tight to hide a real divergence. The observed maxima are recorded in the report.
 */
const DESCRIPTOR_TOLERANCE = 2 * SINGLE_CELL; // ≈ 3.39e-6
const BASE_URL = 'http://127.0.0.1:5199';

interface HealthShape {
  valid: boolean;
  ageSeconds: number;
  fullOccupiedFraction: number;
  fullReactionActivity: number;
  fullChangeRate: number;
}

interface Checkpoint {
  chunk: number;
  /** Cumulative delivered-step mark (the clock's authoritative counter): exactly chunk × CHUNK_STEPS. */
  steps: number;
  /** Cumulative delivered numerical time at the mark: exactly `steps × DT`. */
  simulationTime: number;
  /** Solver step count *since the last field replacement* (resets on a `replace` genesis). */
  solverSteps: number;
  /** Solver numerical time since the last field replacement. */
  solverSimulationTime: number;
  /** Field epoch — increments on every `replace`; equal between runs proves the same replace history. */
  epoch: number;
  performanceSeconds: number;
  movement: string;
  arc: number;
  parameters: { F: number; k: number; Du: number; Dv: number };
  genesisCount: number;
  health: { occupiedFraction: number; flux: number; change: number } | null;
  coarseOccupancy: number;
  coarseCentroid: [number, number];
}

interface RunRecord {
  seed: number;
  trajectoryId: string;
  /** The full exported trajectory document (serialized), so configuration is compared in full. */
  trajectoryDocument: string;
  movements: string[];
  grid: { width: number; height: number };
  simulationResolution: number;
  speed: number;
  epoch: number;
  /** Authoritative delivered step/time right after setup, asserted to be exactly zero in both runs. */
  stepsAtSetup: number;
  simulationTimeAtSetup: number;
  commands: Array<{ chunk: number; performanceSeconds: number; signature: string }>;
  checkpoints: Checkpoint[];
}

function signature(command: GenesisCommandShape): string {
  return (
    `${command.kind}|${command.mode}|${command.seed}|${command.center[0].toFixed(9)}|` +
    `${command.center[1].toFixed(9)}|${command.radiusCells.toFixed(9)}|${command.strength.toFixed(9)}`
  );
}

async function openFreshPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const probe = await openArtwork(page);
  expect(probe.ok, `WebGL2 did not start: ${probe.reason}`).toBe(true);
  return { page, close: () => context.close() };
}

/** Drive one full replay run and return everything the comparison needs. */
async function runOnce(page: Page): Promise<RunRecord> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Pause BEFORE the restart. A fresh page is already stepping chemistry; `restart` resets the clock
  // but not the paused flag, so pausing first closes the window in which a frame could deliver steps
  // between the reset and the first checkpoint (the source of the previous 3-step offset).
  await hook(page, 'setPaused', [true]);
  await hook(page, 'setAutoSeed', [true]);
  await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);

  // Assert the setup invariant before any stepping: paused, and delivered step/time both zero.
  const clockAtSetup = await hook<{ paused: boolean; steps: number; simulationTime: number }>(page, 'clock');
  const solverStepsAtSetup = await hook<number>(page, 'steps');
  const solverTimeAtSetup = await hook<number>(page, 'simulationTime');
  expect(clockAtSetup.paused, 'transport is paused for the replay').toBe(true);
  expect(clockAtSetup.steps, 'no step is delivered before the checkpoint loop').toBe(0);
  expect(clockAtSetup.simulationTime, 'no numerical time elapses before the checkpoint loop').toBe(0);
  expect(solverStepsAtSetup, 'the solver step count is 0 before the checkpoint loop').toBe(0);
  expect(solverTimeAtSetup, 'the solver numerical time is 0 before the checkpoint loop').toBe(0);

  const info = await hook<{ source: string; id: string; movements: string[] }>(page, 'trajectoryInfo');
  const trajectoryDocument = await hook<string>(page, 'exportTrajectory');
  const grid = await hook<{ width: number; height: number }>(page, 'simulationSize');
  const simulationResolution = (await hook<{ simulationResolution: number }>(page, 'labSnapshot'))
    .simulationResolution;

  const commands: RunRecord['commands'] = [];
  const checkpoints: Checkpoint[] = [];
  let seenCommands = 0;

  for (let chunk = 1; chunk <= CHUNKS; chunk += 1) {
    const advanced = await hook<{ steps: number; phase: PhaseShape; epoch: number; simulationTime: number }>(
      page,
      'advanceComposition',
      [CHUNK_STEPS],
    );
    const steps = chunk * CHUNK_STEPS;
    const intendedTime = steps * DT;
    const performanceSeconds = steps / 120;

    // Delivered-work mark: exact. Fail here, before any descriptor delta is computed.
    const clock = await hook<{ steps: number; simulationTime: number }>(page, 'clock');
    expect(clock.steps, `chunk ${chunk}: the delivered-step mark is exact`).toBe(steps);
    expect(clock.simulationTime, `chunk ${chunk}: the delivered numerical time is exact`).toBe(intendedTime);
    // Solver state since the last field replacement: internally consistent (this is the state the
    // descriptors describe).
    const solverSteps = await hook<number>(page, 'steps');
    const solverSimulationTime = await hook<number>(page, 'simulationTime');
    expect(solverSimulationTime, `chunk ${chunk}: solver numerical time = solver steps × dt`).toBe(
      solverSteps * DT,
    );

    // New genesis commands, timestamped at the chunk boundary (resolution = CHUNK_STEPS/120 perf s).
    const log = await hook<GenesisCommandShape[]>(page, 'genesisLog');
    while (seenCommands < log.length) {
      commands.push({ chunk, performanceSeconds, signature: signature(log[seenCommands]!) });
      seenCommands += 1;
    }

    // Force a *fresh* tier-1 reduction for this exact field state. The frame loop is the only poller
    // (automatic composition is on, and `analysisSampleForTest`'s own poll would race it for the same
    // completed slot), so request the sample and wait for the frame loop to deliver it, then read the
    // published health. The field only changes inside `advanceComposition` while paused, so the sample
    // describes exactly the chunk-boundary field.
    const samplesBefore = (await hook<{ samples: number }>(page, 'analysisDiagnostics')).samples;
    let accepted = false;
    for (let attempt = 0; attempt < 25 && !accepted; attempt += 1) {
      accepted = await hook<boolean>(page, 'requestAnalysisOnly');
      if (!accepted) await page.waitForTimeout(20);
    }
    expect(accepted, `chunk ${chunk}: the tier-1 request was accepted`).toBe(true);
    await expect
      .poll(async () => (await hook<{ samples: number }>(page, 'analysisDiagnostics')).samples, {
        timeout: 5_000,
        intervals: [20],
      })
      .toBeGreaterThan(samplesBefore);
    const health = await hook<HealthShape | null>(page, 'chemistryHealth');
    expect(health, `chunk ${chunk}: a tier-1 descriptor sample completed`).not.toBeNull();
    const sample = {
      occupiedFraction: health!.fullOccupiedFraction,
      flux: health!.fullReactionActivity,
      change: health!.fullChangeRate,
    };

    const summary = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
    const coarse = await hook<CoarseOccupancyShape | null>(page, 'coarseOccupancy');

    checkpoints.push({
      chunk,
      steps,
      simulationTime: intendedTime,
      solverSteps,
      solverSimulationTime,
      epoch: advanced.epoch,
      performanceSeconds,
      movement: advanced.phase.movement,
      arc: advanced.phase.arc,
      parameters: await hook<{ F: number; k: number; Du: number; Dv: number }>(page, 'parameters'),
      genesisCount: log.length,
      health: sample,
      coarseOccupancy: coarse ? coarse.occupiedFraction : summary.occupiedFraction,
      coarseCentroid: coarse ? coarse.centroidUV : summary.centroidUV,
    });
  }

  // No step may be delivered outside the batch. Between consecutive checkpoints the solver's step
  // counter must advance by exactly CHUNK_STEPS, unless a `replace` genesis reset it (which also bumps
  // the epoch). This is what makes the absence of frame-loop drift a checked property rather than an
  // assumption.
  for (let i = 1; i < checkpoints.length; i += 1) {
    const prev = checkpoints[i - 1]!;
    const curr = checkpoints[i]!;
    if (curr.epoch === prev.epoch) {
      expect(
        curr.solverSteps - prev.solverSteps,
        `chunk ${curr.chunk}: exactly CHUNK_STEPS delivered since the previous checkpoint`,
      ).toBe(CHUNK_STEPS);
    } else {
      expect(curr.solverSteps, `chunk ${curr.chunk}: a replace reset the solver step counter`).toBeGreaterThan(0);
      expect(curr.solverSteps).toBeLessThanOrEqual(CHUNK_STEPS);
    }
  }

  expect(errors, errors.join(' | ')).toEqual([]);
  return {
    seed: SEED,
    trajectoryId: info.id,
    trajectoryDocument,
    movements: info.movements,
    grid,
    simulationResolution,
    speed: (await hook<{ speed: number }>(page, 'clock')).speed,
    epoch: await hook<number>(page, 'epoch'),
    stepsAtSetup: clockAtSetup.steps,
    simulationTimeAtSetup: clockAtSetup.simulationTime,
    commands,
    checkpoints,
  };
}

test.describe('REPLAY=1 fixed-seed replay', () => {
  test.skip(!ENABLED, 'set REPLAY=1 to run the fixed-seed replay');

  test('the same seed reproduces the same commands and descriptors in two fresh contexts', async ({ browser }) => {
    test.setTimeout(15 * 60_000);

    const first = await openFreshPage(browser);
    let runA: RunRecord;
    try {
      runA = await runOnce(first.page);
    } finally {
      await first.close();
    }

    const second = await openFreshPage(browser);
    let runB: RunRecord;
    try {
      runB = await runOnce(second.page);
    } finally {
      await second.close();
    }

    // 1) Full run configuration agreement — the whole exported trajectory document, the seed, the
    //    grid and resolution, the delivered-step speed and the epoch, not just the trajectory id.
    expect(runA.stepsAtSetup, 'run A starts from delivered step 0').toBe(0);
    expect(runA.simulationTimeAtSetup, 'run A starts from delivered time 0').toBe(0);
    expect(runB.stepsAtSetup, 'run B starts from delivered step 0').toBe(0);
    expect(runB.simulationTimeAtSetup, 'run B starts from delivered time 0').toBe(0);
    expect(runB.seed).toBe(runA.seed);
    expect(runB.trajectoryId, 'same trajectory document').toBe(runA.trajectoryId);
    expect(runB.trajectoryDocument, 'the full exported trajectory document is identical').toBe(
      runA.trajectoryDocument,
    );
    expect(runB.movements).toEqual(runA.movements);
    expect(runB.grid).toEqual(runA.grid);
    expect(runB.simulationResolution).toBe(runA.simulationResolution);
    expect(runB.speed).toBe(runA.speed);
    expect(runB.epoch).toBe(runA.epoch);

    // 2) Byte-identical command sequences, including their performance-time brackets.
    const sigA = runA.commands.map((c) => c.signature);
    const sigB = runB.commands.map((c) => c.signature);
    expect(sigB, 'the genesis command sequence is byte-identical').toEqual(sigA);
    expect(sigB.length, 'the run issued at least one genesis command').toBeGreaterThan(0);
    expect(runB.commands.map((c) => c.chunk), 'commands land in the same chunks').toEqual(
      runA.commands.map((c) => c.chunk),
    );

    // 3) Descriptor checkpoints — exact state alignment first, then deltas within tolerance.
    expect(runB.checkpoints.length).toBe(runA.checkpoints.length);
    let maxOcc = 0;
    let maxFlux = 0;
    let maxChange = 0;
    let maxCoarse = 0;
    let maxMoveDrift = 0;
    for (let i = 0; i < runA.checkpoints.length; i += 1) {
      const a = runA.checkpoints[i]!;
      const b = runB.checkpoints[i]!;
      const mark = (i + 1) * CHUNK_STEPS;
      // Delivered-work mark: exact in both runs.
      expect(a.steps, `checkpoint ${i}: run A is at the intended delivered-step mark`).toBe(mark);
      expect(b.steps, `checkpoint ${i}: run B is at the intended delivered-step mark`).toBe(mark);
      expect(a.simulationTime, `checkpoint ${i}: run A is at the intended delivered time`).toBe(mark * DT);
      expect(b.simulationTime, `checkpoint ${i}: run B is at the intended delivered time`).toBe(mark * DT);
      // Solver state + epoch: exactly equal between the runs (the precondition for the deltas).
      expect(b.solverSteps, `checkpoint ${i}: same solver step state`).toBe(a.solverSteps);
      expect(b.solverSimulationTime, `checkpoint ${i}: same solver numerical time`).toBe(a.solverSimulationTime);
      expect(b.epoch, `checkpoint ${i}: same field epoch`).toBe(a.epoch);
      expect(b.movement, `checkpoint ${i}: same movement`).toBe(a.movement);
      if (b.movement !== a.movement) maxMoveDrift += 1;
      if (a.health && b.health) {
        maxOcc = Math.max(maxOcc, Math.abs(a.health.occupiedFraction - b.health.occupiedFraction));
        maxFlux = Math.max(maxFlux, Math.abs(a.health.flux - b.health.flux));
        maxChange = Math.max(maxChange, Math.abs(a.health.change - b.health.change));
      }
      maxCoarse = Math.max(maxCoarse, Math.abs(a.coarseOccupancy - b.coarseOccupancy));
    }
    const measuredMaxDelta = Math.max(maxOcc, maxFlux, maxChange, maxCoarse);
    console.info(
      `[replay] max descriptor deltas: healthOcc=${maxOcc.toExponential(2)} flux=${maxFlux.toExponential(2)} ` +
        `change=${maxChange.toExponential(2)} coarseOcc=${maxCoarse.toExponential(2)} ` +
        `| measured max=${measuredMaxDelta.toExponential(2)} | tolerance=${DESCRIPTOR_TOLERANCE.toExponential(2)} ` +
        `| movement divergences=${maxMoveDrift} | commands=${sigA.length}`,
    );
    expect(maxOcc, 'health occupancy within tolerance').toBeLessThanOrEqual(DESCRIPTOR_TOLERANCE);
    expect(maxFlux, 'health flux within tolerance').toBeLessThanOrEqual(DESCRIPTOR_TOLERANCE);
    expect(maxChange, 'health change rate within tolerance').toBeLessThanOrEqual(DESCRIPTOR_TOLERANCE);
    expect(maxCoarse, 'coarse occupancy within tolerance').toBeLessThanOrEqual(DESCRIPTOR_TOLERANCE);
    expect(maxMoveDrift, 'the two runs follow the same movement script').toBe(0);

    writeJson('replay/report.json', {
      generatedBy: 'tests/browser/replay.spec.ts (REPLAY=1)',
      seed: SEED,
      chunkSteps: CHUNK_STEPS,
      chunks: CHUNKS,
      deliveredSteps: CHUNK_STEPS * CHUNKS,
      descriptorTolerance: DESCRIPTOR_TOLERANCE,
      toleranceDerivation: {
        singleOccupiedCell: SINGLE_CELL,
        fullDomainCells: 768 * 768,
        engineeringMarginCells: 2,
        note:
          'Both runs are asserted to be at exactly the same delivered-step mark and delivered '
          + 'numerical time at every checkpoint — and to have exactly equal solver step/time state and '
          + 'field epoch — before any descriptor delta is computed, so the expected delta is zero. The '
          + 'bound is a stated engineering margin of two occupied cells in the 768² full-domain count; it '
          + 'replaces the previous 2e-3 bound, which was unjustified because the two runs were not '
          + 'aligned (a persistent 3-step offset).',
      },
      measuredMaxDelta: {
        healthOccupancy: maxOcc,
        healthFlux: maxFlux,
        healthChangeRate: maxChange,
        coarseOccupancy: maxCoarse,
        overall: measuredMaxDelta,
      },
      stateAlignment: {
        stepsAtSetup: [runA.stepsAtSetup, runB.stepsAtSetup],
        simulationTimeAtSetup: [runA.simulationTimeAtSetup, runB.simulationTimeAtSetup],
        deliveredMarksExact: true,
        stepAdvancePerChunkExact: true,
        solverStateEqualBetweenRuns: true,
        note:
          'Delivered step and numerical time are asserted exactly at the intended mark at setup and at '
          + 'every checkpoint; between checkpoints the solver step counter advances by exactly '
          + 'CHUNK_STEPS unless a `replace` genesis (same epoch bump in both runs) reset it; the solver '
          + 'step/time state and field epoch are asserted exactly equal between the two runs.',
      },
      commandsByteIdentical: true,
      movementDivergences: maxMoveDrift,
      runA,
      runB,
    });
  });
});
