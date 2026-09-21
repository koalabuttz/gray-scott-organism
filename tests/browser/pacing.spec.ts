/**
 * §4.1/§11.1 pacing calibration (deviations 31 and 34).
 *
 * "It moves too slowly even at 4x speed" is a measurement question, not an opinion: the speed ceiling
 * is the steps/frame cap, and the steps/frame cap is whatever keeps the *whole* 1080p frame inside the
 * frame budget at a given simulation grid. This spec measures that on the real GPU with the
 * drained-frame benchmark (`App.benchmarkFrames`: N steps, publish, one full render, one-pixel
 * readback to serialise the queue), fits fixed + per-step cost, and derives each cap from the data.
 *
 * It measures **both** supported grids, and writes both under symmetric `presentation`/`exploration`
 * sections of `artifacts/pacing.json`:
 *   - 768² — the presentation grid (deviation 31);
 *   - 512² — the §10 lab-only exploration grid (deviation 34), reached by toggling exploration mode
 *     through the verification hook.
 *
 * **Provenance rule.** Every floor in the artifact is *derived* here from the retained observed
 * maxima, and the derivation record carries the observed maximum, the floor, and the realized margin
 * (absolute ms for the fixed cost, a multiplier for the per-step cost) so any figure quoted in prose
 * is recomputable from `history`. The floors themselves are a documented *policy choice* — the
 * measurement drifts with thermal/driver state, so a floor that merely equalled today's fit would
 * move the cap every run.
 *
 * **Default-suite counts.** This spec is gated (`PACING=1`), so the default `npm run test:browser`
 * suite discovers 24 tests in 8 files and runs **20** of them (4 gated: this one, `calibrate.spec.ts`,
 * `growth.spec.ts`, and the `GATE=1` test inside `gate.spec.ts`). `gate.spec.ts` contributes two
 * tests but only the `GATE=1` one is gated; its "publish safety" probe always runs.
 *
 * Run with: PACING=1 npx playwright test pacing.spec.ts  (or `npm run test:pacing`)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { maxStepsWithinBudget, speedCeiling, type StepBudget } from '../../src/core/longform.ts';
import { ARTIFACTS_DIR, hook, openArtwork, writeArtifact } from '../support/browser.ts';

const ENABLED = process.env['PACING'] === '1';
/** 0 is the fixed-cost baseline (publish + render + drain, no chemistry). */
const BURSTS = [0, 8, 16, 24, 32, 48];
/** The exploration grid is cheaper per step, so its cap lives higher: bracket it explicitly. */
const EXPLORATION_BURSTS = [0, 8, 16, 24, 32, 48, 64];
const COUNT = 90;
/** Repeat each burst and take the median: `benchmarkFrames` averages COUNT frames, but the GPU's
 *  observed per-step cost drifted between runs, so a median is the more trustworthy point estimate. */
const REPEATS = 3;
/** §11.1 initial 60 fps frame budget. */
const BUDGET_60FPS_MS = 1000 / 60;
/** The panel this runs on (entry 18); the frame period the app actually has to fit inside. */
const DISPLAY_HZ = 49.95;
/** Fraction of the frame period reserved for browser/driver variance and presentation. */
const SAFETY_MARGIN = 0.15;
/**
 * **768² presentation floors** (deviation 31): a documented policy choice, not an observation.
 * Realized against the retained maxima: fixed 10.5 ms = observed max 7.44 + 3.06 ms; per-step
 * 0.50 ms/step = observed max 0.2631 × 1.90. The realized margins are recomputed and recorded by
 * `deriveFloorRecord`, so the prose cannot drift from `history`.
 */
const PRESENTATION_FIXED_MS = 10.5;
const PRESENTATION_PER_STEP_MS = 0.5;
/** The rounding applied to each grid's floors, stated so the derivation is reproducible. */
const PRESENTATION_ROUNDING =
  'fixed rounded up to the nearest 0.05 ms; per-step rounded down to the nearest 0.05 ms';
