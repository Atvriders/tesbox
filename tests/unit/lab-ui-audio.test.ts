/**
 * src/lab/ui/lab-audio.ts (phase-2c contract L1/L3): the page's audio graph — the AudioContext created inside
 * the Start tap, the 'tesbox-lab' worklet loaded like the app's, its initial messages posted first, and the
 * A/B graph: lab → match → A gain, local clip (decoded in the page, looped) → match × monitor → B gain, with a
 * 30 ms crossfade. Web Audio is faked; the e2e spec runs the real thing.
 */
import { describe, expect, it, vi } from 'vitest';
import { LabAudio } from '../../src/lab/ui/lab-audio';
import type { AudioRun, LabAudioEvents } from '../../src/lab/ui/model';
import type { LabToMain, MainToLab } from '../../src/lab/ui/protocol';

type ParamEvent = [string, ...number[]];

class FakeParam {
  readonly events: ParamEvent[] = [];
  constructor(public value: number) {}
  cancelScheduledValues(t: number): this {
    this.events.push(['cancel', t]);
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    this.events.push(['set', v, t]);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push(['ramp', v, t]);
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number): this {
    this.events.push(['target', v, t, tau]);
    this.value = v;
    return this;
  }
}

class FakeNode {
  readonly outputs: FakeNode[] = [];
  constructor(readonly kind: string) {}
  connect(n: FakeNode): FakeNode {
    this.outputs.push(n);
    return n;
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
  constructor() {
    super('gain');
  }
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  started = 0;
  stopped = 0;
  constructor() {
    super('source');
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
}

function fakeBuffer(sampleRate: number) {
  const data = new Float32Array(sampleRate).fill(0.5); // RMS 0.5
  return { duration: 1, sampleRate, numberOfChannels: 1, getChannelData: () => data };
}

const log: string[] = [];
let deviceRate = 48000;
let addModule: (url: string) => Promise<void> = () => Promise.resolve();
const contexts: FakeContext[] = [];

class FakeContext {
  readonly sampleRate: number;
  state: AudioContextState = 'suspended';
  currentTime = 2;
  readonly destination = new FakeNode('destination');
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  onstatechange: (() => void) | null = null;
  readonly audioWorklet = { addModule: (url: string) => addModule(url) };
  decoded = 0;
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? deviceRate;
    log.push(`context ${this.sampleRate}`);
    contexts.push(this);
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  decodeAudioData() {
    this.decoded++;
    return Promise.resolve(fakeBuffer(this.sampleRate));
  }
  resume(): Promise<void> {
    this.state = 'running';
    log.push('resume');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    log.push(`close ${this.sampleRate}`);
    return Promise.resolve();
  }
}

class FakeOffline {
  static made = 0;
  constructor(
    readonly channels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    FakeOffline.made++;
  }
  decodeAudioData() {
    return Promise.resolve(fakeBuffer(this.sampleRate));
  }
}

class FakeWorkletNode extends FakeNode {
  readonly port = {
    posted: [] as MainToLab[],
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: MainToLab) => {
      this.port.posted.push(m);
    },
  };
  onprocessorerror: (() => void) | null = null;
  static last: FakeWorkletNode | null = null;
  constructor(
    readonly ctx: FakeContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super('worklet');
    log.push(`node ${name}`);
    FakeWorkletNode.last = this;
  }
}

function lab(): LabAudio {
  return new LabAudio({
    AudioContext: FakeContext as unknown as typeof AudioContext,
    AudioWorkletNode: FakeWorkletNode as unknown as typeof AudioWorkletNode,
    OfflineAudioContext: FakeOffline as unknown as typeof OfflineAudioContext,
    workletUrl: '/assets/lab-worklet.js',
  });
}

function recorder() {
  const states: [AudioRun, string | undefined][] = [];
  const messages: LabToMain[] = [];
  const events: LabAudioEvents = {
    onState: (s, m) => states.push([s, m]),
    onMessage: (m) => messages.push(m),
  };
  return { states, messages, events };
}

const INITIAL: MainToLab[] = [
  { type: 'tier', value: 'full' },
  { type: 'gain', db: -12 },
];

function reset(): void {
  log.length = 0;
  contexts.length = 0;
  deviceRate = 48000;
  addModule = () => Promise.resolve();
  FakeWorkletNode.last = null;
  FakeOffline.made = 0;
}

describe('LabAudio.start', () => {
  it('creates the context inside the tap, then loads the worklet, posts the initial messages and resumes', async () => {
    reset();
    const a = lab();
    const r = recorder();
    const initial = vi.fn(() => INITIAL);
    const p = a.start(initial, r.events);
    expect(log).toEqual(['context 48000']); // synchronously, before any await: still inside the user gesture
    expect(initial).not.toHaveBeenCalled();
    await p;
    expect(log).toEqual(['context 48000', 'node tesbox-lab', 'resume']);
    const node = FakeWorkletNode.last;
    expect(node?.options).toEqual({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    expect(node?.port.posted).toEqual(INITIAL);
    expect(r.states.at(-1)).toEqual(['running', undefined]);
    expect(a.sampleRate).toBe(48000);
  });

  it('replaces a device rate the core cannot run (96 kHz) with a 48 kHz context, still inside the tap', () => {
    reset();
    deviceRate = 96000;
    void lab().start(() => [], recorder().events);
    expect(log).toEqual(['context 96000', 'close 96000', 'context 48000']);
  });

  it('a Start while the context exists resumes it instead of building a second graph', async () => {
    reset();
    const a = lab();
    await a.start(() => INITIAL, recorder().events);
    const ctx = contexts[0] as FakeContext;
    ctx.state = 'suspended';
    const r = recorder();
    await a.start(() => INITIAL, r.events);
    expect(contexts).toHaveLength(1);
    expect(r.states.at(-1)?.[0]).toBe('running');
    expect(FakeWorkletNode.last?.port.posted).toEqual(INITIAL);
  });

  it('reports a worklet that fails to load, leaves nothing behind, and builds afresh next time', async () => {
    reset();
    addModule = () => Promise.reject(new Error('404 lab-worklet.js'));
    const a = lab();
    const r = recorder();
    await a.start(() => INITIAL, r.events);
    expect(r.states.at(-1)).toEqual(['error', '404 lab-worklet.js']);
    expect(log).toContain('close 48000');
    expect(a.sampleRate).toBeNull();
    addModule = () => Promise.resolve();
    await a.start(() => INITIAL, recorder().events);
    expect(contexts).toHaveLength(2);
  });

  it('reports a context that will not resume as suspended instead of hanging in starting', async () => {
    reset();
    vi.useFakeTimers();
    try {
      const a = lab();
      const r = recorder();
      const p = a.start(() => INITIAL, r.events);
      const ctx = contexts[0] as FakeContext;
      ctx.resume = () => new Promise<void>(() => undefined); // never settles (no user activation)
      await vi.advanceTimersByTimeAsync(5_000);
      await p;
      expect(r.states.at(-1)).toEqual(['suspended', undefined]);
      expect(FakeWorkletNode.last?.port.posted).toEqual(INITIAL); // the graph exists: Resume audio can finish the job
    } finally {
      vi.useRealTimers();
    }
  });

  it('relays worklet messages and drops posts while no node exists', async () => {
    reset();
    const a = lab();
    a.post({ type: 'gain', db: -20 }); // nothing to post to yet: dropped, no throw
    const r = recorder();
    await a.start(() => [], r.events);
    a.post({ type: 'gain', db: -20 });
    expect(FakeWorkletNode.last?.port.posted).toEqual([{ type: 'gain', db: -20 }]);
    FakeWorkletNode.last?.port.onmessage?.({ data: { type: 'ready' } });
    FakeWorkletNode.last?.port.onmessage?.({ data: 'garbage' });
    expect(r.messages).toEqual([{ type: 'ready' }]);
  });
});

describe('LabAudio A/B graph', () => {
  async function built() {
    reset();
    const a = lab();
    await a.start(() => [], recorder().events);
    const ctx = contexts[0] as FakeContext;
    const node = FakeWorkletNode.last as FakeWorkletNode;
    const [labMatch, labAb] = node.outputs[0] === undefined ? [] : [node.outputs[0] as FakeGain, (node.outputs[0] as FakeGain).outputs[0] as FakeGain];
    return { a, ctx, node, labMatch: labMatch as FakeGain, labAb: labAb as FakeGain };
  }

  it('routes the lab through its match and A gains to the output, with the reference side silent', async () => {
    const { ctx, labMatch, labAb } = await built();
    expect(labAb.outputs).toEqual([ctx.destination]);
    expect(labAb.gain.value).toBe(1);
    expect(labMatch.gain.value).toBe(1);
    const refAb = ctx.gains.find((g) => g !== labAb && g.outputs[0] === ctx.destination) as FakeGain;
    expect(refAb.gain.value).toBe(0);
  });

  it('decodes a clip in the page and loops it into the reference side', async () => {
    const { a, ctx } = await built();
    const info = await a.loadReference(new ArrayBuffer(16));
    expect(info).toEqual({ durationS: 1, sampleRate: 48000, channels: 1, rms: 0.5 });
    expect(ctx.decoded).toBe(1);
    const src = ctx.sources[0] as FakeSource;
    expect([src.loop, src.started]).toEqual([true, 1]);
    const refGain = src.outputs[0] as FakeGain;
    expect((refGain.outputs[0] as FakeGain).outputs).toEqual([ctx.destination]);
    await a.loadReference(new ArrayBuffer(16)); // a new clip replaces the playing one
    expect(src.stopped).toBe(1);
    expect(ctx.sources[1]?.started).toBe(1);
  });

  it('decodes before Start without a running context, and plays the clip once the graph exists', async () => {
    reset();
    const a = lab();
    const info = await a.loadReference(new ArrayBuffer(16));
    expect(FakeOffline.made).toBe(1);
    expect(info.rms).toBe(0.5);
    await a.start(() => [], recorder().events);
    expect(contexts[0]?.sources[0]?.started).toBe(1);
  });

  it('crossfades A ⇄ B over the given time from now', async () => {
    const { a, ctx, labAb } = await built();
    await a.loadReference(new ArrayBuffer(16));
    const refAb = (ctx.sources[0]?.outputs[0] as FakeGain).outputs[0] as FakeGain;
    a.setAb('B', 0.03);
    expect(labAb.gain.events.slice(-3)).toEqual([
      ['cancel', 2],
      ['set', 1, 2],
      ['ramp', 0, 2.03],
    ]);
    expect(refAb.gain.events.slice(-1)).toEqual([['ramp', 1, 2.03]]);
    a.setAb('A', 0.03);
    expect([labAb.gain.value, refAb.gain.value]).toEqual([1, 0]);
  });

  it('applies the match gains, and the monitor level to the reference side', async () => {
    const { a, ctx, labMatch } = await built();
    await a.loadReference(new ArrayBuffer(16));
    const refGain = ctx.sources[0]?.outputs[0] as FakeGain;
    a.setLevels({ refGain: 0.5, labGain: 0.8, monitorGain: 0.25 });
    expect(labMatch.gain.value).toBe(0.8);
    expect(refGain.gain.value).toBe(0.125);
  });
});
