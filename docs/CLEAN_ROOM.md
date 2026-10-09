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
