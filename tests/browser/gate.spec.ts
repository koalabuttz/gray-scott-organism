/**
 * Phase 1 material gate artifacts (§12.1).
 *
 * Produces, for the operator's `Phase1MaterialGate`:
 *
 *   1. three labelled PNG captures of **one continuous run from one genesis seed** — the plan's
 *      "one strong genesis condition", not a lattice of identical seeds (a uniform lattice grown on
 *      a translation-invariant torus stays periodic and reads as tiled wallpaper);
 *   2. a rejected lattice control in `controls/`, captured with the same parameters and the same
 *      delivered step count, purely so the repetition check below can be shown to discriminate;
 *   3. a candidate sheet of (F,k) alternatives, all using the same single-seed genesis;
 *   4. a 60-120 s real-time WebM clip, with its duration and codec verified from the file itself;
 *   5. README-gate.md and captures.json recording the exact genesis commands, the parameters, the
 *      measured image/field statistics, the verified clip metadata, and — for every value written
 *      into them — the live state the renderer actually used.
 *
 * Every output is written into a staging directory inside `artifacts/` and published with a
 * failure-safe two-rename swap *after* the last assertion has passed (`tests/support/gate-publish.ts`)
 * — a brief absence window between the two renames, but a reader never sees a mixed tree — so a
 * failing run publishes nothing at all and leaves the previous tree untouched. The `GATE=1` test
 * produces the artifacts; an ungated probe in the same file runs the identical flow with a deliberately
 * mismatched live exposure and asserts that it fails without publishing (or leaving a temp tree).
 *
 * Long-running by design, so it is gated behind `GATE=1`:
 *   npm run test:gate
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOOM, COMPOSITE, LIGHTING, MATERIAL, SIMULATION_GRID, SURFACE, TIME } from '../../src/config.ts';
import { createSingleSeedCommand } from '../../src/simulation/genesis.ts';
import { hook, openArtwork, harnessSection, ARTIFACTS_DIR } from '../support/browser.ts';
import type { HarnessLaunchOptions } from '../support/browser.ts';
import { GatePublisher, stagingLeftovers, treeDigest } from '../support/gate-publish.ts';
import { ffmpegInfo, inspectWebm } from '../support/webm.ts';
import type { FfmpegInfo, WebmMetadata } from '../support/webm.ts';
import type {
  GenesisCommandShape,
  ImageStatsShape,
  LabSnapshotShape,
  ParamsShape,
  PublishedStateShape,
  SummaryShape,
} from '../support/types.ts';

const GATE_ENABLED = process.env['GATE'] === '1';
const CLIP_SECONDS = Number(process.env['GATE_CLIP_SECONDS'] ?? 60);
/** Growth curve (artifacts/phase1-growth.json): occupancy reaches 99% of its long-run plateau by
 * 16,000 steps (0.63 of the domain, extent 1.0x1.0) and stays there through 50,000 steps. */
const MATURE_STEPS = Number(process.env['GATE_STEPS'] ?? 16_000);
const NEAR_INVISIBLE_STEPS = 600;
const CANDIDATE_STEPS = Number(process.env['GATE_CANDIDATE_STEPS'] ?? 8_000);
const LATTICE_DIVISIONS = 4;
const LATTICE_RADIUS_CELLS = 5;

const GATE_DIR = process.env['GATE_DIR'] ?? 'phase1-gate';

/**
 * The Phase 1 genesis condition: one `single` seed, perturbed per §4.4 from a recorded seed
 * number. The exact command (including the perturbed centre, radius and strength it produced) is
 * recorded into README-gate.md and captures.json.
 */
const GENESIS = {
  seed: 2_026_031,
  center: [0.44, 0.53] as [number, number],
  radiusCells: 6,
  strength: 1,
} as const;

/** The whole arc uses one parameter set, so the three stills are three moments of one organism. */
const MATURE_PARAMETERS: ParamsShape = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };

const CANDIDATES: Array<{ label: string; params: ParamsShape }> = [
  { label: 'labyrinth-fine-0.029-0.059', params: { F: 0.029, k: 0.059, Du: 0.16, Dv: 0.08 } },
  { label: 'labyrinth-fine-0.029-0.060', params: { F: 0.029, k: 0.06, Du: 0.16, Dv: 0.08 } },
  { label: 'worms-0.030-0.062', params: { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 } },
  { label: 'dense-0.022-0.054', params: { F: 0.022, k: 0.054, Du: 0.16, Dv: 0.08 } },
  { label: 'nucleation-0.026-0.060', params: { F: 0.026, k: 0.06, Du: 0.16, Dv: 0.08 } },
  { label: 'coral-0.0545-0.062', params: { F: 0.0545, k: 0.062, Du: 0.16, Dv: 0.08 } },
  { label: 'mitosis-0.0367-0.0649', params: { F: 0.0367, k: 0.0649, Du: 0.16, Dv: 0.08 } },
];

interface Provenance {
  /** Values the renderer consumed for this frame, from the published snapshot. */
  published: PublishedStateShape;
  /** Exposure and bloom gain the composite pass actually used. */
  appliedTone: { exposure: number; bloomGain: number };
  /** Live app-level identifiers. */
  sessionRootSeed: number;
  scene: string;
  canvas: string;
}

