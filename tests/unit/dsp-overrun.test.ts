import { describe, expect, it } from 'vitest';
import { AIRFLOW_RMS, OverrunLayer, POP_AMP_MAX, POP_AMP_MIN, POP_MAX_PENDING } from '../../src/dsp/overrun';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;
const POP_N = Math.round(0.001 * FS); // 48-sample pop window at 48 kHz

/** i4-test with redline 6000 and the given crackle rate. */
function makeLayer(seed: number, crackleRate = 2): OverrunLayer {
  const def = loadFixture('i4-test');
  def.spec.rpm.redline = 6000;
  def.voicing.overrun = { crackleRate, fuelCutResumeRpm: 1300 };
  const layer = new OverrunLayer(FS);
  layer.configure(def.spec, def.voicing, seed);
  return layer;
}

interface Run {
  pops: Float64Array;
  air: Float64Array;
}

function run(layer: OverrunLayer, n: number, regime: number, falling: boolean, valve = 0, mode = 1, rpm = 4000): Run {
  const pops = new Float64Array(n);
  const air = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    layer.tick(regime, rpm, falling, valve, mode, 0);
    pops[i] = layer.popInject;
    air[i] = layer.airflow;
  }
  return { pops, air };
}

/** Pop onsets: a non-zero sample preceded by a zero sample (pops are separated by ≥ 1 zero). */
function onsets(x: Float64Array, from = 0, to = x.length): number {
  let c = 0;
  for (let i = from; i < to; i++) if ((x[i] ?? 0) !== 0 && (i === 0 || (x[i - 1] ?? 0) === 0)) c++;
  return c;
}

function meanPops(seeds: number, n: number, valve: number, mode: number, regime = 1): number {
  let total = 0;
  for (let s = 1; s <= seeds; s++) total += onsets(run(makeLayer(s), n, regime, true, valve, mode).pops);
  return total / seeds;
}

function rms(x: Float64Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, x.length - from));
}

