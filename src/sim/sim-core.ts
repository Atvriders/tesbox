import { F } from '../contracts';
import type {
  DriveMode,
  Driveline,
  EngineSpec,
  EngineVoicing,
  FixMsg,
  GearboxMode,
  InputMsg,
  SimCore,
  SimOutput,
  SimTuning,
  SpeedSourceKind,
  TeslaParams,
} from '../contracts';
import { DemoDriver, PedalPhysics, type PedalCommand } from './demo';
import { DrivelineModel, RPM_SLEW_RPM_PER_S } from './driveline';
import { Gearbox } from './gearbox';
import { LoadEstimator } from './load';
import { SpeedFilter } from './speed-filter';
import { rollingCircumferenceM } from './tyre';

/** Crank sequence (seconds since ignition on): ramp to 250 rpm, flare to idle + 800, settle to idle. */
export const CRANK_RAMP_END_S = 0.6;
export const CRANK_RPM = 250;
export const CRANK_FLARE_END_S = 1.0;
export const CRANK_FLARE_RPM = 800;
export const CRANK_SETTLE_END_S = 2.5;
/** Ignition off: rpm decays to 0 over this long. */
export const STOP_DECAY_S = 1.0;
/** Demo/keyboard sources are at standstill below this speed. */
export const PEDAL_STANDSTILL_MPS = 0.3;
/** Seed of the deterministic idle wander. */
export const DRIVELINE_SEED = 1;
/** GPS health bits: they describe the real GPS whatever the source (status dot, Diagnostics, spec §10). */
const GPS_HEALTH = F.GPS_LOST | F.PREDICTING | F.SPEED_UNUSABLE;

type Phase = 'off' | 'cranking' | 'running' | 'stopping';

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

/**
 * SimCore (spec §8, phase-1 contract): speed source → load → gearbox → driveline → target rpm →
 * limiter clamp, plus the ignition (crank/stop) sequence and the hidden hold. Environment-free.
 * `step`, `pushFix` and `pushInput` never allocate; everything is allocated in the constructor and
 * `configure`.
 *
 * Continuity (RF5): out.rpm moves by at most RPM_SLEW_RPM_PER_S·dtS (48 rpm per quantum at 48 kHz)
 * per step, except on the step a shift starts, and only in the shift's physical direction (an upshift
 * may drop out.rpm to the new gear, a downshift may raise it; the DSP follows out.shift — against that
 * direction the rpm slews). The limiter clamp (contract: "target ≥ limiter.rpm → out.rpm = limiter.rpm")
 * acts on the continuity-limited rpm and only ever lowers it; as out.rpm never exceeds limiter.rpm (unless
 * configure() just switched to an engine with a lower limiter), the clamp moves it by at most one slew
 * step. Source switches, the hidden hold, crank hand-over, limiter entry and ignition off therefore never
 * step the rpm.
 *
 * out.shift carries ENGINE rpm: fromRpm = out.rpm before the shift, toRpm = out.rpm after it (equal to
 * the gearbox's wheel-rpm values whenever the driveline is engaged and the rpm snaps).
 *
 * Paddle requests (shiftUp/shiftDown) apply at the next quantum (spec §4.3): SimCore holds the request
 * and forwards it to Gearbox.request only on a step that runs in gear outside the hidden hold; any other
 * step drops it, so a request never fires after a hold or a restart.
 *
 * Beyond the contract (plan header, Concerns PC11): the GPS-health bits (GPS_LOST | PREDICTING |
 * SPEED_UNUSABLE) are reported whatever the source; members beyond `SimCore`: setWarm, setTuning,
 * fixesAccepted, fixesRejected; a shift start snaps out.rpm only in the shift's physical direction; the
 * contract's limiter rule "target ≥ limiter.rpm" reads `target` as the continuity-limited rpm (after the
 * slew/snap step), so clamping never raises out.rpm (an upshift whose new gear still turns above
 * limiter.rpm while out.rpm is slewing up from idle keeps slewing); an ignition-on received before
 * configure() starts the crank clock at the first configured step (step() is a no-op until then), so the
 * crank is never skipped.
 */
export class TesboxSimCore implements SimCore {
  readonly out: SimOutput = {
    rpm: 0,
    gear: 0,
    speedMps: 0,
    accelMps2: 0,
    load: 0,
    driveline: 'clutch-open',
    limiter: false,
    flags: 0,
    shift: { active: false, up: false, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0 },
    ignitionOn: false,
    runTimeS: 0,
  };

