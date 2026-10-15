# Sound Lab reference library

Claude cannot hear, so Tesbox's engines are tuned by **measuring renders against real recordings**
of the inspiring cars (spec §11, Phase 2b contract "Reference library (T7)"). This document is the
procedure for building that library: where reference clips come from, how they are screened
without listening, how each clip is described in its sidecar, and what is in the library today.
The user's listening sign-off stays the final authority (spec §11.6).

## Privacy and copyright

- Reference recordings are third-party videos, used for **private analysis only**. They are never
  committed, shipped, uploaded or re-hosted: `lab-refs/` is gitignored, the app never loads them,
  and the Sound Lab A/B feature only plays a file the user picks locally (spec §11.4).
- What the repository may contain is metadata: source URL, title, trim, segment list, scores (this
  file and `docs/sound-scores.md`). Audio, spectrogram images of references and sidecars stay local.
- The tables at the end of this file are enough to re-download the same videos, cut the same
  audio and mark the same segments (kind, bounds, rpm range). The rpm keyframes and the screening
  notes exist only in the local sidecars: a rebuilt library re-derives the keyframes with the
  procedure under "rpm truth" and checks them against the ranges listed here. Delete a clip (WAV
  and sidecar) if its owner asks.
- Clean room (`docs/CLEAN_ROOM.md`): sources are ordinary car videos. Nothing from rupteur.app, or
  from any channel/repo that promotes or derives from it, is searched for, fetched or read.

## Layout

```
lab-refs/<engineId>/<clipId>.wav    48 kHz, mono, 16-bit PCM, trimmed to the useful span
lab-refs/<engineId>/<clipId>.json   sidecar (schema below)
```

Nothing else goes in these directories: the score CLI loads every `*.json` it finds there.
Conversion is always `ffmpeg -i <download> -ac 1 -ar 48000 -c:a pcm_s16le <clipId>.wav`, followed
by a sample-exact trim. The download is YouTube format 251 (Opus, already 48 kHz, so nothing is
resampled) when the video offers it, otherwise format 140 (AAC, 44.1 kHz), which `-ar 48000`
resamples to 48 kHz. Two clips came from format 140: `mustang-dyno-a` and `f458-dyno-a` (see the
library table). One clip per source video, so that "independent clips" really are different
recordings.

## Sidecar schema

```jsonc
{
  "clipId": "rs3-onboard-a",                         // = file name, unique per engine
  "source": "https://www.youtube.com/watch?v=…",     // provenance only, never re-hosted
  "title": "…",                                      // video title as published
  "car": "Audi RS 3 Sportback (8V, 2016, …)",        // must belong to the engine's inspiredBy family
  "perspective": "cabin",                            // cabin | outside
  "segments": [
    { "kind": "wot", "startS": 5.4, "endS": 8.0, "rpm": [[0, 3280], [0.25, 3370], …, [2.6, 6000]] },
    { "kind": "liftoff", "startS": 17.2, "endS": 21.3, "rpm": [[0, 5250], [0.25, 5200], …, [4.1, 3370]] },
    { "kind": "idle", "startS": 21.25, "endS": 24.8, "rpm": [[0, 752], [3.55, 752]] }
  ],
  "notes": "…"                                       // provenance, identity evidence, screening numbers
}
```

- `startS`/`endS`: seconds in the trimmed WAV. Keyframe times are seconds **from the segment
  start** (first 0, last = segment length); rpm between keyframes is linear.
- `kind ∈ idle | cruise | wot | liftoff | limiter`:
  - `wot` — full load in one gear: a dyno pull, a dash showing 100 % torque (or 100 % power past
    the torque peak), or a steep in-gear rise with the cabin level up. Each segment ends at least
    0.1 s before the next 3 % rpm drop (gear change, lift, limiter bounce) and before any top-speed
    plateau.
  - `liftoff` — closed throttle **in gear**: rpm falling with the level dropped (engine braking,
    roller run-down), ending at least 0.1 s before the next 3 % rpm rise (rev-matching blip).
    Clutch-open falls and part-throttle declines are not liftoffs.
  - `cruise` — steady rpm (|slope| ≲ 100 rpm/s) at light load.
  - `idle` — stationary, engine idling, no blips, no beeps or clicks (transient scan below).
  - `limiter` — held on the rev limiter (none in the current library).
- Segment ends are checked with a comb track (0.12 s windows, 20 ms hop, wide search) around each
  end: the drop or rise is dated by the first frame 3 % off the running extreme, minus half a
  window. Smoothed tracks hide shifts that start in the last 0.1 s.
- `rpm`: every segment in the library carries **explicit keyframes** (see "rpm truth"). The
  contract also allows `"auto"` + `rpmHint` (pitch-tracked by `src/lab/pitch.ts`); the notes keep
  the numbers needed to switch a segment to `"auto"` later.
