import { describe, expect, it } from 'vitest';
import { terminationReflect } from '../../src/dsp/junction';
import { MIN_DELAY_SAMPLES, Waveguide } from '../../src/dsp/waveguide';

const FS = 48000;
const C = 343;
/** Length (m) whose delay at 343 m/s and 48 kHz is `d` samples. */
const lenFor = (d: number): number => (d * C) / FS;

/** Impulse into the right rail at end A; returns outRight() for n samples. */
function rightImpulse(wg: Waveguide, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(wg.outRight());
    wg.outLeft();
    wg.input(i === 0 ? 1 : 0, 0);
  }
  return out;
}

/** Closed–closed tube: both ends reflect with r; an impulse enters at A. Returns energy() after every sample. */
function resonate(wg: Waveguide, r: number, n: number): Float64Array {
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const atB = wg.outRight();
    const atA = wg.outLeft();
    wg.input((i === 0 ? 1 : 0) + terminationReflect(atA, r), terminationReflect(atB, r));
    e[i] = wg.energy();
  }
  return e;
}

function windowMaxima(e: Float64Array, win: number): number[] {
  const m: number[] = [];
  for (let i = 0; i < e.length; i += win) {
    let x = 0;
    for (let k = i; k < Math.min(i + win, e.length); k++) x = Math.max(x, e[k] ?? 0);
    m.push(x);
  }
  return m;
}

