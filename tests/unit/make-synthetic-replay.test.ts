import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAllTraces,
  distanceAt,
  gaussian,
  knotsFrom,
  mulberry32,
  serialiseTrace,
  speedAt,
  stepResponseKnots,
} from '../../tools/make-synthetic-replay';
import { FIXTURE_NAMES, fixturePath } from '../helpers/replay-harness';

describe('PRNG', () => {
  it('mulberry32 is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(seqA);
    expect(c()).not.toBe(seqA[0]);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('gaussian has mean ≈ 0 and sd ≈ 1', () => {
    const r = mulberry32(7);
    let s = 0;
    let s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = gaussian(r);
      s += g;
      s2 += g * g;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(s2 / n - (s / n) ** 2) - 1)).toBeLessThan(0.03);
  });
});

describe('truth profiles', () => {
  const ramp = knotsFrom(0, [[10, 10], [5, 10], [0, 4]]); // 0→10 over 10 s, hold 5 s, step to 4

  it('knotsFrom accumulates segment durations', () => {
    expect(ramp).toEqual([[0, 0], [10, 10], [15, 10], [15, 4]]);
  });

  it('speedAt interpolates, is right-continuous at steps, and holds after the last knot', () => {
    expect(speedAt(ramp, 5)).toBe(5);
    expect(speedAt(ramp, 12)).toBe(10);
    expect(speedAt(ramp, 14.999)).toBe(10);
    expect(speedAt(ramp, 15)).toBe(4);
    expect(speedAt(ramp, 100)).toBe(4);
  });

  it('distanceAt integrates exactly (trapezoids, zero-width steps, linear extension)', () => {
    expect(distanceAt(ramp, 0)).toBe(0);
    expect(distanceAt(ramp, 4)).toBeCloseTo(8, 12); // ∫0^4 t dt
    expect(distanceAt(ramp, 10)).toBeCloseTo(50, 12);
    expect(distanceAt(ramp, 15)).toBeCloseTo(100, 12);
    expect(distanceAt(ramp, 20)).toBeCloseTo(120, 12);
  });

  it('stepResponseKnots: 20 steps 0→20→20→10…, phases sweep the fix grid, never back to 0', () => {
    const { knots, durationS } = stepResponseKnots(20);
    const steps = knots.filter((k, i) => i > 0 && k[0] === knots[i - 1]?.[0]);
    expect(steps).toHaveLength(20);
    expect(steps[0]).toEqual([15.05, 20]);
    expect(new Set(steps.map((k) => Math.round((k[0] % 1) * 100))).size).toBe(10);
    expect(knots.slice(2).every((k) => k[1] === 10 || k[1] === 20)).toBe(true); // after the first step
    expect(durationS).toBeGreaterThan(steps[steps.length - 1]?.[0] ?? 0);
  });
});

describe('fixtures', () => {
  it('builds the eight traces in the documented order, deterministically', () => {
    const a = buildAllTraces();
    expect(a.map((t) => t.meta.name)).toEqual([...FIXTURE_NAMES]);
    expect(JSON.stringify(buildAllTraces())).toBe(JSON.stringify(a));
  });

  it('serialiseTrace round-trips through JSON.parse', () => {
    for (const trace of buildAllTraces()) expect(JSON.parse(serialiseTrace(trace))).toEqual(trace);
  });

  it.each(FIXTURE_NAMES)('committed %s.json is exactly what the generator writes', (name) => {
    const trace = buildAllTraces().find((t) => t.meta.name === name);
    expect(trace).toBeDefined();
    if (trace === undefined) return;
    expect(readFileSync(fixturePath(name), 'utf8')).toBe(serialiseTrace(trace));
  });

  /** Lag-1 autocorrelation of the position error (sAlongM − true distance at the measurement time). */
  function lag1(name: string): number {
    const tr = buildAllTraces().find((t) => t.meta.name === name);
    const knots = (tr?.truth ?? []).map((p) => [p.t, p.v] as const);
    const s = (tr?.fixes ?? []).map((f) => f.sAlongM - distanceAt(knots, f.t - (tr?.meta.latencyS ?? 0)));
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < s.length; i++) {
      const d = (s[i] ?? 0) - mean;
      den += d * d;
      if (i > 0) num += d * ((s[i - 1] ?? 0) - mean);
    }
    return num / den;
  }

  it('position noise is time-correlated (Gauss–Markov), not white', () => {
    expect(lag1('intel-null-speed')).toBeGreaterThan(0.8);
    expect(lag1('city-amd')).toBeGreaterThan(0.8);
  });

  it('stoplight-jitter adds the white σ = 1 m component (contract A9): visibly less correlated', () => {
    expect(lag1('stoplight-jitter')).toBeLessThan(0.8);
    expect(lag1('stoplight-jitter')).toBeLessThan(lag1('intel-null-speed') - 0.1);
  });
});
