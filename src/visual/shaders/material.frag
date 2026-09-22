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
uniform sampler2D uSmoothed;  // RGBA16F blurred extraction: x = smoothed V, z = boundary magnitude
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
// §12.4-B refinement (config `REFINEMENT`); every term is an exact identity when its value is 0.
uniform float uThicknessScale;
uniform float uInteriorDarkening;
uniform float uAbsorptionChroma;
uniform vec2 uChromaGate;
uniform float uRoughnessVariation;
/** §5.3 documented roughness band the local (= varied) roughness is clamped into. */
uniform vec2 uRoughnessBand;
// Round-2 (#1/#3/#4): the normalized thickness the height uses, plus the frontier band and thin-gloss.
uniform float uHeightThicknessRef;
uniform float uHeightThicknessPower;
uniform float uFrontBoost;
uniform float uFrontThinGate;
uniform float uGlossThin;

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

  // §12.4-B: support thickness — the same blurred, saturating measure the §5.2 height field uses
  // (`surface.frag`'s `softenedV`), so absorption is driven by physical depth, not a raw-V ramp.
  vec4 smoothed = texture(uSmoothed, vUv);
  float thickness = 1.0 - exp(-max(smoothed.x, 0.0) / max(uThicknessScale, 1e-4));
  float boundaryActivity = clamp(smoothed.z * 2.0, 0.0, 1.0);

  // Round 2: the *same* normalized thickness the §5.2 height is built from (so the frontier band and
  // the thin-gloss sit exactly where the relief is shallow). Falls back to the round-B saturating
  // measure when round 2 is off.
  float heightThickness = uHeightThicknessRef > 0.0
    ? pow(clamp(max(smoothed.x, 0.0) / uHeightThicknessRef, 0.0, 1.0), max(uHeightThicknessPower, 1e-3))
    : thickness;
  float thinness = clamp(1.0 - heightThickness, 0.0, 1.0);

  // §12.4-B #4 + round-2 #4: the actively reshaping front (high |∇V|) keeps the calibrated
  // roughness, calmer material is smoother, and *thin* material is glossier still — thin regions are
  // the active frontier, so the specular difference deepens the depth read. Clamped into the §5.3 band.
  float localRoughness = clamp(
    uRoughness * (1.0 - uRoughnessVariation * (1.0 - boundaryActivity)) * (1.0 - uGlossThin * thinness),
    uRoughnessBand.x,
    uRoughnessBand.y
  );

  vec3 N = normalize(normalSample.xyz);
  vec3 V = normalize(uCameraPosition - vWorldPosition);
  vec3 L = normalize(uLightDirection);
  vec3 H = normalize(L + V);

  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 1e-4);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);

  float alpha = localRoughness * localRoughness;
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
  float envFresnel = fresnelSchlickRoughness(NdotV, uF0, localRoughness);
  radiance += uLightColor * (uEnvironment * envFresnel);

  // Weak subsurface approximation: the reaction's own activity near boundaries.
  radiance += uEmissionTint * (uEmissionGain * surface.a);

  // §12.4-B #1/#2: Beer–Lambert transmittance through the support thickness. The neutral depth
  // darkens genuinely thick interiors (volume under a skin); the gated chromatic term removes the
  // frame's cool cast where the support is deep (blue absorbed faster than green, none in red).
  // Both are exact identities at zero config, and both only attenuate, so a zero-support pixel stays
  // exactly black.
  float neutral = exp(-uInteriorDarkening * thickness);
  float chromaGate = smoothstep(uChromaGate.x, uChromaGate.y, thickness);
  vec3 chromatic = exp(-uAbsorptionChroma * chromaGate * thickness * vec3(0.0, 0.5, 1.0));
  radiance *= neutral * chromatic;

  // Round-2 #3: boundary-band emphasis — a faint lift exactly where the active frontier (|∇V|) is
  // *thin*. The weight is `|∇V|` squared (already concentrated at fronts, and squaring sharpens that
  // selectivity) gated to genuinely thin material, so the band cannot spread over the body: an
  // ungated version flooded the frame (measured p50 29 → 117 and the lit spread collapsing 2.66 →
  // 1.33). The tint is the material's own near-neutral specular tint rather than the (cool) light
  // colour, so the band cannot reintroduce the cast round B removed. Zero config is an exact no-op,
  // and the final `* gate` keeps black black.
  float frontGate = smoothstep(uFrontThinGate, min(1.0, uFrontThinGate + 0.25), thinness);
  float frontWeight = boundaryActivity * boundaryActivity * frontGate;
  radiance += uSpecularTint * (uFrontBoost * frontWeight);

  outColor = vec4(radiance * gate, 1.0);
}
