/**
 * The Tesbox AudioWorkletProcessor 'tesbox' (spec §4.2–4.4, §5.7, §9.3; phase-3 contract T3).
 *
 * Hosts the environment-free cores on the audio thread — TesboxSimCore (speed source → load → gearbox →
 * driveline → target rpm) and TesboxDspCore (synthesis + output stage) — stepped once per render quantum in
 * the worklet's own `currentTime` clock. The main thread only posts MainToWorklet messages (raw fixes,
 * inputs, config) and receives WorkletToMain messages: 'ready' once, a 'state' snapshot every 12 quanta,
 * and 'error'.
 *
 * Node: `new AudioWorkletNode(ctx, 'tesbox', { numberOfInputs: 0, numberOfOutputs: 1,
 * outputChannelCount: [2] })`, the module loaded from `./worklet.ts?worker&url` (Vite bundles it into one
 * self-contained script). The module exports nothing: importing it anywhere else would register the
 * processor in that scope.
 *
 * Messages — each is validated first; a malformed one posts `{ type: 'error', message }` and changes nothing:
 * - `engine` / `tesla` / `tuning` are kept; once engine and tesla are both known the cores are configured
 *   (`sim.configure(def.spec, def.voicing, params, tuning)`, `dsp.configure(def, output, tier)`). Afterwards
 *   `engine` reconfigures both cores (DspCore swaps behind its 300 ms fade), `tesla` reconfigures SimCore and
 *   `tuning` goes to `sim.setTuning` (which keeps the filter state). A value-equal re-post of the current
 *   engine or Tesla is a no-op (no fade, no gear reset).
 * - `output` / `tier` / `volume` → `dsp.configure(current def, output, tier)`; a trim-only change ramps in
 *   DspCore's output stage without a fade. Before configuration they are kept for the first configure.
 * - `source` → `sim.setSource`; `warm` → `ctl.warm` and `sim.setWarm`.
 * - Every InputMsg → `sim.pushInput(msg, currentTime)` (SimCore ignores the DSP-only ones); `valve`,
 *   `perspective` and `driveMode` also update the DspControl; `bench {k}` → k rounded and clamped to 1…16,
 *   and each quantum renders the DSP k − 1 extra times into a scratch buffer — on a second, identically
 *   configured core, so the benchmark (run during the crank) never disturbs the audible engine.
 * - `fix` → `sim.pushFix(msg, currentTime)`. Error messages never echo message values (no coordinates).
 *
 * process(): when configured, `sim.step(currentTime, frames / sampleRate)`, SimCore.out → DspControl,
 * `dsp.render`; otherwise silence. The test tone (sine at `hz`, peak `dbToGain(levelDb)`, 50 ms
 * raised-cosine fades) runs through its own OutputStage `{ subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 }`
 * — only the 22 Hz infrasonic high-pass, no bass-management high-pass, no user trim — and crossfades with
 * the engine output, replacing it while fully on; the engine keeps running underneath, and the tone also
 * plays before the engine is configured (bass sweep). A final NaN-safe clip at OUTPUT_CEILING follows.
 * busyFrac = busy ms / audio ms over ~1 s windows (performance.now() where the scope has it, else
 * Date.now(), spec §5.7); F.OVERLOAD while the last 2 windows were above 0.8. `process` always returns
 * true and never throws: an exception yields a silent quantum and at most one 'error' per window.
 *
 * Allocation: process() allocates only the periodic snapshot copy (plus an error string on the exception
 * path). Message handling may allocate (validation, configure).
 */
