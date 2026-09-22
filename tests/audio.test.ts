/**
 * §8 audio engine unit tests (Phase 3).
 *
 * Node has no Web Audio implementation, so these tests drive the real `AudioEngine` against the
 * recording fake in `tests/support/fake-audio.ts`. That is what makes the *state-machine* findings and
 * the *graph-shape* findings unit-testable without a device, while the browser `audio-offline.spec.ts`
 * still renders the same code through a real `OfflineAudioContext`.
 *
 * Covered here:
 *  - §3  the three-partial porcelain bloom (not the old Q = 8 noise-burst subgraph).
 *  - §6  the presence/reveal state machine: confirmation, hysteresis/chatter, dormancy activation,
 *        general-fade reversal, stillness irreversibility, reset/rebirth.
 *  - §8.3 terminal fades from the tracked level and the de-clicked fresh-performance abort.
 *  - §8.2 granular lookahead scheduling, stall/resume debt drops and the ≤ 4 grain bound.
 *  - §4.4 the sound substream is derived deterministically from the root seed.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO } from '../src/config.ts';
import { AudioEngine } from '../src/audio/audio.ts';
import { createImpulseResponse, createNoiseBuffer } from '../src/audio/buffers.ts';
import { syntheticWorld } from '../src/audio/offline.ts';
import { deriveSoundSeeds } from '../src/audio/substream.ts';
import {
  activityForX,
  bandOf,
  bloomBaseHz,
  deriveAudioControls,
  voicingCarriers,
} from '../src/audio/voices.ts';
import type { EventState, WorldState } from '../src/core/types.ts';
import { FakeAudioContext, FakeAudioParam, asBaseAudioContext } from './support/fake-audio.ts';

/** An active-field presentation sample rich enough to drive every control. */
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
  supportFraction: 0.9,
};

/** §4 a mature fine-detail field: enough detail to schedule grains at the top of the rate band. */
const GRANULAR_PRESENTATION = {
  spectralBands: [0.2, 0.1, 0.1, 0.9] as [number, number, number, number],
  edgeDensity: 0.3,
  occupiedFraction: 0.3,
  reactionActivity: 0.02,
  largestComponentFraction: 0.6,
  beta0Approx: 1,
};

/** The graph's master gain, viewed as the recording fake so its automation can be asserted. */
function masterParam(engine: AudioEngine): FakeAudioParam {
  return engine.graph.master.gain as unknown as FakeAudioParam;
}

/** A pad voice's gain, as the recording fake (MAJOR 1 source-silencing assertions). */
function voiceParam(engine: AudioEngine, index: number): FakeAudioParam {
  return engine.graph.voices[index]!.gain.gain as unknown as FakeAudioParam;
}

/** The texture bus gain, as the recording fake. */
function textureParam(engine: AudioEngine): FakeAudioParam {
  return engine.graph.textureGain.gain as unknown as FakeAudioParam;
}

/** The event bus gain, as the recording fake. */
function eventParam(engine: AudioEngine): FakeAudioParam {
  return engine.graph.eventGain.gain as unknown as FakeAudioParam;
}

/** A pad voice's **frequency** param, as the recording fake (the TAKE-4 pitch path). */
function voiceFreqParam(engine: AudioEngine, index: number): FakeAudioParam {
  return engine.graph.voices[index]!.oscillator.frequency as unknown as FakeAudioParam;
}

/** Every `worldFor()` call carries a *fresh* sample mark, so support confirmation can advance. */
let sampleSeq = 0;
function worldFor(
  presentation: Record<string, unknown> = {},
  extra: {
    event?: Partial<EventState>;
    phase?: Partial<WorldState['phase']>;
    performanceSeconds?: number;
    sampleSeconds?: number;
  } = {},
): WorldState {
  return syntheticWorld(
    { ...ACTIVE_PRESENTATION, ...presentation },
    { sampleSeconds: sampleSeq++, ...extra },
  );
}

/** A dying field (every presentation signal below the off thresholds, no support) — the `kill-wait` shape. */
const QUIET_PRESENTATION = {
  occupiedFraction: 0,
  reactionActivity: 0,
  edgeDensity: 0,
  featureScaleUV: 0,
  spectralBands: [0, 0, 0, 0] as [number, number, number, number],
  beta0Approx: 0,
  largestComponentFraction: 0,
  coherence: 0,
  supportFraction: 0,
};

/** Build a byte/float comparable array from a buffer channel. */
function channelData(buffer: AudioBuffer, channel: number): number[] {
  return Array.from(buffer.getChannelData(channel));
}

describe('§3 porcelain bloom (deviation 58)', () => {
  it('declares three partials at [1, 2, 3] with amplitudes [0.72, 0.21, 0.07]', () => {
    expect(AUDIO.bloomPartialRatios).toEqual([1, 2, 3]);
    expect(AUDIO.bloomPartialAmplitudes).toEqual([0.72, 0.21, 0.07]);
  });

  it('spawns three sine partials — not three Q = 8 band-passes — from the engine-selected note', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    const oscBefore = context.oscillators.length;
    const filtersBefore = context.filters.length;

    // TAKE-4 §4: the engine hands over an exact scale note; the graph only builds the three partials.
    engine.graph.spawnEvent(10, { baseHz: 220, strength: 0.8 });

    const created = context.oscillators.slice(oscBefore);
    expect(created, 'one bloom creates three partials, not four').toHaveLength(3);
    expect(created.every((oscillator) => oscillator.type === 'sine')).toBe(true);
    expect(created.map((oscillator) => oscillator.frequency.value)).toEqual([220, 440, 660]);
    expect(context.filtersSince(filtersBefore), 'no resonant band-passes remain').toHaveLength(0);
    expect(engine.graph.stats().eventsFired).toBe(1);
    engine.dispose();
  });

  it('scales the partials from any in-key base note (all five degrees, both registers)', () => {
    for (const baseHz of [220, 247.5, 275, 330, 366.6666667, 440, 495, 550, 660, 733.3333333]) {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
      const oscBefore = context.oscillators.length;
      engine.graph.spawnEvent(10, { baseHz, strength: 0.5 });
      const created = context.oscillators.slice(oscBefore);
      expect(created.map((oscillator) => oscillator.frequency.value)).toEqual([baseHz, baseHz * 2, baseHz * 3]);
      engine.dispose();
    }
  });

  it('schedules a raised-cosine attack, exponential decay and a bounded terminal fade to zero', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    const gainsBefore = context.gains.length;
    engine.graph.spawnEvent(10, { baseHz: 220, strength: 1 });
    const env = context.gains.slice(gainsBefore)[0]!; // the fundamental partial's gain
    const attack = env.gain.events.find((event) => event.kind === 'curve')!;
    expect(attack.duration).toBeCloseTo(AUDIO.bloomAttackSeconds, 6);
    expect(attack.curve![0], 'the attack starts at exactly zero').toBeCloseTo(0, 9);
    // Peak gain = eventLevelMax · clamp(0.4 + 1, 0.4, 1) = 0.065, times the fundamental amplitude 0.72.
    expect(attack.curve![attack.curve!.length - 1]).toBeCloseTo(AUDIO.eventLevelMax * 0.72, 6);
    const decay = env.gain.events.find((event) => event.kind === 'target')!;
    expect(decay.tau).toBeCloseTo(AUDIO.bloomDecayTaus[0], 6);
    const fade = env.gain.events.find((event) => event.kind === 'linear')!;
    expect(fade.value).toBe(0);
    expect(fade.time).toBeCloseTo(10 + AUDIO.bloomTerminalFadeStart + AUDIO.bloomTerminalFadeSeconds, 6);
    engine.dispose();
  });
});

describe('§3/§4 (TAKE-5) value curves are scheduled from a clock-anchored time', () => {
  /**
   * The exact production repro shape: by the time `spawnEvent` runs, the engine's tick clock is ~13–21 ms
   * behind the audio clock, so the bloom was scheduled with `when` at/behind the clock. Chromium then
   * snapped the attack curve's start forward while the decay stayed at `when + attack` — strictly inside
   * the curve — and threw `NotSupportedError`, aborting that bloom's decay and its bounded terminal fade
   * (43 uncaught exceptions in a 120-minute soak; the bloom could hang at its attack peak).
   */
  it("places the bloom decay at the attack curve's real end when `when` is the clock instant", () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    context.currentTime = 10; // `when` is exactly the clock: inside the current render quantum
    const gainsBefore = context.gains.length;
    expect(() => engine.graph.spawnEvent(10, { baseHz: 220, strength: 1 })).not.toThrow();
    const env = context.gains.slice(gainsBefore)[0]!;
    const curve = env.gain.events.find((event) => event.kind === 'curve')!;
    const decay = env.gain.events.find((event) => event.kind === 'target')!;
    const curveStart = curve.effectiveStart!;
    expect(curveStart, 'the guarded start is at or after the requested time').toBeGreaterThanOrEqual(10);
    expect(decay.time, "the decay starts at or after the curve's never-snapped end").toBeGreaterThanOrEqual(
      curveStart + curve.duration!,
    );
    // The audible shape is preserved: τ is still measured from the end of the 180 ms attack.
    expect(decay.time - curveStart).toBeCloseTo(AUDIO.bloomAttackSeconds, 6);
    expect(decay.tau, 'the partial keeps its designed decay τ').toBeCloseTo(AUDIO.bloomDecayTaus[0]!, 6);
    const ramp = env.gain.events.find((event) => event.kind === 'linear')!;
    expect(ramp.time, 'the bounded terminal fade is anchored to the same start').toBeCloseTo(
      curveStart + AUDIO.bloomTerminalFadeStart + AUDIO.bloomTerminalFadeSeconds,
      6,
    );
    // The terminal zero assignment still exists, so the bloom cannot hang at its attack peak.
    const zeroAt = env.gain.events.filter((event) => event.kind === 'set' && event.value === 0).at(-1)!;
    expect(zeroAt.time).toBeGreaterThanOrEqual(ramp.time);
    engine.dispose();
  });

  it('is overlap-proof for a `when` behind the clock by a full frame, and for grains', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    context.currentTime = 30;
    // 21 ms behind the clock — the measured production lag (640–1024 samples at 48 kHz).
    expect(() => engine.graph.spawnEvent(30 - 0.021, { baseHz: 330, strength: 0.6 })).not.toThrow();
    expect(() =>
      engine.graph.spawnGrain(30 - 0.021, { seconds: 0.4, offset: 0.1, level: AUDIO.grainPeak }),
    ).not.toThrow();
    engine.dispose();
  });

  it('models the browser rule itself: an un-guarded decay inside a snapped curve throws', () => {
    // This is what makes the tests above meaningful: the recording fake now rejects exactly what
    // Chromium rejects, so this class of regression cannot pass by being unexercised.
    const snapped = new FakeAudioParam(() => 10);
    snapped.setValueCurveAtTime(new Float32Array(9), 10, AUDIO.bloomAttackSeconds);
    expect(() => snapped.setTargetAtTime(0, 10 + AUDIO.bloomAttackSeconds, 0.85)).toThrow(
      /overlaps setValueCurveAtTime/,
    );
    // An event exactly at the curve's end is accepted (the fixed schedule relies on this).
    const exact = new FakeAudioParam(() => 10);
    exact.setValueCurveAtTime(new Float32Array(9), 10 + AUDIO.curveLeadMs / 1000, AUDIO.bloomAttackSeconds);
    expect(() =>
      exact.setTargetAtTime(0, 10 + AUDIO.curveLeadMs / 1000 + AUDIO.bloomAttackSeconds, 0.85),
    ).not.toThrow();
  });

  it('records the glide mirror from the time the glide was actually scheduled at', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 5 });
    context.currentTime = 4;
    engine.graph.applyPitchGlide([220], [247.5], 4, AUDIO.glideSeconds);
    const freq = context.oscillators[0]!.frequency;
    const curve = freq.events.find((event) => event.kind === 'curve')!;
    expect(curve.effectiveStart, 'the glide curve is scheduled from a guarded start').toBeGreaterThanOrEqual(4);
    // A later immediate set can never land inside the still-pending glide curve.
    expect(() =>
      engine.graph.applyPitchImmediate([261.6], curve.effectiveStart! + 0.5),
    ).not.toThrow();
    const set = freq.events.filter((event) => event.kind === 'set').at(-1)!;
    expect(set.time).toBeGreaterThanOrEqual(curve.effectiveStart! + curve.duration!);
    engine.dispose();
  });
});

