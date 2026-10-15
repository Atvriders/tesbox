/**
 * Phase 2b T2 — per-frame and per-clip features (src/lab/features.ts, phase 2b contract "Features" as amended
 * by D2 and D5: firingsPerRev in both signatures, subOrderDb over all firing-order multiples, irregularity window
 * max(0.25 s, 4 cycles) and null when undefined (D2); fiLineHz without engine-order exclusion, persisting over
 * ≥ 3 consecutive frames within ±5 % (D5, superseding D2.2)).
 * Every feature is pinned first on signals whose answer is known analytically, then on Phase 2a DSP renders
 * of the fixture engines.
 */
import { describe, expect, it } from 'vitest';
import { fft } from '../../src/dsp/analysis';
import { ForcedInduction } from '../../src/dsp/forced';
import { Rng } from '../../src/dsp/util';
import {
  FI_MIN_RUN_FRAMES,
  FI_RUN_TOLERANCE,
  IRREGULARITY_MIN_CYCLES,
  OVERRUN_MIN_SPAN_S,
  OVERRUN_ONSET_DB,
  clipFeatures,
  frameFeatures,
  overrunRate,
  type FrameFeatures,
} from '../../src/lab/features';
import { CoreHarness, loadFixture, makeCtl, slice } from './helpers/dsp-harness';

const FS = 48000;
/** One 0.25 s frame at 48 kHz. */
const FRAME = 12000;
/** The 0.125 s hop at 48 kHz. */
const HOP = 6000;
/** dB per octave per unit power-law exponent: 10·log10(2). */
const DB_PER_OCT = 10 * Math.log10(2);
/** Firing order of an even-fire I4 (combustion.length × 360 / cycleDeg = 4 × ½): the default in single-frame tests. */
const I4_FPR = 2;

/** amp·cos(2π·hz·i/fs + phase), n samples. */
function tone(n: number, fs: number, hz: number, amp: number, phase = 0): Float64Array {
  const x = new Float64Array(n);
  const w = (2 * Math.PI * hz) / fs;
  for (let i = 0; i < n; i++) x[i] = amp * Math.cos(w * i + phase);
  return x;
}

/** Σ amp·cos(2π·order·(rpm/60)·i/fs + phase_j) over the [order, amp] lines (fixed distinct phases). */
function orderLines(n: number, fs: number, rpm: number, lines: readonly (readonly [number, number])[]): Float64Array {
  const x = new Float64Array(n);
  lines.forEach(([order, amp], j) => {
    const t = tone(n, fs, (order * rpm) / 60, amp, 0.7 * j);
    for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) + (t[i] ?? 0);
  });
  return x;
}

/** Seeded white Gaussian noise of the given RMS. */
function white(n: number, seed: number, rms: number): Float64Array {
  const rng = new Rng(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rms * rng.gauss();
  return x;
}

/** Element-wise sum of equal-length signals. */
function mix(...parts: Float64Array[]): Float64Array {
  const x = new Float64Array(parts[0]?.length ?? 0);
  for (const p of parts) for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) + (p[i] ?? 0);
  return x;
}

function scaled(x: Float64Array, g: number): Float64Array {
  return x.map((v) => v * g);
}

/**
 * Random-phase multisine with a power-law magnitude on every bin of the 2^k ≥ n grid between 20 Hz
 * and 16 kHz: line amplitude 2·(f / 1 kHz)^γ (power density ∝ f^(2γ): γ = 0 white, −½ pink, −1
 * brown). The first n samples, normalised to `rms` when given (else raw).
 */
function powerLaw(n: number, fs: number, gamma: number, seed: number, rms?: number): Float64Array {
  let m = 1;
  while (m < n) m <<= 1;
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const rng = new Rng(seed);
  for (let k = 1; k < m / 2; k++) {
    const f = (k * fs) / m;
    if (f < 20 || f > 16000) continue;
    const a = Math.pow(f / 1000, gamma);
    const ph = 2 * Math.PI * rng.next();
    // conj(X) on both halves of a Hermitian spectrum: the forward FFT then yields m·x (real).
    re[k] = a * Math.cos(ph);
    im[k] = -a * Math.sin(ph);
    re[m - k] = a * Math.cos(ph);
    im[m - k] = a * Math.sin(ph);
  }
  fft(re, im);
  const x = re.slice(0, n);
  if (rms === undefined) return x;
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] ?? 0) ** 2;
  return scaled(x, rms / Math.sqrt(s / n));
}

/**
 * Comb of tones at k·spacing Hz (k = 1..count), amplitude (f / 1 kHz)^γ, seeded random phases. Tones
 * ≥ 10 bins apart do not overlap in a 0.25 s Hann-windowed spectrum, so its power-weighted statistics
 * follow the tone list exactly.
 */
function comb(n: number, fs: number, spacing: number, count: number, gamma: number, seed: number): Float64Array {
  const rng = new Rng(seed);
  let x: Float64Array = new Float64Array(n);
  for (let k = 1; k <= count; k++) {
    const f = k * spacing;
    x = mix(x, tone(n, fs, f, Math.pow(f / 1000, gamma), 2 * Math.PI * rng.next()));
  }
  return x;
}

/** x[i]·amps[floor(i / cycleLen) mod amps.length]: per-cycle amplitude modulation from sample 0. */
function perCycle(x: Float64Array, cycleLen: number, amps: readonly number[]): Float64Array {
  return x.map((v, i) => v * (amps[Math.floor(i / cycleLen) % amps.length] ?? 1));
}

/** rpmAt for a clip cut into 0.125 s hop slots: slot s (t ∈ [0.125·s, 0.125·(s + 1))) runs at rpms[s]. */
function slotRpm(rpms: readonly number[]): (t: number) => number {
  return (t) => rpms[Math.min(rpms.length - 1, Math.floor(t / 0.125))] ?? Number.NaN;
}

function fiOf(f: FrameFeatures): number {
  expect(f.fiLineHz, 'an FI line was expected').not.toBeNull();
  return f.fiLineHz ?? Number.NaN;
}

describe('frameFeatures — orderAmp', () => {
  it('is √(order power): a line of amplitude A at an order reads A/√2 there and ≈ 0 elsewhere', () => {
    // 3000 rpm: order 3 = 150 Hz, order 1.5 = 75 Hz; half-order grid (step 0.5) → orders 0.5 … 12.
    const f = frameFeatures(orderLines(FRAME, FS, 3000, [[3, 0.5], [1.5, 0.2]]), FS, 3000, 0.5, I4_FPR);
    expect(f.rpm).toBe(3000);
    expect(f.orderAmp.length).toBe(24);
    expect(f.orderAmp[5]).toBeCloseTo(0.5 / Math.SQRT2, 5); // order 3
    expect(f.orderAmp[2]).toBeCloseTo(0.2 / Math.SQRT2, 5); // order 1.5
    expect(f.orderAmp[0]).toBeLessThan(1e-4); // order 0.5
    expect(f.orderAmp[11]).toBeLessThan(1e-4); // order 6
  });

  it('covers orders k/3 up to 12 on the rotary ⅓-order grid', () => {
    // 9000 rpm: order 4/3 = 200 Hz → index 3 on the ⅓ grid (36 entries).
    const f = frameFeatures(orderLines(FRAME, FS, 9000, [[4 / 3, 0.3]]), FS, 9000, 1 / 3, 2);
    expect(f.orderAmp.length).toBe(36);
    expect(f.orderAmp[3]).toBeCloseTo(0.3 / Math.SQRT2, 5);
    expect(f.orderAmp[5]).toBeLessThan(1e-4); // order 2
  });

  it('is 0 for orders at or above Nyquist', () => {
    // fs 8 kHz, 30 000 rpm: order k·0.5 lies at 250·k Hz, so k ≥ 16 (index ≥ 15) is at or above 4 kHz.
    const f = frameFeatures(white(2000, 1, 0.1), 8000, 30000, 0.5, I4_FPR);
    for (let i = 0; i < 24; i++) {
      if (i >= 15) expect(f.orderAmp[i], `order ${(i + 1) / 2}`).toBe(0);
      else expect(f.orderAmp[i], `order ${(i + 1) / 2}`).toBeGreaterThan(0);
    }
  });
});

describe('frameFeatures — levelDb', () => {
  it('is the frame RMS in dB re amplitude 1 (a 0.5 sine reads 20·log10(0.5/√2) = −9.03 dB)', () => {
    expect(frameFeatures(tone(FRAME, FS, 100, 0.5), FS, 3000, 0.5, I4_FPR).levelDb).toBeCloseTo(-9.0309, 3);
  });
});

