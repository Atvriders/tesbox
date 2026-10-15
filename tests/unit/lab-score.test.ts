/**
 * Phase 2b T3 — clip comparison and engine scoring (src/lab/compare.ts, src/lab/score.ts; phase 2b contract
 * "Comparison and scoring" as amended by D3, D6 and D8; spec §11.3). Every formula is pinned first on synthetic
 * ClipFeatures whose per-bin means are known exactly, then on Phase 2a DSP renders of the fixture engines, with renders
 * of other seeds standing in for the reference recordings (pseudo-references).
 */
import { describe, expect, it } from 'vitest';
import { QUANTUM, type AspirationType, type EngineDef, type Perspective } from '../../src/contracts';
import { TesboxDspCore } from '../../src/dsp/dsp-core';
import {
  FI_PRESENCE_KINDS,
  METRIC_NAMES,
  MIN_BIN_FRAMES,
  MIN_COMMON_BINS,
  OVERRUN_OFFSET,
  RPM_BIN,
  SIMILARITY_SCALE,
  compareClips,
  compositeScore,
  minCommonBins,
  type MetricName,
} from '../../src/lab/compare';
import { clipFeatures, type ClipFeatures, type FrameFeatures } from '../../src/lab/features';
import { GATE_RATIO, MIN_REFS, compareOptionsFor, metricGate, scoreEngine, type EngineScore } from '../../src/lab/score';
import { PREROLL_S } from '../../tools/render';
import { SEGMENTS, bindSegmentEngine, createBaseControl } from '../../tools/segments';
import { loadFixture } from './helpers/fixtures';

const E = Math.exp;

// ───────────────────────────── Synthetic ClipFeatures ─────────────────────────────

/** orderAmp entries of a 4-stroke (step ½, orders ½ … 12). */
const ORDERS = 24;

/** An orderAmp vector whose first entries are `lead` (orders ½, 1, 1½, …), zero elsewhere. */
function amps(...lead: number[]): Float64Array {
  const a = new Float64Array(ORDERS);
  lead.forEach((v, i) => {
    a[i] = v;
  });
  return a;
}

/** Default order profile: order k·½ at 1/k. */
const BASE_AMP = Float64Array.from({ length: ORDERS }, (_, i) => 1 / (i + 1));

interface FrameSpec {
  rpm: number;
  orderAmp?: Float64Array;
  tilt?: number;
  centroid?: number;
  subOrder?: number;
  irregularity?: number | null;
  fiLine?: number | null;
}

/** One frame; every feature not given takes a fixed default (fiLine none). */
function frame(s: FrameSpec): FrameFeatures {
  return {
    rpm: s.rpm,
    orderAmp: s.orderAmp ?? BASE_AMP,
    centroidHz: s.centroid ?? 1500,
    tiltDbPerOct: s.tilt ?? -4,
    subOrderDb: s.subOrder ?? -10,
    irregularity: s.irregularity === undefined ? 0.1 : s.irregularity,
    fiLineHz: s.fiLine === undefined ? null : s.fiLine,
    levelDb: -20,
  };
}

/** n identical frames. */
function rep(n: number, s: FrameSpec): FrameFeatures[] {
  return Array.from({ length: n }, () => frame(s));
}

interface ClipOpts {
  kind?: string;
  perspective?: Perspective;
  overrunRate?: number | null;
}

function clip(frames: FrameFeatures[], o: ClipOpts = {}): ClipFeatures {
  return { kind: o.kind ?? 'wot', perspective: o.perspective ?? 'cabin', frames, overrunRate: o.overrunRate ?? null };
}

/** Two bins (2000 and 3000 rpm, two frames each) of default frames with the given tilt and FI line. */
function tclip(tilt: number, o: ClipOpts & { fiLine?: number | null } = {}): ClipFeatures {
  return clip([...rep(2, { rpm: 2000, tilt, fiLine: o.fiLine }), ...rep(2, { rpm: 3000, tilt, fiLine: o.fiLine })], o);
}

/** Geometric mean of the values. */
function geomean(values: number[]): number {
  return E(values.reduce((s, v) => s + Math.log(v), 0) / values.length);
}

/** Every metric of `got` is null where `want` is null, else within 1e−12 of it. */
function expectMetrics(got: Record<MetricName, number | null>, want: Record<MetricName, number | null>, label = ''): void {
  for (const m of METRIC_NAMES) {
    const w = want[m];
    if (w === null) expect(got[m], `${label}${m}`).toBeNull();
    else expect(got[m], `${label}${m}`).toBeCloseTo(w, 12);
  }
}

const SCALAR_METRICS = ['tilt', 'centroid', 'subOrder', 'irregularity', 'fiLine'] as const;

describe('compare constants (contract)', () => {
  it('pins the bin width, bin and frame minima, similarity scales, overrun offset and metric order', () => {
    expect(RPM_BIN).toBe(500);
    expect(MIN_BIN_FRAMES).toBe(2);
    expect(MIN_COMMON_BINS).toEqual({ steady: 1, sweep: 2 });
    expect(SIMILARITY_SCALE).toEqual({ tilt: 3, centroid: 0.5, subOrder: 6, irregularity: 0.7, fiLine: 0.25, overrun: 0.7 });
    expect(OVERRUN_OFFSET).toBe(0.5);
    // Amendment D8 appends fiPresence to the contract's seven metrics; it is scored on wot and cruise pairs.
    expect(METRIC_NAMES).toEqual(['orderProfile', 'tilt', 'centroid', 'subOrder', 'irregularity', 'fiLine', 'overrun', 'fiPresence']);
    expect(FI_PRESENCE_KINDS).toEqual(['wot', 'cruise']);
  });

  it('D6: steady kinds (idle, cruise, limiter) need 1 common bin, sweeps (wot, liftoff) 2, any other kind the stricter 2', () => {
    for (const kind of ['idle', 'cruise', 'limiter']) expect(minCommonBins(kind), kind).toBe(1);
    for (const kind of ['wot', 'liftoff', 'wotPull', '']) expect(minCommonBins(kind), kind).toBe(2);
  });
});

describe('compareClips — similarity formulas', () => {
  // Bin 2000 rpm: every metric differs by a known Δ between the clips' per-bin arithmetic MEANS. A holds three
  // asymmetric frames there, so the usual alternatives give other numbers: tilt −2, −2, −8 has mean −4, median −2
  // and midrange −5 (every scalar feature is built the same way; the positive ones also have a geometric mean
  // below the arithmetic one), and averaging per-frame similarities differs again. A's orderAmp rows [6, 0],
  // [0, 5], [0, 1] have unequal norms: their mean [2, 2] points along [1, 1]/√2, unlike the per-order median
  // [0, 1], the midrange [3, 2.5], the power (RMS) mean [√12, √(26/3)] or a mean of per-frame unit profiles
  // [⅓, ⅔] (renormalised or not). B's frames are identical there. Bin 3000 rpm: identical clips (similarity 1).
  const a = clip(
    [
      frame({ rpm: 1990, orderAmp: amps(6, 0), tilt: -2, centroid: 800, subOrder: -8, irregularity: 0.05, fiLine: 1800 }),
      frame({ rpm: 2000, orderAmp: amps(0, 5), tilt: -2, centroid: 800, subOrder: -8, irregularity: 0.05, fiLine: 1800 }),
      frame({ rpm: 2010, orderAmp: amps(0, 1), tilt: -8, centroid: 1400, subOrder: -14, irregularity: 0.2, fiLine: 2400 }),
      ...rep(2, { rpm: 3000, fiLine: 3000 }),
    ],
    { kind: 'liftoff', overrunRate: 1 },
  );
  const b = clip(
    [
      ...rep(2, {
        rpm: 2000,
        orderAmp: amps(1, 0),
        tilt: -7,
        centroid: 2000,
        subOrder: -16,
        irregularity: 0.1 * E(0.7),
        fiLine: 2000 * 2 ** 0.25,
      }),
      ...rep(2, { rpm: 3000, fiLine: 3000 }),
    ],
    { kind: 'liftoff', overrunRate: 1.5 * E(0.7) - 0.5 },
  );
  // A's 2000 rpm means: profile [1, 1]/√2, tilt −4, centroid 1000 Hz, subOrder −10 dB, irregularity 0.1, line 2000 Hz.
  const expected: Record<MetricName, number | null> = {
    orderProfile: (Math.SQRT1_2 + 1) / 2, // cosine([1, 1, 0 …]/√2, [1, 0, …]) = 1/√2
    tilt: (E(-3 / 3) + 1) / 2, // |−4 − (−7)| = 3 dB/oct
    centroid: (E(-1 / 0.5) + 1) / 2, // |log2(1000 / 2000)| = 1 octave
    subOrder: (E(-6 / 6) + 1) / 2, // |−10 − (−16)| = 6 dB
    irregularity: (E(-0.7 / 0.7) + 1) / 2, // |ln(0.1 / 0.1·e^0.7)| = 0.7
    fiLine: (E(-0.25 / 0.25) + 1) / 2, // |log2(2000 / 2000·2^¼)| = ¼ octave
    overrun: E(-0.7 / 0.7), // |ln((1 + 0.5) / (1.5·e^0.7))| = 0.7
    fiPresence: null, // amendment D8 scores wot and cruise pairs only (see 'compareClips — fiPresence')
  };

  it('each metric is the mean over common bins of exp(−Δ / scale) on the bins’ arithmetic-mean features', () => {
    const s = compareClips(a, b);
    expect(s.commonBins).toBe(2);
    expectMetrics(s.metrics, expected);
  });

  it('the composite is the geometric mean of the non-null metrics', () => {
    const s = compareClips(a, b);
    expect(s.composite).toBeCloseTo(geomean(METRIC_NAMES.flatMap((m) => expected[m] ?? [])), 12);
    expect(s.composite).toBe(compositeScore(s.metrics));
  });

  it('is symmetric and leaves its inputs untouched', () => {
    const before = JSON.stringify([a, b], (_k, v: unknown) => (v instanceof Float64Array ? Array.from(v) : v));
    expect(compareClips(b, a)).toEqual(compareClips(a, b));
    expect(JSON.stringify([a, b], (_k, v: unknown) => (v instanceof Float64Array ? Array.from(v) : v))).toBe(before);
  });

  it('a clip compared with itself scores 1 on every defined metric', () => {
    const s = compareClips(a, a);
    for (const m of METRIC_NAMES) {
      if (expected[m] === null) expect(s.metrics[m], m).toBeNull();
      else expect(s.metrics[m], m).toBeCloseTo(1, 12);
    }
    expect(s.composite).toBeCloseTo(1, 12);
  });

  it('every similarity stays in [0, 1], reaching 0 for orthogonal order profiles', () => {
    const far = clip([...rep(2, { rpm: 2000, orderAmp: amps(0, 1) }), ...rep(2, { rpm: 3000, orderAmp: amps(0, 1) })]);
    const near = clip([...rep(2, { rpm: 2000, orderAmp: amps(1, 0) }), ...rep(2, { rpm: 3000, orderAmp: amps(1, 0) })]);
    expect(compareClips(far, near).metrics.orderProfile).toBe(0);
    const wild = clip(
      [
        ...rep(2, { rpm: 2000, orderAmp: amps(0, 0, 0, 9), tilt: 40, centroid: 20, subOrder: 60, irregularity: 5, fiLine: 1000 }),
        ...rep(2, { rpm: 3000, orderAmp: amps(0, 0, 0, 9), tilt: -40, centroid: 12000, subOrder: -60, irregularity: 1e-4, fiLine: 4000 }),
      ],
      { kind: 'liftoff', overrunRate: 300 },
    );
    const s = compareClips(wild, b);
    for (const m of METRIC_NAMES) {
      const v = s.metrics[m];
      if (m === 'fiPresence') {
        expect(v, m).toBeNull(); // liftoff (D8: wot and cruise only); its range is pinned in 'compareClips — fiPresence'
        continue;
      }
      expect(v, m).not.toBeNull();
      expect(v, m).toBeGreaterThanOrEqual(0);
      expect(v, m).toBeLessThanOrEqual(1);
    }
  });

  it('rejects clips of different kinds or perspectives', () => {
    expect(() => compareClips(tclip(-4), tclip(-4, { kind: 'idle' }))).toThrow(RangeError);
    expect(() => compareClips(tclip(-4), tclip(-4, { perspective: 'outside' }))).toThrow(RangeError);
  });
});

