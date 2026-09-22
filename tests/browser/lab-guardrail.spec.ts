/**
 * §10 Phase-4 laboratory guardrail (the operator's standing Phase-1 caveat: "quite easy to end up
 * with a blank screen because of misconfiguring the lab").
 *
 * Two behaviours, both driven through the real lab controls:
 *
 *  1. **Coupled viability (review fix MAJOR).** Danger off is a coupled `(F, k)` rule, not two
 *     independent clamps: every proposed pair is projected onto the evidence-backed viable set, so the
 *     measured-dead corner `(.014, .045)` can no longer be dialled, and a dangerous override
 *     (`k = .075`) is sanitized the instant danger is switched off — with the slider DOM value, the
 *     readout label and the effective (model) value in agreement.
 *  2. **Sparse-field collapse warning (review fix MINOR 2).** The collapse arming threshold sits below
 *     the sparsest documented living occupancy (worms `.030/.062` ≈ 0.009), so a legitimate sparse
 *     field that dies is warned; and the warning appears only after 6 delivered performance seconds,
 *     never during the exempt `dormancy`/`nucleation` movements.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { DEATH_K } from '../../src/core/regime.ts';
import { VIABLE_ENVELOPE } from '../../src/lab/viability.ts';
import { hook, openArtwork } from '../support/browser.ts';
import type { LabSnapshotShape } from '../support/types.ts';

/** §4.4 worms parameters: the project's sparsest documented living anchor (`.030, .062`, occ 0.009). */
const WORMS = { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 } as const;
/** A `k` above the measured death boundary (only reachable with dangerous values allowed). */
const NON_VIABLE_K = 0.075;

/** Drive a range input the way a drag does: set the value and dispatch `input`. */
async function setSlider(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function readSlider(page: Page, testId: string): Promise<number> {
  return Number(await page.getByTestId(testId).inputValue());
}

async function sliderBounds(page: Page, testId: string): Promise<{ min: number; max: number }> {
  return page.getByTestId(testId).evaluate((element) => {
    const input = element as HTMLInputElement;
    return { min: Number(input.min), max: Number(input.max) };
  });
}

async function valueLabel(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(`${testId}-value`).textContent()) ?? '').trim();
}

/** The live full-domain occupied fraction, read straight from the field (independent of the tier-1 tier). */
function fieldOccupancy(page: Page): Promise<number> {
  return hook<{ occupiedFraction: number }>(page, 'fieldStats', [0.1]).then((stats) => stats.occupiedFraction);
}

function snapshot(page: Page): Promise<LabSnapshotShape> {
  return hook<LabSnapshotShape>(page, 'labSnapshot');
}

