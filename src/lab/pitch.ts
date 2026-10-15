/**
 * Engine-speed (rpm) tracking for reference clips — phase 2b contract "Pitch / RPM tracking (T1)" as amended by
 * D1 and D4, spec §11.2 (`"auto"` = pitch-track of the known firing pattern). Environment-free (Node + browser): no
 * DOM, Web Audio or Node APIs. Analysis code may allocate. Deterministic: the same input gives a bit-identical track.
 *
 * Method (textbook harmonic summation + Viterbi smoothing, implemented from first principles):
 *  1. Frames of `winS` (Hann, frame mean removed) every `hopS`; FFT (analysis.fft, two real frames per complex
 *     transform) zero-padded to the next power of two ≥ 4 × the window, computed on a low-passed, decimated
 *     copy when every bin read lies far below Nyquist — same window, same bin spacing, smaller FFT; see
 *     MAX_DECIMATION and `decimate`.
 *  2. Clamped per-bin contrast (D1.1) C⁺(f) = max(0, |X(f)| − mean |X| over f ± CONTRAST_HALF_WIDTH / winS): an
 *     absent line contributes 0, never a penalty.
 *  3. Candidate rpm every RPM_GRID_STEP in [rpmMin, rpmMax]; with b = rpm / 60, f_fire = b · firingsPerRev and
 *     M = firingsPerRev / subOrderStep:
 *       salience = Σ_{h=1..8} h^−½ · C⁺(h · f_fire) + 0.5 · ρ · Σ_{k=1..M−1} C⁺(k · subOrderStep · b)
 *     where ρ ∈ [0, 1] gates the sub-order bins by resolvability (SUB_RESOLVE_*).
 *  4. Level L = mean |X| over 20 Hz – 2 kHz of the frame (D1.2), independent of the search range. A frame
 *     carries evidence when some candidate reaches salience / L > VOICING_FLOOR; its Viterbi emission is then
 *     max(0, salience / L − EMISSION_FLOOR) per candidate, else 0 everywhere.
 *  5. Viterbi over frames: transition cost ∞ beyond maxStep = ⌊maxSlewRpmPerS · hop / RPM_GRID_STEP⌋ grid steps
 *     and linear inside, SLEW_COST per frame for a change at SLEW_COST_RATE rpm/s (a slew below one grid step
 *     per hop is rejected: the grid cannot represent it). O(frames × candidates) via sliding-window maxima.
 *  6. No silent fallback (D1.3): a frame reports the tracked rpm only when that rpm's own salience / L clears
 *     VOICING_FLOOR — so in particular every frame without any candidate above the floor — else rpm = NaN and
 *     confidence = 0. A segment without a voiced frame is all NaN; callers skip it.
 *  7. confidence = salience(tracked rpm) / Σ salience over the grid, normalised to [0, 1] by the best frame.
 *
 * Usage and acceptance (D4). The tracker runs only on reference clips, whose sidecars carry hints, and the score CLI
 * asks for its options through trackOptionsForSegment: an idle, cruise or limiter segment must carry an rpmHint no
 * wider than ±15 % around its centre (RangeError otherwise, D4(1)); a wot or liftoff sweep takes its range hint, or the
 * engine's idle..limiter without one, and relies on the Viterbi continuity constraint (D4(2)). trackRpm itself is
 * generic and searches any range. Accepted by the tests on every cell D4(3) names — the five fixture engines' renders
 * (steady kinds inside ±7 % and ±15 % hints, sweeps with their range hint and with none, subwoofer yes and no, cabin and
 * outside) and the synthetic stacks of firing harmonics 2..8 for amplitude laws flat … h^−2 inside ±7 % and ±15 % hints:
 * never confidently wrong (every frame at confidence ≥ 0.5 within ±6 % of the true rpm), with median |error| ≤ 2 % over
 * the voiced frames. Unvoiced frames are allowed and reported, not gated, except a voiced share ≥ 0.4 on non-rotary
 * wotPull (D4(4)).
 *
 * Choices the contract leaves open (each measured on the Phase 2a fixture renders and on noise; see the tests):
 *  - The sub-order k range is k < M: the cycle orders below the firing order (none is a multiple of M). With
 *    every non-firing half (third) order up to the 8th firing harmonic instead, 13 more of the 120 render cells of
 *    D1.4's matrix fail (136 octave errors): dozens of 0.5-weight bins outweigh the eight harmonic teeth.
 *  - Sub-order bins closer together than the window resolves only re-sample one line's main lobe, so their
 *    weight ρ ramps from 0 (spacing ≤ 2.5 / winS) to 1 (spacing ≥ 4 / winS, where the midpoint between two
 *    bins lies outside the Hann main lobe of half-width 2 / winS).
 *  - The local mean spans ± 2.5 / winS (± 21 Hz at 0.12 s): the line's own main lobe and a little more. Wider
 *    means let a dominant line mask its neighbours (with the 40 Hz no-subwoofer high-pass, i5-test and
 *    rotary-test idle then lock to 2 ×); narrower ones shrink every line's contrast towards the noise.
 *  - Voicing and emission (salience / L of the best candidate per frame, measured): white noise 2–5, pink and
 *    600 Hz-low-passed white or pink noise 4–12 (medians 4–6.5), the fuel-cut overruns of the fixture renders
 *    ≤ 10.3, firing frames of the renders mostly 10–60 (rotary-test above ≈ 4500 rpm only 3–12).
 *    VOICING_FLOOR = 12 lies above all of these noise frames; EMISSION_FLOOR = 5 is about their median, so
 *    emissions count evidence above the noise and a weak but genuine stretch still steers the path. A frame is
 *    reported only when its tracked rpm itself clears the floor: a frame where only an off-path candidate does
 *    (junk combs of fixed resonances — up to 12.3 in the rotary limiter bounce), or that the path merely carries
 *    through a weak stretch (it holds its rpm when nothing pulls), reads NaN instead of a value no evidence
 *    supports.
 *  - The transition cost is independent of maxSlewRpmPerS, which only bounds the step: a wider bound lets the
 *    path follow a gear change without making every move cheaper.
 *
 * Limits (each measured). The confidence flags none of the octave locks in the first three items — every frame of a
 * lock is voiced, at confidence 0.95–0.99 on the synthetic stacks — so the search range is the remedy: no multiple
 * k ≥ 2 or k ≤ ½ of the rpm fits inside a hint whose upper bound is below twice its lower bound, as in every steady-kind
 * hint of at most ±15 % (1.15 / 0.85 < 2). The three items arise in wide idle..limiter searches of idle segments,
 * which D4(5) puts out of scope (bass-limited idle spectra can lock at 2–3 ×) and the score CLI cannot request (D4(1));
 * their cells are not part of the acceptance, and inside ±7 % and ±15 % hints every one of them tracks within one grid
 * step of the truth:
 *  - The salience cannot tell rpm from 3 × rpm when the 3rd firing harmonic dominates and the fundamental is
 *    missing: i4-test idle rendered without subwoofer (40 Hz high-pass + virtual bass, which adds T2/T3 of the
 *    25 Hz firing line) is tracked at 2240–2250 instead of 750 rpm over idle..limiter, every frame voiced, in the
 *    cabin and outside.
 *  - Without the fundamental, a steep spectrum locks at 2 × rpm: the 2 × candidate puts its weight-1 tooth on the
 *    dominant 2nd harmonic, which the true comb weighs 2^−½, and the odd harmonics that only the true rpm explains
 *    add too little. Where the harmonics lie 25 Hz apart (an I4 idle), the main lobes of both neighbours reach into
 *    the ± 21 Hz local mean, so every harmonic between two others keeps only ≈ 40 % of its magnitude as contrast,
 *    against ≈ 55 % for the 2nd, which has none below it (≈ 54 % and 59 % at 30 Hz). Over idle..limiter, stacks of
 *    firing harmonics 2..8 lock at 2 × for an I4 at 750 rpm from amplitude h^−1.2 on (800 rpm: h^−1.5; 900 rpm:
 *    h^−1.75), and for an I5 at 850 and a V8 at 650 rpm at h^−2. With the fundamental present (harmonics 1..8) every
 *    one of them tracks at 1.000 ×.
 *  - A candidate at M × rpm (M = firingsPerRev / subOrderStep) has its M − 1 sub-order bins on the firing harmonics
 *    1..M−1 of rpm and its weight-1 tooth on the M-th, so where the sub-orders of rpm itself are unresolved (idle)
 *    it competes with the truth. For a V8 (M = 8) searched over idle..limiter it wins when the low firing harmonics
 *    are weak or the spectrum is flat: 650 rpm stacks of firing harmonics 2..8 lock at 5200 rpm for every amplitude
 *    law from h^−0.95 to flat, and so does a flat 1..8 stack; amplitude 1/h stays within 1 % of the tie. I4 and I5
 *    (M = 4, 5) show no M × lock for any amplitude law from flat to h^−2.
 *  - Steady stacks whose firing fundamental lies below ≈ 35 Hz and dominates the comb can be tracked one or two grid
 *    steps high, up to 3 %: I4 at 650–1000 rpm and I5 at 650–800 rpm with harmonics 1..8 at h^−1.5 to h^−3 (an I4 at
 *    650 rpm also at 1/h), on grids that contain the true rpm.
 *  - A comb at ½ × rpm lands its teeth on every even crank order of a V8 (a flat-plane V8's exhaust is dominated by
 *    order 2: each bank fires every 180°), so where ½ × lies in the search range it can win: the outside dyno clip
 *    f458-dyno-a of the reference library is tracked at ½ × in 211 of its 240 voiced frames even inside T7's hint
 *    around its keyframes, at a median confidence (0.79) as high as that of correctly tracked clips. A hint whose
 *    lower bound exceeds half its upper bound removes the ambiguity — every steady-kind hint does; a sweep's range
 *    hint (D4(2)) that spans 2 : 1 or more keeps it.
 *  - Inside a narrow hint the confidence says little: every candidate's comb sits on nearly the same lines, so
 *    salience(best) / Σ salience varies little across the hint, and after the per-clip normalisation every voiced
 *    frame of the hinted idle and cruise renders reads ≥ 0.5 (median 0.90, 5th percentile 0.71). There, D4(3) asks
 *    every voiced frame to lie within ±6 %, which the fixture renders and synthetic stacks meet; on real references,
 *    though, fixed lines and road noise between the firing harmonics can pull single frames to the edge of the hint.
 *    On mustang-onboard-a's idle (±7 % hint around 748 rpm) 17 of 494 voiced frames read 696 or 796 rpm, at
 *    confidence 0.73–0.92, while its firing fundamental stays at 742–755 rpm in 0.5 s spectra; on the first cruise of
 *    mustang-onboard-c four isolated voiced frames read 1926–1936 against 2066 rpm, at confidence 0.77–1.00. T7
 *    switches a sidecar segment to "auto" only where the tracker agrees with its keyframes within 2 % on ≥ 90 % of
 *    frames (docs/SOUND_LAB.md), which neither segment does.
 *  - Brown (−6 dB/octave) noise — road and wind rumble — reaches salience / L ≈ 6–23, so on noisy references part
 *    of the noise counts as evidence; a narrow sidecar rpmHint range limits the harm.
 *  - Where an engine has a single in-band harmonic no stronger than fixed resonances, the track is unvoiced rather
 *    than wrong: rotary-test wotPull above about 4500 rpm, where salience / L at the true rpm (median 4–6) lies
 *    below VOICING_FLOOR and below combs ≥ 6 % away, also inside a ±7 % hint (0–8 of its 373 scored frames voiced),
 *    and its limiter hold (none voiced). D4(4) leaves rotary voicing ungated, and rotary references may carry explicit
 *    keyframes from a visible tach instead of "auto". The fuel-cut overrun of a liftoff carries nothing rpm-locked
 *    and is unvoiced as well.
 *  - The voicing floor is absolute (D1.2), so a clean but weak comb stays unvoiced even where a narrow hint leaves it
 *    no rival: the ignition-cut limiter holds of i5-test and v8-flatplane-test (salience / L at the true rpm, median
 *    7–10, 2.5–5 × the best candidate ≥ 6 % away in a ±7 % hint; 0–5 of 145 frames voiced) and i5-test at 6000 rpm
 *    part load in the cabin (9.8; 11–12 of the 195 frames of cruise6k voiced) read NaN, and so does most of
 *    v8-crossplane-test at 4000 rpm part load outside (3 of 195 voiced). Reported, not gated (D4(4)). A lower floor
 *    would voice the renders' fuel-cut overruns (≤ 10.3) and band-limited noise (≤ 12).
 */
