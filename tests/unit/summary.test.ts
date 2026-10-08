import { describe, expect, it } from 'vitest';
import type { Features, ViewportInfo } from '../../src/platform/detect';
import type { AudioProbeState } from '../../src/probe/audio';
import type { GpsModeSummary } from '../../src/probe/gps-stats';
import type { InputCounts, MotionReport } from '../../src/probe/inputs';
import { EventLog } from '../../src/probe/log';
import type { StorageReport } from '../../src/probe/storage-probe';
import {
  assertNoCoordinates,
  buildSummary,
  FORBIDDEN_KEYS,
  type ProbeSummary,
} from '../../src/probe/summary';

const viewport: ViewportInfo = {
  dpr: 1.53,
  screen: [1182, 920],
  inner: [773, 601],
  visual: [773, 601],
  maxTouchPoints: 10,
};

const features: Features = {
  audioWorklet: true,
  serviceWorker: true,
  cacheStorage: true,
  mediaSession: true,
  gamepad: true,
  deviceMotion: false,
  geolocation: true,
  crossOriginIsolated: false,
  fullscreen: true,
  esModules: true,
  webgl: true,
  outputTimestamp: true,
  mediaStreamDestination: true,
};

const audioState: AudioProbeState = {
  state: 'running',
  sampleRate: 48000,
  baseLatency: 0.01,
  outputLatency: 0.1,
  latencyHint: 'balanced',
  route: 'direct-anchor',
  perfInWorklet: true,
  quanta: 3750,
  recoveries: { resumeOk: 1, resumeFail: 0, recreate: 0 },
};

const gpsSummary: GpsModeSummary = {
  mode: 'poll-hiacc-off',
  durationS: 60,
  fixes: 58,
  errors: { permission: 0, unavailable: 1, timeout: 1 },
  intervalMedianMs: 1010,
  intervalP95Ms: 1400,
  ageMedianMs: 950,
  ageP95Ms: 2100,
  staleOver3sPct: 1.7,
  duplicatePct: 0,
  speedNullPct: 0,
  speedZeroPct: 3.4,
  speedZeroWhileMovingPct: 0,
  accuracyMedianM: 5,
  altitudePresentPct: 100,
  fixesWhileHidden: 0,
  maxSpeedMps: 27.5,
  crashedPreviously: false,
};

const motion: MotionReport = {
  available: false,
  permission: 'not-required',
  events: 0,
  rateHz: null,
  accelRange: null,
  axes: { acc: null, accG: null, intervalMs: null },
};

const storage: StorageReport = {
  localStorage: true,
  visits: 3,
  firstSeen: '2026-01-01T00:00:00.000Z',
  lastSeen: '2026-01-02T00:00:00.000Z',
  cacheStorage: true,
  cachePersisted: true,
  cacheAgeS: 86400,
  swSupported: true,
  swRegistered: true,
  swControlled: false,
};

const inputs: InputCounts = {
  mediaSession: { nexttrack: 2, previoustrack: 1 },
  keys: ['MediaTrackNext'],
  wheel: 0,
  gamepads: [],
  visibilityChanges: 2,
};

function parts(): Omit<ProbeSummary, 'v' | 'logTail'> {
  return {
    sha: 'abc1234',
    at: '2026-01-02T03:04:05.000Z',
    env: { ua: 'Mozilla/5.0 (X11; Linux x86_64)', viewport, webgl: 'x', mcu: 'intel', features },
    audio: { ...audioState, bench: [{ k: 1, ratio: 1, overloaded: false, busyFrac: 0.1 }], headroomK: 1 },
    routes: {
      'direct-anchor': {
        miniplayer: 'yes',
        survivesMinimise: '?',
        wheelTilt: 'no',
        music: 'paused',
        hiddenClockRatio: null,
      },
    },
    gps: [gpsSummary],
    motion,
    storage,
    inputs,
    notes: { model: 'Model 3 2021' },
  };
}

describe('FORBIDDEN_KEYS', () => {
  it('lists every coordinate-bearing key name', () => {
    expect([...FORBIDDEN_KEYS]).toEqual(['lat', 'lon', 'latitude', 'longitude', 'coords', 'position']);
  });
});

describe('assertNoCoordinates', () => {
  it('accepts primitives, null and clean nested data', () => {
    expect(() => assertNoCoordinates(null)).not.toThrow();
    expect(() => assertNoCoordinates(42)).not.toThrow();
    expect(() => assertNoCoordinates('lat')).not.toThrow(); // values are not keys
    expect(() => assertNoCoordinates({ a: [{ b: { latency: 1, plateau: 2 } }] })).not.toThrow();
  });

  it.each(FORBIDDEN_KEYS.map((k) => [k]))('rejects key "%s" and names its path', (key) => {
    const value = { gps: [{ fixes: 1 }, { nested: { [key]: 0 } }] };
    expect(() => assertNoCoordinates(value)).toThrow(`$.gps[1].nested.${key}`);
  });

  it('matches keys case-insensitively', () => {
    expect(() => assertNoCoordinates({ Latitude: 1 })).toThrow('$.Latitude');
    expect(() => assertNoCoordinates({ COORDS: {} })).toThrow('$.COORDS');
  });

  it('rejects a forbidden key at the root and inside arrays of arrays', () => {
    expect(() => assertNoCoordinates({ lon: 0 })).toThrow('$.lon');
    expect(() => assertNoCoordinates([[{ position: 1 }]])).toThrow('$[0][0].position');
  });

  it('terminates on cyclic structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => assertNoCoordinates(a)).not.toThrow();
  });
});

