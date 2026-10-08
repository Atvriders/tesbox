import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioProbe } from '../../src/probe/audio';
import { EventLog } from '../../src/probe/log';
import type { ProbeToWorklet, WorkletToProbe } from '../../src/probe/audio-protocol';

// ───────────── fakes (minimal Web Audio / DOM surface AudioProbe touches) ─────────────

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
  readonly stream = { id: 'probe-stream' };
}

type ResumeMode = 'ok' | 'hang' | 'reject';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** When set, addModule() waits for it (simulates a slow module fetch). */
  static moduleGate: Promise<void> | null = null;
  state: AudioContextState = 'running';
  readonly sampleRate = 48000;
  readonly baseLatency = 0.01;
  readonly outputLatency = 0.04;
  currentTime = 0;
  readonly destination = new FakeNode();
  onstatechange: (() => void) | null = null;
  readonly modules: string[] = [];
  readonly streamDestinations: FakeStreamDestination[] = [];
  resumeMode: ResumeMode = 'ok';
  addModuleFails = false;
  closeCalls = 0;
  readonly audioWorklet = {
    addModule: (url: string): Promise<void> => {
      this.modules.push(url);
      if (this.addModuleFails) return Promise.reject(new Error('404'));
      return FakeAudioContext.moduleGate ?? Promise.resolve();
    },
  };
  constructor(readonly options: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamDestination(): FakeStreamDestination {
    const d = new FakeStreamDestination();
    this.streamDestinations.push(d);
    return d;
  }
  getOutputTimestamp(): AudioTimestamp {
    return { contextTime: this.currentTime, performanceTime: performance.now() };
  }
  resume(): Promise<void> {
    if (this.resumeMode === 'hang') return new Promise(() => undefined);
    if (this.resumeMode === 'reject') return Promise.reject(new Error('InvalidStateError'));
    this.setState('running');
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.setState('closed');
    return Promise.resolve();
  }
  setState(s: AudioContextState): void {
    this.state = s;
    this.onstatechange?.();
  }
}

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly sent: ProbeToWorklet[] = [];
  postMessage(m: ProbeToWorklet): void {
    this.sent.push(m);
  }
  emit(m: WorkletToProbe): void {
    this.onmessage?.({ data: m });
  }
}

class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  readonly port = new FakePort();
  onprocessorerror: (() => void) | null = null;
  constructor(
    readonly ctx: FakeAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super();
    FakeWorkletNode.instances.push(this);
  }
  lastK(): number | undefined {
    return this.port.sent.filter((m) => m.type === 'config').at(-1)?.k;
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
  setActionHandler(action: string, handler: (() => void) | null): void {
    this.handlers.set(action, handler);
  }
}

class FakeMediaMetadata {
  constructor(readonly init: MediaMetadataInit) {}
}

class FakeDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  createElement(tag: string): FakeAudioElement {
    if (tag !== 'audio') throw new Error(`unexpected element ${tag}`);
    return new FakeAudioElement();
  }
  setVisibility(v: DocumentVisibilityState): void {
    this.visibilityState = v;
    for (const fn of this.listeners.get('visibilitychange') ?? []) fn();
  }
}

// ───────────── harness ─────────────

const WORKLET_URL = '/assets/audio-worklet.js';
const ANCHOR_URL = '/probe/anchor.wav';
let log: EventLog;
let probe: AudioProbe;
let session: FakeMediaSession;
let doc: FakeDocument;

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
const details = (kind: string): string[] => log.entries().filter((e) => e.kind === kind).map((e) => e.detail);
const listening = (): number => doc.listeners.get('visibilitychange')?.size ?? 0;
const liveHandlers = (): number => [...session.handlers.values()].filter((h) => typeof h === 'function').length;

