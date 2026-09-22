/**
 * OVERLAP=1 — the regression guard for the porcelain bloom's `NotSupportedError` (§3/§4, TAKE-5).
 *
 * The 120-minute AC.14 soak found 43 uncaught
 * `NotSupportedError: setTargetAtTime(...) overlaps setValueCurveAtTime(...)` exceptions. `spawnEvent`
 * scheduled the raised-cosine attack with `setValueCurveAtTime(curve, when, 0.18)` and then the decay
 * with `setTargetAtTime(0, when + 0.18, tau)`. Chromium snaps a value curve's start forward to the
 * current render quantum when `when` is at or behind the audio clock, so the decay landed *strictly
 * inside* the curve's real interval and the browser threw — aborting that bloom's decay and its bounded
 * terminal fade to exact zero.
 *
 * This spec is the live-browser proof, in three independent parts:
 *
 *  1. **Production probe (deterministic).** It reaches the app's own live `AudioGraph` and calls the real
 *     `spawnEvent` with `when` at and behind the audio clock — the exact repro shape — with the real
 *     `AudioParam.prototype.setValueCurveAtTime`/`setTargetAtTime` instrumented to record scheduled
 *     times. It asserts: no throw, the curve start is at/after the requested time, and every bloom decay
 *     is scheduled at or after its attack curve's end.
 *  2. **Live control (proves the detector is live in this browser).** The same un-guarded shape
 *     (`curve at the clock`, decay at `clock + 0.18`) is issued on a scratch `AudioContext` and must
 *     throw; the guarded shape (`curve at clock + lead`, decay at its end) must not. If the control did
 *     not throw, part 1 would be vacuous.
 *  3. **Live-path window.** The artwork runs unlocked for a real window while page errors are counted —
 *     the same measurement the soak makes (the pre-fix rate was 3–4 in the first ~120 s of a grown
 *     field) — and the bloom count is read from the graph instrumentation.
 *
 * Verification-only: `src/` reaches its graph through the app's own runtime object, never a second
 * engine, and the instrumented prototypes are restored in a `finally`.
 *
 * Run: `OVERLAP=1 npx playwright test --project=headless-gpu audio-overlap.spec.ts`
 */
import { expect, test } from '@playwright/test';
import { hook, openArtwork } from '../support/browser.ts';
import { writeJson } from '../support/evidence.ts';

const ENABLED = process.env['OVERLAP'] === '1';

/** Real-time window for the live-path part; the pre-fix rate produced several exceptions in 120 s. */
const LIVE_WINDOW_MS = 150_000;
const SEED = 7_700_077;
const DIRECT_PROBES = 12;

interface DirectProbeResult {
  ran: boolean;
  reason: string;
  throws: number;
  probes: number;
  firstThrow: string | null;
  curveStarts: number[];
  curveEnds: number[];
  decayTimes: number[];
  decayTaus: number[];
  requestedWhen: number[];
  clock: number;
  samples: Array<{ curveStartDrift: number; decayMinusCurveEnd: number }>;
}

