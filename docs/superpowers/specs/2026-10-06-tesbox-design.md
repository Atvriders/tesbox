# Tesbox — Design Spec

- **Date:** 2026-10-06 (rev 2, after 4-lens adversarial review: consistency, research fidelity,
  DSP/vehicle engineering, scope/testability)
- **Status:** Approved design (conversation); written spec pending user review
- **Repo:** `~/tesbox` → `github.com/Atvriders/tesbox` (public)
- **Research basis:** `docs/research/2026-10-05-platform-research.json` — 5 topics, each
  adversarially fact-checked; every claim carries sources and a verdict. Tags below:
  [confirmed] / [medium] / [low] / [in-car] = must be verified by the Phase 0 probe.

---

## 1. What Tesbox is

Tesbox is a web app that runs in a Tesla's built-in touchscreen browser while driving and plays a
real-time, physically-informed synthesized combustion-engine sound through the car's speakers. It
reads vehicle speed from GPS, maps it through a chosen combustion car's real gearbox to engine RPM,
estimates engine load from acceleration and the user's own Tesla's performance, and synthesizes the
engine live. Free, no accounts, self-hosted.

### 1.1 Goals

1. **Sound quality first.** Each engine recognisable by its real character (firing order, exhaust,
   induction) and responding believably to RPM, load, shifts, lift-off and the limiter.
2. **Correct for *your* Tesla.** Model / generation / trim picker calibrates load estimation and
   bass handling, so a Model 3 RWD and a Plaid both sound right.
3. **Robust in the car.** No audio dropouts from GPS gaps, UI stalls or tunnels; clean recovery from
   audio interruptions; a started session survives connectivity loss; offline relaunch where the
   car's browser supports Service Workers (§12, Phase 0 Q5).
4. **Safe.** Cabin-only audio, bounded true-peak level, speaker protection, glance-only driving UI.
5. **Free public app, self-hosted.** Static app in a public Docker image; anyone can run it.

### 1.2 Non-goals (YAGNI)

- Payments, licences, paywalls, paid add-ons; marketing/landing page; community voting; accounts.
- Analytics/telemetry (nothing leaves the car).
- i18n — English only (strings centralised in one module).
- Exterior/pedestrian speaker output (impossible from the browser; legally fraught).
- Tesla Fleet API vehicle data (10 s pedal cadence, cost, backend).
- Recorded-sample or pre-rendered-bank sound engines; convolution IRs.
- ScriptProcessor fallback (0 AudioWorklet fallbacks in 151 Tesla starts per research; a
  main-thread DSP would glitch in exactly the freeze conditions we target).
- GitHub Pages hosting (user chose Docker self-hosting only).

### 1.3 Success criteria (measurable)

- **(a) Responsiveness.** In Replay tests driven by the probe-measured GPS model (cadence, lag,
  null-speed rate, stale-fix distribution): p95 time from a true-speed step to 63 % of the RPM
  response ≤ measured fix lag + one fix interval + 0.2 s on the `coords.speed` path, and ≤ fix
  lag + two fix intervals on the no-speed (position-only) path (1 Hz position-only tracking cannot
  physically do better; measured 2.75 s at 1 Hz / 1 s lag).
- **(b) Stability.** 30-minute in-car drive with Diagnostics counters at 0 for non-finite resets,
  audio-overload events and AudioContext state changes not initiated by the user (read via the
  Diagnostics QR).
- **(c) Level safety.** DSP tests: 4×-oversampled true peak ≤ −1 dBTP across the parameter fuzz
  run and every render segment at maximum volume trim.
- **(d) Sound.** Each engine passes its scoring gates (§11.3) where reference clips exist, plus a
  user listening sign-off line (engine, date, build SHA) in `docs/sound-scores.md`.
- **(e) Verification.** typecheck + unit + DSP invariant tests + build + Playwright e2e (against
  the nginx container in CI) all green.

---

## 2. Clean-room policy (binding)

Tesbox is an original implementation of a publicly-known product *concept* (GPS-driven engine
sound in the Tesla browser). rupteur.app is all-rights-reserved and explicitly forbids code/data
reuse, AI rewriting and text-and-data mining.

- Nothing from rupteur.app (code, engine definitions, calibration data, audio, copy, branding, UI
  assets) may be fetched, read, or used. The one-time download made during discovery was deleted
  unread.
- Do not open or read `github.com/UnendlessGit/juniper-sound-lab` or any repo/app that references
  rupteur.app or appears derived from it.
- Algorithms are implemented from **papers and first principles** (Baldan et al. 2015; Farnell,
  *Designing Sound*; Doerfler & Wyse 2026 PTR; Larsen & Aarts 2002 virtual bass; standard vehicle
  dynamics). Each algorithm's source is logged in `docs/CLEAN_ROOM.md`.
- No code is copied from GPL (e.g. SDT `SDTMotor.h` — not even read), non-commercial (PTR
  code/dataset, PolyForm-NC projects such as sedicivalvole), or unlicensed (Farnell Pd patches)
  sources. MIT code may be adapted with attribution in `NOTICES` (none planned).
- Engine and Tesla physical data are compiled per vehicle from primary/public documents with
  per-field-group `sources`; no third-party specs database is bulk-extracted.

---

## 3. Platform facts that shape the design

| Fact | Design consequence |
|---|---|
| Chromium build (140 since 2026.14; reportedly 148 since 2026.26) with some APIs compiled out (WebCodecs/WebRTC reported missing) [confirmed / feature set: in-car] | Feature-detect; AudioWorklet missing → Unsupported screen with the error. |
| AudioWorklet works in-car (0 fallbacks in 151 starts; output latency avg ≈ 99 ms, max 435 ms) [confirmed] | AudioWorklet is the only audio path. |
| Browser audio plays while driving; only `<video>` picture is suppressed [confirmed] | Normal Web Audio playback while moving. |
| Browser audio is its own media source; user's media resumes when it stops — "replaces, doesn't mix" is inferred [medium; in-car] | Onboarding: "Tesbox replaces your music while it runs." Probe confirms. |
| When minimised, the car may stop browser audio unless the page is a controllable media session in the Miniplayer; a looping >5 s file `<audio>` is the only Tesla-specific workaround on record [medium; in-car] | Three output routes tested in Phase 0 (§6.4); Media Session always registered. |
| **Geolocation updates stop while the page is hidden** (W3C spec); hidden-page timers are throttled [confirmed] | When minimised (map full-screen, reverse camera), Tesbox can only idle. First-run notice: "Keep Tesbox on screen — it idles when minimised." |
| Autoplay gated on sticky activation; contexts can enter `interrupted`, where `resume()` fails even from a tap [confirmed] | Start tap; recovery recreates the AudioContext inside the tap (§6.3). |
| Geolocation ≈ 1 Hz, ≈ 1 s lag; AMD (MCU3) fills `coords.speed`; **Intel (MCU2) reports `coords.speed` as 0 or null while moving** and drops fixes; `maximumAge` ignored (fixes up to 91 s stale) [medium–high] | Single 3-state filter with optional position and speed measurements, `speed == 0` treated as unconfirmed, stale/duplicate fix rejection (§8). |
| `watchPosition` crash reports are confounded with `enableHighAccuracy: true` + heavy WebGL [low] | Default: `getCurrentPosition` polling with `enableHighAccuracy: false`; both knobs in Advanced and in the probe matrix. |
| UA doesn't identify model/MCU; "Tesla" marker reportedly removed in 2026.26 [medium] | User picks the model; MCU detected via WebGL renderer string. |
| 2026.26 zoom: dpr ≈ 1.53 (15.4"), ≈ 1.96 (16"); 773×601 CSS split-view/in-motion layout; parked ≈ 1255×758; S/X disputed (≈1.56 vs 1.0); pre-2026.26 dpr 1.0 [medium; layout state; in-car] | Design target 773×601; read `devicePixelRatio` at runtime; handle resize; e2e at several sizes (§14). Media queries `pointer/hover/prefers-color-scheme` unreliable → dark theme forced, touch assumed. |
| Steering-wheel scroll: no documented page path. Tilt = next/prev track; press = play/pause (3 Highland) or **mute** (Y, S/X); both-press opens P/R/N/D. Media Session actions grant user activation in Chromium (all but pause/stop since Sept 2026) [confirmed source-level; in-car untested] | Touch paddles guaranteed; wheel *tilt* opt-in after in-car test; press never mapped. |
| Gamepad API works with Bluetooth Classic controllers; may appear as "TESLA VIRTUAL GAMEPAD" [confirmed] | Optional gamepad. |
| 100–300 ms *network* stalls with healthy main thread; multi-second main-thread freezes seen in one heavy WebRTC app [medium] | Whole simulation runs on the audio thread (§4.2); session assets preloaded into memory. |
| Tesla browser caches HTML indefinitely [medium] | `no-store` HTML; build SHA shown; `version.json` stale check; `?b=<sha>` cache-buster links. |
| No LAN/private IP access; geolocation + AudioWorklet need a secure context [confirmed] | Must be served from the user's public HTTPS domain. |
| Car applies speed-dependent media volume [confirmed] | No speed-based loudness in Tesbox. |
| Subwoofer presence varies by model, trim, market *and build date*; door-woofer low limit ≈ 45–50 Hz is a guess [confirmed / low] | Picker default + "yes / no / not sure" + bass sweep that sets the high-pass corner (§5.6). |
| Intel MCU2: weak GPU, memory pressure; AMD steady 60 fps [medium] | Intel: tach ≤ 30 fps, 1× canvas backing store. |
| MCU1 (pre-2018 S/X, unretrofitted): old WebKit QtCarBrowser [confirmed] | Static "Unsupported" markup that doesn't need ES modules (§10.2). |
| Browser data needs Wi-Fi/hotspot or Premium Connectivity on cellular [confirmed] | README + first-run note. |

