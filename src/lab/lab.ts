/**
 * §10 hidden laboratory.
 *
 * The panel exists only while it is open: `close()` removes the host element from the document
 * so presentation mode contains zero UI nodes (AC.15). It uses the same command interface as
 * application transport, so nothing here can reach into module internals.
 */
import { DEFAULT_PARAMS, EXPLORATION_GRID, PARAM_ENVELOPE, TIME } from '../config.ts';
import type { AppCommand } from '../core/commands.ts';
import { formatSimTempo } from '../core/longform.ts';
import { describeRegime, formatRegime } from '../core/regime.ts';
import type {
  ChemistryHealth,
  Diagnostics,
  EventState,
  GenesisKind,
  GLResourceCounts,
  Params,
  PresentationAnalysis,
  WorldState,
} from '../core/types.ts';
import { createCaptureControls } from './capture.ts';
import { VIABLE_ENVELOPE, projectViableParameters } from './viability.ts';
import type { SliderHandle, TextHandle } from './controls.ts';
import {
  createButton,
  createHelp,
  createReadout,
  createSection,
  createSlider,
  createText,
  createToggle,
} from './controls.ts';
import { formatDiagnostics } from './diagnostics.ts';
import { createLabGenesisCommand } from './genesis-lab.ts';

/**
 * §10 laboratory labelling: what each parameter actually does. F/k decide whether there is fuel and
 * whether the organism persists; Du/Dv are how far each chemical spreads. The current value stays
 * prominent on the slider itself.
 */
const PARAM_INFO: Record<keyof Params, { title: string; help: string }> = {
  F: {
    title: 'feed rate',
    help: 'fuel U replenishment — low = starvation/sparse, high = lush growth',
  },
  k: {
    title: 'kill rate',
    help: 'decay of V — the k−F gap sets pattern scale: small gap → large labyrinths, large gap → small cells',
  },
  Du: {
    title: 'U diffusion',
    help: 'fuel spread — smoother, more connected growth; main stability bound dt·Du ≤ 0.25',
  },
  Dv: {
    title: 'V diffusion',
    help: 'organism spread — slow relative to Du → sharp, skin-like boundaries',
  },
};

const PANEL_HELP =
  'The organism is chemical V living on fuel U; F feeds it, k kills it, Du/Dv are how far each spreads.';

/**
 * §10 Phase-4 guardrail (the operator's standing Phase-1 caveat: "quite easy to end up with a blank
 * screen because of misconfiguring the lab"). The laboratory now warns *while the operator is still
 * choosing* — from the same `describeRegime` readout the panel already shows plus the live tier-1
 * occupancy — rather than after the field has already gone black.
 */
const VIABLE_PARAMS_WARNING =
  'parameters look non-viable — the field will die; consider k ≈ .057–.062 at F ≈ .029–.030';
const COLLAPSED_WARNING =
  'occupancy has collapsed — the field looks dead; consider k ≈ .057–.062 at F ≈ .029–.030';

/**
 * Occupancy above which the field is considered to have been alive at least once this session, so a
 * later fall can count as a collapse. It must sit **below the documented living occupancy of the
 * sparsest viable regime**: our own worms anchor `(.030, .062)` records occupancy **0.009**
 * (`artifacts/phase1-gate/captures.json`), so the previous `0.02` could never arm on a legitimate
 * sparse field and its death went unwarned (review fix MINOR 2). `0.006` is comfortably below that
 * living value and above the collapse floor `0.002`, and the dormancy/nucleation movement exemption
 * still prevents fresh-nucleation false positives.
 */
const VIABLE_ALIVE_OCCUPANCY = 0.006;
/** Occupancy at or below which a previously-living field counts as collapsed. */
const COLLAPSE_OCCUPANCY = 0.002;
/**
 * Sustained collapse (performance seconds) before the warning appears. The collapse signal is only
 * evaluated for **established** movements: `dormancy`/quiet are intentional empty states, and
 * `nucleation` starts from a freshly reseeded field whose occupancy is legitimately near zero while
 * the seed grows, so neither may be flagged (measured: occupancy climbs back above the alive
 * threshold within a few seconds of every nucleation).
 */
const COLLAPSE_SECONDS = 6;
/** Movements whose low occupancy is expected rather than a sign of failure. */
const COLLAPSE_EXEMPT_MOVEMENTS = new Set(['dormancy', 'nucleation']);

