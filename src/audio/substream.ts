/**
 * §4.4 sound substream (Phase 3B, MAJOR 3).
 *
 * §4.4 requires "a recorded uint32 root seed and deterministic PRNG substreams for chemistry, curator,
 * and sound". `src/core/random.ts` already provides the labelled substream (`SUBSTREAM_IDS.sound`); this
 * module turns that one substream into the three concrete seeds the audio graph consumes, so the noise
 * buffer, the convolver impulse response and the grain scheduler are a **pure function of the root
 * seed** — the same performance seed generates the same stochastic material on every run, and two
 * distinct seeds generate different material.
 *
 * The three draws are taken in a fixed order from one generator, so the derivation is stable: `noise`
 * (the shared 2 s buffer, also the event impulse), `ir` (the 5 s stereo impulse response) and `grains`
 * (the granular scheduler's spec RNG). Nothing else reads the sound substream, and adding a draw at the
 * end would not disturb the earlier ones.
 */
import { SUBSTREAM_IDS, createSubstream } from '../core/random.ts';

export interface SoundSubstreamSeeds {
  /** The recorded root seed the substream was derived from (uint32). */
  readonly root: number;
  /** Seed for the reusable noise buffer (grains and the event impulse). */
  readonly noise: number;
  /** Seed for the dark stereo convolver impulse response. */
  readonly ir: number;
  /** Seed for the granular scheduler's stochastic spec RNG. */
  readonly grains: number;
}

/**
 * Derive the §4.4 `sound` substream seeds from the recorded root seed. Pure and deterministic; the
 * same `rootSeed` always yields the same three seeds.
 */
export function deriveSoundSeeds(rootSeed: number): SoundSubstreamSeeds {
  const root = rootSeed >>> 0;
  const sound = createSubstream(root, SUBSTREAM_IDS.sound);
  return {
    root,
    noise: sound.nextUint32(),
    ir: sound.nextUint32(),
    grains: sound.nextUint32(),
  };
}
