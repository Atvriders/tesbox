/**
 * TesboxDspCore — the full synthesis chain behind the DspCore contract (spec §4.4, §5.3).
 *
 * Per block (≤ 128 frames): sanitise the control, update gas speeds / valve / perspective / trim.
 * Per sample: RpmState → skip mask (B5) → CombustionSource → layers → ExhaustNetwork →
 * PerspectiveMixer → (fade × ignition mix gain) → OutputStage. After each block: non-finite check
 * (full reset + 50 ms fade-in) and the deferred engine/tier/bass swap behind a 300 ms fade.
 * Lite reduces the exhaust only; the layers are tier-independent in Phase 2a (amendment B13).
 *
 * Everything is allocated in the constructor. `configure()`, `render()` and everything they call
 * never allocate (spec §4.4; enforced by the hot-path lint rule and tools/check-alloc.ts).
 */
import {
  MAX_COMBUSTION,
  MAX_SAMPLE_RATE,
  QUANTUM,
  SPEED_OF_SOUND_COLD,
  SPEED_OF_SOUND_MAX,
  type DspControl,
  type DspCore,
  type DspStats,
  type EngineDef,
  type OutputConfig,
  type Perspective,
  type Tier,
} from '../contracts';
import { CombustionSource, RPM_CEIL } from './combustion';
import { ExhaustNetwork } from './exhaust';
import { ForcedInduction } from './forced';
import { IntakeLayer } from './intake';
import { MechanicalLayer } from './mechanical';
import { OutputStage } from './output-stage';
import { OverrunLayer } from './overrun';
import { PerspectiveMixer } from './perspective';
import { RpmState } from './rpm-state';
import { clamp, smoothstep } from './util';

/** Engine / tier / bass changes while running: fade-out → apply → fade-in, each this long (s). */
export const CONFIG_FADE_S = 0.3;
/** Fade-in after the first configure and after a non-finite reset (s). */
export const RECOVERY_FADE_S = 0.05;
/** Lowest supported sample rate: ExhaustNetwork rejects fs < 28 kHz (amendment B3). */
export const MIN_SAMPLE_RATE = 28000;

const GAS_TAU_S = 3;
const WARMUP_TAU_S = 120;
const HOT_HEADER_MPS = 700;
const HOT_COLLECTOR_MPS = 560;
const HOT_MUFFLER_MPS = 460;
const REGIME_SLEW_S = 0.08;
const VALVE_SLEW_S = 0.2;
const IDLE_FLOOR = 0.15;
/** Ignition on: excitation and mix ramp up over this (s). */
const IGNITION_RISE_S = 0.02;
/** Ignition off: combustion/layer excitation fades over this… */
const IGNITION_EXCITE_FALL_S = 0.3;
/** …and the whole pre-OutputStage mix (letting the exhaust ring out) over this, so the core is silent well within 2 s. */
const IGNITION_MIX_FALL_S = 1.5;
/** OverrunLayer modeFactor (contract leaves the value open): comfort 1, sport 2. */
const SPORT_CRACKLE_FACTOR = 2;
const COMFORT_VALVE_RPM = 3500;
const COMFORT_VALVE_LOAD = 0.4;
/** Control trim range (UI range; OutputStage itself accepts down to −120 dB). */
const CONTROL_TRIM_MIN_DB = -24;
const CONTROL_TRIM_MAX_DB = 6;
/** OutputConfig.hpCornerHz default (DEFAULT_OUTPUT) used for a non-finite corner. */
const DEFAULT_HP_CORNER_HZ = 40;
const MIN_SHIFT_S = 0.001;
/** Soft limiter (B5): entries 0, 2, 4, … are cut. */
const SOFT_CUT_BITS = 0x5555;

/** Contract capacity limits (m): header 1.5, collector 1.0, mid-pipe 3.0, muffler section 0.8, tailpipe 1.2. */
const MAX_HEADER_M = 1.5;
const MAX_COLLECTOR_M = 1.0;
const MAX_MID_PIPE_M = 3.0;
const MAX_MUFFLER_SECTION_M = 0.8;
const MAX_TAILPIPE_M = 1.2;
const MAX_MUFFLER_SECTIONS = 4;
/** ExhaustNetwork capacity: one collector junction, tube and turbine per `voicing.collectors` entry (B11). */
const MAX_COLLECTORS = 8;

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Distinct, decorrelated module seeds from the core seed (golden-ratio increment). */
function deriveSeed(seed: number, k: number): number {
  return (seed ^ Math.imul(k, 0x9e3779b9)) >>> 0;
}

