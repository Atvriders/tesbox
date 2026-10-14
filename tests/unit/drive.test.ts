import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { F, type MainToWorklet } from '../../src/contracts';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../../src/app/settings';
import type { AudioStatus } from '../../src/app/store';
import type { MediaAction } from '../../src/audio/engine-audio';
import { getEngine } from '../../src/data/engines';
import type { GamepadHost } from '../../src/input/gamepad';
import { InputLog, type InputEvent } from '../../src/ui/diagnostics';
import {
  LONG_PRESS_MS,
  StartOverlay,
  attachDriveInputs,
  bindLongPress,
  driveStatus,
  flagEdges,
  flashGear,
  gearLabel,
  gearboxTap,
  loadLevel,
  nextValve,
  speedValue,
  type DriveInputDeps,
  type StartOverlayProps,
} from '../../src/ui/drive';
import { STR } from '../../src/ui/strings';
import { button, buttonTexts, byType, click, isDisabled, only, renderTree, textOf } from './helpers/vnode-tree';

// ───────────────────────────── readouts ─────────────────────────────

describe('gearLabel', () => {
  it('shows N before ignition (gear 0) and the gear number after', () => {
    expect(gearLabel(0)).toBe('N');
    expect(gearLabel(1)).toBe('1');
    expect(gearLabel(8)).toBe('8');
  });

  it('shows a dash for anything that is not a gear', () => {
    expect(gearLabel(Number.NaN)).toBe('–');
    expect(gearLabel(-1)).toBe('–');
    expect(gearLabel(2.5)).toBe('–');
  });
});

describe('speedValue', () => {
  it('converts m/s to whole mph or km/h', () => {
    expect(speedValue(10, 'mph')).toBe(22); // 22.37
    expect(speedValue(10, 'kmh')).toBe(36);
    expect(speedValue(26.8224, 'mph')).toBe(60);
    expect(speedValue(27.7778, 'kmh')).toBe(100);
  });

  it('never shows a negative speed and has no value without one', () => {
    expect(speedValue(-0.3, 'kmh')).toBe(0);
    expect(speedValue(Number.NaN, 'mph')).toBeNull();
  });
});

describe('loadLevel — the load bar', () => {
  it('fills with throttle load and with overrun (engine braking) shown as such', () => {
    expect(loadLevel(0.6)).toEqual({ fraction: 0.6, overrun: false });
    expect(loadLevel(-0.4)).toEqual({ fraction: 0.4, overrun: true });
    expect(loadLevel(0)).toEqual({ fraction: 0, overrun: false });
  });

  it('clamps to the bar and treats noise around zero as no overrun', () => {
    expect(loadLevel(1.3)).toEqual({ fraction: 1, overrun: false });
    expect(loadLevel(-0.01)).toEqual({ fraction: 0.01, overrun: false });
    expect(loadLevel(Number.NaN)).toEqual({ fraction: 0, overrun: false });
  });
});

// ───────────────────────────── status dot ─────────────────────────────

