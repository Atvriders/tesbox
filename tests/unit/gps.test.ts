import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventLog } from '../../src/probe/log';

// In-memory stand-in for src/platform/storage.ts (contract API; keys arrive without the prefix).
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../src/platform/storage', () => ({
  storageAvailable: (): boolean => true,
  getJSON: <T>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
  setJSON: (key: string, value: unknown): boolean => {
    store.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    return true;
  },
  remove: (key: string): void => {
    store.delete(key);
  },
}));

import { CRASH_KEY, GPS_MODES, GpsRunner, modeName, type GpsMode } from '../../src/probe/gps';

const POLL: GpsMode = { method: 'poll', highAccuracy: false };
const WATCH_HI: GpsMode = { method: 'watch', highAccuracy: true };
const M_PER_DEG = (6371008.8 * Math.PI) / 180;
const FAKE_LON = 0.0654321; // fake position near 0,0 — must never appear in the log

function position(n: number, speed: number | null = 10): GeolocationPosition {
  const coords = {
    latitude: (10 * n) / M_PER_DEG,
    longitude: FAKE_LON,
    accuracy: 4.4,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed,
    toJSON: () => ({}),
  };
  return { coords, timestamp: Date.now() - 800, toJSON: () => ({}) };
}

function positionError(code: 1 | 2 | 3): GeolocationPositionError {
  return { code, message: `code ${code}`, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

type Behaviour =
  | { kind: 'fix'; latencyMs: number }
  | { kind: 'error'; code: 1 | 2 | 3; latencyMs: number }
  | { kind: 'timeout' } // answers TIMEOUT after options.timeout, like a browser without a fix
  | { kind: 'hang' }; // never answers (e.g. permission prompt still open)

class FakeGeo implements Geolocation {
  behaviour: Behaviour = { kind: 'fix', latencyMs: 50 };
  /** Per-request behaviours for getCurrentPosition, used first in, first out before `behaviour`. */
  script: Behaviour[] = [];
  requestOptions: PositionOptions[] = [];
  requestStarts: number[] = [];
  watchOptions: PositionOptions[] = [];
  clearedWatchIds: number[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private n = 0;
  private nextWatchId = 41;
  private watches = new Map<number, ReturnType<typeof setInterval>>();

  getCurrentPosition(success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions): void {
    this.requestOptions.push(options ?? {});
    this.requestStarts.push(performance.now());
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const b = this.script.shift() ?? this.behaviour;
    if (b.kind === 'hang') return;
    const delay = b.kind === 'timeout' ? (options?.timeout ?? 0) : b.latencyMs;
    setTimeout(() => {
      this.inFlight--;
      if (b.kind === 'fix') success(position(this.n++));
      else error?.(positionError(b.kind === 'timeout' ? 3 : b.code));
    }, delay);
  }

  watchPosition(success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions): number {
    this.watchOptions.push(options ?? {});
    const id = this.nextWatchId++;
    const b = this.behaviour;
    this.watches.set(
      id,
      setInterval(() => {
        if (b.kind === 'fix') success(position(this.n++));
        else if (b.kind === 'error') error?.(positionError(b.code));
        else if (b.kind === 'timeout') error?.(positionError(3));
      }, 1000),
    );
    return id;
  }

  clearWatch(watchId: number): void {
    clearInterval(this.watches.get(watchId));
    this.watches.delete(watchId);
    this.clearedWatchIds.push(watchId);
  }
}

let geo: FakeGeo;
let log: EventLog;
let runner: GpsRunner;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  store.clear();
  geo = new FakeGeo();
  log = new EventLog();
  runner = new GpsRunner(geo, log);
});

afterEach(() => {
  runner.stop();
  vi.useRealTimers();
});

describe('GPS_MODES / modeName', () => {
  it('lists the 4 probe modes in contract order with stable names', () => {
    expect(GPS_MODES).toEqual([
      { method: 'poll', highAccuracy: false },
      { method: 'poll', highAccuracy: true },
      { method: 'watch', highAccuracy: false },
      { method: 'watch', highAccuracy: true },
    ]);
    expect(GPS_MODES.map(modeName)).toEqual(['poll-hiacc-off', 'poll-hiacc-on', 'watch-hiacc-off', 'watch-hiacc-on']);
  });
});

describe('GpsRunner poll mode', () => {
  it('keeps one request in flight with the contract options and ≥ 1000 ms spacing', async () => {
    const p = runner.run(POLL, 5);
    await vi.advanceTimersByTimeAsync(5000);
    const s = await p;
    expect(geo.requestOptions[0]).toEqual({ enableHighAccuracy: false, timeout: 2000, maximumAge: 0 });
    expect(geo.maxInFlight).toBe(1);
    expect(geo.requestStarts).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(s.fixes).toBe(5);
    expect(s.durationS).toBe(5);
    expect(s.intervalMedianMs).toBe(1000);
    expect(s.ageMedianMs).toBe(800);
    expect(s.mode).toBe('poll-hiacc-off');
  });

  it('issues the next request as soon as a slow request settles', async () => {
    geo.behaviour = { kind: 'fix', latencyMs: 1500 };
    const p = runner.run(POLL, 5);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(geo.requestStarts).toEqual([0, 1500, 3000, 4500]);
    expect(geo.maxInFlight).toBe(1);
  });

  it('records hidden fixes', async () => {
    let hidden = false;
    const p = runner.run(POLL, 4, () => hidden);
    await vi.advanceTimersByTimeAsync(2000);
    hidden = true;
    await vi.advanceTimersByTimeAsync(2000);
    const s = await p;
    expect(s.fixes).toBe(4);
    expect(s.fixesWhileHidden).toBe(2);
    expect(s.speedNullPct).toBe(0);
    expect(s.maxSpeedMps).toBe(10);
  });
});

// T10 passes no isHidden, so fixesWhileHidden (spec §16 Q5) rests on this default.
describe('GpsRunner default isHidden', () => {
  it('counts no hidden fixes when there is no document', async () => {
    expect(typeof document).toBe('undefined'); // Vitest's node environment has no DOM
    const p = runner.run(POLL, 2);
    await vi.advanceTimersByTimeAsync(2000);
    const s = await p;
    expect(s.fixes).toBe(2);
    expect(s.fixesWhileHidden).toBe(0);
  });

  it("checks document.visibilityState === 'hidden' at every fix", async () => {
    const doc: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' };
    vi.stubGlobal('document', doc);
    try {
      const p = runner.run(POLL, 4);
      await vi.advanceTimersByTimeAsync(2000); // fixes at 50 and 1050 ms: visible
      doc.visibilityState = 'hidden';
      await vi.advanceTimersByTimeAsync(2000); // fixes at 2050 and 3050 ms: hidden
      const s = await p;
      expect(s.fixes).toBe(4);
      expect(s.fixesWhileHidden).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('GpsRunner normalisation', () => {
  it('turns NaN speed and NaN altitude into null before the stats and the log', async () => {
    const nanGeo: Geolocation = {
      getCurrentPosition: (ok) => {
        const p = position(0, Number.NaN);
        setTimeout(() => ok({ ...p, coords: { ...p.coords, altitude: Number.NaN } }), 10);
      },
      watchPosition: () => 0,
      clearWatch: () => undefined,
    };
    const r = new GpsRunner(nanGeo, log);
    const pending = r.run(POLL, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const s = await pending;
    expect(s.fixes).toBe(1);
    expect(s.speedNullPct).toBe(100);
    expect(s.altitudePresentPct).toBe(0);
    expect(log.entries().some((e) => e.detail.endsWith('speed=null'))).toBe(true);
  });
});

describe('GpsRunner errors (RF1)', () => {
  it('permission denied on every request: resolves at durationS with errors counted', async () => {
    geo.behaviour = { kind: 'error', code: 1, latencyMs: 10 };
    let done = false;
    const p = runner.run(POLL, 5).then((s) => {
      done = true;
      return s;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    expect(runner.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const s = await p;
    expect(done).toBe(true);
    expect(runner.running).toBe(false);
    expect(s.durationS).toBe(5);
    expect(s.fixes).toBe(0);
    expect(s.errors).toEqual({ permission: 5, unavailable: 0, timeout: 0 });
    expect(log.entries().filter((e) => e.detail === 'error code=1')).toHaveLength(5);
  });

  it('timeouts: one request in flight, each times out after 2 s, run still ends at durationS', async () => {
    geo.behaviour = { kind: 'timeout' };
    const p = runner.run(POLL, 5);
    await vi.advanceTimersByTimeAsync(5000);
    const s = await p;
    expect(geo.maxInFlight).toBe(1);
    expect(geo.requestStarts).toEqual([0, 2000, 4000]);
    expect(s.errors.timeout).toBe(2); // the request started at 4000 would time out at 6000, after the run
    expect(s.durationS).toBe(5);
  });

  it('a request that never settles does not block the end of the run', async () => {
    geo.behaviour = { kind: 'hang' };
    const p = runner.run(POLL, 3);
    await vi.advanceTimersByTimeAsync(3000);
    const s = await p;
    expect(geo.requestStarts).toEqual([0]);
    expect(s.fixes).toBe(0);
    expect(s.durationS).toBe(3);
  });

  it('stop() mid-run resolves promptly with the elapsed duration and leaves no timers', async () => {
    const p = runner.run(POLL, 60);
    await vi.advanceTimersByTimeAsync(2500);
    runner.stop();
    const s = await p; // no timer advance needed
    expect(runner.running).toBe(false);
    expect(s.durationS).toBe(2.5);
    expect(s.fixes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.has(CRASH_KEY)).toBe(false);
  });

  it('rounds the elapsed durationS to the nearest 0.1 s', async () => {
    const a = runner.run(POLL, 60);
    await vi.advanceTimersByTimeAsync(2468);
    runner.stop();
    expect((await a).durationS).toBe(2.5);
    const b = runner.run(POLL, 60);
    await vi.advanceTimersByTimeAsync(2430);
    runner.stop();
    expect((await b).durationS).toBe(2.4);
  });

  it('ignores an error that arrives after stop()', async () => {
    geo.behaviour = { kind: 'timeout' }; // the request started at 0 answers TIMEOUT at 2000, after the stop
    const p = runner.run(POLL, 60);
    await vi.advanceTimersByTimeAsync(500);
    runner.stop();
    const s = await p;
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.errors).toEqual({ permission: 0, unavailable: 0, timeout: 0 });
    expect(geo.requestStarts).toEqual([0]);
    expect(log.entries().filter((e) => e.detail.startsWith('error '))).toHaveLength(0);
    expect(log.entries().at(-1)?.detail).toBe('run poll-hiacc-off end fixes=0 errors=0/0/0');
  });

  it('ignores an answer that arrives after stop()', async () => {
    geo.behaviour = { kind: 'fix', latencyMs: 400 };
    const p = runner.run(POLL, 60);
    await vi.advanceTimersByTimeAsync(1100); // request #2 started at 1000, answers at 1400
    runner.stop();
    const s = await p;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.fixes).toBe(1);
    expect(geo.requestStarts).toEqual([0, 1000]);
    expect(log.entries().filter((e) => e.detail.startsWith('fix '))).toHaveLength(1);
  });

  it('caps durationS at the requested duration when the end timer fires late', async () => {
    const late = new GpsRunner(geo, log, () => performance.now() * 1.2); // clock reads 6 s when the 5 s timer fires
    const p = late.run(POLL, 5);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).durationS).toBe(5);
  });

  it('rejects a second run while one is active, then allows a new run', async () => {
    const p = runner.run(POLL, 2);
    // The message names the ACTIVE run's mode, not the requested one.
    await expect(runner.run(WATCH_HI, 2)).rejects.toThrow(/^GPS run already in progress \(poll-hiacc-off\)$/);
    // The rejected run leaves the active run's crash marker alone (RF2 must blame the right mode).
    expect((store.get(CRASH_KEY) as { mode: string }).mode).toBe('poll-hiacc-off');
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    const p2 = runner.run(POLL, 1);
    await vi.advanceTimersByTimeAsync(1000);
    const s2 = await p2;
    expect(s2.fixes).toBe(1);
    expect(s2.crashedPreviously).toBe(false);
  });
});

describe('GpsRunner watch mode', () => {
  it('uses watchPosition with the contract options and clears the watch at the end', async () => {
    const p = runner.run(WATCH_HI, 5);
    await vi.advanceTimersByTimeAsync(5000);
    const s = await p;
    expect(geo.watchOptions).toEqual([{ enableHighAccuracy: true, timeout: 2000, maximumAge: 0 }]);
    expect(geo.requestStarts).toEqual([]);
    expect(s.fixes).toBe(4); // fake emits at 1..4 s; the 5 s emission is cancelled by the end of the run
    expect(s.mode).toBe('watch-hiacc-on');
    expect(geo.clearedWatchIds).toEqual([41]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts watch errors and clears the watch on stop()', async () => {
    geo.behaviour = { kind: 'error', code: 2, latencyMs: 0 };
    const p = runner.run(WATCH_HI, 30);
    await vi.advanceTimersByTimeAsync(3000);
    runner.stop();
    const s = await p;
    expect(s.errors).toEqual({ permission: 0, unavailable: 3, timeout: 0 });
    expect(geo.clearedWatchIds).toEqual([41]);
  });
});

// The matrix separates watchPosition crashes from enableHighAccuracy crashes (spec §3, §16 Q6),
// so each mode must reach only its own API, with its own enableHighAccuracy.
describe('GpsRunner mode matrix', () => {
  it.each(GPS_MODES.map((m): [string, GpsMode] => [modeName(m), m]))(
    '%s calls only its own API with its own enableHighAccuracy',
    async (name, mode) => {
      const p = runner.run(mode, 1);
      await vi.advanceTimersByTimeAsync(1000);
      const s = await p;
      const options = { enableHighAccuracy: mode.highAccuracy, timeout: 2000, maximumAge: 0 };
      const [used, unused] =
        mode.method === 'poll' ? [geo.requestOptions, geo.watchOptions] : [geo.watchOptions, geo.requestOptions];
      expect(used).toEqual([options]);
      expect(unused).toEqual([]);
      expect(s.mode).toBe(name);
    },
  );
});

describe('GpsRunner crash marker (RF2)', () => {
  it('writes {mode, startedAt} while running and clears it when the run ends', async () => {
    const p = runner.run(WATCH_HI, 2);
    const marker = store.get(CRASH_KEY) as { mode: string; startedAt: string };
    expect(marker.mode).toBe('watch-hiacc-on');
    expect(new Date(marker.startedAt).toISOString()).toBe(marker.startedAt);
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(store.has(CRASH_KEY)).toBe(false);
  });

  it('previousCrash() returns a leftover marker once, clears it, and flags the next run of that mode once', async () => {
    store.set(CRASH_KEY, { mode: 'poll-hiacc-off', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(GpsRunner.previousCrash()).toEqual({ mode: 'poll-hiacc-off', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(store.has(CRASH_KEY)).toBe(false);
    expect(GpsRunner.previousCrash()).toBeNull();

    const other = runner.run(WATCH_HI, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await other).crashedPreviously).toBe(false);

    const first = runner.run(POLL, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).crashedPreviously).toBe(true);

    const second = runner.run(POLL, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await second).crashedPreviously).toBe(false);
  });

  it('run() consumes a marker the page never read', async () => {
    store.set(CRASH_KEY, { mode: 'watch-hiacc-on', startedAt: '2026-01-01T00:00:00.000Z' });
    const p = runner.run(WATCH_HI, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).crashedPreviously).toBe(true);
    expect(GpsRunner.previousCrash()).toBeNull();
  });

  it('discards a corrupt marker', () => {
    store.set(CRASH_KEY, { mode: 7 });
    expect(GpsRunner.previousCrash()).toBeNull();
    expect(store.has(CRASH_KEY)).toBe(false);
  });
});

describe('GpsRunner log lines', () => {
  it('logs start, fix, error and end lines in the contract formats, all of kind gps', async () => {
    const ok: Behaviour = { kind: 'fix', latencyMs: 10 };
    const err = (code: 1 | 2 | 3): Behaviour => ({ kind: 'error', code, latencyMs: 10 });
    // One request per second. The counts differ (4 fixes, errors 1/2/3), so any field mix-up shows.
    geo.script = [ok, err(1), ok, err(2), ok, err(2), ok, err(3), err(3), err(3)];
    const p = runner.run(POLL, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    const s = await p;
    expect(s.fixes).toBe(4);
    expect(s.errors).toEqual({ permission: 1, unavailable: 2, timeout: 3 });
    const entries = log.entries();
    expect(entries.every((e) => e.kind === 'gps')).toBe(true);
    const fixLine = 'fix age=800ms acc=4m speed=10.00';
    expect(entries.map((e) => e.detail)).toEqual([
      'run poll-hiacc-off start 10s',
      fixLine,
      'error code=1',
      fixLine,
      'error code=2',
      fixLine,
      'error code=2',
      fixLine,
      'error code=3',
      'error code=3',
      'error code=3',
      'run poll-hiacc-off end fixes=4 errors=1/2/3',
    ]);
  });
});

describe('GpsRunner privacy', () => {
  it('logs fixes as "fix age=…ms acc=…m speed=…" without coordinates', async () => {
    const p = runner.run(POLL, 3);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    const fixes = log.entries().filter((e) => e.kind === 'gps' && e.detail.startsWith('fix '));
    expect(fixes).toHaveLength(3);
    for (const e of fixes) expect(e.detail).toMatch(/^fix age=-?\d+ms acc=\d+m speed=(null|-?\d+\.\d{2})$/);
    const all = log.entries().map((e) => e.detail).join('\n');
    expect(all).not.toContain('0.0654321');
    expect(all).not.toContain(String(FAKE_LON));
  });
});
