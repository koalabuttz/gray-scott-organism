Build a standalone, fullscreen audiovisual reaction–diffusion experience.

The goal is not to make a simulator, dashboard, educational demo, or parameter playground. The finished piece should feel like encountering a small mathematical organism in darkness: something that emerges, grows, transforms, collapses, and begins again.

The default experience should contain no visible UI, controls, labels, charts, parameter readouts, explanatory text, borders, panels, or mouse-driven widgets.

Think:

blackness → emergence → growth → transformation → dissolution → rebirth

The mathematics should create the art. Visual and audio effects should reveal what the system is doing rather than decorate it arbitrarily.

## Core mathematical system

Use a Gray–Scott reaction–diffusion system as the initial mathematical substrate.

Maintain two scalar fields, U and V, evolving approximately according to:

∂U/∂t = Du∇²U - UV² + F(1-U)

∂V/∂t = Dv∇²V + UV² - (F+k)V

Run the simulation on the GPU using ping-pong floating-point textures or an equivalent high-performance GPU technique.

Target smooth realtime performance at a visually high simulation resolution.

The architecture should allow multiple simulation steps per rendered frame independently of display framerate.

Do not expose Gray–Scott parameters in the default presentation.

## Important artistic principle

Do NOT directly render the reaction–diffusion concentration field as a colored texture.

Instead treat the simulation as a hidden physical system and derive a virtual material from it.

Pipeline conceptually:

reaction concentrations
→ gradients / activity / morphology
→ surface properties
→ lighting
→ optical effects
→ final image

The result should feel physical, tactile, and difficult to categorize.

Possible impressions:

- wet obsidian
- translucent biological membrane
- oil or ferrofluid
- microscopic mineral growth
- alien tissue
- glassy cellular material

It should not look like ordinary procedural shader art or a heightmap terrain.

## Surface and depth

Derive a subtle height/displacement field from reaction concentration and/or concentration gradients.

Keep relief shallow. Think millimeters, not mountains.

Compute normals from the field so that grazing light reveals edges and local structure.

Possible material responses:

- subtle specular reflection
- soft subsurface emission
- translucent depth
- faint refraction around active boundaries
- restrained bloom only around genuinely intense features
- very sparse particles or dust to establish spatial depth

The world should remain overwhelmingly black.

The pattern should often be nearly invisible except where structure catches light.

Avoid excessive glow.

## Visual composition

True black should be an active compositional element.

Do not always fill the screen.

Allow the organism to occupy perhaps 50–80% of the frame at times.

Let structures emerge from darkness without any visible canvas boundary.

Allow genuine periods of near-stillness or almost total darkness.

Silence and emptiness are valid states.

The piece should sometimes become visually spectacular, but it should earn those moments.

## Curated evolution

Do not let the system simply sit at one fixed Gray–Scott preset.

Build an invisible “curator” or “director” subsystem.

Its job is to guide the mathematical system through compelling regions of parameter space over long periods.

The experience should feel composed while remaining genuinely emergent.

Instead of storing only isolated presets such as:

F = X
k = Y

store and explore trajectories through parameter space.

For example:

(F1,k1)
→ (F2,k2)
→ (F3,k3)

A successful trajectory might cause:

isolated cells
→ replication
→ worms
→ merging structures
→ labyrinth
→ overgrowth
→ fragmentation
→ collapse

Transitions between regimes are part of the artwork.

The system should interpolate parameters slowly enough that morphology evolves naturally rather than visibly switching modes.

A complete arc may take roughly 10–30 minutes.

## Dramaturgy

Design the curator around broad movements such as:

1. Dormancy
2. Nucleation
3. Cellular growth
4. Replication
5. Connection
6. Labyrinth
7. Overgrowth
8. Collapse
9. Stillness
10. Rebirth

These should not behave like rigid scripted chapters.

They are compositional intentions.

The mathematical state should retain room for unexpected outcomes.

## Initial conditions

Initial conditions should be treated as part of the composition.

