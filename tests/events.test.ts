/**
 * §7.3/AC.10 event fixtures: a merge with stable occupancy produces exactly one merge event; fading
 * shapes must not create a false merge; and a sustained condition does not retrigger (latch +
 * refractory). Collapse/birth precedence is also exercised.
 */
import { describe, expect, it } from 'vitest';
import { EventRecognizer } from '../src/analysis/events.ts';
import type { EventFeatures } from '../src/analysis/events.ts';
import { TopologyAnalyzer } from '../src/analysis/topology.ts';

const SIZE = 48;

function feat(over: Partial<EventFeatures> & { performanceSeconds: number }): EventFeatures {
  return {
    beta0: 5,
    beta1: 0,
    largestComponentFraction: 0.2,
    occupancy: 0.3,
    activity: 0.05,
    topologyConfidence: 0.8,
    mergeCandidates: 0,
    hasNewPersistentComponent: false,
    ...over,
  };
}

describe('§7.3 event recognition (AC.10)', () => {
  it('merge with stable occupancy creates exactly one merge event', () => {
    const recognizer = new EventRecognizer();
    const events = [];
    for (let t = 0; t < 12; t += 1) events.push(recognizer.update(feat({ performanceSeconds: t })));
    for (let t = 12; t < 16; t += 1) {
      events.push(
        recognizer.update(
          feat({ performanceSeconds: t, beta0: 3, beta1: 3, largestComponentFraction: 0.35, mergeCandidates: 1 }),
        ),
      );
    }
    const salient = events.filter((event) => event !== null);
    expect(salient.length).toBe(1);
    expect(salient[0]!.kind).toBe('merge');
    expect(salient[0]!.strength).toBeGreaterThan(0.3);
  });

  it('fading shapes do not create a false merge', () => {
    const recognizer = new EventRecognizer();
    const events = [];
    for (let t = 0; t < 20; t += 1) {
      // Occupancy fades but β0/holes/largest are unchanged and activity is flat -> no merge, no collapse.
      events.push(recognizer.update(feat({ performanceSeconds: t, occupancy: t < 8 ? 0.3 : 0.1 })));
    }
    expect(events.filter((event) => event !== null).length).toBe(0);
  });

  it('does not retrigger while a merge condition is sustained (latch + refractory)', () => {
    const recognizer = new EventRecognizer();
    const events = [];
    for (let t = 0; t < 12; t += 1) events.push(recognizer.update(feat({ performanceSeconds: t })));
    for (let t = 12; t < 60; t += 1) {
      events.push(
        recognizer.update(
          feat({ performanceSeconds: t, beta0: 3, beta1: 3, largestComponentFraction: 0.35, mergeCandidates: 1 }),
        ),
      );
    }
    expect(events.filter((event) => event !== null).length).toBe(1);
  });

  it('collapse takes precedence over fragment when occupancy and activity both fall', () => {
    const recognizer = new EventRecognizer();
    for (let t = 0; t < 12; t += 1) recognizer.update(feat({ performanceSeconds: t }));
    // β0 rises (fragment signature) but occupancy and activity both collapse.
    const event = recognizer.update(
      feat({ performanceSeconds: 12, beta0: 9, beta1: 2, largestComponentFraction: 0.05, occupancy: 0.05, activity: 0.005 }),
    );
    const confirmed = event ?? recognizer.update(
      feat({ performanceSeconds: 12.5, beta0: 9, beta1: 2, largestComponentFraction: 0.05, occupancy: 0.05, activity: 0.005 }),
    );
    expect(confirmed?.kind).toBe('collapse');
  });

  it('a new persistent component is recognized as a birth', () => {
    const recognizer = new EventRecognizer();
    for (let t = 0; t < 12; t += 1) recognizer.update(feat({ performanceSeconds: t, beta0: 0, occupancy: 0, activity: 0 }));
    const event = recognizer.update(
      feat({ performanceSeconds: 12, beta0: 1, hasNewPersistentComponent: true, occupancy: 0.05, activity: 0.02 }),
    );
    expect(event?.kind).toBe('birth');
  });

  it('a fragment-only signature emits exactly one fragment after two confirming ticks', () => {
    const recognizer = new EventRecognizer();
    for (let t = 0; t < 12; t += 1) recognizer.update(feat({ performanceSeconds: t }));
    // β0 rises, largest-component fraction falls, and occupancy declines modestly — well short of the
    // collapse fraction — with activity roughly flat: this is fragmentation, not a simultaneous collapse.
    const events = [];
    for (let t = 12; t < 16; t += 1) {
      events.push(
        recognizer.update(
          feat({
            performanceSeconds: t,
            beta0: 9,
            beta1: 2,
            largestComponentFraction: 0.08,
            occupancy: 0.24,
            activity: 0.045,
          }),
        ),
      );
    }
    const salient = events.filter((event) => event !== null);
    expect(salient.length).toBe(1);
    expect(salient[0]!.kind).toBe('fragment');
  });

  it('a low-confidence persistent component cannot emit a birth', () => {
    const recognizer = new EventRecognizer();
    for (let t = 0; t < 4; t += 1) {
      recognizer.update(feat({ performanceSeconds: t, beta0: 0, occupancy: 0, activity: 0 }));
    }
    const lowConfidence = recognizer.update(
      feat({
        performanceSeconds: 4,
        beta0: 1,
        hasNewPersistentComponent: true,
        topologyConfidence: 0.1,
        occupancy: 0.02,
        activity: 0.01,
      }),
    );
    expect(lowConfidence, 'a seam/noise-confidence persistent component does not emit a birth').toBeNull();
    const highConfidence = recognizer.update(
      feat({
        performanceSeconds: 5,
        beta0: 1,
        hasNewPersistentComponent: true,
        topologyConfidence: 0.8,
        occupancy: 0.02,
        activity: 0.01,
      }),
    );
    expect(highConfidence?.kind).toBe('birth');
  });

  it('a stable isolated pixel is never tracked, so it can never emit a birth', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const grid = new Float32Array(SIZE * SIZE);
    grid[24 * SIZE + 24] = 1; // one isolated foreground pixel, above every topology threshold
    const recognizer = new EventRecognizer();
    for (let sample = 0; sample < 6; sample += 1) {
      const topo = analyzer.analyze(grid, sample);
      expect(topo.hasNewPersistentComponent, `no persistent component at sample ${sample}`).toBe(false);
      expect(topo.labelCount, `no tracked component at sample ${sample}`).toBe(0);
      const event = recognizer.update({
        beta0: topo.beta0Approx,
        beta1: topo.beta1Approx,
        largestComponentFraction: topo.largestComponentFraction,
        occupancy: 0,
        activity: 0,
        topologyConfidence: topo.topologyConfidence,
        mergeCandidates: topo.mergeCandidates,
        hasNewPersistentComponent: topo.hasNewPersistentComponent,
        performanceSeconds: sample,
      });
      expect(event, `no salient event from an isolated pixel at sample ${sample}`).toBeNull();
    }
  });

  it('a retained component births exactly once after the persistence threshold', () => {
    const analyzer = new TopologyAnalyzer(SIZE);
    const recognizer = new EventRecognizer();
    const grid = new Float32Array(SIZE * SIZE);
    for (let y = 23; y < 26; y += 1) for (let x = 23; x < 26; x += 1) grid[y * SIZE + x] = 1; // 3x3
    const births: number[] = [];
    for (let sample = 0; sample < 6; sample += 1) {
      const topo = analyzer.analyze(grid, sample);
      const event = recognizer.update({
        beta0: topo.beta0Approx,
        beta1: topo.beta1Approx,
        largestComponentFraction: topo.largestComponentFraction,
        occupancy: 0.05,
        activity: 0.02,
        topologyConfidence: topo.topologyConfidence,
        mergeCandidates: topo.mergeCandidates,
        hasNewPersistentComponent: topo.hasNewPersistentComponent,
        performanceSeconds: sample,
      });
      if (event?.kind === 'birth') births.push(sample);
    }
    expect(births, 'the retained component births exactly once').toHaveLength(1);
  });
});
