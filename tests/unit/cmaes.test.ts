/**
 * tools/cmaes.ts: the (μ/μ_W, λ)-CMA-ES of N. Hansen, "The CMA Evolution Strategy: A Tutorial" (arXiv:1604.00772),
 * on the box [0, 1]^n with the tutorial's boundary penalty (phase 5 contract P1). Analytic objectives only.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/dsp/util';
import {
  BOX_PENALTY,
  CMAES_SIGMA0,
  Cmaes,
  MIN_IMPROVEMENT,
  SIGMA_STOP,
  STALL_GENERATIONS,
  boxRepair,
  cmaesMinimize,
  cmaesParams,
  cmaesSearch,
  defaultPopulation,
  jacobiEigen,
  searchBatched,
  searchSync,
  type CmaesSearchOptions,
} from '../../tools/cmaes';

type Fn = (x: readonly number[]) => number;

const sphere =
  (c: readonly number[]): Fn =>
  (x) =>
    x.reduce((s, xi, i) => s + (xi - (c[i] ?? 0)) ** 2, 0);

/** A seeded orthogonal n×n matrix (Gram–Schmidt on Gaussian rows). */
function rotation(n: number, seed: number): number[][] {
  const rng = new Rng(seed);
  const q: number[][] = [];
  while (q.length < n) {
    const v = Array.from({ length: n }, () => rng.gauss());
    for (const u of q) {
      const d = v.reduce((s, vi, i) => s + vi * (u[i] ?? 0), 0);
      for (let i = 0; i < n; i++) v[i] = (v[i] ?? 0) - d * (u[i] ?? 0);
    }
    const norm = Math.hypot(...v);
    q.push(v.map((vi) => vi / norm));
  }
  return q;
}

/** Rotated ellipsoid: Σ 10^(6·i/(n−1)) · (Q(x − c))_i², condition number 10⁶. */
function rotatedEllipsoid(c: readonly number[], seed: number): Fn {
  const n = c.length;
  const q = rotation(n, seed);
  return (x) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let j = 0; j < n; j++) r += (q[i]?.[j] ?? 0) * ((x[j] ?? 0) - (c[j] ?? 0));
      s += 10 ** ((6 * i) / (n - 1)) * r * r;
    }
    return s;
  };
}

/** Runs to a target value, recording every point evaluated. */
function solve(f: Fn, x0: readonly number[], o: Partial<CmaesSearchOptions> & { seed: number }) {
  const seen: number[][] = [];
  const r = cmaesMinimize(
    (x) => {
      seen.push([...x]);
      return f(x);
    },
    x0,
    { generations: 5000, sigmaStop: 0, stallGenerations: Number.POSITIVE_INFINITY, ...o },
  );
  return { r, seen };
}

const inBox = (x: readonly number[]): boolean => x.every((xi) => xi >= 0 && xi <= 1);

// ───────────────────────────── default strategy parameters ─────────────────────────────

