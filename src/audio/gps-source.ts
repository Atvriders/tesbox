/**
 * Production GPS source (phase-3 contract T5; spec §4.3, §8.1, §8.2 step 1, §10.1).
 *
 * Polls `getCurrentPosition` (default) or runs `watchPosition`, drops cached repeats and hands every
 * other fix raw to `onFix` as a FixMsg; the worklet's speed filter does the rest (spec §8.2). It also
 * keeps the real-GPS "parked" estimate that locks Settings while the car moves, whatever speed source
 * is selected, so the shell keeps it running whenever geolocation is permitted. That estimate uses
 * only the fixes the worklet could accept (contract: "last accepted fix"): fresh and in order.
 *
 * Privacy (phase-3 global rules): coordinates leave this module only inside the FixMsg given to
 * `onFix`. The state that holds them lives in `#private` fields, so neither `JSON.stringify(source)`
 * nor a diagnostics walk (`assertNoCoordinates`) can reach them.
 */
import type { GpsStatus } from '../app/store';
import type { FixMsg } from '../contracts';
import { haversineM } from '../platform/geo';

/** The store's `gps.status` union (type-only, erased at runtime): 'off' = no geolocation or not running. */
export type { GpsStatus };

export interface GpsSourceOptions {
  method: 'poll' | 'watch';
  highAccuracy: boolean;
  /** `gpsLatencyS` (spec §4.3), added to every fix's age. */
  latencyS: number;
}

/** PositionOptions.timeout of every request (spec §8.1). */
export const GPS_TIMEOUT_MS = 2000;
/** Poll mode: a request starts at least this long after the previous one started. */
export const POLL_SPACING_MS = 1000;
/** Parked needs a counted fix that arrived less than this long ago (spec §10.1). */
export const PARKED_MAX_FIX_AGE_MS = 3000;
/**
 * A fix counts for parked only when taken at most this long before it arrived: the speed filter's
 * MAX_AGE_S (spec §8.2 step 1), on the raw age `Date.now() − timestamp`, without latencyS.
 */
export const PARKED_MAX_RAW_AGE_MS = 3000;
/**
 * …and only when taken more than this after the last counted fix: the speed filter's out-of-order
 * rule (MIN_ADVANCE_S), which also rejects an earlier fix delivered again (spec §8.2 step 1).
 */
export const PARKED_MIN_ADVANCE_MS = 50;
/** Parked needs a speed estimate below 5 km/h (spec §10.1). */
export const PARKED_MAX_SPEED_MPS = 5 / 3.6;
/** Displacement speed: from the newest fix back to the newest fix at least this much older… */
export const DISPLACEMENT_MIN_SPAN_MS = 2000;
/**
 * …which must be no more than this much older; beyond it the speed is unknown. Averaging over a
 * dropout would hide a pull-away at its end (0 → 6 m in the last 2 s of an 8 s gap reads 0.75 m/s).
 */
export const DISPLACEMENT_MAX_SPAN_MS = 5000;
/**
 * Hard cap on kept fixes. Defensive: the 50 ms order rule already keeps at most ~100 within the span,
 * but it is skipped while timestamps run ahead of the wall clock (see #track).
 */
const HISTORY_MAX = 64;
/** GeolocationPositionError.PERMISSION_DENIED. */
const PERMISSION_DENIED = 1;

interface Session {
  readonly geo: Geolocation;
  readonly method: 'poll' | 'watch';
  readonly highAccuracy: boolean;
  readonly options: PositionOptions;
  /** start() with the same method and accuracy only updates this. */
  latencyS: number;
  /** Poll: timer that starts the next request. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Watch: id from watchPosition. */
  watchId: number | null;
}

/** One counted fix for the parked estimate. */
interface Sample {
  /** GeolocationPosition.timestamp (epoch ms). */
  tsMs: number;
  lat: number;
  lon: number;
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Haversine displacement from the newest sample back to the most recently received sample 2–5 s
 * older (by timestamp), divided by that time span; NaN when there is none. Position-only, so it does
 * not trust `coords.speed` (Intel MCU2 reports 0 or null while moving, spec §3).
 */
function displacementSpeed(history: readonly Sample[]): number {
  const n = history[history.length - 1];
  if (n === undefined) return Number.NaN;
  for (let i = history.length - 2; i >= 0; i--) {
    const m = history[i];
    if (m === undefined) continue;
    const spanMs = n.tsMs - m.tsMs;
    if (spanMs >= DISPLACEMENT_MIN_SPAN_MS && spanMs <= DISPLACEMENT_MAX_SPAN_MS) {
      return haversineM(m.lat, m.lon, n.lat, n.lon) / (spanMs / 1000);
    }
  }
  return Number.NaN;
}

export class GpsSource {
  readonly #geo: Geolocation | undefined;
  readonly #onFix: (f: FixMsg) => void;
  readonly #onStatus: (s: GpsStatus) => void;
  readonly #now: () => number;

