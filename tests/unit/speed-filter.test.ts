import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING, F } from '../../src/contracts';
import type { FixMsg } from '../../src/contracts';
import { SpeedFilter } from '../../src/sim/speed-filter';

/** Metres per degree of longitude on the equator for haversineM's R = 6371008.8 m (exact distances). */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

function fixAt(sM: number, speedMps: number | null, ageS = 1, accuracyM = 5): FixMsg {
  return { type: 'fix', ageS, speedMps, lat: 0, lon: sM / M_PER_DEG, accuracyM, altitudeM: null };
}

/**
 * Feeds noise-free fixes measured at integer seconds k = k0..k1 (arrival k + 1, ageS 1) for a truth
 * position function and speed reading, at the given accuracy. Returns the arrival time of the last fix.
 */
function feed(
  f: SpeedFilter,
  k0: number,
  k1: number,
  posAt: (t: number) => number,
  speedAt: (t: number) => number | null,
  accuracyM = 5,
): number {
  let arrival = 0;
  for (let k = k0; k <= k1; k++) {
    arrival = k + 1;
    expect(f.accept(fixAt(posAt(k), speedAt(k), 1, accuracyM), arrival)).toBe(true);
    f.evaluate(arrival);
  }
  return arrival;
}

/** White-box view of the posterior (state [s, v, a] at tK and its row-major 3×3 covariance). */
function posterior(f: SpeedFilter): { readonly x: Float64Array; readonly P: Float64Array } {
  return f as unknown as { readonly x: Float64Array; readonly P: Float64Array };
}

// ── Independent dense 3×3 reference of the contract's filter equations (test-only, allocates freely) ──

type Mat = number[][];

/** Element (r, c); NaN outside the matrix, so a reference bug shows up in the comparison. */
const el = (m: Mat, r: number, c: number): number => m[r]?.[c] ?? Number.NaN;
const mul = (A: Mat, B: Mat): Mat =>
  A.map((_, r) => (B[0] ?? []).map((_, c) => B.reduce((sum, _, k) => sum + el(A, r, k) * el(B, k, c), 0)));
const transpose = (A: Mat): Mat => (A[0] ?? []).map((_, c) => A.map((_, r) => el(A, r, c)));
const add = (A: Mat, B: Mat): Mat => A.map((row, r) => row.map((_, c) => el(A, r, c) + el(B, r, c)));
const sub = (A: Mat, B: Mat): Mat => A.map((row, r) => row.map((_, c) => el(A, r, c) - el(B, r, c)));
const scale = (A: Mat, k: number): Mat => A.map((row) => row.map((v) => v * k));
const I3: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** x: 3×1 column [s, v, a]; P: 3×3. */
interface RefState {
  x: Mat;
  P: Mat;
}

/** Contract predict over Δ = d: x ← F·x, P ← F·P·Fᵀ + q·Q(Δ) (white jerk). */
function refPredict(st: RefState, d: number, q: number): RefState {
  const Fm: Mat = [
    [1, d, (d * d) / 2],
    [0, 1, d],
    [0, 0, 1],
  ];
  const Q: Mat = [
    [d ** 5 / 20, d ** 4 / 8, d ** 3 / 6],
    [d ** 4 / 8, d ** 3 / 3, d ** 2 / 2],
    [d ** 3 / 6, d ** 2 / 2, d],
  ];
  return { x: mul(Fm, st.x), P: add(mul(mul(Fm, st.P), transpose(Fm)), scale(Q, q)) };
}

/** Contract scalar update (row H, value z, variance r): K = P·Hᵀ/S, P ← (I − K·H)·P, then symmetrised. */
function refUpdate(st: RefState, H: Mat, z: number, r: number): RefState {
  const PHt = mul(st.P, transpose(H));
  const K = scale(PHt, 1 / (el(mul(H, PHt), 0, 0) + r));
  const P = mul(sub(I3, mul(K, H)), st.P);
  return {
    x: add(st.x, scale(K, z - el(mul(H, st.x), 0, 0))),
    P: P.map((row, i) => row.map((_, j) => 0.5 * (el(P, i, j) + el(P, j, i)))),
  };
}

