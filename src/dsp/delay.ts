/**
 * Fractional delay line (Smith, "Physical Audio Signal Processing": interpolated delay lines).
 * Float32 ring stored twice (buf[i] === buf[i + capacity]) so every read window is contiguous
 * and no read needs a modulo. Delay d is measured in samples from the most recently written one.
 */
export class FracDelay {
  readonly capacity: number;
  private readonly buf: Float32Array;
  /** Index (in [0, capacity)) of the most recently written sample. */
  private w: number;
  private readonly maxLagrange: number;
  private readonly maxLinear: number;
  // kernel cached by setLagrangeDelay() for readLagrangeFixed()
  private fixI = 1;
  private hm1 = 0;
  private h0 = 1;
  private h1 = 0;
  private h2 = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 8) {
      throw new RangeError(`FracDelay capacity must be an integer ≥ 8, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Float32Array(2 * capacity);
    this.w = capacity - 1;
    this.maxLagrange = capacity - 3;
    this.maxLinear = capacity - 2;
  }

  write(x: number): void {
    let w = this.w + 1;
    if (w === this.capacity) w = 0;
    this.w = w;
    this.buf[w] = x;
    this.buf[w + this.capacity] = x;
  }

  /**
   * 3rd-order Lagrange interpolation at delay d (clamped into [1, capacity − 3]; NaN propagates).
   * Uses the samples at delays i−1, i, i+1, i+2 (i = ⌊d⌋), so the fraction always lies in the
   * central interval, where the interpolator has |H(e^jω)| ≤ 1 (passive inside loops).
   */
  readLagrange(d: number): number {
    const dd = d < 1 ? 1 : d > this.maxLagrange ? this.maxLagrange : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const base = this.w + this.capacity - i; // index of the sample at delay i
    const b = this.buf;
    const xm1 = b[base + 1]!;
    const x0 = b[base]!;
    const x1 = b[base - 1]!;
    const x2 = b[base - 2]!;
    const fp1 = f + 1;
    const fm1 = f - 1;
    const fm2 = f - 2;
    return (
      (-f * fm1 * fm2 * xm1) / 6 +
      (fp1 * fm1 * fm2 * x0) / 2 -
      (fp1 * f * fm2 * x1) / 2 +
      (fp1 * f * fm1 * x2) / 6
    );
  }

  /**
   * Precomputes the Lagrange-3 kernel for delay d (clamped exactly like readLagrange) so that
   * readLagrangeFixed() costs four multiply-adds. Call again whenever the delay changes.
   */
  setLagrangeDelay(d: number): void {
    const dd = d < 1 ? 1 : d > this.maxLagrange ? this.maxLagrange : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const fp1 = f + 1;
    const fm1 = f - 1;
    const fm2 = f - 2;
    this.fixI = i;
    this.hm1 = (-f * fm1 * fm2) / 6;
    this.h0 = (fp1 * fm1 * fm2) / 2;
    this.h1 = (-fp1 * f * fm2) / 2;
    this.h2 = (fp1 * f * fm1) / 6;
  }

  /** readLagrange() at the delay last passed to setLagrangeDelay() (delay 1 before the first call). */
  readLagrangeFixed(): number {
    const base = this.w + this.capacity - this.fixI;
    const b = this.buf;
    return this.hm1 * b[base + 1]! + this.h0 * b[base]! + this.h1 * b[base - 1]! + this.h2 * b[base - 2]!;
  }

  /** Linear interpolation at delay d (clamped into [0, capacity − 2]; NaN propagates). */
  readLinear(d: number): number {
    const dd = d < 0 ? 0 : d > this.maxLinear ? this.maxLinear : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const base = this.w + this.capacity - i;
    const b = this.buf;
    const x0 = b[base]!;
    return x0 + f * (b[base - 1]! - x0);
  }

  /** Σ x² over the `count` most recent samples (count clamped into [0, capacity]). Not part of the hot path. */
  sumSquares(count: number): number {
    const n = count < 0 ? 0 : count > this.capacity ? this.capacity : Math.floor(count);
    const b = this.buf;
    const end = this.w + this.capacity; // most recent sample
    let s = 0;
    for (let k = 0; k < n; k++) {
      const v = b[end - k]!;
      s += v * v;
    }
    return s;
  }

  clear(): void {
    this.buf.fill(0);
    this.w = this.capacity - 1;
  }
}
