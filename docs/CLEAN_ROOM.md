# Clean-room log

Tesbox is an original implementation of a publicly known product concept (GPS-driven engine
sound in the Tesla browser). This file is the binding policy (spec §2) plus the source log for
every algorithm in the repository. Add a row whenever an algorithm lands.

## Policy

- Nothing from rupteur.app — code, engine definitions, calibration data, audio, copy, branding or
  UI assets — is fetched, read or used. The one download made during discovery was deleted unread.
- `github.com/UnendlessGit/juniper-sound-lab`, and any repo or app that references rupteur.app or
  appears derived from it, is never opened or read.
- Algorithms are implemented from papers, standards and first principles only, except MIT code adapted with attribution as allowed below.
- No code is copied from GPL sources (e.g. SDT `SDTMotor.h` — not even read), non-commercial
  sources (PTR code/dataset, PolyForm-NC projects such as sedicivalvole) or unlicensed sources
  (Farnell's Pd patches). MIT code may be adapted with attribution in `NOTICES` (so far: Project Nayuki's QR Code generator library → `src/platform/qr.ts`, MIT notice in `NOTICES`).
- Engine and Tesla data are compiled per vehicle from primary/public documents with per-field-group
  `sources`; no third-party specs database is bulk-extracted.
- Third-party runtime code shipped to the browser: only the MIT-attributed QR encoder adaptation in `src/platform/qr.ts`. Test-only tools are listed in `NOTICES`.

## Phase 0 source log

| Module | Algorithm | Source |
|---|---|---|
| `src/platform/qr.ts` | QR Code encoder: byte mode, ECC level L, versions 1–40, Reed–Solomon over GF(2⁸) (primitive polynomial 0x11D), BCH format/version information, 8 mask patterns, penalty rules N1–N4 | ISO/IEC 18004:2015 *QR Code bar code symbology specification*; code structure adapted from Project Nayuki, *QR Code generator library* (MIT) |
| `src/platform/geo.ts` | Great-circle distance (haversine), mean Earth radius R = 6 371 008.8 m | R. W. Sinnott, "Virtues of the Haversine", *Sky & Telescope* 68(2), 1984; H. Moritz, "Geodetic Reference System 1980", *Bulletin Géodésique* 54, 1980 (mean radius R₁) |
| `src/probe/gps-stats.ts` | Nearest-rank median / p95 | R. J. Hyndman & Y. Fan, "Sample Quantiles in Statistical Packages", *The American Statistician* 50(4), 1996 (inverse empirical CDF) |
| `src/probe/gps.ts` | `getCurrentPosition` chain / `watchPosition` runner | W3C *Geolocation* Recommendation |
| `src/probe/work.ts` | Synthetic multiply-add load kernel (k × 400 ops per sample) | First principles |
| `src/probe/audio-worklet.ts` | Raised-cosine pulse train; one-pole low-pass y[n] = (1 − a)·x[n] + a·y[n−1], a = e^(−2π·f_c/f_s) | First principles; W3C *Web Audio API* (AudioWorklet) |
| `src/probe/drift.ts` | Audio-clock vs wall-clock ratio from `getOutputTimestamp()` | W3C *Web Audio API* |
| `src/probe/audio.ts`, `src/probe/inputs.ts` | Output routes, Media Session handlers, input logging, DeviceMotion | W3C *Web Audio API*, *Media Session*, *DeviceOrientation Event* (DeviceMotion only), *Gamepad*, *UI Events* |
| `src/probe/storage-probe.ts`, `public/probe/sw.js` | Cache Storage round-trip, service-worker registration | W3C *Service Workers* |
| `tools/make-anchor-wav.ts` | RIFF/WAVE PCM writer; xorshift32 PRNG; triangular (TPDF) noise scaled to −60 dBFS RMS | Microsoft & IBM, *Multimedia Programming Interface and Data Specifications 1.0*, 1991 (RIFF WAVE); G. Marsaglia, "Xorshift RNGs", *Journal of Statistical Software* 8(14), 2003 |

## Planned sources (later phases, methods only)

