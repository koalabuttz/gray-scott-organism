# An Organism in Darkness

An autonomous fullscreen Gray–Scott reaction–diffusion artwork. A small
mathematical organism emerges from darkness, grows, transforms, collapses,
and begins again. It runs without visible controls.

## Run

Requires Node 22+, npm, and Chromium with WebGL2 and `EXT_color_buffer_float`.

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5199/. The piece starts in darkness and develops on its own.
The current build is silent. Click the canvas or press Enter to request fullscreen;
Escape leaves it. You can watch without activating fullscreen.

For a static build: `npm run build`, then `npm run preview -- --host 127.0.0.1`.

## Laboratory

Press the backquote key (`~`) to show or hide the laboratory.

| Control | Action |
|---|---|
| `F`, `k`, `Du`, `Dv` sliders | Parameter override: takes precedence over the curator's trajectory but never pauses chemistry. |
| `release parameters` | Blends from the override back onto the current base parameters over 15 seconds. |
| `pause` | Suspends transport; resuming continues from the preserved state with no catch-up burst. |
| `speed` | 0.25×–6× (12× on the exploration grid). The presentation default is 3×. |
| `restart (new seed)` | New root seed, cleared field, new arc. |
| `reseed here` | A new single seed at a random location (radius from the `radius` slider). |
| `exploration` | Toggles the lab-only 512² grid for finding regimes; restarts the organism. |
| `radius` | Seed radius in chemical cells (2–40) for `reseed here` and the genesis kinds. |
| `skip movement` | Advances the curator to its next movement (15 s crossfade); chemistry keeps running, no reset. |
| `restart arc` | Begins a fresh arc from a new root seed. |
| genesis selector (`single` … `structured`) | Reseeds one of the seven §4.4 patterns at strength 1. |
| trajectory import / export | Validates a trajectory document (never evaluated) from a file or textarea, or downloads the active document as JSON. |
| diagnostics view (`none`/`analysis`/`topology`/`spectrum`/`camera`) | Draws the requested overlay: reduced field, label/hole proxy, or band energies; `none`/`camera` show nothing. |
| screenshot / copy base64 / copy state | Saves the composite as PNG, or exposes it as `window.__lastCaptureBase64` / `window.__lastStateSnapshot`. |
| start / stop recording | Records the canvas to WebM (see `architecture-plan.md` §10). |
| status readout | Renderer, fps, steps/s, resource counts, seed, parameters, epoch, activation, movement/arc/progress, trajectory provenance, tier-1 chemistry health, presentation descriptors and events. |

[Artistic brief](idea.md) ·
[Design & build history](architecture-plan.md) ·
[Evidence](artifacts/)