describe('driveStatus — the status dot (GPS / audio / headroom)', () => {
  const running = { audio: 'running', source: 'gps', gps: 'ok', flags: 0, liteNextStart: false } as const;

  it('is off with the engine off and green when everything runs', () => {
    expect(driveStatus({ ...running, audio: 'off' })).toEqual({ level: 'off', reasons: ['engineOff'] });
    expect(driveStatus(running)).toEqual({ level: 'ok', reasons: [] });
  });

  it('reports audio trouble first', () => {
    expect(driveStatus({ ...running, audio: 'error' })).toEqual({ level: 'bad', reasons: ['audioError'] });
    expect(driveStatus({ ...running, audio: 'interrupted' })).toEqual({ level: 'warn', reasons: ['interrupted'] });
    expect(driveStatus({ ...running, audio: 'starting' })).toEqual({ level: 'warn', reasons: ['starting'] });
  });

  it('judges GPS only when GPS is the speed source', () => {
    expect(driveStatus({ ...running, gps: 'waiting' })).toEqual({ level: 'warn', reasons: ['gpsWaiting'] });
    expect(driveStatus({ ...running, gps: 'unavailable' })).toEqual({ level: 'warn', reasons: ['gpsUnavailable'] });
    expect(driveStatus({ ...running, gps: 'denied' })).toEqual({ level: 'bad', reasons: ['gpsDenied'] });
    expect(driveStatus({ ...running, gps: 'off' })).toEqual({ level: 'bad', reasons: ['gpsMissing'] });
    expect(driveStatus({ ...running, flags: F.GPS_LOST | F.PREDICTING })).toEqual({
      level: 'bad',
      reasons: ['gpsLost', 'predicting'],
    });
    expect(driveStatus({ ...running, flags: F.PREDICTING })).toEqual({ level: 'warn', reasons: ['predicting'] });
    expect(driveStatus({ ...running, source: 'demo', gps: 'denied', flags: F.GPS_LOST })).toEqual({ level: 'ok', reasons: [] });
  });

  it('shows headroom: red while overloaded, amber when the next start falls back to Lite', () => {
    expect(driveStatus({ ...running, source: 'demo', flags: F.OVERLOAD })).toEqual({ level: 'bad', reasons: ['overload'] });
    expect(driveStatus({ ...running, liteNextStart: true })).toEqual({ level: 'warn', reasons: ['liteNext'] });
    expect(driveStatus({ ...running, gps: 'waiting', flags: F.OVERLOAD })).toEqual({
      level: 'bad',
      reasons: ['gpsWaiting', 'overload'],
    });
  });

  it('does not alarm on the latched position-only path (Intel speed 0)', () => {
    expect(driveStatus({ ...running, flags: F.SPEED_UNUSABLE | F.STANDSTILL })).toEqual({ level: 'ok', reasons: [] });
  });
});

describe('flagEdges — gear readout flashes', () => {
  it('fires once when a shift starts and when a downshift is refused', () => {
    expect(flagEdges(0, F.SHIFTING)).toEqual({ shifting: true, refused: false });
    expect(flagEdges(F.SHIFTING, F.SHIFTING)).toEqual({ shifting: false, refused: false });
    expect(flagEdges(F.LIMITER, F.SHIFT_REFUSED | F.LIMITER)).toEqual({ shifting: false, refused: true });
    expect(flagEdges(F.SHIFT_REFUSED, 0)).toEqual({ shifting: false, refused: false });
  });

  it('treats an unknown previous value as no flags', () => {
    expect(flagEdges(Number.NaN, F.SHIFTING)).toEqual({ shifting: true, refused: false });
  });
});

describe('flashGear — restarts the one-shot gear animation', () => {
  /** classList + offsetWidth (the reflow flashGear forces). */
  function fakeGear(): { el: HTMLElement; classes: Set<string>; reflows: number } {
    const g = { classes: new Set<string>(['gear']), reflows: 0, el: null as unknown as HTMLElement };
    g.el = {
      classList: {
        add: (...c: string[]) => c.forEach((x) => g.classes.add(x)),
        remove: (...c: string[]) => c.forEach((x) => g.classes.delete(x)),
      },
      get offsetWidth() {
        g.reflows++;
        return 100;
      },
    } as unknown as HTMLElement;
    return g;
  }

  it('leaves only the newest flash class, so a shift flash after a refused one still plays', () => {
    const g = fakeGear();
    flashGear(g.el, 'refused');
    flashGear(g.el, 'shifting');
    expect([...g.classes].sort()).toEqual(['gear', 'shifting']);
    flashGear(g.el, 'refused');
    expect([...g.classes].sort()).toEqual(['gear', 'refused']);
  });

  it('forces a reflow between removing and re-adding the class (that is what restarts it)', () => {
    const g = fakeGear();
    flashGear(g.el, 'shifting');
    flashGear(g.el, 'shifting');
    expect(g.reflows).toBe(2);
  });
});

// ───────────────────────────── toggles ─────────────────────────────

describe('nextValve', () => {
  it('cycles Auto → Open → Closed → Auto', () => {
    expect(nextValve('auto')).toBe('open');
    expect(nextValve('open')).toBe('closed');
    expect(nextValve('closed')).toBe('auto');
  });
});

describe('gearboxTap — Auto|Manual toggle with the one-time warning (parked only)', () => {
  it('goes back to Auto at any time', () => {
    expect(gearboxTap({ current: 'manual', warningSeen: false, parked: false })).toBe('auto');
  });

  it('switches to Manual once the warning has been seen, parked or not', () => {
    expect(gearboxTap({ current: 'auto', warningSeen: true, parked: false })).toBe('manual');
    expect(gearboxTap({ current: 'auto', warningSeen: true, parked: true })).toBe('manual');
  });

  it('shows the warning first while parked, and refuses the first enable while moving', () => {
    expect(gearboxTap({ current: 'auto', warningSeen: false, parked: true })).toBe('warn');
    expect(gearboxTap({ current: 'auto', warningSeen: false, parked: false })).toBe('locked');
  });
});

