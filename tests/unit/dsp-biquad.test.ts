import { describe, expect, it } from 'vitest';
import { BUTTER4_Q, Biquad, Cascade } from '../../src/dsp/biquad';

const FS = 48000;

/** Impulse response (n samples) of a processor that starts from rest. */
function impulse(proc: (x: number) => number, n = 1 << 15): Float64Array {
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = proc(i === 0 ? 1 : 0);
  return h;
}

/** |H(f)| in dB of an impulse response. */
function dbAt(h: Float64Array, f: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < h.length; i++) {
    const w = (-2 * Math.PI * f * i) / FS;
    const v = h[i] ?? 0;
    re += v * Math.cos(w);
    im += v * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

function responseDb(proc: (x: number) => number, f: number): number {
  return dbAt(impulse(proc), f);
}

function biquadDb(configure: (b: Biquad) => void, f: number): number {
  const b = new Biquad();
  configure(b);
  return responseDb((x) => b.process(x), f);
}

describe('BUTTER4_Q', () => {
  it('holds the two 4th-order Butterworth section Qs', () => {
    expect(BUTTER4_Q).toHaveLength(2);
    expect(BUTTER4_Q[0]).toBeCloseTo(0.5411961, 7);
    expect(BUTTER4_Q[1]).toBeCloseTo(1.306563, 6);
  });
});

describe('Biquad', () => {
  it('is a pass-through until configured', () => {
    const b = new Biquad();
    expect(b.process(0.7)).toBe(0.7);
    expect(b.process(-0.2)).toBe(-0.2);
  });

  it('lowpass: unity DC, −3.01 dB at the corner with Q = 1/√2, steep stop band', () => {
    const lp = (b: Biquad) => b.lowpass(1000, Math.SQRT1_2, FS);
    expect(biquadDb(lp, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(lp, 1000)).toBeCloseTo(-3.0103, 3);
    expect(biquadDb(lp, 2000)).toBeLessThan(-12);
    expect(biquadDb(lp, 10000)).toBeLessThan(-40);
  });

  it('lowpass with Q = 1/√2 never exceeds 0 dB (passive in-loop filter)', () => {
    for (const fc of [250, 1500, 6000]) {
      const b = new Biquad();
      b.lowpass(fc, Math.SQRT1_2, FS);
      const h = impulse((x) => b.process(x), 4096);
      let max = -Infinity;
      for (let f = 0; f <= FS / 2; f += 50) max = Math.max(max, dbAt(h, f));
      expect(max).toBeLessThan(1e-9);
    }
  });

  it('highpass: zero DC, −3.01 dB at the corner, unity at Nyquist', () => {
    const hp = (b: Biquad) => b.highpass(1000, Math.SQRT1_2, FS);
    expect(biquadDb(hp, 10)).toBeLessThan(-75);
    expect(biquadDb(hp, 1000)).toBeCloseTo(-3.0103, 3);
    expect(biquadDb(hp, FS / 2 - 1)).toBeCloseTo(0, 3);
  });

  it('bandpass: constant 0 dB peak at f0 and no DC', () => {
    const bp = (b: Biquad) => b.bandpass(3000, 2, FS);
    expect(biquadDb(bp, 3000)).toBeCloseTo(0, 6);
    expect(biquadDb(bp, 1500)).toBeLessThan(-9);
    expect(biquadDb(bp, 6000)).toBeLessThan(-9);
    const b = new Biquad();
    b.bandpass(3000, 2, FS);
    let y = 1;
    for (let i = 0; i < 1 << 15; i++) y = b.process(1);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('peaking: +6 dB at f0, 0 dB far away', () => {
    const pk = (b: Biquad) => b.peaking(1000, 1, 6, FS);
    expect(biquadDb(pk, 1000)).toBeCloseTo(6, 6);
    expect(biquadDb(pk, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(pk, FS / 2 - 1)).toBeCloseTo(0, 3);
  });

  it('shelves: low shelf lifts DC by the gain, high shelf cuts Nyquist, half gain at f', () => {
    const ls = (b: Biquad) => b.lowShelf(200, 6, FS);
    expect(biquadDb(ls, 0)).toBeCloseTo(6, 6);
    expect(biquadDb(ls, 200)).toBeCloseTo(3, 3);
    expect(biquadDb(ls, FS / 2 - 1)).toBeCloseTo(0, 3);
    const hs = (b: Biquad) => b.highShelf(2000, -6, FS);
    expect(biquadDb(hs, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(hs, 2000)).toBeCloseTo(-3, 3);
    expect(biquadDb(hs, FS / 2 - 1)).toBeCloseTo(-6, 3);
  });

  it('keeps its state across a coefficient change and clears it on reset (multi-call)', () => {
    const a = new Biquad();
    const b = new Biquad();
    a.lowpass(500, 0.7, FS);
    b.lowpass(500, 0.7, FS);
    for (let i = 0; i < 100; i++) {
      a.process(1);
      b.process(1);
    }
    a.lowpass(800, 0.7, FS); // state kept: continues smoothly from ≈ 1
    const fresh = new Biquad();
    fresh.lowpass(800, 0.7, FS);
    expect(a.process(1)).toBeGreaterThan(0.9);
    expect(fresh.process(1)).toBeLessThan(0.05);
    b.reset();
    b.lowpass(800, 0.7, FS);
    const ref = new Biquad();
    ref.lowpass(800, 0.7, FS);
    for (let i = 0; i < 16; i++) expect(b.process(1)).toBe(ref.process(1));
  });

  it('flushes its decaying tail to exactly 0', () => {
    const b = new Biquad();
    b.lowpass(2000, 0.7, FS);
    b.process(1);
    let y = 1;
    for (let i = 0; i < 20000; i++) y = b.process(0);
    expect(y).toBe(0);
  });

  it('sanitises non-finite or out-of-range parameters into a stable filter', () => {
    const b = new Biquad();
    b.lowpass(NaN, NaN, FS);
    let y = 0;
    for (let i = 0; i < 1000; i++) y = b.process(1);
    expect(Number.isFinite(y)).toBe(true);
    const c = new Biquad();
    c.peaking(1e9, 1, NaN, FS); // corner clamped to 0.49·fs, gain 0 dB
    for (let i = 0; i < 1000; i++) y = c.process(0.5);
    expect(y).toBeCloseTo(0.5, 9);
  });
});

describe('Cascade', () => {
  it('two BUTTER4_Q stages form a 4th-order Butterworth low-pass', () => {
    const c = new Cascade(2);
    c.stage(0).lowpass(1000, BUTTER4_Q[0], FS);
    c.stage(1).lowpass(1000, BUTTER4_Q[1], FS);
    const at = (f: number) => {
      c.reset();
      return responseDb((x) => c.process(x), f);
    };
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(1000)).toBeCloseTo(-3.0103, 3);
    expect(at(2000)).toBeLessThan(-24);
    expect(at(2000)).toBeGreaterThan(-24.6);
  });

  it('applies stages in order and starts as a pass-through', () => {
    const c = new Cascade(3);
    expect(c.process(0.25)).toBe(0.25);
    c.stage(2).peaking(1000, 1, 6, FS);
    c.reset(); // drop the 0.25 already stored in every stage
    const ref = new Biquad();
    ref.peaking(1000, 1, 6, FS);
    for (let i = 0; i < 64; i++) {
      const x = Math.sin(i * 0.3);
      expect(c.process(x)).toBe(ref.process(x));
    }
  });

  it('rejects bad stage counts and out-of-range stage indices', () => {
    expect(() => new Cascade(0)).toThrow(RangeError);
    expect(() => new Cascade(1.5)).toThrow(RangeError);
    const c = new Cascade(2);
    expect(() => c.stage(2)).toThrow(RangeError);
    expect(() => c.stage(-1)).toThrow(RangeError);
  });
});
