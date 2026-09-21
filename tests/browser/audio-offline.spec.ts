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
/** −60 dBFS: an inaudible floor for the hidden-periphery `no audible change` claim. */
const INAUDIBLE = 1e-3;

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
    // Deviation 57: with the fundamental band raised to 55–110 Hz the carrier's own sample-to-sample
    // slew grew (the highest partial is now ≈ 330 Hz), so the bound was widened from 0.02 to 0.05 —
    // still ~6× below the ≈ 0.3 step a genuine hard master cut would produce.
    expect(m.maxInterSampleStep, 'the restart de-clicks (no hard master cut)').toBeLessThan(0.05);
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
});
