/**
 * Allocation / GC-pause gate (spec §14 "Allocation"; phase 2a contract T10 + amendment B2, revised 2026-10-07).
 *
 *   node --expose-gc --import tsx tools/check-alloc.ts [--profile]      (npm run check:alloc)
 *
 * Default V8 flags and semispace (no inlining or heap flags). Renders 10 000 warm-up quanta, then
 * measured windows of 100 000 quanta of v8-crossplane-test (Full tier) driven by every render segment
 * back-to-back (idle, cruise, WOT pull with shifts, lift-off overrun, limiter, auto shifts). V8 boxes
 * doubles that cross non-inlined calls, so scavenges (minor GCs) are expected and only reported; a
 * window fails if any single GC pause exceeds 4.0 ms or the total GC time exceeds 1 % of its rendered
 * audio duration (output buffering absorbs short scavenges; the in-car Diagnostics overload counters
 * are the real gate, spec §1.3b).
 *
 * The longest of ~350 scavenges is an extreme value, and OS scheduling noise only ever lengthens a
 * pause (a thread descheduled mid-scavenge adds wall time, not GC work). So the gate takes the best of
 * up to 3 windows: each starts with gc() and a fresh observer, on the same core and timeline; the first
 * window within budget passes, and exit 1 needs every window to fail. A real allocation regression
 * (systematically long scavenges or > 1 % GC time) fails all three. Extra windows run only after a
 * failure, and every window's verdict is printed, so a retry is visible in the CI log. The thresholds
 * are the contract's; do not loosen them or switch to a percentile.
 * `--profile` then prints the top allocation sites of 20 000 further quanta (sampling heap profiler,
 * incl. collected objects).
 * The syntactic hot-path lint rule (eslint.config.js) still bans allocation syntax in src/dsp, src/sim.
 */
import { Session } from 'node:inspector/promises';
import { resolve } from 'node:path';
import { PerformanceObserver, constants, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { QUANTUM } from '../src/contracts';
import { TesboxDspCore } from '../src/dsp/dsp-core';
import { loadEngine, resolveEngine } from './render';
import { bindSegmentEngine, createBaseControl, playSegments } from './segments';

export const FS = 48000;
export const WARM_QUANTA = 10_000;
export const MEASURE_QUANTA = 100_000;
export const PROFILE_QUANTA = 20_000;
export const ENGINE_ID = 'v8-crossplane-test';
/** B2 (revised): a window fails if any single GC pause is longer than this (ms)… */
export const MAX_PAUSE_MS = 4.0;
/** …or if its total GC time exceeds this fraction of its rendered audio duration. */
export const MAX_GC_FRACTION = 0.01;
/** Measured windows at most; the gate passes on the first window within budget. */
export const MAX_WINDOWS = 3;

export interface GcSample {
  /** perf_hooks constants.NODE_PERFORMANCE_GC_* (minor 1, major 4, incremental 8, weak callbacks 16). */
  kind: number;
  durationMs: number;
}

export interface GcVerdict {
  /** Scavenges (young-generation collections). */
  minor: number;
  major: number;
  other: number;
  totalMs: number;
  maxPauseMs: number;
  /** totalMs / rendered audio duration. */
  fraction: number;
  ok: boolean;
  reasons: string[];
}

/** Pure B2 verdict over the GC events observed while rendering `audioS` seconds of audio. */
export function gcVerdict(samples: readonly GcSample[], audioS: number): GcVerdict {
  let minor = 0;
  let major = 0;
  let other = 0;
  let totalMs = 0;
  let maxPauseMs = 0;
  for (const s of samples) {
    if (s.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
    else if (s.kind === constants.NODE_PERFORMANCE_GC_MAJOR) major++;
    else other++;
    totalMs += s.durationMs;
    maxPauseMs = Math.max(maxPauseMs, s.durationMs);
  }
  const fraction = audioS > 0 ? totalMs / (audioS * 1000) : Number.POSITIVE_INFINITY;
  const reasons: string[] = [];
  if (maxPauseMs > MAX_PAUSE_MS) reasons.push(`longest GC pause ${maxPauseMs.toFixed(3)} ms > ${MAX_PAUSE_MS} ms`);
  if (fraction > MAX_GC_FRACTION) {
    reasons.push(`total GC time ${totalMs.toFixed(1)} ms = ${(fraction * 100).toFixed(3)} % of audio > ${MAX_GC_FRACTION * 100} %`);
  }
  return { minor, major, other, totalMs, maxPauseMs, fraction, ok: reasons.length === 0, reasons };
}

/**
 * The gate over the measured windows: it passes when any window is within budget (scheduling noise
 * only ever lengthens a pause, while a real regression fails every window). No windows → fail.
 */
export function gateOk(windows: readonly GcVerdict[]): boolean {
  return windows.some((w) => w.ok);
}

/** Measures up to `maxWindows` windows in order (index 0, 1, …) and stops after the first within budget. */
export async function measureWindows(
  measure: (index: number) => Promise<GcVerdict>,
  maxWindows: number = MAX_WINDOWS,
): Promise<GcVerdict[]> {
  const verdicts: GcVerdict[] = [];
  for (let i = 0; i < maxWindows; i++) {
    const v = await measure(i);
    verdicts.push(v);
    if (v.ok) break;
  }
  return verdicts;
}

function nextTurn(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface ObservedWindow {
  samples: GcSample[];
  wallMs: number;
}

/** Renders MEASURE_QUANTA quanta under a fresh `gc` PerformanceObserver; returns the GC entries that started inside. */
async function observeWindow(renderQuanta: (count: number) => void): Promise<ObservedWindow> {
  const samples: GcSample[] = [];
  let windowStart = Number.POSITIVE_INFINITY;
  let windowEnd = Number.POSITIVE_INFINITY;
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.startTime < windowStart || e.startTime > windowEnd) continue;
      // Node's GC entries carry detail.kind; the DOM PerformanceEntry type (lib "DOM") does not declare it.
      const detail = (e as unknown as { detail?: { kind?: number } | null }).detail;
      samples.push({ kind: detail?.kind ?? -1, durationMs: e.duration });
    }
  });
  observer.observe({ entryTypes: ['gc'] });

  const CHUNK = 1000; // yield between chunks so the observer drains its queue
  windowStart = performance.now();
  for (let done = 0; done < MEASURE_QUANTA; done += CHUNK) {
    renderQuanta(Math.min(CHUNK, MEASURE_QUANTA - done));
    await nextTurn();
  }
  windowEnd = performance.now();
  await new Promise((r) => setTimeout(r, 50));
  observer.disconnect();
  return { samples, wallMs: windowEnd - windowStart };
}