- `notes` records the evidence: car identity, microphone position, rpm checks, and one bracket per
  segment with the screening numbers defined below and, where needed, a spectrogram verdict.

## Acquisition procedure

1. **Search** with yt-dlp, one query per car × perspective × content type, e.g.
   `yt-dlp --flat-playlist -J "ytsearch10:Audi RS3 onboard acceleration sound"`, and the same for
   `exhaust sound flyby`, `POV drive`, `stock dyno`, `binaural`. Keep id, title, channel, duration.
2. **Shortlist from metadata** (`yt-dlp -j <id>`: title, description, chapters, tags):
   the right model/generation; stock or factory-optional exhaust (reject Akrapovič, Milltek,
   Capristo, iPE, Borla, straight pipes, "tuned", "stage 2", OPF delete, headers…); no narration
   ("review", "first drive", presenter channels) and no music bed ("Music by …" credits);
   prefer "no talking / no music / pure sound", binaural POVs, dyno baselines.
3. **Download audio only**, sequentially and politely: `yt-dlp -f 251/140 -x --audio-format wav
   --sleep-requests 1 -o <dir>/<id>.%(ext)s -- <id>`, 20-40 s pause between videos, each download in
   its own empty directory. Parallel bulk downloads trigger YouTube's "confirm you're not a bot"
   block (it happened once with ~90 parallel requests); one video at a time has never been blocked.
   Transient HTTP 403s are retried later. Note the format the log reports (251 or 140).
4. **Download the 360p video stream** (`-f 134/243/133`) of every candidate that survives a first
   look. Frames are the only way to verify the car, the microphone position, the tachometer and
   the dash's power reading.
5. **Analyse** (screening below), choose segments, trim, write the sidecar.

## Screening (listen-free)

Every accepted segment passes all of the following; the numbers go into the sidecar `notes`.

### Car and perspective, from frames

- The car in the frames (or the caption/dash) matches the engine's `inspiredBy` family across the
  **whole used span**. Example of why: a "stock RS3 dyno" video switches to a Porsche 911 for its
  last pull; that pull fits an inline-5 harmonic pattern by coincidence and would have passed every
  audio test.
- `cabin` = microphone inside a closed cabin: camera on the windscreen/dash/driver, binaural
  microphones worn by the driver, a passenger camera. Convertibles driven roof-down are rejected
  for cabin. `outside` = microphone outside the car: chassis-dyno cells, camera at exhaust height.
  Spans where the video cuts to drive-by or walk-around shots are excluded (scene cuts:
  `ffmpeg -vf "select='gt(scene,0.3)',showinfo"`).
- Where a dash shows power and torque, full load means 100 % torque, or 100 % power past the
  torque peak; power reads 94-96 % just after an upshift while torque is at 100 %. Example:
  `rs3-onboard-b` reaches 287 km/h at source 477 s, then both readings fall (power 94 %, torque
  88 % by 478 s) while the rpm stops rising; that top-speed plateau is not used. The gear readout
  changes about 0.2 s before the tach needle drops, which marks the shift.

### rpm truth

A four-stroke engine only radiates at multiples of half the crank rotation frequency, so the
**spacing Δ between adjacent spectral lines** gives rpm = 120·Δ directly (60·Δ if only integer
orders are present, which context resolves). Every segment's rpm is anchored by at least one of:

- half-order peak spacing of a 0.25 s spectrum (the most prominent peaks over a ±30 Hz median);
- the tachometer needle or digital rpm on screen, the dash's gear and speed (rpm = v / tyre
  circumference × overall ratio), the dyno screen's sweep range;
- for idle and steady cruise, 4 s FFTs of the firing line and its harmonics (about ±0.5 %).

Three trackers then follow the rpm between anchors, all with a Viterbi path (transition limited to
6000 rpm/s, linear cost inside):

| tracker | salience at candidate rpm r | known failure |
|---|---|---|
| contract | Σₕ₌₁..₈ h^-½·\|X(h·f_fire)\| + ½·Σ sub-orders k·step·r/60 | locks to 1/2, 3/5 or 3/8 of r when non-firing orders dominate (flat-plane V8 orders 2/6/10, cross-plane half orders, I5 under load) |
| contrast | Σₕ h^-½·(W(h·f_fire) − W((h−½)·f_fire)) on the whitened log spectrum | same as above |
| comb | mean over teeth k·step·r/60 in 50-2500 Hz of W(tooth) − mean W(tooth ± ½ spacing) | locks to 5× (I5) or 8× (V8) at idle/cruise, where only firing harmonics are present |

