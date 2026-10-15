/**
 * tesbox-score (phase 2b contract "Score CLI (T5)" + amendments D3/D4). The reference library here is a temporary
 * lab-refs directory built from fixture-engine renders with known rpm — never real recordings.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineDef, Perspective } from '../../src/contracts';
import { PLOT_COLORS, orderPlotBin, orderPlotLayout, textMask } from '../../tools/png';
import { renderSegment } from '../../tools/render';
import { SEGMENTS, bindSegmentEngine, createBaseControl } from '../../tools/segments';
import { compositeScore, type PairScore } from '../../src/lab/compare';
import type { ClipFeatures, FrameFeatures } from '../../src/lab/features';
import type { RpmTrack } from '../../src/lab/pitch';
import {
  DEFAULT_OUT,
  DEFAULT_REFS,
  EXIT_ERROR,
  EXIT_GATE_FAILED,
  EXIT_USAGE,
  MIN_TRACK_CONFIDENCE,
  RENDER_PLAN,
  USAGE,
  confidentTrack,
  exitCodeFor,
  hintHalfWidth,
  keyframeRpm,
  lensOf,
  loadRefClips,
  main,
  orderSeries,
  parseArgs,
  renderTimeline,
  reportMarkdown,
  validateSegment,
  verdictOf,
  type RefClip,
  type RenderedClip,
  type ScoreReport,
} from '../../tools/score';
import { writeWav } from '../../tools/wav';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tesbox-score-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Same names and order as src/lab/compare.ts METRIC_NAMES (fiPresence added by amendment D8).
const METRICS = ['orderProfile', 'tilt', 'centroid', 'subOrder', 'irregularity', 'fiLine', 'overrun', 'fiPresence'] as const;

/** Deterministic uniform noise in ±amplitude/2 (a 32-bit LCG). */
function lcgNoise(n: number, seed: number, amplitude: number): Float32Array {
  const x = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    x[i] = (s / 2 ** 32 - 0.5) * amplitude;
  }
  return x;
}

function quiet<T>(fn: () => T): T {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    return fn();
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

function planOf(name: string): (typeof RENDER_PLAN)[number] {
  const p = RENDER_PLAN.find((e) => e.segment === name);
  if (p === undefined) throw new Error(`no render plan entry ${name}`);
  return p;
}

function segmentNamed(name: string): (typeof SEGMENTS)[number] {
  const s = SEGMENTS.find((e) => e.name === name);
  if (s === undefined) throw new Error(`no segment ${name}`);
  return s;
}

// ───────────────────────────── argument parsing ─────────────────────────────

describe('tesbox-score argument parsing', () => {
  it('applies the contract defaults', () => {
    expect(DEFAULT_REFS).toBe('lab-refs');
    expect(DEFAULT_OUT).toBe('renders/score');
    expect(parseArgs(['i5-turbo-25'])).toEqual({ engine: 'i5-turbo-25', refsDir: 'lab-refs', outDir: 'renders/score', gate: false });
  });

  it('parses every option in any order', () => {
    expect(parseArgs(['--gate', '--out', 'x/y', 'v8-na-50', '--refs', 'r'])).toEqual({
      engine: 'v8-na-50',
      refsDir: 'r',
      outDir: 'x/y',
      gate: true,
    });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs([])).toThrow(/missing/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected/);
    expect(() => parseArgs(['a', '--refs'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--out', '--gate'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--loud'])).toThrow(/unknown option/);
  });

  it('main() returns 2 with the usage on bad arguments', () => {
    expect([EXIT_GATE_FAILED, EXIT_USAGE, EXIT_ERROR]).toEqual([1, 2, 3]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['--nope'])).toBe(2);
      expect(main(['no-such-engine', '--refs', join(dir, 'none'), '--out', join(dir, 'none-out')])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(USAGE));
    } finally {
      err.mockRestore();
    }
  });

  it('main() returns 3 when the run itself fails, never the gate code 1', () => {
    const blocker = join(dir, 'a-file-not-a-directory');
    writeFileSync(blocker, 'the output directory cannot be created below a file');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(quiet(() => main(['i6-test', '--refs', join(dir, 'none'), '--out', blocker, '--gate']))).toBe(3);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^tesbox-score: scoring i6-test failed/));
    } finally {
      err.mockRestore();
    }
  });

  it('is wired as the npm script `score`', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.score).toBe('tsx tools/score.ts');
  });
});

// ───────────────────────────── sidecar segments (amendment D4) ─────────────────────────────

describe('reference segment validation', () => {
  const ok = (raw: unknown, durationS = 60): Exclude<ReturnType<typeof validateSegment>, string> => {
    const v = validateSegment(raw, durationS);
    if (typeof v === 'string') throw new Error(`unexpectedly rejected: ${v}`);
    return v;
  };

  it('accepts explicit keyframes and ignores a hint next to them', () => {
    const s = ok({ kind: 'liftoff', startS: 20, endS: 24, rpm: [[0, 6200], [3.5, 2600]], rpmHint: [1, 2] });
    expect(s).toEqual({ kind: 'liftoff', startS: 20, endS: 24, rpm: [[0, 6200], [3.5, 2600]], rpmHint: null });
  });

  it('measures a hint as ± around its centre', () => {
    expect(hintHalfWidth([850, 1150])).toBeCloseTo(0.15, 12);
    expect(hintHalfWidth([930, 1070])).toBeCloseTo(0.07, 12);
  });

  it('D4.1: steady kinds with "auto" rpm need a hint no wider than ±15 %', () => {
    for (const kind of ['idle', 'cruise', 'limiter']) {
      expect(ok({ kind, startS: 1, endS: 5, rpm: 'auto', rpmHint: [930, 1070] }).rpmHint).toEqual([930, 1070]);
      expect(ok({ kind, startS: 1, endS: 5, rpm: 'auto', rpmHint: [850, 1150] }).rpm).toBe('auto'); // exactly ±15 %
      const wide = validateSegment({ kind, startS: 1, endS: 5, rpm: 'auto', rpmHint: [700, 1100] }, 60);
      expect(wide).toMatch(/±22\.2 %/);
      expect(wide).toMatch(/±15 %/);
      expect(wide).toMatch(/D4/);
      expect(validateSegment({ kind, startS: 1, endS: 5, rpm: 'auto' }, 60)).toMatch(/needs an rpmHint/);
    }
  });

  it('D4.2: sweeps with "auto" rpm need a [low, high] range hint of any width', () => {
    for (const kind of ['wot', 'liftoff']) {
      expect(ok({ kind, startS: 1, endS: 9, rpm: 'auto', rpmHint: [2500, 7000] }).rpmHint).toEqual([2500, 7000]);
      expect(validateSegment({ kind, startS: 1, endS: 9, rpm: 'auto' }, 60)).toMatch(/needs an rpmHint/);
      expect(validateSegment({ kind, startS: 1, endS: 9, rpm: 'auto', rpmHint: [7000, 2500] }, 60)).toMatch(/rpmHint/);
      expect(validateSegment({ kind, startS: 1, endS: 9, rpm: 'auto', rpmHint: [0, 7000] }, 60)).toMatch(/rpmHint/);
    }
  });

  it('rejects malformed segments with a reason', () => {
    const base = { kind: 'wot', startS: 1, endS: 5, rpm: [[0, 3000], [4, 6000]] };
    expect(validateSegment(null, 60)).toMatch(/not an object/);
    expect(validateSegment({ ...base, kind: 'drift' }, 60)).toMatch(/kind/);
    expect(validateSegment({ ...base, startS: 5 }, 60)).toMatch(/startS < endS/);
    expect(validateSegment({ ...base, startS: -1 }, 60)).toMatch(/outside/);
    expect(validateSegment({ ...base, endS: 61 }, 60)).toMatch(/outside/);
    expect(validateSegment({ ...base, rpm: 'tracked' }, 60)).toMatch(/rpm/);
    expect(validateSegment({ ...base, rpm: [] }, 60)).toMatch(/keyframe/);
    expect(validateSegment({ ...base, rpm: [[0, 3000], [0, 4000]] }, 60)).toMatch(/increasing/);
    expect(validateSegment({ ...base, rpm: [[0, 3000], [1, -5]] }, 60)).toMatch(/keyframe/);
    expect(validateSegment({ ...base, rpm: [[0, 3000, 1]] }, 60)).toMatch(/keyframe/);
  });

  it('interpolates keyframes linearly and never extrapolates', () => {
    const kf: [number, number][] = [
      [0, 6200],
      [3.5, 2600],
    ];
    expect(keyframeRpm(kf, 0)).toBe(6200);
    expect(keyframeRpm(kf, 1.75)).toBeCloseTo(4400, 9);
    expect(keyframeRpm(kf, 3.5)).toBe(2600);
    expect(keyframeRpm(kf, 3.6)).toBeNaN();
    expect(keyframeRpm(kf, -0.1)).toBeNaN();
    expect(keyframeRpm([[0, 2000]], 3)).toBe(2000); // one keyframe: constant
  });
});

