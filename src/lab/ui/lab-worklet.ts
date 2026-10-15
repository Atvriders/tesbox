/**
 * The Sound Lab AudioWorkletProcessor 'tesbox-lab' (phase-2c contract L1/L2). Loaded like the app's worklet:
 * `./lab-worklet.ts?worker&url` (Vite bundles it into one self-contained script) → audioWorklet.addModule →
 * `new AudioWorkletNode(ctx, 'tesbox-lab', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })`.
 * The module exports nothing: importing it anywhere else would register the processor in that scope.
 *
 * It hosts one TesboxDspCore — whose last stage is the app's output stage, configured with DEFAULT_OUTPUT or the
 * page's sub / no-sub preset — and the lab's control state (src/lab/ui/lab-control.ts); no SimCore. Messages
 * follow src/lab/ui/protocol.ts; each is validated before anything changes, and a malformed one posts
 * `{ type: 'error', message }`:
 * - `engine`: assertEngineFits(def, sampleRate) and the spec numbers the control needs; a refusal keeps the
 *   previous engine playing. Otherwise DspCore.configure() (behind the core's own 300 ms config fade once it
 *   runs) and the control re-binds its segments and re-clamps the manual control to the new spec.
 * - `tier` / `output` reconfigure the core with the current engine; `gain` sets the monitor level (clamped to
 *   −40…0 dB), ramped across a quantum and applied after the stage.
 * - `manual` / `event` / `segment` go to the control state.
 *
 * process(): control.step → dsp.render (silence until an engine is configured) → the meter accumulates the
 * stage output → monitor gain → a final NaN-safe clip at OUTPUT_CEILING. A meter is posted every
 * round(fs / (20 · 128)) quanta (≈ 20 Hz). Allocation: like the app worklet, process() makes one bounded
 * allocation per meter post (the message object), plus an error string on the exception path; message
 * handling may allocate. process() always returns true and never throws (at most one error post per second).
 */
import { DEFAULT_OUTPUT, QUANTUM, type EngineDef, type OutputConfig, type Subwoofer, type Tier } from '../../contracts';
import { TesboxDspCore, assertEngineFits } from '../../dsp/dsp-core';
import { OUTPUT_CEILING } from '../../dsp/output-stage';
import { dbToGain, gainToDb } from '../../dsp/util';
import { LabControl } from './lab-control';
import {
  LAB_EVENTS,
  LAB_PROCESSOR,
  METER_HZ,
  MONITOR_DEFAULT_DB,
  MONITOR_MAX_DB,
  MONITOR_MIN_DB,
  type LabEvent,
  type LabToMain,
  type ManualControl,
  type MeterMsg,
} from './protocol';

const ERROR_MAX_CHARS = 300;
const TYPE_MAX_CHARS = 40;
const SILENT_DB = -200;
const TIERS: readonly Tier[] = ['full', 'lite'];
const SUBWOOFERS: readonly Subwoofer[] = ['yes', 'no', 'unsure'];
const VALVES: readonly ManualControl['valve'][] = ['auto', 'open', 'closed'];
const PERSPECTIVES: readonly ManualControl['perspective'][] = ['cabin', 'outside'];
const DRIVE_MODES: readonly ManualControl['driveMode'][] = ['comfort', 'sport'];

const READY: LabToMain = { type: 'ready' };

type Obj = Record<string, unknown>;

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
  return s.length > ERROR_MAX_CHARS ? `${s.slice(0, ERROR_MAX_CHARS)}…` : s;
}

function invalid(what: string): never {
  throw new TypeError(what);
}

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function finite(x: unknown, what: string): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : invalid(`${what} must be a finite number`);
}

function oneOf<T extends string>(x: unknown, values: readonly T[], what: string): T {
  return typeof x === 'string' && (values as readonly string[]).includes(x)
    ? (x as T)
    : invalid(`${what} must be one of ${values.join(' | ')}`);
}

/** What LabControl and the segments read from the spec (assertEngineFits checks only what the core needs). */
function checkControlSpec(def: EngineDef): void {
  const spec = def.spec;
  const rpm = isObj(spec.rpm) ? spec.rpm : invalid('def.spec.rpm must be an object');
  const idle = finite(rpm.idle, 'def.spec.rpm.idle');
  const limiter = isObj(rpm.limiter) ? rpm.limiter : invalid('def.spec.rpm.limiter must be an object');
  if (!(finite(limiter.rpm, 'def.spec.rpm.limiter.rpm') > idle)) invalid('def.spec.rpm.limiter.rpm must exceed rpm.idle');
  finite(rpm.redline, 'def.spec.rpm.redline');
  const gearbox = isObj(spec.gearbox) ? spec.gearbox : invalid('def.spec.gearbox must be an object');
  const ratios: unknown = gearbox.overallRatios;
  if (!Array.isArray(ratios) || ratios.length === 0) invalid('def.spec.gearbox.overallRatios must be a non-empty array');
  for (const r of ratios) if (!(finite(r, 'def.spec.gearbox.overallRatios[]') > 0)) invalid('def.spec.gearbox.overallRatios must be > 0');
  finite(gearbox.shiftTimeS, 'def.spec.gearbox.shiftTimeS');
}

