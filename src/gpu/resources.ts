/**
 * Small project-local GL utility layer (§3.1): shader compilation with real error reporting,
 * texture/FBO construction, uniform helpers, and resource accounting for laboratory
 * diagnostics. This is deliberately not a render-graph framework.
 */
import type { GLResourceCounts } from '../core/types.ts';

export class ResourceTracker {
  private counts: GLResourceCounts = {
    textures: 0,
    framebuffers: 0,
    renderbuffers: 0,
    programs: 0,
    shaders: 0,
    vertexArrays: 0,
    buffers: 0,
  };

  increment(key: keyof GLResourceCounts, delta = 1): void {
    this.counts[key] += delta;
  }

  snapshot(): GLResourceCounts {
    return { ...this.counts };
  }

  /**
   * Zero every count. Used by the §11.3 context-restore rebuild: when a WebGL context is lost the
   * driver has already freed every object it owned, and deleting those stale handles in the restored
   * context is an `INVALID_OPERATION` (and a console warning), so the dead instances are dropped and
   * the tracker is re-based to zero before the replacements are constructed.
   */
  reset(): void {
    this.counts = {
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
      programs: 0,
      shaders: 0,
      vertexArrays: 0,
      buffers: 0,
    };
  }
}

export class ShaderError extends Error {
  constructor(
    message: string,
    readonly label: string,
    readonly log: string,
  ) {
    super(message);
    this.name = 'ShaderError';
  }
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly gl: WebGL2RenderingContext;
  private readonly tracker: ResourceTracker | null;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    label: string,
    tracker?: ResourceTracker,
  ) {
    this.gl = gl;
    this.tracker = tracker ?? null;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
    const handle = gl.createProgram();
    if (!handle) throw new ShaderError(`could not create program ${label}`, label, '');
    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);
    const linked = gl.getProgramParameter(handle, gl.LINK_STATUS);
    const log = String(gl.getProgramInfoLog(handle) ?? '');
    // The shader objects are owned by the program only until it links; they are released here, so
    // they are never part of the live resource counts.
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!linked) {
      gl.deleteProgram(handle);
      throw new ShaderError(`program ${label} failed to link`, label, log);
    }
    this.handle = handle;
    this.tracker?.increment('programs');
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  location(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.handle, name));
    }
    const loc = this.locations.get(name)!;
    if (loc === null && !this.locations.has(`${name}#warned`)) {
      this.locations.set(`${name}#warned`, null);
    }
    return loc;
  }

  u1f(name: string, value: number): void {
    this.gl.uniform1f(this.location(name), value);
  }

  u1i(name: string, value: number): void {
    this.gl.uniform1i(this.location(name), value);
  }

  u2f(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.location(name), x, y);
  }

  u2i(name: string, x: number, y: number): void {
    this.gl.uniform2i(this.location(name), x, y);
  }

  u3f(name: string, x: number, y: number, z: number): void {
    this.gl.uniform3f(this.location(name), x, y, z);
  }

  u4f(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.location(name), x, y, z, w);
  }

  /** Upload a float array to a `float[]` uniform (§4.4 seed geometry). */
  u1fv(name: string, values: Float32Array | number[]): void {
    this.gl.uniform1fv(this.location(name), values);
  }

  /** Upload a vec2 array to a `vec2[]` uniform (§4.4 seed geometry). */
  u2fv(name: string, values: Float32Array | number[]): void {
    this.gl.uniform2fv(this.location(name), values);
  }

  /** Upload an unsigned integer to a `uint` uniform (used as the seed hash input). */
  u1ui(name: string, value: number): void {
    this.gl.uniform1ui(this.location(name), value >>> 0);
  }

  /** mat4 is stored as a Float32Array in GL column-major layout. */
  mat4(name: string, value: Float32Array): void {
    this.gl.uniformMatrix4fv(this.location(name), false, value);
  }

  /** Bind a texture unit and point a sampler uniform at it. */
  texture(name: string, unit: number, texture: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.u1i(name, unit);
  }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
    this.tracker?.increment('programs', -1);
    this.locations.clear();
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new ShaderError(`could not create shader ${label}`, label, '');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = String(gl.getShaderInfoLog(shader) ?? '');
    gl.deleteShader(shader);
    throw new ShaderError(`shader ${label} failed to compile`, label, withLineNumbers(source, log));
  }
  return shader;
}