interface CaptureRecord {
  label: string;
  file: string;
  role: 'mandatory' | 'control' | 'candidate';
  parameters: ParamsShape;
  genesis: GenesisCommandShape[];
  steps: number;
  image: ImageStatsShape;
  field: SummaryShape;
  provenance: Provenance;
  notes: string;
}

interface GateRunOptions {
  /** Directory under `artifacts/` that receives the published tree. */
  gateDir: string;
  /** Deliberate live deviation applied through the verification hook (the negative probe only). */
  materialOverride?: Record<string, number>;
  viewport: { width: number; height: number };
  /** Optional progress trail: one entry per stage boundary reached. */
  trail?: string[];
}

/**
 * The gate run: one continuous single-seed arc, a rejected lattice control, the candidate sheet, the
 * verified clip, and the metadata that records the live state each capture used.
 *
 * Every output is written into a staging directory and published with a single rename *after* the
 * last assertion has passed, so a failing run cannot leave a partially updated
 * `artifacts/phase1-gate/` behind (see `tests/support/gate-publish.ts`).
 */
async function runGate(page: Page, options: GateRunOptions): Promise<void> {
  const trail = options.trail;
  const step = (label: string): void => {
    trail?.push(label);
  };
  const publisher = new GatePublisher(options.gateDir);
  try {
    await page.setViewportSize(options.viewport);

    const probe = await openArtwork(page);
    expect(probe.ok, `the artwork must start to produce gate artifacts: ${probe.reason}`).toBe(true);
    if (!probe.ok) return;
    step('opened');

    const pngPath = (name: string): string => publisher.path(name);
    const gateDir = options.gateDir;

    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    if (options.materialOverride) await hook(page, 'setMaterial', [options.materialOverride]);

    const canvas = page.locator('#stage');
    const records: CaptureRecord[] = [];

    const provenance = async (): Promise<Provenance> => {
      const published = await hook<PublishedStateShape>(page, 'publishedState');
      const appliedTone = await hook<{ exposure: number; bloomGain: number }>(page, 'appliedToneState');
      const size = await hook<{ width: number; height: number }>(page, 'canvasSize');
      const scene = await hook<{ width: number; height: number }>(page, 'sceneSize');
      return {
        published,
        appliedTone,
        sessionRootSeed: snapshot.seed,
        scene: `${scene.width}x${scene.height}`,
        canvas: `${size.width}x${size.height}`,
      };
    };

    const measure = async (): Promise<{ image: ImageStatsShape; field: SummaryShape }> => {
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      const field = await hook<SummaryShape>(page, 'fieldSummary', [0.1, 0.25]);
      return { image, field };
    };

    // ---------------------------------------------------------------- one continuous arc
    // One genesis command, built here and applied verbatim, so the recorded command is by
    // construction the applied command.
    const genesis = createSingleSeedCommand({
      center: GENESIS.center,
      seed: GENESIS.seed,
      perturb: true,
      radiusCells: GENESIS.radiusCells,
      strength: GENESIS.strength,
      mode: 'replace',
    }) as unknown as GenesisCommandShape;

    await hook(page, 'reset');
    await hook(page, 'setParameters', [MATURE_PARAMETERS]);
    await hook(page, 'applyGenesis', [genesis]);
    console.info(
      `[gate] genesis applied: kind=${genesis.kind} mode=${genesis.mode} seed=${genesis.seed} ` +
        `center=[${genesis.center.map((n) => n.toFixed(5)).join(', ')}] ` +
        `radiusCells=${genesis.radiusCells.toFixed(3)} strength=${genesis.strength.toFixed(5)}`,
    );

    // 1. near-invisible: the same organism 600 steps (5 s of nominal performance time) into its life
    await hook(page, 'simulate', [NEAR_INVISIBLE_STEPS]);
    await hook(page, 'renderOnce');
    await canvas.screenshot({ path: pngPath('01-near-invisible.png') });
    {
      const { image, field } = await measure();
      records.push({
        label: 'near-invisible state',
        file: `${gateDir}/01-near-invisible.png`,
        role: 'mandatory',
        parameters: { ...MATURE_PARAMETERS },
        genesis: [genesis],
        steps: NEAR_INVISIBLE_STEPS,
        image,
        field,
        provenance: await provenance(),
        notes: 'the same continuous run, 600 delivered steps after the single genesis',
      });
    }

    // 2. mature: continue the same field to the growth-curve plateau
    const matureStarted = Date.now();
    await hook(page, 'simulate', [MATURE_STEPS - NEAR_INVISIBLE_STEPS]);
    const matureSeconds = (Date.now() - matureStarted) / 1000;
    await hook(page, 'renderOnce');
    await canvas.screenshot({ path: pngPath('02-mature-wet-material.png') });
    let matureSymmetry = 0;
    let matureImage: ImageStatsShape | null = null;
    {
      const { image, field } = await measure();
      matureSymmetry = field.symmetry.score;
      matureImage = image;
      records.push({
        label: 'mature wet-material state',
        file: `${gateDir}/02-mature-wet-material.png`,
        role: 'mandatory',
        parameters: { ...MATURE_PARAMETERS },
        genesis: [genesis],
        steps: MATURE_STEPS,
        image,
        field,
        provenance: await provenance(),
        notes:
          `same continuous run continued to ${MATURE_STEPS} delivered steps ` +
          `(GL submission for the 15,400-step increment measured ${matureSeconds.toFixed(1)} s; GPU execution is ` +
          `asynchronous and is drained before the capture), overhead camera, no camera or material override`,
      });
    }

    // 3. grazing-edge close view: identical field, camera lowered to 12 degrees at 1.75 world units
    await hook(page, 'dispatch', [
      {
        type: 'camera',
        value: { mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.5, 0.5], transitionSeconds: 0 },
      },
    ]);
    await hook(page, 'renderOnce');
    await canvas.screenshot({ path: pngPath('03-grazing-edge-close.png') });
    {
      const { image, field } = await measure();
      records.push({
        label: 'grazing-edge close view',
        file: `${gateDir}/03-grazing-edge-close.png`,
        role: 'mandatory',
        parameters: { ...MATURE_PARAMETERS },
        genesis: [genesis],
        steps: MATURE_STEPS,
        image,
        field,
        provenance: await provenance(),
        notes: 'same field and material; only the documented camera override to 12 degrees elevation at 1.75 world units',
      });
    }
    await hook(page, 'dispatch', [{ type: 'camera', value: null }]);
    step('mandatory-captures-written');

    // ---------------------------------------------------------------- gate assertions on live state
    step('provenance-assertions');
    const matureRecord = records[1]!;
    const live = matureRecord.provenance;
    console.info(
      `[gate] live state at the mature capture: exposure=${live.appliedTone.exposure} (config ${COMPOSITE.exposure}), ` +
        `bloomGain=${live.appliedTone.bloomGain} (config ${BLOOM.gain}), relief=${live.published.material.relief} ` +
        `(config ${SURFACE.reliefAmplitude}), roughness=${live.published.material.roughness} (config ${MATERIAL.roughness}), ` +
        `light intensity=${live.published.light.intensity} (config ${LIGHTING.intensity}) ` +
        `elevation=${live.published.light.elevationRadians} (config ${LIGHTING.elevationRadians}), ` +
        `F=${live.published.parameters.F} k=${live.published.parameters.k}`,
    );

    // The values written into README-gate.md and captures.json are *these* live readbacks, and they
    // must equal the calibrated configuration. Before this check existed the gate metadata printed
    // the config exposure (1.5) while the renderer actually used 1.0.
    expect(live.appliedTone.exposure, 'composite exposure the capture used').toBe(COMPOSITE.exposure);
    expect(live.appliedTone.bloomGain, 'composite bloom gain the capture used').toBe(BLOOM.gain);
    expect(live.published.material.exposure, 'published material exposure').toBe(live.appliedTone.exposure);
    expect(live.published.material.bloomGain, 'published material bloom gain').toBe(live.appliedTone.bloomGain);
    expect(live.published.material.relief).toBe(SURFACE.reliefAmplitude);
    expect(live.published.material.roughness).toBe(MATERIAL.roughness);
    expect(live.published.material.emissionTintLinear).toEqual([...MATERIAL.emissionTintLinear]);
    expect(live.published.light.intensity).toBe(LIGHTING.intensity);
    expect(live.published.light.elevationRadians).toBeCloseTo(LIGHTING.elevationRadians, 12);
    expect(live.published.light.azimuthRadians).toBeCloseTo(LIGHTING.azimuthRadians, 12);
    expect(live.published.light.emissionGain).toBe(MATERIAL.emissionGain);
    expect(live.published.light.environment).toBe(MATERIAL.environment);
    expect(live.published.parameters).toEqual(MATURE_PARAMETERS);
    expect(live.published.camera.elevationRadians).toBeCloseTo(
      (84 * Math.PI) / 180,
      12,
    );
    // The genesis recorded in the metadata is the command that was applied.
    expect(matureRecord.genesis[0]).toEqual(genesis);
    expect(genesis.kind).toBe('single');
    expect(genesis.mode).toBe('replace');
    expect(genesis.seed).toBe(GENESIS.seed);
    step('tone-asserted');

    // Black dominance and no highlight clipping at the calibrated exposure.
    expect(matureImage.percentiles[0], 'median pixel must be exactly black').toBe(0);
    expect(matureImage.clippedFraction, 'no pixels at or above 250/255').toBeLessThan(0.001);
    expect(matureImage.max).toBeGreaterThan(120);
    expect(matureImage.nonBlackFraction).toBeGreaterThan(0.05);
    expect(matureImage.nonBlackFraction).toBeLessThan(0.7);

    // ---------------------------------------------------------------- real-time clip
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(500);
    await hook(page, 'setPaused', [false]);
    await page.keyboard.press('Backquote');
    await page.locator('[data-role="laboratory"]').waitFor({ state: 'visible' });
    const recordingStart = await hook<{ mimeType: string }>(page, 'startRecording');
    console.info(`[gate] recording ${CLIP_SECONDS}s as ${recordingStart.mimeType}`);
    await page.waitForTimeout(CLIP_SECONDS * 1000);
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: 'stop recording' }).click();
    const download = await downloadPromise;
    const clipPath = pngPath('04-real-time-clip.webm');
    await download.saveAs(clipPath);
    await page.keyboard.press('Backquote');
    // Read throughput *after* the clip: the app was paused for the stills, and the rolling
    // one-second window would otherwise still hold the paused (zero-step) value.
    const recordingDiag = await hook<{ deliveredFps: number; simStepsPerSecond: number; rendererInfo: string }>(
      page,
      'diagnostics',
    );
    const clipBytes = existsSync(clipPath) ? statSync(clipPath).size : 0;
    expect(clipBytes).toBeGreaterThan(100_000);

    // Verify the file rather than trusting the recorder: container view from ffmpeg, and the real
    // duration/frame count from the WebM's own timestamps (MediaRecorder writes no duration element,
    // which is why ffmpeg reports "Duration: N/A").
    const ffmpeg = ffmpegInfo(clipPath);
    const webm = inspectWebm(clipPath);
    console.info(
      `[gate] clip verified: ${webm.codecId} ${webm.pixelWidth}x${webm.pixelHeight}, ${webm.frames} frames, ` +
        `${webm.durationSeconds?.toFixed(3)}s (median frame interval ${webm.medianFrameIntervalMs} ms, effective ` +
        `${webm.effectiveFps?.toFixed(3)} fps, max interval ${webm.maxFrameIntervalMs} ms), ${(clipBytes / 1024 / 1024).toFixed(1)} MiB`,
    );
    console.info(`[gate] ffmpeg container view: ${ffmpeg.codecLine} | ${ffmpeg.durationLine}`);
    expect(webm.parseError).toBeNull();
    expect(webm.codecId).toContain('VP9');
    expect(webm.pixelWidth).toBe(1280);
    expect(webm.pixelHeight).toBe(720);
    expect(webm.frames).toBeGreaterThan(CLIP_SECONDS * 20);
    expect(webm.declaredDurationSeconds, 'MediaRecorder writes no duration element').toBeNull();
    expect(webm.durationSeconds).not.toBeNull();
    expect(Math.abs((webm.durationSeconds ?? 0) - CLIP_SECONDS)).toBeLessThan(5);
    expect(webm.effectiveFps ?? 0).toBeGreaterThan(20);
    expect(ffmpeg.codecLine ?? '').toContain('vp9');

    // ---------------------------------------------------------------- lattice control (rejected)
    const latticeCommands: GenesisCommandShape[] = [];
    {
      const step = 1 / LATTICE_DIVISIONS;
      for (let j = 0; j < LATTICE_DIVISIONS; j += 1) {
        for (let i = 0; i < LATTICE_DIVISIONS; i += 1) {
          latticeCommands.push(
            createSingleSeedCommand({
              center: [step * (i + 0.5), step * (j + 0.5)],
              seed: GENESIS.seed,
              perturb: false,
              radiusCells: LATTICE_RADIUS_CELLS,
              strength: 1,
              mode: i === 0 && (j === 0) ? 'replace' : 'inject',
            }) as unknown as GenesisCommandShape,
          );
        }
      }
    }
    await hook(page, 'reset');
    await hook(page, 'setParameters', [MATURE_PARAMETERS]);
    for (const command of latticeCommands) await hook(page, 'applyGenesis', [command]);
    await hook(page, 'simulate', [MATURE_STEPS]);
    await hook(page, 'renderOnce');
    await canvas.screenshot({ path: pngPath('controls/lattice-4x4-rejected.png') });
    let controlSymmetry = 0;
    let controlOccupancy = 0;
    {
      const { image, field } = await measure();
      controlSymmetry = field.symmetry.score;
      controlOccupancy = field.occupiedFraction;
      records.push({
        label: 'REJECTED CONTROL: 4x4 uniform seed lattice',
        file: `${gateDir}/controls/lattice-4x4-rejected.png`,
        role: 'control',
        parameters: { ...MATURE_PARAMETERS },
        genesis: latticeCommands,
        steps: MATURE_STEPS,
        image,
        field,
        provenance: await provenance(),
        notes:
          `rejected control, NOT an approval asset: ${LATTICE_DIVISIONS}x${LATTICE_DIVISIONS} identical seeds on a ` +
          'uniform lattice, same parameters and same delivered steps as the mature capture. Shows what the ' +
          'repetition check detects.',
      });
    }

    // Repetition check: the mandatory single-seed capture must not repeat at the lattice period,
    // while the control must. Both fields must actually be alive first — a dead field has zero
    // variance and would otherwise score 1.0 on the symmetry metric (see the mitosis candidate,
    // which dies on this solver and which the occupancy guard below deliberately exposes).
    console.info(
      `[gate] repetition check at a ${records[1]!.field.symmetry.periodCells.join('x')}-cell period: ` +
        `single-seed mature ${matureSymmetry.toFixed(3)} (occupied ${records[1]!.field.occupiedFraction.toFixed(4)}) ` +
        `vs lattice control ${controlSymmetry.toFixed(3)} (occupied ${controlOccupancy.toFixed(4)}) ` +
        '(1 = repeats exactly, 0 = no correlation)',
    );
    expect(records[1]!.field.occupiedFraction, 'the mature capture must be a living field').toBeGreaterThan(0.3);
    expect(controlOccupancy, 'the control must be a living field for the comparison to mean anything').toBeGreaterThan(
      0.3,
    );
    expect(matureSymmetry).toBeLessThan(0.3);
    expect(controlSymmetry).toBeGreaterThan(0.6);
    expect(controlSymmetry - matureSymmetry).toBeGreaterThan(0.5);

    // ---------------------------------------------------------------- candidate sheet
    for (const candidate of CANDIDATES) {
      await hook(page, 'reset');
      await hook(page, 'setParameters', [candidate.params]);
      const command = createSingleSeedCommand({
        center: GENESIS.center,
        seed: GENESIS.seed,
        perturb: true,
        radiusCells: GENESIS.radiusCells,
        strength: GENESIS.strength,
        mode: 'replace',
      }) as unknown as GenesisCommandShape;
      await hook(page, 'applyGenesis', [command]);
      await hook(page, 'simulate', [CANDIDATE_STEPS]);
      await hook(page, 'renderOnce');
      await canvas.screenshot({ path: pngPath(`candidates/${candidate.label}.png`) });
      const { image, field } = await measure();
      records.push({
        label: `candidate ${candidate.label}`,
        file: `${gateDir}/candidates/${candidate.label}.png`,
        role: 'candidate',
        parameters: candidate.params,
        genesis: [command],
        steps: CANDIDATE_STEPS,
        image,
        field,
        provenance: await provenance(),
        notes: `controlled experiment: same single-seed genesis, ${CANDIDATE_STEPS} delivered steps (mid-growth, before the domain saturates)`,
      });
    }

    // ---------------------------------------------------------------- metadata
    const project = test.info().project;
    const harness = harnessSection(
      project.name,
      project.use.launchOptions as HarnessLaunchOptions | undefined,
      {
        renderer: recordingDiag.rendererInfo,
        softwareRenderer: false,
        colorBufferFloat: true,
      },
    );
    const readme = renderGateReadme({
      records,
      clip: {
        file: `${gateDir}/04-real-time-clip.webm`,
        seconds: CLIP_SECONDS,
        bytes: clipBytes,
        mimeType: recordingStart.mimeType,
        webm,
        ffmpeg,
      },
      capability: {
        harness: project.name,
        renderer: recordingDiag.rendererInfo,
        deliveredFps: recordingDiag.deliveredFps,
        deliveredStepsPerSecond: recordingDiag.simStepsPerSecond,
        sessionRootSeed: snapshot.seed,
        matureSymmetry,
        controlSymmetry,
      },
      harness,
    });
    publisher.write('README-gate.md', readme);
    publisher.write('captures.json', JSON.stringify(records, null, 2));

    expect(records.filter((record) => record.role === 'mandatory')).toHaveLength(3);
    expect(records.filter((record) => record.role === 'candidate')).toHaveLength(CANDIDATES.length);
    expect(records.filter((record) => record.role === 'control')).toHaveLength(1);

    // Every assertion above has passed, so the staged tree can replace the published one in a single
    // rename. Nothing below can fail: publication is the last statement of the run.
    step('assertions-passed');
    publisher.publish();
    step('published');
  } finally {
    // No-op after a successful publish; on any failure it removes the staged tree so a failed run
    // leaves neither partial artifacts nor a temporary directory behind.
    publisher.abort();
  }
}