describe('tracked rpm a segment may use (amendment D4(3)/(4))', () => {
  it('keeps voiced frames with confidence ≥ MIN_TRACK_CONFIDENCE and skips unvoiced and low-confidence ones', () => {
    expect(MIN_TRACK_CONFIDENCE).toBe(0.5);
    const track: RpmTrack = {
      hopS: 0.02,
      t: Float64Array.from([0.06, 0.08, 0.1, 0.12, 0.14, 0.16]),
      rpm: Float64Array.from([3000, Number.NaN, 3020, 3030, 3040, 3050]),
      confidence: Float64Array.from([1, 0, 0.49, 0.5, 0.8, Number.NaN]),
    };
    const c = confidentTrack(track);
    expect(Array.from(c.track.rpm)).toEqual([3000, Number.NaN, Number.NaN, 3030, 3040, Number.NaN]);
    expect(c.voiced).toBe(5);
    expect(c.confident).toBe(3);
    expect(c.track.hopS).toBe(track.hopS);
    expect(Array.from(c.track.t)).toEqual(Array.from(track.t));
    // the tracker's own result is left as it was
    expect(Array.from(track.rpm)).toEqual([3000, Number.NaN, 3020, 3030, 3040, 3050]);
  });
});

// ───────────────────────────── reference library loading ─────────────────────────────

describe('reference library loading', () => {
  const engineDir = join(dir, 'small-lib', 'some-engine');
  const i5 = loadFixture('i5-test').spec;
  const lens = lensOf(i5);
  const side = (clipId: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ clipId, perspective: 'cabin', segments: [{ kind: 'wot', startS: 0, endS: 1, rpm: 'auto', rpmHint: [3000, 6000] }], ...extra });

  beforeAll(() => {
    mkdirSync(engineDir, { recursive: true });
    const noise = lcgNoise(FS, 12345, 0.1);
    for (const id of ['n1', 'roof', 'mismatch']) writeWav(join(engineDir, `${id}.wav`), [noise], FS);
    writeFileSync(join(engineDir, 'n1.json'), side('n1'));
    writeFileSync(join(engineDir, 'roof.json'), side('roof', { perspective: 'roof' }));
    writeFileSync(join(engineDir, 'mismatch.json'), side('other'));
    writeFileSync(join(engineDir, 'no-wav.json'), side('no-wav'));
    writeFileSync(join(engineDir, 'corrupt.json'), side('corrupt'));
    writeFileSync(join(engineDir, 'corrupt.wav'), 'not a wav file');
    writeFileSync(join(engineDir, 'broken.json'), '{ not json');
  });

  it('rejects unusable clips with a reason that names no host path', () => {
    const clips = loadRefClips(engineDir, null, lens);
    const byId = new Map(clips.map((c) => [c.report.clipId, c.report]));
    expect([...byId.keys()]).toEqual(['broken', 'corrupt', 'mismatch', 'n1', 'no-wav', 'roof']);
    for (const c of clips) {
      expect(c.report.status, c.report.clipId).toBe('rejected');
      expect(c.features).toEqual([]);
      expect(JSON.stringify(c.report)).not.toContain(dir);
    }
    expect(byId.get('broken')?.reason).toMatch(/unreadable sidecar/);
    expect(byId.get('corrupt')?.reason).toMatch(/corrupt\.wav/);
    expect(byId.get('mismatch')?.reason).toMatch(/does not match/);
    expect(byId.get('no-wav')?.reason).toMatch(/missing no-wav\.wav/);
    expect(byId.get('roof')?.reason).toMatch(/perspective/);
    // "auto" rpm of a library directory with no engine definition cannot be tracked
    expect(byId.get('n1')?.reason).toBe('no usable segment');
    expect(byId.get('n1')?.segments[0]?.reason).toMatch(/no engine definition/);
  });

  it('skips clips of other perspectives when asked (other engines are only loaded where renders exist)', () => {
    const ids = loadRefClips(engineDir, null, lens, { perspectives: ['outside'] }).map((c) => c.report.clipId);
    expect(ids).toEqual(['broken', 'mismatch', 'roof']); // rejected before their perspective is known
    expect(loadRefClips(join(dir, 'small-lib', 'missing'), null, lens)).toEqual([]);
  });

  it('D4(4): rejects an "auto" segment without a single confidently tracked frame (pure noise)', () => {
    const n1 = loadRefClips(engineDir, i5, lens).find((c) => c.report.clipId === 'n1');
    expect(n1?.report.status).toBe('rejected');
    expect(n1?.features).toEqual([]);
    const seg = n1?.report.segments[0];
    expect(seg?.status).toBe('rejected');
    expect(seg?.rpm).toBe('auto');
    expect(seg?.voicedShare).toBe(0);
    expect(seg?.confidentShare).toBe(0);
    expect(seg?.reason).toMatch(/no 0\.25 s frame with a confidently tracked rpm/);
  });

  it('rejects a segment holding a non-finite sample and keeps the clip’s other segments', () => {
    const nanDir = join(dir, 'small-lib', 'nan-engine');
    mkdirSync(nanDir, { recursive: true });
    const x = lcgNoise(2 * FS, 99, 0.1);
    x[Math.round(0.5 * FS)] = Number.NaN; // a corrupt 32-bit float reference (the contract allows float WAVs)
    writeWav(join(nanDir, 'nan.wav'), [x], FS);
    writeFileSync(
      join(nanDir, 'nan.json'),
      JSON.stringify({
        clipId: 'nan',
        perspective: 'cabin',
        segments: [
          { kind: 'wot', startS: 0, endS: 1, rpm: [[0, 3000], [1, 4000]] },
          { kind: 'liftoff', startS: 1, endS: 2, rpm: [[0, 4000], [1, 3000]] },
          { kind: 'wot', startS: 0.25, endS: 0.75, rpm: 'auto', rpmHint: [3000, 6000] },
        ],
      }),
    );
    let clips: RefClip[] = [];
    expect(() => (clips = loadRefClips(nanDir, i5, lens, { plotDir: nanDir }))).not.toThrow();
    const c = clips[0];
    expect(c?.report.status).toBe('used');
    expect(c?.report.segments.map((s) => s.status)).toEqual(['rejected', 'used', 'rejected']);
    for (const s of [c?.report.segments[0], c?.report.segments[2]]) {
      expect(s?.reason).toMatch(/non-finite sample \(NaN\) at 0\.5000 s of nan\.wav/);
      expect(s?.plot).toBeNull();
    }
    expect(c?.features.map((f) => f.kind)).toEqual(['liftoff']);
    expect(JSON.stringify(c?.report)).not.toContain(dir);
  });
});

