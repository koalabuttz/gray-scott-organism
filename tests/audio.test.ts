/**
 * §8 audio engine unit tests (Phase 3B review fixes).
 *
 * Node has no Web Audio implementation, so these tests drive the real `AudioEngine` against the
 * recording fake in `tests/support/fake-audio.ts`. That is what makes the *state-machine* findings
 * (MAJOR 1/2/4) and the *graph-shape* finding (MINOR 5) unit-testable without a device, while the
 * browser `audio-offline.spec.ts` still renders the same code through a real `OfflineAudioContext`.
 *
 * Covered here:
 *  - MINOR 5  exactly three event band-passes at f/2f/3f, Q = 8.
 *  - MAJOR 2  locked→running activation fades from exact zero, baselines the event serial, resets debt.
 *  - MAJOR 1  a fresh-performance abort cancels a stale fade (before the first tick and mid-fade),
 *             clears the acknowledgement, and the next kill-wait takes exactly one fresh fade.
 *  - MAJOR 4  grains are spread across the lookahead window; stalls and resumes drop overdue debt.
 *  - MAJOR 3  the §4.4 sound substream is derived deterministically from the root seed.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO } from '../src/config.ts';
import { AudioEngine } from '../src/audio/audio.ts';
import { createImpulseResponse, createNoiseBuffer } from '../src/audio/buffers.ts';
import { syntheticWorld } from '../src/audio/offline.ts';
import { deriveSoundSeeds } from '../src/audio/substream.ts';
import { EVENT_RATIOS } from '../src/audio/voices.ts';
import type { EventState, WorldState } from '../src/core/types.ts';
import { FakeAudioContext, type FakeAudioParam, asBaseAudioContext } from './support/fake-audio.ts';

/** An active-field presentation sample rich enough to drive every control (grains included). */
const ACTIVE_PRESENTATION = {
  valid: true as const,
  occupiedFraction: 0.32,
  reactionActivity: 0.022,
  edgeDensity: 0.11,
  featureScaleUV: 0.12,
  spectralBands: [0.4, 0.3, 0.2, 0.1] as [number, number, number, number],
  beta0Approx: 3,
  largestComponentFraction: 0.62,
  topologyConfidence: 0.7,
  coherence: 0.45,
};

/** The graph's master gain, viewed as the recording fake so its automation can be asserted. */
function masterParam(engine: AudioEngine): FakeAudioParam {
  return engine.graph.master.gain as unknown as FakeAudioParam;
}

function worldFor(
  presentation: Record<string, unknown> = {},
  extra: {
    event?: Partial<EventState>;
    phase?: Partial<WorldState['phase']>;
    performanceSeconds?: number;
  } = {},
): WorldState {
  return syntheticWorld({ ...ACTIVE_PRESENTATION, ...presentation }, extra);
}

/** A dying field (every presentation signal below the off thresholds) — the real `kill-wait` shape. */
const QUIET_PRESENTATION = {
  occupiedFraction: 0,
  reactionActivity: 0,
  edgeDensity: 0,
  featureScaleUV: 0,
  spectralBands: [0, 0, 0, 0] as [number, number, number, number],
  beta0Approx: 0,
  largestComponentFraction: 0,
  coherence: 0,
};

/** Build a byte/float comparable array from a buffer channel. */
function channelData(buffer: AudioBuffer, channel: number): number[] {
  return Array.from(buffer.getChannelData(channel));
}

describe('§8.2 event subgraph (MINOR 5)', () => {
  it('declares exactly the three drone-independent ratios f/2f/3f', () => {
    expect(EVENT_RATIOS).toEqual([1, 2, 3]);
    expect(EVENT_RATIOS).toHaveLength(3);
  });

  it('spawns exactly three band-pass resonators at f/2f/3f with Q = 8', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    const before = context.filters.length;

    engine.graph.spawnEvent(10, { fundamentalHz: 50, level: 0.1 });

    const created = context.filtersSince(before);
    expect(created, 'one event creates three resonators, not four').toHaveLength(3);
    expect(created.every((filter) => filter.type === 'bandpass')).toBe(true);
    expect(created.map((filter) => filter.frequency.value)).toEqual([50, 100, 150]);
    expect(created.every((filter) => filter.Q.value === 8)).toBe(true);
    engine.dispose();
  });
});