  private readonly filter = new SpeedFilter();
  private readonly loadEst = new LoadEstimator();
  private readonly gearbox = new Gearbox();
  private readonly driveline = new DrivelineModel();
  private readonly demo = new DemoDriver();
  private readonly physics = new PedalPhysics();
  private readonly pedal: PedalCommand = { throttle: 0, brake: 0 };

  private configured = false;
  private source: SpeedSourceKind = 'gps';
  private gearboxMode: GearboxMode = 'auto';
  private driveMode: DriveMode = 'comfort';
  private limiterRpm = Infinity;
  private fuelCutResumeRpm = Infinity;
  private keyThrottle = 0;
  private keyBrake = 0;
  /**
   * Paddle request (+1 up, −1 down, 0 none) received while shiftable(). The next step forwards it to the
   * gearbox only when that quantum runs in gear outside the hidden hold, and drops it otherwise (spec §4.3:
   * inputs apply at the next quantum) — so it never waits in the gearbox through a hold.
   */
  private shiftReq = 0;

  private phase: Phase = 'off';
  private tOnS = 0;
  /**
   * An ignition-on arrived before configure(): step() is a no-op until then, so the crank clock (tOnS) starts
   * at the first configured step instead — the crank is never skipped, however late configure() arrives.
   */
  private crankClockPending = false;
  private tOffS = 0;
  private offFromRpm = 0;
  /** False until the first step after construction (that step sets out.rpm without slew). */
  private primed = false;
  private lastShiftT0 = Number.NaN;

  /**
   * Configure-time only (allocates). All-or-nothing: throws Error, before changing any state, on an invalid
   * tyre code, gearbox (ratios, redline, shift time) or tc data.
   */
  configure(engine: EngineSpec, voicing: EngineVoicing, tesla: TeslaParams, tuning: SimTuning): void {
    const circumferenceM = rollingCircumferenceM(engine.gearbox.drivenTyre);
    // The gearbox and the driveline each validate before changing anything, but the driveline (tc data) is
    // configured after the gearbox has taken the new engine: check its data first.
    if (engine.gearbox.type === 'tc-auto' && engine.gearbox.tc === null) {
      throw new Error('tc-auto gearbox requires gearbox.tc');
    }
    this.gearbox.configure(engine, circumferenceM, this.gearboxMode, this.driveMode);
    this.driveline.configure(engine, voicing, DRIVELINE_SEED);
    this.filter.configure(tuning);
    this.loadEst.configure(tesla);
    this.physics.configure(tesla);
    this.limiterRpm = engine.rpm.limiter.rpm;
    this.fuelCutResumeRpm = voicing.overrun.fuelCutResumeRpm;
    this.lastShiftT0 = Number.NaN;
    this.shiftReq = 0; // the gearbox was reset to gear 1: a request made for the old engine is dropped
    this.out.shift.active = false;
    this.configured = true;
  }

  /** Engine starts warm (no cold-idle elevation) — the `warm` config message (spec §5.3.5). */
  setWarm(warm: boolean): void {
    this.driveline.setWarm(warm);
  }

  /**
   * A new SimTuning mid-drive (the `tuning` config message): forwarded to the speed filter, which keeps
   * its state. configure() is no substitute — it resets the gearbox to gear 1 and re-primes the driveline.
   */
  setTuning(tuning: SimTuning): void {
    this.filter.configure(tuning);
  }

  /** Fix counters for StateSnapshot S.fixesAccepted / S.fixesRejected (spec §4.2 counters). */
  get fixesAccepted(): number {
    return this.filter.fixesAccepted;
  }

  get fixesRejected(): number {
    return this.filter.fixesRejected;
  }

  setSource(kind: SpeedSourceKind): void {
    const prev = this.source;
    if (kind === prev) return;
    if (kind === 'demo') {
      // the demo script always starts from rest at its t = 0 idle
      this.demo.reset();
      this.physics.reset();
    } else if (kind === 'keyboard') {
      if (prev !== 'demo') this.physics.reset(); // demo → keyboard keeps the car rolling
      this.keyThrottle = 0;
      this.keyBrake = 0;
    }
    this.source = kind;
  }

  /** Fixes always reach the speed filter (whatever the source), so switching back to GPS is seamless. */
  pushFix(fix: FixMsg, nowS: number): boolean {
    return this.filter.accept(fix, nowS);
  }

