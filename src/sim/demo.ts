import { G } from '../contracts';
import type { TeslaParams } from '../contracts';
import { maxForceN, roadForceN } from './load';

/** Pedal positions, 0..1 each. */
export interface PedalCommand {
  throttle: number;
  brake: number;
}

/**
 * Scripted demo drive (spec §8.7), linearly interpolated and looped. The LAST keyframe's `t` is the
 * loop length; it equals the first keyframe so the loop is seamless. Tuned so a mid-size dual-motor
 * car reaches ≈ 50 km/h after the pull-away and ≈ 140 km/h after the WOT pull, and every catalogue
 * class (incl. Chill mode, heavy trucks and the quickest cars) is stationary well before the loop
 * restarts. In this model the estimated load equals the throttle whenever the brake is off, so the
 * lift-off phase uses brake 0.1 to stand in for the Tesla's lift-off regen: that deceleration is
 * what makes the load negative (overrun), exactly as it does on the GPS path. Throttle and brake are
 * never non-zero together, also between keyframes.
 */
export const DEMO_PROFILE: readonly { t: number; throttle: number; brake: number }[] = [
  { t: 0, throttle: 0, brake: 0 }, // idle
  { t: 3, throttle: 0, brake: 0 },
  { t: 3.5, throttle: 0.4, brake: 0 }, // pull-away
  { t: 6, throttle: 0.4, brake: 0 },
  { t: 7, throttle: 0.12, brake: 0 }, // settle near 50 km/h
  { t: 13, throttle: 0.12, brake: 0 },
  { t: 13.5, throttle: 1, brake: 0 }, // WOT through the gears
  { t: 19.5, throttle: 1, brake: 0 },
  { t: 20.5, throttle: 0.15, brake: 0 }, // cruise
  { t: 33, throttle: 0.15, brake: 0 },
  { t: 33.5, throttle: 0, brake: 0 }, // lift-off / overrun …
  { t: 34, throttle: 0, brake: 0.1 }, // … with the Tesla's lift-off regen (≈ 0.08 g) → negative load
  { t: 41, throttle: 0, brake: 0.1 },
  { t: 42, throttle: 0, brake: 0.6 }, // braking to a stop
  { t: 56, throttle: 0, brake: 0.6 },
  { t: 56.5, throttle: 0, brake: 0 }, // stand still
  { t: 64, throttle: 0, brake: 0 }, // loop
];

/** Plays DEMO_PROFILE: zero-order evaluation at the start of each step, then time advances. */
export class DemoDriver {
  private readonly times: Float64Array;
  private readonly throttles: Float64Array;
  private readonly brakes: Float64Array;
  private readonly loopS: number;
  private t = 0;
  /** Index of the keyframe at or before `t` (segment start). */
  private seg = 0;

  constructor() {
    const n = DEMO_PROFILE.length;
    this.times = new Float64Array(n);
    this.throttles = new Float64Array(n);
    this.brakes = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = DEMO_PROFILE[i];
      if (k === undefined) continue;
      this.times[i] = k.t;
      this.throttles[i] = k.throttle;
      this.brakes[i] = k.brake;
    }
    this.loopS = this.times[n - 1] ?? 0;
  }

  reset(): void {
    this.t = 0;
    this.seg = 0;
  }

  /** Writes the pedals for the current profile time into `out`, then advances by dtS (looping). */
  step(dtS: number, out: PedalCommand): void {
    const times = this.times;
    const last = times.length - 1;
    while (this.seg < last - 1 && this.t >= (times[this.seg + 1] ?? Infinity)) this.seg++;
    const t0 = times[this.seg] ?? 0;
    const t1 = times[this.seg + 1] ?? t0;
    const u = t1 > t0 ? (this.t - t0) / (t1 - t0) : 0;
    const th0 = this.throttles[this.seg] ?? 0;
    const br0 = this.brakes[this.seg] ?? 0;
    out.throttle = th0 + ((this.throttles[this.seg + 1] ?? th0) - th0) * u;
    out.brake = br0 + ((this.brakes[this.seg + 1] ?? br0) - br0) * u;

    if (dtS > 0) {
      let t = this.t + dtS;
      if (t >= this.loopS) {
        t = this.loopS > 0 ? t - this.loopS * Math.floor(t / this.loopS) : 0;
        this.seg = 0;
      }
      this.t = t;
    }
  }
}

/**
 * Point-mass longitudinal physics for Demo/Keyboard (spec §8.7):
 * a = (throttle·maxForceN − roadForceN − brake·massKg·0.8·G)/massKg, v clamped ≥ 0, road force zero
 * at v = 0. When the clamp at v = 0 engages, `a` is the acceleration actually applied (Δv/dt), so a
 * car held on the brake at a stop reports a = 0.
 */
export class PedalPhysics {
  private p: TeslaParams | null = null;
  private _v = 0;
  private _a = 0;

  configure(p: TeslaParams): void {
    this.p = p;
  }

  reset(): void {
    this._v = 0;
    this._a = 0;
  }

  /** Explicit (forward) Euler over dtS: a from the current v, then v += a·dtS. Pedals are clamped to [0, 1] (NaN → 0). No-op before configure or for dtS ≤ 0. */
  step(throttle: number, brake: number, dtS: number): void {
    const p = this.p;
    if (p === null || !(dtS > 0)) return;
    const th = throttle > 0 ? (throttle < 1 ? throttle : 1) : 0;
    const br = brake > 0 ? (brake < 1 ? brake : 1) : 0;
    const v = this._v;
    const fRoad = v > 0 ? roadForceN(p, v) : 0;
    const a = (th * maxForceN(p, v) - fRoad - br * p.massKg * 0.8 * G) / p.massKg;
    const vNext = v + a * dtS;
    if (vNext > 0) {
      this._v = vNext;
      this._a = a;
    } else {
      this._v = 0;
      this._a = v > 0 ? -v / dtS : 0;
    }
  }

  get v(): number {
    return this._v;
  }

  get a(): number {
    return this._a;
  }
}
