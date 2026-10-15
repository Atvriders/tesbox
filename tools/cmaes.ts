/**
 * The (μ/μ_W, λ)-CMA-ES (phase 5 contract P1), implemented from N. Hansen, "The CMA Evolution Strategy: A Tutorial"
 * (arXiv:1604.00772, v2 2023): Figure 6 / Appendix A — sampling (38)–(40), weighted recombination (41)–(42),
 * cumulative step-size adaptation (43)–(44), rank-one and rank-μ covariance update (45)–(47) with the negative
 * weights of (46) — and the default strategy parameters of Table 1 (48)–(58). Box [0, 1]^n: a candidate is evaluated
 * at its repair clamp(x) and ranked by f(clamp(x)) + BOX_PENALTY·‖x − clamp(x)‖² (the tutorial's §B.5 penalty (63),
 * with a fixed α), the repaired point being disregarded afterwards. The eigendecomposition C = B·D²·Bᵀ that sampling
 * and C^(−½) need is computed by cyclic Jacobi rotations.
 *
 * Searches here are generators of batches (BatchSearch): each `yield` hands a list of points to evaluate and receives
 * their values in the same order, so the same search runs synchronously (searchSync) or with its batches evaluated
 * in parallel (searchBatched; tools/tune.ts evaluates them in worker threads). A search never depends on the order
 * in which the points of a batch finish: it generates a whole batch before seeing any value and reduces the values in
 * candidate order. Pure and environment-free; deterministic for a seed (mulberry32 with Box–Muller normals).
 */
import { Rng } from '../src/dsp/util';

/** Initial step size on the normalised box (contract P1). */
export const CMAES_SIGMA0 = 0.25;
/** α of the boundary penalty α·‖x − clamp(x)‖² (contract P1). */
export const BOX_PENALTY = 10;
/** Stop rules (contract P1): σ below SIGMA_STOP, or no best-objective improvement ≥ MIN_IMPROVEMENT in STALL_GENERATIONS. */
export const SIGMA_STOP = 1e-3;
export const STALL_GENERATIONS = 15;
export const MIN_IMPROVEMENT = 1e-4;

// ───────────────────────────── batch searches ─────────────────────────────

/** A search that yields batches of points and is answered with their objective values, in batch order. */
export type BatchSearch<R> = Generator<number[][], R, number[]>;

/** Runs a search, evaluating every point with `f` in batch order. */
export function searchSync<R>(search: BatchSearch<R>, f: (x: readonly number[]) => number): R {
  let step = search.next();
  while (step.done !== true) step = search.next(step.value.map((x) => f(x)));
  return step.value;
}

/** Runs a search, each batch evaluated by `evaluate` (which may evaluate the points in parallel; values in batch order). */
export async function searchBatched<R>(search: BatchSearch<R>, evaluate: (xs: number[][]) => Promise<readonly number[]> | readonly number[]): Promise<R> {
  let step = search.next();
  while (step.done !== true) step = search.next([...(await evaluate(step.value))]);
  return step.value;
}

/** A value as the searches rank it: anything non-finite (NaN, ±∞, missing) is +∞, worse than every finite value. */
export function finiteOrWorst(y: number | undefined): number {
  return y !== undefined && Number.isFinite(y) ? y : Number.POSITIVE_INFINITY;
}

// ───────────────────────────── strategy parameters (Table 1) ─────────────────────────────

/** Default population size (48): λ = 4 + ⌊3 ln n⌋. */
export function defaultPopulation(n: number): number {
  return 4 + Math.floor(3 * Math.log(n));
}

