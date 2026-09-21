/**
 * §7.3/§3.4 morphological event recognition (Phase 3, tier-2).
 *
 * A serial-numbered event is a persistent record, not a callback, and at most **one** salient event is
 * emitted per analysis update, with precedence collapse > fragment > merge > birth > surge. The
 * labyrinth/merge pattern needs, over a roughly ten-second window, a β0 drop of at least 30%, a rising
 * largest-component fraction, a hole-count rise, and non-collapsing occupied area; fragmentation is the
 * converse with falling coherence/occupancy as support; collapse is a sustained large loss of occupancy
 * **and** activity; birth is a new component that persists with sufficient topology confidence; surge
 * is an activity spike. Morphology
 * events require `confirmTicks` consecutive confirming samples and sufficient topology confidence, a
 * refractory window suppresses spam, and a latch prevents re-firing while a condition stays true.
 */
import { EVENTS } from '../config.ts';

export type SalientKind = 'birth' | 'merge' | 'fragment' | 'collapse' | 'surge';

export interface EventFeatures {
  beta0: number;
  beta1: number;
  largestComponentFraction: number;
  occupancy: number;
  activity: number;
  topologyConfidence: number;
  /** New middle-threshold components that absorbed >= 2 significant previous IDs. */
  mergeCandidates: number;
  /** True on the sample a new component first reaches the birth-persistence count. */
  hasNewPersistentComponent: boolean;
  performanceSeconds: number;
}

export interface EventCandidate {
  kind: SalientKind;
  strength: number;
  atPerformanceSeconds: number;
}

interface HistorySample {
  performanceSeconds: number;
  beta0: number;
  beta1: number;
  largest: number;
  occupancy: number;
  activity: number;
}

/** Precedence order used to pick the single salient event per update. */
const PRECEDENCE: readonly SalientKind[] = ['collapse', 'fragment', 'merge', 'birth', 'surge'];

export class EventRecognizer {
  private readonly history: HistorySample[] = [];
  private readonly windowSeconds: number;
  private latchedKind: SalientKind | null = null;
  private pendingKind: SalientKind | null = null;
  private pendingTicks = 0;
  private lastEventSeconds = Number.NEGATIVE_INFINITY;

  constructor(options?: { windowSeconds?: number }) {
    this.windowSeconds = options?.windowSeconds ?? EVENTS.windowSeconds;
  }

  reset(): void {
    this.history.length = 0;
    this.latchedKind = null;
    this.pendingKind = null;
    this.pendingTicks = 0;
    this.lastEventSeconds = Number.NEGATIVE_INFINITY;
  }

  /** Feed one analysis sample; returns an event candidate or null. */
  update(features: EventFeatures): EventCandidate | null {
    this.history.push({
      performanceSeconds: features.performanceSeconds,
      beta0: features.beta0,
      beta1: features.beta1,
      largest: features.largestComponentFraction,
      occupancy: features.occupancy,
      activity: features.activity,
    });
    while (this.history.length > 2 && this.history[0]!.performanceSeconds < features.performanceSeconds - this.windowSeconds) {
      this.history.shift();
    }
    const oldest = this.history[0]!;
    const now = this.history[this.history.length - 1]!;

    const raw = this.detect(features, oldest, now);
    if (raw === null) {
      this.latchedKind = null;
      this.pendingKind = null;
      this.pendingTicks = 0;
      return null;
    }
    if (raw === this.latchedKind) return null; // sustained condition: one event until it clears

    if (raw === this.pendingKind) this.pendingTicks += 1;
    else {
      this.pendingKind = raw;
      this.pendingTicks = 1;
    }
    const needsConfirm = raw === 'merge' || raw === 'fragment' || raw === 'collapse';
    const confirmed = needsConfirm ? this.pendingTicks >= EVENTS.confirmTicks : true;
    if (!confirmed) return null;
    if (features.performanceSeconds - this.lastEventSeconds < EVENTS.refractorySeconds) return null;

    this.latchedKind = raw;
    this.lastEventSeconds = features.performanceSeconds;
    this.pendingKind = null;
    this.pendingTicks = 0;
    return { kind: raw, strength: this.strengthFor(raw, oldest, now), atPerformanceSeconds: features.performanceSeconds };
  }

