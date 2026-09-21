/**
 * §8/AC.12 live-path audibility guard (Phase 3B, deviation 57).
 *
 * The offline suite proves the *graph* renders a conservative, non-silent signal, but it drives the
 * engine with the synthetic `activePresentation()` fixture and an already-unlocked graph — it never
 * exercises the live path an operator actually hears. That path is where the piece went silent: a
 * dormant field holds every voice gain at zero, the §8.3 gate then fades the master to zero, and the
 * first sounding fundamental sat at 41–53 Hz (below laptop-speaker reproduction) at ≈ −21 dBFS per
 * voice. Nothing in the suite measured the real destination, so "silent when it shouldn't be" passed.
 *
 * This spec closes that gap permanently. It opens the artwork, unlocks with a **real click**, fast
 * forwards to a grown field, and taps an `AnalyserNode` on the **final node before the audio
 * destination** (`muteGain`, deviation 54a) to measure the actual output. It asserts the destination
 * carries an audible level (peak/RMS floor) *and* that the drone's fundamental band is present in the
 * FFT, so a future regression that leaves the live output silent — or purely sub-bass — fails here.
 *
 * When the machine cannot start an output device the spec skips with the diagnostic, exactly like the
 * other live-context audio specs; the offline suite remains the device-independent half.
 */
import { expect, test } from '@playwright/test';
import { AUDIO } from '../../src/config.ts';
import { hook, openArtwork } from '../support/browser.ts';
import type { AudioOutputShape, AudioStatusShape } from '../support/types.ts';

/** An audible linear peak floor (≈ −26 dBFS): far above a silent, stale or DC-only buffer. */
const AUDIBLE_PEAK = 0.05;
/** An audible RMS floor: a lone DC offset or a denormal tail never reaches this. */
const AUDIBLE_RMS = 0.01;
/** The drone's sounding band: the fundamental (55–110 Hz) through its third partial (≤ 330 Hz). */
const DRONE_BAND_HZ = { min: 40, max: 400 } as const;
/** The magnitude floor (dBFS) a real sounding bin must clear. */
const SPECTRUM_FLOOR_DB = -70;

/** The strongest FFT bin, in Hz, from a destination measurement. */
function dominantBinHz(m: AudioOutputShape): number {
  let best = 0;
  let bestDb = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < m.spectrumDb.length; i += 1) {
    const db = m.spectrumDb[i]!;
    if (db > bestDb) {
      bestDb = db;
      best = i;
    }
  }
  return best * m.binHz;
}

async function unlockAudio(page: import('@playwright/test').Page): Promise<AudioStatusShape> {
  await page.locator('#stage').click();
  await page.waitForTimeout(300);
  return hook<AudioStatusShape>(page, 'audioStatus');
}

