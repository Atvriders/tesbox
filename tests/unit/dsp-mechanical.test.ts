import { describe, expect, it } from 'vitest';
import { MechanicalLayer } from '../../src/dsp/mechanical';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;

function makeLayer(blockGain: number, valvetrainGain: number, seed = 1, id = 'i4-test', fs = FS): MechanicalLayer {
  const def = loadFixture(id);
  def.voicing.mechanical = { blockGain, valvetrainGain };
  const layer = new MechanicalLayer(fs);
  layer.configure(def.spec, def.voicing, seed);
  return layer;
}

/** Hann-windowed Goertzel power at f. */
function tonePower(x: Float64Array, f: number, fs = FS): number {
  const n = x.length;
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Mean power over 21 bins spaced 2 Hz around f (noise-density estimate). */
function bandDensity(x: Float64Array, f: number): number {
  let p = 0;
  for (let k = -10; k <= 10; k++) p += tonePower(x, f + 2 * k);
  return p / 21;
}

/** Counts bursts: an onset is a sample with |x| > thr preceded by ≥ 1 ms of |x| ≤ thr. */
function countBursts(x: Float64Array, thr: number): number {
  let count = 0;
  let quiet = FS;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] ?? 0) > thr) {
      if (quiet >= FS / 1000) count++;
      quiet = 0;
    } else quiet++;
  }
  return count;
}

function renderValvetrain(layer: MechanicalLayer, rpm: number, n = FS): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = layer.tick(0, rpm);
  return y;
}

function thump(layer: MechanicalLayer, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = layer.tick(i === 0 ? 1 : 0, 0);
  return y;
}

function peakAbs(x: Float64Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

describe('MechanicalLayer', () => {
  it('is exactly silent with no ignition impulses at rpm 0', () => {
    const y = renderValvetrain(makeLayer(0.3, 0.1), 0);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('turns a unit ignition impulse into a 250 Hz low-passed thump peaking ≈ 0.45 × blockGain', () => {
    const y = thump(makeLayer(1, 0), 4800);
    const peak = peakAbs(y);
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.5);
    expect(tonePower(y, 100)).toBeGreaterThan(1000 * tonePower(y, 2000));
    expect(Math.abs(y[4799] ?? 1)).toBeLessThan(1e-6);
    const half = thump(makeLayer(0.5, 0), 4800);
    for (let i = 0; i < 4800; i++) expect(half[i] ?? NaN).toBeCloseTo(0.5 * (y[i] ?? NaN), 12);
  });

  it('keeps the thump level independent of the sample rate', () => {
    const p48 = peakAbs(thump(makeLayer(1, 0, 1, 'i4-test', 48000), 4800));
    const p44 = peakAbs(thump(makeLayer(1, 0, 1, 'i4-test', 44100), 4410));
    expect(Math.abs(p44 / p48 - 1)).toBeLessThan(0.03);
  });

  it('emits valvetrain bursts at rpm/120 × combustion count per second (I4)', () => {
    for (const [rpm, expected] of [
      [6000, 200],
      [3000, 100],
      [1200, 40],
    ] as const) {
      const y = renderValvetrain(makeLayer(0, 1), rpm);
      expect(Math.abs(countBursts(y, 0.02) - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('scales the burst rate with the combustion count (I6 at 4000 rpm → 200 per second)', () => {
    const y = renderValvetrain(makeLayer(0, 1, 1, 'i6-test'), 4000);
    expect(Math.abs(countBursts(y, 0.02) - 200)).toBeLessThanOrEqual(2);
  });

  it('makes each burst decay within ≈ 2 ms', () => {
    const y = renderValvetrain(makeLayer(0, 1, 4), 1200); // one burst every 12.5 ms
    // Energy in the first 2 ms after each onset vs. the 2–6 ms after it.
    let early = 0;
    let late = 0;
    let i = 0;
    while (i < y.length - 300) {
      if (Math.abs(y[i] ?? 0) > 0.02) {
        for (let k = 0; k < 96; k++) early += (y[i + k] ?? 0) ** 2;
        for (let k = 96; k < 288; k++) late += (y[i + k] ?? 0) ** 2;
        i += 480;
      } else i++;
    }
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(1e-3 * early);
  });

  it('band-limits the valvetrain tick around 3 kHz', () => {
    const y = renderValvetrain(makeLayer(0, 1, 9), 6000);
    const at = bandDensity(y, 3000);
    expect(at).toBeGreaterThan(30 * bandDensity(y, 300));
    expect(at).toBeGreaterThan(10 * bandDensity(y, 15000));
  });

  it('scales the valvetrain exactly with valvetrainGain (same seed)', () => {
    const full = renderValvetrain(makeLayer(0, 1, 5), 6000, 4800); // 20 bursts
    const half = renderValvetrain(makeLayer(0, 0.5, 5), 6000, 4800);
    expect(peakAbs(full)).toBeGreaterThan(0.1);
    for (let i = 0; i < 4800; i++) expect(half[i] ?? NaN).toBeCloseTo(0.5 * (full[i] ?? NaN), 12);
  });

  it('peaks a typical valvetrain burst at ≈ 0.22 × valvetrainGain (median per-burst peak at 48 kHz)', () => {
    // One window per event period (I4 at 6000 rpm: 200 events/s); each holds one burst, which has decayed
    // by 40 dB within 2 ms. Per-burst peaks are random: median ≈ 0.22, p90 ≈ 0.33, max over ~1000 ≈ 0.5.
    const y = renderValvetrain(makeLayer(0, 1, 2), 6000);
    const period = FS / 200;
    const peaks: number[] = [];
    for (let k = 1; (k + 1) * period <= y.length; k++) peaks.push(peakAbs(y.subarray(k * period, (k + 1) * period)));
    peaks.sort((a, b) => a - b);
    const median = peaks[peaks.length >> 1] ?? NaN;
    expect(median).toBeGreaterThan(0.16);
    expect(median).toBeLessThan(0.3);
  });

  it('is deterministic per seed and reset() replays the sequence (multi-call)', () => {
    const run = (layer: MechanicalLayer): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 3000; i++) out.push(layer.tick(i % 240 === 0 ? 0.8 : 0, 4500));
      return out;
    };
    const layer = makeLayer(0.3, 0.1, 21);
    const a = run(layer);
    expect(run(layer)).not.toEqual(a); // state carries over between calls
    layer.reset();
    expect(run(layer)).toEqual(a);
    expect(run(makeLayer(0.3, 0.1, 21))).toEqual(a);
    expect(run(makeLayer(0.3, 0.1, 22))).not.toEqual(a);
  });
});
