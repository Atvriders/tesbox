import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING, F } from '../../src/contracts';
import type { DriveMode, Driveline, EngineDef, EngineSpec, EngineVoicing, FixMsg, InputMsg, SpeedSourceKind } from '../../src/contracts';
import { DEMO_PROFILE } from '../../src/sim/demo';
import { ReplayFeeder } from '../../src/sim/replay';
import { TesboxSimCore } from '../../src/sim/sim-core';
import { rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';
import { loadTrace } from '../helpers/replay-harness';
import {
  DCT7_SPEC,
  DCT7_VOICING,
  DT,
  MANUAL6_SPEC,
  MANUAL6_VOICING,
  MID_TESLA,
  TC8_SPEC,
  TC8_VOICING,
  speedFor,
} from '../helpers/sim-fixtures';

const LOOP_S = DEMO_PROFILE[DEMO_PROFILE.length - 1]?.t ?? 0;

/** Real engines present when the suite runs (the sweep below adds 2 tests per engine JSON found). */
const ENGINE_JSON = import.meta.glob<EngineDef>('../../src/data/engines/*.json', { eager: true, import: 'default' });
const CATALOGUE = Object.values(ENGINE_JSON).map((d) => [d.id, d] as const);

interface Rec {
  t: number;
  rpm: number;
  gear: number;
  /** Gear of the previous record (0 for the first). */
  prevGear: number;
  v: number;
  load: number;
  /**
   * (out.load − previous out.load) / DT: the LoadEstimator's loadRate whenever both loads are outside the
   * ±0.03 deadband and not in the hidden hold — always the case where the A4 trigger (load > 0.6) holds.
   */
  dLoad: number;
  flags: number;
  limiter: boolean;
  driveline: Driveline;
  shiftStart: boolean;
  shiftActive: boolean;
  shiftUp: boolean;
  fromRpm: number;
  toRpm: number;
  ignitionOn: boolean;
  runTimeS: number;
}

/** Steps a TesboxSimCore per 128-frame quantum, feeding replay fixes, and records every output. */
class Harness {
  readonly core = new TesboxSimCore();
  readonly recs: Rec[] = [];
  t = 0;
  private feeder: ReplayFeeder | null = null;
  private feeding = true;
  private readonly fix: FixMsg = { type: 'fix', ageS: 0, speedMps: null, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };

  constructor(spec: EngineSpec = DCT7_SPEC, voicing: EngineVoicing = DCT7_VOICING, source: SpeedSourceKind = 'demo', warm = true) {
    this.core.configure(spec, voicing, MID_TESLA, DEFAULT_SIM_TUNING);
    this.core.setWarm(warm);
    this.core.setSource(source);
  }

  replay(name: string): this {
    this.feeder = new ReplayFeeder(loadTrace(name));
    return this;
  }

  /** Pause/resume fix delivery (the main thread gets no geolocation while hidden). */
  setFeeding(on: boolean): void {
    this.feeding = on;
  }

  input(msg: InputMsg): void {
    this.core.pushInput(msg, this.t);
  }

  /** Runs for `seconds`; returns the records produced. */
  run(seconds: number): Rec[] {
    const start = this.recs.length;
    const end = this.t + seconds - DT / 2;
    const o = this.core.out;
    while (this.t < end) {
      if (this.feeder !== null) {
        while (this.feeder.next(this.t, this.fix)) if (this.feeding) this.core.pushFix(this.fix, this.t);
      }
      const prev = this.recs[this.recs.length - 1];
      this.core.step(this.t, DT);
      this.recs.push({
        t: this.t,
        rpm: o.rpm,
        gear: o.gear,
        prevGear: prev?.gear ?? 0,
        v: o.speedMps,
        load: o.load,
        dLoad: (o.load - (prev?.load ?? 0)) / DT,
        flags: o.flags,
        limiter: o.limiter,
        driveline: o.driveline,
        shiftStart: o.shift.active && o.shift.t0 === this.t,
        shiftActive: o.shift.active,
        shiftUp: o.shift.up,
        fromRpm: o.shift.fromRpm,
        toRpm: o.shift.toRpm,
        ignitionOn: o.ignitionOn,
        runTimeS: o.runTimeS,
      });
      this.t += DT;
    }
    return this.recs.slice(start);
  }

  /** First record at or after time t. */
  at(t: number): Rec {
    const r = this.recs.find((x) => x.t >= t - 1e-9);
    if (r === undefined) throw new Error(`no record at ${t}`);
    return r;
  }

  between(t0: number, t1: number): Rec[] {
    return this.recs.filter((r) => r.t >= t0 && r.t < t1);
  }
}

/**
 * RF5 / continuity rule: |Δ out.rpm| ≤ 50 per quantum except on the quantum a shift starts, and a shift
 * start may move the rpm only in the shift's physical direction (an upshift never raises it, a downshift
 * never lowers it — beyond one slew step). Returns the number of excepted quanta (= shift starts).
 *
 * The contract also excepts the limiter clamp, but SimCore clamps the continuity-limited rpm (PC11) and
 * out.rpm is never above limiter.rpm, so the clamp moves it by at most one slew step: limiter quanta get
 * no exception here — entering or leaving the limiter without a shift start must be continuous too.
 */
function expectContinuous(recs: readonly Rec[]): number {
  let excepted = 0;
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1];
    const b = recs[i];
    if (a === undefined || b === undefined) continue;
    if (b.shiftStart) {
      expect(b.shiftUp ? b.toRpm <= b.fromRpm + 50 : b.toRpm >= b.fromRpm - 50, `shift direction at t=${b.t.toFixed(4)}`).toBe(true);
      excepted++;
      continue;
    }
    expect(Math.abs(b.rpm - a.rpm), `t=${b.t.toFixed(4)} ${a.rpm.toFixed(1)}→${b.rpm.toFixed(1)}`).toBeLessThanOrEqual(50);
  }
  return excepted;
}

const has = (r: Rec, bit: number): boolean => (r.flags & bit) !== 0;

/**
 * Contract A10: a kickdown is identified by the A4 trigger on the step the downshift starts
 * (load > 0.6 && loadRate > 1.2; out.load is the load the gearbox saw), not by the load-map classifier.
 */
const isKickdown = (r: Rec): boolean => r.shiftStart && !r.shiftUp && r.load > 0.6 && r.dLoad > 1.2;

