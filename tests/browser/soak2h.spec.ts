/**
 * SOAK2H=1 — AC.14 two-hour real-time acceptance soak (§12.4 + AC.14), at **presentation settings**.
 *
 * This is the deliberate counterpart to `soak.spec.ts` (the *accelerated* 512²/12× multi-arc leak
 * soak). Here the run is **real time, unattended, at the shipped presentation configuration**:
 * the 768² presentation grid, the default 3× playback speed, a 1920×1080 rendering canvas (the
 * §11.1 measured target), and audio unlocked (this machine starts a real output device).
 *
 * §12.4 capture list, per 5-minute window where applicable:
 *   - frame-time summaries (p50/p95/p99), delivered-vs-requested step ratio, delivered fps
 *   - readback latency (direct in-page round-trip probe) + analysis cadence + presenter stats
 *   - resource counts: audio live nodes, GL textures/FBOs/renderbuffers/programs/VAOs/buffers, and
 *     DOM event listeners (window/document/canvas, via CDP)
 *   - number of resets/rescues (context losses, genesis commands by mode, extinction decisions)
 *   - audio state (truthful status + silence acknowledgement) timeline
 *   - heap series (`performance.memory`, precise-info flag on)
 *   - arc boundaries crossed
 *   - NaN / non-finite field counts and page/console errors
 *
 * The frame-time series is captured by an injected `requestAnimationFrame` monitor (installed by the
 * spec, not by `src/`), so every frame is counted exactly once with its own timestamp and can be
 * binned into 5-minute windows precisely. The monitor's delivered fps is also the throttling witness:
 * a throttled rAF would show a collapsed frame count per window.
 *
 * Timing methodology: frames during the first `WARMUP_MS` are reported separately as `frameTiming.warmup`
 * (process start, context creation, shader compilation, first trajectory fetch, JIT) and are excluded
 * from the AC.14 window verdict — the same "after warmup" convention AC.14 itself uses for the heap.
 * Nothing is hidden: the warmup aggregate is in the report and the warmup-inclusive overall aggregate
 * is too. Frames after warmup are binned into contiguous 5-minute windows.
 *
 * Verdict is split in two so one does not hide the other:
 *   - `verdict.thresholds.tier` — the AC.14 numeric thresholds (frame time / readback / resource
 *     slopes / heap). This is the part AC.14 names.
 *   - `verdict.runIntegrity.pass` — zero uncaught page errors, zero console errors, zero non-finite
 *     field cells, and a completed run. An uncaught exception in the presentation path is an
 *     acceptance-blocking defect regardless of how good the frame times are.
 *   - `verdict.accepted` — both.
 *
 * Progress is checkpointed to `artifacts/soak2h/progress.json` and each completed window is appended
 * to `artifacts/soak2h/windows-attempt<N>.jsonl`, so a crash still leaves usable partial evidence.
 * The full report is written to `artifacts/soak2h/report.json` in a `finally`-equivalent path (before
 * any assertion) for the same reason.
 *
 * Run: `SOAK2H=1 npx playwright test --config playwright.soak2h.config.ts`
 *      (shortened smoke: `SOAK2H=1 SOAK2H_MINUTES=2 npx playwright test --config playwright.soak2h.config.ts`)
 */
import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACTS_DIR, hook, openArtwork } from '../support/browser.ts';
import { writeJson } from '../support/evidence.ts';

const ENABLED = process.env['SOAK2H'] === '1';
const MINUTES = Number(process.env['SOAK2H_MINUTES'] ?? '120');
const ATTEMPT = process.env['SOAK2H_ATTEMPT'] ?? '1';
const DURATION_MS = Math.round(MINUTES * 60_000);

const SEED = 20_260_921;
/** §11.1 presentation canvas (§11.1 target: 60 fps at 1920×1080 with 768² chemistry). */
const VIEWPORT = { width: 1920, height: 1080 } as const;
/** Presentation playback default (deviation 44; `TIME.defaultSpeed`). */
const PRESENTATION_SPEED = 3;
const NOMINAL_STEPS_PER_SECOND = 120;
/** §11.1 acceptance windows are "≥ 5-minute". */
const WINDOW_MS = 5 * 60_000;
/** Frames before this are reported as warmup and excluded from the window verdict (AC.14's warmup). */
const WARMUP_MS = Math.min(10 * 60_000, Math.round(DURATION_MS / 6));

const POLL_MS = Number(process.env['SOAK2H_POLL_MS'] ?? '500');
const ARC_CHECK_MS = 1_000;
const APP_RING_MS = Number(process.env['SOAK2H_APP_RING_MS'] ?? '1000');
const CADENCE_MS = Number(process.env['SOAK2H_CADENCE_MS'] ?? '5000');
const NAN_CHECK_MS = Number(process.env['SOAK2H_NAN_CHECK_MS'] ?? '10000');
const READBACK_PROBE_MS = Number(process.env['SOAK2H_READBACK_PROBE_MS'] ?? '30000');
/** Timeout for the in-page readback probe. The acceptance run uses 300 ms; a control may raise it. */
const READBACK_TIMEOUT_MS = Number(process.env['SOAK2H_READBACK_TIMEOUT_MS'] ?? '300');
const RESOURCE_MS = Number(process.env['SOAK2H_RESOURCE_MS'] ?? '60000');
const LISTENER_MS = Number(process.env['SOAK2H_LISTENER_MS'] ?? String(10 * 60_000));
const PROGRESS_MS = 15_000;

/** AC.14 thresholds, by tier. */
const TIERS = {
  '60fps': { p50: 17, p95: 22, p99: 34, minDeliveredStepsPerSecond: 0 },
  '30fps-fallback': { p50: 34, p95: 40, p99: 67, minDeliveredStepsPerSecond: 96 },
} as const;

interface ResourceCounts {
  textures: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
  shaders: number;
  vertexArrays: number;
  buffers: number;
}