/** Applies `patch` to every AudioContext constructed from now on (e.g. a failing addModule). */
const patchNewContexts = (patch: (c: FakeAudioContext) => void): void => {
  vi.stubGlobal(
    'AudioContext',
    class extends FakeAudioContext {
      constructor(o: AudioContextOptions) {
        super(o);
        patch(this);
      }
    },
  );
};
/** No MediaStreamAudioDestinationNode (the browser lacks MediaStream): the media-element route cannot connect. */
const withoutMediaStream = (c: FakeAudioContext): void => {
  (c as unknown as { createMediaStreamDestination: unknown }).createMediaStreamDestination = undefined;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.moduleGate = null;
  FakeWorkletNode.instances = [];
  FakeAudioElement.instances = [];
  session = new FakeMediaSession();
  doc = new FakeDocument();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('MediaMetadata', FakeMediaMetadata);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { mediaSession: session });
  log = new EventLog();
  probe = new AudioProbe(log, WORKLET_URL, ANCHOR_URL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────── tests ─────────────

describe('AudioProbe.start', () => {
  it('builds one context, adds the module, creates the node with the contract options and sends config', async () => {
    await probe.start('direct', 'balanced');
    expect(ctxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'balanced' });
    expect(lastCtx().modules).toEqual([WORKLET_URL]);
    const node = lastNode();
    expect(node.name).toBe('tesbox-probe');
    expect(node.options).toEqual({ numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    expect(node.port.sent[0]).toEqual({ type: 'config', k: 1, toneHz: 55, gainDb: -18 });
    expect(node.connections).toEqual([lastCtx().destination]);
    expect(FakeAudioElement.instances).toHaveLength(0);
    expect(probe.snapshot).toMatchObject({
      state: 'running',
      sampleRate: 48000,
      baseLatency: 0.01,
      outputLatency: 0.04,
      latencyHint: 'balanced',
      route: 'direct',
      perfInWorklet: null,
      quanta: 0,
      recoveries: { resumeOk: 0, resumeFail: 0, recreate: 0 },
    });
    expect(details('audio')).toEqual(expect.arrayContaining(['context running sr=48000 hint=balanced', 'route direct']));
  });

  it('registers the Media Session with metadata, playing state and all 7 handlers', async () => {
    await probe.start('direct', 'balanced');
    expect((session.metadata as FakeMediaMetadata).init).toEqual({ title: 'Tesbox probe', artist: 'Tesbox' });
    expect(session.playbackState).toBe('playing');
    expect([...session.handlers.keys()].sort()).toEqual(
      ['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'stop'],
    );
    session.handlers.get('nexttrack')?.();
    session.handlers.get('pause')?.();
    expect(details('mediasession')).toEqual(['nexttrack', 'pause']);
  });

  it('media-element route: node → MediaStreamDestination → <audio>.srcObject, playing', async () => {
    await probe.start('media-element', 'playback');
    const ctx = lastCtx();
    expect(ctx.options).toEqual({ latencyHint: 'playback' });
    const msd = ctx.streamDestinations[0];
    expect(lastNode().connections).toEqual([msd]);
    const [el] = FakeAudioElement.instances;
    expect(el?.srcObject).toBe(msd?.stream);
    expect(el?.paused).toBe(false);
    expect(session.playbackState).toBe('playing');
    expect(details('audio')).toContain('media-element element playing');
  });

  it('direct-anchor route: node → destination plus a looping anchor <audio>', async () => {
    await probe.start('direct-anchor', 'balanced');
    expect(lastNode().connections).toEqual([lastCtx().destination]);
    const [el] = FakeAudioElement.instances;
    expect(el?.src).toBe(ANCHOR_URL);
    expect(el?.loop).toBe(true);
    expect(el?.paused).toBe(false);
    expect(details('audio')).toContain('direct-anchor element playing');
  });

  it('resumes a context that starts suspended', async () => {
    patchNewContexts((c) => {
      c.state = 'suspended';
    });
    await probe.start('direct', 'balanced');
    expect(probe.snapshot.state).toBe('running');
    expect(details('audio')).toEqual(
      expect.arrayContaining(['context suspended sr=48000 hint=balanced', 'initial resume ok state=running']),
    );
  });

  it('rejects and leaves no context (and no visibility listener) when addModule fails', async () => {
    patchNewContexts((c) => {
      c.addModuleFails = true;
    });
    await expect(probe.start('direct', 'balanced')).rejects.toThrow('404');
    expect(probe.snapshot.state).toBe('none');
    expect(lastCtx().state).toBe('closed');
    expect(details('error').some((d) => d.startsWith('worklet setup failed'))).toBe(true);
    expect(listening()).toBe(0);
  });

  it('rejects and leaves no context when the processor cannot be constructed', async () => {
    vi.stubGlobal(
      'AudioWorkletNode',
      class {
        constructor() {
          throw new DOMException("processor 'tesbox-probe' is not registered", 'InvalidStateError');
        }
      },
    );
    await expect(probe.start('direct', 'balanced')).rejects.toThrow('not registered');
    expect(probe.snapshot.state).toBe('none');
    expect(lastCtx().state).toBe('closed');
    await probe.start('direct', 'balanced').catch(() => undefined); // a retry builds a fresh context
    expect(ctxs()).toHaveLength(2);
  });

  it('media-element without MediaStreamAudioDestinationNode rejects and leaves no context', async () => {
    patchNewContexts(withoutMediaStream);
    await expect(probe.start('media-element', 'balanced')).rejects.toThrow('media-element route unsupported');
    expect(probe.snapshot.state).toBe('none');
    expect(lastCtx().state).toBe('closed');
    expect(openCtxs()).toHaveLength(0);
    expect(session.handlers.size).toBe(0); // the Media Session was never registered
    expect(listening()).toBe(0);
  });

  it('a start whose addModule never settles rejects after 10 s and does not block later ops', async () => {
    FakeAudioContext.moduleGate = new Promise<void>(() => undefined);
    const started = probe.start('direct', 'balanced');
    let settled = false;
    void started.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false); // still waiting for the module 1 ms before the limit
    await vi.advanceTimersByTimeAsync(1);
    await expect(started).rejects.toThrow(/^addModule timed out after 10000 ms$/);
    expect(details('error')).toContain('worklet setup failed: addModule timed out after 10000 ms');
    expect(probe.snapshot.state).toBe('none');
    expect(openCtxs()).toHaveLength(0);
    await probe.stop();
  });

  it('creates the context synchronously when no operation is pending (still inside the click)', async () => {
    const started = probe.start('direct', 'balanced');
    expect(ctxs()).toHaveLength(1); // no microtask has run yet
    await started;
    const recreated = probe.recreate();
    expect(ctxs()).toHaveLength(2);
    await recreated;
  });

  it('pings the new node once and logs the pong round trip', async () => {
    vi.advanceTimersByTime(1000); // the ping is not sent at performance.now() = 0
    await probe.start('direct', 'balanced');
    const node = lastNode();
    expect(node.port.sent.filter((m) => m.type === 'ping')).toEqual([{ type: 'ping', id: 1 }]);
    vi.advanceTimersByTime(12);
    node.port.emit({ type: 'pong', id: 2, currentTime: 0.25 }); // not the id this node was pinged with
    expect(details('audio').filter((d) => d.startsWith('pong'))).toEqual([]);
    node.port.emit({ type: 'pong', id: 1, currentTime: 0.5 });
    expect(details('audio').filter((d) => d.startsWith('pong'))).toEqual(['pong rtt=12ms ctxTime=0.500']);
  });
});

describe('AudioProbe single-instance guarantees (RF3)', () => {
  it('start() twice concurrently creates exactly one AudioContext and one node', async () => {
    await Promise.all([probe.start('direct-anchor', 'balanced'), probe.start('direct-anchor', 'balanced')]);
    expect(ctxs()).toHaveLength(1);
    expect(FakeWorkletNode.instances).toHaveLength(1);
    expect(playing()).toHaveLength(1);
  });

  it('start() again with the same hint reuses the context (only the route may change)', async () => {
    await probe.start('direct', 'balanced');
    await probe.start('media-element', 'balanced');
    expect(ctxs()).toHaveLength(1);
    expect(probe.snapshot.route).toBe('media-element');
    expect(playing()).toHaveLength(1);
  });

  it('start() with a different latencyHint replaces the context: one open context at a time', async () => {
    await probe.start('direct', 'balanced');
    await probe.start('direct', 'playback');
    expect(ctxs()).toHaveLength(2);
    expect(ctxs()[0]?.state).toBe('closed');
    expect(openCtxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'playback' });
    expect(probe.snapshot.latencyHint).toBe('playback');
    expect(probe.snapshot.recoveries.recreate).toBe(0);
  });

  it('a latencyHint switch whose rebuild fails leaves no context, playing element, Media Session or listener', async () => {
    await probe.start('media-element', 'balanced');
    patchNewContexts(withoutMediaStream);
    await expect(probe.start('media-element', 'playback')).rejects.toThrow('media-element route unsupported');
    expect(probe.snapshot).toMatchObject({ state: 'none', route: null });
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();
    expect(liveHandlers()).toBe(0);
    expect(listening()).toBe(0);
  });

  it('setRoute() called rapidly 3× ends with exactly one connected route and one playing element', async () => {
    await probe.start('direct', 'balanced');
    await Promise.all([
      probe.setRoute('media-element'),
      probe.setRoute('direct-anchor'),
      probe.setRoute('media-element'),
    ]);
    expect(ctxs()).toHaveLength(1);
    const node = lastNode();
    expect(node.connections).toHaveLength(1);
    expect(node.connections[0]).toBe(lastCtx().streamDestinations.at(-1));
    expect(playing()).toHaveLength(1);
    expect(playing()[0]?.srcObject).toBe(lastCtx().streamDestinations.at(-1)?.stream);
    for (const el of FakeAudioElement.instances.slice(0, -1)) {
      expect(el.paused).toBe(true);
      expect(el.loadCalls).toBe(1); // load() releases the old element's media resource
      expect(el.srcObject).toBeNull();
      expect(el.src).toBe('');
    }
    expect(probe.snapshot.route).toBe('media-element');
    expect(details('audio').filter((d) => d.startsWith('route '))).toEqual([
      'route direct',
      'route media-element',
      'route direct-anchor',
      'route media-element',
    ]);
  });

  it('setRoute() during a pending start() is applied after start completes', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = probe.start('direct', 'balanced');
    const routed = probe.setRoute('media-element');
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([started, routed]);
    expect(probe.snapshot.route).toBe('media-element');
    expect(lastNode().connections).toEqual([lastCtx().streamDestinations[0]]);
    expect(playing()).toHaveLength(1);
  });

  it('recreate() during a pending start() never leaves a second graph connected', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = probe.start('direct-anchor', 'balanced');
    const recreated = probe.recreate();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([started, recreated]);
    // It ran after start had finished, so it found the context and rebuilt it (a recreate run
    // mid-build would have found no connected route yet and done nothing).
    expect(probe.snapshot.recoveries.recreate).toBe(1);
    expect(ctxs()).toHaveLength(2);
    expect(openCtxs()).toHaveLength(1);
    const current = lastNode();
    expect(current.ctx).toBe(openCtxs()[0]);
    for (const n of FakeWorkletNode.instances) if (n !== current) expect(n.connections).toEqual([]);
    expect(playing()).toHaveLength(1);
  });

  it('stop() during a pending start() runs after it: no context, element, Media Session or listener is left', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = probe.start('direct-anchor', 'balanced');
    const stopped = probe.stop();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([started, stopped]);
    expect(probe.snapshot).toMatchObject({ state: 'none', route: null });
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect(liveHandlers()).toBe(0);
    expect(listening()).toBe(0);
    expect(details('audio').at(-1)).toBe('stopped');
  });

  it('resume() during a pending start() runs after start completes', async () => {
    let release = (): void => undefined;
    FakeAudioContext.moduleGate = new Promise<void>((r) => (release = r));
    const started = probe.start('direct-anchor', 'balanced');
    const resumed = probe.resume();
    await vi.advanceTimersByTimeAsync(0);
    release();
    const [, ok] = await Promise.all([started, resumed]);
    expect(ok).toBe(true);
    expect(probe.snapshot.recoveries).toEqual({ resumeOk: 1, resumeFail: 0, recreate: 0 });
    expect(details('audio').filter((d) => d.startsWith('route ') || d.startsWith('resume '))).toEqual([
      'route direct-anchor',
      'resume ok state=running',
    ]);
  });

  it('switching to direct stops every media element', async () => {
    await probe.start('direct-anchor', 'balanced');
    await probe.setRoute('direct');
    expect(playing()).toHaveLength(0);
    expect(lastNode().connections).toEqual([lastCtx().destination]);
  });

  it('our own route switch does not log an element pause; an external pause does', async () => {
    await probe.start('direct-anchor', 'balanced');
    await probe.setRoute('media-element');
    expect(details('audio').some((d) => d.endsWith('element paused'))).toBe(false);
    FakeAudioElement.instances.at(-1)?.pause();
    expect(details('audio')).toContain('media-element element paused');
  });

  it('setRoute() before start only logs a note and changes nothing', async () => {
    await probe.setRoute('media-element');
    expect(ctxs()).toHaveLength(0);
    expect(FakeAudioElement.instances).toHaveLength(0);
    expect(probe.snapshot.route).toBeNull();
    expect(details('note')).toEqual(['route media-element ignored: audio not started (start() takes its own route)']);
    await probe.start('direct', 'balanced');
    expect(probe.snapshot.route).toBe('direct'); // start() connects its own route
  });

  it('start() after stop() rebuilds context, route, Media Session and the visibility listener', async () => {
    await probe.start('direct-anchor', 'balanced');
    await probe.stop();
    await probe.start('media-element', 'playback');
    expect(ctxs()).toHaveLength(2);
    expect(openCtxs()).toHaveLength(1);
    expect(lastCtx().options).toEqual({ latencyHint: 'playback' });
    expect(lastNode().connections).toEqual([lastCtx().streamDestinations[0]]);
    expect(playing()).toHaveLength(1);
    expect(session.playbackState).toBe('playing');
    expect([...session.handlers.values()].every((h) => typeof h === 'function')).toBe(true);
    expect(doc.listeners.get('visibilitychange')?.size).toBe(1);
    expect(probe.snapshot).toMatchObject({ state: 'running', route: 'media-element', latencyHint: 'playback' });
  });
});

