/**
 * The 'tesbox' AudioWorkletProcessor (src/audio/worklet.ts, phase-3 contract T3) run in Node through an
 * AudioWorkletGlobalScope shim: a base `AudioWorkletProcessor` whose `port` is one end of a real
 * MessageChannel (main → worklet messages are structured-cloned and delivered asynchronously, as in the
 * browser; worklet → main posts are captured synchronously as structured clones), `registerProcessor`
 * capture, and `sampleRate` / `currentTime` globals driven by the test (each rig keeps its own clock).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIM_TUNING,
  F,
  QUANTUM,
  S,
  STATE_LEN,
  type DspControl,
  type EngineDef,
  type MainToWorklet,
  type OutputConfig,
  type SimOutput,
  type SpeedSourceKind,
  type TeslaParams,
  type Tier,
  type WorkletToMain,
} from '../../src/contracts';
import { resolveTeslaParams } from '../../src/data/catalogue';
import { getEngine } from '../../src/data/engines/index';
import { TesboxDspCore } from '../../src/dsp/dsp-core';
import { ExhaustNetwork } from '../../src/dsp/exhaust';
import { OUTPUT_CEILING } from '../../src/dsp/output-stage';
import { Rng, dbToGain } from '../../src/dsp/util';
import { TesboxSimCore } from '../../src/sim/sim-core';
import { countBufferConstructions } from './helpers/dsp-harness';

const SR = 48000;
const ENGINE: EngineDef = getEngine('i5-turbo-25');
/** The Garage switch target: NA V8, idle 700 rpm (ENGINE idles at 850). */
const V8: EngineDef = getEngine('v8-na-50');
const TESLA: TeslaParams = resolveTeslaParams('model3-highland-lr-awd');
const OUT_SUB: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 };
/** Stage look-ahead of OutputStage at 48 kHz: round(1.5 ms · fs). */
const LOOKAHEAD = 72;
/** Synthetic coordinates near (0, 0) — never a real place of interest. */
const LAT0 = 0.004321;
const LON0 = 0.008765;
/** Options for the tests that render several seconds of audio. */
const SLOW = { timeout: 60_000 };

// ───────────────────────────── AudioWorkletGlobalScope shim ─────────────────────────────

interface Proc {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
type ProcCtor = new (options: AudioWorkletNodeOptions) => Proc;
type StateMsg = Extract<WorkletToMain, { type: 'state' }>;
type ErrorMsg = Extract<WorkletToMain, { type: 'error' }>;

let audioTime = 0;
let rate = SR;
let lastCreated: { node: MessagePort; posted: WorkletToMain[]; rawBufs: Float64Array[] } | null = null;
const registered: { name: string; ctor: ProcCtor | null; count: number } = { name: '', ctor: null, count: 0 };
const openPorts: MessagePort[] = [];

/** Base class of every processor: `port` is port1 of a real MessageChannel; port2 is the node side. */
class ShimAudioWorkletProcessor {
  readonly port: MessagePort;
  constructor() {
    const ch = new MessageChannel();
    const posted: WorkletToMain[] = [];
    const rawBufs: Float64Array[] = [];
    // Worklet → main: record a structured clone at post time (what the main thread would receive), and
    // the posted snapshot buffer itself (to check that every snapshot is a fresh copy).
    Object.defineProperty(ch.port1, 'postMessage', {
      value: (msg: unknown) => {
        posted.push(structuredClone(msg) as WorkletToMain);
        const buf = (msg as { buf?: unknown }).buf;
        if (buf instanceof Float64Array) rawBufs.push(buf);
      },
    });
    this.port = ch.port1;
    lastCreated = { node: ch.port2, posted, rawBufs };
    openPorts.push(ch.port1, ch.port2);
  }
}

beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', ShimAudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (name: string, ctor: ProcCtor) => {
    registered.name = name;
    registered.ctor = ctor;
    registered.count++;
  });
  Object.defineProperty(globalThis, 'sampleRate', { get: () => rate, configurable: true });
  Object.defineProperty(globalThis, 'currentTime', { get: () => audioTime, configurable: true });
  await import('../../src/audio/worklet');
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'sampleRate');
  Reflect.deleteProperty(globalThis, 'currentTime');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const p of openPorts.splice(0)) p.close();
  rate = SR;
});

interface Rendered {
  left: Float32Array;
  right: Float32Array;
}

/** One processor + its node-side port and its own audio clock. */
class Rig {
  readonly proc: Proc;
  readonly node: MessagePort;
  readonly posted: WorkletToMain[];
  /** The Float64Array objects the worklet posted as snapshots (not clones). */
  readonly rawBufs: Float64Array[];
  readonly fs: number;
  /** Quanta rendered so far (the clock: t = q · 128 / fs). */
  q = 0;
  private delivered = 0;
  private expected = 0;
  private wake: (() => void) | null = null;
  private readonly l = new Float32Array(QUANTUM);
  private readonly r = new Float32Array(QUANTUM);

  constructor(fs = SR) {
    rate = fs;
    const ctor = registered.ctor;
    if (ctor === null) throw new Error('processor was not registered');
    this.proc = new ctor({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const created = lastCreated;
    if (created === null) throw new Error('the processor did not construct its base class');
    this.node = created.node;
    this.posted = created.posted;
    this.rawBufs = created.rawBufs;
    this.fs = fs;
    // Registered after the processor's own onmessage, so it runs after the processor handled a message.
    this.proc.port.addEventListener('message', () => {
      this.delivered++;
      this.wake?.();
    });
  }

  get t(): number {
    return (this.q * QUANTUM) / this.fs;
  }

  /** Posts from the node side at the rig's current time and waits until the worklet handled them all. */
  async send(...msgs: unknown[]): Promise<void> {
    audioTime = this.t;
    for (const m of msgs) this.node.postMessage(m);
    this.expected += msgs.length;
    while (this.delivered < this.expected) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    this.wake = null;
  }

  /** Renders round(seconds · fs / 128) quanta. Output buffers are NaN-filled first: every sample must be written. */
  run(seconds: number): Rendered {
    return this.quanta(Math.round((seconds * this.fs) / QUANTUM));
  }

  quanta(n: number): Rendered {
    const left = new Float32Array(n * QUANTUM);
    const right = new Float32Array(n * QUANTUM);
    for (let i = 0; i < n; i++) {
      this.l.fill(Number.NaN);
      this.r.fill(Number.NaN);
      audioTime = this.t;
      if (this.proc.process([], [[this.l, this.r]], {}) !== true) throw new Error('process() must return true');
      left.set(this.l, i * QUANTUM);
      right.set(this.r, i * QUANTUM);
      this.q++;
    }
    return { left, right };
  }

  mark(): number {
    return this.posted.length;
  }

  states(from = 0): Float64Array[] {
    return this.posted.slice(from).filter((m): m is StateMsg => m.type === 'state').map((m) => m.buf);
  }

  last(): Float64Array {
    const st = this.states();
    const s = st[st.length - 1];
    if (s === undefined) throw new Error('no snapshot yet');
    return s;
  }

  errors(from = 0): string[] {
    return this.posted.slice(from).filter((m): m is ErrorMsg => m.type === 'error').map((m) => m.message);
  }
}

function config(
  o: { source?: SpeedSourceKind; tier?: Tier; output?: OutputConfig; warm?: boolean } = {},
): MainToWorklet[] {
  return [
    { type: 'engine', def: ENGINE },
    { type: 'tesla', params: TESLA },
    { type: 'output', config: o.output ?? OUT_SUB },
    { type: 'source', value: o.source ?? 'demo' },
    { type: 'tuning', value: DEFAULT_SIM_TUNING },
    { type: 'tier', value: o.tier ?? 'full' },
    { type: 'warm', warm: o.warm ?? true },
  ];
}

// ───────────────────────────── signal helpers ─────────────────────────────

function seg(x: Float32Array, fromS: number, toS: number, fs = SR): Float32Array {
  return x.subarray(Math.round(fromS * fs), Math.round(toS * fs));
}

function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i] ?? Number.NaN));
  return p;
}

