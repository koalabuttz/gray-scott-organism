/**
 * AC.12 — the audio graph, rendered and measured in an OfflineAudioContext (Phase 3B).
 *
 * The plan requires `OfflineAudioContext` output to be finite, to have a bounded voice count, to
 * reach **digital zero after the silence deadline** (terminal assignment verified by sample
 * inspection), to keep peaks ≤ −6 dBFS, and to leave a hidden-periphery field inaudible. All of that
 * runs headless: an `OfflineAudioContext` needs no audio output device, so this spec is the
 * device-independent half of the audio acceptance and never depends on the live context starting.
 *
 * The graph/engine under test is exactly the one the live system drives — the scenario driver only
 * supplies synthetic `WorldState`s and explicit tick times.
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import type { OfflineAudioShape } from '../support/types.ts';

/** −6 dBFS in linear amplitude (§8.2 conservative level ceiling). */
const PEAK_CEILING = 0.5012;
/** The implementation-margin target the design aims for (§8.2: ≤ −8 dBFS). */
const PEAK_AIM = 0.398107;
/** −60 dBFS: an inaudible floor for the hidden-periphery `no audible change` claim. */
const INAUDIBLE = 1e-3;

/** Linear amplitude → dBFS (the measurement guards are stated in dB). */
function toDb(linear: number): number {
  return 20 * Math.log10(Math.max(linear, 1e-12));
}

/**
 * MINOR 5: the largest per-window lift (dB) of `b` over `a` across aligned 1-second windows. Comparing
 * whole 8 s renders hides a short event burst; windowing exposes it.
 */
function maxWindowLiftDb(a: number[], b: number[]): number {
  const count = Math.min(a.length, b.length);
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) max = Math.max(max, toDb(b[i]!) - toDb(a[i]!));
  return max;
}

/**
 * MAJOR 2: the largest per-window |dB| difference between two renders over `[from, to)`. Used to prove
 * that a pre-reset one-shot (and the reverb history it fed) leaves the post-reveal render identical to a
 * fixture that never had one.
 */
function maxWindowDbDiff(a: number[], b: number[], from: number, to: number): number {
  let max = 0;
  for (let i = from; i < Math.min(to, a.length, b.length); i += 1) {
    max = Math.max(max, Math.abs(toDb(a[i]!) - toDb(b[i]!)));
  }
  return max;
}