describe('frameFeatures — centroidHz', () => {
  const twoTones = mix(tone(FRAME, FS, 100, 1), tone(FRAME, FS, 1000, 0.5, 1.1));

  it('is the power-weighted mean frequency: 100 Hz at 1 and 1 kHz at ½ → (100·1 + 1000·¼)/1.25 = 280 Hz', () => {
    // (Magnitude weighting would read (100·1 + 1000·½)/1.5 = 400 Hz.)
    expect(Math.abs(frameFeatures(twoTones, FS, 3000, 0.5, I4_FPR).centroidHz - 280)).toBeLessThan(1);
    expect(Math.abs(frameFeatures(tone(FRAME, FS, 3000, 0.3), FS, 3000, 0.5, I4_FPR).centroidHz - 3000)).toBeLessThan(1);
  });

  it('only counts 20 Hz–12 kHz: loud 10 Hz and 15 kHz tones leave it at 280 Hz', () => {
    const x = mix(twoTones, tone(FRAME, FS, 10, 1, 0.3), tone(FRAME, FS, 15000, 1, 0.9));
    // Counting them would read (10 + 100 + 250)/2.25 = 160 Hz, or (100 + 250 + 15000)/2.25 = 6822 Hz.
    expect(Math.abs(frameFeatures(x, FS, 3000, 0.5, I4_FPR).centroidHz - 280)).toBeLessThan(1);
  });

  it('is Σ f·A²/Σ A² over a broadband comb (tones every 40 Hz, 40 Hz–11.96 kHz)', () => {
    // Flat comb → 6000 Hz; A ∝ f^−½ → 11960/H_299 = 1904.7 Hz (magnitude weighting would read ≈ 4180 Hz).
    for (const gamma of [0, -0.5]) {
      let num = 0;
      let den = 0;
      for (let k = 1; k <= 299; k++) {
        num += 40 * k * Math.pow(0.04 * k, 2 * gamma);
        den += Math.pow(0.04 * k, 2 * gamma);
      }
      const c = frameFeatures(comb(FRAME, FS, 40, 299, gamma, 13), FS, 3000, 0.5, I4_FPR).centroidHz;
      expect(Math.abs(c - num / den), `γ ${gamma}: ${c.toFixed(2)} Hz vs ${(num / den).toFixed(2)} Hz`).toBeLessThan(1);
    }
  });

  it('reads the band mean (20 Hz + 12 kHz)/2 = 6010 Hz for white Gaussian noise (mean over a 4 s clip)', () => {
    const c = clipFeatures(white(4 * FS, 12, 0.1), FS, () => 3000, 0.5, 'cruise', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(31);
    const mean = c.frames.reduce((s, f) => s + f.centroidHz, 0) / c.frames.length;
    expect(Math.abs(mean / 6010 - 1), `${mean.toFixed(1)} Hz`).toBeLessThan(0.01);
  });
});

describe('frameFeatures — tiltDbPerOct', () => {
  it('reads (2γ + 1)·3.01 dB/oct for power-law noise |A(f)| ∝ f^γ: white +3.01, pink 0, brown −3.01', () => {
    // 1/3-octave band levels are band SUMS, so white noise rises 3.01 dB per octave.
    for (const gamma of [0, -0.5, -1, -1.5]) {
      for (const seed of [3, 4]) {
        const tilt = frameFeatures(powerLaw(FRAME, FS, gamma, seed, 0.1), FS, 3000, 0.5, I4_FPR).tiltDbPerOct;
        expect(Math.abs(tilt - (2 * gamma + 1) * DB_PER_OCT), `γ ${gamma} seed ${seed}: ${tilt.toFixed(3)} dB/oct`).toBeLessThan(0.15);
      }
    }
  });

  it('reads ≈ +3.01 dB/oct for seeded white Gaussian noise (mean over a 2 s clip)', () => {
    // The 50–125 Hz bands hold only a few periodogram bins per 0.25 s frame, and the dB level of a
    // few-bin χ² power is biased low (E[log P] < log E[P]), so Gaussian noise reads ≈ 0.15 dB/oct
    // high on average (measured over 40 seeds: +0.148 ± 0.028); the deterministic-magnitude
    // multisines above pin the slope itself.
    const c = clipFeatures(white(2 * FS, 11, 0.1), FS, () => 3000, 0.5, 'cruise', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(15);
    const mean = c.frames.reduce((s, f) => s + f.tiltDbPerOct, 0) / c.frames.length;
    expect(Math.abs(mean - DB_PER_OCT), `${mean.toFixed(3)} dB/oct`).toBeLessThan(0.3);
  });

  it('fits exactly the 23 bands 50 Hz–8 kHz: one tone at every ⅓-octave centre from 31.5 Hz to 12.7 kHz', () => {
    // Band k (centre 1 kHz·2^(k/3)) holds one tone at level(k) dB: 0 dB except +10 dB in the 50 Hz band
    // (k = −13) and −6 dB in the 8 kHz band (k = 9); the two bands beyond each end (31.5/40 Hz,
    // 10.1/12.7 kHz) are at +20 dB. A 2 s frame resolves every tone well inside its band (Hann main lobe
    // ±1 Hz; the 40 Hz band is 9 Hz wide), so each band level is its tone's level and the tilt is the
    // least-squares slope of level(k) vs log2(fc) over k = −13..9 exactly. Fitting 40 Hz–8 kHz would read
    // −1.05 dB/oct, 50 Hz–10 kHz +0.14, 63 Hz–8 kHz −0.21, 50 Hz–6.3 kHz −0.36, 63 Hz–6.3 kHz 0.
    const level = (k: number): number => (k < -13 || k > 9 ? 20 : k === -13 ? 10 : k === 9 ? -6 : 0);
    const n = 2 * FS;
    const rng = new Rng(7);
    let x: Float64Array = new Float64Array(n);
    for (let k = -15; k <= 11; k++) {
      x = mix(x, tone(n, FS, 1000 * 2 ** (k / 3), 0.01 * 10 ** (level(k) / 20), 2 * Math.PI * rng.next()));
    }
    const ks = Array.from({ length: 23 }, (_, i) => i - 13);
    const mx = ks.reduce((s, k) => s + k / 3, 0) / ks.length;
    const my = ks.reduce((s, k) => s + level(k), 0) / ks.length;
    const slope =
      ks.reduce((s, k) => s + (k / 3 - mx) * (level(k) - my), 0) / ks.reduce((s, k) => s + (k / 3 - mx) ** 2, 0);
    expect(slope).toBeCloseTo(-0.5217, 4); // = −12/23 dB/oct
    const tilt = frameFeatures(x, FS, 3000, 0.5, I4_FPR).tiltDbPerOct;
    expect(Math.abs(tilt - slope), `${tilt.toFixed(5)} dB/oct`).toBeLessThan(0.001);
  });
});

describe('frameFeatures — subOrderDb (amendment D2.1)', () => {
  /** Even-fire I4 firing stack: order 2 and its harmonics, amplitude 1/h (Σ A² = Σ 1/h², h = 1..6 = 1.49139). */
  const I4: [number, number][] = [[2, 1], [4, 1 / 2], [6, 1 / 3], [8, 1 / 4], [10, 1 / 5], [12, 1 / 6]];

  /** I5 firing stack 2.5/5/7.5/10 (Σ A² = 1.42361) plus half-orders 0.5 and 1.5 at 0.1. */
  const I5_LUMPY: [number, number][] = [[2.5, 1], [5, 1 / 2], [7.5, 1 / 3], [10, 1 / 4], [0.5, 0.1], [1.5, 0.1]];

  it('a pure firing-order harmonic stack has (almost) no sub-order energy', () => {
    expect(frameFeatures(orderLines(FRAME, FS, 3000, I4), FS, 3000, 0.5, 2).subOrderDb).toBeLessThan(-40);
  });

  it('is 10·log10(Σ power at non-multiples of firingsPerRev / Σ power at its multiples ≤ 12)', () => {
    // Half-orders 1.5 and 2.5 at 0.1 against the whole I4 firing stack: 10·log10(2·0.1²/1.49139) = −18.73 dB.
    // Re the single order-2 line it would read −16.99 dB.
    const x = orderLines(FRAME, FS, 3000, [...I4, [1.5, 0.1], [2.5, 0.1]]);
    expect(frameFeatures(x, FS, 3000, 0.5, 2).subOrderDb).toBeCloseTo(-18.73, 1);
  });

  it('counts integer non-firing orders too: orders 1 and 3 of an I4 are not multiples of 2', () => {
    // 10·log10((2·0.3² + 2·0.1²)/1.49139) = −8.73 dB. Counting only the non-integer orders 1.5 and 2.5 would
    // read −18.73 dB (or −16.99 dB re the single order-2 line).
    const x = orderLines(FRAME, FS, 3000, [...I4, [1, 0.3], [3, 0.3], [1.5, 0.1], [2.5, 0.1]]);
    expect(frameFeatures(x, FS, 3000, 0.5, 2).subOrderDb).toBeCloseTo(-8.73, 1);
  });

  it('refers to the summed power of every firing-order multiple, not to the first firing line alone', () => {
    // Order 4 at 1 outweighs the order-2 line at ½: Σ firing power ∝ ½² + 1 + ⅓² + ¼² = 1.42361, so
    // 10·log10(2·0.1²/1.42361) = −18.52 dB (re the order-2 line alone: −10.97 dB).
    const x = orderLines(FRAME, FS, 3000, [[2, 0.5], [4, 1], [6, 1 / 3], [8, 1 / 4], [1.5, 0.1], [2.5, 0.1]]);
    expect(frameFeatures(x, FS, 3000, 0.5, 2).subOrderDb).toBeCloseTo(-18.52, 1);
  });

  it('does not count the harmonics of an odd firing order (I5: 2.5, 5, 7.5, 10) as sub-orders', () => {
    // 10·log10(2·0.1²/1.42361) = −18.52 dB. Counting the 2.5 and 7.5 lines as half-orders re the strongest
    // integer order (5 at ½) would read 10·log10((1 + 1/9 + 2·0.01)/(1/4)) = +6.56 dB.
    expect(frameFeatures(orderLines(FRAME, FS, 3000, I5_LUMPY), FS, 3000, 0.5, 2.5).subOrderDb).toBeCloseTo(-18.52, 1);
  });

  it('uses the ⅓-order grid for rotaries', () => {
    // Firing order 2 (stack 2/4/6, Σ A² = 1.36111) at 9000 rpm with ⅓-order lines 1/3 at 0.1 and 5/3 at 0.05:
    // 10·log10((0.1² + 0.05²)/1.36111) = −20.37 dB.
    const x = orderLines(FRAME, FS, 9000, [[2, 1], [4, 1 / 2], [6, 1 / 3], [1 / 3, 0.1], [5 / 3, 0.05]]);
    expect(frameFeatures(x, FS, 9000, 1 / 3, 2).subOrderDb).toBeCloseTo(-20.37, 1);
  });

  it('only counts orders ≤ 12: strong lines at orders 12.5 and 13 change nothing', () => {
    // Counting them (13 is not a multiple of 2) would add 1² to the sub-order sum: +20 dB. What remains is the
    // Hann leakage of the 12.5 line into the order-12 Goertzel bin, 25 Hz away (< 0.001 dB).
    const base = orderLines(FRAME, FS, 3000, [...I4, [1.5, 0.1], [2.5, 0.1]]);
    const above = mix(base, orderLines(FRAME, FS, 3000, [[12.5, 1], [13, 1]]));
    expect(frameFeatures(above, FS, 3000, 0.5, 2).subOrderDb).toBeCloseTo(frameFeatures(base, FS, 3000, 0.5, 2).subOrderDb, 2);
  });

  it('requires firingsPerRev (no guessing fallback): a missing or off-grid firing order throws', () => {
    const x = orderLines(FRAME, FS, 3000, I4);
    const missing = undefined as unknown as number;
    expect(() => frameFeatures(x, FS, 3000, 0.5, missing)).toThrow(RangeError);
    expect(() => clipFeatures(x, FS, () => 3000, 0.5, 'cruise', 'cabin', missing)).toThrow(RangeError);
    for (const bad of [0, -2, 2.2, 12.5, Number.NaN]) {
      expect(() => frameFeatures(x, FS, 3000, 0.5, bad), `firingsPerRev ${bad}`).toThrow(RangeError);
      expect(() => clipFeatures(x, FS, () => 3000, 0.5, 'cruise', 'cabin', bad), `clip, firingsPerRev ${bad}`).toThrow(RangeError);
    }
    expect(() => frameFeatures(x, FS, 3000, 1 / 3, 2.5)).toThrow(RangeError); // not on the ⅓ grid
  });
});

describe('frameFeatures — irregularity', () => {
  // 3000 rpm, 4-stroke: one 720° cycle = 40 ms = 1920 samples → 6 whole cycles (+ ¼) per 0.25 s frame.
  const CYCLE_4S = 1920;
  /** Cycle-periodic (orders on the ½ grid) but not rev-periodic: strong half-order content. */
  const lumpy = orderLines(FRAME, FS, 3000, [[0.5, 0.6], [1.5, 0.3], [2, 1], [2.5, 0.4], [4, 0.5]]);

  it('is 0 for a signal periodic in the 720° cycle, even when consecutive revolutions differ', () => {
    expect(frameFeatures(lumpy, FS, 3000, 0.5, I4_FPR).irregularity).toBeLessThan(1e-9);
  });

  it('is the CV (population σ/μ) of per-cycle RMS: whole cycles at amplitudes 1, 0.6, 1, … read 0.25', () => {
    // Six whole cycles 1, .6, 1, .6, 1, .6 → μ 0.8, σ 0.2. The partial seventh cycle (amplitude 1) is
    // ignored: counting it would read 0.2389; the sample σ (n − 1) would read 0.2739.
    const x = perCycle(lumpy, CYCLE_4S, [1, 0.6]);
    expect(frameFeatures(x, FS, 3000, 0.5, I4_FPR).irregularity).toBeCloseTo(0.25, 9);
  });

  it('is the CV of per-cycle RMS, not of per-cycle mean |x| or peak: sine and square cycles of equal peak read 3 − 2√2', () => {
    // Each 1920-sample cycle holds 8 whole 200 Hz periods; cycles alternate between a unit sine (RMS 1/√2)
    // and the unit square wave of the same period (RMS 1): CV = (1 − 1/√2)/(1 + 1/√2) = 3 − 2√2 = 0.17157.
    // The per-cycle mean |x| (2/π vs 1) would read 0.2221 and the per-cycle peak (1 vs 1) 0.
    const x = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      x[i] = Math.floor(i / CYCLE_4S) % 2 === 0 ? Math.sin((2 * Math.PI * 200 * i) / FS) : i % 240 < 120 ? 1 : -1;
    }
    expect(frameFeatures(x, FS, 3000, 0.5, I4_FPR).irregularity).toBeCloseTo(3 - 2 * Math.SQRT2, 9);
  });

  it('uses the 1080° cycle on the ⅓-order grid', () => {
    // 9000 rpm rotary: one 1080° cycle = 20 ms = 960 samples → 12 whole cycles per frame.
    const rotor = orderLines(FRAME, FS, 9000, [[1 / 3, 0.3], [2 / 3, 0.2], [2, 1], [4, 0.5]]);
    expect(frameFeatures(rotor, FS, 9000, 1 / 3, 2).irregularity).toBeLessThan(1e-9);
    // Cycles at 1, .6, .8 (repeating): μ 0.8, σ = √(0.08/3) → CV 0.204124.
    const x = perCycle(rotor, 960, [1, 0.6, 0.8]);
    expect(frameFeatures(x, FS, 9000, 1 / 3, 2).irregularity).toBeCloseTo(Math.sqrt(0.08 / 3) / 0.8, 9);
  });

  it('is null (never NaN) when the frame holds fewer than two whole cycles (below 960 rpm on the 720° cycle)', () => {
    const at = (rpm: number): number | null =>
      frameFeatures(orderLines(FRAME, FS, rpm, [[0.5, 0.3], [2, 1]]), FS, rpm, 0.5, I4_FPR).irregularity;
    expect(at(900)).toBeNull(); // 133 ms cycles: 1.875 per frame
    expect(at(1000)).toBeLessThan(1e-9); // 120 ms cycles: 2 whole cycles
  });
});

describe('clipFeatures — irregularity window max(0.25 s, 4 cycles) (amendment D2.3)', () => {
  /** Cycle-periodic signal at `rpm` (orders on the ½ grid: one period is one 720° cycle). */
  const cyclic = (n: number, rpm: number): Float64Array =>
    orderLines(n, FS, rpm, [[0.5, 0.6], [1.5, 0.3], [2, 1], [2.5, 0.4], [4, 0.5]]);

  it('uses 4 whole cycles when they outlast the frame (960 rpm: 4 × 125 ms = 0.5 s)', () => {
    expect(IRREGULARITY_MIN_CYCLES).toBe(4);
    // 960 rpm: one cycle = 6000 samples = one hop, so every window (shifted inside the 2 s clip at the ends)
    // starts on a cycle boundary and holds one cycle of each amplitude 1, .6, .8, .8: μ 0.8, σ √0.02 → CV
    // 0.176777 in every frame, wherever the window sits (the next test pins its placement). The frame's own
    // 2 cycles would read 0.25, 0.143, 0 or 0.111.
    const x = perCycle(cyclic(2 * FS, 960), 6000, [1, 0.6, 0.8, 0.8]);
    const c = clipFeatures(x, FS, () => 960, 0.5, 'idle', 'outside', I4_FPR);
    expect(c.frames.length).toBe(15);
    c.frames.forEach((f, k) => expect(f.irregularity, `frame ${k}`).toBeCloseTo(Math.sqrt(0.02) / 0.8, 9));
    // frameFeatures has only its 0.25 s frame (2 cycles here): the windowing is a clipFeatures property.
    expect(frameFeatures(x.subarray(0, FRAME), FS, 960, 0.5, I4_FPR).irregularity).toBeCloseTo(0.25, 9);
  });

  it('centres the window on the frame: one weak cycle is seen by exactly the frames whose centred window holds it', () => {
    // 960 rpm (cycle = hop = 6000 samples), 2 s = cycles 0..15, all at amplitude 1 except cycle 8 (1.0–1.125 s)
    // at ½. Frame k covers cycles k, k + 1; its centred 4-cycle window covers cycles k − 1 … k + 2 (shifted inside
    // the clip at the ends), so the weak cycle lies in the windows of frames 6–9: CV of {1, 1, 1, ½} = 0.247436
    // there, 0 elsewhere. A window starting at the frame start would flag frames 5–8, one ending at the frame end
    // frames 7–10, and the frame alone frames 7–8 (CV of {1, ½} = ⅓).
    const x = perCycle(cyclic(2 * FS, 960), 6000, [1, 1, 1, 1, 1, 1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1]);
    const c = clipFeatures(x, FS, () => 960, 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(15);
    const weak = Math.sqrt((3 * 0.125 ** 2 + 0.375 ** 2) / 4) / 0.875;
    expect(weak).toBeCloseTo(0.247436, 6);
    c.frames.forEach((f, k) => {
      if (k >= 6 && k <= 9) expect(f.irregularity, `frame ${k}`).toBeCloseTo(weak, 9);
      else expect(f.irregularity ?? Number.NaN, `frame ${k}`).toBeLessThan(1e-9);
    });
  });

  it('is measured over exactly ⌈4 cycles⌉ centred on the frame, shifted inside the clip at its ends (any rpm)', () => {
    // 811 rpm: one 720° cycle = 60·48000/(½·811) = 7102.34 samples, so the window is ⌈4 cycles⌉ = 28410 samples
    // (0.59 s): a multiple of neither the hop nor the cycle-aligned case above. On seeded noise every placement of
    // the window reads a different CV, so each frame's value pins its window to the sample: [c − 14205, c + 14205)
    // around the frame centre c = start + 6000, shifted to lie inside the 3 s clip for the first two and last
    // two frames. The windows starting or ending with the frame read other values.
    const rpm = 811;
    const n = 3 * FS;
    const x = white(n, 81, 0.1);
    const len = 28410;
    expect(Math.ceil((IRREGULARITY_MIN_CYCLES * 60 * FS) / (0.5 * rpm))).toBe(len);
    const over = (a: number): number | null => frameFeatures(x.subarray(a, a + len), FS, rpm, 0.5, I4_FPR).irregularity;
    const c = clipFeatures(x, FS, () => rpm, 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(23);
    let distinct = 0;
    c.frames.forEach((f, k) => {
      const centred = Math.min(Math.max(0, k * HOP + FRAME / 2 - len / 2), n - len);
      expect(f.irregularity, `frame ${k}`).toBe(over(centred));
      for (const other of [Math.min(k * HOP, n - len), Math.max(0, k * HOP + FRAME - len)]) {
        if (other === centred) continue;
        expect(f.irregularity, `frame ${k}: window at ${other} instead of ${centred}`).not.toBe(over(other));
        distinct++;
      }
    });
    expect(distinct).toBe(40); // start-aligned differs from centred for frames 1–20, end-aligned for 2–21
  });

  it('uses the whole run of kept frames when it is shorter than the window: defined from 2 whole cycles on', () => {
    // 1000 rpm, one lone frame (0.25 s = 2.08 cycles of 120 ms; the window would be 0.48 s): the CV of its 2
    // whole cycles at amplitudes 1, 0.6 is 0.25 — not null.
    const lone = clipFeatures(perCycle(cyclic(FRAME, 1000), 5760, [1, 0.6]), FS, () => 1000, 0.5, 'idle', 'cabin', I4_FPR);
    expect(lone.frames.length).toBe(1);
    expect(lone.frames[0]?.irregularity).toBeCloseTo(0.25, 9);
    // 750 rpm, a 0.5 s clip (3 frames, 3.125 cycles of 160 ms; the window would be 0.64 s): every frame reads the
    // CV of the clip's 3 whole cycles at amplitudes 1, 0.6, 1 (μ 13/15, σ 0.188562 → 0.217571), although each
    // frame alone holds a single whole cycle (null).
    const x = perCycle(cyclic(FS / 2, 750), 7680, [1, 0.6, 1]);
    const short = clipFeatures(x, FS, () => 750, 0.5, 'idle', 'cabin', I4_FPR);
    expect(short.frames.length).toBe(3);
    const cv3 = Math.sqrt((2 * (1 - 13 / 15) ** 2 + (0.6 - 13 / 15) ** 2) / 3) / (13 / 15);
    expect(cv3).toBeCloseTo(0.217571, 6);
    short.frames.forEach((f, k) => {
      expect(f.irregularity, `frame ${k}`).toBeCloseTo(cv3, 9);
      expect(frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 750, 0.5, I4_FPR).irregularity, `frame ${k} alone`).toBeNull();
    });
  });

  it('measures a short run inside a clip over that whole run: not over the clip, the frame alone, or null', () => {
    // 750 rpm (cycle 7680 samples, window 30720 = 0.64 s) on 3 s of seeded noise, rpmAt defined only on [1.0, 1.375) s:
    // frames 8 and 9 are kept, a run of 0.375 s (samples 48000–66000, 2.34 cycles) between dropped frames. Both read
    // the CV of the run's 2 whole cycles. A window centred on the frame and shifted inside the CLIP would reach into
    // the dropped audio (other values), the frame alone holds 1.56 cycles (null), and a "null unless the whole
    // window fits" rule would read null.
    const x = white(3 * FS, 82, 0.1);
    const c = clipFeatures(x, FS, (t) => (t >= 1 && t < 1.375 ? 750 : Number.NaN), 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.map((f) => f.rpm)).toEqual([750, 750]);
    const run = frameFeatures(x.subarray(8 * HOP, 9 * HOP + FRAME), FS, 750, 0.5, I4_FPR).irregularity;
    expect(run).not.toBeNull();
    c.frames.forEach((f, m) => {
      const k = 8 + m;
      expect(f.irregularity, `frame ${k}`).toBe(run);
      const inClip = Math.min(Math.max(0, k * HOP + FRAME / 2 - 30720 / 2), 3 * FS - 30720);
      expect(frameFeatures(x.subarray(inClip, inClip + 30720), FS, 750, 0.5, I4_FPR).irregularity, `frame ${k} clip window`).not.toBe(run);
      expect(frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 750, 0.5, I4_FPR).irregularity, `frame ${k} alone`).toBeNull();
    });
  });

  it('measures idle: every frame of a 750 rpm clip is defined, though one 0.25 s frame holds 1.56 cycles', () => {
    // 750 rpm: one cycle = 160 ms → a 0.64 s window; the signal is cycle-periodic, so every cycle has the same RMS.
    const x = cyclic(3 * FS, 750);
    const c = clipFeatures(x, FS, () => 750, 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(23);
    for (const f of c.frames) {
      expect(f.irregularity).not.toBeNull();
      expect(f.irregularity ?? Number.NaN).toBeLessThan(1e-9);
    }
    expect(frameFeatures(x.subarray(0, FRAME), FS, 750, 0.5, I4_FPR).irregularity).toBeNull();
  });

  it('never reaches into audio whose frames were dropped: the window stays inside its run of kept frames', () => {
    // 750 rpm, cycle-periodic, 5× louder before 0.5 s where rpmAt is undefined (e.g. an unvoiced stretch of a
    // tracked reference): those frames are dropped, and a 0.64 s window centred on the frame at 0.5 s would
    // otherwise reach back to 0.305 s and read the level step as irregularity.
    const x = cyclic(3 * FS, 750).map((v, i) => (i < FS / 2 ? 5 * v : v));
    const c = clipFeatures(x, FS, (t) => (t < 0.5 ? Number.NaN : 750), 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(19);
    for (const f of c.frames) expect(f.irregularity ?? Number.NaN).toBeLessThan(1e-9);
  });

  it('is null when even the whole clip holds fewer than two cycles (a lone 0.25 s frame at 900 rpm)', () => {
    const c = clipFeatures(cyclic(FRAME, 900), FS, () => 900, 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(1);
    expect(c.frames[0]?.irregularity).toBeNull();
  });

  it('is the frame itself at and above 1920 rpm (4 cycles ≤ 0.25 s): frames equal frameFeatures of their slice', () => {
    const x = perCycle(cyclic(FS, 2400), 1200, [1, 0.7, 0.9]);
    const c = clipFeatures(x, FS, () => 2400, 0.5, 'cruise', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(7);
    c.frames.forEach((f, k) => {
      expect(f.irregularity, `frame ${k}`).toBe(frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 2400, 0.5, I4_FPR).irregularity);
    });
  });
});

describe('frameFeatures — fiLineHz (per-frame line)', () => {
  const noise = white(FRAME, 21, 0.01);

  it('finds a 2.5 kHz tone over broadband noise', () => {
    const f = frameFeatures(mix(noise, tone(FRAME, FS, 2500, 0.02)), FS, 3000, 0.5, I4_FPR);
    expect(Math.abs(fiOf(f) - 2500)).toBeLessThan(1);
  });

  it('tracks a tone anywhere in 1–4 kHz to within 1 Hz', () => {
    for (const hz of [1050, 1777.7, 3333.3, 3850]) {
      const f = frameFeatures(mix(noise, tone(FRAME, FS, hz, 0.02, 0.3)), FS, 3000, 0.5, I4_FPR);
      expect(Math.abs(fiOf(f) - hz), `${hz} Hz`).toBeLessThan(1);
    }
  });

  it('is null for broadband noise alone (no false lines in any of 31 frames)', () => {
    const x = white(4 * FS, 22, 0.05);
    for (let k = 0; k < 31; k++) {
      expect(frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 3000, 0.5, I4_FPR).fiLineHz, `frame ${k}`).toBeNull();
    }
  });

  it('ignores strong tones outside 1–4 kHz', () => {
    const x = mix(noise, tone(FRAME, FS, 800, 0.1), tone(FRAME, FS, 4500, 0.1, 0.5));
    expect(frameFeatures(x, FS, 3000, 0.5, I4_FPR).fiLineHz).toBeNull();
  });

  it('needs ≥ 10 dB prominence over the local median: a ≈ 7.6 dB line is ignored, a ≈ 12.6 dB line found', () => {
    // Prominences measured with the 40 ms Welch PSD on this noise (seed 21): amplitude 0.0012 → 7.6 dB,
    // 0.0022 → 12.6 dB, so a 5 dB or a 15 dB threshold fails one of the two.
    expect(frameFeatures(mix(noise, tone(FRAME, FS, 2200, 0.0012)), FS, 3000, 0.5, I4_FPR).fiLineHz).toBeNull();
    const f = frameFeatures(mix(noise, tone(FRAME, FS, 2200, 0.0022)), FS, 3000, 0.5, I4_FPR);
    expect(Math.abs(fiOf(f) - 2200)).toBeLessThan(2);
  });

  it('measures prominence over the local median, not the mean: a line among close neighbours is still found', () => {
    // A 1.2 kHz line (0.05) between neighbours at 1.1 and 1.3 kHz (0.045), and an isolated 3.5 kHz line (0.02).
    // The 1.2 kHz line stands ≈ 40 dB over the noise. The cluster's main lobes and skirts lift 27 of the 48
    // bins of the ±⅓-octave window around it by > 3 dB, yet raise the window median by only ≈ 8 dB and its
    // mean by ≈ 32 dB: the line keeps ≈ 32 dB of prominence over the median but only ≈ 8 dB over the mean,
    // below the 10 dB threshold. Over a local mean only the weaker isolated line would pass, reading 3.5 kHz.
    const x = mix(
      noise,
      tone(FRAME, FS, 1200, 0.05, 0.1),
      tone(FRAME, FS, 1100, 0.045, 0.9),
      tone(FRAME, FS, 1300, 0.045, 1.7),
      tone(FRAME, FS, 3500, 0.02, 2.3),
    );
    expect(Math.abs(fiOf(frameFeatures(x, FS, 3000, 0.5, I4_FPR)) - 1200)).toBeLessThan(1);
  });

  it('returns the strongest of several prominent lines', () => {
    const a = frameFeatures(mix(noise, tone(FRAME, FS, 1500, 0.02), tone(FRAME, FS, 3500, 0.05, 1)), FS, 3000, 0.5, I4_FPR);
    expect(Math.abs(fiOf(a) - 3500)).toBeLessThan(1);
    const b = frameFeatures(mix(noise, tone(FRAME, FS, 1500, 0.05), tone(FRAME, FS, 3500, 0.02, 1)), FS, 3000, 0.5, I4_FPR);
    expect(Math.abs(fiOf(b) - 1500)).toBeLessThan(1);
  });

  it('prefers a prominent line over louder but non-prominent broadband energy', () => {
    // Steep f^-4 power density (raw multisine: random-phase lines of amplitude a(f) = 2·(f/1k)^-2
    // every fs/16384 Hz): the floor near 1 kHz is 40·log10(3.5) = 21.8 dB above the floor at 3.5 kHz.
    // With 2048-sample Hann segments (1/8 of the 16384 grid period) a tone of amplitude B peaks
    // B²/(12·a²) above such a floor, so B = a(3.5k)·√(12·10^1.6) puts a 3.5 kHz line ≈ 16 dB above
    // its local floor yet ≈ 6 dB below the floor near 1 kHz.
    const a = 2 * Math.pow(3.5, -2);
    const x = mix(powerLaw(FRAME, FS, -2, 9), tone(FRAME, FS, 3500, a * Math.sqrt(12 * Math.pow(10, 1.6)), 0.2));
    expect(Math.abs(fiOf(frameFeatures(x, FS, 3000, 0.5, I4_FPR)) - 3500)).toBeLessThan(2);
  });
});

describe('frameFeatures — fiLineHz has no engine-order exclusion (amendment D5)', () => {
  const noise = white(FRAME, 21, 0.01);

  it('reports a line sitting on an engine order; the rpm, step and firing order never change it', () => {
    // 2 kHz is engine order 40 at 3000 rpm (an I4 firing harmonic), order 20 at 6000 rpm (a V8 firing harmonic) and
    // order 13⅓ on a rotary's ⅓ grid at 9000 rpm: amendment D2.2 ignored it each time; D5 reports it.
    const x = mix(noise, tone(FRAME, FS, 2000, 0.02, 0.3));
    const line = frameFeatures(x, FS, 3000, 0.5, I4_FPR).fiLineHz;
    expect(Math.abs((line ?? Number.NaN) - 2000)).toBeLessThan(1);
    for (const [rpm, step, fpr] of [
      [6000, 0.5, 4],
      [9000, 1 / 3, 2],
      [850, 0.5, 2.5],
      [2000.5, 0.5, 2],
    ] as const) {
      expect(frameFeatures(x, FS, rpm, step, fpr).fiLineHz, `${rpm} rpm, step ${step}, firingsPerRev ${fpr}`).toBe(line);
    }
  });

  it('an NA V8 firing stack reads its strongest prominent harmonic: order 12 (1200 Hz) at 6000 rpm', () => {
    // V8 at 6000 rpm: firing harmonics 4·h (400·h Hz, h = 1..10, amplitude 1/h) plus half-orders 11.5, 12.5
    // (1150, 1250 Hz at 0.3) and 16.5 (1650 Hz at 0.2): the order-12 line (⅓) is the strongest line in 1–4 kHz, in
    // every frame. Amendment D3 keeps fiLine out of the scoring of NA engines, so such a harmonic never enters a score.
    const lines: [number, number][] = [[11.5, 0.3], [12.5, 0.3], [16.5, 0.2]];
    for (let h = 1; h <= 10; h++) lines.push([4 * h, 1 / h]);
    const x = mix(orderLines(FS, FS, 6000, lines), white(FS, 24, 0.001));
    expect(Math.abs(fiOf(frameFeatures(x.subarray(0, FRAME), FS, 6000, 0.5, 4)) - 1200)).toBeLessThan(1);
    const c = clipFeatures(x, FS, () => 6000, 0.5, 'cruise', 'outside', 4);
    expect(c.frames.length).toBe(7);
    c.frames.forEach((f, k) => expect(Math.abs(fiOf(f) - 1200), `frame ${k}`).toBeLessThan(1));
  });

  it('finds a supercharger-like whine at order 19.2, 1.05 % from engine order 19 (inside the old ±3 % exclusion)', () => {
    // 4000 rpm: order 19.2 = 1280 Hz, between the engine orders 19 (1266.7 Hz) and 19.5 (1300 Hz).
    for (const rpm of [4000, 5000, 6000]) {
      const whine = (19.2 * rpm) / 60;
      const f = frameFeatures(mix(noise, orderLines(FRAME, FS, rpm, [[19.2, 0.02]])), FS, rpm, 0.5, 4);
      expect(Math.abs(fiOf(f) - whine), `${rpm} rpm: ${f.fiLineHz} Hz vs ${whine} Hz`).toBeLessThan(1);
    }
  });
});

describe('clipFeatures — fiLineHz persistence: ≥ 3 consecutive frames within ±5 % (amendment D5)', () => {
  /** A 2.5 kHz line (0.02) over white noise (0.01). */
  const line = (seconds: number): Float64Array => mix(white(Math.round(seconds * FS), 25, 0.01), tone(Math.round(seconds * FS), FS, 2500, 0.02, 0.4));

  /**
   * 2 s of white noise (0.01, seed 25) with a 2.5 kHz tone (0.02) switched on only in the given 0.125 s hop slots
   * (slot s = samples [6000·s, 6000·(s + 1))). Frame k spans exactly slots k and k + 1, so it holds the tone iff
   * one of them is on.
   */
  const gated = (on: readonly number[]): Float64Array => {
    const n = 2 * FS;
    const x = white(n, 25, 0.01);
    const t = tone(n, FS, 2500, 0.02, 0.4);
    for (let i = 0; i < n; i++) if (on.includes(Math.floor(i / HOP))) x[i] = (x[i] ?? 0) + (t[i] ?? 0);
    return x;
  };

  /**
   * 2 s of white noise (0.005, seed 26) with a tone (0.05) in every other 0.125 s slot only, stepping by ρ each
   * time: f0·ρ^j Hz in slot 2j. Frame k (slots k, k + 1) holds exactly one of them, f0·ρ^⌈k/2⌉ Hz, so consecutive
   * frames alternately share a tone and differ by one step ρ.
   */
  const stepped = (f0: number, rho: number): Float64Array => {
    const n = 2 * FS;
    const x = white(n, 26, 0.005);
    for (let s = 0; s < 16; s += 2) {
      const t = tone(HOP, FS, f0 * rho ** (s / 2), 0.05, 0.3 * s);
      for (let i = 0; i < HOP; i++) x[s * HOP + i] = (x[s * HOP + i] ?? 0) + (t[i] ?? 0);
    }
    return x;
  };

  it('reports a line only inside runs of ≥ 3 consecutive frames', () => {
    expect(FI_MIN_RUN_FRAMES).toBe(3);
    // Tone in slots 0, 1 | 4, 5 | 8 | 11, 12, 13 of 16: the per-frame detector sees it in frames 0–1 | 3–5 | 7–8 |
    // 10–13 (each frame spans two slots), so only the runs 3–5 and 10–13 are reported.
    const x = gated([0, 1, 4, 5, 8, 11, 12, 13]);
    const c = clipFeatures(x, FS, () => 3000, 0.5, 'cruise', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(15);
    const seen = [0, 1, 3, 4, 5, 7, 8, 10, 11, 12, 13];
    const reported = [3, 4, 5, 10, 11, 12, 13];
    c.frames.forEach((f, k) => {
      const own = frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 3000, 0.5, I4_FPR).fiLineHz;
      expect(own === null, `frame ${k} per-frame`).toBe(!seen.includes(k));
      if (reported.includes(k)) expect(Math.abs(fiOf(f) - 2500), `frame ${k}`).toBeLessThan(1);
      else expect(f.fiLineHz, `frame ${k}`).toBeNull();
    });
  });

  it('chains consecutive frames whose lines lie within ±5 %: steps of 4.8 % keep the run, steps of 5.2 % break it', () => {
    expect(FI_RUN_TOLERANCE).toBe(0.05);
    // The stepped clip (see `stepped`): consecutive frames alternately share a tone and differ by one step ρ. With
    // steps of 4.8 % the clip is one run — the chain follows the line through 7 steps, 39 % in all (no anchor
    // frame) — and every frame is reported; with steps of 5.2 % every run is a pair and nothing is, although every
    // frame holds its tone (to within 0.1 Hz: the steps are resolved). The same holds stepping down (ρ = 1/1.048,
    // 1/1.052): the tolerance is symmetric — a falling ratio of 1/1.052 = 0.9506 is "within 5 % of the earlier
    // line" but 5.2 % below it.
    for (const [f0, rho, kept] of [
      [1500, 1.048, true],
      [1500, 1.052, false],
      [2200, 1 / 1.048, true],
      [2200, 1 / 1.052, false],
    ] as const) {
      const x = stepped(f0, rho);
      const c = clipFeatures(x, FS, () => 3000, 0.5, 'wot', 'cabin', I4_FPR);
      expect(c.frames.length).toBe(15);
      c.frames.forEach((f, k) => {
        const hz = f0 * rho ** Math.ceil(k / 2);
        const own = frameFeatures(x.subarray(k * HOP, k * HOP + FRAME), FS, 3000, 0.5, I4_FPR).fiLineHz;
        expect(Math.abs((own ?? Number.NaN) - hz), `ρ ${rho} frame ${k} per-frame`).toBeLessThan(0.1);
        if (kept) expect(f.fiLineHz, `ρ ${rho} frame ${k}`).toBe(own);
        else expect(f.fiLineHz, `ρ ${rho} frame ${k}`).toBeNull();
      });
    }
  });

  it('cannot show persistence in a clip of one or two frames, unlike frameFeatures', () => {
    expect(Math.abs(fiOf(frameFeatures(line(0.25), FS, 3000, 0.5, I4_FPR)) - 2500)).toBeLessThan(1);
    for (const [seconds, frames] of [[0.25, 1], [0.375, 2]] as const) {
      const c = clipFeatures(line(seconds), FS, () => 3000, 0.5, 'cruise', 'cabin', I4_FPR);
      expect(c.frames.length).toBe(frames);
      expect(c.frames.map((f) => f.fiLineHz), `${frames} frame(s)`).toEqual(new Array<null>(frames).fill(null));
    }
    const three = clipFeatures(line(0.5), FS, () => 3000, 0.5, 'cruise', 'cabin', I4_FPR);
    expect(three.frames.length).toBe(3);
    for (const f of three.frames) expect(Math.abs(fiOf(f) - 2500)).toBeLessThan(1);
  });

  it('a frame dropped for an invalid rpm breaks the run', () => {
    // Slot 3 has no rpm: frames 2 and 3 (spanning it) are dropped, leaving runs 0–1 and 4–6 of a steady line.
    const slots = [3000, 3000, 3000, Number.NaN, 3000, 3000, 3000, 3000];
    const c = clipFeatures(line(1), FS, slotRpm(slots), 0.5, 'cruise', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(5);
    expect(c.frames.slice(0, 2).map((f) => f.fiLineHz)).toEqual([null, null]);
    for (const f of c.frames.slice(2)) expect(Math.abs(fiOf(f) - 2500)).toBeLessThan(1);
  });

  it('consecutive frames must carry the same line: a line hopping 1.5 → 2.5 → 3.5 kHz every 0.125 s is never reported', () => {
    // Frame k spans slots k and k + 1, so two consecutive frames can only share slot k + 1's line and the third
    // frame holds neither of the two earlier lines: no run of three agrees (within 5 %), whatever each frame picks.
    const hopping = (freqs: readonly number[]): Float64Array => {
      const n = 2 * FS;
      const tones = freqs.map((hz, j) => tone(n, FS, hz, 0.05, 0.4 * j));
      const x = white(n, 26, 0.005);
      for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) + (tones[Math.floor(i / HOP) % freqs.length]?.[i] ?? 0);
      return x;
    };
    const hop = hopping([1500, 2500, 3500]);
    const c = clipFeatures(hop, FS, () => 3000, 0.5, 'wot', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(15);
    c.frames.forEach((f, k) => {
      expect(frameFeatures(hop.subarray(k * HOP, k * HOP + FRAME), FS, 3000, 0.5, I4_FPR).fiLineHz, `frame ${k} per-frame`).not.toBeNull();
      expect(f.fiLineHz, `frame ${k}`).toBeNull();
    });
    // The same construction with one continuous line is reported in every frame.
    const steady = clipFeatures(hopping([2500]), FS, () => 3000, 0.5, 'wot', 'cabin', I4_FPR);
    for (const f of steady.frames) expect(Math.abs(fiOf(f) - 2500)).toBeLessThan(1);
  });

  it('never reads the rpm: the same clip gives the same lines under any rpmAt that keeps its frames', () => {
    // No engine-order exclusion and no rpm allowance (amendment D5): the gated clip read at a steady 3000 rpm, at
    // 850 rpm (where 2.5 kHz is engine order 176.5), through a 1000 → 7000 rpm sweep and with slot-wise rpm jumps
    // of ×1.5 gives identical lines, frame for frame.
    const lines = (x: Float64Array, rpmAt: (t: number) => number): (number | null)[] =>
      clipFeatures(x, FS, rpmAt, 0.5, 'wot', 'cabin', I4_FPR).frames.map((f) => f.fiLineHz);
    const x = gated([0, 1, 4, 5, 8, 11, 12, 13]);
    const ref = lines(x, () => 3000);
    expect(ref.filter((v) => v !== null).length).toBe(7);
    expect(lines(x, () => 850)).toEqual(ref);
    expect(lines(x, (t) => 1000 + 3000 * t)).toEqual(ref);
    expect(lines(x, slotRpm([2000, 3000, 2000, 3000, 2000, 3000, 2000, 3000, 2000, 3000, 2000, 3000, 2000, 3000, 2000, 3000]))).toEqual(ref);
    // Lines 5.2 % apart stay apart even while the rpm climbs 6 % per hop, as it would for an order-locked line: an
    // rpm-motion allowance (|ln(rpm_b / rpm_a)| on top of the tolerance, as the D2.2 implementation had) would
    // chain the stepped clip.
    const steps = stepped(1500, 1.052);
    expect(lines(steps, (t) => 3000 * 1.06 ** (t / 0.125))).toEqual(new Array<null>(15).fill(null));
  });

  it('follows an order-locked whine through a moderate sweep (≤ 3 % per hop) with the rpm', () => {
    // A phase-continuous whine at order 19.2 over white noise while the rpm climbs 4000 → 6000 over 2 s (1000 rpm/s,
    // a 4th-gear-like pull): it moves 3.0 % → 2.1 % per hop and smears over ≤ 6.3 % within a frame, and is reported
    // in all 15 frames, each within 0.1 % of order 19.2 at the frame's mean rpm (measured ≤ 0.04 %).
    const n = 2 * FS;
    const x = white(n, 27, 0.005);
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      x[i] = (x[i] ?? 0) + 0.05 * Math.cos(2 * Math.PI * (19.2 / 60) * (4000 * t + 500 * t * t));
    }
    const c = clipFeatures(x, FS, (t) => 4000 + 1000 * t, 0.5, 'wot', 'cabin', 4);
    expect(c.frames.length).toBe(15);
    c.frames.forEach((f, k) => expect(Math.abs(fiOf(f) / ((19.2 * f.rpm) / 60) - 1), `frame ${k}`).toBeLessThan(0.001));
  });
});

describe('frameFeatures — scale invariance', () => {
  it('only levelDb and orderAmp depend on the gain', () => {
    const lumpy = orderLines(FRAME, FS, 3000, [[0.5, 0.3], [1.5, 0.2], [2, 1], [4, 0.5], [6, 0.2]]);
    const x = mix(perCycle(lumpy, 1920, [1, 0.8, 0.9]), tone(FRAME, FS, 2500, 0.05), white(FRAME, 31, 0.02));
    const a = frameFeatures(x, FS, 3000, 0.5, 2);
    for (const v of [a.centroidHz, a.tiltDbPerOct, a.subOrderDb, a.irregularity ?? Number.NaN]) expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(fiOf(a) - 2500)).toBeLessThan(1); // the 2.5 kHz tone (engine order 50: no exclusion, D5)
    for (const g of [1000, 1e-3]) {
      const b = frameFeatures(scaled(x, g), FS, 3000, 0.5, 2);
      expect(b.levelDb - a.levelDb).toBeCloseTo(20 * Math.log10(g), 9);
      for (let i = 0; i < a.orderAmp.length; i++) expect((b.orderAmp[i] ?? 0) / (a.orderAmp[i] ?? 1)).toBeCloseTo(g, 6);
      expect(b.centroidHz).toBeCloseTo(a.centroidHz, 6);
      expect(b.tiltDbPerOct).toBeCloseTo(a.tiltDbPerOct, 9);
      expect(b.subOrderDb).toBeCloseTo(a.subOrderDb, 9);
      expect(b.irregularity ?? Number.NaN).toBeCloseTo(a.irregularity ?? Number.NaN, 9);
      expect(b.fiLineHz ?? Number.NaN).toBeCloseTo(a.fiLineHz ?? Number.NaN, 6);
    }
  });
});

describe('frameFeatures — degenerate input', () => {
  const x = tone(FRAME, FS, 100, 0.5);

  it('rejects an empty frame, a non-positive or non-finite fs/rpm/step, and non-finite samples', () => {
    expect(() => frameFeatures(new Float64Array(0), FS, 3000, 0.5, I4_FPR)).toThrow(RangeError);
    for (const fs of [0, -48000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => frameFeatures(x, fs, 3000, 0.5, I4_FPR), `fs ${fs}`).toThrow(RangeError);
    }
    for (const rpm of [0, -1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => frameFeatures(x, FS, rpm, 0.5, I4_FPR), `rpm ${rpm}`).toThrow(RangeError);
    }
    for (const step of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 13]) {
      expect(() => frameFeatures(x, FS, 3000, step, I4_FPR), `step ${step}`).toThrow(RangeError);
    }
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = Float64Array.from(x);
      bad[777] = v;
      expect(() => frameFeatures(bad, FS, 3000, 0.5, I4_FPR), `sample ${v}`).toThrow(RangeError);
    }
  });

  it('accepts frames of any length ≥ 1 (relative features undefined where a frame is too short to hold them)', () => {
    for (const n of [1, 2, 3, 100]) {
      const f = frameFeatures(white(n, 71, 0.1), FS, 3000, 0.5, I4_FPR);
      expect(f.orderAmp.length, `n ${n}`).toBe(24);
      expect(f.irregularity, `n ${n}`).toBeNull(); // < 2 cycles of 40 ms
      expect(Number.isFinite(f.levelDb), `n ${n}`).toBe(true);
    }
  });

  it('a frame at the −200 dB level floor (RMS ≤ 1e-10) is silent: no relative features', () => {
    const residue = frameFeatures(mix(white(FRAME, 61, 5e-11), tone(FRAME, FS, 2500, 5e-11)), FS, 3000, 0.5, 2);
    expect(residue.levelDb).toBe(-200);
    expect([residue.centroidHz, residue.tiltDbPerOct, residue.subOrderDb]).toEqual([NaN, NaN, NaN]);
    expect(residue.irregularity).toBeNull();
    expect(residue.fiLineHz).toBeNull();
    // The same frame 20 dB louder is above the floor: every relative feature is defined.
    const quiet = frameFeatures(mix(white(FRAME, 61, 5e-10), tone(FRAME, FS, 2500, 5e-10)), FS, 3000, 0.5, 2);
    expect(quiet.levelDb).toBeGreaterThan(-200);
    for (const v of [quiet.centroidHz, quiet.tiltDbPerOct, quiet.subOrderDb, quiet.irregularity ?? Number.NaN]) expect(Number.isFinite(v)).toBe(true);
    expect(quiet.fiLineHz).not.toBeNull();
  });

  it('a digitally silent frame has no relative features: NaN/null, no fi line, −200 dB, zero order amplitudes', () => {
    const f = frameFeatures(new Float64Array(FRAME), FS, 3000, 0.5, 2);
    expect(Array.from(f.orderAmp)).toEqual(new Array<number>(24).fill(0));
    expect(f.levelDb).toBe(-200);
    expect(f.centroidHz).toBeNaN();
    expect(f.tiltDbPerOct).toBeNaN();
    expect(f.subOrderDb).toBeNaN();
    expect(f.irregularity).toBeNull();
    expect(f.fiLineHz).toBeNull();
  });
});

