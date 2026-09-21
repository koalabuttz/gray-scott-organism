/**
 * Shared narrative for `artifacts/arcs/summary.json`.
 *
 * The ARCS spec and the focused nucleation-rescue diagnostic both write this text, so the corrected
 * §6.4 diagnosis cannot drift between them.
 */

/** What the summary's per-arc fields are. */
export const ARCS_SUMMARY_NOTE =
  'Three complete arcs at 1× real time in parallel browser contexts. `descriptors` is a ≈2 Hz log of '
  + 'tier-1 chemistry health + coarse occupancy; `captures` is the 30 s capture strip; `holdSamples` '
  + 'are luminance/light samples taken during the concealed black-hold; `extinctionDecisions` records '
  + 'why each premature-extinction rescue or early recovery fired.';

/**
 * The §6.4 rescue/endpoint diagnosis (MAJOR 3; endpoint retune added by deviation 45; trend refinement
 * added by deviation 48).
 *
 * The three 1× rows in `arcs/summary.json` are the legacy pre-refinement arcs: each fired exactly one
 * injection rescue during NUCLEATION because the initial nucleation field sat below the living
 * occupancy/activity thresholds for the 20 s extinction window. Those rows predate the deviation-48
 * trend refinement, which now treats a field as dead only when it is **both** below the thresholds
 * **and** not rising; under that rule the retuned presentation arc (`arcs/arc-tuned/`) is rescue-free.
 * `npm run test:rescue` (RESCUE=1) no longer reproduces the legacy rescue; it records the
 * post-refinement evidence instead (no spurious rescue while rising, plus a deliberate dead fixture).
 * The DEATH_K = .0635 figure is an approximate bracket midpoint, not a direct measurement of .064 and
 * not an F-independent exact boundary.
 */
export const ARCS_SUMMARY_NARRATIVE =
  'The three 1× rows above are the legacy pre-refinement arcs (deviation-45 era): each completes with '
  + 'exactly one bounded injection rescue, and that rescue fires during NUCLEATION — the arc re-seeds on '
  + 'entering nucleation and the initial nucleation field sits below the living occupancy/activity '
  + 'thresholds for the plan\'s §6.4 20 s extinction window, so the one-per-arc safety injects a second '
  + 'seed while the curator is still in nucleation (cellular growth begins only after ≈76 performance '
  + 'seconds, so the injection is NOT caused by the later cellular-growth/replication/connection '
  + 'endpoints). Those rows were recorded before deviation 48\'s trend refinement; that refinement treats '
  + 'a field as dead only when it is both below the thresholds AND not rising, and under it the retuned '
  + 'presentation arc is rescue-free (`arcs/arc-tuned/summary.json` records `rescueCount: 0`). '
  + '`npm run test:rescue` (RESCUE=1) therefore no longer reproduces the legacy rescue: it records the '
  + 'post-refinement evidence — no spurious rescue while the tuned field rises through nucleation, and a '
  + 'deliberate dead fixture (k = 0.07, above the measured ≈.0649 death boundary) that still fires its one '
  + 'bounded rescue at the 20 s window with `occupancyGrowing: false`. The DEATH_K = .0635 figure remains '
  + 'an approximate bracket midpoint of the measured .062-alive / .0649-dead tune bracket, not a direct '
  + 'measurement of .064 and not an F-independent exact boundary.';
