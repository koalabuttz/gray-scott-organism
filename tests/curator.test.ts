/**
 * §6.3/§6.4 curator: bounded graph walk, dwell, stillness state machine (AC.8), one-rescue limit,
 * quiet dwell, skip/release continuity, progress-rate scaling, and malformed-input handling.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CorrelatedSignal,
  Curator,
  MERGE_WINDOW_SECONDS,
  MIN_REBIRTH_DISPLACEMENT,
  ProgressScaler,
  enforceMinDisplacement,
  toroidalDistanceUV,
  type CuratorEnvironment,
  type CuratorOutput,
  type ProgressSignals,
  type StillnessTimeline,
} from '../src/curator/curator.ts';
import { parseTrajectoryDocument, validateTrajectoryDocument } from '../src/curator/schema.ts';
import { evaluateWaypoints } from '../src/curator/trajectory.ts';
import { Rng } from '../src/core/random.ts';
import { applyGenesisCPU } from '../src/simulation/genesis.ts';
import type { GenesisCommand, GenesisKind, PresentationAnalysis, Vec2, WorldState } from '../src/core/types.ts';

const DEFAULT_DOC = parseTrajectoryDocument(readFileSync(resolve('public/trajectories/default.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------

function neutralPresentation(valid = false): PresentationAnalysis {
  return {
    valid,
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
    boundsUV: [0, 0, 1, 1],
    orientationRadians: 0,
    coherence: 0,
    symmetry: 0,
    supportFraction: 0,
  };
}

interface WorldOptions {
  chemistry?: Partial<WorldState['analysis']['chemistryHealth']>;
  presentation?: Partial<PresentationAnalysis>;
  eventSerial?: number;
  eventKind?: WorldState['events']['kind'];
}

const ALIVE = { valid: true, ageSeconds: 0, fullOccupiedFraction: 0.5, fullReactionActivity: 0.05 };
const DEAD = { valid: true, ageSeconds: 0, fullOccupiedFraction: 0, fullReactionActivity: 0 };

function makeWorld(options: WorldOptions = {}): WorldState {
  return {
    version: 1,
    epoch: 0,
    tick: 0,
    performanceSeed: 1,
    clock: { realSeconds: 0, performanceSeconds: 0, simulationTime: 0, paused: false, speed: 1 },
    phase: { arc: 0, movement: '', elapsedSeconds: 0, progress: 0, intention: 'quiet', stillnessState: 'none' },
    parameters: { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 },
    analysis: {
      samplePerformanceSeconds: 0,
      sampleSimulationTime: 0,
      chemistryHealth: {
        valid: true,
        ageSeconds: 0,
        fullOccupiedFraction: 0.5,
        fullReactionActivity: 0.05,
        fullChangeRate: 0.01,
        ...options.chemistry,
      },
      presentation: { ...neutralPresentation(false), ...options.presentation },
    },
    events: {
      serial: options.eventSerial ?? 0,
      kind: options.eventKind ?? 'none',
      strength: 0,
      atPerformanceSeconds: 0,
    },
    camera: {
      mode: 'overhead',
      focusUV: [0.5, 0.5],
      yawRadians: 0,
      elevationRadians: 1.4,
      distance: 3,
      verticalFovRadians: 0.5,
      transitionSeconds: 1,
    },
    light: {
      azimuthRadians: 0,
      elevationRadians: 0.1,
      intensity: 30,
      colorLinear: [1, 1, 1],
      environment: 0.05,
      emissionGain: 0.05,
      transitionSeconds: 1,
    },
    material: { relief: 0.006, roughness: 0.36, emissionTintLinear: [1, 0.86, 0.7], exposure: 1.5, bloomGain: 0.04 },
    health: { qualityTier: 0, overload: false, audioUnlocked: false },
  };
}

const BYPASS_ENV: CuratorEnvironment = { silence: { satisfied: true, terminalZeroAt: null } };

interface GenesisRecord {
  t: number;
  command: GenesisCommand;
  movement: string;
  state: WorldState['phase']['stillnessState'];
  arc: number;
}

interface DriveResult {
  last: CuratorOutput;
  genesis: GenesisRecord[];
  ticks: number;
  time: number;
}

function drive(
  curator: Curator,
  options: {
    dt?: number;
    ticks: number;
    world?: (last: CuratorOutput | null, t: number) => WorldState;
    environment?: (last: CuratorOutput | null, t: number) => CuratorEnvironment;
    stop?: (out: CuratorOutput, t: number) => boolean;
    onTick?: (out: CuratorOutput, t: number) => void;
  },
): DriveResult {
  const dt = options.dt ?? 0.5;
  let t = 0;
  let last: CuratorOutput | null = null;
  const genesis: GenesisRecord[] = [];
  for (let i = 0; i < options.ticks; i += 1) {
    const world = options.world ? options.world(last, t) : makeWorld();
    const env = options.environment ? options.environment(last, t) : BYPASS_ENV;
    last = curator.advance(dt, env, world);
    for (const command of last.genesis) {
      genesis.push({ t, command, movement: last.phase.movement, state: last.phase.stillnessState, arc: last.phase.arc });
    }
    options.onTick?.(last, t);
    t += dt;
    if (options.stop?.(last, t)) break;
  }
  return { last: last!, genesis, ticks: options.ticks, time: t };
}

// A compact three-movement document that reaches stillness quickly.
function stillnessDoc() {
  return validateTrajectoryDocument({
    version: 1,
    id: 'stillness-test',
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [0.75, 1.25],
    parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 60 },
    genesisLibrary: {
      lead: { kind: 'single', center: [0.5, 0.5], radiusCells: 6, strength: 1 },
      ret: { kind: 'single', center: [0.61, 0.43], radiusCells: 7, strength: 1 },
    },
    movements: [
      {
        id: 'lead',
        seconds: 10,
        intention: 'expand',
        enterGenesis: 'lead',
        waypoints: [
          { at: 0, p: [0.03, 0.062, 0.16, 0.08] },
          { at: 1, p: [0.035, 0.064, 0.16, 0.08] },
        ],
        next: ['stillness'],
      },
      {
        id: 'stillness',
        seconds: 60,
        intention: 'quiet',
        waypoints: [
          { at: 0, p: [0.005, 0.075, 0.16, 0.08] },
          { at: 1, p: [0.005, 0.075, 0.16, 0.08] },
        ],
        next: ['rebirth'],
      },
      {
        id: 'rebirth',
        seconds: 10,
        intention: 'emerge',
        enterGenesis: 'ret',
        waypoints: [
          { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
          { at: 1, p: [0.03, 0.062, 0.16, 0.08] },
        ],
        next: ['lead'],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Full arc walk of the shipped candidate.
// ---------------------------------------------------------------------------------------------

describe('§6.3 full arc walk of the shipped candidate', () => {
  const curator = new Curator(DEFAULT_DOC, { rootSeed: 42 });
  const visited: string[] = [];
  const worlds = (last: CuratorOutput | null): WorldState =>
    makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE });

  const result = drive(curator, {
    dt: 0.5,
    ticks: 8000,
    world: (last) => worlds(last),
    stop: (out) => out.phase.arc >= 1,
    onTick: (out) => {
      if (visited[visited.length - 1] !== out.phase.movement) visited.push(out.phase.movement);
    },
  });

  it('walks dormancy through rebirth in order and increments the arc once', () => {
    expect(visited).toEqual([
      'dormancy',
      'nucleation',
      'cellular-growth',
      'replication',
      'connection',
      'labyrinth',
      'overgrowth',
      'collapse',
      'stillness',
      'rebirth',
    ]);
    expect(result.last.phase.arc).toBe(1);
  });

  it('issues the first-genesis at nucleation and the return-genesis at rebirth', () => {
    const nucleation = result.genesis.find((record) => record.movement === 'nucleation');
    expect(nucleation).toBeDefined();
    expect(nucleation!.command.mode).toBe('replace');
    expect(nucleation!.command.center[0]).toBeCloseTo(0.5, 1);
    expect(nucleation!.command.center[1]).toBeCloseTo(0.5, 1);

    const rebirth = result.genesis.find((record) => record.movement === 'rebirth');
    expect(rebirth).toBeDefined();
    expect(rebirth!.command.center[0]).toBeCloseTo(0.61, 1);
    expect(rebirth!.command.center[1]).toBeCloseTo(0.43, 1);
  });

  it('orders chemistryConfirmedAt / audioZeroAt / blackHoldStartedAt / genesisAt', () => {
    const timeline: StillnessTimeline = curator.stillnessTimeline();
    expect(timeline.killWaitEnteredAt).not.toBeNull();
    expect(timeline.chemistryConfirmedAt).not.toBeNull();
    expect(timeline.blackHoldStartedAt).not.toBeNull();
    expect(timeline.genesisAt).not.toBeNull();

    const k = timeline.killWaitEnteredAt!;
    const c = timeline.chemistryConfirmedAt!;
    const b = timeline.blackHoldStartedAt!;
    const g = timeline.genesisAt!;
    expect(c).toBeGreaterThanOrEqual(k);
    expect(c - k).toBeGreaterThanOrEqual(7.5);
    expect(c - k).toBeLessThanOrEqual(9);
    expect(b).toBeGreaterThanOrEqual(c);
    expect(g - b).toBeGreaterThanOrEqual(20);
  });

  it('issues no genesis during kill-wait or black-hold before the hold completes', () => {
    const duringHold = result.genesis.filter(
      (record) => record.state === 'kill-wait' || record.state === 'black-hold',
    );
    expect(duringHold).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Stillness state machine — both paths.
// ---------------------------------------------------------------------------------------------

describe('§6.4 stillness state machine', () => {
  it('normal path: negligible chemistry for >= 8 s leads to black-hold then genesis >= 20 s later', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    drive(curator, {
      dt: 0.5,
      ticks: 1200,
      world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
      stop: (out) => out.phase.arc >= 1,
    });
    const timeline = curator.stillnessTimeline();
    expect(timeline.chemistryConfirmedAt! - timeline.killWaitEnteredAt!).toBeGreaterThanOrEqual(7.5);
    expect(timeline.blackHoldStartedAt!).toBeGreaterThanOrEqual(timeline.chemistryConfirmedAt!);
    expect(timeline.genesisAt! - timeline.blackHoldStartedAt!).toBeGreaterThanOrEqual(20);
    expect(timeline.blackHoldCompletedAt).toBe(timeline.genesisAt);
    expect(curator.diagnosticsEmitted).toBe(0);
  });

  it('timeout path: 3x max dwell emits exactly one diagnostic and one hard clear', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    const result = drive(curator, {
      dt: 1,
      ticks: 400,
      world: () => makeWorld({ chemistry: ALIVE }), // never negligible
      stop: (out) => out.phase.arc >= 1,
    });
    expect(curator.diagnosticsEmitted).toBe(1);
    const clears = result.genesis.filter((r) => r.command.mode === 'replace' && r.command.strength === 0);
    expect(clears).toHaveLength(1);
    const timeline = curator.stillnessTimeline();
    // The clear confirms the chemistry condition, so the ordering still holds.
    expect(timeline.chemistryConfirmedAt).not.toBeNull();
    expect(timeline.blackHoldStartedAt!).toBeGreaterThanOrEqual(timeline.chemistryConfirmedAt!);
    expect(timeline.genesisAt! - timeline.blackHoldStartedAt!).toBeGreaterThanOrEqual(20);
  });

  it('never starts black-hold while CuratorEnvironment.silence is unsatisfied', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    let reachedKillWait = false;
    const result = drive(curator, {
      dt: 1,
      ticks: 400,
      world: () => makeWorld({ chemistry: ALIVE }), // never negligible → exercises the timeout
      environment: () => ({ silence: { satisfied: false, terminalZeroAt: null } }),
      onTick: (out) => {
        if (out.phase.stillnessState === 'kill-wait') reachedKillWait = true;
        if (reachedKillWait) expect(out.phase.stillnessState).toBe('kill-wait');
      },
    });
    expect(reachedKillWait).toBe(true);
    // Even after the timeout clear the hold cannot begin without the acknowledgement.
    expect(result.last.phase.stillnessState).toBe('kill-wait');
    expect(curator.diagnosticsEmitted).toBe(1);
  });

  it('carries the audio terminal-zero timestamp into the timeline', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    drive(curator, {
      dt: 0.5,
      ticks: 1200,
      world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
      environment: () => ({ silence: { satisfied: true, terminalZeroAt: 1234.5 } }),
      stop: (out) => out.phase.arc >= 1,
    });
    expect(curator.stillnessTimeline().audioZeroAt).toBe(1234.5);
  });

  it('repeated two-arc case: the second stillness requires a fresh acknowledgement', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    const deadWorld = () => makeWorld({ chemistry: DEAD });

    // Arc 1 completes with a satisfied acknowledgement.
    drive(curator, {
      dt: 0.5,
      ticks: 1200,
      world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
      stop: (out) => out.phase.arc >= 1,
    });
    expect(curator.arcIndex).toBe(1);

    // Reach stillness in arc 2 with an unacknowledged audio state.
    let last: CuratorOutput | null = null;
    let t = 0;
    let guard = 0;
    while (guard < 4000) {
      last = curator.advance(0.5, { silence: { satisfied: false, terminalZeroAt: null } }, deadWorld());
      t += 0.5;
      guard += 1;
      if (last.phase.arc === 1 && last.phase.movement === 'stillness' && last.phase.stillnessState === 'kill-wait') break;
    }
    expect(last!.phase.stillnessState).toBe('kill-wait');

    // Chemistry confirms quickly, but black-hold must wait for the fresh acknowledgement.
    for (let i = 0; i < 60; i += 1) {
      last = curator.advance(0.5, { silence: { satisfied: false, terminalZeroAt: null } }, deadWorld());
      expect(last.phase.stillnessState).toBe('kill-wait');
    }
    const beforeAck = curator.stillnessTimeline();
    expect(beforeAck.blackHoldStartedAt).toBeNull();

    // Only after a fresh satisfied acknowledgement does black-hold begin.
    last = curator.advance(0.5, { silence: { satisfied: true, terminalZeroAt: 42 } }, deadWorld());
    expect(last.phase.stillnessState).toBe('black-hold');
    expect(curator.stillnessTimeline().audioZeroAt).toBe(42);
    expect(t).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// One-rescue limit.
// ---------------------------------------------------------------------------------------------

function rescueDoc() {
  return validateTrajectoryDocument({
    version: 1,
    id: 'rescue-test',
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [0.75, 1.25],
    parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 60 },
    genesisLibrary: {
      seed: { kind: 'single', center: [0.5, 0.5], radiusCells: 6, strength: 1 },
      ret: { kind: 'single', center: [0.61, 0.43], radiusCells: 7, strength: 1 },
    },
    movements: [
      {
        id: 'nucleate',
        seconds: 40,
        intention: 'emerge',
        enterGenesis: 'seed',
        waypoints: [
          { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
          { at: 1, p: [0.03, 0.062, 0.16, 0.08] },
        ],
        next: ['stillness'],
      },
      {
        id: 'stillness',
        seconds: 30,
        intention: 'quiet',
        waypoints: [
          { at: 0, p: [0.005, 0.075, 0.16, 0.08] },
          { at: 1, p: [0.005, 0.075, 0.16, 0.08] },
        ],
        next: ['rebirth'],
      },
      {
        id: 'rebirth',
        seconds: 40,
        intention: 'emerge',
        enterGenesis: 'ret',
        waypoints: [
          { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
          { at: 1, p: [0.03, 0.062, 0.16, 0.08] },
        ],
        next: ['nucleate'],
      },
    ],
  });
}

describe('§6.4 trend-based extinction (Phase 3 refinement)', () => {
  it('does not rescue a rising seed-field that is still below the dead thresholds', () => {
    const curator = new Curator(rescueDoc(), { rootSeed: 11 });
    const result = drive(curator, {
      dt: 1,
      ticks: 45,
      world: (_last, t) =>
        makeWorld({
          chemistry: {
            valid: true,
            ageSeconds: 0,
            fullOccupiedFraction: 0.001 + t * 0.00015,
            fullReactionActivity: 0.0005,
          },
        }),
    });
    const arc0Injects = result.genesis.filter((r) => r.arc === 0 && r.command.mode === 'inject');
    expect(arc0Injects, 'a rising field below the thresholds is not extinguished').toHaveLength(0);
  });

  it('still rescues a flat dead field', () => {
    const curator = new Curator(rescueDoc(), { rootSeed: 11 });
    const result = drive(curator, { dt: 1, ticks: 60, world: () => makeWorld({ chemistry: DEAD }) });
    const arc0Injects = result.genesis.filter((r) => r.arc === 0 && r.command.mode === 'inject');
    expect(arc0Injects, 'a flat dead field is still rescued').toHaveLength(1);
    const decisions = curator.drainExtinctionLog();
    expect(decisions[0]?.occupancyGrowing).toBe(false);
  });

  it('still rescues a decaying dead field', () => {
    const curator = new Curator(rescueDoc(), { rootSeed: 11 });
    const result = drive(curator, {
      dt: 1,
      ticks: 60,
      world: (_last, t) =>
        makeWorld({
          chemistry: {
            valid: true,
            ageSeconds: 0,
            fullOccupiedFraction: Math.max(0, 0.006 - t * 0.0005),
            fullReactionActivity: 0.0005,
          },
        }),
    });
    const arc0Injects = result.genesis.filter((r) => r.arc === 0 && r.command.mode === 'inject');
    expect(arc0Injects, 'a decaying dead field is still rescued').toHaveLength(1);
  });
});

describe('§6.4 one-rescue-per-arc', () => {
  it('issues exactly one bounded injection rescue per arc, then follows the declared edge', () => {
    const curator = new Curator(rescueDoc(), { rootSeed: 11 });
    const result = drive(curator, {
      dt: 1,
      ticks: 240,
      world: () => makeWorld({ chemistry: DEAD }),
      stop: (out) => out.phase.arc >= 2,
    });

    // Arc 0: exactly one rescue (nucleate has a single outgoing edge, so no recovery alternative
    // exists and the budget is simply spent once).
    const arc0Rescues = result.genesis.filter((r) => r.arc === 0 && r.command.mode === 'inject');
    expect(arc0Rescues).toHaveLength(1);
    expect(result.genesis.filter((r) => r.arc === 0)).toHaveLength(result.genesis.filter((r) => r.arc === 0 && r.command.mode !== 'inject').length + 1);

    // A fresh arc re-arms the rescue budget: the rebirth movement (arc 1) issues its own rescue.
    const arc1Rescues = result.genesis.filter((r) => r.arc === 1 && r.command.mode === 'inject');
    expect(arc1Rescues).toHaveLength(1);
  });

  it('takes the declared recovery edge instead of a second rescue when one exists', () => {
    const doc = validateTrajectoryDocument({
      version: 1,
      id: 'recovery-test',
      nominalStepsPerSecond: 120,
      dt: 1,
      durationScaleRange: [0.75, 1.25],
      parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 60 },
      genesisLibrary: {
        seed: { kind: 'single', center: [0.5, 0.5], radiusCells: 6, strength: 1 },
        collapse: { kind: 'single', center: [0.2, 0.2], radiusCells: 6, strength: 1 },
      },
      movements: [
        {
          id: 'emerge',
          seconds: 40,
          intention: 'emerge',
          enterGenesis: 'seed',
          waypoints: [
            { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
            { at: 1, p: [0.03, 0.062, 0.16, 0.08] },
          ],
          next: ['emerge', 'collapse'],
        },
        {
          id: 'collapse',
          seconds: 20,
          intention: 'release',
          waypoints: [
            { at: 0, p: [0.045, 0.058, 0.16, 0.08] },
            { at: 1, p: [0.005, 0.075, 0.16, 0.08] },
          ],
          next: ['emerge'],
        },
      ],
    });
    const curator = new Curator(doc, { rootSeed: 5 });
    const movements: string[] = [];
    const result = drive(curator, {
      dt: 1,
      ticks: 200,
      world: () => makeWorld({ chemistry: DEAD }),
      onTick: (out) => {
        if (movements[movements.length - 1] !== out.phase.movement) movements.push(out.phase.movement);
      },
    });
    const rescues = result.genesis.filter((r) => r.command.mode === 'inject');
    expect(rescues).toHaveLength(1);
    expect(movements).toContain('collapse');
  });
});

// ---------------------------------------------------------------------------------------------
// Quiet dwell and skip/release continuity.
// ---------------------------------------------------------------------------------------------

function dwellDoc() {
  return validateTrajectoryDocument({
    version: 1,
    id: 'dwell-test',
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [0.75, 1.25],
    parameterJitter: { F: 0, k: 0, correlationSeconds: 60 },
    genesisLibrary: { seed: { kind: 'single', center: [0.5, 0.5], radiusCells: 6, strength: 1 } },
    movements: [
      {
        id: 'dormancy',
        seconds: 40,
        intention: 'quiet',
        waypoints: [
          { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
          { at: 1, p: [0.026, 0.06, 0.16, 0.08] },
        ],
        next: ['growth'],
      },
      {
        id: 'growth',
        seconds: 40,
        intention: 'expand',
        waypoints: [
          { at: 0, p: [0.03, 0.062, 0.16, 0.08] },
          { at: 1, p: [0.035, 0.064, 0.16, 0.08] },
        ],
        next: ['dormancy'],
      },
    ],
  });
}

describe('§6.4 quiet dwell and continuity', () => {
  it('honours quiet dwell at the top of the duration-scale range and does not rescue during quiet', () => {
    const curator = new Curator(dwellDoc(), { rootSeed: 3, durationJitterFraction: 0 });
    let dormancyStart = -1;
    let growthStart = -1;
    let growthEnd = -1;
    let t = 0;
    const dt = 0.5;
    for (let i = 0; i < 500 && growthEnd < 0; i += 1) {
      const out = curator.advance(dt, BYPASS_ENV, makeWorld({ chemistry: DEAD })); // dead, but quiet must never rescue
      expect(out.genesis).toHaveLength(0); // no rescue while chemistry is dead but the movement is quiet
      if (out.phase.movement === 'dormancy' && dormancyStart < 0) dormancyStart = t;
      if (out.phase.movement === 'growth' && growthStart < 0) growthStart = t;
      if (out.phase.movement === 'dormancy' && growthStart >= 0 && growthEnd < 0) growthEnd = t;
      t += dt;
    }
    // Quiet (dormancy) runs to 1.25 x nominal = 50 s.
    expect(growthStart - dormancyStart).toBeGreaterThanOrEqual(49);
    expect(growthStart - dormancyStart).toBeLessThanOrEqual(51);
    // Non-quiet (growth) runs near nominal = 40 s, strictly shorter than the quiet dwell.
    expect(growthEnd - growthStart).toBeGreaterThanOrEqual(38);
    expect(growthEnd - growthStart).toBeLessThanOrEqual(41);
    expect(growthStart - dormancyStart).toBeGreaterThan(growthEnd - growthStart);
  });

  it('skip-movement crossfades from the actual current parameters without a chemistry reset', () => {
    const curator = new Curator(dwellDoc(), { rootSeed: 9, durationJitterFraction: 0 });
    let last!: CuratorOutput;
    for (let i = 0; i < 20; i += 1) last = curator.advance(0.5, BYPASS_ENV, makeWorld());
    expect(last.phase.movement).toBe('dormancy');
    const before = last.parameters;

    curator.command({ type: 'skip-movement' });
    const afterSkip = curator.advance(0.01, BYPASS_ENV, makeWorld());
    expect(afterSkip.phase.movement).toBe('growth');
    // Continuity: the tick after the skip is still exactly the pre-skip vector (no jump).
    expect(afterSkip.parameters.F).toBeCloseTo(before.F, 9);
    expect(afterSkip.parameters.k).toBeCloseTo(before.k, 9);
    // Skip issues no genesis (chemistry is never reset by the curator).
    expect(afterSkip.genesis).toHaveLength(0);

    // After the 15 s window the output has tracked onto the path.
    let drifted = afterSkip.parameters.F;
    for (let i = 0; i < 160; i += 1) drifted = curator.advance(0.1, BYPASS_ENV, makeWorld()).parameters.F;
    expect(drifted).toBeGreaterThanOrEqual(0.029);
    expect(drifted).toBeLessThanOrEqual(0.036);
  });

  it('parameters-release blends from the override into the current path over 15 s', () => {
    const curator = new Curator(dwellDoc(), { rootSeed: 9, durationJitterFraction: 0 });
    for (let i = 0; i < 20; i += 1) curator.advance(0.5, BYPASS_ENV, makeWorld());

    const override = { F: 0.09, k: 0.01, Du: 0.16, Dv: 0.08 };
    curator.command({ type: 'parameters-override', value: override });
    const held = curator.advance(0.5, BYPASS_ENV, makeWorld());
    expect(held.parameters).toEqual(override);

    curator.command({ type: 'parameters-release' });
    const atRelease = curator.advance(0.01, BYPASS_ENV, makeWorld());
    expect(atRelease.parameters.F).toBeCloseTo(override.F, 6);

    let current = atRelease.parameters;
    for (let i = 0; i < 160; i += 1) current = curator.advance(0.1, BYPASS_ENV, makeWorld()).parameters;
    // Converged near the dormancy path (F ~ 0.026), not the override.
    expect(current.F).toBeLessThan(0.05);
    expect(current.F).toBeGreaterThan(0.02);
  });

  it('mid-movement skip continuity holds when the source is mid-way', () => {
    const curator = new Curator(dwellDoc(), { rootSeed: 9, durationJitterFraction: 0 });
    for (let i = 0; i < 100; i += 1) curator.advance(0.5, BYPASS_ENV, makeWorld());
    const before = curator.parameters;
    curator.command({ type: 'skip-movement' });
    const afterSkip = curator.advance(0.01, BYPASS_ENV, makeWorld());
    expect(afterSkip.parameters.F).toBeCloseTo(before.F, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// Waypoint evaluation against the reference interpolation.
// ---------------------------------------------------------------------------------------------

describe('§6.4 waypoint evaluation', () => {
  it('matches evaluateWaypoints at the same progress within the jitter bound', () => {
    const doc = validateTrajectoryDocument({
      version: 1,
      id: 'waypoint-test',
      nominalStepsPerSecond: 120,
      dt: 1,
      durationScaleRange: [1, 1],
      parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 60 },
      genesisLibrary: {},
      movements: [
        {
          id: 'ramp',
          seconds: 100,
          intention: 'expand',
          waypoints: [
            { at: 0, p: [0, 0.01, 0.16, 0.08] },
            { at: 1, p: [0.1, 0.05, 0.16, 0.08] },
          ],
          next: ['ramp'],
        },
      ],
    });
    const curator = new Curator(doc, { rootSeed: 1, durationJitterFraction: 0 });
    // Advance to 50 s (progress 0.5), presentation invalid so the progress rate is exactly 1.
    let out!: CuratorOutput;
    for (let i = 0; i < 100; i += 1) out = curator.advance(0.5, BYPASS_ENV, makeWorld());
    const progress = out.phase.progress;
    expect(progress).toBeCloseTo(0.5, 3);

    const spec = doc.movements[0]!;
    const expected = evaluateWaypoints(spec.waypoints, progress);
    expect(Math.abs(out.parameters.F - expected[0])).toBeLessThanOrEqual(0.0005);
    expect(Math.abs(out.parameters.k - expected[1])).toBeLessThanOrEqual(0.0005);

    // Endpoint exactness: at path end the movement's own last waypoint is reached.
    const nearEnd = evaluateWaypoints(spec.waypoints, 1);
    expect(nearEnd[0]).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------------------------
// Malformed / invalid inputs.
// ---------------------------------------------------------------------------------------------

describe('curator malformed-input handling', () => {
  it('reverts to elapsed-time behaviour with invalid analysis and never crashes', () => {
    const curator = new Curator(DEFAULT_DOC, { rootSeed: 4 });
    const invalid = makeWorld({
      chemistry: { valid: false },
      presentation: { ...neutralPresentation(false), valid: false },
    });
    let out!: CuratorOutput;
    for (let i = 0; i < 400; i += 1) out = curator.advance(0.5, BYPASS_ENV, invalid);
    // 200 s of pure elapsed-time progress: the walk is well past dormancy and no chemistry-health
    // dependent shortcut (rescue / exit hint) has fired.
    expect(out.phase.movement).not.toBe('dormancy');
    expect(out.phase.arc).toBe(0);
    expect(() => curator.advance(0, BYPASS_ENV, invalid)).not.toThrow();
  });

  it('treats locked/unavailable audio (satisfied, terminalZeroAt null) as a valid bypass', () => {
    const curator = new Curator(stillnessDoc(), { rootSeed: 7 });
    let sawBlackHold = false;
    drive(curator, {
      dt: 0.5,
      ticks: 1200,
      world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
      environment: () => ({ silence: { satisfied: true, terminalZeroAt: null } }),
      stop: (out) => out.phase.arc >= 1,
      onTick: (out) => {
        if (out.phase.stillnessState === 'black-hold') sawBlackHold = true;
      },
    });
    expect(sawBlackHold).toBe(true);
    expect(curator.stillnessTimeline().audioZeroAt).toBeNull();
    // The full 20 s hold is intact even on the bypass.
    expect(curator.stillnessTimeline().genesisAt! - curator.stillnessTimeline().blackHoldStartedAt!).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------------------------
// Progress-rate scaling and correlated signals.
// ---------------------------------------------------------------------------------------------

describe('§6.4 progress-rate scaling', () => {
  const base: ProgressSignals = {
    valid: true,
    changeRate: 0,
    occupiedFraction: 0,
    reactionActivity: 0,
    recentMerge: false,
    beyondNominalDwell: false,
  };

  it('reverts to exactly 1 with invalid analysis', () => {
    const scaler = new ProgressScaler();
    for (let i = 0; i < 20; i += 1) expect(scaler.update({ ...base, valid: false, changeRate: 1 }, 1)).toBe(1);
  });

  it('slows progress on sustained novelty, without jumping on the first tick, and stays bounded', () => {
    const scaler = new ProgressScaler({ smoothingSeconds: 10 });
    const first = scaler.update({ ...base, changeRate: 0.5 }, 1);
    expect(first).toBeLessThan(1);
    expect(first).toBeGreaterThan(0.7); // smoothing: no instantaneous snap
    let rate = first;
    for (let i = 0; i < 200; i += 1) rate = scaler.update({ ...base, changeRate: 0.5 }, 1);
    expect(rate).toBeGreaterThanOrEqual(0.7);
    expect(rate).toBeLessThan(0.75);
  });

  it('hastens progress on low novelty beyond the nominal dwell', () => {
    const scaler = new ProgressScaler();
    let rate = 1;
    for (let i = 0; i < 200; i += 1)
      rate = scaler.update({ ...base, changeRate: 0.0001, beyondNominalDwell: true }, 1);
    expect(rate).toBeGreaterThan(1.25);
    expect(rate).toBeLessThanOrEqual(1.3);
  });

  it('gives stable living states extra dwell', () => {
    const scaler = new ProgressScaler();
    let rate = 1;
    for (let i = 0; i < 200; i += 1)
      rate = scaler.update({ ...base, changeRate: 0.005, occupiedFraction: 0.4, reactionActivity: 0.05 }, 1);
    expect(rate).toBeLessThan(1);
    expect(rate).toBeGreaterThanOrEqual(0.7);
  });

  it('applies hysteresis: a target change smaller than the deadband is ignored', () => {
    // High novelty wants target 0.7; |0.7 - 1| = 0.3 < 0.5 deadband, so the held target stays at 1.
    const wide = new ProgressScaler({ hysteresis: 0.5 });
    for (let i = 0; i < 20; i += 1) wide.update({ ...base, changeRate: 0.5 }, 1);
    expect(wide.heldTarget).toBe(1);
    expect(wide.rate).toBeCloseTo(1, 6);

    // With a smaller deadband the same signal does move the held target onto 0.7.
    const narrow = new ProgressScaler({ hysteresis: 0.1 });
    for (let i = 0; i < 20; i += 1) narrow.update({ ...base, changeRate: 0.5 }, 1);
    expect(narrow.heldTarget).toBe(0.7);
  });

  it('always returns a rate within [.7, 1.3] for random signals', () => {
    const scaler = new ProgressScaler();
    const rng = new Rng(123);
    for (let i = 0; i < 2000; i += 1) {
      const rate = scaler.update(
        {
          valid: rng.next() > 0.1,
          changeRate: rng.range(0, 0.3),
          occupiedFraction: rng.range(0, 1),
          reactionActivity: rng.range(0, 0.5),
          recentMerge: rng.next() > 0.9,
          beyondNominalDwell: rng.next() > 0.5,
        },
        rng.range(0.05, 1),
      );
      expect(rate).toBeGreaterThanOrEqual(0.7 - 1e-9);
      expect(rate).toBeLessThanOrEqual(1.3 + 1e-9);
    }
  });
});

describe('CorrelatedSignal', () => {
  it('stays within its bounds and is deterministic for a seed', () => {
    const a = new CorrelatedSignal(new Rng(5), { min: -0.05, max: 0.05, correlationSeconds: 60, initial: 0 });
    const b = new CorrelatedSignal(new Rng(5), { min: -0.05, max: 0.05, correlationSeconds: 60, initial: 0 });
    for (let i = 0; i < 2000; i += 1) {
      const va = a.update(0.5);
      const vb = b.update(0.5);
      expect(va).toBe(vb);
      expect(va).toBeGreaterThanOrEqual(-0.05);
      expect(va).toBeLessThanOrEqual(0.05);
    }
  });

  it('rejects invalid bounds', () => {
    expect(() => new CorrelatedSignal(new Rng(1), { min: 1, max: 0, correlationSeconds: 60 })).toThrow();
    expect(() => new CorrelatedSignal(new Rng(1), { min: 0, max: 1, correlationSeconds: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// MAJOR 1 — incremental progress accumulation and the merge window.
// ---------------------------------------------------------------------------------------------

/** A single long self-referencing movement so progress can be observed without a transition. */
function rampDoc() {
  return validateTrajectoryDocument({
    version: 1,
    id: 'monotone-test',
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [0.75, 1.25],
    parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 40 },
    genesisLibrary: {},
    movements: [
      {
        id: 'ramp',
        seconds: 200,
        intention: 'expand',
        waypoints: [
          { at: 0, p: [0.03, 0.062, 0.16, 0.08] },
          { at: 1, p: [0.04, 0.07, 0.16, 0.08] },
        ],
        next: ['ramp'],
      },
    ],
  });
}