export interface CmaesParams {
  n: number;
  lambda: number;
  /** Number of strictly positive recombination weights, ⌊λ/2⌋. */
  mu: number;
  /** w_1 ≥ … ≥ w_λ (53): the first μ positive and summing to 1, the rest ≤ 0 (scaled by min(α⁻_μ, α⁻_μeff, α⁻_posdef)). */
  weights: number[];
  /** Variance effective selection mass of the positive weights. */
  mueff: number;
  cm: number;
  cs: number;
  ds: number;
  cc: number;
  c1: number;
  cmu: number;
  /** E‖N(0, I)‖ ≈ √n (1 − 1/(4n) + 1/(21 n²)). */
  chiN: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** The default strategy parameters of Table 1, (48)–(58) (α_cov = 2), for dimension n and population λ. */
export function cmaesParams(n: number, lambda: number = defaultPopulation(n)): CmaesParams {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`cmaesParams: dimension must be a positive integer, got ${n}`);
  if (!Number.isInteger(lambda) || lambda < 2) throw new RangeError(`cmaesParams: population must be an integer ≥ 2, got ${lambda}`);
  // (49) preliminary convex shape
  const raw = Array.from({ length: lambda }, (_, i) => Math.log((lambda + 1) / 2) - Math.log(i + 1));
  const positive = raw.filter((w) => w > 0);
  const negative = raw.filter((w) => w < 0);
  const sumPos = sum(positive);
  const sumNeg = -sum(negative);
  const mueff = sumPos ** 2 / sum(positive.map((w) => w * w));
  const mueffNeg = negative.length > 0 ? sumNeg ** 2 / sum(negative.map((w) => w * w)) : 0;
  const cm = 1; // (54)
  // (55) step-size control
  const cs = (mueff + 2) / (n + mueff + 5);
  const ds = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs;
  // (56)–(58) covariance matrix adaptation
  const alphaCov = 2;
  const cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
  const c1 = alphaCov / ((n + 1.3) ** 2 + mueff);
  const cmu = Math.min(1 - c1, (alphaCov * (0.25 + mueff + 1 / mueff - 2)) / ((n + 2) ** 2 + (alphaCov * mueff) / 2));
  // (50)–(53) weights
  const alphaMu = 1 + c1 / cmu;
  const alphaMueff = 1 + (2 * mueffNeg) / (mueff + 2);
  const alphaPosdef = (1 - c1 - cmu) / (n * cmu);
  const negScale = sumNeg > 0 ? Math.min(alphaMu, alphaMueff, alphaPosdef) / sumNeg : 0;
  const weights = raw.map((w) => (w >= 0 ? w / sumPos : w * negScale));
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  return { n, lambda, mu: positive.length, weights, mueff, cm, cs, ds, cc, c1, cmu, chiN };
}

// ───────────────────────────── symmetric eigendecomposition ─────────────────────────────

/** Sweeps of cyclic Jacobi rotations before giving up on an (impossible for symmetric input) non-convergence. */
const JACOBI_MAX_SWEEPS = 64;

/**
 * Eigendecomposition of a symmetric matrix by cyclic Jacobi rotations: each rotation in the (p, q) plane, tan φ = t
 * the smaller root of t² + 2θt − 1 = 0 with θ = (a_qq − a_pp) / (2 a_pq), zeroes a_pq; sweeps repeat until the
 * off-diagonal mass is negligible against the diagonal. Returns the eigenvalues and the eigenvectors as the columns
 * of `vectors` (C = V·diag(values)·Vᵀ, V orthonormal). The input is not modified.
 */
export function jacobiEigen(c: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
  const n = c.length;
  const a = c.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
  const at = (m: number[][], i: number, j: number): number => m[i]?.[j] ?? 0;
  const put = (m: number[][], i: number, j: number, x: number): void => {
    const row = m[i];
    if (row !== undefined) row[j] = x;
  };
  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      diag += at(a, i, i) ** 2;
      for (let j = i + 1; j < n; j++) off += at(a, i, j) ** 2;
    }
    if (off <= 1e-30 * diag || off === 0) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = at(a, p, q);
        if (apq === 0) continue;
        const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const akp = at(a, k, p);
          const akq = at(a, k, q);
          const kp = cs * akp - sn * akq;
          const kq = sn * akp + cs * akq;
          put(a, k, p, kp);
          put(a, p, k, kp);
          put(a, k, q, kq);
          put(a, q, k, kq);
        }
        put(a, p, p, at(a, p, p) - t * apq);
        put(a, q, q, at(a, q, q) + t * apq);
        put(a, p, q, 0);
        put(a, q, p, 0);
        for (let k = 0; k < n; k++) {
          const vkp = at(v, k, p);
          const vkq = at(v, k, q);
          put(v, k, p, cs * vkp - sn * vkq);
          put(v, k, q, sn * vkp + cs * vkq);
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i] ?? 0), vectors: v };
}

