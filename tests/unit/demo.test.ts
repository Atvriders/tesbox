import { describe, expect, it } from 'vitest';
import { G } from '../../src/contracts';
import type { TeslaParams } from '../../src/contracts';
import { DEMO_PROFILE, DemoDriver, PedalPhysics, type PedalCommand } from '../../src/sim/demo';
import { maxForceN, rawLoad, roadForceN } from '../../src/sim/load';
import { DT, MID_TESLA } from '../helpers/sim-fixtures';

const KMH = 1 / 3.6;
const LOOP_S = DEMO_PROFILE[DEMO_PROFILE.length - 1]?.t ?? 0;

/** Fictional stand-ins for the extremes of the catalogue (quickest, heaviest, Chill mode). */
const QUICK: TeslaParams = {
  massKg: 2250,
  roadLoad: { A_N: 150, B_Nps_m: 1.2, C_Ns2_m2: 0.42 },
  fTracN: 1.1 * 2250 * G,
  pEffW: 760000,
  eta: 0.9,
  modeFactor: 1,
};
const HEAVY: TeslaParams = {
  massKg: 3200,
  roadLoad: { A_N: 220, B_Nps_m: 2.0, C_Ns2_m2: 0.62 },
  fTracN: 0.75 * 3200 * G,
  pEffW: 450000,
  eta: 0.9,
  modeFactor: 1,
};
const CHILL: TeslaParams = { ...HEAVY, modeFactor: 0.5 };

/** Pedals at profile time `time` (evaluate-then-advance: one jump, then a zero-length step). */
function pedalsAt(time: number): PedalCommand {
  const d = new DemoDriver();
  const out: PedalCommand = { throttle: -1, brake: -1 };
  d.step(time, out);
  d.step(0, out);
  return out;
}

/** True if some consecutive keyframe pair satisfies `pred` at both ends and spans ≥ minS; returns its start time. */
function heldFrom(pred: (th: number, br: number) => boolean, minS: number, after = -1): number {
  for (let i = 0; i + 1 < DEMO_PROFILE.length; i++) {
    const a = DEMO_PROFILE[i];
    const b = DEMO_PROFILE[i + 1];
    if (a === undefined || b === undefined || a.t <= after) continue;
    if (pred(a.throttle, a.brake) && pred(b.throttle, b.brake) && b.t - a.t >= minS) return a.t;
  }
  return Number.NaN;
}

describe('DEMO_PROFILE', () => {
  it('starts at rest at t = 0, has strictly increasing times and loops seamlessly at ~64 s', () => {
    const first = DEMO_PROFILE[0];
    const last = DEMO_PROFILE[DEMO_PROFILE.length - 1];
    expect(first).toEqual({ t: 0, throttle: 0, brake: 0 });
    expect(last?.throttle).toBe(0);
    expect(last?.brake).toBe(0);
    expect(LOOP_S).toBeGreaterThanOrEqual(60);
    expect(LOOP_S).toBeLessThanOrEqual(75);
    for (let i = 1; i < DEMO_PROFILE.length; i++) {
      expect(DEMO_PROFILE[i]?.t).toBeGreaterThan(DEMO_PROFILE[i - 1]?.t ?? Infinity);
    }
  });

  it('keeps both pedals in [0, 1] and never applies them together', () => {
    for (const k of DEMO_PROFILE) {
      expect(k.throttle).toBeGreaterThanOrEqual(0);
      expect(k.throttle).toBeLessThanOrEqual(1);
      expect(k.brake).toBeGreaterThanOrEqual(0);
      expect(k.brake).toBeLessThanOrEqual(1);
      expect(k.throttle * k.brake).toBe(0);
    }
  });

  it('contains idle → pull-away → WOT → cruise → lift-off → braking → stop, in that order', () => {
    const idle = heldFrom((th, br) => th === 0 && br === 0, 3);
    const pull = heldFrom((th) => th >= 0.3 && th < 1, 2, idle);
    const wot = heldFrom((th) => th === 1, 4, pull);
    const cruise = heldFrom((th) => th > 0 && th < 0.3, 10, wot);
    const lift = heldFrom((th, br) => th === 0 && br > 0 && br <= 0.15, 5, cruise); // lift-off regen
    const brake = heldFrom((th, br) => th === 0 && br >= 0.5, 10, lift);
    const stop = heldFrom((th, br) => th === 0 && br === 0, 5, brake);
    expect([idle, pull, wot, cruise, lift, brake, stop].every((x) => Number.isFinite(x))).toBe(true);
    expect(idle).toBe(0);
  });
});