describe('TesboxSimCore — lifecycle', () => {
  it('step() before configure() is a no-op; an ignition received before configure() cranks from the first configured step', () => {
    const core = new TesboxSimCore();
    core.pushInput({ type: 'ignition', on: true }, 0);
    core.step(0, DT);
    core.step(DT, DT);
    expect(core.out.rpm).toBe(0);
    expect(core.out.gear).toBe(0);
    expect(core.out.flags).toBe(0);
    // configure() arrives 3 s after the ignition message — longer than the whole crank. The crank is not
    // skipped: its clock starts at the first configured step, and out.rpm never jumps.
    const t0 = 3;
    core.configure(DCT7_SPEC, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING);
    core.setWarm(true);
    const recs: { t: number; rpm: number; gear: number; ignitionOn: boolean; runTimeS: number }[] = [];
    for (let k = 0; k < Math.round(4 / DT); k++) {
      const t = t0 + k * DT;
      core.step(t, DT);
      const o = core.out;
      recs.push({ t, rpm: o.rpm, gear: o.gear, ignitionOn: o.ignitionOn, runTimeS: o.runTimeS });
    }
    const at = (dt: number): number => recs.find((r) => r.t >= t0 + dt - 1e-9)?.rpm ?? Number.NaN;
    expect(recs[0]?.rpm, 'the first configured step starts the crank at 0 rpm').toBe(0);
    expect(recs[0]?.runTimeS, 'runTimeS counts from the first configured step').toBe(0);
    expect(Math.abs(at(0.3) - 125)).toBeLessThanOrEqual(2);
    expect(Math.abs(at(0.6) - 250)).toBeLessThanOrEqual(3);
    expect(Math.abs(at(1.0) - 1600)).toBeLessThanOrEqual(25);
    expect(Math.abs(at(3.5) - 800)).toBeLessThanOrEqual(25);
    for (const r of recs) {
      expect(r.ignitionOn).toBe(true);
      expect(r.runTimeS).toBeCloseTo(r.t - t0, 9);
      expect(r.gear).toBe(r.t - t0 < 2.5 - 1e-9 ? 0 : 1);
    }
    for (let i = 1; i < recs.length; i++) {
      expect(Math.abs((recs[i]?.rpm ?? 0) - (recs[i - 1]?.rpm ?? 0))).toBeLessThanOrEqual(50);
    }
  });

  it('a repeated ignition message changes nothing: on while cranking or running, off while stopping', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    const control = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    const both = (f: (x: Harness) => void): void => {
      f(h);
      f(control);
    };
    both((x) => x.input({ type: 'ignition', on: true }));
    both((x) => x.run(1));
    h.input({ type: 'ignition', on: true }); // mid-crank (flare)
    both((x) => x.run(13.5));
    expect(control.recs[control.recs.length - 1]?.gear).toBeGreaterThanOrEqual(3); // WOT pull, in gear at speed
    h.input({ type: 'ignition', on: true }); // running
    both((x) => x.run(2));
    both((x) => x.input({ type: 'ignition', on: false }));
    both((x) => x.run(0.4));
    h.input({ type: 'ignition', on: false }); // mid-decay
    both((x) => x.run(1));
    expect(h.recs.length).toBe(control.recs.length);
    const diverged = h.recs.findIndex((r, i) => (Object.keys(r) as (keyof Rec)[]).some((k) => !Object.is(r[k], control.recs[i]?.[k])));
    expect(diverged, `first divergence at t=${h.recs[diverged]?.t.toFixed(4)}`).toBe(-1);
    expect(h.recs[h.recs.length - 1]?.rpm).toBe(0);
  });

  it('before ignition: rpm 0, gear 0, clutch open; GPS flags pass through', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'gps');
    const recs = h.run(1);
    for (const r of recs) {
      expect(r.rpm).toBe(0);
      expect(r.gear).toBe(0);
      expect(r.ignitionOn).toBe(false);
      expect(r.runTimeS).toBe(0);
      expect(r.flags & (F.GPS_LOST | F.STANDSTILL | F.CLUTCH_OPEN)).toBe(F.GPS_LOST | F.STANDSTILL | F.CLUTCH_OPEN);
    }
  });

  it.each([
    ['warm', true, 800],
    ['cold', false, 1100],
  ] as const)('ignition on (%s): crank 0→250 rpm by 0.6 s, flare to idle + 800 at 1.0 s, settle to idle, gear 1 after 2.5 s', (_n, warm, idle) => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'gps', warm);
    h.run(0.5);
    const tOn = h.t;
    h.input({ type: 'ignition', on: true });
    const recs = h.run(4);
    expect(Math.abs(h.at(tOn + 0.3).rpm - 125)).toBeLessThanOrEqual(2); // first quantum at/after the mark
    expect(Math.abs(h.at(tOn + 0.6).rpm - 250)).toBeLessThanOrEqual(3);
    expect(Math.abs(h.at(tOn + 1.0).rpm - (idle + 800))).toBeLessThanOrEqual(25);
    expect(h.at(tOn + 1.75).rpm).toBeGreaterThan(idle + 200);
    expect(Math.abs(h.at(tOn + 2.49).rpm - idle)).toBeLessThanOrEqual(25);
    expect(Math.abs(h.at(tOn + 3.5).rpm - idle)).toBeLessThanOrEqual(25);
    for (const r of recs) {
      expect(r.ignitionOn).toBe(true);
      expect(r.runTimeS).toBeCloseTo(r.t - tOn, 9);
      expect(r.gear).toBe(r.t - tOn < 2.5 - 1e-9 ? 0 : 1);
      expect(r.driveline).toBe('clutch-open');
      expect(r.limiter).toBe(false);
    }
    expect(expectContinuous(recs)).toBe(0);
  });

  it('a shift request during the crank is dropped, not applied when the engine starts running (restart while rolling)', () => {
    // Rolling (demo source keeps driving with the engine off) and Manual: at the first running step the
    // gearbox is stepped without standstill, so a request queued during the crank would upshift to 2nd.
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(10);
    h.input({ type: 'ignition', on: false });
    h.run(1.5);
    h.input({ type: 'ignition', on: true });
    h.run(1);
    h.input({ type: 'shiftUp' }); // mid-crank
    const restart = h.run(1.6);
    const first = restart.find((r) => r.runTimeS >= 2.5 - 1e-9); // first running step
    expect(first?.v).toBeGreaterThan(5);
    expect(first?.gear).toBe(1);
  });

  it('ignition off: gear 0 at once, rpm decays smoothly to 0 over 1.0 s', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(16); // demo pull-away: engaged at speed
    const r0 = h.recs[h.recs.length - 1]?.rpm ?? 0;
    expect(r0).toBeGreaterThan(1500);
    const tOff = h.t;
    h.input({ type: 'ignition', on: false });
    const recs = h.run(1.5);
    for (const r of recs) {
      expect(r.gear).toBe(0);
      expect(r.ignitionOn).toBe(false);
      expect(r.limiter).toBe(false);
      expect(r.flags & F.SHIFTING).toBe(0);
    }
    for (let i = 1; i < recs.length; i++) expect(recs[i]?.rpm ?? 0).toBeLessThanOrEqual(recs[i - 1]?.rpm ?? 0);
    expect(h.at(tOff + 0.5).rpm).toBeCloseTo(r0 / 2, -2);
    expect(h.at(tOff + 1.0).rpm).toBe(0);
    expect(h.at(tOff + 1.4).rpm).toBe(0);
    expect(expectContinuous(recs)).toBe(0);
    // restart while still rolling: neutral during the crank, then gear 1 → the box upshifts as needed
    // (when 1st turns ≥ redline: one over-speed upshift straight to the map gear, Task 5)
    h.input({ type: 'ignition', on: true });
    const restart = h.run(4);
    const firstRunning = restart.find((r) => r.runTimeS >= 2.5 - 1e-9);
    expect(firstRunning?.gear === 1 || (firstRunning?.shiftStart === true && firstRunning.gear > 1)).toBe(true);
    for (const r of restart) {
      if (r.runTimeS < 2.5 - 1e-9) expect(r.gear).toBe(0);
      else expect(r.gear).toBeGreaterThanOrEqual(1);
    }
    expect(restart[restart.length - 1]?.gear).toBeGreaterThan(1);
  });
});