/** Element-wise |got − want| ≤ 1e-9 · max(1, |want|). */
function expectMatches(got: ArrayLike<number>, want: readonly number[], what: string): void {
  expect(got.length, `${what}: length`).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? Number.NaN;
    const g = got[i] ?? Number.NaN;
    expect(Math.abs(g - w), `${what}[${i}] = ${g}, reference ${w}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(w)));
  }
}

describe('SpeedFilter — before the first fix', () => {
  it('reports GPS_LOST | STANDSTILL with v = a = 0 on every evaluate', () => {
    const f = new SpeedFilter();
    for (const now of [0, 1, 50]) {
      f.evaluate(now);
      expect(f.v).toBe(0);
      expect(f.a).toBe(0);
      expect(f.flags).toBe(F.GPS_LOST | F.STANDSTILL);
      expect(f.hasFix).toBe(false);
    }
    expect(f.fixesAccepted).toBe(0);
    expect(f.fixesRejected).toBe(0);
  });
});

describe('SpeedFilter — first fix', () => {
  it('initialises v from a usable speed and leaves standstill', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, 12), 10)).toBe(true);
    f.evaluate(10);
    expect(f.hasFix).toBe(true);
    expect(f.fixesAccepted).toBe(1);
    expect(f.v).toBeCloseTo(12, 12);
    expect(f.a).toBe(0);
    expect(f.flags & (F.GPS_LOST | F.STANDSTILL | F.PREDICTING)).toBe(0);
  });

  it('initialises v = 0 when speed is missing and stays in standstill', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, null), 10)).toBe(true);
    f.evaluate(10.5);
    expect(f.v).toBe(0);
    expect(f.flags).toBe(F.STANDSTILL);
  });
});

describe('SpeedFilter — accept/reject (§8.2 step 1)', () => {
  it.each<[string, Partial<FixMsg>]>([
    ['age > 3 s', { ageS: 3.01 }],
    ['non-finite age', { ageS: Number.NaN }],
    ['NaN lat', { lat: Number.NaN }],
    ['infinite lon', { lon: Number.POSITIVE_INFINITY }],
    ['zero accuracy', { accuracyM: 0 }],
    ['negative accuracy', { accuracyM: -3 }],
    ['NaN accuracy', { accuracyM: Number.NaN }],
  ])('rejects a fix with %s and counts it', (_label, patch) => {
    const f = new SpeedFilter();
    expect(f.accept({ ...fixAt(0, 10), ...patch }, 5)).toBe(false);
    expect(f.accept({ ...fixAt(0, 10), ...patch }, 6)).toBe(false);
    expect(f.fixesRejected).toBe(2);
    expect(f.fixesAccepted).toBe(0);
    expect(f.hasFix).toBe(false);
  });

  it('accepts age exactly 3 s', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, 10, 3), 5)).toBe(true);
  });

  it('RF1: rejects out-of-order and repeated cached fixes without moving v or the dropout timer', () => {
    const test = new SpeedFilter();
    const control = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    const spd = () => 15;
    feed(test, 0, 4, pos, spd); // last accepted: measured 4, arrived 5 → tK = 4
    feed(control, 0, 4, pos, spd);

    // Out of order: measured 3.5, delivered 5.5 (tFix 3.5 < tK).
    expect(test.accept(fixAt(pos(3.5), 15, 2.0), 5.5)).toBe(false);
    // Repeated cached fix: the measurement from t = 4 again, now 1.6 s old (tFix = tK).
    expect(test.accept(fixAt(pos(4), 15, 1.6), 5.6)).toBe(false);
    // Within 0.05 s of tK (tFix = 4.04).
    expect(test.accept(fixAt(pos(4.04), 15, 1.66), 5.7)).toBe(false);
    // A wild position in a rejected fix must not leak into the state.
    expect(test.accept(fixAt(99999, 80, 1.7), 5.7)).toBe(false);

    expect(test.fixesRejected).toBe(4);
    expect(test.fixesAccepted).toBe(control.fixesAccepted);
    for (const now of [5.7, 6.5, 7.1]) {
      test.evaluate(now);
      control.evaluate(now);
      expect(test.v).toBe(control.v);
      expect(test.a).toBe(control.a);
      expect(test.flags).toBe(control.flags);
    }
    // Last ACCEPTED arrival was 5.0 → PREDICTING after 7.0 although rejected fixes arrived at 5.5–5.7.
    expect(test.flags & F.PREDICTING).toBe(F.PREDICTING);

    // The next genuine fix (measured 6.0, delivered 7.2) is accepted again.
    expect(test.accept(fixAt(pos(6), 15, 1.2), 7.2)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a fix delivered at nowS = %s (before the first fix and mid-drive) without poisoning the state',
    (bad) => {
      const test = new SpeedFilter();
      const control = new SpeedFilter();
      const pos = (t: number) => 15 * t;
      const spd = () => 15;
      expect(test.accept(fixAt(0, 15), bad)).toBe(false);
      expect(test.hasFix).toBe(false);
      feed(test, 0, 4, pos, spd);
      feed(control, 0, 4, pos, spd);
      expect(test.accept(fixAt(pos(5), 15), bad)).toBe(false);
      expect(test.fixesRejected).toBe(2);
      // Later genuine fixes are still accepted (feed asserts it) and the output matches the control's.
      const last = feed(test, 5, 8, pos, spd);
      feed(control, 5, 8, pos, spd);
      test.evaluate(last + 0.5);
      control.evaluate(last + 0.5);
      expect(test.v).toBe(control.v);
      expect(test.a).toBe(control.a);
      expect(test.flags).toBe(control.flags);
      expect(test.fixesAccepted).toBe(control.fixesAccepted);
    },
  );
});

describe('SpeedFilter — tracking', () => {
  it('tracks a constant speed exactly with speed measurements present', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 12, (t) => 20 * t, () => 20);
    f.evaluate(arrival);
    expect(f.v).toBeCloseTo(20, 2);
    expect(Math.abs(f.a)).toBeLessThan(0.02);
    expect(f.flags).toBe(0);
  });

  it('tracks a constant speed from positions alone (speed null)', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 20, (t) => 15 * t, () => null);
    f.evaluate(arrival);
    expect(Math.abs(f.v - 15)).toBeLessThan(0.3);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('treats speed %s exactly like a missing speed', (bad) => {
    const test = new SpeedFilter();
    const control = new SpeedFilter();
    feed(test, 0, 8, (t) => 10 * t, (t) => (t === 0 ? 10 : bad));
    feed(control, 0, 8, (t) => 10 * t, (t) => (t === 0 ? 10 : null));
    test.evaluate(9.3);
    control.evaluate(9.3);
    expect(test.v).toBe(control.v);
    expect(test.a).toBe(control.a);
  });

  it('predicts with saturating acceleration: v(∞) − v(τ) = τa·a(τ) and a decays', () => {
    const f = new SpeedFilter();
    // Constant 2 m/s² from 4 m/s, speed present, noise-free.
    const arrival = feed(f, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    f.evaluate(arrival);
    const v1 = f.v;
    const a1 = f.a;
    // τ = 0.1 s output latency + 1 s fix age → a = a_k·e^(−1.1/0.6) with a_k ≈ 2 m/s².
    expect(a1).toBeCloseTo(2 * Math.exp(-1.1 / DEFAULT_SIM_TUNING.tauA), 2);
    let prev = v1;
    for (let now = arrival; now <= arrival + 1.9; now += 0.1) {
      f.evaluate(now);
      expect(f.v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f.v;
    }
    f.evaluate(arrival + 15); // τ ≫ τa (PREDICTING, not lost)
    expect(f.flags & F.GPS_LOST).toBe(0);
    expect(f.a).toBeLessThan(1e-9);
    expect(f.v - v1).toBeCloseTo(DEFAULT_SIM_TUNING.tauA * a1, 9);
  });

  it('honours a non-default tauA from the constructor and from configure(): a = a_k·e^(−τ/τa), v(∞) − v(τ) = τa·a(τ)', () => {
    const TAU_A = 1.2;
    const pos = (t: number) => 4 * t + t * t; // 2 m/s² from 4 m/s, speed present, noise-free
    const spd = (t: number) => 4 + 2 * t;
    const built = new SpeedFilter({ ...DEFAULT_SIM_TUNING, tauA: TAU_A });
    const switched = new SpeedFilter();
    const arrival = feed(built, 0, 12, pos, spd);
    feed(switched, 0, 12, pos, spd);
    switched.configure({ ...DEFAULT_SIM_TUNING, tauA: TAU_A }); // mid-drive: the state is kept
    const tK = arrival - 1; // the last fix was measured 1 s before it arrived
    for (const f of [built, switched]) {
      const vk = posterior(f).x[1] ?? Number.NaN;
      const ak = posterior(f).x[2] ?? Number.NaN;
      expect(ak).toBeCloseTo(2, 1); // the posterior has learned the 2 m/s²
      for (const now of [arrival, arrival + 0.4, arrival + 1.7, arrival + 6, arrival + 19.9]) {
        f.evaluate(now);
        expect(f.flags & (F.GPS_LOST | F.STANDSTILL)).toBe(0);
        const tau = now + DEFAULT_SIM_TUNING.outputLatencyS - tK;
        expect(f.a).toBeCloseTo(ak * Math.exp(-tau / TAU_A), 12);
        // v(∞) = v_k + τa·a_k, so v(∞) − v(τ) = τa·a(τ) at every τ.
        expect(vk + TAU_A * ak - f.v).toBeCloseTo(TAU_A * f.a, 9);
      }
    }
  });

  it('honours outputLatencyS from configure() without resetting the state', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    f.evaluate(arrival);
    const vDefault = f.v;
    f.configure({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.6 });
    expect(f.hasFix).toBe(true);
    f.evaluate(arrival);
    expect(f.v).toBeGreaterThan(vDefault);
    // Same as evaluating 0.5 s later with the default latency.
    const g = new SpeedFilter();
    feed(g, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    g.evaluate(arrival + 0.5);
    expect(f.v).toBeCloseTo(g.v, 12);
  });
});

describe('SpeedFilter — exact filter equations (contract numbers: P0, Q, R_s, R_v)', () => {
  /** Non-integer intervals and mutually inconsistent readings, so every innovation is non-zero. */
  const FIXES = [
    { nowS: 11.0, ageS: 1.0, s: 0, speed: 12 }, // first fix: tK = 10
    { nowS: 12.5, ageS: 1.2, s: 17.3, speed: 13.4 }, // Δ = 1.3
    { nowS: 13.0, ageS: 1.0, s: 26.9, speed: null }, // Δ = 0.7, position only
    { nowS: 14.3, ageS: 1.2, s: 41.2, speed: 12.1 }, // Δ = 1.1
    { nowS: 15.0, ageS: 0.4, s: 59.6, speed: 12.9 }, // Δ = 1.5
  ];

  it.each([
    ['accuracy 4 m (R_v at its 0.3 m/s floor), default q', 4, DEFAULT_SIM_TUNING.kalmanQ, true],
    ['accuracy 10 m (R_v = (0.05·accuracy)²), default q', 10, DEFAULT_SIM_TUNING.kalmanQ, true],
    ['accuracy 7 m, q = 0.7, position only', 7, 0.7, false],
  ] as const)('%s: the posterior x and P after every fix match a dense 3×3 reference', (_label, acc, q, withSpeed) => {
    const f = new SpeedFilter({ ...DEFAULT_SIM_TUNING, kalmanQ: q });
    let ref: RefState = { x: [], P: [] };
    let tK = Number.NaN;
    for (const [j, fx] of FIXES.entries()) {
      const speed = withSpeed ? fx.speed : null;
      expect(f.accept(fixAt(fx.s, speed, fx.ageS, acc), fx.nowS)).toBe(true);
      const tFix = fx.nowS - fx.ageS;
      if (j === 0) {
        ref = {
          x: [[0], [speed ?? 0], [0]],
          P: [
            [25, 0, 0],
            [0, 25, 0],
            [0, 0, 4],
          ],
        };
      } else {
        ref = refPredict(ref, tFix - tK, q);
        ref = refUpdate(ref, [[1, 0, 0]], fx.s, (acc / 2) ** 2);
        if (speed !== null) ref = refUpdate(ref, [[0, 1, 0]], speed, Math.max(0.3, 0.05 * acc) ** 2);
      }
      tK = tFix;
      expectMatches(posterior(f).x, ref.x.flat(), `x after fix ${j + 1}`);
      expectMatches(posterior(f).P, ref.P.flat(), `P after fix ${j + 1}`);
      f.evaluate(fx.nowS); // v stays far from the standstill thresholds, so the posterior is untouched
    }
    // §8.2 step 4 from the reference posterior: τ = nowS + outputLatencyS − tK.
    const { tauA, outputLatencyS } = DEFAULT_SIM_TUNING;
    const decay = Math.exp(-((FIXES.at(-1)?.nowS ?? Number.NaN) + outputLatencyS - tK) / tauA);
    expect(f.flags & F.STANDSTILL).toBe(0);
    expectMatches(
      [f.v, f.a],
      [el(ref.x, 1, 0) + el(ref.x, 2, 0) * tauA * (1 - decay), el(ref.x, 2, 0) * decay],
      'output [v, a]',
    );
  });
});

describe('SpeedFilter — zero speed (§8.2 step 2, contract A2)', () => {
  it('A2: a zero with d1 < 3 m is a measurement at once and pulls v into standstill', () => {
    const zero = new SpeedFilter();
    const none = new SpeedFilter();
    // Creeping at 2.5 m/s with the speed reported, then the receiver reports 0 (d1 = 2.5 m < 3 m).
    feed(zero, 0, 3, (t) => 2.5 * t, () => 2.5);
    feed(none, 0, 3, (t) => 2.5 * t, () => 2.5);
    feed(zero, 4, 4, (t) => 2.5 * t, () => 0);
    feed(none, 4, 4, (t) => 2.5 * t, () => null);
    expect(zero.v).toBeLessThan(none.v); // used on the very first zero: no history window needed
    feed(zero, 5, 12, (t) => 2.5 * t, () => 0);
    feed(none, 5, 12, (t) => 2.5 * t, () => null);
    expect(zero.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(zero.v).toBe(0);
    expect(zero.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(none.flags & F.STANDSTILL).toBe(0);
    expect(Math.abs(none.v - 2.5)).toBeLessThan(0.3);
  });

  it('RF2: latches SPEED_UNUSABLE on the 3rd consecutive moving zero (d1, d0 ≥ 8 m) and then tracks via position', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    // k = 1 has no previous interval (d0 undefined) → ignored, not counted; k = 2, 3 count 1, 2.
    feed(f, 0, 3, pos, () => 0);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 4, 4, pos, () => 0); // k = 4: third consecutive moving zero → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);

    // Session-long: later genuine speeds are ignored (identical to a speed-null control).
    const control = new SpeedFilter();
    feed(control, 0, 4, pos, () => 0);
    feed(f, 5, 24, pos, () => 15);
    feed(control, 5, 24, pos, () => null);
    f.evaluate(25.5);
    control.evaluate(25.5);
    expect(f.v).toBe(control.v);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
    expect(Math.abs(f.v - 15)).toBeLessThan(0.3);

    f.reset();
    f.evaluate(30);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(f.fixesAccepted).toBe(0);
  });

  it('A2: a usable (non-zero) speed between moving zeros resets the count', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    feed(f, 0, 3, pos, () => 0); // count 2
    feed(f, 4, 4, pos, () => 15); // not a moving zero → count 0
    feed(f, 5, 6, pos, () => 0); // count 1, 2
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 7, 7, pos, () => 0); // count 3 → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
  });

  it('A2: a zero over a short interval (d1 < 8 m) resets the count, and the next zero needs d0 ≥ 8 m too', () => {
    const f = new SpeedFilter();
    // 15 m/fix, except a 5 m interval from k = 3 to k = 4.
    const pos = (t: number) => (t <= 3 ? 15 * t : 15 * t - 10);
    feed(f, 0, 3, pos, () => 0); // count 2
    feed(f, 4, 4, pos, () => 0); // d1 = 5 m → ignored without counting → count 0
    feed(f, 5, 5, pos, () => 0); // d1 = 15 m but d0 = 5 m → not a moving zero → count 0
    feed(f, 6, 7, pos, () => 0); // count 1, 2
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 8, 8, pos, () => 0); // count 3 → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
  });

  it('A2: zeros with 3 m ≤ d1 < 8 m are ignored without counting; v tracks 5 m/s via position', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 30, (t) => 5 * t, () => 0);
    f.evaluate(arrival);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(Math.abs(f.v - 5)).toBeLessThan(0.3);
  });
});

describe('SpeedFilter — standstill position deadband (contract A3)', () => {
  it('below 1.5 m/s a fix-to-fix displacement < 0.4·accuracy adds nothing to s_meas; real creep still moves v', () => {
    const jitter = (t: number): number => (t % 2 === 0 ? 0.9 : -0.9); // |d1| = 1.8 m every fix
    const dead = new SpeedFilter(); // accuracy 5 m → threshold 2.0 m → every step suppressed
    const live = new SpeedFilter(); // accuracy 4 m → threshold 1.6 m → 1.8 m/s of fake travel
    for (let k = 0; k <= 30; k++) {
      feed(dead, k, k, jitter, () => null, 5);
      expect(dead.flags & F.STANDSTILL).toBe(F.STANDSTILL);
      expect(dead.v).toBe(0);
    }
    feed(live, 0, 30, jitter, () => null, 4);
    expect(live.flags & F.STANDSTILL).toBe(0);

    const creep = new SpeedFilter(); // 3 m/fix ≥ 2.0 m → counted although v starts at 0
    const arrival = feed(creep, 0, 30, (t) => 3 * t, () => null, 5);
    creep.evaluate(arrival);
    expect(creep.flags & F.STANDSTILL).toBe(0);
    expect(Math.abs(creep.v - 3)).toBeLessThan(0.3);
  });
});

describe('SpeedFilter — standstill hysteresis (§8.2 step 5)', () => {
  it('enters below 0.5 m/s, leaves above 1.0 m/s, and outputs v = a = 0 while standing', () => {
    // Holds sit just either side of each threshold (noise-free ramps settle within ~0.01 m/s), so a
    // threshold moved by ≥ 0.1 m/s in either direction fails.
    const f = new SpeedFilter();
    let s = 0;
    let speed = 0.9;
    let arrival = 1;
    /** Ramps the true speed to `target` by ≤ 0.05 m/s per fix (no deceleration transients), then holds. */
    const drive = (target: number, holdFixes: number): void => {
      let held = 0;
      while (held < holdFixes) {
        if (Math.abs(target - speed) <= 0.05) {
          speed = target;
          held++;
        } else {
          speed += target > speed ? 0.05 : -0.05;
        }
        f.accept(fixAt(s, speed), arrival);
        f.evaluate(arrival);
        s += speed;
        arrival++;
      }
    };
    drive(0.9, 6); // starts in standstill; 0.9 < 1.0 → stays
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(f.v).toBe(0);
    expect(f.a).toBe(0);
    drive(1.1, 4); // > 1.0 → leaves
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(f.v).toBeCloseTo(1.1, 1);
    drive(0.6, 6); // between 0.5 and 1.0 → stays moving
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(f.v).toBeCloseTo(0.6, 1);
    drive(0.4, 4); // < 0.5 → enters
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(f.v).toBe(0);
    expect(f.a).toBe(0);
  });
});

describe('SpeedFilter — dropout (§8.2 step 6)', () => {
  it('RF3: 35 s tunnel → PREDICTING after 2 s, no snap, GPS_LOST after 20 s, eased to 0 by 30 s, recovers', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 25 * t;
    const last = feed(f, 0, 19, pos, () => 25); // last arrival 20.0
    expect(last).toBe(20);
    const at = (gap: number): void => f.evaluate(last + gap);

    at(1.5);
    expect(f.flags & (F.PREDICTING | F.GPS_LOST)).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
    at(2.5);
    expect(f.flags & F.PREDICTING).toBe(F.PREDICTING);
    expect(f.flags & F.GPS_LOST).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
    at(19.9);
    expect(f.flags & F.GPS_LOST).toBe(0);
    const before = f.v;
    expect(before).toBeCloseTo(25, 1);

    // Ease: continuous at 20 s, monotonically non-increasing, linear to 0 at 30 s.
    let prev = before;
    for (let gap = 20.0; gap <= 30.0001; gap += 128 / 48000) {
      at(gap);
      expect(f.v).toBeLessThanOrEqual(prev + 1e-9);
      prev = f.v;
    }
    at(20.01);
    expect(f.flags & (F.GPS_LOST | F.PREDICTING)).toBe(F.GPS_LOST | F.PREDICTING);
    expect(Math.abs(f.v - before)).toBeLessThan(0.05);
    at(25);
    expect(f.v).toBeCloseTo(before * 0.5, 1);
    at(30);
    expect(f.v).toBe(0);
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    at(34.9);
    expect(f.v).toBe(0);

    // Exit: measured at 54 (35 s after the last measurement), arrives 55.
    expect(f.accept(fixAt(pos(54), 25), last + 35)).toBe(true);
    at(35);
    expect(f.flags & (F.GPS_LOST | F.PREDICTING | F.STANDSTILL)).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
  });

  it('saturates the prediction while accelerating into a gap (Δv ≤ a·τa)', () => {
    const f = new SpeedFilter();
    const last = feed(f, 0, 12, (t) => 5 * t + 0.5 * t * t, (t) => 5 + t); // 1 m/s²
    f.evaluate(last);
    const v0 = f.v;
    const a0 = f.a;
    for (const gap of [3, 8, 15, 19.9]) {
      f.evaluate(last + gap);
      expect(f.v).toBeLessThanOrEqual(v0 + a0 * DEFAULT_SIM_TUNING.tauA + 1e-9);
      expect(f.v).toBeGreaterThanOrEqual(v0);
    }
  });
});

describe('SpeedFilter — long fix gaps', () => {
  it.each([
    ['speed present', 30],
    ['position only', null],
  ] as const)('a gap of hours (%s) re-seeds instead of predicting: P keeps a non-negative diagonal, v recovers by the 2nd fix', (_label, speed) => {
    const f = new SpeedFilter();
    const P = posterior(f).P;
    feed(f, 0, 20, (t) => 15 * t, () => (speed === null ? null : 15)); // 21 fixes at 15 m/s, last measured at 20 s
    const resumeS = 20 + 7200; // e.g. Tesbox minimised for two hours while driving (no geolocation while hidden)
    for (let k = 0; k < 10; k++) {
      const tMeas = resumeS + k;
      expect(f.accept(fixAt(300 + 30 * (tMeas - 20), speed), tMeas + 1)).toBe(true);
      f.evaluate(tMeas + 1);
      for (const i of [0, 4, 8]) expect(P[i], `P[${i}] after resumed fix ${k + 1}`).toBeGreaterThanOrEqual(0);
      if (k >= 1) expect(Math.abs(f.v - 30), `v after resumed fix ${k + 1}`).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('SpeedFilter — hidden hold, reset, configure', () => {
  it('sets HIDDEN_HOLD while hidden, keeps accepting fixes, and clears it when visible', () => {
    const f = new SpeedFilter();
    feed(f, 0, 3, (t) => 10 * t, () => 10);
    f.setHidden(true);
    expect(f.flags & F.HIDDEN_HOLD).toBe(F.HIDDEN_HOLD);
    expect(f.accept(fixAt(40, 10), 5)).toBe(true);
    f.evaluate(5);
    expect(f.flags & F.HIDDEN_HOLD).toBe(F.HIDDEN_HOLD);
    expect(f.v).toBeCloseTo(10, 1);
    f.setHidden(false);
    expect(f.flags & F.HIDDEN_HOLD).toBe(0);
    f.evaluate(5.1);
    expect(f.flags & F.HIDDEN_HOLD).toBe(0);
  });

  it('reset() clears state and counters but keeps the hidden flag; the next session runs exactly like a fresh filter', () => {
    const f = new SpeedFilter();
    // Previous session: moving at 10 m/s, s_meas = 30 m, last interval 10 m (≥ 8 m), tK = 3 s.
    feed(f, 0, 3, (t) => 10 * t, () => 10);
    f.accept(fixAt(0, 10, 9), 6); // rejected
    f.setHidden(true);
    f.reset();
    expect(f.flags).toBe(F.GPS_LOST | F.STANDSTILL | F.HIDDEN_HOLD); // at once, before any evaluate
    expect(f.hasFix).toBe(false);
    expect(f.fixesAccepted).toBe(0);
    expect(f.fixesRejected).toBe(0);
    expect(f.v).toBe(0);
    expect(f.a).toBe(0);
    f.evaluate(7);
    expect(f.flags).toBe(F.GPS_LOST | F.STANDSTILL | F.HIDDEN_HOLD);

    // New session against a fresh (hidden) control: 15 m/s with the speed reported as 0, starting with a
    // fix measured at 0.5 s, older than the previous session's tK. A fresh filter latches SPEED_UNUSABLE
    // on the 5th fix (the 2nd fix has no d0), so a stale d0, s_meas or standstill state from the previous
    // session shows up in flags, v or the posterior.
    const control = new SpeedFilter();
    control.setHidden(true);
    for (let j = 0; j < 8; j++) {
      for (const g of [f, control]) {
        expect(g.accept(fixAt(15 * j, 0), 1.5 + j)).toBe(true);
        g.evaluate(1.5 + j);
      }
      const what = `after post-reset fix ${j + 1}`;
      expect(f.v, `v ${what}`).toBe(control.v);
      expect(f.a, `a ${what}`).toBe(control.a);
      expect(f.flags, `flags ${what}`).toBe(control.flags);
      expect(f.fixesAccepted, `fixesAccepted ${what}`).toBe(control.fixesAccepted);
      expect(Array.from(posterior(f).x), `x ${what}`).toEqual(Array.from(posterior(control).x));
      expect(Array.from(posterior(f).P), `P ${what}`).toEqual(Array.from(posterior(control).P));
    }
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
    expect(f.flags & F.STANDSTILL).toBe(0);
  });

  it('uses the constructor tuning (kalmanQ changes the position-only response)', () => {
    const slow = new SpeedFilter({ ...DEFAULT_SIM_TUNING, kalmanQ: 0.5 });
    const fast = new SpeedFilter({ ...DEFAULT_SIM_TUNING, kalmanQ: 50 });
    const pos = (t: number) => (t < 5 ? 0 : 20 * (t - 5));
    feed(slow, 0, 6, pos, () => null);
    feed(fast, 0, 6, pos, () => null);
    slow.evaluate(7);
    fast.evaluate(7);
    expect(fast.v).toBeGreaterThan(slow.v);
  });
});

describe('SpeedFilter — contract guards (standstill-entry posterior reset, A3 speed gate, PC3 re-seed boundary)', () => {
  it('standstill entry zeroes the posterior acceleration and sets its P row/column to [0, 0, 1]', () => {
    const f = new SpeedFilter();
    const box = posterior(f);
    // Braking at 2 m/s² from 8 m/s (speed present) to a stop at t = 4 s.
    const pos = (t: number) => (t < 4 ? 8 * t - t * t : 16);
    const spd = (t: number) => (t < 4 ? 8 - 2 * t : 0);
    feed(f, 0, 3, pos, spd);
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(box.x[2]).toBeLessThan(-1.5); // the posterior has learned the deceleration
    feed(f, 4, 4, pos, spd); // output v drops below 0.5 m/s → standstill entry
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(box.x[2]).toBe(0);
    expect([box.P[2], box.P[5], box.P[6], box.P[7], box.P[8]]).toEqual([0, 0, 0, 0, 1]);
  });

  it('A3 applies only while v < 1.5 m/s: a car at 2 m/s keeps tracking from position after its speed reading disappears', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 2 * t; // d1 = 2 m per fix < 0.4 · 8 m = 3.2 m
    feed(f, 0, 9, pos, () => 2, 8); // speed present → v = 2 m/s ≥ 1.5
    expect(f.v).toBeCloseTo(2, 3);
    const arrival = feed(f, 10, 40, pos, () => null, 8); // position only from here on
    f.evaluate(arrival);
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(Math.abs(f.v - 2)).toBeLessThan(0.1);
  });

  /** 15 m/s position-only up to tK = 20 s, GPS lost (eased to standstill) mid-gap, then 2 fixes from tK + gapS. */
  function resumeAfter(gapS: number): { v1: number; still1: boolean; v2: number } {
    const f = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    feed(f, 0, 20, pos, () => null);
    f.evaluate(21 + 31);
    expect(f.flags & (F.GPS_LOST | F.STANDSTILL)).toBe(F.GPS_LOST | F.STANDSTILL);
    const t1 = 20 + gapS;
    feed(f, t1, t1, pos, () => null);
    const v1 = f.v;
    const still1 = (f.flags & F.STANDSTILL) !== 0;
    feed(f, t1 + 1, t1 + 1, pos, () => null);
    return { v1, still1, v2: f.v };
  }

  it('predicts across a 59 s fix gap: v carries over on the first fix', () => {
    const r = resumeAfter(59);
    expect(Math.abs(r.v1 - 15)).toBeLessThan(0.1);
    expect(r.still1).toBe(false);
    expect(Math.abs(r.v2 - 15)).toBeLessThan(0.1);
  });

  it('re-seeds after a 61 s fix gap: position only → v = 0 on the first fix, set again by the second', () => {
    const r = resumeAfter(61);
    expect(r.v1).toBe(0);
    expect(r.still1).toBe(true);
    expect(Math.abs(r.v2 - 15)).toBeLessThan(0.1);
  });
});
