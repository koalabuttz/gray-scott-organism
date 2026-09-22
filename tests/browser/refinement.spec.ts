/**
 * REFINE=1 — §12.4 Phase-4 round-B **visual/artistic refinement** (before/after evidence).
 *
 * This is the measurement harness behind deviation 60. It builds one mature field at the arc-tuned
 * parameters, then renders the *same field* under a sequence of individually toggleable refinement
 * variants and records, for each: the luminance statistics, the lit-pixel colour statistics (mean
 * RGB, warmth `R−B`, saturation, 12-bin hue histogram), the isolated bloom contribution, and the
 * pixelwise difference against the all-off baseline. Every variant is captured as a PNG.
 *
 * Bloom (#3) gets a **threshold × gain grid** because the plan's "soft knee at linear luminance 1.0"
 * was unreachable as built: the knee was applied *after* the 13-tap reduction, so it acted on a
 * half-resolution average whose overhead maximum is ≈0.3 — the mature frame was byte-identical at
 * gain 0 and 0.12. The grid (and the `legacy`/`post-average` variants) are what found and documented
 * the working point.
 *
 * Every accepted change must be *attributable* to one mathematical quantity and satisfy the hard
 * constraints, which this spec asserts rather than assumes:
 *   - p50 stays exactly 0 and clipping stays at 0 (true black is never lifted);
 *   - the palette stays near-neutral (bounded `meanSaturation` and `|R−B|`);
 *   - bloom is effective (> the byte-identical baseline) but restrained (no global haze);
 *   - the all-zero config reproduces itself bit-for-bit (the identity the frozen Phase-1 gate relies on).
 *
 * Run: `REFINE=1 npx playwright test --project=headless-gpu refinement.spec.ts`
 * Writes `artifacts/phase4-refinement/`.
 */
import { expect, test } from '@playwright/test';
import { BLOOM, REFINEMENT, SURFACE } from '../../src/config.ts';
import { hook, openArtwork } from '../support/browser.ts';
import { writeJson, writePng } from '../support/evidence.ts';
import type {
  ColorStatsShape,
  FieldStatsShape,
  HeightFieldStatsShape,
  ImageDifferenceShape,
  ImageStatsShape,
  LitLuminanceStatsShape,
  RefinementShape,
} from '../support/types.ts';

const ENABLED = process.env['REFINE'] === '1';
const STEPS = 16_000;
/** The arc-tuned mature point (README-gate.md / `artifacts/phase1-tune.txt`). */
const PARAMS = { F: 0.029, k: 0.057, Du: 0.16, Dv: 0.08 };
const OUT = 'phase4-refinement';
/**
 * §12.4 round 2 writes its own before/after set.
 */
const ROUND2_OUT = `${OUT}/round2`;
/** The relief the shipped round-B render used — the operator's actual "before" in this round. */
const BEFORE_RELIEF = 0.006;
/** The relief round 2 ships; it must equal the config value (asserted in the spec). */
const SHIPPED_RELIEF = SURFACE.reliefAmplitude;

/**
 * The shipped round-B material, frozen as literal constants rather than read from `REFINEMENT`, so
 * round-B evidence stays byte-reproducible after round 2 retunes a shared knob (`interiorDarkening`)
 * and adds new ones. Round 2 uses this as the operator's actual "before".
 */
const ROUND_B: RefinementShape = {
  interiorDarkening: 0.45,
  absorptionChroma: 0.14,
  chromaGateLow: 0.32,
  chromaGateHigh: 0.78,
  roughnessVariation: 0.35,
  heightThicknessRef: 0,
  heightThicknessPower: 1,
  frontBoost: 0,
  frontThinGate: 0.65,
  glossThin: 0,
};
/** All-off baseline: the pre-refinement material (round-B terms *and* the round-2 knobs at zero). */
const OFF: RefinementShape = {
  ...ROUND_B,
  interiorDarkening: 0,
  absorptionChroma: 0,
  roughnessVariation: 0,
};
/**
 * The round-B accepted material. Frozen (not `{...REFINEMENT}`) so this test's evidence cannot be
 * perturbed by round 2, and with the relief pinned to the round-B value in `capture`.
 */
