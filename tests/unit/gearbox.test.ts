import { describe, expect, it } from 'vitest';
import { F } from '../../src/contracts';
import type { DriveMode, EngineSpec, GearboxMode } from '../../src/contracts';
import { PedalPhysics } from '../../src/sim/demo';
import { Gearbox } from '../../src/sim/gearbox';
import { LoadEstimator } from '../../src/sim/load';
import { buildShiftMap } from '../../src/sim/shift-map';
import { rollingCircumferenceM } from '../../src/sim/tyre';
import { DCT7_SPEC, DT, MID_TESLA, TC8_SPEC, speedFor } from '../helpers/sim-fixtures';

// DCT7: ratios [13.5, 8.6, 6.1, 4.7, 3.8, 3.15, 2.7], redline 7000, shiftTimeS 0.1, 245/40R18.
const C = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
const COMFORT = buildShiftMap(DCT7_SPEC, 'comfort');
const SPORT = buildShiftMap(DCT7_SPEC, 'sport');
const SHIFT_S = DCT7_SPEC.gearbox.shiftTimeS;

/** Road speed at which `gear` turns `rpm`. */
const vAt = (gear: number, rpm: number): number => speedFor(DCT7_SPEC, C, gear, rpm);

function make(mode: GearboxMode = 'auto', drive: DriveMode = 'comfort'): Gearbox {
  const gb = new Gearbox();
  gb.configure(DCT7_SPEC, C, mode, drive);
  return gb;
}

interface In {
  v: number;
  load?: number;
  loadRate?: number;
  predicting?: boolean;
  standstill?: boolean;
  clutchOpen?: boolean;
}

/** One quantum at time t. */
function stepAt(gb: Gearbox, t: number, i: In): void {
  gb.step(t, i.v, i.load ?? 0, i.loadRate ?? 0, i.predicting ?? false, i.standstill ?? false, i.clutchOpen ?? false);
}

/** n quanta starting at t with constant inputs; returns the time of the next quantum. */
function stepN(gb: Gearbox, t: number, n: number, i: In): number {
  for (let k = 0; k < n; k++) stepAt(gb, t + k * DT, i);
  return t + n * DT;
}

/**
 * Manual paddle-up to `gear` at constant speed v (each shift allowed to complete) with otherwise
 * constant inputs (default: load 0); returns the time. Bounded: Vitest cannot time out synchronous
 * code, so a broken paddle-up path must fail here with a clear message instead of hanging the run.
 */
function climbTo(gb: Gearbox, gear: number, t: number, v: number, inputs: Omit<In, 'v'> = {}): number {
  let now = t;
  for (let i = 0; i < 16 && gb.gear < gear; i++) {
    gb.request(+1);
    now = stepN(gb, now, Math.ceil(SHIFT_S / DT) + 1, { ...inputs, v });
  }
  expect(gb.gear, `climbTo(${gear}) reached gear ${gb.gear}`).toBe(gear);
  return now;
}

interface ShiftEvent {
  t0: number;
  from: number;
  to: number;
}

describe('Gearbox — basics', () => {
  it('starts in gear 1 with no shift in flight and no flags', () => {
    const gb = make();
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
  });

  it('rpmInGear = v / C × ratio × 60, and 0 for gears that do not exist', () => {
    const gb = make();
    expect(gb.rpmInGear(3, 20)).toBeCloseTo((20 / C) * 6.1 * 60, 9);
    expect(gb.rpmInGear(7, 40)).toBeCloseTo((40 / C) * 2.7 * 60, 9);
    expect(gb.rpmInGear(0, 20)).toBe(0);
    expect(gb.rpmInGear(8, 20)).toBe(0);
  });

  it('configure rejects a non-positive or non-finite circumference', () => {
    expect(() => new Gearbox().configure(DCT7_SPEC, 0, 'auto', 'comfort')).toThrow(Error);
    expect(() => new Gearbox().configure(DCT7_SPEC, Number.NaN, 'auto', 'comfort')).toThrow(Error);
    expect(() => new Gearbox().configure(DCT7_SPEC, Infinity, 'auto', 'comfort')).toThrow(Error);
  });

  it('configure rejects a non-finite or negative shift time (NaN would keep the first shift in flight forever)', () => {
    for (const shiftTimeS of [Number.NaN, Infinity, -0.1]) {
      const spec = { ...DCT7_SPEC, gearbox: { ...DCT7_SPEC.gearbox, shiftTimeS } };
      expect(() => new Gearbox().configure(spec, C, 'manual', 'comfort'), `shiftTimeS ${shiftTimeS}`).toThrow(Error);
    }
  });

  it('a configure() that throws changes no state: gear, circumference, ratios, shift time, redline and modes survive (multi-call)', () => {
    const gb = make('manual', 'comfort');
    const v = 20; // 3rd turns 3677 rpm, 4th 2833
    let t = climbTo(gb, 3, 0, v);
    const rpm3 = gb.rpmInGear(3, v);
    const t0 = gb.shift.t0;
    // valid apart from the one bad field, and different from DCT7 in everything configure() keeps, so a
    // field assigned before the throw shows up below (redline 3000 would refuse the 4→3 paddle at 3677 rpm)
    const other: EngineSpec = {
      ...DCT7_SPEC,
      rpm: { ...DCT7_SPEC.rpm, redline: 3000 },
      gearbox: { ...DCT7_SPEC.gearbox, overallRatios: [20, 10, 5, 2.5], shiftTimeS: 0.3 },
    };
    const bad: [string, EngineSpec, number][] = [
      ['shiftTimeS NaN', { ...other, gearbox: { ...other.gearbox, shiftTimeS: Number.NaN } }, 2 * C],
      ['circumference 0', other, 0],
      ['ratios not descending', { ...other, gearbox: { ...other.gearbox, overallRatios: [3, 3] } }, 2 * C],
      ['redline 0', { ...other, rpm: { ...other.rpm, redline: 0 } }, 2 * C],
    ];
    for (const [name, spec, c] of bad) {
      expect(() => gb.configure(spec, c, 'auto', 'sport'), name).toThrow(Error);
      expect(gb.gear, name).toBe(3);
      expect(gb.rpmInGear(3, v), name).toBe(rpm3);
      expect(gb.shift.t0, name).toBe(t0);
    }
    // still Manual: Auto (either drive mode) would upshift within these 2 s, 3677 ≥ upshiftRpm(3, 0)
    t = stepN(gb, t, Math.round(2 / DT), { v });
    expect(gb.gear).toBe(3);
    // still DCT7's shift time and circumference
    gb.request(+1);
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(4);
    expect(gb.shift.durationS).toBe(SHIFT_S);
    expect(gb.shift.toRpm).toBeCloseTo((v / C) * 4.7 * 60, 9);
    // still redline 7000: 3rd at 3677 rpm is a legal downshift
    t = stepN(gb, t + DT, Math.ceil(SHIFT_S / DT) + 1, { v });
    gb.request(-1);
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
    expect(gb.flags & F.SHIFT_REFUSED).toBe(0);
    // still Comfort: at load 0.5, 3rd (3677) is above Comfort's upshift point (3598) and below Sport's (4005)
    gb.setMode('auto');
    stepN(gb, t + DT, Math.round(2 / DT), { v, load: 0.5 });
    expect(gb.gear).toBe(4);
  });

  it('does nothing before configure()', () => {
    const gb = new Gearbox();
    gb.request(+1);
    stepAt(gb, 0, { v: 30 });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
  });

  it('reset() returns to gear 1 and clears the shift, the pending request and every flag', () => {
    const gb = make('manual');
    const v = vAt(2, 6000);
    let t = climbTo(gb, 3, 0, v);
    gb.request(-1); // gear 2 would turn 6000·8.6/6.1 > redline → refused
    stepAt(gb, t, { v: vAt(3, 6000) });
    expect(gb.flags & F.SHIFT_REFUSED).toBe(F.SHIFT_REFUSED);
    t += DT;
    gb.request(+1); // 3→4 starts on this step: reset() below comes with a shift in flight
    stepAt(gb, t, { v: vAt(3, 6000) });
    expect(gb.gear).toBe(4);
    expect(gb.shift.active).toBe(true);
    gb.request(+1);
    gb.reset();
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    t += DT;
    stepAt(gb, t, { v: vAt(1, 3000) });
    expect(gb.gear).toBe(1); // the pending +1 was dropped by reset()
    expect(gb.flags, 'still inside the 0.5 s refusal window: the timer itself was cleared').toBe(0);
  });

  it('reset() in Auto also clears the override, refusal and minimum-time timers (multi-step)', () => {
    const gb = make('auto');
    const slow = vAt(1, 2000); // below upshiftRpm(1, 0.2) = 2354.65; 2nd turns 1274 (> coastDownRpm)
    let t = stepN(gb, 0, 2, { v: slow, load: 0.2 });
    gb.request(+1); // paddle 1→2: MANUAL_OVERRIDE for 8 s; the shift ends 0.1 s later
    stepAt(gb, t, { v: slow, load: 0.2 });
    expect(gb.gear).toBe(2);
    t = stepN(gb, t + DT, Math.ceil(SHIFT_S / DT) + 1, { v: slow, load: 0.2 });
    const fast = vAt(2, 5000); // 1st would turn 5000·13.5/8.6 = 7849 > redline → refused
    gb.request(-1);
    stepAt(gb, t, { v: fast, load: 0.2 });
    expect(gb.gear).toBe(2);
    expect(gb.flags).toBe(F.MANUAL_OVERRIDE | F.SHIFT_REFUSED);
    gb.reset();
    expect(gb.gear).toBe(1);
    expect(gb.flags).toBe(0);
    // the following steps all fall inside the old 0.5 s refusal and 8 s override windows
    for (let k = 0; k < 20; k++) {
      t += DT;
      stepAt(gb, t, { v: slow, load: 0.2 });
      expect(gb.flags & F.SHIFT_REFUSED, 'refusal timer cleared').toBe(0);
      expect(gb.flags & F.MANUAL_OVERRIDE, 'override timer cleared').toBe(0);
      expect(gb.gear).toBe(1);
    }
    // ≈ 0.06 s after the pre-reset shift ended: the first quantum at the upshift point upshifts at once
    t += DT;
    stepAt(gb, t, { v: vAt(1, COMFORT.upshiftRpm(1, 0.2) + 10), load: 0.2 });
    expect(gb.gear, 'minimum-time-in-gear timer cleared').toBe(2);
    expect(gb.flags).toBe(F.SHIFTING);
  });
});