test.describe('AC.12 offline audio', () => {
  test('an active field renders finite, bounded, conservative output', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario: 'active', seconds: 8 }]);
    console.info(
      `[audio-offline] active: peak=${m.peak.toFixed(4)} rms=${m.rms.toFixed(4)} voices=${m.maxVoices} ` +
        `grains=${m.grainsStarted} events=${m.eventsFired} liveNodes=${m.liveNodes}`,
    );
    expect(m.finite, 'the render is finite').toBe(true);
    expect(m.peak, 'output is audible').toBeGreaterThan(0.0005);
    expect(m.peak, 'peaks stay at or below -6 dBFS').toBeLessThanOrEqual(PEAK_CEILING);
    expect(m.maxVoices, 'voice count is bounded by the four §8.2 voices').toBeLessThanOrEqual(4);
    expect(m.maxVoices).toBeGreaterThanOrEqual(1);
  });

  test('a dead field fades to digital zero after the silence deadline (terminal assignment)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // 4 s active, then below the off thresholds: the general gate's 8 s timer elapses at ≈ 12 s and the
    // bounded fade reaches digital zero at ≈ 20 s. Render past the deadline so the post-deadline samples
    // can be inspected.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'quiet-fade', seconds: 26 },
    ]);
    console.info(
      `[audio-offline] quiet-fade: peak=${m.peak.toFixed(4)} fadeStart=${m.fadeStartedAt} silentAt=${m.silentAt} ` +
        `terminalZeroAt=${m.terminalZeroAt} fadeWindowPeak=${m.fadeWindowPeak.toFixed(4)} ` +
        `postPeak=${m.postDeadlinePeak} postSamples=${m.postDeadlineSamples} phase=${m.silencePhase}`,
    );
    expect(m.finite).toBe(true);
    expect(m.peak).toBeGreaterThan(0.0005); // there *was* sound before the fade
    expect(m.peak).toBeLessThanOrEqual(PEAK_CEILING);
    // The fade begins at the 8 s general gate after 4 s of activity: ≈ 12 s (not at the render start).
    expect(m.fadeStartedAt, 'the terminal fade began').not.toBeNull();
    expect(m.fadeStartedAt!, 'the fade begins near 12 s').toBeGreaterThan(11.5);
    expect(m.fadeStartedAt!).toBeLessThan(12.5);
    // The fade is a real ramp: output is nonzero for part of the (12, 20) fade window.
    expect(m.fadeWindowPeak, 'the fade is a bounded ramp, not an instant cut').toBeGreaterThan(0.0005);
    // Terminal zero is recorded at the deadline (≈ 20 s), not at the fade start.
    expect(m.terminalZeroAt, 'a terminal-zero timestamp was recorded').not.toBeNull();
    expect(m.terminalZeroAt!, 'terminal zero is at the fade deadline (≈ 20 s), not the start').toBeGreaterThanOrEqual(
      19.5,
    );
    expect(m.silentAt, 'the silence gate reached its terminal-zero phase').not.toBeNull();
    expect(m.silentAt!, 'the terminal phase is observed at the deadline').toBeGreaterThan(19.5);
    expect(m.postDeadlineSamples, 'samples exist after the deadline').toBeGreaterThan(0);
    expect(m.postDeadlinePeak, 'samples after the deadline are digitally zero').toBe(0);
  });

  test('a hidden-periphery field is inaudible', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A presentation tier whose signals all stay below the thresholds (the envelope-hidden periphery):
    // occupy 0, activity 0, zero bands. Nothing should reach the output at all.
    const hidden = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'hidden-periphery', seconds: 8 },
    ]);
    const active = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario: 'active', seconds: 8 }]);
    console.info(
      `[audio-offline] hidden: peak=${hidden.peak} voices=${hidden.maxVoices} vs active peak=${active.peak.toFixed(4)}`,
    );
    expect(hidden.finite).toBe(true);
    expect(hidden.peak, 'a hidden field produces no audible output').toBeLessThan(INAUDIBLE);
    expect(hidden.peak).toBeLessThan(active.peak);
    expect(hidden.grainsStarted, 'no grains are scheduled for a hidden field').toBe(0);
  });

  test('event excitation: one per serial, refractory enforced, obsolete serials skipped', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Serials step by 3 every second; the ≥ 15 s refractory lets only ~2 excitations through in 20 s,
    // and every serial gap is recorded as skipped rather than replayed.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'event-refractory', seconds: 20 },
    ]);
    console.info(
      `[audio-offline] events: fired=${m.eventsFired} skipped=${m.eventsSkipped} peak=${m.peak.toFixed(4)}`,
    );
    expect(m.eventsFired, 'at least one excitation fires').toBeGreaterThanOrEqual(1);
    expect(m.eventsFired, 'the 15 s refractory limits excitations').toBeLessThanOrEqual(3);
    expect(m.eventsSkipped, 'obsolete serials are skipped, not replayed').toBeGreaterThan(0);

    // A field with no new event serial fires nothing.
    const none = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario: 'active', seconds: 6 }]);
    expect(none.eventsFired, 'no serial change means no excitation').toBe(0);
  });

  test('one-shot audio nodes do not accumulate over a long synthetic run', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A long run of ticks without rendering: the point is the *lifecycle*, not the samples.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'long-run', seconds: 180, tickHz: 20, render: false },
    ]);
    console.info(
      `[audio-offline] long-run: created=${m.nodeCreated} stopped=${m.nodeStopped} live=${m.liveNodes} ` +
        `maxLive=${m.maxLiveNodes} grains=${m.grainsStarted} events=${m.eventsFired}`,
    );
    expect(m.grainsStarted, 'grains were scheduled').toBeGreaterThan(0);
    expect(m.nodeCreated, 'one-shot nodes were created').toBeGreaterThan(0);
    // Every created one-shot node is either still live (bounded) or disconnected.
    expect(m.nodeCreated).toBe(m.nodeStopped + m.liveNodes);
    // The live set is bounded by the grain concurrency plus one event subgraph.
    expect(m.maxLiveNodes).toBeLessThanOrEqual(14);
    expect(m.liveNodes).toBeLessThanOrEqual(40);
  });

  test('the stillness override drives the master to terminal zero and satisfies the acknowledgement', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario: 'stillness', seconds: 14 }]);
    console.info(
      `[audio-offline] stillness: fadeStart=${m.fadeStartedAt} silentAt=${m.silentAt} ` +
        `terminalZeroAt=${m.terminalZeroAt} postPeak=${m.postDeadlinePeak} satisfied=${m.satisfied}`,
    );
    // The override is issued at 2 s; its 8 s ramp reaches zero at ≈ 10 s — emphatically not at 2 s.
    expect(m.fadeStartedAt, 'the override fade began near 2 s').not.toBeNull();
    expect(m.fadeStartedAt!).toBeGreaterThan(1.5);
    expect(m.fadeStartedAt!).toBeLessThan(2.5);
    expect(m.silentAt, 'the forced fade reached terminal zero').not.toBeNull();
    expect(m.silentAt!, 'terminal zero is at the fade deadline (≈ 10 s), not the fade start').toBeGreaterThan(9.5);
    expect(m.terminalZeroAt, 'a terminal-zero timestamp was recorded').not.toBeNull();
    expect(m.terminalZeroAt!, 'terminal zero is recorded at ≈ 10 s, not 2 s').toBeGreaterThan(9.5);
    expect(m.terminalZeroAt!).toBeLessThan(10.5);
    expect(m.postDeadlineSamples).toBeGreaterThan(0);
    expect(m.postDeadlinePeak, 'the wet tail is silent too').toBe(0);
    expect(m.satisfied, 'terminal zero satisfies the acknowledgement').toBe(true);
  });

  test('after a re-arm a second stillness requires a fresh acknowledgement', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Episode 1 completes; stillness returns to `none` (re-arm); episode 2 opens without a new fade
    // (the audio wakes), so `satisfied` must be false — no second black-hold on a stale acknowledgement.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario: 'stillness-rearm', seconds: 16 }]);
    console.info(`[audio-offline] stillness-rearm: phase=${m.silencePhase} satisfied=${m.satisfied}`);
    expect(m.satisfied, 'the stale acknowledgement was cleared on re-arm').toBe(false);
  });

  test('a mid-fade restart de-clicks the live master and the abandoned deadline never fires (MAJOR 2)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A tonal field opens a kill-wait fade at 2 s (deadline ≈ 10 s) that a fresh performance aborts at
    // 4 s. The restart must hold the live level and de-click to zero — never step the master — and the
    // abandoned 10 s deadline must never fire.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'restart', seconds: 11, rootSeed: 4321 },
    ]);
    console.info(
      `[audio-offline] restart: peak=${m.peak.toFixed(4)} maxStep=${m.maxInterSampleStep.toFixed(5)} ` +
        `phase=${m.silencePhase} satisfied=${m.satisfied} terminalZeroAt=${m.terminalZeroAt}`,
    );
    expect(m.finite).toBe(true);
    expect(m.peak, 'the restarted field is audible').toBeGreaterThan(0.0005);
    // The restart holds the live level and ramps to zero: a bounded inter-sample step, never a hard cut.
    // Deviation 58: the §2 warm body carries restrained harmonics (voice 0's 2nd/3rd, the upper voices'
    // 2nd) up to ≈ 990 Hz, so the carrier's own sample-to-sample slew grew; the bound is expressed
    // relative to the render's own peak (a genuine hard master cut steps by ≈ the instantaneous signal,
    // i.e. ≈ the peak) rather than an absolute constant.
    expect(m.maxInterSampleStep, 'the restart de-clicks (no hard master cut)').toBeLessThan(m.peak * 0.5);
    // §6 (MAJOR 1): from the de-click's zero instant until the new field confirms presence, the
    // destination is exactly zero — the old organism's tone is not re-exposed in the fresh field.
    expect(m.resetSilencePeak, 'no stale tone/tail survives the reset').toBe(0);
    // The abandoned kill-wait deadline (≈ 10 s) never fires: the fresh performance does not go silent.
    expect(m.terminalZeroAt, 'the abandoned terminal deadline never fires').toBeNull();
    expect(m.satisfied, 'the fresh performance is not at terminal zero').toBe(false);
    expect(m.silencePhase, 'the fresh performance stays live').not.toBe('silent');
  });

  test('the §4.4 sound substream is a pure function of the recorded root seed (MAJOR 3)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // The same root seed renders bit-identical material; a different seed renders different material.
    const first = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 2024 },
    ]);
    const again = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 2024 },
    ]);
    const other = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 2025 },
    ]);
    console.info(
      `[audio-offline] substream: root=${first.rootSeed} checksum=${first.soundChecksum} vs ${other.soundChecksum}; ` +
        `grains=${first.grainsStarted}/${again.grainsStarted}/${other.grainsStarted} peak=${first.peak}`,
    );
    expect(first.rootSeed, 'the root seed is carried through').toBe(2024);
    expect(again.rootSeed).toBe(2024);
    expect(first.soundChecksum, 'the same root seed yields the same material').toBe(again.soundChecksum);
    expect(again.grainsStarted, 'the same root seed yields the same grain schedule').toBe(first.grainsStarted);
    // The *generated material* is bit-identical (checksum above); Chromium's convolver/compressor DSP
    // is not bit-identical across two renders, so the rendered peak agrees only to numerical precision.
    expect(again.peak, 'the same root seed renders the same level').toBeCloseTo(first.peak, 3);
    expect(other.soundChecksum, 'a different root seed yields different material').not.toBe(first.soundChecksum);
    // Both stay inside the §8.2 conservative ceiling.
    expect(first.peak).toBeLessThanOrEqual(PEAK_CEILING);
    expect(other.peak).toBeLessThanOrEqual(PEAK_CEILING);
  });

  test('the §6 wake→reveal output guard reaches audibility by the reveal deadline (rendered samples)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Dormant for 2 s, then a supported body appears: presence confirms (~0.5 s) and the unified 1.5 s
    // reveal brings the pad to level. The guard is measured from the rendered samples.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'wake-reveal', seconds: 12, rootSeed: 7 },
    ]);
    console.info(
      `[audio-offline] wake-reveal: bandRms=${toDb(m.bandRms).toFixed(1)} dBFS rms=${toDb(m.rms).toFixed(1)} dBFS ` +
        `peak=${m.peak.toFixed(4)} (${toDb(m.peak).toFixed(1)} dBFS) phase=${m.silencePhase}`,
    );
    expect(m.finite).toBe(true);
    // §7 the 150–2000 Hz band carries real energy and the full band is clearly audible after the reveal.
    expect(toDb(m.bandRms), '150–2000 Hz band RMS ≥ −34 dBFS by the reveal deadline').toBeGreaterThanOrEqual(-34);
    expect(toDb(m.rms), 'full-band RMS ≥ −27 dBFS by the reveal deadline').toBeGreaterThanOrEqual(-27);
    // §8.2 peak ceiling with margin.
    expect(m.peak, 'peaks stay at or below −6 dBFS').toBeLessThanOrEqual(PEAK_CEILING);
    expect(m.peak, 'the piece sounds, it is not silent').toBeGreaterThan(0.0005);
  });

  test('the render matrix: bus isolation, 44.1/48 kHz, multiple seeds, conservative peaks', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const runs: { label: string; options: Record<string, unknown> }[] = [
      { label: 'pad-only', options: { scenario: 'fine-detail', seconds: 10, rootSeed: 11, muteBuses: ['texture', 'event'] } },
      { label: 'texture-only', options: { scenario: 'fine-detail', seconds: 10, rootSeed: 11, muteBuses: ['pad', 'event'] } },
      { label: 'event-only', options: { scenario: 'event-refractory', seconds: 20, rootSeed: 11, muteBuses: ['pad', 'texture'] } },
      { label: 'combined-48k', options: { scenario: 'active', seconds: 8, rootSeed: 11 } },
      { label: 'combined-44k', options: { scenario: 'active', seconds: 8, rootSeed: 11, sampleRate: 44_100 } },
      { label: 'combined-seed22', options: { scenario: 'active', seconds: 8, rootSeed: 22 } },
      { label: 'single-voice', options: { scenario: 'single-voice', seconds: 8, rootSeed: 11 } },
      { label: 'coherence-sweep', options: { scenario: 'coherence-sweep', seconds: 16, rootSeed: 11 } },
      { label: 'sustained', options: { scenario: 'sustained', seconds: 8, rootSeed: 11 } },
      { label: 'collapse', options: { scenario: 'collapse', seconds: 12, rootSeed: 11 } },
    ];
    const measured = new Map<string, OfflineAudioShape>();
    for (const run of runs) {
      const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [run.options]);
      measured.set(run.label, m);
      console.info(
        `[audio-offline] matrix ${run.label}: peak=${m.peak.toFixed(4)} rms=${toDb(m.rms).toFixed(1)} dBFS ` +
          `voices=${m.maxVoices} grains=${m.grainsStarted} events=${m.eventsFired}`,
      );
      expect(m.finite, `${run.label} is finite`).toBe(true);
      expect(m.peak, `${run.label} peak ≤ −6 dBFS`).toBeLessThanOrEqual(PEAK_CEILING);
      expect(m.peak, `${run.label} peak ≤ the −8 dBFS aim`).toBeLessThanOrEqual(PEAK_AIM);
      expect(m.maxVoices, `${run.label} ≤ 4 pad oscillators`).toBeLessThanOrEqual(4);
      expect(m.maxLiveNodes, `${run.label} live one-shot nodes stay bounded`).toBeLessThanOrEqual(14);
    }

    // §2 the pad is the warm body; §4 the shimmer sits ≥ 12 dB below it.
    const padRms = measured.get('pad-only')!.rms;
    const textureRms = measured.get('texture-only')!.rms;
    console.info(
      `[audio-offline] texture ${toDb(textureRms).toFixed(1)} dBFS vs pad ${toDb(padRms).toFixed(1)} dBFS`,
    );
    expect(textureRms, 'the texture sits ≥ 12 dB below the pad').toBeLessThan(padRms * 10 ** (-12 / 20));
    // §7 single-voice audibility must not depend on the upper voices.
    expect(measured.get('single-voice')!.peak, 'a fragmented single voice is still audible').toBeGreaterThan(0.0005);
  });

  test('the reverb send stays ≥ 15 dB below the dry bus (§5)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const dry = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 11 },
    ]);
    const wet = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 11, wetOnly: true },
    ]);
    console.info(
      `[audio-offline] wet ${toDb(wet.rms).toFixed(1)} dBFS vs dry ${toDb(dry.rms).toFixed(1)} dBFS`,
    );
    expect(wet.rms, 'the wet path is ≥ 15 dB below the dry bus').toBeLessThan(dry.rms * 10 ** (-15 / 20));
    expect(wet.rms, 'the wet path is present, not zero').toBeGreaterThan(0);
  });

  test('a porcelain bloom does not lift any aligned 1-second window by more than 3 dB (§3)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const noEvent = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'active', seconds: 8, rootSeed: 11 },
    ]);
    const withEvent = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'event-refractory', seconds: 8, rootSeed: 11 },
    ]);
    const lift = maxWindowLiftDb(noEvent.windowRms, withEvent.windowRms);
    console.info(
      `[audio-offline] paired-event max 1 s window lift: ${lift.toFixed(2)} dB ` +
        `(${withEvent.eventsFired} bloom(s); windows ${noEvent.windowRms.length})`,
    );
    expect(noEvent.eventsFired, 'the paired render has no event').toBe(0);
    expect(withEvent.eventsFired, 'at least one bloom fired').toBeGreaterThanOrEqual(1);
    expect(lift, 'no 1-second window is lifted by more than 3 dB by a bloom').toBeLessThanOrEqual(3);

    // The guard must not be vacuous: a deliberately over-loud bloom fixture has to FAIL it.
    const loud = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'event-refractory', seconds: 8, rootSeed: 11, eventBoost: 500 },
    ]);
    const loudLift = maxWindowLiftDb(noEvent.windowRms, loud.windowRms);
    console.info(`[audio-offline] over-loud fixture max 1 s window lift: ${loudLift.toFixed(2)} dB (must exceed 3)`);
    expect(loud.eventsFired, 'the over-loud fixture fired a bloom').toBeGreaterThanOrEqual(1);
    expect(loudLift, 'the guard FAILS for an over-loud event, proving it is not vacuous').toBeGreaterThan(3);
  });

  test('a field-replacing reset silences the fresh empty field and reveals only on fresh confirmation (§6/MAJOR 1)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // A mature field, a reset at 3 s into an invalid (fresh, empty) field, then support returns at 6 s.
    const m = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'reset-silence', seconds: 12, rootSeed: 11 },
    ]);
    console.info(
      `[audio-offline] reset-silence: resetSilencePeak=${m.resetSilencePeak} peak=${m.peak.toFixed(4)} ` +
        `rms=${toDb(m.rms).toFixed(1)} dBFS phase=${m.silencePhase}`,
    );
    expect(m.finite).toBe(true);
    // From the de-click's zero instant until the new field confirms presence, the destination is exactly
    // zero — no stale pad target and no reverb tail survive into the fresh field.
    expect(m.resetSilencePeak, 'the old tone/tail does not survive the reset').toBe(0);
    // The NEW field then becomes audible through a real reveal.
    expect(m.peak, 'the fresh field becomes audible after fresh confirmation').toBeGreaterThan(0.0005);
    expect(m.peak, 'peaks stay at or below −6 dBFS').toBeLessThanOrEqual(PEAK_CEILING);
  });

  test('a pre-reset bloom and the reverb history it fed do not leak into the new reveal (§6/MAJOR 2)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // `reset-clean` is the baseline (no pre-reset event); `reset-bloom` fires a bloom 0.2 s before the
    // reset. Both render identically after the reset, and `eventBoost` amplifies that bloom so a leak
    // would be unmistakable rather than marginal.
    const options = { seconds: 12, rootSeed: 11, eventBoost: 20 };
    const clean = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'reset-clean', ...options },
    ]);
    const bloom = await hook<OfflineAudioShape>(page, 'audioOfflineProbe', [
      { scenario: 'reset-bloom', ...options },
    ]);
    console.info(
      `[audio-offline] reset-bloom: resetSilencePeak=${bloom.resetSilencePeak} ` +
        `windows=[${bloom.windowRms.map((value) => value.toFixed(4)).join(', ')}]`,
    );
    expect(bloom.resetSilencePeak, 'the pre-reset bloom leaves nothing in the silence window').toBe(0);
    // Windows 9–11 cover the completed reveal (it begins ≈ 7.55 s and finishes ≈ 9.05 s). A leaked dry
    // bloom or a leaked reverb tail would show up as a large difference here.
    const diff = maxWindowDbDiff(clean.windowRms, bloom.windowRms, 9, 12);
    console.info(`[audio-offline] reset-bloom post-reveal max window difference: ${diff.toFixed(3)} dB`);
    expect(diff, 'the bloom and its reverb tail do not leak into the new reveal').toBeLessThan(0.5);
    expect(bloom.windowRms[10], 'the field really is sounding after the reveal').toBeGreaterThan(0.01);
  });

  test('a pre-reset grain does not leak into the new field reveal (§6/MAJOR 2)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Texture-only, so a leaked grain is a loud fraction of the output rather than a rounding error on
    // the pad. Both fixtures reseed the grain substream at the reset, so their post-reset grain
    // schedules are identical; they differ only in whether grains were flowing before the reset.
    const options = { seconds: 12, rootSeed: 11, muteBuses: ['pad'] as const };
    const run = (scenario: string) =>
      hook<OfflineAudioShape>(page, 'audioOfflineProbe', [{ scenario, ...options }]);
    const clean = await run('reset-grain-clean');
    const grain = await run('reset-grain');
    const repeat = await run('reset-grain');
    // Calibrate against the engine's own run-to-run variation: Chromium's convolver/compressor DSP is
    // not bit-identical across renders, which is material on a signal this quiet (~0.006 RMS). A leaked
    // grain would add roughly a whole grain's energy to the window — far above this floor.
    const noiseFloor = maxWindowDbDiff(grain.windowRms, repeat.windowRms, 9, 12);
    const leak = maxWindowDbDiff(clean.windowRms, grain.windowRms, 9, 12);
    console.info(
      `[audio-offline] reset-grain: resetSilencePeak=${grain.resetSilencePeak} ` +
        `noiseFloor=${noiseFloor.toFixed(3)} dB leak=${leak.toFixed(3)} dB ` +
        `windows=[${grain.windowRms.map((value) => value.toFixed(4)).join(', ')}]`,
    );
    expect(grain.resetSilencePeak, 'the pre-reset grain leaves nothing in the silence window').toBe(0);
    expect(leak, 'the grain does not leak into the new reveal').toBeLessThanOrEqual(
      Math.max(0.5, noiseFloor + 0.5),
    );
    expect(grain.windowRms[10], 'the texture really is sounding after the reveal').toBeGreaterThan(0);
  });
});
