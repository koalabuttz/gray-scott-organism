#version 300 es
/*
 * §7.1 tier-2 **presentation** reduction — envelope-weighted 256x256 RGBA8 pack (Phase 3).
 *
 * Each output texel box-averages its block of the simulation grid with the §5.4 **support envelope
 * mask applied per cell before averaging** (the same fixed peripheral envelope the visual system
 * uses), so chemistry the viewer cannot see cannot drive a presentation-facing signal. Nonlinear
 * reaction terms are computed per cell *before* averaging. The packed channels are (§7.1):
 *
 *   R = envelope-weighted U                     (already 0..1)
 *   G = envelope-weighted V                     (already 0..1)
 *   B = clamp(envelope-weighted U*V^2 / uFluxScale, 0, 1)
 *   A = clamp(envelope-weighted |V - V_prev| / uChangeScale, 0, 1)
 *
 * **Normalization (review fix MAJOR 1).** The weighted sums are divided by the **constant block texel
 * count** `block.x * block.y`, *not* by the summed envelope weight. Dividing by the summed weight
 * would algebraically cancel a near-constant attenuation: a block at ~constant envelope weight
 * `w < 1` would return `sum(w*value)/sum(w) = value`, so dim peripheral chemistry inside the
 * 0.65–1.0 fade annulus would still produce full-strength presentation signals. Dividing by the texel
 * count instead makes the output track the mean envelope weight over the block, so the presentation
 * signal is genuinely and monotonically attenuated with radius, while a fully-lit block (weight 1
 * everywhere) is unchanged: the mean of `w*value` over the block equals the plain block mean.
 *
 * A texel whose envelope weight sums to exactly zero (fully hidden periphery, no cell with weight > 0)
 * is explicitly suppressed to (0, 0, 0, 0): hidden activity produces no presentation signal at all.
 * This pass reads each cell exactly once via `texelFetch`.
 */
precision highp float;
precision highp int;

uniform sampler2D uField;
uniform sampler2D uPrevious;
uniform ivec2 uGrid;
uniform int uOutSize;
uniform float uFluxScale;
uniform float uChangeScale;
uniform float uEnvelopeFullStrengthRadius;

out vec4 outColor;

void main() {
  ivec2 outCoord = ivec2(gl_FragCoord.xy);
  ivec2 block = max(ivec2(uGrid) / uOutSize, ivec2(1));
  ivec2 base = outCoord * block;
  // Constant spatial sample count of this block: the normalization denominator (never the weight sum).
  float texels = float(block.x * block.y);

  float sumWeight = 0.0;
  float sumU = 0.0;
  float sumV = 0.0;
  float sumFlux = 0.0;
  float sumChange = 0.0;

  for (int y = 0; y < block.y; y++) {
    for (int x = 0; x < block.x; x++) {
      ivec2 p = base + ivec2(x, y);
      vec2 uv = (vec2(p) + 0.5) / vec2(uGrid);
      float radius = length(uv - vec2(0.5)) / 0.5;
      float weight = 1.0 - smoothstep(uEnvelopeFullStrengthRadius, 1.0, radius);
      vec2 current = texelFetch(uField, p, 0).xy;
      float previousV = texelFetch(uPrevious, p, 0).y;
      sumWeight += weight;
      sumU += weight * current.x;
      sumV += weight * current.y;
      sumFlux += weight * current.x * current.y * current.y;
      sumChange += weight * abs(current.y - previousV);
    }
  }

  if (sumWeight <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  float inv = 1.0 / texels;
  float flux = (sumFlux * inv) / max(uFluxScale, 1e-9);
  float change = (sumChange * inv) / max(uChangeScale, 1e-9);
  outColor = vec4(clamp(sumU * inv, 0.0, 1.0), clamp(sumV * inv, 0.0, 1.0), clamp(flux, 0.0, 1.0), clamp(change, 0.0, 1.0));
}
