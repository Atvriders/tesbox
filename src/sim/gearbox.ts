import { F } from '../contracts';
import type { DriveMode, EngineSpec, GearboxMode, ShiftState } from '../contracts';
import { buildShiftMap, type ShiftMap } from './shift-map';
import { wheelRpm } from './tyre';

/**
 * Auto-mode paddle override (spec §7.1, PC6): for this long after a paddle shift, auto-upshifts, the
 * load-map downshift and the kickdown are suspended; only the coast-down downshift (rpm < coastDownRpm)
 * still applies.
 */
export const MANUAL_OVERRIDE_S = 8;
/** SHIFT_REFUSED stays set this long after a refused (over-rev) downshift. */
export const SHIFT_REFUSED_S = 0.5;
/** Manual mode anti-lug: auto-downshift below this engine rpm unless the clutch is open. */
export const ANTI_LUG_RPM = 1100;
/** Auto: minimum time in gear after the previous shift ended, part-load (< 0.8) and coast upshifts. */
export const MIN_TIME_IN_GEAR_S = 1.5;
/** Auto: at load ≥ WOT_UPSHIFT_LOAD an upshift is allowed this long after the previous shift ended. */
export const WOT_UPSHIFT_DELAY_S = 0.2;
export const WOT_UPSHIFT_LOAD = 0.8;
/**
 * Auto kickdown trigger (contract A4): load > 0.6 && loadRate > 1.2 /s; fires once per tip-in (A10a latch).
 * KICKDOWN_LOAD_RATE is also the A10b threshold: no load-map downshift while loadRate > 1.2.
 */
export const KICKDOWN_LOAD = 0.6;
export const KICKDOWN_LOAD_RATE = 1.2;
/**
 * Auto (contract A10c): at load > 0 a load-map downshift starts only ≥ this long after the previous Auto
 * downshift ended.
 */
export const DOWNSHIFT_SPACING_S = 0.3;

/**
 * Auto / manual gearbox state machine (spec §8.6, phase-1 contract). Gears are 1-based.
 * `request` and `step` never allocate; `configure` builds both drive-mode shift maps.
 *
 * Beyond the contract (plan header, Concerns PC4–PC7):
 * - PC4: `reset()` returns to gear 1 with no shift in flight, the pending request dropped and every
 *   timer and flag cleared (SimCore calls it at ignition on/off).
 * - PC5: Auto over-speed skip-shift: when the current gear already turns ≥ redline (e.g. GPS
 *   re-acquired at speed after standstill forced gear 1), ONE upshift goes straight to the lowest gear
 *   below its own upshift point (or the top gear), without the minimum-time-in-gear wait — a
 *   one-gear-per-shift climb would rev to the limiter for 1.5 s per gear. Still never while
 *   `predicting`, never in Manual and never during a paddle override.
 * - PC6: the Auto paddle override suspends the load-map downshift and the kickdown as well as
 *   auto-upshifts; only the coast-down downshift (rpm < coastDownRpm) still applies — otherwise the map
 *   would undo a deliberate early paddle upshift on the next quantum.
 * - PC7: paddle legality is the same in Auto and Manual: an upshift request in top gear or a downshift
 *   request in gear 1 is ignored without a flag; a downshift that would turn the lower gear above
 *   redline is refused with SHIFT_REFUSED for 0.5 s and, in Auto, starts no override.
 *
 * PC14 (raised by this task as the kickdown latch; adopted with the hold and the spacing as contract
 * amendment A10, 2026-10-08) — tip-in downshift pacing. With the LoadEstimator's τ = 0.2 s a pedal step
 * keeps the A4 trigger true for ≈ 0.1 s, about one DCT shift time, and the contract rules alone gave
 * 2–3 back-to-back downshifts within 0.3 s ("stutter", 3,060 measured tip-ins) where spec §8.6 has one
 * kickdown of 1–2 gears. The A4 trigger and the kickdown target-gear rule are unchanged.
 * - A10a kickdown latch: the kickdown fires at most once per tip-in. It disarms when it fires and re-arms
 *   on the first quantum (any mode, shift in flight included) on which the A4 trigger is false; reset()
 *   re-arms it. An A4 quantum that finds no target gear leaves it armed.
 * - A10b hold while rising: no load-map downshift while loadRate > KICKDOWN_LOAD_RATE — the rise is the
 *   kickdown's; the map follows once it settles. So outside a paddle override a downshift that starts on
 *   a quantum where the A4 trigger holds is the kickdown (Task 8 classifies kickdowns this way).
 * - A10c spacing: at load > 0 a load-map downshift starts only ≥ DOWNSHIFT_SPACING_S after the previous
 *   Auto downshift (kickdown, load-map or override coast-down; not a paddle or Manual anti-lug one)
 *   ended. Not spaced: coast/braking map downshifts (load ≤ 0), the kickdown and the override coast-down.
 */
