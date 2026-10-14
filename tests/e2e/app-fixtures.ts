/**
 * Shared harness of the app e2e specs (tests/e2e/app-*.spec.ts; phase-3 contract T9). Not a spec.
 *
 * Every app test gets `app`, which installs before any page script:
 * - a worklet tap: the messages the app posts to the `tesbox` AudioWorklet (engine definitions reduced to
 *   their id, fixes without coordinates), the worklet's 'state' snapshots (the S.* indices of
 *   src/contracts.ts), and the Media Session action handlers the app registers — calling one is a
 *   simulated steering-wheel tilt (spec §6.2, §7.2);
 * - with the `tone` option, the dominant frequency of the worklet's output every 100 ms, read from an
 *   AnalyserNode tapped in parallel with whatever route the app connects (the bass-sweep tones, spec §9.3);
 * - a watch that fails the test on a Content-Security-Policy violation, an uncaught page error or a
 *   console error (contract acceptance 7: zero CSP violations).
 *
 * Positions used anywhere in these specs are fake (around 0, 0): no real coordinates in the repo.
 */
import { expect, test as base, type CDPSession, type Page } from '@playwright/test';
import { S } from '../../src/contracts';
import type { Settings } from '../../src/app/settings';
import { STR } from '../../src/ui/strings';

/** localStorage key of the persisted settings (src/platform/storage.ts prefix + SETTINGS_KEY). */
export const SETTINGS_STORAGE_KEY = 'tesbox.v1.settings';

/** The acceptance car: Model 3 Highland Long Range AWD (contract acceptance 1). */
export const TESLA_ID = 'model3-highland-lr-awd';

/** A finished first run: the car chosen and the notices seen. The app opens the garage. */
export const PICKED: Partial<Settings> = { teslaId: TESLA_ID, noticesSeen: true };

/** The default engine (settings default `engineId`). */
export const DEFAULT_ENGINE = 'i5-turbo-25';

/** One message the app posted to the worklet (summarised: see the file header). */
export type PostedMsg = { type: string } & Record<string, unknown>;

export interface ToneReading {
  /** performance.now() of the reading, ms (the clock of PostedRecord.t). */
  t: number;
  /** Mean frequency of the last 0.25 s of output, from its rising zero crossings; null if too few. */
  hz: number | null;
  /** Largest deviation of one period from the mean period, relative: ≈ 0 for a clean sine. */
  spread: number | null;
  rms: number;
}

interface PostedRecord {
  t: number;
  msg: PostedMsg;
}

/** What the init script keeps in the page, as `window.__tbx`. */
export interface Tap {
  posted: PostedRecord[];
  /** Latest worklet snapshots (oldest first, capped); stateCount counts every one received. */
  states: number[][];
  stateCount: number;
  media: Record<string, ((details: { action: string }) => void) | null>;
  tones: ToneReading[];
}

interface TapWindow {
  __tbx?: Tap;
  __tbxCsp?: (violation: string) => void;
}

/**
 * The init script (serialised into the page: self-contained, no outer references). Wraps the
 * AudioWorkletNode constructor, MediaSession.setActionHandler and, with `tone`, AudioNode.connect.
 */
