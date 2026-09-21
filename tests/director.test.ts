/**
 * §9.1/§9.3 visual director (MAJOR 6/7).
 *
 * The director is GPU-free policy, so it is unit-testable directly. These tests cover the two
 * reported defects — seam retention (a torus-spanning organism's planar centroid no longer drags the
 * focus to the domain centre) and the bounded light azimuth (a seeded, rate-limited target that
 * holds, instead of a 4°/min unbounded orbit) — plus the MAJOR 7 pin/unpin and time-origin reset.
 */
import { describe, expect, it } from 'vitest';
import { DIRECTOR_POLICY, VisualDirector, calibratedMaterialState, coarseSeamAmbiguous } from '../src/visual/director.ts';
import { LIGHTING } from '../src/config.ts';
import type { CoarseField } from '../src/analysis/analyzer.ts';
import type { AnalysisState, HealthState, PhaseState } from '../src/core/types.ts';

const DEG = Math.PI / 180;
const HEALTH: HealthState = { qualityTier: 0, overload: false, audioUnlocked: false };

function neutralAnalysis(occupied: number): AnalysisState {
  return {
    samplePerformanceSeconds: 0,
    sampleSimulationTime: 0,
    chemistryHealth: { valid: true, ageSeconds: 0, fullOccupiedFraction: occupied, fullReactionActivity: 0.05, fullChangeRate: 0.01 },
    presentation: {
      valid: false,
      ageSeconds: 0,
      meanU: 0,
      meanV: 0,
      occupiedFraction: 0,
      reactionActivity: 0,
      changeRate: 0,
      edgeDensity: 0,
      entropy: 0,
      featureScaleUV: 0,
      spectralBands: [0, 0, 0, 0],
      beta0Approx: 0,
      beta1Approx: 0,
      largestComponentFraction: 0,
      topologyConfidence: 0,
      persistenceSeconds: 0,
      centroidUV: [0.5, 0.5],
      boundsUV: [0, 0, 0, 0],
      orientationRadians: 0,
      coherence: 0,
      symmetry: 0,
      supportFraction: 0,
    },
  };
}

interface InputOptions {
  realSeconds: number;
  occupied?: number;
  coarse?: CoarseField | null;
  intention?: PhaseState['intention'];
  stillnessState?: PhaseState['stillnessState'];
  arc?: number;
  seed?: number;
}

function makeInput(options: InputOptions): Parameters<VisualDirector['derive']>[0] {
  return {
    analysis: neutralAnalysis(options.occupied ?? 0.5),
    coarse: options.coarse ?? null,
    phase: {
      arc: options.arc ?? 0,
      movement: 'movement',
      elapsedSeconds: 0,
      progress: 0,
      intention: options.intention ?? 'expand',
      stillnessState: options.stillnessState ?? 'none',
    },
    latestEvent: { serial: 0, kind: 'none', strength: 0, atPerformanceSeconds: 0 },
    clock: { performanceSeconds: options.realSeconds, realSeconds: options.realSeconds, speed: 1 },
    performanceSeed: options.seed ?? 1234,
    arc: options.arc ?? 0,
    health: HEALTH,
  };
}

/** Build a CoarseField from a 16x16 occupancy grid (row-major, [y][x]). */
function coarseField(grid: number[][]): CoarseField {
  const size = grid.length;
  const flat = new Float32Array(size * size);
  let sum = 0;
  let weightedU = 0;
  let weightedV = 0;
  let occupied = 0;
  let minU = 1;
  let minV = 1;
  let maxU = 0;
  let maxV = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = grid[y]![x]!;
      flat[y * size + x] = value;
      sum += value;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      weightedU += u * value;
      weightedV += v * value;
      if (value > 0.02) {
        occupied += 1;
        if (u < minU) minU = u;
        if (v < minV) minV = v;
        if (u > maxU) maxU = u;
        if (v > maxV) maxV = v;
      }
    }
  }
  return {
    size,
    occupancy: flat,
    occupiedFraction: sum / (size * size),
    centroidUV: sum > 0 ? [weightedU / sum, weightedV / sum] : [0.5, 0.5],
    boundsUV: occupied > 0 ? [minU, minV, maxU, maxV] : [0, 0, 0, 0],
  };
}

const emptyGrid = (): number[][] => Array.from({ length: 16 }, () => new Array<number>(16).fill(0));

