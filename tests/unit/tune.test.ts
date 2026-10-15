/**
 * tesbox-tune (phase 2b contract "Auto-tune (T6)", phase 5 contract P1 "Tuner v2", spec §11.6). The references here
 * are renders of fixture engines with known rpm (pseudo-references) — never real recordings.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Ajv2020 from 'ajv/dist/2020';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineDef, EngineVoicing, Perspective } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import { MIN_SAMPLE_RATE, assertEngineFits } from '../../src/dsp/dsp-core';
import type { ClipFeatures } from '../../src/lab/features';
import { searchSync } from '../../tools/cmaes';
import { renderSegment } from '../../tools/render';
import { RENDER_PLAN, lensOf, renderClip, renderTimeline, type RenderPlanEntry } from '../../tools/score';
import { SEGMENTS, type Segment } from '../../tools/segments';
import {
  DEFAULT_GENERATIONS,
  DEFAULT_ITERATIONS,
  DEFAULT_OUT,
  DEFAULT_SEED,
  DEFAULT_STRATEGY,
  DISCRIMINATION_MARGIN,
  DISCRIMINATION_WEIGHT,
  EXIT_ERROR,
  EXIT_NOT_TUNED,
  EXIT_USAGE,
  PARAM_KEYS,
  POLISH_MAX_SWEEPS,
  POLISH_STEPS,
  SOUND_SCORES_DOC,
  USAGE,
  VoicingSpace,
  applyVoicing,
  defaultWorkers,
  initialSimplex,
  localEvaluator,
  main,
  nelderMead,
  objectiveOf,
  orderInvariantFailures,
  parseArgs,
  patternSearch,
  renderTargets,
  schemaErrors,
  segmentInvariantFailures,
  tuneEngine,
  tunedEngineIds,
  tunedEngines,
  tunedLine,
  voicingInvariantFailures,
  workerEvaluator,
  workerExecArgv,
  type RenderTarget,
  type TuneReport,
  type TuneStrategy,
} from '../../tools/tune';
import { writeWav } from '../../tools/wav';
import { FIXTURE_IDS, loadFixture } from './helpers/fixtures';

const FS = 48000;
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tesbox-tune-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const STRATEGIES: readonly TuneStrategy[] = ['nm', 'cmaes'];

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    log.mockRestore();
  }
}
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

/** Every engine the tuner may meet: the starter garage and the DSP fixtures (fresh copies). */
function allDefs(): EngineDef[] {
  return [...ENGINES.map((e) => structuredClone(e)), ...FIXTURE_IDS.map((id) => loadFixture(id))];
}

function garage(id: string): EngineDef {
  const e = ENGINES.find((d) => d.id === id);
  if (e === undefined) throw new Error(`no garage engine ${id}`);
  return structuredClone(e);
}

/**
 * A garage engine with its spec's default voicing: a fixture that tuning never moves. The box's header and muffler
 * scales are relative to the current voicing, so a test that needs a known point of the box (e.g. the far corner)
 * must start from this, not from a tuned voicing.
 */
function garageDefault(id: string): EngineDef {
  const e = garage(id);
  return { ...e, voicing: defaultVoicing(e.spec) };
}

// ───────────────────────────── arguments ─────────────────────────────

describe('tesbox-tune arguments', () => {
  it('applies the contract defaults (--strategy cmaes for 60 generations, nm 120 iterations, --seed 1, --workers min(16, cores − 2))', () => {
    expect([DEFAULT_STRATEGY, DEFAULT_GENERATIONS, DEFAULT_ITERATIONS, DEFAULT_SEED, DEFAULT_OUT]).toEqual(['cmaes', 60, 120, 1, 'renders/tune']);
    expect(parseArgs(['i5-turbo-25'])).toEqual({
      engine: 'i5-turbo-25',
      strategy: 'cmaes',
      iterations: 60,
      seed: 1,
      workers: defaultWorkers(),
      apply: false,
      refsDir: 'lab-refs',
      outDir: 'renders/tune',
      params: null,
    });
    expect(parseArgs(['i5-turbo-25', '--strategy', 'nm']).iterations).toBe(120);
    expect([36, 18, 17, 8, 3, 2, 1, 0].map((cores) => defaultWorkers(cores))).toEqual([16, 16, 15, 6, 1, 1, 1, 1]);
    expect(defaultWorkers()).toBe(Math.max(1, Math.min(16, availableParallelism() - 2)));
  });

  it('parses every option in any order', () => {
    expect(
      parseArgs([
        '--apply',
        '--seed',
        '7',
        'v8-na-50',
        '--iterations',
        '30',
        '--refs',
        'r',
        '--workers',
        '3',
        '--out',
        'o',
        '--params',
        'cabin.lowpassHz,intake.gain',
        '--strategy',
        'nm',
      ]),
    ).toEqual({ engine: 'v8-na-50', strategy: 'nm', iterations: 30, seed: 7, workers: 3, apply: true, refsDir: 'r', outDir: 'o', params: ['cabin.lowpassHz', 'intake.gain'] });
    expect(parseArgs(['x', '--iterations', '0']).iterations).toBe(0);
    expect(parseArgs(['x', '--workers', '1', '--strategy', 'cmaes'])).toMatchObject({ strategy: 'cmaes', workers: 1, iterations: 60 });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs([])).toThrow(/missing/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected/);
    expect(() => parseArgs(['a', '--iterations'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--seed', '--apply'])).toThrow(/needs a value/);
    for (const bad of ['-1', '2.5', 'many', '']) expect(() => parseArgs(['a', '--iterations', bad])).toThrow(/--iterations/);
    for (const bad of ['-3', '1.5', 'x', String(2 ** 32)]) expect(() => parseArgs(['a', '--seed', bad])).toThrow(/--seed/);
    for (const bad of ['0', '-2', '1.5', 'all', '']) expect(() => parseArgs(['a', '--workers', bad])).toThrow(/--workers/);
    expect(() => parseArgs(['a', '--strategy', 'anneal'])).toThrow(/--strategy/);
    expect(() => parseArgs(['a', '--strategy'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--params', 'pulse.widthDeg,nope'])).toThrow(/nope/);
    expect(() => parseArgs(['a', '--params', ','])).toThrow(/--params/);
    expect(() => parseArgs(['a', '--loud'])).toThrow(/unknown option/);
  });

  it('main() returns 2 with the usage on bad arguments or an unknown engine', async () => {
    expect([EXIT_NOT_TUNED, EXIT_USAGE, EXIT_ERROR]).toEqual([1, 2, 3]);
    expect(USAGE).toMatch(/--strategy cmaes\|nm/);
    expect(USAGE).toMatch(/--workers/);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['--nope'])).toBe(2);
      expect(await main(['no-such-engine'])).toBe(2);
      expect(await main(['v8-na-50', '--workers', '0'])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(USAGE));
    } finally {
      err.mockRestore();
    }
  });

  it('is wired as the npm script `tune`', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.tune).toBe('tsx tools/tune.ts');
  });
});

// ───────────────────────────── the tunable voicing vector ─────────────────────────────

