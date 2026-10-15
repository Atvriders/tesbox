# Sound scores

How close each tuned engine sounds to recordings of the car that inspired it, measured by
`npm run score` (spec §11.3; phase 2b contract T8). Every number is a similarity in 0–1 between the
engine's renders and real recordings; "ref vs ref" is how well two independent recordings of the same
car agree, and a metric's gate is 0.8 of that. Discrimination asks whether each render matches its own
car's recordings better than every other tuned engine's. A measurement cannot hear: the user's
listening sign-off is the final word, and until then the garage shows **Beta voicing**.

Reproduce: `npm run score -- <engine-id> --gate` with the references in `lab-refs/` (see
[`SOUND_LAB.md`](SOUND_LAB.md)); `npm run tune -- <engine-id> --apply` writes a tuned voicing.

The pilots were re-tuned on 2026-10-15 after the Phase 5 P0 sound-fidelity fixes (phase 2a amendments
B18/B19, phase 2b D9). In their tables, "default" and "v1.0.0 tuned" were measured with the Phase 2b
DSP; "P0 baseline" is the v1.0.0 tuned voicing with the P0 defaults added (whistle −36 dB, outside
forced induction −30 dB, cabin leak −30 dB) rendered by the P0 DSP, and "P0 re-tuned" the result of
`tune --strategy cmaes --iterations 40` over the D9 vector, scored with `score --gate`.

## 2.5 Turbo Inline-5 — inspired by Audi RS 3 (8Y) (`i5-turbo-25`)

Tuned voicing: i5-turbo-25

Composite (render vs references): default **0.348** → tuned **0.478** (v1.0.0) → re-tuned **0.597** (Phase 5 P0, 2026-10-15; P0 baseline 0.563). Gates: 7 pass, 0 fail (fiLine n/a); discrimination **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | v1.0.0 tuned | P0 baseline | P0 re-tuned | result |
|---|---|---|---|---|---|---|---|
| Order profile | 0.645 | 0.516 | 0.765 | 0.731 | 0.735 | 0.740 | pass |
| Spectral tilt | 0.506 | 0.405 | 0.268 | 0.381 | 0.401 | 0.421 | pass |
| Spectral centroid | 0.277 | 0.221 | 0.192 | 0.343 | 0.376 | 0.372 | pass |
| Sub-orders | 0.402 | 0.322 | 0.384 | 0.487 | 0.488 | 0.507 | pass |
| Pulse irregularity | 0.640 | 0.512 | 0.516 | 0.547 | 0.535 | 0.556 | pass |
| Forced-induction line | — | — | — | — | — | — | n/a |
| Overrun | 0.501 | 0.401 | 0.346 | 0.813 | 0.628 | 0.834 | pass |
| Forced-induction presence | 1.000 | 0.800 | 0.231 | 0.276 | 0.987 | 0.987 | pass |

