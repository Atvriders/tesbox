import { describe, expect, it } from 'vitest';
import type { Driveline, EngineSpec, EngineVoicing } from '../../src/contracts';
import { DrivelineModel, RPM_SLEW_RPM_PER_S } from '../../src/sim/driveline';
import { rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';
import {
  DCT7_SPEC,
  DCT7_VOICING,
  DT,
  MANUAL6_SPEC,
  MANUAL6_VOICING,
  TC8_SPEC,
  TC8_VOICING,
} from '../helpers/sim-fixtures';

const MAX_STEP = RPM_SLEW_RPM_PER_S * DT; // 48 rpm per quantum at 48 kHz

function make(spec: EngineSpec, voicing: EngineVoicing, warm = true, seed = 1): DrivelineModel {
  const d = new DrivelineModel();
  d.configure(spec, voicing, seed);
  d.setWarm(warm);
  return d;
}

interface In {
  rw: number;
  load?: number;
  gear?: number;
  standstill?: boolean;
  runTimeS?: number;
}

function stepAt(d: DrivelineModel, t: number, i: In): void {
  d.step(t, DT, i.rw, i.load ?? 0, i.gear ?? 1, i.standstill ?? false, i.runTimeS ?? 100);
}

/** Records rpm/state per quantum and asserts the 50-rpm continuity rule (gear changes while moving excepted). */
class Probe {
  readonly rpm: number[] = [];
  readonly states: Driveline[] = [];
  private prevRpm = Number.NaN;
  private prevGear = Number.NaN;

  constructor(private readonly d: DrivelineModel) {}

  step(t: number, i: In): void {
    stepAt(this.d, t, i);
    const r = this.d.rpm;
    const gear = i.gear ?? 1;
    const shift = gear !== this.prevGear && gear >= 1 && this.prevGear >= 1 && !(i.standstill ?? false);
    if (this.prevRpm === this.prevRpm && !shift) {
      expect(Math.abs(r - this.prevRpm), `t=${t.toFixed(4)}`).toBeLessThanOrEqual(50);
    }
    expect(Number.isFinite(r)).toBe(true);
    this.prevRpm = r;
    this.prevGear = gear;
    this.rpm.push(r);
    const last = this.states[this.states.length - 1];
    if (last !== this.d.state) this.states.push(this.d.state);
  }
}

describe('DrivelineModel — idle', () => {
  it('idles at spec idle ± 20 rpm with a deterministic wander', () => {
    const a = make(DCT7_SPEC, DCT7_VOICING);
    const b = make(DCT7_SPEC, DCT7_VOICING);
    const c = make(DCT7_SPEC, DCT7_VOICING, true, 99);
    let min = Infinity;
    let max = -Infinity;
    let differs = false;
    for (let k = 0; k < 7500; k++) {
      const t = k * DT; // 20 s
      for (const d of [a, b, c]) stepAt(d, t, { rw: 0, standstill: true });
      expect(a.rpm).toBe(b.rpm);
      if (a.rpm !== c.rpm) differs = true;
      expect(a.state).toBe('clutch-open');
      min = Math.min(min, a.rpm);
      max = Math.max(max, a.rpm);
    }
    expect(min).toBeGreaterThanOrEqual(800 - 20);
    expect(max).toBeLessThanOrEqual(800 + 20);
    expect(max - min).toBeGreaterThan(10);
    expect(differs).toBe(true);
  });

  it('cold idle: +300 rpm until 45 s, linear to 0 at 60 s; none when warm', () => {
    const cold = make(DCT7_SPEC, DCT7_VOICING, false);
    const warm = make(DCT7_SPEC, DCT7_VOICING, true);
    const p = new Probe(cold);
    const at: Record<string, number> = {};
    for (let k = 0; k * DT < 62; k++) {
      const t = k * DT;
      p.step(t, { rw: 0, standstill: true, runTimeS: t });
      stepAt(warm, t, { rw: 0, standstill: true, runTimeS: t });
      for (const mark of [10, 44, 52.5, 61]) if (at[mark] === undefined && t >= mark) at[mark] = cold.rpm;
      if (t >= 10 && t < 10 + DT) expect(Math.abs(warm.rpm - 800)).toBeLessThanOrEqual(20);
    }
    expect(Math.abs((at[10] ?? 0) - 1100)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[44] ?? 0) - 1100)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[52.5] ?? 0) - 950)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[61] ?? 0) - 800)).toBeLessThanOrEqual(20);
  });

  it('gear 0 is neutral: clutch open at idle whatever the wheels and load do', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    for (let k = 0; k < 400; k++) stepAt(d, k * DT, { rw: 3000, load: 1, gear: 0 });
    expect(d.state).toBe('clutch-open');
    expect(Math.abs(d.rpm - 800)).toBeLessThanOrEqual(20);
  });
});

