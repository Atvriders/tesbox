# Changelog

All notable changes to Tesbox. Versions follow Semantic Versioning; each release is also published as
the Docker image `ghcr.io/atvriders/tesbox:<version>` (for example `:v1.0.0`).

## 1.2.0 — 2026-10-15

Nine more engines tuned against recordings of the real cars (phase 5), so twelve of the fifteen now
are.

- New reference libraries (private, local only) for the 6.2 Small-Block V8, 6.2 Supercharged V8,
  3.0 Twin-Turbo Inline-6, 4.0 Flat-Six, 5.2 V10, 6.5 V12, 3.8 Twin-Turbo V6, 4.0 Twin-Turbo V8 and
  2.0 Turbo Inline-4: at least two cabin and two outside recordings each, stock exhausts only.
- Each tuned with the CMA-ES tuner; discrimination is now checked against all twelve engines with
  references. Nine pass every gate; three miss one gate narrowly (6.2 Small-Block V8 and 2.0 Turbo
  Inline-4: sub-orders; 6.2 Supercharged V8: order profile), with the likely causes recorded in
  [`docs/sound-scores.md`](docs/sound-scores.md).
- The 2.5 Turbo Inline-5 is re-tuned against all twelve libraries (0.597 → 0.609): the 5.2 V10's
  recordings, which fire like two inline-fives, no longer match it better than its own.
- Still estimated: the 1.3 Twin-Rotor Rotary, 2.5 Turbo Flat-Four and 4.8 V10 (references being
  gathered).

### Engines

| Engine | Inspired by | Set | Voicing |
|---|---|---|---|
| 2.5 Turbo Inline-5 | Audi RS 3 (8Y) | Euro | Tuned against recordings, 0.609; every gate passes; awaiting sign-off (beta) |
| 4.0 Flat-Six NA | Porsche 911 GT3 (992) | Euro | Tuned against recordings, 0.640; every gate passes; awaiting sign-off (beta) |
| 5.2 V10 NA | Lamborghini Huracán | Euro | Tuned against recordings, 0.683; every gate passes; awaiting sign-off (beta) |
| 2.0 Turbo Inline-4 | VW Golf GTI (Mk8) | Euro | Tuned against recordings, 0.684; 1 gate below; awaiting sign-off (beta) |
| 3.0 Twin-Turbo Inline-6 | Toyota Supra (A80, 2JZ-GTE) | JDM | Tuned against recordings, 0.663; every gate passes; awaiting sign-off (beta) |
| 1.3 Twin-Rotor Turbo Rotary | Mazda RX-7 (FD, 13B-REW) | JDM | Beta voicing (estimated); references being gathered |
| 2.5 Turbo Flat-Four | Subaru WRX STI (EJ257) | JDM | Beta voicing (estimated); references being gathered |
| 3.8 Twin-Turbo V6 | Nissan GT-R (R35, VR38DETT) | JDM | Tuned against recordings, 0.719; every gate passes; awaiting sign-off (beta) |
| 5.0 V8 NA | Ford Mustang GT (Coyote) | American | Tuned against recordings, 0.666; every gate passes; awaiting sign-off (beta) |
| 6.2 Small-Block V8 NA | Chevrolet Corvette (C8, LT2) | American | Tuned against recordings, 0.592; 1 gate below; awaiting sign-off (beta) |
| 6.2 Supercharged V8 | Dodge Challenger SRT Hellcat | American | Tuned against recordings, 0.613; 1 gate below; awaiting sign-off (beta) |
| 6.5 V12 NA | Ferrari 812 Superfast | Exotic | Tuned against recordings, 0.753; every gate passes; awaiting sign-off (beta) |
| 4.5 Flat-Plane V8 | Ferrari 458 Italia | Exotic | Tuned against recordings, 0.604; every gate passes; awaiting sign-off (beta) |
| 4.8 V10 NA | Lexus LFA | Exotic | Beta voicing (estimated); references being gathered |
| 4.0 Twin-Turbo V8 | Audi RS 6 Avant (C8) | Exotic | Tuned against recordings, 0.674; every gate passes; awaiting sign-off (beta) |

## 1.1.0 — 2026-10-15