describe('clipFeatures', () => {
  const clip = mix(
    orderLines(FS, FS, 3000, [[0.5, 0.2], [2, 1], [4, 0.4]]),
    tone(FS, FS, 2500, 0.05),
    white(FS, 41, 0.02),
  );

  it('cuts 0.25 s frames every 0.125 s, each analysed at the mean of rpmAt over the frame', () => {
    // Above 1920 rpm the irregularity window is the frame itself, and the 2.5 kHz line persists through all 7
    // frames, so every frame equals frameFeatures of its slice.
    const rpmAt = (t: number): number => 2000 + 1000 * t; // linear: the frame mean is the midpoint value
    const c = clipFeatures(clip, FS, rpmAt, 0.5, 'wot', 'cabin', 2);
    expect(c.kind).toBe('wot');
    expect(c.perspective).toBe('cabin');
    expect(c.frames.length).toBe(7); // starts 0, 0.125, …, 0.75 s
    c.frames.forEach((f, k) => {
      const rpm = 2000 + 1000 * (0.125 * k + 0.125);
      expect(f.rpm, `frame ${k}`).toBeCloseTo(rpm, 6);
      expect(Number.isFinite(f.subOrderDb), `frame ${k}`).toBe(true);
      expect(Math.abs(fiOf(f) - 2500), `frame ${k}`).toBeLessThan(1);
      expect(f, `frame ${k}`).toEqual(frameFeatures(clip.slice(k * HOP, k * HOP + FRAME), FS, f.rpm, 0.5, 2));
    });
  });

  it('averages rpmAt over the frame rather than sampling it at the centre', () => {
    // rpm(t) = 3000 + 4000·t²: mean over [a, b] = 3000 + 4000·(b³ − a³)/(3(b − a)); the centre value
    // is lower by 4000·0.25²/12 = 20.8 rpm.
    const c = clipFeatures(clip, FS, (t) => 3000 + 4000 * t * t, 0.5, 'wot', 'outside', I4_FPR);
    expect(c.frames.length).toBe(7);
    c.frames.forEach((f, k) => {
      const a = 0.125 * k;
      const b = a + 0.25;
      expect(Math.abs(f.rpm - (3000 + (4000 * (b ** 3 - a ** 3)) / (3 * (b - a)))), `frame ${k}`).toBeLessThan(0.5);
    });
  });

  it('accepts any ArrayLike (Float32Array renders, plain arrays)', () => {
    const f32 = Float32Array.from(clip);
    const a = clipFeatures(f32, FS, () => 3000, 0.5, 'cruise', 'cabin', 2);
    const b = clipFeatures(Array.from(f32), FS, () => 3000, 0.5, 'cruise', 'cabin', 2);
    expect(a.frames.length).toBe(7);
    expect(b).toEqual(a);
  });

  it('skips frames where rpmAt is not a finite positive number anywhere in the frame', () => {
    // Frames end at 0.25, 0.375, 0.5, 0.625 … s: only the first three lie wholly before 0.5 s.
    for (const invalid of [Number.NaN, 0, -3000, Number.POSITIVE_INFINITY]) {
      const c = clipFeatures(clip, FS, (t) => (t < 0.5 ? 3000 : invalid), 0.5, 'wot', 'cabin', I4_FPR);
      expect(c.frames.map((f) => f.rpm), `rpm ${invalid} after 0.5 s`).toEqual([3000, 3000, 3000]);
    }
    expect(clipFeatures(clip, FS, () => -3000, 0.5, 'wot', 'cabin', I4_FPR).frames).toEqual([]);
  });

  it('skips digitally silent frames', () => {
    const gap = clip.slice();
    gap.fill(0, 0, FS / 2); // first 0.5 s silent: frames starting at 0, 0.125, 0.25 s are all-zero
    const c = clipFeatures(gap, FS, () => 3000, 0.5, 'idle', 'cabin', I4_FPR);
    expect(c.frames.length).toBe(4);
    expect(c.frames.every((f) => Number.isFinite(f.centroidHz))).toBe(true);
  });

  it('has no frames for a clip shorter than one frame', () => {
    expect(clipFeatures(clip.slice(0, FRAME - 1), FS, () => 3000, 0.5, 'idle', 'cabin', I4_FPR).frames).toEqual([]);
  });

  it('forwards firingsPerRev to every frame', () => {
    const i5 = orderLines(FS, FS, 3000, [[2.5, 1], [5, 1 / 2], [7.5, 1 / 3], [0.5, 0.1], [1.5, 0.1]]);
    // 10·log10(2·0.1²/(1 + ¼ + 1/9)) = −18.33 dB re the I5 firing stack 2.5/5/7.5.
    const c = clipFeatures(i5, FS, () => 3000, 0.5, 'cruise', 'cabin', 2.5);
    expect(c.frames.length).toBe(7);
    for (const f of c.frames) expect(f.subOrderDb).toBeCloseTo(-18.33, 1);
    // The same clip read as an I4 (firing order 2) counts the 2.5 and 7.5 lines as sub-orders.
    for (const f of clipFeatures(i5, FS, () => 3000, 0.5, 'cruise', 'cabin', 2).frames) expect(f.subOrderDb).toBeGreaterThan(0);
  });

  it('validates fs and step and rejects non-finite samples anywhere in the clip', () => {
    expect(() => clipFeatures(clip, 0, () => 3000, 0.5, 'idle', 'cabin', I4_FPR)).toThrow(RangeError);
    expect(() => clipFeatures(clip, FS, () => 3000, 0, 'idle', 'cabin', I4_FPR)).toThrow(RangeError);
    const bad = new Float64Array(FS + 1000);
    bad.set(clip);
    bad[FS + 999] = Number.NaN; // in the tail after the last whole frame (frames end by 1.0 s)
    expect(() => clipFeatures(bad, FS, () => 3000, 0.5, 'idle', 'cabin', I4_FPR)).toThrow(RangeError);
  });

  it('measures overrunRate for liftoff clips only', () => {
    expect(clipFeatures(clip, FS, () => 3000, 0.5, 'wot', 'cabin', I4_FPR).overrunRate).toBeNull();
    expect(clipFeatures(clip, FS, () => 3000, 0.5, 'liftoff6k', 'cabin', I4_FPR).overrunRate).toBeNull();
    const lift = clipFeatures(clip, FS, () => 3000, 0.5, 'liftoff', 'outside', I4_FPR);
    expect(lift.overrunRate).toBe(overrunRate(clip, FS));
    expect(lift.overrunRate).toBe(0); // steady tones + noise: no onsets
  });
});