describe('AudioProbe worklet reports and state changes', () => {
  it('reflects the latest worklet report in the snapshot and in lastWorkletReport', async () => {
    await probe.start('direct', 'balanced');
    expect(probe.lastWorkletReport).toBeNull();
    lastNode().port.emit({
      type: 'report', quanta: 94, perfInWorklet: false, busyMs: 20, windowMs: 250, sampleRate: 48000, currentTime: 0.25,
    });
    expect(probe.snapshot.quanta).toBe(94);
    expect(probe.snapshot.perfInWorklet).toBe(false);
    expect(probe.lastWorkletReport).toMatchObject({ quanta: 94, busyMs: 20, windowMs: 250, currentTime: 0.25 });
    await probe.stop();
    expect(probe.lastWorkletReport).toBeNull();
  });

  it("logs statechange as log('audio', state)", async () => {
    await probe.start('direct', 'balanced');
    lastCtx().setState('interrupted');
    lastCtx().setState('suspended');
    expect(details('audio')).toEqual(expect.arrayContaining(['interrupted', 'suspended']));
  });

  it('setK posts a config message', async () => {
    await probe.start('direct', 'balanced');
    probe.setK(8);
    expect(lastNode().port.sent.at(-1)).toEqual({ type: 'config', k: 8, toneHz: 55, gainDb: -18 });
  });

  it('setTone posts a config message, and a rebuilt node gets the same tone', async () => {
    await probe.start('direct', 'balanced');
    probe.setTone(110);
    expect(lastNode().port.sent.at(-1)).toEqual({ type: 'config', k: 1, toneHz: 110, gainDb: -18 });
    await probe.recreate();
    expect(lastNode().port.sent[0]).toEqual({ type: 'config', k: 1, toneHz: 110, gainDb: -18 });
  });
});

