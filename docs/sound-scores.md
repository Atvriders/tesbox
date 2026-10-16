# Sound scores

How close each tuned engine sounds to recordings of the car that inspired it, measured by
`npm run score` (spec §11.3; phase 2b contract T8, phase 5 contract P2). Every number is a similarity in
0–1 between the engine's renders and real recordings; "ref vs ref" is how well two independent
recordings of the same car agree, and a metric's gate is 0.8 of that. Discrimination asks whether each
render matches its own car's recordings better than every other tuned engine's (here: all fifteen
engines). "Default" is the voicing derived from the engine's spec and "tuned" the
voicing found by `npm run tune` (CMA-ES), both rendered by the current synthesizer (with the phase 5
P0 sound-fidelity fixes). A measurement cannot hear: the user's listening sign-off is the final word,
and until then the garage shows **Beta voicing**.

Reproduce: `npm run score -- <engine-id> --gate` with the references in `lab-refs/` (see
[`SOUND_LAB.md`](SOUND_LAB.md)); `npm run tune -- <engine-id> --apply` writes a tuned voicing.

## 2.5 Turbo Inline-5 — inspired by Audi RS 3 (8Y) (`i5-turbo-25`)

Tuned voicing: i5-turbo-25

Composite (render vs references): default **0.428** → tuned **0.609**. Gates: 7 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.0.0 tuned 0.478 (tilt and forced-induction presence below gate); 1.1 re-tuned after the sound-fidelity fixes 0.597; 1.2 re-tuned against all engines' references 0.609.

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