interface HeapShape {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface AudioStats {
  nodes: {
    nodeCreated: number;
    nodeStopped: number;
    liveNodes: number;
    grainsStarted: number;
    eventsFired: number;
    maxLiveNodes: number;
  };
  phase: string;
  quietSeconds: number;
  eventsSkipped: number;
  terminalZeroAt: number | null;
  armed: boolean;
  masterGain: number;
}

interface AudioStatus {
  status: string;
  unlocked: boolean;
  muted: boolean;
  mutePreference: boolean;
  available: boolean;
}

interface CuratorState {
  arc: number;
  movement: string;
  stillState: string;
  rescueUsed: boolean;
}

interface ArcBoundary {
  arc: number;
  performanceSeconds: number;
  realSeconds: number;
  genesisCount: number;
  rescueCount: number;
  stillState: string;
  movement: string;
}

interface Diagnostics {
  frameTimesMs: number[];
  simulationMsAvg: number;
  renderMsAvg: number;
  overload: boolean;
  rendererInfo: string;
  softwareRenderer: boolean;
  simStepsPerSecond: number;
  deliveredFps: number;
  desiredStepsPerSecond: number;
  analysisBacklog: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function stats(values: readonly number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    n: values.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
    mean,
  };
}

/** Least-squares slope of a (tSeconds, value) series, expressed per minute. */
function slopePerMinute(points: ReadonlyArray<{ t: number; v: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanT = points.reduce((s, p) => s + p.t, 0) / n;
  const meanV = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.v - meanV);
    den += (p.t - meanT) * (p.t - meanT);
  }
  if (den === 0) return 0;
  return (num / den) * 60;
}

/** A bounded recorder: keeps a count plus the first/last few entries, so a hot error path cannot grow. */
class BoundedLog<T> {
  private readonly head: T[] = [];
  private readonly tail: T[] = [];
  count = 0;

  push(value: T): void {
    this.count += 1;
    if (this.head.length < 20) this.head.push(value);
    else {
      this.tail.push(value);
      if (this.tail.length > 20) this.tail.shift();
    }
  }

  snapshot(): { count: number; head: T[]; tail: T[] } {
    return { count: this.count, head: [...this.head], tail: [...this.tail] };
  }
}

async function readHeap(page: Page): Promise<HeapShape | null> {
  return page.evaluate(() => {
    const memory = (performance as unknown as { memory?: HeapShape }).memory;
    return memory
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        }
      : null;
  });
}

/** Count DOM event listeners on window/document/canvas through CDP (not reachable from the page). */
async function listenerCounts(cdp: CDPSession): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = { window: null, document: null, canvas: null };
  const targets: Array<[string, string]> = [
    ['window', 'window'],
    ['document', 'document'],
    ['canvas', "document.getElementById('stage') || document.querySelector('canvas')"],
  ];
  for (const [name, expression] of targets) {
    try {
      const evaluated = (await cdp.send('Runtime.evaluate' as never, {
        expression,
        objectGroup: 'soak2h',
        returnByValue: false,
      } as never)) as { result?: { objectId?: string } };
      const objectId = evaluated.result?.objectId;
      if (!objectId) {
        out[name] = null;
        continue;
      }
      const listeners = (await cdp.send('DOMDebugger.getEventListeners' as never, {
        objectId,
        depth: -1,
        pierce: true,
      } as never)) as { listeners?: unknown[] };
      out[name] = listeners.listeners?.length ?? 0;
      await cdp.send('Runtime.releaseObject' as never, { objectId } as never).catch(() => undefined);
    } catch {
      out[name] = null;
    }
  }
  return out;
}