const AFTER: RefinementShape = { ...ROUND_B };

interface BloomParams {
  gain: number;
  threshold: number;
  knee: number;
  kneePerTap: boolean;
}
/** The approved Phase-1 bloom: gain .04, threshold 1.0, knee applied after the reduction. */
const LEGACY_BLOOM: BloomParams = { gain: 0.04, threshold: 1.0, knee: 0.5, kneePerTap: false };
/** The shipped bloom. */
const SHIPPED_BLOOM: BloomParams = { gain: BLOOM.gain, threshold: BLOOM.threshold, knee: BLOOM.knee, kneePerTap: true };
/** Bloom disabled (used to isolate the material refinements from the bloom change). */
const NO_BLOOM: BloomParams = { gain: 0, threshold: BLOOM.threshold, knee: BLOOM.knee, kneePerTap: true };

interface Sample {
  name: string;
  label: string;
  refinement: RefinementShape;
  bloom: BloomParams;
  png: string | null;
  image: ImageStatsShape;
  color: ColorStatsShape;
  /** Pixelwise difference against the stashed all-off baseline (null for the baseline itself). */
  deltaVsBefore: ImageDifferenceShape | null;
  /** Isolated additive bloom contribution for this frame. */
  bloomContribution: ImageDifferenceShape;
}

