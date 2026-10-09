/**
 * Fixed render segments for tesbox-render / tesbox-score (spec §11.1). Each segment mutates a
 * DspControl in place for segment-relative time t (s); pass the same t as render()'s nowS so
 * ShiftState.t0 values line up. Segments need engine numbers (idle, redline, limiter, ratios, shift
 * time): call bindSegmentEngine(spec) before using SEGMENTS. Phase 2a has no SimCore, so rpm
 * trajectories are simple kinematic profiles (constant vehicle acceleration per gear).
 * Segment ctl() and playSegments() never allocate (tools/check-alloc.ts drives them per quantum).
 */
import type { DspControl, EngineSpec, Perspective } from '../src/contracts';

export interface Segment {
  name: string;
  durationS: number;
  ctl(t: number, base: DspControl): void;
}

interface Phase {
  t0: number;
  t1: number;
  gear: number;
  rpm0: number;
  rpm1: number;
  /** True for shift phases: ShiftState {fromRpm, toRpm = rpm0, t0} is active while t ∈ [t0, t1). */
  shift: boolean;
  fromRpm: number;
  limiter: boolean;
}

interface Bound {
  idle: number;
  redline: number;
  limiterRpm: number;
  shiftTimeS: number;
  wot: Phase[];
  auto: Phase[];
}

let bound: Bound | null = null;

function engine(): Bound {
  if (bound === null) throw new Error('segments: call bindSegmentEngine(spec) before using SEGMENTS');
  return bound;
}

/**
 * Pull through gears 1..G (G = min(gears, ratios)): rpm climbs from `startRpm` in gear 1, upshifts at
 * `shiftRpm` (each a ShiftState of spec.gearbox.shiftTimeS), climbs in gear G to `finalRpm`, then
 * holds (limiter flag set when `limiter`). Climb rate in gear g ∝ ratio g (constant vehicle
 * acceleration), scaled so that the climbs plus the shifts end at `climbS`.
 */
function buildPull(
  spec: EngineSpec,
  gears: number,
  startRpm: number,
  shiftRpm: number,
  finalRpm: number,
  climbS: number,
  totalS: number,
  limiter: boolean,
): Phase[] {
  const ratios = spec.gearbox.overallRatios;
  const g = Math.max(1, Math.min(gears, ratios.length));
  const r = (gear: number): number => ratios[gear - 1] ?? 1;
  const r1 = r(1);
  const shiftS = spec.gearbox.shiftTimeS;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let gear = 1; gear <= g; gear++) {
    starts.push(gear === 1 ? startRpm : (shiftRpm * r(gear)) / r(gear - 1));
    ends.push(gear === g ? finalRpm : shiftRpm);
  }
  let weighted = 0; // Σ (end − start) · r1 / r_g  →  climb time = weighted / rate1
  for (let gear = 1; gear <= g; gear++) {
    weighted += (((ends[gear - 1] ?? 0) - (starts[gear - 1] ?? 0)) * r1) / r(gear);
  }
  const rate1 = weighted / Math.max(0.5, climbS - (g - 1) * shiftS);
  const phases: Phase[] = [];
  let t = 0;
  for (let gear = 1; gear <= g; gear++) {
    const s = starts[gear - 1] ?? 0;
    const e = ends[gear - 1] ?? 0;
    const dur = (e - s) / ((rate1 * r(gear)) / r1);
    phases.push({ t0: t, t1: t + dur, gear, rpm0: s, rpm1: e, shift: false, fromRpm: s, limiter: false });
    t += dur;
    if (gear < g) {
      const to = starts[gear] ?? 0;
      phases.push({ t0: t, t1: t + shiftS, gear: gear + 1, rpm0: to, rpm1: to, shift: true, fromRpm: e, limiter: false });
      t += shiftS;
    }
  }
  phases.push({ t0: t, t1: Math.max(t, totalS), gear: g, rpm0: finalRpm, rpm1: finalRpm, shift: false, fromRpm: finalRpm, limiter });
  return phases;
}

/** Binds SEGMENTS to an engine (idle, redline, limiter, ratios, shift time). */
export function bindSegmentEngine(spec: EngineSpec): void {
  const idle = spec.rpm.idle;
  const redline = spec.rpm.redline;
  const limiterRpm = spec.rpm.limiter.rpm;
  bound = {
    idle,
    redline,
    limiterRpm,
    shiftTimeS: spec.gearbox.shiftTimeS,
    wot: buildPull(spec, 4, idle, redline, limiterRpm, 9, 12, true),
    auto: buildPull(spec, 4, idle, 0.65 * redline, 0.65 * redline, 8, 10, false),
  };
}

