/**
 * tesbox-tune (phase 2b contract "Auto-tune (T6)", phase 5 contract P1 "Tuner v2"; spec §11.6): searches an engine's
 * voicing for the best score against the reference recordings of its inspiring car (lab-refs/, local only — never
 * committed or shipped).
 *
 *   tsx tools/tune.ts <engine-id> [--strategy cmaes|nm] [--iterations 60 (nm: 120)] [--workers N] [--seed 1]
 *                     [--apply] [--refs lab-refs] [--out renders/tune] [--params key,key]
 *
 * - References: loaded and analysed once, exactly as tools/score.ts does (loadRefClips: sidecars, "auto" rpm tracked
 *   inside the sidecar hints, one ClipFeatures per clip and kind); other engines' references feed discrimination.
 *   An engine with fewer than MIN_REF_CLIPS usable clips is unscored (spec §11.3) and is not tuned (exit 1); nor is
 *   one whose baseline render shares no comparable rpm bin with a reference (no voicing can change the bins).
 * - Search space: the TUNABLE voicing vector (VoicingSpace; phase 2b T6 as amended by D9 = phase 5 P0.3: one header
 *   scale per exhaust bank, one length per collector, the B18 whistle / outside levels and the B19 cabin leak), each
 *   parameter normalised to [0, 1] within its contract range; --params restricts the search to a subset. Spec fields
 *   (firing angles, ratios, rpm) are never tuned, nor is any voicing field outside the vector.
 * - Objective (minimised, objectiveOf): −composite + DISCRIMINATION_WEIGHT · max(0, best other composite − own
 *   composite + DISCRIMINATION_MARGIN), from src/lab/score.ts scoreEngine over every scored render segment.
 * - Candidates: each is checked with the DSP's own assertEngineFits (at MIN_SAMPLE_RATE, so it fits every supported
 *   rate) and the steady order invariants (orderInvariantFailures) before it is rendered, and must render without a
 *   non-finite reset; a candidate that fails is rejected (objective +∞), so the search never settles on a voicing
 *   --apply would refuse. Renders and features go through tools/score.ts renderClip — a candidate is measured exactly
 *   as `npm run score` measures the engine — for the contract segments whose kind and perspective a reference covers
 *   (renderTargets; the others cannot change the score).
 * - Strategy (--strategy): 'cmaes' (default) — the (μ/μ_W, λ)-CMA-ES of tools/cmaes.ts from the starting voicing's
 *   normalised vector, σ₀ = 0.25, λ = 4 + ⌊3 ln n⌋, candidates evaluated at their clamp into the box plus the boundary
 *   penalty, stopping after --iterations generations (default 60), at σ < 1e-3, or after 15 generations without a
 *   best-objective improvement ≥ 1e-4; or 'nm' — the Phase 2b bounded Nelder–Mead (nelderMead, every trial point
 *   projected into the box; --iterations simplex updates, default 120). Then, after either, the polish
 *   (patternSearch): a coordinate pattern search from the best point, steps 0.05 → 0.025 → 0.0125. The seed and the
 *   inputs fix the whole run (no clock, no host paths: bit-identical output).
 * - Parallel evaluation (--workers, default min(16, availableParallelism() − 2)): every search hands out batches of
 *   candidates (a CMA-ES generation, a polish sweep, Nelder–Mead's starting simplex and shrinks) whose members are
 *   evaluated in worker_threads (workerEvaluator; tools/tune-worker.ts), each worker receiving the references and their
 *   features once, at start-up. Candidates are generated before any of them is evaluated and every result is reduced in
 *   candidate order, so the run — best.json included — is identical for every worker count.
 * - Output: <out>/<engine-id>/best.json (TuneReport: best voicing + its EngineScore + the baseline + the log of
 *   generations / iterations and polish sweeps with σ and the best objective; no wall time, no worker count). --apply
 *   (applyVoicing) writes the best voicing (voicing.estimated set true: only the user's sign-off clears
 *   it) into src/data/engines/<engine-id>.json, or into the engine JSON given as a path — never into a test fixture —
 *   after the schema and then the DSP invariants (voicingInvariantFailures) accept it. The engine then has to be
 *   recorded as tuned in docs/sound-scores.md (tunedLine): tests/unit/engines.test.ts holds untuned engines to
 *   defaultVoicing and tuned ones to the schema and the same invariants.
 *
 * Exit code: 0; 1 (EXIT_NOT_TUNED) when nothing can be tuned (unscored engine, no scorable candidate) or --apply is
 * refused by the validation; 2 (EXIT_USAGE) on usage errors; 3 (EXIT_ERROR) when the run itself fails.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Ajv2020 from 'ajv/dist/2020';
import { QUANTUM, type EngineDef, type EngineSpec, type EngineVoicing, type Perspective } from '../src/contracts';
import engineSchema from '../src/data/schema/engine.schema.json';
import { dominantOrders, orderSpectrum, truePeakDbtp } from '../src/dsp/analysis';
import { MIN_SAMPLE_RATE, TesboxDspCore, assertEngineFits } from '../src/dsp/dsp-core';
import { Rng } from '../src/dsp/util';
import type { ClipFeatures } from '../src/lab/features';
import { scoreEngine, type EngineScore } from '../src/lab/score';
import { CMAES_SIGMA0, cmaesSearch, finiteOrWorst, searchBatched, searchSync, type BatchSearch } from './cmaes';
import { DEFAULT_REFS, FS, MIN_REF_CLIPS, RENDER_PLAN, lensOf, loadRefClips, renderClip, type RenderPlanEntry } from './score';
import { loadEngine, renderSegment, resolveEngine } from './render';
import { SEGMENTS, createBaseControl } from './segments';

export const USAGE =
  'usage: tsx tools/tune.ts <engine-id> [--strategy cmaes|nm] [--iterations 60 (nm: 120)] [--workers N] [--seed 1] [--apply] ' +
  '[--refs lab-refs] [--out renders/tune] [--params key,key]';
/** Search strategies (contract P1): CMA-ES (the default) or the Phase 2b Nelder–Mead. */
export type TuneStrategy = 'cmaes' | 'nm';
export const TUNE_STRATEGIES: readonly TuneStrategy[] = ['cmaes', 'nm'];
export const DEFAULT_STRATEGY: TuneStrategy = 'cmaes';
/** Default --iterations of Nelder–Mead (simplex updates). */
export const DEFAULT_ITERATIONS = 120;
/** Default --iterations of CMA-ES (generations). */
export const DEFAULT_GENERATIONS = 60;
/** Default --workers: min(MAX_DEFAULT_WORKERS, availableParallelism() − 2), at least 1. */
export const MAX_DEFAULT_WORKERS = 16;
export const DEFAULT_SEED = 1;
export const DEFAULT_OUT = 'renders/tune';
/** Exit codes besides 0: nothing could be tuned or applied (reason printed), a usage error, a run that failed. */
export const EXIT_NOT_TUNED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 3;
/** Objective = −composite + DISCRIMINATION_WEIGHT · max(0, bestOther − own + DISCRIMINATION_MARGIN) (contract T6). */
export const DISCRIMINATION_WEIGHT = 0.5;
export const DISCRIMINATION_MARGIN = 0.02;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_DIR = join(REPO_ROOT, 'src', 'data', 'engines');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures');

// ───────────────────────────── the tunable voicing vector ─────────────────────────────

/**
 * The contract's TUNABLE vector, in contract order (phase 2b T6 as amended by D9, phase 5 contract P0.3). `.scale`
 * parameters multiply every entry of a list: `headersM.bank<b>.scale` the headers of exhaust bank b (one parameter per
 * bank the engine has), `exhaust.mufflerSectionsM.scale` every muffler section; `collectors[<c>].lengthM` is one
 * collector's length (one parameter per collector).
 */
export const PARAM_KEYS = [
  'pulse.widthDeg',
  'pulse.alpha',
  'pulse.beta',
  'pulse.cycleAsymmetry',
  'headersM.bank0.scale',
  'headersM.bank1.scale',
  'headersM.bank2.scale',
  'headersM.bank3.scale',
  'collectors[0].lengthM',
  'collectors[1].lengthM',
  'collectors[2].lengthM',
  'collectors[3].lengthM',
  'collectors[4].lengthM',
  'collectors[5].lengthM',
  'collectors[6].lengthM',
  'collectors[7].lengthM',
  'exhaust.midPipeM',
  'exhaust.mufflerSectionsM.scale',
  'exhaust.mufflerAction',
  'exhaust.tailpipeM',
  'intake.helmholtzHz',
  'intake.gain',
  'mechanical.blockGain',
  'mechanical.valvetrainGain',
  'cabin.lowpassHz',
  'cabin.leakDb',
  'forcedInduction.cabinGainDb',
  'forcedInduction.whistleDb',
  'forcedInduction.outsideGainDb',
] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

export interface TunableParam {
  key: ParamKey;
  /** Physical range searched; normalised coordinate 0 ↔ lo, 1 ↔ hi. */
  lo: number;
  hi: number;
}

/**
 * Pipe-section capacity (phase 2a contract B3, enforced by assertEngineFits): maxima per section kind, and the
 * shortest section — 4 samples at SPEED_OF_SOUND_MAX (700 m/s) at MIN_SAMPLE_RATE (28 kHz) = 0.1 m, so a tuned
 * voicing fits at every sample rate the app supports. Scaled lengths are clamped into these bounds.
 */