| Area | Source |
|---|---|
| Engine synthesis (DspCore) | S. Baldan, H. Lachambre, S. Delle Monache, P. Boussard, "Physically informed car engine sound synthesis for virtual and augmented environments", SIVE 2015 |
| Engine synthesis methods | A. Farnell, *Designing Sound*, MIT Press 2010 (text only; the Pd patches are not used) |
| Pulse shaping / regime gating | Doerfler & Wyse, PTR, arXiv 2603.07584 / 2603.09391 (paper only; CC BY-NC code and dataset not used) |
| Cycle-to-cycle variation | Bodden & Belschner, Inter-noise 2014 |
| Virtual bass | E. Larsen & R. M. Aarts, "Reproducing low-pitched signals through small loudspeakers", *JAES* 2002 |
| Vehicle model | Standard vehicle dynamics; EPA Test Car List (Target road-load coefficients, N/V); Tesla owner's manuals |

## Patents checked (not legal advice)

| Patent | Scope | Status for Tesbox |
|---|---|---|
| US 6,959,094 (Cascone et al., physical-model ICE sound synthesis; filed 2001-04-20) | Synthesis of internal-combustion engine vehicle sounds | Google Patents legal status "Expired - Lifetime", adjusted expiration 2022-12-26 (checked 2026-10-06, re-confirmed 2026-10-08, patents.google.com/patent/US6959094B1) |
| Harman US 12,243,510; US 9,553,553 | Sample/PSOLA and harmonic+residual analysis of recordings | Not used: Tesbox has no recordings or sample banks |
| Hyundai/Kia US 11,904,769 | User-customised virtual engine sound with emotion/review models | Not used: no such models |
| MaxxBass US 5,930,373 | Virtual bass | Expired; Tesbox uses only the basic Larsen & Aarts harmonic method |

## Phase 2a source log (DspCore + render tools)

All modules below are written from the cited papers, standards and books (methods only) or from first
principles. No code was copied from any source; nothing from the sources excluded by the policy above
was read.