Support several carefully designed genesis patterns, for example:

- a single central seed
- several competing seeds
- a thin line
- a ring
- sparse random points
- a nearly imperceptible radial gradient
- subtle structured noise

Do not simply initialize everything with uniform random noise.

Add slight stochastic perturbation so repeated performances of the same composition are recognizably related but never identical.

## Structural analysis

Create a lightweight analysis layer that periodically extracts higher-level descriptors from the simulation.

Potential descriptors:

- total reaction activity
- global rate of change
- number of connected regions
- approximate number of holes
- average feature size
- edge density
- spatial entropy
- characteristic spatial frequencies
- approximate symmetry/coherence
- persistence or lifetime of structures

Do not display these values.

They exist to help the piece respond intelligently to its own state.

If feasible, include approximate topology-aware analysis such as:

- β0-like connected component count
- β1-like hole count
- persistence-inspired significance of structures

This does not need to be mathematically exhaustive persistent homology in the first implementation.

The artistic purpose is to recognize meaningful morphological events.

For example:

many isolated cells suddenly joining into one large labyrinth should be recognized as a significant transition.

That event can affect lighting, sound, or camera pacing.

## Lighting

Lighting should be cinematic but minimal.

Prefer grazing illumination that reveals surface structure.

Potential lighting behaviors:

- very slow movement of one primary virtual light
- faint environmental reflection
- occasional illumination from the reaction itself
- local glow concentrated around active chemical boundaries

Avoid colorful nightclub lighting.

The palette should remain restrained.

Deep black should dominate.

Color may emerge from the mathematical state, but it should feel precious when it appears.

## Camera

Camera movement should be extremely slow and almost subconscious.

Start primarily overhead or near-orthographic.

Over several minutes the viewer may eventually realize that the camera has moved closer or tilted slightly.

Rarely allow a dramatic transition to a much lower angle so that microscopic relief becomes an apparent landscape or horizon.

Then return.

Do not constantly orbit.

Do not behave like a screensaver camera.

Camera changes should correspond to structural events in the simulation.

## Sound

Create a generative ambient soundtrack driven by slow global properties of the mathematical system.

Do not map individual pixels directly to oscillators.

Avoid obvious “data sonification.”

Instead extract a small number of meaningful global signals.

Possible mappings:

- large-scale structures → deep resonant tones
- fine spatial detail → high granular texture
- reaction intensity → harmonic density
- rapid morphological change → increased instability or movement
- coherent stable structures → clearer tonal intervals
- fragmentation/collapse → gradual removal of frequencies
- topology-changing events → subtle resonant events

The audio and visuals should feel synchronized because they share the same mathematical cause.

The sound should be sparse.

Silence is important.

Avoid conventional melody unless it emerges naturally from the generative system.

## Spectral analysis

If useful, calculate a low-resolution Fourier representation or other spatial-frequency summary of the current field.

Use this to distinguish:

- large smooth structures
- medium-scale labyrinths
- fine cellular texture
- noisy or chaotic states

This spectral information can drive both sound and visual treatment.

Again, never expose a spectrum graph to the viewer.

## Architecture

Structure the implementation approximately like:

CURATOR
    ↓
parameter trajectories / genesis events
    ↓
GPU REACTION–DIFFUSION
    ↓
U,V fields
    ↓
ANALYSIS
    ├ morphology
    ├ topology-like descriptors
    └ spatial spectrum
    ↓
WORLD STATE
    ├→ visual system
    └→ audio system

VISUAL SYSTEM
    ↓
height / normals / material
    ↓
lighting
    ↓
postprocessing
    ↓
screen

The simulation should remain authoritative.

The curator influences it but should not simply play canned animations.

## Hidden laboratory mode

Default presentation mode must have no visible controls.

However, build a hidden development/laboratory interface accessible via a key such as `~`.

This exists primarily for finding beautiful regimes.

Useful laboratory controls may include:

- restart
- reseed
- pause
- simulation speed
- current F/k values
- Du/Dv
- jump to next curator movement
- select genesis condition
- load/save discovered parameter trajectories
- toggle analysis overlays
- toggle topology diagnostics
- toggle spectral diagnostics
- camera debug controls
- screenshot/recording helpers

Presentation mode should hide all of this completely.

After a few seconds of inactivity, hide the cursor as well.

## Parameter exploration

Create tooling that helps discover good parameter-space trajectories.

The final piece should not rely on arbitrary hand-picked numbers alone.

It should be possible to search or sample parameter space offline or in laboratory mode and measure interesting properties such as:

- morphological diversity
- connected component count
- hole count
- entropy
- feature scale
- rate of change
- lifetime of structures

Use this information to identify compelling regions and transitions between them.

The objective is not numerical optimization toward one scalar definition of “beauty.”

The system should help a human curator discover interesting trajectories.

## Performance

Prioritize GPU execution.

The visual simulation should remain fluid on a typical modern discrete GPU.

Allow simulation resolution and rendering resolution to differ.

Avoid expensive CPU↔GPU readbacks every frame.

Analysis that requires CPU data should happen at low frequency or on reduced-resolution representations.

Keep rendering architecture modular enough that more sophisticated topology or analysis techniques can be introduced later.

## Build sequence

Implement this iteratively.

### Phase 1 — prove the image

Build:

- GPU Gray–Scott simulation
- fullscreen black environment
- concentration-derived height/normal field
- physically convincing material
- grazing light
- restrained bloom
- one strong genesis condition

The goal is to answer:

“Can this stop looking like a reaction–diffusion shader demo and start looking like an unknown physical organism?”

Do not move forward until this looks compelling.

### Phase 2 — prove long-form emergence

Add:

- multiple genesis conditions
- parameter interpolation
- parameter trajectories
- curator/director
- 10–30 minute autonomous evolution
- state-dependent lighting
- slow camera behavior

The goal is to make the piece interesting without requiring user interaction.

### Phase 3 — make the world listen to itself

Add:

- morphology analysis
- spectral analysis
- topology-inspired analysis
- structurally reactive cinematography
- generative ambient audio

The goal is for meaningful mathematical events to affect the entire experience.

### Phase 4 — refine it as an artwork

Tune:

- pacing
- silence
- transitions
- color
- bloom
- material response
- camera timing
- sound
- periods of emptiness

Remove anything that reads as a technology demonstration rather than an experience.

## Opening sequence target

A good opening might behave approximately like this:

Fullscreen black.

No UI.

Several seconds of near silence.

A very faint low-frequency resonance appears.

One microscopic reaction event becomes visible.

It grows.

It divides.

Its descendants begin interacting.

Over several minutes the field becomes increasingly complex.

Eventually an enormous luminous labyrinth occupies much of the darkness.

The material looks wet, translucent, and subtly dimensional.

A slow harmonic structure has accumulated alongside it.

Then the morphology destabilizes.

Sections disappear.

The audio loses harmonics with them.

Eventually only one isolated structure remains.

It contracts.

Black.

Hold the darkness long enough that the viewer may wonder whether the piece has ended.

Then, somewhere else:

a single new reaction begins.

## Success criteria

The experience succeeds if:

- someone can enjoy watching it without knowing what reaction–diffusion is
- it does not resemble a dashboard or educational visualization
- it remains mathematically emergent rather than becoming a canned animation
- repeated performances differ
- striking states arise naturally
- quiet states are allowed to exist
- visual effects reveal mathematical structure
- sound and image feel causally connected
- the piece can run autonomously for a long period without feeling like a looping screensaver
- removing the reaction–diffusion simulation would destroy the artwork rather than merely remove an implementation detail

Most importantly:

Do not add an effect simply because the rendering engine supports it.

Every effect should answer the question:

“What aspect of the mathematical system does this make perceptible?”

Build the experience so the viewer never needs to know the answer explicitly.