describe('default strategy parameters (tutorial Table 1)', () => {
  it('population λ = 4 + ⌊3 ln n⌋, μ = ⌊λ/2⌋ strictly positive weights', () => {
    expect([1, 2, 3, 6, 10, 16, 30].map(defaultPopulation)).toEqual([4, 6, 7, 9, 10, 12, 14]);
    for (const n of [1, 2, 3, 6, 16]) {
      const p = cmaesParams(n);
      expect(p.lambda).toBe(defaultPopulation(n));
      expect(p.mu).toBe(Math.floor(p.lambda / 2));
      expect(p.weights.filter((w) => w > 0)).toHaveLength(p.mu);
    }
    expect(cmaesParams(4, 20).lambda).toBe(20);
    expect(() => cmaesParams(0)).toThrow(RangeError);
    expect(() => cmaesParams(3, 1)).toThrow(RangeError);
  });

  it('matches Table 1 (48)–(58) and E‖N(0, I)‖ ≈ √n (1 − 1/(4n) + 1/(21n²)) to 10 digits', () => {
    // Reference values computed independently from the tutorial's formulas.
    const ref = {
      2: {
        mueff: 2.02861146461,
        cs: 0.446204987378,
        ds: 1.446204987378,
        cc: 0.624554539027,
        c1: 0.154815399896,
        cmu: 0.085592779427,
        chiN: 1.254272742819,
        weights: [0.637042571241, 0.284570257438, 0.078387171321, -0.286383782597, -0.764958094085, -1.155981778159],
      },
      3: {
        mueff: 2.254815082202,
        cs: 0.414909001098,
        ds: 1.414909001098,
        cc: 0.558801322886,
        c1: 0.096409632579,
        cmu: 0.069588469233,
        chiN: 1.596877530259,
        weights: [0.58564510651, 0.292822553255, 0.121532340235, 0, -0.424126941843, -0.770663885706, -1.063656696984],
      },
      6: {
        mueff: 2.840610429717,
        cs: 0.349739663167,
        ds: 1.349739663167,
        cc: 0.408649688275,
        c1: 0.035631182071,
        cmu: 0.043166794248,
        chiN: 2.350667735965,
        weights: [
          0.493738377484, 0.281096832481, 0.156709502558, 0.068455287477, 0, -0.2110989866, -0.389580636645, -0.544188474347, -0.6805622521,
        ],
      },
      16: {
        mueff: 3.729458934303,
        cs: 0.231685575876,
        ds: 1.231685575876,
        cc: 0.20683345372,
        c1: 0.006600236193,
        cmu: 0.013716156927,
        chiN: 3.938244047619,
        weights: [
          0.402402942819, 0.253389084033, 0.166221564555, 0.104375225247, 0.056403477576, 0.01720770577, -0.050418589993, -0.141265287591,
          -0.221397753913, -0.293078687637, -0.357921979634, -0.417119267235,
        ],
      },
    } as const;
    for (const [n, want] of Object.entries(ref)) {
      const p = cmaesParams(Number(n));
      for (const k of ['mueff', 'cs', 'ds', 'cc', 'c1', 'cmu', 'chiN'] as const) expect(p[k], `n=${n} ${k}`).toBeCloseTo(want[k], 10);
      expect(p.cm).toBe(1);
      expect(p.weights).toHaveLength(want.weights.length);
      p.weights.forEach((w, i) => expect(w, `n=${n} w${i + 1}`).toBeCloseTo(want.weights[i] ?? Number.NaN, 10));
    }
  });

  it('positive weights decrease and sum to one; negative weights are bounded for positive definiteness (53)', () => {
    for (const n of [1, 2, 5, 9, 16]) {
      const p = cmaesParams(n);
      const pos = p.weights.slice(0, p.mu);
      expect(pos.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 12);
      for (let i = 1; i < p.weights.length; i++) expect(p.weights[i]).toBeLessThanOrEqual(p.weights[i - 1] ?? 0);
      const negSum = -p.weights.filter((w) => w < 0).reduce((s, w) => s + w, 0);
      expect(negSum).toBeGreaterThan(0);
      expect(negSum).toBeLessThanOrEqual((1 - p.c1 - p.cmu) / (n * p.cmu) + 1e-12); // α⁻_posdef (52)
      expect(negSum).toBeLessThanOrEqual(1 + p.c1 / p.cmu + 1e-12); // α⁻_μ (50)
    }
  });
});

// ───────────────────────────── eigendecomposition ─────────────────────────────