Sound fidelity. Measuring the tuned pilot engines against recordings of the real cars found three
faults in the synthesizer; they are fixed, and the pilots are re-tuned.

- **Turbo whistle at its real level.** The whistle has its own level (`forcedInduction.whistleDb`,
  default −36 dB), apart from the turbo whoosh, and the outside sound has its own forced-induction
  level (`outsideGainDb`, default −30 dB). In 1.0.0 the whistle was 33–36 dB louder than anything
  the recordings show.
- **A brighter cabin.** The cabin filter is 2nd order with a high-frequency leak (`cabin.leakDb`,
  default −30 dB), so the engine's upper harmonics come through as they do in the recordings; in
  1.0.0 the cabin was 15–20 dB too dark at 1.5–3 kHz.
- **V8 bank rumble.** The tuner sets each cylinder bank's headers and each collector separately, so
  the half orders that lead real cross-plane and flat-plane V8 recordings no longer cancel.
- These defaults apply to every engine, so all 15 sound different from 1.0.0.
- The pilots, re-tuned over the new parameters: 2.5 Turbo Inline-5 0.478 → 0.597, 5.0 V8 NA
  0.546 → 0.666, 4.5 Flat-Plane V8 0.483 → 0.604 (similarity to the recordings); every gate and the
  discrimination check now pass ([`docs/sound-scores.md`](docs/sound-scores.md)). They stay
  "Beta voicing" until the listening sign-off.
- CI: the tuner's heavy tests size their worker threads to the runner.

## 1.0.0 — 2026-10-15

The first release: a self-hosted web app for the Tesla touchscreen browser that synthesizes a
combustion-engine sound in real time from GPS speed, a real gearbox model and your own Tesla's
performance. Not affiliated with or endorsed by Tesla, Inc. or any car manufacturer; the engine
sounds are synthesized impressions, not recordings of the named cars.

### Phase 0 — in-car probe and pipeline

- `/probe/`: an in-car test page that measures the car's browser before the app depends on it —
  AudioWorklet and three output routes, Media Session / key / steering-wheel / gamepad logging,
  headroom benchmark, interruption recovery, GPS matrix (poll / watch × high accuracy), DeviceMotion,
  storage and service-worker persistence; results exported as paged QR codes (statistics only,
  never coordinates).
- Non-root nginx image with a strict Content-Security-Policy and cache rules; CI runs lint,
  typecheck, unit tests, build and Playwright against the container, then publishes a multi-arch
  image (amd64 + arm64) to GHCR. Every action is pinned to a commit SHA.

### Phase 1 — vehicle simulation and data

- SimCore: a 3-state Kalman speed filter over raw GPS fixes (also for cars that report no usable
  speed), load estimation from the selected Tesla's EPA road load, a gearbox with load-dependent
  shift maps, kickdown and paddle override, clutch launch and torque converter, Demo and Keyboard
  pedal physics.
- Data: 15 primary-sourced engine specs with EPA N/V cross-checks, and a 73-record Tesla catalogue
  (Model S, X, 3, Y, Y L, Cybertruck since 2012) with per-field sources.

### Phase 2a — engine synthesizer (DspCore)

- A physically informed synthesizer that runs on the audio thread: per-cylinder combustion pulses
  over the real firing order, a passive waveguide exhaust network (headers, collectors, turbine,
  mufflers, valve bypass), intake, mechanical, turbo / supercharger and overrun layers, rev limiter
  and shift trajectories, cabin / outside perspective.
- Output stage: bass management for cars with and without a subwoofer, compressor and a 4×
  oversampled true-peak limiter (≤ −1 dBTP everywhere).
- `npm run render` (segments to WAV), allocation and realtime-factor checks in CI.

### Phase 2b — Sound Lab tooling

- `npm run score` compares rendered segments with reference recordings of the inspiring cars
  (order profiles, spectral tilt, sub-orders, forced-induction lines, overrun) and writes plots;
  `npm run tune` searches an engine's voicing against them (CMA-ES on parallel worker threads, or
  Nelder–Mead). Reference audio stays local and is never
  committed or shipped ([`docs/SOUND_LAB.md`](docs/SOUND_LAB.md)).
- A voicing stays an estimate ("Beta voicing" in the garage) until the user signs it off by ear.

### Phase 2c — Sound Lab UI

