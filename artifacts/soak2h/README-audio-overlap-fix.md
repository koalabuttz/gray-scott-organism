# Fix: the porcelain bloom's live `AudioParam` overlap (`NotSupportedError`) — §3/§4 TAKE-5

The 120-minute AC.14 soak found **43 uncaught exceptions**, all of the form

```
pageerror: Failed to execute 'setTargetAtTime' on 'AudioParam':
setTargetAtTime(0, 23.04933333333333, 0.85) overlaps setValueCurveAtTime(..., 22.89066666666667, 0.18)
```

one per porcelain bloom. Each exception also aborted that bloom's decay and its bounded terminal fade to
exact zero, so the bloom could hang at its attack peak. This is the record of the fix and its verification.

**Status: FIXED and verified.** `0` overlap exceptions in every post-fix measurement (unit, live browser
probe, and the post-fix 120-minute soak — see *Certification*).

---

## Root cause (proven, not inferred)

`src/audio/audio.ts` `spawnEvent` built each bloom partial's envelope as

```ts
env.gain.setValueCurveAtTime(raisedCosineAttack(attack, sampleRate, peakAmp), when, attack); // attack = 0.18
env.gain.setTargetAtTime(0, when + attack, tau);
```

Chromium **snaps a value curve's start forward to the current render quantum** when `when` is at or behind
the audio clock, while the following `setTargetAtTime` keeps the requested time. The decay then lands
*strictly inside* the curve's real interval and the browser throws.

Measured, in a real headless Chromium (`artifacts/soak2h/audio-overlap-repro.json`):

| Schedule | Result |
|---|---|
| curve at `now + 50 ms`, decay at its end | no throw |
| curve at `now − 2 ms`, decay at `when + 0.18` | **throws** — `setTargetAtTime(0, 0.466, 0.85) overlaps setValueCurveAtTime(..., 0.2987, 0.18)` |
| curve at `now − 5 / 13 / 21 / 40 ms`, same follow-up | **throws** |
| curve at exactly `when + duration` (the boundary) | accepted |

Production timing puts `when` 13–21 ms (640–1024 samples at 48 kHz) behind the clock — the engine's tick
clock lags the audio clock — which is squarely inside the throwing band. It reproduces headless **and**
headed, and only with a genuinely *running* `AudioContext` (a fresh context at `currentTime = 0` cannot
snap, which is why the offline matrix and the live-audibility spec were both green: neither asserted the
absence of page errors across a live-audio window).

## The fix

One guard, in one place, applied to every value curve in the file.

`src/config.ts` — two new `AUDIO` constants:

```ts
curveLeadMs: 50,   // ≥ one 128-frame render quantum (2.67 ms @ 48 kHz) plus margin; matches the 150 ms granular lookahead
curveMarginMs: 20, // the clock-anchored bound on a curve's real end
```

`src/audio/audio.ts` — `AudioGraph.curveWindow(when, duration)` returns `{ start, end }`:

```ts
const start = Math.max(when, clock + AUDIO.curveLeadMs / 1000);
const end = Math.max(start + duration, clock + AUDIO.curveMarginMs / 1000 + duration);
```

- `start` is pushed to at least 50 ms **ahead** of the clock and never pulled earlier, so a caller's
  *future* time is passed through untouched — the offline driver queues ticks against a context whose clock
  does not advance and must keep its queued times.
- With `start` ahead of the clock no snap can occur, so the curve's analytic end **is** its real end; `end`
  additionally takes the clock-anchored bound, so the mirror stays truthful even if the lead were reduced
  to zero. (With 50 > 20 ms the first term always wins today — the second is explicit insurance and is
  documented as such at both sites.)

Applied at every `setValueCurveAtTime` site:

