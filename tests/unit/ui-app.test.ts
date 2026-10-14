import { batch, computed, signal } from '@preact/signals';
import { h, type ComponentChildren, type VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIM_TUNING,
  F,
  S,
  STATE_LEN,
  minTouchCssPx,
  type FixMsg,
  type MainToWorklet,
  type OutputRoute,
} from '../../src/contracts';
import { DEFAULT_SETTINGS, sanitizeSettings, teslaParamsFor, type Settings } from '../../src/app/settings';
import type { AudioState, GpsState, GpsStatus, Screen } from '../../src/app/store';
import { GpsSource } from '../../src/audio/gps-source';
import { getEngine } from '../../src/data/engines';
import { BUILD_SHA } from '../../src/platform/build-info';
import {
  App,
  AudioAlert,
  ConfigForwarder,
  GPS_FRESH_MS,
  LITE_NEXT_OVERLOAD_S,
  SCREEN_VIEWS,
  ScreenBoundary,
  TOAST_MS,
  WARM_WINDOW_MS,
  applyTouchSize,
  buildStartInit,
  createShell,
  initialScreen,
  isWarmStart,
  outputConfigOf,
  sessionFlag,
  showUnsupported,
  trackTouchSize,
  unsupportedReason,
  wireConfig,
  wireGps,
  type GpsLike,
  type ScreenProps,
  type ScreenViews,
  type Shell,
  type ShellAudio,
  type ShellDeps,
} from '../../src/ui/app';
import type { EngineAudioCallbacks, EngineAudioDiagnostics, EngineAudioStart } from '../../src/audio/engine-audio';
import { STR } from '../../src/ui/strings';

// ───────────────────────────── helpers ─────────────────────────────

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const TESLA_ID = 'model3-highland-lr-awd';
const HOUR_MS = 60 * 60 * 1000;

/** Valid settings with a Tesla chosen and the notices seen, plus `over`. */
function settingsWith(over: Partial<Settings> = {}): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: TESLA_ID, noticesSeen: true, ...over });
}

/** Minimal string renderer for hook-free component trees: tags, id/class/role/data-* and text. */
function html(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') return String(node);
  if (Array.isArray(node)) return node.map((n) => html(n as ComponentChildren)).join('');
  const v = node as VNode<Record<string, unknown>>;
  if (typeof v.type === 'function') {
    const proto = (v.type as { prototype?: { render?: unknown } }).prototype;
    if (typeof proto?.render === 'function') {
      const Cls = v.type as unknown as new (p: unknown) => { props: unknown; state: unknown; render(p: unknown, s: unknown): ComponentChildren };
      const inst = new Cls(v.props);
      inst.props = v.props;
      return html(inst.render(inst.props, inst.state));
    }
    return html((v.type as (p: unknown) => ComponentChildren)(v.props));
  }
  const attrs = Object.entries(v.props)
    .filter(([k, val]) => /^(id|class|role|data-[a-z-]+|aria-[a-z]+)$/.test(k) && val !== undefined && val !== false)
    .map(([k, val]) => ` ${k}="${String(val)}"`)
    .join('');
  return `<${v.type}${attrs}>${html(v.props.children as ComponentChildren)}</${v.type}>`;
}

/** The first element of `type` in a hook-free tree (function components are called). */
function findEl(node: ComponentChildren, type: string): VNode<Record<string, unknown>> | null {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n as ComponentChildren, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  const v = node as VNode<Record<string, unknown>>;
  if (v.type === type) return v;
  if (typeof v.type === 'function') return findEl((v.type as (p: unknown) => ComponentChildren)(v.props), type);
  return findEl(v.props.children as ComponentChildren, type);
}

/** The warm flag a start init carries. */
function warmOf(init: EngineAudioStart | undefined): boolean | undefined {
  const m = init?.messages.find((x) => x.type === 'warm');
  return m?.type === 'warm' ? m.warm : undefined;
}

const DIAG: EngineAudioDiagnostics = {
  contextState: 'running',
  sampleRate: 48000,
  baseLatencyS: 0.01,
  outputLatencyS: 0.04,
  latencyHint: 'balanced',
  recoveries: { resumeOk: 1, resumeFail: 0, recreate: 2 },
  bench: null,
};

class FakeAudio implements ShellAudio {
  starts: EngineAudioStart[] = [];
  posted: MainToWorklet[] = [];
  routes: OutputRoute[] = [];
  visibility: boolean[] = [];
  stops = 0;
  recovers = 0;
  startImpl: () => Promise<void> = () => Promise.resolve();
  private holdNextStop = false;
  private endFade: (() => void) | null = null;
  constructor(readonly cb: EngineAudioCallbacks) {}
  get diagnostics(): EngineAudioDiagnostics {
    return DIAG;
  }
  start(init: EngineAudioStart): Promise<void> {
    this.starts.push(init);
    return this.startImpl();
  }
  post(msg: MainToWorklet): void {
    this.posted.push(msg);
  }
  setRoute(route: OutputRoute): Promise<void> {
    this.routes.push(route);
    return Promise.resolve();
  }
  recover(): Promise<boolean> {
    this.recovers++;
    return Promise.resolve(true);
  }
  setVisibility(hidden: boolean): void {
    this.visibility.push(hidden);
  }
  /** The next stop() keeps reporting 'running' (EngineAudio's STOP_FADE_MS) until the returned function ends the fade. */
  holdStop(): () => void {
    this.holdNextStop = true;
    return () => this.endFade?.();
  }
  /** Like EngineAudio: 'off' is published when the fade is over, then the promise resolves. */
  stop(): Promise<void> {
    this.stops++;
    const off = (): void => this.cb.onState({ state: 'off', route: 'direct-anchor', tier: null });
    if (!this.holdNextStop) {
      off();
      return Promise.resolve();
    }
    this.holdNextStop = false;
    return new Promise((resolve) => {
      this.endFade = () => {
        this.endFade = null;
        off();
        resolve();
      };
    });
  }
}

