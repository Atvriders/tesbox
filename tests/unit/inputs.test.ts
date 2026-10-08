import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputProbe } from '../../src/probe/inputs';
import { EventLog } from '../../src/probe/log';

type Listener = (e: unknown) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly added: { type: string; options: unknown }[] = [];
  addEventListener(type: string, fn: Listener, options?: unknown): void {
    this.added.push({ type, options });
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, event: object): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, ...event });
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument extends FakeTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

interface FakePad {
  index: number;
  id: string;
  mapping: string;
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
}

class FakeWindow extends FakeTarget {
  readonly document = new FakeDocument();
  pads: (FakePad | null)[] = [];
  readonly navigator = { getGamepads: (): (FakePad | null)[] => this.pads };
  DeviceMotionEvent?: unknown;
  private frames = new Map<number, () => void>();
  private nextFrame = 1;
  requestAnimationFrame(cb: () => void): number {
    const id = this.nextFrame++;
    this.frames.set(id, cb);
    return id;
  }
  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }
  pendingFrames(): number {
    return this.frames.size;
  }
  /** Runs one animation frame. */
  frame(): void {
    const cbs = [...this.frames.values()];
    this.frames.clear();
    for (const cb of cbs) cb();
  }
}

function pad(over: Partial<FakePad> = {}): FakePad {
  return {
    index: 0,
    id: 'TESLA VIRTUAL GAMEPAD',
    mapping: 'standard',
    buttons: Array.from({ length: 8 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0],
    ...over,
  };
}

let win: FakeWindow;
let log: EventLog;
let probe: InputProbe;
const details = (kind: string): string[] => log.entries().filter((e) => e.kind === kind).map((e) => e.detail);

beforeEach(() => {
  vi.useFakeTimers();
  win = new FakeWindow();
  log = new EventLog();
  probe = new InputProbe(log, win as unknown as Window);
});

afterEach(() => {
  probe.detach();
  vi.useRealTimers();
});

describe('InputProbe.attach — keys, wheel, visibility', () => {
  it('logs keydown/keyup with key, code and keyCode; counts distinct keys on keydown', () => {
    probe.attach();
    win.dispatch('keydown', { key: 'MediaTrackNext', code: 'MediaTrackNext', keyCode: 176 });
    win.dispatch('keyup', { key: 'MediaTrackNext', code: 'MediaTrackNext', keyCode: 176 });
    win.dispatch('keydown', { key: 'MediaTrackNext', code: 'MediaTrackNext', keyCode: 176 });
    win.dispatch('keydown', { key: 'e', code: 'KeyE', keyCode: 69 });
    win.dispatch('keyup', { key: 'q', code: 'KeyQ', keyCode: 81 }); // keyup alone does not count
    expect(details('key')[0]).toBe('keydown key=MediaTrackNext code=MediaTrackNext keyCode=176');
    expect(details('key')[1]).toBe('keyup key=MediaTrackNext code=MediaTrackNext keyCode=176');
    expect(details('key')).toHaveLength(5);
    expect(probe.counts.keys).toEqual(['MediaTrackNext', 'e']);
  });

  it('falls back to code, then keyCode, when key is empty', () => {
    probe.attach();
    win.dispatch('keydown', { key: '', code: 'F13', keyCode: 124 });
    win.dispatch('keydown', { key: '', code: '', keyCode: 255 });
    expect(probe.counts.keys).toEqual(['F13', 'keyCode:255']);
  });

  it('logs wheel deltas and mode with a passive listener', () => {
    probe.attach();
    win.dispatch('wheel', { deltaX: 0, deltaY: -120.456, deltaMode: 0 });
    win.dispatch('wheel', { deltaX: 3, deltaY: 0, deltaMode: 1 });
    expect(probe.counts.wheel).toBe(2);
    expect(details('wheel')).toEqual(['dx=0 dy=-120.46 mode=0', 'dx=3 dy=0 mode=1']);
    expect(win.added.find((a) => a.type === 'wheel')?.options).toEqual({ passive: true });
  });

  it('counts visibility changes and logs the new state', () => {
    probe.attach();
    win.document.visibilityState = 'hidden';
    win.document.dispatch('visibilitychange', {});
    win.document.visibilityState = 'visible';
    win.document.dispatch('visibilitychange', {});
    expect(probe.counts.visibilityChanges).toBe(2);
    expect(details('visibility')).toEqual(['hidden', 'visible']);
  });

  it('counts Media Session actions that AudioProbe pushes into the shared log', () => {
    log.push('mediasession', 'play'); // before attach: not counted
    probe.attach();
    log.push('mediasession', 'nexttrack');
    log.push('mediasession', 'nexttrack');
    log.push('mediasession', 'previoustrack');
    log.push('audio', 'running');
    expect(probe.counts.mediaSession).toEqual({ nexttrack: 2, previoustrack: 1 });
  });

  it('attach() is idempotent: one listener per event', () => {
    probe.attach();
    probe.attach();
    expect(win.count('keydown')).toBe(1);
    expect(win.pendingFrames()).toBe(1);
    win.dispatch('keydown', { key: 'a', code: 'KeyA', keyCode: 65 });
    expect(details('key')).toHaveLength(1);
  });

  it('counts is a snapshot copy', () => {
    probe.attach();
    win.dispatch('keydown', { key: 'a', code: 'KeyA', keyCode: 65 });
    const c = probe.counts;
    c.keys.push('zzz');
    c.mediaSession.play = 9;
    expect(probe.counts.keys).toEqual(['a']);
    expect(probe.counts.mediaSession).toEqual({});
  });

  it('detach() removes every listener, the rAF loop and the log subscription', () => {
    probe.attach();
    probe.detach();
    win.dispatch('keydown', { key: 'a', code: 'KeyA', keyCode: 65 });
    win.dispatch('wheel', { deltaX: 0, deltaY: 1, deltaMode: 0 });
    win.document.dispatch('visibilitychange', {});
    log.push('mediasession', 'play');
    expect(probe.counts).toEqual({ mediaSession: {}, keys: [], wheel: 0, gamepads: [], visibilityChanges: 0 });
    expect(win.pendingFrames()).toBe(0);
    for (const t of ['keydown', 'keyup', 'wheel']) expect(win.count(t)).toBe(0);
    expect(win.document.count('visibilitychange')).toBe(0);
  });
});

describe('InputProbe gamepad polling', () => {
  it('logs a new pad, its button presses/releases and large axis moves, frame by frame', () => {
    probe.attach();
    win.frame(); // no pads yet
    const p = pad();
    p.buttons[5] = { pressed: true, value: 1 }; // the press that makes Chromium expose the pad
    win.pads = [p];
    win.frame();
    expect(details('gamepad')).toEqual([
      'connected index=0 id=TESLA VIRTUAL GAMEPAD mapping=standard buttons=8 axes=2',
      'pad=0 button=5 down',
    ]);
    p.buttons[5] = { pressed: false, value: 0 };
    p.axes[1] = 0.1; // jitter below 0.25: not logged
    win.frame();
    p.axes[1] = -0.8;
    win.frame();
    win.frame(); // unchanged: nothing new
    expect(details('gamepad').slice(2)).toEqual(['pad=0 button=5 up', 'pad=0 axis=1 value=-0.8']);
    expect(probe.counts.gamepads).toEqual(['TESLA VIRTUAL GAMEPAD']);
    expect(win.pendingFrames()).toBe(1); // loop keeps itself scheduled
  });

  it('logs disconnects and does not duplicate a reconnecting pad id', () => {
    probe.attach();
    win.pads = [pad()];
    win.frame();
    win.pads = [null];
    win.frame();
    win.pads = [pad()];
    win.frame();
    expect(details('gamepad').filter((d) => d.startsWith('disconnected'))).toEqual(['disconnected index=0']);
    expect(details('gamepad').filter((d) => d.startsWith('connected'))).toHaveLength(2);
    expect(probe.counts.gamepads).toEqual(['TESLA VIRTUAL GAMEPAD']);
  });

  it('tolerates getGamepads throwing', () => {
    probe.attach();
    win.navigator.getGamepads = () => {
      throw new Error('SecurityError');
    };
    expect(() => win.frame()).not.toThrow();
    expect(win.pendingFrames()).toBe(1);
  });
});

describe('InputProbe.probeMotion', () => {
  function motion(x: number | null, y: number | null, z: number | null, g: number | null = null): object {
    return {
      acceleration: x === null && y === null && z === null ? null : { x, y, z },
      accelerationIncludingGravity: g === null ? null : { x: 0, y: 0, z: g },
    };
  }

  type Vec = [number | null, number | null, number | null];
  /** A devicemotion event with both vectors given axis by axis, and the browser-reported interval (ms). */
  function motion3(acc: Vec | null, accG: Vec | null, interval?: number): object {
    const vec = (v: Vec | null): object | null => (v === null ? null : { x: v[0], y: v[1], z: v[2] });
    return { acceleration: vec(acc), accelerationIncludingGravity: vec(accG), interval };
  }

  const NO_AXES = { acc: null, accG: null, intervalMs: null };

  it('reports unavailable when DeviceMotionEvent does not exist', async () => {
    await expect(probe.probeMotion(1000)).resolves.toEqual({
      available: false, permission: 'not-required', events: 0, rateHz: null, accelRange: null, axes: NO_AXES,
    });
  });

  it('listens for durationMs without a prompt, measuring rate and the acceleration range', async () => {
    win.DeviceMotionEvent = class {};
    const p = probe.probeMotion(1000);
    expect(win.count('devicemotion')).toBe(1);
    for (let i = 0; i <= 10; i++) {
      win.dispatch('devicemotion', motion(i === 3 ? -2.5 : 0.1, 0.2, i === 7 ? 3.25 : 0));
      await vi.advanceTimersByTimeAsync(i < 10 ? 90 : 0);
    }
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r).toEqual({
      available: true,
      permission: 'not-required',
      events: 11,
      rateHz: 11.1,
      accelRange: [-2.5, 3.25],
      axes: { acc: { x: [-2.5, 0.1], y: [0.2, 0.2], z: [0, 3.25] }, accG: null, intervalMs: null },
    });
    expect(win.count('devicemotion')).toBe(0);
    expect(details('motion').at(-1)).toBe('events=11 linear=11 gravityOnly=0 rate=11.1Hz range=-2.5..3.25');
  });

  it('reports per-axis ranges of acceleration and accelerationIncludingGravity and the mean reported interval (C8.4)', async () => {
    win.DeviceMotionEvent = class {};
    const p = probe.probeMotion(1000);
    win.dispatch('devicemotion', motion3([0.1, -0.5, 0.25], [0.3, 9.6, 1.2], 16));
    win.dispatch('devicemotion', motion3([-1.234, 0.5, 0], [-0.9, 9.81, 0.4], 16));
    win.dispatch('devicemotion', motion3(null, [0, 10.05, -0.2], 17)); // gravity-only event
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.axes).toEqual({
      acc: { x: [-1.23, 0.1], y: [-0.5, 0.5], z: [0, 0.25] },
      accG: { x: [-0.9, 0.3], y: [9.6, 10.05], z: [-0.2, 1.2] },
      intervalMs: 16.3,
    });
    expect(r.accelRange).toEqual([-1.23, 0.5]); // unchanged: the overall range of `acceleration`
    expect(r.available).toBe(true);
  });

  it('a vector with an axis that never reported has no per-axis ranges; data-less events add no interval', async () => {
    win.DeviceMotionEvent = class {};
    const p = probe.probeMotion(500);
    win.dispatch('devicemotion', motion3([1, null, 2], [null, null, null], 20));
    win.dispatch('devicemotion', motion3(null, null, 0)); // sensorless desktop event: no data, interval 0
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(r.axes).toEqual({ acc: null, accG: null, intervalMs: 20 });
    expect(r.accelRange).toEqual([1, 2]);
  });

  it('requests permission when required and reports granted', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted'));
    win.DeviceMotionEvent = Object.assign(class {}, { requestPermission });
    const p = probe.probeMotion(500);
    await vi.advanceTimersByTimeAsync(0);
    win.dispatch('devicemotion', motion(1, 1, 1));
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(r.permission).toBe('granted');
    expect(r.events).toBe(1);
    expect(r.rateHz).toBeNull(); // one event: no interval
  });

  it('reports denied without listening', async () => {
    win.DeviceMotionEvent = Object.assign(class {}, { requestPermission: () => Promise.resolve('denied') });
    const r = await probe.probeMotion(500);
    expect(r).toEqual({ available: false, permission: 'denied', events: 0, rateHz: null, accelRange: null, axes: NO_AXES });
    expect(win.added.some((a) => a.type === 'devicemotion')).toBe(false);
  });

  it('reports error when requestPermission throws', async () => {
    win.DeviceMotionEvent = Object.assign(class {}, {
      requestPermission: () => Promise.reject(new Error('NotAllowedError')),
    });
    const r = await probe.probeMotion(500);
    expect(r.permission).toBe('error');
    expect(r.axes).toEqual(NO_AXES);
  });

  it('gravity-only events count as available but give no linear range', async () => {
    win.DeviceMotionEvent = class {};
    const p = probe.probeMotion(500);
    win.dispatch('devicemotion', motion(null, null, null, 9.81));
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(r.available).toBe(true);
    expect(r.accelRange).toBeNull();
  });

  it('events with all-null data (sensorless desktop) are not "available"', async () => {
    win.DeviceMotionEvent = class {};
    const p = probe.probeMotion(500);
    win.dispatch('devicemotion', motion(null, null, null, null));
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    expect(r).toEqual({ available: false, permission: 'not-required', events: 1, rateHz: null, accelRange: null, axes: NO_AXES });
  });

  it('never subscribes to deviceorientation', async () => {
    win.DeviceMotionEvent = class {};
    probe.attach();
    const p = probe.probeMotion(100);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(win.added.map((a) => a.type)).not.toContain('deviceorientation');
    expect(win.added.map((a) => a.type)).not.toContain('deviceorientationabsolute');
  });
});
