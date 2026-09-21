#version 300 es
/*
 * §7.1 tier-1 coarse reduction — **float, unclamped** (deviation 35).
 *
 * One pass, one average per output texel: each output texel box-averages its full block of the
 * simulation grid and writes the *raw* block means into an RGBA32F/16F target:
 *
 *   R = occupied fraction   (share of cells with V above the support threshold)
 *   G = mean reaction flux  (mean U*V^2)
 *   B = mean change rate    (mean |V - V_previous| per step)
 *   A = 0 (spare)
 *
 * Nothing is scaled or clamped here. The previous version divided by the packing scales and clamped
 * to [0,1] *before* the coarse grid reached the global mean, so a localized flux above the .04
 * packing scale was clipped before it could contribute — biasing the domain mean downward. Keeping
 * the whole reduction in a float-renderable format through the global average, and packing/clamping
 * exactly once at the final 1x1 record, removes that bias (MAJOR 5).
 *
 * Nonlinear terms (U*V^2, the occupancy indicator) are computed per cell *before* averaging, so the
 * averages are of the real quantities rather than of a reduced proxy. A mean of means is a mean, so
 * the final 1x1 value is the exact full-domain mean for every channel.
 *
 * The pass reads each cell exactly once — the block is walked with `texelFetch`, so there is no
 * filtering and no dependence on float-linear support. This is the only full-domain per-cell pass in
 * the analysis path, and it runs at ~2 Hz.
 */
precision highp float;
precision highp int;

uniform sampler2D uField;
uniform sampler2D uPrevious;
uniform ivec2 uGrid;
uniform int uOutSize;
uniform float uOccupiedThreshold;

out vec4 outColor;

void main() {
  ivec2 outCoord = ivec2(gl_FragCoord.xy);
  ivec2 block = max(ivec2(uGrid) / uOutSize, ivec2(1));
  ivec2 base = outCoord * block;

  float sumOccupied = 0.0;
  float sumFlux = 0.0;
  float sumChange = 0.0;
  float count = 0.0;

  for (int y = 0; y < block.y; y++) {
    for (int x = 0; x < block.x; x++) {
      ivec2 p = base + ivec2(x, y);
      vec2 current = texelFetch(uField, p, 0).xy;
      float previousV = texelFetch(uPrevious, p, 0).y;
      sumOccupied += (current.y > uOccupiedThreshold) ? 1.0 : 0.0;
      sumFlux += current.x * current.y * current.y;
      sumChange += abs(current.y - previousV);
      count += 1.0;
    }
  }

  float inv = 1.0 / max(count, 1.0);
  // Raw, unclamped block means: the values live in real units (a fraction, and U*V^2 / |dV|).
  outColor = vec4(sumOccupied * inv, sumFlux * inv, sumChange * inv, 0.0);
}
