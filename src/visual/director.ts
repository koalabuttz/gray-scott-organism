/**
 * §9.1/§9.3 visual director: camera and light **policy**, in Phase 2 terms.
 *
 * The director owns camera/light *targets*; the renderer consumes them. Phase-2 signals are the
 * curator's phase/intention, the tier-1 chemistry health and the **coarse 16x16 occupancy grid** the
 * tier-1 reduction already produces, which supplies a focus centroid and a bounding extent without a
 * second readback (deviation 36). `analysis.presentation.centroidUV` / `boundsUV` remain Phase 3.
 *
 * **Seam retention (§4.3/§9.1, MAJOR 6).** The simulation domain is a torus, so an organism can span
 * the seam: its coarse occupancy then sits on both opposing edges and its *planar* centroid is pulled
 * toward the domain centre — a focus target that would slide off the organism. `coarseSeamAmbiguous`
 * detects high occupancy on both opposing edges of the coarse grid and, when it fires, the camera
 * **retains its previous focus** instead of adopting the planar centroid.
 *
 * **Bounded light azimuth (§9.3, MAJOR 6).** The light no longer integrates a 4°/min azimuth forever
 * (an unbounded orbit, which §9.3 forbids). Each arc seeds a **bounded** target offset from the base
 * azimuth, the azimuth travels toward it at no more than 25°/min, and it **holds** once reached — so
 * total azimuth travel stays inside a bounded band and plateaus.
 *
 * **Smoothing.** The renderer applies the published camera/light every frame without interpolating
 * between snapshots, so the director smooths its own state in real time and the app calls `derive`
 * once per frame; the published `WorldState` (2 Hz) simply carries the current targets. Response is
 * first-order with the §9.1 30 s constant, so snapshot rate is invisible (deviation 37).
 *
 * **Pin/unpin (MAJOR 7).** A laboratory/hook override is routed *through* the director
 * (`command`/`pinLight`/`pinMaterial`): the pinned field stops being driven until it is explicitly
 * released, so an override survives the next `derive` instead of being overwritten. `reset()` restores
 * the calibrated defaults, clears every pin and clears the time origin, so re-enabling automatic
 * composition resumes from the current state with no accumulated-delta jump.
 *
 * **What is deliberately *not* here:** colour grading, bloom, exposure and relief stay at the
 * calibrated constants — the director never drifts `material` (it only ever restores or pins it), so
 * §5.4's fixed exposure and BLOOM.gain remain exactly what the gate recorded.
 *
 * **Horizon is deferred (§9.2).** Eligibility needs a persistent high-confidence connection event and
 * sustained *coherent* structure, both of which are presentation-tier (Phase 3) signals. With that
 * tier invalid the director does not attempt a horizon moment and records that decision here rather
 * than guessing from chemistry health (deviation 38).
 */
import { BLOOM, CAMERA, COMPOSITE, HORIZON, LIGHTING, MATERIAL, SURFACE } from '../config.ts';
import type {
  AnalysisState,
  CameraState,
  EventState,
  HealthState,
  LightState,
  MaterialState,
  PhaseState,
  Vec2,
  Vec3,
} from '../core/types.ts';
import type { CoarseField } from '../analysis/analyzer.ts';
import { distanceForDomainFit } from './camera.ts';

