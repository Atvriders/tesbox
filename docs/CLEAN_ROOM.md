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
