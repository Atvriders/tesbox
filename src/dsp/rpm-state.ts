/**
 * RpmState — the DSP-side engine speed that drives the crank clock (spec §5.1, §5.3.7 rev limiter,
 * §8.6 shift trajectory; phase2a contract "RpmState rules" + amendment B5).
 *
 * Per sample, in priority order:
 *   1. shift trajectory while ctl.shift.active and u = (nowS − t0)/durationS < 1: hold fromRpm for
 *      u < 0.3, cosine ease to toRpm over u ∈ [0.3, 1], combustion cut for u < 0.4 (ignition cut —
 *      the "fart" — for dct/pdk/amt, fuel cut otherwise). A completed shift resumes tracking from
 *      toRpm; an aborted one (active cleared early) resumes from where the trajectory was.
 *   2. limiter bounce while ctl.limiter: "cut" phase falls at hysteresis/50 ms down to
 *      limiter.rpm − hysteresis, "fire" phase rises at the same rate back to limiter.rpm
 *      (100 ms period → 10 cut→fire transitions/s, 50 ms cuts). B5: `cut` is true for the whole cut
 *      phase for every limiter type; DspCore turns it into an all-bits or alternating skipMask.
 *   3. otherwise one-pole tracking of ctl.rpm with τ = 40 ms.
 *
 * `shifting` reports which source owns this sample's cut, so DspCore picks the B5 skip mask from
 * RpmState itself rather than from ctl.shift.active (which can linger after u ≥ 1, when the limiter
 * bounce is already running).
 *
 * `tick` is a hot path (spec §4.4): no allocation; the 20 ms history ring is sized in the constructor.
 */
import type { DspControl, EngineSpec } from '../contracts';
import { OnePole } from './util';

/** Tracking time constant of ctl.rpm, seconds (contract). */
export const TRACK_TAU_S = 0.04;
/** Duration of each limiter half-cycle (cut or fire), seconds: rate = hysteresisRpm / 0.05 s (contract). */
export const LIMITER_HALF_PERIOD_S = 0.05;
/** Shift trajectory breakpoints in u: hold fromRpm until 0.3, combustion cut until 0.4 (contract). */
export const SHIFT_HOLD_END = 0.3;
export const SHIFT_CUT_END = 0.4;

/** `falling` = rpm now is more than FALLING_EPS_RPM below rpm FALLING_WINDOW_S ago (≈ 25 rpm/s). */
const FALLING_WINDOW_S = 0.02;
const FALLING_EPS_RPM = 0.5;
/** Sanity ceiling for any rpm input (+Infinity → this). */
const RPM_MAX = 30000;
/** Hysteresis floor: keeps the bounce rate finite and its period at 2 × 50 ms. */
const MIN_HYSTERESIS_RPM = 1;

/** rpm in [0, RPM_MAX]; NaN → fallback, −∞ → 0, +∞ → RPM_MAX. */
function sanitizeRpm(x: number, fallback: number): number {
  if (x >= 0) return x <= RPM_MAX ? x : RPM_MAX;
  return x < 0 ? 0 : fallback;
}

/** Shift trajectory (contract): fromRpm for u ≤ 0.3 (and NaN), cosine ease to toRpm over [0.3, 1], toRpm for u ≥ 1. */
export function shiftTrajectoryRpm(u: number, fromRpm: number, toRpm: number): number {
  if (!(u > SHIFT_HOLD_END)) return fromRpm;
  if (u >= 1) return toRpm;
  const e = 0.5 - 0.5 * Math.cos((Math.PI * (u - SHIFT_HOLD_END)) / (1 - SHIFT_HOLD_END));
  return fromRpm + (toRpm - fromRpm) * e;
}

export class RpmState {
  private readonly fs: number;
  private readonly tracker = new OnePole();
  /** rpm of the last FALLING_WINDOW_S·fs samples (ring). */
  private readonly hist: Float64Array;
  private histIdx = 0;

  private rpmNow = 0;
  private cutNow = false;
  private cutIgnitionNow = false;
  private fallingNow = false;

  private limiterRpm = 7000;
  private hysteresis = 150;
  private limiterStep = 0;
  private limiterIgnition = false;
  private shiftIgnition = false;

  private inShift = false;
  private shiftT0 = 0;
  private shiftDur = 1;
  private shiftTo = 0;
  private inLimiter = false;
  private limiterCutPhase = false;

  constructor(fs: number) {
    if (!(fs >= 8000) || !Number.isFinite(fs)) {
      throw new RangeError(`RpmState: sample rate must be a finite number ≥ 8000, got ${fs}`);
    }
    this.fs = fs;
    this.tracker.setTau(TRACK_TAU_S, fs);
    this.hist = new Float64Array(Math.max(1, Math.round(FALLING_WINDOW_S * fs)));
    this.limiterStep = this.hysteresis / (LIMITER_HALF_PERIOD_S * fs);
  }

  /** Engine rpm this sample (≥ 0). */
  get rpm(): number {
    return this.rpmNow;
  }

