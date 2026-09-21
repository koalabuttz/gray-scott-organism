/**
 * AC.1 capability report, AC.2 GPU-vs-CPU agreement, AC.3 attachment feedback invariants, and
 * AC.5 GPU 10,000-step smoke.
 *
 * These run against the real browser GL implementation. If the artwork cannot obtain WebGL2 at
 * all the tests skip *with the actual failure reason* — never a silent pass — and the renderer
 * string is always reported. When Chromium falls back to a software rasteriser the tests still
 * run (software GL can exercise numerical correctness) but announce it loudly, because software
 * rendering cannot validate target-GPU performance or final material appearance (§12.4).
 */
import { expect, test } from '@playwright/test';
import { DEFAULT_PARAMS, TIME } from '../../src/config.ts';
import { applyGenesisCPU, createSingleSeedCommand } from '../../src/simulation/genesis.ts';
import { ReferenceSolver, fieldStats, maxAbsDiff } from '../../src/simulation/reference.ts';
import { openArtwork, hook, writeArtifact, harnessSection } from '../support/browser.ts';
import type { HarnessLaunchOptions } from '../support/browser.ts';
import { CLIPPING_FREQUENCY_BOUND, GPU_CPU_TOLERANCE_10_STEPS, GPU_CPU_TOLERANCE_1_STEP } from '../support/tolerances.ts';
import type {
  CapabilityReportShape,
  ColorTargetFailureShape,
  DiagnosticsShape,
  FieldStatsShape,
  LifecycleCheckShape,
  ParamsShape,
  SmallGridRunShape,
} from '../support/types.ts';

const SEAM_SEED = { center: [0.03, 0.5] as [number, number], radiusCells: 6 };
const SMALL_GRID = 40;
/**
 * The stable 10,000-step run must show a *zero* excursion magnitude: with the shipped parameters
 * the unclamped update does not leave [0,1] at all. Anything above this is a real excursion rather
 * than float32 noise, and the CPU reference agrees on the count independently.
 */
const CPU_EXCURSION_TOLERANCE = 1e-4;

/**
 * Independent CPU instrument for the same quantity the GPU validation pass counts: how many
 * cell-updates had an unclamped value outside [0,1]. Reuses `ReferenceSolver.step`, which returns
 * those counts from the unclamped values.
 */
function cpuClipping(
  width: number,
  height: number,
  steps: number,
  parameters: ParamsShape,
  seed: { center: [number, number]; radiusCells: number },
): { clippedU: number; clippedV: number; maxExcursion: number } {
  const solver = new ReferenceSolver(width, height);
  solver.setUniform(1, 0);
  applyGenesisCPU(
    solver,
    createSingleSeedCommand({
      center: seed.center,
      seed: 1,
      perturb: false,
      radiusCells: seed.radiusCells,
      strength: 1,
      mode: 'replace',
    }),
  );
  let clippedU = 0;
  let clippedV = 0;
  let maxExcursion = 0;
  for (let i = 0; i < steps; i += 1) {
    const outcome = solver.step({ ...parameters }, TIME.dt);
    clippedU += outcome.clippedU;
    clippedV += outcome.clippedV;
    if (outcome.maxExcursion > maxExcursion) maxExcursion = outcome.maxExcursion;
  }
  return { clippedU, clippedV, maxExcursion };
}

function cpuReference(width: number, height: number, steps: number): ReferenceSolver {
  const solver = new ReferenceSolver(width, height);
  solver.setUniform(1, 0);
  applyGenesisCPU(
    solver,
    createSingleSeedCommand({
      center: SEAM_SEED.center,
      seed: 1,
      perturb: false,
      radiusCells: SEAM_SEED.radiusCells,
      strength: 1,
      mode: 'replace',
    }),
  );
  for (let i = 0; i < steps; i += 1) solver.step({ ...DEFAULT_PARAMS }, TIME.dt);
  return solver;
}