describe('compareClips — rpm bins', () => {
  it('bins are 500 rpm wide and centred on multiples of 500 rpm: [c − 250, c + 250)', () => {
    const ref = clip([...rep(2, { rpm: 2000 }), ...rep(2, { rpm: 2500 })]);
    const inside = clip([frame({ rpm: 1750 }), frame({ rpm: 2249.999 }), frame({ rpm: 2250 }), frame({ rpm: 2749.999 })]);
    expect(compareClips(inside, ref).commonBins).toBe(2);
    // One frame each in the 1500, 2000, 2500 and 3000 rpm bins: no bin is present.
    const shifted = clip([frame({ rpm: 1749.999 }), frame({ rpm: 2249.999 }), frame({ rpm: 2250 }), frame({ rpm: 2750 })]);
    expect(compareClips(shifted, ref).commonBins).toBe(0);
  });

  it('counts only bins holding ≥ 2 frames in both clips', () => {
    // 2500 rpm: one frame in A; 3500 rpm: A only. Either would pull tilt below 1 if it counted.
    const a = clip([
      ...rep(2, { rpm: 2000 }),
      frame({ rpm: 2500, tilt: 40 }),
      ...rep(2, { rpm: 3000 }),
      ...rep(3, { rpm: 3500, tilt: 40 }),
    ]);
    const b = clip([...rep(2, { rpm: 2000 }), ...rep(2, { rpm: 2500, tilt: -40 }), ...rep(2, { rpm: 3000 })]);
    const s = compareClips(a, b);
    expect(s.commonBins).toBe(2);
    expect(s.metrics.tilt).toBe(1);
  });

  it('frames without a finite positive rpm are left out of every bin', () => {
    // Both clips hold two frames at each such rpm (tilts 80 dB/oct apart), so every one of them would form a present
    // common bin, and pull tilt towards 0, if it were binned.
    const invalid = [Number.NaN, 0, -2000, Number.POSITIVE_INFINITY];
    const a = clip([...tclip(-4).frames, ...invalid.flatMap((rpm) => rep(2, { rpm, tilt: 40 }))]);
    const b = clip([...tclip(-4).frames, ...invalid.flatMap((rpm) => rep(2, { rpm, tilt: -40 }))]);
    const s = compareClips(a, b);
    expect(s.commonBins).toBe(2);
    expect(s.metrics.tilt).toBe(1);
  });

  it('D6: a sweep (wot, liftoff) with fewer than 2 common bins has every metric (overrun, fiPresence included) and the composite null', () => {
    // Both clips carry an FI line in every frame, so fiPresence would read 1 if a non-comparable pair scored it.
    for (const kind of ['liftoff', 'wot']) {
      const a = clip([...rep(3, { rpm: 2000, fiLine: 2000 }), ...rep(3, { rpm: 3000, fiLine: 2000 })], { kind, overrunRate: 1 });
      const b = clip([...rep(3, { rpm: 2000, fiLine: 2000 }), frame({ rpm: 3000, fiLine: 2000 })], { kind, overrunRate: 1 });
      const s = compareClips(a, b);
      expect(s.commonBins, kind).toBe(1);
      for (const m of METRIC_NAMES) expect(s.metrics[m], `${kind} ${m}`).toBeNull();
      expect(s.composite, kind).toBeNull();
    }
  });

  it('D6: a steady segment (idle, cruise, limiter) needs one common bin, so constant-rpm segments are comparable', () => {
    // Every frame at 4000 rpm (one 500 rpm bin), as the score CLI renders idle and cruise. tilt −4 vs −7 dB/oct (Δ 3:
    // e^−1), centroid 1000 vs 2000 Hz (1 octave: e^−2), every other feature equal, no FI line in either clip.
    const steady = (kind: string, tilt: number, centroid: number): ClipFeatures => clip(rep(30, { rpm: 4000, tilt, centroid }), { kind });
    for (const kind of ['idle', 'cruise', 'limiter']) {
      const s = compareClips(steady(kind, -4, 1000), steady(kind, -7, 2000));
      // fiPresence: wot and cruise pairs only (D8); here p = 0 on both sides
      const fiPresence = kind === 'cruise' ? 1 : null;
      expect(s.commonBins, kind).toBe(1);
      expectMetrics(
        s.metrics,
        { orderProfile: 1, tilt: E(-1), centroid: E(-2), subOrder: 1, irregularity: 1, fiLine: null, overrun: null, fiPresence },
        `${kind} `,
      );
      // geometric mean of the defined metrics: e^(−3/5), or e^(−3/6) with cruise's fiPresence
      expect(s.composite, kind).toBeCloseTo(geomean([1, E(-1), E(-2), 1, 1, ...(fiPresence === null ? [] : [fiPresence])]), 12);
    }
    // The same frames as a sweep: one common bin is too few.
    for (const kind of ['wot', 'liftoff']) {
      const s = compareClips(steady(kind, -4, 1000), steady(kind, -7, 2000));
      expect(s.commonBins, kind).toBe(1);
      expect(s.composite, kind).toBeNull();
    }
  });

  it('D6: a steady pair still needs ≥ 2 frames on each side of the shared bin', () => {
    const many = clip(rep(30, { rpm: 4000 }), { kind: 'cruise' });
    const one = clip([frame({ rpm: 4000 }), ...rep(5, { rpm: 5000 })], { kind: 'cruise' });
    expect(compareClips(many, one).commonBins).toBe(0);
    expect(compareClips(many, one).composite).toBeNull();
  });

  it('D6: a constant-rpm steady segment is comparable with a tracked one wandering across a bin edge, over the bin they share', () => {
    // Idle around 700 rpm: the 500 rpm bin holds [250, 750). A tracked idle that wanders up to 790 rpm also fills the
    // 1000 rpm bin (its last 9 of 20 frames); one that stays below 750 rpm does not.
    const constant = clip(rep(20, { rpm: 700 }), { kind: 'idle' });
    const wander = (hi: number, tiltAbove750 = -4): ClipFeatures =>
      clip(
        Array.from({ length: 20 }, (_, i) => {
          const rpm = 700 + ((hi - 700) * i) / 19;
          return frame({ rpm, tilt: rpm >= 750 ? tiltAbove750 : -4 });
        }),
        { kind: 'idle' },
      );
    expect(compareClips(wander(790), wander(790)).commonBins).toBe(2);
    expect(compareClips(wander(740), wander(740)).commonBins).toBe(1);
    expect(compareClips(wander(740), wander(740)).composite).toBeCloseTo(1, 12);
    expect(compareClips(constant, wander(790)).commonBins).toBe(1);
    expect(compareClips(constant, wander(790)).composite).toBeCloseTo(1, 12);
    // Only the shared bin counts: the wandering clip's 1000 rpm frames (tilt −40) would pull tilt towards 0 if they did.
    expect(compareClips(constant, wander(790, -40)).metrics.tilt).toBe(1);
    // A constant idle at 1000 rpm shares no bin with one at 700 rpm.
    const apart = clip(rep(20, { rpm: 1000 }), { kind: 'idle' });
    expect(compareClips(constant, apart).commonBins).toBe(0);
    expect(compareClips(constant, apart).composite).toBeNull();
  });
});