import { firingHz, type EngineSpec } from '../contracts';
import { fft, hann } from '../dsp/analysis';

export interface RpmTrack {
  /** Actual hop between frames (s): round(hopS · fs) / fs. */
  hopS: number;
  /** Frame-centre times (s) from the start of the signal. */
  t: Float64Array;
  /** Tracked rpm per frame (a point of the candidate grid); NaN where the frame is unvoiced (D1.3). */
  rpm: Float64Array;
  /** Per-frame confidence in [0, 1]: 0 where unvoiced; the most confident frame of the clip is exactly 1. */
  confidence: Float64Array;
}

export interface TrackOptions {
  firingsPerRev: number; // combustion.length × 360 / cycleDeg (contracts.firingHz basis)
  subOrderStep: number; // 0.5 (4-stroke) or 1/3 (rotary)
  rpmMin: number; // search range (from sidecar rpmHint or the engine's idle..limiter)
  rpmMax: number;
  hopS?: number; // default 0.02
  winS?: number; // default 0.12
  /** default 6000 (Viterbi transition constraint); maxSlewRpmPerS · hop must be ≥ RPM_GRID_STEP (one grid step per frame). */
  maxSlewRpmPerS?: number;
}

export const DEFAULT_HOP_S = 0.02;
export const DEFAULT_WIN_S = 0.12;
export const DEFAULT_MAX_SLEW_RPM_PER_S = 6000;
/** Candidate grid spacing (rpm). */
export const RPM_GRID_STEP = 10;
/** Firing harmonics summed per candidate (weights h^−½). */
export const HARMONICS = 8;
/** Weight of each sub-order bin relative to the fundamental. */
export const SUB_ORDER_WEIGHT = 0.5;
/** The FFT is zero-padded to the next power of two ≥ this × the window length. */
export const ZERO_PAD_FACTOR = 4;
/** Half-width of the local mean subtracted for the clamped contrast, in units of 1 / winS (≈ 21 Hz at 0.12 s). */
export const CONTRAST_HALF_WIDTH = 2.5;
/** Sub-order bin spacing (× 1 / winS) at which their weight starts to rise from 0 … */
export const SUB_RESOLVE_FROM = 2.5;
/** … and reaches 1. */
export const SUB_RESOLVE_TO = 4;
/** Fixed band (Hz) of the emission-normalising level L = mean |X| (D1.2), clipped to Nyquist. */
export const LEVEL_BAND_HZ: readonly [number, number] = [20, 2000];
/**
 * Voicing floor on salience / L: a frame carries evidence only when some candidate exceeds it, and reports an rpm
 * only when the tracked candidate does (D1.3). Noise-only frames stay below it (white ≤ 5, pink and cabin-filtered
 * ≤ 12, the renders' fuel-cut overruns ≤ 10.3); brown noise does not (≤ 23; see Limits).
 */
