/**
 * Central configuration for Phase 1.
 *
 * Every number here is either (a) fixed by architecture-plan.md, or (b) a clearly-labelled
 * calibration default that §6.2/B2 says is set during discovery. Values from the plan carry
 * the section number in a comment.
 */

/** §4.2: default simulation grid, independent of display aspect and resolution. */
export const SIMULATION_GRID = { width: 768, height: 768 } as const;

/**
 * §10 bounded exploration mode: a lab-only, coarser simulation grid used to *find* regimes quickly.
 *
 * The plan's §10 provision is that "higher exploration speed belongs only to bounded exploration mode
 * and is still limited by delivered numerical steps". A coarser grid delivers more of those steps per
 * frame for the same frame cost, so the measured step-budget cap is higher there (see
 * `artifacts/pacing.json`'s `exploration` section). Seed radii are specified in chemical cells
 * (§4.2), so at 512² the same radius covers more of the domain: this is a **calibration difference**,
 * not a nicer version of the piece, and it is deliberately not a presentation option.
 */
export const EXPLORATION_GRID = { width: 512, height: 512 } as const;

/**
 * §4.1: fixed numerical step, nominal delivered steps per performance second, bounds.
 *
 * `maxStepsPerFrame` and `speedRange` are a *measured* pair (deviation 31; operator pacing feedback):
 * `artifacts/pacing.json` records the drained 1080p frame cost at the production 768² grid for step
 * bursts of 0/8/16/24/32/48 (each repeated, reduced by median), fitted as `fixedFrameMs +
 * steps * perStepMs`. The artifact separates `policyFloors` (10.5 ms + 0.50 ms/step) from `observed`
 * (the runs in `history`: 7.06–7.44 ms fixed, 0.2249–0.2631 ms/step over the retained runs). The
 * floors are a documented *policy choice* — the retained observed maxima plus an engineering margin
 * for thermal/driver variance, realized as +3.06 ms absolute and ×1.90 (the artifact's `derivation`
 * recomputes both from `history`) — not observations. Against
 * the panel's 49.95 Hz frame period with a 15% safety margin and those floors that allows
 * 12 steps/frame; at 60 fps a 12-step frame supports 6× (12 * 60 / 120). The previous 8-step cap
 * capped playback at 4×.
 */
export const TIME = {
  dt: 1,
  nominalStepsPerSecond: 120,
  maxStepsPerFrame: 12,
  /** Real delta is bounded so a suspended tab cannot demand minutes of catch-up. */
  realDeltaBoundSeconds: 0.1,
  /** Accumulated debt bound (§4.1: 0.25 s of nominal work). */
  debtBoundSeconds: 0.25,
  speedRange: [0.25, 6] as const,
  /**
   * **Presentation default playback speed** (deviation 44; operator `Phase2ArcReview` directive
   * 2026-09-20). The operator found 1× too slow for a showcase, so the default is 3×: a nominal
   * 980-performance-second arc plays in ≈5.4 real minutes instead of ≈16.3. This consciously
   * overrides the brief's 10–30 minute real-time guideline (§6.3) for showcase pacing; the
   * laboratory slider still spans the full 0.25–6× range and 1× remains selectable there.
   * Performance-time semantics (dwell, trajectory progress, cadence) are unchanged — speed only
   * changes how many real seconds deliver a performance second.
   */
  defaultSpeed: 3,
} as const;

/**
 * §10 bounded exploration mode: the same measured policy at the coarser 512² grid, recorded in
 * `artifacts/pacing.json`'s `exploration` section (deviation 34). Over the five retained runs the
 * fitted per-step cost there was 0.0908–0.1199 ms against 0.2249–0.2631 ms at 768² (1.9–2.9× cheaper;
 * both grids' full histories are in the artifact), and the retained 24-step medians were
 * 10.59–11.59 ms of frame time against the 20.02 ms panel period — so, exactly as on the presentation
 * grid, the cap here is policy-driven rather than cost-driven. Its floors derive from its own retained
 * maxima (fixed 11.0 ms = 7.78 + 3.22; per-step 0.22 ms = 0.1199 × 1.83; the artifact's `derivation`
 * recomputes both from `history`), which is why this grid's cap is 24 steps/frame (a 12× ceiling)
 * against 12 steps/frame (6×) at 768².
 */