describe('compareClips — undefined values (amendment D3)', () => {
  const defined = {
    lo: { tilt: -3, centroid: 1000, subOrder: -10, irregularity: 0.2, fiLine: 2000 },
    hi: { tilt: -5, centroid: 1200, subOrder: -14, irregularity: 0.3, fiLine: 2500 },
  };
  const undef = { tilt: Number.NaN, centroid: Number.NaN, subOrder: Number.NaN, irregularity: null, fiLine: null };

  it('leaves NaN / null frame values out of the per-bin means', () => {
    const a = clip([
      frame({ rpm: 2000, ...undef }),
      frame({ rpm: 2000, ...defined.lo }),
      frame({ rpm: 3000, ...defined.hi }),
      frame({ rpm: 3000, ...undef }),
    ]);
    const b = clip([...rep(2, { rpm: 2000, ...defined.lo }), ...rep(2, { rpm: 3000, ...defined.hi })]);
    const s = compareClips(a, b);
    for (const m of SCALAR_METRICS) expect(s.metrics[m], m).toBeCloseTo(1, 12);
  });

  it('skips a bin with no defined value; a metric with < 2 valid common bins is null while the others stand', () => {
    // Three common bins. A's tilt is undefined in two of them (1 valid bin → null); its centroid in one (2 valid
    // bins: 2500 and 3000, compared with B's means there).
    const a = clip([
      ...rep(2, { rpm: 2000, tilt: Number.NaN, centroid: Number.NaN }),
      ...rep(2, { rpm: 2500, tilt: Number.NaN, centroid: 1000 }),
      ...rep(2, { rpm: 3000, tilt: -4, centroid: 1000 }),
    ]);
    const b = clip([...rep(2, { rpm: 2000, centroid: 1000 }), ...rep(2, { rpm: 2500, centroid: 2000 }), ...rep(2, { rpm: 3000, centroid: 1000 })]);
    const s = compareClips(a, b);
    expect(s.commonBins).toBe(3);
    expect(s.metrics.tilt).toBeNull();
    expect(s.metrics.centroid).toBeCloseTo((E(-2) + 1) / 2, 12);
    expect(s.metrics.subOrder).toBe(1);
    expect(s.metrics.fiPresence).toBe(1); // a wot pair; neither clip has an FI line (p = 0 on both sides, D8)
    // orderProfile, centroid, subOrder, irregularity, fiPresence
    expect(s.composite).toBeCloseTo(geomean([1, (E(-2) + 1) / 2, 1, 1, 1]), 12);
  });

  it('D6: on a steady pair a metric needs one valid common bin (on a sweep pair 2)', () => {
    // Common bins 500 and 1000 rpm; A's tilt is undefined in the 500 rpm bin, so tilt has one valid bin (−7 vs −4: e^−1).
    const pair = (kind: string, tilt500: number) =>
      compareClips(
        clip([...rep(2, { rpm: 500, tilt: tilt500 }), ...rep(2, { rpm: 1000, tilt: -7 })], { kind }),
        clip([...rep(2, { rpm: 500, tilt: -4 }), ...rep(2, { rpm: 1000, tilt: -4 })], { kind }),
      );
    for (const kind of ['idle', 'cruise', 'limiter']) {
      expect(pair(kind, Number.NaN).commonBins, kind).toBe(2);
      expect(pair(kind, Number.NaN).metrics.tilt, kind).toBeCloseTo(E(-1), 12);
    }
    for (const kind of ['wot', 'liftoff']) {
      expect(pair(kind, Number.NaN).metrics.tilt, kind).toBeNull();
      expect(pair(kind, -4).metrics.tilt, kind).toBeCloseTo((1 + E(-1)) / 2, 12); // both bins valid
    }
    // No valid bin: null on a steady pair too.
    const none = compareClips(
      clip(rep(4, { rpm: 1000, tilt: Number.NaN }), { kind: 'idle' }),
      clip(rep(4, { rpm: 1000, tilt: -4 }), { kind: 'idle' }),
    );
    expect(none.commonBins).toBe(1);
    expect(none.metrics.tilt).toBeNull();
    expect(none.metrics.centroid).toBe(1);
  });

  it('a non-positive centroid or FI line is undefined (no logarithm), a negative irregularity too', () => {
    const a = clip([
      ...rep(2, { rpm: 2000, centroid: 0, fiLine: -1000, irregularity: -0.1 }),
      ...rep(2, { rpm: 3000, centroid: 1000, fiLine: 2000, irregularity: 0.1 }),
    ]);
    const b = clip([...rep(2, { rpm: 2000, centroid: 1000, fiLine: 2000 }), ...rep(2, { rpm: 3000, centroid: 1000, fiLine: 2000 })]);
    const s = compareClips(a, b);
    expect(s.metrics.centroid).toBeNull();
    expect(s.metrics.fiLine).toBeNull();
    expect(s.metrics.irregularity).toBeNull();
  });
});

describe('compareClips — fiLine', () => {
  const lines = (...hz: (number | null)[]): ClipFeatures =>
    clip(hz.flatMap((f, i) => rep(2, { rpm: 2000 + 500 * i, fiLine: f })));

  it('is null when either clip has no FI line at all', () => {
    expect(compareClips(lines(2000, 2000, 2000), lines(null, null, null)).metrics.fiLine).toBeNull();
    expect(compareClips(lines(null, null, null), lines(2000, 2000, 2000)).metrics.fiLine).toBeNull();
  });

  it('is compared only over the bins where both clips have a line', () => {
    // Bins 2000 / 2500 / 3000 rpm; B has no line at 2000, so only 2500 (Δ ¼ octave) and 3000 (Δ 0) count.
    const s = compareClips(lines(1000, 2000, 3000), lines(null, 2000 * 2 ** 0.25, 3000));
    expect(s.metrics.fiLine).toBeCloseTo((E(-1) + 1) / 2, 12);
    // A single bin with lines in both: null (amendment D3).
    expect(compareClips(lines(1000, 2000, 3000), lines(null, null, 3000)).metrics.fiLine).toBeNull();
  });

  it('opts.fiLine = false (naturally aspirated engine, amendment D3) makes it null and keeps it out of the composite', () => {
    const a = lines(2000, 2000, 2000);
    const b = lines(2400, 2400, 2400);
    const scored = compareClips(a, b);
    expect(scored.metrics.fiLine).toBeCloseTo(E(-Math.log2(1.2) / 0.25), 12);
    const na = compareClips(a, b, { fiLine: false });
    expect(na.metrics.fiLine).toBeNull();
    expect(na.composite).toBeCloseTo(1, 12); // only identical features left
    expect({ ...na.metrics, fiLine: scored.metrics.fiLine }).toEqual(scored.metrics);
  });
});

