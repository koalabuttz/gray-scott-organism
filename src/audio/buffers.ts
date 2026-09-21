/**
 * §8.2 generated audio buffers (Phase 3).
 *
 * Two buffers are generated once, deterministically, from the recorded seed substream "sound"
 * (§4.4): a 2-second mono white-noise buffer reused for every grain and the rare event impulse, and
 * a 4–6 second dark decaying **stereo** impulse response for the shared convolver send.
 *
 * Both are pure functions of `(sampleRate, seconds, seed)`, so an offline render and a live context
 * generate bit-identical data and the offline test can compare against a fresh generation. No
 * oscillator, grain or impulse is ever created per cell — these buffers are the only stochastic
 * material in the graph.
 */
import { Rng } from '../core/random.ts';

/**
 * Deterministic mono white noise. SplitMix32 via `Rng` (exact integer arithmetic), so the buffer
 * round-trips on any engine.
 */
export function createNoiseBuffer(
  context: BaseAudioContext,
  seconds: number,
  seed: number,
): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = context.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const rng = new Rng(seed);
  for (let i = 0; i < length; i += 1) data[i] = rng.next() * 2 - 1;
  return buffer;
}

/**
 * Dark, slowly decaying stereo impulse response. Each channel is one-pole low-passed white noise
 * (coefficient `tone`, so the IR is dark rather than bright) under an exponential decay envelope with
 * time constant `decayFraction` of the whole length. The first ~4 ms fade in avoids a hard click at
 * the origin. The result is normalised to a modest peak so the wet path stays a small fraction of the
 * dry bus (§8.2: wet ≈ .12–.2).
 */
export function createImpulseResponse(
  context: BaseAudioContext,
  seconds: number,
  seed: number,
  options: { tone?: number; decayFraction?: number; peak?: number } = {},
): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = context.createBuffer(2, length, rate);
  const tone = options.tone ?? 0.12;
  const decayFraction = options.decayFraction ?? 0.28;
  const peak = options.peak ?? 0.5;
  const fadeInSamples = Math.max(1, Math.round(rate * 0.004));
  const decayPerSample = Math.exp(-1 / (rate * seconds * decayFraction));

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const rng = new Rng(seed ^ (0x9e3779b9 * (channel + 1)));
    let lowpassed = 0;
    let envelope = 1;
    let maxAbs = 0;
    for (let i = 0; i < length; i += 1) {
      const white = rng.next() * 2 - 1;
      lowpassed += tone * (white - lowpassed);
      const fadeIn = i < fadeInSamples ? i / fadeInSamples : 1;
      const sample = lowpassed * envelope * fadeIn;
      data[i] = sample;
      if (Math.abs(sample) > maxAbs) maxAbs = Math.abs(sample);
      envelope *= decayPerSample;
    }
    const scale = maxAbs > 0 ? peak / maxAbs : 0;
    for (let i = 0; i < length; i += 1) data[i] *= scale;
  }
  return buffer;
}
