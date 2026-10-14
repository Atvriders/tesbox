import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EngineAudio,
  STOP_FADE_MS,
  type EngineAudioStart,
  type MediaAction,
} from '../../src/audio/engine-audio';
import type { AudioState } from '../../src/app/store';
import {
  DEFAULT_SIM_TUNING,
  F,
  S,
  STATE_LEN,
  type MainToWorklet,
  type OutputConfig,
  type Tier,
} from '../../src/contracts';
import { resolveTeslaParams } from '../../src/data/catalogue';
import { getEngine } from '../../src/data/engines';
import { MIN_SAMPLE_RATE } from '../../src/dsp/dsp-core';

// ───────────── fakes (minimal Web Audio / DOM surface EngineAudio touches; pattern of audio.test.ts) ─────────────

class FakeNode {
  connections: unknown[] = [];
  connect(dest: unknown): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections = [];
  }
}

class FakeStreamDestination extends FakeNode {
  readonly stream = { id: 'engine-stream' };
}

/** ok: resumes; stay: fulfils without leaving the current state; hang: never settles; reject: rejects. */
type ResumeMode = 'ok' | 'stay' | 'hang' | 'reject';
/** What getOutputTimestamp() returns for `ctx` at wall time `nowMs`. */
type OutputClock = (ctx: FakeAudioContext, nowMs: number) => AudioTimestamp;

/** baseLatency 0.01 s + outputLatency 0.04 s of every fake context. */
const FAKE_LATENCY_MS = 50;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** When set, addModule() waits for it (a slow module fetch). */
  static moduleGate: Promise<void> | null = null;
  /** Applied to every context constructed from now on. */
  static onCreate: ((c: FakeAudioContext) => void) | null = null;
  static clock: OutputClock = () => ({ contextTime: 0, performanceTime: 0 });
  /** The output device's rate: what a context runs at unless its options ask for a sampleRate. */
  static deviceRate = 48000;
  /** The browser refuses an explicit sampleRate option (constructor throws NotSupportedError). */
  static refuseSampleRateOption = false;
  state: AudioContextState = 'running';
  readonly sampleRate: number;
  baseLatency = 0.01;
  outputLatency = 0.04;
  currentTime = 0;
  readonly destination = new FakeNode();
  onstatechange: (() => void) | null = null;
  readonly modules: string[] = [];
  readonly streamDestinations: FakeStreamDestination[] = [];
  resumeMode: ResumeMode = 'ok';
  addModuleFails = false;
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url);
      if (this.addModuleFails) return Promise.reject(new Error('404'));
      return FakeAudioContext.moduleGate ?? Promise.resolve();
    },
  };
  constructor(readonly options: AudioContextOptions) {
    if (options.sampleRate !== undefined && FakeAudioContext.refuseSampleRateOption) {
      throw new DOMException('sampleRate option unsupported', 'NotSupportedError');
    }
    this.sampleRate = options.sampleRate ?? FakeAudioContext.deviceRate;
    FakeAudioContext.instances.push(this);
    FakeAudioContext.onCreate?.(this);
  }
  createMediaStreamDestination(): FakeStreamDestination {
    const d = new FakeStreamDestination();
    this.streamDestinations.push(d);
    return d;
  }
  getOutputTimestamp(): AudioTimestamp {
    return FakeAudioContext.clock(this, performance.now());
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeMode === 'hang') return new Promise(() => undefined);
    if (this.resumeMode === 'reject') return Promise.reject(new DOMException('cannot resume', 'InvalidStateError'));
    if (this.resumeMode === 'ok') this.setState('running');
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    this.setState('suspended');
    return Promise.resolve();
  }
  /** Web Audio: close() on a closed context rejects with InvalidStateError. */
  close(): Promise<void> {
    this.closeCalls++;
    if (this.state === 'closed') {
      return Promise.reject(new DOMException('Cannot close a closed AudioContext.', 'InvalidStateError'));
    }
    this.setState('closed');
    return Promise.resolve();
  }
  setState(s: AudioContextState): void {
    if (s === this.state) return;
    this.state = s;
    this.onstatechange?.();
  }
}

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly log: { msg: MainToWorklet; atMs: number }[] = [];
  get sent(): MainToWorklet[] {
    return this.log.map((e) => e.msg);
  }
  postMessage(msg: MainToWorklet): void {
    this.log.push({ msg, atMs: performance.now() });
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  readonly port = new FakePort();
  readonly createdAt = performance.now();
  onprocessorerror: (() => void) | null = null;
  constructor(
    readonly ctx: FakeAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeWorkletNode.instances.push(this);
  }
  benchKs(): number[] {
    return this.port.sent.flatMap((m) => (m.type === 'bench' ? [m.k] : []));
  }
  tiers(): Tier[] {
    return this.port.sent.flatMap((m) => (m.type === 'tier' ? [m.value] : []));
  }
}

class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  src = '';
  srcObject: unknown = null;
  loop = false;
  preload = '';
  paused = true;
  onpause: (() => void) | null = null;
  playCalls = 0;
  loadCalls = 0;
  constructor() {
    FakeAudioElement.instances.push(this);
  }
  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.onpause?.();
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {
    this.loadCalls++;
  }
}

class FakeMediaSession {
  metadata: unknown = null;
  playbackState: MediaSessionPlaybackState = 'none';
  readonly handlers = new Map<string, (() => void) | null>();
  /** Actions this browser does not support: setActionHandler throws for them. */
  unsupported = new Set<string>();
  setActionHandler(action: string, handler: (() => void) | null): void {
    if (this.unsupported.has(action)) throw new TypeError(`"${action}" is not a valid MediaSessionAction`);
    this.handlers.set(action, handler);
  }
}

class FakeMediaMetadata {
  constructor(readonly init: MediaMetadataInit) {}
}

class FakeDocument {
  createElement(tag: string): FakeAudioElement {
    if (tag !== 'audio') throw new Error(`unexpected element ${tag}`);
    return new FakeAudioElement();
  }
}

/** fetch() outcome — ok: the anchor Blob; fail: network error (offline); http404: not ok; hang: pending until releaseFetch(). */
type FetchMode = 'ok' | 'fail' | 'http404' | 'hang';
const ANCHOR_BLOB = new Blob([new Uint8Array(44)], { type: 'audio/wav' });

interface FakeResponse {
  ok: boolean;
  status: number;
  blob(): Promise<Blob>;
}

let fetchMode: FetchMode;
let fetchCalls: string[];
let releaseFetch: () => void;
/** Blobs passed to URL.createObjectURL (each returns `blob:anchor-<n>`) and URLs passed to revokeObjectURL. */
let objectUrlBlobs: unknown[];
let revokedUrls: string[];

function fakeFetch(url: string): Promise<FakeResponse> {
  fetchCalls.push(url);
  const ok: FakeResponse = { ok: true, status: 200, blob: () => Promise.resolve(ANCHOR_BLOB) };
  switch (fetchMode) {
    case 'fail':
      return Promise.reject(new TypeError('Failed to fetch'));
    case 'http404':
      return Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve(new Blob(['not found'])) });
    case 'hang':
      return new Promise((resolve) => {
        releaseFetch = () => resolve(ok);
      });
    default:
      return Promise.resolve(ok);
  }
}

/**
 * Output clock of a simulated audio thread: the context's newest node renders rate(k) seconds of
 * audio per wall second (k = the bench k it last received, 1 before any) and every rendered frame
 * reaches the output latencyMs later (contextTime 0 until the first one does).
 */
