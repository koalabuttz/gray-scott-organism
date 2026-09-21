/**
 * §7.3 topology-like analysis (Phase 3, tier-2).
 *
 * The reduced presentation V field is thresholded at .08, .12 and .16. At each threshold the
 * foreground is **4-connected** and the background **8-connected** (the complementary connectivity
 * that avoids diagonal ambiguity); foreground components smaller than three reduced pixels are
 * removed as isolated artifacts, and background components that neither touch the domain boundary nor
 * reach three pixels are not holes. These are **planar, reduced-resolution proxies**, not exact Betti
 * numbers of the toroidal simulation: components that touch opposing boundaries mark seam involvement
 * and lower `topologyConfidence`, boundary-connected background is never a hole, and cross-threshold
 * count agreement plus temporal stability reject flicker. `beta0Approx`/`beta1Approx` are taken from
 * the **middle** threshold.
 *
 * The analyzer also tracks components between successive samples: an ID is preserved when overlap with
 * a previous component is dominant (> 50% of either), multiple significant source IDs entering one
 * destination are counted as merge candidates, lifespan is maintained and a component must reach
 * `birthPersistenceSamples` to count as persistent, and `persistenceSeconds` is an area-weighted age.
 * **Only middle-threshold components at or above `minComponentPixels` are tracked** (review fix MAJOR
 * 2): the filtered sub-minimum artifacts are stripped before `track()` runs, so a stable isolated
 * pixel can never become a persistent component or drive a `birth`. All per-sample scratch is
 * preallocated on the analyzer and reused (review fix MINOR 6).
 */
import { PRESENTATION } from '../config.ts';

export interface ThresholdCounts {
  components: number;
  holes: number;
  /** Components removed as sub-minimum artifacts at this threshold. */
  artifacts: number;
}

export interface TopologyResult {
  size: number;
  /** Per-threshold component/hole counts, in `PRESENTATION.topologyThresholds` order. */
  counts: [ThresholdCounts, ThresholdCounts, ThresholdCounts];
  beta0Approx: number;
  beta1Approx: number;
  /** Largest middle-threshold component area as a fraction of occupied area. */
  largestComponentFraction: number;
  topologyConfidence: number;
  seamInvolved: boolean;
  /** Middle-threshold foreground labels with tracked IDs (0 = background). */
  labels: Int32Array;
  labelCount: number;
  /** Middle-threshold holes as a 0/1 mask (overlay + diagnostics). */
  holeMask: Uint8Array;
  /** New middle-threshold components that absorbed >= 2 distinct significant previous IDs. */
  mergeCandidates: number;
  /** True on the sample a component first reaches `birthPersistenceSamples` of survival. */
  hasNewPersistentComponent: boolean;
  /** Area-weighted age of the tracked components, in sampled numerical seconds. */
  persistenceSeconds: number;
}

/** The four/eight neighbour offsets as (dx,dy) pairs (always advanced in steps of two). */
const NB4 = [-1, 0, 1, 0, 0, -1, 0, 1] as const;
const NB8 = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

export class TopologyAnalyzer {
  private readonly thresholds: readonly [number, number, number];
  private readonly minComponent: number;
  private readonly minHole: number;
  private readonly birthPersistence: number;

  private readonly fgMask: Uint8Array;
  private readonly labels: Int32Array;
  private readonly prevLabels: Int32Array;
  private readonly holeMask: Uint8Array;
  private readonly queue: Int32Array;
  private readonly labelArea: Int32Array;
  private readonly labelFlags: Uint8Array;
  private readonly bgScratch: Int32Array;
  /** Middle-threshold raw label -> retained (compacted) label, or 0 when stripped as sub-minimum. */
  private readonly labelRemap: Int32Array;
  /** Per-sample scratch for `track()` (review fix MINOR 6: reused, never allocated per sample). */
  private readonly newAreaScratch: Int32Array;
  private readonly trackMapScratch: Int32Array;
  private readonly isHoleScratch: Uint8Array;
  /** Reused overlap/area maps for `track()` (cleared each use instead of allocated). */
  private readonly overlapScratch = new Map<number, number>();
  private readonly prevAreaScratch = new Map<number, number>();

  private sampleIndex = 0;
  private nextTrackedId = 1;
  private readonly firstSeen = new Map<number, number>();
  private readonly birthTime = new Map<number, number>();
  private readonly lastSeen = new Map<number, number>();