/** Occupancy on both vertical edges: a torus-spanning organism. */
function seamGrid(): number[][] {
  const grid = emptyGrid();
  for (let y = 0; y < 16; y += 1) {
    grid[y]![0] = 0.6;
    grid[y]![15] = 0.6;
  }
  return grid;
}

/** Occupancy confined to the lower-left corner: no seam ambiguity. */
function cornerGrid(): number[][] {
  const grid = emptyGrid();
  for (let y = 0; y < 6; y += 1) for (let x = 0; x < 6; x += 1) grid[y]![x] = 0.6;
  return grid;
}

describe('§4.3/§9.1 coarse seam detection (MAJOR 6)', () => {
  it('flags occupancy on both opposing edges of either axis', () => {
    expect(coarseSeamAmbiguous(coarseField(seamGrid()))).toBe(true);

    const horizontal = emptyGrid();
    for (let x = 0; x < 16; x += 1) {
      horizontal[0]![x] = 0.6;
      horizontal[15]![x] = 0.6;
    }
    expect(coarseSeamAmbiguous(coarseField(horizontal))).toBe(true);
  });

  it('does not flag one-sided or interior occupancy', () => {
    const oneSided = emptyGrid();
    for (let y = 0; y < 16; y += 1) oneSided[y]![0] = 0.6;
    expect(coarseSeamAmbiguous(coarseField(oneSided))).toBe(false);
    expect(coarseSeamAmbiguous(coarseField(cornerGrid()))).toBe(false);
    expect(coarseSeamAmbiguous(coarseField(emptyGrid()))).toBe(false);
  });
});

describe('§9.1 camera focus retention on a seam (MAJOR 6)', () => {
  it('retains the previous focus instead of jumping to the planar centre', () => {
    const director = new VisualDirector();
    // Establish a focus away from the domain centre, then release the override so the director drives.
    director.command({ type: 'override', value: { focusUV: [0.28, 0.32] } });
    director.command({ type: 'override', value: null });

    const coarse = coarseField(seamGrid()); // planar centroid ~[0.5, 0.5], but seam-ambiguous
    for (let i = 0; i <= 600; i += 1) {
      director.derive({
        ...makeInput({ realSeconds: i, coarse, intention: 'expand' }),
        clock: { performanceSeconds: i, realSeconds: i, speed: 1 },
      });
    }
    const focus = director.targets.camera.focusUV;
    expect(Math.abs(focus[0] - 0.28), 'focus must not slide toward the planar centroid').toBeLessThan(0.01);
    expect(Math.abs(focus[1] - 0.32)).toBeLessThan(0.01);
  });

  it('follows the centroid when the organism does not touch both opposing edges', () => {
    const director = new VisualDirector();
    const coarse = coarseField(cornerGrid());
    // The corner centroid is ~[0.22, 0.22].
    for (let i = 0; i <= 3000; i += 1) {
      const clock = { performanceSeconds: i, realSeconds: i, speed: 1 };
      director.derive({ ...makeInput({ realSeconds: i, coarse, intention: 'expand' }), clock });
    }
    const focus = director.targets.camera.focusUV;
    expect(focus[0]).toBeLessThan(0.35);
    expect(focus[1]).toBeLessThan(0.35);
  });
});