---

## 4. Architecture

### 4.1 Stack

- **TypeScript** (strict), **Vite** (`build.assetsInlineLimit: 0` for CSP), **Preact +
  @preact/signals**, **canvas 2D** tachometer.
- **Vitest** (unit, vehicle, DSP invariants), **Playwright** (e2e, Chromium only).
- **Node CLIs** (`tsx`): `tesbox-render`, `tesbox-score`, `gpx-to-replay`, catalogue/data tools.
- **nginx:alpine** static image on **GHCR**, built by GitHub Actions.
- Runtime dependencies: Preact and signals only. The QR encoder is written in-house
  (`src/platform/qr.ts`, byte mode, ECC L). No CDN, no third-party scripts.

### 4.2 Threads: the simulation lives on the audio thread

```
┌─ UI / main thread ─────────────────────────────────────────────────────────┐
│ Screens (Preact) · canvas tach (rAF, display only)                         │
│ GPS poller (getCurrentPosition chain)  ──fix msgs (~1 Hz)──┐               │
│ Input: touch paddles · Media Session · gamepad · keyboard ─┤ input msgs     │
│ Settings / engine / Tesla config ──────────────────────────┤ config msgs    │
│                         ◄── state snapshots (30 Hz) ───────┼──┐            │
└────────────────────────────────────────────────────────────┼──┼────────────┘
┌─ Audio thread: AudioWorkletProcessor "tesbox" ─────────────▼──┴────────────┐
│ SimCore (environment-free TS):                                             │
│   SpeedFilter (3-state Kalman, prediction, standstill, dropout)            │
│   LoadEstimator → Drivetrain (gearbox, slip, launch, TC, shift trajectory) │
│   Demo/keyboard physics                                                    │
│ DspCore (environment-free TS): crank clock → pulses → exhaust network +    │
│   layers → events → perspective mix → output stage (true-peak limiter last)│
└────────────────────────────────────────────────────────────────────────────┘
```

- The main thread only forwards **raw GPS fixes**, **input events** and **config**. All filtering,
  prediction, gearbox logic and synthesis run in the worklet, stepped per 128-frame quantum in the
  worklet's own `currentTime` clock. A frozen or throttled main thread therefore cannot cause clicks,
  RPM wobble or a drop to idle; it only delays new fixes/inputs.
- The worklet posts a **state snapshot** (`Float64Array`: rpm, gear, speed, load, flags, counters)
  ~30 Hz for display. (A few small allocations per second on the audio thread; accepted.)
- AudioWorkletNode: `{ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }`;
  `process()` re-reads `outputs[0][0..1]` every call and always returns `true`.

### 4.3 Clock rules

- Worklet time (`currentTime`, seconds) is the only simulation clock.
- A GPS fix is posted as `{ ageS, … }` where `ageS = (Date.now() − position.timestamp)/1000 +
  gpsLatencyS` (`gpsLatencyS` default 1.0, set from Phase 0 measurements). The worklet stamps it
  `tFix = currentTime − ageS` on receipt. Epoch and `performance.now()` times never cross the port.
- Input events apply at the next quantum after receipt. Prediction targets `currentTime +
  outputLatencyS` (reported by the main thread from `AudioContext.outputLatency`, default 0.1).
- Fix-arrival gaps (dropout timer) are measured in worklet time since the last *accepted fix
  arrived*.

### 4.4 Environment-free cores, capacity-sized at construction

`src/sim/` (SimCore) and `src/dsp/` (DspCore) are plain TypeScript with no DOM/Web Audio
dependencies. **All buffers are allocated once at construction for worst-case capacity** (16
combustion entries, max delay lengths at the highest speed of sound and 48 kHz, all layers), so
`configure()` (engine change, tier change, settings) and `render()` never allocate. Engine or tier
changes happen behind a 300 ms fade to silence. They run in:

1. the AudioWorkletProcessor (production);
2. Node (Vitest, `tesbox-render`, `tesbox-score`, allocation check).

All delays are specified in metres/seconds and converted with the actual `sampleRate` (no
hard-coded sample counts). If in-car headroom proves insufficient even on Lite, the hot loop moves
to WASM behind the same interface (not built speculatively).

### 4.5 Contracts (first deliverable of Phase 1: `src/contracts.ts`)

Exact TypeScript types, mirrored by JSON Schemas where data is stored:

- `FixMsg { ageS, speedMps: number|null, lat, lon, accuracyM, altitudeM: number|null }`
- `InputMsg` union: `shiftUp | shiftDown | pedal{throttle, brake} | valve{auto|open|closed} |
  perspective{cabin|outside} | gearboxMode{auto|manual} | driveMode{comfort|sport} | volume{trimDb}`
- `ConfigMsg` union: `engine{EngineDef} | tesla{TeslaParams} | output{OutputConfig} |
  source{gps|demo|keyboard|replay} | tier{full|lite}`
- `OutputConfig { subwoofer: yes|no|unsure, hpCornerHz, tier, volumeTrimDb }`
- `StateSnapshot` layout (indices of the Float64Array) and flag bits:
  `gpsLost, standstill, predicting, limiter, shifting, overrun, speedUnusable, overload`
- `EngineDef` (`spec` + `voicing`, §5.2), `TeslaRecord` (§9.2), `TeslaParams` (resolved numbers)
- `SimCore` and `DspCore` class interfaces.

Phase 3 UI work develops against a stub worklet (sine at the firing frequency) implementing the same
contracts.

### 4.6 Repository layout

```
tesbox/
  src/
    contracts.ts
    sim/            # speed filter, load estimator, drivetrain, demo physics (environment-free)
    dsp/            # synthesis core + output stage (environment-free)
    audio/          # AudioContext lifecycle, worklet entry, output routes, media session
    input/          # touch paddles, media-session shifting, gamepad, keyboard
    ui/             # Preact screens, tach canvas
    data/engines/*.json  data/teslas.json  data/schema/
    platform/       # feature detection, MCU detection, viewport/dpr, storage, qr
    sw/             # service worker
    lab/            # Sound Lab UI (route /lab)
  probe/            # Phase 0 in-car probe page
  tools/            # tesbox-render, tesbox-score, gpx-to-replay, check-alloc, data tools
  tests/            # vitest; fixtures/replay/*.json; e2e/ (Playwright)
  lab-refs/         # (gitignored) reference clips + sidecars
  docs/             # specs, plans, research, CLEAN_ROOM.md, IN_CAR_CHECKLIST.md, sound-scores.md
  Dockerfile  nginx.conf  docker-compose.yml  NOTICES  LICENSE (MIT)  README.md
```

---

## 5. Sound engine (DspCore)

