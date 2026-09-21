#version 300 es
/*
 * §7.1/§9.1 **framing** pack — 16x16 RGBA8 coarse occupancy map for the camera director (deviation 36).
 *
 * Turns the raw float coarse grid from `reduce-coarse.frag` into the small RGBA8 map the camera
 * framing reads:
 *
 *   R = occupied fraction          (already 0..1)
 *   G = mean reaction flux / uFluxScale, clamped to [0,1]
 *   B = mean change rate  / uChangeScale, clamped to [0,1]
 *   A = 1 when either channel had to be clamped (a saturation flag), else 0
 *
 * This map is deliberately lossy and is a framing input only: nothing analytic reads it. The
 * presentation tier (256², envelope-weighted) is the analytic signal. Saturation is reported, never
 * silent, through the alpha flag the CPU decode ORs into `packSaturated`.
 */
precision highp float;
precision highp int;

uniform sampler2D uCoarse;
uniform float uFluxScale;
uniform float uChangeScale;

out vec4 outColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 coarse = texelFetch(uCoarse, p, 0);
  float flux = coarse.g / max(uFluxScale, 1e-9);
  float change = coarse.b / max(uChangeScale, 1e-9);
  bool saturated = flux > 1.0 || change > 1.0;
  outColor = vec4(clamp(coarse.r, 0.0, 1.0), clamp(flux, 0.0, 1.0), clamp(change, 0.0, 1.0), saturated ? 1.0 : 0.0);
}
