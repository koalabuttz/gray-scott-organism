# Architecture Plan: An Organism in Darkness

## Goal

Build a standalone, fullscreen, autonomous audiovisual Gray–Scott reaction–diffusion artwork per `idea.md` (Phases 1–4): a GPU simulation whose derived material, lighting, camera, analysis, and generative audio make an emergent "mathematical organism" perceptible, with no visible UI in presentation mode and a hidden laboratory behind `~`.

## Implementation Summary

- **Stack**: TypeScript + Vite + raw WebGL2 + WebAudio; local only; no frameworks. Rationale and alternatives in §2.
- **Core loop**: Curator → parameter trajectories/genesis → GPU Gray–Scott (RG32F ping-pong, fixed dt) → GPU reduction → async readback → CPU analysis worker → plain-data `WorldState` published at 2 Hz → visual policy (derived field → height/normals → material → bloom → tonemap) and audio (WebAudio graph consuming only `WorldState`).
- **Modules**: `src/{core,gpu,simulation,curator,analysis,visual,audio,lab}` per §3.1; simulation owns chemistry, curator owns composition, analyzer owns descriptors, visual director owns camera/light targets.
- **Phases**: §12 gives the ordered implementation with machine-verifiable acceptance (§AC table) and operator aesthetic gates (`Phase1MaterialGate`, `Phase2ArcReview`, `Phase3CausalityReview`, `FinalFullArcReview`).
- **Hard gates**: Phase 1 image approval before Phase 2; trajectory/pacing approval before final acceptance.

## 1. Recommendation and design contract

Build a local browser application using **TypeScript, Vite, raw WebGL2, and WebAudio**, presented fullscreen in current stable Chromium on Linux. Use no visual framework, game engine, UI framework, backend, or runtime network dependency. Vite is development/build tooling; the artwork runs from static local assets served over localhost.

The mathematical simulation is authoritative. The curator changes its conditions; analysis describes its consequences; material, light, camera, and sound reveal those consequences. Nothing downstream may substitute a canned organism animation.

**The defining implementation gate is Phase 1:** "Can this stop looking like a reaction–diffusion shader demo and start looking like an unknown physical organism?" Do not proceed to long-form direction or audio until the operator approves the image.

### 1.1 Requirements and non-goals

Required:

- Autonomous, indefinitely repeating but nonidentical 10–30 minute arcs.
- Default presentation without labels, controls, borders, visible debug views, or persistent instructions.
- Real GPU Gray–Scott evolution, shallow derived relief, physically suggestive material, restrained grazing light, true black, and intentional silence.
- Morphology/topology/spectral analysis and a shared plain-data world snapshot.
- Hidden laboratory controls and trajectory-discovery tooling.
- Independent simulation and display resolutions, fixed numerical integration, bounded GPU work, infrequent reduced readback.

Not goals: a general-purpose engine, mathematically exhaustive persistent homology, volumetric fluid simulation, physically exact subsurface scattering, network services, machine-learned beauty optimization, ordinary music sequencing, or pixel-to-note sonification. Omit particles, refraction, chromatic aberration, film grain, and depth of field initially; none is required to establish the organism.

### 1.2 Evidence and status

Verified by reading `idea.md`:

- Mathematical substrate and fixed-step GPU requirement: lines 13–29.
- Derived material rather than concentration coloring: lines 31–80.
- Darkness, composition, and long-form emergence: lines 82–175.
- Structural, topological, and spectral analysis: lines 177–212 and 281–294.
- Minimal lighting, slow camera, and sparse global audio mappings: lines 214–279.
- Required architecture: lines 296–329.
- Hidden laboratory and parameter-discovery tooling: lines 331–378.
- Performance constraints: lines 382–394.
- Ordered phase gates: lines 396–458.
- Opening, success criteria, and justification of effects: lines 460–529.

The caller reports a greenfield project containing only `idea.md`. All paths below except that file are **proposed new files**, not existing implementation. No files were modified, commands run, dependencies installed, or tests executed during this design. API compatibility and numerical/artistic defaults below are proposals to verify on the target GPU, not measured results.

## 2. Stack, deployment, and alternatives

### 2.1 Chosen stack

- TypeScript in strict mode.
- Vite, with GLSL files imported as raw strings using `?raw`.
- Raw WebGL2 and a small project-local GL utility module.
- Native DOM controls for the hidden laboratory.
- WebAudio built-in nodes and reusable generated buffers; no AudioWorklet initially.
- Vitest for pure math/control tests; Playwright for browser smoke tests and captures.
- Package scripts: `dev`, `build`, `preview`, `test`, `test:browser`, and `explore`.
- Runtime is entirely local. Provide a README launch procedure using `npm install`, `npm run dev -- --host 127.0.0.1`, and opening the localhost URL. Production uses `npm run build` and `npm run preview -- --host 127.0.0.1`. Commit a lockfile once dependencies are installed.

Request WebGL2 with `alpha:false`, `antialias:false`, `depth:false`, `stencil:false`, and `preserveDrawingBuffer:false`. The renderer creates its own depth attachment. Require `EXT_color_buffer_float`; validate actual framebuffer completeness for every required format. Query texture/viewport limits and vertex texture sampling support. `EXT_disjoint_timer_query_webgl2` is optional instrumentation.

Use integer `texelFetch` and explicit interpolation for numerical float fields, so correctness does not depend on optional float-linear-filtering support. The project uses explicit downsample passes rather than assuming automatic float mip generation works identically everywhere.

### 2.2 Why this choice

WebGL2 exposes float ping-pong targets, multiple render targets, fullscreen passes, fences, and pixel-pack buffers. The application does not require compute shaders: raster passes handle diffusion, derivatives, reduction, and postprocessing. WebAudio supplies stable audio-clock scheduling and a native DSP graph without a separate sound engine.

Browser fullscreen, `canvas.toBlob`, `captureStream`, and `MediaRecorder` cover presentation and practical capture. Browser APIs still require capability checks, especially recording codecs and user activation. Capture is a helper, not a promise of lossless deterministic offline film export.

Rejected alternatives:

- **WebGPU:** attractive storage textures and compute reductions, but unnecessary for the chosen workload and adds adapter/backend and implementation complexity on Linux. Reconsider only if later simulation requirements genuinely need compute or WebGL2 proves insufficient on the deployment hardware.
- **Three.js:** useful for scene-heavy work, but this project is mostly controlled framebuffer passes and one displaced sheet. Raw APIs avoid abstractions that would still need bypassing for analysis and numerical passes.
- **Native OpenGL/Vulkan plus native audio:** potentially stronger kiosk control, but materially more build, packaging, and DSP friction with no requirement that offsets it.

### 2.3 Startup behavior

Start with a black canvas; simulation may begin but remain in dormancy. A click or Enter explicitly resumes audio and requests fullscreen. It must be possible to watch silently without that gesture. Do not repeatedly prompt or pretend sound/fullscreen succeeded if denied. Explain the activation gesture in the README and laboratory status, not as a permanent overlay on the artwork.

Escape remains the browser's fullscreen exit. Hide the cursor after three seconds of inactivity outside the laboratory. Restore it on movement. Ignore composition-changing hotkeys while a form field has focus.

## 3. Modules, ownership, and data flow

### 3.1 Proposed file layout

```text
idea.md
architecture-plan.md
README.md
package.json
package-lock.json
tsconfig.json
vite.config.ts
index.html
public/
  trajectories/default.json
src/
  main.ts
  app.ts
  config.ts
  styles.css
  core/
    types.ts
    clock.ts
    random.ts
    smoothing.ts
    commands.ts
    world.ts
  gpu/
    context.ts
    resources.ts
    fullscreen.ts
    readback.ts
    timing.ts
  simulation/
    simulation.ts
    genesis.ts
    shaders/{step,genesis}.frag
  curator/
    curator.ts
    trajectory.ts
    schema.ts
  analysis/
    analyzer.ts
    morphology.ts
    topology.ts
    spectrum.ts
    events.ts
    worker.ts
    shaders/{reduce,pack}.frag
  visual/
    renderer.ts
    director.ts
    camera.ts
    lighting.ts
    capture.ts
    shaders/
      field.frag
      blur.frag
      normals.frag
      surface.vert
      material.frag
      bloom-down.frag
      bloom-up.frag
      composite.frag
  audio/
    audio.ts
    voices.ts
    buffers.ts
  lab/
    lab.ts
    controls.ts
    diagnostics.ts
    explorer.ts
    capture.ts
scripts/
  explore.ts
tests/
  clock.test.ts
  random.test.ts
  simulation.test.ts
  genesis.test.ts
  trajectory.test.ts
  curator.test.ts
  topology.test.ts
  spectrum.test.ts
  events.test.ts
  worker-protocol.test.ts
  mapping.test.ts
  browser/smoke.spec.ts
  browser/gpu-correctness.spec.ts
  browser/capture.spec.ts
  browser/context-loss.spec.ts
  browser/readback-lifecycle.spec.ts
  browser/analysis-reduction.spec.ts
  browser/stillness-hold.spec.ts
  browser/audio-offline.spec.ts
  browser/soak.spec.ts
```

Do not split these files further until size or testing warrants it. The GPU layer is utilities, not a generic render graph framework.

### 3.2 Causal pipeline

```text
previous WorldState
      ↓
CURATOR → continuous parameters + bounded genesis commands
      ↓
GPU SIMULATION → U,V textures ────────────────────────┐
      ↓                                             │
GPU REDUCTION → asynchronous reduced readback        │
      ↓                                             │
CPU ANALYSIS WORKER                                 │
      ↓                                             │
WORLD ASSEMBLY (WorldStore.publish snapshot)          │
      ↓                                             │
WorldState, published at 2 Hz                        │
      ├→ AUDIO                                      │
      └→ VISUAL POLICY                              │
                    ↓                               │
             derived field ←────────────────────────┘
                    ↓
              height / normals
                    ↓
              material + lighting
                    ↓
               bloom / tone map
                    ↓
                  screen
```

The texture path is an explicit exception to plain-data messaging: renderers must sample the actual simulation. GPU resource handles never appear in `WorldState`. Other subsystems do not inspect textures, each other's mutable internals, or laboratory DOM state.

`app.ts` owns lifecycle, update order, commands, and quality policy. `Simulation` alone owns chemical textures. `Curator` alone owns movement and trajectory progress. `Analyzer` alone owns descriptor history. `VisualDirector` alone owns camera/light target decisions. `WorldStore` publishes immutable snapshots. Audio and rendering own their interpolation and DSP/render resources, not composition decisions.

### 3.3 Essential interfaces

```ts
type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Params = Readonly<{ F: number; k: number; Du: number; Dv: number }>;

type GenesisKind =
  | 'single' | 'competing' | 'line' | 'ring'
  | 'sparse' | 'radial' | 'structured';

type GenesisCommand = Readonly<{
  id: number;
  kind: GenesisKind;
  mode: 'replace' | 'inject';
  seed: number;
  center: Vec2;
  radiusCells: number;
  strength: number;
}>;

interface CuratorEnvironment {
  silence: { satisfied: boolean; terminalZeroAt: number | null }; // AudioSystem.silenceStatus(), sampled by the app this tick
}
interface Curator {
  advance(dtPerformance: number, environment: CuratorEnvironment, previous: WorldState): CuratorOutput;
  command(command: CuratorCommand): void;
}
interface CuratorOutput {
  parameters: Params;
  phase: PhaseState;
  genesis: readonly GenesisCommand[];
}
interface Simulation {
  step(parameters: Params, dt: number): void;
  seed(command: GenesisCommand): void;
  field(): FieldView; // readonly texture reference + size + epoch + step
  reset(seed: number): void;
  dispose(): void;
}
interface Analyzer {
  request(field: FieldView, stamp: SampleStamp, parameters: Params): boolean;
  poll(): AnalysisResult | null;
  reset(epoch: number): void;
  dispose(): void;
}
interface VisualDirector {
  derive(input: DirectorInput): VisualTargets;
  command(command: CameraCommand): void;
}
interface WorldStore {
  publish(input: WorldInput): WorldState;
  latest(): WorldState;
}
interface Renderer {
  render(field: FieldView, world: WorldState, dtReal: number): void;
  resize(width: number, height: number, scale: number): void;
  capture(): Promise<Blob>;
  dispose(): void;
}
interface AudioSystem {
  unlock(): Promise<void>;
  consume(world: WorldState): void;
  setTransport(paused: boolean): void;
  setMuted(muted: boolean): void;
  prepareSilence(): void;   // idempotent within one active kill-wait episode; re-armed after black-hold completes (§8.3)
  silenceStatus(): { satisfied: boolean; terminalZeroAt: number | null }; // terminalZeroAt in performanceSeconds (recorded when the internal audio-clock terminal-zero deadline is observed); locked/muted/unavailable audio → { satisfied: true, terminalZeroAt: null }
  recordingStream(): MediaStream | null;
  dispose(): void;
}
interface Lab {
  mount(host: HTMLElement, api: AppControl): void;
  update(world: WorldState, diagnostics: Diagnostics): void;
  dispose(): void;
}
interface AppControl {
  dispatch(command: AppCommand): void;
  exportTrajectory(): string;
  capture(): Promise<Blob>;
}
```

Transport types referenced above (all defined here, owned by `core/types.ts`):

```ts
type MovementId = string; // unique within one TrajectoryDocument

interface FieldView {
  texture: WebGLTexture;      // opaque handle; only Simulation mutates its contents
  width: number; height: number;  // chemical grid size
  epoch: number;              // invalidates all cached analysis on reset/replace
  step: number;               // delivered simulation steps
  simulationTime: number;     // numerical time at this field state
}

interface SampleStamp {
  epoch: number;
  step: number;
  simulationTime: number;
  performanceSeconds: number;
  parameters: Params;
}

interface AnalysisResult {
  stamp: SampleStamp;
  descriptors: AnalysisState;  // sample timestamps taken from stamp
  diagnostics?: { packSaturated: boolean; workerMs: number };
}

interface WorldInput {
  epoch: number;
  performanceSeed: number;
  clock: WorldState['clock'];
  phase: PhaseState;
  parameters: Params;
  analysis: AnalysisState;      // latest completed or neutral (both tiers carry their own validity)
  event: WorldState['events'];
  health: WorldState['health'];
  visualTargets: VisualTargets; // output of VisualDirector.derive for this tick
}

interface VisualTargets {
  camera: WorldState['camera'];
  light: WorldState['light'];
  material: WorldState['material'];
}

interface DirectorInput {
  analysis: AnalysisState;             // both tiers carry their own valid/age
  phase: PhaseState;
  latestEvent: WorldState['events'];   // serial-numbered; director tracks last-seen serial
  clock: WorldState['clock'];          // includes performanceSeconds and speed
  performanceSeed: number;
  arc: number;                         // per-arc once-only state resets here
  previous: VisualTargets;             // bounded transitions start here
  health: WorldState['health'];
}

type CuratorCommand =
  | { type: 'skip-movement' }
  | { type: 'load-trajectory'; document: TrajectoryDocument }
  | { type: 'parameters-override'; value: Params }
  | { type: 'parameters-release' }
  | { type: 'reseed'; genesis: GenesisCommand };

type CameraCommand = { type: 'override'; value: CameraOverride | null };
type CameraOverride = Readonly<Partial<WorldState['camera']>>;

// Laboratory-only, never part of WorldState:
interface Diagnostics {
  frameTimesMs: readonly number[];   // bounded ring
  simulationMsAvg: number;
  renderMsAvg: number;
  readbackLatencyMsP95: number;
  analysisBacklog: number;
  qualityTier: 0 | 1 | 2;
  overload: boolean;
  rendererInfo: string;
}
```

Ownership clarifications:

- Update order per publication tick is unambiguous: assemble `DirectorInput` from the latest analysis/phase/event/clock → `VisualDirector.derive(input)` returns `VisualTargets` → construct `WorldInput` (epoch, seed, clock, phase, parameters, analysis, event, health, **visualTargets**) → `WorldStore.publish(input)`. The director never writes to the store; the store generates only `tick` and performs no policy.
- **Stillness audio handshake.** When `phase.stillnessState` transitions to `'kill-wait'`, the app calls `AudioSystem.prepareSilence()` exactly once (idempotent). Before each `curator.advance`, the app samples `AudioSystem.silenceStatus()` and passes it via `CuratorEnvironment.silence`; `terminalZeroAt` is a **performance-seconds** timestamp recorded by `AudioSystem` when it observes its internal audio-clock terminal-zero deadline (AudioContext scheduling stays internal; conversion uses the app's real/performance clock mapping), and the curator observes the status with at most one publication tick of latency. **Idempotence is episode-scoped**: `prepareSilence()` is idempotent within one active `kill-wait`; when `stillnessState` returns to `'none'` (black-hold complete, wake/rebirth begun), `AudioSystem` re-arms by clearing its acknowledgement to `{ satisfied: false, terminalZeroAt: null }`, so every later arc's stillness requires a fresh acknowledgement (`curator.test.ts` includes a repeated two-arc case). The curator decides `black-hold` entry from `environment.silence` plus its own chemistry confirmation; no other module may gate rebirth.
- Horizon eligibility is director-owned state: `idle → eligible → engaged → returned`, reset to `idle` at each arc boundary. Eligibility requires `arc ≥ 1` elapsed performance time ≥ 8 minutes in this arc, a persistent high-confidence connection event this arc, sustained occupied/coherent structure, presentation-tier analysis valid, and a seeded per-arc Bernoulli draw (p ≈ .35) from `performanceSeed ⊕ arc`.
- `FieldView.epoch` is bumped by `Simulation.reset` and any genesis `replace`; analysis and director discard anything with a stale epoch.

Worker protocol (canonical, defined once here; `worker-protocol.test.ts` asserts it). **One transferable buffer per analysis sample — a combined sample slot**: 256×256 RGBA8 presentation bytes (256 KiB) followed by the 1×1 RGBA8 health record at fixed offset `0x40000` (256-byte aligned). Request: `analyze {epoch, sequence, stamp, presentationWidth, presentationHeight, healthOffset, buffer}`. Reply is a discriminated union: `result {epoch, sequence, stamp, status: 'ok' | 'stale' | 'error', descriptors?, diagnostics?, buffer}` — `descriptors` present only when `status === 'ok'`; `stale`/`error` carry a `diagnostics` reason. **Every** branch returns the same buffer as a transferable so pooled slots recycle; only an unresponsive/terminated worker loses buffers, and worker termination reinitializes the pool (fresh buffers, hard bound preserved) before the next request. Transfer buffers, never copy. Bounded request/reply messages, not a cross-application event bus.

### 3.4 WorldState snapshot

Use plain numbers, booleans, string enums, and fixed tuples. Never include DOM nodes, functions, GL objects, dates, audio nodes, or mutable typed arrays.

```ts
interface WorldState {
  version: 1;
  epoch: number;             // reset/context recovery invalidates old work
  tick: number;              // monotonically increasing publication index
  performanceSeed: number;
  clock: {
    realSeconds: number;
    performanceSeconds: number;
    simulationTime: number;
    paused: boolean;
    speed: number;
  };
  phase: PhaseState;
  parameters: Params;
  analysis: AnalysisState;
  events: {
    serial: number;
    kind: 'none' | 'birth' | 'merge' | 'fragment' | 'collapse' | 'surge';
    strength: number;
    atPerformanceSeconds: number;
  };
  camera: {
    mode: 'overhead' | 'approach' | 'horizon' | 'retreat';
    focusUV: Vec2;
    yawRadians: number;
    elevationRadians: number;
    distance: number;
    verticalFovRadians: number;
    transitionSeconds: number;
  };
  light: {
    azimuthRadians: number;
    elevationRadians: number;
    intensity: number;
    colorLinear: Vec3;
    environment: number;
    emissionGain: number;
    transitionSeconds: number;
  };
  material: {
    relief: number;
    roughness: number;
    emissionTintLinear: Vec3;
    exposure: number;
    bloomGain: number;
  };
  health: {
    qualityTier: 0 | 1 | 2;
    overload: boolean;
    audioUnlocked: boolean;
  };
}
interface PhaseState {
  arc: number;
  movement: MovementId;
  elapsedSeconds: number;
  progress: number;
  intention: 'quiet' | 'emerge' | 'expand' | 'connect' | 'saturate' | 'release';
  stillnessState: 'none' | 'kill-wait' | 'black-hold'; // drives the §8.3 silence handshake
}
interface AnalysisState {
  samplePerformanceSeconds: number;   // sample timestamp of the newest contributing tier
  sampleSimulationTime: number;
  // Tier 1 — full chemical domain. Feeds curator extinction/stillness safety only.
  chemistryHealth: {
    valid: boolean;                   // Phase 2 basic reduction already satisfies this tier
    ageSeconds: number;
    fullOccupiedFraction: number;
    fullReactionActivity: number;     // normalized mean UV² over the whole torus
    fullChangeRate: number;
  };
  // Tier 2 — envelope-weighted (visible) domain. Feeds events, director, audio.
  presentation: {
    valid: boolean;                   // false until Phase 3 analysis is live and fresh
    ageSeconds: number;
    meanU: number;
    meanV: number;
    occupiedFraction: number;
    reactionActivity: number;         // normalized mean UV² under the support envelope
    changeRate: number;
    edgeDensity: number;
    entropy: number;
    featureScaleUV: number;
    spectralBands: readonly [number, number, number, number];
    beta0Approx: number;
    beta1Approx: number;
    largestComponentFraction: number;
    topologyConfidence: number;
    persistenceSeconds: number;
    centroidUV: Vec2;
    boundsUV: readonly [number, number, number, number];
    orientationRadians: number;
    coherence: number;
    symmetry: number;
  };
}
```

Publish at 2 Hz of performance time, at most 4 Hz real time under accelerated laboratory playback. A snapshot can reuse the latest completed analysis with its original sample timestamp. Ignore stale/out-of-epoch results. Before analysis is implemented, publish neutral descriptors with both tiers `valid:false`; Phase 2 brings `chemistryHealth.valid` online (tier-1 reduction); `presentation.valid` arrives with Phase 3. Each consumer applies its own tier's validity: with an invalid/stale tier, that consumer falls back to elapsed-time policy while others keep working. GPU/frame diagnostic timings stay in a separate laboratory-only `Diagnostics` structure.

An event is a persistent serial-numbered record in a snapshot, not a callback. Consumers remember the last serial they acted on. At most one salient event per analysis update is sufficient. The intended precedence is collapse, fragment, merge, birth, surge.

## 4. Time, simulation, and genesis

### 4.1 Independent clocks

Use three clocks:

1. Real monotonic time for presentation interpolation and audio clock alignment.
2. Numerical simulation time, advanced only by completed fixed integration steps.
3. Performance time for movements, derived from delivered simulation steps at the nominal rate.

Default numerical `dt = 1`, nominal **120 simulation steps per performance second**. At 60 Hz this normally means two steps per frame; at 30 Hz it means four. This is an initial budget, not a requirement to equate one frame to one step.

Accumulate `realDelta * speed * 120` desired steps. Execute integer steps under an eight-step/frame maximum and measured simulation budget. Evaluate trajectory parameters at each delivered step's performance time. Bound real delta to 100 ms and accumulated debt to 0.25 seconds; do not spend minutes catching up after tab suspension. When overloaded, performance time slows with delivered work and diagnostics report it; never enlarge `dt` to catch up. At healthy target performance, arcs retain their intended real duration. Pause/hidden-tab suspends transport and smoothly mutes sound; resumption starts from the preserved state without backlog.

### 4.2 Chemical textures and shader

Default simulation grid: **768 × 768**, independent of display aspect and resolution. Quality tiers may choose 512² or 384² at an arc boundary. Laboratory provides an explicit 1024² option after profiling.

Two `RG32F` textures hold `(U,V)` and alternate input/output. Use nearest filtering, no mipmaps, and single color attachment. RG32F avoids the small-update quantization of half-float concentrations over slow trajectories. RG16F is not an automatic chemistry fallback; if required it must pass a separate stability/morphology comparison. Float image intermediates may use half precision.

The step fragment shader uses the previous entire field (Jacobi update), with an unweighted five-point Laplacian:

```text
L(X) = X(left) + X(right) + X(up) + X(down) - 4 X(center)
r = U * V * V
U' = U + dt * (Du * L(U) - r + F * (1 - U))
V' = V + dt * (Dv * L(V) + r - (F + k) * V)
```

`uDt`, `uF`, `uK`, `uDu`, `uDv`, and grid dimensions are uniforms. Use `highp` floats. Default `Du=.16`, `Dv=.08`, `dt=1`, grid spacing one chemical cell. The classic diffusion stability bound `dt * max(Du,Dv) <= .25` is necessary here but does not prove nonlinear reaction stability. Clamp final concentrations to `[0,1]` as a last guard, instrument out-of-range values in laboratory validation, and reject trajectories that depend on persistent clipping.

Simulation resolution changes the number of chemical cells and available organisms, not the stencil spacing. Do not scale diffusion by texture size implicitly. Seed radii are specified in chemical cells. Consequently, changing grid size is a new calibrated quality regime, not claimed to preserve identical morphology.

### 4.3 Boundary choice

Use **toroidal chemistry** with integer coordinate wrapping in the shader. This avoids a physical container wall shaping growth and supports rebirth without a visible edge. Render a single domain patch with a broad, stationary peripheral black falloff and camera framing that conceals the seam. Never render repeated tiles.

The presentation envelope does not alter chemistry. Analysis sees the chemical domain; topology diagnostics explicitly mark seam uncertainty. If structures span a seam, camera targeting keeps the previous focus rather than jumping between planar centroids.

### 4.4 Genesis pass

`genesis.frag` takes old chemistry, a replace/inject flag, seed geometry, seed number, and strength. Replace begins from `(1,0)`; inject leaves the surrounding field unchanged. A mask smoothly mixes toward approximately `(0.45,0.28)`, with edge softness 1–2 cells. Apply to the current input and swap normally; never sample a texture attached as the write target.

Patterns:

- `single`: disk, default radius 6 cells.
- `competing`: 3–5 asymmetrically spaced disks within the central 40% of the domain.
- `line`: 2–4 cells wide, 8–15% of the domain long.
- `ring`: radius 18–30 cells, wall 3–5 cells thick.
- `sparse`: 8–20 deliberately separated small disks, not whole-field random initialization.
- `radial`: near-threshold radial concentration bump around a small viable core; the diffuse component alone need not nucleate.
- `structured`: low-amplitude band-limited perturbation confined to an elliptical support plus one viable core.

Use a recorded uint32 root seed and deterministic PRNG substreams for chemistry, curator, and sound. Default root seed comes from `crypto.getRandomValues`; replay accepts an explicit seed. Vary seed position, asymmetry, strength by roughly ±5%, duration by ±8%, and F/k offsets within ±0.0004. Smooth parameter perturbations over 30–90 seconds and bound them to the validated trajectory envelope. Do not inject fresh independent pixel noise every frame. Continuous uncontrolled noise would obscure whether real morphology or decoration caused an event.

## 5. Derived material and render passes

### 5.1 Resource table and pass order

| Pass/resource | Size | Format | Meaning |
|---|---:|---|---|
| Simulation A/B | simulation grid | RG32F | U,V |
| Field extraction | simulation grid | RGBA16F | V, normalized chemical change, boundary magnitude, organism support |
| Horizontal/vertical blur | simulation grid | RGBA16F, ping-pong | softly filtered field descriptors |
| Surface field | simulation grid | RGBA16F | shallow height, boundary activity, support, spare |
| Normals | simulation grid | RGBA16F | signed XYZ normal, roughness |
| Material scene | scaled display | RGBA16F + DEPTH_COMPONENT24 renderbuffer | linear HDR light response |
| Bloom downsample chain | 1/2, 1/4, 1/8 scene | RGBA16F | thresholded optical spill |
| Bloom upsample | matching reduced sizes | RGBA16F | restrained multiscale bloom |
| Composite | full canvas | default framebuffer | tone-mapped sRGB output |
| Analysis reductions | successively reduced | RGBA16F | averaged chemical statistics |
| Analysis pack | 256² | RGBA8 | envelope-weighted presentation readback (combined sample buffer, offset 0) |
| Analysis health pack | 1×1 | RGBA8 | full-domain scalar chemistry-health record (combined sample buffer, offset 0x40000) |

`field.frag` and the final blur/surface extraction may share shader code, but their responsibilities remain distinct. MRT is available but deliberately unnecessary in the baseline: fewer mixed-format framebuffer assumptions simplify verification. Use separate passes initially and fuse only measured bottlenecks.

### 5.2 Height, normal, and activity construction

Derive height from smoothed concentration and local gradients, never from decorative noise. Start with a three-tap/separable five-sample Gaussian, sigma approximately 1.2 simulation cells. Define a soft organism support using V around 0.025–0.10; calibrate it alongside the chosen numerical convention.

For a domain width of 2 world units:

- Relief amplitude starts at `0.004`, bounded `0.001–0.008`.
- A saturating remap of smoothed V contributes approximately 80% of height.
- Smoothed boundary magnitude contributes approximately 20%.
- Support smoothly brings both height and opacity to zero outside the organism.

Central differences of height, with the actual world-space texel spacing, yield `normalize(-dh/dx, 1, -dh/dz)`. Store signed normals in float texture. Do not exaggerate normals independently until the shallow surface is convincing.

For emitted reaction activity, compute the local residual `abs(Dv*L(V) + U*V² - (F+k)*V)` and multiply its normalized/saturated value by boundary magnitude and support. This captures active change rather than making every high-V interior glow. Analysis separately records mean `UV²`, the reaction flux. Stable material can remain visible through specular light without needing continuous emission.

### 5.3 Geometry and material

Render one perspective-projected XZ sheet, width 2 world units, initially a **256 × 256 quad grid**. Vertex shader samples height; fragment shader samples the full-resolution normal and activity maps. This gives actual shallow displacement for the low-angle moment without making simulation detail depend entirely on mesh tessellation. Increase to 512 subdivisions only if horizon silhouettes visibly facet and budget permits.

Use a restrained GGX-style microfacet specular term with Schlick Fresnel, dark dielectric base, `F0` near .04, roughness initially .24–.36, and one soft grazing directional source. Approximate its softness with a broad lobe, not a costly shadow map. Environmental contribution is a faint horizon reflection term, not a colorful HDRI.

Add a weak, thickness/support-modulated boundary emission term. This is an artistic subsurface approximation, not a claim of physically exact transmission. Initial palette is near-neutral cool-white specular with faint warm-grey/amber emission. No rainbow concentration ramp. State may vary tint only within a narrowly bounded palette over tens of seconds.

The shader's final radiance is multiplied by chemical support and a broad fixed edge envelope. Unsupported surface contributes exact zero: the sheet must not reveal itself as a grey rectangle. Use a depth attachment for displaced geometry. No visible wireframe, infinite ground, or opaque horizon plane.

### 5.4 Composition, bloom, and black

Near-overhead framing initially reveals a small nucleus inside a wide black field. During mature states, camera distance aims for 50–80% **projected organism bounding extent**, not a mandate that 80% of pixels be bright. Favor negative space over centering every connected component.

The outer domain envelope has full strength through roughly the inner 65% of radius, then a slow fade to black before the patch edge. It remains fixed during an arc and is not animated to pretend the organism is dissolving. Collapse must primarily reduce chemical support.

Bloom: soft knee around linear luminance 1.0, three reduced levels, gain initially .04 and capped .12. Ordinary reflections should not all bloom. Keep fixed exposure by default; state-driven adjustments are bounded and take at least 30 seconds. Never auto-expose near-black states into visibility.

Composite linear HDR scene plus bloom, apply an ACES-style fitted filmic curve with `toneMap(0)=0`, then explicit linear-to-sRGB conversion. Avoid double gamma conversion. No grey offset, vignette that raises blacks, or dither applied to zero pixels. If banding needs dither, gate it to nonzero low luminance at less than one output code step.

## 6. Curator and trajectory data

### 6.1 Composition model

A movement is an intention and a parameter path, not a target image. The curator never writes morphology into the simulation except deliberate genesis commands. It may wait, hasten a path, choose a declared next movement, or authorize a bounded rescue.

Default movements:

1. Dormancy — hold black and allow readiness.
2. Nucleation — introduce one viable local event.
3. Cellular growth — allow separated living regions.
4. Replication — favor sustained proliferation.
5. Connection — invite elongation and contact.
6. Labyrinth — dwell on mature connectivity when it occurs.
7. Overgrowth — reduce available visual space and increase structural tension.
8. Collapse — withdraw chemical support gradually.
9. Stillness — retain genuine emptiness.
10. Rebirth — start again at a changed location and with related conditions.

### 6.2 Exact data shape

Use one versioned JSON document. Validate without adding a schema library: TypeScript type guards plus explicit numeric/range checks are sufficient.

```ts
interface TrajectoryDocument {
  version: 1;
  id: string;
  seed?: number;
  nominalStepsPerSecond: 120;
  dt: 1;
  durationScaleRange: readonly [number, number];
  parameterJitter: { F: number; k: number; correlationSeconds: number };
  genesisLibrary: Record<string, {
    kind: GenesisKind;
    center: Vec2;
    radiusCells: number;
    strength: number;
  }>;
  movements: MovementSpec[];
}
interface MovementSpec {
  id: MovementId;
  seconds: number;
  intention: PhaseState['intention'];
  waypoints: { at: number; p: readonly [number, number, number, number] }[];
  next: MovementId[];
  enterGenesis?: string;
  exitHint?: 'living' | 'replicating' | 'connecting' | 'complex' | 'empty';
}
```

`at` is strictly ascending normalized movement time in `[0,1]`. Each movement includes endpoints 0 and 1. `p` is `[F,k,Du,Dv]`. `next[0]` is the default edge; additional edges are only declared recovery alternatives. IDs must be unique and all edges/genesis references resolvable. Allow only finite numbers, known keys/enums, <=64 movements, <=64 waypoints each, and <=1 MB imports. Never evaluate imported code.

Initial laboratory safety envelope: `0<=F<=.1`, `0<=k<=.09`, `0<Du,Dv<=.2`; enforce the diffusion bound in addition. Imported trajectories are validated candidates, not automatically aesthetically approved.

### 6.3 Complete initial candidate trajectory

This is an implementation starting point for the specified unweighted five-point solver. The names describe intentions; the numerical paths **must not be represented as proven cells/worms/labyrinth transitions** until explored on this solver.

```json
{
  "version": 1,
  "id": "organism-01-candidate",
  "nominalStepsPerSecond": 120,
  "dt": 1,
  "durationScaleRange": [0.75, 1.25],
  "parameterJitter": {"F": 0.0004, "k": 0.0004, "correlationSeconds": 60},
  "genesisLibrary": {
    "first": {"kind":"single","center":[0.5,0.5],"radiusCells":6,"strength":1},
    "return": {"kind":"single","center":[0.61,0.43],"radiusCells":7,"strength":1}
  },
  "movements": [
    {"id":"dormancy","seconds":30,"intention":"quiet","waypoints":[{"at":0,"p":[0.026,0.06,0.16,0.08]},{"at":1,"p":[0.026,0.06,0.16,0.08]}],"next":["nucleation"]},
    {"id":"nucleation","seconds":40,"intention":"emerge","enterGenesis":"first","exitHint":"living","waypoints":[{"at":0,"p":[0.026,0.06,0.16,0.08]},{"at":1,"p":[0.03,0.062,0.16,0.08]}],"next":["cellular-growth","collapse"]},
    {"id":"cellular-growth","seconds":140,"intention":"expand","waypoints":[{"at":0,"p":[0.03,0.062,0.16,0.08]},{"at":1,"p":[0.035,0.064,0.16,0.08]}],"next":["replication"]},
    {"id":"replication","seconds":150,"intention":"expand","exitHint":"replicating","waypoints":[{"at":0,"p":[0.035,0.064,0.16,0.08]},{"at":1,"p":[0.0367,0.0649,0.16,0.08]}],"next":["connection"]},
    {"id":"connection","seconds":140,"intention":"connect","exitHint":"connecting","waypoints":[{"at":0,"p":[0.0367,0.0649,0.16,0.08]},{"at":1,"p":[0.03,0.057,0.16,0.08]}],"next":["labyrinth"]},
    {"id":"labyrinth","seconds":200,"intention":"connect","exitHint":"complex","waypoints":[{"at":0,"p":[0.03,0.057,0.16,0.08]},{"at":1,"p":[0.029,0.057,0.16,0.08]}],"next":["overgrowth"]},
    {"id":"overgrowth","seconds":120,"intention":"saturate","waypoints":[{"at":0,"p":[0.029,0.057,0.16,0.08]},{"at":1,"p":[0.045,0.058,0.16,0.08]}],"next":["collapse"]},
    {"id":"collapse","seconds":100,"intention":"release","exitHint":"empty","waypoints":[{"at":0,"p":[0.045,0.058,0.16,0.08]},{"at":1,"p":[0.005,0.075,0.16,0.08]}],"next":["stillness"]},
    {"id":"stillness","seconds":60,"intention":"quiet","waypoints":[{"at":0,"p":[0.005,0.075,0.16,0.08]},{"at":1,"p":[0.005,0.075,0.16,0.08]}],"next":["rebirth"]},
    {"id":"rebirth","seconds":40,"intention":"emerge","enterGenesis":"return","waypoints":[{"at":0,"p":[0.026,0.06,0.16,0.08]},{"at":1,"p":[0.03,0.062,0.16,0.08]}],"next":["cellular-growth","collapse"]}
  ]
}
```

Nominal first arc totals 980 seconds (~16.3 minutes; dormancy through stillness — the rebirth movement itself belongs to the next arc, since the boundary is the rebirth genesis). Subsequent boundary-to-boundary arcs run rebirth through stillness — 950 seconds (~15.8 minutes). **Arc boundary definition**: `phase.arc` increments exactly when the concealed stillness reset completes and the rebirth genesis is issued; per-arc state (rescue budget, horizon eligibility, event history) resets at that instant. Both durations sit inside the brief's 10–30 minute target before dwell modulation. Use minimum/maximum dwell of .75/1.25 times nominal seconds, plus small correlated duration jitter within those bounds. Maintain an overall 600–1800 performance-second arc guard; quiet dwell can absorb a premature failed emergence rather than immediately machine-gunning new seeds. **Post-approval retune (deviations 44/45, operator `Phase2ArcReview` directive):** the *shipped* document (`public/trajectories/default.json`) differs from this candidate — its `cellular-growth`/`replication` endpoint `k` values and `connection`'s start were moved down into the measured viable band (deviation 45 gives the exact values and evidence), and the presentation default speed is now 3× (deviation 44), so the 980 s arc plays in ≈5.4 real minutes instead of ≈16.3. This paragraph's durations remain the *performance*-time spec; they are unchanged.

### 6.4 Interpolation and feedback

Interpolate each waypoint segment with quintic smootherstep `6t^5-15t^4+10t^3`; it is bounded and avoids overshooting delicate F/k regions. This intentionally slows at waypoints. Transition starts from the actual current parameter vector, not blindly from an imported first waypoint. Laboratory skips crossfade parameters over 15 seconds; do not reset chemistry.

Analysis may scale local waypoint progress rate between .7 and 1.3:

- Sustained novelty/change or a recent merge slows progress.
- Stable, living, feature-rich states get extra dwell.
- Low novelty beyond the nominal dwell gently hastens progress.
- An exit hint can end a movement after minimum dwell, but is never required beyond maximum dwell.

Use 5–15 second smoothed descriptors and hysteresis. Do not chase every analysis tick. With invalid/stale analysis, revert to elapsed-time behavior.

Recognize premature extinction only after `analysis.chemistryHealth.fullOccupiedFraction` and `analysis.chemistryHealth.fullReactionActivity` remain below calibrated dead thresholds — with `chemistryHealth.valid` true and `ageSeconds` fresh — for at least 20 seconds, and only outside intentional quiet movements. Presentation-tier descriptors never gate extinction safety. Permit one injection rescue per arc if nucleation fails, then follow the declared collapse edge. Do not repeatedly reseed a dead trajectory.

Collapse raises kill and lowers feed gradually, and **stillness holds the collapse-end parameters `[F≈.005, k≈.075]` throughout — it never interpolates back toward a viable regime**. Stillness is not implemented as a visible reset. Its exit is an explicit state machine that **overrides ordinary movement maximum dwell**: state `kill-wait` until full-domain chemistry becomes negligible (tier-1 occupancy and activity below calibrated dead thresholds sustained ≥ 8 seconds) — or, if that has not occurred by 3× maximum dwell, emit exactly one diagnostic, hard-clear to an inert field, and log one clear. Either way, the stillness silence override (§8.3) fades audio from `kill-wait` entry (`AudioSystem.prepareSilence()` issued once by the app; status observed via `CuratorEnvironment.silence`); `black-hold` begins only when **both** the chemistry condition is confirmed (or the field cleared) **and** `silenceStatus().satisfied` is true. `black-hold` then holds director light/material targets at near-black with exact-zero audio gain for a fresh **20 seconds**, after which — and only after which — the concealed rebirth genesis and parameter transition may begin. No genesis is ever issued before `black-hold` completes; `curator.test.ts` asserts the `chemistryConfirmedAt`/`audioZeroAt`/`blackHoldStartedAt`/`genesisAt` ordering on both paths, and `browser/stillness-hold.spec.ts` verifies the integrated audiovisual hold. Rebirth chooses a related seed variation and location with at least 0.12 domain displacement from the prior origin.

### 6.5 Discovery tooling

The shipped candidate must pass discovery, not merely sit in source code as arbitrary numbers. `lab/explorer.ts` runs the existing simulation and analysis in an explicit laboratory-only exploration mode, rendering thumbnails periodically rather than every chemical step. `scripts/explore.ts` drives the same page with Playwright; it is not a second solver.

For each candidate endpoint/transition, run at least three fixed seeds, a settling interval, and a 60–120 performance-second observation interval. Transition tests continue the source field into the destination path; testing isolated endpoints is insufficient. Export JSON/CSV descriptors, seeds, solver settings, and contact-sheet PNGs. Compare diversity, occupancy, topology proxies, feature scale, and persistence side by side. Do not collapse all metrics into a universal beauty score. The operator approves paths after watching real-time transitions.

## 7. Analysis and morphological event detection

### 7.1 Readback design

At 2 Hz, two reductions run in the same analysis tick and write into **one combined sample buffer**. **Tier 2 (presentation):** reduce the chemical field to **256 × 256** with the support-envelope mask applied before averaging; pack into RGBA8 at offset 0: R=envelope-weighted U, G=envelope-weighted V, B=saturated envelope-weighted reaction flux divided by .04, A=saturated envelope-weighted residual divided by .02. **Tier 1 (health):** a full-domain (unweighted) scalar reduction to a 1×1 RGBA8 record at offset `0x40000`: R=full occupied fraction, G=full mean reaction flux, B=full change rate, A=spare. Record packing saturation in validation; adjust constants only through configuration and tests. One combined sample per tick flows through the PBO/fence ring; the worker receives it tagged with one `SampleStamp` and computes both tiers. In Phase 2, before the worker exists, the same ring runs with only the health region populated and the main thread evaluates the 4-byte health record directly (no worker, no presentation payload).

Use a three-slot pixel-pack-buffer ring, one combined sample slot each. Issue `readPixels` for both regions into the free slot, add a fence, flush once, and poll with zero-timeout `clientWaitSync` on later frames. Call `getBufferSubData` only after the fence signals, then transfer the combined sample buffer to the worker. Nonlinear reaction terms are calculated before averaging in both tiers. Never wait synchronously for a result. If no slot is free or the worker already has pending work, skip that analysis sample. If the target browser's asynchronous path is broken, use direct reduced readback at 1 Hz and measure the stall explicitly.

Do not assume a fence makes all driver overhead vanish; profile it. Keep at most one worker request active and one latest pending result. Tag every readback with epoch, simulation step, performance timestamp, and parameters. Reset all history on reseed/replace or resolution changes.

**Buffer ownership and recycling.** Maintain a bounded CPU pool of **3 combined-sample slots** (matching the PBO ring) with slot states `free → gpu-pending → cpu-ready → worker-owned → free`. The worker `result` message **returns the consumed buffer as a transferable on every branch** (`ok`, `stale`, `error`), so the analyzer reuses buffers instead of allocating per sample; long-run buffer identity must remain bounded (asserted by `worker-protocol.test.ts`). On `WAIT_FAILED` or a lost fence, delete the fence object, drop the sample, and return the slot to `free`. Delete each `WebGLSync` after it signals; never accumulate fences. If the worker stalls, at most one `cpu-ready` sample waits; further samples are skipped, never queued unboundedly.

**Visibility-weighted analysis (two tiers).** The broad peripheral envelope means analysis of the full torus can see chemistry the viewer cannot. Therefore: *tier 1 (full-domain)* — full occupied fraction, full reaction flux, full change rate, extinction safety — feed curator chemistry health only. *Tier 2 (envelope-weighted)* — occupancy, centroid/bounds, component/hole counts, event strength, symmetry, spectral bands that drive audio and camera — are computed in the reduction shader against the **same fixed support envelope the visual system uses** (an envelope mask applied before averaging), so hidden periphery cannot dominate presentation-facing signals. The topology seam-confidence rule stays as specified. Fixture requirement: a field active only in the hidden periphery must produce no strong presentation-facing event and no audible change (`events.test.ts`, `audio-offline.spec.ts`).

### 7.2 Descriptors

The worker computes:

- Mean U/V, mean reaction flux, occupied fraction, activity centroid/bounds.
- Change rate: mean absolute reduced-V difference divided by the actual sampled numerical time interval; never infer rate from readback arrival time.
- Edge density: mean central-difference V magnitude and threshold-mask perimeter per area.
- Entropy: normalized entropy of a fixed 32-bin V histogram. This is a coarse distribution descriptor, not a claim to measure artistic complexity.
- Spatial coherence/orientation: 2×2 gradient structure tensor; coherence is normalized eigenvalue separation. Keep the previous angle when the orientation is ill-defined.
- Symmetry: normalized correlation with reflected copies about the occupied centroid, only at high occupancy confidence.
- Feature scale and spectrum as below.
- Approximate components, holes, and persistence as below.

Map public control signals with fixed, documented smoothstep ranges established in discovery. Avoid continuously renormalizing against recent maxima, which would make barely living states as loud and bright as intense ones.

### 7.3 Topology-like analysis

Threshold reduced V at .08, .12, and .16. At each threshold, use 4-connected foreground components and 8-connected background components; the complementary connectivity avoids diagonal ambiguity. Count all foreground components of at least three reduced pixels. Count background components not touching the domain boundary, also above three pixels, as holes. Remove isolated single-pixel artifacts; do not use aggressive closing that would manufacture joins.

These are **planar, reduced-resolution proxies**, not exact Betti numbers of the toroidal simulation. Mark components touching opposing boundaries and lower `topologyConfidence` when seam involvement is substantial. Boundary-connected background is not counted as a hole. Do not interpret seam-crossing events as confident merges. `beta0Approx` and `beta1Approx` use the middle threshold; consistency across thresholds increases confidence.

Track component overlap between successive masks using labels and areas. Preserve an ID when overlap is dominant; multiple source IDs entering one destination signal a candidate merge. Maintain lifespan and require at least 3 samples of significance. `persistenceSeconds` is an area-weighted age summary, not persistent homology. Cross-threshold count agreement and temporal stability reject flicker.

A labyrinth event requires more than β0 falling: over a roughly 10-second window, demand a component-count drop of at least 30%, rising largest-component fraction, a hole-count rise of at least two or 20%, and noncollapsing occupied area. Require two confirming ticks and sufficient topology confidence. Thresholds are calibration defaults. Fragmentation uses the converse pattern with falling coherence/occupancy as supporting evidence. Collapse is a sustained large loss of occupancy and activity, not simply a split.

### 7.4 Spatial spectrum

Area-average V to **128 × 128** in the worker. Subtract its mean and apply a separable Hann window. Run a small radix-2 2D FFT in TypeScript using reusable arrays. No dependency is necessary; test against analytic fields.

Integrate radial power into four fixed bands measured in cycles/domain: 1–4, 4–12, 12–28, and 28–64; exclude DC. Normalize powers by total non-DC energy with an explicit near-zero branch returning zero bands. Estimate characteristic frequency by a power-weighted geometric mean; `featureScaleUV = 1 / characteristicFrequency` when valid. Spectrum describes resolved reduced detail only; frequencies above the analysis Nyquist limit are not measured.

In quiet states, feature scale is held or marked ineffective through near-zero band energy rather than reporting a meaningless infinity.

## 8. Audio architecture

### 8.1 Signals and causal mappings

Consume only `WorldState`, never image pixels or GPU resources. All signal mappings derive from the **presentation tier** of the analysis snapshot (`analysis.presentation`), so audio cannot be driven by chemistry the viewer cannot see; the chemistry-health tier is reserved for curator safety. Derive six smoothed controls:

- Scale from characteristic feature scale and low-band energy → deeper resonant fundamental.
- Fine detail from high-band fraction and edge density → sparse filtered granular texture.
- Intensity from reaction flux and occupancy → harmonic density and modest amplitude.
- Coherence → clearer frequency ratios and reduced detuning.
- Fragmentation/collapse → progressive removal of upper voices and texture bandwidth.
- Salient topology event serial → one subtle resonant excitation, not a drum hit.

No conventional beat, arpeggiator, or melody generator. Spectral richness may increase without every voice becoming louder.

### 8.2 Concrete graph

```text
4 sine/triangle drone voices → individual gain/filter ─┐
reusable noise grains → high/band-pass → texture gain ├→ dry bus ─┐
rare noise impulse → 3 resonant band-pass filters ────┘          │
                         └→ shared send → convolver → wet gain ┤
                                                             ↓
                                              high-pass 25 Hz
                                                             ↓
                                        master gain → compressor
                                                             ├→ audio destination
                                                             └→ MediaStream destination
```

- Generate a deterministic 2-second mono noise buffer and a 4–6 second dark decaying stereo impulse response once after activation.
- Fundamental maps logarithmically to approximately 38–82 Hz. Voice ratios start at `[1, 3/2, 2, 3]`; coherence tightens detuning toward these intervals. Never create an oscillator per cell.
- Granular layer uses 0.15–0.8 second windowed slices of the reusable noise buffer, 0–3 grains/second, at most 12 simultaneously. Fine detail controls probability and filtering, not a one-pixel/one-grain mapping.
- Event excitation is short filtered noise into resonances derived from the current fundamental. Enforce at least 15 seconds between resonant events; skip obsolete events after a stall.
- Initially keep wet gain around .12–.2 of the bus and overall output conservative. The compressor is a safety net, not a loudness effect. Built-in compression is not treated as a guaranteed true-peak limiter; verify recorded peaks and lower gain when necessary.

Schedule on `AudioContext.currentTime` using a 50 ms scheduler with a 150 ms lookahead. Store the latest world snapshot and schedule only short-horizon events, so browser timing does not create long queues of obsolete sounds. Reuse buffers, stop/disconnect completed source nodes, and bound live voice counts.

### 8.3 Smoothing and silence

Use exponential descriptor smoothing with time constants of 3–8 seconds, frequency glides of 8–20 seconds, and harmonic changes over 10–30 seconds. Apply automation through `AudioParam.setTargetAtTime` or bounded ramps; do not assign discontinuous gain/frequency each tick.

Silence gate: when occupancy and reaction activity remain below the calibrated off threshold for 8 seconds, ramp the master to exactly zero over 8–15 seconds, including the wet tail. Because `setTargetAtTime` approaches its target only asymptotically, the ramp must end with a **terminal assignment**: cancel prior automation on the master gain, ramp (`linearRampToValueAtTime` or a bounded `setTargetAtTime` phase) to 0 at the deadline, then `setValueAtTime(0, deadline)` — after which samples must be digitally zero in the offline test. Wake only above a higher threshold for 3 seconds. Quiet phase intent may lengthen the hold, but cannot create a loud sound from a dead field. On activation, fade from zero instead of playing a catch-up burst.

**Stillness silence override.** At `kill-wait` entry the app calls `AudioSystem.prepareSilence()` exactly once (idempotent), issuing the terminally bounded fade on **entry** to `kill-wait` — taking precedence over the general 8-second threshold — so the audio is already at terminal zero before `black-hold` can start. `AudioSystem.silenceStatus()` is the authoritative acknowledgement: `satisfied: true` when terminal zero has been reached, or `{ satisfied: true, terminalZeroAt: null }` when audio is locked, muted, or unavailable; `terminalZeroAt` is a performance-seconds timestamp recorded when the internal audio-clock terminal-zero deadline is observed. The acknowledgement is **episode-scoped** — re-armed (cleared to `satisfied: false`) when `stillnessState` returns to `'none'` — so each stillness episode requires its own `prepareSilence()` and a fresh acknowledgement. The curator receives the status through `CuratorEnvironment.silence` each tick; `black-hold` begins only when both the chemistry condition is confirmed (or the field hard-cleared) **and** the status is satisfied. The stillness browser test asserts the ordering `chemistryConfirmedAt` / `audioZeroAt` → `blackHoldStartedAt` → `genesisAt` (≥ 20 s later) on both normal and timeout paths with active audio (`browser/stillness-hold.spec.ts`). Quiet phase intent may lengthen the hold, but cannot create a loud sound from a dead field. On activation, fade from zero instead of playing a catch-up burst.

Pause, hidden-tab transport, lost GL context, or audio failure smoothly mutes; continued visual operation is allowed if audio is unavailable. Laboratory reports suspended/unlocked/running state truthfully.

## 9. Camera and lighting direction

`VisualDirector` updates targets when world snapshots are assembled. Renderer interpolates actual transforms every frame with critically damped or exponential motion; snapshot rate must not be visible.

### 9.1 Camera

Use a perspective camera with a narrow 28-degree vertical field of view. At 75–88 degrees elevation and suitable distance it reads as near-orthographic without projection-mode switching. Start at elevation 84 degrees, nearly fixed yaw, focus near genesis, distance determined by projected framing.

- Growth: slowly approach as bounds expand, using an 8–20 second filtered centroid and 30–90 second camera response.
- Connection: decelerate translation and allow a slight 5–10 degree tilt; show joining rather than chase it.
- Mature coherence: hold nearly motionless for long periods.
- Fragmentation: gently widen to reveal absence; do not zoom rapidly into each fragment.
- Stillness: settle and wait.

Fit projected occupied bounds with margins; clamp the focus to the inner domain so peripheral envelope edges stay offscreen. On seam ambiguity or low activity, retain the last meaningful focus. Do not periodically orbit and do not add sinusoidal camera wobble.

### 9.2 Rare horizon

Permit at most one horizon excursion per arc, after at least 8 minutes, only after a persistent high-confidence connection event and sustained occupied/coherent structure. Probability is seeded at about .35 per eligible arc; no eligibility means no horizon moment.

Transition from near-overhead to 12–18 degrees elevation over 60–90 seconds, hold 20–40 seconds, then return over 60–90 seconds. Keep yaw essentially fixed. Focus on an interior ridge region chosen from coarse activity/bounds, not a full random orbit. Clamp near/far planes and camera height to prevent surface clipping. Fade out distant support with the existing envelope; the horizon is a low view of real shallow relief, not a mountain created by multiplying displacement.

### 9.3 Light

One dominant light, initial elevation 8 degrees, faint neutral-cool color. Its azimuth target aligns obliquely to the dominant structural orientation when confidence is high; clamp travel to roughly 25 degrees per minute and then hold. Topological connection may slowly reveal a previously unlit edge; activity controls boundary emission locally in the shader. A bounded warmth shift may accompany sustained mature intensity.

Environment stays very faint. No nightclub colors, flashing events, full-field lighting pulses, or light completing a circular orbit on a timer. Near-invisible intervals are not lighting failures to be automatically corrected.

## 10. Laboratory, commands, and capture

Toggle using `KeyboardEvent.code === 'Backquote'` outside editable fields, supporting the physical key that produces `~` on common layouts. It opens a small DOM panel above the canvas. Closing it removes all diagnostic overlays and restores cursor timeout.

The laboratory uses the same command interface as application transport:

```ts
type AppCommand =
  | { type: 'restart'; seed?: number }
  | { type: 'reseed'; genesis: GenesisCommand }
  | { type: 'pause'; value: boolean }
  | { type: 'speed'; value: number }
  | { type: 'parameters'; value: Params; mode: 'override' | 'release' }
  | { type: 'skip-movement' }
  | { type: 'load-trajectory'; document: TrajectoryDocument }
  | { type: 'camera'; value: CameraOverride | null }
  | { type: 'diagnostics'; view: 'none' | 'analysis' | 'topology' | 'spectrum' | 'camera' }
  | { type: 'mute'; value: boolean };
```

App validates and queues commands, applies them at the next update boundary, and routes them to the owning module. Parameter override pauses trajectory progress but not chemistry; release blends from the override into the current path over 15 seconds. Manual reseed clears analysis history and increments epoch; skip does not clear chemistry. Restart starts a new complete arc. Speed supports 0.25–4; higher exploration speed belongs only to bounded exploration mode and is still limited by delivered numerical steps.

Provide:

- Restart/reseed/pause/speed/F/k/Du/Dv controls, current movement, skip, genesis selector.
- Trajectory import/export and waypoint capture from current parameters.
- Reduced-field, label/hole, spectral, and camera debug views.
- Laboratory-only performance and stale-analysis indicators.
- PNG screenshot and start/stop recording helpers.
- Export of seed, trajectory, quality tier, simulation step, parameters, descriptors, and camera state beside captures.

Capture the renderer's final frame before browser buffer discard using `canvas.toBlob` in the render/capture flow; no persistent `preserveDrawingBuffer` is required. DOM laboratory panels are not part of the canvas and are not included. If browser timing makes direct capture unreliable, render the final composite to an RGBA8 capture FBO and read that single requested frame.

Recording uses `canvas.captureStream(30)` and the audio MediaStream destination, with `MediaRecorder.isTypeSupported` to choose supported WebM codecs. Silent recording is valid before audio activation. Limit sessions to 10 minutes or a conservative accumulated data budget, report drops, and stop cleanly before exhausting memory. Live recording may reduce visual quality tier; it must not change numerical integration. Offline deterministic encoding is out of scope; seed-based replay is reproducible in configuration, not guaranteed bit-identical across different GPUs.

### Capture, recording, and trajectory import/export in practice

- **Screenshots** read the final composite in the same task as the draw, so no `preserveDrawingBuffer` is required. The laboratory panel is DOM, not canvas, and is never part of a capture — the canvas is the only thing captured.
- **Recording** uses `canvas.captureStream(30)` + `MediaRecorder`, choosing a codec through `MediaRecorder.isTypeSupported` (VP9 WebM on the target machine); a browser with no supported WebM codec reports recording as unsupported while screenshots keep working. Recording is **silent** — the current build has no audio system, so there is no audio track to mux.
- Recording is a **real-time screen recording, not a lossless deterministic export**: dropped frames are the browser's to report and are not measured here, and seed-based replay reproduces the *configuration*, never bit-identical pixels. A 60-second 720p clip is ~13 MiB.
- Sessions are bounded; stop before exhausting memory. Live recording may lower the visual quality tier but never changes numerical integration.

**Trajectory import/export in practice.** Import validates a document with `parseTrajectoryDocument` (explicit type guards and range checks; the text is **never** evaluated) from a file input or a textarea, and reports `import ok` or the rejection reason in the trajectory line while leaving the running piece intact; a parsed document replaces the active composition through the §6.4 crossfade without touching the field or the epoch. Export downloads the active document as `trajectory-<id>.json`, which round-trips through import. The document shape is fixed by §6.2 (see §6.2/§6.3); `public/trajectories/default.json` is the shipped example.

## 11. Performance and failure recovery

### 11.1 Initial budgets

Target: 60 fps at 1920×1080 on the intended modern discrete GPU with 768² chemistry, 120 substeps/second, and 2 Hz analysis. Treat these as acceptance targets, not measured promises.

Initial 16.7 ms frame budget:

- Simulation: approximately 4 ms.
- Derived fields: approximately 2 ms.
- Material + post: approximately 6 ms.
- CPU orchestration: approximately 1 ms.
- Remaining time: browser/driver variance and presentation.

Cap rendering pixel ratio rather than blindly using devicePixelRatio: default scene resolution is no greater than 1920×1080-equivalent pixel count. The display canvas can match the screen while the internal HDR scene is lower resolution. A 4K panel therefore does not quadruple chemistry or HDR cost automatically.

**Measurable acceptance thresholds** (AC.12 takes the audio peak ceiling; AC.14 takes the frame-time/readback/heap thresholds): on the target machine at default tier — p50 frame time ≤ 17 ms, p95 ≤ 22 ms, p99 ≤ 34 ms over any ≥ 5-minute window at 60 Hz; `overload` = tier threshold exceeded for > 30 consecutive seconds; analysis readback latency p95 ≤ 250 ms with backlog ≤ 1; two-hour soak resource slopes ≈ 0 (live audio nodes, GL textures/FBOs/programs, PBOs, fences, event listeners), heap growth < 10% after a 10-minute warmup, zero unbounded queues; audio capture peaks ≤ −6 dBFS; fixed-seed replay = identical configuration and command sequence with descriptor checkpoints within stated tolerance on the same GPU (never cross-GPU bit identity). The target machine is the operator's local Linux box: the implementer must log the GL renderer string (`WEBGL_debug_renderer_info`), Chromium version, and driver, and publish a capability report before Phase 1 acceptance; if the machine cannot sustain 768²/120 steps, degradation tiers apply and the achieved tier is documented (see §13 blockers).

Bound all resource queues and GPU allocations. Preallocate textures, worker arrays, FFT buffers, label arrays, and readback slots. Avoid per-frame object churn except small application state; snapshots arrive only at low frequency.

**Evidence.** `artifacts/capability-report.md` (and the per-project `capability-report-*.md`) records the renderer/driver/Chromium actually validated, the per-format framebuffer completeness results, and the harness provenance; `artifacts/phase1-performance.json` holds the measured pipeline cost and pure solver throughput. The 16.7 ms budget above is a target, not a measured promise, and the Phase-1 numbers in `phase1-performance.json` are **historical** measurements rather than a re-run.

### 11.2 Graceful degradation order

Measure multi-second moving averages and use hysteresis:

1. Reduce bloom levels from three to two and scene scale from 1 to .85 then .7.
2. Reduce analysis from 2 Hz to 1 Hz; disable laboratory diagnostics generation unless visible.
3. Reduce field/normal refresh to 30 Hz while rendering camera/light at display rate.
4. If still overloaded, explicitly enter a 30 fps presentation tier while retaining 120 simulation steps/second where feasible.
5. Schedule a lower chemistry resolution at the next dark rebirth boundary. Recalibrate seed cell geometry and record the tier; do not silently resample mid-arc.

If chemistry alone cannot keep up, slow performance time and report overload in laboratory status. Never skip chemical evolution while continuing the director as if it happened. Recover quality only after at least 30 seconds of headroom.

### 11.3 Recovery

On `webglcontextlost`, call `event.preventDefault()` — this **opts into** receiving restoration — then stop GPU work, mute audio, and discard pending analysis. On `webglcontextrestored`, recreate **every** GL resource and render state (textures, framebuffers, programs, buffers, the readback ring) and begin a quiet new arc with the recorded seed; exact simulation restoration is not promised without a saved field. `context-loss.spec.ts` exercises this with the `WEBGL_lose_context` extension. Invalid floating state, repeated framebuffer failure, or unrecoverable shader compile failure stops presentation and exposes a concise actionable error rather than a convincing-looking fake simulation.

Trajectory imports and capture files are local; no telemetry or remote upload. Object URLs and media tracks must be revoked/stopped on teardown. Browser capability errors are surfaced in startup/laboratory diagnostics and in the troubleshooting table below.

| Symptom | Cause and action |
|---|---|
| "The artwork could not start on this machine." | WebGL2 or `EXT_color_buffer_float` is unavailable, a required framebuffer format failed its render probe, or a probe shader failed to compile. The message names the reason; `artifacts/capability-report.md` has the details and the shader log. Try a Chromium with GPU access (`--ignore-gpu-blocklist --use-gl=angle --use-angle=gl-egl`). |
| Very low frame rate, high CPU | Chromium fell back to SwiftShader (software). The laboratory status line reports the renderer it actually got. |
| Fullscreen did not happen | The request was denied; the laboratory status line says so and the piece keeps running windowed. |
| Recording reports unsupported | `MediaRecorder` found no supported WebM codec; screenshots still work. |
| No sound | The current build is silent: there is no audio system, and the activation gesture reports "audio: none in Phase 1". |

## 12. Implementation Plan

### 12.1 Phase 1 — prove the image

Implement, in order:

1. Vite/TypeScript shell, black canvas, activation/fullscreen handling, resize, capability checks.
2. GL resources/fullscreen utilities, fixed-step clock, RG32F solver, single-seed genesis.
3. Field extraction, shallow height, normals, displaced sheet, grazing material.
4. HDR scene, black-preserving composition, restrained bloom.
5. Minimal hidden pause/parameter/screenshot controls and GPU diagnostics.

Machine-verifiable deliverables:

- Shader compile/link and framebuffer completeness checks on the actual target browser/GPU.
- CPU reference comparison for a small grid over 1 and 10 steps, including toroidal edges; numerical tolerance recorded rather than exact equality assumed.
- Uniform `(U=1,V=0)` remains invariant; seed changes only intended support; no sample/write attachment feedback.
- Synthetic 30/60/144 Hz clock tests deliver equivalent step counts for equal elapsed time under nonoverloaded conditions.
- Finite bounded field over a 10,000-step smoke run, with clipping frequency recorded.
- Screenshot checks for exact black background and nonzero image response to a viable seed.

Human gate, mandatory before Phase 2:

> Can this stop looking like a reaction–diffusion shader demo and start looking like an unknown physical organism?

Surface this with three labeled capture assets outside the presentation: a near-invisible state, a grazing edge close view, and a mature wet-material state, plus a 60–120 second real-time clip. Include seed/parameters and a simple operator checklist: tactile rather than colored texture; shallow not mountainous; invisible canvas boundary; black dominates; bloom restrained. A test passing does not substitute for approval. If the image fails, iterate material/relief/light/genesis only rather than adding audio to distract from it.

### 12.2 Phase 2 — prove long-form emergence

Add all genesis patterns, versioned trajectory import/export, interpolation, bounded curator graph, long-form clock, state-dependent lighting, slow camera, the tier-1 full-domain health reduction, and exploration mode. Extinction safety uses `chemistryHealth` (valid from Phase 2); `presentation.valid` remains false until Phase 3 analysis is live.

Acceptance:

- Unit tests cover waypoint endpoints, interpolation bounds, valid/invalid graph imports, deterministic PRNG, one-rescue limit, quiet dwell, and skip/release continuity.
- Record at least three complete 10–30 minute arcs with different seeds and one fixed-seed replay on the same GPU.
- Run an accelerated multi-arc soak for leaks and dead-state handling, plus real-time viewing for pacing.
- Export a discovery contact sheet and transition metrics; replace the candidate path with an operator-approved trajectory.
- Operator confirms related but distinct evolution, unforced growth/collapse, no arbitrary chapters or regular orbit, and believable periods of quiet.

### 12.3 Phase 3 — make the world listen to itself

Add asynchronous analysis readback/worker, topology proxies, FFT bands, temporal event recognition, complete WorldState publication, reactive camera/light eligibility, and the WebAudio graph.

Machine verification:

- Topology fixtures: empty field, disk, two disks, ring, figure-eight, diagonal contact, edge-crossing object, and noisy isolated pixels. Verify both counts and confidence behavior.
- Spectrum fixtures: constant field yields zero non-DC power; known sinusoidal fields land in expected bands; translations preserve band energy within window tolerance.
- Event fixtures: merging shapes with stable occupancy creates one merge event; fading shapes must not create a false merge; repeated snapshots do not retrigger audio.
- Stale/epoch-mismatched worker replies cannot overwrite current state.
- Audio mappings are bounded and monotonic where specified; OfflineAudioContext captures demonstrate fades to silence, finite output, bounded voice count, and conservative peaks.
- Browser tests exercise gesture-required activation, suspended audio, pause/resume, recording capability fallback, and analysis backlog skipping.

- Reduction contract: `browser/analysis-reduction.spec.ts` seeds deterministic fields (center-only activity, hidden-periphery-only activity), runs the real reduction/pack/readback shaders, decodes both combined-sample regions, and asserts expected channel values plus a material difference between `chemistryHealth` and `presentation`.

Operator review compares a synchronized capture with a short diagnostic report identifying the triggering structural events. The default artwork remains diagnostic-free. Confirm that sound feels caused by the organism, not like a spectrum analyzer or a preset ambient soundtrack. Confirm the rare horizon reveals real relief without turning it into terrain.

### 12.4 Phase 4 — refine as artwork

Tune pacing, palette, silence thresholds, material response, camera dwell, bloom, and sound using approved real-time viewing sessions. Remove anything that reads as a technology demonstration.

Acceptance:

- Two-hour real-time unattended soak on the target machine, recording frame-time summaries, readback latency, resource counts, number of resets/rescues, and audio state.
- Sustained target performance or explicitly documented fallback tier, bounded memory, no growing audio nodes/readback queues.
- Repeated full arcs include genuine quiet, rare earned intensity, distinct rebirth, and no visible laboratory leakage.
- Operator approves the opening and an entire arc, not only selected screenshots.
- Target GPU/browser/driver and the validated capability evidence are recorded in `artifacts/capability-report*.md`, and measured performance in `artifacts/phase1-performance.json` (§11.1). Launch/activation procedure lives in the README's Run section; capture limitations and trajectory import/export guidance live in §10; troubleshooting lives in §11.3 (see the Documentation Strategy).

GPU-dependent Playwright tests must report actual GL renderer/extension information. Software rendering in headless CI is useful for correctness smoke tests but cannot validate target-GPU performance or final material appearance.

## Acceptance Criteria

Each AC is verified by the named automated test(s) in §Test Strategy, or by the named manual gate with recorded artifacts. An AC fails if its test would fail on regression.

| ID | Criterion | Verification |
|---|---|---|
| AC.1 | `EXT_color_buffer_float` present; every required FBO format completeness-validated; renderer/Chromium/driver logged | `gpu-correctness.spec.ts` (capability report artifact) |
| AC.2 | GPU solver matches CPU reference at 1 and 10 steps, including toroidal edges, within recorded tolerance | `simulation.test.ts` (CPU reference), `gpu-correctness.spec.ts` |
| AC.3 | Uniform `(U=1,V=0)` is invariant under stepping; genesis changes only intended support; no read/write attachment feedback | `genesis.test.ts`, `gpu-correctness.spec.ts` |
| AC.4 | Synthetic 30/60/144 Hz clocks deliver equivalent step counts for equal elapsed time when not overloaded | `clock.test.ts` |
| AC.5 | Field finite/bounded over a 10,000-step smoke run; clipping frequency recorded and below calibrated bound | `simulation.test.ts`, `gpu-correctness.spec.ts` |
| AC.6 | Composite output: exact-black background with no seed; nonzero structured response with a viable seed | `capture.spec.ts` |
| AC.7 | Trajectory mechanics: waypoint endpoints hit, smootherstep bounded, import validation rejects malformed graphs, PRNG deterministic, one rescue per arc, quiet dwell honored, skip/release continuous without chemistry reset | `trajectory.test.ts`, `random.test.ts`, `curator.test.ts` |
| AC.8 | Stillness state machine: stillness holds collapse-end parameters; `kill-wait` (negligible chemistry ≥ 8 s, or 3× max-dwell timeout with exactly one diagnostic + one hard clear) → silence override from `kill-wait` entry → `black-hold` starts only when chemistry confirmed/cleared **and** `CuratorEnvironment.silence.satisfied`; with active audio this additionally requires instrumented terminal-zero master gain with non-null `terminalZeroAt`, while locked/muted/unavailable audio uses the satisfied/null bypass with the full 20-second hold intact → then ≥ 20 s at near-black luminance with exact-zero gain (active audio) → only then rebirth genesis. No genesis before hold completion on either path; ordering `chemistryConfirmedAt`/`audioZeroAt`/`blackHoldStartedAt`/`genesisAt` asserted | `curator.test.ts` (state-machine timing on both paths, one named case per bypass state — locked/muted/unavailable — and a repeated two-arc re-arm case) + `browser/stillness-hold.spec.ts` (active audio: final-frame luminance + instrumented master gain + ordering) |
| AC.9 | Long-form: ≥ 3 complete arcs recorded with different seeds (evidence owned by the `Phase2ArcReview` operator gate); fixed-seed replay on the same GPU reproduces identical config/command sequence and descriptor checkpoints within tolerance | `Phase2ArcReview` artifacts + `soak.spec.ts` (replay mode) |
| AC.10 | Analysis correctness: topology fixtures (empty, disk, two disks, ring, figure-eight, diagonal contact, edge-crossing, noisy pixels) yield expected counts/confidence; spectrum fixtures (constant → zero non-DC; known sinusoids in expected bands; translation-tolerant); merge/fragment/collapse event fixtures; stale/epoch-mismatched worker results rejected; hidden-periphery activity produces no strong presentation-facing event; tier-1/tier-2 channel separation verified on the real reduction shader path | `topology.test.ts`, `spectrum.test.ts`, `events.test.ts`, `worker-protocol.test.ts`, `browser/analysis-reduction.spec.ts` |
| AC.11 | Worker + readback lifecycle stays bounded: worker transferable ownership and queue bounds incl. all three `result` statuses (`ok`/`stale`/`error`) and combined-sample offsets (synthetic, GPU-free); actual PBO/fence ring balanced over many samples (syncs and buffers created = deleted, bounded slot count, `WAIT_FAILED`/timeout injection handled, context-loss cleanup) | `worker-protocol.test.ts` + `browser/readback-lifecycle.spec.ts` |
| AC.12 | Audio: `OfflineAudioContext` output finite, bounded voice count, fades reach digital zero after the silence deadline (terminal assignment verified), peaks ≤ −6 dBFS; hidden-periphery fixture causes no audible change | `audio-offline.spec.ts` |
| AC.13 | Browser behaviors: gesture-gated audio/fullscreen with truthful status, pause/resume without backlog, context loss + restoration via `WEBGL_lose_context`, capture fallback path, analysis backlog skipping | `browser/smoke.spec.ts`, `context-loss.spec.ts`, `capture.spec.ts` |
| AC.14 | Soak: two-hour unattended run passing the thresholds of its achieved tier — 60 fps tier: §11.1 default percentiles; 30 fps fallback tier: p50 ≤ 34 ms, p95 ≤ 40 ms, p99 ≤ 67 ms, ≥ 96 delivered simulation steps/s sustained, readback p95 ≤ 250 ms; both tiers: resource slopes ≈ 0, heap growth < 10% after warmup. If no supported tier passes its thresholds, the piece is not accepted and the shortfall is an operator decision — documentation alone never passes | `soak.spec.ts` report artifact (tier declared in report) |
| AC.15 | Presentation purity: default mode DOM contains no UI nodes; cursor hides after 3 s inactivity; laboratory fully hidden | `browser/smoke.spec.ts` (DOM inspection) + `FinalFullArcReview` |

Manual gates (operator is approver; recorded artifacts required):

- `Phase1MaterialGate` — **APPROVED by the operator, 2026-09-20** ("This is fine for now"). Operator caveat recorded: the lab makes it easy to end up with a blank screen through misconfiguration (e.g., non-viable F/k) — accepted for now; queued as a Phase-4 usability item (lab guardrails/feedback for non-viable parameters). Unblocks Phase-2 integration. **Addressed in deviation 59** (Round-A, Phase 4): the laboratory now warns live while the parameters are being chosen and offers one-click recovery plus an opt-in slider clamp.
- `Phase2ArcReview` — **APPROVED by the operator, 2026-09-20** ("Approve as mentioned"). Operator directive recorded: **the default 1× speed is still too slow for a showcase** — presentation default speed raised (see deviation 44); arc pacing remains adjustable via one config constant. Also approved with the risky-trajectory-endpoint tuning (deviation 45): the shipped trajectory's `cellular-growth`/`replication` endpoint k-values are lowered into the viable band. Unblocks Phase 3.
- `Phase3CausalityReview` — **APPROVED to proceed by the operator, 2026-09-21 (take 4)**, after two audio reworks (take 2: "kinda creepy" → take 3: "better but drone-like, marry it to a scale" → take 4: scale-married A-major pentatonic design approved). **Deferred:** the operator has not yet listened (no headphones available); the actual listening verdict folds into `FinalFullArcReview`. Machine evidence: 332→355 unit / 69→75 browser tests through the audio rounds; offline render matrix; exact-zero silence verified.
- `FinalFullArcReview` — operator approves the opening and one entire arc; no laboratory leakage; documentation complete per the Documentation Strategy.

## Test Strategy

Test infrastructure that must be **built as deliverables**, not assumed (the repo starts empty):

- Playwright browser fixture with GL telemetry: logs renderer string, `EXT_color_buffer_float`, limits; skips-with-diagnostic (never silently passes) when software rendering cannot exercise a GPU-dependent AC.
- GL readback/capture helper for deterministic screenshots and small-grid GPU-vs-CPU comparison.
- Synthetic worker harness: runs the analysis worker against scripted 256² RGBA8 fixtures without a GPU.
- Audio graph factory usable with both `AudioContext` and `OfflineAudioContext`; deterministic noise buffer generation.
- Soak metrics collector: bounded frame-time ring, resource counters (audio nodes, GL objects, listeners), heap samples, readback latency. A readback lifecycle harness for the real PBO/fence ring (instrumented sync/buffer creation-deletion, `WAIT_FAILED` and timeout injection, context-loss cleanup) — Phase 3 deliverable.

Named test files: `tests/clock.test.ts`, `random.test.ts`, `simulation.test.ts` (CPU reference solver + 10k-step smoke), `genesis.test.ts`, `trajectory.test.ts`, `curator.test.ts` (incl. stillness state-machine tests), `topology.test.ts`, `spectrum.test.ts`, `events.test.ts`, `worker-protocol.test.ts` (all three result statuses, combined-sample offsets, buffer identity return, termination/pool recreation, bounded slot reuse), `mapping.test.ts`; Playwright: `browser/smoke.spec.ts`, `browser/gpu-correctness.spec.ts`, `browser/capture.spec.ts`, `browser/context-loss.spec.ts` (`WEBGL_lose_context`), `browser/readback-lifecycle.spec.ts`, `browser/analysis-reduction.spec.ts` (real reduction/pack/readback shaders on deterministic center-only and hidden-periphery fields: expected channel values + material tier-1/tier-2 separation), `browser/stillness-hold.spec.ts` (accelerated hold: luminance + instrumented master gain + timestamp ordering), `browser/audio-offline.spec.ts` (OfflineAudioContext in-page), `browser/soak.spec.ts` (2 h, also supports accelerated replay mode).

Fixed-seed replay pass condition: identical recorded configuration and command sequence, and descriptor checkpoints (occupancy, β0/β1, band energies, activity) within stated tolerances on the same GPU/browser. Cross-GPU bit identity is explicitly not a criterion.

### Running verification and evidence

```bash
npm install            # once, then: npx playwright install chromium (only for the browser suite)
npm test               # Vitest: clock, PRNG, CPU reference solver, genesis, curator, analysis
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + Vite production build
npm run test:browser   # Playwright, headless on the real GPU (the default project)
```

The default browser suite runs every ungated spec, including the live Phase-2/Phase-3 loop (`phase2-live.spec.ts`, `phase2-integrity.spec.ts`), the presentation-tier reduction and readback lifecycle (`analysis-reduction.spec.ts`, `readback-lifecycle.spec.ts`), the laboratory composition checks (`lab-composition.spec.ts`) and exploration (`exploration.spec.ts`). Long-running evidence specs are **off by default** and gated by their own environment flag; each writes its raw evidence under `artifacts/` (exact counts and runtimes are deliberately not part of this contract):

| Gate | Spec | Writes |
|---|---|---|
| `CALIBRATE=1` | `calibrate.spec.ts` | calibration sweep printed to the run log (chosen values baked into `src/config.ts`) |
| `GROWTH=1` | `growth.spec.ts` | `artifacts/phase1-growth.json` |
| `PACING=1` | `pacing.spec.ts` | `artifacts/pacing.json` |
| `GATE=1` | `gate.spec.ts` | `artifacts/phase1-gate/` (written to a staging tree, published by one rename) |
| `GENESIS=1` | `genesis-sheet.spec.ts` | `artifacts/genesis-sheet/` |
| `REPLAY=1` | `replay.spec.ts` | `artifacts/replay/` |
| `ARCS=1` | `arcs.spec.ts` | `artifacts/arcs/` |
| `ARC_TUNED=1` | `arcs.spec.ts` | `artifacts/arcs/arc-tuned/` |
| `RESCUE=1` | `nucleation-rescue.spec.ts` | `artifacts/arcs/nucleation-rescue.json` (refreshes `artifacts/arcs/summary.json`) |
| `SOAK=1` | `soak.spec.ts` | `artifacts/soak/report.json` |
| `STILLNESS=1` | `stillness-hold.spec.ts` | none (long-form stillness reachability) |
| `npm run explore` | `src/lab/explorer.ts` + `scripts/explore.ts` | `artifacts/discovery/` |

Run a gated spec through its own script (`npm run test:gate`, `npm run test:replay`, …) or by name (`GROWTH=1 npx playwright test --project=headless-gpu growth.spec.ts`) rather than by grepping. **Every** Playwright invocation replaces `artifacts/playwright-report.json`, so that file always describes the most recent invocation, never necessarily the default suite.

The three browser harness projects are declared once in `playwright.config.ts` (`BROWSER_HARNESS`) and applied through `tests/support/browser.ts`, so no spec chooses its own launch arguments:

- **`headless-gpu` (default; `npm run test:browser`)** — `channel: 'chromium'`, headless, `--use-angle=vulkan`: the real GPU with no window and no focus stealing. Writes `artifacts/capability-report.md`.
- **`headed-offscreen` (opt-in; `npm run test:browser:headed-offscreen`)** — a real window at `-32000,-32000` for evidence that genuinely needs one; never started minimized (a minimized window throttles rAF). Writes `artifacts/capability-report-headed-offscreen.md`.
- **`software-check` (opt-in; `npx playwright test --project=software-check --grep AC.1`)** — forces a software rasteriser so the "report the renderer you actually got, never silently pass a GPU test" discipline is itself testable. Writes `artifacts/capability-report-software-check.md`.

Every capability report ends with a "Test harness" section recording the project, mode, launch arguments, the renderer actually reached, whether that run used a software rasteriser, and whether `EXT_color_buffer_float` was present; the default project writes `capability-report.md` while any other project writes `capability-report-<project>.md`, so a headed or software run cannot overwrite the blessed headless evidence.

## Review Strategy

- **Plan mode (this artifact):** before implementation handoff, run the `plan-reviewer` on this plan; fix or explicitly rebut every finding; if any MUST-FIX/high finding was returned, rerun the review after edits. Hand off only once no MUST-FIX/high finding remains (or the operator explicitly accepts a blocker). Status: round 1 (4 MUST-FIX / 5 SHOULD-FIX / 1 NOTE) — all addressed; round 2 (worker protocol, `WorldInput` completeness, two-tier representation, stillness failsafe, plan-mode loop, AC.11 harness, AC.14 thresholds, arc/reference cleanup) — all addressed; round 3 (combined-sample worker contract + status union, stillness/audio-zero ordering, GPU-layer reduction contract test; plus tier-terminology and AC.8/AC.9 naming) — all addressed; round 4 (single MUST-FIX: canonical audio→curator silence acknowledgement — `AudioSystem.prepareSilence()`/`silenceStatus()`, `CuratorEnvironment`, `PhaseState.stillnessState`, handshake in the update order) — addressed; round 5 (three localized contract contradictions in that handshake: `terminalZeroAt` clock domain unified to performance seconds, episode-scoped idempotence/re-arm across arcs, AC.8 aligned with the locked/muted/unavailable bypass rule plus two-arc re-arm test) — addressed in this revision.
- After each phase's automatable tests pass, a **general-purpose implementation-review subagent** reviews the diff and running evidence. Findings are classified critical / major / minor. **Critical and major findings must be fixed or explicitly rebutted with justification before proceeding; the loop repeats (fix → re-review) until no critical or major findings remain.** Minor findings are batched into the phase's tuning pass.
- The reviewer receives: the phase's AC table, test output, capability report, and captures. It verifies claims independently (runs tests, inspects code) rather than trusting the implementer's summary.
- Manual gates (`Phase1MaterialGate`, etc.) are never substituted by automated results; a passing test suite does not clear an operator gate.
- The same loop applies between phases: a phase is "done" only when no critical/major findings remain AND its operator gate (if any) is approved.

## Documentation Strategy

- `README.md` (the only doc beyond the plan) is deliberately **minimal**: **identity** (what the piece is), **run/activation** (`npm install`, `dev`/`build`/`preview`, the localhost URL, the click/Enter fullscreen gesture and silent watching), the **laboratory key and controls**, and **pointers** to `idea.md`, `architecture-plan.md`, and `artifacts/`. Everything operational lives in the plan: test/evidence commands in §Test Strategy ("Running verification and evidence"), capture/recording and trajectory import/export in §10, target GPU/browser and performance evidence in §11.1, and troubleshooting in §11.3. The previous README scope (validated target table, example trajectory, capture limitations, troubleshooting) is deliberately moved there rather than duplicated.
- `architecture-plan.md` is updated when implementation deviates from design (allowed, but must be recorded).
- Code carries targeted comments for non-obvious numerics (stability bounds, thresholds, packing scales); no separate design docs, no generated API docs.

## 13. Risks, Blockers, and Required Decisions

| Risk | Consequence | Mitigation and decision gate |
|---|---|---|
| Float render-target/platform behavior | Solver or HDR pipeline fails, or differs across drivers | Require and test EXT_color_buffer_float plus each FBO; manually sample float fields; log renderer details; validate actual hardware before substantial visual work. Do not silently downgrade to packed byte chemistry. |
| Audio/fullscreen activation restrictions | Apparently silent/nonfullscreen launch | One documented explicit gesture, independent audio/fullscreen status, silent operation allowed, bounded fade-in, no catch-up scheduling; test rejection and suspended contexts. |
| Numerical/shader artifacts or banding | Texture-demo appearance, unstable chemistry, bright rectangles | RG32F solver, bounded dt, CPU-reference checks, correct world-space normal scale, HDR intermediate formats, explicit gamma handling, zero-preserving post; Phase 1 human gate before scope expansion. |
| Curator stuck or paths do not yield intended morphology | Repetitive dead/overgrown arcs or scripted-looking rescues | Label initial values as candidates; source-state transition exploration across seeds; bounded feedback/dwell; one rescue per arc; declared collapse path and concealed reset only in darkness; operator approval of full arcs. |
| Analysis readback or worker stalls | Frame hitching and misleading late reactions | 256² at 2 Hz, PBO/fence ring, no blocking waits, bounded worker pipeline, timestamp/epoch validation, 1 Hz fallback, stale-data fallback to elapsed-time policy, profile rather than assume asynchronous readback is free. |
| Indefinite-lifetime resource growth | Autonomous multi-hour piece degrades: accumulating audio nodes, media tracks, object URLs, syncs, detached buffers, listeners, GL objects; GC pauses | Lifecycle ownership table per module; bounded counters exposed in Diagnostics; soak asserts ≈0 slopes (AC.14); teardown paths exercised by context-loss and lab open/close tests; any growth trend blocks phase acceptance. |
| Target-hardware availability or shortfall | Performance ACs unmeasurable or unreachable; material look misjudged on software GL | Target machine is the operator's Linux box; capability report (renderer string, driver, Chromium) required before Phase 1 acceptance; if 768²/120 steps unsustainable, apply documented degradation tiers and record achieved tier; GPU-dependent tests skip-with-diagnostic, never silently pass, under software GL. |

### Blockers and required decisions

- **B1 (operator-approved, resolved for handoff):** the operator's local Linux machine is the target hardware; the implementer must publish its capability report before Phase 1 acceptance. If it cannot sustain the default tier, the documented degradation order applies — no architecture change.
- **B2:** descriptor normalization ranges, material thresholds, and audio levels are calibration values set during discovery and confirmed at the operator gates — not architecture decisions.
- **B3:** no further operator decisions are required before Phase 1 acceptance; the Phase 1 image approval and final trajectory/pacing approval are the operator's gates.

## 14. Remaining uncertainties and handoff decisions

The architecture is implementable without further structural choices. The following are validation-dependent rather than unresolved architecture questions:

1. Actual GPU/browser capability and measured 768²/1080p performance.
2. Which precise F/k paths produce compelling transformations with the specified Laplacian, cell scale, seed, and substep rate.
3. Material/emission thresholds and descriptor normalization ranges that make this organism physically convincing and causally responsive.
4. Comfortable playback level, especially deep tones, on the operator's actual speakers.
5. Supported local recording codecs and useful capture duration on the deployment browser.

The implementer should surface these through capability reports, discovery exports, and explicit phase-review clips—not silently choose a more elaborate architecture or claim aesthetics are automatically tested. No caller approval is needed for the module layout or baseline algorithms; **operator approval of Phase 1 and the final trajectory/pacing is required**.

Every added effect must still answer the brief's final question: **What aspect of the mathematical system does this make perceptible?**

## Deviations

Recorded during Phase 1 implementation, as required by the plan's own rule that implementation
deviations must be recorded here. Each entry states what differs, why, and what it costs.

### Files added beyond §3.1

1. **`src/simulation/reference.ts`** — the CPU reference solver plus a shared `fieldStats`. AC.2 and
   AC.5 require a CPU reference, and §12.1 wants the 10,000-step smoke run on the CPU as well as the
   GPU. Keeping it in `src/` (rather than only in `tests/`) lets the browser spec, the vitest suite
   and the offline discovery tool compare against *one* definition instead of three copies. It
   mirrors `step.frag` operation-for-operation in float32 via `Math.fround`.
2. **`src/visual/shaders/surface.frag`** — §5.1's resource table lists a "surface field" pass
   (RGBA16F: height, boundary activity, support, spare) but §3.1's shader list omits its file.
   `field.frag` is left doing extraction only, per §5.1's note that the passes "may share shader code,
   but their responsibilities remain distinct".
3. **`scripts/tune.ts`** — Phase 1 needed the §6.5 *discovery* capability (offline sampling of
   parameter space with measured descriptors) before the §6.5 *tooling* (`scripts/explore.ts`, a
   Playwright-driven contact sheet, which is Phase 2). `scripts/tune.ts` runs the CPU reference over a
   grid of (F,k) candidates and prints occupancy/edge-density/activity; it is what selected and
   justified F = 0.029, k = 0.057. `explore.ts` remains a Phase 2 deliverable.
4. **`tests/support/*.ts`** and **`tests/browser/calibrate.spec.ts`** — the shared browser hook
   helper, the recorded tolerance constants, and the material calibration sweep. §Test Strategy
   requires the browser fixture with GL telemetry to be a deliverable; the calibration spec is the
   auditable form of B2's "material thresholds are calibration values set during discovery".

### Interface-level differences

5. **`Diagnostics` is a Phase-1 subset.** §3.3's shape includes `readbackLatencyMsP95` and
   `analysisBacklog`, which cannot exist before the Phase 3 readback ring. This implementation omits
   them and adds `softwareRenderer`, `simStepsPerSecond` and `deliveredFps`, which the capability
   report and the laboratory status line need now. `Diagnostics` stays laboratory-only and is never
   part of `WorldState`.
6. **`WorldState.material.exposure` and `.bloomGain` are load-bearing, and the live initial state
   must agree with them.** The composite pass reads them from the published snapshot (config only
   seeds the initial values), and — after the review correction below — the live initial
   `MaterialState` is in fact built from those same config constants. The history matters: the first
   calibration sweep exposed the fields as *dead* (the renderer read the config constants instead of
   the published state, so an exposure sweep had no effect), and after that was fixed the initial
   state still hard-coded `exposure: 1` while the config declaration said `1.5`, so every gate still
   and the clip were rendered at 1.0 while the gate metadata printed 1.5. Both halves are now fixed
   *and asserted*: `app.ts` initialises `exposure: COMPOSITE.exposure`, and the gate asserts that the
   exposure and bloom gain the composite actually applied (`Renderer.appliedToneState()`) equal the
   published material state and the configuration *before anything is published* — every gate output
   goes to a staging directory inside `artifacts/` and is published via the failure-safe two-rename
   swap of entry 28 (brief absence window; readers never see a mixed tree) after the last
   assertion passes (see deviation 28). Recorded here because
   it is exactly the class of contract drift the plan warns about, twice over.
7. **`FieldView.epoch` also bumps on a genesis `replace`** as §3.3 specifies; `Simulation.seed` in
   addition resets the delivered-step counter and numerical time for a replace, since a replace
   replaces the whole field. Injections do not.
8. **`benchmarkFrames` / `Renderer.syncPoint`** exist solely as a verification hook: they
   deliberately serialise the pipeline with a one-pixel readback so §11.1's frame budget can be
   measured at all. Ordinary rendering never reads back.

### Rendering and composition

9. **Bloom uses two upsample accumulation passes plus a passthrough seeding the coarsest level**,
   rather than three tent combinations. Resource-wise this still matches §5.1 (three downsample and
   three upsample targets); the coarsest level has no coarser source to combine with. Additive
   accumulation is done inside the shader (`fine + tent(coarse)`) instead of with blending, so the
   result is deterministic across drivers.
10. **The canvas backing store is capped at a 1920×1080-equivalent pixel count**, not only the
    internal HDR scene. §11.1 permits the canvas to match the screen while the scene is smaller; on a
    4K panel the extra canvas pixels would cost a composite that adds nothing, and capping keeps the
    composite 1:1 with the scene.
11. **The sheet is drawn without face culling.** It is a single layer, so culling can only remove
    surface that should be shaded; the silhouette moment in §9.2 is Phase 2's problem.
12. **`GenesisKind` patterns other than `single` throw at command conversion** rather than silently
    doing nothing. Phase 1 implements one genesis condition per §12.1; `competing`/`line`/`ring`/
    `sparse`/`radial`/`structured` are Phase 2 and fail loudly until then.
13. **Diagnostic overlay views are accepted and recorded but render nothing.** §10 lists
    reduced-field, label/hole, spectral and camera views; they all depend on the Phase 3 analysis
    tiers, so the command surface is implemented now and the overlays arrive with the analysis rather
    than being faked.

### Time, transport and dormancy

14. **The automatic genesis is a Phase 1 stand-in for the curator's dormancy movement.** §12.1 asks
    for "one strong genesis condition"; `app.ts` issues a single `replace` seed at the domain centre
    after four performance-seconds of dormancy. Phase 2's `dormancy` movement supersedes it, and the
    hook can disable it for deterministic verification.
15. **`Diagnostics.frameTimesMs` now records rAF intervals, not callback duration.** Surrounding the
    callback with `performance.now()` measures GL *command submission* (~0.2 ms) because WebGL
    submits asynchronously, which would have reported a 50 fps display as if each frame cost 0.2 ms.
    §11.1's percentiles are about delivered frame time, so the interval is the honest metric.
16. **Automatic seeding is triggered on `performanceSinceStart`, not on the raw frame count**, so a
    paused or throttled tab does not advance dormancy.
17. **`material.relief` default is 0.006**, inside §5.2's stated 0.001–0.008 bound (the plan says
    "starts at 0.004"). Calibration showed relief is the dominant lever on whether grazing light
    reveals structure at all: 0.004 leaves the brightest ridge at 65/255 and 0.006 at 247/255 without
    clipping. Roughness moved to the top of the .24–.36 band (0.36) for the same reason, light
    intensity to 30, and exposure to a fixed 1.5. All four are B2 calibration values, measured in
    `tests/browser/calibrate.spec.ts` and recorded with their live readback in
    `artifacts/phase1-gate/README-gate.md`. **Correction after review:** these values were declared
    but not actually in force for the first gate artifacts — the live initial `MaterialState` used
    `exposure: 1` while the config said 1.5 (see entry 6). They are now the values the renderer
    genuinely applies, and every gate capture records the live value the composite used.