Discrimination (re-tuned render vs each tuned engine's references): own 0.597; v8-flatplane-45 0.232; v8-na-50 0.462 (v1.0.0: own 0.478; v8-flatplane-45 0.180; v8-na-50 0.414).

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `rs3-dyno-a` | outside | [Stock 2018 Audi RS3 hits the Dyno](https://www.youtube.com/watch?v=hiCDg22RnLg) | liftoff: 1.5, wot: 20.4 | used |
| `rs3-dyno-b` | outside | [RS3 Power Run *381bhp* Stock](https://www.youtube.com/watch?v=2mvqRs2s8VE) | wot: 21.9 | used |
| `rs3-onboard-a` | cabin | [2016 Audi RS 3 / 13 minutes of pure 5 cylinder onboard sound](https://www.youtube.com/watch?v=Ho34caoeT2o) | cruise: 8.7, liftoff: 6.2, wot: 6.0 | used |
| `rs3-onboard-b` | cabin | [2022 AUDI RS3 Sportback 8Y / 0-288 KM/H Acceleration / POV Drive & Sound by AutoTopNL](https://www.youtube.com/watch?v=k4SCpXBSruk) | liftoff: 9.7, wot: 31.1 | used |
| `rs3-onboard-c` | cabin | [2025 Audi RS3 - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=9eQmBZpeawk) | idle: 3.6 | used |

Gates that failed at v1.0.0 and the Phase 5 P0 fixes (2026-10-15; phase 2a amendments B18/B19, phase 2b D9):

- **Forced-induction presence:** the render's turbo whistle was 33–36 dB louder than anything the recordings show; `forcedInduction.cabinGainDb` scaled the whistle and the whoosh together and the outside mix had no turbo level. Fix: the whistle-only level `whistleDb` and the outside level `outsideGainDb` (P0.1). The P0 defaults alone bring it to 0.987 (gate 0.800); re-tuned 0.987 (whistle −18.3 dB, outside −9 dB).
- **Spectral tilt:** the 4th-order cabin low-pass near 600 Hz left 1.5–3 kHz 15–20 dB below the recordings. Fix: the 2nd-order cabin low-pass with a high-frequency leak (P0.2) and the full `cabin.lowpassHz` / `mechanical.valvetrainGain` ranges (P0.3): 0.401 at the P0 baseline, 0.421 re-tuned (gate 0.405; low-pass 970 Hz, leak −19.9 dB). Outside, most of the remaining gap is dyno-cell fan noise in the references; the re-tune's loud outside forced-induction level may be fitting that noise with the whoosh — a point for the listening check.

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 5.0 V8 NA — inspired by Ford Mustang GT (Coyote) (`v8-na-50`)

Tuned voicing: v8-na-50

Composite (render vs references): default **0.442** → tuned **0.546** (v1.0.0) → re-tuned **0.666** (Phase 5 P0, 2026-10-15; P0 baseline 0.512). Gates: 5 pass, 0 fail (fiLine, overrun, fiPresence n/a); discrimination **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | v1.0.0 tuned | P0 baseline | P0 re-tuned | result |
|---|---|---|---|---|---|---|---|
| Order profile | 0.830 | 0.664 | 0.642 | 0.694 | 0.697 | 0.821 | pass |
| Spectral tilt | 0.771 | 0.616 | 0.327 | 0.722 | 0.495 | 0.642 | pass |
| Spectral centroid | 0.385 | 0.308 | 0.293 | 0.305 | 0.302 | 0.518 | pass |
| Sub-orders | 0.600 | 0.480 | 0.284 | 0.331 | 0.331 | 0.632 | pass |
| Pulse irregularity | 0.466 | 0.373 | 0.643 | 0.591 | 0.589 | 0.574 | pass |
| Forced-induction line | — | — | — | — | — | — | n/a |
| Overrun | — | — | 0.665 | 0.885 | 0.885 | 0.885 | n/a |
| Forced-induction presence | — | — | — | — | — | — | n/a |

Discrimination (re-tuned render vs each tuned engine's references): own 0.666; i5-turbo-25 0.461; v8-flatplane-45 0.436 (v1.0.0: own 0.546; i5-turbo-25 0.443; v8-flatplane-45 0.474).

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `mustang-dyno-a` | outside | [2015 Mustang GT Dyno](https://www.youtube.com/watch?v=FvX5M3eqJic) | wot: 8.6 | used |
| `mustang-dyno-b` | outside | [2016 Mustang GT Stock Baseline Dyno pull](https://www.youtube.com/watch?v=paJA5mV3qMw) | wot: 9.4 | used |
| `mustang-onboard-a` | cabin | [2024 Ford Mustang GT 6MT - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=H09A6zhUy3Y) | idle: 10.0, liftoff: 22.6, wot: 9.4 | used |
| `mustang-onboard-b` | cabin | [2024 Ford Mustang GT Premium 10AT - POV Test Drive (Binaural Audio)](https://www.youtube.com/watch?v=lWJ7lIjBsok) | idle: 8.6, wot: 14.7 | used |
| `mustang-onboard-c` | cabin | [2024 Mustang GT Morning POV Drive (No Commentary)](https://www.youtube.com/watch?v=QqwdLXkrxRk) | cruise: 28.0 | used |

Gates that failed at v1.0.0 and the Phase 5 P0 fixes (2026-10-15; phase 2a amendments B18/B19, phase 2b D9):

- **Sub-orders:** the recordings' orders 1–2.5 (the cross-plane bank-firing rumble) sat at 0 to −5 dB against −17 to −27 dB in the render, because both banks were voiced identically and the tuner could not set them apart. Fix: one header scale per bank and one length per collector in the tuner (P0.3). Re-tuned banks ×1.241 / ×0.930, collectors 0.313 / 0.901 m: 0.632 (gate 0.480; P0 baseline 0.331).
- **Spectral centroid:** the dark 4th-order cabin transfer. Fix: the B19 cabin (P0.2): 0.518 re-tuned (gate 0.308; low-pass 200 Hz, leak −38.7 dB).
- **Lift-off** (not gated): the render's overrun carries no engine orders, because fuel cut zeroes combustion; deferred (P0, measured as mixed).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 4.5 Flat-Plane V8 — inspired by Ferrari 458 Italia (`v8-flatplane-45`)

Tuned voicing: v8-flatplane-45

Composite (render vs references): default **0.424** → tuned **0.483** (v1.0.0) → re-tuned **0.604** (Phase 5 P0, 2026-10-15; P0 baseline 0.506). Gates: 5 pass, 0 fail (fiLine, overrun, fiPresence n/a); discrimination **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | v1.0.0 tuned | P0 baseline | P0 re-tuned | result |
|---|---|---|---|---|---|---|---|
| Order profile | 0.698 | 0.558 | 0.569 | 0.606 | 0.604 | 0.716 | pass |
| Spectral tilt | 0.263 | 0.210 | 0.213 | 0.228 | 0.463 | 0.479 | pass |
| Spectral centroid | 0.286 | 0.229 | 0.400 | 0.419 | 0.354 | 0.460 | pass |
| Sub-orders | 0.467 | 0.374 | 0.318 | 0.334 | 0.327 | 0.487 | pass |
| Pulse irregularity | 0.503 | 0.402 | 0.674 | 0.660 | 0.655 | 0.631 | pass |
| Forced-induction line | — | — | — | — | — | — | n/a |
| Overrun | — | — | 0.557 | 1.000 | 0.794 | 1.000 | n/a |
| Forced-induction presence | — | — | — | — | — | — | n/a |

Discrimination (re-tuned render vs each tuned engine's references): own 0.604; i5-turbo-25 0.387; v8-na-50 0.480 (v1.0.0: own 0.483; i5-turbo-25 0.364; v8-na-50 0.439).

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `f458-dyno-a` | outside | [2014 Ferrari 458 Spider Baseline Dyno Testing](https://www.youtube.com/watch?v=XwzmCrkcNOY) | wot: 15.7 | used |
| `f458-dyno-b` | outside | [Red 2012 FERRARI 458 ITALIA Dyno Run](https://www.youtube.com/watch?v=cLihUpXzods) | liftoff: 4.0, wot: 6.5 | used |
| `f458-onboard-a` | cabin | [FERRARI 458 0-310 KM/H ACCELERATION & SOUND by AutoTopNL](https://www.youtube.com/watch?v=X0yiRilcKME) | wot: 51.3 | used |
| `f458-onboard-b` | cabin | [Ferrari 458 Italia Onboard - Fast Lap of Monza Circuit](https://www.youtube.com/watch?v=3Z1szmKp59M) | liftoff: 6.1, wot: 6.0 | used |

Gates that failed at v1.0.0 and the Phase 5 P0 fixes (2026-10-15; phase 2a amendments B18/B19, phase 2b D9):

- **Sub-orders:** the recordings are led by order 2 (order 4 at −11 to −15 dB below it), while the render's order 2 sat near −25 dB: identical banks. Fix: one header scale per bank and one length per collector in the tuner (P0.3). Re-tuned banks ×1.043 / ×0.910, collectors 0.499 / 0.227 m: 0.487 (gate 0.374; P0 baseline 0.327).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).
