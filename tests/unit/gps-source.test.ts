import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FixMsg } from '../../src/contracts';
import { assertNoCoordinates } from '../../src/probe/summary';
import { GpsSource, type GpsSourceOptions, type GpsStatus } from '../../src/audio/gps-source';

const POLL: GpsSourceOptions = { method: 'poll', highAccuracy: false, latencyS: 1 };
const POLL_HI: GpsSourceOptions = { method: 'poll', highAccuracy: true, latencyS: 1 };
const WATCH: GpsSourceOptions = { method: 'watch', highAccuracy: false, latencyS: 1 };
const WATCH_HI: GpsSourceOptions = { method: 'watch', highAccuracy: true, latencyS: 1 };

/** Metres per degree on the haversine sphere: a fix sM metres north of another is sM metres away. */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;
// Fake positions near 0,0 (open ocean). They must never leave GpsSource except inside a FixMsg.
const FAKE_LAT0 = 0.0123456;
const FAKE_LON = 0.0654321;
/** The fake GPS stamps every fix this long before delivering it. */
const LAG_MS = 800;

const latOf = (sM: number): number => FAKE_LAT0 + sM / M_PER_DEG;
/** Near the equator a degree of longitude is (almost) as long as one of latitude. */
const lonOf = (eastM: number): number => FAKE_LON + eastM / M_PER_DEG;

interface FixSpec {
  /** Distance north of the fake origin, metres. */
  sM?: number;
  /** Distance east of the fake origin, metres. */
  eastM?: number;
  speed?: number | null;
  altitude?: number | null;
  accuracy?: number;
  /** Position timestamp (epoch ms); default Date.now() − LAG_MS. */
  tsMs?: number;
}

function position(f: FixSpec = {}): GeolocationPosition {
  const coords = {
    latitude: latOf(f.sM ?? 0),
    longitude: lonOf(f.eastM ?? 0),
    accuracy: f.accuracy ?? 5,
    altitude: f.altitude ?? null,
    altitudeAccuracy: null,
    heading: null,
    speed: f.speed ?? null,
    toJSON: () => ({}),
  };
  return { coords, timestamp: f.tsMs ?? Date.now() - LAG_MS, toJSON: () => ({}) };
}