describe('tunable voicing vector', () => {
  const NA_KEYS = [
    'pulse.widthDeg',
    'pulse.alpha',
    'pulse.beta',
    'pulse.cycleAsymmetry',
    'headersM.scale',
    'collectors.lengthM',
    'exhaust.midPipeM',
    'exhaust.mufflerSectionsM.scale',
    'exhaust.mufflerAction',
    'exhaust.tailpipeM',
    'intake.helmholtzHz',
    'intake.gain',
    'mechanical.blockGain',
    'mechanical.valvetrainGain',
    'cabin.lowpassHz',
  ];

  it('holds the contract parameters and ranges, the forced-induction cabin gain only where fitted', () => {
    expect(PARAM_KEYS).toEqual([...NA_KEYS, 'forcedInduction.cabinGainDb']);
    const na = new VoicingSpace(garage('v8-na-50'));
    expect(na.params.map((p) => [p.key, p.lo, p.hi])).toEqual([
      ['pulse.widthDeg', 40, 90],
      ['pulse.alpha', 3, 20],
      ['pulse.beta', 1, 10],
      ['pulse.cycleAsymmetry', 0, 0.5],
      ['headersM.scale', 0.7, 1.4],
      ['collectors.lengthM', 0.2, 1.0],
      ['exhaust.midPipeM', 0.6, 3.0],
      ['exhaust.mufflerSectionsM.scale', 0.6, 1.6],
      ['exhaust.mufflerAction', 0, 1],
      ['exhaust.tailpipeM', 0.2, 1.2],
      ['intake.helmholtzHz', 60, 300],
      ['intake.gain', 0, 1],
      ['mechanical.blockGain', 0, 1],
      ['mechanical.valvetrainGain', 0, 0.5],
      ['cabin.lowpassHz', 300, 1200],
    ]);
    // contract −24 … −6 dB, limited to what engine.schema.json and contracts.ts allow (−20 … −10 dB)
    const turbo = new VoicingSpace(garage('i5-turbo-25'));
    expect(turbo.params.map((p) => p.key)).toEqual(PARAM_KEYS);
    expect(turbo.params.at(-1)).toEqual({ key: 'forcedInduction.cabinGainDb', lo: -20, hi: -10 });
    // rotary: pulse width 200–300°
    expect(new VoicingSpace(garage('rotary-twin-13')).params[0]).toEqual({ key: 'pulse.widthDeg', lo: 200, hi: 300 });
  });

  it('tunes a subset when asked, and refuses unknown or inapplicable keys', () => {
    const s = new VoicingSpace(garage('i5-turbo-25'), ['cabin.lowpassHz', 'pulse.alpha']);
    expect(s.params.map((p) => p.key)).toEqual(['pulse.alpha', 'cabin.lowpassHz']); // contract order
    expect(() => new VoicingSpace(garage('v8-na-50'), ['forcedInduction.cabinGainDb'])).toThrow(/forced induction/);
    expect(() => new VoicingSpace(garage('v8-na-50'), ['spec.rpm.idle'])).toThrow(/unknown/);
    expect(() => new VoicingSpace(garage('v8-na-50'), [])).toThrow(/at least one/);
  });

  it('round-trips every starting voicing: decode(encode(v)) is v', () => {
    for (const def of allDefs()) {
      const s = new VoicingSpace(def);
      const x = s.encode(def.voicing);
      expect(x.every((u) => u >= 0 && u <= 1), def.id).toBe(true);
      expect(s.decode(x), def.id).toEqual(def.voicing);
    }
  });

  it('changes only the tuned voicing fields: never the spec, the base, or the estimated flag', () => {
    const def = garage('i5-turbo-25');
    const before = structuredClone(def);
    const s = new VoicingSpace(def, ['pulse.widthDeg', 'exhaust.midPipeM', 'cabin.lowpassHz']);
    const v = s.decode([1, 0, 1]);
    expect(def).toEqual(before);
    expect(v.pulse.widthDeg).toBe(90);
    expect(v.exhaust.midPipeM).toBe(0.6);
    expect(v.cabin.lowpassHz).toBe(1200);
    expect(v.estimated).toBe(true);
    const untouched = structuredClone(v);
    untouched.pulse.widthDeg = before.voicing.pulse.widthDeg;
    untouched.exhaust.midPipeM = before.voicing.exhaust.midPipeM;
    untouched.cabin.lowpassHz = before.voicing.cabin.lowpassHz;
    expect(untouched).toEqual(before.voicing);
    expect(s.values(v)).toEqual([90, 0.6, 1200]);
    expect(s.encode(v)).toEqual([1, 0, 1]);
  });

  it('scales every header / muffler section and the collectors together, clamped to the contract maxima', () => {
    const def = garage('v8-na-50');
    def.voicing.headersM[0] = 1.2; // ×1.4 = 1.68 > 1.5 m
    def.voicing.exhaust.mufflerSectionsM = [0.1, 0.7]; // ×0.6 = 0.06 (below 4 samples at 28 kHz) and ×1.6 = 1.12 > 0.8 m
    def.voicing.collectors = [
      { banks: [0], lengthM: 0.3 },
      { banks: [1], lengthM: 0.5 },
    ];
    const s = new VoicingSpace(def, ['headersM.scale', 'collectors.lengthM', 'exhaust.mufflerSectionsM.scale']);
    expect(s.values(def.voicing)).toEqual([1, 0.4, 1]); // scale factors 1, mean collector length
    const hi = s.decode([1, 1, 1]);
    expect(hi.headersM[0]).toBe(1.5);
    expect(hi.headersM[1]).toBeCloseTo((def.voicing.headersM[1] ?? 0) * 1.4, 3);
    expect(hi.collectors.map((c) => c.lengthM)).toEqual([0.75, 1.0]); // ratio kept: 0.3·2.5, min(1.0, 0.5·2.5)
    expect(hi.exhaust.mufflerSectionsM).toEqual([0.16, 0.8]);
    const lo = s.decode([0, 0, 0]);
    expect(lo.exhaust.mufflerSectionsM).toEqual([0.1, 0.42]); // 0.06 → the 0.1 m floor (4 samples at MIN_SAMPLE_RATE)
    expect(lo.collectors.map((c) => c.lengthM)).toEqual([0.15, 0.25]);
    for (const v of [hi, lo]) expect(() => assertEngineFits({ ...def, voicing: v }, MIN_SAMPLE_RATE)).not.toThrow();
  });

  it('clamps a starting value outside the tunable range into [0, 1]', () => {
    const def = garage('v8-na-50');
    def.voicing.cabin.lowpassHz = 1500; // schema allows 200–2000, the tuner searches 300–1200
    def.voicing.pulse.cycleAsymmetry = 0.8;
    const s = new VoicingSpace(def, ['pulse.cycleAsymmetry', 'cabin.lowpassHz']);
    expect(s.encode(def.voicing)).toEqual([1, 1]);
  });

  it('every corner of the box is schema-valid and fits the DSP at every supported sample rate', () => {
    for (const def of allDefs()) {
      const s = new VoicingSpace(def);
      for (const corner of [0, 1]) {
        const v = s.decode(s.params.map(() => corner));
        const cand = { ...def, voicing: v };
        expect(() => assertEngineFits(cand, MIN_SAMPLE_RATE), `${def.id} corner ${corner}`).not.toThrow();
        expect(validateEngine(cand), `${def.id} corner ${corner}: ${JSON.stringify(validateEngine.errors)}`).toBe(true);
      }
    }
  });
});

