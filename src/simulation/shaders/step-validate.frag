#version 300 es
/*
 * Validation-only pre-clamp instrumentation (AC.5).
 *
 * This pass exists so the 10,000-step smoke run can report a real *clipping frequency* rather
 * than the ambiguous "how many cells ended up exactly on a clamp bound" proxy, which cannot
 * distinguish the untouched U≡1 void from a genuine pre-clamp excursion.
 *
 * It evaluates exactly the expression in `step.frag` — same five-point Laplacian, same wrapping,
 * same operation order — but WITHOUT the final clamp, so it can see the unclamped values that
 * the production path discards. It runs on the same input field the chemistry pass reads, so the
 * two agree step for step, and the production chemistry path is untouched: the pass is only ever
 * submitted when a caller explicitly enables validation.
 *
 * Output is RGBA32UI, accumulated per cell by read-modify-write (integer, so the counts stay
 * exact: 10,000 steps x 65,536 cells exceeds float32's exact-integer range):
 *   R = sum of clipped U channel updates
 *   G = sum of clipped V channel updates
 *   B = maximum excursion magnitude, fixed point 2^20 (saturates at 4096 units)
 *   A = sum over cells of steps in which the excursion exceeded the significance threshold
 *       (separates real clipping from rounding-level blips)
 */
precision highp float;
precision highp int;

uniform sampler2D uField;      // RG32F (U,V) input for the step being validated
uniform highp usampler2D uCounters;  // RGBA32UI cumulative counters
uniform ivec2 uGrid;
uniform float uDt;
uniform float uF;
uniform float uK;
uniform float uDu;
uniform float uDv;

// Integer fragment outputs need an explicit location.
layout(location = 0) out uvec4 outCounters;

const float EXCURSION_SCALE = 1048576.0;  // 2^20
const float EXCURSION_SATURATION = 4000.0;
/** Excursions below this are rounding-level, not clipping. */
const float SIGNIFICANT_EXCURSION = 0.001;

vec2 fetchWrapped(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uField, w, 0).xy;
}

uint toFixed(float magnitude) {
  return uint(min(max(magnitude, 0.0), EXCURSION_SATURATION) * EXCURSION_SCALE);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);

  vec2 c = texelFetch(uField, p, 0).xy;
  vec2 l = fetchWrapped(ivec2(p.x - 1, p.y));
  vec2 r = fetchWrapped(ivec2(p.x + 1, p.y));
  vec2 d = fetchWrapped(ivec2(p.x, p.y - 1));
  vec2 u = fetchWrapped(ivec2(p.x, p.y + 1));

  vec2 laplacian = l + r + d + u - 4.0 * c;
  float reaction = c.x * c.y * c.y;

  // Identical to step.frag, minus the clamp guard.
  float uRaw = c.x + uDt * (uDu * laplacian.x - reaction + uF * (1.0 - c.x));
  float vRaw = c.y + uDt * (uDv * laplacian.y + reaction - (uF + uK) * c.y);

  float excursionU = max(max(-uRaw, 0.0), max(uRaw - 1.0, 0.0));
  float excursionV = max(max(-vRaw, 0.0), max(vRaw - 1.0, 0.0));

  uint clippedU = excursionU > 0.0 ? 1u : 0u;
  uint clippedV = excursionV > 0.0 ? 1u : 0u;
  uint significant = max(excursionU, excursionV) > SIGNIFICANT_EXCURSION ? 1u : 0u;

  uvec4 counters = texelFetch(uCounters, p, 0);
  outCounters = uvec4(
    counters.r + clippedU,
    counters.g + clippedV,
    max(counters.b, max(toFixed(excursionU), toFixed(excursionV))),
    counters.a + significant
  );
}
