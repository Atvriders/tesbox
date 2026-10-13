import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayTrace } from '../../src/sim/replay';
import { GPX_ACCURACY_M, gpxToReplay, main, MAX_INTERP_GAP_S, parseGpx } from '../../tools/gpx-to-replay';
import type { GpxPoint } from '../../tools/gpx-to-replay';

/** Degrees of longitude per metre on the equator for haversineM's R (fake positions only). */
const DEG_PER_M = 180 / (6371008.8 * Math.PI);
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Fake track: lat 0, moving east at `speed` m/s, one point per second; optional speed element. */
function gpx(seconds: number, speed: number, speedTag: 'none' | 'plain' | 'garmin' = 'plain', skip: number[] = []): string {
  const pts: string[] = [];
  for (let i = 0; i < seconds; i++) {
    if (skip.includes(i)) continue;
    const time = new Date(T0 + i * 1000).toISOString();
    const lon = (speed * i * DEG_PER_M).toFixed(9);
    const sp =
      speedTag === 'plain'
        ? `<speed>${speed}</speed>`
        : speedTag === 'garmin'
          ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${speed}</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions>`
          : '';
    pts.push(i % 2 === 0 ? `<trkpt lat="0" lon="${lon}"><time>${time}</time>${sp}</trkpt>` : `<trkpt lon='${lon}' lat='0'>\n  <ele>12</ele>\n  <time>${time}</time>${sp}\n</trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts.join('\n')}</trkseg></trk></gpx>`;
}

describe('parseGpx', () => {
  it('reads lat/lon in either order and quote style, time, and plain or namespaced speed', () => {
    const plain = parseGpx(gpx(3, 10, 'plain'));
    expect(plain).toHaveLength(3);
    expect(plain[0]).toEqual({ tS: T0 / 1000, lat: 0, lon: 0, speedMps: 10 });
    expect(plain[1]?.lon).toBeCloseTo(10 * DEG_PER_M, 9);
    expect(parseGpx(gpx(3, 7, 'garmin')).map((p) => p.speedMps)).toEqual([7, 7, 7]);
    expect(parseGpx(gpx(3, 7, 'none')).map((p) => p.speedMps)).toEqual([null, null, null]);
  });

  it('skips points without time or with bad numbers, sorts by time and drops repeated timestamps', () => {
    const t = (s: number) => new Date(T0 + s * 1000).toISOString();
    const xml = [
      `<trkpt lat="0" lon="0.0002"><time>${t(2)}</time></trkpt>`,
      `<trkpt lat="0" lon="0"><time>${t(0)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0001"><time>${t(1)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.00011"><time>${t(1)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0003"></trkpt>`,
      `<trkpt lat="x" lon="0.0004"><time>${t(4)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0005"><time>not a date</time></trkpt>`,
      `<trkpt lat="0" lon="0.0006"><time>${t(6)}</time><speed>-1</speed></trkpt>`,
    ].join('');
    const pts = parseGpx(xml);
    expect(pts.map((p) => p.tS - T0 / 1000)).toEqual([0, 1, 2, 6]);
    expect(pts[3]?.speedMps).toBeNull();
  });
});

describe('gpxToReplay', () => {
  const opts = { name: 'drive', latencyS: 1, cadenceS: 1, nullRate: 0 };

  it('re-samples cumulative distance to the cadence with t relative to the first point + latency', () => {
    const trace = gpxToReplay(parseGpx(gpx(11, 10)), { ...opts, cadenceS: 0.5, latencyS: 0.8 });
    expect(trace.meta).toMatchObject({ name: 'drive', cadenceS: 0.5, latencyS: 0.8, source: 'gpx' });
    expect(trace.truth).toBeUndefined();
    expect(trace.fixes).toHaveLength(21);
    trace.fixes.forEach((f, k) => {
      expect(f.t).toBeCloseTo(0.8 + 0.5 * k, 9);
      expect(f.sAlongM).toBeCloseTo(5 * k, 1);
      expect(f.speedMps).toBe(10);
      expect(f.accuracyM).toBe(GPX_ACCURACY_M);
      expect(f.ageS).toBeUndefined();
    });
  });

  it('keeps raw gaps longer than MAX_INTERP_GAP_S as gaps', () => {
    const missing = [3, 4, 5, 6, 7, 8]; // 2 → 9 is a 7 s gap
    expect(9 - 2).toBeGreaterThan(MAX_INTERP_GAP_S);
    const trace = gpxToReplay(parseGpx(gpx(15, 10, 'plain', missing)), opts);
    const ts = trace.fixes.map((f) => f.t - 1);
    expect(ts).toEqual([0, 1, 2, 9, 10, 11, 12, 13, 14]);
    expect(trace.fixes[3]?.sAlongM).toBeCloseTo(90, 1);
  });

  it('nulls speeds at the requested rate, deterministically', () => {
    const pts = parseGpx(gpx(201, 10));
    expect(gpxToReplay(pts, { ...opts, nullRate: 1 }).fixes.every((f) => f.speedMps === null)).toBe(true);
    const half = gpxToReplay(pts, { ...opts, nullRate: 0.5 });
    const nulls = half.fixes.filter((f) => f.speedMps === null).length;
    expect(nulls).toBeGreaterThan(70);
    expect(nulls).toBeLessThan(130);
    expect(gpxToReplay(pts, { ...opts, nullRate: 0.5 })).toEqual(half);
  });

  it('rejects unusable input and options', () => {
    const one: GpxPoint[] = [{ tS: 0, lat: 0, lon: 0, speedMps: null }];
    expect(() => gpxToReplay(one, opts)).toThrow(/at least 2/);
    const two = parseGpx(gpx(2, 1));
    expect(() => gpxToReplay(two, { ...opts, cadenceS: 0 })).toThrow(/cadence/);
    expect(() => gpxToReplay(two, { ...opts, latencyS: -1 })).toThrow(/latency/);
    expect(() => gpxToReplay(two, { ...opts, nullRate: 1.5 })).toThrow(/null-rate/);
  });
});

describe('gpx-to-replay CLI', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
    vi.restoreAllMocks();
  });

  it('writes a position-free ReplayTrace JSON and returns 0', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'tesbox-gpx-'));
    const input = join(dir, 'in.gpx');
    const output = join(dir, 'my-drive.json');
    writeFileSync(input, gpx(6, 12));
    expect(main([input, output, '--latency', '1.2', '--cadence', '1', '--null-rate', '0'])).toBe(0);
    const text = readFileSync(output, 'utf8');
    expect(text).not.toMatch(/"(lat|lon|time)"/);
    expect(text).not.toContain('2026-');
    const trace = JSON.parse(text) as ReplayTrace;
    expect(trace.meta.name).toBe('my-drive');
    expect(trace.meta.latencyS).toBe(1.2);
    expect(trace.fixes).toHaveLength(6);
    expect(trace.fixes[5]?.sAlongM).toBeCloseTo(60, 1);
  });

  it('returns 1 with a message on bad arguments', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main(['only-one-arg.gpx'])).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/^usage: gpx-to-replay/));
    // A real, readable input: the failure must come from the --cadence validation, not from the file.
    dir = mkdtempSync(join(tmpdir(), 'tesbox-gpx-'));
    const input = join(dir, 'in.gpx');
    writeFileSync(input, gpx(3, 5));
    expect(main([input, join(dir, 'o.json'), '--cadence', 'fast'])).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/--cadence must be a number/));
    expect(err).toHaveBeenCalledTimes(2);
  });
});
