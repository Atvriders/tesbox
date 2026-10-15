# Phase 2b Contract — Reference scoring, auto-tuning, 3 pilot engines (LOCKED)

Authoritative for every Phase 2b task; formulas here beat prose elsewhere. Spec §11 (all), §1.3(d),
§14, §15 Phase 2b. Shared types: `src/contracts.ts` (LOCKED). Builds on the committed Phase 2a DSP
(`src/dsp/**`, `tools/render.ts`, `tools/segments.ts`, `tools/wav.ts`, `src/dsp/analysis.ts`) and the
Phase 1 engine data (`src/data/engines/*.json`). Execution model: each task is implemented test-first
directly from this contract (no separate full-code plan), then reviewed.

## Principles

- Claude cannot hear. "Perfect sound" is pursued by **measuring renders against real recordings** of
  the inspiring car (§11), with the user's listening sign-off as the final authority.
- **Reference audio is never committed or shipped** (`lab-refs/` and `renders/` are gitignored). Only
  sidecar-free metadata (clip URL, title, segment list, achieved scores) appears in
  `docs/sound-scores.md`.
- Everything in `src/lab/**` is environment-free TypeScript (Node + browser; Phase 2c's Sound Lab UI
  reuses it). Tools in `tools/**` may use Node APIs.
- Deterministic: fixed seeds, fixed analysis parameters; the same inputs give bit-identical reports.
- Clean room as before: no rupteur.app, no GPL/NC code. Algorithms from first principles / textbooks;
  log sources in `docs/CLEAN_ROOM.md` (harmonic-sum pitch estimation, Viterbi smoothing, Nelder–Mead,
  PNG/zlib spec RFC 2083/1950).

## Reference library (T7) — `lab-refs/<engineId>/`

- Clip audio: `lab-refs/<engineId>/<clipId>.wav`, 48 kHz mono 16- or 32-bit (converted with ffmpeg:
  `ffmpeg -i in -ac 1 -ar 48000 -c:a pcm_s16le out.wav`), trimmed to the useful part(s).
- Sidecar: `lab-refs/<engineId>/<clipId>.json`:
  ```jsonc
  {
    "clipId": "rs3-onboard-a",
    "source": "https://www.youtube.com/watch?v=…",   // provenance; never re-hosted
    "title": "…",
    "car": "Audi RS 3 Sportback (8Y)",                 // must match the engine's inspiredBy family
    "perspective": "cabin",                            // cabin | outside
    "segments": [
      { "kind": "wot", "startS": 12.0, "endS": 19.5, "rpm": "auto", "rpmHint": [2500, 7000] },
      { "kind": "idle", "startS": 2.0, "endS": 6.0, "rpm": "auto", "rpmHint": [700, 1100] },
      { "kind": "liftoff", "startS": 20.0, "endS": 24.0, "rpm": [[0, 6200], [3.5, 2600]] }
    ],
    "notes": "music-free; wind noise above 120 km/h"
  }
  ```
  `kind ∈ idle | cruise | wot | liftoff | limiter`. `rpm` is `"auto"` (tracked, §Pitch) or explicit
  keyframes `[[tSegment, rpm], …]` (linear interpolation).
- Acquisition procedure (documented in `docs/SOUND_LAB.md`): `~/.local/bin/yt-dlp` search
  (`ytsearch10:<car> <onboard|exhaust|dyno|acceleration> sound`), audio-only download
  (`-x --audio-format wav`), listen-free screening by analysis (pitch-track confidence ≥ 0.6 over the
  segment, no voice-over: spectral flatness of 300–3000 Hz band below threshold, no music: tonal
  non-harmonic peaks), trim. **At least 2 independent clips (different videos, ideally different
  cars) per perspective per pilot engine**; cabin is required, outside is preferred.
- A clip whose car does not match the engine's `inspiredBy` family is rejected.

## Pitch / RPM tracking (T1) — `src/lab/pitch.ts`

```ts
export interface RpmTrack { hopS: number; t: Float64Array; rpm: Float64Array; confidence: Float64Array }
export interface TrackOptions {
  firingsPerRev: number;          // combustion.length × 360 / cycleDeg (contracts.firingHz basis)
  subOrderStep: number;           // 0.5 (4-stroke) or 1/3 (rotary)
  rpmMin: number; rpmMax: number; // search range (from sidecar rpmHint or the engine's idle..limiter)
  hopS?: number;                  // default 0.02
  winS?: number;                  // default 0.12
  maxSlewRpmPerS?: number;        // default 6000 (Viterbi transition constraint)
}
export function trackRpm(signal: ArrayLike<number>, fs: number, o: TrackOptions): RpmTrack;
```

