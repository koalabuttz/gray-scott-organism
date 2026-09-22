# Phase-4 round 2 — thickness stratification (before/after)

Operator feedback at `FinalFullArcReview`: *"It's hard to tell — there's not a lot of thickness
variation."* This pass makes the organism's **thin edges and thick cores** separate, and measures it.

Reproduce:

```bash
REFINE=1 npx playwright test --project=headless-gpu refinement.spec.ts
```

(the round-2 test is the second one in that file; it writes this directory)

## The diagnosis, confirmed by measurement

The §5.2 height is `relief × (0.8·(1 − exp(−V/0.25)) + 0.2·|∇V|)`. That **saturating** remap maps
every moderate-to-deep V into nearly the same height, so a thick core and a thin filament sat at
almost the same relief. Measured on the mature field at the shipped relief 0.006: the height across
the organism spans only **0.00083 … 0.00434** world units — i.e. the body used **58.5 %** of the relief
budget, and the *spread* (`max/p50`) was only **1.244**. The grazing light responds to height
*gradients*, so there was nothing to show.

## Levers, isolated (mature field, overhead; all 0–255)

`litSpread` = p90/p50 of luminance **within lit pixels** (the thickness-variation proxy);
`hSpread` = the height field's own `max/p50` over the organism (support > 0.5).

| variant | relief | litSpread | lit p50 | lit p90 | height min | height p90 | height max | hSpread | relief used | img max | clip ≥250 | sat | R−B |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **before** (shipped round B) | 0.006 | 2.655 | 29 | 77 | 0.00083 | 0.00383 | 0.00434 | 1.244 | 0.585 | 244 | 0.0000 % | 0.0396 | −1.16 |
| #1 remap ref 0.36 · p 1.0 | 0.006 | 3.107 | 28 | 87 | 0.00081 | 0.00417 | 0.00491 | 1.487 | 0.764 | 248 | 0.0000 % | 0.0406 | −1.18 |
| **#1 remap ref 0.36 · p 1.3** (accepted) | 0.006 | 3.111 | 27 | 84 | 0.00093 | 0.00417 | 0.00491 | **1.653** | 0.781 | 243 | 0.0000 % | 0.0417 | −1.18 |
| #1 remap ref 0.42 · p 1.0 | 0.006 | 2.750 | 28 | 77 | 0.00065 | 0.00374 | 0.00465 | 1.466 | 0.667 | 237 | 0.0000 % | 0.0408 | −1.16 |
| #1 remap ref 0.42 · p 1.3 | 0.006 | 2.667 | 27 | 72 | 0.00093 | 0.00417 | 0.00491 | 1.615 | 0.654 | 222 | 0.0000 % | 0.0423 | −1.13 |
| #1 relief 0.007 alone | 0.007 | 2.931 | 29 | 85 | 0.00097 | 0.00446 | 0.00506 | 1.244 | 0.584 | 253 | 0.0030 % | 0.0401 | −1.16 |
| #1 relief 0.008 alone — **rejected** | 0.008 | 3.200 | 30 | 96 | 0.00111 | 0.00510 | 0.00579 | 1.243 | 0.584 | **255** | 0.0592 % | 0.0408 | −1.21 |
| #2 darkening 0.65 alone | 0.006 | 2.769 | 26 | 72 | 0.00083 | 0.00383 | 0.00434 | 1.244 | 0.585 | 243 | 0.0000 % | 0.0400 | −1.13 |
| combined @ relief 0.006 | 0.006 | 3.160 | 25 | 79 | 0.00054 | 0.00399 | 0.00523 | 1.653 | 0.781 | 241 | 0.0000 % | 0.0421 | −1.14 |
| combined @ relief 0.0065 | 0.0065 | 3.400 | 25 | 85 | 0.00059 | 0.00432 | 0.00566 | 1.654 | 0.781 | 248 | 0.0000 % | 0.0416 | −1.16 |
| **after** — combined @ relief 0.007 | 0.007 | **3.640** | 25 | 91 | 0.00063 | 0.00465 | 0.00610 | **1.654** | 0.781 | 252 | 0.0005 % | 0.0418 | −1.16 |
| combined @ relief 0.0075 | 0.0075 | 3.840 | 25 | 96 | 0.00068 | 0.00498 | 0.00653 | 1.653 | 0.781 | 254 | 0.0048 % | 0.0420 | −1.15 |
| combined @ relief 0.008 — **rejected** | 0.008 | 4.040 | 25 | 101 | 0.00072 | 0.00531 | 0.00697 | 1.653 | 0.781 | **255** | 0.0226 % | 0.0421 | −1.15 |
| #3 frontier band 0.05 — **rejected** | 0.007 | 2.813 | 32 | 90 | — | — | — | 1.654 | 0.781 | 252 | 0.0006 % | 0.0191 | −0.67 |
| #3 frontier band 0.12 — **rejected** | 0.007 | 2.659 | 41 | 109 | — | — | — | 1.654 | 0.781 | 252 | 0.0006 % | 0.0149 | −0.40 |
| #3 frontier band 0.25 — **rejected** | 0.007 | 2.920 | 50 | 146 | — | — | — | 1.654 | 0.781 | 252 | 0.0006 % | 0.0136 | −0.13 |
| #4 thin-gloss 0.10 — **rejected** | 0.007 | 3.400 | 25 | 85 | — | — | — | 1.654 | 0.781 | 253 | 0.0009 % | 0.0423 | −1.14 |
| #4 thin-gloss 0.25 — **rejected** | 0.007 | 3.167 | 24 | 76 | — | — | — | 1.654 | 0.781 | 254 | 0.0012 % | 0.0437 | −1.12 |