describe('§6 activation edge (locked→running)', () => {
  it('stays silent when activation lands in dormancy (no eligible presence)', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false, rootSeed: 1 });
    engine.consume(worldFor(QUIET_PRESENTATION, { event: { serial: 7, kind: 'merge', strength: 0.8 } }));

    context.currentTime = 2;
    engine.setUnlocked(true);
    // No fade-up: the master is only cancelled and held at its current (locked: zero) level.
    expect(masterParam(engine).events.some((event) => event.kind === 'linear')).toBe(false);
    expect(engine.stats().presence).toBe(false);
    engine.dispose();
  });

  it('reveals over 1.5 s when activation lands with eligible presence, and baselines the serial', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false, rootSeed: 1 });
    // Confirm presence while locked (engine ticks, no timer in the test): two fresh samples + 0.5 s.
    for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({}, { event: { serial: 7, kind: 'merge', strength: 0.8 } }));
      engine.tick(t);
    }
    expect(engine.stats().presence, 'presence confirms from fresh support samples').toBe(true);

    context.currentTime = 1.2;
    engine.setUnlocked(true);
    const ramp = masterParam(engine).events.find((event) => event.kind === 'linear');
    expect(ramp).toMatchObject({ value: AUDIO.masterLevel, time: 1.2 + AUDIO.revealSeconds });
    expect(AUDIO.revealSeconds).toBeCloseTo(1.5, 6);

    // The retained serial 7 does not excite on the first post-activation tick.
    engine.consume(worldFor({}, { event: { serial: 7, kind: 'merge', strength: 0.8 } }));
    engine.tick(1.25);
    expect(engine.graph.stats().eventsFired, 'no pre-activation replay').toBe(0);
    engine.dispose();
  });
});

describe('§6 presence confirmation and hysteresis', () => {
  it('requires two distinct fresh samples and 0.5 s of persistence', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    // Repeated ticks on the SAME snapshot (identical mark) never confirm.
    for (let t = 0; t <= 3; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({}, { sampleSeconds: 42 }));
      engine.tick(t);
    }
    expect(engine.stats().presence, 'a repeated snapshot does not confirm').toBe(false);
    expect(engine.stats().supportSamples).toBe(1);

    // Two distinct samples 0.5 s apart confirm.
    context.currentTime = 3.1;
    engine.consume(worldFor({}, { sampleSeconds: 43 }));
    engine.tick(3.1);
    context.currentTime = 3.7;
    engine.consume(worldFor({}, { sampleSeconds: 44 }));
    engine.tick(3.7);
    expect(engine.stats().presence).toBe(true);
    engine.dispose();
  });

  it('holds through hysteresis above support-off and clears immediately below it (no chatter)', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);

    // Below the on-threshold but above support-off: hysteresis holds presence.
    const between = (AUDIO.supportOnFraction + AUDIO.supportOffFraction) / 2;
    context.currentTime = 1.5;
    engine.consume(worldFor({ supportFraction: between }));
    engine.tick(1.5);
    expect(engine.stats().presence, 'hysteresis holds between on- and off-thresholds').toBe(true);

    // Below support-off clears presence immediately.
    context.currentTime = 1.6;
    engine.consume(worldFor({ supportFraction: 0 }));
    engine.tick(1.6);
    expect(engine.stats().presence).toBe(false);
    engine.dispose();
  });

  it('cannot establish presence from an invalid/stale tier', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    for (let t = 0; t <= 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({ valid: false }));
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(false);
    engine.dispose();
  });
});

describe('§6 general-fade reversal and stillness precedence', () => {
  it('cancels a general absence fade on a confirmed crossing and reveals', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    // Quiet for 8 s → a general absence fade begins (deadline ≈ 16 s).
    for (let t = 0; t <= 8.5; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(QUIET_PRESENTATION));
      engine.tick(t);
    }
    expect(engine.stats().phase, 'the general fade began').toBe('fading');

    // Support returns at 9 s and confirms by ≈ 9.6 s → the fade is cancelled and the master revealed.
    for (let t = 9; t <= 9.7; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().phase).toBe('live');
    const ramps = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === AUDIO.masterLevel,
    );
    expect(ramps.length, 'the reveal cancels the fade and ramps back to the live level').toBeGreaterThan(0);
    expect(engine.stats().terminalZeroAt).toBeNull();
    engine.dispose();
  });

  it('never reverses a stillness/kill-wait fade (protected precedence)', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    context.currentTime = 0;
    engine.consume(worldFor({}, { phase: { stillnessState: 'kill-wait' } }));
    engine.tick(0);
    engine.prepareSilence(0);
    expect(engine.stats().armed).toBe(true);

    // A supported field afterwards cannot reveal — the stillness fade proceeds to terminal zero.
    for (let t = 0.05; t <= 12; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({}, { phase: { stillnessState: 'kill-wait' } }));
      engine.tick(t);
    }
    expect(engine.stats().phase).toBe('silent');
    expect(engine.stats().terminalZeroAt).not.toBeNull();
    const reveals = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === AUDIO.masterLevel,
    );
    expect(reveals, 'a protected stillness fade is never reversed').toHaveLength(0);
    engine.dispose();
  });
});

describe('§6 reset and rebirth', () => {
  it('clears presence on reset and requires a fresh confirmation afterwards', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    for (let t = 0; t <= 1.5; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);

    // A reset during the reveal drops presence; the freshly seeded field must re-earn it.
    context.currentTime = 1.5;
    engine.resetPerformance(1.5, 99);
    expect(engine.stats().presence).toBe(false);
    expect(engine.stats().supportSamples).toBe(0);

    context.currentTime = 1.55;
    engine.consume(worldFor());
    engine.tick(1.55);
    expect(engine.stats().presence, 'a single fresh sample does not reconfirm').toBe(false);
    for (let t = 1.6; t <= 2.6; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);
    engine.dispose();
  });
});

describe('§6 (MAJOR 1) a field-replacing reset is presence-gated silence', () => {
  it('zeroes the master and every source, then reveals exactly once on fresh confirmation', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 4 });
    // A mature, audible field.
    for (let t = 0; t <= 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);
    expect(engine.graph.masterLevelAt(2)).toBeCloseTo(AUDIO.masterLevel, 3);

    const resetAt = 2;
    context.currentTime = resetAt;
    engine.resetPerformance(resetAt, 5);
    // The master de-clicks to exactly zero and stays there; presence is cleared.
    expect(engine.graph.masterLevelAt(resetAt + AUDIO.declickSeconds)).toBe(0);
    expect(engine.graph.masterLevelAt(resetAt + 1)).toBe(0);
    expect(engine.stats().presence).toBe(false);

    // The old pad cannot survive: the root target is forced to exactly zero at the master zero instant.
    const flushAt = resetAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    expect(
      voiceParam(engine, 0).events.some(
        (event) => event.kind === 'set' && event.value === 0 && event.time === flushAt,
      ),
      'the root target is zeroed at the reset',
    ).toBe(true);

    // An invalid (fresh, empty) field cannot establish presence, and the destination stays silent.
    for (let t = flushAt; t <= resetAt + 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({ valid: false }));
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(false);
    expect(engine.graph.masterLevelAt(resetAt + 2)).toBe(0);

    // A supported field returns: presence confirms and exactly one 1.5 s reveal runs.
    for (let t = resetAt + 2.05; t <= resetAt + 5; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);
    expect(
      masterParam(engine).events.filter((event) => event.kind === 'linear' && event.value === AUDIO.masterLevel),
      'exactly one reveal after the reset',
    ).toHaveLength(1);
    engine.dispose();
  });
});

