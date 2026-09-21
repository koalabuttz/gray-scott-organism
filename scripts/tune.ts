/**
 * Offline parameter exploration (§6.5 tooling, Phase 1 scope).
 *
 * Runs the CPU reference solver — the same maths as `shaders/step.frag` — over a grid of (F,k)
 * candidates from a single seed and reports morphology statistics, so the mature gate capture
 * uses parameters that actually produce structure on this solver rather than hand-picked
 * folklore. This is discovery tooling, not a second solver: the renderer always uses the GPU
 * simulation.
 *
 * Usage: npm run tune -- [grid] [steps]
 */
import { ReferenceSolver, fieldStats } from '../src/simulation/reference.ts';
import { createSingleSeedCommand } from '../src/simulation/genesis.ts';
import { applyGenesisCPU } from '../src/simulation/genesis.ts';

const args = process.argv.slice(2);
const grid = Number(args[0] ?? 160);
const steps = Number(args[1] ?? 12000);
const gridH = grid;

const F_VALUES = [0.014, 0.018, 0.022, 0.026, 0.029, 0.03, 0.033, 0.0367, 0.04, 0.045, 0.0545];
const K_VALUES = [0.045, 0.051, 0.054, 0.057, 0.059, 0.06, 0.062, 0.0649, 0.066];

interface Row {
  F: number;
  k: number;
  occupied: number;
  meanV: number;
  edge: number;
  activity: number;
  saturated: number;
  clipped: number;
  score: number;
}

function runOne(F: number, k: number): Row {
  const solver = new ReferenceSolver(grid, gridH);
  solver.setUniform(1, 0);
  const command = createSingleSeedCommand({
    center: [0.5, 0.5],
    seed: 12345,
    perturb: false,
    radiusCells: 6,
    strength: 1,
    mode: 'replace',
  });
  applyGenesisCPU(solver, command);
  let clipped = 0;
  const params = { F, k, Du: 0.16, Dv: 0.08 };
  for (let i = 0; i < steps; i += 1) {
    const outcome = solver.step(params, 1);
    clipped += outcome.clippedU + outcome.clippedV;
  }
  const stats = fieldStats(solver.u, solver.v, grid, gridH, 0.1);
  const occupied = stats.occupiedFraction;
  // A rough "structural richness" proxy: dense edges at a moderate occupancy. Deliberately not
  // a universal beauty score (§6.5).
  const occupancyWindow = occupied > 0.05 && occupied < 0.75 ? 1 : 0.25;
  const score = occupancyWindow * (stats.edgeDensity * 1000 + occupied * 4) * (stats.nonFinite > 0 ? 0 : 1);
  return {
    F,
    k,
    occupied,
    meanV: stats.meanV,
    edge: stats.edgeDensity,
    activity: stats.reactionActivity,
    saturated: stats.saturatedCells,
    clipped,
    score,
  };
}

const rows: Row[] = [];
const started = Date.now();
console.log(`# tune: grid=${grid}x${gridH} steps=${steps} candidates=${F_VALUES.length * K_VALUES.length}`);
console.log('F\tk\toccupied\tmeanV\tedgeDensity\tactivity\tsaturated\tclipped\tclippedPerStep');
for (const F of F_VALUES) {
  for (const k of K_VALUES) {
    const row = runOne(F, k);
    rows.push(row);
    console.log(
      [
        row.F.toFixed(4),
        row.k.toFixed(4),
        row.occupied.toFixed(4),
        row.meanV.toFixed(4),
        row.edge.toFixed(5),
        row.activity.toFixed(6),
        row.saturated,
        row.clipped,
        (row.clipped / (steps * grid * gridH * 2)).toExponential(3),
      ].join('\t'),
    );
  }
}

rows.sort((a, b) => b.score - a.score);
console.log(`\n# elapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n# top 12 by richness proxy:`);
console.log('F\tk\toccupied\tmeanV\tedgeDensity\tactivity');
for (const row of rows.slice(0, 12)) {
  console.log(
    [
      row.F.toFixed(4),
      row.k.toFixed(4),
      row.occupied.toFixed(4),
      row.meanV.toFixed(4),
      row.edge.toFixed(5),
      row.activity.toFixed(6),
    ].join('\t'),
  );
}
