/**
 * §4.1 composition batch stepping, kept free of any WebGL/GL dependency so the mid-batch view
 * refresh is unit-testable.
 *
 * MINOR 3: the analysis view handed to the curator must be rebuilt whenever the field's epoch
 * changes mid-batch. A `replace` genesis (a curator hard clear/rebirth, or a laboratory reseed) bumps
 * the epoch and the caller's `resetAnalysis` clears the live health/coarse state, so the
 * *pre-replacement* sample the view was built from is stale. Building the view once and reusing it
 * let the remaining steps of the batch keep consuming that sample — bounded by the frame's step cap
 * in `frame`, but unbounded through the `advanceComposition` hook. Rebuilding on the epoch change
 * makes every subsequent step observe invalid health until a fresh-epoch sample arrives.
 */
import type { WorldState } from './types.ts';

/**
 * Advance one composition batch: `steps` delivered steps, each handed a `WorldState`.
 *
 * `epoch` reads the field epoch the current view was built against; a change between steps forces
 * `refreshView`. `interject`/`onView` exist only for the MINOR-3 verification hook (inject a
 * replacement before a chosen step; record the view each step consumed).
 */
export function advanceCompositionBatch(
  steps: number,
  epoch: () => number,
  refreshView: () => WorldState,
  step: (view: WorldState) => void,
  onView?: (view: WorldState, index: number) => void,
  interject?: (index: number) => void,
): void {
  let viewEpoch = epoch();
  let view = refreshView();
  for (let index = 0; index < steps; index += 1) {
    interject?.(index);
    const current = epoch();
    if (current !== viewEpoch) {
      viewEpoch = current;
      view = refreshView();
    }
    step(view);
    onView?.(view, index);
  }
}
