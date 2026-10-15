/**
 * The Sound Lab's control state (phase-2c contract L2): what the 'tesbox-lab' worklet renders every quantum
 * (src/lab/ui/lab-worklet.ts calls step()), and what the page mirrors so its sliders follow the events.
 * Environment-free and deterministic; step() never allocates.
 *
 * - Manual control: rpm clamped to [idle, limiter] of the current spec, load to DspControl's [-1, 1], gear to
 *   whole gears in [1, gears]; a non-finite number keeps the previous value. Driveline 'engaged'.
 * - upshift: a ShiftState from the current rpm to rpm·ratio[g+1]/ratio[g] at t0 = now, then gear + 1 (no-op
 *   in top gear). downshift: a rev-matched blip to rpm·ratio[g−1]/ratio[g], then gear − 1 (no-op in 1st).
 *   Either target is clamped to [idle, limiter] — the contract's limiter clamp on the blip, and the manual
 *   rpm range on the way down (an upshift near idle would otherwise leave the engine below idle) — and becomes
 *   the manual rpm once the shift is over. "Current rpm" is the rendered one, so a shift out of a limiter
 *   hold starts at the limiter, and it ends the hold.
 * - liftoff: load 0 (the DSP's overrun threshold) until the next manual control.
 * - limiter: toggles a hold at the limiter rpm with `limiter: true` (RpmState bounces off it).
 * - ignition: toggles ignitionOn; switching it on restarts runTimeS.
 * - Segments (tools/segments.ts, bound to the current spec) replace the manual control while they play and
 *   loop; their shifts get absolute start times. Shifts, lift-off and the limiter are ignored meanwhile (the
 *   segment owns rpm, load, gear and the limiter); ignition still toggles.
 */
import type { DspControl, EngineSpec } from '../../contracts';
import { SEGMENTS, bindSegmentEngine, type Segment } from '../../../tools/segments';
import type { LabEvent, ManualControl } from './protocol';

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

export class LabControl {
  /** The control rendered by the last step() (mutated in place, never replaced). */
  readonly ctl: DspControl = {
    rpm: 0,
    load: 0,
    gear: 1,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0.1 },
    ignitionOn: true,
    runTimeS: 0,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
  };
  /** The last manual control, clamped to the current spec (idle in 1st until the first one arrives). */
  readonly manual: ManualControl = {
    rpm: 0,
    load: 0,
    gear: 1,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
  };

  private spec: EngineSpec | null = null;
  private idle = 0;
  private limiterRpm = 0;
  private ratios: readonly number[] = [];
  private shiftTimeS = 0.1;
  private lift = false;
  private hold = false;
  private ignition = true;
  private runTime = 0;
  private seg: Segment | null = null;
  private segT0 = 0;

  /** Lift-off holds load 0 (until the next manual control). */
  get liftoff(): boolean {
    return this.lift;
  }

  get limiterHold(): boolean {
    return this.hold;
  }

  get ignitionOn(): boolean {
    return this.ignition;
  }

  /** Name of the segment playing, or null under manual control. */
  get segmentName(): string | null {
    return this.seg === null ? null : this.seg.name;
  }

  /** Takes the engine's rpm range, ratios and shift time, binds the segments to it and re-clamps the manual control. */
  configure(spec: EngineSpec): void {
    this.spec = spec;
    this.idle = spec.rpm.idle;
    this.limiterRpm = spec.rpm.limiter.rpm;
    this.ratios = spec.gearbox.overallRatios;
    this.shiftTimeS = spec.gearbox.shiftTimeS;
    bindSegmentEngine(spec);
    this.ctl.shift.active = false;
    this.clampManual();
  }

  /** A new manual control (clamped); it ends a lift-off. */
  setManual(m: ManualControl): void {
    const cur = this.manual;
    cur.rpm = finiteOr(m.rpm, cur.rpm);
    cur.load = finiteOr(m.load, cur.load);
    cur.gear = finiteOr(m.gear, cur.gear);
    cur.valve = m.valve;
    cur.perspective = m.perspective;
    cur.driveMode = m.driveMode;
    cur.warm = m.warm;
    this.clampManual();
    this.lift = false;
  }

  /** Applies an event at worklet time nowS; false when it was a no-op (no engine, top/1st gear, segment playing). */
  event(ev: LabEvent, nowS: number): boolean {
    if (this.spec === null) return false;
    if (ev === 'ignition') {
      this.ignition = !this.ignition;
      if (this.ignition) this.runTime = 0;
      return true;
    }
    if (this.seg !== null) return false;
    switch (ev) {
      case 'liftoff':
        this.lift = true;
        return true;
      case 'limiter':
        this.hold = !this.hold;
        return true;
      case 'upshift':
        return this.shift(1, nowS);
      case 'downshift':
        return this.shift(-1, nowS);
      default:
        return false;
    }
  }

  /** Loops the named segment from nowS; null returns to manual control. Throws (changing nothing) on an unknown name. */
  setSegment(name: string | null, nowS: number): void {
    if (name === null) {
      this.seg = null;
      this.ctl.shift.active = false;
      return;
    }
    const seg = SEGMENTS.find((s) => s.name === name);
    if (seg === undefined) throw new RangeError(`unknown segment "${name}"`);
    if (this.spec === null) throw new Error('segment: no engine configured');
    this.seg = seg;
    this.segT0 = nowS;
    this.ctl.shift.active = false;
  }

  /** The control for the quantum starting at nowS (dtS long). Allocation-free. */
  step(nowS: number, dtS: number): DspControl {
    const c = this.ctl;
    const m = this.manual;
    if (this.ignition) this.runTime += dtS;
    c.ignitionOn = this.ignition;
    c.runTimeS = this.runTime;
    c.valve = m.valve;
    c.perspective = m.perspective;
    c.driveMode = m.driveMode;
    c.warm = m.warm;
    const seg = this.seg;
    if (seg !== null) {
      const d = seg.durationS;
      let t = nowS - this.segT0;
      if (!(t > 0)) t = 0;
      const loops = Math.floor(t / d);
      t -= loops * d;
      seg.ctl(t, c);
      if (c.shift.active) c.shift.t0 += this.segT0 + loops * d;
      return c;
    }
    c.rpm = this.hold ? this.limiterRpm : m.rpm;
    c.load = this.lift ? 0 : m.load;
    c.gear = m.gear;
    c.driveline = 'engaged';
    c.limiter = this.hold;
    const s = c.shift;
    if (s.active && nowS >= s.t0 + s.durationS) s.active = false;
    return c;
  }

  private clampManual(): void {
    const m = this.manual;
    m.load = clamp(m.load, -1, 1);
    if (this.spec === null) return;
    m.rpm = clamp(m.rpm, this.idle, this.limiterRpm);
    m.gear = clamp(Math.round(m.gear), 1, Math.max(1, this.ratios.length));
  }

  private shift(dir: 1 | -1, nowS: number): boolean {
    const g = this.manual.gear;
    const next = g + dir;
    const rNow = this.ratios[g - 1];
    const rNext = this.ratios[next - 1];
    if (rNow === undefined || rNext === undefined || !(rNow > 0)) return false;
    const from = this.hold ? this.limiterRpm : this.manual.rpm;
    const to = clamp((from * rNext) / rNow, this.idle, this.limiterRpm);
    const s = this.ctl.shift;
    s.active = true;
    s.up = dir > 0;
    s.fromRpm = from;
    s.toRpm = to;
    s.t0 = nowS;
    s.durationS = this.shiftTimeS;
    this.manual.gear = next;
    this.manual.rpm = to;
    this.hold = false;
    return true;
  }
}