export interface LabSnapshot {
  parameters: Params;
  effectiveParameters: Params;
  overrideActive: boolean;
  steps: number;
  epoch: number;
  simulationTime: number;
  performanceSeconds: number;
  speed: number;
  paused: boolean;
  rendererInfo: string;
  resourceCounts: GLResourceCounts;
  activation: string;
  seed: number;
  autoSeed: boolean;
  scene: string;
  diagnosticsView: 'none' | 'analysis' | 'topology' | 'spectrum' | 'camera';
  genesisRadiusCells: number;
  /** §10: the active simulation grid edge in chemical cells (768 presentation, 512 exploration). */
  simulationResolution: number;
  /** §10: whether the lab-only exploration grid is currently active. */
  explorationActive: boolean;
  /** §10: the speed range the active resolution supports. */
  speedRange: readonly [number, number];
  /** §10: the 60 fps speed ceiling the active resolution measured. */
  speedCeiling: number;
  /** §6.3/§6.4 composition progress: arc, movement, elapsed/progress, intention and stillness state. */
  phase: {
    arc: number;
    movement: string;
    elapsedSeconds: number;
    progress: number;
    intention: string;
    stillnessState: string;
  };
  /**
   * §12.2 composition-document provenance (Fix A): where the active document came from, the bootstrap
   * error if any, and the current document id / movement ids. This is what the laboratory status shows
   * while the panel is open — the console and the verification hook are no longer the only surfaces.
   */
  trajectory: {
    source: string;
    error: string | null;
    id: string;
    movements: string[];
  };
  /** §7.1 tier-1 chemistry health: full-domain occupied fraction / activity / change rate + validity. */
  chemistryHealth: ChemistryHealth;
  /** §7.1 tier-2 presentation tier (envelope-weighted), including β0/β1, bands, coherence, events. */
  presentation: PresentationAnalysis;
  /** §3.4 the latest recognized event (serial-numbered). */
  event: EventState;
  /** §3.4 the bounded retained event log. */
  eventLog: EventState[];
  /** §8 audio: truthful status plus the live silence acknowledgement (`satisfied`/`terminalZeroAt`). */
  audio: {
    status: string;
    unlocked: boolean;
    muted: boolean;
    available: boolean;
    silence: { satisfied: boolean; terminalZeroAt: number | null };
  };
}

export interface CaptureResult {
  blob: Blob;
  filename: string;
}

export interface LabApi {
  dispatch(command: AppCommand): void;
  reseed(radiusCells?: number): void;
  restart(): void;
  capture(): Promise<CaptureResult>;
  startRecording(): Promise<{ mimeType: string }>;
  stopRecording(): Promise<CaptureResult>;
  recordingInfo(): { supported: boolean; mimeType: string };
  mimeForCapture(): string;
  snapshot(): LabSnapshot;
  /**
   * §10 trajectory import. Validate `text` as a `TrajectoryDocument` (never evaluated) and, when it
   * parses, make it the active composition without touching the field or the epoch. A rejection is
   * returned as `{ ok: false, reason }` so the laboratory can display it.
   */
  importTrajectory(text: string): { ok: boolean; reason?: string };
  /** §10 trajectory export: the active document serialized as JSON text (round-trips through import). */
  exportTrajectoryText(): string;
  /**
   * §10 diagnostic overlay image for the selected view (reduced field / label-hole / spectrum), or null
   * when the view is `none`/`camera` or no sample is available yet. Laboratory-only.
   */
  diagnosticImage(): { width: number; height: number; pixels: Uint8ClampedArray } | null;
}

export class Lab {
  private host: HTMLDivElement | null = null;
  private readout: { set(text: string): void } | null = null;
  private sliders = new Map<string, SliderHandle>();
  private regime: TextHandle | null = null;
  private tempo: TextHandle | null = null;
  /** §10 composition readouts, updated each frame while the panel is open. */
  private movementText: TextHandle | null = null;
  private trajectoryText: TextHandle | null = null;
  private chemistryText: TextHandle | null = null;
  private presentationText: TextHandle | null = null;
  private eventsText: TextHandle | null = null;
  /** §8 audio status/silence readout (updated each frame while the panel is open). */
  private audioText: TextHandle | null = null;
  /** §10 diagnostic overlay canvas (created with the panel, removed with it). */
  private overlayCanvas: HTMLCanvasElement | null = null;
  /** Transcription of the last import attempt, so a rejected import stays visible. */
  private importMessage = '';
  /** Monotonic counter feeding the genesis selector's per-click seeds (deterministic, not random). */
  private genesisClick = 0;
  private open = false;
  private genesisRadiusCells = 6;
  /** §10 guardrail: the live non-viable-parameter warning element (hidden when parameters look viable). */
  private viabilityText: TextHandle | null = null;
  /** §10 guardrail: whether the F/k sliders are clamped to `VIABLE_ENVELOPE` (false = wide open). */
  private allowDangerousValues = false;
  /** §10 guardrail occupancy-collapse tracking: has the field been alive, and for how long has it been dead. */
  private seenAlive = false;
  private deadSeconds = 0;
  private lastViabilitySeconds: number | null = null;