  constructor(
    private readonly size: number,
    options?: {
      thresholds?: readonly [number, number, number];
      minComponentPixels?: number;
      minHolePixels?: number;
      birthPersistenceSamples?: number;
    },
  ) {
    this.thresholds = options?.thresholds ?? [
      PRESENTATION.topologyThresholds[0],
      PRESENTATION.topologyThresholds[1],
      PRESENTATION.topologyThresholds[2],
    ];
    this.minComponent = options?.minComponentPixels ?? PRESENTATION.minComponentPixels;
    this.minHole = options?.minHolePixels ?? PRESENTATION.minHolePixels;
    this.birthPersistence = options?.birthPersistenceSamples ?? 3;
    const n = size * size;
    this.fgMask = new Uint8Array(n);
    this.labels = new Int32Array(n);
    this.prevLabels = new Int32Array(n);
    this.holeMask = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.labelArea = new Int32Array(n + 1);
    this.labelFlags = new Uint8Array(n + 1);
    this.bgScratch = new Int32Array(n);
    this.labelRemap = new Int32Array(n + 1);
    this.newAreaScratch = new Int32Array(n + 1);
    this.trackMapScratch = new Int32Array(n + 1);
    this.isHoleScratch = new Uint8Array(n + 1);
  }

  /** Reset the cross-sample tracking state (epoch change / field reset). */
  reset(): void {
    this.prevLabels.fill(0);
    this.sampleIndex = 0;
    this.nextTrackedId = 1;
    this.firstSeen.clear();
    this.birthTime.clear();
    this.lastSeen.clear();
  }

  /**
   * Analyze one reduced V field. `simulationTime` is the numerical time of the sample, used for the
   * area-weighted persistence age.
   */
  analyze(v: Float32Array, simulationTime = 0): TopologyResult {
    this.sampleIndex += 1;
    const size = this.size;
    const counts: [ThresholdCounts, ThresholdCounts, ThresholdCounts] = [
      { components: 0, holes: 0, artifacts: 0 },
      { components: 0, holes: 0, artifacts: 0 },
      { components: 0, holes: 0, artifacts: 0 },
    ];
    let seamInvolved = false;
    let middleLargest = 0;
    let middleOccupied = 0;

    for (let t = 0; t < 3; t += 1) {
      const threshold = this.thresholds[t]!;
      let kept = 0;
      let removed = 0;
      let largest = 0;
      for (let i = 0; i < v.length; i += 1) this.fgMask[i] = v[i]! > threshold ? 1 : 0;
      const labelCount = this.labelInto(this.fgMask, false, this.labels);
      for (let id = 1; id <= labelCount; id += 1) {
        const area = this.labelArea[id]!;
        if (area >= this.minComponent) {
          kept += 1;
          if (area > largest) largest = area;
          const flags = this.labelFlags[id]!;
          if (((flags & 1) !== 0 && (flags & 2) !== 0) || ((flags & 4) !== 0 && (flags & 8) !== 0)) {
            seamInvolved = true;
          }
        } else {
          removed += 1;
        }
      }
      // Holes: 8-connected background components that do not touch the boundary and reach min size.
      const holeCount = this.countHoles();
      counts[t] = { components: kept, holes: holeCount, artifacts: removed };
      if (t === 1) {
        middleLargest = largest;
        middleOccupied = this.occupiedArea(this.fgMask);
      }
    }

    // Track the middle threshold. Re-label with the middle threshold (t=1) so `labels` holds it, then
    // strip sub-minimum components so `track()` only ever sees retained components (review fix
    // MAJOR 2). Without this, a stable isolated pixel would be tracked and, after the persistence
    // window, misreported as a new persistent component (a birth).
    for (let i = 0; i < v.length; i += 1) this.fgMask[i] = v[i]! > this.thresholds[1]! ? 1 : 0;
    const rawMiddleCount = this.labelInto(this.fgMask, false, this.labels);
    const middleCount = this.stripSubMinimum(rawMiddleCount);
    const tracking = this.track(middleCount, simulationTime);
    this.countHoles(); // refresh holeMask for the middle threshold

    const componentCounts = [counts[0].components, counts[1].components, counts[2].components];
    const maxCount = Math.max(...componentCounts);
    const minCount = Math.min(...componentCounts);
    const agreement = maxCount > 0 ? Math.max(0, 1 - (maxCount - minCount) / maxCount) : 1;
    const artifacts = counts[0].artifacts + counts[1].artifacts + counts[2].artifacts;
    const keptTotal = counts[0].components + counts[1].components + counts[2].components;
    const artifactFraction = artifacts + keptTotal > 0 ? artifacts / (artifacts + keptTotal) : 0;
    const topologyConfidence = clamp01(agreement * (1 - artifactFraction) * (seamInvolved ? 0.4 : 1));

    return {
      size,
      counts,
      beta0Approx: counts[1].components,
      beta1Approx: counts[1].holes,
      largestComponentFraction: middleOccupied > 0 ? middleLargest / middleOccupied : 0,
      topologyConfidence,
      seamInvolved,
      labels: this.labels,
      labelCount: middleCount,
      holeMask: this.holeMask,
      mergeCandidates: tracking.mergeCandidates,
      hasNewPersistentComponent: tracking.hasNewPersistentComponent,
      persistenceSeconds: tracking.persistenceSeconds,
    };
  }