  pushInput(msg: InputMsg, nowS: number): void {
    switch (msg.type) {
      case 'shiftUp':
        if (this.shiftable()) this.shiftReq = 1;
        break;
      case 'shiftDown':
        if (this.shiftable()) this.shiftReq = -1;
        break;
      case 'pedal':
        this.keyThrottle = clamp01(msg.throttle);
        this.keyBrake = clamp01(msg.brake);
        break;
      case 'gearboxMode':
        this.gearboxMode = msg.value;
        this.gearbox.setMode(msg.value);
        break;
      case 'driveMode':
        this.driveMode = msg.value;
        this.gearbox.setDriveMode(msg.value);
        break;
      case 'visibility':
        this.filter.setHidden(msg.hidden);
        break;
      case 'ignition':
        if (msg.on) this.ignitionOn(nowS);
        else this.ignitionOff(nowS);
        break;
      default:
        break; // valve, perspective, volume, bench: worklet/DSP concerns
    }
  }

  step(nowS: number, dtS: number): void {
    if (!this.configured) return;
    if (this.crankClockPending) {
      this.crankClockPending = false;
      this.tOnS = nowS;
    }
    const o = this.out;
    // a paddle request counts for this quantum only: forwarded below when running in gear, else dropped
    const shiftReq = this.shiftReq;
    this.shiftReq = 0;

    // 1. speed source (the filter is evaluated every step so its GPS-health bits stay current)
    this.filter.evaluate(nowS);
    let v: number;
    let a: number;
    let srcFlags: number;
    if (this.source === 'demo' || this.source === 'keyboard') {
      if (this.source === 'demo') {
        this.demo.step(dtS, this.pedal);
        this.physics.step(this.pedal.throttle, this.pedal.brake, dtS);
      } else {
        this.physics.step(this.keyThrottle, this.keyBrake, dtS);
      }
      v = this.physics.v;
      a = this.physics.a;
      // STANDSTILL follows the simulated car; no hidden hold for demo/keyboard
      srcFlags = (this.filter.flags & GPS_HEALTH) | (v < PEDAL_STANDSTILL_MPS ? F.STANDSTILL : 0);
    } else {
      v = this.filter.v;
      a = this.filter.a;
      srcFlags = this.filter.flags;
    }
    const gpsSource = this.source === 'gps' || this.source === 'replay';
    const standstill = (srcFlags & F.STANDSTILL) !== 0;
    const predicting = gpsSource && (srcFlags & F.PREDICTING) !== 0;
    const hidden = (srcFlags & F.HIDDEN_HOLD) !== 0;

    // 2. load
    const load = this.loadEst.update(v, a, dtS);
    const loadRate = this.loadEst.loadRate;

    // 3. ignition phase → target rpm
    if (this.phase === 'cranking' && nowS - this.tOnS >= CRANK_SETTLE_END_S) this.phase = 'running';
    if (this.phase === 'stopping' && nowS - this.tOffS >= STOP_DECAY_S) this.phase = 'off';
    const phase = this.phase;
    const runTimeS = phase === 'off' ? 0 : Math.max(0, nowS - this.tOnS);
    let target = 0;
    let gear = 0;
    let driveline: Driveline = 'clutch-open';
    let gearboxFlags = 0;
    let shiftStarted = false;
    const held = phase === 'running' && hidden;

    if (phase === 'cranking') {
      this.driveline.step(nowS, dtS, 0, load, 0, standstill, runTimeS);
      target = this.crankRpm(runTimeS, this.driveline.rpm);
    } else if (phase === 'running') {
      if (held) {
        // hidden hold: gear held (gearbox not stepped), engine eases to idle in neutral
        this.driveline.step(nowS, dtS, 0, load, 0, standstill, runTimeS);
        gear = this.gearbox.gear;
      } else {
        if (shiftReq !== 0) this.gearbox.request(shiftReq);
        this.gearbox.step(nowS, v, load, loadRate, predicting, standstill, this.driveline.state === 'clutch-open');
        gear = this.gearbox.gear;
        const rw = this.gearbox.rpmInGear(gear, v);
        this.driveline.step(nowS, dtS, rw, load, gear, standstill, runTimeS);
        driveline = this.driveline.state;
        gearboxFlags = this.gearbox.flags;
        const gs = this.gearbox.shift;
        shiftStarted = gs.active && gs.t0 === nowS && gs.t0 !== this.lastShiftT0;
      }
      target = this.driveline.rpm;
    } else if (phase === 'stopping') {
      const u = (nowS - this.tOffS) / STOP_DECAY_S;
      target = this.offFromRpm * 0.5 * (1 + Math.cos(Math.PI * (u > 0 ? u : 0)));
    }

    // 4. continuity + limiter clamp. A shift start snaps the rpm only in the shift's physical direction
    // (an upshift lowers it, a downshift raises it); against that direction — e.g. an upshift while the
    // engine is still below the new gear's rpm after a standstill or a source switch — the rpm slews.
    const prevRpm = o.rpm;
    let rpm = target;
    const snap = shiftStarted && (this.gearbox.shift.up ? target <= prevRpm : target >= prevRpm);
    if (this.primed && !snap) {
      const maxStep = dtS > 0 ? RPM_SLEW_RPM_PER_S * dtS : 0;
      const d = target - prevRpm;
      rpm = prevRpm + (d > maxStep ? maxStep : d < -maxStep ? -maxStep : d);
    }
    // The clamp tests the continuity-limited rpm (PC11), not the driveline's unslewed target: while out.rpm
    // still slews up behind the driveline (restart while rolling, source switch, end of a hidden hold) it
    // keeps slewing, and the limiter engages when it reaches limiter.rpm — never a jump, and an upshift into
    // a gear still above limiter.rpm cannot raise out.rpm.
    let limiter = false;
    if (phase === 'running' && rpm >= this.limiterRpm) {
      rpm = this.limiterRpm;
      limiter = true;
    }
    this.primed = true;

    // 5. shift trajectory (engine rpm)
    const sh = o.shift;
    if (shiftStarted) {
      const gs = this.gearbox.shift;
      sh.active = true;
      sh.up = gs.up;
      sh.fromRpm = prevRpm;
      sh.toRpm = rpm;
      sh.t0 = gs.t0;
      sh.durationS = gs.durationS;
      this.lastShiftT0 = gs.t0;
    } else if (sh.active && (phase !== 'running' || held || nowS >= sh.t0 + sh.durationS)) {
      sh.active = false;
    }

    // 6. outputs
    const outLoad = held ? 0 : load;
    o.rpm = rpm;
    o.gear = gear;
    o.speedMps = v;
    o.accelMps2 = a;
    o.load = outLoad;
    o.driveline = driveline;
    o.limiter = limiter;
    o.ignitionOn = phase === 'cranking' || phase === 'running';
    o.runTimeS = runTimeS;
    let flags = srcFlags | gearboxFlags;
    if (limiter) flags |= F.LIMITER;
    if (sh.active) flags |= F.SHIFTING;
    else flags &= ~F.SHIFTING;
    if (driveline === 'clutch-open') flags |= F.CLUTCH_OPEN;
    if (outLoad < -0.05 && rpm > this.fuelCutResumeRpm && driveline === 'engaged') flags |= F.OVERRUN;
    o.flags = flags;
  }

