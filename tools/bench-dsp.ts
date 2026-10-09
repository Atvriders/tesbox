/**
 * DSP realtime-factor benchmark (spec §14 "Performance"; phase 2a contract T10 + amendment B6).
 *
 *   tsx tools/bench-dsp.ts        (npm run bench:dsp)
 *
 * Full and Lite tiers on two fixtures. Each row renders a 2 s warm-up, then times 3 consecutive 20 s
 * windows on the same core (program seconds 2–62, so every render segment plays back-to-back) and
 * reports the best (fastest) and the median window. Prints a markdown table (also appended to
 * $GITHUB_STEP_SUMMARY when set). Report-only, except exit 1 when a Full row's best window renders
 * slower than FULL_FLOOR (5×) realtime — a generous CI floor that only catches gross regressions
 * (amendment B6, revised 2026-10-08: CI runners on Node 22 measure ≈ 10–11×, so a 10× gate flaked).
 * FULL_TARGET (10×) is the development target and is reported, never gated. The in-car budget comes
 * from the Phase 0 probe's headroom benchmark, not from here. Interference from other processes only ever slows a window
 * down, so the best window is the estimate of what the machine can do. If even the best window is
 * below the floor, treat it as a DSP speed problem (amendment B2 revised: boxing-free block methods,
 * Phase 4), not as a reason to lower the floor.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { QUANTUM, type EngineDef, type Tier } from '../src/contracts';
import { TesboxDspCore } from '../src/dsp/dsp-core';
import { loadEngine, resolveEngine } from './render';
import { bindSegmentEngine, createBaseControl, playSegments } from './segments';

export const FS = 48000;
export const WARM_S = 2;
/** Audio seconds per timed window. */
export const AUDIO_S = 20;
/** Timed windows per row; the floor gates on the fastest. */
export const WINDOWS = 3;
/** B6 (revised): CI gate — Full tier must render at least this many times faster than realtime (best window). */
export const FULL_FLOOR = 5;
/** Development target for the Full tier (reported in the table and summary; not gated). */
export const FULL_TARGET = 10;
export const ENGINES = ['v8-crossplane-test', 'i5-test'] as const;
export const TIERS: readonly Tier[] = ['full', 'lite'];

export interface BenchRow {
  engine: string;
  tier: Tier;
  /** Audio seconds rendered in each timed window. */
  audioS: number;
  /** Realtime factor (audio seconds per wall-clock second) of each timed window, in order. */
  factors: number[];
  /** Fastest window, the gated value; NaN when there is no window or any window is NaN. */
  bestFactor: number;
  /** Median window (mean of the middle two for an even count); NaN like bestFactor. */
  medianFactor: number;
}

/** A row from its per-window realtime factors: best = highest, plus the median. */
export function rowFromWindows(engine: string, tier: Tier, audioS: number, factors: readonly number[]): BenchRow {
  const sorted = [...factors].sort((a, b) => a - b);
  const n = sorted.length;
  const valid = n > 0 && !sorted.some((f) => Number.isNaN(f));
  const mid = (n - 1) / 2;
  const bestFactor = valid ? (sorted[n - 1] ?? Number.NaN) : Number.NaN;
  const medianFactor = valid ? ((sorted[Math.floor(mid)] ?? Number.NaN) + (sorted[Math.ceil(mid)] ?? Number.NaN)) / 2 : Number.NaN;
  return { engine, tier, audioS, factors: [...factors], bestFactor, medianFactor };
}

/**
 * Renders `warmS` (untimed), then `windows` consecutive timed windows of `audioS` each, of the segment
 * program on one core; returns every window's realtime factor with the best and the median.
 */
export function measureRealtime(def: EngineDef, tier: Tier, audioS: number, warmS: number, windows: number = WINDOWS): BenchRow {
  bindSegmentEngine(def.spec);
  const core = new TesboxDspCore(FS, 1);
  core.configure(def, { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 }, tier);
  core.forceHot();
  const ctl = createBaseControl(def.spec, 'cabin');
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  const dt = QUANTUM / FS;
  let q = 0;
  const run = (quanta: number): void => {
    for (let i = 0; i < quanta; i++, q++) {
      const t = q * dt;
      playSegments(t, ctl);
      core.render(ctl, l, r, QUANTUM, t);
    }
  };
  run(Math.round(warmS / dt));
  const quanta = Math.max(1, Math.round(audioS / dt));
  const renderedS = quanta * dt;
  const factors: number[] = [];
  for (let w = 0; w < windows; w++) {
    const t0 = performance.now();
    run(quanta);
    factors.push(renderedS / ((performance.now() - t0) / 1000));
  }
  return rowFromWindows(def.id, tier, renderedS, factors);
}

export function formatTable(rows: readonly BenchRow[]): string {
  return [
    `### DSP realtime factor (fs ${FS}, node ${process.version})`,
    '',
    `Consecutive timed windows per row on one core after a ${WARM_S} s warm-up. A Full row fails below ${FULL_FLOOR}× realtime in its best window (amendment B6, revised; development target ${FULL_TARGET}×, reported only); interference only ever slows a window down.`,
    '',
    '| engine | tier | audio (s) | × realtime, best | × realtime, median | windows |',
    '|---|---|---:|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.engine} | ${r.tier} | ${r.factors.length} × ${r.audioS.toFixed(1)} | ${r.bestFactor.toFixed(1)} | ${r.medianFactor.toFixed(1)} | ${r.factors.map((f) => f.toFixed(1)).join(', ')} |`,
    ),
    '',
  ].join('\n');
}

/** Full-tier rows whose best window is below the floor (the only failing condition; NaN counts as below). */
export function slowFullRows(rows: readonly BenchRow[], floor: number = FULL_FLOOR): BenchRow[] {
  return rows.filter((r) => r.tier === 'full' && !(r.bestFactor >= floor));
}

/** CLI entry; returns the process exit code. */
export function main(): number {
  const rows: BenchRow[] = [];
  for (const id of ENGINES) {
    const def = loadEngine(resolveEngine(id));
    for (const tier of TIERS) rows.push(measureRealtime(def, tier, AUDIO_S, WARM_S));
  }
  const table = formatTable(rows);
  console.log(table);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${table}\n`);
  const slow = slowFullRows(rows);
  if (slow.length > 0) {
    const detail = slow.map(
      (r) => `${r.engine} (best of ${r.factors.length} windows ${r.bestFactor.toFixed(1)}×, median ${r.medianFactor.toFixed(1)}×)`,
    );
    console.error(`bench-dsp: FAIL — Full tier below ${FULL_FLOOR}× realtime even in its best window: ${detail.join(', ')}`);
    return 1;
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = main();
}