describe('buildSummary', () => {
  it('adds v: 1 and the formatted log tail', () => {
    const log = new EventLog();
    log.push('audio', 'running', 12_345);
    log.push('mediasession', 'nexttrack', 20_000);
    const summary = buildSummary(parts(), log);
    expect(summary.v).toBe(1);
    expect(summary.sha).toBe('abc1234');
    expect(summary.logTail).toEqual(['t=12.3s audio running', 't=20.0s mediasession nexttrack']);
  });

  it('keeps only the last 40 log entries', () => {
    const log = new EventLog();
    for (let i = 0; i < 45; i++) log.push('note', `n${i}`, i * 100);
    const { logTail } = buildSummary(parts(), log);
    expect(logTail).toHaveLength(40);
    expect(logTail[0]).toBe('t=0.5s note n5');
    expect(logTail[39]).toBe('t=4.4s note n44');
  });

  it('drops GPS fix lines, so audio, visibility and error events survive a GPS run (C8.2)', () => {
    const log = new EventLog();
    log.push('audio', 'interrupted', 1_000);
    log.push('visibility', 'hidden', 2_000);
    log.push('gps', 'run watch-hiacc-on start 60s', 3_000);
    for (let i = 0; i < 60; i++) log.push('gps', `fix age=900ms acc=5m speed=${i}.00`, 4_000 + i * 1000);
    log.push('gps', 'error code=3', 70_000);
    log.push('error', 'direct-anchor element play failed: NotAllowedError', 71_000);
    log.push('gps', 'run watch-hiacc-on end fixes=60 errors=0/0/1', 72_000);
    expect(buildSummary(parts(), log).logTail).toEqual([
      't=1.0s audio interrupted',
      't=2.0s visibility hidden',
      't=3.0s gps run watch-hiacc-on start 60s',
      't=70.0s gps error code=3',
      't=71.0s error direct-anchor element play failed: NotAllowedError',
      't=72.0s gps run watch-hiacc-on end fixes=60 errors=0/0/1',
    ]);
  });

  it('takes the last 40 after dropping fix lines; only gps-kind lines starting "fix " are fix lines', () => {
    const log = new EventLog();
    for (let i = 0; i < 45; i++) {
      log.push('note', `n${i}`, i * 100);
      log.push('gps', 'fix age=1000ms acc=5m speed=null', i * 100 + 50);
    }
    log.push('note', 'fix age=0ms', 4_500); // not a gps entry: kept
    const { logTail } = buildSummary(parts(), log);
    expect(logTail).toHaveLength(40);
    expect(logTail[0]).toBe('t=0.6s note n6');
    expect(logTail[38]).toBe('t=4.4s note n44');
    expect(logTail[39]).toBe('t=4.5s note fix age=0ms');
  });

  it('survives a JSON round trip unchanged and starts with "v"', () => {
    const summary = buildSummary(parts(), new EventLog());
    const json = JSON.stringify(summary);
    expect(json.startsWith('{"v":1,')).toBe(true);
    expect(JSON.parse(json)).toEqual(summary);
  });

  it('drops properties that are not part of ProbeSummary', () => {
    const extra = { ...parts(), debugCoords: 'x' } as Omit<ProbeSummary, 'v' | 'logTail'>;
    expect(Object.keys(buildSummary(extra, new EventLog()))).toEqual([
      'v', 'sha', 'at', 'env', 'audio', 'routes', 'gps', 'motion', 'storage', 'inputs', 'notes', 'logTail',
    ]);
  });

  it('accepts null audio, motion and storage', () => {
    const summary = buildSummary({ ...parts(), audio: null, motion: null, storage: null }, new EventLog());
    expect(summary.audio).toBeNull();
  });

  it('throws when a note smuggles in a coordinate key', () => {
    const p = parts();
    p.notes = { lat: '0.000' };
    expect(() => buildSummary(p, new EventLog())).toThrow('$.notes.lat');
  });

  it('throws when nested data carries coordinates', () => {
    const gps = { ...gpsSummary, coords: { latitude: 0, longitude: 0 } } as GpsModeSummary;
    expect(() => buildSummary({ ...parts(), gps: [gps] }, new EventLog())).toThrow('$.gps[0].coords');
  });
});
