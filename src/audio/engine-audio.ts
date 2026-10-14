/**
 * Main-thread audio controller (phase-3 contract T4; spec §5.7, §6): one AudioContext hosting the
 * `tesbox` AudioWorklet processor (src/audio/worklet.ts), the three output routes (§6.4), the Media
 * Session (§6.2), the start-up quality-tier benchmark (§5.7) and interruption recovery (§6.3).
 *
 * - Every state-changing call (start, setRoute, recover, stop) is serialised. When nothing is queued the
 *   operation starts synchronously, so start() — and recover() of an 'interrupted' or lost context, which
 *   does not try resume() first — create the AudioContext inside the caller's tap (the probe's pattern,
 *   src/probe/audio.ts). A rebuild after a failed resume() follows ≤ 500 ms later (sticky activation).
 * - `suspend()` is never called: Tesbox stays the active media session on every route (§6.2).
 * - Replay: the latest "setting-like" message of each kind (engine, tesla, output, source, tuning, warm,
 *   gearboxMode, driveMode, valve, perspective, volume) is remembered — also while no graph exists — and
 *   sent, in the order the latest ones were posted, to every new worklet: at start() (the start messages
 *   update them first) and when recover() rebuilds. Events (shifts, pedal, fix, testTone, bench,
 *   visibility) are never replayed. A rebuilt engine starts warm (it was just running) with the tier
 *   already chosen and the last ignition state the shell posted.
 * - `post({ type: 'tuning' })` always carries `outputLatencyS = ctx.outputLatency || 0.1` (§4.3).
 * - The context runs at the output device's rate when TesboxDspCore can (28–48 kHz); otherwise (an 88.2 /
 *   96 / 192 kHz device) a resampled 48 kHz context replaces it, still inside the tap.
 * - The anchor file is fetched into memory once (spec §6.1, §12); every anchor element of a session plays
 *   that copy through one object URL (revoked by stop()), so a rebuild in a tunnel needs no network. If it
 *   cannot be loaded, elements load the file URL themselves and the next build fetches again.
 *
 * Tier (spec §5.7): tierPref 'full'/'lite' is forced; 'auto' on an Intel MCU → 'lite'; otherwise the
 * worklet starts on 'full' and, during the 2.5 s crank, renders its DSP k = 1, 2, 4, 8 times per quantum
 * for 0.5 s each. Each step is judged by the output clock (getOutputTimestamp() pairs fed to a
 * DriftMonitor; a frame rendered at wall time t reaches that clock baseLatency + outputLatency later, so
 * each step is measured from its own output) and by the worklet's busyFrac / OVERLOAD reports (which, with
 * the worklet's ~1 s busy windows, only ever describe k ≤ 2 during the crank — see evaluateBench). Full iff
 * the k = 4 step ran without overload (phase-3 contract); an unmeasured k = 4 gives Lite, and the other
 * steps do not decide. headroomK (largest k without overload, spec §5.7) is diagnostics only. Then `tier`
 * and `bench {k: 1}` are posted. An interruption mid-benchmark discards it (a stall would read as
 * overload) and the next running period benchmarks afresh.
 */
import type { TierPref } from '../app/settings';
import type { AudioState, AudioStatus } from '../app/store';
import { F, MAX_SAMPLE_RATE, S, STATE_LEN, type MainToWorklet, type OutputRoute, type Tier } from '../contracts';
import type { Mcu } from '../platform/detect';
import { DriftMonitor, type DriftSample } from '../platform/drift';
import bundledWorkletUrl from './worklet.ts?worker&url';

export type MediaAction = 'play' | 'pause' | 'nexttrack' | 'previoustrack';

export interface EngineAudioCallbacks {
  onState(s: AudioState): void;
  onSnapshot(buf: Float64Array): void;
  onMediaAction(action: MediaAction): void;
  onError(msg: string): void;
}

export interface EngineAudioOptions {
  /** Worklet module URL; default the bundled `./worklet.ts?worker&url`. */
  workletUrl?: string;
  /** Looping anchor file of the direct-anchor route, fetched into memory at the first start; default `/probe/anchor.wav`. */
  anchorUrl?: string;
}

export interface EngineAudioStart {
  route: OutputRoute;
  latencyHint: 'balanced' | 'playback';
  /** Engine, tesla, output, source, tuning, warm (…); tier, bench and ignition entries are ignored: EngineAudio owns them. */
  messages: MainToWorklet[];
  tierPref: TierPref;
  mcu: Mcu;
  engineName: string;
}

/** One step of the start-up tier benchmark. */
export interface BenchStep {
  k: number;
  /** Output-clock advance / wall time over the step's own output (≈ 1 when the audio thread keeps up); null if unmeasured. */
  ratio: number | null;
  /** null: no usable clock samples and no busy evidence. */
  overloaded: boolean | null;
  /**
   * Highest worklet busyFrac received during the step; null if none. It describes an earlier ~1 s window, so
   * it may understate this step (during the crank it reflects k ≤ 2 only — see evaluateBench).
   */
  busyFrac: number | null;
}

