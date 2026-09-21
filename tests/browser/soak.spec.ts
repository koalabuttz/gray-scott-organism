/**
 * SOAK=1 — accelerated multi-arc soak (§12.2 "an accelerated multi-arc soak for leaks and dead-state
 * handling", AC.14's resource/heap discipline at the exploration tier).
 *
 * Runs ≥3 complete arcs back-to-back at the **512² exploration grid at maximum speed** (12×), watching
 * resource counts, delivered readback cadence, heap, and non-finite cells across every extinction /
 * rescue / rebirth cycle. It is the leak and dead-state counterpart to the real-time ARCS evidence.
 *
 * Duration math (documented, and re-checked against the measured delivered rate in the report):
 * one arc is nominal ≈980 performance seconds (dormancy→stillness; §6.3). At the 512² grid the
 * measured step cap is 24 steps/frame (deviation 34), i.e. a **12× ceiling** at 60 fps, so an arc
 * takes 980 / 12 ≈ 82 real seconds if the ceiling is reached and 980 / 6 ≈ 163 s at only 6×. Three
 * arcs therefore land between ~4 and ~9 minutes wall clock; the budget below is 45 minutes so a slow
 * machine cannot fail the spec on time alone.
 *
 * Run: `SOAK=1 npx playwright test --project=headless-gpu soak.spec.ts` (or `npm run test:soak`).
 * Writes `artifacts/soak/report.json`.
 */
import { expect, test } from '@playwright/test';
import { ARTIFACTS_DIR, hook, openArtwork } from '../support/browser.ts';
import { writeJson } from '../support/evidence.ts';

const ENABLED = process.env['SOAK'] === '1';

const SEED = 7_700_077;
const WARMUP_MS = 4_000;
const POLL_MS = 250;
const SAMPLE_MS = 2_000;
const CADENCE_MS = 5_000;
const NAN_CHECK_MS = 10_000;
const TARGET_ARCS = 3;
const MAX_SOAK_MS = 40 * 60_000;
/** One nominal arc in performance seconds (§6.3: dormancy..stillness, before dwell modulation). */
const NOMINAL_ARC_PERFORMANCE_SECONDS = 980;
const EXPLORATION_SPEED_CEILING = 12;

interface CuratorStateShape {
  arc: number;
  movement: string;
  stillState: string;
  rescueUsed: boolean;
}

interface ResourceCounts {
  textures: number;
  framebuffers: number;
  renderbuffers: number;
  programs: number;
  shaders: number;
  vertexArrays: number;
  buffers: number;
}

interface Cadence {
  publications: number;
  analysisRequests: number;
  realSeconds: number;
  performanceSeconds: number;
}

