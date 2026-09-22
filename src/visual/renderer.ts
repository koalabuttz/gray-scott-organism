/**
 * §5.1 pass order and §5.3/§5.4 rendering.
 *
 *   simulation A/B (RG32F)
 *     -> field extraction (RGBA16F)
 *     -> separable blur H/V (RGBA16F ping-pong)
 *     -> surface field: height, boundary, support, activity (RGBA16F)
 *     -> normals (RGBA16F)
 *     -> material scene (RGBA16F + DEPTH_COMPONENT24 renderbuffer)
 *     -> bloom downsample chain (1/2, 1/4, 1/8) + upsample chain (additive, soft-knee)
 *     -> composite (default framebuffer: ACES fit + explicit linear-to-sRGB)
 *
 * Deliberately separate passes with single colour attachments rather than MRT: fewer mixed
 * format assumptions, and the plan says not to fuse until a measured bottleneck appears.
 *
 * The internal HDR scene is capped at a 1920x1080-equivalent pixel count (§11.1); the display
 * canvas may be larger. Simulation resolution is independent of both.
 */
import { BLOOM, COMPOSITE, ENVELOPE, MATERIAL, REFINEMENT, SCENE, SURFACE } from '../config.ts';
import type { FieldView, WorldState } from '../core/types.ts';
import { FULLSCREEN_VERTEX_SHADER, FullscreenQuad } from '../gpu/fullscreen.ts';
import { Program, ResourceTracker, createColorTarget, deleteColorTarget } from '../gpu/resources.ts';
import type { ColorTarget } from '../gpu/resources.ts';
import { readCompositeRGBA8, readColorTargetRGBA } from '../gpu/readback.ts';
import { computeCameraView } from './camera.ts';
import { lightDirection } from './lighting.ts';
import { canvasToBlob } from './capture.ts';

import fieldSource from './shaders/field.frag?raw';
import blurSource from './shaders/blur.frag?raw';
import surfaceSource from './shaders/surface.frag?raw';
import normalsSource from './shaders/normals.frag?raw';
import materialSource from './shaders/material.frag?raw';
import bloomDownSource from './shaders/bloom-down.frag?raw';
import bloomUpSource from './shaders/bloom-up.frag?raw';
import compositeSource from './shaders/composite.frag?raw';
import sheetVertexSource from './shaders/surface.vert?raw';

export interface RendererOptions {
  gl: WebGL2RenderingContext;
  tracker: ResourceTracker;
  canvas: HTMLCanvasElement;
  simulationWidth: number;
  simulationHeight: number;
  width: number;
  height: number;
}

export interface FrameStats {
  renderMs: number;
  sceneWidth: number;
  sceneHeight: number;
  drawCalls: number;
}

/**
 * §12.4-B refinement state (config `REFINEMENT`).
 *
 * Held on the renderer rather than in `WorldState` because it is a *material calibration* the
 * director never drives (exactly like the material constants), and the laboratory/hook override
 * exists so a before/after capture can attribute one change at a time. Every field maps 1:1 to a
 * `REFINEMENT` entry and each is a no-op when zero.
 */
export interface RefinementState {
  interiorDarkening: number;
  absorptionChroma: number;
  chromaGateLow: number;
  chromaGateHigh: number;
  roughnessVariation: number;
  /** Round-2 #1: normalized thickness remap for the height (0 = round-B saturating remap). */
  heightThicknessRef: number;
  heightThicknessPower: number;
  /** Round-2 #3: frontier-band emphasis and its thinness gate. */
  frontBoost: number;
  frontThinGate: number;
  /** Round-2 #4: extra gloss on thin material. */
  glossThin: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly stats: FrameStats = { renderMs: 0, sceneWidth: 0, sceneHeight: 0, drawCalls: 0 };

  private readonly tracker: ResourceTracker;
  private readonly canvas: HTMLCanvasElement;
  private simulationWidth: number;
  private simulationHeight: number;