export const EXPLORATION = {
  maxStepsPerFrame: 24,
  speedRange: [0.25, 12] as const,
} as const;

/**
 * §6.2 laboratory safety envelope. The default F/k sits in the classic worm/labyrinth corner
 * of the unweighted five-point solver; the exact mature parameters were chosen from
 * `scripts/tune.ts` runs (see README-gate.md).
 */
export const DEFAULT_PARAMS = { F: 0.03, k: 0.062, Du: 0.16, Dv: 0.08 } as const;
export const PARAM_ENVELOPE = {
  F: [0, 0.1] as const,
  k: [0, 0.09] as const,
  Du: [0.0001, 0.2] as const,
  Dv: [0.0001, 0.2] as const,
} as const;

/** §4.4 genesis geometry and targets. */
export const GENESIS = {
  /** Smooth mix target for a seed disk. */
  targetU: 0.45,
  targetV: 0.28,
  /** Edge softness in cells (plan: 1–2). */
  edgeSoftnessCells: 1.5,
  defaultRadiusCells: 6,
  pattern: 'single' as const,
} as const;

/** §5.2 height / support construction. */
export const SURFACE = {
  /** Domain width in world units (plan: 2). */
  domainWidth: 2.0,
  /** Relief amplitude in world units; plan bound is .001–.008, calibrated to .006. */
  reliefAmplitude: 0.006,
  reliefAmplitudeRange: [0.001, 0.008] as const,
  /** Smoothed V contributes ~80% of height, smoothed boundary magnitude ~20%. */
  smoothedVWeight: 0.8,
  boundaryWeight: 0.2,
  /** Saturating remap of smoothed V: 1 - exp(-v / scale). */
  softenedVScale: 0.25,
  /** Boundary magnitude saturation scale for |grad V| (cells^-1). */
  boundarySaturation: 0.06,
  /** Support ramp on V (plan: 0.025–0.10). */
  supportVLow: 0.025,
  supportVHigh: 0.1,
  /** Separable five-sample Gaussian, sigma ~1.2 simulation cells. */
  blurSigmaCells: 1.2,
  /** Change normalisation for |V - V_prev| (per numerical step). */
  changeSaturation: 0.02,
} as const;

/** §5.3 geometry and material. */
export const MATERIAL = {
  /** 256 x 256 quad grid (256 subdivisions = 257^2 vertices). */
  sheetSubdivisions: 256,
  f0: 0.04,
  /** Top of the plan's .24–.36 band: the broader lobe catches grazing light on shallow rims. */
  roughness: 0.36,
  roughnessRange: [0.24, 0.36] as const,
  diffuseAlbedo: 0.012,
  /** Faint horizon reflection term, not a colorful HDRI. */
  environment: 0.05,
  emissionGain: 0.05,
  emissionTintLinear: [1.0, 0.86, 0.7] as const,
  /** Specular base colour: near-neutral cool white. */
  specularTintLinear: [1.0, 0.99, 0.98] as const,
} as const;

/** §5.4 fixed peripheral envelope: full strength to 65% of radius, fade to black. */
export const ENVELOPE = {
  fullStrengthRadius: 0.65,
  zeroRadius: 1.0,
} as const;

/** §5.4 bloom: soft knee at linear luminance 1.0, three levels, gain .04 cap .12. */
export const BLOOM = {
  levels: 3,
  threshold: 1.0,
  knee: 0.5,
  gain: 0.04,
  gainCap: 0.12,
} as const;

/**
 * Fixed exposure. Calibrated from `tests/browser/calibrate.spec.ts` on the target machine: with
 * relief .006, roughness .36 and light intensity 30, exposure 1.5 places the brightest ridges at
 * ~247/255 with no highlight clipping (0% of pixels at or above 250) while leaving more than half
 * the frame at exactly 0. Exposure stays a fixed constant; §5.4 forbids auto-exposing black
 * states into visibility.
 */
export const COMPOSITE = { exposure: 1.5 } as const;

