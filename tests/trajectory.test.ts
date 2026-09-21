/**
 * §6.2 schema/validation and §6.4 interpolation (AC.7).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRAJECTORY_LIMITS,
  TrajectoryValidationError,
  parseTrajectoryDocument,
  serializeTrajectoryDocument,
  validateTrajectoryDocument,
} from '../src/curator/schema.ts';
import {
  DEFAULT_CROSSFADE_SECONDS,
  advanceProgress,
  blendTuple,
  effectiveDurationSeconds,
  evaluateMovement,
  evaluateWaypoints,
  smootherstep,
  tupleFromParams,
} from '../src/curator/trajectory.ts';

const DEFAULT_PATH = resolve('public/trajectories/default.json');
const DEFAULT_TEXT = readFileSync(DEFAULT_PATH, 'utf8');

function defaultDoc(): any {
  return JSON.parse(DEFAULT_TEXT);
}

function expectReject(mutate: (doc: any) => void, pattern: RegExp | string): void {
  const doc = defaultDoc();
  mutate(doc);
  expect(() => validateTrajectoryDocument(doc)).toThrow(TrajectoryValidationError);
  let message = '';
  try {
    validateTrajectoryDocument(doc);
  } catch (error) {
    message = (error as Error).message;
  }
  if (typeof pattern === 'string') expect(message).toContain(pattern);
  else expect(message).toMatch(pattern);
}

describe('trajectory document: valid parse', () => {
  it('parses the shipped §6.3 candidate verbatim', () => {
    const document = parseTrajectoryDocument(DEFAULT_TEXT);
    expect(document.version).toBe(1);
    expect(document.id).toBe('organism-01-candidate');
    expect(document.nominalStepsPerSecond).toBe(120);
    expect(document.dt).toBe(1);
    expect(document.durationScaleRange).toEqual([0.75, 1.25]);
    expect(document.parameterJitter).toEqual({ F: 0.0004, k: 0.0004, correlationSeconds: 60 });
    expect(document.movements.map((movement) => movement.id)).toEqual([
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
  });

  it('encodes the corrected 980 s / 950 s arc semantics', () => {
    const document = parseTrajectoryDocument(DEFAULT_TEXT);
    const byId = new Map(document.movements.map((movement) => [movement.id, movement] as const));
    // Nominal first arc: dormancy through stillness (rebirth belongs to the next arc).
    const firstArcIds = [
      'dormancy',
      'nucleation',
      'cellular-growth',
      'replication',
      'connection',
      'labyrinth',
      'overgrowth',
      'collapse',
      'stillness',
    ];
    const firstArc = firstArcIds.reduce((sum, id) => sum + byId.get(id)!.seconds, 0);
    expect(firstArc).toBe(980);

    const subsequentArcIds = [
      'rebirth',
      'cellular-growth',
      'replication',
      'connection',
      'labyrinth',
      'overgrowth',
      'collapse',
      'stillness',
    ];
    const subsequentArc = subsequentArcIds.reduce((sum, id) => sum + byId.get(id)!.seconds, 0);
    expect(subsequentArc).toBe(950);
  });

  it('round-trips through serialize -> parse', () => {
    const document = parseTrajectoryDocument(DEFAULT_TEXT);
    const re = parseTrajectoryDocument(serializeTrajectoryDocument(document));
    expect(re).toEqual(document);
  });

  it('accepts the top of the Du/Dv envelope (diffusion bound dt*max(Du,Dv)=.2 <= .25)', () => {
    const doc = defaultDoc();
    doc.movements[0].waypoints[1].p[2] = 0.2;
    doc.movements[0].waypoints[1].p[3] = 0.2;
    expect(() => validateTrajectoryDocument(doc)).not.toThrow();
  });
});

describe('trajectory document: every malformed category is rejected with a precise error', () => {
  it('wrong version', () => {
    expectReject((d) => (d.version = 2), /\$\.version/);
  });
  it('empty id', () => {
    expectReject((d) => (d.id = ''), /\$\.id/);
  });
  it('unknown top-level key', () => {
    expectReject((d) => (d.bogus = 1), /unknown key 'bogus'/);
  });
  it('nominalStepsPerSecond not 120', () => {
    expectReject((d) => (d.nominalStepsPerSecond = 60), /\$\.nominalStepsPerSecond/);
  });
  it('dt not 1', () => {
    expectReject((d) => (d.dt = 0.5), /\$\.dt/);
  });
  it('durationScaleRange inverted', () => {
    expectReject((d) => (d.durationScaleRange = [1.25, 0.75]), /durationScaleRange\[1\]/);
  });
  it('parameterJitter correlation <= 0', () => {
    expectReject((d) => (d.parameterJitter.correlationSeconds = 0), /correlationSeconds/);
  });
  it('unknown genesis kind', () => {
    expectReject((d) => (d.genesisLibrary.first.kind = 'blob'), /unknown genesis kind/);
  });
  it('genesis center out of range', () => {
    expectReject((d) => (d.genesisLibrary.first.center = [1.4, 0.5]), /center\[0\]/);
  });
  it('genesis strength out of range', () => {
    expectReject((d) => (d.genesisLibrary.first.strength = 1.5), /strength/);
  });
  it('no movements', () => {
    expectReject((d) => (d.movements = []), /\$\.movements/);
  });
  it('unknown intention', () => {
    expectReject((d) => (d.movements[0].intention = 'dance'), /unknown intention/);
  });
  it('unknown exit hint', () => {
    expectReject((d) => (d.movements[1].exitHint = 'sparkly'), /unknown exitHint/);
  });
  it('unknown movement key', () => {
    expectReject((d) => (d.movements[0].bogus = true), /unknown key 'bogus'/);
  });
  it('first waypoint not at 0', () => {
    expectReject((d) => (d.movements[0].waypoints[0].at = 0.1), /must be at 0/);
  });
  it('last waypoint not at 1', () => {
    expectReject((d) => (d.movements[0].waypoints[1].at = 0.9), /must be at 1/);
  });
  it('not strictly ascending', () => {
    expectReject((d) => {
      d.movements[0].waypoints = [
        { at: 0, p: [0.026, 0.06, 0.16, 0.08] },
        { at: 0.5, p: [0.026, 0.06, 0.16, 0.08] },
        { at: 0.5, p: [0.026, 0.06, 0.16, 0.08] },
        { at: 1, p: [0.026, 0.06, 0.16, 0.08] },
      ];
    }, /strictly ascending/);
  });
  it('fewer than 2 waypoints', () => {
    expectReject((d) => (d.movements[0].waypoints = [{ at: 0, p: [0.026, 0.06, 0.16, 0.08] }]), /at least 2 waypoints/);
  });
  it('duplicate movement id', () => {
    expectReject((d) => (d.movements[1].id = 'dormancy'), /duplicate movement id/);
  });
  it('unresolvable next edge', () => {
    expectReject((d) => (d.movements[0].next = ['nowhere']), /unresolvable movement reference/);
  });
  it('unresolvable enterGenesis', () => {
    expectReject((d) => (d.movements[1].enterGenesis = 'ghost'), /unresolvable genesis reference/);
  });
  it('non-finite parameter', () => {
    expectReject((d) => (d.movements[0].waypoints[1].p[0] = Number.POSITIVE_INFINITY), /finite number/);
  });
  it('F outside the safety envelope', () => {
    expectReject((d) => (d.movements[0].waypoints[1].p[0] = 0.2), /F=0.2 outside safety envelope/);
  });
  it('k outside the safety envelope', () => {
    expectReject((d) => (d.movements[0].waypoints[1].p[1] = 0.2), /k=0.2 outside safety envelope/);
  });
  it('Du must be strictly positive', () => {
    expectReject((d) => (d.movements[0].waypoints[1].p[2] = 0), /Du=0 outside safety envelope/);
  });
  it('Dv beyond the envelope', () => {
    expectReject((d) => (d.movements[0].waypoints[1].p[3] = 0.25), /Dv=0.25 outside safety envelope/);
  });
  it('empty next edge list', () => {
    expectReject((d) => (d.movements[0].next = []), /at least one outgoing edge/);
  });
  it('more than 64 movements', () => {
    expectReject((d) => {
      const template = d.movements[0];
      d.movements = Array.from({ length: TRAJECTORY_LIMITS.maxMovements + 1 }, (_, i) => ({
        ...JSON.parse(JSON.stringify(template)),
        id: `m${i}`,
        next: ['m0'],
      }));
    }, /movements/);
  });
  it('more than 64 waypoints', () => {
    expectReject((d) => {
      const points = Array.from({ length: TRAJECTORY_LIMITS.maxWaypointsPerMovement + 1 }, (_, i) => ({
        at: i / TRAJECTORY_LIMITS.maxWaypointsPerMovement,
        p: [0.026, 0.06, 0.16, 0.08],
      }));
      d.movements[0].waypoints = points;
    }, /waypoints/);
  });
  it('imports larger than 1 MiB are refused before parsing', () => {
    const huge = `{"pad":"${'x'.repeat(TRAJECTORY_LIMITS.maxBytes)}"}`;
    expect(() => parseTrajectoryDocument(huge)).toThrow(/exceeding the 1048576-byte limit/);
  });
  it('invalid JSON is refused without evaluation', () => {
    expect(() => parseTrajectoryDocument('{ not json')).toThrow(/not valid JSON/);
  });
});

describe('§6.4 interpolation', () => {
  it('smootherstep matches 6t^5-15t^4+10t^3, is bounded and monotone', () => {
    const reference = (t: number) => 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3;
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 12);
    let previous = -Infinity;
    for (let i = 0; i <= 1000; i += 1) {
      const t = i / 1000;
      const value = smootherstep(t);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeCloseTo(reference(t), 12);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });

  it('clamps outside [0, 1]', () => {
    expect(smootherstep(-3)).toBe(0);
    expect(smootherstep(4)).toBe(1);
  });

  it('hits waypoint endpoints exactly and interpolates the segment with the reference curve', () => {
    const waypoints = [
      { at: 0, p: [0, 0.01, 0.16, 0.08] as const },
      { at: 1, p: [0.1, 0.05, 0.16, 0.08] as const },
    ];
    expect(evaluateWaypoints(waypoints, 0)).toEqual([0, 0.01, 0.16, 0.08]);
    expect(evaluateWaypoints(waypoints, 1)).toEqual([0.1, 0.05, 0.16, 0.08]);
    expect(evaluateWaypoints(waypoints, -1)).toEqual([0, 0.01, 0.16, 0.08]);
    expect(evaluateWaypoints(waypoints, 2)).toEqual([0.1, 0.05, 0.16, 0.08]);

    const t = 0.25;
    const s = 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3;
    const expectedF = 0 + (0.1 - 0) * s;
    const expectedK = 0.01 + (0.05 - 0.01) * s;
    const mid = evaluateWaypoints(waypoints, t);
    expect(mid[0]).toBeCloseTo(expectedF, 12);
    expect(mid[1]).toBeCloseTo(expectedK, 12);
  });

  it('returns an interior waypoint exactly when t lands on it', () => {
    const waypoints = [
      { at: 0, p: [0, 0, 0.16, 0.08] as const },
      { at: 0.5, p: [1, 1, 0.16, 0.08] as const },
      { at: 1, p: [2, 2, 0.16, 0.08] as const },
    ];
    expect(evaluateWaypoints(waypoints, 0.5)).toEqual([1, 1, 0.16, 0.08]);
  });

  it('starts a transition from the actual current vector, not the first waypoint', () => {
    const spec = {
      id: 'm',
      seconds: 10,
      intention: 'expand' as const,
      waypoints: [
        { at: 0, p: [0.05, 0.05, 0.16, 0.08] as const },
        { at: 1, p: [0.09, 0.07, 0.16, 0.08] as const },
      ],
      next: ['m'],
    };
    const from = tupleFromParams({ F: 0.001, k: 0.001, Du: 0.16, Dv: 0.08 });

    // At the very start of a 15 s crossfade the output equals the actual current vector.
    const atStart = evaluateMovement({
      spec,
      progress: 0,
      transitionFrom: from,
      transitionElapsedSeconds: 0,
      transitionSeconds: DEFAULT_CROSSFADE_SECONDS,
    });
    expect(atStart.parameters.F).toBeCloseTo(0.001, 12);
    expect(atStart.parameters.k).toBeCloseTo(0.001, 12);

    // Halfway through the window it is strictly between the current vector and the path.
    const half = evaluateMovement({
      spec,
      progress: 0.75,
      transitionFrom: from,
      transitionElapsedSeconds: DEFAULT_CROSSFADE_SECONDS / 2,
      transitionSeconds: DEFAULT_CROSSFADE_SECONDS,
    });
    expect(half.parameters.F).toBeGreaterThan(0.001);
    expect(half.parameters.F).toBeLessThan(evaluateMovement({ spec, progress: 0.75 }).parameters.F + 1e-9);

    // After the window it tracks the path exactly.
    const after = evaluateMovement({
      spec,
      progress: 1,
      transitionFrom: from,
      transitionElapsedSeconds: DEFAULT_CROSSFADE_SECONDS,
      transitionSeconds: DEFAULT_CROSSFADE_SECONDS,
    });
    const pathOnly = evaluateMovement({ spec, progress: 1 });
    expect(after.parameters).toEqual(pathOnly.parameters);
  });

  it('advanceProgress is monotone non-decreasing under alternating rate and duration targets', () => {
    // The retrospective formula `elapsed * rate / duration` would move progress backward whenever
    // the rate dropped; increment accumulation must not. Alternate a 1.2/0.8 rate against an
    // 8 s/12 s duration target and require non-decreasing progress throughout.
    let progress = 0;
    let previous = -1;
    for (let i = 0; i < 400; i += 1) {
      const rate = i % 2 === 0 ? 1.2 : 0.8;
      const duration = i % 2 === 0 ? 8 : 12;
      progress = advanceProgress(progress, 0.1, rate, duration);
      expect(progress).toBeGreaterThanOrEqual(previous);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
      previous = progress;
    }
    expect(progress).toBe(1);

    // Demonstrate the failure mode this replaces: applying the *current* rate to the same elapsed
    // time gives a strictly smaller number after a 1.2 -> 0.8 drop.
    const elapsed = 3;
    expect((elapsed * 0.8) / 10).toBeLessThan((elapsed * 1.2) / 10);

    // Guards: no increment for dt = 0, and the value saturates at 1.
    expect(advanceProgress(0.4, 0, 1.3, 10)).toBe(0.4);
    expect(advanceProgress(1, 0.5, 1.3, 10)).toBe(1);
  });

  it('effectiveDurationSeconds scales the nominal duration', () => {
    const spec = {
      id: 'm',
      seconds: 40,
      intention: 'expand' as const,
      waypoints: [
        { at: 0, p: [0, 0, 0.16, 0.08] as const },
        { at: 1, p: [0.1, 0.1, 0.16, 0.08] as const },
      ],
      next: ['m'],
    };
    expect(effectiveDurationSeconds(spec)).toBe(40);
    expect(effectiveDurationSeconds(spec, 1)).toBe(40);
    expect(effectiveDurationSeconds(spec, 1.25)).toBeCloseTo(50, 10);
  });

  it('blendTuple spans a→b monotonically', () => {
    const a = tupleFromParams({ F: 0, k: 0, Du: 0.16, Dv: 0.08 });
    const b = tupleFromParams({ F: 0.1, k: 0.09, Du: 0.16, Dv: 0.08 });
    expect(blendTuple(a, b, 0)).toEqual(a);
    expect(blendTuple(a, b, 1)).toEqual(b);
    let previous = -Infinity;
    for (let i = 0; i <= 10; i += 1) {
      const value = blendTuple(a, b, i / 10)[0];
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});