// ───────────────────────────── bounded Nelder–Mead ─────────────────────────────

describe('bounded Nelder–Mead', () => {
  const bowl =
    (c: number[]) =>
    (x: readonly number[]): number =>
      x.reduce((s, xi, i) => s + (xi - (c[i] ?? 0)) ** 2 * (i + 1), 0);

  it('finds the minimum of a bowl inside the box and reports convergence', () => {
    const c = [0.3, 0.72, 0.55];
    const r = nelderMead(bowl(c), [0.9, 0.1, 0.5], { iterations: 400, seed: 1 });
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThan(400);
    r.x.forEach((xi, i) => expect(Math.abs(xi - (c[i] ?? 0)), `x${i}`).toBeLessThan(0.01));
    expect(r.f).toBeLessThan(1e-4);
  });

  it('stays inside [0, 1]^n and ends on the boundary when the minimum lies outside', () => {
    const seen: number[][] = [];
    const f = (x: readonly number[]): number => {
      seen.push([...x]);
      return bowl([1.4, -0.3])(x);
    };
    const r = nelderMead(f, [0.5, 0.5], { iterations: 200, seed: 3 });
    expect(seen.length).toBe(r.evaluations);
    expect(seen.every((x) => x.every((xi) => xi >= 0 && xi <= 1))).toBe(true);
    expect(r.x[0]).toBeCloseTo(1, 3);
    expect(r.x[1]).toBeCloseTo(0, 3);
  });

  it('is deterministic for a seed; the seed shapes the starting simplex', () => {
    const f = bowl([0.2, 0.4, 0.6, 0.8]);
    const a = nelderMead(f, [0.5, 0.5, 0.5, 0.5], { iterations: 25, seed: 9 });
    const b = nelderMead(f, [0.5, 0.5, 0.5, 0.5], { iterations: 25, seed: 9 });
    expect(b).toEqual(a);
    const s1 = initialSimplex([0.5, 0.5, 0.5, 0.5], 1);
    const s2 = initialSimplex([0.5, 0.5, 0.5, 0.5], 2);
    expect(s1).toEqual(initialSimplex([0.5, 0.5, 0.5, 0.5], 1));
    expect(s2).not.toEqual(s1);
    for (const s of [s1, s2]) {
      expect(s).toHaveLength(5);
      expect(s[0]).toEqual([0.5, 0.5, 0.5, 0.5]);
      // vertex i moves coordinate i − 1 only, by 0.10–0.25, inside the box
      s.slice(1).forEach((v, i) => {
        v.forEach((vj, j) => {
          if (j === i) expect(Math.abs(vj - 0.5)).toBeGreaterThanOrEqual(0.1 - 1e-12);
          if (j === i) expect(Math.abs(vj - 0.5)).toBeLessThanOrEqual(0.25 + 1e-12);
          if (j !== i) expect(vj).toBe(0.5);
        });
      });
    }
    // at the boundary the step points inward
    for (const v of initialSimplex([1, 0], 5).slice(1)) expect(v.every((u) => u >= 0 && u <= 1)).toBe(true);
  });

  it('respects the iteration budget and logs every step', () => {
    let n = 0;
    const f = (x: readonly number[]): number => {
      n++;
      return bowl([0.1, 0.9, 0.3])(x);
    };
    const r = nelderMead(f, [0.5, 0.5, 0.5], { iterations: 6, seed: 1 });
    expect(r.iterations).toBe(6);
    expect(r.converged).toBe(false);
    expect(r.evaluations).toBe(n);
    expect(r.history.map((h) => h.iteration)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.history[0]?.step).toBe('init');
    expect(r.history[0]?.evaluations).toBe(4);
    for (const h of r.history.slice(1)) expect(['reflect', 'expand', 'contract-out', 'contract-in', 'shrink']).toContain(h.step);
    // the best value never gets worse
    for (let i = 1; i < r.history.length; i++) expect(r.history[i]?.bestF ?? 0).toBeLessThanOrEqual(r.history[i - 1]?.bestF ?? 0);
    expect(r.f).toBe(r.history.at(-1)?.bestF);
    // no iterations: x0 alone
    const z = nelderMead(f, [0.5, 0.5, 0.5], { iterations: 0, seed: 1 });
    expect(z.evaluations).toBe(1);
    expect(z.x).toEqual([0.5, 0.5, 0.5]);
  });

  it('treats a non-finite objective as worse than any finite one', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = (x: readonly number[]): number => ((x[0] ?? 0) > 0.6 ? bad : bowl([0.2])(x));
      for (const seed of [1, 2, 3]) {
        const r = nelderMead(f, [0.5], { iterations: 60, seed });
        expect(r.x[0], `seed ${seed}`).toBeCloseTo(0.2, 2);
        expect(Number.isFinite(r.f)).toBe(true);
      }
    }
  });
});

// ───────────────────────────── polish: coordinate pattern search ─────────────────────────────