W = level in dB above the ±25 Hz local mean. A segment's final rpm is a **corridor track**: comb +
contract salience restricted to ±8 % around the anchor interpolation, which removes every ratio
ambiguity. The sidecar keyframes are that track, median-smoothed over 0.22 s and sampled every
0.25 s plus the segment end. Keyframes within 0.12 s of an edge come from a linear fit of the raw
track over the 0.25 s at that edge, because a one-sided median there leans towards the interior
(up to 6.6 % on the steepest pulls). There are two keyframes only when an idle or cruise track
stays within 2 % of its median. For idle and quiet cruise the keyframes are long-window
firing-line measurements instead (4 s FFTs, the firing order and its octave agreeing within 1 %).
Verification: an independent comb tracker (review) agrees with the keyframes within 2 % on
90-100 % of frames in every formerly tracked segment, and within 2 % on 94 % of the frames in the
first and last 0.25 s. It loses the engine in two keyframed liftoffs (`rs3-onboard-b` 46.0-55.7 s,
`rs3-dyno-a` 42.9-44.4 s), whose keyframes rest on the dash tach and on half-order spacing.

**Why keyframes everywhere.** The contract's sub-order term is ambiguous about how far the sum
runs, and T1's tracker had not landed when the library was rebuilt. Run inside each segment's
narrow hint `[⌊0.93·min / 50⌋·50, ⌈1.07·max / 50⌉·50]`, the contract tracker agrees with the
keyframes within 2 % on ≥ 90 % of frames in 43 of 53 segments when sub-orders are summed below the
firing order, but only in 40 when they run up to the 8th firing harmonic. Three segments that were
`"auto"` before fall to 0.42-0.83 that way (`mustang-onboard-b` wot 128.2-131.4 s,
`mustang-onboard-a` liftoff 132.1-135.4 s, `f458-onboard-a` wot 76.2-98.3 s). A whitened
(contrast) salience agrees with the keyframes on fewer than half of the frames in 34 of the 37 V8
segments, locking to sub-multiples. Explicit keyframes make every score
independent of the tracker. Each note records the **T1-method check** (contract salience inside the
narrow hint, both readings) and the comb/contrast agreement; a segment may be switched to `"auto"` with
that hint only after T1's `trackRpm`, run inside it, agrees with the keyframes within 2 % on ≥ 90 %
of frames. Keep the hint lower bounds: they are what stops the firing-harmonic tracker from
dropping to a sub-multiple.

### Tracking quality

- Confidence: the contract's T1 confidence, salience(best) / Σ salience over the grid, per frame,
  recorded for both readings of the sub-order sum (`conf a (p90-norm b) / all8 c (p90-norm d)`).
  The contract rule is a median of at least 0.6 after normalising by the single best frame, and it
  is not attainable even by renders with known rpm. On the Phase 2a fixture renders
  (`i5-test`, `v8-crossplane-test`, `v8-flatplane-test`; `wotPull` and `liftoff6k`, cabin and
  outside), the contract tracker run over 0.7·idle to 1.05·limiter gives, with sub-orders below the
  firing order:
  - WOT pulls tracked correctly (median error 0.2-0.5 %): best-frame medians of only 0.54-0.66,
    three of five below 0.6; p90-normalised medians 0.69-0.80;
  - failed tracks of the quiet liftoff renders (31-63 % error): p90-normalised 0.41-0.52;
  - one flat-plane cabin pull tracked at half rpm: 0.62, or 0.75 p90-normalised, so neither rule
    catches it; that is what the anchored corridor track is for.

  **Pending a contract amendment**, the library screens on the median after normalising by the
  segment's **90th-percentile frame** (≥ 0.6). Every segment passes that: 0.63-0.98 (below) and
  0.71-0.99 (all8). Seven segments fail the literal rule:
  - with sub-orders below the firing order, six: `rs3-dyno-a` wot 32.6-42.6 s (0.55) and liftoff
    42.9-44.4 s (0.55), `rs3-dyno-b` wot (0.53), `f458-dyno-a` both wots (0.53, 0.55) and
    `f458-dyno-b` liftoff (0.48);
  - with sub-orders up to the 8th firing harmonic, one: `f458-onboard-b` wot 2.0-3.7 s (0.59).

  Dropping the first six would leave the i5 and 458 outside perspectives with one clip each.
- `harm`: median over frames of the mean whitened level of firing harmonics 1-4 (dB), at the
  keyframe rpm. Accepted segments have 3.9-11.3 dB; overruns, idle and quiet cruise are the lowest.
- Tracker agreement (fraction of frames within 2 % of the keyframes), recorded per tracker.

### No voice-over, no music

Measured on the segment at 48 kHz unless stated:

| metric | definition | pass |
|---|---|---|
| `vmod` | RMS of the 2-8 Hz (syllable-rate) component of L(300-3000 Hz) − L(30-300 Hz), dB (2048-point Hann frames, 10 ms hop) | ≤ 3.5 dB |
| `envFluct` | RMS of L(300-3000 Hz) minus its 0.5 s moving average, dB | ≤ 6 dB |
| `sfm300-3k` | spectral flatness (geometric/arithmetic mean power) per ⅓-octave band 315 Hz-2.5 kHz, averaged | ≥ 0.45 |
| `tonal` | distinct **off-grid tonal lines** 150-5000 Hz per max(segment length, 10 s) (below) | ≤ 0.1 /s |
| `beeps`, `clicks` | transient scan, idle and cruise segments (below) | 0 |

Voice-over **lowers** the 300-3000 Hz flatness (the contract's "flatness below threshold" is the
voice condition) and raises `vmod` and `envFluct`.

#### Off-grid tonal test (`tonal`)

The contract's "no music: tonal non-harmonic peaks", made independent of whether the rpm moves.
A four-stroke engine only radiates on the half-order grid f = m·rpm/120 (m = 1, 2, …), so a
narrow, persistent line that is off that grid at the segment's verified rpm (its keyframes) is not
engine sound:

1. **Frames.** Signal decimated to 12 kHz; Hann window T per segment, hop T/4, FFT zero-padded 4×.
   T is the value in {0.1, 0.15, 0.2, 0.3, 0.5, 1} s that maximises the covered part of 150-5000 Hz
   (steps 4-5) minus 0.1·log2(T / 0.1 s). A longer window must therefore add more than 10 %
   coverage per doubling, which keeps short events visible. Idle and cruise use T ≥ 0.5 s so the
   half-order grid is resolved (5.6-6.3 Hz at idle). In the current library T is 0.3-0.5 s on wot
   and liftoff segments and 1 s on idle and cruise.
2. **rpm per frame.** The keyframe rpm refined within ±3 %, from the firing harmonics 1-4 (parabolic
   peaks) or from a half-order harmonic sum of the whitened spectrum, whichever is more
   self-consistent. Its precision u is the spread between the estimates, bounded to 0.1-1 %.
3. **Tonal peaks** in 150-5000 Hz:
   - at least 15 dB over the median level within ±max(100 Hz, 2.5 grid spacings), where noise
     periodogram bins exceed 15 dB with p ≈ 3·10⁻¹⁰;
   - −6 dB width ≤ 3/T, which excludes engine lines smeared by a sweep;
   - not a Hann sidelobe of a stronger neighbour (sidelobe envelope −31.5 dB at 2.5/T, falling
     18 dB per octave).
4. **Grid test.** Spacing sp = rpm/120; distance d to the nearest m·sp; tolerance
   tol = 0.5/T + f·u + f·|dr/dt|·T/(2·rpm), covering resolution, rpm precision and in-window sweep.
   The slope is the larger of the keyframe slope and the measured one. The peak is *decidable* when
   tol ≤ 0.35·sp, and *off-grid* when d > tol.
5. **Smear test (sweeps).** Where engine lines sweep over at least 4× the narrow-peak width within
   one window (f·|dr/dt|·T/rpm ≥ 12/T), a narrow peak more than 0.15 sp from the instantaneous grid
   is a tone that does not move with the rpm. A windowed chirp's −6 dB width is half its sweep;
   this test uses the smaller of the two slopes.
6. **Lines.** Off-grid peaks are linked into tracks: at least 3 frames and 0.1 s, gaps up to 0.3 s
   bridged. Fixed-frequency tracks within max(2/T Hz, 1.5 %) are one line however far apart; a
   semitone is 5.9 %. **tonal = lines / max(segment length, 10 s).** Each line is reported with
   frequency, class, duration and prominence. Classes:
   - *stationary*: fixed while the rpm moves ≥ 2 %;
   - *rpm-locked*: fixed order;
   - *steady*: fixed, but the rpm is steady too;
   - *gliding*: anything else.

The covered part of 150-5000 Hz is recorded per segment as `classified … Hz (…%)`. Current
library: wot 91-100 % (median 96 %), liftoff 78-100 % (94 %), cruise 39-100 %, idle 2-7 %. At idle
the test decides only up to 220-470 Hz, because the grid is 5.6-6.3 Hz wide and idle speed wanders
±0.3-0.5 % within a second.

#### Transient scan (`beeps`, `clicks`)

Idle and cruise segments, where the grid is too dense to judge short tones:

- **beep**: 10 ms frames (50 ms Hann) whose strongest bin in 400-3000 Hz is ≥ 25 dB over the
  ±150 Hz median and holds the same bin for ≥ 3 frames;
- **click**: energy above 1.5 kHz ≥ 15 dB over the segment median.