describe('§6.4 progress is monotone (incremental accumulation)', () => {
  it('never decreases while novelty and duration targets alternate', () => {
    const curator = new Curator(rampDoc(), { rootSeed: 21 });
    // Alternate a 20 s high-novelty block (slows progress) with a 20 s low-novelty block (hastens),
    // so the instantaneous rate swings widely; duration jitter moves too (default 8%).
    let previous = -1;
    let minRate = Infinity;
    let maxRate = -Infinity;
    for (let i = 0; i < 200; i += 1) {
      const highNovelty = Math.floor(i / 40) % 2 === 0;
      const world = makeWorld({
        presentation: {
          valid: true,
          changeRate: highNovelty ? 0.5 : 0.0001,
          occupiedFraction: 0.3,
          reactionActivity: 0.05,
        },
      });
      const out = curator.advance(0.5, BYPASS_ENV, world);
      // The retrospective `elapsed * rate / duration` formula would move progress backward here.
      expect(out.phase.progress).toBeGreaterThanOrEqual(previous);
      expect(out.phase.movement).toBe('ramp'); // never completes within 100 s of a 200 s movement
      previous = out.phase.progress;
      minRate = Math.min(minRate, curator.progressRate);
      maxRate = Math.max(maxRate, curator.progressRate);
    }
    expect(previous).toBeGreaterThan(0);
    // The rate genuinely swung, so the monotonicity above is a real constraint and not a flat run.
    expect(minRate).toBeLessThan(0.9);
    expect(maxRate).toBeGreaterThan(minRate + 0.05);
  });

  it('expires the merge slowdown ~10 s after the event, including across a movement transition', () => {
    const doc = validateTrajectoryDocument({
      version: 1,
      id: 'merge-test',
      nominalStepsPerSecond: 120,
      dt: 1,
      durationScaleRange: [1, 1],
      parameterJitter: { F: 0, k: 0, correlationSeconds: 60 },
      genesisLibrary: {},
      movements: [
        {
          id: 'a',
          seconds: 6,
          intention: 'connect',
          waypoints: [
            { at: 0, p: [0.03, 0.06, 0.16, 0.08] },
            { at: 1, p: [0.03, 0.06, 0.16, 0.08] },
          ],
          next: ['b'],
        },
        {
          id: 'b',
          seconds: 60,
          intention: 'connect',
          waypoints: [
            { at: 0, p: [0.03, 0.06, 0.16, 0.08] },
            { at: 1, p: [0.03, 0.06, 0.16, 0.08] },
          ],
          next: ['b'],
        },
      ],
    });
    const curator = new Curator(doc, { rootSeed: 3, durationJitterFraction: 0 });
    // Low novelty and a non-living field, so once the merge window clears the rate target recovers
    // toward the "gentle hastening" value (1.05) rather than the extra-dwell value.
    const recovering = (serial: number, kind: WorldState['events']['kind']): WorldState =>
      makeWorld({
        presentation: { valid: true, changeRate: 0.0001, occupiedFraction: 0.01, reactionActivity: 0 },
        eventSerial: serial,
        eventKind: kind,
      });

    let out = curator.advance(0.5, BYPASS_ENV, recovering(1, 'merge'));
    expect(curator.recentMergeActive()).toBe(true);
    expect(MERGE_WINDOW_SECONDS).toBe(10);
    // Collect visited movements from the first tick: movement `a` (6 s) transitions inside the window.
    const visited = new Set<string>([out.phase.movement]);

    // ~9 s later the window is still open.
    for (let i = 0; i < 17; i += 1) {
      out = curator.advance(0.5, BYPASS_ENV, recovering(1, 'merge'));
      visited.add(out.phase.movement);
    }
    expect(curator.recentMergeActive()).toBe(true);
    const rateDuringMerge = curator.progressRate;

    // Drive well past 10 s.
    for (let i = 0; i < 60; i += 1) {
      out = curator.advance(0.5, BYPASS_ENV, recovering(1, 'merge'));
      visited.add(out.phase.movement);
    }
    expect(visited.has('a')).toBe(true);
    expect(visited.has('b')).toBe(true);
    // The window expired rather than persisting to the arc reset.
    expect(curator.recentMergeActive()).toBe(false);
    // ...and the rate target recovered.
    expect(curator.progressRate).toBeGreaterThan(rateDuringMerge);
    expect(curator.progressRate).toBeGreaterThan(1);

    // A fresh merge re-arms it.
    curator.advance(0.5, BYPASS_ENV, recovering(2, 'merge'));
    expect(curator.recentMergeActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// MAJOR 2 — load-trajectory keeps the crossfade origin and adopts the new document's state.
// ---------------------------------------------------------------------------------------------

function constDoc(id: string, f: number, k: number, jitterF: number, correlationSeconds: number) {
  return validateTrajectoryDocument({
    version: 1,
    id,
    nominalStepsPerSecond: 120,
    dt: 1,
    durationScaleRange: [1, 1],
    parameterJitter: { F: jitterF, k: jitterF, correlationSeconds },
    genesisLibrary: {},
    movements: [
      {
        id: 'hold',
        seconds: 400,
        intention: 'expand',
        waypoints: [
          { at: 0, p: [f, k, 0.16, 0.08] },
          { at: 1, p: [f, k, 0.16, 0.08] },
        ],
        next: ['hold'],
      },
    ],
  });
}

describe('§6.4 load-trajectory', () => {
  it('crossfades from the actual current vector and adopts the new document jitter', () => {
    const docA = constDoc('A', 0.026, 0.06, 0.0004, 60);
    const docB = constDoc('B', 0.09, 0.01, 0.002, 30); // far first waypoint, wider jitter, faster correlation
    const curator = new Curator(docA, { rootSeed: 77, durationJitterFraction: 0 });
    for (let i = 0; i < 40; i += 1) curator.advance(0.5, BYPASS_ENV, makeWorld());
    const prior = curator.parameters;
    expect(prior.F).toBeCloseTo(0.026, 2);

    curator.command({ type: 'load-trajectory', document: docB });

    // First output is continuous from the actual current vector — NOT jump to B's first waypoint.
    const first = curator.advance(0.5, BYPASS_ENV, makeWorld());
    expect(first.phase.movement).toBe('hold');
    expect(Math.abs(first.parameters.F - prior.F)).toBeLessThanOrEqual(0.0025);
    expect(Math.abs(first.parameters.F - 0.09)).toBeGreaterThan(0.05);

    // It converges onto the new path over the 15 s load crossfade.
    let out = first;
    for (let i = 0; i < 30; i += 1) out = curator.advance(0.5, BYPASS_ENV, makeWorld());
    expect(out.parameters.F).toBeCloseTo(0.09, 2);
    expect(out.parameters.k).toBeCloseTo(0.01, 2);

    // Subsequent jitter obeys B's amplitude, not A's: over 120 s the deviation from the constant
    // path exceeds A's old ±0.0004 bound while never exceeding B's ±0.002.
    let maxDeviation = 0;
    for (let i = 0; i < 240; i += 1) {
      const sample = curator.advance(0.5, BYPASS_ENV, makeWorld());
      maxDeviation = Math.max(maxDeviation, Math.abs(sample.parameters.F - 0.09));
    }
    expect(maxDeviation).toBeLessThanOrEqual(0.002 + 1e-6);
    expect(maxDeviation).toBeGreaterThan(0.0006);
  });
});

// ---------------------------------------------------------------------------------------------
// MAJOR 3 — rebirth displacement >= 0.12 (toroidal).
// ---------------------------------------------------------------------------------------------

describe('§6.4 rebirth displacement (§4.3 toroidal)', () => {
  it('toroidalDistanceUV uses the minimum image', () => {
    expect(toroidalDistanceUV([0.5, 0.5], [0.5, 0.5])).toBe(0);
    expect(toroidalDistanceUV([0.99, 0.5], [0.01, 0.5])).toBeCloseTo(0.02, 10);
    expect(toroidalDistanceUV([0.5, 0.5], [0.61, 0.43])).toBeCloseTo(0.13038, 4);
    expect(MIN_REBIRTH_DISPLACEMENT).toBe(0.12);
  });

  it('projects adversarial draws back to exactly the minimum displacement', () => {
    // Worst case: the shipped pair with both centres jittered toward each other by the ±0.004 bound
    // gives only ~0.1194 — below 0.12 — so the projection must fire.
    const worstBefore = toroidalDistanceUV([0.606, 0.434], [0.504, 0.496]);
    expect(worstBefore).toBeLessThan(MIN_REBIRTH_DISPLACEMENT);
    expect(worstBefore).toBeCloseTo(0.11937, 4);

    const cases: { prior: Vec2; center: Vec2 }[] = [
      { prior: [0.504, 0.496], center: [0.606, 0.434] }, // 0.1194 < 0.12 -> projected
      { prior: [0.5, 0.5], center: [0.5, 0.5] }, // coincident
      { prior: [0.5, 0.5], center: [0.5, 0.5001] }, // nearly coincident
      { prior: [0.5, 0.5], center: [0.85, 0.5] }, // already satisfied -> unchanged
      { prior: [0.995, 0.5], center: [0.001, 0.5] }, // across the seam -> projected
    ];
    for (const { prior, center } of cases) {
      const before = toroidalDistanceUV(center, prior);
      const projected = enforceMinDisplacement(center, prior, MIN_REBIRTH_DISPLACEMENT);
      const after = toroidalDistanceUV(projected, prior);
      expect(after).toBeGreaterThanOrEqual(MIN_REBIRTH_DISPLACEMENT - 1e-9);
      if (before < MIN_REBIRTH_DISPLACEMENT) {
        // Pushed out to exactly the minimum along its own displacement direction.
        expect(after).toBeLessThanOrEqual(MIN_REBIRTH_DISPLACEMENT + 1e-9);
      } else {
        expect(after).toBeCloseTo(before, 10); // untouched
      }
      expect(projected[0]).toBeGreaterThanOrEqual(0);
      expect(projected[0]).toBeLessThan(1);
      expect(projected[1]).toBeGreaterThanOrEqual(0);
      expect(projected[1]).toBeLessThan(1);
    }
  });

  it('sweeps deterministic roots: every rebirth origin is >= 0.12 from the prior origin', () => {
    for (const rootSeed of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]) {
      const curator = new Curator(DEFAULT_DOC, { rootSeed });
      const result = drive(curator, {
        dt: 1,
        ticks: 4000,
        world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
        stop: (out) => out.phase.arc >= 2,
      });
      const origins: Vec2[] = result.genesis
        .filter((record) => record.command.mode === 'replace' && record.command.strength > 0)
        .map((record) => record.command.center);
      // nucleation origin plus at least two rebirth origins.
      expect(origins.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < origins.length; i += 1) {
        expect(toroidalDistanceUV(origins[i]!, origins[i - 1]!)).toBeGreaterThanOrEqual(
          MIN_REBIRTH_DISPLACEMENT - 1e-9,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fresh curator resets all composition state (MAJOR 1).
// ---------------------------------------------------------------------------------------------

describe('§6.4 a fresh curator resets all composition state (MAJOR 1)', () => {
  const sequence = (seed: number, ticks: number): string[] => {
    const curator = new Curator(DEFAULT_DOC, { rootSeed: seed });
    const result = drive(curator, { dt: 0.5, ticks, world: () => makeWorld({ chemistry: ALIVE }) });
    return result.genesis.map(
      (record) =>
        `${record.command.kind}|${record.command.mode}|${record.command.seed}|` +
        `${record.command.center[0].toFixed(9)}|${record.command.center[1].toFixed(9)}|` +
        `${record.command.radiusCells.toFixed(9)}|${record.command.strength.toFixed(9)}`,
    );
  };

  it('constructs deterministically: the same root seed reproduces the same command sequence', () => {
    const first = sequence(4242, 4000);
    const second = sequence(4242, 4000);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('a brand-new curator is arc 0 / dormancy with an un-spent rescue and no origin or timeline', () => {
    // Drive one curator to a completed arc so it carries arc/rescue/origin/timeline state.
    const driven = new Curator(DEFAULT_DOC, { rootSeed: 7 });
    drive(driven, {
      dt: 0.5,
      ticks: 8000,
      world: (last) => makeWorld({ chemistry: last?.phase.movement === 'stillness' ? DEAD : ALIVE }),
      stop: (out) => out.phase.arc >= 1,
    });
    expect(driven.arcIndex).toBe(1);
    expect(driven.genesisOrigin).not.toBeNull();
    expect(driven.stillnessTimeline().genesisAt).not.toBeNull();

    // A fresh construction with the same seed starts clean.
    const fresh = new Curator(DEFAULT_DOC, { rootSeed: 7 });
    expect(fresh.arcIndex).toBe(0);
    expect(fresh.movementId).toBe('dormancy');
    expect(fresh.stillState).toBe('none');
    expect(fresh.rescueUsed).toBe(false);
    expect(fresh.genesisOrigin).toBeNull();
    const timeline = fresh.stillnessTimeline();
    expect(timeline.killWaitEnteredAt).toBeNull();
    expect(timeline.chemistryConfirmedAt).toBeNull();
    expect(timeline.audioZeroAt).toBeNull();
    expect(timeline.blackHoldStartedAt).toBeNull();
    expect(timeline.blackHoldCompletedAt).toBeNull();
    expect(timeline.genesisAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Hard-clear inertness for every genesis library kind (MAJOR 4 integration).
// ---------------------------------------------------------------------------------------------

describe('§6.4 hard clear is genuinely inert for radial/structured libraries (MAJOR 4)', () => {
  function stillnessDocWithLibraryKind(kind: GenesisKind) {
    return validateTrajectoryDocument({
      version: 1,
      id: `stillness-${kind}`,
      nominalStepsPerSecond: 120,
      dt: 1,
      durationScaleRange: [0.75, 1.25],
      parameterJitter: { F: 0.0004, k: 0.0004, correlationSeconds: 60 },
      genesisLibrary: {
        lead: { kind, center: [0.5, 0.5], radiusCells: 6, strength: 1 },
        ret: { kind, center: [0.61, 0.43], radiusCells: 7, strength: 1 },
      },
      movements: [
        {
          id: 'lead',
          seconds: 10,
          intention: 'expand',
          enterGenesis: 'lead',
          waypoints: [
            { at: 0, p: [0.03, 0.062, 0.16, 0.08] },
            { at: 1, p: [0.035, 0.064, 0.16, 0.08] },
          ],
          next: ['stillness'],
        },
        {
          id: 'stillness',
          seconds: 60,
          intention: 'quiet',
          waypoints: [
            { at: 0, p: [0.005, 0.075, 0.16, 0.08] },
            { at: 1, p: [0.005, 0.075, 0.16, 0.08] },
          ],
          next: ['rebirth'],
        },
        {
          id: 'rebirth',
          seconds: 10,
          intention: 'emerge',
          enterGenesis: 'ret',
          waypoints: [
            { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
            { at: 1, p: [0.03, 0.062, 0.16, 0.08] },
          ],
          next: ['lead'],
        },
      ],
    });
  }

  for (const kind of ['radial', 'structured'] as const) {
    it(`the timeout hard clear of a ${kind} library leaves exactly (1, 0)`, () => {
      const curator = new Curator(stillnessDocWithLibraryKind(kind), { rootSeed: 5 });
      const result = drive(curator, {
        dt: 1,
        ticks: 400,
        world: () => makeWorld({ chemistry: ALIVE }), // never negligible -> the timeout path
        stop: (out) => out.phase.arc >= 1,
      });
      const clear = result.genesis.find((r) => r.command.mode === 'replace' && r.command.strength === 0);
      expect(clear, `${kind}: a hard clear must be issued`).toBeDefined();
      expect(clear!.command.kind).toBe(kind);

      const size = 96;
      const field = {
        u: new Float32Array(size * size).fill(0.4),
        v: new Float32Array(size * size).fill(0.5),
        width: size,
        height: size,
      };
      applyGenesisCPU(field, clear!.command);
      let nonInert = 0;
      for (let i = 0; i < field.u.length; i += 1) {
        if (field.u[i] !== 1 || field.v[i] !== 0) nonInert += 1;
      }
      expect(nonInert, `${kind}: the hard clear must leave an inert field`).toBe(0);
    });
  }
});