describe('compareClips — fiPresence (amendment D8)', () => {
  /** A clip of `kind` with two frames at 2000 rpm and two at 3000 rpm carrying these FI lines (null: none), in order. */
  const lined = (lines: (number | null)[], kind = 'wot'): ClipFeatures =>
    clip(
      lines.map((fiLine, i) => frame({ rpm: i < 2 ? 2000 : 3000, fiLine })),
      { kind },
    );
  /** Per-bin p: 2000 rpm 1, 3000 rpm ½ (threeOfFour); 2000 rpm ½, 3000 rpm 0 (oneOfFour). */
  const threeOfFour = lined([2000, 2000, 2000, null]);
  const oneOfFour = lined([2000, null, null, null]);

  it('is the mean over the common bins of 1 − |p_A − p_B|, p being the share of the bin’s frames that carry an FI line', () => {
    expect(compareClips(threeOfFour, oneOfFour).metrics.fiPresence).toBe(0.5); // ½ in both bins
    expect(compareClips(threeOfFour, threeOfFour).metrics.fiPresence).toBe(1);
    // A: 2000 rpm 4 of 4 frames, 3000 rpm 0 of 2; B: 2000 rpm 1 of 2, 3000 rpm 0 of 2. Per bin: ½ and 1, mean ¾.
    // One share per clip would give 1 − |4/6 − 1/4| = 7/12 instead: the bins are weighed alike, whatever their frames.
    const a = clip([...rep(4, { rpm: 2000, fiLine: 2000 }), ...rep(2, { rpm: 3000 })]);
    const b = clip([frame({ rpm: 2000, fiLine: 2000 }), frame({ rpm: 2000 }), ...rep(2, { rpm: 3000 })]);
    expect(compareClips(a, b).metrics.fiPresence).toBe(0.75);
  });

  it('compares the clips where both have frames: a take covering more rpm (or more gears) than the other is not penalised for it', () => {
    // The score CLI's wotPull render spans every gear's pull, from low rpm where no line has built up yet; a reference
    // wot segment is one gear's pull higher up. Over the common bins (5000, 5500 rpm) both carry the line throughout,
    // so they match; one share per clip would read 1 − |½ − 1| = ½ (and a render against its own source recording would
    // fail its gate). Frames without a finite rpm > 0 fall in no bin, so their lines never count either.
    const render = clip([
      ...rep(2, { rpm: 3000 }),
      ...rep(2, { rpm: 3500 }),
      ...rep(2, { rpm: 5000, fiLine: 2000 }),
      ...rep(2, { rpm: 5500, fiLine: 2000 }),
      ...[Number.NaN, 0, -3000].map((rpm) => frame({ rpm })),
    ]);
    const ref = clip([...rep(3, { rpm: 5000, fiLine: 2100 }), ...rep(3, { rpm: 5500, fiLine: 2100 })]);
    const s = compareClips(render, ref);
    expect(s.commonBins).toBe(2);
    expect(s.metrics.fiPresence).toBe(1);
  });

  it('a line counts where the fiLine metric reads one: a finite frequency > 0', () => {
    // A's 2000 rpm frames have no line (0, −1000 Hz), its 3000 rpm frames one in 2 of 4 (NaN and ∞ are not lines); B
    // carries none at 2000 rpm and a line on both frames at 3000 rpm. Per bin: 1 and ½. Counting every non-null value
    // as a line would give 0 and 1 instead.
    const a = clip([
      frame({ rpm: 2000, fiLine: 0 }),
      frame({ rpm: 2000, fiLine: -1000 }),
      frame({ rpm: 3000, fiLine: Number.NaN }),
      frame({ rpm: 3000, fiLine: Number.POSITIVE_INFINITY }),
      frame({ rpm: 3000, fiLine: 2500 }),
      frame({ rpm: 3000, fiLine: 2500 }),
    ]);
    const b = clip([...rep(2, { rpm: 2000 }), ...rep(2, { rpm: 3000, fiLine: 2500 })]);
    expect(compareClips(a, b).metrics.fiPresence).toBe(0.75);
  });

  it('is scored on comparable wot and cruise pairs only', () => {
    for (const kind of ['wot', 'cruise']) {
      expect(compareClips(lined([2000, 2000, 2000, null], kind), lined([2000, null, null, null], kind)).metrics.fiPresence, kind).toBe(0.5);
    }
    for (const kind of ['idle', 'liftoff', 'limiter']) {
      const s = compareClips(lined([2000, 2000, 2000, null], kind), lined([2000, null, null, null], kind));
      expect(s.commonBins, kind).toBe(2);
      expect(s.metrics.fiPresence, kind).toBeNull();
    }
    // A wot pair with one common bin is not comparable (D6), whatever its clips' shares (here 1 and 0).
    const oneBin = compareClips(clip(rep(4, { rpm: 2000, fiLine: 2000 })), clip([...rep(2, { rpm: 2000 }), ...rep(2, { rpm: 4000 })]));
    expect(oneBin.commonBins).toBe(1);
    expect(oneBin.metrics.fiPresence).toBeNull();
    // A constant-rpm cruise pair is (one common bin suffices for a steady kind).
    const steady = compareClips(clip(rep(4, { rpm: 2000, fiLine: 2000 }), { kind: 'cruise' }), clip(rep(4, { rpm: 2000 }), { kind: 'cruise' }));
    expect(steady.commonBins).toBe(1);
    expect(steady.metrics.fiPresence).toBe(0);
  });

  it('enters the composite: a clip carrying the line throughout against one without it scores 0 there and overall', () => {
    // threeOfFour vs oneOfFour: every other feature equal; fiLine has one bin where both have a line (null for a sweep).
    const s = compareClips(threeOfFour, oneOfFour);
    expect(s.metrics.fiLine).toBeNull();
    expect(s.composite).toBeCloseTo(0.5 ** (1 / 6), 12); // orderProfile, tilt, centroid, subOrder, irregularity at 1; fiPresence ½
    expect(s.composite).toBe(compositeScore(s.metrics));
    const all = lined([2000, 2000, 2000, 2000]);
    const none = lined([null, null, null, null]);
    expect(compareClips(all, none).metrics.fiPresence).toBe(0);
    expect(compareClips(all, none).composite).toBe(0);
  });

  it('is symmetric', () => {
    expect(compareClips(oneOfFour, threeOfFour)).toEqual(compareClips(threeOfFour, oneOfFour));
  });

  it('opts.fiPresence = false (naturally aspirated engine) nulls it; fiLine and fiPresence are switched independently', () => {
    const off = compareClips(threeOfFour, oneOfFour, { fiPresence: false });
    expect(off.metrics.fiPresence).toBeNull();
    expect(off.composite).toBeCloseTo(1, 12);
    const all = lined([2000, 2000, 2000, 2000]);
    const near = lined([2400, 2400, 2400, 2400]);
    expect(compareClips(all, near, { fiPresence: false }).metrics.fiLine).toBeCloseTo(E(-Math.log2(1.2) / 0.25), 12);
    expect(compareClips(threeOfFour, oneOfFour, { fiLine: false }).metrics.fiPresence).toBe(0.5);
  });
});

describe('compareClips — irregularity', () => {
  it('two perfectly regular clips (CV 0) match; regular vs irregular scores 0', () => {
    const regular = clip([...rep(2, { rpm: 2000, irregularity: 0 }), ...rep(2, { rpm: 3000, irregularity: 0 })]);
    expect(compareClips(regular, regular).metrics.irregularity).toBe(1);
    expect(compareClips(regular, tclip(-4)).metrics.irregularity).toBe(0);
  });
});

describe('compareClips — orderProfile', () => {
  const profile = (...frames: Float64Array[]): ClipFeatures =>
    clip([...frames.map((orderAmp) => frame({ rpm: 2000, orderAmp })), ...frames.map((orderAmp) => frame({ rpm: 3000, orderAmp }))]);

  it('is invariant to level (each mean profile is normalised to unit L2)', () => {
    const shape = amps(1, 0.5, 0.25, 2, 0.1);
    const s = compareClips(profile(shape, shape), profile(shape.map((v) => 7 * v), shape.map((v) => 7 * v)));
    expect(s.metrics.orderProfile).toBeCloseTo(1, 12);
  });

  it('keeps tiny and huge levels finite (each mean profile is scaled by its maximum before it is normalised)', () => {
    // Unscaled, Σ v² of rows at 1e−200 underflows to 0 (profile Infinity / NaN, metric NaN) and at 1e200 overflows
    // to Infinity (profile all zero, cosine 0).
    const shape = amps(1, 0.5, 0.25, 2, 0.1);
    for (const scale of [1e-200, 1e200]) {
      const scaled = shape.map((v) => scale * v);
      expect(compareClips(profile(scaled, scaled), profile(shape, shape)).metrics.orderProfile, String(scale)).toBeCloseTo(1, 12);
    }
  });

  it('leaves an orderAmp row holding a NaN, an Infinity or a negative entry out of its bin’s mean profile', () => {
    // Each bin of A holds two clean rows along order ½ and one invalid row leaning on order 1. Averaged in, a NaN
    // would void both bins' profiles (metric null), an Infinity would turn them into NaN (metric NaN) and a −1 would
    // turn them towards order 1 (cosine ≈ 0.02).
    const withRow = (bad: Float64Array): ClipFeatures =>
      clip([
        ...rep(2, { rpm: 2000, orderAmp: amps(1, 0) }),
        frame({ rpm: 2000, orderAmp: bad }),
        ...rep(2, { rpm: 3000, orderAmp: amps(1, 0) }),
        frame({ rpm: 3000, orderAmp: bad }),
      ]);
    const clean = clip([...rep(2, { rpm: 2000, orderAmp: amps(1, 0) }), ...rep(2, { rpm: 3000, orderAmp: amps(1, 0) })]);
    expect(compareClips(withRow(amps(Number.NaN, 50)), clean).metrics.orderProfile).toBe(1);
    expect(compareClips(withRow(amps(Number.POSITIVE_INFINITY, 50)), clean).metrics.orderProfile).toBe(1);
    expect(compareClips(withRow(amps(-1, 50)), clean).metrics.orderProfile).toBe(1);
  });

  it('skips a bin whose mean profile is all zero (no direction)', () => {
    const a = clip([...rep(2, { rpm: 2000, orderAmp: amps() }), ...rep(2, { rpm: 3000 }), ...rep(2, { rpm: 3500 })]);
    const b = clip([...rep(2, { rpm: 2000 }), ...rep(2, { rpm: 3000 }), ...rep(2, { rpm: 3500, orderAmp: amps(0, 1) })]);
    // Valid bins 3000 (identical: 1) and 3500 (cosine(BASE_AMP, order 1) = (1/2) / ‖BASE_AMP‖).
    let norm = 0;
    for (const v of BASE_AMP) norm += v * v;
    expect(compareClips(a, b).metrics.orderProfile).toBeCloseTo((1 + 0.5 / Math.sqrt(norm)) / 2, 12);
  });

  it('is null between clips on different order grids (½ vs ⅓ steps); the other metrics stand', () => {
    const rotaryAmp = new Float64Array(36).fill(0.1);
    const rotary = clip([...rep(2, { rpm: 2000, orderAmp: rotaryAmp }), ...rep(2, { rpm: 3000, orderAmp: rotaryAmp })]);
    const s = compareClips(tclip(-4), rotary);
    expect(s.metrics.orderProfile).toBeNull();
    expect(s.metrics.tilt).toBe(1);
  });

  it('rejects a clip whose frames disagree on the order grid', () => {
    const bad = clip([...rep(2, { rpm: 2000 }), frame({ rpm: 3000, orderAmp: new Float64Array(36) }), frame({ rpm: 3000 })]);
    expect(() => compareClips(bad, tclip(-4))).toThrow(RangeError);
  });
});