"combined" = the accepted remap (0.36 / 1.3) + interior darkening 0.65 + the relief in that row.

### The headline numbers

- **lit-pixel spread `p90/p50`: 2.655 → 3.640 (+37 %)**
- **height field over the organism: `min` 0.00083 → 0.00063, `p90` 0.00383 → 0.00465, `max` 0.00434
  → 0.00610** — the body now uses **78.1 %** of the §5.2 relief budget instead of 58.5 %, the cores
  stand **41 % higher** and the filaments sit **24 % lower**, so `max/min` goes 5.2 → 9.7
- both with `p50` still exactly 0, no pixel reaching the 255 ceiling (img max 252), and the palette
  unchanged (saturation 0.0396 → 0.0418, R−B −1.16 → −1.16)

### Grazing view (the operator's judging angle)

| | relief | litSpread | lit p50 | lit mean | height max | hSpread | img max |
|---|---:|---:|---:|---:|---:|---:|---:|
| before-grazing | 0.006 | 2.405 | 2 | 42.5 | 0.00434 | 1.244 | 249 |
| after-grazing | 0.007 | 2.933 (+22 %) | 1 | 39.4 | 0.00610 | 1.654 (+33 %) | 254 |

## Accepted / rejected

- **#1 height response to thickness — ACCEPTED**: normalized remap `clamp(V/0.36, 0, 1)^1.3` for the
  height (a `heightThicknessRef` of 0 keeps the old saturating remap, so this is one toggle), plus the
  relief raised 0.006 → 0.007. The remap alone (relief fixed) moves `hSpread` 1.244 → 1.653 (+33 %);
  the relief widens the absolute band without touching the shape. `.008` would give +52 % on the lit
  spread but saturates a pixel at 255 and puts 0.023 % of the frame at ≥ 250 — **rejected** to keep
  headroom, since the field's peak moves as it evolves.
- **#2 interior darkening 0.45 → 0.65 — ACCEPTED as part of the combination.** Alone it is a small
  effect on the metric (2.655 → 2.769, +4 %) but it contributes to the combined 3.640, and its
  mechanism is the one the operator described (deeper interiors under a brighter skin). It darkens the
  frame's mean (8.79 → 8.93 after the relief raise; the raster's mean is dominated by the black
  background, so the organism's own lit mean rises 25 → 38.5 with the remap).
- **#3 frontier-band emphasis — REJECTED.** On top of the accepted combination every tested gain
  *lowers* the stratification metric (2.81 / 2.66 / 2.92 against 3.640) while flooding the frame
  (mean 8.93 → 11.9 / 15.3 / 19.7, i.e. 1.34× / 1.71× / 2.21×) and desaturating it (0.0418 → 0.019 /
  0.015 / 0.014). The band is `|∇V|²` gated to thin material; the evidence, and the rejected capture
  `after-frontier-band-rejected.png`, are kept. `frontBoost` stays a documented off knob.
- **#4 thin-gloss roughness coupling — REJECTED.** Making thin regions glossier *reduces* the lit
  spread (3.400 at 0.10 and 3.167 at 0.25, against 3.640) and adds clipping: a smoother surface throws
  a narrower specular lobe, so fewer thin pixels catch the grazing light — the measured opposite of the
  intended cue. `glossThin` stays a documented off knob.

## Files

- `before-overhead.png` / `after-all-overhead.png` — the accepted pair, overhead presentation camera
- `before-grazing.png` / `after-all-grazing.png` — the same pair at the 12° / 1.75-unit grazing view
- `after-height-remap.png` — lever #1 alone (normalized remap, relief still 0.006)
- `after-frontier-band-rejected.png` — the rejected #3 at gain 0.25
- `changes.json` — every row above with the full statistics and the config in force

`before-overhead.png` and `before-grazing.png` are **byte-identical (SHA-256) to round B's shipped
`after-all-overhead.png` / `after-all-grazing.png`** — i.e. the "before" this pass measures against is
exactly the render the operator reviewed, not a re-derivation of it.

## Unit-pinned model

The shader arithmetic for both round-2 knobs is mirrored in TypeScript
(`src/visual/material-response.ts`) and pinned by `tests/material-response.test.ts`, so the claim
"could not leave the §5.2 relief bound / the §5.3 roughness band" is checked rather than asserted:
`heightThickness` (both branches bounded to [0, 1], monotonic, and measurably wider than the saturating
remap over the mature field's V range) and the `gloss`/`thinness` factor (identity at 0, and it only
ever reduces roughness inside the band).

## Config in force after round 2

```ts
SURFACE.reliefAmplitude = 0.007;                       // was 0.006
REFINEMENT = { interiorDarkening: 0.65,                // was 0.45
               heightThicknessRef: 0.36, heightThicknessPower: 1.3,
               frontBoost: 0, glossThin: 0, ... }
```

Round B's own evidence (`../changes.json`, `../*.png`) is reproduced byte-for-byte by this run: the
round-B test pins its material and relief, so the only change to `../changes.json` is that each
sample's echoed `refinement` object now carries the new round-2 knobs.