describe('Waveguide', () => {
  it('validates configure (≥ 4 samples at 700 m/s, ≤ capacity − 2, positive finite arguments)', () => {
    const wg = new Waveguide(256);
    expect(MIN_DELAY_SAMPLES).toBe(4);
    expect(() => wg.configure(0.05, C, FS, 0)).toThrow(RangeError); // 3.43 samples at 700 m/s
    expect(() => wg.configure(1.9, C, FS, 0)).toThrow(RangeError); // 265.9 samples > 254
    expect(() => wg.configure(0, C, FS, 0)).toThrow(RangeError);
    expect(() => wg.configure(0.5, -1, FS, 0)).toThrow(RangeError);
    expect(() => wg.configure(0.5, C, NaN, 0)).toThrow(RangeError);
    expect(() => wg.configure(0.06, 1000, FS, 0)).toThrow(RangeError); // 4.11 samples at 700 m/s, but only 2.88 at 1000 m/s
    wg.configure(0.06, C, FS, 0); // 4.11 samples at 700 m/s: allowed
    expect(wg.delaySamples).toBeCloseTo((0.06 / C) * FS, 12);
  });

  it('before configure() it is a lossless MIN_DELAY_SAMPLES delay and setSpeed() is harmless (multi-call)', () => {
    const wg = new Waveguide(64);
    for (const afterSetSpeed of [false, true]) {
      if (afterSetSpeed) {
        wg.setSpeed(C); // no length or sample rate yet: clamps to the minimum delay
        wg.setSpeed(-1);
        wg.setSpeed(NaN);
      }
      expect(wg.delaySamples).toBe(MIN_DELAY_SAMPLES);
      // the reported delay is the real one: an impulse into each rail arrives exactly 4 samples later
      for (let i = 0; i < 12; i++) {
        expect(wg.outRight()).toBe(i === MIN_DELAY_SAMPLES ? 1 : 0);
        expect(wg.outLeft()).toBe(i === MIN_DELAY_SAMPLES ? 0.5 : 0);
        wg.input(i === 0 ? 1 : 0, i === 0 ? 0.5 : 0);
      }
    }
  });

  it('delays each rail by exactly delaySamples (integer delay, lossless)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    expect(wg.delaySamples).toBeCloseTo(48, 9);
    const h = rightImpulse(wg, 100);
    h.forEach((v, i) => expect(v).toBeCloseTo(i === 48 ? 1 : 0, 9));
    // the left rail is independent: impulse at B arrives at A after 48 samples
    wg.clear();
    const left: number[] = [];
    for (let i = 0; i < 100; i++) {
      wg.outRight();
      left.push(wg.outLeft());
      wg.input(0, i === 0 ? 1 : 0);
    }
    left.forEach((v, i) => expect(v).toBeCloseTo(i === 48 ? 1 : 0, 9));
  });

  it('fractional delays keep unity DC gain and a group delay of exactly delaySamples', () => {
    const wg = new Waveguide(256);
    for (const d of [8.5, 37.3, 100.75]) {
      wg.configure(lenFor(d), C, FS, 0);
      const h = rightImpulse(wg, 140);
      let sum = 0;
      let moment = 0;
      h.forEach((v, i) => {
        sum += v;
        moment += i * v;
      });
      expect(sum).toBeCloseTo(1, 6);
      expect(moment / sum).toBeCloseTo(d, 5);
    }
  });

  it('the wall-loss low-pass keeps DC and removes energy (|H| ≤ 1)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(30), C, FS, 2000);
    const h = rightImpulse(wg, 250);
    const sum = h.reduce((a, b) => a + b, 0);
    const energy = h.reduce((a, b) => a + b * b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(energy).toBeLessThan(0.3);
    expect(h.slice(0, 29).every((v) => Math.abs(v) < 1e-9)).toBe(true); // nothing before the delay
  });

  it('lossHz ≥ fs/2 or ≤ 0 leaves both rails lossless', () => {
    const wg = new Waveguide(256);
    for (const lossHz of [FS / 2, FS, -1]) {
      wg.configure(lenFor(48), C, FS, lossHz);
      for (let i = 0; i < 100; i++) {
        expect(wg.outRight()).toBeCloseTo(i === 48 ? 1 : 0, 12);
        expect(wg.outLeft()).toBeCloseTo(i === 48 ? 1 : 0, 12);
        wg.input(i === 0 ? 1 : 0, i === 0 ? 1 : 0);
      }
    }
  });

  it('lossless integer-delay resonator loses exactly r² per reflection', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    const r = 0.999;
    const e = resonate(wg, r, 96 * 101);
    for (let k = 0; k <= 100; k++) {
      // 10 samples after the k-th round trip the pulse sits mid-rail: energy = r^(4k) (Float32 rails)
      const ref = Math.pow(r, 4 * k);
      expect(Math.abs((e[96 * k + 10] ?? 0) - ref) / ref).toBeLessThan(1e-5);
    }
  });

  it('is passive with wall loss and fractional delays: round-trip window maxima never rise and decay to −120 dB', () => {
    for (const [d, loss] of [
      [37.37, 6000],
      [100.5, 3000],
    ] as const) {
      const wg = new Waveguide(256);
      wg.configure(lenFor(d), C, FS, loss);
      const e = resonate(wg, 0.95, 48000);
      const m = windowMaxima(e, Math.ceil(2 * d));
      for (let i = 1; i < m.length; i++) expect(m[i]).toBeLessThanOrEqual((m[i - 1] ?? 0) * (1 + 1e-12));
      expect(e[e.length - 1]).toBeLessThan(1e-12 * (m[0] ?? 0));
    }
  });

  it('is passive with lossless fractional delays: energy stays under the reflection envelope', () => {
    // Window maxima cannot judge this case: the ≈ 2× swing of energy() around each reflection peaks
    // higher or lower (by up to ≈ 0.6 %) depending on how the pulse lines up with the sample grid,
    // which is more than a round trip loses at r = 0.999. A passive loop instead keeps
    // energy ≤ 2·r^(2·max(j − 1, 0)) after j = ⌊t/d⌋ reflections (old + reflected pulse while they overlap).
    const r = 0.999;
    for (const d of [36.97, 37.37, 39.71, 100.5]) {
      const wg = new Waveguide(256);
      wg.configure(lenFor(d), C, FS, 0);
      const e = resonate(wg, r, 48000);
      let worst = 0;
      for (let t = 0; t < e.length; t++) {
        const j = Math.floor(t / d);
        worst = Math.max(worst, (e[t] ?? 0) / Math.pow(r, 2 * Math.max(j - 1, 0)));
      }
      expect(worst).toBeLessThanOrEqual(2);
    }
  });

  it('setSpeed rescales the delay, clamps it and ignores c ≤ 0 (multi-call)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    wg.setSpeed(2 * C);
    expect(wg.delaySamples).toBeCloseTo(24, 9);
    const h = rightImpulse(wg, 60);
    h.forEach((v, i) => expect(v).toBeCloseTo(i === 24 ? 1 : 0, 9));
    wg.setSpeed(-5);
    wg.setSpeed(NaN);
    expect(wg.delaySamples).toBeCloseTo(24, 9);
    wg.setSpeed(1e6);
    expect(wg.delaySamples).toBe(MIN_DELAY_SAMPLES);
    wg.setSpeed(1);
    expect(wg.delaySamples).toBe(254);
  });

  it('outPair()/inputPair() are exact boxing-free equivalents of outRight()/outLeft()/input()', () => {
    const a = new Waveguide(256);
    const b = new Waveguide(256);
    a.configure(lenFor(23.6), C, FS, 5000);
    b.configure(lenFor(23.6), C, FS, 5000);
    const arr = new Float64Array(4);
    const inp = new Float64Array(4);
    for (let n = 0; n < 500; n++) {
      const ra = a.outRight();
      const la = a.outLeft();
      b.outPair(arr, 2);
      expect(arr[2]).toBe(ra);
      expect(arr[3]).toBe(la);
      const x = Math.sin(n * 0.21);
      const y = Math.cos(n * 0.13);
      a.input(x + 0.9 * la, y - 0.9 * ra);
      inp[2] = x + 0.9 * (arr[3] ?? 0);
      inp[3] = y - 0.9 * (arr[2] ?? 0);
      b.inputPair(inp, 2);
    }
    expect(b.energy()).toBe(a.energy());
  });

  it('energy() counts both rails; clear() and configure() zero the state (multi-call)', () => {
    const wg = new Waveguide(256);
    expect(wg.energy()).toBe(0);
    wg.configure(lenFor(20), C, FS, 0);
    wg.outRight();
    wg.outLeft();
    wg.input(0.5, -0.25);
    expect(wg.energy()).toBeCloseTo(0.25 + 0.0625, 12);
    wg.clear();
    expect(wg.energy()).toBe(0);
    wg.input(1, 1);
    wg.configure(lenFor(30), C, FS, 1000);
    expect(wg.energy()).toBe(0);
    expect(wg.outRight()).toBe(0);
    expect(wg.outLeft()).toBe(0);
  });

  it('energy() counts a stored sample exactly while a future read can still touch it (both rails)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(20.5), C, FS, 0); // fractional: the read kernel spans ages 18 … 21
    const span = Math.floor(wg.delaySamples - 1) + 3; // ages 0 … span − 1 are counted
    expect(span).toBe(22);
    wg.input(1, 0.5); // one non-zero sample per rail, now at age 0
    let lastRight = -1;
    let lastLeft = -1;
    for (let age = 0; age < span + 3; age++) {
      expect(wg.energy()).toBe(age < span ? 1.25 : 0);
      if (wg.outRight() !== 0) lastRight = age;
      if (wg.outLeft() !== 0) lastLeft = age;
      wg.input(0, 0);
    }
    // the oldest sample energy() counts is the oldest one a read still uses
    expect(lastRight).toBe(span - 1);
    expect(lastLeft).toBe(span - 1);
  });

  it('clear() and configure() also reset the wall-loss filters: no stale or NaN state survives (multi-call)', () => {
    for (const lossHz of [0, 1000]) {
      const wg = new Waveguide(256);
      wg.configure(lenFor(20), C, FS, lossHz);
      const resets = [() => wg.clear(), () => wg.configure(lenFor(20), C, FS, lossHz)];
      for (const reset of resets) {
        for (const x of [1, NaN]) {
          wg.input(x, x);
          reset();
          for (let i = 0; i < 2 * wg.delaySamples + 4; i++) {
            expect(wg.outRight()).toBe(0);
            expect(wg.outLeft()).toBe(0);
            wg.input(0, 0);
            expect(wg.energy()).toBe(0);
          }
        }
      }
    }
  });
});