test.describe('§12.4-B visual refinement', () => {
  test.skip(!ENABLED, 'set REFINE=1 to run the refinement measurement pass');

  test('before/after of each config-gated refinement on a mature field', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const probe = await openArtwork(page);
    expect(probe.ok, probe.reason).toBe(true);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [PARAMS]);
    await hook(page, 'seed', [{ center: [0.44, 0.53], radiusCells: 6, mode: 'replace' }]);
    const started = Date.now();
    await hook(page, 'simulate', [STEPS]);
    await hook(page, 'renderOnce');
    const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
    console.info(
      `[refine] mature field in ${((Date.now() - started) / 1000).toFixed(1)}s: occupied=${field.occupiedFraction.toFixed(4)} ` +
        `meanV=${field.meanV.toFixed(4)} edge=${field.edgeDensity.toFixed(5)} activity=${field.reactionActivity.toFixed(6)}`,
    );
    const overheadCamera = (await hook<{ camera: unknown }>(page, 'publishedState')).camera;

    const samples: Sample[] = [];

    const capture = async (
      name: string,
      label: string,
      refinement: RefinementShape,
      bloom: BloomParams,
      pngName: string | null,
      isBefore = false,
      verbose = true,
    ): Promise<Sample> => {
      await hook(page, 'setRefinement', [refinement]);
      await hook(page, 'setMaterial', [{ bloomGain: bloom.gain, relief: BEFORE_RELIEF }]);
      await hook(page, 'setBloomParams', [{ threshold: bloom.threshold, knee: bloom.knee, kneePerTap: bloom.kneePerTap }]);
      await hook(page, 'renderOnce');
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      const color = await hook<ColorStatsShape>(page, 'colorStats');
      const bloomContribution = await hook<ImageDifferenceShape>(page, 'bloomContribution');
      let deltaVsBefore: ImageDifferenceShape | null = null;
      if (!isBefore) deltaVsBefore = await hook<ImageDifferenceShape>(page, 'diffAgainstStash');
      let png: string | null = null;
      if (pngName) {
        png = `${OUT}/${pngName}`;
        writePng(png, await hook<string>(page, 'capturePngBase64'));
      }
      const sample: Sample = { name, label, refinement, bloom, png, image, color, deltaVsBefore, bloomContribution };
      samples.push(sample);
      if (verbose) {
        console.info(
          `[refine] ${name.padEnd(24)} max=${String(image.max).padStart(3)} mean=${image.mean.toFixed(3)} ` +
            `p50=${image.percentiles[0]} p95=${image.percentiles[1]} p99=${image.percentiles[2]} ` +
            `clipped=${(image.clippedFraction * 100).toFixed(4)}% | R-B=${color.warmMinusCool.toFixed(2)} sat=${color.meanSaturation.toFixed(4)} | ` +
            `bloomΔ=${bloomContribution.maxDelta}@${(bloomContribution.changedFraction * 100).toFixed(3)}%` +
            (deltaVsBefore ? ` | vsBefore maxΔ=${deltaVsBefore.maxDelta} meanΔ=${deltaVsBefore.meanDelta.toFixed(3)} chg=${(deltaVsBefore.changedFraction * 100).toFixed(1)}%` : ''),
        );
      }
      return sample;
    };

    // --- baseline: the approved Phase-1 render (all-off material, pre-refinement bloom) ----------
    await capture('before-all', 'approved Phase-1 render (refinements off, legacy bloom)', OFF, LEGACY_BLOOM, 'before-overhead.png', true);

    // The all-off identity is a **round trip**, not a self-diff: stash the all-off frame, exercise
    // *every* toggle at its accepted setting (the material block and the shipped bloom
    // threshold/gain/knee order), restore the all-off settings, re-render, and require the result to
    // be byte-identical to the stash. A tautological stash-then-diff-the-same-frame would pass even if
    // a toggle leaked into the off state.
    await hook(page, 'stashComposite');
    await capture('toggle-exercise', 'every toggle exercised at its accepted setting', AFTER, SHIPPED_BLOOM, null, true);
    await hook(page, 'setRefinement', [OFF]);
    await hook(page, 'setMaterial', [{ bloomGain: LEGACY_BLOOM.gain, relief: BEFORE_RELIEF }]);
    await hook(page, 'setBloomParams', [{ threshold: LEGACY_BLOOM.threshold, knee: LEGACY_BLOOM.knee, kneePerTap: LEGACY_BLOOM.kneePerTap }]);
    await hook(page, 'renderOnce');
    const identity = await hook<ImageDifferenceShape>(page, 'diffAgainstStash');
    expect(identity.changedFraction, 'the all-off config round-trips bit-for-bit after the toggles').toBe(0);
    expect(identity.maxDelta, 'the all-off config round-trips bit-for-bit after the toggles').toBe(0);

    // --- material refinements, one at a time (bloom off, so only the material differs) -----------
    await capture('after-chroma', '#1 thickness-driven neutralization only', { ...OFF, absorptionChroma: ROUND_B.absorptionChroma }, NO_BLOOM, 'after-thickness-color.png');
    await capture('after-darkening', '#2 interior darkening only (isolated)', { ...OFF, interiorDarkening: ROUND_B.interiorDarkening }, NO_BLOOM, 'after-interior-darkening.png');
    await capture('after-roughness', '#4 boundary-keyed roughness variation only', { ...OFF, roughnessVariation: ROUND_B.roughnessVariation }, NO_BLOOM, 'after-roughness-variation.png');
    await capture('after-material', 'all accepted material refinements', AFTER, NO_BLOOM, null);

    // --- #3 bloom: the defect, the rejected order, and the working point -------------------------
    await capture('legacy-bloom', '#3 the approved bloom config (gain .04, threshold 1.0, post-average knee)', AFTER, LEGACY_BLOOM, null);
    await capture('post-average-knee', '#3 threshold 0.6 after the reduction (under-triggers)', AFTER, { gain: 0.12, threshold: 0.6, knee: 0.5, kneePerTap: false }, null);
    await capture('post-average-haze', '#3 REJECTED: threshold 0.4 after the reduction (broad haze)', AFTER, { gain: 0.12, threshold: 0.4, knee: 0.5, kneePerTap: false }, 'after-bloom-post-average-rejected.png');
    await capture('bloom-off', '#3 bloom off (isolation pair)', AFTER, NO_BLOOM, 'before-bloom.png');
    await capture('bloom-shipped', '#3 shipped bloom (isolation pair)', AFTER, SHIPPED_BLOOM, 'after-bloom.png');
    await capture('after-all', 'all accepted refinements (material + bloom)', AFTER, SHIPPED_BLOOM, 'after-all-overhead.png');

    // threshold x gain grid (per-tap knee), to show the chosen point in context
    const thresholds = [0.45, 0.6, 0.8, 1.0];
    const gains = [0.04, 0.12, 0.3];
    console.info('[refine] --- bloom grid (per-tap knee)');
    for (const threshold of thresholds) {
      for (const gain of gains) {
        await capture(`bloom-t${threshold}-g${gain}`, `#3 threshold ${threshold} gain ${gain}`, AFTER, { gain, threshold, knee: 0.5, kneePerTap: true }, null, false, false);
      }
    }
    const beforeMean = samples.find((s) => s.name === 'before-all')!.image.mean;
    for (const threshold of thresholds) {
      const row = gains.map((gain) => {
        const s = samples.find((x) => x.name === `bloom-t${threshold}-g${gain}`)!;
        return `g${gain}: maxΔ${String(s.bloomContribution.maxDelta).padStart(3)} chg${(s.bloomContribution.changedFraction * 100).toFixed(1).padStart(5)}% meanΔ${(s.image.mean - beforeMean).toFixed(2).padStart(5)}`;
      });
      console.info(`[refine] t=${threshold}  ${row.join('  ')}`);
    }

    // interior-darkening strength sweep: #1 and #4 stay at their accepted settings, so these are
    // **combined** numbers and are reported separately from the isolated `after-darkening` sample.
    console.info('[refine] --- #2 interior darkening strength sweep (combined: #1 and #4 on)');
    for (const interiorDarkening of [0.25, ROUND_B.interiorDarkening, 0.65]) {
      await capture(`darkening-${interiorDarkening}`, `#2 interior darkening ${interiorDarkening} (combined, #1 and #4 on)`, { ...AFTER, interiorDarkening }, NO_BLOOM, null);
    }

    // --- grazing pair (FinalFullArcReview judges this) ------------------------------------------
    await hook(page, 'dispatch', [
      { type: 'camera', value: { mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.5, 0.5], transitionSeconds: 0 } },
    ]);
    await hook(page, 'setRefinement', [OFF]);
    await hook(page, 'setMaterial', [{ bloomGain: LEGACY_BLOOM.gain, relief: BEFORE_RELIEF }]);
    await hook(page, 'setBloomParams', [{ threshold: LEGACY_BLOOM.threshold, knee: LEGACY_BLOOM.knee, kneePerTap: LEGACY_BLOOM.kneePerTap }]);
    await hook(page, 'renderOnce');
    await hook(page, 'stashComposite');
    writePng(`${OUT}/before-grazing.png`, await hook<string>(page, 'capturePngBase64'));
    const grazingBefore = await hook<ImageStatsShape>(page, 'compositeStats');
    await capture('after-all-grazing', 'all accepted refinements, grazing view', AFTER, SHIPPED_BLOOM, 'after-all-grazing.png');

    // --- evidence first, assertions after (so a failed guard still leaves the measurements) ------
    writeJson(`${OUT}/changes.json`, {
      createdAt: new Date().toISOString(),
      field: { steps: STEPS, parameters: PARAMS, occupiedFraction: field.occupiedFraction, meanV: field.meanV, edgeDensity: field.edgeDensity, activity: field.reactionActivity },
      config: { refinement: REFINEMENT, bloom: BLOOM },
      bloomLegacy: LEGACY_BLOOM,
      overheadCamera,
      grazingBefore,
      /**
       * Reviewer round-B findings, corrected. These are the labels the numbers must be read with:
       *  - #1 is a thickness-driven **neutralization**, not an amber moment (see `label` and the
       *    warm-bin figures below).
       *  - #2 has two different tables: the `after-darkening` sample is *isolated*, the `darkening-*`
       *    sweep samples are *combined* (…#1 and #4 on), so their 0.45 values legitimately differ.
       *  - #4 is clamped into the §5.3 roughness band (see `notes`).
       */
      notes: {
        label: 'thickness-driven neutralization',
        refinement1: {
          description:
            '#1 (absorptionChroma) is a thickness-driven NEUTRALIZATION, not a perceptible amber moment. It removes the ' +
            "frame's cool blue cast: R-B -2.44 -> -1.23 and mean HSV saturation 0.0751 -> 0.0385 (lower, i.e. *more* neutral).",
          amberEvidence:
            'No amber claim: lit-pixel warmFraction (R-B >= 2) is exactly 0, and the warm hue bins are negligible — ' +
            'bin 0 (0-30 deg, red/amber) 199 px, bins 0-2 (0-90 deg) 699 px, bins 0+2+4 735 px, out of 506797 lit pixels ' +
            '(0.039% / 0.138% / 0.145%). The earlier "precious amber" wording and the ~0.5% figure were overstated and are dropped.',
        },
        refinement2: {
          isolatedTable: 'only #2 on: 0 -> 0.45 = 10.768 -> 9.052 (p95 58 -> 48, peak delta 20)',
          combinedTable: 'with #1 and #4 on: 0.25 -> 9.466, 0.45 -> 8.761, 0.65 -> 8.102',
          caveat: 'The isolated and combined 0.45 means differ (9.052 vs 8.761); the two tables must not be read as one series.',
        },
        refinement4:
          'local roughness is clamped into the plan §5.3 band [0.24, 0.36] (material.frag uRoughnessBand = ' +
          'MATERIAL.roughnessRange). Unclamped, zero boundary activity gives 0.36 x (1 - 0.35) = 0.234, below the 0.24 floor; ' +
          'with the clamp, activity 0 -> 0.24 and activity 1 -> 0.36. Asserted by tests/material-response.test.ts.',
        identityCheck:
          'the all-off round trip stashes the all-off frame, exercises every toggle at its accepted setting ' +
          '(`toggle-exercise` above), restores all-off, re-renders and requires a byte-identical composite (changed 0, maxDelta 0).',
      },
      samples,
    });

    // --- hard constraints -----------------------------------------------------------------------
    const overhead = samples.filter((s) => s.name !== 'after-all-grazing');
    for (const s of overhead) {
      expect(s.image.percentiles[0], `${s.name}: p50 stays exactly black`).toBe(0);
      expect(s.image.clippedFraction, `${s.name}: no highlight clipping`).toBeLessThanOrEqual(0.0005);
      expect(s.color.meanSaturation, `${s.name}: palette stays near-neutral`).toBeLessThanOrEqual(0.08);
      expect(Math.abs(s.color.warmMinusCool), `${s.name}: warmth stays subtle`).toBeLessThanOrEqual(8);
    }

    const before = samples.find((s) => s.name === 'before-all')!;
    const chroma = samples.find((s) => s.name === 'after-chroma')!;
    const darkening = samples.find((s) => s.name === 'after-darkening')!;
    const roughness = samples.find((s) => s.name === 'after-roughness')!;
    const legacy = samples.find((s) => s.name === 'legacy-bloom')!;
    const postAverage = samples.find((s) => s.name === 'post-average-haze')!;
    const shipped = samples.find((s) => s.name === 'bloom-shipped')!;

    // #1 is a thickness-driven NEUTRALIZATION: it removes the frame's cool cast (R−B rises toward
    // zero) and must not add saturation or produce a perceptible amber moment.
    const warmBinShare = chroma.color.hueHistogram.slice(0, 3).reduce((a, b) => a + b, 0) / chroma.color.litPixels;
    expect(chroma.color.warmMinusCool, '#1 removes the cool cast (R−B rises toward neutral)').toBeGreaterThan(before.color.warmMinusCool);
    expect(chroma.color.meanSaturation, '#1 lowers saturation (neutralizes, never saturates)').toBeLessThan(before.color.meanSaturation);
    expect(chroma.color.warmFraction, '#1 produces no perceptible amber: no lit pixel reaches R−B ≥ 2').toBe(0);
    expect(warmBinShare, '#1 warm-hue (0–90°) pixels stay a negligible share of lit').toBeLessThan(0.005);
    expect(chroma.deltaVsBefore!.changedFraction, '#1 touches a real share of the frame').toBeGreaterThan(0.0005);
    expect(chroma.deltaVsBefore!.changedFraction, '#1 stays restrained').toBeLessThan(0.6);
    // #2: the neutral depth lowers mean luminance (interiors darker).
    expect(darkening.image.mean, '#2 lowers mean luminance').toBeLessThan(before.image.mean);
    // #4: it changes the shading, but only a little.
    expect(roughness.deltaVsBefore!.maxDelta, '#4 changes the shading').toBeGreaterThan(0);
    // #3: the approved bloom config was byte-identical (the defect) ...
    expect(legacy.bloomContribution.changedFraction, 'legacy bloom is byte-identical (the #3 defect)').toBe(0);
    expect(legacy.bloomContribution.maxDelta, 'legacy bloom is byte-identical (the #3 defect)').toBe(0);
    // ... a post-average knee needs threshold 0.4 to reach a comparable amplitude, and then it
    // covers an order of magnitude more of the frame (a haze) — which is why the order was changed ...
    expect(postAverage.bloomContribution.maxDelta, 'post-average knee matches the amplitude at threshold 0.4').toBeGreaterThan(shipped.bloomContribution.maxDelta);
    expect(postAverage.bloomContribution.changedFraction, 'post-average knee hazes the frame (rejected)').toBeGreaterThan(
      5 * shipped.bloomContribution.changedFraction,
    );
    // ... and the shipped bloom is effective yet restrained (no global haze), and never lifts black.
    expect(shipped.bloomContribution.changedFraction, '#3 bloom is effective').toBeGreaterThan(0.0002);
    expect(shipped.bloomContribution.changedFraction, '#3 bloom stays restrained (no global haze)').toBeLessThan(0.05);
    expect(shipped.image.percentiles[0], '#3 does not lift black').toBe(0);
  });

  /**
   * §12.4 round 2 — thickness stratification.
   *
   * Operator feedback at `FinalFullArcReview`: *"It's hard to tell — there's not a lot of thickness
   * variation."* The diagnosis is measurable: the §5.2 height is
   * `relief × (0.8·(1 − exp(−V/0.25)) + 0.2·|∇V|)`, and that saturating remap maps every
   * moderate-to-deep V into nearly the same height, so a thick core and a thin filament sit at almost
   * the same relief — and the grazing light, which responds to height *gradients*, has nothing to
   * show. This test measures each lever against the stratification proxy (`litStats().spread` =
   * p90/p50 within lit pixels) and the height field's own distribution, and keeps the combination
   * that lifts stratification without breaking a guard.
   */
  test('round 2: thickness stratification sweep on the mature field', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const probe = await openArtwork(page);
    expect(probe.ok, probe.reason).toBe(true);
    if (!probe.ok) return;

    await hook(page, 'setAutoSeed', [false]);
    await hook(page, 'setPaused', [true]);
    await hook(page, 'reset');
    await hook(page, 'setParameters', [PARAMS]);
    await hook(page, 'seed', [{ center: [0.44, 0.53], radiusCells: 6, mode: 'replace' }]);
    await hook(page, 'simulate', [STEPS]);
    await hook(page, 'renderOnce');
    const field = await hook<FieldStatsShape>(page, 'fieldStats', [0.1]);
    console.info(
      `[round2] mature field: occupied=${field.occupiedFraction.toFixed(4)} meanV=${field.meanV.toFixed(4)} maxV=${field.maxV.toFixed(4)}`,
    );

    /** The shipped round-B material, i.e. the operator's "before". Frozen, not read from config. */
    const BASE: RefinementShape = ROUND_B;
    /** The round-2 accepted combination (set to the measured optimum in the config). */
    const FINAL: RefinementShape = { ...REFINEMENT };
    const FINAL_RELIEF = SHIPPED_RELIEF;

    interface Row {
      name: string;
      label: string;
      relief: number;
      refinement: RefinementShape;
      png: string | null;
      image: ImageStatsShape;
      color: ColorStatsShape;
      lit: LitLuminanceStatsShape;
      height: HeightFieldStatsShape;
      bloom: ImageDifferenceShape;
    }
    const rows: Row[] = [];

    const measure = async (
      name: string,
      label: string,
      refinement: RefinementShape,
      relief: number,
      pngName: string | null = null,
    ): Promise<Row> => {
      await hook(page, 'setRefinement', [refinement]);
      await hook(page, 'setMaterial', [{ relief, bloomGain: BLOOM.gain }]);
      await hook(page, 'setBloomParams', [{ threshold: BLOOM.threshold, knee: BLOOM.knee, kneePerTap: true }]);
      await hook(page, 'renderOnce');
      const image = await hook<ImageStatsShape>(page, 'compositeStats');
      const color = await hook<ColorStatsShape>(page, 'colorStats');
      const lit = await hook<LitLuminanceStatsShape>(page, 'litStats');
      const height = await hook<HeightFieldStatsShape>(page, 'heightStats');
      const bloom = await hook<ImageDifferenceShape>(page, 'bloomContribution');
      let png: string | null = null;
      if (pngName) {
        png = `${ROUND2_OUT}/${pngName}`;
        writePng(png, await hook<string>(page, 'capturePngBase64'));
      }
      const row: Row = { name, label, relief, refinement, png, image, color, lit, height, bloom };
      rows.push(row);
      console.info(
        `[round2] ${name.padEnd(26)} lit spread=${lit.spread.toFixed(3)} (p50=${lit.p50} p90=${lit.p90} mean=${lit.mean.toFixed(1)} sd=${lit.stdev.toFixed(1)}) | ` +
          `height min=${height.min.toFixed(5)} p90=${height.p90.toFixed(5)} max=${height.max.toFixed(5)} spread=${height.spread.toFixed(2)} reliefUse=${height.reliefFraction.toFixed(3)} | ` +
          `img p50=${image.percentiles[0]} max=${image.max} clip=${(image.clippedFraction * 100).toFixed(4)}% sat=${color.meanSaturation.toFixed(4)} R-B=${color.warmMinusCool.toFixed(2)}`,
      );
      return row;
    };

    // The operator's "before": the shipped round-B render at its calibrated relief.
    await measure('before', 'shipped round-B render (saturating height remap, relief 0.006)', BASE, BEFORE_RELIEF, 'before-overhead.png');

    console.info('[round2] --- lever #1a: normalized thickness remap alone (round-B material)');
    for (const ref of [0.36, 0.38, 0.42]) {
      for (const power of [1.0, 1.3]) {
        await measure(`remap-r${ref}-p${power}`, `remap ref ${ref} power ${power}`, { ...BASE, heightThicknessRef: ref, heightThicknessPower: power }, BEFORE_RELIEF);
      }
    }
    const REMAP_ONLY: RefinementShape = {
      ...BASE,
      heightThicknessRef: FINAL.heightThicknessRef,
      heightThicknessPower: FINAL.heightThicknessPower,
    };
    await measure('remap-accepted', 'accepted remap alone', REMAP_ONLY, BEFORE_RELIEF, 'after-height-remap.png');

    console.info('[round2] --- lever #1b: relief alone (saturating remap, round-B material)');
    for (const relief of [0.007, 0.008]) {
      await measure(`relief-only-${relief}`, `relief ${relief} alone`, BASE, relief);
    }

    console.info('[round2] --- lever #2: interior darkening alone (round-B material, relief 0.006)');
    for (const interiorDarkening of [0.45, 0.55, 0.65]) {
      await measure(`dark-${interiorDarkening}`, `interior darkening ${interiorDarkening} alone`, { ...BASE, interiorDarkening }, BEFORE_RELIEF);
    }

    console.info('[round2] --- the accepted combination: relief refinement at the accepted remap');
    for (const relief of [0.006, 0.0065, 0.007, 0.0075]) {
      await measure(`final-relief-${relief}`, `accepted combination at relief ${relief}`, FINAL, relief);
    }

    console.info('[round2] --- the accepted combination (remap + darkening + relief)');
    const final = await measure('after', 'round-2 accepted combination', FINAL, FINAL_RELIEF, 'after-all-overhead.png');
    await measure('after-relief-0.008', 'accepted combination at the §5.2 relief ceiling', FINAL, 0.008);

    console.info('[round2] --- lever #3 (REJECTED): frontier band on top of the accepted combination');
    for (const frontBoost of [0.05, 0.12, 0.25]) {
      await measure(`front-${frontBoost}`, `frontier band ${frontBoost} on the accepted combination`, { ...FINAL, frontBoost }, FINAL_RELIEF, frontBoost === 0.25 ? 'after-frontier-band-rejected.png' : null);
    }

    console.info('[round2] --- lever #4 (REJECTED): thin-gloss on top of the accepted combination');
    for (const glossThin of [0.1, 0.25]) {
      await measure(`gloss-${glossThin}`, `thin-gloss ${glossThin} on the accepted combination`, { ...FINAL, glossThin }, FINAL_RELIEF);
    }

    // Grazing view: the operator's actual presentation angle for judging structure.
    await hook(page, 'dispatch', [
      { type: 'camera', value: { mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.5, 0.5], transitionSeconds: 0 } },
    ]);
    await measure('before-grazing', 'shipped round-B render, grazing view', BASE, BEFORE_RELIEF, 'before-grazing.png');
    await measure('after-grazing', 'round-2 accepted combination, grazing view', FINAL, FINAL_RELIEF, 'after-all-grazing.png');

    writeJson(`${ROUND2_OUT}/changes.json`, {
      createdAt: new Date().toISOString(),
      field: { steps: STEPS, parameters: PARAMS, occupiedFraction: field.occupiedFraction, meanV: field.meanV, maxV: field.maxV },
      config: { refinement: REFINEMENT, bloom: BLOOM, beforeRelief: BEFORE_RELIEF, shippedRelief: SHIPPED_RELIEF, reliefRange: SURFACE.reliefAmplitudeRange },
      rows,
    });

    // --- guards ---------------------------------------------------------------------------------
    const before = rows.find((r) => r.name === 'before')!;
    for (const r of rows) {
      const grazing = r.name.includes('grazing');
      // The grazing close view legitimately has a small nonzero p50 (gate README: p50 = 2 at the
      // 12° / 1.75-unit override); the overhead presentation view must stay exactly black.
      if (grazing) expect(r.image.percentiles[0], `${r.name}: grazing p50 stays at the black floor`).toBeLessThanOrEqual(2);
      else expect(r.image.percentiles[0], `${r.name}: p50 exactly black`).toBe(0);
      expect(r.image.clippedFraction, `${r.name}: no highlight clipping`).toBeLessThanOrEqual(0.001);
      expect(r.color.meanSaturation, `${r.name}: palette near-neutral`).toBeLessThanOrEqual(0.08);
      expect(Math.abs(r.color.warmMinusCool), `${r.name}: warmth subtle`).toBeLessThanOrEqual(8);
      expect(r.relief, `${r.name}: relief inside the §5.2 bound`).toBeLessThanOrEqual(SURFACE.reliefAmplitudeRange[1]);
      expect(r.relief, `${r.name}: relief inside the §5.2 bound`).toBeGreaterThanOrEqual(SURFACE.reliefAmplitudeRange[0]);
      expect(r.height.reliefFraction, `${r.name}: height never exceeds the relief budget`).toBeLessThanOrEqual(1.0001);
    }
    // The point of round 2: the accepted render is measurably more stratified than the shipped one.
    expect(final.lit.spread, 'round 2 raises lit-pixel stratification (p90/p50)').toBeGreaterThan(before.lit.spread);
    expect(final.height.spread, 'round 2 raises the height field spread').toBeGreaterThan(before.height.spread);

    // #3 and #4 are rejected on evidence, not taste: neither beats the accepted combination, and the
    // frontier band only "wins" the metric by flooding the whole frame with added light.
    const front025 = rows.find((r) => r.name === 'front-0.25')!;
    const gloss025 = rows.find((r) => r.name === 'gloss-0.25')!;
    const reliefCeiling = rows.find((r) => r.name === 'after-relief-0.008')!;
    expect(front025.lit.spread, '#3 rejected: the frontier band does not beat the accepted combination').toBeLessThan(final.lit.spread);
    expect(front025.image.mean / final.image.mean, '#3 rejected: it floods the frame with light').toBeGreaterThan(1.3);
    expect(Math.abs(front025.color.warmMinusCool), '#3 rejected: and it shifts the palette').toBeLessThan(Math.abs(final.color.warmMinusCool) + 1);
    expect(gloss025.lit.spread, '#4 rejected: thin-gloss does not beat the accepted combination').toBeLessThan(final.lit.spread);
    expect(reliefCeiling.image.max, '#1 rejected at 0.008: the relief ceiling clips').toBe(255);
    expect(final.image.max, 'the shipped relief keeps every pixel off the hard ceiling').toBeLessThan(255);
  });
});
