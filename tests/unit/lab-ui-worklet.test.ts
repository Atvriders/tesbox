/**
 * The 'tesbox-lab' AudioWorkletProcessor (src/lab/ui/lab-worklet.ts, phase-2c contract L1/L2) run in Node
 * through an AudioWorkletGlobalScope shim: `port` is one end of a real MessageChannel (main → worklet messages
 * are structured-cloned and delivered asynchronously, as in the browser), worklet → main posts are captured as
 * structured clones, and `sampleRate` / `currentTime` are driven by the test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QUANTUM, type EngineDef } from '../../src/contracts';
import { getEngine } from '../../src/data/engines';
import { OUTPUT_CEILING } from '../../src/dsp/output-stage';
import type { LabToMain, MainToLab, ManualMsg, MeterMsg } from '../../src/lab/ui/protocol';
import { countBufferConstructions } from './helpers/dsp-harness';

const SR = 48000;
const I5: EngineDef = getEngine('i5-turbo-25');
const SLOW = { timeout: 60_000 };

const MANUAL: ManualMsg = {
  type: 'manual',
  rpm: 3000,
  load: 0.5,
  gear: 1,
  valve: 'auto',
  perspective: 'cabin',
  driveMode: 'comfort',
  warm: true,
};

// ───────────────────────────── AudioWorkletGlobalScope shim ─────────────────────────────

interface Proc {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
type ProcCtor = new (options: AudioWorkletNodeOptions) => Proc;

let audioTime = 0;
let rate = SR;
let lastCreated: { node: MessagePort; posted: LabToMain[] } | null = null;
const registered: { name: string; ctor: ProcCtor | null } = { name: '', ctor: null };
const openPorts: MessagePort[] = [];

class ShimAudioWorkletProcessor {
  readonly port: MessagePort;
  constructor() {
    const ch = new MessageChannel();
    const posted: LabToMain[] = [];
    Object.defineProperty(ch.port1, 'postMessage', {
      value: (msg: unknown) => posted.push(structuredClone(msg) as LabToMain),
    });
    this.port = ch.port1;
    lastCreated = { node: ch.port2, posted };
    openPorts.push(ch.port1, ch.port2);
  }
}

beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', ShimAudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (name: string, ctor: ProcCtor) => {
    registered.name = name;
    registered.ctor = ctor;
  });
  Object.defineProperty(globalThis, 'sampleRate', { get: () => rate, configurable: true });
  Object.defineProperty(globalThis, 'currentTime', { get: () => audioTime, configurable: true });
  await import('../../src/lab/ui/lab-worklet');
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'sampleRate');
  Reflect.deleteProperty(globalThis, 'currentTime');
});

afterEach(() => {
  for (const p of openPorts.splice(0)) p.close();
  rate = SR;
});

class Rig {
  readonly proc: Proc;
  readonly node: MessagePort;
  readonly posted: LabToMain[];
  readonly fs: number;
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
    if (lastCreated === null) throw new Error('the processor did not construct its base class');
    this.node = lastCreated.node;
    this.posted = lastCreated.posted;
    this.fs = fs;
    // Registered after the processor's own onmessage: runs once the processor handled a message.
    this.proc.port.addEventListener('message', () => {
      this.delivered++;
      this.wake?.();
    });
  }

  get t(): number {
    return (this.q * QUANTUM) / this.fs;
  }

  async send(...msgs: (MainToLab | unknown)[]): Promise<void> {
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

  /** Renders round(seconds · fs / 128) quanta; buffers are NaN-filled first, so every sample must be written. */
  run(seconds: number): { left: Float32Array; right: Float32Array } {
    const n = Math.round((seconds * this.fs) / QUANTUM);
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

  /** Like run(), keeping nothing: allocates nothing itself. */
  spin(seconds: number): void {
    const n = Math.round((seconds * this.fs) / QUANTUM);
    for (let i = 0; i < n; i++) {
      audioTime = this.t;
      this.proc.process([], [[this.l, this.r]], {});
      this.q++;
    }
  }

  mark(): number {
    return this.posted.length;
  }

  meters(from = 0): MeterMsg[] {
    return this.posted.slice(from).filter((m): m is MeterMsg => m.type === 'meter');
  }

  meter(): MeterMsg {
    const m = this.meters().at(-1);
    if (m === undefined) throw new Error('no meter yet');
    return m;
  }

  errors(from = 0): string[] {
    return this.posted
      .slice(from)
      .filter((m): m is Extract<LabToMain, { type: 'error' }> => m.type === 'error')
      .map((m) => m.message);
  }
}

/** A rig running the five-cylinder at 3000 rpm, load 0.5, 1st gear, settled for `settleS`. */
async function running(settleS = 1): Promise<Rig> {
  const rig = new Rig();
  await rig.send({ type: 'engine', def: I5 }, MANUAL);
  rig.run(settleS);
  return rig;
}