describe('DemoDriver', () => {
  it('returns the t = 0 keyframe on the first step, then advances', () => {
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: -1, brake: -1 };
    d.step(DT, out);
    expect(out).toEqual({ throttle: 0, brake: 0 });
  });

  it('interpolates linearly between keyframes', () => {
    expect(pedalsAt(3.25).throttle).toBeCloseTo(0.2, 12); // (3, 0) → (3.5, 0.4)
    expect(pedalsAt(6.5).throttle).toBeCloseTo(0.26, 12); // (6, 0.4) → (7, 0.12)
    expect(pedalsAt(16).throttle).toBe(1);
    expect(pedalsAt(33.75)).toEqual({ throttle: 0, brake: 0.05 }); // (33.5, 0, 0) → (34, 0, 0.1)
    expect(pedalsAt(41.5).throttle).toBe(0); // (41, 0, 0.1) → (42, 0, 0.6)
    expect(pedalsAt(41.5).brake).toBeCloseTo(0.35, 12);
    expect(pedalsAt(49).brake).toBeCloseTo(0.6, 12);
  });

  it('loops: profile time loopS + x plays the same pedals as x; reset() restarts at idle', () => {
    for (const x of [1, 5, 16.25, 30, 49]) {
      const a = pedalsAt(x);
      const b = pedalsAt(LOOP_S + x);
      const c = pedalsAt(3 * LOOP_S + x);
      expect(b.throttle).toBeCloseTo(a.throttle, 9);
      expect(b.brake).toBeCloseTo(a.brake, 9);
      expect(c.throttle).toBeCloseTo(a.throttle, 9);
    }
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: 0, brake: 0 };
    d.step(16, out);
    d.step(0, out);
    expect(out.throttle).toBe(1);
    d.reset();
    d.step(DT, out);
    expect(out).toEqual({ throttle: 0, brake: 0 });
  });

  it('stepped per quantum over two loops, the pedal trace has no jumps (incl. the loop wrap)', () => {
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: 0, brake: 0 };
    let prevTh = 0;
    let prevBr = 0;
    let sawWot = 0;
    for (let k = 0; k * DT < 2 * LOOP_S; k++) {
      d.step(DT, out);
      expect(Math.abs(out.throttle - prevTh)).toBeLessThan(0.01);
      expect(Math.abs(out.brake - prevBr)).toBeLessThan(0.01);
      expect(out.throttle * out.brake).toBe(0); // never both, also between keyframes
      if (out.throttle === 1) sawWot++;
      prevTh = out.throttle;
      prevBr = out.brake;
    }
    expect(sawWot).toBeGreaterThan(2 * Math.floor(4 / DT));
  });
});