describe('§2.3 activation edge (MAJOR 2)', () => {
  it('fades the master up from exact zero and baselines the retained event serial', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false, rootSeed: 1 });

    // A pre-activation event serial is already published (the field saw a merge while locked).
    engine.consume(worldFor({}, { event: { serial: 7, kind: 'merge', strength: 0.8 } }));

    context.currentTime = 2;
    engine.setUnlocked(true);
    const master = masterParam(engine);
    // The fade is anchored at exactly zero and rises over a bounded 3–5 s window.
    expect(master.events[0]).toMatchObject({ kind: 'set', value: 0, time: 2 });
    const ramp = master.events.find((event) => event.kind === 'linear');
    expect(ramp).toMatchObject({ value: AUDIO.masterLevel, time: 2 + AUDIO.activationFadeSeconds });
    expect(AUDIO.activationFadeSeconds).toBeGreaterThanOrEqual(3);
    expect(AUDIO.activationFadeSeconds).toBeLessThanOrEqual(5);

    // The retained serial 7 does not excite on the first tick.
    engine.consume(worldFor({}, { event: { serial: 7, kind: 'merge', strength: 0.8 } }));
    engine.tick(2.05);
    expect(engine.graph.stats().eventsFired, 'no pre-activation replay').toBe(0);

    // The next published serial fires exactly once.
    engine.consume(worldFor({}, { event: { serial: 8, kind: 'merge', strength: 0.8 } }));
    engine.tick(2.1);
    expect(engine.graph.stats().eventsFired).toBe(1);
    engine.consume(worldFor({}, { event: { serial: 8, kind: 'merge', strength: 0.8 } }));
    engine.tick(2.15);
    expect(engine.graph.stats().eventsFired, 'a serial excites once').toBe(1);
    engine.dispose();
  });

  it('stays silent when activation lands during armed stillness', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false });
    engine.consume(worldFor({}, { phase: { stillnessState: 'kill-wait' } }));

    context.currentTime = 1;
    engine.prepareSilence();
    expect(engine.stats().armed).toBe(true);

    context.currentTime = 1.5;
    engine.setUnlocked(true);
    // No fade-up: the master is only cancelled and held at its current (locked: zero) level.
    expect(masterParam(engine).events.some((event) => event.kind === 'linear')).toBe(false);
    engine.dispose();
  });
});