function rmsDb(...chans: Float32Array[]): number {
  let s = 0;
  let n = 0;
  for (const c of chans) {
    for (const v of c) s += v * v;
    n += c.length;
  }
  return 10 * Math.log10(s / n);
}

/** Mean power of meter readings, dB. */
function meterDb(ms: readonly MeterMsg[]): number {
  return 10 * Math.log10(ms.reduce((p, m) => p + 10 ** (m.rmsDb / 10), 0) / ms.length);
}

const CEILING_F32 = Math.fround(OUTPUT_CEILING);
function sane(x: Float32Array): boolean {
  return x.every((v) => Number.isFinite(v) && Math.abs(v) <= CEILING_F32);
}

describe('the tesbox-lab processor', () => {
  it('registers as tesbox-lab and posts ready', () => {
    const rig = new Rig();
    expect(registered.name).toBe('tesbox-lab');
    expect(rig.posted).toEqual([{ type: 'ready' }]);
  });

  it('posts an error instead of ready where the core cannot run (96 kHz), and renders silence', () => {
    const rig = new Rig(96000);
    expect(rig.posted.map((m) => m.type)).toEqual(['error']);
    const out = rig.run(0.05);
    expect(out.left.every((v) => v === 0)).toBe(true);
  });

  it('renders silence and silent meters until an engine arrives', () => {
    const rig = new Rig();
    const out = rig.run(0.5);
    expect(out.left.every((v) => v === 0) && out.right.every((v) => v === 0)).toBe(true);
    const m = rig.meter();
    expect([m.rmsDb, m.peakDb]).toEqual([-200, -200]);
  });

  it('posts a meter about 20 times a second', () => {
    const rig = new Rig();
    rig.run(1);
    expect(rig.meters().length).toBeGreaterThanOrEqual(19);
    expect(rig.meters().length).toBeLessThanOrEqual(21);
  });
});

describe('manual control and the meter', () => {
  it('at 3000 rpm the meter is non-silent and finite, and reports the control', SLOW, async () => {
    const rig = await running(1.5);
    const ms = rig.meters().slice(-10);
    for (const m of ms) {
      expect(Number.isFinite(m.rmsDb) && Number.isFinite(m.peakDb)).toBe(true);
      expect(m.rmsDb).toBeGreaterThan(-60);
      expect(m.peakDb).toBeLessThanOrEqual(-1); // the stage's −1 dBTP ceiling
      expect(m.limiterGrDb).toBeGreaterThanOrEqual(0);
      expect(m.boost).toBeGreaterThanOrEqual(0);
      expect(m.boost).toBeLessThanOrEqual(1);
    }
    expect(rig.meter()).toMatchObject({ rpm: 3000, gear: 1, limiter: false, nonFiniteResets: 0 });
  });

  it('applies the monitor level after the stage: −12 dB by default, then the posted gain (clamped to −40)', SLOW, async () => {
    const rig = await running(1);
    let from = rig.mark();
    let out = rig.run(1);
    expect(rmsDb(out.left, out.right) - meterDb(rig.meters(from))).toBeCloseTo(-12, 0);

    await rig.send({ type: 'gain', db: -30 });
    rig.run(0.05);
    from = rig.mark();
    out = rig.run(1);
    expect(rmsDb(out.left, out.right) - meterDb(rig.meters(from))).toBeCloseTo(-30, 0);

    await rig.send({ type: 'gain', db: -70 });
    rig.run(0.05);
    from = rig.mark();
    out = rig.run(1);
    expect(rmsDb(out.left, out.right) - meterDb(rig.meters(from))).toBeCloseTo(-40, 0);
    expect(sane(out.left) && sane(out.right)).toBe(true);
  });

  it('clamps the manual rpm to the spec: 20 000 rpm renders at the limiter rpm', async () => {
    const rig = await running(0.1);
    await rig.send({ ...MANUAL, rpm: 20000, gear: 12 });
    rig.run(0.1);
    expect(rig.meter()).toMatchObject({ rpm: I5.spec.rpm.limiter.rpm, gear: I5.spec.gearbox.overallRatios.length });
  });

  it('keeps a manual control sent before the engine', async () => {
    const rig = new Rig();
    await rig.send({ ...MANUAL, rpm: 4000, gear: 2 }, { type: 'engine', def: I5 });
    rig.run(0.1);
    expect(rig.meter()).toMatchObject({ rpm: 4000, gear: 2 });
  });
});