  #status: GpsStatus = 'off';
  #session: Session | null = null;
  /** A getCurrentPosition request is outstanding, possibly from an ended session (restart/stop). */
  #pending = false;
  #lastRequestAt = Number.NEGATIVE_INFINITY;

  /** The previous fix, to drop cached repeats; NaN never matches. */
  #lastTs = Number.NaN;
  #lastLat = Number.NaN;
  #lastLon = Number.NaN;

  /**
   * Parked estimate, from counted fixes only (#track): the last one's timestamp and arrival time (on
   * `#now`), recent ones, and the speed (NaN = unknown).
   */
  #countedTsMs = Number.NEGATIVE_INFINITY;
  #lastArrivalMs = Number.NEGATIVE_INFINITY;
  #history: Sample[] = [];
  #speedMps = Number.NaN;

  /**
   * @param geo `navigator.geolocation`, or undefined where there is none (then parked() is true).
   * @param now Clock for fix arrival, poll spacing and parked(); default `performance.now()`.
   */
  constructor(
    geo: Geolocation | undefined,
    onFix: (f: FixMsg) => void,
    onStatus: (s: GpsStatus) => void,
    now: () => number = () => performance.now(),
  ) {
    this.#geo = geo;
    this.#onFix = onFix;
    this.#onStatus = onStatus;
    this.#now = now;
  }

  /**
   * Starts (or restarts) the source. A call with the same method and accuracy as the running session
   * only applies the new latencyS. Without geolocation it does nothing (status stays 'off').
   */
  start(o: GpsSourceOptions): void {
    const current = this.#session;
    if (current !== null && current.method === o.method && current.highAccuracy === o.highAccuracy) {
      current.latencyS = o.latencyS;
      return;
    }
    this.#end();
    const geo = this.#geo;
    if (geo === undefined) return;
    const s: Session = {
      geo,
      method: o.method,
      highAccuracy: o.highAccuracy,
      options: { enableHighAccuracy: o.highAccuracy, timeout: GPS_TIMEOUT_MS, maximumAge: 0 },
      latencyS: o.latencyS,
      timer: null,
      watchId: null,
    };
    this.#session = s;
    this.#setStatus('waiting');
    if (s.method === 'poll') this.#poll(s);
    else this.#watch(s);
  }

  /** Stops polling / clears the watch; a late answer is ignored. Status → 'off'. */
  stop(): void {
    this.#end();
    this.#setStatus('off');
  }

  /**
   * Real-GPS parked estimate (spec §10.1): the last counted fix arrived less than 3 s ago and the
   * speed estimate is below 5 km/h. A fix counts when the worklet could accept it (see #track):
   * cached repeats, stale fixes and out-of-order fixes do not. The estimate is `coords.speed` when
   * finite and > 0, else the displacement speed (needs 2 s of fixes, so a reported 0 is never trusted
   * alone). True without geolocation (desktop). `nowMs` is on the constructor's clock.
   */
  parked(nowMs: number = this.#now()): boolean {
    if (this.#geo === undefined) return true;
    const sinceFixMs = nowMs - this.#lastArrivalMs;
    // NaN-safe: an unknown speed (NaN) or a NaN clock reading is never parked.
    return sinceFixMs >= 0 && sinceFixMs < PARKED_MAX_FIX_AGE_MS && this.#speedMps < PARKED_MAX_SPEED_MPS;
  }

  #setStatus(status: GpsStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#onStatus(status);
  }