// ───────────────────────────── the evolution strategy ─────────────────────────────

/** Eigenvalues of C are kept at least this fraction of the largest (round-off guard; C is positive definite by (52)). */
const MIN_EIGEN_RATIO = 1e-20;

export interface CmaesOptions {
  sigma0: number;
  seed: number;
  /** Population size (default: defaultPopulation(n)). */
  lambda?: number;
}

/**
 * One (μ/μ_W, λ)-CMA-ES (tutorial Figure 6): ask() samples a population x_k = m + σ·B·D·z_k, z_k ~ N(0, I);
 * tell(fitness) ranks it (ties by candidate index; non-finite values worst) and applies (41)–(47).
 */
export class Cmaes {
  readonly n: number;
  readonly params: CmaesParams;
  private readonly rng: Rng;
  private m: number[];
  private s: number;
  private c: number[][];
  private b: number[][];
  private d: number[];
  private ps: number[];
  private pc: number[];
  private updates = 0;
  private pending: { z: number[][]; y: number[][] } | null = null;

  constructor(x0: readonly number[], o: CmaesOptions) {
    const n = x0.length;
    if (n < 1) throw new RangeError('Cmaes: needs at least one coordinate');
    if (!(o.sigma0 > 0) || !Number.isFinite(o.sigma0)) throw new RangeError(`Cmaes: σ₀ must be positive, got ${o.sigma0}`);
    this.n = n;
    this.params = cmaesParams(n, o.lambda);
    this.rng = new Rng(o.seed);
    this.m = [...x0];
    this.s = o.sigma0;
    const identity = (): number[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => (i === j ? 1 : 0)));
    this.c = identity();
    this.b = identity();
    this.d = new Array<number>(n).fill(1);
    this.ps = new Array<number>(n).fill(0);
    this.pc = new Array<number>(n).fill(0);
  }

  /** Distribution mean m. */
  get mean(): number[] {
    return [...this.m];
  }

  /** Step size σ. */
  get sigma(): number {
    return this.s;
  }

  /** Completed updates (tell calls). */
  get generation(): number {
    return this.updates;
  }

  /** A copy of the covariance matrix C. */
  covariance(): number[][] {
    return this.c.map((row) => [...row]);
  }

  /** (38)–(40): the next population, λ points (call tell() with their fitness before asking again). */
  ask(): number[][] {
    if (this.pending !== null) throw new Error('Cmaes.ask: tell() the fitness of the previous population first');
    const { n } = this;
    const z: number[][] = [];
    const y: number[][] = [];
    const xs: number[][] = [];
    for (let k = 0; k < this.params.lambda; k++) {
      const zk = Array.from({ length: n }, () => this.rng.gauss());
      const yk = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let j = 0; j < n; j++) acc += (this.b[i]?.[j] ?? 0) * (this.d[j] ?? 0) * (zk[j] ?? 0);
        yk[i] = acc;
      }
      z.push(zk);
      y.push(yk);
      xs.push(this.m.map((mi, i) => mi + this.s * (yk[i] ?? 0)));
    }
    this.pending = { z, y };
    return xs;
  }

  /** (41)–(47): updates the distribution from the fitness of the population ask() returned (lower is better). */
  tell(fitness: readonly number[]): void {
    const batch = this.pending;
    if (batch === null) throw new Error('Cmaes.tell: ask() for a population first');
    const { n } = this;
    const { lambda, mu, weights, mueff, cm, cs, ds, cc, c1, cmu, chiN } = this.params;
    if (fitness.length !== lambda) throw new RangeError(`Cmaes.tell: expected ${lambda} fitness values, got ${fitness.length}`);
    this.pending = null;
    const f = fitness.map(finiteOrWorst);
    const order = f.map((_, k) => k).sort((a, b) => ((f[a] ?? 0) < (f[b] ?? 0) ? -1 : (f[a] ?? 0) > (f[b] ?? 0) ? 1 : a - b));
    const ranked = (i: number): number => order[i] ?? 0;
    // (41) ⟨y⟩_w over the μ best, and Σ w_i z_{i:λ} for C^(−½)⟨y⟩_w = B Σ w_i z_{i:λ} (§B.1)
    const yw = new Array<number>(n).fill(0);
    const zw = new Array<number>(n).fill(0);
    for (let i = 0; i < mu; i++) {
      const w = weights[i] ?? 0;
      const yk = batch.y[ranked(i)] ?? [];
      const zk = batch.z[ranked(i)] ?? [];
      for (let j = 0; j < n; j++) {
        yw[j] = (yw[j] ?? 0) + w * (yk[j] ?? 0);
        zw[j] = (zw[j] ?? 0) + w * (zk[j] ?? 0);
      }
    }
    // (42) mean
    const sigma = this.s;
    this.m = this.m.map((mi, j) => mi + cm * sigma * (yw[j] ?? 0));
    // (43) conjugate evolution path
    const csFactor = Math.sqrt(cs * (2 - cs) * mueff);
    for (let i = 0; i < n; i++) {
      let bz = 0;
      for (let j = 0; j < n; j++) bz += (this.b[i]?.[j] ?? 0) * (zw[j] ?? 0);
      this.ps[i] = (1 - cs) * (this.ps[i] ?? 0) + csFactor * bz;
    }
    const psNorm = Math.hypot(...this.ps);
    this.updates++;
    // h_σ: stall the update of p_c while ‖p_σ‖ is large (normalised by its variance after `updates` updates from 0)
    const hs = psNorm / Math.sqrt(1 - (1 - cs) ** (2 * this.updates)) < (1.4 + 2 / (n + 1)) * chiN ? 1 : 0;
    // (44) step size
    this.s = sigma * Math.exp((cs / ds) * (psNorm / chiN - 1));
    // (45) evolution path
    const ccFactor = hs * Math.sqrt(cc * (2 - cc) * mueff);
    this.pc = this.pc.map((p, j) => (1 - cc) * p + ccFactor * (yw[j] ?? 0));
    // (46) w°: negative weights rescaled by n / ‖C^(−½) y_{i:λ}‖² = n / ‖z_{i:λ}‖²
    const wo = weights.map((w, i) => {
      if (w >= 0) return w;
      const zz = sum((batch.z[ranked(i)] ?? []).map((zj) => zj * zj));
      return zz > 0 ? (w * n) / zz : 0;
    });
    // (47) rank-one and rank-μ update
    const deltaHs = (1 - hs) * cc * (2 - cc);
    const decay = 1 + c1 * deltaHs - c1 - cmu * sum(weights);
    const next: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let rankMu = 0;
        for (let r = 0; r < lambda; r++) {
          const yr = batch.y[ranked(r)] ?? [];
          rankMu += (wo[r] ?? 0) * (yr[i] ?? 0) * (yr[j] ?? 0);
        }
        const cij = decay * (this.c[i]?.[j] ?? 0) + c1 * (this.pc[i] ?? 0) * (this.pc[j] ?? 0) + cmu * rankMu;
        const ri = next[i];
        const rj = next[j];
        if (ri !== undefined) ri[j] = cij;
        if (rj !== undefined) rj[i] = cij;
      }
    }
    this.c = next;
    const { values, vectors } = jacobiEigen(next);
    const floor = Math.max(Math.max(...values) * MIN_EIGEN_RATIO, Number.MIN_VALUE);
    this.d = values.map((l) => Math.sqrt(l > floor ? l : floor));
    this.b = vectors;
  }
}