describe('events and segments', () => {
  it('upshift changes the gear readout and the rpm by the ratio step', async () => {
    const rig = await running(0.2);
    await rig.send({ type: 'event', ev: 'upshift' });
    rig.run(0.2);
    const [r1, r2] = I5.spec.gearbox.overallRatios;
    expect(rig.meter().gear).toBe(2);
    expect(rig.meter().rpm).toBeCloseTo((3000 * (r2 ?? 0)) / (r1 ?? 1), 6);
  });

  it('the limiter event holds the limiter rpm with the limiter flag', async () => {
    const rig = await running(0.2);
    await rig.send({ type: 'event', ev: 'limiter' });
    rig.run(0.2);
    expect(rig.meter()).toMatchObject({ rpm: I5.spec.rpm.limiter.rpm, limiter: true });
  });

  it('a segment advances rpm; null returns to the manual control', SLOW, async () => {
    const rig = await running(0.2);
    await rig.send({ type: 'segment', name: 'wotPull' });
    const from = rig.mark();
    rig.run(1.5);
    const rpms = rig.meters(from).map((m) => m.rpm);
    expect(Math.max(...rpms) - Math.min(...rpms)).toBeGreaterThan(1000);
    await rig.send({ type: 'segment', name: null });
    rig.run(0.1);
    expect(rig.meter()).toMatchObject({ rpm: 3000, gear: 1 });
  });

  it('ignition off fades the engine to silence; on brings it back', SLOW, async () => {
    const rig = await running(0.5);
    await rig.send({ type: 'event', ev: 'ignition' });
    rig.run(2);
    expect(rig.meter().rmsDb).toBeLessThan(-80);
    await rig.send({ type: 'event', ev: 'ignition' });
    rig.run(1);
    expect(rig.meter().rmsDb).toBeGreaterThan(-60);
  });
});

describe('engine changes', () => {
  it('a voicing the core refuses: an error naming the field, and the previous engine keeps playing', SLOW, async () => {
    const rig = await running(1);
    const before = meterDb(rig.meters().slice(-10));
    const from = rig.mark();
    const bad: EngineDef = { ...I5, voicing: { ...I5.voicing, headersM: [5, ...I5.voicing.headersM.slice(1)] } };
    await rig.send({ type: 'engine', def: bad });
    rig.run(1);
    expect(rig.errors(from)).toEqual([expect.stringMatching(/^engine: .*headersM\[0\]/)]);
    const ms = rig.meters(from);
    expect(Math.min(...ms.map((m) => m.rmsDb))).toBeGreaterThan(before - 6); // no config fade: nothing was swapped
  });

  it('a new voicing reconfigures behind the core config fade, without errors', SLOW, async () => {
    const rig = await running(1);
    const steady = meterDb(rig.meters().slice(-10));
    const from = rig.mark();
    const edited: EngineDef = { ...I5, voicing: { ...I5.voicing, pulse: { ...I5.voicing.pulse, alpha: 14 } } };
    await rig.send({ type: 'engine', def: edited });
    const out = rig.run(1.5);
    expect(rig.errors(from)).toEqual([]);
    const ms = rig.meters(from);
    expect(Math.min(...ms.map((m) => m.rmsDb))).toBeLessThan(steady - 10); // the 300 ms fade-out / fade-in
    expect(meterDb(ms.slice(-5))).toBeGreaterThan(-60);
    expect(sane(out.left) && sane(out.right)).toBe(true);
  });

  it('accepts tier and output changes; rejects invalid ones', async () => {
    const rig = await running(0.1);
    const from = rig.mark();
    await rig.send(
      { type: 'tier', value: 'lite' },
      { type: 'output', config: { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 } },
      { type: 'tier', value: 'medium' },
      { type: 'output', config: { subwoofer: 'maybe', hpCornerHz: 40, volumeTrimDb: 0 } },
    );
    expect(rig.errors(from)).toEqual([expect.stringMatching(/^tier: /), expect.stringMatching(/^output: /)]);
  });
});

describe('robustness', () => {
  it('a malformed message posts an error and changes nothing', async () => {
    const rig = await running(0.2);
    const from = rig.mark();
    await rig.send(
      null,
      { type: 'warp' },
      { ...MANUAL, rpm: 'fast' },
      { ...MANUAL, valve: 'half' },
      { type: 'event', ev: 'turbo' },
      { type: 'segment', name: 'nope' },
      { type: 'gain', db: Number.NaN },
      { type: 'engine', def: null },
    );
    expect(rig.errors(from)).toHaveLength(8);
    rig.run(0.1);
    expect(rig.meter()).toMatchObject({ rpm: 3000, gear: 1 });
  });

  it('process() constructs no typed arrays', async () => {
    const rig = await running(0.2);
    let constructed = 0;
    const restore = countBufferConstructions(() => constructed++);
    try {
      rig.spin(1);
    } finally {
      restore();
    }
    expect(constructed).toBe(0);
  });
});
