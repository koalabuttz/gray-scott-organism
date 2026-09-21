/**
 * §8.2/§5 generated audio buffers (Phase 3, palette per the Sunlit Porcelain Garden record).
 *
 * Two buffers are generated once, deterministically, from the recorded seed substream "sound"
 * (§4.4): a 2-second mono white-noise buffer reused for every grain, and a **2.4-second luminous**
 * stereo impulse response (§5, replacing the old 5 s dark tail) for the shared convolver send.
 *
 * Both are pure functions of `(sampleRate, seconds, seed)`, so an offline render and a live context
 * generate bit-identical data and the offline test can compare against a fresh generation. No
 * oscillator, grain or impulse is ever created per cell — these buffers are the only stochastic
 * material in the graph.
 */
import { AUDIO } from '../config.ts';
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

/** §5 the IR recipe's tunable parts (defaults come from `AUDIO`). */
export interface ImpulseResponseOptions {
  peak?: number;
  envelopeTau?: number;
  onsetSeconds?: number;
  tailSeconds?: number;
  cutoffStartHz?: number;
  cutoffEndHz?: number;
}

/**
 * §5 small luminous space: a deterministic, peak-normalised **stereo** impulse response.
 *
 * Each channel is one-pole low-passed white noise under an `exp(-t/envelopeTau)` amplitude envelope
 * (τ = 0.32 s ⇒ ≈ 2.21 s to −60 dB), with a 10 ms raised-cosine onset, a one-pole cutoff declining
 * **exponentially 5500 Hz → 2200 Hz** across the IR duration, and a final 100 ms linear fade to
 * **exact zero** (the last sample is exactly 0). The two channels use separate seeded noise so the
 * space is stereo. The result is peak-normalised to a modest level so the wet path stays a small
 * fraction of the dry bus (§5: wet ≈ .07–.11).
 */
export function createImpulseResponse(
  context: BaseAudioContext,
  seconds: number,
  seed: number,
  options: ImpulseResponseOptions = {},
): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.round(seconds * rate));
  const buffer = context.createBuffer(2, length, rate);
  const peak = options.peak ?? 0.5;
  const envelopeTau = options.envelopeTau ?? AUDIO.irEnvelopeTau;
  const onsetSamples = Math.max(1, Math.round(rate * (options.onsetSeconds ?? AUDIO.irOnsetSeconds)));
  const tailSamples = Math.max(1, Math.round(rate * (options.tailSeconds ?? AUDIO.irTailSeconds)));
  const cutoffStart = options.cutoffStartHz ?? AUDIO.irCutoffStartHz;
  const cutoffEnd = options.cutoffEndHz ?? AUDIO.irCutoffEndHz;
  const duration = length / rate;

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    const rng = new Rng(seed ^ (0x9e3779b9 * (channel + 1)));
    let lowpassed = 0;
    let maxAbs = 0;
    for (let i = 0; i < length; i += 1) {
      const t = i / rate;
      const white = rng.next() * 2 - 1;
      // One-pole cutoff declining exponentially across the IR (darkens as it decays).
      const cutoff = cutoffStart * Math.pow(cutoffEnd / cutoffStart, t / duration);
      const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
      lowpassed += alpha * (white - lowpassed);
      const envelope = Math.exp(-t / envelopeTau);
      // 10 ms raised-cosine onset (starts at exactly zero, no hard click at the origin).
      const onset = i < onsetSamples ? 0.5 * (1 - Math.cos((Math.PI * i) / onsetSamples)) : 1;
      // Final 100 ms linear fade to exact zero — the last sample is exactly 0.
      const tail =
        i >= length - tailSamples ? Math.max(0, (length - 1 - i) / (tailSamples - 1)) : 1;
      const sample = lowpassed * envelope * onset * tail;
      data[i] = sample;
      if (Math.abs(sample) > maxAbs) maxAbs = Math.abs(sample);
    }
    const scale = maxAbs > 0 ? peak / maxAbs : 0;
    for (let i = 0; i < length; i += 1) data[i] *= scale;
  }
  return buffer;
}