describe('overrunRate', () => {
  /** 2 ms blocks and 50 ms history at 48 kHz; a 2.05 s clip leaves exactly 2.0 s of evaluated blocks. */
  const BLOCK = 96;
  const N = Math.round(2.05 * FS);
  /** Steady background above the 1 kHz high-pass: a 12 kHz tone (period 4 samples, equal energy per block). */
  const bg = (): Float64Array => tone(N, FS, 12000, 0.01, 0.25);

  it('uses a 9 dB onset threshold', () => {
    expect(OVERRUN_ONSET_DB).toBe(9);
  });

  it('counts every click of an irregular sparse train: onsets per second', () => {
    const x = bg();
    let clicks = 0;
    for (let j = 0; j < 23; j++) {
      const t = 0.06 + 0.085 * j + 0.02 * Math.sin(3 * j);
      x[Math.round(t * FS)] = (x[Math.round(t * FS)] ?? 0) + (j % 2 === 0 ? 0.5 : -0.3);
      clicks++;
    }
    expect(overrunRate(x, FS)).toBeCloseTo(clicks / 2, 9); // 11.5 / s
  });

  it('is 0 for stationary noise', () => {
    expect(overrunRate(white(N, 51, 0.1), FS)).toBe(0);
  });

  it('needs a ≥ 9 dB jump over the 50 ms median: +8 dB blocks are ignored, +10 dB blocks are counted', () => {
    const burst = (db: number): Float64Array => {
      const x = bg();
      const g = Math.pow(10, db / 20);
      for (let b = 0; b < 10; b++) {
        const start = (100 + 50 * b) * BLOCK; // one whole 2 ms block every 100 ms
        for (let i = start; i < start + BLOCK; i++) x[i] = (x[i] ?? 0) * g;
      }
      return x;
    };
    expect(overrunRate(burst(8), FS)).toBe(0);
    expect(overrunRate(burst(10), FS)).toBeCloseTo(10 / 2, 9);
  });

  it('counts a burst spanning several blocks once', () => {
    const x = bg();
    for (let b = 0; b < 5; b++) {
      const start = (100 + 150 * b) * BLOCK; // 6 ms (three blocks) at +20 dB every 300 ms
      for (let i = start; i < start + 3 * BLOCK; i++) x[i] = (x[i] ?? 0) * 10;
    }
    expect(overrunRate(x, FS)).toBeCloseTo(5 / 2, 9);
  });

  it('compares with the preceding 50 ms: a lasting +20 dB step is one onset, a step down none', () => {
    const x = bg();
    for (let i = 500 * BLOCK; i < 750 * BLOCK; i++) x[i] = (x[i] ?? 0) * 10; // up at 1.0 s, down at 1.5 s
    expect(overrunRate(x, FS)).toBeCloseTo(1 / 2, 9);
  });

  it('compares with the median of the preceding 50 ms, not the mean', () => {
    // 1.05 s → 1.0 s evaluated. Single blocks 200, 202, …, 248 at +30 dB are 25 onsets; block 251 at +18 dB
    // follows 25 blocks of which 12 are raised and 13 quiet (≈ +1 dB: the high-pass rings after each
    // raised block), so their median is quiet and 251 is a 26th onset. Their mean (≈ +15 dB) would hide it,
    // and a mean of block powers (≈ +27 dB) would hide most of the train too.
    const x = tone(Math.round(1.05 * FS), FS, 12000, 0.01, 0.25);
    const raise = (block: number, db: number): void => {
      const g = Math.pow(10, db / 20);
      for (let i = block * BLOCK; i < (block + 1) * BLOCK; i++) x[i] = (x[i] ?? 0) * g;
    };
    for (let b = 200; b <= 248; b += 2) raise(b, 30);
    raise(251, 18);
    expect(overrunRate(x, FS)).toBeCloseTo(26, 9);
  });

  it('high-passes at 1 kHz: a 1.5 kHz burst 12 dB over the background is an onset, a 500 Hz burst 17 dB over it is not', () => {
    // Smooth bursts (5 ms raised-cosine ramps, 10 ms flat top) every 0.19 s: their energy stays within
    // ≈ ±100 Hz of the tone. A 2nd-order Butterworth high-pass at 1 kHz takes 0.8 dB off 1.5 kHz (peak
    // block ≈ 11.5 dB over the background) and 12.3 dB off 500 Hz (≈ 5.9 dB). A 2 kHz corner would leave
    // the 1.5 kHz bursts at ≈ 6.8 dB; a 500 or 700 Hz corner would pass the 500 Hz bursts (≥ 10 dB).
    const bursts = (hz: number, db: number): Float64Array => {
      const x = bg();
      const amp = 0.01 * Math.pow(10, db / 20);
      const ramp = Math.round(0.005 * FS);
      const flat = Math.round(0.01 * FS);
      const len = 2 * ramp + flat;
      for (let j = 0; j < 10; j++) {
        const start = Math.round((0.1 + 0.19 * j) * FS);
        for (let i = 0; i < len; i++) {
          const edge = Math.min(i, len - i);
          const env = edge < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / ramp) : 1;
          x[start + i] = (x[start + i] ?? 0) + amp * env * Math.sin((2 * Math.PI * hz * i) / FS);
        }
      }
      return x;
    };
    expect(overrunRate(bursts(1500, 12), FS)).toBeCloseTo(10 / 2, 9);
    expect(overrunRate(bursts(500, 17), FS)).toBe(0);
  });

  it('high-passes at 1 kHz: smooth 100 Hz swells 30 dB above the background are not onsets', () => {
    const x = bg();
    const len = Math.round(0.04 * FS);
    for (let b = 0; b < 8; b++) {
      const start = Math.round((0.1 + 0.2 * b) * FS);
      for (let i = 0; i < len; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
        x[start + i] = (x[start + i] ?? 0) + 0.3 * w * Math.sin((2 * Math.PI * 100 * i) / FS);
      }
    }
    expect(overrunRate(x, FS)).toBe(0);
  });

  it('is null when less than 0.5 s can be evaluated after the 50 ms history (clips under 0.55 s)', () => {
    // 25 history blocks + 250 evaluated 2 ms blocks = 275 blocks is the shortest measured clip.
    expect(OVERRUN_MIN_SPAN_S).toBe(0.5);
    expect(overrunRate(tone(26 * BLOCK, FS, 12000, 0.01), FS)).toBeNull();
    expect(overrunRate(tone(274 * BLOCK, FS, 12000, 0.01), FS)).toBeNull();
    expect(overrunRate(tone(275 * BLOCK, FS, 12000, 0.01), FS)).toBe(0);
    expect(clipFeatures(tone(274 * BLOCK, FS, 12000, 0.01), FS, () => 3000, 0.5, 'liftoff', 'cabin', I4_FPR).overrunRate).toBeNull();
    expect(clipFeatures(tone(275 * BLOCK, FS, 12000, 0.01), FS, () => 3000, 0.5, 'liftoff', 'cabin', I4_FPR).overrunRate).toBe(0);
  });

  it('reads one onset in the shortest measured clip as 2 per second (a tiny window cannot read hundreds)', () => {
    const x = tone(275 * BLOCK, FS, 12000, 0.01, 0.25);
    x[200 * BLOCK + 10] = (x[200 * BLOCK + 10] ?? 0) + 0.5;
    expect(overrunRate(x, FS)).toBeCloseTo(1 / 0.5, 9);
  });

  it('rejects a non-positive fs and non-finite samples', () => {
    expect(() => overrunRate(bg(), 0)).toThrow(RangeError);
    const bad = bg();
    bad[5] = Number.NaN;
    expect(() => overrunRate(bad, FS)).toThrow(RangeError);
  });
});

