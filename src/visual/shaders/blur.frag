#version 300 es
/*
 * §5.2 separable five-sample Gaussian, sigma ~1.2 simulation cells.
 *
 * Weights are the analytic Gaussian exp(-d^2 / (2 * 1.2^2)) normalised over the five taps:
 *   exp(0) = 1, exp(-2/2.88) = 0.7066, exp(-8/2.88) = 0.0622 ... rounded to the constants
 * below (sum = 1). This is deliberately a short kernel: it removes single-cell noise without
 * inventing large-scale structure.
 */
precision highp float;
precision highp int;

uniform sampler2D uSource;
uniform ivec2 uGrid;
uniform ivec2 uDirection;   // (1,0) horizontal, (0,1) vertical

out vec4 outColor;

const float W_FAR = 0.085628;   // exp(-8 / (2 * 1.2^2)) / 2.912
const float W_NEAR = 0.242643;  // exp(-2 / (2 * 1.2^2)) / 2.912
const float W_CENTER = 0.343406; // 1 / 2.912

vec4 fetchWrapped(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uSource, w, 0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 sum = W_CENTER * fetchWrapped(p);
  sum += W_NEAR * fetchWrapped(p + uDirection);
  sum += W_NEAR * fetchWrapped(p - uDirection);
  sum += W_FAR * fetchWrapped(p + 2 * uDirection);
  sum += W_FAR * fetchWrapped(p - 2 * uDirection);
  outColor = sum;
}
