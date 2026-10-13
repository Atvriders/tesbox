import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { F } from '../../src/contracts';
import type { FixMsg } from '../../src/contracts';
import { haversineM } from '../../src/platform/geo';
import { METRES_PER_DEG_LON_AT_EQUATOR, ReplayFeeder } from '../../src/sim/replay';
import type { ReplayTrace } from '../../src/sim/replay';
import {
  DT_S,
  FIXTURE_NAMES,
  fixturePath,
  idx,
  knotsOf,
  loadTrace,
  runTrace,
  settled,
  stepsOf,
  truthAt,
} from '../helpers/replay-harness';

const TINY: ReplayTrace = {
  meta: { name: 'tiny', cadenceS: 1, latencyS: 0.8, source: 'synthetic' },
  fixes: [
    { t: 1, sAlongM: 0, speedMps: 3, accuracyM: 5 },
    { t: 2, sAlongM: 111.31949, speedMps: null, accuracyM: 6 },
    { t: 2, sAlongM: 222.63898, speedMps: 0, accuracyM: 7, ageS: 2.5 },
  ],
};

function blankFix(): FixMsg {
  return { type: 'fix', ageS: -1, speedMps: -1, lat: 9, lon: 9, accuracyM: -1, altitudeM: 123 };
}

describe('ReplayFeeder', () => {
  it('delivers fixes in order once their t ≤ nowS, one per call, as fake equator positions', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    expect(feeder.next(0.999, out)).toBe(false);
    expect(out.ageS).toBe(-1); // untouched when nothing is due

    expect(feeder.next(1, out)).toBe(true);
    expect(out).toEqual({ type: 'fix', ageS: 0.8, speedMps: 3, lat: 0, lon: 0, accuracyM: 5, altitudeM: null });
    expect(feeder.next(1.5, out)).toBe(false);

    expect(feeder.next(2.5, out)).toBe(true);
    expect(out.lon).toBeCloseTo(111.31949 / METRES_PER_DEG_LON_AT_EQUATOR, 15);
    expect(out.speedMps).toBeNull();
    expect(out.ageS).toBe(0.8); // meta.latencyS default
    expect(feeder.next(2.5, out)).toBe(true); // second fix with the same t, same call time
    expect(out.ageS).toBe(2.5); // per-fix override
    expect(out.speedMps).toBe(0);
    expect(out.accuracyM).toBe(7);
    expect(feeder.next(2.5, out)).toBe(false);
    expect(feeder.next(1e9, out)).toBe(false); // exhausted
  });

  it('reset() rewinds to the first fix', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    while (feeder.next(10, out)) {
      /* drain */
    }
    feeder.reset();
    expect(feeder.next(1, out)).toBe(true);
    expect(out.speedMps).toBe(3);
  });

  it('fake positions are 1° = 111319.49 m; haversine (R = 6371008.8 m) reads them 0.112 % short', () => {
    expect(METRES_PER_DEG_LON_AT_EQUATOR).toBe(111319.49);
    const d = haversineM(0, 0, 0, 1000 / METRES_PER_DEG_LON_AT_EQUATOR);
    expect(d / 1000).toBeCloseTo((6371008.8 * Math.PI) / 180 / METRES_PER_DEG_LON_AT_EQUATOR, 9);
    expect(d / 1000).toBeCloseTo(0.998882, 6);
  });
});