Discrimination (tuned render vs each tuned engine's references): own 0.609; flat4-turbo-25 0.369; flat6-na-40 0.202; i4-turbo-20 0.404; i6-twinturbo-30 0.462; rotary-twin-13 0.397; v10-na-48 0.376; v10-na-52 0.277; v12-na-65 0.455; v6-twinturbo-38 0.512; v8-flatplane-45 0.234; v8-na-50 0.477; v8-na-62 0.218; v8-sc-62 0.526; v8-twinturbo-40 0.422.

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

Discrimination (tuned render vs each tuned engine's references): own 0.666; flat4-turbo-25 0.638; flat6-na-40 0.498; i4-turbo-20 0.569; i5-turbo-25 0.461; i6-twinturbo-30 0.442; rotary-twin-13 0.372; v10-na-48 0.261; v10-na-52 0.474; v12-na-65 0.437; v6-twinturbo-38 0.523; v8-flatplane-45 0.436; v8-na-62 0.561; v8-sc-62 0.485; v8-twinturbo-40 0.417.

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

Discrimination (tuned render vs each tuned engine's references): own 0.604; flat4-turbo-25 0.443; flat6-na-40 0.457; i4-turbo-20 0.458; i5-turbo-25 0.387; i6-twinturbo-30 0.387; rotary-twin-13 0.461; v10-na-48 0.400; v10-na-52 0.485; v12-na-65 0.495; v6-twinturbo-38 0.481; v8-na-50 0.480; v8-na-62 0.548; v8-sc-62 0.585; v8-twinturbo-40 0.513.

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

Composite (render vs references): default **0.375** → tuned **0.597**. Gates: 5 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.864 | 0.691 | 0.641 | 0.726 | pass |
| Spectral tilt | 0.542 | 0.434 | 0.666 | 0.738 | pass |
| Spectral centroid | 0.441 | 0.353 | 0.365 | 0.545 | pass |
| Sub-orders | 0.624 | 0.499 | 0.260 | 0.507 | pass |
| Pulse irregularity | 0.653 | 0.522 | 0.586 | 0.576 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.116 | 0.532 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.597; flat4-turbo-25 0.588; flat6-na-40 0.528; i4-turbo-20 0.542; i5-turbo-25 0.411; i6-twinturbo-30 0.420; rotary-twin-13 0.378; v10-na-48 0.245; v10-na-52 0.493; v12-na-65 0.462; v6-twinturbo-38 0.532; v8-flatplane-45 0.483; v8-na-50 0.590; v8-sc-62 0.495; v8-twinturbo-40 0.387.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `c8-cabin-a` | cabin | [2025 Chevrolet Corvette Stingray Coupe 3LT - POV Test Drive (Binaural Audio)](https://www.youtube.com/watch?v=C8R8LmbTsx4) | idle: 3.6, wot: 4.5 | used |
| `c8-cabin-b` | cabin | [2021 Chevrolet Corvette Z51 - POV Night Drive (Binaural Audio)](https://www.youtube.com/watch?v=IWEh0oG-YvU) | liftoff: 3.2, wot: 4.3 | used |
| `c8-dyno-a` | outside | [C8 Corvette Stock Dyno](https://www.youtube.com/watch?v=x3Lg_ykPUyk) | wot: 30.9 | used |
| `c8-dyno-b` | outside | [2020 C8 Corvette Dyno Run (Stock)](https://www.youtube.com/watch?v=WMob_LcxrHE) | liftoff: 3.7, wot: 6.8 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 6.2 Supercharged V8 — inspired by Dodge Challenger SRT Hellcat (`v8-sc-62`)

Tuned voicing: v8-sc-62

Composite (render vs references): default **0.284** → tuned **0.639**. Gates: 7 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.3.0 tuned 0.613 (order profile 0.696 below its 0.709 gate); phase 5 P0b re-tune 0.639.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.887 | 0.709 | 0.701 | 0.764 | pass |
| Spectral tilt | 0.633 | 0.506 | 0.615 | 0.582 | pass |
| Spectral centroid | 0.237 | 0.190 | 0.286 | 0.377 | pass |
| Sub-orders | 0.453 | 0.363 | 0.362 | 0.536 | pass |
| Pulse irregularity | 0.694 | 0.555 | 0.687 | 0.646 | pass |
| Forced-induction line | 0.676 | 0.541 | 0.016 | — | n/a |
| Overrun | 1.000 | 0.800 | 0.154 | 0.941 | pass |
| Forced-induction presence | 0.683 | 0.546 | 0.569 | 0.799 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.639; flat4-turbo-25 0.509; flat6-na-40 0.506; i4-turbo-20 0.573; i5-turbo-25 0.506; i6-twinturbo-30 0.468; rotary-twin-13 0.528; v10-na-48 0.407; v10-na-52 0.508; v12-na-65 0.488; v6-twinturbo-38 0.538; v8-flatplane-45 0.579; v8-na-50 0.489; v8-na-62 0.556; v8-twinturbo-40 0.601.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `hellcat-cabin-a` | cabin | [2015 Dodge Challenger SRT Hellcat (Manual) - WR TV POV Test Drive](https://www.youtube.com/watch?v=XShvhKViP5k) | idle: 3.9, wot: 3.9 | used |
| `hellcat-cabin-b` | cabin | [2015 Dodge Challenger SRT 6.2 Hellcat Red Key 707 HP TOP SPEED AUTOBAHN DRIVE POV](https://www.youtube.com/watch?v=0Ij8r0KuaxI) | liftoff: 7.7, wot: 17.6 | used |
| `hellcat-dyno-a` | outside | [2016 Dodge Challenger Hellcat (Stock) Dyno Pull 1](https://www.youtube.com/watch?v=Y-8RsNRQPsg) | liftoff: 6.4, wot: 8.4 | used |
| `hellcat-dyno-b` | outside | [Stock 2017 Hellcat Challenger Dyno Pull](https://www.youtube.com/watch?v=1uyBK0VvlAs) | liftoff: 1.7, wot: 3.8 | used |

What changed in phase 5 P0b:

- **Order profile** now passes (0.764 against the 0.709 gate; 1.3.0: 0.696). The re-tune (CMA-ES over the D10 vector, all fifteen libraries) set the new cabin boom (phase 2a amendment B21) to 143 Hz, +11.5 dB — a boost of the cabin path over ≈ 90–230 Hz (half the boost), where the cabin recordings' low boom lies (orders 1–2 near 90–180 Hz at 5,500 rpm) — and left the per-cylinder spread at 0 dB. The boom carries most of the gain: the same voicing without it scores order profile 0.714 and composite 0.584, and fails discrimination.

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

Discrimination (tuned render vs each tuned engine's references): own 0.663; flat4-turbo-25 0.395; flat6-na-40 0.538; i4-turbo-20 0.424; i5-turbo-25 0.468; rotary-twin-13 0.441; v10-na-48 0.314; v10-na-52 0.493; v12-na-65 0.551; v6-twinturbo-38 0.586; v8-flatplane-45 0.426; v8-na-50 0.455; v8-na-62 0.463; v8-sc-62 0.479; v8-twinturbo-40 0.360.

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

Discrimination (tuned render vs each tuned engine's references): own 0.640; flat4-turbo-25 0.213; i4-turbo-20 0.368; i5-turbo-25 0.390; i6-twinturbo-30 0.408; rotary-twin-13 0.298; v10-na-48 0.272; v10-na-52 0.438; v12-na-65 0.423; v6-twinturbo-38 0.599; v8-flatplane-45 0.389; v8-na-50 0.356; v8-na-62 0.415; v8-sc-62 0.420; v8-twinturbo-40 0.274.

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

Discrimination (tuned render vs each tuned engine's references): own 0.683; flat4-turbo-25 0.308; flat6-na-40 0.348; i4-turbo-20 0.356; i5-turbo-25 0.430; i6-twinturbo-30 0.419; rotary-twin-13 0.359; v10-na-48 0.490; v12-na-65 0.423; v6-twinturbo-38 0.455; v8-flatplane-45 0.439; v8-na-50 0.368; v8-na-62 0.400; v8-sc-62 0.464; v8-twinturbo-40 0.371.

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

Discrimination (tuned render vs each tuned engine's references): own 0.753; flat4-turbo-25 0.403; flat6-na-40 0.450; i4-turbo-20 0.335; i5-turbo-25 0.325; i6-twinturbo-30 0.505; rotary-twin-13 0.344; v10-na-48 0.218; v10-na-52 0.343; v6-twinturbo-38 0.456; v8-flatplane-45 0.365; v8-na-50 0.326; v8-na-62 0.316; v8-sc-62 0.323; v8-twinturbo-40 0.263.

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

Discrimination (tuned render vs each tuned engine's references): own 0.719; flat4-turbo-25 0.317; flat6-na-40 0.623; i4-turbo-20 0.477; i5-turbo-25 0.462; i6-twinturbo-30 0.533; rotary-twin-13 0.384; v10-na-48 0.282; v10-na-52 0.505; v12-na-65 0.479; v8-flatplane-45 0.474; v8-na-50 0.477; v8-na-62 0.501; v8-sc-62 0.502; v8-twinturbo-40 0.324.

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

Discrimination (tuned render vs each tuned engine's references): own 0.674; flat4-turbo-25 0.649; flat6-na-40 0.490; i4-turbo-20 0.645; i5-turbo-25 0.491; i6-twinturbo-30 0.536; rotary-twin-13 0.514; v10-na-48 0.427; v10-na-52 0.513; v12-na-65 0.650; v6-twinturbo-38 0.534; v8-flatplane-45 0.479; v8-na-50 0.559; v8-na-62 0.608; v8-sc-62 0.590.

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

Composite (render vs references): default **0.462** → tuned **0.726**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

History: 1.3.0 tuned 0.684; phase 5 P0b re-tune 0.696 (sub-orders 0.492 → 0.494, below their 0.527 gate); phase 5 P0c re-tune 0.726.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.912 | 0.730 | 0.666 | 0.812 | pass |
| Spectral tilt | 0.673 | 0.539 | 0.594 | 0.774 | pass |
| Spectral centroid | 0.329 | 0.263 | 0.231 | 0.511 | pass |
| Sub-orders | 0.659 | 0.527 | 0.510 | 0.582 | pass |
| Pulse irregularity | 0.564 | 0.451 | 0.593 | 0.594 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.170 | 1.000 | n/a |
| Forced-induction presence | 0.949 | 0.759 | 0.957 | 0.957 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.726; flat4-turbo-25 0.632; flat6-na-40 0.530; i5-turbo-25 0.403; i6-twinturbo-30 0.406; rotary-twin-13 0.527; v10-na-48 0.366; v10-na-52 0.435; v12-na-65 0.453; v6-twinturbo-38 0.534; v8-flatplane-45 0.581; v8-na-50 0.540; v8-na-62 0.579; v8-sc-62 0.597; v8-twinturbo-40 0.572.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `gti-cabin-a` | cabin | [2022 Volkswagen Golf GTI DSG POV Canyon Drive (3D Audio)(ASMR)](https://www.youtube.com/watch?v=ZZkKkwZbh_A) | liftoff: 2.1, wot: 22.9 | used |
| `gti-cabin-b` | cabin | [0-267km/h / Mk.8 VW Golf GTi / POV- Acceleration and Top speed TEST ✔](https://www.youtube.com/watch?v=T2b6Y3VVWF4) | wot: 6.4 | used |
| `gti-dyno-a` | outside | [2021 VW Golf GTI MK8 on the DYNO + 0-240km/h Acceleration / Dyno Results & Exhaust Sound](https://www.youtube.com/watch?v=1UGYTrtpYlE) | wot: 10.6 | used |
| `gti-exhaust-a` | outside | [2021 VW Golf 8 GTI DSG Stock Exhaust Sounds with Burbles / OnBoard, Exhaust, Accelerations & More!](https://www.youtube.com/watch?v=RfMebPPZD8I) | liftoff: 2.4, wot: 1.2 | used |
| `gti-exhaust-b` | outside | [2022 Volkswagen Golf GTI DSG Walkaround + Exhaust (No Talking)(ASMR)](https://www.youtube.com/watch?v=PtJ0gcujMt4) | idle: 4.0 | used |

What changed in phase 5 P0c:

- **Sub-orders** now pass (0.582 against the 0.527 gate; 1.4.0: 0.494). The engine keeps firing on the fuel cut (phase 2a amendment B23) at cutPulseDb 0 dB, its idle-load pulse level: the cabin lift-off pair rises from 0.12 to 0.67 (the outside lift-off pair falls from 0.13 to 0.05; the four WOT pairs score 0.55–0.81). The re-tune took two runs of the same CMA-ES command (D11 vector, all fifteen libraries). From the 1.4.0 voicing, with cutPulseDb at its neutral −60 dB, it stalled at 0.707 (sub-orders 0.495): the score does not move between −60 and −12 dB, so neither CMA-ES nor the polish ever raised the level (forced to −6 / 0 dB: sub-orders 0.503 / 0.542, composite 0.709 / 0.719). Started again from that result with cutPulseDb at 0 dB, it kept 0 dB and reached 0.726. Against 1.4.0 the voicing now has a wider pulse (widthDeg 58.6 → 66.1, beta 6.2 → 6.65), headers × 0.965, collector 0.711 m, mid-pipe 1.93 m, tailpipe 1.191 m, intake.gain 0.826, cabin.leakDb −28 dB and a boom of +5.4 dB at 64 Hz.

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 2.5 Turbo Flat-Four — inspired by Subaru WRX STI (EJ257) (`flat4-turbo-25`)

Tuned voicing: flat4-turbo-25

Composite (render vs references): default **0.564** → tuned **0.793**. Gates: 5 pass, 1 fail (orderProfile); discrimination **pass** → **FAIL**.

History: 1.3.0 tuned 0.786; phase 5 P0b re-tune 0.792 (order profile unchanged at 0.705); phase 5 P0c re-tune 0.793 (order profile still 0.705).

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.937 | 0.750 | 0.542 | 0.705 | fail |
| Spectral tilt | 0.787 | 0.629 | 0.572 | 0.764 | pass |
| Spectral centroid | 0.560 | 0.448 | 0.346 | 0.824 | pass |
| Sub-orders | 0.537 | 0.430 | 0.487 | 0.777 | pass |
| Pulse irregularity | 0.793 | 0.635 | 0.668 | 0.762 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | — | — | n/a |
| Forced-induction presence | 0.849 | 0.679 | 0.921 | 0.949 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.793; flat6-na-40 0.592; i4-turbo-20 0.485; i5-turbo-25 0.484; i6-twinturbo-30 0.541; rotary-twin-13 0.439; v10-na-48 0.278; v10-na-52 0.516; v12-na-65 0.631; v6-twinturbo-38 0.564; v8-flatplane-45 0.407; v8-na-50 0.582; v8-na-62 0.499; v8-sc-62 0.504; v8-twinturbo-40 0.465.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `sti-cabin-a` | cabin | [255 km/h - POV Drive - Subaru WRX STi (300 PS) on German Autobahn](https://www.youtube.com/watch?v=Q_vmioWUSxI) | wot: 15.0 | used |
| `sti-cabin-b` | cabin | [POV 2016 Subaru WRX STI 300 HP FAST! AUTOBAHN Acceleration Drive & Sound](https://www.youtube.com/watch?v=Mc6p0IdK-5A) | idle: 7.0, wot: 3.0 | used |
| `sti-cabin-c` | cabin | [2021 Subaru WRX STI - POV Test Drive 4K (Binaural Audio) Sound System](https://www.youtube.com/watch?v=_KW6LF3HqYc) | wot: 4.1 | used |
| `sti-exhaust-a` | outside | [2015 Wrx STI stock exhaust cold start and rev](https://www.youtube.com/watch?v=IOHPu8NV38Q) | idle: 16.0 | used |
| `sti-exhaust-b` | outside | [2020 sti stock exhaust - cold start, rev and idle](https://www.youtube.com/watch?v=neTRnfr_iaQ) | idle: 32.0 | used |

Gates not passed and their most likely structural causes (Phase 5 items):

- **Order profile** (0.705 against 0.750, unchanged by the phase 5 P0b and P0c re-tunes): per reference the cabin idle pair scores 0.58 and the three cabin WOT pairs 0.74–0.76, so with the idle pair as it is the WOT pairs would have to average 0.81. The P0c re-tune (CMA-ES over the D11 vector) left the new cabin cut (phase 2a amendment B22) neutral and moved only valvetrainGain (0.961 → 1) and forcedInduction.cabinGainDb (−12.3 → −15.8 dB). Forced cuts show why: −6 dB at 250 / 300 / 350 / 400 Hz lifts the WOT pairs to 0.75–0.77 but the order profile only to 0.695 / 0.710 / 0.715 / 0.715, at a composite of 0.735–0.739 (centroid, sub-orders and irregularity fall); −3 dB at 300 Hz gives 0.711 at 0.766. Engine pulses during overrun (B23) cannot help: no flat4-turbo-25 reference has a lift-off segment. The idle pair — the render's orders at ≈ 800 rpm, which no cut at 250–350 Hz reaches — is the likely next target (phase 5 follow-up).

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 1.3 Twin-Rotor Turbo Rotary — inspired by Mazda RX-7 (FD, 13B-REW) (`rotary-twin-13`)

Tuned voicing: rotary-twin-13

Composite (render vs references): default **0.459** → tuned **0.657**. Gates: 6 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.804 | 0.643 | 0.754 | 0.783 | pass |
| Spectral tilt | 0.399 | 0.319 | 0.371 | 0.499 | pass |
| Spectral centroid | 0.124 | 0.099 | 0.146 | 0.464 | pass |
| Sub-orders | 0.564 | 0.451 | 0.384 | 0.653 | pass |
| Pulse irregularity | 0.498 | 0.398 | 0.603 | 0.686 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | — | — | n/a |
| Forced-induction presence | 0.972 | 0.777 | 0.988 | 0.988 | pass |

Discrimination (tuned render vs each tuned engine's references): own 0.657; flat4-turbo-25 0.525; flat6-na-40 0.367; i4-turbo-20 0.379; i5-turbo-25 0.368; i6-twinturbo-30 0.462; v10-na-48 0.298; v10-na-52 0.413; v12-na-65 0.532; v6-twinturbo-38 0.363; v8-flatplane-45 0.352; v8-na-50 0.361; v8-na-62 0.360; v8-sc-62 0.361; v8-twinturbo-40 0.397.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `rx7-cabin-a` | cabin | [【FD3S RX-7】高速道路合流120キロ全開加速11連発！ピー音と至高のロータリーサウンド〜東北道篇〜ASMR/ロータリーエンジン ベタ踏み/純正マフラー排気音](https://www.youtube.com/watch?v=THvULkLt_Sk) | cruise: 8.6, wot: 12.1 | used |
| `rx7-cabin-b` | cabin | [【FD3S RX-7】8000回転120キロ全開加速ロータリーサウンド〜新東名120キロ区間編/ノーマルマフラー排気音](https://www.youtube.com/watch?v=7rzPQ29hyPA) | wot: 6.9 | used |
| `rx7-cabin-c` | cabin | [rx7 フルノーマル 加速 0-100 fd3s](https://www.youtube.com/watch?v=6O4D8sj5NDk) | wot: 7.1 | used |
| `rx7-exhaust-a` | outside | [【FD3S 6型】RX-7 純正マフラーサウンド](https://www.youtube.com/watch?v=e5bv_8Ksmt4) | idle: 36.0 | used |
| `rx7-exhaust-b` | outside | [FD3S型RX-7　ノーマルマフラーサウンド](https://www.youtube.com/watch?v=ucxQPj7NAYk) | idle: 2.3 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).

## 4.8 V10 NA — inspired by Lexus LFA (`v10-na-48`)

Tuned voicing: v10-na-48

Composite (render vs references): default **0.302** → tuned **0.620**. Gates: 5 pass, 0 fail; discrimination **pass** → **PASS**.

| metric | ref vs ref | gate (0.8 ×) | default | tuned | result |
|---|---|---|---|---|---|
| Order profile | 0.857 | 0.686 | 0.791 | 0.768 | pass |
| Spectral tilt | 0.547 | 0.438 | 0.349 | 0.657 | pass |
| Spectral centroid | 0.286 | 0.229 | 0.265 | 0.308 | pass |
| Sub-orders | 0.465 | 0.372 | 0.423 | 0.512 | pass |
| Pulse irregularity | 0.492 | 0.394 | 0.498 | 0.710 | pass |
| Forced-induction line | — | — | — | — | n/a |
| Overrun | — | — | 0.050 | 1.000 | n/a |
| Forced-induction presence | — | — | — | — | n/a |

Discrimination (tuned render vs each tuned engine's references): own 0.620; flat4-turbo-25 0.124; flat6-na-40 0.281; i4-turbo-20 0.296; i5-turbo-25 0.464; i6-twinturbo-30 0.277; rotary-twin-13 0.249; v10-na-52 0.513; v12-na-65 0.246; v6-twinturbo-38 0.374; v8-flatplane-45 0.378; v8-na-50 0.282; v8-na-62 0.367; v8-sc-62 0.394; v8-twinturbo-40 0.297.

References (private, local only — never committed or shipped):

| clip | perspective | source | segments (kind: seconds) | status |
|---|---|---|---|---|
| `lfa-cabin-a` | cabin | [Lexus LFA / Phillip Island Track POV / Pure sound](https://www.youtube.com/watch?v=5685xkTpgHw) | liftoff: 2.9, wot: 14.8 | used |
| `lfa-cabin-b` | cabin | [Lexus LFA Nordschleife lap](https://www.youtube.com/watch?v=H_fcVWkvK2Q) | wot: 31.9 | used |
| `lfa-dyno-a` | outside | [Lexus LFA Nürburgring Edition Dyno – 5 Minutes of Screaming V10 at 9,000 RPM](https://www.youtube.com/watch?v=7KD3cRKhK7A) | liftoff: 11.7, wot: 9.2 | used |
| `lfa-dyno-b` | outside | [2012 Lexus LFA Whitest White Dyno Run 1 @ SP Engineering](https://www.youtube.com/watch?v=IuDn3vE93cA) | wot: 10.6 | used |
| `lfa-dyno-c` | outside | [Lexus LFA V10 making music on the dyno!](https://www.youtube.com/watch?v=er_OWJ4E83I) | wot: 4.2 | used |

Sign-off: pending — the user's listening check (default vs tuned previews, cabin and outside).
