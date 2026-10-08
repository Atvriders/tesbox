import type { OutputRoute } from '../contracts';
import { PROBE_GAIN_DB, PROBE_PROCESSOR, PROBE_TONE_HZ, type ProbeToWorklet, type WorkletToProbe } from './audio-protocol';
import { DriftMonitor, type DriftSample } from './drift';
import type { EventLog } from './log';
import { errText, withTimeout } from './log';

export interface BenchResult {
  k: number;
  ratio: number;
  overloaded: boolean;
  busyFrac: number | null;
}

export interface AudioProbeState {
  state: AudioContextState | 'none';
  sampleRate: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
  latencyHint: 'balanced' | 'playback';
  route: OutputRoute | null;
  perfInWorklet: boolean | null;
  quanta: number;
  recoveries: { resumeOk: number; resumeFail: number; recreate: number };
}

/**
 * Audio-path events over the probe's lifetime (one probe per page visit), kept as counts so the
 * export still has them after the 40-line log tail has scrolled past (C8.2).
 */
export interface AudioEventCounts {
  /** statechange of the live context (start-up, interruptions, resumes); not the close of a replaced or stopped one. */
  stateChanges: number;
  /** Pauses of the route's <audio> element that the probe did not cause (e.g. the car took audio focus). */
  elementPauses: number;
  /** `error` entries this probe logged. */
  errors: number;
}

type Report = Extract<WorkletToProbe, { type: 'report' }>;
type LatencyHint = 'balanced' | 'playback';

const MEDIA_ACTIONS: readonly MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'nexttrack',
  'previoustrack',
  'seekbackward',
  'seekforward',
];
const RESUME_TIMEOUT_MS = 500;
const ADD_MODULE_TIMEOUT_MS = 10_000; // a hung module fetch (car network stall) must not block the queue
const CLOSE_TIMEOUT_MS = 2000;
const BENCH_KS: readonly number[] = [1, 2, 4, 8, 16];
const BENCH_SECONDS = 3;
const BENCH_SETTLE_MS = 250; // let the new k reach the worklet and one report window flush
const BENCH_SAMPLE_MS = 100;
const DRIFT_WINDOW_MS = 1000;
const DRIFT_THRESHOLD = 0.98;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true if `p` fulfils within `ms`; false if it rejects or is still pending (e.g. an interrupted context). */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return withTimeout(p, ms, 'resume').then(() => true, () => false);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Largest k such that it and every smaller benchmarked k ran without overload (0 if the smallest overloaded). */
function headroomOf(results: readonly BenchResult[]): number {
  let best = 0;
  for (const r of [...results].sort((a, b) => a.k - b.k)) {
    if (r.overloaded) break;
    best = r.k;
  }
  return best;
}

/**
 * Phase 0 audio probe: AudioContext lifecycle, the three output routes (spec §6.4), Media Session,
 * k× headroom benchmark, resume/recreate recovery and the hidden-page clock check.
 * Every state-changing call is serialised so overlapping taps can never build two contexts,
 * two connected routes or two playing media elements.
 */