function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, x.length));
}

function maxStep(x: ArrayLike<number>): number {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs((x[i] ?? 0) - (x[i - 1] ?? 0)));
  return m;
}

/** The clip ceiling as stored in a Float32Array (0.8913 rounds up to 0.89130002 in float32). */
const CEILING_F32 = Math.fround(OUTPUT_CEILING);

/** Every sample finite and within the output ceiling. */
function sane(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? Number.NaN;
    if (!Number.isFinite(v) || Math.abs(v) > CEILING_F32) return false;
  }
  return true;
}

function allZero(r: Rendered): boolean {
  return r.left.every((v) => v === 0) && r.right.every((v) => v === 0);
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Least-squares fit of a·sin + b·cos + c at `hz` over a whole number of periods → residual RMS / amplitude, amplitude. */
function sineFit(x: Float32Array, hz: number, fs = SR): { amp: number; residual: number } {
  const n = x.length;
  let sx = 0;
  let cx = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * hz * i) / fs;
    const v = x[i] ?? 0;
    sx += v * Math.sin(w);
    cx += v * Math.cos(w);
    mean += v;
  }
  const a = (2 * sx) / n;
  const b = (2 * cx) / n;
  mean /= n;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * hz * i) / fs;
    e += ((x[i] ?? 0) - a * Math.sin(w) - b * Math.cos(w) - mean) ** 2;
  }
  const amp = Math.hypot(a, b);
  return { amp, residual: Math.sqrt(e / n) / amp };
}

/** Peak |x| over the period-long window centred on sample n. */
function envelopeAt(x: Float32Array, n: number, period: number): number {
  return peak(x.subarray(Math.max(0, n - (period >> 1)), n + (period >> 1)));
}

function firstNonZero(x: Float32Array): number {
  return x.findIndex((v) => v !== 0);
}

/** Captures a deep copy of the DspControl handed to every TesboxDspCore.render call (main and bench cores). */
function captureControl(): DspControl[] {
  const seen: DspControl[] = [];
  const original = TesboxDspCore.prototype.render;
  vi.spyOn(TesboxDspCore.prototype, 'render').mockImplementation(function (this: TesboxDspCore, ctl, l, r, frames, nowS) {
    seen.push({ ...ctl, shift: { ...ctl.shift } });
    original.call(this, ctl, l, r, frames, nowS);
  });
  return seen;
}

/** Captures a deep copy of SimCore.out right after every TesboxSimCore.step call. */
function captureSimOut(): SimOutput[] {
  const seen: SimOutput[] = [];
  const original = TesboxSimCore.prototype.step;
  vi.spyOn(TesboxSimCore.prototype, 'step').mockImplementation(function (this: TesboxSimCore, nowS, dtS) {
    original.call(this, nowS, dtS);
    seen.push({ ...this.out, shift: { ...this.out.shift } });
  });
  return seen;
}

/** The SimOutput fields the worklet copies into the DspControl each quantum (contract T3), shift trajectory included. */
function copiedFields(x: SimOutput | DspControl): Pick<DspControl, 'rpm' | 'load' | 'gear' | 'driveline' | 'limiter' | 'shift' | 'ignitionOn' | 'runTimeS'> {
  return {
    rpm: x.rpm,
    load: x.load,
    gear: x.gear,
    driveline: x.driveline,
    limiter: x.limiter,
    shift: { ...x.shift },
    ignitionOn: x.ignitionOn,
    runTimeS: x.runTimeS,
  };
}

/** Fake millisecond clock for both Date.now and performance.now: every read advances it by `stepMs`. */
function fakeClock(stepMs: () => number): void {
  let now = 1_000_000;
  const read = (): number => (now += stepMs());
  vi.spyOn(performance, 'now').mockImplementation(read);
  vi.spyOn(Date, 'now').mockImplementation(read);
}

// ───────────────────────────── tests ─────────────────────────────

describe("worklet 'tesbox' — registration, silence, snapshots", () => {
  it("registers once as 'tesbox'; a new processor posts { type: 'ready' } and nothing else", () => {
    expect(registered.name).toBe('tesbox');
    expect(registered.count).toBe(1);
    const rig = new Rig();
    expect(rig.posted).toEqual([{ type: 'ready' }]);
  });

  it('renders exact silence until both engine and tesla are known (ignition, inputs, output or an engine alone change nothing)', async () => {
    const rig = new Rig();
    expect(allZero(rig.run(0.5))).toBe(true);
    await rig.send(
      { type: 'ignition', on: true },
      { type: 'source', value: 'demo' },
      { type: 'pedal', throttle: 1, brake: 0 },
      { type: 'output', config: OUT_SUB },
      { type: 'engine', def: ENGINE },
    );
    expect(allZero(rig.run(1))).toBe(true);
    await rig.send({ type: 'tesla', params: TESLA }); // now configured: the pending ignition cranks the engine
    const on = rig.run(2.5);
    expect(rms(seg(on.left, 1, 2.5))).toBeGreaterThan(1e-3);
    expect(rig.errors()).toEqual([]);
  });

  it('posts a fresh STATE_LEN snapshot every 12 quanta, stamped with currentTime; busyFrac is NaN until the first ~1 s window', async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'gps' }));
    rig.quanta(12 * 40);
    const st = rig.states();
    expect(st.length).toBe(40);
    st.forEach((s, k) => {
      expect(s).toBeInstanceOf(Float64Array);
      expect(s.length).toBe(STATE_LEN);
      expect(s[S.time]).toBeCloseTo(((12 * (k + 1) - 1) * QUANTUM) / SR, 12);
      expect(s[S.tier]).toBe(0);
      expect(s[S.benchK]).toBe(1);
    });
    expect(st[0]?.[S.busyFrac]).toBeNaN();
    const late = st[st.length - 1];
    expect(Number.isFinite(late?.[S.busyFrac])).toBe(true); // 480 quanta > one 375-quantum window
    expect(late?.[S.busyFrac]).toBeGreaterThanOrEqual(0);
    // a fresh copy per snapshot: distinct buffers, none rewritten after it was posted
    expect(new Set(rig.rawBufs).size).toBe(40);
    rig.rawBufs.forEach((raw, k) => expect(raw).toEqual(st[k]));
  });
});