// ───────────────────────────── Start overlay ─────────────────────────────

describe('StartOverlay — Start engine, with Settings and Diagnostics still in reach', () => {
  function overlay(over: Partial<StartOverlayProps> = {}): { tree: ReturnType<typeof renderTree>; calls: string[] } {
    const calls: string[] = [];
    const props: StartOverlayProps = {
      engine: getEngine(DEFAULT_SETTINGS.engineId),
      source: 'demo',
      audio: 'off',
      parked: true,
      banner: null,
      onStart: () => void calls.push('start'),
      onGarage: () => void calls.push('garage'),
      onSettings: () => void calls.push('settings'),
      onDiagnostics: () => void calls.push('diagnostics'),
      ...over,
    };
    return { tree: renderTree(h(StartOverlay, props)), calls };
  }

  it('names the engine and offers Start engine, Garage, Settings and Diagnostics', () => {
    const { tree, calls } = overlay();
    expect(textOf(only(tree, byType('h1')))).toBe(getEngine(DEFAULT_SETTINGS.engineId).name);
    expect(buttonTexts(tree)).toEqual([STR.actions.startEngine, STR.drive.garage, STR.actions.settings, STR.actions.diagnostics]);
    for (const b of [STR.actions.startEngine, STR.drive.garage, STR.actions.settings, STR.actions.diagnostics]) click(button(tree, b));
    expect(calls).toEqual(['start', 'garage', 'settings', 'diagnostics']);
  });

  it('keeps Settings and Diagnostics open after a failed start and while starting (the overlay covers the status dot and Settings)', () => {
    for (const audio of ['error', 'starting'] as const) {
      const { tree, calls } = overlay({ audio });
      click(button(tree, STR.actions.settings));
      click(button(tree, STR.actions.diagnostics));
      expect(calls).toEqual(['settings', 'diagnostics']);
    }
    expect(isDisabled(button(overlay({ audio: 'starting' }).tree, STR.drive.starting))).toBe(true);
  });

  it('locks Settings while moving; Diagnostics stays open', () => {
    const { tree } = overlay({ parked: false });
    expect(isDisabled(button(tree, STR.actions.settings))).toBe(true);
    expect(isDisabled(button(tree, STR.actions.diagnostics))).toBe(false);
  });
});

// ───────────────────────────── long press ─────────────────────────────

type Listener = (e: unknown) => void;

/** The EventTarget slice the input code uses. */
class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  dispatch(type: string, init: object = {}): { defaultPrevented: boolean } {
    const e = {
      type,
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
      ...init,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e);
    return e;
  }
}

describe('bindLongPress — status dot → Diagnostics after 700 ms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after holding for 700 ms', () => {
    expect(LONG_PRESS_MS).toBe(700);
    const el = new FakeTarget();
    let fired = 0;
    bindLongPress(el as unknown as HTMLElement, () => fired++);
    el.dispatch('pointerdown');
    vi.advanceTimersByTime(699);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(1);
  });

  it('does not fire when released, cancelled or left early', () => {
    const el = new FakeTarget();
    let fired = 0;
    bindLongPress(el as unknown as HTMLElement, () => fired++);
    for (const end of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.dispatch('pointerdown');
      vi.advanceTimersByTime(600);
      el.dispatch(end);
      vi.advanceTimersByTime(600);
    }
    expect(fired).toBe(0);
  });

  it('ignores secondary mouse buttons and suppresses the touch context menu', () => {
    const el = new FakeTarget();
    let fired = 0;
    bindLongPress(el as unknown as HTMLElement, () => fired++);
    el.dispatch('pointerdown', { button: 2 });
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(0);
    expect(el.dispatch('contextmenu').defaultPrevented).toBe(true);
  });

  it('unbinds: no listeners and no pending fire', () => {
    const el = new FakeTarget();
    let fired = 0;
    const off = bindLongPress(el as unknown as HTMLElement, () => fired++);
    el.dispatch('pointerdown');
    off();
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(0);
    expect(el.count()).toBe(0);
  });
});