describe('compareClips — overrun', () => {
  const liftoff = (rate: number | null): ClipFeatures => clip(tclip(-4).frames, { kind: 'liftoff', overrunRate: rate });

  it('is exp(−|ln((r_A + 0.5) / (r_B + 0.5))| / 0.7) for liftoff clips', () => {
    expect(compareClips(liftoff(0), liftoff(0)).metrics.overrun).toBe(1);
    expect(compareClips(liftoff(0), liftoff(1)).metrics.overrun).toBeCloseTo(E(-Math.log(3) / 0.7), 12);
    expect(compareClips(liftoff(4), liftoff(1)).metrics.overrun).toBeCloseTo(E(-Math.log(3) / 0.7), 12);
  });

  it('is null when either rate is missing or not a finite rate ≥ 0, and for every kind but liftoff', () => {
    expect(compareClips(liftoff(null), liftoff(1)).metrics.overrun).toBeNull();
    expect(compareClips(liftoff(1), liftoff(null)).metrics.overrun).toBeNull();
    // Unguarded, ln(−1 + 0.5) and ln(NaN) would give NaN, and ln(∞) a similarity of 0.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compareClips(liftoff(bad), liftoff(1)).metrics.overrun, String(bad)).toBeNull();
      expect(compareClips(liftoff(1), liftoff(bad)).metrics.overrun, String(bad)).toBeNull();
    }
    const wot = (rate: number): ClipFeatures => clip(tclip(-4).frames, { kind: 'wot', overrunRate: rate });
    expect(compareClips(wot(1), wot(1)).metrics.overrun).toBeNull();
  });
});

describe('compositeScore', () => {
  const none: Record<MetricName, number | null> = {
    orderProfile: null,
    tilt: null,
    centroid: null,
    subOrder: null,
    irregularity: null,
    fiLine: null,
    overrun: null,
    fiPresence: null,
  };

  it('is the geometric mean of the non-null metrics, null when every metric is null', () => {
    expect(compositeScore({ ...none, tilt: 0.5, overrun: 0.8 })).toBeCloseTo(Math.sqrt(0.4), 14);
    expect(compositeScore({ ...none, centroid: 0.9 })).toBeCloseTo(0.9, 14);
    expect(compositeScore(none)).toBeNull();
  });

  it('counts fiPresence like any other metric (amendment D8)', () => {
    expect(compositeScore({ ...none, tilt: 1, fiPresence: 0.25 })).toBeCloseTo(0.5, 14);
    expect(compositeScore({ ...none, tilt: 0.9, fiPresence: 0 })).toBe(0);
  });

  it('is 0 when any metric is 0', () => {
    expect(compositeScore({ ...none, tilt: 0, centroid: 1, subOrder: 0.9 })).toBe(0);
  });

  it('skips non-finite metrics as if they were null', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(compositeScore({ ...none, tilt: bad, centroid: 0.9 }), String(bad)).toBeCloseTo(0.9, 14);
      expect(compositeScore({ ...none, tilt: bad }), String(bad)).toBeNull();
    }
  });
});

// ───────────────────────────── scoreEngine (synthetic) ─────────────────────────────

/**
 * Every metric except tilt, FI line and overrun is 1 between tclip()s of a forced-induction engine — fiPresence
 * included: no tclip() carries a line unless asked to, so p = 0 on both sides (amendment D8).
 */
const UNIT_METRICS = ['orderProfile', 'centroid', 'subOrder', 'irregularity', 'fiPresence'] as const;

describe('scoreEngine — render vs ref, ref vs ref, gates, composite', () => {
  // Cabin wot refs at tilt −3 and −6 dB/oct (ref vs ref Δ 3 → e^−1). The outside / cruise refs have no partner of
  // their own kind and perspective, so they never enter refVsRef.
  const refs = [tclip(-3), tclip(-6), tclip(-20, { perspective: 'outside' }), tclip(-20, { kind: 'cruise' })];

  it('renderVsRef / refVsRef are means over the (render, ref) and distinct (ref, ref) pairs of the same kind and perspective', () => {
    const s = scoreEngine('e', [tclip(-4.5), tclip(-4.5, { kind: 'cruise' })], refs, {}, { aspiration: 'turbo' });
    expect(s.engineId).toBe('e');
    // Pairs: wot render vs both wot refs (Δ 1.5 each), cruise render vs the cruise ref (Δ 15.5).
    expect(s.renderVsRef.tilt).toBeCloseTo((2 * E(-0.5) + E(-15.5 / 3)) / 3, 12);
    expect(s.refVsRef.tilt).toBeCloseTo(E(-1), 12);
    for (const m of UNIT_METRICS) {
      expect(s.renderVsRef[m], m).toBeCloseTo(1, 12);
      expect(s.refVsRef[m], m).toBeCloseTo(1, 12);
    }
    expect(s.renderVsRef.fiLine).toBeNull();
    expect(s.renderVsRef.overrun).toBeNull();
    expect(s.unscored).toBe(false);
  });

  it('averages over pairs, each pair weighing the same whatever its number of common bins (bins are not pooled)', () => {
    // A 4-bin render (2000–3500 rpm) at tilt −4.5 against a 2-bin ref (tclip: 2000 and 3000 rpm) at −3 and 4-bin
    // refs at −6 and −7.5.
    const wide = (tilt: number): ClipFeatures => clip([2000, 2500, 3000, 3500].flatMap((rpm) => rep(2, { rpm, tilt })));
    const render = wide(-4.5);
    const narrow3 = tclip(-3);
    const wide6 = wide(-6);
    const wide75 = wide(-7.5);
    const refs = [narrow3, wide6, wide75];
    expect(refs.map((f) => compareClips(render, f).commonBins)).toEqual([2, 4, 4]);
    const refPairs = [compareClips(narrow3, wide6), compareClips(narrow3, wide75), compareClips(wide6, wide75)];
    expect(refPairs.map((p) => p.commonBins)).toEqual([2, 2, 4]);
    const s = scoreEngine('e', [render], refs, {}, { aspiration: 'turbo' });
    // Render pairs: Δ 1.5, 1.5, 3 (pooling the 2 + 4 + 4 bins would give (6·e^−0.5 + 4·e^−1) / 10).
    expect(s.renderVsRef.tilt).toBeCloseTo((2 * E(-0.5) + E(-1)) / 3, 12);
    // Ref pairs: Δ 3 and 4.5 over 2 bins, Δ 1.5 over 4 (pooling would give (2·e^−1 + 2·e^−1.5 + 4·e^−0.5) / 8).
    expect(s.refVsRef.tilt).toBeCloseTo((E(-1) + E(-1.5) + E(-0.5)) / 3, 12);
  });

  it('leaves a pair out of the mean of a metric it does not define; the pair still counts for the other metrics', () => {
    // A wot pair (tilt Δ 0, overrun null: liftoff only) and a liftoff pair (tilt Δ 3, overrun Δ 0.7).
    const lift = (tilt: number, rate: number): ClipFeatures => clip(tclip(tilt).frames, { kind: 'liftoff', overrunRate: rate });
    const s = scoreEngine('e', [tclip(-4), lift(-4, 1)], [tclip(-4), lift(-7, 1.5 * E(0.7) - 0.5)], {}, { aspiration: 'turbo' });
    expect(s.renderVsRef.overrun).toBeCloseTo(E(-1), 12); // the liftoff pair alone, not (0 + e^−1) / 2
    expect(s.renderVsRef.tilt).toBeCloseTo((1 + E(-1)) / 2, 12);
  });

  it('gates each metric at renderVsRef ≥ 0.8 × refVsRef; n/a when either side is null', () => {
    const near = scoreEngine('e', [tclip(-4.5)], refs, {}, { aspiration: 'turbo' });
    expect(near.renderVsRef.tilt).toBeCloseTo(E(-0.5), 12);
    expect(near.gate).toEqual({
      orderProfile: 'pass',
      tilt: 'pass',
      centroid: 'pass',
      subOrder: 'pass',
      irregularity: 'pass',
      fiLine: 'n/a',
      overrun: 'n/a',
      fiPresence: 'pass',
    });
    // tilt −15: Δ 12 and 9 → (e^−4 + e^−3)/2 = 0.034 < 0.8·e^−1 = 0.294.
    const far = scoreEngine('e', [tclip(-15)], refs, {}, { aspiration: 'turbo' });
    expect(far.renderVsRef.tilt).toBeCloseTo((E(-4) + E(-3)) / 2, 12);
    expect(far.gate.tilt).toBe('fail');
    expect(far.gate.centroid).toBe('pass');
  });

  it('metricGate passes at exactly 0.8 × refVsRef', () => {
    expect(GATE_RATIO).toBe(0.8);
    expect(metricGate(0.4, 0.5)).toBe('pass');
    expect(metricGate(0.3999999, 0.5)).toBe('fail');
    expect(metricGate(1, 1)).toBe('pass');
    expect(metricGate(null, 0.5)).toBe('n/a');
    expect(metricGate(0.5, null)).toBe('n/a');
    expect(metricGate(null, null)).toBe('n/a');
  });

  it('composite is the geometric mean of the non-null renderVsRef metrics', () => {
    const s = scoreEngine('e', [tclip(-4.5)], refs, {}, { aspiration: 'turbo' });
    // (1·e^−0.5·1·1·1·1)^(1/6): orderProfile, tilt, centroid, subOrder, irregularity and fiPresence (D8)
    expect(s.composite).toBeCloseTo(E(-0.5 / 6), 12);
    expect(s.composite).toBe(compositeScore(s.renderVsRef));
  });

  it('refs without a partner of their kind and perspective leave refVsRef null and every gate n/a', () => {
    // Two refs, so not unscored, yet no ceiling: an all-'n/a' gate record is not a pass (see score.ts).
    const s = scoreEngine('e', [tclip(-4.5)], [tclip(-3), tclip(-6, { perspective: 'outside' })], {}, { aspiration: 'turbo' });
    for (const m of METRIC_NAMES) {
      expect(s.refVsRef[m], m).toBeNull();
      expect(s.gate[m], m).toBe('n/a');
    }
    expect(s.renderVsRef.tilt).toBeCloseTo(E(-0.5), 12);
    expect(s.unscored).toBe(false);
  });

  it('refVsRef spans every slot holding a comparable ref pair, even one where no render pair is comparable (contract as written)', () => {
    // The render idles at 700 rpm (the 500 rpm bin). Two idle refs at 1000 rpm share no bin with it, so no render pair
    // of the idle slot is comparable, yet they are comparable with each other (one common bin suffices for a steady kind,
    // amendment D6): their pair (tilt Δ 6 dB/oct) enters the ceiling and flips the tilt gate although renderVsRef is the
    // same. A ceiling restricted to the slots renderVsRef covers would need a contract change (see score.ts); this pins
    // the current rule.
    const idle = (rpm: number, tilt: number): ClipFeatures => clip(rep(20, { rpm, tilt }), { kind: 'idle' });
    const render = [tclip(-4.5), idle(700, -4.5)];
    const without = scoreEngine('e', render, [tclip(-3), tclip(-3)], {}, { aspiration: 'turbo' });
    const elsewhere = scoreEngine('e', render, [tclip(-3), tclip(-3), idle(1000, -3), idle(1000, -9)], {}, { aspiration: 'turbo' });
    for (const s of [without, elsewhere]) expect(s.renderVsRef.tilt).toBeCloseTo(E(-0.5), 12); // the wot pairs alone: 0.607
    expect(without.refVsRef.tilt).toBe(1); // the wot ref pair alone
    expect(without.gate.tilt).toBe('fail'); // 0.607 < 0.8 × 1
    expect(elsewhere.refVsRef.tilt).toBeCloseTo((1 + E(-2)) / 2, 12); // the wot and idle ref pairs: 0.568
    expect(elsewhere.gate.tilt).toBe('pass'); // 0.607 ≥ 0.8 × 0.568
  });

  it('D6: constant-rpm steady renders (idle, cruise) score against steady refs that share their bin', () => {
    // The score CLI renders idle and cruise at one rpm each. Render idle 800 rpm and cruise 4000 rpm at tilt −4.5; refs
    // from two recordings, tracked: idles wandering 760–840 rpm and cruises 3800–4200 rpm, at tilt −3 and −6 (all in
    // the render's 1000 and 4000 rpm bins). Every render pair has tilt Δ 1.5 (e^−0.5), every ref pair Δ 3 (e^−1).
    const steady = (kind: string, from: number, to: number, tilt: number): ClipFeatures =>
      clip(Array.from({ length: 20 }, (_, i) => frame({ rpm: from + ((to - from) * i) / 19, tilt })), { kind });
    const render = [steady('idle', 800, 800, -4.5), steady('cruise', 4000, 4000, -4.5)];
    const refs = [-3, -6].flatMap((tilt) => [steady('idle', 760, 840, tilt), steady('cruise', 3800, 4200, tilt)]);
    const s = scoreEngine('e', render, refs, {}, { aspiration: 'turbo' });
    expect(s.renderVsRef.tilt).toBeCloseTo(E(-0.5), 12);
    expect(s.refVsRef.tilt).toBeCloseTo(E(-1), 12);
    expect(s.gate.tilt).toBe('pass');
    for (const m of UNIT_METRICS) expect(s.gate[m], m).toBe('pass'); // fiPresence from the cruise pairs
    expect(s.composite).toBeCloseTo(E(-0.5 / 6), 12);
  });

  it('a render with no matching ref has null scores, n/a gates and no discrimination verdict', () => {
    const s = scoreEngine('e', [tclip(-4.5, { kind: 'idle' })], refs, { other: [tclip(-4.5, { kind: 'idle' })] }, { aspiration: 'turbo' });
    for (const m of METRIC_NAMES) expect(s.renderVsRef[m], m).toBeNull();
    expect(s.composite).toBeNull();
    expect(s.discrimination.ownComposite).toBeNull();
    expect(s.discrimination.pass).toBeNull();
  });

  it('is unscored with fewer than 2 refs (spec §11.3)', () => {
    expect(MIN_REFS).toBe(2);
    const zero = scoreEngine('e', [tclip(-4.5)], [], {}, { aspiration: 'turbo' });
    expect(zero.unscored).toBe(true);
    expect(zero.composite).toBeNull();
    for (const m of METRIC_NAMES) expect(zero.gate[m], m).toBe('n/a');
    const one = scoreEngine('e', [tclip(-4.5)], [tclip(-3)], {}, { aspiration: 'turbo' });
    expect(one.unscored).toBe(true);
    expect(one.renderVsRef.tilt).toBeCloseTo(E(-0.5), 12);
    expect(scoreEngine('e', [tclip(-4.5)], [tclip(-3), tclip(-6)], {}, { aspiration: 'turbo' }).unscored).toBe(false);
  });

  it('returns exactly the contract fields', () => {
    const s: EngineScore = scoreEngine('e', [tclip(-4.5)], refs, {}, { aspiration: 'turbo' });
    expect(Object.keys(s).sort()).toEqual(['composite', 'discrimination', 'engineId', 'gate', 'refVsRef', 'renderVsRef', 'unscored']);
    expect(Object.keys(s.renderVsRef)).toEqual([...METRIC_NAMES]);
    expect(Object.keys(s.discrimination).sort()).toEqual(['others', 'ownComposite', 'pass']);
  });
});