Physically-informed synthesis after Baldan et al. 2015, with PTR-style pulse shaping and regime
gating (Doerfler & Wyse 2026) and Farnell's engine chapter — implemented from the papers.

### 5.1 Cycle and firing model

- `cycleDeg`: 720 for 4-stroke; **1080 for rotary** (eccentric-shaft degrees — each rotor face fires
  once per 1080°).
- `combustion[]`: one entry per cylinder (4-stroke) or per **rotor face** (rotary: rotor offset +
  k·360°, k = 0..2; a twin-rotor 13B has 6 entries at 0/360/720 and 180/540/900). Per-face small
  amplitude/timing variation yields the rotary's 1/3-order texture.
- **Firing fundamental** (used everywhere): `f_fire = (rpm/60) × combustion.length × 360 / cycleDeg`
  (I4: 2 per rev; V8: 4; 13B: 2). Order analysis base: crank (e-shaft) frequency `rpm/60`; cycle
  sub-orders at `360/cycleDeg` (½ for 4-stroke, ⅓ for rotary).
- Crank clock: double-precision phase accumulator over `cycleDeg`, driven by the DSP's RPM state
  (§5.3.7 limiter and shift trajectories own that state; otherwise it tracks SimCore's RPM through a
  one-pole of ≈30–60 ms).

### 5.2 Engine definition (`src/data/engines/*.json`)

Split into a sourced **`spec`** (physical facts) and an estimated **`voicing`** (produced by our
Sound Lab work). The data test requires a `sources` entry for every `spec` field group.

```jsonc
{
  "id": "i5-turbo-25",
  "name": "2.5 Turbo Inline-5",
  "inspiredBy": "Audi RS 3",                 // subtitle only (§11.5)
  "set": "euro",                              // euro | jdm | american | exotic
  "notes": "variant choices, data caveats",
  "spec": {
    "layout": { "type": "inline", "bankAngleDeg": 0, "crank": "n/a", "displacementL": 2.48 },
    "cycleDeg": 720,
    "combustion": [ { "angleDeg": 0, "bank": 0 }, { "angleDeg": 144, "bank": 0 } /* … */ ],
    "rpm": { "idle": 850, "redline": 7000,
             "limiter": { "type": "ignition-soft", "rpm": 7100, "hysteresisRpm": 150 } },
    "aspiration": { "type": "turbo",           // na | turbo | supercharger
                    "turbo": { "count": 1, "layout": "single" },   // single | parallel | sequential
                    "supercharger": null },    // { kind: roots|twin-screw, pulleyRatio, gearRatio, lobes }
    "gearbox": {
      "type": "dct",                           // dct | pdk | tc-auto | manual | amt
      "overallRatios": [ /* gear × applicable final drive, gear 1 first */ ],
      "drivenTyre": "265/30R19",               // driven axle (front for transverse/Haldex AWD)
      "shiftTimeS": 0.10,                      // authoritative; §8.6 type values are defaults/ranges
      "tc": null                               // tc-auto: { stallRpmWot, lockupTurbineRpm, couplingSR }
    },
    "sources": { "layout": ["…"], "combustion": ["…"], "rpm": ["…"], "aspiration": ["…"], "gearbox": ["…"] }
  },
  "voicing": {
    "pulse": { "widthDeg": 60, "alpha": 9, "beta": 4, "evoOffsetDeg": 140, "cycleAsymmetry": 0.15 },
    "headersM": [0.62, 0.58 /* per combustion entry or per bank */],
    "collectors": [ { "banks": [0], "lengthM": 0.35 } ],
    "turbine": { "reflection": 0.45, "lpHz": 1500 },           // turbo engines only
    "exhaust": { "midPipeM": 1.4, "mufflerSectionsM": [0.21, 0.34, 0.47], "mufflerAction": 0.6,
                 "tailpipeM": 0.5, "valve": { "fitted": true, "openGainDb": 4 } },
    "intake": { "runnerM": 0.3, "helmholtzHz": 140, "gain": 0.4 },
    "forcedInduction": { "spoolTimeS": 0.6, "maxShaftKrpm": 180, "lift": "bov", "cabinGainDb": -14 },
    "mechanical": { "blockGain": 0.3, "valvetrainGain": 0.1 },
    "overrun": { "crackleRate": 0.6, "fuelCutResumeRpm": 1350 },
    "cabin": { "lowpassHz": 600 },
    "estimated": true
  }
}
```

(Values illustrative.) Valid-range checks live in the JSON Schema.

### 5.3 Signal chain

1. **Combustion events.** Each entry fires at its `angleDeg` with per-cycle humanisation (timing
   jitter ≈ ±1° crank, amplitude jitter ≈ ±5 %, seeded PRNG) and `cycleAsymmetry` growl. Ignition
   and block impulses are at the firing angle; the **exhaust blowdown** launches `evoOffsetDeg`
   (default 140°) later; intake windows span `angle + 360 + [−10, 230]°` (4-stroke; rotary uses
   port windows scaled to its cycle).
2. **Pulse shape.** φ ∈ [0, 1] normalised over `widthDeg` (rotary allows up to 300°):
   `E(φ) = (1 − e^(−αφ))² · e^(−βφ) · taper(φ)`, where `taper` is a cos² fade over the last 25 %
   (E(1) = 0, zero slope; C¹ onset). Amplitude `0.15 + 0.85·g`, `g = max(load, 0)^0.7`; sharpness
   (α) rises with load but is clamped so time-to-peak ≥ 4 samples at the current RPM. Pulse mass is
   made DC-free at the source (running-mean subtraction) and the outlet tap radiates as a
   differentiator (first-order HP ≈ 20 Hz), so no DC circulates in resonant loops.
3. **Regime gating (combustion vs overrun).** Fuel-cut overrun only when *all* hold:
   `load < −0.05`, `rpm > fuelCutResumeRpm` (default idle + 500), driveline engaged (not
   clutch-open, not TC stall, not manual "clutch disengaged"). Otherwise combustion is floored at
   idle amplitude. Combustion↔overrun crossfade is a smoothstep over load ∈ [−0.08, +0.02] with gain
   slew ≥ 80 ms. In overrun, airflow noise scales mainly with RPM.
4. **Exhaust network (passive by construction).** Per-combustion header delays → per-bank
   collectors → **turbine element** (turbo engines: partial reflection 0.3–0.6, 1–2-pole LP ≈ 1–2 kHz,
   attenuation rising with shaft speed) → mid-pipe → 3–4 parallel muffler sections → tailpipe/outlet.
   Rules: every junction is an impedance-based N-port scattering junction (not an ad-hoc sum);
   every in-loop filter has |H(e^jω)| ≤ 1 (unity-DC one-poles; linear or 3rd-order Lagrange
   fractional delay); **no gain > 1 inside any loop** (valve open gain, mufflerAction, injection
   gains apply only at the outlet tap); time-varying reflections are slew-limited; each delay ≥
   interpolator order + 1 samples at maximum speed of sound (asserted at configure).
5. **Gas temperature per section.** Speed of sound from c = √(γRT): headers up to ≈ 700 m/s at WOT,
   collector/post-turbine ≈ 500–600, muffler/tailpipe ≈ 430–490; all start at 343 m/s cold.
   Load-driven temperature slews with τ = 2–5 s (no audible "wah"); warm-up over minutes.
   `engineWarmAt` is persisted so a reload mid-drive starts warm (warm if < 30 min old or speed > 0).
6. **Layers.** Intake roar (noise gated by intake windows, scaled by throttle, through a band-pass at
   `helmholtzHz`; silent off-throttle). Mechanical: block vibration (low-passed piston motion +
   ignition) and valvetrain tick (filtered noise bursts at valve events).
7. **Rev limiter (owned by the DSP).** SimCore clamps its target at `limiter.rpm` and sets the
   `limiter` flag. While set, the DSP runs a local RPM state: on cut, RPM falls at a per-engine rate
   (≈ hysteresis over 30–80 ms); on re-fire it rises back — producing the 8–20 Hz bounce (hard cut)
   or a buzz with a cylinder subset (soft cut). Ignition-cut types emit pops; fuel-cut types don't.
