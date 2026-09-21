# Phase 1 material gate — An Organism in Darkness

Everything here was captured from the running piece, unmodified: no image editing, no
camera cheat beyond the documented grazing-view camera override, no extra effects.

The three mandatory stills are **one continuous run from one genesis seed** — the plan's
"one strong genesis condition" — captured at three moments of the same organism.

## Machine and harness

- Renderer: `ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (RPL-U) (0x0000A7A9)), Intel open-source Mesa driver)`
- Canvas: 1920x1080 for the stills, 1280x720 for the clip
- Internal HDR scene: 1920x1080 for the stills (§11.1 caps the scene at a 1920x1080-equivalent pixel count; the renderer re-derives it on resize)
- Throughput during the session: 60.0 rendered fps (clip resolution), 120.0 simulation steps/s
- Configuration in force at the mature capture, read back from the live published state: simulation grid 768x768, dt = 1, 120 nominal steps/performance-second, F/k/Du/Dv = 0.029/0.057/0.16/0.08, relief 0.006, roughness 0.36, F0 0.04, exposure 1.5 (applied by the composite pass), bloom gain 0.04 cap 0.12 with a soft knee at linear luminance 1, light intensity 30 at 8 degrees elevation / 135 degrees azimuth, environment 0.05, emission gain 0.05
- Session root seed: `2856951971` — this is the app's replay seed for the whole session. The gate captures do not derive their genesis from it; each capture's exact genesis command is recorded below.

## Test harness

- Playwright project: `headless-gpu`
- Mode: headless (Chromium new headless through the `chromium` channel) — no window is created, so a test run cannot take foreground focus
- Launch arguments: `--no-sandbox --disable-dev-shm-usage --ignore-gpu-blocklist --enable-unsafe-swiftshader --use-angle=vulkan`
- Renderer reached by this run: `ANGLE (Intel, Vulkan 1.4.305 (Intel(R) Graphics (RPL-U) (0x0000A7A9)), Intel open-source Mesa driver)`
- Software rasteriser: **false**
- `EXT_color_buffer_float` present in this run: **true**
- The default suite (`npm run test:browser`) runs the headless project; a headless run on this
  machine still reaches the real GPU because ANGLE's Vulkan backend drives the Intel device
  through the DRI render node. The old headless shell has no such path and falls back to
  SwiftShader, which is why the `chromium` channel is required rather than assumed.