18. **Environment finding, not a design change (B1/§11.1):** the target machine is an *integrated*
    Intel UHD (Raptor Lake-P) whose internal panel refreshes at 49.95 Hz, so the ordinary frame-rate
    measurement is refresh-capped near 50 fps and says nothing about GPU headroom. The drained-frame
    benchmark reports 9.9 ms/frame at 1920×1080 for the 768²/120-step workload against §11.1's
    16.7 ms budget, and the solver sustains 422–467 M cell-updates/s, so the default tier is met on
    this hardware; no degradation tier is required. Software rendering (SwiftShader) is reachable in
    headless Chromium and passes the correctness tests, and the suite reports it explicitly rather
    than treating it as the target.
19. **Playwright runs headless on the real GPU by default.** §Test Strategy requires a browser
    fixture with GL telemetry but does not specify a window mode; running headed would open a visible
    window and take foreground focus whenever tests run. The default project is therefore
    `headless-gpu` (`channel: 'chromium'`, `headless: true`, `--use-angle=vulkan`), which reaches the
    real Intel device through ANGLE's Vulkan backend with no window at all. This matters because the
    *headless shell* build has no GPU path on Linux and would have quietly substituted SwiftShader for
    the target GPU. A second, opt-in `headed-offscreen` project runs a real window positioned at
    -32000,-32000 for evidence that needs one (not `--start-minimized`, which throttles rAF and would
    invalidate timing assertions). Both modes are declared once in `playwright.config.ts` and consumed
    through `tests/support/browser.ts`; every capability report ends with a "Test harness" section
    recording the mode, the launch arguments, the renderer actually reached, and whether
    `EXT_color_buffer_float` was present, and the default run's report is written to
    `artifacts/capability-report.md` while other projects write `capability-report-<project>.md` so a
    headed run cannot overwrite the headless evidence. Both modes pass the entire suite, and the two
    ANGLE backends agree on every numerical assertion (GPU-vs-CPU agreement 2.4e-7 on each). A third
    opt-in project, `software-check` (`--use-angle=swiftshader`), forces a software rasteriser so the
    reporting discipline is itself verifiable: it declares `Software rasteriser: true`, still passes
    the correctness assertions with the same 2.4e-7 agreement, and its report lands in
    `artifacts/capability-report-software-check.md`, leaving the blessed `capability-report.md`
    untouched.

