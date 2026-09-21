/**
 * §4.2 RG32F ping-pong Gray-Scott simulation.
 *
 * Two RG32F textures hold (U,V) and alternate input/output. Nearest filtering, no mipmaps,
 * single colour attachment. RG32F avoids the small-update quantisation of half-float
 * concentrations over slow trajectories. The step shader samples the previous entire field
 * with `texelFetch` (Jacobi update, §4.2) and wraps toroidally (§4.3).
 *
 * The class also enforces the §12.1 "no sample/write attachment feedback" rule: every pass is
 * routed through `drawTo`, which asserts the sampled texture is not the write attachment.
 */
import { FULLSCREEN_VERTEX_SHADER, FullscreenQuad } from '../gpu/fullscreen.ts';
import { Program, ResourceTracker, createColorTarget, deleteColorTarget } from '../gpu/resources.ts';
import type { ColorTarget } from '../gpu/resources.ts';
import { readFieldRG } from '../gpu/readback.ts';
import { assertNoFeedback, commandToUniforms } from './genesis.ts';
import type { StepOutcome } from './reference.ts';
import type { FieldView, GenesisCommand, Params } from '../core/types.ts';
import stepFragmentSource from './shaders/step.frag?raw';
import genesisFragmentSource from './shaders/genesis.frag?raw';
import validateFragmentSource from './shaders/step-validate.frag?raw';

export interface SimulationOptions {
  gl: WebGL2RenderingContext;
  tracker: ResourceTracker;
  width: number;
  height: number;
  dt?: number;
}

/** Result of the validation-only pre-clamp instrumentation (AC.5). */
export interface ClippingReport {
  /** Cell-updates where the unclamped U left [0,1]. */
  clippedU: number;
  /** Cell-updates where the unclamped V left [0,1]. */
  clippedV: number;
  /** Largest excursion magnitude observed, before the fixed-point channel saturates. */
  maxExcursion: number;
  /** (cell, step) pairs whose excursion exceeded the significance threshold. */
  significantCellSteps: number;
  /** Steps that were instrumented. */
  steps: number;
  cells: number;
  /** Fraction of channel-updates that clipped: (clippedU + clippedV) / (steps * cells * 2). */
  frequency: number;
}

export class Simulation {
  readonly gl: WebGL2RenderingContext;
  readonly width: number;
  readonly height: number;
  readonly dt: number;

  /** Count of passes that would have sampled their own write attachment (must stay 0). */
  feedbackViolations = 0;
  /** GPU-side clamping cannot be counted directly; callers record the saturation proxy. */
  readonly clampProbe = { saturatedCells: 0, sampledSteps: 0 };

  private readonly tracker: ResourceTracker;
  private readonly targets: [ColorTarget, ColorTarget];
  private readonly stepProgram: Program;
  private readonly genesisProgram: Program;
  private readonly quad: FullscreenQuad;
  private readonly readBuffer: Float32Array;

  /** Validation-only instrumentation; null until a caller enables it. */
  private validationProgram: Program | null = null;
  private validationTargets: [ColorTarget, ColorTarget] | null = null;
  private validationIndex = 0;
  private validationSteps = 0;
  private validationReadBuffer: Uint32Array | null = null;

  private readIndex = 0;
  private epochValue = 0;
  private stepCount = 0;
  private simulationTime = 0;
  private disposed = false;

  constructor(options: SimulationOptions) {
    const { gl, tracker, width, height } = options;
    this.gl = gl;
    this.tracker = tracker;
    this.width = width;
    this.height = height;
    this.dt = options.dt ?? 1;

    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('simulation requires EXT_color_buffer_float');
    }

    const makeTarget = (): ColorTarget =>
      createColorTarget(gl, tracker, width, height, gl.RG32F, gl.RG, gl.FLOAT, gl.NEAREST, false);
    this.targets = [makeTarget(), makeTarget()];

    this.stepProgram = new Program(
      gl,
      FULLSCREEN_VERTEX_SHADER,
      stepFragmentSource,
      'simulation.step', tracker);
    this.genesisProgram = new Program(
      gl,
      FULLSCREEN_VERTEX_SHADER,
      genesisFragmentSource,
      'simulation.genesis', tracker);
    this.quad = new FullscreenQuad(gl, tracker);
    this.readBuffer = new Float32Array(width * height * 2);