describe('polish: coordinate pattern search', () => {
  /** Drives a pattern search with `f`, recording every batch it asks for. */
  function record(x0: number[], f: (x: readonly number[]) => number, f0 = f(x0)) {
    const batches: number[][][] = [];
    const search = patternSearch(x0, f0);
    let step = search.next();
    while (step.done !== true) {
      batches.push(step.value.map((p) => [...p]));
      step = search.next(step.value.map(f));
    }
    return { r: step.value, batches };
  }
  const bowl =
    (c: readonly number[]) =>
    (x: readonly number[]): number =>
      x.reduce((s, xi, i) => s + (xi - (c[i] ?? 0)) ** 2 * (i + 1), 0);

  it('sweeps ±step on every coordinate as one batch, takes the best improving move, halves the step 0.05 → 0.025 → 0.0125 when none improves', () => {
    expect([POLISH_STEPS, POLISH_MAX_SWEEPS]).toEqual([[0.05, 0.025, 0.0125], 8]);
    const f = bowl([0.47, 0.538]);
    const { r, batches } = record([0.5, 0.5], f);
    expect(r.sweeps).toBe(batches.length);
    expect(r.history.map((h) => h.sweep)).toEqual(batches.map((_, i) => i + 1));
    let x = [0.5, 0.5];
    let fx = f(x);
    let level = 0;
    batches.forEach((batch, k) => {
      const step = POLISH_STEPS[level] ?? Number.NaN;
      expect(r.history[k]?.step, `sweep ${k + 1}`).toBe(step);
      // both directions of every coordinate, coordinate by coordinate
      expect(batch).toEqual([
        [x[0]! + step, x[1]],
        [x[0]! - step, x[1]],
        [x[0], x[1]! + step],
        [x[0], x[1]! - step],
      ]);
      const values = batch.map(f);
      const best = values.indexOf(Math.min(...values));
      if ((values[best] ?? Number.POSITIVE_INFINITY) < fx) {
        x = batch[best] ?? [];
        fx = values[best] ?? Number.NaN;
        expect(r.history[k]?.moved).toBe(true);
      } else {
        expect(r.history[k]?.moved).toBe(false);
        level++;
      }
      expect(r.history[k]?.bestF).toBe(fx);
      expect(r.history[k]?.bestX).toEqual(x);
    });
    // stopped because no move improved at the finest step, before the sweep limit
    expect(level).toBe(POLISH_STEPS.length);
    expect(r.sweeps).toBeLessThan(POLISH_MAX_SWEEPS);
    expect(r.history.map((h) => h.step)).toContain(0.0125);
    expect([r.x, r.f]).toEqual([x, fx]);
    expect(r.evaluations).toBe(batches.flat().length);
  });

  it('stops after 8 sweeps while moves still improve', () => {
    const { r, batches } = record([0, 0.5], (x) => -(x[0] ?? 0));
    expect(batches).toHaveLength(8);
    expect(r.history.every((h) => h.moved && h.step === 0.05)).toBe(true);
    expect(r.x[0]).toBeCloseTo(0.4, 12);
  });

  it('never leaves the box, skips the moves the boundary blocks, and breaks ties for the earlier candidate', () => {
    const f = (x: readonly number[]): number => (x[0] === 0 && x[1] === 1 ? 1 : 0.5); // every move ties at 0.5
    const { r, batches } = record([0, 1], f);
    expect(batches[0]).toEqual([
      [0.05, 1],
      [0, 0.95],
    ]);
    expect(r.history[0]?.bestX).toEqual([0.05, 1]); // the first candidate wins the tie
    expect(r.history.map((h) => h.moved)).toEqual([true, false, false, false]); // then nothing beats 0.5: 0.05 → 0.025 → 0.0125
    expect(batches.flat(2).every((u) => u >= 0 && u <= 1)).toBe(true);
    expect([r.x, r.f]).toEqual([[0.05, 1], 0.5]);
  });

  it('a start without a finite value takes the first finite move; non-finite values never win', () => {
    const f = (x: readonly number[]): number => ((x[0] ?? 0) > 0.5 ? Number.NaN : bowl([0.3])(x));
    const { r } = record([0.5], f, Number.POSITIVE_INFINITY);
    expect(r.history[0]?.bestX).toEqual([0.45]);
    expect(Number.isFinite(r.f)).toBe(true);
  });

  it('is a batch search: the same result synchronously', () => {
    const f = bowl([0.31, 0.77, 0.52]);
    expect(searchSync(patternSearch([0.5, 0.5, 0.5], f([0.5, 0.5, 0.5])), f)).toEqual(record([0.5, 0.5, 0.5], f).r);
  });
});

// ───────────────────────────── objective ─────────────────────────────

describe('objective', () => {
  const score = (own: number | null, others: (number | null)[]) => ({
    composite: own,
    discrimination: { ownComposite: own, others: others.map((composite, i) => ({ engineId: `e${i}`, composite })), pass: null },
  });

  it('is −composite plus 0.5 · max(0, best other − own + 0.02)', () => {
    expect([DISCRIMINATION_WEIGHT, DISCRIMINATION_MARGIN]).toEqual([0.5, 0.02]);
    expect(objectiveOf(score(0.8, []))).toBe(-0.8);
    expect(objectiveOf(score(0.8, [0.7]))).toBe(-0.8); // own leads by more than the margin
    expect(objectiveOf(score(0.8, [0.79]))).toBeCloseTo(-0.8 + 0.5 * 0.01, 12);
    expect(objectiveOf(score(0.8, [0.9, null, 0.85]))).toBeCloseTo(-0.8 + 0.5 * 0.12, 12);
  });

  it('is +∞ when the render shares no comparable pair with its references', () => {
    expect(objectiveOf(score(null, [0.5]))).toBe(Number.POSITIVE_INFINITY);
  });
});

// ───────────────────────────── tuned-engine registry ─────────────────────────────

describe('tuned engines recorded in docs/sound-scores.md', () => {
  it('reads one `Tuned voicing: <engine-id>` line per tuned engine', () => {
    expect(SOUND_SCORES_DOC).toBe('docs/sound-scores.md');
    expect(tunedLine('v8-flatplane-45')).toBe('Tuned voicing: v8-flatplane-45');
    const md = [
      '# Sound scores',
      '',
      '## i5-turbo-25',
      'Tuned voicing: i5-turbo-25 (tools/tune.ts --apply, seed 1, 120 iterations)',
      '- Tuned voicing: `v8-na-50`',
      'Not a record: Tuned voicing: v12-na-65',
      'Tuned voicing pending for v10-na-52',
      '',
    ].join('\n');
    expect(tunedEngineIds(md)).toEqual(['i5-turbo-25', 'v8-na-50']);
    expect(tunedEngineIds(`${tunedLine('a-b')}\n${tunedLine('a-b')}\n`)).toEqual(['a-b']);
    expect(tunedEngineIds('')).toEqual([]);
  });

  it('tunedEngines reads the file (docs/sound-scores.md by default); a missing file records none', () => {
    const doc = join(dir, 'sound-scores.md');
    writeFileSync(doc, `# Sound scores\n\n${tunedLine('v8-na-50')}\n`);
    expect([...tunedEngines(doc)]).toEqual(['v8-na-50']);
    expect([...tunedEngines(join(dir, 'missing.md'))]).toEqual([]);
    const repoDoc = join(ROOT, SOUND_SCORES_DOC);
    expect([...tunedEngines()]).toEqual(existsSync(repoDoc) ? tunedEngineIds(readFileSync(repoDoc, 'utf8')) : []);
  });
});

// ───────────────────────────── what gets rendered ─────────────────────────────

describe('render targets', () => {
  const f = (kind: string, perspective: Perspective): ClipFeatures => ({ kind, perspective, frames: [], overrunRate: null });

  it('renders the contract segments whose kind a reference covers, in the perspectives with own references', () => {
    const targets = renderTargets([f('wot', 'cabin'), f('idle', 'outside')], { other: [f('liftoff', 'cabin'), f('cruise', 'outside')] });
    expect(targets.map((t) => [t.perspective, t.plan.segment])).toEqual([
      ['cabin', 'wotPull'],
      ['cabin', 'liftoff6k'],
      ['outside', 'idle'],
      ['outside', 'cruise2k'],
      ['outside', 'cruise4k'],
      ['outside', 'cruise6k'],
    ]);
    for (const t of targets) expect(RENDER_PLAN).toContain(t.plan);
    // another engine's references alone add no perspective (score renders only where the engine has references)
    expect(renderTargets([f('wot', 'cabin')], { other: [f('liftoff', 'outside')] }).map((t) => [t.perspective, t.plan.segment])).toEqual([
      ['cabin', 'wotPull'],
    ]);
    expect(renderTargets([], {})).toEqual([]);
  });
});

/**
 * Polish sweeps that ask again for a point already evaluated: every sweep after one that moved includes the step back to
 * the point it moved from (a sweep moved when it lowered the best objective).
 */