function positionError(code: 1 | 2 | 3): GeolocationPositionError {
  return { code, message: `code ${code}`, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

type Answer =
  | { kind: 'fix'; latencyMs: number; fix?: () => FixSpec }
  | { kind: 'error'; code: 1 | 2 | 3; latencyMs: number }
  | { kind: 'timeout' } // TIMEOUT after options.timeout, like a browser without a fix
  | { kind: 'hang' } // never answers (permission prompt still open)
  | { kind: 'throw' } // getCurrentPosition throws synchronously
  | { kind: 'twice'; latencyMs: number }; // a broken implementation: a fix, then an error, for one request

class FakeGeo implements Geolocation {
  /** getCurrentPosition answer, after the per-request `script` (first in, first out) runs out. */
  answer: Answer = { kind: 'fix', latencyMs: 50 };
  script: Answer[] = [];
  requestOptions: PositionOptions[] = [];
  requestStarts: number[] = [];
  watchOptions: PositionOptions[] = [];
  clearedWatchIds: number[] = [];
  /** watchPosition calls its error callback with PERMISSION_DENIED before returning. */
  denyWatchSynchronously = false;
  /** watchPosition throws instead of registering a watch. */
  throwOnWatch = false;
  /** Exceptions thrown by the page's callbacks: a browser reports them instead of propagating them. */
  callbackErrors: unknown[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private nextWatchId = 41;
  private readonly watchers = new Map<number, { ok: PositionCallback; err: PositionErrorCallback | null | undefined }>();

  getCurrentPosition(ok: PositionCallback, err?: PositionErrorCallback | null, options?: PositionOptions): void {
    this.requestOptions.push(options ?? {});
    this.requestStarts.push(performance.now());
    const a = this.script.shift() ?? this.answer;
    if (a.kind === 'throw') throw new Error('geolocation broke');
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (a.kind === 'hang') return;
    const delay = a.kind === 'timeout' ? (options?.timeout ?? 0) : a.latencyMs;
    setTimeout(() => {
      this.inFlight--;
      if (a.kind === 'fix') this.deliver(() => ok(position(a.fix?.())));
      else if (a.kind === 'twice') {
        this.deliver(() => ok(position()));
        this.deliver(() => err?.(positionError(2)));
      } else this.deliver(() => err?.(positionError(a.kind === 'timeout' ? 3 : a.code)));
    }, delay);
  }

  watchPosition(ok: PositionCallback, err?: PositionErrorCallback | null, options?: PositionOptions): number {
    this.watchOptions.push(options ?? {});
    if (this.throwOnWatch) throw new Error('geolocation broke');
    const id = this.nextWatchId++;
    this.watchers.set(id, { ok, err });
    if (this.denyWatchSynchronously) this.deliver(() => err?.(positionError(1)));
    return id;
  }

  clearWatch(watchId: number): void {
    this.watchers.delete(watchId);
    this.clearedWatchIds.push(watchId);
  }

  get activeWatches(): number {
    return this.watchers.size;
  }

  /** Delivers `pos` to every active watch now. */
  emit(pos: GeolocationPosition): void {
    for (const w of [...this.watchers.values()]) this.deliver(() => w.ok(pos));
  }

  emitError(code: 1 | 2 | 3): void {
    for (const w of [...this.watchers.values()]) this.deliver(() => w.err?.(positionError(code)));
  }

  private deliver(callback: () => void): void {
    try {
      callback();
    } catch (e) {
      this.callbackErrors.push(e);
    }
  }
}

let geo: FakeGeo;
let fixes: FixMsg[];
let statuses: GpsStatus[];
let src: GpsSource;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  geo = new FakeGeo();
  fixes = [];
  statuses = [];
  src = new GpsSource(
    geo,
    (f) => fixes.push(f),
    (s) => statuses.push(s),
  );
});

afterEach(() => {
  src.stop();
  vi.useRealTimers();
});

/** Starts `source` in watch mode; the returned function delivers one fix at the current fake time. */
function watching(source: GpsSource = src): (f?: FixSpec) => void {
  source.start(WATCH);
  return (f) => geo.emit(position(f));
}

/** Delivers the fixes 1 s apart (the first one now) and returns parked() right after each. */
function drive(emit: (f: FixSpec) => void, specs: FixSpec[]): boolean[] {
  return specs.map((f, i) => {
    if (i > 0) vi.advanceTimersByTime(1000);
    emit(f);
    return src.parked();
  });
}

/** n fixes 1 s apart moving at v m/s from sM = 0, reporting `speed` as coords.speed. */
function trace(n: number, v: number, speed: number | null): FixSpec[] {
  return Array.from({ length: n }, (_, i) => ({ sM: v * i, speed }));
}

describe('GpsSource poll mode', () => {
  it('keeps one getCurrentPosition in flight with the contract options, starts ≥ 1000 ms apart', async () => {
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(4500);
    expect(geo.requestOptions[0]).toEqual({ enableHighAccuracy: false, timeout: 2000, maximumAge: 0 });
    expect(geo.requestStarts).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(geo.maxInFlight).toBe(1);
    expect(geo.watchOptions).toEqual([]);
    expect(fixes).toHaveLength(5);
  });

  it('passes highAccuracy as enableHighAccuracy', async () => {
    src.start(POLL_HI);
    await vi.advanceTimersByTimeAsync(100);
    expect(geo.requestOptions).toEqual([{ enableHighAccuracy: true, timeout: 2000, maximumAge: 0 }]);
  });

  it('issues the next request as soon as a slow answer settles', async () => {
    geo.answer = { kind: 'fix', latencyMs: 1500 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(5000);
    expect(geo.requestStarts).toEqual([0, 1500, 3000, 4500]);
    expect(geo.maxInFlight).toBe(1);
  });

  it('keeps polling through timeouts, one request at a time', async () => {
    geo.answer = { kind: 'timeout' };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(5000);
    expect(geo.requestStarts).toEqual([0, 2000, 4000]);
    expect(geo.maxInFlight).toBe(1);
    expect(fixes).toEqual([]);
  });
});

describe('GpsSource FixMsg', () => {
  it('posts ageS = (Date.now() − timestamp)/1000 + latencyS with the raw position, accuracy and altitude', async () => {
    geo.answer = { kind: 'fix', latencyMs: 50, fix: () => ({ sM: 12, speed: 3.5, altitude: 41.5, accuracy: 4.4 }) };
    src.start({ method: 'poll', highAccuracy: false, latencyS: 1.25 });
    await vi.advanceTimersByTimeAsync(100);
    expect(fixes).toHaveLength(1);
    const { ageS, ...rest } = fixes[0]!;
    expect(ageS).toBeCloseTo(0.8 + 1.25, 9);
    expect(rest).toEqual({
      type: 'fix',
      speedMps: 3.5,
      lat: FAKE_LAT0 + 12 / M_PER_DEG,
      lon: FAKE_LON,
      accuracyM: 4.4,
      altitudeM: 41.5,
    });
  });

  it.each([
    [3.5, 3.5],
    [0, 0],
    [-1, -1],
    [null, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ])('coords.speed %s → speedMps %s (finite passes through, otherwise null)', (speed, expected) => {
    watching()({ speed });
    expect(fixes[0]?.speedMps).toBe(expected);
  });

  it.each([
    [41.5, 41.5],
    [0, 0],
    [null, null],
    [Number.NaN, null],
    [Number.NEGATIVE_INFINITY, null],
  ])('coords.altitude %s → altitudeM %s', (altitude, expected) => {
    watching()({ altitude });
    expect(fixes[0]?.altitudeM).toBe(expected);
  });

  it('drops a repeat with identical (timestamp, lat, lon); a changed timestamp, lat or lon is a new fix', () => {
    const emit = watching();
    const ts = Date.now() - LAG_MS;
    emit({ sM: 5, tsMs: ts });
    emit({ sM: 5, tsMs: ts }); // the cached fix again
    emit({ sM: 5, eastM: 3, tsMs: ts }); // same timestamp and latitude, moved east
    emit({ sM: 6, eastM: 3, tsMs: ts }); // same timestamp and longitude, moved north
    emit({ sM: 6, eastM: 3, tsMs: ts + 1000 }); // same position, new timestamp
    expect(fixes.map((f) => [f.lat, f.lon])).toEqual([
      [latOf(5), lonOf(0)],
      [latOf(5), lonOf(3)],
      [latOf(6), lonOf(3)],
      [latOf(6), lonOf(3)],
    ]);
    expect(statuses).toEqual(['waiting', 'ok']);
  });
});

describe('GpsSource status', () => {
  it("reports 'waiting' on start and 'ok' on the first fix, only when it changes", async () => {
    src.start(POLL);
    expect(statuses).toEqual(['waiting']);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fixes).toHaveLength(3);
    expect(statuses).toEqual(['waiting', 'ok']);
  });

  it("permission denied → 'denied' and polling stops", async () => {
    geo.answer = { kind: 'error', code: 1, latencyMs: 10 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(5000);
    expect(geo.requestStarts).toEqual([0]);
    expect(statuses).toEqual(['waiting', 'denied']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'unavailable' while requests fail (unavailable, timeout), 'ok' again on the next fix", async () => {
    geo.script = [{ kind: 'error', code: 2, latencyMs: 10 }, { kind: 'timeout' }, { kind: 'error', code: 2, latencyMs: 10 }];
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(3500);
    expect(statuses).toEqual(['waiting', 'unavailable']);
    await vi.advanceTimersByTimeAsync(600);
    expect(statuses).toEqual(['waiting', 'unavailable', 'ok']);
    expect(geo.requestStarts).toEqual([0, 1000, 3000, 4000]);
  });

  it("a getCurrentPosition that throws reports 'unavailable' and polling retries 1000 ms later", async () => {
    geo.script = [{ kind: 'throw' }];
    src.start(POLL);
    expect(statuses).toEqual(['waiting', 'unavailable']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(geo.requestStarts).toEqual([0, 1000]);
    expect(statuses).toEqual(['waiting', 'unavailable', 'ok']);
  });

  it("a cached repeat changes no status: 'unavailable' after an error, 'waiting' after a restart", () => {
    const emit = watching();
    const cached: FixSpec = { sM: 0, tsMs: Date.now() - LAG_MS };
    emit(cached);
    geo.emitError(2);
    emit(cached); // the car's cached fix again: no news, so still failing
    expect(statuses).toEqual(['waiting', 'ok', 'unavailable']);
    src.start(WATCH_HI); // restart
    emit(cached);
    expect(statuses).toEqual(['waiting', 'ok', 'unavailable', 'waiting']);
    expect(fixes).toHaveLength(1);
    emit({ sM: 1 }); // a new fix
    expect(statuses).toEqual(['waiting', 'ok', 'unavailable', 'waiting', 'ok']);
    expect(fixes).toHaveLength(2);
  });

  it('counts only the first answer when getCurrentPosition calls back twice for one request', async () => {
    geo.script = [{ kind: 'twice', latencyMs: 50 }];
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1500);
    expect(statuses).toEqual(['waiting', 'ok']); // the stray error after the fix is ignored
    expect(fixes).toHaveLength(2); // at 50 and 1050 ms
    expect(geo.requestStarts).toEqual([0, 1000]);
    expect(geo.maxInFlight).toBe(1);
  });

  it('keeps polling when the onFix callback throws', async () => {
    const s = new GpsSource(
      geo,
      () => {
        throw new Error('consumer bug');
      },
      () => undefined,
    );
    s.start(POLL);
    await vi.advanceTimersByTimeAsync(2500);
    expect(geo.requestStarts).toEqual([0, 1000, 2000]);
    expect(geo.callbackErrors).toHaveLength(3);
    s.stop();
  });
});

describe('GpsSource start/stop', () => {
  it("stop() cancels the next request, leaves no timers and reports 'off'", async () => {
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(500); // fix at 50 ms; the next request is due at 1000 ms
    src.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(geo.requestStarts).toEqual([0]);
    expect(statuses).toEqual(['waiting', 'ok', 'off']);
  });

  it('ignores an answer that arrives after stop()', async () => {
    geo.answer = { kind: 'fix', latencyMs: 400 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1100); // request 2 started at 1000 ms, answers at 1400 ms
    src.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixes).toHaveLength(1);
    expect(geo.requestStarts).toEqual([0, 1000]);
    expect(statuses).toEqual(['waiting', 'ok', 'off']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() with the same method and accuracy keeps the running chain and applies a new latencyS', async () => {
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1500);
    src.start({ ...POLL, latencyS: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(geo.requestStarts).toEqual([0, 1000, 2000]);
    expect(statuses).toEqual(['waiting', 'ok']);
    const ages = fixes.map((f) => f.ageS);
    expect(ages).toHaveLength(3);
    [1.8, 1.8, 2.8].forEach((a, i) => expect(ages[i]).toBeCloseTo(a, 9));
  });

  it('a restart keeps one request in flight and ≥ 1000 ms between starts, dropping the old answer', async () => {
    geo.answer = { kind: 'fix', latencyMs: 400 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1100); // request 2 (old options) is out until 1400 ms
    src.start(POLL_HI);
    await vi.advanceTimersByTimeAsync(3000);
    expect(geo.maxInFlight).toBe(1);
    expect(geo.requestStarts).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(geo.requestOptions.map((o) => o.enableHighAccuracy)).toEqual([false, false, true, true, true]);
    expect(fixes).toHaveLength(3); // 400, 2400 and 3400 ms; the 1400 ms answer belonged to the old chain
    expect(statuses).toEqual(['waiting', 'ok', 'waiting', 'ok']);
  });

  it('a restart while a slow request is out waits for its answer before the next request', async () => {
    geo.answer = { kind: 'fix', latencyMs: 1500 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1600); // request 2 started at 1500 ms, answers at 3000 ms
    src.start(POLL_HI);
    await vi.advanceTimersByTimeAsync(3000);
    expect(geo.maxInFlight).toBe(1);
    expect(geo.requestStarts).toEqual([0, 1500, 3000, 4500]);
    expect(geo.requestOptions.map((o) => o.enableHighAccuracy)).toEqual([false, false, true, true]);
  });

  it('a clock that jumps backwards delays the next request by at most 1000 ms', async () => {
    let offsetMs = 0;
    const s = new GpsSource(
      geo,
      () => undefined,
      () => undefined,
      () => performance.now() + offsetMs,
    );
    s.start(POLL);
    await vi.advanceTimersByTimeAsync(10); // request 1 is out until 50 ms
    offsetMs = -3_600_000;
    await vi.advanceTimersByTimeAsync(1100);
    expect(geo.requestStarts).toEqual([0, 1050]);
    s.stop();
  });

  it('switching to watch stops polling', async () => {
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1500);
    src.start(WATCH_HI);
    await vi.advanceTimersByTimeAsync(5000);
    expect(geo.requestStarts).toEqual([0, 1000]);
    expect(geo.watchOptions).toEqual([{ enableHighAccuracy: true, timeout: 2000, maximumAge: 0 }]);
    expect(statuses).toEqual(['waiting', 'ok', 'waiting']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() after a denial polls again (permission re-granted)', async () => {
    geo.answer = { kind: 'error', code: 1, latencyMs: 10 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(100);
    geo.answer = { kind: 'fix', latencyMs: 50 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(2000);
    expect(statuses).toEqual(['waiting', 'denied', 'waiting', 'ok']);
    expect(geo.requestStarts).toEqual([0, 1000, 2000]);
  });
});

describe('GpsSource watch mode', () => {
  it('uses watchPosition with the contract options and clears the watch on stop()', () => {
    const emit = watching();
    expect(geo.watchOptions).toEqual([{ enableHighAccuracy: false, timeout: 2000, maximumAge: 0 }]);
    emit({ sM: 0 });
    vi.advanceTimersByTime(1000);
    emit({ sM: 1 });
    expect(fixes).toHaveLength(2);
    expect(geo.requestStarts).toEqual([]);
    src.stop();
    expect(geo.clearedWatchIds).toEqual([41]);
    expect(geo.activeWatches).toBe(0);
    expect(statuses).toEqual(['waiting', 'ok', 'off']);
  });

  it("'unavailable' on watch errors, 'ok' on the next fix, 'denied' clears the watch", () => {
    const emit = watching();
    geo.emitError(3);
    geo.emitError(2);
    emit({});
    geo.emitError(1);
    expect(statuses).toEqual(['waiting', 'unavailable', 'ok', 'denied']);
    expect(geo.clearedWatchIds).toEqual([41]);
    expect(geo.activeWatches).toBe(0);
  });

  it("a watchPosition that throws reports 'unavailable' and the next start() tries again", () => {
    geo.throwOnWatch = true;
    src.start(WATCH);
    expect(statuses).toEqual(['waiting', 'unavailable']);
    geo.throwOnWatch = false;
    const emit = watching(); // the same options
    emit({});
    expect(statuses).toEqual(['waiting', 'unavailable', 'waiting', 'ok']);
    expect(fixes).toHaveLength(1);
  });

  it('clears a watch that is denied before watchPosition returns', () => {
    geo.denyWatchSynchronously = true;
    src.start(WATCH);
    expect(statuses).toEqual(['waiting', 'denied']);
    expect(geo.clearedWatchIds).toEqual([41]);
    expect(geo.activeWatches).toBe(0);
  });
});

describe('GpsSource parked()', () => {
  it("is true without geolocation (desktop), where start() leaves the status 'off'", () => {
    const desk = new GpsSource(
      undefined,
      (f) => fixes.push(f),
      (s) => statuses.push(s),
    );
    expect(desk.parked()).toBe(true);
    desk.start(POLL);
    expect(desk.parked()).toBe(true);
    desk.stop();
    expect(statuses).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is false before any fix and after a denial', async () => {
    expect(src.parked()).toBe(false);
    geo.answer = { kind: 'error', code: 1, latencyMs: 10 };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(100);
    expect(src.parked()).toBe(false);
  });

  it('uses coords.speed when finite and > 0: one fresh fix decides, against 5 km/h (AMD)', () => {
    const emit = watching();
    emit({ sM: 0, speed: 0.4 });
    expect(src.parked()).toBe(true);
    vi.advanceTimersByTime(100);
    emit({ sM: 0.1, speed: 1.39 }); // 5.004 km/h
    expect(src.parked()).toBe(false);
    vi.advanceTimersByTime(100);
    emit({ sM: 0.2, speed: 1.38 }); // 4.968 km/h
    expect(src.parked()).toBe(true);
  });

  it('needs the last fix to have arrived less than 3 s ago', () => {
    watching()({ speed: 0.4 });
    const arrived = performance.now();
    expect(src.parked(arrived + 2999)).toBe(true);
    expect(src.parked(arrived + 3000)).toBe(false);
    expect(src.parked(arrived - 1)).toBe(false); // a clock reading before the arrival proves nothing
    expect(src.parked(Number.NaN)).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(src.parked()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(src.parked()).toBe(false);
  });

  it('times fix arrival with the injected clock (ageS still uses Date.now)', () => {
    let clockMs = 50_000;
    const s = new GpsSource(
      geo,
      (f) => fixes.push(f),
      () => undefined,
      () => clockMs,
    );
    s.start(WATCH);
    geo.emit(position({ speed: 0.4 }));
    expect(fixes[0]?.ageS).toBeCloseTo(1.8, 9);
    clockMs += 2999;
    expect(s.parked()).toBe(true);
    clockMs += 1;
    expect(s.parked()).toBe(false);
    s.stop();
  });

  it('Intel: coords.speed 0 at a standstill is parked once the fixes span 2 s', () => {
    expect(drive(watching(), trace(5, 0, 0))).toEqual([false, false, true, true, true]);
  });

  it('Intel: coords.speed 0 while moving reads the displacement and is not parked', () => {
    expect(drive(watching(), trace(6, 10, 0))).toEqual([false, false, false, false, false, false]);
  });

  it('a negative coords.speed (invalid on some platforms) while moving reads the displacement and is not parked', () => {
    expect(drive(watching(), trace(6, 10, -1))).toEqual([false, false, false, false, false, false]);
  });

  it.each([
    [0, 1, true],
    [0, 1.5, false],
    [null, 1, true],
    [null, 1.5, false],
    [-1, 0, true],
    [-1, 1, true],
    [-1, 1.5, false],
  ])('coords.speed %s at %s m/s: the 2 s displacement decides', (speed, v, still) => {
    expect(drive(watching(), trace(5, v, speed))).toEqual([false, false, still, still, still]);
  });

  it('measures back to the newest fix at least 2 s older, so pulling away shows within 2 s', () => {
    const emit = watching();
    drive(emit, trace(11, 0, 0)); // parked at 1 Hz for 10 s
    expect(src.parked()).toBe(true);
    // Pulls away at 2 m/s², still reporting speed 0.
    vi.advanceTimersByTime(1000);
    emit({ sM: 1, speed: 0 });
    expect(src.parked()).toBe(true); // 1 m in the last 2 s: 1.8 km/h
    vi.advanceTimersByTime(1000);
    emit({ sM: 4, speed: 0 });
    expect(src.parked()).toBe(false); // 4 m in the last 2 s: 7.2 km/h
  });

  it('a gap over 5 s leaves the displacement unknown until 2 s of fixes follow', () => {
    const emit = watching();
    emit({ sM: 0, speed: 0 });
    vi.advanceTimersByTime(1000);
    emit({ sM: 0, speed: 0 });
    vi.advanceTimersByTime(8000); // dropout
    // Rolled 6 m, mostly near the end of the gap: an 8 s average (0.75 m/s) would read as parked.
    emit({ sM: 6, speed: 0 });
    expect(src.parked()).toBe(false);
    vi.advanceTimersByTime(1000);
    emit({ sM: 6, speed: 0 });
    expect(src.parked()).toBe(false); // the newest fix ≥ 2 s older is 9 s back
    vi.advanceTimersByTime(1000);
    emit({ sM: 6, speed: 0 });
    expect(src.parked()).toBe(true); // 0 m over the last 2 s
  });

  it('cached repeats are dropped and do not refresh the fix age', () => {
    const emit = watching();
    const cached: FixSpec = { sM: 0, speed: 0.4, tsMs: Date.now() - LAG_MS };
    expect(drive(emit, [cached, cached, cached, cached])).toEqual([true, true, true, false]);
    expect(fixes).toHaveLength(1);
    vi.advanceTimersByTime(500);
    emit({ sM: 0, speed: 0.4 }); // a fresh fix
    expect(src.parked()).toBe(true);
  });

  it('a stale fix (a cached one, spec §3) is posted but does not count: a fast trace stays unparked', () => {
    const emit = watching();
    expect(drive(emit, trace(3, 20, 20))).toEqual([false, false, false]);
    vi.advanceTimersByTime(1000);
    emit({ sM: 60, speed: 1, tsMs: Date.now() - 60_000 }); // taken a minute ago, while creeping
    expect(fixes).toHaveLength(4); // the worklet gets it all the same (and rejects it, spec §8.2 step 1)
    expect(fixes[3]?.ageS).toBeCloseTo(61, 9);
    expect(src.parked()).toBe(false);
    vi.advanceTimersByTime(2500);
    expect(src.parked()).toBe(false);
  });

  it('after a pause (page hidden), a stale fix newer than the last counted one does not count either', () => {
    const emit = watching();
    expect(drive(emit, trace(3, 20, 20))).toEqual([false, false, false]);
    vi.advanceTimersByTime(30_000); // geolocation pauses while the page is hidden (spec §3)
    emit({ sM: 600, speed: 1, tsMs: Date.now() - 10_000 }); // the first answer: an older cached fix
    expect(fixes).toHaveLength(4);
    expect(src.parked()).toBe(false);
    vi.advanceTimersByTime(1000);
    emit({ sM: 600, speed: 0.4 }); // a fresh fix
    expect(src.parked()).toBe(true);
  });

  it.each([
    [3000, true],
    [3001, false],
  ])('a fix taken %s ms before it arrived counts: %s (raw age, without latencyS)', (rawAgeMs, counts) => {
    src.start({ ...WATCH, latencyS: 2.5 }); // with latencyS the posted ageS is above 3 s either way
    geo.emit(position({ speed: 0.4, tsMs: Date.now() - rawAgeMs }));
    expect(fixes[0]?.ageS).toBeGreaterThan(3);
    expect(src.parked()).toBe(counts);
  });

  it('an earlier fix delivered again later does not refresh the fix age (out of order)', () => {
    const emit = watching();
    const a: FixSpec = { sM: 0, speed: 0.4, tsMs: Date.now() - LAG_MS };
    emit(a);
    vi.advanceTimersByTime(1000);
    emit({ sM: 0, speed: 0.4 });
    const bArrived = performance.now();
    vi.advanceTimersByTime(1000);
    emit(a); // not a repeat of the previous fix, and taken only 2.8 s ago
    expect(fixes).toHaveLength(3);
    expect(src.parked(bArrived + 2999)).toBe(true);
    expect(src.parked(bArrived + 3000)).toBe(false);
  });

  it.each([
    ['an earlier fix again', { sM: 0, speed: 0.4 }, 0],
    ['a late fix taken between the last two', { sM: 2, speed: 0.4 }, 500],
  ])('%s does not set the speed estimate (out of order)', (_label, late, takenAfterFirstMs) => {
    const emit = watching();
    const t0 = Date.now() - LAG_MS;
    emit({ sM: 0, speed: 0.4, tsMs: t0 });
    expect(src.parked()).toBe(true);
    vi.advanceTimersByTime(1000);
    emit({ sM: 10, speed: 20, tsMs: t0 + 1000 }); // pulling away hard
    expect(src.parked()).toBe(false);
    vi.advanceTimersByTime(500);
    emit({ ...late, tsMs: t0 + takenAfterFirstMs });
    expect(fixes).toHaveLength(3);
    expect(src.parked()).toBe(false);
  });

  it.each([
    [0, false],
    [50, false],
    [51, true],
  ])('a fix taken %s ms after the last counted one counts: %s (speed filter MIN_ADVANCE)', (dtMs, counts) => {
    const emit = watching();
    const t0 = Date.now() - LAG_MS;
    emit({ sM: 0, speed: 0.4, tsMs: t0 });
    const firstArrived = performance.now();
    vi.advanceTimersByTime(2000);
    emit({ sM: 1, speed: 0.4, tsMs: t0 + dtMs }); // a new position, so never dropped as a repeat
    expect(fixes).toHaveLength(2);
    expect(src.parked(firstArrived + 3000)).toBe(counts);
  });

  it('recovers within 2 s when the system clock and the GPS timestamps step back an hour together', () => {
    const emit = watching();
    expect(drive(emit, trace(3, 0, 0)).at(-1)).toBe(true);
    vi.advanceTimersByTime(1000);
    vi.setSystemTime(Date.now() - 3_600_000); // e.g. an NTP step; the fake GPS stamps with Date.now()
    expect(drive(emit, trace(3, 0, 0))).toEqual([false, false, true]);
    expect(fixes.at(-1)?.ageS).toBeCloseTo(1.8, 9);
  });

  it('GPS timestamps an hour behind the system clock are stale: posted, but they never unlock', () => {
    const emit = watching();
    expect(drive(emit, trace(3, 0, 0)).at(-1)).toBe(true);
    const back0 = Date.now() - LAG_MS - 3_600_000;
    const seen: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      vi.advanceTimersByTime(1000);
      emit({ sM: 0, speed: 0, tsMs: back0 + 1000 * i });
      seen.push(src.parked());
    }
    expect(fixes).toHaveLength(7);
    expect(seen).toEqual([true, true, false, false]); // the last counted fix ages out after 3 s
  });

  it('a fix stamped in the future (clock skew) does not hold later fixes back', () => {
    const emit = watching();
    emit({ sM: 0, speed: 0.4, tsMs: Date.now() + 3_600_000 });
    const seen: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1000);
      emit({ sM: 0, speed: 0.4 });
      seen.push(src.parked());
    }
    expect(seen).toEqual([true, true, true, true, true, true]);
  });

  it('works end to end in poll mode', async () => {
    geo.answer = { kind: 'fix', latencyMs: 50, fix: () => ({ sM: 0, speed: 0 }) };
    src.start(POLL);
    await vi.advanceTimersByTimeAsync(1100); // fixes at 50 and 1050 ms: 1 s of fixes, speed unknown
    expect(src.parked()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); // fix at 2050 ms
    expect(src.parked()).toBe(true);
  });
});

describe('GpsSource privacy', () => {
  it('keeps coordinates inside: nothing enumerable on the instance, only FixMsg carries them', () => {
    drive(watching(), trace(3, 1, null));
    expect(fixes).toHaveLength(3);
    expect(Object.keys(src)).toEqual([]);
    expect(JSON.stringify(src)).toBe('{}');
    expect(() => assertNoCoordinates(src)).not.toThrow();
  });
});
