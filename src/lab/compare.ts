/**
 * Clip-vs-clip comparison (phase 2b contract "Comparison and scoring" as amended by D3, D6 and D8; spec §11.3).
 * Environment-free (Node + browser); analysis code may allocate.
 *
 * Two clips of the same kind and perspective are compared bin by bin over engine speed:
 * - Frames are grouped into RPM_BIN (500 rpm) bins centred on multiples of 500 rpm — the bin of c rpm holds
 *   rpm ∈ [c − 250, c + 250), the same bins as tools/png.ts's order plot (ORDER_PLOT.binRpm). Frames without a finite
 *   rpm > 0 (unvoiced) are left out. A bin is present in a clip when it holds ≥ MIN_BIN_FRAMES (2) frames; the common
 *   bins of two clips are the bins present in both.
 * - A bin's feature value is the arithmetic mean over its frames where that feature is defined (FrameFeatures:
 *   NaN / null mean "undefined"; a centroid or FI line must also be > 0 and an irregularity ≥ 0, so that their
 *   logarithms exist). Its order profile is the element-wise mean of the orderAmp rows (rows holding a
 *   non-finite or negative entry left out), normalised to unit L2; undefined when it is all zero.
 * - Amendment D6: a pair is comparable when it has at least minCommonBins(kind) common bins — 1 for the steady kinds
 *   (idle, cruise, limiter: a steady segment holds about one rpm, and the score CLI renders idle and cruise at exactly
 *   one), 2 for the sweeps (wot, liftoff) and any other kind. Each metric is the mean of its per-bin similarities over
 *   the common bins where both clips' values are defined, and needs that same number of such bins, else it is null
 *   (amendment D3 with D6's per-kind minimum). A pair that is not comparable has every metric null, overrun included.
 *
 * | metric       | per-bin Δ                                              | similarity      |
 * |--------------|--------------------------------------------------------|-----------------|
 * | orderProfile | cosine of the unit mean order profiles (no Δ)          | cosine ∈ [0, 1] |
 * | tilt         | |tilt_A − tilt_B| dB/oct                               | exp(−Δ / 3)     |
 * | centroid     | |log2(c_A / c_B)|                                      | exp(−Δ / 0.5)   |
 * | subOrder     | |sub_A − sub_B| dB                                     | exp(−Δ / 6)     |
 * | irregularity | |ln(i_A / i_B)| (two zeros match: Δ = 0)               | exp(−Δ / 0.7)   |
 * | fiLine       | |log2(f_A / f_B)|, bins where both have a line         | exp(−Δ / 0.25)  |
 * | overrun      | |ln((r_A + 0.5) / (r_B + 0.5))|, liftoff only          | exp(−Δ / 0.7)   |
 * | fiPresence   | |p_A − p_B|, p = share of the bin's frames with a line | 1 − Δ           |
 *
 * overrun compares the clips' overrunRate (one value per clip, the same in every common bin). fiPresence (amendment
 * D8, wot and cruise pairs only) compares how often an FI line is present: p is the fraction of the bin's (voiced)
 * frames whose fiLineHz is a line as the fiLine metric reads one, so it is defined in every present bin. Like every
 * other frame feature it is compared bin by bin over the common bins: a take that covers more rpm, or more gears, than
 * the other (the score CLI's wotPull render against a one-gear reference segment) is compared where both have frames,
 * not penalised for the frames the other lacks. The composite is the geometric mean of the non-null metrics. Every
 * similarity is in [0, 1], and compareClips is symmetric.
 */
import type { ClipFeatures, FrameFeatures } from './features';
import { STEADY_KINDS, type SegmentKind } from './pitch';

export type MetricName = 'orderProfile' | 'tilt' | 'centroid' | 'subOrder' | 'irregularity' | 'fiLine' | 'overrun' | 'fiPresence';

/** Every metric, in contract order with amendment D8's fiPresence last (the key order of every metric record built here). */
export const METRIC_NAMES: readonly MetricName[] = ['orderProfile', 'tilt', 'centroid', 'subOrder', 'irregularity', 'fiLine', 'overrun', 'fiPresence'];