describe('§9.3 bounded light azimuth (MAJOR 6)', () => {
  it('seeds a bounded target, rate-limits the travel, and holds once reached', () => {
    const director = new VisualDirector();
    const frameDt = 1 / 60;
    const maxStepRadians = DIRECTOR_POLICY.azimuthTravelDegPerMinute * DEG * (frameDt / 60);
    let previous = director.targets.light.azimuthRadians;
    let totalTravel = 0;
    let azimuth = previous;
    const seconds = 6 * 60; // 6 minutes of frames
    for (let i = 1; i <= seconds * 60; i += 1) {
      const realSeconds = i * frameDt;
      director.derive(makeInput({ realSeconds, intention: 'expand' }));
      azimuth = director.targets.light.azimuthRadians;
      const step = Math.abs(azimuth - previous);
      expect(step, 'per-frame azimuth travel must respect the 25 deg/min clamp').toBeLessThanOrEqual(maxStepRadians * 1.001 + 1e-12);
      totalTravel += step;
      previous = azimuth;
    }
    const offset = Math.abs(azimuth - LIGHTING.azimuthRadians) / DEG;
    expect(offset, 'azimuth stays inside the bounded band').toBeGreaterThanOrEqual(DIRECTOR_POLICY.azimuthTargetMinDegrees - 0.5);
    expect(offset).toBeLessThanOrEqual(DIRECTOR_POLICY.azimuthTargetMaxDegrees + 0.5);
    expect(totalTravel / DEG, 'total travel is bounded').toBeLessThanOrEqual(DIRECTOR_POLICY.azimuthTargetMaxDegrees + 0.5);
  });

  it('holds (plateaus) rather than orbiting without bound', () => {
    const director = new VisualDirector();
    const frameDt = 1 / 60;
    let plateauAt = -1;
    let previous = director.targets.light.azimuthRadians;
    let stationaryFrames = 0;
    for (let i = 1; i <= 120 * 60; i += 1) {
      const realSeconds = i * frameDt;
      director.derive(makeInput({ realSeconds, intention: 'expand' }));
      const azimuth = director.targets.light.azimuthRadians;
      const step = Math.abs(azimuth - previous);
      previous = azimuth;
      if (step <= DIRECTOR_POLICY.azimuthHoldEpsilonRadians) {
        stationaryFrames += 1;
        if (stationaryFrames > 60 * 60 && plateauAt < 0) plateauAt = realSeconds;
      } else {
        stationaryFrames = 0;
      }
    }
    expect(plateauAt, 'the light must plateau well within the run').toBeGreaterThan(0);
    // A full orbit would be 2*pi; a bounded target cannot accumulate anything close.
    expect(Math.abs(previous - LIGHTING.azimuthRadians)).toBeLessThanOrEqual((DIRECTOR_POLICY.azimuthTargetMaxDegrees + 0.5) * DEG);
  });

  it('the per-arc target is seeded from performanceSeed and arc', () => {
    const a = new VisualDirector();
    const b = new VisualDirector();
    for (let i = 1; i <= 60 * 60; i += 1) {
      const realSeconds = i / 60;
      a.derive(makeInput({ realSeconds, seed: 1, arc: 0 }));
      b.derive(makeInput({ realSeconds, seed: 2, arc: 3 }));
    }
    expect(a.targets.light.azimuthRadians).not.toBeCloseTo(b.targets.light.azimuthRadians, 6);
  });
});