export interface EngineAudioDiagnostics {
  contextState: AudioContextState | 'none';
  sampleRate: number | null;
  baseLatencyS: number | null;
  outputLatencyS: number | null;
  latencyHint: 'balanced' | 'playback' | null;
  /** recover() outcomes: resumed in place, resume failed, context rebuilt. */
  recoveries: { resumeOk: number; resumeFail: number; recreate: number };
  /**
   * Last completed tier benchmark; null when none ran (forced tier, Intel, or not finished yet). headroomK =
   * largest k whose step ran without overload (spec §5.7), 0 if none — diagnostics only: the tier comes from
   * the k = 4 step alone.
   */
  bench: { headroomK: number; steps: BenchStep[] } | null;
}

/** registerProcessor name of src/audio/worklet.ts. */
const PROCESSOR_NAME = 'tesbox';
export const DEFAULT_ANCHOR_URL = '/probe/anchor.wav';
/** recover(): a context not running this long after resume() is rebuilt (spec §6.3). */
export const RESUME_TIMEOUT_MS = 500;
/** stop(): ignition off → close. The worklet's engine is silent well within this (DspCore ignition mix fall 1.5 s). */
export const STOP_FADE_MS = 1600;
/** Tier benchmark: DSP passes per quantum, in run order, each held this long (spec §5.7: during the 2.5 s crank). */
export const BENCH_KS: readonly number[] = [1, 2, 4, 8];
export const BENCH_STEP_MS = 500;
/** The step that decides the tier: Full iff k = 4 runs without overload (phase-3 contract, spec §5.7). */
export const FULL_MIN_K = 4;

const NODE_OPTIONS: AudioWorkletNodeOptions = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] };
const MEDIA_ACTIONS: readonly MediaAction[] = ['play', 'pause', 'nexttrack', 'previoustrack'];
const ADD_MODULE_TIMEOUT_MS = 10_000; // a hung module fetch (car network stall) must not block the queue
/** A direct-anchor build waits at most this long for the anchor file to reach memory, then plays the file URL itself. */
const ANCHOR_WAIT_MS = 1000;
/** An anchor fetch still pending after this is given up: the next build fetches again. */
const ANCHOR_FETCH_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2000;
const DEFAULT_OUTPUT_LATENCY_S = 0.1;
/**
 * Lowest rate TesboxDspCore runs at (MIN_SAMPLE_RATE in src/dsp/dsp-core.ts, amendment B3; the highest is
 * MAX_SAMPLE_RATE). A copy, so the main-thread bundle does not pull in the DSP; the unit tests pin the two together.
 */
const DSP_MIN_SAMPLE_RATE = 28_000;
/** The worklet renders the provisional tier while the benchmark measures it. */
const PROVISIONAL_TIER: Tier = 'full';
/** Start of each step left out of its measurement (message delivery, latency estimate error). */
const BENCH_SETTLE_MS = 100;
const BENCH_SAMPLE_MS = 50;
/** DriftMonitor window inside a step: ≥ 2 windows → sustained-overload rule, else the whole-step ratio. */
const BENCH_WINDOW_MS = 150;
const DRIFT_THRESHOLD = 0.98;
/** A worklet busyFrac above this received during a step marks it overloaded (the worklet's own OVERLOAD threshold). */
const BUSY_OVERLOAD = 0.8;
/** Render → output-clock shift is capped so the k = 4 step is always measured within the k = 8 step. */
const MAX_BENCH_LATENCY_MS = 450;

type MsgType = MainToWorklet['type'];
/** Setting-like messages: the latest of each kind is replayed to every new worklet. */
const REPLAYED: ReadonlySet<MsgType> = new Set<MsgType>([
  'engine',
  'tesla',
  'output',
  'source',
  'tuning',
  'warm',
  'gearboxMode',
  'driveMode',
  'valve',
  'perspective',
  'volume',
]);
/** Owned by EngineAudio: never taken from start() messages. */
const OWNED: ReadonlySet<MsgType> = new Set<MsgType>(['tier', 'bench', 'ignition']);

interface StepWindow {
  k: number;
  startMs: number;
  endMs: number;
}

interface BusySample {
  atMs: number;
  busyFrac: number;
  overload: boolean;
}