function copyOutput(src: OutputConfig, dst: OutputConfig, trimDb: number): void {
  dst.subwoofer = src.subwoofer;
  dst.hpCornerHz = finiteOr(src.hpCornerHz, DEFAULT_HP_CORNER_HZ);
  dst.volumeTrimDb = trimDb;
}

function reject(msg: string): never {
  throw new RangeError(`TesboxDspCore.configure: ${msg}`);
}

function needObject(path: string, x: unknown): void {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) reject(`${path} must be an object`);
}

function needObjectOrNull(path: string, x: unknown): void {
  if (x !== null && (typeof x !== 'object' || Array.isArray(x))) reject(`${path} must be an object or null`);
}

function needArray(path: string, x: unknown): void {
  if (!Array.isArray(x)) reject(`${path} must be an array`);
}

/** Throws unless lengthM is a number in [minM, maxM]; `[]` in the name is replaced by `[index]`. Builds a message only on failure. */
function checkLength(name: string, index: number, lengthM: unknown, minM: number, maxM: number): void {
  if (typeof lengthM !== 'number' || !(lengthM >= minM && lengthM <= maxM)) {
    reject(`${name.replace('[]', `[${index}]`)} = ${String(lengthM)} m is outside [${minM.toFixed(4)}, ${maxM}] m`);
  }
}

/**
 * Rejects a definition the core cannot run, so a bad definition throws from configure() in the
 * caller's context — never later from inside render() (on the audio thread) when a deferred swap
 * is applied. Checks, in order:
 *  - shape: every object and array that the modules' configure() dereference exists (runtime data,
 *    e.g. JSON posted to the worklet, can bypass the types);
 *  - capacity (phase 2a contract, B3, B11): 1…MAX_COMBUSTION entries, each with an integer bank in
 *    [0, MAX_COMBUSTION); one header length per entry; 1…8 collectors; 1…4 muffler sections; every
 *    section length a number in [4 samples at SPEED_OF_SOUND_MAX, contract max].
 * Builds an error message only on failure (configure never allocates on success).
 */
export function assertEngineFits(def: EngineDef, fs: number): void {
  needObject('def', def);
  needObject('spec', def.spec);
  needObject('voicing', def.voicing);
  const spec = def.spec;
  const v = def.voicing;
  needArray('spec.combustion', spec.combustion);
  needObject('spec.rpm', spec.rpm);
  needObject('spec.rpm.limiter', spec.rpm.limiter);
  needObject('spec.aspiration', spec.aspiration);
  needObjectOrNull('spec.aspiration.turbo', spec.aspiration.turbo);
  needObjectOrNull('spec.aspiration.supercharger', spec.aspiration.supercharger);
  needObject('spec.gearbox', spec.gearbox);
  needObject('voicing.pulse', v.pulse);
  needArray('voicing.headersM', v.headersM);
  needArray('voicing.collectors', v.collectors);
  needObjectOrNull('voicing.turbine', v.turbine);
  needObject('voicing.exhaust', v.exhaust);
  needArray('voicing.exhaust.mufflerSectionsM', v.exhaust.mufflerSectionsM);
  needObject('voicing.exhaust.valve', v.exhaust.valve);
  needObject('voicing.intake', v.intake);
  needObjectOrNull('voicing.forcedInduction', v.forcedInduction);
  needObject('voicing.mechanical', v.mechanical);
  needObject('voicing.overrun', v.overrun);
  needObject('voicing.cabin', v.cabin);

  const n = spec.combustion.length;
  if (n < 1 || n > MAX_COMBUSTION) reject(`combustion.length must be 1..${MAX_COMBUSTION}, got ${n}`);
  for (let i = 0; i < n; i++) {
    const entry = spec.combustion[i];
    const bank = typeof entry === 'object' && entry !== null ? entry.bank : Number.NaN;
    if (!Number.isInteger(bank) || bank < 0 || bank >= MAX_COMBUSTION) {
      reject(`combustion[${i}].bank = ${String(bank)} must be an integer in [0, ${MAX_COMBUSTION})`);
    }
  }
  if (v.headersM.length !== n) reject(`headersM has ${v.headersM.length} entries for ${n} combustion entries`);
  const nColl = v.collectors.length;
  if (nColl < 1 || nColl > MAX_COLLECTORS) reject(`collectors must have 1..${MAX_COLLECTORS} entries, got ${nColl}`);
  const sections = v.exhaust.mufflerSectionsM.length;
  if (sections < 1 || sections > MAX_MUFFLER_SECTIONS) {
    reject(`mufflerSectionsM must have 1..${MAX_MUFFLER_SECTIONS} entries, got ${sections}`);
  }

  const minM = (4 * SPEED_OF_SOUND_MAX) / fs;
  for (let i = 0; i < n; i++) checkLength('headersM[]', i, v.headersM[i], minM, MAX_HEADER_M);
  for (let c = 0; c < nColl; c++) {
    const col = v.collectors[c];
    if (typeof col !== 'object' || col === null || !Array.isArray(col.banks)) {
      reject(`collectors[${c}] must be an object with a banks array`);
    }
    checkLength('collectors[].lengthM', c, col.lengthM, minM, MAX_COLLECTOR_M);
  }
  checkLength('exhaust.midPipeM', -1, v.exhaust.midPipeM, minM, MAX_MID_PIPE_M);
  for (let k = 0; k < sections; k++) {
    checkLength('exhaust.mufflerSectionsM[]', k, v.exhaust.mufflerSectionsM[k], minM, MAX_MUFFLER_SECTION_M);
  }
  checkLength('exhaust.tailpipeM', -1, v.exhaust.tailpipeM, minM, MAX_TAILPIPE_M);
}

