/**
 * MINOR 3: a `replace` genesis inside a multi-step composition batch must invalidate the analysis
 * view for the remaining steps. The batch stepper is GL-free precisely so this is a unit test:
 * `advanceCompositionBatch` is the same helper the frame loop and the `advanceComposition` hook use.
 */
import { describe, expect, it } from 'vitest';
import { advanceCompositionBatch } from '../src/core/composition-batch.ts';
import type { WorldState } from '../src/core/types.ts';

/** The only part of the view the curator's negligible/extinction checks read. */
function view(valid: boolean, occupied: number, activity: number): WorldState {
  return {
    analysis: {
      chemistryHealth: { valid, ageSeconds: 0, fullOccupiedFraction: occupied, fullReactionActivity: activity, fullChangeRate: 0 },
    },
  } as unknown as WorldState;
}

const DEAD_OCCUPANCY = 0.05;
const DEAD_ACTIVITY = 0.02;
const DT = 1 / 120;

function isNegligible(v: WorldState): boolean {
  const health = v.analysis.chemistryHealth;
  return health.valid && health.fullOccupiedFraction < DEAD_OCCUPANCY && health.fullReactionActivity < DEAD_ACTIVITY;
}

describe('MINOR 3 mid-batch analysis-view refresh', () => {
  it('rebuilds the view after a mid-batch replacement, so later steps see invalid health', () => {
    const steps = 40;
    const replaceAfterStep = 1; // "replace on the first step of a multi-step batch"
    let epoch = 1;
    let valid = true; // a valid, negligible (inert) old-epoch sample

    const trace: boolean[] = [];
    let negligibleSeconds = 0;
    advanceCompositionBatch(
      steps,
      () => epoch,
      () => view(valid, 0, 0),
      (v) => {
        if (isNegligible(v)) negligibleSeconds += DT;
      },
      (v) => trace.push(v.analysis.chemistryHealth.valid),
      (index) => {
        if (index === replaceAfterStep) {
          epoch = 2; // the replace bumps the field epoch ...
          valid = false; // ... and the app clears the live health state
        }
      },
    );

    expect(trace[0], 'step 0 consumed the valid old-epoch sample').toBe(true);
    for (let i = 1; i < steps; i += 1) {
      expect(trace[i], `step ${i} must see invalid health after the replacement`).toBe(false);
    }
    expect(negligibleSeconds, 'only the pre-replacement step accumulated negligible time').toBeCloseTo(DT, 12);

    // The pre-fix behaviour, for contrast: a single view reused across the batch kept the valid
    // sample for every step, accumulating negligible time for all of them.
    let staleSeconds = 0;
    const staleView = view(true, 0, 0);
    for (let i = 0; i < steps; i += 1) if (isNegligible(staleView)) staleSeconds += DT;
    expect(staleSeconds).toBeCloseTo(steps * DT, 12);
    expect(staleSeconds).toBeGreaterThan(negligibleSeconds);
  });

  it('leaves a batch with no replacement untouched (one view, valid throughout)', () => {
    const trace: boolean[] = [];
    let epoch = 7;
    advanceCompositionBatch(
      5,
      () => epoch,
      () => view(true, 0, 0),
      () => {},
      (v) => trace.push(v.analysis.chemistryHealth.valid),
      () => {
        epoch = 7; // no change
      },
    );
    expect(trace).toEqual([true, true, true, true, true]);
  });
});