/** §9.1/§9.3 policy constants (phase-2 values, derivable from the plan's clamps). */
export const DIRECTOR_POLICY = {
  /** §9.1 camera response time; also the light's smooth time constant. */
  responseSeconds: 30,
  /** Filter time constant for the coarse focus/extent (well inside §9.1's 30-90 s window). */
  framingSeconds: 45,
  /** §9.1 connection phase: a slight 5-10 degree tilt off the near-overhead start. */
  connectionElevationRadians: (77 * Math.PI) / 180,
  /** §9.1 collapse/fragmentation: widen gently to reveal absence. */
  retreatDistanceGain: 1.18,
  /** Framing margin around the occupied extent, and the clamp on the filled fraction. */
  boundsMargin: 1.45,
  minFillFraction: 0.35,
  maxFillFraction: 0.9,
  /** Focus is clamped to the inner domain so the peripheral envelope stays offscreen (§9.1). */
  focusClampUV: 0.15,
  /**
   * §4.3/§9.1 seam detection: a coarse edge counts as occupied above this per-texel mean occupancy.
   * When both opposing edges exceed it on either axis the planar centroid is untrustworthy.
   */
  seamEdgeOccupancy: 0.05,
  /** §9.3 azimuth travel clamp, degrees per minute (the plan's 25 is an upper bound). */
  azimuthTravelDegPerMinute: 25,
  /** §9.3 bounded per-arc azimuth target offset from the base azimuth, degrees. */
  azimuthTargetMinDegrees: 8,
  azimuthTargetMaxDegrees: 20,
  /** Below this distance the azimuth target is snapped to (and held at). */
  azimuthHoldEpsilonRadians: 1e-4,
  /** §9.3 bounded warmth/intensity lift for sustained mature states. */
  matureIntensityGain: 0.15,
  /** §9.1: on a newly observed merge the camera decelerates and tilts for this long (performance s). */
  mergeResponseSeconds: 18,
  /** §9.1: on a new fragment/collapse the camera widens to reveal absence for this long. */
  fragmentResponseSeconds: 18,
  /** §9.3: a bounded one-shot light-azimuth nudge toward the structural orientation (degrees). */
  orientationNudgeMaxDegrees: 8,
  /** Minimum presentation topology confidence for any event-driven presentation behavior. */
  minPresentationConfidence: 0.2,
} as const;

export interface DirectorInput {
  analysis: AnalysisState;
  /** Coarse full-domain occupancy from the tier-1 reduction; null before the first sample. */
  coarse: CoarseField | null;
  phase: PhaseState;
  latestEvent: EventState;
  clock: { performanceSeconds: number; realSeconds: number; speed: number };
  performanceSeed: number;
  arc: number;
  health: HealthState;
}

export interface VisualTargets {
  camera: CameraState;
  light: LightState;
  material: MaterialState;
}

export interface CameraCommand {
  type: 'override';
  value: Partial<CameraState> | null;
}

function smooth(current: number, target: number, dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return target;
  const alpha = 1 - Math.exp(-Math.max(0, dtSeconds) / tauSeconds);
  return current + (target - current) * alpha;
}

