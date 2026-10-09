/**
 * RBJ Audio-EQ-Cookbook biquads (R. Bristow-Johnson), Direct Form I with double-precision state.
 * The output state is flushed (|y| < 1e-20 → 0) on every sample. Coefficient setters keep the
 * filter state (safe for slow parameter sweeps); reset() clears the state and keeps the coefficients.
 */
import { flush } from './util';

/** Q of the two biquad sections of a 4th-order Butterworth filter: 1/(2·cos(π/8)), 1/(2·cos(3π/8)). */
export const BUTTER4_Q: readonly [number, number] = [
  1 / (2 * Math.cos(Math.PI / 8)),
  1 / (2 * Math.cos((3 * Math.PI) / 8)),
];

/** Corner frequency clamped into [1 Hz, 0.49·fs]; NaN → 1 Hz. */
function corner(f: number, fs: number): number {
  const hi = 0.49 * fs;
  return f > 1 ? (f < hi ? f : hi) : 1;
}

/** Q clamped to ≥ 1e-3; NaN → 1e-3. */
function quality(q: number): number {
  return q > 1e-3 ? q : 1e-3;
}

/** Shelf/peak gain in dB; non-finite → 0 dB. */
function decibels(g: number): number {
  return Number.isFinite(g) ? g : 0;
}

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  lowpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  highpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  /** Band-pass with constant 0 dB peak gain at f. */
  bandpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }

  /** Low shelf, shelf slope S = 1. */
  lowShelf(f: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / Math.SQRT2; // sin(w)/2 · √((A + 1/A)(1/S − 1) + 2) with S = 1
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cs + sq),
      2 * A * (A - 1 - (A + 1) * cs),
      A * (A + 1 - (A - 1) * cs - sq),
      A + 1 + (A - 1) * cs + sq,
      -2 * (A - 1 + (A + 1) * cs),
      A + 1 + (A - 1) * cs - sq,
    );
  }

  /** High shelf, shelf slope S = 1. */
  highShelf(f: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cs + sq),
      -2 * A * (A - 1 + (A + 1) * cs),
      A * (A + 1 + (A - 1) * cs - sq),
      A + 1 - (A - 1) * cs + sq,
      2 * (A - 1 - (A + 1) * cs),
      A + 1 - (A - 1) * cs - sq,
    );
  }

  peaking(f: number, q: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }

  process(x: number): number {
    const y = flush(
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2,
    );
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
  }
}

/** Series chain of biquads, applied in index order. Every stage starts as a pass-through. */
export class Cascade {
  private readonly stages: Biquad[] = [];

  constructor(stages: number) {
    if (!Number.isInteger(stages) || stages < 1) {
      throw new RangeError(`Cascade needs a positive integer stage count, got ${stages}`);
    }
    for (let i = 0; i < stages; i++) this.stages.push(new Biquad());
  }

  /** The live Biquad of stage i (configure it in place). */
  stage(i: number): Biquad {
    const s = this.stages[i];
    if (s === undefined) throw new RangeError(`Cascade stage ${i} out of range [0, ${this.stages.length})`);
    return s;
  }

  process(x: number): number {
    const st = this.stages;
    let y = x;
    for (let i = 0; i < st.length; i++) y = st[i]!.process(y);
    return y;
  }

  reset(): void {
    for (let i = 0; i < this.stages.length; i++) this.stages[i]!.reset();
  }
}
