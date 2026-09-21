/**
 * §2.3/§8.3 audio activation and lifecycle (Phase 3B).
 *
 * The plan requires gesture-gated activation with truthful status, pause/resume without a backlog,
 * a working mute command, and a recording stream the recorder can mux in. These are live-context
 * behaviours, so the spec unlocks audio with a real click (a trusted event, which is what the
 * autoplay policy requires); when the machine cannot start an output device it **skips with the
 * diagnostic**, never silently passing a claim about sound that cannot be produced.
 */
import { expect, test } from '@playwright/test';
import { AUDIO } from '../../src/config.ts';
import { hook, openArtwork } from '../support/browser.ts';
import type {
  AudioStatsShape,
  AudioStatusShape,
  LabSnapshotShape,
  SilenceStatusShape,
  SoundSignatureShape,
} from '../support/types.ts';

/** A real gesture unlocks audio; poll briefly so a slow device enumeration cannot make it flaky. */
async function unlockAudio(page: import('@playwright/test').Page): Promise<AudioStatusShape> {
  await page.locator('#stage').click();
  await page.waitForTimeout(300);
  return hook<AudioStatusShape>(page, 'audioStatus');
}

test.describe('§2.3/§8.3 audio activation and lifecycle', () => {
  test('audio exists suspended before the gesture and unlocks on a real gesture', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const before = await hook<AudioStatusShape>(page, 'audioStatus');
    console.info(`[audio-lifecycle] before gesture: ${JSON.stringify(before)}`);
    expect(before.available, 'an AudioContext was constructed').toBe(true);
    expect(before.status, 'audio is suspended before the gesture').toBe('suspended');
    expect(before.unlocked).toBe(false);

    const after = await unlockAudio(page);
    console.info(`[audio-lifecycle] after gesture: ${JSON.stringify(after)}`);
    test.skip(
      after.status !== 'running',
      `this machine did not start an audio output device (status=${after.status}); live-context ` +
        'assertions are skipped — the offline suite covers the graph on any machine',
    );
    expect(after.status).toBe('running');
    expect(after.unlocked, 'audio is truthfully reported as unlocked').toBe(true);

    const snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.audio.status).toBe('running');
    expect(snapshot.audio.unlocked).toBe(true);
    expect(snapshot.activation, 'the activation string names the real audio state').toContain('audio: running');
  });

  test('pause mutes smoothly and resume restores the live acknowledgement', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const unlocked = await unlockAudio(page);
    test.skip(unlocked.status !== 'running', `no audio device (status=${unlocked.status})`);

    // Live: the acknowledgement is not satisfied until the master really reaches terminal zero.
    const live = await hook<SilenceStatusShape>(page, 'silenceStatus');
    expect(live.satisfied, 'a live, unmuted context is not silently satisfied').toBe(false);

    // Pause mutes: locked/transport-stopped audio reads as satisfied-with-null (the §8.3 bypass).
    await hook(page, 'dispatch', [{ type: 'pause', value: true }]);
    await page.waitForTimeout(200);
    const paused = await hook<SilenceStatusShape>(page, 'silenceStatus');
    expect(paused.satisfied, 'paused audio bypasses the gate').toBe(true);
    expect(paused.terminalZeroAt).toBeNull();

    // Resume restores the live acknowledgement — no backlog is replayed.
    await hook(page, 'dispatch', [{ type: 'pause', value: false }]);
    await page.waitForTimeout(200);
    const resumed = await hook<SilenceStatusShape>(page, 'silenceStatus');
    expect(resumed.satisfied, 'resumed audio is live again').toBe(false);
  });

  test('the mute command is wired to the audio system', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const unlocked = await unlockAudio(page);
    test.skip(unlocked.status !== 'running', `no audio device (status=${unlocked.status})`);

    // The dispatch path the laboratory toggle uses.
    await hook(page, 'dispatch', [{ type: 'mute', value: true }]);
    await page.waitForTimeout(150);
    let snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.audio.muted, 'mute:true reaches the audio system').toBe(true);
    expect((await hook<SilenceStatusShape>(page, 'silenceStatus')).satisfied, 'muted reads as bypass-satisfied').toBe(true);

    await hook(page, 'dispatch', [{ type: 'mute', value: false }]);
    await page.waitForTimeout(150);
    snapshot = await hook<LabSnapshotShape>(page, 'labSnapshot');
    expect(snapshot.audio.muted, 'mute:false reaches the audio system').toBe(false);
  });

  test('the recorder stream carries the audio track and the graph stays bounded', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const unlocked = await unlockAudio(page);
    test.skip(unlocked.status !== 'running', `no audio device (status=${unlocked.status})`);

    expect(await hook<number>(page, 'audioRecordingTrackCount'), 'the MediaStream destination has a track').toBe(1);

    // The live graph over a few seconds: one-shot nodes are reaped, nothing accumulates.
    await page.waitForTimeout(4000);
    const stats = await hook<AudioStatsShape>(page, 'audioStats');
    console.info(`[audio-lifecycle] live stats: ${JSON.stringify(stats)}`);
    expect(stats, 'graph instrumentation is available').not.toBeNull();
    expect(stats!.nodes.nodeCreated).toBe(stats!.nodes.nodeStopped + stats!.nodes.liveNodes);
    expect(stats!.nodes.maxLiveNodes, 'live one-shot nodes stay bounded').toBeLessThanOrEqual(14);
    expect(stats!.masterGain, 'a live master gain is above zero').toBeGreaterThan(0);
  });

  test('a restart during a kill-wait fade cannot leave the old terminal fade active (MAJOR 1)', async ({
    page,
  }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const unlocked = await unlockAudio(page);
    test.skip(unlocked.status !== 'running', `no audio device (status=${unlocked.status})`);

    // Start the §8.3 override fade directly (verification-only hook), then restart mid-fade. Without the
    // fresh-performance abort the abandoned episode's 8 s ramp to zero would still be scheduled and the
    // restarted field would fade to silence; with it, the new master transition fades the living field
    // back up to a non-silent level.
    await hook(page, 'prepareSilence');
    await page.waitForTimeout(400);
    const fading = await hook<SilenceStatusShape>(page, 'silenceStatus');
    console.info(`[audio-lifecycle] mid-fade before restart: ${JSON.stringify(fading)}`);
    expect(fading.satisfied, 'the override fade is still armed (not yet at zero)').toBe(false);

    await hook(page, 'dispatch', [{ type: 'restart', seed: 4242 }]);
    // MAJOR 2: sample *around* the transition. The restart holds the live master level and de-clicks it
    // to zero (never a hard cut), and the recorded held level is deterministic — a restart that stepped
    // the master to zero would record a held level of ~0.
    const samples: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await hook<AudioStatsShape>(page, 'audioStats');
      if (s) samples.push(s.masterGain);
      await page.waitForTimeout(40);
    }
    const early = await hook<AudioStatsShape>(page, 'audioStats');
    console.info(
      `[audio-lifecycle] restart transition: heldLevel=${early?.masterHeldAtRestart} ` +
        `samples=[${samples.map((v) => v.toFixed(3)).join(', ')}]`,
    );
    expect(early, 'graph instrumentation is available').not.toBeNull();
    expect(early!.masterHeldAtRestart, 'the restart recorded the level it held from').not.toBeNull();
    // The restart lands mid-activation-fade, so the held level is small but clearly nonzero — a hard cut
    // would hold exactly 0. (The offline render measures the de-click continuity on samples directly.)
    expect(early!.masterHeldAtRestart!, 'the restart held a nonzero live master level').toBeGreaterThan(0.02);
    expect(early!.masterHeldAtRestart!, 'the held level never exceeds the live level').toBeLessThanOrEqual(
      AUDIO.masterLevel + 1e-3,
    );
    // Every sample of the transition stays inside [0, live level] — bounded, no overshoot.
    expect(samples.every((v) => v >= 0), 'the master never goes negative').toBe(true);
    expect(Math.max(...samples), 'the transition never exceeds the live master level').toBeLessThanOrEqual(
      AUDIO.masterLevel + 1e-3,
    );

    await page.waitForTimeout(1600);

    const stats = await hook<AudioStatsShape>(page, 'audioStats');
    const silence = await hook<SilenceStatusShape>(page, 'silenceStatus');
    console.info(`[audio-lifecycle] after restart: master=${stats?.masterGain} armed=${stats?.armed} ${JSON.stringify(silence)}`);
    expect(stats, 'graph instrumentation is available').not.toBeNull();
    expect(stats!.armed, 'the abandoned episode acknowledgement is cleared').toBe(false);
    expect(silence.satisfied, 'the fresh performance is not at terminal zero').toBe(false);
    // The master is rising back to the live level rather than continuing the stale fade to zero.
    await page.waitForTimeout(2600);
    const settled = await hook<AudioStatsShape>(page, 'audioStats');
    expect(settled!.masterGain, 'the living new field is non-silent').toBeGreaterThan(0.5);
  });

  test('a restart reseeds the §4.4 sound substream deterministically (MAJOR 3)', async ({ page }) => {
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const before = await hook<SoundSignatureShape | null>(page, 'audioSoundSignature');
    test.skip(before === null, 'no AudioContext on this machine (audio unavailable)');
    if (before === null) return;

    await hook(page, 'dispatch', [{ type: 'restart', seed: 12345 }]);
    await page.waitForTimeout(120);
    const first = await hook<SoundSignatureShape>(page, 'audioSoundSignature');
    expect(first.root, 'the restart seed becomes the sound-substream root').toBe(12345);

    // The same seed is deterministic.
    await hook(page, 'dispatch', [{ type: 'restart', seed: 12345 }]);
    await page.waitForTimeout(120);
    const again = await hook<SoundSignatureShape>(page, 'audioSoundSignature');
    expect(again, 'the same restart seed reproduces the same substream').toEqual(first);

    // A different seed changes the material, and the initial performance differed too.
    await hook(page, 'dispatch', [{ type: 'restart', seed: 999 }]);
    await page.waitForTimeout(120);
    const other = await hook<SoundSignatureShape>(page, 'audioSoundSignature');
    console.info(
      `[audio-lifecycle] substream: initial=${before.checksum} seed12345=${first.checksum} seed999=${other.checksum}`,
    );
    expect(other.root).toBe(999);
    expect(other.checksum, 'a different seed changes the material').not.toBe(first.checksum);
    expect(before.checksum, 'the restart changed the substream from the initial performance').not.toBe(
      first.checksum,
    );
  });
});