describe("worklet 'tesbox' — engine and vehicle", () => {
  it('key-on → crank → idle is audible; rpm settles near idle at a standstill; silent again ~2 s after key-off', SLOW, async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'gps' }));
    const before = rig.run(0.5);
    expect(peak(before.left)).toBeLessThan(1e-9); // configured, ignition off
    await rig.send({ type: 'ignition', on: true });
    const crank = rig.run(3.5);
    expect(sane(crank.left) && sane(crank.right)).toBe(true);
    expect(rms(seg(crank.left, 1, 3.5))).toBeGreaterThan(1e-3);
    const idle = rig.last();
    expect(Math.abs((idle[S.rpm] ?? 0) - ENGINE.spec.rpm.idle)).toBeLessThan(100);
    expect(idle[S.gear]).toBe(1);
    expect((idle[S.flags] ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    await rig.send({ type: 'ignition', on: false });
    const off = rig.run(2.5);
    expect(peak(seg(off.left, 2.0, 2.5))).toBeLessThan(1e-4);
    expect(rig.last()[S.rpm]).toBe(0);
  });

  it('demo source: over the demo loop the snapshots show the pull-away, upshifts and a wide rpm swing', SLOW, async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo', tier: 'lite' }), { type: 'ignition', on: true });
    const audio = rig.run(21);
    expect(sane(audio.left) && sane(audio.right)).toBe(true);
    const st = rig.states();
    const gears = st.map((s) => s[S.gear] ?? 0);
    const rpms = st.filter((s) => (s[S.time] ?? 0) > 3).map((s) => s[S.rpm] ?? 0);
    expect(Math.max(...gears)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...rpms) - Math.min(...rpms)).toBeGreaterThan(2500);
    expect(Math.max(...st.map((s) => s[S.speedMps] ?? 0))).toBeGreaterThan(15);
    expect(st.some((s) => ((s[S.flags] ?? 0) & F.SHIFTING) !== 0)).toBe(true);
    expect(Math.max(...st.map((s) => s[S.throttle] ?? 0))).toBeGreaterThan(0.9);
    for (const s of st) {
      expect(s[S.throttle]).toBe(Math.max(0, s[S.load] ?? 0));
      expect(s[S.tier]).toBe(1);
      expect(s[S.boost]).toBeGreaterThanOrEqual(0);
      expect(s[S.boost]).toBeLessThanOrEqual(1);
    }
    // S.boost is the audible core's turbo boost (the bench core does not render at k = 1): none at idle, and the
    // i5 turbo spools up on the full-throttle pull (demo profile 13.5–19.5 s)
    const boost = (fromS: number, toS: number): number[] =>
      st.filter((s) => (s[S.time] ?? 0) >= fromS && (s[S.time] ?? 0) < toS).map((s) => s[S.boost] ?? 0);
    expect(Math.max(...boost(0, 3))).toBeLessThan(0.05);
    expect(Math.max(...boost(13.5, 19.5))).toBeGreaterThan(0.5);
    expect(rig.errors()).toEqual([]);
  });

  it('gearboxMode Manual reaches the gearbox (the demo pull-away holds 1st); shiftUp / shiftDown shift without an Auto override', SLOW, async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'gearboxMode', value: 'manual' }, { type: 'ignition', on: true });
    rig.run(6.5);
    // Auto upshifts this pull-away into 2nd at ≈ 6.0 s; Manual never shifts on its own (anti-lug downshifts only)
    expect(Math.max(...rig.states().map((s) => s[S.gear] ?? 0))).toBe(1);
    expect(rig.last()[S.speedMps]).toBeGreaterThan(5);
    await rig.send({ type: 'shiftUp' });
    let from = rig.mark();
    rig.run(0.2);
    expect(rig.states(from)[0]?.[S.gear]).toBe(2);
    expect(rig.states(from).some((s) => ((s[S.flags] ?? 0) & F.SHIFTING) !== 0)).toBe(true);
    // In Auto the same paddle shift would start the 8 s MANUAL_OVERRIDE (spec §7.1); Manual never sets it
    for (const s of rig.states(from)) expect((s[S.flags] ?? 0) & F.MANUAL_OVERRIDE).toBe(0);
    await rig.send({ type: 'shiftDown' });
    from = rig.mark();
    rig.run(0.2);
    expect(rig.states(from)[0]?.[S.gear]).toBe(1);
    for (const s of rig.states(from)) expect((s[S.flags] ?? 0) & F.MANUAL_OVERRIDE).toBe(0);
  });

  it('copies SimCore.out into the DspControl each quantum; valve, perspective, driveMode and warm reach it', SLOW, async () => {
    const seen = captureControl();
    const simOut = captureSimOut();
    const rig = new Rig();
    await rig.send(...config({ source: 'demo', warm: false }), { type: 'ignition', on: true });
    rig.run(1);
    const first = seen[seen.length - 1];
    expect(first).toMatchObject({ valve: 'auto', perspective: 'cabin', driveMode: 'comfort', warm: false, ignitionOn: true });
    await rig.send(
      { type: 'valve', mode: 'open' },
      { type: 'perspective', value: 'outside' },
      { type: 'driveMode', value: 'sport' },
      { type: 'warm', warm: true },
    );
    rig.quanta(12 * 500); // 16 s more: pull-away and the WOT pull, so gear, load and shifts move
    const c = seen[seen.length - 1];
    expect(c).toMatchObject({ valve: 'open', perspective: 'outside', driveMode: 'sport', warm: true, ignitionOn: true });
    expect(seen.length).toBe(rig.q); // one render per quantum at bench k = 1
    // the snapshot of each 12th quantum is posted after that quantum's render: same sim state
    const st = rig.states();
    for (let k = 0; k < st.length; k++) {
      const s = st[k];
      const ctl = seen[12 * (k + 1) - 1];
      if (s === undefined || ctl === undefined) throw new Error('missing snapshot or control');
      expect(ctl.rpm).toBe(s[S.rpm]);
      expect(ctl.gear).toBe(s[S.gear]);
      expect(ctl.load).toBe(s[S.load]);
      expect(ctl.limiter).toBe(((s[S.flags] ?? 0) & F.LIMITER) !== 0);
      expect(ctl.shift.active).toBe(((s[S.flags] ?? 0) & F.SHIFTING) !== 0);
      expect(ctl.driveline === 'clutch-open').toBe(((s[S.flags] ?? 0) & F.CLUTCH_OPEN) !== 0);
      expect(ctl.runTimeS).toBeCloseTo(s[S.time] ?? 0, 9); // ignition went on at t = 0
    }
    expect(Math.max(...seen.map((x) => x.gear))).toBeGreaterThanOrEqual(3);
    expect(seen.some((x) => x.shift.active && x.shift.durationS > 0 && x.shift.toRpm !== x.shift.fromRpm)).toBe(true);
    // Every quantum, field for field: the control DspCore renders with is SimCore.out after that quantum's step —
    // the whole shift trajectory included (DspCore's RpmState follows it from t0 for durationS).
    expect(simOut.length).toBe(rig.q);
    expect(seen.map(copiedFields)).toEqual(simOut.map(copiedFields));
    const shifting = seen.filter((x) => x.shift.active);
    expect(shifting.some((x) => x.shift.up)).toBe(true);
    for (const x of shifting) expect(x.shift.t0).toBeGreaterThan(1); // real shift start times, after the crank
  });

  it('fixes and visibility reach SimCore; fixes are stamped with currentTime', SLOW, async () => {
    const pushFix = vi.spyOn(TesboxSimCore.prototype, 'pushFix');
    const rig = new Rig();
    await rig.send(...config({ source: 'gps' }), { type: 'ignition', on: true });
    rig.run(3);
    const fix = (k: number, accuracyM = 5): MainToWorklet => ({
      type: 'fix',
      ageS: 1,
      speedMps: 10,
      lat: LAT0 + (10 * k) / 111_195,
      lon: LON0,
      accuracyM,
      altitudeM: null,
    });
    const sentAt: number[] = [];
    for (let k = 0; k < 3; k++) {
      sentAt.push(rig.t);
      await rig.send(fix(k));
      rig.run(1);
    }
    sentAt.push(rig.t);
    await rig.send(fix(3, 0)); // accuracy 0: rejected by the speed filter, not a protocol error
    rig.run(0.1);
    expect(pushFix.mock.calls.map((c) => c[1])).toEqual(sentAt); // the worklet's currentTime at receipt
    expect(pushFix.mock.calls.map((c) => c[0])).toEqual([fix(0), fix(1), fix(2), fix(3, 0)]);
    let s = rig.last();
    expect(s[S.fixesAccepted]).toBe(3);
    expect(s[S.fixesRejected]).toBe(1);
    expect(s[S.speedMps]).toBeGreaterThan(5);
    await rig.send({ type: 'visibility', hidden: true });
    rig.run(0.1);
    s = rig.last();
    expect((s[S.flags] ?? 0) & F.HIDDEN_HOLD).toBe(F.HIDDEN_HOLD);
    expect(rig.errors()).toEqual([]);
  });

  it('tuning goes to SimCore.setTuning, warm to SimCore.setWarm; value-equal tesla / engine re-posts do not reconfigure', async () => {
    const simConfigure = vi.spyOn(TesboxSimCore.prototype, 'configure');
    const setTuning = vi.spyOn(TesboxSimCore.prototype, 'setTuning');
    const setWarm = vi.spyOn(TesboxSimCore.prototype, 'setWarm');
    const dspConfigure = vi.spyOn(TesboxDspCore.prototype, 'configure');
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    rig.run(0.5);
    expect(simConfigure).toHaveBeenCalledTimes(1);
    expect(setWarm).toHaveBeenLastCalledWith(true);
    const dspCalls = dspConfigure.mock.calls.length;
    await rig.send(
      { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 } },
      { type: 'tesla', params: { ...TESLA } },
      { type: 'engine', def: ENGINE },
    );
    expect(setTuning).toHaveBeenCalledWith({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 });
    expect(simConfigure).toHaveBeenCalledTimes(1);
    expect(dspConfigure.mock.calls.length).toBe(dspCalls);
    await rig.send({ type: 'tesla', params: { ...TESLA, modeFactor: 0.7 } });
    expect(simConfigure).toHaveBeenCalledTimes(2);
    expect(simConfigure.mock.calls[1]?.[2]).toEqual({ ...TESLA, modeFactor: 0.7 });
    expect(simConfigure.mock.calls[1]?.[3]).toEqual({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 });
    expect(rig.errors()).toEqual([]);
  });

  it('a different engine once configured (Garage switch) reconfigures SimCore and both DspCores: 1st gear, the new idle, the new def kept', SLOW, async () => {
    const simConfigure = vi.spyOn(TesboxSimCore.prototype, 'configure');
    const dspConfigure = vi.spyOn(TesboxDspCore.prototype, 'configure');
    const tuning = { ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 };
    const rig = new Rig();
    await rig.send(
      ...config({ source: 'demo' }),
      { type: 'tuning', value: tuning },
      { type: 'gearboxMode', value: 'manual' },
      { type: 'ignition', on: true },
    );
    rig.run(5); // the demo pull-away, held in 1st by Manual
    await rig.send({ type: 'shiftUp' });
    rig.run(0.4);
    expect(rig.last()[S.gear]).toBe(2);
    expect(rig.last()[S.speedMps]).toBeGreaterThan(4);
    simConfigure.mockClear();
    dspConfigure.mockClear();

    const from = rig.mark();
    await rig.send({ type: 'engine', def: V8 });
    // SimCore: exactly once, with the new spec and voicing, the current Tesla params and the current tuning
    expect(simConfigure).toHaveBeenCalledTimes(1);
    const [spec, voicing, params, simTuning] = simConfigure.mock.calls[0] ?? [];
    expect(spec).toEqual(V8.spec);
    expect(voicing).toEqual(V8.voicing);
    expect(params).toEqual(TESLA);
    expect(simTuning).toEqual(tuning);
    // DspCore: the main and the bench core, both with the one new def object (the one SimCore got), current output and tier
    expect(dspConfigure).toHaveBeenCalledTimes(2);
    expect(dspConfigure.mock.contexts[0]).not.toBe(dspConfigure.mock.contexts[1]);
    const def = dspConfigure.mock.calls[0]?.[0];
    expect(def).toEqual(V8);
    expect(def?.spec).toBe(spec);
    expect(def?.voicing).toBe(voicing);
    for (const call of dspConfigure.mock.calls) {
      expect(call[0]).toBe(def);
      expect(call[1]).toEqual(OUT_SUB);
      expect(call[2]).toBe('full');
    }

    // Observable: the gearbox restarts in 1st while still rolling (Manual keeps it there — no anti-lug in 1st) …
    rig.run(0.3);
    const rolling = rig.states(from);
    expect(rolling.length).toBeGreaterThan(5);
    for (const s of rolling) {
      expect(s[S.gear]).toBe(1);
      expect(s[S.speedMps]).toBeGreaterThan(4);
    }
    // … and at a standstill (GPS source, no fixes) the idle is the V8's 700 rpm, not the i5's 850 (wander ±20)
    const stop = rig.mark();
    await rig.send({ type: 'source', value: 'gps' });
    const idleAudio = rig.run(1.2);
    const idle = rig.states(stop).filter((s) => (s[S.time] ?? 0) >= rig.t - 0.6);
    expect(idle.length).toBeGreaterThan(10);
    for (const s of idle) {
      expect(Math.abs((s[S.rpm] ?? 0) - V8.spec.rpm.idle)).toBeLessThan(50);
      expect(s[S.gear]).toBe(1);
      expect((s[S.flags] ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    }
    expect(rms(seg(idleAudio.left, 0.6, 1.2))).toBeGreaterThan(1e-3); // the swapped-in engine is audible

    // A later trim change still takes DspCore's trim-only path: the very same (new) def object, nothing else changed
    dspConfigure.mockClear();
    await rig.send({ type: 'volume', trimDb: -6 });
    expect(dspConfigure).toHaveBeenCalledTimes(2);
    for (const call of dspConfigure.mock.calls) {
      expect(call[0]).toBe(def);
      expect(call[1]).toEqual({ ...OUT_SUB, volumeTrimDb: -6 });
      expect(call[2]).toBe('full');
    }
    expect(simConfigure).toHaveBeenCalledTimes(1);
    expect(rig.errors()).toEqual([]);
  });

  it('every InputMsg is forwarded to SimCore.pushInput with currentTime (SimCore ignores the DSP-only ones)', async () => {
    const pushInput = vi.spyOn(TesboxSimCore.prototype, 'pushInput');
    const rig = new Rig();
    await rig.send(...config({ source: 'keyboard' }));
    rig.run(0.1);
    const inputs: MainToWorklet[] = [
      { type: 'ignition', on: true },
      { type: 'pedal', throttle: 0.3, brake: 0 },
      { type: 'shiftUp' },
      { type: 'shiftDown' },
      { type: 'valve', mode: 'open' },
      { type: 'perspective', value: 'outside' },
      { type: 'gearboxMode', value: 'manual' },
      { type: 'driveMode', value: 'sport' },
      { type: 'volume', trimDb: -3 },
      { type: 'visibility', hidden: false },
      { type: 'bench', k: 2 },
      { type: 'testTone', hz: 50, levelDb: -18 },
      { type: 'testTone', hz: null, levelDb: -18 },
    ];
    for (const m of inputs) {
      const t = rig.t;
      await rig.send(m);
      expect(pushInput).toHaveBeenLastCalledWith(m, t);
      rig.quanta(3);
    }
    expect(pushInput).toHaveBeenCalledTimes(inputs.length);
    expect(rig.errors()).toEqual([]);
  });

  it('tier and output go to DspCore.configure for the main and the bench core; S.tier follows', async () => {
    const dspConfigure = vi.spyOn(TesboxDspCore.prototype, 'configure');
    const rig = new Rig();
    await rig.send(...config({ source: 'gps' }));
    dspConfigure.mockClear();
    await rig.send({ type: 'tier', value: 'lite' });
    expect(dspConfigure).toHaveBeenCalledTimes(2);
    for (const call of dspConfigure.mock.calls) expect(call[2]).toBe('lite');
    rig.quanta(12);
    expect(rig.last()[S.tier]).toBe(1);
    dspConfigure.mockClear();
    await rig.send({ type: 'output', config: { subwoofer: 'no', hpCornerHz: 50, volumeTrimDb: -3 } });
    expect(dspConfigure).toHaveBeenCalledTimes(2);
    for (const call of dspConfigure.mock.calls) expect(call[1]).toEqual({ subwoofer: 'no', hpCornerHz: 50, volumeTrimDb: -3 });
  });
});

