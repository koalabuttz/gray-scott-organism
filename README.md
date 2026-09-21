# An Organism in Darkness

An autonomous fullscreen Gray–Scott reaction–diffusion artwork. A small
mathematical organism emerges from darkness, grows, transforms, collapses,
and begins again. It runs without visible controls.

## Initial Prompts

Here are some of the prompts I used while exploring potential concepts:                               
- can I get a list of mathematics concepts that have cool visualizations?
- What are some of the most common combinations of these visualizations out there?
- Now, based on what we've spoken about, what are some of the least common combinations of these visualizations?
- Please search online for prior art regarding this
- within these, can you think of any novel or especially interesting combinations or chains of concepts?   
- which of these do you think would result in interesting emergent art/be the prettiest/spark the most joy?
- Now, I want you to pitch each of these to me as an experience. within the experience, think black background, no controls visible (possibly hidden behind a key press, but I also like the idea of something being curated), possibly using additional 3d or 2d flare (glow, bloom, sound, reflection, physics, gravity, light, etc.). This will not be a dashboard of options - each one should get the best pitch you can give them to win their singular spot in the experience.
- Explain how you think we would approach building the Reaction-Diffusion as a standalone experience
- Turn this into a prompt to send an agent to build

## Reflection 
                                                                                                                                            Mathematics-based visualizations always fascinate me, so I was happy to have an excuse to work with them. As you can see in my prompting, I wanted to give some love to a lesser-known one, but I chose the Gray-Scott Reaction Diffusion option based on the pitch. Within my prompting I led the agent through a series of questions towards the kind of experience I was looking for. In the end, I chose the one that interested me the most and looked doable in the free time I had. This initial conversation provided me with ideas and a prompt for a builder agent, which went on to be the one I spent the most time with. I had the builder agent spawn subagents with larger models for implementation planning and code reviews. While waiting for these subagents to finish cost some time, it proved to be useful in terms of catching bugs and ensuring correctness. Because of this review loop, I was able to stay hands off on the coding and focus on the experience, tweaking things like the speed or curation of the visuals. While the agent attempted to use Playwright and screenshots to assist with development, it's doesn't have particularly great taste on its own. As of writing this, audio and further visual flavor is still being added and I hope to make it more compelling in time.

## Run

Requires Node 22+, npm, and Chromium with WebGL2 and `EXT_color_buffer_float`.

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:5199/. The piece starts in darkness and develops on its own.
Click the canvas or press Enter once to unlock the generative ambient soundtrack and request
fullscreen; Escape leaves fullscreen. You can watch without activating fullscreen, and the piece
runs silently until you do. The sound is sparse and caused by the organism — it can be silent
for long stretches — and it fades to true silence when the field dies.

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
| `mute` | Smoothly mutes/unmutes the master path (pause and a hidden tab mute too, and resume without a backlog). |
| genesis selector (`single` … `structured`) | Reseeds one of the seven §4.4 patterns at strength 1. |
| trajectory import / export | Validates a trajectory document (never evaluated) from a file or textarea, or downloads the active document as JSON. |
| diagnostics view (`none`/`analysis`/`topology`/`spectrum`/`camera`) | Draws the requested overlay: reduced field, label/hole proxy, or band energies; `none`/`camera` show nothing. |
| screenshot / copy base64 / copy state | Saves the composite as PNG, or exposes it as `window.__lastCaptureBase64` / `window.__lastStateSnapshot`. |
| start / stop recording | Records the canvas to WebM (see `architecture-plan.md` §10). |
| status readout | Renderer, fps, steps/s, resource counts, seed, parameters, epoch, activation, movement/arc/progress, trajectory provenance, tier-1 chemistry health, presentation descriptors and events. |

[Artistic brief](idea.md) ·
[Design & build history](architecture-plan.md) ·
[Evidence](artifacts/)
