#version 300 es
/*
 * §5.2 normals from central differences of the height field, with the actual world-space texel
 * spacing. `normalize(-dh/dx, 1, -dh/dz)`; the +1 keeps the surface a shallow sheet rather than
 * an inflated terrain. A stores support so the material pass can gate radiance with one fetch.
 *
 * Normals are derived from the *same* gated height the sheet mesh displaces by, so silhouette
 * and shading cannot disagree.
 */
precision highp float;
precision highp int;

uniform sampler2D uSurface;   // R = height in world units
uniform ivec2 uGrid;
uniform float uTexelWorld;    // domainWidth / gridWidth

out vec4 outColor;

float heightAt(ivec2 p) {
  ivec2 w = ivec2((p.x + uGrid.x) % uGrid.x, (p.y + uGrid.y) % uGrid.y);
  return texelFetch(uSurface, w, 0).x;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 surface = texelFetch(uSurface, p, 0);

  float dhdx = (heightAt(ivec2(p.x + 1, p.y)) - heightAt(ivec2(p.x - 1, p.y))) / (2.0 * uTexelWorld);
  float dhdz = (heightAt(ivec2(p.x, p.y + 1)) - heightAt(ivec2(p.x, p.y - 1))) / (2.0 * uTexelWorld);

  vec3 normal = normalize(vec3(-dhdx, 1.0, -dhdz));
  outColor = vec4(normal, surface.z);
}