describe('scoreEngine — discrimination', () => {
  const refs = [tclip(-3), tclip(-6)];
  const render = [tclip(-4.5)];
  const turbo = { aspiration: 'turbo' as const };

  it('passes when the composite vs own refs is strictly higher than vs every other engine’s refs', () => {
    // Six defined metrics (fiPresence 1: no line anywhere). vs 'far': Δ 7.5 → tilt e^−2.5 → composite e^(−2.5/6) <
    // own e^(−0.5/6).
    const s = scoreEngine('e', render, refs, { far: [tclip(-12), tclip(-12)] }, turbo);
    expect(s.discrimination.ownComposite).toBeCloseTo(E(-0.5 / 6), 12);
    expect(s.discrimination.others).toHaveLength(1);
    expect(s.discrimination.others[0]?.engineId).toBe('far');
    expect(s.discrimination.others[0]?.composite).toBeCloseTo(E(-2.5 / 6), 12);
    expect(s.discrimination.pass).toBe(true);
  });

  it('fails when any other engine’s refs score as high or higher (ties fail)', () => {
    const closer = scoreEngine('e', render, refs, { far: [tclip(-12)], closer: [tclip(-4.5)] }, turbo);
    expect(closer.discrimination.pass).toBe(false);
    const tie = scoreEngine('e', render, refs, { twin: [tclip(-3), tclip(-6)] }, turbo);
    expect(tie.discrimination.others[0]?.composite).toBe(tie.discrimination.ownComposite);
    expect(tie.discrimination.pass).toBe(false);
  });

  it('only engines with refs take part; the scored engine itself is never an "other"; others are sorted by id', () => {
    const s = scoreEngine('e', render, refs, { zeta: [tclip(-12)], e: refs, empty: [], alpha: [tclip(-9)] }, turbo);
    expect(s.discrimination.others.map((o) => o.engineId)).toEqual(['alpha', 'zeta']);
    expect(s.discrimination.pass).toBe(true);
  });

  it('compares the one own composite with each other engine’s even when their refs cover different slots (contract as written)', () => {
    // Own refs cover wot and liftoff; 'wotOnly' covers wot alone. The own composite carries the liftoff pairs'
    // overrun similarity (rates 0 vs 5/s: e^(−ln 11 / 0.7) ≈ 0.033), which 'wotOnly' never sees, so a render whose
    // wot sound matches its own refs exactly loses to an engine 3 dB/oct away on wot. Restricted to the shared wot
    // slot it passes. A slot-matched comparison would need a contract change; this pins the current rule.
    const lift = (tilt: number, rate: number): ClipFeatures => clip(tclip(tilt).frames, { kind: 'liftoff', overrunRate: rate });
    const own = [tclip(-4.5), tclip(-4.5), lift(-4.5, 5), lift(-4.5, 5)];
    const others = { wotOnly: [tclip(-7.5), tclip(-7.5)] };
    const overrun = E(-Math.log(11) / 0.7);
    const both = scoreEngine('e', [tclip(-4.5), lift(-4.5, 0)], own, others, turbo);
    expect(both.renderVsRef.overrun).toBeCloseTo(overrun, 12);
    // 0.613: six metrics at 1 (fiPresence from the wot pairs), overrun
    expect(both.discrimination.ownComposite).toBeCloseTo(overrun ** (1 / 7), 12);
    expect(both.discrimination.others[0]?.composite).toBeCloseTo(E(-1 / 6), 12); // 0.846: tilt e^−1, five metrics at 1
    expect(both.discrimination.pass).toBe(false);
    const wotOnly = scoreEngine('e', [tclip(-4.5)], own, others, turbo);
    expect(wotOnly.discrimination.ownComposite).toBeCloseTo(1, 12);
    expect(wotOnly.discrimination.others[0]?.composite).toBeCloseTo(E(-1 / 6), 12);
    expect(wotOnly.discrimination.pass).toBe(true);
  });

  it('is null with no other engine’s refs, or when none of them is comparable', () => {
    expect(scoreEngine('e', render, refs, {}, turbo).discrimination).toEqual({
      ownComposite: compositeScore(scoreEngine('e', render, refs, {}, turbo).renderVsRef),
      others: [],
      pass: null,
    });
    const s = scoreEngine('e', render, refs, { idleOnly: [tclip(-4.5, { kind: 'idle' })] }, turbo);
    expect(s.discrimination.others).toEqual([{ engineId: 'idleOnly', composite: null }]);
    expect(s.discrimination.pass).toBeNull();
  });
});

