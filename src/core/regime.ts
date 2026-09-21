/**
 * §10 laboratory regime readout: a coarse, **approximate** qualitative descriptor of the morphology a
 * `(F, k)` pair is expected to produce.
 *
 * This is a presentation aid for the hidden laboratory only. It never influences the simulation, and
 * it is deliberately coarse: the labels name broad regions of the Gray–Scott parameter plane, not
 * proven outcomes on this particular solver. `architecture-plan.md` §6.3 makes the same point about
 * the candidate trajectory's movement names — "the numerical paths **must not be represented as
 * proven cells/worms/labyrinth transitions** until explored on this solver".
 *
 * **Method: 2-D nearest reference, not a 1-D ladder.** The `(F, k)` plane is crescent-shaped and
 * genuinely two-dimensional. The same `k − F` gap lands in different regimes at different feed levels
 * (`(.029,.057)` is a classic maze, while a same-gap `(.050,.078)` is dead), and a blanket
 * "high F ⇒ overgrowth" cutoff mislabels the coral/flower region at `(.0545,.062)` — which our own
 * candidate sheet also calls coral. `describeRegime` therefore finds the nearest point in a
 * documented table of anchor points by **plain Euclidean distance in `(F, k)`** and reports that
 * anchor's label plus the distance. When the nearest anchor is farther than `MAX_ANCHOR_DISTANCE` it
 * reports an explicit `unmapped` result that still names the nearest anchor.
 *
 * **Anchors must be points that survived.** Every anchor binds to a provenance class
 * (`literature` | `candidate` | `tune`), and every `candidate` anchor is cross-checked by
 * `tests/regime.test.ts` against the frozen gate evidence
 * (`artifacts/phase1-gate/captures.json`): it must have a recorded capture with **nonzero**
 * occupancy. The textbook mitosis point `(.0367,.0649)` is deliberately **not** an anchor — our own
 * production capture of it is black (image max/mean 0, occupancy 0) and `README-gate.md` records that
 * it "did **not** survive on this solver". It lives in `KNOWN_DEAD` instead, so it can never label a
 * living region.
 */
import type { Params } from './types.ts';

/** Approximate morphology labels. Anchor labels plus the nonviable outcome. */
export type Regime =
  | 'labyrinth'
  | 'solitons'
  | 'mitosis'
  | 'worms'
  | 'dense'
  | 'coral'
  | 'overgrowth'
  | 'dying';

/** Where an anchor comes from — and therefore how it is allowed to be trusted. */
export type RegimeProvenance = 'literature' | 'candidate' | 'tune';

export interface RegimeAnchor {
  readonly F: number;
  readonly k: number;
  readonly label: Regime;
  readonly provenance: RegimeProvenance;
  /** Human-readable evidence for this anchor. */
  readonly source: string;
}

/**
 * Documented anchor table. Sources, by provenance class:
 *
 *  - `literature` — the established 2-D Gray–Scott maps (MROB xmorphia; the Frankfurt project's
 *    parameter maps), as supplied by the review: classic maze ≈ (.029,.057), solitons ≈ (.030,.060),
 *    mitosis ≈ (.028,.062). These are *literature* labels; they are kept because our own k = .062 tune
 *    row is alive (occupancy 0.3612 at F = .029), but they are not production observations.
 *  - `candidate` — our own `artifacts/phase1-gate/candidates/*.png` contact sheet. Every one of these
 *    has a recorded capture in `artifacts/phase1-gate/captures.json` with **nonzero** occupancy
 *    (coral 0.029, worms 0.009, dense 0.229), and the unit tests assert exactly that.
 *  - `tune` — our own offline `(F,k)` sweep on the CPU reference solver (`artifacts/phase1-tune.txt`:
 *    99 candidates, 160×160, 12 000 steps, one 6-cell replace seed). Saturation is `occupied ≈ 1.000`
 *    with `edgeDensity ≈ 0.000`; death is `occupied = 0.000`.
 *
 * The neighbourhood around `(.028–.030, .060–.062)` is crowded — mitosis, solitons and worms anchors
 * sit within 0.003 of each other — which is exactly why the result is labelled *approximate*; ties are
 * broken deterministically by table order (first match wins).
 */