  private readonly extractProgram: Program;
  private readonly blurProgram: Program;
  private readonly surfaceProgram: Program;
  private readonly normalsProgram: Program;
  private readonly materialProgram: Program;
  private readonly bloomDownProgram: Program;
  private readonly bloomUpProgram: Program;
  private readonly compositeProgram: Program;
  private readonly quad: FullscreenQuad;

  private extractTarget!: ColorTarget;
  private blurTargets!: [ColorTarget, ColorTarget];
  private surfaceTarget!: ColorTarget;
  private normalsTarget!: ColorTarget;

  private sceneTarget: ColorTarget | null = null;
  private bloomDownTargets: ColorTarget[] = [];
  private bloomUpTargets: ColorTarget[] = [];

  private sheetVao: WebGLVertexArrayObject | null = null;
  private sheetVbo: WebGLBuffer | null = null;
  private sheetIbo: WebGLBuffer | null = null;
  private sheetIndexCount = 0;

  private canvasWidth = 0;
  private canvasHeight = 0;
  private sceneWidth = 0;
  private sceneHeight = 0;
  private lastField: { current: FieldView; previous: FieldView } | null = null;
  private lastWorld: WorldState | null = null;
  private syncScratch: Uint8Array | null = null;
  /** Tone-map inputs mirrored from the published material state (config only seeds them). */
  private toneState: { exposure: number; bloomGain: number } = {
    exposure: COMPOSITE.exposure,
    bloomGain: BLOOM.gain,
  };
  /** §12.4-B refinement knobs; defaults from config, overridable for before/after measurement. */
  private refinement: RefinementState = { ...REFINEMENT };
  /**
   * §12.4-B #3: the bloom threshold/knee. Seeded from config `BLOOM` and overridable because the
   * working point had to be *measured* — at the §5.4 threshold of 1.0 the overhead scene (p99 ≈ 0.11
   * linear, max ≈ 1.3) seeds almost no bloom, so the gain alone could never make it perceptible.
   */
  private bloomParams: { threshold: number; knee: number; kneePerTap: boolean } = {
    threshold: BLOOM.threshold,
    knee: BLOOM.knee,
    kneePerTap: true,
  };
  private disposed = false;