import {
  DEFAULT_OUTPUT,
  DEFAULT_SIM_TUNING,
  F,
  QUANTUM,
  S,
  STATE_LEN,
  type DriveMode,
  type DspControl,
  type EngineDef,
  type FixMsg,
  type GearboxMode,
  type GearboxType,
  type InputMsg,
  type LimiterType,
  type OutputConfig,
  type Perspective,
  type SimTuning,
  type SpeedSourceKind,
  type Subwoofer,
  type TeslaParams,
  type Tier,
  type ValveMode,
  type WorkletToMain,
} from '../contracts';
import { TesboxDspCore, assertEngineFits } from '../dsp/dsp-core';
import { OUTPUT_CEILING, OutputStage } from '../dsp/output-stage';
import { dbToGain } from '../dsp/util';
import { TesboxSimCore } from '../sim/sim-core';
import { rollingCircumferenceM } from '../sim/tyre';

/** registerProcessor name (phase-3 contract). */
const PROCESSOR_NAME = 'tesbox';
/** A 'state' snapshot every this many quanta (≈ 31 Hz at 48 kHz, ≈ 29 Hz at 44.1 kHz). */
const SNAPSHOT_EVERY = 12;
/** busyFrac window, audio seconds. */
const BUSY_WINDOW_S = 1;
/** F.OVERLOAD is set while busyFrac exceeded this … */
const OVERLOAD_FRAC = 0.8;
/** … in this many consecutive windows. */
const OVERLOAD_WINDOWS = 2;
const BENCH_K_MAX = 16;
/** Test tone fade in / out (raised cosine). */
const TONE_FADE_S = 0.05;
/** After a tone faded out, its stage keeps running this long (look-ahead + filter tails), then resets and idles. */
const TONE_TAIL_S = 0.2;
const TONE_MIN_HZ = 10;
const TONE_MAX_HZ = 20000;
/** levelDb is clamped to this range (a peak above 0 dBFS only drives the stage's compressor and limiter harder). */
const TONE_MIN_DB = -120;
const TONE_MAX_DB = 0;
/** The tone stage: subwoofer 'yes' keeps only the 22 Hz infrasonic high-pass (no bass-management HP); no trim. */
const TONE_OUTPUT: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 };
const ERROR_MAX_CHARS = 300;
const TYPE_MAX_CHARS = 40;
const TWO_PI = 2 * Math.PI;

const VALVES: readonly ValveMode[] = ['auto', 'open', 'closed'];
const PERSPECTIVES: readonly Perspective[] = ['cabin', 'outside'];
const GEARBOX_MODES: readonly GearboxMode[] = ['auto', 'manual'];
const DRIVE_MODES: readonly DriveMode[] = ['comfort', 'sport'];
const SOURCES: readonly SpeedSourceKind[] = ['gps', 'demo', 'keyboard', 'replay'];
const TIERS: readonly Tier[] = ['full', 'lite'];
const SUBWOOFERS: readonly Subwoofer[] = ['yes', 'no', 'unsure'];
const GEARBOX_TYPES: readonly GearboxType[] = ['dct', 'pdk', 'tc-auto', 'manual', 'amt'];
const LIMITER_TYPES: readonly LimiterType[] = ['ignition-hard', 'ignition-soft', 'fuel-hard', 'fuel-soft'];

const READY: WorkletToMain = { type: 'ready' };

type Obj = Record<string, unknown>;
type StateMsg = Extract<WorkletToMain, { type: 'state' }>;

/** Busy-time clock in ms: performance.now() where the AudioWorkletGlobalScope exposes it (spec §5.7), else Date.now(). */
const clockMs: () => number =
  typeof performance === 'object' && performance !== null && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  return s.length > ERROR_MAX_CHARS ? `${s.slice(0, ERROR_MAX_CHARS)}…` : s;
}

// ───────────────────────────── message validation (message path only; may allocate) ─────────────────────────────

function invalid(what: string): never {
  throw new TypeError(what);
}

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function obj(x: unknown, what: string): Obj {
  return isObj(x) ? x : invalid(`${what} must be an object`);
}

function finite(x: unknown, what: string): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : invalid(`${what} must be a finite number`);
}

function positive(x: unknown, what: string): number {
  const v = finite(x, what);
  return v > 0 ? v : invalid(`${what} must be > 0`);
}

