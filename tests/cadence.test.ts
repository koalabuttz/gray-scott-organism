/**
 * Deviation 44 — the analysis/publication cadence under the new 3× presentation default.
 *
 * The tier-1 analysis request and the `WorldState` publication are scheduled on delivered
 * *performance* time at 2 Hz, but only once at least `1 / CADENCE.realCeilingHz` of *real* time has
 * elapsed (deviation 43, `app.ts` `pollAnalysis` / the publish gate). At the presentation default of
 * 3× (deviation 44) the 2 Hz performance schedule would ask for 6 Hz of real sampling, which exceeds
 * the explicit 4 Hz real ceiling — so the ceiling binds and the delivered spacing stretches from
 * 0.5 to 0.75 performance seconds. This test pins that arithmetic against the curator's 1.5
 * performance-second freshness window (`CURATOR_DEFAULTS.freshAnalysisSeconds`), so "the feedback
 * stays live at 3×" is a checked claim rather than a comment.
 *
 * The accumulator logic below is a faithful model of the two-line gate in `app.ts` (advance both
 * accumulators by the frame's deltas, fire only when *both* thresholds are met, then reset both). The
 * real gate quantizes every fire to a whole real frame, so spacings are compared with a tolerance of
 * two frames of performance time rather than bit-exactly.
 */
import { describe, expect, it } from 'vitest';
import { CADENCE, TIME } from '../src/config.ts';
import { CURATOR_DEFAULTS } from '../src/curator/curator.ts';

const PERFORMANCE_HZ = CADENCE.performanceHz;
const REAL_CEILING_HZ = CADENCE.realCeilingHz;
const FRESH_SECONDS = CURATOR_DEFAULTS.freshAnalysisSeconds;
const REAL_HZ = 60;

interface Fire {
  /** Delivered performance seconds at the moment the sample fired. */
  performanceSeconds: number;
  /** Real seconds at the moment the sample fired. */
  realSeconds: number;
}

/** Run the exact publish/analysis gate at a fixed real frame rate and return the fire times. */
function fires(speed: number, realSeconds = 60): Fire[] {
  const frames = Math.round(REAL_HZ * realSeconds);
  const realDelta = 1 / REAL_HZ;
  const performanceDelta = speed * realDelta; // non-overloaded: steps == speed * nominal * realDelta
  let performanceAccumulator = 0;
  let realSinceFire = 0;
  let performanceSeconds = 0;
  let realSecondsElapsed = 0;
  const out: Fire[] = [];
  for (let i = 0; i < frames; i += 1) {
    performanceAccumulator += performanceDelta;
    realSinceFire += realDelta;
    performanceSeconds += performanceDelta;
    realSecondsElapsed += realDelta;
    if (
      performanceAccumulator >= 1 / PERFORMANCE_HZ &&
      realSinceFire >= 1 / REAL_CEILING_HZ
    ) {
      performanceAccumulator = 0;
      realSinceFire = 0;
      out.push({ performanceSeconds, realSeconds: realSecondsElapsed });
    }
  }
  return out;
}

function meanSpacing(list: Fire[], key: keyof Fire): number {
  const deltas = list.slice(1).map((f, i) => f[key] - list[i]![key]);
  return deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
}

/** Two real frames of performance time — the granularity of the real gate. */
function frameTolerance(speed: number): number {
  return (2 * speed) / REAL_HZ + 1e-9;
}

describe('analysis/publication cadence at the 3× presentation default (deviation 44)', () => {
  it('requests 6 Hz real at 3×, above the 4 Hz real ceiling, so the ceiling binds', () => {
    const requestedHz = PERFORMANCE_HZ * TIME.defaultSpeed;
    expect(TIME.defaultSpeed).toBe(3);
    expect(requestedHz).toBe(6);
    expect(requestedHz).toBeGreaterThan(REAL_CEILING_HZ);
  });

  it('delivers one sample every 0.75 performance seconds at 3× — inside the 1.5 s freshness window', () => {
    // Analytic identity: the real ceiling delivers one sample every 1/realCeilingHz real seconds,
    // which at `speed` is `speed / realCeilingHz` performance seconds.
    const performanceSecondsPerSample = TIME.defaultSpeed / REAL_CEILING_HZ;
    expect(performanceSecondsPerSample).toBeCloseTo(0.75, 12);
    expect(performanceSecondsPerSample).toBeLessThan(FRESH_SECONDS);

    // And the model of the gate agrees (within the one/two-frame real-gate granularity).
    const at3x = fires(TIME.defaultSpeed);
    expect(at3x.length).toBeGreaterThan(0);
    const performanceSpacing = meanSpacing(at3x, 'performanceSeconds');
    expect(Math.abs(performanceSpacing - 0.75)).toBeLessThanOrEqual(frameTolerance(TIME.defaultSpeed));
    // Real spacing is exactly the ceiling period (4 Hz).
    expect(Math.abs(meanSpacing(at3x, 'realSeconds') - 1 / REAL_CEILING_HZ))
      .toBeLessThanOrEqual(frameTolerance(TIME.defaultSpeed) / TIME.defaultSpeed);
    // The delivered sample is younger than the freshness window, so feedback stays live.
    expect(performanceSpacing).toBeLessThan(FRESH_SECONDS);
  });

  it('leaves 1× behaviour unchanged (2 Hz performance; the real ceiling never binds)', () => {
    const at1x = fires(1);
    const performanceSpacing = meanSpacing(at1x, 'performanceSeconds');
    expect(Math.abs(performanceSpacing - 1 / PERFORMANCE_HZ)).toBeLessThanOrEqual(frameTolerance(1));
    expect(performanceSpacing).toBeLessThan(FRESH_SECONDS);
    // At 1× the performance schedule is the binding constraint: the real spacing equals the
    // performance spacing (0.5 s), so the 4 Hz real gate is satisfied without ever stretching it.
    const realSpacing = meanSpacing(at1x, 'realSeconds');
    expect(Math.abs(realSpacing - 0.5)).toBeLessThanOrEqual(frameTolerance(1));
    expect(realSpacing).toBeGreaterThan(1 / REAL_CEILING_HZ);
  });

  it('at the 6× ceiling the window is exactly satisficed — 1.5 performance seconds == the freshness window', () => {
    // This is why the 4 Hz real ceiling exists: without it 6× would sample at 12 Hz real; with it the
    // delivered spacing is exactly the curator's freshness window, so 6× is the documented edge and
    // 3× (the default) keeps a factor-of-two margin.
    const top = TIME.speedRange[1];
    const performanceSecondsPerSample = top / REAL_CEILING_HZ;
    expect(performanceSecondsPerSample).toBeCloseTo(FRESH_SECONDS, 12);
    expect(Math.abs(meanSpacing(fires(top), 'performanceSeconds') - FRESH_SECONDS))
      .toBeLessThanOrEqual(frameTolerance(top));
  });
});
