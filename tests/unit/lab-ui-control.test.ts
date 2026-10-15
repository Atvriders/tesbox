/**
 * src/lab/ui/lab-control.ts (phase-2c contract L2): the Sound Lab's control state — manual clamps, the five
 * events and segment playback — that the 'tesbox-lab' worklet steps every quantum and the page mirrors.
 * A literal spec keeps every expected number hand-checkable.
 */
import { describe, expect, it } from 'vitest';
import type { EngineSpec } from '../../src/contracts';
import { LabControl } from '../../src/lab/ui/lab-control';
import type { ManualControl } from '../../src/lab/ui/protocol';

/** idle 800, limiter 7000, four gears 15 / 10 / 8 / 6.4, 0.2 s shifts. */
const SPEC: EngineSpec = {
  layout: { type: 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2 },
  cycleDeg: 720,
  combustion: [
    { angleDeg: 0, bank: 0 },
    { angleDeg: 180, bank: 0 },
    { angleDeg: 360, bank: 0 },
    { angleDeg: 540, bank: 0 },
  ],
  rpm: { idle: 800, redline: 6500, limiter: { type: 'fuel-hard', rpm: 7000, hysteresisRpm: 200 } },
  aspiration: { type: 'na', turbo: null, supercharger: null },
  gearbox: { type: 'manual', overallRatios: [15, 10, 8, 6.4], drivenTyre: '225/40R18', shiftTimeS: 0.2, tc: null },
  sources: { layout: ['t'], combustion: ['t'], rpm: ['t'], aspiration: ['t'], gearbox: ['t'] },
};

const MANUAL: ManualControl = {
  rpm: 3000,
  load: 0.5,
  gear: 2,
  valve: 'auto',
  perspective: 'cabin',
  driveMode: 'comfort',
  warm: true,
};

function control(manual: Partial<ManualControl> = {}): LabControl {
  const c = new LabControl();
  c.configure(SPEC);
  c.setManual({ ...MANUAL, ...manual });
  return c;
}

describe('LabControl: manual control', () => {
  it('starts idling in 1st gear, engaged, warm, ignition on, no limiter, no shift', () => {
    const c = new LabControl();
    c.configure(SPEC);
    const ctl = c.step(0, 0.01);
    expect(ctl.rpm).toBe(800);
    expect(ctl.gear).toBe(1);
    expect(ctl.load).toBe(0);
    expect(ctl.driveline).toBe('engaged');
    expect(ctl.warm).toBe(true);
    expect(ctl.ignitionOn).toBe(true);
    expect(ctl.limiter).toBe(false);
    expect(ctl.shift.active).toBe(false);
  });

  it('renders the manual control every quantum (valve, perspective, drive mode and warm included)', () => {
    const c = control({ rpm: 4321, load: -0.4, gear: 3, valve: 'open', perspective: 'outside', driveMode: 'sport', warm: false });
    const ctl = c.step(1, 0.01);
    expect([ctl.rpm, ctl.load, ctl.gear, ctl.valve, ctl.perspective, ctl.driveMode, ctl.warm]).toEqual([
      4321,
      -0.4,
      3,
      'open',
      'outside',
      'sport',
      false,
    ]);
  });

  it('clamps rpm to [idle, limiter], load to [-1, 1] and gear to whole gears in [1, gears]', () => {
    expect(control({ rpm: 500 }).manual.rpm).toBe(800);
    expect(control({ rpm: 9000 }).manual.rpm).toBe(7000);
    expect(control({ load: 1.5 }).manual.load).toBe(1);
    expect(control({ load: -2 }).manual.load).toBe(-1);
    expect(control({ gear: 0 }).manual.gear).toBe(1);
    expect(control({ gear: 9 }).manual.gear).toBe(4);
    expect(control({ gear: 2.6 }).manual.gear).toBe(3);
  });

  it('keeps the previous value when a number is not finite', () => {
    const c = control({ rpm: 3000, load: 0.5, gear: 2 });
    c.setManual({ ...MANUAL, rpm: Number.NaN, load: Number.POSITIVE_INFINITY, gear: Number.NaN });
    expect([c.manual.rpm, c.manual.load, c.manual.gear]).toEqual([3000, 0.5, 2]);
  });

  it('re-clamps the manual control to a newly configured spec', () => {
    const c = control({ rpm: 6800, gear: 4 });
    c.configure({
      ...SPEC,
      rpm: { idle: 900, redline: 6000, limiter: { type: 'fuel-hard', rpm: 6200, hysteresisRpm: 200 } },
      gearbox: { ...SPEC.gearbox, overallRatios: [12, 8, 6] },
    });
    expect([c.manual.rpm, c.manual.gear]).toEqual([6200, 3]);
  });
});