  /**
   * Shift requests count only while the engine runs in gear and is not in the hidden hold — both when the
   * request is received (here) and on the quantum it applies to (step drops it otherwise).
   */
  private shiftable(): boolean {
    if (this.phase !== 'running') return false;
    const gps = this.source === 'gps' || this.source === 'replay';
    return !(gps && (this.filter.flags & F.HIDDEN_HOLD) !== 0);
  }

  private ignitionOn(nowS: number): void {
    if (this.phase === 'cranking' || this.phase === 'running') return;
    this.phase = 'cranking';
    this.tOnS = nowS;
    this.crankClockPending = !this.configured;
    this.gearbox.reset();
    this.driveline.reset();
  }

  private ignitionOff(nowS: number): void {
    if (this.phase === 'off' || this.phase === 'stopping') return;
    this.phase = 'stopping';
    this.tOffS = nowS;
    this.crankClockPending = false;
    this.offFromRpm = this.out.rpm;
    this.gearbox.reset();
  }

  /** 0–0.6 s ramp to 250 rpm, 0.6–1.0 s flare to idle + 800, 1.0–2.5 s smoothstep settle to idle. */
  private crankRpm(t: number, idle: number): number {
    if (t < CRANK_RAMP_END_S) return (CRANK_RPM * t) / CRANK_RAMP_END_S;
    if (t < CRANK_FLARE_END_S) {
      const u = (t - CRANK_RAMP_END_S) / (CRANK_FLARE_END_S - CRANK_RAMP_END_S);
      return CRANK_RPM + (idle + CRANK_FLARE_RPM - CRANK_RPM) * Math.sin(0.5 * Math.PI * u);
    }
    const u = (t - CRANK_FLARE_END_S) / (CRANK_SETTLE_END_S - CRANK_FLARE_END_S);
    const s = u < 1 ? u * u * (3 - 2 * u) : 1;
    return idle + CRANK_FLARE_RPM * (1 - s);
  }
}
