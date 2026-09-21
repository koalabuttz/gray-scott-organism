#version 300 es
/*
 * §5.4 composition: linear HDR scene + restrained bloom -> ACES-fitted filmic curve -> explicit
 * linear-to-sRGB. No grey offset, no black-raising vignette, no dither on zero pixels.
 *
 * The fitted curve is the standard Narkowicz ACES approximation, whose numerator is
 * x * (2.51x + 0.03) — so toneMap(0) is exactly 0 and the black field stays black through the
 * whole chain. The sRGB transfer below also maps 0 to exactly 0.
 */
precision highp float;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomGain;
uniform float uBloomCap;
uniform float uExposure;

in vec2 vUv;
out vec4 outColor;

vec3 acesFitted(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 color) {
  vec3 low = color * 12.92;
  vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), color));
}

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = min(texture(uBloom, vUv).rgb * uBloomGain, vec3(uBloomCap));
  vec3 color = (scene + bloom) * uExposure;
  color = acesFitted(color);
  color = linearToSrgb(color);
  outColor = vec4(color, 1.0);
}
