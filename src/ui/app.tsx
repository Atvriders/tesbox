/**
 * Tesbox app shell (phase-3 contract T1): the screen router, the Unsupported fallback, and the glue
 * between the signals store (src/app/store.ts, T2), the audio controller (src/audio/engine-audio.ts,
 * T4) and the GPS poller (src/audio/gps-source.ts, T5).
 *
 * - Screens are Preact components that receive the shell as `ScreenProps`. They read and write the
 *   store directly and reach the engine only through the shell (start, stop, recover, post, toast).
 * - The shell owns the audio controller: its callbacks feed `store.audio` / `snapshot` / `toast`;
 *   `wireConfig` forwards engine / Tesla / output / mode / source / route changes to it while audio
 *   runs; `wireGps` mirrors the GPS poller into `store.gps`, forwards fixes to the worklet and tells
 *   the shell whether the car is rolling (warm start).
 * - Engine lifecycle rules kept here: `engineWarmAt` on stop and when the page goes away with the
 *   engine on (spec §5.3.5); a per-tab "engine on" mark so a reload mid-drive reopens Drive (§6.3);
 *   a start tapped during the stop fade is not lost; "Lite next Start" after sustained overload
 *   (§5.7); an audio failure stays on screen until the next start (§6.5).
 *
 * Every collaborator is passed in (src/main.ts passes the real ones), so this module runs in Node
 * under Vitest with fakes.
 */
import { computed, effect, type ReadonlySignal, type Signal } from '@preact/signals';
import { Component, render, type ComponentChildren, type ComponentType, type VNode } from 'preact';
import {
  DEFAULT_SIM_TUNING,
  F,
  S,
  minTouchCssPx,
  type EngineDef,
  type FixMsg,
  type MainToWorklet,
  type OutputConfig,
  type OutputRoute,
  type TeslaParams,
} from '../contracts';
import type { Settings } from '../app/settings';
import type { AudioState, GpsState, GpsStatus, Screen } from '../app/store';
import type {
  EngineAudio,
  EngineAudioCallbacks,
  EngineAudioDiagnostics,
  EngineAudioStart,
  MediaAction,
} from '../audio/engine-audio';
import { BUILD_SHA } from '../platform/build-info';
import type { Mcu } from '../platform/detect';
import { DiagnosticsScreen } from './diagnostics';
import { DriveScreen } from './drive';
import { FirstRun } from './first-run';
import { Garage } from './garage';
import { SettingsScreen } from './settings-screen';
import { STR } from './strings';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ───────────────────────────── Router ─────────────────────────────

/** What every screen component receives. */
export interface ScreenProps {
  shell: Shell;
}

export type ScreenViews = Record<Screen, ComponentType<ScreenProps>>;

/** The component of each route. */
export const SCREEN_VIEWS: ScreenViews = {
  'first-run': FirstRun,
  garage: Garage,
  drive: DriveScreen,
  settings: SettingsScreen,
  diagnostics: DiagnosticsScreen,
};

/** Disclaimer (spec §13) and build SHA (spec §10.1, §12) under every screen but Drive. */
export function ShellFooter(): VNode {
  return (
    <footer class="shell-footer">
      <p>{STR.disclaimer}</p>
      <p id="build-sha" class="build">
        {STR.build(BUILD_SHA)}
      </p>
    </footer>
  );
}

interface BoundaryProps {
  children?: ComponentChildren;
}

interface BoundaryState {
  error: string | null;
}

/** Keeps a failing screen from blanking the page: shows the error and a reload button instead. */
export class ScreenBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(err: unknown): BoundaryState {
    return { error: errText(err) };
  }

  render(): ComponentChildren {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <section class="screen" role="alert">
        <h1>{STR.screenError}</h1>
        <p class="muted">{error}</p>
        <button type="button" class="btn-primary" onClick={() => globalThis.location.reload()}>
          {STR.actions.reload}
        </button>
      </section>
    );
  }
}

/** `store.toast` as a status line (its own component, so a toast never re-renders the screen). */
function Toast({ toast }: { toast: ReadonlySignal<string | null> }): VNode | null {
  const message = toast.value;
  return message === null ? null : (
    <div class="toast" role="status">
      {message}
    </div>
  );
}