### Corrections made after the Phase 1 implementation review (fix-first round)

20. **Mandatory gate evidence is one genesis seed, not a lattice.** The first gate artifacts composed
    the mature and grazing captures (and the candidate sheet) from a uniform 4x4 lattice of identical
    seeds. Because the solver is translation-invariant on the torus, that composition stays *exactly*
    periodic, so those captures read as tiled wallpaper rather than one organism — defeating the
    question Phase 1 exists to answer, and §12.1's "one strong genesis condition". The mandatory
    captures are now one continuous run from a single §4.4-perturbed seed (600 / 16,000 / 16,000
    delivered steps of the same field), and the lattice survives only as a clearly labelled rejected
    control in `artifacts/phase1-gate/controls/`, captured with the same parameters and step count.
    The repetition is now *measured*: the symmetry score `1 - mean|V(p) - V(p+Δ)| / mean|V(p) - mean(V)|`
    at a quarter-domain period is **-0.238** for the mandatory capture and **+0.900** for the control
    (both fields verified alive at ~0.63 occupancy). `artifacts/phase1-growth.json` records the
    single-seed growth curve that chose the 16,000-step budget (occupancy reaches 99% of its plateau by
    then and is unchanged at 50,000 steps). **Caveat (round-3 review):** `+0.900` is a session-specific
    control measurement assembled while live stepping continued — after the clip the app unpauses and
    keeps stepping, and the 16 lattice commands are separate awaited hook calls, so later seeds inject
    into an already-evolving field; the control is therefore neither simultaneous nor exactly 16,000
    steps, which explains the 0.900/0.903/0.915 spread and the 1.0 measured in isolated exact-lattice
    probes. It does not invalidate the mandatory evidence (paused captures, byte-reproducible). On the
    next authorized gate run, pause before control/candidates and batch the commands synchronously.
21. **AC.5 clipping is measured, not inferred.** The 10,000-step GPU smoke previously reported only how
    many cells ended on a clamp bound, which cannot distinguish the untouched U≡1 void from a real
    pre-clamp excursion. `src/simulation/shaders/step-validate.frag` now evaluates the identical step
    expression without the clamp and accumulates *exact integer* counters into RGBA32UI targets
    (clipped U, clipped V, maximum excursion in 2^20 fixed point, significant-excursion cell-steps).
    The pass is submitted only when `Simulation.enableValidation(true)` is called, so the production
    chemistry path is unchanged, and RGBA32UI was added to the capability probe. The stable 10,000-step
    run reports clipping frequency 0 (bound 1e-3) *and* agrees exactly with the independent CPU
    instrument (0 and 0); a deliberately unstable fixture (`dt·Du = 0.3 > 0.25`, outside the §6.2
    envelope) reports 67,626 clipped U updates and a 0.272 excursion on the GPU and **the same 67,626
    and 0.272** from the CPU reference — so the instrumentation is both sensitive and not noisy.
22. **`ColorTarget` owns its depth renderbuffer, and every `gl.delete*` now decrements the tracker.**
    §5.1's scene target takes a DEPTH_COMPONENT24 renderbuffer, which was created and counted but never
    retained, so `deleteColorTarget` could not release it: every resize of the scene target leaked one
    renderbuffer and grew the laboratory count. `ColorTarget` now stores it, `deleteColorTarget`
    releases it, and incomplete construction releases everything it allocated — *and*, since the
    round-2 review, takes each count at ownership rather than on the success path, so those releases
    are balanced rather than leaving `framebuffers` at −1 (see entry 27). The same audit found
    three more ownership gaps of the same class (the fullscreen quad's VAO, the sheet VAO and its two
    buffers were deleted without decrementing), and `Program` now takes an optional tracker so the
    'programs' counter is meaningful instead of permanently zero. `tests/browser/gpu-correctness.spec.ts`
    verifies all of it: 200 resizes across four sizes leave every count at its baseline, 25 depth
    targets created and deleted return a fresh tracker to exactly zero, and a throwaway `App` that owns
    14 textures / 14 framebuffers / 1 renderbuffer / 10 programs / 3 VAOs / 2 buffers ends at exactly
    zero after `dispose()`.
23. **The WebM clip's duration and codec are verified from the file.** MediaRecorder writes no WebM
    `Duration` element, so every container tool reports `Duration: N/A` and a nominal 30 fps says
    nothing about the clip's real length. `tests/support/webm.ts` (no third-party dependency) parses the
    EBML structure — including the unknown-size Clusters a live MediaRecorder muxer emits — and derives
    the frame count, span, median frame interval and duration from the file's own block timestamps;
    ffmpeg corroborates the container view. The recorded clip is `V_VP9` 1280x720, 1801 frames,
    60.03 s, median interval 33 ms (max 40 ms), effective 30.00 fps. Both the parsed metadata and the
    ffmpeg line are written into `README-gate.md`.