class FakeDoc {
  hidden = false;
  devicePixelRatio = 1;
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** sessionStorage stand-in. */
class MemStorage {
  readonly items = new Map<string, string>();
  getItem(k: string): string | null {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.items.set(k, v);
  }
  removeItem(k: string): void {
    this.items.delete(k);
  }
}

function fixture(over: Partial<Settings> = {}) {
  const settings = signal<Settings>(settingsWith(over));
  const engine = computed(() => getEngine(settings.value.engineId));
  const teslaParams = computed(() => teslaParamsFor(settings.value));
  const audio = signal<AudioState>({ state: 'off', route: settings.value.outputRoute, tier: null });
  const snapshot = signal(new Float64Array(STATE_LEN));
  const gps = signal<GpsState>({ status: 'off', parked: false, fixAgeS: null });
  const toast = signal<string | null>(null);
  const patches: Partial<Settings>[] = [];
  const updateSettings = (patch: Partial<Settings>): boolean => {
    patches.push(patch);
    settings.value = sanitizeSettings({ ...settings.peek(), ...patch });
    return true;
  };
  return { settings, engine, teslaParams, audio, snapshot, gps, toast, patches, updateSettings };
}

type Fixture = ReturnType<typeof fixture>;

type ShellOpts = Partial<Pick<ShellDeps, 'doc' | 'page' | 'gpsMoving' | 'engineMark' | 'mcu'>>;

function makeShell(f: Fixture, opts: ShellOpts = {}) {
  let fake: FakeAudio | null = null;
  const made = createShell({
    ...f,
    createAudio: (cb) => (fake = new FakeAudio(cb)),
    mcu: () => 'amd',
    now: () => NOW,
    ...opts,
  });
  if (fake === null) throw new Error('createShell did not create the audio controller');
  return { ...made, fake: fake as FakeAudio };
}

const running = (f: Fixture): void => {
  f.audio.value = { ...f.audio.peek(), state: 'running' };
};

const OFF: AudioState = { state: 'off', route: 'direct-anchor', tier: null };

// ───────────────────────────── router ─────────────────────────────

describe('App router', () => {
  const view = (name: string) => (): ComponentChildren => h('p', { class: 'view' }, name);
  const views: ScreenViews = {
    'first-run': view('first-run'),
    garage: view('garage'),
    drive: view('drive'),
    settings: view('settings'),
    diagnostics: view('diagnostics'),
  };
  const shell = makeShell(fixture()).shell;
  const audio = signal<AudioState>(OFF);

  it('renders the view of the current screen, with the footer (disclaimer + build SHA) except on Drive', () => {
    const screen = signal<Screen>('garage');
    const toast = signal<string | null>(null);
    for (const s of ['first-run', 'garage', 'settings', 'diagnostics'] as const) {
      screen.value = s;
      const out = html(App({ screen, toast, audio, shell, views }));
      expect(out).toContain(`<p class="view">${s}</p>`);
      expect(out).toContain(`<p id="build-sha" class="build">${STR.build(BUILD_SHA)}</p>`);
      expect(out).toContain(STR.disclaimer);
    }
    screen.value = 'drive';
    const drive = html(App({ screen, toast, audio, shell, views }));
    expect(drive).toBe('<p class="view">drive</p>');
  });

  it('falls back to the garage for an unknown screen value', () => {
    const screen = signal('nowhere' as Screen);
    expect(html(App({ screen, toast: signal(null), audio, shell, views }))).toContain('<p class="view">garage</p>');
  });

  it('shows the store toast as a status message', () => {
    const toast = signal<string | null>('Saved');
    const out = html(App({ screen: signal<Screen>('drive'), toast, audio, shell, views }));
    expect(out).toContain('<div class="toast" role="status">Saved</div>');
  });

  it('passes the shell to the screen', () => {
    let got: ScreenProps | null = null;
    const spy: ScreenViews = { ...views, garage: (p: ScreenProps) => ((got = p), null) };
    html(App({ screen: signal<Screen>('garage'), toast: signal(null), audio, shell, views: spy }));
    expect(got).toEqual({ shell });
  });

  it('contains a screen that throws: the error and a reload button instead of a blank page', () => {
    const boundary = new ScreenBoundary({ children: h('p', null, 'fine') });
    expect(html(boundary.render())).toBe('<p>fine</p>');
    boundary.state = ScreenBoundary.getDerivedStateFromError(new Error('kaput'));
    expect(html(boundary.render())).toBe(
      `<section class="screen" role="alert"><h1>${STR.screenError}</h1><p class="muted">kaput</p><button class="btn-primary">${STR.actions.reload}</button></section>`,
    );
  });

  it('has a view for every screen', () => {
    expect(Object.keys(SCREEN_VIEWS).sort()).toEqual(['diagnostics', 'drive', 'first-run', 'garage', 'settings']);
    for (const v of Object.values(SCREEN_VIEWS)) expect(typeof v).toBe('function');
  });

  it('keeps a failed audio start on every screen until the next start (spec §6.5: the error string, not just a toast)', () => {
    const failed = signal<AudioState>({ ...OFF, state: 'error', message: 'addModule timed out after 10000 ms' });
    const alert = `<div class="audio-alert banner bad" role="alert"><p>${STR.audioFailed('addModule timed out after 10000 ms')}</p><button class="btn-primary">${STR.actions.tryAgain}</button></div>`;
    for (const s of ['first-run', 'garage', 'drive', 'settings', 'diagnostics'] as const) {
      expect(html(App({ screen: signal<Screen>(s), toast: signal(null), audio: failed, shell, views }))).toContain(alert);
    }
    for (const state of ['off', 'starting', 'running', 'interrupted'] as const) {
      failed.value = { ...OFF, state };
      expect(html(App({ screen: signal<Screen>('drive'), toast: signal(null), audio: failed, shell, views }))).not.toContain('audio-alert');
    }
  });

  it("the alert's Try again starts the engine from the tap", () => {
    let starts = 0;
    const spyShell: Shell = {
      ...shell,
      startEngine: () => {
        starts++;
        return Promise.resolve(true);
      },
    };
    const failed = signal<AudioState>({ ...OFF, state: 'error' });
    const button = findEl(AudioAlert({ audio: failed, shell: spyShell }), 'button');
    expect(html(AudioAlert({ audio: failed, shell: spyShell }))).toContain(`<p>${STR.audioFailed(STR.audioStates.error)}</p>`);
    (button?.props.onClick as () => void)();
    expect(starts).toBe(1);
  });
});

// ───────────────────────────── unsupported ─────────────────────────────

describe('Unsupported fallback (main.ts side)', () => {
  const ctor = function AudioThing(): void {};

  it('reports the first missing Web Audio feature, or null when supported', () => {
    expect(unsupportedReason({})).toBe(STR.unsupported.noAudioContext);
    expect(unsupportedReason({ AudioContext: ctor })).toBe(STR.unsupported.noAudioWorklet);
    expect(unsupportedReason({ AudioWorkletNode: ctor })).toBe(STR.unsupported.noAudioContext);
    expect(unsupportedReason({ AudioContext: ctor, AudioWorkletNode: ctor })).toBeNull();
  });

  it('reveals #unsupported with the reason and hides #app', () => {
    const els: Record<string, { hidden: boolean; textContent: string }> = {
      unsupported: { hidden: true, textContent: '' },
      'unsupported-reason': { hidden: false, textContent: '' },
      app: { hidden: false, textContent: '' },
    };
    const doc = { getElementById: (id: string) => els[id] ?? null } as unknown as Document;
    showUnsupported(doc, 'why');
    expect(els.unsupported?.hidden).toBe(false);
    expect(els['unsupported-reason']?.textContent).toBe('why');
    expect(els.app?.hidden).toBe(true);
    expect(() => showUnsupported({ getElementById: () => null } as unknown as Document, 'x')).not.toThrow();
  });
});

// ───────────────────────────── touch size ─────────────────────────────

describe('touch targets from the runtime devicePixelRatio (spec §7.1: ≥ 22 mm on any Tesla panel)', () => {
  const root = () => {
    const props = new Map<string, string>();
    return { props, style: { setProperty: (name: string, value: string): void => void props.set(name, value) } };
  };

  it('sets --touch to minTouchCssPx(dpr); a missing or nonsensical ratio counts as 1', () => {
    const r = root();
    applyTouchSize(r, 1.53);
    expect(r.props.get('--touch')).toBe(`${minTouchCssPx(1.53)}px`);
    expect(r.props.get('--touch')).toBe('108px');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      applyTouchSize(r, bad);
      expect(r.props.get('--touch'), String(bad)).toBe(`${minTouchCssPx(1)}px`);
    }
  });

  it('applies at once and follows a zoom change (resize) until removed', () => {
    const r = root();
    const win = new FakeDoc();
    win.devicePixelRatio = 1.53;
    const remove = trackTouchSize(win, r);
    expect(r.props.get('--touch')).toBe('108px');
    win.devicePixelRatio = 1.96;
    win.fire('resize');
    expect(r.props.get('--touch')).toBe(`${minTouchCssPx(1.96)}px`);
    remove();
    expect(win.count('resize')).toBe(0);
  });
});