- `/lab/` (desktop): any engine live on its own audio worklet — rpm / load / gear, shift, lift-off,
  limiter and ignition events, the fixed test segments — with a slider for every voicing parameter,
  A/B against a local recording (decoded in the browser, never uploaded), level matching, meters and
  JSON export / import of a voicing. Not part of the in-car bundle or its offline cache.

### Phase 3 — the app

- First run: notices, Tesla picker (model, generation, trim, MCU2 retrofit, subwoofer), a parked-only
  bass sweep, acceleration mode, "Not listed" for other cars.
- Garage of 15 engines in four sets with a live preview; Drive with a canvas tach, gear, speed, load,
  shift paddles, Auto|Manual, Comfort|Sport, exhaust valves and a status dot; Settings (parked only);
  Diagnostics with a statistics-only QR export.
- Audio lifecycle: start from a tap, three output routes, quality tier chosen at start, recovery
  from interruptions (Tap to resume), steering-wheel tilt shifting through the Media Session.

### Phase 4 — offline, updates, release

- App service worker: after the first visit the app relaunches without a connection (precached build;
  network-first page with a 3 s timeout and the cached page as fallback; cache-first hashed assets;
  `version.json` always from the network). A new version waits until you apply it.
- Session preload: a running engine needs no network — the anchor audio plays from memory (`blob:`),
  engines and the Tesla catalogue are in the main bundle, the worklet is loaded once at Start.
- "Update available — tap to reload": a newer service worker or a newer deployed build (checked at
  start and every 30 minutes) is offered only while the engine is off and the car is parked; the tap
  reloads into the new build (with `?b=<sha>` past the browser's HTML cache).
- Garage cards show each engine's voicing status; Diagnostics shows the service-worker state.
- End-to-end tests for an offline relaunch, a session that loses its connection, a browser without
  service workers and the update banner; CI publishes release tags as image tags.

### Engines

| Engine | Inspired by | Set | Voicing |
|---|---|---|---|
| 2.5 Turbo Inline-5 | Audi RS 3 (8Y) | Euro | Tuned against recordings, awaiting sign-off (beta) |
| 4.0 Flat-Six NA | Porsche 911 GT3 (992) | Euro | Beta voicing (estimated) |
| 5.2 V10 NA | Lamborghini Huracán | Euro | Beta voicing (estimated) |
| 2.0 Turbo Inline-4 | VW Golf GTI (Mk8) | Euro | Beta voicing (estimated) |
| 3.0 Twin-Turbo Inline-6 | Toyota Supra (A80, 2JZ-GTE) | JDM | Beta voicing (estimated) |
| 1.3 Twin-Rotor Turbo Rotary | Mazda RX-7 (FD, 13B-REW) | JDM | Beta voicing (estimated) |
| 2.5 Turbo Flat-Four | Subaru WRX STI (EJ257) | JDM | Beta voicing (estimated) |
| 3.8 Twin-Turbo V6 | Nissan GT-R (R35, VR38DETT) | JDM | Beta voicing (estimated) |
| 5.0 V8 NA | Ford Mustang GT (Coyote) | American | Tuned against recordings, awaiting sign-off (beta) |
| 6.2 Small-Block V8 NA | Chevrolet Corvette (C8, LT2) | American | Beta voicing (estimated) |
| 6.2 Supercharged V8 | Dodge Challenger SRT Hellcat | American | Beta voicing (estimated) |
| 6.5 V12 NA | Ferrari 812 Superfast | Exotic | Beta voicing (estimated) |
| 4.5 Flat-Plane V8 | Ferrari 458 Italia | Exotic | Tuned against recordings, awaiting sign-off (beta) |
| 4.8 V10 NA | Lexus LFA | Exotic | Beta voicing (estimated) |
| 4.0 Twin-Turbo V8 | Audi RS 6 Avant (C8) | Exotic | Beta voicing (estimated) |

*Beta voicing (estimated)*: the default voicing derived from the engine's spec, not yet tuned
against reference recordings nor signed off by ear. The tuned engines' scores are in
[`docs/sound-scores.md`](docs/sound-scores.md). *Tuned*: tuned against reference recordings,
awaiting the listening sign-off. *Signed off*: approved by ear (the garage then shows no badge).