export class TesboxDspCore implements DspCore {
  /** Test hook: the last block's exhaust bus (ExhaustNetwork.outlet per sample, first `n` entries), before perspective/bass/fade. */
  readonly exhaustBus = new Float32Array(QUANTUM);

  private readonly fs: number;
  private readonly invFs: number;
  private readonly seed: number;

  private readonly rpmState: RpmState;
  private readonly combustion: CombustionSource;
  private readonly exhaust: ExhaustNetwork;
  private readonly intake: IntakeLayer;
  private readonly mechanical: MechanicalLayer;
  private readonly forced: ForcedInduction;
  private readonly overrun: OverrunLayer;
  private readonly perspective: PerspectiveMixer;
  private readonly output: OutputStage;

  private readonly exhaustIn = new Float64Array(MAX_COMBUSTION);
  private readonly intakeGate = new Float64Array(MAX_COMBUSTION);
  private readonly ctlSafe: DspControl;
  private readonly outCfg: OutputConfig;
  private readonly pendingOut: OutputConfig;
  private readonly statsObj: DspStats;

  // per-sample step sizes (constant for this fs)
  private readonly regimeStep: number;
  private readonly ignRiseStep: number;
  private readonly ignExciteFallStep: number;
  private readonly ignMixFallStep: number;
  private readonly configFadeStep: number;
  private readonly recoveryFadeStep: number;

  // applied configuration
  private def: EngineDef | null = null;
  private tier: Tier = 'full';
  private count = 0;
  private allMask = 0;
  private softMask = 0;
  private limiterSoft = false;
  private limiterIgnition = false;
  private isTurbo = false;
  private valveFitted = false;
  private fuelCutResumeRpm = 0;
  private trimDb = 0;

  // deferred swap
  private pending = false;
  private pendingDef: EngineDef | null = null;
  private pendingTier: Tier = 'full';

  // running state
  private started = false;
  private needRpmSeed = true;
  /** Perspective last passed to the mixer; null after every configure/reset (the next one snaps). */
  private appliedPerspective: Perspective | null = null;
  private hot = false;
  private snapGas = false;
  private gasHeader = SPEED_OF_SOUND_COLD;
  private gasCollector = SPEED_OF_SOUND_COLD;
  private gasMuffler = SPEED_OF_SOUND_COLD;
  private regime = 0;
  private valve = 0;
  private ign = 0;
  private ignMix = 0;
  private lastCombustionGain = 0;
  private fadeGain = 0;
  private fadeTarget = 0;
  private fadeInStep = 0;
  private fadeOutStep = 0;
  private nonFiniteResets = 0;