describe('Gearbox — Manual', () => {
  it('applies a request on the next step, changes gear immediately and fills the shift trajectory', () => {
    const gb = make('manual');
    const v = vAt(1, 3000);
    stepAt(gb, 0, { v });
    gb.request(+1);
    expect(gb.gear).toBe(1); // not before the next step
    stepAt(gb, 0.5, { v });
    expect(gb.gear).toBe(2);
    expect(gb.shift).toEqual({
      active: true,
      up: true,
      fromRpm: gb.rpmInGear(1, v),
      toRpm: gb.rpmInGear(2, v),
      t0: 0.5,
      durationS: SHIFT_S,
    });
    expect(gb.shift.fromRpm).toBeCloseTo(3000, 6);
    expect(gb.shift.toRpm).toBeCloseTo((3000 * 8.6) / 13.5, 6);
    expect(gb.flags).toBe(F.SHIFTING);
  });

  it('keeps SHIFTING exactly until t0 + durationS (multi-step)', () => {
    const gb = make('manual');
    const v = vAt(1, 3000);
    gb.request(+1);
    let activeSteps = 0;
    for (let k = 0; k < 60; k++) {
      stepAt(gb, k * DT, { v });
      if (gb.shift.active) {
        activeSteps++;
        expect(gb.flags & F.SHIFTING).toBe(F.SHIFTING);
        expect(k * DT).toBeLessThan(SHIFT_S);
      } else {
        expect(gb.flags & F.SHIFTING).toBe(0);
        expect(k * DT).toBeGreaterThanOrEqual(SHIFT_S);
      }
    }
    expect(activeSteps).toBe(Math.ceil(SHIFT_S / DT)); // 38 quanta at 48 kHz
  });

  it('RF4: paddle spam during an active shift is ignored until it completes; shifts never overlap', () => {
    const gb = make('manual');
    const v = vAt(2, 4000); // gears 1 … 7 all turn between 1100 rpm and redline at this speed
    let t = climbTo(gb, 2, 0, v);
    const pattern = [+1, +1, +1, -1, +1, -1, -1, +1];
    /** Spams one request before EVERY quantum (also while a shift is in flight); returns the shift events. */
    const spam = (quanta: number, dirAt: (k: number) => number): ShiftEvent[] => {
      const events: ShiftEvent[] = [];
      let lastT0 = gb.shift.t0;
      for (let k = 0; k < quanta; k++) {
        gb.request(dirAt(k));
        const before = gb.gear;
        const inFlight = gb.shift.active && t < gb.shift.t0 + gb.shift.durationS;
        stepAt(gb, t, { v });
        if (gb.shift.t0 !== lastT0) {
          expect(inFlight, `new shift at t=${t.toFixed(4)} while one was in flight`).toBe(false);
          expect(Math.abs(gb.gear - before)).toBe(1);
          events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
          lastT0 = gb.shift.t0;
        } else {
          expect(gb.gear).toBe(before); // no gear change without a shift event
        }
        t += DT;
      }
      for (let i = 1; i < events.length; i++) {
        const a = events[i - 1];
        const b = events[i];
        if (a !== undefined && b !== undefined) expect(b.t0).toBeGreaterThanOrEqual(a.t0 + SHIFT_S); // no overlap
      }
      return events;
    };

    // Phase A: only up-requests → 2→3→…→7, each next shift on the first quantum after the previous ended
    const a = spam(1200, () => +1);
    expect(a.map((e) => e.to)).toEqual([3, 4, 5, 6, 7]);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      if (prev !== undefined && cur !== undefined) expect(cur.t0 - (prev.t0 + SHIFT_S)).toBeLessThan(DT);
    }
    expect(gb.gear).toBe(7);
    expect(gb.flags & F.SHIFT_REFUSED).toBe(0); // up-requests in top gear are ignored silently

    // Phase B: mixed up/down spam → still never overlapping, one gear per shift. In 7th (or 1st) the
    // pattern can repeat an illegal direction up to 4 quanta in a row (indices 7, 0, 1, 2 are all +1),
    // so the next legal request comes at most 4 quanta (+ the sub-quantum shift-end offset) later.
    const b = spam(1200, (k) => pattern[k % pattern.length] ?? 1);
    expect(b.length).toBeGreaterThan(8);
    for (let i = 1; i < b.length; i++) {
      const prev = b[i - 1];
      const cur = b[i];
      if (prev !== undefined && cur !== undefined) expect(cur.t0 - (prev.t0 + SHIFT_S)).toBeLessThan(5 * DT);
    }
  });

  it('RF4: a single request made while a shift is in flight is dropped, not deferred', () => {
    const gb = make('manual');
    const v = vAt(2, 4000);
    gb.request(+1);
    stepAt(gb, 0, { v });
    expect(gb.gear).toBe(2);
    let t = DT;
    for (let k = 1; k < 400; k++, t += DT) {
      if (k === 10) gb.request(+1); // mid-shift (shift lasts 38 quanta)
      stepAt(gb, t, { v });
    }
    expect(gb.gear).toBe(2);
    gb.request(+1); // after completion it works again
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
  });

  it('RF4 in Auto: paddle spam during a shift is dropped, never queued, never overlapping', () => {
    const gb = make('auto');
    const v = vAt(3, 3000);
    let t = 0;
    const starts: number[] = [];
    let lastT0 = Number.NaN;
    for (let k = 0; k < 600; k++) {
      gb.request(k % 2 === 0 ? +1 : -1);
      stepAt(gb, t, { v, load: 0.3 });
      if (gb.shift.active && gb.shift.t0 !== lastT0) {
        const prev = starts[starts.length - 1];
        if (prev !== undefined) expect(gb.shift.t0).toBeGreaterThanOrEqual(prev + SHIFT_S);
        starts.push(gb.shift.t0);
        lastT0 = gb.shift.t0;
      }
      t += DT;
    }
    expect(starts.length).toBeGreaterThan(5);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
  });

  it('ignores an upshift request in top gear and a downshift request in gear 1 (no flag)', () => {
    const gb = make('manual');
    gb.request(-1);
    let t = stepN(gb, 0, 2, { v: vAt(1, 2000) });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    const v = vAt(7, 2000);
    t = climbTo(gb, 7, t, v);
    gb.request(+1);
    stepN(gb, t, 2, { v });
    expect(gb.gear).toBe(7);
    expect(gb.flags).toBe(0);
  });

  it('refuses a downshift that would exceed redline: SHIFT_REFUSED for 0.5 s, gear kept', () => {
    const gb = make('manual');
    const v = vAt(3, 5000); // gear 2 would turn 5000·8.6/6.1 = 7049 > 7000
    let t = climbTo(gb, 3, 0, v);
    expect(gb.rpmInGear(2, v)).toBeGreaterThan(7000);
    gb.request(-1);
    const tReq = t;
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(F.SHIFT_REFUSED);
    for (t += DT; t < tReq + 0.7; t += DT) {
      stepAt(gb, t, { v });
      expect(gb.flags & F.SHIFT_REFUSED, `t − tReq = ${(t - tReq).toFixed(4)}`).toBe(t < tReq + 0.5 ? F.SHIFT_REFUSED : 0);
    }
    const slower = vAt(3, 4500); // gear 2 = 6344 rpm → allowed
    gb.request(-1);
    stepAt(gb, t, { v: slower });
    expect(gb.gear).toBe(2);
    expect(gb.shift.up).toBe(false);
  });

  it('anti-lug: below 1100 rpm it downshifts one gear per shift unless the clutch is open', () => {
    const gb = make('manual');
    let t = climbTo(gb, 4, 0, vAt(4, 2000));
    const lugging = vAt(4, 1000);
    t = stepN(gb, t, 50, { v: lugging, clutchOpen: true });
    expect(gb.gear).toBe(4);
    stepAt(gb, t, { v: lugging });
    expect(gb.gear).toBe(3); // 1000·6.1/4.7 = 1298 rpm in 3rd → stays
    expect(gb.shift.up).toBe(false);
    t = stepN(gb, t + DT, 200, { v: lugging });
    expect(gb.gear).toBe(3);
    // keep slowing: 3rd < 1100 → 2nd; 2nd < 1100 → 1st; never below 1st
    const seen: number[] = [];
    for (let v = lugging; v > 0.5; v -= 0.002) {
      stepAt(gb, t, { v });
      if (seen[seen.length - 1] !== gb.gear) seen.push(gb.gear);
      t += DT;
    }
    expect(seen).toEqual([3, 2, 1]);
  });

  it('never upshifts by itself, even past redline', () => {
    const gb = make('manual');
    stepN(gb, 0, 1000, { v: vAt(1, 8000), load: 1 });
    expect(gb.gear).toBe(1);
  });

  it('standstill forces gear 1 without a shift event and drops a pending request', () => {
    const gb = make('manual');
    let t = climbTo(gb, 4, 0, vAt(4, 2500));
    gb.request(+1);
    stepAt(gb, t, { v: 0, standstill: true });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    t += DT;
    stepAt(gb, t, { v: vAt(1, 2000) });
    expect(gb.gear).toBe(1);
  });
});