// ───────────────────────────── the search on [0, 1]^n ─────────────────────────────

/** A point repaired into [0, 1]^n (NaN → 0) and its boundary penalty BOX_PENALTY·‖x − repaired‖². */
export function boxRepair(x: readonly number[]): { x: number[]; penalty: number } {
  let d2 = 0;
  const repaired = x.map((xi) => {
    const r = xi < 0 ? 0 : xi > 1 ? 1 : xi === xi ? xi : 0;
    d2 += (xi - r) ** 2;
    return r;
  });
  return { x: repaired, penalty: BOX_PENALTY * d2 };
}

export interface CmaesSearchOptions {
  seed: number;
  /** Generations (λ evaluations each); 0 evaluates nothing. */
  generations: number;
  /** Default CMAES_SIGMA0. */
  sigma0?: number;
  /** Default defaultPopulation(n). */
  lambda?: number;
  /** Default SIGMA_STOP (0: never). */
  sigmaStop?: number;
  /** Default STALL_GENERATIONS (+∞: never). */
  stallGenerations?: number;
  /** Default MIN_IMPROVEMENT. */
  minImprovement?: number;
  /** The objective at x0 when already known (it is not evaluated again): the starting best point. */
  f0?: number;
  /** Stop as soon as the best objective is ≤ target (default: never). */
  target?: number;
  /** Called with each history entry as it is logged (progress reporting). */
  onGeneration?: (g: CmaesGeneration) => void;
}