describe('DrivelineModel — clutch types', () => {
  it('opens below 1.05·idle and re-engages above 1.15·idle, continuously', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    let openedAt = Number.NaN;
    let closedAt = Number.NaN;
    for (let rw = 1500; rw > 500; rw -= 1) {
      p.step(t, { rw, gear: 2 });
      if (d.state === 'clutch-open' && openedAt !== openedAt) openedAt = rw;
      if (d.state === 'engaged' && rw < 1400) expect(d.rpm).toBeCloseTo(rw, 6);
      t += DT;
    }
    for (let rw = 500; rw < 1500; rw += 1) {
      p.step(t, { rw, gear: 2 });
      if (d.state === 'engaged' && closedAt !== closedAt) closedAt = rw;
      t += DT;
    }
    expect(openedAt).toBeLessThan(1.05 * 800);
    expect(openedAt).toBeGreaterThanOrEqual(1.05 * 800 - 1);
    expect(closedAt).toBeGreaterThan(1.15 * 800);
    expect(closedAt).toBeLessThanOrEqual(1.15 * 800 + 1);
    expect(p.states).toEqual(['engaged', 'clutch-open', 'engaged']);
    expect(d.rpm).toBeCloseTo(1499, 6);
  });

  it('launch flare: idle + load·(launchRpm − idle), flat to 0.5 s, tapering to idle at 1.0 s, never forcing lock', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 1; t += DT) p.step(t, { rw: 0, standstill: true });
    const t0 = t; // first quantum with load > 0.1
    const flare = 800 + 0.6 * (3150 - 800); // 2210 (± wander·0.4)
    const sample: Record<string, number> = {};
    for (; t < t0 + 3; t += DT) {
      p.step(t, { rw: 0, load: 0.6, standstill: true });
      for (const m of [0.4, 0.75, 1.2, 2.9]) if (sample[m] === undefined && t - t0 >= m) sample[m] = d.rpm;
      if (t - t0 < 1) expect(d.state).toBe('slipping');
    }
    expect(Math.abs((sample[0.4] ?? 0) - flare)).toBeLessThanOrEqual(10);
    expect(Math.abs((sample[0.75] ?? 0) - (800 + 0.6 * 2350 * 0.5))).toBeLessThanOrEqual(15);
    expect(Math.abs((sample[1.2] ?? 0) - 800)).toBeLessThanOrEqual(20);
    expect(Math.abs((sample[2.9] ?? 0) - 800)).toBeLessThanOrEqual(20); // holding the load does not re-flare
    expect(p.states).toEqual(['clutch-open', 'slipping', 'clutch-open']);
    // lift, then press again → a new launch
    for (let k = 0; k < 20; k++, t += DT) p.step(t, { rw: 0, load: 0, standstill: true });
    for (let k = 0; k < 150; k++, t += DT) p.step(t, { rw: 0, load: 0.6, standstill: true });
    expect(d.state).toBe('slipping');
    expect(d.rpm).toBeGreaterThan(2000);
  });

  it('launch locks once the wheels catch up: rw ≥ max(1.05·idle, slip − 50)', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.5; t += DT) p.step(t, { rw: 0, standstill: true });
    const t0 = t;
    let lockedAt = Number.NaN;
    for (; t < t0 + 2; t += DT) {
      const rw = 1000 * (t - t0); // wheels accelerate at 1000 rpm/s
      p.step(t, { rw, load: 0.5, standstill: rw < 100 });
      if (d.state === 'engaged' && lockedAt !== lockedAt) {
        lockedAt = t - t0;
        expect(Math.abs(d.rpm - rw)).toBeLessThanOrEqual(50); // the last ≤ 50 rpm of slip closes via the slew
      }
      if (t - t0 > lockedAt + 4 * DT) expect(d.rpm).toBeCloseTo(rw, 6); // then rpm = rpmWheel
    }
    // slip(t) = 800 + 0.5·2350·(1 − t)/0.5 in the taper → lock where 1000·t = slip − 50 ⇒ t ≈ 0.925 s
    expect(lockedAt).toBeGreaterThan(0.9);
    expect(lockedAt).toBeLessThan(0.95);
    expect(p.states).toEqual(['clutch-open', 'slipping', 'engaged']);
  });

  it('a gear change while moving snaps to the new wheel rpm; a gear change at standstill slews', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    let t = 0;
    for (let k = 0; k < 10; k++, t += DT) stepAt(d, t, { rw: 5000, gear: 2, load: 0.5 });
    expect(d.state).toBe('engaged');
    expect(d.rpm).toBe(5000);
    stepAt(d, t, { rw: (5000 * 6.1) / 8.6, gear: 3, load: 0.5 });
    t += DT;
    expect(d.rpm).toBeCloseTo((5000 * 6.1) / 8.6, 9); // snapped (≈ 3547)
    for (let k = 0; k < 10; k++, t += DT) stepAt(d, t, { rw: 3000, gear: 3 });
    const before = d.rpm;
    stepAt(d, t, { rw: 0, gear: 1, standstill: true }); // standstill → gear 1 is not a shift
    expect(before - d.rpm).toBeCloseTo(MAX_STEP, 9);
    expect(d.state).toBe('clutch-open');
  });

  it('manual gearbox uses the same clutch model (NA launchRpm 0.55·redline)', () => {
    const d = make(MANUAL6_SPEC, MANUAL6_VOICING);
    let t = 0;
    for (; t < 0.5; t += DT) stepAt(d, t, { rw: 0, standstill: true });
    for (let k = 0; k < 120; k++, t += DT) stepAt(d, t, { rw: 0, load: 1, standstill: true });
    expect(d.state).toBe('slipping');
    expect(Math.abs(d.rpm - 4125)).toBeLessThanOrEqual(5); // 750 + 1·(4125 − 750) (wander × 0)
  });
});