/** RPM bin width; bins are centred on its multiples. */
export const RPM_BIN = 500;
/** A bin is present in a clip when it holds at least this many frames. */
export const MIN_BIN_FRAMES = 2;
/**
 * Common bins a pair needs to be comparable, and a metric needs with defined values in both clips (else null), by
 * the kind of the clips (amendment D6, refining D3's 2): steady kinds (idle, cruise, limiter) 1, sweeps (wot, liftoff) 2.
 */
export const MIN_COMMON_BINS = { steady: 1, sweep: 2 } as const;
/** similarity = exp(−Δ / scale) per metric (contract table). */
export const SIMILARITY_SCALE = { tilt: 3, centroid: 0.5, subOrder: 6, irregularity: 0.7, fiLine: 0.25, overrun: 0.7 } as const;
/** overrun compares ln(rate + OVERRUN_OFFSET): a clip without onsets reads 0.5/s rather than −∞. */
export const OVERRUN_OFFSET = 0.5;
/** The kinds whose pairs score fiPresence (amendment D8: wot + cruise). */
export const FI_PRESENCE_KINDS: readonly SegmentKind[] = ['wot', 'cruise'];

export interface PairScore {
  metrics: Record<MetricName, number | null>;
  composite: number | null;
  commonBins: number;
}

export interface CompareOptions {
  /**
   * false: the fiLine metric is null. Amendment D3 — the scorer passes false for naturally aspirated engines,
   * whose clips carry no forced-induction line (anything reported there is an engine harmonic, amendment D5).
   * Default true.
   */
  fiLine?: boolean;
  /**
   * false: the fiPresence metric is null. Amendment D8 scores it for forced-induction engines only; the scorer
   * switches it together with fiLine (score.ts compareOptionsFor), while compareClips keeps the two independent.
   * Default true.
   */
  fiPresence?: boolean;
}

/** Common bins (with defined values, per metric) a pair of clips of `kind` needs (amendment D6): see MIN_COMMON_BINS. */
export function minCommonBins(kind: string): number {
  return (STEADY_KINDS as readonly string[]).includes(kind) ? MIN_COMMON_BINS.steady : MIN_COMMON_BINS.sweep;
}

/** The per-bin scalar features, keyed by their metric. */
type ScalarMetric = 'tilt' | 'centroid' | 'subOrder' | 'irregularity' | 'fiLine' | 'fiPresence';

const SCALAR_METRICS: readonly ScalarMetric[] = ['tilt', 'centroid', 'subOrder', 'irregularity', 'fiLine', 'fiPresence'];

/** A frame's FI line: a finite fiLineHz > 0, else null. */
function fiLineOf(f: FrameFeatures): number | null {
  return f.fiLineHz !== null && f.fiLineHz > 0 && Number.isFinite(f.fiLineHz) ? f.fiLineHz : null;
}

/**
 * A frame's value for a scalar metric, or null where it is undefined (see the module comment). fiPresence is the
 * frame's line indicator (1: an FI line, 0: none), defined on every frame, so its bin mean is the share p.
 */
const FRAME_VALUE: Record<ScalarMetric, (f: FrameFeatures) => number | null> = {
  tilt: (f) => (Number.isFinite(f.tiltDbPerOct) ? f.tiltDbPerOct : null),
  centroid: (f) => (f.centroidHz > 0 && Number.isFinite(f.centroidHz) ? f.centroidHz : null),
  subOrder: (f) => (Number.isFinite(f.subOrderDb) ? f.subOrderDb : null),
  irregularity: (f) => (f.irregularity !== null && f.irregularity >= 0 && Number.isFinite(f.irregularity) ? f.irregularity : null),
  fiLine: fiLineOf,
  fiPresence: (f) => (fiLineOf(f) === null ? 0 : 1),
};