export interface CmaesGeneration {
  /** 0: the start (σ₀, the best is x0 with f0, or nothing yet). */
  generation: number;
  /** σ after the generation's update. */
  sigma: number;
  /** Best objective so far (unpenalised, at a repaired point) and that point. */
  bestF: number;
  bestX: number[];
  /** Objective evaluations so far. */
  evaluations: number;
}

export type CmaesStop = 'generations' | 'sigma' | 'stagnation' | 'target';

export interface CmaesResult {
  /** The best point evaluated (in [0, 1]^n), or x0 when nothing beat f0. */
  x: number[];
  f: number;
  generations: number;
  evaluations: number;
  stop: CmaesStop;
  /** The final distribution. */
  sigma: number;
  mean: number[];
  history: CmaesGeneration[];
}

/**
 * CMA-ES minimisation over [0, 1]^n from mean x0 (contract P1): each generation's candidates are yielded at their
 * repair (boxRepair) and ranked by value + penalty; the best is tracked on the unpenalised values (ties: the earlier
 * candidate). Stops after `generations`, when σ < sigmaStop, when the best objective improved by less than
 * minImprovement over the last stallGenerations generations, or at the target.
 */
export function* cmaesSearch(x0: readonly number[], o: CmaesSearchOptions): BatchSearch<CmaesResult> {
  const sigmaStop = o.sigmaStop ?? SIGMA_STOP;
  const stall = o.stallGenerations ?? STALL_GENERATIONS;
  const minImprovement = o.minImprovement ?? MIN_IMPROVEMENT;
  const target = o.target ?? Number.NEGATIVE_INFINITY;
  const es = new Cmaes(x0, { sigma0: o.sigma0 ?? CMAES_SIGMA0, seed: o.seed, lambda: o.lambda });
  let bestF = o.f0 === undefined ? Number.POSITIVE_INFINITY : finiteOrWorst(o.f0);
  let bestX = [...x0];
  let evaluations = 0;
  const history: CmaesGeneration[] = [];
  const log = (generation: number): void => {
    const h: CmaesGeneration = { generation, sigma: es.sigma, bestF, bestX: [...bestX], evaluations };
    history.push(h);
    o.onGeneration?.(h);
  };
  log(0);
  let stop: CmaesStop = 'generations';
  for (let g = 1; g <= o.generations; g++) {
    const repaired = es.ask().map(boxRepair);
    evaluations += repaired.length;
    const values = yield repaired.map((r) => r.x);
    const fitness = repaired.map((r, k) => {
      const v = finiteOrWorst(values[k]);
      if (v < bestF) {
        bestF = v;
        bestX = [...r.x];
      }
      return v + r.penalty;
    });
    es.tell(fitness);
    log(g);
    if (bestF <= target) {
      stop = 'target';
      break;
    }
    if (es.sigma < sigmaStop) {
      stop = 'sigma';
      break;
    }
    const before = history[g - stall];
    if (before !== undefined && !(before.bestF - bestF >= minImprovement)) {
      stop = 'stagnation';
      break;
    }
  }
  return { x: bestX, f: bestF, generations: history.length - 1, evaluations, stop, sigma: es.sigma, mean: es.mean, history };
}

/** cmaesSearch evaluated synchronously with `f`. */
export function cmaesMinimize(f: (x: readonly number[]) => number, x0: readonly number[], o: CmaesSearchOptions): CmaesResult {
  return searchSync(cmaesSearch(x0, o), f);
}