/** A warm, running control with the app defaults (valve auto, comfort), idling in gear 1. */
export function createBaseControl(spec: EngineSpec, perspective: Perspective = 'cabin'): DspControl {
  return {
    rpm: spec.rpm.idle,
    load: 0,
    gear: 1,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: spec.rpm.idle, toRpm: spec.rpm.idle, t0: 0, durationS: spec.gearbox.shiftTimeS },
    ignitionOn: true,
    runTimeS: 600,
    valve: 'auto',
    perspective,
    driveMode: 'comfort',
    warm: true,
  };
}

function steady(base: DspControl, rpm: number, load: number, gear: number): void {
  base.rpm = rpm;
  base.load = load;
  base.gear = gear;
  base.driveline = 'engaged';
  base.limiter = false;
  base.shift.active = false;
}

function cruiseRpm(target: number): number {
  return Math.min(target, engine().redline - 500);
}

function followPull(phases: Phase[], t: number, base: DspControl, load: number): void {
  const b = engine();
  let ph = phases[phases.length - 1];
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p !== undefined && t < p.t1) {
      ph = p;
      break;
    }
  }
  if (ph === undefined) return;
  const u = ph.t1 > ph.t0 ? Math.min(1, Math.max(0, (t - ph.t0) / (ph.t1 - ph.t0))) : 1;
  base.rpm = ph.rpm0 + (ph.rpm1 - ph.rpm0) * u;
  base.load = load;
  base.gear = ph.gear;
  base.driveline = 'engaged';
  base.limiter = ph.limiter;
  const s = base.shift;
  if (ph.shift) {
    s.active = true;
    s.up = true;
    s.fromRpm = ph.fromRpm;
    s.toRpm = ph.rpm0;
    s.t0 = ph.t0;
    s.durationS = b.shiftTimeS;
  } else {
    s.active = false;
  }
}

export const SEGMENTS: Segment[] = [
  {
    name: 'idle',
    durationS: 5,
    ctl(_t, base) {
      steady(base, engine().idle, 0, 1);
      base.driveline = 'clutch-open';
    },
  },
  {
    name: 'cruise2k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(2000), 0.3, 3);
    },
  },
  {
    name: 'cruise4k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(4000), 0.3, 3);
    },
  },
  {
    name: 'cruise6k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(6000), 0.3, 3);
    },
  },
  {
    name: 'wotPull',
    durationS: 12,
    ctl(t, base) {
      followPull(engine().wot, t, base, 1);
    },
  },
  {
    name: 'liftoff6k',
    durationS: 6,
    ctl(t, base) {
      const b = engine();
      const start = cruiseRpm(6000);
      const end = b.idle + 200;
      if (t < 0.5) {
        steady(base, start, 0.3, 3);
      } else if (t < 5) {
        steady(base, start + ((end - start) * (t - 0.5)) / 4.5, -0.6, 3);
      } else {
        steady(base, end, 0, 3);
        base.driveline = 'clutch-open';
      }
    },
  },
  {
    name: 'limiterHold',
    durationS: 4,
    ctl(_t, base) {
      steady(base, engine().limiterRpm, 1, 3);
      base.limiter = true;
    },
  },
  {
    name: 'autoShiftPull',
    durationS: 10,
    ctl(t, base) {
      followPull(engine().auto, t, base, 0.6);
    },
  },
];

/** Total length of one pass through SEGMENTS (s). */
export const PROGRAM_S = SEGMENTS.reduce((s, seg) => s + seg.durationS, 0);

/**
 * Plays every segment back-to-back, repeating, on one absolute timeline: t (s) → control, with
 * ShiftState.t0 converted to absolute time (render with nowS = t). Allocation-free.
 */
export function playSegments(t: number, base: DspControl): void {
  const cycleStart = Math.floor(t / PROGRAM_S) * PROGRAM_S;
  let start = cycleStart;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    if (seg === undefined) continue;
    if (t < start + seg.durationS || i === SEGMENTS.length - 1) {
      seg.ctl(t - start, base);
      if (base.shift.active) base.shift.t0 += start;
      return;
    }
    start += seg.durationS;
  }
}
