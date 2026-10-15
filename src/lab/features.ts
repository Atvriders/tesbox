/**
 * Per-frame and per-clip sound features for reference scoring (phase 2b contract "Features" as amended by D2
 * and D5, spec §11.3). Environment-free (Node + browser): no DOM, Web Audio or Node APIs. Analysis code may
 * allocate.
 *
 * Spectral estimators (all Hann-windowed, via src/dsp/analysis):
 * - orderAmp, subOrderDb: orderSpectrum — Goertzel at the exact order frequencies over the whole frame.
 * - centroidHz, tiltDbPerOct: one periodogram of the whole frame, zero-padded to a power of two.
 * - fiLineHz: a Welch-averaged periodogram (≈ 40 ms segments, 50 % overlap, 2× zero-padding). A single
 *   periodogram's bins are exponentially distributed, so in plain broadband noise the largest of the
 *   ≈ 750 bins in 1–4 kHz already stands ≈ 10 dB over the local median and would read as a "line";
 *   averaging ≈ 11 segments keeps noise peaks near 3 dB. The line never depends on the rpm (amendment D5).
 *
 * A frame whose RMS is at the rmsDb floor (≤ 1e-10, levelDb −200) is digitally silent: its relative
 * features are undefined (NaN; irregularity and fiLineHz null) and clipFeatures drops it.
 */
import type { Perspective } from '../contracts';
import { fft, hann, orderSpectrum, rmsDb } from '../dsp/analysis';
import { Biquad } from '../dsp/biquad';

/**
 * Features of one analysis frame. **NaN means "undefined" (not measurable on this frame), never a
 * measurement**: consumers must skip non-finite values, e.g. leave them out of per-bin means (a single
 * NaN poisons a mean, and exp(−NaN) a similarity). irregularity and fiLineHz use null instead. rpm,
 * orderAmp and levelDb are always finite.
 */
export interface FrameFeatures {
  rpm: number;
  orderAmp: Float64Array; // sqrt of orderSpectrum power at orders k·step, k = 1..floor(12/step)
  /** Spectral centroid 20 Hz–12 kHz. NaN: digitally silent frame, or no power in that range. */
  centroidHz: number;
  /**
   * Least-squares slope of 1/3-octave band levels (50 Hz–8 kHz, dB) vs log2(fc). NaN: silent frame, fewer
   * than two bands below fs/2, or no power in them.
   */
  tiltDbPerOct: number;
  /**
   * 10·log10(Σ power at the orders j·step ≤ 12 that are not multiples of firingsPerRev / Σ power at the
   * multiples of firingsPerRev ≤ 12) (amendment D2.1). NaN: silent frame, or no power at any order.
   */
  subOrderDb: number;
  /**
   * CV of per-cycle RMS (cycle = 720° or 1080° at the frame rpm) over an analysis window of
   * max(0.25 s, IRREGULARITY_MIN_CYCLES cycles) centred on the frame (amendment D2.3; see clipFeatures —
   * frameFeatures only has its own frame). null when the window holds fewer than two whole cycles, or on a
   * silent frame — never NaN.
   */
  irregularity: number | null;
  /**
   * Strongest peak 1–4 kHz with prominence ≥ 10 dB over the local median, engine orders included (amendment
   * D5, superseding D2.2's ±3 % engine-order exclusion: a supercharger whine is order-locked and must be
   * detected; per D3 the metric is only scored for forced-induction engines, so the engine harmonics an NA
   * clip may report never enter a score). clipFeatures also requires the line to persist over
   * ≥ FI_MIN_RUN_FRAMES (3) consecutive frames whose lines lie within ±FI_RUN_TOLERANCE (5 %) of each other.
   * Else null.
   */
  fiLineHz: number | null;
  levelDb: number; // frame RMS dB
}

export interface ClipFeatures {
  kind: string;
  perspective: Perspective;
  frames: FrameFeatures[];
  overrunRate: number | null;
}