describe('scoreEngine — fiLine and fiPresence for naturally aspirated engines (amendments D3, D8)', () => {
  // Refs 2000 / 2400 Hz, render 2200 Hz, 'far' refs 3000 Hz: fiLine is < 1 whenever it is scored. Every clip carries its
  // line in every frame, so fiPresence is 1 whenever it is scored.
  const refs = [tclip(-3, { fiLine: 2000 }), tclip(-6, { fiLine: 2400 })];
  const render = [tclip(-4.5, { fiLine: 2200 })];
  const others = { far: [tclip(-12, { fiLine: 3000 })] };
  const sim = (fa: number, fb: number): number => E(-Math.abs(Math.log2(fa / fb)) / 0.25);

  function expectNa(s: EngineScore): void {
    for (const m of ['fiLine', 'fiPresence'] as const) {
      expect(s.renderVsRef[m], m).toBeNull();
      expect(s.refVsRef[m], m).toBeNull();
      expect(s.gate[m], m).toBe('n/a');
    }
    expect(s.composite).toBeCloseTo(E(-0.1), 12); // as without any FI line: (1·e^−0.5·1·1·1)^(1/5)
    expect(s.discrimination.others[0]?.composite).toBeCloseTo(E(-0.5), 12);
  }

  function expectScored(s: EngineScore): void {
    expect(s.renderVsRef.fiLine).toBeCloseTo((sim(2200, 2000) + sim(2200, 2400)) / 2, 12);
    expect(s.refVsRef.fiLine).toBeCloseTo(sim(2000, 2400), 12);
    expect(s.gate.fiLine).toBe('pass');
    expect(s.renderVsRef.fiPresence).toBe(1);
    expect(s.refVsRef.fiPresence).toBe(1);
    expect(s.gate.fiPresence).toBe('pass');
    // seven defined metrics: tilt e^−0.5, fiLine, five at 1 (fiPresence among them)
    expect(s.composite).toBeCloseTo(geomean([E(-0.5), s.renderVsRef.fiLine ?? Number.NaN]) ** (2 / 7), 12);
  }

  it('aspiration "na": fiLine and fiPresence are n/a in render vs ref, ref vs ref, the composite and discrimination', () => {
    expectNa(scoreEngine('e', render, refs, others, { aspiration: 'na' }));
  });

  it('turbo and supercharged engines score it', () => {
    for (const aspiration of ['turbo', 'supercharger'] as const satisfies readonly AspirationType[]) {
      expectScored(scoreEngine('e', render, refs, others, { aspiration }));
    }
  });

  it('defaults to the starter garage record of the engine id', () => {
    expectNa(scoreEngine('v8-na-50', render, refs, others));
    expectNa(scoreEngine('v8-flatplane-45', render, refs, others));
    expectScored(scoreEngine('i5-turbo-25', render, refs, others));
    expectScored(scoreEngine('v8-sc-62', render, refs, others));
    // An explicit aspiration wins over the garage record.
    expectScored(scoreEngine('v8-na-50', render, refs, others, { aspiration: 'turbo' }));
  });

  it('rejects an engine outside the garage without an explicit aspiration (no guessing)', () => {
    expect(() => scoreEngine('i4-test', render, refs, others)).toThrow(RangeError);
    expect(() => scoreEngine('i4-test', render, refs, others, { aspiration: 'turbo' })).not.toThrow();
  });
});

describe('scoreEngine — fiPresence (amendment D8)', () => {
  const turbo = { aspiration: 'turbo' as const };
  /**
   * A wot tclip (2000 and 3000 rpm, two frames each) whose first `n` of 4 frames carry a 2000 Hz FI line: per-bin p
   * (2000, 3000 rpm) = (1, 1) for n = 4, (1, ½) for 3, (1, 0) for 2, (0, 0) for 0.
   */
  const withLines = (n: number): ClipFeatures => clip([2000, 2000, 3000, 3000].map((rpm, i) => frame({ rpm, fiLine: i < n ? 2000 : null })));

  it('renderVsRef / refVsRef average the pairs’ per-bin 1 − |p_A − p_B| like any metric; gated at 0.8 × refVsRef', () => {
    // Refs (1, 1) and (1, 0): refVsRef (1 + 0) / 2 = ½, so the gate needs ≥ 0.4.
    const refs = [withLines(4), withLines(2)];
    const none = scoreEngine('e', [withLines(0)], refs, {}, turbo); // pairs (0 + 0) / 2 and (0 + 1) / 2: ¼
    expect(none.renderVsRef.fiPresence).toBeCloseTo(0.25, 15);
    expect(none.refVsRef.fiPresence).toBeCloseTo(0.5, 15);
    expect(none.gate.fiPresence).toBe('fail');
    // fiLine says nothing here (the render has no line at all); fiPresence alone carries the miss into the composite.
    expect(none.renderVsRef.fiLine).toBeNull();
    expect(none.composite).toBeCloseTo(0.25 ** (1 / 6), 12);
    const most = scoreEngine('e', [withLines(3)], refs, {}, turbo); // pairs (1 + ½) / 2 and (1 + ½) / 2: ¾
    expect(most.renderVsRef.fiPresence).toBeCloseTo(0.75, 15);
    expect(most.gate.fiPresence).toBe('pass');
  });

  it('drives discrimination: a render lacking the line its refs carry loses to refs that lack it too, and the converse', () => {
    // Own refs carry the line throughout (p = 1 in every bin); the 'twin' engine's refs are the same sound without it.
    const own = [withLines(4), withLines(4)];
    const twin = { twin: [withLines(0), withLines(0)] };
    const lacking = scoreEngine('e', [withLines(0)], own, twin, turbo);
    expect(lacking.renderVsRef.fiPresence).toBe(0);
    expect(lacking.composite).toBe(0);
    expect(lacking.discrimination.others[0]?.composite).toBeCloseTo(1, 12);
    expect(lacking.discrimination.pass).toBe(false);
    const carrying = scoreEngine('e', [withLines(4)], own, twin, turbo);
    expect(carrying.composite).toBeCloseTo(1, 12);
    expect(carrying.discrimination.others[0]?.composite).toBe(0);
    expect(carrying.discrimination.pass).toBe(true);
  });

  it('is n/a for a naturally aspirated engine, by aspiration or by its starter-garage record', () => {
    const own = [withLines(4), withLines(4)];
    const twin = { twin: [withLines(0), withLines(0)] };
    for (const s of [scoreEngine('e', [withLines(0)], own, twin, { aspiration: 'na' }), scoreEngine('v8-na-50', [withLines(0)], own, twin)]) {
      expect(s.renderVsRef.fiPresence).toBeNull();
      expect(s.refVsRef.fiPresence).toBeNull();
      expect(s.gate.fiPresence).toBe('n/a');
      expect(s.composite).toBeCloseTo(1, 12);
      expect(s.discrimination.others[0]?.composite).toBeCloseTo(1, 12);
    }
    expect(scoreEngine('i5-turbo-25', [withLines(0)], own, twin).renderVsRef.fiPresence).toBe(0);
  });

  it('compareOptionsFor: both forced-induction metrics follow the aspiration (D3, D8)', () => {
    expect(compareOptionsFor('na')).toEqual({ fiLine: false, fiPresence: false });
    expect(compareOptionsFor('turbo')).toEqual({ fiLine: true, fiPresence: true });
    expect(compareOptionsFor('supercharger')).toEqual({ fiLine: true, fiPresence: true });
  });
});

// ───────────────────────────── Fixture renders as pseudo-references ─────────────────────────────