describe('§8.3 fresh-performance abort (MAJOR 1)', () => {
  it('cancels a fade aborted before the first tick observes it', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 5 });
    engine.consume(worldFor());
    context.currentTime = 1;
    engine.tick(1);

    engine.prepareSilence(1);
    expect(engine.stats().armed).toBe(true);
    expect(engine.stats().phase).toBe('fading');
    const oldDeadline = 1 + AUDIO.fadeSeconds;

    // Abort at 1.02 s — 20 ms later, before the next scheduled tick — for a fresh performance.
    context.currentTime = 1.02;
    engine.resetPerformance(1.02, 9);

    const stats = engine.stats();
    expect(stats.armed, 'the stale acknowledgement is cleared').toBe(false);
    expect(stats.phase, 'the abandoned fade is gone').toBe('live');
    expect(stats.terminalZeroAt).toBeNull();
    // The stale terminal deadline cannot silence the fresh performance.
    expect(masterParam(engine).eventsAtOrAfter(oldDeadline)).toHaveLength(0);
    // The new master transition is a fade up to the live level.
    expect(
      masterParam(engine).events.some(
        (event) => event.kind === 'linear' && event.value === AUDIO.masterLevel,
      ),
    ).toBe(true);

    // Tick well past the old deadline with a living field: the fresh performance keeps sounding.
    for (let t = 1.05; t <= 12; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().phase).not.toBe('silent');
    expect(engine.graph.stats().grainsStarted).toBeGreaterThan(0);
    engine.dispose();
  });

  it('cancels a fade aborted mid-way', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 6 });
    context.currentTime = 0;
    engine.consume(worldFor());
    engine.tick(0);
    engine.prepareSilence(0);
    const oldDeadline = AUDIO.fadeSeconds;
    // Advance to the middle of the fade.
    for (let t = 0.05; t <= 4; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().phase).toBe('fading');

    context.currentTime = 4;
    engine.resetPerformance(4, 10);
    expect(engine.stats().phase).toBe('live');
    expect(engine.stats().armed).toBe(false);
    // No surviving terminal-zero event at the abandoned deadline (the new fade-up ends there at the
    // live level, so match on the zero value, not on the timestamp).
    expect(
      masterParam(engine).eventsAtOrAfter(oldDeadline).some((event) => event.value === 0),
    ).toBe(false);

    for (let t = 4.05; t <= 10; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().phase).not.toBe('silent');
    engine.dispose();
  });

  it('lets the next kill-wait take exactly one fresh fade', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 7 });
    engine.consume(worldFor());
    context.currentTime = 1;
    engine.tick(1);
    engine.prepareSilence(1);
    context.currentTime = 1.02;
    engine.resetPerformance(1.02, 8);
    expect(engine.stats().armed).toBe(false);

    const zeroRampsBefore = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === 0,
    ).length;

    // A new episode opens: the app issues prepareSilence() once on the kill-wait edge. `kill-wait`
    // carries a dying field, so the still-world is the quiet presentation.
    context.currentTime = 5;
    engine.consume(worldFor(QUIET_PRESENTATION, { phase: { stillnessState: 'kill-wait' } }));
    engine.tick(5);
    engine.prepareSilence(5);
    expect(engine.stats().armed).toBe(true);
    expect(engine.stats().phase).toBe('fading');

    // A second prepareSilence() inside the same episode is idempotent.
    engine.prepareSilence(5.5);
    const zeroRamps = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === 0,
    );
    expect(zeroRamps.length - zeroRampsBefore, 'one fresh fade, not two').toBe(1);

    // And it reaches terminal zero at the fresh deadline (a dying field never wakes it back up).
    for (let t = 5.05; t <= 20; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(QUIET_PRESENTATION, { phase: { stillnessState: 'kill-wait' } }));
      engine.tick(t);
    }
    expect(engine.stats().phase).toBe('silent');
    expect(engine.stats().terminalZeroAt).not.toBeNull();
    engine.dispose();
  });
});

describe('§8.3 terminal-fade envelope (review MAJOR 1)', () => {
  it('fades from the tracked level, not the stale AudioParam.value, and reaches zero only at the deadline', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 2 });
    // The offline driver queues the whole timeline against future explicit times and never advances the
    // context clock, so `master.gain.value` stays at its intrinsic 0 for the entire run (the fake is
    // faithful about this: scheduling never updates `value`).
    for (let t = 0; t <= AUDIO.offSeconds + AUDIO.fadeSeconds + 6; t += AUDIO.tickMs / 1000) {
      engine.consume(worldFor(QUIET_PRESENTATION));
      engine.tick(t);
    }
    expect(masterParam(engine).value, 'the intrinsic AudioParam.value is stale at 0').toBe(0);

    const stats = engine.stats();
    // Quiet for AUDIO.offSeconds, then a real AUDIO.fadeSeconds ramp: fade start ≈ offSeconds, zero ≈ off+fade.
    expect(stats.fadeStartedAt, 'the fade begins at the off threshold, not immediately').not.toBeNull();
    expect(stats.fadeStartedAt!).toBeGreaterThan(AUDIO.offSeconds - 0.2);
    expect(stats.fadeStartedAt!).toBeLessThan(AUDIO.offSeconds + 0.2);
    expect(
      engine.graph.masterLevelAt(AUDIO.offSeconds),
      'the master is still live at the fade start (no instant cut)',
    ).toBeCloseTo(AUDIO.masterLevel, 3);
    expect(stats.terminalZeroAt, 'terminal zero is recorded at the deadline, not the fade start').not.toBeNull();
    expect(stats.terminalZeroAt!).toBeGreaterThan(AUDIO.offSeconds + AUDIO.fadeSeconds - 0.3);
    expect(engine.silencePhase).toBe('silent');
    engine.dispose();
  });
});