describe('§6 (MAJOR 2) hysteresis holds the pad floor (no chatter)', () => {
  it('keeps the floor through the band and removes it once below support-off', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 4 });
    for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);

    // Several fresh samples in the hysteresis band [supportOff, supportOn): presence holds and the pad
    // target stays at its floor — it must not chatter to zero while presence is latched.
    const between = (AUDIO.supportOnFraction + AUDIO.supportOffFraction) / 2;
    context.currentTime = 1.05;
    engine.consume(worldFor({ supportFraction: between }));
    engine.tick(1.05);
    expect(engine.stats().presence, 'presence is held in the band').toBe(true);
    const bandTarget = voiceParam(engine, 0).events.at(-1)!.value;
    expect(bandTarget, 'the floor is not chattered to zero in the band').toBeGreaterThan(0);
    for (let i = 1; i < 6; i += 1) {
      const t = 1.05 + i * 0.1;
      context.currentTime = t;
      engine.consume(worldFor({ supportFraction: between }));
      engine.tick(t);
      expect(engine.stats().presence, 'presence stays latched through the band').toBe(true);
      expect(voiceParam(engine, 0).events.at(-1)!.value, 'the pad target is unchanged').toBeCloseTo(
        bandTarget,
        9,
      );
    }

    // Below support-off: presence clears once and the target is removed — no oscillation.
    const belowAt = 1.05 + 6 * 0.1;
    context.currentTime = belowAt;
    engine.consume(worldFor({ supportFraction: 0 }));
    engine.tick(belowAt);
    expect(engine.stats().presence).toBe(false);
    expect(voiceParam(engine, 0).events.at(-1)!.value, 'the floor is removed exactly once').toBe(0);
    context.currentTime = belowAt + 0.05;
    engine.consume(worldFor({ supportFraction: 0 }));
    engine.tick(belowAt + 0.05);
    expect(engine.stats().presence, 'no chatter back on').toBe(false);
    expect(voiceParam(engine, 0).events.at(-1)!.value).toBe(0);
    engine.dispose();
  });
});

describe('§6 (MAJOR 3) an invalid sample breaks the confirmation sequence', () => {
  it('does not confirm across a stale interval, and restarts the count afterwards', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 4 });
    // Valid A (fresh sample 1).
    context.currentTime = 0;
    engine.consume(worldFor({}, { sampleSeconds: 1 }));
    engine.tick(0);
    expect(engine.stats().supportSamples).toBe(1);

    // An invalid (stale) interval longer than the 0.5 s persistence.
    for (let t = 0.6; t <= 1.2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor({ valid: false }));
      engine.tick(t);
    }
    expect(engine.stats().supportSamples, 'the stale interval broke the sequence').toBe(0);
    expect(engine.stats().presence).toBe(false);

    // Valid B is sample 1 of a NEW sequence, not sample 2 of the broken one.
    context.currentTime = 1.5;
    engine.consume(worldFor({}, { sampleSeconds: 2 }));
    engine.tick(1.5);
    expect(engine.stats().presence, 'B alone does not confirm').toBe(false);
    expect(engine.stats().supportSamples).toBe(1);

    // Valid C plus 0.5 s of persistence confirms.
    context.currentTime = 2.1;
    engine.consume(worldFor({}, { sampleSeconds: 3 }));
    engine.tick(2.1);
    expect(engine.stats().presence).toBe(true);
    engine.dispose();
  });
});

describe('§6 (MINOR 4) the root raise is a bounded 0.75 s envelope', () => {
  it('schedules a linear root ramp with an exact endpoint when the master is already live', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 4 });
    // An already-unlocked graph anchors the master at the live level, so the reveal takes the
    // "master already live" branch (no master fade — only the root regains its floor).
    expect(engine.graph.masterLevelAt(0)).toBeCloseTo(AUDIO.masterLevel, 9);

    let revealAt: number | null = null;
    for (let t = 0; t <= 1.2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
      if (revealAt === null && engine.stats().presence) revealAt = t;
    }
    expect(revealAt, 'presence confirmed').not.toBeNull();

    // The root gain carries a linear ramp ending exactly at the 0.75 s endpoint with the target level,
    // followed by a terminal assignment — never an asymptotic `setTargetAtTime`.
    const events = voiceParam(engine, 0).events;
    const ramp = events.find((event) => event.kind === 'linear' && event.value > 0);
    expect(ramp, 'the root raise is a linear ramp, not an asymptotic approach').toBeDefined();
    expect(ramp!.time).toBeCloseTo(revealAt! + AUDIO.rootRevealSeconds, 6);
    const expected = deriveAudioControls(worldFor().analysis.presentation).voiceLevels[0]!;
    expect(ramp!.value).toBeCloseTo(expected, 9);
    expect(
      events.some(
        (event) => event.kind === 'set' && event.time === ramp!.time && Math.abs(event.value - ramp!.value) < 1e-9,
      ),
      'the ramp endpoint is assigned exactly',
    ).toBe(true);
    engine.dispose();
  });
});

describe('§6 (MAJOR 1) an inaudible reset anchors the master at exactly zero', () => {
  /** Drive a mature, audible field. */
  function driveLive(engine: AudioEngine, context: FakeAudioContext, until: number): void {
    for (let t = 0; t <= until; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
  }

  /**
   * The three inaudible reset surfaces, parameterized so all three carry the **identical** assertion set
   * (MINOR): immediate/stable exact zero on param and mirror, exactly one linear master ramp to
   * `AUDIO.masterLevel` ending at permission-return + `AUDIO.revealSeconds`, and the master still
   * < 0.2·`masterLevel` at +0.15 s so the fast mute release cannot expose the pad.
   */
  const INAUDIBLE_RESET_CASES = [
    { name: 'paused', locked: false, withhold: 'pause' },
    { name: 'muted', locked: false, withhold: 'mute' },
    { name: 'locked', locked: true, withhold: 'lock' },
  ] as const;

  for (const testCase of INAUDIBLE_RESET_CASES) {
    it(`${testCase.name}: exact-zero anchor, then exactly one 1.5 s reveal ending at permission + 1.5 s`, () => {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), {
        unlocked: !testCase.locked,
        rootSeed: 3,
      });
      // A mature field: the reveal only matters where the pad would otherwise sound.
      driveLive(engine, context, 2);

      const resetAt = 2;
      context.currentTime = resetAt;
      if (testCase.withhold === 'pause') engine.setPaused(true);
      if (testCase.withhold === 'mute') engine.setMuted(true);
      engine.resetPerformance(resetAt, 9);

      // 1. Immediate / stable exact zero on both the scheduled param and the mirror.
      expect(
        masterParam(engine).events.some(
          (event) => event.kind === 'set' && event.value === 0 && event.time === resetAt,
        ),
        'the param is anchored at exactly zero at the reset',
      ).toBe(true);
      expect(engine.graph.masterLevelAt(resetAt), 'the mirror is exactly zero immediately').toBe(0);
      expect(engine.graph.masterLevelAt(resetAt + 0.05)).toBe(0);
      expect(engine.graph.masterLevelAt(resetAt + 3)).toBe(0);

      // Presence re-confirms while permission is withheld, so the reveal is deferred (none yet).
      for (let t = resetAt; t <= resetAt + 1; t += AUDIO.tickMs / 1000) {
        context.currentTime = t;
        engine.consume(worldFor());
        engine.tick(t);
      }
      expect(engine.stats().presence, 'presence confirms while permission is withheld').toBe(true);
      expect(
        masterParam(engine).events.filter(
          (event) => event.kind === 'linear' && event.value === AUDIO.masterLevel,
        ),
        'no reveal while permission is withheld',
      ).toHaveLength(0);

      // Restore permission: resume, unmute, or the activation edge.
      const permissionAt = resetAt + 1.05;
      context.currentTime = permissionAt;
      if (testCase.withhold === 'pause') engine.setPaused(false);
      if (testCase.withhold === 'mute') engine.setMuted(false);
      if (testCase.withhold === 'lock') engine.setUnlocked(true);
      engine.consume(worldFor());
      engine.tick(permissionAt);

      // 2. Exactly ONE linear master ramp to `masterLevel`, ending at permission + revealSeconds.
      const ramps = masterParam(engine).events.filter(
        (event) => event.kind === 'linear' && event.value === AUDIO.masterLevel,
      );
      expect(ramps, 'exactly ONE unified reveal on the permission return').toHaveLength(1);
      expect(ramps[0]!.time, 'the reveal ends at permission + 1.5 s').toBeCloseTo(
        permissionAt + AUDIO.revealSeconds,
        6,
      );
      expect(ramps[0]!.value).toBeCloseTo(AUDIO.masterLevel, 9);
      expect(
        engine.graph.masterLevelAt(permissionAt + AUDIO.revealSeconds),
        'the master reaches the live level at the reveal deadline',
      ).toBeCloseTo(AUDIO.masterLevel, 6);
      // 3. The master (which gates the mute gain) is still < 0.2·level 0.15 s after permission returns, so
      // the fast mute release alone cannot expose the pad.
      expect(
        engine.graph.masterLevelAt(permissionAt + 0.15),
        'the mute release alone cannot expose the pad',
      ).toBeLessThan(AUDIO.masterLevel * 0.2);
      engine.dispose();
    });
  }
});

