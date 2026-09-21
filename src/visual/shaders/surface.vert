#version 300 es
/*
 * §5.3 one perspective-projected XZ sheet, 256 x 256 quad grid, 2 world units wide.
 *
 * The vertex shader samples the derived height (nearest texel fetch, exact addressing) so low
 * angles show real shallow displacement, while the fragment shader samples full-resolution
 * normals and activity. Mesh tessellation therefore limits only the silhouette, not the detail.
 */
precision highp float;
precision highp int;

uniform sampler2D uHeight;      // surface R = height in world units
uniform mat4 uViewProjection;
uniform vec2 uDomainWidth;      // (2, 2)
uniform vec2 uHeightGrid;       // (768, 768)

in vec2 aGridUv;
out vec2 vUv;
out vec3 vWorldPosition;

void main() {
  vUv = aGridUv;
  vec2 gridMax = uHeightGrid - vec2(1.0);
  ivec2 texel = ivec2(clamp(floor(aGridUv * uHeightGrid), vec2(0.0), gridMax));
  float height = texelFetch(uHeight, texel, 0).x;

  vec3 world = vec3((aGridUv.x - 0.5) * uDomainWidth.x, height, (aGridUv.y - 0.5) * uDomainWidth.y);
  vWorldPosition = world;
  gl_Position = uViewProjection * vec4(world, 1.0);
}
