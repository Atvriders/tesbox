/**
 * Scalar DSP helpers shared by every module in src/dsp (Phase 2a contract, spec §5.4).
 * Environment-free: no DOM, Web Audio, sim or data imports.
 */

const FLUSH_EPS = 1e-20;

/** |x| < 1e-20 → exactly 0 (JS has no flush-to-zero; avoids subnormal stalls). NaN/±Infinity pass through. */
export function flush(x: number): number {
  return x < FLUSH_EPS && x > -FLUSH_EPS ? 0 : x;
}

/** Clamp x into [lo, hi]. NaN passes through unchanged. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Decibels → linear amplitude gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear amplitude gain → decibels, floored at −200 dB (g ≤ 1e-10, 0, negative or NaN → −200). */
export function gainToDb(g: number): number {
  return g > 1e-10 ? 20 * Math.log10(g) : -200;
}

/** Hermite smoothstep 3t² − 2t³ of x between edges e0 and e1 (reversed edges allowed; e0 === e1 → step at e0). */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic PRNG: mulberry32 (bit-identical to the reference sequence for the same uint32 seed)
 * plus Box–Muller normal deviates with a cached second value.
 */
export class Rng {
  private s = 0;
  private spare = 0;
  private hasSpare = false;

  constructor(seed = 1) {
    this.seed(seed);
  }

  /** Restart the sequence from seed `s` (coerced to uint32); also drops a cached gauss() value. */
  seed(s: number): void {
    this.s = s >>> 0;
    this.spare = 0;
    this.hasSpare = false;
  }

  /** Uniform in [0, 1). */
  next(): number {
    const a = (this.s + 0x6d2b79f5) | 0;
    this.s = a;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [−1, 1). */
  bipolar(): number {
    return 2 * this.next() - 1;
  }

  /** Standard normal deviate (mean 0, variance 1). */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const u = 1 - this.next(); // (0, 1]: log() stays finite
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * v;
    this.spare = r * Math.sin(th);
    this.hasSpare = true;
    return r * Math.cos(th);
  }
}

/**
 * One-pole low-pass y += k·(x − y), evaluated as y = k·x + (1 − k)·y so k = 1 is an exact pass-through.
 * Unity DC gain and |H| ≤ 1 at every frequency for 0 ≤ k ≤ 1. A fresh instance has k = 1 and y = 0.
 */
export class OnePole {
  private k = 1;
  private a = 0; // 1 − k
  private state = 0;

  get y(): number {
    return this.state;
  }

  /** Time constant τ in seconds: k = 1 − e^(−1/(τ·fs)). τ ≤ 0 (or NaN) → pass-through (k = 1). */
  setTau(tauS: number, fs: number): void {
    this.setK(tauS > 0 && fs > 0 ? 1 - Math.exp(-1 / (tauS * fs)) : 1);
  }

  /** Corner in Hz: k = 1 − e^(−2π·hz/fs). hz ≤ 0 (or NaN) → k = 0 (the output holds its value). */
  setCutoff(hz: number, fs: number): void {
    this.setK(hz > 0 && fs > 0 ? 1 - Math.exp((-2 * Math.PI * hz) / fs) : 0);
  }

  process(x: number): number {
    const y = flush(this.k * x + this.a * this.state);
    this.state = y;
    return y;
  }

  reset(v = 0): void {
    this.state = v;
  }

  private setK(k: number): void {
    this.k = k;
    this.a = 1 - k;
  }
}

/** Linear slew limiter: y moves toward the target by at most unitsPerS/fs per process() call. */
export class Slew {
  private maxStep = Infinity;
  private state = 0;

  get y(): number {
    return this.state;
  }

  /** unitsPerS ≤ 0 or NaN → unlimited (y jumps straight to the target). */
  setRate(unitsPerS: number, fs: number): void {
    this.maxStep = unitsPerS > 0 && fs > 0 ? unitsPerS / fs : Infinity;
  }

  process(target: number): number {
    const s = this.state;
    const d = target - s;
    const m = this.maxStep;
    const y = d > m ? s + m : d < -m ? s - m : target;
    this.state = y;
    return y;
  }

  reset(v: number): void {
    this.state = v;
  }
}