function polishRevisits(r: TuneReport): number {
  let revisits = 0;
  for (let i = 1; i < r.log.length; i++) {
    const prev = r.log[i - 1];
    const cur = r.log[i];
    const before = r.log[i - 2];
    if (cur?.phase !== 'polish' || prev?.phase !== 'polish' || before === undefined) continue;
    if ((prev.objective ?? Number.POSITIVE_INFINITY) < (before.objective ?? Number.POSITIVE_INFINITY)) revisits++;
  }
  return revisits;
}

// ───────────────────────────── a test-only render segment, for this thread and worker threads ─────────────────────────────

/**
 * A short WOT sweep in one gear (3000 → 6000 rpm in 2.5 s) for tools/score.ts renderClip, which renders it exactly as
 * it renders the contract segments — only shorter, to keep the tests fast. It is a module so that worker threads can
 * register it too (TuneConfig.workerModules: its `segments` join tools/segments.ts SEGMENTS, its `renderPlan` entries
 * the plans targets may name); this thread imports the same module.
 */
const PULL_MODULE = join(dir, 'tune-test-pull.mjs');
writeFileSync(
  PULL_MODULE,
  `export const segments = [{
  name: 'tuneTestPull',
  durationS: 2.5,
  ctl(t, base) {
    base.rpm = 3000 + 3000 * Math.min(1, Math.max(0, t / 2.5));
    base.load = 1;
    base.gear = 3;
    base.driveline = 'engaged';
    base.limiter = false;
    base.shift.active = false;
  },
}];
export const renderPlan = [{ segment: 'tuneTestPull', kind: 'wot', scored: () => true }];
`,
);
const PULL_URL = pathToFileURL(PULL_MODULE).href;

async function importPull(): Promise<{ segment: Segment; plan: RenderPlanEntry }> {
  const m = (await import(/* @vite-ignore */ PULL_URL)) as { segments: Segment[]; renderPlan: RenderPlanEntry[] };
  const segment = m.segments[0];
  const plan = m.renderPlan[0];
  if (segment === undefined || plan === undefined) throw new Error('tune-test-pull.mjs: no segment');
  return { segment, plan };
}

// ───────────────────────────── tuning a detuned fixture back (pseudo-reference) ─────────────────────────────

describe('auto-tune recovers a detuned fixture from a render of the original (pseudo-reference)', () => {
  let PULL: Segment;
  let PLAN: RenderPlanEntry;
  let TARGETS: RenderTarget[];
  beforeAll(async () => {
    ({ segment: PULL, plan: PLAN } = await importPull());
    TARGETS = [{ plan: PLAN, perspective: 'cabin' }];
    SEGMENTS.push(PULL);
  });
  afterAll(() => {
    const i = SEGMENTS.indexOf(PULL);
    if (i >= 0) SEGMENTS.splice(i, 1);
  });

  /** The parameters with the strongest effect on this sweep's scored features (each alone moves the composite by ≈ 0.15–0.3 over its range). */
  const MAIN = ['intake.gain', 'mechanical.blockGain', 'cabin.lowpassHz'];

  // the two searches evaluate in worker threads of their own: run them side by side, each on half the machine (a 4-core
  // CI runner gets 2 + 2 threads instead of 8 + 8), with a timeout sized for such a runner (≈ 25 s here on 36 cores)
  const RECOVERY_WORKERS = Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
  for (const strategy of STRATEGIES) {
    it.concurrent(`${strategy}: improves the composite by ≥ 0.1 and brings the main parameters back within 20 % of their range`, { timeout: 300_000 }, async ({ expect }) => {
      const original = loadFixture('v8-crossplane-test');
      const pseudoRef = renderClip(original, PLAN, 'cabin', lensOf(original.spec)).features;
      const space = new VoicingSpace(original, MAIN);
      const truth = space.encode(original.voicing);
      const detuned: EngineDef = { ...original, voicing: space.decode(truth.map((u) => (u < 0.5 ? u + 0.45 : u - 0.45))) };
      const r = await tuneEngine(
        { def: detuned, refs: [pseudoRef, pseudoRef], otherRefs: {}, targets: TARGETS },
        { strategy, iterations: 25, seed: 1, params: MAIN, workers: RECOVERY_WORKERS, workerModules: [PULL_URL] },
      );
      expect(r.strategy).toBe(strategy);
      expect(r.rejected).toBe(0);
      expect(r.renders).toBeGreaterThan(10);
      expect(r.renders).toBeLessThanOrEqual(r.evaluations - polishRevisits(r)); // a candidate asked for again is not rendered again
      expect((r.best.composite ?? 0) - (r.baseline.composite ?? 1)).toBeGreaterThanOrEqual(0.1);
      expect(r.improved).toBe(true);
      const found = space.encode(r.best.voicing);
      found.forEach((u, i) => expect(Math.abs(u - (truth[i] ?? Number.NaN)), MAIN[i]).toBeLessThanOrEqual(0.2));
      // only the tuned fields moved: every other voicing field is still the detuned engine's
      expect(r.params.map((p) => p.key)).toEqual(MAIN);
      expect({ ...r.best.voicing, intake: null, mechanical: null, cabin: null }).toEqual({ ...detuned.voicing, intake: null, mechanical: null, cabin: null });
      expect(r.best.voicing.intake.runnerM).toBe(detuned.voicing.intake.runnerM);
      expect(r.best.voicing.intake.helmholtzHz).toBe(detuned.voicing.intake.helmholtzHz);
      expect(r.best.voicing.mechanical.valvetrainGain).toBe(detuned.voicing.mechanical.valvetrainGain);
      // the log follows the run: the strategy's iterations (0: the start), then the polish sweeps; the best never gets worse
      const search = r.log.filter((l) => l.phase === strategy);
      const polish = r.log.filter((l) => l.phase === 'polish');
      expect(search[0]?.step).toBe('init');
      expect(search.map((l) => l.generation)).toEqual(search.map((_, i) => i));
      expect(search.length).toBe(r.iterationsRun + 1);
      expect(polish.map((l) => l.generation)).toEqual(polish.map((_, i) => i + 1));
      expect(polish.length).toBe(r.polishSweeps);
      expect(r.polishSweeps).toBeGreaterThan(0);
      expect(r.log).toEqual([...search, ...polish]);
      for (let i = 1; i < r.log.length; i++) expect(r.log[i]?.objective ?? 0).toBeLessThanOrEqual(r.log[i - 1]?.objective ?? 0);
      expect(r.log.at(-1)?.objective).toBe(r.best.objective);
      expect(r.log.at(-1)?.renders).toBe(r.renders);
      expect(r.log.at(-1)?.evaluations).toBe(r.evaluations);
      if (strategy === 'cmaes') {
        // generation log: σ starts at 0.25; each generation evaluates λ = 4 + ⌊3 ln 3⌋ = 7 candidates
        expect(search[0]?.sigma).toBe(0.25);
        search.slice(1).forEach((l, i) => expect(l.evaluations - (search[i]?.evaluations ?? 0)).toBe(7));
        expect(['iterations', 'sigma', 'stagnation']).toContain(r.stop);
      }
    });
  }

  for (const strategy of STRATEGIES) {
    it(`${strategy}: checks every candidate with assertEngineFits before rendering it`, async () => {
      const def = loadFixture('v8-crossplane-test');
      def.voicing.exhaust.mufflerSectionsM = [0.2, 0.2, 0.2, 0.2, 0.2]; // capacity: 1–4 sections
      const r = await tuneEngine({ def, refs: [], otherRefs: {}, targets: TARGETS }, { strategy, iterations: 3, seed: 1, params: ['cabin.lowpassHz'] });
      expect(r.renders).toBe(0);
      expect(r.rejected).toBeGreaterThan(1);
      expect(r.best.objective).toBeNull();
      expect(r.best.rejected).toMatch(/mufflerSectionsM/);
      expect(r.improved).toBe(false);
      expect(r.polishSweeps).toBe(0); // nothing scored: nothing to polish
    });

    it(`${strategy}: does not search when no render shares a comparable rpm bin with a reference (no voicing can change that)`, async () => {
      const def = loadFixture('v8-crossplane-test');
      // references of the render's kind and perspective, recorded 6000 rpm above every bin the sweep covers
      const ref = renderClip(def, PLAN, 'cabin', lensOf(def.spec)).features;
      const far: ClipFeatures = { ...ref, frames: ref.frames.map((f) => ({ ...f, rpm: f.rpm + 6000 })) };
      const r = await tuneEngine({ def, refs: [far, far], otherRefs: {}, targets: TARGETS }, { strategy, iterations: 5, seed: 1, params: ['cabin.lowpassHz'] });
      expect(r.baseline.rejected).toBeNull();
      expect(r.baseline.score?.composite).toBeNull();
      expect(r.renders).toBe(1); // the baseline alone: no candidate is rendered
      expect([r.iterationsRun, r.converged, r.stop]).toEqual([0, false, 'unscorable']);
      expect(r.log.map((l) => l.step)).toEqual(['init']);
      expect(r.best.objective).toBeNull();
      expect(r.improved).toBe(false);
      expect(r.polishSweeps).toBe(0);
    });

    it(`${strategy}: never renders a candidate that breaks the steady order invariants (a voicing --apply would refuse)`, { timeout: 30_000 }, async () => {
      // v8-na-50 (default voicing) at the far corner of the box (every parameter at its maximum) loses its firing
      // order at 2000 rpm
      const pilot = garageDefault('v8-na-50');
      const s = new VoicingSpace(pilot);
      const def: EngineDef = { ...pilot, voicing: s.decode(s.params.map(() => 1)) };
      const r = await tuneEngine({ def, refs: [], otherRefs: {}, targets: TARGETS }, { strategy, iterations: 0, seed: 1 });
      expect(r.renders).toBe(0);
      expect(r.rejected).toBe(1);
      expect(r.baseline.rejected).toMatch(/firing order 4 is not among the top 3 orders at 2000 rpm/);
      expect(r.baseline.objective).toBeNull();
    });
  }
});