/** §9.1 camera: 28 degree vertical FOV, 84 degree elevation, near-orthographic read. */
export const CAMERA = {
  verticalFovRadians: (28 * Math.PI) / 180,
  elevationRadians: (84 * Math.PI) / 180,
  yawRadians: 0,
  /** The 2-unit domain spans this fraction of the visible vertical extent. */
  domainFillVertical: 0.9,
  /** Slow approach only; Phase 2 owns camera policy. */
  responseSeconds: 30,
} as const;

/** §9.3 one dominant light, initial elevation 8 degrees, faint neutral-cool. */
export const LIGHTING = {
  elevationRadians: (8 * Math.PI) / 180,
  azimuthRadians: (135 * Math.PI) / 180,
  /**
   * Calibrated (calibrate.spec.ts): a dark dielectric under an 8-degree grazing source returns
   * almost nothing on flat interior and only the shallow rims light up, so the intensity has to
   * be high for the material to be legible at all. 30 puts the ridge highlights near white
   * without clipping.
   */
  intensity: 30,
  colorLinear: [0.92, 0.96, 1.0] as const,
} as const;

/** §11.1 the internal HDR scene never exceeds a 1920x1080-equivalent pixel count. */
export const SCENE = {
  pixelBudget: 1920 * 1080,
  maxScale: 1,
} as const;

/** §2.3 cursor auto-hide, laboratory key, publish rate. */
export const UX = { cursorIdleSeconds: 3, publishHz: 2 } as const;

/**
 * §4.1/§7.1 analysis and publication cadence (MAJOR 3).
 *
 * Both the tier-1 analysis request and the `WorldState` publication are scheduled on **delivered
 * performance time** at 2 Hz — the same rate the plan specifies, but measured in the time the piece
 * actually delivers rather than in wall time. Under acceleration that would otherwise request 12 Hz at
 * 6× (3× more work per real second with no new information, since a sample takes several real seconds
 * to come back), so an explicit real-time ceiling of 4 Hz caps the *observed* rate: a skipped sample
 * stays skipped (§7.1) rather than queueing. At 1× the two rates coincide and behaviour is unchanged.
 */
export const CADENCE = { performanceHz: 2, realCeilingHz: 4 } as const;

/** §7.1 default analysis/publish dimensions used later; fixed here so the enums agree. */
export const ANALYSIS = { presentationWidth: 256, presentationHeight: 256 } as const;

/**
 * §7.1/§7.2 presentation-tier (tier-2) combined-sample layout and descriptor scale constants.
 *
 * The combined analysis slot is `presentation (256² RGBA8) ‖ health (1×1 float) ‖ framing (16×16
 * RGBA8)`: the §3.3 canonical presentation map starts at offset 0 and the 1×1 health record sits at
 * the canonical `0x40000`; the small 16×16 framing map the director already consumed is retained
 * (deviation 36's seam logic needs a per-edge occupancy grid the planar presentation tier cannot
 * provide) and appended after the health record. Deviation 46 records the reconciliation.
 */
export const PRESENTATION = {
  width: 256,
  height: 256,
  /** §7.1: mean `U*V^2` is packed divided by this in channel B. */
  fluxScale: 0.04,
  /** §7.1: mean `|V - V_prev|` per step is packed divided by this in channel A. */
  changeScale: 0.02,
  /** §7.2 envelope-weighted occupancy: a reduced texel counts as occupied above this reduced-V. */
  occupancyThreshold: 0.08,
  /** §7.2 edge-density threshold used for the mask perimeter/area term. */
  edgeThreshold: 0.12,
  /** §7.3 the three reduced-V thresholds whose planar component/hole counts are compared. */
  topologyThresholds: [0.08, 0.12, 0.16] as const,
  /** §7.3: components smaller than this are ignored ("remove isolated single-pixel artifacts"). */
  minComponentPixels: 3,
  /** §7.3: background components smaller than this are not holes. */
  minHolePixels: 3,
  /** §7.2: fixed 32-bin V histogram for the entropy descriptor. */
  histogramBins: 32,
  /** §7.2: symmetry is only meaningful at high occupancy confidence (normalized eigenvalue sep). */
  symmetryMinCoherence: 0.35,
  symmetryMinOccupied: 0.05,
  /** §7.4: the reduced V field is area-averaged to this square before the FFT. */
  spectrumSize: 128,
  /** §7.4 radial power bands in cycles/domain: 1–4, 4–12, 12–28, 28–64. */
  spectralBands: [
    [1, 4],
    [4, 12],
    [12, 28],
    [28, 64],
  ] as const,
} as const;