export const VOICING_FLOOR = 12;
/** Viterbi emission of a frame with evidence: max(0, salience / L − EMISSION_FLOOR), about the noise-only median. */
export const EMISSION_FLOOR = 5;
/** Transition cost per frame, in emission units, of an rpm change at SLEW_COST_RATE (linear in |Δrpm|). */
export const SLEW_COST = 1;
/** rpm/s whose per-frame change costs SLEW_COST; independent of maxSlewRpmPerS, which only bounds the step. */
export const SLEW_COST_RATE = DEFAULT_MAX_SLEW_RPM_PER_S;
/** Upper bound for rpmMax (keeps the candidate grid and its tables bounded). */
const RPM_LIMIT = 100_000;
/**
 * Speed-up only (the method is unchanged): every bin read lies far below Nyquist, so the signal is low-passed and
 * decimated by D before the FFTs, which shrink D-fold at the same bin spacing. D is the largest power of two
 * ≤ MAX_DECIMATION that divides the window and hop lengths and keeps every read bin (comb, contrast and level
 * band) below DECIMATION_PASSBAND · fs / D, inside the anti-alias filter's flat passband.
 */
const MAX_DECIMATION = 16;
const DECIMATION_PASSBAND = 0.4;
/** Blackman-windowed-sinc taps per unit of D: 28·D + 1 taps put the transition band inside [0.4, 0.6]·fs/D. */
const DECIMATION_TAPS_PER_FACTOR = 28;
/** A decimated window keeps at least this many samples. */
const MIN_DECIMATED_WINDOW = 64;