// ───────────────────────────── candidate evaluation in worker threads ─────────────────────────────

describe('candidate evaluation in worker threads', () => {
  const LIFTOFF = RENDER_PLAN.find((p) => p.segment === 'liftoff6k');
  if (LIFTOFF === undefined) throw new Error('liftoff6k missing');
  const targets: RenderTarget[] = [{ plan: LIFTOFF, perspective: 'cabin' }];
  /** A voicing assertEngineFits refuses at once, with a message naming its section count. */
  const unfit = (v: EngineVoicing, sections: number): EngineVoicing => ({
    ...structuredClone(v),
    exhaust: { ...structuredClone(v.exhaust), mufflerSectionsM: new Array<number>(sections).fill(0.2) },
  });

  it('returns every result in candidate order, whatever order the workers finish in', { timeout: 60_000 }, async () => {
    const def = loadFixture('v8-crossplane-test');
    const other = structuredClone(def.voicing);
    other.cabin.lowpassHz = 700;
    // index 0 renders (slow); 1–3 are refused at once and finish first; 4 renders
    const batch = [def.voicing, unfit(def.voicing, 5), unfit(def.voicing, 6), unfit(def.voicing, 7), other];
    const pool = workerEvaluator({ def, refs: [], otherRefs: {}, targets }, 4);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      const results = await pool.evaluate(batch);
      // each task carries one voicing; the problem (references included) went to each worker once, as workerData. The
      // spy sees every pool in this process, so count only the messages carrying this batch's voicings.
      const ours = posted.mock.calls.filter(([m]) => batch.includes((m as { voicing?: EngineVoicing }).voicing as EngineVoicing));
      expect(ours.map(([m]) => Object.keys(m as object).sort())).toEqual(batch.map(() => ['id', 'voicing']));
      expect(results.map((r) => (r.rejected === null ? 'rendered' : /got (\d)/.exec(r.rejected)?.[1]))).toEqual(['rendered', '5', '6', '7', 'rendered']);
      expect(results.map((r) => r.rendered)).toEqual([true, false, false, false, true]);
      expect(pool.threads).toBe(4);
      // exactly what this thread computes
      expect(await localEvaluator({ def, refs: [], otherRefs: {}, targets }).evaluate(batch)).toEqual(results);
    } finally {
      posted.mockRestore();
      await pool.close();
    }
  });

  it('starts no more workers than candidates are waiting', { timeout: 30_000 }, async () => {
    const def = loadFixture('v8-crossplane-test');
    const pool = workerEvaluator({ def, refs: [], otherRefs: {}, targets }, 16);
    try {
      await pool.evaluate([unfit(def.voicing, 5), unfit(def.voicing, 6)]);
      expect(pool.threads).toBe(2);
    } finally {
      await pool.close();
    }
  });

  it('fails loudly: a segment the workers cannot render, a module that does not load', { timeout: 30_000 }, async () => {
    const def = loadFixture('v8-crossplane-test');
    const custom: RenderTarget[] = [{ plan: { segment: 'tuneTestPull', kind: 'wot', scored: () => true }, perspective: 'cabin' }];
    expect(() => workerEvaluator({ def, refs: [], otherRefs: {}, targets: custom }, 2)).toThrow(/tuneTestPull.*workerModules/);
    const pool = workerEvaluator({ def, refs: [], otherRefs: {}, targets: custom }, 2, [pathToFileURL(join(dir, 'no-such-module.mjs')).href]);
    try {
      await expect(pool.evaluate([def.voicing])).rejects.toThrow(/no-such-module/);
    } finally {
      await pool.close();
    }
  });

  it('loads TypeScript in the workers: through the parent’s tsx when it runs under tsx, else through tsx’s loader', () => {
    const tsxCli = ['--require', '/r/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///r/node_modules/tsx/dist/loader.mjs'];
    expect(workerExecArgv(tsxCli)).toBeUndefined(); // inherited (Worker's default)
    expect(workerExecArgv(['--import', 'tsx'])).toBeUndefined();
    expect(workerExecArgv(['--import=tsx/esm'])).toBeUndefined();
    for (const parent of [[], ['--conditions', 'development', '--require', '/r/node_modules/vitest/suppress-warnings.cjs']]) {
      expect(workerExecArgv(parent)).toEqual(['--import', expect.stringMatching(/^file:\/\/.*\/tsx\/dist\/loader\.mjs$/)]);
    }
  });
});