/** Highest order analysed (orders k·step, k = 1..floor(MAX_ORDER/step)). */
export const MAX_ORDER = 12;
/** Analysis frame length and hop (contract). */
export const FRAME_S = 0.25;
export const HOP_S = 0.125;
/** overrunRate: onsets/s where a 2 ms HP(1 kHz) energy jump ≥ 9 dB over a 50 ms median, liftoff segments only. */
export const OVERRUN_ONSET_DB = 9;
/**
 * overrunRate is null when less than this span (s) of blocks can be evaluated after the 50 ms history
 * (clips under 0.55 s): one stray onset can then read at most 2/s, never hundreds per second.
 */
export const OVERRUN_MIN_SPAN_S = 0.5;
/** clipFeatures reports a FI line only inside runs of at least this many consecutive frames (amendment D5). */
export const FI_MIN_RUN_FRAMES = 3;
/**
 * Consecutive frames carry the same FI line when their lines lie within ±5 % of each other: the higher at most
 * (1 + FI_RUN_TOLERANCE) × the lower (amendment D5; symmetric, and independent of the rpm). Runs chain frame to
 * frame, with no anchor frame: a line gliding < 5 % per 0.125 s hop persists however far it glides (a turbo
 * whistle spooling up; a supercharger whine while the rpm climbs by less than ≈ 0.39·rpm per second, i.e.
 * ln 1.05 per hop), while one moving faster is broken into runs that are too short (e.g. a whine through a
 * fast first-gear pull).
 */
export const FI_RUN_TOLERANCE = 0.05;
/** irregularity's analysis window is max(FRAME_S, this many cycles) (amendment D2.3). */
export const IRREGULARITY_MIN_CYCLES = 4;

/** rmsDb's floor: a frame at or below it is digitally silent. */
const SILENT_DB = -200;
/** An order counts as a multiple of the firing order (or of step) within this tolerance. */
const GRID_EPS = 1e-6;
/** Relative floor of power ratios (−120 dB re the frame's total): keeps them finite and gain-invariant. */
const REL_FLOOR = 1e-12;

const CENTROID_LO_HZ = 20;
const CENTROID_HI_HZ = 12000;

/** Base-2 1/3-octave bands, centres 1 kHz·2^(k/3): k = −13 is the 50 Hz band, k = 9 the 8 kHz band. */
const TILT_BAND_FIRST = -13;
const TILT_BAND_LAST = 9;

const FI_LO_HZ = 1000;
const FI_HI_HZ = 4000;
const FI_PROMINENCE_DB = 10;
/** The local median spans ±1/3 octave around a candidate peak. */
const FI_NEIGHBOUR_OCT = 1 / 3;
/** Welch segment length ≈ 40 ms, rounded to a power of two in samples (2048 at 48 kHz). */
const FI_SEGMENT_S = 0.04;

const OVERRUN_HP_HZ = 1000;
const OVERRUN_BLOCK_S = 0.002;
const OVERRUN_MEDIAN_S = 0.05;
/** Mean-square floor of an overrun block (−200 dB re full scale): digital silence stays finite. */
const OVERRUN_FLOOR = 1e-20;

/** rpmAt samples per frame (midpoint rule, every 5 ms of a 0.25 s frame) for the frame's mean rpm. */
const RPM_SAMPLES = 50;

function assertPositive(who: string, name: string, v: number): void {
  if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`${who}: ${name} must be finite and > 0, got ${v}`);
}

function isMultiple(a: number, b: number): boolean {
  const r = a / b;
  return Math.abs(r - Math.round(r)) < GRID_EPS;
}

/** step in (0, 12]; firingsPerRev a positive multiple of step up to order 12 (required: no fallback, D2.1). */
function assertGrid(who: string, step: number, firingsPerRev: number): void {
  assertPositive(who, 'step', step);
  if (step > MAX_ORDER) throw new RangeError(`${who}: step ${step} leaves no order up to ${MAX_ORDER}`);
  assertPositive(who, 'firingsPerRev', firingsPerRev);
  if (!isMultiple(firingsPerRev, step) || firingsPerRev > MAX_ORDER + GRID_EPS) {
    throw new RangeError(`${who}: firingsPerRev ${firingsPerRev} is not a multiple of step ${step} up to order ${MAX_ORDER}`);
  }
}