function nonNegative(x: unknown, what: string): number {
  const v = finite(x, what);
  return v >= 0 ? v : invalid(`${what} must be ≥ 0`);
}

function bool(x: unknown, what: string): boolean {
  return typeof x === 'boolean' ? x : invalid(`${what} must be a boolean`);
}

function oneOf<T extends string>(x: unknown, values: readonly T[], what: string): T {
  return typeof x === 'string' && (values as readonly string[]).includes(x)
    ? (x as T)
    : invalid(`${what} must be one of ${values.join(' | ')}`);
}

/**
 * Rejects, before anything changes, every engine either core would refuse or turn into a sticky
 * non-finite state: DspCore's shape and capacity check (assertEngineFits), then what SimCore and RpmState
 * read — cycle and combustion angles, rpm figures, limiter type, gearbox type / ratios / tyre / shift time /
 * tc data, launch and fuel-cut rpm. A def that passes cannot make SimCore.configure or DspCore.configure throw.
 */
function checkEngine(x: unknown, fs: number): EngineDef {
  const def = x as EngineDef;
  assertEngineFits(def, fs);
  const spec = def.spec;
  const voicing = def.voicing;
  const cycle = spec.cycleDeg;
  if (cycle !== 720 && cycle !== 1080) invalid('def.spec.cycleDeg must be 720 or 1080');
  for (const entry of spec.combustion) {
    const a = finite(entry.angleDeg, 'def.spec.combustion[].angleDeg');
    if (a < 0 || a >= cycle) invalid('def.spec.combustion[].angleDeg must be in [0, cycleDeg)');
  }
  const rpm = spec.rpm;
  const idle = positive(rpm.idle, 'def.spec.rpm.idle');
  if (!(finite(rpm.redline, 'def.spec.rpm.redline') > idle)) invalid('def.spec.rpm.redline must exceed rpm.idle');
  positive(rpm.limiter.rpm, 'def.spec.rpm.limiter.rpm');
  nonNegative(rpm.limiter.hysteresisRpm, 'def.spec.rpm.limiter.hysteresisRpm');
  oneOf(rpm.limiter.type, LIMITER_TYPES, 'def.spec.rpm.limiter.type');
  const gearbox = spec.gearbox;
  const type = oneOf(gearbox.type, GEARBOX_TYPES, 'def.spec.gearbox.type');
  const ratios: unknown = gearbox.overallRatios;
  if (!Array.isArray(ratios) || ratios.length === 0) invalid('def.spec.gearbox.overallRatios must be a non-empty array');
  let prev = Infinity;
  for (const r of ratios) {
    const ratio = positive(r, 'def.spec.gearbox.overallRatios[]');
    if (!(ratio < prev)) invalid('def.spec.gearbox.overallRatios must be strictly descending');
    prev = ratio;
  }
  if (typeof gearbox.drivenTyre !== 'string') invalid('def.spec.gearbox.drivenTyre must be a string');
  rollingCircumferenceM(gearbox.drivenTyre); // throws on an unrecognised tyre code
  nonNegative(gearbox.shiftTimeS, 'def.spec.gearbox.shiftTimeS');
  if (type === 'tc-auto') {
    const tc = obj(gearbox.tc, 'def.spec.gearbox.tc');
    positive(tc.stallRpmWot, 'def.spec.gearbox.tc.stallRpmWot');
    positive(tc.lockupTurbineRpm, 'def.spec.gearbox.tc.lockupTurbineRpm');
    positive(tc.couplingSR, 'def.spec.gearbox.tc.couplingSR');
  }
  positive(voicing.launchRpm, 'def.voicing.launchRpm');
  finite(voicing.overrun.fuelCutResumeRpm, 'def.voicing.overrun.fuelCutResumeRpm');
  return def;
}