8. **Forced induction (separate bus — bypasses the cabin LP).**
   - *Turbo:* shaft-speed state lags `f(load, rpm)` by `spoolTimeS`; whistle = 1–2 sines at shaft
     order (1–4 kHz) + whoosh noise (4–12 kHz) ∝ boost²; on lift above a boost threshold: BOV burst
     (band-passed, 0.3–0.8 s decay) or compressor flutter (whoosh AM 8–20 Hz). Parallel/sequential
     layouts supported.
   - *Supercharger:* whine order = `pulleyRatio × gearRatio × (roots ? 2 × lobesPerRotor :
     maleLobes)`; whine Hz = `rpm/60 × order`; level ∝ boost; no lag.
9. **Events.** Overrun pops: Poisson process while in overrun and RPM falling; rate =
   `crackleRate × (valveOpen ? kOpen : 1) × modeFactor`, decaying over the overrun; each pop is a
   bounded impulse injected at the collector/outlet so it rings with the exhaust's own resonances.
   Shifts: see §8.6 (shift trajectory with cut/dip).
10. **Exhaust valves.** Closed: higher muffler reflection + extra ≈ 2 kHz shelf cut. Open: bypass
    path, lower reflection, brighter, `openGainDb` at the outlet tap. 150–300 ms slew-limited
    crossfade. Auto: opens above a mode threshold (e.g. Comfort 3,500 rpm & load > 0.4; Sport always
    open).
11. **Perspective (no IR).**
    - *Cabin (default):* exhaust + intake through a 4th-order LP at `cabin.lowpassHz` (≈ 400–800);
      block layer weighted below ≈ 250 Hz; forced-induction bus through its own 2nd-order LP ≈ 2.5–3
      kHz at `cabinGainDb` (−10 to −20 dB) so whine/whistle stay audible. No reverb.
    - *Outside:* outlet-dominant, full bandwidth, plus intake, reduced block.
12. **Output stage (always last, every route).** Volume trim (linearly interpolated per quantum) →
    NaN guard (`!(x === x) || |x| > 1e6` → 0 and flag) → DC blocker → bass management (§5.6) →
    soft-knee compressor → 4×-oversampled true-peak look-ahead limiter at −1 dBTP → NaN-safe hard
    clip. Once per quantum the sum of all recursive states is checked; non-finite → full core reset
    (including compressor/limiter envelopes and look-ahead buffer) with a 50 ms fade-in; counted in
    Diagnostics. No gain stage exists after the limiter.

### 5.4 Numerics

Filter/waveguide state in `Float64Array` or locals; every recursive update flushes |y| < 1e-20 to 0
(no FTZ in JS; Intel Atom subnormal stalls). Delay lines may be `Float32Array`. Zero allocations in
`render`/`process` (lint rule + GC check, §14).

### 5.5 The starter garage (15 engines)

| Set | Title (generic) | Inspired by | Character to nail |
|---|---|---|---|
| Euro | 2.5 Turbo Inline-5 | Audi RS 3 (8Y) | 1-2-4-5-3 half-order warble, turbo, DCT pops |
| Euro | 4.0 Flat-Six NA | Porsche 911 GT3 (992) | 9,000 rpm even-fire flat-6 howl, PDK |
| Euro | 5.2 V10 NA | Lamborghini Huracán | V10 scream; firing intervals (even vs 54/90 odd-fire) confirmed from a primary source in Phase 1 |
| Euro | 2.0 Turbo Inline-4 | VW Golf GTI (Mk8) | 1-3-4-2 hot hatch, DSG upshift "fart" |
| JDM | 3.0 Twin-Turbo Inline-6 | Toyota Supra (A80, 2JZ-GTE) | smooth I6, sequential turbos, BOV |
| JDM | 1.3 Twin-Rotor Turbo Rotary | Mazda RX-7 (FD, 13B-REW) | rotary "brap", long port pulses, ⅓-orders |
| JDM | 2.5 Turbo Flat-Four | Subaru WRX STI (EJ257) | unequal-length-header boxer rumble |
| JDM | 3.8 Twin-Turbo V6 | Nissan GT-R (R35, VR38DETT) | V6 TT, DCT, turbo whoosh |
| American | 5.0 V8 NA | Ford Mustang GT (Coyote) | cross-plane burble, high-rev DOHC |
| American | 6.2 Small-Block V8 NA | Chevrolet Corvette (C8, LT2) | pushrod cross-plane lope |
| American | 6.2 Supercharged V8 | Dodge Challenger SRT Hellcat | supercharger whine, TC auto |
| Exotic | 6.5 V12 NA | Ferrari 812 Superfast | V12 shriek to ≈ 8,900 rpm |
| Exotic | 4.5 Flat-Plane V8 | Ferrari 458 Italia | flat-plane scream, 9,000 rpm |
| Exotic | 4.8 V10 NA | Lexus LFA | 72° even-fire V10, 9,000 rpm, AMT; ratios currently only from a secondary aggregator → must be primary-sourced or replaced by a pre-agreed fallback that doesn't duplicate the Huracán's character |
| Exotic | 4.0 Twin-Turbo V8 | Audi RS 6 Avant (C8) | hot-V biturbo cross-plane rumble, 8AT |

Exact variants are fixed in Phase 1 by which has primary-sourced gearbox data; choices and caveats
go in `notes`.

### 5.6 Bass management

- Firing fundamentals at idle span ≈ 25 Hz (I4/boxer-4) to ≈ 100 Hz (V10/V12).
- **No subwoofer / not sure:** 4th-order high-pass at `hpCornerHz` (default **40 Hz**, range 30–60;
  the 50 Hz door-woofer floor is unverified). The corner is set per car by the parked bass sweep
  (§9.3). **Virtual bass** (Larsen & Aarts 2002 NLD method): 4th-order LP at the corner on the
  removed band → Chebyshev T2+T3 shaper → band-pass corner…4×corner → scaled by the removed band's
  envelope → summed with the high-passed signal (phase-coherent with the source, tracks the corner
  automatically). Equal-loudness compensation keys off the in-app volume trim only (the car's knob is
  invisible). Optional slight mid emphasis (reviews call 7-speaker cars bass-heavy).
- **Subwoofer:** infrasonic high-pass at 20–25 Hz only.

### 5.7 Quality tiers

- **Full:** everything above. **Lite:** 2 muffler sections, header delays shared per bank (layers are
  tier-independent for now; fewer noise bands only if in-car headroom requires it); tach canvas at 1× backing store and ≤ 30 fps (the canvas rules follow the detected
  MCU regardless of tier).
- Tier is chosen **once at Start**: Intel MCU → Lite; otherwise run the headroom benchmark during
  the key-on/crank sequence (DSP rendered k = 1, 2, 4, 8 times per quantum; overload detected on the
  main thread as `getOutputTimestamp().contextTime` advancing slower than `performance.now()`;
  headroom = largest k with no drift; Full requires k ≥ 4). Sustained overload mid-drive sets a
  persisted "Lite next Start" flag and a status-dot warning — no live switching. User can force a
  tier in Settings (applied behind a fade).
- In-worklet timing (`performance.now`) is used only if it exists (feature-detected; Chromium has
  historically not exposed it). Otherwise Diagnostics shows windowed mean load from `Date.now()`
  busy-ms over ≥ 1 s windows (no p99).

---

## 6. Audio session lifecycle

### 6.1 Start

The **Start engine** button (`click`, an activation-triggering event) creates
`AudioContext({ latencyHint })` — `'balanced'` by default; Intel uses the value chosen by the Phase 0
A/B (`'balanced'` vs `'playback'`) — adds the worklet module, preloads every session asset into
memory (§12), configures SimCore/DspCore, runs the headroom benchmark during a key-on → crank → idle
sequence, and registers the Media Session.

### 6.2 Media Session

Once audible: `metadata` (title = engine name, artist = "Tesbox"), `playbackState = 'playing'` (on
every route; `suspend()` is never called while Tesbox should stay the active session), handlers for
`play`, `pause`, `nexttrack`, `previoustrack`. `play`/`pause` keep or restore audio and are never
shifts. **Dedupe:** a `MediaTrackNext`/`MediaTrackPrevious` keydown and a
`nexttrack`/`previoustrack` action within 900 ms count as one input (same-direction repeats from a
single source are *not* suppressed).

### 6.3 Interruption and recovery

