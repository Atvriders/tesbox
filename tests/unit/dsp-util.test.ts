import { describe, expect, it } from 'vitest';
import {
  OnePole,
  Rng,
  Slew,
  clamp,
  dbToGain,
  flush,
  gainToDb,
  smoothstep,
} from '../../src/dsp/util';

const FS = 48000;

describe('flush', () => {
  it('maps |x| < 1e-20 to exactly 0 and passes everything else through', () => {
    expect(flush(1e-21)).toBe(0);
    expect(flush(-9.99e-21)).toBe(0);
    expect(Object.is(flush(-1e-30), 0)).toBe(true); // +0, never −0
    expect(flush(1e-20)).toBe(1e-20);
    expect(flush(-0.5)).toBe(-0.5);
    expect(flush(Infinity)).toBe(Infinity);
    expect(Number.isNaN(flush(NaN))).toBe(true);
  });
});

describe('clamp', () => {
  it('limits to [lo, hi] and lets NaN through', () => {
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(2, -1, 1)).toBe(1);
    expect(clamp(0.25, -1, 1)).toBe(0.25);
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true);
  });
});

describe('dbToGain / gainToDb', () => {
  it('converts both ways', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(20)).toBeCloseTo(10, 12);
    expect(dbToGain(-6.020599913279624)).toBeCloseTo(0.5, 12);
    expect(gainToDb(10)).toBeCloseTo(20, 12);
    expect(gainToDb(dbToGain(-37.5))).toBeCloseTo(-37.5, 10);
  });

  it('is −Infinity-safe: g ≤ 0, NaN or below 1e-10 → −200', () => {
    expect(gainToDb(0)).toBe(-200);
    expect(gainToDb(-1)).toBe(-200);
    expect(gainToDb(NaN)).toBe(-200);
    expect(gainToDb(1e-12)).toBe(-200);
  });
});

describe('smoothstep', () => {
  it('is 0 below e0, 1 above e1, ½ at the midpoint, with zero slope at the edges', () => {
    expect(smoothstep(-0.08, 0.02, -1)).toBe(0);
    expect(smoothstep(-0.08, 0.02, 1)).toBe(1);
    expect(smoothstep(-0.08, 0.02, -0.03)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, 1e-4)).toBeLessThan(1e-7);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 12);
  });

  it('handles reversed and equal edges', () => {
    expect(smoothstep(1, 0, 0.25)).toBeCloseTo(1 - 0.15625, 12);
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0);
    expect(smoothstep(0.5, 0.5, 0.5)).toBe(1);
  });
});

describe('Rng', () => {
  it('reproduces the mulberry32 reference sequence', () => {
    const a = new Rng(1);
    expect(a.next()).toBe(0.6270739405881613);
    expect(a.next()).toBe(0.002735721180215478);
    expect(a.next()).toBe(0.5274470399599522);
    const b = new Rng(42);
    expect(b.next()).toBe(0.6011037519201636);
    expect(b.next()).toBe(0.44829055899754167);
    expect(b.next()).toBe(0.8524657934904099);
    expect(new Rng(0).next()).toBe(0.26642920868471265);
  });

  it('defaults to seed 1 and restarts on seed()', () => {
    const a = new Rng();
    const first = [a.next(), a.next(), a.next()];
    a.seed(1);
    expect([a.next(), a.next(), a.next()]).toEqual(first);
    expect(first[0]).toBe(new Rng(1).next());
  });

  it('next() is uniform in [0, 1) and bipolar() in [−1, 1)', () => {
    const r = new Rng(7);
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const x = r.next();
      sum += x;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(1);
    expect(sum / n).toBeCloseTo(0.5, 2);
    let bl = Infinity;
    let bh = -Infinity;
    let bsum = 0;
    for (let i = 0; i < n; i++) {
      const x = r.bipolar();
      bsum += x;
      bl = Math.min(bl, x);
      bh = Math.max(bh, x);
    }
    expect(bl).toBeGreaterThanOrEqual(-1);
    expect(bh).toBeLessThan(1);
    expect(bl).toBeLessThan(-0.999);
    expect(bh).toBeGreaterThan(0.999);
    expect(bsum / n).toBeCloseTo(0, 2);
  });

  it('gauss() has mean 0 and variance 1 and uses the cached pair', () => {
    const r = new Rng(3);
    const n = 200000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const g = r.gauss();
      expect(Number.isFinite(g)).toBe(true);
      s += g;
      s2 += g * g;
    }
    const mean = s / n;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(s2 / n - mean * mean).toBeCloseTo(1, 1);
    // Two gauss() calls consume exactly two next() draws (one Box–Muller pair).
    const a = new Rng(11);
    a.gauss();
    a.gauss();
    const b = new Rng(11);
    b.next();
    b.next();
    expect(a.next()).toBe(b.next());
  });

  it('seed() drops a cached gauss() value', () => {
    const a = new Rng(5);
    a.gauss(); // caches the second value of the pair
    a.seed(9);
    expect(a.gauss()).toBe(new Rng(9).gauss());
  });
});