/** Per-bin similarity of two defined bin values; each Δ is written as a difference, so it is exactly symmetric. */
const SIMILARITY: Record<ScalarMetric, (a: number, b: number) => number> = {
  tilt: (a, b) => Math.exp(-Math.abs(a - b) / SIMILARITY_SCALE.tilt),
  centroid: (a, b) => Math.exp(-Math.abs(Math.log2(a) - Math.log2(b)) / SIMILARITY_SCALE.centroid),
  subOrder: (a, b) => Math.exp(-Math.abs(a - b) / SIMILARITY_SCALE.subOrder),
  // ln 0 = −∞: a CV of 0 against a positive one scores 0; two zeros (0/0) are identical.
  irregularity: (a, b) => (a === b ? 1 : Math.exp(-Math.abs(Math.log(a) - Math.log(b)) / SIMILARITY_SCALE.irregularity)),
  fiLine: (a, b) => Math.exp(-Math.abs(Math.log2(a) - Math.log2(b)) / SIMILARITY_SCALE.fiLine),
  fiPresence: (a, b) => 1 - Math.abs(a - b),
};

/** A present bin's summary. */
interface Bin {
  /** Unit-L2 mean order profile; null when there is no valid row or the mean is all zero. */
  profile: Float64Array | null;
  /** Mean of the defined frame values per scalar metric; null when no frame defines it. */
  value: Record<ScalarMetric, number | null>;
}

/** An all-null metric record, keys in METRIC_NAMES order. */
function nullMetrics(): Record<MetricName, number | null> {
  return { orderProfile: null, tilt: null, centroid: null, subOrder: null, irregularity: null, fiLine: null, overrun: null, fiPresence: null };
}

/** Bin index of a frame rpm: the bin of c = index·RPM_BIN rpm holds [c − RPM_BIN/2, c + RPM_BIN/2). */
function binIndex(rpm: number): number {
  return Math.floor((rpm + RPM_BIN / 2) / RPM_BIN);
}

/** True when every entry is finite and ≥ 0. */
function validRow(row: Float64Array): boolean {
  for (const v of row) if (!(v >= 0) || !Number.isFinite(v)) return false;
  return true;
}

/** sum / ‖sum‖₂ (scaled by its maximum first, so that tiny or huge levels neither underflow nor overflow); null when all zero. */
function unitVector(sum: Float64Array): Float64Array | null {
  let max = 0;
  for (const v of sum) max = Math.max(max, v);
  if (!(max > 0)) return null;
  let ss = 0;
  for (const v of sum) ss += (v / max) ** 2;
  const root = Math.sqrt(ss);
  return sum.map((v) => v / max / root);
}

function summarise(frames: FrameFeatures[], orders: number): Bin {
  const sum = new Float64Array(orders);
  let rows = 0;
  for (const f of frames) {
    if (!validRow(f.orderAmp)) continue;
    for (let i = 0; i < orders; i++) sum[i] = (sum[i] ?? 0) + (f.orderAmp[i] ?? 0);
    rows++;
  }
  const value = { tilt: null, centroid: null, subOrder: null, irregularity: null, fiLine: null, fiPresence: null } as Record<ScalarMetric, number | null>;
  for (const m of SCALAR_METRICS) {
    let s = 0;
    let n = 0;
    for (const f of frames) {
      const v = FRAME_VALUE[m](f);
      if (v === null) continue;
      s += v;
      n++;
    }
    value[m] = n > 0 ? s / n : null;
  }
  return { profile: rows > 0 ? unitVector(sum) : null, value };
}

/**
 * The present bins of a clip by bin index. Throws RangeError when its frames disagree on the order grid
 * (orderAmp lengths differ: frames of one clip share one step).
 */
function presentBins(c: ClipFeatures, who: string): Map<number, Bin> {
  const orders = c.frames[0]?.orderAmp.length ?? 0;
  const groups = new Map<number, FrameFeatures[]>();
  for (const f of c.frames) {
    if (f.orderAmp.length !== orders) {
      throw new RangeError(`compareClips: ${who} mixes order grids (${orders} and ${f.orderAmp.length} orders per frame)`);
    }
    if (!(f.rpm > 0) || !Number.isFinite(f.rpm)) continue;
    const k = binIndex(f.rpm);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [f]);
    else group.push(f);
  }
  const bins = new Map<number, Bin>();
  for (const [k, frames] of groups) if (frames.length >= MIN_BIN_FRAMES) bins.set(k, summarise(frames, orders));
  return bins;
}

