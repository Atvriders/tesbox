import { haversineM } from '../platform/geo';

export interface GpsFix {
  arrivalPerfMs: number;
  arrivalEpochMs: number;
  timestampMs: number;
  lat: number;
  lon: number;
  accuracyM: number;
  speedMps: number | null;
  altitudeM: number | null;
  hidden: boolean;
}

export interface GpsModeSummary {
  mode: string;
  durationS: number;
  fixes: number;
  errors: { permission: number; unavailable: number; timeout: number };
  intervalMedianMs: number | null;
  intervalP95Ms: number | null;
  ageMedianMs: number | null;
  ageP95Ms: number | null;
  staleOver3sPct: number;
  duplicatePct: number;
  speedNullPct: number;
  speedZeroPct: number;
  speedZeroWhileMovingPct: number;
  accuracyMedianM: number | null;
  altitudePresentPct: number;
  fixesWhileHidden: number;
  maxSpeedMps: number | null;
  crashedPreviously: boolean;
}

const STALE_AGE_MS = 3000;
const MOVING_LOOKBACK_MS = 5000;
const MOVING_DISTANCE_M = 20;

/** Nearest-rank percentile (p in 1..100) of an ascending array; null when empty. */
function nearestRank(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p * n) / 100)));
  return sorted[rank - 1] ?? null;
}

function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Rounds to `digits` decimals; keeps the QR summary compact. */
function round(value: number | null, digits: number): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Collects one GPS mode run. Coordinates stay inside this object and never appear in the summary. */
export class GpsStats {
  private readonly fixList: GpsFix[] = [];
  private readonly intervals: number[] = [];
  private readonly ages: number[] = [];
  private readonly accuracies: number[] = [];
  private readonly errors = { permission: 0, unavailable: 0, timeout: 0 };
  private stale = 0;
  private duplicates = 0;
  private speedNull = 0;
  private speedZero = 0;
  private speedZeroMoving = 0;
  private altitudePresent = 0;
  private hiddenFixes = 0;
  private maxSpeed: number | null = null;

  constructor(private readonly mode: string) {}

  add(fix: GpsFix): void {
    const prev = this.fixList[this.fixList.length - 1];
    if (prev !== undefined) {
      this.intervals.push(fix.arrivalPerfMs - prev.arrivalPerfMs);
      if (prev.timestampMs === fix.timestampMs && prev.lat === fix.lat && prev.lon === fix.lon) {
        this.duplicates++;
      }
    }
    const ageMs = fix.arrivalEpochMs - fix.timestampMs;
    this.ages.push(ageMs);
    if (ageMs > STALE_AGE_MS) this.stale++;

    const speed = fix.speedMps !== null && Number.isFinite(fix.speedMps) ? fix.speedMps : null;
    if (speed === null) {
      this.speedNull++;
    } else {
      if (speed === 0) {
        this.speedZero++;
        if (this.movedOverThreshold(fix)) this.speedZeroMoving++;
      }
      if (this.maxSpeed === null || speed > this.maxSpeed) this.maxSpeed = speed;
    }

    this.accuracies.push(fix.accuracyM);
    if (fix.altitudeM !== null) this.altitudePresent++;
    if (fix.hidden) this.hiddenFixes++;
    this.fixList.push(fix);
  }

  addError(code: 1 | 2 | 3): void {
    if (code === 1) this.errors.permission++;
    else if (code === 2) this.errors.unavailable++;
    else this.errors.timeout++;
  }

  summary(durationS: number, crashedPreviously: boolean): GpsModeSummary {
    const fixes = this.fixList.length;
    const pct = (n: number): number => (fixes === 0 ? 0 : Math.round((n / fixes) * 1000) / 10);
    const intervals = ascending(this.intervals);
    const ages = ascending(this.ages);
    const accuracies = ascending(this.accuracies);
    return {
      mode: this.mode,
      durationS,
      fixes,
      errors: { ...this.errors },
      intervalMedianMs: round(nearestRank(intervals, 50), 0),
      intervalP95Ms: round(nearestRank(intervals, 95), 0),
      ageMedianMs: round(nearestRank(ages, 50), 0),
      ageP95Ms: round(nearestRank(ages, 95), 0),
      staleOver3sPct: pct(this.stale),
      duplicatePct: pct(this.duplicates),
      speedNullPct: pct(this.speedNull),
      speedZeroPct: pct(this.speedZero),
      speedZeroWhileMovingPct: pct(this.speedZeroMoving),
      accuracyMedianM: round(nearestRank(accuracies, 50), 1),
      altitudePresentPct: pct(this.altitudePresent),
      fixesWhileHidden: this.hiddenFixes,
      maxSpeedMps: round(this.maxSpeed, 2),
      crashedPreviously,
    };
  }

  /** Displacement from the latest earlier fix that arrived ≥ 5 s before `fix` exceeds 20 m. */
  private movedOverThreshold(fix: GpsFix): boolean {
    const cutoff = fix.arrivalPerfMs - MOVING_LOOKBACK_MS;
    for (let i = this.fixList.length - 1; i >= 0; i--) {
      const earlier = this.fixList[i];
      if (earlier !== undefined && earlier.arrivalPerfMs <= cutoff) {
        return haversineM(earlier.lat, earlier.lon, fix.lat, fix.lon) > MOVING_DISTANCE_M;
      }
    }
    return false;
  }
}
