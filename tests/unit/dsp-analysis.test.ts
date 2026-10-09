import { describe, expect, it } from 'vitest';
import {
  bandEnergyDb,
  dominantOrders,
  fft,
  hann,
  orderSpectrum,
  rmsDb,
  truePeakDbtp,
} from '../../src/dsp/analysis';
import { Upsampler4 } from '../../src/dsp/oversample';

const FS = 48000;

function sine(freq: number, amp: number, seconds: number, phase = 0, fs = FS): Float64Array {
  const n = Math.round(seconds * fs);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return x;
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
}

/**
 * Streamed 4× true peak (linear) of x[from..]: a fresh Upsampler4 fed the samples from index 0 (so it
 * is warm at `from`) — no zeros after the end.
 */
function streamedTruePeak(x: ArrayLike<number>, from = 0): number {
  const up = new Upsampler4();
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = at(x, i);
    up.push(v);
    if (i < from) continue;
    p = Math.max(p, Math.abs(v));
    for (const o of up.out) p = Math.max(p, Math.abs(o));
  }
  return p;
}

describe('fft', () => {
  it('transforms a unit impulse to a flat spectrum', () => {
    const re = new Float64Array(16);
    const im = new Float64Array(16);
    re[0] = 1;
    fft(re, im);
    for (let k = 0; k < 16; k++) {
      expect(at(re, k)).toBeCloseTo(1, 12);
      expect(at(im, k)).toBeCloseTo(0, 12);
    }
  });

  it('matches a naive DFT on pseudo-random data, and is reusable across calls', () => {
    for (const n of [8, 64]) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      const x = new Float64Array(n);
      let s = 12345;
      for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) % 2147483648;
        x[i] = s / 2147483648 - 0.5;
        re[i] = at(x, i);
      }
      fft(re, im);
      for (let k = 0; k < n; k++) {
        let dr = 0;
        let di = 0;
        for (let t = 0; t < n; t++) {
          dr += at(x, t) * Math.cos((-2 * Math.PI * k * t) / n);
          di += at(x, t) * Math.sin((-2 * Math.PI * k * t) / n);
        }
        expect(Math.abs(at(re, k) - dr)).toBeLessThan(1e-9);
        expect(Math.abs(at(im, k) - di)).toBeLessThan(1e-9);
      }
    }
  });

  it('puts a bin-centred sine at |X_k| = N/2', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    expect(Math.hypot(at(re, 5), at(im, 5))).toBeCloseTo(16, 9);
    expect(Math.hypot(at(re, 4), at(im, 4))).toBeLessThan(1e-9);
  });

  it('rejects non-power-of-two and mismatched lengths', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow(RangeError);
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(RangeError);
  });
});

describe('hann', () => {
  it('is the symmetric Hann window', () => {
    const w = hann(5);
    expect(Array.from(w).map((v) => Number(v.toFixed(12)))).toEqual([0, 0.5, 1, 0.5, 0]);
    expect(Array.from(hann(1))).toEqual([1]);
    expect(hann(0).length).toBe(0);
  });
});

describe('orderSpectrum', () => {
  it('reads A²/2 at the matching order and ~0 elsewhere (step ½)', () => {
    // 3000 rpm → 50 Hz crank; order 2 → 100 Hz.
    const x = sine(100, 0.5, 1);
    const spec = orderSpectrum(x, FS, 3000, 12, 0.5);
    expect(spec.length).toBe(24);
    expect(at(spec, 3)).toBeCloseTo(0.125, 3); // index 3 = order 2
    expect(at(spec, 1)).toBeLessThan(1e-9); // order 1
    expect(at(spec, 4)).toBeLessThan(1e-9); // order 2.5
  });

  it('handles ⅓-order steps without losing the last order to rounding', () => {
    const spec = orderSpectrum(sine((6000 / 60) * (4 / 3), 1, 1), FS, 6000, 12, 1 / 3);
    expect(spec.length).toBe(36);
    expect(dominantOrders(spec, 1 / 3, 1)[0]).toBeCloseTo(4 / 3, 9);
  });

  it('returns zeros for empty input and for orders at/above Nyquist', () => {
    expect(Array.from(orderSpectrum(new Float64Array(0), FS, 3000, 4, 1))).toEqual([0, 0, 0, 0]);
    const spec = orderSpectrum(sine(1000, 1, 0.1), FS, 600000, 4, 1); // order 3 = 30 kHz > Nyquist
    expect(at(spec, 2)).toBe(0);
    expect(at(spec, 3)).toBe(0);
  });
});

describe('dominantOrders', () => {
  it('sorts by energy, ties to the lower order, NaN last', () => {
    const spec = Float64Array.from([1, 5, 3, 5, Number.NaN]);
    expect(dominantOrders(spec, 0.5, 3)).toEqual([1, 2, 1.5]);
    expect(dominantOrders(spec, 0.5, 10)).toEqual([1, 2, 1.5, 0.5, 2.5]);
    expect(dominantOrders(spec, 0.5, 0)).toEqual([]);
  });
});

