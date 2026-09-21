#version 300 es
/*
 * §5.1 Field extraction: V, normalized chemical change, boundary magnitude, organism support.
 *
 * Reads the live ping-pong pair directly, so the change term is a real per-step difference
 * (current minus the previous delivered step) rather than a guessed rate. All sampling is
 * texelFetch with manual toroidal wrapping.
 */
precision highp float;
precision highp int;

uniform sampler2D uField;     // RG32F current (U,V)
uniform sampler2D uPrevious;  // RG32F one delivered step earlier
uniform ivec2 uGrid;
uniform float uChangeSaturation;
uniform float uBoundarySaturation;
uniform float uSupportLow;
uniform float uSupportHigh;

out vec4 outColor;

vec2 fetchWrapped(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uField, w, 0).xy;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(uField, p, 0).xy;
  vec2 previous = texelFetch(uPrevious, p, 0).xy;

  float change = clamp(abs(c.y - previous.y) / uChangeSaturation, 0.0, 1.0);

  vec2 dx = (fetchWrapped(ivec2(p.x + 1, p.y)) - fetchWrapped(ivec2(p.x - 1, p.y))) * 0.5;
  vec2 dy = (fetchWrapped(ivec2(p.x, p.y + 1)) - fetchWrapped(ivec2(p.x, p.y - 1))) * 0.5;
  float boundary = clamp(length(vec2(dx.y, dy.y)) / uBoundarySaturation, 0.0, 1.0);

  float support = smoothstep(uSupportLow, uSupportHigh, c.y);

  outColor = vec4(c.y, change, boundary, support);
}