- Watch `AudioContext.onstatechange`, the anchor/route `<audio>` element's `pause`, and
  `visibilitychange`.
- If audio stops without the user asking: full-screen **Tap to resume**. In that tap: if
  `state === 'interrupted'`, or `resume()` rejects, or the state isn't `running` within 500 ms →
  `close()` the context and, still inside the tap handler, build a new one, re-add the module,
  reconfigure, and replay the last config/fix. If `onstatechange` goes from `interrupted` to
  `suspended`/`running` by itself, resume automatically. No timer-driven retry loops. Recoveries are
  counted in Diagnostics.
- A Media Session action (other than pause/stop) also grants activation and may trigger the same
  recovery.
- `visibilitychange → hidden`: SimCore enters a "hidden" hold — fade to idle over 300 ms (GPS stops
  while hidden). `→ visible`: resume tracking; if audio was suspended, show Tap to resume.
- After a page reload mid-drive: restore settings, show Start immediately.

### 6.4 Output routes (all three implemented; default chosen by Phase 0)

- **direct:** worklet → `destination`.
- **media-element:** worklet → `MediaStreamAudioDestinationNode` → `<audio>`.
- **direct + anchor:** worklet → `destination`, plus a separate looping near-silent (≈ −60 dBFS)
  **file** `<audio>` element > 5 s long to hold the media session (the only Tesla-specific
  workaround on record).

Phase 0 tests each for Miniplayer appearance, survival when minimised, wheel-action delivery and
latency. Default before probe data: **direct + anchor**. Purpose of these routes: keep the car from
switching to radio and keep wheel actions flowing — not to keep the engine tracking while hidden
(impossible, §3).

### 6.5 Failure modes

| Condition | Behaviour |
|---|---|
| AudioWorklet missing / `addModule` rejects | Unsupported screen with the error string |
| MCU1 / no ES modules | Static Unsupported markup in `index.html` (§10.2) |
| Geolocation permission denied | Blocking banner with re-grant steps + **Use Demo** button |
| `POSITION_UNAVAILABLE` / timeouts | Dropout handling (§8.2); GPS-lost status after 20 s |
| `coords.speed` stuck at 0 while moving | Latch "speed unusable" → position path (§8.2) |
| Service Worker / Cache Storage unavailable | Online-only relaunch; session still survives via in-memory preload; Diagnostics shows it |
| Every route stops when minimised | Known limitation; Tap to resume on return |
| Context `interrupted` | Recreate-in-tap recovery (§6.3) |
| Non-finite DSP state | Full core reset + fade-in; counted |

---

## 7. Input

### 7.1 Touch paddles (guaranteed)

`−` / `+` paddle zones on the left/right edges of Drive, firing on `pointerdown`,
`touch-action: manipulation`. Minimum size `ceil(22 / 25.4 × 190 / devicePixelRatio)` CSS px (190
ppi ≥ the densest Tesla panel, so ≥ 22 mm everywhere). Each shift flashes the gear readout.

- **Manual:** paddles select gears (§8.6).
- **Auto:** a paddle press performs that shift and suspends auto-upshifts for 8 s (anti-lug
  downshift and over-rev refusal still apply), then Auto resumes.

### 7.2 Steering-wheel tilt (experimental, opt-in)

Requires Tesbox to be the active media session. Settings → **Test steering-wheel shifting**
(parked): "Tilt the LEFT scroll wheel to the RIGHT now" → expect `nexttrack` (or `MediaTrackNext`
keydown) within 10 s → reverse test. On success: tilt right = upshift, tilt left = downshift; result
stored. **Press is never mapped**; never suggest two-wheel gestures.

### 7.3 Gamepad (optional)

`navigator.getGamepads()` polled from rAF with a timing guard. R1/RB = upshift, L1/LB = downshift,
A = valves, B = perspective; A/B swap toggle for "TESLA VIRTUAL GAMEPAD"/Nintendo label mapping. User
presses a button once so the pad appears. Lowest-priority item of Phase 3.

### 7.4 Keyboard (desktop dev/testing)

`E` upshift, `Q` downshift, `V` valves, `P` perspective — any source. `W` throttle, `S` brake,
`Space` brake-to-stop — Keyboard source only.

---

## 8. Vehicle model (SimCore)

### 8.1 Sources

- **GPS** (main thread): `getCurrentPosition` chain — one request in flight, `timeout: 2000`,
  `maximumAge: 0`, `enableHighAccuracy: false` (default; Advanced toggles it and `watchPosition`),
  next request issued on resolve/reject (~1 Hz). Fixes forwarded raw (§4.3) with `coords.altitude`.
- **Demo / Keyboard:** physics in SimCore (§8.7).
- **Replay:** `tests/fixtures/replay/*.json` traces `{t, sAlongM, speedMps|null, accuracyM}`;
  positions are synthesised along a fake straight line from `sAlongM` (no real coordinates ever
  stored). Produced by `gpx-to-replay` from a phone GPX log recorded on the same drive, re-sampled
  to the probe-measured cadence/lag/null-rate/stale-fix model.

### 8.2 Speed filter (single 3-state Kalman on [s, v, a])

1. **Accept/reject.** Reject fixes with `ageS > 3`, `tFix ≤ t_k` (out of order), or identical
   (timestamp, lat, lon) to an earlier fix (Tesla repeats cached fixes).
2. **Measurements.** Position: `s` = cumulative haversine distance between consecutive accepted
   fixes, `R_s = (accuracy/2)²`. Speed: `coords.speed` when usable, `R_v = max(0.3 m/s,
   k·accuracy)²` (no age inflation). `speed === 0` is accepted only if displacement over the last
   3–5 s is < 5 m; if speed stays 0/null while displacement shows > 20 m over 5 s, latch
   `speedUnusable` for the session (position-only path). Null/NaN/non-finite = missing.
3. **Predict/update.** Posterior kept at the last fix time `t_k`; on each new fix predict to
   `t_{k+1}` with F = [[1,Δ,Δ²/2],[0,1,Δ],[0,0,1]] and white-jerk Q (q tuned; start 2 (m/s³)²/Hz).
4. **Output to "now".** Computed separately, never written back:
   `v(τ) = v_k + a_k · τ_a · (1 − e^(−τ/τ_a))`, τ = (currentTime + outputLatency) − t_k,
   τ_a ≈ 0.6 s (Δv saturates; no lift-off overshoot), clamped v ≥ 0.
5. **Standstill.** Enter zero below 0.5 m/s, leave above 1.0 m/s; reset `a` to 0 on entry.
6. **Dropout.** No accepted fix *arrival* for > 2 s → `predicting`; the step-4 predictor continues
   (saturating); auto-upshifts suppressed while predicting. After 20 s: ease to 0 over 10 s and set
   `gpsLost`.

### 8.3 RPM

- `C_dyn = π × (2·w·ar/100 + rim·25.4)/1000 × 0.97` m from `drivenTyre`.
- `rpm_wheel = v / C_dyn × overallRatios[gear − 1] × 60` (gear is 1-based).
- Unit-tested against EPA N/V (rpm/mph) where published: tolerance ±2.5 %, test records which tyre
  and which EPA axle ratio it compares; rows using the 1:1 gear instead of top gear are screened out.
  The RS 3's per-gear dual-final-drive mapping must come from an Audi/homologation document (the
  research's split was derived, not sourced).

### 8.4 Low-speed slip, launch, torque converter, idle

- **Clutch / DCT / AMT launch:** taper timer starts when load first exceeds 0.1 from standstill;
  `rpm = max(rpm_wheel, idle + max(load, 0) · (launchRpm − idle))`; lock only when
  `rpm_wheel ≥ max(1.05·idle, rpm_engine − 50)` (the 0.5–1.0 s timer only shapes the taper target,
  never forces lock). `launchRpm` is a voicing value.
- **Clutch disengage (all types):** disengage when `rpm_wheel(current gear) < 1.05·idle`,
  re-engage above `1.15·idle` → never stalls.
- **Torque converter:** `rpm_t = rpm_wheel` (turbine), `SR = lerp(0.97, couplingSR, max(load,0))`,
  `stall = lerp(idle, stallRpmWot, clamp(load,0,1))`,
  `rpm = ((rpm_t/SR)^4 + stall^4)^(1/4)` (smooth max). Lock-up from 2nd gear when turbine RPM >
  `lockupTurbineRpm`, slip ramped to 0 over 0.3–0.5 s (and back on unlock/kickdown).