class LabProcessor extends AudioWorkletProcessor {
  private readonly fs: number;
  /** null when TesboxDspCore cannot run at this sample rate (28–48 kHz). */
  private readonly dsp: TesboxDspCore | null;
  private readonly dspError: string;
  private readonly control = new LabControl();
  private readonly scratchL = new Float32Array(QUANTUM);
  private readonly scratchR = new Float32Array(QUANTUM);
  private def: EngineDef | null = null;
  private readonly output: OutputConfig = { ...DEFAULT_OUTPUT };
  private tier: Tier = 'full';
  private gain = dbToGain(MONITOR_DEFAULT_DB);
  private gainTarget = dbToGain(MONITOR_DEFAULT_DB);

  // meter window (the stage output, before the monitor gain)
  private readonly meterEvery: number;
  private quanta = 0;
  private sumSq = 0;
  private samples = 0;
  private peakDb = SILENT_DB;
  private grDb = 0;
  private boost = 0;
  private resets = 0;

  // process() error throttling: at most one per second of audio
  private readonly errorEvery: number;
  private errorQuanta = 0;
  private errorPosted = false;

  constructor() {
    super();
    const fs = sampleRate;
    this.fs = fs;
    let dsp: TesboxDspCore | null = null;
    let why = '';
    try {
      dsp = new TesboxDspCore(fs);
    } catch (e) {
      why = errText(e);
    }
    this.dsp = dsp;
    this.dspError = `engine unavailable at ${fs} Hz: ${why}`;
    this.meterEvery = Math.max(1, Math.round(fs / (METER_HZ * QUANTUM)));
    this.errorEvery = Math.max(1, Math.round(fs / QUANTUM));
    this.port.onmessage = (e: MessageEvent<unknown>) => this.onMessage(e.data);
    if (dsp === null) this.postError(this.dspError);
    else this.port.postMessage(READY);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const bus = outputs[0];
    const L = (bus !== undefined ? bus[0] : undefined) ?? this.scratchL;
    const R = (bus !== undefined ? bus[1] : undefined) ?? this.scratchR;
    const frames = L.length < R.length ? L.length : R.length;
    try {
      this.renderQuantum(L, R, frames);
    } catch (e) {
      L.fill(0);
      R.fill(0);
      this.reportProcessError(e);
    }
    if (++this.quanta >= this.meterEvery) {
      this.quanta = 0;
      try {
        this.postMeter();
      } catch (e) {
        this.reportProcessError(e);
      }
    }
    if (++this.errorQuanta >= this.errorEvery) {
      this.errorQuanta = 0;
      this.errorPosted = false;
    }
    return true;
  }

  // ── audio path ──