// ───────────────────────────── start init ─────────────────────────────

describe('engine start parameters', () => {
  it('starts warm within 30 min of the last stop, or when already rolling (contract "Engine warm")', () => {
    expect(WARM_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(isWarmStart(null, NOW, false)).toBe(false);
    expect(isWarmStart(NOW - 10 * 60 * 1000, NOW, false)).toBe(true);
    expect(isWarmStart(NOW - WARM_WINDOW_MS, NOW, false)).toBe(false);
    expect(isWarmStart(NOW + 60_000, NOW, false)).toBe(false); // clock went backwards: not trusted
    expect(isWarmStart(null, NOW, true)).toBe(true);
  });

  it('builds the EngineAudio.start init from the settings: route, hint, tier pref, MCU, name and every config message', () => {
    const s = settingsWith({
      engineId: 'v8-na-50',
      subwoofer: 'no',
      hpCornerHz: 45,
      volumeTrimDb: -6,
      source: 'demo',
      gearboxMode: 'manual',
      driveMode: 'sport',
      valve: 'open',
      perspective: 'outside',
      gpsLatencyS: 1.5,
      outputRoute: 'media-element',
      tierPref: 'full',
      engineWarmAt: NOW - 60_000,
    });
    const def = getEngine('v8-na-50');
    const params = teslaParamsFor(s);
    if (params === null) throw new Error('fixture Tesla must resolve');
    const init = buildStartInit(s, def, params, { mcu: 'intel', nowMs: NOW, moving: false });
    expect(init).toEqual({
      route: 'media-element',
      latencyHint: 'balanced',
      tierPref: 'full',
      mcu: 'intel',
      engineName: def.name,
      messages: [
        { type: 'engine', def },
        { type: 'tesla', params },
        { type: 'output', config: { subwoofer: 'no', hpCornerHz: 45, volumeTrimDb: -6 } },
        { type: 'source', value: 'demo' },
        { type: 'tuning', value: { ...DEFAULT_SIM_TUNING, gpsLatencyS: 1.5 } },
        { type: 'gearboxMode', value: 'manual' },
        { type: 'driveMode', value: 'sport' },
        { type: 'valve', mode: 'open' },
        { type: 'perspective', value: 'outside' },
        { type: 'warm', warm: true },
      ],
    });
    expect(outputConfigOf(s)).toEqual({ subwoofer: 'no', hpCornerHz: 45, volumeTrimDb: -6 });
  });

  it('forces Lite for one start after an overload (liteNextStart)', () => {
    const s = settingsWith({ tierPref: 'auto', liteNextStart: true });
    const params = teslaParamsFor(s);
    if (params === null) throw new Error('fixture Tesla must resolve');
    const init = buildStartInit(s, getEngine(s.engineId), params, { mcu: 'amd', nowMs: NOW, moving: false });
    expect(init.tierPref).toBe('lite');
    expect(init.messages.at(-1)).toEqual({ type: 'warm', warm: false });
  });
});

// ───────────────────────────── config forwarding ─────────────────────────────

describe('wireConfig: settings changes → worklet (contract T2: "the shell forwards engine/tesla/output/mode changes")', () => {
  let f: Fixture;
  let sink: { posted: MainToWorklet[]; routes: OutputRoute[]; post(m: MainToWorklet): void; setRoute(r: OutputRoute): Promise<void> };
  let fwd: ConfigForwarder;
  let dispose: () => void;

  /** What the shell's start() records as already sent. */
  const markStart = (): void => {
    const s = f.settings.peek();
    const params = f.teslaParams.peek();
    if (params === null) throw new Error('no params');
    const init = buildStartInit(s, f.engine.peek(), params, { mcu: 'amd', nowMs: NOW, moving: false });
    fwd.markSent(init.messages, init.route);
  };

  beforeEach(() => {
    f = fixture();
    sink = {
      posted: [],
      routes: [],
      post(m) {
        this.posted.push(m);
      },
      setRoute(r) {
        this.routes.push(r);
        return Promise.resolve();
      },
    };
    fwd = new ConfigForwarder(sink);
    dispose = wireConfig(f, fwd);
  });
  afterEach(() => dispose());

  it('sends nothing while audio is not running', () => {
    f.updateSettings({ valve: 'open', engineId: 'v8-na-50', volumeTrimDb: -3, outputRoute: 'direct' });
    f.audio.value = { ...f.audio.peek(), state: 'starting' };
    f.updateSettings({ valve: 'closed' });
    f.audio.value = { ...f.audio.peek(), state: 'interrupted' };
    f.updateSettings({ driveMode: 'sport' });
    expect(sink.posted).toEqual([]);
    expect(sink.routes).toEqual([]);
  });

  it('does not repeat what start() already sent', () => {
    markStart();
    running(f);
    expect(sink.posted).toEqual([]);
    expect(sink.routes).toEqual([]);
  });

  it('forwards each changed field once, as its own message', () => {
    markStart();
    running(f);
    f.updateSettings({ valve: 'open' });
    f.updateSettings({ perspective: 'outside' });
    f.updateSettings({ gearboxMode: 'manual' });
    f.updateSettings({ driveMode: 'sport' });
    f.updateSettings({ source: 'keyboard' });
    f.updateSettings({ volumeTrimDb: -9 });
    f.updateSettings({ engineId: 'v8-na-50' });
    expect(sink.posted).toEqual([
      { type: 'valve', mode: 'open' },
      { type: 'perspective', value: 'outside' },
      { type: 'gearboxMode', value: 'manual' },
      { type: 'driveMode', value: 'sport' },
      { type: 'source', value: 'keyboard' },
      { type: 'output', config: { subwoofer: f.settings.peek().subwoofer, hpCornerHz: 40, volumeTrimDb: -9 } },
      { type: 'engine', def: getEngine('v8-na-50') },
    ]);
  });

  it('forwards a new Tesla (or accel mode) as tesla params, and a new route via setRoute', () => {
    markStart();
    running(f);
    f.updateSettings({ teslaId: 'model3-highland-performance', accelMode: null });
    f.updateSettings({ accelMode: 'Chill' });
    f.updateSettings({ outputRoute: 'direct' });
    expect(sink.posted).toEqual([
      { type: 'tesla', params: teslaParamsFor(settingsWith({ teslaId: 'model3-highland-performance' })) },
      { type: 'tesla', params: teslaParamsFor(settingsWith({ teslaId: 'model3-highland-performance', accelMode: 'Chill' })) },
    ]);
    expect(sink.routes).toEqual(['direct']);
  });

  it('ignores settings the worklet does not use', () => {
    markStart();
    running(f);
    f.updateSettings({ units: 'kmh', gamepadSwap: true, manualWarningSeen: true, highAccuracy: true });
    expect(sink.posted).toEqual([]);
  });

  it('sends changes made during starting/interrupted once audio runs, and a value changed back is not sent', () => {
    markStart();
    f.audio.value = { ...f.audio.peek(), state: 'starting' };
    f.updateSettings({ valve: 'closed', driveMode: 'sport' });
    f.updateSettings({ driveMode: 'comfort' });
    running(f);
    expect(sink.posted).toEqual([{ type: 'valve', mode: 'closed' }]);
  });

  it('after reset (engine stopped) the next start is the baseline again', () => {
    markStart();
    running(f);
    f.audio.value = { ...f.audio.peek(), state: 'off' };
    fwd.reset();
    f.updateSettings({ valve: 'open' });
    markStart();
    running(f);
    expect(sink.posted).toEqual([]);
  });

  it('a message noted as sent outside the forwarder is re-synced to the settings by the next change', () => {
    markStart();
    running(f);
    fwd.note({ type: 'source', value: 'keyboard' });
    fwd.note({ type: 'shiftUp' }); // not a forwarded kind: ignored
    f.updateSettings({ units: 'kmh' });
    expect(sink.posted).toEqual([{ type: 'source', value: 'gps' }]);
    fwd.reset();
    fwd.note({ type: 'source', value: 'demo' }); // inactive: nothing recorded
    markStart();
    f.updateSettings({ units: 'mph' });
    expect(sink.posted).toEqual([{ type: 'source', value: 'gps' }]);
  });

  it('a throwing controller never breaks the settings write: the error goes to onError', () => {
    const errors: string[] = [];
    const bad = new ConfigForwarder(
      {
        post: () => {
          throw new Error('port closed');
        },
        setRoute: () => {
          throw new Error('no route');
        },
      },
      (m) => errors.push(m),
    );
    const f2 = fixture();
    const off = wireConfig(f2, bad);
    const params = f2.teslaParams.peek();
    if (params === null) throw new Error('no params');
    const init = buildStartInit(f2.settings.peek(), f2.engine.peek(), params, { mcu: 'amd', nowMs: NOW, moving: false });
    bad.markSent(init.messages, init.route);
    running(f2);
    expect(() => f2.updateSettings({ valve: 'open', outputRoute: 'direct' })).not.toThrow();
    expect(f2.settings.peek().valve).toBe('open');
    expect(errors).toEqual(['port closed', 'no route']);
    off();
  });

  it('stops forwarding once disposed', () => {
    markStart();
    running(f);
    dispose();
    f.updateSettings({ valve: 'open' });
    expect(sink.posted).toEqual([]);
  });
});

// ───────────────────────────── shell ─────────────────────────────

describe('createShell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the engine with the init built from the current settings', async () => {
    const f = fixture({ engineWarmAt: NOW - 5 * 60 * 1000 });
    const { shell, fake } = makeShell(f);
    await expect(shell.startEngine()).resolves.toBe(true);
    expect(fake.starts).toHaveLength(1);
    const params = f.teslaParams.peek();
    if (params === null) throw new Error('no params');
    expect(fake.starts[0]).toEqual(buildStartInit(f.settings.peek(), f.engine.peek(), params, { mcu: 'amd', nowMs: NOW, moving: false }));
    expect(warmOf(fake.starts[0])).toBe(true);
  });

  it('starts warm when the GPS says the car is rolling (contract "Engine warm": GPS speed > 0)', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f, { gpsMoving: () => true });
    await shell.startEngine();
    expect(warmOf(fake.starts[0])).toBe(true);
  });

  it('a store.gps that reads ok and not parked (stale fix, unknown speed) does not make a cold start warm: only gpsMoving counts', async () => {
    const f = fixture({ engineWarmAt: NOW - 2 * HOUR_MS });
    f.gps.value = { status: 'ok', parked: false, fixAgeS: 61 };
    const { shell, fake } = makeShell(f, { gpsMoving: () => false });
    await shell.startEngine();
    expect(warmOf(fake.starts[0])).toBe(false);
  });

  it('calls EngineAudio.start synchronously (inside the click that grants user activation)', () => {
    const { shell, fake } = makeShell(fixture());
    void shell.startEngine();
    expect(fake.starts).toHaveLength(1);
  });

  it('does not start twice while starting or running', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    f.audio.value = { ...f.audio.peek(), state: 'starting' };
    await expect(shell.startEngine()).resolves.toBe(true);
    running(f);
    await expect(shell.startEngine()).resolves.toBe(true);
    expect(fake.starts).toHaveLength(0);
  });

  it('recovers instead of starting again while interrupted', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    f.audio.value = { ...f.audio.peek(), state: 'interrupted' };
    await expect(shell.startEngine()).resolves.toBe(true);
    expect(fake.recovers).toBe(1);
    expect(fake.starts).toHaveLength(0);
  });

  it('refuses to start without a Tesla and says why', async () => {
    const f = fixture({ teslaId: null });
    const { shell, fake } = makeShell(f);
    await expect(shell.startEngine()).resolves.toBe(false);
    expect(fake.starts).toHaveLength(0);
    expect(f.toast.peek()).toBe(STR.noTesla);
  });

  it('reports a failed start in the toast and resolves false', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    fake.startImpl = () => Promise.reject(new Error('addModule failed'));
    await expect(shell.startEngine()).resolves.toBe(false);
    expect(f.toast.peek()).toBe(STR.startFailed('addModule failed'));
  });

  it('never rejects: a synchronous failure while preparing a start (now or queued behind a stop) resolves false with the reason', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f, {
      mcu: () => {
        throw new Error('no WebGL');
      },
    });
    await expect(shell.startEngine()).resolves.toBe(false);
    expect(f.toast.peek()).toBe(STR.startFailed('no WebGL'));
    running(f);
    const endFade = fake.holdStop();
    const stopped = shell.stopEngine();
    const queued = shell.startEngine();
    endFade();
    await stopped;
    await expect(queued).resolves.toBe(false);
    expect(fake.starts).toHaveLength(0);
  });

  it('leaves a start that ended in audio "error" to the persistent alert (no toast repeating it)', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    fake.startImpl = () => {
      fake.cb.onState({ ...OFF, state: 'error', message: 'addModule failed' }); // as EngineAudio.start does
      return Promise.reject(new Error('addModule failed'));
    };
    await expect(shell.startEngine()).resolves.toBe(false);
    expect(f.audio.peek()).toEqual({ ...OFF, state: 'error', message: 'addModule failed' });
    expect(f.toast.peek()).toBeNull();
  });

  it('clears liteNextStart after a start that used it', async () => {
    const f = fixture({ liteNextStart: true });
    const { shell, fake } = makeShell(f);
    await shell.startEngine();
    expect(fake.starts[0]?.tierPref).toBe('lite');
    expect(f.settings.peek().liteNextStart).toBe(false);
  });

  it('does not re-send the start config, then forwards changes', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    await shell.startEngine();
    running(f);
    expect(fake.posted).toEqual([]);
    f.updateSettings({ valve: 'closed' });
    expect(fake.posted).toEqual([{ type: 'valve', mode: 'closed' }]);
  });

  it('stopEngine remembers when the engine stopped and stops audio; later changes are not forwarded', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    await shell.startEngine();
    running(f);
    await shell.stopEngine();
    expect(fake.stops).toBe(1);
    expect(f.settings.peek().engineWarmAt).toBe(NOW);
    expect(f.audio.peek().state).toBe('off');
    f.updateSettings({ valve: 'open' });
    expect(fake.posted).toEqual([]);
  });

  it('stopEngine with the engine already off does not count as a warm stop', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    await shell.stopEngine();
    expect(fake.stops).toBe(1);
    expect(f.settings.peek().engineWarmAt).toBeNull();
  });

  it('records engineWarmAt when the page goes away with the engine on, so a reload mid-drive starts warm (spec §5.3.5)', () => {
    const page = new FakeDoc();
    const f = fixture();
    const { dispose } = makeShell(f, { page });
    page.fire('pagehide');
    expect(f.settings.peek().engineWarmAt).toBeNull(); // engine off: nothing to remember
    running(f);
    page.fire('pagehide');
    expect(f.settings.peek().engineWarmAt).toBe(NOW);
    dispose();
    expect(page.count('pagehide')).toBe(0);
  });

  it('routes EngineAudio callbacks into the store: state, snapshot, errors, media actions', () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    const st: AudioState = { state: 'running', route: 'direct', tier: 'full' };
    fake.cb.onState(st);
    expect(f.audio.peek()).toEqual(st);
    const buf = new Float64Array(STATE_LEN).fill(3);
    fake.cb.onSnapshot(buf);
    expect(f.snapshot.peek()).toBe(buf);
    fake.cb.onError('worklet: boom');
    expect(f.toast.peek()).toBe('worklet: boom');

    const got: string[] = [];
    const off = shell.onMediaAction((a) => got.push(a));
    fake.cb.onMediaAction('nexttrack');
    off();
    fake.cb.onMediaAction('previoustrack');
    expect(got).toEqual(['nexttrack']);
  });

  it('clears a toast after TOAST_MS; a newer toast restarts the clock', () => {
    const f = fixture();
    makeShell(f);
    f.toast.value = 'one';
    vi.advanceTimersByTime(TOAST_MS - 100);
    f.toast.value = 'two';
    vi.advanceTimersByTime(TOAST_MS - 100);
    expect(f.toast.peek()).toBe('two');
    vi.advanceTimersByTime(100);
    expect(f.toast.peek()).toBeNull();
  });

  it('shell.toast shows the same text again for a full TOAST_MS (a signal ignores an equal value)', () => {
    const f = fixture();
    const { shell } = makeShell(f);
    shell.toast('Saved');
    vi.advanceTimersByTime(3000);
    shell.toast('Saved');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(f.toast.peek()).toBe('Saved');
    vi.advanceTimersByTime(1);
    expect(f.toast.peek()).toBeNull();
    batch(() => shell.toast('Again'));
    vi.advanceTimersByTime(3000);
    batch(() => shell.toast('Again'));
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(f.toast.peek()).toBe('Again');
  });

  it('two failed starts with the same error each keep the toast up for TOAST_MS', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    fake.startImpl = () => Promise.reject(new Error('addModule failed'));
    await shell.startEngine();
    vi.advanceTimersByTime(3000);
    await shell.startEngine();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(f.toast.peek()).toBe(STR.startFailed('addModule failed'));
    vi.advanceTimersByTime(1);
    expect(f.toast.peek()).toBeNull();
  });

  it('exposes the live EngineAudio diagnostics (recoveries, latencies, bench) for the Diagnostics screen', () => {
    const { shell } = makeShell(fixture());
    expect(shell.diagnostics()).toBe(DIAG);
  });

  it('passes inputs and recover through, and page visibility to EngineAudio', async () => {
    const doc = new FakeDoc();
    const { shell, fake, dispose } = makeShell(fixture(), { doc });
    shell.post({ type: 'shiftUp' });
    shell.post({ type: 'shiftDown' });
    shell.post({ type: 'pedal', throttle: 1, brake: 0 });
    shell.post({ type: 'testTone', hz: 40, levelDb: -18 });
    shell.post({ type: 'tier', value: 'lite' });
    expect(fake.posted).toEqual([
      { type: 'shiftUp' },
      { type: 'shiftDown' },
      { type: 'pedal', throttle: 1, brake: 0 },
      { type: 'testTone', hz: 40, levelDb: -18 },
      { type: 'tier', value: 'lite' },
    ]);
    await expect(shell.recover()).resolves.toBe(true);
    expect(fake.recovers).toBe(1);
    doc.hidden = true;
    doc.fire('visibilitychange');
    doc.hidden = false;
    doc.fire('visibilitychange');
    expect(fake.visibility).toEqual([true, false]);
    dispose();
    expect(doc.count('visibilitychange')).toBe(0);
  });

  it('post() keeps mode inputs and volume as settings (persisted, shown by the toggles) and sends them while running', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    shell.post({ type: 'valve', mode: 'open' }); // engine off: stored for the next start
    expect(f.settings.peek().valve).toBe('open');
    expect(fake.posted).toEqual([]);
    await shell.startEngine();
    expect(fake.starts[0]?.messages).toContainEqual({ type: 'valve', mode: 'open' });
    running(f);
    shell.post({ type: 'perspective', value: 'outside' });
    shell.post({ type: 'gearboxMode', value: 'manual' });
    shell.post({ type: 'driveMode', value: 'sport' });
    shell.post({ type: 'volume', trimDb: -6 });
    shell.post({ type: 'valve', mode: 'open' }); // unchanged: nothing to send
    expect(f.patches).toEqual([
      { valve: 'open' },
      { perspective: 'outside' },
      { gearboxMode: 'manual' },
      { driveMode: 'sport' },
      { volumeTrimDb: -6 },
      { valve: 'open' },
    ]);
    expect(f.settings.peek()).toMatchObject({ valve: 'open', perspective: 'outside', gearboxMode: 'manual', driveMode: 'sport', volumeTrimDb: -6 });
    expect(fake.posted).toEqual([
      { type: 'perspective', value: 'outside' },
      { type: 'gearboxMode', value: 'manual' },
      { type: 'driveMode', value: 'sport' },
      { type: 'output', config: { subwoofer: f.settings.peek().subwoofer, hpCornerHz: 40, volumeTrimDb: -6 } },
    ]);
  });

  it('a raw config override through post() (a Preview on the keyboard source) lasts until the next settings change re-syncs it', async () => {
    const f = fixture();
    const { shell, fake } = makeShell(f);
    await shell.startEngine();
    running(f);
    shell.post({ type: 'source', value: 'keyboard' });
    expect(f.settings.peek().source).toBe('gps');
    f.updateSettings({ units: 'kmh' });
    expect(fake.posted).toEqual([
      { type: 'source', value: 'keyboard' },
      { type: 'source', value: 'gps' },
    ]);
  });

  describe('a start tapped during the stop fade (EngineAudio reports running until it is off)', () => {
    it('is not lost: the engine starts again once the stop has finished, with the settings of that moment', async () => {
      const f = fixture();
      const { shell, fake } = makeShell(f);
      await shell.startEngine();
      running(f);
      const endFade = fake.holdStop();
      const stopped = shell.stopEngine();
      const restarted = shell.startEngine();
      f.updateSettings({ driveMode: 'sport' }); // during the fade: not forwarded to the dying engine
      expect(f.audio.peek().state).toBe('running');
      expect(fake.starts).toHaveLength(1);
      endFade();
      await stopped;
      await expect(restarted).resolves.toBe(true);
      expect(fake.starts).toHaveLength(2);
      expect(fake.starts[1]?.messages).toContainEqual({ type: 'driveMode', value: 'sport' });
      expect(fake.posted).toEqual([]);
      running(f);
      f.updateSettings({ valve: 'closed' });
      expect(fake.posted).toEqual([{ type: 'valve', mode: 'closed' }]);
    });

    it('repeated taps share one restart', async () => {
      const f = fixture();
      const { shell, fake } = makeShell(f);
      await shell.startEngine();
      running(f);
      const endFade = fake.holdStop();
      const stopped = shell.stopEngine();
      const a = shell.startEngine();
      const b = shell.startEngine();
      expect(b).toBe(a);
      endFade();
      await stopped;
      await expect(a).resolves.toBe(true);
      expect(fake.starts).toHaveLength(2);
    });

    it('a later stop cancels it: stop → start → stop ends off', async () => {
      const f = fixture();
      const { shell, fake } = makeShell(f);
      await shell.startEngine();
      running(f);
      const endFade = fake.holdStop();
      const first = shell.stopEngine();
      const restarted = shell.startEngine();
      const second = shell.stopEngine();
      endFade();
      await Promise.all([first, second]);
      await expect(restarted).resolves.toBe(false);
      expect(fake.starts).toHaveLength(1);
      expect(f.audio.peek().state).toBe('off');
    });

    it('an interrupted engine being stopped is started afresh, not recovered (recover() refuses after stop)', async () => {
      const f = fixture();
      const { shell, fake } = makeShell(f);
      await shell.startEngine();
      f.audio.value = { ...f.audio.peek(), state: 'interrupted' };
      const endFade = fake.holdStop();
      const stopped = shell.stopEngine();
      const restarted = shell.startEngine();
      endFade();
      await stopped;
      await expect(restarted).resolves.toBe(true);
      expect(fake.recovers).toBe(0);
      expect(fake.starts).toHaveLength(2);
    });
  });

  describe('sustained overload mid-drive → persisted "Lite next Start" (spec §5.7)', () => {
    /** A worklet snapshot at worklet time `t` (s): OVERLOAD set unless `overload: false`, bench k 1 unless given. */
    const snap = (t: number, o: { overload?: boolean; benchK?: number } = {}): Float64Array => {
      const b = new Float64Array(STATE_LEN);
      b[S.time] = t;
      b[S.benchK] = o.benchK ?? 1;
      b[S.flags] = o.overload === false ? F.STANDSTILL : F.OVERLOAD | F.STANDSTILL;
      return b;
    };
    /** Snapshots at the worklet's ~30 Hz from `from` to `to` (s). */
    const feed = (fake: FakeAudio, from: number, to: number, o?: { overload?: boolean; benchK?: number }): void => {
      for (let i = 0; from + i / 30 <= to + 1e-9; i++) fake.cb.onSnapshot(snap(from + i / 30, o));
    };
    const tier = (f: Fixture, t: 'full' | 'lite', state: AudioState['state'] = 'running'): void => {
      f.audio.value = { state, route: 'direct-anchor', tier: t };
    };
    const liteWrites = (f: Fixture): Partial<Settings>[] => f.patches.filter((p) => 'liteNextStart' in p);

    it(`sets it once, after OVERLOAD held ${LITE_NEXT_OVERLOAD_S} s of worklet time while rendering Full`, () => {
      const f = fixture();
      const { fake } = makeShell(f);
      tier(f, 'full');
      feed(fake, 10, 10 + LITE_NEXT_OVERLOAD_S - 0.1);
      expect(f.settings.peek().liteNextStart).toBe(false);
      feed(fake, 10 + LITE_NEXT_OVERLOAD_S, 10 + LITE_NEXT_OVERLOAD_S + 5);
      expect(f.settings.peek().liteNextStart).toBe(true);
      expect(liteWrites(f)).toEqual([{ liteNextStart: true }]);
      expect(f.snapshot.peek()[S.time]).toBeCloseTo(10 + LITE_NEXT_OVERLOAD_S + 5);
    });

    it('ignores the start-up benchmark and what it leaves behind, Lite, a stalled engine, a broken run and a restarted clock', () => {
      const f = fixture();
      const { fake } = makeShell(f);
      tier(f, 'full'); // the provisional tier while the benchmark runs
      feed(fake, 0, 2, { benchK: 8 }); // the benchmark's own k = 8 overload
      feed(fake, 2, 4); // still flagged up to 2 s after it (two ~1 s windows)
      feed(fake, 4, 4.1, { overload: false });
      feed(fake, 4.2, 4.2 + LITE_NEXT_OVERLOAD_S - 0.2); // broken run: starts again
      feed(fake, 7.1, 7.2, { overload: false });
      tier(f, 'lite');
      feed(fake, 7.3, 20); // already Lite
      tier(f, 'full', 'interrupted');
      feed(fake, 20, 30);
      tier(f, 'full');
      feed(fake, 30, 30 + LITE_NEXT_OVERLOAD_S - 0.5);
      feed(fake, 0, LITE_NEXT_OVERLOAD_S - 0.5); // a rebuilt context restarts its clock at 0
      expect(liteWrites(f)).toEqual([]);
    });

    it('does not write again while the flag is already set', () => {
      const f = fixture({ liteNextStart: true });
      const { fake } = makeShell(f);
      tier(f, 'full');
      feed(fake, 10, 20);
      expect(liteWrites(f)).toEqual([]);
    });
  });
});