export const REGIME_ANCHORS: readonly RegimeAnchor[] = [
  // Literature anchors.
  {
    F: 0.029,
    k: 0.057,
    label: 'labyrinth',
    provenance: 'literature',
    source: 'literature (classic maze ~.029/.057); our mature gate captures at (.029,.057) are alive (occupancy 0.632)',
  },
  { F: 0.03, k: 0.06, label: 'solitons', provenance: 'literature', source: 'literature (solitons ~.030/.060)' },
  {
    F: 0.028,
    k: 0.062,
    label: 'mitosis',
    provenance: 'literature',
    source: 'literature (mitosis ~.028/.062); our tune row (.029,.062) is alive (occupancy 0.3612)',
  },
  // Our own candidate contact sheet (each cross-checked for nonzero recorded occupancy).
  {
    F: 0.0545,
    k: 0.062,
    label: 'coral',
    provenance: 'candidate',
    source:
      'candidate sheet coral-0.0545-0.062.png (captures.json occupancy 0.029, alive); corroborates literature flower/coral ~.055/.062',
  },
  {
    F: 0.03,
    k: 0.062,
    label: 'worms',
    provenance: 'candidate',
    source: 'candidate sheet worms-0.030-0.062.png (captures.json occupancy 0.009, alive but sparse)',
  },
  {
    F: 0.022,
    k: 0.054,
    label: 'dense',
    provenance: 'candidate',
    source: 'candidate sheet dense-0.022-0.054.png (captures.json occupancy 0.229, alive)',
  },
  // artifacts/phase1-tune.txt observations on our own solver.
  {
    F: 0.026,
    k: 0.045,
    label: 'overgrowth',
    provenance: 'tune',
    source: 'tune.txt (0.026,0.045): occupied 1.000, edge 0.000 — saturated field',
  },
  {
    F: 0.018,
    k: 0.062,
    label: 'dying',
    provenance: 'tune',
    source: 'tune.txt (0.018,0.062): occupied 0.000 — dead at low feed',
  },
  {
    F: 0.014,
    k: 0.045,
    label: 'dying',
    provenance: 'tune',
    source: 'tune.txt (0.014,0.045): occupied 0.000 — dead at low feed',
  },
];

/**
 * Measured points that are **dead on this solver** and are therefore excluded from the anchor table,
 * so they can never label a living region.
 */
export interface KnownDeadPoint {
  readonly F: number;
  readonly k: number;
  /** The label the literature gives this point. */
  readonly literatureLabel: string;
  readonly note: string;
}

export const KNOWN_DEAD: readonly KnownDeadPoint[] = [
  {
    F: 0.0367,
    k: 0.0649,
    literatureLabel: 'mitosis',
    note:
      'Reported as mitosis in the literature, but it DIED on this solver. `artifacts/phase1-gate/' +
      'captures.json` records the mitosis-0.0367-0.0649 candidate with image max 0, mean 0 and ' +
      'occupiedFraction 0, and `README-gate.md` states: "Above k ~ 0.0649 everything dies — including ' +
      'the textbook mitosis point (F = 0.0367, k = 0.0649), which is in the candidate sheet precisely ' +
      'because it did **not** survive on this solver." The filename describes intent, not outcome. It ' +
      'is excluded from REGIME_ANCHORS and classified nonviable by the death rule below.',
  },
];

/**
 * Nearest-anchor distance beyond which the point is reported `unmapped` rather than assigned a
 * label. In `(F, k)` Euclidean units: the anchors span F 0.014–0.0545 and k 0.045–0.062, and 0.02
 * covers their immediate neighbourhoods (and every shipped candidate point) without stretching a
 * single anchor across the whole plane.
 */