describe('DrivelineModel — torque converter', () => {
  // TC8: idle 650, stallRpmWot 2600, lockupTurbineRpm 1300, couplingSR 0.88
  const unlocked = (rw: number, load: number, idle: number): number => {
    const l = Math.min(1, Math.max(0, load));
    const sr = 0.97 + (0.88 - 0.97) * l;
    const stall = idle + (2600 - idle) * l;
    return Math.pow(Math.pow(rw / sr, 4) + Math.pow(stall, 4), 0.25);
  };

  it('stalls at idle with no load and at stallRpmWot at full load (tc-stall)', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.5; t += DT) p.step(t, { rw: 0, standstill: true });
    expect(Math.abs(d.rpm - 650)).toBeLessThanOrEqual(20);
    expect(d.state).toBe('tc-stall');
    for (const end = t + 1; t < end; t += DT) p.step(t, { rw: 0, load: 1, standstill: true });
    expect(d.rpm).toBeCloseTo(2600, 6);
    expect(d.state).toBe('tc-stall');
  });

  it('follows ((rw/SR)^4 + stall^4)^(1/4) unlocked, reporting slipping once the pump outruns stall; no lock-up in 1st', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.3; t += DT) p.step(t, { rw: 0, load: 0.5, standstill: true });
    for (let rw = 0; rw < 3000; rw += 1.5, t += DT) {
      p.step(t, { rw, load: 0.5 });
      // wander moves stall by ≤ 0.5·20 rpm, the smooth max by no more than that
      expect(Math.abs(d.rpm - unlocked(rw, 0.5, 650))).toBeLessThanOrEqual(10.5);
      const pumpAboveStall = rw / 0.925 > 1625 + 10;
      const pumpBelowStall = rw / 0.925 < 1625 - 10;
      if (pumpAboveStall) expect(d.state).toBe('slipping');
      if (pumpBelowStall) expect(d.state).toBe('tc-stall');
    }
    expect(p.states).toEqual(['tc-stall', 'slipping']);
  });

  it('locks up in ≥ 2nd above lockupTurbineRpm at load < 0.9, slip ramping to zero over 0.4 s', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    const u = unlocked(2000, 0.3, 650); // ≈ 2179
    let mid = Number.NaN;
    for (let k = 0; k * DT < 0.6; k++, t += DT) {
      p.step(t, { rw: 2000, load: 0.3, gear: 2 });
      expect(d.state).toBe('engaged');
      if (mid !== mid && (k + 1) * DT >= 0.2) mid = d.rpm;
    }
    expect(Math.abs(mid - (u + 2000) / 2)).toBeLessThanOrEqual(5);
    expect(d.rpm).toBeCloseTo(2000, 9);
  });

  it('unlocks on kickdown (load > 0.9) and below lockupTurbineRpm − 200, ramping back over 0.4 s', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.6; t += DT) p.step(t, { rw: 2000, load: 0.3, gear: 2 });
    expect(d.rpm).toBeCloseTo(2000, 9);
    // kickdown load
    for (let k = 0; k * DT < 0.6; k++, t += DT) {
      p.step(t, { rw: 2000, load: 0.95, gear: 2 });
      expect(d.state).not.toBe('engaged');
    }
    expect(Math.abs(d.rpm - unlocked(2000, 0.95, 650))).toBeLessThanOrEqual(2);
    // back to part load → locks again
    for (let k = 0; k * DT < 0.6; k++, t += DT) p.step(t, { rw: 2000, load: 0.3, gear: 2 });
    expect(d.state).toBe('engaged');
    // turbine rpm hysteresis: stays locked down to 1100, unlocks below
    for (let rw = 2000; rw > 900; rw -= 1, t += DT) {
      p.step(t, { rw, load: 0.3, gear: 2 });
      if (rw > 1101) expect(d.state).toBe('engaged');
      if (rw < 1099) expect(d.state).not.toBe('engaged');
    }
  });
});