/** A Float64Array copy of x; throws on any non-finite sample (a corrupt buffer must not be analysed). */
function finiteCopy(who: string, x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v === undefined || !Number.isFinite(v)) throw new RangeError(`${who}: non-finite sample at ${i}`);
    out[i] = v;
  }
  return out;
}

function nextPow2(n: number): number {
  let m = 1;
  while (m < n) m <<= 1;
  return m;
}

/** Median of the values (mean of the middle two for an even count); sorts a copy. */
function median(values: Float64Array): number {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

interface Spectrum {
  /** |X_k|², k = 0..nfft/2. */
  p: Float64Array;
  /** Bin spacing, Hz. */
  df: number;
}

/** Hann-windowed periodogram of x, zero-padded to the next power of two. */
function periodogram(x: Float64Array, fs: number): Spectrum {
  const n = x.length;
  const nfft = nextPow2(n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = (x[i] ?? 0) * (w[i] ?? 0);
  fft(re, im);
  const p = new Float64Array((nfft >> 1) + 1);
  for (let k = 0; k < p.length; k++) p[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
  return { p, df: fs / nfft };
}

/**
 * Welch PSD (unnormalised: only ratios are used): Hann segments of 2^round(log2(0.04·fs)) samples
 * (the whole frame if shorter), spread evenly over the frame with ≥ 50 % overlap, each zero-padded 2×.
 */
function welch(x: Float64Array, fs: number): Spectrum {
  const n = x.length;
  const seg = Math.min(n, 2 ** Math.round(Math.log2(FI_SEGMENT_S * fs)));
  const nfft = 2 * nextPow2(seg);
  const count = n <= seg ? 1 : Math.ceil((n - seg) / (seg / 2)) + 1;
  const w = hann(seg);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const p = new Float64Array((nfft >> 1) + 1);
  for (let s = 0; s < count; s++) {
    const start = count === 1 ? 0 : Math.round((s * (n - seg)) / (count - 1));
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < seg; i++) re[i] = (x[start + i] ?? 0) * (w[i] ?? 0);
    fft(re, im);
    for (let k = 0; k < p.length; k++) p[k] = (p[k] ?? 0) + (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
  }
  return { p, df: fs / nfft };
}

/** Power-weighted mean frequency Σ f·P / Σ P over the bins in [20 Hz, min(12 kHz, fs/2)]; NaN if no power. */
function centroid(s: Spectrum, fs: number): number {
  const hi = Math.min(CENTROID_HI_HZ, fs / 2);
  let num = 0;
  let den = 0;
  for (let k = Math.ceil(CENTROID_LO_HZ / s.df); k < s.p.length; k++) {
    const f = k * s.df;
    if (f > hi) break;
    const v = s.p[k] ?? 0;
    num += f * v;
    den += v;
  }
  return den > 0 ? num / den : Number.NaN;
}

/**
 * Least-squares slope (dB per octave) of the 1/3-octave band levels vs log2(fc). A band's level is
 * 10·log10 of the SUMMED power of the bins in [fc·2^(−1/6), fc·2^(1/6)) — pink noise is flat, white
 * noise rises 3.01 dB/oct. Bands reaching past Nyquist or holding no bin are left out; band powers are
 * floored at 1e-12 × the strongest band. NaN with fewer than two bands or no power.
 */
function thirdOctaveTilt(s: Spectrum, fs: number): number {
  const xs: number[] = [];
  const ps: number[] = [];
  for (let b = TILT_BAND_FIRST; b <= TILT_BAND_LAST; b++) {
    const fc = 1000 * 2 ** (b / 3);
    const lo = fc * 2 ** (-1 / 6);
    const hi = fc * 2 ** (1 / 6);
    if (hi > fs / 2) continue;
    const k0 = Math.ceil(lo / s.df);
    const k1 = Math.ceil(hi / s.df) - 1;
    if (k1 < k0) continue;
    let e = 0;
    for (let k = k0; k <= k1; k++) e += s.p[k] ?? 0;
    xs.push(Math.log2(fc));
    ps.push(e);
  }
  if (xs.length < 2) return Number.NaN;
  const top = Math.max(...ps);
  if (!(top > 0)) return Number.NaN;
  const floor = REL_FLOOR * top;
  const ys = ps.map((e) => 10 * Math.log10(Math.max(e, floor)));
  let mx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    mx += xs[i] ?? 0;
    my += ys[i] ?? 0;
  }
  mx /= xs.length;
  my /= xs.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] ?? 0) - mx;
    sxy += dx * ((ys[i] ?? 0) - my);
    sxx += dx * dx;
  }
  return sxy / sxx;
}