describe('TesboxSimCore — demo source over DEMO_PROFILE', () => {
  it('DCT7 Auto Comfort: launch → part-load upshifts → WOT pull → cruise in top → overrun → coast-down → stop, continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);

    // idle in gear 1 at rest once cranked
    for (const r of h.between(2.6, 3.0)) {
      expect(r.gear).toBe(1);
      expect(has(r, F.STANDSTILL) && has(r, F.CLUTCH_OPEN)).toBe(true);
      expect(Math.abs(r.rpm - 800)).toBeLessThanOrEqual(20);
    }
    // launch: slipping then engaged
    const pull = h.between(3.0, 13);
    expect(pull.some((r) => r.driveline === 'slipping')).toBe(true);
    expect(h.at(13).driveline).toBe('engaged');
    expect(h.at(13).gear).toBeGreaterThanOrEqual(3);
    // WOT tip-in (contract A10): ONE downshift, the A4 kickdown 4→3 at ≈ 13.45 s. The A10b hold keeps the
    // load-map downshift back while the load rises at kickdown pace, so no map downshift precedes it and
    // the A10a latch allows no second kickdown. Measured: see the 'DCT7 Auto … WOT tip-in' test below.
    const tipDowns = h.between(13.3, 14).filter((r) => r.shiftStart && !r.shiftUp);
    expect(tipDowns.length).toBe(1);
    const kd = tipDowns[0];
    expect(kd !== undefined && isKickdown(kd)).toBe(true);
    expect(kd?.prevGear).toBe(4);
    expect(kd?.gear).toBe(3);
    expect(kd?.t).toBeCloseTo(13.45, 1);
    // WOT: upshifts at 0.9·redline (comfort), never the limiter
    const wot = h.between(13.5, 19.6);
    const wotUps = wot.filter((r) => r.shiftStart && r.shiftUp);
    expect(wotUps.length).toBeGreaterThanOrEqual(1);
    for (const r of wotUps) expect(r.fromRpm).toBeGreaterThan(0.89 * 7000);
    expect(Math.max(...wot.map((r) => r.rpm))).toBeLessThan(0.9 * 7000 + 20);
    expect(h.at(19.5).gear).toBeGreaterThan(h.at(13.5).gear - 2);
    // cruise: settles in top gear at low part-load rpm
    const cruise = h.at(32);
    expect(cruise.gear).toBe(7);
    expect(cruise.load).toBeCloseTo(0.15, 1);
    expect(cruise.rpm).toBeCloseTo(wheelRpm(cruise.v, 2.7, c), -1);
    // lift-off with regen: OVERRUN while engaged above fuelCutResumeRpm
    const lift = h.between(35, 41);
    expect(lift.filter((r) => has(r, F.OVERRUN)).length).toBeGreaterThan(lift.length * 0.9);
    // braking: one-gear coast downshifts, clutch opens near the stop, standstill → gear 1
    const brake = h.between(42, LOOP_S);
    const downs = brake.filter((r) => r.shiftStart);
    for (const r of downs) expect(r.shiftUp).toBe(false);
    expect(downs.length).toBeGreaterThanOrEqual(4);
    expect(brake.some((r) => has(r, F.CLUTCH_OPEN) && !has(r, F.STANDSTILL))).toBe(true);
    for (const r of h.between(57, LOOP_S)) {
      expect(r.gear).toBe(1);
      expect(r.v).toBe(0);
      expect(Math.abs(r.rpm - 800)).toBeLessThanOrEqual(20);
    }
    // global invariants
    for (const r of recs) {
      expect(r.limiter).toBe(false);
      expect(Number.isFinite(r.rpm)).toBe(true);
      expect(has(r, F.SHIFTING)).toBe(r.shiftActive);
      if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(780 - 1e-9); // never stalls
    }
    expect(expectContinuous(recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });

  /*
   * Contract A10, measured through this SimCore (DCT7, MID_TESLA, demo source, 48 kHz quanta):
   * - Comfort: 1→2 5.94 s, 2→3 7.54 s, 3→4 9.14 s; tip-in: the A4 kickdown 4→3 at 13.4507 s (load 0.6003,
   *   loadRate 1.575, 16.05 m/s, 2271 → 2951 rpm) — from 13.432 s the 4th-gear rpm was already below the
   *   map's downshift point (2256 < 2280) but A10b held that downshift while the load rose; WOT: 3→4 at
   *   17.55 s from 6299 rpm; throttle lift: 4→5 19.77 s, 5→6 21.37 s, 6→7 22.97 s.
   * - Sport: 1→2 6.20 s, 2→3 7.81 s, 3→4 11.26 s; tip-in: the A4 kickdown 4→2 at 13.4507 s (2271 → 4160 rpm;
   *   2nd lands ≤ kickdownMaxRpm(2, 0.6003) = 4216); WOT: 2→3 at 15.33 s and 3→4 at 18.44 s, both from
   *   6789 rpm; throttle lift: 4→5 19.88 s, 5→6 21.48 s, 6→7 23.08 s.
   */
  it.each([
    ['comfort', 3, 0.9],
    ['sport', 2, 0.97],
  ] as const)(
    'DCT7 Auto %s: the demo WOT tip-in is ONE A4 kickdown, from 4th to gear %i (contract A10); WOT upshifts at %f·redline',
    (mode: DriveMode, to, hi) => {
      const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
      h.input({ type: 'driveMode', value: mode });
      h.input({ type: 'ignition', on: true });
      h.run(19.5);
      expect(h.at(13).gear).toBe(4);
      // every downshift from the end of the part-load cruise to the end of the WOT hold: the kickdown only
      const downs = h.between(13, 19.5).filter((r) => r.shiftStart && !r.shiftUp);
      expect(downs.length).toBe(1);
      const kd = downs[0];
      expect(kd !== undefined && isKickdown(kd)).toBe(true);
      expect(kd?.prevGear).toBe(4);
      expect(kd?.gear).toBe(to);
      expect(kd?.t).toBeCloseTo(13.45, 1);
      // then the box pulls through the gears at the WOT point (frac(1) = hi): upshifts only
      const ups = h.between((kd?.t ?? 0) + DT / 2, 19.5).filter((r) => r.shiftStart && r.shiftUp);
      expect(ups.length).toBeGreaterThanOrEqual(1);
      for (const r of ups) expect(r.fromRpm).toBeGreaterThan((hi - 0.01) * 7000);
    },
  );

  it('a shift start carries the engine rpm before and after the shift, snapping to the new gear when engaged', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(25);
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
    let checked = 0;
    let snapped = 0;
    for (let i = 1; i < h.recs.length; i++) {
      const prev = h.recs[i - 1];
      const r = h.recs[i];
      if (prev === undefined || r === undefined || !r.shiftStart) continue;
      expect(r.fromRpm).toBe(prev.rpm);
      expect(r.toRpm).toBe(r.rpm);
      // upshifts are one gear here (the over-speed skip-shift needs ≥ redline, which this run never reaches);
      // downshifts one gear (map) or up to two (A4 kickdown: g ≥ gear − 2)
      expect(r.shiftUp ? r.gear === prev.gear + 1 : r.gear < prev.gear && r.gear >= prev.gear - 2).toBe(true);
      // RF5 / spec §8.6: engaged, out.rpm SNAPS to the new gear on the shift-start quantum, so out.shift.toRpm
      // is exactly the gearbox's wheel rpm in the new gear (a slew would have moved it by only 48 rpm).
      if (r.driveline === 'engaged') {
        const wheel = wheelRpm(r.v, DCT7_SPEC.gearbox.overallRatios[r.gear - 1] ?? 0, c);
        expect(r.toRpm, `t=${r.t.toFixed(4)} ${prev.gear}→${r.gear}`).toBe(wheel);
        snapped++;
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    // measured: all 8 shift starts of this run are engaged (1→2 5.94 s … 6→7 22.97 s, the 4→3 kickdown included)
    expect(snapped).toBeGreaterThanOrEqual(5);
  });

  it('Manual box without paddles: the WOT pull hits the limiter, clamped exactly at limiter.rpm', () => {
    const h = new Harness(MANUAL6_SPEC, MANUAL6_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    const recs = h.run(16);
    const lim = recs.filter((r) => r.limiter);
    expect(lim.length).toBeGreaterThan(100);
    for (const r of recs) {
      expect(r.rpm).toBeLessThanOrEqual(7500);
      if (r.limiter) {
        expect(r.rpm).toBe(7500);
        expect(has(r, F.LIMITER)).toBe(true);
      } else {
        expect(has(r, F.LIMITER)).toBe(false);
      }
    }
    expect(h.recs[h.recs.length - 1]?.gear).toBe(1);
    // a paddle upshift takes it off the limiter (2nd at ≈ 104 km/h turns ≈ 7385 rpm, so WOT reaches
    // the limiter again ≈ 0.15 s later): out.rpm snaps from limiter.rpm straight to the 2nd-gear wheel rpm
    h.input({ type: 'shiftUp' });
    const after = h.run(0.5);
    const first = after[0];
    const c = rollingCircumferenceM(MANUAL6_SPEC.gearbox.drivenTyre);
    expect(first?.gear).toBe(2);
    expect(first?.shiftStart).toBe(true);
    expect(first?.limiter).toBe(false);
    expect(first?.driveline).toBe('engaged');
    expect(first?.rpm).toBe(wheelRpm(first?.v ?? 0, MANUAL6_SPEC.gearbox.overallRatios[1] ?? 0, c));
    expect(first?.rpm).toBeLessThan(7500 - 50); // more than one slew step below the limiter
    expect(first?.toRpm).toBe(first?.rpm);
    expect(first?.fromRpm).toBe(7500);
    expectContinuous(h.recs);
  });

  it('TC8 automatic: converter stall at rest, slip on launch, lock-up (engaged) when cruising', () => {
    const h = new Harness(TC8_SPEC, TC8_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    expect(h.at(3).driveline).toBe('tc-stall');
    expect(h.between(3.5, 8).some((r) => r.driveline === 'slipping')).toBe(true);
    expect(h.at(30).driveline).toBe('engaged');
    expect(h.at(30).gear).toBeGreaterThanOrEqual(6);
    // OVERRUN needs the locked-up driveline: while braking the converter unlocks and slips with
    // load < −0.05 above fuelCutResumeRpm — those quanta must not report OVERRUN
    const fuelCutResume = TC8_VOICING.overrun.fuelCutResumeRpm;
    const overrunLoadRpm = (r: Rec): boolean => r.load < -0.05 && r.rpm > fuelCutResume;
    expect(recs.filter((r) => r.driveline !== 'engaged' && overrunLoadRpm(r)).length).toBeGreaterThan(10);
    expect(recs.filter((r) => has(r, F.OVERRUN)).length).toBeGreaterThan(100); // the locked-up lift-off
    for (const r of recs) expect(has(r, F.OVERRUN), `t=${r.t.toFixed(4)}`).toBe(overrunLoadRpm(r) && r.driveline === 'engaged');
    expect(expectContinuous(recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });
});

describe('TesboxSimCore — GPS replay source', () => {
  it('highway-amd: upshifts to top gear for the 130 km/h cruise and tracks speed in gear', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(78);
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
    const cruise = h.between(30, 46);
    for (const r of cruise) {
      expect(r.gear).toBe(7);
      expect(Math.abs(r.v - 36.11)).toBeLessThan(1.5);
      // engaged: rpm = wheel rpm, except the one quantum after a fix arrival moves v by > 48 rpm's worth
      expect(Math.abs(r.rpm - wheelRpm(r.v, 2.7, c))).toBeLessThanOrEqual(50);
    }
    // lift-off 36 → 30 m/s stays in top gear (2442 rpm at 30 m/s ≫ the 1125 rpm coast-down point)
    for (const r of h.between(48, 60)) expect(r.gear).toBe(7);
    for (const r of recs) {
      expect(r.load).toBeGreaterThanOrEqual(-1);
      expect(r.load).toBeLessThanOrEqual(1);
      expect(r.limiter).toBe(false);
      expect(has(r, F.PREDICTING)).toBe(false);
    }
    expect(expectContinuous(h.recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });

  it('tunnel-dropout: no upshift while predicting, GPS_LOST eases to a stop, recovery at the exit stays continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('tunnel-dropout');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(83);
    const predicting = recs.filter((r) => has(r, F.PREDICTING));
    expect(predicting.length).toBeGreaterThan(0);
    for (const r of predicting) expect(r.shiftStart && r.shiftUp).toBe(false);
    expect(recs.some((r) => has(r, F.GPS_LOST))).toBe(true);
    // fix arrivals stop at 20 s: lost from 40 s, eased to 0 by 50 s → standstill in gear 1 at idle
    const lost = h.at(52);
    expect(lost.v).toBe(0);
    expect(lost.gear).toBe(1);
    expect(has(lost, F.GPS_LOST) && has(lost, F.STANDSTILL)).toBe(true);
    // after the tunnel (arrivals resume at 55 s) the car is back at 25 m/s in a sensible gear
    const back = h.at(80);
    expect(back.v).toBeGreaterThan(23);
    expect(back.gear).toBeGreaterThanOrEqual(5);
    expect(back.limiter).toBe(false);
    // the exit fix finds the box in gear 1 (standstill) at 25 m/s: one over-speed upshift straight to the
    // map gear while the engine slews up from idle — never a 1st/2nd-gear over-rev
    expect(h.at(55.5).gear).toBeGreaterThanOrEqual(6);
    expect(Math.max(...h.between(55, 58).map((r) => r.rpm))).toBeLessThan(3000);
    expect(expectContinuous(recs)).toBeLessThanOrEqual(
      recs.filter((r) => r.shiftStart).length + recs.filter((r) => r.limiter).length + 1,
    );
  });

  // One row per fixture (stale/duplicate fixes, Intel zero/null speed, stoplight jitter, city stop-go): ≈ 0.6 s
  // each, where a single 5-fixture test took ≈ 3 s — too close to the 5 s default timeout in a loaded full run.
  it.each([['stale-duplicates'], ['intel-zero-speed'], ['intel-null-speed'], ['stoplight-jitter'], ['city-amd']] as const)(
    'replay fixture %s (TC8): finite, continuous and above idle',
    (name) => {
      const h = new Harness(TC8_SPEC, TC8_VOICING, 'replay').replay(name);
      h.input({ type: 'ignition', on: true });
      const recs = h.run(60);
      for (const r of recs) {
        expect(Number.isFinite(r.rpm) && Number.isFinite(r.load) && Number.isFinite(r.v)).toBe(true);
        if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(650 - 20 - 1e-9);
      }
      expectContinuous(recs);
    },
  );

  it('hidden hold: rpm eases to idle, load 0, clutch open, gear held; tracking resumes when visible', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(35);
    const before = h.recs[h.recs.length - 1];
    expect(before?.gear).toBe(7);
    h.input({ type: 'visibility', hidden: true });
    h.setFeeding(false); // geolocation stops while hidden
    const hidden = h.run(5);
    h.input({ type: 'shiftDown' }); // ignored while held
    for (const r of hidden) {
      expect(r.gear).toBe(7);
      expect(r.load).toBe(0);
      expect(r.driveline).toBe('clutch-open');
      expect(has(r, F.HIDDEN_HOLD) && has(r, F.CLUTCH_OPEN)).toBe(true);
      expect(r.shiftActive).toBe(false);
      expect(has(r, F.OVERRUN)).toBe(false);
    }
    expect(Math.abs((hidden[Math.round(0.3 / DT)]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.input({ type: 'visibility', hidden: false });
    h.setFeeding(true);
    const visible = h.run(5);
    expect((visible[0]?.flags ?? F.HIDDEN_HOLD) & F.HIDDEN_HOLD).toBe(0);
    expect(visible.filter((r) => r.shiftStart && !r.shiftUp).length).toBe(0); // the hidden shiftDown was dropped
    const end = visible[visible.length - 1];
    expect(end?.gear).toBe(7);
    expect(end?.driveline).toBe('engaged');
    expect(Math.abs((end?.rpm ?? 0) - (before?.rpm ?? 0))).toBeLessThan(200);
    expect(expectContinuous(h.between(34, h.t))).toBe(0);
  });

  it('a paddle request received in the quantum the hidden hold starts is dropped, not applied when visible again', () => {
    // Spec §4.3: an input applies at the next quantum after receipt — here that quantum is already held, so
    // the request must not wait in the gearbox for the hold to end (it would fire seconds later, with an 8 s
    // MANUAL_OVERRIDE).
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(35);
    expect(h.recs[h.recs.length - 1]?.gear).toBe(7);
    h.input({ type: 'shiftDown' }); // received while running and visible …
    h.input({ type: 'visibility', hidden: true }); // … but the next quantum is held
    h.setFeeding(false);
    const hidden = h.run(5);
    for (const r of hidden) {
      expect(r.gear).toBe(7);
      expect(r.shiftActive).toBe(false);
    }
    h.input({ type: 'visibility', hidden: false });
    h.setFeeding(true);
    const visible = h.run(5);
    expect(visible.filter((r) => r.shiftStart).length).toBe(0);
    for (const r of visible) {
      expect(r.gear).toBe(7);
      expect(has(r, F.MANUAL_OVERRIDE)).toBe(false);
    }
    // a request received once visible again is applied at the next quantum as usual
    h.input({ type: 'shiftDown' });
    const down = h.run(0.2)[0];
    expect(down?.gear).toBe(6);
    expect(down?.shiftStart).toBe(true);
    expect(down?.shiftUp).toBe(false);
    expect((down?.flags ?? 0) & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    expect(expectContinuous(h.between(34, h.t))).toBeLessThanOrEqual(1);
  });

  it('setTuning() applies a new SimTuning mid-drive without a reset: gear held, rpm continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    const control = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    for (const x of [h, control]) {
      x.input({ type: 'ignition', on: true });
      x.run(35);
    }
    h.core.setTuning({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 });
    const after = h.run(1);
    control.run(1);
    for (const r of after) expect(r.gear).toBe(7);
    expect(expectContinuous(h.between(34, h.t))).toBe(0);
    // the filter now predicts 0.1 s further ahead (identical runs otherwise)
    expect(h.core.out.speedMps).not.toBe(control.core.out.speedMps);
  });

  it('demo source: GPS-health bits still describe the real GPS; STANDSTILL follows the demo car; no hidden hold', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const start = h.run(10);
    for (const r of start) expect(has(r, F.GPS_LOST)).toBe(true); // no fix ever arrived
    expect(has(h.at(2.8), F.STANDSTILL)).toBe(true);
    expect(has(h.at(9), F.STANDSTILL)).toBe(false); // the demo car is moving
    h.input({ type: 'visibility', hidden: true });
    const recs = h.run(4);
    for (const r of recs) expect(has(r, F.HIDDEN_HOLD)).toBe(false);
    expect(recs[recs.length - 1]?.driveline).toBe('engaged');
    expect(recs[recs.length - 1]?.rpm).toBeGreaterThan(1200);
  });

  it('demo source: PREDICTING (the real GPS stopped delivering) is reported but does not hold the demo car’s auto-upshifts', () => {
    // PREDICTING suppresses auto-upshifts only on gps/replay: two early fixes, then none → PREDICTING from 3 s.
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    const fix: FixMsg = { type: 'fix', ageS: 1, speedMps: 0, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };
    expect(h.core.pushFix(fix, 0)).toBe(true);
    h.input({ type: 'ignition', on: true });
    h.run(1);
    expect(h.core.pushFix(fix, h.t)).toBe(true); // last arrival at 1.0 s
    h.run(9);
    for (const r of h.between(3.1, 10)) {
      expect(has(r, F.PREDICTING)).toBe(true);
      expect(has(r, F.GPS_LOST)).toBe(false); // lost only after 20 s without an arrival
    }
    // the demo pull-away upshifts exactly as without a GPS (Comfort 1→2 at 5.94 s, 2→3 7.54 s, 3→4 9.14 s)
    const ups = h.between(3, 10).filter((r) => r.shiftStart && r.shiftUp);
    expect(ups.map((r) => r.gear)).toEqual([2, 3, 4]);
    expect(ups[0]?.prevGear).toBe(1);
    expect(ups[0]?.t).toBeCloseTo(5.94, 1);
    for (const r of ups) expect(has(r, F.PREDICTING)).toBe(true);
  });
});

describe('TesboxSimCore — RF5: source switching mid-run', () => {
  it('demo → gps (no fixes) → demo: out.rpm never jumps more than 50 rpm/quantum outside shift starts and the limiter', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(17); // mid-WOT, high rpm
    const high = h.recs[h.recs.length - 1]?.rpm ?? 0;
    expect(high).toBeGreaterThan(3500);
    h.core.setSource('gps'); // filter has never had a fix → v = 0, standstill
    const toGps = h.run(3);
    expect(toGps[0]?.rpm).toBeGreaterThanOrEqual(high - 50);
    expect(toGps[toGps.length - 1]?.gear).toBe(1);
    expect(Math.abs((toGps[toGps.length - 1]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.core.setSource('demo'); // demo restarts from rest at its idle
    const tSwitch = h.t;
    const again = h.run(20);
    // the script restarts from rest (it stopped at 17 s, mid-WOT, with the demo car at ≈ 38 m/s): its idle
    // phase replays — car at rest, gear 1, clutch open, warm idle …
    const idle = again.filter((r) => r.t < tSwitch + 2.9);
    expect(idle.length).toBeGreaterThan(1000);
    for (const r of idle) {
      expect(r.v).toBe(0);
      expect(r.gear).toBe(1);
      expect(has(r, F.STANDSTILL) && has(r, F.CLUTCH_OPEN)).toBe(true);
      expect(Math.abs(r.rpm - 800)).toBeLessThanOrEqual(20);
    }
    // … then the pull-away upshifts at the script's own times (1→2 at 5.94 s, as after the first ignition)
    const firstUp = again.find((r) => r.shiftStart);
    expect(firstUp?.shiftUp).toBe(true);
    expect([firstUp?.prevGear, firstUp?.gear]).toEqual([1, 2]);
    expect((firstUp?.t ?? 0) - tSwitch).toBeCloseTo(5.94, 1);
    expect(expectContinuous(h.recs)).toBe(h.recs.filter((r) => r.shiftStart).length);
  });

  it('gps (130 km/h replay) → demo → gps at speed: same rule, including the over-speed recovery', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(30);
    expect(h.recs[h.recs.length - 1]?.gear).toBe(7);
    const cruiseRpm = h.recs[h.recs.length - 1]?.rpm ?? 0;
    h.core.setSource('demo'); // demo car at rest → rpm eases to idle
    const toDemo = h.run(6); // demo idle 0–3 s, pull-away from 3.5 s
    expect(toDemo[0]?.rpm).toBeGreaterThanOrEqual(cruiseRpm - 50);
    expect(Math.abs((toDemo[Math.round(2 / DT)]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.core.setSource('replay'); // back to the real car at ~130 km/h while the demo was in a low gear
    const back = h.run(12);
    expect(back.some((r) => r.shiftStart && r.shiftUp)).toBe(true);
    expect(back[back.length - 1]?.gear).toBe(7);
    const all = h.between(29, h.t);
    expect(expectContinuous(all)).toBeLessThanOrEqual(
      all.filter((r) => r.shiftStart).length + all.filter((r) => r.limiter).length + 1,
    );
  });

  it('demo → keyboard keeps the car rolling; keyboard pedals drive PedalPhysics; brake to standstill', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(12);
    const v0 = h.recs[h.recs.length - 1]?.v ?? 0;
    expect(v0).toBeGreaterThan(10);
    h.core.setSource('keyboard');
    const coast = h.run(1);
    expect(coast[0]?.v).toBeGreaterThan(v0 - 0.5); // no reset to 0
    h.input({ type: 'pedal', throttle: 1, brake: 0 });
    const acc = h.run(2);
    expect(acc[acc.length - 1]?.v ?? 0).toBeGreaterThan((coast[coast.length - 1]?.v ?? 0) + 5);
    h.input({ type: 'pedal', throttle: 0, brake: 1 });
    h.run(6);
    const stop = h.recs[h.recs.length - 1];
    expect(stop?.v).toBe(0);
    expect((stop?.flags ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(stop?.gear).toBe(1);
    expectContinuous(h.recs);
  });

  it('demo → replay → keyboard: the keyboard car starts at rest (only demo → keyboard keeps it rolling); rpm continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(12);
    expect(h.recs[h.recs.length - 1]?.v).toBeGreaterThan(10); // the demo car's PedalPhysics speed
    h.core.setSource('replay'); // the real car (the filter tracked the trace all along)
    const gps = h.run(3);
    expect(gps[gps.length - 1]?.v).toBeGreaterThan(20);
    h.core.setSource('keyboard');
    const kb = h.run(2); // no pedal message yet
    expect(kb[0]?.v).toBe(0); // not the stale demo speed, not the GPS speed
    for (const r of kb) expect(r.v).toBe(0);
    const end = kb[kb.length - 1];
    expect(end?.gear).toBe(1);
    expect((end?.flags ?? 0) & (F.STANDSTILL | F.CLUTCH_OPEN)).toBe(F.STANDSTILL | F.CLUTCH_OPEN);
    expect(Math.abs((end?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    expectContinuous(h.recs);
  });
});

describe('TesboxSimCore — inputs', () => {
  it('shiftUp/shiftDown reach the gearbox; gearboxMode and driveMode are applied; other messages are ignored', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(5); // pulling away in 1st
    h.input({ type: 'shiftUp' });
    const up = h.run(0.2);
    expect(up[0]?.gear).toBe(2);
    expect(up[0]?.shiftStart && up[0]?.shiftUp).toBe(true);
    h.input({ type: 'shiftDown' });
    expect(h.run(0.2)[0]?.gear).toBe(1);
    h.input({ type: 'gearboxMode', value: 'auto' });
    h.input({ type: 'driveMode', value: 'sport' });
    for (const msg of [
      { type: 'valve', mode: 'open' },
      { type: 'perspective', value: 'outside' },
      { type: 'volume', trimDb: -6 },
      { type: 'bench', k: 4 },
    ] as const) {
      h.input(msg);
    }
    h.run(8);
    expect(h.recs[h.recs.length - 1]?.gear).toBeGreaterThan(1); // auto took over again
  });

  it('pushFix returns the filter verdict whatever the source; the fix counters are forwarded', () => {
    const core = new TesboxSimCore();
    core.configure(DCT7_SPEC, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING);
    core.setSource('demo');
    const fix: FixMsg = { type: 'fix', ageS: 1, speedMps: 10, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };
    expect(core.pushFix(fix, 10)).toBe(true);
    expect(core.pushFix({ ...fix, ageS: 5 }, 11)).toBe(false); // stale (> 3 s)
    expect(core.pushFix({ ...fix, accuracyM: 0 }, 12)).toBe(false);
    expect(core.fixesAccepted).toBe(1);
    expect(core.fixesRejected).toBe(2);
  });

  it('a paddle request followed by configure() before the next quantum is dropped: the reconfigured box stays in 1st', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(5); // pulling away in 1st
    h.input({ type: 'shiftUp' }); // made for the old configuration …
    h.core.configure(DCT7_SPEC, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING); // … which resets the box to gear 1
    const after = h.run(1);
    for (const r of after) {
      expect(r.gear).toBe(1);
      expect(r.shiftActive).toBe(false);
    }
    expect(after[0]?.v).toBeGreaterThan(3); // rolling: an applied request would have upshifted at once
    expect(expectContinuous(h.recs)).toBe(0);
    // a request made after configure() applies at the next quantum as usual
    h.input({ type: 'shiftUp' });
    const up = h.run(0.2)[0];
    expect(up?.shiftStart && up.shiftUp).toBe(true);
    expect(up?.gear).toBe(2);
  });

  it('configure() rejects an unparseable driven tyre', () => {
    const bad: EngineSpec = { ...DCT7_SPEC, gearbox: { ...DCT7_SPEC.gearbox, drivenTyre: 'not a tyre' } };
    expect(() => new TesboxSimCore().configure(bad, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING)).toThrow(Error);
  });

  it('configure() is all-or-nothing: a tc-auto spec without tc data throws and leaves the running core untouched', () => {
    // Only hand-built/unvalidated specs reach this (engine.schema.json requires tc for tc-auto).
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    const control = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    for (const x of [h, control]) {
      x.input({ type: 'ignition', on: true });
      x.run(12);
    }
    const bad: EngineSpec = { ...TC8_SPEC, gearbox: { ...TC8_SPEC.gearbox, tc: null } };
    expect(() => h.core.configure(bad, TC8_VOICING, MID_TESLA, DEFAULT_SIM_TUNING)).toThrow('tc-auto gearbox requires gearbox.tc');
    // the next 20 s (kickdown, WOT pull to 7th, cruise) are exactly the control's: still DCT7 throughout
    const after = h.run(20);
    const ref = control.run(20);
    expect(after.length).toBe(ref.length);
    const diverged = after.findIndex((r, i) => (Object.keys(r) as (keyof Rec)[]).some((k) => !Object.is(r[k], ref[i]?.[k])));
    expect(diverged, `first divergence at t=${after[diverged]?.t.toFixed(4)}`).toBe(-1);
    expect(Math.max(...after.map((r) => r.gear))).toBe(7);
  });
});

describe('TesboxSimCore — limiter clamp on the continuity-limited rpm (PC11)', () => {
  it('restart while rolling in Manual at 130 km/h, paddle up while out.rpm still slews up from idle: no jump to the limiter', () => {
    // After the restart the box is in 1st at ≈ 36 m/s (≈ 13 700 rpm) and out.rpm slews up from idle. A paddle
    // upshift snaps the driveline to 2nd, which still turns ≈ 9 200 rpm > limiter.rpm: clamping that unslewed
    // target would lift out.rpm from ≈ 4 300 straight to 7 500 on the upshift, against the shift's direction.
    const h = new Harness(MANUAL6_SPEC, MANUAL6_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(35); // Auto: 6th at ≈ 36.3 m/s
    expect(h.recs[h.recs.length - 1]?.gear).toBe(6);
    const tOff = h.t;
    h.input({ type: 'ignition', on: false });
    h.run(0.1);
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    const restart = h.run(2.5 + 0.2); // crank, then 0.2 s running in 1st
    const climbing = restart[restart.length - 1];
    expect(climbing?.gear).toBe(1);
    expect(climbing?.v).toBeGreaterThan(35);
    expect(climbing?.limiter).toBe(false);
    expect(climbing?.rpm).toBeGreaterThan(3000);
    expect(climbing?.rpm).toBeLessThan(7500 - 1000);
    h.input({ type: 'shiftUp' });
    const after = h.run(1);
    const up = after[0];
    expect(up?.shiftStart).toBe(true);
    expect(up?.shiftUp).toBe(true);
    expect([up?.prevGear, up?.gear]).toEqual([1, 2]);
    expect(up?.fromRpm).toBe(climbing?.rpm);
    expect(up?.toRpm).toBe(up?.rpm);
    const rise = (up?.toRpm ?? Infinity) - (up?.fromRpm ?? 0);
    expect(rise, `the upshift raised out.rpm ${up?.fromRpm.toFixed(1)} → ${up?.toRpm.toFixed(1)}`).toBeLessThanOrEqual(50); // slews on
    expect(up?.limiter, 'limiter on the upshift quantum').toBe(false);
    // 2nd at ≈ 36 m/s is above limiter.rpm: out.rpm keeps slewing up, then the clamp holds it at exactly 7 500
    const first = after.findIndex((r) => r.limiter);
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(after.length - 100);
    for (const r of after.slice(first)) {
      expect(r.limiter).toBe(true);
      expect(r.rpm).toBe(7500);
      expect(has(r, F.LIMITER)).toBe(true);
    }
    // RF5 over the whole window — ignition off, restart, slew-up, limiter entry: only the paddle upshift is excepted
    expect(expectContinuous(h.between(tOff - 1.5 * DT, h.t))).toBe(1);
  });

  it('restart while rolling in Manual: 1st at 130 km/h reaches the limiter by slewing up from idle, not in one jump', () => {
    // No paddle: the driveline's own output slews up from idle here as well, so this path stayed continuous even
    // when the clamp read the driveline target. It pins the hand-over and limiter entry the paddle test builds on.
    const h = new Harness(MANUAL6_SPEC, MANUAL6_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(35);
    h.input({ type: 'ignition', on: false });
    h.run(0.1);
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    const restart = h.run(3.5);
    const running = restart.filter((r) => r.runTimeS >= 2.5 - 1e-9); // the crank is over
    expect(running.length).toBeGreaterThan(300);
    expect(running[0]?.gear).toBe(1);
    expect(running[0]?.limiter).toBe(false);
    expect(running[0]?.rpm).toBeLessThan(1000);
    const first = running.findIndex((r) => r.limiter);
    // ≈ (7500 − 750) / 48 quanta of slew from idle, then held at exactly limiter.rpm
    expect(first).toBeGreaterThanOrEqual(Math.floor((7500 - 1000) / 48));
    for (const r of running.slice(first)) {
      expect(r.limiter).toBe(true);
      expect(r.rpm).toBe(7500);
    }
    expect(expectContinuous(restart)).toBe(0); // crank, hand-over to 1st, slew-up and limiter entry
  });

  // The second case the review's fuzz found (i4-turbo-20: keyboard → replay at 25 m/s, paddle up, 4683 → 6600 rpm
  // in one quantum), rebuilt on the fictional fixtures at the highway-amd cruise, where 2nd turns above
  // limiter.rpm for all three (DCT7 ≈ 9 400, TC8 ≈ 11 000, MANUAL6 ≈ 9 200 rpm at 36 m/s).
  it.each([
    ['DCT7', DCT7_SPEC, DCT7_VOICING],
    ['TC8', TC8_SPEC, TC8_VOICING],
    ['MANUAL6', MANUAL6_SPEC, MANUAL6_VOICING],
  ] as const)(
    '%s, Manual: keyboard car at rest → replay at 130 km/h, paddle up while out.rpm still slews up from idle: no jump to the limiter',
    (_n, spec, voicing) => {
      const lim = spec.rpm.limiter.rpm;
      const c = rollingCircumferenceM(spec.gearbox.drivenTyre);
      const h = new Harness(spec, voicing, 'keyboard').replay('highway-amd'); // fixes reach the filter whatever the source
      h.input({ type: 'gearboxMode', value: 'manual' });
      h.input({ type: 'ignition', on: true });
      h.run(25); // no pedal: the keyboard car idles at rest in 1st while the replay car cruises at ≈ 36 m/s from 17 s
      const rest = h.recs[h.recs.length - 1];
      expect(rest?.v).toBe(0);
      expect(rest?.gear).toBe(1);
      expect(Math.abs((rest?.rpm ?? 0) - spec.rpm.idle)).toBeLessThanOrEqual(20);
      const tSwitch = h.t;
      h.core.setSource('replay'); // 1st at ≈ 36 m/s turns far above limiter.rpm: out.rpm slews up from idle
      const climb = h.run(0.2);
      const climbing = climb[climb.length - 1];
      expect(climbing?.gear).toBe(1);
      expect(climbing?.v).toBeGreaterThan(35);
      expect(climbing?.limiter).toBe(false);
      expect(climbing?.rpm).toBeLessThan(lim - 1000);
      expect(wheelRpm(climbing?.v ?? 0, spec.gearbox.overallRatios[1] ?? 0, c)).toBeGreaterThan(lim); // 2nd: still above
      h.input({ type: 'shiftUp' });
      const after = h.run(1);
      const up = after[0];
      expect(up?.shiftStart).toBe(true);
      expect(up?.shiftUp).toBe(true);
      expect([up?.prevGear, up?.gear]).toEqual([1, 2]);
      expect(up?.fromRpm).toBe(climbing?.rpm);
      expect(up?.toRpm).toBe(up?.rpm);
      const rise = (up?.toRpm ?? Infinity) - (up?.fromRpm ?? 0);
      expect(rise, `the upshift raised out.rpm ${up?.fromRpm.toFixed(1)} → ${up?.toRpm.toFixed(1)}`).toBeLessThanOrEqual(50); // slews on
      expect(up?.limiter, 'limiter on the upshift quantum').toBe(false);
      // out.rpm keeps slewing up, then the clamp holds it at exactly limiter.rpm
      const first = after.findIndex((r) => r.limiter);
      expect(first).toBeGreaterThan(1);
      expect(first).toBeLessThan(after.length - 100);
      for (const r of after.slice(first)) {
        expect(r.limiter).toBe(true);
        expect(r.rpm).toBe(lim);
        expect(has(r, F.LIMITER)).toBe(true);
      }
      // RF5 from the last quantum before the switch: slew-up, upshift, limiter entry — only the upshift is excepted
      expect(expectContinuous(h.between(tSwitch - 1.5 * DT, h.t))).toBe(1);
    },
  );
});

describe('TesboxSimCore — Manual anti-lug follows the previous driveline state (gearbox clutchOpen)', () => {
  it('clutch engaged: braking from 3rd downshifts 3→2→1 as each gear drops below 1100 rpm (keyboard source)', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'keyboard');
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(2.6);
    h.input({ type: 'pedal', throttle: 0.4, brake: 0 });
    h.run(2); // ≈ 6 m/s in 1st
    h.input({ type: 'shiftUp' });
    h.run(1.5); // ≈ 10 m/s in 2nd
    h.input({ type: 'shiftUp' });
    h.run(0.5);
    const third = h.recs[h.recs.length - 1];
    expect(third?.gear).toBe(3);
    expect(third?.driveline).toBe('engaged');
    h.input({ type: 'pedal', throttle: 0, brake: 0.5 });
    const stop = h.run(4);
    const downs = stop.filter((r) => r.shiftStart);
    expect(downs.map((r) => [r.prevGear, r.gear])).toEqual([
      [3, 2],
      [2, 1],
    ]);
    for (const r of downs) {
      expect(r.shiftUp).toBe(false);
      expect(h.recs[h.recs.indexOf(r) - 1]?.driveline).toBe('engaged'); // the clutchOpen argument was false
    }
    expect(downs[0]?.v).toBeCloseTo(speedFor(DCT7_SPEC, c, 3, 1100), 1); // 5.98 m/s
    expect(downs[1]?.v).toBeCloseTo(speedFor(DCT7_SPEC, c, 2, 1100), 1); // 4.24 m/s
    const end = stop[stop.length - 1];
    expect(end?.v).toBe(0);
    expect(end?.gear).toBe(1);
    expect(expectContinuous(h.recs)).toBe(h.recs.filter((r) => r.shiftStart).length);
  });

  it('clutch open: a paddle upshift at a crawl is kept — no anti-lug while the clutch is open (keyboard source)', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'keyboard');
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(2.6);
    h.input({ type: 'pedal', throttle: 0.4, brake: 0 });
    h.run(1); // ≈ 3 m/s in 1st, clutch engaged
    expect(h.recs[h.recs.length - 1]?.driveline).toBe('engaged');
    h.input({ type: 'pedal', throttle: 0, brake: 0.1 });
    h.run(2); // below the 1st-gear clutch-open speed (1.05 · 800 rpm ≈ 2.06 m/s)
    h.input({ type: 'pedal', throttle: 0, brake: 0 });
    const crawl = h.run(0.5);
    const before = crawl[crawl.length - 1];
    expect(before?.gear).toBe(1);
    expect(before?.driveline).toBe('clutch-open');
    expect(before?.v).toBeGreaterThan(0.5);
    expect(before?.v).toBeLessThan(speedFor(DCT7_SPEC, c, 1, 1.05 * 800));
    h.input({ type: 'shiftUp' });
    const after = h.run(2);
    expect(after[0]?.shiftStart && after[0]?.shiftUp).toBe(true);
    expect(after.filter((r) => r.shiftStart).length).toBe(1);
    for (const r of after) {
      expect(r.gear).toBe(2); // 2nd turns far below 1100 rpm, but the clutch is open: no anti-lug downshift
      expect(r.driveline).toBe('clutch-open');
      expect(has(r, F.STANDSTILL)).toBe(false);
    }
    expect(wheelRpm(after[after.length - 1]?.v ?? 0, DCT7_SPEC.gearbox.overallRatios[1] ?? 0, c)).toBeLessThan(1100 / 2);
    expect(expectContinuous(h.recs)).toBe(h.recs.filter((r) => r.shiftStart).length);
  });
});

/** mulberry32: a small deterministic PRNG, uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of an engine id: an engine's fuzz seeds do not depend on which other engines are present. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const FUZZ_RUNS = 4;
/** Seconds per run: the length of the highway-amd trace. */
const FUZZ_S = 78;
const FUZZ_SOURCES: readonly SpeedSourceKind[] = ['gps', 'replay', 'demo', 'keyboard'];
/** highway-amd twice: a low gear turning above limiter.rpm (the PC11 case) needs highway speed. */
const FUZZ_TRACES = ['highway-amd', 'highway-amd', 'tunnel-dropout', 'city-amd'] as const;

interface FuzzStats {
  shiftStarts: number;
  limiterQuanta: number;
  /**
   * Upshift starts whose new gear turns ≥ limiter.rpm (wheel rpm) while out.rpm was more than 50 rpm below the
   * limiter: where clamping the driveline's unslewed target lifted out.rpm to the limiter (PC11). Measured with
   * the seeded runs below: as many as that old clamp's violations, on every engine.
   */
  pc11Upshifts: number;
  violations: string[];
}

/**
 * One seeded fuzz run of FUZZ_S seconds in 48 kHz quanta. Every 0.1–2.1 s one random event: a source switch, a
 * restart while rolling (ignition off for 0.05–1.55 s), a hidden hold of 0.5–6.5 s (fix delivery paused, as on
 * the main thread), a paddle, a gearbox-mode (60 % Manual) or drive-mode change, or a keyboard pedal. 70 % of the
 * source switches, hold ends and restarts are followed by a paddle-up within 0.5 s (after a restart: within 0.5 s
 * of the crank's end), the window where out.rpm may still slew up behind the driveline. Every quantum is checked
 * against RF5 and the limiter clamp; violations are collected rather than thrown, so a failure lists them all.
 */
function fuzzContinuity(spec: EngineSpec, voicing: EngineVoicing, seed: number, st: FuzzStats): void {
  const rnd = mulberry32(seed);
  const source = (): SpeedSourceKind => FUZZ_SOURCES[Math.floor(rnd() * FUZZ_SOURCES.length)] ?? 'gps';
  const core = new TesboxSimCore();
  core.configure(spec, voicing, MID_TESLA, DEFAULT_SIM_TUNING);
  core.setWarm(rnd() < 0.5);
  core.setSource(source());
  const feeder = new ReplayFeeder(loadTrace(FUZZ_TRACES[Math.floor(rnd() * FUZZ_TRACES.length)] ?? 'highway-amd'));
  const fix: FixMsg = { type: 'fix', ageS: 0, speedMps: null, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };
  const lim = spec.rpm.limiter.rpm;
  const c = rollingCircumferenceM(spec.gearbox.drivenTyre);
  core.pushInput({ type: 'gearboxMode', value: rnd() < 0.6 ? 'manual' : 'auto' }, 0);
  core.pushInput({ type: 'ignition', on: true }, 0);
  const o = core.out;
  let hidden = false;
  let nextEventS = 3 + 2 * rnd();
  let ignitionOnS = Infinity;
  let showS = Infinity;
  let paddleUpS = Infinity;
  let prev = 0;
  for (let k = 0; k < Math.round(FUZZ_S / DT); k++) {
    const t = k * DT;
    while (feeder.next(t, fix)) if (!hidden) core.pushFix(fix, t);
    if (t >= ignitionOnS) {
      core.pushInput({ type: 'ignition', on: true }, t);
      ignitionOnS = Infinity;
      if (rnd() < 0.7) paddleUpS = t + 2.5 + 0.5 * rnd();
    }
    if (t >= showS) {
      hidden = false;
      core.pushInput({ type: 'visibility', hidden: false }, t);
      showS = Infinity;
      if (rnd() < 0.7) paddleUpS = t + 0.5 * rnd();
    }
    if (t >= paddleUpS) {
      core.pushInput({ type: 'shiftUp' }, t);
      paddleUpS = Infinity;
    }
    if (t >= nextEventS) {
      const e = rnd();
      if (e < 0.22) {
        core.setSource(source());
        if (rnd() < 0.7) paddleUpS = t + 0.5 * rnd();
      } else if (e < 0.32) {
        if (ignitionOnS === Infinity) {
          core.pushInput({ type: 'ignition', on: false }, t);
          ignitionOnS = t + 0.05 + 1.5 * rnd();
        }
      } else if (e < 0.4) {
        if (!hidden) {
          hidden = true;
          core.pushInput({ type: 'visibility', hidden: true }, t);
          showS = t + 0.5 + 6 * rnd();
        }
      } else if (e < 0.62) core.pushInput({ type: rnd() < 0.6 ? 'shiftUp' : 'shiftDown' }, t);
      else if (e < 0.72) core.pushInput({ type: 'gearboxMode', value: rnd() < 0.6 ? 'manual' : 'auto' }, t);
      else if (e < 0.77) core.pushInput({ type: 'driveMode', value: rnd() < 0.5 ? 'sport' : 'comfort' }, t);
      else core.pushInput(rnd() < 0.65 ? { type: 'pedal', throttle: rnd(), brake: 0 } : { type: 'pedal', throttle: 0, brake: rnd() }, t);
      nextEventS = t + 0.1 + 2 * rnd();
    }
    core.step(t, DT);
    const start = o.shift.active && o.shift.t0 === t;
    if (o.limiter) st.limiterQuanta++;
    if (start) {
      st.shiftStarts++;
      const newGearRpm = wheelRpm(o.speedMps, spec.gearbox.overallRatios[o.gear - 1] ?? 0, c);
      if (o.shift.up && prev < lim - 50 && newGearRpm >= lim) st.pc11Upshifts++;
    }
    let bad = '';
    if (!(o.rpm >= 0 && o.rpm <= lim)) bad = 'out.rpm outside [0, limiter.rpm]';
    else if (o.limiter && o.rpm !== lim) bad = 'limiter set but out.rpm ≠ limiter.rpm';
    else if (((o.flags & F.LIMITER) !== 0) !== o.limiter) bad = 'LIMITER flag ≠ out.limiter';
    else if (start && (o.shift.fromRpm !== prev || o.shift.toRpm !== o.rpm)) bad = 'out.shift.fromRpm/toRpm ≠ out.rpm before/after';
    else if (start && (o.shift.up ? o.rpm > prev + 50 : o.rpm < prev - 50)) bad = `${o.shift.up ? 'upshift raised' : 'downshift lowered'} out.rpm`;
    else if (!start && Math.abs(o.rpm - prev) > 50) bad = 'jump > 50 rpm without a shift start';
    if (bad !== '') {
      st.violations.push(
        `seed ${seed} t=${t.toFixed(4)} ${bad}: ${prev.toFixed(1)} → ${o.rpm.toFixed(1)} rpm (gear ${o.gear}, ${o.speedMps.toFixed(1)} m/s, limiter ${o.limiter})`,
      );
    }
    prev = o.rpm;
  }
}

/**
 * Every engine the vehicle tests know: the fictional fixtures and each catalogue engine JSON present. The last
 * column is the minimum number of PC11 upshifts the seeded runs must reach, so the fuzz cannot silently stop
 * probing that case: the fixtures are fixed (measured: DCT7 3, TC8 3, MANUAL6 4), whereas catalogue gearing may
 * still change (measured 0–6 per engine), so no minimum is asserted there.
 */
const FUZZ_ENGINES: readonly (readonly [string, EngineSpec, EngineVoicing, number])[] = [
  ['DCT7', DCT7_SPEC, DCT7_VOICING, 1],
  ['TC8', TC8_SPEC, TC8_VOICING, 1],
  ['MANUAL6', MANUAL6_SPEC, MANUAL6_VOICING, 1],
  ...CATALOGUE.map(([id, d]) => [id, d.spec, d.voicing, 0] as const),
];

describe.each(FUZZ_ENGINES)('TesboxSimCore — RF5 seeded continuity fuzz, engine %s', (id, spec, voicing, minPc11Upshifts) => {
  it('random source switches, restarts while rolling, hidden holds, paddles, mode and pedal changes: out.rpm never jumps > 50 rpm outside a shift start, a shift start moves it only in the shift’s direction, clamped at limiter.rpm', () => {
    const st: FuzzStats = { shiftStarts: 0, limiterQuanta: 0, pc11Upshifts: 0, violations: [] };
    for (let run = 0; run < FUZZ_RUNS; run++) fuzzContinuity(spec, voicing, (fnv1a(id) + Math.imul(run, 0x9e3779b9)) >>> 0, st);
    expect(st.violations.length, st.violations.slice(0, 8).join('\n')).toBe(0);
    // the runs exercised what they are meant to (measured per engine: 47–75 shift starts, 2 300–9 500 limiter quanta)
    expect(st.shiftStarts).toBeGreaterThan(20);
    expect(st.limiterQuanta).toBeGreaterThan(500);
    expect(st.pc11Upshifts).toBeGreaterThanOrEqual(minPc11Upshifts);
  });
});

describe.each(CATALOGUE)('TesboxSimCore — catalogue engine %s over one DEMO_PROFILE loop', (_id, def) => {
  it.each([['auto'], ['manual']] as const)('%s: finite, continuous, never below idle, clamped at limiter.rpm', (mode) => {
    const h = new Harness(def.spec, def.voicing, 'demo');
    h.input({ type: 'gearboxMode', value: mode });
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    const lim = def.spec.rpm.limiter.rpm;
    for (const r of recs) {
      expect(Number.isFinite(r.rpm) && Number.isFinite(r.load)).toBe(true);
      expect(r.rpm).toBeLessThanOrEqual(lim);
      if (r.limiter) expect(r.rpm).toBe(lim);
      if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(def.spec.rpm.idle - 20 - 1e-9);
    }
    if (mode === 'auto') expect(recs.reduce((m, r) => Math.max(m, r.gear), 0)).toBeGreaterThanOrEqual(4);
    expectContinuous(recs);
  });
});
