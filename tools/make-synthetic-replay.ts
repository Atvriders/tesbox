/**
 * Deterministic synthetic GPS replay traces with ground truth (phase-1 contract, T3).
 *
 *   npx tsx tools/make-synthetic-replay.ts            # writes tests/fixtures/replay/*.json
 *
 * Model: fixes are measured every CADENCE_S on a fixed grid and delivered LATENCY_S later.
 * Accuracy wanders slowly in [4, 8] m. Position noise is a first-order Gauss–Markov process with
 * stationary σ = accuracy/2 and correlation time POS_NOISE_TAU_S (GNSS position error is
 * time-correlated; white 1 Hz noise is not what receivers output) — contract A9. The
 * stoplight-jitter trace adds a white component σ = 1 m on top (A9; it exercises the A3 standstill
 * deadband). Speed noise is white, σ = 0.15 m/s, clamped ≥ 0. Positions are 1-D distances along a
 * fake straight line; no coordinates exist anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReplayFix, ReplayTrace } from '../src/sim/replay';

export const CADENCE_S = 1.0;
export const LATENCY_S = 1.0;
export const SPEED_NOISE_SD = 0.15;
export const POS_NOISE_TAU_S = 60;
export const FIXTURE_DIR = 'tests/fixtures/replay';

/** Ground-truth speed as a piecewise-linear function: knots [t, v]; equal t = instantaneous step. */
export type Knot = readonly [t: number, v: number];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller (one value per call; deterministic for a given rand). */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const w = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

/** Builds knots from a start speed and segments [durationS, endSpeed] (linear ramps; 0 duration = step). */
export function knotsFrom(v0: number, segments: readonly (readonly [number, number])[]): Knot[] {
  const knots: Knot[] = [[0, v0]];
  let t = 0;
  for (const [dur, vEnd] of segments) {
    t += dur;
    knots.push([t, vEnd]);
  }
  return knots;
}

/** Truth speed at t (right-continuous at steps); constant beyond the last knot. */
export function speedAt(knots: readonly Knot[], t: number): number {
  let v = knots[0]?.[1] ?? 0;
  for (let i = 1; i < knots.length; i++) {
    const k0 = knots[i - 1];
    const k1 = knots[i];
    if (k0 === undefined || k1 === undefined) break;
    if (t < k1[0]) {
      const span = k1[0] - k0[0];
      return span > 0 ? k0[1] + ((k1[1] - k0[1]) * (t - k0[0])) / span : k0[1];
    }
    v = k1[1];
  }
  return v;
}

/** Exact distance travelled from 0 to t (integral of the piecewise-linear speed). */
export function distanceAt(knots: readonly Knot[], t: number): number {
  let s = 0;
  for (let i = 1; i < knots.length; i++) {
    const k0 = knots[i - 1];
    const k1 = knots[i];
    if (k0 === undefined || k1 === undefined) break;
    if (t <= k0[0]) return s;
    const tEnd = Math.min(t, k1[0]);
    const span = k1[0] - k0[0];
    if (span > 0) {
      const vEnd = k0[1] + ((k1[1] - k0[1]) * (tEnd - k0[0])) / span;
      s += ((k0[1] + vEnd) / 2) * (tEnd - k0[0]);
    }
    if (t <= k1[0]) return s;
  }
  const last = knots[knots.length - 1];
  if (last !== undefined && t > last[0]) s += last[1] * (t - last[0]);
  return s;
}

/** Rounds to `dp` decimals without producing "-0" (shared with tools/gpx-to-replay.ts). */
export function round(x: number, dp: number): number {
  const m = 10 ** dp;
  const r = Math.round(x * m) / m;
  return r === 0 ? 0 : r; // no "-0" in JSON
}

export type SpeedMode = 'present' | 'zero' | 'null';

export interface TraceSpec {
  name: string;
  notes: string;
  seed: number;
  knots: Knot[];
  durationS: number;
  speed: SpeedMode;
  /** Measurement-time windows [from, to) with no fixes (tunnels). */
  gaps?: readonly (readonly [number, number])[];
  /** Additional WHITE position-noise σ (m) on top of the Gauss–Markov component (contract A9: stoplight). */
  posWhiteSigmaM?: number;
  /** Hard clamp on |position noise| (m). */
  posClampM?: number;
  /** Speed reading generator overriding truth + noise (stoplight). */
  speedReading?: (rand: () => number) => number;
}