test.describe('SOAK2H=1 two-hour real-time presentation soak (AC.14)', () => {
  test.skip(!ENABLED, 'set SOAK2H=1 to run the two-hour acceptance soak (very long, GPU-heavy)');

  test('two-hour unattended run at 768²/3× passing its achieved tier thresholds', async ({ page }) => {
    test.setTimeout(DURATION_MS + 20 * 60_000);

    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;

    const pageErrors = new BoundedLog<string>();
    const consoleErrors = new BoundedLog<string>();
    let audioSchedulingErrors = 0;
    page.on('pageerror', (e) => {
      const message = `pageerror: ${e.message}`;
      pageErrors.push(message);
      if (/setTargetAtTime|setValueCurveAtTime/.test(e.message)) audioSchedulingErrors += 1;
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // --- presentation configuration -------------------------------------------------------------
    await hook(page, 'setExploration', [false]);
    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    await hook(page, 'setSpeed', [PRESENTATION_SPEED]);
    await hook(page, 'setPaused', [false]);

    const grid = await hook<{ width: number; height: number }>(page, 'simulationSize');
    expect(grid, 'the soak runs on the 768² presentation grid').toEqual({ width: 768, height: 768 });
    const canvasSize = await hook<{ width: number; height: number }>(page, 'canvasSize');
    const sceneSize = await hook<{ width: number; height: number }>(page, 'sceneSize');
    const capability = await hook<{ renderer: string; softwareRenderer: boolean }>(page, 'report');
    const userAgent = await page.evaluate(() => navigator.userAgent);

    // Audio: unlock without a synthetic (fullscreen-requesting) click so the canvas is not re-sized
    // mid-run. `--autoplay-policy=no-user-gesture-required` lets `resume()` succeed from the hook.
    let audioUnlockNote = 'not attempted';
    try {
      await hook(page, 'audioUnlock');
      const status = await hook<AudioStatus>(page, 'audioStatus');
      audioUnlockNote = `audioUnlock() -> status=${status.status} available=${status.available} muted=${status.muted}`;
    } catch (error) {
      audioUnlockNote = `audioUnlock() threw: ${String(error)}`;
    }

    // --- injected frame monitor -----------------------------------------------------------------
    const installMonitor = async (): Promise<void> => {
      await page.evaluate(() => {
        const scope = window as unknown as { __soak2h?: { frames: number[] } };
        if (scope.__soak2h) return;
        const state = { frames: [] as number[] };
        scope.__soak2h = state;
        const tick = (): void => {
          state.frames.push(performance.now());
          if (state.frames.length > 20_000) state.frames.splice(0, 10_000);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    };
    const drainFrames = async (): Promise<number[]> =>
      page.evaluate(() => {
        const scope = window as unknown as { __soak2h?: { frames: number[] } };
        if (!scope.__soak2h) return [];
        const out = scope.__soak2h.frames;
        scope.__soak2h.frames = [];
        return out;
      });
    await installMonitor();
    const cdp = await page.context().newCDPSession(page);

    // --- accumulators ---------------------------------------------------------------------------
    const warmupDeltas: number[] = [];
    const windowDeltas = new Map<number, number[]>();
    const windowFirstT = new Map<number, number>();
    const windowLastT = new Map<number, number>();
    let firstFrameT: number | null = null;
    let windowBaseT: number | null = null;
    let prevFrameT: number | null = null;

    const resourceSamples: Array<{ realSeconds: number; counts: ResourceCounts }> = [];
    const audioNodeSamples: Array<{ realSeconds: number; liveNodes: number; maxLiveNodes: number; nodeCreated: number; nodeStopped: number }> = [];
    const listenerSamples: Array<{ realSeconds: number; counts: Record<string, number | null> }> = [];
    const heapSamples: Array<{ realSeconds: number; usedJSHeapSize: number; totalJSHeapSize: number }> = [];
    const audioStateTimeline: Array<{ realSeconds: number; status: string; unlocked: boolean; muted: boolean; available: boolean; silenceSatisfied: boolean; terminalZeroAt: number | null; masterGain: number | null; phase: string | null }> = [];
    const readbackProbes: Array<{ realSeconds: number; ms: number | null; ok: boolean }> = [];
    const cadenceSamples: Array<{ realSeconds: number; performanceSeconds: number; steps: number; analysisRequests: number; publications: number; simStepsPerSecond: number; deliveredFps: number; overload: boolean; analysisBacklog: number }> = [];
    const nanSamples: Array<{ realSeconds: number; nonFinite: number }> = [];
    // Authoritative frame-time source: the app's own 240-frame diagnostics ring, sampled every
    // second and pooled per window. (The injected monitor below is used for *counting* frames and
    // detecting throttling; its percentiles carry polling overhead, so they are reported separately.)
    const warmupAppDeltas: number[] = [];
    const appWindowDeltas = new Map<number, number[]>();
    const deliveredSeries: Array<{ realSeconds: number; requested: number; delivered: number; ratio: number }> = [];
    const arcBoundaries: ArcBoundary[] = [];
    const anomalies: string[] = [];

    let lastArc = -1;
    let lastArcCheck = 0;
    let lastCadence = 0;
    let lastAppRing = 0;
    let lastNan = 0;
    let lastReadback = 0;
    let lastResource = 0;
    let lastListener = 0;
    let lastProgress = 0;
    let nanViolations = 0;
    let completedWindows = 0;
    const overloadSampleTimes: number[] = [];
    let warmupHeap: HeapShape | null = null;
    let lastAudioStatus: AudioStatus | null = null;
    let vanishedFrames = 0;
    let loopIterations = 0;

    const started = Date.now();
    const startedAtIso = new Date(started).toISOString();
    let status: 'completed' | 'aborted' = 'completed';
    let abortReason: string | null = null;

    const windowsJsonl = resolve(ARTIFACTS_DIR, 'soak2h', `windows-attempt${ATTEMPT}.jsonl`);
    const appendWindow = (record: unknown): void => {
      try {
        mkdirSync(resolve(ARTIFACTS_DIR, 'soak2h'), { recursive: true });
        appendFileSync(windowsJsonl, `${JSON.stringify(record)}\n`);
      } catch {
        /* progress is best-effort */
      }
    };

    const buildProgress = (elapsedMs: number): unknown => {
      // Cheap: never sort the whole pooled series here (that is ~400k numbers late in a 2 h run and
      // stalls the driver). Only the current window's deltas are summarised.
      const collected = warmupDeltas.length + [...windowDeltas.values()].reduce((sum, a) => sum + a.length, 0);
      const currentIndex = elapsedMs < WARMUP_MS ? -1 : Math.floor((elapsedMs - WARMUP_MS) / WINDOW_MS);
      const current = currentIndex >= 0 ? windowDeltas.get(currentIndex) ?? [] : [];
      return {
        attempt: ATTEMPT,
        generatedBy: 'tests/browser/soak2h.spec.ts (SOAK2H=1)',
        phase: elapsedMs >= WARMUP_MS ? 'soak' : 'warmup',
        requestedSeconds: DURATION_MS / 1000,
        elapsedSeconds: elapsedMs / 1000,
        updatedAtIso: new Date().toISOString(),
        framesCollected: collected,
        completedWindows,
        currentWindowFrames: current.length > 0 ? stats(current) : null,
        currentArc: lastArc,
        lastResourceCounts: resourceSamples.at(-1)?.counts ?? null,
        lastAudioStatus,
        lastHeapUsed: heapSamples.at(-1)?.usedJSHeapSize ?? null,
        nanViolations,
        pageErrors: pageErrors.count,
        audioSchedulingErrors,
        consoleErrors: consoleErrors.count,
      };
    };

    // One listener sample immediately, so even a very short run reports it.
    listenerSamples.push({ realSeconds: 0, counts: await listenerCounts(cdp) });

    // --- main loop ------------------------------------------------------------------------------
    try {
      while (Date.now() - started < DURATION_MS) {
        loopIterations += 1;
        const elapsed = Date.now() - started;

        // Frame monitor: re-install if a reload wiped it, then drain.
        const drained = await drainFrames();
        if (drained.length === 0) {
          const installed = await page.evaluate(() => Boolean((window as unknown as { __soak2h?: unknown }).__soak2h));
          if (!installed) {
            vanishedFrames += 1;
            await installMonitor();
          }
        }
        if (drained.length > 0) {
          if (firstFrameT === null) firstFrameT = drained[0]!;
          for (const t of drained) {
            if (windowBaseT === null && t >= firstFrameT + WARMUP_MS) windowBaseT = t;
            if (prevFrameT !== null && t > prevFrameT) {
              const delta = t - prevFrameT;
              // Reject absurd gaps (a stall or a monitor re-install): they are not delivered frames.
              if (delta < 2_000) {
                if (windowBaseT === null || t < windowBaseT) {
                  warmupDeltas.push(delta);
                } else {
                  const index = Math.floor((t - windowBaseT) / WINDOW_MS);
                  let bucket = windowDeltas.get(index);
                  if (!bucket) {
                    bucket = [];
                    windowDeltas.set(index, bucket);
                    windowFirstT.set(index, t);
                  }
                  bucket.push(delta);
                  windowLastT.set(index, t);
                }
              }
            }
            prevFrameT = t;
          }
        }

        if (elapsed - lastArcCheck >= ARC_CHECK_MS) {
          lastArcCheck = elapsed;
          const state = await hook<CuratorState>(page, 'curatorState');
          if (state.arc !== lastArc) {
            const log = await hook<Array<{ mode: string }>>(page, 'genesisLog');
            const clock = await hook<{ performanceSeconds: number }>(page, 'clock');
            const boundary: ArcBoundary = {
              arc: state.arc,
              performanceSeconds: clock.performanceSeconds,
              realSeconds: elapsed / 1000,
              genesisCount: log.length,
              rescueCount: log.filter((g) => g.mode === 'inject').length,
              stillState: state.stillState,
              movement: state.movement,
            };
            arcBoundaries.push(boundary);
            appendWindow({ kind: 'arc-boundary', attempt: ATTEMPT, ...boundary });
            lastArc = state.arc;
          }
        }

        if (elapsed - lastCadence >= CADENCE_MS) {
          lastCadence = elapsed;
          const clock = await hook<{ performanceSeconds: number; steps: number; speed: number }>(page, 'clock');
          const cadence = await hook<{ publications: number; analysisRequests: number; realSeconds: number; performanceSeconds: number }>(page, 'cadenceCounters');
          const diag = await hook<Diagnostics>(page, 'diagnostics');
          cadenceSamples.push({
            realSeconds: elapsed / 1000,
            performanceSeconds: cadence.performanceSeconds,
            steps: clock.steps,
            analysisRequests: cadence.analysisRequests,
            publications: cadence.publications,
            simStepsPerSecond: diag.simStepsPerSecond,
            deliveredFps: diag.deliveredFps,
            overload: diag.overload,
            analysisBacklog: diag.analysisBacklog,
          });
          // Delivered vs requested steps: requested assumes the app got every frame it asked for.
          const requestedSteps = PRESENTATION_SPEED * NOMINAL_STEPS_PER_SECOND * (elapsed / 1000);
          deliveredSeries.push({
            realSeconds: elapsed / 1000,
            requested: requestedSteps,
            delivered: clock.steps,
            ratio: requestedSteps > 0 ? clock.steps / requestedSteps : 0,
          });
          // Cross-check: the app's *own* internal frame-time ring is sampled on its own 1 s cadence.
          if (diag.overload) overloadSampleTimes.push(elapsed / 1000);
        }

        if (elapsed - lastAppRing >= APP_RING_MS) {
          lastAppRing = elapsed;
          const diag = await hook<Diagnostics>(page, 'diagnostics');
          const values = Array.isArray(diag.frameTimesMs) ? diag.frameTimesMs : [];
          if (values.length > 0) {
            if (elapsed < WARMUP_MS) {
              warmupAppDeltas.push(...values);
            } else {
              const index = Math.floor((elapsed - WARMUP_MS) / WINDOW_MS);
              const bucket = appWindowDeltas.get(index);
              if (bucket) bucket.push(...values);
              else appWindowDeltas.set(index, [...values]);
            }
          }
        }

        if (elapsed - lastNan >= NAN_CHECK_MS) {
          lastNan = elapsed;
          const field = await hook<{ nonFinite: number }>(page, 'fieldStats', [0.1]);
          nanSamples.push({ realSeconds: elapsed / 1000, nonFinite: field.nonFinite });
          if (field.nonFinite > 0) nanViolations += 1;
        }

        if (elapsed - lastReadback >= READBACK_PROBE_MS) {
          lastReadback = elapsed;
          // Time the round-trip *in the page* so the number is readback latency, not Playwright RPC.
          let measured: { ms: number | null; ok: boolean } = { ms: null, ok: false };
          try {
            measured = await page.evaluate(async (timeoutMs) => {
              const scope = window as unknown as { __artwork?: { analysisSampleForTest?: (t?: number) => Promise<unknown> } };
              const fn = scope.__artwork?.analysisSampleForTest;
              if (typeof fn !== 'function') return { ms: null, ok: false };
              const t0 = performance.now();
              const sample = await fn(timeoutMs);
              const t1 = performance.now();
              return { ms: t1 - t0, ok: sample !== null };
            }, READBACK_TIMEOUT_MS);
          } catch {
            measured = { ms: null, ok: false };
          }
          readbackProbes.push({ realSeconds: elapsed / 1000, ms: measured.ms, ok: measured.ok });
        }

        if (elapsed - lastResource >= RESOURCE_MS) {
          lastResource = elapsed;
          const counts = await hook<ResourceCounts>(page, 'resourceCounts');
          resourceSamples.push({ realSeconds: elapsed / 1000, counts });

          const audioStats = await hook<AudioStats | null>(page, 'audioStats');
          if (audioStats) {
            audioNodeSamples.push({
              realSeconds: elapsed / 1000,
              liveNodes: audioStats.nodes.liveNodes,
              maxLiveNodes: audioStats.nodes.maxLiveNodes,
              nodeCreated: audioStats.nodes.nodeCreated,
              nodeStopped: audioStats.nodes.nodeStopped,
            });
          }
          const audioStatus = await hook<AudioStatus>(page, 'audioStatus');
          const silence = await hook<{ satisfied: boolean; terminalZeroAt: number | null }>(page, 'silenceStatus');
          lastAudioStatus = audioStatus;
          audioStateTimeline.push({
            realSeconds: elapsed / 1000,
            status: audioStatus.status,
            unlocked: audioStatus.unlocked,
            muted: audioStatus.muted,
            available: audioStatus.available,
            silenceSatisfied: silence.satisfied,
            terminalZeroAt: silence.terminalZeroAt,
            masterGain: audioStats ? audioStats.masterGain : null,
            phase: audioStats ? audioStats.phase : null,
          });

          const heap = await readHeap(page);
          if (heap) heapSamples.push({ realSeconds: elapsed / 1000, usedJSHeapSize: heap.usedJSHeapSize, totalJSHeapSize: heap.totalJSHeapSize });
          if (warmupHeap === null && elapsed >= WARMUP_MS) warmupHeap = await readHeap(page);
        }

        if (elapsed - lastListener >= LISTENER_MS) {
          lastListener = elapsed;
          listenerSamples.push({ realSeconds: elapsed / 1000, counts: await listenerCounts(cdp) });
        }

        // Window bookkeeping + progress checkpoint.
        if (elapsed - lastProgress >= PROGRESS_MS) {
          lastProgress = elapsed;
          const currentIndex = elapsed < WARMUP_MS ? 0 : Math.floor((elapsed - WARMUP_MS) / WINDOW_MS);
          while (completedWindows < currentIndex) {
            const index = completedWindows;
            const deltas = windowDeltas.get(index) ?? [];
            if (deltas.length > 0) {
              const span = (windowLastT.get(index)! - windowFirstT.get(index)!) / 1000;
              appendWindow({
                kind: 'window',
                attempt: ATTEMPT,
                index,
                startRealSeconds: (WARMUP_MS + index * WINDOW_MS) / 1000,
                observedSeconds: span,
                deliveredFps: span > 0 ? deltas.length / span : 0,
                frames: stats(appWindowDeltas.get(index) ?? []),
                injectedMonitorFrames: stats(deltas),
              });
            }
            completedWindows += 1;
          }
          writeJson('soak2h/progress.json', buildProgress(elapsed));
        }

        // Pace the polling loop. Without this the loop is RPC-bound and polls far faster than the
        // documented cadence, which itself displaces frames (measured: see README / the acceptance run).
        await page.waitForTimeout(POLL_MS);
      }
    } catch (error) {
      status = 'aborted';
      abortReason = String(error);
    }

    // --- finalize --------------------------------------------------------------------------------
    const elapsedMs = Date.now() - started;
    const endedAtIso = new Date().toISOString();

    const finalResources = await hook<ResourceCounts>(page, 'resourceCounts').catch(() => null);
    const finalAudioStats = await hook<AudioStats | null>(page, 'audioStats').catch(() => null);
    const finalAudioStatus = await hook<AudioStatus>(page, 'audioStatus').catch(() => null);
    const finalPresenterStats = await hook<{ requests: number; results: number; stale: number; errors: number; skips: number; terminations: number; ignored: number; slots: number; free: number }>(page, 'presenterStats').catch(() => null);
    const finalAnalysisDiagnostics = await hook<{ floatFormat: string; requests: number; samples: number; staleDrops: number; nullFenceDrops: number; packSaturatedSamples: number; packSaturated: boolean }>(page, 'analysisDiagnostics').catch(() => null);
    const finalHeap = await readHeap(page).catch(() => null);
    const finalClock = await hook<{ performanceSeconds: number; steps: number; speed: number; simulationTime: number }>(page, 'clock').catch(() => null);
    const genesisLog = await hook<Array<{ mode: string; kind: string }>>(page, 'genesisLog').catch(() => []);
    const extinctionLog = await hook<Array<{ action: string; movement: string }>>(page, 'extinctionLog').catch(() => []);
    const contextLossCount = await hook<number>(page, 'contextLossCount').catch(() => 0);
    const contextLost = await hook<boolean>(page, 'contextLost').catch(() => false);
    const diagnostics = await hook<Diagnostics>(page, 'diagnostics').catch(() => null);
    if (finalResources) resourceSamples.push({ realSeconds: elapsedMs / 1000, counts: finalResources });
    if (finalHeap) heapSamples.push({ realSeconds: elapsedMs / 1000, usedJSHeapSize: finalHeap.usedJSHeapSize, totalJSHeapSize: finalHeap.totalJSHeapSize });

    // Frame-time windows. `frames` is the authoritative app-owned ring; `injectedMonitorFrames`
    // carries the polling overhead and is reported only for the delivered-fps / throttle witness.
    const windowIndices = [...new Set([...windowDeltas.keys(), ...appWindowDeltas.keys()])].sort((a, b) => a - b);
    const frameWindows = windowIndices.map((index) => {
      const monitorDeltas = windowDeltas.get(index) ?? [];
      const appDeltas = appWindowDeltas.get(index) ?? [];
      const span =
        windowFirstT.has(index) && windowLastT.has(index)
          ? (windowLastT.get(index)! - windowFirstT.get(index)!) / 1000
          : 0;
      return {
        index,
        startRealSeconds: (WARMUP_MS + index * WINDOW_MS) / 1000,
        observedSeconds: span,
        complete: span >= (WINDOW_MS / 1000) * 0.9,
        deliveredFps: span > 0 ? monitorDeltas.length / span : 0,
        frames: stats(appDeltas),
        appRingSampleCount: appDeltas.length,
        injectedMonitorFrames: stats(monitorDeltas),
      };
    });
    const judgedWindows = frameWindows.filter((w) => w.complete);
    const windowsForVerdict = judgedWindows.length > 0 ? judgedWindows : frameWindows;
    const steadyStateWindows = windowsForVerdict.filter((w) => w.index >= 1);
    const worstByP99 = windowsForVerdict.reduce<null | (typeof windowsForVerdict)[number]>(
      (worst, w) => (worst === null || w.frames.p99 > worst.frames.p99 ? w : worst),
      null,
    );
    const worstByP50 = windowsForVerdict.reduce<null | (typeof windowsForVerdict)[number]>(
      (worst, w) => (worst === null || w.frames.p50 > worst.frames.p50 ? w : worst),
      null,
    );
    const overall = stats([...appWindowDeltas.values()].flat());
    const warmup = stats(warmupAppDeltas);
    const injectedMonitorOverall = stats([...warmupDeltas, ...windowDeltas.values()].flat());

    // Readback latency percentiles.
    const readbackLatencies = readbackProbes.filter((p) => p.ms !== null).map((p) => p.ms!);
    const readback = stats(readbackLatencies);
    const readbackMisses = readbackProbes.filter((p) => !p.ok).length;

    // Analysis cadence (requests/second between consecutive cadence samples).
    const cadenceIntervals: number[] = [];
    for (let i = 1; i < cadenceSamples.length; i += 1) {
      const dt = cadenceSamples[i]!.realSeconds - cadenceSamples[i - 1]!.realSeconds;
      if (dt > 1) cadenceIntervals.push((cadenceSamples[i]!.analysisRequests - cadenceSamples[i - 1]!.analysisRequests) / dt);
    }
    const cadenceStats = stats(cadenceIntervals);

    // Resource deltas and slopes.
    const resourceKeys: Array<keyof ResourceCounts> = ['textures', 'framebuffers', 'renderbuffers', 'programs', 'shaders', 'vertexArrays', 'buffers'];
    const resourceDeltas: Record<string, number> = {};
    const resourceSlopes: Record<string, number> = {};
    for (const key of resourceKeys) {
      const points = resourceSamples.map((s) => ({ t: s.realSeconds, v: s.counts[key] }));
      resourceDeltas[key] = points.length > 1 ? points[points.length - 1]!.v - points[0]!.v : 0;
      resourceSlopes[key] = slopePerMinute(points);
    }
    const audioNodeSlopes = {
      liveNodes: slopePerMinute(audioNodeSamples.map((s) => ({ t: s.realSeconds, v: s.liveNodes }))),
      maxLiveNodes: slopePerMinute(audioNodeSamples.map((s) => ({ t: s.realSeconds, v: s.maxLiveNodes }))),
    };
    const audioNodeDelta = audioNodeSamples.length > 1 ? audioNodeSamples[audioNodeSamples.length - 1]!.liveNodes - audioNodeSamples[0]!.liveNodes : 0;
    const listenerDeltas: Record<string, number | null> = { window: null, document: null, canvas: null };
    if (listenerSamples.length > 1) {
      const first = listenerSamples[0]!.counts;
      const last = listenerSamples[listenerSamples.length - 1]!.counts;
      for (const key of Object.keys(listenerDeltas)) {
        listenerDeltas[key] = first[key] !== null && last[key] !== null ? (last[key] as number) - (first[key] as number) : null;
      }
    }

    // Heap growth after warmup.
    const heapBaseline = warmupHeap ?? heapSamples.find((s) => s.realSeconds >= WARMUP_MS / 1000) ?? heapSamples[0] ?? null;
    const heapGrowthFraction =
      heapBaseline && finalHeap && heapBaseline.usedJSHeapSize > 0
        ? (finalHeap.usedJSHeapSize - heapBaseline.usedJSHeapSize) / heapBaseline.usedJSHeapSize
        : null;
    // AC.14's heap criterion means "bounded memory / no leak", but `performance.memory` is a coarse
    // readout that oscillates by tens of percent within a single run (GC and allocator timing), so one
    // baseline sample against one final sample is not a leak test: across two 120-minute runs of this
    // artwork the endpoint metric swung from −36% to +20% with no relevant code change. The pass is
    // therefore taken on the **trend** — the median of the last 10 minutes against the median of the
    // first 10 minutes after warmup — with the endpoint number and the regression slope still reported.
    const medianOf = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!;
    };
    const postWarmupHeap = heapSamples.filter((s) => s.realSeconds >= WARMUP_MS / 1000);
    const heapFirstTen = postWarmupHeap.filter((s) => s.realSeconds < WARMUP_MS / 1000 + 600).map((s) => s.usedJSHeapSize);
    const heapLastTen = postWarmupHeap.filter((s) => s.realSeconds >= elapsedMs / 1000 - 600).map((s) => s.usedJSHeapSize);
    const heapFirstTenMedian = heapFirstTen.length > 0 ? medianOf(heapFirstTen) : null;
    const heapLastTenMedian = heapLastTen.length > 0 ? medianOf(heapLastTen) : null;
    const heapRobustGrowthFraction =
      heapFirstTenMedian && heapLastTenMedian && heapFirstTenMedian > 0
        ? (heapLastTenMedian - heapFirstTenMedian) / heapFirstTenMedian
        : null;
    const heapSeries = postWarmupHeap.map((s) => ({ t: s.realSeconds, v: s.usedJSHeapSize }));
    const heapSlopePerHour = slopePerMinute(heapSeries) * 60;
    const heapMin = postWarmupHeap.length > 0 ? Math.min(...postWarmupHeap.map((s) => s.usedJSHeapSize)) : null;
    const heapMax = postWarmupHeap.length > 0 ? Math.max(...postWarmupHeap.map((s) => s.usedJSHeapSize)) : null;

    // Delivered vs requested summary.
    const ratioStats = stats(deliveredSeries.map((s) => s.ratio));
    const simStepsSeries = stats(cadenceSamples.map((s) => s.simStepsPerSecond));
    const overloadSamples = overloadSampleTimes.length;
    const overloadAfterWarmup = overloadSampleTimes.filter((t) => t * 1000 >= WARMUP_MS).length;
    const appRing = overall;

    // --- verdict --------------------------------------------------------------------------------
    const evaluateTier = (tier: keyof typeof TIERS): { framePass: boolean; stepsPass: boolean } => {
      const t = TIERS[tier];
      const framePass =
        windowsForVerdict.length > 0 &&
        windowsForVerdict.every((w) => w.frames.p50 <= t.p50 && w.frames.p95 <= t.p95 && w.frames.p99 <= t.p99);
      const stepsPass = t.minDeliveredStepsPerSecond === 0 || simStepsSeries.p50 >= t.minDeliveredStepsPerSecond;
      return { framePass, stepsPass };
    };
    const tier60 = evaluateTier('60fps');
    const tier30 = evaluateTier('30fps-fallback');
    const resourceBounded =
      resourceKeys.every((key) => resourceDeltas[key] === 0) &&
      (audioNodeSamples.length === 0 || audioNodeDelta === 0) &&
      Object.values(listenerDeltas).every((d) => d === null || d === 0);
    const heapPass =
      heapRobustGrowthFraction !== null
        ? heapRobustGrowthFraction < 0.1
        : heapGrowthFraction === null || heapGrowthFraction < 0.1;

    // Readback: the soak probe issues an *extra* sample that competes with the app's own cadence on the
    // three-slot PBO ring, and it is bounded by its own timeout. When it saturates that timeout (or the
    // ring is full) the p95 is a clipped lower bound and cannot adjudicate AC.14's 250 ms criterion —
    // so the check reports `null` (not adjudicable) instead of a misleading pass/fail.
    const readbackClipped = readbackLatencies.filter((v) => v >= READBACK_TIMEOUT_MS - 5).length;
    const readbackAdjudicable = readbackLatencies.length > 0 && readbackClipped === 0 && readbackMisses === 0;
    const readbackPass: boolean | null = readbackAdjudicable ? readback.p95 <= 250 : null;

    const runIntegrity = {
      completed: status === 'completed',
      pageErrors: pageErrors.count,
      pageErrorSamples: pageErrors.snapshot(),
      audioSchedulingErrors,
      consoleErrors: consoleErrors.count,
      consoleErrorSamples: consoleErrors.snapshot(),
      nanViolations,
      pass: status === 'completed' && pageErrors.count === 0 && consoleErrors.count === 0 && nanViolations === 0,
    };

    const checks: Record<string, { value: unknown; threshold: string; pass: boolean }> = {
      'frameTime-60fps': {
        value: worstByP99 ? { worstWindow: worstByP99.index, p50: worstByP50?.frames.p50 ?? null, p95: worstByP99.frames.p95, p99: worstByP99.frames.p99 } : null,
        threshold: 'every 5-min window p50 ≤ 17 / p95 ≤ 22 / p99 ≤ 34 ms',
        pass: tier60.framePass,
      },
      'frameTime-30fps-fallback': {
        value: worstByP99 ? { worstWindow: worstByP99.index, p50: worstByP50?.frames.p50 ?? null, p95: worstByP99.frames.p95, p99: worstByP99.frames.p99 } : null,
        threshold: 'every 5-min window p50 ≤ 34 / p95 ≤ 40 / p99 ≤ 67 ms, ≥ 96 delivered steps/s',
        pass: tier30.framePass && tier30.stepsPass,
      },
      readbackLatency: {
        value: {
          p50: readback.p50,
          p95: readback.p95,
          p99: readback.p99,
          samples: readback.n,
          misses: readbackMisses,
          clippedAtProbeTimeout: readbackClipped,
          probeTimeoutMs: READBACK_TIMEOUT_MS,
        },
        threshold: 'readback latency p95 ≤ 250 ms, backlog ≤ 1',
        pass: readbackPass === true && (diagnostics ? diagnostics.analysisBacklog <= 1 : true),
      },
      resourceSlopes: {
        value: { resourceDeltas, resourceSlopesPerMinute: resourceSlopes, audioNodeDelta, audioNodeSlopes, listenerDeltas },
        threshold: 'resource slopes ≈ 0 (no growth in GL objects, live audio nodes, event listeners)',
        pass: resourceBounded,
      },
      heap: {
        value: { warmupBaselineBytes: heapBaseline?.usedJSHeapSize ?? null, finalBytes: finalHeap?.usedJSHeapSize ?? null, growthFraction: heapGrowthFraction },
        threshold: 'heap growth < 10% after warmup',
        pass: heapPass,
      },
    };

    // AC.14's frame-time tier is judged on the app-owned ring + the resource + heap discipline.
    // Readback is reported separately and is NOT folded into the tier: the soak probe cannot adjudicate
    // the 250 ms criterion (see readbackAdjudicable above).
    let frameTimeTier: '60fps' | '30fps-fallback' | 'none' = 'none';
    if (tier60.framePass && resourceBounded && heapPass) frameTimeTier = '60fps';
    else if (tier30.framePass && tier30.stepsPass && resourceBounded && heapPass) frameTimeTier = '30fps-fallback';
    const achievedTier = frameTimeTier;

    if (status === 'aborted') anomalies.push(`run aborted before the requested duration: ${abortReason}`);
    if (frameWindows.some((w) => !w.complete)) anomalies.push('the trailing frame-time window is partial (shorter than 5 minutes) and was excluded from the verdict');
    if (vanishedFrames > 0) anomalies.push(`the in-page frame monitor vanished ${vanishedFrames}× and was re-installed (a page reload would explain this)`);
    if (readbackMisses > 0) anomalies.push(`${readbackMisses} readback probes returned no sample (analyzer busy or timed out)`);
    const throttled = frameWindows.filter((w) => w.complete && w.deliveredFps < 45);
    if (throttled.length > 0) anomalies.push(`${throttled.length} window(s) delivered < 45 fps — possible rAF throttling`);
    if (overloadAfterWarmup > 0) anomalies.push(`the app reported 'overload' in ${overloadAfterWarmup} post-warmup cadence sample(s)`);
    if (nanViolations > 0) anomalies.push(`${nanViolations} sample(s) contained non-finite field cells`);
    if (audioSchedulingErrors > 0) {
      anomalies.push(
        `${audioSchedulingErrors} uncaught AudioParam scheduling error(s) on the live audio path ` +
          '(setTargetAtTime overlaps setValueCurveAtTime) — see verdict.runIntegrity.pageErrorSamples',
      );
    }
    for (const key of Object.keys(listenerDeltas)) {
      if (listenerDeltas[key] === null && listenerSamples.length > 1) anomalies.push(`event-listener count for '${key}' was not exposed by CDP in this run`);
    }
    if (!readbackAdjudicable) {
      anomalies.push(
        `the readback latency probe is not adjudicable (${readbackClipped} probe(s) hit its ${READBACK_TIMEOUT_MS} ms ` +
          `timeout, ${readbackMisses} miss(es)) — AC.14's 250 ms readback criterion is NOT demonstrated by this run`,
      );
    }

    const report_ = {
      generatedBy: 'tests/browser/soak2h.spec.ts (SOAK2H=1) — AC.14 two-hour real-time presentation soak',
      attempt: ATTEMPT,
      status,
      abortReason,
      startedAtIso,
      endedAtIso,
      requestedDurationSeconds: DURATION_MS / 1000,
      measuredWallClockSeconds: elapsedMs / 1000,
      configuration: {
        seed: SEED,
        grid: `${grid.width}x${grid.height}`,
        speed: PRESENTATION_SPEED,
        nominalStepsPerSecond: NOMINAL_STEPS_PER_SECOND,
        intendedStepsPerSecond: PRESENTATION_SPEED * NOMINAL_STEPS_PER_SECOND,
        viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
        canvas: `${canvasSize.width}x${canvasSize.height}`,
        scene: `${sceneSize.width}x${sceneSize.height}`,
        renderer: capability.renderer,
        softwareRenderer: capability.softwareRenderer,
        userAgent,
        harnessArgs: 'channel=chromium headless --use-angle=vulkan + anti-throttling/autoplay/precise-memory flags',
        warmupSeconds: WARMUP_MS / 1000,
      },
      harness: {
        loop: {
          iterations: loopIterations,
          measuredSeconds: elapsedMs / 1000,
          iterationsPerSecond: loopIterations / (elapsedMs / 1000),
        },
        cadenceMs: {
          poll: POLL_MS,
          appRing: APP_RING_MS,
          cadence: CADENCE_MS,
          nanCheck: NAN_CHECK_MS,
          readbackProbe: READBACK_PROBE_MS,
          resource: RESOURCE_MS,
          listener: LISTENER_MS,
          progress: PROGRESS_MS,
          readbackProbeTimeout: READBACK_TIMEOUT_MS,
        },
      },
      audio: {
        unlockNote: audioUnlockNote,
        finalStatus: finalAudioStatus,
        finalStats: finalAudioStats,
        stateTimeline: audioStateTimeline,
        nodeSamples: audioNodeSamples,
        nodeSlopesPerMinute: audioNodeSlopes,
      },
      frameTiming: {
        overall,
        warmup,
        windows: frameWindows,
        appInternalRing: { ...appRing, note: "the app's own 240-frame diagnostics ring, sampled every 1 s and pooled — the authoritative frame-time source (AC.14 §11.1 rAF intervals)" },
        injectedMonitorOverall: {
          ...injectedMonitorOverall,
          note: 'the injected rAF monitor, used for frame counting / throttling; its percentiles include Playwright polling overhead and are NOT the AC.14 authority',
        },
        judgedWindowCount: judgedWindows.length,
        steadyStateWindowCount: steadyStateWindows.length,
        worstWindowByP99: worstByP99,
        worstWindowByP50: worstByP50,
      },
      readback: {
        probes: readbackProbes,
        percentiles: readback,
        misses: readbackMisses,
        analysisCadencePerSecond: cadenceStats,
        finalPresenterStats,
        finalAnalysisDiagnostics,
      },
      resources: {
        start: resourceSamples[0]?.counts ?? null,
        end: finalResources,
        deltas: resourceDeltas,
        slopesPerMinute: resourceSlopes,
        samplesEverySeconds: RESOURCE_MS / 1000,
        samples: resourceSamples,
        eventListeners: { samples: listenerSamples, deltas: listenerDeltas },
      },
      heap: {
        exposed: finalHeap !== null,
        warmupBaseline: heapBaseline,
        final: finalHeap,
        growthFraction: heapGrowthFraction,
        robustGrowthFraction: heapRobustGrowthFraction,
        firstTenMinutesMedianBytes: heapFirstTenMedian,
        lastTenMinutesMedianBytes: heapLastTenMedian,
        slopePerHourBytes: heapSlopePerHour,
        postWarmupMinBytes: heapMin,
        postWarmupMaxBytes: heapMax,
        samples: heapSamples,
        note:
          'performance.memory with --enable-precise-memory-info; still a coarse process-wide readout. ' +
          'The AC.14 pass uses `robustGrowthFraction` (last-10-minute median vs first-10-minute median after ' +
          'warmup) because `growthFraction` (one baseline sample vs one final sample) swings with GC timing.',
      },
      arcs: {
        count: Math.max(0, ...arcBoundaries.map((b) => b.arc)),
        boundaries: arcBoundaries,
        genesisByMode: {
          replace: genesisLog.filter((g) => g.mode === 'replace').length,
          inject: genesisLog.filter((g) => g.mode === 'inject').length,
          total: genesisLog.length,
        },
        extinctionByAction: {
          rescue: extinctionLog.filter((e) => e.action === 'rescue').length,
          recovery: extinctionLog.filter((e) => e.action === 'recovery').length,
          none: extinctionLog.filter((e) => e.action === 'none').length,
          total: extinctionLog.length,
        },
      },
      resets: {
        contextLossCount,
        contextLost,
        genesisTotal: genesisLog.length,
        rescues: genesisLog.filter((g) => g.mode === 'inject').length,
      },
      deliveredVsRequested: {
        series: deliveredSeries,
        ratio: ratioStats,
        simulatedStepsPerSecond: simStepsSeries,
        overloadSamples,
        overloadAfterWarmup,
        overloadSampleTimes,
        finalClock,
        finalDiagnostics: diagnostics,
      },
      nan: { violations: nanViolations, samples: nanSamples },
      errors: { pageErrors: pageErrors.snapshot(), consoleErrors: consoleErrors.snapshot(), audioSchedulingErrors },
      verdict: {
        thresholds: {
          tier: frameTimeTier,
          checks,
          tierEvaluations: { tier60, tier30, resourceBounded, heapPass },
        },
        readbackProbe: {
          adjudicable: readbackAdjudicable,
          clippedAtProbeTimeout: readbackClipped,
          misses: readbackMisses,
          pass: readbackPass,
        },
        runIntegrity,
        accepted: frameTimeTier !== 'none' && readbackPass === true && runIntegrity.pass,
      },
      anomalies,
      artifactsDir: ARTIFACTS_DIR,
    };

    writeJson('soak2h/report.json', report_);
    writeJson('soak2h/summary.json', {
      attempt: ATTEMPT,
      status,
      achievedTier,
      accepted: report_.verdict.accepted,
      measuredWallClockSeconds: report_.measuredWallClockSeconds,
      arcs: report_.arcs.count,
      worstWindow: worstByP99,
      overall,
      warmup,
      appInternalRing: appRing,
      readback,
      resourceDeltas,
      resourceSlopesPerMinute: resourceSlopes,
      audioNodeDelta,
      listenerDeltas,
      heapGrowthFraction,
      nanViolations,
      pageErrors: pageErrors.count,
      audioSchedulingErrors,
      consoleErrors: consoleErrors.count,
      overloadSamples,
      overloadAfterWarmup,
      anomalies,
    });
    writeJson('soak2h/progress.json', buildProgress(elapsedMs));

    // --- assertions -----------------------------------------------------------------------------
    // The report above is the deliverable and is written before these, so a failing assertion still
    // leaves the complete evidence on disk.
    expect(status, `the soak ran to completion (aborted: ${abortReason})`).toBe('completed');
    expect(achievedTier, 'the soak passes at least one AC.14 threshold tier').not.toBe('none');
    expect(
      runIntegrity.pass,
      `run integrity (${pageErrors.count} page error(s), ${consoleErrors.count} console error(s), ` +
        `${nanViolations} NaN sample(s)): ${pageErrors.snapshot().head.join(' | ')}`,
    ).toBe(true);
  });
});
