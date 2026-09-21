#version 300 es
/*
 * §4.2 Gray-Scott step (Jacobi update over the whole previous field).
 *
 * Unweighted five-point Laplacian, toroidal integer wrapping, one chemical cell spacing:
 *   L(X) = X(left) + X(right) + X(up) + X(down) - 4 X(center)
 *   r    = U * V * V
 *   U'   = U + dt * (Du * L(U) - r + F * (1 - U))
 *   V'   = V + dt * (Dv * L(V) + r - (F + k) * V)
 *
 * Sampling is `texelFetch` on purpose: nearest-neighbour, exact texel addressing, no
 * dependency on optional float-linear filtering support (§2.1). Out-of-range coordinates are
 * wrapped by hand because texelFetch outside the texture is undefined.
 *
 * The final clamp to [0,1] is a last guard only; the laboratory instruments how often it
 * arithmetically binds (see Simulation.clampProxy) and trajectories that depend on persistent
 * clipping are rejected.
 */
precision highp float;
precision highp int;

uniform sampler2D uField;
uniform ivec2 uGrid;
uniform float uDt;
uniform float uF;
uniform float uK;
uniform float uDu;
uniform float uDv;

out vec4 outColor;

vec2 fetchWrapped(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uField, w, 0).xy;
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

  float uNext = c.x + uDt * (uDu * laplacian.x - reaction + uF * (1.0 - c.x));
  float vNext = c.y + uDt * (uDv * laplacian.y + reaction - (uF + uK) * c.y);

  outColor = vec4(clamp(uNext, 0.0, 1.0), clamp(vNext, 0.0, 1.0), 0.0, 1.0);
}