Method: per frame (Hann, zero-padded FFT ≥ 4× window), candidate rpm grid every 10 rpm in
`[rpmMin, rpmMax]`; salience(rpm) = Σ_{h=1..8} w_h · |X(h·f_fire)| with f_fire = rpm/60 ·
firingsPerRev and w_h = 1/h^0.5, plus 0.5·Σ sub-order bins (k·subOrderStep·rpm/60, k not a multiple
of firingsPerRev/subOrderStep) to disambiguate octave errors; Viterbi over frames with transition
cost ∞ beyond `maxSlewRpmPerS·hopS` and a linear cost inside; confidence = salience(best) /
Σ salience over the grid, normalised to [0,1] by the best frame. Tests: synthetic harmonic signals
and Phase 2a DSP renders with known rpm (fixtures, segments idle/wotPull/liftoff6k) — median abs
error ≤ 2 % of rpm, no octave errors.

## Features (T2) — `src/lab/features.ts`

Frames of 0.25 s, hop 0.125 s; each frame carries the (known or tracked) mean rpm.

```ts
export interface FrameFeatures {
  rpm: number;
  orderAmp: Float64Array;   // sqrt of orderSpectrum power at orders k·step, k = 1..floor(12/step)
  centroidHz: number;       // spectral centroid 20 Hz–12 kHz
  tiltDbPerOct: number;     // least-squares slope of 1/3-octave band levels (50 Hz–8 kHz, dB) vs log2(fc)
  subOrderDb: number;       // 10·log10(Σ sub-order power / firing-order power)
  irregularity: number;     // CV of per-cycle RMS (cycle = 720° or 1080° at frame rpm) over the frame
  fiLineHz: number | null;  // strongest peak 1–4 kHz with prominence ≥ 10 dB over the local median, else null
  levelDb: number;          // frame RMS dB
}
export interface ClipFeatures { kind: string; perspective: 'cabin' | 'outside'; frames: FrameFeatures[]; overrunRate: number | null }
export function frameFeatures(x: ArrayLike<number>, fs: number, rpm: number, step: number): FrameFeatures;
export function clipFeatures(x: ArrayLike<number>, fs: number, rpmAt: (tS: number) => number,
  step: number, kind: string, perspective: 'cabin' | 'outside'): ClipFeatures;
export const OVERRUN_ONSET_DB = 9; // overrunRate: onsets/s where a 2 ms HP(1 kHz) energy jump ≥ 9 dB over a 50 ms median, liftoff segments only
```

`step` = sub-order step (0.5 or 1/3). Orders above Nyquist are 0.

## Comparison and scoring (T3) — `src/lab/compare.ts`, `src/lab/score.ts`

RPM bins of 500 rpm. For two clips A, B of the same `kind` and `perspective`, over bins present in
both (≥ 2 frames each; ≥ 2 common bins else metric = null):

| metric | per-bin value | similarity |
|---|---|---|
| orderProfile | cosine(mean orderAmp_A, mean orderAmp_B) (each normalised to unit L2) | mean over bins |
| tilt | Δ = |mean tilt_A − mean tilt_B| | exp(−Δ / 3) |
| centroid | Δ = |log2(c_A / c_B)| | exp(−Δ / 0.5) |
| subOrder | Δ = |sub_A − sub_B| dB | exp(−Δ / 6) |
| irregularity | Δ = |ln(i_A / i_B)| | exp(−Δ / 0.7) |
| fiLine | Δ = |log2(f_A / f_B)| over bins where both non-null; null if either clip has none | exp(−Δ / 0.25) |
| overrun | Δ = |ln((r_A + 0.5) / (r_B + 0.5))| (liftoff only) | exp(−Δ / 0.7) |

Each metric's value is the mean of per-bin similarities. **Composite** = geometric mean of the
non-null metrics. All similarities ∈ [0, 1].

