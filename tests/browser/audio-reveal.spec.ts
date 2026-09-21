/**
 * §6 live presence/reveal (deviation 58): the locked→wake→reveal path an operator actually hears.
 *
 * The piece used to stay quiet far too long after the organism was first visible. This spec opens the
 * artwork **locked/dormant** (not pre-live), fast-forwards until the field carries a visible supported
 * body (§6 `supportFraction`), then unlocks with a real gesture and measures the **real time** to
 * audibility at the destination tap, logging support / audibility / band RMS / master envelope / silence
 * phase against real timestamps. When the machine cannot start an output device the spec skips with the
 * diagnostic — the offline `audio-offline.spec.ts` guard remains the device-independent half.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type {
  AudioOutputShape,
  AudioStatsShape,
  AudioStatusShape,
  PresentationShape,
} from '../support/types.ts';

/** An audible linear peak floor (≈ −26 dBFS): far above a silent, stale or DC-only buffer. */
const AUDIBLE_PEAK = 0.05;
/** The audibility target: the destination is audible within a few real seconds of the wake. */
const AUDIBLE_WITHIN_MS = 5_000;

/** §7 the 150–2000 Hz presentation band power (dBFS) from the destination tap's magnitude spectrum. */
function bandLevelDb(measurement: AudioOutputShape | null): number {
  if (!measurement) return Number.NEGATIVE_INFINITY;
  let power = 0;
  for (let bin = 0; bin < measurement.spectrumDb.length; bin += 1) {
    const hz = bin * measurement.binHz;
    if (hz < 150 || hz > 2000) continue;
    power += 10 ** (measurement.spectrumDb[bin]! / 10);
  }
  return 10 * Math.log10(Math.max(power, 1e-24));
}

test.describe('§6 live presence and reveal', () => {
  test('a visible supported body becomes audible within seconds of the wake (locked→wake→reveal)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Locked and dormant: no audio device has been unlocked yet.
    const before = await hook<AudioStatusShape>(page, 'audioStatus');
    expect(before.unlocked, 'audio starts locked (not pre-live)').toBe(false);

    // Fast-forward the arc until the field carries a *visible supported* body (§6 supportFraction).
    await hook(page, 'dispatch', [{ type: 'speed', value: 6 }]);
    const visibleAt = Date.now();
    await expect
      .poll(
        async () => {
          const presentation = await hook<PresentationShape>(page, 'presentationAnalysis');
          return presentation.valid && presentation.supportFraction >= 0.02;
        },
        { timeout: 150_000, intervals: [500], message: 'the field grew a visible supported body' },
      )
      .toBe(true);
    const supportSeenAt = Date.now();

    // A real gesture unlocks the context — the same surface the operator uses.
    await page.locator('#stage').click();
    const unlockAt = Date.now();
    await page.waitForTimeout(300);
    const status = await hook<AudioStatusShape>(page, 'audioStatus');
    test.skip(
      status.status !== 'running',
      `this machine did not start an audio output device (status=${status.status}); the live reveal ` +
        'assertions are skipped — the offline suite covers the graph and guard on any machine',
    );
    await page.waitForTimeout(150);

    /** The live timeline: support / audibility / root / band RMS / master envelope / silence phase. */
    const timeline: Array<{
      tMs: number;
      support: number;
      peak: number;
      rms: number;
      rootHz: number;
      bandDb: number;
      master: number;
      presence: boolean;
      phase: string;
    }> = [];
    let audibleAt: number | null = null;
    while (Date.now() - unlockAt < AUDIBLE_WITHIN_MS + 3_000) {
      const [presentation, output, stats] = await Promise.all([
        hook<PresentationShape>(page, 'presentationAnalysis'),
        hook<AudioOutputShape | null>(page, 'audioOutput'),
        hook<AudioStatsShape | null>(page, 'audioStats'),
      ]);
      const peak = output?.peak ?? 0;
      timeline.push({
        tMs: Date.now() - unlockAt,
        support: presentation.supportFraction,
        peak,
        rms: output?.rms ?? 0,
        rootHz: output?.dominantHz ?? 0,
        bandDb: bandLevelDb(output),
        master: stats?.masterGain ?? 0,
        presence: stats?.presence ?? false,
        phase: stats?.phase ?? 'unknown',
      });
      if (audibleAt === null && peak > AUDIBLE_PEAK) audibleAt = Date.now();
      if (timeline.length >= 30) break;
      await page.waitForTimeout(150);
    }

    const summary = timeline
      .filter((_, index) => index % 3 === 0)
      .map(
        (entry) =>
          `+${entry.tMs}ms support=${entry.support.toFixed(3)} peak=${entry.peak.toFixed(4)} ` +
          `root=${entry.rootHz.toFixed(0)}Hz band=${entry.bandDb.toFixed(1)}dB master=${entry.master.toFixed(2)} ` +
          `presence=${entry.presence} ${entry.phase}`,
      )
      .join('\n    ');
    console.info(
      `[audio-reveal] visible→support ${supportSeenAt - visibleAt} ms; support→unlock ${unlockAt - supportSeenAt} ms; ` +
        `unlock→audible ${audibleAt === null ? 'n/a' : audibleAt - unlockAt} ms\n    ${summary}`,
    );

    expect(audibleAt, 'the destination became audible after the wake').not.toBeNull();
    expect(
      audibleAt! - unlockAt,
      '§6 the reveal is audible within a few real seconds of the wake',
    ).toBeLessThan(AUDIBLE_WITHIN_MS);

    const settled = await hook<AudioOutputShape | null>(page, 'audioOutput');
    expect(settled, 'the destination tap returned a measurement').not.toBeNull();
    expect(settled!.rms, '§7 the settled drone carries real power').toBeGreaterThan(0.01);
  });
});