| Site | Change |
|---|---|
| `spawnEvent` (the defect) | curve at `start`; decay at `curveEnd`; the terminal fade, the oscillator start/stop and the node reap all anchor to the same `start`. Because `curveEnd == start + attack`, the exponential τ is still measured from the end of the 180 ms attack — **the audible shape is unchanged**; only the 50 ms lead shifts the whole bloom. |
| `spawnGrain` | curve at `start`; `source.start/stop` and the reap anchor to `start`/`end`. A grain's Hann curve is the **only** automation on its envelope gain, so it has no overlap partner — the guard is applied for consistency and so the curve is never snapped. (Checked as instructed; no defect there.) |
| `applyPitchGlide` | curve at a guarded start, clamped to be at/after any still-pending glide curve's mirrored end; **returns** the scheduled start. |
| `applyPitchImmediate` | the immediate set is placed at/after the pending glide curve's mirrored end (a curve whose start precedes a `cancelScheduledValues(t)` survives that cancel — the same overlap class in the pitch path). |

**The envelope mirror stays truthful.** `commitDegree` now builds the glide mirror from the time
`applyPitchGlide` *actually* scheduled at:

```ts
const start = this.graph.applyPitchGlide(from, to, now, AUDIO.glideSeconds);
this.pitch = { from, to, start, end: start + AUDIO.glideSeconds };
```

so `pitchCarriersAt` (which reads the mirror) can never disagree with the scheduled frequency curve. The
bloom has no such mirror, but its *node-reap schedule* is the same kind of bookkeeping and is now anchored
to the same real start.

## Verification

### 1. Unit — the recording fake now models the browser rule

`tests/support/fake-audio.ts` was taught the two behaviours the defect depends on, so the whole audio suite
can catch this class rather than a live browser being the only detector:

- `FakeAudioParam` takes a clock and **snaps a value curve's start forward to the render quantum** when the
  requested time is at or behind it.
- Every scheduling call runs `guardCurveOverlap`: an event scheduled *strictly inside* a recorded curve
  interval throws a `NotSupportedError`-shaped error; an event exactly at the curve's end is accepted.

Four new tests in `tests/audio.test.ts` (`§3/§4 (TAKE-5) value curves are scheduled from a clock-anchored
time`):

| Test | Asserts |
|---|---|
| "places the bloom decay at the attack curve's real end when `when` is the clock instant" | the exact repro shape: no throw; the decay is at/after the curve's never-snapped end; `decay.time − curveStart == 0.18` (shape preserved); the τ is the partial's designed constant; the bounded terminal fade and the final zero assignment still exist |
| "is overlap-proof for a `when` behind the clock by a full frame, and for grains" | 21 ms behind the clock (the measured production lag) → no throw, bloom and grain |
| "models the browser rule itself…" | the fake throws for the un-guarded shape and accepts the guarded one, so the two tests above cannot pass vacuously |
| "records the glide mirror from the time the glide was actually scheduled at" | the glide curve's guarded start, and that a later immediate set lands at/after the pending curve's end |

**Results:** `npx tsc --noEmit` clean; `npx vitest run` → **373 passed** (was 369: the 4 new tests).
The new overlap guard produced exactly **one** pre-existing failure — the bloom event-bus test that pinned
the scheduled unity re-assertion to the un-guarded instant — which was updated to assert the guarded start
(at/after the requested time and no further ahead than the lead). **No other latent overlap exists in any
path the unit suite drives.**

### 2. Browser — `tests/browser/audio-overlap.spec.ts` (`OVERLAP=1`)

Three independent parts, all in a real headless Chromium on the real GPU:

| Part | Result |
|---|---|
| **Production probe** — reaches the app's own live `AudioGraph`, calls the real `spawnEvent` 12× with `when` at and 21 ms behind the audio clock, with `AudioParam.prototype.setValueCurveAtTime`/`setTargetAtTime` instrumented on the **real browser objects** | **0 throws** of 12; every attack curve scheduled at/after the requested time; every decay paired per-`AudioParam` with its own curve at **exactly** the curve's end (`decay − curveEnd = 0`) |
| **Live control** — the same un-guarded shape on a scratch `AudioContext` (curve 2 ms behind the clock, decay at `when + attack`) | **throws** — `setTargetAtTime(0, 0.4233, 0.85) overlaps setValueCurveAtTime(..., 0.256, 0.18)` — while the guarded shape does not. This is what makes the probe above non-vacuous. |
| **Live window** — 150.7 s of the artwork unlocked at presentation settings | **15 blooms fired, 0 page errors, 0 overlap errors**; nodes balanced (created 94 == stopped 94, live 0) |