describe('OnePole', () => {
  it('is a pass-through before configuration', () => {
    const p = new OnePole();
    expect(p.process(0.3)).toBe(0.3);
    expect(p.process(-2)).toBe(-2);
    expect(p.y).toBe(-2);
  });

  it('setCutoff gives the exact exponential step response and unity DC gain (multi-call)', () => {
    const p = new OnePole();
    p.setCutoff(1000, FS);
    const k = 1 - Math.exp((-2 * Math.PI * 1000) / FS);
    let y = 0;
    for (let n = 1; n <= 200; n++) {
      y = p.process(1);
      expect(y).toBeCloseTo(1 - Math.pow(1 - k, n), 12);
    }
    expect(y).toBeCloseTo(1, 9);
    expect(p.y).toBe(y);
  });

  it('setTau reaches 1 − e^(−1) after τ·fs samples', () => {
    const p = new OnePole();
    p.setTau(0.01, FS);
    let y = 0;
    for (let n = 0; n < 480; n++) y = p.process(1);
    expect(y).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('never amplifies a sinusoid (|H| ≤ 1)', () => {
    const p = new OnePole();
    p.setCutoff(3000, FS);
    let peak = 0;
    for (let n = 0; n < 48000; n++) {
      const y = p.process(Math.sin((2 * Math.PI * 200 * n) / FS));
      if (n > 4800) peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.99);
  });

  it('flushes its decaying tail to exactly 0 and reset() sets the state', () => {
    const p = new OnePole();
    p.setCutoff(5000, FS);
    p.reset(1);
    expect(p.y).toBe(1);
    let y = 1;
    for (let n = 0; n < 2000; n++) y = p.process(0);
    expect(y).toBe(0);
    p.reset();
    expect(p.y).toBe(0);
  });

  it('setCutoff(≤ 0) holds the output and setTau(≤ 0) passes through', () => {
    const p = new OnePole();
    p.reset(0.4);
    p.setCutoff(0, FS);
    expect(p.process(1)).toBe(0.4);
    p.setTau(0, FS);
    expect(p.process(1)).toBe(1);
  });
});

describe('Slew', () => {
  it('passes straight through until a rate is set', () => {
    const s = new Slew();
    expect(s.process(5)).toBe(5);
    expect(s.y).toBe(5);
  });

  it('moves at most unitsPerS/fs per call and lands exactly on the target (multi-call)', () => {
    const s = new Slew();
    s.setRate(1 / 0.2, FS); // full scale in 200 ms
    s.reset(0);
    const step = 1 / (0.2 * FS);
    let prev = 0;
    let calls = 0;
    while (s.y !== 1 && calls < 20000) {
      const y = s.process(1);
      expect(y - prev).toBeLessThanOrEqual(step * (1 + 1e-12));
      prev = y;
      calls++;
    }
    expect(s.y).toBe(1);
    expect(calls).toBe(Math.ceil(0.2 * FS));
    // reverses with the same limit
    const down = s.process(0);
    expect(1 - down).toBeCloseTo(step, 15);
  });

  it('reset() jumps immediately; rate ≤ 0 means unlimited', () => {
    const s = new Slew();
    s.setRate(1, FS);
    s.reset(0.75);
    expect(s.y).toBe(0.75);
    s.setRate(0, FS);
    expect(s.process(-3)).toBe(-3);
  });
});