  /**
   * Zero the middle-threshold labels of components smaller than `minComponent` and compact the
   * survivors to contiguous IDs `1..k`. Returns the retained count. `track()` therefore only ever sees
   * retained components (review fix MAJOR 2): a filtered 1-px artifact is no longer tracked, so it can
   * never accumulate the persistence samples that would emit a `birth`.
   */
  private stripSubMinimum(rawCount: number): number {
    const remap = this.labelRemap;
    let retained = 0;
    for (let id = 1; id <= rawCount; id += 1) {
      if (this.labelArea[id]! >= this.minComponent) {
        retained += 1;
        remap[id] = retained;
      } else {
        remap[id] = 0;
      }
    }
    if (retained !== rawCount) {
      const labels = this.labels;
      for (let i = 0; i < labels.length; i += 1) {
        const id = labels[i]!;
        if (id !== 0) labels[i] = remap[id]!;
      }
    }
    return retained;
  }

  /** Label `mask` into `labels` (>=1 per component, 0 background); records area and boundary flags. */
  private labelInto(mask: Uint8Array, eightConnected: boolean, labels: Int32Array): number {
    const size = this.size;
    labels.fill(0);
    let next = 0;
    const queue = this.queue;
    const neighbours = eightConnected ? NB8 : NB4;
    const step = 2;
    for (let start = 0; start < mask.length; start += 1) {
      if (mask[start] === 0 || labels[start] !== 0) continue;
      next += 1;
      let head = 0;
      let tail = 0;
      queue[tail] = start;
      tail += 1;
      labels[start] = next;
      let area = 0;
      let flags = 0;
      while (head < tail) {
        const p = queue[head]!;
        head += 1;
        area += 1;
        const x = p % size;
        const y = (p - x) / size;
        if (x === 0) flags |= 1;
        if (x === size - 1) flags |= 2;
        if (y === 0) flags |= 4;
        if (y === size - 1) flags |= 8;
        for (let k = 0; k < neighbours.length; k += step) {
          const nx = x + neighbours[k]!;
          const ny = y + neighbours[k + 1]!;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const ni = ny * size + nx;
          if (mask[ni] !== 0 && labels[ni] === 0) {
            labels[ni] = next;
            queue[tail] = ni;
            tail += 1;
          }
        }
      }
      this.labelArea[next] = area;
      this.labelFlags[next] = flags;
    }
    return next;
  }

  /** Count 8-connected background components not touching the boundary (>= minHolePixels); fill mask. */
  private countHoles(): number {
    const size = this.size;
    const holeMask = this.holeMask;
    holeMask.fill(0);
    // Reuse bgScratch as the background-label scratch (prevLabels is consumed by track()).
    const bgLabels = this.bgScratch;
    bgLabels.fill(0);
    let next = 0;
    const queue = this.queue;
    for (let start = 0; start < this.fgMask.length; start += 1) {
      if (this.fgMask[start] !== 0 || bgLabels[start] !== 0) continue;
      next += 1;
      let head = 0;
      let tail = 0;
      queue[tail] = start;
      tail += 1;
      bgLabels[start] = next;
      let area = 0;
      let touchesBoundary = false;
      while (head < tail) {
        const p = queue[head]!;
        head += 1;
        area += 1;
        const x = p % size;
        const y = (p - x) / size;
        if (x === 0 || y === 0 || x === size - 1 || y === size - 1) touchesBoundary = true;
        for (let k = 0; k < NB8.length; k += 2) {
          const nx = x + NB8[k]!;
          const ny = y + NB8[k + 1]!;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const ni = ny * size + nx;
          if (this.fgMask[ni] === 0 && bgLabels[ni] === 0) {
            bgLabels[ni] = next;
            queue[tail] = ni;
            tail += 1;
          }
        }
      }
      this.labelArea[next] = area;
      this.labelFlags[next] = touchesBoundary ? 1 : 0;
    }
    let holes = 0;
    for (let id = 1; id <= next; id += 1) {
      if (this.labelFlags[id] === 0 && this.labelArea[id]! >= this.minHole) holes += 1;
    }
    // Mark hole pixels in the mask: interior background components that reached the size threshold.
    const isHole = this.isHoleScratch;
    isHole.fill(0, 0, next + 1);
    for (let id = 1; id <= next; id += 1) isHole[id] = this.labelFlags[id] === 0 && this.labelArea[id]! >= this.minHole ? 1 : 0;
    for (let i = 0; i < bgLabels.length; i += 1) {
      const id = bgLabels[i]!;
      if (id !== 0 && isHole[id] === 1) holeMask[i] = 1;
    }
    return holes;
  }