    this.clearToUniform(1, 0);
  }

  /** §4.2: advance the chemistry by one fixed step. */
  step(parameters: Params, dt: number = this.dt): void {
    const input = this.targets[this.readIndex]!;
    const output = this.targets[1 - this.readIndex]!;

    // Validation runs first and reads the same input the chemistry pass is about to read, so the
    // two evaluate identical expressions on identical data. The production path below is
    // unchanged: when validation is off, this call is not made at all.
    if (this.validationProgram) {
      this.runValidationPass(input, parameters, dt);
    }

    this.stepProgram.use();
    this.stepProgram.u2i('uGrid', this.width, this.height);
    this.stepProgram.u1f('uDt', dt);
    this.stepProgram.u1f('uF', parameters.F);
    this.stepProgram.u1f('uK', parameters.k);
    this.stepProgram.u1f('uDu', parameters.Du);
    this.stepProgram.u1f('uDv', parameters.Dv);

    this.drawTo(input, output, 'step');

    this.readIndex = 1 - this.readIndex;
    this.stepCount += 1;
    this.simulationTime += dt;
  }

  /** §4.4: apply a genesis command to the current field and swap normally. */
  seed(command: GenesisCommand): void {
    const uniforms = commandToUniforms(command, this.width, this.height);
    const input = this.targets[this.readIndex]!;
    const output = this.targets[1 - this.readIndex]!;

    this.genesisProgram.use();
    this.genesisProgram.u2i('uGrid', this.width, this.height);
    this.genesisProgram.u2f('uCenterCells', uniforms.centerCells[0], uniforms.centerCells[1]);
    this.genesisProgram.u1f('uRadiusCells', uniforms.radiusCells);
    this.genesisProgram.u1f('uSoftnessCells', uniforms.softnessCells);
    this.genesisProgram.u1f('uShapeStrength', uniforms.shapeStrength);
    // §3.3/§4.4: the command strength is a single global final mask multiplier (deviation 41).
    this.genesisProgram.u1f('uStrength', uniforms.strength);
    this.genesisProgram.u2f('uTarget', uniforms.target[0], uniforms.target[1]);
    this.genesisProgram.u1i('uMode', uniforms.modeIndex);
    this.genesisProgram.u1i('uPattern', uniforms.patternIndex);
    // §4.4 seed geometry as data: a disc array plus the per-pattern shape scalars.
    this.genesisProgram.u1i('uDiscCount', uniforms.discCount);
    this.genesisProgram.u2fv('uDiscCenters', uniforms.discCenters);
    this.genesisProgram.u1fv('uDiscRadii', uniforms.discRadii);
    this.genesisProgram.u1fv('uDiscStrengths', uniforms.discStrengths);
    this.genesisProgram.u2f('uLineA', uniforms.lineA[0], uniforms.lineA[1]);
    this.genesisProgram.u2f('uLineB', uniforms.lineB[0], uniforms.lineB[1]);
    this.genesisProgram.u1f('uLineWidthCells', uniforms.lineWidthCells);
    this.genesisProgram.u2f('uRingCenter', uniforms.ringCenter[0], uniforms.ringCenter[1]);
    this.genesisProgram.u1f('uRingRadiusCells', uniforms.ringRadiusCells);
    this.genesisProgram.u1f('uRingWallCells', uniforms.ringWallCells);
    this.genesisProgram.u2f('uRadialCenter', uniforms.radialCenter[0], uniforms.radialCenter[1]);
    this.genesisProgram.u1f('uRadialCoreCells', uniforms.radialCoreCells);
    this.genesisProgram.u1f('uRadialRadiusCells', uniforms.radialRadiusCells);
    this.genesisProgram.u1f('uRadialCoreStrength', uniforms.radialCoreStrength);
    this.genesisProgram.u1f('uRadialHaloStrength', uniforms.radialHaloStrength);
    this.genesisProgram.u2f('uStructCenter', uniforms.structCenter[0], uniforms.structCenter[1]);
    this.genesisProgram.u1f('uStructSemiMajorCells', uniforms.structSemiMajorCells);
    this.genesisProgram.u1f('uStructSemiMinorCells', uniforms.structSemiMinorCells);
    this.genesisProgram.u1f('uStructRotation', uniforms.structRotation);
    this.genesisProgram.u1f('uStructAmplitude', uniforms.structAmplitude);
    this.genesisProgram.u1f('uStructCoreCells', uniforms.structCoreCells);
    this.genesisProgram.u1ui('uSeed', uniforms.seed);

    this.drawTo(input, output, 'genesis');

    this.readIndex = 1 - this.readIndex;

    if (command.mode === 'replace') {
      // §3.3: a replace invalidates cached analysis.
      this.epochValue += 1;
      this.stepCount = 0;
      this.simulationTime = 0;
    }
  }

  field(): FieldView {
    return {
      texture: this.targets[this.readIndex]!.texture,
      width: this.width,
      height: this.height,
      epoch: this.epochValue,
      step: this.stepCount,
      simulationTime: this.simulationTime,
    };
  }

  /** Current field plus the field one delivered step ago (used for the change descriptor). */
  fieldWithPrevious(): { current: FieldView; previous: FieldView } {
    const current = this.field();
    const previous = this.targets[1 - this.readIndex]!;
    return {
      current,
      previous: {
        texture: previous.texture,
        width: this.width,
        height: this.height,
        epoch: this.epochValue,
        step: Math.max(0, this.stepCount - 1),
        simulationTime: Math.max(0, this.simulationTime - this.dt),
      },
    };
  }

  get epoch(): number {
    return this.epochValue;
  }

  get steps(): number {
    return this.stepCount;
  }

  get numericalTime(): number {
    return this.simulationTime;
  }

  /** Clear to an inert/uniform field and invalidate caches. */
  reset(): void {
    this.clearToUniform(1, 0);
    this.epochValue += 1;
    this.stepCount = 0;
    this.simulationTime = 0;
    this.resetValidation();
  }

  /**
   * §3.3: raise the epoch without touching the field. Used when the whole field is replaced by a
   * *different* `Simulation` (a §10 resolution switch), so consumers still see a monotonic epoch
   * even though the replacement instance would otherwise start from a lower one.
   */
  setEpoch(epoch: number): void {
    this.epochValue = Math.max(this.epochValue, Math.floor(epoch));
  }

  // ------------------------------------------------------------ validation

  /**
   * Enable (and lazily allocate) or release the validation-only pre-clamp instrumentation. This is
   * the only way the instrumentation is ever submitted: `step()` checks for the program's
   * existence, so a caller that never enables it runs exactly the production path.
   *
   * `enableValidation(false)` *releases* everything it allocated rather than only dropping the
   * reference: a nulled reference would leave the GL program and both counter targets alive but
   * unreachable, so re-enabling would orphan them (still allocated, still counted) and a later
   * `dispose()` could never reach them. Toggling is therefore stable — every disable returns the
   * tracker to exactly its pre-validation counts.
   */
  enableValidation(enabled = true): void {
    if (!enabled) {
      this.disableValidation();
      return;
    }
    if (this.validationProgram) return;
    const gl = this.gl;
    // RGBA32UI is colour-renderable in WebGL2 core, so no extension is required for the counters.
    const makeCounter = (): ColorTarget =>
      createColorTarget(gl, this.tracker, this.width, this.height, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, gl.NEAREST, false);
    this.validationTargets = [makeCounter(), makeCounter()];
    this.validationProgram = new Program(
      gl,
      FULLSCREEN_VERTEX_SHADER,
      validateFragmentSource,
      'simulation.validate',
      this.tracker,
    );
    this.validationIndex = 0;
    this.validationSteps = 0;
    this.clearValidationTargets();
  }

  /**
   * Release the validation instrumentation and reset its state. Idempotent, and the single release
   * path shared by `enableValidation(false)` and `dispose()`.
   */
  private disableValidation(): void {
    if (this.validationProgram) {
      this.validationProgram.dispose();
      this.validationProgram = null;
    }
    if (this.validationTargets) {
      for (const target of this.validationTargets) deleteColorTarget(this.gl, this.tracker, target);
      this.validationTargets = null;
    }
    this.validationReadBuffer = null;
    this.validationIndex = 0;
    this.validationSteps = 0;
  }

  get validationEnabled(): boolean {
    return this.validationProgram !== null;
  }

  /** Zero the counters without changing them structurally. */
  resetValidation(): void {
    this.validationSteps = 0;
    if (this.validationTargets) this.clearValidationTargets();
  }

  /**
   * Read the accumulated counters and derive the clipping frequency over the instrumented steps.
   * Called once after a run, never per frame.
   */
  readClipping(): ClippingReport | null {
    const targets = this.validationTargets;
    if (!targets) return null;
    const gl = this.gl;
    const cells = this.width * this.height;
    const buffer =
      this.validationReadBuffer && this.validationReadBuffer.length >= cells * 4
        ? this.validationReadBuffer
        : new Uint32Array(cells * 4);
    this.validationReadBuffer = buffer;

    const current = targets[this.validationIndex]!;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, current.framebuffer);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buffer);
    const error = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    if (error !== gl.NO_ERROR) {
      throw new Error(`reading the validation counters failed (0x${error.toString(16)})`);
    }

    let clippedU = 0;
    let clippedV = 0;
    let maxFixed = 0;
    let significant = 0;
    for (let i = 0; i < cells; i += 1) {
      // Counters are uint32; accumulate in double precision so a very long run cannot overflow.
      clippedU += buffer[i * 4]!;
      clippedV += buffer[i * 4 + 1]!;
      const fixed = buffer[i * 4 + 2]!;
      if (fixed > maxFixed) maxFixed = fixed;
      significant += buffer[i * 4 + 3]!;
    }
    const steps = this.validationSteps;
    const channelUpdates = steps * cells * 2;
    return {
      clippedU,
      clippedV,
      maxExcursion: maxFixed / 1048576,
      significantCellSteps: significant,
      steps,
      cells,
      frequency: channelUpdates > 0 ? (clippedU + clippedV) / channelUpdates : 0,
    };
  }

  private clearValidationTargets(): void {
    const gl = this.gl;
    const targets = this.validationTargets;
    if (!targets) return;
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const zero = new Uint32Array([0, 0, 0, 0]);
    for (const target of targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clearBufferuiv(gl.COLOR, 0, zero);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    this.validationIndex = 0;
  }

  private runValidationPass(input: ColorTarget, parameters: Params, dt: number): void {
    const program = this.validationProgram;
    const targets = this.validationTargets;
    if (!program || !targets) return;
    const gl = this.gl;
    const countersIn = targets[this.validationIndex]!;
    const countersOut = targets[1 - this.validationIndex]!;

    program.use();
    program.u2i('uGrid', this.width, this.height);
    program.u1f('uDt', dt);
    program.u1f('uF', parameters.F);
    program.u1f('uK', parameters.k);
    program.u1f('uDu', parameters.Du);
    program.u1f('uDv', parameters.Dv);
    // Input field on unit 0, previous counters on unit 1. The counter texture is never the field
    // texture, and nothing here is ever bound as both sampler and attachment.
    program.texture('uField', 0, input.texture);
    program.texture('uCounters', 1, countersIn.texture);

    gl.bindFramebuffer(gl.FRAMEBUFFER, countersOut.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.quad.draw();
    this.validationIndex = 1 - this.validationIndex;
    this.validationSteps += 1;
  }

  /** Read the current (U,V) field back to the CPU. Verification and analysis-tooling only. */
  readField(out?: Float32Array): Float32Array {
    const target =
      out && out.length >= this.width * this.height * 2 ? out : this.readBuffer;
    return readFieldRG(
      this.gl,
      this.targets[this.readIndex]!.framebuffer,
      this.width,
      this.height,
      target,
    );
  }

  /**
   * §12.1 attachment-feedback validation against the live GL state: bind the write framebuffer,
   * bind the read texture to unit 0, and compare the actual binding against the attachment.
   */
  verifyAttachmentFeedback(): boolean {
    const gl = this.gl;
    const input = this.targets[this.readIndex]!.texture;
    const output = this.targets[1 - this.readIndex]!;
    const previousFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo);
    const ok = bound !== output.texture;
    if (!ok) this.feedbackViolations += 1;
    return ok;
  }

  /** Record the GPU-side saturation proxy measured by the caller's readback. */
  noteClampProbe(saturatedCells: number): void {
    this.clampProbe.saturatedCells = saturatedCells;
    this.clampProbe.sampledSteps += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stepProgram.dispose();
    this.genesisProgram.dispose();
    this.quad.dispose();
    this.disableValidation();
    for (const target of this.targets) deleteColorTarget(this.gl, this.tracker, target);
  }

  private clearToUniform(u: number, v: number): void {
    const gl = this.gl;
    const previousFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    for (const target of this.targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.clearBufferfv(gl.COLOR, 0, [u, v, 0, 1]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFbo);
  }

  /** Every pass goes through here: bind output, bind input, assert no feedback, draw. */
  private drawTo(input: ColorTarget, output: ColorTarget, label: string): void {
    const gl = this.gl;
    assertNoFeedback(input.texture, output.texture, `simulation.${label}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.texture);
    const bound = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    if (bound === output.texture) {
      this.feedbackViolations += 1;
      throw new Error(`read/write attachment feedback detected in simulation.${label}`);
    }
    this.quad.draw();
  }
}

export function outcomeSummary(outcome: StepOutcome): string {
  return `clippedU=${outcome.clippedU} clippedV=${outcome.clippedV} maxExcursion=${outcome.maxExcursion.toExponential(2)}`;
}