  /** Ends the current session without a status change. */
  #end(): void {
    const s = this.#session;
    if (s === null) return;
    this.#session = null;
    if (s.timer !== null) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.watchId !== null) {
      s.geo.clearWatch(s.watchId);
      s.watchId = null;
    }
  }

  /**
   * One getCurrentPosition in flight, each starting ≥ POLL_SPACING_MS after the previous one — across
   * restarts too: an answer still owed to an ended session polls for the current one when it settles.
   */
  #poll(s: Session): void {
    if (this.#session !== s || this.#pending) return;
    // Clamped, and not re-checked when the timer fires, so a clock stepping back cannot stall polling.
    const waitMs = Math.min(POLL_SPACING_MS, POLL_SPACING_MS - (this.#now() - this.#lastRequestAt));
    if (waitMs > 0) {
      s.timer = setTimeout(() => {
        s.timer = null;
        this.#request(s);
      }, waitMs);
    } else {
      this.#request(s);
    }
  }

  #request(s: Session): void {
    if (this.#session !== s || this.#pending) return;
    this.#pending = true;
    this.#lastRequestAt = this.#now();
    let settled = false;
    const settle = (handle: () => void): void => {
      if (settled) return;
      settled = true;
      this.#pending = false;
      try {
        if (this.#session === s) handle();
      } finally {
        // Even when a consumer callback throws, polling goes on.
        const next = this.#session;
        if (next !== null && next.method === 'poll' && next.timer === null) this.#poll(next);
      }
    };
    try {
      s.geo.getCurrentPosition(
        (pos) => settle(() => this.#onPosition(s, pos)),
        (err) => settle(() => this.#onError(s, err)),
        s.options,
      );
    } catch {
      // A throwing implementation must not end polling: report it and retry after the spacing.
      settle(() => this.#setStatus('unavailable'));
    }
  }

  #watch(s: Session): void {
    let id: number;
    try {
      id = s.geo.watchPosition(
        (pos) => this.#onPosition(s, pos),
        (err) => this.#onError(s, err),
        s.options,
      );
    } catch {
      // No watch was registered: end the session so that the next start() tries again.
      if (this.#session === s) {
        this.#end();
        this.#setStatus('unavailable');
      }
      return;
    }
    if (this.#session === s) s.watchId = id;
    else s.geo.clearWatch(id); // ended (denied) before watchPosition returned
  }

  #onPosition(s: Session, pos: GeolocationPosition): void {
    if (this.#session !== s) return;
    const c = pos.coords;
    const tsMs = pos.timestamp;
    const lat = c.latitude;
    const lon = c.longitude;
    // The car repeats its cached fix (maximumAge is ignored, spec §3): a repeat carries no news.
    if (tsMs === this.#lastTs && lat === this.#lastLat && lon === this.#lastLon) return;
    this.#lastTs = tsMs;
    this.#lastLat = lat;
    this.#lastLon = lon;
    const wallMs = Date.now();
    const speedMps = finiteOrNull(c.speed);
    this.#track(wallMs, tsMs, lat, lon, speedMps);
    this.#setStatus('ok');
    // Posted whether or not it counted for parked: the worklet applies its own acceptance (spec §8.2).
    this.#onFix({
      type: 'fix',
      ageS: (wallMs - tsMs) / 1000 + s.latencyS,
      speedMps,
      lat,
      lon,
      accuracyM: c.accuracy,
      altitudeM: finiteOrNull(c.altitude),
    });
  }

  #onError(s: Session, err: GeolocationPositionError): void {
    if (this.#session !== s) return;
    if (err.code === PERMISSION_DENIED) {
      this.#end();
      this.#setStatus('denied');
    } else {
      this.#setStatus('unavailable'); // POSITION_UNAVAILABLE / TIMEOUT: keep trying
    }
  }

  /**
   * Parked bookkeeping for one new fix (not a repeat of the previous one). It counts — refreshes the
   * fix age, joins the history, sets the speed — only when the worklet could accept it (contract
   * global rules: "last accepted fix"; spec §8.2 step 1): taken at most 3 s before it arrived, and
   * after the last counted fix.
   */
  #track(wallMs: number, tsMs: number, lat: number, lon: number, speedMps: number | null): void {
    // Stale: a cached fix (the car's can be 91 s old, spec §3) or the first answer after the page was
    // hidden. Raw age without latencyS, so that no gpsLatencyS calibration can lock Settings for good.
    if (!(wallMs - tsMs <= PARKED_MAX_RAW_AGE_MS)) return; // NaN-safe
    // Out of order: an earlier fix delivered again, or a late one. Not applied while the last counted
    // timestamp is ahead of the wall clock (the clock stepped back, or skews): no timestamp can then
    // hold the later fixes back.
    const countedTsMs = this.#countedTsMs;
    if (!(tsMs > countedTsMs + PARKED_MIN_ADVANCE_MS) && countedTsMs <= wallMs) return;
    this.#countedTsMs = tsMs;
    this.#lastArrivalMs = this.#now();
    // Keep only fixes that can still pair with this one; a timestamp jump (either way) clears the rest.
    const history = this.#history.filter((h) => Math.abs(h.tsMs - tsMs) <= DISPLACEMENT_MAX_SPAN_MS);
    history.push({ tsMs, lat, lon });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    this.#history = history;
    this.#speedMps = speedMps !== null && speedMps > 0 ? speedMps : displacementSpeed(history);
  }
}
