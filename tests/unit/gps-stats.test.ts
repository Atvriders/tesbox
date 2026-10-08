import { describe, it, expect } from 'vitest';
import { GpsStats, type GpsFix } from '../../src/probe/gps-stats';

const M_PER_DEG = (6371008.8 * Math.PI) / 180;
/** Latitude (degrees) of a point `m` metres north of 0,0. Fake positions only. */
const north = (m: number): number => m / M_PER_DEG;

function fix(over: Partial<GpsFix> = {}): GpsFix {
  return {
    arrivalPerfMs: 0,
    arrivalEpochMs: 1_000_000,
    timestampMs: 999_000,
    lat: 0,
    lon: 0,
    accuracyM: 5,
    speedMps: 10,
    altitudeM: null,
    hidden: false,
    ...over,
  };
}

describe('GpsStats', () => {
  it('summarises an empty run with zeros and nulls', () => {
    const s = new GpsStats('poll-hiacc-off').summary(60, false);
    expect(s).toEqual({
      mode: 'poll-hiacc-off',
      durationS: 60,
      fixes: 0,
      errors: { permission: 0, unavailable: 0, timeout: 0 },
      intervalMedianMs: null,
      intervalP95Ms: null,
      ageMedianMs: null,
      ageP95Ms: null,
      staleOver3sPct: 0,
      duplicatePct: 0,
      speedNullPct: 0,
      speedZeroPct: 0,
      speedZeroWhileMovingPct: 0,
      accuracyMedianM: null,
      altitudePresentPct: 0,
      fixesWhileHidden: 0,
      maxSpeedMps: null,
      crashedPreviously: false,
    });
  });

  it('computes interval and age percentiles by nearest rank', () => {
    const st = new GpsStats('m');
    // arrivals 0, 1000, 2100, 3000 → intervals [1000, 1100, 900]
    // ages 1000, 2000, 3000, 4000 (arrivalEpoch − timestamp)
    const arrivals = [0, 1000, 2100, 3000];
    arrivals.forEach((a, i) =>
      st.add(fix({ arrivalPerfMs: a, arrivalEpochMs: 10_000 + a, timestampMs: 10_000 + a - (i + 1) * 1000, lat: north(i) })),
    );
    const s = st.summary(4, false);
    expect(s.fixes).toBe(4);
    expect(s.intervalMedianMs).toBe(1000); // sorted [900,1000,1100], rank ceil(1.5)=2
    expect(s.intervalP95Ms).toBe(1100); // rank ceil(2.85)=3
    expect(s.ageMedianMs).toBe(2000); // sorted [1000..4000], rank 2
    expect(s.ageP95Ms).toBe(4000); // rank ceil(3.8)=4
    expect(s.staleOver3sPct).toBe(25); // only 4000 > 3000 (3000 is not stale)
  });

  it('uses nearest-rank p95 = 19th of 20 values', () => {
    const st = new GpsStats('m');
    for (let i = 0; i < 20; i++) {
      st.add(fix({ arrivalPerfMs: i * 1000, accuracyM: i + 1, lat: north(i * 10), timestampMs: i }));
    }
    const s = st.summary(20, false);
    expect(s.accuracyMedianM).toBe(10); // rank 10 of 1..20
    expect(s.intervalMedianMs).toBe(1000);
    // ages = 1_000_000 − i → sorted 999_981 … 1_000_000: nearest-rank p95 is the 19th value, not the max
    expect(s.ageMedianMs).toBe(999_990);
    expect(s.ageP95Ms).toBe(999_999);
  });

  it('takes the p95 rank as ceil(0.95·n): the 11th of 11 intervals, not the 10th', () => {
    const st = new GpsStats('m');
    let arrival = 0;
    for (let i = 0; i < 12; i++) {
      st.add(fix({ arrivalPerfMs: arrival, timestampMs: i }));
      arrival += 1001 + i; // intervals 1001, 1002, …, 1011
    }
    // ceil(10.45) = 11 → 1011; rounding the rank instead would pick the 10th (1010).
    expect(st.summary(12, false).intervalP95Ms).toBe(1011);
  });

  it('counts duplicates only against the immediately previous fix', () => {
    const st = new GpsStats('m');
    st.add(fix({ arrivalPerfMs: 0, timestampMs: 1, lat: north(0) }));
    st.add(fix({ arrivalPerfMs: 1000, timestampMs: 1, lat: north(0) })); // duplicate of previous
    st.add(fix({ arrivalPerfMs: 2000, timestampMs: 2, lat: north(5) }));
    st.add(fix({ arrivalPerfMs: 3000, timestampMs: 1, lat: north(0) })); // equals #1, not the previous
    st.add(fix({ arrivalPerfMs: 4000, timestampMs: 2, lat: north(6) })); // same timestamp, moved
    expect(st.summary(5, false).duplicatePct).toBe(20);
  });

  it('reports speed null/zero percentages, max speed and altitude presence', () => {
    const st = new GpsStats('m');
    st.add(fix({ arrivalPerfMs: 0, speedMps: null, altitudeM: 12 }));
    st.add(fix({ arrivalPerfMs: 1000, speedMps: 0, timestampMs: 1 }));
    st.add(fix({ arrivalPerfMs: 2000, speedMps: Number.NaN, timestampMs: 2 })); // non-finite → null
    st.add(fix({ arrivalPerfMs: 3000, speedMps: 13.456, altitudeM: 0, timestampMs: 3 }));
    const s = st.summary(4, false);
    expect(s.speedNullPct).toBe(50);
    expect(s.speedZeroPct).toBe(25);
    expect(s.maxSpeedMps).toBe(13.46);
    expect(s.altitudePresentPct).toBe(50); // 12 and 0 are both present
  });

  it('rounds percentages to one decimal', () => {
    const st = new GpsStats('m');
    st.add(fix({ arrivalPerfMs: 0, speedMps: null }));
    st.add(fix({ arrivalPerfMs: 1000, timestampMs: 1 }));
    st.add(fix({ arrivalPerfMs: 2000, timestampMs: 2 }));
    expect(st.summary(3, false).speedNullPct).toBe(33.3);
  });

  it('rounds interval and age statistics to integer ms and accuracy to 0.1 m', () => {
    const st = new GpsStats('m');
    // Fractional inputs, like real performance.now() readings: intervals 1000.4 and 1000.7 ms, every age 800.6 ms.
    st.add(fix({ arrivalPerfMs: 0, arrivalEpochMs: 10_000.6, timestampMs: 9_200, accuracyM: 4.44 }));
    st.add(fix({ arrivalPerfMs: 1000.4, arrivalEpochMs: 11_000.6, timestampMs: 10_200, accuracyM: 4.44 }));
    st.add(fix({ arrivalPerfMs: 2001.1, arrivalEpochMs: 12_000.6, timestampMs: 11_200, accuracyM: 4.44 }));
    const s = st.summary(3, false);
    expect(s.intervalMedianMs).toBe(1000);
    expect(s.intervalP95Ms).toBe(1001);
    expect(s.ageMedianMs).toBe(801);
    expect(s.ageP95Ms).toBe(801);
    expect(s.accuracyMedianM).toBe(4.4);
  });

  it('flags speed=0 while moving > 20 m relative to the fix ≥ 5 s earlier', () => {
    const st = new GpsStats('m');
    // Driving north at 10 m/s, one fix per second; speed reported 0 at t=3 s and t=6 s.
    for (let t = 0; t <= 7; t++) {
      st.add(
        fix({
          arrivalPerfMs: t * 1000,
          timestampMs: t * 1000,
          lat: north(10 * t),
          speedMps: t === 3 || t === 6 ? 0 : 10,
        }),
      );
    }
    const s = st.summary(8, false);
    // t=3: no fix arrived ≤ −2000 → not counted. t=6: fix at t=1 (arrival 1000 ≤ 1000) is 50 m back → counted.
    expect(s.speedZeroPct).toBe(25);
    expect(s.speedZeroWhileMovingPct).toBe(12.5);
  });

  it('measures from the NEAREST fix ≥ 5 s earlier, not an older one', () => {
    const st = new GpsStats('m');
    // 100 m north at t=0, then parked at 100 m from t=1 s; speed reads 0 at t=7 s.
    st.add(fix({ arrivalPerfMs: 0, timestampMs: 0, lat: north(0), speedMps: 10 }));
    for (let t = 1; t <= 7; t++) {
      st.add(fix({ arrivalPerfMs: t * 1000, timestampMs: t * 1000, lat: north(100), speedMps: t === 7 ? 0 : 0.5 }));
    }
    // Nearest fix with arrival ≤ 2000 ms is t=2 (0 m away): not moving. The t=0 fix (100 m) must not be used.
    expect(st.summary(8, false).speedZeroWhileMovingPct).toBe(0);
  });

  it('uses a fix that arrived exactly 5000 ms earlier (arrival ≤ now − 5000)', () => {
    const st = new GpsStats('m');
    st.add(fix({ arrivalPerfMs: 0, timestampMs: 0, lat: north(50) }));
    st.add(fix({ arrivalPerfMs: 1000, timestampMs: 1000, lat: north(0) }));
    st.add(fix({ arrivalPerfMs: 6000, timestampMs: 6000, lat: north(50), speedMps: 0 }));
    // Cutoff 1000: the t=1 s fix (50 m back) qualifies, so the speed-0 fix counts as moving.
    // A strict "< cutoff" would fall back to the t=0 fix (0 m back) and count nothing.
    expect(st.summary(6, false).speedZeroWhileMovingPct).toBe(33.3);
  });

  it('does not flag speed=0 while parked (GPS jitter < 20 m)', () => {
    const st = new GpsStats('m');
    for (let t = 0; t <= 7; t++) {
      st.add(fix({ arrivalPerfMs: t * 1000, timestampMs: t * 1000, lat: north(t % 2 === 0 ? 0 : 3), speedMps: 0 }));
    }
    const s = st.summary(8, false);
    expect(s.speedZeroPct).toBe(100);
    expect(s.speedZeroWhileMovingPct).toBe(0);
  });

  it('counts errors per code, hidden fixes and passes duration/crash flag through', () => {
    const st = new GpsStats('watch-hiacc-on');
    st.addError(1);
    st.addError(2);
    st.addError(3);
    st.addError(3);
    st.add(fix({ hidden: true }));
    st.add(fix({ arrivalPerfMs: 1000, timestampMs: 5, hidden: false }));
    const s = st.summary(12.5, true);
    expect(s.errors).toEqual({ permission: 1, unavailable: 1, timeout: 2 });
    expect(s.fixesWhileHidden).toBe(1);
    expect(s.durationS).toBe(12.5);
    expect(s.crashedPreviously).toBe(true);
    expect(s.mode).toBe('watch-hiacc-on');
  });

  it('is stateful across calls: summary() is repeatable and later adds update it', () => {
    const st = new GpsStats('m');
    st.add(fix({ arrivalPerfMs: 0 }));
    const a = st.summary(1, false);
    const b = st.summary(1, false);
    expect(b).toEqual(a);
    b.errors.permission = 99; // mutating a returned summary must not leak into the stats
    st.add(fix({ arrivalPerfMs: 1000, timestampMs: 7 }));
    const c = st.summary(2, false);
    expect(c.fixes).toBe(2);
    expect(c.intervalMedianMs).toBe(1000);
    expect(c.errors.permission).toBe(0);
  });

  it('never exposes coordinates in the summary', () => {
    const st = new GpsStats('m');
    st.add(fix({ lat: 0.0123456, lon: 0.0654321 }));
    const json = JSON.stringify(st.summary(1, false));
    expect(json).not.toContain('0.0123456');
    expect(json).not.toContain('0.0654321');
    expect(json).not.toMatch(/"lat"|"lon"/);
  });
});