describe('Gearbox — Auto', () => {
  it('upshifts when rpm reaches upshiftRpm(gear, load) and lands at the predicted rpm', () => {
    const gb = make('auto');
    const up = COMFORT.upshiftRpm(1, 0.5); // 3597.87
    stepN(gb, 0, 10, { v: vAt(1, up - 5), load: 0.5 });
    expect(gb.gear).toBe(1);
    stepAt(gb, 10 * DT, { v: vAt(1, up + 1), load: 0.5 });
    expect(gb.gear).toBe(2);
    expect(gb.shift.up).toBe(true);
    expect(gb.shift.fromRpm).toBeCloseTo(up + 1, 6);
    expect(gb.shift.toRpm).toBeCloseTo(((up + 1) * 8.6) / 13.5, 6);
  });

  it('never auto-upshifts while predicting', () => {
    const gb = make('auto');
    const v = vAt(1, 5000);
    const t = stepN(gb, 0, 400, { v, load: 0.5, predicting: true });
    expect(gb.gear).toBe(1);
    stepAt(gb, t, { v, load: 0.5 });
    expect(gb.gear).toBe(2);
  });

  // [title, gapS, load]: the title's second %s consumes the gap, so it comes before the load.
  it.each([
    ['part load 0.5', 1.5, 0.5],
    ['coast −0.3', 1.5, -0.3],
    ['WOT 0.9', 0.2, 0.9],
  ])('%s: next upshift waits %s s after the previous shift ended', (_name, gapS, load) => {
    const gb = make('auto');
    const v1 = vAt(1, COMFORT.upshiftRpm(1, load) + 10);
    stepAt(gb, 0, { v: v1, load });
    expect(gb.gear).toBe(2);
    const ended = 0 + SHIFT_S;
    // now hold a speed at which gear 2 is above its upshift point (below redline, above downshift)
    const v2 = vAt(2, Math.max(COMFORT.upshiftRpm(2, load) + 10, 2600));
    expect(gb.rpmInGear(2, v2)).toBeLessThan(7000);
    let t = DT;
    let upAt = Number.NaN;
    for (; t < 3; t += DT) {
      stepAt(gb, t, { v: v2, load });
      if (gb.gear === 3) {
        upAt = t;
        break;
      }
    }
    expect(upAt - ended).toBeGreaterThanOrEqual(gapS);
    expect(upAt - ended).toBeLessThan(gapS + DT + 1e-9);
  });

  it('coasting down: one gear per shift at downshiftRpm, no hunting, ends in gear 1', () => {
    const gb = make('manual');
    // 1700 rpm in 5th sits inside the hysteresis band (downshift 1125 < 1700 < upshift 1809.5 at load 0)
    let t = climbTo(gb, 5, 0, vAt(5, 1700));
    gb.setMode('auto');
    const events: ShiftEvent[] = [];
    let lastT0 = gb.shift.t0;
    let v = vAt(5, 1700);
    for (; v > 0.3; v -= 1.0 * DT) {
      const before = gb.gear;
      const rpmBefore = gb.rpmInGear(before, v);
      stepAt(gb, t, { v, load: 0 });
      if (gb.shift.t0 !== lastT0) {
        expect(gb.gear).toBe(before - 1); // only downshifts, one gear at a time
        expect(rpmBefore).toBeLessThan(COMFORT.downshiftRpm(before, 0));
        expect(rpmBefore).toBeGreaterThan(COMFORT.downshiftRpm(before, 0) - 5);
        events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
        lastT0 = gb.shift.t0;
      }
      t += DT;
    }
    expect(events.map((e) => e.to)).toEqual([4, 3, 2, 1]);
    expect(gb.gear).toBe(1);
  });

  it('kickdown picks the lowest gear ≥ gear − 2 that lands ≤ upshiftRpm − 300', () => {
    const cases: [rpm5: number, expected: number][] = [
      [2000, 3], // 3rd = 3210 ≤ 5706 → two gears down
      [3800, 4], // 3rd = 6100 > 5706, 4th = 4700 ≤ 5706 → one gear down
      [4700, 5], // 4th = 5813 > 5706 → no kickdown (and no map downshift at 4700)
    ];
    for (const [rpm5, expected] of cases) {
      const gb = make('manual');
      const v = vAt(5, rpm5);
      const t = climbTo(gb, 5, 0, v);
      gb.setMode('auto');
      stepAt(gb, t, { v, load: 0.95, loadRate: 3 });
      expect(gb.gear, `rpm5=${rpm5}`).toBe(expected);
    }
    expect(COMFORT.kickdownMaxRpm(3, 0.95)).toBeCloseTo(5706.5, 0);
  });

  it('no kickdown when the load rises slowly (loadRate ≤ 1.2): only the one-gear map downshift', () => {
    const gb = make('manual');
    const v = vAt(5, 2000);
    const t = climbTo(gb, 5, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, load: 0.95, loadRate: 1 });
    expect(gb.gear).toBe(4);
  });

  it('kickdown from 2nd may drop to 1st', () => {
    const gb = make('manual');
    const v = vAt(2, 2500); // 1st = 3924 ≤ 5706
    const t = climbTo(gb, 2, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, load: 0.95, loadRate: 5 });
    expect(gb.gear).toBe(1);
  });

  it('A4: kickdown fires at load > 0.6 && loadRate > 1.2 (both thresholds needed)', () => {
    /** 5th at 2000 rpm, then one Auto step with the given load / loadRate; returns the new gear. */
    const at5 = (load: number, loadRate: number): number => {
      const gb = make('manual');
      const v = vAt(5, 2000);
      const t = climbTo(gb, 5, 0, v);
      gb.setMode('auto');
      stepAt(gb, t, { v, load, loadRate });
      return gb.gear;
    };
    // 3rd = 3210 ≤ kickdownMaxRpm(3, 0.65) → two gears down
    expect(COMFORT.kickdownMaxRpm(3, 0.65)).toBeGreaterThan(3210);
    expect(at5(0.65, 1.5)).toBe(3);
    expect(at5(0.7, 1.5)).toBe(3);
    // loadRate ≤ 1.2 → no kickdown, only the one-gear map downshift (downshiftRpm(5, 0.7) > 2000)
    expect(COMFORT.downshiftRpm(5, 0.7)).toBeGreaterThan(2000);
    expect(at5(0.7, 1.1)).toBe(4);
    // load ≤ 0.6 → no kickdown even with a fast rise, and the rise holds the map downshift too (A10b)
    expect(COMFORT.downshiftRpm(5, 0.55)).toBeGreaterThan(2000);
    expect(at5(0.55, 1.5)).toBe(5);
    expect(at5(0.55, 3)).toBe(5);
    // both thresholds are strict (A4: >): exactly at either one there is no kickdown — at load 0.6 the
    // rise (loadRate 1.5 > 1.2) still holds the map downshift (A10b), at loadRate 1.2 it goes ahead
    expect(COMFORT.downshiftRpm(5, 0.6)).toBeGreaterThan(2000);
    expect(at5(0.6, 1.5)).toBe(5);
    expect(at5(0.7, 1.2)).toBe(4);
  });

  // Kickdown latch (contract A10a, PC14 in the Gearbox class doc). In 7th at 2200 rpm, 5th turns 3096 rpm
  // and 4th 3830, both ≤ kickdownMaxRpm(·, 0.7) = 4312; at load 0.7 5th sits between its map downshift
  // (2797) and upshift (4612) points. load 0.7 / loadRate 1.5 is an A4 quantum a pedal step really
  // produces (loadRate ≈ (1 − load)/τ).
  const KD_TIP = { load: 0.7, loadRate: 1.5 };

  /** Auto Comfort in 7th at 2200 rpm, then one A4 quantum: the kickdown 7→5. Returns v and the next time. */
  function kickdownFrom7(): { gb: Gearbox; v: number; t: number } {
    const gb = make('manual');
    const v = vAt(7, 2200);
    const t = climbTo(gb, 7, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, ...KD_TIP });
    expect(gb.gear).toBe(5);
    expect(gb.shift.t0).toBe(t);
    return { gb, v, t: t + DT };
  }

  it.each([
    ['loadRate ≤ 1.2 (load still 0.7)', { load: 0.7, loadRate: 1.2 }],
    ['load ≤ 0.6 (loadRate still 1.5)', { load: 0.6, loadRate: 1.5 }],
  ])('kickdown latch: none again while A4 still holds; one quantum with %s re-arms it', (_name, rearm) => {
    const { gb, v, t: t1 } = kickdownFrom7();
    const t0 = gb.shift.t0;
    // 4th would be a second kickdown target, and 5th is above its map downshift point
    expect(gb.rpmInGear(4, v)).toBeLessThanOrEqual(COMFORT.kickdownMaxRpm(4, 0.7));
    expect(gb.rpmInGear(5, v)).toBeGreaterThan(COMFORT.downshiftRpm(5, 0.7));
    let t = stepN(gb, t1, Math.round(0.5 / DT), { v, ...KD_TIP }); // A4 holds on, well past the 0.1 s shift
    expect(gb.gear).toBe(5);
    expect(gb.shift.t0).toBe(t0);
    stepAt(gb, t, { v, ...rearm }); // trigger false for one quantum: re-armed, no shift
    expect(gb.gear).toBe(5);
    t += DT;
    stepAt(gb, t, { v, ...KD_TIP }); // the next tip-in kicks down again: 3rd = 4970 > 4312, 4th = 3830
    expect(gb.gear).toBe(4);
    expect(gb.shift.t0).toBe(t);
  });

  it('kickdown latch: a quantum without A4 while the kickdown shift is still in flight re-arms it', () => {
    const { gb, v, t: t1 } = kickdownFrom7();
    const tEnd = gb.shift.t0 + SHIFT_S;
    let t = stepN(gb, t1, 10, { v, ...KD_TIP });
    stepAt(gb, t, { v, load: 0.3, loadRate: -2 }); // a lift, mid-shift …
    expect(gb.shift.active).toBe(true);
    let downAt = Number.NaN;
    for (t += DT; t < tEnd + 0.3; t += DT) {
      stepAt(gb, t, { v, ...KD_TIP }); // … and the pedal goes down again
      if (gb.gear !== 5) {
        downAt = t;
        break;
      }
    }
    expect(gb.gear).toBe(4); // kicked down on the first quantum after the shift ended
    expect(downAt).toBeGreaterThanOrEqual(tEnd);
    expect(downAt).toBeLessThan(tEnd + DT + 1e-9);
  });

  it('kickdown latch: an A4 quantum that finds no target gear does not use the kickdown up', () => {
    const gb = make('manual');
    const v = vAt(6, 3400); // 5th 4101 rpm, 4th 5073; no map up/downshift in 6th at load 0.62 or 0.74
    let t = climbTo(gb, 6, 0, v);
    gb.setMode('auto');
    expect(gb.rpmInGear(5, v)).toBeGreaterThan(COMFORT.kickdownMaxRpm(5, 0.62)); // 3894
    expect(gb.rpmInGear(5, v)).toBeLessThanOrEqual(COMFORT.kickdownMaxRpm(5, 0.74)); // 4526
    stepAt(gb, t, { v, load: 0.62, loadRate: 1.9 }); // A4 holds, but no gear lands low enough yet
    expect(gb.gear).toBe(6);
    t += DT;
    stepAt(gb, t, { v, load: 0.74, loadRate: 1.3 }); // same tip-in, higher load: 5th qualifies
    expect(gb.gear).toBe(5);
    expect(gb.shift.t0).toBe(t);
  });

  it('kickdown latch: reset() re-arms it', () => {
    const { gb, v, t: t1 } = kickdownFrom7();
    gb.reset();
    gb.setMode('manual');
    // back to 7th with A4 holding on every quantum, so only reset() can have re-armed the latch
    const t = climbTo(gb, 7, t1, v, KD_TIP);
    gb.setMode('auto');
    stepAt(gb, t, { v, ...KD_TIP });
    expect(gb.gear).toBe(5); // the kickdown again (disarmed it would stay in 7th: A10b holds the map's 7→6)
  });

  /** Tip-in sweep: both drive modes × cruise throttle 0.1 / 0.2 / 0.3 × cruise speed 10–30 m/s (0.5 m/s). */
  function tipIns(): [DriveMode, number, number][] {
    const out: [DriveMode, number, number][] = [];
    for (const drive of ['comfort', 'sport'] as const) {
      for (const cruise of [0.1, 0.2, 0.3]) for (let v0 = 10; v0 <= 30; v0 += 0.5) out.push([drive, cruise, v0]);
    }
    return out;
  }

  it.each([
    ['DCT7', DCT7_SPEC],
    ['TC8', TC8_SPEC],
  ])(
    'A10 %s tip-ins via PedalPhysics + LoadEstimator: ≤ 1 kickdown (≤ 2 gears), no two Auto downshifts within 0.3 s',
    (_name, spec) => {
      // SimCore's demo/keyboard chain with MID_TESLA: throttle 0.35 up to v0, 4 s cruising at `cruise`, then
      // floored for 2 s. With τ = 0.2 s the A4 trigger holds ≈ 0.1 s per pedal step, about one DCT7 shift.
      // The contract rules alone (DCT7, measured) gave a second kickdown as the first ended (Comfort from
      // 10.5 m/s at 0.2: 4→3, then 3→2 0.1 s later), and with the latch alone map downshifts still cascaded
      // while the load rose (Sport from 20 m/s at 0.1: 6→5, 5→4, then the kickdown 4→3, within 0.25 s).
      // Map downshifts are held while loadRate > 1.2 (A10b), so a downshift that starts on a quantum where
      // the A4 trigger holds is the kickdown — the classification Task 8 uses.
      const c = rollingCircumferenceM(spec.gearbox.drivenTyre);
      const runs = tipIns();
      let kickdowns = 0;
      let spaced = 0; // tip-ins with a second downshift, i.e. where the spacing is exercised
      for (const [drive, cruise, v0] of runs) {
        const map = buildShiftMap(spec, drive);
        const gb = new Gearbox();
        gb.configure(spec, c, 'auto', drive);
        const car = new PedalPhysics();
        car.configure(MID_TESLA);
        const est = new LoadEstimator();
        est.configure(MID_TESLA);
        const run = `${drive}, ${cruise} → 1 at ${v0} m/s`;
        let tCruise = Number.NaN;
        let perTip = 0;
        let downs = 0;
        let lastDownT0 = -Infinity;
        for (let k = 0, t = 0; k < Math.round(40 / DT); k++, t += DT) {
          if (Number.isNaN(tCruise) && car.v >= v0) tCruise = t;
          if (t >= tCruise + 6) break;
          car.step(t >= tCruise + 4 ? 1 : Number.isNaN(tCruise) ? 0.35 : cruise, 0, DT);
          const load = est.update(car.v, car.a, DT);
          const from = gb.gear;
          gb.step(t, car.v, load, est.loadRate, false, car.v < 0.3, false);
          if (!(gb.shift.active && gb.shift.t0 === t && gb.gear < from)) continue;
          // an Auto downshift starts now (no paddles in this run, so no override coast-down)
          const at =
            `${run}: ${from}→${gb.gear} at ${t.toFixed(4)} s, ` +
            `load ${load.toFixed(3)}, loadRate ${est.loadRate.toFixed(3)}`;
          expect(t - lastDownT0, `${at}: start-to-start after the previous downshift`).toBeGreaterThan(0.3);
          lastDownT0 = t;
          downs++;
          if (load > 0.6 && est.loadRate > 1.2) {
            perTip++; // contract A4 holds on this step: the kickdown
            expect(from - gb.gear, `${at}: kickdown`).toBeLessThanOrEqual(2);
          } else {
            // a load-map downshift: one gear, called for by the map, never while the load still rises (A10b)
            expect(from - gb.gear, `${at}: map`).toBe(1);
            expect(est.loadRate, `${at}: map`).toBeLessThanOrEqual(1.2);
            expect(gb.rpmInGear(from, car.v), `${at}: map`).toBeLessThan(map.downshiftRpm(from, load));
          }
        }
        expect(tCruise, `${run}: cruise speed reached`).toBeLessThan(30);
        expect(perTip, `${run}: kickdowns in one tip-in`).toBeLessThanOrEqual(1);
        kickdowns += perTip;
        if (downs >= 2) spaced++;
      }
      // A4 really is reached through the estimator, and map downshifts do follow kickdowns (DCT7 246 and
      // 151, TC8 245 and 167 of 246)
      expect(kickdowns).toBeGreaterThan(runs.length / 2);
      expect(spaced).toBeGreaterThan(runs.length / 4);
    },
  );

  it('A10b: no map downshift while loadRate > 1.2; it starts on the first quantum at ≤ 1.2 (multi-step)', () => {
    const gb = make('manual');
    const v = vAt(5, 2000);
    let t = climbTo(gb, 5, 0, v);
    gb.setMode('auto');
    expect(2000).toBeLessThan(COMFORT.downshiftRpm(5, 0.5)); // ≈ 2182: the map wants 4th at load 0.5
    t = stepN(gb, t, Math.round(0.5 / DT), { v, load: 0.5, loadRate: 1.5 }); // load ≤ 0.6: no kickdown either
    expect(gb.gear).toBe(5);
    expect(gb.shift.active).toBe(false);
    stepAt(gb, t, { v, load: 0.5, loadRate: 1.2 });
    expect(gb.gear).toBe(4);
    expect(gb.shift.t0).toBe(t);
  });

  // [title, load, rpm in 7th, gears shifted into, gap after the previous downshift ended]. Comfort map
  // downshift points: load 0.5 → 7th 2313, 6th 2237, 5th 2182, 4th 2079; load 0.05 → 7th 1184, 6th 1145,
  // 5th 1125; load ≤ 0 → 1125 in every gear.
  it.each([
    ['load 0.5: spaced', 0.5, 1300, [6, 5, 4], 0.3],
    ['load 0.05: spaced', 0.05, 900, [6, 5], 0.3],
    ['load 0 (coast): not spaced', 0, 900, [6, 5], 0],
    ['load −0.3 (overrun): not spaced', -0.3, 900, [6, 5], 0],
  ])(
    'A10c %s: at load > 0 a map downshift starts ≥ 0.3 s after the previous Auto downshift ended (multi-step)',
    (_name, load, rpm7, gears, gapS) => {
      const gb = make('manual');
      const v = vAt(7, rpm7);
      let t = climbTo(gb, 7, 0, v, { clutchOpen: true }); // clutch open: no Manual anti-lug below 1100 rpm
      gb.setMode('auto');
      const tAuto = t;
      const events: ShiftEvent[] = [];
      let lastT0 = gb.shift.t0;
      for (const end = t + 2; t < end; t += DT) {
        const before = gb.gear;
        stepAt(gb, t, { v, load });
        if (gb.shift.t0 !== lastT0) {
          events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
          lastT0 = gb.shift.t0;
        }
      }
      expect(events.map((e) => e.to)).toEqual(gears);
      expect(events[0]?.t0).toBe(tAuto); // no earlier Auto downshift: the first one starts at once
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const cur = events[i];
        if (prev === undefined || cur === undefined) continue;
        const gap = cur.t0 - (prev.t0 + SHIFT_S);
        expect(gap, `${prev.to}→${cur.to}`).toBeGreaterThanOrEqual(gapS);
        expect(gap, `${prev.to}→${cur.to}`).toBeLessThan(gapS + DT + 1e-9);
      }
    },
  );

  it('A10c: the kickdown starts the spacing — the map downshift after it waits 0.3 s', () => {
    const { gb, v, t: t1 } = kickdownFrom7();
    const tEnd = gb.shift.t0 + SHIFT_S;
    // the rise is over (loadRate 0) at a high load: 5th (3096 rpm) is below its map downshift point, 4th is not
    expect(gb.rpmInGear(5, v)).toBeLessThan(COMFORT.downshiftRpm(5, 0.95)); // ≈ 3642
    expect(gb.rpmInGear(4, v)).toBeGreaterThan(COMFORT.downshiftRpm(4, 0.95)); // ≈ 3471
    let downAt = Number.NaN;
    for (let t = t1; t < tEnd + 1; t += DT) {
      stepAt(gb, t, { v, load: 0.95 });
      if (gb.gear !== 5) {
        downAt = t;
        break;
      }
    }
    expect(gb.gear).toBe(4);
    expect(downAt - tEnd).toBeGreaterThanOrEqual(0.3);
    expect(downAt - tEnd).toBeLessThan(0.3 + DT + 1e-9);
  });

  it('the override coast-down is neither held nor spaced, but starts the A10c spacing (multi-step)', () => {
    const gb = make('auto');
    const v4 = vAt(4, 1500); // gears 1–4 all turn ≥ 1200 rpm (coastDownRpm): no coast-down yet
    let t = climbTo(gb, 4, 0, v4, { load: 0.2 }); // paddles 1→2→3→4 in Auto
    const tOverrideEnd = gb.shift.t0 + 8;
    t = stepN(gb, t, Math.round((7.9 - t) / DT), { v: v4, load: 0.2 });
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    // slower: 4th 820 and 3rd 1064 rpm are below coastDownRpm, 2nd 1500 below downshiftRpm(2, 0.5) ≈ 1719
    const v = vAt(2, 1500);
    const tSlow = t;
    const events: ShiftEvent[] = [];
    let lastT0 = gb.shift.t0;
    for (; t < tSlow + 1; t += DT) {
      const before = gb.gear;
      // the load rises at kickdown pace while the box coasts down, then settles before the override ends
      stepAt(gb, t, { v, load: 0.5, loadRate: t < tSlow + 0.2 ? 1.5 : 0 });
      if (gb.shift.t0 !== lastT0) {
        events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
        lastT0 = gb.shift.t0;
      }
    }
    expect(events.map((e) => e.to)).toEqual([3, 2, 1]);
    const [c1, c2, mapDown] = events;
    if (c1 === undefined || c2 === undefined || mapDown === undefined) return;
    expect(c1.t0).toBe(tSlow); // not held by the rise (A10b is the map's)
    expect(c2.t0 - (c1.t0 + SHIFT_S)).toBeLessThan(DT + 1e-9); // not spaced
    expect(c2.t0).toBeLessThan(tOverrideEnd);
    expect(mapDown.t0).toBeGreaterThanOrEqual(tOverrideEnd);
    expect(mapDown.t0 - (c2.t0 + SHIFT_S)).toBeGreaterThanOrEqual(0.3); // spaced after the coast-down
    expect(mapDown.t0 - (c2.t0 + SHIFT_S)).toBeLessThan(0.3 + DT + 1e-9);
  });

  it('A10c: reset() clears the spacing timer (multi-step)', () => {
    const gb = make('manual');
    const v = vAt(2, 1500); // below downshiftRpm(2, 0.5) ≈ 1719; 1st turns 2355, below its upshift point
    let t = climbTo(gb, 2, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, load: 0.5 }); // map downshift 2→1: spacing until 0.4 s from now
    expect(gb.gear).toBe(1);
    const tDown = t;
    gb.reset();
    gb.setMode('manual');
    gb.request(+1);
    t += DT;
    stepAt(gb, t, { v, load: 0.5 }); // paddle 1→2 in Manual (no override)
    expect(gb.gear).toBe(2);
    const tPaddleEnd = t + SHIFT_S;
    gb.setMode('auto');
    let downAt = Number.NaN;
    for (t += DT; t < tDown + 1; t += DT) {
      stepAt(gb, t, { v, load: 0.5 });
      if (gb.gear === 1) {
        downAt = t;
        break;
      }
    }
    // on the first quantum after the paddle shift ended, inside the pre-reset spacing window
    expect(downAt - tPaddleEnd).toBeGreaterThanOrEqual(0);
    expect(downAt - tPaddleEnd).toBeLessThan(DT + 1e-9);
    expect(downAt - (tDown + SHIFT_S)).toBeLessThan(0.3);
  });

  it('paddle in Auto shifts, sets MANUAL_OVERRIDE for 8 s and suspends auto-upshifts meanwhile', () => {
    const gb = make('auto');
    let t = stepN(gb, 0, 10, { v: vAt(1, 2000), load: 0.2 });
    gb.request(+1);
    const tPaddle = t;
    stepAt(gb, t, { v: vAt(1, 2000), load: 0.2 });
    expect(gb.gear).toBe(2);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    const fast = vAt(2, 3000); // ≥ upshiftRpm(2, 0.2) = 2311 → would upshift without the override
    expect(3000).toBeGreaterThan(COMFORT.upshiftRpm(2, 0.2));
    let upAt = Number.NaN;
    for (t += DT; t < tPaddle + 9; t += DT) {
      stepAt(gb, t, { v: fast, load: 0.2 });
      const overriding = t < tPaddle + 8;
      expect(gb.flags & F.MANUAL_OVERRIDE).toBe(overriding ? F.MANUAL_OVERRIDE : 0);
      if (gb.gear === 3) {
        upAt = t;
        break;
      }
    }
    expect(upAt).toBeGreaterThanOrEqual(tPaddle + 8);
    expect(upAt).toBeLessThan(tPaddle + 8 + DT + 1e-9);
  });

  it('during the override the coast-down downshift still applies', () => {
    const gb = make('auto');
    const v = vAt(2, 1500); // 3rd would turn 1500·6.1/8.6 = 1064 < coastDownRpm 1200
    let t = stepN(gb, 0, 2, { v: vAt(1, 2000), load: 0.1 });
    gb.request(+1);
    t = stepN(gb, t, Math.ceil(SHIFT_S / DT) + 2, { v: vAt(1, 2000), load: 0.1 });
    expect(gb.gear).toBe(2);
    gb.request(+1); // the driver asks for 3rd at 1500 rpm
    stepAt(gb, t, { v, load: 0 });
    expect(gb.gear).toBe(3);
    stepN(gb, t + DT, Math.ceil(SHIFT_S / DT) + 2, { v, load: 0 });
    expect(gb.gear).toBe(2); // anti-lug back to 2nd, override still running
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
  });

  it('the override also suspends the map downshift and the kickdown (PC6), which resume when it ends', () => {
    const gb = make('auto');
    const v = vAt(2, 1500); // 2nd: above coastDownRpm 1200, below downshiftRpm(2, 0.95) ≈ 2870
    expect(gb.rpmInGear(2, v)).toBeLessThan(COMFORT.downshiftRpm(2, 0.95));
    gb.request(+1);
    stepAt(gb, 0, { v, load: 0.1 }); // paddle 1→2 at t = 0: override until 8 s
    expect(gb.gear).toBe(2);
    let t = DT;
    for (; t < 4; t += DT) {
      stepAt(gb, t, { v, load: 0.95 }); // without the override the map would go back to 1st
      expect(gb.gear).toBe(2);
    }
    for (; t < 8; t += DT) {
      stepAt(gb, t, { v, load: 0.95, loadRate: 3 }); // … and so would the kickdown
      expect(gb.gear).toBe(2);
    }
    stepAt(gb, t, { v, load: 0.95, loadRate: 3 }); // override over: the kickdown on the first quantum
    expect(gb.gear).toBe(1);
    expect(gb.shift.t0).toBe(t);
  });

  it('a refused paddle downshift in Auto raises SHIFT_REFUSED and no override', () => {
    const gb = make('manual');
    const v = vAt(3, 5000);
    const t = climbTo(gb, 3, 0, v);
    gb.setMode('auto');
    gb.request(-1);
    stepAt(gb, t, { v, load: 0.5 });
    expect(gb.gear).toBe(3);
    expect(gb.flags & F.SHIFT_REFUSED).toBe(F.SHIFT_REFUSED);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);
  });

  it('setMode(manual) ends the override; setDriveMode(sport) moves the upshift point', () => {
    const gb = make('auto');
    gb.request(+1);
    stepAt(gb, 0, { v: vAt(1, 2000), load: 0.2 });
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    gb.setMode('manual');
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);
    stepAt(gb, DT, { v: vAt(2, 2000), load: 0.2 });
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);

    const comfort = make('auto', 'comfort');
    const sport = make('auto', 'sport');
    const v = vAt(1, 3800); // comfort upshifts at 3598 (load 0.5), sport at 4005
    expect(SPORT.upshiftRpm(1, 0.5)).toBeGreaterThan(3800);
    stepAt(comfort, 0, { v, load: 0.5 });
    stepAt(sport, 0, { v, load: 0.5 });
    expect(comfort.gear).toBe(2);
    expect(sport.gear).toBe(1);
    sport.setDriveMode('comfort');
    stepAt(sport, DT, { v, load: 0.5 });
    expect(sport.gear).toBe(2);
  });

  it('setMode ends the override for good: back in Auto within 8 s there is no MANUAL_OVERRIDE and auto-upshifts resume', () => {
    const gb = make('auto');
    const slow = vAt(1, 2000); // 2nd turns 1274 rpm here: above coastDownRpm and the 1100 rpm anti-lug
    gb.request(+1);
    stepAt(gb, 0, { v: slow, load: 0.2 }); // paddle 1→2 at t = 0: override until 8 s, shift ends at 0.1 s
    expect(gb.gear).toBe(2);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    let t = stepN(gb, DT, 10, { v: slow, load: 0.2 });
    gb.setMode('manual');
    t = stepN(gb, t, 10, { v: slow, load: 0.2 });
    gb.setMode('auto');
    const v2 = vAt(2, 3000); // ≥ upshiftRpm(2, 0.2) = 2311, below redline
    expect(3000).toBeGreaterThan(COMFORT.upshiftRpm(2, 0.2));
    const ended = 0 + SHIFT_S;
    let upAt = Number.NaN;
    for (; t < 3; t += DT) {
      stepAt(gb, t, { v: v2, load: 0.2 });
      expect(gb.flags & F.MANUAL_OVERRIDE, `t = ${t.toFixed(4)}`).toBe(0);
      if (gb.gear === 3) {
        upAt = t;
        break;
      }
    }
    // only the 1.5 s minimum time in gear after the paddle shift ended — not the rest of the 8 s override
    expect(upAt - ended).toBeGreaterThanOrEqual(1.5);
    expect(upAt - ended).toBeLessThan(1.5 + DT + 1e-9);
  });

  it('over-speed (rpm ≥ redline): one upshift straight to the map gear without the minimum time, then nothing more', () => {
    const gb = make('auto');
    const v = 30; // 1st 12207 rpm ≥ redline; 6th 2848 ≥ upshiftRpm(6, 0.3) = 2701; 7th (top) 2442
    stepAt(gb, 0, { v, load: 0.3 });
    expect(gb.gear).toBe(7);
    expect(gb.shift.active && gb.shift.up && gb.shift.t0 === 0).toBe(true);
    expect(gb.shift.fromRpm).toBeCloseTo(gb.rpmInGear(1, v), 6);
    expect(gb.shift.toRpm).toBeCloseTo(gb.rpmInGear(7, v), 6);
    stepN(gb, DT, Math.round(2 / DT), { v, load: 0.3 }); // 7th sits above its downshift point: no further shift
    expect(gb.gear).toBe(7);
    expect(gb.shift.t0).toBe(0);
  });

  it('over-speed skip-shift never fires while predicting; the first quantum after prediction ends does it', () => {
    const gb = make('auto');
    const v = 30; // 1st turns 12207 rpm ≥ redline
    const t = stepN(gb, 0, 400, { v, load: 0.3, predicting: true });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    stepAt(gb, t, { v, load: 0.3 });
    expect(gb.gear).toBe(7);
    expect(gb.shift.t0).toBe(t);
  });

  it('over-speed skip-shift waits for a paddle override to end, then makes its one shift', () => {
    const gb = make('auto');
    const slow = vAt(1, 2000);
    let t = stepN(gb, 0, 2, { v: slow, load: 0.3 });
    const tPaddle = t;
    gb.request(+1);
    stepAt(gb, t, { v: slow, load: 0.3 }); // paddle 1→2: override until tPaddle + 8
    expect(gb.gear).toBe(2);
    const fast = vAt(2, 7200); // 2nd at/above redline: the over-speed path
    let upAt = Number.NaN;
    for (t += DT; t < tPaddle + 9; t += DT) {
      stepAt(gb, t, { v: fast, load: 0.3 });
      if (gb.gear !== 2) {
        upAt = t;
        break;
      }
    }
    expect(upAt).toBeGreaterThanOrEqual(tPaddle + 8);
    expect(upAt).toBeLessThan(tPaddle + 8 + DT + 1e-9);
    // one shift straight to the map gear: 5th turns 3181 ≥ upshiftRpm(5, 0.3) = 2701, 6th 2637 < upshiftRpm(6, 0.3)
    expect(gb.gear).toBe(6);
    expect(gb.shift.up && gb.shift.t0 === upAt).toBe(true);
  });

  it('WOT run: sequential upshifts at 0.9·redline, never overlapping, each landing ≥ coast-down + 300', () => {
    const gb = make('auto');
    const events: (ShiftEvent & { fromRpm: number; toRpm: number })[] = [];
    let lastT0 = Number.NaN;
    let v = 0.5;
    for (let t = 0; t < 40 && v < 80; t += DT) {
      stepAt(gb, t, { v, load: 1 });
      if (gb.shift.active && gb.shift.t0 !== lastT0) {
        events.push({ t0: gb.shift.t0, from: gb.gear - 1, to: gb.gear, fromRpm: gb.shift.fromRpm, toRpm: gb.shift.toRpm });
        lastT0 = gb.shift.t0;
      }
      v += 4 * DT;
    }
    expect(events.map((e) => e.to)).toEqual([2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e === undefined) continue;
      expect(e.fromRpm).toBeGreaterThanOrEqual(0.9 * 7000);
      expect(e.fromRpm).toBeLessThan(0.9 * 7000 + 10);
      expect(e.toRpm).toBeGreaterThanOrEqual(COMFORT.coastDownRpm + 300 - 1);
      const prev = events[i - 1];
      if (prev !== undefined) expect(e.t0).toBeGreaterThanOrEqual(prev.t0 + SHIFT_S);
    }
  });
});

describe('Gearbox — rev-match (spec §14)', () => {
  it('a downshift trajectory rev-matches: toRpm is the lower gear rpm, above fromRpm', () => {
    const gb = make('manual');
    const v = vAt(4, 3000);
    const t = climbTo(gb, 4, 0, v);
    gb.request(-1);
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
    expect(gb.shift.up).toBe(false);
    expect(gb.shift.fromRpm).toBeCloseTo(3000, 6);
    expect(gb.shift.toRpm).toBeCloseTo((3000 * 6.1) / 4.7, 6);
    expect(gb.shift.toRpm).toBeGreaterThan(gb.shift.fromRpm);
  });
});
