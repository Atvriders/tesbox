import type { EventLog, LogEntry } from './log';
import { errText } from './log';

export interface InputCounts {
  mediaSession: Record<string, number>;
  keys: string[];
  wheel: number;
  gamepads: string[];
  visibilityChanges: number;
}

/** Per-axis [min, max] of one DeviceMotion vector over a probe run, m/s², rounded to 0.01. */
export interface AxisRanges {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

export interface MotionReport {
  available: boolean;
  permission: 'granted' | 'denied' | 'not-required' | 'error';
  events: number;
  rateHz: number | null;
  /** Overall [min, max] over every axis of `acceleration` (gravity-free). */
  accelRange: [number, number] | null;
  /**
   * `acc` / `accG`: per-axis ranges of `acceleration` / `accelerationIncludingGravity` (accG shows
   * which axis carries gravity, i.e. how the screen is mounted), each null unless all three axes
   * reported. `intervalMs`: mean DeviceMotionEvent.interval (the sampling interval the browser
   * claims) over the events that carried data; the measured delivery rate is `rateHz`.
   */
  axes: { acc: AxisRanges | null; accG: AxisRanges | null; intervalMs: number | null };
}

/** DeviceMotionEvent as exposed on window; requestPermission exists only where a prompt is required. */
type DeviceMotionCtor = (new (type: string) => Event) & { requestPermission?: () => Promise<string> };

type Axis = 'x' | 'y' | 'z';
type Vector = { readonly [A in Axis]: number | null | undefined };

const AXES: readonly Axis[] = ['x', 'y', 'z'];
const MAX_DISTINCT_KEYS = 64; // keeps the QR summary bounded
const AXIS_LOG_STEP = 0.25; // log an axis only when it moved this far since its last logged value

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function noAxes(): MotionReport['axes'] {
  return { acc: null, accG: null, intervalMs: null };
}

/** Running per-axis min/max of one DeviceMotion vector; unreported (null/NaN) components are skipped. */
class AxisTracker {
  private readonly lo: Record<Axis, number> = { x: Infinity, y: Infinity, z: Infinity };
  private readonly hi: Record<Axis, number> = { x: -Infinity, y: -Infinity, z: -Infinity };

  /** Widens each axis by its finite component; true if any component was finite. */
  add(v: Vector | null | undefined): boolean {
    if (v === null || v === undefined) return false;
    let any = false;
    for (const a of AXES) {
      const c = v[a];
      if (!finite(c)) continue;
      any = true;
      if (c < this.lo[a]) this.lo[a] = c;
      if (c > this.hi[a]) this.hi[a] = c;
    }
    return any;
  }

  /** Ranges of all three axes, or null unless every axis reported at least once. */
  ranges(): AxisRanges | null {
    if (!AXES.every((a) => this.lo[a] <= this.hi[a])) return null;
    const r = (a: Axis): [number, number] => [round(this.lo[a], 2), round(this.hi[a], 2)];
    return { x: r('x'), y: r('y'), z: r('z') };
  }

  /** [min, max] over every component seen on any axis, or null if none was finite. */
  overall(): [number, number] | null {
    const min = Math.min(this.lo.x, this.lo.y, this.lo.z); // an unreported axis stays at ±Infinity
    const max = Math.max(this.hi.x, this.hi.y, this.hi.z);
    return min <= max ? [round(min, 2), round(max, 2)] : null;
  }
}

/**
 * Logs every input path the car might deliver: keys (incl. MediaTrack*), wheel, visibility,
 * gamepads (rAF polling) and DeviceMotion. Media Session actions are registered by AudioProbe
 * (one handler per action) and counted here from the shared log.
 */
export class InputProbe {
  private attached = false;
  private rafId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly mediaSession = new Map<string, number>();
  private readonly keys: string[] = [];
  private wheel = 0;
  private readonly gamepads: string[] = [];
  private visibilityChanges = 0;
  private readonly padIds = new Map<number, string>();
  private readonly padButtons = new Map<number, boolean[]>();
  private readonly padAxes = new Map<number, number[]>();

  constructor(
    private readonly log: EventLog,
    private readonly target: Window = window,
  ) {}

  get counts(): InputCounts {
    return {
      mediaSession: Object.fromEntries(this.mediaSession),
      keys: [...this.keys],
      wheel: this.wheel,
      gamepads: [...this.gamepads],
      visibilityChanges: this.visibilityChanges,
    };
  }

  /** keydown/keyup (key, code, keyCode), wheel (deltaX/Y, deltaMode), visibilitychange, gamepad polling via rAF. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const t = this.target;
    t.addEventListener('keydown', this.onKey);
    t.addEventListener('keyup', this.onKey);
    t.addEventListener('wheel', this.onWheel, { passive: true });
    t.document.addEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe = this.log.subscribe(this.onLogEntry);
    this.rafId = t.requestAnimationFrame(this.onFrame);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const t = this.target;
    t.removeEventListener('keydown', this.onKey);
    t.removeEventListener('keyup', this.onKey);
    t.removeEventListener('wheel', this.onWheel);
    t.document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.rafId !== null) t.cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Listens to devicemotion for durationMs (requests permission if DeviceMotionEvent.requestPermission exists). Never uses deviceorientation. */
  async probeMotion(durationMs = 5000): Promise<MotionReport> {
    const ctor = (this.target as unknown as { DeviceMotionEvent?: DeviceMotionCtor }).DeviceMotionEvent;
    if (typeof ctor !== 'function') {
      this.log.push('motion', 'DeviceMotionEvent unsupported');
      return { available: false, permission: 'not-required', events: 0, rateHz: null, accelRange: null, axes: noAxes() };
    }
    let permission: MotionReport['permission'] = 'not-required';
    if (typeof ctor.requestPermission === 'function') {
      try {
        // First await of the click handler's call chain: still inside the user gesture.
        permission = (await ctor.requestPermission()) === 'granted' ? 'granted' : 'denied';
      } catch (e) {
        this.log.push('motion', `permission error ${errText(e)}`);
        return { available: false, permission: 'error', events: 0, rateHz: null, accelRange: null, axes: noAxes() };
      }
      if (permission === 'denied') {
        this.log.push('motion', 'permission denied');
        return { available: false, permission, events: 0, rateHz: null, accelRange: null, axes: noAxes() };
      }
    }
    return this.listenMotion(Math.max(0, durationMs), permission);
  }

