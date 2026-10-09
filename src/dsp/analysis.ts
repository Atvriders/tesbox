/**
 * Offline signal analysis for tests and tools (spec §11.3, §14). Allocates freely — never call from
 * the audio thread. Pure functions; no imports from sim/data/ui/DOM.
 */
import { OS_FACTOR, OS_TAPS, Upsampler4 } from './oversample';
import { gainToDb } from './util';

/**
 * Upsampler4 pushes before its input history (one polyphase branch: 48 / 4 = 12 samples) holds only
 * signal samples: the outputs of pushes 0..10 still interpolate the implicit zeros before x[0].
 */
const TP_WARM_PUSHES = Math.ceil(OS_TAPS.length / OS_FACTOR) - 1;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** In-place iterative radix-2 complex FFT (forward, e^(−i2πkn/N), unnormalised). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new RangeError('fft: re and im must have the same length');
  if (!isPowerOfTwo(n)) throw new RangeError(`fft: length ${n} is not a power of two`);
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = (-2 * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k);
      const wi = Math.sin(step * k);
      for (let a = k; a < n; a += len) {
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
      }
    }
  }
}

/** Symmetric Hann window: w[i] = 0.5 − 0.5·cos(2πi/(n−1)); n = 1 → [1]. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** |X(ω)|² of an already-windowed signal at `cyclesPerSample` via the Goertzel recursion. */
function goertzelPower(x: Float64Array, cyclesPerSample: number): number {
  const coeff = 2 * Math.cos(2 * Math.PI * cyclesPerSample);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = (x[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Energy (linear power) at orders k·step for k = 1..floor(maxOrder/step), base frequency rpm/60;
 * Hann-windowed Goertzel over the whole signal. Normalised so that a sine of amplitude A exactly at
 * an order's frequency yields A²/2 (its mean power) in that entry. Entries whose frequency is at or
 * above Nyquist are 0. Index i holds order (i + 1)·step.
 */
export function orderSpectrum(
  signal: ArrayLike<number>,
  fs: number,
  rpm: number,
  maxOrder: number,
  step: number,
): Float64Array {
  const count = step > 0 ? Math.max(0, Math.floor(maxOrder / step + 1e-9)) : 0;
  const out = new Float64Array(count);
  const n = signal.length;
  if (n === 0 || count === 0) return out;
  const w = hann(n);
  const xw = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i] ?? 0;
    wsum += wi;
    xw[i] = (signal[i] ?? 0) * wi;
  }
  const norm = 2 / (wsum * wsum);
  const base = rpm / 60;
  for (let k = 1; k <= count; k++) {
    const f = k * step * base;
    out[k - 1] = f > 0 && f < fs / 2 ? goertzelPower(xw, f / fs) * norm : 0;
  }
  return out;
}

/**
 * True peak in dBTP: max of |x| over every sample and of the 4× (Upsampler4) interpolated samples whose
 * whole input history lies inside the signal; silence/empty → −200; NaN if any sample is NaN. Neither
 * end is zero-padded (contract B14): implicit zeros before x[0] (a buffer cut from a running signal can
 * start loud) or after the last sample would be a step — a Gibbs overshoot that is not in the signal —
 * so the first and last ≈ 5 input intervals count by their sample peaks only.
 */
export function truePeakDbtp(signal: ArrayLike<number>): number {
  const up = new Upsampler4();
  up.reset();
  const n = signal.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = signal[i] ?? 0;
    if (x !== x) return Number.NaN;
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    up.push(x);
    if (i < TP_WARM_PUSHES) continue; // the history still reaches back before x[0]
    for (let j = 0; j < OS_FACTOR; j++) {
      const v = Math.abs(up.out[j] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return gainToDb(peak);
}

/**
 * RMS level in dB re amplitude 1 (a full-scale sine reads −3.01 dB); empty/silent → −200; NaN if any
 * sample is NaN (a corrupt buffer must not read as silence: gainToDb maps NaN to −200).
 */
export function rmsDb(signal: ArrayLike<number>): number {
  const n = signal.length;
  if (n === 0) return gainToDb(0);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = signal[i] ?? 0;
    s += x * x;
  }
  if (s !== s) return Number.NaN;
  return gainToDb(Math.sqrt(s / n));
}

/**
 * Energy in [loHz, hiHz] (inclusive bin centres) of the Hann-windowed, zero-padded FFT, in dB relative
 * to a full-scale sine (amplitude 1) whose energy lies entirely inside the band. Silence, empty input
 * or hiHz < loHz → −200. NaN if any sample is NaN or the measured bins are NaN (e.g. from ±Infinity
 * samples): a corrupt buffer never reads as silence.
 */
export function bandEnergyDb(signal: ArrayLike<number>, fs: number, loHz: number, hiHz: number): number {
  const len = signal.length;
  if (len === 0 || !(hiHz >= loHz)) return gainToDb(0);
  let n = 1;
  while (n < len) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(len);
  let w2 = 0;
  for (let i = 0; i < len; i++) {
    const x = signal[i] ?? 0;
    if (x !== x) return Number.NaN;
    const wi = w[i] ?? 0;
    re[i] = x * wi;
    w2 += wi * wi;
  }
  if (w2 === 0) return gainToDb(0);
  fft(re, im);
  const half = n >> 1;
  const df = fs / n;
  let e = 0;
  for (let k = 0; k <= half; k++) {
    const f = k * df;
    if (f < loHz || f > hiHz) continue;
    const r = re[k] ?? 0;
    const q = im[k] ?? 0;
    const p = r * r + q * q;
    e += k === 0 || k === half ? p : 2 * p;
  }
  if (e !== e) return Number.NaN;
  const ref = (n * w2) / 2;
  return gainToDb(Math.sqrt(e / ref));
}

/** The topN orders ((index + 1)·step) sorted by energy, descending; ties → lower order first; NaN sorts last. */
export function dominantOrders(spectrum: Float64Array, step: number, topN: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < spectrum.length; i++) idx.push(i);
  const val = (i: number): number => {
    const v = spectrum[i] ?? 0;
    return v === v ? v : Number.NEGATIVE_INFINITY;
  };
  idx.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (vb > va) return 1;
    if (vb < va) return -1;
    return a - b;
  });
  return idx.slice(0, Math.max(0, Math.floor(topN))).map((i) => (i + 1) * step);
}
