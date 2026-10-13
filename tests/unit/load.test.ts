import { describe, expect, it } from 'vitest';
import { G, QUANTUM } from '../../src/contracts';
import type { TeslaParams } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';
import { LoadEstimator, maxForceN, rawLoad, roadForceN } from '../../src/sim/load';

/** Illustrative params (not a catalogue record): 2000 kg, 12 kN traction, 300 kW, η 0.9. */
const P: TeslaParams = {
  massKg: 2000,
  roadLoad: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  fTracN: 12000,
  pEffW: 300000,
  eta: 0.9,
  modeFactor: 1,
};
const DT = QUANTUM / 48000;
const KMH100 = 100 / 3.6;

/** Acceleration that produces exactly `load` (≥ 0) at speed v. */
function accelFor(p: TeslaParams, v: number, load: number): number {
  return (load * maxForceN(p, v) - roadForceN(p, v)) / p.massKg;
}

describe('roadForceN', () => {
  it('is A + B·v + C·v²', () => {
    expect(roadForceN(P, 0)).toBe(130);
    // 130 + 27.7778 + 0.4·771.605 = 466.42 N
    expect(roadForceN(P, KMH100)).toBeCloseTo(130 + KMH100 + 0.4 * KMH100 * KMH100, 9);
    expect(roadForceN(P, KMH100)).toBeCloseTo(466.42, 2);
  });

  it('allows a negative B coefficient', () => {
    const p = { ...P, roadLoad: { A_N: 150, B_Nps_m: -2, C_Ns2_m2: 0.45 } };
    expect(roadForceN(p, 10)).toBeCloseTo(150 - 20 + 45, 12);
  });

  it('matches a hand-computed EPA Target row at 100 km/h (illustrative coefficients)', () => {
    // A 30 lbf, B 0.2 lbf/mph, C 0.015 lbf/mph² → at 62.1371 mph: 100.3426 lbf = 446.35 N
    const p = { ...P, roadLoad: epaToSi({ A_lbf: 30, B_lbf_per_mph: 0.2, C_lbf_per_mph2: 0.015 }) };
    expect(roadForceN(p, KMH100)).toBeCloseTo(446.35, 1);
  });
});

describe('maxForceN', () => {
  it('is traction-limited below the crossover and power-limited above it', () => {
    const crossover = (P.eta * P.pEffW) / P.fTracN; // 22.5 m/s
    expect(maxForceN(P, 5)).toBe(12000);
    expect(maxForceN(P, crossover)).toBeCloseTo(12000, 9);
    expect(maxForceN(P, 40)).toBeCloseTo((0.9 * 300000) / 40, 9);
  });

  it('uses max(v, 1) so standstill is finite', () => {
    const weak = { ...P, fTracN: 1e7 };
    expect(maxForceN(weak, 0)).toBeCloseTo(0.9 * 300000, 6);
    expect(maxForceN(weak, 0.5)).toBe(maxForceN(weak, 0));
  });

  it('scales by modeFactor', () => {
    expect(maxForceN({ ...P, modeFactor: 0.5 }, 30)).toBeCloseTo(0.5 * maxForceN(P, 30), 9);
  });
});

