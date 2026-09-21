/**
 * §9.3 lighting: one dominant light at a shallow elevation, faint neutral-cool, plus the small
 * analytic helpers the material pass needs.
 *
 * Phase 1 keeps the light fixed; aligning its azimuth to the dominant structural orientation
 * and the bounded warmth shift belong to the Phase 2 director.
 */
import { LIGHTING, MATERIAL } from '../config.ts';
import type { LightState, Vec3 } from '../core/types.ts';
import { normalize } from './camera.ts';

/** Unit direction pointing *toward* the light from the surface. */
export function lightDirection(state: LightState): Vec3 {
  const cosElevation = Math.cos(state.elevationRadians);
  return normalize([
    cosElevation * Math.cos(state.azimuthRadians),
    Math.sin(state.elevationRadians),
    cosElevation * Math.sin(state.azimuthRadians),
  ]);
}

export function defaultLightState(): LightState {
  return {
    azimuthRadians: LIGHTING.azimuthRadians,
    elevationRadians: LIGHTING.elevationRadians,
    intensity: LIGHTING.intensity,
    colorLinear: LIGHTING.colorLinear,
    environment: MATERIAL.environment,
    emissionGain: MATERIAL.emissionGain,
    transitionSeconds: 30,
  };
}
