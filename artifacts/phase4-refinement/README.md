# Phase-4 round-B visual/artistic refinement — before/after evidence

Plan §12.4 ("Tune: pacing, silence, transitions, colour, bloom, material response… Remove anything
that reads as a technology demonstration"). These are refinements of the **approved** Phase-1 image
(the operator's "fine for now"), not a redesign: every change is a separately toggleable config knob,
measured before/after on one mature field, and presented here as a capture pair.

Reproduce everything with:

```bash
REFINE=1 npx playwright test --project=headless-gpu refinement.spec.ts
```

## The field every capture uses

One mature organism at the arc-tuned parameters — single seed at `[0.44, 0.53]` radius 6 cells,
`F/k/Du/Dv = 0.029/0.057/0.16/0.08`, 16 000 delivered steps, 768² simulation grid, 1920×1080 canvas,
overhead camera unless the file says `grazing`. Field: occupied 0.6311, mean V 0.1614, edge density
0.04440, reaction activity 0.013889.

`before-*.png` is the **approved** render: all refinement knobs at 0 and the original §5.4 bloom
(gain .04, threshold 1.0, knee after the reduction). `after-*.png` applies the shipped config.

## Pairs

| # | refinement | before | after |
|---|---|---|---|
| 1 | thickness-driven **neutralization** | `before-overhead.png` | `after-thickness-color.png` |
| 2 | interior darkening for volume | `before-overhead.png` | `after-interior-darkening.png` |
| 3 | bloom gain | `before-bloom.png` | `after-bloom.png` |
| 4 | boundary-keyed roughness variation | `before-overhead.png` | `after-roughness-variation.png` |
| — | all accepted refinements (overhead) | `before-overhead.png` | `after-all-overhead.png` |
| — | all accepted refinements (grazing) | `before-grazing.png` | `after-all-grazing.png` |
| 3 | **REJECTED** post-average knee at a matching amplitude | `after-bloom.png` | `after-bloom-post-average-rejected.png` |

`changes.json` carries every measurement: the luminance statistics, the lit-pixel colour statistics
(mean RGB, `R−B`, mean HSV saturation, 12-bin hue histogram), the isolated bloom contribution (latest
gain vs the same frame at gain 0), the pixelwise difference of each variant against the all-off
baseline, and a `notes` block recording the labels the numbers must be read with.

## Measured (mature field, overhead camera, 0–255)

| variant | mean | p50 | p99 | max | clipped | lit mean RGB | R−B | sat | bloom Δ | bloom cover |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| before (approved) | 10.768 | 0 | 137 | 246 | 0.0000 % | 40.44, 41.66, 42.87 | −2.44 | 0.0751 | 0 | 0.00 % |
| #1 neutralization only | 10.467 | 0 | 136 | 246 | 0.0000 % | 41.12, 41.76, 42.36 | −1.23 | 0.0385 | 0 | 0.00 % |
| #2 darkening only (isolated) | 9.052 | 0 | 124 | 244 | 0.0000 % | — | −2.19 | 0.0738 | 0 | 0.00 % |
| #4 roughness only | 10.714 | 0 | 137 | 246 | 0.0000 % | — | −2.43 | 0.0753 | 0 | 0.00 % |
| material combined | 8.761 | 0 | 123 | 244 | 0.0000 % | — | −1.16 | 0.0394 | 0 | 0.00 % |
| **after (all accepted)** | **8.785** | **0** | **123** | **244** | **0.0000 %** | — | **−1.16** | **0.0396** | **12** | **3.31 %** |
| after, grazing view | 19.258 | 2 | 145 | 249 | 0.0000 % | — | −0.97 | 0.0369 | 50 | 4.06 % |
| grazing before | 24.000 | 2 | — | — | — | — | — | — | — | — |
| REJECTED post-average knee (t 0.4) | 10.230 | 0 | 126 | 244 | 0.0000 % | — | −1.03 | 0.0441 | 18 | **35.34 %** |

## #1 is thickness-driven neutralization, not an amber moment

The chroma term is a per-channel Beer–Lambert transmittance keyed on the same blurred, saturating
support **thickness** the §5.2 height field is built from (blue absorbed twice as fast as green, none
in red). Its measured effect is a **reduction of the frame's cool cast toward neutral** — it does not
add saturation and produces no perceptible amber:

- `R−B` −2.44 → −1.23 (toward zero, i.e. less blue);
- mean HSV saturation 0.0751 → **0.0385** — *lower*, i.e. more neutral, not less;
- lit-pixel `warmFraction` (share with `R−B ≥ 2`) is **exactly 0** — no lit pixel reaches a
  just-noticeable warm cast;
- warm hue bins are negligible: bin 0 (0–30°, red/amber) 199 px, bins 0–2 (0–90°) 699 px, bins 0+2+4
  735 px, out of 506 797 lit pixels → **0.039 % / 0.138 % / 0.145 %**.

An earlier draft of this artifact called the effect a "precious amber moment" at ≈0.5 % of lit pixels.
That was overstated (the ≈0.5 % figure counted hue-classified pixels, not all lit pixels, and no warmth
metric supported it); the wording and the figure are dropped. The refinement's justification is the
move toward the brief's *near-neutral cool-white base* — the palette is measurably **more** neutral
after it, and the rare non-blue pixels are not a colour event.

## #2 interior darkening — two separate tables

The two series must not be read as one, because the earlier draft mixed an **isolated** sample with a
**combined** sweep. Isolated = only #2 is on; combined = #1 and #4 are also at their accepted settings.

**Isolated (#2 only):**

| interior darkening | mean | p95 | peak Δ vs before |
|---|---:|---:|---:|
| 0 (before) | 10.768 | 58 | — |
| **0.45 (shipped)** | **9.052** | **48** | **20** |

**Combined sweep (#1 and #4 on):**

| interior darkening | mean | p99 | peak Δ vs before |
|---|---:|---:|---:|
| 0.25 | 9.466 | 129 | 20 |
| **0.45 (shipped)** | **8.761** | **123** | **24** |
| 0.65 | 8.102 | 117 | 32 |

The isolated and combined 0.45 means therefore differ (9.052 vs 8.761) — the combined figure includes
the neutralization and the roughness variation, which darken the frame on their own. In both series the
term is *neutral* (the hue histogram is unchanged) and only attenuates, so p50 stays 0.

## #4 roughness stays inside the §5.3 band

Local roughness is keyed on the blurred boundary magnitude (`|∇V|`, the active front) and is **clamped
into the plan's §5.3 band [0.24, 0.36]** (`material.frag`, `uRoughnessBand = MATERIAL.roughnessRange`).
The clamp is load-bearing: at the calibrated base 0.36 with the shipped variation 0.35 the unclamped
value at zero boundary activity is `0.36 × (1 − 0.35) = 0.234`, *below* the 0.24 floor. With the clamp,
activity 0 → 0.24 and activity 1 → 0.36. `tests/material-response.test.ts` asserts both endpoints and
sweeps activity × variation. Measured effect: 5.1 % of pixels changed at a peak Δ of 11/255 and a mean
Δ of 0.05/255.

## The bloom (#3) finding

The queued observation was that bloom was imperceptible — **byte-identical** statistics at gain 0 and
0.12. The cause was not the gain: the knee was applied to the **already-reduced** half-resolution
level, whose overhead maximum is ≈0.3, so the plan's "soft knee at linear luminance 1.0" could never be
crossed. `legacy-bloom` in `changes.json` reproduces the approved config exactly (changed 0.000 %,
maxΔ 0 — byte-identical to gain 0). `bloom-down.frag` now applies the knee to each source tap
*before* the 13-tap reduction — i.e. to real linear luminance — and the working point was then found
with a threshold × gain grid:

| threshold | gain 0.04 | gain 0.12 | gain 0.3 |
|---|---|---|---|
| 0.45 | Δ8 / 23.2 % | Δ20 / 32.8 % | Δ45 / 35.0 % |
| **0.6** | Δ4 / 1.6 % | **Δ12 / 3.3 %** | Δ26 / 5.4 % |
| 0.8 | Δ2 / 0.2 % | Δ5 / 0.4 % | Δ12 / 0.7 % |
| 1.0 | Δ1 / 0.0 % | Δ2 / 0.0 % | Δ4 / 0.1 % |

(`Δ` = peak per-channel change in 255ths, `%` = share of pixels changed.) The cell is amplitude on the
peaks *and* coverage. Thresholds below 0.6 turn the bloom into a broad lift (0.45 at gain 0.12 already
covers a third of the frame); the shipped point `threshold 0.6, gain 0.12` (the plan's own cap) puts a
peak Δ of 12/255 on 3.3 % of the overhead frame and moves the frame mean by +0.024/255 — a glow on the
hottest rims, not a haze. `after-bloom-post-average-rejected.png` is the rejected alternative: to reach
a comparable amplitude with the old knee order you must drop the threshold to 0.4, which then covers
35.3 % of the frame.

## Hard constraints (asserted in the spec, not assumed)

- `p50` is **exactly 0** for every variant, and highlight clipping is **0.0000 %**.
- The palette stays near-neutral: mean HSV saturation ≤ 0.08 and `|R−B|` ≤ 8 everywhere; the
  neutralization term *lowers* saturation and never produces `R−B ≥ 2`.
- The all-off config is **bit-for-bit** its own identity as a **round trip**, not a self-diff: the spec
  stashes the all-off frame, exercises **every** toggle at its accepted setting (the material block and
  the shipped bloom threshold/gain/knee order — recorded as the `toggle-exercise` sample), restores
  all-off, re-renders and requires a byte-identical composite (`changedFraction` 0, `maxDelta` 0).
- Bloom is effective (> 0.02 % of pixels changed) yet restrained (< 5 %) and never lifts black.
- `artifacts/phase1-gate/` is untouched (SHA-256 of every file unchanged — `phase1-gate-hashes.txt`).

## Config in force after this pass

```ts
REFINEMENT = { interiorDarkening: 0.45, absorptionChroma: 0.14, chromaGateLow: 0.32, chromaGateHigh: 0.78, roughnessVariation: 0.35 }
BLOOM = { levels: 3, threshold: 0.6, knee: 0.5, gain: 0.12, gainCap: 0.12 }
```
