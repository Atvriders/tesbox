import { describe, expect, it } from 'vitest';
import type { DspControl, EngineSpec, GearboxType, LimiterType } from '../../src/contracts';
import { RpmState, SHIFT_CUT_END, SHIFT_HOLD_END, shiftTrajectoryRpm } from '../../src/dsp/rpm-state';

const FS = 48000;
const DT = 1 / FS;

interface SpecOpts {
  gearbox?: GearboxType;
  limiter?: LimiterType;
  limiterRpm?: number;
  hysteresisRpm?: number;
}

function makeSpec(o: SpecOpts = {}): EngineSpec {
  const gearbox = o.gearbox ?? 'dct';
  return {
    layout: { type: 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2 },
    cycleDeg: 720,
    combustion: [
      { angleDeg: 0, bank: 0 },
      { angleDeg: 180, bank: 0 },
      { angleDeg: 360, bank: 0 },
      { angleDeg: 540, bank: 0 },
    ],
    rpm: {
      idle: 850,
      redline: 7000,
      limiter: { type: o.limiter ?? 'ignition-hard', rpm: o.limiterRpm ?? 7100, hysteresisRpm: o.hysteresisRpm ?? 150 },
    },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: {
      type: gearbox,
      overallRatios: [13.1, 8.4, 6.1, 4.8, 4.0, 3.4],
      drivenTyre: '225/40R18',
      shiftTimeS: 0.1,
      tc: gearbox === 'tc-auto' ? { stallRpmWot: 2400, lockupTurbineRpm: 1500, couplingSR: 0.9 } : null,
    },
    sources: { layout: ['test'], combustion: ['test'], rpm: ['test'], aspiration: ['test'], gearbox: ['test'] },
  };
}

function makeCtl(rpm: number): DspControl {
  return {
    rpm,
    load: 0.5,
    gear: 3,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0.1 },
    ignitionOn: true,
    runTimeS: 10,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
  };
}

function makeState(o: SpecOpts = {}, rpm = 0): RpmState {
  const s = new RpmState(FS);
  s.configure(makeSpec(o));
  s.reset(rpm);
  return s;
}

interface Trace {
  rpm: Float64Array;
  cut: Uint8Array;
  cutIgn: Uint8Array;
  falling: Uint8Array;
}

/** Ticks `samples` times starting at time t0S, recording every output. */
function run(s: RpmState, ctl: DspControl, samples: number, t0S = 0): Trace {
  const tr: Trace = {
    rpm: new Float64Array(samples),
    cut: new Uint8Array(samples),
    cutIgn: new Uint8Array(samples),
    falling: new Uint8Array(samples),
  };
  for (let k = 0; k < samples; k++) {
    s.tick(ctl, t0S + k * DT);
    tr.rpm[k] = s.rpm;
    tr.cut[k] = s.cut ? 1 : 0;
    tr.cutIgn[k] = s.cutIsIgnition ? 1 : 0;
    tr.falling[k] = s.falling ? 1 : 0;
  }
  return tr;
}