/** A validated copy (the worklet never keeps message objects it does not own). */
function checkTesla(x: unknown): TeslaParams {
  const p = obj(x, 'params');
  const road = obj(p.roadLoad, 'params.roadLoad');
  return {
    massKg: positive(p.massKg, 'params.massKg'),
    roadLoad: {
      A_N: finite(road.A_N, 'params.roadLoad.A_N'),
      B_Nps_m: finite(road.B_Nps_m, 'params.roadLoad.B_Nps_m'),
      C_Ns2_m2: finite(road.C_Ns2_m2, 'params.roadLoad.C_Ns2_m2'),
    },
    fTracN: positive(p.fTracN, 'params.fTracN'),
    pEffW: positive(p.pEffW, 'params.pEffW'),
    eta: positive(p.eta, 'params.eta'),
    modeFactor: positive(p.modeFactor, 'params.modeFactor'),
  };
}

function sameTesla(a: TeslaParams, b: TeslaParams): boolean {
  return (
    a.massKg === b.massKg &&
    a.roadLoad.A_N === b.roadLoad.A_N &&
    a.roadLoad.B_Nps_m === b.roadLoad.B_Nps_m &&
    a.roadLoad.C_Ns2_m2 === b.roadLoad.C_Ns2_m2 &&
    a.fTracN === b.fTracN &&
    a.pEffW === b.pEffW &&
    a.eta === b.eta &&
    a.modeFactor === b.modeFactor
  );
}

function checkTuning(x: unknown): SimTuning {
  const t = obj(x, 'value');
  return {
    gpsLatencyS: nonNegative(t.gpsLatencyS, 'value.gpsLatencyS'),
    kalmanQ: positive(t.kalmanQ, 'value.kalmanQ'),
    tauA: positive(t.tauA, 'value.tauA'),
    outputLatencyS: nonNegative(t.outputLatencyS, 'value.outputLatencyS'),
  };
}

/** Shape only: GPS data quality (non-finite or implausible numbers) is the speed filter's call (counted as rejected). */
function checkFix(m: Obj): FixMsg {
  if (typeof m.ageS !== 'number' || typeof m.lat !== 'number' || typeof m.lon !== 'number' || typeof m.accuracyM !== 'number') {
    invalid('ageS, lat, lon and accuracyM must be numbers');
  }
  if (m.speedMps !== null && typeof m.speedMps !== 'number') invalid('speedMps must be a number or null');
  if (m.altitudeM !== null && typeof m.altitudeM !== 'number') invalid('altitudeM must be a number or null');
  return m as unknown as FixMsg;
}

function clampBenchK(k: number): number {
  const r = Math.round(k);
  return r < 1 ? 1 : r > BENCH_K_MAX ? BENCH_K_MAX : r;
}

/** Both DSP cores, or the reason they cannot run at this sample rate (TesboxDspCore accepts 28–48 kHz, amendment B3). */
function makeCores(fs: number): { dsp: TesboxDspCore; bench: TesboxDspCore } | string {
  try {
    return { dsp: new TesboxDspCore(fs), bench: new TesboxDspCore(fs) };
  } catch (e) {
    return errText(e);
  }
}

// ───────────────────────────── processor ─────────────────────────────

class TesboxProcessor extends AudioWorkletProcessor {
  private readonly fs: number;
  private readonly sim = new TesboxSimCore();
  /** null when TesboxDspCore cannot run at this sample rate (28–48 kHz, amendment B3); see dspError. */
  private readonly dsp: TesboxDspCore | null;
  /** Headroom benchmark core: configured like `dsp`, renders the k − 1 extra passes into scratch. */
  private readonly benchDsp: TesboxDspCore | null;
  private readonly dspError: string;
  private readonly ctl: DspControl;
  private readonly snap = new Float64Array(STATE_LEN);
  private readonly stateMsg: StateMsg = { type: 'state', buf: this.snap };
  private readonly scratchL = new Float32Array(QUANTUM);
  private readonly scratchR = new Float32Array(QUANTUM);