export class Gearbox {
  /** Current/last shift trajectory, mutated in place (never replaced). */
  readonly shift: ShiftState = { active: false, up: false, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0 };

  private comfortMap: ShiftMap | null = null;
  private sportMap: ShiftMap | null = null;
  private map: ShiftMap | null = null;
  private ratios = new Float64Array(0);
  private circumferenceM = 1;
  private redline = 0;
  private shiftTimeS = 0;
  private gears = 0;
  private mode: GearboxMode = 'auto';
  private _gear = 1;
  private _flags = 0;
  /** Pending paddle request: +1, −1 or 0. Applied (or dropped) by the next step. */
  private pending = 0;
  private lastShiftEndS = -Infinity;
  private overrideUntilS = -Infinity;
  private refusedUntilS = -Infinity;
  /** A10a kickdown latch: false from a kickdown until the first quantum on which the A4 trigger is false. */
  private kickdownArmed = true;
  /** A10c: end time of the last downshift the Auto logic made (kickdown, load-map or override coast-down). */
  private autoDownEndS = -Infinity;

  /**
   * Configure-time only (allocates). Resets to gear 1. Throws Error (before changing any state) on a
   * bad circumference, shift time, ratios or redline — a NaN shift time would never let a shift end.
   */
  configure(spec: EngineSpec, circumferenceM: number, mode: GearboxMode, drive: DriveMode): void {
    if (!(circumferenceM > 0) || !Number.isFinite(circumferenceM)) {
      throw new Error('circumferenceM must be a positive finite number');
    }
    const shiftTimeS = spec.gearbox.shiftTimeS;
    if (!Number.isFinite(shiftTimeS) || shiftTimeS < 0) {
      throw new Error('gearbox.shiftTimeS must be a finite number ≥ 0');
    }
    const comfortMap = buildShiftMap(spec, 'comfort');
    const sportMap = buildShiftMap(spec, 'sport');
    this.comfortMap = comfortMap;
    this.sportMap = sportMap;
    this.ratios = Float64Array.from(spec.gearbox.overallRatios);
    this.gears = this.ratios.length;
    this.circumferenceM = circumferenceM;
    this.redline = spec.rpm.redline;
    this.shiftTimeS = shiftTimeS;
    this.mode = mode;
    this.setDriveMode(drive);
    this.reset();
  }

  /**
   * Gear 1, no shift in flight, no pending request, all timers (A10c spacing included) and flags
   * cleared, the kickdown latch re-armed. Keeps the configuration.
   */
  reset(): void {
    const s = this.shift;
    s.active = false;
    s.up = false;
    s.fromRpm = 0;
    s.toRpm = 0;
    s.t0 = 0;
    s.durationS = 0;
    this._gear = 1;
    this._flags = 0;
    this.pending = 0;
    this.lastShiftEndS = -Infinity;
    this.overrideUntilS = -Infinity;
    this.refusedUntilS = -Infinity;
    this.kickdownArmed = true;
    this.autoDownEndS = -Infinity;
  }

  /** Switching mode ends any Auto paddle override (MANUAL_OVERRIDE clears now). */
  setMode(mode: GearboxMode): void {
    this.mode = mode;
    this.overrideUntilS = -Infinity;
    this._flags &= ~F.MANUAL_OVERRIDE;
  }

  setDriveMode(drive: DriveMode): void {
    this.map = drive === 'sport' ? this.sportMap : this.comfortMap;
  }

  /** Paddle/wheel/keyboard request; applied on the next step. dir: +1 up, −1 down (0/NaN ignored). */
  request(dir: number): void {
    if (dir > 0) this.pending = 1;
    else if (dir < 0) this.pending = -1;
  }

  step(
    nowS: number,
    v: number,
    load: number,
    loadRate: number,
    predicting: boolean,
    standstill: boolean,
    clutchOpen: boolean,
  ): void {
    const map = this.map;
    if (map === null) return;
    const s = this.shift;
    if (s.active && nowS >= s.t0 + s.durationS) s.active = false;
    // A10a kickdown latch: re-armed on every quantum on which the A4 trigger is false, whatever happens below.
    if (!(load > KICKDOWN_LOAD && loadRate > KICKDOWN_LOAD_RATE)) this.kickdownArmed = true;
    const req = this.pending;
    this.pending = 0; // a request is applied by this step or dropped (never queued behind a shift)

    if (standstill) {
      this._gear = 1; // no shift event
    } else if (!s.active) {
      if (req !== 0) this.paddle(nowS, v, req);
      if (!s.active) {
        if (this.mode === 'manual') this.manualAuto(nowS, v, clutchOpen);
        else this.auto(nowS, v, load, loadRate, predicting, map);
      }
    }

    let f = 0;
    if (s.active) f |= F.SHIFTING;
    if (this.mode === 'auto' && nowS < this.overrideUntilS) f |= F.MANUAL_OVERRIDE;
    if (nowS < this.refusedUntilS) f |= F.SHIFT_REFUSED;
    this._flags = f;
  }