test.describe('OVERLAP=1 live bloom envelope is overlap-proof', () => {
  test.skip(!ENABLED, 'set OVERLAP=1 to run the live audio-overlap regression guard');

  test('the production bloom scheduling never overlaps its attack curve', async ({ page }) => {
    test.setTimeout(LIVE_WINDOW_MS + 240_000);

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
    });

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    // Presentation settings; a fresh seed so the field grows and blooms become eligible.
    await hook(page, 'setExploration', [false]);
    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    await hook(page, 'setSpeed', [3]);
    await hook(page, 'setPaused', [false]);
    try {
      await hook(page, 'audioUnlock');
    } catch {
      /* the status check below decides */
    }
    const status = await hook<{ status: string; available: boolean }>(page, 'audioStatus');
    test.skip(status.status !== 'running', `this machine did not start an audio output device (status=${status.status})`);

    // --- part 1: the production probe -----------------------------------------------------------
    const direct = await page.evaluate(
      ({ probes }: { probes: number }): DirectProbeResult => {
        const result: DirectProbeResult = {
          ran: false,
          reason: '',
          throws: 0,
          probes: 0,
          firstThrow: null,
          curveStarts: [],
          curveEnds: [],
          decayTimes: [],
          decayTaus: [],
          requestedWhen: [],
          clock: 0,
          samples: [],
        };
        const app = (window as unknown as { __artworkApp?: Record<string, any> }).__artworkApp;
        const graph = app?.['audio']?.['engine']?.['graph'];
        const ctx = app?.['audio']?.['context'] as AudioContext | undefined;
        const spawn = graph?.['spawnEvent'];
        if (typeof spawn !== 'function' || !ctx) {
          result.reason = 'the live AudioGraph was not reachable (audio unavailable or not unlocked)';
          return result;
        }
        result.ran = true;
        result.clock = ctx.currentTime;

        const proto = AudioParam.prototype;
        const originalCurve = proto.setValueCurveAtTime;
        const originalTarget = proto.setTargetAtTime;
        // Real browser objects, instrumented: record what the production call actually schedules. The
        // curve end is remembered **per AudioParam**, so each decay is paired with the curve on its own
        // envelope rather than with another bloom's.
        proto.setValueCurveAtTime = function (this: AudioParam, curve: Float32Array, time: number, duration: number) {
          (this as unknown as { __probeCurveEnd?: number }).__probeCurveEnd = time + duration;
          result.curveStarts.push(time);
          result.curveEnds.push(time + duration);
          return originalCurve.call(this, curve, time, duration);
        };
        proto.setTargetAtTime = function (this: AudioParam, value: number, time: number, tau: number) {
          // Only the bloom decay targets exactly zero with a bloom τ (the pad's τs are on other params).
          if (value === 0 && tau > 0.3 && tau < 0.9) {
            const end = (this as unknown as { __probeCurveEnd?: number }).__probeCurveEnd;
            if (end !== undefined) result.samples.push({ curveStartDrift: 0, decayMinusCurveEnd: time - end });
            result.decayTimes.push(time);
            result.decayTaus.push(tau);
          }
          return originalTarget.call(this, value, time, tau);
        };
        try {
          for (let i = 0; i < probes; i += 1) {
            // Alternate the exact production repro shapes: `when` at the clock, and ~one frame behind it
            // (the measured production lag was 640–1024 samples at 48 kHz, 13–21 ms).
            const when = ctx.currentTime - (i % 2 === 0 ? 0 : 0.021);
            result.requestedWhen.push(when);
            result.probes += 1;
            try {
              spawn.call(graph, when, { baseHz: 220 + i * 11, strength: 0.7 });
            } catch (error) {
              result.throws += 1;
              if (result.firstThrow === null) result.firstThrow = String(error);
            }
          }
        } finally {
          proto.setValueCurveAtTime = originalCurve;
          proto.setTargetAtTime = originalTarget;
        }
        return result;
      },
      { probes: DIRECT_PROBES },
    );

    // --- part 2: the live control (the detector must be live in this browser) --------------------
    const control = await page.evaluate(async () => {
      const attack = 0.18;
      const lead = 0.05;
      const curve = () => {
        const n = Math.max(2, Math.round(attack * 48_000));
        const out = new Float32Array(n);
        for (let i = 0; i < n; i += 1) out[i] = 0.2 * 0.5 * (1 - Math.cos((Math.PI * i) / (n - 1)));
        return out;
      };
      const ctx = new AudioContext();
      await ctx.resume().catch(() => undefined);
      // The snap only applies to a start that is at or behind the clock, and a fresh context sits at
      // `currentTime = 0`, so let the clock advance past the first render quantum first (this is why the
      // defect only appears in a live, running graph).
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A short silent lead-in also lets the render thread start pulling quanta.
      const before = ctx.currentTime;
      // The un-guarded production shape, with a single `when` for both calls (as `spawnEvent` had it):
      // the curve at ~2 ms behind the clock, the decay at `when + attack`.
      const unguardedWhen = before - 0.002;
      let unguarded = 'no throw';
      try {
        const g = ctx.createGain();
        g.gain.setValueCurveAtTime(curve(), unguardedWhen, attack);
        g.gain.setTargetAtTime(0, unguardedWhen + attack, 0.85);
      } catch (error) {
        unguarded = String(error);
      }
      // The fixed shape (what `curveWindow` does): the curve at the clock plus the lead, and the decay at
      // that curve's real end.
      let guarded = 'no throw';
      try {
        const g = ctx.createGain();
        const start = ctx.currentTime + lead;
        g.gain.setValueCurveAtTime(curve(), start, attack);
        g.gain.setTargetAtTime(0, start + attack, 0.85);
      } catch (error) {
        guarded = String(error);
      }
      void ctx.close();
      return { clockAtControl: before, unguarded, guarded };
    });

    // --- part 3: the live-path window -----------------------------------------------------------
    const started = Date.now();
    let blooms = 0;
    let analyzed = 0;
    while (Date.now() - started < LIVE_WINDOW_MS) {
      const stats = await hook<{ nodes: { eventsFired: number } } | null>(page, 'audioStats');
      blooms = stats?.nodes.eventsFired ?? blooms;
      analyzed += 1;
      await page.waitForTimeout(2_000);
    }
    const finalStats = await hook<{ nodes: { eventsFired: number; nodeCreated: number; nodeStopped: number; liveNodes: number } } | null>(
      page,
      'audioStats',
    );
    blooms = finalStats?.nodes.eventsFired ?? blooms;
    const overlapErrors = pageErrors.filter((message) => /overlaps setValueCurveAtTime/.test(message));
    const window = {
      liveWindowSeconds: (Date.now() - started) / 1000,
      blooms,
      finalNodes: finalStats?.nodes ?? null,
      overlapErrors: overlapErrors.length,
      pageErrors,
      polls: analyzed,
    };

    writeJson('soak2h/audio-overlap-after-fix.json', {
      generatedBy: 'tests/browser/audio-overlap.spec.ts (OVERLAP=1)',
      seed: SEED,
      audioStatus: status,
      directProbe: direct,
      liveControl: control,
      liveWindow: window,
    });

    // --- assertions -----------------------------------------------------------------------------
    expect(direct.ran, `the production probe reached the live graph: ${direct.reason}`).toBe(true);
    expect(direct.throws, `no throw from ${direct.probes} production bloom schedules (first: ${direct.firstThrow})`).toBe(0);
    expect(direct.curveStarts.length, 'the probe observed scheduled attack curves').toBeGreaterThan(0);
    // Every bloom curve is scheduled from a start that is at or after the requested time, and the
    // guard means the curve's end is its real end — so no decay can be inside it.
    for (const start of direct.curveStarts) {
      expect(start, 'the attack curve is never scheduled in the past').toBeGreaterThanOrEqual(direct.clock - 1e-6);
    }
    for (const sample of direct.samples) {
      expect(sample.decayMinusCurveEnd, 'every decay starts at or after its attack curve end').toBeGreaterThanOrEqual(-1e-9);
    }
    // The control: the un-guarded shape must still throw, or parts 1 could pass vacuously.
    expect(control.clockAtControl, 'the control context clock advanced past the first quantum').toBeGreaterThan(0.01);
    expect(control.unguarded, 'the un-guarded shape is rejected by this browser').toMatch(/overlaps setValueCurveAtTime/);
    expect(control.guarded, 'the guarded shape is accepted by this browser').toBe('no throw');
    // The live path must be clean over a real window.
    expect(overlapErrors, `no bloom overlap exceptions in the live window (${overlapErrors.join(' | ')})`).toEqual([]);
  });
});