/**
 * Amendment D2.1: 10·log10(Σ power at the grid orders j·step ≤ 12 that are not multiples of
 * `firingsPerRev` / Σ power at the multiples of `firingsPerRev` ≤ 12). Integer non-firing orders (e.g. 1 and
 * 3 of an I4, the per-bank rate of a cross-plane V8) count as sub-orders; an odd firing order's harmonics
 * (2.5, 5, 7.5, 10 of an I5) do not. Both sums are floored at 1e-12 × the total order power (finite and
 * gain-invariant); NaN with no power at any order.
 */
function subOrderRatioDb(power: Float64Array, step: number, firingsPerRev: number): number {
  let total = 0;
  let sub = 0;
  let fire = 0;
  for (let i = 0; i < power.length; i++) {
    const p = power[i] ?? 0;
    total += p;
    if (isMultiple((i + 1) * step, firingsPerRev)) fire += p;
    else sub += p;
  }
  if (!(total > 0)) return Number.NaN;
  const floor = REL_FLOOR * total;
  return 10 * Math.log10((sub + floor) / (fire + floor));
}

/**
 * Coefficient of variation (population σ / μ) of the RMS of the whole engine cycles (360°/step of crank:
 * 720° for step ½, 1080° for step ⅓, at `rpm`) laid end to end from the start of `x`; a trailing partial
 * cycle is ignored. null with fewer than two whole cycles or no energy.
 */
function cycleIrregularity(x: Float64Array, fs: number, rpm: number, step: number): number | null {
  const len = (60 * fs) / (step * rpm);
  if (!(len >= 2)) return null;
  const cycles = Math.floor(x.length / len + 1e-9);
  if (cycles < 2) return null;
  const rms = new Float64Array(cycles);
  for (let j = 0; j < cycles; j++) {
    const a = Math.round(j * len);
    const b = Math.min(x.length, Math.round((j + 1) * len));
    let e = 0;
    for (let i = a; i < b; i++) e += (x[i] ?? 0) ** 2;
    rms[j] = Math.sqrt(e / (b - a));
  }
  let mean = 0;
  for (let j = 0; j < cycles; j++) mean += rms[j] ?? 0;
  mean /= cycles;
  if (!(mean > 0)) return null;
  let v = 0;
  for (let j = 0; j < cycles; j++) v += ((rms[j] ?? 0) - mean) ** 2;
  return Math.sqrt(v / cycles) / mean;
}

/**
 * The irregularity window of the frame [start, start + frameLen) of `sig` (amendment D2.3):
 * max(frameLen, IRREGULARITY_MIN_CYCLES cycles at `rpm`) samples centred on the frame, shifted to lie inside
 * `sig`, or the whole of `sig` when it is shorter.
 */
function irregularityWindow(sig: Float64Array, start: number, frameLen: number, fs: number, rpm: number, step: number): Float64Array {
  const cycle = (60 * fs) / (step * rpm);
  const len = Math.min(sig.length, Math.max(frameLen, Math.ceil(IRREGULARITY_MIN_CYCLES * cycle - 1e-9)));
  const a = Math.min(Math.max(0, Math.round(start + frameLen / 2 - len / 2)), sig.length - len);
  return sig.subarray(a, a + len);
}