const MAX_HEADER_M = 1.5;
const MAX_COLLECTOR_M = 1.0;
const MAX_MUFFLER_SECTION_M = 0.8;
const MIN_SECTION_M = 0.1;
/** Exhaust banks a header scale can address (engine.schema.json: combustion[].bank 0–3). */
const HEADER_BANKS = [0, 1, 2, 3] as const;
/** Collectors a length can address (the exhaust network's MAX_COLLECTORS). */
const COLLECTOR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x !== x ? 0 : x;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** x rounded to `digits` decimals (k/10^d: the same double as the decimal literal). */
function round(x: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}

function mean(xs: readonly number[]): number {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : Number.NaN;
}

/** Mean of a[i] / b[i] (the scale of list a against list b). */
function meanRatio(a: readonly number[], b: readonly number[]): number {
  return mean(a.map((x, i) => x / (b[i] ?? Number.NaN)));
}

interface ParamRule {
  key: ParamKey;
  range(def: EngineDef): [number, number];
  /** Inapplicable to this engine: the reason (e.g. no forced induction), else null. */
  inapplicable(def: EngineDef): string | null;
  /** Physical value in `v`: the field, or for `.scale` parameters the mean ratio of v's list to the base's. */
  get(v: EngineVoicing, base: EngineVoicing, spec: EngineSpec): number;
  /** Writes `value` (inside the range) into `v`, rounded to the parameter's grid and clamped to capacity. */
  set(v: EngineVoicing, base: EngineVoicing, value: number, spec: EngineSpec): void;
}

const always = (): null => null;

/** A plain numeric field with a fixed range, rounded to `digits` decimals. */
function field(
  key: ParamKey,
  lo: number,
  hi: number,
  digits: number,
  get: (v: EngineVoicing) => number,
  put: (v: EngineVoicing, x: number) => void,
): ParamRule {
  return {
    key,
    range: () => [lo, hi],
    inapplicable: always,
    get: (v) => get(v),
    set: (v, _base, value) => put(v, clamp(round(value, digits), lo, hi)),
  };
}

/** Lengths in metres are rounded to the millimetre. */
const MM = 3;

/**
 * Exhaust bank of header i: its combustion entry's bank, the key the exhaust network routes header i by (a bank joins
 * the first collector listing it, or collector 0; phase 2a amendment B11) — so one scale moves exactly the headers the
 * network groups as that bank.
 */
function headerBank(spec: EngineSpec, i: number): number {
  return spec.combustion[i]?.bank ?? 0;
}

/** One scale (0.7–1.4) for the headers of exhaust bank `bank`, clamped to the contract maxima; applies when the bank has any. */
function bankScale(key: ParamKey, bank: number): ParamRule {
  const inBank = (spec: EngineSpec, n: number): number[] => Array.from({ length: n }, (_, i) => i).filter((i) => headerBank(spec, i) === bank);
  return {
    key,
    range: () => [0.7, 1.4],
    inapplicable: (def) => (inBank(def.spec, def.voicing.headersM.length).length > 0 ? null : `the engine has no bank ${bank}`),
    get: (v, base, spec) => {
      const idx = inBank(spec, v.headersM.length);
      return meanRatio(
        idx.map((i) => v.headersM[i] ?? Number.NaN),
        idx.map((i) => base.headersM[i] ?? Number.NaN),
      );
    },
    set: (v, base, s, spec) => {
      for (const i of inBank(spec, v.headersM.length)) {
        v.headersM[i] = clamp(round((base.headersM[i] ?? Number.NaN) * s, MM), MIN_SECTION_M, MAX_HEADER_M);
      }
    },
  };
}

/** The length of collector `c` within the pipe-section capacity (0.1–1.0 m); applicable when the voicing has it. */
function collectorLength(key: ParamKey, c: number): ParamRule {
  return {
    key,
    range: () => [MIN_SECTION_M, MAX_COLLECTOR_M],
    inapplicable: (def) => (c < def.voicing.collectors.length ? null : `the voicing has no collectors[${c}]`),
    get: (v) => v.collectors[c]?.lengthM ?? Number.NaN,
    set: (v, _base, length) => {
      const col = v.collectors[c];
      if (col !== undefined) col.lengthM = clamp(round(length, MM), MIN_SECTION_M, MAX_COLLECTOR_M);
    },
  };
}

const noForcedInduction = (def: EngineDef): string | null => (def.voicing.forcedInduction === null ? 'the engine has no forced induction' : null);

const RULES: readonly ParamRule[] = [
  {
    key: 'pulse.widthDeg',
    // 40–90° (4-stroke), 200–300° (rotary: a rotor face's port stays open far longer)
    range: (def) => (def.spec.layout.type === 'rotary' ? [200, 300] : [40, 90]),
    inapplicable: always,
    get: (v) => v.pulse.widthDeg,
    set: (v, _base, value) => {
      v.pulse.widthDeg = round(value, 1);
    },
  },
  field('pulse.alpha', 3, 20, 2, (v) => v.pulse.alpha, (v, x) => (v.pulse.alpha = x)),
  field('pulse.beta', 1, 10, 2, (v) => v.pulse.beta, (v, x) => (v.pulse.beta = x)),
  field('pulse.cycleAsymmetry', 0, 0.5, 3, (v) => v.pulse.cycleAsymmetry, (v, x) => (v.pulse.cycleAsymmetry = x)),
  // Per-bank header scales and per-collector lengths (D9): bank-asymmetric exhausts keep the half-orders that
  // identical banks cancel.
  ...HEADER_BANKS.map((b) => bankScale(`headersM.bank${b}.scale`, b)),
  ...COLLECTOR_SLOTS.map((c) => collectorLength(`collectors[${c}].lengthM`, c)),
  field('exhaust.midPipeM', 0.6, 3.0, MM, (v) => v.exhaust.midPipeM, (v, x) => (v.exhaust.midPipeM = x)),
  {
    key: 'exhaust.mufflerSectionsM.scale',
    range: () => [0.6, 1.6],
    inapplicable: always,
    get: (v, base) => meanRatio(v.exhaust.mufflerSectionsM, base.exhaust.mufflerSectionsM),
    set: (v, base, s) => {
      v.exhaust.mufflerSectionsM = base.exhaust.mufflerSectionsM.map((m) => clamp(round(m * s, MM), MIN_SECTION_M, MAX_MUFFLER_SECTION_M));
    },
  },
  field('exhaust.mufflerAction', 0, 1, 3, (v) => v.exhaust.mufflerAction, (v, x) => (v.exhaust.mufflerAction = x)),
  field('exhaust.tailpipeM', 0.2, 1.2, MM, (v) => v.exhaust.tailpipeM, (v, x) => (v.exhaust.tailpipeM = x)),
  field('intake.helmholtzHz', 60, 300, 1, (v) => v.intake.helmholtzHz, (v, x) => (v.intake.helmholtzHz = x)),
  field('intake.gain', 0, 1, 3, (v) => v.intake.gain, (v, x) => (v.intake.gain = x)),
  field('mechanical.blockGain', 0, 1, 3, (v) => v.mechanical.blockGain, (v, x) => (v.mechanical.blockGain = x)),
  // The full schema ranges (D9): the recordings' 0.8–2.5 kHz band is mostly engine harmonics.
  field('mechanical.valvetrainGain', 0, 1, 3, (v) => v.mechanical.valvetrainGain, (v, x) => (v.mechanical.valvetrainGain = x)),
  field('cabin.lowpassHz', 200, 2000, 0, (v) => v.cabin.lowpassHz, (v, x) => (v.cabin.lowpassHz = x)),
  field('cabin.leakDb', -60, -10, 1, (v) => v.cabin.leakDb, (v, x) => (v.cabin.leakDb = x)),
  {
    // Contract range −24 … −6 dB, limited to the −20 … −10 dB that engine.schema.json and contracts.ts allow, so a
    // tuned voicing always validates.
    key: 'forcedInduction.cabinGainDb',
    range: () => [-20, -10],
    inapplicable: noForcedInduction,
    get: (v) => v.forcedInduction?.cabinGainDb ?? Number.NaN,
    set: (v, _base, value) => {
      if (v.forcedInduction !== null) v.forcedInduction.cabinGainDb = clamp(round(value, 1), -20, -10);
    },
  },
  {
    // Phase 2a amendment B18: the turbo whistle alone (a supercharger's whine ignores it).
    key: 'forcedInduction.whistleDb',
    range: () => [-60, 0],
    inapplicable: (def) =>
      def.voicing.forcedInduction === null || def.spec.aspiration.type !== 'turbo' ? 'the engine has no turbo whistle' : null,
    get: (v) => v.forcedInduction?.whistleDb ?? Number.NaN,
    set: (v, _base, value) => {
      if (v.forcedInduction !== null) v.forcedInduction.whistleDb = clamp(round(value, 1), -60, 0);
    },
  },
  {
    // B18: the forced-induction bus in the outside mix.
    key: 'forcedInduction.outsideGainDb',
    range: () => [-60, 0],
    inapplicable: noForcedInduction,
    get: (v) => v.forcedInduction?.outsideGainDb ?? Number.NaN,
    set: (v, _base, value) => {
      if (v.forcedInduction !== null) v.forcedInduction.outsideGainDb = clamp(round(value, 1), -60, 0);
    },
  },
];

function isParamKey(k: string): k is ParamKey {
  return (PARAM_KEYS as readonly string[]).includes(k);
}