function renderClock(rate: (k: number) => number, latencyMs = FAKE_LATENCY_MS): OutputClock {
  return (ctx, nowMs) => {
    const node = FakeWorkletNode.instances.filter((n) => n.ctx === ctx).at(-1);
    const until = nowMs - latencyMs;
    if (node === undefined || until <= node.createdAt) return { contextTime: 0, performanceTime: nowMs };
    let t = node.createdAt;
    let k = 1;
    let renderedMs = 0;
    for (const { msg, atMs } of node.port.log) {
      if (msg.type !== 'bench') continue;
      if (atMs >= until) break;
      renderedMs += (atMs - t) * rate(k);
      t = atMs;
      k = msg.k;
    }
    renderedMs += (until - t) * rate(k);
    return { contextTime: 1 + renderedMs / 1000, performanceTime: nowMs };
  };
}

/** A worklet state snapshot (S.* fields; busyFrac NaN = unknown unless given). */
function stateBuf(fields: Partial<Record<keyof typeof S, number>> = {}): Float64Array {
  const buf = new Float64Array(STATE_LEN);
  buf[S.busyFrac] = NaN;
  for (const [key, value] of Object.entries(fields)) buf[S[key as keyof typeof S]] = value;
  return buf;
}

/** Time-weighted mean of load(k) over [fromMs, toMs]; k follows the bench messages posted to `node` (1 before any). */
function meanLoad(node: FakeWorkletNode, fromMs: number, toMs: number, load: (k: number) => number): number {
  let k = 1;
  let t = fromMs;
  let sum = 0;
  for (const { msg, atMs } of node.port.log) {
    if (msg.type !== 'bench') continue;
    if (atMs >= toMs) break;
    if (atMs > fromMs) {
      sum += (atMs - t) * load(k);
      t = atMs;
    }
    k = msg.k;
  }
  return (sum + (toMs - t) * load(k)) / (toMs - fromMs);
}

/**
 * The worklet's busy reporting as T3 implements it (src/audio/worklet.ts): busyFrac = mean busy load over
 * 1 s windows of audio counted from the node's first quantum (NaN until the first one closes), sent with
 * every snapshot (12 quanta ≈ 32 ms at 48 kHz); F.OVERLOAD while the last 2 windows were above 0.8.
 * load(k) = busy fraction at bench k; the audio clock runs at wall speed.
 */
function workletBusyReports(node: FakeWorkletNode, load: (k: number) => number): void {
  const windowMs = 1000;
  let windowStart = node.createdAt;
  let busyFrac = Number.NaN;
  let hot = 0;
  setInterval(() => {
    const now = performance.now();
    while (now - windowStart >= windowMs) {
      busyFrac = meanLoad(node, windowStart, windowStart + windowMs, load);
      hot = busyFrac > 0.8 ? hot + 1 : 0;
      windowStart += windowMs;
    }
    node.port.emit({ type: 'state', buf: stateBuf({ busyFrac, flags: hot >= 2 ? F.OVERLOAD : 0 }) });
  }, 32);
}

// ───────────── harness ─────────────

const WORKLET_URL = '/assets/tesbox-worklet.js';
const ANCHOR_URL = '/probe/anchor.wav';
/** The first object URL made of the fetched anchor (fake URL.createObjectURL). */
const ANCHOR_IN_MEMORY = 'blob:anchor-1';
const ENGINE = getEngine('i5-turbo-25');
const OTHER_ENGINE = getEngine('v8-na-50');
const TESLA = resolveTeslaParams('model3-highland-lr-awd');
const OUTPUT: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 };
/** Contract: recover() recreates when the context is "not running within 500 ms". */
const RESUME_WAIT_MS = 500;

/** What the shell sends at Start (contract: engine, tesla, output, source, tuning, warm). */
function startMessages(): MainToWorklet[] {
  return [
    { type: 'engine', def: ENGINE },
    { type: 'tesla', params: TESLA },
    { type: 'output', config: OUTPUT },
    { type: 'source', value: 'demo' },
    { type: 'tuning', value: { ...DEFAULT_SIM_TUNING } },
    { type: 'warm', warm: false },
  ];
}

/** startMessages() as posted: the tuning carries the context's outputLatency. */
function postedStart(outputLatencyS = 0.04): MainToWorklet[] {
  return startMessages().map((m) => (m.type === 'tuning' ? { type: 'tuning', value: { ...m.value, outputLatencyS } } : m));
}

function init(over: Partial<EngineAudioStart> = {}): EngineAudioStart {
  return {
    route: 'direct',
    latencyHint: 'balanced',
    messages: startMessages(),
    tierPref: 'full',
    mcu: 'amd',
    engineName: ENGINE.name,
    ...over,
  };
}

let states: AudioState[];
let snapshots: Float64Array[];
let actions: MediaAction[];
let errors: string[];
let session: FakeMediaSession;
let audio: EngineAudio;

const ctxs = (): FakeAudioContext[] => FakeAudioContext.instances;
const lastCtx = (): FakeAudioContext => {
  const c = ctxs().at(-1);
  if (c === undefined) throw new Error('no AudioContext');
  return c;
};
const lastNode = (): FakeWorkletNode => {
  const n = FakeWorkletNode.instances.at(-1);
  if (n === undefined) throw new Error('no AudioWorkletNode');
  return n;
};
const playing = (): FakeAudioElement[] => FakeAudioElement.instances.filter((e) => !e.paused);
const openCtxs = (): FakeAudioContext[] => ctxs().filter((c) => c.state !== 'closed');
const liveHandlers = (): number => [...session.handlers.values()].filter((h) => typeof h === 'function').length;

function newAudio(opts?: { workletUrl?: string; anchorUrl?: string }): EngineAudio {
  return new EngineAudio(
    {
      onState: (s) => states.push(s),
      onSnapshot: (b) => snapshots.push(b),
      onMediaAction: (a) => actions.push(a),
      onError: (m) => errors.push(m),
    },
    opts,
  );
}

