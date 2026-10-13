/** Test-only harness: runs ReplayTrace fixtures through ReplayFeeder → SpeedFilter per audio quantum. */
import { readFileSync } from 'node:fs';
import { DEFAULT_SIM_TUNING, QUANTUM } from '../../src/contracts';
import type { FixMsg, SimTuning } from '../../src/contracts';
import { ReplayFeeder } from '../../src/sim/replay';
import type { ReplayTrace } from '../../src/sim/replay';
import { SpeedFilter } from '../../src/sim/speed-filter';
import { speedAt } from '../../tools/make-synthetic-replay';
import type { Knot } from '../../tools/make-synthetic-replay';

export const DT_S = QUANTUM / 48000;

export const FIXTURE_NAMES = [
  'city-amd',
  'highway-amd',
  'intel-zero-speed',
  'intel-null-speed',
  'tunnel-dropout',
  'stoplight-jitter',
  'stale-duplicates',
  'step-response',
] as const;

export function fixturePath(name: string): URL {
  return new URL(`../fixtures/replay/${name}.json`, import.meta.url);
}

export function loadTrace(name: string): ReplayTrace {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as ReplayTrace;
}

export interface ReplayRun {
  /** nowS of quantum i is i·DT_S. */
  v: Float64Array;
  flags: Int32Array;
  accepted: number;
  rejected: number;
}

/** Steps a fresh SpeedFilter every quantum from 0 to the last fix time + tailS. */
export function runTrace(trace: ReplayTrace, tuning: SimTuning = DEFAULT_SIM_TUNING, tailS = 3): ReplayRun {
  const lastT = trace.fixes[trace.fixes.length - 1]?.t ?? 0;
  const n = Math.ceil((lastT + tailS) / DT_S) + 1;
  const v = new Float64Array(n);
  const flags = new Int32Array(n);
  const feeder = new ReplayFeeder(trace);
  const filter = new SpeedFilter(tuning);
  const fix: FixMsg = { type: 'fix', ageS: 0, speedMps: null, lat: 0, lon: 0, accuracyM: 1, altitudeM: null };
  for (let i = 0; i < n; i++) {
    const nowS = i * DT_S;
    while (feeder.next(nowS, fix)) filter.accept(fix, nowS);
    filter.evaluate(nowS);
    v[i] = filter.v;
    flags[i] = filter.flags;
  }
  return { v, flags, accepted: filter.fixesAccepted, rejected: filter.fixesRejected };
}

/** Index of the first quantum with nowS ≥ t. */
export function idx(t: number): number {
  return Math.ceil(t / DT_S - 1e-9);
}

export function knotsOf(trace: ReplayTrace): Knot[] {
  return (trace.truth ?? []).map((p) => [p.t, p.v] as const);
}

/** True speed at t (piecewise linear, right-continuous at steps). */
export function truthAt(knots: readonly Knot[], t: number): number {
  return speedAt(knots, t);
}

/** True when the truth speed has been exactly constant over [t − windowS, t]. */
export function settled(knots: readonly Knot[], t: number, windowS: number): boolean {
  if (t < windowS) return false;
  for (const [tk] of knots) if (tk > t - windowS && tk <= t) return false;
  return truthAt(knots, t - windowS) === truthAt(knots, t);
}

/** Instantaneous steps in the truth (two knots with equal t and different v). */
export function stepsOf(trace: ReplayTrace): { t: number; from: number; to: number }[] {
  const truth = trace.truth ?? [];
  const steps: { t: number; from: number; to: number }[] = [];
  for (let i = 1; i < truth.length; i++) {
    const a = truth[i - 1];
    const b = truth[i];
    if (a !== undefined && b !== undefined && a.t === b.t && a.v !== b.v) steps.push({ t: a.t, from: a.v, to: b.v });
  }
  return steps;
}

/** Nearest-rank percentile (p in (0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}
