import type { Driveline, EngineSpec, EngineVoicing } from '../contracts';

/**
 * Low-speed engine/road coupling (spec §8.4, phase-1 contract): idle (wander + cold idle), clutch
 * disengage/re-engage, clutch launch slip, torque converter with lock-up. Never stalls.
 *
 * Continuity: every target is passed through a slew limiter of RPM_SLEW_RPM_PER_S (48 rpm per
 * 128-frame quantum at 48 kHz) so state changes (clutch re-engage, launch flare, cold-idle end,
 * source switches upstream) never step the rpm by more than 50 rpm per quantum. The only bypass is
 * a gear change while moving (a shift: the DSP follows the shift trajectory instead).
 */

/** Maximum engine-rpm slew outside shifts: 18 000 rpm/s = 48 rpm per quantum at 48 kHz. */
export const RPM_SLEW_RPM_PER_S = 18000;
/** Idle wander amplitude bound (rpm) and main frequency (Hz). */
export const IDLE_WANDER_RPM = 20;
export const IDLE_WANDER_HZ = 0.5;
/** Cold idle: +300 rpm until 45 s after ignition, then a linear ramp to 0 at 60 s (unless warm). */
export const COLD_IDLE_RPM = 300;
export const COLD_IDLE_HOLD_S = 45;
export const COLD_IDLE_END_S = 60;
/** Clutch disengages below 1.05·idleBase wheel rpm and re-engages above 1.15·idleBase. */
export const CLUTCH_OPEN_FACTOR = 1.05;
export const CLUTCH_CLOSE_FACTOR = 1.15;
/** A launch starts when load exceeds this with the clutch open. */
export const LAUNCH_LOAD = 0.1;
/** Launch taper: 1 until 0.5 s, then linear to 0 at 1.0 s. */
export const LAUNCH_TAPER_START_S = 0.5;
export const LAUNCH_TAPER_END_S = 1.0;
/** Clutch locks once wheel rpm is within this of the slip target. */
export const LOCK_MARGIN_RPM = 50;
/** Torque converter: lock-up/unlock slip ramp time and unlock hysteresis. */
export const TC_LOCK_RAMP_S = 0.4;
export const TC_UNLOCK_HYSTERESIS_RPM = 200;
export const TC_UNLOCK_LOAD = 0.9;
/** Coupling speed ratio at zero load (turbine/pump). */
export const TC_SR_LIGHT = 0.97;

/** Deterministic phase in [0, 2π) from (seed, k) — integer hash, configure-time only. */
function seededPhase(seed: number, k: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(k + 1, 0x85ebca6b)) | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 * Math.PI;
}

/** 1 for t < 0.5 s, linear to 0 at 1.0 s, 0 after (and for t = +Infinity: no launch running). */
function launchTaper(t: number): number {
  if (t < LAUNCH_TAPER_START_S) return 1;
  if (t >= LAUNCH_TAPER_END_S) return 0;
  return (LAUNCH_TAPER_END_S - t) / (LAUNCH_TAPER_END_S - LAUNCH_TAPER_START_S);
}

export class DrivelineModel {
  private configured = false;
  private idleSpec = 800;
  private launchRpm = 3000;
  private isTc = false;
  private tcStallWot = 0;
  private tcLockupRpm = 0;
  private tcCouplingSR = 0.9;
  private warm = false;
  private phase1 = 0;
  private phase2 = 0;

  private _rpm = 800;
  private _state: Driveline = 'clutch-open';
  /** False until the first step after configure/reset (that step snaps to its target). */
  private primed = false;
  private prevGear = 0;
  /** Clutch types: a launch may start (re-armed by load ≤ 0.1 or by the clutch opening). */
  private armed = true;
  private launchT0 = -Infinity;
  /** Torque converter: lock-up commanded, and the lock fraction 0 (open) … 1 (locked). */
  private lockCmd = false;
  private lock = 0;