  constructor(options: RendererOptions) {
    const { gl, tracker, canvas, simulationWidth, simulationHeight } = options;
    this.gl = gl;
    this.tracker = tracker;
    this.canvas = canvas;
    this.simulationWidth = simulationWidth;
    this.simulationHeight = simulationHeight;

    this.quad = new FullscreenQuad(gl, tracker);
    this.extractProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, fieldSource, 'visual.field', tracker);
    this.blurProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, blurSource, 'visual.blur', tracker);
    this.surfaceProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, surfaceSource, 'visual.surface', tracker);
    this.normalsProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, normalsSource, 'visual.normals', tracker);
    this.materialProgram = new Program(gl, sheetVertexSource, materialSource, 'visual.material', tracker);
    this.bloomDownProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, bloomDownSource, 'visual.bloom-down', tracker);
    this.bloomUpProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, bloomUpSource, 'visual.bloom-up', tracker);
    this.compositeProgram = new Program(gl, FULLSCREEN_VERTEX_SHADER, compositeSource, 'visual.composite', tracker);

    this.createSimulationTargets();
    this.setupSheet(this.materialProgram);
    this.resize(options.width, options.height);
  }

  /**
   * §10: the simulation-sized intermediates (field extraction, blur pair, surface, normals) follow
   * the *simulation* grid, so a resolution change releases and recreates exactly those. Programs,
   * canvas-sized scene/bloom targets and the sheet geometry are untouched.
   */
  private createSimulationTargets(): void {
    const gl = this.gl;
    const sim = (filter: number): ColorTarget =>
      createColorTarget(
        gl,
        this.tracker,
        this.simulationWidth,
        this.simulationHeight,
        gl.RGBA16F,
        gl.RGBA,
        gl.HALF_FLOAT,
        filter,
        false,
      );
    this.extractTarget = sim(gl.NEAREST);
    this.blurTargets = [sim(gl.NEAREST), sim(gl.NEAREST)];
    this.surfaceTarget = sim(gl.NEAREST);
    this.normalsTarget = sim(gl.NEAREST);
  }

  private releaseSimulationTargets(): void {
    deleteColorTarget(this.gl, this.tracker, this.extractTarget);
    deleteColorTarget(this.gl, this.tracker, this.blurTargets[0]);
    deleteColorTarget(this.gl, this.tracker, this.blurTargets[1]);
    deleteColorTarget(this.gl, this.tracker, this.surfaceTarget);
    deleteColorTarget(this.gl, this.tracker, this.normalsTarget);
  }

  /** Retarget the derived-field intermediates at a new simulation grid (§10 exploration mode). */
  setSimulationSize(width: number, height: number): void {
    if (width === this.simulationWidth && height === this.simulationHeight) return;
    this.releaseSimulationTargets();
    this.simulationWidth = Math.max(2, Math.floor(width));
    this.simulationHeight = Math.max(2, Math.floor(height));
    this.createSimulationTargets();
  }

  /** §11.1: cap the internal scene at a 1920x1080-equivalent pixel count. */
  resize(width: number, height: number): void {
    const safeWidth = Math.max(2, Math.floor(width));
    const safeHeight = Math.max(2, Math.floor(height));
    if (safeWidth === this.canvasWidth && safeHeight === this.canvasHeight && this.sceneTarget) return;

    this.canvasWidth = safeWidth;
    this.canvasHeight = safeHeight;

    const requested = safeWidth * safeHeight;
    const scale = Math.min(SCENE.maxScale, Math.sqrt(SCENE.pixelBudget / requested));
    this.sceneWidth = Math.max(2, Math.floor(safeWidth * scale));
    this.sceneHeight = Math.max(2, Math.floor(safeHeight * scale));

    this.releaseSceneTargets();

    this.sceneTarget = createColorTarget(
      this.gl,
      this.tracker,
      this.sceneWidth,
      this.sceneHeight,
      this.gl.RGBA16F,
      this.gl.RGBA,
      this.gl.HALF_FLOAT,
      this.gl.LINEAR,
      true,
    );

    this.bloomDownTargets = [];
    this.bloomUpTargets = [];
    for (let level = 0; level < BLOOM.levels; level += 1) {
      const [w, h] = this.bloomSize(level);
      const make = (): ColorTarget =>
        createColorTarget(this.gl, this.tracker, w, h, this.gl.RGBA16F, this.gl.RGBA, this.gl.HALF_FLOAT, this.gl.LINEAR, false);
      this.bloomDownTargets.push(make());
      this.bloomUpTargets.push(make());
    }

    this.stats.sceneWidth = this.sceneWidth;
    this.stats.sceneHeight = this.sceneHeight;
  }

  get sceneDimensions(): { width: number; height: number } {
    return { width: this.sceneWidth, height: this.sceneHeight };
  }

  /**
   * §10: the dimensions of the simulation-sized derived-field targets. Read from the live GL target
   * rather than from the stored numbers, so a resolution switch that failed to re-create them is
   * visible instead of merely reported.
   */
  get simulationDimensions(): { width: number; height: number } {
    return { width: this.extractTarget.width, height: this.extractTarget.height };
  }

  /** Render one frame: derived fields, material scene, bloom, composite. */
  render(field: { current: FieldView; previous: FieldView }, world: WorldState): void {
    const started = performance.now();
    const gl = this.gl;
    this.lastField = field;
    this.lastWorld = world;
    // The published snapshot is authoritative for composition: exposure and bloom gain come from
    // `world.material`, never from the config constants that only provide initial values.
    this.toneState = { exposure: world.material.exposure, bloomGain: world.material.bloomGain };
    let drawCalls = 0;

    const w = this.simulationWidth;
    const h = this.simulationHeight;

    // 1. field extraction
    this.extractProgram.use();
    this.extractProgram.u2i('uGrid', w, h);
    this.extractProgram.u1f('uChangeSaturation', SURFACE.changeSaturation);
    this.extractProgram.u1f('uBoundarySaturation', SURFACE.boundarySaturation);
    this.extractProgram.u1f('uSupportLow', SURFACE.supportVLow);
    this.extractProgram.u1f('uSupportHigh', SURFACE.supportVHigh);
    this.extractProgram.texture('uField', 0, field.current.texture);
    this.extractProgram.texture('uPrevious', 1, field.previous.texture);
    this.bindAndClear(this.extractTarget, false);
    this.quad.draw();
    drawCalls += 1;

    // 2. separable blur (horizontal then vertical)
    this.blurProgram.use();
    this.blurProgram.u2i('uGrid', w, h);
    this.blurProgram.u2i('uDirection', 1, 0);
    this.blurProgram.texture('uSource', 0, this.extractTarget.texture);
    this.bindAndClear(this.blurTargets[0], false);
    this.quad.draw();
    drawCalls += 1;

    this.blurProgram.u2i('uDirection', 0, 1);
    this.blurProgram.texture('uSource', 0, this.blurTargets[0].texture);
    this.bindAndClear(this.blurTargets[1], false);
    this.quad.draw();
    drawCalls += 1;

    // 3. surface field (height, boundary, support, activity)
    this.surfaceProgram.use();
    this.surfaceProgram.u2i('uGrid', w, h);
    this.surfaceProgram.u1f('uReliefAmplitude', world.material.relief);
    this.surfaceProgram.u1f('uSmoothedVWeight', SURFACE.smoothedVWeight);
    this.surfaceProgram.u1f('uBoundaryWeight', SURFACE.boundaryWeight);
    this.surfaceProgram.u1f('uSoftenedVScale', SURFACE.softenedVScale);
    this.surfaceProgram.u1f('uThicknessRef', this.refinement.heightThicknessRef);
    this.surfaceProgram.u1f('uThicknessPower', this.refinement.heightThicknessPower);
    this.surfaceProgram.u1f('uDv', world.parameters.Dv);
    this.surfaceProgram.u1f('uF', world.parameters.F);
    this.surfaceProgram.u1f('uK', world.parameters.k);
    this.surfaceProgram.u1f('uResidualScale', 0.02);
    this.surfaceProgram.texture('uSmoothed', 0, this.blurTargets[1].texture);
    this.surfaceProgram.texture('uField', 1, field.current.texture);
    this.bindAndClear(this.surfaceTarget, false);
    this.quad.draw();
    drawCalls += 1;

    // 4. normals from the height field
    this.normalsProgram.use();
    this.normalsProgram.u2i('uGrid', w, h);
    this.normalsProgram.u1f('uTexelWorld', SURFACE.domainWidth / w);
    this.normalsProgram.texture('uSurface', 0, this.surfaceTarget.texture);
    this.bindAndClear(this.normalsTarget, false);
    this.quad.draw();
    drawCalls += 1;

    // 5. material scene into the HDR target with depth
    const scene = this.sceneTarget!;
    const aspect = this.sceneWidth / this.sceneHeight;
    const cameraView = computeCameraView(world.camera, aspect);
    const direction = lightDirection(world.light);

    this.materialProgram.use();
    this.materialProgram.u3f('uCameraPosition', cameraView.position[0], cameraView.position[1], cameraView.position[2]);
    this.materialProgram.u3f('uLightDirection', direction[0], direction[1], direction[2]);
    this.materialProgram.u3f('uLightColor', world.light.colorLinear[0], world.light.colorLinear[1], world.light.colorLinear[2]);
    this.materialProgram.u3f('uSpecularTint', MATERIAL.specularTintLinear[0], MATERIAL.specularTintLinear[1], MATERIAL.specularTintLinear[2]);
    this.materialProgram.u3f('uEmissionTint', world.material.emissionTintLinear[0], world.material.emissionTintLinear[1], world.material.emissionTintLinear[2]);
    this.materialProgram.u1f('uLightIntensity', world.light.intensity);
    this.materialProgram.u1f('uEnvironment', world.light.environment);
    this.materialProgram.u1f('uEmissionGain', world.light.emissionGain);
    this.materialProgram.u1f('uRoughness', world.material.roughness);
    this.materialProgram.u1f('uF0', MATERIAL.f0);
    this.materialProgram.u1f('uDiffuseAlbedo', MATERIAL.diffuseAlbedo);
    this.materialProgram.u1f('uEnvelopeFullStrengthRadius', ENVELOPE.fullStrengthRadius);
    this.materialProgram.texture('uNormals', 0, this.normalsTarget.texture);
    this.materialProgram.texture('uSurface', 1, this.surfaceTarget.texture);
    this.materialProgram.mat4('uViewProjection', cameraView.viewProjection);
    this.materialProgram.u2f('uDomainWidth', SURFACE.domainWidth, SURFACE.domainWidth);
    this.materialProgram.u2f('uHeightGrid', w, h);
    // The sheet displaces by the same height field the normals come from; unit 2 keeps the
    // height fetch independent of the fragment-stage normal/surface samplers.
    this.materialProgram.texture('uHeight', 2, this.surfaceTarget.texture);
    // §12.4-B: the blurred extraction supplies the support *thickness* (x) and the boundary
    // magnitude (z) that drive absorption and roughness variation.
    this.materialProgram.u1f('uThicknessScale', SURFACE.softenedVScale);
    this.materialProgram.u1f('uInteriorDarkening', this.refinement.interiorDarkening);
    this.materialProgram.u1f('uAbsorptionChroma', this.refinement.absorptionChroma);
    this.materialProgram.u2f('uChromaGate', this.refinement.chromaGateLow, this.refinement.chromaGateHigh);
    this.materialProgram.u1f('uRoughnessVariation', this.refinement.roughnessVariation);
    this.materialProgram.u2f('uRoughnessBand', MATERIAL.roughnessRange[0], MATERIAL.roughnessRange[1]);
    this.materialProgram.u1f('uHeightThicknessRef', this.refinement.heightThicknessRef);
    this.materialProgram.u1f('uHeightThicknessPower', this.refinement.heightThicknessPower);
    this.materialProgram.u1f('uFrontBoost', this.refinement.frontBoost);
    this.materialProgram.u1f('uFrontThinGate', this.refinement.frontThinGate);
    this.materialProgram.u1f('uGlossThin', this.refinement.glossThin);
    this.materialProgram.texture('uSmoothed', 3, this.blurTargets[1].texture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
    gl.viewport(0, 0, this.sceneWidth, this.sceneHeight);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(this.sheetVao);
    gl.drawElements(gl.TRIANGLES, this.sheetIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    drawCalls += 1;

    // 6. bloom: thresholded downsample chain, then additive upsample chain
    this.bloomDownProgram.use();
    for (let level = 0; level < this.bloomDownTargets.length; level += 1) {
      const source = level === 0 ? scene : this.bloomDownTargets[level - 1]!;
      const sourceWidth = level === 0 ? this.sceneWidth : source.width;
      const sourceHeight = level === 0 ? this.sceneHeight : source.height;
      this.bloomDownProgram.use();
      this.bloomDownProgram.u2f('uTexelSize', 1 / sourceWidth, 1 / sourceHeight);
      this.bloomDownProgram.u1f('uApplyThreshold', level === 0 ? 1 : 0);
      this.bloomDownProgram.u1f('uThreshold', this.bloomParams.threshold);
      this.bloomDownProgram.u1f('uKnee', this.bloomParams.knee);
      this.bloomDownProgram.u1f('uKneePerTap', this.bloomParams.kneePerTap ? 1 : 0);
      this.bloomDownProgram.texture('uSource', 0, source.texture);
      this.bindAndClear(this.bloomDownTargets[level]!, false);
      this.quad.draw();
      drawCalls += 1;
    }

    this.bloomUpProgram.use();
    for (let level = this.bloomUpTargets.length - 1; level >= 0; level -= 1) {
      const fine = this.bloomDownTargets[level]!;
      const hasCoarse = level < this.bloomUpTargets.length - 1;
      const coarse = hasCoarse ? this.bloomUpTargets[level + 1]! : fine;
      this.bloomUpProgram.use();
      this.bloomUpProgram.u1f('uHasCoarse', hasCoarse ? 1 : 0);
      this.bloomUpProgram.u2f('uCoarseTexelSize', 1 / coarse.width, 1 / coarse.height);
      this.bloomUpProgram.texture('uFine', 0, fine.texture);
      this.bloomUpProgram.texture('uCoarse', 1, coarse.texture);
      this.bindAndClear(this.bloomUpTargets[level]!, false);
      this.quad.draw();
      drawCalls += 1;
    }

    // 7. composite to the default framebuffer
    this.composeToScreen();

    this.stats.renderMs = performance.now() - started;
    this.stats.drawCalls = drawCalls;
  }

  /** The final composite pass; re-runnable for capture in the same task as the draw. */
  composeToScreen(): void {
    const gl = this.gl;
    const scene = this.sceneTarget;
    const bloom = this.bloomUpTargets[0];
    if (!scene || !bloom) return;
    this.compositeProgram.use();
    this.compositeProgram.u1f('uBloomGain', this.toneState.bloomGain);
    this.compositeProgram.u1f('uBloomCap', BLOOM.gainCap);
    this.compositeProgram.u1f('uExposure', this.toneState.exposure);
    this.compositeProgram.texture('uScene', 0, scene.texture);
    this.compositeProgram.texture('uBloom', 1, bloom.texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvasWidth, this.canvasHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.quad.draw();
  }

  /** Exposure and bloom gain the last composite actually used (gate/verification provenance). */
  appliedToneState(): { exposure: number; bloomGain: number } {
    return { exposure: this.toneState.exposure, bloomGain: this.toneState.bloomGain };
  }

  /** §12.4-B: override the refinement knobs (measurement/tuning; zero disables an effect). */
  setRefinement(value: Partial<RefinementState>): void {
    this.refinement = { ...this.refinement, ...value };
  }

  /** The refinement knobs the last material pass used (before/after provenance). */
  appliedRefinement(): RefinementState {
    return { ...this.refinement };
  }

  /** §12.4-B #3: override the bloom threshold/knee/knee order (measurement/tuning). */
  setBloomParams(value: Partial<{ threshold: number; knee: number; kneePerTap: boolean }>): void {
    this.bloomParams = { ...this.bloomParams, ...value };
  }

  /** The bloom parameters the last bloom pass used (before/after provenance). */
  appliedBloomParams(): { threshold: number; knee: number; kneePerTap: boolean } {
    return { ...this.bloomParams };
  }

  /** Read the last composite as RGBA8 (test/verification path; no per-frame readback exists). */
  readComposite(out?: Uint8Array): Uint8Array {
    this.composeToScreen();
    return readCompositeRGBA8(this.gl, this.canvasWidth, this.canvasHeight, out);
  }

  /**
   * §12.4 round-2: read the derived surface field (R = height, G = boundary, B = support, A =
   * activity) for verification. Verification only — no readback exists on the render path.
   */
  readSurfaceField(out?: Float32Array): Float32Array {
    return readColorTargetRGBA(
      this.gl,
      this.surfaceTarget.framebuffer,
      this.surfaceTarget.width,
      this.surfaceTarget.height,
      out,
    );
  }

  get surfaceDimensions(): { width: number; height: number } {
    return { width: this.surfaceTarget.width, height: this.surfaceTarget.height };
  }

  /**
   * Drain the GPU queue by reading one pixel from the default framebuffer. Used only by the
   * laboratory/verification throughput benchmark: it turns asynchronous submission into a
   * measurable per-frame cost.
   */
  syncPoint(): void {
    const gl = this.gl;
    if (!this.syncScratch) this.syncScratch = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncScratch);
  }

  /** §3.3/§10: capture the renderer's final frame as a PNG blob. */
  async capture(): Promise<Blob> {
    this.composeToScreen();
    return canvasToBlob(this.canvas, 'image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const program of [
      this.extractProgram,
      this.blurProgram,
      this.surfaceProgram,
      this.normalsProgram,
      this.materialProgram,
      this.bloomDownProgram,
      this.bloomUpProgram,
      this.compositeProgram,
    ]) {
      program.dispose();
    }
    this.quad.dispose();
    this.releaseSimulationTargets();
    this.releaseSceneTargets();
    if (this.sheetVbo) {
      this.gl.deleteBuffer(this.sheetVbo);
      this.tracker.increment('buffers', -1);
    }
    if (this.sheetIbo) {
      this.gl.deleteBuffer(this.sheetIbo);
      this.tracker.increment('buffers', -1);
    }
    if (this.sheetVao) {
      this.gl.deleteVertexArray(this.sheetVao);
      this.tracker.increment('vertexArrays', -1);
    }
    this.sheetVbo = null;
    this.sheetIbo = null;
    this.sheetVao = null;
  }

  private releaseSceneTargets(): void {
    if (this.sceneTarget) deleteColorTarget(this.gl, this.tracker, this.sceneTarget);
    this.sceneTarget = null;
    for (const target of this.bloomDownTargets) deleteColorTarget(this.gl, this.tracker, target);
    for (const target of this.bloomUpTargets) deleteColorTarget(this.gl, this.tracker, target);
    this.bloomDownTargets = [];
    this.bloomUpTargets = [];
  }

  private bloomSize(level: number): [number, number] {
    return [
      Math.max(1, this.sceneWidth >> (level + 1)),
      Math.max(1, this.sceneHeight >> (level + 1)),
    ];
  }

  private bindAndClear(target: ColorTarget, withDepth: boolean): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (withDepth) gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  private setupSheet(program: Program): void {
    const gl = this.gl;
    const subdivisions = MATERIAL.sheetSubdivisions;
    const side = subdivisions + 1;
    const vertices = new Float32Array(side * side * 2);
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const index = (j * side + i) * 2;
        vertices[index] = i / subdivisions;
        vertices[index + 1] = j / subdivisions;
      }
    }
    const quads = subdivisions * subdivisions;
    const indices = new Uint32Array(quads * 6);
    let cursor = 0;
    for (let j = 0; j < subdivisions; j += 1) {
      for (let i = 0; i < subdivisions; i += 1) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }

    this.sheetVao = gl.createVertexArray();
    this.sheetVbo = gl.createBuffer();
    this.sheetIbo = gl.createBuffer();
    if (!this.sheetVao || !this.sheetVbo || !this.sheetIbo) throw new Error('sheet buffers could not be created');

    gl.bindVertexArray(this.sheetVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sheetVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program.handle, 'aGridUv');
    if (location < 0) throw new Error('sheet vertex shader has no aGridUv attribute');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sheetIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.tracker.increment('buffers', 2);
    this.tracker.increment('vertexArrays');
    this.sheetIndexCount = indices.length;
  }

  /** Last-rendered inputs, for laboratory capture flows. */
  get lastFrameInputs(): { field: { current: FieldView; previous: FieldView } | null; world: WorldState | null } {
    return { field: this.lastField, world: this.lastWorld };
  }
}