/** The canonical combined-sample slot byte layout (§3.3 worker protocol; deviation 46). */
export const ANALYSIS_LAYOUT = {
  /** 256² RGBA8 = 262144 bytes = 0x40000. */
  healthOffset: 0x40000,
  presentationBytes: 256 * 256 * 4,
  /** Reserved bytes for the 1×1 float health record (16 on RGBA32F, 8 used on RGBA16F). */
  healthReserveBytes: 16,
  /** 16×16 RGBA8 framing map (deviation 36), appended after the reserved health record. */
  framingBytes: 16 * 16 * 4,
  framingSize: 16,
} as const;

/**
 * §7.3/§3.4 event recognition thresholds and hysteresis (calibration defaults). All are measured in
 * performance seconds; the refractory window and the two-tick confirmation are anti-spam guards.
 */
export const EVENTS = {
  /** §7.3: a labyrinth/merge needs a β0 drop of at least this fraction over the window. */
  mergeDropFraction: 0.3,
  /** §7.3: the roughly-10-second comparison window. */
  windowSeconds: 10,
  /** §7.3: a hole-count rise of at least this many, or `holeRiseFraction` (whichever binds). */
  holeRiseAbsolute: 2,
  holeRiseFraction: 0.2,
  /** §7.3: a merge also needs a rising largest-component fraction. */
  largestRiseFraction: 0.05,
  /** §7.3: two confirming ticks before an event is emitted. */
  confirmTicks: 2,
  /** Minimum presentation topology confidence for a salient morphology event. */
  minTopologyConfidence: 0.35,
  /** Anti-spam: no new salient event within this many performance seconds of the previous one. */
  refractorySeconds: 8,
  /** §7.3: "non-collapsing occupied area" — occupancy must not drop by more than this fraction. */
  maxOccupancyDrop: 0.35,
  /** Birth: a new component must persist at least this many samples to count. */
  birthPersistenceSamples: 3,
  /** Collapse: sustained occupancy loss fraction and activity loss fraction for a collapse event. */
  collapseOccupancyFraction: 0.5,
  collapseActivityFraction: 0.5,
  /** Surge: activity must rise by at least this fraction and exceed the absolute floor. */
  surgeActivityFraction: 0.6,
  surgeActivityFloor: 0.01,
  /** Minimum confirmed merge candidates for a merge event. */
  mergeMinCandidates: 1,
} as const;

/**
 * §8 generative ambient audio (Phase 3).
 *
 * Every value here is either fixed by §8.2/§8.3 (the graph, the fundamental range, the voice
 * ratios, the granular bounds, the wet-send fraction, the scheduler cadence, the 8 s off / 3 s
 * wake / 8–15 s fade silence policy) or a clearly-labelled calibration default for the six
 * descriptor mappings. Levels stay conservative on purpose: the compressor is a safety net, not a
 * loudness effect (§8.2), and the offline render asserts peaks ≤ −6 dBFS.
 */