function printWindow(index: number, w: ObservedWindow, v: GcVerdict, audioS: number): void {
  const longest = [...w.samples].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  console.log(`  window ${index + 1}/${MAX_WINDOWS}`);
  console.log(`    render wall time  ${w.wallMs.toFixed(0)} ms (${(audioS / (w.wallMs / 1000)).toFixed(1)}× realtime)`);
  console.log(`    GC events         scavenges (minor) ${v.minor}, major ${v.major}, other ${v.other}`);
  console.log(
    `    GC time           total ${v.totalMs.toFixed(1)} ms (${(v.fraction * 100).toFixed(3)} % of audio; budget ${MAX_GC_FRACTION * 100} %), longest pause ${v.maxPauseMs.toFixed(3)} ms (budget ${MAX_PAUSE_MS} ms)`,
  );
  console.log(`    longest pauses    ${longest.map((s) => `${s.durationMs.toFixed(3)} ms (kind ${s.kind})`).join(', ') || 'none'}`);
  console.log(`    verdict           ${v.ok ? 'within budget' : `over budget: ${v.reasons.join('; ')}`}`);
}

/** Top allocation sites (bytes) of `run()` via the sampling heap profiler, including collected objects. */
async function profileAllocations(run: () => void): Promise<[string, number][]> {
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  // The include* flags may be newer than @types/node's StartSamplingParameterType; a variable skips the excess-property check.
  const params = { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
  await session.post('HeapProfiler.startSampling', params);
  run();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  const sites = new Map<string, number>();
  type ProfileNode = (typeof profile)['head'];
  const walk = (n: ProfileNode): void => {
    if (n.selfSize > 0) {
      const f = n.callFrame;
      const key = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(src|tools)\//, '$1/')}`;
      sites.set(key, (sites.get(key) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  return [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
}

/** CLI entry; returns the process exit code (0 pass, 1 gate failed, 2 not run with --expose-gc). */
export async function main(argv: string[]): Promise<number> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    console.error('check-alloc: run with  node --expose-gc --import tsx tools/check-alloc.ts  (npm run check:alloc)');
    return 2;
  }
  const def = loadEngine(resolveEngine(ENGINE_ID));
  bindSegmentEngine(def.spec);
  const core = new TesboxDspCore(FS, 1);
  core.configure(def, { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 }, 'full');
  core.forceHot();
  const ctl = createBaseControl(def.spec, 'cabin');
  const outL = new Float32Array(QUANTUM);
  const outR = new Float32Array(QUANTUM);
  const dt = QUANTUM / FS;

  let q = 0;
  const renderQuanta = (count: number): void => {
    for (let i = 0; i < count; i++, q++) {
      const t = q * dt;
      playSegments(t, ctl);
      core.render(ctl, outL, outR, QUANTUM, t);
    }
  };

  renderQuanta(WARM_QUANTA);
  const audioS = MEASURE_QUANTA * dt;
  console.log(
    `check-alloc: ${ENGINE_ID} (Full), ${WARM_QUANTA} warm-up quanta, then up to ${MAX_WINDOWS} windows of ${MEASURE_QUANTA} quanta = ${audioS.toFixed(1)} s of audio each (the first window within budget passes)`,
  );
  const verdicts = await measureWindows(async (index) => {
    gc(); // start every measured window with an empty young generation
    await nextTurn();
    const w = await observeWindow(renderQuanta);
    const v = gcVerdict(w.samples, audioS);
    printWindow(index, w, v, audioS);
    return v;
  });
  console.log(`  non-finite resets ${core.stats.nonFiniteResets}`);

  if (argv.includes('--profile')) {
    const top = await profileAllocations(() => renderQuanta(PROFILE_QUANTA));
    console.log(`\nTop allocation sites over ${PROFILE_QUANTA} quanta (sampled bytes):`);
    for (const [site, bytes] of top) console.log(`${String(bytes).padStart(12)}  ${site}`);
  }

  if (!gateOk(verdicts)) {
    const why = verdicts.map((v, i) => `window ${i + 1}: ${v.reasons.join('; ')}`).join(' | ');
    console.error(
      `check-alloc: FAIL — all ${verdicts.length} windows over budget (${why}); run with --profile to find the allocation sites`,
    );
    return 1;
  }
  const passed = verdicts.findIndex((v) => v.ok) + 1;
  console.log(
    passed === 1
      ? 'check-alloc: OK'
      : `check-alloc: OK — window ${passed}/${MAX_WINDOWS} within budget after ${passed - 1} over budget (see above)`,
  );
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