describe('LabControl: events', () => {
  it('upshift: a shift from the current rpm to rpm·ratio[g+1]/ratio[g] at t0 = now, then gear + 1', () => {
    const c = control({ rpm: 6000, gear: 2 });
    expect(c.event('upshift', 5)).toBe(true);
    const ctl = c.step(5, 0.01);
    expect(ctl.shift).toEqual({ active: true, up: true, fromRpm: 6000, toRpm: 4800, t0: 5, durationS: 0.2 });
    expect(ctl.gear).toBe(3);
    expect(ctl.rpm).toBe(4800); // tracking continues at the new gear's rpm once the shift is over
    expect(c.manual.gear).toBe(3);
  });

  it('upshift in top gear changes nothing', () => {
    const c = control({ rpm: 5000, gear: 4 });
    expect(c.event('upshift', 1)).toBe(false);
    const ctl = c.step(1, 0.01);
    expect([ctl.gear, ctl.rpm, ctl.shift.active]).toEqual([4, 5000, false]);
  });

  it('upshift never takes the rpm below idle', () => {
    const c = control({ rpm: 900, gear: 1 }); // 900 · 10 / 15 = 600 < idle 800
    c.event('upshift', 2);
    const ctl = c.step(2, 0.01);
    expect(ctl.shift.toRpm).toBe(800);
    expect(ctl.gear).toBe(2);
  });

  it('downshift: a rev-matched blip to rpm·ratio[g−1]/ratio[g], then gear − 1', () => {
    const c = control({ rpm: 5000, gear: 3 });
    expect(c.event('downshift', 7)).toBe(true);
    const ctl = c.step(7, 0.01);
    expect(ctl.shift).toEqual({ active: true, up: false, fromRpm: 5000, toRpm: 6250, t0: 7, durationS: 0.2 });
    expect([ctl.gear, ctl.rpm]).toEqual([2, 6250]);
  });

  it('downshift clamps the blip to the limiter', () => {
    const c = control({ rpm: 6000, gear: 2 }); // 6000 · 15 / 10 = 9000
    c.event('downshift', 1);
    expect(c.step(1, 0.01).shift.toRpm).toBe(7000);
  });

  it('downshift in 1st changes nothing', () => {
    const c = control({ rpm: 3000, gear: 1 });
    expect(c.event('downshift', 1)).toBe(false);
    const ctl = c.step(1, 0.01);
    expect([ctl.gear, ctl.shift.active]).toEqual([1, false]);
  });

  it('a shift stays active for its duration, then ends', () => {
    const c = control({ rpm: 6000, gear: 2 });
    c.event('upshift', 10);
    expect(c.step(10.19, 0.01).shift.active).toBe(true);
    expect(c.step(10.2, 0.01).shift.active).toBe(false);
  });

  it('lift-off renders load 0 until the next manual control', () => {
    const c = control({ load: 0.8 });
    expect(c.event('liftoff', 1)).toBe(true);
    expect(c.step(1, 0.01).load).toBe(0);
    expect(c.step(2, 0.01).load).toBe(0);
    c.setManual({ ...MANUAL, load: 0.8 });
    expect(c.step(3, 0.01).load).toBe(0.8);
  });

  it('limiter toggles a hold at the limiter rpm with limiter: true', () => {
    const c = control({ rpm: 3000 });
    c.event('limiter', 1);
    let ctl = c.step(1, 0.01);
    expect([ctl.rpm, ctl.limiter]).toEqual([7000, true]);
    c.setManual({ ...MANUAL, rpm: 3500 }); // a manual control does not end the hold
    ctl = c.step(2, 0.01);
    expect([ctl.rpm, ctl.limiter]).toEqual([7000, true]);
    c.event('limiter', 3);
    ctl = c.step(3, 0.01);
    expect([ctl.rpm, ctl.limiter]).toEqual([3500, false]);
  });

  it('a shift out of a limiter hold starts from the limiter rpm and ends the hold', () => {
    const c = control({ rpm: 3000, gear: 2 });
    c.event('limiter', 1);
    c.event('upshift', 2);
    const ctl = c.step(2, 0.01);
    expect(ctl.shift).toMatchObject({ fromRpm: 7000, toRpm: 5600 });
    expect([ctl.limiter, ctl.gear, c.limiterHold]).toEqual([false, 3, false]);
  });

  it('ignition toggles ignitionOn; switching it on restarts runTimeS', () => {
    const c = control();
    c.step(0, 0.5);
    expect(c.step(0.5, 0.5).runTimeS).toBe(1);
    c.event('ignition', 1);
    let ctl = c.step(1, 0.5);
    expect([ctl.ignitionOn, ctl.runTimeS]).toEqual([false, 1]);
    c.event('ignition', 2);
    ctl = c.step(2, 0.25);
    expect([ctl.ignitionOn, ctl.runTimeS]).toEqual([true, 0.25]);
  });

  it('needs an engine: events before configure() change nothing', () => {
    const c = new LabControl();
    expect(c.event('upshift', 0)).toBe(false);
    expect(c.event('limiter', 0)).toBe(false);
    expect(c.limiterHold).toBe(false);
  });
});