describe("worklet 'tesbox' — volume trim", () => {
  it('volume is a trim-only DspCore change (same def, same tier, no fade) that lowers the level', SLOW, async () => {
    const dspConfigure = vi.spyOn(TesboxDspCore.prototype, 'configure');
    const a = new Rig();
    const b = new Rig();
    await a.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    const before = dspConfigure.mock.calls[dspConfigure.mock.calls.length - 1]; // rig a's (its def is its own clone)
    await b.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    a.run(3);
    b.run(3);
    dspConfigure.mockClear();
    await a.send({ type: 'volume', trimDb: -12 });
    expect(dspConfigure).toHaveBeenCalledTimes(2);
    for (const call of dspConfigure.mock.calls) {
      expect(call[0]).toBe(before?.[0]); // the very same EngineDef object → DspCore's trim-only path
      expect(call[1]).toEqual({ ...OUT_SUB, volumeTrimDb: -12 });
      expect(call[2]).toBe('full');
    }
    const ta = a.run(1).left;
    const tb = b.run(1).left;
    const ratioDb = (from: number, to: number): number => 20 * Math.log10(rms(seg(ta, from, to)) / rms(seg(tb, from, to)));
    expect(ratioDb(0.2, 1)).toBeLessThan(-10);
    expect(ratioDb(0.2, 1)).toBeGreaterThan(-13);
    // Trim-only, no 300 ms fade: window by window against the control rig the level steps down within the
    // first 20 ms (a one-quantum ramp behind the 1.5 ms look-ahead) and then holds — a fade would dip toward −∞.
    for (let t = 0; t < 0.4; t += 0.02) {
      expect(ratioDb(t, t + 0.02)).toBeGreaterThan(-13);
      expect(ratioDb(t, t + 0.02)).toBeLessThan(t < 0.02 ? 0 : -10.5);
    }
  });

  it('a volume message before configuration is applied by the first configure', SLOW, async () => {
    const a = new Rig();
    const b = new Rig();
    await a.send({ type: 'volume', trimDb: -12 }, { type: 'engine', def: ENGINE }, { type: 'tesla', params: TESLA });
    await b.send(
      { type: 'output', config: { subwoofer: 'unsure', hpCornerHz: 40, volumeTrimDb: -12 } },
      { type: 'engine', def: ENGINE },
      { type: 'tesla', params: TESLA },
    );
    for (const rig of [a, b]) await rig.send({ type: 'ignition', on: true });
    expect(sameBits(a.run(3).left, b.run(3).left)).toBe(true);
  });
});