```ts
export type MetricName = 'orderProfile' | 'tilt' | 'centroid' | 'subOrder' | 'irregularity' | 'fiLine' | 'overrun';
export interface PairScore { metrics: Record<MetricName, number | null>; composite: number | null; commonBins: number }
export function compareClips(a: ClipFeatures, b: ClipFeatures): PairScore;

export interface EngineScore {
  engineId: string;
  renderVsRef: Record<MetricName, number | null>;   // mean over (render segment, matching ref segment) pairs
  refVsRef: Record<MetricName, number | null>;      // mean over distinct ref pairs of the same kind+perspective
  gate: Record<MetricName, 'pass' | 'fail' | 'n/a'>; // pass iff renderVsRef ≥ 0.8 × refVsRef (n/a if either null)
  composite: number | null;                          // composite over renderVsRef
  discrimination: { ownComposite: number | null; others: { engineId: string; composite: number | null }[]; pass: boolean | null };
  unscored: boolean;                                 // true when fewer than 2 refs exist (spec §11.3)
}
export function scoreEngine(engineId: string, render: ClipFeatures[], refs: ClipFeatures[],
  otherRefs: Record<string, ClipFeatures[]>): EngineScore;
```

Discrimination passes iff the render's composite vs its own refs is strictly higher than vs every
other engine's refs (only engines with refs participate; null if none).

## PNG plots (T4) — `tools/png.ts`

```ts
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array; // RFC 2083, zlib via node:zlib deflateSync, CRC32 in-house
export function spectrogramPng(x: ArrayLike<number>, fs: number, opts?: { width?: number; height?: number; maxHz?: number }): Uint8Array; // log-frequency axis 20 Hz–maxHz (12 kHz), 80 dB range, perceptual colormap
export function orderPlotPng(series: { label: string; rpm: number[]; orderAmp: number[][] }[], step: number): Uint8Array; // order (x) vs level dB (y) at the 3000 rpm bin per series
```

Tests decode the PNG header/CRC/IDAT with node:zlib inflate and check dimensions and pixel values.

## Score CLI (T5) — `tools/score.ts` (npm script `score`)

