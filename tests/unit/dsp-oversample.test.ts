import { describe, expect, it } from 'vitest';
import { OS_FACTOR, OS_TAPS, Upsampler4 } from '../../src/dsp/oversample';
import { Rng } from '../../src/dsp/util';

const tap = (i: number): number => OS_TAPS[i] ?? NaN;

/** Interpolator gain in dB at a frequency given as a fraction of the INPUT rate (normalised by OS_FACTOR). */
function gainDb(fOverFsIn: number): number {
  let re = 0;
  let im = 0;
  for (let n = 0; n < OS_TAPS.length; n++) {
    const w = (-2 * Math.PI * fOverFsIn * n) / OS_FACTOR;
    re += tap(n) * Math.cos(w);
    im += tap(n) * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im) / OS_FACTOR);
}

describe('OS_TAPS', () => {
  it('is a symmetric 48-tap filter summing to OS_FACTOR', () => {
    expect(OS_FACTOR).toBe(4);
    expect(OS_TAPS).toBeInstanceOf(Float64Array);
    expect(OS_TAPS.length).toBe(48);
    let sum = 0;
    for (let n = 0; n < 48; n++) {
      expect(Number.isFinite(tap(n))).toBe(true);
      expect(tap(n)).toBeCloseTo(tap(47 - n), 15);
      sum += tap(n);
    }
    expect(sum).toBeCloseTo(4, 12);
    expect(tap(23)).toBe(Math.max(...OS_TAPS));
  });

  it('gives every polyphase branch ≈ unity DC gain', () => {
    for (let p = 0; p < 4; p++) {
      let s = 0;
      for (let m = 0; m < 12; m++) s += tap(p + 4 * m);
      expect(Math.abs(s - 1)).toBeLessThan(1e-4);
    }
  });

  it('meets the Kaiser β = 8 / 0.45·fs_in design: flat pass band, −6 dB at cutoff, ≥ 80 dB stop band', () => {
    let passDev = 0;
    for (let f = 0; f <= 0.25; f += 0.0025) passDev = Math.max(passDev, Math.abs(gainDb(f)));
    expect(passDev).toBeLessThan(0.01);
    expect(gainDb(0.45)).toBeCloseTo(-6.02, 1);
    let stop = -Infinity;
    for (let f = 0.7; f <= 2; f += 0.0025) stop = Math.max(stop, gainDb(f));
    expect(stop).toBeLessThan(-80);
  });
});

describe('Upsampler4', () => {
  it('replays OS_TAPS as its impulse response, four taps per push (multi-call)', () => {
    const u = new Upsampler4();
    for (let k = 0; k < 12; k++) {
      u.push(k === 0 ? 1 : 0);
      for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(tap(4 * k + p));
    }
    u.push(0);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
  });

  it('equals direct convolution of the zero-stuffed input with OS_TAPS', () => {
    const n = 300;
    const x = new Float64Array(n);
    const rng = new Rng(12345);
    for (let i = 0; i < n; i++) x[i] = rng.bipolar();
    const u = new Upsampler4();
    for (let k = 0; k < n; k++) {
      u.push(x[k] ?? 0);
      for (let p = 0; p < 4; p++) {
        const outIndex = 4 * k + p;
        let ref = 0;
        for (let j = 0; j < 48; j++) {
          const s = outIndex - j;
          if (s >= 0 && s % 4 === 0) ref += tap(j) * (x[s / 4] ?? 0);
        }
        expect(u.out[p]).toBeCloseTo(ref, 12);
      }
    }
  });

  it('interpolates a 1 kHz sine at 48 kHz to within 1e-4 (group delay 5.875 input samples)', () => {
    const u = new Upsampler4();
    const f = 1000 / 48000;
    let err = 0;
    for (let k = 0; k < 2000; k++) {
      u.push(Math.sin(2 * Math.PI * f * k));
      if (k < 50) continue;
      for (let p = 0; p < 4; p++) {
        const t = k + p / 4 - 5.875;
        err = Math.max(err, Math.abs((u.out[p] ?? NaN) - Math.sin(2 * Math.PI * f * t)));
      }
    }
    expect(err).toBeLessThan(1e-4);
  });

  it('reveals the inter-sample peak of an fs/4 sine sampled at ±0.707', () => {
    const u = new Upsampler4();
    let samplePeak = 0;
    let truePeak = 0;
    for (let k = 0; k < 400; k++) {
      const x = Math.sin((Math.PI / 2) * k + Math.PI / 4);
      samplePeak = Math.max(samplePeak, Math.abs(x));
      u.push(x);
      if (k > 20) for (let p = 0; p < 4; p++) truePeak = Math.max(truePeak, Math.abs(u.out[p] ?? 0));
    }
    expect(samplePeak).toBeCloseTo(Math.SQRT1_2, 9);
    expect(truePeak).toBeGreaterThan(0.97);
    expect(truePeak).toBeLessThanOrEqual(1.001);
  });

  it('reset() clears the history and the outputs', () => {
    const u = new Upsampler4();
    for (let k = 0; k < 30; k++) u.push(1);
    expect(u.out[0]).toBeCloseTo(1, 3);
    u.reset();
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
    u.push(0);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
    u.push(1);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(tap(p));
  });
});
