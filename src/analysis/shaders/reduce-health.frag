#version 300 es
/*
 * §7.1 tier-1 1x1 health record — **exact, float, unclamped** (deviation 35).
 *
 * Averages the fixed COARSE x COARSE **float** coarse grid into the single full-domain record the
 * curator's extinction safety and stillness gate read:
 *
 *   R = full occupied fraction, G = mean reaction flux, B = mean change rate, A = 1 (spare)
 *
 * The average is exact: every channel of the coarse grid is already a mean over its block, so the
 * mean of the coarse grid is the mean over the whole domain, and because the coarse grid is float
 * and unclamped there is no intermediate quantization or clipping. The result is written to an
 * RGBA32F/16F target and read back as floats, so the only loss anywhere in the chain is the final
 * record's own precision — reported rather than hidden. The loop bound is a compile-time constant so
 * the shader is well-formed on every ES 3.0 implementation.
 */
precision highp float;
precision highp int;

#define COARSE 16

uniform sampler2D uCoarse;

out vec4 outColor;

void main() {
  vec4 sum = vec4(0.0);
  for (int y = 0; y < COARSE; y++) {
    for (int x = 0; x < COARSE; x++) {
      sum += texelFetch(uCoarse, ivec2(x, y), 0);
    }
  }
  float inv = 1.0 / float(COARSE * COARSE);
  // No clamp: the raw domain means are the honest values the curator's thresholds compare against.
  outColor = vec4(sum.rgb * inv, 1.0);
}