test.describe('GPU correctness', () => {
  test('AC.1 capability report and framebuffer completeness on the real device', async ({ page }) => {
    const probe = await openArtwork(page);
    if (!probe.ok) {
      writeArtifact(
        'capability-report.md',
        `# Capability report — An Organism in Darkness (Phase 1)\n\n` +
          `**The artwork could not start:** ${probe.reason}\n\n` +
          `WebGL2 with EXT_color_buffer_float is required. No GPU verification was performed.\n`,
      );
      test.skip(true, `WebGL2 did not start: ${probe.reason}`);
      return;
    }

    const report = await hook<CapabilityReportShape>(page, 'report');
    const markdown = await hook<string>(page, 'capabilityMarkdown');
    const project = test.info().project;
    const harness = harnessSection(
      project.name,
      project.use.launchOptions as HarnessLaunchOptions | undefined,
      {
        renderer: report.renderer,
        softwareRenderer: report.softwareRenderer,
        colorBufferFloat: report.extensions['EXT_color_buffer_float'] === true,
      },
    );
    const written = writeArtifact(
      project.name === 'headless-gpu' ? 'capability-report.md' : `capability-report-${project.name}.md`,
      `${markdown}\n${harness}`,
    );
    test.info().annotations.push({ type: 'renderer', description: report.renderer });
    if (report.softwareRenderer) {
      test.info().annotations.push({
        type: 'software-gl',
        description: 'software rasteriser: correctness is exercised, target performance is not',
      });
    }
    console.info(`[AC.1] capability report written to ${written}`);
    console.info(`[AC.1] renderer=${report.renderer} vendor=${report.vendor} software=${report.softwareRenderer}`);
    console.info(
      `[AC.1] formats: ${report.formats.map((format) => `${format.name}:${format.complete ? 'complete' : format.status}${format.attachment === 'color' ? (format.writeVerified ? '/write-ok' : '/write-FAILED') : ''}`).join(' ')}`,
    );
    console.info(
      `[AC.1] limits: MAX_TEXTURE_SIZE=${report.limits.MAX_TEXTURE_SIZE} MAX_VERTEX_TEXTURE_IMAGE_UNITS=${report.limits.MAX_VERTEX_TEXTURE_IMAGE_UNITS} MAX_RENDERBUFFER_SIZE=${report.limits.MAX_RENDERBUFFER_SIZE}`,
    );

    expect(report.extensions['EXT_color_buffer_float'], 'EXT_color_buffer_float must be present').toBe(true);
    expect(report.problems, `capability problems: ${report.problems.join('; ')}`).toEqual([]);
    for (const format of report.formats) {
      expect(format.complete, `${format.name} framebuffer incomplete: ${format.status}`).toBe(true);
      if (format.attachment === 'color') {
        expect(format.writeVerified, `${format.name} write probe failed: ${format.writeError}`).toBe(true);
      }
    }
    expect(report.limits.MAX_TEXTURE_SIZE).toBeGreaterThanOrEqual(768);
    expect(report.limits.MAX_RENDERBUFFER_SIZE).toBeGreaterThanOrEqual(1024);
    expect(report.limits.MAX_VERTEX_TEXTURE_IMAGE_UNITS).toBeGreaterThanOrEqual(1);
  });

  test('AC.2 GPU matches the CPU reference at 1 and 10 steps, including toroidal edges', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    const runs: SmallGridRunShape[] = [];
    for (const steps of [1, 10]) {
      const run = await hook<SmallGridRunShape>(page, 'smallGridRun', [
        { width: SMALL_GRID, height: SMALL_GRID, steps, parameters: DEFAULT_PARAMS, seed: SEAM_SEED },
      ]);
      runs.push(run);
      const reference = cpuReference(SMALL_GRID, SMALL_GRID, steps);
      const gpuU = Float32Array.from(run.u);
      const gpuV = Float32Array.from(run.v);
      const diffU = maxAbsDiff(gpuU, reference.u);
      const diffV = maxAbsDiff(gpuV, reference.v);
      const observed = Math.max(diffU.max, diffV.max);
      const tolerance = steps === 1 ? GPU_CPU_TOLERANCE_1_STEP : GPU_CPU_TOLERANCE_10_STEPS;

      console.info(
        `[AC.2] ${steps} step(s) @ ${SMALL_GRID}x${SMALL_GRID} with a seam-crossing seed: ` +
          `maxdU=${diffU.max.toExponential(3)} maxdV=${diffV.max.toExponential(3)} observed=${observed.toExponential(3)} tolerance=${tolerance}`,
      );
      expect(run.feedbackViolations, 'the comparison run must not sample its own write attachment').toBe(0);
      expect(run.attachmentFeedbackOk).toBe(true);
      expect(observed).toBeLessThan(tolerance);

      // The seed must really straddle the seam, otherwise this is not testing toroidal edges.
      const middleRow = Math.floor(SMALL_GRID / 2) * SMALL_GRID;
      expect(gpuV[middleRow + 0]!).toBeGreaterThan(0.2);
      expect(gpuV[middleRow + SMALL_GRID - 1]!).toBeGreaterThan(0.2);
    }

    // The comparison must not be trivially satisfied by an unchanged field: 10 steps of
    // Gray-Scott from a seed must produce a measurably different field than 1 step.
    const first = Float32Array.from(runs[0]!.v);
    const tenth = Float32Array.from(runs[1]!.v);
    const evolution = maxAbsDiff(first, tenth).max;
    console.info(`[AC.2] evolution between step 1 and step 10: maxdV=${evolution.toExponential(3)}`);
    expect(evolution).toBeGreaterThan(1e-3);
  });

  test('AC.3 uniform (U=1,V=0) survives 50 GPU steps and no pass feeds back', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    const run = await hook<SmallGridRunShape>(page, 'smallGridRun', [
      { width: 32, height: 32, steps: 50, parameters: DEFAULT_PARAMS, seed: null },
    ]);
    const uExact = run.u.every((value) => value === 1);
    const vExact = run.v.every((value) => value === 0);
    console.info(`[AC.3] uniform invariance over 50 GPU steps: u===1 ${uExact}, v===0 ${vExact}`);
    expect(uExact).toBe(true);
    expect(vExact).toBe(true);
    expect(run.feedbackViolations).toBe(0);
    expect(run.attachmentFeedbackOk).toBe(true);

    // Live attachment validation on the main 768^2 simulation as it runs.
    expect(await hook<boolean>(page, 'feedbackOk')).toBe(true);
    expect(await hook<number>(page, 'feedbackViolations')).toBe(0);
  });

  test('AC.5 10,000 GPU steps stay finite and bounded with the clipping frequency instrumented', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    const grid = 256;
    const steps = 10_000;
    const sealSeed = { center: [0.5, 0.5] as [number, number], radiusCells: 6 };
    const started = Date.now();
    const run = await hook<SmallGridRunShape>(page, 'smallGridRun', [
      { width: grid, height: grid, steps, parameters: DEFAULT_PARAMS, seed: sealSeed, validate: true },
    ]);
    const elapsedSeconds = (Date.now() - started) / 1000;
    const stats: FieldStatsShape = fieldStats(Float32Array.from(run.u), Float32Array.from(run.v), grid, grid, 0.1);

    expect(run.clipping, 'the run must return the pre-clamp instrumentation').not.toBeNull();
    const clipping = run.clipping!;
    const cpu = cpuClipping(grid, grid, steps, DEFAULT_PARAMS, sealSeed);

    const cellUpdates = grid * grid * steps;
    console.info(
      `[AC.5] GPU ${steps} steps @ ${grid}x${grid} in ${elapsedSeconds.toFixed(1)}s ` +
        `(${(cellUpdates / elapsedSeconds / 1e6).toFixed(1)} M cell-updates/s): ` +
        `nonFinite=${stats.nonFinite} occupied=${stats.occupiedFraction.toFixed(4)} ` +
        `meanV=${stats.meanV.toFixed(4)} edgeDensity=${stats.edgeDensity.toFixed(5)} ` +
        `feedbackViolations=${run.feedbackViolations} steps=${run.steps}`,
    );
    console.info(
      `[AC.5] pre-clamp instrumentation: clippedU=${clipping.clippedU} clippedV=${clipping.clippedV} ` +
        `frequency=${clipping.frequency.toExponential(3)} (bound ${CLIPPING_FREQUENCY_BOUND}) ` +
        `maxExcursion=${clipping.maxExcursion.toExponential(3)} significantCellSteps=${clipping.significantCellSteps} ` +
        `| CPU reference: clippedU=${cpu.clippedU} clippedV=${cpu.clippedV} maxExcursion=${cpu.maxExcursion.toExponential(3)} ` +
        `| saturation proxy (includes the untouched U=1 void): ${stats.saturatedCells} cells`,
    );

    // Field health
    expect(run.steps).toBe(steps);
    expect(stats.nonFinite).toBe(0);
    expect(stats.minV).toBeGreaterThanOrEqual(0);
    expect(stats.maxV).toBeLessThanOrEqual(1);
    expect(stats.occupiedFraction).toBeGreaterThan(0.02);
    expect(stats.occupiedFraction).toBeLessThan(0.95);
    expect(run.feedbackViolations).toBe(0);

    // The instrumentation reports the run it instrumented, and the frequency is inside the
    // calibrated bound. The CPU reference — which counts the same quantity independently, from the
    // unclamped values of the same equations — must agree.
    expect(clipping.steps).toBe(steps);
    expect(clipping.cells).toBe(grid * grid);
    expect(clipping.frequency).toBeLessThanOrEqual(CLIPPING_FREQUENCY_BOUND);
    expect(clipping.clippedU).toBe(cpu.clippedU);
    expect(clipping.clippedV).toBe(cpu.clippedV);
    expect(clipping.maxExcursion).toBeGreaterThanOrEqual(0);
    expect(clipping.maxExcursion).toBeLessThan(CPU_EXCURSION_TOLERANCE);

    writeArtifact(
      'phase1-gpu-smoke.json',
      JSON.stringify(
        {
          grid,
          steps,
          elapsedSeconds,
          cellUpdatesPerSecond: cellUpdates / elapsedSeconds,
          stats,
          instrumentation: { gpu: clipping, cpuReference: cpu, bound: CLIPPING_FREQUENCY_BOUND },
          feedbackViolations: run.feedbackViolations,
        },
        null,
        2,
      ),
    );
  });

  test('AC.5 the clipping instrumentation is sensitive: a deliberately unstable fixture registers excursions', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);

    // Deliberately outside the §6.2 safety envelope (dt * max(Du,Dv) = 0.3 > 0.25): the five-point
    // update is unstable, so unclamped values leave [0,1] immediately. This exists purely to prove
    // the instrumentation is sensitive — the production command path still validates and would
    // reject these parameters.
    const unstable = { F: 0.03, k: 0.062, Du: 0.3, Dv: 0.2 };
    const grid = 64;
    const steps = 60;
    const run = await hook<SmallGridRunShape>(page, 'smallGridRun', [
      { width: grid, height: grid, steps, parameters: unstable, seed: { center: [0.5, 0.5], radiusCells: 6 }, validate: true },
    ]);
    const clipping = run.clipping!;
    const cpu = cpuClipping(grid, grid, steps, unstable, { center: [0.5, 0.5], radiusCells: 6 });

    console.info(
      `[AC.5] unstable fixture (Du=0.3, dt*Du=0.3 > 0.25): GPU clippedU=${clipping.clippedU} clippedV=${clipping.clippedV} ` +
        `maxExcursion=${clipping.maxExcursion.toFixed(3)} significantCellSteps=${clipping.significantCellSteps} ` +
        `| CPU clippedU=${cpu.clippedU} clippedV=${cpu.clippedV} maxExcursion=${cpu.maxExcursion.toFixed(3)}`,
    );

    // Sensitivity: the instrument sees real clipping, and the CPU reference agrees it is real.
    expect(clipping.clippedU + clipping.clippedV).toBeGreaterThan(0);
    expect(clipping.maxExcursion).toBeGreaterThan(0.01);
    expect(clipping.frequency).toBeGreaterThan(CLIPPING_FREQUENCY_BOUND);
    expect(cpu.clippedU + cpu.clippedV).toBeGreaterThan(0);
    expect(cpu.maxExcursion).toBeGreaterThan(0.01);
    // Agreement on the same quantities, within a documented relative tolerance (a divergent run
    // amplifies any single-channel rounding difference between the CPU and the shader).
    expect(Math.abs(clipping.clippedU - cpu.clippedU) / Math.max(1, cpu.clippedU)).toBeLessThan(0.02);
    expect(Math.abs(clipping.clippedV - cpu.clippedV) / Math.max(1, cpu.clippedV)).toBeLessThan(0.02);
  });

  test('resource lifecycle: depth renderbuffers are owned and released (no resize leak)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const result = await hook<LifecycleCheckShape>(page, 'lifecycleCheck');
    const zeros = {
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
      programs: 0,
      shaders: 0,
      vertexArrays: 0,
      buffers: 0,
    };
    console.info(
      `[lifecycle] resize churn x${result.resizeIterations}: renderbuffers ${result.before.renderbuffers} -> ` +
        `${result.afterResizeChurn.renderbuffers}; textures ${result.before.textures} -> ${result.afterResizeChurn.textures}; ` +
        `framebuffers ${result.before.framebuffers} -> ${result.afterResizeChurn.framebuffers}`,
    );
    console.info(
      `[lifecycle] scratch targets x${result.scratchTargets} created+deleted -> ${JSON.stringify(result.scratchTrackerAfterChurn)}`,
    );
    console.info(
      `[lifecycle] throwaway app: after construct ${JSON.stringify(result.throwawayAfterConstruct)} ` +
        `-> after dispose ${JSON.stringify(result.throwawayAfterDispose)}`,
    );

    // 1. Resizing the scene target hundreds of times must not grow any owned count, because each
    //    resize now releases the depth renderbuffer it replaces.
    expect(result.afterResizeChurn).toEqual(result.before);
    expect(result.before.renderbuffers).toBeGreaterThan(0);

    // 2. Creating and deleting depth-bearing targets on a fresh tracker must return it to zero.
    expect(result.scratchTrackerAfterChurn).toEqual(zeros);

    // 3. A throwaway application must own resources while alive and own nothing after dispose.
    expect(result.throwawayAfterConstruct.renderbuffers).toBeGreaterThan(0);
    expect(result.throwawayAfterConstruct.textures).toBeGreaterThan(0);
    expect(result.throwawayAfterDispose).toEqual(zeros);

    // 4. The validation instrumentation must be released on disable, not merely dereferenced:
    //    every disable returns the tracker to the pre-validation baseline, every enable allocates
    //    exactly the same resources (so re-enabling cannot accumulate), and dispose() ends at zero.
    console.info(
      `[lifecycle] validation toggle x${result.validationCycles}: baseline ${JSON.stringify(result.validationBaseline)}; ` +
        `enabled ${JSON.stringify(result.validationEnabledCounts[0])}; ` +
        `after first disable ${JSON.stringify(result.validationDisabledCounts[0])}; ` +
        `after last disable ${JSON.stringify(result.validationDisabledCounts[result.validationDisabledCounts.length - 1] ?? null)}; ` +
        `after dispose ${JSON.stringify(result.validationAfterDispose)}`,
    );
    expect(result.validationCycles).toBeGreaterThan(1);
    expect(result.validationEnabledCounts).toHaveLength(result.validationCycles);
    expect(result.validationDisabledCounts).toHaveLength(result.validationCycles);
    // The instrumentation is really allocated while enabled: 2 counter textures + 2 framebuffers
    // + 1 program over the simulation's own 2 textures / 2 framebuffers / 2 programs / 1 VAO.
    expect(result.validationEnabledCounts[0]!.textures).toBe(result.validationBaseline.textures + 2);
    expect(result.validationEnabledCounts[0]!.framebuffers).toBe(result.validationBaseline.framebuffers + 2);
    expect(result.validationEnabledCounts[0]!.programs).toBe(result.validationBaseline.programs + 1);
    for (let cycle = 0; cycle < result.validationCycles; cycle += 1) {
      expect(
        result.validationDisabledCounts[cycle],
        `tracker counts after validation disable #${cycle + 1}`,
      ).toEqual(result.validationBaseline);
      expect(
        result.validationEnabledCounts[cycle],
        `tracker counts with validation enabled for cycle #${cycle + 1}`,
      ).toEqual(result.validationEnabledCounts[0]);
    }
    expect(result.validationAfterDispose).toEqual(zeros);

    // The live verification hook must survive the throwaway instance's dispose.
    expect(await hook<number>(page, 'steps')).toBeGreaterThanOrEqual(0);
  });

  test('resource lifecycle: a failed target construction leaves the tracker exactly where it started', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const result = await hook<ColorTargetFailureShape>(page, 'colorTargetFailureProbe');
    for (const attempt of result.probes) {
      console.info(
        `[lifecycle] construction probe "${attempt.label}": ${attempt.message === null ? 'constructed (released)' : `failed: ${attempt.message}`} ` +
          `| before ${JSON.stringify(attempt.before)} -> after ${JSON.stringify(attempt.after)}`,
      );
    }
    console.info(`[lifecycle] construction probe tracker after all attempts: ${JSON.stringify(result.final)}`);

    expect(result.probes.length).toBeGreaterThanOrEqual(2);
    // The zero-extent attempt cannot produce a complete framebuffer on any implementation, so the
    // failure path (and both of its decrements) is genuinely exercised rather than assumed.
    expect(result.probes[0]!.message, 'the zero-extent probe must fail construction').not.toBeNull();
    for (const attempt of result.probes) {
      // The essential property: every tracker field returns exactly to its starting value. With the
      // old ordering a failed attempt left `framebuffers` at -1 relative to the start.
      expect(attempt.after, `tracker counts after "${attempt.label}"`).toEqual(attempt.before);
    }
    expect(result.final).toEqual({
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
      programs: 0,
      shaders: 0,
      vertexArrays: 0,
      buffers: 0,
    });
    // The probe uses its own tracker, and the live hook must still work afterwards.
    expect(await hook<number>(page, 'steps')).toBeGreaterThanOrEqual(0);
  });

  test('informational: delivered throughput of the live 768^2 pipeline', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A short measurement of the real pipeline at two canvas resolutions; evidence for the
    // capability report, not a performance gate (the architecture's measured thresholds belong to
    // AC.14 in Phase 4).
    const measureAt = async (width: number, height: number): Promise<Record<string, unknown>> => {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(12_000);
      const diagnostics = await hook<DiagnosticsShape>(page, 'diagnostics');
      const clock = await hook<{ performanceSeconds: number; steps: number }>(page, 'clock');
      const scene = await hook<{ width: number; height: number }>(page, 'sceneSize');
      const canvas = await hook<{ width: number; height: number }>(page, 'canvasSize');
      const stepsPerSecond = clock.performanceSeconds > 0 ? clock.steps / clock.performanceSeconds : 0;
      const frames = diagnostics.frameTimesMs.slice().sort((a, b) => a - b);
      const percentile = (p: number): number =>
        frames.length === 0 ? 0 : frames[Math.min(frames.length - 1, Math.round((p / 100) * (frames.length - 1)))]!;
      const record = {
        canvas: `${canvas.width}x${canvas.height}`,
        scene: `${scene.width}x${scene.height}`,
        deliveredFps: diagnostics.deliveredFps,
        deliveredSimulationStepsPerSecond: stepsPerSecond,
        frameMsPercentiles: { p50: percentile(50), p95: percentile(95), p99: percentile(99) },
        simulationMsAvg: diagnostics.simulationMsAvg,
        renderMsAvg: diagnostics.renderMsAvg,
        overload: diagnostics.overload,
      };
      console.info(
        `[perf] canvas ${record.canvas} (scene ${record.scene}): ${record.deliveredFps.toFixed(1)} fps, ` +
          `${stepsPerSecond.toFixed(1)} sim steps/s (nominal ${TIME.nominalStepsPerSecond}), ` +
          `frame p50=${percentile(50).toFixed(1)}ms p95=${percentile(95).toFixed(1)}ms p99=${percentile(99).toFixed(1)}ms ` +
          `submit-only sim=${diagnostics.simulationMsAvg.toFixed(2)}ms render=${diagnostics.renderMsAvg.toFixed(2)}ms overload=${diagnostics.overload}`,
      );
      return record;
    };

    const at720 = await measureAt(1280, 720);
    const at1080 = await measureAt(1920, 1080);
    // Drained-frame benchmark: 2 steps per frame is exactly the nominal 120 steps/s at 60 fps.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);
    const benchmark1080 = await hook<Record<string, unknown>>(page, 'benchmarkFrames', [120, 2]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);
    const benchmark720 = await hook<Record<string, unknown>>(page, 'benchmarkFrames', [120, 2]);
    console.info(
      `[perf] drained frame cost @1080p: ${(benchmark1080['msPerFrame'] as number).toFixed(2)} ms/frame ` +
        `(${(benchmark1080['impliedFps'] as number).toFixed(1)} fps implied, serialised)`,
    );
    console.info(
      `[perf] drained frame cost @720p: ${(benchmark720['msPerFrame'] as number).toFixed(2)} ms/frame ` +
        `(${(benchmark720['impliedFps'] as number).toFixed(1)} fps implied, serialised)`,
    );
    const diagnostics = await hook<DiagnosticsShape>(page, 'diagnostics');
    writeArtifact(
      'phase1-performance.json',
      JSON.stringify(
        {
          renderer: diagnostics.rendererInfo,
          softwareRenderer: diagnostics.softwareRenderer,
          harness: test.info().project.name,
          displayRefreshHz: test.info().project.name === 'headless-gpu' ? 'synthetic 60 Hz BeginFrame' : 49.95,
          note:
            'simulationMs/renderMs measure GL command submission, not GPU execution, because WebGL ' +
            'submits asynchronously; the frame-time percentiles are rAF intervals and therefore the ' +
            'delivered display cadence, which on this laptop panel is capped at 49.95 Hz. The ' +
            'drainedFrameBenchmark serialises each frame with a one-pixel readback to measure the ' +
            'real per-frame cost (2 simulation steps per frame = the nominal 120 steps/s at 60 fps).',
          nominalSimulationStepsPerSecond: TIME.nominalStepsPerSecond,
          measurements: [at720, at1080],
          drainedFrameBenchmark: { at1080: benchmark1080, at720: benchmark720 },
        },
        null,
        2,
      ),
    );

    expect(at1080['deliveredSimulationStepsPerSecond']).toBeGreaterThan(0);
    expect(benchmark1080['msPerFrame'] as number).toBeGreaterThan(0);
    expect(diagnostics.rendererInfo.length).toBeGreaterThan(0);
  });

  test('parameter override reaches the solver through the command surface', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const value = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };
    const result = await hook<{ ok: boolean; reason?: string }>(page, 'dispatch', [
      { type: 'parameters', value, mode: 'override' },
    ]);
    expect(result.ok).toBe(true);
    const applied = await hook<ParamsShape>(page, 'parameters');
    expect(applied).toEqual(value);

    // The §6.2 envelope is enforced before anything reaches the solver.
    const rejected = await hook<{ ok: boolean; reason?: string }>(page, 'dispatch', [
      { type: 'parameters', value: { ...value, k: 0.5 }, mode: 'override' },
    ]);
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toContain('k must be within');
  });
});
