/**
 * 4× polyphase upsampler shared by the true-peak limiter (output stage) and analysis (ITU-R BS.1770
 * style true-peak measurement). The interpolation filter is designed here at module load from the
 * Kaiser-window method (Kaiser 1974): a 48-tap windowed sinc, β = 8, cutoff 0.45·fs_in.
 */

export const OS_FACTOR = 4;

const TAP_COUNT = 48;
const KAISER_BETA = 8;
/** Cutoff in cycles per OUTPUT sample: 0.45·fs_in / (4·fs_in). */
const CUTOFF = 0.45 / OS_FACTOR;
/** Input samples of history each polyphase branch needs: 48 / 4. */
const HISTORY = TAP_COUNT / OS_FACTOR;

/** Zeroth-order modified Bessel function of the first kind, I0(x), by its power series. */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * h[n] = 2fc·sinc(2fc·(n − M)) · I0(β·√(1 − ((n − M)/M)²)) / I0(β), M = (N − 1)/2, then scaled so
 * Σh = OS_FACTOR (zero-stuffing loses a factor 4; each polyphase branch then has ≈ unity DC gain).
 */
function designTaps(): Float64Array {
  const taps = new Float64Array(TAP_COUNT);
  const mid = (TAP_COUNT - 1) / 2; // 23.5: never an integer, so the sinc argument is never 0
  const i0Beta = besselI0(KAISER_BETA);
  let sum = 0;
  for (let n = 0; n < TAP_COUNT; n++) {
    const t = n - mid;
    const arg = Math.PI * 2 * CUTOFF * t;
    const sinc = Math.sin(arg) / arg;
    const r = t / mid;
    const w = besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0Beta;
    const v = 2 * CUTOFF * sinc * w;
    taps[n] = v;
    sum += v;
  }
  const g = OS_FACTOR / sum;
  for (let n = 0; n < TAP_COUNT; n++) taps[n] = (taps[n] ?? 0) * g;
  return taps;
}

/** 48-tap Kaiser (β = 8) windowed-sinc low-pass, cutoff 0.45·fs_in, Σ = 4 (normalised for 4× upsampling). */
export const OS_TAPS: Float64Array = designTaps();

/**
 * Zero-stuffing 4× interpolator in polyphase form. After push(x[k]):
 * out[p] = Σ_{m=0..11} OS_TAPS[p + 4m] · x[k − m], p = 0..3 (output times 4k + p).
 * Group delay: 23.5 output samples = 5.875 input samples.
 */
export class Upsampler4 {
  /** The 4 upsampled samples belonging to the most recent push (overwritten in place). */
  readonly out = new Float64Array(OS_FACTOR);
  /** Input history, mirrored (h[i] === h[i + 12]) so every read window is contiguous. */
  private readonly hist = new Float64Array(2 * HISTORY);
  private pos = 0;

  reset(): void {
    this.hist.fill(0);
    this.out.fill(0);
    this.pos = 0;
  }

  push(x: number): void {
    let p = this.pos - 1;
    if (p < 0) p = HISTORY - 1;
    this.pos = p;
    const h = this.hist;
    h[p] = x;
    h[p + HISTORY] = x; // x[k − m] now sits at h[p + m] for m = 0..11
    const t = OS_TAPS;
    const out = this.out;
    for (let ph = 0; ph < OS_FACTOR; ph++) {
      let acc = 0;
      for (let m = 0; m < HISTORY; m++) acc += t[ph + OS_FACTOR * m]! * h[p + m]!;
      out[ph] = acc;
    }
  }
}
