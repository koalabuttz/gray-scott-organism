#version 300 es
/*
 * §5.4 bloom downsample with a soft knee around linear luminance 1.0.
 *
 * 13-tap Karis-style reduction (stable, no firefly sparkle from single bright texels). The
 * threshold is applied only on the first level; later levels are a pure band-limited reduction,
 * otherwise the chain would re-threshold its own spill and turn restrained bloom into glow.
 *
 * §12.4-B #3 correction: the knee is applied to **each source tap before averaging**, so it selects
 * genuinely intense *pixels* (their linear luminance) rather than the luminance of an already
 * half-resolution average. Applying it after the reduction made the threshold behave as a global
 * brightness knob — a band of merely mid-bright pixels all crossed it at once and the whole frame
 * lifted by a uniform haze (measured: threshold 0.4 raised the mature mean by 44% at gain 0.04).
 * Selecting peaks first is both what "soft knee at linear luminance" says and what makes the glow
 * local to the hot rims.
 */
precision highp float;

uniform sampler2D uSource;
uniform vec2 uTexelSize;        // 1 / source size
uniform float uApplyThreshold;
uniform float uThreshold;
uniform float uKnee;
/** §12.4-B #3: 1 = knee per source tap (shipped), 0 = knee on the reduced level (legacy). */
uniform float uKneePerTap;

in vec2 vUv;
out vec4 outColor;

vec3 applySoftKnee(vec3 color) {
  float brightness = max(max(color.r, color.g), color.b);
  float quadratic = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  quadratic = quadratic * quadratic / (4.0 * uKnee + 1e-4);
  float contribution = max(quadratic, brightness - uThreshold) / max(brightness, 1e-4);
  return color * contribution;
}

/** Fetch a tap, optionally keeping only its above-knee luminance before it is averaged in. */
vec3 tap(vec2 uv, bool thresholdHere) {
  vec3 color = texture(uSource, uv).rgb;
  return thresholdHere ? applySoftKnee(color) : color;
}

void main() {
  vec2 uv = vUv;
  vec2 t = uTexelSize;
  bool perTap = uApplyThreshold > 0.5 && uKneePerTap > 0.5;

  vec3 result = tap(uv, perTap) * 0.125;
  result += (tap(uv + vec2(-2.0, -2.0) * t, perTap) + tap(uv + vec2(2.0, -2.0) * t, perTap)
           + tap(uv + vec2(-2.0, 2.0) * t, perTap) + tap(uv + vec2(2.0, 2.0) * t, perTap)) * 0.03125;
  result += (tap(uv + vec2(0.0, -2.0) * t, perTap) + tap(uv + vec2(-2.0, 0.0) * t, perTap)
           + tap(uv + vec2(2.0, 0.0) * t, perTap) + tap(uv + vec2(0.0, 2.0) * t, perTap)) * 0.0625;
  result += (tap(uv + vec2(-1.0, -1.0) * t, perTap) + tap(uv + vec2(1.0, -1.0) * t, perTap)
           + tap(uv + vec2(-1.0, 1.0) * t, perTap) + tap(uv + vec2(1.0, 1.0) * t, perTap)) * 0.125;

  // Legacy path: the knee acts on the already-reduced level (documented as the #3 defect).
  if (uApplyThreshold > 0.5 && !perTap) result = applySoftKnee(result);

  outColor = vec4(result, 1.0);
}