describe('MAJOR 7 pin/unpin and time-origin reset', () => {
  it('pins each field through the director and resumes smoothly on release', () => {
    const director = new VisualDirector();

    // Camera pin.
    director.command({ type: 'override', value: { distance: 7.5, focusUV: [0.4, 0.6] } });
    for (let i = 0; i <= 120; i += 1) director.derive(makeInput({ realSeconds: i }));
    expect(director.targets.camera.distance).toBeCloseTo(7.5, 9);
    expect(director.targets.camera.focusUV[0]).toBeCloseTo(0.4, 9);
    director.command({ type: 'override', value: null });
    // After release the director drives again (distance moves off the pinned value).
    for (let i = 121; i <= 600; i += 1) director.derive(makeInput({ realSeconds: i, occupied: 0.2 }));
    expect(Math.abs(director.targets.camera.distance - 7.5)).toBeGreaterThan(1e-3);

    // Light pin.
    director.pinLight({ azimuthRadians: 1.0, intensity: 12 });
    for (let i = 0; i <= 300; i += 1) director.derive(makeInput({ realSeconds: 1000 + i }));
    expect(director.targets.light.azimuthRadians).toBeCloseTo(1.0, 9);
    expect(director.targets.light.intensity).toBeCloseTo(12, 9);
    expect(director.pinned.light).toBe(true);
    director.pinLight(null);
    for (let i = 0; i <= 300; i += 1) director.derive(makeInput({ realSeconds: 2000 + i }));
    expect(Math.abs(director.targets.light.azimuthRadians - 1.0)).toBeGreaterThan(1e-3);
    expect(director.pinned.light).toBe(false);

    // Material pin.
    director.pinMaterial({ exposure: 0.25 });
    for (let i = 0; i <= 120; i += 1) director.derive(makeInput({ realSeconds: 3000 + i }));
    expect(director.targets.material.exposure).toBeCloseTo(0.25, 9);
    director.pinMaterial(null);
  });

  it('resetCamera restores the calibrated overhead camera and clears the pin (manual-mode release)', () => {
    const director = new VisualDirector();
    const calibrated = new VisualDirector().targets.camera;

    // A grazing laboratory override pins the camera. With automatic composition OFF nothing runs
    // `derive`, so clearing the pin alone would leave this value in force indefinitely.
    director.command({
      type: 'override',
      value: { mode: 'horizon', elevationRadians: 0.21, distance: 1.75, focusUV: [0.42, 0.58] },
    });
    for (let i = 0; i <= 120; i += 1) director.derive(makeInput({ realSeconds: i }));
    expect(director.targets.camera.elevationRadians).toBeCloseTo(0.21, 9);
    expect(director.targets.camera.distance).toBeCloseTo(1.75, 9);
    expect(director.pinned.camera).toBe(true);

    director.resetCamera();
    expect(director.pinned.camera).toBe(false);
    expect(director.targets.camera.mode).toBe('overhead');
    expect(director.targets.camera.elevationRadians).toBeCloseTo(calibrated.elevationRadians, 12);
    expect(director.targets.camera.distance).toBeCloseTo(calibrated.distance, 12);
    expect(director.targets.camera.focusUV).toEqual([0.5, 0.5]);
    // Light/material are deliberately untouched by a camera-only release.
    expect(director.targets.material).toEqual(calibratedMaterialState());
  });

  it('reset clears the time origin, so the next derive sees dt = 0 (no accumulated-delta jump)', () => {
    const director = new VisualDirector();
    for (let i = 0; i <= 1200; i += 1) director.derive(makeInput({ realSeconds: i, occupied: 0.2 }));

    director.reset();
    const defaultDistance = director.targets.camera.distance;
    // One derive long after the previous frame: with a stale origin this would snap (alpha ~ 1); a
    // cleared origin makes it a zero-delta frame.
    director.derive(makeInput({ realSeconds: 5000, occupied: 0.2 }));
    expect(director.targets.camera.distance).toBeCloseTo(defaultDistance, 9);
    expect(director.targets.camera.focusUV[0]).toBeCloseTo(0.5, 9);
    expect(director.targets.light.azimuthRadians).toBeCloseTo(LIGHTING.azimuthRadians, 9);
    expect(director.targets.material).toEqual(calibratedMaterialState());
  });
});

describe('§9.2 rare horizon eligibility', () => {
  const DEG = Math.PI / 180;
  function hash01(value: number): number {
    let x = value >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296;
  }
  const draw = (seed: number, arc: number): number => hash01((seed ^ Math.imul(arc + 1, 0x85ebca6b)) >>> 0);

  function driveHorizon(seed: number, seconds: number): { director: VisualDirector; minElevation: number; sawHorizon: boolean } {
    const director = new VisualDirector();
    director.restartPerformance(seed, 1);
    let minElevation = Infinity;
    let sawHorizon = false;
    for (let i = 0; i <= seconds; i += 1) {
      const input = makeInput({ realSeconds: i, arc: 1, seed, intention: 'connect' });
      input.clock = { performanceSeconds: i, realSeconds: i, speed: 1 };
      input.analysis.presentation = {
        ...neutralAnalysis(0.2).presentation,
        valid: true,
        occupiedFraction: 0.2,
        coherence: 0.6,
        topologyConfidence: 0.8,
        centroidUV: [0.45, 0.55],
        boundsUV: [0.3, 0.4, 0.6, 0.7],
      };
      input.latestEvent =
        i >= 470 && i < 471
          ? { serial: 1, kind: 'merge', strength: 0.5, atPerformanceSeconds: i }
          : { serial: 0, kind: 'none', strength: 0, atPerformanceSeconds: 0 };
      const targets = director.derive(input);
      if (targets.camera.mode === 'horizon') sawHorizon = true;
      minElevation = Math.min(minElevation, targets.camera.elevationRadians);
    }
    return { director, minElevation, sawHorizon };
  }

  it('does not engage before 8 minutes or without a recent connection event', () => {
    let seed = 0;
    while (draw(seed, 1) >= 0.35) seed += 1;
    const director = new VisualDirector();
    director.restartPerformance(seed, 1);
    for (let i = 0; i <= 400; i += 1) {
      const input = makeInput({ realSeconds: i, arc: 1, seed, intention: 'connect' });
      input.clock = { performanceSeconds: i, realSeconds: i, speed: 1 };
      input.analysis.presentation = { ...neutralAnalysis(0.2).presentation, valid: true, occupiedFraction: 0.2, coherence: 0.6 };
      director.derive(input);
    }
    expect(director.horizon.moments, 'no horizon before 8 minutes').toBe(0);
  });

  it('engages exactly once for an eligible arc and drives the horizon camera mode', () => {
    let seed = 0;
    while (draw(seed, 1) >= 0.35) seed += 1;
    const { director, minElevation, sawHorizon } = driveHorizon(seed, 700);
    expect(director.horizon.moments, 'one horizon moment').toBe(1);
    expect(director.horizon.usedThisArc).toBe(true);
    expect(['engaged', 'returned']).toContain(director.horizon.state);
    // The excursion descended into the low horizon band and the horizon camera mode was produced.
    expect(sawHorizon).toBe(true);
    expect(minElevation).toBeLessThan(30 * DEG);
  });

  it('never engages when the seeded draw is above the probability', () => {
    let seed = 0;
    while (draw(seed, 1) < 0.35) seed += 1;
    const { director } = driveHorizon(seed, 700);
    expect(director.horizon.moments).toBe(0);
  });
});