describe('AudioProbe recovery', () => {
  it('resume() succeeds when the context reaches running', async () => {
    await probe.start('direct-anchor', 'balanced');
    lastCtx().setState('suspended');
    FakeAudioElement.instances[0]?.pause();
    expect(await probe.resume()).toBe(true);
    expect(probe.snapshot.recoveries).toEqual({ resumeOk: 1, resumeFail: 0, recreate: 0 });
    expect(FakeAudioElement.instances[0]?.paused).toBe(false); // route element restarted after the resume check
    expect(FakeAudioElement.instances[0]?.playCalls).toBe(2); // once at start, once by resume()
    expect(details('audio')).toContain('resume ok state=running');
  });

  it('resume() leaves a route element that is still playing alone', async () => {
    await probe.start('direct-anchor', 'balanced');
    lastCtx().setState('suspended');
    expect(await probe.resume()).toBe(true);
    expect(FakeAudioElement.instances).toHaveLength(1);
    expect(FakeAudioElement.instances[0]?.playCalls).toBe(1); // only the play() from start
  });

  it('resume() reports failure after 500 ms when the context is interrupted (promise never settles)', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().setState('interrupted');
    lastCtx().resumeMode = 'hang';
    const p = probe.resume();
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(false);
    expect(probe.snapshot.recoveries.resumeFail).toBe(1);
  });

  it('resume() reports failure when resume() fulfils but the context stays interrupted', async () => {
    await probe.start('direct', 'balanced');
    const ctx = lastCtx();
    ctx.setState('interrupted');
    ctx.resume = (): Promise<void> => Promise.resolve(); // fulfils without leaving 'interrupted'
    expect(await probe.resume()).toBe(false);
    expect(probe.snapshot.recoveries).toEqual({ resumeOk: 0, resumeFail: 1, recreate: 0 });
    expect(details('audio')).toContain('resume failed state=interrupted');
  });

  it('stop() abandons a close() that never settles after 2 s, and later operations still run', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().close = (): Promise<void> => new Promise<void>(() => undefined);
    const stopped = probe.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await stopped;
    expect(details('error')).toContain('close failed: close timed out after 2000 ms');
    await probe.start('direct', 'balanced');
    expect(ctxs()).toHaveLength(2);
    expect(probe.snapshot.state).toBe('running');
  });

  it('resume() reports failure when resume() rejects', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().setState('suspended');
    lastCtx().resumeMode = 'reject';
    expect(await probe.resume()).toBe(false);
    expect(probe.snapshot.recoveries.resumeFail).toBe(1);
  });

  it('recreate() closes the old context and rebuilds module, node, route and session', async () => {
    await probe.start('media-element', 'playback');
    const old = lastCtx();
    const oldEl = FakeAudioElement.instances[0];
    session.handlers.clear();
    await probe.recreate();
    expect(ctxs()).toHaveLength(2);
    expect(old.state).toBe('closed');
    expect(old.closeCalls).toBe(1);
    expect(openCtxs()).toHaveLength(1);
    const ctx = lastCtx();
    expect(ctx.options).toEqual({ latencyHint: 'playback' });
    expect(ctx.modules).toEqual([WORKLET_URL]);
    expect(FakeWorkletNode.instances).toHaveLength(2);
    expect(lastNode().connections).toEqual([ctx.streamDestinations[0]]);
    expect(oldEl?.paused).toBe(true);
    expect(playing()).toHaveLength(1);
    expect(session.handlers.size).toBe(7);
    expect(probe.snapshot.recoveries.recreate).toBe(1);
    expect(probe.snapshot.route).toBe('media-element');
    expect(details('audio')).toContain('recreate');
    expect(listening()).toBe(1);
    const before = log.count('audio');
    old.setState('suspended'); // stale context: ignored
    expect(log.count('audio')).toBe(before);
  });

  it('a recreate() whose rebuild fails leaves no Media Session or visibility listener; Start restores both', async () => {
    await probe.start('direct-anchor', 'balanced');
    patchNewContexts((c) => {
      c.addModuleFails = true;
    });
    await expect(probe.recreate()).rejects.toThrow('404');
    expect(probe.snapshot).toMatchObject({ state: 'none', route: null });
    expect(openCtxs()).toHaveLength(0);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();
    expect(liveHandlers()).toBe(0);
    expect(listening()).toBe(0);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await probe.start('direct-anchor', 'balanced');
    expect(session.playbackState).toBe('playing');
    expect(liveHandlers()).toBe(7);
    expect(listening()).toBe(1);
  });

  it('recreate() after rejected route switches rebuilds the route that is still connected', async () => {
    patchNewContexts(withoutMediaStream); // e.g. a car browser without MediaStream (detect.ts: mediaStreamDestination)
    await probe.start('direct-anchor', 'balanced');
    await expect(probe.setRoute('media-element')).rejects.toThrow('media-element route unsupported');
    await expect(probe.start('media-element', 'balanced')).rejects.toThrow('media-element route unsupported');
    expect(probe.snapshot.route).toBe('direct-anchor'); // the failed switches left the anchor route playing
    await probe.recreate();
    expect(probe.snapshot).toMatchObject({ state: 'running', route: 'direct-anchor' });
    expect(openCtxs()).toHaveLength(1);
    expect(playing()).toHaveLength(1);
    expect(playing()[0]?.src).toBe(ANCHOR_URL);
    expect(session.playbackState).toBe('playing');
  });

  it('recreate() before any start does nothing', async () => {
    await probe.recreate();
    expect(ctxs()).toHaveLength(0);
    expect(probe.snapshot.recoveries.recreate).toBe(0);
    expect(details('audio')).toEqual(['recreate: no context (not started or stopped)']);
  });

  it('recreate() after setRoute-before-start or after stop() does nothing', async () => {
    await probe.setRoute('media-element');
    await probe.recreate();
    expect(ctxs()).toHaveLength(0);
    await probe.start('direct', 'balanced');
    await probe.stop();
    await probe.recreate();
    expect(ctxs()).toHaveLength(1);
    expect(openCtxs()).toHaveLength(0);
    expect(probe.snapshot.recoveries.recreate).toBe(0);
  });

  it('stop() closes the context, stops elements and clears the Media Session', async () => {
    await probe.start('direct-anchor', 'balanced');
    await probe.stop();
    expect(lastCtx().state).toBe('closed');
    expect(lastCtx().closeCalls).toBe(1);
    expect(playing()).toHaveLength(0);
    expect(session.playbackState).toBe('none');
    expect([...session.handlers.values()].every((h) => h === null)).toBe(true);
    expect(probe.snapshot).toMatchObject({ state: 'none', route: null });
    expect(doc.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
    expect(details('audio').at(-1)).toBe('stopped');
  });
});