describe('DSP renders: subOrderDb (exhaust bus, hot, steady rpm, load 0.5)', () => {
  /** Mean subOrderDb over the frames of the exhaust bus 0.5–1.5 s into a steady render. */
  function exhaustSubOrderDb(id: string, rpm: number, firingsPerRev: number): number {
    const out = new CoreHarness(loadFixture(id)).run(1.5, makeCtl(rpm, 0.5));
    const c = clipFeatures(slice(out.exhaust, 0.5, 1.5), FS, () => rpm, 0.5, 'cruise', 'outside', firingsPerRev);
    expect(c.frames.length).toBe(7);
    return c.frames.reduce((s, f) => s + f.subOrderDb, 0) / c.frames.length;
  }

  it('the uneven-fire cross-plane V8 reads ≥ 10 dB above the even-fire flat-plane V8', { timeout: 60_000 }, () => {
    for (const rpm of [2000, 4000]) {
      const cross = exhaustSubOrderDb('v8-crossplane-test', rpm, 4);
      const flat = exhaustSubOrderDb('v8-flatplane-test', rpm, 4);
      expect(cross, `${rpm} rpm: cross-plane ${cross.toFixed(1)} dB, flat-plane ${flat.toFixed(1)} dB`).toBeGreaterThan(flat + 10);
    }
  });

  it('the unequal-header I5 reads ≥ 10 dB above the equal-header even-fire I4', { timeout: 60_000 }, () => {
    const i5 = exhaustSubOrderDb('i5-test', 4000, 2.5);
    const i4 = exhaustSubOrderDb('i4-test', 4000, 2);
    expect(i5, `I5 ${i5.toFixed(1)} dB, I4 ${i4.toFixed(1)} dB`).toBeGreaterThan(i4 + 10);
  });
});