/** stop() including the ignition-off fade it waits for. */
async function stopAudio(): Promise<void> {
  const p = audio.stop();
  await vi.advanceTimersByTimeAsync(STOP_FADE_MS);
  await p;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.moduleGate = null;
  FakeAudioContext.onCreate = null;
  FakeAudioContext.deviceRate = 48000;
  FakeAudioContext.refuseSampleRateOption = false;
  FakeAudioContext.clock = renderClock(() => 1);
  FakeWorkletNode.instances = [];
  FakeAudioElement.instances = [];
  session = new FakeMediaSession();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
  vi.stubGlobal('document', new FakeDocument());
  vi.stubGlobal('navigator', { mediaSession: session });
  fetchMode = 'ok';
  fetchCalls = [];
  releaseFetch = () => undefined;
  objectUrlBlobs = [];
  revokedUrls = [];
  vi.stubGlobal('fetch', fakeFetch);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    objectUrlBlobs.push(blob);
    return `blob:anchor-${objectUrlBlobs.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revokedUrls.push(url);
  });
  states = [];
  snapshots = [];
  actions = [];
  errors = [];
  audio = newAudio({ workletUrl: WORKLET_URL, anchorUrl: ANCHOR_URL });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ───────────── start ─────────────

describe('EngineAudio.start', () => {
  it('builds one context and the tesbox node, then posts the messages, the tier and ignition on', async () => {
    await audio.start(init());
    expect(ctxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'balanced' });
    expect(lastCtx().modules).toEqual([WORKLET_URL]);
    const node = lastNode();
    expect(node.name).toBe('tesbox');
    expect(node.options).toEqual({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    expect(node.port.sent).toEqual([
      ...postedStart(),
      { type: 'tier', value: 'full' },
      { type: 'ignition', on: true },
    ]);
    expect(node.connections).toEqual([lastCtx().destination]);
  });

  it('reports starting → running with the route and the tier, and exposes it as `state`', async () => {
    const started = audio.start(init({ route: 'direct-anchor', latencyHint: 'playback' }));
    expect(states).toEqual([{ state: 'starting', route: 'direct-anchor', tier: null }]);
    await started;
    expect(lastCtx().options).toEqual({ latencyHint: 'playback' });
    expect(states).toEqual([
      { state: 'starting', route: 'direct-anchor', tier: null },
      { state: 'running', route: 'direct-anchor', tier: 'full' },
    ]);
    expect(audio.state).toEqual({ state: 'running', route: 'direct-anchor', tier: 'full' });
  });

  it('starts off, and `state` is a copy', () => {
    const s = audio.state;
    expect(s).toEqual({ state: 'off', route: 'direct-anchor', tier: null });
    s.state = 'running';
    expect(audio.state.state).toBe('off');
  });

  it('creates the AudioContext synchronously, still inside the click', async () => {
    const started = audio.start(init());
    expect(ctxs()).toHaveLength(1); // no microtask has run yet
    await started;
  });

  it('a 96 kHz output device gets a 48 kHz context instead (the DSP runs at 28–48 kHz), still inside the tap', async () => {
    FakeAudioContext.deviceRate = 96000;
    const started = audio.start(init());
    // synchronously: the 96 kHz context is closed and its 48 kHz replacement exists before any await
    expect(ctxs().map((c) => [c.sampleRate, c.state])).toEqual([
      [96000, 'closed'],
      [48000, 'running'],
    ]);
    expect(lastCtx().options).toEqual({ latencyHint: 'balanced', sampleRate: 48000 });
    await started;
    expect(lastNode().ctx).toBe(lastCtx());
    expect(lastCtx().modules).toEqual([WORKLET_URL]);
    expect(audio.diagnostics.sampleRate).toBe(48000);
    expect(audio.state.state).toBe('running');
    expect(errors).toEqual([]);
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(openCtxs().map((c) => c.options)).toEqual([{ latencyHint: 'balanced', sampleRate: 48000 }]); // a rebuild too
  });

  it.each([MIN_SAMPLE_RATE, 44100, 48000])('a %i Hz output device keeps its own rate', async (rate) => {
    FakeAudioContext.deviceRate = rate;
    await audio.start(init());
    expect(ctxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'balanced' });
    expect(audio.diagnostics.sampleRate).toBe(rate);
  });

  it.each([MIN_SAMPLE_RATE - 1, 22050, 88200, 192000])('a %i Hz output device → one open 48 kHz context', async (rate) => {
    FakeAudioContext.deviceRate = rate;
    await audio.start(init());
    expect(openCtxs().map((c) => c.sampleRate)).toEqual([48000]);
    expect(lastNode().ctx).toBe(lastCtx());
  });

  it('a browser that refuses the 48 kHz request: start rejects and leaves no context', async () => {
    FakeAudioContext.deviceRate = 96000;
    FakeAudioContext.refuseSampleRateOption = true;
    await expect(audio.start(init())).rejects.toThrow('sampleRate option unsupported');
    expect(audio.state).toMatchObject({ state: 'error', message: 'NotSupportedError: sampleRate option unsupported' });
    expect(openCtxs()).toHaveLength(0);
    expect(FakeWorkletNode.instances).toHaveLength(0);
  });

  it('tuning.outputLatencyS = ctx.outputLatency, or 0.1 when the context reports none', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.outputLatency = 0;
    };
    await audio.start(init());
    expect(lastNode().port.sent.find((m) => m.type === 'tuning')).toEqual({
      type: 'tuning',
      value: { ...DEFAULT_SIM_TUNING, outputLatencyS: 0.1 },
    });
  });

  it('ignores tier, bench and ignition entries in the start messages: EngineAudio owns them', async () => {
    await audio.start(
      init({
        messages: [
          ...startMessages(),
          { type: 'tier', value: 'lite' },
          { type: 'bench', k: 8 },
          { type: 'ignition', on: false },
        ],
      }),
    );
    expect(lastNode().port.sent).toEqual([...postedStart(), { type: 'tier', value: 'full' }, { type: 'ignition', on: true }]);
  });

  it('defaults to the bundled ./worklet.ts module and the /probe/anchor.wav anchor', async () => {
    audio = newAudio();
    await audio.start(init({ route: 'direct-anchor' }));
    expect(lastCtx().modules).toHaveLength(1);
    expect(lastCtx().modules[0]).toMatch(/worklet\.ts\?worker_file/);
    expect(fetchCalls).toEqual(['/probe/anchor.wav']);
    fetchMode = 'fail';
    audio = newAudio();
    await audio.start(init({ route: 'direct-anchor' })); // not loadable: the element loads the file itself
    expect(FakeAudioElement.instances.at(-1)?.src).toBe('/probe/anchor.wav');
  });

  it('direct route: node → destination, no media element', async () => {
    await audio.start(init({ route: 'direct' }));
    expect(lastNode().connections).toEqual([lastCtx().destination]);
    expect(FakeAudioElement.instances).toHaveLength(0);
  });

  it('media-element route: node → MediaStreamDestination → playing <audio>.srcObject', async () => {
    await audio.start(init({ route: 'media-element' }));
    const msd = lastCtx().streamDestinations[0];
    expect(lastNode().connections).toEqual([msd]);
    const [el] = FakeAudioElement.instances;
    expect(el?.srcObject).toBe(msd?.stream);
    expect(el?.paused).toBe(false);
    expect(audio.state.route).toBe('media-element');
  });

  it('direct-anchor route: node → destination plus a looping anchor <audio>', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    expect(lastNode().connections).toEqual([lastCtx().destination]);
    const [el] = FakeAudioElement.instances;
    expect(el?.src).toBe(ANCHOR_IN_MEMORY);
    expect(el?.loop).toBe(true);
    expect(el?.paused).toBe(false);
  });

  it('registers the Media Session: metadata, playing, and the four handlers → onMediaAction', async () => {
    await audio.start(init());
    expect((session.metadata as FakeMediaMetadata).init).toEqual({ title: ENGINE.name, artist: 'Tesbox' });
    expect(session.playbackState).toBe('playing');
    expect([...session.handlers.keys()].sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack']);
    for (const a of ['nexttrack', 'previoustrack', 'pause', 'play']) session.handlers.get(a)?.();
    expect(actions).toEqual(['nexttrack', 'previoustrack', 'pause', 'play']);
  });

  it('an action the browser rejects does not stop the others from registering', async () => {
    session.unsupported.add('previoustrack');
    await audio.start(init());
    expect([...session.handlers.keys()].sort()).toEqual(['nexttrack', 'pause', 'play']);
    expect(audio.state.state).toBe('running');
  });

  it('works without a Media Session', async () => {
    vi.stubGlobal('navigator', {});
    await audio.start(init());
    expect(audio.state.state).toBe('running');
  });

  it('addModule failure: rejects, reports error with the message, leaves nothing; a retry builds anew', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.addModuleFails = true;
    };
    await expect(audio.start(init({ route: 'direct-anchor' }))).rejects.toThrow('404');
    expect(audio.state).toEqual({ state: 'error', route: 'direct-anchor', tier: null, message: '404' });
    expect(openCtxs()).toHaveLength(0);
    expect(FakeWorkletNode.instances).toHaveLength(0);
    expect(liveHandlers()).toBe(0);
    FakeAudioContext.onCreate = null;
    await audio.start(init());
    expect(ctxs()).toHaveLength(2);
    expect(audio.state.state).toBe('running');
  });

  it('a module fetch that never settles fails after 10 s', async () => {
    FakeAudioContext.moduleGate = new Promise<void>(() => undefined);
    const started = audio.start(init());
    const rejected = expect(started).rejects.toThrow('addModule timed out after 10000 ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(audio.state.state).toBe('error');
    expect(openCtxs()).toHaveLength(0);
  });

  it('media-element without MediaStreamAudioDestinationNode: rejects and leaves no context or session', async () => {
    FakeAudioContext.onCreate = (c) => {
      (c as unknown as { createMediaStreamDestination: unknown }).createMediaStreamDestination = undefined;
    };
    await expect(audio.start(init({ route: 'media-element' }))).rejects.toThrow('media-element route unsupported');
    expect(audio.state.state).toBe('error');
    expect(openCtxs()).toHaveLength(0);
    expect(session.handlers.size).toBe(0);
  });

  it('a context that stays suspended (no activation) reports interrupted: Tap to resume', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.state = 'suspended';
      c.resumeMode = 'stay';
    };
    const started = audio.start(init());
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS);
    await started;
    expect(lastCtx().resumeCalls).toBe(1);
    expect(audio.state.state).toBe('interrupted');
    expect(lastNode().port.sent.at(-1)).toEqual({ type: 'ignition', on: true }); // configured all the same
  });

  it('start() twice concurrently builds exactly one context and node', async () => {
    await Promise.all([audio.start(init({ route: 'direct-anchor' })), audio.start(init({ route: 'direct-anchor' }))]);
    expect(ctxs()).toHaveLength(1);
    expect(FakeWorkletNode.instances).toHaveLength(1);
    expect(playing()).toHaveLength(1);
  });

  it('start() while a session exists changes nothing (config goes through post, routes through setRoute)', async () => {
    await audio.start(init());
    const sent = lastNode().port.sent.length;
    await audio.start(init({ route: 'media-element', latencyHint: 'playback' }));
    expect(ctxs()).toHaveLength(1);
    expect(lastNode().port.sent).toHaveLength(sent);
    expect(audio.state.route).toBe('direct');
  });
});

// ───────────── tier selection (spec §5.7) ─────────────

describe('EngineAudio tier selection', () => {
  it.each([
    { tierPref: 'full', mcu: 'intel', tier: 'full' },
    { tierPref: 'lite', mcu: 'amd', tier: 'lite' },
    { tierPref: 'auto', mcu: 'intel', tier: 'lite' },
  ] as const)('tierPref $tierPref on $mcu → $tier without a benchmark', async ({ tierPref, mcu, tier }) => {
    await audio.start(init({ tierPref, mcu }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastNode().tiers()).toEqual([tier]);
    expect(lastNode().benchKs()).toEqual([]);
    expect(audio.state.tier).toBe(tier);
    expect(audio.diagnostics.bench).toBeNull();
  });

  it('auto (AMD): bench k = 1, 2, 4, 8 for 0.5 s each during the crank, then the tier and bench 1', async () => {
    await audio.start(init({ tierPref: 'auto', mcu: 'amd' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(2100);
    const t0 = node.createdAt;
    const timeline = node.port.log
      .filter((e) => e.msg.type === 'bench' || e.msg.type === 'tier' || e.msg.type === 'ignition')
      .map((e) => [e.msg, e.atMs - t0]);
    expect(timeline).toEqual([
      [{ type: 'tier', value: 'full' }, 0], // provisional: the benchmark measures Full
      [{ type: 'ignition', on: true }, 0],
      [{ type: 'bench', k: 1 }, 0],
      [{ type: 'bench', k: 2 }, 500],
      [{ type: 'bench', k: 4 }, 1000],
      [{ type: 'bench', k: 8 }, 1500],
      [{ type: 'tier', value: 'full' }, 2000],
      [{ type: 'bench', k: 1 }, 2000],
    ]);
    expect(audio.state.tier).toBe('full');
    await vi.advanceTimersByTimeAsync(5000);
    expect(node.port.sent).toHaveLength(postedStart().length + 8); // nothing more after the decision
  });

  it('auto (unknown MCU): the audio clock falling behind from k = 4 → lite', async () => {
    FakeAudioContext.clock = renderClock((k) => (k >= 4 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto', mcu: 'unknown' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'lite']);
    expect(lastNode().benchKs()).toEqual([1, 2, 4, 8, 1]);
    expect(states.at(-1)).toEqual({ state: 'running', route: 'direct', tier: 'lite' });
    expect(audio.diagnostics.bench?.headroomK).toBe(2);
  });

  it('auto: overload only at k = 8 still gives full (Full iff k = 4 runs without overload)', async () => {
    FakeAudioContext.clock = renderClock((k) => (k >= 8 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
    expect(audio.diagnostics.bench?.headroomK).toBe(4);
  });

  it('auto: an overloaded k = 2 alone does not decide — Full iff k = 4 runs without overload', async () => {
    FakeAudioContext.clock = renderClock((k) => (k === 2 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
    const bench = audio.diagnostics.bench;
    expect(bench?.steps.map((s) => [s.k, s.overloaded])).toEqual([
      [1, false],
      [2, true],
      [4, false],
      [8, false],
    ]);
    expect(bench?.headroomK).toBe(8); // spec §5.7: headroom = largest k with no drift
  });

  it('auto: k = 1–2 unmeasured (output clock not started yet) but a clean k = 4 → full', async () => {
    const clock = renderClock(() => 1);
    FakeAudioContext.clock = (ctx, nowMs) => {
      const node = FakeWorkletNode.instances.filter((n) => n.ctx === ctx).at(-1);
      if (node === undefined || nowMs - node.createdAt < 1100) return { contextTime: 0, performanceTime: nowMs };
      return clock(ctx, nowMs);
    };
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
    expect(audio.diagnostics.bench?.steps.map((s) => [s.k, s.overloaded])).toEqual([
      [1, null],
      [2, null],
      [4, false],
      [8, false],
    ]);
  });

  it('measures each step from its own output: a 400 ms output latency does not hide a k = 4 overload', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.outputLatency = 0.39; // + baseLatency 0.01
    };
    FakeAudioContext.clock = renderClock((k) => (k >= 4 ? 0.9 : 1), 400);
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'lite']);
  });

  it('…and a 400 ms output latency does not move a k = 8 overload onto k = 4', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.outputLatency = 0.39;
    };
    FakeAudioContext.clock = renderClock((k) => (k >= 8 ? 0.9 : 1), 400);
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
  });

  it('busy reports during the crank describe k ≤ 2 only: a k = 4 busy load is not seen by itself (drift is the k = 4 signal)', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    workletBusyReports(node, (k) => 0.25 * k); // k = 4 is 1.0 busy, but its window closes as the benchmark ends
    await vi.advanceTimersByTimeAsync(2100);
    expect(node.tiers()).toEqual(['full', 'full']);
    expect(audio.diagnostics.bench?.steps.map((s) => [s.k, s.overloaded, s.busyFrac])).toEqual([
      [1, false, null],
      [2, false, null],
      [4, false, 0.375], // the first window: (0.25 + 0.5) / 2, received while k = 4 runs
      [8, false, 0.375],
    ]);
  });

  it('a k = 1–2 busy window above 0.8, received while k = 4 runs, marks k = 4 overloaded → lite, even without drift', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    workletBusyReports(node, (k) => 0.5 + 0.22 * k); // first window: (0.72 + 0.94) / 2 = 0.83
    await vi.advanceTimersByTimeAsync(2100);
    expect(node.tiers()).toEqual(['full', 'lite']);
    expect(audio.diagnostics.bench?.steps.map((s) => [s.k, s.overloaded, s.busyFrac])).toEqual([
      [1, false, null],
      [2, false, null],
      [4, true, 0.83],
      [8, true, 0.83],
    ]);
  });

  it('a busy report first received during the k = 8 step (it may describe k = 8) is not held against k = 4 → full', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(1700);
    node.port.emit({ type: 'state', buf: stateBuf({ busyFrac: 0.95 }) });
    await vi.advanceTimersByTimeAsync(400);
    expect(node.tiers()).toEqual(['full', 'full']);
  });

  it('the worklet OVERLOAD flag reported while k = 4 runs (a worklet already running hot) → lite', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    setInterval(() => node.port.emit({ type: 'state', buf: stateBuf({ flags: F.OVERLOAD }) }), 32);
    await vi.advanceTimersByTimeAsync(2100);
    expect(node.tiers()).toEqual(['full', 'lite']);
    expect(audio.diagnostics.bench?.steps.find((s) => s.k === 4)?.overloaded).toBe(true);
  });

  it('an OVERLOAD flag reported only during the k = 2 step (it cleared before k = 4) → full', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(700);
    node.port.emit({ type: 'state', buf: stateBuf({ flags: F.OVERLOAD }) });
    await vi.advanceTimersByTimeAsync(1400);
    expect(node.tiers()).toEqual(['full', 'full']);
    expect(audio.diagnostics.bench?.steps.map((s) => s.overloaded)).toEqual([false, true, false, false]);
  });

  it('an output clock that never advances proves no headroom → lite', async () => {
    FakeAudioContext.clock = (_c, nowMs) => ({ contextTime: 0, performanceTime: nowMs });
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'lite']);
    expect(audio.diagnostics.bench?.steps.every((s) => s.overloaded === null && s.ratio === null)).toBe(true);
    expect(audio.diagnostics.bench?.headroomK).toBe(0);
  });

  it('without getOutputTimestamp the render clock (currentTime) is measured, unshifted', async () => {
    FakeAudioContext.onCreate = (c) => {
      (c as unknown as { getOutputTimestamp: unknown }).getOutputTimestamp = undefined;
      c.currentTime = 1;
    };
    await audio.start(init({ tierPref: 'auto' }));
    const ctx = lastCtx();
    const node = lastNode();
    setInterval(() => {
      const k = node.benchKs().at(-1) ?? 1;
      ctx.currentTime += 0.01 * (k >= 4 ? 0.9 : 1);
    }, 10);
    await vi.advanceTimersByTimeAsync(2100);
    expect(node.tiers()).toEqual(['full', 'lite']);
    expect(audio.diagnostics.bench?.headroomK).toBe(2);
  });

  it('an interruption mid-benchmark drops the measurement (bench 1); the next running period benchmarks afresh', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(700); // inside the k = 2 step
    lastCtx().setState('interrupted');
    expect(audio.state.state).toBe('interrupted');
    expect(node.benchKs()).toEqual([1, 2, 1]); // a stall would read as overload: discarded, load back to 1×
    await vi.advanceTimersByTimeAsync(3000);
    expect(node.tiers()).toEqual(['full']); // nothing decided
    lastCtx().setState('running'); // came back by itself (spec §6.3)
    expect(audio.state.state).toBe('running');
    await vi.advanceTimersByTimeAsync(2100);
    expect(node.benchKs()).toEqual([1, 2, 1, 1, 2, 4, 8, 1]);
    expect(node.tiers()).toEqual(['full', 'full']);
  });

  it('a start that ends suspended benchmarks once Tap to resume gets it running', async () => {
    FakeAudioContext.onCreate = (c) => {
      c.state = 'suspended';
      c.resumeMode = 'stay';
    };
    const started = audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS);
    await started;
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastNode().benchKs()).toEqual([]); // a stopped clock measures nothing
    lastCtx().resumeMode = 'ok';
    expect(await audio.recover()).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().benchKs()).toEqual([1, 2, 4, 8, 1]);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
  });

  it('stop() mid-benchmark: bench back to 1, then ignition off; no further steps and no decision', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(1200);
    const stopped = audio.stop();
    expect(node.port.sent.slice(-2)).toEqual([
      { type: 'bench', k: 1 },
      { type: 'ignition', on: false },
    ]);
    await vi.advanceTimersByTimeAsync(STOP_FADE_MS);
    await stopped;
    await vi.advanceTimersByTimeAsync(2000);
    expect(node.benchKs()).toEqual([1, 2, 4, 1]);
    expect(node.tiers()).toEqual(['full']);
  });

  it('a tier posted by Settings ends a running benchmark and is kept for recoveries', async () => {
    await audio.start(init({ tierPref: 'auto' }));
    const node = lastNode();
    await vi.advanceTimersByTimeAsync(700);
    audio.post({ type: 'tier', value: 'lite' });
    expect(node.port.sent.slice(-2)).toEqual([
      { type: 'bench', k: 1 },
      { type: 'tier', value: 'lite' },
    ]);
    expect(audio.state.tier).toBe('lite');
    await vi.advanceTimersByTimeAsync(3000);
    expect(node.benchKs()).toEqual([1, 2, 1]);
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(lastNode().tiers()).toEqual(['lite']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastNode().benchKs()).toEqual([]);
  });

  it('a decided tier is replayed by a recovery without benchmarking again', async () => {
    FakeAudioContext.clock = renderClock((k) => (k >= 4 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(lastNode().tiers()).toEqual(['lite']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(lastNode().benchKs()).toEqual([]);
  });

  it('every start() chooses the tier again', async () => {
    FakeAudioContext.clock = renderClock((k) => (k >= 4 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto' }));
    await vi.advanceTimersByTimeAsync(2100);
    expect(audio.state.tier).toBe('lite');
    await stopAudio();
    FakeAudioContext.clock = renderClock(() => 1);
    await audio.start(init({ tierPref: 'auto' }));
    expect(lastNode().tiers()).toEqual(['full']);
    await vi.advanceTimersByTimeAsync(2100);
    expect(lastNode().tiers()).toEqual(['full', 'full']);
  });
});

// ───────────── post ─────────────

describe('EngineAudio.post', () => {
  it('forwards messages to the worklet; a tuning gets the context outputLatency', async () => {
    await audio.start(init());
    const node = lastNode();
    const n = node.port.sent.length;
    audio.post({ type: 'shiftUp' });
    audio.post({ type: 'testTone', hz: 40, levelDb: -18 });
    audio.post({ type: 'tuning', value: { ...DEFAULT_SIM_TUNING, gpsLatencyS: 0.5 } });
    expect(node.port.sent.slice(n)).toEqual([
      { type: 'shiftUp' },
      { type: 'testTone', hz: 40, levelDb: -18 },
      { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, gpsLatencyS: 0.5, outputLatencyS: 0.04 } },
    ]);
  });

  it('an engine message retitles the Media Session', async () => {
    await audio.start(init());
    audio.post({ type: 'engine', def: OTHER_ENGINE });
    expect((session.metadata as FakeMediaMetadata).init).toEqual({ title: OTHER_ENGINE.name, artist: 'Tesbox' });
  });

  it('before start: settings-like messages are kept and sent at start ahead of the start messages; events are dropped', async () => {
    audio.post({ type: 'gearboxMode', value: 'manual' });
    audio.post({ type: 'valve', mode: 'open' });
    audio.post({ type: 'shiftUp' });
    audio.post({ type: 'pedal', throttle: 1, brake: 0 });
    audio.post({ type: 'visibility', hidden: true });
    audio.post({ type: 'valve', mode: 'closed' }); // replaces the older valve
    expect(ctxs()).toHaveLength(0);
    await audio.start(init());
    expect(lastNode().port.sent).toEqual([
      { type: 'gearboxMode', value: 'manual' },
      { type: 'valve', mode: 'closed' },
      ...postedStart(),
      { type: 'tier', value: 'full' },
      { type: 'ignition', on: true },
    ]);
  });
});

// ───────────── setRoute ─────────────

describe('EngineAudio.setRoute', () => {
  it('reconnects the live context: one connected route, one playing element, state updated', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    await Promise.all([audio.setRoute('media-element'), audio.setRoute('direct'), audio.setRoute('media-element')]);
    expect(ctxs()).toHaveLength(1);
    const node = lastNode();
    expect(node.connections).toEqual([lastCtx().streamDestinations.at(-1)]);
    expect(playing()).toHaveLength(1);
    expect(playing()[0]?.srcObject).toBe(lastCtx().streamDestinations.at(-1)?.stream);
    for (const el of FakeAudioElement.instances.slice(0, -1)) expect(el.loadCalls).toBe(1); // released
    expect(audio.state).toEqual({ state: 'running', route: 'media-element', tier: 'full' });
    expect(errors).toEqual([]);
  });

  it('switching to direct stops the media element; our own pause is not an interruption', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    await audio.setRoute('direct');
    expect(playing()).toHaveLength(0);
    expect(lastNode().connections).toEqual([lastCtx().destination]);
    expect(audio.state.state).toBe('running');
  });

  it('an unsupported media-element route rejects and keeps the connected route', async () => {
    FakeAudioContext.onCreate = (c) => {
      (c as unknown as { createMediaStreamDestination: unknown }).createMediaStreamDestination = undefined;
    };
    await audio.start(init({ route: 'direct-anchor' }));
    await expect(audio.setRoute('media-element')).rejects.toThrow('media-element route unsupported');
    expect(audio.state.route).toBe('direct-anchor');
    expect(playing()).toHaveLength(1);
    expect(playing()[0]?.src).toBe(ANCHOR_IN_MEMORY);
  });

  it('before start: creates nothing (start takes its own route)', async () => {
    await audio.setRoute('media-element');
    expect(ctxs()).toHaveLength(0);
    expect(FakeAudioElement.instances).toHaveLength(0);
    await audio.start(init({ route: 'direct' }));
    expect(audio.state.route).toBe('direct');
  });
});

// ───────────── recover (spec §6.3) ─────────────

describe('EngineAudio.recover', () => {
  it('resume path: a suspended context that resumes within 500 ms → true, same context', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    lastCtx().setState('suspended');
    expect(audio.state.state).toBe('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(ctxs()).toHaveLength(1);
    expect(audio.state.state).toBe('running');
    expect(audio.diagnostics.recoveries).toEqual({ resumeOk: 1, resumeFail: 0, recreate: 0 });
    expect(FakeAudioElement.instances[0]?.playCalls).toBe(1); // still playing: not restarted
  });

  it("an 'interrupted' context is closed and rebuilt inside the tap; config, warm, tier and ignition replayed", async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    audio.post({ type: 'gearboxMode', value: 'manual' });
    audio.post({ type: 'pedal', throttle: 1, brake: 0 }); // an event: not replayed
    audio.post({ type: 'engine', def: OTHER_ENGINE });
    const old = lastCtx();
    old.setState('interrupted');
    const recovered = audio.recover();
    expect(ctxs()).toHaveLength(2); // built synchronously, still inside the tap
    expect(old.resumeCalls).toBe(0); // resume() fails from 'interrupted' even in a tap: not tried
    expect(await recovered).toBe(true);
    expect(old.state).toBe('closed');
    expect(openCtxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'balanced' });
    expect(lastCtx().modules).toEqual([WORKLET_URL]);
    expect(lastNode().port.sent).toEqual([
      { type: 'tesla', params: TESLA },
      { type: 'output', config: OUTPUT },
      { type: 'source', value: 'demo' },
      { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, outputLatencyS: 0.04 } },
      { type: 'gearboxMode', value: 'manual' },
      { type: 'engine', def: OTHER_ENGINE },
      { type: 'warm', warm: true }, // the engine was just running
      { type: 'tier', value: 'full' },
      { type: 'ignition', on: true },
    ]);
    expect(playing()).toHaveLength(1);
    expect(playing()[0]?.src).toBe(ANCHOR_IN_MEMORY);
    expect((session.metadata as FakeMediaMetadata).init).toEqual({ title: OTHER_ENGINE.name, artist: 'Tesbox' });
    expect(liveHandlers()).toBe(4);
    expect(audio.state).toEqual({ state: 'running', route: 'direct-anchor', tier: 'full' });
    expect(audio.diagnostics.recoveries).toEqual({ resumeOk: 0, resumeFail: 0, recreate: 1 });
  });

  it('replays the last ignition state the shell posted', async () => {
    await audio.start(init());
    audio.post({ type: 'ignition', on: false });
    lastCtx().setState('interrupted');
    await audio.recover();
    expect(lastNode().port.sent.at(-1)).toEqual({ type: 'ignition', on: false });
  });

  it('resume() rejects → recreate', async () => {
    await audio.start(init());
    lastCtx().setState('suspended');
    lastCtx().resumeMode = 'reject';
    expect(await audio.recover()).toBe(true);
    expect(ctxs()).toHaveLength(2);
    expect(audio.diagnostics.recoveries).toEqual({ resumeOk: 0, resumeFail: 1, recreate: 1 });
  });

  it('resume() still pending after 500 ms → recreate', async () => {
    await audio.start(init());
    lastCtx().setState('suspended');
    lastCtx().resumeMode = 'hang';
    const recovered = audio.recover();
    await vi.advanceTimersByTimeAsync(RESUME_WAIT_MS - 1);
    expect(ctxs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctxs()).toHaveLength(2);
    expect(await recovered).toBe(true);
    expect(audio.state.state).toBe('running');
  });

  it('resume() fulfils but the context is not running → recreate', async () => {
    await audio.start(init());
    lastCtx().setState('suspended');
    lastCtx().resumeMode = 'stay';
    expect(await audio.recover()).toBe(true);
    expect(ctxs()).toHaveLength(2);
    expect(openCtxs()).toHaveLength(1);
  });

  it('a recreate that fails → false, error state, nothing left; the next tap tries again', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    lastCtx().setState('interrupted');
    FakeAudioContext.onCreate = (c) => {
      c.addModuleFails = true;
    };
    expect(await audio.recover()).toBe(false);
    expect(audio.state).toEqual({ state: 'error', route: 'direct-anchor', tier: null, message: '404' });
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect(liveHandlers()).toBe(0);
    FakeAudioContext.onCreate = null;
    expect(await audio.recover()).toBe(true);
    expect(audio.state.state).toBe('running');
    expect(openCtxs()).toHaveLength(1);
    expect(session.playbackState).toBe('playing');
  });

  it('a context that closed by itself is rebuilt without closing it again (no error toast)', async () => {
    await audio.start(init());
    const old = lastCtx();
    old.setState('closed');
    expect(audio.state.state).toBe('interrupted');
    expect(await audio.recover()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    expect(old.closeCalls).toBe(0);
    expect(audio.state.state).toBe('running');
  });

  it('an external pause of the route element is an interruption; recover() restarts the element', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    const [el] = FakeAudioElement.instances;
    el?.pause(); // e.g. the car took the audio focus
    expect(audio.state.state).toBe('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(ctxs()).toHaveLength(1);
    expect(el?.paused).toBe(false);
    expect(el?.playCalls).toBe(2);
    expect(audio.state.state).toBe('running');
  });

  it('recover() before start or after stop does nothing', async () => {
    expect(await audio.recover()).toBe(false);
    expect(ctxs()).toHaveLength(0);
    await audio.start(init());
    await stopAudio();
    expect(await audio.recover()).toBe(false);
    expect(ctxs()).toHaveLength(1);
    expect(audio.state.state).toBe('off');
  });

  it('a recover() during a pending start runs after it: one live graph', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = audio.start(init({ route: 'direct-anchor' }));
    const recovered = audio.recover();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await started;
    expect(await recovered).toBe(true);
    expect(ctxs()).toHaveLength(1); // running by then: the resume path
    expect(playing()).toHaveLength(1);
  });
});

// ───────────── context state changes ─────────────

describe('EngineAudio context state', () => {
  it('suspended or interrupted without the user asking → interrupted; never resumed without a tap', async () => {
    await audio.start(init());
    const ctx = lastCtx();
    ctx.setState('suspended');
    expect(audio.state.state).toBe('interrupted');
    expect(ctx.resumeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.resumeCalls).toBe(0); // no timer-driven retries
  });

  it('interrupted → running by itself → running again', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    const ctx = lastCtx();
    ctx.setState('interrupted');
    FakeAudioElement.instances[0]?.pause(); // the same interruption paused the anchor
    ctx.setState('running');
    expect(audio.state.state).toBe('running');
    expect(playing()).toHaveLength(1);
  });

  it('interrupted → suspended by itself → one automatic resume()', async () => {
    await audio.start(init());
    const ctx = lastCtx();
    ctx.setState('interrupted');
    ctx.resumeMode = 'stay';
    ctx.setState('suspended');
    expect(ctx.resumeCalls).toBe(1);
    expect(audio.state.state).toBe('interrupted');
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.resumeCalls).toBe(1);
    ctx.setState('interrupted');
    ctx.resumeMode = 'ok';
    ctx.setState('suspended');
    expect(ctx.resumeCalls).toBe(2);
    expect(audio.state.state).toBe('running');
  });

  it('ignores a replaced context', async () => {
    await audio.start(init());
    const old = lastCtx();
    old.setState('interrupted');
    await audio.recover();
    const n = states.length;
    old.setState('running');
    old.setState('suspended');
    expect(states).toHaveLength(n);
    expect(audio.state.state).toBe('running');
  });

  it('a media-element whose play() is refused is an interruption; a refused anchor is only an error', async () => {
    const play = vi
      .spyOn(FakeAudioElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await audio.start(init({ route: 'direct-anchor' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['direct-anchor element play failed: NotAllowedError: denied']);
    expect(audio.state.state).toBe('running');
    play.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await audio.setRoute('media-element');
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.at(-1)).toBe('media-element element play failed: NotAllowedError: denied');
    expect(audio.state.state).toBe('interrupted');
    play.mockRestore();
  });

  it('never calls suspend()', async () => {
    await audio.start(init({ route: 'direct-anchor', tierPref: 'auto' }));
    audio.setVisibility(true);
    audio.setVisibility(false);
    await audio.setRoute('media-element');
    lastCtx().setState('interrupted');
    await audio.recover();
    lastCtx().setState('suspended');
    await audio.recover();
    await vi.advanceTimersByTimeAsync(3000);
    await stopAudio();
    expect(ctxs().map((c) => c.suspendCalls)).toEqual([0, 0]);
  });
});

// ───────────── visibility ─────────────

describe('EngineAudio.setVisibility', () => {
  it('posts { type: visibility }; it is never replayed', async () => {
    await audio.start(init());
    audio.setVisibility(true);
    audio.setVisibility(false);
    expect(lastNode().port.sent.slice(-2)).toEqual([
      { type: 'visibility', hidden: true },
      { type: 'visibility', hidden: false },
    ]);
    lastCtx().setState('interrupted');
    await audio.recover();
    expect(lastNode().port.sent.some((m) => m.type === 'visibility')).toBe(false);
  });

  it('becoming visible with a context that stopped meanwhile → interrupted (Tap to resume)', async () => {
    await audio.start(init());
    audio.setVisibility(true);
    lastCtx().state = 'suspended'; // no statechange delivered while hidden
    audio.setVisibility(false);
    expect(audio.state.state).toBe('interrupted');
  });
});

// ───────────── stop ─────────────

describe('EngineAudio.stop', () => {
  it('ignition off, waits for the fade, then closes and clears the route and the Media Session', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    const ctx = lastCtx();
    const stopped = audio.stop();
    expect(lastNode().port.sent.at(-1)).toEqual({ type: 'ignition', on: false });
    await vi.advanceTimersByTimeAsync(STOP_FADE_MS - 1);
    expect(ctx.closeCalls).toBe(0); // still fading out
    expect(playing()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(ctx.closeCalls).toBe(1);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();
    expect(liveHandlers()).toBe(0);
    expect(audio.state).toEqual({ state: 'off', route: 'direct-anchor', tier: null });
    expect(audio.diagnostics.contextState).toBe('none');
  });

  it('a context that is not running is closed at once', async () => {
    await audio.start(init());
    lastCtx().setState('interrupted');
    await audio.stop();
    expect(lastCtx().closeCalls).toBe(1);
    expect(audio.state.state).toBe('off');
  });

  it('a context that closed by itself is not closed again: off, no error', async () => {
    await audio.start(init());
    const ctx = lastCtx();
    ctx.setState('closed');
    await audio.stop();
    expect(ctx.closeCalls).toBe(0);
    expect(errors).toEqual([]);
    expect(audio.state.state).toBe('off');
  });

  it('abandons a close() that never settles after 2 s; later operations still run', async () => {
    await audio.start(init());
    lastCtx().close = (): Promise<void> => new Promise<void>(() => undefined);
    const stopped = audio.stop();
    await vi.advanceTimersByTimeAsync(STOP_FADE_MS + 2000);
    await stopped;
    expect(errors).toEqual(['close failed: close timed out after 2000 ms']);
    await audio.start(init());
    expect(ctxs()).toHaveLength(2);
    expect(audio.state.state).toBe('running');
  });

  it('start() after stop() builds a new session', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    await stopAudio();
    await audio.start(init({ route: 'media-element', latencyHint: 'playback' }));
    expect(openCtxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'playback' });
    expect(playing()).toHaveLength(1);
    expect(session.playbackState).toBe('playing');
    expect(liveHandlers()).toBe(4);
    expect(audio.state).toEqual({ state: 'running', route: 'media-element', tier: 'full' });
  });

  it('stop() during a pending start runs after it and leaves nothing', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = audio.start(init({ route: 'direct-anchor' }));
    const stopped = audio.stop();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await started;
    await vi.advanceTimersByTimeAsync(STOP_FADE_MS);
    await stopped;
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(liveHandlers()).toBe(0);
    expect(audio.state.state).toBe('off');
  });
});

// ───────────── worklet messages ─────────────

describe('EngineAudio worklet messages', () => {
  it('state → onSnapshot, error → onError; malformed messages are ignored', async () => {
    await audio.start(init());
    const node = lastNode();
    const buf = stateBuf({ rpm: 900, gear: 1 });
    node.port.emit({ type: 'state', buf });
    node.port.emit({ type: 'error', message: 'engine def rejected' });
    node.port.emit({ type: 'ready' });
    node.port.emit(null);
    node.port.emit({ type: 'state', buf: new Float64Array(3) });
    node.port.emit({ type: 'state', buf: [1, 2, 3] });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toBe(buf);
    expect(errors).toEqual(['engine def rejected']);
  });

  it('messages of a replaced node are ignored', async () => {
    await audio.start(init());
    const old = lastNode();
    const onmessage = old.port.onmessage;
    lastCtx().setState('interrupted');
    await audio.recover();
    onmessage?.({ data: { type: 'state', buf: stateBuf() } });
    expect(snapshots).toHaveLength(0);
  });

  it('a callback that throws does not break the controller', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    audio = new EngineAudio(
      {
        onState: () => {
          throw new Error('ui bug');
        },
        onSnapshot: () => undefined,
        onMediaAction: () => undefined,
        onError: () => undefined,
      },
      { workletUrl: WORKLET_URL },
    );
    await audio.start(init());
    expect(audio.state.state).toBe('running');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('processorerror: reported, the dead graph is closed and the state is error; recover() rebuilds it', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    lastNode().onprocessorerror?.();
    expect(errors).toEqual(['audio worklet failed (processorerror)']);
    expect(audio.state).toEqual({
      state: 'error',
      route: 'direct-anchor',
      tier: null,
      message: 'audio worklet failed (processorerror)',
    });
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(liveHandlers()).toBe(0);
    expect(await audio.recover()).toBe(true);
    expect(openCtxs()).toHaveLength(1);
    expect(audio.state.state).toBe('running');
  });
});

// ───────────── the anchor file in memory (spec §6.1, §12) ─────────────

describe('EngineAudio anchor file', () => {
  it('start loads the anchor file into memory; the anchor element plays it from there', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    expect(fetchCalls).toEqual([ANCHOR_URL]);
    expect(objectUrlBlobs).toEqual([ANCHOR_BLOB]);
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
  });

  it('a recover() rebuild in a tunnel (offline) plays the anchor from memory: no fetch, no error', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    fetchMode = 'fail';
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toHaveLength(1);
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
    expect(errors).toEqual([]);
  });

  it('one object URL per session for every anchor element; stop() revokes it; the next start reuses the file without a fetch', async () => {
    await audio.start(init({ route: 'direct-anchor' }));
    await audio.setRoute('direct');
    await audio.setRoute('direct-anchor');
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
    expect(objectUrlBlobs).toHaveLength(1);
    expect(revokedUrls).toEqual([]);
    await stopAudio();
    expect(revokedUrls).toEqual([ANCHOR_IN_MEMORY]);
    fetchMode = 'fail';
    await audio.start(init({ route: 'direct-anchor' }));
    expect(fetchCalls).toHaveLength(1);
    expect(objectUrlBlobs).toEqual([ANCHOR_BLOB, ANCHOR_BLOB]);
    expect(playing().map((e) => e.src)).toEqual(['blob:anchor-2']);
  });

  it.each(['fail', 'http404'] as const)(
    'an anchor that cannot be loaded (%s) falls back to the file URL without an error; the next start tries again',
    async (mode) => {
      fetchMode = mode;
      await audio.start(init({ route: 'direct-anchor' }));
      expect(playing().map((e) => e.src)).toEqual([ANCHOR_URL]);
      expect(errors).toEqual([]);
      await stopAudio();
      fetchMode = 'ok';
      await audio.start(init({ route: 'direct-anchor' }));
      expect(fetchCalls).toEqual([ANCHOR_URL, ANCHOR_URL]);
      expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
    },
  );

  it('a slow anchor holds the first anchor element back by at most 1 s; once loaded, later ones play it from memory', async () => {
    fetchMode = 'hang';
    const started = audio.start(init({ route: 'direct-anchor' }));
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeAudioElement.instances).toHaveLength(0);
    expect(audio.state.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_URL]);
    expect(audio.state.state).toBe('running');
    releaseFetch();
    await vi.advanceTimersByTimeAsync(0);
    await audio.setRoute('direct');
    await audio.setRoute('direct-anchor');
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
    expect(fetchCalls).toHaveLength(1);
  });

  it('routes without the anchor do not wait for it; a later switch to direct-anchor plays it from memory', async () => {
    fetchMode = 'hang';
    await audio.start(init({ route: 'media-element' }));
    expect(audio.state.state).toBe('running');
    expect(fetchCalls).toEqual([ANCHOR_URL]);
    releaseFetch();
    await vi.advanceTimersByTimeAsync(0);
    await audio.setRoute('direct-anchor');
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
  });

  it('an anchor fetch that never settles is given up after 10 s; the next build fetches again', async () => {
    fetchMode = 'hang';
    await audio.start(init({ route: 'direct' }));
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(fetchCalls).toHaveLength(1); // still on its way: not fetched twice
    await vi.advanceTimersByTimeAsync(10_000);
    fetchMode = 'ok';
    lastCtx().setState('interrupted');
    expect(await audio.recover()).toBe(true);
    expect(fetchCalls).toEqual([ANCHOR_URL, ANCHOR_URL]);
    await vi.advanceTimersByTimeAsync(0);
    await audio.setRoute('direct-anchor');
    expect(playing().map((e) => e.src)).toEqual([ANCHOR_IN_MEMORY]);
  });
});

// ───────────── diagnostics ─────────────

describe('EngineAudio.diagnostics', () => {
  it('context facts, recovery counters and the last benchmark', async () => {
    expect(audio.diagnostics).toEqual({
      contextState: 'none',
      sampleRate: null,
      baseLatencyS: null,
      outputLatencyS: null,
      latencyHint: null,
      recoveries: { resumeOk: 0, resumeFail: 0, recreate: 0 },
      bench: null,
    });
    FakeAudioContext.clock = renderClock((k) => (k >= 8 ? 0.9 : 1));
    await audio.start(init({ tierPref: 'auto', latencyHint: 'playback' }));
    await vi.advanceTimersByTimeAsync(2100);
    const d = audio.diagnostics;
    expect(d).toMatchObject({
      contextState: 'running',
      sampleRate: 48000,
      baseLatencyS: 0.01,
      outputLatencyS: 0.04,
      latencyHint: 'playback',
    });
    expect(d.bench).toEqual({
      headroomK: 4,
      steps: [
        { k: 1, ratio: 1, overloaded: false, busyFrac: null },
        { k: 2, ratio: 1, overloaded: false, busyFrac: null },
        { k: 4, ratio: 1, overloaded: false, busyFrac: null },
        { k: 8, ratio: 0.9, overloaded: true, busyFrac: null },
      ],
    });
  });
});