// ───────────────────────────── reload mid-drive ─────────────────────────────

describe('reload mid-drive (spec §6.3: restore settings, show Start immediately)', () => {
  const KEY = 'tesbox.v1.engineOn';

  it('sessionFlag: set until taken once; blocked, missing or full sessionStorage reads as unset and never throws', () => {
    const mem = new MemStorage();
    const flag = sessionFlag(KEY, () => mem);
    expect(flag.take()).toBe(false);
    flag.set();
    expect(mem.items.get(KEY)).toBe('1');
    expect(flag.take()).toBe(true);
    expect(flag.take()).toBe(false);
    flag.set();
    flag.clear();
    expect(flag.take()).toBe(false);

    const blocked = sessionFlag(KEY, () => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => {
      blocked.set();
      blocked.clear();
    }).not.toThrow();
    expect(blocked.take()).toBe(false);
    expect(sessionFlag(KEY, () => undefined).take()).toBe(false);
    const full = sessionFlag(KEY, () => ({
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {},
    }));
    expect(() => full.set()).not.toThrow();
  });

  it('initialScreen: the engine was on when the page went away → Drive, whose Start overlay shows at once; first run still wins', () => {
    expect(initialScreen('garage', true)).toBe('drive');
    expect(initialScreen('garage', false)).toBe('garage');
    expect(initialScreen('first-run', true)).toBe('first-run');
    expect(initialScreen('first-run', false)).toBe('first-run');
  });

  it('the shell marks the engine on (per tab) from a start until stopEngine; a failed start clears it', async () => {
    const mem = new MemStorage();
    const f = fixture();
    const { shell, fake } = makeShell(f, { engineMark: sessionFlag(KEY, () => mem) });
    void shell.startEngine();
    expect(mem.items.has(KEY)).toBe(true); // a reload while it is still starting reopens Drive too
    running(f);
    await shell.stopEngine();
    expect(mem.items.has(KEY)).toBe(false);
    fake.startImpl = () => Promise.reject(new Error('no'));
    await shell.startEngine();
    expect(mem.items.has(KEY)).toBe(false);
  });
});