/**
 * The tunable vector of one engine: every applicable parameter (or the given subset, kept in contract order), each
 * normalised to [0, 1] within its range. `.scale` parameters are relative to the base voicing (1 = the base).
 */
export class VoicingSpace {
  readonly base: EngineDef;
  readonly params: readonly TunableParam[];
  private readonly rules: readonly ParamRule[];

  constructor(base: EngineDef, keys?: readonly string[]) {
    if (keys !== undefined) {
      if (keys.length === 0) throw new RangeError('VoicingSpace: tune at least one parameter');
      const unknown = keys.filter((k) => !isParamKey(k));
      if (unknown.length > 0) throw new RangeError(`VoicingSpace: unknown parameter key(s) ${unknown.join(', ')} (known: ${PARAM_KEYS.join(', ')})`);
    }
    const rules = RULES.filter((r) => keys === undefined || keys.includes(r.key));
    for (const r of rules) {
      const why = r.inapplicable(base);
      if (why !== null && keys !== undefined) throw new RangeError(`VoicingSpace: ${r.key} cannot be tuned on ${base.id}: ${why}`);
    }
    this.base = base;
    this.rules = rules.filter((r) => r.inapplicable(base) === null);
    this.params = this.rules.map((r) => {
      const [lo, hi] = r.range(base);
      return { key: r.key, lo, hi };
    });
  }

  /** Physical value of every parameter in `v` (`.scale` parameters: the scale against the base voicing). */
  values(v: EngineVoicing): number[] {
    return this.rules.map((r) => r.get(v, this.base.voicing, this.base.spec));
  }

  /** Normalised coordinates of `v`, each clamped into [0, 1]. */
  encode(v: EngineVoicing): number[] {
    return this.values(v).map((value, i) => {
      const p = this.params[i];
      return p === undefined ? 0 : clamp01((value - p.lo) / (p.hi - p.lo));
    });
  }

  /** A fresh voicing: the base voicing with every parameter set from x (clamped into [0, 1]). Never mutates the base. */
  decode(x: readonly number[]): EngineVoicing {
    if (x.length !== this.rules.length) throw new RangeError(`VoicingSpace.decode: ${x.length} coordinates for ${this.rules.length} parameters`);
    const base = this.base.voicing;
    const v = structuredClone(base);
    this.rules.forEach((r, i) => {
      const p = this.params[i];
      if (p !== undefined) r.set(v, base, p.lo + clamp01(x[i] ?? 0) * (p.hi - p.lo), this.base.spec);
    });
    return v;
  }
}

// ───────────────────────────── bounded Nelder–Mead ─────────────────────────────

/** Convergence: every vertex within NM_XTOL (∞-norm, normalised units) of the best and every value within NM_FTOL. */
export const NM_XTOL = 1e-4;
export const NM_FTOL = 1e-8;
/** Starting simplex: vertex i moves coordinate i − 1 by 0.10–0.25 (seeded size and direction, pointing into the box). */
const INIT_STEP_MIN = 0.1;
const INIT_STEP_SPAN = 0.15;

export type NelderMeadStep = 'init' | 'reflect' | 'expand' | 'contract-out' | 'contract-in' | 'shrink';

export interface NelderMeadOptions {
  /** Simplex updates; 0 evaluates x0 only. */
  iterations: number;
  seed: number;
  xtol?: number;
  ftol?: number;
  /** Called with each history entry as it is logged (progress reporting). */
  onIteration?: (it: NelderMeadIteration) => void;
}

export interface NelderMeadIteration {
  /** 0: the starting simplex. */
  iteration: number;
  step: NelderMeadStep;
  /** Objective evaluations so far. */
  evaluations: number;
  bestF: number;
  bestX: number[];
  /** Largest ∞-norm distance of a vertex from the best. */
  diameter: number;
}

export interface NelderMeadResult {
  x: number[];
  f: number;
  iterations: number;
  evaluations: number;
  converged: boolean;
  history: NelderMeadIteration[];
}

/** The seeded starting simplex around x0 (clamped into [0, 1]^n): x0 first, then one vertex per coordinate. */
export function initialSimplex(x0: readonly number[], seed: number): number[][] {
  const rng = new Rng(seed);
  const v0 = x0.map(clamp01);
  const simplex = [v0];
  for (let i = 0; i < v0.length; i++) {
    const size = INIT_STEP_MIN + INIT_STEP_SPAN * rng.next();
    let dir = rng.next() < 0.5 ? -1 : 1;
    const xi = v0[i] ?? 0;
    if (xi + dir * size > 1 || xi + dir * size < 0) dir = -dir; // size ≤ 0.25 < ½: the other side always fits
    const v = [...v0];
    v[i] = clamp01(xi + dir * size);
    simplex.push(v);
  }
  return simplex;
}

/**
 * Minimises f over the box [0, 1]^n with the Nelder–Mead simplex method (Nelder & Mead 1965; step and tie rules of
 * Lagarias et al. 1998; dimension-adaptive coefficients of Gao & Han 2012). Bounded by projection: every trial
 * point is clamped into the box before it is evaluated. A non-finite value counts as +∞. Deterministic for a seed.
 */
export function nelderMead(f: (x: readonly number[]) => number, x0: readonly number[], o: NelderMeadOptions): NelderMeadResult {
  return searchSync(nelderMeadSearch(x0, o), f);
}

/**
 * nelderMead as a batch search (tools/cmaes.ts BatchSearch): the same points in the same order, asked for one at a
 * time except the starting simplex and a shrink's new vertices, which are independent of each other's values and so
 * are asked for together (evaluated in parallel by tuneEngine).
 */
export function* nelderMeadSearch(x0: readonly number[], o: NelderMeadOptions): BatchSearch<NelderMeadResult> {
  const xtol = o.xtol ?? NM_XTOL;
  const ftol = o.ftol ?? NM_FTOL;
  let evaluations = 0;
  /** The values of `points`, in order; a non-finite value counts as +∞. */
  function* values(points: number[][]): Generator<number[][], number[], number[]> {
    evaluations += points.length;
    const ys = yield points;
    return points.map((_, i) => finiteOrWorst(ys[i]));
  }
  const history: NelderMeadIteration[] = [];
  const push = (h: NelderMeadIteration): void => {
    history.push(h);
    o.onIteration?.(h);
  };
  if (o.iterations <= 0) {
    const x = x0.map(clamp01);
    const [f0 = Number.POSITIVE_INFINITY] = yield* values([x]);
    push({ iteration: 0, step: 'init', evaluations, bestF: f0, bestX: [...x], diameter: 0 });
    return { x, f: f0, iterations: 0, evaluations, converged: false, history };
  }
  const n = x0.length;
  const m = Math.max(n, 2); // Gao–Han coefficients; n = 1 keeps the classic ones (their shrink factor would be 0)
  const ALPHA = 1;
  const BETA = 1 + 2 / m;
  const GAMMA = 0.75 - 1 / (2 * m);
  const DELTA = 1 - 1 / m;

  let pts = initialSimplex(x0, o.seed);
  let fx = yield* values(pts);
  const order = (): void => {
    const idx = pts.map((_, i) => i).sort((a, b) => (fx[a] ?? 0) - (fx[b] ?? 0) || a - b);
    pts = idx.map((i) => pts[i] ?? []);
    fx = idx.map((i) => fx[i] ?? Number.POSITIVE_INFINITY);
  };
  const diameter = (): number => {
    const best = pts[0] ?? [];
    let d = 0;
    for (const p of pts) for (let j = 0; j < n; j++) d = Math.max(d, Math.abs((p[j] ?? 0) - (best[j] ?? 0)));
    return d;
  };
  const along = (from: readonly number[], to: readonly number[], t: number): number[] => from.map((a, j) => clamp01(a + t * ((to[j] ?? 0) - a)));
  const log = (iteration: number, step: NelderMeadStep): void => {
    push({ iteration, step, evaluations, bestF: fx[0] ?? Number.POSITIVE_INFINITY, bestX: [...(pts[0] ?? [])], diameter: diameter() });
  };
  order();
  log(0, 'init');

  let iterations = 0;
  let converged = false;
  while (iterations < o.iterations) {
    const fBest = fx[0] ?? Number.POSITIVE_INFINITY;
    const fWorst = fx[n] ?? Number.POSITIVE_INFINITY;
    if (diameter() <= xtol && fWorst - fBest <= ftol) {
      converged = true;
      break;
    }
    iterations++;
    const worst = pts[n] ?? [];
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] = (centroid[j] ?? 0) + (pts[i]?.[j] ?? 0) / n;
    const fSecond = fx[n - 1] ?? Number.POSITIVE_INFINITY;
    // reflection xr = c + α(c − worst)
    const xr = along(centroid, worst, -ALPHA);
    const [fr = Number.POSITIVE_INFINITY] = yield* values([xr]);
    let step: NelderMeadStep;
    let accepted: [number[], number] | null = null;
    if (fr < fBest) {
      const xe = along(centroid, xr, BETA);
      const [fe = Number.POSITIVE_INFINITY] = yield* values([xe]);
      if (fe < fr) {
        accepted = [xe, fe];
        step = 'expand';
      } else {
        accepted = [xr, fr];
        step = 'reflect';
      }
    } else if (fr < fSecond) {
      accepted = [xr, fr];
      step = 'reflect';
    } else if (fr < fWorst) {
      const xc = along(centroid, xr, GAMMA);
      const [fc = Number.POSITIVE_INFINITY] = yield* values([xc]);
      step = 'contract-out';
      if (fc <= fr) accepted = [xc, fc];
    } else {
      const xcc = along(centroid, worst, GAMMA);
      const [fcc = Number.POSITIVE_INFINITY] = yield* values([xcc]);
      step = 'contract-in';
      if (fcc < fWorst) accepted = [xcc, fcc];
    }
    if (accepted !== null) {
      pts[n] = accepted[0];
      fx[n] = accepted[1];
    } else {
      step = 'shrink';
      const best = pts[0] ?? [];
      const shrunk: number[][] = [];
      for (let i = 1; i <= n; i++) shrunk.push(along(best, pts[i] ?? [], DELTA));
      const fs = yield* values(shrunk);
      for (let i = 1; i <= n; i++) {
        pts[i] = shrunk[i - 1] ?? [];
        fx[i] = fs[i - 1] ?? Number.POSITIVE_INFINITY;
      }
    }
    order();
    log(iterations, step);
  }
  return { x: [...(pts[0] ?? [])], f: fx[0] ?? Number.POSITIVE_INFINITY, iterations, evaluations, converged, history };
}