describe('§6 (MAJOR) a prohibited interval holds the root down and reveals once on release', () => {
  /**
   * Each case interrupts the bounded root raise (live master, presence eligible) **halfway** through,
   * keeps the prohibition for ~0.6 s with support untouched, then restores permission.
   */
  const PROHIBITION_CASES = [
    {
      name: 'pause',
      prohibitedWorld: () => worldFor(),
      releaseWorld: () => worldFor(),
    },
    {
      name: 'mute',
      prohibitedWorld: () => worldFor(),
      releaseWorld: () => worldFor(),
    },
    {
      name: 'stillness-armed',
      prohibitedWorld: () => worldFor({}, { phase: { stillnessState: 'kill-wait' } }),
      releaseWorld: () => worldFor(),
    },
  ] as const;

  for (const testCase of PROHIBITION_CASES) {
    it(`${testCase.name}: the root never rises during the prohibition and reveals once on release`, () => {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 2 });

      // Confirm presence with the master already live: the reveal is the bounded 0.75 s root raise.
      let revealAt: number | null = null;
      for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
        context.currentTime = t;
        engine.consume(worldFor());
        engine.tick(t);
        if (revealAt === null && engine.stats().presence) revealAt = t;
      }
      expect(revealAt, 'presence confirmed').not.toBeNull();
      const halfway = revealAt! + AUDIO.rootRevealSeconds / 2;

      // Interrupt halfway through the ramp (support is untouched, so presence stays eligible).
      context.currentTime = halfway;
      if (testCase.name === 'pause') engine.setPaused(true);
      if (testCase.name === 'mute') engine.setMuted(true);
      if (testCase.name === 'stillness-armed') engine.prepareSilence(halfway);
      engine.consume(testCase.prohibitedWorld());
      engine.tick(halfway);
      const interruptedAt = engine.graph.rootLevelAt(halfway);
      expect(interruptedAt, 'the ramp was in flight when it was interrupted').toBeGreaterThan(0);

      // During the prohibition the root only ever decays, and no positive target or ramp is scheduled.
      let previous = interruptedAt;
      for (let t = halfway + 0.05; t <= halfway + 0.6; t += 0.05) {
        context.currentTime = t;
        engine.consume(testCase.prohibitedWorld());
        engine.tick(t);
        const value = engine.graph.rootLevelAt(t);
        expect(value, 'the root never rises during the prohibition').toBeLessThanOrEqual(previous + 1e-9);
        previous = value;
      }
      expect(
        voiceParam(engine, 0).events.some(
          (event) =>
            event.time > halfway && (event.kind === 'target' || event.kind === 'linear') && event.value > 0,
        ),
        'no positive root target or ramp is scheduled during the prohibition',
      ).toBe(false);

      // Restore permission. The root returns through exactly one bounded ramp starting from its mirrored
      // held/decayed value — never an already-raised root and never an upward step.
      const releaseAt = halfway + 0.65;
      const mirroredAtRelease = engine.graph.rootLevelAt(releaseAt);
      expect(mirroredAtRelease, 'the root decayed during the prohibition').toBeLessThan(interruptedAt);
      context.currentTime = releaseAt;
      if (testCase.name === 'pause') engine.setPaused(false);
      if (testCase.name === 'mute') engine.setMuted(false);
      engine.consume(testCase.releaseWorld());
      engine.tick(releaseAt);

      const ramps = voiceParam(engine, 0).events.filter(
        (event) => event.kind === 'linear' && event.value > 0 && event.time > halfway,
      );
      expect(ramps, 'exactly one bounded root ramp on release').toHaveLength(1);
      expect(ramps[0]!.time, 'the ramp is the bounded 0.75 s envelope').toBeCloseTo(
        releaseAt + AUDIO.rootRevealSeconds,
        6,
      );
      expect(
        voiceParam(engine, 0).events.some(
          (event) =>
            event.kind === 'set' && event.time === releaseAt && Math.abs(event.value - mirroredAtRelease) < 1e-9,
        ),
        'the ramp starts at the mirrored held/decayed value (no upward step)',
      ).toBe(true);
      engine.dispose();
    });
  }
});

describe('§6 (MAJOR 2) a reset clears in-flight one-shots and the wet path', () => {
  it('retires every pending grain/bloom, zeroes the event bus and reassigns the convolver IR', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 6 });
    // Bring a bloom and grains into flight. The serial changes at 2.5 s — clearly after the initial
    // reveal completes at 2.0 s — so the bloom fires there and is still in flight at the 3 s reset.
    for (let t = 0; t <= 3; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(
        worldFor(GRANULAR_PRESENTATION, {
          event: { serial: t < 2.5 ? 1 : 2, kind: 'merge', strength: 0.8 },
        }),
      );
      engine.tick(t);
    }
    expect(engine.graph.stats().eventsFired, 'a bloom is in flight').toBe(1);
    expect(engine.graph.liveNodes('grain'), 'grains are in flight').toBeGreaterThan(0);
    const irBefore = engine.graph.convolver.buffer;
    const startedBefore = context.startTimes().length;

    const resetAt = 3;
    context.currentTime = resetAt;
    engine.resetPerformance(resetAt, 21);
    // The clear is deferred to the de-click's zero instant (inaudible there).
    const flushAt = resetAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);

    expect(engine.graph.liveNodes('grain'), 'every in-flight grain is retired').toBe(0);
    expect(engine.graph.liveNodes('event'), 'the in-flight bloom is retired').toBe(0);
    expect(
      eventParam(engine).events.some(
        (event) => event.kind === 'set' && event.value === 0 && event.time === flushAt,
      ),
      'the event bus is zeroed at the zero instant',
    ).toBe(true);
    expect(
      engine.graph.convolver.buffer,
      'the convolver IR is reassigned, flushing its internal history',
    ).not.toBe(irBefore);
    expect(context.startTimes().length, 'the reset releases no new one-shot').toBe(startedBefore);
    engine.dispose();
  });

  it('a new bloom re-asserts unity on the event bus after the reset clear', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 8 });
    for (let t = 0; t <= 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    const resetAt = 2;
    context.currentTime = resetAt;
    engine.resetPerformance(resetAt, 8);
    const flushAt = resetAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    expect(eventParam(engine).events.at(-1)).toMatchObject({ kind: 'set', value: 0 });

    // Re-confirm presence after the reset, then fire a later bloom.
    for (let t = flushAt; t <= resetAt + 1.2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.stats().presence).toBe(true);

    // A later bloom restores unity at its own start time.
    const bloomAt = resetAt + 3;
    context.currentTime = bloomAt;
    engine.consume(worldFor({}, { event: { serial: 1, kind: 'merge', strength: 0.8 } }));
    engine.tick(bloomAt);
    expect(engine.graph.stats().eventsFired).toBe(1);
    // §3/§4 (TAKE-5) the re-assertion is scheduled from the guarded start: at or after the requested
    // instant, and no further ahead than the curve lead (so the envelope can no longer be snapped).
    const lead = AUDIO.curveLeadMs / 1000;
    expect(
      eventParam(engine).events.some(
        (event) =>
          event.kind === 'set' && event.value === 1 && event.time >= bloomAt && event.time <= bloomAt + lead,
      ),
      'the new bloom re-asserts unity on the event bus at its guarded start',
    ).toBe(true);
    engine.dispose();
  });
});

describe('§6 (MAJOR 3) a mid-ramp presence loss cancels the root rise', () => {
  it('cancels the positive endpoint, never rises afterwards, and re-crosses from the mirrored value', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 2 });
    // Confirm presence with the master already live: the reveal is the bounded 0.75 s root raise.
    let revealAt: number | null = null;
    for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
      if (revealAt === null && engine.stats().presence) revealAt = t;
    }
    expect(revealAt, 'presence confirmed').not.toBeNull();
    const rampEnd = revealAt! + AUDIO.rootRevealSeconds;
    expect(engine.graph.rootLevelAt(rampEnd), 'the ramp reaches its endpoint').toBeGreaterThan(0);

    // Halfway through the ramp, presence drops below support-off.
    const dropAt = revealAt! + AUDIO.rootRevealSeconds / 2;
    const inFlight = engine.graph.rootLevelAt(dropAt);
    expect(inFlight, 'the mirror reports the true in-flight value').toBeGreaterThan(0);
    expect(inFlight, 'mid-ramp, below the endpoint').toBeLessThan(engine.graph.rootLevelAt(rampEnd) - 1e-9);
    context.currentTime = dropAt;
    engine.consume(worldFor({ supportFraction: 0 }));
    engine.tick(dropAt);
    expect(engine.stats().presence).toBe(false);

    // The positive endpoint is cancelled and the root never increases afterwards.
    expect(
      voiceParam(engine, 0).events.some((event) => event.kind === 'linear' && event.value > 0 && event.time > dropAt),
      'the scheduled positive endpoint is cancelled',
    ).toBe(false);
    let previous = inFlight;
    for (let t = dropAt; t <= dropAt + 0.5; t += 0.01) {
      const value = engine.graph.rootLevelAt(t);
      expect(value, 'no later gain increase').toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }

    // Re-cross after the confirmation interval but before the old endpoint: the new ramp starts from the
    // mirrored in-flight value with no upward step.
    let crossAt: number | null = null;
    let mirroredAtCross = 0;
    for (let t = dropAt + 0.05; t <= dropAt + 0.9; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      const before = engine.graph.rootLevelAt(t);
      engine.tick(t);
      if (crossAt === null && engine.stats().presence) {
        crossAt = t;
        mirroredAtCross = before;
      }
    }
    expect(crossAt, 'presence re-confirmed').not.toBeNull();
    const newRamp = voiceParam(engine, 0).events.find(
      (event) => event.kind === 'linear' && event.value > 0 && event.time > dropAt,
    );
    expect(newRamp, 'a new ramp runs after the re-cross').toBeDefined();
    expect(newRamp!.time).toBeCloseTo(crossAt! + AUDIO.rootRevealSeconds, 6);
    expect(
      voiceParam(engine, 0).events.some(
        (event) => event.kind === 'set' && event.time === crossAt && Math.abs(event.value - mirroredAtCross) < 1e-9,
      ),
      'the new ramp starts at the mirrored in-flight value (no upward step)',
    ).toBe(true);
    engine.dispose();
  });
});

describe('§6 (MINOR 4) a seedless reset preserves a pending reseed', () => {
  it('a seedless reset inside the de-click window does not discard the pending seed', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    context.currentTime = 2;
    engine.consume(worldFor());
    engine.tick(2);

    context.currentTime = 2.5;
    engine.resetPerformance(2.5, 77);
    context.currentTime = 2.55;
    engine.resetPerformance(2.55); // seedless, inside the de-click window
    expect(engine.recordedRootSeed).toBe(77);

    const flushAt = 2.55 + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    const fresh = new AudioEngine(asBaseAudioContext(new FakeAudioContext()), {
      unlocked: true,
      rootSeed: 77,
    });
    expect(engine.soundSignature(), 'the seed-77 material is applied').toEqual(fresh.soundSignature());
    engine.dispose();
    fresh.dispose();
  });

  it('two seeded resets: the latest wins', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    context.currentTime = 2;
    engine.consume(worldFor());
    engine.tick(2);
    context.currentTime = 2.5;
    engine.resetPerformance(2.5, 77);
    context.currentTime = 2.55;
    engine.resetPerformance(2.55, 88);
    expect(engine.recordedRootSeed).toBe(88);

    const flushAt = 2.55 + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    const fresh = new AudioEngine(asBaseAudioContext(new FakeAudioContext()), {
      unlocked: true,
      rootSeed: 88,
    });
    expect(engine.soundSignature(), 'the latest seed wins').toEqual(fresh.soundSignature());
    engine.dispose();
    fresh.dispose();
  });

  it('two seedless resets leave the substream unchanged', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    context.currentTime = 2;
    engine.consume(worldFor());
    engine.tick(2);
    const before = engine.soundSignature();
    context.currentTime = 2.5;
    engine.resetPerformance(2.5);
    context.currentTime = 2.55;
    engine.resetPerformance(2.55);
    expect(engine.recordedRootSeed).toBe(1);

    const flushAt = 2.55 + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    expect(engine.soundSignature(), 'a seedless reset keeps the current material').toEqual(before);
    engine.dispose();
  });
});

