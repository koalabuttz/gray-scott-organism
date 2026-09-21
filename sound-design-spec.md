# Sound-design record: Sunlit Porcelain Garden

> Design of record for the Phase-3CausalityReview audio rework (operator feedback: "feels kinda creepy — want it more relaxing or interesting; stays too quiet too long after the organism is first seen"). This file is the implementation contract; after acceptance its decisions fold into `architecture-plan.md` deviations and this file may be removed.

## Recommendation and rationale

Replace the ominous low drone with **Sunlit Porcelain Garden**: a warm, softly resonant body with occasional porcelain-like blooms and a fine, airy surface. The organism should feel quietly alive and approachable—not haunted, underwater, or threatening. Its geometry still determines its register, harmonic fullness, surface detail, and rare excitations; nothing plays merely because time has passed.

Keep the approved causal architecture. Change the palette, shorten the acoustic space, and separate **fast presence/reveal** from **slow timbral evolution**. Do not solve audibility by amplifying sub-bass or making every layer louder.

## 1. Contract and evidence

### Requirements retained

- Audio consumes presentation-tier simulation analysis, never rendered pixels, lighting, camera brightness, or chemistry-health fallback.
- Preserve all six mappings: scale→fundamental; fine detail→grains; intensity→harmonic density; coherence→interval clarity/detuning; fragmentation→upper-voice removal; topology events→rare excitation.
- Four persistent pad oscillators maximum; built-in WebAudio nodes only; one reusable noise buffer and one generated stereo IR; context-agnostic offline engine.
- No beat, arpeggiator, melody generator, free-running musical LFO, or soundtrack keyed to named movement times.
- Minimum event spacing 15 real audio-clock seconds.
- Exact digital zero in dormancy and after terminal fades; death/kill-wait→black-hold→rebirth remains authoritative.
- Output sample peaks ≤ −6 dBFS (0.501187); design toward ≤ −8 dBFS (0.398107) for implementation margin. The compressor is not a guaranteed limiter.

### Verified facts that affect this design

- `idea.md:255–279` requires sparse, globally caused sound and meaningful silence.
- `architecture-plan.md:773–813` establishes presentation-tier causality, six mappings, scheduling, and the terminal silence/black-hold handshake.
- `src/audio/voices.ts` maps scale logarithmically, computes intensity, removes voices with fragmentation, and currently gives level no floor.
- `src/audio/audio.ts` uses sine/triangle pad voices, noise texture, and three Q=8 noise resonances with a 12 ms event attack; grains are spaced evenly; grain attacks cap at 60 ms; the slow level time constant is used for master wake and sounding-voice gain — this compounds the initial low target level.
- Thresholds are not directly aligned: renderer support is local V concentration 0.025–0.1 (`SURFACE`); audio wake uses occupancy=0.03 meaning 3% occupied *area* above reduced V=0.08 — different units.
- Deviation 54 puts the terminal master after the compressor, guaranteeing silence despite compressor lookahead. Preserve that ordering and the envelope mirror (deviation 56).

### Acoustic diagnosis

Low sine-heavy register, open fifths without a warm third, ±18-cent spreading, abruptly articulated filtered noise, and a long dark tail plausibly produce the reported unease. The replacement shifts the surviving voice into a reproducible low-mid register, adds restrained even harmonics and a major-third color, reduces beating, rounds attacks, and replaces the cave-like tail with a shorter, lighter space.

## 2. Pad: warm body, not a bass drone

### Pitch and waveform

- Set `fundamentalMinHz=110`, `fundamentalMaxHz=165`. Keep the existing feature-scale/low-band normalization and logarithmic decreasing mapping unchanged. Large structures still sound lower.
- Four logical voices, in removal priority order: **[1, 2, 3, 5/2] × fundamental**. The audible stack is root, octave, fifth above the octave, then major third above the octave. Highest carrier is 495 Hz.
- Use `PeriodicWave` on the existing four `OscillatorNode`s (built-in node; not an oscillator bank).
- Voice 0 harmonic amplitudes: `[1, 0.28, 0.10]` at harmonics 1/2/3, all sine phase. Divide by the absolute sum and use `disableNormalization:true` (defined ≤1 waveform bound).
- Voices 1–3: `[1, 0.10]` at harmonics 1/2, divided by 1.10, also `disableNormalization:true`.
- No triangle/saw/square, inharmonic partials, or oscillator phase retrigger on descriptor changes.
- Low-pass Q=0.5; per-voice cutoff `clamp(carrierHz * (3 + 2*intensity), 500, 2400)` Hz.

### Coherence, consonance, and detune