  /** Throws RangeError unless MIN_SAMPLE_RATE ≤ fs ≤ MAX_SAMPLE_RATE (amendment B3). */
  constructor(fs: number, seed = 1) {
    if (!(fs >= MIN_SAMPLE_RATE && fs <= MAX_SAMPLE_RATE)) {
      throw new RangeError(`TesboxDspCore: fs must be in [${MIN_SAMPLE_RATE}, ${MAX_SAMPLE_RATE}] Hz (amendment B3), got ${fs}`);
    }
    this.fs = fs;
    this.invFs = 1 / fs;
    this.seed = seed >>> 0;
    this.rpmState = new RpmState(fs);
    this.combustion = new CombustionSource(fs);
    this.exhaust = new ExhaustNetwork(fs);
    this.intake = new IntakeLayer(fs);
    this.mechanical = new MechanicalLayer(fs);
    this.forced = new ForcedInduction(fs);
    this.overrun = new OverrunLayer(fs);
    this.perspective = new PerspectiveMixer(fs);
    this.output = new OutputStage(fs);
    this.ctlSafe = {
      rpm: 0,
      load: 0,
      gear: 0,
      driveline: 'clutch-open',
      limiter: false,
      shift: { active: false, up: true, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0.1 },
      ignitionOn: false,
      runTimeS: 0,
      valve: 'auto',
      perspective: 'cabin',
      driveMode: 'comfort',
      warm: false,
    };
    this.outCfg = { subwoofer: 'unsure', hpCornerHz: DEFAULT_HP_CORNER_HZ, volumeTrimDb: 0 };
    this.pendingOut = { subwoofer: 'unsure', hpCornerHz: DEFAULT_HP_CORNER_HZ, volumeTrimDb: 0 };
    this.statsObj = { nonFiniteResets: 0, boost: 0, limiterGainReductionDb: 0, truePeakDbtp: -200 };
    this.regimeStep = 1 / (REGIME_SLEW_S * fs);
    this.ignRiseStep = 1 / (IGNITION_RISE_S * fs);
    this.ignExciteFallStep = 1 / (IGNITION_EXCITE_FALL_S * fs);
    this.ignMixFallStep = 1 / (IGNITION_MIX_FALL_S * fs);
    this.configFadeStep = 1 / (CONFIG_FADE_S * fs);
    this.recoveryFadeStep = 1 / (RECOVERY_FADE_S * fs);
  }

  /**
   * Reading `stats` refreshes the shared object in place. `truePeakDbtp` is read-and-reset (the max
   * since the previous read of `stats`), so read `stats` once per snapshot and copy the fields you need.
   */
  get stats(): DspStats {
    const s = this.statsObj;
    s.nonFiniteResets = this.nonFiniteResets;
    s.boost = this.forced.boost;
    s.limiterGainReductionDb = this.output.gainReductionDb;
    s.truePeakDbtp = this.output.takeTruePeak();
    return s;
  }

  /** Test hook: jump the gas speeds to their hot steady state for the current load and keep the engine fully warm. */
  forceHot(): void {
    this.hot = true;
    this.snapGas = true;
  }

  configure(def: EngineDef, output: OutputConfig, tier: Tier): void {
    assertEngineFits(def, this.fs);
    this.trimDb = clamp(finiteOr(output.volumeTrimDb, 0), CONTROL_TRIM_MIN_DB, CONTROL_TRIM_MAX_DB);
    if (this.def === null || !this.started) {
      // Nothing audible yet: apply immediately, then a short fade-in.
      copyOutput(output, this.outCfg, this.trimDb);
      this.pending = false;
      this.pendingDef = null;
      this.applyConfig(def, tier);
      this.fadeGain = 0;
      this.fadeTarget = 1;
      this.fadeInStep = this.recoveryFadeStep;
      return;
    }
    this.outCfg.volumeTrimDb = this.trimDb;
    this.pendingOut.volumeTrimDb = this.trimDb;
    const sameAsApplied =
      def === this.def &&
      tier === this.tier &&
      output.subwoofer === this.outCfg.subwoofer &&
      finiteOr(output.hpCornerHz, DEFAULT_HP_CORNER_HZ) === this.outCfg.hpCornerHz;
    if (sameAsApplied) {
      // Trim-only change (OutputStage ramps it per quantum) or a cancelled swap: no fade needed.
      if (this.pending) {
        this.pending = false;
        this.pendingDef = null;
        this.fadeTarget = 1;
        this.fadeInStep = this.configFadeStep;
      }
      return;
    }
    this.pendingDef = def;
    this.pendingTier = tier;
    copyOutput(output, this.pendingOut, this.trimDb);
    this.pending = true;
    this.fadeTarget = 0;
    this.fadeOutStep = this.configFadeStep;
  }