describe("worklet 'tesbox' — test tone", () => {
  it('plays without an engine: 50 ms raised-cosine fade-in to a steady sine at dbToGain(levelDb), identical on both channels', async () => {
    const rig = new Rig();
    expect(allZero(rig.run(0.1))).toBe(true);
    await rig.send({ type: 'testTone', hz: 1000, levelDb: -18 });
    const on = rig.run(0.3);
    expect(sameBits(on.left, on.right)).toBe(true);
    expect(sane(on.left)).toBe(true);
    const a = dbToGain(-18);
    const n0 = firstNonZero(on.left);
    expect(n0).toBeGreaterThanOrEqual(LOOKAHEAD - 2);
    expect(n0).toBeLessThanOrEqual(LOOKAHEAD + 2);
    const fadeN = 0.05 * SR;
    for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const want = a * (0.5 - 0.5 * Math.cos(Math.PI * u));
      expect(Math.abs(envelopeAt(on.left, n0 + Math.round(u * fadeN), 48) - want)).toBeLessThan(0.05 * a);
    }
    const steady = seg(on.left, 0.1, 0.3);
    const fit = sineFit(steady, 1000);
    expect(fit.amp).toBeGreaterThan(a * 0.97);
    expect(fit.amp).toBeLessThan(a * 1.03);
    expect(fit.residual).toBeLessThan(0.01);
    expect(maxStep(on.left)).toBeLessThan(((2 * Math.PI * 1000) / SR) * a * 1.05);
  });

  it('hz: null fades out over 50 ms; then exact silence', async () => {
    const rig = new Rig();
    await rig.send({ type: 'testTone', hz: 1000, levelDb: -18 });
    rig.run(0.2);
    await rig.send({ type: 'testTone', hz: null });
    const off = rig.run(0.5);
    const a = dbToGain(-18);
    expect(envelopeAt(off.left, LOOKAHEAD + 0.025 * SR, 48)).toBeGreaterThan(0.4 * a);
    expect(envelopeAt(off.left, LOOKAHEAD + 0.025 * SR, 48)).toBeLessThan(0.6 * a);
    expect(peak(seg(off.left, 0.06, 0.5))).toBeLessThan(0.01 * a);
    expect(seg(off.left, 0.3, 0.5).every((v) => v === 0)).toBe(true);
    expect(maxStep(off.left)).toBeLessThan(((2 * Math.PI * 1000) / SR) * a * 1.05);
  });

  it('a new hz while playing changes frequency phase-continuously (no click, no gap)', async () => {
    const rig = new Rig();
    await rig.send({ type: 'testTone', hz: 1000, levelDb: -18 });
    const x1 = rig.run(0.2).left;
    await rig.send({ type: 'testTone', hz: 1200, levelDb: -18 });
    const x2 = rig.run(0.2).left;
    const a = dbToGain(-18);
    const joined = new Float32Array(x1.length + x2.length);
    joined.set(x1);
    joined.set(x2, x1.length);
    expect(maxStep(seg(joined, 0.1, 0.4))).toBeLessThan(((2 * Math.PI * 1200) / SR) * a * 1.05);
    const fit = sineFit(seg(x2, 0.05, 0.2), 1200);
    expect(fit.amp).toBeGreaterThan(a * 0.97);
    expect(fit.residual).toBeLessThan(0.01);
  });

  it('bypasses bass management and the user trim (subwoofer no, 60 Hz corner, −24 dB trim); levelDb > 0 is clamped', SLOW, async () => {
    const rig = new Rig();
    await rig.send(...config({ output: { subwoofer: 'no', hpCornerHz: 60, volumeTrimDb: -24 } }));
    await rig.send({ type: 'testTone', hz: 30, levelDb: -18 });
    const low = rig.run(1).left;
    // 2nd-order 22 Hz infrasonic HP (0.881 at 30 Hz) × 5 Hz DC blocker (0.986); a 60 Hz 4th-order HP would give ≈ −24 dB
    const fit = sineFit(seg(low, 0.2, 1), 30);
    expect(fit.amp).toBeGreaterThan(dbToGain(-18) * 0.8);
    expect(fit.amp).toBeLessThan(dbToGain(-18) * 0.95);
    // +12 dB is clamped to a 0 dBFS sine, which the stage compresses (−12 dBFS, 3:1) to ≈ −8 dBFS;
    // an unclamped +12 dB sine would come out near 0.63.
    await rig.send({ type: 'testTone', hz: 1000, levelDb: 12 });
    const hot = rig.run(0.5).left;
    expect(sane(hot)).toBe(true);
    expect(peak(seg(hot, 0.2, 0.5))).toBeGreaterThan(0.3);
    expect(peak(seg(hot, 0.2, 0.5))).toBeLessThan(0.5);
  });

  it('replaces a running engine while active (pure sine) and hands back to the engine, which kept running underneath', SLOW, async () => {
    const a = new Rig();
    const b = new Rig();
    for (const rig of [a, b]) await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    a.run(3);
    b.run(3);
    await a.send({ type: 'testTone', hz: 40, levelDb: -18 });
    const ta = a.run(1).left;
    const tb = b.run(1).left;
    expect(rms(seg(tb, 0, 1))).toBeGreaterThan(1e-3); // the control engine is audible
    const fit = sineFit(seg(ta, 0.1, 1), 40); // 36 whole periods
    expect(fit.residual).toBeLessThan(0.01);
    expect(fit.amp).toBeGreaterThan(dbToGain(-18) * 0.9);
    // the 50 ms crossfade adds no click: no step beyond the engine's own steps plus the sine's slope
    const sineStep = ((2 * Math.PI * 40) / SR) * dbToGain(-18);
    expect(maxStep(ta)).toBeLessThan((maxStep(seg(tb, 0, 0.06)) + sineStep) * 1.1);
    await a.send({ type: 'testTone', hz: null });
    const ra = a.run(1).left;
    const rb = b.run(1).left;
    expect(sane(ra)).toBe(true);
    expect(sameBits(seg(ra, 0.4, 1), seg(rb, 0.4, 1))).toBe(true);
  });
});