/**
 * **512² exploration floors** (deviation 34): the same method on the exploration grid's own retained
 * maxima. Realized: fixed 11.0 ms = observed max 7.78 + 3.22 ms; per-step 0.22 ms = observed max
 * 0.1199 × 1.83. Recorded separately so neither resolution's policy can be read as the other's.
 */
const EXPLORATION_FIXED_MS = 11.0;
const EXPLORATION_PER_STEP_MS = 0.22;
const EXPLORATION_ROUNDING =
  'fixed rounded up to the nearest 0.5 ms; per-step rounded up to the nearest 0.01 ms';
const PARAMS = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };

interface BenchmarkResult {
  canvas: string;
  scene: string;
  count: number;
  stepsPerFrame: number;
  totalMs: number;
  msPerFrame: number;
  impliedFps: number;
}

interface Sample {
  stepsPerFrame: number;
  count: number;
  /** Median of the repeated bursts, the point estimate used for the fit. */
  msPerFrame: number;
  /** Every repeated burst's ms/frame, kept in the artifact for auditability. */
  repeatsMsPerFrame: number[];
  /** Marginal cost relative to the 0-step baseline (null for the baseline row). */
  msPerStep: number | null;
  impliedFps: number;
}

/** The derived policy for one grid: the fit, the floors used, and the cap/ceiling they imply. */
interface DerivedPolicy {
  fit: { fixedMs: number; perStepMs: number };
  fixedMsForCap: number;
  perStepMsForCap: number;
  capAt60fps: number;
  capOnPanel: number;
  chosenCap: number;
  speedCeiling: number;
  predictedMsAtCap: number;
  deliveredSpeedOnPanel: number;
}

