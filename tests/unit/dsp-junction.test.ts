import { describe, expect, it } from 'vitest';
import { Junction, MAX_REFLECTION, terminationReflect } from '../../src/dsp/junction';
import { Rng } from '../../src/dsp/util';

function power(y: ArrayLike<number>, p: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += (y[i] ?? 0) * (p[i] ?? 0) ** 2;
  return s;
}

describe('Junction', () => {
  it('validates its construction and configuration', () => {
    expect(() => new Junction(0)).toThrow(RangeError);
    expect(() => new Junction(2.5)).toThrow(RangeError);
    const j = new Junction(3);
    expect(j.ports).toBe(0);
    expect(() => j.configure([1, 1, 1, 1], 4)).toThrow(RangeError);
    expect(() => j.configure([1], 2)).toThrow(RangeError);
    expect(() => j.configure([1, 0], 2)).toThrow(RangeError);
    expect(() => j.configure([1, NaN], 2)).toThrow(RangeError);
    expect(() => j.configure([1, Infinity], 2)).toThrow(RangeError);
    expect(j.ports).toBe(0); // failed configure changed nothing
  });

  it('a rejected configure() leaves the previous configuration in force (multi-call)', () => {
    const j = new Junction(2);
    j.configure([1, 3], 2);
    const inc = new Float64Array([1, 0]);
    const out = new Float64Array(2);
    const rejected: Array<[number[], number]> = [
      [[5, NaN], 2],
      [[1, -2], 2],
      [[1, -Infinity], 2],
      [[-1, 3], 2],
      [[0], 1],
      [[1, 3, 1], 3],
      [[1], 2],
      [[1, 3], 1.5],
      [[1, 3], 0],
    ];
    for (const [y, n] of rejected) {
      expect(() => j.configure(y, n)).toThrow(RangeError);
      expect(j.ports).toBe(2);
      j.scatter(inc, out);
      expect(Array.from(out)).toEqual([-0.5, 0.5]); // still Y = [1, 3]
    }
  });

  it('equal 2-port is transparent; 1:3 area step gives r = −0.5, t = 0.5', () => {
    const j = new Junction(2);
    const inc = new Float64Array(2);
    const out = new Float64Array(2);
    j.configure([2, 2], 2);
    inc[0] = 0.8;
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(0, 15);
    expect(out[1]).toBeCloseTo(0.8, 15);
    j.configure([1, 3], 2); // reconfigure (multi-call)
    inc[0] = 1;
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(-0.5, 15); // (Y1 − Y2)/(Y1 + Y2)
    expect(out[1]).toBeCloseTo(0.5, 15); // 2·Y1/(Y1 + Y2)
    // the reverse direction: contraction gives r = +0.5, pressure transmission 1.5
    inc[0] = 0;
    inc[1] = 1;
    j.scatter(inc, out);
    expect(out[1]).toBeCloseTo(0.5, 15);
    expect(out[0]).toBeCloseTo(1.5, 15);
  });

  it('a single port reflects totally (closed end)', () => {
    const j = new Junction(4);
    j.configure([5], 1);
    const inc = new Float64Array([0.3, 9, 9, 9]);
    const out = new Float64Array(4).fill(7);
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(0.3, 15);
    expect(Array.from(out.subarray(1))).toEqual([7, 7, 7]); // untouched beyond `ports`
  });

  it('conserves admittance-weighted power exactly for random admittances and waves', () => {
    const rng = new Rng(2024);
    const j = new Junction(17);
    const inc = new Float64Array(17);
    const out = new Float64Array(17);
    const y = new Float64Array(17);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng.next() * 17);
      for (let i = 0; i < n; i++) {
        y[i] = 0.05 + 5 * rng.next();
        inc[i] = rng.bipolar();
      }
      j.configure(y, n);
      expect(j.ports).toBe(n);
      j.scatter(inc, out);
      const pin = power(y, inc, n);
      expect(Math.abs(power(y, out, n) - pin)).toBeLessThan(1e-12 * Math.max(1, pin));
      // all ports share one junction pressure p⁺ + p⁻
      const pJ = (inc[0] ?? 0) + (out[0] ?? 0);
      for (let i = 1; i < n; i++) expect((inc[i] ?? 0) + (out[i] ?? 0)).toBeCloseTo(pJ, 12);
    }
  });

  it('copies the admittances (later edits of the source array have no effect)', () => {
    const y = [1, 3];
    const j = new Junction(2);
    j.configure(y, 2);
    y[1] = 1;
    const inc = new Float64Array([1, 0]);
    const out = new Float64Array(2);
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(-0.5, 15);
  });
});

describe('terminationReflect', () => {
  it('returns r·x for |r| < 1 and clamps |r| to 0.999', () => {
    expect(terminationReflect(2, 0.95)).toBeCloseTo(1.9, 15);
    expect(terminationReflect(2, -0.9)).toBeCloseTo(-1.8, 15);
    expect(MAX_REFLECTION).toBe(0.999);
    expect(terminationReflect(1, 1.5)).toBe(0.999);
    expect(terminationReflect(1, -7)).toBe(-0.999);
    expect(Number.isNaN(terminationReflect(1, NaN))).toBe(true);
  });
});