// ───────────────────────────── polish: coordinate pattern search ─────────────────────────────

/** Step sizes of the polish (normalised units, contract P1), finest last, and its sweep limit. */
export const POLISH_STEPS: readonly number[] = [0.05, 0.025, 0.0125];
export const POLISH_MAX_SWEEPS = 8;

export interface PolishSweep {
  /** 1, 2, … */
  sweep: number;
  /** The step size of the sweep (normalised units). */
  step: number;
  /** The sweep's best move improved on the current point and was taken. */
  moved: boolean;
  /** The current point after the sweep and its value. */
  bestF: number;
  bestX: number[];
  /** Objective evaluations so far. */
  evaluations: number;
}

export interface PolishResult {
  x: number[];
  f: number;
  sweeps: number;
  evaluations: number;
  history: PolishSweep[];
}

/**
 * The polish after either strategy (contract P1): a coordinate pattern search from x0 (value f0) on the box. A sweep
 * asks for both directions of every coordinate at the current step — x ± step·e_i, coordinate by coordinate, + first,
 * moves the boundary blocks left out — as one batch, and takes its best move (the earlier candidate on a tie) if it
 * improves strictly on the current value; a sweep without an improving move halves the step (0.05 → 0.025 → 0.0125).
 * Stops when no move improves at the finest step, or after POLISH_MAX_SWEEPS sweeps. Non-finite values count as +∞.
 */
export function* patternSearch(x0: readonly number[], f0: number, o: { onSweep?: (s: PolishSweep) => void } = {}): BatchSearch<PolishResult> {
  let x = x0.map(clamp01);
  let f = finiteOrWorst(f0);
  let level = 0;
  let evaluations = 0;
  const history: PolishSweep[] = [];
  for (let sweep = 1; sweep <= POLISH_MAX_SWEEPS; sweep++) {
    const step = POLISH_STEPS[level] ?? 0;
    const moves: number[][] = [];
    for (let i = 0; i < x.length; i++) {
      for (const dir of [1, -1]) {
        const from = x[i] ?? 0;
        const to = clamp01(from + dir * step);
        if (to === from) continue; // the boundary blocks this move
        const y = [...x];
        y[i] = to;
        moves.push(y);
      }
    }
    evaluations += moves.length;
    const values = moves.length > 0 ? yield moves : [];
    let best = -1;
    let bestValue = f;
    moves.forEach((_, k) => {
      const v = finiteOrWorst(values[k]);
      if (v < bestValue) {
        best = k;
        bestValue = v;
      }
    });
    const moved = best >= 0;
    if (moved) {
      x = moves[best] ?? x;
      f = bestValue;
    }
    const h: PolishSweep = { sweep, step, moved, bestF: f, bestX: [...x], evaluations };
    history.push(h);
    o.onSweep?.(h);
    if (!moved) {
      if (level === POLISH_STEPS.length - 1) break;
      level++;
    }
  }
  return { x, f, sweeps: history.length, evaluations, history };
}

// ───────────────────────────── objective ─────────────────────────────

/**
 * The value tune minimises (contract T6): −composite + DISCRIMINATION_WEIGHT · max(0, bestOther − own +
 * DISCRIMINATION_MARGIN), bestOther being the highest composite of the render against another engine's references
 * (no penalty when no other engine votes). +∞ when the composite is undefined (no comparable render/reference pair).
 */
export function objectiveOf(score: Pick<EngineScore, 'composite' | 'discrimination'>): number {
  const own = score.composite;
  if (own === null || !Number.isFinite(own)) return Number.POSITIVE_INFINITY;
  let bestOther = Number.NEGATIVE_INFINITY;
  for (const o of score.discrimination.others) {
    if (o.composite !== null && Number.isFinite(o.composite) && o.composite > bestOther) bestOther = o.composite;
  }
  const ownComposite = score.discrimination.ownComposite ?? own;
  const penalty = bestOther === Number.NEGATIVE_INFINITY ? 0 : Math.max(0, bestOther - ownComposite + DISCRIMINATION_MARGIN);
  return -own + DISCRIMINATION_WEIGHT * penalty;
}

// ───────────────────────────── tuning: problem, configuration, report ─────────────────────────────

/** One render per candidate: a contract segment (tools/score.ts RENDER_PLAN entry) in one perspective. */
export interface RenderTarget {
  plan: RenderPlanEntry;
  perspective: Perspective;
}

const PERSPECTIVES: readonly Perspective[] = ['cabin', 'outside'];

/**
 * What a candidate is rendered as: in each perspective that has own references (score renders only those), the
 * plan entries whose kind a reference of that perspective has — own or another engine's. scoreEngine pairs a render
 * only with references of its kind and perspective, so the entries left out could not change the score.
 */
export function renderTargets(
  refs: readonly ClipFeatures[],
  otherRefs: Record<string, readonly ClipFeatures[]>,
  plan: readonly RenderPlanEntry[] = RENDER_PLAN,
): RenderTarget[] {
  const all = [...refs, ...Object.values(otherRefs).flat()];
  const targets: RenderTarget[] = [];
  for (const perspective of PERSPECTIVES) {
    if (!refs.some((r) => r.perspective === perspective)) continue;
    const kinds = new Set(all.filter((r) => r.perspective === perspective).map((r) => r.kind));
    for (const entry of plan) if (kinds.has(entry.kind)) targets.push({ plan: entry, perspective });
  }
  return targets;
}

export interface TuneProblem {
  /** The engine as it stands: its spec, and the voicing the search starts from (the baseline). */
  def: EngineDef;
  /** Own reference features (tools/score.ts loadRefClips, one ClipFeatures per clip and kind). */
  refs: ClipFeatures[];
  /** Other engines' reference features by engine id (discrimination). */
  otherRefs: Record<string, ClipFeatures[]>;
  /** Default: renderTargets(refs, otherRefs). */
  targets?: readonly RenderTarget[];
}

export interface TuneConfig {
  /** Search strategy (default DEFAULT_STRATEGY: 'cmaes'). */
  strategy?: TuneStrategy;
  /** cmaes: generations; nm: simplex updates. */
  iterations: number;
  seed: number;
  /** Parameter keys to tune (default / null: the whole vector). */
  params?: readonly string[] | null;
  /** Worker threads to evaluate candidates in (workerEvaluator); 0, the default, evaluates them in this thread. */
  workers?: number;
  /** Modules every worker imports before its first candidate (workerEvaluator): render segments of the caller's own. */
  workerModules?: readonly string[];
}

export interface CandidateReport {
  /** objectiveOf(score); null when the candidate cannot be scored (rejected, or no comparable pair). */
  objective: number | null;
  composite: number | null;
  /** Normalised coordinates of the voicing in the tuned space. */
  x: number[];
  voicing: EngineVoicing;
  /** null for a rejected candidate. */
  score: EngineScore | null;
  /**
   * Why the candidate was refused, else null: assertEngineFits or the order invariants (it was not rendered), or a
   * non-finite reset while rendering.
   */
  rejected: string | null;
}

/** The search that logged a TuneLogEntry: the strategy, then the polish. */
export type TunePhase = TuneStrategy | 'polish';

export interface TuneLogEntry {
  phase: TunePhase;
  /** nm: the iteration (0: the starting simplex); cmaes: the generation (0: the baseline); polish: the sweep (1, 2, …). */
  generation: number;
  /** nm: the simplex step ('init' first); cmaes: 'init', then 'generation'; polish: 'sweep'. */
  step: NelderMeadStep | 'generation' | 'sweep';
  /**
   * The search's scale in normalised units — cmaes: σ after the generation; nm: the simplex size (largest ∞-norm
   * distance of a vertex from the best); polish: the sweep's step.
   */
  sigma: number;
  /** Objective evaluations so far (the baseline included; repeated candidates count, they are not re-rendered). */
  evaluations: number;
  /** Candidates rendered and scored so far. */
  renders: number;
  /** Best so far (baseline included). */
  objective: number | null;
  composite: number | null;
}

/**
 * Why the search ended: its --iterations budget; Nelder–Mead convergence ('converged'); CMA-ES σ < 1e-3 ('sigma') or
 * 15 generations without a best-objective improvement ≥ 1e-4 ('stagnation'); 'unscorable' when no render shares a
 * comparable rpm bin with a reference (nothing is searched).
 */
export type TuneStop = 'iterations' | 'converged' | 'sigma' | 'stagnation' | 'unscorable';

