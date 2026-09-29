# Fresh Gray–Scott growth captures

Four new stills and one GIF from **one continuous seeded run** of the actual WebGL2 artwork, captured headless on the hardware GPU. They supplement the historical Phase-1 gate evidence and appear in the main README.

- `01-developing-overhead.png` — 4,100 delivered simulation steps; organism occupancy 0.0490.
- `02-growing-overhead.png` — 10,100 steps; occupancy 0.2998.
- `03-mature-overhead.png` — 20,000 steps; occupancy 0.6400. The fully developed circular rim fades out **within** the image, not at a hard crop.
- `04-mature-grazing-close.png` — **the same 20,000-step field**; only the camera is overridden to 0.21 rad elevation, distance 1.75, focus [0.5, 0.5].
- `growth-stage.gif` — a looping 800×450, 64-frame, 5.33-second GIF from 16 overhead captures in `frames/` spanning 800–20,000 steps. The overhead camera is fixed at distance 4.2, focus [0.5, 0.5] for **every** frame. Source frames are at **unequal simulation-step intervals** and played at three source frames/second (duplicated to 12 fps for compatibility). This is a stage-development time-compression montage, **not real-time footage** or interpolation of the chemistry.

The manual-lab run used `F=0.029`, `k=0.057`, `Du=0.16`, `Dv=0.08` on the default chemical grid, with a single unperturbed seed at [0.44, 0.53], radius 6 cells. In a separate probe this field's occupancy remained about 0.64 from 20,000 to 40,000 steps; additional waiting does not fill the picture. The closer but constant overhead framing makes the mature form larger while retaining its full fade. `captures.json` records the step list, camera distance and frame measurements. The stills are 1280×720. No image editing was applied; the GIF uses an ffmpeg palette (128 colours, Bayer dithering, Lanczos downscale) to represent the captured frames. GIF palette quantization necessarily loses some subtle dark tones.

Reproduce locally with:

```bash
FRESH_CAPTURE=1 npx playwright test --config playwright.config.ts --project=headless-gpu fresh-captures.spec.ts
ffmpeg -y -framerate 3 -i artifacts/fresh-growth-2026-09/frames/frame-%03d.png -vf 'fps=12,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4' -loop 0 artifacts/fresh-growth-2026-09/growth-stage.gif
```