Idle and cruise segments are cut so both counts are 0. This removed:
- six ~660 Hz touchscreen beeps (up to 39 dB over the ±150 Hz median) from `mustang-onboard-b`'s
  idle;
- 19 regular clicks (20-28 dB above the high-band median, 1-4 s apart) from `rs3-onboard-c`'s idle
  chapter, of which the segment is now the longest click-free stretch;
- two clicks (37 and 19 dB) from `mustang-onboard-a`'s idle.

#### Tolerated non-engine tones

A segment with any off-grid line is reviewed in a spectrogram with the half-order grid of its
keyframes drawn over it, and the verdict is written next to its screening bracket. Kept and
recorded (within the 0.1 /s limit):

- **tyre-cavity resonance**: one fixed line while rolling, which does not move with the engine
  lines. In the library it is 213-216 Hz, 15-23 dB over the local median, in two S650 cabin clips
  (`mustang-onboard-c` cruise, `mustang-onboard-a` liftoff).
- **HVAC blower, fuel pump, dyno-cell fans**: fixed lines (none found in the current segments).
- **gear or accessory whine and turbo whistle**: engine-related but off the half-order grid; whine
  shows as an rpm-locked line at a non-half-integer order (none found).
- **isolated short peaks** (≤ 0.6 s) on the shoulder of a strong engine line or in road noise (two:
  `rs3-dyno-a` wot 1.2-11.6 s, `rs3-onboard-a` cruise 35.8-39.7 s).

Not tolerated: UI beeps, chimes and clicks in idle and cruise segments (cut around them), and any
music or voice.

#### Calibration and limits

Threshold calibration has two parts. Standalone windows of known content are analysed against a
nominal grid, since music and voice are on no engine grid. Mixtures add an interferer to eight
clean library segments at −20/−10/0 dB relative to the segment's 300-3000 Hz level:
- idle: `mustang-onboard-b`;
- cruise: `rs3-onboard-a`, `mustang-onboard-c`;
- slow dyno pull: `rs3-dyno-b`;
- fast cabin pull: `mustang-onboard-a`;
- liftoff: `f458-onboard-b`;
- Autobahn pull: `f458-onboard-a`;
- dyno pull: `f458-dyno-a`.

