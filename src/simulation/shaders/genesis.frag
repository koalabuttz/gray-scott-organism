#version 300 es
/*
 * §4.4 Genesis pass — all seven declared patterns.
 *
 * Reads the previous chemistry and writes a new target field. Replace mode starts from a uniform
 * (1,0) field; inject mode leaves the surrounding field unchanged. Every pattern mixes smoothly
 * toward approximately (0.45, 0.28) with 1-2 cells of edge softness.
 *
 * The geometry arrives as **data** (§4.4 + `genesis-geometry.ts`): a small uniform array of discs
 * plus a handful of per-pattern scalars, so the shader implements the *shapes* and `genesis.ts`
 * decides where they go. `single`/`competing`/`sparse` are all disc sets (`single` is a one-disc set
 * whose centre and radius come straight from the command, which keeps Phase-1 seeding identical).
 *
 * The read texture is never the write attachment (see Simulation.drawTo), and every distance is
 * measured on the torus, so a seed near a seam changes only the intended, wrapped support.
 */
precision highp float;
precision highp int;

/** Maximum discs any pattern places; must match MAX_GENESIS_DISCS in genesis.ts. */
#define MAX_DISCS 24

uniform sampler2D uField;
uniform ivec2 uGrid;
uniform int uMode;       // 0 = replace, 1 = inject
uniform int uPattern;    // 0 single, 1 competing, 2 sparse, 3 line, 4 ring, 5 radial, 6 structured
uniform vec2 uTarget;
uniform float uSoftnessCells;
/** The pattern's *own* structural strength (line/ring); 1 for the others, which carry theirs per disc. */
uniform float uShapeStrength;
/**
 * The command's `strength` (§3.3), applied as a **single final global multiplier** on the assembled
 * mask for every pattern (deviation 41). Previously it was folded into per-pattern terms, which left
 * `radial`'s viable core and `structured`'s viable core at full strength even for `strength: 0`, so a
 * curator hard-clear on a radial/structured document could seed a living core instead of an inert
 * field. Applying it last makes `strength: 0` exactly (1, 0) everywhere for every kind, and leaves
 * `single`'s Phase-1 mask byte-identical at `strength: 1` (1.0 * 1.0 * 1.0).
 */
uniform float uStrength;

uniform int uDiscCount;
uniform vec2 uDiscCenters[MAX_DISCS];
uniform float uDiscRadii[MAX_DISCS];
uniform float uDiscStrengths[MAX_DISCS];

uniform vec2 uLineA;
uniform vec2 uLineB;
uniform float uLineWidthCells;

uniform vec2 uRingCenter;
uniform float uRingRadiusCells;
uniform float uRingWallCells;

uniform vec2 uRadialCenter;
uniform float uRadialCoreCells;
uniform float uRadialRadiusCells;
uniform float uRadialCoreStrength;
uniform float uRadialHaloStrength;

uniform vec2 uStructCenter;
uniform float uStructSemiMajorCells;
uniform float uStructSemiMinorCells;
uniform float uStructRotation;
uniform float uStructAmplitude;
uniform float uStructCoreCells;

uniform uint uSeed;

out vec4 outColor;

/** Shortest toroidal offset from `center` to `point`. */
vec2 toroidal(vec2 point, vec2 center) {
  vec2 grid = vec2(uGrid);
  vec2 delta = point - center;
  return delta - grid * floor(delta / grid + 0.5);
}

float discMask(vec2 point, vec2 center, float radius) {
  float dist = length(toroidal(point, center));
  return 1.0 - smoothstep(radius - uSoftnessCells, radius + uSoftnessCells, dist);
}

/** Deterministic 0..1 hash of the seed, used for the structured pattern's phases. */
float hash11(float x) {
  return fract(sin(x * 12.9898) * 43758.5453);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 base = (uMode == 0) ? vec2(1.0, 0.0) : texelFetch(uField, p, 0).xy;
  vec2 point = vec2(p) + 0.5;

  float mask = 0.0;

  if (uPattern <= 2) {
    // single / competing / sparse: a set of discs.
    for (int i = 0; i < MAX_DISCS; i++) {
      if (i >= uDiscCount) break;
      mask = max(mask, discMask(point, uDiscCenters[i], uDiscRadii[i]) * uDiscStrengths[i]);
    }
  } else if (uPattern == 3) {
    // line: distance to the segment a-b, measured in the wrapped frame of `a`.
    vec2 ab = toroidal(uLineB, uLineA);
    vec2 ap = toroidal(point, uLineA);
    float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    float dist = length(ap - ab * t);
    float halfWidth = max(uLineWidthCells * 0.5, 0.5);
    mask = 1.0 - smoothstep(halfWidth - uSoftnessCells, halfWidth + uSoftnessCells, dist);
  } else if (uPattern == 4) {
    // ring: a band of half-thickness wall/2 at the given radius.
    float dist = length(toroidal(point, uRingCenter));
    float halfWall = max(uRingWallCells * 0.5, 0.5);
    mask = 1.0 - smoothstep(halfWall - uSoftnessCells, halfWall + uSoftnessCells, abs(dist - uRingRadiusCells));
  } else if (uPattern == 5) {
    // radial: a viable core inside a much wider, near-threshold halo.
    float dist = length(toroidal(point, uRadialCenter));
    float core = 1.0 - smoothstep(uRadialCoreCells - uSoftnessCells, uRadialCoreCells + uSoftnessCells, dist);
    float halo = 1.0 - smoothstep(uRadialCoreCells, max(uRadialRadiusCells, uRadialCoreCells + 1.0), dist);
    mask = max(core * uRadialCoreStrength, halo * uRadialHaloStrength);
  } else {
    // structured: a low-amplitude, band-limited perturbation confined to an elliptical support,
    // plus one viable core (the core alone must be enough to nucleate).
    vec2 d = toroidal(point, uStructCenter);
    float c = cos(uStructRotation);
    float s = sin(uStructRotation);
    vec2 rotated = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    float semiMajor = max(uStructSemiMajorCells, 1.0);
    float semiMinor = max(uStructSemiMinorCells, 1.0);
    float ellipse = length(vec2(rotated.x / semiMajor, rotated.y / semiMinor));
    float support = 1.0 - smoothstep(0.85, 1.0, ellipse);
    float phase = hash11(float(uSeed) * 0.001) * 6.2831853;
    float wave =
      sin(rotated.x * 0.35 + phase) +
      sin(rotated.y * 0.41 + phase * 1.7) +
      sin((rotated.x + rotated.y) * 0.23 + phase * 2.3);
    // `wave` lies in [-3, 3]; map to a bounded 0..1 perturbation and scale by the low amplitude.
    float perturbation = clamp(0.5 + wave / 6.0, 0.0, 1.0);
    float structured = support * perturbation * uStructAmplitude;
    mask = max(structured, discMask(point, uStructCenter, uStructCoreCells));
  }

  vec2 result = mix(base, uTarget, clamp(mask * uShapeStrength * uStrength, 0.0, 1.0));
  outColor = vec4(clamp(result, 0.0, 1.0), 0.0, 1.0);
}