function smoothVec2(current: Vec2, target: Vec2, dt: number, tau: number): Vec2 {
  return [smooth(current[0], target[0], dt, tau), smooth(current[1], target[1], dt, tau)];
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Deterministic 0..1 hash of a uint32, for the seeded per-arc light target. */
function hash01(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}

/**
 * §4.3/§9.1: is the coarse occupancy ambiguous because the organism spans a seam? True when both
 * opposing edges of the coarse grid carry occupancy on either axis — the signature of a torus-spanning
 * body whose planar centroid would be pulled to the domain centre.
 */
export function coarseSeamAmbiguous(coarse: CoarseField, threshold = DIRECTOR_POLICY.seamEdgeOccupancy): boolean {
  const s = coarse.size;
  const occ = coarse.occupancy;
  let colLeft = 0;
  let colRight = 0;
  let rowTop = 0;
  let rowBottom = 0;
  for (let i = 0; i < s; i += 1) {
    colLeft += occ[i * s + 0]!;
    colRight += occ[i * s + (s - 1)]!;
    rowTop += occ[0 * s + i]!;
    rowBottom += occ[(s - 1) * s + i]!;
  }
  const spanX = colLeft / s > threshold && colRight / s > threshold;
  const spanY = rowTop / s > threshold && rowBottom / s > threshold;
  return spanX || spanY;
}

/** §5.4-calibrated material: the director only ever restores this, never drifts it. */
export function calibratedMaterialState(): MaterialState {
  return {
    relief: SURFACE.reliefAmplitude,
    roughness: MATERIAL.roughness,
    emissionTintLinear: MATERIAL.emissionTintLinear,
    exposure: COMPOSITE.exposure,
    bloomGain: BLOOM.gain,
  };
}

export class VisualDirector {
  private camera: CameraState;
  private light: LightState;
  private material: MaterialState;
  private lastRealSeconds: number | null = null;
  private lastPerformanceSeconds: number | null = null;
  private arcSeen = -1;
  private lightAzimuthTarget: number;
  /** Set once a laboratory/hook override touches a field: the director then stops driving it. */
  private cameraPinned = false;
  private lightPinned = false;
  // §9.2 horizon (director-owned state machine, at most one excursion per arc).
  private horizonState: 'idle' | 'engaged' | 'returned' = 'idle';
  private horizonUsedThisArc = false;
  private horizonDraw = 0;
  private horizonEngagedAt = 0;
  private horizonFocus: Vec2 = [0.5, 0.5];
  private horizonDistance = 1;
  private horizonMoments = 0;
  private arcStartPerformanceSeconds = 0;
  // Presentation-tier event/framing response (bounded windows).
  private sustainedStructureSeconds = 0;
  private lastSeenEventSerial = -1;
  private lastConnectionEventSeconds = Number.NEGATIVE_INFINITY;
  private mergeResponseUntil = Number.NEGATIVE_INFINITY;
  private widenResponseUntil = Number.NEGATIVE_INFINITY;
  private lightOrientationApplied = false;

  constructor(initial?: Partial<VisualTargets>) {
    this.camera = initial?.camera ?? defaultCamera();
    this.light = initial?.light ?? defaultLight();
    this.material = initial?.material ?? calibratedMaterialState();
    this.lightAzimuthTarget = this.light.azimuthRadians;
  }

  get targets(): VisualTargets {
    return { camera: this.camera, light: this.light, material: this.material };
  }

  get pinned(): { camera: boolean; light: boolean } {
    return { camera: this.cameraPinned, light: this.lightPinned };
  }

  /** The bounded per-arc azimuth target currently in force (radians); diagnostic/test accessor. */
  get azimuthTargetRadians(): number {
    return this.lightAzimuthTarget;
  }

  /** §9.2 horizon state for diagnostics/tests: state, whether it was used this arc, and the count. */
  get horizon(): { state: 'idle' | 'engaged' | 'returned'; usedThisArc: boolean; moments: number } {
    return { state: this.horizonState, usedThisArc: this.horizonUsedThisArc, moments: this.horizonMoments };
  }

  /**
   * Re-arm the director for a **fresh performance** (§6.4/§10 `restart`, and the §10 resolution
   * switch, which rebuilds the curator from the *retained* root seed).
   *
   * The clock and the field both restart, so the real/performance time origins are cleared — the
   * next `derive` sees `dt = 0` and cannot take a one-frame step from an accumulated delta. The
   * per-arc/per-seed state is re-armed **explicitly** rather than left to the `arc !== arcSeen`
   * guard inside `derive`: a restart returns to arc 0, which the previous performance has almost
   * always already visited, so the guard would skip the retarget and the new seed would inherit the
   * *old* performance's bounded light target and visual state (MAJOR 2). `seed`/`arc` describe the
   * *new* performance.
   *
   * Camera/light/material values are **preserved as transition origins** (they are *not* snapped to
   * the calibrated defaults): the renderer consumes them every frame, so a restart must not produce
   * a visible jump; only the seed-dependent target and the time origins change here. Pins are left
   * untouched — a laboratory override is released on its own schedule.
   */
  restartPerformance(seed: number, arc: number): void {
    this.lastRealSeconds = null;
    this.lastPerformanceSeconds = null;
    this.arcSeen = arc;
    this.retargetLight(seed, arc);
    this.resetArcState(seed, arc, 0);
  }

  /**
   * Re-arm the per-arc presentation state (horizon, event windows, sustained-structure accumulator).
   * The §9.2 horizon is a once-per-arc event, so a fresh arc starts `idle` with a fresh seeded draw.
   */
  private resetArcState(seed: number, arc: number, performanceSeconds: number): void {
    this.horizonState = 'idle';
    this.horizonUsedThisArc = false;
    this.horizonDraw = hash01((seed ^ Math.imul(arc + 1, 0x85ebca6b)) >>> 0);
    this.horizonEngagedAt = 0;
    this.arcStartPerformanceSeconds = performanceSeconds;
    this.sustainedStructureSeconds = 0;
    this.lastSeenEventSerial = -1;
    this.lastConnectionEventSeconds = Number.NEGATIVE_INFINITY;
    this.mergeResponseUntil = Number.NEGATIVE_INFINITY;
    this.widenResponseUntil = Number.NEGATIVE_INFINITY;
    this.lightOrientationApplied = false;
  }

  /** Laboratory/test override: pin camera fields (or clear the pin with `null`). */
  command(command: CameraCommand): void {
    if (command.value === null) {
      this.cameraPinned = false;
      return;
    }
    this.cameraPinned = true;
    this.camera = { ...this.camera, ...command.value, focusUV: command.value.focusUV ?? this.camera.focusUV };
  }

  /** Laboratory/test override for the light (pins it) or `null` to release it. */
  pinLight(value: Partial<LightState> | null): void {
    if (value === null) {
      this.lightPinned = false;
      // Re-arm the per-arc target so the released light resumes travelling toward its bounded target
      // (rate-limited, ≤25°/min) instead of holding at wherever it was pinned.
      this.arcSeen = -1;
      return;
    }
    this.lightPinned = true;
    this.light = { ...this.light, ...value };
    // Hold exactly where it was pinned, so releasing cannot trigger a jump.
    this.lightAzimuthTarget = this.light.azimuthRadians;
  }

  /** Laboratory/test override for the material (pins it) or `null` to release it. */
  pinMaterial(value: Partial<MaterialState> | null): void {
    if (value === null) return;
    this.material = { ...this.material, ...value };
  }

  /**
   * Manual-mode camera release (§10, MAJOR 7). Clears the camera pin **and** snaps the camera back to
   * the calibrated Phase-1 default. This exists because releasing a pin with `command(null)` only
   * clears the pin: with automatic composition ON the director's next `derive` resumes driving the
   * camera smoothly from wherever it was (the desired smooth-resume semantics), but with automatic
   * composition OFF nothing runs `derive`, so unpinning alone would leave the camera at the last
   * override (e.g. a grazing laboratory view) **forever** — and every subsequent capture, the gate's
   * clip, the gate's control/candidate stills and any regeneration would inherit it. The Phase-1
   * manual path therefore releases to the calibrated overhead camera explicitly.
   *
   * Only the camera is touched: light and material handling are unchanged (the full Phase-1 restore
   * is `reset()`).
   */
  resetCamera(): void {
    this.cameraPinned = false;
    this.camera = defaultCamera();
  }

  /**
   * Restore calibrated defaults, clear every pin and clear the time origin. Called when the app
   * switches into or out of the Phase-1 manual path (MAJOR 7): the cleared origin means the next
   * `derive` sees `dt = 0`, so re-enabling automatic composition cannot produce a one-frame jump from
   * an accumulated delta.
   */
  reset(): void {
    this.camera = defaultCamera();
    this.light = defaultLight();
    this.material = calibratedMaterialState();
    this.lastRealSeconds = null;
    this.lastPerformanceSeconds = null;
    this.arcSeen = -1;
    this.lightAzimuthTarget = this.light.azimuthRadians;
    this.cameraPinned = false;
    this.lightPinned = false;
    this.resetArcState(0, 0, 0);
  }

  /** Derive targets for this frame. `dt` is real seconds since the previous call. */
  derive(input: DirectorInput): VisualTargets {
    const dt = this.lastRealSeconds === null ? 0 : Math.max(0, input.clock.realSeconds - this.lastRealSeconds);
    this.lastRealSeconds = input.clock.realSeconds;
    // §8.3: the black-hold is 20 *performance* seconds, so its light fade is paced by performance time
    // (bounded, like real time, so a suspended tab cannot demand a burst). At 1x this equals `dt`.
    const performanceDelta =
      this.lastPerformanceSeconds === null
        ? 0
        : Math.min(1, Math.max(0, input.clock.performanceSeconds - this.lastPerformanceSeconds));
    this.lastPerformanceSeconds = input.clock.performanceSeconds;

    if (input.arc !== this.arcSeen) {
      // §9.2/§9.3: per-arc state. The light's bounded target is seeded per arc so successive arcs do
      // not share an identical light path, and the horizon/event windows restart.
      this.arcSeen = input.arc;
      this.retargetLight(input.performanceSeed, input.arc);
      this.resetArcState(input.performanceSeed, input.arc, input.clock.performanceSeconds);
    }

    this.trackPresentation(input, performanceDelta);
    this.updateHorizon(input);

    this.updateCamera(dt, input);
    this.updateLight(dt, performanceDelta, input);
    return this.targets;
  }

  /** Seed a bounded azimuth target for this arc (offset from the calibrated base azimuth). */
  private retargetLight(seed: number, arc: number): void {
    const mixed = (seed ^ Math.imul(arc + 1, 0x9e3779b9)) >>> 0;
    const magnitude =
      DIRECTOR_POLICY.azimuthTargetMinDegrees +
      (DIRECTOR_POLICY.azimuthTargetMaxDegrees - DIRECTOR_POLICY.azimuthTargetMinDegrees) * hash01(mixed);
    const sign = (Math.imul(mixed, 0x85ebca6b) >>> 31) === 1 ? 1 : -1;
    this.lightAzimuthTarget = LIGHTING.azimuthRadians + (sign * magnitude * Math.PI) / 180;
  }

  /**
   * §9.1/§9.2 presentation-tier event windows and sustained-structure accumulation. A newly observed
   * merge arms the decelerate/tilt window and records the connection event; a fragment/collapse arms
   * the widen window. Sustained structure accumulates while the presentation tier is valid with
   * occupancy and coherence above the §9.2 thresholds.
   */
  private trackPresentation(input: DirectorInput, performanceDelta: number): void {
    const perf = input.clock.performanceSeconds;
    if (input.latestEvent.serial !== this.lastSeenEventSerial) {
      this.lastSeenEventSerial = input.latestEvent.serial;
      switch (input.latestEvent.kind) {
        case 'merge':
          this.mergeResponseUntil = perf + DIRECTOR_POLICY.mergeResponseSeconds;
          this.lastConnectionEventSeconds = perf;
          break;
        case 'fragment':
          this.widenResponseUntil = perf + DIRECTOR_POLICY.fragmentResponseSeconds;
          break;
        case 'collapse':
          this.widenResponseUntil = perf + DIRECTOR_POLICY.fragmentResponseSeconds * 1.5;
          break;
        default:
          break;
      }
    }
    const presentation = input.analysis.presentation;
    const sustained =
      presentation.valid &&
      presentation.occupiedFraction > HORIZON.sustainOccupancy &&
      presentation.coherence > HORIZON.sustainCoherence;
    this.sustainedStructureSeconds = sustained ? this.sustainedStructureSeconds + performanceDelta : 0;
  }

  /**
   * §9.2 horizon eligibility: arc ≥ 1, ≥ 8 minutes of performance time in the arc, a persistent
   * high-confidence connection (merge) event, sustained occupied/coherent structure, valid
   * presentation-tier analysis, and a seeded per-arc Bernoulli draw at p ≈ .35. At most one
   * engagement per arc; when eligible the excursion engages and the camera animates the full
   * descent/hold/return cinematography.
   */
  private updateHorizon(input: DirectorInput): void {
    if (this.horizonUsedThisArc || this.horizonState !== 'idle') return;
    const perf = input.clock.performanceSeconds;
    const presentation = input.analysis.presentation;
    const arcElapsed = perf - this.arcStartPerformanceSeconds;
    const eligible =
      input.arc >= 1 &&
      arcElapsed >= HORIZON.minArcSeconds &&
      presentation.valid &&
      presentation.topologyConfidence >= DIRECTOR_POLICY.minPresentationConfidence &&
      this.sustainedStructureSeconds >= HORIZON.sustainSeconds &&
      perf - this.lastConnectionEventSeconds <= HORIZON.connectionEventMaxAgeSeconds &&
      this.horizonDraw < HORIZON.probability;
    if (!eligible) return;
    this.horizonState = 'engaged';
    this.horizonUsedThisArc = true;
    this.horizonEngagedAt = perf;
    this.horizonMoments += 1;
    this.horizonFocus = presentation.valid
      ? [presentation.centroidUV[0], presentation.centroidUV[1]]
      : this.camera.focusUV;
    this.horizonDistance = this.camera.distance * 0.85;
  }

  /** §9.2 excursion cinematography, or null when no horizon is in progress. */
  private horizonPhase(perf: number): { elevation: number; tau: number; mode: CameraState['mode'] } | null {
    if (this.horizonState !== 'engaged') return null;
    const elapsed = perf - this.horizonEngagedAt;
    const descent = HORIZON.descentSeconds;
    const hold = HORIZON.holdSeconds;
    const back = HORIZON.returnSeconds;
    if (elapsed <= descent) return { elevation: HORIZON.lowElevationRadians, tau: descent * 0.4, mode: 'horizon' };
    if (elapsed <= descent + hold) return { elevation: HORIZON.lowElevationRadians, tau: 5, mode: 'horizon' };
    if (elapsed <= descent + hold + back) return { elevation: CAMERA.elevationRadians, tau: back * 0.4, mode: 'horizon' };
    this.horizonState = 'returned';
    return null;
  }

  private updateCamera(dt: number, input: DirectorInput): void {
    if (this.cameraPinned) return;

    const perf = input.clock.performanceSeconds;
    const presentation = input.analysis.presentation;
    const health = input.analysis.chemistryHealth;
    const occupied = presentation.valid
      ? presentation.occupiedFraction
      : health.valid
        ? health.fullOccupiedFraction
        : 0;
    const intention = input.phase.intention;
    const stillness = input.phase.stillnessState;

    // §9.1: fit the projected occupied extent with a margin, clamped to a believable fill range.
    let fill = clamp(DIRECTOR_POLICY.minFillFraction + occupied * 1.2, DIRECTOR_POLICY.minFillFraction, DIRECTOR_POLICY.maxFillFraction);
    let targetFocus: Vec2 = this.camera.focusUV;
    const coarse = input.coarse;
    if (coarse && coarse.occupiedFraction > 0.01) {
      const [minU, minV, maxU, maxV] = coarse.boundsUV;
      const extent = Math.max(maxU - minU, maxV - minV);
      if (extent > 0) fill = clamp(extent * DIRECTOR_POLICY.boundsMargin, DIRECTOR_POLICY.minFillFraction, DIRECTOR_POLICY.maxFillFraction);
      // §4.3/§9.1: a seam-spanning organism's planar centroid is untrustworthy — retain the previous
      // focus rather than sliding toward the domain centre.
      if (!coarseSeamAmbiguous(coarse)) targetFocus = [coarse.centroidUV[0], coarse.centroidUV[1]];
    }
    // Presentation tier (preferred when valid): framing from the envelope-weighted bounds/centroid.
    if (presentation.valid && presentation.occupiedFraction > 0.01) {
      const [minU, minV, maxU, maxV] = presentation.boundsUV;
      const extent = Math.max(maxU - minU, maxV - minV);
      if (extent > 0) fill = clamp(extent * DIRECTOR_POLICY.boundsMargin, DIRECTOR_POLICY.minFillFraction, DIRECTOR_POLICY.maxFillFraction);
      // Retain the previous focus when the presentation topology confidence is low (seam/flicker).
      if (presentation.topologyConfidence >= DIRECTOR_POLICY.minPresentationConfidence) {
        targetFocus = [presentation.centroidUV[0], presentation.centroidUV[1]];
      }
    }
    // Fragmentation/withdrawal widens to reveal absence rather than chasing fragments.
    if (intention === 'release') fill = Math.min(fill, DIRECTOR_POLICY.minFillFraction + 0.05);
    // §9.1 event-aware: a new fragment/collapse widens for a bounded window.
    const widening = perf < this.widenResponseUntil;
    if (widening) fill = Math.min(fill, DIRECTOR_POLICY.minFillFraction + 0.05);
    // Stillness settles and waits; a quiet movement keeps whatever framing it had.
    if (stillness !== 'none' || intention === 'quiet') {
      return;
    }

    // §9.2: an in-progress horizon excursion overrides the baseline framing entirely.
    const horizon = this.horizonPhase(perf);
    if (horizon) {
      this.camera = {
        ...this.camera,
        mode: horizon.mode,
        focusUV: smoothVec2(this.camera.focusUV, clampFocus(this.horizonFocus), dt, HORIZON.descentSeconds * 0.5),
        yawRadians: this.camera.yawRadians, // §9.2: yaw stays essentially fixed
        elevationRadians: smooth(this.camera.elevationRadians, horizon.elevation, dt, horizon.tau),
        distance: smooth(this.camera.distance, this.horizonDistance, dt, horizon.tau),
        verticalFovRadians: this.camera.verticalFovRadians,
        transitionSeconds: horizon.tau,
      };
      return;
    }

    const desiredDistance = distanceForDomainFit(
      this.camera.verticalFovRadians,
      fill,
      SURFACE.domainWidth,
    );
    const retreating = intention === 'release' || widening ? DIRECTOR_POLICY.retreatDistanceGain : 1;
    // Near-overhead by default; the connection phase decelerates translation and tilts slightly. A new
    // merge event additionally decelerates and tilts for a bounded window (§9.1).
    const decelerating = perf < this.mergeResponseUntil;
    const desiredElevation =
      intention === 'connect' || intention === 'saturate' || decelerating
        ? DIRECTOR_POLICY.connectionElevationRadians
        : CAMERA.elevationRadians;

    const baseTau = intention === 'connect' || decelerating ? DIRECTOR_POLICY.responseSeconds * 2 : DIRECTOR_POLICY.responseSeconds;
    this.camera = {
      ...this.camera,
      mode: desiredElevation < CAMERA.elevationRadians - 0.01 ? 'approach' : 'overhead',
      focusUV: smoothVec2(this.camera.focusUV, clampFocus(targetFocus), dt, DIRECTOR_POLICY.framingSeconds),
      yawRadians: this.camera.yawRadians, // §9.1: yaw stays essentially fixed; no orbiting.
      elevationRadians: smooth(this.camera.elevationRadians, desiredElevation, dt, baseTau),
      distance: smooth(this.camera.distance, desiredDistance * retreating, dt, baseTau),
      verticalFovRadians: this.camera.verticalFovRadians,
      transitionSeconds: DIRECTOR_POLICY.responseSeconds,
    };
  }

  private updateLight(dt: number, performanceDelta: number, input: DirectorInput): void {
    if (this.lightPinned) return;

    // §9.3: a topological connection may slowly reveal a previously unlit edge. When the presentation
    // tier reports high coherence and a connection (merge) event has occurred this arc, the bounded
    // azimuth target is nudged **once** toward the dominant structural orientation (obliquely), and the
    // ordinary rate-limited travel then moves the light there and holds.
    const presentation = input.analysis.presentation;
    if (
      !this.lightOrientationApplied &&
      presentation.valid &&
      presentation.coherence >= HORIZON.sustainCoherence &&
      Number.isFinite(this.lastConnectionEventSeconds)
    ) {
      const nudge = clamp(
        wrapAngle(presentation.orientationRadians + Math.PI / 4),
        (-DIRECTOR_POLICY.orientationNudgeMaxDegrees * Math.PI) / 180,
        (DIRECTOR_POLICY.orientationNudgeMaxDegrees * Math.PI) / 180,
      );
      this.lightAzimuthTarget = LIGHTING.azimuthRadians + nudge;
      this.lightOrientationApplied = true;
    }

    // §9.3: travel toward the bounded per-arc target at no more than 25 deg/min, then HOLD. The
    // azimuth is never integrated without a target, so it cannot orbit the domain without bound.
    const maxStep = ((DIRECTOR_POLICY.azimuthTravelDegPerMinute * Math.PI) / 180) * (dt / 60);
    let azimuth = this.light.azimuthRadians;
    const delta = this.lightAzimuthTarget - azimuth;
    if (Math.abs(delta) <= DIRECTOR_POLICY.azimuthHoldEpsilonRadians) azimuth = this.lightAzimuthTarget;
    else azimuth += clamp(delta, -maxStep, maxStep);

    const health = input.analysis.chemistryHealth;
    const occupied = health.valid ? health.fullOccupiedFraction : 0;
    // §9.3: a bounded warmth + intensity lift accompanies sustained mature structure; there is no
    // full-field pulse and no circular orbit on a timer.
    const maturity = clamp((occupied - 0.25) / 0.35, 0, 1);
    const blackHold = input.phase.stillnessState === 'black-hold';
    const targetIntensity = blackHold ? 0 : LIGHTING.intensity * (1 + DIRECTOR_POLICY.matureIntensityGain * maturity);
    const targetEnvironment = blackHold ? 0 : MATERIAL.environment;
    const targetEmission = blackHold ? 0 : MATERIAL.emissionGain;
    const warmth: Vec3 = [
      clamp(LIGHTING.colorLinear[0] + 0.05 * maturity, 0, 1),
      clamp(LIGHTING.colorLinear[1] - 0.02 * maturity, 0, 1),
      clamp(LIGHTING.colorLinear[2] - 0.08 * maturity, 0, 1),
    ];

    // During a black-hold the fade must complete well inside the 20 s hold, so it is faster than the
    // ordinary response; otherwise changes take the §9.3 tens-of-seconds. The fade is paced by
    // performance time (§8.3) so it completes inside the hold at any playback speed.
    const dtLight = blackHold ? performanceDelta : dt;
    const tau = blackHold ? 3 : DIRECTOR_POLICY.responseSeconds;
    this.light = {
      azimuthRadians: azimuth,
      elevationRadians: this.light.elevationRadians,
      intensity: smooth(this.light.intensity, targetIntensity, dtLight, tau),
      colorLinear: [
        smooth(this.light.colorLinear[0], warmth[0], dtLight, DIRECTOR_POLICY.responseSeconds * 2),
        smooth(this.light.colorLinear[1], warmth[1], dtLight, DIRECTOR_POLICY.responseSeconds * 2),
        smooth(this.light.colorLinear[2], warmth[2], dtLight, DIRECTOR_POLICY.responseSeconds * 2),
      ],
      environment: smooth(this.light.environment, targetEnvironment, dtLight, tau),
      emissionGain: smooth(this.light.emissionGain, targetEmission, dtLight, tau),
      transitionSeconds: DIRECTOR_POLICY.responseSeconds,
    };
  }
}

function clampFocus(focus: Vec2): Vec2 {
  const bound = 1 - DIRECTOR_POLICY.focusClampUV;
  return [clamp(focus[0], DIRECTOR_POLICY.focusClampUV, bound), clamp(focus[1], DIRECTOR_POLICY.focusClampUV, bound)];
}

/** Wrap an angle into [-pi, pi]. */
function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function defaultCamera(): CameraState {
  return {
    mode: 'overhead',
    focusUV: [0.5, 0.5],
    yawRadians: CAMERA.yawRadians,
    elevationRadians: CAMERA.elevationRadians,
    distance: distanceForDomainFit(CAMERA.verticalFovRadians, CAMERA.domainFillVertical, SURFACE.domainWidth),
    verticalFovRadians: CAMERA.verticalFovRadians,
    transitionSeconds: CAMERA.responseSeconds,
  };
}

function defaultLight(): LightState {
  return {
    azimuthRadians: LIGHTING.azimuthRadians,
    elevationRadians: LIGHTING.elevationRadians,
    intensity: LIGHTING.intensity,
    colorLinear: LIGHTING.colorLinear,
    environment: MATERIAL.environment,
    emissionGain: MATERIAL.emissionGain,
    transitionSeconds: DIRECTOR_POLICY.responseSeconds,
  };
}