/** Generates one trace on the standard grid (measured k·CADENCE_S, delivered + LATENCY_S). */
export function makeTrace(spec: TraceSpec): ReplayTrace {
  const rand = mulberry32(spec.seed);
  const rho = Math.exp(-CADENCE_S / POS_NOISE_TAU_S);
  const drive = Math.sqrt(1 - rho * rho);
  const accPhase = rand() * 2 * Math.PI;
  let u = gaussian(rand);
  const fixes: ReplayFix[] = [];
  for (let k = 0; k * CADENCE_S <= spec.durationS; k++) {
    const tm = k * CADENCE_S;
    u = rho * u + drive * gaussian(rand);
    const accuracyM = round(6 + 2 * Math.sin((2 * Math.PI * k) / 97 + accPhase), 1);
    const speedNoise = gaussian(rand);
    // Drawn on every grid slot (also inside gaps) when the spec has a white component, so the
    // pattern is deterministic and traces without one keep their random sequence.
    const white = spec.posWhiteSigmaM !== undefined ? spec.posWhiteSigmaM * gaussian(rand) : 0;
    const inGap = (spec.gaps ?? []).some(([a, b]) => tm >= a && tm < b);
    if (inGap) continue;
    let noise = u * (accuracyM / 2) + white;
    if (spec.posClampM !== undefined) noise = Math.max(-spec.posClampM, Math.min(spec.posClampM, noise));
    const vTrue = speedAt(spec.knots, tm);
    let speedMps: number | null;
    if (spec.speed === 'null') speedMps = null;
    else if (spec.speed === 'zero') speedMps = 0;
    else if (spec.speedReading !== undefined) speedMps = round(spec.speedReading(rand), 2);
    else speedMps = round(Math.max(0, vTrue + SPEED_NOISE_SD * speedNoise), 2);
    fixes.push({
      t: round(tm + LATENCY_S, 3),
      sAlongM: round(distanceAt(spec.knots, tm) + noise, 2),
      speedMps,
      accuracyM,
    });
  }
  // Truth covers the whole replay window: up to the last delivery (durationS + LATENCY_S).
  const truthEnd = spec.durationS + LATENCY_S;
  const truth: { t: number; v: number }[] = spec.knots
    .filter(([t]) => t <= truthEnd)
    .map(([t, v]) => ({ t: round(t, 3), v: round(v, 3) }));
  const lastT = truth[truth.length - 1]?.t ?? 0;
  if (lastT < truthEnd) truth.push({ t: round(truthEnd, 3), v: round(speedAt(spec.knots, truthEnd), 3) });
  return {
    meta: { name: spec.name, cadenceS: CADENCE_S, latencyS: LATENCY_S, source: 'synthetic', notes: spec.notes },
    fixes,
    truth,
  };
}

/** Repeated/cached and stale deliveries layered onto a clean trace (Tesla repeats cached fixes). */
export function withStaleDuplicates(base: ReplayTrace): ReplayTrace {
  const out: ReplayFix[] = [];
  base.fixes.forEach((f, i) => {
    if (i >= 20 && i < 30) {
      // GPS freeze: the fix measured at i = 20 is re-delivered every second, ageing 1 → 10 s.
      const frozen = base.fixes[20];
      if (frozen === undefined) return;
      out.push({ ...frozen, t: f.t, ageS: round(LATENCY_S + (i - 20) * CADENCE_S, 3) });
      return;
    }
    out.push({ ...f, ageS: LATENCY_S });
    if (i === base.fixes.length - 1) return; // nothing after the last regular delivery
    if (i % 7 === 3) {
      // Cached repeat 0.5 s later: same measurement, older by 0.5 s → same tFix.
      out.push({ ...f, t: round(f.t + 0.5, 3), ageS: round(LATENCY_S + 0.5, 3) });
    }
    if (i % 11 === 5) {
      // Out-of-order straggler: measured 0.6 s before this fix, delivered 0.3 s after it.
      out.push({ ...f, t: round(f.t + 0.3, 3), ageS: round(LATENCY_S + 0.3 + 0.6, 3) });
    }
  });
  out.sort((x, y) => x.t - y.t);
  return { ...base, fixes: out };
}

/**
 * Criterion (a) truth: 0 for 15 s, then the cycle 20 → 20 → 10 m/s (each level held ≈15 s), i.e.
 * 0→20→20→10→20→20→10… Step instants walk through the fix phase in 0.1 s increments. The speed
 * never returns to 0, so the zero-speed rule is not exercised here (see stoplight/intel traces).
 */