describe('§8.3 fresh-performance abort (MAJOR 1)', () => {
  it('cancels a fade aborted before the first tick observes it', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 5 });
    engine.consume(worldFor(GRANULAR_PRESENTATION));
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
    // MAJOR 1: the field-replacing reset leaves the master at exactly zero with presence cleared and
    // does NOT ramp back up (no re-exposing the old tone into the fresh, empty field).
    expect(stats.presence).toBe(false);
    expect(engine.graph.masterLevelAt(1.02 + AUDIO.declickSeconds)).toBe(0);
    expect(engine.graph.masterLevelAt(1.02 + AUDIO.declickSeconds + 5)).toBe(0);

    // Tick well past the old deadline with a living field: presence re-confirms and exactly one unified
    // 1.5 s reveal brings the master back.
    for (let t = 1.05; t <= 12; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(GRANULAR_PRESENTATION));
      engine.tick(t);
    }
    expect(engine.stats().phase).not.toBe('silent');
    expect(engine.stats().presence).toBe(true);
    expect(engine.graph.stats().grainsStarted).toBeGreaterThan(0);
    expect(
      masterParam(engine).events.filter((event) => event.kind === 'linear' && event.value === AUDIO.masterLevel),
      'exactly one reveal after the reset',
    ).toHaveLength(1);
    engine.dispose();
  });

  it('cancels a fade aborted mid-way', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 6 });
    context.currentTime = 0;
    engine.consume(worldFor(GRANULAR_PRESENTATION));
    engine.tick(0);
    engine.prepareSilence(0);
    const oldDeadline = AUDIO.fadeSeconds;
    for (let t = 0.05; t <= 4; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(GRANULAR_PRESENTATION));
      engine.tick(t);
    }
    expect(engine.stats().phase).toBe('fading');

    context.currentTime = 4;
    engine.resetPerformance(4, 10);
    expect(engine.stats().phase).toBe('live');
    expect(engine.stats().armed).toBe(false);
    expect(
      masterParam(engine).eventsAtOrAfter(oldDeadline).some((event) => event.value === 0),
    ).toBe(false);

    for (let t = 4.05; t <= 10; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(GRANULAR_PRESENTATION));
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

    // MAJOR 1: the reset leaves the master at zero, so a living field must re-confirm presence and
    // reveal before the next kill-wait opens its fade from a real live level.
    for (let t = 1.05; t <= 4.8; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    expect(engine.graph.masterLevelAt(4.8), 'the revealed field is live again').toBeCloseTo(
      AUDIO.masterLevel,
      3,
    );

    const zeroRampsBefore = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === 0,
    ).length;

    context.currentTime = 5;
    engine.consume(worldFor(QUIET_PRESENTATION, { phase: { stillnessState: 'kill-wait' } }));
    engine.tick(5);
    engine.prepareSilence(5);
    expect(engine.stats().armed).toBe(true);
    expect(engine.stats().phase).toBe('fading');

    engine.prepareSilence(5.5);
    const zeroRamps = masterParam(engine).events.filter(
      (event) => event.kind === 'linear' && event.value === 0,
    );
    expect(zeroRamps.length - zeroRampsBefore, 'one fresh fade, not two').toBe(1);

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
  it('de-clicks to zero, silences the sources there and reseeds — and never ramps back up (MAJOR 1)', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 11 });
    for (let t = 0; t <= 2; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    const oldRoot = engine.soundSignature().root;

    const restartAt = 2;
    context.currentTime = restartAt;
    engine.resetPerformance(restartAt, 22);

    expect(engine.graph.masterLevelAt(restartAt), 'the restart holds the live level').toBeCloseTo(
      AUDIO.masterLevel,
      6,
    );
    const step = 0.001;
    let maxStep = 0;
    let prev = engine.graph.masterLevelAt(restartAt);
    const horizon = restartAt + AUDIO.declickSeconds + 1.5;
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
      'the master stays at zero — no re-exposing the old tone into the fresh field',
    ).toBe(0);

    expect(engine.soundSignature().root, 'no material change while the master is live').toBe(oldRoot);
    const flushAt = restartAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    expect(engine.soundSignature().root, 'the reseed lands while the master is at zero').toBe(22);
    // MAJOR 1: every persistent source is forced to exactly zero at the same instant.
    expect(
      voiceParam(engine, 0).events.some(
        (event) => event.kind === 'set' && event.value === 0 && event.time === flushAt,
      ),
      'the root source is forced to zero at the master zero instant',
    ).toBe(true);
    expect(
      textureParam(engine).events.some(
        (event) => event.kind === 'set' && event.value === 0 && event.time === flushAt,
      ),
      'the texture bus is forced to zero at the master zero instant',
    ).toBe(true);
    expect(engine.stats().presence, 'presence is cleared by the reset').toBe(false);
    expect(engine.stats().armed).toBe(false);
    engine.dispose();
  });

  it('de-clicks a restart landing mid-activation-fade without a step', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: false, rootSeed: 3 });
    context.currentTime = 0;
    engine.consume(worldFor());
    // Confirm presence, then activate: revealMaster ramps from zero over revealSeconds.
    for (let t = 0; t <= 1; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor());
      engine.tick(t);
    }
    context.currentTime = 1;
    engine.setUnlocked(true);
    expect(engine.graph.masterLevelAt(1)).toBe(0);
    const mid = 1 + AUDIO.revealSeconds / 2;
    const midLevel = engine.graph.masterLevelAt(mid);
    expect(midLevel, 'the activation reveal is mid-way up').toBeGreaterThan(0.1);

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
    for (let t = 0; t <= 12; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(GRANULAR_PRESENTATION));
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
      engine.consume(worldFor(GRANULAR_PRESENTATION));
      engine.tick(t);
    }
    const before = context.startTimes().length;

    // A 3.25 s stall: the cursor must resync to `now`, not release a batch at the resume timestamp.
    context.currentTime = 3.5;
    engine.consume(worldFor(GRANULAR_PRESENTATION));
    engine.tick(3.5);
    const spawned = context.startTimes().slice(before);
    expect(spawned.length, 'a stalled tick spawns at most one grain').toBeLessThanOrEqual(1);
    for (const when of spawned) expect(when).toBeGreaterThanOrEqual(3.5 - 1e-9);
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
      engine.consume(worldFor(GRANULAR_PRESENTATION));
      engine.tick(t);
    }
    engine.setPaused(true);
    const pausedAt = context.startTimes().length;
    for (let t = 1; t <= 18; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldFor(GRANULAR_PRESENTATION));
      engine.tick(t);
    }
    expect(context.startTimes().length, 'paused transport emits no grains').toBe(pausedAt);

    engine.setPaused(false);
    context.currentTime = 20;
    engine.consume(worldFor(GRANULAR_PRESENTATION));
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
    const ir1 = createImpulseResponse(base, 0.5, 7);
    const ir2 = createImpulseResponse(base, 0.5, 7);
    const ir3 = createImpulseResponse(base, 0.5, 8);
    expect(channelData(ir1, 0)).toEqual(channelData(ir2, 0));
    expect(channelData(ir1, 1)).toEqual(channelData(ir2, 1));
    expect(channelData(ir1, 0)).not.toEqual(channelData(ir3, 0));
  });

  it('an IR fades to exact zero at its end (the last sample is exactly 0)', () => {
    const context = new FakeAudioContext();
    const ir = createImpulseResponse(asBaseAudioContext(context), 0.5, 7);
    for (let channel = 0; channel < ir.numberOfChannels; channel += 1) {
      const data = ir.getChannelData(channel);
      expect(Math.abs(data[0]), 'the onset starts at exactly zero').toBe(0);
      expect(Math.abs(data[data.length - 1]), 'the tail ends at exactly zero').toBe(0);
    }
  });

  it('produces an identical grain schedule and material for the same root seed', () => {
    const run = (seed: number): { starts: { when: number; offset: number; duration: number | null }[]; checksum: number } => {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: seed });
      for (let t = 0; t <= 8; t += AUDIO.tickMs / 1000) {
        context.currentTime = t;
        engine.consume(worldFor(GRANULAR_PRESENTATION));
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
    const flushAt = 2 + AUDIO.declickSeconds + 0.01;
    context.currentTime = flushAt;
    engine.consume(worldFor());
    engine.tick(flushAt);
    const after = engine.soundSignature();
    expect(after.root).toBe(77);
    expect(after.checksum).not.toBe(before.checksum);
    const fresh = new AudioEngine(asBaseAudioContext(new FakeAudioContext()), {
      unlocked: true,
      rootSeed: 77,
    });
    expect(after).toEqual(fresh.soundSignature());
    engine.dispose();
    fresh.dispose();
  });
});