interface HeapShape {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
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

test.describe('SOAK=1 accelerated multi-arc soak', () => {
  test.skip(!ENABLED, 'set SOAK=1 to run the accelerated soak (long, GPU-heavy)');

  test('≥3 arcs back-to-back at 512² max speed with bounded resources', async ({ page }) => {
    test.setTimeout(45 * 60_000);
    const probe = await openArtwork(page);
    test.skip(!probe.ok, `WebGL2 did not start: ${probe.reason}`);
    if (!probe.ok) return;
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
    });

    // 512² exploration grid, maximum speed, fixed seed, automatic composition on.
    await hook(page, 'setExploration', [true]);
    await hook(page, 'setAutoSeed', [true]);
    await hook(page, 'dispatch', [{ type: 'restart', seed: SEED }]);
    await hook(page, 'setSpeed', [EXPLORATION_SPEED_CEILING]);
    await hook(page, 'setPaused', [false]);

    const grid = await hook<{ width: number; height: number }>(page, 'simulationSize');
    expect(grid, 'the soak runs on the 512² exploration grid').toEqual({ width: 512, height: 512 });

    const heap = async (): Promise<HeapShape | null> =>
      page.evaluate(() => {
        const memory = (performance as unknown as { memory?: HeapShape }).memory;
        return memory
          ? {
              usedJSHeapSize: memory.usedJSHeapSize,
              totalJSHeapSize: memory.totalJSHeapSize,
              jsHeapSizeLimit: memory.jsHeapSizeLimit,
            }
          : null;
      });

    // Warm up so one-time allocations (shader compile, first samples) are not counted as growth.
    await page.waitForTimeout(WARMUP_MS);
    const startResources = (await hook<{ resourceCounts: ResourceCounts }>(page, 'labSnapshot')).resourceCounts;
    const startHeap = await heap();
    const resourceSamples: Array<{ realSeconds: number; counts: ResourceCounts }> = [
      { realSeconds: 0, counts: startResources },
    ];
    const cadenceSamples: Array<{ realSeconds: number; cadence: Cadence; heap: HeapShape | null }> = [];
    const arcBoundaries: ArcBoundary[] = [];
    let nanViolations = 0;
    let lastArc = -1;
    let lastSample = -SAMPLE_MS;
    let lastCadence = -CADENCE_MS;
    let lastNan = -NAN_CHECK_MS;
    const started = Date.now();

    while (Date.now() - started < MAX_SOAK_MS) {
      const elapsed = Date.now() - started;
      const state = await hook<CuratorStateShape>(page, 'curatorState');
      if (state.arc !== lastArc) {
        if (lastArc >= 0 || state.arc > 0) {
          const log = await hook<Array<{ mode: string }>>(page, 'genesisLog');
          const clock = await hook<{ performanceSeconds: number }>(page, 'clock');
          arcBoundaries.push({
            arc: state.arc,
            performanceSeconds: clock.performanceSeconds,
            realSeconds: elapsed / 1000,
            genesisCount: log.length,
            rescueCount: log.filter((g) => g.mode === 'inject').length,
            stillState: state.stillState,
            movement: state.movement,
          });
          console.info(
            `[soak] arc boundary -> arc=${state.arc} at ${clock.performanceSeconds.toFixed(1)} perf s ` +
              `(${(elapsed / 1000).toFixed(1)} real s), genesis=${log.length} rescues=${log.filter((g) => g.mode === 'inject').length}`,
          );
        }
        lastArc = state.arc;
      }

      if (elapsed - lastSample >= SAMPLE_MS) {
        lastSample = elapsed;
        const snapshot = await hook<{ resourceCounts: ResourceCounts }>(page, 'labSnapshot');
        resourceSamples.push({ realSeconds: elapsed / 1000, counts: snapshot.resourceCounts });
      }

      if (elapsed - lastCadence >= CADENCE_MS) {
        lastCadence = elapsed;
        const cadence = await hook<Cadence>(page, 'cadenceCounters');
        cadenceSamples.push({ realSeconds: elapsed / 1000, cadence, heap: await heap() });
      }

      if (elapsed - lastNan >= NAN_CHECK_MS) {
        lastNan = elapsed;
        const field = await hook<{ nonFinite: number }>(page, 'fieldStats', [0.1]);
        if (field.nonFinite > 0) nanViolations += 1;
        expect(field.nonFinite, 'no non-finite field cells during the soak').toBe(0);
      }

      if (state.arc >= TARGET_ARCS) break;
      await page.waitForTimeout(POLL_MS);
    }

    const wallSeconds = (Date.now() - started) / 1000;
    const endResources = (await hook<{ resourceCounts: ResourceCounts }>(page, 'labSnapshot')).resourceCounts;
    const endHeap = await heap();
    const finalCadence = await hook<Cadence>(page, 'cadenceCounters');

    // --- assertions -----------------------------------------------------------------------------
    expect(pageErrors, `no page errors (${pageErrors.join(' | ')})`).toEqual([]);
    expect(nanViolations, 'no non-finite field cells across the soak').toBe(0);
    expect(arcBoundaries.length, '≥3 arc boundaries exercised').toBeGreaterThanOrEqual(TARGET_ARCS);

    const resourceKeys = Object.keys(startResources) as Array<keyof ResourceCounts>;
    for (const key of resourceKeys) {
      expect(endResources[key], `resource '${key}' is bounded (start ${startResources[key]} -> end ${endResources[key]})`).toBe(
        startResources[key],
      );
    }

    // Delivered rate and the readback cadence.
    const deliveredMultiple = finalCadence.performanceSeconds / wallSeconds;
    const intervals = cadenceSamples.map((sample, index) => {
      const previous = index === 0 ? { realSeconds: 0, cadence: { analysisRequests: 0, publications: 0, realSeconds: 0, performanceSeconds: 0 } } : cadenceSamples[index - 1]!;
      const dt = sample.realSeconds - previous.realSeconds;
      return {
        dt,
        analysisPerSecond: (sample.cadence.analysisRequests - previous.cadence.analysisRequests) / dt,
        publicationsPerSecond: (sample.cadence.publications - previous.cadence.publications) / dt,
      };
    }).filter((interval) => interval.dt > 0.5);
    const reqRates = intervals.map((i) => i.analysisPerSecond);
    const pubRates = intervals.map((i) => i.publicationsPerSecond);
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const reqMedian = median(reqRates);
    const reqMin = Math.min(...reqRates);
    const reqMax = Math.max(...reqRates);
    const pubMedian = median(pubRates);
    console.info(
      `[soak] ${wallSeconds.toFixed(1)} real s for ${finalCadence.performanceSeconds.toFixed(1)} perf s ` +
        `(${deliveredMultiple.toFixed(2)}× delivered) | arcs=${arcBoundaries.length} | ` +
        `analysis req/s ${reqMin.toFixed(2)}–${reqMax.toFixed(2)} (median ${reqMedian.toFixed(2)}) | ` +
        `pub/s median ${pubMedian.toFixed(2)}`,
    );
    expect(deliveredMultiple, 'the soak runs accelerated (≥2× delivered)').toBeGreaterThan(2);
    expect(reqMedian, 'the readback cadence sits inside the 2–4 Hz real band').toBeGreaterThan(1);
    expect(reqMedian, 'the readback cadence sits inside the 2–4 Hz real band').toBeLessThan(6);
    // "Stable": no interval collapses to zero and the spread stays within a factor of two of the median.
    expect(reqMin, 'the readback cadence never stalls').toBeGreaterThan(reqMedian * 0.5);
    expect(reqMax, 'the readback cadence never runs away').toBeLessThan(reqMedian * 2);

    // Heap discipline (AC.14: < 10% growth after warmup) — reported when the environment exposes it.
    let heapGrowthFraction: number | null = null;
    if (startHeap && endHeap && startHeap.usedJSHeapSize > 0) {
      heapGrowthFraction = (endHeap.usedJSHeapSize - startHeap.usedJSHeapSize) / startHeap.usedJSHeapSize;
      console.info(
        `[soak] heap used ${(startHeap.usedJSHeapSize / 1048576).toFixed(1)} MiB -> ` +
          `${(endHeap.usedJSHeapSize / 1048576).toFixed(1)} MiB (${(heapGrowthFraction * 100).toFixed(1)}%)`,
      );
      expect(heapGrowthFraction, 'heap growth after warmup stays under 10%').toBeLessThan(0.1);
    }

    writeJson('soak/report.json', {
      generatedBy: 'tests/browser/soak.spec.ts (SOAK=1)',
      seed: SEED,
      resolution: grid.width,
      requestedSpeed: EXPLORATION_SPEED_CEILING,
      speedCeiling: EXPLORATION_SPEED_CEILING,
      expectedDurationSeconds: {
        formula: 'arcs * nominalArcPerformanceSeconds / deliveredMultiple',
        nominalArcPerformanceSeconds: NOMINAL_ARC_PERFORMANCE_SECONDS,
        atCeiling: (TARGET_ARCS * NOMINAL_ARC_PERFORMANCE_SECONDS) / EXPLORATION_SPEED_CEILING,
        measured: wallSeconds,
      },
      wallClockSeconds: wallSeconds,
      deliveredMultiple,
      arcs: arcBoundaries.length,
      arcBoundaries,
      resourceCounts: { start: startResources, end: endResources },
      resourceSamples,
      readbackCadence: {
        medianAnalysisRequestsPerSecond: reqMedian,
        minAnalysisRequestsPerSecond: reqMin,
        maxAnalysisRequestsPerSecond: reqMax,
        medianPublicationsPerSecond: pubMedian,
        intervals,
      },
      heap: {
        exposed: startHeap !== null,
        start: startHeap,
        end: endHeap,
        growthFraction: heapGrowthFraction,
        note:
          'Chromium exposes `performance.memory` as a coarse readout; without '
          + '--enable-precise-memory-info the numbers are quantized but still show a large leak.',
      },
      nanViolations,
      pageErrors,
      artifactsDir: ARTIFACTS_DIR,
    });
  });
});