- Reference readings from a headed run on the same machine (ANGLE + Mesa GL-ES path, the
  operator's actual presentation path): `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-U),
  OpenGL ES 3.2)` with the same format results. The two paths agree on every assertion in this
  report; the renderer strings differ, which is why both are recorded.

- The stills and the clip are canvas content only: the laboratory panel is DOM, not canvas.

## Genesis commands actually applied

- **near-invisible state**
  - `kind=single mode=replace seed=2026031 center=[0.44153, 0.52601] radiusCells=6.206 strength=0.97181`
- **mature wet-material state**
  - `kind=single mode=replace seed=2026031 center=[0.44153, 0.52601] radiusCells=6.206 strength=0.97181`
- **grazing-edge close view**
  - `kind=single mode=replace seed=2026031 center=[0.44153, 0.52601] radiusCells=6.206 strength=0.97181`
- **REJECTED CONTROL: 4x4 uniform seed lattice**
  - 16 recorded commands (full list in `captures.json`): a uniform 4x4 lattice, spacing 0.2500 of the domain, each `kind=single` with radiusCells=5, strength=1, the first `mode=replace` and the rest `mode=inject`, deliberately unperturbed so the lattice is exact.
- The candidate sheet reuses the single-seed command verbatim (seed 2026031, centre [0.44000, 0.53000], radiusCells 6, strength 1, mode=replace, §4.4 perturbation enabled); its per-capture command is in `captures.json`.

## Captures

### near-invisible state

- File: `phase1-gate/01-near-invisible.png`
- Parameters: F=0.029, k=0.057, Du=0.16, Dv=0.08
- Genesis: 1 command(s); the same continuous run, 600 delivered steps after the single genesis
- Delivered steps: 600
- Image: max=245, mean=0.056, p50=0, p95=0, p99=0, lit=0.12%, bright=0.08%, clipped=0.0000%
- Field: occupied=0.0020, maxV=0.345, extent=0.060x0.060, centroid=[0.441, 0.525], symmetry at a 192x192-cell period=-0.004
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### mature wet-material state

- File: `phase1-gate/02-mature-wet-material.png`
- Parameters: F=0.029, k=0.057, Du=0.16, Dv=0.08
- Genesis: 1 command(s); same continuous run continued to 16000 delivered steps (GL submission for the 15,400-step increment measured 0.6 s; GPU execution is asynchronous and is drained before the capture), overhead camera, no camera or material override
- Delivered steps: 16000
- Image: max=246, mean=10.761, p50=0, p95=57, p99=137, lit=24.99%, bright=13.77%, clipped=0.0000%
- Field: occupied=0.6316, maxV=0.379, extent=1.000x1.000, centroid=[0.494, 0.503], symmetry at a 192x192-cell period=-0.238
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### grazing-edge close view

- File: `phase1-gate/03-grazing-edge-close.png`
- Parameters: F=0.029, k=0.057, Du=0.16, Dv=0.08
- Genesis: 1 command(s); same field and material; only the documented camera override to 12 degrees elevation at 1.75 world units
- Delivered steps: 16000
- Image: max=250, mean=24.252, p50=2, p95=106, p99=164, lit=47.61%, bright=27.87%, clipped=0.0013%
- Field: occupied=0.6316, maxV=0.379, extent=1.000x1.000, centroid=[0.494, 0.503], symmetry at a 192x192-cell period=-0.238
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 0.2100 rad at distance 1.750

### REJECTED CONTROL: 4x4 uniform seed lattice

- File: `phase1-gate/controls/lattice-4x4-rejected.png`
- Parameters: F=0.029, k=0.057, Du=0.16, Dv=0.08
- Genesis: 16 command(s); rejected control, NOT an approval asset: 4x4 identical seeds on a uniform lattice, same parameters and same delivered steps as the mature capture. Shows what the repetition check detects.
- Delivered steps: 16000
- Image: max=244, mean=10.514, p50=0, p95=60, p99=121, lit=24.24%, bright=13.72%, clipped=0.0000%
- Field: occupied=0.6422, maxV=0.337, extent=1.000x1.000, centroid=[0.499, 0.499], symmetry at a 192x192-cell period=0.900
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate labyrinth-fine-0.029-0.059

- File: `phase1-gate/candidates/labyrinth-fine-0.029-0.059.png`
- Parameters: F=0.029, k=0.059, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=250, mean=2.412, p50=0, p95=2, p99=64, lit=4.68%, bright=2.90%, clipped=0.0001%
- Field: occupied=0.0727, maxV=0.393, extent=0.413x0.414, centroid=[0.441, 0.526], symmetry at a 192x192-cell period=-0.101
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate labyrinth-fine-0.029-0.060

- File: `phase1-gate/candidates/labyrinth-fine-0.029-0.060.png`
- Parameters: F=0.029, k=0.06, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=249, mean=1.328, p50=0, p95=0, p99=49, lit=2.62%, bright=1.53%, clipped=0.0000%
- Field: occupied=0.0387, maxV=0.379, extent=0.311x0.309, centroid=[0.440, 0.525], symmetry at a 192x192-cell period=-0.084
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate worms-0.030-0.062

- File: `phase1-gate/candidates/worms-0.030-0.062.png`
- Parameters: F=0.03, k=0.062, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=241, mean=0.317, p50=0, p95=0, p99=0, lit=0.63%, bright=0.35%, clipped=0.0000%
- Field: occupied=0.0090, maxV=0.381, extent=0.158x0.160, centroid=[0.441, 0.525], symmetry at a 192x192-cell period=-0.024
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate dense-0.022-0.054

- File: `phase1-gate/candidates/dense-0.022-0.054.png`
- Parameters: F=0.022, k=0.054, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=252, mean=6.980, p50=0, p95=52, p99=114, lit=14.94%, bright=9.07%, clipped=0.0005%
- Field: occupied=0.2293, maxV=0.469, extent=0.721x0.729, centroid=[0.441, 0.525], symmetry at a 192x192-cell period=-0.190
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate nucleation-0.026-0.060

- File: `phase1-gate/candidates/nucleation-0.026-0.060.png`
- Parameters: F=0.026, k=0.06, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=249, mean=1.284, p50=0, p95=0, p99=48, lit=2.56%, bright=1.38%, clipped=0.0000%
- Field: occupied=0.0348, maxV=0.395, extent=0.329x0.335, centroid=[0.443, 0.525], symmetry at a 192x192-cell period=-0.097
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate coral-0.0545-0.062

- File: `phase1-gate/candidates/coral-0.0545-0.062.png`
- Parameters: F=0.0545, k=0.062, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=252, mean=0.870, p50=0, p95=0, p99=41, lit=1.64%, bright=1.16%, clipped=0.0003%
- Field: occupied=0.0294, maxV=0.430, extent=0.230x0.232, centroid=[0.441, 0.525], symmetry at a 192x192-cell period=-0.047
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

### candidate mitosis-0.0367-0.0649

- File: `phase1-gate/candidates/mitosis-0.0367-0.0649.png`
- Parameters: F=0.0367, k=0.0649, Du=0.16, Dv=0.08
- Genesis: 1 command(s); controlled experiment: same single-seed genesis, 8000 delivered steps (mid-growth, before the domain saturates)
- Delivered steps: 8000
- Image: max=0, mean=0.000, p50=0, p95=0, p99=0, lit=0.00%, bright=0.00%, clipped=0.0000%
- Field: occupied=0.0000, maxV=0.000, extent=0.000x0.000, centroid=[0.000, 0.000], symmetry at a 192x192-cell period=1.000
- Live state used: exposure 1.5, bloom gain 0.04, relief 0.006, roughness 0.36, light intensity 30 at elevation 0.1396 rad, camera elevation 1.4661 rad at distance 4.456

## Repetition check

A uniform lattice of identical seeds grown on a translation-invariant torus stays periodic,
which reads as tiled wallpaper rather than one emergent organism. The symmetry score below is
`1 - mean|V(p) - V(p + period)| / mean|V(p) - mean(V)|` at a period of one quarter of the
domain (192 cells) — 1 means the field repeats exactly there, 0 means it does not.

- Mandatory single-seed mature capture: **-0.238**
- Rejected lattice control, same parameters and same steps: **0.900**

The control is kept deliberately so this check can be seen to discriminate; it is not an
approval asset.

## Real-time clip

- File: `phase1-gate/04-real-time-clip.webm`
- 18.2 MiB, recorded as `video/webm;codecs=vp9`
- Verified from the file itself: codec id `V_VP9`, 1280x720, **1801 frames**, **60.03 s**, median frame interval 33 ms (max 40 ms), effective 30.00 fps
- Container view from ffmpeg: `Stream #0:0(eng): Video: vp9, none(tv, bt709), 1280x720, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn (default)`; `Duration: N/A, start: 0.000000, bitrate: N/A`
- Note: MediaRecorder writes no WebM `Duration` element, so container tools report `Duration: N/A`. The duration above is derived from the file's own cluster and block timecodes (see `tests/support/webm.ts`), and independently corroborated by the ffmpeg container view.
- Silent, as permitted: no audio system exists in Phase 1.
- Recorded with `canvas.captureStream(30)` + `MediaRecorder` from the live canvas.