  private occupiedArea(mask: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < mask.length; i += 1) sum += mask[i]!;
    return sum;
  }

  /**
   * Preserve tracked IDs across samples by dominant overlap, count merge candidates and update the
   * lifespan maps. Rewrites `this.labels` in place with tracked IDs and copies into `prevLabels`.
   */
  private track(labelCount: number, simulationTime: number): {
    mergeCandidates: number;
    hasNewPersistentComponent: boolean;
    persistenceSeconds: number;
  } {
    const n = this.labels.length;
    const labels = this.labels;
    const prev = this.prevLabels;
    // Reused scratch (review fix MINOR 6): the long-lived worker allocates these once, never per
    // sample. The maps are cleared rather than re-allocated.
    const overlap = this.overlapScratch;
    const prevArea = this.prevAreaScratch;
    prevArea.clear();
    for (let i = 0; i < n; i += 1) {
      const pid = prev[i]!;
      if (pid !== 0) prevArea.set(pid, (prevArea.get(pid) ?? 0) + 1);
    }
    const newArea = this.newAreaScratch;
    newArea.fill(0, 0, labelCount + 1);
    for (let i = 0; i < n; i += 1) {
      const id = labels[i]!;
      if (id !== 0) newArea[id] += 1;
    }
    let mergeCandidates = 0;
    let minPersistence = Infinity;
    const trackMap = this.trackMapScratch;
    trackMap.fill(0, 0, labelCount + 1);
    for (let id = 1; id <= labelCount; id += 1) {
      overlap.clear();
      for (let i = 0; i < n; i += 1) {
        if (labels[i] !== id) continue;
        const pid = prev[i]!;
        if (pid !== 0) overlap.set(pid, (overlap.get(pid) ?? 0) + 1);
      }
      let dominant = 0;
      let dominantOverlap = 0;
      let significantSources = 0;
      for (const [pid, count] of overlap) {
        if (count > dominantOverlap) {
          dominantOverlap = count;
          dominant = pid;
        }
        if (count * 2 > (prevArea.get(pid) ?? 0)) significantSources += 1;
      }
      const area = newArea[id]!;
      let tracked: number;
      if (dominant !== 0 && dominantOverlap * 2 > area) {
        tracked = dominant; // dominant overlap of this destination -> preserve the source's ID
      } else {
        tracked = this.nextTrackedId;
        this.nextTrackedId += 1;
        this.firstSeen.set(tracked, this.sampleIndex);
        this.birthTime.set(tracked, simulationTime);
      }
      if (significantSources >= 2) mergeCandidates += 1;
      trackMap[id] = tracked;
      this.lastSeen.set(tracked, this.sampleIndex);
      const age = this.sampleIndex - (this.firstSeen.get(tracked) ?? this.sampleIndex);
      if (age < minPersistence) minPersistence = age;
    }
    // Rewrite labels with tracked IDs and copy into prevLabels for the next sample.
    for (let i = 0; i < n; i += 1) {
      const id = labels[i]!;
      const tracked = id === 0 ? 0 : trackMap[id]!;
      labels[i] = tracked;
      prev[i] = tracked;
    }

    // New persistent component: an ID that just reached the birth-persistence sample count.
    let hasNewPersistentComponent = false;
    let weightedAge = 0;
    let weightedArea = 0;
    for (let id = 1; id <= labelCount; id += 1) {
      const tracked = trackMap[id]!;
      const age = this.sampleIndex - (this.firstSeen.get(tracked) ?? this.sampleIndex);
      if (age === this.birthPersistence - 1) hasNewPersistentComponent = true;
      const area = newArea[id]!;
      weightedAge += area * Math.max(0, simulationTime - (this.birthTime.get(tracked) ?? simulationTime));
      weightedArea += area;
    }
    return {
      mergeCandidates,
      hasNewPersistentComponent,
      persistenceSeconds: weightedArea > 0 ? weightedAge / weightedArea : 0,
    };
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