  /**
   * Configure-time only. Throws Error for a tc-auto gearbox without `tc` data; the check runs before
   * any field changes, so a rejected configure leaves the model exactly as it was.
   */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed = 1): void {
    const tc = spec.gearbox.tc;
    const isTc = spec.gearbox.type === 'tc-auto';
    if (isTc && tc === null) throw new Error('tc-auto gearbox requires gearbox.tc');
    this.isTc = isTc;
    if (isTc && tc !== null) {
      this.tcStallWot = tc.stallRpmWot;
      this.tcLockupRpm = tc.lockupTurbineRpm;
      this.tcCouplingSR = tc.couplingSR;
    }
    this.idleSpec = spec.rpm.idle;
    this.launchRpm = voicing.launchRpm;
    this.phase1 = seededPhase(seed, 0);
    this.phase2 = seededPhase(seed, 1);
    this.configured = true;
    this.reset();
  }

  /** Back to idle / clutch open; keeps the configuration and the warm flag. */
  reset(): void {
    this._rpm = this.idleSpec;
    this._state = 'clutch-open';
    this.primed = false;
    this.prevGear = 0;
    this.armed = true;
    this.launchT0 = -Infinity;
    this.lockCmd = false;
    this.lock = 0;
  }

  /** Warm engine: no cold-idle elevation. */
  setWarm(warm: boolean): void {
    this.warm = warm;
  }

  /**
   * runTimeS = seconds since ignition on. Inputs are sanitised so that no input makes the rpm
   * non-finite: a non-finite clock reads as 0, load is clamped to its [−1, 1] domain (NaN → 0), and a
   * negative or non-finite wheel rpm reads as 0.
   */
  step(
    nowS: number,
    dtS: number,
    rpmWheel: number,
    load: number,
    gear: number,
    standstill: boolean,
    runTimeS: number,
  ): void {
    if (!this.configured) return;
    const now = Number.isFinite(nowS) ? nowS : 0;
    const ld = load > -1 ? (load < 1 ? load : 1) : load <= -1 ? -1 : 0;
    const rw = rpmWheel > 0 && rpmWheel < Infinity ? rpmWheel : 0;
    const idleBase = this.idleSpec + this.coldIdle(runTimeS);
    const idle = idleBase + this.wander(now);

    let target: number;
    if (gear < 1) {
      // neutral (pre-ignition, cranking, hidden hold): engine at idle, nothing coupled
      this._state = 'clutch-open';
      this.armed = true;
      this.launchT0 = -Infinity;
      this.lockCmd = false;
      this.lock = 0;
      target = idle;
    } else if (this.isTc) {
      target = this.stepTc(dtS, rw, ld, gear, idle);
    } else {
      target = this.stepClutch(now, rw, ld, idle, idleBase);
    }

    const shifted = gear !== this.prevGear && gear >= 1 && this.prevGear >= 1 && !standstill;
    if (!this.primed || shifted) {
      this._rpm = target;
    } else {
      const maxStep = dtS > 0 ? RPM_SLEW_RPM_PER_S * dtS : 0;
      const d = target - this._rpm;
      this._rpm += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
    }
    this.primed = true;
    this.prevGear = gear;
  }

  /** Engine rpm (pre-limiter). */
  get rpm(): number {
    return this._rpm;
  }

  get state(): Driveline {
    return this._state;
  }

  private coldIdle(runTimeS: number): number {
    if (this.warm || !(runTimeS < COLD_IDLE_END_S)) return 0;
    if (runTimeS < COLD_IDLE_HOLD_S) return COLD_IDLE_RPM;
    return (COLD_IDLE_RPM * (COLD_IDLE_END_S - runTimeS)) / (COLD_IDLE_END_S - COLD_IDLE_HOLD_S);
  }

  /** Deterministic idle wander, |w| ≤ 20 rpm: 0.5 Hz main component + a slower 0.21 Hz drift (t finite). */
  private wander(t: number): number {
    return (
      IDLE_WANDER_RPM *
      (0.7 * Math.sin(2 * Math.PI * IDLE_WANDER_HZ * t + this.phase1) + 0.3 * Math.sin(2 * Math.PI * 0.21 * t + this.phase2))
    );
  }

  /** dct | pdk | manual | amt. */
  private stepClutch(nowS: number, rw: number, load: number, idle: number, idleBase: number): number {
    const openBelow = CLUTCH_OPEN_FACTOR * idleBase;
    const closeAbove = CLUTCH_CLOSE_FACTOR * idleBase;
    if (load <= LAUNCH_LOAD) this.armed = true;
    let st = this._state;
    if (st === 'engaged' && rw < openBelow) {
      st = 'clutch-open';
      this.armed = true;
    }
    if (st === 'clutch-open') {
      if (this.armed && load > LAUNCH_LOAD) {
        st = 'slipping';
        this.launchT0 = nowS;
        this.armed = false;
      } else if (rw > closeAbove) {
        st = 'engaged';
      }
    }
    let target = idle;
    if (st === 'slipping') {
      const tLaunch = nowS - this.launchT0;
      const slip = idle + Math.max(load, 0) * (this.launchRpm - idle) * launchTaper(tLaunch);
      if (rw >= Math.max(openBelow, slip - LOCK_MARGIN_RPM)) {
        st = 'engaged';
      } else if (rw < openBelow && (tLaunch >= LAUNCH_TAPER_END_S || load <= LAUNCH_LOAD)) {
        st = 'clutch-open'; // launch over without the car taking up the drive: back to idle
      } else {
        target = Math.max(rw, slip);
      }
    }
    if (st === 'engaged') target = rw;
    this._state = st;
    return target;
  }

  /** tc-auto: smooth-max converter curve, lock-up from 2nd gear with a 0.4 s slip ramp. */
  private stepTc(dtS: number, rw: number, load: number, gear: number, idle: number): number {
    const l01 = load > 0 ? (load < 1 ? load : 1) : 0;
    const sr = TC_SR_LIGHT + (this.tcCouplingSR - TC_SR_LIGHT) * l01;
    const stall = idle + (this.tcStallWot - idle) * l01;
    const pump = rw / sr;
    const p2 = pump * pump;
    const s2 = stall * stall;
    const unlocked = Math.sqrt(Math.sqrt(p2 * p2 + s2 * s2));
    if (this.lockCmd) {
      if (load > TC_UNLOCK_LOAD || rw < this.tcLockupRpm - TC_UNLOCK_HYSTERESIS_RPM || gear < 2) this.lockCmd = false;
    } else if (gear >= 2 && rw > this.tcLockupRpm && load < TC_UNLOCK_LOAD) {
      this.lockCmd = true;
    }
    const rate = dtS > 0 ? dtS / TC_LOCK_RAMP_S : 0;
    this.lock = this.lockCmd ? Math.min(1, this.lock + rate) : Math.max(0, this.lock - rate);
    this._state = this.lockCmd ? 'engaged' : pump < stall ? 'tc-stall' : 'slipping';
    return unlocked + (rw - unlocked) * this.lock;
  }
}