## Which (F,k) looked best in the offline search

Selection came from `scripts/tune.ts` (99 (F,k) candidates, 160x160, 12000 steps, one 6-cell
seed; raw table in `artifacts/phase1-tune.txt`). At F = 0.029:

| k | occupied | mean V | edge density | activity | total edge mass |
|---:|---:|---:|---:|---:|---:|
| 0.054 | 0.938 | 0.206 | 0.0214 | 0.0170 | 0.0200 |
| 0.057 | 0.641 | 0.164 | 0.0450 | 0.0141 | **0.0288** |
| 0.059 | 0.544 | 0.144 | 0.0484 | 0.0127 | 0.0263 |
| 0.060 | 0.475 | 0.131 | 0.0513 | 0.0117 | 0.0244 |
| 0.062 | 0.361 | 0.106 | 0.0482 | 0.0097 | 0.0174 |
| >=0.0649 | 0 | 0 | 0 | 0 | dead |

k = 0.057 has the largest total boundary mass and is the mature capture above; k = 0.059 and
k = 0.060 give a finer maze with slightly less mass, so both are kept as candidates. Above
k ~ 0.0649 everything dies — including the textbook mitosis point (F = 0.0367, k = 0.0649),
which is in the candidate sheet precisely because it did **not** survive on this solver.

The growth curve that chose the mature step budget (single seed, 768x768) is in
`artifacts/phase1-growth.json`: occupancy reaches 99% of its long-run plateau by 16,000 steps
(0.63 of the domain, extent 1.0x1.0) and is unchanged through 50,000 steps.

Reproduce any capture with:

```bash
npm run test:gate            # GATE=1 playwright test --project=headless-gpu gate.spec.ts
```

The `--project=headless-gpu` selector matters: running the spec without it would also run the
opt-in headed project, and the last project to finish would own these files.

## Operator checklist (from architecture-plan §12.1)

Approve only if, watching the clip and the stills:

- [ ] it is **tactile rather than coloured texture** — the surface reads as a material, not as a mapped colour ramp
- [ ] it is **shallow, not mountainous** — relief reads as millimetres; no terrain silhouette, no inflated blobs
- [ ] the **canvas boundary is invisible** — no rectangle, no grey floor, no visible domain edge
- [ ] **black dominates** — the majority of the frame is true black and the organism emerges from darkness
- [ ] **bloom is restrained** — glow appears only around genuinely intense features and never as a global haze
- [ ] it reads as **one emergent organism**, not a repeating lattice

And, for the piece as a whole:

- [ ] it reads as an unknown physical organism rather than a reaction-diffusion shader demo
- [ ] the grazing-edge close view makes local structure legible without exaggeration
- [ ] the near-invisible state is genuinely near-invisible while still present

A passing test suite does not substitute for this approval.