function assertFinitePositive(name: string, v: number): void {
  if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`trackRpm: ${name} must be finite and > 0, got ${v}`);
}

/**
 * Zero-phase anti-alias low-pass (Blackman-windowed sinc, cutoff fs / (2d), unity DC gain, 28·d + 1 taps:
 * flat to 0.4·fs / d, ≥ 70 dB down from 0.6·fs / d) keeping every d-th sample: y[m] ≈ x[m·d], ⌈x.length / d⌉
 * samples. Samples outside x count as 0. `d` must be a positive integer (RangeError otherwise). Exported for
 * its tests; trackRpm picks d (see MAX_DECIMATION).
 */
export function decimate(x: Float64Array, d: number): Float64Array {
  if (!Number.isInteger(d) || d < 1) throw new RangeError(`decimate: d must be a positive integer, got ${d}`);
  const half = (DECIMATION_TAPS_PER_FACTOR * d) / 2;
  const h = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const u = k / d;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * k) / half) + 0.08 * Math.cos((2 * Math.PI * k) / half);
    const v = sinc * w;
    h[k + half] = v;
    sum += v;
  }
  for (let k = 0; k < h.length; k++) h[k] = (h[k] ?? 0) / sum;
  const len = x.length;
  const out = new Float64Array(Math.ceil(len / d));
  for (let m = 0; m < out.length; m++) {
    const c = m * d;
    const lo = c - half > 0 ? -half : -c;
    const hi = c + half < len ? half : len - 1 - c;
    let acc = 0;
    for (let k = lo; k <= hi; k++) acc += (h[k + half] ?? 0) * (x[c + k] ?? 0);
    out[m] = acc;
  }
  return out;
}

