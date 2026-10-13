import type { FixMsg } from '../contracts';

/** One recorded/synthetic GPS fix. `t` = delivery time in seconds from trace start. */
export interface ReplayFix {
  t: number;
  sAlongM: number;
  speedMps: number | null;
  accuracyM: number;
  ageS?: number;
}

export interface ReplayTrace {
  meta: { name: string; cadenceS: number; latencyS: number; source: 'synthetic' | 'gpx'; notes?: string };
  fixes: ReplayFix[]; // t = delivery time (s from trace start), ascending
  truth?: { t: number; v: number }[]; // ground-truth speed (synthetic traces only)
}

/** Fake positions lie on the equator: lon = sAlongM / this. */
export const METRES_PER_DEG_LON_AT_EQUATOR = 111319.49;

/** Feeds a ReplayTrace into the FixMsg path as fake equator positions (no real coordinates). */
export class ReplayFeeder {
  private readonly trace: ReplayTrace;
  private index = 0;

  constructor(trace: ReplayTrace) {
    this.trace = trace;
  }

  reset(): void {
    this.index = 0;
  }

  /** Fills `out` with the next fix if its t ≤ nowS and returns true; else false. Fake position: lat 0, lon = sAlongM / 111319.49. ageS = fix.ageS ?? meta.latencyS. */
  next(nowS: number, out: FixMsg): boolean {
    const f = this.trace.fixes[this.index];
    if (f === undefined || f.t > nowS) return false;
    this.index++;
    out.type = 'fix';
    out.ageS = f.ageS ?? this.trace.meta.latencyS;
    out.speedMps = f.speedMps;
    out.lat = 0;
    out.lon = f.sAlongM / METRES_PER_DEG_LON_AT_EQUATOR;
    out.accuracyM = f.accuracyM;
    out.altitudeM = null;
    return true;
  }
}