| content | standalone | in mixtures (segments flagged of 8 at −20 / −10 / 0 dB) |
|---|---|---|
| sustained music bed (chord/melody intro of a review video) | tonal 0.96 /s on a 3000 rpm grid, 0.05 /s on a 750 rpm idle grid (undecidable); vmod 3.2 dB | tonal: 2 / 5 / 8; vmod/envFluct: 0 / 0 / 0 |
| percussive music (channel outro, drums) | tonal 0.00 /s; vmod 5.1 dB, envFluct 4.3 dB | tonal: 0 / 0 / 3; vmod/envFluct: 0 / 0 / 3; either: 0 / 0 / 4 |
| narration (binaural POV, engine idling below the voice; a review over a music bed) | vmod 5.4-6.9 dB, envFluct 9.7-11.0 dB; tonal ≤ 0.29 /s | tonal: 0 / 0 / 0; vmod/envFluct: 0 / 0 / 1 |
| UI beeps (the cut-off part of `mustang-onboard-b`'s idle) | transient scan 6 beeps at 660 Hz; tonal 0 (above the decidable idle band) | — |
| clean library segments | — | tonal 0-0.05 /s |

Read the table as follows:
- The test catches a sustained music bed 10 dB below the engine wherever the grid is resolvable
  (cruise, slow and dyno pulls, Autobahn pulls), and at equal level in fast pulls, liftoffs and at
  idle.
- Percussive music and voice are not tonal. Narration that dominates a recording fails `vmod` and
  `envFluct`, and drums at the engine's level fail one check or the other in half the segments.
  Voice mixed at or below the engine level, and drums 10 dB below it, pass every automatic check.
- So the metadata screen (no-talking channels, chapters, credits) and the spectrogram check of
  every accepted segment remain mandatory. In a spectrogram, speech shows as gliding harmonic
  stacks with syllable gaps, and music as steady horizontal lines and beats.

## Rebuilding a clip

1. Download the source audio as above and convert to 48 kHz mono 16-bit.
2. Cut `[trim start, trim end)` from the library table (sample-exact: `round(t·48000)`).
3. Mark the segments from the segment list below; re-derive the keyframes with the corridor
   procedure ("rpm truth") and check them against the listed rpm ranges. The local sidecar, if it
   still exists, has the exact keyframes and notes.

## Library (2026-10-13)

Requirement (Phase 2b contract): at least 2 independent clips (different videos, ideally
different cars) per perspective per pilot engine. Trim = source-video seconds kept in the WAV.
Format = YouTube audio format downloaded (251 Opus 48 kHz, or 140 AAC 44.1 kHz resampled).

| engine | clip | perspective | car | microphone | source | format | trim (s) | segments |
|---|---|---|---|---|---|---|---|---|
| `i5-turbo-25` | `rs3-onboard-a` | cabin | RS 3 Sportback 8V (2016) | windscreen camera | <https://www.youtube.com/watch?v=Ho34caoeT2o> | 251 | 238.00-300.50 | 3 wot, 2 cruise, 2 liftoff |
| `i5-turbo-25` | `rs3-onboard-b` | cabin | RS 3 Sportback 8Y (2022) | dash camera (tach) | <https://www.youtube.com/watch?v=k4SCpXBSruk> | 251 | 441.00-497.30 | 3 wot, 1 liftoff |
| `i5-turbo-25` | `rs3-onboard-c` | cabin | RS 3 8Y facelift (2025) | binaural (driver) | <https://www.youtube.com/watch?v=9eQmBZpeawk> | 251 | 184.00-222.00 | 1 idle |
| `i5-turbo-25` | `rs3-dyno-a` | outside | RS 3 sedan 8V (2018 US), stock | dyno cell | <https://www.youtube.com/watch?v=hiCDg22RnLg> | 251 | 15.00-61.00 | 2 wot, 1 liftoff |
| `i5-turbo-25` | `rs3-dyno-b` | outside | RS 3 Sportback 8V, stock | dyno cell, tailpipe height | <https://www.youtube.com/watch?v=2mvqRs2s8VE> | 251 | 13.00-38.50 | 1 wot |
| `v8-na-50` | `mustang-onboard-a` | cabin | Mustang GT S650 (2024) 6MT | binaural (driver) | <https://www.youtube.com/watch?v=H09A6zhUy3Y> | 251 | 115.00-334.00 | 1 idle, 5 wot, 4 liftoff |
| `v8-na-50` | `mustang-onboard-b` | cabin | Mustang GT S650 (2024) 10AT | binaural (driver) | <https://www.youtube.com/watch?v=lWJ7lIjBsok> | 251 | 150.00-346.00 | 1 idle, 6 wot |
| `v8-na-50` | `mustang-onboard-c` | cabin | Mustang GT S650 (2024) 6MT | driver POV camera | <https://www.youtube.com/watch?v=QqwdLXkrxRk> | 251 | 546.00-610.00 | 2 cruise |
| `v8-na-50` | `mustang-dyno-a` | outside | Mustang GT S550 (2015), stock | dyno cell | <https://www.youtube.com/watch?v=FvX5M3eqJic> | 140 | 14.50-26.00 | 1 wot |
| `v8-na-50` | `mustang-dyno-b` | outside | Mustang GT S550 (2016) 6MT, stock | dyno cell | <https://www.youtube.com/watch?v=paJA5mV3qMw> | 251 | 13.50-25.50 | 1 wot |
| `v8-flatplane-45` | `f458-onboard-a` | cabin | 458 Italia | tach close-up camera | <https://www.youtube.com/watch?v=X0yiRilcKME> | 251 | 85.30-206.50 | 5 wot |
| `v8-flatplane-45` | `f458-onboard-b` | cabin | 458 Italia | dash camera | <https://www.youtube.com/watch?v=3Z1szmKp59M> | 251 | 44.00-174.00 | 4 wot, 3 liftoff |
| `v8-flatplane-45` | `f458-dyno-a` | outside | 458 Spider (2014), stock baseline | dyno cell | <https://www.youtube.com/watch?v=XwzmCrkcNOY> | 140 | 20.50-77.00 | 2 wot |
| `v8-flatplane-45` | `f458-dyno-b` | outside | 458 Italia (2012) | dyno cell, exhaust height | <https://www.youtube.com/watch?v=cLihUpXzods> | 251 | 2.00-15.00 | 1 wot, 1 liftoff |

### Segments

Seconds in the trimmed WAV (source time = trim start + WAV time), the rpm range of the keyframes,
and where the keyframes come from: *track* (corridor track, 0.25 s keyframes) or *FFT*
(4 s firing-line measurements). 53 segments, 310 s; all carry keyframes.

| clip | segments |
|---|---|
| `rs3-onboard-a` | wot 5.40-8.00 (3280-6000, track) · wot 8.70-10.00 (4560-5470, track) · cruise 10.80-15.60 (4000-4170, track) · liftoff 17.20-21.30 (3370-5250, track) · cruise 35.80-39.70 (3570-3840, track) · wot 50.40-52.50 (3920-5810, track) · liftoff 57.50-59.60 (4100-5400, track) |
| `rs3-onboard-b` | wot 2.90-7.20 (5360-6700, track) · wot 8.30-21.05 (5350-6750, track) · wot 22.00-36.00 (5570-6060, track) · liftoff 46.00-55.70 (4280-5540, track) |
| `rs3-onboard-c` | idle 21.25-24.80 (752, FFT) |
| `rs3-dyno-a` | wot 1.20-11.60 (3880-5740, track) · wot 32.60-42.60 (3920-6940, track) · liftoff 42.90-44.40 (5040-6910, track) |
| `rs3-dyno-b` | wot 2.60-24.50 (2080-6820, track) |
| `mustang-onboard-a` | idle 8.00-18.00 (748, FFT) · wot 114.95-116.10 (4930-7290, track) · wot 117.35-119.85 (5020-7340, track) · liftoff 121.20-131.00 (3330-5090, track) · liftoff 132.10-135.40 (3080-4200, track) · wot 187.90-189.25 (4520-7250, track) · liftoff 190.10-194.40 (3380-7060, track) · wot 207.30-209.60 (4710-7430, track) · wot 210.70-212.80 (5290-7150, track) · liftoff 213.30-218.50 (4450-7040, track) |
| `mustang-onboard-b` | idle 2.80-11.35 (676, FFT) · wot 128.20-131.40 (2910-6650, track) · wot 132.00-133.00 (5510-6420, track) · wot 149.00-152.25 (4250-7420, track) · wot 152.90-154.50 (5970-7430, track) · wot 188.50-192.90 (3830-7010, track) · wot 193.40-194.65 (6160-6950, track) |
| `mustang-onboard-c` | cruise 2.00-10.00 (2024-2118, FFT) · cruise 42.00-62.00 (2042-2123, FFT) |
| `mustang-dyno-a` | wot 1.70-10.30 (2970-6830, track) |
| `mustang-dyno-b` | wot 1.50-10.90 (2760-6270, track) |
| `f458-onboard-a` | wot 1.10-3.70 (5770-8730, track) · wot 4.60-6.60 (7610-8950, track) · wot 7.60-10.50 (7470-8520, track) · wot 76.20-98.30 (5050-7140, track) · wot 99.30-121.00 (6740-8050, track) |
| `f458-onboard-b` | wot 2.00-3.70 (5180-9180, track) · liftoff 20.00-22.20 (6310-7910, track) · liftoff 25.15-26.75 (4550-6440, track) · wot 31.00-32.45 (7300-8810, track) · wot 32.90-34.70 (7290-8480, track) · liftoff 34.90-37.20 (5730-8480, track) · wot 128.00-129.00 (7420-8980, track) |
| `f458-dyno-a` | wot 1.00-8.60 (4230-9050, track) · wot 47.50-55.60 (3660-9070, track) |
| `f458-dyno-b` | wot 1.20-7.70 (3490-8750, track) · liftoff 8.30-12.30 (3860-7200, track) |

Coverage notes: every perspective of every pilot has at least two independent clips (different
videos and different cars). Kinds still missing: idle and cruise for the 458 cabin and for all
outside perspectives, and limiter everywhere; clips found for them so far were narrated, roof-down,
of an unconfirmed variant, or only had idle in 1-2 s gaps between free revs. Rejected after
screening (examples): an RS3 dyno video whose last pull is a Porsche 911, a narrated binaural 458
POV, a roof-down 458 Spider POV, aftermarket-exhaust and tuned cars by title or description.

Family judgements: the RS 3 8V (2015-2020) and 8Y share the EA855 2.5 TFSI five-cylinder family
with the modelled 8Y; the 2015-2016 Mustang GT (S550, Gen 2 Coyote) shares the Coyote 5.0 family
with the modelled S650 (Gen 4); the 458 Spider shares the 458 Italia's F136 FB engine and exhaust
and is used only for an outside (dyno) clip. Pure cabin clips of the 458 are Italia coupes.

## Scoring and auto-tuning

- `npm run score -- <engineId> [--gate] [--refs lab-refs] [--out renders/score]` renders the engine's
  test segments, measures them against every usable clip in `lab-refs/<engineId>/` and writes
  `report.md`, `report.json` and plots to `renders/score/<engineId>/`. `--gate` exits 1 when a gate
  or discrimination fails. Discrimination compares against every other engine that has references
  in `--refs`: point `--refs` at a folder holding only the tuned engines' libraries (symlinks work)
  while other libraries are still being built.
- `npm run tune -- <engineId> [--strategy cmaes|nm] [--iterations N] [--workers N] [--seed 1]
  [--refs …] [--out renders/tune] [--apply]` searches the voicing parameters against the same score.
  The default CMA-ES (60 generations, a coordinate polish afterwards) evaluates candidates on
  `--workers` threads (default: cores − 2, at most 16) and gives the same result for any worker count;
  `nm` is the original Nelder–Mead search. `--apply` writes the best voicing into
  `src/data/engines/<engineId>.json` with `estimated: true`; then add the engine's
  `Tuned voicing: <engineId>` line to `docs/sound-scores.md`.

## Lab UI

The Sound Lab page (`/lab/`, phase-2c contract) is for listening to the engines and hand-tuning a
voicing between score runs. It is a desktop tool: the app never links to it, its files are not in
the app's offline cache, and it runs the same DSP core and output stage as the car (no SimCore).

### Opening it

- Development: `npm run dev`, then `http://localhost:5173/lab/`.
- Built: `npm run build && npm run preview`, then `http://localhost:4173/lab/`.
- Deployed: `https://tesbox.example.com/lab/` (your own host; `/lab` redirects to `/lab/`).

Use a desktop Chromium-based browser. Press **Start audio** (it also resumes audio the browser
suspended); the status line shows the sample rate once the lab worklet is ready.

### Controls

- **Header:** engine (all 15: generic title, "inspired by" subtitle), View **Cabin | Outside**, Tier
  **Full | Lite**, Bass **No sub** (the app's default output stage) **| Sub**.
- **Meter:** the rpm and gear the core renders, RMS and true peak of the output stage before the
  monitor level (the −1 dBTP ceiling is marked), limiter gain reduction, boost and non-finite resets.
  **Monitor level** (−40…0 dB, default −12) sets the listening level of both A and B.
- **Drive:** RPM (idle…limiter), Load (−1…1; below 0 is overrun), Gear, Valve, Drive mode, Warm
  engine. Events: **Upshift** (shift from the current rpm by the ratio step), **Downshift**
  (rev-matched blip, capped at the limiter), **Lift-off** (load 0; the load control drops to 0 with
  it), **Limiter** (toggles a hold bouncing off the limiter), **Ignition** (toggles; switching on
  restarts the warm-up). **Segment** + **Play** loops one of the render/score segments
  (`tools/segments.ts`: idle, cruise2k/4k/6k, wotPull, liftoff6k, limiterHold, autoShiftPull) in
  place of the manual controls; **Stop** returns to them. Events and segments need running audio.
- **Keys:** ↑/↓ rpm ±100, W/S load ±0.05, E/Q shift up/down, Space lift-off, L limiter, B A/B. They
  never act while you type in a number box or a select, and a focused slider keeps its arrow keys.
- **Voicing:** built from `engine.schema.json` `$defs.voicing`: a slider and a number box per number
  over the schema range (pulse.alpha and pulse.beta, which have no schema maximum, use the auto-tuner's
  ranges 3–20 and 1–10), one control per array element (lengths are fixed), turbine and
  forcedInduction only on engines that have them, booleans as checkboxes, and `estimated` read-only.
  Sliders act as you drag; a number box applies on Enter or when you leave it. The engine picks up an
  edit 120 ms after the last change, behind the core's 300 ms fade out and in. A voicing that fails
  the schema or the core's own capacity check (for example a header longer than 1.5 m, which the
  schema allows) is flagged with the reason, its field turns red, and it is not sent until fixed.
  **Reset to engine** restores the shipped JSON; **Reset to default voicing** applies
  `defaultVoicing(spec)`.

### A/B against a local clip

1. Under **Reference clip**, pick a local recording — any format the browser decodes (WAV, MP3,
   FLAC…), typically one of your `lab-refs/<engine>/` clips. It is decoded inside the page and loops
   on side B; it is never uploaded (no request carries it) and nothing is kept after you close the tab.
2. Put the lab in the clip's situation: the clip's perspective, its rpm and load, or the matching
   segment.
3. **Match level** turns the louder side down to the quieter side's RMS (the clip: its whole-clip
   RMS; the lab: the meter's RMS over the last second), so you compare at equal loudness.
4. **A/B** (or the B key) crossfades in 30 ms between the lab (A) and the clip (B).

### Export → engine file

1. **Download JSON** saves `<engineId>.voicing.json`, `{ "engineId": …, "voicing": … }`: the current
   voicing, schema-validated, with `"estimated": true`. **Copy JSON** puts the same text on the
   clipboard; **Show the JSON** displays it.
2. Replace the `voicing` object in `src/data/engines/<engineId>.json` with the file's `voicing`.
3. Record the engine as tuned in `docs/sound-scores.md` with a `Tuned voicing: <engineId>` line
   (tests/unit/engines.test.ts holds every engine without one to `defaultVoicing`), then run
   `npm test` (schema and DSP invariants) and `npm run score -- <engineId>` to record its scores.
4. `estimated` stays `true` until the user's listening sign-off; only that sign-off flips it to
   `false`, by hand in the engine file. The lab never writes `false`.

**Import JSON** loads such a file back (switching to the engine it names). A file whose shape,
voicing schema or fit to that engine's DSP check fails is refused with the reason, and nothing
changes.