`tsx tools/score.ts <engineId> [--refs lab-refs] [--out renders/score] [--gate]`:
renders `idle, cruise2k, cruise4k, cruise6k, wotPull, liftoff6k` in each perspective that has refs
(Full tier, `renderSegment`), with known rpm from the segment control (`seg.ctl(t, base)` re-evaluated
per frame); loads every `lab-refs/<id>/*.json` sidecar + wav, tracks rpm where `"auto"`, extracts
features, scores (`scoreEngine`, with other engines' refs for discrimination), writes
`renders/score/<engineId>/report.json` (EngineScore + per-pair details), `report.md`, and PNGs
(`spectrogram-<clip|render>-<segment>.png`, `orders-<perspective>.png`). Exit 0 unless `--gate` and
any metric gate fails or discrimination fails (exit 1). Missing refs → `unscored: true`, exit 0.

## Auto-tune (T6) — `tools/tune.ts` (npm script `tune`)

`tsx tools/tune.ts <engineId> [--iterations 120] [--seed 1] [--apply]`:
bounded **Nelder–Mead** over the TUNABLE voicing vector (each normalised to [0,1] within its range):

| parameter | range |
|---|---|
| pulse.widthDeg | 40–90 (rotary 200–300) |
| pulse.alpha / beta | 3–20 / 1–10 |
| pulse.cycleAsymmetry | 0–0.5 |
| headers scale (×all headersM) | 0.7–1.4 (result clamped to contract maxima) |
| collectors lengthM | 0.2–1.0 |
| exhaust.midPipeM | 0.6–3.0 |
| mufflerSectionsM scale | 0.6–1.6 |
| exhaust.mufflerAction | 0–1 |
| exhaust.tailpipeM | 0.2–1.2 |
| intake.helmholtzHz / gain | 60–300 / 0–1 |
| mechanical.blockGain / valvetrainGain | 0–1 / 0–0.5 |
| cabin.lowpassHz | 300–1200 |
| forcedInduction.cabinGainDb (if present) | −24 – −6 |

(Superseded by amendments D9 and D10: one header scale per bank, one length per collector, the full schema ranges of
`cabin.lowpassHz` and `mechanical.valvetrainGain`, the phase 2a B18/B19 levels, and (D10) the B20 spread and the
B21 boom.)

Objective = −(composite renderVsRef over all scored segments) + 0.5·max(0, bestOtherComposite −
ownComposite + 0.02). Spec fields (firing angles, ratios, rpm) are never tuned. Every candidate must
pass `assertEngineFits`. Output: `renders/tune/<engineId>/best.json` (voicing + score + iteration
log). `--apply` writes the best voicing into `src/data/engines/<engineId>.json`, keeping
`voicing.estimated: true` (only the user's sign-off flips it) and rerunning `defaultVoicing`-free
validation (schema). Phase 1's `engines.test.ts` "voicing equals defaultVoicing" check must be
relaxed to "**untuned engines** equal defaultVoicing; tuned engines (listed in
`docs/sound-scores.md` / a `TUNED_ENGINES` set) pass schema + DSP invariants instead" — T6 owns this
test change. Tests: tuning a deliberately detuned fixture back toward a render of the original
(as a pseudo-reference) improves the composite by ≥ 0.1 and recovers the main parameters within
20 % of range.

## Pilots and sign-off (T8)

Pilot engines (spec §15 Phase 2b): `i5-turbo-25` (Audi RS 3), `v8-na-50` (Mustang GT Coyote),
`v8-flatplane-45` (Ferrari 458). For each: refs (T7) → `score` baseline → `tune --apply` →
`score --gate` → record in `docs/sound-scores.md`: refs (URL, title, perspective, segments),
baseline and tuned scores per metric, gate results, discrimination, and a **sign-off line pending
the user** (`Sign-off: pending — listen at <preview page>`). Previews: render each pilot's
`wotPull`, `cruise4k`, `liftoff6k`, `idle` in cabin and outside → MP3 (ffmpeg, 192 kbps) for the
user's listening page (published by the orchestrator as a private artifact). If an engine cannot
pass a gate after tuning, record the numbers and the most likely structural cause (e.g. missing
feature in the DSP) as a Phase 4/5 item — never loosen gates.

## File map

| Path | Task |
|---|---|
| `src/lab/pitch.ts`, `tests/unit/lab-pitch.test.ts` | T1 |
| `src/lab/features.ts`, `tests/unit/lab-features.test.ts` | T2 |
| `src/lab/compare.ts`, `src/lab/score.ts`, `tests/unit/lab-score.test.ts` | T3 |
| `tools/png.ts`, `tests/unit/png.test.ts` | T4 |
| `tools/score.ts`, `tests/unit/score-cli.test.ts`, `package.json` script `score` | T5 |
| `tools/tune.ts`, `tests/unit/tune.test.ts`, `package.json` script `tune`, `tests/unit/engines.test.ts` (voicing rule) | T6 |
| `lab-refs/**` (local only), `docs/SOUND_LAB.md` | T7 |
| `src/data/engines/{i5-turbo-25,v8-na-50,v8-flatplane-45}.json` (voicing), `docs/sound-scores.md`, previews (local) | T8 |
| `docs/CLEAN_ROOM.md` (append) | T5/T6 |

Waves: W1 T1, T2, T4, T7 → W2 T3, T5 → W3 T6 → W4 T8.

## Conventions

As earlier phases: TDD, one test file per module, hot-path rules don't apply to `src/lab` (analysis
code may allocate), no host paths/IPs in committed files, scratch dirs only, no per-task commits —
Phase 2b lands as one verified commit.

## Amendments (2026-10-14, authoritative — override anything above)

- **D1 Pitch tracker (replaces the salience/acceptance text of §Pitch):**
  1. Harmonic terms use **clamped per-bin contrast** `C⁺(f) = max(0, |X(f)| − localMean(f))`
     (weights `h^−½`, h = 1..8; sub-order term weight 0.5, gated by resolvability) — an absent
     fundamental contributes 0, never a penalty, so harmonic-2..8-only signals track at 1.000×.
  2. Emissions are normalised by a **fixed-band level** `L = mean |X|` over 20 Hz – 2 kHz of the
     frame, independent of `[rpmMin, rpmMax]`, so the voicing floor and SLEW_COST do not depend on
     the search range (narrow sidecar hints must work).
  3. **No silent fallback:** frames with no candidate above the voicing floor get `rpm = NaN`,
     `confidence = 0`; a segment with no voiced frame returns all NaN (callers skip it).
  4. **Acceptance (tests):** median |error| ≤ 2 % and zero octave errors (ratio outside
     [0.94, 1.06] counts as octave error) for idle / wotPull / liftoff6k on i4-test, i5-test,
     v8-crossplane-test, v8-flatplane-test, rotary-test, rendered with subwoofer `'yes'` AND `'no'`
     (40 Hz HP + virtual bass), searched with the engine's idle..limiter range AND with ±7 % hints
     around the true rpm; plus synthetic harmonic-2..8-only stacks for I4/I5/V8 at idle. Frames
     whose true rpm varies by > 3 % within the analysis window (limiter bounce) are excluded and
     counted; the overrun-segment acceptance scores every voiced frame (no `fromS` carve-out).
