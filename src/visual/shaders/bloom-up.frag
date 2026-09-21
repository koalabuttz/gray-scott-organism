#version 300 es
/*
 * §5.4 bloom upsample: 9-tap tent filter of the coarser level, added to the finer level.
 *
 * Additive accumulation is done in one pass rather than with blend state, so the result is
 * deterministic on every driver. When `uHasCoarse` is 0 the pass is a passthrough used to seed
 * the coarsest upsample level.
 */
precision highp float;

uniform sampler2D uFine;
uniform sampler2D uCoarse;
uniform vec2 uCoarseTexelSize;
uniform float uHasCoarse;

in vec2 vUv;
out vec4 outColor;

vec3 tent(sampler2D source, vec2 uv, vec2 texel) {
  vec3 a = texture(source, uv + vec2(-texel.x, -texel.y)).rgb;
  vec3 b = texture(source, uv + vec2(0.0, -texel.y)).rgb;
  vec3 c = texture(source, uv + vec2(texel.x, -texel.y)).rgb;
  vec3 d = texture(source, uv + vec2(-texel.x, 0.0)).rgb;
  vec3 e = texture(source, uv).rgb;
  vec3 f = texture(source, uv + vec2(texel.x, 0.0)).rgb;
  vec3 g = texture(source, uv + vec2(-texel.x, texel.y)).rgb;
  vec3 h = texture(source, uv + vec2(0.0, texel.y)).rgb;
  vec3 i = texture(source, uv + vec2(texel.x, texel.y)).rgb;
  return e * 0.25
       + (b + d + f + h) * 0.125
       + (a + c + g + i) * 0.0625;
}

void main() {
  vec3 fine = texture(uFine, vUv).rgb;
  if (uHasCoarse < 0.5) {
    outColor = vec4(fine, 1.0);
    return;
  }
  outColor = vec4(fine + tent(uCoarse, vUv, uCoarseTexelSize), 1.0);
}