describe('§8.3 restart de-click (review MAJOR 2)', () => {
  it('holds the live level and ramps to zero before reseeding, so a restart never hard-cuts', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 11 });
    // Drive to steady, live output.
    for (let t = 0; t <= 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    const oldRoot = engine.soundSignature().root;

    const restartAt = 2;
    context.currentTime = restartAt;
    engine.resetPerformance(restartAt, 22);

    // The master holds the live level, ramps to zero over the de-click window and rises back: continuous.
    expect(engine.graph.masterLevelAt(restartAt), 'the restart holds the live level').toBeCloseTo(
      AUDIO.masterLevel,
      6,
    );
    const step = 0.001;
    let maxStep = 0;
    let prev = engine.graph.masterLevelAt(restartAt);
    const horizon = restartAt + AUDIO.declickSeconds + AUDIO.activationFadeSeconds + 0.05;
    for (let t = restartAt + step; t <= horizon; t += step) {
      const v = engine.graph.masterLevelAt(t);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(maxStep, 'the master envelope is continuous (bounded slope), never a hard cut').toBeLessThan(0.02);
    expect(
      engine.graph.masterLevelAt(restartAt + AUDIO.declickSeconds),
      'it reaches exactly zero at the de-click end',
    ).toBe(0);
    expect(
      engine.graph.masterLevelAt(horizon),
      'the new performance returns to the live level',
    ).toBeCloseTo(AUDIO.masterLevel, 3);

    // The audible reseed is deferred to the zero instant: the old material is still live through the
    // de-click, and the new material lands exactly as the master reaches zero.
    expect(engine.soundSignature().root, 'no material change while the master is live').toBe(oldRoot);
    const flushAt = restartAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    expect(engine.soundSignature().root, 'the reseed lands while the master is at zero').toBe(22);
    expect(engine.stats().armed).toBe(false);
    engine.dispose();
  });

  it('de-clicks a restart landing mid-activation-fade without a step', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false, rootSeed: 3 });
    context.currentTime = 0;
    engine.setUnlocked(true); // locked→running: fadeMasterIn over activationFadeSeconds
    expect(engine.graph.masterLevelAt(0)).toBe(0);
    const mid = AUDIO.activationFadeSeconds / 2;
    const midLevel = engine.graph.masterLevelAt(mid);
    expect(midLevel, 'the activation fade is mid-way up').toBeGreaterThan(0.1);

    context.currentTime = mid;
    engine.resetPerformance(mid, 4);
    expect(engine.graph.masterLevelAt(mid), 'the restart holds the mid-fade level').toBeCloseTo(midLevel, 6);

    const step = 0.001;
    let maxStep = 0;
    let prev = engine.graph.masterLevelAt(mid);
    const horizon = mid + AUDIO.declickSeconds + AUDIO.activationFadeSeconds + 0.05;
    for (let t = mid + step; t <= horizon; t += step) {
      const v = engine.graph.masterLevelAt(t);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(maxStep, 'no hard cut mid-activation-fade').toBeLessThan(0.02);
    engine.dispose();
  });
});

describe('§8.2 granular lookahead scheduling (MAJOR 4)', () => {
  const HORIZON = AUDIO.lookaheadMs / 1000;

  it('spreads each tick’s grains across [now, now + lookahead] and never beyond it', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 3 });
    let seen = 0;
    for (let t = 0; t <= 10; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
      const starts = context.startTimes();
      for (const when of starts.slice(seen)) {
        expect(when, 'no grain is scheduled beyond the lookahead horizon').toBeLessThanOrEqual(
          t + HORIZON + 1e-9,
        );
        expect(when, 'no grain is scheduled in the past').toBeGreaterThanOrEqual(t - 1e-9);
      }
      seen = starts.length;
    }
    expect(seen, 'the granular layer did schedule grains').toBeGreaterThan(5);
    expect(engine.graph.liveNodes('grain')).toBeLessThanOrEqual(AUDIO.maxConcurrentGrains);
    engine.dispose();
  });

  it('drops overdue debt across a multi-second stall instead of batching', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 4 });
    for (let t = 0; t <= 0.25; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    const before = context.startTimes().length;

    // A 3.25 s stall: the cursor must resync to `now`, not release a batch at the resume timestamp.
    context.currentTime = 3.5;
    engine.consume(worldFor());
    engine.tick(3.5);
    const spawned = context.startTimes().slice(before);
    expect(spawned.length, 'a stalled tick spawns at most one grain').toBeLessThanOrEqual(1);
    for (const when of spawned) expect(when).toBeGreaterThanOrEqual(3.5 - 1e-9);
    // Nothing was scheduled inside the abandoned interval.
    expect(
      context.startTimes().some((when) => when > 0.26 && when < 3.5 - 1e-9),
      'no debt was replayed into the skipped window',
    ).toBe(false);
    engine.dispose();
  });

  it('drops debt on transport resume', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 5 });
    for (let t = 0; t <= 0.5; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    engine.setPaused(true);
    // Long paused span: nothing is emitted and no debt accumulates.
    const pausedAt = context.startTimes().length;
    for (let t = 1; t <= 18; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(context.startTimes().length, 'paused transport emits no grains').toBe(pausedAt);

    engine.setPaused(false);
    context.currentTime = 20;
    engine.consume(worldFor());
    engine.tick(20);
    const resumed = context.startTimes().slice(pausedAt);
    expect(resumed.length, 'no batch is released at the resume timestamp').toBeLessThanOrEqual(1);
    for (const when of resumed) expect(when).toBeGreaterThanOrEqual(20 - 1e-9);
    engine.dispose();
  });
});