interface Session {
  latencyHint: 'balanced' | 'playback';
}

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private routeEl: HTMLAudioElement | null = null;
  /** Connected route; null while no graph exists. */
  private route: OutputRoute | null = null;
  /** Route the next (re)build connects: start()'s, then every route setRoute() connected. */
  private wantedRoute: OutputRoute = 'direct-anchor';
  private session: Session | null = null;
  /** Between start() and stop(): only then is audio supposed to play (and recover() allowed). */
  private wantRunning = false;
  /** A build is in progress: it sets the state when done. */
  private building = false;
  /** The route element was paused by something other than EngineAudio. */
  private elementPaused = false;
  private lastCtxState: AudioContextState | null = null;
  private mediaSessionSet = false;
  private engineName = 'Tesbox';
  private readonly replay = new Map<MsgType, MainToWorklet>();
  private ignitionOn = true;
  /** Chosen tier (forced, Intel, benchmarked or posted by Settings); null while 'auto' is undecided. */
  private tierDecided: Tier | null = null;
  /** Tier the current worklet renders; null without one. */
  private tierPosted: Tier | null = null;
  private benchNode: AudioWorkletNode | null = null;
  private benchGen = 0;
  private benchListener: ((buf: Float64Array) => void) | null = null;
  private lastBench: { headroomK: number; steps: BenchStep[] } | null = null;
  private readonly recoveries = { resumeOk: 0, resumeFail: 0, recreate: 0 };
  /** The anchor file in memory (spec §6.1, §12): a rebuild in a tunnel needs no network. Kept across sessions once loaded. */
  private anchorBlob: Blob | null = null;
  private anchorLoading: Promise<void> | null = null;
  /** This session's object URL of anchorBlob, shared by every anchor element; revoked by stop(). */
  private anchorObjectUrl: string | null = null;
  private current: AudioState = { state: 'off', route: 'direct-anchor', tier: null };
  private pendingOps = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly workletUrl: string;
  private readonly anchorUrl: string;

  constructor(
    private readonly cb: EngineAudioCallbacks,
    opts: EngineAudioOptions = {},
  ) {
    this.workletUrl = opts.workletUrl ?? bundledWorkletUrl;
    this.anchorUrl = opts.anchorUrl ?? DEFAULT_ANCHOR_URL;
  }

  /** Current state (a copy). */
  get state(): AudioState {
    return { ...this.current };
  }

  get diagnostics(): EngineAudioDiagnostics {
    const ctx = this.ctx;
    const bench = this.lastBench;
    return {
      contextState: ctx === null ? 'none' : ctx.state,
      sampleRate: ctx === null ? null : ctx.sampleRate,
      baseLatencyS: ctx !== null && typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatencyS: ctx !== null && typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      latencyHint: this.session?.latencyHint ?? null,
      recoveries: { ...this.recoveries },
      bench: bench === null ? null : { headroomK: bench.headroomK, steps: bench.steps.map((s) => ({ ...s })) },
    };
  }

  /**
   * MUST be called from a click/pointerup handler. Builds context → module → node → route → Media
   * Session → messages → tier → `ignition on`; resolves once the graph exists (state 'running', or
   * 'interrupted' if the context would not run). The tier benchmark continues in the background. Rejects
   * (state 'error' with the message, nothing left behind) if the module, node or route fails. While a
   * session exists it does nothing: config goes through post(), routes through setRoute().
   */
  start(init: EngineAudioStart): Promise<void> {
    return this.serial(async () => {
      if (this.ctx !== null) return;
      this.session = { latencyHint: init.latencyHint };
      this.wantedRoute = init.route;
      this.wantRunning = true;
      this.engineName = init.engineName;
      this.ignitionOn = true;
      this.tierDecided = forcedTier(init.tierPref, init.mcu);
      this.lastBench = null;
      const extras: MainToWorklet[] = [];
      for (const msg of init.messages) {
        if (REPLAYED.has(msg.type)) this.remember(msg);
        else if (!OWNED.has(msg.type)) extras.push(msg);
      }
      this.publish('starting');
      try {
        await this.build(extras, false);
      } catch (e) {
        this.wantRunning = false;
        this.clearMediaSession();
        this.releaseAnchorUrl();
        this.publish('error', errText(e));
        throw e;
      }
    });
  }

  /** Sends `msg` to the worklet (a tuning with the context's outputLatency) and keeps setting-like messages for replay. */
  post(msg: MainToWorklet): void {
    if (msg.type === 'tier') {
      this.cancelBench(); // a tier chosen in Settings ends the benchmark
      this.tierDecided = msg.value;
    } else if (msg.type === 'ignition') {
      this.ignitionOn = msg.on;
    } else if (msg.type === 'engine') {
      this.engineName = msg.def.name;
      if (this.mediaSessionSet) this.setMetadata();
    }
    if (REPLAYED.has(msg.type)) this.remember(msg);
    const ctx = this.ctx;
    const node = this.node;
    if (ctx === null || node === null) return;
    node.port.postMessage(this.prepare(msg, ctx));
    if (msg.type === 'tier') {
      this.tierPosted = msg.value;
      this.publish(this.current.state, this.current.message);
    }
  }

  /** Reconnects the live context (no new context). Rejects, keeping the connected route, if the route is unsupported. */
  setRoute(route: OutputRoute): Promise<void> {
    return this.serial(async () => {
      if (this.ctx === null || this.node === null) {
        this.wantedRoute = route; // a recover() that rebuilds uses it; start() takes its own
        return;
      }
      if (route === this.route) return;
      this.connectRoute(route);
      this.wantedRoute = route;
      this.publish(this.current.state, this.current.message);
    });
  }

  /**
   * From the Tap-to-resume tap: resume(); if the context is 'interrupted' (or gone), resume() rejects, or it
   * is not running within 500 ms → close + recreate inside the tap, replaying the last config, warm, the tier
   * and ignition. Resolves true when audio runs afterwards; false before start()/after stop() or when the
   * rebuild failed (state 'error'; the next tap tries again).
   */
  recover(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.wantRunning || this.session === null) return false;
      const ctx = this.ctx;
      if (ctx !== null && this.node !== null && ctx.state !== 'interrupted' && ctx.state !== 'closed') {
        const settled = await settlesWithin(ctx.resume(), RESUME_TIMEOUT_MS);
        if (settled && this.ctx === ctx && ctx.state === 'running') {
          this.recoveries.resumeOk++;
          this.lastCtxState = ctx.state;
          this.restartElement();
          this.publish('running');
          this.maybeStartBench();
          return true;
        }
        this.recoveries.resumeFail++;
      }
      this.recoveries.recreate++;
      return this.rebuild();
    });
  }

  /** Posts `{ type: 'visibility' }`. Visible again with audio stopped meanwhile → 'interrupted' (Tap to resume). */
  setVisibility(hidden: boolean): void {
    this.post({ type: 'visibility', hidden });
    const ctx = this.ctx;
    if (hidden || ctx === null || this.building || !this.wantRunning) return;
    if (this.current.state === 'running' && (ctx.state !== 'running' || this.elementPaused)) this.publish('interrupted');
  }

  /** Ignition off, the engine's fade-out, then close; clears the route and the Media Session. */
  stop(): Promise<void> {
    return this.serial(async () => {
      this.wantRunning = false;
      this.cancelBench();
      const ctx = this.ctx;
      const node = this.node;
      if (ctx !== null && node !== null) {
        node.port.postMessage({ type: 'ignition', on: false });
        if (ctx.state === 'running') await delay(STOP_FADE_MS);
      }
      const dead = this.teardown();
      this.clearMediaSession();
      this.releaseAnchorUrl(); // after teardown released the element
      this.publish('off');
      if (dead !== null) {
        await closeContext(dead).catch((e: unknown) => this.report(`close failed: ${errText(e)}`));
      }
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** One operation at a time, in call order; when idle it starts synchronously (inside the caller's tap). */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const idle = this.pendingOps === 0;
    this.pendingOps++;
    const result = idle ? op() : this.queue.then(op);
    this.queue = result.then(
      () => {
        this.pendingOps--;
      },
      () => {
        this.pendingOps--;
      },
    );
    return result;
  }

  /**
   * Creates the AudioContext synchronously, then module, node, route, Media Session and the session
   * messages; resumes a context that does not run (within 500 ms). On failure nothing is left.
   */
  private async build(extras: readonly MainToWorklet[], recovery: boolean): Promise<void> {
    const ctx = this.createContext();
    this.ctx = ctx;
    this.building = true;
    this.lastCtxState = ctx.state;
    ctx.onstatechange = () => this.onContextState(ctx);
    const anchor = this.loadAnchor(); // every session asset into memory (spec §6.1, §12)
    let node: AudioWorkletNode;
    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
      await Promise.all([
        withTimeout(ctx.audioWorklet.addModule(this.workletUrl), ADD_MODULE_TIMEOUT_MS, 'addModule'),
        // The first anchor element plays from memory too, unless the file takes longer than ANCHOR_WAIT_MS.
        this.wantedRoute === 'direct-anchor' ? settlesWithin(anchor, ANCHOR_WAIT_MS) : null,
      ]);
      node = new AudioWorkletNode(ctx, PROCESSOR_NAME, NODE_OPTIONS);
      node.port.onmessage = (e: MessageEvent<unknown>) => this.onWorkletMessage(node, e.data);
      node.onprocessorerror = () => this.onProcessorError(node);
      this.node = node;
      this.connectRoute(this.wantedRoute);
      this.registerMediaSession();
      this.postSession(ctx, node, extras, recovery);
      if (ctx.state !== 'running') await settlesWithin(ctx.resume(), RESUME_TIMEOUT_MS);
      if (this.node !== node) throw new Error('audio worklet failed during start');
    } catch (e) {
      this.building = false;
      if (this.ctx === ctx) this.teardown();
      await closeContext(ctx).catch(() => undefined);
      throw e;
    }
    this.building = false;
    this.lastCtxState = ctx.state;
    const running = ctx.state === 'running' && !this.elementPaused;
    this.publish(running ? 'running' : 'interrupted');
    if (running) this.maybeStartBench();
  }

  /**
   * `AudioContext({ latencyHint })` at the output device's rate — unless TesboxDspCore cannot run at it
   * (28–48 kHz, amendment B3: an 88.2/96/192 kHz device would leave the worklet silent behind a 'running'
   * state): then that context is closed and a resampled 48 kHz one is created instead, synchronously, so
   * still inside the caller's tap. Throws (nothing left open) if the browser refuses the 48 kHz request.
   */
  private createContext(): AudioContext {
    const latencyHint = this.session?.latencyHint ?? 'balanced';
    const ctx = new AudioContext({ latencyHint });
    const fs = ctx.sampleRate;
    if (fs >= DSP_MIN_SAMPLE_RATE && fs <= MAX_SAMPLE_RATE) return ctx;
    closeContext(ctx).catch(() => undefined);
    return new AudioContext({ latencyHint, sampleRate: MAX_SAMPLE_RATE });
  }

  /** Close the old context (not awaited: the new one is created inside the tap) and build anew. */
  private async rebuild(): Promise<boolean> {
    const old = this.teardown();
    if (old !== null) closeContext(old).catch((e: unknown) => this.report(`close failed: ${errText(e)}`));
    this.publish('starting');
    try {
      await this.build([], true);
    } catch (e) {
      this.clearMediaSession(); // nothing may advertise a playing session for audio that no longer exists
      this.publish('error', errText(e));
      return false;
    }
    return this.current.state === 'running';
  }

  /** Replayed settings (recency order), start extras, warm on a rebuild, the tier, then ignition. */
  private postSession(ctx: AudioContext, node: AudioWorkletNode, extras: readonly MainToWorklet[], recovery: boolean): void {
    for (const msg of this.replay.values()) {
      if (recovery && msg.type === 'warm') continue;
      node.port.postMessage(this.prepare(msg, ctx));
    }
    for (const msg of extras) node.port.postMessage(this.prepare(msg, ctx));
    if (recovery) node.port.postMessage({ type: 'warm', warm: true }); // it was just running (spec §5.3.5)
    const tier = this.tierDecided ?? PROVISIONAL_TIER;
    node.port.postMessage({ type: 'tier', value: tier });
    this.tierPosted = tier;
    node.port.postMessage({ type: 'ignition', on: this.ignitionOn });
  }

  /** Disconnects everything and forgets the context; the caller decides how to close it. */
  private teardown(): AudioContext | null {
    this.cancelBench();
    this.disconnectRoute();
    const node = this.node;
    if (node !== null) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      this.node = null;
    }
    const ctx = this.ctx;
    if (ctx !== null) ctx.onstatechange = null;
    this.ctx = null;
    this.tierPosted = null;
    this.elementPaused = false;
    return ctx;
  }

  private remember(msg: MainToWorklet): void {
    this.replay.delete(msg.type); // re-insert: the map keeps the order of the latest posts
    this.replay.set(msg.type, msg);
  }

  private prepare(msg: MainToWorklet, ctx: AudioContext): MainToWorklet {
    if (msg.type !== 'tuning') return msg;
    return { type: 'tuning', value: { ...msg.value, outputLatencyS: outputLatencyOf(ctx) } };
  }

  /** Builds the AudioState from the current route/tier; calls onState only when something changed. */
  private publish(state: AudioStatus, message?: string): void {
    const route = this.route ?? this.wantedRoute;
    const tier = this.tierPosted;
    const cur = this.current;
    if (cur.state === state && cur.route === route && cur.tier === tier && cur.message === message) return;
    const next: AudioState = message === undefined ? { state, route, tier } : { state, route, tier, message };
    this.current = next;
    this.safely(() => this.cb.onState({ ...next }));
  }

  private report(msg: string): void {
    this.safely(() => this.cb.onError(msg));
  }

  /** A throwing UI callback must not leave the controller half-updated. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error('EngineAudio callback failed', e);
    }
  }

  // ── context and worklet events ──

  private onContextState(ctx: AudioContext): void {
    if (this.ctx !== ctx) return; // a replaced or stopped context closing
    const prev = this.lastCtxState;
    const s = ctx.state;
    this.lastCtxState = s;
    if (this.building || !this.wantRunning) return; // build() / stop() set the state themselves
    if (s === 'running') {
      this.restartElement(); // the same interruption usually paused the route element
      this.publish('running');
      this.maybeStartBench();
      return;
    }
    this.cancelBench(); // measuring across a stall would read as overload
    this.publish('interrupted');
    if (s === 'suspended' && prev === 'interrupted') {
      // Spec §6.3: interrupted → suspended by itself → resume automatically (once; no retry loop).
      ctx.resume().catch(() => undefined);
    }
  }

  private onWorkletMessage(node: AudioWorkletNode, data: unknown): void {
    if (node !== this.node || typeof data !== 'object' || data === null) return;
    const msg = data as { type?: unknown; buf?: unknown; message?: unknown };
    if (msg.type === 'state') {
      const buf = msg.buf;
      if (!(buf instanceof Float64Array) || buf.length < STATE_LEN) return;
      this.benchListener?.(buf);
      this.safely(() => this.cb.onSnapshot(buf));
    } else if (msg.type === 'error') {
      this.report(String(msg.message));
    }
  }

  /** The processor died (it renders silence from now on): close the graph; recover() or start() rebuilds it. */
  private onProcessorError(node: AudioWorkletNode): void {
    if (node !== this.node) return;
    const message = 'audio worklet failed (processorerror)';
    this.report(message);
    const dead = this.teardown();
    this.clearMediaSession();
    this.publish('error', message);
    if (dead !== null) closeContext(dead).catch(() => undefined);
  }

  // ── routes (spec §6.4) ──

  private connectRoute(route: OutputRoute): void {
    const ctx = this.ctx;
    const node = this.node;
    if (ctx === null || node === null) return;
    if (route === 'media-element' && typeof ctx.createMediaStreamDestination !== 'function') {
      throw new Error('media-element route unsupported (no MediaStreamAudioDestinationNode)');
    }
    this.disconnectRoute();
    if (route === 'media-element') {
      const msd = ctx.createMediaStreamDestination();
      node.connect(msd);
      const el = this.makeElement();
      el.srcObject = msd.stream;
      this.route = route;
      this.playElement(el, route);
    } else {
      node.connect(ctx.destination);
      this.route = route;
      if (route === 'direct-anchor') {
        const el = this.makeElement();
        el.src = this.anchorSrc();
        el.loop = true;
        this.playElement(el, route);
      }
    }
  }

  /** Loads the anchor file into memory unless it is there or on its way; never rejects (a failure leaves it to the file URL). */
  private loadAnchor(): Promise<void> {
    if (this.anchorBlob !== null) return Promise.resolve();
    this.anchorLoading ??= withTimeout(fetchBlob(this.anchorUrl), ANCHOR_FETCH_TIMEOUT_MS, 'anchor fetch').then(
      (blob) => {
        this.anchorBlob = blob;
        this.anchorLoading = null;
      },
      () => {
        this.anchorLoading = null; // offline, refused or stalled: elements load the file URL themselves; the next build retries
      },
    );
    return this.anchorLoading;
  }

  /** src of a new anchor element: this session's object URL of the file in memory, else the file URL. */
  private anchorSrc(): string {
    const blob = this.anchorBlob;
    if (this.anchorObjectUrl === null && blob !== null) {
      try {
        this.anchorObjectUrl = URL.createObjectURL(blob);
      } catch {
        // no object URLs here: the file URL still plays while online
      }
    }
    return this.anchorObjectUrl ?? this.anchorUrl;
  }

  /** Revokes this session's object URL once no element uses it (the file itself stays in memory for the next start). */
  private releaseAnchorUrl(): void {
    const url = this.anchorObjectUrl;
    if (url === null) return;
    this.anchorObjectUrl = null;
    try {
      URL.revokeObjectURL(url);
    } catch {
      // nothing to release
    }
  }

  private disconnectRoute(): void {
    this.node?.disconnect();
    const el = this.routeEl;
    if (el !== null) {
      this.routeEl = null;
      el.onpause = null; // our own pause is not an interruption
      el.pause();
      el.srcObject = null;
      el.removeAttribute('src');
      el.load(); // releases the media resource
    }
    this.route = null;
    this.elementPaused = false;
  }

  private makeElement(): HTMLAudioElement {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.onpause = () => this.onElementPaused(el);
    this.routeEl = el;
    return el;
  }

  /** Not awaited: a play() that never settles must not block the operation queue. */
  private playElement(el: HTMLAudioElement, route: OutputRoute): void {
    el.play().then(undefined, (e: unknown) => {
      if (this.routeEl !== el) return;
      this.report(`${route} element play failed: ${errText(e)}`);
      // Through a media element the engine is silent without it; the anchor only holds the session.
      if (route === 'media-element') this.onElementPaused(el);
    });
  }

  /** The route element stopped without EngineAudio asking (e.g. the car took the audio focus): Tap to resume. */
  private onElementPaused(el: HTMLAudioElement): void {
    if (this.routeEl !== el || !this.wantRunning) return;
    this.elementPaused = true;
    if (!this.building && this.current.state === 'running') this.publish('interrupted');
  }

  private restartElement(): void {
    const el = this.routeEl;
    const route = this.route;
    if (el === null || route === null || !(this.elementPaused || el.paused)) return;
    this.elementPaused = false;
    this.playElement(el, route);
  }

  // ── Media Session (spec §6.2) ──

  private registerMediaSession(): void {
    const ms = mediaSession();
    if (ms === undefined) return;
    this.setMetadata();
    try {
      ms.playbackState = 'playing';
    } catch {
      // read-only in some engines: the metadata and handlers still apply
    }
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, () => this.safely(() => this.cb.onMediaAction(action)));
      } catch {
        // action unsupported by this browser
      }
    }
    this.mediaSessionSet = true;
  }

  private setMetadata(): void {
    const ms = mediaSession();
    if (ms === undefined || typeof MediaMetadata !== 'function') return;
    try {
      ms.metadata = new MediaMetadata({ title: this.engineName, artist: 'Tesbox' });
    } catch {
      // metadata is cosmetic
    }
  }

  /** Clears only what registerMediaSession() set: a start that failed earlier leaves the session untouched. */
  private clearMediaSession(): void {
    if (!this.mediaSessionSet) return;
    this.mediaSessionSet = false;
    const ms = mediaSession();
    if (ms === undefined) return;
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // unsupported action: nothing was registered
      }
    }
    try {
      ms.playbackState = 'none';
      ms.metadata = null;
    } catch {
      // nothing more to clear
    }
  }

  // ── tier benchmark (spec §5.7) ──

  private maybeStartBench(): void {
    const ctx = this.ctx;
    const node = this.node;
    if (this.tierDecided !== null || !this.wantRunning || this.building || ctx === null || node === null) return;
    if (ctx.state !== 'running' || this.benchNode === node) return;
    void this.runBench(ctx, node);
  }

  /** Ends a running benchmark without a decision and puts the worklet back to one DSP pass. */
  private cancelBench(): void {
    const node = this.benchNode;
    if (node === null) return;
    this.benchGen++;
    this.benchNode = null;
    this.benchListener = null;
    if (node === this.node) node.port.postMessage({ type: 'bench', k: 1 });
  }

  private async runBench(ctx: AudioContext, node: AudioWorkletNode): Promise<void> {
    const gen = ++this.benchGen;
    this.benchNode = node;
    const steps: StepWindow[] = [];
    const samples: DriftSample[] = [];
    const busy: BusySample[] = [];
    this.benchListener = (buf) => {
      busy.push({
        atMs: performance.now(),
        busyFrac: buf[S.busyFrac] ?? Number.NaN,
        overload: ((buf[S.flags] ?? 0) & F.OVERLOAD) !== 0,
      });
    };
    const live = (): boolean => gen === this.benchGen && this.node === node && ctx.state === 'running';
    for (const k of BENCH_KS) {
      const startMs = performance.now();
      const endMs = startMs + BENCH_STEP_MS;
      node.port.postMessage({ type: 'bench', k });
      steps.push({ k, startMs, endMs });
      for (;;) {
        samples.push(sampleClock(ctx));
        const leftMs = endMs - performance.now();
        if (leftMs <= 0) break;
        await delay(Math.min(BENCH_SAMPLE_MS, leftMs));
        if (!live()) {
          if (gen === this.benchGen) this.cancelBench();
          return;
        }
      }
    }
    const shiftMs = typeof ctx.getOutputTimestamp === 'function' ? renderToOutputMs(ctx) : 0;
    const result = evaluateBench(steps, samples, busy, shiftMs);
    // Contract: Full iff k = 4 runs without overload — decided by that step alone (an unmeasured k = 4 is not proof).
    const k4 = result.steps.find((s) => s.k === FULL_MIN_K);
    const tier: Tier = k4?.overloaded === false ? 'full' : 'lite';
    this.benchNode = null;
    this.benchListener = null;
    this.lastBench = result;
    this.tierDecided = tier;
    node.port.postMessage({ type: 'tier', value: tier });
    node.port.postMessage({ type: 'bench', k: 1 });
    this.tierPosted = tier;
    this.publish(this.current.state, this.current.message);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function forcedTier(pref: TierPref, mcu: Mcu): Tier | null {
  if (pref !== 'auto') return pref;
  return mcu === 'intel' ? 'lite' : null;
}

function outputLatencyOf(ctx: AudioContext): number {
  const v = ctx.outputLatency;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_OUTPUT_LATENCY_S;
}

/** Wall time from rendering a frame to its output timestamp: baseLatency + outputLatency, whole ms, capped. */
function renderToOutputMs(ctx: AudioContext): number {
  const s = nonNegative(ctx.baseLatency) + nonNegative(ctx.outputLatency);
  return Math.min(MAX_BENCH_LATENCY_MS, Math.round(s * 1000));
}

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Audio clock vs wall clock (spec §5.7): getOutputTimestamp() pairs (both values describe the same
 * render callback), else currentTime + performance.now(). Never throws: a failing clock reads as 0
 * (unmeasured), so the background benchmark cannot reject.
 */
function sampleClock(ctx: AudioContext): DriftSample {
  const now = performance.now();
  try {
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      const perfMs = ts.performanceTime ?? 0;
      return { contextTimeS: ts.contextTime ?? 0, perfMs: perfMs > 0 ? perfMs : now };
    }
    return { contextTimeS: ctx.currentTime, perfMs: now };
  } catch {
    return { contextTimeS: 0, perfMs: now };
  }
}