- Keep all carrier ratios just and fixed. Do not morph frequency through dissonant intermediate chord ratios.
- Voice 3 major-third gain multiplier: `smoothstep(0.25, 0.75, coherence)`. Low coherence = open root/octave/fifth; as it coheres, the warm third becomes audible.
- Maximum detune magnitude: **3 cents**, falling linearly to zero with coherence.
- Detune multipliers: `[0, +1, -1, +0.5]`; root never detunes. Smooth with τ=8 s. No independent random drift.
- Coherence→interval clarity retained without using beating as a primary texture.

### Density, breathing, and levels

- Retain the existing intensity and fragmentation formulas and `mapVoiceCount` semantics. Fragmentation removes voice 3, then 2, then 1; voice 0 survives until presence fades out.
- Base relative weights: `[1, 0.48, 0.26, 0.22]`; apply the coherence multiplier to voice 3.
- Normalize the active target weights by `max(1, sqrt(sum(weight²)))` before multiplying by pad level. Density increases spectral richness, not loudness jumps.
- Active pad level: `0.18 + 0.06*sqrt(intensity)`, multiplied by the support eligibility in §6. A living-field floor, never an unconditional noise floor; absent support → exactly zero.
- Ordinary pad-level smoothing τ=3 s; newly admitted/removed upper voices τ=10 s. Root's reveal uses the dedicated bounded envelope in §6.
- Frequency smoothing τ=10 s; filter smoothing τ=6 s. While completely silent, initialize pitch/filter to the latest valid target before revealing rather than audibly gliding from a placeholder pitch.
- Chord breathing is solely the slow response to changing intensity, coherence, and fragmentation. No periodic tremolo or scheduled chord sequence.

## 3. Topology event: soft porcelain bloom

Replace the Q=8 noise-burst event with a **three-partial additive resonant bloom**. This is an intentional palette amendment to the old §8.2 subgraph, not a change to event causality.

- Only a newly accepted topology serial may trigger it. Preserve obsolete-serial skipping, activation baselining, and ≥15 s refractory behavior.
- Three temporary sine oscillators at `[1, 2, 3] × bellBaseHz`; normalized partial amplitudes `[0.72, 0.21, 0.07]`.
- `bellBaseHz = rootHz * (featureScaleNorm >= 0.5 ? 2 : 3)` from the current **smoothed audible root** (not a future unsmoothed target). Range 220–495 Hz; highest partial ≤1485 Hz. Sample pitch once at excitation; hold through the decay.
- Do not alternate octave choices or event pitches by counter. Different geometry may give different pitches; unchanged geometry gives the same pitch.
- All three start together. Raised-cosine attack of **120 ms**, then exponential decay, τ **0.85 / 0.55 / 0.35 s**. From 3.3 s, a 100 ms bounded terminal fade; stop/disconnect all event nodes by 3.42 s.
- Peak event gain: `0.065 * clamp(0.4 + eventStrength, 0.4, 1)`. No noise transient, detune, pitch bend, downward drop, mallet click, or strike layer.
- Route to the same dry bus/shared reverb. Three simultaneous partials count as one event, not three serials.
- At most one live event group. Drop, never queue, an event received during reveal, terminal fading, invalid analysis, pause, mute, or stillness. Consume its serial even when suppressed.
- Must not lift total 1-second RMS by more than 3 dB relative to a paired no-event render.

## 4. Texture: soft shimmer rather than scuttling

- Keep the one 2-second noise buffer and seeded `sound` substream.
- Grain duration **0.65–1.2 s**, uniformly seeded; offsets wholly inside the buffer.
- Grain envelope: full Hann window `sin²(pi*t/duration)`, peak **0.85**, via `setValueCurveAtTime`; first and last values exactly zero. No fast attack or sustain plateau.
- Rate: `1.4 * fineDetail² * (1-fragmentation)` grains/s. Zero detail or complete fragmentation → exactly zero rate.
- Next grain spacing: `(0.75 + 0.5*rng.next()) / rate`. Preserve the existing lookahead cursor, stall debt discard, transport reset rules.
- Maximum concurrent grains **4** (below the approved 12). Never fill a missed interval with a burst.
- Shared high-pass **700 Hz** Q=0.5; band-pass Q=0.65, center mapped logarithmically **1100→2400 Hz** by fine detail; shared low-pass **4200 Hz** Q=0.5.
- Texture bus gain `0.07 * fineDetail * (1-fragmentation)`, τ=4 s. No early texture floor.
- Grains disabled during the initial reveal and whenever support is ineligible. After the reveal, begin from current scheduler time, not accumulated debt.
- Isolated output target: ≈ −42 to −32 dBFS RMS in a mature fine-detail fixture; ≥12 dB below the pad.

## 5. Reverb: small luminous space