  render(ctl: DspControl, outL: Float32Array, outR: Float32Array, frames: number, nowS: number): void {
    let total = frames | 0;
    if (total > outL.length) total = outL.length;
    if (total > outR.length) total = outR.length;
    if (total <= 0) return;
    if (this.def === null) {
      for (let i = 0; i < total; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      return;
    }
    this.started = true;
    let off = 0;
    while (off < total) {
      const n = total - off > QUANTUM ? QUANTUM : total - off;
      this.step(ctl, outL, outR, off, n, nowS + off * this.invFs);
      off += n;
    }
  }

  /** One block of n ≤ QUANTUM frames written at outL/outR[off…]; t0 = time of its first frame. */
  private step(ctl: DspControl, outL: Float32Array, outR: Float32Array, off: number, n: number, t0: number): void {
    this.readControl(ctl);
    const c = this.ctlSafe;
    if (this.needRpmSeed) {
      this.rpmState.reset(c.rpm);
      this.needRpmSeed = false;
    }

    // ── per-quantum control (contract "DspCore per-quantum control") ──
    const load = c.load;
    const throttle = load > 0 ? load : 0;
    const eligible = c.ignitionOn && c.rpm > this.fuelCutResumeRpm && c.driveline === 'engaged';
    const regimeTarget = eligible ? 1 - smoothstep(-0.08, 0.02, load) : 0;
    const floor = eligible ? 0 : IDLE_FLOOR;

    const warmup = this.hot || c.warm ? 1 : 1 - Math.exp(-c.runTimeS / WARMUP_TAU_S);
    const heat = warmup * (0.6 + 0.4 * throttle);
    const tHeader = SPEED_OF_SOUND_COLD + (HOT_HEADER_MPS - SPEED_OF_SOUND_COLD) * heat;
    const tCollector = SPEED_OF_SOUND_COLD + (HOT_COLLECTOR_MPS - SPEED_OF_SOUND_COLD) * heat;
    const tMuffler = SPEED_OF_SOUND_COLD + (HOT_MUFFLER_MPS - SPEED_OF_SOUND_COLD) * heat;
    if (this.snapGas) {
      this.gasHeader = tHeader;
      this.gasCollector = tCollector;
      this.gasMuffler = tMuffler;
      this.snapGas = false;
    } else {
      const k = 1 - Math.exp(-n / (GAS_TAU_S * this.fs));
      this.gasHeader += (tHeader - this.gasHeader) * k;
      this.gasCollector += (tCollector - this.gasCollector) * k;
      this.gasMuffler += (tMuffler - this.gasMuffler) * k;
    }
    this.exhaust.setGasSpeeds(this.gasHeader, this.gasCollector, this.gasMuffler);

    let valveTarget = 0;
    if (this.valveFitted) {
      if (c.valve === 'open') valveTarget = 1;
      else if (c.valve === 'auto') {
        if (c.driveMode === 'sport') valveTarget = 1;
        else if (c.rpm > COMFORT_VALVE_RPM && load > COMFORT_VALVE_LOAD) valveTarget = 1;
      }
    }
    const valveStep = n / (VALVE_SLEW_S * this.fs);
    if (this.valve < valveTarget) this.valve = Math.min(valveTarget, this.valve + valveStep);
    else if (this.valve > valveTarget) this.valve = Math.max(valveTarget, this.valve - valveStep);
    this.exhaust.setValve(this.valve);
    if (this.isTurbo) this.exhaust.setTurbineAttenuation(Math.sqrt(clamp(this.forced.boost, 0, 1))); // shaft = √boost

    if (this.appliedPerspective !== c.perspective) {
      const first = this.appliedPerspective === null;
      this.perspective.setPerspective(c.perspective);
      // setPerspective only sets the target; reset() snaps the crossfade to it. The first perspective
      // after a configure/reset (state just cleared) snaps instead of fading in from the old target.
      if (first) this.perspective.reset();
      this.appliedPerspective = c.perspective;
    }
    this.output.beginQuantum(this.trimDb, n);

    const modeFactor = c.driveMode === 'sport' ? SPORT_CRACKLE_FACTOR : 1;
    const ignOn = c.ignitionOn;
    const count = this.count;
    const valve = this.valve;
    const bus = this.exhaustBus;
    let ign = this.ign;
    let ignMix = this.ignMix;
    let regime = this.regime;
    let fade = this.fadeGain;
    let acc = 0;

    // ── per-sample chain ──
    for (let i = 0; i < n; i++) {
      if (ignOn) {
        ign = ign + this.ignRiseStep > 1 ? 1 : ign + this.ignRiseStep;
        ignMix = ignMix + this.ignRiseStep > 1 ? 1 : ignMix + this.ignRiseStep;
      } else {
        ign = ign - this.ignExciteFallStep < 0 ? 0 : ign - this.ignExciteFallStep;
        ignMix = ignMix - this.ignMixFallStep < 0 ? 0 : ignMix - this.ignMixFallStep;
      }
      if (regime < regimeTarget) {
        regime += this.regimeStep;
        if (regime > regimeTarget) regime = regimeTarget;
      } else if (regime > regimeTarget) {
        regime -= this.regimeStep;
        if (regime < regimeTarget) regime = regimeTarget;
      }
      if (fade < this.fadeTarget) {
        fade += this.fadeInStep;
        if (fade > 1) fade = 1;
      } else if (fade > this.fadeTarget) {
        fade -= this.fadeOutStep;
        if (fade < 0) fade = 0;
      }

      this.rpmState.tick(c, t0 + i * this.invFs);
      const rpm = this.rpmState.rpm;
      if (this.rpmState.cut) {
        // B5: a cut outside the shift trajectory is the limiter bounce (RpmState owns that decision:
        // ctl.shift.active can linger after the shift while the bounce already runs).
        const limiterCut = !this.rpmState.shifting;
        this.combustion.skipMask = limiterCut && this.limiterSoft ? this.softMask : this.allMask;
        this.combustion.skipIsIgnition = limiterCut ? this.limiterIgnition : this.rpmState.cutIsIgnition;
      } else {
        this.combustion.skipMask = 0;
        this.combustion.skipIsIgnition = false;
      }

      let gain = 1 - regime;
      if (gain < floor) gain = floor;
      gain *= ign;
      this.lastCombustionGain = gain;
      const ignition = this.combustion.tick(rpm, load, gain, this.exhaustIn, this.intakeGate);
      const pops = this.combustion.takeIgnitionCutPops();

      let gateSum = 0;
      for (let k = 0; k < count; k++) gateSum += this.intakeGate[k] ?? 0;
      const intake = this.intake.tick(gateSum, throttle * ign);
      const block = this.mechanical.tick(ignition, rpm) * ign;
      const fi = this.forced.tick(rpm, load * ign) * ign;
      this.overrun.tick(regime, rpm, this.rpmState.falling, valve, modeFactor, pops);
      const pop = this.overrun.popInject * ign;
      const air = this.overrun.airflow * ign;

      this.exhaust.tick(this.exhaustIn, pop);
      const ex = this.exhaust.outlet;
      bus[i] = ex;

      this.perspective.tick(ex, intake, block, fi, air);
      const g = fade * ignMix;
      const pl = this.perspective.l;
      const pr = this.perspective.r;
      this.output.process(pl * g, pr * g);
      outL[off + i] = this.output.l;
      outR[off + i] = this.output.r;
      acc += ignition + intake + block + fi + pop + air + pl + pr;
    }

    this.ign = ign;
    this.ignMix = ignMix;
    this.regime = regime;
    this.fadeGain = fade;

    // ── once per quantum: non-finite guard, then the deferred swap ──
    if (!Number.isFinite(this.exhaust.energy() + acc + this.rpmState.rpm)) {
      this.recover();
    } else if (this.pending && fade === 0 && this.pendingDef !== null) {
      copyOutput(this.pendingOut, this.outCfg, this.pendingOut.volumeTrimDb);
      this.applyConfig(this.pendingDef, this.pendingTier);
      this.pending = false;
      this.pendingDef = null;
      this.fadeTarget = 1;
      this.fadeInStep = this.configFadeStep;
    }
  }

  /** Copies + sanitises the caller's control into ctlSafe (finite, clamped; never aliases caller objects). */
  private readControl(ctl: DspControl): void {
    const c = this.ctlSafe;
    c.rpm = clamp(finiteOr(ctl.rpm, 0), 0, RPM_CEIL);
    c.load = clamp(finiteOr(ctl.load, 0), -1, 1);
    c.gear = finiteOr(ctl.gear, 0);
    c.driveline = ctl.driveline;
    c.limiter = ctl.limiter === true;
    c.ignitionOn = ctl.ignitionOn === true;
    c.runTimeS = Math.max(0, finiteOr(ctl.runTimeS, 0));
    c.valve = ctl.valve;
    c.perspective = ctl.perspective === 'outside' ? 'outside' : 'cabin';
    c.driveMode = ctl.driveMode;
    c.warm = ctl.warm === true;
    const s = ctl.shift;
    const d = c.shift;
    d.active = s.active === true;
    d.up = s.up === true;
    d.fromRpm = clamp(finiteOr(s.fromRpm, c.rpm), 0, RPM_CEIL);
    d.toRpm = clamp(finiteOr(s.toRpm, c.rpm), 0, RPM_CEIL);
    d.t0 = finiteOr(s.t0, 0);
    d.durationS = Math.max(MIN_SHIFT_S, finiteOr(s.durationS, MIN_SHIFT_S));
  }

  /** Configures every module for `def` (validated by assertEngineFits, so nothing here can throw). */
  private applyConfig(def: EngineDef, tier: Tier): void {
    const spec = def.spec;
    const voicing = def.voicing;
    this.exhaust.configure(def, tier); // the only tier-dependent module (B13)
    this.rpmState.configure(spec);
    this.combustion.configure(spec, voicing, deriveSeed(this.seed, 1));
    this.intake.configure(voicing, deriveSeed(this.seed, 2));
    this.mechanical.configure(spec, voicing, deriveSeed(this.seed, 3));
    this.forced.configure(spec, voicing, deriveSeed(this.seed, 4));
    this.overrun.configure(spec, voicing, deriveSeed(this.seed, 5));
    this.perspective.configure(voicing);
    this.output.configure(this.outCfg);
    this.def = def;
    this.tier = tier;
    this.count = spec.combustion.length;
    this.resetModules();
    this.allMask = (1 << this.count) - 1;
    this.softMask = this.allMask & SOFT_CUT_BITS;
    const lt = spec.rpm.limiter.type;
    this.limiterSoft = lt === 'ignition-soft' || lt === 'fuel-soft';
    this.limiterIgnition = lt === 'ignition-soft' || lt === 'ignition-hard';
    this.isTurbo = spec.aspiration.type === 'turbo';
    this.valveFitted = voicing.exhaust.valve.fitted;
    this.fuelCutResumeRpm = voicing.overrun.fuelCutResumeRpm;
  }

  private resetModules(): void {
    this.combustion.reset();
    this.exhaust.reset();
    this.intake.reset();
    this.mechanical.reset();
    this.forced.reset();
    this.overrun.reset();
    this.perspective.reset();
    this.output.reset();
    this.regime = 0;
    this.appliedPerspective = null;
    this.needRpmSeed = true;
    this.snapGas = true; // start at the thermal state the control implies (warm start → warm gas)
  }

  /** Non-finite state: full reset (applying a queued swap if any), then a 50 ms fade-in. */
  private recover(): void {
    this.nonFiniteResets++;
    if (this.pending && this.pendingDef !== null) {
      copyOutput(this.pendingOut, this.outCfg, this.pendingOut.volumeTrimDb);
      this.applyConfig(this.pendingDef, this.pendingTier);
      this.pending = false;
      this.pendingDef = null;
    } else {
      this.resetModules();
    }
    this.fadeGain = 0;
    this.fadeTarget = 1;
    this.fadeInStep = this.recoveryFadeStep;
  }
}