/**
 * Spec §6.5 ("addModule rejects → … with the error string"): while audio is in its 'error' state —
 * the worklet module, node or route failed at start, or the worklet died — the error stays on top of
 * every screen until the next start. Try again starts from the tap (a user gesture).
 */
export function AudioAlert({ audio, shell }: { audio: ReadonlySignal<AudioState>; shell: Shell }): VNode | null {
  const a = audio.value;
  if (a.state !== 'error') return null;
  return (
    <div class="audio-alert banner bad" role="alert">
      <p>{STR.audioFailed(a.message ?? STR.audioStates.error)}</p>
      <button type="button" class="btn-primary" onClick={() => void shell.startEngine()}>
        {STR.actions.tryAgain}
      </button>
    </div>
  );
}

export interface AppProps {
  /** `store.screen`; the store sets the first screen, src/main.ts applies `initialScreen`. */
  screen: ReadonlySignal<Screen>;
  /** `store.toast`: shown as a status line; the shell clears it after TOAST_MS. */
  toast: ReadonlySignal<string | null>;
  /** `store.audio`: its 'error' state shows the AudioAlert. */
  audio: ReadonlySignal<AudioState>;
  shell: Shell;
  views?: ScreenViews;
}

/** Renders the screen named by `screen` (an unknown value falls back to the garage). */
export function App({ screen, toast, audio, shell, views = SCREEN_VIEWS }: AppProps): VNode {
  const current = screen.value;
  const View = views[current] ?? views.garage;
  return (
    <>
      <ScreenBoundary key={current}>
        <View shell={shell} />
      </ScreenBoundary>
      {current === 'drive' ? null : <ShellFooter />}
      <AudioAlert audio={audio} shell={shell} />
      <Toast toast={toast} />
    </>
  );
}

export function mountApp(root: HTMLElement, props: AppProps): void {
  render(<App {...props} />, root);
}

// ───────────────────────────── Unsupported fallback ─────────────────────────────

/** The Web Audio globals the app needs (the module bundle itself proves ES-module support). */
export interface AudioGlobals {
  readonly AudioContext?: unknown;
  readonly AudioWorkletNode?: unknown;
}

/** Why the app cannot run here, or null. Mirrors public/unsupported.js, so the two never disagree. */
export function unsupportedReason(g: AudioGlobals): string | null {
  if (!g.AudioContext) return STR.unsupported.noAudioContext;
  if (!g.AudioWorkletNode) return STR.unsupported.noAudioWorklet;
  return null;
}

/** Reveals the static #unsupported block of index.html with `reason`, and hides the app. */
export function showUnsupported(doc: Pick<Document, 'getElementById'>, reason: string): void {
  const box = doc.getElementById('unsupported');
  if (box) box.hidden = false;
  const out = doc.getElementById('unsupported-reason');
  if (out) out.textContent = reason;
  const app = doc.getElementById('app');
  if (app) app.hidden = true;
}

// ───────────────────────────── Touch targets ─────────────────────────────

/** Where `--touch` goes (src/main.ts: document.documentElement). */
export interface TouchRoot {
  readonly style: { setProperty(name: string, value: string): void };
}