// ───────────────────────────── gps ─────────────────────────────

class FakeGps implements GpsLike {
  starts: { method: 'poll' | 'watch'; highAccuracy: boolean; latencyS: number }[] = [];
  stops = 0;
  isParked = true;
  constructor(
    readonly onFix: (f: FixMsg) => void,
    readonly onStatus: (s: GpsStatus) => void,
  ) {}
  /** Like GpsSource: (re)starting reports 'waiting'. */
  start(o: { method: 'poll' | 'watch'; highAccuracy: boolean; latencyS: number }): void {
    this.starts.push(o);
    this.onStatus('waiting');
  }
  stop(): void {
    this.stops++;
  }
  parked(): boolean {
    return this.isParked;
  }
}

describe('wireGps: GpsSource → store.gps and fixes → worklet', () => {
  let clock = NOW;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = NOW;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(over: Partial<Settings> = {}) {
    const f = fixture(over);
    const posted: FixMsg[] = [];
    let gps: FakeGps | null = null;
    const wiring = wireGps({
      settings: f.settings,
      gps: f.gps,
      audio: f.audio,
      post: (m) => posted.push(m),
      createGps: (onFix, onStatus) => (gps = new FakeGps(onFix, onStatus)),
      now: () => clock,
    });
    if (gps === null) throw new Error('wireGps did not create the GPS source');
    return { f, posted, gps: gps as FakeGps, wiring };
  }

  /** A FixMsg as GpsSource posts it: ageS = raw age + gpsLatencyS (default 1 s). */
  const fix = (ageS = 1.2, speedMps: number | null = 0): FixMsg => ({ type: 'fix', ageS, speedMps, lat: 0, lon: 0, accuracyM: 5, altitudeM: null });

  it('starts at once with the settings options; the status is whatever the source reports', () => {
    const { f, gps } = setup({ gpsMethod: 'watch', highAccuracy: true, gpsLatencyS: 0.8 });
    expect(gps.starts).toEqual([{ method: 'watch', highAccuracy: true, latencyS: 0.8 }]);
    expect(f.gps.peek().status).toBe('waiting');
  });

  it('re-applies the options only when a GPS setting changes, through start() alone (no "off" flash, which would read as parked)', () => {
    const { f, gps } = setup();
    const statuses: string[] = [];
    f.gps.subscribe((g) => statuses.push(g.status));
    f.updateSettings({ volumeTrimDb: -3, units: 'kmh' });
    expect(gps.starts).toHaveLength(1);
    f.updateSettings({ highAccuracy: true });
    f.updateSettings({ gpsLatencyS: 0.5 });
    expect(gps.starts).toEqual([
      { method: 'poll', highAccuracy: false, latencyS: 1 },
      { method: 'poll', highAccuracy: true, latencyS: 1 },
      { method: 'poll', highAccuracy: true, latencyS: 0.5 },
    ]);
    expect(gps.stops).toBe(0);
    expect(statuses).not.toContain('off');
  });

  it('mirrors status, parked estimate and fix age into store.gps, refreshed every second', () => {
    const { f, gps } = setup();
    gps.isParked = false;
    gps.onStatus('ok');
    gps.onFix(fix(1.2));
    expect(f.gps.peek()).toMatchObject({ status: 'ok', parked: false });
    expect(f.gps.peek().fixAgeS).toBeCloseTo(0.2);
    clock += 2000;
    gps.isParked = true;
    vi.advanceTimersByTime(1000);
    expect(f.gps.peek()).toMatchObject({ status: 'ok', parked: true });
    expect(f.gps.peek().fixAgeS).toBeCloseTo(2.2);
    gps.onStatus('denied');
    expect(f.gps.peek().status).toBe('denied');
  });

  it('fix age is the raw age (arrival − GPS timestamp, as the probe measured it): the gpsLatencyS calibration is taken back out', () => {
    const { f, gps } = setup({ gpsLatencyS: 0.5 });
    gps.onFix(fix(0.8));
    expect(f.gps.peek().fixAgeS).toBeCloseTo(0.3);
    f.updateSettings({ gpsLatencyS: 2 });
    gps.onFix(fix(2.05));
    expect(f.gps.peek().fixAgeS).toBeCloseTo(0.05);
  });

  it(`moving: only a fix that arrived < ${GPS_FRESH_MS} ms ago with a speed above 0 (contract "Engine warm": GPS speed > 0)`, () => {
    const { gps, wiring } = setup();
    expect(wiring.moving()).toBe(false); // no fix yet
    gps.onFix(fix(1.2, 8));
    expect(wiring.moving()).toBe(true);
    clock += GPS_FRESH_MS - 1;
    expect(wiring.moving()).toBe(true);
    clock += 1; // stale: e.g. the car repeating its cached fix, which GpsSource drops (spec §3)
    expect(wiring.moving()).toBe(false);
    gps.onFix(fix(1.2, 8));
    expect(wiring.moving()).toBe(true);
    clock -= 10_000; // a clock stepping back proves nothing
    expect(wiring.moving()).toBe(false);
  });

  it('moving: an unknown or zero speed is not proof (Intel MCU2 reports 0 or null; a parked AMD car reports 0), whatever the parked estimate', () => {
    const { gps, wiring } = setup();
    gps.isParked = false; // GpsSource: no 2 s of fixes yet → speed unknown → not parked
    for (const speed of [0, null, Number.NaN, -1]) {
      gps.onFix(fix(1.2, speed));
      expect(wiring.moving(), String(speed)).toBe(false);
    }
  });

  it('forwards fixes to the worklet only while audio runs with the GPS source', () => {
    const { f, gps, posted } = setup({ source: 'gps' });
    gps.onFix(fix());
    running(f);
    gps.onFix(fix(0.9));
    f.updateSettings({ source: 'demo' });
    gps.onFix(fix(1.1));
    expect(posted).toEqual([fix(0.9)]);
  });

  it('never invents a status: before the source reports one, store.gps stays as it was', () => {
    const f = fixture();
    wireGps({
      settings: f.settings,
      gps: f.gps,
      audio: f.audio,
      post: () => {},
      createGps: () => ({ start: () => {}, stop: () => {}, parked: () => true }),
    });
    expect(f.gps.peek()).toEqual({ status: 'off', parked: true, fixAgeS: null });
  });

  it('does nothing without geolocation (never moving)', () => {
    const f = fixture();
    const wiring = wireGps({ settings: f.settings, gps: f.gps, audio: f.audio, post: () => {}, createGps: () => null });
    expect(f.gps.peek().status).toBe('off');
    expect(wiring.moving()).toBe(false);
    expect(() => wiring.dispose()).not.toThrow();
  });

  it('dispose stops the source and the refresh timer', () => {
    const { f, gps, wiring } = setup();
    wiring.dispose();
    expect(gps.stops).toBe(1);
    const before = f.gps.peek();
    clock += 5000;
    vi.advanceTimersByTime(5000);
    expect(f.gps.peek()).toBe(before);
  });
});

