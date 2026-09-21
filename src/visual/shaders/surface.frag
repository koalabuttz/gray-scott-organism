#version 300 es
/*
 * §5.2 shallow surface field.
 *
 * RGBA16F: R = height (world units), G = boundary magnitude, B = organism support,
 *          A = support-gated boundary emission activity.
 *
 * Height:
 *   shape = 0.8 * (1 - exp(-smoothedV / scale))     saturating remap of smoothed V
 *         + 0.2 * boundaryMagnitude                  revealed edges
 *   height = reliefAmplitude * shape * support
 * with reliefAmplitude starting at 0.004 world units on a 2-unit domain — millimetres, not
 * mountains — and support ramping both height and radiance to zero outside the organism.
 *
 * Emission:
 *   residual = |Dv * L(V) + U*V^2 - (F + k) * V|    the V-equation's local imbalance
 *   activity = saturate(residual / 0.02) * boundary * support
 * so light appears where the chemistry is actually changing, not on every high-V interior.
 * The Laplacian is taken from the raw field (not the blurred copy) so the residual is faithful.
 */
precision highp float;
precision highp int;

uniform sampler2D uSmoothed;   // RGBA16F blurred extraction
uniform sampler2D uField;      // RG32F raw (U,V)
uniform ivec2 uGrid;
uniform float uReliefAmplitude;
uniform float uSmoothedVWeight;
uniform float uBoundaryWeight;
uniform float uSoftenedVScale;
uniform float uDv;
uniform float uF;
uniform float uK;
uniform float uResidualScale;

out vec4 outColor;

vec2 fetchField(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uField, w, 0).xy;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 smoothed = texelFetch(uSmoothed, p, 0);
  vec2 c = texelFetch(uField, p, 0).xy;

  float smoothedV = smoothed.x;
  float boundary = smoothed.z;
  float support = smoothed.w;

  float softenedV = 1.0 - exp(-max(smoothedV, 0.0) / uSoftenedVScale);
  float shape = uSmoothedVWeight * softenedV + uBoundaryWeight * boundary;
  float height = uReliefAmplitude * shape * support;

  float lapV = fetchField(ivec2(p.x + 1, p.y)).y + fetchField(ivec2(p.x - 1, p.y)).y
             + fetchField(ivec2(p.x, p.y + 1)).y + fetchField(ivec2(p.x, p.y - 1)).y
             - 4.0 * c.y;

  float residual = abs(uDv * lapV + c.x * c.y * c.y - (uF + uK) * c.y);
  float activity = clamp(residual / uResidualScale, 0.0, 1.0) * boundary * support;

  outColor = vec4(height, boundary, support, activity);
}