/**
 * The strongest local maximum of the Welch PSD in 1–4 kHz whose prominence over the median PSD within
 * ±1/3 octave of it is ≥ 10 dB (a louder but non-prominent maximum does not mask it), its frequency refined by
 * parabolic interpolation of the log power over its three bins; null when there is none. Engine orders are not
 * excluded (amendment D5): the line depends on the audio alone.
 */
function fiLine(x: Float64Array, fs: number): number | null {
  const { p, df } = welch(x, fs);
  const last = p.length - 1; // Nyquist bin
  const kLo = Math.max(1, Math.ceil(FI_LO_HZ / df));
  const kHi = Math.min(last - 1, Math.floor(FI_HI_HZ / df));
  const widen = 2 ** FI_NEIGHBOUR_OCT;
  let bestP = 0;
  let bestHz: number | null = null;
  for (let k = kLo; k <= kHi; k++) {
    const v = p[k] ?? 0;
    const pl = p[k - 1] ?? 0;
    const pr = p[k + 1] ?? 0;
    if (!(v > pl && v >= pr) || v <= bestP) continue;
    const f = k * df;
    const a = Math.max(1, Math.ceil(f / widen / df));
    const b = Math.min(last, Math.floor((f * widen) / df));
    const med = median(p.subarray(a, b + 1));
    if (med > 0 && 10 * Math.log10(v / med) < FI_PROMINENCE_DB) continue;
    let delta = 0;
    if (pl > 0 && pr > 0) {
      const l = Math.log(pl);
      const c = Math.log(v);
      const r = Math.log(pr);
      const den = l - 2 * c + r;
      if (den < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
    }
    bestP = v;
    bestHz = (k + delta) * df;
  }
  return bestHz;
}

/**
 * Features of a validated frame (finite samples, fs/rpm/step/firingsPerRev checked); irregularity is measured
 * over `irrWindow` (the frame itself for frameFeatures).
 */
function analyse(
  x: Float64Array,
  fs: number,
  rpm: number,
  step: number,
  firingsPerRev: number,
  irrWindow: Float64Array,
): FrameFeatures {
  const power = orderSpectrum(x, fs, rpm, MAX_ORDER, step);
  const orderAmp = new Float64Array(power.length);
  for (let i = 0; i < power.length; i++) orderAmp[i] = Math.sqrt(power[i] ?? 0);
  const levelDb = rmsDb(x);
  if (levelDb <= SILENT_DB) {
    return {
      rpm,
      orderAmp,
      centroidHz: Number.NaN,
      tiltDbPerOct: Number.NaN,
      subOrderDb: Number.NaN,
      irregularity: null,
      fiLineHz: null,
      levelDb,
    };
  }
  const spectrum = periodogram(x, fs);
  return {
    rpm,
    orderAmp,
    centroidHz: centroid(spectrum, fs),
    tiltDbPerOct: thirdOctaveTilt(spectrum, fs),
    subOrderDb: subOrderRatioDb(power, step, firingsPerRev),
    irregularity: cycleIrregularity(irrWindow, fs, rpm, step),
    fiLineHz: fiLine(x, fs),
    levelDb,
  };
}

/**
 * Features of one frame `x` (any length ≥ 1; the contract frame is 0.25 s) at the frame's mean `rpm`;
 * `step` is the cycle sub-order step (½ for 4-stroke, ⅓ for rotary) and `firingsPerRev` the firing order
 * combustion.length × 360 / cycleDeg (required, a multiple of `step`, ≤ 12; amendment D2.1). A single frame
 * has no neighbours: irregularity is measured over `x` itself (null when it holds fewer than two cycles,
 * e.g. a 0.25 s frame below 960 rpm), and fiLineHz is the frame's own line, unchecked for persistence —
 * clipFeatures applies the irregularity window (D2.3) and the line persistence (D5). Throws RangeError on an
 * empty frame, a non-finite sample, a non-finite or non-positive fs/rpm/step, a step above 12, or a missing or
 * off-grid firingsPerRev.
 */
export function frameFeatures(x: ArrayLike<number>, fs: number, rpm: number, step: number, firingsPerRev: number): FrameFeatures {
  const who = 'frameFeatures';
  if (x.length === 0) throw new RangeError(`${who}: empty frame`);
  assertPositive(who, 'fs', fs);
  assertPositive(who, 'rpm', rpm);
  assertGrid(who, step, firingsPerRev);
  const frame = finiteCopy(who, x);
  return analyse(frame, fs, rpm, step, firingsPerRev, frame);
}

/**
 * Mean of rpmAt over [t0, t0 + dur] (midpoint rule, RPM_SAMPLES samples); null if any sample is not finite
 * and > 0.
 */
function frameRpm(rpmAt: (tS: number) => number, t0: number, dur: number): number | null {
  let s = 0;
  for (let j = 0; j < RPM_SAMPLES; j++) {
    const r = rpmAt(t0 + ((j + 0.5) * dur) / RPM_SAMPLES);
    if (!(r > 0) || !Number.isFinite(r)) return null;
    s += r;
  }
  return s / RPM_SAMPLES;
}

/** A kept frame's position (hop index, first sample) and mean rpm. */
interface FrameSlot {
  hop: number;
  start: number;
  rpm: number;
}

/** True when the lines of consecutive frames are the same line: within ±FI_RUN_TOLERANCE of each other. */
function sameLine(hzA: number, hzB: number): boolean {
  return Math.max(hzA, hzB) <= (1 + FI_RUN_TOLERANCE) * Math.min(hzA, hzB);
}

/**
 * Amendment D5 persistence: keeps each frame's fiLineHz only inside runs of ≥ FI_MIN_RUN_FRAMES frames that
 * are consecutive (adjacent hops: a dropped frame breaks the run) and whose consecutive lines are the same line
 * (sameLine); nulls the rest.
 */
function keepPersistentLines(frames: FrameFeatures[], slots: FrameSlot[]): void {
  let runStart = 0;
  for (let i = 1; i <= frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const sa = slots[i - 1];
    const sb = slots[i];
    const continues =
      a !== undefined &&
      b !== undefined &&
      sa !== undefined &&
      sb !== undefined &&
      a.fiLineHz !== null &&
      b.fiLineHz !== null &&
      sb.hop === sa.hop + 1 &&
      sameLine(a.fiLineHz, b.fiLineHz);
    if (continues) continue;
    if (i - runStart < FI_MIN_RUN_FRAMES) {
      for (let j = runStart; j < i; j++) {
        const f = frames[j];
        if (f !== undefined) f.fiLineHz = null;
      }
    }
    runStart = i;
  }
}

/** overrunRate of a validated signal (see the exported overrunRate). */
function onsetRate(x: Float64Array, fs: number): number | null {
  const block = Math.max(1, Math.round(OVERRUN_BLOCK_S * fs));
  const hist = Math.max(1, Math.round((OVERRUN_MEDIAN_S * fs) / block));
  const blocks = Math.floor(x.length / block);
  if ((blocks - hist) * block < OVERRUN_MIN_SPAN_S * fs) return null;
  const hp = new Biquad();
  hp.highpass(OVERRUN_HP_HZ, Math.SQRT1_2, fs);
  const level = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let e = 0;
    for (let i = b * block; i < (b + 1) * block; i++) {
      const y = hp.process(x[i] ?? 0);
      e += y * y;
    }
    level[b] = 10 * Math.log10(e / block + OVERRUN_FLOOR);
  }
  let onsets = 0;
  let above = false;
  for (let b = hist; b < blocks; b++) {
    const now = (level[b] ?? 0) - median(level.subarray(b - hist, b)) >= OVERRUN_ONSET_DB;
    if (now && !above) onsets++;
    above = now;
  }
  return onsets / (((blocks - hist) * block) / fs);
}