- **Idle:** per-engine idle ± 10–30 rpm wander; cold idle +300 rpm for 30–60 s only on a true cold
  start (§5.3.5 `engineWarmAt`).
- **Rotary:** RPM is e-shaft speed; same math.

### 8.5 Load estimation

Per selected Tesla (`TeslaParams`, resolved at catalogue build time, all SI):

- `m` = normalised mass + 75 kg occupant (only for US-curb basis; EU unladen already includes a
  driver) — see `massBasis` §9.2.
- Road load `F_road(v) = A + B·v + C·v²` from **EPA *Target* coefficients** (not *Set*), converted:
  `A_N = 4.448222·A`, `B = 9.95040·B` (N·s/m), `C = 22.2583·C` (N·s²/m²); negative B allowed.
  Unit test: F_road at 100 km/h vs a hand-computed EPA row.
- Traction/power limits `F_trac`, `P_eff`, η = 0.90: fitted at catalogue build time by
  forward-simulating `m·dv/dt = min(F_trac, η·P_eff/v) − F_road(v)` to the published acceleration
  figure (normalised by `accelBasis`; US 0–60 mph + 0.25 s rollout correction where
  `rolloutSubtracted`).
- `F_max(v) = modeFactor · min(F_trac, η·P_eff/max(v, 1))`; `modeFactor` from the trim's
  `accelModes` (e.g. Chill 0.5, Standard 0.85, top mode 1.0).

```
F_req = m·a_out + F_road(v)
load  = F_req ≥ 0 ? clamp(F_req / F_max, 0, 1) : max(F_req / (m·0.25·g), −1)
```

Then 150–300 ms low-pass + small deadband. No grade estimation in v1 (altitude availability is
logged by the probe; a slow-adapting bias is a possible later enhancement). Tests: a simulated WOT
run per catalogue trim gives load ≥ 0.95 across 10–130 km/h and ≤ 0.75 at 0.6× that acceleration;
±20 % road-load / ±10 % mass changes load by < 0.05 over the Demo profile.

### 8.6 Drivetrain / gearbox

- **Shift-map invariants (computed at configure, unit-tested):** per gear n,
  `minUpshiftRpm_n = max(frac(load, mode)·redline, (coastDownRpm + 300) / (r_{n+1}/r_n))`;
  n→n−1 downshift speed = upshift speed of (n−1→n) × (1 − h), h = 0.15–0.30.
- **Auto (default):** upshift RPM interpolates with load: Sport ≈ 0.30→0.97·redline,
  Comfort ≈ 0.25→0.90. Minimum time in gear 1–2 s applies only to part-load and coast shifts; an
  upshift at or above the WOT point is allowed 0.2 s after the previous shift ends. Kickdown when
  load > 0.9 with a fast rise: drop 1–2 gears if the target RPM ≤ upshiftPoint(load) − 300. Coast
  downshifts below 1.2–1.5k. No auto-upshift while `predicting`.
- **Manual:** driver chooses gears; limiter at `rpm.limiter.rpm` (DSP-owned bounce, §5.3.7);
  downshifts that would exceed redline are refused (gear readout flashes); auto rev-match blip on
  downshift; optional auto-downshift below ≈ 1,100 rpm (default on); never stalls (§8.4).
- **Shift trajectory:** a shift event carries `{fromRpm, toRpm, t0, durationS = shiftTimeS}`; the DSP
  follows a prescribed curve (combustion cut / torque dip over the first 30–50 %, cosine ease of RPM
  over the last ~70 %), bypassing the RPM one-pole; then resumes tracking from `toRpm`. Type
  defaults/ranges: DCT/PDK ≈ 0.10 s, TC ≈ 0.20 s, manual/AMT ≈ 0.25–0.35 s.
- **Drive mode** (Comfort/Sport): shift map, valve threshold, crackle factor.

### 8.7 Demo / Keyboard physics

`a = (pedal·F_max(v) − F_road(v) − F_brake)/m` for the selected Tesla. Demo loops a scripted
profile (pull-away, WOT through gears, cruise, lift-off, braking, stop); Keyboard maps W/S/Space to
pedals. Both exercise the identical SimCore path.

---

## 9. Tesla catalogue (`src/data/teslas.json`)

### 9.1 Coverage

Per the user's request: **every Model S, X, 3, Y (incl. Y L) and Cybertruck generation and trim**
sold in the US/EU since 2012. MCU1-era configurations are present with `supported: false` unless the
user confirms an MCU2 retrofit. Plus **"Not listed"**: user enters 0–100 time and mass (parked only);
road load from a generic sedan/SUV default; `F_max = m·a_launch` (no power term); subwoofer =
not sure. Wheel options are not modelled (road-load sensitivity is negligible — test-backed, §8.5).

### 9.2 Record schema

```jsonc
{
  "model": "Model 3", "generation": "Highland", "years": [2024, 2026],
  "trim": "Long Range AWD", "markets": ["US", "EU"],
  "massKg": 1828, "massBasis": "us-curb",            // us-curb | eu-unladen-incl-driver | test-weight
  "peakPowerKw": 366,
  "accel": { "seconds": 4.2, "basis": "0-60mph", "rolloutSubtracted": true },  // or 0-100kmh
  "accelModes": [ { "name": "Chill", "factor": 0.5 }, { "name": "Standard", "factor": 1.0 } ],
  "roadLoadRef": "model3-highland",                  // → roadLoad table, matched by model year + rated hp
  "subwooferDefault": true,                          // a best guess; UI says so
  "mcu": ["amd"],                                    // possible values; runtime detection is authoritative
  "supported": true,
  "sources": { "mass": ["…"], "power": ["…"], "accel": ["…"], "audio": ["…"] }
}
```

`roadLoad` is a separate table keyed by model+generation (EPA Target coefficients matched to the
right generation — e.g. the 2025 EPA "Model Y Performance AWD" row is the pre-Juniper car — or
`derived` from Cd·A and Crr). Values illustrative.

### 9.3 Picker flow

Model → generation/years → trim → (MCU1-era only) "Has MCU2 retrofit?" → **Subwoofer: yes / no /
not sure** (pre-selected from `subwooferDefault`, labelled a best guess) → **bass sweep** (parked
only): steps at 30/35/40/45/50/60 Hz played at a fixed conservative level, *bypassing the
bass-management high-pass* (still through compressor/limiter); the user taps the lowest step that
plays cleanly → stored as `hpCornerHz` → acceleration mode from `accelModes`. Changeable in Settings
(parked).

---

## 10. UI

### 10.1 Global

Design target 773×601 CSS px; scales to ≈ 1255×758, 16" (dpr 1.96) and S/X layouts. Dark theme
forced. Touch targets per §7.1. No text entry while moving. Strings in one module. Original visual
identity — no Tesla logo/T emblem/wordmark styling, no car-brand logos or fonts. Build SHA visible in
Settings and Diagnostics.

"**Parked / stopped**" everywhere means: geolocation available **and** speed known **and** last
accepted fix < 3 s old **and** v < 5 km/h (real GPS, regardless of the selected source). Without
geolocation (desktop), stopped = unlocked.

### 10.2 Screens

1. **Unsupported** — static markup in `index.html`, hidden by the module bundle when it boots; an
   external ES5 `nomodule` script and a classic feature-check script reveal it (CSP-compatible) for
   MCU1 / no Web Audio / no AudioWorklet.
2. **First run: Which Tesla?** — §9.3, plus notices: "Tesbox replaces your music while it runs",
   "Keep Tesbox on screen — it idles when minimised", "Cabin sound only — keep it below sirens",
   "First load needs Wi-Fi, hotspot or Premium Connectivity", "Not affiliated with Tesla, Inc. or any
   car maker".
3. **Garage** — 15 cards in Euro / JDM / American / Exotic: generic title, "inspired by" subtitle,
   spec line (layout, displacement, aspiration, redline), 3 s live-rendered rev preview.