/** best.json. Identical for every worker count: it holds no timing and no worker count. */
export interface TuneReport {
  engineId: string;
  strategy: TuneStrategy;
  seed: number;
  /** Requested iterations (cmaes: generations); iterationsRun < iterations when the search stopped earlier (stop). */
  iterations: number;
  iterationsRun: number;
  /** The search stopped on its own criterion before its budget ('converged', 'sigma', 'stagnation'). */
  converged: boolean;
  stop: TuneStop;
  /** Polish sweeps run after the search (0: no candidate could be scored, nothing to polish). */
  polishSweeps: number;
  evaluations: number;
  renders: number;
  /** Distinct candidates refused: by assertEngineFits or the order invariants (never rendered), or for a non-finite render. */
  rejected: number;
  /** The renders every candidate is scored on. */
  targets: { segment: string; kind: string; perspective: Perspective }[];
  /** Tuned parameters: range, starting and best physical values (`.scale` parameters relative to the start). */
  params: { key: ParamKey; lo: number; hi: number; base: number; best: number }[];
  /** The starting voicing as it is. */
  baseline: CandidateReport;
  best: CandidateReport;
  /** best scores strictly better than the baseline. */
  improved: boolean;
  /** The strategy's iterations / generations (phase = strategy), then the polish sweeps (phase 'polish'). */
  log: TuneLogEntry[];
}

function finiteOrNull(x: number | null | undefined): number | null {
  return x !== null && x !== undefined && Number.isFinite(x) ? x : null;
}

function fmt(x: number | null, digits = 4): string {
  return x === null ? '—' : x.toFixed(digits);
}

// ───────────────────────────── candidate evaluation (this thread or worker threads) ─────────────────────────────

/** What evaluating one candidate voicing gives. */
export interface CandidateResult {
  /** objectiveOf(score); +∞ for a refused candidate or one without a comparable render/reference pair. */
  objective: number;
  /** null for a refused candidate. */
  score: EngineScore | null;
  /** Why the candidate was refused (CandidateReport.rejected), else null. */
  rejected: string | null;
  /** The candidate was rendered: it passed assertEngineFits and the order invariants. */
  rendered: boolean;
}

/** Evaluates the candidates of one problem; results in the order of the voicings given. */
export interface CandidateEvaluator {
  evaluate(voicings: readonly EngineVoicing[]): Promise<CandidateResult[]>;
  /** Worker threads started so far (0: candidates are evaluated in this thread). */
  readonly threads: number;
  /** Stops the worker threads. */
  close(): Promise<void>;
}

/**
 * Evaluation of one candidate voicing of `problem` (synchronous; what each worker thread runs): assertEngineFits at
 * MIN_SAMPLE_RATE, the steady order invariants (memoised on the exhaust-bus part of the voicing), then the renders
 * of every target through tools/score.ts renderClip, refused on a non-finite reset, scored by scoreEngine.
 */
export function candidateEvaluator(problem: TuneProblem): (voicing: EngineVoicing) => CandidateResult {
  const { def, refs, otherRefs } = problem;
  const lens = lensOf(def.spec);
  const targets = problem.targets ?? renderTargets(refs, otherRefs);
  const aspiration = def.spec.aspiration.type;
  // The order invariants see the exhaust bus only, which the intake, mechanical and cabin layers (and the cabin gain
  // of the forced-induction bus) never reach: memoised on the rest of the voicing.
  const orderMemo = new Map<string, string[]>();
  const exhaustKey = (v: EngineVoicing): string =>
    JSON.stringify({
      ...v,
      intake: null,
      mechanical: null,
      cabin: null,
      forcedInduction: v.forcedInduction === null ? null : { ...v.forcedInduction, cabinGainDb: null },
    });
  const refuse = (rejected: string, rendered: boolean): CandidateResult => ({ objective: Number.POSITIVE_INFINITY, score: null, rejected, rendered });
  return (voicing) => {
    const candidate: EngineDef = { ...def, voicing };
    const capacity = capacityFailure(candidate);
    if (capacity !== null) return refuse(capacity, false);
    const ek = exhaustKey(voicing);
    let order = orderMemo.get(ek);
    if (order === undefined) {
      order = orderInvariantFailures(candidate);
      orderMemo.set(ek, order);
    }
    if (order.length > 0) return refuse(order.join('; '), false);
    const clips = targets.map((t) => renderClip(candidate, t.plan, t.perspective, lens));
    const resets = clips.reduce((s, c) => s + c.report.nonFiniteResets, 0);
    if (resets > 0) return refuse(`${resets} non-finite reset(s) while rendering`, true);
    const score = scoreEngine(
      def.id,
      clips.map((c) => c.features),
      refs,
      otherRefs,
      { aspiration },
    );
    return { objective: objectiveOf(score), score, rejected: null, rendered: true };
  };
}

/** Evaluates candidates in this thread, one after the other. */
export function localEvaluator(problem: TuneProblem): CandidateEvaluator {
  const evaluate = candidateEvaluator(problem);
  return {
    threads: 0,
    evaluate: async (voicings) => voicings.map((v) => evaluate(v)),
    close: async () => undefined,
  };
}

/** Given once to each worker thread (workerData): the problem, its targets by segment name, the caller's modules. */
export interface TuneWorkerInit {
  def: EngineDef;
  refs: ClipFeatures[];
  otherRefs: Record<string, ClipFeatures[]>;
  targets: { segment: string; kind: string; perspective: Perspective }[];
  modules: string[];
}

/** A candidate for a worker, and the worker's answer. */
export interface TuneWorkerTask {
  id: number;
  voicing: EngineVoicing;
}
export type TuneWorkerReply = { id: number; result: CandidateResult } | { id: number; error: string };

const WORKER_URL = new URL('./tune-worker.ts', import.meta.url);
/** tsx's module loader (its `--import` entry point), for workers of a process that does not run under tsx (Vitest). */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** The value of a Node option argument ("--import=tsx" → "tsx"), or the argument itself. */
function optionValue(arg: string): string {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return eq >= 0 ? arg.slice(eq + 1) : arg;
}

/**
 * Node options of a tuning worker thread, which must load TypeScript: undefined — inherit the parent's (Worker's
 * default) — when the parent already runs under tsx (`tsx tools/tune.ts` runs node with tsx's preflight and loader;
 * `node --import tsx`), else `--import` of tsx's loader (e.g. inside Vitest, whose own module runner does not reach
 * worker threads).
 */
export function workerExecArgv(parent: readonly string[] = process.execArgv): string[] | undefined {
  const underTsx = parent.some((a) => {
    const v = optionValue(a);
    return v === 'tsx' || v.startsWith('tsx/') || /[\\/]tsx[\\/]dist[\\/]/.test(v);
  });
  return underTsx ? undefined : ['--import', TSX_LOADER];
}

/** Default --workers (contract P1): min(16, cores − 2), at least 1. */
export function defaultWorkers(cores: number = availableParallelism()): number {
  return Math.max(1, Math.min(MAX_DEFAULT_WORKERS, cores - 2));
}

/**
 * Evaluates candidates in up to `workers` worker threads (tools/tune-worker.ts), started as candidates wait for them.
 * Each worker receives the problem — references and their features included — once, at start-up, and evaluates one
 * candidate at a time with candidateEvaluator; results come back in candidate order whatever order the workers
 * finish in. Workers render the contract segments (RENDER_PLAN); a target on another segment needs `modules`: file
 * URLs each worker imports first, whose `segments` (tools/segments.ts Segment[]) it adds to SEGMENTS and whose
 * `renderPlan` (RenderPlanEntry[]) supplies the targets' plans. A worker that fails stops the pool: every pending
 * evaluation rejects.
 */