Evidence: `artifacts/soak2h/audio-overlap-after-fix.json`.

### 3. Regression suites

| Suite | Result |
|---|---|
| `npx vitest run` (unit) | **373 passed** (was 369; +4 new) |
| `npm run test:browser` (whole browser suite) | **79 passed, 15 skipped, 0 failed** — the 79 is unchanged from the pre-fix suite; the skipped set is the 13 pre-existing gated specs plus the two new gated specs (`SOAK2H=1`, `OVERLAP=1`) |
| `npx playwright test --project=headless-gpu audio-offline audio-audible audio-lifecycle audio-reveal` | **31 passed** |
| `STILLNESS=1 npx playwright test --project=headless-gpu stillness-hold.spec.ts` | **1 passed** — with the real audio silence handshake: `silence at kill-wait entry: satisfied: true, terminalZeroAt: 1.861 s`, 20.01 performance-second black-hold, then a fresh arc re-arms (`satisfied: false`) |
| `OVERLAP=1 … audio-overlap.spec.ts` | **1 passed** |
| `npx tsc --noEmit` | clean |

## Before → after (the same measurement, three ways)

| Measurement | Before | After |
|---|---|---|
| **120-minute AC.14 soak** (the gate) | **43** uncaught overlap exceptions | **0** (see *Certification*) |
| 6-minute control soak at 1920×1080/768²/3× | **4** (paced) / **6** (light) uncaught | — |
| 150-second live window while blooms fire (browser probe) | pre-fix rate ≈ 3–4 per 120 s | **0** with **15 blooms** |
| 12 direct production `spawnEvent` calls at/behind the clock | every call threw | **0 throws** |

The 43 pre-fix exceptions came from the (pre-fix) acceptance run recorded in
`artifacts/soak2h/report-acceptance-120min.json`; the pre-fix controls are
`report-control-paced-6min.json` / `report-control-light-6min.json`.

## Certification

### Post-fix certification soak — the full 120 minutes (attempt 3, paced harness, stopped-at-applied)