describe('AudioProbe hidden clock', () => {
  it('is null until a hidden period ends, then audio-clock / wall-clock over that period', async () => {
    await probe.start('direct', 'balanced');
    expect(probe.hiddenClockRatio).toBeNull();
    const ctx = lastCtx();
    ctx.currentTime = 10;
    doc.setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    ctx.currentTime = 15; // audio advanced only 5 s in 10 s of wall time
    doc.setVisibility('visible');
    expect(probe.hiddenClockRatio).toBe(0.5);
    expect(details('audio').filter((d) => d.startsWith('hidden '))).toEqual(['hidden 10.0s clock ratio=0.5 state=running']);
  });

  it('ignores a hidden period that spans a context recreation', async () => {
    await probe.start('direct', 'balanced');
    doc.setVisibility('hidden');
    await probe.recreate();
    vi.advanceTimersByTime(1000);
    doc.setVisibility('visible');
    expect(probe.hiddenClockRatio).toBeNull();
    expect(details('audio').some((d) => d.startsWith('hidden '))).toBe(false); // the line comes only with a ratio
  });
});

describe('AudioProbe.benchmark', () => {
  /**
   * Simulates the audio thread: every 10 ms of fake wall time the context clock advances by
   * 10 ms × rate(k), and every 250 ms the node posts a busy report. k comes from the last config.
   * A context that is not running renders nothing.
   */
  function simulateAudio(rate: (k: number) => number, busyFrac: (k: number) => number): void {
    let quanta = 0;
    let sinceReport = 0;
    setInterval(() => {
      const ctx = lastCtx();
      if (ctx.state !== 'running') return;
      const node = lastNode();
      const k = node.lastK() ?? 1;
      ctx.currentTime += 0.01 * rate(k);
      sinceReport += 10;
      quanta += 4;
      if (sinceReport >= 250) {
        sinceReport = 0;
        node.port.emit({
          type: 'report', quanta, perfInWorklet: false, busyMs: 250 * busyFrac(k), windowMs: 250,
          sampleRate: 48000, currentTime: ctx.currentTime,
        });
      }
    }, 10);
  }

  it('finds headroomK = largest k below the first overloaded one and restores k', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio((k) => (k >= 8 ? 0.9 : 1), (k) => Math.min(1, 0.1 * k));
    const p = probe.benchmark();
    await vi.advanceTimersByTimeAsync(5 * 3250 + 100);
    const { results, headroomK } = await p;
    expect(results.map((r) => r.k)).toEqual([1, 2, 4, 8, 16]);
    expect(results.map((r) => r.overloaded)).toEqual([false, false, false, true, true]);
    expect(results[0]?.ratio).toBeCloseTo(1, 2);
    expect(results[3]?.ratio).toBeCloseTo(0.9, 2);
    expect(results[1]?.busyFrac).toBeCloseTo(0.2, 2);
    expect(headroomK).toBe(4);
    expect(lastNode().lastK()).toBe(1);
    const ks = lastNode().port.sent.filter((m) => m.type === 'config').map((m) => m.k);
    expect(ks).toEqual([1, 1, 2, 4, 8, 16, 1]);
    expect(details('audio').filter((d) => d.startsWith('bench '))).toEqual([
      'bench k=1 ratio=1 overloaded=false busy=0.1',
      'bench k=2 ratio=1 overloaded=false busy=0.2',
      'bench k=4 ratio=1 overloaded=false busy=0.4',
      'bench k=8 ratio=0.9 overloaded=true busy=0.8',
      'bench k=16 ratio=0.9 overloaded=true busy=1',
      'bench headroomK=4',
    ]);
  });

  it('measures getOutputTimestamp() pairs, not currentTime or the moment of sampling', async () => {
    await probe.start('direct', 'balanced');
    const ctx = lastCtx();
    ctx.currentTime = 1; // frozen: only the output timestamp advances
    let calls = 0;
    ctx.getOutputTimestamp = (): AudioTimestamp => {
      // Each pair describes a render callback 40 ms before the call (only the first one is fresh),
      // and its contextTime keeps exact pace with its performanceTime: a clock that keeps up.
      const performanceTime = performance.now() - (calls++ === 0 ? 0 : 40);
      return { contextTime: 1 + performanceTime / 1000, performanceTime };
    };
    const p = probe.benchmark([1], 1);
    await vi.advanceTimersByTimeAsync(1350);
    const { results } = await p;
    expect(results).toEqual([{ k: 1, ratio: 1, overloaded: false, busyFrac: null }]); // no report: busy n/a
    expect(details('audio')).toContain('bench k=1 ratio=1 overloaded=false busy=n/a');
  });

  it.each([
    [
      'performanceTime is 0: performance.now() stands in',
      (c: FakeAudioContext): void => {
        c.getOutputTimestamp = (): AudioTimestamp => ({ contextTime: c.currentTime, performanceTime: 0 });
      },
    ],
    [
      'getOutputTimestamp() is missing: currentTime + performance.now()',
      (c: FakeAudioContext): void => {
        (c as unknown as { getOutputTimestamp: unknown }).getOutputTimestamp = undefined;
      },
    ],
  ])('clock fallback when %s', async (_case, patch) => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    patch(lastCtx());
    simulateAudio(() => 1, () => 0.1);
    const p = probe.benchmark([1], 1);
    await vi.advanceTimersByTimeAsync(1350);
    const { results } = await p;
    expect(results[0]).toMatchObject({ ratio: 1, overloaded: false });
  });

  /** Output timestamps whose audio clock runs at rates[i] × wall time during the i-th second after the first call. */
  function clockAtRates(ctx: FakeAudioContext, rates: readonly number[]): void {
    let origin: number | null = null;
    ctx.getOutputTimestamp = (): AudioTimestamp => {
      const now = performance.now();
      origin ??= now;
      let leftS = (now - origin) / 1000;
      let contextTime = 1;
      for (const rate of rates) {
        const s = Math.min(1, leftS);
        contextTime += rate * s;
        leftS -= s;
      }
      return { contextTime, performanceTime: now };
    };
  }

  it.each([
    { rates: [0.9, 1.0, 0.9], ratio: 0.933, overloaded: false }, // slow windows, never two in a row
    { rates: [0.97, 0.97, 1.06], ratio: 1, overloaded: true }, // two slow windows in a row; whole span on time
    { rates: [0.97, 0.985], ratio: 0.978, overloaded: false }, // exactly 2 windows decide; the whole span alone says overloaded
  ])(
    'with ≥ 2 drift windows DriftMonitor decides, not the whole-span ratio: windows $rates → $overloaded',
    async ({ rates, ratio, overloaded }) => {
      await probe.start('direct', 'balanced');
      clockAtRates(lastCtx(), rates);
      const p = probe.benchmark([1], rates.length); // one 1 s drift window per rate
      await vi.advanceTimersByTimeAsync(rates.length * 1000 + 350);
      const { results } = await p;
      expect(results[0]).toMatchObject({ k: 1, ratio, overloaded });
    },
  );

  it('headroomK is 0 when k = 1 is already overloaded', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 0.9, () => 1);
    const p = probe.benchmark([1, 2], 3);
    await vi.advanceTimersByTimeAsync(2 * 3250 + 100);
    const { results, headroomK } = await p;
    expect(results.every((r) => r.overloaded)).toBe(true);
    expect(headroomK).toBe(0);
  });

  it('quick bench ([1,2] × 1 s) completes with 2 results using the whole-span ratio', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.05);
    const p = probe.benchmark([1, 2], 1);
    await vi.advanceTimersByTimeAsync(2 * 1250 + 100);
    const { results, headroomK } = await p;
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.overloaded)).toBe(true);
    expect(headroomK).toBe(2);
  });

  it('a step too short for 2 drift windows is judged by the whole-span ratio', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio((k) => (k >= 2 ? 0.9 : 1), () => 0.1);
    const p = probe.benchmark([1, 2], 1);
    await vi.advanceTimersByTimeAsync(2 * 1250 + 100);
    const { results, headroomK } = await p;
    expect(results.map((r) => r.overloaded)).toEqual([false, true]);
    expect(headroomK).toBe(1);
  });

  it('headroomK stops at the first overloaded k even if a larger k passes', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio((k) => (k === 2 ? 0.9 : 1), () => 0.1);
    const p = probe.benchmark([1, 2, 4], 3);
    await vi.advanceTimersByTimeAsync(3 * 3250 + 100);
    const { results, headroomK } = await p;
    expect(results.map((r) => r.overloaded)).toEqual([false, true, false]);
    expect(headroomK).toBe(1);
  });

  it('headroomK ranks results by k when ks are benchmarked out of order', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio((k) => (k >= 4 ? 0.9 : 1), () => 0.1);
    const p = probe.benchmark([4, 1, 2], 1);
    await vi.advanceTimersByTimeAsync(3 * 1250 + 100);
    const { results, headroomK } = await p;
    expect(results.map((r) => [r.k, r.overloaded])).toEqual([
      [4, true],
      [1, false],
      [2, false],
    ]); // results stay in run order
    expect(headroomK).toBe(2);
  });

  it.each([
    { ks: [1], secondsEach: NaN, error: 'secondsEach must be a finite number > 0, got NaN' },
    { ks: [1], secondsEach: Infinity, error: 'secondsEach must be a finite number > 0, got Infinity' },
    { ks: [1], secondsEach: 0, error: 'secondsEach must be a finite number > 0, got 0' },
    { ks: [1], secondsEach: -1, error: 'secondsEach must be a finite number > 0, got -1' },
    { ks: [], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got []' },
    { ks: [1, NaN], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got [1, NaN]' },
    { ks: [1, Infinity], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got [1, Infinity]' },
    { ks: [0, 1], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got [0, 1]' },
    { ks: [-2], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got [-2]' },
    { ks: [1, 2.5], secondsEach: 1, error: 'ks must be a non-empty list of integers >= 1, got [1, 2.5]' },
  ])('rejects benchmark($ks, $secondsEach) with a RangeError before measuring anything', async ({ ks, secondsEach, error }) => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.1);
    const node = lastNode();
    const sent = node.port.sent.length;
    let outcome: unknown = 'pending';
    void probe.benchmark(ks, secondsEach).then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeInstanceOf(RangeError);
    expect(String(outcome)).toBe(`RangeError: benchmark ${error}`);
    expect(node.port.sent).toHaveLength(sent); // no k was posted to the worklet
    const p = probe.benchmark([1], 1); // and nothing stayed latched
    await vi.advanceTimersByTimeAsync(1350);
    await expect(p).resolves.toMatchObject({ headroomK: 1 });
  });

  it('rejects when audio is not running, or when a benchmark is already running', async () => {
    await expect(probe.benchmark()).rejects.toThrow('audio is not running');
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.1);
    const p = probe.benchmark([1], 1);
    await expect(probe.benchmark([1], 1)).rejects.toThrow('already running');
    await vi.advanceTimersByTimeAsync(1350);
    await expect(p).resolves.toMatchObject({ headroomK: 1 });
  });

  it('rejects up front when the context is suspended or interrupted', async () => {
    await probe.start('direct', 'balanced');
    const node = lastNode();
    const sent = node.port.sent.length;
    for (const state of ['suspended', 'interrupted'] as const) {
      lastCtx().setState(state);
      const rejected = expect(probe.benchmark([1], 1)).rejects.toThrow('audio is not running');
      await vi.advanceTimersByTimeAsync(1350);
      await rejected;
    }
    expect(node.port.sent).toHaveLength(sent); // no k was ever posted to the worklet
  });

  it('rejects when the context stops running mid-benchmark, and restores k', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.1);
    const p = probe.benchmark([1, 2, 4], 3);
    const rejected = expect(p).rejects.toThrow('audio is not running');
    await vi.advanceTimersByTimeAsync(4000); // inside the k = 2 step
    expect(lastNode().lastK()).toBe(2);
    lastCtx().setState('suspended');
    await vi.advanceTimersByTimeAsync(3 * 3250); // long enough for the rest of the run to settle either way
    await rejected;
    expect(lastNode().lastK()).toBe(1);
    expect(details('audio').filter((d) => d.startsWith('bench '))).toEqual([
      'bench k=1 ratio=1 overloaded=false busy=0.1', // no result for the cut-short step, no headroom line
    ]);
  });

  it.each([
    { what: 'only zeros', ts: (): AudioTimestamp => ({ contextTime: 0, performanceTime: 0 }) },
    { what: 'one frozen pair', ts: (): AudioTimestamp => ({ contextTime: 5, performanceTime: 1234 }) },
    { what: 'a frozen audio clock', ts: (): AudioTimestamp => ({ contextTime: 5, performanceTime: performance.now() }) },
  ])('rejects instead of reporting overload when the output timestamp shows $what', async ({ ts }) => {
    await probe.start('direct', 'balanced');
    lastCtx().getOutputTimestamp = ts;
    const rejected = expect(probe.benchmark([1, 2], 1)).rejects.toThrow('audio clock did not advance during bench k=1');
    await vi.advanceTimersByTimeAsync(2600);
    await rejected;
    expect(details('audio').some((d) => d.startsWith('bench '))).toBe(false);
    expect(lastNode().lastK()).toBe(1);
  });

  it('restores the pre-benchmark k on a node rebuilt mid-benchmark', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.1);
    const p = probe.benchmark([1, 16], 1);
    const rejected = expect(p).rejects.toThrow('context changed');
    await vi.advanceTimersByTimeAsync(1600); // inside the k = 16 step
    expect(lastNode().lastK()).toBe(16);
    await probe.recreate();
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(lastNode().lastK()).toBe(1);
  });

  it('rejects if the context is recreated mid-benchmark', async () => {
    await probe.start('direct', 'balanced');
    lastCtx().currentTime = 1;
    simulateAudio(() => 1, () => 0.1);
    const p = probe.benchmark([1, 2], 3);
    const rejected = expect(p).rejects.toThrow('context changed');
    await vi.advanceTimersByTimeAsync(500);
    await probe.recreate();
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
  });
});