function installTap(opts: { tone: boolean }): void {
  const w = window as unknown as TapWindow & Record<string, unknown>;
  const tap: Tap = { posted: [], states: [], stateCount: 0, media: {}, tones: [] };
  w.__tbx = tap;

  document.addEventListener('securitypolicyviolation', (e) => {
    w.__tbxCsp?.(`${e.violatedDirective} blocked ${e.blockedURI}`);
  });

  const ms = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
  if (ms !== undefined && typeof ms.setActionHandler === 'function') {
    const setHandler = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      tap.media[action] = handler as ((details: { action: string }) => void) | null;
      setHandler(action, handler);
    };
  }

  const Native = w.AudioWorkletNode as typeof AudioWorkletNode | undefined;
  if (typeof Native !== 'function') return; // the Unsupported specs delete it first
  const tesboxNodes = new WeakSet<AudioNode>();

  /** Engine definitions by id, fixes without coordinates; everything else as posted. */
  const summarise = (msg: unknown): PostedMsg => {
    const m = msg as PostedMsg;
    if (m.type === 'engine') return { type: 'engine', id: (m.def as { id: string }).id };
    if (m.type === 'fix') return { type: 'fix', speedMps: m.speedMps, ageS: m.ageS };
    return JSON.parse(JSON.stringify(m)) as PostedMsg;
  };

  class TappedNode extends Native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      if (name !== 'tesbox') return;
      tesboxNodes.add(this);
      const port = this.port;
      const post = port.postMessage.bind(port) as (message: unknown, transfer?: Transferable[]) => void;
      port.postMessage = ((message: unknown, transfer?: Transferable[]) => {
        tap.posted.push({ t: performance.now(), msg: summarise(message) });
        if (transfer === undefined) post(message);
        else post(message, transfer);
      }) as MessagePort['postMessage'];
      // The app sets port.onmessage, which starts the port: listeners added here hear every message.
      port.addEventListener('message', (e: MessageEvent<unknown>) => {
        const data = e.data as { type?: unknown; buf?: unknown } | null;
        if (data === null || data.type !== 'state' || !(data.buf instanceof Float64Array)) return;
        tap.stateCount++;
        tap.states.push(Array.from(data.buf));
        if (tap.states.length > 6000) tap.states.splice(0, 1000);
      });
    }
  }
  w.AudioWorkletNode = TappedNode;

  if (!opts.tone) return;
  let analyser: AnalyserNode | null = null;
  const nativeConnect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
  // EngineAudio disconnects the node and connects its route on every (re)build and route change; the
  // analyser is connected beside each route connection, so it always hears what the route plays.
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]): unknown {
    const result = nativeConnect.apply(this, args);
    if (tesboxNodes.has(this) && !(args[0] instanceof AnalyserNode)) {
      if (analyser === null || analyser.context !== this.context) {
        analyser = this.context.createAnalyser();
        analyser.fftSize = 32768;
      }
      nativeConnect.call(this, analyser);
    }
    return result;
  } as typeof AudioNode.prototype.connect;
  const buf = new Float32Array(32768);
  setInterval(() => {
    const an = analyser;
    if (an === null) return;
    an.getFloatTimeDomainData(buf);
    const n = Math.round(0.25 * an.context.sampleRate);
    const ups: number[] = [];
    let sumSq = 0;
    for (let i = buf.length - n; i < buf.length; i++) {
      const x = buf[i] ?? 0;
      const prev = buf[i - 1] ?? 0;
      sumSq += x * x;
      if (prev < 0 && x >= 0) ups.push(i - 1 + prev / (prev - x)); // interpolated rising zero crossing
    }
    let hz: number | null = null;
    let spread: number | null = null;
    if (ups.length >= 3) {
      const periods: number[] = [];
      for (let k = 1; k < ups.length; k++) periods.push((ups[k] ?? 0) - (ups[k - 1] ?? 0));
      const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
      spread = Math.max(...periods.map((p) => Math.abs(p - mean))) / mean;
      hz = an.context.sampleRate / mean;
    }
    tap.tones.push({ t: performance.now(), hz, spread, rms: Math.sqrt(sumSq / n) });
    if (tap.tones.length > 3000) tap.tones.splice(0, 500);
  }, 100);
}

/** A fake GPS fed through the DevTools geolocation override (with `coords.speed`), re-issued every 500 ms. */
export interface FakeGps {
  /** Drives north at `speedMps` from wherever the car is (0 = parked: the same position, speed 0). */
  drive(speedMps: number): Promise<void>;
  stop(): void;
}

/** The test's view of the page: storage seeding, the worklet tap and a few screen actions. */
export class AppHarness {
  /** Console messages a test expects (matched before the teardown check). */
  readonly allowedConsole: RegExp[] = [];
  /** Run at teardown, whether the test passed or not (fake GPS timers). */
  readonly cleanups: (() => void)[] = [];

  constructor(readonly page: Page) {}

  /** Writes the stored settings (an object, raw text, or null to clear them) for the next load of the app. */
  async seed(settings: Partial<Settings> | string | null): Promise<void> {
    await this.page.goto('/version.json'); // same origin, no app code
    await this.page.evaluate(
      ([key, value]) => {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      },
      [SETTINGS_STORAGE_KEY, typeof settings === 'string' || settings === null ? settings : JSON.stringify(settings)] as const,
    );
  }

  /** Seeds `settings` (when given) and opens the app. */
  async open(settings?: Partial<Settings> | string | null): Promise<void> {
    if (settings !== undefined) await this.seed(settings);
    await this.page.goto('/');
  }

  /** The settings in localStorage, parsed (null when absent). */
  async stored(): Promise<Settings | null> {
    const raw = await this.page.evaluate((key) => localStorage.getItem(key), SETTINGS_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as Settings);
  }

  async tap(): Promise<Tap> {
    const tap = await this.page.evaluate(() => (window as unknown as TapWindow).__tbx ?? null);
    if (tap === null) throw new Error('the worklet tap is not installed');
    return tap;
  }

  /** Messages posted to the worklet since load, optionally of one type. */
  async posted(type?: string): Promise<PostedMsg[]> {
    const tap = await this.tap();
    return tap.posted.map((p) => p.msg).filter((m) => type === undefined || m.type === type);
  }