describe('symmetric eigendecomposition (Jacobi rotations)', () => {
  const product = (b: number[][], d: readonly number[]): number[][] =>
    b.map((_, i) => b.map((__, j) => b[0]?.reduce((s, ___, k) => s + (b[i]?.[k] ?? 0) * (d[k] ?? 0) * (b[j]?.[k] ?? 0), 0) ?? 0));

  it('C = B·diag(λ)·Bᵀ with orthonormal B, for random positive definite matrices up to 16-D', () => {
    const rng = new Rng(11);
    for (const n of [1, 2, 3, 6, 16]) {
      const m = Array.from({ length: n }, () => Array.from({ length: n }, () => rng.gauss()));
      const c = m.map((_, i) => m.map((__, j) => m.reduce((s, row) => s + (row[i] ?? 0) * (row[j] ?? 0), 0) + (i === j ? 0.1 : 0)));
      const { values, vectors } = jacobiEigen(c);
      expect(values).toHaveLength(n);
      const back = product(vectors, values);
      const btb = product(vectors.map((_, i) => vectors.map((row) => row[i] ?? 0)), new Array<number>(n).fill(1));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          expect(Math.abs((back[i]?.[j] ?? 0) - (c[i]?.[j] ?? 0)), `n=${n} C[${i}][${j}]`).toBeLessThan(1e-10);
          expect(Math.abs((btb[i]?.[j] ?? 0) - (i === j ? 1 : 0)), `n=${n} BᵀB[${i}][${j}]`).toBeLessThan(1e-12);
        }
      }
      expect(values.every((v) => v > 0)).toBe(true);
    }
  });

  it('finds known eigenvalues, repeated ones included, and leaves its input alone', () => {
    const q = rotation(5, 3);
    const lambda = [1, 2, 2, 7, 1e-6];
    const c = q.map((_, i) => q.map((__, j) => lambda.reduce((s, l, k) => s + (q[k]?.[i] ?? 0) * l * (q[k]?.[j] ?? 0), 0)));
    const copy = c.map((row) => [...row]);
    const { values } = jacobiEigen(c);
    expect(c).toEqual(copy);
    const sorted = [...values].sort((a, b) => a - b);
    [1e-6, 1, 2, 2, 7].forEach((l, i) => expect(Math.abs((sorted[i] ?? Number.NaN) - l), `λ${i}`).toBeLessThan(1e-12));
    expect(jacobiEigen([[4, 0], [0, 9]])).toEqual({ values: [4, 9], vectors: [[1, 0], [0, 1]] });
  });
});

// ───────────────────────────── box handling ─────────────────────────────

describe('box handling (tutorial §B.5 penalty, simplified)', () => {
  it('repairs a candidate into [0, 1]^n and penalises it by 10·‖x − clamp(x)‖²', () => {
    expect(BOX_PENALTY).toBe(10);
    expect(boxRepair([0.5, 0, 1])).toEqual({ x: [0.5, 0, 1], penalty: 0 });
    const r = boxRepair([-0.2, 0.3, 1.5]);
    expect(r.x).toEqual([0, 0.3, 1]);
    expect(r.penalty).toBeCloseTo(10 * (0.04 + 0.25), 12);
  });

  it('evaluates every candidate at its repair and ranks it by objective + penalty', () => {
    // f is flat in x0, so only the penalty pulls x0 back: the mean must not drift away from the box
    const seen: number[][] = [];
    const r = cmaesMinimize(
      (x) => {
        seen.push([...x]);
        return ((x[1] ?? 0) - 0.3) ** 2;
      },
      [1, 0.9],
      { seed: 4, generations: 80, sigmaStop: 0, stallGenerations: Number.POSITIVE_INFINITY },
    );
    expect(seen.length).toBe(r.evaluations);
    expect(seen.every(inBox)).toBe(true);
    expect(r.x[1]).toBeCloseTo(0.3, 4);
    expect(Math.abs((r.mean[0] ?? 0) - Math.min(1, Math.max(0, r.mean[0] ?? 0)))).toBeLessThan(0.05);
  });
});

// ───────────────────────────── analytic objectives ─────────────────────────────