describe('§2 graph palette', () => {
  it('builds the four voices from PeriodicWave with disableNormalization', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true });
    expect(context.periodicWaves).toHaveLength(4);
    expect(context.periodicWaves.every((wave) => wave.disableNormalization)).toBe(true);
    // Voice 0's imaginary harmonics are [0, 1/1.38, 0.28/1.38, 0.10/1.38], all sine phase.
    const voice0 = context.periodicWaves[0]!;
    expect(voice0.real.every((value) => value === 0)).toBe(true);
    expect(voice0.imag[1]).toBeCloseTo(1 / 1.38, 6);
    expect(voice0.imag[2]).toBeCloseTo(0.28 / 1.38, 6);
    expect(voice0.imag[3]).toBeCloseTo(0.1 / 1.38, 6);
    // The upper voices are [0, 1/1.10, 0.10/1.10].
    const voice1 = context.periodicWaves[1]!;
    expect(voice1.imag[1]).toBeCloseTo(1 / 1.1, 6);
    expect(voice1.imag[2]).toBeCloseTo(0.1 / 1.1, 6);
    // The voice low-pass uses Q = 0.5 and the texture chain adds the 4200 Hz low-pass.
    expect(context.filters.some((filter) => filter.type === 'highpass' && filter.frequency.value === AUDIO.textureHighpassHz)).toBe(true);
    expect(context.filters.some((filter) => filter.type === 'lowpass' && filter.frequency.value === AUDIO.textureLowpassHz)).toBe(true);
    expect(context.filters.filter((filter) => filter.type === 'lowpass').length).toBeGreaterThanOrEqual(5);
    engine.dispose();
  });

  it('writes a full-Hann grain window with exact zero endpoints and peak 0.85', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 3 });
    const gainsBefore = context.gains.length;
    engine.graph.spawnGrain(5, { seconds: 1, offset: 0.2, level: AUDIO.grainPeak });
    const env = context.gains.slice(gainsBefore)[0]!;
    const curve = env.gain.events.find((event) => event.kind === 'curve')!.curve!;
    expect(curve[0], 'the grain starts at exactly zero').toBeCloseTo(0, 9);
    expect(curve[curve.length - 1], 'the grain ends at exactly zero').toBeCloseTo(0, 9);
    expect(Math.max(...curve)).toBeCloseTo(AUDIO.grainPeak, 3);
    engine.dispose();
  });
});

describe('§2/§3 (TAKE-4) the musicalized pad', () => {
  /** A world whose reaction activity lands squarely in a band (centres .1/.3/.5/.7/.9). */
  function bandWorld(x: number, extra: Parameters<typeof worldFor>[1] = {}): WorldState {
    return worldFor({ reactionActivity: activityForX(x), occupiedFraction: 0.32, coherence: 0.45 }, extra);
  }

  /** Tick `[from, to]` inclusive at the scheduler cadence. */
  function run(
    engine: AudioEngine,
    context: FakeAudioContext,
    from: number,
    to: number,
    world: () => WorldState,
  ): void {
    for (let t = from; t <= to + 1e-9; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(world());
      engine.tick(t);
    }
  }

  /** Tick until the crossing count rises, or `limit` elapses; returns the confirm time or null. */
  function tickUntilCrossing(
    engine: AudioEngine,
    context: FakeAudioContext,
    limit: number,
    world: () => WorldState,
  ): number | null {
    const from = context.currentTime;
    for (let t = from; t <= from + limit; t += 0.05) {
      context.currentTime = t;
      engine.consume(world());
      engine.tick(t);
      if (engine.pitchDiagnostics().crossings > 0) return t;
    }
    return null;
  }

  it('settles at degree 0 (neutral A) with no crossing of its own', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 8, () => bandWorld(0.1));
    const pitch = engine.pitchDiagnostics();
    expect(pitch.padDegree).toBe(0);
    expect(pitch.observedBand).toBe(0);
    expect(pitch.crossings).toBe(0);
    expect(pitch.acceptedChanges).toBe(0);
    expect(pitch.carriers).toEqual(voicingCarriers(0));
    engine.dispose();
  });

  it('confirms after ≥1 s and ≥3 distinct samples, and moves exactly one adjacent degree', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 3, () => bandWorld(0.1));

    const stepAt = 3;
    let confirmedAt: number | null = null;
    for (let t = stepAt; t <= stepAt + 10; t += 0.05) {
      context.currentTime = t;
      engine.consume(bandWorld(0.7));
      engine.tick(t);
      if (confirmedAt === null && engine.pitchDiagnostics().crossings > 0) confirmedAt = t;
    }
    expect(confirmedAt, 'a crossing confirmed').not.toBeNull();
    const pitch = engine.pitchDiagnostics();
    expect(pitch.observedBand, 'the observed band latched to the band the activity crossed into').toBe(3);
    expect(pitch.padDegree, 'a large jump still moves exactly one adjacent degree').toBe(1);
    expect(pitch.acceptedChanges).toBe(1);
    expect(pitch.carriers).toEqual(voicingCarriers(1));
    // The confirmation cannot fire before a full second of persistence.
    expect(confirmedAt!).toBeGreaterThan(stepAt + AUDIO.confirmSeconds - 0.06);
    engine.dispose();
  });

  it('never confirms from a duplicate sample mark (repeated ticks on one snapshot)', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 12, () => bandWorld(0.7, { sampleSeconds: 42 }));
    expect(engine.pitchDiagnostics().crossings, 'a repeated snapshot never confirms').toBe(0);
    expect(engine.pitchDiagnostics().padDegree).toBe(0);
    engine.dispose();
  });

  it('confirms nothing from activity chatter inside the hysteresis deadband', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 30, () => bandWorld(Math.floor(context.currentTime) % 2 === 0 ? 0.15 : 0.25));
    expect(engine.pitchDiagnostics().crossings).toBe(0);
    expect(engine.pitchDiagnostics().padDegree).toBe(0);
    engine.dispose();
  });

  it('issues exactly one finite logarithmic glide per commit — and no per-tick pitch target', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 3, () => bandWorld(0.1));
    const before = voiceFreqParam(engine, 0).events.length;
    expect(tickUntilCrossing(engine, context, 10, () => bandWorld(0.7))).not.toBeNull();

    const curves = voiceFreqParam(engine, 0).events.slice(before).filter((event) => event.kind === 'curve');
    expect(curves, 'exactly one glide curve per committed change').toHaveLength(1);
    expect(curves[0]!.duration).toBeCloseTo(AUDIO.glideSeconds, 9);
    const curve = curves[0]!.curve!;
    expect(curve[0]).toBeCloseTo(voicingCarriers(0)[0]!, 4);
    expect(curve[curve.length - 1]).toBeCloseTo(voicingCarriers(1)[0]!, 4);
    expect(curve[Math.floor(curve.length / 2)]!).toBeGreaterThan(curve[0]!); // monotone glide
    // The old continuous mapping used a per-tick `setTarget` on every voice frequency; it is gone.
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      expect(voiceFreqParam(engine, i).events.every((event) => event.kind !== 'target')).toBe(true);
    }
    engine.dispose();
  });

  it('drops a crossing inside the 12 s refractory and never releases a catch-up later', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 3, () => bandWorld(0.1));
    expect(tickUntilCrossing(engine, context, 12, () => bandWorld(0.3))).not.toBeNull();
    const first = engine.pitchDiagnostics();
    expect(first.acceptedChanges).toBe(1);
    expect(first.padDegree).toBe(1);

    // Step back down inside the gate: the crossing is observed and dropped, not delayed.
    const from = context.currentTime;
    run(engine, context, from + 0.05, from + 6, () => bandWorld(0.1));
    const after = engine.pitchDiagnostics();
    expect(after.droppedRefractory, 'the crossing was dropped by the refractory').toBeGreaterThanOrEqual(1);
    expect(after.acceptedChanges).toBe(1);
    expect(after.padDegree).toBe(1);

    // Holding the same descriptors must not release a queued change once the gate expires.
    const held = context.currentTime;
    run(engine, context, held + 0.05, held + 20, () => bandWorld(0.1));
    expect(engine.pitchDiagnostics().acceptedChanges, 'no catch-up change is ever queued').toBe(1);
    engine.dispose();
  });

  it('consumes a crossing from a prohibited interval and requires a fresh one afterwards', () => {
    for (const kind of ['pause', 'mute'] as const) {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
      run(engine, context, 0, 2, () => bandWorld(0.1));
      context.currentTime = 2;
      if (kind === 'pause') engine.setPaused(true);
      if (kind === 'mute') engine.setMuted(true);
      run(engine, context, 2, 12, () => bandWorld(0.9));
      const during = engine.pitchDiagnostics();
      expect(during.crossings, `${kind}: the crossing was observed`).toBeGreaterThanOrEqual(1);
      expect(during.droppedProhibited).toBeGreaterThanOrEqual(1);
      expect(during.acceptedChanges, `${kind}: nothing commits while prohibited`).toBe(0);
      expect(during.padDegree).toBe(0);

      // Restore permission and step to a *different* band: only a new crossing may commit.
      const restoreAt = context.currentTime + 0.05;
      context.currentTime = restoreAt;
      if (kind === 'pause') engine.setPaused(false);
      if (kind === 'mute') engine.setMuted(false);
      engine.consume(bandWorld(0.9));
      engine.tick(restoreAt);
      expect(engine.pitchDiagnostics().acceptedChanges, `${kind}: the spent crossing is not replayed`).toBe(0);
      run(engine, context, restoreAt + 0.05, restoreAt + 8, () => bandWorld(0.5));
      const after = engine.pitchDiagnostics();
      expect(after.acceptedChanges, `${kind}: a fresh post-return crossing commits`).toBe(1);
      expect(after.padDegree).toBe(1);
      engine.dispose();
    }
  });

  it('a stall rebaselines the observed band, and invalidity holds the last pitch', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 3, () => bandWorld(0.1));
    run(engine, context, 3, 3.4, () => bandWorld(0.9));
    const beforeDegree = engine.pitchDiagnostics().padDegree;

    // A multi-second stall: candidates are dropped and the observed band is rebaselined to the smoothed
    // value's band; the held degree is preserved.
    context.currentTime = 6.4;
    engine.consume(bandWorld(0.9));
    engine.tick(6.4);
    const stalled = engine.pitchDiagnostics();
    expect(stalled.padDegree, 'the held degree is preserved across the stall').toBe(beforeDegree);
    expect(stalled.observedBand, 'the observed band is rebaselined').toBe(
      bandOf(stalled.activityX!, AUDIO.activityBandEdges),
    );

    // An invalid/stale sample clears candidates and holds the pitch — never NaN, never degree 0 from NaN.
    run(engine, context, 6.45, 10, () => worldFor({ valid: false }));
    const invalid = engine.pitchDiagnostics();
    expect(invalid.padDegree).toBe(beforeDegree);
    expect(invalid.carriers.every((hz) => Number.isFinite(hz))).toBe(true);
    expect(invalid.carriers).toEqual(voicingCarriers(beforeDegree));
    engine.dispose();
  });

  it('takes the bloom note from the coherence degree and the feature-scale register', () => {
    for (const [featureScaleUV, register] of [
      [0.66, 'coarse'],
      [0.02, 'fine'],
    ] as const) {
      const context = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
      const oscBefore = context.oscillators.length;
      for (let t = 0; t <= 4; t += 0.05) {
        context.currentTime = t;
        engine.consume(
          worldFor(
            { coherence: 0.45, featureScaleUV },
            { event: { serial: t < 2.5 ? 1 : 2, kind: 'merge', strength: 0.8 } },
          ),
        );
        engine.tick(t);
      }
      const pitch = engine.pitchDiagnostics();
      expect(pitch.bloomRegister).toBe(register);
      expect(pitch.bloomDegree, 'coherence .45 is the third band').toBe(2);
      expect(pitch.lastBloom, 'a bloom fired').not.toBeNull();
      expect(pitch.lastBloom!.baseHz).toBeCloseTo(bloomBaseHz(2, register), 6);
      const bloomOscillators = context.oscillators.slice(oscBefore);
      expect(bloomOscillators.map((oscillator) => oscillator.frequency.value)).toEqual([
        pitch.lastBloom!.baseHz,
        pitch.lastBloom!.baseHz * 2,
        pitch.lastBloom!.baseHz * 3,
      ]);
      // Highest weak harmonic ≤ 2200 Hz, and the pitch is latched (no frequency automation on the bloom).
      expect(pitch.lastBloom!.baseHz * 3).toBeLessThanOrEqual(2200 + 1e-6);
      expect(bloomOscillators.every((oscillator) => oscillator.frequency.events.length === 0)).toBe(true);
      engine.dispose();
    }
  });

  it('resets to the silent neutral A and cancels pitch automation with the episode', () => {
    const context = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(context), { unlocked: true, rootSeed: 1 });
    run(engine, context, 0, 3, () => bandWorld(0.1));
    expect(tickUntilCrossing(engine, context, 12, () => bandWorld(0.7))).not.toBeNull();
    expect(engine.pitchDiagnostics().padDegree).toBe(1);

    const resetAt = context.currentTime + 0.05;
    context.currentTime = resetAt;
    engine.resetPerformance(resetAt, 5);
    const pitch = engine.pitchDiagnostics();
    expect(pitch.padDegree, 'the fresh performance starts on the neutral A').toBe(0);
    expect(pitch.observedBand).toBe(0);
    expect(pitch.carriers).toEqual(voicingCarriers(0));
    expect(pitch.acceptedChanges).toBe(0);

    const flushAt = resetAt + AUDIO.declickSeconds + 0.001;
    context.currentTime = flushAt;
    engine.consume(bandWorld(0.1));
    engine.tick(flushAt);
    for (let i = 0; i < AUDIO.maxVoices; i += 1) {
      expect(
        voiceFreqParam(engine, i).cancels.some((time) => Math.abs(time - flushAt) < 1e-9),
        'pitch automation was cancelled at the reset zero instant',
      ).toBe(true);
    }
    engine.dispose();
  });
});