  private detect(
    features: EventFeatures,
    oldest: HistorySample,
    now: HistorySample,
  ): SalientKind | null {
    const raw = new Set<SalientKind>();
    const oldBeta0 = oldest.beta0;
    const beta0Drop = oldBeta0 > 0 ? (oldBeta0 - now.beta0) / oldBeta0 : 0;
    const beta0Rise = oldBeta0 > 0 ? (now.beta0 - oldBeta0) / oldBeta0 : 0;
    const largestRise = now.largest - oldest.largest;
    const largestFall = oldest.largest - now.largest;
    const holeRise = now.beta1 - oldest.beta1;
    const holeRiseOk =
      holeRise >= EVENTS.holeRiseAbsolute || (oldest.beta1 > 0 && holeRise / oldest.beta1 >= EVENTS.holeRiseFraction);
    const occupancyKept = now.occupancy >= oldest.occupancy * (1 - EVENTS.maxOccupancyDrop);

    // Merge / labyrinth.
    if (
      beta0Drop >= EVENTS.mergeDropFraction &&
      largestRise >= EVENTS.largestRiseFraction &&
      holeRiseOk &&
      occupancyKept &&
      features.topologyConfidence >= EVENTS.minTopologyConfidence &&
      features.mergeCandidates >= EVENTS.mergeMinCandidates
    ) {
      raw.add('merge');
    }
    // Fragmentation (converse).
    if (
      beta0Rise >= EVENTS.mergeDropFraction &&
      largestFall >= EVENTS.largestRiseFraction &&
      now.occupancy < oldest.occupancy &&
      features.topologyConfidence >= EVENTS.minTopologyConfidence
    ) {
      raw.add('fragment');
    }
    // Collapse: sustained large loss of occupancy and activity.
    if (
      oldest.occupancy > 0 &&
      now.occupancy <= oldest.occupancy * (1 - EVENTS.collapseOccupancyFraction) &&
      (oldest.activity <= 0 || now.activity <= oldest.activity * (1 - EVENTS.collapseActivityFraction))
    ) {
      raw.add('collapse');
    }
    // Birth requires a persistent component AND sufficient topology confidence (review fix MAJOR 2):
    // a low-confidence seam/noise field must not emit a birth even if the persistence counter fires.
    if (features.hasNewPersistentComponent && features.topologyConfidence >= EVENTS.minTopologyConfidence) {
      raw.add('birth');
    }
    if (
      now.activity > EVENTS.surgeActivityFloor &&
      oldest.activity > 0 &&
      (now.activity - oldest.activity) / oldest.activity >= EVENTS.surgeActivityFraction
    ) {
      raw.add('surge');
    }

    for (const kind of PRECEDENCE) if (raw.has(kind)) return kind;
    return null;
  }

  private strengthFor(
    kind: SalientKind,
    oldest: HistorySample,
    now: HistorySample,
  ): number {
    switch (kind) {
      case 'merge':
        return clamp01(oldest.beta0 > 0 ? (oldest.beta0 - now.beta0) / oldest.beta0 : 0);
      case 'fragment':
        return clamp01(oldest.beta0 > 0 ? (now.beta0 - oldest.beta0) / oldest.beta0 : 0);
      case 'collapse':
        return clamp01(oldest.occupancy > 0 ? (oldest.occupancy - now.occupancy) / oldest.occupancy : 0);
      case 'surge':
        return clamp01(oldest.activity > 0 ? (now.activity - oldest.activity) / oldest.activity : 0);
      case 'birth':
        return clamp01(now.largest);
    }
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
