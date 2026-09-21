/**
 * §9.1 camera: perspective projection with a narrow 28-degree vertical field of view at a high
 * elevation, which reads as near-orthographic without a projection-mode switch.
 *
 * Column-major 4x4 matrices (GL layout). This module owns matrices only; camera *policy* is the
 * visual director's job in Phase 2.
 */
import { CAMERA, SURFACE } from '../config.ts';
import type { CameraState, Vec2, Vec3 } from '../core/types.ts';

export type Mat4 = Float32Array;

export function mat4Identity(out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  m.fill(0);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function perspective(fovY: number, aspect: number, near: number, far: number, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  const f = 1 / Math.tan(fovY / 2);
  m.fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3, out?: Mat4): Mat4 {
  const z = normalize(subtract(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = out ?? new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[3] = 0;
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[7] = 0;
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[11] = 0;
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/** out = a * b (apply b first). */
export function multiply(a: Mat4, b: Mat4, out?: Mat4): Mat4 {
  const m = out ?? new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    const b0 = b[column * 4]!;
    const b1 = b[column * 4 + 1]!;
    const b2 = b[column * 4 + 2]!;
    const b3 = b[column * 4 + 3]!;
    m[column * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    m[column * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    m[column * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    m[column * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return m;
}

/** Camera distance at which a square domain of `domainWidth` fills `fillFraction` of the view. */
export function distanceForDomainFit(fovY: number, fillFraction: number, domainWidth: number): number {
  const visibleHeight = domainWidth / Math.max(0.05, fillFraction);
  return visibleHeight / (2 * Math.tan(fovY / 2));
}

export function focusToWorld(focusUV: Vec2, domainWidth = SURFACE.domainWidth): Vec3 {
  return [(focusUV[0] - 0.5) * domainWidth, 0, (focusUV[1] - 0.5) * domainWidth];
}

export interface CameraView {
  position: Vec3;
  target: Vec3;
  viewProjection: Mat4;
  near: number;
  far: number;
}

const scratchView = new Float32Array(16);
const scratchProjection = new Float32Array(16);
const scratchViewProjection = new Float32Array(16);

export function computeCameraView(state: CameraState, aspect: number, domainWidth = SURFACE.domainWidth): CameraView {
  const target = focusToWorld(state.focusUV, domainWidth);
  const cosElevation = Math.cos(state.elevationRadians);
  const direction: Vec3 = [
    cosElevation * Math.cos(state.yawRadians),
    Math.sin(state.elevationRadians),
    cosElevation * Math.sin(state.yawRadians),
  ];
  const position: Vec3 = [
    target[0] + direction[0] * state.distance,
    target[1] + direction[1] * state.distance,
    target[2] + direction[2] * state.distance,
  ];
  const near = 0.05;
  // Far plane is generous but bounded; the domain is 2 units and relief is millimetric.
  const far = state.distance + 20;
  lookAt(position, target, [0, 1, 0], scratchView);
  perspective(state.verticalFovRadians, aspect, near, far, scratchProjection);
  const viewProjection = multiply(scratchProjection, scratchView, scratchViewProjection);
  return { position, target, viewProjection, near, far };
}

export function defaultCameraState(): CameraState {
  return {
    mode: 'overhead',
    focusUV: [0.5, 0.5],
    yawRadians: CAMERA.yawRadians,
    elevationRadians: CAMERA.elevationRadians,
    distance: distanceForDomainFit(
      CAMERA.verticalFovRadians,
      CAMERA.domainFillVertical,
      SURFACE.domainWidth,
    ),
    verticalFovRadians: CAMERA.verticalFovRadians,
    transitionSeconds: CAMERA.responseSeconds,
  };
}

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