  /** Engine rpm the wheels impose in `gear` (1-based) at road speed v; 0 for a gear that does not exist. */
  rpmInGear(gear: number, v: number): number {
    const r = this.ratios[gear - 1];
    return r === undefined ? 0 : wheelRpm(v, r, this.circumferenceM);
  }

  get gear(): number {
    return this._gear;
  }

  get flags(): number {
    return this._flags;
  }

  /** Paddle in either mode: upshift at top / downshift at gear 1 ignored; over-rev downshift refused. */
  private paddle(nowS: number, v: number, dir: number): void {
    const g = this._gear;
    if (dir > 0) {
      if (g >= this.gears) return;
      this.begin(nowS, v, g + 1);
    } else {
      if (g <= 1) return;
      if (this.rpmInGear(g - 1, v) > this.redline) {
        this.refusedUntilS = nowS + SHIFT_REFUSED_S;
        return;
      }
      this.begin(nowS, v, g - 1);
    }
    if (this.mode === 'auto') this.overrideUntilS = nowS + MANUAL_OVERRIDE_S;
  }

  /** Manual mode: only the anti-lug downshift is automatic. */
  private manualAuto(nowS: number, v: number, clutchOpen: boolean): void {
    const g = this._gear;
    if (clutchOpen || g <= 1) return;
    if (this.rpmInGear(g, v) < ANTI_LUG_RPM && this.rpmInGear(g - 1, v) <= this.redline) this.begin(nowS, v, g - 1);
  }

  private auto(nowS: number, v: number, load: number, loadRate: number, predicting: boolean, map: ShiftMap): void {
    const g = this._gear;
    const rpm = this.rpmInGear(g, v);
    if (nowS < this.overrideUntilS) {
      // Paddle override (PC6): auto-upshifts (over-speed included), the map downshift and the kickdown
      // are suspended; only the coast-down downshift still applies.
      if (g > 1 && rpm < map.coastDownRpm) this.autoDown(nowS, v, g - 1);
      return;
    }
    // A4 kickdown: lowest gear ≥ g − 2 landing ≤ kickdownMaxRpm. Once per tip-in (A10a): a quantum that
    // finds no such gear leaves the latch armed for the rest of the tip-in.
    if (load > KICKDOWN_LOAD && loadRate > KICKDOWN_LOAD_RATE && this.kickdownArmed) {
      for (let k = g - 2 > 1 ? g - 2 : 1; k < g; k++) {
        if (this.rpmInGear(k, v) <= map.kickdownMaxRpm(k, load)) {
          this.kickdownArmed = false;
          this.autoDown(nowS, v, k);
          return;
        }
      }
    }
    if (g > 1 && rpm < map.downshiftRpm(g, load)) {
      // Load-map downshift, held while the load rises at kickdown pace (A10b) and, at load > 0, until
      // DOWNSHIFT_SPACING_S after the previous Auto downshift ended (A10c). Held or not, no upshift check
      // follows (below its downshift point a gear is always below its upshift point too).
      if (!(loadRate > KICKDOWN_LOAD_RATE) && (!(load > 0) || nowS - this.autoDownEndS >= DOWNSHIFT_SPACING_S)) {
        this.autoDown(nowS, v, g - 1);
      }
      return;
    }
    if (!predicting && g < this.gears && rpm >= map.upshiftRpm(g, load)) {
      if (rpm >= this.redline) {
        // Over-speed: one shift straight to the lowest gear below its own upshift point (or the top gear).
        let to = g + 1;
        while (to < this.gears && this.rpmInGear(to, v) >= map.upshiftRpm(to, load)) to++;
        this.begin(nowS, v, to);
        return;
      }
      const minGapS = load >= WOT_UPSHIFT_LOAD ? WOT_UPSHIFT_DELAY_S : MIN_TIME_IN_GEAR_S;
      if (nowS - this.lastShiftEndS >= minGapS) this.begin(nowS, v, g + 1);
    }
  }

  /** A downshift made by the Auto logic: also starts the A10c spacing. */
  private autoDown(nowS: number, v: number, to: number): void {
    this.begin(nowS, v, to);
    this.autoDownEndS = this.lastShiftEndS;
  }

  private begin(nowS: number, v: number, to: number): void {
    const s = this.shift;
    s.active = true;
    s.up = to > this._gear;
    s.fromRpm = this.rpmInGear(this._gear, v);
    s.toRpm = this.rpmInGear(to, v);
    s.t0 = nowS;
    s.durationS = this.shiftTimeS;
    this.lastShiftEndS = nowS + this.shiftTimeS;
    this._gear = to;
  }
}