describe('AudioProbe.events (C8.2: audio events since load, for the export)', () => {
  it('starts at zero and is a snapshot copy', () => {
    const e = probe.events;
    expect(e).toEqual({ stateChanges: 0, elementPauses: 0, errors: 0 });
    e.errors = 9;
    expect(probe.events.errors).toBe(0);
  });

  it('counts state changes of the live context only, not the close of a replaced or stopped one', async () => {
    patchNewContexts((c) => {
      c.state = 'suspended'; // the start-up transition to running is a state change too
    });
    await probe.start('direct', 'balanced'); // suspended → running (1)
    lastCtx().setState('interrupted'); // (2)
    await probe.resume(); // interrupted → running (3)
    await probe.recreate(); // the replaced context's close: not counted; the new one starts running (4)
    await probe.stop(); // the stopped context's close: not counted
    expect(probe.events).toEqual({ stateChanges: 4, elementPauses: 0, errors: 0 });
  });

  it('counts pauses of its route element that it did not cause itself', async () => {
    await probe.start('direct-anchor', 'balanced');
    await probe.setRoute('media-element'); // pauses the anchor element itself: not counted
    FakeAudioElement.instances.at(-1)?.pause(); // e.g. the car pauses the media element
    await probe.stop(); // stop() pauses it itself: not counted
    expect(probe.events.elementPauses).toBe(1);
  });

  it('counts every error entry it logs', async () => {
    patchNewContexts((c) => {
      c.addModuleFails = true;
    });
    await expect(probe.start('direct', 'balanced')).rejects.toThrow('404'); // worklet setup failed (1)
    patchNewContexts(withoutMediaStream);
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor() {
          throw new TypeError('bad metadata');
        }
      },
    );
    const play = vi
      .spyOn(FakeAudioElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await probe.start('direct-anchor', 'balanced'); // media session metadata (2), element play failed (3)
    await vi.advanceTimersByTimeAsync(0);
    await expect(probe.setRoute('media-element')).rejects.toThrow('media-element route unsupported'); // (4)
    lastNode().onprocessorerror?.(); // (5)
    lastCtx().close = (): Promise<void> => Promise.reject(new Error('InvalidStateError'));
    await probe.stop(); // close failed (6)
    play.mockRestore();
    expect(details('error')).toHaveLength(6);
    expect(probe.events).toEqual({ stateChanges: 0, elementPauses: 0, errors: 6 });
  });
});