  private listenMotion(durationMs: number, permission: MotionReport['permission']): Promise<MotionReport> {
    return new Promise((resolve) => {
      let events = 0;
      let linear = 0; // events carrying gravity-free acceleration
      let gravityOnly = 0; // events carrying only accelerationIncludingGravity
      let firstMs = 0;
      let lastMs = 0;
      let intervalSum = 0;
      let intervals = 0;
      const acc = new AxisTracker();
      const accG = new AxisTracker();
      const onMotion = (e: DeviceMotionEvent): void => {
        const now = performance.now();
        if (events === 0) firstMs = now;
        lastMs = now;
        events++;
        const hasLinear = acc.add(e.acceleration);
        const hasGravity = accG.add(e.accelerationIncludingGravity);
        if (hasLinear) linear++;
        else if (hasGravity) gravityOnly++;
        // A data-less event (sensorless desktop) says nothing about the sensor's sampling interval.
        if ((hasLinear || hasGravity) && finite(e.interval)) {
          intervalSum += e.interval;
          intervals++;
        }
      };
      this.target.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        this.target.removeEventListener('devicemotion', onMotion);
        const rateHz = events >= 2 && lastMs > firstMs ? round(((events - 1) * 1000) / (lastMs - firstMs), 1) : null;
        const accelRange = acc.overall();
        const axes: MotionReport['axes'] = {
          acc: acc.ranges(),
          accG: accG.ranges(),
          intervalMs: intervals > 0 ? round(intervalSum / intervals, 1) : null,
        };
        const report: MotionReport = { available: linear + gravityOnly > 0, permission, events, rateHz, accelRange, axes };
        this.log.push(
          'motion',
          `events=${events} linear=${linear} gravityOnly=${gravityOnly} rate=${rateHz ?? 'n/a'}Hz range=${accelRange === null ? 'n/a' : accelRange.join('..')}`,
        );
        resolve(report);
      }, durationMs);
    });
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    this.log.push('key', `${e.type} key=${e.key} code=${e.code} keyCode=${e.keyCode}`);
    const id = e.key || e.code || `keyCode:${e.keyCode}`;
    if (e.type === 'keydown' && !this.keys.includes(id) && this.keys.length < MAX_DISTINCT_KEYS) this.keys.push(id);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.wheel++;
    this.log.push('wheel', `dx=${round(e.deltaX, 2)} dy=${round(e.deltaY, 2)} mode=${e.deltaMode}`);
  };

  private readonly onVisibility = (): void => {
    this.visibilityChanges++;
    this.log.push('visibility', this.target.document.visibilityState);
  };

  private readonly onLogEntry = (e: LogEntry): void => {
    if (e.kind === 'mediasession') this.mediaSession.set(e.detail, (this.mediaSession.get(e.detail) ?? 0) + 1);
  };

  private readonly onFrame = (): void => {
    this.rafId = null;
    if (!this.attached) return;
    this.scanGamepads();
    this.rafId = this.target.requestAnimationFrame(this.onFrame);
  };

  private scanGamepads(): void {
    const nav = this.target.navigator;
    if (typeof nav.getGamepads !== 'function') return;
    let pads: (Gamepad | null)[];
    try {
      pads = nav.getGamepads();
    } catch {
      return; // e.g. blocked by Permissions-Policy
    }
    const seen = new Set<number>();
    for (const pad of pads) {
      if (pad === null) continue;
      seen.add(pad.index);
      if (this.padIds.get(pad.index) !== pad.id) {
        this.padIds.set(pad.index, pad.id);
        this.padButtons.set(pad.index, pad.buttons.map(() => false));
        this.padAxes.set(pad.index, pad.axes.map(() => 0));
        if (!this.gamepads.includes(pad.id)) this.gamepads.push(pad.id);
        this.log.push(
          'gamepad',
          `connected index=${pad.index} id=${pad.id} mapping=${pad.mapping || 'none'} buttons=${pad.buttons.length} axes=${pad.axes.length}`,
        );
      }
      this.diffPad(pad);
    }
    for (const index of [...this.padIds.keys()]) {
      if (seen.has(index)) continue;
      this.log.push('gamepad', `disconnected index=${index}`);
      this.padIds.delete(index);
      this.padButtons.delete(index);
      this.padAxes.delete(index);
    }
  }

  private diffPad(pad: Gamepad): void {
    const buttons = this.padButtons.get(pad.index);
    const axes = this.padAxes.get(pad.index);
    if (buttons === undefined || axes === undefined) return;
    pad.buttons.forEach((b, i) => {
      if (b.pressed === (buttons[i] ?? false)) return;
      buttons[i] = b.pressed;
      this.log.push('gamepad', `pad=${pad.index} button=${i} ${b.pressed ? 'down' : 'up'}`);
    });
    pad.axes.forEach((v, i) => {
      if (Math.abs(v - (axes[i] ?? 0)) < AXIS_LOG_STEP) return;
      axes[i] = v;
      this.log.push('gamepad', `pad=${pad.index} axis=${i} value=${round(v, 2)}`);
    });
  }
}