/**
 * Overrun pop/crackle onsets per second: the signal is high-passed (2nd-order Butterworth, 1 kHz) and
 * cut into consecutive 2 ms blocks from sample 0; a block whose mean-square level (dB) is ≥ 9 dB above
 * the median of the levels of the preceding 50 ms of blocks is "above", and each run of consecutive
 * "above" blocks is one onset. The rate is onsets / the evaluated duration (every whole block after the
 * first 50 ms). null when that duration is under OVERRUN_MIN_SPAN_S = 0.5 s (a clip under 0.55 s: fewer
 * than 275 blocks at 48 kHz). Throws RangeError on a non-positive fs or a non-finite sample.
 */
export function overrunRate(x: ArrayLike<number>, fs: number): number | null {
  assertPositive('overrunRate', 'fs', fs);
  return onsetRate(finiteCopy('overrunRate', x), fs);
}

/**
 * Features of a clip: 0.25 s frames every 0.125 s from sample 0 (whole frames only), each analysed at
 * the mean of rpmAt (seconds from x[0]) over the frame with the firing order `firingsPerRev` (required,
 * see frameFeatures). A frame is dropped when rpmAt is not finite and > 0 somewhere in it, or when it is
 * digitally silent. Clip rules: irregularity (amendment D2.3) is measured over max(0.25 s, 4 cycles at the
 * frame rpm) centred on the frame, shifted to lie inside the frame's run of consecutive kept frames (never
 * over audio whose frames were dropped; the whole run if shorter), so it equals frameFeatures' value at and
 * above 1920 rpm (4-stroke) / 2880 rpm (rotary) and is defined at idle; and a frame keeps its fiLineHz
 * (amendment D5) only inside a run of ≥ 3 consecutive kept frames whose consecutive lines lie within ±5 % of
 * each other (FI_RUN_TOLERANCE; rpmAt plays no part beyond which frames are kept). Kept frames may still hold
 * undefined features (NaN / null, see FrameFeatures).
 * overrunRate is measured over the whole clip for kind 'liftoff' only (else null; null too for a liftoff
 * clip under 0.55 s, see overrunRate).
 */