- Replace the 5-second dark IR with a deterministic stereo IR of **2.4 s** total.
- Amplitude envelope `exp(-t/0.32)` (≈2.21 s to −60 dB); 10 ms smoothed onset; final 100 ms faded to exact zero.
- One-pole low-pass, cutoff declining **5500 Hz → 2200 Hz** exponentially over the IR duration. Keep separate seeded channel noise.
- Retain peak normalization in generated data and `ConvolverNode.normalize=true`.
- Wet gain: `0.07 + 0.04*clamp01(0.5*coherence + 0.5*intensity)` → **0.07–0.11**, τ=8 s. Shared send stays 1.
- No feedback delay, pitched echoes, modulation, or additional IRs. If measured wet RMS exceeds dry RMS−15 dB in the mature fixture, lower the wet range; do not lengthen or darken the IR. Terminal master still mutes the entire tail.

## 6. Presence and wake: audible within a few seconds

### Correct the threshold model

Do **not** equate `wakeOccupancy=0.03` to renderer `supportVLow=0.025`; units differ. Do not change occupancy/topology thresholds to wake earlier.

Add one bounded presentation-tier descriptor, **`supportFraction`**, computed in `src/analysis/presentation.ts` from existing envelope-weighted reduced V samples:

`supportFraction = mean(smoothstep(SURFACE.supportVLow, SURFACE.supportVHigh, reducedV))`

Keep it raw — no multi-second smoothing. Zero for an empty field; propagate through the typed presentation result/WorldState path. No new GPU readback.

### Gate and envelope

- Support-on threshold **0.001**; support-off **0.00025**.
- Two consecutive fresh valid presentation samples at/above on-threshold AND ≥ **0.5 real seconds** persistence. Repeated ticks on the same snapshot don't count again.
- Remove the activity-only OR wake path. Activity cannot wake invisible chemistry.
- Presence eligibility false at startup/reset; true on confirmed crossing; held through hysteresis; cleared below support-off (clearing removes the floor and one-shot eligibility immediately).
- Quiet detection: keep 8 s confirmation + 8 s terminal fade, but require support below support-off as well as low occupancy/activity (a visually supported low-activity body is not empty dormancy).
- On confirmed wake: cancel only a **general absence fade** (never a stillness/kill-wait fade); re-anchor from the mirrored current gain; **1.5 s linear reveal** to normal master level.
- From exact silence: prepare root frequency/filter/gain targets behind the zero master before revealing — never a second root envelope in series with the reveal.
- Master already nonzero: raise the root to its new floor over **0.75 s**; never step a source gain. Maintain the root-envelope mirror for offline scheduling (never read scheduled `AudioParam.value`).
- Activation fade becomes **1.5 s**, only when presence is eligible. Activation in dormancy stays silent. Reveal and activation are one envelope operation, never serial fades.
- Upper voices stay slow. Grains/events suppressed during the reveal, then follow current descriptors; missed events never replay.
- Invalid/stale presentation cannot establish presence. `kill-wait`, stillness-armed, black-hold, pause/mute, unavailable audio, and pre-gesture lock prohibit reveal regardless of support. Rebirth re-arms through the existing lifecycle.

### Timing objective

Target: audible output within **3 real seconds after confirmed support begins**, and within **4 real seconds of the first clearly visible organism** in synchronized live capture (audio clock, not accelerated performance time). The 0.001 threshold is the initial design value — if reduced support misses clearly visible nucleation, show the descriptor/visibility trace and adjust before acceptance. Never satisfy the timing test via chemistry-tier wake, a timed intro sound, or weakening the silence guarantee.

## 7. Level plan and felt arc

Keep `masterLevel=0.75` and existing compressor/high-pass. Measure RMS in 1-second windows at destination-equivalent output. Calibration targets:

| State | Feeling / target |
|---|---|
| Dormancy | No tone, hiss, or tail. Samples exactly zero. |
| Nucleation | Soft, clearly detectable warm body; typically one voice. Full-band RMS −27 to −21 dBFS after reveal; 150–2000 Hz band RMS ≥−34 dBFS early. |
| Growth | Gradual spectral opening; ≈ −25 to −20 dBFS RMS. |
| Labyrinth | Most coherent consonance, occasional third color + shimmer; ≈ −23 to −18 dBFS RMS. |
| Overgrowth | Richest detail, not a climax; ≈ −22 to −18 dBFS RMS, never above −16 dBFS RMS sustained. |
| Collapse | Upper voices/texture disappear; warmth remains; no horror-style descending gesture; no compensating crescendo. |
| Stillness/death | Terminal fade to exact zero before black-hold; no tail leaks into the hold. |

Movement names are listening labels, not sound-control inputs. Test the fragmented single-voice case: audibility must not depend on upper voices.

