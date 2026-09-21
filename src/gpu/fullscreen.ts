/**
 * Fullscreen pass utilities.
 *
 * Every derived-field and post pass is a fullscreen triangle whose UVs come from
 * `gl_VertexID`; there are no vertex attributes and no vertex buffer, so there is nothing to
 * misbind. Numerical passes use `texelFetch` in the fragment shader and never rely on
 * optional float-linear filtering (§2.1).
 */
import type { ResourceTracker } from './resources.ts';

export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class FullscreenQuad {
  readonly vao: WebGLVertexArrayObject;
  private readonly gl: WebGL2RenderingContext;
  private readonly tracker: ResourceTracker;

  constructor(gl: WebGL2RenderingContext, tracker: ResourceTracker) {
    this.gl = gl;
    this.tracker = tracker;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    tracker.increment('vertexArrays');
  }

  draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
    this.tracker.increment('vertexArrays', -1);
  }
}

/** Bind a colour target (or the default framebuffer when `target` is null) and set the viewport. */
export function bindTarget(
  gl: WebGL2RenderingContext,
  target: { framebuffer: WebGLFramebuffer; width: number; height: number } | null,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
  }
}

/** Toroidal integer wrap for grid coordinates (mirrors the shader's wrap). */
export function wrapIndex(value: number, size: number): number {
  const m = value % size;
  return m < 0 ? m + size : m;
}