describe('CMA-ES on analytic objectives (6-D, σ₀ = 0.25, default population)', () => {
  const C = [0.31, 0.62, 0.47, 0.55, 0.38, 0.7];
  const X0 = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const SEEDS = [1, 2, 3, 4, 5];

  it('sphere: reaches f ≤ 1e−10 within 1300 evaluations, never outside the box', () => {
    expect(CMAES_SIGMA0).toBe(0.25);
    for (const seed of SEEDS) {
      const { r, seen } = solve(sphere(C), X0, { seed, target: 1e-10 });
      expect(r.stop, `seed ${seed}`).toBe('target');
      expect(r.f).toBeLessThanOrEqual(1e-10);
      expect(r.evaluations, `seed ${seed}`).toBeLessThanOrEqual(1300);
      expect(seen.every(inBox)).toBe(true);
      expect(r.history.at(-1)?.bestF).toBe(r.f);
    }
  });

  it('rotated ellipsoid (condition 10⁶), the strategy itself: f ≤ 1e−10 within 2400 evaluations, C learning the inverse Hessian', () => {
    const q = rotation(6, 21);
    const f = rotatedEllipsoid(C, 21);
    for (const seed of SEEDS) {
      const es = new Cmaes(X0, { sigma0: CMAES_SIGMA0, seed });
      let best = Number.POSITIVE_INFINITY;
      let evaluations = 0;
      while (best > 1e-10 && evaluations < 2400) {
        const xs = es.ask();
        const ys = xs.map(f);
        evaluations += xs.length;
        best = Math.min(best, ...ys);
        es.tell(ys);
      }
      expect(best, `seed ${seed}`).toBeLessThanOrEqual(1e-10);
      // C ∝ H⁻¹: condition ≈ 10⁶, longest axis along the flattest direction of f, shortest along the steepest
      const { values, vectors } = jacobiEigen(es.covariance());
      const iMax = values.indexOf(Math.max(...values));
      const iMin = values.indexOf(Math.min(...values));
      const cond = (values[iMax] ?? 0) / (values[iMin] ?? 1);
      expect(cond, `seed ${seed}`).toBeGreaterThan(2e5);
      expect(cond, `seed ${seed}`).toBeLessThan(5e6);
      const along = (k: number, row: readonly number[]): number => Math.abs(vectors.reduce((s, v, i) => s + (v[k] ?? 0) * (row[i] ?? 0), 0));
      expect(along(iMax, q[0] ?? []), `seed ${seed}`).toBeGreaterThan(0.99);
      expect(along(iMin, q[5] ?? []), `seed ${seed}`).toBeGreaterThan(0.99);
    }
  });

  it('rotated ellipsoid on the box: f ≤ 1e−10 within 9000 evaluations (clamping truncates the flat axis mid-run)', () => {
    for (const seed of SEEDS) {
      const { r, seen } = solve(rotatedEllipsoid(C, 21), X0, { seed, target: 1e-10 });
      expect(r.stop, `seed ${seed}`).toBe('target');
      expect(r.evaluations, `seed ${seed}`).toBeLessThanOrEqual(9000);
      expect(seen.every(inBox)).toBe(true);
    }
  });

  it('an optimum on the box edge: lands on clamp(c) within 1e−4 in 1500 evaluations, every candidate inside the box', () => {
    const c = [1.3, -0.2, 0.5, 0.42, 1.05, 0.61];
    const xStar = [1, 0, 0.5, 0.42, 1, 0.61];
    const fStar = sphere(c)(xStar);
    for (const seed of SEEDS) {
      const { r, seen } = solve(sphere(c), X0, { seed, target: fStar + 1e-9 });
      expect(r.stop, `seed ${seed}`).toBe('target');
      expect(r.evaluations, `seed ${seed}`).toBeLessThanOrEqual(1500);
      r.x.forEach((xi, i) => expect(Math.abs(xi - (xStar[i] ?? Number.NaN)), `seed ${seed} x${i}`).toBeLessThan(1e-4));
      expect(seen.every(inBox)).toBe(true);
    }
  });

  it('ranks a NaN value exactly like +∞: last', () => {
    const a = new Cmaes([0.5, 0.5, 0.5], { sigma0: 0.25, seed: 3 });
    const b = new Cmaes([0.5, 0.5, 0.5], { sigma0: 0.25, seed: 3 });
    const xs = a.ask();
    expect(b.ask()).toEqual(xs);
    const values = xs.map((x) => sphere([0.2, 0.3, 0.4])(x));
    a.tell(values.map((v, k) => (k % 2 === 0 ? Number.NaN : v)));
    b.tell(values.map((v, k) => (k % 2 === 0 ? Number.POSITIVE_INFINITY : v)));
    expect(a.mean).toEqual(b.mean);
    expect(a.covariance()).toEqual(b.covariance());
    expect(a.sigma).toBe(b.sigma);
  });

  it('reports the best candidate by its value at the repair (the penalty only steers the distribution)', () => {
    // optimum on the edge x = 1: a sample beyond it is repaired onto it and scores 0 exactly
    for (const seed of SEEDS) {
      const r = cmaesMinimize((x) => ((x[0] ?? 0) - 1) ** 2, [0.9], { seed, generations: 5, target: 0 });
      expect([r.stop, r.f, r.x], `seed ${seed}`).toEqual(['target', 0, [1]]);
    }
  });

  it('treats NaN and +∞ as worse than any finite value', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const f: Fn = (x) => ((x[0] ?? 0) > 0.6 ? bad : sphere([0.2, 0.4])(x));
      const r = cmaesMinimize(f, [0.5, 0.5], { seed: 2, generations: 200, sigmaStop: 0, stallGenerations: Number.POSITIVE_INFINITY, target: 1e-12 });
      expect(r.x[0]).toBeCloseTo(0.2, 5);
      expect(r.x[1]).toBeCloseTo(0.4, 5);
      expect(Number.isFinite(r.f)).toBe(true);
    }
  });
});