describe('order plot series', () => {
  const frame = (rpm: number): FrameFeatures => ({
    rpm,
    orderAmp: new Float64Array(24).fill(1),
    centroidHz: 1000,
    tiltDbPerOct: -3,
    subOrderDb: -10,
    irregularity: 0.1,
    fiLineHz: null,
    levelDb: -20,
  });
  const clip = (kind: string, perspective: Perspective, rpms: number[]): ClipFeatures => ({
    kind,
    perspective,
    frames: rpms.map(frame),
    overrunRate: null,
  });
  const render = (segment: string, f: ClipFeatures): RenderedClip => ({
    report: {
      perspective: f.perspective,
      segment,
      kind: f.kind as RenderedClip['report']['kind'],
      durationS: 1,
      spanS: [0, 1],
      frames: f.frames.length,
      nonFiniteResets: 0,
      plot: null,
    },
    features: f,
  });
  const ref = (clipId: string, perspective: Perspective, features: ClipFeatures[]): RefClip => ({
    report: { clipId, perspective, fs: FS, durationS: 1, status: 'used', reason: null, segments: [] },
    features,
  });

  it('draws one curve per clip and kind in the D7 bin, those with frames there first, render before references', () => {
    // Cabin render frames per 500 rpm bin: 2000 → 3 (cruise), 3000 → 3 (wot 2800 and 3100, liftoff 3000), 4500 → 3
    // (wot); cabin reference frames: 3000 → 2 (liftoff), 4500 → 3 (wot), 6000 → 1. Frames common to both (the smaller
    // count): 3000 → 2, 4500 → 3, so the plot shows 4250–4750 rpm (amendment D7), not a fixed 3000 rpm bin.
    const renders = [
      render('cruise2k', clip('cruise', 'cabin', [2000, 2000, 2000])),
      render('wotPull', clip('wot', 'cabin', [2800, 3100, 4400, 4600, 4700])),
      render('liftoff6k', clip('liftoff', 'cabin', [3000])),
      render('wotPull', clip('wot', 'outside', [4500])),
    ];
    const refs = [
      ref('r1', 'cabin', [clip('wot', 'cabin', [4300, 4500, 4600, 6000]), clip('liftoff', 'cabin', [2900, 3200])]),
      ref('r2', 'outside', [clip('wot', 'outside', [4500])]),
    ];
    const series = orderSeries('cabin', renders, refs, 0.5);
    expect(orderPlotBin(series)).toEqual({ rpm: 4500, lo: 4250, hi: 4750, renderFrames: 3, referenceFrames: 3, commonFrames: 3, frames: 6 });
    // the kind leads each label, so the legend's middle elision keeps the clip's distinguishing end
    expect(series.map((s) => s.label)).toEqual(['wot render', 'wot r1', 'cruise render', 'liftoff render', 'liftoff r1']);
    expect(series.map((s) => [s.kind, s.clipId, s.role, s.binFrames])).toEqual([
      ['wot', null, 'render', 3],
      ['wot', 'r1', 'reference', 3],
      ['cruise', null, 'render', 0],
      ['liftoff', null, 'render', 0],
      ['liftoff', 'r1', 'reference', 0],
    ]);
    expect(Array.from(series[0]?.rpm ?? [])).toEqual([2800, 3100, 4400, 4600, 4700]);
    // no bin holds both: the bin with the most frames (the render's 2000 rpm cruise); every series stays
    const apart = orderSeries('cabin', renders.slice(0, 1), [ref('r1', 'cabin', [clip('wot', 'cabin', [6000])])], 0.5);
    expect(apart.map((s) => [s.label, s.binFrames])).toEqual([
      ['cruise render', 3],
      ['wot r1', 0],
    ]);
    expect(orderPlotBin(apart)).toMatchObject({ rpm: 2000, renderFrames: 3, referenceFrames: 0, commonFrames: 0 });
  });
});