describe('rawLoad', () => {
  it('is 1 at full available force, proportional below, clamped above', () => {
    expect(rawLoad(P, 20, accelFor(P, 20, 1))).toBeCloseTo(1, 12);
    expect(rawLoad(P, 20, accelFor(P, 20, 0.5))).toBeCloseTo(0.5, 12);
    expect(rawLoad(P, 20, 50)).toBe(1);
  });

  it('matches closed-form physics for steady acceleration and cruise', () => {
    // a = 1.5 m/s² at 15 m/s: (2000·1.5 + 130 + 15 + 90) / min(12000, 18000) = 0.269583…
    expect(rawLoad(P, 15, 1.5)).toBeCloseTo(3235 / 12000, 12);
    // cruise at 30 m/s: (130 + 30 + 360) / min(12000, 9000) = 0.057777…
    expect(rawLoad(P, 30, 0)).toBeCloseTo(520 / 9000, 12);
  });

  it('maps deceleration to negative load against 0.25 g, floored at −1', () => {
    // a = −1 at 20 m/s: (−2000 + 310) / (2000·0.25·G) = −0.344669…
    expect(rawLoad(P, 20, -1)).toBeCloseTo(-1690 / (2000 * 0.25 * G), 12);
    expect(rawLoad(P, 20, -8)).toBe(-1);
  });

  it('returns NaN for non-finite speed (the estimator guards it)', () => {
    expect(rawLoad(P, Number.NaN, 0)).toBeNaN();
  });

  it('returns NaN for infinite speed or acceleration too, not a clamped ±1', () => {
    expect(rawLoad(P, Number.POSITIVE_INFINITY, 0)).toBeNaN();
    expect(rawLoad(P, Number.NEGATIVE_INFINITY, 0)).toBeNaN();
    expect(rawLoad(P, 20, Number.POSITIVE_INFINITY)).toBeNaN();
    expect(rawLoad(P, 20, Number.NEGATIVE_INFINITY)).toBeNaN();
    expect(rawLoad(P, 20, Number.NaN)).toBeNaN();
  });
});