describe('engine warm from the real GPS (GpsSource → wireGps.moving → createShell)', () => {
  let clock = NOW;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clock = NOW;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const position = (timestamp: number, speed: number | null): GeolocationPosition =>
    ({
      timestamp,
      coords: { latitude: 0, longitude: 0, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed },
    }) as unknown as GeolocationPosition;

  /** Polls `answer(now)` for `seconds`, then taps Start; returns the warm flag sent and store.gps at the tap. */
  async function startAfter(answer: (nowMs: number) => GeolocationPosition, seconds: number, over: Partial<Settings> = {}) {
    const f = fixture(over);
    const geo = {
      getCurrentPosition: (ok: PositionCallback) => ok(answer(clock)),
      watchPosition: () => 0,
      clearWatch: () => {},
    } as unknown as Geolocation;
    const gps = wireGps({
      settings: f.settings,
      gps: f.gps,
      audio: f.audio,
      post: () => {},
      now: () => clock,
      createGps: (onFix, onStatus) => new GpsSource(geo, onFix, onStatus, () => clock),
    });
    const { shell, fake } = makeShell(f, { gpsMoving: gps.moving });
    for (let i = 0; i < seconds; i++) {
      clock += 1000;
      vi.advanceTimersByTime(1000);
    }
    const atTap = f.gps.peek();
    await shell.startEngine();
    gps.dispose();
    return { warm: warmOf(fake.starts[0]), atTap };
  }

  it('the car repeating its cached fix (Intel MCU2, spec §3) is not rolling: a start 2 h after the stop is cold', async () => {
    const cached = position(NOW - 30_000, 12);
    const { warm, atTap } = await startAfter(() => cached, 61, { engineWarmAt: NOW - 2 * HOUR_MS });
    expect(atTap).toMatchObject({ status: 'ok', parked: false }); // what the old rule took for "rolling"
    expect(warm).toBe(false);
  });

  it('a parked car reporting speed 0 on its first fixes (AMD) is cold', async () => {
    const { warm, atTap } = await startAfter((now) => position(now - 300, 0), 1);
    expect(atTap).toMatchObject({ status: 'ok', parked: false }); // speed still unknown to the parked estimate
    expect(warm).toBe(false);
  });

  it('a fresh fix reporting a speed (AMD while driving) is warm', async () => {
    const { warm } = await startAfter((now) => position(now - 300, 12), 3);
    expect(warm).toBe(true);
  });
});