// ───────────────────────────── validation (--apply; tuned engines in engines.test.ts) ─────────────────────────────

describe('validation of a tuned voicing', () => {
  it('schemaErrors: none for the garage; a value outside engine.schema.json is reported', () => {
    for (const e of ENGINES) expect(schemaErrors(e), e.id).toEqual([]);
    const bad = garage('v8-na-50');
    bad.voicing.cabin.lowpassHz = 5000;
    expect(schemaErrors(bad).join('\n')).toMatch(/lowpassHz/);
  });

  it('voicingInvariantFailures: a capacity violation is reported without rendering', () => {
    const bad = garage('v8-na-50');
    bad.voicing.headersM = bad.voicing.headersM.slice(1);
    expect(voicingInvariantFailures(bad)).toEqual([expect.stringMatching(/headersM/)]);
  });

  it('applyVoicing (--apply): a voicing engine.schema.json rejects is refused, the engine file untouched', () => {
    const def = loadFixture('v8-crossplane-test');
    const target = join(dir, 'refused.json');
    const before = `${JSON.stringify(def, null, 2)}\n`;
    writeFileSync(target, before);
    const lines: string[] = [];
    const voicing = { ...def.voicing, launchRpm: 500 }; // schema: 1000–10000 rpm (a field the tuner never moves)
    expect(applyVoicing(def, voicing, target, (l) => lines.push(l))).toBe(EXIT_NOT_TUNED);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(lines.join('\n')).toMatch(/not applied/);
    expect(lines.join('\n')).toMatch(/launchRpm/);
  });

  it('orderInvariantFailures: the firing order among the top 3 orders on the hot exhaust bus at 2k/4k/6k rpm', { timeout: 30_000 }, () => {
    const pilot = garageDefault('v8-na-50');
    expect(orderInvariantFailures(pilot)).toEqual([]);
    expect(orderInvariantFailures(garage('v8-na-50'))).toEqual([]); // the tuned voicing keeps it as well
    const s = new VoicingSpace(pilot);
    const far = orderInvariantFailures({ ...pilot, voicing: s.decode(s.params.map(() => 1)) });
    expect(far).toEqual([expect.stringMatching(/^firing order 4 is not among the top 3 orders at 2000 rpm \(top: /)]);
    expect(orderInvariantFailures(garage('rotary-twin-13'))).toEqual([]); // e-shaft order 2 dominates too
  });

  it('segmentInvariantFailures: every segment stays finite and ≤ −1 dBTP at +6 dB at both extreme corners of the box', { timeout: 120_000 }, () => {
    // Not checked per candidate (the output stage's limiter bounds the peak), so check the extremes of the box once.
    const def = garage('i5-turbo-25');
    const s = new VoicingSpace(def);
    for (const corner of [0, 1]) {
      expect(segmentInvariantFailures({ ...def, voicing: s.decode(s.params.map(() => corner)) }), `corner ${corner}`).toEqual([]);
    }
  });
});

// ───────────────────────────── CLI on a pseudo-reference library ─────────────────────────────

/** The closed-throttle fall of liftoff6k (its scored span) as mono audio, with keyframes every 0.05 s from the DSP's own rpm. */
function liftoffRecording(def: EngineDef): { audio: Float32Array; rpm: [number, number][] } {
  const seg = SEGMENTS.find((s) => s.name === 'liftoff6k');
  const plan = RENDER_PLAN.find((p) => p.segment === 'liftoff6k');
  if (seg === undefined || plan === undefined) throw new Error('liftoff6k missing');
  const { left, right } = renderSegment(def, seg, { perspective: 'cabin', subwoofer: 'yes', fs: FS });
  const tl = renderTimeline(def.spec, seg, plan, 'cabin', left.length, FS);
  const a = tl.scored.indexOf(1);
  const b = tl.scored.lastIndexOf(1) + 1;
  const audio = new Float32Array(b - a);
  for (let i = 0; i < audio.length; i++) audio[i] = 0.5 * ((left[a + i] ?? 0) + (right[a + i] ?? 0));
  const rpm: [number, number][] = [];
  for (let k = a; k < b - 1; k += Math.round(0.05 * FS)) rpm.push([(k - a) / FS, tl.rpm[k] ?? Number.NaN]);
  rpm.push([(b - 1 - a) / FS, tl.rpm[b - 1] ?? Number.NaN]);
  return { audio, rpm };
}

/** Child processes still running: stopped after the file (a test filter may skip the tests that wait for them). */
const children = new Map<ChildProcess, Promise<unknown>>();
afterAll(async () => {
  for (const child of children.keys()) child.kill();
  await Promise.all(children.values());
});

/** Runs `node <args>` in the repository; resolves with the exit code and output. */
function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, args, { cwd: ROOT, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      children.delete(child);
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
    });
    children.set(child, new Promise((done) => child.once('close', done)));
  });
  return run;
}

const cliEngine = loadFixture('v8-crossplane-test');
const lib = join(dir, 'lab-refs');
const enginePath = join(dir, 'engines', `${cliEngine.id}.json`);
/** The --apply run's own copy of the engine file (the runs overlap; nothing else writes an engine file). */
const applyPath = join(dir, 'engines-apply', `${cliEngine.id}.json`);
const TUNED = ['intake.gain', 'cabin.lowpassHz'];
let detunedJson = '';
const cliArgs = (engine: string, out: string, ...extra: string[]): string[] => [
  engine,
  '--refs',
  lib,
  '--out',
  join(dir, out),
  '--iterations',
  '2',
  '--params',
  TUNED.join(','),
  ...extra,
];
const report = (out: string): TuneReport => JSON.parse(readFileSync(join(dir, out, cliEngine.id, 'best.json'), 'utf8')) as TuneReport;
const bestJson = (out: string): Buffer => readFileSync(join(dir, out, cliEngine.id, 'best.json'));
type NodeRun = Awaited<ReturnType<typeof runNode>>;
/**
 * `tsx tools/tune.ts` runs (npm run tune) in child processes, so that their worker threads load TypeScript the way the
 * CLI's do. They start with the file and need nothing from this thread, so they run alongside the tests above:
 * one worker thread (out-1), seed 2 (out-seed), and --apply with four worker threads (out-3).
 */
let cliRuns: Promise<{ one: NodeRun; seed: NodeRun; apply: NodeRun }>;