describe("worklet 'tesbox' — headroom benchmark and busy time", () => {
  it('bench k renders the DSP k times per quantum (k−1 extra into a scratch core); k is rounded and clamped to 1…16', async () => {
    const render = vi.spyOn(TesboxDspCore.prototype, 'render');
    const rig = new Rig();
    await rig.send(...config({ source: 'gps' }), { type: 'ignition', on: true });
    const cases: [number, number][] = [
      [4, 4],
      [100, 16],
      [0, 1],
      [2.6, 3],
      [-5, 1],
      [1, 1],
    ];
    for (const [k, want] of cases) {
      await rig.send({ type: 'bench', k });
      render.mockClear();
      rig.quanta(12);
      expect(render).toHaveBeenCalledTimes(12 * want);
      expect(rig.last()[S.benchK]).toBe(want);
    }
  });

  it('the audible output is bit-identical with and without a running benchmark', SLOW, async () => {
    const a = new Rig();
    const b = new Rig();
    for (const rig of [a, b]) await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    await a.send({ type: 'bench', k: 8 });
    const xa = a.run(2);
    const xb = b.run(2);
    expect(sameBits(xa.left, xb.left) && sameBits(xa.right, xb.right)).toBe(true);
    expect(rms(xa.left)).toBeGreaterThan(1e-3);
  });

  it('busyFrac = busy ms / audio ms over ~1 s windows; OVERLOAD after 2 windows above 0.8, cleared by a calm window', async () => {
    const rig = new Rig();
    let step = 2.5; // ms per clock read; process() reads the clock twice → 2.5 ms busy per 2.667 ms quantum
    fakeClock(() => step);
    rig.quanta(384); // first window closes at quantum 375; snapshot at 384
    let s = rig.last();
    expect(s[S.busyFrac]).toBeCloseTo((375 * 2.5) / 1000, 9);
    expect((s[S.flags] ?? 0) & F.OVERLOAD).toBe(0);
    rig.quanta(372); // second window closes at 750; snapshot at 756
    s = rig.last();
    expect(s[S.busyFrac]).toBeCloseTo(0.9375, 9);
    expect((s[S.flags] ?? 0) & F.OVERLOAD).toBe(F.OVERLOAD);
    step = 0.5;
    rig.quanta(372); // third window = quanta 751…1125: 751–756 still at 2.5 ms, 757–1125 at 0.5 ms; snapshot at 1128
    s = rig.last();
    expect(s[S.busyFrac]).toBeCloseTo((6 * 2.5 + 369 * 0.5) / 1000, 9);
    expect((s[S.flags] ?? 0) & F.OVERLOAD).toBe(0);
  });
});