describe('synthetic replay fixtures — structure', () => {
  it.each(FIXTURE_NAMES)('%s is a well-formed synthetic trace without coordinates', (name) => {
    const text = readFileSync(fixturePath(name), 'utf8');
    expect(text).not.toMatch(/"(lat|lon|latitude|longitude)"/);
    const trace = loadTrace(name);
    expect(trace.meta).toMatchObject({ name, cadenceS: 1, latencyS: 1, source: 'synthetic' });
    expect(trace.fixes.length).toBeGreaterThan(40);
    let prevT = -Infinity;
    for (const f of trace.fixes) {
      expect(f.t).toBeGreaterThanOrEqual(prevT);
      prevT = f.t;
      expect(f.accuracyM).toBeGreaterThanOrEqual(4);
      expect(f.accuracyM).toBeLessThanOrEqual(8);
      expect(Number.isFinite(f.sAlongM)).toBe(true);
      if (f.speedMps !== null) expect(f.speedMps).toBeGreaterThanOrEqual(0);
    }
    const truth = trace.truth ?? [];
    expect(truth.length).toBeGreaterThan(0);
    for (let i = 1; i < truth.length; i++) expect(truth[i]?.t ?? 0).toBeGreaterThanOrEqual(truth[i - 1]?.t ?? 0);
    expect(truth[truth.length - 1]?.t ?? 0).toBeGreaterThanOrEqual(prevT);
  });

  it('encodes each scenario', () => {
    expect(loadTrace('intel-zero-speed').fixes.every((f) => f.speedMps === 0)).toBe(true);
    expect(loadTrace('intel-null-speed').fixes.every((f) => f.speedMps === null)).toBe(true);
    expect(loadTrace('stoplight-jitter').truth?.every((p) => p.v === 0)).toBe(true);
    const stop = loadTrace('stoplight-jitter').fixes;
    expect(Math.max(...stop.map((f) => Math.abs(f.sAlongM)))).toBeLessThanOrEqual(4);
    expect(Math.max(...stop.map((f) => f.speedMps ?? 0))).toBeLessThanOrEqual(0.4);
    expect(stop.some((f) => f.speedMps === 0)).toBe(true);

    const tunnel = loadTrace('tunnel-dropout').fixes;
    const gaps = tunnel.slice(1).map((f, i) => f.t - (tunnel[i]?.t ?? 0));
    expect(Math.max(...gaps)).toBe(35);

    const stale = loadTrace('stale-duplicates').fixes;
    expect(Math.max(...stale.map((f) => f.ageS ?? 0))).toBe(10);
    expect(stale.every((f) => f.ageS !== undefined)).toBe(true);

    expect(stepsOf(loadTrace('step-response'))).toHaveLength(20);
  });
});