export const AUDIO = {
  /**
   * §2 (TAKE-4) fixed tonic **A2 = 110 Hz**, across seeds, arcs, pauses and rebirths. A fixed key keeps
   * listening comparison meaningful and prevents reset-time key jumps; the sound-substream seeds keep
   * their noise/IR/grain responsibilities and never choose pitch.
   */
  tonicHz: 110,
  /**
   * §2 (TAKE-4) just **major-pentatonic** ratios for degrees 0–4: A, B, C♯, E, F♯. Ratios are the
   * source of truth; the absolute scale index `k` maps to `tonic · 2^floor(k/5) · ratios[k mod 5]`.
   */
  scaleRatios: [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3] as const,
  /**
   * §3 (TAKE-4) absolute-scale-index **voicing table**, voice order = removal priority. Every row is a
   * related major / suspended / minor-color chord from the same pentatonic key — a major chord built on
   * each pentatonic note would not stay in one key, so the voicings are explicit rather than transposed.
   */
  padVoicings: [
    [0, 5, 8, 7], // A  → A2, A3, E4, C♯4 — warm major
    [1, 6, 9, 8], // B  → B2, B3, F♯4, E4 — suspended fourth
    [2, 7, 9, 8], // C♯ → C♯3, C♯4, F♯4, E4 — fourth + minor-third color
    [3, 8, 11, 10], // E  → E3, E4, B4, A4 — suspended fourth
    [4, 9, 12, 11], // F♯ → F♯3, F♯4, C♯5, B4 — suspended fourth
  ] as const,
  /** §2 base relative weights, before normalisation and the coherence colour on voice 3. */
  voiceWeights: [1, 0.48, 0.26, 0.22] as const,
  /**
   * §2 voice-0 waveform: harmonic amplitude table at harmonics 1/2/3, all sine phase. Divided by the
   * absolute sum (1.38) so the defined waveform bound is ≤ 1 under `disableNormalization:true`.
   */
  voice0Harmonics: [1, 0.28, 0.1] as const,
  /** §2 upper-voice waveform: harmonics 1/2, divided by 1.10 under `disableNormalization:true`. */
  voiceHarmonics: [1, 0.1] as const,
  /** §3 coherence reveals the chord colour on voice 3 (smoothstep window; never a universal major third). */
  chordColorLow: 0.25,
  chordColorHigh: 0.75,
  /**
   * §2/§3 (TAKE-4) the pad's musical anchors: the tonic and the top of the base pentatonic register
   * (`110 · 5/3 ≈ 183.333 Hz`). These are the *key* bounds, not a continuous feature-scale sweep — the
   * pad's degree is chosen by the activity-band selector below.
   */
  fundamentalMinHz: 110,
  fundamentalMaxHz: 110 * (5 / 3),
  maxVoices: 4,
  /** §3 (TAKE-4) one bounded logarithmic glide per committed degree change (no restart, no gain boost). */
  glideSeconds: 1.25,
  /**
   * §2 (TAKE-4) activity-band selector. `a = clamp(reactionActivity, 0, ceiling)`,
   * `x = ln(1 + a/knee) / ln(1 + ceiling/knee)` ∈ [0,1]; five bands at the edges below select the pad
   * degree. Selector τ 1.5 s, Schmitt hysteresis, and a 1 s / 3-distinct-sample confirmation.
   */
  activityCeiling: 0.03,
  activityKnee: 0.001,
  activityBandEdges: [0.2, 0.4, 0.6, 0.8] as const,
  selectorTau: 1.5,
  selectorHysteresis: 0.025,
  /** §4 (TAKE-4) coherence bands select the bloom degree; same delays, slightly wider hysteresis. */
  coherenceBandEdges: [0.2, 0.4, 0.6, 0.8] as const,
  coherenceHysteresis: 0.03,
  /** §2/§4 confirmation: a candidate band needs ≥ this many real seconds and ≥ this many fresh samples. */
  confirmSeconds: 1,
  confirmSamples: 3,
  /** §2 (TAKE-4) ≥ 12 real audio-clock seconds between committed pad-degree changes. */
  degreeRefractorySeconds: 12,
  /** §4 (TAKE-4) bloom register: featureScaleNorm ≥ .5 coarsely (initial), ≥ .55 fine→coarse, ≤ .45 coarse→fine. */
  registerFineToCoarse: 0.55,
  registerCoarseToFine: 0.45,
  registerInitialPivot: 0.5,
  /** §4 (TAKE-4) bloom octave offsets in scale degrees: coarse `scaleHz(degree+5)`, fine `scaleHz(degree+10)`. */
  bloomOctaveOffsetCoarse: 5,
  bloomOctaveOffsetFine: 10,
  /** §2 pad level floor and intensity term: `0.18 + 0.06·√intensity` for a supported field; zero if absent. */
  padLevelFloor: 0.18,
  padLevelIntensityGain: 0.06,
  /** §2 per-voice low-pass: `clamp(carrierHz · (3 + 2·intensity), 500, 2400)`, Q = 0.5. */
  voiceFilterBase: 3,
  voiceFilterIntensityGain: 2,
  voiceFilterMinHz: 500,
  voiceFilterMaxHz: 2400,
  voiceFilterQ: 0.5,
  /** §4 granular texture: a softly-shimmering full-Hann grain rather than a scuttling transient. */
  grainMinSeconds: 0.65,
  grainMaxSeconds: 1.2,
  grainPeak: 0.85,
  /** §4 rate: `1.4 · fineDetail² · (1−fragmentation)` grains/s; peak value 1.4. */
  maxGrainsPerSecond: 1.4,
  /** §4 at most 4 concurrent grains (below the approved 12); never fill a missed interval with a burst. */
  maxConcurrentGrains: 4,
  /** §4 next-grain spacing `(0.75 + 0.5·rng.next())/rate`. */
  grainSpacingLow: 0.75,
  grainSpacingRange: 0.5,
  /** §4 shared filter chain: high-pass 700 Hz Q=0.5; band-pass Q=0.65 centre 1100→2400 Hz; low-pass 4200 Q=0.5. */
  textureHighpassHz: 700,
  textureHighpassQ: 0.5,
  textureBandpassQ: 0.65,
  textureLowpassHz: 4200,
  textureLowpassQ: 0.5,
  /** §4 band-pass centre maps logarithmically 1100→2400 Hz by fine detail. */
  grainFilterMinHz: 1100,
  grainFilterMaxHz: 2400,
  /** §4 texture bus gain `0.07 · fineDetail · (1−fragmentation)`; no early texture floor. */
  textureLevelMax: 0.07,
  /** §5 reverb wet gain `0.07 + 0.04·clamp01(0.5·coherence + 0.5·intensity)` → 0.07–0.11. */
  wetMin: 0.07,
  wetMax: 0.11,
  /** §3 porcelain bloom: three temporary sine partials at 1/2/3 × baseHz, normalised amplitudes. */
  bloomPartialRatios: [1, 2, 3] as const,
  bloomPartialAmplitudes: [0.72, 0.21, 0.07] as const,
  /** §4 (TAKE-4) raised-cosine 180 ms attack, then exponential decay τ 0.85 / 0.55 / 0.35 s. */
  bloomAttackSeconds: 0.18,
  bloomDecayTaus: [0.85, 0.55, 0.35] as const,
  /** §3 from 3.3 s a 100 ms bounded terminal fade; stop/disconnect all bloom nodes by 3.42 s. */
  bloomTerminalFadeStart: 3.3,
  bloomTerminalFadeSeconds: 0.1,
  bloomLifetimeSeconds: 3.42,
  /** §3 peak event gain `0.065 · clamp(0.4 + eventStrength, 0.4, 1)`. */
  eventLevelMax: 0.065,
  /** §8.3 smoothing time constants (seconds): pad level 3, newly admitted/removed upper voices 10. */
  levelTau: 3,
  upperVoiceTau: 10,
  filterTau: 6,
  textureTau: 4,
  wetTau: 8,
  /** §6 presence: support-on 0.001, support-off 0.00025, two samples and 0.5 s to confirm. */
  supportOnFraction: 0.001,
  supportOffFraction: 0.00025,
  supportConfirmSamples: 2,
  supportConfirmSeconds: 0.5,
  /** §6 the unified reveal/activation: a 1.5 s linear master ramp; the root floor regains in 0.75 s. */
  revealSeconds: 1.5,
  rootRevealSeconds: 0.75,
  /**
   * §8.3 general silence gate: a field with occupancy/activity below the off thresholds **and** support
   * below support-off for 8 s → terminally bounded fade over 8 s. A visually supported low-activity
   * body is not empty dormancy, so the support condition is required.
   */
  offOccupancy: 0.01,
  offActivity: 0.001,
  offSeconds: 8,
  fadeSeconds: 8,
  /** §8.2 at least 15 s between porcelain blooms. */
  eventRefractorySeconds: 15,
  /** §3 (TAKE-4) zero detuning: coherence controls the chord-colour gain and the wet send only. */
  maxDetuneCents: 0,
  /**
   * Conservative levels (linear, pre-compressor). §2's active pad level is `0.18 + 0.06·√intensity`
   * (a living-field floor, exactly zero when support is absent), the bloom peak is `0.065·clamp(…)` and
   * the texture bus is `0.07·fineDetail·(1−fragmentation)`. `masterLevel` remains the single
   * overall-output trim (post-compressor) and the headroom knob if the offline peak approaches −6 dBFS.
   */
  masterLevel: 0.75,
  /** Descriptor reference scales for the six normalized mappings (calibration defaults). */
  intensityOccupancyRef: 0.3,
  intensityActivityRef: 0.02,
  edgeDensityRef: 0.15,
  /**
   * §8.2 scheduler: a 50 ms tick with a 150 ms lookahead. Each tick schedules every *due* grain with a
   * start time spread across `[now, now + lookaheadMs]` (MAJOR 4) rather than batching them all at
   * `now`; the granular cursor is resynced to `now` after a stall longer than `stallSeconds` so overdue
   * debt can never release a burst.
   */
  tickMs: 50,
  lookaheadMs: 150,
  /** Gap between ticks beyond which the granular cursor drops its overdue debt instead of replaying it. */
  stallSeconds: 1,
  /**
   * §6/§2.3 unified reveal/activation window: the master is anchored at exactly 0 while locked and
   * ramps up over this bounded window on the locked→running edge or the confirmed-support reveal (only
   * when presence is eligible), so activation fades from zero and never plays a catch-up burst.
   */
  activationFadeSeconds: 1.5,
  /**
   * §8.3 fresh-performance de-click: a restart/reseed **holds the computed live master level** at the
   * abort instant, ramps linearly to zero over this bounded window (80–150 ms), performs the buffer/IR
   * swap while the master is at zero, and only then fades back up. Without it a restart would step a
   * live master to zero (an instantaneous nonzero→zero discontinuity = a click).
   */
  declickSeconds: 0.1,
  /**
   * Generated buffers (§8.2/§5): a deterministic 2 s noise buffer and a 2.4 s luminous stereo IR. The
   * seeds are **fallbacks only** — the live system and the offline driver derive the §4.4 `sound`
   * substream from the recorded root seed (MAJOR 3); these constants are used when no root seed is
   * supplied.
   */
  noiseSeconds: 2,
  irSeconds: 2.4,
  /** §5 IR recipe: exp(−t/0.32) envelope, 10 ms smoothed onset, final 100 ms faded to exact zero. */
  irEnvelopeTau: 0.32,
  irOnsetSeconds: 0.01,
  irTailSeconds: 0.1,
  /** §5 one-pole low-pass cutoff declining exponentially 5500 → 2200 Hz over the IR duration. */
  irCutoffStartHz: 5500,
  irCutoffEndHz: 2200,
  noiseSeed: 0x51ce5eed,
  irSeed: 0x1a2b3c4d,
  /** §8.2 safety compressor (a limiter is not assumed; peaks are verified, not trusted). */
  compressor: { thresholdDb: -18, kneeDb: 6, ratio: 4, attackSeconds: 0.01, releaseSeconds: 0.25 },
  /** §8.2 fixed high-pass at 25 Hz before the master gain. */
  highpassHz: 25,
} as const;

/**
 * §9.2 rare horizon eligibility (director-owned). Eligibility requires arc ≥ 1, ≥ 8 minutes of
 * performance time in the arc, a persistent high-confidence connection (merge) event, sustained
 * occupied/coherent structure, valid presentation-tier analysis, and a seeded per-arc Bernoulli
 * draw at p ≈ .35 (deviation 38 updated: horizon is enabled now that the presentation tier is live).
 */
export const HORIZON = {
  minArcSeconds: 8 * 60,
  probability: 0.35,
  /** The connection event must be no older than this for the eligibility check. */
  connectionEventMaxAgeSeconds: 120,
  /** Sustained structure: this many performance seconds of occupancy + coherence above thresholds. */
  sustainSeconds: 90,
  sustainOccupancy: 0.04,
  sustainCoherence: 0.3,
  /** §9.2 excursion timing (seconds) and the low elevation band (degrees). */
  descentSeconds: 75,
  holdSeconds: 30,
  returnSeconds: 75,
  lowElevationRadians: (15 * Math.PI) / 180,
  /** At most one horizon moment per arc. */
  maxPerArc: 1,
} as const;