  // configuration (kept until both engine and tesla are known)
  private def: EngineDef | null = null;
  private defJson = '';
  private tesla: TeslaParams | null = null;
  private tuning: SimTuning = { ...DEFAULT_SIM_TUNING };
  private readonly output: OutputConfig = { ...DEFAULT_OUTPUT };
  private tier: Tier = 'full';
  private configured = false;
  private benchK = 1;

  // test tone
  private readonly tone: OutputStage;
  private readonly toneFadeStep: number;
  private readonly toneTailSamples: number;
  private readonly toneMaxHz: number;
  /** The tone path runs (fading in, on, fading out or in its tail). */
  private toneActive = false;
  /** Fade direction: true → in / on, false → out. */
  private toneOn = false;
  private toneFade = 0;
  private tonePhase = 0;
  private toneInc = 0;
  private toneAmp = 0;
  private toneAmpTarget = 0;
  private toneTailLeft = 0;

  // snapshots and busy time
  private readonly windowFrames: number;
  private quanta = 0;
  private busyMs = 0;
  private framesInWindow = 0;
  private busyFrac = Number.NaN;
  private hotWindows = 0;
  private errorPosted = false;

  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    const cores = makeCores(fs);
    const dsp = typeof cores === 'string' ? null : cores.dsp;
    this.dsp = dsp;
    this.benchDsp = typeof cores === 'string' ? null : cores.bench;
    this.dspError = `engine unavailable at ${fs} Hz: ${typeof cores === 'string' ? cores : 'n/a'}`;
    this.tone = new OutputStage(fs);
    this.tone.configure(TONE_OUTPUT);
    this.toneFadeStep = 1 / (TONE_FADE_S * fs);
    this.toneTailSamples = Math.round(TONE_TAIL_S * fs);
    this.toneMaxHz = Math.min(TONE_MAX_HZ, 0.45 * fs);
    this.windowFrames = Math.max(QUANTUM, Math.round(BUSY_WINDOW_S * fs));
    this.ctl = {
      rpm: 0,
      load: 0,
      gear: 0,
      driveline: 'clutch-open',
      limiter: false,
      shift: { active: false, up: false, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0 },
      ignitionOn: false,
      runTimeS: 0,
      valve: 'auto',
      perspective: 'cabin',
      driveMode: 'comfort',
      warm: false,
    };
    this.port.onmessage = (e: MessageEvent<unknown>) => this.onMessage(e.data);
    if (dsp === null) this.postError(this.dspError);
    else this.port.postMessage(READY);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const t0 = clockMs();
    const bus = outputs[0];
    const L = (bus !== undefined ? bus[0] : undefined) ?? this.scratchL;
    const R = (bus !== undefined ? bus[1] : undefined) ?? this.scratchR;
    const frames = L.length < R.length ? L.length : R.length;
    this.quanta++;
    try {
      this.renderQuantum(L, R, frames);
    } catch (e) {
      L.fill(0);
      R.fill(0);
      this.reportProcessError(e);
    }
    // Guarded separately: snapshots keep flowing through a persistent render fault.
    if (this.quanta % SNAPSHOT_EVERY === 0) {
      try {
        this.postState();
      } catch (e) {
        this.reportProcessError(e);
      }
    }
    this.account(clockMs() - t0, frames);
    return true;
  }

  // ── audio path ──

  private renderQuantum(L: Float32Array, R: Float32Array, frames: number): void {
    const now = currentTime;
    const dsp = this.dsp;
    if (this.configured && dsp !== null) {
      this.sim.step(now, frames / this.fs);
      this.copyControl();
      dsp.render(this.ctl, L, R, frames, now);
      const bench = this.benchDsp;
      if (bench !== null && this.benchK > 1) {
        const n = frames < QUANTUM ? frames : QUANTUM;
        for (let k = 1; k < this.benchK; k++) bench.render(this.ctl, this.scratchL, this.scratchR, n, now);
      }
    } else {
      L.fill(0, 0, frames);
      R.fill(0, 0, frames);
    }
    if (this.toneActive) this.mixTone(L, R, frames);
    // Final NaN-safe clip: nothing non-finite or above the ceiling ever leaves the worklet.
    for (let i = 0; i < frames; i++) {
      const l = L[i] ?? 0;
      L[i] = l === l ? (l > OUTPUT_CEILING ? OUTPUT_CEILING : l < -OUTPUT_CEILING ? -OUTPUT_CEILING : l) : 0;
      const r = R[i] ?? 0;
      R[i] = r === r ? (r > OUTPUT_CEILING ? OUTPUT_CEILING : r < -OUTPUT_CEILING ? -OUTPUT_CEILING : r) : 0;
    }
    if (L.length > frames) L.fill(0, frames);
    if (R.length > frames) R.fill(0, frames);
  }

  /** SimCore.out → DspControl (field copies; valve, perspective, driveMode and warm come from messages). */
  private copyControl(): void {
    const o = this.sim.out;
    const c = this.ctl;
    c.rpm = o.rpm;
    c.load = o.load;
    c.gear = o.gear;
    c.driveline = o.driveline;
    c.limiter = o.limiter;
    c.ignitionOn = o.ignitionOn;
    c.runTimeS = o.runTimeS;
    const s = o.shift;
    const d = c.shift;
    d.active = s.active;
    d.up = s.up;
    d.fromRpm = s.fromRpm;
    d.toRpm = s.toRpm;
    d.t0 = s.t0;
    d.durationS = s.durationS;
  }

  /**
   * Test tone: sine × raised-cosine fade weight w through the tone stage, crossfaded with the engine output
   * (engine × (1 − w)). The level ramps linearly across the quantum; a new hz continues the phase. After a
   * fade-out the stage runs TONE_TAIL_S longer, then resets and the path idles.
   */
  private mixTone(L: Float32Array, R: Float32Array, frames: number): void {
    const stage = this.tone;
    const on = this.toneOn;
    const step = this.toneFadeStep;
    const inc = this.toneInc;
    const a0 = this.toneAmp;
    const da = frames > 0 ? (this.toneAmpTarget - a0) / frames : 0;
    let fade = this.toneFade;
    let phase = this.tonePhase;
    for (let i = 0; i < frames; i++) {
      if (on) fade = fade + step < 1 ? fade + step : 1;
      else fade = fade - step > 0 ? fade - step : 0;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * fade);
      const x = Math.sin(TWO_PI * phase) * (a0 + da * (i + 1)) * w;
      phase += inc;
      if (phase >= 1) phase -= 1;
      stage.process(x, x);
      const g = 1 - w;
      L[i] = (L[i] ?? 0) * g + stage.l;
      R[i] = (R[i] ?? 0) * g + stage.r;
    }
    this.toneFade = fade;
    this.tonePhase = phase;
    this.toneAmp = this.toneAmpTarget;
    if (!on && fade === 0) {
      this.toneTailLeft -= frames;
      if (this.toneTailLeft <= 0) {
        this.toneActive = false;
        stage.reset();
      }
    }
  }

  // ── snapshots, busy time, errors ──

  private postState(): void {
    const s = this.snap;
    const o = this.sim.out;
    s[S.time] = currentTime;
    s[S.rpm] = o.rpm;
    s[S.gear] = o.gear;
    s[S.speedMps] = o.speedMps;
    s[S.load] = o.load;
    s[S.flags] = this.hotWindows >= OVERLOAD_WINDOWS ? o.flags | F.OVERLOAD : o.flags;
    const dsp = this.dsp;
    if (dsp !== null) {
      const st = dsp.stats;
      s[S.boost] = st.boost;
      s[S.nonFiniteResets] = st.nonFiniteResets;
    } else {
      s[S.boost] = 0;
      s[S.nonFiniteResets] = 0;
    }
    s[S.fixesAccepted] = this.sim.fixesAccepted;
    s[S.fixesRejected] = this.sim.fixesRejected;
    s[S.busyFrac] = this.busyFrac;
    s[S.tier] = this.tier === 'lite' ? 1 : 0;
    s[S.benchK] = this.benchK;
    s[S.throttle] = o.load > 0 ? o.load : 0;
    const msg = this.stateMsg;
    msg.buf = s.slice(); // a fresh copy per snapshot: the one allocation process() makes
    this.port.postMessage(msg);
  }

  /** busyFrac = busy ms / audio ms over windows of ~BUSY_WINDOW_S; F.OVERLOAD after OVERLOAD_WINDOWS hot windows in a row. */
  private account(busyMs: number, frames: number): void {
    this.busyMs += busyMs > 0 ? busyMs : 0; // a clock stepping backwards counts as 0
    this.framesInWindow += frames;
    if (this.framesInWindow < this.windowFrames) return;
    const frac = this.busyMs / ((this.framesInWindow / this.fs) * 1000);
    this.busyFrac = frac;
    this.hotWindows = frac > OVERLOAD_FRAC ? this.hotWindows + 1 : 0;
    this.busyMs = 0;
    this.framesInWindow = 0;
    this.errorPosted = false;
  }

  /** At most one 'error' per busy window, so a persistent fault cannot flood the main thread. */
  private reportProcessError(e: unknown): void {
    if (this.errorPosted) return;
    this.errorPosted = true;
    this.postError(`process: ${errText(e)}`);
  }

  private postError(message: string): void {
    const msg: WorkletToMain = { type: 'error', message };
    this.port.postMessage(msg);
  }

  // ── messages ──

  private onMessage(data: unknown): void {
    let label = 'message';
    try {
      if (!isObj(data)) invalid('must be an object with a string type');
      const type = data.type;
      if (typeof type !== 'string') invalid('must be an object with a string type');
      label = type.length > TYPE_MAX_CHARS ? type.slice(0, TYPE_MAX_CHARS) : type;
      this.handle(data, type);
    } catch (e) {
      this.postError(`${label}: ${errText(e)}`);
    }
  }

  /** Validates everything a message carries before changing any state. */
  private handle(m: Obj, type: string): void {
    const now = currentTime;
    switch (type) {
      case 'engine':
        this.onEngine(m.def);
        return;
      case 'tesla':
        this.onTesla(m.params);
        return;
      case 'tuning':
        this.onTuning(m.value);
        return;
      case 'output':
        this.onOutput(m.config);
        return;
      case 'tier':
        this.tier = oneOf(m.value, TIERS, 'value');
        this.reconfigureDsp();
        return;
      case 'source':
        this.sim.setSource(oneOf(m.value, SOURCES, 'value'));
        return;
      case 'warm': {
        const warm = bool(m.warm, 'warm');
        this.ctl.warm = warm;
        this.sim.setWarm(warm);
        return;
      }
      case 'fix':
        this.sim.pushFix(checkFix(m), now);
        return;
      // ── InputMsg: validated and applied here, then forwarded to SimCore below ──
      case 'shiftUp':
      case 'shiftDown':
        break;
      case 'pedal':
        finite(m.throttle, 'throttle');
        finite(m.brake, 'brake');
        break;
      case 'valve':
        this.ctl.valve = oneOf(m.mode, VALVES, 'mode');
        break;
      case 'perspective':
        this.ctl.perspective = oneOf(m.value, PERSPECTIVES, 'value');
        break;
      case 'gearboxMode':
        oneOf(m.value, GEARBOX_MODES, 'value');
        break;
      case 'driveMode':
        this.ctl.driveMode = oneOf(m.value, DRIVE_MODES, 'value');
        break;
      case 'volume':
        this.output.volumeTrimDb = finite(m.trimDb, 'trimDb');
        this.reconfigureDsp();
        break;
      case 'visibility':
        bool(m.hidden, 'hidden');
        break;
      case 'ignition':
        bool(m.on, 'on');
        break;
      case 'bench':
        this.benchK = clampBenchK(finite(m.k, 'k'));
        break;
      case 'testTone':
        this.onTone(m);
        break;
      default:
        invalid('unknown message type');
    }
    this.sim.pushInput(m as unknown as InputMsg, now);
  }

  private onEngine(x: unknown): void {
    if (this.dsp === null) invalid(this.dspError);
    const def = checkEngine(x, this.fs);
    const json = JSON.stringify(def);
    if (this.def !== null && json === this.defJson) return; // the current engine again: no fade, no gear reset
    const tesla = this.tesla;
    if (tesla !== null) this.configureCores(def, tesla);
    this.def = def;
    this.defJson = json;
  }

  private onTesla(x: unknown): void {
    const params = checkTesla(x);
    if (this.tesla !== null && sameTesla(params, this.tesla)) return;
    const def = this.def;
    if (def !== null) {
      if (this.configured) this.sim.configure(def.spec, def.voicing, params, this.tuning);
      else this.configureCores(def, params);
    }
    this.tesla = params;
  }

  private onTuning(x: unknown): void {
    const tuning = checkTuning(x);
    this.tuning = tuning;
    if (this.configured) this.sim.setTuning(tuning);
  }

  private onOutput(x: unknown): void {
    const c = obj(x, 'config');
    const subwoofer = oneOf(c.subwoofer, SUBWOOFERS, 'config.subwoofer');
    const hpCornerHz = finite(c.hpCornerHz, 'config.hpCornerHz');
    const volumeTrimDb = finite(c.volumeTrimDb, 'config.volumeTrimDb');
    const o = this.output;
    o.subwoofer = subwoofer;
    o.hpCornerHz = hpCornerHz;
    o.volumeTrimDb = volumeTrimDb;
    this.reconfigureDsp();
  }

  private onTone(m: Obj): void {
    if (m.hz === null) {
      this.toneOn = false;
      return;
    }
    if (typeof m.hz !== 'number' || !(m.hz > 0) || m.hz === Infinity) invalid('hz must be a finite number > 0, or null');
    const db = finite(m.levelDb, 'levelDb');
    const hz = m.hz < TONE_MIN_HZ ? TONE_MIN_HZ : m.hz > this.toneMaxHz ? this.toneMaxHz : m.hz;
    const amp = dbToGain(db < TONE_MIN_DB ? TONE_MIN_DB : db > TONE_MAX_DB ? TONE_MAX_DB : db);
    if (!this.toneActive) {
      this.tone.reset();
      this.tonePhase = 0;
      this.toneFade = 0;
      this.toneAmp = amp;
      this.toneActive = true;
    }
    this.toneInc = hz / this.fs;
    this.toneAmpTarget = amp;
    this.toneOn = true;
    this.toneTailLeft = this.toneTailSamples;
  }

  /** First configuration and engine changes. `def` passed checkEngine, so DspCore.configure cannot throw once SimCore took it. */
  private configureCores(def: EngineDef, tesla: TeslaParams): void {
    const dsp = this.dsp;
    if (dsp === null) invalid(this.dspError);
    this.sim.configure(def.spec, def.voicing, tesla, this.tuning);
    dsp.configure(def, this.output, this.tier);
    this.benchDsp?.configure(def, this.output, this.tier);
    this.configured = true;
  }

  /** output / tier / volume: DspCore applies a trim-only change without a fade, anything else behind its 300 ms fade. */
  private reconfigureDsp(): void {
    const def = this.def;
    if (!this.configured || def === null) return;
    this.dsp?.configure(def, this.output, this.tier);
    this.benchDsp?.configure(def, this.output, this.tier);
  }
}

registerProcessor(PROCESSOR_NAME, TesboxProcessor);