/** The window: its device pixel ratio and resize events. */
export interface TouchWindow {
  readonly devicePixelRatio: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

/**
 * Sets `--touch` (every button, toggle and paddle is at least that big) to minTouchCssPx(dpr): ≥ 22 mm
 * on any Tesla panel (spec §7.1). A missing, zero or non-finite ratio counts as 1.
 */
export function applyTouchSize(root: TouchRoot, dpr: number): void {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  root.style.setProperty('--touch', `${minTouchCssPx(ratio)}px`);
}

/** Applies it now and on every resize: the car's zoom changes the ratio at runtime (spec §3). Returns the remover. */
export function trackTouchSize(win: TouchWindow, root: TouchRoot): () => void {
  const apply = (): void => applyTouchSize(root, win.devicePixelRatio);
  apply();
  win.addEventListener('resize', apply);
  return () => win.removeEventListener('resize', apply);
}

// ───────────────────────────── Reload mid-drive ─────────────────────────────

/** A per-tab flag: it survives a reload of the page, not a closed tab. */
export interface SessionFlag {
  set(): void;
  clear(): void;
  /** Whether it was set; clears it. */
  take(): boolean;
}

type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type FlagStorageSource = () => FlagStorage | null | undefined;

/** Runs `fn` on the storage; missing, blocked (the getter throws) or failing storage gives `fallback`. */
function withStorage<T>(storage: FlagStorageSource, fn: (s: FlagStorage) => T, fallback: T): T {
  try {
    const s = storage();
    return s ? fn(s) : fallback;
  } catch {
    return fallback;
  }
}

/** A SessionFlag in sessionStorage under `key`. Never throws; storage trouble reads as unset. */
export function sessionFlag(key: string, storage: FlagStorageSource = () => globalThis.sessionStorage): SessionFlag {
  return {
    set: () => withStorage(storage, (s) => s.setItem(key, '1'), undefined),
    clear: () => withStorage(storage, (s) => s.removeItem(key), undefined),
    take: () =>
      withStorage(
        storage,
        (s) => {
          const was = s.getItem(key) !== null;
          s.removeItem(key);
          return was;
        },
        false,
      ),
  };
}

/**
 * The first screen: the store's (first-run while needsFirstRun, else the garage), except that a reload
 * while the engine was on reopens Drive, whose Start overlay shows at once — spec §6.3 "after a page
 * reload mid-drive: restore settings, show Start immediately". First run still wins.
 */
export function initialScreen(stored: Screen, engineWasOn: boolean): Screen {
  return engineWasOn && stored === 'garage' ? 'drive' : stored;
}

// ───────────────────────────── Engine start ─────────────────────────────

/** Contract "Engine warm": a start within 30 min of the last stop is warm (spec §5.3.5). */
export const WARM_WINDOW_MS = 30 * 60 * 1000;

/** Warm when stopped < 30 min ago (a clock that went backwards proves nothing) or already rolling. */
export function isWarmStart(engineWarmAt: number | null, nowMs: number, moving: boolean): boolean {
  if (moving) return true;
  if (engineWarmAt === null) return false;
  const age = nowMs - engineWarmAt;
  return age >= 0 && age < WARM_WINDOW_MS;
}

export function outputConfigOf(s: Settings): OutputConfig {
  return { subwoofer: s.subwoofer, hpCornerHz: s.hpCornerHz, volumeTrimDb: s.volumeTrimDb };
}

/** The persisted modes, as the input messages that set them in the worklet. */
function modeMessages(s: Settings): MainToWorklet[] {
  return [
    { type: 'gearboxMode', value: s.gearboxMode },
    { type: 'driveMode', value: s.driveMode },
    { type: 'valve', mode: s.valve },
    { type: 'perspective', value: s.perspective },
  ];
}

/**
 * EngineAudio.start init for the current settings: every config message the worklet needs plus
 * the persisted modes and the warm flag. EngineAudio patches the tuning's outputLatencyS from its
 * context and posts the tier it picks (contract T4). `liteNextStart` forces Lite for this start.
 */
export function buildStartInit(
  s: Settings,
  def: EngineDef,
  params: TeslaParams,
  o: { mcu: Mcu; nowMs: number; moving: boolean },
): EngineAudioStart {
  return {
    route: s.outputRoute,
    latencyHint: 'balanced', // spec §6.1 default; no Phase 0 result has changed it yet
    tierPref: s.liteNextStart ? 'lite' : s.tierPref,
    mcu: o.mcu,
    engineName: def.name,
    messages: [
      { type: 'engine', def },
      { type: 'tesla', params },
      { type: 'output', config: outputConfigOf(s) },
      { type: 'source', value: s.source },
      { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, gpsLatencyS: s.gpsLatencyS } },
      ...modeMessages(s),
      { type: 'warm', warm: isWarmStart(s.engineWarmAt, o.nowMs, o.moving) },
    ],
  };
}