// ───────────────────────────── input wiring ─────────────────────────────

/** A KeyboardEvent as Chromium fills it (US layout). */
function key(type: 'keydown' | 'keyup', code: string, keyName: string, over: object = {}): object {
  return {
    code,
    key: keyName,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target: { tagName: 'BODY' },
    ...over,
    type,
  };
}

interface Harness {
  posts: MainToWorklet[];
  recovers: number;
  media: Set<(a: MediaAction) => void>;
  win: FakeTarget;
  log: InputLog;
  settings: Settings;
  audio: AudioStatus;
  nowMs: number;
  deps: DriveInputDeps;
  press(code: string, keyName: string, over?: object): void;
  release(code: string, keyName: string): void;
  action(a: MediaAction): void;
  logged(): string[];
}

function harness(over: Partial<Settings> = {}): Harness {
  const h = {
    posts: [] as MainToWorklet[],
    recovers: 0,
    media: new Set<(a: MediaAction) => void>(),
    win: new FakeTarget(),
    log: new InputLog(),
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: 'model3-highland-lr-awd', noticesSeen: true, ...over }),
    audio: 'running' as AudioStatus,
    nowMs: 10_000,
  } as Harness;
  h.deps = {
    shell: {
      post: (m) => {
        h.posts.push(m);
      },
      recover: () => {
        h.recovers++;
        return Promise.resolve(true);
      },
      onMediaAction: (l) => {
        h.media.add(l);
        return () => {
          h.media.delete(l);
        };
      },
    },
    settings: () => h.settings,
    audio: () => h.audio,
    keyTarget: h.win as unknown as DriveInputDeps['keyTarget'],
    gamepadHost: null,
    log: h.log,
    now: () => h.nowMs,
  };
  h.press = (code, keyName, o = {}) => void h.win.dispatch('keydown', key('keydown', code, keyName, o));
  h.release = (code, keyName) => void h.win.dispatch('keyup', key('keyup', code, keyName));
  h.action = (a) => {
    for (const l of [...h.media]) l(a);
  };
  h.logged = () => h.log.entries().map((e: InputEvent) => `${e.source} ${e.detail}`);
  return h;
}