  async stateCount(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as TapWindow).__tbx?.stateCount ?? 0);
  }

  /** The newest worklet snapshot, or null before the first. */
  async lastState(): Promise<number[] | null> {
    return this.page.evaluate(() => (window as unknown as TapWindow).__tbx?.states.at(-1) ?? null);
  }

  /** Every snapshot kept so far (oldest first). */
  async states(): Promise<number[][]> {
    return this.page.evaluate(() => (window as unknown as TapWindow).__tbx?.states ?? []);
  }

  /** Waits until the newest snapshot satisfies `pred`, and returns it. */
  async waitForState(pred: (s: number[]) => boolean, timeout = 15_000, what = 'worklet state'): Promise<number[]> {
    const hits: number[][] = [];
    await expect
      .poll(
        async () => {
          const s = await this.lastState();
          if (s !== null && pred(s)) hits.push(s);
          return hits.length > 0;
        },
        { timeout, message: what },
      )
      .toBe(true);
    return hits[0] ?? [];
  }

  /** Calls the app's Media Session handler for `action`, as the browser does for a wheel tilt or press. */
  async mediaAction(action: 'play' | 'pause' | 'nexttrack' | 'previoustrack'): Promise<void> {
    const called = await this.page.evaluate((a) => {
      const handler = (window as unknown as TapWindow).__tbx?.media[a];
      if (typeof handler !== 'function') return false;
      handler({ action: a });
      return true;
    }, action);
    expect(called, `a Media Session handler for ${action}`).toBe(true);
  }

  /** The gear readout on Drive. */
  gear() {
    return this.page.getByRole('status', { name: STR.drive.gearLabel });
  }

  /** The screen on show (`data-screen` of the routed view). */
  screen() {
    return this.page.locator('#app [data-screen]').first();
  }

  /** Drive with its inputs attached (keys, paddles, Media Session): the first input is never lost. */
  async driveReady(): Promise<void> {
    await expect(this.page.locator('[data-screen="drive"][data-inputs="ready"]')).toBeVisible();
  }

  /** Taps Start engine on Drive and waits until the engine runs in gear (snapshots arriving). */
  async startEngine(): Promise<void> {
    await this.page.getByRole('button', { name: STR.actions.startEngine, exact: true }).click();
    await expect(this.page.getByRole('dialog', { name: STR.actions.startEngine })).toBeHidden({ timeout: 15_000 });
    await this.waitForState((s) => (s[S.gear] ?? 0) >= 1, 15_000, 'the engine runs in gear');
  }

  /** Holds a pointer on `target` for `ms` (the 700 ms long press that opens Diagnostics). */
  async longPress(target: ReturnType<Page['locator']>, ms = 900): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box === null) throw new Error('long-press target is not rendered');
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.down();
    await this.page.waitForTimeout(ms);
    await this.page.mouse.up();
  }

  /**
   * A fake GPS through the DevTools geolocation override (it carries `coords.speed`, which Playwright's
   * setGeolocation cannot). Needs the geolocation permission. Each override is a new fix with a fresh
   * timestamp; the app polls about once a second. Call before opening the app.
   */
  async fakeGps(start = { latitude: 0.001, longitude: 0.001 }): Promise<FakeGps> {
    const cdp: CDPSession = await this.page.context().newCDPSession(this.page);
    let lat = start.latitude;
    let speed = 0;
    let lastMs = Date.now();
    const send = async (): Promise<void> => {
      const now = Date.now();
      lat += (speed * (now - lastMs)) / 1000 / 111_195; // metres north → degrees of latitude
      lastMs = now;
      await cdp.send('Emulation.setGeolocationOverride', { latitude: lat, longitude: start.longitude, accuracy: 5, speed });
    };
    await send();
    const timer = setInterval(() => void send().catch(() => undefined), 500);
    const stop = (): void => clearInterval(timer);
    this.cleanups.push(stop);
    return {
      drive: async (speedMps: number) => {
        speed = speedMps;
        await send();
      },
      stop,
    };
  }
}

/** The extended `test`: `app` (always on) and the `tone` option (output frequency readings). */
export const test = base.extend<{ app: AppHarness; tone: boolean }>({
  tone: [false, { option: true }],
  app: async ({ page, tone }, use) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await page.exposeFunction('__tbxCsp', (violation: string) => problems.push(`CSP violation: ${violation}`));
    await page.addInitScript(installTap, { tone });
    const app = new AppHarness(page);
    try {
      await use(app);
    } finally {
      for (const cleanup of app.cleanups) cleanup();
    }
    const unexpected = problems.filter((p) => !app.allowedConsole.some((re) => re.test(p)));
    expect(unexpected, 'CSP violations, page errors and console errors').toEqual([]);
  },
});

export { expect, S, STR };