describe('DrivelineModel — robustness', () => {
  it('requires tc data for a tc-auto gearbox', () => {
    const bad: EngineSpec = { ...TC8_SPEC, gearbox: { ...TC8_SPEC.gearbox, tc: null } };
    expect(() => new DrivelineModel().configure(bad, TC8_VOICING)).toThrow(Error);
    // a rejected configure leaves an already configured model untouched (still a DCT, not half a converter)
    const d = make(DCT7_SPEC, DCT7_VOICING);
    expect(() => d.configure(bad, TC8_VOICING)).toThrow(Error);
    for (let k = 0; k < 10; k++) stepAt(d, k * DT, { rw: 2000, gear: 2, load: 0.3 });
    expect(d.state).toBe('engaged');
    expect(d.rpm).toBe(2000);
  });

  it('non-finite inputs never produce a non-finite rpm', () => {
    for (const [spec, voicing] of [
      [DCT7_SPEC, DCT7_VOICING],
      [TC8_SPEC, TC8_VOICING],
    ] as const) {
      const d = make(spec, voicing, false);
      d.step(0, DT, Number.NaN, Number.NaN, 2, false, Number.NaN);
      d.step(Number.NaN, Number.NaN, Infinity, -Infinity, 3, false, 5);
      d.step(DT, DT, 1500, Number.NaN, 2, false, -1);
      expect(Number.isFinite(d.rpm)).toBe(true);
      // each sequence on a fresh model, [nowS, rpmWheel, load, gear] per step (standstill while rpmWheel = 0)
      const sequences: [number, number, number, number][][] = [
        [[0, 0, Infinity, 1]], // infinite load on the first step (which snaps to its target)
        [[0, 0, 0, 1], [Number.NaN, 0, 0.5, 1], [DT, 0, 0.5, 1]], // a launch starting at an unknown time
        [[0, 0, 0, 0], [Infinity, 0, 0, 0], [-Infinity, 0, 0, 1]], // a non-finite clock
        [[0, 0, 0, 1], [DT, 0, Infinity, 1], [1.5, 1500, Infinity, 1]], // infinite load after the taper
      ];
      for (const seq of sequences) {
        const e = make(spec, voicing, false);
        for (const [now, rw, load, gear] of seq) {
          e.step(now, DT, rw, load, gear, rw === 0, 5);
          expect(Number.isFinite(e.rpm), `${spec.gearbox.type} nowS=${now} load=${load}`).toBe(true);
        }
      }
    }
  });

  it('reset() returns to idle with the clutch open and keeps the warm flag', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING, true);
    for (let k = 0; k < 100; k++) stepAt(d, k * DT, { rw: 4000, gear: 3, load: 0.5, runTimeS: 1 });
    expect(d.state).toBe('engaged');
    d.reset();
    expect(d.state).toBe('clutch-open');
    expect(d.rpm).toBe(800);
    stepAt(d, 1, { rw: 0, standstill: true, runTimeS: 1 });
    expect(Math.abs(d.rpm - 800)).toBeLessThanOrEqual(20); // warm: no cold idle
  });

  it.each([
    ['DCT7', DCT7_SPEC, DCT7_VOICING],
    ['TC8', TC8_SPEC, TC8_VOICING],
    ['MANUAL6', MANUAL6_SPEC, MANUAL6_VOICING],
  ] as const)('%s: stop-go drive is continuous (≤ 50 rpm/quantum except shifts) and never below idle', (_n, spec, voicing) => {
    const d = make(spec, voicing, false);
    const p = new Probe(d);
    const c = rollingCircumferenceM(spec.gearbox.drivenTyre);
    const ratios = spec.gearbox.overallRatios;
    const top = ratios.length;
    let gear = 1;
    let v = 0;
    let t = 0;
    const rwOf = (g: number): number => wheelRpm(v, ratios[g - 1] ?? 0, c);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let k = 0; k * DT < 2; k++, t += DT) p.step(t, { rw: 0, standstill: true, runTimeS: t });
      for (let k = 0; k * DT < 15; k++, t += DT) {
        v += 3 * DT;
        if (gear < top && rwOf(gear) > 0.8 * spec.rpm.redline) gear++;
        p.step(t, { rw: rwOf(gear), load: 0.7, gear, runTimeS: t });
      }
      for (; v > 0; t += DT) {
        v = Math.max(0, v - 2.5 * DT);
        if (gear > 1 && rwOf(gear) < 1.3 * spec.rpm.idle) gear--;
        const standstill = v < 0.3;
        if (standstill) gear = 1;
        p.step(t, { rw: rwOf(gear), load: -0.4, gear, standstill, runTimeS: t });
      }
    }
    const floor = spec.rpm.idle - 20 - 1e-9;
    for (const r of p.rpm) expect(r).toBeGreaterThanOrEqual(floor);
  });
});