export function workerEvaluator(problem: TuneProblem, workers: number, modules: readonly string[] = []): CandidateEvaluator {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new RangeError(`workerEvaluator: workers must be an integer ≥ 1, got ${workers}`);
  const targets = problem.targets ?? renderTargets(problem.refs, problem.otherRefs);
  const foreign = targets.filter((t) => !RENDER_PLAN.includes(t.plan)).map((t) => t.plan.segment);
  if (foreign.length > 0 && modules.length === 0) {
    throw new Error(
      `workerEvaluator: worker threads render the contract segments (tools/score.ts RENDER_PLAN); ${foreign.join(', ')} ` +
        'needs workerModules that define it',
    );
  }
  const init: TuneWorkerInit = {
    def: problem.def,
    refs: problem.refs,
    otherRefs: problem.otherRefs,
    targets: targets.map((t) => ({ segment: t.plan.segment, kind: t.plan.kind, perspective: t.perspective })),
    modules: [...modules],
  };
  interface Task {
    id: number;
    voicing: EngineVoicing;
    resolve(r: CandidateResult): void;
    reject(e: Error): void;
  }
  interface Slot {
    worker: Worker;
    task: Task | null;
  }
  const slots: Slot[] = [];
  const queue: Task[] = [];
  let nextId = 0;
  let failure: Error | null = null;
  let closing = false;
  const fail = (e: Error): void => {
    if (failure !== null || closing) return;
    failure = e;
    const pending = [...queue.splice(0), ...slots.flatMap((s) => (s.task === null ? [] : [s.task]))];
    for (const s of slots) {
      s.task = null;
      void s.worker.terminate();
    }
    for (const t of pending) t.reject(e);
  };
  const dispatch = (slot: Slot): void => {
    const task = queue.shift();
    if (task === undefined) return;
    slot.task = task;
    const message: TuneWorkerTask = { id: task.id, voicing: task.voicing };
    slot.worker.postMessage(message);
  };
  const spawn = (): Slot => {
    const execArgv = workerExecArgv();
    const worker = new Worker(WORKER_URL, execArgv === undefined ? { workerData: init } : { workerData: init, execArgv });
    const slot: Slot = { worker, task: null };
    worker.on('message', (reply: TuneWorkerReply) => {
      const task = slot.task;
      if (task === null || task.id !== reply.id) {
        fail(new Error(`a tuning worker answered candidate ${reply.id}, which it was not given`));
        return;
      }
      slot.task = null;
      if ('error' in reply) task.reject(new Error(`evaluating a candidate failed in a worker thread: ${reply.error}`));
      else task.resolve(reply.result);
      dispatch(slot);
    });
    worker.on('error', (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
    worker.on('exit', (code) => fail(new Error(`a tuning worker thread exited (code ${code})`)));
    slots.push(slot);
    return slot;
  };
  return {
    get threads() {
      return slots.length;
    },
    evaluate(voicings) {
      if (failure !== null) return Promise.reject(failure);
      if (closing) return Promise.reject(new Error('workerEvaluator: closed'));
      const results = voicings.map((voicing) => new Promise<CandidateResult>((resolve, reject) => queue.push({ id: nextId++, voicing, resolve, reject })));
      for (const slot of slots) if (slot.task === null) dispatch(slot);
      while (queue.length > 0 && slots.length < workers) dispatch(spawn());
      return Promise.all(results);
    },
    async close() {
      closing = true;
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}

// ───────────────────────────── tuning ─────────────────────────────

interface Evaluated {
  objective: number;
  voicing: EngineVoicing;
  score: EngineScore | null;
  rejected: string | null;
}

/**
 * Minimises objectiveOf over the tunable voicing of `problem.def`: the baseline (the voicing as it stands) is scored
 * first, then the strategy searches from it (cmaes: tools/cmaes.ts cmaesSearch with the baseline's value as the
 * starting best; nm: nelderMeadSearch), then the polish (patternSearch) from the best point when anything could be
 * scored. Every batch a search asks for is evaluated with config.workers worker threads (0: this thread); candidates
 * are memoised by their (rounded) voicing, so a repeated point is never rendered twice, and every count and reduction
 * runs in candidate order — the report does not depend on the worker count. Writes no file.
 */
export async function tuneEngine(problem: TuneProblem, config: TuneConfig, progress?: (line: string) => void): Promise<TuneReport> {
  const { def, refs, otherRefs } = problem;
  const strategy = config.strategy ?? DEFAULT_STRATEGY;
  if (!TUNE_STRATEGIES.includes(strategy)) throw new RangeError(`tuneEngine: unknown strategy ${String(strategy)}`);
  const workers = config.workers ?? 0;
  if (!Number.isSafeInteger(workers) || workers < 0) throw new RangeError(`tuneEngine: workers must be an integer ≥ 0, got ${workers}`);
  const space = new VoicingSpace(def, config.params ?? undefined);
  const targets = problem.targets ?? renderTargets(refs, otherRefs);
  const evaluator =
    workers > 0 ? workerEvaluator({ def, refs, otherRefs, targets }, workers, config.workerModules ?? []) : localEvaluator({ def, refs, otherRefs, targets });
  try {
    const report = await search(space, targets, strategy, config, evaluator, progress);
    const threads = evaluator.threads;
    progress?.(`  candidates evaluated ${threads === 0 ? 'in this thread' : `in ${threads} worker thread${threads === 1 ? '' : 's'}`}`);
    return report;
  } finally {
    await evaluator.close();
  }
}

async function search(
  space: VoicingSpace,
  targets: readonly RenderTarget[],
  strategy: TuneStrategy,
  config: TuneConfig,
  evaluator: CandidateEvaluator,
  progress: ((line: string) => void) | undefined,
): Promise<TuneReport> {
  const def = space.base;
  const memo = new Map<string, Evaluated>();
  let evaluations = 0;
  let renders = 0;
  let rejected = 0;

  /** Evaluates a batch: memo hits and repeats inside the batch are not evaluated again; counted in candidate order. */
  const evaluateAll = async (voicings: readonly EngineVoicing[]): Promise<Evaluated[]> => {
    evaluations += voicings.length;
    const keys = voicings.map((v) => JSON.stringify(v));
    const fresh: number[] = [];
    const asked = new Set<string>();
    keys.forEach((k, i) => {
      if (!memo.has(k) && !asked.has(k)) {
        asked.add(k);
        fresh.push(i);
      }
    });
    const results = await evaluator.evaluate(fresh.map((i) => voicings[i] ?? def.voicing));
    fresh.forEach((i, j) => {
      const r = results[j];
      const voicing = voicings[i];
      if (r === undefined || voicing === undefined) throw new Error('tuneEngine: an evaluator returned too few results');
      if (r.rendered) renders++;
      if (r.rejected !== null) rejected++;
      memo.set(keys[i] ?? '', { objective: r.objective, voicing, score: r.score, rejected: r.rejected });
    });
    return keys.map((k) => {
      const e = memo.get(k);
      if (e === undefined) throw new Error('tuneEngine: a candidate was not evaluated');
      return e;
    });
  };
  const objectives = async (xs: readonly (readonly number[])[]): Promise<number[]> =>
    (await evaluateAll(xs.map((x) => space.decode(x)))).map((e) => e.objective);
  const report = (e: Evaluated): CandidateReport => ({
    objective: finiteOrNull(e.objective),
    composite: finiteOrNull(e.score?.composite),
    x: space.encode(e.voicing),
    voicing: e.voicing,
    score: e.score,
    rejected: e.rejected,
  });

  const [baseline] = await evaluateAll([def.voicing]);
  if (baseline === undefined) throw new Error('tuneEngine: the baseline was not evaluated');
  /** The evaluated candidate at x when it beats the baseline, else the baseline (Phase 2b's rule for the best vertex). */
  const bestOf = (x: readonly number[]): Evaluated => {
    const e = memo.get(JSON.stringify(space.decode(x)));
    return e !== undefined && e.objective < baseline.objective ? e : baseline;
  };
  const log: TuneLogEntry[] = [];
  const record = (phase: TunePhase, generation: number, step: TuneLogEntry['step'], sigma: number, best: Evaluated): void => {
    const entry: TuneLogEntry = {
      phase,
      generation,
      step,
      sigma,
      evaluations,
      renders,
      objective: finiteOrNull(best.objective),
      composite: finiteOrNull(best.score?.composite),
    };
    log.push(entry);
    const what =
      phase === 'nm'
        ? `iteration ${generation}/${config.iterations} ${step}`
        : phase === 'cmaes'
          ? `generation ${generation}/${config.iterations}: σ ${sigma.toFixed(4)},`
          : `polish sweep ${generation}/${POLISH_MAX_SWEEPS} (step ${sigma}):`;
    progress?.(
      `  ${what}${phase === 'nm' ? ':' : ''} objective ${fmt(entry.objective)}, composite ${fmt(entry.composite)} ` +
        `(${entry.evaluations} evaluations, ${entry.renders} renders)`,
    );
  };

  // The rpm bins a render covers are fixed by the segment programs, never by the voicing: a baseline that renders but
  // shares no comparable bin with any reference (composite null) means no candidate can be scored either, so nothing is
  // searched (an all-+∞ search would only render candidates to end "not tuned").
  const scorable = baseline.rejected !== null || finiteOrNull(baseline.score?.composite) !== null;
  if (!scorable) progress?.('  no render shares a comparable rpm bin with a reference: no voicing can be scored, nothing to search');
  const x0 = space.encode(def.voicing);
  let found: number[] = x0;
  let iterationsRun = 0;
  let stop: TuneStop = 'unscorable';
  if (strategy === 'nm') {
    const nm = await searchBatched(
      nelderMeadSearch(x0, {
        iterations: scorable ? config.iterations : 0,
        seed: config.seed,
        onIteration: (h) => record('nm', h.iteration, h.step, h.diameter, bestOf(h.bestX)),
      }),
      scorable ? objectives : (xs) => xs.map(() => Number.POSITIVE_INFINITY),
    );
    found = nm.x;
    iterationsRun = nm.iterations;
    if (scorable) stop = nm.converged ? 'converged' : 'iterations';
  } else if (!scorable) {
    record('cmaes', 0, 'init', CMAES_SIGMA0, baseline);
  } else {
    const cm = await searchBatched(
      cmaesSearch(x0, {
        seed: config.seed,
        generations: config.iterations,
        f0: baseline.objective,
        onGeneration: (g) => record('cmaes', g.generation, g.generation === 0 ? 'init' : 'generation', g.sigma, bestOf(g.bestX)),
      }),
      objectives,
    );
    found = cm.x;
    iterationsRun = cm.generations;
    stop = cm.stop === 'sigma' || cm.stop === 'stagnation' ? cm.stop : 'iterations';
  }
  let best = bestOf(found);
  let polishSweeps = 0;
  if (Number.isFinite(best.objective)) {
    const polished = await searchBatched(
      patternSearch(best === baseline ? x0 : found, best.objective, {
        onSweep: (s) => record('polish', s.sweep, 'sweep', s.step, bestOf(s.bestX)),
      }),
      objectives,
    );
    polishSweeps = polished.sweeps;
    best = bestOf(polished.x);
  }
  const baseValues = space.values(def.voicing);
  const bestValues = space.values(best.voicing);
  return {
    engineId: def.id,
    strategy,
    seed: config.seed,
    iterations: config.iterations,
    iterationsRun,
    converged: stop === 'converged' || stop === 'sigma' || stop === 'stagnation',
    stop,
    polishSweeps,
    evaluations,
    renders,
    rejected,
    targets: targets.map((t) => ({ segment: t.plan.segment, kind: t.plan.kind, perspective: t.perspective })),
    params: space.params.map((p, i) => ({ key: p.key, lo: p.lo, hi: p.hi, base: baseValues[i] ?? Number.NaN, best: bestValues[i] ?? Number.NaN })),
    baseline: report(baseline),
    best: report(best),
    improved: best !== baseline && best.objective < baseline.objective,
    log,
  };
}

// ───────────────────────────── validation (--apply; tuned engines in engines.test.ts) ─────────────────────────────

let schemaValidator: ReturnType<Ajv2020['compile']> | null = null;

/** engine.schema.json violations of `def` ("<path> <message>"), none when it validates. */
export function schemaErrors(def: unknown): string[] {
  schemaValidator ??= new Ajv2020({ allErrors: true, strict: true }).compile(engineSchema);
  if (schemaValidator(def) === true) return [];
  return (schemaValidator.errors ?? []).map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`);
}

/** Steady rpm of the order checks (those ≤ redline − 500), as tests/unit/dsp-invariants.test.ts. */
export const INVARIANT_RPMS: readonly number[] = [2000, 4000, 6000];
/** Highest volume trim (dB): every segment must stay ≤ TRUE_PEAK_CEILING_DBTP there (spec §1.3c). */
export const MAX_TRIM_DB = 6;
export const TRUE_PEAK_CEILING_DBTP = -1;
const ORDER_MAX = 12;
const STEADY_S = 1.5;
const STEADY_SKIP_S = 0.5;

function allFinite(x: ArrayLike<number>): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i] ?? Number.NaN)) return false;
  return true;
}

function near(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 1e-6;
}

/**
 * Exhaust bus (before perspective and bass management) of a steady hot render: load 0.5, app-default control (valve
 * auto, comfort, gear 3), seed 1, Full tier; 1.5 s with the first 0.5 s discarded — as tests/unit/dsp-invariants.test.ts.
 */
function steadyExhaustBus(def: EngineDef, rpm: number): { bus: Float32Array; nonFiniteResets: number } {
  const core = new TesboxDspCore(FS, 1);
  core.configure(def, { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 }, 'full');
  core.forceHot();
  const ctl = createBaseControl(def.spec, 'cabin');
  ctl.rpm = rpm;
  ctl.load = 0.5;
  ctl.gear = 3;
  ctl.shift.fromRpm = rpm;
  ctl.shift.toRpm = rpm;
  const quanta = Math.round((STEADY_S * FS) / QUANTUM);
  const bus = new Float32Array(quanta * QUANTUM);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  for (let q = 0; q < quanta; q++) {
    core.render(ctl, l, r, QUANTUM, (q * QUANTUM) / FS);
    bus.set(core.exhaustBus, q * QUANTUM);
  }
  return { bus: bus.subarray(Math.round(STEADY_SKIP_S * FS), Math.round(STEADY_S * FS)), nonFiniteResets: core.stats.nonFiniteResets };
}

/** assertEngineFits at MIN_SAMPLE_RATE (so the voicing fits every supported rate): the refusal, or null. */
function capacityFailure(def: EngineDef): string | null {
  try {
    assertEngineFits(def, MIN_SAMPLE_RATE);
    return null;
  } catch (e) {
    return `capacity: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Spec §14 order invariants on the hot exhaust bus at 2k/4k/6k rpm (those ≤ redline − 500): the firing order is
 * among the top 3 orders and, for a rotary, the e-shaft order 2 dominates; the bus stays finite. The def must fit
 * the DSP (assertEngineFits). Cheap (three 1.5 s renders): tune checks it on every candidate.
 */
export function orderInvariantFailures(def: EngineDef): string[] {
  const failures: string[] = [];
  const step = 360 / def.spec.cycleDeg;
  const firing = (def.spec.combustion.length * 360) / def.spec.cycleDeg;
  for (const rpm of INVARIANT_RPMS.filter((r) => r <= def.spec.rpm.redline - 500)) {
    const { bus, nonFiniteResets } = steadyExhaustBus(def, rpm);
    if (!allFinite(bus) || nonFiniteResets > 0) {
      failures.push(`exhaust bus at ${rpm} rpm: non-finite output (${nonFiniteResets} non-finite resets)`);
      continue;
    }
    const top = dominantOrders(orderSpectrum(bus, FS, rpm, ORDER_MAX, step), step, 3);
    if (!top.some((o) => near(o, firing))) failures.push(`firing order ${firing} is not among the top 3 orders at ${rpm} rpm (top: ${top.join(', ')})`);
    if (def.spec.layout.type === 'rotary' && !near(top[0], 2)) failures.push(`rotary: e-shaft order 2 does not dominate at ${rpm} rpm (top: ${top.join(', ')})`);
  }
  return failures;
}

/**
 * Spec §1.3(c) on every render segment (tools/segments.ts), cabin and outside, without subwoofer at the +6 dB
 * maximum trim: finite output, no non-finite reset, true peak ≤ −1 dBTP. The def must fit the DSP. Costly (every
 * segment twice), so tune checks it once, before --apply, not per candidate (the output stage's limiter bounds the
 * peak whatever the voicing).
 */
export function segmentInvariantFailures(def: EngineDef): string[] {
  const failures: string[] = [];
  for (const perspective of PERSPECTIVES) {
    for (const seg of SEGMENTS) {
      const { left, right, nonFiniteResets } = renderSegment(def, seg, { perspective, subwoofer: 'no', fs: FS, trimDb: MAX_TRIM_DB });
      const what = `${seg.name} (${perspective}, +${MAX_TRIM_DB} dB trim)`;
      if (!allFinite(left) || !allFinite(right) || nonFiniteResets > 0) {
        failures.push(`${what}: non-finite output (${nonFiniteResets} non-finite resets)`);
        continue;
      }
      const tp = Math.max(truePeakDbtp(left), truePeakDbtp(right));
      if (!(tp <= TRUE_PEAK_CEILING_DBTP)) failures.push(`${what}: true peak ${tp.toFixed(2)} dBTP > ${TRUE_PEAK_CEILING_DBTP} dBTP`);
    }
  }
  return failures;
}

/**
 * The DSP invariants a tuned voicing must keep (spec §14 / §1.3c, the ones a voicing can affect), as messages —
 * none when it passes: capacity, then orderInvariantFailures and segmentInvariantFailures. tune --apply refuses a
 * voicing that fails, and tests/unit/engines.test.ts holds every tuned engine to it.
 */
export function voicingInvariantFailures(def: EngineDef): string[] {
  const capacity = capacityFailure(def);
  if (capacity !== null) return [capacity];
  return [...orderInvariantFailures(def), ...segmentInvariantFailures(def)];
}

// ───────────────────────────── tuned engines (docs/sound-scores.md) ─────────────────────────────

/** Where tuned engines are recorded; tests/unit/engines.test.ts derives its TUNED_ENGINES set from it. */
export const SOUND_SCORES_DOC = 'docs/sound-scores.md';
const TUNED_RE = /^(?:[-*]\s+)?Tuned voicing:\s*`?([a-z0-9][a-z0-9-]*)`?/gm;

/** The line that records `engineId` as tuned in docs/sound-scores.md. */
export function tunedLine(engineId: string): string {
  return `Tuned voicing: ${engineId}`;
}

/** Engine ids recorded as tuned (lines starting `Tuned voicing: <engine-id>`, optionally as a list item), unique, in order. */
export function tunedEngineIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const m of markdown.matchAll(TUNED_RE)) {
    const id = m[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The engines recorded as tuned in `path` (default: the repository's docs/sound-scores.md); none when it is missing. */
export function tunedEngines(path: string = join(REPO_ROOT, SOUND_SCORES_DOC)): Set<string> {
  return new Set(existsSync(path) ? tunedEngineIds(readFileSync(path, 'utf8')) : []);
}

// ───────────────────────────── CLI ─────────────────────────────

export interface TuneCliOptions {
  engine: string;
  strategy: TuneStrategy;
  /** cmaes: generations (default DEFAULT_GENERATIONS); nm: simplex updates (default DEFAULT_ITERATIONS). */
  iterations: number;
  seed: number;
  /** Worker threads candidates are evaluated in (default defaultWorkers()). */
  workers: number;
  apply: boolean;
  refsDir: string;
  outDir: string;
  /** Tune only these parameters (contract order); null = the whole vector. */
  params: string[] | null;
}

const MAX_SEED = 2 ** 32 - 1;

function isStrategy(s: string): s is TuneStrategy {
  return (TUNE_STRATEGIES as readonly string[]).includes(s);
}

export function parseArgs(argv: string[]): TuneCliOptions {
  const o: TuneCliOptions = {
    engine: '',
    strategy: DEFAULT_STRATEGY,
    iterations: Number.NaN,
    seed: DEFAULT_SEED,
    workers: defaultWorkers(),
    apply: false,
    refsDir: DEFAULT_REFS,
    outDir: DEFAULT_OUT,
    params: null,
  };
  let iterations: number | null = null;
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const integer = (v: string, flag: string, max: number): number => {
    const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
    if (!Number.isSafeInteger(n) || n > max) throw new Error(`${flag} must be an integer in [0, ${max}], got "${v}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--iterations') {
      iterations = integer(value(i, a), a, Number.MAX_SAFE_INTEGER);
      i++;
    } else if (a === '--seed') {
      o.seed = integer(value(i, a), a, MAX_SEED);
      i++;
    } else if (a === '--strategy') {
      const v = value(i, a);
      if (!isStrategy(v)) throw new Error(`--strategy must be ${TUNE_STRATEGIES.join(' or ')}, got "${v}"`);
      o.strategy = v;
      i++;
    } else if (a === '--workers') {
      const v = value(i, a);
      const n = /^\d+$/.test(v) ? Number(v) : Number.NaN;
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--workers must be an integer ≥ 1, got "${v}"`);
      o.workers = n;
      i++;
    } else if (a === '--refs') {
      o.refsDir = value(i, a);
      i++;
    } else if (a === '--out') {
      o.outDir = value(i, a);
      i++;
    } else if (a === '--params') {
      const keys = value(i, a)
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (keys.length === 0) throw new Error('--params needs at least one parameter key');
      const unknown = keys.filter((k) => !isParamKey(k));
      if (unknown.length > 0) throw new Error(`--params: unknown parameter key(s) ${unknown.join(', ')} (known: ${PARAM_KEYS.join(', ')})`);
      o.params = keys;
      i++;
    } else if (a === '--apply') {
      o.apply = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else if (o.engine === '') {
      o.engine = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  if (o.engine === '') throw new Error('missing <engine-id>');
  o.iterations = iterations ?? (o.strategy === 'nm' ? DEFAULT_ITERATIONS : DEFAULT_GENERATIONS);
  return o;
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\');
}

/**
 * The file --apply writes: src/data/engines/<id>.json for an engine id, or the engine JSON given as a path. Throws
 * for anything under tests/fixtures (the DSP tests' fixed baselines are never modified).
 */
export function applyTarget(engineArg: string): string {
  const path = resolve(resolveEngine(engineArg));
  const explicitPath = engineArg.endsWith('.json') || engineArg.includes('/') || engineArg.includes('\\');
  if (isInside(path, FIXTURE_DIR) || (!explicitPath && path !== join(ENGINE_DIR, `${engineArg}.json`))) {
    throw new Error(
      `--apply writes src/data/engines/<engine-id>.json (or an engine JSON given as a path); ${engineArg} is a test fixture, which is never modified`,
    );
  }
  return path;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Engine directories of the reference library other than `exceptId`, sorted (as tools/score.ts). */
function otherEngineIds(refsDir: string, exceptId: string): string[] {
  if (!isDirectory(refsDir)) return [];
  return readdirSync(refsDir)
    .filter((d) => d !== exceptId && isDirectory(join(refsDir, d)))
    .sort();
}

/** The spec "auto" rpm of another engine's references is tracked with (null: unknown engine, as tools/score.ts). */
function specOf(engineId: string): EngineSpec | null {
  try {
    return loadEngine(resolveEngine(engineId)).spec;
  } catch {
    return null;
  }
}

/** Runs the whole tuning (see the module comment). Throws when the engine cannot be resolved. */
export async function runTune(
  opts: TuneCliOptions,
  log: (line: string) => void = (l) => console.log(l),
): Promise<{ exitCode: number; report: TuneReport | null }> {
  const def = loadEngine(resolveEngine(opts.engine));
  const target = opts.apply ? applyTarget(opts.engine) : null;
  const lens = lensOf(def.spec);
  const own = loadRefClips(join(opts.refsDir, def.id), def.spec, lens);
  const used = own.filter((c) => c.report.status === 'used');
  log(`tesbox-tune ${def.id}: ${used.length} usable reference clip(s)`);
  for (const c of own) if (c.report.reason !== null) log(`  ${c.report.clipId}: ${c.report.reason}`);
  if (used.length < MIN_REF_CLIPS) {
    log(`${def.id}: not tuned: unscored (${used.length} usable reference clip(s); ${MIN_REF_CLIPS} needed, spec §11.3)`);
    return { exitCode: EXIT_NOT_TUNED, report: null };
  }
  const perspectives = PERSPECTIVES.filter((p) => used.some((c) => c.report.perspective === p));
  const otherRefs: Record<string, ClipFeatures[]> = {};
  for (const id of otherEngineIds(opts.refsDir, def.id)) {
    const features = loadRefClips(join(opts.refsDir, id), specOf(id), lens, { perspectives }).flatMap((c) => c.features);
    if (features.length > 0) otherRefs[id] = features;
  }
  const refs = used.flatMap((c) => c.features);
  const targets = renderTargets(refs, otherRefs);
  log(
    `  scoring every candidate on ${targets.map((t) => `${t.plan.segment} (${t.perspective})`).join(', ')}` +
      (Object.keys(otherRefs).length > 0 ? `; discrimination against ${Object.keys(otherRefs).join(', ')}` : ''),
  );
  const searchName = opts.strategy === 'cmaes' ? `CMA-ES, ${opts.iterations} generation(s) at most` : `Nelder–Mead, ${opts.iterations} iteration(s)`;
  log(`  ${searchName}, seed ${opts.seed}, then the polish; evaluating candidates in up to ${opts.workers} worker thread${opts.workers === 1 ? '' : 's'}`);
  const started = performance.now();
  const report = await tuneEngine(
    { def, refs, otherRefs, targets },
    { strategy: opts.strategy, iterations: opts.iterations, seed: opts.seed, params: opts.params, workers: opts.workers },
    log,
  );
  const seconds = (performance.now() - started) / 1000;
  const outDir = join(opts.outDir, def.id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'best.json'), `${JSON.stringify(report, null, 2)}\n`);
  const unit = report.strategy === 'cmaes' ? 'generation' : 'iteration';
  log(
    `${def.id}: objective ${fmt(report.baseline.objective)} → ${fmt(report.best.objective)}, composite ` +
      `${fmt(report.baseline.composite)} → ${fmt(report.best.composite)} after ${report.iterationsRun} ${unit}(s) (stop: ${report.stop}) ` +
      `and ${report.polishSweeps} polish sweep(s); ${report.renders} render(s)${report.rejected > 0 ? `, ${report.rejected} rejected` : ''} ` +
      `in ${seconds.toFixed(1)} s (${(report.renders / Math.max(seconds, 1e-9)).toFixed(2)} renders/s); wrote ${join(outDir, 'best.json')}`,
  );
  for (const p of report.params) if (p.best !== p.base) log(`  ${p.key}: ${p.base} → ${p.best}`);
  if (report.best.objective === null) {
    log(`${def.id}: not tuned: no candidate could be scored (no render shares comparable rpm bins with a reference)`);
    return { exitCode: EXIT_NOT_TUNED, report };
  }
  if (target === null) return { exitCode: 0, report };
  if (!report.improved) {
    log(`${def.id}: no voicing scored better than the current one; ${target} is unchanged`);
    return { exitCode: 0, report };
  }
  return { exitCode: applyVoicing(def, report.best.voicing, target, log), report };
}

/**
 * --apply's last step: `def` with `voicing` (voicing.estimated set true — only the user's sign-off clears it) is
 * written to the engine JSON `target` once engine.schema.json and then the DSP invariants (voicingInvariantFailures)
 * accept it; a voicing the schema rejects is refused without rendering. Returns 0 (written) or EXIT_NOT_TUNED (refused
 * with the failures logged; nothing written).
 */
export function applyVoicing(def: EngineDef, voicing: EngineVoicing, target: string, log: (line: string) => void): number {
  const tuned: EngineDef = { ...def, voicing: { ...voicing, estimated: true } };
  const schema = schemaErrors(tuned);
  const failures = schema.length > 0 ? schema : voicingInvariantFailures(tuned);
  if (failures.length > 0) {
    log(`${def.id}: not applied: the tuned voicing fails validation:`);
    for (const f of failures) log(`  ${f}`);
    return EXIT_NOT_TUNED;
  }
  writeFileSync(target, `${JSON.stringify(tuned, null, 2)}\n`);
  log(`${def.id}: applied: wrote the tuned voicing to ${target} (voicing.estimated: true until the user's sign-off)`);
  if (isInside(target, ENGINE_DIR)) {
    log(
      `  record it in ${SOUND_SCORES_DOC} with the line "${tunedLine(def.id)}": tests/unit/engines.test.ts holds tuned engines to the ` +
        'schema and the DSP invariants instead of defaultVoicing',
    );
  }
  return 0;
}

/**
 * CLI entry; returns the process exit code: runTune's (0, or EXIT_NOT_TUNED), EXIT_USAGE for bad arguments, an
 * unknown engine, a parameter the engine lacks or an --apply target that is a test fixture (all checked before any
 * work), EXIT_ERROR when the run itself throws.
 */
export async function main(argv: string[]): Promise<number> {
  let opts: TuneCliOptions;
  try {
    opts = parseArgs(argv);
    const def = loadEngine(resolveEngine(opts.engine));
    if (opts.params !== null) new VoicingSpace(def, opts.params); // throws for a parameter this engine lacks
    if (opts.apply) applyTarget(opts.engine); // throws for a test fixture
  } catch (e) {
    console.error(`tesbox-tune: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return (await runTune(opts)).exitCode;
  } catch (e) {
    console.error(`tesbox-tune: tuning ${opts.engine} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return EXIT_ERROR;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