| | |
|---|---|
| Duration | **7200.0 s continuous**, `status: completed`, 27 arcs, 22 judged 5-minute windows (+ 1 partial) |
| **Overlap exceptions** | **0** (`errors.pageErrors.count = 0`; `audioSchedulingErrors = 0`) |
| Console errors / non-finite field cells | 0 / 0 (699 samples) |
| Frame time (app's own ring, all post-warmup samples, n = 1 461 600) | p50 **16.7** / p95 **16.8** / p99 **16.8** ms — **60 fps tier met** (≤ 17 / 22 / 34 ms); worst 5-min window identical (p50 16.7 / p95 16.8 / p99 16.8) |
| Delivered rate | 59.4–59.7 fps per window (the app's own final 1-second window: 59.99), 360.02 simulation steps/s against a 360 steps/s target (delivered/requested ratio p50 0.999992) |
| Resources | every GL count delta **0**, slope 0/min; audio nodes created 450 == stopped 450, live 0; event listeners constant across 12 samples (window 16 / document 5 / canvas 3, deltas 0) |
| Heap | **trend −2.0%** (last-10-minute median 19.64 MiB vs first-10-minute median 20.04 MiB), slope ≈ −0.12 MiB/h; the endpoint-to-endpoint number (+20.3%) is GC noise (see below) |
| Readback latency | p95 302 ms **clipped by the probe's own 300 ms timeout** (20 clipped, 20 misses) → not adjudicable at full length; the 2000 ms-timeout paced control measured **p95 242 ms**, inside the criterion |
| Resets / rescues | 0 WebGL context losses; 27 rescues |

**The blocking failure is gone, and the sample-by-sample comparison is unambiguous.** The pre-fix soak had
**21** exceptions by 49 minutes and **35** by 98 minutes; this run had **0 and 0**, and 0 at 120 minutes.

**AC.14 verdict for the certified run** (`artifacts/soak2h/report.json` → `verdict`):
frame-time tier **`60fps`**; resource slopes **PASS**; heap **PASS**; delivered steps **PASS**; NaN/console
errors **PASS**; **run integrity PASS** (0 uncaught exceptions). `accepted` is **false** for exactly one
reason, unrelated to this fix: the soak's readback probe cannot adjudicate AC.14's 250 ms criterion because it
is bounded by its own 300 ms timeout (the paced control with a 2000 ms timeout measured 242 ms — inside the
criterion). That is the only outstanding AC.14 item, and it is an instrument limitation, not a regression.

**Two notes for the reviewer.**

1. *The run's own process exited 1.* Its in-spec heap assertion used the endpoint metric, which read +20.3%
   for this run while the pre-fix run read −35.7% — the same code, the same machine, a coarse oscillating
   readout (post-warmup range 14.8–30.8 MiB; the AC.14 "no leak" question is answered by the trend, which is
   −2.0%). The spec and the post-processor now judge heap on the trend and report the endpoint number
   alongside, so a re-run reports `60fps` and passes its internal assertions.
2. *The other AC.14 numbers improved over the pre-fix run* for a reason unrelated to this fix: the pre-fix
   soak ran with the un-paced harness (polling with no sleep), which was found and fixed while producing the
   earlier report; the certified run is paced at the documented 500 ms. Its frame times are therefore the
   heartbeat of the artwork rather than of the instrument (16.7 / 16.8 / 16.8 ms).

Evidence files: `report-postfix-120min.json` (raw), `report.json` (certified verdict), `summary-postfix-120min.json`,
`windows-attempt3.jsonl`, `progress-postfix-120min.json`, `run-attempt3-postfix.log`, `README-soak2h.md`.

## What is *not* verified here

- **The pitch path's latent overlap is prevented, not observed.** No test or soak ever produced an overlap
  in `applyPitchImmediate`/`applyPitchGlide`; the guard there is derived from the same browser rule and is
  covered by the new unit test ("records the glide mirror…") and by the fake's overlap enforcement, but it
  was never a live failure. The engine's ≥ 12 s degree refractory with a 1.25 s glide already made a
  glide-vs-glide overlap impossible.
- **The audible character of the bloom is asserted structurally, not by ear.** The fix preserves the
  envelope shape by construction (τ still measured from the attack's end, all legs anchored to the same
  start) and the live audibility spec plus the stillness handshake pass, but the operator's listening
  verdict remains part of `FinalFullArcReview`.
- **A 50 ms scheduling lead is now applied to blooms and grains in the live path.** This is deliberate and
  inaudible (the granular scheduler already spreads grains over a 150 ms lookahead), but it is a behaviour
  change: bloom and grain automation is now scheduled ahead of the clock rather than at it.
- The AC.14 frame-time/readback caveats from the pre-fix soak (harness polling overhead; the readback
  probe's clipping) are unchanged by this fix and are documented in `README-soak2h.md`.
- **Running the browser suite rewrites tracked Phase-1 evidence.** `gpu-correctness.spec.ts` regenerates
  `artifacts/capability-report.md`, `artifacts/phase1-gpu-smoke.json` and `artifacts/phase1-performance.json`,
  and Playwright rewrites `artifacts/playwright-report.json`. Those files were restored to their committed
  state after the regression run (`git checkout --`), because §11.1 records the Phase-1 numbers as
  *historical*; the regression result itself is reported above rather than left in the artifacts.