async function pollSnapshot(
  page: Page,
  predicate: (state: LabSnapshotShape) => boolean,
  timeoutMs = 30_000,
): Promise<LabSnapshotShape> {
  const deadline = Date.now() + timeoutMs;
  let last = await snapshot(page);
  while (Date.now() < deadline) {
    last = await snapshot(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(50);
  }
  throw new Error('pollSnapshot timed out');
}

test.describe('§10 laboratory viability guardrail', () => {
  test('danger-off is a coupled (F,k) rule: dead corners are projected and a dangerous override is sanitized', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);

    const warning = page.locator('.lab-warning');
    const regime = page.locator('.lab-regime');

    // Calibrated defaults are viable: no warning, and the danger-off k ceiling is the highest
    // measured-alive anchor (below the death boundary), not the death-boundary midpoint.
    await expect(warning).toBeHidden();
    await expect(regime).not.toContainText('nonviable');
    const kBounds = await sliderBounds(page, 'lab-param-k');
    console.info(`[guardrail] danger-off k slider range: ${kBounds.min}–${kBounds.max}`);
    expect(kBounds.max, 'the k slider ceiling is the evidence-backed living anchor').toBeCloseTo(
      VIABLE_ENVELOPE.k[1],
      6,
    );
    expect(kBounds.max, 'and it is below the measured death boundary').toBeLessThan(DEATH_K);

    // Every corner of the danger-off envelope lands on a viable pair, and the slider DOM value, the
    // readout label and the effective (model) value all agree — including the measured-dead corner
    // (.014, .045), which the old independent rectangle admitted.
    const corners: Array<[number, number]> = [
      [VIABLE_ENVELOPE.F[0], VIABLE_ENVELOPE.k[0]],
      [VIABLE_ENVELOPE.F[0], VIABLE_ENVELOPE.k[1]],
      [VIABLE_ENVELOPE.F[1], VIABLE_ENVELOPE.k[0]],
      [VIABLE_ENVELOPE.F[1], VIABLE_ENVELOPE.k[1]],
    ];
    for (const [F, k] of corners) {
      await setSlider(page, 'lab-param-F', F);
      await setSlider(page, 'lab-param-k', k);
      await expect(warning, `corner (${F}, ${k}) must not warn`).toBeHidden();
      const text = (await regime.textContent()) ?? '';
      expect(text, `corner (${F}, ${k}) regime readout`).not.toContain('nonviable');
      expect(text, `corner (${F}, ${k}) regime readout`).not.toContain('dying');
      expect(text, `corner (${F}, ${k}) regime readout`).not.toContain('unmapped');
      const snap = await snapshot(page);
      const fInput = await readSlider(page, 'lab-param-F');
      const kInput = await readSlider(page, 'lab-param-k');
      expect(fInput, `corner (${F}, ${k}) F slider agrees with the model`).toBeCloseTo(
        Number(snap.effectiveParameters.F.toFixed(4)),
        9,
      );
      expect(kInput, `corner (${F}, ${k}) k slider agrees with the model`).toBeCloseTo(
        Number(snap.effectiveParameters.k.toFixed(4)),
        9,
      );
      expect((await valueLabel(page, 'lab-param-F')), `corner (${F}, ${k}) F readout`).toBe(
        snap.effectiveParameters.F.toFixed(4),
      );
      expect((await valueLabel(page, 'lab-param-k')), `corner (${F}, ${k}) k readout`).toBe(
        snap.effectiveParameters.k.toFixed(4),
      );
      console.info(
        `[guardrail] corner (${F}, ${k}) -> effective (${snap.effectiveParameters.F}, ${snap.effectiveParameters.k})`,
      );
    }
    // The dead corner really was projected, not silently accepted.
    expect(await readSlider(page, 'lab-param-k'), 'the dead corner (F .014) was projected off k = .045').not.toBeCloseTo(
      0.045,
      4,
    );

    // Danger on -> k = .075 (above the death boundary) -> warning.
    await page.getByRole('button', { name: /allow dangerous values/ }).click();
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);
    expect(
      (await sliderBounds(page, 'lab-param-k')).max,
      'danger on widens the k slider past the death boundary',
    ).toBeGreaterThan(DEATH_K);
    await setSlider(page, 'lab-param-k', NON_VIABLE_K);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('non-viable');
    await expect(regime).toContainText('nonviable');
    expect((await snapshot(page)).effectiveParameters.k).toBeCloseTo(NON_VIABLE_K, 4);

    // Danger off sanitizes the live override **immediately**, and snaps the sliders to the projected
    // viable pair so the DOM, the readout and the model agree.
    await page.getByRole('button', { name: /allow dangerous values/ }).click();
    await expect(warning).toBeHidden();
    await expect(regime).not.toContainText('nonviable');
    const safe = await snapshot(page);
    console.info(`[guardrail] sanitized to (${safe.effectiveParameters.F}, ${safe.effectiveParameters.k})`);
    expect(safe.effectiveParameters.k, 'the dangerous k is projected to the nearest living anchor').toBeCloseTo(
      0.062,
      4,
    );
    expect(await readSlider(page, 'lab-param-k')).toBeCloseTo(0.062, 9);
    expect(await valueLabel(page, 'lab-param-k')).toBe('0.0620');

    // Re-enabling danger makes the full range (and k = .075) reachable again.
    await page.getByRole('button', { name: /allow dangerous values/ }).click();
    await setSlider(page, 'lab-param-k', NON_VIABLE_K);
    expect(await readSlider(page, 'lab-param-k')).toBeCloseTo(NON_VIABLE_K, 9);
    await expect(warning).toBeVisible();

    // One-click restore clears everything, snaps the sliders to the defaults, and recovers the field.
    await page.getByRole('button', { name: 'restore viable defaults' }).click();
    await expect(warning).toBeHidden();
    const restored = await snapshot(page);
    expect(restored.effectiveParameters.F).toBeCloseTo(0.03, 4);
    expect(restored.effectiveParameters.k).toBeCloseTo(0.062, 4);
    expect(await readSlider(page, 'lab-param-k')).toBeCloseTo(0.062, 9);
    await expect
      .poll(async () => fieldOccupancy(page), { timeout: 60_000, intervals: [500] })
      .toBeGreaterThan(0.002);
  });

  test('a sparse living field that collapses warns after 6 delivered performance seconds (dormancy does not)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    await page.keyboard.press('Backquote');
    await expect(page.locator('[data-role="laboratory"]')).toHaveCount(1);
    const warning = page.locator('.lab-warning');

    // Reach a non-exempt living movement (cellular-growth/expand, stillness none) deterministically,
    // then let the transport run so the tier-1 cadence delivers health samples.
    await hook(page, 'setPaused', [true]);
    const advanced = await hook<LabSnapshotShape>(page, 'advanceComposition', [10000]);
    expect(advanced.phase.movement, 'a non-exempt movement is active').not.toBe('dormancy');
    expect(['quiet', 'release']).not.toContain(advanced.phase.intention);
    expect(advanced.phase.stillnessState).toBe('none');

    // Grow the project's sparsest documented living regime: worms at radius 6 / 8000 steps measures
    // occupied ≈ 0.009 — below the old 0.02 arming threshold and above the 0.002 collapse floor.
    await hook(page, 'setParameters', [WORMS]);
    await hook(page, 'reset');
    await hook(page, 'seed', [{ center: [0.5, 0.5], radiusCells: 6 }]);
    await hook(page, 'simulate', [8000]);
    await hook(page, 'setSpeed', [6]);
    await hook(page, 'setPaused', [false]);

    const sparse = await pollSnapshot(
      page,
      (state) =>
        state.chemistryHealth.valid &&
        state.chemistryHealth.fullOccupiedFraction >= 0.006 &&
        state.chemistryHealth.fullOccupiedFraction < 0.02,
    );
    console.info(
      `[guardrail] sparse living field occupancy ${sparse.chemistryHealth.fullOccupiedFraction.toFixed(5)} ` +
        `(movement ${sparse.phase.movement}/${sparse.phase.intention})`,
    );
    expect(
      sparse.chemistryHealth.fullOccupiedFraction,
      'a legitimate sparse living field, below the old arming threshold',
    ).toBeLessThan(0.02);
    await expect(warning, 'a living sparse field does not warn').toBeHidden();
    await page.waitForTimeout(600);
    await expect(warning, 'still alive, still no warning').toBeHidden();

    // Kill the field. The sparse sample armed `seenAlive`, so the collapse must warn — but only after
    // six delivered performance seconds, and only because the movement is a non-exempt one.
    await hook(page, 'reset');
    const perfAtReset = (await snapshot(page)).performanceSeconds;
    await expect(warning, 'the dwell has not elapsed yet').toBeHidden();
    await expect(warning).toBeVisible({ timeout: 30_000 });
    const perfAtWarning = (await snapshot(page)).performanceSeconds;
    const dwell = perfAtWarning - perfAtReset;
    console.info(`[guardrail] collapse warning after ${dwell.toFixed(1)} delivered performance seconds`);
    await expect(warning).toContainText('collapsed');
    expect(dwell, 'warned only after the 6 s collapse dwell').toBeGreaterThanOrEqual(6);

    // No warning during the exempt movements: a restart enters `dormancy` with a uniform field and the
    // same living parameters, so the collapse path is the only one that could warn — and it must not.
    await hook(page, 'dispatch', [{ type: 'restart', seed: 4242 }]);
    await hook(page, 'setParameters', [WORMS]);
    const dormant = await pollSnapshot(page, (state) => state.performanceSeconds > dwell + 1);
    expect(
      ['dormancy', 'nucleation'],
      `an exempt movement is active (got ${dormant.phase.movement})`,
    ).toContain(dormant.phase.movement);
    await expect(warning, 'dormancy/nucleation is exempt from the collapse warning').toBeHidden();
  });
});