/**
 * Judges each step on the clock samples whose rendering happened inside it (sample time − shiftMs in
 * [start + settle, end]) and on the worklet busy reports received inside it.
 *
 * A busy report describes a busy window that had already closed when it arrived, i.e. earlier steps of
 * this run (busyFrac grows with k and the steps run in increasing k): it can understate the load of the
 * step it arrives in, but never overstates it — which is what makes it safe to use: a busyFrac above 0.8
 * (or the OVERLOAD flag) marks that step overloaded without a false alarm. (Exception: after an
 * interruption cancelled a run at a higher k, the first window can still hold those frames — an error
 * towards Lite.)
 *
 * The worklet's windows last ~1 s (src/audio/worklet.ts) and the steps 0.5 s, so the reports received
 * during the crank describe k ≤ 2 only: the window that covers k = 4 closes as the benchmark ends, and
 * OVERLOAD needs 2 hot windows. Busy evidence therefore flags k = 4 only when k = 1–2 already kept the
 * worklet above 0.8 busy; the output-clock drift is the measurement of k = 4 itself. Isolating k = 4 in
 * busy terms would need shorter worklet windows or a k = 4 step spanning a whole window.
 */
function evaluateBench(
  steps: readonly StepWindow[],
  samples: readonly DriftSample[],
  busy: readonly BusySample[],
  shiftMs: number,
): { headroomK: number; steps: BenchStep[] } {
  const results = steps.map((step): BenchStep => {
    const from = step.startMs + BENCH_SETTLE_MS;
    const to = step.endMs;
    const own = samples.filter(
      (s) => s.contextTimeS !== 0 && Number.isFinite(s.contextTimeS) && s.perfMs - shiftMs >= from && s.perfMs - shiftMs <= to,
    );
    let ratio: number | null = null;
    let drift: boolean | null = null;
    const first = own[0];
    const last = own[own.length - 1];
    if (first !== undefined && last !== undefined && last.perfMs > first.perfMs && last.contextTimeS > first.contextTimeS) {
      const monitor = new DriftMonitor(BENCH_WINDOW_MS, DRIFT_THRESHOLD);
      let windows = 0;
      for (const s of own) if (monitor.push(s) !== null) windows++;
      ratio = ((last.contextTimeS - first.contextTimeS) * 1000) / (last.perfMs - first.perfMs);
      // ≥ 2 windows: sustained-overload rule; shorter spans: the whole-step ratio (src/probe/audio.ts).
      drift = windows >= 2 ? monitor.overloaded : ratio < DRIFT_THRESHOLD;
    }
    let busyMax: number | null = null;
    let busyOver = false;
    for (const b of busy) {
      if (b.atMs < from || b.atMs > to) continue;
      if (b.overload) busyOver = true;
      if (!Number.isFinite(b.busyFrac)) continue;
      busyMax = busyMax === null ? b.busyFrac : Math.max(busyMax, b.busyFrac);
      if (b.busyFrac > BUSY_OVERLOAD) busyOver = true;
    }
    return {
      k: step.k,
      ratio: ratio === null ? null : round3(ratio),
      overloaded: busyOver ? true : drift,
      busyFrac: busyMax === null ? null : round3(busyMax),
    };
  });
  return { headroomK: headroomOf(results), steps: results };
}

/** Spec §5.7 "headroom = largest k with no drift": the largest k whose step ran without overload, 0 if none did. */
function headroomOf(steps: readonly BenchStep[]): number {
  let best = 0;
  for (const s of steps) if (s.overloaded === false && s.k > best) best = s.k;
  return best;
}

function mediaSession(): MediaSession | undefined {
  return typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform error text: "<Name>: <message>", or just the message for a plain Error. */
function errText(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

/** GET `url` as a Blob; rejects when fetch is unavailable or fails, or the response is not ok. */
async function fetchBlob(url: string): Promise<Blob> {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * close(), abandoned after CLOSE_TIMEOUT_MS; a context that is already closed (it closed by itself) is left
 * alone — close() on it would reject with InvalidStateError and toast an error during a working recovery.
 */
function closeContext(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'closed') return Promise.resolve();
  return withTimeout(ctx.close(), CLOSE_TIMEOUT_MS, 'close');
}

/** Rejects with `Error('<label> timed out after <ms> ms')` unless `p` settles within `ms`; else settles like `p`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** true if `p` fulfils within `ms`; false if it rejects or is still pending (e.g. an interrupted context's resume()). */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return withTimeout(p, ms, 'settle').then(
    () => true,
    () => false,
  );
}