  constructor(private readonly api: LabApi) {}

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.openPanel();
  }

  openPanel(): void {
    if (this.open) return;
    const host = document.createElement('div');
    host.className = 'lab-host';
    host.dataset.role = 'laboratory';

    const heading = document.createElement('h2');
    heading.textContent = 'laboratory (~ to close)';
    host.appendChild(heading);
    createHelp(host, PANEL_HELP);

    // Danger-off is a safety state: never present or run a non-viable override. Project first, then
    // read the snapshot the sliders are built from, so the DOM, the native range, the readout and the
    // internal model all agree with the sanitized pair.
    this.sanitizeViableOverride();
    const snapshot = this.api.snapshot();

    // --- chemistry -------------------------------------------------------
    const chemistry = createSection(host, 'chemistry');
    const parameterKeys: (keyof Params)[] = ['F', 'k', 'Du', 'Dv'];
    for (const key of parameterKeys) {
      // §10 guardrail (item (c)): F/k sliders are clamped to the viable envelope unless the operator
      // opts into dangerous values. Du/Dv keep the plan's full envelope as before.
      const bounds =
        key === 'F'
          ? this.allowDangerousValues
            ? PARAM_ENVELOPE.F
            : VIABLE_ENVELOPE.F
          : key === 'k'
            ? this.allowDangerousValues
              ? PARAM_ENVELOPE.k
              : VIABLE_ENVELOPE.k
            : key === 'Du'
              ? PARAM_ENVELOPE.Du
              : PARAM_ENVELOPE.Dv;
      const handle = createSlider(chemistry, {
        label: `${key} — ${PARAM_INFO[key].title}`,
        min: key === 'F' || key === 'k' ? bounds[0] : 0.01,
        max: bounds[1],
        step: key === 'F' || key === 'k' ? 0.0001 : 0.001,
        value: snapshot.parameters[key],
        format: (value) => value.toFixed(4),
        testId: `lab-param-${key}`,
        onInput: () => this.emitParameterOverride(),
      });
      this.sliders.set(key, handle);
      createHelp(chemistry, PARAM_INFO[key].help);
    }
    createToggle(chemistry, 'allow dangerous values', this.allowDangerousValues, (value) => {
      this.allowDangerousValues = value;
      // Turning danger off is a safety action: sanitize the live override **now** (dispatch the
      // projected viable pair immediately) and then rebuild the panel so the sliders adopt the
      // sanitized values and the narrower ranges. With danger on nothing is projected.
      if (!value) this.sanitizeViableOverride();
      this.close();
      this.openPanel();
    });
    createHelp(
      chemistry,
      this.allowDangerousValues
        ? 'dangerous values allowed: the F/k sliders span the full plan envelope and can kill the field'
        : 'F/k are held inside the viable (F,k) set — a pair that would die is projected to the nearest ' +
          'viable k (e.g. .014/.045 → .014/.054); toggle to reach the full plan range',
    );
    this.regime = createText(chemistry, 'lab-regime');
    this.refreshRegime(snapshot.effectiveParameters);
    // Item (a): the live non-viable warning, and item (b): the one-click restore. Both are updated
    // while the panel is open (`update`) and immediately when a slider moves (`emitParameterOverride`).
    this.viabilityText = createText(chemistry, 'lab-warning');
    this.viabilityText.element.hidden = true;
    createButton(chemistry, 'restore viable defaults', () => this.restoreViableDefaults());
    createHelp(
      chemistry,
      'restore sets the calibrated viable parameters (F .03, k .062) and reseeds the field, so a ' +
        'field that has already died can grow back',
    );
    this.refreshViability(snapshot);
    createButton(chemistry, 'release parameters', () => {
      this.api.dispatch({ type: 'parameters', value: snapshot.parameters, mode: 'release' });
      const current = this.api.snapshot().parameters;
      for (const key of parameterKeys) this.sliders.get(key)?.setValue(current[key]);
    });

    // --- transport -------------------------------------------------------
    const transport = createSection(host, 'transport');
    const pauseButton = createButton(transport, `pause: ${snapshot.paused ? 'on' : 'off'}`, () => {
      const next = !this.api.snapshot().paused;
      pauseButton.textContent = `pause: ${next ? 'on' : 'off'}`;
      this.api.dispatch({ type: 'pause', value: next });
    });
    createSlider(transport, {
      label: 'speed',
      min: snapshot.speedRange[0],
      max: snapshot.speedRange[1],
      step: 0.05,
      value: snapshot.speed,
      format: (value) => `${value.toFixed(2)}x`,
      onInput: (value) => {
        this.api.dispatch({ type: 'speed', value });
        this.refreshTempo(value);
      },
    });
    createHelp(
      transport,
      `transport speed, clamped to ${snapshot.speedRange[0]}–${snapshot.speedRange[1]}x ` +
        `(measured ceiling ${snapshot.speedCeiling}× at this grid)`,
    );
    this.tempo = createText(transport, 'lab-tempo');
    this.refreshTempo(snapshot.speed);

    // --- audio (§8) ------------------------------------------------------
    const audio = createSection(host, 'audio');
    createToggle(audio, 'mute', snapshot.audio.muted, (value) => {
      this.api.dispatch({ type: 'mute', value });
    });
    createHelp(
      audio,
      'click the canvas or press Enter once to unlock audio; mute silences the master path ' +
        '(pause and a hidden tab mute too, and resume without a backlog)',
    );
    this.audioText = createText(audio, 'lab-audio');
    this.refreshAudio();

    // --- exploration (§10 bounded exploration mode) -----------------------
    const exploration = createSection(host, 'exploration mode');
    createToggle(exploration, 'exploration', snapshot.explorationActive, (value) => {
      this.api.dispatch({ type: 'exploration', value });
      // The grid changed, so every resolution-dependent bound and readout changed with it: rebuild
      // the panel rather than patching individual controls.
      this.close();
      this.openPanel();
    });
    createText(
      exploration,
      'lab-resolution',
      `active grid: ${snapshot.simulationResolution}² · measured ceiling ${snapshot.speedCeiling}× at 60 fps`,
    );
    createHelp(
      exploration,
      `toggling restarts the organism at ${EXPLORATION_GRID.width}² (and again at 768² when switched off)`,
    );
    createHelp(
      exploration,
      `${EXPLORATION_GRID.width}²: fewer, larger cells; calibration differs from the 768² presentation`,
    );
    createHelp(exploration, 'for finding regimes, not for viewing the final piece');
    createButton(transport, 'restart (new seed)', () => this.api.restart());
    createButton(transport, 'reseed here', () => this.api.reseed(this.genesisRadiusCells));

    // --- genesis ---------------------------------------------------------
    const genesis = createSection(host, 'genesis');
    createSlider(genesis, {
      label: 'radius',
      min: 2,
      max: 40,
      step: 1,
      value: snapshot.genesisRadiusCells,
      format: (value) => `${value.toFixed(0)} cells`,
      onInput: (value) => {
        this.genesisRadiusCells = value;
      },
    });

    // --- composition (§10/§12.2) -----------------------------------------
    const composition = createSection(host, 'composition');
    this.movementText = createText(composition, 'lab-movement');
    createButton(composition, 'skip movement', () => {
      this.api.dispatch({ type: 'skip-movement' });
    });
    createButton(composition, 'restart arc', () => {
      this.api.dispatch({ type: 'restart' });
    });
    createHelp(
      composition,
      'skip advances the curator to its next movement (15 s crossfade; the chemistry keeps running, ' +
        'so the field is not reset); restart begins a fresh arc from a new root seed',
    );

    // Genesis selector: all seven §4.4 kinds, each a complete lab-chosen command at strength 1,
    // dispatched through the ordinary `reseed` surface.
    const kinds: readonly GenesisKind[] = [
      'single',
      'competing',
      'line',
      'ring',
      'sparse',
      'radial',
      'structured',
    ];
    const genesisRow = document.createElement('div');
    genesisRow.className = 'lab-row';
    for (const kind of kinds) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = kind;
      button.dataset.role = 'lab-control';
      button.dataset.genesisKind = kind;
      button.addEventListener('click', () => this.applyGenesisKind(kind));
      genesisRow.appendChild(button);
    }
    composition.appendChild(genesisRow);
    createHelp(
      composition,
      '§4.4 genesis kinds — geometry is drawn by genesis-geometry.ts from the command seed at strength 1',
    );

    // Trajectory import/export (§12.2). Import validates with `parseTrajectoryDocument` (the text is
    // never evaluated); a rejection is shown in the trajectory line and leaves the piece running.
    this.trajectoryText = createText(composition, 'lab-trajectory');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.dataset.role = 'lab-control';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then((text) => this.applyImport(text));
    });
    const textarea = document.createElement('textarea');
    textarea.dataset.role = 'lab-control';
    textarea.className = 'lab-trajectory-input';
    textarea.placeholder = 'paste a trajectory document (JSON)';
    const importRow = document.createElement('div');
    importRow.className = 'lab-row';
    importRow.append(fileInput, textarea);
    composition.appendChild(importRow);
    createButton(composition, 'import (validated JSON)', () => this.applyImport(textarea.value));
    createButton(composition, 'export document', () => this.exportDocument());
    createHelp(
      composition,
      'import replaces the active composition via the §6.4 crossfade without touching the field or the ' +
        'epoch; export downloads the active document as JSON',
    );

    // Chemistry health (§7.1 tier-1): the full-domain occupied fraction, reaction activity and change
    // rate the director and the curator consume, with the sample validity and age.
    this.chemistryText = createText(composition, 'lab-chem');

    // Presentation tier (§7.1 tier-2): the envelope-weighted descriptors, β0/β1, spectral bands,
    // coherence and the recognized event log.
    this.presentationText = createText(composition, 'lab-presentation');
    this.eventsText = createText(composition, 'lab-events');

    // --- diagnostics -----------------------------------------------------
    const views = createSection(host, 'diagnostics view');
    for (const view of ['none', 'analysis', 'topology', 'spectrum', 'camera'] as const) {
      createButton(views, view, () => this.api.dispatch({ type: 'diagnostics', view }));
    }
    const overlay = document.createElement('canvas');
    overlay.className = 'lab-overlay';
    overlay.dataset.role = 'lab-control';
    overlay.width = 256;
    overlay.height = 256;
    views.appendChild(overlay);
    this.overlayCanvas = overlay;
    createHelp(views, 'overlays: analysis = reduced field, topology = label/hole proxy, spectrum = band energies');

    // --- capture ---------------------------------------------------------
    const capture = createSection(host, 'capture');
    createCaptureControls(capture, {
      screenshot: () => this.api.capture(),
      startRecording: () => this.api.startRecording(),
      stopRecording: () => this.api.stopRecording(),
      recordingSupport: () => this.api.recordingInfo(),
      stateSnapshot: () => JSON.stringify(this.api.snapshot(), null, 2),
      mimeForCapture: () => this.api.mimeForCapture(),
    });

    // --- readout ---------------------------------------------------------
    const readoutSection = createSection(host, 'status');
    this.readout = createReadout(readoutSection);

    document.body.appendChild(host);
    this.host = host;
    this.open = true;
    this.refreshReadout();
  }

  close(): void {
    if (!this.open) return;
    this.host?.remove();
    this.host = null;
    this.readout = null;
    this.regime = null;
    this.tempo = null;
    this.movementText = null;
    this.trajectoryText = null;
    this.chemistryText = null;
    this.presentationText = null;
    this.eventsText = null;
    this.audioText = null;
    this.overlayCanvas = null;
    this.viabilityText = null;
    this.sliders.clear();
    this.open = false;
  }

  update(world: WorldState, diagnostics: Diagnostics): void {
    if (!this.open) return;
    this.refreshRegime(world.parameters);
    this.refreshViability(this.api.snapshot());
    this.refreshTempo(world.clock.speed, diagnostics.simStepsPerSecond);
    this.refreshComposition();
    this.refreshOverlay();
    this.refreshReadout(diagnostics);
  }

  /** §10 draw the selected diagnostic overlay image into the panel canvas. */
  private refreshOverlay(): void {
    const canvas = this.overlayCanvas;
    if (!canvas) return;
    const image = this.api.diagnosticImage();
    if (!image) {
      canvas.hidden = true;
      return;
    }
    canvas.hidden = false;
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const imageData = context.createImageData(image.width, image.height);
    imageData.data.set(image.pixels);
    context.putImageData(imageData, 0, 0);
  }

  /**
   * §10 genesis selector: build a complete lab-chosen command for one §4.4 kind (geometry from
   * `genesis-geometry.ts`, strength 1) and dispatch it through the ordinary `reseed` surface. The seed
   * mixes the session root seed with a per-click counter, so each click reseeds a different pattern
   * without drawing from the app's own RNG stream.
   */
  private applyGenesisKind(kind: GenesisKind): void {
    const snapshot = this.api.snapshot();
    this.genesisClick += 1;
    const seed = (Math.imul(this.genesisClick, 0x9e3779b9) + snapshot.seed) >>> 0;
    const command = createLabGenesisCommand(kind, {
      seed,
      center: [0.5, 0.5],
      gridWidth: snapshot.simulationResolution,
      gridHeight: snapshot.simulationResolution,
      mode: 'replace',
    });
    this.api.dispatch({ type: 'reseed', genesis: command });
  }

  /** §10 trajectory import: validate the text (never evaluated) and report the outcome in the status. */
  private applyImport(text: string): void {
    if (text.trim().length === 0) {
      this.importMessage = 'import failed: no document supplied';
    } else {
      const result = this.api.importTrajectory(text);
      this.importMessage = result.ok ? 'import ok' : `import failed: ${result.reason ?? 'unknown error'}`;
    }
    this.refreshComposition();
  }

  /** §10 trajectory export: download the active document as JSON. */
  private exportDocument(): void {
    const text = this.api.exportTrajectoryText();
    const snapshot = this.api.snapshot();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trajectory-${snapshot.trajectory.id}.json`;
    // Attach only for the click, then remove: the host must contain no more than its own controls,
    // and nothing may survive `close()` (AC.15).
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke after the download has had a chance to start, so the anchor's target is not pulled out
    // from under the browser's own download handling.
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.importMessage = `exported ${text.length} bytes`;
    this.refreshComposition();
  }

  /** Refresh the composition readouts from the live snapshot (movement/arc, trajectory, chemistry). */
  private refreshComposition(): void {
    const snapshot = this.api.snapshot();
    this.refreshAudio();
    const phase = snapshot.phase;
    this.movementText?.set(
      `movement ${phase.movement} · arc ${phase.arc} · progress ${(phase.progress * 100).toFixed(1)}% · ` +
        `elapsed ${phase.elapsedSeconds.toFixed(1)}s · intention ${phase.intention} · stillness ${phase.stillnessState}`,
    );
    const trajectory = snapshot.trajectory;
    this.trajectoryText?.set(
      `trajectory ${trajectory.source}${trajectory.error ? ` — ${trajectory.error}` : ''} · id ${trajectory.id} · ` +
        `${trajectory.movements.length} movements${this.importMessage ? ` · ${this.importMessage}` : ''}`,
    );
    const health = snapshot.chemistryHealth;
    this.chemistryText?.set(
      `chemistry occupied ${health.fullOccupiedFraction.toFixed(4)} · activity ` +
        `${health.fullReactionActivity.toFixed(6)} · change ${health.fullChangeRate.toFixed(6)} · ` +
        `${health.valid ? `valid · age ${health.ageSeconds.toFixed(1)}s` : 'invalid'}`,
    );
    const presentation = snapshot.presentation;
    if (presentation.valid) {
      const bands = presentation.spectralBands.map((value) => value.toFixed(2)).join('/');
      this.presentationText?.set(
        `presentation occ ${presentation.occupiedFraction.toFixed(3)} · β0 ${presentation.beta0Approx} · ` +
          `β1 ${presentation.beta1Approx} · bands ${bands} · feature ${presentation.featureScaleUV.toFixed(3)} · ` +
          `coherence ${presentation.coherence.toFixed(2)} · orientation ${((presentation.orientationRadians * 180) / Math.PI).toFixed(0)}° · ` +
          `symmetry ${presentation.symmetry.toFixed(2)} · conf ${presentation.topologyConfidence.toFixed(2)} · ` +
          `age ${presentation.ageSeconds.toFixed(1)}s`,
      );
    } else {
      this.presentationText?.set('presentation invalid (no tier-2 sample yet)');
    }
    const event = snapshot.event;
    const recent = snapshot.eventLog.slice(-4).map((entry) => `${entry.kind}@${entry.atPerformanceSeconds.toFixed(0)}s`);
    this.eventsText?.set(
      `event serial ${event.serial} · latest ${event.kind}${event.kind === 'none' ? '' : ` (${event.strength.toFixed(2)})`}` +
        `${recent.length > 0 ? ` · log ${recent.join(', ')}` : ''}`,
    );
  }

  dispose(): void {
    this.close();
  }

  /** §8 audio readout: truthful context status plus the live silence acknowledgement. */
  private refreshAudio(): void {
    if (!this.audioText) return;
    const engine = this.api.snapshot().audio;
    const silence = engine.silence;
    this.audioText.set(
      `status ${engine.status} · ${engine.muted ? 'muted' : 'unmuted'} · ` +
        `silence ${silence.satisfied ? 'satisfied' : 'live'}` +
        (silence.terminalZeroAt !== null ? ` @ ${silence.terminalZeroAt.toFixed(1)}s` : ''),
    );
  }

  private emitParameterOverride(): void {
    const base = this.api.snapshot().parameters;
    const proposed: Params = {
      F: this.sliders.get('F')?.value ?? base.F,
      k: this.sliders.get('k')?.value ?? base.k,
      Du: this.sliders.get('Du')?.value ?? base.Du,
      Dv: this.sliders.get('Dv')?.value ?? base.Dv,
    };
    // Danger-off: project the proposed pair onto the evidence-backed viable set *before* dispatching,
    // then write the projected values back to the sliders so the model, the readout and the native
    // range can never disagree (review fix MAJOR). With danger on the proposal is used as-is.
    const value = this.allowDangerousValues ? proposed : projectViableParameters(proposed);
    this.api.dispatch({ type: 'parameters', value, mode: 'override' });
    if (!this.allowDangerousValues && (value.F !== proposed.F || value.k !== proposed.k)) {
      this.syncSliderValues(value);
    }
    this.refreshRegime(this.api.snapshot().effectiveParameters);
    this.refreshViability(this.api.snapshot());
  }

  /** Write a parameter set back to the four sliders (DOM + native range + internal model together). */
  private syncSliderValues(params: Params): void {
    for (const key of ['F', 'k', 'Du', 'Dv'] as const) this.sliders.get(key)?.setValue(params[key]);
  }

  /**
   * Danger-off sanitize (review fix MAJOR): if the live override pair is not viable, dispatch the
   * projected viable pair immediately — the "reject/project every proposed pair" rule applied to
   * whatever is currently in force. Idempotent, and a no-op while dangerous values are allowed.
   */
  private sanitizeViableOverride(): void {
    if (this.allowDangerousValues) return;
    const current = this.api.snapshot().effectiveParameters;
    const safe = projectViableParameters(current);
    if (safe.F !== current.F || safe.k !== current.k || safe.Du !== current.Du || safe.Dv !== current.Dv) {
      this.api.dispatch({ type: 'parameters', value: safe, mode: 'override' });
      this.refreshRegime(safe);
    }
  }

  /** The approximate morphology the current (F,k) is expected to produce (§10 regime readout). */
  private refreshRegime(params: Params): void {
    this.regime?.set(`approximate regime: ${formatRegime(describeRegime(params))}`);
  }

  /**
   * §10 Phase-4 guardrail: show/hide the live non-viable warning.
   *
   * Fires when the *effective* parameters map to `dying`/`nonviable` via `describeRegime` (the
   * deterministic misconfiguration the operator's caveat is about), or when a field that has been
   * alive has been measurably collapsed for a sustained interval **outside** a dormancy/quiet
   * movement (so an intentional rebirth dwell is never flagged). The two conditions share one
   * actionable suggestion — the calibrated viable band.
   */
  private refreshViability(snapshot: LabSnapshot): void {
    const element = this.viabilityText?.element;
    const health = snapshot.chemistryHealth;
    const phase = snapshot.phase;

    // Occupancy-collapse tracking, paced by delivered performance time (bounded so a resumption
    // cannot accumulate a burst).
    const previous = this.lastViabilitySeconds;
    const at = snapshot.performanceSeconds;
    const dt = previous === null || at < previous ? 0 : at - previous;
    this.lastViabilitySeconds = at;
    if (at < (previous ?? 0)) this.deadSeconds = 0;
    if (health.valid && health.fullOccupiedFraction >= VIABLE_ALIVE_OCCUPANCY) this.seenAlive = true;
    const living =
      phase.intention !== 'quiet' &&
      phase.stillnessState === 'none' &&
      !COLLAPSE_EXEMPT_MOVEMENTS.has(phase.movement);
    const collapsedNow =
      this.seenAlive && health.valid && health.fullOccupiedFraction <= COLLAPSE_OCCUPANCY && living;
    this.deadSeconds = collapsedNow ? this.deadSeconds + dt : 0;

    const description = describeRegime(snapshot.effectiveParameters);
    const nonviable = description.nonviable || description.regime === 'dying';
    const message = nonviable ? VIABLE_PARAMS_WARNING : this.deadSeconds >= COLLAPSE_SECONDS ? COLLAPSED_WARNING : null;

    if (!element) return;
    if (message === null) {
      if (!element.hidden) {
        element.hidden = true;
        element.textContent = '';
      }
    } else {
      element.hidden = false;
      if (element.textContent !== message) element.textContent = message;
    }
  }

  /**
   * §10 Phase-4 guardrail (item (b)): one-click recovery. Dispatching the calibrated default
   * parameters is only half of it — a field that has already died has no V left to grow back from, so
   * the field is also reseeded at the recorded seed. The sliders are snapped to the restored values
   * so the panel and the running chemistry agree.
   */
  private restoreViableDefaults(): void {
    const value: Params = { ...DEFAULT_PARAMS };
    this.api.dispatch({ type: 'parameters', value, mode: 'override' });
    this.api.reseed(this.genesisRadiusCells);
    this.syncSliderValues(value);
    this.refreshRegime(value);
    this.refreshViability(this.api.snapshot());
  }

  /**
   * "sim tempo: …" — the delivered multiple comes from measured delivered steps/s (see
   * `formatSimTempo`), so a capped run shows the requested and delivered speeds side by side, and a
   * run whose delivery window has not populated yet says so instead of guessing.
   */
  private refreshTempo(speed: number, deliveredStepsPerSecond?: number): void {
    this.tempo?.set(
      formatSimTempo({
        speed,
        deliveredStepsPerSecond,
        nominalStepsPerSecond: TIME.nominalStepsPerSecond,
      }),
    );
  }

  private refreshReadout(diagnostics?: Diagnostics): void {
    if (!this.readout) return;
    const snapshot = this.api.snapshot();
    const extra: Record<string, string> = {
      seed: String(snapshot.seed),
      autoseed: snapshot.autoSeed ? 'on' : 'off',
      epoch: String(snapshot.epoch),
      steps: String(snapshot.steps),
      simtime: snapshot.simulationTime.toFixed(1),
      perftime: `${snapshot.performanceSeconds.toFixed(1)}s`,
      scene: snapshot.scene,
      regime: `${formatRegime(describeRegime(snapshot.effectiveParameters))}`,
      grid: `${snapshot.simulationResolution}²${snapshot.explorationActive ? ' (exploration)' : ''}`,
      ceiling: `${snapshot.speedCeiling}× at 60 fps (range ${snapshot.speedRange[0]}–${snapshot.speedRange[1]}x)`,
      tempo: formatSimTempo({
        speed: snapshot.speed,
        deliveredStepsPerSecond: diagnostics?.simStepsPerSecond,
        nominalStepsPerSecond: TIME.nominalStepsPerSecond,
      }),
      params: `F=${snapshot.effectiveParameters.F.toFixed(4)} k=${snapshot.effectiveParameters.k.toFixed(4)} ` +
        `Du=${snapshot.effectiveParameters.Du.toFixed(3)} Dv=${snapshot.effectiveParameters.Dv.toFixed(3)}` +
        (snapshot.overrideActive ? ' (override)' : ''),
      activation: snapshot.activation,
      movement: `${snapshot.phase.movement} (arc ${snapshot.phase.arc})`,
      progress: `${(snapshot.phase.progress * 100).toFixed(1)}% ${snapshot.phase.elapsedSeconds.toFixed(1)}s ` +
        `${snapshot.phase.intention}/${snapshot.phase.stillnessState}`,
      trajectory: `${snapshot.trajectory.source}` +
        (snapshot.trajectory.error ? ` — ${snapshot.trajectory.error}` : ''),
      trid: `${snapshot.trajectory.id} (${snapshot.trajectory.movements.length} movements)`,
      chem: `occ ${snapshot.chemistryHealth.fullOccupiedFraction.toFixed(4)} ` +
        `act ${snapshot.chemistryHealth.fullReactionActivity.toFixed(6)} ` +
        `chg ${snapshot.chemistryHealth.fullChangeRate.toFixed(6)} ` +
        (snapshot.chemistryHealth.valid ? `valid age ${snapshot.chemistryHealth.ageSeconds.toFixed(1)}s` : 'invalid'),
      present: snapshot.presentation.valid
        ? `occ ${snapshot.presentation.occupiedFraction.toFixed(3)} β0 ${snapshot.presentation.beta0Approx} ` +
          `β1 ${snapshot.presentation.beta1Approx} coh ${snapshot.presentation.coherence.toFixed(2)} ` +
          `conf ${snapshot.presentation.topologyConfidence.toFixed(2)} age ${snapshot.presentation.ageSeconds.toFixed(1)}s`
        : 'invalid',
      event: `serial ${snapshot.event.serial} ${snapshot.event.kind}` +
        (snapshot.event.kind === 'none' ? '' : ` (${snapshot.event.strength.toFixed(2)})`),
      audio: `${snapshot.audio.status}${snapshot.audio.muted ? ' muted' : ''} · silence ` +
        `${snapshot.audio.silence.satisfied ? 'satisfied' : 'live'}` +
        (snapshot.audio.silence.terminalZeroAt !== null
          ? ` @ ${snapshot.audio.silence.terminalZeroAt.toFixed(1)}s`
          : ''),
    };
    if (diagnostics) {
      this.readout.set(formatDiagnostics(diagnostics, snapshot.resourceCounts, extra));
    } else {
      this.readout.set(
        Object.entries(extra)
          .map(([key, value]) => `${key.padEnd(10)} ${value}`)
          .join('\n'),
      );
    }
  }
}