describe('truePeakDbtp', () => {
  it('finds the inter-sample peak a sample-peak meter misses', () => {
    // fs/8 sine with π/8 phase: sample peak = sin(3π/8) = −0.69 dB, true peak = 0 dB.
    const x = sine(FS / 8, 1, 0.05, Math.PI / 8);
    let samplePeak = 0;
    for (let i = 0; i < x.length; i++) samplePeak = Math.max(samplePeak, Math.abs(at(x, i)));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-0.688, 2);
    const tp = truePeakDbtp(x);
    expect(tp).toBeGreaterThan(-0.15);
    expect(tp).toBeLessThan(0.15);
  });

  it('is never below the sample peak, −200 for silence, NaN for NaN input', () => {
    const x = Float64Array.from([0, 0.25, -0.5, 0.1]);
    expect(truePeakDbtp(x)).toBeGreaterThanOrEqual(20 * Math.log10(0.5) - 1e-12);
    expect(truePeakDbtp(new Float32Array(64))).toBe(-200);
    expect(truePeakDbtp([])).toBe(-200);
    expect(truePeakDbtp([0, Number.NaN, 0])).toBeNaN();
  });

  it('does not zero-flush after the end: a tone ending on a crest reads its streamed true peak', () => {
    // A tone at the limiter target (−1.3 dBTP, contract B9) whose buffer ends on a crest. Padding
    // the interpolator with zeros after the last sample would add a step to 0 — a Gibbs overshoot
    // (≈ +0.9 dB) that is not in the signal — and spuriously fail the ≤ −1.0 dBTP gate (B14).
    const targetDb = -1.3;
    const amp = 10 ** (targetDb / 20);
    for (const f of [100, 997]) {
      const n = Math.round(10.25 * (FS / f)) + 1; // starts at a zero crossing, ends on (or next to) a crest
      const x = sine(f, amp, n / FS);
      expect(x.length).toBe(n);
      expect(at(x, n - 1)).toBeGreaterThan(0.995 * amp);
      const tp = truePeakDbtp(x);
      expect(tp).toBeLessThanOrEqual(20 * Math.log10(streamedTruePeak(x)) + 1e-9);
      expect(tp).toBeCloseTo(targetDb, 2);
      expect(tp).toBeLessThanOrEqual(-1.0);
    }
  });

  it('does not zero-pad the start either: a slice of a running tone that starts on a crest reads its in-signal true peak', () => {
    // A buffer cut from a running signal (e.g. a render after a discarded pre-roll) can start loud.
    // The implicit zeros before x[0] are a step too — the same Gibbs overshoot (≈ +0.8 dB), not in
    // the signal — so interpolated samples count only once the interpolator's history is all signal.
    const targetDb = -1.3;
    const amp = 10 ** (targetDb / 20);
    const pre = 1000;
    for (const f of [100, 997, 3000]) {
      const running = new Float64Array(pre + FS);
      for (let i = 0; i < running.length; i++) running[i] = amp * Math.cos((2 * Math.PI * f * (i - pre)) / FS);
      const x = running.subarray(pre); // 1 s of the running tone, starting exactly on a crest
      expect(at(x, 0)).toBe(amp);
      const tp = truePeakDbtp(x);
      expect(tp).toBeLessThanOrEqual(20 * Math.log10(streamedTruePeak(running, pre)) + 1e-9);
      expect(tp).toBeCloseTo(targetDb, 2);
      expect(tp).toBeLessThanOrEqual(-1.0);
    }
  });
});

describe('rmsDb', () => {
  it('reads a full-scale sine at −3.01 dB and silence at −200', () => {
    expect(rmsDb(sine(997, 1, 1))).toBeCloseTo(-3.0103, 3);
    expect(rmsDb(new Float32Array(100))).toBe(-200);
    expect(rmsDb([])).toBe(-200);
  });

  it('propagates NaN instead of reading a corrupt buffer as silence', () => {
    expect(rmsDb([0, Number.NaN, 0])).toBeNaN();
    const x = sine(1000, 1, 0.1);
    x[100] = Number.NaN;
    expect(rmsDb(x)).toBeNaN();
  });
});

describe('bandEnergyDb', () => {
  it('reads a full-scale in-band sine at 0 dB and rejects out-of-band energy', () => {
    const x = sine(1000, 1, 1);
    expect(bandEnergyDb(x, FS, 500, 2000)).toBeCloseTo(0, 1);
    expect(bandEnergyDb(x, FS, 5000, 10000)).toBeLessThan(-100);
  });

  it('measures band ratios of a two-tone signal', () => {
    const a = sine(1000, 1, 1);
    const b = sine(5000, 0.1, 1);
    const x = new Float64Array(a.length);
    for (let i = 0; i < x.length; i++) x[i] = at(a, i) + at(b, i);
    const total = bandEnergyDb(x, FS, 0, FS / 2);
    expect(total).toBeCloseTo(10 * Math.log10(1.01), 1);
    expect(bandEnergyDb(x, FS, 4000, 6000) - total).toBeCloseTo(-20.04, 1);
  });

  it('returns −200 for empty input or an inverted band', () => {
    expect(bandEnergyDb([], FS, 0, 1000)).toBe(-200);
    expect(bandEnergyDb(sine(1000, 1, 0.1), FS, 2000, 1000)).toBe(-200);
  });

  it('returns NaN, not −200, for a corrupt (NaN or ±Infinity) buffer', () => {
    const x = sine(1000, 1, 0.1);
    // 4800 samples → 8192-point FFT, 5.86 Hz bins: no bin centre lies in [1000.1, 1000.2] Hz
    expect(bandEnergyDb(x, FS, 1000.1, 1000.2)).toBe(-200);
    x[100] = Number.NaN;
    expect(bandEnergyDb(x, FS, 500, 2000)).toBeNaN();
    expect(bandEnergyDb(x, FS, 0, FS / 2)).toBeNaN();
    expect(bandEnergyDb(x, FS, 1000.1, 1000.2)).toBeNaN(); // any NaN sample → NaN, as truePeakDbtp
    x[100] = Number.POSITIVE_INFINITY;
    expect(bandEnergyDb(x, FS, 500, 2000)).toBeNaN();
    x[100] = Number.NEGATIVE_INFINITY;
    expect(bandEnergyDb(x, FS, 0, FS / 2)).toBeNaN();
  });
});