export function stepResponseKnots(steps: number): { knots: Knot[]; durationS: number } {
  const cycle = [20, 20, 10];
  const knots: Knot[] = [[0, 0]];
  let prev = 0;
  let made = 0;
  let slot = 1;
  while (made < steps) {
    const level = cycle[(slot - 1) % cycle.length] ?? 0;
    if (level !== prev) {
      const tStep = 15 * slot + 0.05 + 0.1 * (made % 10);
      knots.push([tStep, prev], [tStep, level]);
      prev = level;
      made++;
    }
    slot++;
  }
  return { knots, durationS: 15 * slot + 1 };
}

const CITY: Knot[] = knotsFrom(0, [
  [5, 0], [6, 13.9], [12, 13.9], [12, 0], [8, 0],
  [5, 11], [10, 11], [3, 5], [6, 5], [4, 14], [8, 14], [12, 0], [10, 0],
]);
const HIGHWAY: Knot[] = knotsFrom(0, [[3, 0], [6, 20], [8, 36.11], [30, 36.11], [10, 30], [20, 30]]);
const INTEL: Knot[] = knotsFrom(0, [[5, 0], [8, 20], [20, 20], [7, 0], [8, 0], [6, 15], [15, 15]]);
const TUNNEL: Knot[] = knotsFrom(0, [[2, 0], [10, 25], [70, 25]]);
const STOPLIGHT: Knot[] = [[0, 0]];

export function buildAllTraces(): ReplayTrace[] {
  const step = stepResponseKnots(20);
  return [
    makeTrace({ name: 'city-amd', notes: 'stop-go city driving, coords.speed present (AMD)', seed: 101, knots: CITY, durationS: 100, speed: 'present' }),
    makeTrace({ name: 'highway-amd', notes: '0→130 km/h, cruise, lift-off to 108 km/h, speed present', seed: 102, knots: HIGHWAY, durationS: 77, speed: 'present' }),
    makeTrace({ name: 'intel-zero-speed', notes: 'Intel MCU2: coords.speed always 0 while moving', seed: 103, knots: INTEL, durationS: 69, speed: 'zero' }),
    makeTrace({ name: 'intel-null-speed', notes: 'coords.speed always null (position-only path)', seed: 104, knots: INTEL, durationS: 69, speed: 'null' }),
    makeTrace({ name: 'tunnel-dropout', notes: '25 m/s cruise with a 35 s fix-arrival gap (tunnel)', seed: 105, knots: TUNNEL, durationS: 82, speed: 'present', gaps: [[20, 54]] }),
    makeTrace({
      name: 'stoplight-jitter', notes: 'stationary; Gauss–Markov wander plus white σ = 1 m (A9), clamped to ±4 m; speed 0–0.4 m/s', seed: 106, knots: STOPLIGHT,
      durationS: 90, speed: 'present', posWhiteSigmaM: 1, posClampM: 4,
      speedReading: (rand) => Math.min(0.4, Math.max(0, 0.2 * gaussian(rand))),
    }),
    withStaleDuplicates(makeTrace({ name: 'stale-duplicates', notes: 'cached repeats, a 10 s freeze (ages 1–10 s) and out-of-order stragglers', seed: 107, knots: CITY, durationS: 60, speed: 'present' })),
    makeTrace({ name: 'step-response', notes: 'speed steps 0→20→20→10 m/s held 15 s, step phase sweeps the fix grid (criterion a)', seed: 108, knots: step.knots, durationS: step.durationS, speed: 'present' }),
  ];
}

/** Stable JSON: one fix / truth point per line (reviewable diffs). */
export function serialiseTrace(trace: ReplayTrace): string {
  const lines: string[] = ['{', `"meta": ${JSON.stringify(trace.meta)},`, '"fixes": ['];
  trace.fixes.forEach((f, i) => lines.push(JSON.stringify(f) + (i < trace.fixes.length - 1 ? ',' : '')));
  const truth = trace.truth;
  if (truth === undefined) {
    lines.push(']');
  } else {
    lines.push('],', '"truth": [');
    truth.forEach((p, i) => lines.push(JSON.stringify(p) + (i < truth.length - 1 ? ',' : '')));
    lines.push(']');
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function main(rootDir: string): void {
  const dir = join(rootDir, FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  for (const trace of buildAllTraces()) {
    writeFileSync(join(dir, `${trace.meta.name}.json`), serialiseTrace(trace));
    console.log(`wrote ${FIXTURE_DIR}/${trace.meta.name}.json (${trace.fixes.length} fixes)`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