test.describe('§8 live-path audibility', () => {
  test('after activation the grown field reaches the destination with an audible drone', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A real gesture unlocks the context — the same surface the operator uses.
    const status = await unlockAudio(page);
    test.skip(
      status.status !== 'running',
      `this machine did not start an audio output device (status=${status.status}); the live-path ` +
        'audibility assertions are skipped — the offline suite covers the graph on any machine',
    );
    expect(status.status, 'the gesture starts the audio context').toBe('running');

    // Fast-forward the arc (the boot is a 30 performance-second dormancy by §2.3/§6.4) so a grown
    // field is reached in test time rather than after a wall-clock minute.
    await hook(page, 'dispatch', [{ type: 'speed', value: 6 }]);

    // Wait for the field to be genuinely grown — the same occupancy the §8.3 gate wakes above.
    await expect
      .poll(
        async () => {
          const presentation = await hook<{ valid: boolean; occupiedFraction: number }>(page, 'presentationAnalysis');
          return presentation.valid && presentation.occupiedFraction >= AUDIO.wakeOccupancy;
        },
        { timeout: 150_000, intervals: [1000], message: 'the field grew above the §8.3 wake occupancy' },
      )
      .toBe(true);

    // ...then sample the destination tap until the drone has risen. The master wakes over 3 s and the
    // descriptors glide (levelTau 5 s), so give it a generous window; a genuinely silent path never
    // satisfies it and the poll times out with the measured values in the failure message.
    let last: AudioOutputShape | null = null;
    let lastPeak = 0;
    await expect
      .poll(
        async () => {
          last = await hook<AudioOutputShape | null>(page, 'audioOutput');
          lastPeak = last?.peak ?? 0;
          return lastPeak;
        },
        { timeout: 90_000, intervals: [2000], message: 'the destination tap carries an audible level' },
      )
      .toBeGreaterThan(AUDIBLE_PEAK);

    expect(last, 'the destination-tapped analyser returned a measurement').not.toBeNull();
    const measurement = last!;
    const dominantHz = dominantBinHz(measurement);
    console.info(
      `[audio-audible] destination (as it rises): peak=${measurement.peak.toFixed(4)} rms=${measurement.rms.toFixed(4)} ` +
        `dominant=${dominantHz.toFixed(1)} Hz (bin ${measurement.binHz.toFixed(2)} Hz, ` +
        `strongest bin ${Math.max(...measurement.spectrumDb).toFixed(1)} dBFS)`,
    );

    // 1. Real audible level reaches the destination (not merely a nonzero gain *value*).
    expect(measurement.peak, 'the destination peak clears the audible floor').toBeGreaterThan(AUDIBLE_PEAK);
    expect(measurement.rms, 'the destination RMS clears the audible floor').toBeGreaterThan(AUDIBLE_RMS);

    // Let the drone settle (the master wakes over 3 s, descriptors glide with levelTau 5 s) and sample
    // again: a merely-barely-audible regression is caught here rather than sneaking past the floor.
    await page.waitForTimeout(8000);
    const settled = (await hook<AudioOutputShape | null>(page, 'audioOutput'))!;
    const settledDominantHz = dominantBinHz(settled);
    console.info(
      `[audio-audible] destination (settled): peak=${settled.peak.toFixed(4)} rms=${settled.rms.toFixed(4)} ` +
        `dominant=${settledDominantHz.toFixed(1)} Hz (strongest bin ${Math.max(...settled.spectrumDb).toFixed(1)} dBFS)`,
    );
    expect(settled.peak, 'the settled drone is comfortably audible').toBeGreaterThan(AUDIBLE_PEAK * 2);
    expect(settled.rms, 'the settled drone carries real power').toBeGreaterThan(AUDIBLE_RMS);
    expect(settledDominantHz, 'the settled drone sounds in the fundamental band').toBeGreaterThanOrEqual(
      DRONE_BAND_HZ.min,
    );
    expect(settledDominantHz).toBeLessThanOrEqual(DRONE_BAND_HZ.max);
    expect(
      Math.max(...settled.spectrumDb),
      'the fundamental band carries real energy, not a noise floor',
    ).toBeGreaterThan(SPECTRUM_FLOOR_DB);
  });

  test('muting the drone silences the destination tap (the guard measures the real signal)', async ({ page }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const status = await unlockAudio(page);
    test.skip(status.status !== 'running', `no audio device (status=${status.status})`);
    await hook(page, 'dispatch', [{ type: 'speed', value: 6 }]);

    await expect
      .poll(
        async () => {
          const presentation = await hook<{ valid: boolean; occupiedFraction: number }>(page, 'presentationAnalysis');
          return presentation.valid && presentation.occupiedFraction >= AUDIO.wakeOccupancy;
        },
        { timeout: 150_000, intervals: [1000] },
      )
      .toBe(true);

    await expect
      .poll(async () => (await hook<AudioOutputShape | null>(page, 'audioOutput'))?.peak ?? 0, {
        timeout: 90_000,
        intervals: [2000],
      })
      .toBeGreaterThan(AUDIBLE_PEAK);

    // The mute command drives the *same* tap to the floor: this proves the measurement is the real
    // destination signal, not a stale buffer, so the positive assertion above is meaningful.
    await hook(page, 'dispatch', [{ type: 'mute', value: true }]);
    await expect
      .poll(async () => (await hook<AudioOutputShape | null>(page, 'audioOutput'))?.peak ?? 1, {
        timeout: 10_000,
        intervals: [250],
      })
      .toBeLessThan(AUDIBLE_PEAK);
  });
});