24. **The Playwright harness no longer overrides `userAgent`.** The `devices['Desktop Chrome']` preset
    injects a Windows desktop UA string, which made the capability report claim "Windows NT 10.0"
    while the renderer was a Linux Mesa/ANGL driver — a report that describes a machine it did not run
    on. The preset is gone; only the viewport and device scale factor are pinned, so the capability
    report carries the browser's true identity (verified: `HeadlessChrome/153.0.0.0 ... X11; Linux
    x86_64`).
25. **Two more Phase-1-named specs.** `tests/browser/growth.spec.ts` (`GROWTH=1`) measures the
    single-seed growth curve that chose the mature step budget, and `tests/support/webm.ts` provides
    the clip verification of entry 23. Both exist to make a gate decision auditable rather than
    asserted.

### Corrections made after the round-2 review (three minor findings)

26. **Validation instrumentation is released on disable, not dereferenced.** `enableValidation(false)`
    used to null `validationProgram` and leave `validationTargets` allocated, so re-enabling orphaned
    the previous program and both counter targets: they stayed allocated and counted, and no later
    `dispose()` could reach them. `Simulation.disableValidation()` now disposes the program, deletes
    both RGBA32UI counter targets, drops the readback scratch and resets the index/step state — the
    single release path shared with `dispose()`. The resource-lifecycle spec now toggles the
    instrumentation six times on one throwaway simulation: each enable takes exactly +2 counter
    textures, +2 framebuffers and +1 program over the pre-validation baseline, every disable returns
    to that baseline exactly, the enabled counts are identical on every cycle (no accumulation), and
    the final `dispose()` reaches all-zero.
27. **Tracker counters are incremented at ownership, not at the end of the success path.**
    `createColorTarget` decremented `framebuffers` from `abandon()` but only incremented it after the
    completeness check, so a construction that failed completeness left the count at −1 (a later
    successful target then merely masked it). The framebuffer and depth-renderbuffer counters are now
    incremented as soon as each object exists, before the completeness check, so every decrement in
    `abandon()` is balanced. `tests/browser/gpu-correctness.spec.ts` forces the failure path — a
    zero-extent colour attachment with a depth renderbuffer (incomplete on every implementation) plus
    a non-colour-renderable packed internal format, which this driver also rejects — and asserts that
    every tracker field returns exactly to its starting value for both probes and that the probe's
    tracker ends at all-zero. Both probes fail on this machine (`INCOMPLETE_ATTACHMENT 0x8cd6`), so
    the failure path is exercised rather than assumed; the assertion on the counters holds whichever
    way a driver decides the format question.
28. **The gate publishes with a failure-safe two-rename swap, after its assertions.** The mandatory
    screenshots, the control and candidate captures, the clip and the metadata were written straight
    into `artifacts/phase1-gate/` *before* the provenance assertions ran, so a failing run could leave
    a partially updated, mixed-provenance tree behind — the claim in entry 6 that the exposure is
    asserted "before writing any metadata" was not true of the artifacts themselves. Every gate output
    now goes into a staging directory inside `artifacts/` (`tests/support/gate-publish.ts`) and the
    tree is published, as the last statement of the run, with a **failure-safe two-rename swap**: the
    previous tree is renamed aside to a backup, the staging tree is renamed into place, and the backup
    is deleted only after the swap succeeds. There is a brief window between the two renames in which
    the published path is absent, but a reader never sees a *mixed* tree — only the complete old tree
    or the complete new one — and a failed or aborted run restores the previous tree untouched. The
    `GATE=1` test is the only publisher of
    `phase1-gate/`; an ungated probe in the same spec runs the identical flow with a deliberately
    mismatched live composite exposure (the historical failure mode of entry 6/17) and asserts that
    the run fails at the provenance assertion, that its published directory does not exist, that no
    staging or backup directory is left in `artifacts/`, and that the operator's `phase1-gate/` tree
    is hash-identical afterwards. It publishes into its own probe directory, never `phase1-gate/`, so
    a regression cannot destroy approved evidence before the test reports it. `GATE_DIR` can override
    the published directory name, which is how an end-to-end rehearsal of the full flow was run
    (`GATE=1 GATE_DIR=phase1-gate-rehearsal`, short clip and few candidate steps) without touching the
    approved artifacts.

### Governance decisions after the Phase 1 review loop

29. **Phase-1 material gate kept OPEN; bounded image-independent Phase-2 logic proceeds (sequencing
    deviation, recorded 2026-09-20).** The operator was unavailable at the `Phase1MaterialGate`. An
    adversarial second-opinion review established: (a) no automated result may clear the gate per
    §Review Strategy, and generic image statistics cannot even distinguish the accepted capture from
    the rejected lattice control — the aesthetic judgment is genuinely unavailable to any agent; (b)
    full proceed is forbidden; (c) HOLD is wasteful because a bounded body of Phase-2 work is provably
    image-independent and would survive any material rework. **Decision:** build only pure, GPU-free,
    unit-testable Phase-2 modules behind stubs that throw if wired into the live path: deterministic
    PRNG, trajectory schema/validation/interpolation, curator bounded-graph + state-machine logic
    (incl. one-rescue, quiet dwell, skip/release, episode re-arm), long-form clock, stillness timing
    logic (AC.8's pure ordering assertions), and genesis *command* geometry as data. **Forbidden until
    the operator clears the gate:** wiring any of it into the live simulation/render; state-dependent
    lighting; camera integration; curator→GPU parameter coupling; the audio subsystem;
    `browser/stillness-hold.spec.ts`; any material/relief/light/bloom change; any gate-artifact
    regeneration. On operator return the gate is presented first; if the material is rejected,
    Phase-1-scope iteration happens and the Phase-2 logic remains intact. The implementer's Phase-1
    tuning list (second moving light, thickness-driven color absorption, interior darkening for
    volume, bloom gain toward its cap) is queued as the first Phase-1 revision awaiting the
    operator's review.
30. **Phase-2 logic built behind throwing stubs (entry 29); four files added beyond §3.1.**
    Entry 29 authorises pure, image-independent Phase-2 logic behind stubs that throw if wired into
    the live path; this adds exactly that and imports none of it into `src/app.ts`. Precisely: no
    `src/curator/*`, `src/core/longform.ts` or `src/simulation/genesis-geometry.ts` module is imported
    by `src/app.ts`. The only `src/core/random.ts` / `Rng` usage in `src/app.ts` (its line-18 import)
    is **pre-existing** §3.1 code that predates Work B and is unchanged by this work. (Superseded in
    part by entries 31/34: `src/core/longform.ts` is now imported by `src/app.ts` for the
    operator-requested pacing policies — a speed change, not a material/image change.) Files beyond
    §3.1: `src/core/longform.ts` (§4.1 speed clamp + arc-time derivation layered on the Phase-1
    `FixedStepClock`; §3.1 lists only `clock.ts`), `src/simulation/genesis-geometry.ts` (§4.4
    `GenesisKind` patterns as pure seed-geometry data; §3.1 lists only `genesis.ts`),
    `tests/longform.test.ts` and `tests/genesis-geometry.test.ts` (§3.1 names neither). `random.ts`,
    the three `curator/*` modules and `public/trajectories/default.json` are §3.1 files. Cost: two
    more source files and two test files to review. Note: the §4.2 diffusion bound
    `dt·max(Du,Dv) <= .25` is strictly implied by the §6.2 envelope (`Du,Dv <= .2`, `dt = 1`), so
    that validator branch is defensive-only and is covered by envelope-rejection tests rather than a
    direct violation, which cannot exist inside the envelope. Note: the §6.3 shipped rebirth base
    centres (`[0.5,0.5]` and `[0.61,0.43]`) are only ~0.1304 apart, so a ±0.004 coordinate jitter can
    shrink a realized rebirth below the required 0.12; the curator enforces the invariant by
    projecting the final centre back out along its own displacement direction (toroidal distance,
    §4.3). `public/trajectories/default.json`'s §6.3 base values are left untouched.
31. **Playback speed ceiling raised from 4x to 6x on measured headroom (operator pacing feedback,
    recorded 2026-09-20).** The operator reported the piece "moves too slowly even at 4× speed". §10
    originally bounded speed at 0.25–4 and §4.1 bounded the frame at eight steps, i.e. a hard ceiling of
    480 delivered steps/s at 60 fps. `tests/browser/pacing.spec.ts` (`PACING=1`, script `test:pacing`)
    now measures the drained 1080p frame cost at the production 768² grid for step bursts of
    0/8/16/24/32/48, each repeated and reduced by median, and writes `artifacts/pacing.json`
    (schemaVersion 2). The artifact keeps *policy* and *observation* apart: `policyFloors` (10.5 ms
    fixed + 0.50 ms/step) and `observed` (min/max over the runs in `history`, which records every run's
    timestamp, fitted fixed/per-step cost and per-burst medians). The floors are a documented **policy
    choice, not an observation**: the freshly observed maxima (7.08–7.44 ms fixed, 0.225–0.263 ms/step
    over the recorded runs, all derivable from `history`) plus an engineering margin for thermal/driver
    variance — +3 ms absolute on the fixed cost, 2× on the per-step cost, rounded — which is why they
    sit above every retained observation and the cap is stable at 12. An earlier session measured higher
    costs, but that data is an **unretained historical observation (session 2026-09-19, raw bursts not
    kept)**: it is consistent with the floors and is *not* their basis. Deriving the cap against the
    panel's 49.95 Hz frame period (20.02 ms, entry 18) with a 15% safety margin and those floors gives
    12 steps/frame, whose predicted total frame cost at the floors (16.5 ms) fits the panel period. The configured cap is therefore
    **12 steps/frame** and `SPEED_RANGE` becomes **0.25–6** (`TIME` in `src/config.ts`;
    `clampSpeed`/`SPEED_RANGE` in `src/core/longform.ts`; the laboratory speed slider reads the same
    constant). §4.1 semantics are unchanged: `dt` stays fixed, performance time is still derived from
    delivered steps, the debt bound is unchanged, and `dt` is never enlarged to catch up — so at high
    speed on a slower machine the delivered rate degrades gracefully below the request, which the
    laboratory now surfaces as "delivered vs desired steps/s" (`Diagnostics.desiredStepsPerSecond`) and
    in the tempo readout, which reports the *measured* delivered multiple instead of echoing the
    request — `sim tempo: 6.00× requested · 5.00× delivered (600 of 720 steps/s — cap binds)` when the
    cap binds, `sim tempo: 1.00× (120 of 120 steps/s)` when it does not, and a `measuring…` form before
    any delivery window has populated (`formatSimTempo`, `src/core/longform.ts`). Default speed remains
    1×, and arcs keep their intended real duration at 1× because performance time is still delivered
    steps / 120. **The ceiling
    is below the 24–32 steps/frame the request hoped for:** on this integrated GPU the frame's fixed
    cost is 9–10.5 ms of the 20 ms period, so 12 steps is the honest measured limit, not the hoped one.
    A pure budget guard (`maxStepsWithinBudget`/`budgetedSteps` in `src/core/longform.ts`) records the
    rule and is unit-tested; the 60 fps frame budget would allow only 7 steps, which is why the cap uses
    the frame period the display actually provides.
32. **Files added beyond §3.1 by the pacing/labelling iteration.** `src/core/regime.ts` (the pure
    `describeRegime(params)` §10 approximate-morphology descriptor — deliberately a core, DOM-free
    function so it is unit-testable), `tests/regime.test.ts`, and `tests/browser/pacing.spec.ts` (the
    `PACING=1` gated measurement spec; §3.1 names neither a regime module nor a pacing spec). It also
    adds one artifact, `artifacts/pacing.json` (the pacing calibration record, beside
    `phase1-performance.json`), and a `test:pacing` package script. `src/core/longform.ts`,
    `src/lab/lab.ts`, `src/lab/diagnostics.ts`, `src/lab/controls.ts`, `src/core/types.ts`,
    `src/config.ts` and `src/styles.css` are §3.1 files and were edited in place.
33. **The regime readout is a 2-D nearest-reference map, not a 1-D k−F ladder.** The first version of
    `src/core/regime.ts` (entry 32) classified `(F,k)` with a `k−F` gap ladder plus blanket feed
    cutoffs. That contradicts the established 2-D Gray–Scott maps (MROB xmorphia; the Frankfurt
    project): it called the classic maze `(.029,.057)` "worms", and its `F ≥ .042 → overgrowth` cutoff
    called the flower/coral region `(.0545,.062)` overgrowth — while our own candidate sheet
    (`artifacts/phase1-gate/candidates/coral-0.0545-0.062.png`) calls it coral. It is now a nearest
    reference lookup over a documented anchor table (`REGIME_ANCHORS`), plain Euclidean in `(F,k)`,
    with `MAX_ANCHOR_DISTANCE = 0.02` beyond which the result is explicitly `unmapped (nearest: …)`.
    Each anchor carries an explicit provenance class, and **an anchor must be a point that survived**.
    **`literature`** — maze `(.029,.057)`, solitons `(.030,.060)`, mitosis `(.028,.062)` (literature
    labels; kept because our own `k = .062` tune row is alive, occupancy 0.3612 at `F = .029`); our
    **`candidate`** contact sheet — coral `(.0545,.062)`, worms `(.030,.062)`, dense `(.022,.054)`;
    **`tune`** (`artifacts/phase1-tune.txt`, 160², 12 000 steps) — overgrowth `(.026,.045)`
    (occupied 1.000, edge 0.000, saturated) and dying `(.018,.062)` / `(.014,.045)` (occupied 0.000).
    **The textbook mitosis point `(.0367,.0649)` is deliberately NOT an anchor.** Our own production
    capture of it is black — `artifacts/phase1-gate/captures.json` records image max 0, mean 0 and
    `occupiedFraction` 0 — and `README-gate.md` states that it "did **not** survive on this solver";
    the candidate filename `mitosis-0.0367-0.0649.png` describes *intent*, not outcome. It is listed in
    `KNOWN_DEAD` instead, so it can never label a living region, and it classifies as nonviable.
    `tests/regime.test.ts` asserts both directions against the frozen gate evidence: every `candidate`
    anchor must have a recorded capture with **nonzero** occupancy (and classify as living), the
    mandatory captures must be alive, and the known-dead point must have a black capture and classify
    nonviable. The one non-anchor rule is the measured death boundary, whose bracket is `k = 0.062`
    alive (occupancy 0.3612 at `F = .029`) against `k = 0.0649` dead (every tabulated point, plus our production
    capture): `DEATH_K = 0.0635`, the midpoint of that bracket, rounded to four decimals. Cost: the
    labels remain *approximate* — the map is crowded (the mitosis/solitons/worms anchors sit within
    0.003 of each other), so ties resolve deterministically by table order and the readout prints the
    anchor it used together with its distance.
34. **Lab-only fast-exploration mode at 512² (operator pacing feedback, recorded 2026-09-20).** The
    operator's standing feedback is that the piece "moves too slowly even at 4×". Entry 31 raised the
    presentation ceiling to 6× from measurement, but the measured 768² cost puts the honest limit
    there (≈16.5 ms predicted at the cap against the panel's 20 ms period). §10's own answer is that
    "higher exploration speed belongs only to bounded exploration mode and is still limited by
    delivered numerical steps", so this adds exactly that: a **lab-only, default-off** toggle that
    switches the simulation to a **512²** grid. Measured with the same drained-frame method
    (`artifacts/pacing.json`'s `exploration` section): fixed 7.12–7.78 ms and **per-step
    0.0908–0.1199 ms** over the five retained runs, against 0.2249–0.2631 ms per step at 768²
    (1.9–2.9× cheaper; 512² has 0.444× the cells), and that grid's own conservative policy floors
    (11.0 ms + 0.22 ms/step, derived from those retained maxima as +3.22 ms and ×1.83 — the artifact's
    `derivation` recomputes both from `history`) give **24 steps/frame → a 12× ceiling at 60 fps**
    (6× at 768²), predicted 16.3 ms/frame. The retained 24-step medians are 10.59–11.59 ms of frame
    time against the panel's 20.02 ms period, so as on the presentation grid the cap is policy-driven
    rather than cost-driven. **Semantics:** off by default, and the
    presentation path is untouched — default-mode DOM and behaviour are identical to before (AC.15
    passes unchanged). The mode is an explicit lab toggle, so it does not silently persist: the grid
    only changes while the operator asks for it. **Both directions restart the organism**, and the lab
    says so ("toggling restarts the organism at 512² (and again at 768² when switched off)"): the grid
    changes how many chemical cells exist and seed radii are specified in cells (§4.2), so continuing a
    field across the change would mean something different rather than showing the same organism at
    another resolution. The switch replaces the `Simulation`, retargets the renderer's
    simulation-sized intermediates (`Renderer.setSimulationSize`), and rebuilds the clock with that
    resolution's cap and speed range (preserving the paused flag and clamping the speed); the epoch is
    raised so cache consumers see a fresh field, and camera/light are left alone because the domain
    stays 2 world units wide. The laboratory displays the active grid, warns that "512²: fewer, larger
    cells; calibration differs from the 768² presentation", and labels the mode "for finding regimes,
    not for viewing the final piece". Cost: a switch disposes and re-creates a `Simulation` plus the
    renderer's five simulation-sized targets, so it is a visible hitch and a chemistry restart —
    acceptable for a lab action, and better than silently switching mid-arc. The presentation
    `SPEED_RANGE` is unchanged; the exploration range lives in `EXPLORATION` and is reached only
    through the active-resolution policy (`speedPolicyForResolution`), so no presentation path can
    inherit the higher ceiling by accident.

### Corrections made after the Phase-2 integration review (findings MAJOR 1-7, MINOR A/B)

35. **The tier-1 analyzer/readback shape, made exact.** The analyzer keeps the §7.1 three-slot
    pixel-pack-buffer ring, but the reduction chain and the slot layout changed: `reduce-coarse.frag`
    now writes **raw, unclamped** float block means into an RGBA32F coarse target (RGBA16F fallback,
    chosen by a one-time renderability probe); a new `reduce-presentation.frag` packs that into the
    16×16 **RGBA8** framing map (scaled + clamped once, with a saturation flag in alpha); and
    `reduce-health.frag` takes the **exact float mean** of the coarse grid into a 1×1 **float** record
    read back as floats. The health value therefore never passes through an 8-bit stage, so the
    mean-of-means is exact and an above-scale local flux can no longer be clipped before it reaches the
    global mean. A slot is `[0, 1024) presentation RGBA8 (16×16) ‖ [1024, 1024+healthBytes) health
    (1×1)`: **1040 bytes** on the RGBA32F path (16 B/texel) and **1032 bytes** on the RGBA16F fallback
    (8 B/texel), with `HEALTH_OFFSET` a **fixed 1024 in both** (still 256-byte aligned). The two slot
    sizes are the deliberate consequence of a byte-exact readback of whichever float format the
    one-time renderability probe selected, rather than a padded fixed-size transport contract
    (reviewer MINOR 4): `analyzer.ts` derives both from `analysisSlotLayout(bytesPerTexel)`, and
    `tests/analyzer-layout.test.ts` pins the fallback layout — forcing the probe to reject RGBA32F
    yields `floatFormat === 'RGBA16F'`, slot 1032 / offset 1024 — and the decoded half-float health
    record. (The slot was a flat 1028 bytes before this change.) The
    16×16 coarse framing map stays RGBA8 and is documented approximate (deviation 36). `SampleStamp`
    (§3.3) was added to `core/types.ts` — it was missing — and is carried in full (epoch, step,
    simulationTime, performanceSeconds, parameters) through each slot. `Analyzer.reset(epoch)` deletes
    pending fences, frees the slots and moves the accepted epoch; `poll()` discards a completed sample
    whose epoch is not current (app-level `pollAnalysis` also re-checks). A `null` `fenceSync()` is
    treated as a **dropped** request (slot recycled, `nullFenceDrops` counted, `request` returns false)
    rather than a success. `request` still takes `fieldWithPrevious()` (a `FieldView` pair) rather than
    the single `FieldView` of §3.3, because the change-rate channel needs the previous field, and the
    `parameters` argument is carried inside the stamp. Cost: two extra tiny passes (16×16 and 1×1) per
    sample, an extra float coarse target and one more program; the full-domain per-cell pass count is
    unchanged (one), and the extra targets are RGBA32F (16 B/texel at 16×16 = 4 KiB). The worker
    protocol of §3.3 remains Phase 3: there is no worker, so the "combined slot" is a main-thread PBO
    ring, not a transferred buffer.

36. **The coarse 16×16 camera signal is a provisional, presentation-only framing input.** §9.1 wants
    camera framing to follow the organism's coarse extent, and `analysis.presentation.centroidUV` /
    `boundsUV` are Phase 3 topology (they need the 256×256 presentation readback). The director derives
    a focus centroid and a bounded extent from the same 16×16 reduction at no extra readback cost. That
    grid is **RGBA8 and approximate**: per-texel flux/change above the .04/.02 packing scales are
    clamped (the saturation flag in alpha records when), and the focus/extent are quantized to a
    16-cell lattice. This is adequate for framing (the camera smooths over 45 s and clamps focus to the
    inner domain) but is **not** a descriptor: nothing analytic may read it. A seam-spanning organism's
    planar centroid is additionally untrustworthy on a torus; `coarseSeamAmbiguous` detects occupancy on
    both opposing edges and the camera then retains its previous focus (the §4.3 seam discipline applied
    to framing). When the Phase-3 presentation tier lands, the centroid/bounds should come from it and
    this signal should be retired.

37. **The director owns per-frame smoothing; the snapshot rate is not visible.** The renderer applies
    the published camera/light every frame without interpolating between 2 Hz snapshots, so the
    director smooths its own state in real time (first-order, §9.1's 30 s constant) and `app.ts` calls
    `derive` once per frame; the published `WorldState` carries the current targets. Consequently the
    director also owns the **time origin**: `reset()` clears `lastRealSeconds`/`lastPerformanceSeconds`
    so leaving and re-entering the automatic path cannot resume a stale target with an accumulated
    delta (the one-frame jump). Pins (`command`/`pinLight`/`pinMaterial`) route laboratory/hook
    overrides through the director so they survive `derive`; §10 camera commands and `setLight`/
    `setMaterial` now go through it and the app synchronizes its live fields from the director targets
    so the Phase-1 manual path (which does not `derive`) also sees them. `material` stays otherwise
    undriven. The black-hold light fade is paced by **performance** time (§8.3) so the fade completes
    inside the 20 s hold at any playback speed.

38. **§9.2's rare horizon remains deferred and is recorded as a director decision, not faked.**
    Horizon eligibility needs a persistent high-confidence connection event and sustained coherent
    structure, both of which are presentation-tier (Phase 3) signals. With that tier invalid the
    director never attempts a horizon moment; it says so in the code rather than guessing from
    chemistry health. No `horizon` camera mode is produced by the live path in Phase 2.

39. **§12.2 bootstrap fallback: the app starts on the bundled document and the fetch never gates
    startup.** `app.ts` constructs its curator from the bundled `public/trajectories/default.json` in
    the constructor, and `init()` now runs **synchronously to `start()`** — canvas sizing, input
    handlers, the verification hook and capability reporting are all installed and rAF begins before
    `fetch('trajectories/default.json')` is even issued. The fetch is then fired in the background
    (`void this.bootstrapTrajectory()`, MAJOR 1), so a slow or **hanging** response can no longer leave
    the artwork black and unstarted; previously `init()` awaited it, so the fallback only worked on an
    explicit rejection. A successful fetch replaces the document live via the §6.4 `load-trajectory`
    crossfade (source `bundled` → `fetched`) **without touching the field or the epoch**; a failure is
    surfaced in the laboratory rather than swallowed. A completion that lands after
    `dispose()` is dropped, so there are no post-teardown writes. `trajectoryInfo()` reports the
    provenance (`bundled` | `fetched` | `imported`) and the movement ids.

    **Round-3 refinement (reviewer finding A).** The first revision stored `trajectoryError` but only
    the console and the test hook could see it — the laboratory snapshot carried no trajectory fields,
    so "surfaced in the laboratory" was not true of the panel. `LabSnapshot` now carries a `trajectory`
    record (`source`, `error`, `id`, `movements`), `labApi().snapshot()` populates it, and the lab's
    composition section renders it (`.lab-trajectory`, plus a `trajectory` line in the status readout)
    while the panel is open — presentation purity is untouched because the whole host is still created
    only on open and removed on close. The bundled-then-fetched path is pinned by
    `tests/browser/lab-composition.spec.ts`: with `trajectories/default.json` routed to fail the panel
    shows `trajectory bundled — trajectory fetch failed …` and the snapshot carries a non-null error
    with source `bundled`; a successful bootstrap leaves the error null and shows `fetched`.
    `tests/browser/phase2-integrity.spec.ts` pins the guarantee: a **never-settling**
    `trajectories/default.json` still installs the hook and advances the clock/frames with
    `source === 'bundled'`, and fulfilling it later flips the source to `fetched` with no epoch bump.

40. **The Phase-2 silence interface is a satisfied bypass.** With no `AudioSystem` until Phase 3, the
    app passes `{ silence: { satisfied: true, terminalZeroAt: null } }` as `CuratorEnvironment`, which
    §3.3 explicitly says is the locked/unavailable-audio case. The stillness gate therefore proceeds on
    chemistry confirmation alone and records no terminal-zero timestamp. This is the whole of the
    Phase-2 silence interface; `prepareSilence()`/`silenceStatus()` and active-audio instrumentation are
    Phase 3. `tests/browser/stillness-hold.spec.ts` (gated `STILLNESS=1`) exercises the integrated
    kill-wait → black-hold → rebirth path, asserting a ≥20 performance-second near-black hold with no
    audio present. Cost: the integrated test cannot distinguish "audio silent" from "audio absent", which
    is exactly why full active-audio instrumentation stays Phase 3.

41. **Supersedes deviation 12: every `GenesisKind` is live, and `strength` is now a single global mask
    multiplier.** Deviation 12 recorded that patterns other than `single` threw at command conversion;
    all seven are now implemented (`SUPPORTED_PATTERNS`), and `genesis-geometry.ts` supplies their
    geometry. The command `strength` (§3.3) is applied **once, last**, as a global multiplier on the
    assembled mask for every kind (`uStrength` in `genesis.frag`; `GenesisUniforms.strength` in the CPU
    mirror), instead of being folded into some per-pattern terms. Previously `radial` scaled only its
    halo and `structured` only its sinusoid, leaving the viable core at full strength, so a curator
    hard-clear (`replace`, `strength: 0`) on a radial/structured document seeded a living core rather
    than an inert field. With the global multiplier, `strength: 0` is exactly `(1, 0)` everywhere for
    every kind and `strength: 0` inject is a no-op; `single`'s Phase-1 semantics at `strength: 1` are
    unchanged (the mask is `1.0 * 1.0 * 1.0`), which the genesis unit tests assert and the gate
    rehearsal re-confirms by hash.

42. **Restart and resolution switch start a fresh composition arc; bootstrap/import do not.**
    `restart(seed)` constructs a **new** `Curator` from the active document with the (possibly new)
    root seed and clears the phase/events/curator-parameters/health/coarse/cadence/genesis-log state —
    it no longer sends `load-trajectory` to the existing curator (which preserved its RNG, arc, rescue
    budget, origin and timeline). `applyResolution` (the §10 exploration toggle) does the same and, as
    §10 says the switch "restarts the organism", rebuilds the curator from the **retained** root seed
    (a grid change is not a new performance), so 768→512→768 is an identical, coherent restart. Import
    and the §12.2 bootstrap fetch still use the §6.4 `load-trajectory` crossfade, because they change
    the composition without replacing the field.

    Both restart paths (MAJOR 2) also re-arm the **director** explicitly, via
    `VisualDirector.restartPerformance(seed, arc)`, instead of relying on `derive`'s `arc !== arcSeen`
    guard: `restart()` and the resolution switch both return to arc 0, which the previous performance
    has almost always already visited, so the guard treats it as already-seen and the new performance
    would inherit the *old* seed's bounded light-azimuth target and visual state. The operation clears
    the director's real/performance **time origins** (the clock restarts, so the next `derive` sees
    `dt = 0` and cannot take a one-frame jump from an accumulated delta), forces the retarget to the
    **new** seed's bounded azimuth target, and — the documented choice between the two the review
    allowed — **preserves** the current camera/light/material values as transition origins rather than
    snapping them to the calibrated defaults, because the renderer consumes them live and a restart
    must not produce a visible jump; pins are left untouched. `applyResolution` passes the **retained**
    root seed with arc 0, so a resolution switch re-arms with the same operation and the same seed.
    Coverage: `tests/director.test.ts` (settling arc 0 under seed A then restarting into seed B adopts
    a clean seed-B arc-0 target, not A's; the time origin is cleared) and
    `tests/browser/phase2-integrity.spec.ts` (restarts into the same seed after different prior seeds,
    and across the 512↔768 switch, yield the same light-target sequence).

    **Round-3 refinement (reviewer finding B): the manual-mode camera release target.** `command(null)`
    only clears `cameraPinned`. With automatic composition ON the director's next `derive` resumes
    driving the camera smoothly from wherever the pin left it — the intended smooth-resume semantics —
    but with composition OFF *nothing* runs `derive`, so unpinning alone left `this.camera` at the last
    override **indefinitely**. A laboratory grazing view would then be inherited by the gate's
    real-time clip, the control/candidate stills and the next regeneration. Releasing the camera while
    automatic composition is OFF now restores the **calibrated Phase-1 camera** explicitly, through the
    camera-only `VisualDirector.resetCamera()` (mode `overhead`, the calibrated 84° elevation and the
    calibrated domain-fit distance); light and material handling are unchanged (the full Phase-1
    restore remains `reset()`), and a composition-ON release keeps the smooth-resume behaviour.
    Coverage: `tests/director.test.ts` (a grazing pin, then `resetCamera()`, returns the calibrated
    overhead camera and clears the pin) and `tests/browser/lab-composition.spec.ts` (composition off →
    default capture → grazing override → release → the published camera is back to the calibrated
    overhead mode, elevation and distance). The manual release is a *release* target, not a restart
    re-arm: it deliberately does not touch the director's arc/seed state or its time origins. A gate
    rehearsal (scratch `GATE_DIR`, short clip) confirmed the fix is invisible to the approved evidence:
    the three mandatory PNGs are byte-identical (SHA-256) to `artifacts/phase1-gate/` — they are
    captured *before* the release — while the lattice control and six of the seven candidate stills,
    captured *after* it, now differ (the seventh, `mitosis`, is unchanged because that field dies on
    this solver and renders black from any camera).

43. **Analysis and publication cadence is scheduled on delivered performance time (2 Hz) with an
    explicit 4 Hz real-time ceiling.** Both accumulators advance by the frame's delivered performance
    delta (`steps / nominalStepsPerSecond`) and fire when they reach `1/CADENCE.performanceHz`, but only
    once at least `1/CADENCE.realCeilingHz` of real time has passed, so acceleration cannot multiply the
    observed request/publication rate (at 6× the uncapped schedule would be 12 Hz real; the cap binds at
    4 Hz real). A skipped analysis request stays skipped. The curator's freshness is measured against the
    **current** performance time at consumption (`analysisStateAt`), not frozen at the last publication,
    so a sample cannot appear fresh for longer than it is. Cost: at high speed fewer samples reach the
    curator per performance second, which is the intended trade (a sample takes several real seconds to
    return, so requesting three times as many per real second buys nothing).

44. **The presentation default playback speed is raised from 1× to 3× (operator `Phase2ArcReview`
    directive, 2026-09-20).** The operator found the 1× default too slow for a showcase, so
    `TIME.defaultSpeed = 3` now seeds the presentation `FixedStepClock` (`app.ts` passes it at
    construction). The full **0.25–6×** range and the laboratory slider are unchanged, 1× remains
    selectable in the lab, and a resolution switch still **preserves** the live speed (clamped to the
    active grid's range) rather than resetting it. A nominal **980-performance-second** first arc
    (§6.3) therefore plays in **≈5.4 real minutes** (980 ÷ 3) instead of ≈16.3 — this **consciously
    overrides the brief's 10–30 minute real-time guideline** for showcase pacing, at the operator's
    explicit direction; the arc is still adjustable through the one `TIME.defaultSpeed` constant and
    the lab slider. **Performance-time semantics are unchanged**: dwell, trajectory progress, the
    stillness state machine and the analysis cadence all run in performance time, so the piece behaves
    identically — only *how many real seconds deliver a performance second* changes. Cadence
    (deviation 43): the 2 Hz **performance** schedule would ask for 6 Hz of real sampling at 3×, above
    the **4 Hz real ceiling**, so the ceiling binds and a tier-1 sample is delivered every 1/4 real
    second = **0.75 performance seconds** — half the curator's **1.5 performance-second freshness
    window** (`CURATOR_DEFAULTS.freshAnalysisSeconds`), so analysis-driven feedback (extinction
    detection, exit hints, progress scaling) **stays live** at the default (`tests/cadence.test.ts`
    asserts the identity, models the gate, and shows the 6× ceiling sits exactly on the window). The
    one test that assumed the old default is updated:
    `tests/browser/exploration.spec.ts` now expects `TIME.defaultSpeed` (not 1) on the
    rejected-command path. A **fresh complete arc** recorded at this default
    (`artifacts/arcs/arc-tuned/`, `ARC_TUNED=1`) plays the ≈980-performance-second first arc in a
    measured **320 real seconds** (≈5.3 min) at the 768² presentation grid, which is the pacing the
    operator actually sees.

45. **The shipped trajectory's cellular-growth / replication / connection-start `k` band is retuned
    inside the measured viable region (operator `Phase2ArcReview` directive); `stillness`'s lethal
    collapse-end `k` is deliberately left alone.** `public/trajectories/default.json` previously ramped
    the two "must stay alive" movements to `k = .064` (`cellular-growth`) and `k = .0649`
    (`replication`), at or above the measured death boundary (`DEATH_K = .0635`, the midpoint of the
    tune bracket `k = .062` alive / `k = .0649` dead; `artifacts/phase1-tune.txt` shows the
    `F ≈ .029–.030` rows with `k = .062` alive — occupancy 0.361 / 0.349 — and `k = .0649` dead —
    occupancy 0). The whole junction is moved into the viable band, **preserving the artistic shape**
    (a single rising `k` ramp whose peak lands at the *replicating* moment) and the §6.2 envelope and
    strictly-ascending waypoints:

    | movement | old `(F, k)` path | new `(F, k)` path |
    |---|---|---|
    | `cellular-growth` | `(.030, .062) → (.035, .064)` | `(.030, **.0600**) → (.035, **.0608**)` |
    | `replication` | `(.035, .064) → (.0367, .0649)` | `(.035, **.0608**) → (.0367, **.0610**)` |
    | `connection` (start only) | `(.0367, .0649) → (.030, .057)` | `(.0367, **.0610**) → (.030, .057)` |

    Choices, with the evidence behind each: the `k` **peak is placed at the replication endpoint**
    (`.0610`, the top of the directed `.0600–.0610` band) because the exit hint there is
    *replicating* and the tune evidence shows higher `k` at fixed `F` yields the sparse, spot-like
    ("separated") morphology — the original intent — while `.0610` sits `.0025` below `DEATH_K` and
    `.001` below the highest proven-alive sampled point (`.062`) for clear margin. `cellular-growth`
    **rises** from `.0600` to `.0608` (the upper-middle of the directed `.0605–.0615` band, so the
    growth morphology stays separated, not saturated) — it starts **below** `nucleation`'s `.062` end
    because the directive requires both `k` ramps to keep rising ("still rising" / "keeping its ramp
    shape") and to be "distinct from nucleation's `.062`"; the curator's 15 s entry crossfade (§6.4)
    smooths the small `.062 → .0600` boundary step, exactly as it does for any skip. `connection`'s
    **start is lowered from `.0649` to `.0610`** so the boundary stays continuous with replication —
    leaving it would jump straight back into the measured dead zone at the replication→connection
    hand-off. `stillness`'s collapse-end `k = .075` is **untouched**: that one is intentionally lethal
    for the collapse→stillness movement, and the death boundary is only a problem for movements that
    must stay alive. Evidence regenerated with `npm run explore`: the affected edges are now viable in
    settled trials for **all three seeds** — `03-cellular-growth-to-replication` occupancy `0.035 →
    0.218` (the `11000011` seed previously read `0.000`, dead) and `04-replication-to-connection`
    occupancy `0.036 → 0.227` (previously dead for **every** seed) — while `02` (`0.019 → 0.153`) and
    `05` (unchanged) stay alive and `08-collapse-to-stillness` still reads `0.000`, which is the
    *intended* collapse. `tests/regime.test.ts`'s shipped-arc readout is updated so both retuned
    endpoints assert `nonviable === false`. A **fresh complete arc at the new default 3× speed**
    (`artifacts/arcs/arc-tuned/`, `ARC_TUNED=1`) confirms the retune behaviourally: it completes in
    320 real seconds and walks the whole first-arc path (dormancy → … → stillness → rebirth) with no
    non-finite cells and a 20.0-performance-second near-black hold. **Honest finding — the rescue
    still fires.** The directive expected that removing the dying endpoints would also remove the
    injection rescue; it does not: the tuned arc records exactly **one** rescue, during **nucleation**
    at 58.3 performance seconds (occupancy 3.2e-3, activity 7.7e-5, dead-duration accumulator 20.0 s),
    which is unchanged by the retune because the rescue is a property of the *initial nucleation
    field*, not of the retuned endpoints. **Investigating the nucleation movement's own parameters:
    they are not marginal.** `artifacts/phase1-tune.txt` shows both nucleation endpoints solidly alive
    (F = .026, k = .060 → occupancy 0.409; F = .030, k = .062 → occupancy 0.349) and discovery confirms
    `01-dormancy-to-nucleation` / `02-nucleation-to-cellular-growth` are alive and rising for all three
    seeds. The rescue fires because §6.4's extinction detector uses a **domain-scale** living occupancy
    threshold (0.02) while a freshly seeded radius-6 nucleation organism starts far below it and takes
    longer than the 20 s premature-extinction window to cross — i.e. the one-per-arc rescue at arc
    start is structural and plan-permitted, not a symptom of a marginal nucleation regime. No rescue
    fires on the later, previously-dying edges any more (discovery 03/04 are alive for all seeds).

### Phase 3 — presentation tier ("make the world listen to itself")

46. **Combined-sample layout reconciled to the §3.3 canonical offsets; tier-1 health stays float.**
    Deviation 35 recorded a Phase-2 slot of `16×16 RGBA8 ‖ 1×1 float` (1040/1032 bytes) because the
    presentation tier did not exist yet. With the 256² tier-2 map live the canonical §3.3/§7.1 offset is
    adopted: a slot is `presentation 256² RGBA8 (0 … 0x40000) ‖ health 1×1 float (0x40000) ‖ framing
    16×16 RGBA8 (0x40010)`. The **health record stays float** (RGBA32F on the ordinary path, RGBA16F on
    the fallback), not the §3.3/§7.1 wording's "RGBA8": an 8-bit health byte would quantize occupancy to
    1/255 ≈ 3.9e-3, destroying the measured nucleation-seed occupancy (3.2e-3, deviation 45) that the
    curator's extinction logic reads — i.e. it would regress tier-1 fidelity, which the Phase-3 brief
    forbids. 16 bytes are reserved for the health record so the framing offset is format-independent
    (`0x40010` in both formats) and the slot size is constant. `HEALTH_OFFSET = 0x40000`,
    `FRAMING_OFFSET = 0x40010`; the 16×16 framing map is retained (deviation 36's seam logic needs a
    per-edge occupancy grid the planar presentation tier cannot supply) rather than retired.
    `tests/analyzer-layout.test.ts` and `tests/worker-protocol.test.ts` pin the offsets and the slot
    size; `analyzer.ts` derives them from `analysisSlotLayout(bytesPerTexel)`. **Amendment (round-A
    review, MAJOR 1): the tier-2 pack's normalization is by the constant block texel count, not by the
    summed envelope weight.** `reduce-presentation.frag` divides its envelope-weighted block sums by
    `block.x * block.y`; dividing by the weight sum instead would cancel a near-constant attenuation
    (a block at ~constant weight `w < 1` would return the unattenuated mean), so dim chemistry in the
    §5.4 0.65–1.0 fade annulus would produce full-strength presentation signals. The weight-sum form is
    retained only as the zero test that explicitly suppresses a fully-hidden block to (0, 0, 0, 0).
    `tests/browser/analysis-reduction.spec.ts` pins the monotone radius attenuation and the annulus
    event suppression against the real reduction shader.

47. **§9.2's rare horizon is enabled (supersedes deviation 38).** Deviation 38 deferred the horizon
    because eligibility needs a persistent high-confidence connection event and sustained coherent
    structure — both presentation-tier signals that were invalid in Phase 2. That tier is live now, so
    the director implements the full eligibility rule (arc ≥ 1, ≥ 8 minutes of performance time in the
    arc, valid presentation analysis with `topologyConfidence` above the policy floor, sustained
    occupied/coherent structure for ≥ 90 s, a connection (merge) event within 120 s, and a seeded
    per-arc Bernoulli draw at p ≈ .35 from `performanceSeed ⊕ arc`) and the complete excursion
    cinematography (60–90 s descent to a 12–18° band, a 20–40 s hold, a 60–90 s return, essentially
    fixed yaw, an interior ridge focus from the presentation centroid, at most one per arc).
    `tests/director.test.ts` pins: no engagement before 8 minutes or without a connection event, exactly
    one moment for an eligible arc (driving the `horizon` camera mode and descending below 30°), and no
    engagement when the seeded draw exceeds the probability. The live arc is short enough that the
    horizon does not fire in `phase2-live` (logged there: `moments=0`), which is the intended rarity.

48. **§6.4 premature-extinction detector refined to "below threshold **and** not growing"; the tuned
    arc's spurious nucleation rescue is removed.** Deviation 45 recorded the honest finding that every
    arc still fired its one injection rescue during `nucleation`, because the domain-scale dead
    occupancy threshold (≈0.01–0.02) sits below where a fresh radius-6 seed starts and the seed needs
    longer than the 20 s window to cross it. The detector now samples full-domain occupancy into a
    bounded ≤ window history (at most one sample every 0.5 s) and treats a field as dead only when it is
    **both** below the dead thresholds **and** not rising (a positive occupancy slope, or clear relative
    growth, keeps it alive). The one-rescue budget and genuine extinction detection are unchanged. This
    is a bounded tier-1-side change only (curator safety logic); no other tier-1 behavior changes.
    `tests/curator.test.ts` adds a trend-extinction block: a rising seed-field below the thresholds is
    **not** rescued, while flat and decaying dead fields **are** rescued (with the decision telemetry's
    new `occupancyGrowing` flag recorded). That is what makes tuned arcs rescue-free; see the fresh
    `ARC_TUNED=1` arc run recorded with this round.

49. **Presentation-tier modules added beyond §3.1.** `src/analysis/worker.ts` (the Vite classic module
    worker), `src/analysis/worker-model.ts` (the pure, Node-testable request handler),
    `src/analysis/presentation-worker.ts` (the GPU-free client that owns the bounded slot pool and the
    worker lifecycle), `src/analysis/presentation.ts` (the engine that decodes the combined buffer and
    computes the §7.2/§7.3/§7.4 descriptors), `src/analysis/topology.ts`, `src/analysis/spectrum.ts`,
    `src/analysis/events.ts` (all pure/preallocated), `src/analysis/protocol.ts` (the message types),
    `src/analysis/float-format.ts` (the shared health-record decode), and the new shader
    `src/analysis/shaders/reduce-framing.frag` (the retired-in-plan 16×16 framing pack; the 256²
    envelope-weighted pack now lives in `reduce-presentation.frag`). All worker arrays (FFT buffers,
    label arrays, decode scratch, previous-sample V) are preallocated per engine; one request is in
    flight and buffer transfers are one-way-and-back (identity is *not* assumed — the client tracks the
    in-flight slot, because a transfer re-creates the ArrayBuffer and an identity lookup would strand a
    slot). **Amendment (round-A review, MINOR 6): the topology analyzer's per-sample scratch is now
    preallocated and reused too.** `TopologyAnalyzer` previously allocated its `Int32Array`/`Uint8Array`
    labels/areas and two keyed `Map`s on every `analyze` call; those are now instance fields reused
    across samples (the typed arrays are `fill`-reset and the maps `clear`ed, so a long-lived worker
    allocates nothing per sample). The only remaining per-sample objects are the three tiny
    `ThresholdCounts` records returned with the result. §7.2's edge density is reported as the mean
    central-difference V magnitude; the
    threshold-mask perimeter/area term is realized through the §7.3 topology proxies (component/hole
    geometry and the artifact penalty in `topologyConfidence`) rather than double-counted into the one
    published `edgeDensity` scalar.

50. **§9.1/§9.3 event-aware camera and light.** The director now consumes the presentation-tier event
    serial: a new merge arms a bounded decelerate/slight-tilt window, a new fragment/collapse arms a
    bounded widen window, framing prefers the presentation-tier centroid/bounds (falling back to the
    16×16 coarse map, and retaining the previous focus when `topologyConfidence` is low), and the first
    high-coherence connection of an arc applies one bounded (≤ 8°) oblique light-azimuth nudge toward
    the structure-tensor orientation, then the ordinary 25°/min rate-limited travel holds it. §5.4's
    fixed exposure/bloom and the material drift rule are untouched.

51. **`Diagnostics.analysisBacklog` added; the §10 diagnostic overlays are rendered.** Deviation 5
    deferred `analysisBacklog` to the Phase-3 readback ring; it is now published (0 or 1, never a
    queue). Deviation 13 accepted-and-recorded the `analysis`/`topology`/`spectrum`/`camera` diagnostic
    views but rendered nothing; the laboratory now renders the reduced-field, label/hole and spectral
    views (a lab-only canvas that is created with the panel and removed with it, so presentation purity
    is untouched): the reduced field comes from a throttled lab-only `readPresentationRGBA8` readback,
    the label/hole view runs the same `TopologyAnalyzer` on that field, and the spectral view shows the
    four normalized band energies. The `camera` view remains accepted-but-unrendered.

52. **Documentation policy narrowed: the root README is minimal and operational guidance lives in the plan (supersedes the Documentation Strategy's original README scope and the §12.4 README clause).** The README had grown into a second design document — phase status/worklog, test counts and harness rationale, evidence narratives, measurement tables, acceptance inventories and a "next phases" roadmap. It is reduced to identity, the run/activation procedure, the laboratory controls table, and pointers to `idea.md`/`architecture-plan.md`/`artifacts/`. The moved material now lives in the plan: a "Running verification and evidence" subsection (§Test Strategy) with the install/test/typecheck/build commands, the gated-spec env-flag→artifact mapping and the three harness projects; capture/recording limitations and trajectory import/export guidance in §10; the capability/performance evidence pointer with the "Phase-1 numbers are historical" caveat in §11.1; and a troubleshooting table in §11.3. Two generated/embedded pointers that named the README are retargeted: the capability-report line in `src/gpu/context.ts` now cites `artifacts/phase1-performance.json` (and the checked-in `artifacts/capability-report*.md` strings are patched to match), and the fatal-startup message in `src/main.ts` now cites §11.3 instead of "the README". No test, script or `src` assertion reads root-README content; `README-gate.md`, `discovery/README.json` and plan references are unaffected.

53. **Round-A analysis review (Phase 3) fixes: presentation-envelope normalization, artifact birth gating, and worker-recovery association.** Three correctness fixes to the tier-2 presentation path, each with a deterministic fixture, plus a stale-evidence correction. (a) **Envelope attenuation (MAJOR 1).** The tier-2 pack now divides its envelope-weighted block sums by the constant block texel count instead of the summed weight (see the amendment to deviation 46 and `reduce-presentation.frag`), so peripheral chemistry in the §5.4 0.65–1.0 fade annulus is genuinely attenuated rather than normalized back to full strength; `tests/browser/analysis-reduction.spec.ts` adds "identical raw chemistry is attenuated monotonically by the support envelope" (translated seeds at increasing radius, tier-1 invariant / tier-2 monotone, plus an annulus-only multi-sample suppression check). (b) **Artifact birth gating (MAJOR 2).** `TopologyAnalyzer` strips sub-`minComponentPixels` middle-threshold components before cross-sample tracking (a filtered 1-px artifact can no longer become a persistent component), and `EventRecognizer` gates `birth` on `topologyConfidence ≥ EVENTS.minTopologyConfidence`; new fixtures in `tests/topology.test.ts` and `tests/events.test.ts`. (c) **Worker-recovery association (MAJOR 3).** `PresentationWorker` stamps every wired worker with a generation, detaches old handlers before terminating, and accepts a reply only when generation + sequence + epoch + echoed stamp + returned buffer size match the tracked request (unsolicited/duplicate/mismatched replies and synchronous `postMessage` failures are quarantined as `ignored` without touching slot ownership); new fixtures in `tests/worker-protocol.test.ts`. (d) **Stale rescue evidence (MINOR 5).** The deviation-48 trend refinement makes the retuned presentation arc rescue-free, so `tests/browser/nucleation-rescue.spec.ts` (RESCUE=1) is repurposed to assert no spurious rescue while the tuned field rises and to preserve a deliberate dead fixture that still fires its one bounded rescue; the `arcs/arc-tuned/summary.json` narrative and the shared `ARCS_SUMMARY_NARRATIVE` are corrected to match their `rescueCount: 0` data. The three legacy 1× arcs are preserved, not re-run.

54. **Round-B (Phase 3) generative ambient audio.** The sound system of §8 was added with four modules
    under `src/audio/` and five new/extended test surfaces. Recorded here are the real choices that
    differ from a literal reading of §8.2.
    (a) **The master gain is the final gain before the destinations** (`mix bus → high-pass 25 Hz →
    compressor → master gain → mute gain → audio + MediaStream destinations`), superseding §8.2's
    `master → compressor` order. Offline measurement showed that a master gain *before* the compressor
    leaves a −94 dBFS residual (`≈2.1e-5`) for ~6 ms after the deadline, because Chromium's
    `DynamicsCompressorNode` has a look-ahead delay that smears the last pre-deadline samples past the
    `setValueAtTime(0, deadline)` assignment. §8.3's binding requirement is that "after which samples
    must be **digitally zero** in the offline test", so the master is moved last; the signal path and
    the safety compressor are otherwise identical, and `browser/audio-offline.spec.ts` now asserts
    `postDeadlinePeak === 0` exactly (measured 0 for the general gate and the stillness override).
    (b) **A dedicated `muteGain` after the master** keeps pause/hidden-tab/laboratory mute from fighting
    the §8.3 silence state machine over one `AudioParam`; `silenceStatus()` derives the locked/muted/
    unavailable bypass from explicit `unlocked/muted/paused` flags, not from the master value.
    (c) **`AudioEngine` is context-agnostic and timer-free; `AudioSystem` is the live driver.**
    §3.3's `AudioSystem` owns the `AudioContext`, the 50 ms `setInterval` scheduler and the lifecycle,
    while the §8.1 mappings, §8.2 graph and §8.3 state machine live in an engine that accepts any
    `BaseAudioContext` and is driven by explicit `tick(now)` calls. This is what the Test Strategy's
    "audio graph factory usable with both `AudioContext` and `OfflineAudioContext`" requires; the
    engine's `prepareSilence(now?)` also takes an optional time because an `OfflineAudioContext` never
    advances `currentTime` while the offline driver ticks.
    (d) **Granular layer is windowed `AudioBufferSourceNode` slices of one reusable 2 s noise buffer**
    through the shared high/band-pass → texture gain bus (0–3 grains/s, ≤12 live, 0.15–0.8 s), with a
    5 s dark decaying stereo convolver IR; no AudioWorklet and no per-cell oscillator (§8.2). One-shot
    sources are reaped **by time** in `reap(now)` rather than by `onended`, so the live-node bound is
    verifiable without rendering (the offline boundedness case asserts `created === stopped + live`
    over a 180 s synthetic run).
    (e) **Calibration defaults.** `src/config.ts` gains an `AUDIO` block: §8.2/§8.3 fix the graph, the
    38–82 Hz band, the just ratios `[1, 3/2, 2, 3]`, the granular bounds and the 8 s-off / 3 s-wake /
    8 s-fade silence policy; the descriptor reference scales, off/wake thresholds and level ceilings
    are calibration values for the Phase-4 tune. The six mappings are normalized so that tune is a
    scale change, not a redesign. *(Superseded in part by deviation 56: the generated-buffer seeds are
    now the §4.4 `sound` substream of the recorded root seed — the fixed `noiseSeed`/`irSeed` are
    fallbacks only — and `lookaheadMs` is now implemented by the granular scheduler.)*
    (f) **Activation / mute / recording surface.** `activate()` reports `audio: <status>` truthfully
    (suspended / unlocked / running / unavailable) instead of "none in Phase 1"; the hidden laboratory
    gains an `audio` section whose mute toggle finally wires the previously no-op `mute` command, plus
    a live status/silence readout; `startCanvasRecording` muxes the audio system's
    `MediaStreamAudioDestinationNode` tracks so a recording is A/V WebM. `browser/smoke.spec.ts` now
    asserts the pre-gesture `suspended` truth and the post-gesture status instead of "none in Phase 1".
    The Phase-1 gate artifact line "no audio system exists in Phase 1" is historical Phase-1 evidence
    and is left unchanged, as are `idea.md` and `artifacts/phase1-gate/`. Files added beyond §3.1:
    `src/audio/buffers.ts`, `src/audio/voices.ts`, `src/audio/audio.ts`, `src/audio/offline.ts` (the
    deterministic offline scenario driver; imported by the in-page verification hook and therefore
    present in the bundle, alongside the existing laboratory-only code).

55. **New Phase-3B tests.** `tests/mapping.test.ts` (unit, 18 cases: the six §8.1 mappings bounded and
    monotone where specified, plus the §8.2 scheduler/bound constants, the joint `deriveAudioControls`
    bundle over a synthetic arc and the invalid/dead-field boundaries); `tests/browser/audio-offline.spec.ts` (AC.12: finite output,
    `peak ≤ −6 dBFS`, voice bound ≤ 4, digital zero after the silence deadline, hidden-periphery field
    inaudible, event serial/refractory/obsolete skipping, no one-shot node accumulation, the stillness
    override reaching terminal zero, and the episode-scoped re-arm); `tests/browser/audio-lifecycle.spec.ts`
    (§2.3/§8.3: suspended-before-gesture, gesture unlock truthfully reported, pause/resume mute with no
    backlog, the mute command, and the recorder's audio track); and the upgraded
    `tests/browser/stillness-hold.spec.ts` (STILLNESS=1) which now drives the **real** `silenceStatus()`
    — unlock, `prepareSilence()` on `kill-wait` entry, a reached terminal zero, the curator's
    acknowledgement (`timeline.audioZeroAt` non-null and ≤ `blackHoldStartedAt`), the ≥ 20 performance-
    second hold at near-black luminance with the instrumented master gain at exact digital zero, and the
    post-rebirth re-arm (`satisfied` false again) — instead of the deviation-40 bypass. All new browser
    specs skip-with-diagnostic when no audio device can start; the offline suite is device-independent.
    **Amendment (round-B review, MAJOR 1–4 + MINOR 5).** `tests/audio.test.ts` (14 unit cases) plus
    `tests/support/fake-audio.ts` (a recording Web-Audio fake: scheduled `AudioParam` automation,
    one-shot `start()` times, and filter type/Q/frequency) add unit coverage for the five findings, and
    the two live/offline browser specs gain three cases (a `rootSeed`-keyed substream-determinism render,
    a restart that reseeds the §4.4 substream deterministically, and a restart during a `kill-wait` fade).
    Counts after the fixes: **290 unit (was 276) / 57 browser (was 54)** + the same **12 gated skips**.

56. **Round-B (Phase 3B) audio review fixes: a fresh-performance abort, activation from zero, the §4.4
    sound substream, the §8.2 lookahead scheduler, and the three-ratio event subgraph.** Five reviewer
    findings (MAJOR 1–4, MINOR 5) on the deviation-54 audio system, each fixed at the boundary the plan
    names and covered by tests. A later review then added two master-envelope fixes — the offline
    terminal-fade collapse and the restart hard cut — recorded as sub-items (g)/(h) below.
    `npx tsc --noEmit` is clean; `npm test` is 293/293; the default browser suite is 58 passed / 12
    gated skips; `STILLNESS=1` passes.
    (a) **MAJOR 1 — restart/resolution during a `kill-wait` fade no longer inherits the old terminal
    fade.** `AudioEngine.resetPerformance(now?, reseedTo?)` (surfaced as `AudioSystem.resetPerformance`)
    is an explicit fresh-performance/episode-abort at the audio boundary: it **synchronously cancels the
    stale master automation** (the abandoned `setValueAtTime(0, deadline)` can no longer silence the new
    performance), resets the stillness episode state and every counter (`phase`, `fadeDeadline`,
    `terminalZeroAt`, `armed`, quiet/wake seconds, `lastStillness`, event refractory/obsolete counters),
    drops the granular scheduling debt, and establishes the intended new master transition — a **de-click**
    (hold the computed live level, ramp to zero over `AUDIO.declickSeconds`, then the bounded fade up) for
    an audible graph, or a stay-silent anchor when locked (see (h)). `restart()` and `applyResolution()`
    call it (with the new/retained root seed) and synchronise the app-side edge (`lastStillnessState =
    'none'`), so the next `kill-wait` entry issues exactly one fresh `prepareSilence()`. **Decision:**
    a `load-trajectory` that replaces the document with a **different id** aborts too (the composition
    has been replaced); the silent bootstrap that fetches the **same** bundled document does **not**
    abort, so the intended same-document crossfade is undisturbed. `tests/audio.test.ts` covers the
    abort before the first tick and mid-fade (old deadline gone, `armed` false, fresh fade on the next
    episode), and `audio-lifecycle.spec.ts` restarts mid-fade and asserts the living field returns to a
    non-silent master.
    (b) **MAJOR 2 — activation fades from exactly zero and does not replay pre-activation events.** The
    graph's master now initialises at **0** (it was 0.9). The locked→running edge in `setUnlocked()` is a
    lifecycle transition: it baselines `lastEventSerial` to the latest **published** serial (a retained
    pre-activation event does not fire on the first tick), resets the scheduling time/debt, and — only
    if the state permits sound (not stillness-armed or already silent) — anchors the master at exact 0
    and ramps up over the bounded `AUDIO.activationFadeSeconds` = 4 s. A graph constructed already
    unlocked (the offline driver) is anchored at the live level, so no offline render is attenuated.
    Covered by `tests/audio.test.ts` (fade anchored at 0, retained serial silent, next serial fires once;
    a still-armed activation stays silent).
    (c) **MAJOR 3 — the audio material is the recorded `sound` substream.** New `src/audio/substream.ts`
    derives three seeds (`noise`, `ir`, `grains`) from `substream(rootSeed, SUBSTREAM_IDS.sound)`, so the
    noise buffer, the convolver IR and the grain scheduler are a pure function of the recorded root seed
    (§4.4). `AudioSystem({ rootSeed })` takes the app's root seed at construction and `restart()` /
    `applyResolution()` reseed it (`AudioGraph.reseedSound`, which rebuilds the buffer + IR and reseeds
    the grain RNG). **Click-free swap:** the abort **de-clicks the live master to zero first** (hold the
    computed live level, ramp to zero over `AUDIO.declickSeconds` — MAJOR 2, see (h)), and the buffer/IR
    swap is **deferred to that zero instant** (applied on the first tick at or after it, via `pendingReseed`)
    with the fade-up starting from zero — so the live buffer/IR swap is inaudible without an extra crossfade
    node; existing grain sources keep the buffer they started with and are reaped by time. `AUDIO.noiseSeed`
    / `irSeed` are retained only as fallbacks when no root seed is supplied. Covered by unit tests
    (deterministic seeds; identical noise/IR/grain material for the same root, different for another) and
    by a browser render that is identical for the same `rootSeed` (material checksum + grain count; the
    rendered peak agrees only to DSP precision) and different for another, plus a restart-determinism
    signature test.
    (d) **MAJOR 4 — `AUDIO.lookaheadMs` is implemented.** The engine keeps a granular scheduling cursor
    (`grainCursor`, the context time of the next due grain) and on each tick emits grains only while the
    cursor is inside the §8.2 window `[now, now + lookaheadMs]`, so a stalled or batched tick spreads its
    grains over 150 ms instead of stacking them at `now`. The cursor is resynced to `now` (dropping
    overdue debt rather than replaying it) on a material stall (`> AUDIO.stallSeconds`), on activation,
    and on transport resume — and it is pinned while silent/paused/muted so no debt accumulates. The
    ≤ 12 concurrent-grain cap is enforced on every spawn. Covered by unit tests (regular ticks never
    schedule beyond the horizon; a multi-second stall and a pause/resume release no batch and leave no
    debt; the cap holds).
    (e) **MINOR 5 — the event subgraph uses three resonances at f/2f/3f.** `spawnEvent` now iterates the
    explicit `AUDIO.eventRatios = [1, 2, 3]` (exported as `EVENT_RATIOS`) instead of all four drone
    `voiceRatios` (which produced f/1.5f/2f/3f), matching §8.2's "3 resonant band-pass filters"; each is
    a `bandpass` at Q = 8, summed 1/3. Covered by a unit test that counts exactly three band-passes at
    50/100/150 Hz for a 50 Hz fundamental.
    (f) **Offline measurements after the fixes** (`audio-offline.spec.ts`, all ≤ the −6 dBFS = 0.5012
    ceiling): active peak 0.3678 / rms 0.0978 / voices 3 / grains 9; quiet-fade peak 0.2496, fade start
    12 s, `silentAt` 20 s, `terminalZeroAt` 20 s (the true deadline, not the fade start — see (g)),
    fade-window peak 0.0980, post-deadline peak **exactly 0** over ≈ 576 k samples; hidden-periphery peak 0;
    event-refractory fired 2 / skipped 40; long-run created 460 = stopped 452 + live 8, `maxLiveNodes` 3,
    grains 191; the stillness override (issued at 2 s) `fadeStartedAt` 2 s, `silentAt` 10 s,
    `terminalZeroAt` 10 s, post-deadline peak 0, `satisfied` true; re-arm `satisfied` false; the `restart`
    scenario peak 0.3021, `maxInterSampleStep` 0.0081 (≪ the 0.02 continuity bound), phase `live`,
    `terminalZeroAt` null (the abandoned deadline never fires — see (h)); the substream render root 2024
    checksum 2.1941 vs root 2025 checksum 1.9071. `STILLNESS=1` (`stillness-hold.spec.ts`): `audioZeroAt`
    ≈ 18.2 performance s (a live-timing measurement), a 20.01 s black-hold at darkest composite max = 0 /
    mean 0.000 (the instrumented master gain is exactly 0), and the post-rebirth re-arm reads `satisfied`
    false.
    (g) **Offline terminal fade no longer collapses to an instant cut (later review MAJOR 1).** The graph
    inferred the scheduled master level from `AudioParam.value`, but that is the **intrinsic** value:
    scheduling (`setValueAtTime`/`linearRampToValueAtTime`/`setTargetAtTime`) never updates it. The offline
    driver queues every tick/fade against explicit future times **before** `startRendering()`, so the
    context clock has not advanced and `param.value` is stale (0); `beginTerminalFade` then took its
    immediate-zero branch and recorded `terminalZeroAt` at the fade *start* (56(f)'s `silentAt` 12 s / 2 s
    figures were fade starts; with `fadeSeconds` = 8 the deadline is 20 s / 10 s). The graph now maintains a
    plain-JS **master-envelope mirror** (`MasterSegment`: anchor level + linear/target legs sampled by
    `masterLevelAt(t)`), updated at every scheduling point; `beginTerminalFade` starts from
    `masterLevelAt(now)` (never `param.value`) and always schedules ramp → terminal `setValueAtTime(0,
    deadline)`, and `terminalZeroAt` is recorded only when the deadline is observed. The live path uses the
    same mirror, so both are identical. The recording fake is now faithful (scheduling leaves `value`
    untouched), so the collapse is unit-reproducible; `tests/audio.test.ts` adds a case and
    `audio-offline.spec.ts` asserts the exact figures above (no permissive windows).
    (h) **Restart/reseed de-clicks the live master instead of hard-cutting it (later review MAJOR 2).**
    `resetPerformance()` called `cancelMasterAutomation(at)`, an immediate `setValueAtTime(0, at)`
    regardless of the live level, then faded up — an instantaneous nonzero→zero discontinuity (a click;
    56(c)'s old "click-free" note protected only the IR/buffer swap, not this cut). `cancelMasterAutomation`
    now **holds** the computed live level, and the new `AudioGraph.declickMaster(now, declick, fade)` holds
    the live level, ramps to exactly zero over `AUDIO.declickSeconds` = 0.1 s, then ramps up to the live
    level over `AUDIO.activationFadeSeconds`. The §4.4 sound-substream swap is **deferred to the de-click's
    zero instant** (`pendingReseed`, applied on the first tick at/after it) so it happens while the master is
    at zero, and the abandoned terminal deadline is still cancelled outright so it can never fire. Unit
    tests assert the envelope is continuous across a restart from steady output and from mid-activation-fade
    (max 1 ms step ≪ 0.02, zero exactly at the de-click end, back to the live level) and that the reseed
    lands only once the master is at zero; the `restart` offline scenario renders a mid-fade restart and
    measures a bounded `maxInterSampleStep` = 0.0081 with a null `terminalZeroAt`; and the lifecycle fixture
    samples `masterGain` around the transition and asserts the restart held a nonzero live level
    (`masterHeldAtRestart` ≈ 0.073).

57. **Round-B (Phase 3B) live-path audibility: the drone was electrically present but acoustically
    silent, and the calibration was raised.** The operator reported "no audible sound at all" after
    activating. The offline suites were green (peak ≈ −8 dBFS with the synthetic `activePresentation()`
    fixture), so the fault was in the **live** path the offline driver never exercises: `offline.ts`
    builds the engine already-unlocked with a permanently-active presentation, so it never sees the
    activation edge, the dormant boot field, or the §8.3 gate closing over it. A destination-tapped
    `AnalyserNode` was added to measure the real output and the answer is **(d) genuinely inaudible
    calibration**, compounded by the correct dormancy silence — *not* (a) context/suspension, *not* a
    stuck master, and *not* a broken signal chain. The precise instrumented evidence:
    (a) **Not (a): the gesture and context work.** A real click on `#stage` (the handler is on the canvas
    itself — `canvas.addEventListener('click', …)`; there is no overlay or "watch silently" path that
    swallows it) put the context at `running`, `unlocked: true`; `activateEdge()` scheduled the 4 s
    `fadeMasterIn` on `audioCtx.currentTime`, and the tap reported the master reaching **0.9000**.
    (b) **Not (b): the master is never stuck at zero.** During the boot dormancy (the trajectory's
    30 performance-second `dormancy` movement, `intention: quiet`) the field is empty, so
    `deriveAudioControls` yields `intensity 0` and **every voice gain stays exactly 0** — the
    destination measured `rms 0.00000 / peak 0.00000` while the master sat at 0.9. That is a *source*
    silence, not a master fault. The §8.3 gate then correctly did its job: after 8 s below the off
    thresholds it began the terminal fade at ≈ 24 performance-s and reached digital zero at ≈ 51
    performance-s. The first sound therefore arrived only when the field crossed the §8.3 wake
    occupancy (0.03) at ≈ 96 performance-s (≈ 32 real s at the default 3×) — an operator who clicks and
    listens briefly hears **nothing at all**, which is what was reported.
    (c) **Not (c): the chain is wired.** Once grown, the tap measured real signal over a full arc
    (speed 6): peak 0.1276 → 0.3440, rms 0.0907 → 0.1466, with voice gains rising from `[0.059,0,0,0]`
    during the fragmented *replication* phase to `[0.074,0.052,0.041,0.030]` (all four §8.2 voices) at
    *overgrowth*. The single-voice early phase is the §8.1 fragmentation mapping doing its job (the
    live field genuinely reports `largestComponentFraction` ≈ 0.01–0.06 / `beta0Approx` ≈ 300–500 for
    the spotted pattern; the topology analyzer was verified correct — a single injected disk reads
    `β0 = 1`, `largestComponentFraction = 1`).
    (d) **The root cause (d).** Even at its loudest, the sounding fundamental sat at **41–53 Hz** — the
    bottom of §8.2's literal 38–82 Hz band, exactly where large-scale structure and low-band energy push
    it — with `voiceLevelMax` 0.085 (a single voice ≈ −21 dBFS) and a granular texture layer measuring
    0.0003–0.0077. Peak 0.34 (−9.4 dBFS) of composite energy almost entirely below ~150 Hz is below the
    reproduction floor of ordinary laptop speakers: the analyser proves signal, the ear hears nothing.
    **Fix — recalibration for audibility within §8's restraint** (`src/config.ts` `AUDIO`, deviation-54
    calibration amendment): the fundamental band moved **38–82 Hz → 55–110 Hz** (still a deep sub-bass
    fundamental; the 2f/3f partials now land at 110–330 Hz, which real speakers reproduce), the per-voice
    ceiling **0.085 → 0.2**, texture **0.06 → 0.15** and events **0.12 → 0.24** (events sit below the
    ≈ 2.35× lift because the three Q = 8 resonances spike on a rare excitation), and the overall-output
    trim `masterLevel` **0.9 → 0.75** to hold the louder drone under the −6 dBFS ceiling (there is no Web
    Audio compressor *makeup* to reduce, so `masterLevel` — the final post-compressor trim — is the
    headroom knob; 0.9 and even 0.82 sat within Chromium's run-to-run compressor/convolver variation of
    the ceiling, so 0.75 leaves ≈ 10% headroom). The `mapVoiceCount`/`mapFragmentation` §8.1 semantics
    are unchanged: the note is genuinely fragmented during the spotted phases and gains its upper voices
    as it coheres, which is what §8.1 asks for; only the band and the levels were miscalibrated.
    **Instrumentation added** (permanent, lazily created so playback/offline pay nothing):
    `AudioGraph.attachOutputAnalyser()` taps an `AnalyserNode` on `muteGain` — the final node before the
    audio destination (deviation 54a) — and `AudioGraph.outputMeasurement()` returns time-domain
    RMS/peak plus the full magnitude spectrum; `AudioGraph.gainSnapshot()` exposes every gain value for
    localising a chain. Surfaced as `AudioSystem.attachOutputAnalyser()/outputMeasurement()/gainSnapshot()`
    and the verification hooks `audioOutput()` / `audioGains()`.
    **New regression guard:** `tests/browser/audio-audible.spec.ts` (2 cases). It opens the artwork,
    unlocks with a real click, fast-forwards (speed 6) to a field above the §8.3 wake occupancy, and
    asserts the **destination tap** clears an audible floor (peak > 0.05, RMS > 0.01; settled
    peak > 0.10) **and** that the strongest FFT bin lies in the drone band 40–400 Hz above −70 dBFS —
    so "silent when it shouldn't be" can never pass again; the second case asserts the mute command
    drives the same tap to the floor, proving the measurement is the real signal. Measured live after the
    fix (settled, speed 6, grown field): **peak 0.2094 / RMS 0.1480 / dominant 70.3 Hz / strongest bin
    −27.1 dBFS** (rising: peak 0.0684). `tests/mapping.test.ts` carries the new band (55/110) and the
    boundary case was renamed; `browser/audio-offline.spec.ts`'s restart inter-sample-continuity bound
    was widened **0.02 → 0.05** because the raised band raises the carrier's own per-sample slew (the
    330 Hz third partial) — measured 0.0187–0.0204, i.e. right at the old bound — while 0.05 is still
    ~6× below the ≈ 0.3 step a genuine hard master cut makes.
    **Re-recorded offline measurements** (superseding the level figures in deviation 56(f)): `active`
    peak **0.4079** / rms **0.1375** / voices 3 / grains 12; `quiet-fade` peak **0.3570** (fade start 12 s,
    `silentAt`/`terminalZeroAt` 20 s, post-deadline peak exactly 0); `event-refractory` peak **0.4511**;
    `restart` peak **0.3910**, `maxInterSampleStep` **0.01870**, `terminalZeroAt` null; `stillness` peak
    **0.2319**; substream render root 2024 peak **0.4226**, checksum 2.1941 (unchanged — the material is
    the seed's, not a level). All are ≤ the −6 dBFS = 0.5012 ceiling with ≥ 10% headroom. `npx tsc
    --noEmit` clean; `npm test` **293/293**; the
    default browser suite **60 passed / 12 gated skips** (58 + the 2 new audibility cases); `STILLNESS=1`
    **61 passed / 11 gated skips** (`audioZeroAt` ≈ 17.8 performance-s, 20.01 s black-hold, re-arm
    `satisfied` false).

58. **Round-B (Phase 3B) audio character rework — "Sunlit Porcelain Garden".** Operator listening
    feedback on the deviation-57 system: *"feels kinda creepy — want it more relaxing or interesting;
    stays too quiet too long after the organism is first seen"*. The design of record is
    **`sound-design-spec.md`** (repo root, retained for the reviewer; on acceptance its decisions fold
    into this plan and the file may be removed). This entry **supersedes the §8.2 event subgraph and the
    timbral constants** of §8.2 and of deviation 57 — the *causal architecture*, the six mappings, the
    silence discipline (exact zero, terminal assignment, the stillness/kill-wait handshake), the
    ≤ 4-orchestra / one-noise / one-IR budget, the 50 ms tick / 150 ms lookahead, the recording
    destination, the mute path and the terminal-master position (deviation 54) are all **unchanged**.
    The historical evidence above stays as the record of what the previous palette did and why.
    **Sound changes.** Pad register raised **55–110 Hz → 110–165 Hz** (highest carrier 3·165 = 495 Hz);
    voice ratios **[1, 3/2, 2, 3] → [1, 2, 3, 5/2]** (root, octave, fifth above the octave, just major
    third above the octave); the three sine/triangle oscillators are replaced by four built-in
    `OscillatorNode`s driven by **`PeriodicWave`s** (voice 0 harmonics `[1, 0.28, 0.10]`, upper voices
    `[1, 0.10]`, all sine phase, `disableNormalization:true`, divided by the absolute harmonic sum);
    detune ceiling **18 → 3 cents** with fixed multipliers `[0, +1, −1, +0.5]` (root never detunes);
    base weights `[1, 0.48, 0.26, 0.22]` normalised by `max(1, √Σw²)`, with the just major third
    (voice 3) coloured by `smoothstep(0.25, 0.75, coherence)`; the pad level is a **living-field floor**
    `0.18 + 0.06·√intensity`, **exactly zero when support is absent**; per-voice low-pass
    `clamp(carrier·(3 + 2·intensity), 500, 2400)`, Q = 0.5. The **§8.2 event subgraph is replaced**: the
    three Q = 8 noise-burst band-passes become a **three-partial additive porcelain bloom** (temporary
    sine partials at `[1,2,3]×bellBaseHz`, `bellBaseHz = rootHz·(featureScaleNorm ≥ 0.5 ? 2 : 3)`,
    amplitudes `[0.72, 0.21, 0.07]`, 120 ms raised-cosine attack then exponential decay τ 0.85/0.55/0.35 s,
    100 ms bounded terminal fade from 3.3 s, stopped by 3.42 s, peak `0.065·clamp(0.4+strength, 0.4, 1)`,
    pitch sampled once from the **smoothed audible root**); serial skipping, the ≥ 15 s refractory and
    "at most one live event group, dropped not queued" are preserved. The **granular layer** becomes a
    soft shimmer: grains 0.65–1.2 s, full-**Hann** window (`setValueCurveAtTime`, peak 0.85, exact-zero
    endpoints), rate `1.4·fineDetail²·(1−fragmentation)`, spacing `(0.75 + 0.5·rng)/rate`, **≤ 4
    concurrent**, shared high-pass 700 / band-pass Q 0.65 centre 1100→2400 / low-pass 4200. The **IR**
    is a **2.4 s luminous** stereo response (`exp(−t/0.32)`, 10 ms onset, one-pole cutoff 5500→2200 Hz,
    final 100 ms to exact zero) replacing the 5 s dark tail, and wet gain is **0.07–0.11**.
    **New presence/reveal (§6).** A new bounded presentation descriptor **`supportFraction`** =
    `mean(smoothstep(SURFACE.supportVLow, SURFACE.supportVHigh, reducedV))` is computed in
    `presentation.ts` (raw, zero for an empty field) and propagated through the protocol/types/WorldState.
    The activity-only wake path and the `wakeOccupancy`/`wakeActivity`/`wakeSeconds` thresholds are
    **removed**: presence eligibility is false at startup/reset, true on a **confirmed** support crossing
    (two distinct fresh valid samples at/above **0.001** *and* ≥ 0.5 real seconds — repeated ticks on one
    snapshot do not count), held by hysteresis above **0.00025**, cleared immediately below it. Quiet
    dormancy now also requires support below support-off. On a confirmed crossing the engine cancels a
    **general** absence fade only (never a stillness/kill-wait fade, which stays protected) and performs
    one **unified 1.5 s linear reveal/activation** re-anchored from the mirrored master gain; from exact
    silence the root's pitch/filter/gain are prepared behind the zero master first (no second root
    envelope), while a live master raises the root to its floor through a dedicated 0.75 s envelope.
    Grains and blooms are suppressed during the reveal and whenever support is ineligible; the envelope
    mirror is used for **every** new master transition (never a scheduled `AudioParam.value`); the
    de-clicked restart/reseed is preserved.
    **Verification.** `npx tsc --noEmit` clean; `npm test` **320/320** (new
    `tests/presentation-support.test.ts` 5 cases; rewritten `tests/mapping.test.ts` and
    `tests/audio.test.ts`). The browser offline suite
    gains the §6 wake→reveal **output guard** (150–2000 Hz band RMS **−18.3 dBFS** ≥ −34, full-band RMS
    **−16.3 dBFS** ≥ −27, rendered samples), a **render matrix** (pad/texture/event-only via
    verification-only `muteBuses`, combined at 44.1/48 kHz seeds 11/22, single-voice, coherence sweep,
    sustained, collapse — all peaks **≤ 0.367** (−8.7 dBFS), well under the −6 dBFS ceiling and the
    −8 dBFS aim), a **wet-vs-dry** guard (wet **−39.9 dBFS** vs dry **−15.8 dBFS**, 24 dB below), a
    **paired-event** guard comparing **aligned 1-second windows** (max lift **0.00 dB** ≤ +3, plus a
    deliberately over-loud `eventBoost: 500` fixture lifting a window **11.15 dB** to prove the guard is
    not vacuous), and a **texture-vs-pad** guard (**−39.2 dBFS** vs **−15.7 dBFS** = 23.5 dB under,
    ≥ 12 dB, and inside the spec's ≈ −42…−32 dBFS listening guide). Measured matrix: `active` peak 0.3581 / rms −15.8 dBFS;
    `wake-reveal` peak 0.3549; `single-voice` peak 0.2828; `stillness` and the post-deadline samples
    stay exactly zero. A new live `browser/audio-reveal.spec.ts` drives the locked→wake→reveal path from
    a **not-pre-live** frozen load, logs support/audibility/master/phase against real timestamps and
    asserts the destination is audible within a few real seconds of the wake. The `browser/audio-audible`
    fixture now keys on `supportFraction` (occupancy and support are different units). The default
    browser suite runs **66 passed / 12 gated skips** (was 60/12: +5 offline cases and the reveal
    fixture); `STILLNESS=1` passes (`audioZeroAt` **2.01** performance-s, 20.01 s black-hold, re-arm
    `satisfied` false). Live capture on the real output device: settlement peak **0.294** / RMS 0.175,
    dominant **128.9 Hz** (inside the 110–165 register); the locked→wake→reveal path is audible
    **≈ 1.0 s** after the wake (master 0.27 at +1.2 s, 0.75 by +2.5 s) and the live timeline logs
    support / root / 150–2000 Hz band / master / silence phase against real timestamps.
    **Round-C review fixes (same character rework).** (MAJOR 1) A field-replacing reset
    (`restart`/`applyResolution`/a replaced `load-trajectory`) now **de-clicks to zero and stays there**:
    `declickMaster`'s ramp back up is gone, `declickToZero` holds the master at exactly zero and every
    persistent source (the four pad voices and the texture bus) is forced to exactly zero at that zero
    instant, so the pre-reset tone can no longer sound into the freshly seeded empty field; the master
    rises only through the ordinary §6 reveal once the NEW field confirms support. A trajectory load that
    *preserves* the field never calls `resetPerformance`, so it keeps its semantics. Verified by the new
    offline `reset-silence` fixture (`resetSilencePeak` **exactly 0** from the de-click end until fresh
    confirmation, then audible), by `resetSilencePeak` **0** in the `restart` fixture, and by the
    lifecycle restart test, which now asserts presence-gated silence instead of the (previously codified)
    rise. (MAJOR 2) `mapPadLevel` no longer re-gates the floor on the raw on-threshold every sample: it
    zeroes only for an **absent** field (`supportFraction > 0`) while the engine's latched
    `presenceEligible` — not the raw descriptor — is the stateful gate, so the floor is held through the
    hysteresis band and removed only once below support-off (unit-verified: the pad target is unchanged
    across six in-band samples and removed exactly once below off). (MAJOR 3) An invalid/stale sample now
    **breaks an unconfirmed candidate sequence** (counters/timestamp cleared) while already-eligible
    presence keeps its hold; unit-verified (valid A → invalid > 0.5 s → valid B is sample 1 of a new
    sequence; valid C + persistence confirms). (MINOR 4) The live-master root raise is now a **bounded
    linear ramp with an explicit 0.75 s endpoint** (terminal assignment), started from the root's JS
    mirror — never an asymptotic `setTargetAtTime` and never a read of a scheduled `AudioParam.value`; the
    ordinary τ smoothing returns after the window (unit-asserted: ramp time = start + 0.75 s, exact
    endpoint, target equal to the derived per-voice level). (MINOR 5) The paired-event guard compares
    **aligned 1-second windows** rather than whole 8 s renders, with a deliberately over-loud
    `eventBoost: 500` fixture that fails the guard (11.15 dB) to prove it is not vacuous. (MINOR 6) This
    entry records all of the above and fixes the `tests/presentation-support.test.ts` filename. **A real
    render bug was found while verifying MINOR 5:** `reap()` disconnected one-shot nodes during the
    offline driver's *pre-render* scheduling (the whole timeline is queued before `startRendering()`), so
    every finished bloom and most grains were silenced — this is why the isolated texture had measured a
    spurious ≈ −47 dBFS and the first bloom was inaudible. Disconnection is now deferred to `dispose()`
    on a non-realtime context while retirement still bounds the live accounting (`long-run`:
    created = stopped + live). Re-measured: isolated texture **−39.2 dBFS**, event-only **−37.9 dBFS**,
    `event-refractory` peak 0.3853, all still ≤ the peak ceiling.
    **Round-D presence/reset fixes (same character rework).** (MAJOR 1) An **inaudible** reset — paused,
    muted or locked — used to `cancelMasterAutomation()`, which *holds* the mirrored live level (~0.75);
    a later resume/unmute then saw a nonzero master, took the "master already live" branch and exposed the
    fresh field through the ~0.15 s mute release instead of the unified 1.5 s reveal. The inaudible branch
    now calls `anchorMasterAtZero()` (scheduled param **and** JS mirror at exactly zero) and clears the
    episode state immediately, so the exact-silence branch stays reachable and the resume/unmute runs one
    1.5 s reveal ending at resume + 1.5 s (unit-verified for paused, muted **and** locked, including that
    the master is still < 0.2·masterLevel at the 0.15 s mute-release point, so the upper voices cannot
    become audible through it). (MAJOR 2) `silenceSources()` only zeroed the pad and texture gains, so an
    in-flight bloom (3.42 s), a grain (≤ 1.2 s) or the convolver's 2.4 s tail could survive into the new
    field's reveal. It is replaced by **`clearEpisodeState()`**, which at the reset's zero instant retires
    **every** one-shot (stops and disconnects `pending`, disconnects `retired`, counts them stopped), forces
    the pad, texture **and event** buses to exactly zero, and flushes the wet path by **reassigning the
    convolver's impulse response** (a fresh deterministic buffer from the current sound substream) to clear
    its internal history; a new bloom re-asserts unity on the event bus at its own start time, so the event
    path keeps working. Verified by new offline fixtures: **`reset-bloom`** (a bloom fired 0.2 s before the
    reset) and **`reset-grain`** (grains flowing up to the reset) each compared against an exact control
    (`reset-clean` / `reset-grain-clean`, differing *only* in pre-reset one-shot activity) — the post-reveal
    windows differ by **0.000 dB** with `resetSilencePeak` **exactly 0**, and the grain comparison is
    texture-only so the control cannot be trivially silent. (MAJOR 3) `revealVoice` recorded a
    `rootSegment` constant at its endpoint, so `rootLevelAt` misreported the in-flight level, and
    `applyControls` kept skipping root control while `rootRevealUntil` was active even after presence had
    cleared — the scheduled rise continued and a rapid re-confirm started from the false full target. The
    mirror now records the **true linear segment** (start/end/from/to) and `rootLevelAt` evaluates it, and
    a new `abandonRootReveal()` cancels the ramp and re-anchors at the mirrored in-flight value whenever
    presence clears or the reveal becomes prohibited (the ordinary τ then glides the root *down*). Unit
    test: confirm presence with a live master, drop below support-off halfway through the 0.75 s ramp →
    the positive endpoint is cancelled, no later gain increase occurs, and a re-cross produces a new ramp
    that starts exactly at the mirrored in-flight value (no upward step). (MINOR 4) `resetPerformance`
    unconditionally replaced `pendingReset`, so a **seedless** reset inside the de-click window dropped a
    pending seeded reseed while `recordedRootSeed` already reported the new seed. It now coalesces: a newer
    explicit seed supersedes, a seedless reset **preserves the latest pending seeds** and only moves the
    swap to the newest zero instant, and an inaudible (immediate) reset applies any pending seeds rather
    than discarding them. Unit-verified: `resetPerformance(t, 77)` then a seedless `resetPerformance(t+0.05)`
    leaves the material equal to a fresh seed-77 engine; two seeded resets apply the latest; two seedless
    resets leave the substream unchanged. Counts after Round-D: `npx tsc --noEmit` clean, `npm test`
    **329/329**, offline browser suite **16/16**.
    **Round-E root-reveal prohibition fix (same character rework).** (MAJOR) `tick()` abandoned the
    in-flight root raise on **any** interruption (`!eligible || !revealPermitted()`) and cleared
    `rootRevealUntil`; `applyControls` then took its ordinary branch and scheduled a **positive** root
    target, so the root kept rising behind the mute / under the stillness fade — and because presence
    stayed eligible `presenceRevealed` was never cleared, so `beginReveal` never retried and the root
    returned *already raised* on resume/unmute. Two distinct cases are now handled: presence **cleared**
    abandons and glides down as before, while a **prohibited** interval with presence still eligible sets
    a new `rootRevealPending` marker; for that interval `applyControls` drives the root **down** through
    the ordinary bounded τ and never schedules a positive target, and when permission returns with
    presence still eligible the unified reveal restarts **exactly once**. `beginReveal` additionally now
    gives the root its own bounded 0.75 s ramp — concurrently with, never in series with, the master
    reveal — when the master is live-ish mid-fade (which also covers the general-fade-reversal case),
    while from exact silence the root is still *prepared* behind the zero master. Unit-verified for
    **pause, mute and stillness-armed** (`§6 (MAJOR) a prohibited interval holds the root down and reveals
    once on release`): after the halfway interruption the root mirror never increases over ≥ 0.6 s and no
    positive root target or ramp is scheduled; on release exactly one bounded ramp runs to
    `release + 0.75 s`, starting at the mirrored held/decayed value (no upward step).
    (MINOR) The three inaudible-reset cases are now parameterized over one table with the **identical**
    assertion set — immediate/stable exact zero on param and mirror, exactly one linear master ramp to
    `AUDIO.masterLevel` ending at permission-return + `AUDIO.revealSeconds`, and the master still
    `< 0.2·masterLevel` at +0.15 s — so paused, muted and locked all pin the early-level bound and the
    ramp value. Counts after Round-E: `npx tsc --noEmit` clean, `npm test` **332/332**.
    **Round-F: TAKE-4 musicalization (operator take-3 feedback).** The operator found the pad drone
    "changes too slowly to feel alive" and asked for the tones to be married to a musical scale. The
    design of record is the **"TAKE-4 REVISION" section appended to `sound-design-spec.md`** (both
    generations of that file are retained for the reviewer); it **supersedes** the continuous
    feature-scale→fundamental mapping, the universal just-major ratios `[1, 2, 3, 5/2]`, the bloom
    2×/3× pitch rule and the 165 Hz pad ceiling. **Feature scale remains causally audible through bloom
    octave selection**, so no approved mapping is lost. Everything else is untouched: causal
    architecture, presence/reveal/reset lifecycle (through Round-E), silence discipline, level plan, IR
    recipe, grain recipe, compressor, high-pass, `masterLevel`, and every output guard.
    **What changed.** A fixed **A-major-pentatonic key** (tonic A2 = 110 Hz; just ratios
    `[1, 9/8, 5/4, 3/2, 5/3]`; `scaleHz(k) = 110·2^floor(k/5)·ratios[k mod 5]`). The pad's **degree** is
    chosen by **reaction-activity bands**: `x = ln(1 + a/.001)/ln(31)` over `a = clamp(activity, 0, .03)`,
    five bands at `.2/.4/.6/.8`, τ = 1.5 s smoothing that advances **only on distinct fresh valid
    samples** (elapsed capped at 1 s per update), Schmitt hysteresis ±.025, a ≥ 1 s + ≥ 3-distinct-sample
    confirmation, a **12 s degree refractory**, at most **one adjacent step** per confirmed crossing, no
    queued destination or catch-up, and no 4→0 wrap. Voicings are an explicit **scale-aware table**
    (A major, B/F♯/E suspended-fourth, C♯ fourth + minor-third colour), carriers 110–550 Hz, all in key.
    Detuning is gone (`maxDetuneCents = 0`; coherence controls chord-colour gain, bloom degree and wet
    only). Each committed change is **one bounded 1.25 s logarithmic glide** (`f0·(f1/f0)^u`) scheduled
    **once** as a `setValueCurveAtTime` curve on a dedicated idempotent pitch path — the old per-tick
    `setTarget` on voice frequencies (and the `rootHzSmoothed` scalar mirror) are removed, so a control
    pass can never fight or quantize a glide. Bloom degree comes from **coherence bands** (τ 1.5 s,
    hysteresis ±.03) and its octave from `featureScaleNorm` (coarse `scaleHz(degree+5)` = 220–366.667 Hz,
    fine `scaleHz(degree+10)` = 440–733.333 Hz; highest weak harmonic 2200 Hz); `spawnEvent` now takes
    `{baseHz, strength}` and the engine selects the note; the bloom attack lengthened 120 → 180 ms.
    `AudioEngine` gained the musical state (fresh-sample identity, smoothed selectors, confirmed bands,
    accepted degree, commit clock, frequency mirror), and `stats()`/`OfflineMeasurements` expose the §9.5
    diagnostics (selector values, observed/committed degrees, carriers, crossing/accept/drop counters and
    a bounded change log with reasons).
    **§9.4 acceptance fixture (offline `lively`).** A settled degree-0 reveal, then **raw activity
    targets** at the centres of bands 1, 2, 3, 4 (one step every 20 s) and finally back down to the
    band-2 centre. The raw target sequence and the **confirmed crossing** sequence differ: on the way
    down the τ-smoothed selector decays *through* band 3 before reaching band 2, so the **confirmed
    crossings** are into bands 1, 2, 3, 4, 3, **2** — **6 confirmed crossings**, of which the first five
    (bands 1, 2, 3, 4, 3) are accepted and the last (band 2, only ≈2 s after the band-3 commit) is
    dropped by the 12 s refractory; 0 are dropped by admissibility. That yields **exactly 5 accepted pad
    changes**, the accepted path `0→1→2→3→4→3` (the fifth accepted crossing — into band 3 — moves the
    degree from 4 one adjacent step to 3; the final band-2 crossing would move 3→2 but is
    refractory-dropped before it can), every commit ≥ 12 s apart, all
    settled carriers in key, peak 0.372 (≤ −6 dBFS). A fragmented single-voice companion fixture (`lively-fragmented`)
    reproduces the same five changes with `maxVoices = 1`, and `lively-freeze` shows identical
    diagnostics at 60 s and 130 s (frozen descriptors add no crossing and no glide). `chatter` (activity
    oscillating inside the deadband) confirms nothing, and both bloom registers produce in-key notes
    (fine 550 Hz / coarse 275 Hz at coherence-band 2).
    **Counts after Round-F:** `npx tsc --noEmit` clean; `npm test` **349/349**; the offline browser suite
    gains 6 musicality cases (fixture 4, single-voice-at-every-root, freeze, chatter, both bloom octaves,
    glide+event overlap) and all prior guards are unchanged and unrelaxed.
    **Round-G: TAKE-4 selector-state-machine review (4 MAJOR + 2 MINOR).** A reviewer pass over the
    Round-F selector machinery found four state-machine defects that the offline fixtures cannot see
    (every fixture tick is a *fresh* sample, so the live path's fresh/duplicate split is never
    exercised) plus two documentation issues; all six are fixed, each with a unit test that was checked
    to fail against the pre-fix code.
    1. *Smoothing used the scheduler tick gap, not real elapsed time.* `advanceBandSelector` was passed
       `dt = clamp(tickGap, 0, 1)` and `lastUpdateAt` was written but never read, so with fresh marks
       every 0.5 s and ticks every 50 ms τ = 1.5 s acted as ≈15 s — the static drone the revision exists
       to remove. Elapsed is now `min(now − lastUpdateAt, 1)` measured from the previous **fresh** sample;
       duplicates never touch the clock. Applies to the activity, coherence and bloom-register selectors.
    2. *Silent preparation ignored the current descriptors.* Spec §"Degree acceptance, not queued
       motion" ("At silent preparation both = current nominal activity band") is now implemented by
       `baselinePitchFromActivity`, called from `beginReveal` while the master is at exact zero: the
       observed band, the smoothed selector value and `padDegree` are all seeded from the current
       nominal band, and that voicing is applied immediately (inaudible, no candidate, no counter, no
       log). Without it a high-activity organism revealed on the neutral A and stayed there, its
       confirmed crossing consumed as prohibited during the reveal window.
    3. *Duplicate ticks could emit the confirmation.* The `samples ≥ 3 && elapsed ≥ 1 s` test ran
       outside the `if (fresh)` block in both `advanceBandSelector` and `updateBloomRegister`, so three
       rapid samples plus scheduler time latched a band on a stale snapshot. Confirmation/latching is now
       evaluated only while processing a distinct fresh sample.
    4. *Candidate debt straddled a prohibited interval.* Candidates are now rebaselined on permission
       **return** as well as on entry to prohibition (activity, coherence and register candidates), so a
       candidate formed while already prohibited cannot commit on the first fresh post-return sample. A
       crossing that *fully confirmed* while prohibited still latches the observed band (consumed, never
       replayed). Verified for pause, mute, armed stillness, the reveal window and absent support.
    5. *Clean browser report (MINOR).* The retained `artifacts/playwright-report.json` had recorded one
       unexpected failure (a `smoke` loop test reading an undefined `.clock`); it did not reproduce, so
       it was a flake. The default suite now reports **75 passed / 12 gated skips / 0 unexpected / 0
       flaky** (JSON report `expected 75, skipped 12, unexpected 0, flaky 0`). Note: passing
       `--reporter=list` on the CLI *overrides* the config reporters and suppresses the JSON report, so
       the default `npm run test:browser` (no override) is what regenerates it.
    6. *Round-F wording (MINOR).* Round-F conflated raw target bands with confirmed crossings. The raw
       `lively` targets are the centres of bands 1, 2, 3, 4 then back to the **band-2** centre; because the
       τ-smoothed selector decays *through* band 3 on the way down, the **confirmed crossings** are into
       bands 1, 2, 3, 4, 3, **2** — six in total, the first five accepted (`0→1→2→3→4→3`) and the last
       (band 2, ≈2 s after the band-3 commit) refractory-dropped. The stale `offline.ts` comments that
       said the last target returned "to band 3" were corrected to band 2 for the same reason.
    **Counts after Round-G:** `npx tsc --noEmit` clean; `npm test` **355/355** (6 new selector
    state-machine cases: fresh-vs-tick-gap smoothing, silent-reveal baseline for bands 0–4, duplicate
    non-confirmation for activity+coherence+register, and the four permission-return debt cases);
    default `npm run test:browser` **75 passed / 12 gated skips / 0 unexpected**; `STILLNESS=1` stillness
    reachability passed. The §9.4 `lively` diagnostics are unchanged (every offline driver tick is fresh,
    so the Round-G freshness rules are a no-op there): still exactly 5 accepted changes with 6 confirmed
    crossings and 1 refractory drop.

59. **Round-A (Phase 4) robustness: the laboratory misconfiguration guardrail, WebGL context-loss
    recovery, and two browser-flake root causes.**

    **(a) Laboratory misconfiguration guardrail (§10; the operator's standing Phase-1 caveat).** The
    hidden laboratory now tells the operator that a parameter choice would kill the field **while the
    sliders are still being moved**, not after the screen has gone black.
    - A live warning element (`src/lab/lab.ts` `refreshViability`) fires when the *effective* `(F, k)`
      maps to `dying`/`nonviable` via the existing `describeRegime` (`src/core/regime.ts`) — e.g.
      `k ≥ DEATH_K (.0635)` or a low-feed `dying` anchor — or when a field that has been measurably
      alive has collapsed for ≥ 6 performance seconds *outside* an exempt movement. It names the
      calibrated viable band ("…consider k ≈ .057–.062 at F ≈ .029–.030"). The occupancy-collapse
      signal is exempt for `dormancy` and `nucleation` (measured: occupancy is legitimately near zero
      for a few seconds after every nucleation while the seed grows back above the alive threshold),
      so an intentional rebirth is never flagged.
    - A **`restore viable defaults`** button dispatches the calibrated parameters (`DEFAULT_PARAMS`,
      mode `override`) **and reseeds** the recorded seed at the current radius. The reseed is
      required: a field that has already died has no `V` left and Gray–Scott cannot nucleate from a
      uniform state, so the dispatch alone would not recover occupancy. The sliders are snapped to the
      restored values so the panel and the chemistry agree.
    - An opt-in clamp (scope item (c)) that is **coupled**, not two independent ranges
      (`src/lab/viability.ts`). Viability is a property of the `(F, k)` pair, so with dangerous values
      off every proposed pair is **projected** onto an evidence-backed viable set: `F`/`k` are clamped
      into the danger-off envelope (`F ∈ [.014, .055]`, `k ∈ [.045, .062]` — the `k` ceiling is the
      highest **measured-alive** anchor `.062`, not the death-boundary midpoint, so a sanitize lands on
      measured life), then a pair that would classify `dying`/`nonviable`/`unmapped` has `k` moved to
      the nearest living anchor at that `F` (e.g. the measured-dead corner `.014/.045` → `.014/.054`),
      falling back to the calibrated defaults only when no anchor `k` is viable at that `F`. The
      **`allow dangerous values`** toggle widens the sliders to the plan's full `PARAM_ENVELOPE`, and
      switching it **off sanitizes the live override immediately** (dispatching the projected pair) and
      re-syncs the slider DOM/native/readout/internal values to it. The toggle rebuilds the panel
      (bounds of a range input cannot be patched in place) — the same approach the exploration toggle
      already uses.
    Presentation mode is untouched (the panel is created only while open and removed on close, AC.15).
    Browser spec `lab-guardrail.spec.ts` drives the real controls: the calibrated defaults show no
    warning; all four danger-off envelope corners (including the measured-dead `.014/.045`) land on a
    viable pair with the slider value, the readout and the effective model all agreeing; with danger on,
    `k = .075` warns and reads `nonviable`, and switching danger off sanitizes immediately to `k = .062`;
    re-enabling danger makes `.075` reachable again; clicking restore clears the warning, snaps the
    sliders to `F .03 / k .062`, and the field's occupancy (read straight from the field via the
    `fieldStats` hook, not a stale analysis sample) grows out of the collapsed range. A second case
    proves the collapse warning on a **sparse living field** (see (g)).

    **(b) WebGL context loss and restoration (§11.3; closes the AC.11/AC.13 gap).** `App` now installs
    `webglcontextlost`/`webglcontextrestored` listeners on the canvas (`src/app.ts`
    `onContextLost`/`onContextRestored`). On loss it calls `preventDefault()` (opting into
    restoration), stops the rAF loop and issues **no further GL calls** (the frame callback is guarded
    too): the forced silence is a **transient gate** (`AudioSystem.setContextMuted`, on the audio
    thread, separate from the operator's mute preference), and the pending analysis is discarded
    through the CPU-only `clearAnalysisState` — `Analyzer.reset`/`PresentationWorker.reset` (whose reset
    calls `gl.deleteSync`) are deliberately **not** invoked on the lost context; those instances are
    dropped and rebuilt at restoration instead. On restoration it recreates
    **every** GL resource through the same construction paths the constructor uses — `Simulation`
    (chemistry ping-pong + programs), `Renderer` (derived-field/bloom/material targets and all render
    programs) and `Analyzer` (reduction targets + the whole pixel-pack-buffer ring) are reconstructed,
    and the CPU-side presentation worker is recreated so its pooled slot ring starts clean — then
    begins a **quiet new arc with the recorded seed** (monotonic epoch, fresh curator, director/audio
    re-armed) and resumes. The dead GL instances are **dropped rather than disposed**: after a loss the
    driver has already freed their objects and deleting the stale handles raises `INVALID_OPERATION`
    console warnings, so `ResourceTracker.reset()` re-bases the shared tracker to zero before the
    replacements are built (giving the rebuilt set the same baseline the original had, so a leak stays
    visible). If the rebuild throws, the piece stays stopped rather than presenting a fake simulation.
    New browser spec `context-loss.spec.ts` forces a real loss through `WEBGL_lose_context` and
    asserts no page errors, the loss flag/counter, muted audio, a frozen step count and an intact
    presentation DOM; then `restoreContext()` and asserts the loop resumes, the epoch is monotonic,
    **the rebuilt resource counts equal the pre-loss counts exactly** (nothing leaked, nothing
    reused), and the forced gate is dropped so the operator's mute preference applies. A second case
    (`review fix MINOR 3`) covers initially-muted and initially-unmuted starts: the operator mute
    toggles **both ways during the outage** update only the preference while the effective gate stays
    forced-muted, and after restoration the **latest** preference applies.

    **(c) Browser flake A — `smoke.spec.ts` "the loop runs…" read `undefined` / a destroyed execution
    context.** Root cause: the dev server used by the harness had HMR enabled, and because no module
    declares an `import.meta.hot.accept`, Vite answers **any** write to a module in the graph with a
    full page reload sent to every client. During active development — exactly when this suite runs —
    an editor or another process routinely writes a source file, so a reload could land mid-test,
    destroying the evaluate context ("Execution context was destroyed") and resetting live state to
    the startup defaults. Reproduced with a scripted probe: touching `src/config.ts` (mtime only)
    reloads the page with HMR on and does **not** reload it with `VITE_TEST=1` (frame-navigation count
    2 → 1). Fixes, all at the harness level: `vite.config.ts` disables HMR when `VITE_TEST=1`;
    `playwright.config.ts` starts the webServer with that env and no longer reuses a pre-existing
    server (so the suite always runs against the HMR-suppressed one — a stray `npm run dev` on 5199
    now fails loudly instead of flaking); the smoke test polls the delivered step count instead of a
    single fixed-interval read; and the shared `hook()` helper retries across transient execution-
    context failures, re-waiting for the hook and treating a momentarily-missing `window.__artwork` as
    transient while still failing fast on a genuinely missing method.

    **(d) Browser flake B — `phase2-integrity.spec.ts` MAJOR 7 director pin ("0.5 vs 1.5").** This was
    **not** a publish/reset ordering bug in the application. Reproduced in a loop (failed 5/10, then
    2/20): the pin commands are applied correctly (`cameraPins` reports `true`) but the published
    camera/light/material read back as the calibrated **defaults**. Instrumentation showed the real
    clock did not advance at all during the test's fixed 1.5 s wait (`cadenceCounters.realSeconds
    0.48 → 0.48`, no page errors, no context loss): after the synchronous `advanceComposition(10000)`
    burst the transport is paused, so the 2 Hz publication never fires and the only writer of the
    frame-driven `worldState.camera/light/material` is the rAF loop — which can stall briefly while the
    just-submitted 10 000-step GPU batch drains. A fixed wall-clock wait therefore sometimes elapsed
    with a stale snapshot. Fix: the test now waits on **frame-loop progress** (`waitForFrames()` polls
    `clock.realSeconds`, which advances every frame even while paused) instead of a fixed
    `waitForTimeout`, removing the wall-clock assumption at its source. Verified 20/20 consecutive
    passes.

    **(e) §9.3 camera light azimuth hold (Phase-2 leftover).** Verified against the plan: `updateLight`
    travels toward the bounded per-arc target at ≤ 25°/min and snaps/holds once inside
    `azimuthHoldEpsilonRadians`; the existing tests already covered per-frame rate limiting, the
    bounded band, and a plateau. Added a unit assertion in `tests/director.test.ts` that encodes §9.3
    in the plan's own units — no 60 s window exceeds 25°/min of travel — and asserts **zero residual
    drift** once the azimuth reaches the target exactly. Instrumentation note: the snap-to-target
    check uses the *pre-move* delta, so the light may land within tolerance a frame before landing
    exactly on the target — a single bounded step, not drift; the assertion measures from the first
    frame the azimuth equals the target.

    **(f) Counts after Round-A.** `npx tsc --noEmit` clean; `npm test` **356/356** (one new director
    case); default `npm run test:browser` **77 passed / 12 gated skips / 0 unexpected / 0 flaky**
    (JSON report `expected 77, skipped 12, unexpected 0, flaky 0`; the two new specs are
    `context-loss.spec.ts` and `lab-guardrail.spec.ts`); the two flake specs re-run in a loop —
    `smoke.spec.ts` "the loop runs…" **10/10** and `phase2-integrity.spec.ts` MAJOR 7 **20/20** — and
    `STILLNESS=1` stillness reachability passed. Only the run's own regenerated evidence
    (`artifacts/playwright-report.json`) changed; the checked-in capability/performance artifacts were
    restored so the round's diff stays limited to the actual work, and `artifacts/phase1-gate/` is
    untouched.

    **(g) Round-A review fixes (1 MAJOR + 2 MINOR), amended counts.** `npx tsc --noEmit` clean;
    `npm test` **364/364** (8 new `tests/viability.test.ts` cases); default `npm run test:browser`
    **79 passed / 12 gated skips / 0 unexpected / 0 flaky** (the two round-A specs gained the cases
    below). The fixes:
    - **MAJOR — the danger-off clamp was a rectangle, and danger-off did not sanitize.** The clamp was
      two independent ranges, so its corner `(.014, .045)` — a project-measured dead anchor — was
      dialable, and `enable danger → k=.075 → disable danger` merely rebuilt the panel, leaving the
      live override non-viable and the display disagreeing with the model. Viability is now a
      **coupled** `(F,k)` predicate with a projection (`src/lab/viability.ts`): with danger off every
      proposed pair is clamped into the danger-off envelope and, if it would classify
      `dying`/`nonviable`/`unmapped`, `k` is projected to the nearest **evidence-backed living anchor**
      at that `F` (or the calibrated defaults when none is viable); the danger-off `k` ceiling is the
      highest measured-alive anchor `.062` rather than the death-boundary midpoint `.0634`; switching
      danger off **sanitizes the live override immediately**; and `createSlider` now derives its
      internal value from the native (clamped) input value, with projected values written back through
      `setValue`, so the DOM, the native range, the readout and the internal model cannot disagree.
      `tests/viability.test.ts` pins the invariants — notably that **all four envelope corners** and a
      dense 10⁻³ sample of the plane project to viable, in-envelope pairs, and that
      `projectViableParameters` is idempotent on the defaults.
    - **MINOR 2 — the collapse arming threshold missed sparse living fields.** `seenAlive` armed at full
      occupancy ≥ 0.02, above our own worms anchor `(.030, .062)` occupancy **0.009**, so a legitimate
      sparse field could die unwarned. The threshold is now **0.006** (below the documented living
      value, above the 0.002 collapse floor), keeping the `dormancy`/`nucleation` exemption.
      `lab-guardrail.spec.ts` grows the sparse worms field (measured occupied ≈ 0.0087), confirms no
      warning while it lives, then kills the field and asserts the warning appears only after
      **6 delivered performance seconds** (measured 8.4) and never during `dormancy`/`nucleation`.
    - **MINOR 3 — the context-loss mute shared one flag with the operator preference.** On loss the app
      snapshotted `audio.isMuted()` and set the same flag true, so an operator unmute during the outage
      defeated the forced silence and restoration overwrote a preference change. `AudioSystem` now
      keeps the operator **preference** and a transient **context-loss gate** separately
      (`setMuted`/`setContextMuted`), with `isMuted()` = OR of the two and `mutePreference()` the
      preference alone (exposed on the hook). The loss path sets the gate; restoration drops it. The
      `context-loss.spec.ts` mute case covers initially-muted and initially-unmuted starts, toggles the
      operator mute both ways during the outage (effective stays muted throughout), and asserts the
      latest preference applies after restoration.
    - **Caveat the reviewer noted — `deleteSync` on a lost context.** The loss path previously called
      `resetAnalysis`, which reaches `Analyzer.reset` → `gl.deleteSync` on the dead context, so the
      "no GL calls" wording was wrong. The loss path now uses the CPU-only `clearAnalysisState` and the
      analyzer/presenter are dropped and rebuilt at restoration, so "no further GL calls" is literally
      true. Documented in (b).
    - **Unrelated flake found while verifying (same family as (d)).**
      `lab-composition.spec.ts` Fix B captured its `calibrated` baseline from the frame-driven
      published snapshot immediately after a camera reset, so it could read the pre-reset,
      slightly-smoothed camera and then disagree with the freshly-read released camera by ~1e-5
      (observed once in the full suite; 20/20 clean in isolation). It now waits for frame-loop progress
      (`waitForFrames`) before capturing the baseline.

