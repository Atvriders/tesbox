import type { DriveMode, EngineSpec } from '../contracts';

/**
 * Automatic shift schedule for one engine + drive mode (spec §8.6, phase-1 contract).
 * Gears are 1-based; all rpm values are ENGINE rpm in the named gear.
 */
export interface ShiftMap {
  readonly gears: number;
  /** Comfort 1200, Sport 1500. */
  readonly coastDownRpm: number;
  /** Engine rpm in `gear` at or above which to go to gear + 1. Infinity for the top gear. */
  upshiftRpm(gear: number, load: number): number;
  /** Engine rpm IN `gear` below which to go to gear − 1. 0 for gear 1. */
  downshiftRpm(gear: number, load: number): number;
  /** upshiftRpm(gear, load) − 300: highest rpm a kickdown may land on in `gear`. */
  kickdownMaxRpm(gear: number, load: number): number;
}

interface ModeParams {
  /** frac(load) = lo + (hi − lo)·clamp(load, 0, 1)^1.3 (fraction of redline). */
  lo: number;
  hi: number;
  /** Downshift hysteresis h. */
  h: number;
  coastDownRpm: number;
}

const MODE_PARAMS: Readonly<Record<DriveMode, ModeParams>> = {
  comfort: { lo: 0.25, hi: 0.9, h: 0.25, coastDownRpm: 1200 },
  sport: { lo: 0.3, hi: 0.97, h: 0.15, coastDownRpm: 1500 },
};

const LOAD_EXPONENT = 1.3;
/** After an upshift the new gear must turn at least coastDownRpm + 300. */
const UPSHIFT_FLOOR_MARGIN_RPM = 300;
const KICKDOWN_MARGIN_RPM = 300;

class FormulaShiftMap implements ShiftMap {
  readonly gears: number;
  readonly coastDownRpm: number;
  private readonly ratios: Float64Array;
  private readonly redline: number;
  private readonly lo: number;
  private readonly hi: number;
  private readonly h: number;

  constructor(ratios: Float64Array, redline: number, p: ModeParams) {
    this.ratios = ratios;
    this.gears = ratios.length;
    this.redline = redline;
    this.lo = p.lo;
    this.hi = p.hi;
    this.h = p.h;
    this.coastDownRpm = p.coastDownRpm;
  }

  /** lo + (hi − lo)·clamp(load, 0, 1)^1.3; NaN load counts as 0. */
  private frac(load: number): number {
    const x = load > 0 ? (load < 1 ? load : 1) : 0;
    return this.lo + (this.hi - this.lo) * Math.pow(x, LOAD_EXPONENT);
  }

  upshiftRpm(gear: number, load: number): number {
    // 1-based gear n uses r[n] = ratios[n − 1]; the floor uses the ratio of next to current gear.
    const rn = this.ratios[gear - 1];
    const rNext = this.ratios[gear];
    if (rn === undefined || rNext === undefined) return Infinity;
    return Math.max(this.frac(load) * this.redline, (this.coastDownRpm + UPSHIFT_FLOOR_MARGIN_RPM) / (rNext / rn));
  }

  downshiftRpm(gear: number, load: number): number {
    const rn = this.ratios[gear - 1];
    const rPrev = this.ratios[gear - 2];
    if (rn === undefined || rPrev === undefined) return 0;
    // Speed at which (gear − 1) → gear upshifted, reduced by h, expressed as rpm in `gear`.
    return this.upshiftRpm(gear - 1, load) * (rn / rPrev) * (1 - this.h);
  }

  kickdownMaxRpm(gear: number, load: number): number {
    return this.upshiftRpm(gear, load) - KICKDOWN_MARGIN_RPM;
  }
}

/**
 * Builds the shift map for `spec` in `mode`. Configure-time only (allocates). Throws Error when the
 * ratios are empty, non-finite, non-positive or not strictly descending, or the redline is not > 0.
 */
export function buildShiftMap(spec: EngineSpec, mode: DriveMode): ShiftMap {
  const src = spec.gearbox.overallRatios;
  if (src.length === 0) throw new Error('overallRatios is empty');
  const ratios = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    if (r === undefined || !Number.isFinite(r) || r <= 0) throw new Error(`overallRatios[${i}] must be a positive number`);
    const prev = i > 0 ? ratios[i - 1] : undefined;
    if (prev !== undefined && !(r < prev)) throw new Error('overallRatios must be strictly descending');
    ratios[i] = r;
  }
  const redline = spec.rpm.redline;
  if (!(redline > 0)) throw new Error('rpm.redline must be > 0');
  return new FormulaShiftMap(ratios, redline, MODE_PARAMS[mode]);
}
