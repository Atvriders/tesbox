import { getJSON, remove, setJSON } from '../platform/storage';
import { GpsStats, type GpsFix, type GpsModeSummary } from './gps-stats';
import { errText, type EventLog } from './log';

export interface GpsMode {
  method: 'poll' | 'watch';
  highAccuracy: boolean;
}

export const GPS_MODES: GpsMode[] = [
  { method: 'poll', highAccuracy: false },
  { method: 'poll', highAccuracy: true },
  { method: 'watch', highAccuracy: false },
  { method: 'watch', highAccuracy: true },
];

export function modeName(m: GpsMode): string {
  return `${m.method}-hiacc-${m.highAccuracy ? 'on' : 'off'}`;
}

/** Storage key of the crash marker (storage.ts adds the "tesbox.v1." prefix). */
export const CRASH_KEY = 'probe.gpsRun';

const REQUEST_TIMEOUT_MS = 2000;
const POLL_MIN_SPACING_MS = 1000;

interface CrashMarker {
  mode: string;
  startedAt: string;
}

function isCrashMarker(v: unknown): v is CrashMarker {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.mode === 'string' && typeof r.startedAt === 'string';
}

/**
 * Modes whose crash marker was found (by previousCrash() or at run start) and not yet reported.
 * Module-level because previousCrash() is static and usually runs before any GpsRunner exists.
 */
const crashedModes = new Set<string>();

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

type Timer = ReturnType<typeof setTimeout>;

interface ActiveRun {
  readonly name: string;
  readonly stats: GpsStats;
  readonly options: PositionOptions;
  readonly t0: number;
  readonly durationS: number;
  readonly crashedPreviously: boolean;
  readonly isHidden: () => boolean;
  readonly resolve: (summary: GpsModeSummary) => void;
  endTimer: Timer | null;
  pollTimer: Timer | null;
  watchId: number | null;
}

/** Runs one GPS mode of the probe matrix. Coordinates go only into GpsStats, never into the log. */
export class GpsRunner {
  private active: ActiveRun | null = null;

  constructor(
    private readonly geo: Geolocation,
    private readonly log: EventLog,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get running(): boolean {
    return this.active !== null;
  }

  /** Reads and clears the crash marker left by a run that never finished (page crash/reload). */
  static previousCrash(): { mode: string; startedAt: string } | null {
    const raw = getJSON<unknown>(CRASH_KEY, null);
    if (raw === null) return null;
    remove(CRASH_KEY);
    if (!isCrashMarker(raw)) return null;
    crashedModes.add(raw.mode);
    return { mode: raw.mode, startedAt: raw.startedAt };
  }

  /** Writes crash marker {mode, startedAt}, runs for durationS, clears marker, resolves summary. */
  run(mode: GpsMode, durationS: number, isHidden: () => boolean = documentHidden): Promise<GpsModeSummary> {
    if (this.active !== null) {
      return Promise.reject(new Error(`GPS run already in progress (${this.active.name})`));
    }
    const name = modeName(mode);
    GpsRunner.previousCrash(); // consume a marker the page has not read yet
    const crashedPreviously = crashedModes.delete(name);
    const marker: CrashMarker = { mode: name, startedAt: new Date().toISOString() };
    setJSON(CRASH_KEY, marker);
    const safeDurationS = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;

    return new Promise<GpsModeSummary>((resolve) => {
      const run: ActiveRun = {
        name,
        stats: new GpsStats(name),
        options: { enableHighAccuracy: mode.highAccuracy, timeout: REQUEST_TIMEOUT_MS, maximumAge: 0 },
        t0: this.now(),
        durationS: safeDurationS,
        crashedPreviously,
        isHidden,
        resolve,
        endTimer: null,
        pollTimer: null,
        watchId: null,
      };
      this.active = run;
      this.log.push('gps', `run ${name} start ${safeDurationS}s`);
      run.endTimer = setTimeout(() => this.finish(run), safeDurationS * 1000);
      try {
        if (mode.method === 'poll') {
          this.poll(run);
        } else {
          run.watchId = this.geo.watchPosition(
            (pos) => this.onPosition(run, pos),
            (err) => this.onError(run, err),
            run.options,
          );
        }
      } catch (e) {
        // A throwing Geolocation implementation must not leave the runner stuck; the run still ends at durationS.
        this.log.push('error', `gps ${name} start failed: ${errText(e)}`);
      }
    });
  }

  stop(): void {
    if (this.active !== null) this.finish(this.active);
  }

  /** One getCurrentPosition in flight; the next starts when it settles, ≥ 1000 ms after this one started. */
  private poll(run: ActiveRun): void {
    if (this.active !== run) return;
    run.pollTimer = null;
    const startedAt = this.now();
    let settled = false;
    const settle = (): void => {
      if (this.active !== run) return;
      const wait = POLL_MIN_SPACING_MS - (this.now() - startedAt);
      // wait ≤ 0 is only possible after ≥ 1 s, so calling poll() directly cannot recurse without bound.
      if (wait <= 0) this.poll(run);
      else run.pollTimer = setTimeout(() => this.poll(run), wait);
    };
    this.geo.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        this.onPosition(run, pos);
        settle();
      },
      (err) => {
        if (settled) return;
        settled = true;
        this.onError(run, err);
        settle();
      },
      run.options,
    );
  }

  private onPosition(run: ActiveRun, pos: GeolocationPosition): void {
    if (this.active !== run) return;
    const c = pos.coords;
    const fix: GpsFix = {
      arrivalPerfMs: this.now(),
      arrivalEpochMs: Date.now(),
      timestampMs: pos.timestamp,
      lat: c.latitude,
      lon: c.longitude,
      accuracyM: c.accuracy,
      speedMps: finiteOrNull(c.speed),
      altitudeM: finiteOrNull(c.altitude),
      hidden: run.isHidden(),
    };
    run.stats.add(fix);
    const speed = fix.speedMps === null ? 'null' : fix.speedMps.toFixed(2);
    this.log.push(
      'gps',
      `fix age=${Math.round(fix.arrivalEpochMs - fix.timestampMs)}ms acc=${Math.round(fix.accuracyM)}m speed=${speed}`,
    );
  }

  private onError(run: ActiveRun, err: GeolocationPositionError): void {
    if (this.active !== run) return;
    const code: 1 | 2 | 3 = err.code === 1 || err.code === 3 ? err.code : 2;
    run.stats.addError(code);
    this.log.push('gps', `error code=${code}`);
  }

  private finish(run: ActiveRun): void {
    if (this.active !== run) return;
    this.active = null;
    if (run.endTimer !== null) clearTimeout(run.endTimer);
    if (run.pollTimer !== null) clearTimeout(run.pollTimer);
    if (run.watchId !== null) this.geo.clearWatch(run.watchId);
    remove(CRASH_KEY);
    const elapsedS = Math.min(run.durationS, Math.max(0, (this.now() - run.t0) / 1000));
    const summary = run.stats.summary(Math.round(elapsedS * 10) / 10, run.crashedPreviously);
    const e = summary.errors;
    this.log.push(
      'gps',
      `run ${run.name} end fixes=${summary.fixes} errors=${e.permission}/${e.unavailable}/${e.timeout}`,
    );
    run.resolve(summary);
  }
}