describe('§2/§4 (TAKE-4) the band-selector state machine (findings MAJOR 1/2/3/4)', () => {
  /** An active supported field with the reaction activity centred in band `x`. */
  const fieldWorld = (
    x: number,
    mark: number,
    opts: { support?: number; coherence?: number; featureScaleUV?: number; stillness?: 'none' | 'kill-wait' } = {},
  ): WorldState =>
    syntheticWorld(
      {
        ...ACTIVE_PRESENTATION,
        reactionActivity: activityForX(x),
        coherence: opts.coherence ?? ACTIVE_PRESENTATION.coherence,
        featureScaleUV: opts.featureScaleUV ?? ACTIVE_PRESENTATION.featureScaleUV,
        supportFraction: opts.support ?? ACTIVE_PRESENTATION.supportFraction,
      },
      { sampleSeconds: mark, phase: { stillnessState: opts.stillness ?? 'none' } },
    );

  function runTicks(
    engine: AudioEngine,
    context: FakeAudioContext,
    from: number,
    to: number,
    worldAt: (t: number) => WorldState,
  ): void {
    for (let t = from; t <= to + 1e-9; t += AUDIO.tickMs / 1000) {
      context.currentTime = t;
      engine.consume(worldAt(t));
      engine.tick(t);
    }
  }

  const markAt = (t: number): number => Math.round(t * 1000);

  it('MAJOR 1: τ advances on elapsed time between *fresh* samples, never on the scheduler tick gap', () => {
    // Reference cadence: the sample mark advances exactly when the tick does (both every 500 ms).
    const refCtx = new FakeAudioContext();
    const ref = new AudioEngine(asBaseAudioContext(refCtx), { unlocked: true, rootSeed: 1 });
    refCtx.currentTime = 0;
    ref.consume(fieldWorld(0.1, 0, { support: 0 }));
    ref.tick(0);
    for (let k = 1; k <= 3; k += 1) {
      refCtx.currentTime = 0.5 * k;
      ref.consume(fieldWorld(0.9, k, { support: 0 }));
      ref.tick(0.5 * k);
    }
    const reference = ref.pitchDiagnostics().activityX!;

    // Production cadence: ticks every 50 ms, but a fresh mark only every 500 ms.
    const ctx = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
    ctx.currentTime = 0;
    engine.consume(fieldWorld(0.1, 0, { support: 0 }));
    engine.tick(0);
    for (let i = 1; i <= 30; i += 1) {
      const t = 0.05 * i;
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.9, Math.floor(t / 0.5 + 1e-9), { support: 0 }));
      engine.tick(t);
    }
    const production = engine.pitchDiagnostics().activityX!;

    // Three 0.5 s fresh steps under τ = 1.5 s give x ≈ 0.9·(1 − e^{−1}) ≈ 0.606. The tick-gap bug
    // would leave x ≈ 0.09 (τ effectively 15 s) — the static drone the revision exists to remove.
    expect(reference, 'the reference run really smoothed with τ = 1.5 s').toBeGreaterThan(0.5);
    expect(production, 'fresh-sample elapsed, not the tick gap').toBeCloseTo(reference, 3);

    // Duplicate-only control: one mark held while the raw activity steps 0.1 → 0.9 smooths nothing.
    const dupCtx = new FakeAudioContext();
    const dup = new AudioEngine(asBaseAudioContext(dupCtx), { unlocked: true, rootSeed: 1 });
    dupCtx.currentTime = 0;
    dup.consume(fieldWorld(0.1, 7, { support: 0 }));
    dup.tick(0);
    for (let t = 0.05; t <= 3 + 1e-9; t += 0.05) {
      dupCtx.currentTime = t;
      dup.consume(fieldWorld(0.9, 7, { support: 0 }));
      dup.tick(t);
    }
    expect(dup.pitchDiagnostics().activityX, 'duplicates never advance the smoothing').toBeCloseTo(0.1, 6);

    ref.dispose();
    engine.dispose();
    dup.dispose();
  });

  it('MAJOR 2: a silent reveal baselines the observed band *and* pad degree from the current activity', () => {
    const centres = [0.1, 0.3, 0.5, 0.7, 0.9];
    for (let expected = 0; expected <= 4; expected += 1) {
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
      // A reset de-clicks the master to exact zero; the support that then re-confirms reveals from that
      // silence, so the reveal is a *silent preparation*.
      ctx.currentTime = 0;
      engine.resetPerformance(0);
      runTicks(engine, ctx, 0.05, 30, (t) => fieldWorld(centres[expected]!, markAt(t)));
      const pitch = engine.pitchDiagnostics();
      expect(pitch.observedBand, `band ${expected}: observed band baselined at the reveal`).toBe(expected);
      expect(pitch.padDegree, `band ${expected}: pad degree baselined at the reveal`).toBe(expected);
      expect(pitch.carriers, `band ${expected}: carriers set immediately to that row`).toEqual(
        voicingCarriers(expected),
      );
      expect(pitch.crossings, `band ${expected}: the baseline is not a crossing`).toBe(0);
      expect(pitch.acceptedChanges, `band ${expected}: the baseline is not a commit`).toBe(0);
      expect(
        voiceFreqParam(engine, 0).events.every((event) => event.kind !== 'curve'),
        `band ${expected}: the baseline is an immediate set, not a glide`,
      ).toBe(true);
      engine.dispose();
    }
  });

  it('MAJOR 3: only a distinct fresh sample may confirm — a duplicate tick never latches', () => {
    // (a) The activity band selector.
    {
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
      const w = (mark: number) => fieldWorld(0.3, mark, { support: 0 });
      ctx.currentTime = 0;
      engine.consume(w(1000));
      engine.tick(0);
      ctx.currentTime = 0.05;
      engine.consume(w(1001));
      engine.tick(0.05);
      ctx.currentTime = 0.1;
      engine.consume(w(1002));
      engine.tick(0.1);
      for (let t = 0.15; t <= 1.0 + 1e-9; t += 0.05) {
        ctx.currentTime = t;
        engine.consume(w(1002));
        engine.tick(t);
      }
      expect(engine.pitchDiagnostics().crossings, 'the duplicate run confirms nothing').toBe(0);
      ctx.currentTime = 1.05;
      engine.consume(w(1003));
      engine.tick(1.05);
      expect(engine.pitchDiagnostics().crossings, 'one fresh sample after the window confirms exactly once').toBe(1);
      engine.dispose();
    }

    // (b) The coherence latch (bloom degree). Activity parked in band 0 so only coherence can cross.
    {
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
      const w = (mark: number) => fieldWorld(0.1, mark, { support: 0, coherence: 0.45 });
      ctx.currentTime = 0;
      engine.consume(w(1000));
      engine.tick(0);
      ctx.currentTime = 0.05;
      engine.consume(w(1001));
      engine.tick(0.05);
      ctx.currentTime = 0.1;
      engine.consume(w(1002));
      engine.tick(0.1);
      for (let t = 0.15; t <= 1.0 + 1e-9; t += 0.05) {
        ctx.currentTime = t;
        engine.consume(w(1002));
        engine.tick(t);
      }
      expect(engine.pitchDiagnostics().bloomDegree, 'the duplicate run latches no coherence band').toBe(0);
      ctx.currentTime = 1.05;
      engine.consume(w(1003));
      engine.tick(1.05);
      expect(engine.pitchDiagnostics().bloomDegree, 'one fresh sample latches coherence band 2').toBe(2);
      engine.dispose();
    }

    // (c) The bloom-register latch.
    {
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
      const w = (fsuv: number, mark: number) => fieldWorld(0.1, mark, { support: 0, featureScaleUV: fsuv });
      ctx.currentTime = 0;
      engine.consume(w(0.02, 1000));
      engine.tick(0);
      ctx.currentTime = 0.05;
      engine.consume(w(0.66, 1001));
      engine.tick(0.05);
      ctx.currentTime = 0.1;
      engine.consume(w(0.66, 1002));
      engine.tick(0.1);
      ctx.currentTime = 0.15;
      engine.consume(w(0.66, 1003));
      engine.tick(0.15);
      for (let t = 0.2; t <= 1.1 + 1e-9; t += 0.05) {
        ctx.currentTime = t;
        engine.consume(w(0.66, 1003));
        engine.tick(t);
      }
      expect(engine.pitchDiagnostics().bloomRegister, 'the duplicate run never flips the register').toBe('fine');
      ctx.currentTime = 1.15;
      engine.consume(w(0.66, 1004));
      engine.tick(1.15);
      expect(engine.pitchDiagnostics().bloomRegister, 'one fresh sample after the window flips it once').toBe('coarse');
      engine.dispose();
    }
  });

  /**
   * MAJOR 4, cases whose permission *return* is an instant, directly-driven toggle: pause, mute and the
   * armed stillness (a world-phase `kill-wait` plus `prepareSilence`, released by returning to `none`).
   * The debt is banked as a two-sample candidate (age well under 1 s) in band 1, then only its *age* is
   * grown with duplicate ticks — so it can never confirm while prohibited, but it is exactly the kind of
   * unconfirmed debt that must not survive into the admissible period.
   */
  it('MAJOR 4: a candidate built while prohibited cannot commit on permission return (pause/mute/stillness)', () => {
    const CASES = [
      {
        name: 'pause',
        enter: (engine: AudioEngine, _t: number) => engine.setPaused(true),
        exit: (engine: AudioEngine) => engine.setPaused(false),
        world: (x: number, mark: number, _prohibited: boolean) => fieldWorld(x, mark),
      },
      {
        name: 'mute',
        enter: (engine: AudioEngine, _t: number) => engine.setMuted(true),
        exit: (engine: AudioEngine) => engine.setMuted(false),
        world: (x: number, mark: number, _prohibited: boolean) => fieldWorld(x, mark),
      },
      {
        name: 'stillness-armed',
        enter: (engine: AudioEngine, t: number) => engine.prepareSilence(t),
        exit: () => {},
        world: (x: number, mark: number, prohibited: boolean) =>
          fieldWorld(x, mark, { stillness: prohibited ? 'kill-wait' : 'none' }),
      },
    ];

    for (const c of CASES) {
      const ctx = new FakeAudioContext();
      const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
      // Settle band 0 behind a supported field so presence/reveal complete and the pad is admissible.
      runTicks(engine, ctx, 0, 3, (t) => c.world(0.1, 100 + markAt(t), false));
      expect(engine.pitchDiagnostics().acceptedChanges, `${c.name}: a quiet settled band 0`).toBe(0);

      // Enter the prohibition at t = 3.05 (this transition alone clears the empty candidate set).
      ctx.currentTime = 3.05;
      c.enter(engine, 3.05);
      engine.consume(c.world(0.1, 9000, true));
      engine.tick(3.05);

      // Bank a two-sample band-1 candidate, then hold the raw inside band 1 (so the candidate can never
      // shift band) and grow only its age with duplicate ticks.
      ctx.currentTime = 3.5;
      engine.consume(c.world(0.7, 9010, true));
      engine.tick(3.5);
      ctx.currentTime = 3.6;
      engine.consume(c.world(0.3, 9011, true));
      engine.tick(3.6);
      for (let t = 3.65; t <= 4.6 + 1e-9; t += 0.05) {
        ctx.currentTime = t;
        engine.consume(c.world(0.3, 9011, true));
        engine.tick(t);
      }
      expect(engine.pitchDiagnostics().acceptedChanges, `${c.name}: nothing commits while prohibited`).toBe(0);

      // Restore permission with exactly one fresh sample: the banked age must not be spent.
      const returnAt = 4.65;
      ctx.currentTime = returnAt;
      c.exit(engine);
      engine.consume(c.world(0.3, 9020, false));
      engine.tick(returnAt);
      expect(
        engine.pitchDiagnostics().acceptedChanges,
        `${c.name}: the debt built while prohibited is not committed on return`,
      ).toBe(0);

      // A complete *fresh* post-return candidate does commit, exactly once.
      runTicks(engine, ctx, returnAt + 0.05, returnAt + 10, (t) => c.world(0.3, 20000 + markAt(t), false));
      expect(engine.pitchDiagnostics().acceptedChanges, `${c.name}: a fresh post-return crossing commits once`).toBe(1);
      engine.dispose();
    }
  });

  it('MAJOR 4: an absent-support interval cannot bank a candidate for the return', () => {
    const ctx = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
    runTicks(engine, ctx, 0, 3, (t) => fieldWorld(0.1, 100 + markAt(t)));
    expect(engine.stats().presence, 'presence confirmed before support drops').toBe(true);

    // Drop support: presence clears, which is the absent-support prohibition.
    ctx.currentTime = 3.05;
    engine.consume(fieldWorld(0.1, 9000, { support: 0 }));
    engine.tick(3.05);
    expect(engine.stats().presence, 'support dropped').toBe(false);

    // Bank a two-sample band-1 candidate while absent, then hold its sample count with duplicates while
    // its age grows. Its `since` ends up ≈0.7 s before the return, so the pre-return debt matures only
    // just *after* the return — never confirming (and being consumed) while still prohibited.
    ctx.currentTime = 3.8;
    engine.consume(fieldWorld(0.7, 9010, { support: 0 }));
    engine.tick(3.8);
    ctx.currentTime = 3.85;
    engine.consume(fieldWorld(0.3, 9011, { support: 0 }));
    engine.tick(3.85);
    for (let t = 3.9; t <= 3.95 + 1e-9; t += 0.05) {
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.3, 9011, { support: 0 }));
      engine.tick(t);
    }

    // Restore support and detect the presence return (the candidate is unconfirmed at that instant).
    let returnAt: number | null = null;
    for (let t = 4.0; t <= 6 && returnAt === null; t += 0.05) {
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.3, 20000 + markAt(t)));
      engine.tick(t);
      if (engine.stats().presence) returnAt = t;
    }
    expect(returnAt, 'support re-confirmed').not.toBeNull();
    const ret = returnAt!;

    // The pre-return debt would mature just after the return; the fresh post-return candidate cannot
    // commit until a full second later. Sample the window in between.
    runTicks(engine, ctx, ret + 0.05, ret + 0.6, (t) => fieldWorld(0.3, 30000 + markAt(t)));
    const afterReturn = engine.pitchDiagnostics();
    expect(
      afterReturn.acceptedChanges,
      'the absent-support candidate is not committed shortly after the return',
    ).toBe(0);

    // Hold band 1 through the return's 1.5 s reveal window (which suppresses crossings), then step to a
    // new band: a complete fresh post-return crossing commits exactly once.
    runTicks(engine, ctx, ret + 0.65, ret + 1.6, (t) => fieldWorld(0.3, 40000 + markAt(t)));
    runTicks(engine, ctx, ret + 1.65, ret + 6, (t) => fieldWorld(0.9, 50000 + markAt(t)));
    expect(engine.pitchDiagnostics().acceptedChanges, 'exactly one fresh post-return commit').toBe(1);
    engine.dispose();
  });

  it('MAJOR 4: a candidate built during the reveal window cannot commit when the window expires', () => {
    const ctx = new FakeAudioContext();
    const engine = new AudioEngine(asBaseAudioContext(ctx), { unlocked: true, rootSeed: 1 });
    // Absent support and band 0 until t = 3, so the reveal happens behind an exact-zero master on band 0.
    runTicks(engine, ctx, 0, 3, (t) => fieldWorld(0.1, 100 + markAt(t), { support: 0 }));
    let revealUntil: number | null = null;
    for (let t = 3.0; t <= 6 && revealUntil === null; t += 0.05) {
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.1, 20000 + markAt(t)));
      engine.tick(t);
      if (engine.stats().revealUntil !== null) revealUntil = engine.stats().revealUntil;
    }
    expect(revealUntil, 'the reveal window opened').not.toBeNull();
    const R = revealUntil!;

    // Bank a two-sample band-1 candidate inside the window; its `since` is ≈0.9 s before the expiry.
    for (let t = ctx.currentTime + 0.05; t <= R - 0.95 + 1e-9; t += 0.05) {
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.1, 25000 + markAt(t)));
      engine.tick(t);
    }
    // Bring the raw into band 1 through the window and bank a multi-sample candidate there; holding the
    // raw with duplicates then freezes its sample count (MAJOR 3) while its age crosses 1 s only *after*
    // the window expires, so it is exactly the unconfirmed pre-expiry debt MAJOR 4 must discard.
    runTicks(engine, ctx, R - 1.4, R - 0.8, (t) => fieldWorld(0.7, 25000 + markAt(t)));
    for (let t = R - 0.75; t <= R - 0.05 + 1e-9; t += 0.05) {
      ctx.currentTime = t;
      engine.consume(fieldWorld(0.3, 26000));
      engine.tick(t);
    }

    // The window expires at R; the pre-expiry debt would mature ≈0.1 s later. Sample past that instant,
    // where the fresh post-expiry candidate (which needs a full second) cannot yet have committed.
    runTicks(engine, ctx, R + 0.05, R + 0.4, (t) => fieldWorld(0.3, 30020 + markAt(t)));
    expect(
      engine.pitchDiagnostics().acceptedChanges,
      'the debt built during the reveal window is not committed when it expires',
    ).toBe(0);

    // A complete fresh post-expiry candidate does commit, exactly once.
    runTicks(engine, ctx, R + 0.45, R + 8, (t) => fieldWorld(0.9, 40000 + markAt(t)));
    expect(engine.pitchDiagnostics().acceptedChanges, 'exactly one fresh post-expiry commit').toBe(1);
    engine.dispose();
  });
});