// ───────────────────────────── stopping rules ─────────────────────────────

describe('stopping rules: --iterations generations, σ < 1e−3, 15 generations without an improvement ≥ 1e−4', () => {
  it('stops at the generation budget; generation 0 is the start (σ₀, the known value at x0)', () => {
    expect([SIGMA_STOP, STALL_GENERATIONS, MIN_IMPROVEMENT]).toEqual([1e-3, 15, 1e-4]);
    const r = cmaesMinimize(sphere([0.2, 0.9, 0.4]), [0.5, 0.5, 0.5], { seed: 1, generations: 3, f0: 0.66 });
    expect(r.stop).toBe('generations');
    expect(r.generations).toBe(3);
    expect(r.evaluations).toBe(3 * defaultPopulation(3));
    expect(r.history.map((h) => h.generation)).toEqual([0, 1, 2, 3]);
    expect(r.history[0]).toMatchObject({ generation: 0, sigma: 0.25, bestF: 0.66, evaluations: 0, bestX: [0.5, 0.5, 0.5] });
    for (let i = 1; i < r.history.length; i++) expect(r.history[i]?.bestF ?? 0).toBeLessThanOrEqual(r.history[i - 1]?.bestF ?? 0);
    const none = cmaesMinimize(sphere([0.2]), [0.5], { seed: 1, generations: 0 });
    expect([none.generations, none.evaluations, none.stop, none.f, none.x]).toEqual([0, 0, 'generations', Number.POSITIVE_INFINITY, [0.5]]);
  });

  it('stops once σ < 1e−3', () => {
    const f: Fn = (x) => 1e8 * sphere([0.3, 0.6])(x); // improvements stay ≥ 1e−4 until the step size is tiny
    const r = cmaesMinimize(f, [0.5, 0.5], { seed: 3, generations: 1000 });
    expect(r.stop).toBe('sigma');
    expect(r.sigma).toBeLessThan(1e-3);
    expect(r.history.at(-2)?.sigma ?? 0).toBeGreaterThanOrEqual(1e-3);
    expect(r.history.at(-1)?.sigma).toBe(r.sigma);
  });

  it('stops after 15 generations without a best-objective improvement of at least 1e−4', () => {
    const flat = cmaesMinimize(() => 0.5, [0.5, 0.5], { seed: 1, generations: 100, f0: 0.5 });
    expect([flat.stop, flat.generations]).toEqual(['stagnation', 15]);
    // the improvements add up to less than 1e−4 over the whole run: stop at generation 15
    const tiny = cmaesMinimize((x) => 1e-5 * sphere([0.3, 0.3])(x), [0.5, 0.5], { seed: 1, generations: 100, f0: 0.8e-6 });
    expect([tiny.stop, tiny.generations]).toEqual(['stagnation', 15]);
    // without a known start, the first finite value is an improvement (from +∞): 15 more generations
    const fresh = cmaesMinimize(() => 0.5, [0.5, 0.5], { seed: 1, generations: 100 });
    expect([fresh.stop, fresh.generations]).toEqual(['stagnation', 16]);
    // small steps that add up to ≥ 1e−4 within every 15 generations keep it going (1.2e−5 per generation here)
    let k = 0;
    const steady = cmaesMinimize(() => 1 - 2e-6 * ++k, [0.5, 0.5], { seed: 1, generations: 40, f0: 1 });
    expect([steady.stop, steady.generations]).toEqual(['generations', 40]);
  });
});

