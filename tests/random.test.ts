/**
 * §4.4 deterministic PRNG substreams: repeated performances must be recognizably related but
 * reproducible from a recorded seed.
 */
import { describe, expect, it } from 'vitest';
import {
  Rng,
  SUBSTREAM_IDS,
  createSubstream,
  hashLabel,
  jitterMultiplier,
  jitterValue,
  randomRootSeed,
  substream,
  type RngState,
} from '../src/core/random.ts';

describe('deterministic PRNG', () => {
  it('reproduces the same sequence from the same seed', () => {
    const a = new Rng(0x12345678);
    const b = new Rng(0x12345678);
    const first = Array.from({ length: 64 }, () => a.nextUint32());
    const second = Array.from({ length: 64 }, () => b.nextUint32());
    expect(first).toEqual(second);
  });

  it('produces different sequences from different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const first = Array.from({ length: 32 }, () => a.nextUint32());
    const second = Array.from({ length: 32 }, () => b.nextUint32());
    expect(first).not.toEqual(second);
  });

  it('derives independent, stable substreams per label', () => {
    const chemistry = substream(42, 'chemistry');
    const curator = substream(42, 'curator');
    const sound = substream(42, 'sound');
    expect(new Set([chemistry, curator, sound]).size).toBe(3);
    // Stable across calls.
    expect(substream(42, 'chemistry')).toBe(chemistry);
    expect(hashLabel('chemistry')).toBe(hashLabel('chemistry'));
    expect(hashLabel('chemistry')).not.toBe(hashLabel('curator'));
  });

  it('forks substreams that do not disturb the parent sequence', () => {
    const parent = new Rng(7);
    const first = parent.nextUint32();
    const fork = parent.fork('child');
    const second = parent.nextUint32();
    const reference = new Rng(7);
    expect(reference.nextUint32()).toBe(first);
    expect(reference.nextUint32()).toBe(second);
    expect(fork.nextUint32()).toBe(new Rng(substream(first, 'child')).nextUint32());
  });

  it('stays inside its declared ranges', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const ranged = rng.range(2, 5);
      expect(ranged).toBeGreaterThanOrEqual(2);
      expect(ranged).toBeLessThan(5);
      const symmetric = rng.symmetric(0.0004);
      expect(Math.abs(symmetric)).toBeLessThan(0.0004);
    }
  });

  it('reports a uint32 root seed', () => {
    for (let i = 0; i < 10; i += 1) {
      const seed = randomRootSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('round-trips generator state so a replay can resume exactly', () => {
    const rng = new Rng(0xcafe1234);
    for (let i = 0; i < 10; i += 1) rng.nextUint32();
    const saved: RngState = rng.state();
    expect(saved.algorithm).toBe('splitmix32');
    expect(saved.draws).toBe(10);

    const expected = Array.from({ length: 16 }, () => rng.nextUint32());

    const restored = Rng.fromState(saved);
    const resumed = Array.from({ length: 16 }, () => restored.nextUint32());
    expect(resumed).toEqual(expected);

    const restoredInPlace = new Rng(1);
    restoredInPlace.restore(saved);
    expect(restoredInPlace.draws).toBe(10);
    expect(Array.from({ length: 16 }, () => restoredInPlace.nextUint32())).toEqual(expected);
  });

  it('clone() copies without disturbing the source', () => {
    const rng = new Rng(777);
    rng.nextUint32();
    const clone = rng.clone();
    expect(clone.nextUint32()).toBe(rng.nextUint32());
  });

  it('rejects a state from an unknown algorithm', () => {
    const rng = new Rng(3);
    expect(() => rng.restore({ algorithm: 'nope' as unknown as 'splitmix32', state: 1, draws: 0 })).toThrow(
      /unsupported PRNG algorithm/,
    );
  });

  it('derives the three named §4.4 substreams independently and deterministically', () => {
    expect(SUBSTREAM_IDS.chemistry).toBe('chemistry');
    expect(SUBSTREAM_IDS.curator).toBe('curator');
    expect(SUBSTREAM_IDS.sound).toBe('sound');

    const chem = createSubstream(123, SUBSTREAM_IDS.chemistry);
    const cur = createSubstream(123, SUBSTREAM_IDS.curator);
    const sound = createSubstream(123, SUBSTREAM_IDS.sound);
    const first = Array.from({ length: 8 }, () => chem.nextUint32());
    expect(cur.nextUint32()).not.toBe(first[0]);
    expect(sound.nextUint32()).not.toBe(first[0]);
    const chemAgain = createSubstream(123, SUBSTREAM_IDS.chemistry);
    expect(Array.from({ length: 8 }, () => chemAgain.nextUint32())).toEqual(first);
  });

  it('applies ±5% / ±8% / ±0.0004-style jitter within the requested bounds', () => {
    const rng = new Rng(2024);
    for (let i = 0; i < 500; i += 1) {
      const m5 = jitterMultiplier(rng, 0.05);
      expect(m5).toBeGreaterThanOrEqual(0.95);
      expect(m5).toBeLessThanOrEqual(1.05);
      const v8 = jitterValue(rng, 40, 0.08);
      expect(v8).toBeGreaterThanOrEqual(40 * 0.92);
      expect(v8).toBeLessThanOrEqual(40 * 1.08);
      const offset = rng.symmetric(0.0004);
      expect(Math.abs(offset)).toBeLessThan(0.0004);
    }
    // variation 0 is exactly nominal
    expect(jitterMultiplier(new Rng(1), 0)).toBe(1);
    expect(jitterValue(new Rng(1), 12, 0)).toBe(12);
  });
});