/** Attach source lines to driver messages; most drivers report line numbers only. */
function withLineNumbers(source: string, log: string): string {
  const numbered = source
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(3, ' ')} | ${line}`)
    .join('\n');
  return `${log}\n--- source ---\n${numbered}`;
}

export interface TextureOptions {
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
  filter: number;
  wrap?: number;
  levels?: number;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  tracker: ResourceTracker,
  options: TextureOptions,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('createTexture failed');
  const wrap = options.wrap ?? gl.CLAMP_TO_EDGE;
  const levels = options.levels ?? 1;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, levels, options.internalFormat, options.width, options.height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  tracker.increment('textures');
  return texture;
}

export interface ColorTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
  /**
   * Optional depth attachment owned by this target. It is stored explicitly so that
   * `deleteColorTarget` can release it: a renderbuffer that is created but never retained leaks
   * one allocation (and one diagnostic count) on every resize of the scene target.
   */
  depthRenderbuffer: WebGLRenderbuffer | null;
}

/** A single-colour-attachment framebuffer (§5.1: fewer mixed-format assumptions). */
export function createColorTarget(
  gl: WebGL2RenderingContext,
  tracker: ResourceTracker,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number,
  depth: boolean,
): ColorTarget {
  const texture = createTexture(gl, tracker, {
    width,
    height,
    internalFormat,
    format,
    type,
    filter,
  });
  let framebuffer: WebGLFramebuffer | null = null;
  let depthRenderbuffer: WebGLRenderbuffer | null = null;

  // Any failure below must release everything created so far, or the tracker would report
  // allocations that no longer have an owner.
  const abandon = (message: string): never => {
    if (depthRenderbuffer) {
      gl.deleteRenderbuffer(depthRenderbuffer);
      tracker.increment('renderbuffers', -1);
    }
    if (framebuffer) {
      gl.deleteFramebuffer(framebuffer);
      tracker.increment('framebuffers', -1);
    }
    gl.deleteTexture(texture);
    tracker.increment('textures', -1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error(message);
  };

  // Ownership is taken the moment an object exists rather than at the end of the success path:
  // `abandon` decrements whatever this function owns, so a counter incremented only after the
  // completeness check would be decremented on a failed construction without ever having been
  // incremented — leaving the tracker at -1 (and a later successful construction merely masking it).
  framebuffer = gl.createFramebuffer();
  if (!framebuffer) abandon('createFramebuffer failed');
  tracker.increment('framebuffers');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer!);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (depth) {
    depthRenderbuffer = gl.createRenderbuffer();
    if (!depthRenderbuffer) abandon('createRenderbuffer failed');
    tracker.increment('renderbuffers');
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer!);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      depthRenderbuffer!,
    );
  }
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    abandon(
      `framebuffer ${width}x${height} format 0x${internalFormat.toString(16)} incomplete: 0x${status.toString(16)}`,
    );
  }
  return { texture, framebuffer: framebuffer!, width, height, depthRenderbuffer };
}

export function deleteColorTarget(
  gl: WebGL2RenderingContext,
  tracker: ResourceTracker,
  target: ColorTarget,
): void {
  if (target.depthRenderbuffer) {
    gl.deleteRenderbuffer(target.depthRenderbuffer);
    tracker.increment('renderbuffers', -1);
    target.depthRenderbuffer = null;
  }
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
  tracker.increment('framebuffers', -1);
  tracker.increment('textures', -1);
}