4. **Drive** — canvas tach (redline arc, shift light), large gear, speed, load bar; `−`/`+` paddles;
   three toggles Auto|Manual, Comfort|Sport, Valves Auto|Open|Closed; status dot (GPS / audio /
   headroom). Settings button enabled only when stopped. Enabling Manual the first time (parked)
   shows a one-time warning that touchscreen use while driving may be illegal in some places
   (e.g. Germany, StVO §23(1a)) and is at the driver's own risk.
5. **Settings** (stopped only) — volume trim, perspective Cabin|Outside, acceleration mode, Tesla &
   subwoofer & bass sweep, source GPS|Demo|Keyboard, quality Auto|Full|Lite, steering-wheel test,
   gamepad, Advanced (GPS method, high-accuracy, output route, gpsLatencyS, reset).
6. **Diagnostics** (long-press the status dot on Drive, or the app title in Settings) — GPS fix rate,
   fix age, `coords.speed` null/zero %, `speedUnusable`, accuracy, altitude availability;
   AudioContext state / sampleRate / baseLatency / outputLatency; headroom k; overload and
   recovery counters; non-finite resets; MCU guess; dpr/viewport; route; Media Session / key /
   gamepad event log. **Show QR**: statistics-only JSON summary (never coordinates).
7. **Sound Lab** (`/lab`) — §11.

### 10.3 Persistence

`localStorage` (try/catch, schema-versioned `tesbox.v1.*`): Tesla selection, MCU2-retrofit answer,
subwoofer answer, `hpCornerHz`, accelMode, engine, gearbox mode, drive mode, valve mode, perspective,
volume trim, speed source, quality tier + "Lite next Start" flag, GPS method, high-accuracy flag,
output route, `gpsLatencyS`, gamepad swap, wheel-shift calibration result, `engineWarmAt`,
first-run-notices-seen, manual-warning-seen. Corrupt/unknown → defaults.

---

## 11. Sound Lab and the "perfect sound" process

### 11.1 Render CLI

`tesbox-render <engine> [--segments …]` renders SimCore+DspCore in Node to WAV through fixed
segments: idle, cruise 2k/4k/6k, WOT pull idle→limiter, lift-off from 6k, limiter hold, auto-shift
pull — Cabin (scored) and Outside (invariants + listening only).

### 11.2 Reference clips

`lab-refs/<engine>/<clip>.wav` + sidecar `<clip>.json`:
`{ perspective, segment, rpmKeyframes: [[t, rpm], …] | "auto", gear? }` (`auto` = pitch-track of
the known firing pattern, seeded by cylinder count). **≥ 2 independent clips per scored engine.**
Clips are gitignored, used for private analysis only, never committed or shipped. Source: supplied
by the user, or fetched locally for analysis with the user's OK (open question §16).

### 11.3 Score CLI and gates

`tesbox-score <engine>` reports per segment:

- order-profile similarity (orders 0.5–12, cosine) at matched RPM,
- spectral tilt / centroid vs RPM,
- sub-order ratio (½ or ⅓ orders — uneven-firing / rotary signature),
- pulse irregularity (cycle-to-cycle variance),
- forced-induction line (whistle/whine frequency vs RPM),
- overrun event rate and loudness envelope,

and writes spectrogram + order-plot PNGs per segment (the reviewable evidence in
`docs/sound-scores.md`).

**Gates:** per metric, render-vs-ref ≥ 0.8 × ref-vs-ref (the two clips of the same car define the
achievable ceiling); **discrimination:** each render scores higher against its own refs than against
any other tuned engine's refs. Engines without clips: invariant tests + listening sign-off only,
marked `unscored` in `docs/sound-scores.md`.

### 11.4 Lab UI (`/lab`, desktop)

Engine selector, voicing sliders, RPM/load/gear/event controls, A/B against a locally-loaded
reference clip (file picker; never uploaded), Export JSON. Analysis plots come from the score CLI,
not a live in-browser analyser.

### 11.5 Naming rule

Generic title + "inspired by <car>" subtitle; never claim the sound *is* the real car; no logos.

### 11.6 Tuning loop

render → score → adjust voicing → repeat until gates pass → user listening sign-off (final
authority; Claude cannot hear).

---

## 12. Offline, caching, deployment

- **In-memory preload:** Start fetches everything a session needs (worklet module, all engine JSON,
  Tesla catalogue, fonts, anchor audio) into memory → a running session survives connectivity loss
  even without a Service Worker.
- **Service worker (opportunistic):** precache the hashed build; cache-first for hashed assets;
  network-first for `index.html`. New version → "Update available — tap to reload", shown only when
  the engine is off and stopped (§10.1). Registered with a relative scope.
- **Stale-build detection:** build SHA embedded; `version.json` fetched with `cache: 'no-store'`;
  mismatch → update prompt. Probe/test links documented as `…/?b=<sha>`.
- **nginx:** `index.html`, `sw.js`, `version.json` → `no-store`; `/assets/*` → `public,
  max-age=31536000, immutable`; MIME for `.js/.mjs/.wasm/.webmanifest`; gzip; SPA fallback (incl.
  `/lab`, `/probe/`); CSP `default-src 'self'; img-src 'self' data:; font-src 'self'; media-src
  'self' blob:` (no third parties); no COOP/COEP. Non-root, port 8080, healthcheck.
- **Docker:** `FROM --platform=$BUILDPLATFORM node:20-alpine AS build` → `nginx:alpine`; multi-arch
  amd64 + arm64 with only the final COPY per arch; GHA layer cache.
- **CI (GitHub Actions, push to master):** (1) typecheck + Vitest (DSP renders ≤ 2 s segments,
  suite budget ≤ 90 s; full sweeps are local-only); (2) build amd64 image (`load: true`), run it;
  (3) Playwright (Chromium only, cached) against the container; (4) only if green: push multi-arch
  `ghcr.io/atvriders/tesbox:latest` + `:<sha>`; write the realtime-factor benchmark to the job
  summary. Locally (no Docker): e2e against `vite preview` with the same headers module.
- **GHCR visibility:** the first push creates a private package; it must be set Public once in the
  package settings, verified by an anonymous `docker pull` (noted in README for forks).
- **README:** what it is, disclaimer, `docker-compose.yml` with `https://tesbox.example.com`
  placeholder, requirement for a public HTTPS domain/tunnel, connectivity note, in-car first run.
  No real hostnames/IPs anywhere in the repo.
- **Licence:** MIT; `NOTICES` for any attributions.

---

## 13. Safety and legal

- Cabin-only output; never suggest external speakers (FMVSS 141 — Boombox is Park-only; CA VC 27007).
- Conservative default volume; true-peak ceiling −1 dBTP; no speed-based loudness (the car does it);
  reminder not to mask sirens (StVO §23(1), UK Highway Code 148).
- Touchscreen use while driving: Tesla's manual warns against it; Germany's OLG Karlsruhe (2020)
  treated the Tesla screen as a device under StVO §23(1a) (brief glance only). Hence: Auto is the
  default; Settings only when stopped; one-time Manual warning; glance-sized controls.
- Disclaimer: "Not affiliated with or endorsed by Tesla, Inc. or any car manufacturer. Engine sounds
  are synthesized impressions, not recordings of the named cars."
- Naming rule §11.5; "Tesbox" used without Tesla marks or styling.
- Patents (not legal advice; free non-commercial project): Harman US 12,243,510 and US 9,553,553
  cover sample/PSOLA and harmonic+residual analysis of recordings — not used. US 6,959,094
  (Cascone, physical-model ICE synthesis, filed 2001) — expiry to be confirmed on Google Patents and
  recorded in `CLEAN_ROOM.md`. Hyundai/Kia US 11,904,769 (user-customised virtual engine sound with
  emotion/review models) — Tesbox uses no such model. Virtual bass uses only the basic Larsen & Aarts
  harmonic method (MaxxBass US 5,930,373 expired).

---