describe('attachDriveInputs', () => {
  it('shifts on E / Q and on the paddles, logging each', () => {
    const h = harness();
    const inputs = attachDriveInputs(h.deps);
    h.press('KeyE', 'e');
    h.press('KeyQ', 'q');
    inputs.shift(1, 'paddle');
    inputs.shift(-1, 'paddle');
    expect(h.posts).toEqual([{ type: 'shiftUp' }, { type: 'shiftDown' }, { type: 'shiftUp' }, { type: 'shiftDown' }]);
    expect(h.logged()).toEqual(['key E: shift up', 'key Q: shift down', 'paddle shift up', 'paddle shift down']);
  });

  it('V cycles the valves from the current setting and P flips the perspective', () => {
    const h = harness({ valve: 'open', perspective: 'cabin' });
    attachDriveInputs(h.deps);
    h.press('KeyV', 'v');
    h.press('KeyP', 'p');
    expect(h.posts).toEqual([
      { type: 'valve', mode: 'closed' },
      { type: 'perspective', value: 'outside' },
    ]);
    expect(h.logged()).toEqual(['key V: valves closed', 'key P: perspective outside']);
  });

  it('drives the pedals with W / S / Space on the Keyboard source only', () => {
    const demo = harness({ source: 'demo' });
    attachDriveInputs(demo.deps);
    demo.press('KeyW', 'w');
    expect(demo.posts).toEqual([]);

    const kb = harness({ source: 'keyboard' });
    attachDriveInputs(kb.deps);
    kb.press('KeyW', 'w');
    kb.release('KeyW', 'w');
    kb.press('Space', ' ');
    expect(kb.posts).toEqual([
      { type: 'pedal', throttle: 1, brake: 0 },
      { type: 'pedal', throttle: 0, brake: 0 },
      { type: 'pedal', throttle: 0, brake: 1 },
    ]);
    expect(kb.logged()).toEqual(['key pedal throttle 1 brake 0', 'key pedal throttle 0 brake 0', 'key pedal throttle 0 brake 1']);
  });

  it('shifts on steering-wheel tilts only when wheel shifting is enabled, logging them either way', () => {
    const off = harness();
    attachDriveInputs(off.deps);
    off.action('nexttrack');
    off.press('MediaTrackPrevious', 'MediaTrackPrevious');
    expect(off.posts).toEqual([]);
    expect(off.logged()).toEqual(['media nexttrack: wheel shifting off', 'key MediaTrackPrevious: wheel shifting off']);

    const on = harness({ wheelShift: { tested: true, works: true, enabled: true } });
    attachDriveInputs(on.deps);
    on.action('nexttrack');
    on.nowMs += 5000;
    on.press('MediaTrackPrevious', 'MediaTrackPrevious');
    expect(on.posts).toEqual([{ type: 'shiftUp' }, { type: 'shiftDown' }]);
  });

  it('counts a tilt delivered as both a key and an action once (900 ms dedupe)', () => {
    const h = harness({ wheelShift: { tested: true, works: true, enabled: true } });
    attachDriveInputs(h.deps);
    h.press('MediaTrackNext', 'MediaTrackNext');
    h.nowMs += 120;
    h.action('nexttrack');
    expect(h.posts).toEqual([{ type: 'shiftUp' }]);
    expect(h.logged()[1]).toBe('media nexttrack: duplicate');
  });

  it('never shifts on play / pause, and ignores held media keys', () => {
    const h = harness({ wheelShift: { tested: true, works: true, enabled: true } });
    attachDriveInputs(h.deps);
    h.action('play');
    h.action('pause');
    h.press('MediaTrackNext', 'MediaTrackNext', { repeat: true });
    expect(h.posts).toEqual([]);
    expect(h.recovers).toBe(0);
  });

  it('a media action or key while audio is interrupted recovers (it grants activation) instead of shifting', () => {
    const h = harness({ wheelShift: { tested: true, works: true, enabled: true } });
    h.audio = 'interrupted';
    attachDriveInputs(h.deps);
    h.action('nexttrack');
    h.nowMs += 5000;
    h.action('play');
    h.nowMs += 5000;
    h.action('pause');
    expect(h.recovers).toBe(2);
    h.nowMs += 5000; // past the 900 ms key/action dedupe window
    h.press('MediaTrackNext', 'MediaTrackNext');
    h.nowMs += 5000;
    h.press('MediaTrackPrevious', 'MediaTrackPrevious');
    expect(h.recovers).toBe(4);
    expect(h.posts).toEqual([]);
    expect(h.logged()).toEqual([
      'media nexttrack: resume',
      'media play: resume',
      'media pause',
      'key MediaTrackNext: resume',
      'key MediaTrackPrevious: resume',
    ]);
  });

  it('acts on gamepad shoulder buttons through the gamepad poller', () => {
    const h = harness();
    const frames: FrameRequestCallback[] = [];
    const pad = {
      id: 'pad',
      index: 0,
      connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    const host: GamepadHost = {
      requestAnimationFrame: (cb) => frames.push(cb),
      cancelAnimationFrame: () => {},
      navigator: { getGamepads: () => [pad as unknown as Gamepad] },
    };
    attachDriveInputs({ ...h.deps, gamepadHost: host });
    const run = (t: number): void => {
      const cb = frames.shift();
      cb?.(t);
    };
    run(0); // baseline
    pad.buttons[5] = { pressed: true, touched: true, value: 1 };
    run(100);
    expect(h.posts).toEqual([{ type: 'shiftUp' }]);
    expect(h.logged()).toEqual(['gamepad shift up']);
  });

  it('stops polling the gamepad when detached', () => {
    const h = harness();
    const frames = new Map<number, FrameRequestCallback>();
    let next = 1;
    const host: GamepadHost = {
      requestAnimationFrame: (cb) => {
        frames.set(next, cb);
        return next++;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      },
      navigator: { getGamepads: () => [] },
    };
    const inputs = attachDriveInputs({ ...h.deps, gamepadHost: host });
    expect(frames.size).toBe(1);
    inputs.detach();
    expect(frames.size).toBe(0);
  });

  it('detaches every listener and the media subscription', () => {
    const h = harness({ wheelShift: { tested: true, works: true, enabled: true } });
    const inputs = attachDriveInputs(h.deps);
    inputs.detach();
    h.press('KeyE', 'e');
    h.action('nexttrack');
    expect(h.posts).toEqual([]);
    expect(h.media.size).toBe(0);
    expect(h.win.count()).toBe(0);
  });
});