  private renderQuantum(L: Float32Array, R: Float32Array, frames: number): void {
    const dsp = this.dsp;
    if (dsp !== null && this.def !== null) {
      const now = currentTime;
      const ctl = this.control.step(now, frames / this.fs);
      dsp.render(ctl, L, R, frames, now);
      const st = dsp.stats; // read once per quantum: the true peak is read-and-reset
      if (st.truePeakDbtp > this.peakDb) this.peakDb = st.truePeakDbtp;
      if (st.limiterGainReductionDb > this.grDb) this.grDb = st.limiterGainReductionDb;
      this.boost = st.boost;
      this.resets = st.nonFiniteResets;
    } else {
      L.fill(0, 0, frames);
      R.fill(0, 0, frames);
    }
    // Meter (stage output), then the monitor gain ramped across the quantum, then the NaN-safe clip.
    const g0 = this.gain;
    const dg = frames > 0 ? (this.gainTarget - g0) / frames : 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      let l = L[i] ?? 0;
      let r = R[i] ?? 0;
      if (l !== l) l = 0;
      if (r !== r) r = 0;
      sum += l * l + r * r;
      const g = g0 + dg * (i + 1);
      l *= g;
      r *= g;
      L[i] = l > OUTPUT_CEILING ? OUTPUT_CEILING : l < -OUTPUT_CEILING ? -OUTPUT_CEILING : l;
      R[i] = r > OUTPUT_CEILING ? OUTPUT_CEILING : r < -OUTPUT_CEILING ? -OUTPUT_CEILING : r;
    }
    this.gain = this.gainTarget;
    this.sumSq += sum;
    this.samples += 2 * frames;
    if (L.length > frames) L.fill(0, frames);
    if (R.length > frames) R.fill(0, frames);
  }

  private postMeter(): void {
    const c = this.control.ctl;
    const on = this.def !== null && this.dsp !== null;
    const msg: MeterMsg = {
      type: 'meter',
      rmsDb: gainToDb(this.samples > 0 ? Math.sqrt(this.sumSq / this.samples) : 0),
      peakDb: this.peakDb,
      rpm: on ? c.rpm : 0,
      gear: on ? c.gear : 0,
      limiter: on && c.limiter,
      boost: this.boost,
      limiterGrDb: this.grDb,
      nonFiniteResets: this.resets,
    };
    this.sumSq = 0;
    this.samples = 0;
    this.peakDb = SILENT_DB;
    this.grDb = 0;
    this.port.postMessage(msg);
  }

  private reportProcessError(e: unknown): void {
    if (this.errorPosted) return;
    this.errorPosted = true;
    this.postError(`process: ${errText(e)}`);
  }

  private postError(message: string): void {
    const msg: LabToMain = { type: 'error', message };
    this.port.postMessage(msg);
  }

  // ── messages (validated before anything changes; may allocate) ──

  private onMessage(data: unknown): void {
    let label = 'message';
    try {
      if (!isObj(data) || typeof data.type !== 'string') invalid('must be an object with a string type');
      const type = data.type;
      label = type.length > TYPE_MAX_CHARS ? type.slice(0, TYPE_MAX_CHARS) : type;
      this.handle(data, type);
    } catch (e) {
      this.postError(`${label}: ${errText(e)}`);
    }
  }

  private handle(m: Obj, type: string): void {
    switch (type) {
      case 'engine':
        this.onEngine(m.def);
        return;
      case 'tier':
        this.tier = oneOf(m.value, TIERS, 'value');
        this.reconfigure();
        return;
      case 'output':
        this.onOutput(m.config);
        return;
      case 'gain': {
        const db = finite(m.db, 'db');
        this.gainTarget = dbToGain(db < MONITOR_MIN_DB ? MONITOR_MIN_DB : db > MONITOR_MAX_DB ? MONITOR_MAX_DB : db);
        return;
      }
      case 'manual':
        this.control.setManual({
          rpm: finite(m.rpm, 'rpm'),
          load: finite(m.load, 'load'),
          gear: finite(m.gear, 'gear'),
          valve: oneOf(m.valve, VALVES, 'valve'),
          perspective: oneOf(m.perspective, PERSPECTIVES, 'perspective'),
          driveMode: oneOf(m.driveMode, DRIVE_MODES, 'driveMode'),
          warm: typeof m.warm === 'boolean' ? m.warm : invalid('warm must be a boolean'),
        });
        return;
      case 'event': {
        const ev: LabEvent = oneOf(m.ev, LAB_EVENTS, 'ev');
        this.control.event(ev, currentTime);
        return;
      }
      case 'segment': {
        const name = m.name;
        if (name !== null && typeof name !== 'string') invalid('name must be a string or null');
        this.control.setSegment(name, currentTime);
        return;
      }
      default:
        invalid('unknown message type');
    }
  }

  private onEngine(x: unknown): void {
    const dsp = this.dsp;
    if (dsp === null) invalid(this.dspError);
    const def = x as EngineDef;
    assertEngineFits(def, this.fs); // throws (nothing changed) on a definition the core cannot run
    checkControlSpec(def);
    dsp.configure(def, this.output, this.tier);
    this.control.configure(def.spec);
    this.def = def;
  }

  private onOutput(x: unknown): void {
    const c = isObj(x) ? x : invalid('config must be an object');
    const subwoofer = oneOf(c.subwoofer, SUBWOOFERS, 'config.subwoofer');
    const hpCornerHz = finite(c.hpCornerHz, 'config.hpCornerHz');
    const volumeTrimDb = finite(c.volumeTrimDb, 'config.volumeTrimDb');
    this.output.subwoofer = subwoofer;
    this.output.hpCornerHz = hpCornerHz;
    this.output.volumeTrimDb = volumeTrimDb;
    this.reconfigure();
  }

  private reconfigure(): void {
    const def = this.def;
    if (def !== null) this.dsp?.configure(def, this.output, this.tier);
  }
}

registerProcessor(LAB_PROCESSOR, LabProcessor);
