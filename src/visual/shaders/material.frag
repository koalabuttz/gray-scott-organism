#version 300 es
/*
 * §5.3 grazing GGX dielectric material with Schlick Fresnel.
 *
 * One soft directional source at a shallow elevation, a very faint horizon reflection, and a
 * weak support/boundary-modulated emission term. The base is a dark dielectric: F0 near .04,
 * roughness .24-.36, and negligible diffuse albedo, so the surface is revealed almost entirely
 * by grazing specular light — "nearly invisible except where structure catches light".
 *
 * Support-gated radiance: outside the organism (support 0) the output is exactly zero. There is
 * no ambient constant, no grey floor, and no vignette, so the sheet can never reveal itself as
 * a rectangle.
 */
precision highp float;
precision highp int;

uniform sampler2D uNormals;   // xyz = world-space normal, A = support
uniform sampler2D uSurface;   // R = height, G = boundary, B = support, A = activity
uniform vec3 uCameraPosition;
uniform vec3 uLightDirection; // direction toward the light
uniform vec3 uLightColor;
uniform vec3 uSpecularTint;
uniform vec3 uEmissionTint;
uniform float uLightIntensity;
uniform float uEnvironment;
uniform float uEmissionGain;
uniform float uRoughness;
uniform float uF0;
uniform float uDiffuseAlbedo;
uniform float uEnvelopeFullStrengthRadius;

in vec2 vUv;
in vec3 vWorldPosition;
out vec4 outColor;

const float PI = 3.14159265359;

/** §5.4 fixed peripheral envelope: full strength inside the radius, smooth to zero at the edge. */
float envelopeAt(vec2 uv) {
  float radius = length(uv - vec2(0.5)) / 0.5;
  return 1.0 - smoothstep(uEnvelopeFullStrengthRadius, 1.0, radius);
}

float fresnelSchlickRoughness(float cosTheta, float f0, float roughness) {
  float f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return f0 + (max(1.0 - roughness, f0) - f0) * f;
}

void main() {
  vec4 normalSample = texture(uNormals, vUv);
  vec4 surface = texture(uSurface, vUv);

  float support = min(normalSample.w, surface.z);
  float envelope = envelopeAt(vUv);
  float gate = support * envelope;
  if (gate <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  vec3 N = normalize(normalSample.xyz);
  vec3 V = normalize(uCameraPosition - vWorldPosition);
  vec3 L = normalize(uLightDirection);
  vec3 H = normalize(L + V);

  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);

  float alpha = uRoughness * uRoughness;
  float a2 = alpha * alpha;
  float denominator = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * denominator * denominator);

  float k = alpha * 0.5;
  float G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));

  float F = uF0 + (1.0 - uF0) * pow(clamp(1.0 - VdotH, 0.0, 1.0), 5.0);

  vec3 specular = vec3(D * G * F / (4.0 * NdotV * NdotL + 1e-4)) * uSpecularTint;
  vec3 diffuse = vec3(uDiffuseAlbedo / PI);
  vec3 radiance = (diffuse + specular) * uLightColor * uLightIntensity * NdotL;

  // Faint horizon reflection: an environment term, never a colourful HDRI.
  float envFresnel = fresnelSchlickRoughness(NdotV, uF0, uRoughness);
  radiance += uLightColor * (uEnvironment * envFresnel);

  // Weak subsurface approximation: the reaction's own activity near boundaries.
  radiance += uEmissionTint * (uEmissionGain * surface.a);

  outColor = vec4(radiance * gate, 1.0);
}