describe('MAJOR 2 director re-arm on a same-arc restart', () => {
  const targetFor = (seed: number): number => {
    const director = new VisualDirector();
    director.restartPerformance(seed, 0);
    return director.azimuthTargetRadians;
  };

  it("adopts the new seed's bounded light target, not the previous performance's", () => {
    // Two seeds that select genuinely different bounded targets (the test picks them, not luck).
    const seedA = 1;
    let seedB = 2;
    while (seedB < 64 && Math.abs(targetFor(seedB) - targetFor(seedA)) < 1e-6) seedB += 1;
    expect(Math.abs(targetFor(seedB) - targetFor(seedA)), 'the seeds select different targets').toBeGreaterThan(1e-6);
    const seedC = seedB + 1;

    // One director instance: settle arc 0 under seed A, then restart into seed B (still arc 0). Without
    // the explicit re-arm, `derive`'s `arc !== arcSeen` guard would treat arc 0 as already-seen and
    // keep seed A's target.
    const director = new VisualDirector();
    for (let i = 0; i <= 600; i += 1) director.derive(makeInput({ realSeconds: i, seed: seedA, arc: 0 }));
    expect(director.azimuthTargetRadians).toBeCloseTo(targetFor(seedA), 12);

    director.restartPerformance(seedB, 0);
    expect(director.azimuthTargetRadians, 'the same-arc reseed re-arms the light target').toBeCloseTo(targetFor(seedB), 12);
    expect(director.azimuthTargetRadians).not.toBeCloseTo(targetFor(seedA), 9);

    // The light actually travels to the new target rather than holding at A's plateau.
    const frameDt = 1 / 60;
    for (let i = 1; i <= 6 * 60 * 60; i += 1) director.derive(makeInput({ realSeconds: i * frameDt, seed: seedB, arc: 0 }));
    expect(director.targets.light.azimuthRadians).toBeCloseTo(targetFor(seedB), 6);

    // Prior-state independence: arriving at seed B after a run under seed C gives the same target.
    const other = new VisualDirector();
    for (let i = 0; i <= 600; i += 1) other.derive(makeInput({ realSeconds: i, seed: seedC, arc: 0 }));
    other.restartPerformance(seedB, 0);
    expect(other.azimuthTargetRadians).toBeCloseTo(targetFor(seedB), 12);
  });

  it('clears the time origin, so a restart does not take a one-frame jump', () => {
    const director = new VisualDirector();
    for (let i = 0; i <= 1200; i += 1) director.derive(makeInput({ realSeconds: i, occupied: 0.2 }));
    const distanceBefore = director.targets.camera.distance;
    director.restartPerformance(4242, 0);
    // A frame long after the previous one: a stale origin would snap; a cleared origin makes it a
    // zero-delta frame (the field and the clock both restarted).
    director.derive(makeInput({ realSeconds: 99_999, seed: 4242, arc: 0, occupied: 0.2 }));
    expect(director.targets.camera.distance).toBeCloseTo(distanceBefore, 9);
  });
});