describe('LabControl: segments', () => {
  it('loops a tools/segments.ts segment bound to the current spec instead of manual control', () => {
    const c = control({ rpm: 3000, gear: 2 });
    c.setSegment('wotPull', 100);
    expect(c.segmentName).toBe('wotPull');
    const first = c.step(100.05, 0.01);
    expect([first.gear, first.load]).toEqual([1, 1]);
    const r0 = first.rpm;
    const r1 = c.step(100.5, 0.01).rpm;
    expect(r0).toBeGreaterThanOrEqual(800);
    expect(r1).toBeGreaterThan(r0 + 300); // a wide-open pull from idle in 1st
    const end = c.step(111.9, 0.01); // the pull's final limiter hold in 4th
    expect([end.rpm, end.gear, end.limiter]).toEqual([7000, 4, true]);
    const looped = c.step(112.05, 0.01).rpm; // 12 s segment: back to its start
    expect(looped).toBeCloseTo(r0, 6);
  });

  it('gives the segment shifts absolute start times', () => {
    const c = control();
    c.setSegment('wotPull', 100);
    const shiftT0s: number[] = [];
    for (let t = 100; t < 112; t += 0.005) {
      const ctl = c.step(t, 0.005);
      if (ctl.shift.active) shiftT0s.push(ctl.shift.t0);
    }
    expect(shiftT0s.length).toBeGreaterThan(0);
    for (const t0 of shiftT0s) expect(t0).toBeGreaterThan(100);
  });

  it('returns to the manual control on null', () => {
    const c = control({ rpm: 3000, gear: 2, load: 0.5 });
    c.setSegment('limiterHold', 0);
    expect(c.step(1, 0.01).rpm).toBe(7000);
    c.setSegment(null, 2);
    const ctl = c.step(2, 0.01);
    expect([ctl.rpm, ctl.gear, ctl.load, ctl.limiter, ctl.shift.active, c.segmentName]).toEqual([3000, 2, 0.5, false, false, null]);
  });

  it('rejects an unknown segment name and keeps the current playback', () => {
    const c = control();
    c.setSegment('idle', 0);
    expect(() => c.setSegment('warp', 1)).toThrow(/warp/);
    expect(c.segmentName).toBe('idle');
  });

  it('ignores shifts, lift-off and the limiter while a segment plays; ignition still toggles', () => {
    const c = control({ rpm: 3000, gear: 2 });
    c.setSegment('cruise4k', 0);
    expect(c.event('upshift', 1)).toBe(false);
    expect(c.event('downshift', 1)).toBe(false);
    expect(c.event('liftoff', 1)).toBe(false);
    expect(c.event('limiter', 1)).toBe(false);
    expect(c.manual.gear).toBe(2);
    expect(c.event('ignition', 1)).toBe(true);
    expect(c.step(1, 0.01).ignitionOn).toBe(false);
  });
});