  /** Combustion cut this sample (limiter cut phase or shift cut window). */
  get cut(): boolean {
    return this.cutNow;
  }

  /** The current cut is an ignition cut (limiter type ignition-*, or a dct/pdk/amt shift); false when not cutting. */
  get cutIsIgnition(): boolean {
    return this.cutIgnitionNow;
  }

  /** rpm decreased by more than 0.5 rpm over the last 20 ms. */
  get falling(): boolean {
    return this.fallingNow;
  }

  /** This sample followed the shift trajectory (u < 1); a cut while false is the limiter bounce. */
  get shifting(): boolean {
    return this.inShift;
  }

  /** Reads limiter and gearbox data from the spec, then reset(0). Never allocates. */
  configure(spec: EngineSpec): void {
    const lim = spec.rpm.limiter;
    const redline = spec.rpm.redline > 0 && spec.rpm.redline <= RPM_MAX ? spec.rpm.redline : 7000;
    this.limiterRpm = lim.rpm > 0 && lim.rpm <= RPM_MAX ? lim.rpm : redline;
    const h = lim.hysteresisRpm > MIN_HYSTERESIS_RPM ? lim.hysteresisRpm : MIN_HYSTERESIS_RPM;
    this.hysteresis = Math.min(h, 0.5 * this.limiterRpm);
    this.limiterStep = this.hysteresis / (LIMITER_HALF_PERIOD_S * this.fs);
    this.limiterIgnition = lim.type === 'ignition-hard' || lim.type === 'ignition-soft';
    const gb = spec.gearbox.type;
    this.shiftIgnition = gb === 'dct' || gb === 'pdk' || gb === 'amt';
    this.reset(0);
  }

  /** Sets rpm immediately (default 0; NaN → 0) and clears cut/falling, shift and limiter state. */
  reset(rpm = 0): void {
    const r = sanitizeRpm(rpm, 0);
    this.tracker.reset(r);
    this.rpmNow = r;
    this.hist.fill(r);
    this.histIdx = 0;
    this.cutNow = false;
    this.cutIgnitionNow = false;
    this.fallingNow = false;
    this.inShift = false;
    this.inLimiter = false;
    this.limiterCutPhase = false;
  }

  tick(ctl: DspControl, nowS: number): void {
    const sh = ctl.shift;
    let rpm: number;
    let cut = false;
    let cutIgnition = false;
    let u = Number.NaN;
    if (sh.active && sh.durationS > 0) u = (nowS - sh.t0) / sh.durationS;

    if (u < 1) {
      // 1. shift trajectory (u < 0, i.e. t0 slightly in the future, holds fromRpm with the cut)
      const from = sanitizeRpm(sh.fromRpm, this.tracker.y);
      const to = sanitizeRpm(sh.toRpm, from);
      rpm = shiftTrajectoryRpm(u, from, to);
      cut = u < SHIFT_CUT_END;
      cutIgnition = cut && this.shiftIgnition;
      this.inShift = true;
      this.shiftT0 = sh.t0;
      this.shiftDur = sh.durationS;
      this.shiftTo = to;
      this.inLimiter = false;
      this.tracker.reset(rpm);
    } else {
      if (this.inShift) {
        this.inShift = false;
        // completed → resume from toRpm exactly; aborted early → resume from the last trajectory rpm
        if ((nowS - this.shiftT0) / this.shiftDur >= 1) this.tracker.reset(this.shiftTo);
      }
      if (ctl.limiter) {
        // 2. limiter bounce
        const top = this.limiterRpm;
        const bottom = top - this.hysteresis;
        const step = this.limiterStep;
        let y = this.tracker.y;
        if (!this.inLimiter) {
          this.inLimiter = true;
          this.limiterCutPhase = y >= top;
        }
        if (this.limiterCutPhase) {
          y -= step;
          if (y <= bottom) {
            y = bottom;
            this.limiterCutPhase = false;
          }
        } else {
          if (y < bottom) {
            // still below the bounce band (limiter flagged while rpm lags): at least as fast as tracking
            const pulled = this.tracker.process(top);
            y = pulled > y + step ? pulled : y + step;
          } else {
            y += step;
          }
          if (y >= top) {
            y = top;
            this.limiterCutPhase = true;
          }
        }
        this.tracker.reset(y);
        rpm = y;
        cut = this.limiterCutPhase;
        cutIgnition = cut && this.limiterIgnition;
      } else {
        // 3. one-pole tracking (NaN target holds the current rpm)
        this.inLimiter = false;
        rpm = this.tracker.process(sanitizeRpm(ctl.rpm, this.tracker.y));
      }
    }

    const past = this.hist[this.histIdx] ?? rpm;
    this.hist[this.histIdx] = rpm;
    this.histIdx = this.histIdx + 1 === this.hist.length ? 0 : this.histIdx + 1;
    this.fallingNow = rpm < past - FALLING_EPS_RPM;
    this.rpmNow = rpm;
    this.cutNow = cut;
    this.cutIgnitionNow = cutIgnition;
  }
}
