import { describe, expect, it } from 'vitest';
import { FracDelay } from '../../src/dsp/delay';

/** Writes an impulse then zeros; returns readFn(d) for each of `len` subsequent states (impulse at age k = 0..len−1). */
function impulseReads(cap: number, len: number, read: (dl: FracDelay) => number): number[] {
  const dl = new FracDelay(cap);
  const out: number[] = [];
  dl.write(1);
  for (let k = 0; k < len; k++) {
    out.push(read(dl));
    dl.write(0);
  }
  return out;
}

describe('FracDelay', () => {
  it('rejects capacities that are not integers ≥ 8', () => {
    expect(() => new FracDelay(7)).toThrow(RangeError);
    expect(() => new FracDelay(16.5)).toThrow(RangeError);
    expect(new FracDelay(64).capacity).toBe(64);
  });

  it('returns exact samples at integer delays, also after the ring wraps (multi-call)', () => {
    const dl = new FracDelay(16);
    for (let n = 0; n < 100; n++) {
      dl.write(n);
      for (let d = 1; d <= 13; d++) {
        if (n - d < 0) continue;
        expect(dl.readLagrange(d)).toBeCloseTo(n - d, 4);
        expect(dl.readLinear(d)).toBe(n - d);
      }
      expect(dl.readLinear(0)).toBe(n);
    }
  });

  it('stores Float32 values', () => {
    const dl = new FracDelay(8);
    dl.write(0.1);
    expect(dl.readLinear(0)).toBe(Math.fround(0.1));
  });

  it('linear interpolation mixes the two neighbours', () => {
    const dl = new FracDelay(16);
    dl.write(2); // delay 1 after the next write
    dl.write(4); // delay 0
    expect(dl.readLinear(0.25)).toBeCloseTo(3.5, 12);
    expect(dl.readLinear(0.5)).toBeCloseTo(3, 12);
  });

  it('Lagrange-3 is exact for cubic signals at any fractional delay', () => {
    const dl = new FracDelay(32);
    const cubic = (t: number) => 0.001 * t * t * t - 0.02 * t * t + 0.3 * t - 1;
    for (let n = 0; n < 20; n++) dl.write(cubic(n));
    // most recent sample is t = 19; delay d → t = 19 − d
    for (const d of [1, 1.25, 2.5, 3.999, 7.3, 12.75]) {
      expect(dl.readLagrange(d)).toBeCloseTo(Math.fround(cubic(19 - d)), 4);
    }
  });

  it('Lagrange-3 impulse response has unity DC gain, group delay d and |H| ≤ 1', () => {
    for (const d of [1, 1.3, 2.5, 5.77, 9.999]) {
      const h = impulseReads(32, 16, (dl) => dl.readLagrange(d));
      let sum = 0;
      let moment = 0;
      for (let k = 0; k < h.length; k++) {
        sum += h[k] ?? 0;
        moment += k * (h[k] ?? 0);
      }
      expect(sum).toBeCloseTo(1, 12);
      expect(moment).toBeCloseTo(d, 9);
      let maxMag = 0;
      for (let i = 0; i <= 512; i++) {
        const w = (Math.PI * i) / 512;
        let re = 0;
        let im = 0;
        for (let k = 0; k < h.length; k++) {
          re += (h[k] ?? 0) * Math.cos(w * k);
          im -= (h[k] ?? 0) * Math.sin(w * k);
        }
        maxMag = Math.max(maxMag, Math.hypot(re, im));
      }
      expect(maxMag).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('clamps delays into the documented ranges and propagates NaN', () => {
    const dl = new FracDelay(8);
    for (let n = 0; n < 8; n++) dl.write(n);
    expect(dl.readLagrange(0)).toBeCloseTo(dl.readLagrange(1), 12);
    expect(dl.readLagrange(100)).toBeCloseTo(dl.readLagrange(5), 12);
    expect(dl.readLinear(-3)).toBe(7);
    expect(dl.readLinear(100)).toBe(dl.readLinear(6));
    expect(Number.isNaN(dl.readLagrange(NaN))).toBe(true);
  });

  it('readLagrangeFixed() equals readLagrange() at the delay given to setLagrangeDelay() (multi-call)', () => {
    const dl = new FracDelay(64);
    expect(dl.readLagrangeFixed()).toBe(0); // fresh line, default delay 1
    let seed = 0.37;
    for (let n = 0; n < 200; n++) {
      seed = (seed * 9301 + 0.49297) % 1;
      dl.write(seed - 0.5);
      if (n === 0) expect(dl.readLagrangeFixed()).toBe(dl.readLagrange(1));
      for (const d of [1, 2.75, 13.01, 60.5, 0.2, 99]) {
        dl.setLagrangeDelay(d);
        expect(dl.readLagrangeFixed()).toBeCloseTo(dl.readLagrange(d), 14);
      }
    }
  });

  it('sumSquares covers the most recent samples and clear() zeroes everything', () => {
    const dl = new FracDelay(8);
    for (const x of [1, 2, 3, 4]) dl.write(x);
    expect(dl.sumSquares(2)).toBe(16 + 9);
    expect(dl.sumSquares(4)).toBe(30);
    expect(dl.sumSquares(100)).toBe(30);
    expect(dl.sumSquares(-1)).toBe(0);
    dl.clear();
    expect(dl.sumSquares(8)).toBe(0);
    expect(dl.readLinear(0)).toBe(0);
    dl.write(5);
    expect(dl.readLinear(0)).toBe(5);
    expect(dl.readLinear(1)).toBe(0);
  });
});