describe('PedalPhysics', () => {
  it('integrates a = (throttle·maxForceN − roadForceN − brake·m·0.8·G)/m step by step', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    let v = 0;
    for (let k = 0; k < 3000; k++) {
      const th = k < 1500 ? 0.7 : 0;
      const br = k >= 2500 ? 0.2 : 0;
      const fRoad = v > 0 ? roadForceN(MID_TESLA, v) : 0;
      const a = (th * maxForceN(MID_TESLA, v) - fRoad - br * MID_TESLA.massKg * 0.8 * G) / MID_TESLA.massKg;
      v = Math.max(0, v + a * DT);
      ph.step(th, br, DT);
      expect(ph.v).toBeCloseTo(v, 9);
      if (v > 0) expect(ph.a).toBeCloseTo(a, 9);
    }
    expect(ph.v).toBeGreaterThan(5);
  });

  it('has zero road force at rest: without throttle a stationary car stays put with a = 0', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    for (let k = 0; k < 100; k++) {
      ph.step(0, 0, DT);
      expect(ph.v).toBe(0);
      expect(ph.a).toBe(0);
    }
  });

  it('clamps at v = 0 when braking to a stop and reports the acceleration actually applied', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    for (let k = 0; k < 400; k++) ph.step(1, 0, DT);
    expect(ph.v).toBeGreaterThan(2);
    let stoppedSteps = 0;
    for (let k = 0; k < 2000; k++) {
      const before = ph.v;
      ph.step(0, 1, DT);
      expect(ph.v).toBeGreaterThanOrEqual(0);
      expect(ph.a).toBeCloseTo((ph.v - before) / DT, 6);
      if (ph.v === 0) {
        stoppedSteps++;
        if (before === 0) expect(ph.a).toBe(0); // held on the brake: no phantom −0.8 g
      }
    }
    expect(stoppedSteps).toBeGreaterThan(1000);
  });

  it('clamps pedals to [0, 1] (NaN → 0)', () => {
    const a = new PedalPhysics();
    const b = new PedalPhysics();
    a.configure(MID_TESLA);
    b.configure(MID_TESLA);
    for (let k = 0; k < 50; k++) {
      a.step(7, -3, DT);
      b.step(1, 0, DT);
    }
    expect(a.v).toBe(b.v);
    a.step(Number.NaN, Number.NaN, DT);
    b.step(0, 0, DT);
    expect(a.v).toBe(b.v);
  });

  it('does nothing before configure() or for dtS ≤ 0; reset() stops the car', () => {
    const ph = new PedalPhysics();
    ph.step(1, 0, DT);
    expect(ph.v).toBe(0);
    ph.configure(MID_TESLA);
    ph.step(1, 0, 0);
    ph.step(1, 0, -DT);
    ph.step(1, 0, Number.NaN);
    expect(ph.v).toBe(0);
    for (let k = 0; k < 100; k++) ph.step(1, 0, DT);
    expect(ph.v).toBeGreaterThan(0);
    ph.reset();
    expect(ph.v).toBe(0);
    expect(ph.a).toBe(0);
  });
});

describe('DEMO_PROFILE driven through PedalPhysics', () => {
  function drive(p: TeslaParams): { at: (t: number) => number; trace: { t: number; v: number; a: number; th: number; br: number }[] } {
    const d = new DemoDriver();
    const ph = new PedalPhysics();
    ph.configure(p);
    const pedal: PedalCommand = { throttle: 0, brake: 0 };
    const trace: { t: number; v: number; a: number; th: number; br: number }[] = [];
    for (let k = 0; k * DT < LOOP_S; k++) {
      d.step(DT, pedal);
      ph.step(pedal.throttle, pedal.brake, DT);
      trace.push({ t: (k + 1) * DT, v: ph.v, a: ph.a, th: pedal.throttle, br: pedal.brake });
    }
    const at = (t: number): number => trace[Math.min(trace.length - 1, Math.round(t / DT) - 1)]?.v ?? Number.NaN;
    return { at, trace };
  }

  it('mid-size car: ≈ 50 km/h after the pull-away, ≈ 140 km/h after WOT, then stops before the loop ends', () => {
    const { at, trace } = drive(MID_TESLA);
    expect(at(3)).toBe(0);
    expect(at(13) / KMH).toBeGreaterThan(45);
    expect(at(13) / KMH).toBeLessThan(60);
    expect(at(19.5) / KMH).toBeGreaterThan(130);
    expect(at(19.5) / KMH).toBeLessThan(155);
    expect(at(33) / KMH).toBeGreaterThan(130); // cruise holds speed
    expect(at(41)).toBeLessThan(at(33)); // lift-off decelerates
    expect(at(41)).toBeGreaterThan(25);
    for (const s of trace) {
      if (s.t > 34.5 && s.t < 41) expect(rawLoad(MID_TESLA, s.v, s.a)).toBeLessThan(-0.2); // overrun
    }
    for (const s of trace) if (s.t >= 56.5) expect(s.v).toBe(0);
    for (const s of trace) {
      if (s.br === 0 && s.v > 1) expect(Math.abs(rawLoad(MID_TESLA, s.v, s.a) - s.th)).toBeLessThan(0.01);
    }
  });

  it.each([
    ['quickest', QUICK],
    ['heaviest', HEAVY],
    ['heavy in Chill', CHILL],
  ] as const)('%s car: moving after the pull-away, stationary from 56.5 s to the loop end', (_n, p) => {
    const { at, trace } = drive(p);
    expect(at(13)).toBeGreaterThan(5);
    for (const s of trace) {
      expect(s.v).toBeGreaterThanOrEqual(0);
      if (s.t >= 56.5) expect(s.v).toBe(0);
    }
  });
});