// ───────────────────────────── determinism and the batch protocol ─────────────────────────────

describe('determinism', () => {
  const f = rotatedEllipsoid([0.3, 0.7, 0.5, 0.2], 5);

  it('is a pure function of the seed and the values it is told; the seed changes the samples', () => {
    const a = cmaesMinimize(f, [0.5, 0.5, 0.5, 0.5], { seed: 9, generations: 40 });
    expect(cmaesMinimize(f, [0.5, 0.5, 0.5, 0.5], { seed: 9, generations: 40 })).toEqual(a);
    const b = cmaesMinimize(f, [0.5, 0.5, 0.5, 0.5], { seed: 10, generations: 40 });
    expect(b.history[1]?.bestX).not.toEqual(a.history[1]?.bestX);
  });

  it('asks a whole generation at once and gives the same result however the batch is answered', async () => {
    const o = { seed: 4, generations: 30 };
    const sync = searchSync(cmaesSearch([0.5, 0.5, 0.5, 0.5], o), f);
    const sizes: number[] = [];
    const batched = await searchBatched(cmaesSearch([0.5, 0.5, 0.5, 0.5], o), async (xs) => {
      sizes.push(xs.length);
      // answer each point after a different delay: completion order ≠ candidate order
      return Promise.all(xs.map((x, i) => new Promise<number>((done) => setTimeout(() => done(f(x)), (7 * i) % 5))));
    });
    expect(batched).toEqual(sync);
    expect(sizes.every((s) => s === defaultPopulation(4))).toBe(true);
    expect(sizes).toHaveLength(sync.generations);
  });

  it('Cmaes: one tell per ask, with one value per candidate', () => {
    const es = new Cmaes([0.5, 0.5], { sigma0: 0.25, seed: 1 });
    expect(() => es.tell([1, 2, 3, 4, 5, 6])).toThrow(/ask/);
    const xs = es.ask();
    expect(xs).toHaveLength(6);
    expect(() => es.ask()).toThrow(/tell/);
    expect(() => es.tell([1, 2])).toThrow(/6/);
    es.tell(xs.map((x) => sphere([0.2, 0.2])(x)));
    expect(es.generation).toBe(1);
    expect(es.covariance()).toHaveLength(2);
  });
});