test.describe('phase 1 material gate', () => {
  test.skip(!GATE_ENABLED, 'set GATE=1 to produce the phase-1 gate artifacts (long-running)');

  test('one continuous single-seed arc, a rejected lattice control, candidates, verified clip and README-gate.md', async ({ page }) => {
    test.setTimeout(45 * 60_000);
    await runGate(page, { gateDir: GATE_DIR, viewport: { width: 1920, height: 1080 } });
  });
});

/**
 * Publishing safety — and this one runs in the *default* suite rather than behind `GATE=1`, because
 * "a failed gate publishes nothing" is a property of every run, not just of the long one.
 *
 * The probe runs the same capture flow with a deliberately live-mismatched composite exposure (the
 * historical failure mode: the metadata's exposure disagreed with the one the renderer applied, so
 * every still was rendered at 1.0 while the README claimed 1.5). It asserts that the run fails at the
 * provenance assertion, that the temporary tree is cleaned up, and that nothing was published.
 *
 * It publishes into its own directory rather than `phase1-gate/`, so a regression in the publish
 * discipline cannot destroy approved evidence before this test reports it; the operator's tree is
 * additionally compared hash-for-hash afterwards.
 */
test.describe('phase 1 material gate (publish safety)', () => {
  const PROBE_DIR = `${GATE_DIR}-negative-probe`;

  test.afterAll(() => {
    for (const leftover of [resolve(ARTIFACTS_DIR, PROBE_DIR), ...stagingLeftovers(PROBE_DIR)]) {
      rmSync(leftover, { recursive: true, force: true });
    }
  });

  test('a mismatched live exposure fails the gate and publishes nothing', async ({ page }) => {
    test.setTimeout(10 * 60_000);

    const probeDir = resolve(ARTIFACTS_DIR, PROBE_DIR);
    const publishedBefore = treeDigest(resolve(ARTIFACTS_DIR, GATE_DIR));
    const mismatchedExposure = COMPOSITE.exposure + 1;
    const trail: string[] = [];

    let failure: Error | null = null;
    try {
      await runGate(page, {
        gateDir: PROBE_DIR,
        materialOverride: { exposure: mismatchedExposure },
        viewport: { width: 1920, height: 1080 },
        trail,
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }

    console.info(`[gate-negative] stages reached: ${trail.join(' -> ')}`);
    console.info(
      `[gate-negative] failed with: ${failure === null ? 'no failure (the gate published a mismatched exposure)' : failure.message.split('\n').slice(0, 5).join(' | ')}`,
    );

    // 1. The run fails at the provenance assertion: the three mandatory captures were written into
    //    staging and the assertion stage was entered, but the tone assertion (the first one in that
    //    stage) did not pass, and publication was never reached.
    expect(failure, 'the gate must fail when the live exposure is not the calibrated one').not.toBeNull();
    expect(trail).toContain('mandatory-captures-written');
    expect(trail).toContain('provenance-assertions');
    expect(trail).not.toContain('tone-asserted');
    expect(trail).not.toContain('published');

    // The mismatch was live — it is the renderer's own readback, not a changed expectation.
    const tone = await hook<{ exposure: number; bloomGain: number }>(page, 'appliedToneState');
    expect(tone.exposure).toBe(mismatchedExposure);
    expect(tone.exposure).not.toBe(COMPOSITE.exposure);

    // 2. Nothing was published, and the staging tree was removed.
    expect(existsSync(probeDir), 'a failed gate run must publish no artifacts').toBe(false);
    expect(stagingLeftovers(PROBE_DIR), 'the staging tree must be cleaned up').toEqual([]);

    // 3. The published gate artifacts are byte-for-byte what they were before the probe.
    expect(treeDigest(resolve(ARTIFACTS_DIR, GATE_DIR))).toEqual(publishedBefore);
  });
});

function renderGateReadme(input: {
  records: CaptureRecord[];
  clip: {
    file: string;
    seconds: number;
    bytes: number;
    mimeType: string;
    webm: WebmMetadata;
    ffmpeg: FfmpegInfo;
  };
  capability: {
    harness: string;
    renderer: string;
    deliveredFps: number;
    deliveredStepsPerSecond: number;
    sessionRootSeed: number;
    matureSymmetry: number;
    controlSymmetry: number;
  };
  harness: string;
}): string {
  const lines: string[] = [];
  const mandatory = input.records.filter((record) => record.role === 'mandatory');
  const mature = mandatory[1] ?? mandatory[0]!;
  const provenance = mature.provenance;

  lines.push('# Phase 1 material gate — An Organism in Darkness');
  lines.push('');
  lines.push('Everything here was captured from the running piece, unmodified: no image editing, no');
  lines.push('camera cheat beyond the documented grazing-view camera override, no extra effects.');
  lines.push('');
  lines.push('The three mandatory stills are **one continuous run from one genesis seed** — the plan\'s');
  lines.push('"one strong genesis condition" — captured at three moments of the same organism.');
  lines.push('');
  lines.push('## Machine and harness');
  lines.push('');
  lines.push(`- Renderer: \`${input.capability.renderer}\``);
  lines.push(`- Canvas: ${provenance.canvas} for the stills, 1280x720 for the clip`);
  lines.push(`- Internal HDR scene: ${provenance.scene} for the stills (§11.1 caps the scene at a 1920x1080-equivalent pixel count; the renderer re-derives it on resize)`);
  lines.push(
    `- Throughput during the session: ${input.capability.deliveredFps.toFixed(1)} rendered fps (clip resolution), ` +
      `${input.capability.deliveredStepsPerSecond.toFixed(1)} simulation steps/s`,
  );
  lines.push(
    `- Configuration in force at the mature capture, read back from the live published state: ` +
      `simulation grid ${SIMULATION_GRID.width}x${SIMULATION_GRID.height}, dt = ${TIME.dt}, ` +
      `${TIME.nominalStepsPerSecond} nominal steps/performance-second, ` +
      `F/k/Du/Dv = ${provenance.published.parameters.F}/${provenance.published.parameters.k}/${provenance.published.parameters.Du}/${provenance.published.parameters.Dv}, ` +
      `relief ${provenance.published.material.relief}, roughness ${provenance.published.material.roughness}, ` +
      `F0 ${MATERIAL.f0}, exposure ${provenance.appliedTone.exposure} (applied by the composite pass), ` +
      `bloom gain ${provenance.appliedTone.bloomGain} cap ${BLOOM.gainCap} with a soft knee at linear luminance ${BLOOM.threshold}, ` +
      `light intensity ${provenance.published.light.intensity} at ${((provenance.published.light.elevationRadians * 180) / Math.PI).toFixed(0)} degrees ` +
      `elevation / ${((provenance.published.light.azimuthRadians * 180) / Math.PI).toFixed(0)} degrees azimuth, ` +
      `environment ${provenance.published.light.environment}, emission gain ${provenance.published.light.emissionGain}`,
  );
  lines.push(
    `- Session root seed: \`${input.capability.sessionRootSeed}\` — this is the app's replay seed for the whole session. ` +
      'The gate captures do not derive their genesis from it; each capture\'s exact genesis command is recorded below.',
  );
  lines.push('');
  lines.push(input.harness.trim());
  lines.push('');
  lines.push(
    '- The stills and the clip are canvas content only: the laboratory panel is DOM, not canvas.',
  );
  lines.push('');
  lines.push('## Genesis commands actually applied');
  lines.push('');
  for (const record of input.records.filter((entry) => entry.role !== 'candidate')) {
    lines.push(`- **${record.label}**`);
    if (record.genesis.length === 1) {
      const command = record.genesis[0]!;
      lines.push(
        `  - \`kind=${command.kind} mode=${command.mode} seed=${command.seed} center=[${command.center
          .map((n) => n.toFixed(5))
          .join(', ')}] radiusCells=${command.radiusCells.toFixed(3)} strength=${command.strength.toFixed(5)}\``,
      );
    } else {
      lines.push(
        `  - ${record.genesis.length} recorded commands (full list in \`captures.json\`): a uniform ` +
          `${LATTICE_DIVISIONS}x${LATTICE_DIVISIONS} lattice, spacing ${(1 / LATTICE_DIVISIONS).toFixed(4)} of the domain, ` +
          `each \`kind=single\` with radiusCells=${LATTICE_RADIUS_CELLS}, strength=1, the first \`mode=replace\` and the rest \`mode=inject\`, ` +
          'deliberately unperturbed so the lattice is exact.',
      );
    }
  }
  lines.push(
    `- The candidate sheet reuses the single-seed command verbatim (seed ${GENESIS.seed}, centre ` +
      `[${GENESIS.center.map((n) => n.toFixed(5)).join(', ')}], radiusCells ${GENESIS.radiusCells}, strength ${GENESIS.strength}, ` +
      'mode=replace, §4.4 perturbation enabled); its per-capture command is in `captures.json`.',
  );
  lines.push('');
  lines.push('## Captures');
  lines.push('');
  for (const record of input.records) {
    lines.push(`### ${record.label}`);
    lines.push('');
    lines.push(`- File: \`${record.file}\``);
    lines.push(
      `- Parameters: F=${record.parameters.F}, k=${record.parameters.k}, Du=${record.parameters.Du}, Dv=${record.parameters.Dv}`,
    );
    lines.push(`- Genesis: ${record.genesis.length} command(s); ${record.notes}`);
    lines.push(`- Delivered steps: ${record.steps}`);
    lines.push(
      `- Image: max=${record.image.max}, mean=${record.image.mean.toFixed(3)}, p50=${record.image.percentiles[0]}, ` +
        `p95=${record.image.percentiles[1]}, p99=${record.image.percentiles[2]}, ` +
        `lit=${(record.image.nonBlackFraction * 100).toFixed(2)}%, bright=${(record.image.aboveThresholdFraction * 100).toFixed(2)}%, ` +
        `clipped=${(record.image.clippedFraction * 100).toFixed(4)}%`,
    );
    lines.push(
      `- Field: occupied=${record.field.occupiedFraction.toFixed(4)}, maxV=${record.field.maxV.toFixed(3)}, ` +
        `extent=${record.field.extentUV.map((n) => n.toFixed(3)).join('x')}, centroid=[${record.field.centroidUV
          .map((n) => n.toFixed(3))
          .join(', ')}], ` +
        `symmetry at a ${record.field.symmetry.periodCells.join('x')}-cell period=${record.field.symmetry.score.toFixed(3)}`,
    );
    lines.push(
      `- Live state used: exposure ${record.provenance.appliedTone.exposure}, bloom gain ${record.provenance.appliedTone.bloomGain}, ` +
        `relief ${record.provenance.published.material.relief}, roughness ${record.provenance.published.material.roughness}, ` +
        `light intensity ${record.provenance.published.light.intensity} at elevation ${record.provenance.published.light.elevationRadians.toFixed(4)} rad, ` +
        `camera elevation ${record.provenance.published.camera.elevationRadians.toFixed(4)} rad at distance ${record.provenance.published.camera.distance.toFixed(3)}`,
    );
    lines.push('');
  }
  lines.push('## Repetition check');
  lines.push('');
  lines.push('A uniform lattice of identical seeds grown on a translation-invariant torus stays periodic,');
  lines.push('which reads as tiled wallpaper rather than one emergent organism. The symmetry score below is');
  lines.push('`1 - mean|V(p) - V(p + period)| / mean|V(p) - mean(V)|` at a period of one quarter of the');
  lines.push('domain (192 cells) — 1 means the field repeats exactly there, 0 means it does not.');
  lines.push('');
  lines.push(`- Mandatory single-seed mature capture: **${input.capability.matureSymmetry.toFixed(3)}**`);
  lines.push(`- Rejected lattice control, same parameters and same steps: **${input.capability.controlSymmetry.toFixed(3)}**`);
  lines.push('');
  lines.push('The control is kept deliberately so this check can be seen to discriminate; it is not an');
  lines.push('approval asset.');
  lines.push('');
  lines.push('## Real-time clip');
  lines.push('');
  const webm = input.clip.webm;
  lines.push(`- File: \`${input.clip.file}\``);
  lines.push(`- ${(input.clip.bytes / 1024 / 1024).toFixed(1)} MiB, recorded as \`${input.clip.mimeType}\``);
  lines.push(
    `- Verified from the file itself: codec id \`${webm.codecId}\`, ${webm.pixelWidth}x${webm.pixelHeight}, ` +
      `**${webm.frames} frames**, **${webm.durationSeconds?.toFixed(2)} s**, ` +
      `median frame interval ${webm.medianFrameIntervalMs} ms (max ${webm.maxFrameIntervalMs} ms), ` +
      `effective ${webm.effectiveFps?.toFixed(2)} fps`,
  );
  lines.push(
    `- Container view from ffmpeg: \`${input.clip.ffmpeg.codecLine ?? 'unavailable'}\`; ` +
      `\`${input.clip.ffmpeg.durationLine ?? 'unavailable'}\``,
  );
  lines.push(
    '- Note: MediaRecorder writes no WebM `Duration` element, so container tools report `Duration: N/A`. ' +
      'The duration above is derived from the file\'s own cluster and block timecodes (see ' +
      '`tests/support/webm.ts`), and independently corroborated by the ffmpeg container view.',
  );
  lines.push('- Silent, as permitted: no audio system exists in Phase 1.');
  lines.push('- Recorded with `canvas.captureStream(30)` + `MediaRecorder` from the live canvas.');
  lines.push('');
  lines.push('## Which (F,k) looked best in the offline search');
  lines.push('');
  lines.push('Selection came from `scripts/tune.ts` (99 (F,k) candidates, 160x160, 12000 steps, one 6-cell');
  lines.push('seed; raw table in `artifacts/phase1-tune.txt`). At F = 0.029:');
  lines.push('');
  lines.push('| k | occupied | mean V | edge density | activity | total edge mass |');
  lines.push('|---:|---:|---:|---:|---:|---:|');
  lines.push('| 0.054 | 0.938 | 0.206 | 0.0214 | 0.0170 | 0.0200 |');
  lines.push('| 0.057 | 0.641 | 0.164 | 0.0450 | 0.0141 | **0.0288** |');
  lines.push('| 0.059 | 0.544 | 0.144 | 0.0484 | 0.0127 | 0.0263 |');
  lines.push('| 0.060 | 0.475 | 0.131 | 0.0513 | 0.0117 | 0.0244 |');
  lines.push('| 0.062 | 0.361 | 0.106 | 0.0482 | 0.0097 | 0.0174 |');
  lines.push('| >=0.0649 | 0 | 0 | 0 | 0 | dead |');
  lines.push('');
  lines.push('k = 0.057 has the largest total boundary mass and is the mature capture above; k = 0.059 and');
  lines.push('k = 0.060 give a finer maze with slightly less mass, so both are kept as candidates. Above');
  lines.push('k ~ 0.0649 everything dies — including the textbook mitosis point (F = 0.0367, k = 0.0649),');
  lines.push('which is in the candidate sheet precisely because it did **not** survive on this solver.');
  lines.push('');
  lines.push('The growth curve that chose the mature step budget (single seed, 768x768) is in');
  lines.push('`artifacts/phase1-growth.json`: occupancy reaches 99% of its long-run plateau by 16,000 steps');
  lines.push('(0.63 of the domain, extent 1.0x1.0) and is unchanged through 50,000 steps.');
  lines.push('');
  lines.push('Reproduce any capture with:');
  lines.push('');
  lines.push('```bash');
  lines.push('npm run test:gate            # GATE=1 playwright test --project=headless-gpu gate.spec.ts');
  lines.push('```');
  lines.push('');
  lines.push('The `--project=headless-gpu` selector matters: running the spec without it would also run the');
  lines.push('opt-in headed project, and the last project to finish would own these files.');
  lines.push('');
  lines.push('## Operator checklist (from architecture-plan §12.1)');
  lines.push('');
  lines.push('Approve only if, watching the clip and the stills:');
  lines.push('');
  lines.push('- [ ] it is **tactile rather than coloured texture** — the surface reads as a material, not as a mapped colour ramp');
  lines.push('- [ ] it is **shallow, not mountainous** — relief reads as millimetres; no terrain silhouette, no inflated blobs');
  lines.push('- [ ] the **canvas boundary is invisible** — no rectangle, no grey floor, no visible domain edge');
  lines.push('- [ ] **black dominates** — the majority of the frame is true black and the organism emerges from darkness');
  lines.push('- [ ] **bloom is restrained** — glow appears only around genuinely intense features and never as a global haze');
  lines.push('- [ ] it reads as **one emergent organism**, not a repeating lattice');
  lines.push('');
  lines.push('And, for the piece as a whole:');
  lines.push('');
  lines.push('- [ ] it reads as an unknown physical organism rather than a reaction-diffusion shader demo');
  lines.push('- [ ] the grazing-edge close view makes local structure legible without exaggeration');
  lines.push('- [ ] the near-invisible state is genuinely near-invisible while still present');
  lines.push('');
  lines.push('A passing test suite does not substitute for this approval.');
  lines.push('');
  return lines.join('\n');
}