## 14. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Vehicle | Vitest | C_dyn/RPM vs EPA N/V ±2.5 %; Kalman on Replay fixtures (1 Hz, 1 s lag, null speed, **speed=0-while-moving Intel trace**, stale and duplicate fixes, dropouts, tunnels, stoplight jitter) incl. criterion (a); load estimator vs closed-form physics; WOT load ≥ 0.95 per catalogue trim; road-load/mass sensitivity < 0.05; gearbox invariants (min-upshift vs coast-down, hysteresis, min time in gear exemptions, kickdown target, no auto-upshift while predicting, never-stall, over-rev refusal, rev-match, Auto paddle override); slip/launch/TC curves continuous (no RPM steps) |
| Data | Vitest + JSON Schema | every engine & Tesla record validates; combustion angles distinct within [0, cycleDeg); overall ratios strictly descending; `spec` field groups each have sources; every `roadLoadRef` resolves; unit conversions |
| DSP invariants | Vitest (Node) | measured on the exhaust bus *before* bass management/perspective, fixed seed, forced hot thermal state, load 0.5, at 2k/4k/6k, 1–2 s renders: firing order in the top 3 orders; sub-order energy ≥ −N dB re firing order for uneven-fire/rotary and ≤ −M dB for even-fire; rotary 2nd e-shaft order dominant; supercharger whine line within 0.5 % of formula; turbo whistle and whine detectable in Cabin renders; limiter hold → combustion events at the bounce rate, never absent > 100 ms; **passivity:** impulse energy decays monotonically to −120 dB within 2 s for every engine × valve state × c extreme; no NaN/Inf under 10k-step fuzz incl. trim sweeps; **true peak ≤ −1 dBTP** (4× oversampled) everywhere; inharmonic energy above 16 kHz at 9,000 rpm < −60 dB; determinism by rendering twice in-process (never stored hashes/WAVs); `npm run goldens:update` for reviewed numeric snapshots |
| Allocation | lint + `tools/check-alloc.ts` | lint bans `new`, array/object literals, closures, try/throw in render/process paths; Node script renders 10⁵ warm quanta and fails if any GC pause > 4 ms or total GC time > 1 % of audio time (V8 boxes doubles across non-inlined calls, so zero GCs is not achievable with scalar per-sample APIs; output buffering absorbs short scavenges; in-car overload counters are the real gate) |
| Performance | CI benchmark (non-gating) | realtime factor in job summary; gate only on a generous floor (Full ≥ 5× realtime on CI, best of 3 windows; 10× is the reported development target) |
| Audio lifecycle | Vitest (mocked) + Playwright | start; interruption → recreate-in-tap; `interrupted→running` auto-resume; visibility hold; media-session handlers + dedupe definition; both output channels non-silent |
| E2E | Playwright vs container | first run → picker → bass sweep → garage → Drive in Demo → paddle/keyboard/simulated-media shifts → settings persistence → geolocation denied → Use Demo → no-SW mode (`serviceWorkers: 'block'`) → SW offline reload → paddle/toggle sizes ≥ minCssPx at viewports 773×601 @1.53, 1255×758 @1.53, 1306×735 @1.96, 1410×833 @1.56, 2200×1300 @1.0 |
| In-car | `docs/IN_CAR_CHECKLIST.md` + Diagnostics QR | parked (interactive) vs driving (logging only; a passenger reads the screen) steps; probe results committed as `docs/research/probe-results-<date>.json` (no coordinates) |

---

## 15. Build phases and exit gates

**Commit policy (needs user approval — §16):** in-car gates require a CI-deployed build, so each
phase ends with one fully-verified commit pushed to master (an exception to the user's usual
"single commit at the end" preference).

| Phase | Scope | Exit gate |
|---|---|---|
| **0 — In-car probe + pipeline** | Probe page (`/probe/`): AudioWorklet tone + `typeof performance` in worklet + k× headroom benchmark; three output routes (Miniplayer, minimise survival, latency); Media Session/key/gamepad logger; music resume/mix check; `latencyHint` A/B on Intel; visibility log; GPS matrix {poll, watch} × {highAccuracy on, off}: cadence, fix age, speed null/zero %, accuracy, altitude, crashes; DeviceMotion availability (no DeviceOrientation); dpr/viewport; WebGL MCU; SW + Cache Storage; build SHA; QR export. Plus Dockerfile, nginx, CI → GHCR. **User deliverable:** run the image behind their public HTTPS domain/tunnel and do the checklist. | Probe live at the user's URL; checklist done; results committed; §16 answers + chosen defaults (route, GPS method, high-accuracy, latencyHint, `gpsLatencyS`) recorded in this spec |
| **1 — Contracts + data spec + SimCore** | `src/contracts.ts`; schemas; full Tesla catalogue; 15 engine `spec` records (primary-sourced); speed filter, load, drivetrain, demo physics; Replay fixtures (`gpx-to-replay`) | Vehicle + data tests green on synthetic and recorded Replay fixtures, criterion (a) met |
| **2a — DspCore + render CLI** | Full synthesis chain, output stage, numerics, tiers; `tesbox-render`; invariant/allocation/true-peak tests | Invariant suite green; check-alloc green |
| **2b — Score CLI + 3 pilot engines** | `tesbox-score` + PNG plots; refs for pilots (user deliverable or fetched with OK); voice **2.5 Turbo Inline-5 (RS 3)**, **5.0 V8 NA (Mustang GT)**, **4.5 Flat-Plane V8 (458)** | 3 pilots pass gates (or are marked unscored) + listening sign-off |
| **2c — Sound Lab UI** | `/lab` per §11.4 | e2e smoke for `/lab` |
| **3 — App UI, input, lifecycle** | All screens, picker + bass sweep, paddles, wheel-tilt test, keyboard, diagnostics, persistence, audio lifecycle/recovery, gamepad last | e2e green; deployed; 10-min in-car drive with error counters at 0 |
| **4 — PWA, hardening, v1 release** | SW, update flow, stale detection, headers, README, IN_CAR_CHECKLIST; **v1 ships with the 3 pilot engines** | Offline-reload e2e; criterion (b) 30-min drive met; GHCR public + anonymous pull verified |
| **5 — Remaining 12 engines** | One engine per unit: `voicing` via Lab loop | Per engine: data tests + invariants + gates/unscored + sign-off; each shippable on its own |

---

## 16. Open questions

**For the user (before Phase 0 ships):**

1. Approve the per-phase commit + push exception (§15)?
2. Reference clips for scoring: will you supply them, or may Claude fetch public clips locally for
   private analysis (gitignored, never committed or shipped)?
3. Which public HTTPS domain/tunnel will host the probe and app? (Kept out of the repo; README uses a
   placeholder.)

**Resolved by the Phase 0 probe (results recorded back into §3/§6/§8 defaults):**

4. Does left-wheel tilt reach `nexttrack`/`previoustrack` (or `MediaTrack*` keys)? Per route,
   model, firmware.
5. Which output route keeps audio alive and shows the Miniplayer when minimised? Do geolocation
   fixes arrive while minimised (expected: no)?
6. GPS cadence, fix age (→ `gpsLatencyS`), `coords.speed` null/zero rate (Intel vs AMD),
   `watchPosition` and `enableHighAccuracy` stability, altitude availability.
7. Is `performance.now` available in the worklet; k× headroom on the user's MCU with the map running;
   Intel `latencyHint` A/B.
8. Are Service Worker + Cache Storage available and persistent across drives/sleep?
9. Does Tesbox replace or mix with the user's music?
10. Is `DeviceMotion` exposed with plausible longitudinal acceleration? (If yes, a later enhancement
    fuses it into the filter; never `DeviceOrientation`.)
11. (S/X only) Any interaction with Active Road Noise Reduction?

---

## 17. Key references

- Baldan, Lachambre, Delle Monache, Boussard — *Physically informed car engine sound synthesis for
  virtual and augmented environments*, SIVE 2015 (note: the printed ignition formula conflicts with
  the text — choose ignition phase deliberately).
- Farnell — *Designing Sound*, MIT Press 2010 (methods only).
- Doerfler & Wyse — PTR, arXiv 2603.07584 / 2603.09391 (methods only; code/dataset CC BY-NC).
- Bodden & Belschner — Inter-noise 2014 (order synthesis needs cycle-to-cycle variation).
- Larsen & Aarts — *Reproducing low-pitched signals through small loudspeakers*, JAES 2002.
- W3C Geolocation, Media Session, Web Audio; Chromium `media_session.cc`, `audio_context.cc`.
- EPA Test Car List (Target road-load coefficients, N/V); Tesla owner's manuals.
- Claim-level sources: `docs/research/2026-10-05-platform-research.json`; review findings that shaped
  rev 2 are summarised in the spec history (git).
