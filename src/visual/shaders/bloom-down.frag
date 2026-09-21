#version 300 es
/*
 * §5.4 bloom downsample with a soft knee around linear luminance 1.0.
 *
 * 13-tap Karis-style reduction (stable, no firefly sparkle from single bright texels). The
 * threshold is applied only on the first level; later levels are a pure band-limited reduction,
 * otherwise the chain would re-threshold its own spill and turn restrained bloom into glow.
 */
precision highp float;

uniform sampler2D uSource;
uniform vec2 uTexelSize;        // 1 / source size
uniform float uApplyThreshold;
uniform float uThreshold;
uniform float uKnee;

in vec2 vUv;
out vec4 outColor;

vec3 applySoftKnee(vec3 color) {
  float brightness = max(max(color.r, color.g), color.b);
  float quadratic = clamp(brightness - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  quadratic = quadratic * quadratic / (4.0 * uKnee + 1e-4);
  float contribution = max(quadratic, brightness - uThreshold) / max(brightness, 1e-4);
  return color * contribution;
}

void main() {
  vec2 uv = vUv;
  vec2 t = uTexelSize;

  vec3 a = texture(uSource, uv + vec2(-2.0, -2.0) * t).rgb;
  vec3 b = texture(uSource, uv + vec2(0.0, -2.0) * t).rgb;
  vec3 c = texture(uSource, uv + vec2(2.0, -2.0) * t).rgb;
  vec3 d = texture(uSource, uv + vec2(-2.0, 0.0) * t).rgb;
  vec3 e = texture(uSource, uv).rgb;
  vec3 f = texture(uSource, uv + vec2(2.0, 0.0) * t).rgb;
  vec3 g = texture(uSource, uv + vec2(-2.0, 2.0) * t).rgb;
  vec3 h = texture(uSource, uv + vec2(0.0, 2.0) * t).rgb;
  vec3 i = texture(uSource, uv + vec2(2.0, 2.0) * t).rgb;
  vec3 j = texture(uSource, uv + vec2(-1.0, -1.0) * t).rgb;
  vec3 k = texture(uSource, uv + vec2(1.0, -1.0) * t).rgb;
  vec3 l = texture(uSource, uv + vec2(-1.0, 1.0) * t).rgb;
  vec3 m = texture(uSource, uv + vec2(1.0, 1.0) * t).rgb;

  vec3 result = e * 0.125;
  result += (a + c + g + i) * 0.03125;
  result += (b + d + f + h) * 0.0625;
  result += (j + k + l + m) * 0.125;

  if (uApplyThreshold > 0.5) {
    result = applySoftKnee(result);
  }
  outColor = vec4(result, 1.0);
}