describe('LoadEstimator', () => {
  function make(): LoadEstimator {
    const e = new LoadEstimator();
    e.configure(P);
    return e;
  }

  it('returns 0 and stays inert before configure()', () => {
    const e = new LoadEstimator();
    expect(e.update(20, 3, DT)).toBe(0);
    expect(e.update(20, 3, DT)).toBe(0);
    expect(e.load).toBe(0);
    expect(e.loadRate).toBe(0);
  });

  it('one-pole τ = 0.2 s: 63.2 % after 0.2 s, settles to the raw load', () => {
    const e = make();
    const raw = rawLoad(P, 15, 1.5);
    for (let i = 0; i < 75; i++) e.update(15, 1.5, DT); // 75 × 128/48000 = 0.2 s
    expect(e.load).toBeCloseTo(raw * (1 - Math.exp(-1)), 9);
    for (let i = 0; i < 750; i++) e.update(15, 1.5, DT);
    expect(e.load).toBeCloseTo(raw, 4); // 2.2 s = 11 τ → residual e^(−11)·raw ≈ 5e−6
    expect(Math.abs(e.loadRate)).toBeLessThan(1e-4);
  });

  it('applies the ±0.03 deadband to the output only', () => {
    const e = make();
    // cruise at 10 m/s: raw = 180 / 12000 = 0.015 → inside the deadband forever
    for (let i = 0; i < 1000; i++) expect(e.update(10, 0, DT)).toBe(0);
    // gentle decel: raw ≈ −0.0183 → still 0
    for (let i = 0; i < 1000; i++) expect(e.update(10, -0.135, DT)).toBe(0);
  });

  it('passes the filtered value once |y| ≥ 0.03', () => {
    const e = make();
    const out: number[] = [];
    for (let i = 0; i < 40; i++) out.push(e.update(20, accelFor(P, 20, 0.5), DT));
    const firstNonZero = out.findIndex((x) => x !== 0);
    expect(firstNonZero).toBeGreaterThan(0);
    expect(out[firstNonZero]).toBeGreaterThanOrEqual(0.03);
    expect(out[firstNonZero - 1]).toBe(0);
  });

  it('loadRate is the derivative of the pre-deadband filtered value', () => {
    const e = make();
    const a = accelFor(P, 20, 0.8);
    const raw = rawLoad(P, 20, a);
    let y = 0;
    const alpha = 1 - Math.exp(-DT / 0.2);
    for (let i = 0; i < 20; i++) {
      e.update(20, a, DT);
      const next = y + (raw - y) * alpha;
      expect(e.loadRate).toBeCloseTo((next - y) / DT, 9); // non-zero even while the output is in the deadband
      y = next;
    }
    // Lift-off: rate turns negative.
    e.update(20, -1, DT);
    expect(e.loadRate).toBeLessThan(0);
  });

  it('loadRate ≤ (1 − previous load)/τ — at most ≈ 0.5 /s once load > 0.9 (one-pole bound)', () => {
    const e = make();
    const a = accelFor(P, 10, 1); // raw load exactly 1
    let prev = 0;
    let maxRateAbove09 = 0;
    for (let i = 0; i < 1000; i++) {
      e.update(10, a, DT);
      expect(e.loadRate).toBeLessThanOrEqual((1 - prev) / 0.2 + 1e-9);
      if (e.load > 0.9) maxRateAbove09 = Math.max(maxRateAbove09, e.loadRate);
      prev = e.load;
    }
    expect(e.load).toBeCloseTo(1, 4);
    expect(maxRateAbove09).toBeGreaterThan(0.45);
    expect(maxRateAbove09).toBeLessThanOrEqual(0.51); // (1 − 0.9)/0.2 + one quantum of slack
  });

  it('reaches the A4 kickdown trigger: on a step to raw load 1, loadRate > 1.2 /s when load first exceeds 0.6', () => {
    const e = make();
    const a = accelFor(P, 10, 1); // raw load exactly 1, from rest
    let crossed = false;
    for (let i = 0; i < 1000 && !crossed; i++) {
      e.update(10, a, DT);
      if (e.load > 0.6) {
        crossed = true;
        expect(e.loadRate).toBeGreaterThan(1.2);
        expect(e.loadRate).toBeCloseTo(2, 1); // ≈ (1 − 0.6)/0.2 (measured 2.006 /s)
      }
    }
    expect(crossed).toBe(true);
  });

  it('treats a NaN raw load as 0 and never outputs NaN', () => {
    const e = make();
    for (let i = 0; i < 200; i++) e.update(20, accelFor(P, 20, 0.6), DT);
    const before = e.load;
    e.update(Number.NaN, Number.NaN, DT);
    expect(Number.isFinite(e.load)).toBe(true);
    expect(e.load).toBeLessThan(before);
    expect(Number.isFinite(e.loadRate)).toBe(true);
  });

  it('treats infinite speed or acceleration like NaN: the load decays to 0, never toward ±1', () => {
    const e = make();
    for (let i = 0; i < 200; i++) e.update(20, accelFor(P, 20, 0.6), DT);
    let prev = e.load;
    expect(prev).toBeGreaterThan(0.5);
    const step = (v: number, a: number): void => {
      e.update(v, a, DT);
      expect(e.load).toBeLessThanOrEqual(prev);
      expect(e.load).toBeGreaterThanOrEqual(0);
      prev = e.load;
    };
    for (let i = 0; i < 100; i++) {
      step(Number.POSITIVE_INFINITY, 0);
      step(Number.NEGATIVE_INFINITY, 0);
      step(20, Number.POSITIVE_INFINITY);
      step(20, Number.NEGATIVE_INFINITY);
    }
    expect(e.load).toBe(0); // 400 quanta ≈ 5.3 τ: 0.558·e^(−5.33) ≈ 0.003, inside the deadband
  });

  it('ignores dtS ≤ 0', () => {
    const e = make();
    for (let i = 0; i < 100; i++) e.update(20, 2, DT);
    const load = e.load;
    const rate = e.loadRate;
    expect(e.update(20, -5, 0)).toBe(load);
    expect(e.update(20, -5, -DT)).toBe(load);
    expect(e.loadRate).toBe(rate);
  });

  it('reset() zeroes the state; configure() alone keeps it', () => {
    const e = make();
    for (let i = 0; i < 300; i++) e.update(20, 2, DT);
    const held = e.load;
    expect(held).toBeGreaterThan(0.3);
    e.configure({ ...P, modeFactor: 0.5 });
    expect(e.load).toBe(held);
    e.reset();
    expect(e.load).toBe(0);
    expect(e.loadRate).toBe(0);
    e.update(10, 0, DT);
    expect(e.load).toBe(0);
  });
});
