/**
 * Phone GPX log → ReplayTrace JSON with positions stripped (phase-1 contract, T3).
 *
 *   npx tsx tools/gpx-to-replay.ts <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]
 *
 * Parses <trkpt lat lon><time> (and a <speed> / <ns:speed> element if present), computes the
 * cumulative haversine distance, re-samples to the cadence (linear interpolation; raw gaps longer
 * than MAX_INTERP_GAP_S stay gaps), and writes fixes {t, sAlongM, speedMps, accuracyM} with t
 * relative to the first track point. No latitude, longitude or absolute time is written.
 * GPX inputs contain real positions: never commit them (.gitignore has *.gpx).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { haversineM } from '../src/platform/geo';
import type { ReplayFix, ReplayTrace } from '../src/sim/replay';
import { mulberry32, round, serialiseTrace } from './make-synthetic-replay';

export interface GpxPoint {
  /** Epoch seconds (only used for differences; never written). */
  tS: number;
  lat: number;
  lon: number;
  speedMps: number | null;
}

export interface GpxOptions {
  name: string;
  latencyS: number;
  cadenceS: number;
  /** Fraction of output fixes whose speed is replaced by null (deterministic PRNG). */
  nullRate: number;
}

/** GPX has no standard accuracy field; replay fixes get a constant, typical phone value. */
export const GPX_ACCURACY_M = 5;
/** Raw track gaps longer than this are not interpolated across (keeps real dropouts). */
export const MAX_INTERP_GAP_S = 5;
const NULL_RATE_SEED = 0x7e5b0c;

const TRKPT = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const LAT = /\blat\s*=\s*["']([^"']+)["']/;
const LON = /\blon\s*=\s*["']([^"']+)["']/;
const TIME = /<time>\s*([^<]+?)\s*<\/time>/;
const SPEED = /<(?:[\w-]+:)?speed>\s*([^<]+?)\s*<\/(?:[\w-]+:)?speed>/;

/** Extracts timed track points, sorted by time, dropping points without a valid time/position and repeated timestamps. */
export function parseGpx(xml: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const m of xml.matchAll(TRKPT)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const lat = Number(LAT.exec(attrs)?.[1]);
    const lon = Number(LON.exec(attrs)?.[1]);
    const timeText = TIME.exec(body)?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || timeText === undefined) continue;
    const tMs = Date.parse(timeText);
    if (!Number.isFinite(tMs)) continue;
    const speedText = SPEED.exec(body)?.[1];
    const speed = speedText === undefined ? Number.NaN : Number(speedText);
    points.push({ tS: tMs / 1000, lat, lon, speedMps: Number.isFinite(speed) && speed >= 0 ? speed : null });
  }
  points.sort((a, b) => a.tS - b.tS);
  return points.filter((p, i) => i === 0 || p.tS > (points[i - 1]?.tS ?? Number.NEGATIVE_INFINITY));
}

/** Re-samples timed points to the cadence and builds a position-free ReplayTrace. */
export function gpxToReplay(points: readonly GpxPoint[], opts: GpxOptions): ReplayTrace {
  if (points.length < 2) throw new Error('GPX needs at least 2 timed track points');
  if (!(opts.cadenceS > 0)) throw new Error('cadence must be > 0');
  if (!(opts.latencyS >= 0)) throw new Error('latency must be ≥ 0');
  if (!(opts.nullRate >= 0 && opts.nullRate <= 1)) throw new Error('null-rate must be in [0, 1]');

  const dist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) throw new Error('unreachable: point index');
    dist.push((dist[i - 1] ?? 0) + haversineM(a.lat, a.lon, b.lat, b.lon));
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) throw new Error('unreachable: empty points');
  const rand = mulberry32(NULL_RATE_SEED);
  const fixes: ReplayFix[] = [];
  let j = 0;
  for (let k = 0; first.tS + k * opts.cadenceS <= last.tS + 1e-9; k++) {
    const tm = first.tS + k * opts.cadenceS;
    while (j < points.length - 2 && (points[j + 1]?.tS ?? Number.POSITIVE_INFINITY) < tm) j++;
    const p0 = points[j];
    const p1 = points[j + 1];
    if (p0 === undefined || p1 === undefined) break;
    const span = p1.tS - p0.tS;
    const nullDraw = rand(); // drawn for every grid slot so the pattern is independent of gaps
    const onSample = Math.abs(tm - p0.tS) < 1e-6 || Math.abs(tm - p1.tS) < 1e-6;
    if (span > MAX_INTERP_GAP_S && !onSample) continue;
    const f = span > 0 ? Math.min(1, Math.max(0, (tm - p0.tS) / span)) : 0;
    const s = (dist[j] ?? 0) + f * ((dist[j + 1] ?? 0) - (dist[j] ?? 0));
    let speedMps: number | null = null;
    if (p0.speedMps !== null && p1.speedMps !== null) {
      speedMps = round(p0.speedMps + f * (p1.speedMps - p0.speedMps), 2);
    }
    if (nullDraw < opts.nullRate) speedMps = null;
    fixes.push({
      t: round(tm - first.tS + opts.latencyS, 3),
      sAlongM: round(s, 2),
      speedMps,
      accuracyM: GPX_ACCURACY_M,
    });
  }

  return {
    meta: {
      name: opts.name,
      cadenceS: opts.cadenceS,
      latencyS: opts.latencyS,
      source: 'gpx',
      notes: `converted from GPX by tools/gpx-to-replay.ts; positions stripped; accuracy fixed at ${GPX_ACCURACY_M} m; null-rate ${opts.nullRate}`,
    },
    fixes,
  };
}

function parseNumberOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${label} must be a number, got "${value}"`);
  return n;
}

/** CLI entry; returns the process exit code. */
export function main(argv: readonly string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        latency: { type: 'string' },
        cadence: { type: 'string' },
        'null-rate': { type: 'string' },
      },
    });
    const [input, output] = positionals;
    if (input === undefined || output === undefined || positionals.length !== 2) {
      throw new Error('usage: gpx-to-replay <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]');
    }
    // Options are validated before any file is read.
    const latencyS = parseNumberOption(values.latency, 1.0, 'latency');
    const cadenceS = parseNumberOption(values.cadence, 1.0, 'cadence');
    const nullRate = parseNumberOption(values['null-rate'], 0, 'null-rate');
    const trace = gpxToReplay(parseGpx(readFileSync(input, 'utf8')), {
      name: basename(output, '.json'),
      latencyS,
      cadenceS,
      nullRate,
    });
    writeFileSync(output, serialiseTrace(trace));
    console.log(`wrote ${output} (${trace.fixes.length} fixes, no positions)`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