export const MAX_ANCHOR_DISTANCE = 0.02;

/**
 * Death boundary, derived from measurements rather than guessed. The bracket of *measured* points is
 * `k = 0.062` **alive** (our tune run's (.029, .062) row: occupancy 0.3612; `README-gate.md`'s
 * F = .029 table lists 0.361 / 0.106 / 0.0482 / 0.0097 for k = .062) against `k = 0.0649` **dead** (every
 * tabulated tune point at that k is occupancy 0, and our production capture at F = .0367 is black).
 * `DEATH_K` is the midpoint of that bracket, rounded to four decimals: `(0.062 + 0.0649) / 2 =
 * 0.06345 -> 0.0635`. At or above it, `describeRegime` reports `dying` / nonviable without consulting
 * the anchor table — this is the only non-anchor rule, because it is a measured nonviability boundary
 * rather than a morphology guess.
 */
export const DEATH_K = 0.0635;

export interface RegimeDescription {
  regime: Regime;
  /** `k - F`, the gap conventionally used to read the pattern scale. */
  gap: number;
  /** True when the death rule fired (k at or above the measured boundary). */
  nonviable: boolean;
  /** True when no anchor was within `MAX_ANCHOR_DISTANCE` and the rule did not fire. */
  unmapped: boolean;
  /** Euclidean distance to the nearest anchor in `(F, k)`, or null when the death rule fired. */
  distance: number | null;
  /** The nearest anchor, even when the result is `unmapped`; null only for the death rule. */
  nearest: RegimeAnchor | null;
}

/** Plain Euclidean distance in the `(F, k)` plane (deliberately not toroidal). */
export function anchorDistance(F: number, k: number, anchor: RegimeAnchor): number {
  return Math.hypot(F - anchor.F, k - anchor.k);
}

/** The anchor with the smallest `(F, k)` distance; ties resolve to the first in table order. */
export function nearestAnchor(F: number, k: number): { anchor: RegimeAnchor; distance: number } {
  let best = REGIME_ANCHORS[0]!;
  let bestDistance = anchorDistance(F, k, best);
  for (let i = 1; i < REGIME_ANCHORS.length; i += 1) {
    const candidate = REGIME_ANCHORS[i]!;
    const distance = anchorDistance(F, k, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return { anchor: best, distance: bestDistance };
}

/** Coarse qualitative descriptor of the morphology expected at these parameters (approximate). */
export function describeRegime(params: Params): RegimeDescription {
  const gap = params.k - params.F;
  if (params.k >= DEATH_K) {
    return { regime: 'dying', gap, nonviable: true, unmapped: false, distance: null, nearest: null };
  }
  const { anchor, distance } = nearestAnchor(params.F, params.k);
  const unmapped = distance > MAX_ANCHOR_DISTANCE;
  return { regime: anchor.label, gap, nonviable: false, unmapped, distance, nearest: anchor };
}

/** `.029/.057`-style anchor coordinates for the readout. */
function formatAnchorPoint(anchor: RegimeAnchor): string {
  const trim = (value: number): string => value.toFixed(3).slice(1);
  return `${trim(anchor.F)}/${trim(anchor.k)}`;
}

/** One-line laboratory readout, e.g. `labyrinth (nearest @ .029/.057, d=0.000)`. */
export function formatRegime(description: RegimeDescription): string {
  if (description.nonviable) {
    return `dying (nonviable: k above the measured death boundary ${DEATH_K})`;
  }
  if (description.nearest === null) {
    return `${description.regime} (approximate)`;
  }
  const point = formatAnchorPoint(description.nearest);
  const distance = (description.distance ?? 0).toFixed(3);
  if (description.unmapped) {
    return `unmapped (nearest: ${description.nearest.label} @ ${point}, d=${distance})`;
  }
  return `${description.regime} (nearest @ ${point}, d=${distance})`;
}