| Module | Algorithm | Source |
|---|---|---|
| `src/dsp/util.ts` | Flush-to-zero of tiny recursive states, dB conversions, smoothstep, one-pole smoother y += k·(x − y), slew limiter; mulberry32 32-bit PRNG with Box–Muller Gaussian deviates (cached pair) | First principles; mulberry32 (T. Ettinger, 2017; reimplemented from its published description); G. E. P. Box & M. E. Muller, "A Note on the Generation of Random Normal Deviates", *Ann. Math. Statist.* 29(2), 1958 |
| `src/dsp/biquad.ts` | Biquad low-/high-/band-pass (constant 0 dB peak gain), shelves and peaking EQ, Direct Form I with float64 state flushed every sample; 4th-order Butterworth as two cascaded biquads (Q = 1/(2·cos(π/8)), 1/(2·cos(3π/8))) | R. Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients" (Audio EQ Cookbook, W3C Note); S. Butterworth, "On the Theory of Filter Amplifiers", *Experimental Wireless & the Wireless Engineer* 7, 1930 |
| `src/dsp/oversample.ts` | 4× polyphase interpolator: 48-tap windowed-sinc low-pass designed at load time, Kaiser window β = 8 (I0 by its power series), cutoff 0.45·fs_in, taps normalised for 4× upsampling | J. F. Kaiser, "Nonrecursive digital filter design using the I0-sinh window function", *Proc. IEEE ISCAS*, 1974; ITU-R BS.1770 Annex 2 (true-peak estimation by oversampling) |
| `src/dsp/delay.ts` | Fractional delay line (doubled Float32 ring, no modulo on read) with linear and 3rd-order Lagrange interpolation, incl. a precomputed fixed-delay Lagrange kernel | T. I. Laakso, V. Välimäki, M. Karjalainen, U. K. Laine, "Splitting the unit delay", *IEEE Signal Processing Magazine* 13(1), 1996; J. O. Smith III, *Physical Audio Signal Processing*, W3K Publishing, 2010 |
| `src/dsp/waveguide.ts`, `src/dsp/junction.ts` | Bidirectional digital-waveguide tube section with one-pole wall loss (\|H\| ≤ 1) and Lagrange-3 reads; lossless N-port parallel scattering junction pJ = 2·Σ(Yᵢ·pᵢ⁺)/Σ(Yᵢ), pᵢ⁻ = pJ − pᵢ⁺; terminations by reflection coefficient | J. O. Smith III, *Physical Audio Signal Processing*, W3K Publishing, 2010 (digital waveguides, scattering junctions, passivity) |
| `src/dsp/exhaust.ts` | Passive exhaust network: headers → per-collector junctions → collector tubes → turbine 2-port (partial reflection, transmitted wave through a 2-pole low-pass) → merge junction → mid-pipe → muffler junction with closed side-branch chambers → tailpipe → open end (reflection through a one-pole low-pass, exit wave p⁺ − p⁻); per-section speeds of sound set from the gas thermal state (343 m/s cold → hot targets, slewed by DspCore); valve bypass as a convex combination of passive scattering matrices; radiation as a first-order high-pass (differentiator) and a first-order shelf outside every loop | S. Baldan, H. Lachambre, S. Delle Monache, P. Boussard, "Physically informed car engine sound synthesis for virtual and augmented environments", IEEE SIVE 2015 (methods only); J. O. Smith III, *Physical Audio Signal Processing* (passivity); first principles |
| `src/dsp/combustion.ts` | Double-precision crank-angle clock over cycleDeg (720 four-stroke, 1080 rotary) with sub-sample event onsets, firing scheduler, blowdown pulse E(φ) = (1 − e^(−αφ))²·e^(−βφ)·taper(φ) with load-dependent onset sharpness and a time-to-peak clamp, cycle-to-cycle timing/amplitude jitter, cycle asymmetry, rotary per-face amplitude pattern, per-entry first-order DC blocker, intake gates with raised-cosine edges, ignition impulses, skip masks | Baldan et al., SIVE 2015 (methods only); Doerfler & Wyse, PTR, arXiv 2603.07584 / 2603.09391 (pulse shaping and regime gating, paper only — CC BY-NC code and dataset not used); Bodden & Belschner, Inter-noise 2014 (cycle-to-cycle variation) |
| `src/dsp/rpm-state.ts` | One-pole rpm tracking (τ 40 ms), prescribed shift trajectory (hold, cut window, cosine ease), rev-limiter cut/fire bounce, falling-rpm detector over a 20 ms ring | First principles (spec §5.3.7, §8.6) |
| `src/dsp/intake.ts`, `src/dsp/mechanical.ts` | Intake roar: noise band-passed at the Helmholtz frequency, gated by the intake windows, throttle de-zipped by a 20 ms linear slew; block thump (ignition impulses → 250 Hz low-pass); valvetrain ticks (exponentially decaying 2 ms noise bursts → 3 kHz band-pass) | A. Farnell, *Designing Sound*, MIT Press 2010, engine chapter (text only; the Pd patches are not used); Baldan et al., SIVE 2015 |
| `src/dsp/forced.ts` | Turbo shaft-speed lag (one-pole, spool time rising, 0.6 × spool time falling), boost = shaft², whistle sines (f1 = 1000 + 3000·shaft Hz and 2·f1) ∝ boost, 4–12 kHz band-passed whoosh ∝ boost², parallel/sequential second voices, blow-off burst / compressor flutter on lift; supercharger whine order = pulleyRatio·gearRatio·(roots ? 2·lobes : lobes) | First principles; Farnell, *Designing Sound* (methods only) |
| `src/dsp/overrun.ts` | Overrun pops as a Poisson process (one Bernoulli trial per sample with probability λ/fs) with an exponentially decaying rate, bounded 1 ms raised-cosine impulses injected into the exhaust, immediate pops for ignition-cut firings; airflow noise (2nd-order Butterworth low-pass) | First principles; Doerfler & Wyse (combustion/overrun regime gating, methods only) |
| `src/dsp/perspective.ts` | Cabin (4th-order Butterworth low-pass; separately low-passed block and forced-induction buses) vs outside mix with a 300 ms smoothstep crossfade; mono-compatible ±0.08 mid/side decorrelation via a 0.7 ms delay | First principles; Audio EQ Cookbook (filters) |
| `src/dsp/output-stage.ts` | Trim ramp, NaN guard, DC blocker, bass management (4th-order Butterworth high-pass or 22 Hz infrasonic high-pass), NLD virtual bass (Chebyshev T2 + T3 on the envelope-normalised removed band), linked soft-knee compressor (static gain computer + smooth decoupled peak detector on the gain reduction), look-ahead true-peak limiter with 4× oversampled detection, hard clip | E. Larsen & R. M. Aarts, "Reproducing low-pitched signals through small loudspeakers", *J. Audio Eng. Soc.* 50(3), 2002; D. Giannoulis, M. Massberg, J. D. Reiss, "Digital Dynamic Range Compressor Design — A Tutorial and Analysis", *J. Audio Eng. Soc.* 60(6), 2012 (soft-knee gain computer, smooth decoupled peak detector); ITU-R BS.1770 Annex 2 (true peak) |
| `src/dsp/analysis.ts` | In-place iterative radix-2 FFT, symmetric Hann window, Hann-windowed Goertzel order spectrum, true peak via the shared 4× upsampler, RMS, band energy from the Hann-windowed zero-padded FFT relative to a full-scale sine | J. W. Cooley & J. W. Tukey, "An algorithm for the machine calculation of complex Fourier series", *Math. Comp.* 19, 1965; G. Goertzel, "An Algorithm for the Evaluation of Finite Trigonometric Series", *Amer. Math. Monthly* 65(1), 1958; F. J. Harris, "On the use of windows for harmonic analysis with the discrete Fourier transform", *Proc. IEEE* 66(1), 1978; ITU-R BS.1770 Annex 2 |
| `src/dsp/dsp-core.ts` | Per-quantum control (gas-speed slews τ 3 s with a 120 s warm-up, overrun regime crossfade, valve slew), ignition ramps, limiter/shift skip masks, per-sample chain, 300 ms configure fades, non-finite reset with a 50 ms fade-in | First principles (spec §5.3) |
| `tools/wav.ts` | RIFF/WAVE writer (32-bit IEEE float with `fact` chunk) and reader (16/24/32-bit PCM, 32-bit float, WAVE_FORMAT_EXTENSIBLE) | Microsoft & IBM, *Multimedia Programming Interface and Data Specifications 1.0*, 1991; Microsoft, WAVEFORMATEXTENSIBLE documentation |
| `tools/segments.ts`, `tools/render.ts` | Render segments (kinematic rpm profiles, constant vehicle acceleration per gear, upshift ShiftStates) and the `tesbox-render` CLI (0.5 s discarded pre-roll per segment) | First principles (spec §11.1) |
| `tools/check-alloc.ts`, `tools/bench-dsp.ts` | GC-pause gate from `perf_hooks` GC entries (amendment B2), judged on the best of up to 3 measured windows, sampling-heap-profiler allocation report; realtime-factor benchmark gated on the best of 3 timed windows (median reported) | Node.js `perf_hooks` and `inspector` documentation; first principles |