describe('report.md', () => {
  const nulls = Object.fromEntries(METRICS.map((m) => [m, null])) as Record<(typeof METRICS)[number], number | null>;
  type OrderPlot = ScoreReport['orderPlots'][number];
  const report = (
    series: OrderPlot['series'],
    rpmBin: OrderPlot['rpmBin'] = [4250, 4750],
    frames: OrderPlot['frames'] = { render: 12, reference: 3, common: 3 },
  ): ScoreReport => ({
    engineId: 'x-test',
    name: 'X',
    inspiredBy: 'a car',
    aspiration: 'na',
    lens: { step: 0.5, firingsPerRev: 2 },
    refClips: 2,
    score: {
      engineId: 'x-test',
      renderVsRef: nulls,
      refVsRef: nulls,
      gate: Object.fromEntries(METRICS.map((m) => [m, 'n/a'])) as ScoreReport['score']['gate'],
      composite: null,
      discrimination: { ownComposite: null, others: [], pass: null },
      unscored: false,
    },
    verdict: { unscored: false, passed: [], failed: [], discrimination: null, pass: true },
    refs: [],
    otherRefs: [],
    renders: [],
    pairs: { renderVsRef: [], refVsRef: [], renderVsOther: [] },
    plots: ['orders-cabin.png'],
    orderPlots: [{ file: 'orders-cabin.png', perspective: 'cabin', rpmBin, frames, series }],
  });

  it('names the D7 bin with its render and reference frames and lists every order-plot series', () => {
    const md = reportMarkdown(
      report([
        { label: 'wot render', kind: 'wot', clipId: null, frames: 12, drawn: true },
        { label: 'wot clip-onboard-a', kind: 'wot', clipId: 'clip-onboard-a', frames: 3, drawn: true },
        { label: 'liftoff clip-onboard-a', kind: 'liftoff', clipId: 'clip-onboard-a', frames: 0, drawn: true },
        { label: 'idle clip-onboard-b', kind: 'idle', clipId: 'clip-onboard-b', frames: 0, drawn: false },
      ]),
    );
    expect(md).toContain('4250–4750 rpm bin');
    expect(md).toContain('most frames common to the render and the references');
    expect(md).toContain('12 render and 3 reference frames there, 3 in common');
    expect(md).toMatch(/D7/);
    expect(md).not.toMatch(/2750–3250|fixed by the order-plot contract/);
    expect(md).toMatch(/\| wot render \| 12 \| curve \|/);
    expect(md).toMatch(/\| wot clip-onboard-a \| 3 \| curve \|/);
    expect(md).toMatch(/\| liftoff clip-onboard-a \| 0 \| legend only \|/);
    expect(md).toMatch(/\| idle clip-onboard-b \| 0 \| not drawn/);
    expect(md).not.toMatch(/no common bin|no reference curve/i);
  });

  it('flags an order plot whose bin is the fallback (no bin holds both render and reference frames)', () => {
    const md = reportMarkdown(
      report(
        [
          { label: 'cruise render', kind: 'cruise', clipId: null, frames: 30, drawn: true },
          { label: 'wot clip-onboard-a', kind: 'wot', clipId: 'clip-onboard-a', frames: 0, drawn: true },
        ],
        [1750, 2250],
        { render: 30, reference: 0, common: 0 },
      ),
    );
    expect(md).toContain('1750–2250 rpm bin');
    expect(md).toMatch(/\*\*No common bin\*\*/);
    expect(md).toContain('30 render and 0 reference frames');
    const none = reportMarkdown(report([{ label: 'wot render', kind: 'wot', clipId: null, frames: 0, drawn: true }], null, { render: 0, reference: 0, common: 0 }));
    expect(none).toMatch(/no series of this perspective has a frame/i);
  });
});

// ───────────────────────────── renders with known rpm ─────────────────────────────

describe('render timeline (known rpm)', () => {
  const def = loadFixture('i5-test');

  it('renders the six contract segments, mapped to reference kinds', () => {
    expect(RENDER_PLAN.map((p) => [p.segment, p.kind])).toEqual([
      ['idle', 'idle'],
      ['cruise2k', 'cruise'],
      ['cruise4k', 'cruise'],
      ['cruise6k', 'cruise'],
      ['wotPull', 'wot'],
      ['liftoff6k', 'liftoff'],
    ]);
  });

  it('wotPull: the DSP rpm per sample, gear changes and the limiter hold left out', () => {
    const seg = segmentNamed('wotPull');
    const frames = Math.round(seg.durationS * FS);
    const tl = renderTimeline(def.spec, seg, planOf('wotPull'), 'cabin', frames, FS);
    expect(tl.rpm.length).toBe(frames);
    expect(tl.scored.length).toBe(frames);
    bindSegmentEngine(def.spec);
    const base = createBaseControl(def.spec, 'cabin');
    let shiftQuanta = 0;
    let limiterQuanta = 0;
    for (let q = 0; q * 128 < frames; q++) {
      seg.ctl((q * 128) / FS, base);
      const k = q * 128;
      if (base.shift.active) {
        shiftQuanta++;
        expect(tl.scored[k], `quantum ${q} in a shift`).toBe(0);
      } else if (base.limiter) {
        limiterQuanta++;
        expect(tl.scored[k], `quantum ${q} on the limiter`).toBe(0);
      }
    }
    expect(shiftQuanta).toBeGreaterThan(0);
    expect(limiterQuanta).toBeGreaterThan(0);
    // Mid-climb in gear 1 the DSP lags the control ramp by its 40 ms tracking time constant.
    const k = Math.round(1.0 * FS);
    seg.ctl(1.0, base);
    const control = base.rpm;
    seg.ctl(1.0 - 0.04, base);
    expect(tl.scored[k]).toBe(1);
    expect(tl.rpm[k] ?? Number.NaN).toBeLessThan(control);
    expect(Math.abs((tl.rpm[k] ?? Number.NaN) - base.rpm) / base.rpm).toBeLessThan(0.005);
  });

  it('liftoff6k: only the closed-throttle fall in gear is scored', () => {
    const seg = segmentNamed('liftoff6k');
    const frames = Math.round(seg.durationS * FS);
    const tl = renderTimeline(def.spec, seg, planOf('liftoff6k'), 'cabin', frames, FS);
    const first = tl.scored.indexOf(1);
    const last = tl.scored.lastIndexOf(1);
    expect(Math.abs(first / FS - 0.5)).toBeLessThanOrEqual(128 / FS);
    expect(Math.abs((last + 1) / FS - 5.0)).toBeLessThanOrEqual(128 / FS);
    for (let k = first; k <= last; k++) if (tl.scored[k] !== 1) throw new Error(`hole at ${k}`);
  });

  it('steady segments sit exactly on the control rpm', () => {
    const seg = segmentNamed('cruise4k');
    const frames = Math.round(seg.durationS * FS);
    const tl = renderTimeline(def.spec, seg, planOf('cruise4k'), 'outside', frames, FS);
    expect(tl.scored.every((v) => v === 1)).toBe(true);
    expect(tl.rpm.reduce((m, r) => Math.max(m, Math.abs(r - 4000)), 0)).toBeLessThan(1e-6);
  });
});

// ───────────────────────────── verdict / exit code ─────────────────────────────

describe('gate verdict', () => {
  type Gate = 'pass' | 'fail' | 'n/a';
  function score(gates: Partial<Record<(typeof METRICS)[number], Gate>>, discrimination: boolean | null, unscored = false) {
    const gate = Object.fromEntries(METRICS.map((m) => [m, gates[m] ?? 'n/a'])) as Record<(typeof METRICS)[number], Gate>;
    const values = Object.fromEntries(METRICS.map((m) => [m, null])) as Record<(typeof METRICS)[number], number | null>;
    return {
      engineId: 'x',
      renderVsRef: values,
      refVsRef: values,
      gate,
      composite: null,
      discrimination: { ownComposite: null, others: [], pass: discrimination },
      unscored,
    };
  }

  it('passes when every evaluated gate passes and discrimination does not fail', () => {
    const v = verdictOf(score({ orderProfile: 'pass', tilt: 'pass' }, true), 2);
    expect(v).toEqual({ unscored: false, passed: ['orderProfile', 'tilt'], failed: [], discrimination: true, pass: true });
    expect(exitCodeFor(v, true)).toBe(0);
    expect(verdictOf(score({ tilt: 'pass' }, null), 3).pass).toBe(true);
  });

  it('fails on any failed metric gate or failed discrimination, but only exits 1 with --gate', () => {
    const g = verdictOf(score({ orderProfile: 'pass', subOrder: 'fail' }, true), 2);
    expect(g.failed).toEqual(['subOrder']);
    expect(g.pass).toBe(false);
    expect(exitCodeFor(g, true)).toBe(1);
    expect(exitCodeFor(g, false)).toBe(0);
    const d = verdictOf(score({ orderProfile: 'pass' }, false), 2);
    expect(d.pass).toBe(false);
    expect(exitCodeFor(d, true)).toBe(1);
  });

  it('unscored engines (fewer than 2 reference clips, spec §11.3) never fail', () => {
    const one = verdictOf(score({ orderProfile: 'fail' }, false), 1);
    expect(one.unscored).toBe(true);
    expect(one.pass).toBe(true);
    expect(exitCodeFor(one, true)).toBe(0);
    expect(verdictOf(score({ orderProfile: 'fail' }, false, true), 5).unscored).toBe(true);
    expect(exitCodeFor(verdictOf(score({}, null, true), 0), true)).toBe(0);
  });
});