describe('SpeedFilter on synthetic replay fixtures', () => {
  /** Max |v − truth| while moving and count of non-standstill quanta at stops, over settled windows. */
  function settledErrors(name: string, windowS = 6): { moveErr: number; stopBad: number; samples: number } {
    const trace = loadTrace(name);
    const run = runTrace(trace);
    const knots = knotsOf(trace);
    let moveErr = 0;
    let stopBad = 0;
    let samples = 0;
    for (let i = 0; i < run.v.length; i++) {
      const t = i * DT_S;
      const flags = run.flags[i] ?? 0;
      if (flags & F.PREDICTING || !settled(knots, t, windowS)) continue;
      samples++;
      const vTrue = truthAt(knots, t);
      const v = run.v[i] ?? Number.NaN;
      if (vTrue > 0) moveErr = Math.max(moveErr, Math.abs(v - vTrue));
      else if (!(flags & F.STANDSTILL) || v !== 0) stopBad++;
    }
    return { moveErr, stopBad, samples };
  }

  function everLatched(name: string): boolean {
    return runTrace(loadTrace(name)).flags.some((fl) => (fl & F.SPEED_UNUSABLE) !== 0);
  }

  it('city-amd: tracks within 1.0 m/s when settled, stands still at stops, never latches SPEED_UNUSABLE', () => {
    const e = settledErrors('city-amd');
    expect(e.samples).toBeGreaterThan(5000);
    expect(e.moveErr).toBeLessThanOrEqual(1.0);
    expect(e.stopBad).toBe(0);
    expect(everLatched('city-amd')).toBe(false);
  });

  it('highway-amd: tracks within 1.0 m/s when settled and never exceeds 130 km/h by more than 2.5 m/s', () => {
    const e = settledErrors('highway-amd');
    expect(e.moveErr).toBeLessThanOrEqual(1.0);
    const run = runTrace(loadTrace('highway-amd'));
    expect(run.v.reduce((m, x) => Math.max(m, x), 0)).toBeLessThanOrEqual(36.11 + 2.5);
  });

  it('RF2 intel-zero-speed: SPEED_UNUSABLE latches once moving and v tracks the truth via position', () => {
    const run = runTrace(loadTrace('intel-zero-speed'));
    const first = run.flags.findIndex((fl) => (fl & F.SPEED_UNUSABLE) !== 0);
    expect(first).toBeGreaterThan(0);
    const latchS = first * DT_S;
    // Car pulls away at 5 s (2.5 m/s²): fix-to-fix steps reach 8 m at the fix measured at 9 s, so
    // three consecutive moving zeros (d1, d0 ≥ 8 m, contract A2) end with the fix measured at 12 s,
    // which arrives at 13.0 s → latch.
    expect(latchS).toBeGreaterThanOrEqual(12);
    expect(latchS).toBeLessThanOrEqual(13.5);
    expect(run.flags.slice(first).every((fl) => (fl & F.SPEED_UNUSABLE) !== 0)).toBe(true); // session-long
    const e = settledErrors('intel-zero-speed');
    expect(e.moveErr).toBeLessThanOrEqual(1.5);
    expect(e.stopBad).toBe(0);
  });

  it('intel-null-speed: null speed never latches; position path tracks within 1.5 m/s when settled', () => {
    expect(everLatched('intel-null-speed')).toBe(false);
    const e = settledErrors('intel-null-speed');
    expect(e.moveErr).toBeLessThanOrEqual(1.5);
    expect(e.stopBad).toBe(0);
  });

  it('RF3 tunnel-dropout: predicting after 2 s, no snap, GPS_LOST after 20 s, 0 by 30 s, recovers', () => {
    const run = runTrace(loadTrace('tunnel-dropout'));
    const at = (t: number): { v: number; flags: number } => ({ v: run.v[idx(t)] ?? NaN, flags: run.flags[idx(t)] ?? 0 });
    // Last fix before the tunnel arrives at 20.0 s; the next at 55.0 s.
    expect(at(21.9).flags & (F.PREDICTING | F.GPS_LOST)).toBe(0);
    expect(at(22.1).flags & F.PREDICTING).toBe(F.PREDICTING);
    expect(at(22.1).v).toBeCloseTo(25, 0);
    expect(at(39.9).flags & F.GPS_LOST).toBe(0);
    const held = at(39.9).v;
    expect(Math.abs(held - 25)).toBeLessThanOrEqual(1);
    expect(at(40.1).flags & F.GPS_LOST).toBe(F.GPS_LOST);
    expect(Math.abs(at(40.01).v - at(39.99).v)).toBeLessThan(0.05); // no snap at the 20 s boundary
    expect(at(45).v).toBeCloseTo(held * 0.5, 1);
    for (let t = 50; t < 55; t += 0.25) {
      expect(at(t).v).toBe(0);
      expect(at(t).flags & (F.GPS_LOST | F.STANDSTILL)).toBe(F.GPS_LOST | F.STANDSTILL);
    }
    for (let i = idx(40); i < idx(50); i++) expect(run.v[i + 1] ?? 0).toBeLessThanOrEqual((run.v[i] ?? 0) + 1e-9); // ease is monotonic
    expect(at(55).flags & (F.GPS_LOST | F.PREDICTING | F.STANDSTILL)).toBe(0);
    expect(Math.abs(at(55).v - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(at(58).v - 25)).toBeLessThanOrEqual(1);
  });

  it('stoplight-jitter: ±4 m wander (Gauss–Markov + white σ = 1 m, A9) and 0–0.4 m/s readings never leave standstill', () => {
    const trace = loadTrace('stoplight-jitter');
    const run = runTrace(trace);
    expect(run.accepted).toBe(91);
    expect(run.rejected).toBe(0);
    for (let i = idx(1); i < run.v.length; i++) {
      expect(run.v[i]).toBe(0);
      expect((run.flags[i] ?? 0) & (F.STANDSTILL | F.SPEED_UNUSABLE)).toBe(F.STANDSTILL);
    }
    // Position-only at the same stop (speeds nulled): the A3 deadband keeps the filter in standstill
    // most of the time although some noise steps exceed 0.4·accuracy (measured 77.7 % of quanta;
    // 34.0 % without the deadband).
    const posOnly = runTrace({ ...trace, fixes: trace.fixes.map((f) => ({ ...f, speedMps: null })) });
    let still = 0;
    for (const fl of posOnly.flags) if (fl & F.STANDSTILL) still++;
    expect(still / posOnly.flags.length).toBeGreaterThan(0.7);
  });

  it('stale-duplicates: rejects 21 repeats/stale/out-of-order fixes, holds v through the freeze, recovers', () => {
    const run = runTrace(loadTrace('stale-duplicates'));
    expect(run.accepted).toBe(52);
    expect(run.rejected).toBe(21); // 9 freeze repeats + 8 cached repeats + 4 stragglers
    // Freeze: last accepted arrival 21.0 s; repeats of that fix (ages 2–10 s) arrive 22–30 s.
    expect((run.flags[idx(22.9)] ?? 0) & F.PREDICTING).toBe(0);
    expect((run.flags[idx(23.1)] ?? 0) & F.PREDICTING).toBe(F.PREDICTING);
    expect((run.flags[idx(30.9)] ?? 0) & F.PREDICTING).toBe(F.PREDICTING);
    for (let t = 21; t <= 30.9; t += 0.1) {
      const v = run.v[idx(t)] ?? 0;
      expect(v).toBeGreaterThan(13);
      expect(v).toBeLessThan(15);
    }
    expect((run.flags[idx(31)] ?? 0) & F.PREDICTING).toBe(0);
    const knots = knotsOf(loadTrace('stale-duplicates'));
    expect(Math.abs((run.v[idx(31)] ?? 0) - truthAt(knots, 31))).toBeLessThanOrEqual(1.5);
    expect((run.flags[idx(37)] ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(settledErrors('stale-duplicates').moveErr).toBeLessThanOrEqual(1.0);
  });
});

/** Recorded fixtures: tools/gpx-to-replay.ts output (`meta.source: 'gpx'`) committed next to the synthetic ones. */
const RECORDED = readdirSync(new URL('../fixtures/replay/', import.meta.url))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .filter((name) => loadTrace(name).meta.source === 'gpx');

describe('recorded (gpx) replay fixtures — spec §15 exit gate', () => {
  if (RECORDED.length === 0) {
    it.skip('no recorded fixture committed yet (record a phone GPX, convert with tools/gpx-to-replay.ts, commit only the JSON)', () => {});
  } else {
    it.each(RECORDED)("%s: position-free; the filter output stays finite and its peak matches the trace's own speeds", (name) => {
      const text = readFileSync(fixturePath(name), 'utf8');
      expect(text).not.toMatch(/"(lat|lon|latitude|longitude|time)"/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no absolute timestamps
      const trace = loadTrace(name);
      expect(trace.fixes.length).toBeGreaterThan(1);
      for (let i = 1; i < trace.fixes.length; i++) expect(trace.fixes[i]?.t ?? 0).toBeGreaterThanOrEqual(trace.fixes[i - 1]?.t ?? 0);
      const run = runTrace(trace);
      expect(run.accepted).toBeGreaterThan(0);
      for (const v of run.v) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(70);
      }
      // Plausibility against the trace's own positions (catches a filter stuck at 0 or running away):
      // vRef = the highest mean speed over 5 fix intervals (5 s at 1 Hz; measurement time t − ageS).
      // Bounds calibrated on the synthetic fixtures with speeds present and nulled: peak / vRef is
      // 0.93–1.49 (prediction overshoot after accelerations and speed steps). Skipped only for a trace
      // with fewer than 6 fixes or one that never moves (vRef < 3 m/s: GNSS jitter at a stop).
      const fixes = trace.fixes;
      const tMeas = (i: number): number => (fixes[i]?.t ?? 0) - (fixes[i]?.ageS ?? trace.meta.latencyS);
      let vRef = 0;
      for (let i = 0; i + 5 < fixes.length; i++) {
        const dt = tMeas(i + 5) - tMeas(i);
        if (dt > 0) vRef = Math.max(vRef, ((fixes[i + 5]?.sAlongM ?? 0) - (fixes[i]?.sAlongM ?? 0)) / dt);
      }
      if (fixes.length >= 6 && vRef >= 3) {
        const vMax = run.v.reduce((m, x) => Math.max(m, x), 0);
        expect(vMax, `filter peak vs 5-interval reference ${vRef.toFixed(2)} m/s`).toBeGreaterThanOrEqual(0.8 * vRef - 1);
        expect(vMax, `filter peak vs 5-interval reference ${vRef.toFixed(2)} m/s`).toBeLessThanOrEqual(1.5 * vRef + 4);
      }
    });
  }
});