function at(xs: ArrayLike<number>, i: number): number {
  const v = xs[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${xs.length})`);
  return v;
}

/** Cut→fire transitions and the longest continuous cut (in samples) of a cut trace. */
function cutStats(cut: Uint8Array): { transitions: number; longest: number } {
  let transitions = 0;
  let longest = 0;
  let runLen = 0;
  for (let k = 0; k < cut.length; k++) {
    if (at(cut, k) === 1) {
      runLen++;
      longest = Math.max(longest, runLen);
    } else {
      if (runLen > 0) transitions++;
      runLen = 0;
    }
  }
  return { transitions, longest };
}

describe('shiftTrajectoryRpm', () => {
  it('holds fromRpm until u = 0.3, cosine-eases to toRpm by u = 1, then stays there', () => {
    expect(SHIFT_HOLD_END).toBe(0.3);
    expect(SHIFT_CUT_END).toBe(0.4);
    for (const u of [Number.NaN, -0.5, 0, 0.1, 0.3]) expect(shiftTrajectoryRpm(u, 6500, 4200)).toBe(6500);
    expect(shiftTrajectoryRpm(0.65, 6500, 4200)).toBeCloseTo(5350, 9); // midpoint of the ease
    expect(shiftTrajectoryRpm(1, 6500, 4200)).toBe(4200);
    expect(shiftTrajectoryRpm(3, 6500, 4200)).toBe(4200);
    let prev = 6500;
    for (let u = 0.3; u <= 1; u += 0.001) {
      const r = shiftTrajectoryRpm(u, 6500, 4200);
      expect(r).toBeLessThanOrEqual(prev + 1e-9); // monotone for an upshift
      prev = r;
    }
    // C¹ at both ends of the ease (zero slope): a 1e-4 step in u moves rpm by < 0.01
    expect(Math.abs(shiftTrajectoryRpm(0.3001, 6500, 4200) - 6500)).toBeLessThan(0.01);
    expect(Math.abs(shiftTrajectoryRpm(0.9999, 6500, 4200) - 4200)).toBeLessThan(0.01);
    // downshift (rev-match blip) rises
    expect(shiftTrajectoryRpm(0.65, 3000, 5000)).toBeCloseTo(4000, 9);
  });
});

describe('RpmState: tracking', () => {
  it('rejects bad sample rates', () => {
    expect(() => new RpmState(0)).toThrow(RangeError);
    expect(() => new RpmState(Number.NaN)).toThrow(RangeError);
  });

  it('reset(rpm) sets rpm immediately; configure() resets to 0', () => {
    const s = makeState({}, 1234);
    expect(s.rpm).toBe(1234);
    expect(s.cut).toBe(false);
    expect(s.cutIsIgnition).toBe(false);
    expect(s.falling).toBe(false);
    s.configure(makeSpec());
    expect(s.rpm).toBe(0);
    s.reset();
    expect(s.rpm).toBe(0);
    s.reset(Number.NaN);
    expect(s.rpm).toBe(0);
  });

  it('follows ctl.rpm through a one-pole with τ = 40 ms across successive steps', () => {
    const s = makeState({}, 1000);
    const ctl = makeCtl(2000);
    const a = run(s, ctl, Math.round(0.04 * FS));
    expect(at(a.rpm, a.rpm.length - 1)).toBeCloseTo(1000 + 1000 * (1 - Math.exp(-1)), 0); // ≈ 1632
    run(s, ctl, Math.round(0.36 * FS));
    expect(Math.abs(s.rpm - 2000)).toBeLessThan(0.2); // 10 τ
    ctl.rpm = 1500;
    const b = run(s, ctl, Math.round(0.04 * FS));
    expect(at(b.rpm, b.rpm.length - 1)).toBeCloseTo(2000 - 500 * (1 - Math.exp(-1)), 0); // ≈ 1684
    for (let k = 0; k < b.cut.length; k++) expect(at(b.cut, k)).toBe(0);
  });

  it('holds on a NaN target, floors negative targets at 0 and caps +Infinity', () => {
    const s = makeState({}, 3000);
    run(s, makeCtl(Number.NaN), 4800);
    expect(s.rpm).toBe(3000);
    run(s, makeCtl(-500), FS);
    expect(s.rpm).toBeGreaterThanOrEqual(0);
    expect(s.rpm).toBeLessThan(1e-6);
    run(s, makeCtl(Number.POSITIVE_INFINITY), FS);
    expect(Number.isFinite(s.rpm)).toBe(true);
    expect(s.rpm).toBeLessThanOrEqual(30000);
  });
});

describe('RpmState: shift trajectory', () => {
  const cases: [GearboxType, boolean][] = [
    ['dct', true],
    ['pdk', true],
    ['amt', true],
    ['manual', false],
    ['tc-auto', false],
  ];
  for (const [gearbox, fart] of cases) {
    it(`${gearbox}: holds, cuts for u < 0.4 (ignition cut: ${fart}), eases, then tracks from toRpm`, () => {
      const s = makeState({ gearbox }, 6500);
      const ctl = makeCtl(4300);
      const t0 = 1;
      const dur = 0.1;
      ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0, durationS: dur };
      const n = Math.round(dur * FS); // 4800 samples, u = k / 4800
      const tr = run(s, ctl, n, t0);
      let wrong = 0;
      for (let k = 0; k < n; k++) {
        const u = k / n;
        if (Math.abs(at(tr.rpm, k) - shiftTrajectoryRpm(u, 6500, 4200)) > 1e-6) wrong++;
        if (k === 1920) continue; // u = 0.4 exactly: the cut flag may flip on a 1-ulp rounding of nowS
        const cutExpected = u < 0.4 ? 1 : 0;
        if (at(tr.cut, k) !== cutExpected) wrong++;
        if (at(tr.cutIgn, k) !== (fart ? cutExpected : 0)) wrong++;
      }
      expect(wrong).toBe(0);
      expect(at(tr.rpm, 0)).toBe(6500);
      expect(at(tr.cut, 1919)).toBe(1); // u ≈ 0.3998
      expect(at(tr.cut, 1921)).toBe(0); // u ≈ 0.4002
      // SimCore clears `active` after the shift: tracking resumes from toRpm, not from ctl.rpm
      ctl.shift.active = false;
      s.tick(ctl, t0 + dur);
      const k1 = 1 - Math.exp(-1 / (0.04 * FS));
      expect(s.rpm).toBeCloseTo(4200 + k1 * (4300 - 4200), 3);
      expect(s.cut).toBe(false);
      expect(s.cutIsIgnition).toBe(false);
      run(s, ctl, Math.round(0.4 * FS), t0 + dur + DT);
      expect(Math.abs(s.rpm - 4300)).toBeLessThan(0.1);
    });
  }

  it('a completed shift whose `active` flag lingers resumes tracking from toRpm', () => {
    const s = makeState({}, 6500);
    const ctl = makeCtl(4300);
    ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0: 0, durationS: 0.1 };
    run(s, ctl, 4800, 0);
    s.tick(ctl, 0.1); // u = 1 while still active
    expect(s.rpm).toBeGreaterThan(4200);
    expect(s.rpm).toBeLessThan(4201);
    expect(s.cut).toBe(false);
  });

  it('before t0 the trajectory holds fromRpm with the cut active', () => {
    const s = makeState({ gearbox: 'manual' }, 5000);
    const ctl = makeCtl(5000);
    ctl.shift = { active: true, up: true, fromRpm: 5200, toRpm: 3500, t0: 2, durationS: 0.3 };
    s.tick(ctl, 1.99);
    expect(s.rpm).toBe(5200);
    expect(s.cut).toBe(true);
    expect(s.cutIsIgnition).toBe(false);
  });

  it('an aborted shift (active cleared mid-ease) continues from the current rpm without a jump', () => {
    const s = makeState({}, 6500);
    const ctl = makeCtl(4200);
    ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 2400, 0); // up to u = 0.5
    const last = at(tr.rpm, tr.rpm.length - 1);
    ctl.shift.active = false;
    ctl.rpm = 6000;
    s.tick(ctl, 0.05);
    expect(Math.abs(s.rpm - last)).toBeLessThan(2);
  });

  it('a downshift blip rises from fromRpm to toRpm', () => {
    const s = makeState({ gearbox: 'pdk' }, 3000);
    const ctl = makeCtl(5000);
    ctl.shift = { active: true, up: false, fromRpm: 3000, toRpm: 5000, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 4800, 0);
    expect(at(tr.rpm, 0)).toBe(3000);
    expect(at(tr.rpm, 3120)).toBeCloseTo(4000, 6); // u = 0.65
    expect(at(tr.rpm, 4799)).toBeGreaterThan(4999);
  });

  it('takes priority over the limiter', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    ctl.shift = { active: true, up: true, fromRpm: 7100, toRpm: 5000, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 4800, 0);
    for (let k = 0; k < 4800; k += 100) expect(at(tr.rpm, k)).toBeCloseTo(shiftTrajectoryRpm(k / 4800, 7100, 5000), 6);
  });
});

describe('RpmState: limiter bounce (8–20 Hz, cuts ≤ 100 ms)', () => {
  const types: LimiterType[] = ['ignition-hard', 'ignition-soft', 'fuel-hard', 'fuel-soft'];
  for (const limiter of types) {
    it(`${limiter}: 2 s hold → 8–20 cut→fire transitions/s, longest cut ≤ 100 ms, rpm within the hysteresis band`, () => {
      const s = makeState({ limiter }, 7100);
      const ctl = makeCtl(7100);
      ctl.limiter = true;
      const tr = run(s, ctl, 2 * FS);
      const { transitions, longest } = cutStats(tr.cut);
      expect(transitions / 2).toBeGreaterThanOrEqual(8);
      expect(transitions / 2).toBeLessThanOrEqual(20);
      expect(longest).toBeLessThanOrEqual(0.1 * FS);
      let outOfBand = 0;
      let wrongType = 0;
      for (let k = 0; k < tr.rpm.length; k++) {
        const r = at(tr.rpm, k);
        if (r < 7100 - 150 - 1e-6 || r > 7100 + 1e-6) outOfBand++;
        // B5: `cut` covers the whole cut phase for every type; the cut type follows the limiter type
        if (at(tr.cutIgn, k) !== (limiter.startsWith('ignition') ? at(tr.cut, k) : 0)) wrongType++;
      }
      expect(outOfBand).toBe(0);
      expect(wrongType).toBe(0);
      // the cut phase is the falling half of the saw-tooth
      let cutSamples = 0;
      for (let k = 0; k < tr.cut.length; k++) cutSamples += at(tr.cut, k);
      expect(cutSamples / tr.cut.length).toBeGreaterThan(0.4);
      expect(cutSamples / tr.cut.length).toBeLessThan(0.6);
    });
  }

  it('keeps 8–20 Hz for tiny, zero and large hysteresis values', () => {
    for (const hysteresisRpm of [0, 20, 400]) {
      const s = makeState({ hysteresisRpm }, 7100);
      const ctl = makeCtl(7100);
      ctl.limiter = true;
      const { transitions, longest } = cutStats(run(s, ctl, 2 * FS).cut);
      expect(transitions / 2).toBeGreaterThanOrEqual(8);
      expect(transitions / 2).toBeLessThanOrEqual(20);
      expect(longest).toBeLessThanOrEqual(0.1 * FS);
    }
  });

  it('entered from below: rises without cutting, then bounces; on release tracking resumes without a jump', () => {
    const s = makeState({}, 5000);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    const tr = run(s, ctl, FS);
    let firstCut = -1;
    for (let k = 0; k < tr.cut.length && firstCut < 0; k++) if (at(tr.cut, k) === 1) firstCut = k;
    expect(firstCut).toBeGreaterThan(0);
    expect(firstCut).toBeLessThan(0.3 * FS);
    for (let k = 1; k < firstCut; k++) expect(at(tr.rpm, k)).toBeGreaterThan(at(tr.rpm, k - 1));
    const { transitions } = cutStats(tr.cut.subarray(firstCut));
    expect(transitions).toBeGreaterThanOrEqual(6);
    const before = s.rpm;
    ctl.limiter = false;
    ctl.rpm = 6000;
    s.tick(ctl, 1);
    expect(s.cut).toBe(false);
    expect(Math.abs(s.rpm - before)).toBeLessThan(1); // continuous
  });
});

describe('RpmState: falling', () => {
  it('is false when steady or rising, true while decreasing, and clears ~20 ms after rpm settles', () => {
    const s = makeState({}, 3000);
    const steady = run(s, makeCtl(3000), 4800);
    expect(steady.falling.every((f) => f === 0)).toBe(true);
    const rising = run(s, makeCtl(4000), 4800);
    expect(rising.falling.every((f) => f === 0)).toBe(true);
    run(s, makeCtl(4000), FS); // settle at 4000
    const drop = run(s, makeCtl(2000), Math.round(0.1 * FS));
    expect(at(drop.falling, 2)).toBe(1);
    for (let k = 2; k < drop.falling.length; k++) expect(at(drop.falling, k)).toBe(1);
    run(s, makeCtl(2000), FS); // settle at 2000
    const settled = run(s, makeCtl(2000), Math.round(0.03 * FS));
    expect(settled.falling.every((f) => f === 0)).toBe(true);
  });

  it('turns true ≈ 10 ms into each limiter cut phase (the 20 ms look-back first straddles the rise)', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    const tr = run(s, ctl, FS);
    let cutAndFalling = 0;
    let cutSamples = 0;
    for (let k = 0; k < tr.cut.length; k++) {
      if (at(tr.cut, k) === 1) {
        cutSamples++;
        cutAndFalling += at(tr.falling, k);
      }
    }
    expect(cutAndFalling / cutSamples).toBeGreaterThan(0.75); // ≈ 40 of every 50 ms
  });
});

describe('RpmState: reset mid-event', () => {
  it('clears an active limiter bounce and shift', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    run(s, ctl, 1000);
    expect(s.cut).toBe(true);
    s.reset(2000);
    expect(s.rpm).toBe(2000);
    expect(s.cut).toBe(false);
    expect(s.cutIsIgnition).toBe(false);
    expect(s.falling).toBe(false);
    ctl.limiter = false;
    ctl.rpm = 2000;
    run(s, ctl, 960);
    expect(s.rpm).toBe(2000);
    expect(s.falling).toBe(false);
  });
});

describe('RpmState: shifting (which source owns a cut, for the B5 skip mask)', () => {
  it('is true exactly while a sample follows the trajectory (t0 still ahead through u < 1); false after completion, abort and reset', () => {
    const s = makeState({}, 6500);
    expect(s.shifting).toBe(false);
    const ctl = makeCtl(4300);
    ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0: 0.01, durationS: 0.1 };
    let notShifting = 0;
    for (let k = 0; k < 5280; k++) {
      s.tick(ctl, k * DT); // the first 480 samples precede t0, the rest have u = (k − 480) / 4800 < 1
      if (!s.shifting) notShifting++;
    }
    expect(notShifting).toBe(0);
    s.tick(ctl, 0.12); // u = 1.1 with `active` still set: completed, tracking resumes from toRpm
    expect(s.shifting).toBe(false);
    expect(s.cut).toBe(false);
    // abort: a new shift whose `active` flag clears mid-ease
    ctl.shift = { active: true, up: true, fromRpm: s.rpm, toRpm: 3000, t0: 1, durationS: 0.1 };
    s.tick(ctl, 1.05);
    expect(s.shifting).toBe(true);
    ctl.shift.active = false;
    s.tick(ctl, 1.06);
    expect(s.shifting).toBe(false);
    // reset mid-shift clears it
    ctl.shift.active = true;
    s.tick(ctl, 1.07);
    expect(s.shifting).toBe(true);
    s.reset(3000);
    expect(s.shifting).toBe(false);
  });

  it('is false for limiter cuts: a completed shift whose `active` flag lingers with ctl.limiter set runs the bounce', () => {
    // manual gearbox + ignition-soft limiter: the shift cut is a fuel cut, the limiter cut an ignition cut
    const s = makeState({ gearbox: 'manual', limiter: 'ignition-soft' }, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    ctl.shift = { active: true, up: true, fromRpm: 7100, toRpm: 7100, t0: 0, durationS: 0.1 };
    let wrong = 0;
    for (let k = 0; k < 4800; k++) {
      s.tick(ctl, k * DT); // u = k / 4800 < 1: the trajectory has priority over the limiter
      if (!s.shifting || s.cutIsIgnition) wrong++;
      if (k !== 1920 && s.cut !== (k < 1920)) wrong++; // shift cut for u < 0.4 (u = 0.4 itself may round either way)
    }
    let limiterCuts = 0;
    for (let k = 4801; k < 4801 + 2 * 4800; k++) {
      s.tick(ctl, k * DT); // u > 1 while `active` lingers: the limiter bounce owns the cut
      if (s.shifting || s.cutIsIgnition !== s.cut) wrong++;
      if (s.cut) limiterCuts++;
    }
    expect(wrong).toBe(0);
    expect(limiterCuts).toBeGreaterThan(0.4 * 2 * 4800);
  });
});
