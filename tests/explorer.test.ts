/**
 * §6.5 discovery tooling — the planner/reducer half (`src/lab/explorer.ts`).
 *
 * The transition enumeration and descriptor reduction are pure, so they are asserted here without a
 * GPU; `scripts/explore.ts` is the Playwright driver that feeds them from the real page.
 */
import { describe, expect, it } from 'vitest';
import bundledTrajectory from '../public/trajectories/default.json';
import {
  MIN_REBIRTH_DISPLACEMENT,
  toroidalDistanceUV,
} from '../src/curator/curator.ts';
import { validateTrajectoryDocument } from '../src/curator/schema.ts';
import type { Vec2 } from '../src/core/types.ts';
import {
  DISCOVERY_GRID,
  DISCOVERY_SEEDS,
  OBSERVATION_PERFORMANCE_SECONDS,
  genesisCommandSignature,
  paramsFromWaypoint,
  requireExploration,
  shippedTransitions,
  summarizeSamples,
  transitionEntryGenesis,
  type DescriptorSample,
} from '../src/lab/explorer.ts';

const document = validateTrajectoryDocument(bundledTrajectory);

describe('§6.5 shipped-trajectory transitions', () => {
  it('enumerates one transition per movement edge, source endpoint -> destination start', () => {
    const transitions = shippedTransitions(document);
    expect(transitions.length).toBe(document.movements.length - 1);
    for (let index = 1; index < document.movements.length; index += 1) {
      const transition = transitions[index - 1]!;
      const previous = document.movements[index - 1]!;
      const movement = document.movements[index]!;
      expect(transition.index).toBe(index);
      expect(transition.source.movement).toBe(previous.id);
      expect(transition.destination.movement).toBe(movement.id);
      expect(transition.source.params).toEqual(
        paramsFromWaypoint(previous.waypoints[previous.waypoints.length - 1]!.p),
      );
      expect(transition.destination.params).toEqual(paramsFromWaypoint(movement.waypoints[0]!.p));
    }
    expect(new Set(transitions.map((t) => t.id)).size).toBe(transitions.length);
  });

  it('covers the dormancy, growth, connection, release and rebirth edges', () => {
    const ids = shippedTransitions(document).map((t) => t.id);
    expect(ids.some((id) => id.includes('dormancy-to-nucleation'))).toBe(true);
    expect(ids.some((id) => id.includes('collapse-to-stillness'))).toBe(true);
    expect(ids.some((id) => id.includes('stillness-to-rebirth'))).toBe(true);
  });

  it('resolves each destination movement enterGenesis so the edge is tested as the curator runs it', () => {
    const transitions = shippedTransitions(document);
    const byId = new Map(transitions.map((t) => [t.id, t]));
    const nucleation = [...byId.values()].find((t) => t.destination.movement === 'nucleation')!;
    const rebirth = [...byId.values()].find((t) => t.destination.movement === 'rebirth')!;
    expect(nucleation.destinationGenesis?.kind).toBe('single');
    expect(rebirth.destinationGenesis?.kind).toBe('single');
    // The rebirth library entry is a real recorded centre, not a default.
    expect(rebirth.destinationGenesis?.center).toEqual([0.61, 0.43]);
    // A movement with no enterGenesis must resolve to null (no spurious seed).
    const connection = [...byId.values()].find((t) => t.destination.movement === 'connection')!;
    expect(connection.destinationGenesis).toBeNull();
  });

  it('is lab-gated: exploration mode must be active', () => {
    expect(() => requireExploration(false)).toThrow(/lab-gated/);
    expect(() => requireExploration(true)).not.toThrow();
    expect(DISCOVERY_GRID).toBe(512);
    expect(DISCOVERY_SEEDS.length).toBeGreaterThanOrEqual(3);
    expect(OBSERVATION_PERFORMANCE_SECONDS).toBeGreaterThanOrEqual(60);
    expect(OBSERVATION_PERFORMANCE_SECONDS).toBeLessThanOrEqual(120);
  });
});