describe('OverrunLayer — pops', () => {
  it('never pops while regime is 0 or rpm is not falling (no ignition-cut pops)', () => {
    expect(run(makeLayer(1, 5), 2 * FS, 0, true).pops.every((v) => v === 0)).toBe(true);
    expect(run(makeLayer(1, 5), 2 * FS, 1, false).pops.every((v) => v === 0)).toBe(true);
    expect(run(makeLayer(1, 5), 2 * FS, 1, true, 1, 0).pops.every((v) => v === 0)).toBe(true); // modeFactor 0
  });

  it('shapes every pop as a 1 ms raised cosine with peak amplitude in [0.3, 1.0]', () => {
    const { pops } = run(makeLayer(2, 5), 4 * FS, 1, true, 1, 1);
    let checked = 0;
    for (let i = 1; i < pops.length - POP_N; i++) {
      if ((pops[i] ?? 0) === 0 || (pops[i - 1] ?? 0) !== 0) continue;
      const w = pops.subarray(i, i + POP_N);
      expect(w.every((v) => v > 0 && v <= 1)).toBe(true);
      expect(pops[i + POP_N]).toBe(0);
      for (let k = 0; k < POP_N / 2; k++) expect(w[k] ?? NaN).toBeCloseTo(w[POP_N - 1 - k] ?? NaN, 12);
      const peak = Math.max(...w);
      expect(peak).toBeGreaterThan(POP_AMP_MIN * 0.99);
      expect(peak).toBeLessThanOrEqual(POP_AMP_MAX);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  // 31M ticks (≈ 3–3.5 s under Vitest's module transform here): headroom over the 5 s default for slower CI hosts.
  it('follows λ = crackleRate·4·(1 + 1.5·valve)·modeFactor·regime·e^(−t/1.5) (mean over seeds)', { timeout: 20_000 }, () => {
    const expected = 2 * 4 * 1.5 * (1 - Math.exp(-4 / 1.5)); // ≈ 11.17 pops in 4 s
    const closed = meanPops(40, 4 * FS, 0, 1);
    expect(closed).toBeGreaterThan(0.85 * expected);
    expect(closed).toBeLessThan(1.15 * expected);
    const open = meanPops(40, 4 * FS, 1, 1);
    expect(open / closed).toBeGreaterThan(2.0);
    expect(open / closed).toBeLessThan(3.0);
    const sport = meanPops(40, 4 * FS, 0, 1.5);
    expect(sport / closed).toBeGreaterThan(1.2);
    expect(sport / closed).toBeLessThan(1.8);
    const halfRegime = meanPops(40, 4 * FS, 0, 1, 0.5); // still an overrun episode (0.5 > OVERRUN_ENTER)
    expect(halfRegime / closed).toBeGreaterThan(0.35);
    expect(halfRegime / closed).toBeLessThan(0.65);
  });

  it('decays the rate with τ = 1.5 s since the overrun started', () => {
    let first = 0;
    let second = 0;
    for (let s = 1; s <= 60; s++) {
      const { pops } = run(makeLayer(s), 3 * FS, 1, true);
      first += onsets(pops, 0, 1.5 * FS);
      second += onsets(pops, 1.5 * FS, 3 * FS);
    }
    expect(first / second).toBeGreaterThan(2.0); // expected e ≈ 2.72
    expect(first / second).toBeLessThan(3.6);
  });

  it('restarts the decay at a new overrun episode (multi-call)', () => {
    let restarted = 0;
    for (let s = 1; s <= 40; s++) {
      const layer = makeLayer(s);
      run(layer, 3 * FS, 1, true); // episode 1: decays to e^(−2)
      run(layer, FS / 10, 0, true); // regime 0 ends the episode
      restarted += onsets(run(layer, FS, 1, true).pops);
    }
    // Restarted: 8·1.5·(1 − e^(−2/3)) ≈ 5.8 per run; continuing the old decay would give ≈ 0.7.
    expect(restarted / 40).toBeGreaterThan(4);
  });

  it('keeps the episode and its decay through a regime dip that stays above OVERRUN_EXIT (multi-call)', () => {
    let pops = 0;
    for (let s = 1; s <= 40; s++) {
      const layer = makeLayer(s);
      run(layer, 3 * FS, 1, true); // decays to e^(−2)
      run(layer, FS / 10, 0.05, true); // between OVERRUN_EXIT 0.02 and OVERRUN_ENTER 0.1: same episode
      pops += onsets(run(layer, FS, 1, true).pops);
    }
    // Continuing: 8·1.5·e^(−3.1/1.5)·(1 − e^(−2/3)) ≈ 0.74 per run; a restarted decay would give ≈ 5.8.
    expect(pops / 40).toBeLessThan(2);
  });

  it('starts an episode only above OVERRUN_ENTER: regime 0.05 from rest never pops, 0.15 then does (multi-call)', () => {
    let inBand = 0;
    let above = 0;
    for (let s = 1; s <= 10; s++) {
      const layer = makeLayer(s, 5);
      inBand += onsets(run(layer, 2 * FS, 0.05, true, 1, 1.5).pops); // between OVERRUN_EXIT and OVERRUN_ENTER
      above += onsets(run(layer, FS, 0.15, true, 1, 1.5).pops);
    }
    // An episode entered at 0.05 would pop ≈ 5·4·2.5·1.5·0.05 · 1.5·(1 − e^(−2/1.5)) ≈ 4 times per run.
    expect(inBand).toBe(0);
    expect(above).toBeGreaterThan(20); // ≈ 8 per run expected
  });

  it('runs the decay from the overrun start even while rpm is not falling (multi-call)', () => {
    let pops = 0;
    for (let s = 1; s <= 40; s++) {
      const layer = makeLayer(s);
      run(layer, 3 * FS, 1, false); // overrun at steady rpm: no pops, but the decay runs to e^(−2)
      pops += onsets(run(layer, FS, 1, true).pops);
    }
    // 8·1.5·e^(−2)·(1 − e^(−2/3)) ≈ 0.79 per run; a decay paused while not falling would give ≈ 5.8.
    expect(pops / 40).toBeLessThan(2);
  });

  it('plays ignition-cut pops immediately, one window each, separated, capped at 8 queued', () => {
    const layer = makeLayer(3, 0);
    layer.tick(0, 4000, false, 0, 1, 3);
    const out = new Float64Array(FS / 10);
    out[0] = layer.popInject;
    for (let i = 1; i < out.length; i++) {
      layer.tick(0, 4000, false, 0, 1, 0);
      out[i] = layer.popInject;
    }
    expect(out[0]).toBeGreaterThan(0); // immediate
    expect(onsets(out)).toBe(3);
    const many = makeLayer(4, 0);
    many.tick(0, 4000, false, 0, 1, 20);
    const burst = new Float64Array(FS / 5);
    burst[0] = many.popInject;
    for (let i = 1; i < burst.length; i++) {
      many.tick(0, 4000, false, 0, 1, 0);
      burst[i] = many.popInject;
    }
    expect(onsets(burst)).toBe(POP_MAX_PENDING);
  });
});

describe('OverrunLayer — airflow', () => {
  it('is exactly 0 at regime 0', () => {
    expect(run(makeLayer(5), FS, 0, true).air.every((v) => v === 0)).toBe(true);
  });

  it('has RMS ≈ AIRFLOW_RMS · regime · rpm/redline', () => {
    for (const [regime, rpm] of [
      [1, 6000],
      [0.5, 6000],
      [1, 3000],
    ] as const) {
      const r = rms(run(makeLayer(6), 2 * FS, regime, false, 0, 1, rpm).air, FS / 10);
      const expected = AIRFLOW_RMS * regime * (rpm / 6000);
      expect(r).toBeGreaterThan(0.85 * expected);
      expect(r).toBeLessThan(1.15 * expected);
    }
  });

  it('caps rpm/redline at 2: RMS ≈ 2·AIRFLOW_RMS at rpm = 10 × redline', () => {
    const r = rms(run(makeLayer(6), 2 * FS, 1, false, 0, 1, 60000).air, FS / 10);
    expect(r).toBeGreaterThan(0.85 * 2 * AIRFLOW_RMS);
    expect(r).toBeLessThan(1.15 * 2 * AIRFLOW_RMS);
  });

  it('is low-passed at 1.2 kHz', () => {
    const { air } = run(makeLayer(7), 2 * FS, 1, false, 0, 1, 6000);
    let lo = 0;
    let hi = 0;
    // First difference emphasises highs: for a 1.2 kHz LP its RMS is far below the signal RMS.
    for (let i = 1; i < air.length; i++) {
      lo += (air[i] ?? 0) ** 2;
      hi += ((air[i] ?? 0) - (air[i - 1] ?? 0)) ** 2;
    }
    expect(Math.sqrt(hi / lo)).toBeLessThan(0.25); // white noise would give √2
  });
});

describe('OverrunLayer — determinism', () => {
  it('is deterministic per seed and reset() replays the sequence', () => {
    const layer = makeLayer(9, 5);
    const a = run(layer, FS, 1, true, 1, 1);
    layer.reset();
    const b = run(layer, FS, 1, true, 1, 1);
    expect(Array.from(b.pops)).toEqual(Array.from(a.pops));
    expect(Array.from(b.air)).toEqual(Array.from(a.air));
    const c = run(makeLayer(10, 5), FS, 1, true, 1, 1);
    expect(Array.from(c.air)).not.toEqual(Array.from(a.air));
  });
});