export function clipFeatures(
  x: ArrayLike<number>,
  fs: number,
  rpmAt: (tS: number) => number,
  step: number,
  kind: string,
  perspective: Perspective,
  firingsPerRev: number,
): ClipFeatures {
  const who = 'clipFeatures';
  assertPositive(who, 'fs', fs);
  assertGrid(who, step, firingsPerRev);
  const sig = finiteCopy(who, x);
  const frameLen = Math.max(1, Math.round(FRAME_S * fs));
  const hop = Math.max(1, Math.round(HOP_S * fs));
  const slots: FrameSlot[] = [];
  for (let h = 0; h * hop + frameLen <= sig.length; h++) {
    const start = h * hop;
    const rpm = frameRpm(rpmAt, start / fs, frameLen / fs);
    if (rpm === null || rmsDb(sig.subarray(start, start + frameLen)) <= SILENT_DB) continue;
    slots.push({ hop: h, start, rpm });
  }
  const frames: FrameFeatures[] = [];
  for (let i = 0; i < slots.length; ) {
    // [i, j]: a run of consecutive kept frames; their irregularity windows stay inside the audio they cover.
    let j = i;
    while ((slots[j + 1]?.hop ?? Number.NaN) === (slots[j]?.hop ?? Number.NaN) + 1) j++;
    const first = slots[i]?.start ?? 0;
    const run = sig.subarray(first, (slots[j]?.start ?? 0) + frameLen);
    for (let m = i; m <= j; m++) {
      const s = slots[m];
      if (s === undefined) continue;
      const irrWindow = irregularityWindow(run, s.start - first, frameLen, fs, s.rpm, step);
      frames.push(analyse(sig.subarray(s.start, s.start + frameLen), fs, s.rpm, step, firingsPerRev, irrWindow));
    }
    i = j + 1;
  }
  keepPersistentLines(frames, slots);
  return { kind, perspective, frames, overrunRate: kind === 'liftoff' ? onsetRate(sig, fs) : null };
}