// ───────────────────────────── end to end on a fixture library ─────────────────────────────

/** Mono (L + R)/2 render of a fixture segment. */
function renderMono(def: EngineDef, name: string, perspective: Perspective = 'cabin'): Float32Array {
  const { left, right } = renderSegment(def, segmentNamed(name), { perspective, subwoofer: 'yes', fs: FS });
  const m = new Float32Array(left.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * ((left[i] ?? 0) + (right[i] ?? 0));
  return m;
}

/** Longest run [a, b) of scored samples of a render segment, with keyframes every 0.05 s from the DSP rpm. */
function knownSpan(def: EngineDef, name: string): { from: number; to: number; rpm: [number, number][] } {
  const seg = segmentNamed(name);
  const frames = Math.round(seg.durationS * FS);
  const tl = renderTimeline(def.spec, seg, planOf(name), 'cabin', frames, FS);
  let best: [number, number] = [0, 0];
  for (let a = 0; a < frames; ) {
    if (tl.scored[a] !== 1) {
      a++;
      continue;
    }
    let b = a;
    while (b < frames && tl.scored[b] === 1) b++;
    if (b - a > best[1] - best[0]) best = [a, b];
    a = b;
  }
  const [a, b] = best;
  const rpm: [number, number][] = [];
  const step = Math.round(0.05 * FS);
  for (let k = a; k < b - 1; k += step) rpm.push([(k - a) / FS, tl.rpm[k] ?? Number.NaN]);
  rpm.push([(b - 1 - a) / FS, tl.rpm[b - 1] ?? Number.NaN]);
  return { from: a / FS, to: b / FS, rpm };
}

interface PartSegment {
  kind: string;
  from: number;
  to: number;
  rpm: 'auto' | [number, number][];
  rpmHint?: [number, number];
}

/** A keyframed span cut at its middle into two segments of one kind: two segments of one recording. */
function splitSpan(kind: string, s: { from: number; to: number; rpm: [number, number][] }): PartSegment[] {
  const at = (s.to - s.from) / 2;
  const mid = keyframeRpm(s.rpm, at);
  return [
    { kind, from: s.from, to: s.from + at, rpm: [...s.rpm.filter(([t]) => t < at), [at, mid]] },
    { kind, from: s.from + at, to: s.to, rpm: [[0, mid], ...s.rpm.filter(([t]) => t > at).map(([t, r]): [number, number] => [t - at, r])] },
  ];
}

/** Writes <dir>/<clipId>.wav (parts back to back, 32-bit float mono) and its sidecar. */
function writeClip(engineDir: string, clipId: string, perspective: Perspective, parts: { audio: Float32Array; segments: PartSegment[] }[]): void {
  mkdirSync(engineDir, { recursive: true });
  const total = parts.reduce((s, p) => s + p.audio.length, 0);
  const audio = new Float32Array(total);
  const segments: Record<string, unknown>[] = [];
  let off = 0;
  for (const p of parts) {
    audio.set(p.audio, off);
    for (const s of p.segments) {
      segments.push({
        kind: s.kind,
        startS: off / FS + s.from,
        endS: off / FS + s.to,
        rpm: s.rpm,
        ...(s.rpmHint ? { rpmHint: s.rpmHint } : {}),
      });
    }
    off += p.audio.length;
  }
  writeWav(join(engineDir, `${clipId}.wav`), [audio], FS);
  writeFileSync(
    join(engineDir, `${clipId}.json`),
    JSON.stringify({ clipId, source: 'fixture render', title: clipId, car: 'fixture', perspective, segments, notes: 'test' }, null, 2),
  );
}

/** A deliberately different voicing of the same spec (a "second car" of the same family). */
function detuned(def: EngineDef): EngineDef {
  def.voicing.pulse.widthDeg = 75;
  def.voicing.pulse.alpha = 5;
  def.voicing.exhaust.midPipeM *= 1.4;
  def.voicing.cabin.lowpassHz = Math.min(1200, def.voicing.cabin.lowpassHz * 1.3);
  return def;
}

function readReport(outDir: string, id: string): ScoreReport {
  return JSON.parse(readFileSync(join(outDir, id, 'report.json'), 'utf8')) as ScoreReport;
}

function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(b.toString('ascii', 12, 16)).toBe('IHDR');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

interface Pixels {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Pixels of a PNG written by tools/png.ts encodePng (8-bit RGBA; every scanline filter type 0). */
function pngPixels(path: string): Pixels {
  const b = readFileSync(path);
  const [width, height] = pngSize(path);
  const idat: Buffer[] = [];
  for (let off = 8; off < b.length; ) {
    const len = b.readUInt32BE(off);
    if (b.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgba };
}

/** Mismatches between `text` (textMask at `scale`) with its top-left corner at (x, y) and the pixels of colour `ink`. */
function textMismatch(p: Pixels, text: string, x: number, y: number, scale: number, ink: readonly number[]): number {
  const m = textMask(text, scale);
  let bad = 0;
  for (let yy = 0; yy < m.height; yy++) {
    for (let xx = 0; xx < m.width; xx++) {
      const o = ((y + yy) * p.width + x + xx) * 4;
      const isInk = p.rgba[o] === ink[0] && p.rgba[o + 1] === ink[1] && p.rgba[o + 2] === ink[2];
      if (isInk !== (m.mask[yy * m.width + xx] === 1)) bad++;
    }
  }
  return bad;
}

describe('D4(4): an "auto" sweep with an unvoiced stretch (fixture render, noise spliced in)', () => {
  const def = loadFixture('i5-test');
  const lens = lensOf(def.spec);
  const lib = join(dir, 'gap-lib', 'i5-test');
  /** The noise stretch [from, to) in seconds of the segment, and the segment's length. */
  let noise: [number, number] = [0, 0];
  let durationS = 0;
  let auto: RefClip | undefined;
  let keyed: RefClip | undefined;

  beforeAll(() => {
    // one gear's climb of wotPull (the longest in-kind run) with its known DSP rpm as keyframes every 0.05 s
    const span = knownSpan(def, 'wotPull');
    const audio = renderMono(def, 'wotPull').slice(Math.round(span.from * FS), Math.round(span.to * FS));
    // ~1 s of the climb replaced by white noise at the climb's RMS: nothing rpm-locked to track there
    let ms = 0;
    for (const v of audio) ms += v * v;
    const n0 = Math.round(0.3 * audio.length);
    const n1 = Math.min(audio.length, n0 + FS);
    audio.set(lcgNoise(n1 - n0, 4242, Math.sqrt((12 * ms) / audio.length)), n0);
    noise = [n0 / FS, n1 / FS];
    durationS = audio.length / FS;
    const rpms = span.rpm.map(([, r]) => r);
    const hint: [number, number] = [Math.round(0.93 * Math.min(...rpms)), Math.round(1.07 * Math.max(...rpms))]; // a sweep's range hint
    const sweep = { kind: 'wot', startS: 0, endS: durationS };
    mkdirSync(lib, { recursive: true });
    for (const [id, seg] of [
      ['gap-auto', { ...sweep, rpm: 'auto', rpmHint: hint }],
      ['gap-keyed', { ...sweep, rpm: span.rpm }], // the same audio and span with its known rpm
    ] as const) {
      writeWav(join(lib, `${id}.wav`), [audio], FS);
      writeFileSync(join(lib, `${id}.json`), JSON.stringify({ clipId: id, perspective: 'cabin', segments: [seg] }));
    }
    [auto, keyed] = loadRefClips(lib, def.spec, lens);
  }, 120_000);

  it('uses the voiced stretches, skips the unvoiced one, and every frame it keeps carries the right rpm', () => {
    expect(auto?.report.clipId).toBe('gap-auto');
    const seg = auto?.report.segments[0];
    expect(seg?.status).toBe('used');
    expect(seg?.rpmHint).not.toBeNull();
    expect(seg?.voicedShare ?? 1).toBeLessThan(1);
    expect(seg?.voicedShare ?? 0).toBeGreaterThan(0.3);
    expect(seg?.confidentShare ?? 1).toBeLessThanOrEqual(seg?.voicedShare ?? 0);
    const tracked = auto?.features[0]?.frames ?? [];
    const known = keyed?.features[0]?.frames ?? [];
    // the keyframed copy keeps every 0.25 s frame (hop 0.125 s) of the span; the tracked one fewer
    expect(known.length).toBe(Math.floor((durationS - 0.25) / 0.125 + 1e-9) + 1);
    expect(seg?.frames).toBe(tracked.length);
    expect(tracked.length).toBeGreaterThan(5);
    expect(tracked.length).toBeLessThan(known.length);
    // Match each tracked frame to the keyframed frame of the same audio by its rpm-independent level and centroid.
    const key = (f: FrameFeatures): string => `${f.levelDb}|${f.centroidHz}`;
    const hopOf = new Map(known.map((f, h) => [key(f), h]));
    expect(hopOf.size).toBe(known.length);
    const noiseOnly = (h: number): boolean => h * 0.125 >= noise[0] && h * 0.125 + 0.25 <= noise[1];
    expect(known.filter((_, h) => noiseOnly(h)).length).toBeGreaterThanOrEqual(4);
    for (const f of tracked) {
      const h = hopOf.get(key(f));
      if (h === undefined) throw new Error(`tracked frame at ${f.rpm} rpm matches no frame of the keyframed copy`);
      expect(noiseOnly(h), `frame ${h} lies inside the noise`).toBe(false);
      expect(Math.abs(f.rpm / (known[h]?.rpm ?? Number.NaN) - 1), `frame ${h}`).toBeLessThanOrEqual(0.06);
    }
  });
});

describe('tesbox-score end to end (fixture reference library)', () => {
  const refs = join(dir, 'lab-refs');
  const swapped = join(dir, 'lab-refs-swapped');
  const out = join(dir, 'out');
  const outSwapGate = join(dir, 'out-swap-gate');
  const outSwap = join(dir, 'out-swap');
  let honest: ScoreReport;
  let honestExit = -1;

  beforeAll(() => {
    const a = loadFixture('i5-test');
    const a2 = detuned(loadFixture('i5-test'));
    const b = loadFixture('v8-crossplane-test');
    const idleA = a.spec.rpm.idle;
    const clipParts = (def: EngineDef, autoIdle: boolean, extras: PartSegment[], splitWot = false) => {
      const wot = knownSpan(def, 'wotPull');
      const lift = knownSpan(def, 'liftoff6k');
      const idle = def.spec.rpm.idle;
      return [
        {
          audio: renderMono(def, 'idle'),
          segments: [
            autoIdle
              ? { kind: 'idle', from: 0.5, to: 4.5, rpm: 'auto' as const, rpmHint: [0.93 * idle, 1.07 * idle] as [number, number] }
              : { kind: 'idle', from: 0.5, to: 4.5, rpm: [[0, idle], [4, idle]] as [number, number][] },
            ...extras,
          ],
        },
        { audio: renderMono(def, 'wotPull'), segments: splitWot ? splitSpan('wot', wot) : [{ kind: 'wot', ...wot }] },
        { audio: renderMono(def, 'liftoff6k'), segments: [{ kind: 'liftoff', ...lift }] },
      ];
    };
    const a1Extras: PartSegment[] = [
      { kind: 'cruise', from: 0.5, to: 4.5, rpm: 'auto', rpmHint: [600, 1100] }, // ±29.4 %: D4 rejects it
      { kind: 'wot', from: 0.5, to: 4.5, rpm: 'auto' }, // no hint: rejected
      { kind: 'limiter', from: 0.5, to: 4.5, rpm: [[0, idleA], [4, idleA]] }, // no render segment of this kind
    ];
    // honest library: i5-test refs are i5-test renders, v8-crossplane-test refs are V8 renders; a2 cuts its wot
    // climb into two wot segments (one recording, so one wot ClipFeatures)
    writeClip(join(refs, 'i5-test'), 'a1', 'cabin', clipParts(a, true, a1Extras));
    writeClip(join(refs, 'i5-test'), 'a2', 'cabin', clipParts(a2, false, [], true));
    writeClip(join(refs, 'v8-crossplane-test'), 'b1', 'cabin', clipParts(b, false, []));
    writeFileSync(join(refs, 'i5-test', 'README.txt'), 'not a sidecar');
    // swapped library: the V8's "own" refs are I5 recordings and vice versa (keyframes only)
    for (const id of ['a1', 'a2']) {
      mkdirSync(join(swapped, 'v8-crossplane-test'), { recursive: true });
      copyFileSync(join(refs, 'i5-test', `${id}.wav`), join(swapped, 'v8-crossplane-test', `${id}.wav`));
      const side = JSON.parse(readFileSync(join(refs, 'i5-test', `${id}.json`), 'utf8')) as { segments: Record<string, unknown>[] };
      side.segments = side.segments
        .filter((s) => s.rpm !== 'auto' && s.kind !== 'limiter')
        .concat(id === 'a1' ? [{ kind: 'idle', startS: 0.5, endS: 4.5, rpm: [[0, idleA], [4, idleA]] }] : []);
      writeFileSync(join(swapped, 'v8-crossplane-test', `${id}.json`), JSON.stringify(side));
    }
    mkdirSync(join(swapped, 'i5-test'), { recursive: true });
    copyFileSync(join(refs, 'v8-crossplane-test', 'b1.wav'), join(swapped, 'i5-test', 'b1.wav'));
    copyFileSync(join(refs, 'v8-crossplane-test', 'b1.json'), join(swapped, 'i5-test', 'b1.json'));

    honestExit = quiet(() => main(['i5-test', '--refs', refs, '--out', out, '--gate']));
    honest = readReport(out, 'i5-test');
  }, 300_000);

  it('scores the engine and passes the gate when its renders match its own references', () => {
    expect(honest.engineId).toBe('i5-test');
    expect(honest.refClips).toBe(2);
    expect(honest.score.unscored).toBe(false);
    expect(honest.score.composite).toBeGreaterThan(0.5);
    for (const m of METRICS) expect(['pass', 'fail', 'n/a']).toContain(honest.score.gate[m]);
    expect(honest.score.gate.orderProfile).toBe('pass');
    expect(honest.score.discrimination.others.map((o) => o.engineId)).toEqual(['v8-crossplane-test']);
    expect(honest.score.discrimination.pass).toBe(true);
    expect(honest.verdict.pass).toBe(true);
    expect(honestExit).toBe(0);
  });

  it('tracks "auto" rpm inside the sidecar hint and reports why segments were not used', () => {
    const a1 = honest.refs.find((c) => c.clipId === 'a1');
    expect(a1?.status).toBe('used');
    const segs = a1?.segments ?? [];
    expect(segs.map((s) => [s.kind, s.status])).toEqual([
      ['idle', 'used'],
      ['cruise', 'rejected'],
      ['wot', 'rejected'],
      ['limiter', 'unmatched'],
      ['wot', 'used'],
      ['liftoff', 'used'],
    ]);
    const idle = segs[0];
    expect(idle?.rpm).toBe('auto');
    expect(idle?.voicedShare ?? 0).toBeGreaterThan(0.5);
    expect(idle?.confidentShare ?? 0).toBeGreaterThan(0.5);
    expect(idle?.frames ?? 0).toBeGreaterThan(10);
    expect(segs[1]?.reason).toMatch(/±15 %/);
    expect(segs[2]?.reason).toMatch(/needs an rpmHint/);
    expect(segs[3]?.reason).toMatch(/limiter/);
    expect(segs[4]?.rpm).toBe('keyframes');
    expect(segs[4]?.voicedShare).toBeNull();
    expect(honest.refs.map((c) => c.clipId)).toEqual(['a1', 'a2']);
  });

  it('renders only the perspectives that have references, with known rpm', () => {
    expect(honest.renders.map((r) => [r.perspective, r.segment, r.kind])).toEqual(
      RENDER_PLAN.map((p) => ['cabin', p.segment, p.kind]),
    );
    for (const r of honest.renders) {
      expect(r.frames, r.segment).toBeGreaterThan(5);
      expect(r.nonFiniteResets).toBe(0);
    }
    const lift = honest.renders.find((r) => r.segment === 'liftoff6k');
    expect(lift?.spanS[0]).toBeCloseTo(0.5, 2);
    expect(lift?.spanS[1]).toBeCloseTo(5.0, 2);
  });

  it('reports every pair: render vs ref, ref vs ref (independent clips only), render vs other engines', () => {
    const { renderVsRef, refVsRef, renderVsOther } = honest.pairs;
    expect(renderVsRef.length).toBeGreaterThan(0);
    expect(renderVsRef.every((p) => p.a.startsWith('render') && ['a1', 'a2'].includes(p.b))).toBe(true);
    // one ClipFeatures per clip and kind (a2's two wot segments merged): one pair per clip pair and kind, and a ref
    // pair never pairs a recording with itself
    expect(honest.refs.find((c) => c.clipId === 'a2')?.segments.map((s) => [s.kind, s.status])).toEqual([
      ['idle', 'used'],
      ['wot', 'used'],
      ['wot', 'used'],
      ['liftoff', 'used'],
    ]);
    expect(refVsRef.map((p) => [p.a, p.b, p.kind])).toEqual([
      ['a1', 'a2', 'idle'],
      ['a1', 'a2', 'wot'],
      ['a1', 'a2', 'liftoff'],
    ]);
    expect(renderVsRef.filter((p) => p.kind === 'wot').map((p) => [p.a, p.b])).toEqual([
      ['render wotPull', 'a1'],
      ['render wotPull', 'a2'],
    ]);
    expect(renderVsOther.every((p) => p.engineId === 'v8-crossplane-test')).toBe(true);
    const wotA1 = renderVsRef.find((p) => p.kind === 'wot' && p.b === 'a1');
    expect(wotA1?.commonBins ?? 0).toBeGreaterThanOrEqual(2);
    // the render is the very recording a1 was made from
    expect(wotA1?.composite ?? 0).toBeGreaterThan(0.9);
    // the listed pairs are exactly the pairs the EngineScore averages
    const meanOf = (pairs: readonly PairScore[], m: (typeof METRICS)[number]): number | null => {
      const v = pairs.map((p) => p.metrics[m]).filter((x): x is number => x !== null);
      return v.length > 0 ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    const same = (got: number | null, want: number | null, what: string): void => {
      if (want === null) expect(got, what).toBeNull();
      else expect(got ?? Number.NaN, what).toBeCloseTo(want, 12);
    };
    for (const m of METRICS) {
      same(meanOf(refVsRef, m), honest.score.refVsRef[m], `refVsRef ${m}`);
      same(meanOf(renderVsRef, m), honest.score.renderVsRef[m], `renderVsRef ${m}`);
    }
    expect(honest.score.refVsRef.orderProfile).not.toBeNull();
    const other = Object.fromEntries(METRICS.map((m) => [m, meanOf(renderVsOther, m)])) as Record<(typeof METRICS)[number], number | null>;
    same(compositeScore(other), honest.score.discrimination.others[0]?.composite ?? null, 'discrimination vs v8-crossplane-test');
  });

  it('writes report.md and the PNG evidence', () => {
    const d = join(out, 'i5-test');
    const md = readFileSync(join(d, 'report.md'), 'utf8');
    expect(md).toMatch(/^# /);
    for (const m of METRICS) expect(md).toContain(m);
    expect(md).toContain('a1');
    expect(md).toMatch(/±15 %/);
    for (const p of RENDER_PLAN) expect(pngSize(join(d, `spectrogram-render-${p.segment}-cabin.png`))).toEqual([960, 540]);
    for (const f of [
      'spectrogram-a1-idle1.png',
      'spectrogram-a1-wot2.png',
      'spectrogram-a1-liftoff1.png',
      'spectrogram-a2-wot1.png',
      'spectrogram-a2-wot2.png',
    ]) {
      expect(pngSize(join(d, f)), f).toEqual([960, 540]);
    }
    expect(existsSync(join(d, 'spectrogram-a1-cruise1.png'))).toBe(false); // rejected segment
    expect(pngSize(join(d, 'orders-cabin.png'))).toEqual([960, 540]);
    expect(existsSync(join(d, 'orders-outside.png'))).toBe(false);
    expect(existsSync(join(d, 'spectrogram-render-idle-outside.png'))).toBe(false);
    expect(honest.plots).toContain('orders-cabin.png');
    expect(honest.plots.every((p) => existsSync(join(d, p)))).toBe(true);
    // The order plot's bin (amendment D7): the 500 rpm bin with the most frames common to the render and the references.
    // Here the idle segments decide it: the render's 5 s idle and the two references' 4 s idles all sit at the idle rpm,
    // while every other bin holds a few frames of the references' sweeps.
    expect(honest.orderPlots.map((p) => [p.file, p.perspective])).toEqual([['orders-cabin.png', 'cabin']]);
    const op = honest.orderPlots[0];
    const [lo, hi] = op?.rpmBin ?? [Number.NaN, Number.NaN];
    expect([hi - lo, (lo + 250) % 500]).toEqual([500, 0]);
    const idleRpm = loadFixture('i5-test').spec.rpm.idle;
    expect(lo <= idleRpm && idleRpm < hi, `idle ${idleRpm} rpm in ${lo}–${hi}`).toBe(true);
    const series = op?.series ?? [];
    const framesOf = (render: boolean): number => series.filter((s) => (s.clipId === null) === render).reduce((n, s) => n + s.frames, 0);
    expect(op?.frames).toEqual({ render: framesOf(true), reference: framesOf(false), common: Math.min(framesOf(true), framesOf(false)) });
    expect(op?.frames.common ?? 0).toBeGreaterThan(10);
    // the series with frames in the bin come first; report.md names the bin and lists every series with its count
    const inBin = series.filter((s) => s.frames > 0);
    expect(series.slice(0, inBin.length)).toEqual(inBin);
    expect(inBin.map((s) => s.label)).toEqual(expect.arrayContaining(['idle render', 'idle a1', 'idle a2']));
    expect(series.map((s) => s.label)).toEqual(expect.arrayContaining(['wot render', 'wot a1', 'wot a2', 'liftoff a1', 'liftoff a2']));
    expect(series.map((s) => s.drawn)).toEqual(series.map((_, i) => i < 8));
    for (const s of series) expect(md).toMatch(new RegExp(`\\| ${s.label} \\| ${s.frames} \\| `));
    expect(md).toContain(`${lo}–${hi} rpm bin`);
    expect(md).not.toMatch(/no common bin|no reference curve/i);
    // the figure shows that bin in its title and in its legend header
    const L = orderPlotLayout(960, 540);
    const px = pngPixels(join(d, 'orders-cabin.png'));
    expect(textMismatch(px, `ORDERS AT ${lo + 250} RPM (${lo}-${hi})`, L.plot.x, L.titleTop, L.scale, PLOT_COLORS.text)).toBe(0);
    expect(textMismatch(px, `${lo}-${hi} RPM`, L.legend.x, L.legend.y, L.scale, PLOT_COLORS.text)).toBe(0);
  });

  it(
    'exits 1 with --gate when discrimination fails, 0 without, with bit-identical reports',
    { timeout: 300_000 },
    () => {
      expect(quiet(() => main(['v8-crossplane-test', '--refs', swapped, '--out', outSwapGate, '--gate']))).toBe(1);
      expect(quiet(() => main(['v8-crossplane-test', '--refs', swapped, '--out', outSwap]))).toBe(0);
      const r = readReport(outSwap, 'v8-crossplane-test');
      expect(r.score.unscored).toBe(false);
      expect(r.score.discrimination.pass).toBe(false);
      expect(r.verdict.pass).toBe(false);
      // D3: fiLine is n/a for a naturally aspirated engine
      expect(r.score.gate.fiLine).toBe('n/a');
      expect(r.score.renderVsRef.fiLine).toBeNull();
      const a = readFileSync(join(outSwapGate, 'v8-crossplane-test', 'report.json'));
      const b = readFileSync(join(outSwap, 'v8-crossplane-test', 'report.json'));
      expect(a.equals(b)).toBe(true);
      const pa = readFileSync(join(outSwapGate, 'v8-crossplane-test', 'orders-cabin.png'));
      const pb = readFileSync(join(outSwap, 'v8-crossplane-test', 'orders-cabin.png'));
      expect(pa.equals(pb)).toBe(true);
    },
  );

  it(
    'one usable clip is unscored even when it holds several kinds; a rerun into the same --out drops stale plots',
    { timeout: 300_000 },
    () => {
      // a1 alone, its idle hint widened so that D4 now rejects the idle: one clip with a wot and a liftoff
      const solo = join(dir, 'lab-refs-solo');
      const outSolo = join(dir, 'out-solo');
      mkdirSync(join(solo, 'i5-test'), { recursive: true });
      copyFileSync(join(refs, 'i5-test', 'a1.wav'), join(solo, 'i5-test', 'a1.wav'));
      const side = JSON.parse(readFileSync(join(refs, 'i5-test', 'a1.json'), 'utf8')) as { segments: Record<string, unknown>[] };
      const idle = side.segments[0];
      if (idle === undefined) throw new Error('a1 has no idle segment');
      idle.rpmHint = [600, 1100];
      writeFileSync(join(solo, 'i5-test', 'a1.json'), JSON.stringify(side));
      // the honest run's output sits in the --out directory already
      const d = join(outSolo, 'i5-test');
      cpSync(join(out, 'i5-test'), d, { recursive: true });
      writeFileSync(join(d, 'notes.txt'), 'not a tesbox-score output');
      expect(existsSync(join(d, 'spectrogram-a1-idle1.png'))).toBe(true);

      expect(quiet(() => main(['i5-test', '--refs', solo, '--out', outSolo, '--gate']))).toBe(0);
      const r = readReport(outSolo, 'i5-test');
      expect(r.refClips).toBe(1);
      expect(r.refs[0]?.segments.filter((s) => s.status === 'used').map((s) => s.kind)).toEqual(['wot', 'liftoff']);
      // scoreEngine counts ClipFeatures (two here); the CLI counts recordings (spec §11.3)
      expect(r.score.unscored).toBe(true);
      expect(r.verdict.unscored).toBe(true);
      expect(r.verdict.pass).toBe(true);
      const pngs = readdirSync(d)
        .filter((f) => f.endsWith('.png'))
        .sort();
      expect(pngs).toEqual([...r.plots].sort());
      expect(pngs).not.toContain('spectrogram-a1-idle1.png');
      expect(pngs.filter((f) => f.includes('-a2-'))).toEqual([]);
      expect(pngs).toContain('spectrogram-a1-wot2.png');
      expect(existsSync(join(d, 'notes.txt'))).toBe(true);
    },
  );

  it('an engine without references is unscored and exits 0 even with --gate', () => {
    expect(quiet(() => main(['i6-test', '--refs', refs, '--out', out, '--gate']))).toBe(0);
    const r = readReport(out, 'i6-test');
    expect(r.score.unscored).toBe(true);
    expect(r.verdict.unscored).toBe(true);
    expect(r.refClips).toBe(0);
    expect(r.renders).toEqual([]);
    expect(readFileSync(join(out, 'i6-test', 'report.md'), 'utf8')).toMatch(/unscored/i);
    // a missing library directory is the same as an empty one
    expect(quiet(() => main(['i6-test', '--refs', join(dir, 'no-such-dir'), '--out', join(dir, 'out-none'), '--gate']))).toBe(0);
  });
});