/**
 * Tracks engine rpm through `signal` (mono, sample rate `fs`) for an engine with `o.firingsPerRev` firing
 * events per crank (e-shaft) revolution. Frames are full windows only: a signal shorter than one window
 * gives an empty track. Unvoiced frames read rpm = NaN, confidence = 0. Throws RangeError on invalid options
 * or non-finite samples.
 */
export function trackRpm(signal: ArrayLike<number>, fs: number, o: TrackOptions): RpmTrack {
  assertFinitePositive('fs', fs);
  assertFinitePositive('firingsPerRev', o.firingsPerRev);
  assertFinitePositive('subOrderStep', o.subOrderStep);
  if (o.subOrderStep > o.firingsPerRev) {
    throw new RangeError(`trackRpm: subOrderStep (${o.subOrderStep}) must not exceed firingsPerRev (${o.firingsPerRev})`);
  }
  assertFinitePositive('rpmMin', o.rpmMin);
  assertFinitePositive('rpmMax', o.rpmMax);
  if (o.rpmMax < o.rpmMin || o.rpmMax > RPM_LIMIT) {
    throw new RangeError(`trackRpm: need rpmMin ≤ rpmMax ≤ ${RPM_LIMIT}, got ${o.rpmMin}..${o.rpmMax}`);
  }
  const hopS = o.hopS ?? DEFAULT_HOP_S;
  const winS = o.winS ?? DEFAULT_WIN_S;
  const maxSlew = o.maxSlewRpmPerS ?? DEFAULT_MAX_SLEW_RPM_PER_S;
  assertFinitePositive('hopS', hopS);
  assertFinitePositive('winS', winS);
  assertFinitePositive('maxSlewRpmPerS', maxSlew);
  const winN = Math.round(winS * fs);
  const hopN = Math.round(hopS * fs);
  if (winN < 2 || hopN < 1) throw new RangeError(`trackRpm: winS and hopS must span ≥ 2 and ≥ 1 samples at ${fs} Hz`);

  const len = signal.length;
  const x = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const v = signal[i] ?? Number.NaN;
    if (!Number.isFinite(v)) throw new RangeError(`trackRpm: sample ${i} is not finite (${v})`);
    x[i] = v;
  }

  const hopOut = hopN / fs;
  /** Largest per-frame move of the path, in grid steps. */
  const maxStep = Math.floor((maxSlew * hopOut) / RPM_GRID_STEP + 1e-9);
  if (maxStep < 1) {
    throw new RangeError(
      `trackRpm: maxSlewRpmPerS · hop must be ≥ ${RPM_GRID_STEP} rpm (one grid step per frame), got ${maxSlew} rpm/s × ${hopOut} s`,
    );
  }
  const frames = len >= winN ? Math.floor((len - winN) / hopN) + 1 : 0;
  const t = new Float64Array(frames);
  const rpm = new Float64Array(frames);
  const confidence = new Float64Array(frames);
  if (frames === 0) return { hopS: hopOut, t, rpm, confidence };

  // ── candidate grid and comb tables ──
  const J = Math.floor((o.rpmMax - o.rpmMin) / RPM_GRID_STEP + 1e-9) + 1;
  let n = 1;
  while (n < ZERO_PAD_FACTOR * winN) n <<= 1;
  const halfN = n >> 1;
  const binPerHz = n / fs;
  const F = o.firingsPerRev;
  const step = o.subOrderStep;
  const subCount = Math.ceil(F / step - 1e-9) - 1; // k = 1..M−1: cycle orders below the firing order (M ≥ 1 checked above)
  const teethPer = HARMONICS + subCount;
  const pos = new Float64Array(J * teethPer); // FFT bin positions (fractional)
  const wt = new Float64Array(J * teethPer);
  let kTop = 1; // highest bin index a tooth interpolates from (floor(u) + 1 ≤ halfN)
  for (let j = 0; j < J; j++) {
    const b = (o.rpmMin + RPM_GRID_STEP * j) / 60;
    const base = j * teethPer;
    for (let h = 1; h <= HARMONICS; h++) {
      const u = h * F * b * binPerHz;
      if (u < halfN) {
        pos[base + h - 1] = u;
        wt[base + h - 1] = 1 / Math.sqrt(h);
        kTop = Math.max(kTop, Math.floor(u) + 1);
      }
    }
    const spacingPerWin = step * b * winS;
    const rho = Math.min(1, Math.max(0, (spacingPerWin - SUB_RESOLVE_FROM) / (SUB_RESOLVE_TO - SUB_RESOLVE_FROM)));
    for (let k = 1; k <= subCount; k++) {
      const u = k * step * b * binPerHz;
      if (u < halfN && rho > 0) {
        pos[base + HARMONICS + k - 1] = u;
        wt[base + HARMONICS + k - 1] = SUB_ORDER_WEIGHT * rho;
        kTop = Math.max(kTop, Math.floor(u) + 1);
      }
    }
  }
  const W = Math.round((CONTRAST_HALF_WIDTH / winS) * binPerHz); // = round(2.5 · n / winN) ∈ [10, 20]
  const levelLo = Math.ceil(LEVEL_BAND_HZ[0] * binPerHz);
  const levelHi = Math.min(halfN, Math.floor(LEVEL_BAND_HZ[1] * binPerHz));
  const kMag = Math.min(halfN, Math.max(kTop + W, levelHi));

  // ── decimation (speed only: same window, same bin spacing n / fs, D-fold smaller FFT) ──
  const fRead = (kMag + 1) / binPerHz;
  let d = 1;
  while (
    2 * d <= MAX_DECIMATION &&
    winN % (2 * d) === 0 &&
    hopN % (2 * d) === 0 &&
    winN / (2 * d) >= MIN_DECIMATED_WINDOW &&
    fRead <= (DECIMATION_PASSBAND * fs) / (2 * d)
  ) {
    d *= 2;
  }
  const xs = d > 1 ? decimate(x, d) : x;
  const winD = winN / d;
  const hopD = hopN / d;

  // ── per-frame level and salience ──
  // Two real frames per complex FFT: frame i in re, frame i + 1 in im. With Z = FFT(re + i·im) of length N,
  // X_i[k] = (Z[k] + conj Z[N − k]) / 2 and X_{i+1}[k] = (Z[k] − conj Z[N − k]) / 2i.
  const win = hann(winD);
  const nD = n / d;
  const re = new Float64Array(nD);
  const im = new Float64Array(nD);
  const magA = new Float64Array(kMag + 1);
  const magB = new Float64Array(kMag + 1);
  const prefix = new Float64Array(kMag + 2);
  const contrast = new Float64Array(kTop + 1);
  const sal = new Float64Array(frames * J);
  const salSum = new Float64Array(frames);
  /** 1 / L per frame, 0 when the band is empty or silent (such a frame carries no evidence). */
  const invLevel = new Float64Array(frames);
  /** 1 where some candidate's salience / L exceeds VOICING_FLOOR: the frame carries evidence (D1.2 / D1.3). */
  const evidence = new Uint8Array(frames);
  const load = (i: number, dst: Float64Array): void => {
    const start = i * hopD;
    let mean = 0;
    for (let q = 0; q < winD; q++) mean += xs[start + q] ?? 0;
    mean /= winD;
    for (let q = 0; q < winD; q++) dst[q] = ((xs[start + q] ?? 0) - mean) * (win[q] ?? 0);
  };
  const score = (i: number, mag: Float64Array): void => {
    t[i] = (i * hopN + (winN - 1) / 2) / fs;
    let lv = 0;
    for (let k = levelLo; k <= levelHi; k++) lv += mag[k] ?? 0;
    invLevel[i] = levelHi >= levelLo && lv > 0 ? (levelHi - levelLo + 1) / lv : 0;
    prefix[0] = 0;
    for (let k = 0; k <= kMag; k++) prefix[k + 1] = (prefix[k] ?? 0) + (mag[k] ?? 0);
    for (let k = 0; k <= kTop; k++) {
      const lo = k - W > 0 ? k - W : 0;
      const hi = k + W < kMag ? k + W : kMag;
      const c = (mag[k] ?? 0) - ((prefix[hi + 1] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo + 1);
      contrast[k] = c > 0 ? c : 0;
    }
    let sum = 0;
    let best = 0;
    for (let j = 0; j < J; j++) {
      const base = j * teethPer;
      let s = 0;
      for (let q = 0; q < teethPer; q++) {
        const w = wt[base + q] ?? 0;
        if (w === 0) continue;
        const u = pos[base + q] ?? 0;
        const k0 = Math.floor(u);
        const c0 = contrast[k0] ?? 0;
        s += w * (c0 + (u - k0) * ((contrast[k0 + 1] ?? 0) - c0));
      }
      sal[i * J + j] = s;
      sum += s;
      if (s > best) best = s;
    }
    salSum[i] = sum;
    evidence[i] = best * (invLevel[i] ?? 0) > VOICING_FLOOR ? 1 : 0;
  };
  for (let i = 0; i < frames; i += 2) {
    re.fill(0);
    im.fill(0);
    load(i, re);
    if (i + 1 < frames) load(i + 1, im);
    fft(re, im);
    for (let k = 0; k <= kMag; k++) {
      const k2 = k === 0 ? 0 : nD - k;
      const a = re[k] ?? 0;
      const b = im[k] ?? 0;
      const c = re[k2] ?? 0;
      const e = im[k2] ?? 0;
      magA[k] = 0.5 * Math.sqrt((a + c) * (a + c) + (b - e) * (b - e));
      magB[k] = 0.5 * Math.sqrt((a - c) * (a - c) + (b + e) * (b + e));
    }
    score(i, magA);
    if (i + 1 < frames) score(i + 1, magB);
  }

  const emission = (i: number, j: number): number => {
    if (evidence[i] !== 1) return 0;
    const e = (sal[i * J + j] ?? 0) * (invLevel[i] ?? 0) - EMISSION_FLOOR;
    return e > 0 ? e : 0;
  };

  // ── Viterbi: max over k ∈ [j − m, j + m] of prev[k] − c·|k − j|, lowest k on ties, as two sliding-window maxima
  // (k ≤ j: prev[k] + c·k − c·j; k ≥ j: prev[k] − c·k + c·j) ──
  const m = maxStep;
  const c = (SLEW_COST * RPM_GRID_STEP) / (SLEW_COST_RATE * hopOut);
  let prev = new Float64Array(J);
  let cur = new Float64Array(J);
  const back = new Int32Array(frames * J);
  const up = new Float64Array(J);
  const down = new Float64Array(J);
  const queue = new Int32Array(J);
  const leftValue = new Float64Array(J);
  const leftArg = new Int32Array(J);
  for (let j = 0; j < J; j++) prev[j] = emission(0, j);
  for (let i = 1; i < frames; i++) {
    for (let k = 0; k < J; k++) {
      up[k] = (prev[k] ?? 0) + c * k;
      down[k] = (prev[k] ?? 0) - c * k;
    }
    let head = 0;
    let tail = 0;
    for (let j = 0; j < J; j++) {
      while (tail > head && (up[queue[tail - 1] ?? 0] ?? 0) < (up[j] ?? 0)) tail--;
      queue[tail++] = j;
      while ((queue[head] ?? 0) < j - m) head++;
      const k = queue[head] ?? j;
      leftArg[j] = k;
      leftValue[j] = (up[k] ?? 0) - c * j;
    }
    head = 0;
    tail = 0;
    for (let j = J - 1; j >= 0; j--) {
      while (tail > head && (down[queue[tail - 1] ?? 0] ?? 0) <= (down[j] ?? 0)) tail--;
      queue[tail++] = j;
      while ((queue[head] ?? 0) > j + m) head++;
      const k = queue[head] ?? j;
      const right = (down[k] ?? 0) + c * j;
      const left = leftValue[j] ?? 0;
      const fromRight = right > left;
      cur[j] = (fromRight ? right : left) + emission(i, j);
      back[i * J + j] = fromRight ? k : (leftArg[j] ?? j);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  let at = 0;
  for (let j = 1; j < J; j++) if ((prev[j] ?? 0) > (prev[at] ?? 0)) at = j;

  // ── report: the tracked rpm only where its own salience clears the voicing floor (D1.3) ──
  let bestConf = 0;
  for (let i = frames - 1; i >= 0; i--) {
    const s = sal[i * J + at] ?? 0;
    if (s * (invLevel[i] ?? 0) > VOICING_FLOOR) {
      rpm[i] = o.rpmMin + RPM_GRID_STEP * at;
      const total = salSum[i] ?? 0;
      const conf = total > 0 ? s / total : 0;
      confidence[i] = conf;
      if (conf > bestConf) bestConf = conf;
    } else {
      rpm[i] = Number.NaN;
      confidence[i] = 0;
    }
    if (i > 0) at = back[i * J + at] ?? at;
  }
  if (bestConf > 0) for (let i = 0; i < frames; i++) confidence[i] = (confidence[i] ?? 0) / bestConf;
  return { hopS: hopOut, t, rpm, confidence };
}

/**
 * Tracking options for an engine (spec §5.1): firing order combustion.length × 360 / cycleDeg (the
 * contracts.firingHz basis), sub-order step 360 / cycleDeg, search range `rpmHint` or idle..limiter.
 */
export function trackOptionsForEngine(spec: EngineSpec, rpmHint?: readonly [number, number]): TrackOptions {
  return {
    firingsPerRev: firingHz(60, spec.combustion.length, spec.cycleDeg),
    subOrderStep: 360 / spec.cycleDeg,
    rpmMin: rpmHint?.[0] ?? spec.rpm.idle,
    rpmMax: rpmHint?.[1] ?? spec.rpm.limiter.rpm,
  };
}

/** Segment kinds of a reference sidecar (phase 2b contract §Reference library). */
export const SEGMENT_KINDS = ['idle', 'cruise', 'wot', 'liftoff', 'limiter'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];
/** D4(1): the steady kinds. An `"auto"` segment of one of them must carry an rpmHint no wider than ±STEADY_HINT_MAX. */
export const STEADY_KINDS: readonly SegmentKind[] = ['idle', 'cruise', 'limiter'];
/** D4(1): the widest steady-kind hint [lo, hi], as ± a fraction of its centre: hi − lo ≤ STEADY_HINT_MAX · (lo + hi). */
export const STEADY_HINT_MAX = 0.15;

/**
 * Tracking options for one `"rpm": "auto"` sidecar segment: the score CLI's request to the tracker (phase 2b D4). A
 * steady kind (idle, cruise, limiter) must carry an rpmHint no wider than ±15 % around its centre (D4(1)); without one,
 * or with a wider one, this throws RangeError, because a wide search of a steady, bass-limited segment can lock onto
 * 2–3 × its rpm at full confidence (see Limits). A sweep (wot, liftoff) takes any range hint, or the engine's
 * idle..limiter without one, and relies on the Viterbi continuity constraint (D4(2)). trackRpm itself stays generic and
 * searches whatever range it is given. Also throws RangeError on an unknown kind, or a hint that is not two finite rpm
 * 0 < lo ≤ hi (sidecars are untrusted JSON).
 */
export function trackOptionsForSegment(spec: EngineSpec, kind: SegmentKind, rpmHint?: readonly [number, number]): TrackOptions {
  if (!(SEGMENT_KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(`trackOptionsForSegment: unknown segment kind ${JSON.stringify(kind)} (expected ${SEGMENT_KINDS.join(' | ')})`);
  }
  if (rpmHint !== undefined) {
    const [lo, hi] = rpmHint;
    if (!(lo > 0 && hi >= lo && Number.isFinite(hi))) {
      throw new RangeError(`trackOptionsForSegment: rpmHint must be two finite rpm 0 < lo ≤ hi, got [${String(lo)}, ${String(hi)}]`);
    }
  }
  if (STEADY_KINDS.includes(kind)) {
    const max = `±${Math.round(100 * STEADY_HINT_MAX)} %`;
    if (rpmHint === undefined) {
      throw new RangeError(`trackOptionsForSegment: a ${kind} segment with rpm "auto" needs an rpmHint no wider than ${max} (phase 2b D4(1))`);
    }
    const [lo, hi] = rpmHint;
    if (hi - lo > STEADY_HINT_MAX * (lo + hi) * (1 + 1e-9)) {
      const half = (100 * (hi - lo)) / (hi + lo);
      throw new RangeError(
        `trackOptionsForSegment: the rpmHint [${lo}, ${hi}] of a ${kind} segment spans ±${half.toFixed(1)} % around its centre; ` +
          `steady kinds allow at most ${max} (phase 2b D4(1))`,
      );
    }
  }
  return trackOptionsForEngine(spec, rpmHint);
}

/**
 * rpm at time `tS` (s): linear between frame centres, clamped to the first / last frame; exact at a frame centre;
 * NaN between a voiced and an unvoiced frame (an unvoiced frame's rpm is NaN), if the track is empty, or if `tS`
 * is NaN.
 */
export function interpolateRpm(track: RpmTrack, tS: number): number {
  const n = track.t.length;
  if (n === 0 || Number.isNaN(tS)) return Number.NaN;
  const first = track.t[0] ?? 0;
  const last = track.t[n - 1] ?? 0;
  if (!(tS > first)) return track.rpm[0] ?? Number.NaN;
  if (tS >= last) return track.rpm[n - 1] ?? Number.NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((track.t[mid] ?? 0) <= tS) lo = mid;
    else hi = mid;
  }
  const t0 = track.t[lo] ?? 0;
  const t1 = track.t[hi] ?? 0;
  const r0 = track.rpm[lo] ?? Number.NaN;
  if (tS === t0) return r0;
  const r1 = track.rpm[hi] ?? Number.NaN;
  return t1 > t0 ? r0 + ((r1 - r0) * (tS - t0)) / (t1 - t0) : r0;
}