/** One recorded pacing run — the auditable unit of `history` in `artifacts/pacing.json`. */
interface RunRecord {
  measuredAt: string;
  harness: string;
  renderer: string;
  softwareRenderer: boolean;
  grid: string;
  viewport: string;
  repeats: number;
  fixedMs: number;
  perStepMs: number;
  bursts: { stepsPerFrame: number; msPerFrame: number; repeatsMsPerFrame: number[] }[];
  capAt60fps: number;
  capOnPanel: number;
  chosenCap: number;
  predictedMsAtCap: number;
  speedCeiling: number;
  deliveredSpeedOnPanel: number;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Least-squares slope of msPerFrame against stepsPerFrame (fixed cost is the intercept). */
function linearFit(samples: Sample[]): { fixedMs: number; perStepMs: number } {
  const n = samples.length;
  const sumX = samples.reduce((sum, s) => sum + s.stepsPerFrame, 0);
  const sumY = samples.reduce((sum, s) => sum + s.msPerFrame, 0);
  const sumXX = samples.reduce((sum, s) => sum + s.stepsPerFrame * s.stepsPerFrame, 0);
  const sumXY = samples.reduce((sum, s) => sum + s.stepsPerFrame * s.msPerFrame, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { fixedMs: sumY / n, perStepMs: 0 };
  const perStepMs = (n * sumXY - sumX * sumY) / denominator;
  const fixedMs = (sumY - perStepMs * sumX) / n;
  return { fixedMs, perStepMs };
}

/**
 * Derive one grid's cap: the conservative floors are applied to the fit, the cap is computed against
 * the panel's real frame period (with the 60 fps period as a cross-check) and rounded down to a
 * multiple of 4 so the 60 fps ceiling is clean.
 */
function derivePolicy(samples: Sample[], conservativeFixedMs: number, conservativePerStepMs: number): DerivedPolicy {
  const fit = linearFit(samples);
  const fixedMsForCap = Math.max(fit.fixedMs, conservativeFixedMs);
  const perStepMsForCap = Math.max(fit.perStepMs, conservativePerStepMs);
  const budgetAt60fps: StepBudget = {
    fixedFrameMs: fixedMsForCap,
    perStepMs: perStepMsForCap,
    framePeriodMs: BUDGET_60FPS_MS,
    safetyMargin: SAFETY_MARGIN,
  };
  const budgetOnPanel: StepBudget = { ...budgetAt60fps, framePeriodMs: 1000 / DISPLAY_HZ };
  const capAt60fps = maxStepsWithinBudget(budgetAt60fps);
  const capOnPanel = maxStepsWithinBudget(budgetOnPanel);
  const chosenCap = Math.max(4, Math.floor(capOnPanel / 4) * 4);
  return {
    fit,
    fixedMsForCap,
    perStepMsForCap,
    capAt60fps,
    capOnPanel,
    chosenCap,
    speedCeiling: speedCeiling(chosenCap),
    predictedMsAtCap: fixedMsForCap + chosenCap * perStepMsForCap,
    deliveredSpeedOnPanel: (chosenCap * DISPLAY_HZ) / 120,
  };
}

function pacingPath(): string {
  return resolve(ARTIFACTS_DIR, 'pacing.json');
}

/** Prior runs for one section; an absent or unreadable file is simply an empty history. */
function readHistory(path: string, section: 'presentation' | 'exploration'): RunRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      history?: RunRecord[];
      presentation?: { history?: RunRecord[] };
      exploration?: { history?: RunRecord[] };
    };
    // `history` at the top level is the pre-nesting (schemaVersion ≤ 3) presentation history.
    const list =
      section === 'exploration' ? parsed.exploration?.history : (parsed.presentation?.history ?? parsed.history);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function extremes(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * The audit record for one grid's floors: the retained observed maxima, the floors, and the realized
 * margins, computed (never transcribed). `text` restates it for a human reader.
 */
function deriveFloorRecord(
  observedFixedMaxMs: number,
  observedPerStepMaxMs: number,
  fixedFloorMs: number,
  perStepFloorMs: number,
  rounding: string,
  runs: number,
  derived: DerivedPolicy,
): Record<string, unknown> {
  const fixedMarginMs = fixedFloorMs - observedFixedMaxMs;
  const perStepMultiplier = perStepFloorMs / observedPerStepMaxMs;
  return {
    basedOn: `the retained observed maxima across ${runs} run(s) in \`history\``,
    isPolicyChoice: true,
    rounding,
    fixed: { observedMaxMs: observedFixedMaxMs, floorMs: fixedFloorMs, marginMs: fixedMarginMs },
    perStep: { observedMaxMs: observedPerStepMaxMs, floorMs: perStepFloorMs, multiplier: perStepMultiplier },
    consistency: {
      floorsAtOrAboveObservedMaxima: fixedMarginMs >= 0 && perStepMultiplier >= 1,
      capWithinFlooredBudget: maxStepsWithinBudget({
        fixedFrameMs: fixedFloorMs,
        perStepMs: perStepFloorMs,
        framePeriodMs: 1000 / DISPLAY_HZ,
        safetyMargin: SAFETY_MARGIN,
      }) >= derived.chosenCap,
    },
    text:
      `fixed ${fixedFloorMs} ms = observed max ${observedFixedMaxMs.toFixed(2)} + ${fixedMarginMs.toFixed(2)} ms; ` +
      `per-step ${perStepFloorMs} ms = observed max ${observedPerStepMaxMs.toFixed(4)} x ${perStepMultiplier.toFixed(2)}`,
  };
}

/** Measure the drained cost of a 1080p frame for each burst, repeated and reduced by median. */
async function measureBursts(page: Page, label: string, bursts: number[]): Promise<Sample[]> {
  const samples: Sample[] = [];
  let baselineMsPerFrame = 0;
  for (const stepsPerFrame of bursts) {
    const repeatsMsPerFrame: number[] = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const result = await hook<BenchmarkResult>(page, 'benchmarkFrames', [COUNT, stepsPerFrame]);
      repeatsMsPerFrame.push(result.msPerFrame);
    }
    const msPerFrame = median(repeatsMsPerFrame);
    if (stepsPerFrame === 0) baselineMsPerFrame = msPerFrame;
    samples.push({
      stepsPerFrame,
      count: COUNT,
      msPerFrame,
      repeatsMsPerFrame,
      msPerStep:
        stepsPerFrame > 0 && baselineMsPerFrame > 0
          ? (msPerFrame - baselineMsPerFrame) / stepsPerFrame
          : null,
      impliedFps: msPerFrame > 0 ? 1000 / msPerFrame : 0,
    });
    console.info(
      `[pacing] ${label} ${String(stepsPerFrame).padStart(2)} steps/frame: ${msPerFrame.toFixed(2)} ms/frame ` +
        `(median of ${REPEATS}: ${repeatsMsPerFrame.map((v) => v.toFixed(2)).join(', ')})`,
    );
  }
  return samples;
}

/** Build a recorded run from a measurement + its derived policy. */
function makeRun(
  samples: Sample[],
  derived: DerivedPolicy,
  grid: string,
  harness: string,
  renderer: { rendererInfo: string; softwareRenderer: boolean },
  measuredAt: string,
): RunRecord {
  return {
    measuredAt,
    harness,
    renderer: renderer.rendererInfo,
    softwareRenderer: renderer.softwareRenderer,
    grid,
    viewport: '1920x1080',
    repeats: REPEATS,
    fixedMs: derived.fit.fixedMs,
    perStepMs: derived.fit.perStepMs,
    bursts: samples.map((sample) => ({
      stepsPerFrame: sample.stepsPerFrame,
      msPerFrame: sample.msPerFrame,
      repeatsMsPerFrame: sample.repeatsMsPerFrame,
    })),
    capAt60fps: derived.capAt60fps,
    capOnPanel: derived.capOnPanel,
    chosenCap: derived.chosenCap,
    predictedMsAtCap: derived.predictedMsAtCap,
    speedCeiling: derived.speedCeiling,
    deliveredSpeedOnPanel: derived.deliveredSpeedOnPanel,
  };
}

/** The full artifact section for one grid, with the derivation recomputed from `history`. */
function gridSection(input: {
  grid: string;
  samples: Sample[];
  derived: DerivedPolicy;
  fixedFloorMs: number;
  perStepFloorMs: number;
  rounding: string;
  history: RunRecord[];
  note: string;
}): Record<string, unknown> {
  const observedFixedMaxMs = extremes(input.history.map((entry) => entry.fixedMs)).max;
  const observedPerStepMaxMs = extremes(input.history.map((entry) => entry.perStepMs)).max;
  // The floors must dominate the retained observations or the cap would move every run (and the
  // "margin" recorded below would be negative). Fail loudly rather than write a false derivation.
  expect(
    input.fixedFloorMs,
    `${input.grid}: the fixed floor must be at or above every observed fixed cost`,
  ).toBeGreaterThanOrEqual(observedFixedMaxMs - 1e-9);
  expect(
    input.perStepFloorMs,
    `${input.grid}: the per-step floor must be at or above every observed per-step cost`,
  ).toBeGreaterThanOrEqual(observedPerStepMaxMs - 1e-9);

  return {
    grid: input.grid,
    viewport: '1920x1080',
    safetyMargin: SAFETY_MARGIN,
    frameBudget60fpsMs: BUDGET_60FPS_MS,
    panelHz: DISPLAY_HZ,
    panelPeriodMs: 1000 / DISPLAY_HZ,
    policyFloors: { fixedMs: input.fixedFloorMs, perStepMs: input.perStepFloorMs, rounding: input.rounding },
    derivation: deriveFloorRecord(
      observedFixedMaxMs,
      observedPerStepMaxMs,
      input.fixedFloorMs,
      input.perStepFloorMs,
      input.rounding,
      input.history.length,
      input.derived,
    ),
    observed: {
      runs: input.history.length,
      fixedMs: extremes(input.history.map((entry) => entry.fixedMs)),
      perStepMs: extremes(input.history.map((entry) => entry.perStepMs)),
      maxPredictedMsAtChosenCap: Math.max(...input.history.map((entry) => entry.predictedMsAtCap)),
    },
    chosenCap: input.derived.chosenCap,
    capAt60fps: input.derived.capAt60fps,
    capOnPanel: input.derived.capOnPanel,
    predictedMsAtCap: input.derived.predictedMsAtCap,
    speedCeiling: input.derived.speedCeiling,
    deliveredSpeedOnPanel: input.derived.deliveredSpeedOnPanel,
    samples: input.samples,
    fit: input.derived.fit,
    history: input.history,
    note: input.note,
  };
}

test.describe('pacing calibration', () => {
  test.skip(!ENABLED, 'set PACING=1 to run the pacing calibration');

  test('per-step cost at 768^2 and 512^2, and the derived steps/frame caps at 1080p', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const probe = await openArtwork(page);
    expect(probe.ok, probe.reason).toBe(true);
    if (!probe.ok) return;

    // A representative live field, held still: mature parameters, then settle so the measurement is
    // not taken on the degenerate all-(U=1, V=0) domain (the solver cost is data-independent, but a
    // live field is the honest workload).
    const settle = async (): Promise<void> => {
      await hook(page, 'setAutoSeed', [false]);
      await hook(page, 'setPaused', [true]);
      await hook(page, 'setParameters', [PARAMS]);
      await hook(page, 'simulate', [6000]);
    };
    await settle();

    const renderer = await hook<{ rendererInfo: string; softwareRenderer: boolean }>(page, 'diagnostics');
    const measuredAt = new Date().toISOString();
    const harness = test.info().project.name;

    // ---------------------------------------------------------------- 768² presentation
    const samples = await measureBursts(page, '768²', BURSTS);
    const derived = derivePolicy(samples, PRESENTATION_FIXED_MS, PRESENTATION_PER_STEP_MS);
    console.info(
      `[pacing] 768² fit: fixed=${derived.fit.fixedMs.toFixed(2)} ms/frame, per-step=${derived.fit.perStepMs.toFixed(4)} ms ` +
        `(conservative ${derived.fixedMsForCap.toFixed(2)} / ${derived.perStepMsForCap.toFixed(4)} used for the cap)`,
    );
    console.info(
      `[pacing] 768² caps: ${derived.capAt60fps} steps/frame at the 60 fps budget, ` +
        `${derived.capOnPanel} at the panel period; chosen ${derived.chosenCap} -> ` +
        `ceiling ${derived.speedCeiling}x (predicted ${derived.predictedMsAtCap.toFixed(2)} ms/frame)`,
    );
    const run = makeRun(samples, derived, '768x768', harness, renderer, measuredAt);
    const history = [...readHistory(pacingPath(), 'presentation'), run];

    // ---------------------------------------------------------------- 512² exploration
    await hook(page, 'setExploration', [true]);
    const size = await hook<{ width: number; height: number }>(page, 'simulationSize');
    expect(size.width, 'exploration mode must switch the simulation grid to 512²').toBe(512);
    expect(size.height).toBe(512);
    // The switch restarts the organism, so settle a live field again before measuring.
    await settle();
    const explorationSamples = await measureBursts(page, '512²', EXPLORATION_BURSTS);
    const explorationDerived = derivePolicy(explorationSamples, EXPLORATION_FIXED_MS, EXPLORATION_PER_STEP_MS);
    console.info(
      `[pacing] 512² fit: fixed=${explorationDerived.fit.fixedMs.toFixed(2)} ms/frame, per-step=${explorationDerived.fit.perStepMs.toFixed(4)} ms ` +
        `(conservative ${explorationDerived.fixedMsForCap.toFixed(2)} / ${explorationDerived.perStepMsForCap.toFixed(4)} used for the cap)`,
    );
    console.info(
      `[pacing] 512² caps: ${explorationDerived.capAt60fps} steps/frame at the 60 fps budget, ` +
        `${explorationDerived.capOnPanel} at the panel period; chosen ${explorationDerived.chosenCap} -> ` +
        `ceiling ${explorationDerived.speedCeiling}x (predicted ${explorationDerived.predictedMsAtCap.toFixed(2)} ms/frame)`,
    );
    const explorationRun = makeRun(
      explorationSamples,
      explorationDerived,
      '512x512',
      harness,
      renderer,
      measuredAt,
    );
    const explorationHistory = [...readHistory(pacingPath(), 'exploration'), explorationRun];

    const presentationSection = gridSection({
      grid: '768x768',
      samples,
      derived,
      fixedFloorMs: PRESENTATION_FIXED_MS,
      perStepFloorMs: PRESENTATION_PER_STEP_MS,
      rounding: PRESENTATION_ROUNDING,
      history,
      note:
        'Presentation grid. The floors are a policy choice (see `derivation`), not an observation: the ' +
        'measurement drifts with thermal/driver state, so a floor equal to today\'s fit would move the ' +
        'cap every run.',
    });
    const explorationSection = gridSection({
      grid: '512x512',
      samples: explorationSamples,
      derived: explorationDerived,
      fixedFloorMs: EXPLORATION_FIXED_MS,
      perStepFloorMs: EXPLORATION_PER_STEP_MS,
      rounding: EXPLORATION_ROUNDING,
      history: explorationHistory,
      note:
        '§10 lab-only exploration grid. Same drained-frame method and the same policy-floor structure ' +
        'as the presentation grid, with its own floors derived from its own retained maxima: the ' +
        'coarser grid is cheaper per step, so the same frame budget buys more steps and the measured ' +
        'cap (and its 60 fps ceiling) is higher. Reached by toggling exploration mode through the ' +
        'verification hook, which restarts the organism.',
    });

    console.info(
      `[pacing] floors vs retained maxima — 768²: ${JSON.stringify((presentationSection['derivation'] as Record<string, unknown>)['text'])}`,
    );
    console.info(
      `[pacing] floors vs retained maxima — 512²: ${JSON.stringify((explorationSection['derivation'] as Record<string, unknown>)['text'])}`,
    );

    const artifact = {
      schemaVersion: 4,
      updatedAt: measuredAt,
      nominalStepsPerSecond: 120,
      // Both grids use the same section shape; `presentation` replaces the old top-level fields.
      presentation: presentationSection,
      exploration: explorationSection,
      note:
        'Drained-frame cost: N simulation steps, one publish, one full render, one-pixel readback to ' +
        'serialise the GPU queue, each burst repeated and reduced by median. `fit` is the least-squares ' +
        'slope/intercept; `fit` for every past run is in that section\'s `history`. Each cap is derived ' +
        'against the panel frame period with the safety margin using that grid\'s `policyFloors` (not ' +
        'the day\'s fit) and rounded down to a multiple of 4; speedCeiling = chosenCap * 60 / 120, and ' +
        '`deliveredSpeedOnPanel` = chosenCap * panelHz / 120. `derivation` recomputes each floor\'s ' +
        'margin from the retained observed maxima, so every figure quoted in prose is derivable from ' +
        '`history`.',
    };
    writeArtifact(pacingPath(), JSON.stringify(artifact, null, 2));
    console.info('[pacing] wrote artifacts/pacing.json');

    expect(derived.fit.perStepMs).toBeGreaterThan(0);
    expect(explorationDerived.fit.perStepMs).toBeGreaterThan(0);
    // The coarser grid must be cheaper per step, or the exploration premise is wrong.
    expect(explorationDerived.fit.perStepMs).toBeLessThan(derived.fit.perStepMs);
    expect(derived.chosenCap).toBeGreaterThanOrEqual(8);
    expect(explorationDerived.chosenCap).toBeGreaterThan(derived.chosenCap);
    expect(explorationDerived.predictedMsAtCap).toBeLessThan(1000 / DISPLAY_HZ);
    // The 768² budget must stay inside the panel period at its own cap, too.
    expect(derived.predictedMsAtCap).toBeLessThan(1000 / DISPLAY_HZ);
    // The artifact must carry this run in each of its histories.
    expect(history[history.length - 1]!.measuredAt).toBe(measuredAt);
    expect(explorationHistory[explorationHistory.length - 1]!.measuredAt).toBe(measuredAt);
  });
});
