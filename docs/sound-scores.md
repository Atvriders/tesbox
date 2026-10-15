# Sound scores

How close each tuned engine sounds to recordings of the car that inspired it, measured by
`npm run score` (spec §11.3; phase 2b contract T8, phase 5 contract P2). Every number is a similarity in
0–1 between the engine's renders and real recordings; "ref vs ref" is how well two independent
recordings of the same car agree, and a metric's gate is 0.8 of that. Discrimination asks whether each
render matches its own car's recordings better than every other tuned engine's (here: all twelve
engines with references). "Default" is the voicing derived from the engine's spec and "tuned" the
voicing found by `npm run tune` (CMA-ES), both rendered by the current synthesizer (with the phase 5
P0 sound-fidelity fixes). A measurement cannot hear: the user's listening sign-off is the final word,
and until then the garage shows **Beta voicing**.

Reproduce: `npm run score -- <engine-id> --gate` with the references in `lab-refs/` (see
[`SOUND_LAB.md`](SOUND_LAB.md)); `npm run tune -- <engine-id> --apply` writes a tuned voicing.

## 2.5 Turbo Inline-5 — inspired by Audi RS 3 (8Y) (`i5-turbo-25`)

Tuned voicing: i5-turbo-25

Composite (render vs references): default **0.428** → tuned **0.609**. Gates: 7 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.0.0 tuned 0.478 (tilt and forced-induction presence below gate); 1.1 re-tuned after the sound-fidelity fixes 0.597.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.645 | 0.516 | 0.757 | 0.739 | pass |
| Spectral tilt | 0.506 | 0.405 | 0.289 | 0.426 | pass |
| Spectral centroid | 0.277 | 0.221 | 0.211 | 0.412 | pass |
| Sub-orders | 0.402 | 0.322 | 0.388 | 0.516 | pass |
| Pulse irregularity | 0.640 | 0.512 | 0.554 | 0.585 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | 0.501 | 0.401 | 0.281 | 0.834 | pass |
| Forced-induction presence | 1.000 | 0.800 | 0.938 | 0.947 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.609; flat6-na-40 0.202; i4-turbo-20 0.404; i6-twinturbo-30 0.462; v10-na-52 0.277; v12-na-65 0.455; v6-twinturbo-38 0.512; v8-flatplane-45 0.234; v8-na-50 0.477; v8-na-62 0.218; v8-sc-62 0.526; v8-twinturbo-40 0.422.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `rs3-dyno-a` | outside | [Stock 2018 Audi RS3 hits the Dyno](https://www.youtube.com/watch?v=hiCDg22RnLg) | liftoff: 1.5, wot: 20.4 | used |
| `rs3-dyno-b` | outside | [RS3 Power Run *381bhp* Stock](https://www.youtube.com/watch?v=2mvqRs2s8VE) | wot: 21.9 | used |
| `rs3-onboard-a` | cabin | [2016 Audi RS 3 / 13 minutes of pure 5 cylinder onboard sound](https://www.youtube.com/watch?v=Ho34caoeT2o) | cruise: 8.7, liftoff: 6.2, wot: 6.0 | used |
| `rs3-onboard-b` | cabin | [2022 AUDI RS3 Sportback 8Y / 0-288 KM/H Acceleration / POV Drive & Sound by AutoTopNL](https://www.youtube.com/watch?v=k4SCpXBSruk) | liftoff: 9.7, wot: 31.1 | used |
| `rs3-onboard-c` | cabin | [2025 Audi RS3 - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=9eQmBZpeawk) | idle: 3.6 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 5.0 V8 NA — inspired by Ford Mustang GT (Coyote) (`v8-na-50`)

Tuned voicing: v8-na-50

Composite (render vs references): default **0.390** → tuned **0.666**. Gates: 5 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.0.0 tuned 0.546 (centroid and sub-orders below gate); 1.1 re-tuned 0.666.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.830 | 0.664 | 0.639 | 0.821 | pass |
| Spectral tilt | 0.771 | 0.616 | 0.468 | 0.642 | pass |
| Spectral centroid | 0.385 | 0.308 | 0.286 | 0.518 | pass |
| Sub-orders | 0.600 | 0.480 | 0.302 | 0.632 | pass |
| Pulse irregularity | 0.466 | 0.373 | 0.644 | 0.574 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.210 | 0.885 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.666; flat6-na-40 0.498; i4-turbo-20 0.569; i5-turbo-25 0.461; i6-twinturbo-30 0.442; v10-na-52 0.474; v12-na-65 0.437; v6-twinturbo-38 0.523; v8-flatplane-45 0.436; v8-na-62 0.561; v8-sc-62 0.485; v8-twinturbo-40 0.417.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `mustang-dyno-a` | outside | [2015 Mustang GT Dyno](https://www.youtube.com/watch?v=FvX5M3eqJic) | wot: 8.6 | used |
| `mustang-dyno-b` | outside | [2016 Mustang GT Stock Baseline Dyno pull](https://www.youtube.com/watch?v=paJA5mV3qMw) | wot: 9.4 | used |
| `mustang-onboard-a` | cabin | [2024 Ford Mustang GT 6MT - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=H09A6zhUy3Y) | idle: 10.0, liftoff: 22.6, wot: 9.4 | used |
| `mustang-onboard-b` | cabin | [2024 Ford Mustang GT Premium 10AT - POV Test Drive (Binaural Audio)](https://www.youtube.com/watch?v=lWJ7lIjBsok) | idle: 8.6, wot: 14.7 | used |
| `mustang-onboard-c` | cabin | [2024 Mustang GT Morning POV Drive (No Commentary)](https://www.youtube.com/watch?v=QqwdLXkrxRk) | cruise: 28.0 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 4.5 Flat-Plane V8 — inspired by Ferrari 458 Italia (`v8-flatplane-45`)

Tuned voicing: v8-flatplane-45

Composite (render vs references): default **0.431** → tuned **0.604**. Gates: 5 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.0.0 tuned 0.483 (sub-orders below gate); 1.1 re-tuned 0.604.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.698 | 0.558 | 0.567 | 0.716 | pass |
| Spectral tilt | 0.263 | 0.210 | 0.440 | 0.479 | pass |
| Spectral centroid | 0.286 | 0.229 | 0.340 | 0.460 | pass |
| Sub-orders | 0.467 | 0.374 | 0.324 | 0.487 | pass |
| Pulse irregularity | 0.503 | 0.402 | 0.666 | 0.631 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.351 | 1.000 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.604; flat6-na-40 0.457; i4-turbo-20 0.458; i5-turbo-25 0.387; i6-twinturbo-30 0.387; v10-na-52 0.485; v12-na-65 0.495; v6-twinturbo-38 0.481; v8-na-50 0.480; v8-na-62 0.548; v8-sc-62 0.585; v8-twinturbo-40 0.513.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `f458-dyno-a` | outside | [2014 Ferrari 458 Spider Baseline Dyno Testing](https://www.youtube.com/watch?v=XwzmCrkcNOY) | wot: 15.7 | used |
| `f458-dyno-b` | outside | [Red 2012 FERRARI 458 ITALIA Dyno Run](https://www.youtube.com/watch?v=cLihUpXzods) | liftoff: 4.0, wot: 6.5 | used |
| `f458-onboard-a` | cabin | [FERRARI 458 0-310 KM/H ACCELERATION & SOUND by AutoTopNL](https://www.youtube.com/watch?v=X0yiRilcKME) | wot: 51.3 | used |
| `f458-onboard-b` | cabin | [Ferrari 458 Italia Onboard - Fast Lap of Monza Circuit](https://www.youtube.com/watch?v=3Z1szmKp59M) | liftoff: 6.1, wot: 6.0 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 6.2 Small-Block V8 NA — inspired by Chevrolet Corvette (C8, LT2) (`v8-na-62`)

Tuned voicing: v8-na-62

Composite (render vs references): default **0.375** → tuned **0.592**. Gates: 4 pass, 1 fail (subOrder); discrimination **pass** → **FAIL**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.864 | 0.691 | 0.641 | 0.744 | pass |
| Spectral tilt | 0.542 | 0.434 | 0.666 | 0.745 | pass |
| Spectral centroid | 0.441 | 0.353 | 0.365 | 0.562 | pass |
| Sub-orders | 0.624 | 0.499 | 0.260 | 0.467 | fail |
| Pulse irregularity | 0.653 | 0.522 | 0.586 | 0.555 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.116 | 0.532 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.592; flat6-na-40 0.537; i4-turbo-20 0.551; i5-turbo-25 0.415; i6-twinturbo-30 0.421; v10-na-52 0.501; v12-na-65 0.466; v6-twinturbo-38 0.529; v8-flatplane-45 0.481; v8-na-50 0.576; v8-sc-62 0.493; v8-twinturbo-40 0.384.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `c8-cabin-a` | cabin | [2025 Chevrolet Corvette Stingray Coupe 3LT - POV Test Drive (Binaural Audio)](https://www.youtube.com/watch?v=C8R8LmbTsx4) | idle: 3.6, wot: 4.5 | used |
| `c8-cabin-b` | cabin | [2021 Chevrolet Corvette Z51 - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=IWEh0oG-YvU) | liftoff: 3.2, wot: 4.3 | used |
| `c8-dyno-a` | outside | [C8 Corvette Stock Dyno](https://www.youtube.com/watch?v=x3Lg_ykPUyk) | wot: 30.9 | used |
| `c8-dyno-b` | outside | [2020 C8 Corvette Dyno Run (Stock)](https://www.youtube.com/watch?v=WMob_LcxrHE) | liftoff: 3.7, wot: 6.8 | used |

Gates not passed and their most likely structural causes (Phase 5 items):

- **Sub-orders** (0.467 against 0.499): at full load outside, the dyno recordings carry orders 0.5–2 within about 10 dB of the strongest order, the render 20–30 dB below it, even with the banks voiced apart. Bank asymmetry in pipe lengths alone does not raise the half orders that far; a fixed per-cylinder combustion-level spread (cylinder-to-cylinder variation, which creates half orders directly) is the likely fix (phase 5 follow-up).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 6.2 Supercharged V8 — inspired by Dodge Challenger SRT Hellcat (`v8-sc-62`)

Tuned voicing: v8-sc-62

Composite (render vs references): default **0.284** → tuned **0.613**. Gates: 6 pass, 1 fail (orderProfile); discrimination **pass** → **FAIL**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.887 | 0.709 | 0.701 | 0.696 | fail |
| Spectral tilt | 0.633 | 0.506 | 0.615 | 0.600 | pass |
| Spectral centroid | 0.237 | 0.190 | 0.286 | 0.291 | pass |
| Sub-orders | 0.453 | 0.363 | 0.362 | 0.488 | pass |
| Pulse irregularity | 0.694 | 0.555 | 0.687 | 0.713 | pass |
| Forced-induction line | 0.676 | 0.541 | 0.016 | — | n/a |
| Overrun | 1.000 | 0.800 | 0.154 | 0.941 | pass |
| Forced-induction presence | 0.683 | 0.546 | 0.569 | 0.819 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.613; flat6-na-40 0.477; i4-turbo-20 0.537; i5-turbo-25 0.511; i6-twinturbo-30 0.492; v10-na-52 0.541; v12-na-65 0.410; v6-twinturbo-38 0.501; v8-flatplane-45 0.543; v8-na-50 0.509; v8-na-62 0.554; v8-twinturbo-40 0.582.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `hellcat-cabin-a` | cabin | [2015 Dodge Challenger SRT Hellcat (Manual) - WR TV POV Test Drive](https://www.youtube.com/watch?v=XShvhKViP5k) | idle: 3.9, wot: 3.9 | used |
| `hellcat-cabin-b` | cabin | [2015 Dodge Challenger SRT 6.2 Hellcat Red Key 707 HP TOP SPEED AUTOBAHN DRIVE POV](https://www.youtube.com/watch?v=0Ij8r0KuaxI) | liftoff: 7.7, wot: 17.6 | used |
| `hellcat-dyno-a` | outside | [2016 Dodge Challenger Hellcat (Stock) Dyno Pull 1](https://www.youtube.com/watch?v=Y-8RsNRQPsg) | liftoff: 6.4, wot: 8.4 | used |
| `hellcat-dyno-b` | outside | [Stock 2017 Hellcat Challenger Dyno Pull](https://www.youtube.com/watch?v=1uyBK0VvlAs) | liftoff: 1.7, wot: 3.8 | used |

Gates not passed and their most likely structural causes (Phase 5 items):

- **Order profile** (0.696 against the 0.709 gate, a near miss): the cabin recordings are led by orders 1–2 (a low boom near 90–180 Hz at 5,500 rpm) with the upper orders falling about 30 dB by order 10, while the render is led by the firing order 4 and keeps orders 5.5–12 about 10 dB stronger. No voicing parameter shapes the cabin's low orders; a cabin low-frequency resonance in the cabin transfer is the likely fix (phase 5 follow-up).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 3.0 Twin-Turbo Inline-6 — inspired by Toyota Supra (A80, 2JZ-GTE) (`i6-twinturbo-30`)

Tuned voicing: i6-twinturbo-30

Composite (render vs references): default **0.471** → tuned **0.663**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.730 | 0.584 | 0.693 | 0.753 | pass |
| Spectral tilt | 0.476 | 0.380 | 0.537 | 0.575 | pass |
| Spectral centroid | 0.140 | 0.112 | 0.192 | 0.472 | pass |
| Sub-orders | 0.565 | 0.452 | 0.235 | 0.546 | pass |
| Pulse irregularity | 0.655 | 0.524 | 0.712 | 0.764 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | — | — | n/a |
| Forced-induction presence | 0.987 | 0.789 | 0.915 | 0.994 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.663; flat6-na-40 0.538; i4-turbo-20 0.424; i5-turbo-25 0.468; v10-na-52 0.493; v12-na-65 0.551; v6-twinturbo-38 0.586; v8-flatplane-45 0.426; v8-na-50 0.455; v8-na-62 0.463; v8-sc-62 0.479; v8-twinturbo-40 0.360.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `supra-cabin-a` | cabin | [1994 Toyota Supra MK4 *FACTORY NEW* ACCELERATION TOP SPEED POV & SOUND by AutoTopNL](https://www.youtube.com/watch?v=fb1wzYpkduI) | wot: 23.1 | used |
| `supra-cabin-b` | cabin | [BRAND NEW! 1994 Toyota SUPRA MK4 265km/h on AUTOBAHN! by AutoTopNL](https://www.youtube.com/watch?v=VrbdDW0QSWI) | wot: 35.4 | used |
| `supra-cabin-c` | cabin | [OEM Toyota Supra twin turbo acceleration 0-120mph with stock boost](https://www.youtube.com/watch?v=FAEDeRbfBlE) | wot: 15.9 | used |
| `supra-dyno-a` | outside | [Supra MK4 - Canada spec 320hp stock. Dyno run](https://www.youtube.com/watch?v=1cDzUuGLT8s) | wot: 11.5 | used |
| `supra-dyno-b` | outside | [Supra 2jz gte auto stock dyno](https://www.youtube.com/watch?v=XjDvvDWDArA) | wot: 11.2 | used |
| `supra-exhaust-a` | outside | [1998 Supra Turbo stock sound](https://www.youtube.com/watch?v=8Dh5FpxOXEg) | idle: 4.3 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 4.0 Flat-Six NA — inspired by Porsche 911 GT3 (992) (`flat6-na-40`)

Tuned voicing: flat6-na-40

Composite (render vs references): default **0.543** → tuned **0.640**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.868 | 0.695 | 0.724 | 0.763 | pass |
| Spectral tilt | 0.343 | 0.274 | 0.489 | 0.612 | pass |
| Spectral centroid | 0.295 | 0.236 | 0.483 | 0.514 | pass |
| Sub-orders | 0.468 | 0.374 | 0.381 | 0.456 | pass |
| Pulse irregularity | 0.589 | 0.471 | 0.666 | 0.630 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | 1.000 | 0.800 | 0.588 | 1.000 | pass |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.640; i4-turbo-20 0.368; i5-turbo-25 0.390; i6-twinturbo-30 0.408; v10-na-52 0.438; v12-na-65 0.423; v6-twinturbo-38 0.599; v8-flatplane-45 0.389; v8-na-50 0.356; v8-na-62 0.415; v8-sc-62 0.420; v8-twinturbo-40 0.274.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `gt3-dyno-a` | outside | [Porsche 992 GT3 2022+ / Stock Baseline Dyno / How Much Power Does it Make?](https://www.youtube.com/watch?v=LJMZjXKifc4) | liftoff: 2.4, wot: 12.8 | used |
| `gt3-dyno-b` | outside | [2021 Porsche 992 GT3 SCREAMING to 9000 RPM on the DYNO / 4.0 liter NA Flat-Six Engine Sound!](https://www.youtube.com/watch?v=NawUsCKVqtE) | wot: 18.4 | used |
| `gt3-onboard-a` | cabin | [NEW Porsche 911 GT3 992.2 POV / 315 KM/H TOP SPEED on AUTOBAHN / RAW SOUND](https://www.youtube.com/watch?v=H3C7FMVCqFY) | cruise: 12.4, liftoff: 21.2, wot: 30.1 | used |
| `gt3-onboard-b` | cabin | [2022 Porsche 911 GT3 (Manual) - POV Night Drive](https://www.youtube.com/watch?v=t6N5GmiSIaY) | cruise: 3.4, liftoff: 15.5, wot: 5.7 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 5.2 V10 NA — inspired by Lamborghini Huracán (`v10-na-52`)

Tuned voicing: v10-na-52

Composite (render vs references): default **0.543** → tuned **0.683**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.816 | 0.653 | 0.787 | 0.749 | pass |
| Spectral tilt | 0.796 | 0.637 | 0.497 | 0.722 | pass |
| Spectral centroid | 0.459 | 0.367 | 0.544 | 0.716 | pass |
| Sub-orders | 0.266 | 0.213 | 0.443 | 0.579 | pass |
| Pulse irregularity | 0.588 | 0.470 | 0.595 | 0.541 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | 0.769 | 0.615 | 0.457 | 0.840 | pass |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.683; flat6-na-40 0.348; i4-turbo-20 0.356; i5-turbo-25 0.430; i6-twinturbo-30 0.419; v12-na-65 0.423; v6-twinturbo-38 0.455; v8-flatplane-45 0.439; v8-na-50 0.368; v8-na-62 0.400; v8-sc-62 0.464; v8-twinturbo-40 0.371.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `huracan-dyno-a` | outside | [Lamborghini huracan Dyno run @ HP Logic](https://www.youtube.com/watch?v=S9NTE6Kdc4M) | wot: 5.5 | used |
| `huracan-dyno-b` | outside | [Lamborghini Huracan On Dyno At JF Automotive](https://www.youtube.com/watch?v=NPhUhTWQKcg) | liftoff: 3.7, wot: 8.1 | used |
| `huracan-onboard-a` | cabin | [Lamborghini Huracan POV ACCELERATION & TOP SPEED 342 km/h Autobahn Test Drive Sound Exhaust](https://www.youtube.com/watch?v=c4a5OpilS5w) | liftoff: 10.2, wot: 23.7 | used |
| `huracan-onboard-b` | cabin | [2015 Lamborghini Huracán LP 610-4 - WR TV POV Test Drive](https://www.youtube.com/watch?v=ACQYLbpbNkQ) | cruise: 4.0, liftoff: 8.6 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 6.5 V12 NA — inspired by Ferrari 812 Superfast (`v12-na-65`)

Tuned voicing: v12-na-65

Composite (render vs references): default **0.497** → tuned **0.753**. Gates: 5 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.815 | 0.652 | 0.693 | 0.797 | pass |
| Spectral tilt | 0.717 | 0.573 | 0.928 | 0.939 | pass |
| Spectral centroid | 0.233 | 0.186 | 0.502 | 0.527 | pass |
| Sub-orders | 0.405 | 0.324 | 0.353 | 0.612 | pass |
| Pulse irregularity | 0.734 | 0.587 | 0.677 | 0.797 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.196 | 0.950 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.753; flat6-na-40 0.450; i4-turbo-20 0.335; i5-turbo-25 0.325; i6-twinturbo-30 0.505; v10-na-52 0.343; v6-twinturbo-38 0.456; v8-flatplane-45 0.365; v8-na-50 0.326; v8-na-62 0.316; v8-sc-62 0.323; v8-twinturbo-40 0.263.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `f812-exhaust-a` | outside | [2018 Ferrari 812 Superfast Cold Start](https://www.youtube.com/watch?v=20OXxBsFE6c) | idle: 8.5 | used |
| `f812-exhaust-b` | outside | [Ferrari 812 Superfast Cold Start](https://www.youtube.com/watch?v=JyZns5KEN30) | idle: 5.0 | used |
| `f812-onboard-a` | cabin | [Ferrari 812 Superfast V12 POV Test Drive (3D Audio)(ASMR)](https://www.youtube.com/watch?v=3tAE-TRiT-8) | wot: 6.7 | used |
| `f812-onboard-b` | cabin | [Ferrari 812 Superfast / HOT LAP / Nordschleife / 7.27,48 min / sport auto](https://www.youtube.com/watch?v=MswIflgRyTA) | liftoff: 11.7, wot: 16.4 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 3.8 Twin-Turbo V6 — inspired by Nissan GT-R (R35, VR38DETT) (`v6-twinturbo-38`)

Tuned voicing: v6-twinturbo-38

Composite (render vs references): default **0.585** → tuned **0.719**. Gates: 7 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.889 | 0.712 | 0.798 | 0.828 | pass |
| Spectral tilt | 0.632 | 0.506 | 0.463 | 0.677 | pass |
| Spectral centroid | 0.449 | 0.359 | 0.347 | 0.599 | pass |
| Sub-orders | 0.569 | 0.455 | 0.398 | 0.486 | pass |
| Pulse irregularity | 0.616 | 0.493 | 0.643 | 0.704 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | 0.779 | 0.623 | 0.890 | 0.890 | pass |
| Forced-induction presence | 0.989 | 0.791 | 0.802 | 0.976 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.719; flat6-na-40 0.623; i4-turbo-20 0.477; i5-turbo-25 0.462; i6-twinturbo-30 0.533; v10-na-52 0.505; v12-na-65 0.479; v8-flatplane-45 0.474; v8-na-50 0.477; v8-na-62 0.501; v8-sc-62 0.502; v8-twinturbo-40 0.324.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `gtr-cabin-a` | cabin | [NISSAN GTR NISMO R35 / 0-320 POV ACCELERATION TOP SPEED & SOUND by AutoTopNL](https://www.youtube.com/watch?v=ETUNtvkXhRk) | liftoff: 10.7, wot: 1.6 | used |
| `gtr-cabin-b` | cabin | [2023 Nissan GT-R Premium - POV Test Drive (Binaural Audio)](https://www.youtube.com/watch?v=bsDz2I-OqNg) | cruise: 3.3, liftoff: 15.3, wot: 6.6 | used |
| `gtr-dyno-a` | outside | [2017 Nissan Nismo GT-R Baseline Dyno Pull](https://www.youtube.com/watch?v=HMTrqA4vP1c) | liftoff: 2.3, wot: 8.4 | used |
| `gtr-dyno-b` | outside | [2015 GTR Baseline Dyno at Performance Solutions](https://www.youtube.com/watch?v=cUN1Vc7fHF0) | wot: 17.6 | used |
| `gtr-dyno-c` | outside | [2017 Nissan GTR FIRSTLOOK on the Dyno.](https://www.youtube.com/watch?v=OHCH9fEBsLE) | wot: 13.3 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 4.0 Twin-Turbo V8 — inspired by Audi RS 6 Avant (C8) (`v8-twinturbo-40`)

Tuned voicing: v8-twinturbo-40

Composite (render vs references): default **0.238** → tuned **0.674**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.839 | 0.671 | 0.613 | 0.731 | pass |
| Spectral tilt | 0.650 | 0.520 | 0.598 | 0.788 | pass |
| Spectral centroid | 0.399 | 0.319 | 0.246 | 0.398 | pass |
| Sub-orders | 0.477 | 0.381 | 0.148 | 0.484 | pass |
| Pulse irregularity | 0.737 | 0.589 | 0.682 | 0.629 | pass |
| Forced-induction line | — | — | 0.015 | — | n/a |
| Overrun | — | — | 0.088 | 1.000 | n/a |
| Forced-induction presence | 0.878 | 0.703 | 0.870 | 0.903 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.674; flat6-na-40 0.490; i4-turbo-20 0.645; i5-turbo-25 0.491; i6-twinturbo-30 0.536; v10-na-52 0.513; v12-na-65 0.650; v6-twinturbo-38 0.534; v8-flatplane-45 0.479; v8-na-50 0.559; v8-na-62 0.608; v8-sc-62 0.590.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `rs6-cabin-a` | cabin | [2020 AUDI RS6 C8 / 0-305km/h ACCELERATION TOP SPEED & EXHAUST SOUND by AutoTopNL](https://www.youtube.com/watch?v=Exq6pB3IGyU) | wot: 11.5 | used |
| `rs6-cabin-b` | cabin | [2023 Audi RS6 Avant (600 PS) TOP SPEED AUTOBAHN DRIVE POV](https://www.youtube.com/watch?v=m-jCN0xkk7M) | wot: 7.2 | used |
| `rs6-cabin-c` | cabin | [2021 Audi RS6 Avant POV Test Drive (3D Audio)(ASMR)](https://www.youtube.com/watch?v=KzhgIrHkX-4) | wot: 16.8 | used |
| `rs6-dyno-a` | outside | [2024 Audi RS6 C8 Performance Stock Dyno](https://www.youtube.com/watch?v=eAyP6IShD4k) | liftoff: 4.7, wot: 2.7 | used |
| `rs6-dyno-b` | outside | [STOCK RS6 Dyno](https://www.youtube.com/watch?v=Mg1d_CSeaq8) | wot: 9.3 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 2.0 Turbo Inline-4 — inspired by VW Golf GTI (Mk8) (`i4-turbo-20`)

Tuned voicing: i4-turbo-20

Composite (render vs references): default **0.462** → tuned **0.684**. Gates: 5 pass, 1 fail (subOrder); discrimination **pass** → **FAIL**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.912 | 0.730 | 0.666 | 0.785 | pass |
| Spectral tilt | 0.673 | 0.539 | 0.594 | 0.760 | pass |
| Spectral centroid | 0.329 | 0.263 | 0.231 | 0.440 | pass |
| Sub-orders | 0.659 | 0.527 | 0.510 | 0.492 | fail |
| Pulse irregularity | 0.564 | 0.451 | 0.593 | 0.564 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.170 | 1.000 | n/a |
| Forced-induction presence | 0.949 | 0.759 | 0.957 | 0.957 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.684; flat6-na-40 0.572; i5-turbo-25 0.450; i6-twinturbo-30 0.405; v10-na-52 0.486; v12-na-65 0.504; v6-twinturbo-38 0.561; v8-flatplane-45 0.556; v8-na-50 0.562; v8-na-62 0.591; v8-sc-62 0.591; v8-twinturbo-40 0.579.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `gti-cabin-a` | cabin | [2022 Volkswagen Golf GTI DSG POV Canyon Drive (3D Audio)(ASMR)](https://www.youtube.com/watch?v=ZZkKkwZbh_A) | liftoff: 2.1, wot: 22.9 | used |
| `gti-cabin-b` | cabin | [0-267km/h / Mk.8 VW Golf GTi / POV- Acceleration and Top speed TEST ✔](https://www.youtube.com/watch?v=T2b6Y3VVWF4) | wot: 6.4 | used |
| `gti-dyno-a` | outside | [2021 VW Golf GTI MK8 on the DYNO + 0-240km/h Acceleration / Dyno Results & Exhaust Sound](https://www.youtube.com/watch?v=1UGYTrtpYlE) | wot: 10.6 | used |
| `gti-exhaust-a` | outside | [2021 VW Golf 8 GTI DSG Stock Exhaust Sounds with Burbles / OnBoard, Exhaust, Accelerations & More!](https://www.youtube.com/watch?v=RfMebPPZD8I) | liftoff: 2.4, wot: 1.2 | used |
| `gti-exhaust-b` | outside | [2022 Volkswagen Golf GTI DSG Walkaround + Exhaust (No Talking)(ASMR)](https://www.youtube.com/watch?v=PtJ0gcujMt4) | idle: 4.0 | used |

Gates not passed and their most likely structural causes (Phase 5 items):

- **Sub-orders** (0.492 against 0.527, a near miss): in the cabin at 6,000 rpm the render's half orders sit between the two recordings'; the shortfall comes from other rpm bins and the outside clips. The same per-cylinder combustion-level spread is the candidate fix (phase 5 follow-up).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).