// ───────────────────────────── Config forwarding ─────────────────────────────

/** Where forwarded changes go: the audio controller. */
export interface ConfigSink {
  post(msg: MainToWorklet): void;
  setRoute(route: OutputRoute): Promise<void>;
}

/** Message types kept in step with the settings while audio runs. */
const FORWARDED: ReadonlySet<MainToWorklet['type']> = new Set<MainToWorklet['type']>([
  'engine',
  'tesla',
  'output',
  'source',
  'gearboxMode',
  'driveMode',
  'valve',
  'perspective',
]);

/** Identity of a forwarded message: an engine by id (definitions are static data), the rest by value. */
function keyOf(msg: MainToWorklet): string {
  return msg.type === 'engine' ? msg.def.id : JSON.stringify(msg);
}

/**
 * Remembers what the worklet was last told per message type and sends only differences, so the
 * start config is never sent twice (an engine or Tesla re-send reconfigures the cores). Inactive
 * from reset() (engine stopping) until the next start's markSent().
 */
export class ConfigForwarder {
  private readonly sent = new Map<string, string>();
  private active = false;

  constructor(
    private readonly sink: ConfigSink,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /** Records the messages (and route) EngineAudio.start is about to send, and activates forwarding. */
  markSent(messages: readonly MainToWorklet[], route: OutputRoute): void {
    this.sent.clear();
    for (const m of messages) if (FORWARDED.has(m.type)) this.sent.set(m.type, keyOf(m));
    this.sent.set('route', route);
    this.active = true;
  }

  reset(): void {
    this.sent.clear();
    this.active = false;
  }

  /**
   * Records a forwarded kind that went to the worklet around the forwarder (Shell.post's raw
   * override), so the next settings change compares with what the worklet really has and re-syncs it.
   */
  note(msg: MainToWorklet): void {
    if (this.active && FORWARDED.has(msg.type)) this.sent.set(msg.type, keyOf(msg));
  }

  /** Never throws: it runs inside signal effects, so a throw would escape from store.updateSettings. */
  offer(msg: MainToWorklet): void {
    if (!this.active) return;
    const key = keyOf(msg);
    if (this.sent.get(msg.type) === key) return;
    this.sent.set(msg.type, key);
    try {
      this.sink.post(msg);
    } catch (err) {
      this.onError(errText(err));
    }
  }

  offerRoute(route: OutputRoute): void {
    if (!this.active || this.sent.get('route') === route) return;
    this.sent.set('route', route);
    try {
      this.sink.setRoute(route).catch((err: unknown) => this.onError(errText(err)));
    } catch (err) {
      this.onError(errText(err));
    }
  }
}

/** The store signals the forwarding reads. */
export interface ConfigSignals {
  settings: ReadonlySignal<Settings>;
  engine: ReadonlySignal<EngineDef>;
  teslaParams: ReadonlySignal<TeslaParams | null>;
  audio: ReadonlySignal<AudioState>;
}

/**
 * Forwards settings changes while audio is running (contract T2: "Engine/tesla/output/mode changes
 * are forwarded to EngineAudio by the shell"); changes made while starting or interrupted go out
 * once it runs. Returns the dispose function.
 */
export function wireConfig(src: ConfigSignals, fwd: ConfigForwarder): () => void {
  const live = computed(() => src.audio.value.state === 'running');
  const disposers = [
    effect(() => {
      const def = src.engine.value;
      if (live.value) fwd.offer({ type: 'engine', def });
    }),
    effect(() => {
      const params = src.teslaParams.value;
      if (params !== null && live.value) fwd.offer({ type: 'tesla', params });
    }),
    effect(() => {
      const s = src.settings.value;
      if (!live.value) return;
      fwd.offer({ type: 'output', config: outputConfigOf(s) });
      fwd.offer({ type: 'source', value: s.source });
      for (const m of modeMessages(s)) fwd.offer(m);
      fwd.offerRoute(s.outputRoute);
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * Mode inputs that are user settings (spec §10.3 persists them; the Drive toggles show them):
 * Shell.post stores them through updateSettings instead of sending them straight to the worklet, and
 * the forwarder sends them while audio runs.
 */
function settingsPatchOf(msg: MainToWorklet): Partial<Settings> | null {
  switch (msg.type) {
    case 'valve':
      return { valve: msg.mode };
    case 'perspective':
      return { perspective: msg.value };
    case 'gearboxMode':
      return { gearboxMode: msg.value };
    case 'driveMode':
      return { driveMode: msg.value };
    case 'volume':
      return { volumeTrimDb: msg.trimDb };
    default:
      return null;
  }
}

// ───────────────────────────── Overload → Lite next Start ─────────────────────────────

/**
 * Spec §5.7: sustained overload mid-drive sets the persisted "Lite next Start" flag (no live
 * switching). The worklet raises F.OVERLOAD after two ~1 s busy windows above 0.8; it must then hold
 * this long on the worklet clock. The start-up benchmark's own k = 8 load can leave the flag up for
 * at most two windows (≈ 2 s) after it ends, which never reaches this.
 */
export const LITE_NEXT_OVERLOAD_S = 3;

/** Watches the worklet snapshots for sustained overload while the engine renders the Full tier. */
export class OverloadWatch {
  /** Worklet time of the first snapshot of the current unbroken overloaded run; NaN outside one. */
  private since = Number.NaN;

  /** True once F.OVERLOAD has held LITE_NEXT_OVERLOAD_S while running Full after the benchmark (bench k = 1). */
  push(buf: Float64Array, audio: AudioState): boolean {
    const t = buf[S.time] ?? Number.NaN;
    const overloaded =
      audio.state === 'running' &&
      audio.tier === 'full' &&
      buf[S.benchK] === 1 &&
      ((buf[S.flags] ?? 0) & F.OVERLOAD) !== 0 &&
      Number.isFinite(t);
    if (!overloaded) {
      this.since = Number.NaN;
      return false;
    }
    // A run starts here — also when the clock went back (a rebuilt context starts again at 0).
    if (!(t >= this.since)) this.since = t;
    return t - this.since >= LITE_NEXT_OVERLOAD_S;
  }
}

// ───────────────────────────── Shell ─────────────────────────────

/** The part of EngineAudio (contract T4) the shell uses. */
export type ShellAudio = Pick<
  EngineAudio,
  'start' | 'post' | 'setRoute' | 'recover' | 'setVisibility' | 'stop' | 'diagnostics'
>;

/** What screens use to drive the engine. */
export interface Shell {
  /**
   * Starts the engine. Call it synchronously from a click/pointerup handler: the AudioContext is
   * created before the first await (autoplay policy). Resolves true once started (or already
   * starting/running), false when it could not start — the reason is in `store.toast`, or in
   * `store.audio` ('error', shown by the AudioAlert). Never rejects. Tapped while a stop is still
   * fading out, it starts the engine again once the stop has finished (unless stopped again first).
   */
  startEngine(): Promise<boolean>;
  /** Ignition off → fade → close; remembers the stop time for a warm restart. Never rejects. */
  stopEngine(): Promise<void>;
  /** Tap to resume (spec §6.3): call synchronously from the tap handler. */
  recover(): Promise<boolean>;
  /**
   * Sends an input to the worklet. Mode inputs are user settings: `valve`, `perspective`,
   * `gearboxMode`, `driveMode` and `volume` (trim) go through updateSettings — persisted and shown by
   * the toggles, sent by the forwarder while audio runs. Everything else (shifts, pedal, testTone,
   * tier, …) goes to the worklet as is; a raw engine / tesla / output / source message (e.g. a
   * Preview on the keyboard source) lasts until the next settings change re-syncs it.
   */
  post(msg: MainToWorklet): void;
  /** Shows a transient message for TOAST_MS; the same text shown again gets the full time again. */
  toast(message: string): void;
  /** Media Session actions (steering-wheel tilt, spec §7.2). Returns the unsubscribe function. */
  onMediaAction(listener: (action: MediaAction) => void): () => void;
  /** Live audio diagnostics (context, latencies, recoveries, tier benchmark) for the Diagnostics screen. */
  diagnostics(): EngineAudioDiagnostics;
}

/** Page-visibility source (the document). */
export interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Page-lifecycle source (the window). */
export interface PageEvents {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

export interface ShellDeps extends ConfigSignals {
  audio: Signal<AudioState>;
  snapshot: Signal<Float64Array>;
  toast: Signal<string | null>;
  updateSettings(patch: Partial<Settings>): unknown;
  /** Builds the audio controller around the shell's callbacks (src/main.ts: `new EngineAudio(cb)`). */
  createAudio(cb: EngineAudioCallbacks): ShellAudio;
  /** MCU guess, asked once at the first start (it opens a throwaway WebGL context). */
  mcu(): Mcu;
  /** Contract "Engine warm": the real GPS says the car is rolling (src/main.ts: wireGps().moving). Default: never. */
  gpsMoving?: () => boolean;
  /** Per-tab "engine on" mark, set from a start until stopEngine (src/main.ts: a sessionFlag). */
  engineMark?: Pick<SessionFlag, 'set' | 'clear'>;
  now?: () => number;
  /** Visibility changes are passed to EngineAudio.setVisibility (spec §6.3 hidden hold). */
  doc?: VisibilityDoc;
  /** pagehide with the engine on records engineWarmAt: the page going away stops the engine too. */
  page?: PageEvents;
}

/** How long a toast stays up. */
export const TOAST_MS = 4000;

/** Wires the audio controller to the store and returns the screens' shell. */
export function createShell(d: ShellDeps): { shell: Shell; audio: ShellAudio; dispose(): void } {
  const now = d.now ?? Date.now;
  const gpsMoving = d.gpsMoving ?? ((): boolean => false);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** (Re)starts the TOAST_MS countdown that clears the toast; none for null. */
  const armToast = (message: string | null): void => {
    clearTimeout(toastTimer);
    if (message !== null) {
      toastTimer = setTimeout(() => {
        d.toast.value = null;
      }, TOAST_MS);
    }
  };
  /**
   * The shell's own toasts. A signal ignores an equal value — and a batch that sets null and then
   * the same text again counts as no change — so a repeat (two failed starts, one error) re-arms here.
   */
  const toast = (message: string): void => {
    d.toast.value = message;
    armToast(message);
  };

  const mediaListeners = new Set<(action: MediaAction) => void>();
  const overload = new OverloadWatch();
  const audioCtl = d.createAudio({
    onState: (s) => {
      d.audio.value = s;
    },
    onSnapshot: (buf) => {
      d.snapshot.value = buf;
      if (overload.push(buf, d.audio.peek()) && !d.settings.peek().liteNextStart) {
        d.updateSettings({ liteNextStart: true });
      }
    },
    onMediaAction: (action) => {
      for (const listener of [...mediaListeners]) listener(action);
    },
    onError: toast,
  });
  const fwd = new ConfigForwarder(audioCtl, toast);
  const disposers: (() => void)[] = [
    wireConfig(d, fwd),
    effect(() => armToast(d.toast.value)), // whoever writes store.toast
    () => clearTimeout(toastTimer),
  ];

  /** Started and not stopped (a failed start ends in 'error'). */
  const engineOn = (): boolean => {
    const state = d.audio.peek().state;
    return state !== 'off' && state !== 'error';
  };

  const doc = d.doc;
  if (doc !== undefined) {
    const onVisibility = (): void => audioCtl.setVisibility(doc.hidden);
    doc.addEventListener('visibilitychange', onVisibility);
    disposers.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  }

  // The page going away stops the engine as surely as stopEngine does. Spec §5.3.5 persists
  // engineWarmAt "so a reload mid-drive starts warm" — whatever the GPS says then (Intel: speed 0).
  const page = d.page;
  if (page !== undefined) {
    const onPageHide = (): void => {
      if (engineOn()) d.updateSettings({ engineWarmAt: now() });
    };
    page.addEventListener('pagehide', onPageHide);
    disposers.push(() => page.removeEventListener('pagehide', onPageHide));
  }

  let mcu: Mcu | null = null;
  /** The latest stopEngine() until its audio stop has settled (EngineAudio fades STOP_FADE_MS first). */
  let stopping: Promise<void> | null = null;
  /** Counts stopEngine() calls: a later stop cancels a start queued behind an earlier one. */
  let stops = 0;
  /** A start tapped during the stop fade, shared by repeated taps. */
  let queuedStart: Promise<boolean> | null = null;

  /** Starts (or recovers) at once. Never throws or rejects: a failure resolves false, its reason shown. */
  const startNow = (): Promise<boolean> => {
    try {
      return beginStart();
    } catch (err) {
      d.engineMark?.clear();
      toast(STR.startFailed(errText(err)));
      return Promise.resolve(false);
    }
  };

  const beginStart = (): Promise<boolean> => {
    const state = d.audio.peek().state;
    if (state === 'starting' || state === 'running') return Promise.resolve(true);
    if (state === 'interrupted') return audioCtl.recover(); // recreate-in-tap (spec §6.3)
    const s = d.settings.peek();
    const params = d.teslaParams.peek();
    if (params === null) {
      toast(STR.noTesla);
      return Promise.resolve(false);
    }
    mcu ??= d.mcu();
    const init = buildStartInit(s, d.engine.peek(), params, { mcu, nowMs: now(), moving: gpsMoving() });
    fwd.markSent(init.messages, init.route);
    d.engineMark?.set();
    let started: Promise<void>;
    try {
      started = audioCtl.start(init); // synchronously, inside the user's click
    } catch (err) {
      started = Promise.reject(err);
    }
    return started.then(
      () => {
        if (s.liteNextStart) d.updateSettings({ liteNextStart: false });
        return true;
      },
      (err: unknown) => {
        d.engineMark?.clear();
        // EngineAudio reports a failed start as audio 'error' too, which the AudioAlert keeps on screen.
        if (d.audio.peek().state !== 'error') toast(STR.startFailed(errText(err)));
        return false;
      },
    );
  };

  const shell: Shell = {
    startEngine() {
      if (stopping === null) return startNow();
      // Tapped while the engine fades out (EngineAudio still reports 'running'): start again once the
      // stop has finished, with the settings of that moment — unless another stop comes first.
      if (queuedStart === null) {
        const at = stops;
        queuedStart = stopping.then(() => (at === stops ? startNow() : false));
      }
      return queuedStart;
    },
    stopEngine() {
      const wasOn = engineOn();
      fwd.reset();
      d.engineMark?.clear();
      queuedStart = null;
      const at = ++stops;
      if (wasOn) d.updateSettings({ engineWarmAt: now() });
      const settled = (async (): Promise<void> => {
        try {
          await audioCtl.stop();
        } catch (err) {
          toast(errText(err));
        }
      })().then(() => {
        if (at === stops) stopping = null;
      });
      stopping = settled;
      return settled;
    },
    recover: () => audioCtl.recover(),
    post(msg) {
      const patch = settingsPatchOf(msg);
      if (patch !== null) {
        d.updateSettings(patch);
        return;
      }
      fwd.note(msg);
      audioCtl.post(msg);
    },
    toast,
    onMediaAction(listener) {
      mediaListeners.add(listener);
      return () => {
        mediaListeners.delete(listener);
      };
    },
    diagnostics: () => audioCtl.diagnostics,
  };

  return {
    shell,
    audio: audioCtl,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

// ───────────────────────────── GPS ─────────────────────────────

export interface GpsOptions {
  method: 'poll' | 'watch';
  highAccuracy: boolean;
  latencyS: number;
}

/** The part of GpsSource (contract T5) the shell uses. */
export interface GpsLike {
  start(o: GpsOptions): void;
  stop(): void;
  parked(nowMs?: number): boolean;
}

export interface GpsDeps {
  settings: ReadonlySignal<Settings>;
  gps: Signal<GpsState>;
  audio: ReadonlySignal<AudioState>;
  /** Fix → worklet (EngineAudio.post). Coordinates go nowhere else (contract: privacy). */
  post(msg: FixMsg): void;
  /** The GPS poller around the shell's callbacks, or null without geolocation (desktop): then
   * store.gps stays 'off', which counts as parked. */
  createGps(onFix: (fix: FixMsg) => void, onStatus: (status: GpsStatus) => void): GpsLike | null;
  now?: () => number;
}

/** What wireGps gives the shell. */
export interface GpsWiring {
  /**
   * Contract "Engine warm" — GPS speed > 0: the last fix arrived less than GPS_FRESH_MS ago and
   * reported a speed above 0. A stale fix (the car repeating its cached fix, spec §3) and an unknown
   * or zero speed (Intel MCU2 reports 0 or null while moving; a parked car reports 0) prove nothing:
   * a reload mid-drive starts warm through engineWarmAt instead (createShell records it on pagehide).
   */
  moving(): boolean;
  dispose(): void;
}

/** store.gps refresh period: `parked` and the fix age change with time alone. */
export const GPS_REFRESH_MS = 1000;

/** A fix is current for this long after it arrived (the parked rule's 3 s, spec §10.1). */
export const GPS_FRESH_MS = 3000;

/**
 * Runs the GPS poller from boot, whatever the speed source — the real-GPS parked estimate locks
 * Settings while moving (contract global rules). Restarts it when a GPS setting changes, mirrors
 * status / parked / fix age into `store.gps`, and forwards fixes to the worklet only while audio
 * runs with the GPS source selected. `store.gps.fixAgeS` is the raw age (arrival − GPS timestamp, as
 * the probe measured it, spec §10.2), without the gpsLatencyS calibration FixMsg.ageS includes.
 */
export function wireGps(d: GpsDeps): GpsWiring {
  const now = d.now ?? Date.now;
  let status: GpsStatus = d.gps.peek().status;
  let fixArrivedAt: number | null = null;
  let fixAgeAtArrivalS = 0;
  let fixSpeedMps: number | null = null;
  /** The gpsLatencyS that GpsSource adds to every fix's age: the options of the last start(). */
  let latencyS = 0;
  let source: GpsLike | null = null;

  const refresh = (): void => {
    if (source === null) return;
    const fixAgeS = fixArrivedAt === null ? null : fixAgeAtArrivalS + (now() - fixArrivedAt) / 1000;
    const next: GpsState = { status, parked: source.parked(), fixAgeS };
    const cur = d.gps.peek();
    if (cur.status !== next.status || cur.parked !== next.parked || cur.fixAgeS !== next.fixAgeS) d.gps.value = next;
  };

  const moving = (): boolean => {
    if (fixArrivedAt === null || fixSpeedMps === null) return false;
    const sinceMs = now() - fixArrivedAt;
    return sinceMs >= 0 && sinceMs < GPS_FRESH_MS && fixSpeedMps > 0; // NaN-safe
  };

  source = d.createGps(
    (fix) => {
      fixArrivedAt = now();
      fixAgeAtArrivalS = fix.ageS - latencyS;
      fixSpeedMps = fix.speedMps;
      if (d.audio.peek().state === 'running' && d.settings.peek().source === 'gps') d.post(fix);
      refresh();
    },
    (s) => {
      status = s;
      refresh();
    },
  );
  if (source === null) return { moving, dispose: () => {} };
  const src = source;

  // GpsSource.start() restarts by itself when the method or accuracy changes (and only takes the new
  // latency otherwise). stop() first would report 'off' — which the store counts as parked.
  const options = computed(() => {
    const s = d.settings.value;
    const o: GpsOptions = { method: s.gpsMethod, highAccuracy: s.highAccuracy, latencyS: s.gpsLatencyS };
    return JSON.stringify(o);
  });
  const stopOptions = effect(() => {
    const o = JSON.parse(options.value) as GpsOptions;
    latencyS = o.latencyS;
    src.start(o);
  });
  refresh();
  const timer = setInterval(refresh, GPS_REFRESH_MS);

  return {
    moving,
    dispose: () => {
      stopOptions();
      clearInterval(timer);
      src.stop();
    },
  };
}