export class AudioProbe {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private routeEl: HTMLAudioElement | null = null;
  private route: OutputRoute | null = null;
  /**
   * Route that most recently connected; recreate() rebuilds it. A rejected route request never
   * changes it, so Recreate restores the audio that was playing instead of retrying a route that
   * just failed (`route` is also null after a switch that failed midway).
   */
  private lastRoute: OutputRoute | null = null;
  private latencyHint: LatencyHint = 'balanced';
  private k = 1;
  private toneHz = PROBE_TONE_HZ;
  private lastReport: Report | null = null;
  private readonly recoveries = { resumeOk: 0, resumeFail: 0, recreate: 0 };
  private readonly eventCounts: AudioEventCounts = { stateChanges: 0, elementPauses: 0, errors: 0 };
  private hiddenAt: { ctx: AudioContext; ctxTimeS: number; perfMs: number } | null = null;
  private hiddenRatio: number | null = null;
  private visibilityAttached = false;
  private benchRunning = false;
  private reportListener: ((r: Report) => void) | null = null;
  private pingId = 0;
  private pingSentAt = 0;
  private pendingOps = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: EventLog,
    private readonly workletUrl: string,
    private readonly anchorUrl: string,
  ) {}

  /** Ratio of audio-clock advance to wall time across the last hidden period, null if never hidden. */
  get hiddenClockRatio(): number | null {
    return this.hiddenRatio;
  }

  /** Context state changes, external route-element pauses and logged errors since this probe was created (a copy). */
  get events(): AudioEventCounts {
    return { ...this.eventCounts };
  }

  /** Latest worklet report of the current node (a copy), null before the first one. */
  get lastWorkletReport(): Readonly<Report> | null {
    return this.lastReport === null ? null : { ...this.lastReport };
  }

  get snapshot(): AudioProbeState {
    const ctx = this.ctx;
    return {
      state: ctx !== null ? ctx.state : 'none',
      sampleRate: ctx !== null ? ctx.sampleRate : null,
      baseLatency: ctx !== null && typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
      outputLatency: ctx !== null && typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
      latencyHint: this.latencyHint,
      route: this.route,
      perfInWorklet: this.lastReport !== null ? this.lastReport.perfInWorklet : null,
      quanta: this.lastReport !== null ? this.lastReport.quanta : 0,
      recoveries: { ...this.recoveries },
    };
  }

  /** MUST be called from a click handler. Creates the context, adds the module, connects the route, registers Media Session. */
  start(route: OutputRoute, latencyHint: LatencyHint): Promise<void> {
    return this.serial(async () => {
      if (this.ctx !== null) {
        if (latencyHint !== this.latencyHint) {
          // The latencyHint A/B needs a fresh context: there is only ever one.
          this.latencyHint = latencyHint;
          await this.rebuild(route);
        } else if (route !== this.route) {
          this.connectRoute(route);
        }
        return;
      }
      this.latencyHint = latencyHint;
      this.attachVisibility();
      try {
        await this.build(route);
      } catch (e) {
        this.detachVisibility(); // no context left to watch; build() fails before registering the Media Session
        throw e;
      }
    });
  }

  /** Reconnects without recreating the context. Before start() it changes nothing: start() takes its own route. */
  setRoute(route: OutputRoute): Promise<void> {
    return this.serial(async () => {
      if (this.ctx === null) {
        this.log.push('note', `route ${route} ignored: audio not started (start() takes its own route)`);
        return;
      }
      if (route !== this.route) this.connectRoute(route);
    });
  }

  setK(k: number): void {
    this.k = k;
    this.postConfig();
  }

  /**
   * Probe tone in Hz for the current node and every node built later (the worklet clamps it to
   * [1, 1000]). T10's Pitch step toggles 55 ↔ 110 Hz so the tester can hear each route's
   * tap → pitch-change delay (spec §6.4), which outputLatency alone does not show.
   */
  setTone(toneHz: number): void {
    this.toneHz = toneHz;
    this.postConfig();
  }

  /**
   * Runs each k for secondsEach using DriftMonitor + worklet busy reports; headroomK = largest k not
   * overloaded (0 if k=1 overloaded). Rejects with a RangeError, before anything runs, unless ks is a
   * non-empty list of integers ≥ 1 (the worklet renders a whole number of DSP passes per quantum) and
   * secondsEach a finite number > 0 (a NaN or ∞ step would never end and keep the benchmark latched).
   * Otherwise rejects with 'audio is not running' (up front, or when the context stops running
   * mid-run), 'benchmark already running', 'audio context changed during benchmark' (recreate/stop
   * mid-run) or 'audio clock did not advance during bench k=<k>': a step that measured nothing is
   * never reported as an overload, so headroomK cannot silently understate.
   */
  async benchmark(
    ks: number[] = [...BENCH_KS],
    secondsEach = BENCH_SECONDS,
  ): Promise<{ results: BenchResult[]; headroomK: number }> {
    if (!Number.isFinite(secondsEach) || secondsEach <= 0) {
      throw new RangeError(`benchmark secondsEach must be a finite number > 0, got ${secondsEach}`);
    }
    if (ks.length === 0 || !ks.every((k) => Number.isInteger(k) && k >= 1)) {
      throw new RangeError(`benchmark ks must be a non-empty list of integers >= 1, got [${ks.join(', ')}]`);
    }
    if (this.benchRunning) throw new Error('benchmark already running');
    const ctx = this.ctx;
    if (ctx === null || this.node === null || ctx.state !== 'running') throw new Error('audio is not running');
    this.benchRunning = true;
    const prevK = this.k;
    const results: BenchResult[] = [];
    try {
      for (const k of ks) results.push(await this.benchOne(ctx, k, secondsEach));
    } finally {
      this.reportListener = null;
      this.benchRunning = false;
      this.setK(prevK); // also re-configures a node rebuilt mid-run (build() posted the bench k)
    }
    const headroomK = headroomOf(results);
    this.log.push('audio', `bench headroomK=${headroomK}`);
    return { results, headroomK };
  }

  /** From a tap. true when the context is running within 500 ms; logs the result. */
  resume(): Promise<boolean> {
    return this.serial(async () => {
      const ctx = this.ctx;
      if (ctx === null) {
        this.log.push('audio', 'resume: no context');
        return false;
      }
      const settled = await settlesWithin(ctx.resume(), RESUME_TIMEOUT_MS);
      const ok = settled && ctx.state === 'running';
      if (ok) this.recoveries.resumeOk++;
      else this.recoveries.resumeFail++;
      this.log.push('audio', `resume ${ok ? 'ok' : 'failed'} state=${ctx.state}`);
      const el = this.routeEl;
      if (ok && el !== null && el.paused && this.route !== null) this.playElement(el, this.route);
      return ok;
    });
  }

  /**
   * Close + new context inside the tap; re-adds module, the last connected route and Media Session.
   * No-op without a context. If the rebuild fails, no context, Media Session or listener is left.
   */
  recreate(): Promise<void> {
    return this.serial(async () => {
      const route = this.lastRoute;
      if (this.ctx === null || route === null) {
        this.log.push('audio', 'recreate: no context (not started or stopped)');
        return;
      }
      this.recoveries.recreate++;
      this.log.push('audio', 'recreate');
      await this.rebuild(route);
    });
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      const ctx = this.teardown();
      this.clearMediaSession();
      this.detachVisibility();
      if (ctx !== null) {
        await withTimeout(ctx.close(), CLOSE_TIMEOUT_MS, 'close').catch((e: unknown) =>
          this.logError(`close failed: ${errText(e)}`),
        );
        this.log.push('audio', 'stopped');
      }
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Every `error` entry the probe writes goes through here, so `events.errors` cannot miss one. */
  private logError(detail: string): void {
    this.eventCounts.errors++;
    this.log.push('error', detail);
  }

  /**
   * Runs ops one at a time, in call order; a failed op does not block later ones. When nothing is
   * queued the op starts synchronously, so start()/recreate() create the AudioContext and resume()
   * calls ctx.resume() inside the caller's click handler. The route element's play() runs after
   * addModule (or the resume check) resolves and relies on the document's sticky user activation.
   */
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

  private async build(route: OutputRoute): Promise<void> {
    const ctx = new AudioContext({ latencyHint: this.latencyHint });
    this.ctx = ctx;
    this.lastReport = null;
    ctx.onstatechange = () => {
      if (this.ctx !== ctx) return; // a replaced or stopped context closing
      this.eventCounts.stateChanges++;
      this.log.push('audio', ctx.state);
    };
    this.log.push('audio', `context ${ctx.state} sr=${ctx.sampleRate} hint=${this.latencyHint}`);
    let node: AudioWorkletNode;
    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
      await withTimeout(ctx.audioWorklet.addModule(this.workletUrl), ADD_MODULE_TIMEOUT_MS, 'addModule');
      node = new AudioWorkletNode(ctx, PROBE_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
    } catch (e) {
      this.logError(`worklet setup failed: ${errText(e)}`);
      this.ctx = null;
      await withTimeout(ctx.close(), CLOSE_TIMEOUT_MS, 'close').catch(() => undefined);
      throw e;
    }
    node.port.onmessage = (e: MessageEvent<WorkletToProbe>) => this.onWorkletMessage(node, e.data);
    node.onprocessorerror = () => this.logError('worklet processorerror');
    this.node = node;
    this.postConfig();
    try {
      this.connectRoute(route);
    } catch (e) {
      // e.g. media-element without MediaStreamAudioDestinationNode: leave no live context behind.
      this.teardown();
      await withTimeout(ctx.close(), CLOSE_TIMEOUT_MS, 'close').catch(() => undefined);
      throw e;
    }
    this.registerMediaSession();
    this.pingId++;
    this.pingSentAt = performance.now();
    const ping: ProbeToWorklet = { type: 'ping', id: this.pingId };
    node.port.postMessage(ping);
    if (ctx.state !== 'running') {
      const ok = await settlesWithin(ctx.resume(), RESUME_TIMEOUT_MS);
      this.log.push('audio', `initial resume ${ok ? 'ok' : 'pending'} state=${ctx.state}`);
    }
  }

  /**
   * Close the old context (not awaited, so when serial() ran this op synchronously the new one is
   * created inside the tap) and build anew. When the build fails no context is left, so the Media
   * Session the old graph registered and the visibility listener go too: nothing may keep
   * advertising a playing session (or logging its actions) for audio that no longer exists.
   */
  private async rebuild(route: OutputRoute): Promise<void> {
    const old = this.teardown();
    if (old !== null) old.close().catch((e: unknown) => this.logError(`close failed: ${errText(e)}`));
    try {
      await this.build(route);
    } catch (e) {
      this.clearMediaSession();
      this.detachVisibility();
      throw e;
    }
  }

  /** Disconnects everything and forgets the context; returns it so the caller decides how to close it. */
  private teardown(): AudioContext | null {
    this.disconnectRoute();
    if (this.node !== null) {
      this.node.port.onmessage = null;
      this.node.onprocessorerror = null;
      this.node = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.hiddenAt = null;
    this.lastReport = null;
    return ctx;
  }

  private connectRoute(route: OutputRoute): void {
    const ctx = this.ctx;
    const node = this.node;
    if (ctx === null || node === null) return;
    if (route === 'media-element' && typeof ctx.createMediaStreamDestination !== 'function') {
      this.logError('media-element route unsupported (no MediaStreamAudioDestinationNode)');
      throw new Error('media-element route unsupported');
    }
    this.disconnectRoute();
    if (route === 'media-element') {
      const msd = ctx.createMediaStreamDestination();
      node.connect(msd);
      const el = this.makeElement(route);
      el.srcObject = msd.stream;
      this.playElement(el, route);
    } else {
      node.connect(ctx.destination);
      if (route === 'direct-anchor') {
        const el = this.makeElement(route);
        el.src = this.anchorUrl;
        el.loop = true;
        this.playElement(el, route);
      }
    }
    this.route = route;
    this.lastRoute = route;
    this.log.push('audio', `route ${route}`);
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
  }

  private makeElement(route: OutputRoute): HTMLAudioElement {
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.onpause = () => {
      if (this.routeEl !== el) return;
      this.eventCounts.elementPauses++;
      this.log.push('audio', `${route} element paused`);
    };
    this.routeEl = el;
    return el;
  }

  private playElement(el: HTMLAudioElement, route: OutputRoute): void {
    // Not awaited: a play() that never settles must not block the operation queue.
    el.play().then(
      () => {
        if (this.routeEl === el) this.log.push('audio', `${route} element playing`);
      },
      (e: unknown) => {
        if (this.routeEl === el) this.logError(`${route} element play failed: ${errText(e)}`);
      },
    );
  }

  private registerMediaSession(): void {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (ms === undefined) {
      this.log.push('note', 'Media Session unavailable');
      return;
    }
    try {
      if (typeof MediaMetadata === 'function') {
        ms.metadata = new MediaMetadata({ title: 'Tesbox probe', artist: 'Tesbox' });
      }
      ms.playbackState = 'playing';
    } catch (e) {
      this.logError(`media session metadata: ${errText(e)}`);
    }
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, () => this.log.push('mediasession', action));
      } catch {
        this.log.push('note', `media session action unsupported: ${action}`);
      }
    }
  }

  private clearMediaSession(): void {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (ms === undefined) return;
    for (const action of MEDIA_ACTIONS) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // unsupported action: nothing was registered
      }
    }
    ms.playbackState = 'none';
    ms.metadata = null;
  }

  /** Current k and tone to the current node; build() calls it too, so a rebuilt node keeps both. */
  private postConfig(): void {
    const msg: ProbeToWorklet = { type: 'config', k: this.k, toneHz: this.toneHz, gainDb: PROBE_GAIN_DB };
    this.node?.port.postMessage(msg);
  }

  private onWorkletMessage(node: AudioWorkletNode, msg: WorkletToProbe): void {
    if (node !== this.node || typeof msg !== 'object' || msg === null) return;
    if (msg.type === 'report') {
      this.lastReport = msg;
      this.reportListener?.(msg);
    } else if (msg.type === 'pong' && msg.id === this.pingId) {
      const rttMs = Math.round(performance.now() - this.pingSentAt);
      this.log.push('audio', `pong rtt=${rttMs}ms ctxTime=${msg.currentTime.toFixed(3)}`);
    }
  }

  private async benchOne(ctx: AudioContext, k: number, secondsEach: number): Promise<BenchResult> {
    this.setK(k);
    await delay(BENCH_SETTLE_MS);
    this.assertMeasurable(ctx);
    const monitor = new DriftMonitor(DRIFT_WINDOW_MS, DRIFT_THRESHOLD);
    let windows = 0;
    let busyMs = 0;
    let windowMs = 0;
    this.reportListener = (r) => {
      busyMs += r.busyMs;
      windowMs += r.windowMs;
    };
    let first: DriftSample | null = null;
    let last: DriftSample | null = null;
    const endAt = performance.now() + secondsEach * 1000; // benchmark() admits only finite secondsEach > 0
    for (;;) {
      const s = this.sampleClock(ctx);
      if (s.contextTimeS !== 0) {
        first ??= s;
        last = s;
        if (monitor.push(s) !== null) windows++;
      }
      if (performance.now() >= endAt) break;
      await delay(BENCH_SAMPLE_MS);
      this.assertMeasurable(ctx);
    }
    this.reportListener = null;
    // No clock progress (no non-zero sample, a frozen pair or a frozen audio clock) measures nothing,
    // e.g. getOutputTimestamp() returning zeros: fail rather than record ratio 0 as an overload.
    if (
      first === null ||
      last === null ||
      last.perfMs <= first.perfMs ||
      last.contextTimeS <= first.contextTimeS
    ) {
      throw new Error(`audio clock did not advance during bench k=${k}`);
    }
    const ratio = ((last.contextTimeS - first.contextTimeS) * 1000) / (last.perfMs - first.perfMs);
    // ≥ 2 windows: sustained-overload rule (robust to clock quantisation); shorter runs: whole-span ratio.
    const overloaded = windows >= 2 ? monitor.overloaded : ratio < DRIFT_THRESHOLD;
    const result: BenchResult = {
      k,
      ratio: round3(ratio),
      overloaded,
      busyFrac: windowMs > 0 ? round3(busyMs / windowMs) : null,
    };
    this.log.push(
      'audio',
      `bench k=${k} ratio=${result.ratio} overloaded=${overloaded} busy=${result.busyFrac ?? 'n/a'}`,
    );
    return result;
  }

  /** Audio clock vs wall clock (spec §5.7): getOutputTimestamp() {contextTime, performanceTime} pairs. */
  private sampleClock(ctx: AudioContext): DriftSample {
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      const perfMs = ts.performanceTime ?? 0;
      // contextTime and performanceTime describe the same render callback: no callback-period jitter.
      return { contextTimeS: ts.contextTime ?? 0, perfMs: perfMs > 0 ? perfMs : performance.now() };
    }
    return { contextTimeS: ctx.currentTime, perfMs: performance.now() };
  }

  /** A benchmark measures only the context it started on, and only while that context renders. */
  private assertMeasurable(ctx: AudioContext): void {
    if (this.ctx !== ctx) throw new Error('audio context changed during benchmark');
    if (ctx.state !== 'running') throw new Error('audio is not running');
  }

  private attachVisibility(): void {
    if (this.visibilityAttached || typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.visibilityAttached = true;
  }

  private detachVisibility(): void {
    if (!this.visibilityAttached) return;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.visibilityAttached = false;
  }

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = ctx !== null ? { ctx, ctxTimeS: ctx.currentTime, perfMs: performance.now() } : null;
      return;
    }
    const h = this.hiddenAt;
    this.hiddenAt = null;
    if (h === null || ctx === null || h.ctx !== ctx) return;
    const elapsedMs = performance.now() - h.perfMs;
    if (elapsedMs <= 0) return;
    this.hiddenRatio = round3(((ctx.currentTime - h.ctxTimeS) * 1000) / elapsedMs);
    this.log.push(
      'audio',
      `hidden ${(elapsedMs / 1000).toFixed(1)}s clock ratio=${this.hiddenRatio} state=${ctx.state}`,
    );
  };
}