beforeAll(() => {
  // two clips of one "recording": the original engine's lift-off, keyframed with its known rpm
  const rec = liftoffRecording(cliEngine);
  mkdirSync(join(lib, cliEngine.id), { recursive: true });
  for (const clipId of ['orig-a', 'orig-b']) {
    writeWav(join(lib, cliEngine.id, `${clipId}.wav`), [rec.audio], FS);
    const segments = [{ kind: 'liftoff', startS: 0, endS: rec.audio.length / FS, rpm: rec.rpm }];
    writeFileSync(join(lib, cliEngine.id, `${clipId}.json`), JSON.stringify({ clipId, perspective: 'cabin', segments }));
  }
  // the engine to tune: the original with its intake gain and cabin low-pass moved far off, as if signed off
  // (estimated false), so that --apply has to mark the tuned voicing as an estimate again
  const s = new VoicingSpace(cliEngine, TUNED);
  const off = s.decode(s.encode(cliEngine.voicing).map((u) => (u < 0.5 ? u + 0.45 : u - 0.45)));
  const detuned: EngineDef = { ...cliEngine, voicing: { ...off, estimated: false } };
  detunedJson = `${JSON.stringify(detuned, null, 2)}\n`;
  for (const path of [enginePath, applyPath]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, detunedJson);
  }
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const tune = (args: string[]): Promise<NodeRun> => runNode([tsxCli, 'tools/tune.ts', ...args]);
  cliRuns = (async () => {
    const [one, seed, apply] = await Promise.all([
      tune(cliArgs(enginePath, 'out-1', '--workers', '1')),
      tune([...cliArgs(enginePath, 'out-seed'), '--seed', '2']),
      tune(cliArgs(applyPath, 'out-3', '--apply', '--workers', '4')),
    ]);
    return { one, seed, apply };
  })();
}, 60_000);

describe('tesbox-tune CLI (pseudo-reference library)', () => {
  it('writes best.json (voicing + score + generation log) and leaves the engine file alone without --apply', { timeout: 240_000 }, async () => {
    const { one, seed } = await cliRuns;
    expect(one.stderr).toBe('');
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/evaluating candidates in up to 1 worker thread\n/);
    expect(one.stdout).toMatch(/candidates evaluated in 1 worker thread\n/);
    expect(one.stdout).toMatch(/renders\/s\)/); // the summary line reports the evaluation rate (stdout only, never best.json)
    expect(bestJson('out-1').toString('utf8')).not.toContain(dir); // no host paths
    const r = report('out-1');
    expect(r.engineId).toBe(cliEngine.id);
    expect([r.strategy, r.seed, r.iterations]).toEqual(['cmaes', 1, 2]);
    expect(r.targets).toEqual([{ segment: 'liftoff6k', kind: 'liftoff', perspective: 'cabin' }]);
    expect(r.params.map((p) => p.key)).toEqual(TUNED);
    // the generation log: generation 0 is the baseline at σ₀; then λ = 4 + ⌊3 ln 2⌋ = 6 candidates per generation
    const generations = r.log.filter((l) => l.phase === 'cmaes');
    expect(generations[0]).toMatchObject({ generation: 0, step: 'init', sigma: 0.25, evaluations: 1, renders: 1 });
    expect(generations.map((l) => [l.generation, l.evaluations])).toEqual([
      [0, 1],
      [1, 7],
      [2, 13],
    ]);
    expect(generations.every((l) => Number.isFinite(l.sigma) && l.sigma > 0)).toBe(true);
    expect(r.log.length).toBe(r.iterationsRun + 1 + r.polishSweeps);
    // a candidate asked for again is not rendered again: here every polish move is followed by a sweep that steps back
    expect(polishRevisits(r)).toBeGreaterThan(0);
    expect(r.renders).toBeLessThanOrEqual(r.evaluations - polishRevisits(r));
    expect(r.best.voicing.estimated).toBe(false); // the voicing as searched; only --apply marks it as an estimate
    expect(r.best.score?.engineId).toBe(cliEngine.id);
    expect(r.best.score?.unscored).toBe(false);
    expect(r.improved).toBe(true);
    expect(r.best.composite ?? 0).toBeGreaterThan(r.baseline.composite ?? 1);
    expect(r.best.objective ?? 0).toBeLessThan(r.baseline.objective ?? 0);
    // without --apply the engine file is left alone
    expect(readFileSync(enginePath, 'utf8')).toBe(detunedJson);
    // a different seed draws different candidates
    expect(seed.code).toBe(0);
    expect(report('out-seed').log[0]?.evaluations).toBe(r.log[0]?.evaluations);
    expect(JSON.stringify(report('out-seed').log)).not.toBe(JSON.stringify(r.log));
  });

  it('--apply writes the best voicing into the engine file: estimated true, nothing else changes', { timeout: 240_000 }, async () => {
    const { apply } = await cliRuns;
    expect(apply.stderr).toBe('');
    expect(apply.code).toBe(0);
    expect(apply.stdout).toMatch(/evaluating candidates in up to 4 worker threads\n/);
    expect(apply.stdout).toMatch(/candidates evaluated in 4 worker threads\n/);
    // deterministic whatever the worker count: the same seed gives a byte-identical best.json (one thread vs four)
    expect(bestJson('out-3').equals(bestJson('out-1'))).toBe(true);
    const r = report('out-3');
    const text = readFileSync(applyPath, 'utf8');
    const written = JSON.parse(text) as EngineDef;
    expect(text).toBe(`${JSON.stringify(written, null, 2)}\n`);
    expect(written.voicing).toEqual({ ...r.best.voicing, estimated: true });
    expect(written.voicing.estimated).toBe(true); // the engine was signed off (false): a tuned voicing is an estimate again
    const before = JSON.parse(detunedJson) as EngineDef;
    expect(written.voicing).not.toEqual(before.voicing);
    expect({ ...written, voicing: null }).toEqual({ ...before, voicing: null });
    expect(schemaErrors(written)).toEqual([]);
  });

  it('main() in this process, its worker threads loading TypeScript through tsx’s loader: the same best.json again', { timeout: 120_000 }, async () => {
    await cliRuns;
    expect(await quietly(() => main(cliArgs(enginePath, 'out-2', '--workers', '6')))).toBe(0);
    expect(bestJson('out-2').equals(bestJson('out-1'))).toBe(true);
  });

  it('cannot tune without two usable reference clips: exit 1, nothing written', async () => {
    const empty = join(dir, 'no-refs');
    mkdirSync(empty, { recursive: true });
    const one = join(dir, 'one-ref', cliEngine.id);
    mkdirSync(one, { recursive: true });
    copyFileSync(join(lib, cliEngine.id, 'orig-a.wav'), join(one, 'orig-a.wav'));
    copyFileSync(join(lib, cliEngine.id, 'orig-a.json'), join(one, 'orig-a.json'));
    const engineBefore = readFileSync(enginePath, 'utf8');
    for (const refs of [empty, join(dir, 'one-ref')]) {
      expect(await quietly(() => main([enginePath, '--refs', refs, '--out', join(dir, 'out-4'), '--apply']))).toBe(EXIT_NOT_TUNED);
    }
    expect(existsSync(join(dir, 'out-4', cliEngine.id, 'best.json'))).toBe(false);
    expect(readFileSync(enginePath, 'utf8')).toBe(engineBefore);
  });

  it('--apply never writes a test fixture: an engine id outside src/data/engines is refused before any work', async () => {
    const fixture = join(ROOT, 'tests/fixtures/engines/v8-crossplane-test.json');
    const before = readFileSync(fixture, 'utf8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['v8-crossplane-test', '--refs', lib, '--out', join(dir, 'out-5'), '--apply'])).toBe(EXIT_USAGE);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/src\/data\/engines/));
    } finally {
      err.mockRestore();
    }
    expect(readFileSync(fixture, 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'out-5'))).toBe(false);
  });
});