describe("worklet 'tesbox' — robustness", () => {
  const BAD_ENGINES: unknown[] = [
    { ...ENGINE, voicing: { ...ENGINE.voicing, headersM: [] } },
    { ...ENGINE, spec: { ...ENGINE.spec, gearbox: { ...ENGINE.spec.gearbox, drivenTyre: 'R19' } } },
    { ...ENGINE, spec: { ...ENGINE.spec, gearbox: { ...ENGINE.spec.gearbox, overallRatios: [3, 5] } } },
    { ...ENGINE, spec: { ...ENGINE.spec, rpm: { ...ENGINE.spec.rpm, idle: Number.NaN } } },
    { ...ENGINE, spec: { ...ENGINE.spec, cycleDeg: 0 } },
    { ...ENGINE, voicing: { ...ENGINE.voicing, launchRpm: 'high' } },
  ];
  const MALFORMED: unknown[] = [
    null,
    42,
    'engine',
    [],
    {},
    { type: 7 },
    { type: 'warp-drive' },
    { type: 'engine' },
    { type: 'engine', def: null },
    ...BAD_ENGINES.map((def) => ({ type: 'engine', def })),
    { type: 'tesla', params: 'fast' },
    { type: 'tesla', params: { ...TESLA, massKg: -1 } },
    { type: 'tesla', params: { ...TESLA, roadLoad: null } },
    { type: 'output', config: { ...OUT_SUB, subwoofer: 'maybe' } },
    { type: 'output', config: { ...OUT_SUB, hpCornerHz: Number.NaN } },
    { type: 'source', value: 'telepathy' },
    { type: 'tier', value: 'ultra' },
    { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, kalmanQ: -1 } },
    { type: 'warm', warm: 'yes' },
    { type: 'pedal', throttle: '1', brake: 0 },
    { type: 'pedal', throttle: Number.NaN, brake: 0 },
    { type: 'valve', mode: 'half' },
    { type: 'perspective', value: 'roof' },
    { type: 'gearboxMode', value: 'cvt' },
    { type: 'driveMode', value: 'eco' },
    { type: 'volume', trimDb: 'loud' },
    { type: 'volume', trimDb: Number.POSITIVE_INFINITY },
    { type: 'visibility', hidden: 1 },
    { type: 'ignition', on: 'on' },
    { type: 'bench', k: 'max' },
    { type: 'bench', k: Number.NaN },
    { type: 'testTone', hz: -40, levelDb: -18 },
    { type: 'testTone', hz: '40', levelDb: -18 },
    { type: 'testTone', hz: 40 },
    { type: 'fix', ageS: 'late', speedMps: null, lat: LAT0, lon: LON0, accuracyM: 5, altitudeM: null },
    { type: 'fix', ageS: 1, speedMps: 'fast', lat: LAT0, lon: LON0, accuracyM: 5, altitudeM: null },
    { type: 'fix', ageS: 1, speedMps: null, lat: String(LAT0), lon: LON0, accuracyM: 5, altitudeM: null },
  ];

  it('every malformed message posts exactly one error and changes nothing: the running engine stays bit-identical', SLOW, async () => {
    const a = new Rig();
    const b = new Rig();
    for (const rig of [a, b]) await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    a.run(3);
    b.run(3);
    const from = a.mark();
    await a.send(...MALFORMED);
    const errors = a.errors(from);
    expect(errors.length).toBe(MALFORMED.length);
    for (const e of errors) expect(e.length).toBeGreaterThan(0);
    // coordinates never leave in an error message
    for (const e of errors) expect(e.includes('4321') || e.includes('8765')).toBe(false);
    const xa = a.run(3);
    const xb = b.run(3);
    expect(sameBits(xa.left, xb.left) && sameBits(xa.right, xb.right)).toBe(true);
    expect(rms(xa.left)).toBeGreaterThan(1e-3);
    expect(a.posted.filter((m) => m.type === 'ready').length).toBe(1);
  });

  it('a malformed engine before configuration leaves the worklet unconfigured; a valid one afterwards works', async () => {
    const rig = new Rig();
    await rig.send({ type: 'tesla', params: TESLA }, { type: 'engine', def: BAD_ENGINES[1] }, { type: 'ignition', on: true });
    expect(rig.errors().length).toBe(1);
    expect(allZero(rig.run(1))).toBe(true);
    await rig.send({ type: 'engine', def: ENGINE });
    expect(rms(seg(rig.run(2.5).left, 1, 2.5))).toBeGreaterThan(1e-3);
  });

  it('testTone { hz: null } without levelDb is accepted', async () => {
    const rig = new Rig();
    await rig.send({ type: 'testTone', hz: null });
    expect(rig.errors()).toEqual([]);
  });

  it('process() never throws and returns true: a throwing core yields silence and one error per ~1 s window', async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    rig.run(1);
    const from = rig.mark();
    const spy = vi.spyOn(TesboxDspCore.prototype, 'render').mockImplementation(() => {
      throw new Error('boom');
    });
    const broken = rig.quanta(300);
    expect(allZero(broken)).toBe(true);
    expect(rig.errors(from)).toEqual(['process: boom']);
    expect(rig.states(from).length).toBe(25); // snapshots keep flowing through the fault (300 / 12)
    spy.mockRestore();
    expect(rms(rig.run(1).left)).toBeGreaterThan(1e-3);
  });

  it('a final NaN-safe clip guards the output even if a core misbehaves', async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    const junk = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2, -2, 0.5];
    vi.spyOn(TesboxDspCore.prototype, 'render').mockImplementation((_ctl, l, r, frames) => {
      for (let i = 0; i < frames; i++) {
        l[i] = junk[i % junk.length] ?? 0;
        r[i] = junk[(i + 1) % junk.length] ?? 0;
      }
    });
    const x = rig.quanta(3);
    expect(sane(x.left) && sane(x.right)).toBe(true);
    expect(Array.from(x.left.subarray(0, 6))).toEqual([0, CEILING_F32, -CEILING_F32, CEILING_F32, -CEILING_F32, 0.5]);
    expect(x.right[0]).toBe(CEILING_F32);
  });

  it("S.nonFiniteResets reports the audible core's non-finite resets (spec §10.2 diagnostics)", async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    rig.run(1);
    expect(rig.last()[S.nonFiniteResets]).toBe(0);
    // One non-finite energy reading trips the main core's once-per-quantum guard (full reset + 50 ms fade-in). At
    // bench k = 1 the bench core never renders, so its own count stays 0: a 1 can only be the main core's.
    const energy = vi.spyOn(ExhaustNetwork.prototype, 'energy').mockReturnValueOnce(Number.NaN);
    const from = rig.mark();
    const q0 = rig.q;
    const x = rig.run(1);
    expect(energy).toHaveBeenCalledTimes(rig.q - q0); // one guard check per quantum, main core only
    const st = rig.states(from);
    expect(st.length).toBe(31);
    for (const s of st) expect(s[S.nonFiniteResets]).toBe(1);
    expect(sane(x.left) && sane(x.right)).toBe(true);
    expect(rms(seg(x.left, 0.5, 1))).toBeGreaterThan(1e-3); // recovered
    expect(rig.errors()).toEqual([]);
  });

  it('process() constructs no typed arrays or buffers per quantum (engine, bench and tone running)', SLOW, async () => {
    const rig = new Rig();
    await rig.send(
      ...config({ source: 'demo' }),
      { type: 'ignition', on: true },
      { type: 'bench', k: 2 },
      { type: 'testTone', hz: 50, levelDb: -18 },
    );
    rig.run(1); // warm-up, tone fully on
    const outputs = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];
    const inputs: Float32Array[][] = [];
    const params: Record<string, Float32Array> = {};
    let constructed = 0;
    const uninstall = countBufferConstructions(() => {
      constructed++;
    });
    try {
      for (let i = 0; i < 1200; i++) {
        audioTime = rig.t;
        rig.proc.process(inputs, outputs, params);
        rig.q++;
      }
    } finally {
      uninstall();
    }
    expect(constructed).toBe(0); // the snapshot copy is a .slice() of an existing array, not a constructor call
    expect(rig.states().length).toBe(Math.floor(rig.q / 12));
  });

  it('survives missing or mono output buses and keeps the simulation running', async () => {
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    audioTime = 0;
    expect(rig.proc.process([], [], {})).toBe(true);
    expect(rig.proc.process([], [[]], {})).toBe(true);
    const mono = new Float32Array(QUANTUM).fill(Number.NaN);
    for (let i = 0; i < 400; i++) {
      audioTime = (i * QUANTUM) / SR;
      expect(rig.proc.process([], [[mono]], {})).toBe(true);
    }
    expect(sane(mono)).toBe(true);
    expect(peak(mono)).toBeGreaterThan(0);
    expect(rig.states().length).toBe(Math.floor(402 / 12));
  });

  it('an unsupported sample rate posts an error instead of ready; the engine stays silent but the test tone works', async () => {
    const rig = new Rig(96000);
    expect(rig.posted.length).toBe(1);
    expect(rig.posted[0]?.type).toBe('error');
    expect(rig.errors()[0]).toContain('96000');
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    expect(rig.errors().length).toBeGreaterThan(1); // the engine message is refused
    expect(allZero(rig.run(1))).toBe(true);
    expect(rig.states().length).toBeGreaterThan(0);
    await rig.send({ type: 'testTone', hz: 1000, levelDb: -18 });
    expect(peak(rig.run(0.2).left)).toBeGreaterThan(0.1);
  });

  it('runs at 44.1 kHz: audible engine, a snapshot every 12 quanta', SLOW, async () => {
    const rig = new Rig(44100);
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    const x = rig.quanta(12 * 100);
    expect(sane(x.left)).toBe(true);
    expect(rms(seg(x.left, 1, 3, 44100))).toBeGreaterThan(1e-3);
    const st = rig.states();
    expect(st.length).toBe(100);
    expect(st[99]?.[S.time]).toBeCloseTo((1199 * QUANTUM) / 44100, 12);
  });

  it('fuzz: random valid and invalid messages between quanta never produce a non-finite or over-ceiling sample', SLOW, async () => {
    const rng = new Rng(7);
    const engines = [ENGINE, getEngine('v8-na-50'), getEngine('rotary-twin-13')];
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)] as T;
    const wild = (): number => pick([0, 1, -1, 0.5, 1e9, -1e9, Number.NaN, Number.POSITIVE_INFINITY, rng.bipolar() * 100]);
    const makers: (() => unknown)[] = [
      () => ({ type: 'ignition', on: rng.next() < 0.8 }),
      () => ({ type: 'pedal', throttle: wild(), brake: wild() }),
      () => ({ type: 'pedal', throttle: rng.next(), brake: 0 }),
      () => ({ type: 'shiftUp' }),
      () => ({ type: 'shiftDown' }),
      () => ({ type: 'source', value: pick(['gps', 'demo', 'keyboard', 'replay']) }),
      () => ({ type: 'gearboxMode', value: pick(['auto', 'manual']) }),
      () => ({ type: 'driveMode', value: pick(['comfort', 'sport']) }),
      () => ({ type: 'valve', mode: pick(['auto', 'open', 'closed']) }),
      () => ({ type: 'perspective', value: pick(['cabin', 'outside']) }),
      () => ({ type: 'volume', trimDb: wild() }),
      () => ({ type: 'visibility', hidden: rng.next() < 0.3 }),
      () => ({ type: 'bench', k: pick([1, 2, wild()]) }),
      () => ({ type: 'testTone', hz: pick([null, 30, 60, 1000, wild()]), levelDb: wild() }),
      () => ({ type: 'tier', value: pick(['full', 'lite']) }),
      () => ({ type: 'output', config: { subwoofer: pick(['yes', 'no', 'unsure']), hpCornerHz: wild(), volumeTrimDb: wild() } }),
      () => ({ type: 'engine', def: pick(engines) }),
      () => ({ type: 'warm', warm: rng.next() < 0.5 }),
      () => ({ type: 'tuning', value: { ...DEFAULT_SIM_TUNING, kalmanQ: Math.abs(wild()), tauA: Math.abs(wild()) } }),
      () => ({ type: 'fix', ageS: wild(), speedMps: pick([null, wild()]), lat: LAT0 + rng.next() * 1e-3, lon: LON0, accuracyM: wild(), altitudeM: null }),
      () => pick(MALFORMED),
    ];
    const rig = new Rig();
    await rig.send(...config({ source: 'demo' }), { type: 'ignition', on: true });
    for (let burst = 0; burst < 300; burst++) {
      const msgs: unknown[] = [];
      const n = Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) msgs.push(pick(makers)());
      await rig.send(...msgs);
      const x = rig.quanta(10);
      if (!sane(x.left) || !sane(x.right)) throw new Error(`insane output after burst ${burst}`);
    }
    for (const s of rig.states()) {
      for (let i = 0; i < STATE_LEN; i++) if (i !== S.busyFrac) expect(Number.isFinite(s[i])).toBe(true);
    }
  });
});