describe('fixture renders as pseudo-references (Phase 2a DSP, cabin)', () => {
  const FS = 48000;
  /** Three engines of distinct character: turbo I5, NA cross-plane V8, turbo even-fire I4. */
  const IDS = ['i5-test', 'v8-crossplane-test', 'i4-test'] as const;
  /** The sweeps (render segment → clip kind). */
  const SWEEPS = [
    ['wotPull', 'wot'],
    ['liftoff6k', 'liftoff'],
  ] as const;
  /** Steady renders (render segment → clip kind): one rpm, so one 500 rpm bin — comparable since amendment D6. */
  const STEADY = [
    ['idle', 'idle'],
    ['cruise4k', 'cruise'],
  ] as const;
  const cache = new Map<string, ClipFeatures>();

  /**
   * ClipFeatures of a cabin render of `segName` (kind `kind`) with DSP seed `seed`: tools/render.ts renderSegment
   * with a free seed (Full tier, warm, hot, valve auto, subwoofer yes, 0.5 s pre-roll at the t = 0 control),
   * analysed on the left channel at the segment control's rpm (as the score CLI does for renders).
   */
  function features(def: EngineDef, segName: string, kind: string, seed: number): ClipFeatures {
    const key = `${def.id}|${segName}|${seed}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const seg = SEGMENTS.find((s) => s.name === segName);
    if (seg === undefined) throw new Error(`no segment ${segName}`);
    bindSegmentEngine(def.spec);
    const core = new TesboxDspCore(FS, seed);
    core.configure(def, { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 }, 'full');
    core.forceHot();
    const base = createBaseControl(def.spec, 'cabin');
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    const pre = Math.round((PREROLL_S * FS) / QUANTUM);
    seg.ctl(0, base);
    for (let q = 0; q < pre; q++) core.render(base, l, r, QUANTUM, ((q - pre) * QUANTUM) / FS);
    const n = Math.round(seg.durationS * FS);
    const left = new Float32Array(Math.ceil(n / QUANTUM) * QUANTUM);
    for (let q = 0; q * QUANTUM < n; q++) {
      const t = (q * QUANTUM) / FS;
      seg.ctl(t, base);
      base.runTimeS = 600 + t;
      core.render(base, l, r, QUANTUM, t);
      left.set(l, q * QUANTUM);
    }
    const probe = createBaseControl(def.spec, 'cabin');
    const rpmAt = (t: number): number => {
      seg.ctl(t, probe);
      return probe.rpm;
    };
    const step = def.spec.cycleDeg === 720 ? 0.5 : 1 / 3;
    const firingsPerRev = (def.spec.combustion.length * 360) / def.spec.cycleDeg;
    const c = clipFeatures(left.subarray(0, n), FS, rpmAt, step, kind, 'cabin', firingsPerRev);
    cache.set(key, c);
    return c;
  }

  /** Every sweep and steady render of `id` (all comparable since amendment D6), rendered with each of `seeds`. */
  function takes(id: string, seeds: readonly number[]): ClipFeatures[] {
    const def = loadFixture(id);
    return seeds.flatMap((seed) => [...SWEEPS, ...STEADY].map(([segName, kind]) => features(def, segName, kind, seed)));
  }

  const aspiration = (id: string): AspirationType => loadFixture(id).spec.aspiration.type;
  /** Seed 1 is "the render"; seeds 2 and 3 are the two "independent reference clips". */
  const RENDER = [1];
  const REFS = [2, 3];

  // Measured (2026-10-14, features with amendment D5, comparison with D6 and D8; seed 1 vs seed 2, cabin; fiLine and
  // fiPresence per the scored engine's aspiration, as scoreEngine does). Same engine: composite 0.758–0.928 per sweep;
  // orderProfile, tilt, centroid 0.897–0.970 (spectral shape barely depends on the seed); subOrder, irregularity and
  // overrun 0.42–0.97 (seeded combustion noise and crackle onsets differ between takes, and a 6 s liftoff holds few
  // crackles: i5-test's overrun similarity spans 0.32–0.77 across seed pairs); fiPresence 0.988–0.991 on the turbo
  // engines' wot (an FI line in 83–85 % of the frames of every take). Other engine: composite 0.223–0.772, at least
  // 0.156 below the same-engine pair of the sweep.
  it('a render matches a different-seed render of its own engine better than any other engine’s, on every sweep', { timeout: 180_000 }, () => {
    for (const [segName, kind] of SWEEPS) {
      for (const id of IDS) {
        const opts = compareOptionsFor(aspiration(id));
        const own = compareClips(features(loadFixture(id), segName, kind, 1), features(loadFixture(id), segName, kind, 2), opts);
        const label = `${id} ${segName}: ${JSON.stringify(own)}`;
        expect(own.commonBins, label).toBeGreaterThanOrEqual(8);
        expect(own.composite ?? 0, label).toBeGreaterThanOrEqual(0.7);
        for (const m of ['orderProfile', 'tilt', 'centroid'] as const) expect(own.metrics[m] ?? 0, `${label} → ${m}`).toBeGreaterThanOrEqual(0.85);
        if (kind === 'liftoff') expect(own.metrics.overrun, label).not.toBeNull();
        // D8: the turbo engines' wot takes carry their FI line about equally often; NA and liftoff pairs score no fiPresence.
        if (kind === 'wot' && aspiration(id) !== 'na') expect(own.metrics.fiPresence ?? 0, label).toBeGreaterThanOrEqual(0.85);
        else expect(own.metrics.fiPresence, label).toBeNull();
        for (const other of IDS.filter((o) => o !== id)) {
          const x = compareClips(features(loadFixture(id), segName, kind, 1), features(loadFixture(other), segName, kind, 2), opts);
          expect(x.composite ?? 1, `${label} vs ${other}: ${x.composite}`).toBeLessThan((own.composite ?? 0) - 0.1);
        }
      }
    }
  });

  // Measured (2026-10-14, seed 1 vs seed 2, cabin): same engine composite 0.986–0.993 at idle and 0.954–0.982 at
  // cruise4k; orderProfile, tilt and centroid ≥ 0.974; the turbo engines carry an FI line in every cruise4k frame
  // (fiPresence 1). Other engine: idle 0.341–0.348 (I5 vs I4; the V8 shares no bin), cruise4k 0.000–0.674 — the turbo
  // engines score 0 against the V8 there (fiPresence 0: p = 1 vs 0) — at least 0.280 below the same-engine pair.
  it('D6: a steady render (one 500 rpm bin) matches a different-seed render of its own engine better than any other engine’s sharing its bin', { timeout: 180_000 }, () => {
    for (const [segName, kind] of STEADY) {
      for (const id of IDS) {
        const opts = compareOptionsFor(aspiration(id));
        const own = compareClips(features(loadFixture(id), segName, kind, 1), features(loadFixture(id), segName, kind, 2), opts);
        const label = `${id} ${segName}: ${JSON.stringify(own)}`;
        expect(own.commonBins, label).toBe(1);
        expect(own.composite ?? 0, label).toBeGreaterThanOrEqual(0.9);
        for (const m of ['orderProfile', 'tilt', 'centroid'] as const) expect(own.metrics[m] ?? 0, `${label} → ${m}`).toBeGreaterThanOrEqual(0.9);
        if (kind === 'cruise' && aspiration(id) !== 'na') expect(own.metrics.fiPresence ?? 0, label).toBeGreaterThanOrEqual(0.9);
        else expect(own.metrics.fiPresence, label).toBeNull();
        for (const other of IDS.filter((o) => o !== id)) {
          const x = compareClips(features(loadFixture(id), segName, kind, 1), features(loadFixture(other), segName, kind, 2), opts);
          const xLabel = `${label} vs ${other}: ${JSON.stringify(x)}`;
          // The V8 idles at 650 rpm (the 500 rpm bin), the I5 and the I4 at 850 and 750 rpm (the 1000 rpm bin).
          if (kind === 'idle' && (id === 'v8-crossplane-test' || other === 'v8-crossplane-test')) {
            expect(x.commonBins, xLabel).toBe(0);
            expect(x.composite, xLabel).toBeNull();
            continue;
          }
          expect(x.commonBins, xLabel).toBe(1);
          expect(x.composite ?? 1, xLabel).toBeLessThan((own.composite ?? 0) - 0.2);
        }
      }
    }
  });

  // Measured (2026-10-14, with D5, D6 and D8; sweeps and steady renders): own composite 0.887 / 0.938 / 0.948 (i5 /
  // V8 / i4), best other 0.518 / 0.615 / 0.548; every renderVsRef / refVsRef ratio ≥ 0.951 (the gate needs 0.8). The
  // turbo engines' wot and cruise renders carry an FI line (fiLine ≈ 0.99, fiPresence ≈ 0.997 render vs ref); the NA
  // V8's line-like harmonics (an FI "line" in 15–21 % of its wot frames) stay out of its score (fiLine and fiPresence
  // 'n/a', D3 and D8).
  it('every engine passes discrimination against the others’ pseudo-refs, and no metric gate fails', { timeout: 180_000 }, () => {
    for (const id of IDS) {
      const otherRefs = Object.fromEntries(IDS.filter((o) => o !== id).map((o) => [o, takes(o, REFS)]));
      const s = scoreEngine(id, takes(id, RENDER), takes(id, REFS), otherRefs, { aspiration: aspiration(id) });
      const label = `${id}: own ${s.discrimination.ownComposite} others ${JSON.stringify(s.discrimination.others)}`;
      expect(s.unscored, label).toBe(false);
      expect(s.composite ?? 0, label).toBeGreaterThanOrEqual(0.85);
      expect(s.discrimination.ownComposite, label).toBe(s.composite);
      expect(s.discrimination.others.map((o) => o.engineId), label).toEqual(IDS.filter((o) => o !== id).sort());
      expect(s.discrimination.pass, label).toBe(true);
      for (const o of s.discrimination.others) expect(o.composite ?? 1, label).toBeLessThan((s.composite ?? 0) - 0.15);
      for (const m of METRIC_NAMES) expect(s.gate[m], `${label} gate ${m}`).not.toBe('fail');
      for (const m of ['orderProfile', 'tilt', 'centroid', 'subOrder', 'irregularity', 'overrun'] as const) {
        expect(s.gate[m], `${label} gate ${m}`).toBe('pass');
      }
      if (aspiration(id) === 'na') {
        expect(s.gate.fiLine, label).toBe('n/a');
        expect(s.gate.fiPresence, label).toBe('n/a'); // D8
      } else {
        expect(s.gate.fiPresence, label).toBe('pass'); // D8, from the wot pairs
      }
    }
  });

  it('a render of the wrong engine fails discrimination against the right engine’s pseudo-refs', { timeout: 180_000 }, () => {
    for (const id of IDS) {
      for (const impostor of IDS.filter((o) => o !== id)) {
        const otherRefs = Object.fromEntries(IDS.filter((o) => o !== id).map((o) => [o, takes(o, REFS)]));
        const s = scoreEngine(id, takes(impostor, RENDER), takes(id, REFS), otherRefs, { aspiration: aspiration(id) });
        expect(s.discrimination.pass, `${impostor} rendered as ${id}: ${JSON.stringify(s.discrimination)}`).toBe(false);
      }
    }
  });
});