## Phase 1 source log — vehicle model, catalogue data and tools

Policy check for this phase: nothing from rupteur.app, its repositories or any app or repo that references it (e.g. github.com/UnendlessGit/juniper-sound-lab) was fetched, opened or used. No GPL, non-commercial or unlicensed code (SDT, PTR code/dataset, sedicivalvole, Farnell's Pd patches) was read. Every algorithm below was implemented from the cited public documents or from first principles; every engine and Tesla number carries per-field-group sources in its JSON.

| Module | Algorithm | Source |
|---|---|---|
| `src/sim/tyre.ts` | ISO metric tyre code → unloaded diameter 2·w·ar/100 + rim·25.4 mm; rolling circumference π·D·0.97; engine rpm = v / C · overall ratio · 60 | ISO 4000-1 tyre designation; 0.97 dynamic-radius factor checked against US EPA Test Car List N/V values (docs/research/2026-10-05-platform-research.json, topic `drivetrain`) |
| `src/sim/epa.ts` | EPA Target coefficients lbf, lbf/mph, lbf/mph² → N, N·s/m, N·s²/m² | NIST SP 811 conversion factors (1 lbf = 4.448222 N, 1 mph = 0.44704 m/s); US EPA Test Car List column definitions |
| `src/sim/speed-filter.ts` | 3-state [s, v, a] Kalman filter with white-noise-jerk process noise, sequential scalar position/speed updates with a symmetrised covariance, saturating acceleration prediction to "now", standstill hysteresis with a position deadband, arrival-based dropout, re-seed after fix gaps longer than 60 s, zero-speed plausibility rule with a speed-unusable latch | R. E. Kalman, "A New Approach to Linear Filtering and Prediction Problems", *J. Basic Eng.* 82 (1960); Y. Bar-Shalom, X. R. Li, T. Kirubarajan, *Estimation with Applications to Tracking and Navigation*, Wiley 2001 (kinematic state models); W3C *Geolocation* (`coords.speed` semantics) |
| `src/sim/replay.ts`, `tools/make-synthetic-replay.ts`, `tools/gpx-to-replay.ts` | Deterministic synthetic GPS traces (mulberry32 PRNG, Gaussian noise via Box–Muller, first-order Gauss–Markov position noise; the stoplight trace adds a white component), GPX track parsing, cumulative haversine distance, resampling to a fixed cadence, positions stripped | TopoGrafix *GPX 1.1 Schema*; G. E. P. Box & M. E. Muller, "A Note on the Generation of Random Normal Deviates", *Ann. Math. Statist.* 29 (1958); first principles (haversine: Phase 0 row) |
| `src/sim/load.ts` | F = m·a + A + B·v + C·v²; F_max = modeFactor·min(F_trac, η·P/max(v, 1)); one-pole low-pass + deadband | Newton's second law; road-load equation of the EPA coast-down procedure (40 CFR Part 1066) |
| `src/sim/shift-map.ts`, `src/sim/gearbox.ts` | Load-dependent upshift curve, hysteresis downshift line, minimum time in gear with exemptions, over-speed skip upshift, kickdown, paddle override, over-rev refusal | Shift-schedule literature in docs/research (topic `drivetrain`): *J. Phys.: Conf. Ser.* 2601, 012016; US 4,967,611, US 5,685,799, US 5,669,850 (methods only) |
| `src/sim/driveline.ts` | Clutch-slip launch taper; torque-converter engine speed as the L4 smooth maximum of turbine-driven and stall rpm; lock-up slip ramps; cold-idle ramp | First principles; Schaeffler (LuK) symposium paper "Torque Converter" (lock-up practice) |
| `src/sim/demo.ts`, `src/sim/sim-core.ts` | Keyframed pedal profile (linear interpolation) → force → explicit Euler; crank/idle sequence; sub-model wiring | Newton's second law; first principles |
| `tools/build-catalogue.ts` | EPA Target → SI; derived road load A = Crr·m·g, C = ½·ρ·CdA (ρ = 1.2041 kg/m³); forward-Euler 0 → v_target simulation (dt 5 ms) with bisection on F_trac, then P_eff, to the published time | First principles (spec §8.5) |
| `src/data/voicing-defaults.ts` | Deterministic starting voicing; header lengths from a golden-ratio low-discrepancy sequence | First principles; constants from the phase contract |

| Data | Sources | Notes |
|---|---|---|
| Engine `spec` (15 JSONs) | Manufacturer technical data, press releases, brochures and workshop manuals (archive.org scans and Wayback copies count as the manufacturer document), US EPA Test Car Lists (axle ratio, N/V), Wikipedia only as labelled last resort | No bulk extraction from a specs database; variant choices, estimates (idle, limiter type/hysteresis, torque-converter data) and substitutions are stated in each `notes` |
| Engine `voicing` | `defaultVoicing` estimates, `estimated: true` | Tuned in the Sound Lab (Phases 2b and 5) |
| Tesla catalogue (`teslas.json`) | Tesla spec pages and owner's manuals via Internet Archive Wayback snapshots (URLs with timestamps), US EPA Test Car Lists 2012–2026 (rated hp), Wikipedia only where Tesla publishes nothing (stated per record) | `accelModes` factors are Tesbox estimates (Chill 0.5, intermediate 0.85 — 0.7 / 0.85 where a manual lists two intermediate modes — top 1.0) |
| Road load (`raw/roadload-src.json` → `roadload.json`) | US EPA Test Car Lists, Target (not Set) coefficients | US government public data; proxies and `derived` rows state their basis |
| Replay fixtures (`tests/fixtures/replay/*.json`) | Generated by `tools/make-synthetic-replay.ts` | No real coordinates; GPX inputs are never committed |

Third-party code added in Phase 1: Ajv 8 (MIT) for JSON Schema validation in tests and `tools/build-catalogue.ts` only — not shipped to users (listed in `NOTICES`).