describe('§6.4/§6.5 curator-faithful movement-entry genesis', () => {
  const transitions = shippedTransitions(document);
  /** The only two edges whose destination declares an `enterGenesis`: dormancy→nucleation, stillness→rebirth. */
  const entryEdges = transitions.filter((transition) => transition.destinationGenesis !== null);

  it('finds exactly the two declared entry edges', () => {
    expect(entryEdges.map((transition) => transition.id)).toEqual([
      '01-dormancy-to-nucleation',
      '09-stillness-to-rebirth',
    ]);
  });

  it('varies centre/radius/strength across seeds (not just command.seed), reproducibly', () => {
    for (const transition of entryEdges) {
      const base = transition.destinationGenesis!;
      const prior: Vec2 = [base.center[0], base.center[1]];
      const signatures = DISCOVERY_SEEDS.map((seed) =>
        genesisCommandSignature(transitionEntryGenesis(document, transition, seed, prior)!),
      );
      // Three distinct commands — the previous driver produced three identical `single` commands
      // because it only varied `command.seed`, which the `single` shader branch ignores.
      expect(new Set(signatures).size, `${transition.id}: three distinct command signatures`).toBe(3);
      // Deterministic: re-running a seed reproduces its signature exactly.
      const again = DISCOVERY_SEEDS.map((seed) =>
        genesisCommandSignature(transitionEntryGenesis(document, transition, seed, prior)!),
      );
      expect(again, `${transition.id}: the signatures reproduce per seed`).toEqual(signatures);
      // The perturbation genuinely moves the command's own centre (the field the `single` shader honours).
      for (const seed of DISCOVERY_SEEDS) {
        const command = transitionEntryGenesis(document, transition, seed, prior)!;
        expect(command.kind).toBe(base.kind);
        expect(command.mode).toBe('replace');
        expect(command.center).not.toEqual(base.center);
        expect(Math.abs(command.radiusCells - base.radiusCells)).toBeGreaterThan(0);
      }
    }
  });

  it('enforces the §6.4 rebirth displacement from the prior origin', () => {
    for (const transition of entryEdges) {
      const base = transition.destinationGenesis!;
      // A prior origin at the entry's own base centre forces the projection to engage.
      const prior: Vec2 = [base.center[0], base.center[1]];
      for (const seed of DISCOVERY_SEEDS) {
        const command = transitionEntryGenesis(document, transition, seed, prior)!;
        expect(
          toroidalDistanceUV(command.center, prior),
          `${transition.id} seed ${seed}: displaced from the prior origin`,
        ).toBeGreaterThanOrEqual(MIN_REBIRTH_DISPLACEMENT - 1e-9);
      }
    }
  });

  it('returns null for a destination movement that declares no enterGenesis', () => {
    const connection = transitions.find((transition) => transition.destination.movement === 'connection')!;
    expect(connection.destinationGenesis).toBeNull();
    expect(transitionEntryGenesis(document, connection, 11_000_011, [0.5, 0.5])).toBeNull();
  });
});

describe('§6.5 descriptor reduction', () => {
  const sample = (t: number, occupied: number, activity: number): DescriptorSample => ({
    performanceSeconds: t,
    steps: t * 120,
    occupiedFraction: occupied,
    activity,
    changeRate: activity / 10,
    centroidUV: [0.5, 0.5],
  });

  it('reduces a series without collapsing it to a single score', () => {
    const samples = [sample(5, 0.1, 0.02), sample(10, 0.3, 0.04), sample(15, 0.2, 0.03)];
    const reduced = summarizeSamples(samples);
    expect(reduced.samples).toBe(3);
    expect(reduced.occupancy).toMatchObject({ min: 0.1, max: 0.3, first: 0.1, last: 0.2 });
    expect(reduced.occupancy.mean).toBeCloseTo(0.2, 9);
    expect(reduced.occupancyTrend).toBeCloseTo(0.1, 9);
    expect(reduced.activity.max).toBeCloseTo(0.04, 9);
    expect(reduced.changeRate.mean).toBeCloseTo(0.003, 9);
  });

  it('handles an empty series', () => {
    const reduced = summarizeSamples([]);
    expect(reduced.samples).toBe(0);
    expect(reduced.occupancy.mean).toBe(0);
    expect(reduced.occupancyTrend).toBe(0);
  });
});