- **D2 Features:**
  1. Signatures gain the firing order: `frameFeatures(x, fs, rpm, step, firingsPerRev)` and
     `clipFeatures(x, fs, rpmAt, step, kind, perspective, firingsPerRev)`. `subOrderDb` =
     10·log10(Σ power at orders j·step ≤ 12 that are **not** multiples of `firingsPerRev` /
     Σ power at multiples of `firingsPerRev` ≤ 12). No guessing fallback.
  2. `fiLineHz` ignores peaks within ±3 % of any engine order `k·step·rpm/60`; the
     forced-induction line must also persist across ≥ 3 consecutive frames to be reported.
  3. `irregularity` uses an analysis window of `max(0.25 s, 4 cycles)` (cycle = 720° or 1080° at
     the frame rpm); if still undefined → `null` (never NaN).
- **D3 Scoring:** `fiLine` is `'n/a'` for engines whose `spec.aspiration.type === 'na'` (both in
  render-vs-ref and ref-vs-ref); per-bin values that are `null`/NaN are skipped, and a metric with
  < 2 valid common bins is `null` → gate `'n/a'`.
- **D4 Pitch-tracking usage and acceptance (2026-10-14; supersedes D1.4's wide-range cells):** the
  tracker only ever runs on reference clips, which carry sidecar hints. (1) `idle`, `cruise` and
  `limiter` segments with `rpm: "auto"` MUST carry an `rpmHint` no wider than ±15 % around the
  expected rpm (the score CLI rejects wider hints for these kinds). (2) `wot`/`liftoff` sweeps use a
  range hint `[low, high]` plus the Viterbi continuity constraint. (3) **Hard requirement: never
  confidently wrong** — over every cell actually used (hinted steady segments at ±7 % and ±15 %,
  sweeps with their range hints, subwoofer yes/no, all 5 fixtures, plus the synthetic
  harmonic-2..8 stacks for every amplitude law flat … h^−2 inside ±7 %/±15 % hints): every frame
  with `confidence ≥ 0.5` lies within ±6 % of the true rpm, and median |error| ≤ 2 % over voiced
  frames. (4) Unvoiced frames (NaN) are allowed and reported, not gated, except a voiced-share
  floor of 0.4 on non-rotary `wotPull` cells; rotary clips may use explicit `rpm` keyframes
  (from a visible tach) instead of `"auto"`. (5) Wide idle..limiter searches on idle segments are
  out of scope (documented limitation: bass-limited idle spectra can lock at 2–3×).
- **D5 fiLine (supersedes D2.2):** `fiLineHz` = strongest peak in 1–4 kHz with ≥ 10 dB prominence
  over the local median that persists across ≥ 3 consecutive frames (within ±5 % frequency),
  **without** engine-order exclusion (a supercharger whine is order-locked and must be detected).
  Per D3 the metric is only used for forced-induction engines, so NA harmonics never enter scoring.
- **D6 Minimum common bins:** steady kinds (`idle`, `cruise`, `limiter`) need ≥ 1 common 500 rpm
  bin (each side ≥ 2 frames); sweeps (`wot`, `liftoff`) need ≥ 2. (The old "≥ 2 everywhere" rule
  made steady segments never score.)
- **D7 Order plot bin:** `orderPlotPng` plots the 500 rpm bin with the most frames common to the
  render and the refs of that perspective (ties → the lower rpm); the chosen bin is printed in the
  legend and `report.md`.
- **D8 Forced-induction presence:** for engines with `aspiration.type !== 'na'`, add metric
  `fiPresence`: p = fraction of voiced frames (wot + cruise kinds) with a non-null `fiLineHz`;
  similarity = `1 − |p_render − p_ref|`; gate as other metrics (0.8 × ref-vs-ref, where ref-vs-ref
  compares p between ref clips). `MetricName` gains `'fiPresence'`; it enters the composite.
- **D8 (ratified 2026-10-14, supersedes the D8 formula above):** `fiPresence` is scored on
  comparable `wot` and `cruise` pairs. Per common 500 rpm bin, p = the fraction of that bin's voiced
  frames with a line (finite `fiLineHz > 0`); per-bin similarity = `1 − |p_A − p_B|`; the metric is
  the mean over the common bins with D6's minimum common bins (else null). renderVsRef, refVsRef,
  the gate (0.8 × ref-vs-ref) and the composite work as for every other metric; null / gate `n/a`
  for NA engines (like fiLine, D3). (The clip-wide reading scored pairs with no common rpm and failed
  the honest end-to-end test: 0.774 vs a 1.000 ceiling, against 0.967 per bin.)
- **D9 Tunable vector v2 (2026-10-15, phase 5 contract P0.3; supersedes the §T6 table):**

  | parameter | range |
  |---|---|
  | pulse.widthDeg | 40–90 (rotary 200–300) |
  | pulse.alpha / beta | 3–20 / 1–10 |
  | pulse.cycleAsymmetry | 0–0.5 |
  | `headersM.bank<b>.scale` — one per exhaust bank the engine has (two where the layout has two banks) | 0.7–1.4 (result clamped to the contract maxima) |
  | `collectors[<c>].lengthM` — one per collector | 0.1–1.0 |
  | exhaust.midPipeM | 0.6–3.0 |
  | mufflerSectionsM scale | 0.6–1.6 |
  | exhaust.mufflerAction | 0–1 |
  | exhaust.tailpipeM | 0.2–1.2 |
  | intake.helmholtzHz / gain | 60–300 / 0–1 |
  | mechanical.blockGain / valvetrainGain | 0–1 / 0–1 |
  | cabin.lowpassHz / leakDb (phase 2a B19) | 200–2000 / −60 – −10 |
  | forcedInduction.cabinGainDb (if present) | −20 – −10 (the schema range) |
  | forcedInduction.whistleDb (turbo only, phase 2a B18) | −60 – 0 |
  | forcedInduction.outsideGainDb (if present, B18) | −60 – 0 |

  Header i belongs to bank `spec.combustion[i].bank` — the key the exhaust network routes it by (a
  bank joins the first collector listing it, else collector 0; phase 2a B11) — so one scale moves exactly
  the headers the network groups as that bank. Keys: `headersM.bank0.scale` … `headersM.bank3.scale`
  (schema banks 0–3) and `collectors[0].lengthM` … `collectors[7].lengthM` (the network's 8 collectors);
  parameters an engine lacks are left out of its vector, and `--params` naming one is refused. The
  collector floor is the 0.1 m pipe-section capacity (4 samples at 700 m/s and 28 kHz) instead of 0.2 m.
  Every range lies inside engine.schema.json, so every candidate validates. Evidence (2026-10-15 gap
  analysis): default voicings give both banks of a V the same header lengths per bank position and equal
  collectors, so the banks are identical and cancel the half-orders — render orders 1–2.5 at −17 … −27 dB
  against 0 … −5 dB in the Mustang recordings, the 458's order 2 at −25 dB where the recordings lead with
  it; bank-asymmetric headers (×0.7 / ×1.4) on v8-flatplane-45 passed every gate (composite 0.539), and
  Mustang collectors of 0.1 m / 1.0 m lifted subOrder to 0.463. The cabin ranges follow the B19 evidence
  (the recordings' 0.8–2.5 kHz band is 41–83 % engine harmonics).
- **D10 Tunable vector v3 (2026-10-15, phase 5 contract P0b.3; extends D9):** three parameters every
  engine has, inside their schema ranges, so every candidate still validates:

  | parameter | range | grid | position |
  |---|---|---|---|
  | pulse.cylinderSpreadDb (phase 2a B20) | 0–6 dB | 0.01 dB | after pulse.cycleAsymmetry |
  | cabin.boomHz (phase 2a B21) | 40–200 Hz | 1 Hz | after cabin.leakDb |
  | cabin.boomDb (phase 2a B21) | 0–12 dB | 0.1 dB | after cabin.boomHz |

  A voicing at the neutral defaults (no spread, boom 0 dB at 100 Hz) starts on the lower box edges of the
  two levels; CMA-ES evaluates such candidates at their clamp with the P1 boundary penalty. The Lab's T6
  ranges follow. Only the three near-miss engines (v8-sc-62, flat4-turbo-25, i4-turbo-20) are re-tuned
  with v3; every other engine keeps its 1.3.0 voicing with the neutral defaults and renders
  bit-identically (phase 2a B20/B21).