/** Cosine of two unit profiles, clamped to [0, 1]; null when either is undefined or the order grids differ (½ vs ⅓ step). */
function cosine(a: Float64Array | null, b: Float64Array | null): number | null {
  if (a === null || b === null || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.min(1, Math.max(0, dot));
}

/** Mean of the non-null per-bin similarities; null when fewer than `minBins` (≥ 1) are defined. */
function binMean(values: (number | null)[], minBins: number): number | null {
  let s = 0;
  let n = 0;
  for (const v of values) {
    if (v === null) continue;
    s += v;
    n++;
  }
  return n >= Math.max(1, minBins) ? s / n : null;
}

/** overrun similarity of two clips of the same kind: liftoff only, both rates finite and ≥ 0. */
function overrunSimilarity(a: ClipFeatures, b: ClipFeatures): number | null {
  const ra = a.overrunRate;
  const rb = b.overrunRate;
  if (a.kind !== 'liftoff' || ra === null || rb === null) return null;
  if (!(ra >= 0) || !(rb >= 0) || !Number.isFinite(ra) || !Number.isFinite(rb)) return null;
  const delta = Math.abs(Math.log(ra + OVERRUN_OFFSET) - Math.log(rb + OVERRUN_OFFSET));
  return Math.exp(-delta / SIMILARITY_SCALE.overrun);
}

/**
 * Geometric mean of the non-null metrics (non-finite values count as null); 0 when any of them is 0; null when
 * none is defined.
 */
export function compositeScore(metrics: Record<MetricName, number | null>): number | null {
  let logSum = 0;
  let n = 0;
  for (const m of METRIC_NAMES) {
    const v = metrics[m];
    if (v === null || !Number.isFinite(v)) continue;
    if (v <= 0) return 0;
    logSum += Math.log(v);
    n++;
  }
  return n > 0 ? Math.exp(logSum / n) : null;
}

/**
 * Compares two clips of the same kind and perspective (see the module comment); `opts.fiLine === false` nulls the
 * fiLine metric (amendment D3), `opts.fiPresence === false` the fiPresence metric (amendment D8). Throws RangeError
 * for clips of different kinds or perspectives, and for a clip whose frames mix order grids; clips on different
 * grids (a ½-step and a ⅓-step engine) have orderProfile null.
 */
export function compareClips(a: ClipFeatures, b: ClipFeatures, opts: CompareOptions = {}): PairScore {
  if (a.kind !== b.kind || a.perspective !== b.perspective) {
    throw new RangeError(`compareClips: clips differ (${a.kind}/${a.perspective} vs ${b.kind}/${b.perspective}); compare like with like`);
  }
  const binsA = presentBins(a, 'clip A');
  const binsB = presentBins(b, 'clip B');
  const common: [Bin, Bin][] = [];
  // Ascending bin order: the per-bin sums run in the same order whichever clip comes first (exact symmetry).
  for (const k of [...binsA.keys()].sort((x, y) => x - y)) {
    const ba = binsA.get(k);
    const bb = binsB.get(k);
    if (ba !== undefined && bb !== undefined) common.push([ba, bb]);
  }
  const minBins = minCommonBins(a.kind);
  const fiPresence = opts.fiPresence !== false && (FI_PRESENCE_KINDS as readonly string[]).includes(a.kind);
  const metrics = nullMetrics();
  if (common.length >= minBins) {
    metrics.orderProfile = binMean(common.map(([x, y]) => cosine(x.profile, y.profile)), minBins);
    for (const m of SCALAR_METRICS) {
      if ((m === 'fiLine' && opts.fiLine === false) || (m === 'fiPresence' && !fiPresence)) continue;
      metrics[m] = binMean(
        common.map(([x, y]) => {
          const va = x.value[m];
          const vb = y.value[m];
          return va === null || vb === null ? null : SIMILARITY[m](va, vb);
        }),
        minBins,
      );
    }
    metrics.overrun = overrunSimilarity(a, b);
  }
  return { metrics, composite: compositeScore(metrics), commonBins: common.length };
}