describe('§4.4 sound substream (MAJOR 3)', () => {
  it('derives three distinct seeds per root and is deterministic', () => {
    const a = deriveSoundSeeds(1234);
    const b = deriveSoundSeeds(1234);
    const c = deriveSoundSeeds(1235);
    expect(a).toEqual(b);
    expect(a.root).toBe(1234);
    expect(new Set([a.noise, a.ir, a.grains]).size, 'the three seeds differ').toBe(3);
    expect(a.noise).not.toBe(c.noise);
    expect(a.grains).not.toBe(c.grains);
  });

  it('generates identical noise/IR buffers for the same seed and different ones otherwise', () => {
    const context = new FakeAudioContext();
    const base = asBaseAudioContext(context);
    expect(channelData(createNoiseBuffer(base, 0.05, 111), 0)).toEqual(
      channelData(createNoiseBuffer(base, 0.05, 111), 0),
    );
    expect(channelData(createNoiseBuffer(base, 0.05, 111), 0)).not.toEqual(
      channelData(createNoiseBuffer(base, 0.05, 112), 0),
    );
    const ir1 = createImpulseResponse(base, 0.2, 7);
    const ir2 = createImpulseResponse(base, 0.2, 7);
    const ir3 = createImpulseResponse(base, 0.2, 8);
    expect(channelData(ir1, 0)).toEqual(channelData(ir2, 0));
    expect(channelData(ir1, 1)).toEqual(channelData(ir2, 1));
    expect(channelData(ir1, 0)).not.toEqual(channelData(ir3, 0));
  });

  it('produces an identical grain schedule and material for the same root seed', () => {
    const run = (seed: number): { starts: { when: number; offset: number; duration: number | null }[]; checksum: number } => {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: seed });
      for (let t = 0; t <= 8; t += AUDIO.tickMs / 1000) {
        context.currentTime = t;
        engine.consume(worldFor());
        engine.tick(t);
      }
      const starts = context.bufferSources.flatMap((source) => source.starts);
      const checksum = engine.soundSignature().checksum;
      engine.dispose();
      return { starts, checksum };
    };
    const first = run(42);
    const again = run(42);
    const other = run(43);
    expect(first.starts.length).toBeGreaterThan(0);
    expect(first.starts, 'the same root seed yields the same grain schedule').toEqual(again.starts);
    expect(first.checksum).toBe(again.checksum);
    expect(first.starts, 'a different root seed yields different grain material').not.toEqual(other.starts);
    expect(first.checksum).not.toBe(other.checksum);
  });

  it('reseeds deterministically on a fresh performance', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    const before = engine.soundSignature();
    context.currentTime = 2;
    engine.resetPerformance(2, 77);
    // An audible restart defers the buffer/IR swap to the de-click's zero instant; it lands on the first
    // tick at or after it (MAJOR 2), so the swap happens while the master is at zero.
    const flushAt = 2 + AUDIO.declickSeconds + 0.01;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    const after = engine.soundSignature();
    expect(after.root).toBe(77);
    expect(after.checksum).not.toBe(before.checksum);
    // A fresh engine with the same root seed has identical material.
    const fresh = new AudioEngine(asBaseAudioContext(new FakeAudioContext()), {
      unlocked: true,
      rootSeed: 77,
    });
    expect(after).toEqual(fresh.soundSignature());
    engine.dispose();
    fresh.dispose();
  });
});