describe('DSP renders: irregularity at idle (exhaust bus, hot)', () => {
  it('every frame of an idle render is defined, though a lone 0.25 s frame holds < 2 cycles', { timeout: 60_000 }, () => {
    // v8-crossplane-test idles at 650 rpm: one 720° cycle = 185 ms (1.35 per frame), 4 cycles = 0.74 s.
    const d = loadFixture('v8-crossplane-test');
    const idle = d.spec.rpm.idle;
    const out = new CoreHarness(d).run(3, makeCtl(idle, 0, { driveline: 'clutch-open' }));
    const x = slice(out.exhaust, 0.5, 3);
    const c = clipFeatures(x, FS, () => idle, 0.5, 'idle', 'outside', 4);
    expect(c.frames.length).toBe(19);
    for (const f of c.frames) {
      expect(f.irregularity).not.toBeNull();
      expect(Number.isFinite(f.irregularity ?? Number.NaN)).toBe(true);
    }
    expect(frameFeatures(x.subarray(0, FRAME), FS, idle, 0.5, 4).irregularity).toBeNull();
  });
});

describe('DSP renders: fiLineHz (hot)', () => {
  it('reports the supercharger whine (order 19.2, 1.05 % from engine order 19) in every frame at steady rpm', { timeout: 60_000 }, () => {
    // Amendment D5: no engine-order exclusion, so the order-locked whine, the strongest prominent line of 1–4 kHz in
    // these renders, is found at the engine's own rpm, cabin and outside (D2.2's ±3 % exclusion hid it).
    const d = loadFixture('v8-sc-test');
    const fi = new ForcedInduction(FS);
    fi.configure(d.spec, d.voicing, 1);
    for (const perspective of ['cabin', 'outside'] as const) {
      for (const rpm of [4000, 5000, 6000]) {
        const whine = fi.whineHz(rpm); // 1280, 1600, 1920 Hz
        const out = new CoreHarness(d).run(1.5, makeCtl(rpm, 0.5, { perspective }));
        const c = clipFeatures(slice(out.left, 0.5, 1.5), FS, () => rpm, 0.5, 'cruise', perspective, 4);
        expect(c.frames.length).toBe(7);
        c.frames.forEach((f, k) => {
          const err = Math.abs(fiOf(f) / whine - 1);
          expect(err, `${perspective} ${rpm} rpm frame ${k}: ${f.fiLineHz} Hz vs ${whine} Hz`).toBeLessThanOrEqual(0.001);
        });
      }
    }
  });

  it('follows the whine through a 4th-gear-like pull: 4000 → 6000 rpm in 2 s, 2–3 % per hop', { timeout: 60_000 }, () => {
    // Load 1, rpm ramped per 128-sample quantum after 0.5 s at 4000 rpm. The core's rpm smoothing lags the control
    // ramp a little: measured −1.5 … −0.2 % re 19.2·rpm/60 at the frames' mean control rpm, in all 15 frames.
    const d = loadFixture('v8-sc-test');
    const fi = new ForcedInduction(FS);
    fi.configure(d.spec, d.voicing, 1);
    const ctl = makeCtl(4000, 1, { perspective: 'cabin' });
    const h = new CoreHarness(d);
    h.run(0.5, ctl);
    const t0 = h.tS;
    const out = h.run(2, ctl, (t) => {
      ctl.rpm = 4000 + 1000 * (t - t0);
    });
    const c = clipFeatures(out.left, FS, (t) => 4000 + 1000 * t, 0.5, 'wot', 'cabin', 4);
    expect(c.frames.length).toBe(15);
    c.frames.forEach((f, k) => expect(Math.abs(fiOf(f) / fi.whineHz(f.rpm) - 1), `frame ${k}`).toBeLessThan(0.03));
  });

  it('reports the turbo whistle under boost: i5-test reads f1 = 1000 + 3000·shaft Hz in every frame', { timeout: 60_000 }, () => {
    // Steady rpm and load for 4 s (the shaft spools up with τ = spoolTimeS = 0.55 s), analysed over 3–4 s. The
    // expected whistle comes from a replica ForcedInduction fed the same rpm and load for 3.5 s (mid-window):
    // shaft = √boost → f1 = 1963 / 2669 / 3396 Hz. Measured within 0.13 % in every frame, cabin and outside.
    const d = loadFixture('i5-test');
    for (const perspective of ['cabin', 'outside'] as const) {
      for (const [rpm, load] of [
        [4000, 0.5],
        [5000, 0.6],
        [6000, 0.8],
      ] as const) {
        const out = new CoreHarness(d).run(4, makeCtl(rpm, load, { perspective }));
        const fi = new ForcedInduction(FS);
        fi.configure(d.spec, d.voicing, 1);
        for (let i = 0; i < 3.5 * FS; i++) fi.tick(rpm, load);
        const whistle = 1000 + 3000 * Math.sqrt(fi.boost);
        const c = clipFeatures(slice(out.left, 3, 4), FS, () => rpm, 0.5, 'cruise', perspective, 2.5);
        expect(c.frames.length).toBe(7);
        c.frames.forEach((f, k) => {
          const err = Math.abs(fiOf(f) / whistle - 1);
          expect(err, `${perspective} ${rpm} rpm load ${load} frame ${k}: ${f.fiLineHz} Hz vs ${whistle.toFixed(1)} Hz`).toBeLessThan(0.003);
        });
      }
    }
  });
});