## 8. Interesting, not merely pleasant

1. **Geometry-sized resonator:** rare bell excitation chooses its 2× or 3× register from the feature-scale normalization. Large structures = larger objects; fine structures = smaller, brighter ones. No score or counter chooses notes.
2. **Coherence reveals hidden warmth:** the just major third becomes perceptible only as coherence rises; fragmentation removes it first.

The fine-detail shimmer is a third layer. Do not add stereo-centroid tracking in this pass.

## 9. Implementation handoff

Ordered work:
1. `supportFraction` descriptor: `src/analysis/protocol.ts` shape + `src/core/types.ts` + `src/analysis/presentation.ts`; propagate through publisher/default/fixture sites; update empty/invalid/synthetic constructors.
2. Pure mappings/config: `src/config.ts` AUDIO + `src/audio/voices.ts` — register, ratios, waveform coefficients, weights, coherence color, normalization, level floor, grain mapping, filter ranges, wet mapping, reveal constants. Distinguish valid-present zero-intensity from absent input so the floor can't leak into empty fixtures.
3. Graph palette: `src/audio/audio.ts` — PeriodicWave voices, texture low-pass, three-partial bloom `spawnEvent`, Hann-window grains.
4. Space: `src/audio/buffers.ts` IR recipe + `AUDIO.irSeconds`; keep deterministic seeds and the reseed-swap boundary.
5. Reveal state machine: support confirmation, floor eligibility, unified reveal/activation, general-fade reversal, protected stillness precedence; envelope mirror for every new transition; preserve reset/reseed de-click and stale-deadline cancellation.
6. Verification + documentation: extend offline driver and tests; update plan §8/deviations superseding old timbral constants.

Untouched: simulation, curator, topology detection, renderer, camera, six causal inputs, root-seed ownership, one noise/one IR budget, 50 ms tick/150 ms lookahead, no-backlog, recording destination, mute path, terminal master position, silence acknowledgement, black-hold duration, transport/restart contracts.

Required tests: mapping bounds (110–165 Hz, consonant ratios, ≤3¢ detune, monotone scale/rate/density/removal, third-coherence gain, absent-support exact zero; adversarial NaN cases); support analysis fixtures (empty, hidden-periphery, subthreshold, small patch, broad patch); wake fixture starting locked/dormant→unlock→reveal a small supported, low-intensity, fragmented organism (not a pre-live fixture); distinct-sample confirmation, stale repeats, threshold chatter, general-fade reversal, stillness-fade irreversibility, dormancy activation, reset during reveal, rebirth fresh confirmation; output guard (150–2000 Hz band RMS ≥−34 dBFS, full-band ≥−27 dBFS by reveal deadline, from rendered samples); render matrix (pad-only, texture-only, event-only, combined, single-voice onset, coherence sweep, sustained intensity, collapse, full silence cycle at 44.1/48 kHz, multiple seeds; finite; peaks ≤0.501187, aim ≤0.398107); paired event RMS ≤ +3 dB; texture ≥12 dB below pad; wet ≥15 dB below dry; exact zeros; hidden-periphery silence; ≥15 s spacing; ≤4 grains; ≤4 pad oscillators; balanced node creation/teardown; fake-audio support for PeriodicWave/curves; replace the "three Q=8 band-passes" expectation with the bloom recipe (serial/refractory tests unchanged in intent); extend live audibility capture to log support/visibility/audibility/root/band RMS/silence phase/master envelope against real timestamps.

## 10. Re-listen acceptance: five gates

1. **Prompt arrival:** soft identifiable body within four real seconds of first clear visibility, on initial appearance and rebirth. No sound anticipates a visibly empty field.
2. **Relaxed foundation:** fragmented one-voice opening audible without headphones at fixed comfortable volume; reads warm/resonant, not threatening.
3. **Quiet interest:** warmer interval opening + occasional shimmer during coherent growth; no tappable beat or recurring tune; frozen descriptors produce no autonomous chord motion.
4. **Gentle rarity:** blooms detectable but never startling, ≥15 s apart, no hissy attack/ominous bend/cave tail; peak guard passes.
5. **Earned silence:** collapse sheds detail to unambiguous silence; black-hold contains exact zero samples; no old event/tail leaks into the new reveal.

## Alternatives rejected

Raising master gain / keeping 55 Hz (doesn't fix laptop reproduction; eats headroom). Globally speeding smoothing (audible morphology jitter). Lowering occupancy/topology thresholds (changes analysis semantics). Composed pentatonic sequences or chime schedulers (uncasued melody). A second sound-mode UI or dual engines (one reviewable change set; roll back as a unit if listening acceptance fails).
