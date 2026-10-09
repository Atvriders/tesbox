# Tesbox Phase 2a — DspCore + Render CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the environment-free physically-informed engine synthesizer (`TesboxDspCore`) with its exhaust waveguide network, combustion source, layers, perspective mix and safe output stage, plus the offline render CLI and allocation/performance tooling, verified by physics-invariant tests.

**Architecture:** Pure TypeScript in `src/dsp/`, capacity-sized at construction, per-sample processing chain driven by a per-quantum `DspControl`; passive-by-construction waveguide network; true-peak limited output; Node tools render to WAV.

**Tech Stack:** TypeScript 6.0, Vitest 5, tsx, ESLint 10 (hot-path rule).

**Spec:** `docs/superpowers/specs/2026-10-06-tesbox-design.md` (§4.4, §5, §14, §15 Phase 2a)

## Global Constraints

The locked contract `docs/superpowers/plans/contracts/phase2a-contract.md` (including **Amendments B1–B10**) and `src/contracts.ts` are part of every task's requirements. Key lines:

- No imports from `src/sim/**` or `src/data/**`; fixtures under `tests/fixtures/engines/`.
- Capacity-sized construction; `configure()` never allocates; hot paths obey B1; GC gate per B2.
- Passivity by construction; no in-loop gain > 1; NaN-safe output; true peak ≤ −1 dBTP.
- Determinism via seeded `Rng`.
- No per-task commits — Phase 2a lands as one verified commit.

## Review Focus

1. Engine/tier change while rendering → 300 ms fade, no NaN, no allocation, no step > 0.1 FS. (Task 9)
2. rpm 0 / ignition off → no NaN, output decays to silence. (Tasks 4, 9)
3. rpm 12000 on a 9000-redline engine → finite, α clamp holds. (Task 4)
4. +6 dB trim, full-scale input → true peak ≤ −1.0 dBTP, no sample > 0.8913. (Task 7)
5. Valve / perspective toggled rapidly → bounded energy, no clicks. (Tasks 3, 7)

## Execution order (dependency waves)

W1: Task 1 → W2: Tasks 2, 4, 5, 6, 7, 8 → W3: Task 3 → W4: Task 9 → W5: Task 10.

---

### Task 1: DSP primitives (util, biquads, 4× oversampler) and the 8 fixture engines

**Files:**
- Create: `src/dsp/util.ts`
- Create: `src/dsp/biquad.ts`
- Create: `src/dsp/oversample.ts`
- Create: `tests/fixtures/engines/i4-test.json`, `tests/fixtures/engines/i5-test.json`, `tests/fixtures/engines/i6-test.json`, `tests/fixtures/engines/v8-crossplane-test.json`, `tests/fixtures/engines/v8-flatplane-test.json`, `tests/fixtures/engines/v8-sc-test.json`, `tests/fixtures/engines/flat4-uel-test.json`, `tests/fixtures/engines/rotary-test.json`
- Test: `tests/unit/dsp-util.test.ts`
- Test: `tests/unit/dsp-biquad.test.ts`
- Test: `tests/unit/dsp-oversample.test.ts`
- Test: `tests/unit/dsp-fixtures.test.ts`

**Interfaces:**
- Consumes: `src/contracts.ts` (LOCKED) — `type EngineDef`, `MAX_COMBUSTION` (16), `firingHz(rpm: number, combustionCount: number, cycleDeg: number): number` (fixture test only). Nothing from other Phase 2a tasks.
- Produces (contract names and signatures exactly; `readonly y` members are getters; no class here takes constructor arguments except `Rng` and `Cascade`):
  - `src/dsp/util.ts`
    - `flush(x: number): number` — exactly `0` for |x| < 1e-20 (never −0), otherwise `x`; NaN/±Infinity pass through.
    - `clamp(x: number, lo: number, hi: number): number` — NaN passes through.
    - `dbToGain(db: number): number` = 10^(db/20).
    - `gainToDb(g: number): number` = 20·log10(g), floored: g ≤ 1e-10 (incl. 0, negative, NaN) → −200.
    - `smoothstep(e0: number, e1: number, x: number): number` — 3t² − 2t³, t = clamp((x − e0)/(e1 − e0), 0, 1); reversed edges work; e0 === e1 → step at e0.
    - `class Rng { constructor(seed?: number /* default 1 */); seed(s: number): void; next(): number /* [0,1) */; bipolar(): number /* [−1,1) */; gauss(): number }` — mulberry32, bit-identical to the reference sequence (seed coerced with `>>> 0`; state kept int32 so it never loses precision); Box–Muller with a cached second value (two `gauss()` calls consume exactly two `next()` draws); `seed()` also drops the cached value.
    - `class OnePole { setTau(tauS: number, fs: number): void; setCutoff(hz: number, fs: number): void; process(x: number): number; reset(v?: number /* 0 */): void; readonly y: number }` — y = k·x + (1 − k)·y, flushed. Fresh instance: k = 1 (exact pass-through), y = 0. `setCutoff`: k = 1 − e^(−2π·hz/fs); hz ≤ 0/NaN → k = 0 (holds). `setTau`: k = 1 − e^(−1/(τ·fs)); τ ≤ 0/NaN → k = 1. Unity DC gain, |H| ≤ 1.
    - `class Slew { setRate(unitsPerS: number, fs: number): void; process(target: number): number; reset(v: number): void; readonly y: number }` — moves at most unitsPerS/fs per call and lands exactly on the target; default and rate ≤ 0/NaN = unlimited.
  - `src/dsp/biquad.ts`
    - `class Biquad { lowpass(f, q, fs); highpass(f, q, fs); bandpass(f, q, fs) /* constant 0 dB peak */; lowShelf(f, gainDb, fs); highShelf(f, gainDb, fs); peaking(f, q, gainDb, fs); process(x: number): number; reset(): void }` (all setters `(…: number): void`) — RBJ cookbook, Direct Form I, double state, output flushed. Pass-through until configured. f clamped into [1 Hz, 0.49·fs] (NaN → 1 Hz), q ≥ 1e-3, non-finite gainDb → 0 dB, shelves use slope S = 1. Setters keep the state; `reset()` keeps the coefficients. `lowpass(f, Math.SQRT1_2, fs)` never exceeds 0 dB (tested; Task 3 relies on it in a loop).
    - `BUTTER4_Q: readonly [number, number]` = [1/(2·cos(π/8)), 1/(2·cos(3π/8))] ≈ [0.5411961, 1.3065630].
    - `class Cascade { constructor(stages: number); stage(i: number): Biquad; process(x: number): number; reset(): void }` — `RangeError` for a non-positive-integer stage count or an out-of-range `i`; every stage starts as a pass-through; `stage(i)` returns the live Biquad; stages run in index order.
  - `src/dsp/oversample.ts`
    - `OS_FACTOR = 4`.
    - `OS_TAPS: Float64Array` — 48 taps computed at module load from the Kaiser-window formula (β = 8, windowed sinc, cutoff 0.45·fs_in), symmetric, Σ = 4 (each polyphase branch ≈ unity DC gain, within 1e-4). Measured: pass-band deviation < 0.01 dB up to 0.25·fs_in, −6.02 dB at 0.45·fs_in, ≤ −80 dB from 0.7·fs_in to the output Nyquist.
    - `class Upsampler4 { reset(): void; push(x: number): void; readonly out: Float64Array }` — after each `push`, `out[p] = Σ_{m=0..11} OS_TAPS[p + 4m]·x[k − m]` (p = 0..3, overwritten in place). Group delay 23.5 output samples = 5.875 input samples (Task 7's look-ahead and Task 8's true-peak meter should account for it). A 1 kHz sine at 48 kHz is reproduced within 1e-4; an fs/4 sine sampled at ±0.707 reads > 0.97.
  - Fixtures `tests/fixtures/engines/<id>.json` — complete `EngineDef`s (exact contract keys, checked by the test), `estimated: true`, every `spec.sources` group `["fixture"]`. Entry i is cylinder (or rotor face) i + 1. Every redline ≥ 6500 (invariants run at 6000 rpm ≤ redline − 500). Even-fire fixtures use equal headers (amendment B8).

    | id | firing / angles (entry order) | banks | aspiration | gearbox | headersM | collectors (banks, m) | valve | muffler sections |
    |---|---|---|---|---|---|---|---|---|
    | `i4-test` | 1-3-4-2; 0, 540, 180, 360 | all 0 | single turbo, turbine {0.45, 1500 Hz}, lift bov | dct, 7 | 4 × 0.60 | [0] 0.35 | fitted, +4 dB | 3 |
    | `i5-test` | 1-2-4-5-3 @144°; 0, 144, 576, 288, 432 | all 0 | single turbo, turbine {0.45, 1500}, lift flutter | dct, 7 | 0.62, 0.55, 0.70, 0.58, 0.66 | [0] 0.40 | fitted, +5 | 3 |
    | `i6-test` | 1-5-3-6-2-4; 0, 480, 240, 600, 120, 360 | cyl 1–3 → 0, 4–6 → 1 | NA | manual, 6 | 6 × 0.55 | [0] 0.35, [1] 0.35 | not fitted | 4 |
    | `v8-crossplane-test` | 1-8-4-3-6-5-7-2; 0, 630, 270, 180, 450, 360, 540, 90 | odd cyl → 0, even → 1 | NA | tc-auto, 8, tc {2400, 1300, 0.88} | 0.58, 0.66, 0.62, 0.70, 0.66, 0.58, 0.70, 0.62 | [0] 0.40, [1] 0.45 | fitted, +4 | 3 |
    | `v8-flatplane-test` | 1-5-3-7-4-8-2-6; 0, 540, 180, 360, 90, 630, 270, 450 | cyl 1–4 → 0, 5–8 → 1 | NA | dct, 7 | 8 × 0.50 | [0] 0.30, [1] 0.30 | fitted, +5 | 1 |
    | `v8-sc-test` | as cross-plane | as cross-plane | roots `{pulleyRatio 2.4, gearRatio 1, lobes 4}` (whine order 19.2), FI {0.05 s, 15 krpm, bov, −12 dB} | tc-auto, 8, tc {2600, 1400, 0.86} | 0.60, 0.68, 0.64, 0.72, 0.68, 0.60, 0.72, 0.64 | [0] 0.42, [1] 0.48 | fitted, +4 | 2 |
    | `flat4-uel-test` | 1-3-2-4; 0, 360, 180, 540 | cyl 1, 3 → 0; 2, 4 → 1 | single turbo, turbine {0.5, 1400} | manual, 6 | 0.45, 0.75, 0.45, 0.75 | [0, 1] 0.30 | not fitted | 3 |
    | `rotary-test` | cycleDeg 1080; 0, 360, 720, 180, 540, 900 | rotor 1 → 0, rotor 2 → 1 | sequential turbo (count 2), turbine {0.4, 1600} | manual, 6 | 6 × 0.50 | [0, 1] 0.30 | not fitted | 2 |

    rpm idle / redline / limiter (type, rpm, hysteresis): i4 750 / 6500 / ignition-soft 6600 150; i5 850 / 7000 / ignition-soft 7100 150; i6 700 / 7000 / fuel-hard 7100 200; v8-crossplane 650 / 6600 / fuel-hard 6700 250; v8-flatplane 900 / 9000 / ignition-hard 9100 150; v8-sc 750 / 6500 / fuel-soft 6600 250; flat4-uel 750 / 6700 / fuel-hard 6800 300; rotary 800 / 8000 / fuel-hard 8200 200. Pulse widthDeg: 55, 60, 50, 65, 45, 65, 70, 260 (same order); cycleAsymmetry 0.05 for the even-fire i4/i6/v8-flatplane.

**Cross-task premises:** (open each file and confirm before coding)
- Phase 0 tooling exists: `package.json` scripts `test` (`vitest run`), `lint` (`eslint .`), `typecheck` (`tsc --noEmit -p tsconfig.json`); `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `types: ["vite/client", "node"]` and includes `src` and `tests`; `vite.config.ts` has `test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' }`.
- `eslint.config.js` is `@eslint/js` recommended + `typescript-eslint` **recommended** (not `strict`): hot loops here use the non-null assertion `!` on typed-array reads that are in range by construction. If the repo enables `@typescript-eslint/no-non-null-assertion`, stop and report instead of rewriting.
- `src/contracts.ts` exports `EngineDef`, `MAX_COMBUSTION = 16` and `firingHz` exactly as in the locked file.
- No other Phase 2a task creates these files. Tasks 2–10 import the names above unchanged; Tasks 3, 9 and 10 read the fixtures by path (`tests/fixtures/engines/<id>.json`); Task 9's invariant 9 raises `v8-flatplane-test`'s redline to 9500 in a copy (it is 9000 here); Task 10's check-alloc renders `v8-crossplane-test`.
- Task 10 adds the amendment-B1 lint rule later. `process`, `push`, `next` here contain no `new`, array/object literals, closures, spread, template literals, `try` or `throw` (verified while authoring: with the B1 selector enabled these files lint clean).

- [ ] **Step 1: Write the failing util tests**

Create `tests/unit/dsp-util.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  OnePole,
  Rng,
  Slew,
  clamp,
  dbToGain,
  flush,
  gainToDb,
  smoothstep,
} from '../../src/dsp/util';

const FS = 48000;

describe('flush', () => {
  it('maps |x| < 1e-20 to exactly 0 and passes everything else through', () => {
    expect(flush(1e-21)).toBe(0);
    expect(flush(-9.99e-21)).toBe(0);
    expect(Object.is(flush(-1e-30), 0)).toBe(true); // +0, never −0
    expect(flush(1e-20)).toBe(1e-20);
    expect(flush(-0.5)).toBe(-0.5);
    expect(flush(Infinity)).toBe(Infinity);
    expect(Number.isNaN(flush(NaN))).toBe(true);
  });
});

describe('clamp', () => {
  it('limits to [lo, hi] and lets NaN through', () => {
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(2, -1, 1)).toBe(1);
    expect(clamp(0.25, -1, 1)).toBe(0.25);
    expect(Number.isNaN(clamp(NaN, 0, 1))).toBe(true);
  });
});

describe('dbToGain / gainToDb', () => {
  it('converts both ways', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(20)).toBeCloseTo(10, 12);
    expect(dbToGain(-6.020599913279624)).toBeCloseTo(0.5, 12);
    expect(gainToDb(10)).toBeCloseTo(20, 12);
    expect(gainToDb(dbToGain(-37.5))).toBeCloseTo(-37.5, 10);
  });

  it('is −Infinity-safe: g ≤ 0, NaN or below 1e-10 → −200', () => {
    expect(gainToDb(0)).toBe(-200);
    expect(gainToDb(-1)).toBe(-200);
    expect(gainToDb(NaN)).toBe(-200);
    expect(gainToDb(1e-12)).toBe(-200);
  });
});

describe('smoothstep', () => {
  it('is 0 below e0, 1 above e1, ½ at the midpoint, with zero slope at the edges', () => {
    expect(smoothstep(-0.08, 0.02, -1)).toBe(0);
    expect(smoothstep(-0.08, 0.02, 1)).toBe(1);
    expect(smoothstep(-0.08, 0.02, -0.03)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, 1e-4)).toBeLessThan(1e-7);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 12);
  });

  it('handles reversed and equal edges', () => {
    expect(smoothstep(1, 0, 0.25)).toBeCloseTo(1 - 0.15625, 12);
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0);
    expect(smoothstep(0.5, 0.5, 0.5)).toBe(1);
  });
});

describe('Rng', () => {
  it('reproduces the mulberry32 reference sequence', () => {
    const a = new Rng(1);
    expect(a.next()).toBe(0.6270739405881613);
    expect(a.next()).toBe(0.002735721180215478);
    expect(a.next()).toBe(0.5274470399599522);
    const b = new Rng(42);
    expect(b.next()).toBe(0.6011037519201636);
    expect(b.next()).toBe(0.44829055899754167);
    expect(b.next()).toBe(0.8524657934904099);
    expect(new Rng(0).next()).toBe(0.26642920868471265);
  });

  it('defaults to seed 1 and restarts on seed()', () => {
    const a = new Rng();
    const first = [a.next(), a.next(), a.next()];
    a.seed(1);
    expect([a.next(), a.next(), a.next()]).toEqual(first);
    expect(first[0]).toBe(new Rng(1).next());
  });

  it('next() is uniform in [0, 1) and bipolar() in [−1, 1)', () => {
    const r = new Rng(7);
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const x = r.next();
      sum += x;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(1);
    expect(sum / n).toBeCloseTo(0.5, 2);
    let bl = Infinity;
    let bh = -Infinity;
    let bsum = 0;
    for (let i = 0; i < n; i++) {
      const x = r.bipolar();
      bsum += x;
      bl = Math.min(bl, x);
      bh = Math.max(bh, x);
    }
    expect(bl).toBeGreaterThanOrEqual(-1);
    expect(bh).toBeLessThan(1);
    expect(bl).toBeLessThan(-0.999);
    expect(bh).toBeGreaterThan(0.999);
    expect(bsum / n).toBeCloseTo(0, 2);
  });

  it('gauss() has mean 0 and variance 1 and uses the cached pair', () => {
    const r = new Rng(3);
    const n = 200000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const g = r.gauss();
      expect(Number.isFinite(g)).toBe(true);
      s += g;
      s2 += g * g;
    }
    const mean = s / n;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(s2 / n - mean * mean).toBeCloseTo(1, 1);
    // Two gauss() calls consume exactly two next() draws (one Box–Muller pair).
    const a = new Rng(11);
    a.gauss();
    a.gauss();
    const b = new Rng(11);
    b.next();
    b.next();
    expect(a.next()).toBe(b.next());
  });

  it('seed() drops a cached gauss() value', () => {
    const a = new Rng(5);
    a.gauss(); // caches the second value of the pair
    a.seed(9);
    expect(a.gauss()).toBe(new Rng(9).gauss());
  });
});

describe('OnePole', () => {
  it('is a pass-through before configuration', () => {
    const p = new OnePole();
    expect(p.process(0.3)).toBe(0.3);
    expect(p.process(-2)).toBe(-2);
    expect(p.y).toBe(-2);
  });

  it('setCutoff gives the exact exponential step response and unity DC gain (multi-call)', () => {
    const p = new OnePole();
    p.setCutoff(1000, FS);
    const k = 1 - Math.exp((-2 * Math.PI * 1000) / FS);
    let y = 0;
    for (let n = 1; n <= 200; n++) {
      y = p.process(1);
      expect(y).toBeCloseTo(1 - Math.pow(1 - k, n), 12);
    }
    expect(y).toBeCloseTo(1, 9);
    expect(p.y).toBe(y);
  });

  it('setTau reaches 1 − e^(−1) after τ·fs samples', () => {
    const p = new OnePole();
    p.setTau(0.01, FS);
    let y = 0;
    for (let n = 0; n < 480; n++) y = p.process(1);
    expect(y).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it('never amplifies a sinusoid (|H| ≤ 1)', () => {
    const p = new OnePole();
    p.setCutoff(3000, FS);
    let peak = 0;
    for (let n = 0; n < 48000; n++) {
      const y = p.process(Math.sin((2 * Math.PI * 200 * n) / FS));
      if (n > 4800) peak = Math.max(peak, Math.abs(y));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.99);
  });

  it('flushes its decaying tail to exactly 0 and reset() sets the state', () => {
    const p = new OnePole();
    p.setCutoff(5000, FS);
    p.reset(1);
    expect(p.y).toBe(1);
    let y = 1;
    for (let n = 0; n < 2000; n++) y = p.process(0);
    expect(y).toBe(0);
    p.reset();
    expect(p.y).toBe(0);
  });

  it('setCutoff(≤ 0) holds the output and setTau(≤ 0) passes through', () => {
    const p = new OnePole();
    p.reset(0.4);
    p.setCutoff(0, FS);
    expect(p.process(1)).toBe(0.4);
    p.setTau(0, FS);
    expect(p.process(1)).toBe(1);
  });
});

describe('Slew', () => {
  it('passes straight through until a rate is set', () => {
    const s = new Slew();
    expect(s.process(5)).toBe(5);
    expect(s.y).toBe(5);
  });

  it('moves at most unitsPerS/fs per call and lands exactly on the target (multi-call)', () => {
    const s = new Slew();
    s.setRate(1 / 0.2, FS); // full scale in 200 ms
    s.reset(0);
    const step = 1 / (0.2 * FS);
    let prev = 0;
    let calls = 0;
    while (s.y !== 1 && calls < 20000) {
      const y = s.process(1);
      expect(y - prev).toBeLessThanOrEqual(step * (1 + 1e-12));
      prev = y;
      calls++;
    }
    expect(s.y).toBe(1);
    expect(calls).toBe(Math.ceil(0.2 * FS));
    // reverses with the same limit
    const down = s.process(0);
    expect(1 - down).toBeCloseTo(step, 15);
  });

  it('reset() jumps immediately; rate ≤ 0 means unlimited', () => {
    const s = new Slew();
    s.setRate(1, FS);
    s.reset(0.75);
    expect(s.y).toBe(0.75);
    s.setRate(0, FS);
    expect(s.process(-3)).toBe(-3);
  });
});
```

- [ ] **Step 2: Run the util tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-util.test.ts
```

Expected: FAIL — the suite does not load: `Error: Cannot find module '../../src/dsp/util' imported from …/tests/unit/dsp-util.test.ts`.

- [ ] **Step 3: Implement `src/dsp/util.ts`**

Create `src/dsp/util.ts`:

```ts
/**
 * Scalar DSP helpers shared by every module in src/dsp (Phase 2a contract, spec §5.4).
 * Environment-free: no DOM, Web Audio, sim or data imports.
 */

const FLUSH_EPS = 1e-20;

/** |x| < 1e-20 → exactly 0 (JS has no flush-to-zero; avoids subnormal stalls). NaN/±Infinity pass through. */
export function flush(x: number): number {
  return x < FLUSH_EPS && x > -FLUSH_EPS ? 0 : x;
}

/** Clamp x into [lo, hi]. NaN passes through unchanged. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Decibels → linear amplitude gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear amplitude gain → decibels, floored at −200 dB (g ≤ 1e-10, 0, negative or NaN → −200). */
export function gainToDb(g: number): number {
  return g > 1e-10 ? 20 * Math.log10(g) : -200;
}

/** Hermite smoothstep 3t² − 2t³ of x between edges e0 and e1 (reversed edges allowed; e0 === e1 → step at e0). */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic PRNG: mulberry32 (bit-identical to the reference sequence for the same uint32 seed)
 * plus Box–Muller normal deviates with a cached second value.
 */
export class Rng {
  private s = 0;
  private spare = 0;
  private hasSpare = false;

  constructor(seed = 1) {
    this.seed(seed);
  }

  /** Restart the sequence from seed `s` (coerced to uint32); also drops a cached gauss() value. */
  seed(s: number): void {
    this.s = s >>> 0;
    this.spare = 0;
    this.hasSpare = false;
  }

  /** Uniform in [0, 1). */
  next(): number {
    const a = (this.s + 0x6d2b79f5) | 0;
    this.s = a;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [−1, 1). */
  bipolar(): number {
    return 2 * this.next() - 1;
  }

  /** Standard normal deviate (mean 0, variance 1). */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const u = 1 - this.next(); // (0, 1]: log() stays finite
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * v;
    this.spare = r * Math.sin(th);
    this.hasSpare = true;
    return r * Math.cos(th);
  }
}

/**
 * One-pole low-pass y += k·(x − y), evaluated as y = k·x + (1 − k)·y so k = 1 is an exact pass-through.
 * Unity DC gain and |H| ≤ 1 at every frequency for 0 ≤ k ≤ 1. A fresh instance has k = 1 and y = 0.
 */
export class OnePole {
  private k = 1;
  private a = 0; // 1 − k
  private state = 0;

  get y(): number {
    return this.state;
  }

  /** Time constant τ in seconds: k = 1 − e^(−1/(τ·fs)). τ ≤ 0 (or NaN) → pass-through (k = 1). */
  setTau(tauS: number, fs: number): void {
    this.setK(tauS > 0 && fs > 0 ? 1 - Math.exp(-1 / (tauS * fs)) : 1);
  }

  /** Corner in Hz: k = 1 − e^(−2π·hz/fs). hz ≤ 0 (or NaN) → k = 0 (the output holds its value). */
  setCutoff(hz: number, fs: number): void {
    this.setK(hz > 0 && fs > 0 ? 1 - Math.exp((-2 * Math.PI * hz) / fs) : 0);
  }

  process(x: number): number {
    const y = flush(this.k * x + this.a * this.state);
    this.state = y;
    return y;
  }

  reset(v = 0): void {
    this.state = v;
  }

  private setK(k: number): void {
    this.k = k;
    this.a = 1 - k;
  }
}

/** Linear slew limiter: y moves toward the target by at most unitsPerS/fs per process() call. */
export class Slew {
  private maxStep = Infinity;
  private state = 0;

  get y(): number {
    return this.state;
  }

  /** unitsPerS ≤ 0 or NaN → unlimited (y jumps straight to the target). */
  setRate(unitsPerS: number, fs: number): void {
    this.maxStep = unitsPerS > 0 && fs > 0 ? unitsPerS / fs : Infinity;
  }

  process(target: number): number {
    const s = this.state;
    const d = target - s;
    const m = this.maxStep;
    const y = d > m ? s + m : d < -m ? s - m : target;
    this.state = y;
    return y;
  }

  reset(v: number): void {
    this.state = v;
  }
}
```

- [ ] **Step 4: Run the util tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-util.test.ts
```

Expected: PASS — `Tests  20 passed (20)`.

- [ ] **Step 5: Write the failing biquad tests**

Create `tests/unit/dsp-biquad.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BUTTER4_Q, Biquad, Cascade } from '../../src/dsp/biquad';

const FS = 48000;

/** Impulse response (n samples) of a processor that starts from rest. */
function impulse(proc: (x: number) => number, n = 1 << 15): Float64Array {
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = proc(i === 0 ? 1 : 0);
  return h;
}

/** |H(f)| in dB of an impulse response. */
function dbAt(h: Float64Array, f: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < h.length; i++) {
    const w = (-2 * Math.PI * f * i) / FS;
    const v = h[i] ?? 0;
    re += v * Math.cos(w);
    im += v * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im));
}

function responseDb(proc: (x: number) => number, f: number): number {
  return dbAt(impulse(proc), f);
}

function biquadDb(configure: (b: Biquad) => void, f: number): number {
  const b = new Biquad();
  configure(b);
  return responseDb((x) => b.process(x), f);
}

describe('BUTTER4_Q', () => {
  it('holds the two 4th-order Butterworth section Qs', () => {
    expect(BUTTER4_Q).toHaveLength(2);
    expect(BUTTER4_Q[0]).toBeCloseTo(0.5411961, 7);
    expect(BUTTER4_Q[1]).toBeCloseTo(1.306563, 6);
  });
});

describe('Biquad', () => {
  it('is a pass-through until configured', () => {
    const b = new Biquad();
    expect(b.process(0.7)).toBe(0.7);
    expect(b.process(-0.2)).toBe(-0.2);
  });

  it('lowpass: unity DC, −3.01 dB at the corner with Q = 1/√2, steep stop band', () => {
    const lp = (b: Biquad) => b.lowpass(1000, Math.SQRT1_2, FS);
    expect(biquadDb(lp, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(lp, 1000)).toBeCloseTo(-3.0103, 3);
    expect(biquadDb(lp, 2000)).toBeLessThan(-12);
    expect(biquadDb(lp, 10000)).toBeLessThan(-40);
  });

  it('lowpass with Q = 1/√2 never exceeds 0 dB (passive in-loop filter)', () => {
    for (const fc of [250, 1500, 6000]) {
      const b = new Biquad();
      b.lowpass(fc, Math.SQRT1_2, FS);
      const h = impulse((x) => b.process(x), 4096);
      let max = -Infinity;
      for (let f = 0; f <= FS / 2; f += 50) max = Math.max(max, dbAt(h, f));
      expect(max).toBeLessThan(1e-9);
    }
  });

  it('highpass: zero DC, −3.01 dB at the corner, unity at Nyquist', () => {
    const hp = (b: Biquad) => b.highpass(1000, Math.SQRT1_2, FS);
    expect(biquadDb(hp, 10)).toBeLessThan(-75);
    expect(biquadDb(hp, 1000)).toBeCloseTo(-3.0103, 3);
    expect(biquadDb(hp, FS / 2 - 1)).toBeCloseTo(0, 3);
  });

  it('bandpass: constant 0 dB peak at f0 and no DC', () => {
    const bp = (b: Biquad) => b.bandpass(3000, 2, FS);
    expect(biquadDb(bp, 3000)).toBeCloseTo(0, 6);
    expect(biquadDb(bp, 1500)).toBeLessThan(-9);
    expect(biquadDb(bp, 6000)).toBeLessThan(-9);
    const b = new Biquad();
    b.bandpass(3000, 2, FS);
    let y = 1;
    for (let i = 0; i < 1 << 15; i++) y = b.process(1);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('peaking: +6 dB at f0, 0 dB far away', () => {
    const pk = (b: Biquad) => b.peaking(1000, 1, 6, FS);
    expect(biquadDb(pk, 1000)).toBeCloseTo(6, 6);
    expect(biquadDb(pk, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(pk, FS / 2 - 1)).toBeCloseTo(0, 3);
  });

  it('shelves: low shelf lifts DC by the gain, high shelf cuts Nyquist, half gain at f', () => {
    const ls = (b: Biquad) => b.lowShelf(200, 6, FS);
    expect(biquadDb(ls, 0)).toBeCloseTo(6, 6);
    expect(biquadDb(ls, 200)).toBeCloseTo(3, 3);
    expect(biquadDb(ls, FS / 2 - 1)).toBeCloseTo(0, 3);
    const hs = (b: Biquad) => b.highShelf(2000, -6, FS);
    expect(biquadDb(hs, 0)).toBeCloseTo(0, 6);
    expect(biquadDb(hs, 2000)).toBeCloseTo(-3, 3);
    expect(biquadDb(hs, FS / 2 - 1)).toBeCloseTo(-6, 3);
  });

  it('keeps its state across a coefficient change and clears it on reset (multi-call)', () => {
    const a = new Biquad();
    const b = new Biquad();
    a.lowpass(500, 0.7, FS);
    b.lowpass(500, 0.7, FS);
    for (let i = 0; i < 100; i++) {
      a.process(1);
      b.process(1);
    }
    a.lowpass(800, 0.7, FS); // state kept: continues smoothly from ≈ 1
    const fresh = new Biquad();
    fresh.lowpass(800, 0.7, FS);
    expect(a.process(1)).toBeGreaterThan(0.9);
    expect(fresh.process(1)).toBeLessThan(0.05);
    b.reset();
    b.lowpass(800, 0.7, FS);
    const ref = new Biquad();
    ref.lowpass(800, 0.7, FS);
    for (let i = 0; i < 16; i++) expect(b.process(1)).toBe(ref.process(1));
  });

  it('flushes its decaying tail to exactly 0', () => {
    const b = new Biquad();
    b.lowpass(2000, 0.7, FS);
    b.process(1);
    let y = 1;
    for (let i = 0; i < 20000; i++) y = b.process(0);
    expect(y).toBe(0);
  });

  it('sanitises non-finite or out-of-range parameters into a stable filter', () => {
    const b = new Biquad();
    b.lowpass(NaN, NaN, FS);
    let y = 0;
    for (let i = 0; i < 1000; i++) y = b.process(1);
    expect(Number.isFinite(y)).toBe(true);
    const c = new Biquad();
    c.peaking(1e9, 1, NaN, FS); // corner clamped to 0.49·fs, gain 0 dB
    for (let i = 0; i < 1000; i++) y = c.process(0.5);
    expect(y).toBeCloseTo(0.5, 9);
  });
});

describe('Cascade', () => {
  it('two BUTTER4_Q stages form a 4th-order Butterworth low-pass', () => {
    const c = new Cascade(2);
    c.stage(0).lowpass(1000, BUTTER4_Q[0], FS);
    c.stage(1).lowpass(1000, BUTTER4_Q[1], FS);
    const at = (f: number) => {
      c.reset();
      return responseDb((x) => c.process(x), f);
    };
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(1000)).toBeCloseTo(-3.0103, 3);
    expect(at(2000)).toBeLessThan(-24);
    expect(at(2000)).toBeGreaterThan(-24.6);
  });

  it('applies stages in order and starts as a pass-through', () => {
    const c = new Cascade(3);
    expect(c.process(0.25)).toBe(0.25);
    c.stage(2).peaking(1000, 1, 6, FS);
    c.reset(); // drop the 0.25 already stored in every stage
    const ref = new Biquad();
    ref.peaking(1000, 1, 6, FS);
    for (let i = 0; i < 64; i++) {
      const x = Math.sin(i * 0.3);
      expect(c.process(x)).toBe(ref.process(x));
    }
  });

  it('rejects bad stage counts and out-of-range stage indices', () => {
    expect(() => new Cascade(0)).toThrow(RangeError);
    expect(() => new Cascade(1.5)).toThrow(RangeError);
    const c = new Cascade(2);
    expect(() => c.stage(2)).toThrow(RangeError);
    expect(() => c.stage(-1)).toThrow(RangeError);
  });
});
```

- [ ] **Step 6: Run the biquad tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-biquad.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/biquad' imported from …/tests/unit/dsp-biquad.test.ts`.

- [ ] **Step 7: Implement `src/dsp/biquad.ts`**

Create `src/dsp/biquad.ts`:

```ts
/**
 * RBJ Audio-EQ-Cookbook biquads (R. Bristow-Johnson), Direct Form I with double-precision state.
 * The output state is flushed (|y| < 1e-20 → 0) on every sample. Coefficient setters keep the
 * filter state (safe for slow parameter sweeps); reset() clears the state and keeps the coefficients.
 */
import { flush } from './util';

/** Q of the two biquad sections of a 4th-order Butterworth filter: 1/(2·cos(π/8)), 1/(2·cos(3π/8)). */
export const BUTTER4_Q: readonly [number, number] = [
  1 / (2 * Math.cos(Math.PI / 8)),
  1 / (2 * Math.cos((3 * Math.PI) / 8)),
];

/** Corner frequency clamped into [1 Hz, 0.49·fs]; NaN → 1 Hz. */
function corner(f: number, fs: number): number {
  const hi = 0.49 * fs;
  return f > 1 ? (f < hi ? f : hi) : 1;
}

/** Q clamped to ≥ 1e-3; NaN → 1e-3. */
function quality(q: number): number {
  return q > 1e-3 ? q : 1e-3;
}

/** Shelf/peak gain in dB; non-finite → 0 dB. */
function decibels(g: number): number {
  return Number.isFinite(g) ? g : 0;
}

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  lowpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  highpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  }

  /** Band-pass with constant 0 dB peak gain at f. */
  bandpass(f: number, q: number, fs: number): void {
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }

  /** Low shelf, shelf slope S = 1. */
  lowShelf(f: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / Math.SQRT2; // sin(w)/2 · √((A + 1/A)(1/S − 1) + 2) with S = 1
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cs + sq),
      2 * A * (A - 1 - (A + 1) * cs),
      A * (A + 1 - (A - 1) * cs - sq),
      A + 1 + (A - 1) * cs + sq,
      -2 * (A - 1 + (A + 1) * cs),
      A + 1 + (A - 1) * cs - sq,
    );
  }

  /** High shelf, shelf slope S = 1. */
  highShelf(f: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cs + sq),
      -2 * A * (A - 1 + (A + 1) * cs),
      A * (A + 1 + (A - 1) * cs - sq),
      A + 1 - (A - 1) * cs + sq,
      2 * (A - 1 - (A + 1) * cs),
      A + 1 - (A - 1) * cs - sq,
    );
  }

  peaking(f: number, q: number, gainDb: number, fs: number): void {
    const A = Math.pow(10, decibels(gainDb) / 40);
    const w = (2 * Math.PI * corner(f, fs)) / fs;
    const cs = Math.cos(w);
    const al = Math.sin(w) / (2 * quality(q));
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }

  process(x: number): number {
    const y = flush(
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2,
    );
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
  }
}

/** Series chain of biquads, applied in index order. Every stage starts as a pass-through. */
export class Cascade {
  private readonly stages: Biquad[] = [];

  constructor(stages: number) {
    if (!Number.isInteger(stages) || stages < 1) {
      throw new RangeError(`Cascade needs a positive integer stage count, got ${stages}`);
    }
    for (let i = 0; i < stages; i++) this.stages.push(new Biquad());
  }

  /** The live Biquad of stage i (configure it in place). */
  stage(i: number): Biquad {
    const s = this.stages[i];
    if (s === undefined) throw new RangeError(`Cascade stage ${i} out of range [0, ${this.stages.length})`);
    return s;
  }

  process(x: number): number {
    const st = this.stages;
    let y = x;
    for (let i = 0; i < st.length; i++) y = st[i]!.process(y);
    return y;
  }

  reset(): void {
    for (let i = 0; i < this.stages.length; i++) this.stages[i]!.reset();
  }
}
```

- [ ] **Step 8: Run the biquad tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-biquad.test.ts
```

Expected: PASS — `Tests  14 passed (14)` in well under a second.

- [ ] **Step 9: Write the failing oversampler tests**

Create `tests/unit/dsp-oversample.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OS_FACTOR, OS_TAPS, Upsampler4 } from '../../src/dsp/oversample';
import { Rng } from '../../src/dsp/util';

const tap = (i: number): number => OS_TAPS[i] ?? NaN;

/** Interpolator gain in dB at a frequency given as a fraction of the INPUT rate (normalised by OS_FACTOR). */
function gainDb(fOverFsIn: number): number {
  let re = 0;
  let im = 0;
  for (let n = 0; n < OS_TAPS.length; n++) {
    const w = (-2 * Math.PI * fOverFsIn * n) / OS_FACTOR;
    re += tap(n) * Math.cos(w);
    im += tap(n) * Math.sin(w);
  }
  return 20 * Math.log10(Math.hypot(re, im) / OS_FACTOR);
}

describe('OS_TAPS', () => {
  it('is a symmetric 48-tap filter summing to OS_FACTOR', () => {
    expect(OS_FACTOR).toBe(4);
    expect(OS_TAPS).toBeInstanceOf(Float64Array);
    expect(OS_TAPS.length).toBe(48);
    let sum = 0;
    for (let n = 0; n < 48; n++) {
      expect(Number.isFinite(tap(n))).toBe(true);
      expect(tap(n)).toBeCloseTo(tap(47 - n), 15);
      sum += tap(n);
    }
    expect(sum).toBeCloseTo(4, 12);
    expect(tap(23)).toBe(Math.max(...OS_TAPS));
  });

  it('gives every polyphase branch ≈ unity DC gain', () => {
    for (let p = 0; p < 4; p++) {
      let s = 0;
      for (let m = 0; m < 12; m++) s += tap(p + 4 * m);
      expect(Math.abs(s - 1)).toBeLessThan(1e-4);
    }
  });

  it('meets the Kaiser β = 8 / 0.45·fs_in design: flat pass band, −6 dB at cutoff, ≥ 80 dB stop band', () => {
    let passDev = 0;
    for (let f = 0; f <= 0.25; f += 0.0025) passDev = Math.max(passDev, Math.abs(gainDb(f)));
    expect(passDev).toBeLessThan(0.01);
    expect(gainDb(0.45)).toBeCloseTo(-6.02, 1);
    let stop = -Infinity;
    for (let f = 0.7; f <= 2; f += 0.0025) stop = Math.max(stop, gainDb(f));
    expect(stop).toBeLessThan(-80);
  });
});

describe('Upsampler4', () => {
  it('replays OS_TAPS as its impulse response, four taps per push (multi-call)', () => {
    const u = new Upsampler4();
    for (let k = 0; k < 12; k++) {
      u.push(k === 0 ? 1 : 0);
      for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(tap(4 * k + p));
    }
    u.push(0);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
  });

  it('equals direct convolution of the zero-stuffed input with OS_TAPS', () => {
    const n = 300;
    const x = new Float64Array(n);
    const rng = new Rng(12345);
    for (let i = 0; i < n; i++) x[i] = rng.bipolar();
    const u = new Upsampler4();
    for (let k = 0; k < n; k++) {
      u.push(x[k] ?? 0);
      for (let p = 0; p < 4; p++) {
        const outIndex = 4 * k + p;
        let ref = 0;
        for (let j = 0; j < 48; j++) {
          const s = outIndex - j;
          if (s >= 0 && s % 4 === 0) ref += tap(j) * (x[s / 4] ?? 0);
        }
        expect(u.out[p]).toBeCloseTo(ref, 12);
      }
    }
  });

  it('interpolates a 1 kHz sine at 48 kHz to within 1e-4 (group delay 5.875 input samples)', () => {
    const u = new Upsampler4();
    const f = 1000 / 48000;
    let err = 0;
    for (let k = 0; k < 2000; k++) {
      u.push(Math.sin(2 * Math.PI * f * k));
      if (k < 50) continue;
      for (let p = 0; p < 4; p++) {
        const t = k + p / 4 - 5.875;
        err = Math.max(err, Math.abs((u.out[p] ?? NaN) - Math.sin(2 * Math.PI * f * t)));
      }
    }
    expect(err).toBeLessThan(1e-4);
  });

  it('reveals the inter-sample peak of an fs/4 sine sampled at ±0.707', () => {
    const u = new Upsampler4();
    let samplePeak = 0;
    let truePeak = 0;
    for (let k = 0; k < 400; k++) {
      const x = Math.sin((Math.PI / 2) * k + Math.PI / 4);
      samplePeak = Math.max(samplePeak, Math.abs(x));
      u.push(x);
      if (k > 20) for (let p = 0; p < 4; p++) truePeak = Math.max(truePeak, Math.abs(u.out[p] ?? 0));
    }
    expect(samplePeak).toBeCloseTo(Math.SQRT1_2, 9);
    expect(truePeak).toBeGreaterThan(0.97);
    expect(truePeak).toBeLessThanOrEqual(1.001);
  });

  it('reset() clears the history and the outputs', () => {
    const u = new Upsampler4();
    for (let k = 0; k < 30; k++) u.push(1);
    expect(u.out[0]).toBeCloseTo(1, 3);
    u.reset();
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
    u.push(0);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(0);
    u.push(1);
    for (let p = 0; p < 4; p++) expect(u.out[p]).toBe(tap(p));
  });
});
```

- [ ] **Step 10: Run the oversampler tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-oversample.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/oversample' imported from …/tests/unit/dsp-oversample.test.ts`.

- [ ] **Step 11: Implement `src/dsp/oversample.ts`**

Create `src/dsp/oversample.ts` (the taps are computed from the Kaiser formula at module load — no literal table):

```ts
/**
 * 4× polyphase upsampler shared by the true-peak limiter (output stage) and analysis (ITU-R BS.1770
 * style true-peak measurement). The interpolation filter is designed here at module load from the
 * Kaiser-window method (Kaiser 1974): a 48-tap windowed sinc, β = 8, cutoff 0.45·fs_in.
 */

export const OS_FACTOR = 4;

const TAP_COUNT = 48;
const KAISER_BETA = 8;
/** Cutoff in cycles per OUTPUT sample: 0.45·fs_in / (4·fs_in). */
const CUTOFF = 0.45 / OS_FACTOR;
/** Input samples of history each polyphase branch needs: 48 / 4. */
const HISTORY = TAP_COUNT / OS_FACTOR;

/** Zeroth-order modified Bessel function of the first kind, I0(x), by its power series. */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * h[n] = 2fc·sinc(2fc·(n − M)) · I0(β·√(1 − ((n − M)/M)²)) / I0(β), M = (N − 1)/2, then scaled so
 * Σh = OS_FACTOR (zero-stuffing loses a factor 4; each polyphase branch then has ≈ unity DC gain).
 */
function designTaps(): Float64Array {
  const taps = new Float64Array(TAP_COUNT);
  const mid = (TAP_COUNT - 1) / 2; // 23.5: never an integer, so the sinc argument is never 0
  const i0Beta = besselI0(KAISER_BETA);
  let sum = 0;
  for (let n = 0; n < TAP_COUNT; n++) {
    const t = n - mid;
    const arg = Math.PI * 2 * CUTOFF * t;
    const sinc = Math.sin(arg) / arg;
    const r = t / mid;
    const w = besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0Beta;
    const v = 2 * CUTOFF * sinc * w;
    taps[n] = v;
    sum += v;
  }
  const g = OS_FACTOR / sum;
  for (let n = 0; n < TAP_COUNT; n++) taps[n] = (taps[n] ?? 0) * g;
  return taps;
}

/** 48-tap Kaiser (β = 8) windowed-sinc low-pass, cutoff 0.45·fs_in, Σ = 4 (normalised for 4× upsampling). */
export const OS_TAPS: Float64Array = designTaps();

/**
 * Zero-stuffing 4× interpolator in polyphase form. After push(x[k]):
 * out[p] = Σ_{m=0..11} OS_TAPS[p + 4m] · x[k − m], p = 0..3 (output times 4k + p).
 * Group delay: 23.5 output samples = 5.875 input samples.
 */
export class Upsampler4 {
  /** The 4 upsampled samples belonging to the most recent push (overwritten in place). */
  readonly out = new Float64Array(OS_FACTOR);
  /** Input history, mirrored (h[i] === h[i + 12]) so every read window is contiguous. */
  private readonly hist = new Float64Array(2 * HISTORY);
  private pos = 0;

  reset(): void {
    this.hist.fill(0);
    this.out.fill(0);
    this.pos = 0;
  }

  push(x: number): void {
    let p = this.pos - 1;
    if (p < 0) p = HISTORY - 1;
    this.pos = p;
    const h = this.hist;
    h[p] = x;
    h[p + HISTORY] = x; // x[k − m] now sits at h[p + m] for m = 0..11
    const t = OS_TAPS;
    const out = this.out;
    for (let ph = 0; ph < OS_FACTOR; ph++) {
      let acc = 0;
      for (let m = 0; m < HISTORY; m++) acc += t[ph + OS_FACTOR * m]! * h[p + m]!;
      out[ph] = acc;
    }
  }
}
```

- [ ] **Step 12: Run the oversampler tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-oversample.test.ts
```

Expected: PASS — `Tests  8 passed (8)`.

- [ ] **Step 13: Write the failing fixture test**

Create `tests/unit/dsp-fixtures.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef } from '../../src/contracts';
import { MAX_COMBUSTION, firingHz } from '../../src/contracts';

const IDS = [
  'i4-test',
  'i5-test',
  'i6-test',
  'v8-crossplane-test',
  'v8-flatplane-test',
  'v8-sc-test',
  'flat4-uel-test',
  'rotary-test',
] as const;

function load(id: string): EngineDef {
  const url = new URL(`../fixtures/engines/${id}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as EngineDef;
}

const DEFS = IDS.map((id) => [id, load(id)] as const);

/** Exact key sets of every object level of EngineDef (catches missing and misspelt fields). */
const KEYS: Record<string, string[]> = {
  '': ['id', 'name', 'inspiredBy', 'set', 'notes', 'spec', 'voicing'],
  spec: ['layout', 'cycleDeg', 'combustion', 'rpm', 'aspiration', 'gearbox', 'sources'],
  'spec.layout': ['type', 'bankAngleDeg', 'crank', 'displacementL'],
  'spec.rpm': ['idle', 'redline', 'limiter'],
  'spec.rpm.limiter': ['type', 'rpm', 'hysteresisRpm'],
  'spec.aspiration': ['type', 'turbo', 'supercharger'],
  'spec.gearbox': ['type', 'overallRatios', 'drivenTyre', 'shiftTimeS', 'tc'],
  'spec.sources': ['layout', 'combustion', 'rpm', 'aspiration', 'gearbox'],
  voicing: [
    'pulse', 'headersM', 'collectors', 'turbine', 'exhaust', 'intake', 'forcedInduction',
    'mechanical', 'overrun', 'cabin', 'launchRpm', 'estimated',
  ],
  'voicing.pulse': ['widthDeg', 'alpha', 'beta', 'evoOffsetDeg', 'cycleAsymmetry'],
  'voicing.exhaust': ['midPipeM', 'mufflerSectionsM', 'mufflerAction', 'tailpipeM', 'valve'],
  'voicing.exhaust.valve': ['fitted', 'openGainDb'],
  'voicing.intake': ['runnerM', 'helmholtzHz', 'gain'],
  'voicing.mechanical': ['blockGain', 'valvetrainGain'],
  'voicing.overrun': ['crackleRate', 'fuelCutResumeRpm'],
  'voicing.cabin': ['lowpassHz'],
};

function at(root: unknown, path: string): unknown {
  return path === '' ? root : path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root);
}

/** Cylinder numbers (entry index + 1) in firing order. */
function firingOrder(def: EngineDef): number[] {
  return def.spec.combustion
    .map((c, i) => ({ a: c.angleDeg, cyl: i + 1 }))
    .sort((x, y) => x.a - y.a)
    .map((x) => x.cyl);
}

/** Sorted firing angles of one bank. */
function bankAngles(def: EngineDef, bank: number): number[] {
  return def.spec.combustion.filter((c) => c.bank === bank).map((c) => c.angleDeg).sort((a, b) => a - b);
}

function gaps(sorted: number[], cycle: number): number[] {
  return sorted.map((a, i) => ((sorted[(i + 1) % sorted.length] ?? 0) - a + cycle) % cycle || cycle);
}

describe('fixture engines (tests/fixtures/engines)', () => {
  it.each(DEFS)('%s is a complete EngineDef with exactly the contract fields', (id, def) => {
    expect(def.id).toBe(id);
    for (const [path, keys] of Object.entries(KEYS)) {
      expect(Object.keys(at(def, path) as object).sort(), path).toEqual([...keys].sort());
    }
    for (const c of def.spec.combustion) expect(Object.keys(c).sort()).toEqual(['angleDeg', 'bank']);
    for (const c of def.voicing.collectors) expect(Object.keys(c).sort()).toEqual(['banks', 'lengthM']);
    for (const g of Object.values(def.spec.sources)) expect(g).toEqual(['fixture']);
    expect(def.voicing.estimated).toBe(true);
  });

  it.each(DEFS)('%s has valid combustion entries, rpm, gearbox and voicing ranges', (_id, def) => {
    const s = def.spec;
    const v = def.voicing;
    const n = s.combustion.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(MAX_COMBUSTION);
    const angles = s.combustion.map((c) => c.angleDeg);
    expect(new Set(angles).size).toBe(n);
    for (const c of s.combustion) {
      expect(c.angleDeg).toBeGreaterThanOrEqual(0);
      expect(c.angleDeg).toBeLessThan(s.cycleDeg);
      expect(Number.isInteger(c.bank) && c.bank >= 0).toBe(true);
    }
    expect(s.rpm.idle).toBeGreaterThanOrEqual(500);
    expect(s.rpm.idle).toBeLessThanOrEqual(1200);
    expect(s.rpm.redline).toBeGreaterThanOrEqual(6500); // invariants run steady 6000 rpm ≤ redline − 500
    expect(s.rpm.redline).toBeLessThanOrEqual(10000);
    expect(s.rpm.limiter.rpm).toBeGreaterThanOrEqual(s.rpm.redline);
    expect(s.rpm.limiter.hysteresisRpm).toBeGreaterThanOrEqual(50);
    expect(s.rpm.limiter.hysteresisRpm).toBeLessThanOrEqual(600);
    const r = s.gearbox.overallRatios;
    expect(r.length).toBeGreaterThanOrEqual(6);
    expect(r.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1] ?? 0);
    expect(s.gearbox.drivenTyre).toMatch(/^\d{3}\/\d{2}R\d{2}$/);
    expect(s.gearbox.shiftTimeS).toBeGreaterThanOrEqual(0.05);
    expect(s.gearbox.shiftTimeS).toBeLessThanOrEqual(0.6);
    if (s.gearbox.type === 'tc-auto') {
      expect(s.gearbox.tc).not.toBeNull();
      expect(s.gearbox.tc?.couplingSR).toBeGreaterThanOrEqual(0.8);
      expect(s.gearbox.tc?.couplingSR).toBeLessThanOrEqual(0.95);
    } else {
      expect(s.gearbox.tc).toBeNull();
    }
    // voicing
    expect(v.headersM).toHaveLength(n);
    for (const h of v.headersM) expect(h > 0 && h <= 1.5).toBe(true);
    const banks = new Set(s.combustion.map((c) => c.bank));
    const covered = new Set(v.collectors.flatMap((c) => c.banks));
    for (const b of banks) expect(covered.has(b)).toBe(true);
    for (const c of v.collectors) expect(c.lengthM > 0 && c.lengthM <= 1.0).toBe(true);
    expect(v.exhaust.midPipeM > 0 && v.exhaust.midPipeM <= 3.0).toBe(true);
    expect(v.exhaust.mufflerSectionsM.length).toBeGreaterThanOrEqual(1);
    expect(v.exhaust.mufflerSectionsM.length).toBeLessThanOrEqual(4);
    for (const m of v.exhaust.mufflerSectionsM) expect(m > 0 && m <= 0.8).toBe(true);
    expect(v.exhaust.tailpipeM > 0 && v.exhaust.tailpipeM <= 1.2).toBe(true);
    expect(v.exhaust.mufflerAction).toBeGreaterThanOrEqual(0);
    expect(v.exhaust.mufflerAction).toBeLessThanOrEqual(1);
    expect(v.intake.runnerM > 0 && v.intake.runnerM <= 0.6).toBe(true);
    const maxWidth = s.cycleDeg === 1080 ? 300 : 90;
    expect(v.pulse.widthDeg).toBeGreaterThanOrEqual(40);
    expect(v.pulse.widthDeg).toBeLessThanOrEqual(maxWidth);
    expect(v.pulse.alpha).toBeGreaterThan(0);
    expect(v.pulse.beta).toBeGreaterThan(0);
    expect(v.pulse.cycleAsymmetry).toBeGreaterThanOrEqual(0);
    expect(v.pulse.cycleAsymmetry).toBeLessThanOrEqual(1);
    expect(v.overrun.fuelCutResumeRpm).toBeGreaterThan(s.rpm.idle);
    expect(v.launchRpm).toBeGreaterThan(s.rpm.idle);
    expect(v.launchRpm).toBeLessThan(s.rpm.redline);
    // aspiration ↔ turbine / forced induction consistency
    const t = s.aspiration.type;
    expect(s.aspiration.turbo !== null).toBe(t === 'turbo');
    expect(s.aspiration.supercharger !== null).toBe(t === 'supercharger');
    expect(v.turbine !== null).toBe(t === 'turbo');
    expect(v.forcedInduction !== null).toBe(t !== 'na');
    if (v.forcedInduction) {
      expect(v.forcedInduction.cabinGainDb).toBeGreaterThanOrEqual(-20);
      expect(v.forcedInduction.cabinGainDb).toBeLessThanOrEqual(-10);
    }
  });

  it('encodes the contract firing orders and layouts', () => {
    const def = Object.fromEntries(DEFS) as Record<(typeof IDS)[number], EngineDef>;
    expect(firingOrder(def['i4-test'])).toEqual([1, 3, 4, 2]);
    expect(firingOrder(def['i5-test'])).toEqual([1, 2, 4, 5, 3]);
    expect(firingOrder(def['i6-test'])).toEqual([1, 5, 3, 6, 2, 4]);
    expect(firingOrder(def['v8-crossplane-test'])).toEqual([1, 8, 4, 3, 6, 5, 7, 2]);
    expect(firingOrder(def['v8-sc-test'])).toEqual([1, 8, 4, 3, 6, 5, 7, 2]);
    expect(firingOrder(def['v8-flatplane-test'])).toEqual([1, 5, 3, 7, 4, 8, 2, 6]);
    expect(firingOrder(def['flat4-uel-test'])).toEqual([1, 3, 2, 4]);
    // even overall spacing = cycleDeg / n everywhere (I5 144°, rotary 180°)
    const even: [string, number][] = [
      ['i4-test', 180], ['i5-test', 144], ['i6-test', 120], ['v8-crossplane-test', 90],
      ['v8-flatplane-test', 90], ['v8-sc-test', 90], ['flat4-uel-test', 180], ['rotary-test', 180],
    ];
    for (const [id, gap] of even) {
      const d = load(id);
      const all = d.spec.combustion.map((c) => c.angleDeg).sort((a, b) => a - b);
      expect(gaps(all, d.spec.cycleDeg), id).toEqual(all.map(() => gap));
    }
    // cross-plane banks fire unevenly (270/180/90/180), flat-plane banks evenly (180)
    const xp = def['v8-crossplane-test'];
    expect(gaps(bankAngles(xp, 0), 720)).toEqual([270, 180, 90, 180]);
    expect(gaps(bankAngles(xp, 1), 720)).toEqual([90, 180, 270, 180]);
    const fp = def['v8-flatplane-test'];
    expect(gaps(bankAngles(fp, 0), 720)).toEqual([180, 180, 180, 180]);
    expect(gaps(bankAngles(fp, 1), 720)).toEqual([180, 180, 180, 180]);
    // rotary: 1080° cycle, rotor faces 0/360/720 (bank 0) and 180/540/900 (bank 1), sequential twin turbo
    const ro = def['rotary-test'];
    expect(ro.spec.cycleDeg).toBe(1080);
    expect(ro.spec.layout.type).toBe('rotary');
    expect(bankAngles(ro, 0)).toEqual([0, 360, 720]);
    expect(bankAngles(ro, 1)).toEqual([180, 540, 900]);
    expect(ro.spec.aspiration.turbo).toEqual({ count: 2, layout: 'sequential' });
    expect(ro.spec.gearbox.type).toBe('manual');
    // supercharger: roots, pulley 2.4, 4 lobes, gear 1 → whine order 19.2
    const sc = def['v8-sc-test'].spec.aspiration.supercharger;
    expect(sc).toEqual({ kind: 'roots', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 });
    expect(def['v8-sc-test'].spec.gearbox.type).toBe('tc-auto');
    // boxer: unequal 0.45 / 0.75 headers, bank 0 short and bank 1 long
    const f4 = def['flat4-uel-test'];
    expect(f4.spec.layout.bankAngleDeg).toBe(180);
    f4.spec.combustion.forEach((c, i) => expect(f4.voicing.headersM[i]).toBe(c.bank === 0 ? 0.45 : 0.75));
    // aspiration / gearbox per contract
    expect(def['i4-test'].spec.aspiration.type).toBe('turbo');
    expect(def['i4-test'].spec.gearbox.type).toBe('dct');
    expect(def['i5-test'].spec.gearbox.type).toBe('dct');
    expect(def['i6-test'].spec.aspiration.type).toBe('na');
    expect(def['i6-test'].spec.gearbox.type).toBe('manual');
    expect(def['v8-crossplane-test'].spec.gearbox.type).toBe('tc-auto');
    expect(def['v8-flatplane-test'].spec.gearbox.type).toBe('dct');
    expect(def['flat4-uel-test'].spec.gearbox.type).toBe('manual');
  });

  it('even-fire fixtures use equal headers (amendment B8); uneven-fire ones do not', () => {
    for (const id of ['i4-test', 'i6-test', 'v8-flatplane-test']) {
      expect(new Set(load(id).voicing.headersM).size, id).toBe(1);
    }
    for (const id of ['i5-test', 'v8-crossplane-test', 'v8-sc-test', 'flat4-uel-test']) {
      expect(new Set(load(id).voicing.headersM).size, id).toBeGreaterThan(1);
    }
  });

  it('agrees with the shared firingHz formula', () => {
    const fire = (id: string, rpm: number) => {
      const d = load(id);
      return firingHz(rpm, d.spec.combustion.length, d.spec.cycleDeg);
    };
    expect(fire('i4-test', 6000)).toBeCloseTo(200, 9);
    expect(fire('i5-test', 6000)).toBeCloseTo(250, 9);
    expect(fire('i6-test', 6000)).toBeCloseTo(300, 9);
    expect(fire('v8-crossplane-test', 6000)).toBeCloseTo(400, 9);
    expect(fire('rotary-test', 6000)).toBeCloseTo(200, 9);
  });
});
```

- [ ] **Step 14: Run the fixture test and watch it fail**

Run:

```bash
npx vitest run tests/unit/dsp-fixtures.test.ts
```

Expected: FAIL — the suite does not load: `Error: ENOENT: no such file or directory, open '…/tests/fixtures/engines/i4-test.json'`.

- [ ] **Step 15: Create the `i4-test` fixture**

Create `tests/fixtures/engines/i4-test.json`:

```json
{
  "id": "i4-test",
  "name": "Test 2.0 Turbo Inline-4",
  "inspiredBy": "Test fixture (no real car)",
  "set": "euro",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. Even-fire 1-3-4-2, equal headers (B8).",
  "spec": {
    "layout": {"type": "inline", "bankAngleDeg": 0, "crank": "n/a", "displacementL": 1.98},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 540, "bank": 0},
      {"angleDeg": 180, "bank": 0},
      {"angleDeg": 360, "bank": 0}
    ],
    "rpm": {
      "idle": 750,
      "redline": 6500,
      "limiter": {"type": "ignition-soft", "rpm": 6600, "hysteresisRpm": 150}
    },
    "aspiration": {"type": "turbo", "turbo": {"count": 1, "layout": "single"}, "supercharger": null},
    "gearbox": {
      "type": "dct",
      "overallRatios": [13.56, 9.03, 6.06, 4.42, 3.39, 2.78, 2.29],
      "drivenTyre": "225/40R18",
      "shiftTimeS": 0.1,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 55, "alpha": 9, "beta": 4, "evoOffsetDeg": 140, "cycleAsymmetry": 0.05},
    "headersM": [0.6, 0.6, 0.6, 0.6],
    "collectors": [{"banks": [0], "lengthM": 0.35}],
    "turbine": {"reflection": 0.45, "lpHz": 1500},
    "exhaust": {
      "midPipeM": 1.4,
      "mufflerSectionsM": [0.21, 0.34, 0.47],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {"fitted": true, "openGainDb": 4}
    },
    "intake": {"runnerM": 0.3, "helmholtzHz": 140, "gain": 0.4},
    "forcedInduction": {"spoolTimeS": 0.6, "maxShaftKrpm": 180, "lift": "bov", "cabinGainDb": -14},
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.6, "fuelCutResumeRpm": 1250},
    "cabin": {"lowpassHz": 600},
    "launchRpm": 2900,
    "estimated": true
  }
}
```

- [ ] **Step 16: Create the `i5-test` fixture**

Create `tests/fixtures/engines/i5-test.json`:

```json
{
  "id": "i5-test",
  "name": "Test 2.5 Turbo Inline-5",
  "inspiredBy": "Test fixture (no real car)",
  "set": "euro",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. 1-2-4-5-3 at 144 deg; unequal headers give the half-order warble.",
  "spec": {
    "layout": {"type": "inline", "bankAngleDeg": 0, "crank": "n/a", "displacementL": 2.48},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 144, "bank": 0},
      {"angleDeg": 576, "bank": 0},
      {"angleDeg": 288, "bank": 0},
      {"angleDeg": 432, "bank": 0}
    ],
    "rpm": {
      "idle": 850,
      "redline": 7000,
      "limiter": {"type": "ignition-soft", "rpm": 7100, "hysteresisRpm": 150}
    },
    "aspiration": {"type": "turbo", "turbo": {"count": 1, "layout": "single"}, "supercharger": null},
    "gearbox": {
      "type": "dct",
      "overallRatios": [13.71, 9.74, 6.47, 4.35, 3.23, 2.58, 2.16],
      "drivenTyre": "255/30R19",
      "shiftTimeS": 0.1,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 60, "alpha": 9, "beta": 4, "evoOffsetDeg": 140, "cycleAsymmetry": 0.15},
    "headersM": [0.62, 0.55, 0.7, 0.58, 0.66],
    "collectors": [{"banks": [0], "lengthM": 0.4}],
    "turbine": {"reflection": 0.45, "lpHz": 1500},
    "exhaust": {
      "midPipeM": 1.5,
      "mufflerSectionsM": [0.22, 0.36, 0.5],
      "mufflerAction": 0.55,
      "tailpipeM": 0.55,
      "valve": {"fitted": true, "openGainDb": 5}
    },
    "intake": {"runnerM": 0.32, "helmholtzHz": 145, "gain": 0.4},
    "forcedInduction": {"spoolTimeS": 0.55, "maxShaftKrpm": 190, "lift": "flutter", "cabinGainDb": -13},
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.8, "fuelCutResumeRpm": 1350},
    "cabin": {"lowpassHz": 620},
    "launchRpm": 3150,
    "estimated": true
  }
}
```

- [ ] **Step 17: Create the `i6-test` fixture**

Create `tests/fixtures/engines/i6-test.json`:

```json
{
  "id": "i6-test",
  "name": "Test 3.0 Inline-6 NA",
  "inspiredBy": "Test fixture (no real car)",
  "set": "jdm",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. Even-fire 1-5-3-6-2-4, two 3-into-1 collectors (cyl 1-3, 4-6), equal headers (B8), no valve.",
  "spec": {
    "layout": {"type": "inline", "bankAngleDeg": 0, "crank": "n/a", "displacementL": 2.99},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 480, "bank": 0},
      {"angleDeg": 240, "bank": 0},
      {"angleDeg": 600, "bank": 1},
      {"angleDeg": 120, "bank": 1},
      {"angleDeg": 360, "bank": 1}
    ],
    "rpm": {
      "idle": 700,
      "redline": 7000,
      "limiter": {"type": "fuel-hard", "rpm": 7100, "hysteresisRpm": 200}
    },
    "aspiration": {"type": "na", "turbo": null, "supercharger": null},
    "gearbox": {
      "type": "manual",
      "overallRatios": [14.22, 8.03, 5.33, 4.08, 3.46, 2.94],
      "drivenTyre": "275/35R19",
      "shiftTimeS": 0.3,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 50, "alpha": 9, "beta": 4, "evoOffsetDeg": 140, "cycleAsymmetry": 0.05},
    "headersM": [0.55, 0.55, 0.55, 0.55, 0.55, 0.55],
    "collectors": [{"banks": [0], "lengthM": 0.35}, {"banks": [1], "lengthM": 0.35}],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.3,
      "mufflerSectionsM": [0.2, 0.32, 0.44, 0.56],
      "mufflerAction": 0.65,
      "tailpipeM": 0.5,
      "valve": {"fitted": false, "openGainDb": 0}
    },
    "intake": {"runnerM": 0.35, "helmholtzHz": 150, "gain": 0.4},
    "forcedInduction": null,
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.4, "fuelCutResumeRpm": 1200},
    "cabin": {"lowpassHz": 650},
    "launchRpm": 3850,
    "estimated": true
  }
}
```

- [ ] **Step 18: Create the `v8-crossplane-test` fixture**

Create `tests/fixtures/engines/v8-crossplane-test.json`:

```json
{
  "id": "v8-crossplane-test",
  "name": "Test 6.2 Cross-Plane V8 NA",
  "inspiredBy": "Test fixture (no real car)",
  "set": "american",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. 90-deg cross-plane 1-8-4-3-6-5-7-2; odd cylinders bank 0, even bank 1; unequal headers.",
  "spec": {
    "layout": {"type": "v", "bankAngleDeg": 90, "crank": "cross-plane", "displacementL": 6.16},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 630, "bank": 1},
      {"angleDeg": 270, "bank": 0},
      {"angleDeg": 180, "bank": 1},
      {"angleDeg": 450, "bank": 0},
      {"angleDeg": 360, "bank": 1},
      {"angleDeg": 540, "bank": 0},
      {"angleDeg": 90, "bank": 1}
    ],
    "rpm": {
      "idle": 650,
      "redline": 6600,
      "limiter": {"type": "fuel-hard", "rpm": 6700, "hysteresisRpm": 250}
    },
    "aspiration": {"type": "na", "turbo": null, "supercharger": null},
    "gearbox": {
      "type": "tc-auto",
      "overallRatios": [14.84, 9.86, 6.62, 5.26, 4.06, 3.15, 2.65, 2.11],
      "drivenTyre": "305/30R20",
      "shiftTimeS": 0.2,
      "tc": {"stallRpmWot": 2400, "lockupTurbineRpm": 1300, "couplingSR": 0.88}
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 65, "alpha": 8, "beta": 3.5, "evoOffsetDeg": 140, "cycleAsymmetry": 0.25},
    "headersM": [0.58, 0.66, 0.62, 0.7, 0.66, 0.58, 0.7, 0.62],
    "collectors": [{"banks": [0], "lengthM": 0.4}, {"banks": [1], "lengthM": 0.45}],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.6,
      "mufflerSectionsM": [0.24, 0.38, 0.52],
      "mufflerAction": 0.5,
      "tailpipeM": 0.6,
      "valve": {"fitted": true, "openGainDb": 4}
    },
    "intake": {"runnerM": 0.4, "helmholtzHz": 160, "gain": 0.45},
    "forcedInduction": null,
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.7, "fuelCutResumeRpm": 1150},
    "cabin": {"lowpassHz": 560},
    "launchRpm": 3650,
    "estimated": true
  }
}
```

- [ ] **Step 19: Create the `v8-flatplane-test` fixture**

Create `tests/fixtures/engines/v8-flatplane-test.json`:

```json
{
  "id": "v8-flatplane-test",
  "name": "Test 4.5 Flat-Plane V8 NA",
  "inspiredBy": "Test fixture (no real car)",
  "set": "exotic",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. Flat-plane 1-5-3-7-4-8-2-6, banks alternate every 90 deg, equal headers (B8), single muffler section.",
  "spec": {
    "layout": {"type": "v", "bankAngleDeg": 90, "crank": "flat-plane", "displacementL": 4.5},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 540, "bank": 0},
      {"angleDeg": 180, "bank": 0},
      {"angleDeg": 360, "bank": 0},
      {"angleDeg": 90, "bank": 1},
      {"angleDeg": 630, "bank": 1},
      {"angleDeg": 270, "bank": 1},
      {"angleDeg": 450, "bank": 1}
    ],
    "rpm": {
      "idle": 900,
      "redline": 9000,
      "limiter": {"type": "ignition-hard", "rpm": 9100, "hysteresisRpm": 150}
    },
    "aspiration": {"type": "na", "turbo": null, "supercharger": null},
    "gearbox": {
      "type": "dct",
      "overallRatios": [13.68, 9.72, 7.24, 5.73, 4.57, 3.73, 2.8],
      "drivenTyre": "295/35R20",
      "shiftTimeS": 0.1,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 45, "alpha": 10, "beta": 4.5, "evoOffsetDeg": 140, "cycleAsymmetry": 0.05},
    "headersM": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    "collectors": [{"banks": [0], "lengthM": 0.3}, {"banks": [1], "lengthM": 0.3}],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.2,
      "mufflerSectionsM": [0.3],
      "mufflerAction": 0.4,
      "tailpipeM": 0.4,
      "valve": {"fitted": true, "openGainDb": 5}
    },
    "intake": {"runnerM": 0.25, "helmholtzHz": 180, "gain": 0.5},
    "forcedInduction": null,
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.9, "fuelCutResumeRpm": 1400},
    "cabin": {"lowpassHz": 680},
    "launchRpm": 4950,
    "estimated": true
  }
}
```

- [ ] **Step 20: Create the `v8-sc-test` fixture**

Create `tests/fixtures/engines/v8-sc-test.json`:

```json
{
  "id": "v8-sc-test",
  "name": "Test 6.2 Supercharged V8",
  "inspiredBy": "Test fixture (no real car)",
  "set": "american",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. Cross-plane V8 with a roots blower: whine order 2.4 x 1 x (2 x 4) = 19.2.",
  "spec": {
    "layout": {"type": "v", "bankAngleDeg": 90, "crank": "cross-plane", "displacementL": 6.17},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 630, "bank": 1},
      {"angleDeg": 270, "bank": 0},
      {"angleDeg": 180, "bank": 1},
      {"angleDeg": 450, "bank": 0},
      {"angleDeg": 360, "bank": 1},
      {"angleDeg": 540, "bank": 0},
      {"angleDeg": 90, "bank": 1}
    ],
    "rpm": {
      "idle": 750,
      "redline": 6500,
      "limiter": {"type": "fuel-soft", "rpm": 6600, "hysteresisRpm": 250}
    },
    "aspiration": {
      "type": "supercharger",
      "turbo": null,
      "supercharger": {"kind": "roots", "pulleyRatio": 2.4, "gearRatio": 1, "lobes": 4}
    },
    "gearbox": {
      "type": "tc-auto",
      "overallRatios": [12.34, 8.23, 5.53, 4.38, 3.38, 2.62, 2.2, 1.76],
      "drivenTyre": "305/35R20",
      "shiftTimeS": 0.2,
      "tc": {"stallRpmWot": 2600, "lockupTurbineRpm": 1400, "couplingSR": 0.86}
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 65, "alpha": 8, "beta": 3.5, "evoOffsetDeg": 140, "cycleAsymmetry": 0.2},
    "headersM": [0.6, 0.68, 0.64, 0.72, 0.68, 0.6, 0.72, 0.64],
    "collectors": [{"banks": [0], "lengthM": 0.42}, {"banks": [1], "lengthM": 0.48}],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.7,
      "mufflerSectionsM": [0.26, 0.42],
      "mufflerAction": 0.55,
      "tailpipeM": 0.6,
      "valve": {"fitted": true, "openGainDb": 4}
    },
    "intake": {"runnerM": 0.45, "helmholtzHz": 160, "gain": 0.45},
    "forcedInduction": {"spoolTimeS": 0.05, "maxShaftKrpm": 15, "lift": "bov", "cabinGainDb": -12},
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.6, "fuelCutResumeRpm": 1250},
    "cabin": {"lowpassHz": 540},
    "launchRpm": 2900,
    "estimated": true
  }
}
```

- [ ] **Step 21: Create the `flat4-uel-test` fixture**

Create `tests/fixtures/engines/flat4-uel-test.json`:

```json
{
  "id": "flat4-uel-test",
  "name": "Test 2.5 Turbo Flat-4 (unequal headers)",
  "inspiredBy": "Test fixture (no real car)",
  "set": "jdm",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. Boxer 1-3-2-4; bank 0 (cyl 1, 3) short 0.45 m headers, bank 1 (cyl 2, 4) long 0.75 m; one up-pipe collector; no valve.",
  "spec": {
    "layout": {"type": "flat", "bankAngleDeg": 180, "crank": "n/a", "displacementL": 2.46},
    "cycleDeg": 720,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 360, "bank": 1},
      {"angleDeg": 180, "bank": 0},
      {"angleDeg": 540, "bank": 1}
    ],
    "rpm": {
      "idle": 750,
      "redline": 6700,
      "limiter": {"type": "fuel-hard", "rpm": 6800, "hysteresisRpm": 300}
    },
    "aspiration": {"type": "turbo", "turbo": {"count": 1, "layout": "single"}, "supercharger": null},
    "gearbox": {
      "type": "manual",
      "overallRatios": [14.2, 8.74, 5.93, 4.45, 3.78, 2.96],
      "drivenTyre": "245/40R18",
      "shiftTimeS": 0.3,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 70, "alpha": 8, "beta": 3.5, "evoOffsetDeg": 140, "cycleAsymmetry": 0.25},
    "headersM": [0.45, 0.75, 0.45, 0.75],
    "collectors": [{"banks": [0, 1], "lengthM": 0.3}],
    "turbine": {"reflection": 0.5, "lpHz": 1400},
    "exhaust": {
      "midPipeM": 1.5,
      "mufflerSectionsM": [0.22, 0.35, 0.48],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {"fitted": false, "openGainDb": 0}
    },
    "intake": {"runnerM": 0.3, "helmholtzHz": 130, "gain": 0.4},
    "forcedInduction": {"spoolTimeS": 0.7, "maxShaftKrpm": 170, "lift": "bov", "cabinGainDb": -14},
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.5, "fuelCutResumeRpm": 1250},
    "cabin": {"lowpassHz": 600},
    "launchRpm": 3000,
    "estimated": true
  }
}
```

- [ ] **Step 22: Create the `rotary-test` fixture**

Create `tests/fixtures/engines/rotary-test.json`:

```json
{
  "id": "rotary-test",
  "name": "Test 1.3 Twin-Rotor Turbo",
  "inspiredBy": "Test fixture (no real car)",
  "set": "jdm",
  "notes": "Phase 2a DSP test fixture. Invented but plausible values; not sourced, not a real car. 13B-like: cycleDeg 1080, rotor 1 faces 0/360/720 (bank 0), rotor 2 faces 180/540/900 (bank 1); sequential twin turbos.",
  "spec": {
    "layout": {"type": "rotary", "bankAngleDeg": 0, "crank": "n/a", "displacementL": 1.31},
    "cycleDeg": 1080,
    "combustion": [
      {"angleDeg": 0, "bank": 0},
      {"angleDeg": 360, "bank": 0},
      {"angleDeg": 720, "bank": 0},
      {"angleDeg": 180, "bank": 1},
      {"angleDeg": 540, "bank": 1},
      {"angleDeg": 900, "bank": 1}
    ],
    "rpm": {
      "idle": 800,
      "redline": 8000,
      "limiter": {"type": "fuel-hard", "rpm": 8200, "hysteresisRpm": 200}
    },
    "aspiration": {"type": "turbo", "turbo": {"count": 2, "layout": "sequential"}, "supercharger": null},
    "gearbox": {
      "type": "manual",
      "overallRatios": [14.27, 8.28, 5.7, 4.1, 3.48, 2.95],
      "drivenTyre": "255/40R17",
      "shiftTimeS": 0.3,
      "tc": null
    },
    "sources": {
      "layout": ["fixture"],
      "combustion": ["fixture"],
      "rpm": ["fixture"],
      "aspiration": ["fixture"],
      "gearbox": ["fixture"]
    }
  },
  "voicing": {
    "pulse": {"widthDeg": 260, "alpha": 6, "beta": 2.5, "evoOffsetDeg": 140, "cycleAsymmetry": 0.1},
    "headersM": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    "collectors": [{"banks": [0, 1], "lengthM": 0.3}],
    "turbine": {"reflection": 0.4, "lpHz": 1600},
    "exhaust": {
      "midPipeM": 1.6,
      "mufflerSectionsM": [0.25, 0.4],
      "mufflerAction": 0.5,
      "tailpipeM": 0.55,
      "valve": {"fitted": false, "openGainDb": 0}
    },
    "intake": {"runnerM": 0.28, "helmholtzHz": 170, "gain": 0.45},
    "forcedInduction": {"spoolTimeS": 0.5, "maxShaftKrpm": 200, "lift": "bov", "cabinGainDb": -12},
    "mechanical": {"blockGain": 0.3, "valvetrainGain": 0.1},
    "overrun": {"crackleRate": 0.9, "fuelCutResumeRpm": 1300},
    "cabin": {"lowpassHz": 580},
    "launchRpm": 3600,
    "estimated": true
  }
}
```

- [ ] **Step 23: Run the fixture test and watch it pass**

Run:

```bash
npx vitest run tests/unit/dsp-fixtures.test.ts
```

Expected: PASS — `Tests  19 passed (19)`.

- [ ] **Step 24: Run all Task 1 tests together**

Run:

```bash
npx vitest run tests/unit/dsp-util.test.ts tests/unit/dsp-biquad.test.ts tests/unit/dsp-oversample.test.ts tests/unit/dsp-fixtures.test.ts
```

Expected: PASS — `Test Files  4 passed (4)`, `Tests  61 passed (61)`.

- [ ] **Step 25: Lint and typecheck**

Run:

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no errors or warnings.

---

### Task 2: Fractional delay line, waveguide tube section and N-port scattering junction

**Files:**
- Create: `src/dsp/delay.ts`
- Create: `src/dsp/junction.ts`
- Create: `src/dsp/waveguide.ts`
- Test: `tests/unit/dsp-delay.test.ts`
- Test: `tests/unit/dsp-junction.test.ts`
- Test: `tests/unit/dsp-waveguide.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED): `SPEED_OF_SOUND_MAX` (700).
  - Task 1 `src/dsp/util.ts`: `class OnePole` (`setCutoff(hz, fs)`, `setTau(0, fs)` = exact pass-through, `process(x): number`, `reset(v?)`); `class Rng` (`new Rng(seed)`, `next()`, `bipolar()`) — junction test only.
- Produces (contract API exactly, plus the additive boxing-free methods marked "extra", which amendment B2 encourages and Task 3 uses):
  - `src/dsp/delay.ts` — `class FracDelay`:
    - `constructor(capacity: number)` — integer ≥ 8, else `RangeError`. Storage is a Float32 ring kept twice (`buf[i] === buf[i + capacity]`) so reads never wrap.
    - `write(x: number): void`; `readonly capacity: number`; `clear(): void` (zeros, back to "nothing written").
    - `readLagrange(d: number): number` — 3rd-order Lagrange on the samples at delays ⌊d⌋−1 … ⌊d⌋+2 (fraction always in the central interval ⇒ |H| ≤ 1, unity DC gain, group delay exactly d; exact for cubics). d is clamped into [1, capacity − 3]; NaN propagates.
    - `readLinear(d: number): number` — clamped into [0, capacity − 2]; exact at integer d.
    - extra `setLagrangeDelay(d: number): void` + `readLagrangeFixed(): number` — the same read with the kernel precomputed (four multiply-adds per read; default delay 1 before the first call).
    - extra `sumSquares(count: number): number` — Σx² over the `count` newest samples (clamped into [0, capacity]).
  - `src/dsp/junction.ts`:
    - `class Junction { constructor(maxPorts: number); configure(admittances: ArrayLike<number>, n: number): void; scatter(incoming: Float64Array, outgoing: Float64Array): void; readonly ports: number }` — pJ = 2·Σ(Y_i·p_i⁺)/ΣY_i, p_i⁻ = pJ − p_i⁺; conserves Σ Y·p² exactly. `configure` copies the admittances, throws `RangeError` (changing nothing) for n ∉ [1, maxPorts], too few admittances, or any Y that is not finite and > 0; it never allocates, so it may be called every sample. `scatter` reads/writes only indices 0 … n−1 (arrays must not alias). `ports` is 0 until configured. n = 1 ⇒ total reflection (+1).
    - `terminationReflect(x: number, r: number): number` = r·x with r clamped into [−0.999, 0.999] (NaN propagates); `MAX_REFLECTION = 0.999`.
  - `src/dsp/waveguide.ts`:
    - `MIN_DELAY_SAMPLES = 4`.
    - `class Waveguide { constructor(capacitySamples: number /* integer ≥ 8, else RangeError (from FracDelay) */); configure(lengthM: number, cMps: number, fs: number, lossHz: number): void; setSpeed(cMps: number): void; outRight(): number; outLeft(): number; input(rightIn: number, leftIn: number): void; clear(): void; readonly delaySamples: number; energy(): number }`.
    - `configure` sets delaySamples = lengthM/cMps·fs and clears the state; `RangeError` when an argument is non-positive/non-finite, when lengthM/700·fs < 4 (the B3 minimum, asserted at SPEED_OF_SOUND_MAX whatever cMps is), or when the delay is outside [4, capacity − 2]. `lossHz` in (0, fs/2) → one-pole wall-loss low-pass at the input of each rail (unity DC, |H| ≤ 1, adds (1 − k)/k samples of low-frequency group delay); `lossHz` ≤ 0 or ≥ fs/2 → lossless rails.
    - `setSpeed(c)` recomputes the delay, clamps it into [4, capacity − 2], never throws, ignores c ≤ 0/NaN; before `configure` it is harmless.
    - Per sample: `outRight()` (wave arriving at end B) and `outLeft()` (arriving at A) **before** `input(rightIn at A, leftIn at B)`; a value input at sample n arrives exactly delaySamples later.
    - extra `outPair(dst: Float64Array, j: number): void` (dst[j] = outRight(), dst[j+1] = outLeft()) and `inputPair(src: Float64Array, j: number): void` (= input(src[j], src[j+1])) — bit-identical to the scalar forms, no doubles crossing call boundaries.
    - `energy()` = Σ squares of both rails over the ⌊delaySamples − 1⌋ + 3 newest samples (everything a future read can touch). Per sample it can swing up to ≈ 2× around a reflection (the 4-tap kernel still holds samples already re-emitted), so passivity is judged on maxima over windows ≥ one round trip; with an integer delay and no loss it equals r^(4k) after k round trips exactly.

**Cross-task premises:** (open each file and confirm before coding)
- Task 1 `src/dsp/util.ts` exports `OnePole` with no constructor arguments, where `setTau(0, fs)` makes `process` an exact pass-through and `setCutoff(hz, fs)` sets k = 1 − e^(−2π·hz/fs); and `Rng` with `next()`/`bipolar()`.
- `src/contracts.ts` exports `SPEED_OF_SOUND_MAX = 700`.
- Phase 0 tooling as in Task 1 (Vitest include `tests/unit/**/*.test.ts`, `noUncheckedIndexedAccess`, typescript-eslint **recommended** so `!` on in-range typed-array reads lints clean).
- Task 3 is the only planned consumer of `Waveguide`, `Junction`, `terminationReflect` and the extras; other tasks may use `FracDelay` through the contract API only (e.g. Task 7's 0.7 ms decorrelation delay needs capacity ≥ 8).
- Task 10's amendment-B1 lint rule covers `write`, `readLagrange`, `readLinear`, `readLagrangeFixed`, `scatter`, `outRight`, `outLeft`, `outPair` and `input`, but **not** `inputPair`: its anchored name list `^(…|input|out[A-Za-z]*)$` does not match that name. None of these methods (`inputPair` included) contains allocation syntax. (Verified while authoring: with the B1 selector enabled these files lint clean, and planting `const t = [pJ];` inside `scatter` is reported as "Hot path must not allocate". Re-verified in review: an allocation planted in `inputPair` is not reported unless T10's selector widens `input` to `input[A-Za-z]*`, which is a T10-owned change; until then `inputPair` stays allocation-free by review only.)

- [ ] **Step 1: Write the failing delay-line tests**

Create `tests/unit/dsp-delay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FracDelay } from '../../src/dsp/delay';

/** Writes an impulse then zeros; returns readFn(d) for each of `len` subsequent states (impulse at age k = 0..len−1). */
function impulseReads(cap: number, len: number, read: (dl: FracDelay) => number): number[] {
  const dl = new FracDelay(cap);
  const out: number[] = [];
  dl.write(1);
  for (let k = 0; k < len; k++) {
    out.push(read(dl));
    dl.write(0);
  }
  return out;
}

describe('FracDelay', () => {
  it('rejects capacities that are not integers ≥ 8', () => {
    expect(() => new FracDelay(7)).toThrow(RangeError);
    expect(() => new FracDelay(16.5)).toThrow(RangeError);
    expect(new FracDelay(64).capacity).toBe(64);
  });

  it('returns exact samples at integer delays, also after the ring wraps (multi-call)', () => {
    const dl = new FracDelay(16);
    for (let n = 0; n < 100; n++) {
      dl.write(n);
      for (let d = 1; d <= 13; d++) {
        if (n - d < 0) continue;
        expect(dl.readLagrange(d)).toBeCloseTo(n - d, 4);
        expect(dl.readLinear(d)).toBe(n - d);
      }
      expect(dl.readLinear(0)).toBe(n);
    }
  });

  it('stores Float32 values', () => {
    const dl = new FracDelay(8);
    dl.write(0.1);
    expect(dl.readLinear(0)).toBe(Math.fround(0.1));
  });

  it('linear interpolation mixes the two neighbours', () => {
    const dl = new FracDelay(16);
    dl.write(2); // delay 1 after the next write
    dl.write(4); // delay 0
    expect(dl.readLinear(0.25)).toBeCloseTo(3.5, 12);
    expect(dl.readLinear(0.5)).toBeCloseTo(3, 12);
  });

  it('Lagrange-3 is exact for cubic signals at any fractional delay', () => {
    const dl = new FracDelay(32);
    const cubic = (t: number) => 0.001 * t * t * t - 0.02 * t * t + 0.3 * t - 1;
    for (let n = 0; n < 20; n++) dl.write(cubic(n));
    // most recent sample is t = 19; delay d → t = 19 − d
    for (const d of [1, 1.25, 2.5, 3.999, 7.3, 12.75]) {
      expect(dl.readLagrange(d)).toBeCloseTo(Math.fround(cubic(19 - d)), 4);
    }
  });

  it('Lagrange-3 impulse response has unity DC gain, group delay d and |H| ≤ 1', () => {
    for (const d of [1, 1.3, 2.5, 5.77, 9.999]) {
      const h = impulseReads(32, 16, (dl) => dl.readLagrange(d));
      let sum = 0;
      let moment = 0;
      for (let k = 0; k < h.length; k++) {
        sum += h[k] ?? 0;
        moment += k * (h[k] ?? 0);
      }
      expect(sum).toBeCloseTo(1, 12);
      expect(moment).toBeCloseTo(d, 9);
      let maxMag = 0;
      for (let i = 0; i <= 512; i++) {
        const w = (Math.PI * i) / 512;
        let re = 0;
        let im = 0;
        for (let k = 0; k < h.length; k++) {
          re += (h[k] ?? 0) * Math.cos(w * k);
          im -= (h[k] ?? 0) * Math.sin(w * k);
        }
        maxMag = Math.max(maxMag, Math.hypot(re, im));
      }
      expect(maxMag).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('clamps delays into the documented ranges and propagates NaN', () => {
    const dl = new FracDelay(8);
    for (let n = 0; n < 8; n++) dl.write(n);
    expect(dl.readLagrange(0)).toBeCloseTo(dl.readLagrange(1), 12);
    expect(dl.readLagrange(100)).toBeCloseTo(dl.readLagrange(5), 12);
    expect(dl.readLinear(-3)).toBe(7);
    expect(dl.readLinear(100)).toBe(dl.readLinear(6));
    expect(Number.isNaN(dl.readLagrange(NaN))).toBe(true);
  });

  it('readLagrangeFixed() equals readLagrange() at the delay given to setLagrangeDelay() (multi-call)', () => {
    const dl = new FracDelay(64);
    expect(dl.readLagrangeFixed()).toBe(0); // fresh line, default delay 1
    let seed = 0.37;
    for (let n = 0; n < 200; n++) {
      seed = (seed * 9301 + 0.49297) % 1;
      dl.write(seed - 0.5);
      if (n === 0) expect(dl.readLagrangeFixed()).toBe(dl.readLagrange(1));
      for (const d of [1, 2.75, 13.01, 60.5, 0.2, 99]) {
        dl.setLagrangeDelay(d);
        expect(dl.readLagrangeFixed()).toBeCloseTo(dl.readLagrange(d), 14);
      }
    }
  });

  it('sumSquares covers the most recent samples and clear() zeroes everything', () => {
    const dl = new FracDelay(8);
    for (const x of [1, 2, 3, 4]) dl.write(x);
    expect(dl.sumSquares(2)).toBe(16 + 9);
    expect(dl.sumSquares(4)).toBe(30);
    expect(dl.sumSquares(100)).toBe(30);
    expect(dl.sumSquares(-1)).toBe(0);
    dl.clear();
    expect(dl.sumSquares(8)).toBe(0);
    expect(dl.readLinear(0)).toBe(0);
    dl.write(5);
    expect(dl.readLinear(0)).toBe(5);
    expect(dl.readLinear(1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the delay-line tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-delay.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/delay' imported from …/tests/unit/dsp-delay.test.ts`.

- [ ] **Step 3: Implement `src/dsp/delay.ts`**

Create `src/dsp/delay.ts`:

```ts
/**
 * Fractional delay line (Smith, "Physical Audio Signal Processing": interpolated delay lines).
 * Float32 ring stored twice (buf[i] === buf[i + capacity]) so every read window is contiguous
 * and no read needs a modulo. Delay d is measured in samples from the most recently written one.
 */
export class FracDelay {
  readonly capacity: number;
  private readonly buf: Float32Array;
  /** Index (in [0, capacity)) of the most recently written sample. */
  private w: number;
  private readonly maxLagrange: number;
  private readonly maxLinear: number;
  // kernel cached by setLagrangeDelay() for readLagrangeFixed()
  private fixI = 1;
  private hm1 = 0;
  private h0 = 1;
  private h1 = 0;
  private h2 = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 8) {
      throw new RangeError(`FracDelay capacity must be an integer ≥ 8, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Float32Array(2 * capacity);
    this.w = capacity - 1;
    this.maxLagrange = capacity - 3;
    this.maxLinear = capacity - 2;
  }

  write(x: number): void {
    let w = this.w + 1;
    if (w === this.capacity) w = 0;
    this.w = w;
    this.buf[w] = x;
    this.buf[w + this.capacity] = x;
  }

  /**
   * 3rd-order Lagrange interpolation at delay d (clamped into [1, capacity − 3]; NaN propagates).
   * Uses the samples at delays i−1, i, i+1, i+2 (i = ⌊d⌋), so the fraction always lies in the
   * central interval, where the interpolator has |H(e^jω)| ≤ 1 (passive inside loops).
   */
  readLagrange(d: number): number {
    const dd = d < 1 ? 1 : d > this.maxLagrange ? this.maxLagrange : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const base = this.w + this.capacity - i; // index of the sample at delay i
    const b = this.buf;
    const xm1 = b[base + 1]!;
    const x0 = b[base]!;
    const x1 = b[base - 1]!;
    const x2 = b[base - 2]!;
    const fp1 = f + 1;
    const fm1 = f - 1;
    const fm2 = f - 2;
    return (
      (-f * fm1 * fm2 * xm1) / 6 +
      (fp1 * fm1 * fm2 * x0) / 2 -
      (fp1 * f * fm2 * x1) / 2 +
      (fp1 * f * fm1 * x2) / 6
    );
  }

  /**
   * Precomputes the Lagrange-3 kernel for delay d (clamped exactly like readLagrange) so that
   * readLagrangeFixed() costs four multiply-adds. Call again whenever the delay changes.
   */
  setLagrangeDelay(d: number): void {
    const dd = d < 1 ? 1 : d > this.maxLagrange ? this.maxLagrange : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const fp1 = f + 1;
    const fm1 = f - 1;
    const fm2 = f - 2;
    this.fixI = i;
    this.hm1 = (-f * fm1 * fm2) / 6;
    this.h0 = (fp1 * fm1 * fm2) / 2;
    this.h1 = (-fp1 * f * fm2) / 2;
    this.h2 = (fp1 * f * fm1) / 6;
  }

  /** readLagrange() at the delay last passed to setLagrangeDelay() (delay 1 before the first call). */
  readLagrangeFixed(): number {
    const base = this.w + this.capacity - this.fixI;
    const b = this.buf;
    return this.hm1 * b[base + 1]! + this.h0 * b[base]! + this.h1 * b[base - 1]! + this.h2 * b[base - 2]!;
  }

  /** Linear interpolation at delay d (clamped into [0, capacity − 2]; NaN propagates). */
  readLinear(d: number): number {
    const dd = d < 0 ? 0 : d > this.maxLinear ? this.maxLinear : d;
    const i = Math.floor(dd);
    const f = dd - i;
    const base = this.w + this.capacity - i;
    const b = this.buf;
    const x0 = b[base]!;
    return x0 + f * (b[base - 1]! - x0);
  }

  /** Σ x² over the `count` most recent samples (count clamped into [0, capacity]). Not part of the hot path. */
  sumSquares(count: number): number {
    const n = count < 0 ? 0 : count > this.capacity ? this.capacity : Math.floor(count);
    const b = this.buf;
    const end = this.w + this.capacity; // most recent sample
    let s = 0;
    for (let k = 0; k < n; k++) {
      const v = b[end - k]!;
      s += v * v;
    }
    return s;
  }

  clear(): void {
    this.buf.fill(0);
    this.w = this.capacity - 1;
  }
}
```

- [ ] **Step 4: Run the delay-line tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-delay.test.ts
```

Expected: PASS — `Tests  9 passed (9)`.

- [ ] **Step 5: Write the failing junction tests**

Create `tests/unit/dsp-junction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Junction, MAX_REFLECTION, terminationReflect } from '../../src/dsp/junction';
import { Rng } from '../../src/dsp/util';

function power(y: ArrayLike<number>, p: Float64Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += (y[i] ?? 0) * (p[i] ?? 0) ** 2;
  return s;
}

describe('Junction', () => {
  it('validates its construction and configuration', () => {
    expect(() => new Junction(0)).toThrow(RangeError);
    expect(() => new Junction(2.5)).toThrow(RangeError);
    const j = new Junction(3);
    expect(j.ports).toBe(0);
    expect(() => j.configure([1, 1, 1, 1], 4)).toThrow(RangeError);
    expect(() => j.configure([1], 2)).toThrow(RangeError);
    expect(() => j.configure([1, 0], 2)).toThrow(RangeError);
    expect(() => j.configure([1, NaN], 2)).toThrow(RangeError);
    expect(() => j.configure([1, Infinity], 2)).toThrow(RangeError);
    expect(j.ports).toBe(0); // failed configure changed nothing
  });

  it('equal 2-port is transparent; 1:3 area step gives r = −0.5, t = 0.5', () => {
    const j = new Junction(2);
    const inc = new Float64Array(2);
    const out = new Float64Array(2);
    j.configure([2, 2], 2);
    inc[0] = 0.8;
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(0, 15);
    expect(out[1]).toBeCloseTo(0.8, 15);
    j.configure([1, 3], 2); // reconfigure (multi-call)
    inc[0] = 1;
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(-0.5, 15); // (Y1 − Y2)/(Y1 + Y2)
    expect(out[1]).toBeCloseTo(0.5, 15); // 2·Y1/(Y1 + Y2)
    // the reverse direction: contraction gives r = +0.5, pressure transmission 1.5
    inc[0] = 0;
    inc[1] = 1;
    j.scatter(inc, out);
    expect(out[1]).toBeCloseTo(0.5, 15);
    expect(out[0]).toBeCloseTo(1.5, 15);
  });

  it('a single port reflects totally (closed end)', () => {
    const j = new Junction(4);
    j.configure([5], 1);
    const inc = new Float64Array([0.3, 9, 9, 9]);
    const out = new Float64Array(4).fill(7);
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(0.3, 15);
    expect(Array.from(out.subarray(1))).toEqual([7, 7, 7]); // untouched beyond `ports`
  });

  it('conserves admittance-weighted power exactly for random admittances and waves', () => {
    const rng = new Rng(2024);
    const j = new Junction(17);
    const inc = new Float64Array(17);
    const out = new Float64Array(17);
    const y = new Float64Array(17);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng.next() * 17);
      for (let i = 0; i < n; i++) {
        y[i] = 0.05 + 5 * rng.next();
        inc[i] = rng.bipolar();
      }
      j.configure(y, n);
      expect(j.ports).toBe(n);
      j.scatter(inc, out);
      const pin = power(y, inc, n);
      expect(Math.abs(power(y, out, n) - pin)).toBeLessThan(1e-12 * Math.max(1, pin));
      // all ports share one junction pressure p⁺ + p⁻
      const pJ = (inc[0] ?? 0) + (out[0] ?? 0);
      for (let i = 1; i < n; i++) expect((inc[i] ?? 0) + (out[i] ?? 0)).toBeCloseTo(pJ, 12);
    }
  });

  it('copies the admittances (later edits of the source array have no effect)', () => {
    const y = [1, 3];
    const j = new Junction(2);
    j.configure(y, 2);
    y[1] = 1;
    const inc = new Float64Array([1, 0]);
    const out = new Float64Array(2);
    j.scatter(inc, out);
    expect(out[0]).toBeCloseTo(-0.5, 15);
  });
});

describe('terminationReflect', () => {
  it('returns r·x for |r| < 1 and clamps |r| to 0.999', () => {
    expect(terminationReflect(2, 0.95)).toBeCloseTo(1.9, 15);
    expect(terminationReflect(2, -0.9)).toBeCloseTo(-1.8, 15);
    expect(MAX_REFLECTION).toBe(0.999);
    expect(terminationReflect(1, 1.5)).toBe(0.999);
    expect(terminationReflect(1, -7)).toBe(-0.999);
    expect(Number.isNaN(terminationReflect(1, NaN))).toBe(true);
  });
});
```

- [ ] **Step 6: Run the junction tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-junction.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/junction' imported from …/tests/unit/dsp-junction.test.ts`.

- [ ] **Step 7: Implement `src/dsp/junction.ts`**

Create `src/dsp/junction.ts`:

```ts
/**
 * Lossless parallel N-port scattering junction of acoustic tubes (Smith, "Physical Audio Signal
 * Processing", lossless scattering junctions). Admittances Y_i ∝ cross-section area:
 *   pJ = 2·Σ(Y_i·p_i⁺)/Σ(Y_i);  p_i⁻ = pJ − p_i⁺   (p⁺ incoming, p⁻ outgoing)
 * Power is conserved exactly: Σ Y_i·(p_i⁻)² = Σ Y_i·(p_i⁺)².
 */

/** Largest |r| terminationReflect allows (keeps every termination strictly lossy). */
export const MAX_REFLECTION = 0.999;

export class Junction {
  private readonly y: Float64Array;
  private n = 0;
  private twoOverSum = 0;

  constructor(maxPorts: number) {
    if (!Number.isInteger(maxPorts) || maxPorts < 1) {
      throw new RangeError(`Junction maxPorts must be a positive integer, got ${maxPorts}`);
    }
    this.y = new Float64Array(maxPorts);
  }

  /** Number of active ports (0 until configured). */
  get ports(): number {
    return this.n;
  }

  /** Copies admittances[0..n−1] (each finite and > 0). Never allocates; safe to call per sample. */
  configure(admittances: ArrayLike<number>, n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > this.y.length) {
      throw new RangeError(`Junction port count ${n} outside [1, ${this.y.length}]`);
    }
    if (admittances.length < n) {
      throw new RangeError(`Junction needs ${n} admittances, got ${admittances.length}`);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = admittances[i];
      if (v === undefined || !(v > 0) || v === Infinity) {
        throw new RangeError(`Junction admittance ${i} must be finite and > 0, got ${v}`);
      }
      sum += v;
    }
    for (let i = 0; i < n; i++) this.y[i] = admittances[i] ?? 0;
    this.n = n;
    this.twoOverSum = 2 / sum;
  }

  /** Reads incoming[0..n−1] and writes outgoing[0..n−1] (the two arrays may not alias). */
  scatter(incoming: Float64Array, outgoing: Float64Array): void {
    const n = this.n;
    const y = this.y;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += y[i]! * incoming[i]!;
    const pJ = acc * this.twoOverSum;
    for (let i = 0; i < n; i++) outgoing[i] = pJ - incoming[i]!;
  }
}

/**
 * Reflected wave at a tube termination: r·x with r clamped into [−0.999, 0.999].
 * Open end ≈ −0.9 (the caller adds a low-pass), closed end ≈ +0.95.
 */
export function terminationReflect(x: number, r: number): number {
  const rr = r > MAX_REFLECTION ? MAX_REFLECTION : r < -MAX_REFLECTION ? -MAX_REFLECTION : r;
  return rr * x;
}
```

- [ ] **Step 8: Run the junction tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-junction.test.ts
```

Expected: PASS — `Tests  6 passed (6)`.

- [ ] **Step 9: Write the failing waveguide tests (energy-decay passivity included)**

Create `tests/unit/dsp-waveguide.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { terminationReflect } from '../../src/dsp/junction';
import { MIN_DELAY_SAMPLES, Waveguide } from '../../src/dsp/waveguide';

const FS = 48000;
const C = 343;
/** Length (m) whose delay at 343 m/s and 48 kHz is `d` samples. */
const lenFor = (d: number): number => (d * C) / FS;

/** Impulse into the right rail at end A; returns outRight() for n samples. */
function rightImpulse(wg: Waveguide, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(wg.outRight());
    wg.outLeft();
    wg.input(i === 0 ? 1 : 0, 0);
  }
  return out;
}

/** Closed–closed tube: both ends reflect with r; an impulse enters at A. Returns energy() after every sample. */
function resonate(wg: Waveguide, r: number, n: number): Float64Array {
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const atB = wg.outRight();
    const atA = wg.outLeft();
    wg.input((i === 0 ? 1 : 0) + terminationReflect(atA, r), terminationReflect(atB, r));
    e[i] = wg.energy();
  }
  return e;
}

function windowMaxima(e: Float64Array, win: number): number[] {
  const m: number[] = [];
  for (let i = 0; i < e.length; i += win) {
    let x = 0;
    for (let k = i; k < Math.min(i + win, e.length); k++) x = Math.max(x, e[k] ?? 0);
    m.push(x);
  }
  return m;
}

describe('Waveguide', () => {
  it('validates configure (≥ 4 samples at 700 m/s, ≤ capacity − 2, positive finite arguments)', () => {
    const wg = new Waveguide(256);
    expect(MIN_DELAY_SAMPLES).toBe(4);
    expect(() => wg.configure(0.05, C, FS, 0)).toThrow(RangeError); // 3.43 samples at 700 m/s
    expect(() => wg.configure(1.9, C, FS, 0)).toThrow(RangeError); // 265.9 samples > 254
    expect(() => wg.configure(0, C, FS, 0)).toThrow(RangeError);
    expect(() => wg.configure(0.5, -1, FS, 0)).toThrow(RangeError);
    expect(() => wg.configure(0.5, C, NaN, 0)).toThrow(RangeError);
    wg.configure(0.06, C, FS, 0); // 4.11 samples at 700 m/s: allowed
    expect(wg.delaySamples).toBeCloseTo((0.06 / C) * FS, 12);
  });

  it('delays each rail by exactly delaySamples (integer delay, lossless)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    expect(wg.delaySamples).toBeCloseTo(48, 9);
    const h = rightImpulse(wg, 100);
    h.forEach((v, i) => expect(v).toBeCloseTo(i === 48 ? 1 : 0, 9));
    // the left rail is independent: impulse at B arrives at A after 48 samples
    wg.clear();
    const left: number[] = [];
    for (let i = 0; i < 100; i++) {
      wg.outRight();
      left.push(wg.outLeft());
      wg.input(0, i === 0 ? 1 : 0);
    }
    left.forEach((v, i) => expect(v).toBeCloseTo(i === 48 ? 1 : 0, 9));
  });

  it('fractional delays keep unity DC gain and a group delay of exactly delaySamples', () => {
    const wg = new Waveguide(256);
    for (const d of [8.5, 37.3, 100.75]) {
      wg.configure(lenFor(d), C, FS, 0);
      const h = rightImpulse(wg, 140);
      let sum = 0;
      let moment = 0;
      h.forEach((v, i) => {
        sum += v;
        moment += i * v;
      });
      expect(sum).toBeCloseTo(1, 6);
      expect(moment / sum).toBeCloseTo(d, 5);
    }
  });

  it('the wall-loss low-pass keeps DC and removes energy (|H| ≤ 1)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(30), C, FS, 2000);
    const h = rightImpulse(wg, 250);
    const sum = h.reduce((a, b) => a + b, 0);
    const energy = h.reduce((a, b) => a + b * b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(energy).toBeLessThan(0.3);
    expect(h.slice(0, 29).every((v) => Math.abs(v) < 1e-9)).toBe(true); // nothing before the delay
  });

  it('lossless integer-delay resonator loses exactly r² per reflection', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    const r = 0.999;
    const e = resonate(wg, r, 96 * 101);
    for (let k = 0; k <= 100; k++) {
      // 10 samples after the k-th round trip the pulse sits mid-rail: energy = r^(4k) (Float32 rails)
      const ref = Math.pow(r, 4 * k);
      expect(Math.abs((e[96 * k + 10] ?? 0) - ref) / ref).toBeLessThan(1e-5);
    }
  });

  it('is passive with fractional delays: round-trip window maxima never rise and decay to −120 dB', () => {
    for (const [d, loss] of [
      [37.37, 6000],
      [37.37, 0],
      [100.5, 3000],
    ] as const) {
      const wg = new Waveguide(256);
      wg.configure(lenFor(d), C, FS, loss);
      const r = loss > 0 ? 0.95 : 0.999;
      const e = resonate(wg, r, 48000);
      const m = windowMaxima(e, Math.ceil(2 * d));
      for (let i = 1; i < m.length; i++) expect(m[i]).toBeLessThanOrEqual((m[i - 1] ?? 0) * (1 + 1e-12));
      if (loss > 0) expect(e[e.length - 1]).toBeLessThan(1e-12 * (m[0] ?? 0));
    }
  });

  it('setSpeed rescales the delay, clamps it and ignores c ≤ 0 (multi-call)', () => {
    const wg = new Waveguide(256);
    wg.configure(lenFor(48), C, FS, 0);
    wg.setSpeed(2 * C);
    expect(wg.delaySamples).toBeCloseTo(24, 9);
    const h = rightImpulse(wg, 60);
    h.forEach((v, i) => expect(v).toBeCloseTo(i === 24 ? 1 : 0, 9));
    wg.setSpeed(-5);
    wg.setSpeed(NaN);
    expect(wg.delaySamples).toBeCloseTo(24, 9);
    wg.setSpeed(1e6);
    expect(wg.delaySamples).toBe(MIN_DELAY_SAMPLES);
    wg.setSpeed(1);
    expect(wg.delaySamples).toBe(254);
  });

  it('outPair()/inputPair() are exact boxing-free equivalents of outRight()/outLeft()/input()', () => {
    const a = new Waveguide(256);
    const b = new Waveguide(256);
    a.configure(lenFor(23.6), C, FS, 5000);
    b.configure(lenFor(23.6), C, FS, 5000);
    const arr = new Float64Array(4);
    const inp = new Float64Array(4);
    for (let n = 0; n < 500; n++) {
      const ra = a.outRight();
      const la = a.outLeft();
      b.outPair(arr, 2);
      expect(arr[2]).toBe(ra);
      expect(arr[3]).toBe(la);
      const x = Math.sin(n * 0.21);
      const y = Math.cos(n * 0.13);
      a.input(x + 0.9 * la, y - 0.9 * ra);
      inp[2] = x + 0.9 * (arr[3] ?? 0);
      inp[3] = y - 0.9 * (arr[2] ?? 0);
      b.inputPair(inp, 2);
    }
    expect(b.energy()).toBe(a.energy());
  });

  it('energy() counts both rails; clear() and configure() zero the state (multi-call)', () => {
    const wg = new Waveguide(256);
    expect(wg.energy()).toBe(0);
    wg.configure(lenFor(20), C, FS, 0);
    wg.outRight();
    wg.outLeft();
    wg.input(0.5, -0.25);
    expect(wg.energy()).toBeCloseTo(0.25 + 0.0625, 12);
    wg.clear();
    expect(wg.energy()).toBe(0);
    wg.input(1, 1);
    wg.configure(lenFor(30), C, FS, 1000);
    expect(wg.energy()).toBe(0);
    expect(wg.outRight()).toBe(0);
    expect(wg.outLeft()).toBe(0);
  });
});
```

- [ ] **Step 10: Run the waveguide tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-waveguide.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/waveguide' imported from …/tests/unit/dsp-waveguide.test.ts`.

- [ ] **Step 11: Implement `src/dsp/waveguide.ts`**

Create `src/dsp/waveguide.ts`:

```ts
/**
 * Bidirectional digital waveguide tube section (Smith, "Physical Audio Signal Processing"):
 * a right-going rail (written at end A, read at end B) and a left-going rail (written at B, read
 * at A), each a FracDelay of delaySamples = lengthM / cMps · fs read with 3rd-order Lagrange
 * interpolation, preceded by a unity-DC one-pole low-pass (wall loss, |H| ≤ 1).
 */
import { SPEED_OF_SOUND_MAX } from '../contracts';
import { FracDelay } from './delay';
import { OnePole } from './util';

/** Lagrange-3 order + 1: the shortest allowed section, asserted at SPEED_OF_SOUND_MAX (amendment B3). */
export const MIN_DELAY_SAMPLES = 4;

export class Waveguide {
  private readonly right: FracDelay;
  private readonly left: FracDelay;
  private readonly lpR = new OnePole();
  private readonly lpL = new OnePole();
  private readonly maxDelay: number;
  private lengthM = 0;
  private fs = 0;
  private d = MIN_DELAY_SAMPLES;
  /** Read position: a sample written d samples ago is "the most recent" minus (d − 1). */
  private readD = MIN_DELAY_SAMPLES - 1;

  constructor(capacitySamples: number) {
    this.right = new FracDelay(capacitySamples);
    this.left = new FracDelay(capacitySamples);
    this.maxDelay = capacitySamples - 2;
  }

  get delaySamples(): number {
    return this.d;
  }

  /**
   * Sets length, speed, sample rate and wall loss, and clears the state. Throws RangeError for
   * non-positive/non-finite arguments, a section shorter than 4 samples at SPEED_OF_SOUND_MAX, or a
   * delay that does not fit the capacity (delaySamples must be ≤ capacity − 2).
   * lossHz ≤ 0 or ≥ fs/2 → lossless rails.
   */
  configure(lengthM: number, cMps: number, fs: number, lossHz: number): void {
    if (!(lengthM > 0) || !(cMps > 0) || !(fs > 0) || !Number.isFinite(lengthM * cMps * fs)) {
      throw new RangeError(`Waveguide.configure: bad arguments L=${lengthM} c=${cMps} fs=${fs}`);
    }
    const dAtMax = (lengthM / SPEED_OF_SOUND_MAX) * fs;
    if (dAtMax < MIN_DELAY_SAMPLES) {
      throw new RangeError(
        `Waveguide.configure: ${lengthM} m is ${dAtMax.toFixed(2)} samples at ${SPEED_OF_SOUND_MAX} m/s (< ${MIN_DELAY_SAMPLES})`,
      );
    }
    const d = (lengthM / cMps) * fs;
    if (d < MIN_DELAY_SAMPLES || d > this.maxDelay) {
      throw new RangeError(
        `Waveguide.configure: delay ${d.toFixed(2)} samples outside [${MIN_DELAY_SAMPLES}, ${this.maxDelay}]`,
      );
    }
    this.lengthM = lengthM;
    this.fs = fs;
    this.setDelay(d);
    if (lossHz > 0 && lossHz < fs / 2) {
      this.lpR.setCutoff(lossHz, fs);
      this.lpL.setCutoff(lossHz, fs);
    } else {
      this.lpR.setTau(0, fs);
      this.lpL.setTau(0, fs);
    }
    this.clear();
  }

  /** New speed of sound (caller slew-limits). The delay is clamped into [4, capacity − 2]; c ≤ 0/NaN is ignored. */
  setSpeed(cMps: number): void {
    if (!(cMps > 0)) return;
    let d = (this.lengthM / cMps) * this.fs;
    if (d < MIN_DELAY_SAMPLES) d = MIN_DELAY_SAMPLES;
    else if (d > this.maxDelay) d = this.maxDelay;
    this.setDelay(d);
  }

  /** Wave arriving at end B (right-going rail). Call before input() each sample. */
  outRight(): number {
    return this.right.readLagrangeFixed();
  }

  /** Wave arriving at end A (left-going rail). Call before input() each sample. */
  outLeft(): number {
    return this.left.readLagrangeFixed();
  }

  /** rightIn enters at end A, leftIn at end B (each through its rail's loss filter). */
  input(rightIn: number, leftIn: number): void {
    this.right.write(this.lpR.process(rightIn));
    this.left.write(this.lpL.process(leftIn));
  }

  /**
   * Boxing-free form of outRight()/outLeft() for hot loops (amendment B2):
   * dst[j] = wave arriving at B, dst[j + 1] = wave arriving at A.
   */
  outPair(dst: Float64Array, j: number): void {
    dst[j] = this.right.readLagrangeFixed();
    dst[j + 1] = this.left.readLagrangeFixed();
  }

  /** Boxing-free form of input(): rightIn = src[j] (enters at A), leftIn = src[j + 1] (enters at B). */
  inputPair(src: Float64Array, j: number): void {
    this.right.write(this.lpR.process(src[j]!));
    this.left.write(this.lpL.process(src[j + 1]!));
  }

  clear(): void {
    this.right.clear();
    this.left.clear();
    this.lpR.reset();
    this.lpL.reset();
  }

  /** A wave written now is read back (d − 1) samples after the next write, i.e. d samples later. */
  private setDelay(d: number): void {
    this.d = d;
    this.readD = d - 1;
    this.right.setLagrangeDelay(this.readD);
    this.left.setLagrangeDelay(this.readD);
  }

  /** Σ squares of both rails' live samples (every sample a future read can still touch). */
  energy(): number {
    const n = Math.floor(this.readD) + 3;
    return this.right.sumSquares(n) + this.left.sumSquares(n);
  }
}
```

- [ ] **Step 12: Run the waveguide tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-waveguide.test.ts
```

Expected: PASS — `Tests  9 passed (9)`.

- [ ] **Step 13: Run all Task 2 tests together**

Run:

```bash
npx vitest run tests/unit/dsp-delay.test.ts tests/unit/dsp-junction.test.ts tests/unit/dsp-waveguide.test.ts
```

Expected: PASS — `Test Files  3 passed (3)`, `Tests  24 passed (24)`.

- [ ] **Step 14: Lint and typecheck**

Run:

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no errors or warnings.

---

### Task 3: Exhaust network (passive waveguide topology, turbine 2-port, valve bypass)

**Files:**
- Create: `src/dsp/exhaust.ts`
- Test: `tests/unit/dsp-exhaust.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED): `type EngineDef`, `type Tier`, `MAX_COMBUSTION` (16), `MAX_SAMPLE_RATE` (48000), `SPEED_OF_SOUND_COLD` (343), `SPEED_OF_SOUND_MAX` (700).
  - Task 1 `src/dsp/util.ts`: `dbToGain(db)`; tests also use `class Slew` (`setRate(unitsPerS, fs)`, `process(target)`, `reset(v)`).
  - Task 1 `src/dsp/biquad.ts`: `new Biquad()`, `lowpass(f, Math.SQRT1_2, fs)` (never above 0 dB), `process(x)`, `reset()`.
  - Task 2 `src/dsp/waveguide.ts`: `new Waveguide(capacitySamples)`, `configure(lengthM, cMps, fs, lossHz)`, `setSpeed(cMps)`, `outPair(dst, j)`, `inputPair(src, j)`, `clear()`, `energy()`, `MIN_DELAY_SAMPLES`; tests also use `outRight()`, `outLeft()`, `input(r, l)`.
  - Task 2 `src/dsp/junction.ts`: `new Junction(maxPorts)`, `configure(admittances, n)`, `scatter(incoming, outgoing)`; tests also use `terminationReflect(x, r)`.
  - Task 1 fixtures `tests/fixtures/engines/<id>.json`.
- Produces (contract API exactly): `export class ExhaustNetwork { constructor(fs: number); configure(def: EngineDef, tier: Tier): void; setGasSpeeds(header: number, collector: number, muffler: number): void; setValve(open01: number): void; setTurbineAttenuation(x01: number): void; tick(headerIn: Float64Array, popIn: number): void; readonly outlet: number; readonly collectorTap: number; energy(): number; reset(): void }`. Behaviour later tasks (T9 DspCore, T10 tools) rely on:
  - **Construction.** `RangeError` for fs < 28 000 Hz or non-finite (amendment B3). Allocates the worst case once: 16 header sections, 8 collectors (each with its junction and two turbine biquads), 4 muffler chambers, mid-pipe and tailpipe; delay capacity = ⌈L_max / 343 m/s · max(fs, 48 000)⌉ + 4 with the contract max lengths (header 1.5, collector 1.0, mid 3.0, muffler section 0.8, tailpipe 1.2 m).
  - **`configure(def, tier)`.** Validates first and throws `RangeError` without touching the previous engine for: 0 or > 16 combustion entries, `headersM` shorter than `combustion` or non-positive, a bank outside 0…15, 0 or > 8 collectors, a non-positive collector/mid/tail/muffler length, or no muffler section. After that it never throws and never allocates. Topology: each bank belongs to the first collector that lists it (unlisted banks → collector 0); **Full** = one header per combustion entry; **Lite** = one header per bank (order of first appearance) with the bank's mean header length, fed the bank's summed pulses divided by its entry count (the merged header's admittance is the entry count, so the injected volume flow — and the level — matches Full), and at most 2 chambers. Each collector junction joins the headers of every bank the collector lists plus the collector tube. Lengths are clamped into [4.5 samples at 700 m/s, contract max]. Admittances: header 1 per entry, collector 0.5·(entries + 1), mid = tail = 0.6·Σ collectors (Y_mid = Y_tail makes the B7 bypass lossless), chamber Y_mid·(0.6 + 0.4·mufflerAction·(1 − valve)). Turbine (iff `aspiration.type === 'turbo'` and `voicing.turbine !== null`): per collector a lossless 2-port [[r, t], [t, −r]] (r = reflection clamped to ±0.95, t = √(1 − r²)) with a 2-pole Butterworth low-pass at `lpHz` × (1 − 0.5·attenuation) on the downstream port in both directions — diag(1, gG)·S·diag(1, gG), a contraction — joined to the merge junction through a 1-sample link each way. Rail wall-loss corners: header 9 kHz, collector 7 kHz, mid 6 kHz, chamber 4 kHz, tail 6 kHz. Leaves the network cold (343 m/s), valve 0, attenuation 0, state cleared.
  - **`setGasSpeeds(h, c, m)`** clamps each into [343, 700] m/s (NaN keeps the previous value): header → headers, collector → collectors, muffler → mid-pipe, chambers and tailpipe. Cheap no-op when unchanged; call once per quantum.
  - **`setValve(v)`** is ignored when `voicing.exhaust.valve.fitted` is false; otherwise v is clamped into [0, 1] (NaN → 0) and followed by an internal 20 ms linear anti-zipper slew on top of the caller's 150–300 ms slew. The smoothed value v sets the bypass a = 0.7·v (B7: S = (1 − a)·S_junction + a·S_bypass, mid↔tail straight-through, chambers absorbed; the tailpipe input is exactly lerp(mufflerJunctionOut, midPipeOut, a)), the chamber admittance, the outlet shelf (first-order at 2 kHz, gain 4·v − 6·mufflerAction·(1 − v) dB) and the outlet gain `dbToGain(openGainDb·v)` — the last two after the loop.
  - **`setTurbineAttenuation(x)`** clamps into [0, 1] (NaN → 0); no effect without a turbine.
  - **`tick(headerIn, popIn)`** reads `headerIn[0 … combustion.length − 1]` (missing → 0); `popIn / collectors` is added to each collector's downstream wave. Cylinder ends reflect +0.7, chamber far ends +0.9, the open end −0.85 through a 1.5 kHz one-pole; the exit wave is p⁺ − p⁻ (B10). Inert (outputs stay 0) before `configure`. No double crosses a method boundary in the hot loop except turbo `Biquad.process` and the valve update while slewing (B2).
  - **`outlet`** = openGain · shelf(HP₂₀(exit)), all outside every loop. **`collectorTap`** = mean junction pressure (p⁺ + p⁻) of the collector junctions.
  - **`energy()`** = Σ Y·`Waveguide.energy()` over all sections + Σ Y_collector·(link samples²), plus 0·(outlet filter states) so any non-finite state makes it NaN. O(stored samples): call once per quantum. Window maxima over 50 ms never rise for any fixture × tier × valve {0, 1} × speeds {343, hot}, and −120 dB is reached in ≤ 0.65 s (measured; the test allows 2 s).
  - **`reset()`** clears all wave and filter state, keeps topology, speeds, valve target (smoothing snapped to it) and attenuation; a replay after `reset()` is bit-identical.
  - Measured on the authoring VM (Node 24, no AVX): outlet peak ≈ 0.18–0.75 for unit raised-cosine pulses at 3000 rpm (hot); open valve +5 … +14 dB RMS over closed; ≈ 0.85 µs/sample for V8 Full (≈ 24× realtime for the exhaust alone), ≈ 0.52 µs for V8 Lite, no deopts, GC pauses < 1 ms.

**Cross-task premises:** (open each file and confirm before coding)
- **Task 2:** `Waveguide.outPair(dst, j)` writes the wave arriving at end B to `dst[j]` and at end A to `dst[j + 1]`; `inputPair(src, j)` equals `input(src[j], src[j + 1])`; `configure` throws only for bad arguments, < 4 samples at 700 m/s or a delay outside [4, capacity − 2]; `setSpeed` never throws; `MIN_DELAY_SAMPLES === 4`. `Junction.configure` copies the admittances and may be called every sample; `scatter` writes only `outgoing[0 … n−1]`.
- **Task 1:** `dbToGain`, `Slew` and `Biquad` as listed; `Biquad.lowpass(f, Math.SQRT1_2, fs)` has |H| ≤ 1 (Task 1 tests it).
- **Task 1 fixtures:** `valve.fitted` is true for i4, i5, v8-crossplane, v8-flatplane, v8-sc and false for i6, flat4-uel, rotary; `i6-test` is NA and its entry 0 is on bank 0, owned by `collectors[0]`; `i4-test` is turbo with one collector; `v8-crossplane-test` is NA and its entries 0 and 2 are both bank 0; every fixture has ≤ 4 muffler sections and lengths within the contract maxima.
- **Contract-only expectations of Task 9 (DspCore) — no code dependency:** it constructs `new ExhaustNetwork(sampleRate)`; calls `configure(def, tier)` only while faded out (never inside `render`'s per-sample loop — it validates and may throw); calls `setGasSpeeds` once per quantum with its τ = 3 s slewed targets (hot = 700/560/460 m/s), `setValve` with its 200 ms-slewed value (per sample or per quantum both work), `setTurbineAttenuation` from the forced-induction state, `tick(exhaustOut, overrun.popInject)` once per sample, reads `outlet` into the exhaust bus, calls `energy()` once per quantum for the NaN check and `reset()` on a non-finite reset. For invariant 7, `setValve(v)` followed by `reset()` gives a static valve state immediately.
- **Task 10's amendment-B1 lint rule:** `tick` contains no `new`, array/object literals, closures, spread, template literals, `try` or `throw`; the `outlet`/`collectorTap` getters are trivial.

- [ ] **Step 1: Write the failing exhaust tests (passivity, quarter-wave resonance, RF5)**

Create `tests/unit/dsp-exhaust.test.ts`. It covers construction/validation, impulse-decay passivity for every fixture × tier × valve {0, 1} × gas speeds {343, hot} (50 ms window maxima never rise, ≤ −120 dB within 2 s), a closed–open tube against c/4L and 3c/4L (and not c/2L), first-arrival timing through header + collector + mid-pipe + tailpipe, valve / open-gain / turbine / speed-clamp / Lite / pop / reset behaviour, and Review Focus RF5 (valve toggled 0↔1 every 20 ms for 2 s through a 200 ms and a 150 ms caller slew: energy ≤ 1.25 × the static-valve maxima, no sample-to-sample jump > 0.1 of full scale or > 1.25 × the static-valve jumps, and the network still decays when excitation stops while toggling continues):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef, Tier } from '../../src/contracts';
import { SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_MAX } from '../../src/contracts';
import { ExhaustNetwork } from '../../src/dsp/exhaust';
import { terminationReflect } from '../../src/dsp/junction';
import { Slew } from '../../src/dsp/util';
import { Waveguide } from '../../src/dsp/waveguide';

const FS = 48000;
const IDS = [
  'i4-test',
  'i5-test',
  'i6-test',
  'v8-crossplane-test',
  'v8-flatplane-test',
  'v8-sc-test',
  'flat4-uel-test',
  'rotary-test',
] as const;
const TIERS: Tier[] = ['full', 'lite'];
const HOT: [number, number, number] = [700, 560, 460];
const COLD: [number, number, number] = [SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD];

function load(id: string): EngineDef {
  return JSON.parse(readFileSync(new URL(`../fixtures/engines/${id}.json`, import.meta.url), 'utf8')) as EngineDef;
}

function network(id: string, tier: Tier, speeds: [number, number, number] = HOT, valve = 0): ExhaustNetwork {
  const ex = new ExhaustNetwork(FS);
  ex.configure(load(id), tier);
  ex.setGasSpeeds(...speeds);
  ex.setValve(valve);
  ex.reset(); // snaps the internal valve smoothing to the target
  return ex;
}

/** Raised-cosine blowdown pulses (amplitude 1, widthDeg) at each entry's angle + 140°, steady rpm. */
function pulseTrain(def: EngineDef, rpm: number): (n: number, out: Float64Array) => void {
  const cycle = def.spec.cycleDeg;
  const width = def.voicing.pulse.widthDeg;
  const degPerSample = (rpm * 6) / FS;
  const starts = def.spec.combustion.map((c) => c.angleDeg + 140);
  return (n, out) => {
    const theta = (n * degPerSample) % cycle;
    starts.forEach((s, i) => {
      const phi = ((((theta - s) % cycle) + cycle) % cycle) / width;
      out[i] = phi < 1 ? 0.5 * (1 - Math.cos(2 * Math.PI * phi)) : 0;
    });
  };
}

interface Trace {
  out: Float64Array;
  energyMax: number;
  maxJump: number;
  finite: boolean;
}

/** Runs a pulse train for n samples; valveAt(n) is called every sample (the caller's slewed valve). */
function drive(ex: ExhaustNetwork, def: EngineDef, n: number, valveAt: (i: number) => number, rpm = 3000): Trace {
  const gen = pulseTrain(def, rpm);
  const hin = new Float64Array(16);
  const out = new Float64Array(n);
  let energyMax = 0;
  let maxJump = 0;
  let finite = true;
  for (let i = 0; i < n; i++) {
    ex.setValve(valveAt(i));
    gen(i, hin);
    ex.tick(hin, 0);
    const y = ex.outlet;
    out[i] = y;
    if (!Number.isFinite(y)) finite = false;
    if (i > 0) maxJump = Math.max(maxJump, Math.abs(y - (out[i - 1] ?? 0)));
    if (i % 48 === 47) {
      const e = ex.energy();
      if (!Number.isFinite(e)) finite = false;
      energyMax = Math.max(energyMax, e);
    }
  }
  return { out, energyMax, maxJump, finite };
}

function rms(x: Float64Array, from: number): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / (x.length - from));
}

/** |DFT| of x at f (Hz), Goertzel recurrence. */
function magAt(x: Float64Array, f: number): number {
  const w = (2 * Math.PI * f) / FS;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < x.length; n++) {
    const s0 = (x[n] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2));
}

describe('ExhaustNetwork: construction and configuration', () => {
  it('rejects sample rates below 28 kHz and accepts common rates', () => {
    expect(() => new ExhaustNetwork(22050)).toThrow(RangeError);
    expect(() => new ExhaustNetwork(NaN)).toThrow(RangeError);
    for (const fs of [44100, 48000, 96000]) {
      const ex = new ExhaustNetwork(fs);
      ex.configure(load('v8-crossplane-test'), 'full');
      ex.setGasSpeeds(SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD); // longest delays fit
      ex.tick(new Float64Array(16).fill(1), 0);
      expect(Number.isFinite(ex.energy())).toBe(true);
    }
  });

  it('is inert before configure()', () => {
    const ex = new ExhaustNetwork(FS);
    ex.setGasSpeeds(...HOT);
    ex.setValve(1);
    ex.tick(new Float64Array(16).fill(1), 1);
    expect(ex.outlet).toBe(0);
    expect(ex.collectorTap).toBe(0);
    expect(ex.energy()).toBe(0);
  });

  it.each(IDS)('%s configures for both tiers and produces finite sound', (id) => {
    for (const tier of TIERS) {
      const ex = network(id, tier);
      const t = drive(ex, load(id), 4800, () => 0);
      expect(t.finite).toBe(true);
      expect(rms(t.out, 2400)).toBeGreaterThan(1e-3);
    }
  });

  it('rejects unrepresentable definitions with RangeError and keeps the previous engine', () => {
    const good = load('i4-test');
    const ex = new ExhaustNetwork(FS);
    ex.configure(good, 'full');
    const bad: EngineDef[] = [];
    const shortHeaders = load('i4-test');
    shortHeaders.voicing.headersM = [0.6, 0.6];
    bad.push(shortHeaders);
    const noMuffler = load('i4-test');
    noMuffler.voicing.exhaust.mufflerSectionsM = [];
    bad.push(noMuffler);
    const badBank = load('i4-test');
    badBank.spec.combustion[1] = { angleDeg: 540, bank: -1 };
    bad.push(badBank);
    const noCollector = load('i4-test');
    noCollector.voicing.collectors = [];
    bad.push(noCollector);
    for (const def of bad) expect(() => ex.configure(def, 'full')).toThrow(RangeError);
    // still the i4 network: bit-identical to a fresh one
    const ref = new ExhaustNetwork(FS);
    ref.configure(good, 'full');
    const a = drive(ex, good, 2000, () => 0);
    const b = drive(ref, good, 2000, () => 0);
    expect(Array.from(a.out)).toEqual(Array.from(b.out));
  });
});

describe('ExhaustNetwork: passivity (impulse decay)', () => {
  it.each(IDS)('%s: every tier × valve {0,1} × speeds {cold, hot} decays monotonically to −120 dB within 2 s', (id) => {
    for (const tier of TIERS) {
      for (const valve of [0, 1]) {
        for (const speeds of [COLD, HOT]) {
          const ex = network(id, tier, speeds, valve);
          const hin = new Float64Array(16);
          const windowMax: number[] = [];
          let current = 0;
          let reached = false;
          for (let n = 0; n < 2 * FS && !reached; n++) {
            hin.fill(n === 0 ? 1 : 0);
            ex.tick(hin, 0);
            if (n % 48 !== 47) continue; // energy every 1 ms …
            const e = ex.energy();
            expect(Number.isFinite(e)).toBe(true);
            current = Math.max(current, e);
            if ((n + 1) % 2400 === 0) {
              // … windowed per 50 ms
              windowMax.push(current);
              const e0 = windowMax[0] ?? 0;
              if (e <= 1e-12 * e0) reached = true;
              current = 0;
            }
          }
          const label = `${id} ${tier} valve=${valve} c=${speeds[0]}`;
          expect(reached, label).toBe(true);
          for (let w = 1; w < windowMax.length; w++) {
            expect(windowMax[w], label).toBeLessThanOrEqual((windowMax[w - 1] ?? 0) * (1 + 1e-9));
          }
        }
      }
    }
  });
});

describe('ExhaustNetwork: acoustics', () => {
  it('a single closed–open tube resonates at the quarter-wave frequencies c/4L, 3c/4L (not c/2L)', () => {
    for (const [L, c] of [
      [0.5, 343],
      [0.3, 700],
    ] as const) {
      const wg = new Waveguide(512);
      wg.configure(L, c, FS, 0);
      const y = new Float64Array(FS / 2);
      for (let n = 0; n < y.length; n++) {
        const atOpen = wg.outRight();
        const atClosed = wg.outLeft();
        const refl = terminationReflect(atOpen, -0.95);
        y[n] = atOpen - refl;
        wg.input((n === 0 ? 1 : 0) + terminationReflect(atClosed, 0.95), refl);
      }
      const f1 = c / (4 * L);
      const peakIn = (lo: number, hi: number) => {
        let best = 0;
        let bestF = 0;
        for (let f = lo; f <= hi; f += 0.1) {
          const m = magAt(y, f);
          if (m > best) {
            best = m;
            bestF = f;
          }
        }
        return { f: bestF, m: best };
      };
      const p1 = peakIn(0.8 * f1, 1.2 * f1);
      const p3 = peakIn(2.8 * f1, 3.2 * f1);
      expect(Math.abs(p1.f / f1 - 1)).toBeLessThan(0.005);
      expect(Math.abs(p3.f / (3 * f1) - 1)).toBeLessThan(0.005);
      expect(20 * Math.log10(magAt(y, 2 * f1) / p1.m)).toBeLessThan(-20);
    }
  });

  it('the first arrival at the outlet takes header + collector + mid-pipe + tailpipe travel time', () => {
    const def = load('i6-test'); // NA: no turbine link sample
    for (const [speeds, ch, cc, cm] of [
      [COLD, 343, 343, 343],
      [HOT, 700, 560, 460],
    ] as const) {
      const ex = network('i6-test', 'full', speeds);
      const hin = new Float64Array(16);
      const out: number[] = [];
      const tap: number[] = [];
      for (let n = 0; n < 1500; n++) {
        hin[0] = n === 0 ? 1 : 0;
        ex.tick(hin, 0);
        out.push(ex.outlet);
        tap.push(ex.collectorTap);
      }
      const v = def.voicing;
      const dHeader = ((v.headersM[0] ?? 0) / ch) * FS;
      const total =
        dHeader +
        ((v.collectors[0]?.lengthM ?? 0) / cc) * FS +
        (v.exhaust.midPipeM / cm) * FS +
        (v.exhaust.tailpipeM / cm) * FS;
      const peak = Math.max(...out.map(Math.abs));
      const first = out.findIndex((x) => Math.abs(x) > 1e-6 * peak);
      expect(Math.abs(first - total)).toBeLessThanOrEqual(6);
      let peakIdx = first;
      for (let i = first; i < first + 40; i++) if (Math.abs(out[i] ?? 0) > Math.abs(out[peakIdx] ?? 0)) peakIdx = i;
      expect(peakIdx - total).toBeGreaterThanOrEqual(-2);
      expect(peakIdx - total).toBeLessThanOrEqual(8);
      const firstTap = tap.findIndex((x) => Math.abs(x) > 1e-9);
      expect(Math.abs(firstTap - dHeader)).toBeLessThanOrEqual(3);
    }
  });

  it('opening a fitted valve makes the outlet louder, openGainDb acts outside the loop, an unfitted valve is ignored', () => {
    const v8 = load('v8-crossplane-test');
    const closed = drive(network('v8-crossplane-test', 'full', HOT, 0), v8, FS, () => 0);
    const open = drive(network('v8-crossplane-test', 'full', HOT, 1), v8, FS, () => 1);
    expect(20 * Math.log10(rms(open.out, FS / 2) / rms(closed.out, FS / 2))).toBeGreaterThan(3);
    // +6 dB more open gain scales the open-valve outlet exactly (an outlet-tap gain, never in a loop)
    const louder = load('v8-crossplane-test');
    louder.voicing.exhaust.valve.openGainDb += 6;
    const ex = new ExhaustNetwork(FS);
    ex.configure(louder, 'full');
    ex.setGasSpeeds(...HOT);
    ex.setValve(1);
    ex.reset();
    const boosted = drive(ex, louder, 4800, () => 1);
    const g = Math.pow(10, 6 / 20);
    for (let i = 0; i < 4800; i++) expect(boosted.out[i]).toBeCloseTo((open.out[i] ?? 0) * g, 12);
    const i6 = load('i6-test'); // valve.fitted = false
    const a = drive(network('i6-test', 'full', HOT, 0), i6, 4800, () => 0);
    const b = drive(network('i6-test', 'full', HOT, 1), i6, 4800, () => 1);
    expect(Array.from(b.out)).toEqual(Array.from(a.out));
  });

  it('turbine attenuation lowers a turbo engine and leaves an NA engine untouched', () => {
    const i4 = load('i4-test');
    const free = network('i4-test', 'full');
    const choked = network('i4-test', 'full');
    choked.setTurbineAttenuation(1);
    const a = drive(free, i4, FS / 2, () => 0);
    const b = drive(choked, i4, FS / 2, () => 0);
    expect(rms(b.out, FS / 4)).toBeLessThan(rms(a.out, FS / 4) * 0.9);
    const v8 = load('v8-crossplane-test');
    const na = network('v8-crossplane-test', 'full');
    na.setTurbineAttenuation(1);
    const c = drive(na, v8, 4800, () => 0);
    const d = drive(network('v8-crossplane-test', 'full'), v8, 4800, () => 0);
    expect(Array.from(c.out)).toEqual(Array.from(d.out));
  });

  it('gas speeds are clamped to [343, 700] m/s and NaN keeps the previous speeds', () => {
    const def = load('v8-flatplane-test');
    const ref = network('v8-flatplane-test', 'full', HOT);
    const clamped = network('v8-flatplane-test', 'full', [5000, 560, 460]);
    expect(Array.from(drive(clamped, def, 3000, () => 0).out)).toEqual(Array.from(drive(ref, def, 3000, () => 0).out));
    const low = network('v8-flatplane-test', 'full', [1, 1, 1]);
    const cold = network('v8-flatplane-test', 'full', COLD);
    expect(Array.from(drive(low, def, 3000, () => 0).out)).toEqual(Array.from(drive(cold, def, 3000, () => 0).out));
    const nan = network('v8-flatplane-test', 'full', HOT);
    nan.setGasSpeeds(NaN, NaN, NaN);
    const ref2 = network('v8-flatplane-test', 'full', HOT);
    expect(Array.from(drive(nan, def, 3000, () => 0).out)).toEqual(Array.from(drive(ref2, def, 3000, () => 0).out));
    expect(SPEED_OF_SOUND_MAX).toBe(700);
  });

  it('Lite sums the pulses of a bank (summing inputs is equivalent to one input carrying the sum)', () => {
    const a = network('v8-crossplane-test', 'lite');
    const b = network('v8-crossplane-test', 'lite');
    const hinA = new Float64Array(16);
    const hinB = new Float64Array(16);
    for (let n = 0; n < 3000; n++) {
      const x = n < 100 ? Math.sin(n * 0.05) : 0;
      hinA[0] = 0.5 * x; // entries 0 and 2 are both bank 0
      hinA[2] = 0.5 * x;
      hinB[0] = x;
      a.tick(hinA, 0);
      b.tick(hinB, 0);
      expect(a.outlet).toBe(b.outlet);
    }
  });

  it('pops injected at the collectors ring through the network; collectorTap follows the junctions', () => {
    const ex = network('i4-test', 'full');
    const hin = new Float64Array(16);
    let peak = 0;
    for (let n = 0; n < 4800; n++) {
      ex.tick(hin, n === 0 ? 1 : 0);
      peak = Math.max(peak, Math.abs(ex.outlet));
    }
    expect(peak).toBeGreaterThan(1e-3);
    expect(Number.isFinite(ex.energy())).toBe(true);
    const tapNet = network('i4-test', 'full');
    hin[0] = 1;
    tapNet.tick(hin, 0);
    expect(tapNet.collectorTap).toBe(0); // the pulse has not reached the junction yet
  });

  it('reset() clears every state so a replay is bit-identical (deterministic)', () => {
    const def = load('rotary-test');
    const ex = network('rotary-test', 'full');
    const first = drive(ex, def, 6000, () => 0);
    ex.reset();
    expect(ex.energy()).toBe(0);
    expect(ex.outlet).toBe(0);
    const second = drive(ex, def, 6000, () => 0);
    expect(Array.from(second.out)).toEqual(Array.from(first.out));
  });
});

describe('ExhaustNetwork: RF5 valve toggling', () => {
  it.each([
    ['v8-crossplane-test', 'full', 0.2],
    ['v8-crossplane-test', 'full', 0.15],
    ['i4-test', 'lite', 0.2],
  ] as const)(
    '%s %s: valve toggled 0↔1 every 20 ms for 2 s through a %s s caller slew stays bounded and click-free',
    (id, tier, slewS) => {
      const def = load(id);
      const n = 2 * FS;
      const static0 = drive(network(id, tier, HOT, 0), def, n, () => 0);
      const static1 = drive(network(id, tier, HOT, 1), def, n, () => 1);
      const slew = new Slew();
      slew.setRate(1 / slewS, FS);
      slew.reset(0);
      const ex = network(id, tier, HOT, 0);
      const toggled = drive(ex, def, n, (i) => slew.process(Math.floor(i / 960) % 2 === 0 ? 1 : 0));
      expect(toggled.finite).toBe(true);
      const energyRef = Math.max(static0.energyMax, static1.energyMax);
      expect(toggled.energyMax).toBeLessThanOrEqual(1.25 * energyRef);
      const jumpRef = Math.max(static0.maxJump, static1.maxJump);
      expect(toggled.maxJump).toBeLessThanOrEqual(0.1); // full scale = 1.0
      expect(toggled.maxJump).toBeLessThanOrEqual(1.25 * jumpRef);
      // keep toggling without excitation: the network still decays (bounded, no self-oscillation)
      const hin = new Float64Array(16);
      let last = 0;
      for (let i = 0; i < FS; i++) {
        ex.setValve(slew.process(Math.floor((n + i) / 960) % 2 === 0 ? 1 : 0));
        ex.tick(hin, 0);
        last = ex.energy();
      }
      expect(last).toBeLessThan(1e-6 * energyRef);
    },
  );

  it('the internal anti-zipper smoothing keeps even an unslewed 0↔1 toggle click-free', () => {
    const def = load('v8-crossplane-test');
    const static1 = drive(network('v8-crossplane-test', 'full', HOT, 1), def, FS, () => 1);
    const raw = drive(network('v8-crossplane-test', 'full', HOT, 0), def, FS, (i) => (Math.floor(i / 960) % 2 === 0 ? 1 : 0));
    expect(raw.finite).toBe(true);
    expect(raw.maxJump).toBeLessThanOrEqual(0.1);
    expect(raw.maxJump).toBeLessThanOrEqual(1.25 * static1.maxJump);
  });
});
```

- [ ] **Step 2: Run the exhaust tests and watch them fail**

Run:

```bash
npx vitest run tests/unit/dsp-exhaust.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/dsp/exhaust' imported from …/tests/unit/dsp-exhaust.test.ts`.

- [ ] **Step 3: Implement `src/dsp/exhaust.ts`**

Create `src/dsp/exhaust.ts`:

```ts
/**
 * Exhaust network, passive by construction (spec §5.3.4; Phase 2a contract topology + amendments
 * B3, B7, B10). Digital waveguides (Smith, "Physical Audio Signal Processing") joined by lossless
 * N-port parallel junctions:
 *
 *   cylinder (r = +0.7) → header → collector junction (that collector's headers + collector tube)
 *   → collector → [turbo: turbine 2-port → 1-sample link] → merge junction (collectors + mid-pipe)
 *   → mid-pipe → muffler junction (mid-pipe, tailpipe, N side-branch chambers closed at r = +0.9;
 *     valve bypass blends in a lossless mid↔tail straight-through) → tailpipe → open end
 *     (r = −0.85 through a 1.5 kHz one-pole; exit wave p⁺ − p⁻)
 *   → outlet, outside every loop: 20 Hz first-order HP → 2 kHz first-order shelf → open gain.
 *
 * Energy bookkeeping uses admittance-weighted rail energy: every junction conserves it; terminations,
 * rail filters, interpolators, the turbine 2-port and the valve bypass can only lose it.
 */
import type { EngineDef, Tier } from '../contracts';
import { MAX_COMBUSTION, MAX_SAMPLE_RATE, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_MAX } from '../contracts';
import { Biquad } from './biquad';
import { Junction } from './junction';
import { dbToGain } from './util';
import { MIN_DELAY_SAMPLES, Waveguide } from './waveguide';

const MIN_EXHAUST_FS = 28000;
const MAX_COLLECTORS = 8;
const MAX_MUFFLER_CHAMBERS = 4;
const LITE_MUFFLER_CHAMBERS = 2;
/** Contract max lengths (m); longer voicing values are clamped. */
const EXHAUST_MAX_LENGTH_M = {
  header: 1.5,
  collector: 1.0,
  midPipe: 3.0,
  mufflerSection: 0.8,
  tailpipe: 1.2,
} as const;
const HEADER_END_REFLECTION = 0.7;
const CHAMBER_END_REFLECTION = 0.9;
const OPEN_END_REFLECTION = -0.85;
const OPEN_END_LP_HZ = 1500;
/** Bypass weight a = BYPASS_MAX · valve (amendment B7). */
const BYPASS_MAX = 0.7;
const OUTLET_HP_HZ = 20;
const OUTLET_SHELF_HZ = 2000;
/** Outlet shelf gain in dB = VALVE_BRIGHTEN_DB·v − CLOSED_SHELF_CUT_DB·mufflerAction·(1 − v). */
const VALVE_BRIGHTEN_DB = 4;
const CLOSED_SHELF_CUT_DB = 6;
/** Internal anti-zipper slew on the valve value (full range in 20 ms) on top of the caller's slew. */
const VALVE_SMOOTH_S = 0.02;

/** Rail wall-loss corners (Hz) per section group. */
const LOSS_HZ = { header: 9000, collector: 7000, midPipe: 6000, chamber: 4000, tailpipe: 6000 } as const;
/** Header (and Lite unit) admittance per merged header; collector = 0.5·(headers + 1); mid = tail = 0.6·Σ collectors. */
const COLLECTOR_Y_PER_HEADER = 0.5;
const PIPE_Y_FRACTION = 0.6;
/** Side-branch admittance = Y_mid·(CHAMBER_Y_BASE + CHAMBER_Y_ACTION·mufflerAction·(1 − valve)). */
const CHAMBER_Y_BASE = 0.6;
const CHAMBER_Y_ACTION = 0.4;

function invalid(msg: string): never {
  throw new RangeError(`ExhaustNetwork.configure: ${msg}`);
}

function positive(x: unknown): boolean {
  return typeof x === 'number' && x > 0 && x < Infinity;
}

/** Throws RangeError for definitions the network cannot represent. Checks everything before any state changes. */
function validate(def: EngineDef): void {
  const comb = def.spec.combustion;
  const v = def.voicing;
  if (comb.length < 1 || comb.length > MAX_COMBUSTION) invalid(`${comb.length} combustion entries (1…${MAX_COMBUSTION})`);
  if (v.headersM.length < comb.length) invalid(`headersM has ${v.headersM.length} entries for ${comb.length} combustion entries`);
  for (let i = 0; i < comb.length; i++) {
    const b = comb[i]?.bank;
    if (b === undefined || !Number.isInteger(b) || b < 0 || b >= MAX_COMBUSTION) invalid(`entry ${i} bank ${b}`);
    if (!positive(v.headersM[i])) invalid(`headersM[${i}] = ${v.headersM[i]}`);
  }
  if (v.collectors.length < 1 || v.collectors.length > MAX_COLLECTORS) invalid(`${v.collectors.length} collectors (1…${MAX_COLLECTORS})`);
  for (let c = 0; c < v.collectors.length; c++) {
    if (!positive(v.collectors[c]?.lengthM)) invalid(`collectors[${c}].lengthM`);
  }
  const m = v.exhaust.mufflerSectionsM;
  if (m.length < 1) invalid('no muffler section');
  for (let k = 0; k < m.length && k < MAX_MUFFLER_CHAMBERS; k++) if (!positive(m[k])) invalid(`mufflerSectionsM[${k}]`);
  if (!positive(v.exhaust.midPipeM)) invalid('midPipeM');
  if (!positive(v.exhaust.tailpipeM)) invalid('tailpipeM');
}

export class ExhaustNetwork {
  private readonly fs: number;
  private readonly minLen: number;

  // ── sections (capacity-sized at SPEED_OF_SOUND_COLD and max(fs, MAX_SAMPLE_RATE), amendment B3) ──
  private readonly headers: Waveguide[] = [];
  private readonly colls: Waveguide[] = [];
  private readonly chambers: Waveguide[] = [];
  private readonly mid: Waveguide;
  private readonly tail: Waveguide;
  private readonly collJ: Junction[] = [];
  private readonly merge: Junction;
  private readonly muff: Junction;
  private readonly turbDown: Biquad[] = [];
  private readonly turbUp: Biquad[] = [];

  // ── topology (Int32Array/Float64Array, filled by configure) ──
  private readonly entryUnit = new Int32Array(MAX_COMBUSTION);
  private readonly unitBank = new Int32Array(MAX_COMBUSTION);
  private readonly unitCount = new Int32Array(MAX_COMBUSTION);
  private readonly unitColl = new Int32Array(MAX_COMBUSTION);
  private readonly unitLen = new Float64Array(MAX_COMBUSTION);
  private readonly unitY = new Float64Array(MAX_COMBUSTION);
  /** 1 / entries per unit: a Lite unit (admittance = entry count) gets the bank's mean pulse, i.e. the same volume flow as Full. */
  private readonly unitInv = new Float64Array(MAX_COMBUSTION);
  private readonly bankUnit = new Int32Array(MAX_COMBUSTION);
  private readonly bankColl = new Int32Array(MAX_COMBUSTION);
  private readonly collUnits = new Int32Array(MAX_COMBUSTION);
  private readonly collStart = new Int32Array(MAX_COLLECTORS);
  private readonly collCount = new Int32Array(MAX_COLLECTORS);
  private readonly collFill = new Int32Array(MAX_COLLECTORS);
  private readonly collY = new Float64Array(MAX_COLLECTORS);
  private readonly jAdm = new Float64Array(MAX_COMBUSTION + 1);
  private readonly mergeAdm = new Float64Array(MAX_COLLECTORS + 1);
  private readonly muffAdm = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);

  // ── per-sample scratch: arrivals (…A) and inputs (…I) as [right, left] pairs per section ──
  private readonly unitIn = new Float64Array(MAX_COMBUSTION);
  private readonly hA = new Float64Array(2 * MAX_COMBUSTION);
  private readonly hI = new Float64Array(2 * MAX_COMBUSTION);
  private readonly cA = new Float64Array(2 * MAX_COLLECTORS);
  private readonly cI = new Float64Array(2 * MAX_COLLECTORS);
  private readonly kA = new Float64Array(2 * MAX_MUFFLER_CHAMBERS);
  private readonly kI = new Float64Array(2 * MAX_MUFFLER_CHAMBERS);
  /** mid-pipe at [0, 1], tailpipe at [2, 3]. */
  private readonly pA = new Float64Array(4);
  private readonly pI = new Float64Array(4);
  private readonly linkDown = new Float64Array(MAX_COLLECTORS);
  private readonly linkUp = new Float64Array(MAX_COLLECTORS);
  private readonly newDown = new Float64Array(MAX_COLLECTORS);
  private readonly jin = new Float64Array(MAX_COMBUSTION + 1);
  private readonly jout = new Float64Array(MAX_COMBUSTION + 1);
  private readonly mergeIn = new Float64Array(MAX_COLLECTORS + 1);
  private readonly mergeOut = new Float64Array(MAX_COLLECTORS + 1);
  private readonly muffIn = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);
  private readonly muffOut = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);

  // ── parameters ──
  private configured = false;
  private nEntries = 0;
  private nUnits = 0;
  private nColl = 0;
  private nCh = 0;
  private turbo = false;
  private turbR = 0;
  private turbT = 1;
  private turbGain = 1;
  private yMid = 1;
  private yCh = 1;
  private valveFitted = false;
  private openGainDb = 0;
  private mufflerAction = 0;
  private valveTarget = 0;
  private vSmooth = 0;
  private readonly valveStep: number;
  private bypass = 0;
  private shelfGain = 1;
  private outGain = 1;
  private cH = SPEED_OF_SOUND_COLD;
  private cC = SPEED_OF_SOUND_COLD;
  private cM = SPEED_OF_SOUND_COLD;
  private outletV = 0;
  private tapV = 0;
  // one-pole coefficients/states kept inline in tick (no double crosses a call boundary, amendment B2)
  private readonly openK: number;
  private readonly openA: number;
  private openY = 0;
  private readonly hpK: number;
  private readonly hpA: number;
  private hpY = 0;
  private readonly shK: number;
  private readonly shA: number;
  private shY = 0;

  constructor(fs: number) {
    if (!(fs >= MIN_EXHAUST_FS) || !Number.isFinite(fs)) {
      throw new RangeError(`ExhaustNetwork needs fs ≥ ${MIN_EXHAUST_FS} Hz, got ${fs}`);
    }
    this.fs = fs;
    this.minLen = ((MIN_DELAY_SAMPLES + 0.5) * SPEED_OF_SOUND_MAX) / fs;
    const fsCap = Math.max(fs, MAX_SAMPLE_RATE);
    const cap = (lengthM: number): number => Math.ceil((lengthM / SPEED_OF_SOUND_COLD) * fsCap) + 4;
    for (let i = 0; i < MAX_COMBUSTION; i++) this.headers.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.header)));
    for (let c = 0; c < MAX_COLLECTORS; c++) {
      this.colls.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.collector)));
      this.collJ.push(new Junction(MAX_COMBUSTION + 1));
      this.turbDown.push(new Biquad());
      this.turbUp.push(new Biquad());
    }
    for (let k = 0; k < MAX_MUFFLER_CHAMBERS; k++) {
      this.chambers.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.mufflerSection)));
    }
    this.mid = new Waveguide(cap(EXHAUST_MAX_LENGTH_M.midPipe));
    this.tail = new Waveguide(cap(EXHAUST_MAX_LENGTH_M.tailpipe));
    this.merge = new Junction(MAX_COLLECTORS + 1);
    this.muff = new Junction(2 + MAX_MUFFLER_CHAMBERS);
    this.openK = onePoleK(OPEN_END_LP_HZ, fs);
    this.openA = 1 - this.openK;
    this.hpK = onePoleK(OUTLET_HP_HZ, fs);
    this.hpA = 1 - this.hpK;
    this.shK = onePoleK(OUTLET_SHELF_HZ, fs);
    this.shA = 1 - this.shK;
    this.valveStep = 1 / (VALVE_SMOOTH_S * fs);
  }

  /** Radiated pressure: exit wave → 20 Hz HP → shelf → open gain (all after the loop). */
  get outlet(): number {
    return this.outletV;
  }

  /** Mean junction pressure (p⁺ + p⁻) of the header→collector junctions. */
  get collectorTap(): number {
    return this.tapV;
  }

  /**
   * Builds the topology for `def` (Full: one header per combustion entry, up to 4 chambers; Lite: one
   * header per bank fed by the bank's summed pulses with the bank's mean header length, ≤ 2 chambers).
   * Throws RangeError (leaving the previous engine intact) for unrepresentable definitions; otherwise
   * never allocates. Leaves the network cold (343 m/s), valve closed, turbine attenuation 0, state cleared.
   */
  configure(def: EngineDef, tier: Tier): void {
    validate(def);
    const spec = def.spec;
    const v = def.voicing;
    const fs = this.fs;
    const n = spec.combustion.length;
    const lite = tier === 'lite';
    const nColl = v.collectors.length;

    // bank → first collector that lists it (unlisted banks join collector 0)
    this.bankColl.fill(-1);
    for (let c = 0; c < nColl; c++) {
      const col = v.collectors[c];
      if (col === undefined) continue;
      const banks = col.banks;
      for (let j = 0; j < banks.length; j++) {
        const b = banks[j] ?? -1;
        if (Number.isInteger(b) && b >= 0 && b < MAX_COMBUSTION && this.bankColl[b] === -1) this.bankColl[b] = c;
      }
    }

    // header units: Full = one per entry, Lite = one per bank (order of first appearance)
    let nUnits = 0;
    this.bankUnit.fill(-1);
    for (let i = 0; i < n; i++) {
      const b = spec.combustion[i]?.bank ?? 0;
      let u = i;
      if (lite) {
        u = this.bankUnit[b] ?? -1;
        if (u < 0) {
          u = nUnits;
          this.bankUnit[b] = u;
        }
      }
      if (u === nUnits) {
        nUnits++;
        this.unitBank[u] = b;
        this.unitCount[u] = 0;
        this.unitLen[u] = 0;
      }
      this.entryUnit[i] = u;
      this.unitCount[u] = (this.unitCount[u] ?? 0) + 1;
      this.unitLen[u] = (this.unitLen[u] ?? 0) + (v.headersM[i] ?? 0);
    }

    // group units by collector
    for (let c = 0; c < nColl; c++) {
      this.collCount[c] = 0;
      this.collY[c] = COLLECTOR_Y_PER_HEADER;
    }
    for (let u = 0; u < nUnits; u++) {
      const c = Math.max(this.bankColl[this.unitBank[u] ?? 0] ?? 0, 0);
      this.unitColl[u] = c;
      this.collCount[c] = (this.collCount[c] ?? 0) + 1;
      this.collY[c] = (this.collY[c] ?? 0) + COLLECTOR_Y_PER_HEADER * (this.unitCount[u] ?? 0);
      this.unitY[u] = this.unitCount[u] ?? 1;
      this.unitInv[u] = 1 / (this.unitCount[u] ?? 1);
    }
    let start = 0;
    for (let c = 0; c < nColl; c++) {
      this.collStart[c] = start;
      this.collFill[c] = start;
      start += this.collCount[c] ?? 0;
    }
    for (let u = 0; u < nUnits; u++) {
      const c = this.unitColl[u] ?? 0;
      const slot = this.collFill[c] ?? 0;
      this.collUnits[slot] = u;
      this.collFill[c] = slot + 1;
    }

    // waveguides, cold
    for (let u = 0; u < nUnits; u++) {
      const len = (this.unitLen[u] ?? 0) / (this.unitCount[u] ?? 1);
      this.headers[u]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.header), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.header);
    }
    let sumCollY = 0;
    for (let c = 0; c < nColl; c++) {
      const len = v.collectors[c]?.lengthM ?? 0;
      this.colls[c]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.collector), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.collector);
      sumCollY += this.collY[c] ?? 0;
    }
    this.mid.configure(this.len(v.exhaust.midPipeM, EXHAUST_MAX_LENGTH_M.midPipe), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.midPipe);
    this.tail.configure(this.len(v.exhaust.tailpipeM, EXHAUST_MAX_LENGTH_M.tailpipe), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.tailpipe);
    const nCh = Math.min(v.exhaust.mufflerSectionsM.length, lite ? LITE_MUFFLER_CHAMBERS : MAX_MUFFLER_CHAMBERS);
    for (let k = 0; k < nCh; k++) {
      const len = v.exhaust.mufflerSectionsM[k] ?? 0;
      this.chambers[k]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.mufflerSection), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.chamber);
    }

    // junction admittances
    for (let c = 0; c < nColl; c++) {
      const s = this.collStart[c] ?? 0;
      const cnt = this.collCount[c] ?? 0;
      for (let j = 0; j < cnt; j++) this.jAdm[j] = this.unitY[this.collUnits[s + j] ?? 0] ?? 1;
      this.jAdm[cnt] = this.collY[c] ?? 1;
      this.collJ[c]!.configure(this.jAdm, cnt + 1);
      this.mergeAdm[c] = this.collY[c] ?? 1;
    }
    this.yMid = PIPE_Y_FRACTION * sumCollY;
    this.mergeAdm[nColl] = this.yMid;
    this.merge.configure(this.mergeAdm, nColl + 1);

    // turbine 2-port (turbo engines with turbine voicing only)
    const tb = v.turbine;
    this.turbo = spec.aspiration.type === 'turbo' && tb !== null;
    if (tb !== null && this.turbo) {
      const r = tb.reflection;
      this.turbR = r > 0 ? (r < 0.95 ? r : 0.95) : r < 0 ? (r > -0.95 ? r : -0.95) : 0;
      this.turbT = Math.sqrt(1 - this.turbR * this.turbR);
      for (let c = 0; c < nColl; c++) {
        this.turbDown[c]!.lowpass(tb.lpHz, Math.SQRT1_2, fs);
        this.turbUp[c]!.lowpass(tb.lpHz, Math.SQRT1_2, fs);
      }
    } else {
      this.turbR = 0;
      this.turbT = 1;
    }

    this.nEntries = n;
    this.nUnits = nUnits;
    this.nColl = nColl;
    this.nCh = nCh;
    this.valveFitted = v.exhaust.valve.fitted;
    this.openGainDb = Number.isFinite(v.exhaust.valve.openGainDb) ? v.exhaust.valve.openGainDb : 0;
    const ma = v.exhaust.mufflerAction;
    this.mufflerAction = ma > 0 ? (ma < 1 ? ma : 1) : 0;
    this.valveTarget = 0;
    this.turbGain = 1;
    this.cH = SPEED_OF_SOUND_COLD;
    this.cC = SPEED_OF_SOUND_COLD;
    this.cM = SPEED_OF_SOUND_COLD;
    this.configured = true;
    this.reset();
  }

  /** Speeds of sound (m/s) per group, clamped into [343, 700]; NaN keeps the previous value. Caller slews (τ 2–5 s). */
  setGasSpeeds(header: number, collector: number, muffler: number): void {
    const h = header === header ? clampSpeed(header) : this.cH;
    const c = collector === collector ? clampSpeed(collector) : this.cC;
    const m = muffler === muffler ? clampSpeed(muffler) : this.cM;
    if (h !== this.cH) {
      this.cH = h;
      for (let u = 0; u < this.nUnits; u++) this.headers[u]!.setSpeed(h);
    }
    if (c !== this.cC) {
      this.cC = c;
      for (let k = 0; k < this.nColl; k++) this.colls[k]!.setSpeed(c);
    }
    if (m !== this.cM) {
      this.cM = m;
      this.mid.setSpeed(m);
      this.tail.setSpeed(m);
      for (let k = 0; k < this.nCh; k++) this.chambers[k]!.setSpeed(m);
    }
  }

  /** 0 closed … 1 open (clamped; NaN → 0). Ignored when the voicing has no valve. Caller slews 150–300 ms. */
  setValve(open01: number): void {
    if (!this.valveFitted) return;
    this.valveTarget = open01 > 0 ? (open01 < 1 ? open01 : 1) : 0;
  }

  /** 0…1 (clamped; NaN → 0): transmitted turbine wave × (1 − 0.5·x). No effect without a turbine. */
  setTurbineAttenuation(x01: number): void {
    const a = x01 > 0 ? (x01 < 1 ? x01 : 1) : 0;
    this.turbGain = 1 - 0.5 * a;
  }

  tick(headerIn: Float64Array, popIn: number): void {
    if (!this.configured) return;
    // anti-zipper valve smoothing (inline Slew: no double crosses a call boundary, amendment B2)
    let v = this.vSmooth;
    const vt = this.valveTarget;
    if (v !== vt) {
      const st = this.valveStep;
      v = vt - v > st ? v + st : v - vt > st ? v - st : vt;
      this.vSmooth = v;
      this.applyValve(v);
    }

    const nUnits = this.nUnits;
    const nColl = this.nColl;
    const nCh = this.nCh;
    const headers = this.headers;
    const colls = this.colls;
    const chambers = this.chambers;
    const unitIn = this.unitIn;
    const hA = this.hA;
    const hI = this.hI;
    const cA = this.cA;
    const cI = this.cI;
    const kA = this.kA;
    const kI = this.kI;
    const pA = this.pA;
    const pI = this.pI;

    // 1. per-unit pulse inputs (Lite sums the entries of a bank; step 3 divides by the entry count)
    for (let u = 0; u < nUnits; u++) unitIn[u] = 0;
    const entryUnit = this.entryUnit;
    for (let i = 0; i < this.nEntries; i++) {
      const u = entryUnit[i]!;
      unitIn[u] = unitIn[u]! + (headerIn[i] ?? 0);
    }

    // 2. waves arriving at every section end: [2s] at end B, [2s + 1] at end A
    for (let u = 0; u < nUnits; u++) headers[u]!.outPair(hA, 2 * u);
    for (let c = 0; c < nColl; c++) colls[c]!.outPair(cA, 2 * c);
    this.mid.outPair(pA, 0);
    this.tail.outPair(pA, 2);
    for (let k = 0; k < nCh; k++) chambers[k]!.outPair(kA, 2 * k);
    const mR = pA[0]!; // mid-pipe wave arriving at the muffler junction
    const mL = pA[1]!; // mid-pipe wave arriving at the merge junction
    const tR = pA[2]!; // tailpipe wave arriving at the open end
    const tL = pA[3]!; // tailpipe wave arriving at the muffler junction

    // 3. cylinder ends (r = +0.7) and header → collector junctions (pops enter each collector)
    const unitInv = this.unitInv;
    for (let u = 0; u < nUnits; u++) hI[2 * u] = unitIn[u]! * unitInv[u]! + HEADER_END_REFLECTION * hA[2 * u + 1]!;
    const jin = this.jin;
    const jout = this.jout;
    const collUnits = this.collUnits;
    const popShare = popIn / nColl;
    let tap = 0;
    for (let c = 0; c < nColl; c++) {
      const s = this.collStart[c]!;
      const cnt = this.collCount[c]!;
      for (let j = 0; j < cnt; j++) jin[j] = hA[2 * collUnits[s + j]!]!;
      jin[cnt] = cA[2 * c + 1]!;
      this.collJ[c]!.scatter(jin, jout);
      for (let j = 0; j < cnt; j++) hI[2 * collUnits[s + j]! + 1] = jout[j]!;
      cI[2 * c] = jout[cnt]! + popShare;
      tap += jin[0]! + jout[0]!;
    }

    // 4. turbine 2-ports (diag(1, gG)·[[r, t], [t, −r]]·diag(1, gG), |G| ≤ 1) and the merge junction
    const mergeIn = this.mergeIn;
    const mergeOut = this.mergeOut;
    if (this.turbo) {
      const r = this.turbR;
      const t = this.turbT;
      const g = this.turbGain;
      const linkUp = this.linkUp;
      const linkDown = this.linkDown;
      const newDown = this.newDown;
      for (let c = 0; c < nColl; c++) {
        const a = cA[2 * c]!;
        const b = g * this.turbUp[c]!.process(linkUp[c]!);
        cI[2 * c + 1] = r * a + t * b;
        newDown[c] = g * this.turbDown[c]!.process(t * a - r * b);
        mergeIn[c] = linkDown[c]!;
      }
      mergeIn[nColl] = mL;
      this.merge.scatter(mergeIn, mergeOut);
      for (let c = 0; c < nColl; c++) {
        linkUp[c] = mergeOut[c]!;
        linkDown[c] = newDown[c]!;
      }
    } else {
      for (let c = 0; c < nColl; c++) mergeIn[c] = cA[2 * c]!;
      mergeIn[nColl] = mL;
      this.merge.scatter(mergeIn, mergeOut);
      for (let c = 0; c < nColl; c++) cI[2 * c + 1] = mergeOut[c]!;
    }
    pI[0] = mergeOut[nColl]!; // mid-pipe right-going input at the merge end

    // 5. muffler junction with the valve bypass: S = (1 − a)·S_junction + a·S_bypass (amendment B7)
    const muffIn = this.muffIn;
    const muffOut = this.muffOut;
    muffIn[0] = mR;
    muffIn[1] = tL;
    for (let k = 0; k < nCh; k++) muffIn[2 + k] = kA[2 * k + 1]!;
    this.muff.scatter(muffIn, muffOut);
    const a = this.bypass;
    const keep = 1 - a;
    pI[1] = keep * muffOut[0]! + a * tL; // mid-pipe left-going input
    pI[2] = keep * muffOut[1]! + a * mR; // tailpipe input = lerp(mufflerJunctionOut, midPipeOut, 0.7·valve)
    for (let k = 0; k < nCh; k++) {
      kI[2 * k] = keep * muffOut[2 + k]!; // chambers are absorbed by the bypass branch
      kI[2 * k + 1] = CHAMBER_END_REFLECTION * kA[2 * k]!; // closed far end
    }

    // 6. open end: reflection −0.85·LP1.5k(p⁺); exit wave p⁺ − p⁻ (amendment B10)
    let ol = this.openK * tR + this.openA * this.openY;
    if (ol < 1e-20 && ol > -1e-20) ol = 0;
    this.openY = ol;
    const refl = OPEN_END_REFLECTION * ol;
    pI[3] = refl;
    const exit = tR - refl;

    // 7. write every section
    for (let u = 0; u < nUnits; u++) headers[u]!.inputPair(hI, 2 * u);
    for (let c = 0; c < nColl; c++) colls[c]!.inputPair(cI, 2 * c);
    this.mid.inputPair(pI, 0);
    this.tail.inputPair(pI, 2);
    for (let k = 0; k < nCh; k++) chambers[k]!.inputPair(kI, 2 * k);

    // 8. radiation (outside every loop): 20 Hz first-order HP → first-order shelf at 2 kHz → open gain
    let lp = this.hpK * exit + this.hpA * this.hpY;
    if (lp < 1e-20 && lp > -1e-20) lp = 0;
    this.hpY = lp;
    const hp = exit - lp;
    let lo = this.shK * hp + this.shA * this.shY;
    if (lo < 1e-20 && lo > -1e-20) lo = 0;
    this.shY = lo;
    this.outletV = this.outGain * (lo + this.shelfGain * (hp - lo));
    this.tapV = tap / nColl;
  }

  /**
   * Admittance-weighted stored wave energy: Σ Y·rail energy of every section plus the turbine links.
   * Non-finite filter states outside the rails make it NaN (0·x term), for the per-quantum NaN check.
   */
  energy(): number {
    let e = 0;
    for (let u = 0; u < this.nUnits; u++) e += this.unitY[u]! * this.headers[u]!.energy();
    for (let c = 0; c < this.nColl; c++) {
      const up = this.linkUp[c]!;
      const down = this.linkDown[c]!;
      e += this.collY[c]! * (this.colls[c]!.energy() + up * up + down * down);
    }
    e += this.yMid * (this.mid.energy() + this.tail.energy());
    for (let k = 0; k < this.nCh; k++) e += this.yCh * this.chambers[k]!.energy();
    return e + 0 * (this.openY + this.hpY + this.shY + this.outletV);
  }

  /** Clears all wave and filter state; keeps topology, speeds, valve target and attenuation. */
  reset(): void {
    for (let u = 0; u < MAX_COMBUSTION; u++) this.headers[u]!.clear();
    for (let c = 0; c < MAX_COLLECTORS; c++) {
      this.colls[c]!.clear();
      this.turbDown[c]!.reset();
      this.turbUp[c]!.reset();
    }
    for (let k = 0; k < MAX_MUFFLER_CHAMBERS; k++) this.chambers[k]!.clear();
    this.mid.clear();
    this.tail.clear();
    this.linkUp.fill(0);
    this.linkDown.fill(0);
    this.newDown.fill(0);
    this.openY = 0;
    this.hpY = 0;
    this.shY = 0;
    this.vSmooth = this.valveTarget;
    if (this.configured) this.applyValve(this.valveTarget);
    this.outletV = 0;
    this.tapV = 0;
  }

  /** Length clamped into [4.5 samples at 700 m/s, contract max]. */
  private len(x: number, max: number): number {
    return x > this.minLen ? (x < max ? x : max) : this.minLen;
  }

  private applyValve(v: number): void {
    const yMid = this.yMid;
    this.yCh = yMid * (CHAMBER_Y_BASE + CHAMBER_Y_ACTION * this.mufflerAction * (1 - v));
    const adm = this.muffAdm;
    adm[0] = yMid;
    adm[1] = yMid; // Y_tail = Y_mid: the straight-through bypass is lossless (B7)
    for (let k = 0; k < this.nCh; k++) adm[2 + k] = this.yCh;
    this.muff.configure(adm, 2 + this.nCh);
    this.bypass = BYPASS_MAX * v;
    this.shelfGain = dbToGain(VALVE_BRIGHTEN_DB * v - CLOSED_SHELF_CUT_DB * this.mufflerAction * (1 - v));
    this.outGain = dbToGain(this.openGainDb * v);
  }
}

/** One-pole coefficient k = 1 − e^(−2π·hz/fs) (same law as OnePole.setCutoff). */
function onePoleK(hz: number, fs: number): number {
  return 1 - Math.exp((-2 * Math.PI * hz) / fs);
}

function clampSpeed(c: number): number {
  return c > SPEED_OF_SOUND_COLD ? (c < SPEED_OF_SOUND_MAX ? c : SPEED_OF_SOUND_MAX) : SPEED_OF_SOUND_COLD;
}
```

- [ ] **Step 4: Run the exhaust tests and watch them pass**

Run:

```bash
npx vitest run tests/unit/dsp-exhaust.test.ts
```

Expected: PASS — `Tests  31 passed (31)` in about 4 s; the slowest single test (an RF5 case or the resonance scan) takes ≈ 0.5 s, far below the 5 s default timeout. If a passivity case fails, print its label (fixture, tier, valve, speed) from the assertion message and debug that configuration — never loosen the window or the −120 dB bound.

- [ ] **Step 5: Run every Task 1–3 suite together**

Run:

```bash
npx vitest run tests/unit/dsp-util.test.ts tests/unit/dsp-biquad.test.ts tests/unit/dsp-oversample.test.ts tests/unit/dsp-fixtures.test.ts tests/unit/dsp-delay.test.ts tests/unit/dsp-junction.test.ts tests/unit/dsp-waveguide.test.ts tests/unit/dsp-exhaust.test.ts
```

Expected: PASS — `Test Files  8 passed (8)`, `Tests  116 passed (116)`.

- [ ] **Step 6: Lint and typecheck**

Run:

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no errors or warnings.

---

### Task 4: CombustionSource: crank clock, firing scheduler, blowdown pulse voices, intake gates, ignition impulses (`src/dsp/combustion.ts`)

**Files:**
- Create: `src/dsp/combustion.ts`
- Test: `tests/unit/dsp-combustion.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED): `MAX_COMBUSTION` (= 16); `type EngineSpec` (reads `cycleDeg`, `combustion[i].angleDeg`); `type EngineVoicing` (reads `pulse.widthDeg`, `pulse.alpha`, `pulse.beta`, `pulse.evoOffsetDeg`, `pulse.cycleAsymmetry`). The tests build complete `EngineSpec`/`EngineVoicing` literals.
  - `src/dsp/util.ts` (T1): `flush(x: number): number`; `clamp(x: number, lo: number, hi: number): number`; `class Rng { constructor(seed?: number); seed(s: number): void; bipolar(): number /* [-1, 1) */ }`.
- Produces (contract API + amendment B4, exact):
  - `export class CombustionSource { constructor(fs: number); configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void; skipMask: number; skipIsIgnition: boolean; tick(rpm: number, load: number, combustionGain: number, exhaustOut: Float64Array, intakeGate: Float64Array): number; takeIgnitionCutPops(): number; readonly crankDeg: number; reset(): void }`
  - Extra pure exports (no allocation; used by the tests and available to T8/T9/T10): `pulseShape(phi: number, alpha: number, beta: number): number` is the un-normalised E(φ) and returns 0 outside (0, 1) and for NaN. `pulsePeak(alpha: number, beta: number): number` is max E. `peakFraction(alpha: number, beta: number): number` is ln((α+β)/β)/α. `clampAlpha(alpha: number, beta: number, minFrac: number): number`. Constants: `DC_BLOCK_HZ = 10`, `ALPHA_FLOOR = 1e-3`, `RPM_CEIL = 30000`, `ROTARY_FACE_DEPTH = 0.1`.
  - Behaviour that T9 (DspCore) and T10 (tools) rely on:
    - **Errors.** `constructor` throws `RangeError` unless `fs` is finite and ≥ 8000. `configure` throws `RangeError` for 0 or more than 16 combustion entries. `tick` never throws and never allocates.
    - **Clock.** `crankDeg` advances by `d = rpm·6/fs` per `tick` and wraps into `[0, cycleDeg)`, where cycleDeg is 1080 iff `spec.cycleDeg === 1080`, else 720.
      - rpm ≤ 0, NaN or −∞ means a stopped engine: the crank does not advance and nothing fires.
      - rpm above `RPM_CEIL`, including +∞, saturates at `RPM_CEIL`.
      - A firing at angle `a` happens in the tick whose advance covers it, half-open: `a ∈ [prev, prev + d)` mod cycleDeg. An entry at 0° therefore fires on the first tick with rpm > 0 after `reset()`.
      - All outputs are values at the end of the tick's advance. Pulses start with sub-sample precision: they are already `over` degrees in.
    - **Outputs.** `exhaustOut[i]` (i < n) is entry i's blowdown pulse after its DC blocker `y = g·(x − x₁) + R·y₁`, with `R = e^(−2π·10/fs)` and `g = (1 + R)/2`. `intakeGate[i]` is in [0, 1]. Indices n…15 of both buffers are written 0 on every tick, so pass `Float64Array(MAX_COMBUSTION)` buffers.
    - **Return value.** The sum of this tick's ignition impulses. An impulse is 1 sample wide at the nominal firing angle (no timing jitter). Its amplitude is `(0.15 + 0.85·clamp(load,0,1)^0.7)·(1 + 0.05·U[−1,1))·(1 ∓ 0.5·cycleAsymmetry)·face_i·clamp(combustionGain,0,1)`.
      - NaN load or gain counts as 0.
      - `face_i` is 1 for 4-stroke engines and `1 + 0.1·cos(2π·angle_i/1080)` for rotary engines (spec §5.1 "per-face variation → ⅓-order texture").
    - **Cuts (B4).** `skipMask` (bit i) and `skipIsIgnition` are read in the tick where entry i fires.
      - A skipped firing launches no blowdown and emits no ignition impulse.
      - If `skipIsIgnition` is true at that moment, the skipped firing is counted for `takeIgnitionCutPops()`, which returns the count and zeroes it.
      - A blowdown already scheduled by an earlier, unskipped firing still plays.
      - Jitter is drawn for every firing, cut or not, so the RNG sequence does not depend on cuts.
    - **Blowdown.** The peak equals that firing's impulse amplitude, because E is normalised by `pulsePeak`.
      - It starts at `angle + evoOffsetDeg + U(−1, 1)°` and lasts `widthDeg` crank degrees, so it stretches and shrinks with rpm.
      - `α_eff = alpha·(0.7 + 0.6·clamp(load,0,1))` uses the load at firing. It is then clamped with `clampAlpha(α_eff, beta, 4·d/widthDeg)`, using the rpm at blowdown start. This is the contract's `ln((α+β)/β)/α · widthSamples ≥ 4`, computed without dividing by rpm.
    - **Intake gate.** The nominal windows are `angle + 360 + [−10, 230]°` (4-stroke) and `angle + [60, 300]°` (rotary).
      - Each boundary gets a 10° raised-cosine edge centred on it. The gate is 0.5 exactly at the nominal boundary, and its area per cycle equals the 240° window length.
      - The gate depends only on crank angle and ignores `skipMask`.
    - **Cycle parity.** Each entry's first firing after `reset()` is an "even" cycle (×(1 − 0.5·asym)). Parity then alternates.
    - **Reset and config clamps.** `reset()` sets the crank to 0, clears voices, pending blowdowns, DC state and pops, sets `skipMask = 0` and `skipIsIgnition = false`, and re-seeds the RNG with the `configure` seed. Output therefore replays bit-identically. `configure` ends with `reset()`. Config clamps:
      - `widthDeg` → [10, 180] for 4-stroke, [10, 300] for rotary.
      - `evoOffsetDeg` → [0, cycleDeg/2]; `cycleAsymmetry` → [0, 1].
      - `alpha` ≥ 1e-3 and `beta` ≥ 1e-3.
      - Non-finite pulse numbers fall back to 60/9/4/140/0.
      - Angles are wrapped into [0, cycleDeg).

**Cross-task premises:** (open each named file and confirm before coding)
- **`src/dsp/util.ts` (T1)** exports `flush`, `clamp` and `Rng` with the contract signatures.
  - `flush(x)` returns exactly 0 when |x| < 1e-20 and `x` unchanged otherwise.
  - `clamp(x, lo, hi)` returns `lo` below the range, `hi` above it and `x` otherwise.
  - `new Rng(1)` is valid. `rng.seed(s)` restarts the sequence, so the same seed reproduces the same draws. `rng.bipolar()` is uniform in [−1, 1).
  - The statistical assertions (jitter spread, rotary face means, ⅓-order sidebands, amplitude range) were checked against mulberry32 across seeds 1–150 with margin. Any uniform generator passes them.
- **`src/contracts.ts`** has `MAX_COMBUSTION = 16`. `EngineSpec`/`EngineVoicing` have exactly the fields used by `makeEngine()` in the test. If either interface gained a required field, add it to the test literal.
- **Phase 0 tooling (Phase 0 T1):**
  - Vitest includes `tests/unit/**/*.test.ts` in the `node` environment.
  - `tsconfig.json` has `strict` and `noUncheckedIndexedAccess`, which is why every typed-array read uses `?? 0` or the test helper `at()`.
  - ESLint is `@eslint/js` plus `typescript-eslint` recommended.
- **T10 adds the amendment-B1 rule.** This applies the `no-restricted-syntax` rule to `MethodDefinition[key.name=/^(tick|…)$/] > FunctionExpression > BlockStatement`. `tick` contains no `new`, no array or object literals, no closures, spread, template literals, `try` or `throw`. The only template literals are in `constructor` and `configure`. This was verified with eslint 10.12 and typescript-eslint 8.71 using the B1 selector.
- **T9 (DspCore): contract-only expectations, no code dependency.**
  - T9 sets `skipMask` and `skipIsIgnition` before every `tick` (B4/B5). `skipIsIgnition` defaults to `false` and is cleared by `reset()`, so if T9 never sets it, `takeIgnitionCutPops()` always returns 0.
  - T9 passes `exhaustOut` to `ExhaustNetwork.tick`, sums `intakeGate[0..n−1]` into `IntakeLayer.tick`, and passes the return value to `MechanicalLayer.tick`.
  - T9 passes `takeIgnitionCutPops()` straight to `OverrunLayer.tick`. No extra gating is needed, because only ignition cuts are counted.

- [ ] **Step 1: Write the failing tests for the pure pulse helpers**

Create `tests/unit/dsp-combustion.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALPHA_FLOOR, clampAlpha, peakFraction, pulsePeak, pulseShape } from '../../src/dsp/combustion';

describe('pulse helpers', () => {
  it('pulseShape is 0 outside (0, 1) and for NaN, quadratic at onset, zero-slope at the end, continuous at the taper', () => {
    expect(pulseShape(0, 9, 4)).toBe(0);
    expect(pulseShape(-0.1, 9, 4)).toBe(0);
    expect(pulseShape(1, 9, 4)).toBe(0);
    expect(pulseShape(1.2, 9, 4)).toBe(0);
    expect(pulseShape(Number.NaN, 9, 4)).toBe(0);
    // onset ≈ (αφ)²: 10× smaller φ → ≈ 100× smaller E (C¹ onset)
    expect(pulseShape(1e-4, 9, 4) / pulseShape(1e-3, 9, 4)).toBeCloseTo(0.01, 3);
    // end ≈ (1 − φ)² (cos² taper): E(1) = 0 with zero slope
    expect(pulseShape(1 - 1e-4, 9, 4) / pulseShape(1 - 1e-3, 9, 4)).toBeLessThan(0.011);
    expect(Math.abs(pulseShape(0.75 + 1e-9, 9, 4) - pulseShape(0.75 - 1e-9, 9, 4))).toBeLessThan(1e-8);
  });

  it('pulseShape matches (1 − e^(−αφ))²·e^(−βφ) before the taper and adds the cos² taper after 0.75', () => {
    expect(pulseShape(0.3, 9, 4)).toBeCloseTo(Math.pow(1 - Math.exp(-2.7), 2) * Math.exp(-1.2), 14);
    const phi = 0.9;
    const taper = Math.pow(Math.cos((Math.PI / 2) * ((phi - 0.75) / 0.25)), 2);
    expect(pulseShape(phi, 9, 4)).toBeCloseTo(Math.pow(1 - Math.exp(-9 * phi), 2) * Math.exp(-4 * phi) * taper, 14);
  });

  it('pulsePeak is the true maximum (closed-form and tapered branches)', () => {
    const cases: [number, number][] = [
      [9, 4],
      [40, 4],
      [2, 1],
      [1, 0.5], // untapered peak beyond 0.75 → golden-section branch
      [0.2, 0.05],
      [ALPHA_FLOOR, 4],
      [200, 30],
    ];
    for (const [alpha, beta] of cases) {
      const peak = pulsePeak(alpha, beta);
      expect(peak).toBeGreaterThan(0);
      let max = 0;
      const steps = 200000;
      for (let k = 1; k < steps; k++) max = Math.max(max, pulseShape(k / steps, alpha, beta));
      expect(max / peak).toBeLessThanOrEqual(1 + 1e-9);
      expect(max / peak).toBeGreaterThan(1 - 1e-6);
    }
  });

  it('peakFraction is ln((α + β)/β)/α, decreasing in α, → 1/β as α → 0', () => {
    expect(peakFraction(9, 4)).toBeCloseTo(Math.log((9 + 4) / 4) / 9, 14);
    expect(peakFraction(20, 4)).toBeLessThan(peakFraction(10, 4));
    expect(peakFraction(1e-9, 4)).toBeCloseTo(0.25, 6);
  });

  it('clampAlpha passes valid α through, returns the largest valid α otherwise, ALPHA_FLOOR when unattainable', () => {
    expect(clampAlpha(9, 4, 0.01)).toBe(9);
    expect(clampAlpha(9, 4, 0)).toBe(9); // rpm 0 → minFrac 0 → no clamp
    const a = clampAlpha(52, 4, 0.15);
    expect(a).toBeLessThan(52);
    expect(peakFraction(a, 4)).toBeGreaterThanOrEqual(0.15);
    expect(peakFraction(a * (1 + 1e-6), 4)).toBeLessThan(0.15);
    expect(clampAlpha(9, 4, 0.3)).toBe(ALPHA_FLOOR); // even α → 0 peaks before 0.25 of the width
  });
});
```

- [ ] **Step 2: Run the helper tests and confirm they fail**

Run: `npx vitest run tests/unit/dsp-combustion.test.ts`
Expected: FAIL. The suite does not load and shows `Error: Cannot find module '../../src/dsp/combustion' imported from …/tests/unit/dsp-combustion.test.ts` and `Tests  no tests`.

- [ ] **Step 3: Implement the pure pulse helpers**

Create `src/dsp/combustion.ts`. Step 7 replaces the whole file and keeps these helpers verbatim.

```ts
/**
 * Combustion source — pulse-shape helpers (Task 4, step 3). The CombustionSource class is added in
 * step 7, which replaces this whole file.
 */
/** Lower bound for the onset sharpness α (also the α returned when the clamp is unattainable). */
export const ALPHA_FLOOR = 1e-3;

const TAPER_START = 0.75;
const HALF_PI = Math.PI / 2;
const INV_GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Un-normalised pulse E(φ); 0 outside the open interval (0, 1) and for NaN. */
export function pulseShape(phi: number, alpha: number, beta: number): number {
  if (!(phi > 0) || phi >= 1) return 0;
  const rise = -Math.expm1(-alpha * phi); // 1 − e^(−αφ), accurate for small αφ
  let e = rise * rise * Math.exp(-beta * phi);
  if (phi > TAPER_START) {
    const c = Math.cos((HALF_PI * (phi - TAPER_START)) / (1 - TAPER_START));
    e *= c * c;
  }
  return e;
}

/**
 * max over φ ∈ (0, 1) of pulseShape(φ, α, β). ln E is a sum of concave terms on (0, 1), so E is
 * unimodal. The untapered peak is φ* = ln(1 + 2α/β)/α; when φ* ≤ 0.75 the taper is 1 there and
 * the peak is exact, otherwise the maximum lies in [0.75, 1) and is found by golden-section search.
 */
export function pulsePeak(alpha: number, beta: number): number {
  const phiStar = Math.log1p((2 * alpha) / beta) / alpha;
  if (phiStar <= TAPER_START) return pulseShape(phiStar, alpha, beta);
  let a = TAPER_START;
  let b = 1;
  let c = b - INV_GOLDEN * (b - a);
  let d = a + INV_GOLDEN * (b - a);
  let fc = pulseShape(c, alpha, beta);
  let fd = pulseShape(d, alpha, beta);
  for (let k = 0; k < 48; k++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_GOLDEN * (b - a);
      fc = pulseShape(c, alpha, beta);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_GOLDEN * (b - a);
      fd = pulseShape(d, alpha, beta);
    }
  }
  return fc > fd ? fc : fd;
}

/** Contract time-to-peak as a fraction of the pulse width: ln((α + β)/β)/α (strictly decreasing in α, → 1/β as α → 0). */
export function peakFraction(alpha: number, beta: number): number {
  return Math.log1p(alpha / beta) / alpha;
}

/**
 * Contract α clamp: the largest α' ≤ alpha with peakFraction(α', β) ≥ minFrac, where
 * minFrac = MIN_PEAK_SAMPLES / widthSamples = MIN_PEAK_SAMPLES·(rpm·6/fs)/widthDeg (no division by
 * rpm, so rpm = 0 gives minFrac = 0 and no clamp). Returns alpha unchanged when it already
 * satisfies the bound; returns ALPHA_FLOOR when even ALPHA_FLOOR cannot (bound unattainable).
 */
export function clampAlpha(alpha: number, beta: number, minFrac: number): number {
  if (!(minFrac > 0) || peakFraction(alpha, beta) >= minFrac) return alpha;
  if (alpha <= ALPHA_FLOOR || peakFraction(ALPHA_FLOOR, beta) < minFrac) return ALPHA_FLOOR;
  let lo = ALPHA_FLOOR; // satisfies the bound
  let hi = alpha; // violates it
  for (let k = 0; k < 48; k++) {
    const mid = 0.5 * (lo + hi);
    if (peakFraction(mid, beta) >= minFrac) lo = mid;
    else hi = mid;
  }
  return lo;
}
```

Design notes:
- ln E(φ) is a sum of concave terms on (0, 1), so E is unimodal.
- The untapered peak of the squared form is φ* = ln(1 + 2α/β)/α. When φ* ≤ 0.75 the taper is 1 there and `pulsePeak` is exact. Otherwise the maximum lies in [0.75, 1) and a 48-step golden-section search finds it (interval ≈ 2.5·10⁻¹¹).
- `peakFraction(α) = ln(1 + α/β)/α` decreases strictly from 1/β (as α → 0), so the contract's α clamp is a monotone bisection. No Lambert-W is needed.
- The contract's time-to-peak formula is the peak of the *unsquared* rise. The squared form peaks later, so enforcing the contract bound also keeps the real peak ≥ 4 samples in.
- `minFrac = 4·(rpm·6/fs)/widthDeg` is passed in instead of `4/widthSamples`. At rpm 0 it is therefore 0, with no division by zero (RF2).

- [ ] **Step 4: Run the helper tests and confirm they pass**

Run: `npx vitest run tests/unit/dsp-combustion.test.ts`
Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 5: Write the failing CombustionSource tests, including review-focus RF2 and RF3**

Make two edits to `tests/unit/dsp-combustion.test.ts`. The `describe('pulse helpers', …)` block from Step 1 stays unchanged between them.

(a) Replace the two `import` lines at the top of the file (everything above `describe('pulse helpers'`) with this block of imports and shared helpers. Keep one blank line before the `describe`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION } from '../../src/contracts';
import type { EngineSpec, EngineVoicing } from '../../src/contracts';
import {
  ALPHA_FLOOR,
  CombustionSource,
  DC_BLOCK_HZ,
  RPM_CEIL,
  ROTARY_FACE_DEPTH,
  clampAlpha,
  peakFraction,
  pulsePeak,
  pulseShape,
} from '../../src/dsp/combustion';

const FS = 48000;

/** Typed read for noUncheckedIndexedAccess: throws instead of returning undefined. */
function at<T>(xs: ArrayLike<T>, i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${xs.length})`);
  return v;
}

interface PulseOpts {
  widthDeg?: number;
  alpha?: number;
  beta?: number;
  evoOffsetDeg?: number;
  cycleAsymmetry?: number;
}

function makeEngine(angles: number[], cycleDeg: 720 | 1080 = 720, pulse: PulseOpts = {}): { spec: EngineSpec; voicing: EngineVoicing } {
  const spec: EngineSpec = {
    layout: { type: cycleDeg === 1080 ? 'rotary' : 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2 },
    cycleDeg,
    combustion: angles.map((angleDeg) => ({ angleDeg, bank: 0 })),
    rpm: { idle: 800, redline: 7000, limiter: { type: 'ignition-hard', rpm: 7100, hysteresisRpm: 150 } },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: {
      type: 'manual',
      overallRatios: [13.1, 8.4, 6.1, 4.8, 4.0, 3.4],
      drivenTyre: '225/40R18',
      shiftTimeS: 0.3,
      tc: null,
    },
    sources: { layout: ['test'], combustion: ['test'], rpm: ['test'], aspiration: ['test'], gearbox: ['test'] },
  };
  const voicing: EngineVoicing = {
    pulse: {
      widthDeg: pulse.widthDeg ?? 60,
      alpha: pulse.alpha ?? 9,
      beta: pulse.beta ?? 4,
      evoOffsetDeg: pulse.evoOffsetDeg ?? 140,
      cycleAsymmetry: pulse.cycleAsymmetry ?? 0,
    },
    headersM: angles.map(() => 0.6),
    collectors: [{ banks: [0], lengthM: 0.35 }],
    turbine: null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: false, openGainDb: 0 },
    },
    intake: { runnerM: 0.3, helmholtzHz: 140, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: 1300 },
    cabin: { lowpassHz: 600 },
    launchRpm: 3000,
    estimated: true,
  };
  return { spec, voicing };
}

function makeSource(angles: number[], cycleDeg: 720 | 1080 = 720, pulse: PulseOpts = {}, seed = 1): CombustionSource {
  const { spec, voicing } = makeEngine(angles, cycleDeg, pulse);
  const src = new CombustionSource(FS);
  src.configure(spec, voicing, seed);
  return src;
}

interface Capture {
  ex: Float64Array[];
  gate: Float64Array[];
  ign: Float64Array;
  crank: Float64Array;
}

interface RenderOpts {
  rpm: number | ((k: number) => number);
  load?: number;
  gain?: number;
  mask?: (k: number) => number;
  ignitionCut?: boolean;
}

/** Ticks `samples` times and records every entry's outputs, the ignition sum and the crank angle. */
function render(src: CombustionSource, entries: number, samples: number, o: RenderOpts): Capture {
  const exOut = new Float64Array(MAX_COMBUSTION);
  const gateOut = new Float64Array(MAX_COMBUSTION);
  const ex = Array.from({ length: entries }, () => new Float64Array(samples));
  const gate = Array.from({ length: entries }, () => new Float64Array(samples));
  const ign = new Float64Array(samples);
  const crank = new Float64Array(samples);
  const rpmOf = o.rpm;
  for (let k = 0; k < samples; k++) {
    src.skipMask = o.mask ? o.mask(k) : 0;
    src.skipIsIgnition = o.ignitionCut ?? false;
    const rpm = typeof rpmOf === 'number' ? rpmOf : rpmOf(k);
    ign[k] = src.tick(rpm, o.load ?? 0.5, o.gain ?? 1, exOut, gateOut);
    crank[k] = src.crankDeg;
    for (let i = 0; i < entries; i++) {
      at(ex, i)[k] = at(exOut, i);
      at(gate, i)[k] = at(gateOut, i);
    }
  }
  return { ex, gate, ign, crank };
}

/** Inverts the per-entry DC blocker y = g·(x − x₁) + R·y₁ (g = (1 + R)/2) to recover the raw pulse train. */
function undc(y: Float64Array): Float64Array {
  const r = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) / FS);
  const g = (1 + r) / 2;
  const x = new Float64Array(y.length);
  let xPrev = 0;
  let yPrev = 0;
  for (let k = 0; k < y.length; k++) {
    const yk = at(y, k);
    const xk = xPrev + (yk - r * yPrev) / g;
    x[k] = xk;
    xPrev = xk;
    yPrev = yk;
  }
  return x;
}

interface Pulse {
  start: number;
  peakIndex: number;
  peak: number;
  length: number;
}

/** Contiguous runs of the recovered pulse train above `eps`. */
function pulses(x: Float64Array, eps = 1e-9): Pulse[] {
  const out: Pulse[] = [];
  let k = 0;
  while (k < x.length) {
    if (at(x, k) > eps) {
      const start = k;
      let peakIndex = k;
      while (k < x.length && at(x, k) > eps) {
        if (at(x, k) > at(x, peakIndex)) peakIndex = k;
        k++;
      }
      out.push({ start, peakIndex, peak: at(x, peakIndex), length: k - start });
    } else {
      k++;
    }
  }
  return out;
}

function firings(ign: Float64Array): number[] {
  const idx: number[] = [];
  for (let k = 0; k < ign.length; k++) if (at(ign, k) !== 0) idx.push(k);
  return idx;
}

function allFinite(xs: ArrayLike<number>): boolean {
  for (let k = 0; k < xs.length; k++) if (!Number.isFinite(at(xs, k))) return false;
  return true;
}

function allZero(xs: ArrayLike<number>): boolean {
  for (let k = 0; k < xs.length; k++) if (at(xs, k) !== 0) return false;
  return true;
}

function level(load: number): number {
  return 0.15 + 0.85 * Math.pow(Math.max(load, 0), 0.7);
}

/** |DFT|² of x at frequency hz (Hann window). */
function lineEnergy(x: Float64Array, hz: number): number {
  let re = 0;
  let im = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    const ph = (2 * Math.PI * hz * k) / FS;
    re += w * at(x, k) * Math.cos(ph);
    im -= w * at(x, k) * Math.sin(ph);
  }
  return re * re + im * im;
}
```

(b) Append this to the end of the file, after one blank line:

```ts
describe('CombustionSource: clock, firing, amplitude', () => {
  it('rejects bad sample rates and combustion counts outside 1–16', () => {
    expect(() => new CombustionSource(0)).toThrow(RangeError);
    expect(() => new CombustionSource(Number.NaN)).toThrow(RangeError);
    expect(() => new CombustionSource(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const src = new CombustionSource(FS);
    const tooMany = makeEngine(Array.from({ length: MAX_COMBUSTION + 1 }, (_, i) => i * 40));
    expect(() => src.configure(tooMany.spec, tooMany.voicing, 1)).toThrow(RangeError);
    const none = makeEngine([]);
    expect(() => src.configure(none.spec, none.voicing, 1)).toThrow(RangeError);
  });

  it('advances the crank by rpm·6/fs per tick and wraps into [0, cycleDeg)', () => {
    const src = makeSource([0, 180, 360, 540]);
    const exOut = new Float64Array(MAX_COMBUSTION);
    const gateOut = new Float64Array(MAX_COMBUSTION);
    let expected = 0;
    for (let k = 0; k < 5000; k++) {
      src.tick(3000, 0.5, 1, exOut, gateOut); // 0.375°/sample, exact in binary
      expected = (expected + 0.375) % 720;
      expect(src.crankDeg).toBe(expected);
    }
    const rotary = makeSource([0, 360, 720], 1080, { widthDeg: 300 });
    for (let k = 0; k < 4000; k++) rotary.tick(5000, 0.5, 1, exOut, gateOut); // 0.625°/sample
    expect(rotary.crankDeg).toBeGreaterThanOrEqual(0);
    expect(rotary.crankDeg).toBeLessThan(1080);
    expect(rotary.crankDeg).toBeCloseTo((4000 * 0.625) % 1080, 6);
  });

  it('fires every entry once per cycle at its angle (I4 at 3000 rpm: 100 firings/s)', () => {
    const angles = [0, 180, 360, 540];
    const cap = render(makeSource(angles), 4, FS, { rpm: 3000 });
    const idx = firings(cap.ign);
    expect(idx.length).toBe(100);
    for (const k of idx) {
      const end = at(cap.crank, k);
      // the firing angle lies in [end − d, end) ⇒ (end − angle) mod 720 ∈ (0, d]
      const hit = angles.some((a) => {
        const past = (((end - a) % 720) + 720) % 720;
        return past > 0 && past <= 0.375 + 1e-9;
      });
      expect(hit).toBe(true);
    }
  });

  it('scales amplitude by (0.15 + 0.85·max(load, 0)^0.7)·combustionGain with ±5 % uniform jitter', () => {
    const cases: [number, number][] = [
      [0.5, 0.8],
      [1, 1],
      [-0.4, 0.6],
      [0, 0.15],
    ];
    for (const [load, gain] of cases) {
      const cap = render(makeSource([0, 180, 360, 540]), 4, FS, { rpm: 3000, load, gain });
      const amps = firings(cap.ign).map((k) => at(cap.ign, k));
      const base = level(load) * gain;
      expect(amps.length).toBe(100);
      for (const a of amps) {
        expect(a).toBeGreaterThanOrEqual(0.95 * base - 1e-12);
        expect(a).toBeLessThanOrEqual(1.05 * base + 1e-12);
      }
      expect(Math.max(...amps) - Math.min(...amps)).toBeGreaterThan(0.05 * base); // jitter present
    }
  });

  it('alternates cycle amplitudes by 1 − 0.5·asym (even, first) and 1 + 0.5·asym (odd)', () => {
    const cap = render(makeSource([0], 720, { cycleAsymmetry: 1 }), 1, FS, { rpm: 3000 });
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(amps.length).toBe(25);
    for (let c = 0; c < amps.length; c++) {
      const scale = c % 2 === 0 ? 0.5 : 1.5;
      expect(at(amps, c)).toBeGreaterThanOrEqual(level(0.5) * scale * 0.95 - 1e-12);
      expect(at(amps, c)).toBeLessThanOrEqual(level(0.5) * scale * 1.05 + 1e-12);
    }
  });

  it('rotary faces carry a fixed 1 + depth·cos(2π·angle/1080) signature → ⅓-order sidebands', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const src = makeSource(angles, 1080, { widthDeg: 300, evoOffsetDeg: 200 });
    const cycles = 60;
    const cap = render(src, 6, cycles * 2880, { rpm: 3000 }); // 0.375°/sample → 2880 samples per 1080°
    const idx = firings(cap.ign);
    expect(idx.length).toBe(6 * cycles);
    const sums = new Map<number, { sum: number; count: number }>();
    for (const k of idx) {
      const end = at(cap.crank, k);
      const face = angles.find((a) => {
        const past = (((end - a) % 1080) + 1080) % 1080;
        return past > 0 && past <= 0.375 + 1e-9;
      });
      expect(face).toBeDefined();
      const key = face ?? -1;
      const s = sums.get(key) ?? { sum: 0, count: 0 };
      s.sum += at(cap.ign, k);
      s.count += 1;
      sums.set(key, s);
    }
    for (const a of angles) {
      const s = sums.get(a);
      expect(s?.count).toBe(cycles);
      const mean = (s?.sum ?? 0) / cycles;
      const expected = level(0.5) * (1 + ROTARY_FACE_DEPTH * Math.cos((2 * Math.PI * a) / 1080));
      expect(Math.abs(mean / expected - 1)).toBeLessThan(0.025); // faces differ by 5–10 %
    }
    // ignition train: firing line at order 2 (100 Hz at 3000 rpm), sidebands at orders 5/3 and 7/3
    const order = 50; // e-shaft Hz
    const main = lineEnergy(cap.ign, 2 * order);
    for (const side of [5 / 3, 7 / 3]) {
      const db = 10 * Math.log10(lineEnergy(cap.ign, side * order) / main);
      expect(db).toBeGreaterThan(-30);
      expect(db).toBeLessThan(-20);
    }
  });
});

describe('CombustionSource: blowdown pulses', () => {
  it('emits one peak-normalised pulse per firing, widthDeg long, starting evoOffsetDeg ± 1° after ignition', () => {
    const samples = 30 * 5760; // 30 cycles at 1000 rpm (0.125°/sample, 5760 samples per 720°)
    const cap = render(makeSource([0]), 1, samples, { rpm: 1000, load: 0.5 });
    const x = undc(at(cap.ex, 0));
    const ps = pulses(x);
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(ps.length).toBe(30);
    const onsets: number[] = [];
    ps.forEach((p, c) => {
      expect(p.peak / at(amps, c)).toBeGreaterThan(1 - 1e-4);
      expect(p.peak / at(amps, c)).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.length).toBeGreaterThanOrEqual(470); // 60° / 0.125° = 480 samples (cos² tail below eps)
      expect(p.length).toBeLessThanOrEqual(481);
      const startEnd = at(cap.crank, p.start); // crank at the end of the pulse's first tick
      onsets.push(startEnd);
      expect(startEnd).toBeGreaterThan(139); // 140 − 1° jitter
      expect(startEnd).toBeLessThanOrEqual(141 + 2 * 0.125);
    });
    expect(Math.max(...onsets) - Math.min(...onsets)).toBeGreaterThan(1); // timing jitter present
    let minX = 0;
    for (let k = 0; k < x.length; k++) minX = Math.min(minX, at(x, k));
    expect(minX).toBeGreaterThan(-1e-9); // the raw pulses are one-sided
  });

  it('sharpens α with load: α_eff = α·(0.7 + 0.6·load) sets the time-to-peak', () => {
    for (const load of [0, 1]) {
      const cap = render(makeSource([0]), 1, 6 * 5760, { rpm: 1000, load });
      const ps = pulses(undc(at(cap.ex, 0)));
      expect(ps.length).toBe(6);
      const aEff = 9 * (0.7 + 0.6 * load);
      const phiPeak = Math.log1p((2 * aEff) / 4) / aEff; // peak of the squared form
      for (const p of ps) expect(Math.abs(p.peakIndex - p.start - phiPeak * 480)).toBeLessThanOrEqual(2);
    }
  });

  it('blocks DC per entry (10 Hz high-pass) and outputs exactly 0 before the first blowdown', () => {
    const cap = render(makeSource([0, 180, 360, 540]), 4, 2 * FS, { rpm: 3000, load: 0.8 });
    for (let i = 0; i < 4; i++) {
      const y = at(cap.ex, i);
      expect(at(y, 0)).toBe(0);
      const x = undc(y);
      let sumY = 0;
      let sumX = 0;
      for (let k = FS; k < 2 * FS; k++) {
        sumY += at(y, k);
        sumX += at(x, k);
      }
      expect(Math.abs(sumY / FS)).toBeLessThan(2e-3);
      expect(sumX / FS).toBeGreaterThan(0.02);
    }
  });

  it('writes 0 to the outputs of unused entries', () => {
    const src = makeSource([0, 360]);
    const exOut = new Float64Array(MAX_COMBUSTION).fill(7);
    const gateOut = new Float64Array(MAX_COMBUSTION).fill(7);
    src.tick(3000, 0.5, 1, exOut, gateOut);
    for (let i = 2; i < MAX_COMBUSTION; i++) {
      expect(at(exOut, i)).toBe(0);
      expect(at(gateOut, i)).toBe(0);
    }
  });

  it('is deterministic per seed and reset() replays the post-configure state bit-identically', () => {
    const opts: RenderOpts = { rpm: (k) => 1500 + k * 0.1, load: 0.6 };
    const a = makeSource([0, 180, 360, 540], 720, {}, 7);
    const first = render(a, 4, FS / 2, opts);
    a.reset();
    const again = render(a, 4, FS / 2, opts);
    const twin = render(makeSource([0, 180, 360, 540], 720, {}, 7), 4, FS / 2, opts);
    const other = render(makeSource([0, 180, 360, 540], 720, {}, 8), 4, FS / 2, opts);
    expect(again.ign).toEqual(first.ign);
    expect(twin.ign).toEqual(first.ign);
    expect(at(again.ex, 2)).toEqual(at(first.ex, 2));
    expect(at(twin.ex, 2)).toEqual(at(first.ex, 2));
    expect(other.ign).not.toEqual(first.ign);
  });
});

describe('CombustionSource: skipMask, cut type, pops (amendment B4)', () => {
  it('ignition cut: skipped firings emit no pulse and no impulse, and each counts one pop', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    expect(firings(cap.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) expect(allZero(at(cap.ex, i))).toBe(true);
    expect(src.takeIgnitionCutPops()).toBe(100);
    expect(src.takeIgnitionCutPops()).toBe(0); // consumed
    const resumed = render(src, 4, FS / 2, { rpm: 3000 });
    expect(firings(resumed.ign).length).toBe(50);
    expect(src.takeIgnitionCutPops()).toBe(0);
  });

  it('fuel cut (skipIsIgnition false): skipped firings emit no pulse, no impulse and no pops', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0xffff, ignitionCut: false });
    expect(firings(cap.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) expect(allZero(at(cap.ex, i))).toBe(true);
    expect(src.takeIgnitionCutPops()).toBe(0);
  });

  it('an alternating mask skips only the masked entries', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0b0101, ignitionCut: true });
    expect(allZero(at(cap.ex, 0))).toBe(true);
    expect(allZero(at(cap.ex, 2))).toBe(true);
    expect(pulses(undc(at(cap.ex, 1))).length).toBe(25);
    expect(pulses(undc(at(cap.ex, 3))).length).toBe(25);
    expect(firings(cap.ign).length).toBe(50);
    expect(src.takeIgnitionCutPops()).toBe(50);
  });

  it('samples the mask at the firing angle: a firing already made still blows down', () => {
    // one entry at 0° and 3000 rpm: ignition on tick 0, blowdown ≈ 140°/0.375° ≈ 373 ticks later
    const late = makeSource([0]);
    const capLate = render(late, 1, 1920, { rpm: 3000, mask: (k) => (k >= 10 && k < 600 ? 1 : 0), ignitionCut: true });
    expect(pulses(undc(at(capLate.ex, 0))).length).toBe(1);
    expect(late.takeIgnitionCutPops()).toBe(0);
    const onTime = makeSource([0]);
    const capOn = render(onTime, 1, 1920, { rpm: 3000, mask: (k) => (k === 0 ? 1 : 0), ignitionCut: true });
    expect(allZero(at(capOn.ex, 0))).toBe(true);
    expect(onTime.takeIgnitionCutPops()).toBe(1);
  });

  it('reset() clears skipMask, skipIsIgnition and the pop counter', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, 4800, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    src.skipMask = 0xffff;
    src.skipIsIgnition = true;
    src.reset();
    expect(src.skipMask).toBe(0);
    expect(src.skipIsIgnition).toBe(false);
    expect(src.takeIgnitionCutPops()).toBe(0);
    expect(src.crankDeg).toBe(0);
  });
});

describe('CombustionSource: intake gates', () => {
  /** Position of `crank` relative to the nominal window start, in [0, cycle). */
  function relTo(crank: number, start: number, cycle: number): number {
    return (((crank - start) % cycle) + cycle) % cycle;
  }

  it('4-stroke gate: 1 over angle + 360 + [−10, 230]° with 10° raised-cosine edges centred on the boundaries', () => {
    for (const angle of [0, 300]) {
      const cap = render(makeSource([angle]), 1, 3 * 1920, { rpm: 3000 }); // 3 cycles
      const g = at(cap.gate, 0);
      let sum = 0;
      for (let k = 0; k < g.length; k++) {
        const v = at(g, k);
        const r = relTo(at(cap.crank, k), angle + 350, 720);
        sum += v;
        if (r >= 5 && r < 235) expect(v).toBe(1);
        else if (r >= 245 && r < 715) expect(v).toBe(0);
        else {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        if (Math.abs(r - 0) < 1e-9 || Math.abs(r - 240) < 1e-9) expect(v).toBeCloseTo(0.5, 12);
      }
      expect(sum / g.length).toBeCloseTo(240 / 720, 3); // area = window length
    }
  });

  it('rotary gate: 1 over angle + [60, 300]°, independent of the skip mask', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const pulse: PulseOpts = { widthDeg: 300, evoOffsetDeg: 200 };
    const cap = render(makeSource(angles, 1080, pulse), 6, 2 * 2880, { rpm: 3000 });
    angles.forEach((angle, i) => {
      const g = at(cap.gate, i);
      let sum = 0;
      for (let k = 0; k < g.length; k++) {
        const r = relTo(at(cap.crank, k), angle + 60, 1080);
        sum += at(g, k);
        if (r >= 5 && r < 235) expect(at(g, k)).toBe(1);
        else if (r >= 245 && r < 1075) expect(at(g, k)).toBe(0);
      }
      expect(sum / g.length).toBeCloseTo(240 / 1080, 3);
    });
    const masked = render(makeSource(angles, 1080, pulse), 6, 2 * 2880, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    for (let i = 0; i < 6; i++) expect(at(masked.gate, i)).toEqual(at(cap.gate, i));
  });
});

describe('CombustionSource: rotary (cycleDeg 1080)', () => {
  it('fires each face once per 1080° (2 firings per e-shaft rev) with pulses up to 300° long', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const src = makeSource(angles, 1080, { widthDeg: 300, evoOffsetDeg: 200 });
    const revs = 30; // 3000 rpm → 0.375°/sample → 960 samples per rev
    const cap = render(src, 6, revs * 960, { rpm: 3000 });
    expect(firings(cap.ign).length).toBe(2 * revs);
    for (let i = 0; i < 6; i++) {
      const ps = pulses(undc(at(cap.ex, i)));
      expect(ps.length).toBeGreaterThanOrEqual(9); // 10 cycles; the last may be cut off by the render end
      for (const p of ps.slice(0, -1)) {
        expect(p.length).toBeGreaterThanOrEqual(780); // 300° / 0.375° = 800 samples (tail below eps)
        expect(p.length).toBeLessThanOrEqual(801);
      }
    }
  });

  it('clamps 4-stroke pulses to 180° but lets rotary pulses reach 300°', () => {
    const four = render(makeSource([0], 720, { widthDeg: 300 }), 1, 2 * 1920, { rpm: 3000 });
    for (const p of pulses(undc(at(four.ex, 0)))) expect(p.length).toBeLessThanOrEqual(481); // 180° / 0.375°
  });
});

describe('CombustionSource: robustness (RF2, RF3)', () => {
  it('RF2: rpm 0 from reset → no firings, no pulses, crank frozen; rpm 50 stays finite', () => {
    const src = makeSource([0, 180, 360, 540]);
    const stopped = render(src, 4, FS, { rpm: 0 });
    expect(src.crankDeg).toBe(0);
    expect(firings(stopped.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) {
      expect(allZero(at(stopped.ex, i))).toBe(true);
      expect(allFinite(at(stopped.gate, i))).toBe(true);
    }
    expect(src.takeIgnitionCutPops()).toBe(0);
    const slow = render(src, 4, 2.5 * FS, { rpm: 50 }); // 0.00625°/sample → 750° in 2.5 s
    expect(src.crankDeg).toBeCloseTo(750 - 720, 6);
    expect(firings(slow.ign).length).toBe(5); // 0, 180, 360, 540, 720 ≡ 0
    expect(allFinite(slow.ign)).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(allFinite(at(slow.ex, i))).toBe(true);
      expect(allFinite(at(slow.gate, i))).toBe(true);
    }
  });

  it('RF2: running → rpm 0 → crank frozen, no firings, outputs decay to 0 and stay finite; then 50 rpm', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, FS / 2, { rpm: 4000, load: 1 });
    const frozenAt = src.crankDeg;
    const hold = render(src, 4, FS / 2, { rpm: 0 });
    expect(src.crankDeg).toBe(frozenAt);
    expect(firings(hold.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) {
      const y = at(hold.ex, i);
      expect(allFinite(y)).toBe(true);
      expect(Math.abs(at(y, y.length - 1))).toBeLessThan(1e-9);
    }
    const resumed = render(src, 4, FS / 2, { rpm: 50 });
    for (let i = 0; i < 4; i++) expect(allFinite(at(resumed.ex, i))).toBe(true);
  });

  it('RF2: NaN / negative / ±Infinity rpm and NaN load or gain never produce NaN or Infinity', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, 4800, { rpm: 3000 });
    const crank = src.crankDeg;
    const badRpm = [Number.NaN, -500, Number.NEGATIVE_INFINITY];
    const bad = render(src, 4, 4800, { rpm: (k) => at(badRpm, k % 3), load: Number.NaN, gain: Number.NaN });
    expect(src.crankDeg).toBe(crank);
    expect(allFinite(bad.ign)).toBe(true);
    for (let i = 0; i < 4; i++) expect(allFinite(at(bad.ex, i))).toBe(true);
    const fast = render(src, 4, 4800, { rpm: Number.POSITIVE_INFINITY, load: Number.NaN, gain: 1 });
    expect(src.crankDeg).toBeCloseTo((crank + 4800 * RPM_CEIL * (6 / FS)) % 720, 6);
    expect(allFinite(fast.ign)).toBe(true);
    for (let i = 0; i < 4; i++) expect(allFinite(at(fast.ex, i))).toBe(true);
  });

  it('RF3: 12000 rpm on a 9000-redline V8 stays finite and keeps time-to-peak ≥ 4 samples', () => {
    const angles = [0, 90, 180, 270, 360, 450, 540, 630];
    const { spec, voicing } = makeEngine(angles, 720, { widthDeg: 40, alpha: 40, beta: 4 });
    spec.rpm.redline = 9000;
    spec.rpm.limiter.rpm = 9100;
    const src = new CombustionSource(FS);
    src.configure(spec, voicing, 1);
    // 12000 rpm → 1.5°/sample → a 40° pulse spans 26.7 samples; unclamped α_eff = 52 would peak ≈ 1.7 samples in
    const cap = render(src, 8, 2 * FS, { rpm: 12000, load: 1 });
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(amps.length).toBe(1600);
    expect(allFinite(cap.ign)).toBe(true);
    const maxAmp = Math.max(...amps);
    expect(maxAmp).toBeLessThanOrEqual(1.05 + 1e-12);
    for (let i = 0; i < 8; i++) {
      const y = at(cap.ex, i);
      expect(allFinite(y)).toBe(true);
      const ps = pulses(undc(y));
      expect(ps.length).toBeGreaterThanOrEqual(199);
      for (const p of ps) {
        expect(p.peakIndex - p.start).toBeGreaterThanOrEqual(4);
        expect(p.peak).toBeLessThanOrEqual(maxAmp + 1e-9);
      }
    }
  });
});
```

How the tests see the raw pulses:
- `undc()` inverts the per-entry DC blocker exactly: `x[n] = x[n−1] + (y[n] − R·y[n−1])/g`. Onset, peak, width and time-to-peak are then measured on the recovered pre-blocker pulse train instead of the high-passed output.
- **RF2** is covered by the three robustness tests: rpm 0 from reset; running → 0 → 50 rpm; and NaN/negative/±∞ rpm with NaN load or gain.
- **RF3** checks 12000 rpm on a copy of the engine with redline 9000. A 40° pulse at 1.5°/sample is 26.7 samples long. The unclamped α_eff = 52 would peak ≈ 1.7 samples in; the clamp makes it 5–6 samples, and the test asserts ≥ 4.

- [ ] **Step 6: Run the tests and confirm the new ones fail**

Run: `npx vitest run tests/unit/dsp-combustion.test.ts`
Expected: FAIL, `Tests  24 failed | 5 passed (29)`.
- 23 failures report `TypeError: CombustionSource is not a constructor`.
- `rejects bad sample rates and combustion counts outside 1–16` reports `AssertionError: expected error to be instance of RangeError`, because the thrown error is that TypeError.
- The five helper tests still pass.

- [ ] **Step 7: Implement CombustionSource**

Replace the entire contents of `src/dsp/combustion.ts` with the following. The Step 3 helpers are unchanged inside it.

```ts
/**
 * CombustionSource — crank clock, firing scheduler, blowdown pulse voices, intake gates and
 * ignition impulses (spec §5.1, §5.3.1–5.3.2; phase2a contract "Combustion rules" + amendment B4).
 *
 * Clock convention: each `tick` advances the crank by d = rpm·6/fs degrees and every output of
 * that tick is the value at the END of the advance. An event at crank angle `a` belongs to the
 * tick whose advance covers it, half-open: a ∈ [prev, prev + d) (mod cycleDeg). An event that
 * happened `over` degrees before the end of the tick starts its pulse already `over` degrees in
 * (sub-sample onset, no timing quantisation).
 *
 * Pulse shape (contract): E(φ) = (1 − e^(−αφ))²·e^(−βφ)·taper(φ), φ ∈ [0, 1] over widthDeg crank
 * degrees, taper = cos² fade over the last 25 %, normalised so its peak is the firing amplitude.
 *
 * `tick` is a hot path (spec §4.4): no allocation; all state is capacity-sized in the constructor.
 */
import { MAX_COMBUSTION } from '../contracts';
import type { EngineSpec, EngineVoicing } from '../contracts';
import { clamp, flush, Rng } from './util';

/** Per-entry DC blocker corner (first-order high-pass: zero at DC, pole e^(−2π·10/fs)), Hz. */
export const DC_BLOCK_HZ = 10;
/** Lower bound for the onset sharpness α (also the α returned when the clamp is unattainable). */
export const ALPHA_FLOOR = 1e-3;
/** Crank-clock ceiling: rpm above this (or +Infinity) is treated as this. */
export const RPM_CEIL = 30000;
/**
 * Rotary only (spec §5.1 "per-face small amplitude variation yields the rotary's ⅓-order
 * texture"): fixed per-face amplitude scale 1 + depth·cos(2π·angle/1080), a smooth once-per-1080°
 * pattern → sidebands at ±⅓ e-shaft order around every firing harmonic (≈ −26 dB).
 */
export const ROTARY_FACE_DEPTH = 0.1;

const BETA_FLOOR = 1e-3;
/** Minimum blowdown time-to-peak in samples (contract α clamp). */
const MIN_PEAK_SAMPLES = 4;
/** Per-cycle humanisation (contract): timing ±1° crank, amplitude ±5 %, both uniform. */
const TIMING_JITTER_DEG = 1;
const AMP_JITTER = 0.05;
/** Pulse width clamps (voicing ranges: 40–90° 4-stroke, ≤ 300° rotary); keeps an entry's pulses from overlapping. */
const MIN_WIDTH_DEG = 10;
const MAX_WIDTH_DEG_4S = 180;
const MAX_WIDTH_DEG_ROTARY = 300;
/** Nominal intake windows: 4-stroke angle + 360 + [−10, 230]°, rotary angle + [60, 300]° (both 240° long). */
const INTAKE_START_4S_DEG = 350;
const INTAKE_START_ROTARY_DEG = 60;
const INTAKE_LEN_DEG = 240;
/** Raised-cosine edge width, centred on each nominal window boundary, degrees. */
const INTAKE_EDGE_DEG = 10;

const TAPER_START = 0.75;
const HALF_PI = Math.PI / 2;
const INV_GOLDEN = (Math.sqrt(5) - 1) / 2;

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** x wrapped into [0, cycle). */
function wrapDeg(x: number, cycle: number): number {
  let r = x % cycle;
  if (r < 0) r += cycle;
  return r >= cycle ? 0 : r;
}

/** Un-normalised pulse E(φ); 0 outside the open interval (0, 1) and for NaN. */
export function pulseShape(phi: number, alpha: number, beta: number): number {
  if (!(phi > 0) || phi >= 1) return 0;
  const rise = -Math.expm1(-alpha * phi); // 1 − e^(−αφ), accurate for small αφ
  let e = rise * rise * Math.exp(-beta * phi);
  if (phi > TAPER_START) {
    const c = Math.cos((HALF_PI * (phi - TAPER_START)) / (1 - TAPER_START));
    e *= c * c;
  }
  return e;
}

/**
 * max over φ ∈ (0, 1) of pulseShape(φ, α, β). ln E is a sum of concave terms on (0, 1), so E is
 * unimodal. The untapered peak is φ* = ln(1 + 2α/β)/α; when φ* ≤ 0.75 the taper is 1 there and
 * the peak is exact, otherwise the maximum lies in [0.75, 1) and is found by golden-section search.
 */
export function pulsePeak(alpha: number, beta: number): number {
  const phiStar = Math.log1p((2 * alpha) / beta) / alpha;
  if (phiStar <= TAPER_START) return pulseShape(phiStar, alpha, beta);
  let a = TAPER_START;
  let b = 1;
  let c = b - INV_GOLDEN * (b - a);
  let d = a + INV_GOLDEN * (b - a);
  let fc = pulseShape(c, alpha, beta);
  let fd = pulseShape(d, alpha, beta);
  for (let k = 0; k < 48; k++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - INV_GOLDEN * (b - a);
      fc = pulseShape(c, alpha, beta);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + INV_GOLDEN * (b - a);
      fd = pulseShape(d, alpha, beta);
    }
  }
  return fc > fd ? fc : fd;
}

/** Contract time-to-peak as a fraction of the pulse width: ln((α + β)/β)/α (strictly decreasing in α, → 1/β as α → 0). */
export function peakFraction(alpha: number, beta: number): number {
  return Math.log1p(alpha / beta) / alpha;
}

/**
 * Contract α clamp: the largest α' ≤ alpha with peakFraction(α', β) ≥ minFrac, where
 * minFrac = MIN_PEAK_SAMPLES / widthSamples = MIN_PEAK_SAMPLES·(rpm·6/fs)/widthDeg (no division by
 * rpm, so rpm = 0 gives minFrac = 0 and no clamp). Returns alpha unchanged when it already
 * satisfies the bound; returns ALPHA_FLOOR when even ALPHA_FLOOR cannot (bound unattainable).
 */
export function clampAlpha(alpha: number, beta: number, minFrac: number): number {
  if (!(minFrac > 0) || peakFraction(alpha, beta) >= minFrac) return alpha;
  if (alpha <= ALPHA_FLOOR || peakFraction(ALPHA_FLOOR, beta) < minFrac) return ALPHA_FLOOR;
  let lo = ALPHA_FLOOR; // satisfies the bound
  let hi = alpha; // violates it
  for (let k = 0; k < 48; k++) {
    const mid = 0.5 * (lo + hi);
    if (peakFraction(mid, beta) >= minFrac) lo = mid;
    else hi = mid;
  }
  return lo;
}

export class CombustionSource {
  /** Set by DspCore before every tick. Bit i set at entry i's firing angle ⇒ that firing is skipped (no blowdown, no ignition impulse). */
  skipMask = 0;
  /** Amendment B4: set by DspCore next to skipMask; skipped firings while true are counted for takeIgnitionCutPops(). */
  skipIsIgnition = false;

  private readonly degPerRpm: number;
  private readonly dcR: number;
  private readonly dcG: number;
  private readonly rng = new Rng(1);

  // Per-entry state, capacity MAX_COMBUSTION.
  private readonly angle = new Float64Array(MAX_COMBUSTION);
  private readonly gateOrigin = new Float64Array(MAX_COMBUSTION);
  private readonly faceScale = new Float64Array(MAX_COMBUSTION);
  private readonly parity = new Uint8Array(MAX_COMBUSTION);
  private readonly pendOn = new Uint8Array(MAX_COMBUSTION);
  private readonly pendRem = new Float64Array(MAX_COMBUSTION);
  private readonly pendAmp = new Float64Array(MAX_COMBUSTION);
  private readonly pendLoad = new Float64Array(MAX_COMBUSTION);
  private readonly voiceOn = new Uint8Array(MAX_COMBUSTION);
  private readonly voiceProg = new Float64Array(MAX_COMBUSTION);
  private readonly voiceAlpha = new Float64Array(MAX_COMBUSTION);
  private readonly voiceNorm = new Float64Array(MAX_COMBUSTION);
  private readonly dcX1 = new Float64Array(MAX_COMBUSTION);
  private readonly dcY1 = new Float64Array(MAX_COMBUSTION);

  private n = 0;
  private cycle = 720;
  private width = 60;
  private invWidth = 1 / 60;
  private alpha = 9;
  private beta = 4;
  private evo = 140;
  private asymEven = 1;
  private asymOdd = 1;
  private seedValue = 1;
  private crank = 0;
  private pops = 0;
  private cachedAlpha = Number.NaN;
  private cachedPeak = 1;

  constructor(fs: number) {
    if (!(fs >= 8000) || !Number.isFinite(fs)) {
      throw new RangeError(`CombustionSource: sample rate must be a finite number ≥ 8000, got ${fs}`);
    }
    this.degPerRpm = 6 / fs;
    this.dcR = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) / fs);
    this.dcG = (1 + this.dcR) / 2; // unity gain at Nyquist
  }

  /** Crank (4-stroke) or e-shaft (rotary) angle in [0, cycleDeg) at the end of the last tick. */
  get crankDeg(): number {
    return this.crank;
  }

  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    const n = spec.combustion.length;
    if (n < 1 || n > MAX_COMBUSTION) {
      throw new RangeError(`CombustionSource: ${n} combustion entries (supported 1–${MAX_COMBUSTION})`);
    }
    const cycle = spec.cycleDeg === 1080 ? 1080 : 720;
    const rotary = cycle === 1080;
    const p = voicing.pulse;
    this.n = n;
    this.cycle = cycle;
    this.width = clamp(finiteOr(p.widthDeg, 60), MIN_WIDTH_DEG, rotary ? MAX_WIDTH_DEG_ROTARY : MAX_WIDTH_DEG_4S);
    this.invWidth = 1 / this.width;
    this.alpha = Math.max(ALPHA_FLOOR, finiteOr(p.alpha, 9));
    this.beta = Math.max(BETA_FLOOR, finiteOr(p.beta, 4));
    this.evo = clamp(finiteOr(p.evoOffsetDeg, 140), 0, cycle / 2);
    const asym = clamp(finiteOr(p.cycleAsymmetry, 0), 0, 1);
    this.asymEven = 1 - 0.5 * asym;
    this.asymOdd = 1 + 0.5 * asym;
    const gateStart = rotary ? INTAKE_START_ROTARY_DEG : INTAKE_START_4S_DEG;
    for (let i = 0; i < MAX_COMBUSTION; i++) {
      const entry = spec.combustion[i];
      const a = entry === undefined ? 0 : wrapDeg(finiteOr(entry.angleDeg, 0), cycle);
      this.angle[i] = a;
      this.gateOrigin[i] = wrapDeg(a + gateStart - INTAKE_EDGE_DEG / 2, cycle);
      this.faceScale[i] = rotary ? 1 + ROTARY_FACE_DEPTH * Math.cos((2 * Math.PI * a) / cycle) : 1;
    }
    this.seedValue = finiteOr(seed, 1);
    this.reset();
  }

  /** Back to the post-configure state: crank 0, no voices, RNG re-seeded (bit-identical replay). */
  reset(): void {
    this.crank = 0;
    this.pops = 0;
    this.skipMask = 0;
    this.skipIsIgnition = false;
    this.parity.fill(0);
    this.pendOn.fill(0);
    this.pendRem.fill(0);
    this.pendAmp.fill(0);
    this.pendLoad.fill(0);
    this.voiceOn.fill(0);
    this.voiceProg.fill(0);
    this.voiceAlpha.fill(0);
    this.voiceNorm.fill(0);
    this.dcX1.fill(0);
    this.dcY1.fill(0);
    this.cachedAlpha = Number.NaN;
    this.cachedPeak = 1;
    this.rng.seed(this.seedValue);
  }

  /** Skipped firings (while skipIsIgnition) since the last call; resets the count. */
  takeIgnitionCutPops(): number {
    const p = this.pops;
    this.pops = 0;
    return p;
  }

  tick(rpm: number, load: number, combustionGain: number, exhaustOut: Float64Array, intakeGate: Float64Array): number {
    // NaN / negative rpm → stopped; +Infinity → RPM_CEIL. NaN load / gain → 0.
    const r = rpm > 0 ? (rpm < RPM_CEIL ? rpm : RPM_CEIL) : 0;
    const d = r * this.degPerRpm;
    const ld = load > 0 ? (load < 1 ? load : 1) : 0;
    const gain = combustionGain > 0 ? (combustionGain < 1 ? combustionGain : 1) : 0;
    const cycle = this.cycle;
    const width = this.width;
    const prev = this.crank;
    let crank = prev + d;
    if (crank >= cycle) crank -= cycle;
    this.crank = crank;
    const minFrac = MIN_PEAK_SAMPLES * d * this.invWidth;
    const mask = this.skipMask;
    const n = this.n;
    let ignition = 0;

    for (let i = 0; i < n; i++) {
      // 1. advance the running blowdown voice
      if (this.voiceOn[i] === 1) {
        const prog = (this.voiceProg[i] ?? 0) + d;
        if (prog < width) this.voiceProg[i] = prog;
        else this.voiceOn[i] = 0;
      }
      // 2. pending blowdown (scheduled at the firing) starts once the crank passes it
      if (this.pendOn[i] === 1) {
        const rem = (this.pendRem[i] ?? 0) - d;
        if (rem < 0) {
          this.pendOn[i] = 0;
          this.startVoice(i, -rem, minFrac);
        } else {
          this.pendRem[i] = rem;
        }
      }
      // 3. firing (ignition) at angleDeg_i
      let rel = (this.angle[i] ?? 0) - prev;
      if (rel < 0) rel += cycle;
      if (rel < d) {
        const over = d - rel;
        const timing = TIMING_JITTER_DEG * this.rng.bipolar();
        const jitter = 1 + AMP_JITTER * this.rng.bipolar();
        const odd = this.parity[i] === 1;
        this.parity[i] = odd ? 0 : 1;
        if (((mask >>> i) & 1) === 1) {
          if (this.skipIsIgnition) this.pops++;
        } else {
          const level = 0.15 + 0.85 * Math.pow(ld, 0.7);
          const amp = level * jitter * (odd ? this.asymOdd : this.asymEven) * (this.faceScale[i] ?? 1) * gain;
          ignition += amp;
          this.pendAmp[i] = amp;
          this.pendLoad[i] = ld;
          const rem = this.evo + timing - over;
          if (rem < 0) {
            this.startVoice(i, -rem, minFrac);
          } else {
            this.pendOn[i] = 1;
            this.pendRem[i] = rem;
          }
        }
      }
      // 4. pulse sample → per-entry DC blocker y = g·(x − x₁) + R·y₁
      let x = 0;
      if (this.voiceOn[i] === 1) {
        x = (this.voiceNorm[i] ?? 0) * pulseShape((this.voiceProg[i] ?? 0) * this.invWidth, this.voiceAlpha[i] ?? 1, this.beta);
      }
      const y = flush(this.dcG * (x - (this.dcX1[i] ?? 0)) + this.dcR * (this.dcY1[i] ?? 0));
      this.dcX1[i] = x;
      this.dcY1[i] = y;
      exhaustOut[i] = y;
      // 5. intake gate: raised-cosine edges centred on the nominal window boundaries
      let s = crank - (this.gateOrigin[i] ?? 0);
      if (s < 0) s += cycle;
      let g = 0;
      if (s < INTAKE_EDGE_DEG) g = 0.5 - 0.5 * Math.cos((Math.PI * s) / INTAKE_EDGE_DEG);
      else if (s < INTAKE_LEN_DEG) g = 1;
      else if (s < INTAKE_LEN_DEG + INTAKE_EDGE_DEG) g = 0.5 + 0.5 * Math.cos((Math.PI * (s - INTAKE_LEN_DEG)) / INTAKE_EDGE_DEG);
      intakeGate[i] = g;
    }
    for (let i = n; i < MAX_COMBUSTION; i++) {
      exhaustOut[i] = 0;
      intakeGate[i] = 0;
    }
    return ignition;
  }

  /** Starts entry i's blowdown voice `progressDeg` crank degrees in, with the firing's stored amplitude and load. */
  private startVoice(i: number, progressDeg: number, minFrac: number): void {
    if (progressDeg >= this.width) return; // whole pulse inside one tick: nothing to sample
    const alpha = clampAlpha(this.alpha * (0.7 + 0.6 * (this.pendLoad[i] ?? 0)), this.beta, minFrac);
    let peak = this.cachedPeak;
    if (alpha !== this.cachedAlpha) {
      peak = pulsePeak(alpha, this.beta);
      this.cachedAlpha = alpha;
      this.cachedPeak = peak;
    }
    this.voiceOn[i] = 1;
    this.voiceProg[i] = progressDeg;
    this.voiceAlpha[i] = alpha;
    this.voiceNorm[i] = peak > 0 ? (this.pendAmp[i] ?? 0) / peak : 0;
  }
}
```

Design notes:
- **Scheduler.**
  - `rel = angle − prev (+ cycleDeg if negative)` is in [0, cycleDeg), and an entry fires when `rel < d`. This uses no `%` in the hot loop and is exactly consistent with `crankDeg`. With `d = 0` nothing can fire.
  - At the firing, the blowdown is scheduled as a countdown of `evo + jitter − over` crank degrees.
  - A voice's progress is kept in crank degrees, so pulse length tracks rpm changes.
  - Width ≤ 180°/300° and evo ≤ cycleDeg/2 guarantee an entry never has two overlapping voices or two pending blowdowns.
- **Per-voice work.** The α clamp and `pulsePeak` run once per voice start, not per sample, with a 1-entry cache for the common case of an unchanged α (contract: "precompute peak per α,β").
- **Measured on the sandbox (Node 24, fs 48 kHz).**
  - `tick` for an 8-entry V8 runs ≈ 85–90× realtime on its own (≈ 25 ns per entry per sample).
  - GC under amendment B2 is ≈ 6 ms per 100 s of audio, max pause 0.4 ms. The cause is the boxed double return of the scalar API, which B2 accepts.
- **Source-level spectra checked while authoring.**
  - Even-fire I4/I6 odd half orders are ≤ −38 dB re firing order at 2k/4k/6k rpm.
  - The rotary ⅓-order line is −16 dB and the 5/3 and 7/3 sidebands are ≈ −25 dB re order 2. This is the input that invariants 2 and 3 of T9 build on.

- [ ] **Step 8: Run the tests and confirm they all pass**

Run: `npx vitest run tests/unit/dsp-combustion.test.ts`
Expected: PASS, `Tests  29 passed (29)` (≈ 2 s).

- [ ] **Step 9: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.
- If files belonging to other in-progress tasks fail lint, confirm that this task's files are clean with `npx eslint src/dsp/combustion.ts tests/unit/dsp-combustion.test.ts`.
- `Hot path must not allocate` must not appear for `combustion.ts`. If it is reported at the `tick(` line itself, T10's selector lacks amendment B1's `> FunctionExpression > BlockStatement`.

---

### Task 5: RpmState: DSP-side rpm tracking, shift trajectory, limiter bounce and cut decisions (`src/dsp/rpm-state.ts`)

**Files:**
- Create: `src/dsp/rpm-state.ts`
- Test: `tests/unit/dsp-rpm-state.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED):
    - `type DspControl`: reads `rpm`, `limiter`, and `shift: ShiftState` (`active`, `fromRpm`, `toRpm`, `t0`, `durationS`).
    - `type EngineSpec`: reads `rpm.redline`, `rpm.limiter.type`, `rpm.limiter.rpm`, `rpm.limiter.hysteresisRpm`, `gearbox.type`.
    - The tests also use `GearboxType` and `LimiterType`.
  - `src/dsp/util.ts` (T1): `class OnePole { setTau(tauS: number, fs: number): void; process(x: number): number; reset(v?: number): void; readonly y: number }`.
- Produces (contract API, exact):
  - `export class RpmState { constructor(fs: number); configure(spec: EngineSpec): void; tick(ctl: DspControl, nowS: number): void; readonly rpm: number; readonly cut: boolean; readonly cutIsIgnition: boolean; readonly falling: boolean; reset(rpm?: number): void }`
  - Extra exports: `shiftTrajectoryRpm(u: number, fromRpm: number, toRpm: number): number` (the pure contract curve, usable by T10 segment scripts and tests). Constants: `TRACK_TAU_S = 0.04`, `LIMITER_HALF_PERIOD_S = 0.05`, `SHIFT_HOLD_END = 0.3`, `SHIFT_CUT_END = 0.4`.
  - Behaviour that T9 (DspCore) relies on:
    - **Priority per sample:** shift trajectory, then limiter bounce, then tracking. `constructor` throws `RangeError` unless `fs` is finite and ≥ 8000. `tick` never throws and never allocates.
    - **Shift trajectory.** It is active while `ctl.shift.active && durationS > 0` and `u = (nowS − t0)/durationS < 1`.
      - u < 0 (t0 in the future) holds `fromRpm`.
      - rpm is `shiftTrajectoryRpm(u, fromRpm, toRpm)`.
      - `cut = u < 0.4`, and `cutIsIgnition = cut && gearbox.type ∈ {dct, pdk, amt}`. This applies to up- and downshifts alike, as the contract says.
      - On leaving the trajectory: if it completed ((nowS − t0)/durationS ≥ 1, whether `active` is still set or not), tracking resumes from exactly `toRpm`. An aborted shift (`active` cleared earlier) resumes from the last trajectory rpm, with no jump.
      - `durationS ≤ 0` disables the trajectory.
    - **Limiter bounce.** It runs while `ctl.limiter` and no trajectory is active. `ctl.rpm` is ignored meanwhile.
      - `h = clamp(hysteresisRpm, 1, 0.5·limiter.rpm)` and `rate = h / 0.05 s`.
      - On entry, rpm ≥ `limiter.rpm` starts the cut phase; otherwise the fire phase.
      - Cut phase: rpm falls at `rate` to `limiter.rpm − h`, with `cut = true`.
      - Fire phase: rpm rises at `rate` back to `limiter.rpm`, with `cut = false`. When rpm is still below `limiter.rpm − h` it rises at least as fast as the τ = 40 ms tracking would.
      - The period is therefore 100 ms: 10 cut→fire transitions/s, 50 ms cuts.
      - Amendment B5: `cut` is true for the whole cut phase for **every** limiter type, and `cutIsIgnition = cut && limiter.type ∈ {ignition-hard, ignition-soft}`. This equals B5's `type.startsWith('ignition')` rule.
      - On release, tracking resumes from the current rpm.
      - A non-positive or non-finite `limiter.rpm` falls back to `redline` (or 7000).
    - **Tracking.** A one-pole with τ = 40 ms toward `ctl.rpm`. A NaN target holds; negative targets go to 0; values above 30000 (including +∞) go to 30000. `cut` and `cutIsIgnition` are false.
    - **`falling`.** `rpm < rpm(20 ms ago) − 0.5`, from a ring of round(0.02·fs) samples. During a limiter cut phase it turns true ≈ 10 ms in, because the look-back first straddles the preceding rise.
    - **Reset and configure.** `reset(rpm = 0)` sets rpm immediately (NaN → 0), fills the history, and clears cut, falling, shift and limiter state. `configure()` reads the spec and ends with `reset(0)`.

**Cross-task premises:** (open each named file and confirm before coding)
- **`src/dsp/util.ts` (T1)** exports `OnePole` with the contract surface.
  - `setTau(τ, fs)` gives a step response of ≈ 63.2 % after τ. T1 uses `k = 1 − e^(−1/(τ·fs))`; the test tolerances also accept `k = 1/(τ·fs)`.
  - `process(x)` performs `y += k·(x − y)` and returns the new `y`.
  - `reset(v)` sets the state to exactly `v`, and the getter `y` returns the state.
- **`src/contracts.ts`:** `DspControl`, `ShiftState`, `EngineSpec`, `GearboxType` and `LimiterType` are exactly as in the file. The test literals `makeSpec()` and `makeCtl()` must list every required field; add any new one.
- **Phase 0 tooling (Phase 0 T1):** Vitest runs `tests/unit/**/*.test.ts` in node. The tsconfig has `strict` and `noUncheckedIndexedAccess`. ESLint is recommended + typescript-eslint recommended. T10 adds the amendment-B1 hot-path rule; `tick` uses no allocation syntax, and the only template literal is in the constructor.
- **T9 (DspCore): contract-only expectations, no code dependency.**
  - T9 calls `tick(ctl, nowS)` once per sample, with `nowS` = quantum start + i/fs. This is the same clock as `ctl.shift.t0`.
  - T9 maps `cut` to `CombustionSource.skipMask`: all bits for shift cuts and `*-hard` limiter cuts, alternating bits for `*-soft` limiter cuts (B5). It sets `CombustionSource.skipIsIgnition` from `cutIsIgnition`, which already encodes both B5 rules.
  - T9 feeds `falling` to `OverrunLayer.tick` and calls `reset(rpm)` on non-finite recovery.
  - With `ctl.shift.active` and `ctl.limiter` both true, RpmState follows the shift. T9 should therefore pick the shift-cut mask while `ctl.shift.active`.

- [ ] **Step 1: Write the failing test for the shift-trajectory curve**

Create `tests/unit/dsp-rpm-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SHIFT_CUT_END, SHIFT_HOLD_END, shiftTrajectoryRpm } from '../../src/dsp/rpm-state';

describe('shiftTrajectoryRpm', () => {
  it('holds fromRpm until u = 0.3, cosine-eases to toRpm by u = 1, then stays there', () => {
    expect(SHIFT_HOLD_END).toBe(0.3);
    expect(SHIFT_CUT_END).toBe(0.4);
    for (const u of [Number.NaN, -0.5, 0, 0.1, 0.3]) expect(shiftTrajectoryRpm(u, 6500, 4200)).toBe(6500);
    expect(shiftTrajectoryRpm(0.65, 6500, 4200)).toBeCloseTo(5350, 9); // midpoint of the ease
    expect(shiftTrajectoryRpm(1, 6500, 4200)).toBe(4200);
    expect(shiftTrajectoryRpm(3, 6500, 4200)).toBe(4200);
    let prev = 6500;
    for (let u = 0.3; u <= 1; u += 0.001) {
      const r = shiftTrajectoryRpm(u, 6500, 4200);
      expect(r).toBeLessThanOrEqual(prev + 1e-9); // monotone for an upshift
      prev = r;
    }
    // C¹ at both ends of the ease (zero slope): a 1e-4 step in u moves rpm by < 0.01
    expect(Math.abs(shiftTrajectoryRpm(0.3001, 6500, 4200) - 6500)).toBeLessThan(0.01);
    expect(Math.abs(shiftTrajectoryRpm(0.9999, 6500, 4200) - 4200)).toBeLessThan(0.01);
    // downshift (rev-match blip) rises
    expect(shiftTrajectoryRpm(0.65, 3000, 5000)).toBeCloseTo(4000, 9);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/dsp-rpm-state.test.ts`
Expected: FAIL. The suite does not load and shows `Error: Cannot find module '../../src/dsp/rpm-state' imported from …/tests/unit/dsp-rpm-state.test.ts` and `Tests  no tests`.

- [ ] **Step 3: Implement the shift-trajectory curve**

Create `src/dsp/rpm-state.ts`. Step 7 replaces the whole file and keeps this function verbatim.

```ts
/**
 * RpmState — shift-trajectory helper (Task 5, step 3). The RpmState class is added in step 7,
 * which replaces this whole file.
 */
/** Shift trajectory breakpoints in u: hold fromRpm until 0.3, combustion cut until 0.4 (contract). */
export const SHIFT_HOLD_END = 0.3;
export const SHIFT_CUT_END = 0.4;

/** Shift trajectory (contract): fromRpm for u ≤ 0.3 (and NaN), cosine ease to toRpm over [0.3, 1], toRpm for u ≥ 1. */
export function shiftTrajectoryRpm(u: number, fromRpm: number, toRpm: number): number {
  if (!(u > SHIFT_HOLD_END)) return fromRpm;
  if (u >= 1) return toRpm;
  const e = 0.5 - 0.5 * Math.cos((Math.PI * (u - SHIFT_HOLD_END)) / (1 - SHIFT_HOLD_END));
  return fromRpm + (toRpm - fromRpm) * e;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/dsp-rpm-state.test.ts`
Expected: PASS, `Tests  1 passed (1)`.

- [ ] **Step 5: Write the failing RpmState tests, including the limiter 8–20 Hz test**

Make two edits to `tests/unit/dsp-rpm-state.test.ts`. The `describe('shiftTrajectoryRpm', …)` block from Step 1 stays unchanged between them.

(a) Replace the two `import` lines at the top of the file (everything above `describe('shiftTrajectoryRpm'`) with this block of imports and shared helpers. Keep one blank line before the `describe`:

```ts
import { describe, expect, it } from 'vitest';
import type { DspControl, EngineSpec, GearboxType, LimiterType } from '../../src/contracts';
import { RpmState, SHIFT_CUT_END, SHIFT_HOLD_END, shiftTrajectoryRpm } from '../../src/dsp/rpm-state';

const FS = 48000;
const DT = 1 / FS;

interface SpecOpts {
  gearbox?: GearboxType;
  limiter?: LimiterType;
  limiterRpm?: number;
  hysteresisRpm?: number;
}

function makeSpec(o: SpecOpts = {}): EngineSpec {
  const gearbox = o.gearbox ?? 'dct';
  return {
    layout: { type: 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2 },
    cycleDeg: 720,
    combustion: [
      { angleDeg: 0, bank: 0 },
      { angleDeg: 180, bank: 0 },
      { angleDeg: 360, bank: 0 },
      { angleDeg: 540, bank: 0 },
    ],
    rpm: {
      idle: 850,
      redline: 7000,
      limiter: { type: o.limiter ?? 'ignition-hard', rpm: o.limiterRpm ?? 7100, hysteresisRpm: o.hysteresisRpm ?? 150 },
    },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: {
      type: gearbox,
      overallRatios: [13.1, 8.4, 6.1, 4.8, 4.0, 3.4],
      drivenTyre: '225/40R18',
      shiftTimeS: 0.1,
      tc: gearbox === 'tc-auto' ? { stallRpmWot: 2400, lockupTurbineRpm: 1500, couplingSR: 0.9 } : null,
    },
    sources: { layout: ['test'], combustion: ['test'], rpm: ['test'], aspiration: ['test'], gearbox: ['test'] },
  };
}

function makeCtl(rpm: number): DspControl {
  return {
    rpm,
    load: 0.5,
    gear: 3,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0.1 },
    ignitionOn: true,
    runTimeS: 10,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
  };
}

function makeState(o: SpecOpts = {}, rpm = 0): RpmState {
  const s = new RpmState(FS);
  s.configure(makeSpec(o));
  s.reset(rpm);
  return s;
}

interface Trace {
  rpm: Float64Array;
  cut: Uint8Array;
  cutIgn: Uint8Array;
  falling: Uint8Array;
}

/** Ticks `samples` times starting at time t0S, recording every output. */
function run(s: RpmState, ctl: DspControl, samples: number, t0S = 0): Trace {
  const tr: Trace = {
    rpm: new Float64Array(samples),
    cut: new Uint8Array(samples),
    cutIgn: new Uint8Array(samples),
    falling: new Uint8Array(samples),
  };
  for (let k = 0; k < samples; k++) {
    s.tick(ctl, t0S + k * DT);
    tr.rpm[k] = s.rpm;
    tr.cut[k] = s.cut ? 1 : 0;
    tr.cutIgn[k] = s.cutIsIgnition ? 1 : 0;
    tr.falling[k] = s.falling ? 1 : 0;
  }
  return tr;
}

function at(xs: ArrayLike<number>, i: number): number {
  const v = xs[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${xs.length})`);
  return v;
}

/** Cut→fire transitions and the longest continuous cut (in samples) of a cut trace. */
function cutStats(cut: Uint8Array): { transitions: number; longest: number } {
  let transitions = 0;
  let longest = 0;
  let runLen = 0;
  for (let k = 0; k < cut.length; k++) {
    if (at(cut, k) === 1) {
      runLen++;
      longest = Math.max(longest, runLen);
    } else {
      if (runLen > 0) transitions++;
      runLen = 0;
    }
  }
  return { transitions, longest };
}
```

(b) Append this to the end of the file, after one blank line:

```ts
describe('RpmState: tracking', () => {
  it('rejects bad sample rates', () => {
    expect(() => new RpmState(0)).toThrow(RangeError);
    expect(() => new RpmState(Number.NaN)).toThrow(RangeError);
  });

  it('reset(rpm) sets rpm immediately; configure() resets to 0', () => {
    const s = makeState({}, 1234);
    expect(s.rpm).toBe(1234);
    expect(s.cut).toBe(false);
    expect(s.cutIsIgnition).toBe(false);
    expect(s.falling).toBe(false);
    s.configure(makeSpec());
    expect(s.rpm).toBe(0);
    s.reset();
    expect(s.rpm).toBe(0);
    s.reset(Number.NaN);
    expect(s.rpm).toBe(0);
  });

  it('follows ctl.rpm through a one-pole with τ = 40 ms across successive steps', () => {
    const s = makeState({}, 1000);
    const ctl = makeCtl(2000);
    const a = run(s, ctl, Math.round(0.04 * FS));
    expect(at(a.rpm, a.rpm.length - 1)).toBeCloseTo(1000 + 1000 * (1 - Math.exp(-1)), 0); // ≈ 1632
    run(s, ctl, Math.round(0.36 * FS));
    expect(Math.abs(s.rpm - 2000)).toBeLessThan(0.2); // 10 τ
    ctl.rpm = 1500;
    const b = run(s, ctl, Math.round(0.04 * FS));
    expect(at(b.rpm, b.rpm.length - 1)).toBeCloseTo(2000 - 500 * (1 - Math.exp(-1)), 0); // ≈ 1684
    for (let k = 0; k < b.cut.length; k++) expect(at(b.cut, k)).toBe(0);
  });

  it('holds on a NaN target, floors negative targets at 0 and caps +Infinity', () => {
    const s = makeState({}, 3000);
    run(s, makeCtl(Number.NaN), 4800);
    expect(s.rpm).toBe(3000);
    run(s, makeCtl(-500), FS);
    expect(s.rpm).toBeGreaterThanOrEqual(0);
    expect(s.rpm).toBeLessThan(1e-6);
    run(s, makeCtl(Number.POSITIVE_INFINITY), FS);
    expect(Number.isFinite(s.rpm)).toBe(true);
    expect(s.rpm).toBeLessThanOrEqual(30000);
  });
});

describe('RpmState: shift trajectory', () => {
  const cases: [GearboxType, boolean][] = [
    ['dct', true],
    ['pdk', true],
    ['amt', true],
    ['manual', false],
    ['tc-auto', false],
  ];
  for (const [gearbox, fart] of cases) {
    it(`${gearbox}: holds, cuts for u < 0.4 (ignition cut: ${fart}), eases, then tracks from toRpm`, () => {
      const s = makeState({ gearbox }, 6500);
      const ctl = makeCtl(4300);
      const t0 = 1;
      const dur = 0.1;
      ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0, durationS: dur };
      const n = Math.round(dur * FS); // 4800 samples, u = k / 4800
      const tr = run(s, ctl, n, t0);
      let wrong = 0;
      for (let k = 0; k < n; k++) {
        const u = k / n;
        if (Math.abs(at(tr.rpm, k) - shiftTrajectoryRpm(u, 6500, 4200)) > 1e-6) wrong++;
        if (k === 1920) continue; // u = 0.4 exactly: the cut flag may flip on a 1-ulp rounding of nowS
        const cutExpected = u < 0.4 ? 1 : 0;
        if (at(tr.cut, k) !== cutExpected) wrong++;
        if (at(tr.cutIgn, k) !== (fart ? cutExpected : 0)) wrong++;
      }
      expect(wrong).toBe(0);
      expect(at(tr.rpm, 0)).toBe(6500);
      expect(at(tr.cut, 1919)).toBe(1); // u ≈ 0.3998
      expect(at(tr.cut, 1921)).toBe(0); // u ≈ 0.4002
      // SimCore clears `active` after the shift: tracking resumes from toRpm, not from ctl.rpm
      ctl.shift.active = false;
      s.tick(ctl, t0 + dur);
      const k1 = 1 - Math.exp(-1 / (0.04 * FS));
      expect(s.rpm).toBeCloseTo(4200 + k1 * (4300 - 4200), 3);
      expect(s.cut).toBe(false);
      expect(s.cutIsIgnition).toBe(false);
      run(s, ctl, Math.round(0.4 * FS), t0 + dur + DT);
      expect(Math.abs(s.rpm - 4300)).toBeLessThan(0.1);
    });
  }

  it('a completed shift whose `active` flag lingers resumes tracking from toRpm', () => {
    const s = makeState({}, 6500);
    const ctl = makeCtl(4300);
    ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0: 0, durationS: 0.1 };
    run(s, ctl, 4800, 0);
    s.tick(ctl, 0.1); // u = 1 while still active
    expect(s.rpm).toBeGreaterThan(4200);
    expect(s.rpm).toBeLessThan(4201);
    expect(s.cut).toBe(false);
  });

  it('before t0 the trajectory holds fromRpm with the cut active', () => {
    const s = makeState({ gearbox: 'manual' }, 5000);
    const ctl = makeCtl(5000);
    ctl.shift = { active: true, up: true, fromRpm: 5200, toRpm: 3500, t0: 2, durationS: 0.3 };
    s.tick(ctl, 1.99);
    expect(s.rpm).toBe(5200);
    expect(s.cut).toBe(true);
    expect(s.cutIsIgnition).toBe(false);
  });

  it('an aborted shift (active cleared mid-ease) continues from the current rpm without a jump', () => {
    const s = makeState({}, 6500);
    const ctl = makeCtl(4200);
    ctl.shift = { active: true, up: true, fromRpm: 6500, toRpm: 4200, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 2400, 0); // up to u = 0.5
    const last = at(tr.rpm, tr.rpm.length - 1);
    ctl.shift.active = false;
    ctl.rpm = 6000;
    s.tick(ctl, 0.05);
    expect(Math.abs(s.rpm - last)).toBeLessThan(2);
  });

  it('a downshift blip rises from fromRpm to toRpm', () => {
    const s = makeState({ gearbox: 'pdk' }, 3000);
    const ctl = makeCtl(5000);
    ctl.shift = { active: true, up: false, fromRpm: 3000, toRpm: 5000, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 4800, 0);
    expect(at(tr.rpm, 0)).toBe(3000);
    expect(at(tr.rpm, 3120)).toBeCloseTo(4000, 6); // u = 0.65
    expect(at(tr.rpm, 4799)).toBeGreaterThan(4999);
  });

  it('takes priority over the limiter', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    ctl.shift = { active: true, up: true, fromRpm: 7100, toRpm: 5000, t0: 0, durationS: 0.1 };
    const tr = run(s, ctl, 4800, 0);
    for (let k = 0; k < 4800; k += 100) expect(at(tr.rpm, k)).toBeCloseTo(shiftTrajectoryRpm(k / 4800, 7100, 5000), 6);
  });
});

describe('RpmState: limiter bounce (8–20 Hz, cuts ≤ 100 ms)', () => {
  const types: LimiterType[] = ['ignition-hard', 'ignition-soft', 'fuel-hard', 'fuel-soft'];
  for (const limiter of types) {
    it(`${limiter}: 2 s hold → 8–20 cut→fire transitions/s, longest cut ≤ 100 ms, rpm within the hysteresis band`, () => {
      const s = makeState({ limiter }, 7100);
      const ctl = makeCtl(7100);
      ctl.limiter = true;
      const tr = run(s, ctl, 2 * FS);
      const { transitions, longest } = cutStats(tr.cut);
      expect(transitions / 2).toBeGreaterThanOrEqual(8);
      expect(transitions / 2).toBeLessThanOrEqual(20);
      expect(longest).toBeLessThanOrEqual(0.1 * FS);
      let outOfBand = 0;
      let wrongType = 0;
      for (let k = 0; k < tr.rpm.length; k++) {
        const r = at(tr.rpm, k);
        if (r < 7100 - 150 - 1e-6 || r > 7100 + 1e-6) outOfBand++;
        // B5: `cut` covers the whole cut phase for every type; the cut type follows the limiter type
        if (at(tr.cutIgn, k) !== (limiter.startsWith('ignition') ? at(tr.cut, k) : 0)) wrongType++;
      }
      expect(outOfBand).toBe(0);
      expect(wrongType).toBe(0);
      // the cut phase is the falling half of the saw-tooth
      let cutSamples = 0;
      for (let k = 0; k < tr.cut.length; k++) cutSamples += at(tr.cut, k);
      expect(cutSamples / tr.cut.length).toBeGreaterThan(0.4);
      expect(cutSamples / tr.cut.length).toBeLessThan(0.6);
    });
  }

  it('keeps 8–20 Hz for tiny, zero and large hysteresis values', () => {
    for (const hysteresisRpm of [0, 20, 400]) {
      const s = makeState({ hysteresisRpm }, 7100);
      const ctl = makeCtl(7100);
      ctl.limiter = true;
      const { transitions, longest } = cutStats(run(s, ctl, 2 * FS).cut);
      expect(transitions / 2).toBeGreaterThanOrEqual(8);
      expect(transitions / 2).toBeLessThanOrEqual(20);
      expect(longest).toBeLessThanOrEqual(0.1 * FS);
    }
  });

  it('entered from below: rises without cutting, then bounces; on release tracking resumes without a jump', () => {
    const s = makeState({}, 5000);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    const tr = run(s, ctl, FS);
    let firstCut = -1;
    for (let k = 0; k < tr.cut.length && firstCut < 0; k++) if (at(tr.cut, k) === 1) firstCut = k;
    expect(firstCut).toBeGreaterThan(0);
    expect(firstCut).toBeLessThan(0.3 * FS);
    for (let k = 1; k < firstCut; k++) expect(at(tr.rpm, k)).toBeGreaterThan(at(tr.rpm, k - 1));
    const { transitions } = cutStats(tr.cut.subarray(firstCut));
    expect(transitions).toBeGreaterThanOrEqual(6);
    const before = s.rpm;
    ctl.limiter = false;
    ctl.rpm = 6000;
    s.tick(ctl, 1);
    expect(s.cut).toBe(false);
    expect(Math.abs(s.rpm - before)).toBeLessThan(1); // continuous
  });
});

describe('RpmState: falling', () => {
  it('is false when steady or rising, true while decreasing, and clears ~20 ms after rpm settles', () => {
    const s = makeState({}, 3000);
    const steady = run(s, makeCtl(3000), 4800);
    expect(steady.falling.every((f) => f === 0)).toBe(true);
    const rising = run(s, makeCtl(4000), 4800);
    expect(rising.falling.every((f) => f === 0)).toBe(true);
    run(s, makeCtl(4000), FS); // settle at 4000
    const drop = run(s, makeCtl(2000), Math.round(0.1 * FS));
    expect(at(drop.falling, 2)).toBe(1);
    for (let k = 2; k < drop.falling.length; k++) expect(at(drop.falling, k)).toBe(1);
    run(s, makeCtl(2000), FS); // settle at 2000
    const settled = run(s, makeCtl(2000), Math.round(0.03 * FS));
    expect(settled.falling.every((f) => f === 0)).toBe(true);
  });

  it('turns true ≈ 10 ms into each limiter cut phase (the 20 ms look-back first straddles the rise)', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    const tr = run(s, ctl, FS);
    let cutAndFalling = 0;
    let cutSamples = 0;
    for (let k = 0; k < tr.cut.length; k++) {
      if (at(tr.cut, k) === 1) {
        cutSamples++;
        cutAndFalling += at(tr.falling, k);
      }
    }
    expect(cutAndFalling / cutSamples).toBeGreaterThan(0.75); // ≈ 40 of every 50 ms
  });
});

describe('RpmState: reset mid-event', () => {
  it('clears an active limiter bounce and shift', () => {
    const s = makeState({}, 7100);
    const ctl = makeCtl(7100);
    ctl.limiter = true;
    run(s, ctl, 1000);
    expect(s.cut).toBe(true);
    s.reset(2000);
    expect(s.rpm).toBe(2000);
    expect(s.cut).toBe(false);
    expect(s.cutIsIgnition).toBe(false);
    expect(s.falling).toBe(false);
    ctl.limiter = false;
    ctl.rpm = 2000;
    run(s, ctl, 960);
    expect(s.rpm).toBe(2000);
    expect(s.falling).toBe(false);
  });
});
```

The contract's limiter test is `RpmState: limiter bounce (8–20 Hz, cuts ≤ 100 ms)`. It holds `ctl.limiter` true for 2 s for each of the four limiter types and asserts:
- 8–20 cut→fire transitions per second (the implementation gives 10);
- longest continuous cut ≤ 100 ms (50 ms);
- rpm stays inside `[limiter.rpm − hysteresis, limiter.rpm]`;
- B5 cut semantics.

The same bounds are re-checked for hysteresis 0 (clamped to 1 rpm), 20 and 400.

- [ ] **Step 6: Run the tests and confirm the new ones fail**

Run: `npx vitest run tests/unit/dsp-rpm-state.test.ts`
Expected: FAIL, `Tests  23 failed | 1 passed (24)`.
- The failures report `TypeError: RpmState is not a constructor`. Vitest prints repeated identical errors once per group.
- `rejects bad sample rates` reports `AssertionError: expected error to be instance of RangeError`.

- [ ] **Step 7: Implement RpmState**

Replace the entire contents of `src/dsp/rpm-state.ts` with the following. The Step 3 function is unchanged inside it.

```ts
/**
 * RpmState — the DSP-side engine speed that drives the crank clock (spec §5.1, §5.3.7 rev limiter,
 * §8.6 shift trajectory; phase2a contract "RpmState rules" + amendment B5).
 *
 * Per sample, in priority order:
 *   1. shift trajectory while ctl.shift.active and u = (nowS − t0)/durationS < 1: hold fromRpm for
 *      u < 0.3, cosine ease to toRpm over u ∈ [0.3, 1], combustion cut for u < 0.4 (ignition cut —
 *      the "fart" — for dct/pdk/amt, fuel cut otherwise). A completed shift resumes tracking from
 *      toRpm; an aborted one (active cleared early) resumes from where the trajectory was.
 *   2. limiter bounce while ctl.limiter: "cut" phase falls at hysteresis/50 ms down to
 *      limiter.rpm − hysteresis, "fire" phase rises at the same rate back to limiter.rpm
 *      (100 ms period → 10 cut→fire transitions/s, 50 ms cuts). B5: `cut` is true for the whole cut
 *      phase for every limiter type; DspCore turns it into an all-bits or alternating skipMask.
 *   3. otherwise one-pole tracking of ctl.rpm with τ = 40 ms.
 *
 * `tick` is a hot path (spec §4.4): no allocation; the 20 ms history ring is sized in the constructor.
 */
import type { DspControl, EngineSpec } from '../contracts';
import { OnePole } from './util';

/** Tracking time constant of ctl.rpm, seconds (contract). */
export const TRACK_TAU_S = 0.04;
/** Duration of each limiter half-cycle (cut or fire), seconds: rate = hysteresisRpm / 0.05 s (contract). */
export const LIMITER_HALF_PERIOD_S = 0.05;
/** Shift trajectory breakpoints in u: hold fromRpm until 0.3, combustion cut until 0.4 (contract). */
export const SHIFT_HOLD_END = 0.3;
export const SHIFT_CUT_END = 0.4;

/** `falling` = rpm now is more than FALLING_EPS_RPM below rpm FALLING_WINDOW_S ago (≈ 25 rpm/s). */
const FALLING_WINDOW_S = 0.02;
const FALLING_EPS_RPM = 0.5;
/** Sanity ceiling for any rpm input (+Infinity → this). */
const RPM_MAX = 30000;
/** Hysteresis floor: keeps the bounce rate finite and its period at 2 × 50 ms. */
const MIN_HYSTERESIS_RPM = 1;

/** rpm in [0, RPM_MAX]; NaN → fallback, −∞ → 0, +∞ → RPM_MAX. */
function sanitizeRpm(x: number, fallback: number): number {
  if (x >= 0) return x <= RPM_MAX ? x : RPM_MAX;
  return x < 0 ? 0 : fallback;
}

/** Shift trajectory (contract): fromRpm for u ≤ 0.3 (and NaN), cosine ease to toRpm over [0.3, 1], toRpm for u ≥ 1. */
export function shiftTrajectoryRpm(u: number, fromRpm: number, toRpm: number): number {
  if (!(u > SHIFT_HOLD_END)) return fromRpm;
  if (u >= 1) return toRpm;
  const e = 0.5 - 0.5 * Math.cos((Math.PI * (u - SHIFT_HOLD_END)) / (1 - SHIFT_HOLD_END));
  return fromRpm + (toRpm - fromRpm) * e;
}

export class RpmState {
  private readonly fs: number;
  private readonly tracker = new OnePole();
  /** rpm of the last FALLING_WINDOW_S·fs samples (ring). */
  private readonly hist: Float64Array;
  private histIdx = 0;

  private rpmNow = 0;
  private cutNow = false;
  private cutIgnitionNow = false;
  private fallingNow = false;

  private limiterRpm = 7000;
  private hysteresis = 150;
  private limiterStep = 0;
  private limiterIgnition = false;
  private shiftIgnition = false;

  private inShift = false;
  private shiftT0 = 0;
  private shiftDur = 1;
  private shiftTo = 0;
  private inLimiter = false;
  private limiterCutPhase = false;

  constructor(fs: number) {
    if (!(fs >= 8000) || !Number.isFinite(fs)) {
      throw new RangeError(`RpmState: sample rate must be a finite number ≥ 8000, got ${fs}`);
    }
    this.fs = fs;
    this.tracker.setTau(TRACK_TAU_S, fs);
    this.hist = new Float64Array(Math.max(1, Math.round(FALLING_WINDOW_S * fs)));
    this.limiterStep = this.hysteresis / (LIMITER_HALF_PERIOD_S * fs);
  }

  /** Engine rpm this sample (≥ 0). */
  get rpm(): number {
    return this.rpmNow;
  }

  /** Combustion cut this sample (limiter cut phase or shift cut window). */
  get cut(): boolean {
    return this.cutNow;
  }

  /** The current cut is an ignition cut (limiter type ignition-*, or a dct/pdk/amt shift); false when not cutting. */
  get cutIsIgnition(): boolean {
    return this.cutIgnitionNow;
  }

  /** rpm decreased by more than 0.5 rpm over the last 20 ms. */
  get falling(): boolean {
    return this.fallingNow;
  }

  /** Reads limiter and gearbox data from the spec, then reset(0). Never allocates. */
  configure(spec: EngineSpec): void {
    const lim = spec.rpm.limiter;
    const redline = spec.rpm.redline > 0 && spec.rpm.redline <= RPM_MAX ? spec.rpm.redline : 7000;
    this.limiterRpm = lim.rpm > 0 && lim.rpm <= RPM_MAX ? lim.rpm : redline;
    const h = lim.hysteresisRpm > MIN_HYSTERESIS_RPM ? lim.hysteresisRpm : MIN_HYSTERESIS_RPM;
    this.hysteresis = Math.min(h, 0.5 * this.limiterRpm);
    this.limiterStep = this.hysteresis / (LIMITER_HALF_PERIOD_S * this.fs);
    this.limiterIgnition = lim.type === 'ignition-hard' || lim.type === 'ignition-soft';
    const gb = spec.gearbox.type;
    this.shiftIgnition = gb === 'dct' || gb === 'pdk' || gb === 'amt';
    this.reset(0);
  }

  /** Sets rpm immediately (default 0; NaN → 0) and clears cut/falling, shift and limiter state. */
  reset(rpm = 0): void {
    const r = sanitizeRpm(rpm, 0);
    this.tracker.reset(r);
    this.rpmNow = r;
    this.hist.fill(r);
    this.histIdx = 0;
    this.cutNow = false;
    this.cutIgnitionNow = false;
    this.fallingNow = false;
    this.inShift = false;
    this.inLimiter = false;
    this.limiterCutPhase = false;
  }

  tick(ctl: DspControl, nowS: number): void {
    const sh = ctl.shift;
    let rpm: number;
    let cut = false;
    let cutIgnition = false;
    let u = Number.NaN;
    if (sh.active && sh.durationS > 0) u = (nowS - sh.t0) / sh.durationS;

    if (u < 1) {
      // 1. shift trajectory (u < 0, i.e. t0 slightly in the future, holds fromRpm with the cut)
      const from = sanitizeRpm(sh.fromRpm, this.tracker.y);
      const to = sanitizeRpm(sh.toRpm, from);
      rpm = shiftTrajectoryRpm(u, from, to);
      cut = u < SHIFT_CUT_END;
      cutIgnition = cut && this.shiftIgnition;
      this.inShift = true;
      this.shiftT0 = sh.t0;
      this.shiftDur = sh.durationS;
      this.shiftTo = to;
      this.inLimiter = false;
      this.tracker.reset(rpm);
    } else {
      if (this.inShift) {
        this.inShift = false;
        // completed → resume from toRpm exactly; aborted early → resume from the last trajectory rpm
        if ((nowS - this.shiftT0) / this.shiftDur >= 1) this.tracker.reset(this.shiftTo);
      }
      if (ctl.limiter) {
        // 2. limiter bounce
        const top = this.limiterRpm;
        const bottom = top - this.hysteresis;
        const step = this.limiterStep;
        let y = this.tracker.y;
        if (!this.inLimiter) {
          this.inLimiter = true;
          this.limiterCutPhase = y >= top;
        }
        if (this.limiterCutPhase) {
          y -= step;
          if (y <= bottom) {
            y = bottom;
            this.limiterCutPhase = false;
          }
        } else {
          if (y < bottom) {
            // still below the bounce band (limiter flagged while rpm lags): at least as fast as tracking
            const pulled = this.tracker.process(top);
            y = pulled > y + step ? pulled : y + step;
          } else {
            y += step;
          }
          if (y >= top) {
            y = top;
            this.limiterCutPhase = true;
          }
        }
        this.tracker.reset(y);
        rpm = y;
        cut = this.limiterCutPhase;
        cutIgnition = cut && this.limiterIgnition;
      } else {
        // 3. one-pole tracking (NaN target holds the current rpm)
        this.inLimiter = false;
        rpm = this.tracker.process(sanitizeRpm(ctl.rpm, this.tracker.y));
      }
    }

    const past = this.hist[this.histIdx] ?? rpm;
    this.hist[this.histIdx] = rpm;
    this.histIdx = this.histIdx + 1 === this.hist.length ? 0 : this.histIdx + 1;
    this.fallingNow = rpm < past - FALLING_EPS_RPM;
    this.rpmNow = rpm;
    this.cutNow = cut;
    this.cutIgnitionNow = cutIgnition;
  }
}
```

Design notes:
- The tracker `OnePole` is the single rpm state.
  - The trajectory and the bounce write their value into it with `reset(y)` every sample. Every hand-over (shift → tracking, limiter → tracking, tracking → limiter) is therefore continuous by construction.
  - The only deliberate exception: a completed shift snaps to `toRpm`. The cosine ease has zero slope at u = 1, so the snap is below 0.01 rpm.
- **Limiter timing is independent of `hysteresisRpm`.** Rate = h/50 ms and distance = h give 50 ms per half-cycle. The 1-rpm floor only guards h = 0 or NaN, which would otherwise flip the phase every sample.
- **`falling` uses an exact 20 ms look-back ring**, not a slope filter, so it matches the contract's "rpm decreasing over the last ~20 ms". The 0.5 rpm threshold (≈ 25 rpm/s) ignores numerical creep at steady state.

- [ ] **Step 8: Run the tests and confirm they all pass**

Run: `npx vitest run tests/unit/dsp-rpm-state.test.ts`
Expected: PASS, `Tests  24 passed (24)` (< 1 s).

- [ ] **Step 9: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0. If files belonging to other in-progress tasks fail lint, confirm that this task's files are clean with `npx eslint src/dsp/rpm-state.ts tests/unit/dsp-rpm-state.test.ts`.

---

### Task 6: Engine layers — intake, mechanical, forced induction, overrun

**Files:**
- Create: `src/dsp/intake.ts`
- Create: `src/dsp/mechanical.ts`
- Create: `src/dsp/forced.ts`
- Create: `src/dsp/overrun.ts`
- Test: `tests/unit/dsp-intake.test.ts`
- Test: `tests/unit/dsp-mechanical.test.ts`
- Test: `tests/unit/dsp-forced.test.ts`
- Test: `tests/unit/dsp-overrun.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED): `type EngineSpec`, `type EngineVoicing`; tests also use `type EngineDef`, `type LiftEvent`, `type TurboLayout`.
  - T1 `src/dsp/util.ts`:
    - `flush(x: number): number`
    - `clamp(x: number, lo: number, hi: number): number`
    - `smoothstep(e0: number, e1: number, x: number): number`
    - `class Rng { constructor(seed?: number); seed(s: number): void; next(): number /* [0,1) */; bipolar(): number /* [-1,1) */ }`
    - `class Slew { setRate(unitsPerS: number, fs: number): void; process(target: number): number; reset(v: number): void }`
  - T1 `src/dsp/biquad.ts`: `class Biquad { lowpass(f: number, q: number, fs: number): void; highpass(f: number, q: number, fs: number): void; bandpass(f: number, q: number, fs: number): void; process(x: number): number; reset(): void }`. The tests also use it as a measuring filter.
  - T1 fixtures (tests only): `tests/fixtures/engines/i4-test.json`, `i6-test.json`, `v8-sc-test.json`.
- Produces (exact exports; T9 `dsp-core.ts` and T10 tools rely on them):

```ts
// Summary of the exports (each constant is its own `export const` in the file).
// src/dsp/intake.ts
export const INTAKE_Q = 2;                          // contract band-pass Q
export const INTAKE_RMS = 0.25;                     // layer RMS at gate envelope 1, throttle 1, gain 1
export const INTAKE_THROTTLE_SLEW_PER_S = 50;       // throttle de-zipper: 0 → 1 in 20 ms (linear)
export class IntakeLayer {
  constructor(fs: number);
  configure(voicing: EngineVoicing, seed: number): void;   // no allocation; clears state
  tick(gateSum: number, throttle01: number): number;       // gateSum = Σ CombustionSource intakeGate[i]
  reset(): void;                                           // restores the post-configure state (same noise)
}
// src/dsp/mechanical.ts
export const BLOCK_LP_HZ = 250, BLOCK_Q = 0.7, VALVETRAIN_BP_HZ = 3000, VALVETRAIN_Q = 1.5,
  VALVETRAIN_BURST_S = 0.002, VALVETRAIN_AMP_JITTER = 0.2;
export class MechanicalLayer {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  tick(ignitionImpulse: number, rpm: number): number;      // ignitionImpulse = CombustionSource.tick() return value
  reset(): void;
}
// src/dsp/forced.ts
export const WHISTLE_AMP = 0.25, WHISTLE_H2 = 0.2512, WHOOSH_RMS = 0.1, WHOOSH_LO_HZ = 4000, WHOOSH_HI_HZ = 12000,
  LIFT_LOAD = 0.1, LIFT_MIN_BOOST = 0.4, LIFT_REARM_LOAD = 0.2, BOV_HZ = 2500, BOV_Q = 1.2, BOV_ATTACK_S = 0.005,
  BOV_DECAY_S = 0.5, BOV_RMS = 0.3, FLUTTER_HZ = 14, FLUTTER_DECAY_S = 0.8, FLUTTER_RMS = 0.2, WHINE_AMP = 0.4,
  WHINE_H2 = 0.316, SEQ_ENTRY = 0.55, SEQ_FULL = 0.65, SEQ_RATIO = 0.88, PARALLEL_RATIO = 1.012;
export class ForcedInduction {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  tick(rpm: number, load: number): number;                 // forced-induction bus sample (pre-perspective)
  get boost(): number;                                     // satisfies the contract's `readonly boost` (0..1)
  whineHz(rpm: number): number;                            // rpm/60·pulleyRatio·gearRatio·(roots ? 2·lobes : lobes); 0 without a supercharger
  reset(): void;
}
// src/dsp/overrun.ts
export const POP_RATE_PER_CRACKLE = 4, POP_VALVE_FACTOR = 2.5, POP_DECAY_TAU_S = 1.5, POP_LEN_S = 0.001,
  POP_AMP_MIN = 0.3, POP_AMP_MAX = 1.0, POP_MAX_PENDING = 8, OVERRUN_ENTER = 0.1, OVERRUN_EXIT = 0.02,
  AIRFLOW_LP_HZ = 1200, AIRFLOW_RMS = 0.1;
export class OverrunLayer {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  tick(regime: number, rpm: number, falling: boolean, valveOpen01: number, modeFactor: number, ignitionCutPops: number): void;
  get popInject(): number;                                 // contract `readonly popInject`; 0 ≤ value ≤ 1
  get airflow(): number;                                   // contract `readonly airflow`
  reset(): void;
}
```

  - What T9 can rely on:
    - **Seeds.** Every layer salts its seed internally (`(seed ^ SALT) >>> 0`), so T9 may pass the same seed to all four.
    - **reset()** re-seeds and clears all state, so it replays the identical sequence (invariant 10).
    - **Allocation.** Constructors allocate everything (`OverrunLayer` allocates its pop window); `configure()` and the per-sample methods never allocate.
    - **Hot-path shape.** Each public per-sample method stores its arguments in fields and calls a private argument-less `step()` that writes a field. The public method is tiny, so callers inline it, and doubles do not cross non-inlined call boundaries (amendment B2). Keep this shape when editing.
  - Levels (the Sound Lab tunes voicing gains against these):
    - Intake: RMS ≈ `0.25·gain` at full throttle with gate envelope 1. The gate envelope is `gateSum · 3 / headersM.length`, so a 4-stroke's cycle mean is ≈ 1 for any cylinder count.
    - Block: thump peak ≈ `0.45·blockGain` per unit ignition impulse, independent of `fs`.
    - Valvetrain: burst peak ≈ `0.45·valvetrainGain`.
    - Forced-induction bus (FI): whistle amplitude `0.25·boost` (+ 2·f1 at −12 dB); whoosh RMS `0.1·boost²`; BOV RMS `0.3·boost at lift`; flutter RMS ≈ `0.2·boost at lift`.
    - Supercharger whine: amplitude `0.4·boost` (+ 2nd harmonic at −10 dB). Tones above `0.45·fs` are muted.
    - Pops: ≤ 1. Airflow: RMS `0.1·regime·rpm/redline`, with rpm/redline capped at 2.
  - Behaviour:
    - Intake throttle is de-zipped by a linear 20 ms slew; at throttle 0 the output is exactly 0 once the slew lands.
    - `ForcedInduction` is silent (`boost` 0) for NA engines, and for a turbo engine whose `voicing.forcedInduction` is `null`.
    - `valveOpen01` is continuous: the contract's `valveOpen ? 2.5 : 1` becomes `1 + 1.5·valveOpen01`.
    - `ignitionCutPops` may be any non-negative count per call. Pops are queued, capped at 8, with ≥ 1 zero sample between pops.
    - `popInject` is valid right after `tick()`. T9 may tick `OverrunLayer` before `ExhaustNetwork` in the same sample, or feed the previous sample's value (a 1-sample delay).
  - Interpretations of the contract's "decay" phrases:
    - BOV "decay 0.5 s" is −60 dB at 0.5 s after the 5 ms attack.
    - Flutter "decaying over 0.8 s" is −60 dB at 0.8 s.
    - Valvetrain "2 ms decaying" is −40 dB at 2 ms.
  - Measured cost on the authoring machine, in ns/sample: intake 26, mechanical 38, turbo 149, supercharger 52, overrun 44.

**Cross-task premises:** (open each named file and confirm every bullet before coding)
- T1 `src/dsp/util.ts`:
  - `new Rng()` works as a field initialiser. `seed(s)` takes any uint32 and restarts a deterministic stream. `next()` is uniform in [0, 1) and `bipolar()` is uniform in [−1, 1).
  - `new Slew()` takes no arguments. `setRate(unitsPerS, fs)` limits each `process(target)` step to `unitsPerS/fs`. When the target is within one step, y lands on it: `y = target`, or `y + (target − y)`, which is exactly 0 for target 0. `reset(v)` sets y.
  - `flush(x)` returns 0 for |x| < 1e-20, else x.
  - `clamp(x, lo, hi)` clamps finite x.
  - `smoothstep(e0, e1, x)` is `3t² − 2t³` with `t = clamp((x − e0)/(e1 − e0), 0, 1)`.
- T1 `src/dsp/biquad.ts`:
  - `new Biquad()` takes no arguments.
  - `lowpass`/`highpass`/`bandpass` follow the RBJ cookbook (`bandpass` = constant 0 dB peak gain). They may be called from constructors and `configure()` without allocating.
  - `process(x)` returns the output sample. `reset()` clears state and keeps the coefficients.
- T1 fixtures:
  - `i4-test.json` is a complete `EngineDef` with exactly 4 `spec.combustion` entries.
  - `i6-test.json` has 6 entries and `spec.aspiration.type === 'na'`.
  - `v8-sc-test.json` has `spec.aspiration = { type: 'supercharger', turbo: null, supercharger: { kind: 'roots', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 } }`.
  - The tests override every other field they depend on: redline, aspiration for turbo cases, `forcedInduction`, `intake`, `mechanical`, `overrun` and `headersM`.
- T4 `CombustionSource` and T9 (consumer side, informational; nothing here imports them):
  - `intakeGate[i]` ∈ [0, 1] is summed into `IntakeLayer.tick(gateSum, …)`.
  - The ignition-impulse return of `CombustionSource.tick()` feeds `MechanicalLayer.tick`.
  - `takeIgnitionCutPops()` feeds `OverrunLayer.tick(…, ignitionCutPops)`.
  - `ForcedInduction.boost` is the natural input for `ExhaustNetwork.setTurbineAttenuation`.

- [ ] **Step 1: Write the failing test for `IntakeLayer`**

Create `tests/unit/dsp-intake.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef } from '../../src/contracts';
import { INTAKE_RMS, IntakeLayer } from '../../src/dsp/intake';

const FS = 48000;

function loadDef(id: string): EngineDef {
  return JSON.parse(readFileSync(new URL(`../fixtures/engines/${id}.json`, import.meta.url), 'utf8')) as EngineDef;
}

/** i4-test with the intake voicing under test (4 entries → gate sum 4/3 is envelope 1). */
function makeLayer(seed = 1, helmholtzHz = 140, gain = 0.4): IntakeLayer {
  const def = loadDef('i4-test');
  def.voicing.intake = { runnerM: 0.3, helmholtzHz, gain };
  def.voicing.headersM = [0.6, 0.6, 0.6, 0.6];
  const layer = new IntakeLayer(FS);
  layer.configure(def.voicing, seed);
  return layer;
}

function render(layer: IntakeLayer, n: number, gateSum: number, throttle: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = layer.tick(gateSum, throttle);
  return out;
}

function rms(x: Float64Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Hann-windowed Goertzel power at f (relative units, same window for all calls). */
function tonePower(x: Float64Array, f: number, from: number): number {
  const n = x.length - from;
  const c = 2 * Math.cos((2 * Math.PI * f) / FS);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[from + i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Mean power over 41 bins spaced 1 Hz around f (a noise-density estimate). */
function bandDensity(x: Float64Array, f: number, from: number): number {
  let p = 0;
  for (let k = -20; k <= 20; k++) p += tonePower(x, f + k, from);
  return p / 41;
}

describe('IntakeLayer', () => {
  it('is exactly silent at throttle 0 even with open intake gates', () => {
    const out = render(makeLayer(), FS, 4 / 3, 0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('is exactly silent whenever the gate sum is 0', () => {
    const out = render(makeLayer(), FS / 2, 0, 1);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('has RMS ≈ INTAKE_RMS × gain at full throttle with gate envelope 1 (I4 gate sum 4/3)', () => {
    const out = render(makeLayer(1, 140, 0.4), 2 * FS, 4 / 3, 1);
    const r = rms(out, FS / 4);
    expect(r).toBeGreaterThan(0.8 * INTAKE_RMS * 0.4);
    expect(r).toBeLessThan(1.2 * INTAKE_RMS * 0.4);
  });

  it('concentrates its energy around helmholtzHz (band-pass Q 2)', () => {
    const out = render(makeLayer(3, 140, 1), 2 * FS, 4 / 3, 1);
    const at = bandDensity(out, 140, FS / 4);
    expect(at).toBeGreaterThan(10 * bandDensity(out, 600, FS / 4));
    expect(at).toBeGreaterThan(100 * bandDensity(out, 2000, FS / 4));
    expect(at).toBeGreaterThan(10 * bandDensity(out, 40, FS / 4));
  });

  it('scales exactly with the gate envelope and with voicing gain (same seed)', () => {
    const a = render(makeLayer(5, 140, 0.4), 4800, 4 / 3, 1);
    const b = render(makeLayer(5, 140, 0.4), 4800, 2 / 3, 1);
    const c = render(makeLayer(5, 140, 0.8), 4800, 4 / 3, 1);
    for (let i = 0; i < 4800; i++) {
      expect(b[i] ?? NaN).toBeCloseTo(0.5 * (a[i] ?? NaN), 12);
      expect(c[i] ?? NaN).toBeCloseTo(2 * (a[i] ?? NaN), 12);
    }
  });

  it('de-zips throttle: 20 ms linear fade in, 20 ms fade out to exact silence (multi-call)', () => {
    const layer = makeLayer(7);
    const on = render(layer, FS / 5, 4 / 3, 1);
    const steady = rms(on, FS / 10);
    expect(rms(on, 0, 96)).toBeLessThan(0.25 * steady); // first 2 ms: still fading in
    const off = render(layer, FS / 2, 4 / 3, 0);
    expect(off[0]).not.toBe(0); // no instant cut on lift
    expect(rms(off, 0, 96)).toBeGreaterThan(0.5 * steady); // first 2 ms: still mostly there
    expect(off.subarray(1000).every((v) => v === 0)).toBe(true); // exact silence after 20.8 ms
    const again = render(layer, FS / 5, 4 / 3, 1); // re-open: sound returns
    expect(rms(again, FS / 10)).toBeGreaterThan(0.5 * steady);
  });

  it('is deterministic per seed, reset() replays the sequence, and seeds differ', () => {
    const layer = makeLayer(11);
    const first = render(layer, 2000, 1, 1);
    layer.reset();
    expect(Array.from(render(layer, 2000, 1, 1))).toEqual(Array.from(first));
    expect(Array.from(render(makeLayer(11), 2000, 1, 1))).toEqual(Array.from(first));
    expect(Array.from(render(makeLayer(12), 2000, 1, 1))).not.toEqual(Array.from(first));
  });
});
```

- [ ] **Step 2: Run the intake test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-intake.test.ts`
Expected: FAIL. The suite cannot load: `Error: Cannot find module '../../src/dsp/intake' imported from …/tests/unit/dsp-intake.test.ts` (`Tests  no tests`).

- [ ] **Step 3: Implement `src/dsp/intake.ts`**

Create `src/dsp/intake.ts`:

```ts
import type { EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, Rng, Slew } from './util';

/** Contract: band-pass Q at `voicing.intake.helmholtzHz`. */
export const INTAKE_Q = 2;
/** Layer RMS at gate envelope 1, throttle 1 and `voicing.intake.gain` = 1 (≈ −12 dBFS). */
export const INTAKE_RMS = 0.25;
/** Throttle de-zipper: linear slew, full 0 → 1 travel in 20 ms; reaches exactly 0 (true silence). */
export const INTAKE_THROTTLE_SLEW_PER_S = 50;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x1a7a3e5;

/**
 * Intake roar (spec §5.3.6): band-passed noise × intake-gate envelope × throttle × gain.
 * `gateSum` is Σ CombustionSource.intakeGate[i]; it is normalised by 3 / entryCount so the
 * cycle-mean envelope of a 4-stroke (240° windows in 720°) is ≈ 1 for any cylinder count.
 * Silent (exactly 0) whenever the de-zipped throttle is 0.
 */
export class IntakeLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly bp = new Biquad();
  private readonly throttle = new Slew();
  private seedValue = 1;
  private noiseScale = 0;
  private gain = 0;
  private gateNorm = 1;
  private inGate = 0;
  private inThrottle = 0;
  private y = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.throttle.setRate(INTAKE_THROTTLE_SLEW_PER_S, fs);
  }

  /** Sets parameters and clears state (no allocation). */
  configure(voicing: EngineVoicing, seed: number): void {
    const f0 = clamp(voicing.intake.helmholtzHz, 20, 0.45 * this.fs);
    this.bp.bandpass(f0, INTAKE_Q, this.fs);
    // RBJ constant-0-dB-peak band-pass passes a white-noise power fraction ≈ π·f0/(Q·fs);
    // uniform noise in [−1, 1) has variance 1/3.
    this.noiseScale = INTAKE_RMS / Math.sqrt(((1 / 3) * Math.PI * f0) / (INTAKE_Q * this.fs));
    this.gain = voicing.intake.gain;
    this.gateNorm = 3 / Math.max(1, voicing.headersM.length);
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. Tiny wrapper so callers inline it; per-sample doubles cross into step() via fields. */
  tick(gateSum: number, throttle01: number): number {
    this.inGate = gateSum;
    this.inThrottle = throttle01;
    this.step();
    return this.y;
  }

  /** Restores the post-configure state (same noise sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.bp.reset();
    this.throttle.reset(0);
    this.y = 0;
  }

  private step(): void {
    const t = this.throttle.process(clamp(this.inThrottle, 0, 1));
    const band = this.bp.process(this.rng.bipolar() * this.noiseScale);
    this.y = t > 0 ? band * this.inGate * this.gateNorm * t * this.gain : 0;
  }
}
```

- [ ] **Step 4: Run the intake test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-intake.test.ts`
Expected: PASS, `Tests  7 passed (7)`. The measured RMS normalisation is within ±6 % of `INTAKE_RMS·gain` for `helmholtzHz` 60–1000 Hz across seeds; the test allows ±20 %.

- [ ] **Step 5: Write the failing test for `MechanicalLayer`**

Create `tests/unit/dsp-mechanical.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef } from '../../src/contracts';
import { MechanicalLayer } from '../../src/dsp/mechanical';

const FS = 48000;

function loadDef(id: string): EngineDef {
  return JSON.parse(readFileSync(new URL(`../fixtures/engines/${id}.json`, import.meta.url), 'utf8')) as EngineDef;
}

function makeLayer(blockGain: number, valvetrainGain: number, seed = 1, id = 'i4-test', fs = FS): MechanicalLayer {
  const def = loadDef(id);
  def.voicing.mechanical = { blockGain, valvetrainGain };
  const layer = new MechanicalLayer(fs);
  layer.configure(def.spec, def.voicing, seed);
  return layer;
}

/** Hann-windowed Goertzel power at f. */
function tonePower(x: Float64Array, f: number, fs = FS): number {
  const n = x.length;
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Mean power over 21 bins spaced 2 Hz around f (noise-density estimate). */
function bandDensity(x: Float64Array, f: number): number {
  let p = 0;
  for (let k = -10; k <= 10; k++) p += tonePower(x, f + 2 * k);
  return p / 21;
}

/** Counts bursts: an onset is a sample with |x| > thr preceded by ≥ 1 ms of |x| ≤ thr. */
function countBursts(x: Float64Array, thr: number): number {
  let count = 0;
  let quiet = FS;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] ?? 0) > thr) {
      if (quiet >= FS / 1000) count++;
      quiet = 0;
    } else quiet++;
  }
  return count;
}

function renderValvetrain(layer: MechanicalLayer, rpm: number, n = FS): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = layer.tick(0, rpm);
  return y;
}

function thump(layer: MechanicalLayer, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = layer.tick(i === 0 ? 1 : 0, 0);
  return y;
}

function peakAbs(x: Float64Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

describe('MechanicalLayer', () => {
  it('is exactly silent with no ignition impulses at rpm 0', () => {
    const y = renderValvetrain(makeLayer(0.3, 0.1), 0);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('turns a unit ignition impulse into a 250 Hz low-passed thump peaking ≈ 0.45 × blockGain', () => {
    const y = thump(makeLayer(1, 0), 4800);
    const peak = peakAbs(y);
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.5);
    expect(tonePower(y, 100)).toBeGreaterThan(1000 * tonePower(y, 2000));
    expect(Math.abs(y[4799] ?? 1)).toBeLessThan(1e-6);
    const half = thump(makeLayer(0.5, 0), 4800);
    for (let i = 0; i < 4800; i++) expect(half[i] ?? NaN).toBeCloseTo(0.5 * (y[i] ?? NaN), 12);
  });

  it('keeps the thump level independent of the sample rate', () => {
    const p48 = peakAbs(thump(makeLayer(1, 0, 1, 'i4-test', 48000), 4800));
    const p44 = peakAbs(thump(makeLayer(1, 0, 1, 'i4-test', 44100), 4410));
    expect(Math.abs(p44 / p48 - 1)).toBeLessThan(0.03);
  });

  it('emits valvetrain bursts at rpm/120 × combustion count per second (I4)', () => {
    for (const [rpm, expected] of [
      [6000, 200],
      [3000, 100],
      [1200, 40],
    ] as const) {
      const y = renderValvetrain(makeLayer(0, 1), rpm);
      expect(Math.abs(countBursts(y, 0.02) - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('scales the burst rate with the combustion count (I6 at 4000 rpm → 200 per second)', () => {
    const y = renderValvetrain(makeLayer(0, 1, 1, 'i6-test'), 4000);
    expect(Math.abs(countBursts(y, 0.02) - 200)).toBeLessThanOrEqual(2);
  });

  it('makes each burst decay within ≈ 2 ms', () => {
    const y = renderValvetrain(makeLayer(0, 1, 4), 1200); // one burst every 12.5 ms
    // Energy in the first 2 ms after each onset vs. the 2–6 ms after it.
    let early = 0;
    let late = 0;
    let i = 0;
    while (i < y.length - 300) {
      if (Math.abs(y[i] ?? 0) > 0.02) {
        for (let k = 0; k < 96; k++) early += (y[i + k] ?? 0) ** 2;
        for (let k = 96; k < 288; k++) late += (y[i + k] ?? 0) ** 2;
        i += 480;
      } else i++;
    }
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(1e-3 * early);
  });

  it('band-limits the valvetrain tick around 3 kHz', () => {
    const y = renderValvetrain(makeLayer(0, 1, 9), 6000);
    const at = bandDensity(y, 3000);
    expect(at).toBeGreaterThan(30 * bandDensity(y, 300));
    expect(at).toBeGreaterThan(10 * bandDensity(y, 15000));
  });

  it('is deterministic per seed and reset() replays the sequence (multi-call)', () => {
    const run = (layer: MechanicalLayer): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 3000; i++) out.push(layer.tick(i % 240 === 0 ? 0.8 : 0, 4500));
      return out;
    };
    const layer = makeLayer(0.3, 0.1, 21);
    const a = run(layer);
    expect(run(layer)).not.toEqual(a); // state carries over between calls
    layer.reset();
    expect(run(layer)).toEqual(a);
    expect(run(makeLayer(0.3, 0.1, 21))).toEqual(a);
    expect(run(makeLayer(0.3, 0.1, 22))).not.toEqual(a);
  });
});
```

- [ ] **Step 6: Run the mechanical test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-mechanical.test.ts`
Expected: FAIL. `Error: Cannot find module '../../src/dsp/mechanical' imported from …/tests/unit/dsp-mechanical.test.ts`.

- [ ] **Step 7: Implement `src/dsp/mechanical.ts`**

Create `src/dsp/mechanical.ts`:

```ts
import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { flush, Rng } from './util';

/** Contract: block = ignition impulses → LP 250 Hz (Q 0.7) × blockGain. */
export const BLOCK_LP_HZ = 250;
export const BLOCK_Q = 0.7;
/** Contract: valvetrain bursts through a band-pass at 3 kHz. */
export const VALVETRAIN_BP_HZ = 3000;
export const VALVETRAIN_Q = 1.5;
/** "2 ms decaying" burst: exponential envelope that is −40 dB after 2 ms. */
export const VALVETRAIN_BURST_S = 0.002;
/** Per-event amplitude variation of the valvetrain tick: uniform in [1 − x, 1 + x]. */
export const VALVETRAIN_AMP_JITTER = 0.2;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x2b3c4d5;

/**
 * Mechanical layer (spec §5.3.6): block vibration from ignition impulses and valvetrain tick
 * (noise bursts at rpm/120 × combustion count per second through a 3 kHz band-pass).
 * A unit ignition impulse yields a block thump peaking at ≈ 0.45·blockGain, independent of fs.
 */
export class MechanicalLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly blockLp = new Biquad();
  private readonly valveBp = new Biquad();
  /** A 1-sample impulse has area 1/fs; × fs/(2π·250) makes the thump amplitude fs-independent. */
  private readonly blockNorm: number;
  private readonly burstDecay: number;
  private seedValue = 1;
  private blockGain = 0;
  private valveGain = 0;
  /** Valve events per second per rpm = combustion count / 120. */
  private eventsPerRpm = 0;
  private phase = 0;
  private env = 0;
  private inImpulse = 0;
  private inRpm = 0;
  private y = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.blockLp.lowpass(BLOCK_LP_HZ, BLOCK_Q, fs);
    this.valveBp.bandpass(Math.min(VALVETRAIN_BP_HZ, 0.45 * fs), VALVETRAIN_Q, fs);
    this.blockNorm = fs / (2 * Math.PI * BLOCK_LP_HZ);
    this.burstDecay = Math.pow(10, -2 / (VALVETRAIN_BURST_S * fs));
  }

  /** Sets parameters and clears state (no allocation). */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    this.blockGain = voicing.mechanical.blockGain;
    this.valveGain = voicing.mechanical.valvetrainGain;
    this.eventsPerRpm = spec.combustion.length / 120;
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. `ignitionImpulse` = CombustionSource.tick() return value. */
  tick(ignitionImpulse: number, rpm: number): number {
    this.inImpulse = ignitionImpulse;
    this.inRpm = rpm;
    this.step();
    return this.y;
  }

  /** Restores the post-configure state (same noise sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.blockLp.reset();
    this.valveBp.reset();
    this.phase = 0;
    this.env = 0;
    this.y = 0;
  }

  private step(): void {
    const block = this.blockLp.process(this.inImpulse * this.blockNorm) * this.blockGain;
    const rate = this.inRpm > 0 ? this.inRpm * this.eventsPerRpm : 0;
    this.phase += rate / this.fs;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      this.env = 1 + VALVETRAIN_AMP_JITTER * this.rng.bipolar();
    }
    const burst = this.valveBp.process(this.rng.bipolar() * this.env);
    this.env = flush(this.env * this.burstDecay);
    this.y = block + burst * this.valveGain;
  }
}
```

- [ ] **Step 8: Run the mechanical test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-mechanical.test.ts`
Expected: PASS, `Tests  8 passed (8)`. The burst counter reads 199–200 per second where 200 is expected: the first event fires one period after reset, inside the ±2 tolerance.

- [ ] **Step 9: Write the failing test for `ForcedInduction`, including the supercharger whine-order formula**

Create `tests/unit/dsp-forced.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef, LiftEvent, TurboLayout } from '../../src/contracts';
import { Biquad } from '../../src/dsp/biquad';
import { ForcedInduction, WHINE_AMP, WHISTLE_AMP } from '../../src/dsp/forced';

const FS = 48000;

function loadDef(id: string): EngineDef {
  return JSON.parse(readFileSync(new URL(`../fixtures/engines/${id}.json`, import.meta.url), 'utf8')) as EngineDef;
}

function configured(def: EngineDef, seed = 1): ForcedInduction {
  const fi = new ForcedInduction(FS);
  fi.configure(def.spec, def.voicing, seed);
  return fi;
}

/** Turbo test engine: i4-test with redline 6000 and the given turbo layout / lift / spool. */
function turboDef(lift: LiftEvent = 'bov', layout: TurboLayout = 'single', spoolTimeS = 0.5): EngineDef {
  const def = loadDef('i4-test');
  def.spec.rpm.redline = 6000;
  def.spec.aspiration = { type: 'turbo', turbo: { count: layout === 'single' ? 1 : 2, layout }, supercharger: null };
  def.voicing.forcedInduction = { spoolTimeS, maxShaftKrpm: 180, lift, cabinGainDb: -14 };
  return def;
}

/** v8-sc-test (roots, pulleyRatio 2.4, gearRatio 1, 4 lobes) with redline 6000. */
function scDef(): EngineDef {
  const def = loadDef('v8-sc-test');
  def.spec.rpm.redline = 6000;
  return def;
}

function render(fi: ForcedInduction, n: number, rpm: number, load: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = fi.tick(rpm, load);
  return y;
}

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel, exact for a pure tone). */
function toneAmp(x: Float64Array, f: number): number {
  const n = x.length;
  const c = 2 * Math.cos((2 * Math.PI * f) / FS);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

/** Mean Hann-windowed Goertzel power over 101 bins (2 Hz apart) centred on f0: a noise density free of tone leakage. */
function noiseDensity(x: Float64Array, f0: number): number {
  const n = x.length;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  let p = 0;
  for (let k = -50; k <= 50; k++) {
    const c = 2 * Math.cos((2 * Math.PI * (f0 + 2 * k)) / FS);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = (x[i] ?? 0) * (w[i] ?? 0) + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    p += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return p / 101;
}

/** Frequency of the strongest tone in [lo, hi], scanned in steps of `step` Hz. */
function peakFreq(x: Float64Array, lo: number, hi: number, step: number): number {
  let best = lo;
  let bestA = -1;
  for (let f = lo; f <= hi; f += step) {
    const a = toneAmp(x, f);
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  return best;
}

/** RMS through a band-pass (Q 4) at f0, measured over [from, to). */
function narrowRms(x: Float64Array, f0: number, from: number, to: number): number {
  const bp = new Biquad();
  bp.bandpass(f0, 4, FS);
  let s = 0;
  for (let i = 0; i < to; i++) {
    const v = bp.process(x[i] ?? 0);
    if (i >= from) s += v * v;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

function bandRms(x: Float64Array, lo: number, hi: number, from: number, to: number): number {
  const hp = new Biquad();
  const lp = new Biquad();
  hp.highpass(lo, Math.SQRT1_2, FS);
  lp.lowpass(hi, Math.SQRT1_2, FS);
  let s = 0;
  for (let i = 0; i < to; i++) {
    const v = lp.process(hp.process(x[i] ?? 0));
    if (i >= from) s += v * v;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

describe('ForcedInduction — supercharger', () => {
  it('whineHz = rpm/60 × pulleyRatio × gearRatio × 2·lobes for roots (fixture order 19.2)', () => {
    const fi = configured(scDef());
    expect(fi.whineHz(6000)).toBeCloseTo(1920, 9);
    expect(fi.whineHz(3000)).toBeCloseTo(960, 9);
    expect(fi.whineHz(0)).toBe(0);
  });

  it('uses male-rotor lobes (no ×2) for twin-screw, and the gear step-up', () => {
    const def = scDef();
    def.spec.aspiration.supercharger = { kind: 'twin-screw', pulleyRatio: 2, gearRatio: 1.5, lobes: 3 };
    expect(configured(def).whineHz(4000)).toBeCloseTo(600, 9); // 4000/60 × 2 × 1.5 × 3
    def.spec.aspiration.supercharger = { kind: 'roots', pulleyRatio: 2.5, gearRatio: 1, lobes: 3 };
    expect(configured(def).whineHz(1200)).toBeCloseTo(300, 9); // 1200/60 × 2.5 × 1 × 6
  });

  it('whineHz is 0 for NA and turbo engines', () => {
    expect(configured(loadDef('i6-test')).whineHz(5000)).toBe(0);
    expect(configured(turboDef()).whineHz(5000)).toBe(0);
  });

  it('boost = clamp(load,0,1)·rpm/redline with no lag', () => {
    const fi = configured(scDef());
    fi.tick(3000, 0.5);
    expect(fi.boost).toBeCloseTo(0.25, 12);
    fi.tick(3000, 2);
    expect(fi.boost).toBeCloseTo(0.5, 12);
    fi.tick(6000, 1);
    expect(fi.boost).toBeCloseTo(1, 12);
    fi.tick(3000, -1);
    expect(fi.boost).toBe(0);
  });

  it('puts its spectral peak within 0.5 % of whineHz with level ∝ boost', () => {
    const fi = configured(scDef());
    const full = render(fi, FS, 4000, 1);
    const w = fi.whineHz(4000); // 1280 Hz
    const f = peakFreq(full, 0.9 * w, 1.1 * w, 0.5);
    expect(Math.abs(f - w) / w).toBeLessThan(0.005);
    const boost = 4000 / 6000;
    expect(toneAmp(full, w)).toBeCloseTo(WHINE_AMP * boost, 2);
    fi.reset();
    const half = render(fi, FS, 4000, 0.5);
    expect(toneAmp(half, w) / toneAmp(full, w)).toBeCloseTo(0.5, 3);
  });

  it('is exactly silent at load 0', () => {
    const y = render(configured(scDef()), FS / 4, 5000, 0);
    expect(y.every((v) => v === 0)).toBe(true);
  });
});

describe('ForcedInduction — turbo', () => {
  it('spools with τ = spoolTimeS and falls with τ = 0.6·spoolTimeS; boost = shaft² (multi-call)', () => {
    const fi = configured(turboDef('bov', 'single', 0.5));
    render(fi, FS / 2, 4500, 1); // target shaft = 1 · clamp((4500 − 1500)/3000) = 1
    expect(fi.boost).toBeCloseTo((1 - Math.exp(-1)) ** 2, 2);
    render(fi, (5 * FS) / 2, 4500, 1); // 3 s total
    expect(fi.boost).toBeGreaterThan(0.99);
    const shaftAtLift = Math.sqrt(fi.boost);
    render(fi, (3 * FS) / 10, 4500, 0); // 0.3 s = one falling τ
    expect(Math.sqrt(fi.boost)).toBeCloseTo(shaftAtLift * Math.exp(-1), 2);
  });

  it('targets shaft = load · clamp((rpm − 0.25·redline)/(0.5·redline), 0, 1)', () => {
    const fi = configured(turboDef('bov', 'single', 0.1));
    render(fi, FS, 3000, 0.8); // (3000 − 1500)/3000 = 0.5 → shaft 0.4
    expect(Math.sqrt(fi.boost)).toBeCloseTo(0.4, 4);
    render(fi, FS, 1400, 1); // below 0.25·redline → 0
    expect(fi.boost).toBeLessThan(1e-12);
  });

  it('is exactly silent below 0.25·redline from rest', () => {
    const y = render(configured(turboDef()), FS / 2, 1400, 1);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('whistles at f1 = 1000 + 3000·shaft with 2·f1 at −12 dB, amplitude WHISTLE_AMP × boost', () => {
    const fi = configured(turboDef('bov', 'single', 0.2));
    render(fi, 3 * FS, 3750, 1); // target shaft 0.75 → f1 = 3250 Hz
    const shaft = Math.sqrt(fi.boost);
    const y = render(fi, FS, 3750, 1);
    const f1 = 1000 + 3000 * shaft;
    expect(Math.abs(peakFreq(y, 1000, 4500, 1) - f1)).toBeLessThan(0.005 * f1);
    const a1 = toneAmp(y, f1);
    expect(a1).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
    expect(20 * Math.log10(toneAmp(y, 2 * f1) / a1)).toBeCloseTo(-12, 0);
  });

  it('adds 4–12 kHz whoosh ∝ boost²', () => {
    // Same seed: both whoosh noise waveforms are identical up to scale, so the density ratio is exact.
    const fi = configured(turboDef('bov', 'single', 0.1));
    render(fi, FS, 6000, 1);
    const fullB = fi.boost;
    const yFull = render(fi, FS, 6000, 1);
    const fiHalf = configured(turboDef('bov', 'single', 0.1));
    render(fiHalf, FS, 6000, Math.SQRT1_2); // shaft → 1/√2 → boost 0.5
    const halfB = fiHalf.boost;
    const yHalf = render(fiHalf, FS, 6000, Math.SQRT1_2);
    const d10k = noiseDensity(yFull, 10000);
    expect(Math.sqrt(noiseDensity(yHalf, 10000) / d10k)).toBeCloseTo((halfB / fullB) ** 2, 3);
    expect(d10k).toBeGreaterThan(10 * noiseDensity(yFull, 1500));
    expect(d10k).toBeGreaterThan(3 * noiseDensity(yFull, 20000));
  });

  it('fires a 2.5 kHz BOV burst on lift above 0.4 boost, ∝ boost at lift, decaying within 0.5 s', () => {
    // Same seed and inputs: the 'bov' and 'flutter' instances are identical until the lift; their
    // difference afterwards is exactly BOV − flutter (whistle and whoosh cancel).
    const liftDiff = (spoolS: number): Float64Array => {
      const bov = configured(turboDef('bov'), 3);
      const flutter = configured(turboDef('flutter'), 3);
      const spoolN = Math.round(spoolS * FS);
      const d = new Float64Array(spoolN + FS);
      for (let i = 0; i < d.length; i++) {
        const load = i < spoolN ? 1 : 0;
        d[i] = bov.tick(6000, load) - flutter.tick(6000, load);
        if (i < spoolN && d[i] !== 0) throw new Error(`instances differ before the lift at ${i}`);
      }
      return d.subarray(spoolN);
    };
    const ms = FS / 1000;
    const full = liftDiff(3); // boost ≈ 1 at lift
    const early = narrowRms(full, 2500, 5 * ms, 60 * ms);
    expect(early).toBeGreaterThan(2 * narrowRms(full, 1000, 5 * ms, 60 * ms));
    expect(20 * Math.log10(narrowRms(full, 2500, 900 * ms, 1000 * ms) / early)).toBeLessThan(-40);
    const partial = liftDiff(0.6); // boost = (1 − e^(−1.2))² ≈ 0.49 at lift
    const ratio = narrowRms(partial, 2500, 5 * ms, 60 * ms) / early;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it('does not fire BOV/flutter when lifting below 0.4 boost (outputs identical)', () => {
    const bov = configured(turboDef('bov'), 5);
    const flutter = configured(turboDef('flutter'), 5);
    for (let i = 0; i < FS; i++) {
      const load = i < FS / 10 ? 1 : 0; // 0.1 s of spool → boost ≈ 0.03
      expect(bov.tick(6000, load)).toBe(flutter.tick(6000, load));
    }
  });

  it('re-arms only after load returns above 0.2, then fires again (multi-call)', () => {
    const fi = configured(turboDef('bov', 'single', 0.1), 9);
    const ref = configured(turboDef('flutter', 'single', 0.1), 9);
    const run = (n: number, load: number): number => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = fi.tick(6000, load) - ref.tick(6000, load);
        s += d * d;
      }
      return s;
    };
    run(FS, 1);
    const first = run(FS / 5, 0); // lift: event in both (bov vs flutter) → outputs differ
    expect(first).toBeGreaterThan(0);
    run(FS, 0); // let both decay
    run(FS / 5, 0.15); // below re-arm (shaft follows load but no new lift event possible)
    run(FS, 0);
    const quiet = run(FS / 5, 0.05);
    expect(quiet).toBeLessThan(1e-12 * first);
    run(FS, 1); // re-arm + spool
    const second = run(FS / 5, 0);
    expect(second).toBeGreaterThan(0.1 * first);
  });

  it("modulates the whoosh at 14 Hz after lift with lift = 'flutter' (and not with 'bov')", () => {
    // RMS above 5 kHz in 10 ms windows centred on the AM peaks vs. the following AM nulls (cycles 2–6).
    const peakToNull = (lift: LiftEvent): number => {
      const fi = configured(turboDef(lift), 4);
      const spoolN = 3 * FS;
      const y = new Float64Array(spoolN + FS);
      for (let i = 0; i < y.length; i++) y[i] = fi.tick(6000, i < spoolN ? 1 : 0);
      const win = FS / 100;
      let peaks = 0;
      let nulls = 0;
      for (let k = 2; k <= 6; k++) {
        const pk = spoolN + Math.round(((k + 0.5) / 14) * FS);
        const nu = spoolN + Math.round(((k + 1) / 14) * FS);
        peaks += bandRms(y, 5000, 20000, pk - win / 2, pk + win / 2);
        nulls += bandRms(y, 5000, 20000, nu - win / 2, nu + win / 2);
      }
      return peaks / nulls;
    };
    expect(peakToNull('flutter')).toBeGreaterThan(3);
    expect(peakToNull('bov')).toBeLessThan(2);
  });

  it('sequential: the second whistle voice (0.88·f1) enters above 0.55·redline', () => {
    const fi = configured(turboDef('bov', 'sequential', 0.1));
    render(fi, FS, 3000, 1); // 0.5·redline → shaft 0.5 → f1 = 2500, voice 2 (2200 Hz) off
    let y = render(fi, FS, 3000, 1);
    expect(toneAmp(y, 2500)).toBeGreaterThan(0.05);
    expect(toneAmp(y, 0.88 * 2500)).toBeLessThan(1e-3);
    render(fi, FS, 4800, 1); // 0.8·redline → shaft 1 → f1 = 4000, voice 2 at 3520 Hz full
    y = render(fi, FS, 4800, 1);
    const f1 = 1000 + 3000 * Math.sqrt(fi.boost);
    expect(toneAmp(y, 0.88 * f1)).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
    expect(toneAmp(y, f1)).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
  });

  it('parallel: two half-level voices at f1 and 1.012·f1', () => {
    const fi = configured(turboDef('bov', 'parallel', 0.1));
    render(fi, 2 * FS, 6000, 1);
    const y = render(fi, FS, 6000, 1);
    const f1 = 1000 + 3000 * Math.sqrt(fi.boost);
    expect(toneAmp(y, f1)).toBeCloseTo(0.5 * WHISTLE_AMP * fi.boost, 2);
    expect(toneAmp(y, 1.012 * f1)).toBeCloseTo(0.5 * WHISTLE_AMP * fi.boost, 2);
  });
});

describe('ForcedInduction — common', () => {
  it('NA engines output exactly 0 with boost 0', () => {
    const fi = configured(loadDef('i6-test'));
    for (let i = 0; i < 1000; i++) expect(fi.tick(7000, 1)).toBe(0);
    expect(fi.boost).toBe(0);
  });

  it('is deterministic per seed and reset() replays the sequence', () => {
    const fi = configured(turboDef('bov', 'single', 0.2), 17);
    const a = Array.from(render(fi, 6000, 5500, 1));
    fi.reset();
    expect(Array.from(render(fi, 6000, 5500, 1))).toEqual(a);
    expect(Array.from(render(configured(turboDef('bov', 'single', 0.2), 18), 6000, 5500, 1))).not.toEqual(a);
  });
});
```

- [ ] **Step 10: Run the forced-induction test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-forced.test.ts`
Expected: FAIL. `Error: Cannot find module '../../src/dsp/forced' imported from …/tests/unit/dsp-forced.test.ts`.

- [ ] **Step 11: Implement `src/dsp/forced.ts`**

Create `src/dsp/forced.ts`:

```ts
import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, flush, Rng, smoothstep } from './util';

/** Whistle sine amplitude at boost 1 (single voice). */
export const WHISTLE_AMP = 0.25;
/** Second whistle harmonic (2·f1) relative to f1: −12 dB. */
export const WHISTLE_H2 = 0.2512;
/** Whoosh RMS at boost 1 (whoosh level ∝ boost²). */
export const WHOOSH_RMS = 0.1;
/** Whoosh band (contract: 4–12 kHz): 2nd-order Butterworth HP at LO cascaded with LP at HI. */
export const WHOOSH_LO_HZ = 4000;
export const WHOOSH_HI_HZ = 12000;
/** Lift detection (contract): load drops below LIFT_LOAD while boost > LIFT_MIN_BOOST. Re-arms when load ≥ LIFT_REARM_LOAD. */
export const LIFT_LOAD = 0.1;
export const LIFT_MIN_BOOST = 0.4;
export const LIFT_REARM_LOAD = 0.2;
/** Blow-off valve burst: band-passed noise at 2.5 kHz, 5 ms linear attack, −60 dB after 0.5 s. RMS = BOV_RMS × boost at lift. */
export const BOV_HZ = 2500;
export const BOV_Q = 1.2;
export const BOV_ATTACK_S = 0.005;
export const BOV_DECAY_S = 0.5;
export const BOV_RMS = 0.3;
/** Compressor flutter: whoosh-band noise AM at 14 Hz, −60 dB after 0.8 s. RMS ≈ FLUTTER_RMS × boost at lift. */
export const FLUTTER_HZ = 14;
export const FLUTTER_DECAY_S = 0.8;
export const FLUTTER_RMS = 0.2;
/** Supercharger whine amplitude at boost 1, and its 2nd harmonic relative level (−10 dB). */
export const WHINE_AMP = 0.4;
export const WHINE_H2 = 0.316;
/** Sequential turbos: the secondary voice fades in over [SEQ_ENTRY, SEQ_FULL]·redline at SEQ_RATIO × f1. */
export const SEQ_ENTRY = 0.55;
export const SEQ_FULL = 0.65;
export const SEQ_RATIO = 0.88;
/** Parallel turbos: two half-level voices, the second at PARALLEL_RATIO × f1 (slow beating). */
export const PARALLEL_RATIO = 1.012;

const MODE_NONE = 0;
const MODE_TURBO = 1;
const MODE_SC = 2;
const TWO_PI = 2 * Math.PI;
/** Envelopes below this are snapped to 0 (−120 dB) so idle bursts cost nothing. */
const ENV_FLOOR = 1e-6;
/** 1 / RMS of the AM shape 0.5·(1 − cos θ) (= 1/√0.375), so flutter RMS = FLUTTER_RMS × boost at lift. */
const FLUTTER_AM_NORM = 1 / Math.sqrt(0.375);
/** Below this boost the whistle sines are skipped (−240 dB). */
const TONE_FLOOR = 1e-12;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x3c4d5e6;

/**
 * Forced-induction bus (spec §5.3.8). Turbo: lagging shaft state → whistle (f1 = 1000 + 3000·shaft Hz
 * and 2·f1 at −12 dB, × boost) + whoosh (4–12 kHz noise × boost²) + BOV / flutter on lift.
 * Supercharger: whine at rpm/60 × pulleyRatio·gearRatio·(roots ? 2·lobes : lobes), level ∝ boost, no lag.
 * Every turbo tick draws exactly two random numbers, so the noise sequence never depends on events.
 */
export class ForcedInduction {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly whooshHp = new Biquad();
  private readonly whooshLp = new Biquad();
  private readonly bovBp = new Biquad();
  private readonly whooshScale: number;
  private readonly bovScale: number;
  private readonly bovDecay: number;
  private readonly flutterDecay: number;
  private readonly bovAttackN: number;
  private readonly maxToneHz: number;
  private seedValue = 1;
  private mode = MODE_NONE;
  private redline = 1;
  private whineOrder = 0;
  private kRise = 1;
  private kFall = 1;
  private lift: 0 | 1 = 0; // 0 = bov, 1 = flutter
  private v1Amp = 1;
  private v2Ratio = 1;
  private v2Seq = false;
  private v2Parallel = false;
  // state
  private shaft = 0;
  private boostV = 0;
  private ph1 = 0;
  private ph2 = 0;
  private armed = false;
  private bovEnv = 0;
  private bovFrom = 0;
  private bovPeak = 0;
  private bovPos = 0;
  private flEnv = 0;
  private flPh = 0;
  private inRpm = 0;
  private inLoad = 0;
  private y = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.whooshHp.highpass(WHOOSH_LO_HZ, Math.SQRT1_2, fs);
    this.whooshLp.lowpass(Math.min(WHOOSH_HI_HZ, 0.45 * fs), Math.SQRT1_2, fs);
    this.bovBp.bandpass(BOV_HZ, BOV_Q, fs);
    // Normalise both noise paths to unit RMS for uniform noise: measure the whoosh chain's
    // impulse-response energy once (exact for any fs); the band-pass uses the RBJ closed form.
    let e = 0;
    for (let i = 0; i < 8192; i++) {
      const h = this.whooshLp.process(this.whooshHp.process(i === 0 ? 1 : 0));
      e += h * h;
    }
    this.whooshHp.reset();
    this.whooshLp.reset();
    this.whooshScale = 1 / Math.sqrt(e / 3);
    this.bovScale = 1 / Math.sqrt(((1 / 3) * Math.PI * BOV_HZ) / (BOV_Q * fs));
    this.bovDecay = Math.pow(10, -3 / (BOV_DECAY_S * fs));
    this.flutterDecay = Math.pow(10, -3 / (FLUTTER_DECAY_S * fs));
    this.bovAttackN = Math.max(1, Math.round(BOV_ATTACK_S * fs));
    this.maxToneHz = 0.45 * fs;
  }

  /** Sets parameters and clears state (no allocation). */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    const asp = spec.aspiration;
    const fi = voicing.forcedInduction;
    this.redline = spec.rpm.redline > 0 ? spec.rpm.redline : 1;
    this.whineOrder = 0;
    this.v2Seq = false;
    this.v2Parallel = false;
    this.v1Amp = 1;
    this.v2Ratio = 1;
    if (asp.type === 'supercharger' && asp.supercharger !== null) {
      const sc = asp.supercharger;
      this.mode = MODE_SC;
      this.whineOrder = sc.pulleyRatio * sc.gearRatio * (sc.kind === 'roots' ? 2 * sc.lobes : sc.lobes);
    } else if (asp.type === 'turbo' && fi !== null) {
      this.mode = MODE_TURBO;
      const spool = fi.spoolTimeS > 1e-3 ? fi.spoolTimeS : 1e-3;
      this.kRise = 1 - Math.exp(-1 / (spool * this.fs));
      this.kFall = 1 - Math.exp(-1 / (0.6 * spool * this.fs));
      this.lift = fi.lift === 'flutter' ? 1 : 0;
      const layout = asp.turbo === null ? 'single' : asp.turbo.layout;
      if (layout === 'sequential') {
        this.v2Seq = true;
        this.v2Ratio = SEQ_RATIO;
      } else if (layout === 'parallel') {
        this.v2Parallel = true;
        this.v1Amp = 0.5;
        this.v2Ratio = PARALLEL_RATIO;
      }
    } else {
      this.mode = MODE_NONE;
    }
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. Returns the forced-induction bus sample (pre-perspective). */
  tick(rpm: number, load: number): number {
    this.inRpm = rpm;
    this.inLoad = load;
    this.step();
    return this.y;
  }

  /** 0..1: turbo shaft², supercharger clamp(load,0,1)·rpm/redline, NA 0. */
  get boost(): number {
    return this.boostV;
  }

  /** Supercharger whine frequency (Hz) for the given rpm; 0 when no supercharger is configured. */
  whineHz(rpm: number): number {
    return this.mode === MODE_SC ? (Math.max(rpm, 0) / 60) * this.whineOrder : 0;
  }

  /** Restores the post-configure state (same noise sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.whooshHp.reset();
    this.whooshLp.reset();
    this.bovBp.reset();
    this.shaft = 0;
    this.boostV = 0;
    this.ph1 = 0;
    this.ph2 = 0;
    this.armed = false;
    this.bovEnv = 0;
    this.bovFrom = 0;
    this.bovPeak = 0;
    this.bovPos = this.bovAttackN;
    this.flEnv = 0;
    this.flPh = 0;
    this.y = 0;
  }

  private step(): void {
    if (this.mode === MODE_TURBO) this.stepTurbo();
    else if (this.mode === MODE_SC) this.stepSupercharger();
    else this.y = 0;
  }

  private stepSupercharger(): void {
    const rpm = this.inRpm > 0 ? this.inRpm : 0;
    const b = clamp(clamp(this.inLoad, 0, 1) * (rpm / this.redline), 0, 1);
    this.boostV = b;
    const f = (rpm / 60) * this.whineOrder;
    this.ph1 += f / this.fs;
    this.ph1 -= Math.floor(this.ph1);
    let s = 0;
    if (f < this.maxToneHz) s = Math.sin(TWO_PI * this.ph1);
    if (2 * f < this.maxToneHz) s += WHINE_H2 * Math.sin(2 * TWO_PI * this.ph1);
    this.y = WHINE_AMP * b * s;
  }

  private stepTurbo(): void {
    const rpm = this.inRpm;
    const load = this.inLoad;
    const red = this.redline;
    // Shaft: one-pole toward the contract target, τ = spoolTimeS rising, 0.6·spoolTimeS falling.
    const target = clamp(load, 0, 1) * clamp((rpm - 0.25 * red) / (0.5 * red), 0, 1);
    const k = target > this.shaft ? this.kRise : this.kFall;
    this.shaft = flush(this.shaft + k * (target - this.shaft));
    const boost = this.shaft * this.shaft;
    this.boostV = boost;

    // Lift detection (edge-triggered with re-arm hysteresis).
    if (this.armed) {
      if (load < LIFT_LOAD) {
        this.armed = false;
        if (boost > LIFT_MIN_BOOST) {
          if (this.lift === 0) {
            this.bovFrom = this.bovEnv;
            this.bovPeak = boost;
            this.bovPos = 0;
          } else {
            this.flEnv = boost;
            this.flPh = 0;
          }
        }
      }
    } else if (load >= LIFT_REARM_LOAD) {
      this.armed = true;
    }

    // Whistle voices.
    const f1 = 1000 + 3000 * this.shaft;
    this.ph1 += f1 / this.fs;
    this.ph1 -= Math.floor(this.ph1);
    this.ph2 += (f1 * this.v2Ratio) / this.fs;
    this.ph2 -= Math.floor(this.ph2);
    let whistle = 0;
    if (boost > TONE_FLOOR) {
      whistle = this.v1Amp * (Math.sin(TWO_PI * this.ph1) + WHISTLE_H2 * Math.sin(2 * TWO_PI * this.ph1));
      if (this.v2Seq || this.v2Parallel) {
        const w2 = this.v2Seq ? smoothstep(SEQ_ENTRY * red, SEQ_FULL * red, rpm) : 0.5;
        if (w2 > 0) whistle += w2 * (Math.sin(TWO_PI * this.ph2) + WHISTLE_H2 * Math.sin(2 * TWO_PI * this.ph2));
      }
      whistle *= WHISTLE_AMP * boost;
    }

    // Noise sources: always exactly two draws per tick.
    const nw = this.whooshLp.process(this.whooshHp.process(this.rng.bipolar() * this.whooshScale));
    const nb = this.bovBp.process(this.rng.bipolar() * this.bovScale);

    // BOV envelope: linear attack from the current level, then exponential decay.
    if (this.bovPos < this.bovAttackN) {
      this.bovPos++;
      this.bovEnv = this.bovFrom + (this.bovPeak - this.bovFrom) * (this.bovPos / this.bovAttackN);
    } else if (this.bovEnv > ENV_FLOOR) {
      this.bovEnv *= this.bovDecay;
    } else {
      this.bovEnv = 0;
    }

    // Flutter: AM 0.5·(1 − cos 2π·14·t) (starts at 0, no click) under a decaying envelope.
    let flutter = 0;
    if (this.flEnv > ENV_FLOOR) {
      this.flPh += FLUTTER_HZ / this.fs;
      this.flPh -= Math.floor(this.flPh);
      flutter = this.flEnv * 0.5 * (1 - Math.cos(TWO_PI * this.flPh));
      this.flEnv *= this.flutterDecay;
    } else {
      this.flEnv = 0;
    }

    this.y = whistle + nw * (WHOOSH_RMS * boost * boost + FLUTTER_RMS * FLUTTER_AM_NORM * flutter) + nb * BOV_RMS * this.bovEnv;
  }
}
```

- [ ] **Step 12: Run the forced-induction test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-forced.test.ts`
Expected: PASS, `Tests  19 passed (19)` in about 5 s. Reference margins measured over 6 seeds:
- Whistle amplitude error ≤ 2.2e-3 (tolerance 5e-3).
- 2·f1 level −12 ± 0.3 dB (tolerance ±0.5).
- BOV 2.5 kHz : 1 kHz band ratio 2.8–3.6 (asserted > 2); BOV late decay ≈ −81 dB (asserted < −40).
- Flutter peak/null ratio ≈ 5.5, versus ≈ 1.45 for `'bov'` (asserted > 3 and < 2).
- The whoosh density ratio is exact (0.2500), because both instances share one noise waveform.

- [ ] **Step 13: Write the failing test for `OverrunLayer`**

Create `tests/unit/dsp-overrun.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef } from '../../src/contracts';
import { AIRFLOW_RMS, OverrunLayer, POP_AMP_MAX, POP_AMP_MIN, POP_MAX_PENDING } from '../../src/dsp/overrun';

const FS = 48000;
const POP_N = Math.round(0.001 * FS); // 48-sample pop window at 48 kHz

function loadDef(id: string): EngineDef {
  return JSON.parse(readFileSync(new URL(`../fixtures/engines/${id}.json`, import.meta.url), 'utf8')) as EngineDef;
}

/** i4-test with redline 6000 and the given crackle rate. */
function makeLayer(seed: number, crackleRate = 2): OverrunLayer {
  const def = loadDef('i4-test');
  def.spec.rpm.redline = 6000;
  def.voicing.overrun = { crackleRate, fuelCutResumeRpm: 1300 };
  const layer = new OverrunLayer(FS);
  layer.configure(def.spec, def.voicing, seed);
  return layer;
}

interface Run {
  pops: Float64Array;
  air: Float64Array;
}

function run(layer: OverrunLayer, n: number, regime: number, falling: boolean, valve = 0, mode = 1, rpm = 4000): Run {
  const pops = new Float64Array(n);
  const air = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    layer.tick(regime, rpm, falling, valve, mode, 0);
    pops[i] = layer.popInject;
    air[i] = layer.airflow;
  }
  return { pops, air };
}

/** Pop onsets: a non-zero sample preceded by a zero sample (pops are separated by ≥ 1 zero). */
function onsets(x: Float64Array, from = 0, to = x.length): number {
  let c = 0;
  for (let i = from; i < to; i++) if ((x[i] ?? 0) !== 0 && (i === 0 || (x[i - 1] ?? 0) === 0)) c++;
  return c;
}

function meanPops(seeds: number, n: number, valve: number, mode: number): number {
  let total = 0;
  for (let s = 1; s <= seeds; s++) total += onsets(run(makeLayer(s), n, 1, true, valve, mode).pops);
  return total / seeds;
}

function rms(x: Float64Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, x.length - from));
}

describe('OverrunLayer — pops', () => {
  it('never pops while regime is 0 or rpm is not falling (no ignition-cut pops)', () => {
    expect(run(makeLayer(1, 5), 2 * FS, 0, true).pops.every((v) => v === 0)).toBe(true);
    expect(run(makeLayer(1, 5), 2 * FS, 1, false).pops.every((v) => v === 0)).toBe(true);
    expect(run(makeLayer(1, 5), 2 * FS, 1, true, 1, 0).pops.every((v) => v === 0)).toBe(true); // modeFactor 0
  });

  it('shapes every pop as a 1 ms raised cosine with peak amplitude in [0.3, 1.0]', () => {
    const { pops } = run(makeLayer(2, 5), 4 * FS, 1, true, 1, 1);
    let checked = 0;
    for (let i = 1; i < pops.length - POP_N; i++) {
      if ((pops[i] ?? 0) === 0 || (pops[i - 1] ?? 0) !== 0) continue;
      const w = pops.subarray(i, i + POP_N);
      expect(w.every((v) => v > 0 && v <= 1)).toBe(true);
      expect(pops[i + POP_N]).toBe(0);
      for (let k = 0; k < POP_N / 2; k++) expect(w[k] ?? NaN).toBeCloseTo(w[POP_N - 1 - k] ?? NaN, 12);
      const peak = Math.max(...w);
      expect(peak).toBeGreaterThan(POP_AMP_MIN * 0.99);
      expect(peak).toBeLessThanOrEqual(POP_AMP_MAX);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('follows λ = crackleRate·4·(1 + 1.5·valve)·modeFactor·regime·e^(−t/1.5) (mean over seeds)', () => {
    const expected = 2 * 4 * 1.5 * (1 - Math.exp(-4 / 1.5)); // ≈ 11.17 pops in 4 s
    const closed = meanPops(40, 4 * FS, 0, 1);
    expect(closed).toBeGreaterThan(0.85 * expected);
    expect(closed).toBeLessThan(1.15 * expected);
    const open = meanPops(40, 4 * FS, 1, 1);
    expect(open / closed).toBeGreaterThan(2.0);
    expect(open / closed).toBeLessThan(3.0);
    const sport = meanPops(40, 4 * FS, 0, 1.5);
    expect(sport / closed).toBeGreaterThan(1.2);
    expect(sport / closed).toBeLessThan(1.8);
  });

  it('decays the rate with τ = 1.5 s since the overrun started', () => {
    let first = 0;
    let second = 0;
    for (let s = 1; s <= 60; s++) {
      const { pops } = run(makeLayer(s), 3 * FS, 1, true);
      first += onsets(pops, 0, 1.5 * FS);
      second += onsets(pops, 1.5 * FS, 3 * FS);
    }
    expect(first / second).toBeGreaterThan(2.0); // expected e ≈ 2.72
    expect(first / second).toBeLessThan(3.6);
  });

  it('restarts the decay at a new overrun episode (multi-call)', () => {
    let restarted = 0;
    for (let s = 1; s <= 40; s++) {
      const layer = makeLayer(s);
      run(layer, 3 * FS, 1, true); // episode 1: decays to e^(−2)
      run(layer, FS / 10, 0, true); // regime 0 ends the episode
      restarted += onsets(run(layer, FS, 1, true).pops);
    }
    // Restarted: 8·1.5·(1 − e^(−2/3)) ≈ 5.8 per run; continuing the old decay would give ≈ 0.7.
    expect(restarted / 40).toBeGreaterThan(4);
  });

  it('plays ignition-cut pops immediately, one window each, separated, capped at 8 queued', () => {
    const layer = makeLayer(3, 0);
    layer.tick(0, 4000, false, 0, 1, 3);
    const out = new Float64Array(FS / 10);
    out[0] = layer.popInject;
    for (let i = 1; i < out.length; i++) {
      layer.tick(0, 4000, false, 0, 1, 0);
      out[i] = layer.popInject;
    }
    expect(out[0]).toBeGreaterThan(0); // immediate
    expect(onsets(out)).toBe(3);
    const many = makeLayer(4, 0);
    many.tick(0, 4000, false, 0, 1, 20);
    const burst = new Float64Array(FS / 5);
    burst[0] = many.popInject;
    for (let i = 1; i < burst.length; i++) {
      many.tick(0, 4000, false, 0, 1, 0);
      burst[i] = many.popInject;
    }
    expect(onsets(burst)).toBe(POP_MAX_PENDING);
  });
});

describe('OverrunLayer — airflow', () => {
  it('is exactly 0 at regime 0', () => {
    expect(run(makeLayer(5), FS, 0, true).air.every((v) => v === 0)).toBe(true);
  });

  it('has RMS ≈ AIRFLOW_RMS · regime · rpm/redline', () => {
    for (const [regime, rpm] of [
      [1, 6000],
      [0.5, 6000],
      [1, 3000],
    ] as const) {
      const r = rms(run(makeLayer(6), 2 * FS, regime, false, 0, 1, rpm).air, FS / 10);
      const expected = AIRFLOW_RMS * regime * (rpm / 6000);
      expect(r).toBeGreaterThan(0.85 * expected);
      expect(r).toBeLessThan(1.15 * expected);
    }
  });

  it('is low-passed at 1.2 kHz', () => {
    const { air } = run(makeLayer(7), 2 * FS, 1, false, 0, 1, 6000);
    let lo = 0;
    let hi = 0;
    // First difference emphasises highs: for a 1.2 kHz LP its RMS is far below the signal RMS.
    for (let i = 1; i < air.length; i++) {
      lo += (air[i] ?? 0) ** 2;
      hi += ((air[i] ?? 0) - (air[i - 1] ?? 0)) ** 2;
    }
    expect(Math.sqrt(hi / lo)).toBeLessThan(0.25); // white noise would give √2
  });
});

describe('OverrunLayer — determinism', () => {
  it('is deterministic per seed and reset() replays the sequence', () => {
    const layer = makeLayer(9, 5);
    const a = run(layer, FS, 1, true, 1, 1);
    layer.reset();
    const b = run(layer, FS, 1, true, 1, 1);
    expect(Array.from(b.pops)).toEqual(Array.from(a.pops));
    expect(Array.from(b.air)).toEqual(Array.from(a.air));
    const c = run(makeLayer(10, 5), FS, 1, true, 1, 1);
    expect(Array.from(c.air)).not.toEqual(Array.from(a.air));
  });
});
```

- [ ] **Step 14: Run the overrun test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-overrun.test.ts`
Expected: FAIL. `Error: Cannot find module '../../src/dsp/overrun' imported from …/tests/unit/dsp-overrun.test.ts`.

- [ ] **Step 15: Implement `src/dsp/overrun.ts`**

Create `src/dsp/overrun.ts`:

```ts
import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, flush, Rng } from './util';

/** Contract: λ = crackleRate·4·(valveOpen ? 2.5 : 1)·modeFactor·regime events/s, × e^(−t/1.5 s). */
export const POP_RATE_PER_CRACKLE = 4;
/** Valve factor at valveOpen01 = 1; interpolated linearly: 1 + (POP_VALVE_FACTOR − 1)·valveOpen01. */
export const POP_VALVE_FACTOR = 2.5;
export const POP_DECAY_TAU_S = 1.5;
/** Each pop: amplitude uniform in [POP_AMP_MIN, POP_AMP_MAX] × a raised-cosine window POP_LEN_S long. */
export const POP_LEN_S = 0.001;
export const POP_AMP_MIN = 0.3;
export const POP_AMP_MAX = 1.0;
/** Queued pops (Poisson arrivals during a pop + ignition-cut pops) are capped at this count. */
export const POP_MAX_PENDING = 8;
/** An overrun episode starts when regime rises above ENTER (decay timer restarts) and ends below EXIT. */
export const OVERRUN_ENTER = 0.1;
export const OVERRUN_EXIT = 0.02;
/** Airflow: noise → 2nd-order Butterworth LP at AIRFLOW_LP_HZ; RMS = AIRFLOW_RMS · regime · rpm/redline. */
export const AIRFLOW_LP_HZ = 1200;
export const AIRFLOW_RMS = 0.1;
/** rpm/redline is capped here so a wild rpm cannot blow the airflow level up. */
const AIRFLOW_RPM_CAP = 2;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x4d5e6f7;

/**
 * Overrun layer (spec §5.3.3, §5.3.9): Poisson exhaust pops while in overrun with rpm falling, plus
 * immediate pops for ignition-cut skipped firings; and overrun airflow noise.
 * Pops never overlap: each plays its full window, then ≥ 1 zero sample before the next queued pop.
 */
export class OverrunLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly lp = new Biquad();
  private readonly shape: Float64Array;
  private readonly popLen: number;
  private readonly decayStep: number;
  private readonly airScale: number;
  private seedValue = 1;
  private crackle = 0;
  private redline = 1;
  // state
  private inOverrun = false;
  private decay = 0;
  private pending = 0;
  private popPos = 0;
  private popAmp = 0;
  private gap = 0;
  private popOut = 0;
  private airOut = 0;
  private inRegime = 0;
  private inRpm = 0;
  private inFalling = false;
  private inValve = 0;
  private inMode = 1;
  private inCut = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.popLen = Math.max(2, Math.round(POP_LEN_S * fs));
    this.shape = new Float64Array(this.popLen);
    for (let k = 0; k < this.popLen; k++) {
      this.shape[k] = 0.5 * (1 - Math.cos((2 * Math.PI * (k + 0.5)) / this.popLen));
    }
    this.decayStep = Math.exp(-1 / (POP_DECAY_TAU_S * fs));
    const fc = Math.min(AIRFLOW_LP_HZ, 0.45 * fs);
    this.lp.lowpass(fc, Math.SQRT1_2, fs);
    // 2nd-order Butterworth LP noise bandwidth = fc·π/(2√2); uniform noise variance 1/3.
    this.airScale = AIRFLOW_RMS / Math.sqrt(((1 / 3) * 2 * ((Math.PI / (2 * Math.SQRT2)) * fc)) / fs);
    this.popPos = this.popLen;
  }

  /** Sets parameters and clears state (no allocation). */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    this.crackle = Math.max(0, voicing.overrun.crackleRate);
    this.redline = spec.rpm.redline > 0 ? spec.rpm.redline : 1;
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. regime = 0 combustion … 1 overrun (already smoothstepped + slewed by the caller). */
  tick(regime: number, rpm: number, falling: boolean, valveOpen01: number, modeFactor: number, ignitionCutPops: number): void {
    this.inRegime = regime;
    this.inRpm = rpm;
    this.inFalling = falling;
    this.inValve = valveOpen01;
    this.inMode = modeFactor;
    this.inCut = ignitionCutPops;
    this.step();
  }

  /** Pop impulse sample for ExhaustNetwork.tick(headerIn, popIn); 0 ≤ popInject ≤ 1. */
  get popInject(): number {
    return this.popOut;
  }

  /** Overrun airflow noise sample (perspective-mixed with the exhaust). */
  get airflow(): number {
    return this.airOut;
  }

  /** Restores the post-configure state (same random sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.lp.reset();
    this.inOverrun = false;
    this.decay = 0;
    this.pending = 0;
    this.popPos = this.popLen;
    this.popAmp = 0;
    this.gap = 0;
    this.popOut = 0;
    this.airOut = 0;
  }

  private step(): void {
    const regime = clamp(this.inRegime, 0, 1);

    // Overrun episode: the pop-rate decay restarts at each overrun start.
    if (!this.inOverrun) {
      if (regime > OVERRUN_ENTER) {
        this.inOverrun = true;
        this.decay = 1;
      }
    } else if (regime < OVERRUN_EXIT) {
      this.inOverrun = false;
      this.decay = 0;
    } else {
      this.decay = flush(this.decay * this.decayStep);
    }

    // Poisson arrivals (one uniform draw every sample keeps the sequence input-independent).
    const u = this.rng.next();
    if (this.inOverrun && this.inFalling) {
      const valve = clamp(this.inValve, 0, 1);
      const mode = this.inMode > 0 ? this.inMode : 0;
      const lambda = this.crackle * POP_RATE_PER_CRACKLE * (1 + (POP_VALVE_FACTOR - 1) * valve) * mode * regime * this.decay;
      if (u < lambda / this.fs && this.pending < POP_MAX_PENDING) this.pending++;
    }
    if (this.inCut > 0) {
      this.pending = Math.min(POP_MAX_PENDING, this.pending + Math.floor(this.inCut));
    }

    // Pop playback: window, then a 1-sample gap, then the next queued pop.
    if (this.popPos < this.popLen) {
      this.popOut = this.popAmp * (this.shape[this.popPos] ?? 0);
      this.popPos++;
      if (this.popPos === this.popLen) this.gap = 1;
    } else if (this.gap > 0) {
      this.gap--;
      this.popOut = 0;
    } else if (this.pending > 0) {
      this.pending--;
      this.popAmp = POP_AMP_MIN + (POP_AMP_MAX - POP_AMP_MIN) * this.rng.next();
      this.popOut = this.popAmp * (this.shape[0] ?? 0);
      this.popPos = 1;
    } else {
      this.popOut = 0;
    }

    // Airflow noise.
    const n = this.lp.process(this.rng.bipolar() * this.airScale);
    const rpmFrac = clamp(this.inRpm / this.redline, 0, AIRFLOW_RPM_CAP);
    this.airOut = n * regime * rpmFrac;
  }
}
```

- [ ] **Step 16: Run the overrun test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-overrun.test.ts`
Expected: PASS, `Tests  10 passed (10)`. Reference values over 4 independent seed sets:
- Mean pops / expected: 0.98–1.07 (bounds 0.85–1.15).
- Open/closed ratio: 2.40–2.45 (bounds 2.0–3.0). It sits below 2.5 because both runs share seeds.
- Sport/closed ratio: 1.41–1.48 (bounds 1.2–1.8).
- First/second 1.5 s ratio: 2.48–2.69 (bounds 2.0–3.6).

- [ ] **Step 17: Run all four layer suites together**

Run: `npx vitest run tests/unit/dsp-intake.test.ts tests/unit/dsp-mechanical.test.ts tests/unit/dsp-forced.test.ts tests/unit/dsp-overrun.test.ts`
Expected: PASS, `Test Files  4 passed (4)`, `Tests  44 passed (44)`.

- [ ] **Step 18: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no output beyond the script headers.
- The per-sample methods (`tick`, private `step`/`stepTurbo`/`stepSupercharger`) contain no `new`, array/object literals, closures, spread, template literals, `try` or `throw`. T10's amendment-B1 rule therefore reports nothing for these files, and nothing needs changing when T10 adds it.
- If `@typescript-eslint` flags anything in the tests, fix the test code only. The `src/dsp/*.ts` files above are lint-clean under `@eslint/js` recommended + `typescript-eslint` recommended + the B1 selector.

---

### Task 7: Perspective mixer and output stage (trim, NaN guard, DC block, bass management + virtual bass, compressor, true-peak limiter, clip)

**Files:**
- Create: `src/dsp/perspective.ts`
- Create: `src/dsp/output-stage.ts`
- Test: `tests/unit/dsp-perspective.test.ts`
- Test: `tests/unit/dsp-output-stage.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts` (LOCKED): `type EngineVoicing`, `type Perspective`, `type OutputConfig`, `DEFAULT_OUTPUT` (= `{ subwoofer: 'unsure', hpCornerHz: 40, volumeTrimDb: 0 }`); tests also use `type EngineDef`, `type Subwoofer`.
  - T1 `src/dsp/util.ts`:
    - `flush(x: number): number`
    - `clamp(x: number, lo: number, hi: number): number`
    - `dbToGain(db: number): number`
    - `gainToDb(g: number): number` (g ≤ 0 → −200)
    - `smoothstep(e0: number, e1: number, x: number): number`
  - T1 `src/dsp/biquad.ts`:
    - `class Biquad { lowpass(f: number, q: number, fs: number): void; highpass(f: number, q: number, fs: number): void; process(x: number): number; reset(): void }`
    - `BUTTER4_Q: readonly [number, number]`
    - `class Cascade { constructor(stages: number); stage(i: number): Biquad; process(x: number): number; reset(): void }`
  - T1 `src/dsp/oversample.ts`: `OS_TAPS: Float64Array`; `class Upsampler4 { reset(): void; push(x: number): void; readonly out: Float64Array }`.
  - T1 fixture (perspective test only): `tests/fixtures/engines/i4-test.json`.
- Produces (exact exports; T9 `dsp-core.ts` and T10 tools rely on them):

```ts
// Summary of the exports (each constant is its own `export const` in the file).
// src/dsp/perspective.ts
export const PERSPECTIVE_XFADE_S = 0.3, CABIN_BLOCK_LP_HZ = 250, CABIN_FI_LP_HZ = 2800,
  DEFAULT_CABIN_FI_GAIN_DB = -14, OUTSIDE_INTAKE = 0.7, OUTSIDE_BLOCK = 0.3, STEREO_WIDTH = 0.08, STEREO_DELAY_S = 0.0007;
export class PerspectiveMixer {
  constructor(fs: number);
  configure(voicing: EngineVoicing): void;          // sets filters, snaps the crossfade to the target, clears state
  setPerspective(p: Perspective): void;             // 300 ms crossfade; idempotent; default 'cabin'
  tick(exhaust: number, intake: number, block: number, fi: number, airflow: number): void;
  get l(): number; get r(): number;                 // contract `readonly l / r`
  reset(): void;                                    // clears state, snaps the crossfade to the target
}
// src/dsp/output-stage.ts
export const OUTPUT_CEILING = 0.8913, LIMITER_TARGET_DBTP = -1.3, LIMITER_LOOKAHEAD_S = 0.0015, LIMITER_RELEASE_S = 0.05,
  COMP_THRESHOLD_DB = -12, COMP_RATIO = 3, COMP_KNEE_DB = 6, COMP_ATTACK_S = 0.005, COMP_RELEASE_S = 0.12,
  DC_BLOCK_HZ = 5, SUB_HP_HZ = 22, HP_CORNER_MIN_HZ = 30, HP_CORNER_MAX_HZ = 60, TRIM_MIN_DB = -120, TRIM_MAX_DB = 6,
  NAN_GUARD_LIMIT = 1e6, VB_ENV_RELEASE_S = 0.1;
export class OutputStage {
  constructor(fs: number);                          // allocates everything; calls configure(DEFAULT_OUTPUT)
  configure(out: OutputConfig): void;               // bass mode, clamp(hpCornerHz, 30, 60) (non-finite → 40), trim snaps to volumeTrimDb, clears state
  beginQuantum(trimDb: number, frames: number): void; // once per quantum, before its process() calls
  process(l: number, r: number): void;
  get l(): number; get r(): number;                 // output, delayed by round(1.5 ms · fs) samples (72 @ 48 kHz)
  get truePeakDbtp(): number;                       // max output true peak since takeTruePeak(); −200 when silent
  takeTruePeak(): number;                           // returns it and resets the max
  get gainReductionDb(): number;                    // limiter gain reduction at the last sample, ≥ 0 dB
  nonFiniteCount: number;                           // guard + clip catches; NOT cleared by reset()
  reset(): void;                                    // clears filters, envelopes, look-ahead buffers, meters; completes a trim ramp
}
```

  - `PerspectiveMixer` mix:
    - Both perspectives are computed every sample, so the filters stay warm.
    - Crossfade: a linear 300 ms ramp shaped by `smoothstep`. A new target reverses the ramp from where it is. At the endpoints the output equals the pure perspective bit for bit.
    - Stereo: `l = m + 0.08·d`, `r = m − 0.08·d`, with `d = m` delayed by `round(0.7 ms·fs)` samples, so `l + r = 2m`.
    - With no `voicing.forcedInduction`, the cabin FI gain is −14 dB.
    - `block` is the whole `MechanicalLayer` output. In the cabin it passes the 250 Hz LP; outside it is weighted ×0.3.
  - `OutputStage` trim:
    - `trimDb` is clamped to [−120, +6] dB. A NaN `trimDb` keeps the previous trim.
    - The ramp is linear in gain, from the gain at the call to the target, landing exactly on the target at sample `frames`.
    - The virtual-bass equal-loudness gain is recomputed from `trimDb` in every `beginQuantum`.
  - `OutputStage` compressor and limiter:
    - Compressor: a smooth decoupled peak detector on the gain reduction (Giannoulis, Massberg & Reiss 2012), release stage then attack stage. A steady 0 dBFS sine leaves at −8.0 dBFS.
    - Limiter target: −1.3 dBTP (amendment B9). Stress-tested worst case: −1.298 dBTP over 160 random signals with trims −24…+6 dB at 48 and 44.1 kHz; the 0.8913 clip never engaged.
    - Quiet skip: below ≈ −5.3 dBFS (after the compressor) the limiter skips its `Upsampler4` pushes. This is exact: it was verified bit-identical over 3.07 M samples.
    - Meter: exact to < 0.1 dB near the ceiling; reads the sample peak in quiet passages.
  - Measured cost on the authoring machine, in ns/sample:
    - `PerspectiveMixer`: 83.
    - `OutputStage`: 142–197 with a subwoofer and 294–360 without one (the 14 biquads of the 4th-order HP/LP and virtual-bass band-pass).
  - Combined with the T6 layers: 74 µs per 128-frame quantum (36× realtime), 0.012 % of audio time in GC, max pause ≤ 0.7 ms (amendment B2).
  - Contains the Review Focus tests **RF4** (`dsp-output-stage.test.ts` › "RF4: true-peak ceiling at +6 dB trim") and **RF5** (`dsp-perspective.test.ts` › "RF5: toggling perspective every 50 ms…").

**Cross-task premises:** (open each named file and confirm every bullet before coding)
- T1 `src/dsp/util.ts`:
  - `dbToGain(db) = 10^(db/20)`.
  - `gainToDb(g) = 20·log10(g)` for g > 0, and exactly −200 for g ≤ 0. The tests assert `truePeakDbtp === -200` after `reset()`.
  - `smoothstep(0, 1, w) = w²(3 − 2w)`, returning exactly 0 at w = 0 and exactly 1 at w = 1.
  - `flush` and `clamp` as in Task 6.
- T1 `src/dsp/biquad.ts`:
  - `new Biquad()` and `new Cascade(2)` take no other arguments.
  - `Cascade.stage(i)` returns the live `Biquad`, and `Cascade.process` applies the stages in index order.
  - Setting coefficients never allocates. `reset()` clears state and keeps the coefficients.
  - `BUTTER4_Q = [0.5411961, 1.3065630]`: two stages with these Qs at the same corner form a 4th-order Butterworth.
- T1 `src/dsp/oversample.ts`:
  - `new Upsampler4()` takes no arguments. After `push(x)`, `out` (length `OS_FACTOR` = 4) holds the 4 interpolated samples for that input.
  - It is a linear-phase FIR built from the 48 `OS_TAPS`. Its outputs depend only on the last ≤ 48 pushed inputs; the constructor measures the exact memory and worst-case phase gain from an impulse.
  - Group delay is ≈ 5.875 input samples, so the interval after input m is detected at push ≈ m + 6. The limiter covers m − 1…m + 9, so ±2 samples of difference are harmless; the tests were also run with the output phase order reversed.
- T1 fixture: `tests/fixtures/engines/i4-test.json` is a complete `EngineDef`. The test overrides `voicing.cabin` and `voicing.forcedInduction`.
- T9 (consumer side, informational):
  - Per sample: `mixer.tick(exhaustOutlet, intake, mechanical, fiBus, overrun.airflow)` → `output.process(mixer.l, mixer.r)` → `outL[i] = output.l`, `outR[i] = output.r`.
  - Once per quantum before the loop: `output.beginQuantum(trimDb, frames)` and `mixer.setPerspective(ctl.perspective)`.
  - `stats.truePeakDbtp` comes from `output.takeTruePeak()` (it resets the max), and `stats.limiterGainReductionDb` from `output.gainReductionDb`.
  - A NaN/Inf reset calls `output.reset()` and `mixer.reset()`.

- [ ] **Step 1: Write the failing test for `PerspectiveMixer` (includes RF5)**

Create `tests/unit/dsp-perspective.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing, Perspective } from '../../src/contracts';
import { dbToGain } from '../../src/dsp/util';
import { PerspectiveMixer } from '../../src/dsp/perspective';

const FS = 48000;
const DELAY_N = Math.round(0.0007 * FS); // 34 samples

function voicing(cabinGainDb: number | null = -14, lowpassHz = 600): EngineVoicing {
  const def = JSON.parse(
    readFileSync(new URL('../fixtures/engines/i4-test.json', import.meta.url), 'utf8'),
  ) as EngineDef;
  const v = def.voicing;
  v.cabin = { lowpassHz };
  v.forcedInduction =
    cabinGainDb === null ? null : { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb };
  return v;
}

function mixer(p: Perspective, v: EngineVoicing = voicing()): PerspectiveMixer {
  const m = new PerspectiveMixer(FS);
  m.setPerspective(p);
  m.configure(v); // snaps the crossfade to the target
  return m;
}

/** Inputs as a function of the sample index. */
type Src = (i: number) => [number, number, number, number, number];

function render(m: PerspectiveMixer, n: number, src: Src, onSample?: (i: number) => void): { l: Float64Array; r: Float64Array } {
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    onSample?.(i);
    const [e, it, b, f, a] = src(i);
    m.tick(e, it, b, f, a);
    l[i] = m.l;
    r[i] = m.r;
  }
  return { l, r };
}

const dc: Src = () => [0.1, 0.2, 0.3, 0.05, 0.02];
const sine = (f: number, amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * f * i) / FS);

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel). */
function toneAmp(x: Float64Array, f: number, from: number): number {
  const n = x.length - from;
  const c = 2 * Math.cos((2 * Math.PI * f) / FS);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[from + i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

describe('PerspectiveMixer', () => {
  it('outside: exhaust + airflow + 0.7·intake + 0.3·block + fi, full band', () => {
    const { l, r } = render(mixer('outside'), 1000, dc);
    const m = 0.1 + 0.02 + 0.7 * 0.2 + 0.3 * 0.3 + 0.05;
    expect(((l[999] ?? 0) + (r[999] ?? 0)) / 2).toBeCloseTo(m, 12);
    const e = sine(4000, 0.5);
    const hf = render(mixer('outside'), FS / 2, (i) => [e(i), 0, 0, 0, 0]);
    expect(toneAmp(hf.l, 4000, 0) + toneAmp(hf.r, 4000, 0)).toBeCloseTo(2 * 0.5, 2);
  });

  it('cabin: unity-DC low-passes + fi × dbToGain(cabinGainDb)', () => {
    const { l, r } = render(mixer('cabin'), FS / 2, dc);
    const m = 0.1 + 0.02 + 0.2 + 0.3 + dbToGain(-14) * 0.05;
    expect(((l[FS / 2 - 1] ?? 0) + (r[FS / 2 - 1] ?? 0)) / 2).toBeCloseTo(m, 9);
  });

  it('cabin: 4th-order LP at cabin.lowpassHz on exhaust/intake/airflow', () => {
    const e = sine(4000, 0.5);
    const hf = render(mixer('cabin'), FS / 2, (i) => [e(i), e(i), 0, 0, e(i)]);
    expect(toneAmp(hf.l, 4000, FS / 10)).toBeLessThan(1.5 * 0.0005 * 3 * 0.5); // (600/4000)^4 ≈ 5e-4
    const lo = sine(100, 0.5);
    const lf = render(mixer('cabin'), FS, (i) => [lo(i), 0, 0, 0, 0]);
    expect((toneAmp(lf.l, 100, FS / 4) + toneAmp(lf.r, 100, FS / 4)) / 2).toBeCloseTo(0.5, 2);
  });

  it('cabin: block through a 250 Hz LP; forced induction through a 2.8 kHz LP at cabinGainDb', () => {
    const b = sine(2000, 0.5);
    const blk = render(mixer('cabin'), FS / 2, (i) => [0, 0, b(i), 0, 0]);
    expect(toneAmp(blk.l, 2000, FS / 10)).toBeLessThan(0.5 * 0.02); // ≈ (250/2000)² ≈ −36 dB
    const f = sine(1000, 1);
    const fi = render(mixer('cabin', voicing(-12)), FS / 2, (i) => [0, 0, 0, f(i), 0]);
    const amp = (toneAmp(fi.l, 1000, FS / 10) + toneAmp(fi.r, 1000, FS / 10)) / 2;
    const lp = 1 / Math.sqrt(1 + (1000 / 2800) ** 4);
    expect(amp / (dbToGain(-12) * lp)).toBeCloseTo(1, 1);
  });

  it('uses −14 dB for the cabin forced-induction gain when the voicing has none', () => {
    const { l, r } = render(mixer('cabin', voicing(null)), FS / 2, () => [0, 0, 0, 1, 0]);
    expect(((l[FS / 2 - 1] ?? 0) + (r[FS / 2 - 1] ?? 0)) / 2).toBeCloseTo(dbToGain(-14), 9);
  });

  it('stereo: l = m + 0.08·d, r = m − 0.08·d with d = m delayed 0.7 ms (mono-compatible)', () => {
    const { l, r } = render(mixer('outside'), 200, (i) => [i === 0 ? 1 : 0, 0, 0, 0, 0]);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(1);
    expect(l[DELAY_N]).toBeCloseTo(0.08, 15);
    expect(r[DELAY_N]).toBeCloseTo(-0.08, 15);
    for (let i = 1; i < 200; i++) if (i !== DELAY_N) expect(Math.abs(l[i] ?? 1)).toBe(0);
  });

  it('crossfades cabin → outside over 300 ms (smoothstep), then equals pure outside exactly', () => {
    const m = mixer('cabin');
    const ref = mixer('outside');
    const before = render(m, FS / 2, dc); // settle
    render(ref, FS / 2, dc);
    m.setPerspective('outside');
    const mid = render(m, 0.15 * FS, dc);
    const cab = ((before.l[FS / 2 - 1] ?? 0) + (before.r[FS / 2 - 1] ?? 0)) / 2;
    const out = 0.1 + 0.02 + 0.7 * 0.2 + 0.3 * 0.3 + 0.05;
    // w = 7200/14400 = 0.5 → smoothstep 0.5 → halfway (DC: delayed copy holds the same value ± ramp).
    const midM = ((mid.l[0.15 * FS - 1] ?? 0) + (mid.r[0.15 * FS - 1] ?? 0)) / 2;
    expect(midM).toBeCloseTo((cab + out) / 2, 3);
    render(m, 0.15 * FS + DELAY_N, dc);
    render(ref, 0.3 * FS + DELAY_N, dc);
    const s = sine(330, 0.4);
    const after = render(m, 2000, (i) => [s(i), s(i + 7), 0.1, 0.2 * s(i), 0]);
    const pure = render(ref, 2000, (i) => [s(i), s(i + 7), 0.1, 0.2 * s(i), 0]);
    expect(Array.from(after.l)).toEqual(Array.from(pure.l));
    expect(Array.from(after.r)).toEqual(Array.from(pure.r));
  });

  it('repeating setPerspective with the same value does not restart the crossfade', () => {
    const m = mixer('cabin');
    const ref = mixer('outside');
    render(m, 1000, dc, () => m.setPerspective('outside'));
    render(ref, 1000, dc);
    render(m, 0.3 * FS, dc, () => m.setPerspective('outside'));
    render(ref, 0.3 * FS, dc);
    const a = render(m, 500, dc);
    const b = render(ref, 500, dc);
    expect(Array.from(a.l)).toEqual(Array.from(b.l));
  });

  it('RF5: toggling perspective every 50 ms crossfades without any step > 0.1 full scale', () => {
    const e = sine(80, 0.5);
    const blk = sine(50, 0.3);
    const f = sine(1000, 0.3);
    const src: Src = (i) => [e(i), 0.2 * e(i + 13), blk(i), f(i), 0.05 * e(i + 29)];
    // Sensitivity: the two perspectives differ by far more than 0.1, so a hard switch would step.
    const cab = render(mixer('cabin'), FS, src);
    const out = render(mixer('outside'), FS, src);
    let maxDiff = 0;
    for (let i = FS / 10; i < FS; i++) maxDiff = Math.max(maxDiff, Math.abs((cab.l[i] ?? 0) - (out.l[i] ?? 0)));
    expect(maxDiff).toBeGreaterThan(0.2);

    const m = mixer('cabin');
    const toggleEvery = 0.05 * FS;
    const { l, r } = render(m, 2 * FS, src, (i) => {
      if (i > 0 && i % toggleEvery === 0) m.setPerspective((i / toggleEvery) % 2 === 1 ? 'outside' : 'cabin');
    });
    let maxStep = 0;
    for (let i = 1; i < l.length; i++) {
      maxStep = Math.max(maxStep, Math.abs((l[i] ?? 0) - (l[i - 1] ?? 0)), Math.abs((r[i] ?? 0) - (r[i - 1] ?? 0)));
    }
    expect(maxStep).toBeLessThan(0.1);
  });

  it('reset() clears state and snaps the crossfade to the target', () => {
    const m = mixer('cabin');
    render(m, 1000, dc);
    m.setPerspective('outside');
    render(m, 100, dc);
    m.reset();
    const ref = mixer('outside');
    const a = render(m, 300, dc);
    const b = render(ref, 300, dc);
    expect(Array.from(a.l)).toEqual(Array.from(b.l));
    expect(Array.from(a.r)).toEqual(Array.from(b.r));
  });
});
```

- [ ] **Step 2: Run the perspective test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-perspective.test.ts`
Expected: FAIL. `Error: Cannot find module '../../src/dsp/perspective' imported from …/tests/unit/dsp-perspective.test.ts` (`Tests  no tests`).

- [ ] **Step 3: Implement `src/dsp/perspective.ts`**

Create `src/dsp/perspective.ts`:

```ts
import type { EngineVoicing, Perspective } from '../contracts';
import { BUTTER4_Q, Biquad, Cascade } from './biquad';
import { clamp, dbToGain, smoothstep } from './util';

/** Contract: perspective changes crossfade over 300 ms. */
export const PERSPECTIVE_XFADE_S = 0.3;
/** Cabin: block weighted below ≈ 250 Hz (2nd-order Butterworth LP). */
export const CABIN_BLOCK_LP_HZ = 250;
/** Cabin: forced-induction bus through a 2nd-order Butterworth LP at 2.8 kHz × dbToGain(cabinGainDb). */
export const CABIN_FI_LP_HZ = 2800;
/** cabinGainDb used when the voicing has no forcedInduction block. */
export const DEFAULT_CABIN_FI_GAIN_DB = -14;
/** Outside weights (contract). */
export const OUTSIDE_INTAKE = 0.7;
export const OUTSIDE_BLOCK = 0.3;
/** Stereo decorrelation: l = m + STEREO_WIDTH·d, r = m − STEREO_WIDTH·d, d = m delayed STEREO_DELAY_S. */
export const STEREO_WIDTH = 0.08;
export const STEREO_DELAY_S = 0.0007;

/**
 * Listening-point mix (spec §5.3.11). Both perspectives are computed every sample (filters stay
 * warm) and crossfaded with a 300 ms linear ramp shaped by smoothstep; a new target reverses the
 * ramp from where it is, so rapid toggling never steps. Mono-compatible stereo: l + r = 2m.
 */
export class PerspectiveMixer {
  private readonly fs: number;
  private readonly cabinLp = new Cascade(2);
  private readonly blockLp = new Biquad();
  private readonly fiLp = new Biquad();
  private readonly delay: Float64Array;
  private readonly delayN: number;
  private readonly xfadeStep: number;
  private dPos = 0;
  private fiGain = 1;
  /** Crossfade position: 0 = cabin, 1 = outside. */
  private w = 0;
  private target = 0;
  private inE = 0;
  private inI = 0;
  private inB = 0;
  private inF = 0;
  private inA = 0;
  private outL = 0;
  private outR = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.delayN = Math.max(1, Math.round(STEREO_DELAY_S * fs));
    this.delay = new Float64Array(this.delayN);
    this.xfadeStep = 1 / (PERSPECTIVE_XFADE_S * fs);
  }

  /** Sets parameters, snaps the crossfade to the current target and clears state (no allocation). */
  configure(voicing: EngineVoicing): void {
    const fc = clamp(voicing.cabin.lowpassHz, 20, 0.45 * this.fs);
    this.cabinLp.stage(0).lowpass(fc, BUTTER4_Q[0], this.fs);
    this.cabinLp.stage(1).lowpass(fc, BUTTER4_Q[1], this.fs);
    this.blockLp.lowpass(CABIN_BLOCK_LP_HZ, Math.SQRT1_2, this.fs);
    this.fiLp.lowpass(Math.min(CABIN_FI_LP_HZ, 0.45 * this.fs), Math.SQRT1_2, this.fs);
    const fi = voicing.forcedInduction;
    this.fiGain = dbToGain(fi === null ? DEFAULT_CABIN_FI_GAIN_DB : fi.cabinGainDb);
    this.reset();
  }

  /** Target perspective; repeated calls with the same value are no-ops. Default 'cabin'. */
  setPerspective(p: Perspective): void {
    this.target = p === 'outside' ? 1 : 0;
  }

  /** Per sample. Results in `l` / `r`. */
  tick(exhaust: number, intake: number, block: number, fi: number, airflow: number): void {
    this.inE = exhaust;
    this.inI = intake;
    this.inB = block;
    this.inF = fi;
    this.inA = airflow;
    this.step();
  }

  get l(): number {
    return this.outL;
  }

  get r(): number {
    return this.outR;
  }

  /** Clears filter/delay state and snaps the crossfade to the target. */
  reset(): void {
    this.cabinLp.reset();
    this.blockLp.reset();
    this.fiLp.reset();
    this.delay.fill(0);
    this.dPos = 0;
    this.w = this.target;
    this.outL = 0;
    this.outR = 0;
  }

  private step(): void {
    const e = this.inE;
    const a = this.inA;
    const i = this.inI;
    const cabin =
      this.cabinLp.process(e + a + i) + this.blockLp.process(this.inB) + this.fiGain * this.fiLp.process(this.inF);
    const outside = e + a + OUTSIDE_INTAKE * i + OUTSIDE_BLOCK * this.inB + this.inF;

    const t = this.target;
    let w = this.w;
    if (w < t) {
      w += this.xfadeStep;
      if (w > t) w = t;
    } else if (w > t) {
      w -= this.xfadeStep;
      if (w < t) w = t;
    }
    this.w = w;
    const s = smoothstep(0, 1, w);
    const m = s === 0 ? cabin : s === 1 ? outside : cabin + s * (outside - cabin);

    const d = this.delay[this.dPos] ?? 0;
    this.delay[this.dPos] = m;
    this.dPos = this.dPos + 1 === this.delayN ? 0 : this.dPos + 1;
    this.outL = m + STEREO_WIDTH * d;
    this.outR = m - STEREO_WIDTH * d;
  }
}
```

- [ ] **Step 4: Run the perspective test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-perspective.test.ts`
Expected: PASS, `Tests  10 passed (10)`. In RF5, a hard switch would step by 0.32 full scale (FS) on this input, while the crossfaded output's largest sample-to-sample step is ≈ 0.018 FS; the signal's own largest step is 0.017.

- [ ] **Step 5: Write the failing test for `OutputStage` (includes RF4)**

Create `tests/unit/dsp-output-stage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { OutputConfig, Subwoofer } from '../../src/contracts';
import { OutputStage, OUTPUT_CEILING } from '../../src/dsp/output-stage';
import { Upsampler4 } from '../../src/dsp/oversample';
import { dbToGain } from '../../src/dsp/util';

const FS = 48000;
const Q = 128;
const LOOKAHEAD = Math.round(0.0015 * FS); // 72 samples

function stage(subwoofer: Subwoofer = 'yes', hpCornerHz = 40, volumeTrimDb = 0, fs = FS): OutputStage {
  const s = new OutputStage(fs);
  const cfg: OutputConfig = { subwoofer, hpCornerHz, volumeTrimDb };
  s.configure(cfg);
  return s;
}

/** Runs a stereo signal through the stage in 128-frame quanta; trim per quantum (constant or a function of the quantum index). */
function run(
  s: OutputStage,
  n: number,
  srcL: (i: number) => number,
  srcR: (i: number) => number = srcL,
  trimDb: number | ((q: number) => number) = 0,
): { l: Float64Array; r: Float64Array } {
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let q = 0; q * Q < n; q++) {
    const frames = Math.min(Q, n - q * Q);
    s.beginQuantum(typeof trimDb === 'number' ? trimDb : trimDb(q), frames);
    for (let k = 0; k < frames; k++) {
      const i = q * Q + k;
      s.process(srcL(i), srcR(i));
      l[i] = s.l;
      r[i] = s.r;
    }
  }
  return { l, r };
}

/**
 * Independent 4× true peak (linear) of one channel over samples [from, end). The upsampler is fed
 * from index 0 so it is warm at `from`; no zero padding after the end (an abrupt cut would add a
 * Gibbs overshoot that is not in the signal).
 */
function truePeak(x: Float64Array, from = 0): number {
  const up = new Upsampler4();
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    up.push(v);
    if (i < from) continue;
    p = Math.max(p, Math.abs(v));
    for (const o of up.out) p = Math.max(p, Math.abs(o));
  }
  return p;
}

function maxAbs(x: Float64Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i] ?? 0));
  return p;
}

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel). */
function toneAmp(x: Float64Array, f: number, from: number, fs = FS): number {
  const n = x.length - from;
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[from + i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

const sine = (f: number, amp: number, fs = FS) => (i: number) => amp * Math.sin((2 * Math.PI * f * i) / fs);
const db = (g: number): number => 20 * Math.log10(g);

describe('OutputStage — trim, guard, latency', () => {
  it('delays by the 1.5 ms look-ahead and passes quiet audio at unity (sub mode)', () => {
    const { l } = run(stage('yes'), 400, (i) => (i === 0 ? 0.5 : 0));
    let at = -1;
    for (let i = 0; i < 400; i++) if (Math.abs(l[i] ?? 0) === maxAbs(l)) at = i;
    expect(at).toBe(LOOKAHEAD);
    expect(l[LOOKAHEAD]).toBeCloseTo(0.5, 2);
    expect(maxAbs(l, 0, LOOKAHEAD)).toBe(0);
  });

  it('ramps the trim linearly across the quantum, reaching the target on its last sample', () => {
    // Below the compressor knee the chain after the trim is linear time-invariant, so the trimmed
    // stage must equal a 0 dB stage fed with the input pre-multiplied by the expected ramp.
    const x = sine(3000, 0.01);
    const g6 = dbToGain(6);
    const gain = (i: number): number => (i < Q ? 1 : i < 2 * Q ? 1 + (g6 - 1) * ((i - Q + 1) / Q) : g6);
    const a = run(stage('yes'), 6 * Q, x, x, (q) => (q === 0 ? 0 : 6));
    const b = run(stage('yes'), 6 * Q, (i) => x(i) * gain(i));
    for (let i = 0; i < 6 * Q; i++) expect(a.l[i] ?? NaN).toBeCloseTo(b.l[i] ?? NaN, 12);
  });

  it('clamps trim to +6 dB and keeps the previous trim for NaN', () => {
    const x = sine(3000, 0.01);
    const ref = run(stage('yes', 40, 6), 4 * Q, x, x, 6);
    const hi = run(stage('yes', 40, 6), 4 * Q, x, x, 20);
    const nan = run(stage('yes', 40, 6), 4 * Q, x, x, (q) => (q === 0 ? 6 : NaN));
    expect(Array.from(hi.l)).toEqual(Array.from(ref.l));
    expect(Array.from(nan.l)).toEqual(Array.from(ref.l));
  });

  it('guards NaN / ±Infinity / |x| > 1e6 per channel, counts them, and keeps running (multi-call)', () => {
    const s = stage('no');
    const bad = [NaN, Infinity, -Infinity, 2e6];
    const out = run(s, 4 * Q, (i) => (i < bad.length ? (bad[i] ?? 0) : 0.1 * Math.sin(i / 7)), () => 0);
    expect(s.nonFiniteCount).toBe(4);
    expect(out.l.every((v) => Number.isFinite(v))).toBe(true);
    run(s, Q, () => NaN, () => NaN);
    expect(s.nonFiniteCount).toBe(4 + 2 * Q);
    const after = run(s, FS / 2, sine(1000, 0.1));
    expect(after.l.every((v) => Number.isFinite(v))).toBe(true);
    expect(toneAmp(after.l, 1000, FS / 4)).toBeCloseTo(0.1, 2);
  });

  it('blocks DC in both bass modes', () => {
    for (const sub of ['yes', 'no'] as const) {
      const { l } = run(stage(sub), FS, () => 0.5);
      expect(maxAbs(l, FS / 2)).toBeLessThan(1e-3);
    }
  });
});

describe('OutputStage — bass management', () => {
  it("subwoofer 'yes': only a 22 Hz 2nd-order HP (30 Hz ≈ −1 dB, 10 Hz < −12 dB)", () => {
    const a30 = toneAmp(run(stage('yes'), 2 * FS, sine(30, 0.1)).l, 30, FS);
    expect(a30 / 0.1).toBeGreaterThan(0.84);
    expect(a30 / 0.1).toBeLessThan(0.95);
    const a10 = toneAmp(run(stage('yes'), 4 * FS, sine(10, 0.1)).l, 10, 2 * FS);
    expect(a10 / 0.1).toBeLessThan(0.25);
  });

  it("'no' / 'unsure': 4th-order HP at the corner (2×corner ≈ 0 dB, ½·corner ≈ −24 dB)", () => {
    for (const sub of ['no', 'unsure'] as const) {
      const a80 = toneAmp(run(stage(sub, 40), FS, sine(80, 0.1)).l, 80, FS / 2);
      expect(db(a80 / 0.1)).toBeCloseTo(0, 0);
      const a20 = toneAmp(run(stage(sub, 40), 2 * FS, sine(20, 0.1)).l, 20, FS);
      expect(db(a20 / 0.1)).toBeLessThan(-20);
    }
  });

  it('adds NLD virtual bass: 2nd + 3rd harmonics of the removed band (absent with a sub)', () => {
    const x = sine(25, 0.1);
    const noSub = run(stage('no', 40), 3 * FS, x).l;
    const sub = run(stage('yes'), 3 * FS, x).l;
    for (const h of [50, 75]) {
      expect(toneAmp(noSub, h, FS)).toBeGreaterThan(0.1 * 0.1);
      expect(toneAmp(sub, h, FS)).toBeLessThan(1e-5);
    }
  });

  it('scales virtual bass by 0.5·(1 − clamp((trimDb + 12)/18, 0, 1)·0.5) (equal loudness)', () => {
    const x = sine(25, 0.05);
    const h3 = (trimDb: number): number => toneAmp(run(stage('no', 40), 3 * FS, x, x, trimDb).l, 75, FS) / dbToGain(trimDb);
    const at0 = h3(0); // gain 1/3
    expect(h3(-12) / at0).toBeCloseTo(1.5, 1); // gain 0.5
    expect(h3(-20) / at0).toBeCloseTo(1.5, 1); // clamped at 0.5
    expect(h3(6) / at0).toBeCloseTo(0.75, 1); // gain 0.25
  });

  it('clamps hpCornerHz to 30–60 Hz and maps non-finite to 40 Hz', () => {
    const x = (i: number): number => 0.2 * Math.sin(i / 200) + 0.1 * Math.sin(i / 37);
    const same = (a: number, b: number): void => {
      expect(Array.from(run(stage('no', a), 4 * Q, x).l)).toEqual(Array.from(run(stage('no', b), 4 * Q, x).l));
    };
    same(100, 60);
    same(10, 30);
    same(NaN, 40);
  });
});

describe('OutputStage — dynamics', () => {
  it('compresses 3:1 above −12 dBFS with a 6 dB soft knee (linked, no make-up)', () => {
    const peakDb = (inDb: number): number => db(maxAbs(run(stage('yes'), FS, sine(1000, dbToGain(inDb))).l, FS / 2));
    expect(Math.abs(peakDb(0) + 8)).toBeLessThan(0.3); // −12 + 12/3
    expect(Math.abs(peakDb(-12) + 12.5)).toBeLessThan(0.2); // knee centre: −0.5 dB
    expect(Math.abs(peakDb(-20) + 20)).toBeLessThan(0.05); // below the knee: unity
    // Linked: a loud left channel also turns the quiet right channel down by the same gain.
    const { r } = run(stage('yes'), FS, sine(1000, 1), sine(1000, 0.01));
    expect(Math.abs(db(maxAbs(r, FS / 2) / 0.01) + 8)).toBeLessThan(0.3);
  });

  it('attacks in ≈ 5 ms and releases in ≈ 120 ms (multi-call)', () => {
    const s = stage('yes');
    run(s, FS / 2, sine(1000, 0.01));
    const loud = run(s, FS / 2, sine(1000, 1));
    expect(Math.abs(db(maxAbs(loud.l, (30 * FS) / 1000, (40 * FS) / 1000)) + 8)).toBeLessThan(1);
    const quiet = run(s, FS, sine(1000, 0.01));
    expect(db(maxAbs(quiet.l, FS / 20, FS / 20 + 100) / 0.01)).toBeLessThan(-3); // still recovering at 50 ms
    expect(Math.abs(db(maxAbs(quiet.l, (6 * FS) / 10, (7 * FS) / 10) / 0.01))).toBeLessThan(0.3); // recovered
  });

  it('reports limiter gain reduction and the output true peak; takeTruePeak() resets it', () => {
    // +26 dBFS after trim: the compressor alone leaves ≈ +0.7 dBFS, so the limiter must hold ≈ 2 dB.
    const s = stage('yes');
    run(s, FS / 2, sine(997, 10), sine(997, 10), 6);
    expect(s.gainReductionDb).toBeGreaterThan(1);
    const tp = s.takeTruePeak();
    expect(tp).toBeLessThanOrEqual(-1.0);
    expect(tp).toBeGreaterThan(-3);
    run(s, 2 * FS, () => 0); // the delayed tail of the loud passage comes out here
    expect(s.gainReductionDb).toBe(0);
    expect(s.takeTruePeak()).toBeLessThanOrEqual(-1.0);
    run(s, FS / 2, () => 0);
    expect(s.truePeakDbtp).toBeLessThan(-100);
  });

  it('meters the output true peak to within 0.1 dB of an independent 4× measurement near the ceiling', () => {
    for (const [f, amp] of [
      [997, 10],
      [5000, 3],
      [15000, 10],
    ] as const) {
      const s = stage('yes', 40, 6);
      const half = 188; // quanta (≈ 0.5 s): the meter window is everything after it
      const { l, r } = run(
        s,
        2 * half * Q,
        sine(f, amp),
        sine(1.01 * f, amp),
        (q) => {
          if (q === half) s.takeTruePeak();
          return 6;
        },
      );
      const independent = db(Math.max(truePeak(l, half * Q), truePeak(r, half * Q)));
      expect(Math.abs(s.truePeakDbtp - independent)).toBeLessThan(0.1);
    }
  });

  it('reset() clears every buffer, envelope and meter', () => {
    const s = stage('no');
    run(s, FS / 4, sine(50, 1), sine(70, 1), 6);
    s.reset();
    expect(s.truePeakDbtp).toBe(-200);
    expect(s.gainReductionDb).toBe(0);
    const { l, r } = run(s, 1000, () => 0);
    expect(l.every((v) => v === 0) && r.every((v) => v === 0)).toBe(true);
  });
});

describe('OutputStage — RF4: true-peak ceiling at +6 dB trim', () => {
  const n = 2 * FS;
  const square = (f: number) => (i: number) => (Math.sin((2 * Math.PI * f * i) / FS) >= 0 ? 1 : -1);
  const squareish = (f: number) => (i: number) => Math.tanh(5 * Math.sin((2 * Math.PI * f * i) / FS)) / Math.tanh(5);
  const sweep = (f0: number, f1: number) => (i: number) => {
    const t = i / FS;
    const k = Math.log(f1 / f0) / (n / FS);
    return Math.sin(((2 * Math.PI * f0) / k) * (Math.exp(k * t) - 1));
  };
  const quarterFs45 = (i: number) => Math.sin((Math.PI / 2) * i + Math.PI / 4); // samples ±0.707, true peak 1
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const cases: [string, (i: number) => number, (i: number) => number][] = [
    ['naive full-scale square 441 Hz', square(441), square(441)],
    ['square-ish (tanh) 60 Hz, R inverted', squareish(60), (i) => -squareish(60)(i)],
    ['log sine sweep 20 Hz → 20 kHz', sweep(20, 20000), sweep(20, 20000)],
    ['log sine sweep 5 kHz → 23 kHz', sweep(5000, 23000), sweep(23000, 5000)],
    ['fs/4 tone at 45° (+3 dB inter-sample peaks)', quarterFs45, quarterFs45],
    ['full-scale white noise', () => noise(), () => noise()],
    // 45 ms quiet / 5 ms loud bursts: exercises the limiter's exact quiet-skip and history replay.
    ['quiet ↔ loud bursts', (i) => (i % 2400 < 2160 ? 0.05 : 4) * square(3001)(i), (i) => (i % 2400 < 2160 ? 0.05 : -4) * quarterFs45(i)],
  ];
  for (const sub of ['yes', 'no'] as const) {
    for (const [name, srcL, srcR] of cases) {
      it(`${name} (subwoofer ${sub}): ≤ −1.0 dBTP and no sample above 0.8913`, () => {
        const s = stage(sub, 40, 6);
        const { l, r } = run(s, n, srcL, srcR, 6);
        expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING);
        expect(maxAbs(r)).toBeLessThanOrEqual(OUTPUT_CEILING);
        const tp = db(Math.max(truePeak(l), truePeak(r)));
        expect(tp).toBeLessThanOrEqual(-1.0);
        expect(tp).toBeGreaterThan(-6); // the limiter is working, not muting
        expect(s.truePeakDbtp).toBeLessThanOrEqual(-1.0);
      });
    }
  }

  it('holds at 44.1 kHz too (sweep + square)', () => {
    const fs = 44100;
    const s = stage('no', 40, 6, fs);
    const src = (i: number): number => 0.5 * Math.sin((2 * Math.PI * 30 * i) / fs) + (Math.sin((2 * Math.PI * 3001 * i) / fs) >= 0 ? 0.5 : -0.5);
    const { l, r } = run(s, 2 * fs, src, (i) => Math.sin((2 * Math.PI * (200 + i / 10) * i) / fs), 6);
    expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING);
    expect(db(Math.max(truePeak(l), truePeak(r)))).toBeLessThanOrEqual(-1.0);
  });
});
```

- [ ] **Step 6: Run the output-stage test and confirm it fails**

Run: `npx vitest run tests/unit/dsp-output-stage.test.ts`
Expected: FAIL. `Error: Cannot find module '../../src/dsp/output-stage' imported from …/tests/unit/dsp-output-stage.test.ts`.

- [ ] **Step 7: Implement `src/dsp/output-stage.ts`**

Create `src/dsp/output-stage.ts`:

```ts
import { DEFAULT_OUTPUT } from '../contracts';
import type { OutputConfig } from '../contracts';
import { BUTTER4_Q, Biquad, Cascade } from './biquad';
import { OS_TAPS, Upsampler4 } from './oversample';
import { clamp, dbToGain, flush, gainToDb } from './util';

/** Final NaN-safe hard clip (contract: −1 dBTP = 0.8913). Nothing follows it. */
export const OUTPUT_CEILING = 0.8913;
/** Internal true-peak limiter target (amendment B9), leaving 0.3 dB for the clip and measurement. */
export const LIMITER_TARGET_DBTP = -1.3;
/** Limiter look-ahead: the whole stage delays audio by round(LIMITER_LOOKAHEAD_S · fs) samples. */
export const LIMITER_LOOKAHEAD_S = 0.0015;
export const LIMITER_RELEASE_S = 0.05;
/** Compressor (contract): linked stereo, soft knee 6 dB, −12 dBFS, 3:1, 5 ms / 120 ms. No make-up gain. */
export const COMP_THRESHOLD_DB = -12;
export const COMP_RATIO = 3;
export const COMP_KNEE_DB = 6;
export const COMP_ATTACK_S = 0.005;
export const COMP_RELEASE_S = 0.12;
/** First-order DC blocker corner. */
export const DC_BLOCK_HZ = 5;
/** Subwoofer 'yes': 2nd-order infrasonic high-pass only. */
export const SUB_HP_HZ = 22;
/** No-sub high-pass corner range (contract: 30–60 Hz). */
export const HP_CORNER_MIN_HZ = 30;
export const HP_CORNER_MAX_HZ = 60;
/** trimDb is clamped to this range (the UI uses −24…+6; lower values are accepted so callers can fade). */
export const TRIM_MIN_DB = -120;
export const TRIM_MAX_DB = 6;
/** NaN guard: non-finite or |x| above this after trim → 0 and nonFiniteCount++. */
export const NAN_GUARD_LIMIT = 1e6;
/** Virtual-bass envelope follower: instant attack, exponential release. */
export const VB_ENV_RELEASE_S = 0.1;

/** Below this envelope the virtual-bass shaper is idle (avoids 0/0). */
const VB_ENV_MIN = 1e-9;
/** Limiter release snaps to the held gain once within this distance (else rounding stalls at 1 − 1e-13). */
const LIM_SNAP = 1e-12;
/** Upsampler4 detection of the interval after audio sample m happens at push m + 6 (group delay 5.875). */
const DETECT_LAG = 6;
const DB_TO_LN = Math.LN10 / 20;

/** One channel of DC blocker + bass management. Per-sample values pass through the `x` field. */
class BassChannel {
  /** In: trimmed, NaN-guarded sample. Out: after DC blocker and bass management. */
  x = 0;
  /** Parameters (set by OutputStage.configure / beginQuantum). */
  sub = true;
  dcR = 0;
  envRel = 0;
  vbGain = 0;
  readonly subHp = new Biquad();
  readonly hp4 = new Cascade(2);
  readonly lp4 = new Cascade(2);
  readonly vbHp = new Cascade(2);
  readonly vbLp = new Biquad();
  private dcX1 = 0;
  private dcY1 = 0;
  private env = 0;

  reset(): void {
    this.subHp.reset();
    this.hp4.reset();
    this.lp4.reset();
    this.vbHp.reset();
    this.vbLp.reset();
    this.dcX1 = 0;
    this.dcY1 = 0;
    this.env = 0;
    this.x = 0;
  }

  step(): void {
    const x = this.x;
    // DC blocker: y = x − x[n−1] + R·y[n−1].
    const dc = flush(x - this.dcX1 + this.dcR * this.dcY1);
    this.dcX1 = x;
    this.dcY1 = dc;
    if (this.sub) {
      this.x = this.subHp.process(dc);
      return;
    }
    // No sub: 4th-order Butterworth HP at the corner + NLD virtual bass (Larsen & Aarts 2002):
    // removed band (4th-order LP at the corner) normalised by its envelope → Chebyshev T2 + T3
    // (2nd + 3rd harmonics of a unit sinusoid) → band-pass corner…4·corner (4th-order HP at the
    // corner, so envelope-error leakage of the sub-corner fundamental is cut 24 dB/oct, + 2nd-order
    // LP at 4·corner) → × envelope × gain.
    const hp = this.hp4.process(dc);
    const band = this.lp4.process(dc);
    const mag = band < 0 ? -band : band;
    this.env = mag > this.env ? mag : flush(this.env * this.envRel);
    let h = 0;
    if (this.env > VB_ENV_MIN) {
      const u = clamp(band / this.env, -1, 1);
      h = 2 * u * u - 1 + (4 * u * u * u - 3 * u);
    }
    const vb = this.vbLp.process(this.vbHp.process(h));
    this.x = hp + vb * this.env * this.vbGain;
  }
}

/**
 * Output stage (spec §5.3.12, §5.6), always last: per channel trim → NaN guard → DC blocker → bass
 * management; then linked soft-knee compressor → linked 4×-oversampled look-ahead true-peak limiter
 * (target −1.3 dBTP) → NaN-safe hard clip at 0.8913. Latency = round(1.5 ms · fs) samples.
 *
 * Limiter: required gain g[k] = min(1, target / peak[k]) where peak[k] is the max of |x| and the 4
 * Upsampler4 outputs of both channels; min-hold over H = D + 2 samples; release one-pole (50 ms);
 * moving average over A = D − 8 samples; applied to audio delayed by D. This bounds the gain on
 * audio sample m by every g[k] for k ∈ [m − 1, m + 9], which covers both its own sample peak (k = m)
 * and the Upsampler4 detections of the intervals next to it (k ≈ m + 5…m + 7, group delay 5.875).
 * Quiet skip (exact): the Upsampler4 outputs depend on its last `upMem` inputs with gain ≤ upGain
 * (both measured from an impulse at construction). While every one of those inputs is ≤ target/upGain,
 * no output can exceed the target, so the required gain is exactly 1 and the pushes are skipped; the
 * stored history is replayed before the next loud sample, so the upsampler state is as if never skipped.
 * The true-peak meter reuses the detections: each is delayed to the moment its audio leaves the stage
 * and scaled by the gain applied then (≈ 0.1 dB). In quiet passages (below ≈ −5 dBFS after the
 * compressor) it reads the sample peak instead.
 */
export class OutputStage {
  /** Increments for every non-finite / > 1e6 sample caught by the guard or the final clip. Not cleared by reset(). */
  nonFiniteCount = 0;

  private readonly fs: number;
  private readonly chL = new BassChannel();
  private readonly chR = new BassChannel();
  // trim
  private trimDb = 0;
  private trimGain = 1;
  private trimTarget = 1;
  private rampFrom = 1;
  private rampPos = 0;
  private rampFrames = 0;
  // compressor: smooth decoupled peak detector on the gain reduction (dB ≥ 0)
  private readonly compAtk: number;
  private readonly compRel: number;
  private readonly kneeLoLin: number;
  private compPeak = 0;
  private compGr = 0;
  // limiter
  private readonly upL = new Upsampler4();
  private readonly upR = new Upsampler4();
  private readonly lookahead: number;
  private readonly holdN: number;
  private readonly avgN: number;
  private readonly delayL: Float64Array;
  private readonly delayR: Float64Array;
  private readonly req: Float64Array;
  private readonly envRing: Float64Array;
  private readonly limRel: number;
  private readonly limCeil: number;
  private dPos = 0;
  private reqPos = 0;
  private reqBelow = 0;
  private envPos = 0;
  private envBelow = 0;
  private envSum = 0;
  private limEnv = 1;
  private limGain = 1;
  // quiet skip
  private readonly upMem: number;
  private readonly quietLevel: number;
  private readonly histL: Float64Array;
  private readonly histR: Float64Array;
  private histPos = 0;
  private loudLeft = 0;
  private upStale = false;
  // true-peak meter
  private readonly detRing: Float64Array;
  private detPos = 0;
  private tpMax = 0;
  // per-sample I/O
  private inL = 0;
  private inR = 0;
  private outL = 0;
  private outR = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.compAtk = Math.exp(-1 / (COMP_ATTACK_S * fs));
    this.compRel = Math.exp(-1 / (COMP_RELEASE_S * fs));
    this.kneeLoLin = dbToGain(COMP_THRESHOLD_DB - COMP_KNEE_DB / 2);
    this.lookahead = Math.max(1, Math.round(LIMITER_LOOKAHEAD_S * fs));
    this.holdN = this.lookahead + 2;
    this.avgN = Math.max(1, this.lookahead - 8);
    this.delayL = new Float64Array(this.lookahead);
    this.delayR = new Float64Array(this.lookahead);
    this.req = new Float64Array(this.holdN);
    this.envRing = new Float64Array(this.avgN);
    this.detRing = new Float64Array(Math.max(1, this.lookahead - DETECT_LAG));
    this.limRel = Math.exp(-1 / (LIMITER_RELEASE_S * fs));
    this.limCeil = dbToGain(LIMITER_TARGET_DBTP);
    // Measure the upsampler's memory and worst-case phase gain (Σ|taps| of the loudest phase) from
    // its impulse response, so the quiet skip holds for any polyphase arrangement of OS_TAPS.
    const probe = new Upsampler4();
    const phaseSum = new Float64Array(probe.out.length);
    let mem = 1;
    for (let j = 0; j < OS_TAPS.length; j++) {
      probe.push(j === 0 ? 1 : 0);
      for (let p = 0; p < probe.out.length; p++) {
        const v = Math.abs(probe.out[p] ?? 0);
        phaseSum[p] = (phaseSum[p] ?? 0) + v;
        if (v > 0) mem = j + 1;
      }
    }
    let upGain = 1;
    for (let p = 0; p < phaseSum.length; p++) upGain = Math.max(upGain, phaseSum[p] ?? 0);
    this.upMem = mem;
    this.quietLevel = this.limCeil / upGain;
    this.histL = new Float64Array(mem);
    this.histR = new Float64Array(mem);
    this.configure(DEFAULT_OUTPUT);
  }

  /** Bass mode from `subwoofer`; corner = clamp(hpCornerHz, 30, 60) (non-finite → 40); trim snaps to volumeTrimDb. Clears state. */
  configure(out: OutputConfig): void {
    const sub = out.subwoofer === 'yes';
    const corner = clamp(
      Number.isFinite(out.hpCornerHz) ? out.hpCornerHz : DEFAULT_OUTPUT.hpCornerHz,
      HP_CORNER_MIN_HZ,
      HP_CORNER_MAX_HZ,
    );
    this.setupChannel(this.chL, sub, corner);
    this.setupChannel(this.chR, sub, corner);
    const db = Number.isNaN(out.volumeTrimDb) ? 0 : clamp(out.volumeTrimDb, TRIM_MIN_DB, TRIM_MAX_DB);
    this.trimDb = db;
    this.trimTarget = dbToGain(db);
    this.trimGain = this.trimTarget;
    this.rampFrom = this.trimTarget;
    this.rampPos = 0;
    this.rampFrames = 0;
    this.applyVbGain();
    this.reset();
  }

  /** Call once per quantum before its process() calls: linear trim ramp from the current gain to trimDb, reaching it on sample `frames`. NaN keeps the previous trim. */
  beginQuantum(trimDb: number, frames: number): void {
    const db = Number.isNaN(trimDb) ? this.trimDb : clamp(trimDb, TRIM_MIN_DB, TRIM_MAX_DB);
    this.trimDb = db;
    this.rampFrom = this.trimGain;
    this.trimTarget = dbToGain(db);
    this.rampPos = 0;
    this.rampFrames = frames >= 1 ? Math.floor(frames) : 0;
    if (this.rampFrames === 0) this.trimGain = this.trimTarget;
    this.applyVbGain();
  }

  /** Per sample. Results in `l` / `r` (delayed by the look-ahead). */
  process(l: number, r: number): void {
    this.inL = l;
    this.inR = r;
    this.step();
  }

  get l(): number {
    return this.outL;
  }

  get r(): number {
    return this.outR;
  }

  /** Max true peak (dBTP, 4× oversampled) of the output since the last takeTruePeak(); −200 when silent. */
  get truePeakDbtp(): number {
    return gainToDb(this.tpMax);
  }

  takeTruePeak(): number {
    const v = gainToDb(this.tpMax);
    this.tpMax = 0;
    return v;
  }

  /** Limiter gain reduction in dB at the last sample (≥ 0; 0 = no limiting). */
  get gainReductionDb(): number {
    return this.limGain < 1 ? -gainToDb(this.limGain) : 0;
  }

  /** Clears all signal state (filters, envelopes, look-ahead buffers, meters); completes any trim ramp. */
  reset(): void {
    this.chL.reset();
    this.chR.reset();
    this.trimGain = this.trimTarget;
    this.rampPos = this.rampFrames;
    this.compPeak = 0;
    this.compGr = 0;
    this.upL.reset();
    this.upR.reset();
    this.histL.fill(0);
    this.histR.fill(0);
    this.histPos = 0;
    this.loudLeft = 0;
    this.upStale = false;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.req.fill(1);
    this.envRing.fill(1);
    this.detRing.fill(0);
    this.dPos = 0;
    this.reqPos = 0;
    this.reqBelow = 0;
    this.envPos = 0;
    this.envBelow = 0;
    this.envSum = this.avgN;
    this.detPos = 0;
    this.limEnv = 1;
    this.limGain = 1;
    this.tpMax = 0;
    this.outL = 0;
    this.outR = 0;
  }

  private setupChannel(ch: BassChannel, sub: boolean, corner: number): void {
    const fs = this.fs;
    ch.sub = sub;
    ch.dcR = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) / fs);
    ch.envRel = Math.exp(-1 / (VB_ENV_RELEASE_S * fs));
    ch.subHp.highpass(SUB_HP_HZ, Math.SQRT1_2, fs);
    ch.hp4.stage(0).highpass(corner, BUTTER4_Q[0], fs);
    ch.hp4.stage(1).highpass(corner, BUTTER4_Q[1], fs);
    ch.lp4.stage(0).lowpass(corner, BUTTER4_Q[0], fs);
    ch.lp4.stage(1).lowpass(corner, BUTTER4_Q[1], fs);
    ch.vbHp.stage(0).highpass(corner, BUTTER4_Q[0], fs);
    ch.vbHp.stage(1).highpass(corner, BUTTER4_Q[1], fs);
    ch.vbLp.lowpass(4 * corner, Math.SQRT1_2, fs);
  }

  /** Equal-loudness: virtual bass 0.5 at trim ≤ −12 dB, falling linearly to 0.25 at +6 dB. */
  private applyVbGain(): void {
    const g = 0.5 * (1 - clamp((this.trimDb + 12) / 18, 0, 1) * 0.5);
    this.chL.vbGain = g;
    this.chR.vbGain = g;
  }

  private step(): void {
    // 1. Trim: linear ramp across the quantum.
    if (this.rampPos < this.rampFrames) {
      this.rampPos++;
      this.trimGain =
        this.rampPos === this.rampFrames
          ? this.trimTarget
          : this.rampFrom + (this.trimTarget - this.rampFrom) * (this.rampPos / this.rampFrames);
    }
    const g = this.trimGain;

    // 2. NaN guard.
    let xl = this.inL * g;
    if (!(xl === xl) || xl > NAN_GUARD_LIMIT || xl < -NAN_GUARD_LIMIT) {
      xl = 0;
      this.nonFiniteCount++;
    }
    let xr = this.inR * g;
    if (!(xr === xr) || xr > NAN_GUARD_LIMIT || xr < -NAN_GUARD_LIMIT) {
      xr = 0;
      this.nonFiniteCount++;
    }

    // 3–4. DC blocker + bass management.
    const chL = this.chL;
    const chR = this.chR;
    chL.x = xl;
    chL.step();
    chR.x = xr;
    chR.step();
    const bl = chL.x;
    const br = chR.x;

    // 5. Compressor: linked peak level → soft-knee gain computer → smooth decoupled peak detector
    //    on the gain reduction (Giannoulis, Massberg & Reiss 2012): release stage, then attack stage.
    const al = bl < 0 ? -bl : bl;
    const ar = br < 0 ? -br : br;
    const lvl = al > ar ? al : ar;
    let red = 0;
    if (lvl > this.kneeLoLin) {
      const over = 20 * Math.log10(lvl) - COMP_THRESHOLD_DB;
      const slope = 1 - 1 / COMP_RATIO;
      if (over >= COMP_KNEE_DB / 2) {
        red = slope * over;
      } else {
        const t = over + COMP_KNEE_DB / 2;
        red = (slope * t * t) / (2 * COMP_KNEE_DB);
      }
    }
    const released = this.compRel * this.compPeak + (1 - this.compRel) * red;
    this.compPeak = flush(red > released ? red : released);
    this.compGr = flush(this.compAtk * this.compGr + (1 - this.compAtk) * this.compPeak);
    const cg = this.compGr === 0 ? 1 : Math.exp(-this.compGr * DB_TO_LN);
    const cl = bl * cg;
    const cr = br * cg;

    // 6. True-peak look-ahead limiter. Detection: sample peaks + 4× upsampled peaks, both channels.
    const acl = cl < 0 ? -cl : cl;
    const acr = cr < 0 ? -cr : cr;
    let peak = acl > acr ? acl : acr;
    this.histL[this.histPos] = cl;
    this.histR[this.histPos] = cr;
    this.histPos = this.histPos + 1 === this.upMem ? 0 : this.histPos + 1;
    if (peak > this.quietLevel) this.loudLeft = this.upMem;
    if (this.loudLeft > 0) {
      this.loudLeft--;
      if (this.upStale) {
        // Replay the previous upMem − 1 inputs (oldest first); histPos now points at the oldest.
        for (let j = 0; j < this.upMem - 1; j++) {
          const i = this.histPos + j < this.upMem ? this.histPos + j : this.histPos + j - this.upMem;
          this.upL.push(this.histL[i] ?? 0);
          this.upR.push(this.histR[i] ?? 0);
        }
        this.upStale = false;
      }
      this.upL.push(cl);
      this.upR.push(cr);
      const oL = this.upL.out;
      const oR = this.upR.out;
      for (let k = 0; k < oL.length; k++) {
        const a = oL[k] ?? 0;
        const b = oR[k] ?? 0;
        if (a > peak) peak = a;
        else if (-a > peak) peak = -a;
        if (b > peak) peak = b;
        else if (-b > peak) peak = -b;
      }
    } else {
      this.upStale = true;
    }
    // Min-hold of the required gain over holdN samples (loop only while some entry is < 1).
    const req = peak > this.limCeil ? this.limCeil / peak : 1;
    if ((this.req[this.reqPos] ?? 1) < 1) this.reqBelow--;
    if (req < 1) this.reqBelow++;
    this.req[this.reqPos] = req;
    this.reqPos = this.reqPos + 1 === this.holdN ? 0 : this.reqPos + 1;
    let held = 1;
    if (this.reqBelow > 0) {
      for (let i = 0; i < this.holdN; i++) {
        const v = this.req[i] ?? 1;
        if (v < held) held = v;
      }
    }
    // Release (50 ms one-pole toward the held gain; attack is instant).
    let env = held;
    if (held > this.limEnv) {
      const gap = (held - this.limEnv) * this.limRel;
      if (gap > LIM_SNAP) env = held - gap;
    }
    this.limEnv = env;
    // Moving average over avgN samples (running sum, recomputed exactly at every ring wrap).
    const oldEnv = this.envRing[this.envPos] ?? 1;
    if (oldEnv < 1) this.envBelow--;
    if (env < 1) this.envBelow++;
    this.envRing[this.envPos] = env;
    this.envSum += env - oldEnv;
    this.envPos = this.envPos + 1 === this.avgN ? 0 : this.envPos + 1;
    let lg = 1;
    if (this.envBelow > 0) {
      if (this.envPos === 0) {
        let s = 0;
        for (let i = 0; i < this.avgN; i++) s += this.envRing[i] ?? 1;
        this.envSum = s;
      }
      lg = this.envSum / this.avgN;
      if (lg > 1) lg = 1;
    } else {
      this.envSum = this.avgN;
    }
    this.limGain = lg;
    const dl = this.delayL[this.dPos] ?? 0;
    const dr = this.delayR[this.dPos] ?? 0;
    this.delayL[this.dPos] = cl;
    this.delayR[this.dPos] = cr;
    this.dPos = this.dPos + 1 === this.lookahead ? 0 : this.dPos + 1;

    // 7. NaN-safe hard clip. No gain stage follows.
    let yl = dl * lg;
    let yr = dr * lg;
    if (yl === yl) yl = yl > OUTPUT_CEILING ? OUTPUT_CEILING : yl < -OUTPUT_CEILING ? -OUTPUT_CEILING : yl;
    else {
      yl = 0;
      this.nonFiniteCount++;
    }
    if (yr === yr) yr = yr > OUTPUT_CEILING ? OUTPUT_CEILING : yr < -OUTPUT_CEILING ? -OUTPUT_CEILING : yr;
    else {
      yr = 0;
      this.nonFiniteCount++;
    }

    // True-peak meter: the detection made DETECT_LAG pushes after this sample entered, × gain now.
    const det = this.detRing[this.detPos] ?? 0;
    this.detRing[this.detPos] = peak;
    this.detPos = this.detPos + 1 === this.detRing.length ? 0 : this.detPos + 1;
    let tp = det * lg;
    const ayl = yl < 0 ? -yl : yl;
    const ayr = yr < 0 ? -yr : yr;
    if (ayl > tp) tp = ayl;
    if (ayr > tp) tp = ayr;
    if (tp > this.tpMax) this.tpMax = tp;
    this.outL = yl;
    this.outR = yr;
  }
}
```

- [ ] **Step 8: Run the output-stage test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-output-stage.test.ts`
Expected: PASS, `Tests  30 passed (30)` in about 2.5 s. Reference measurements:
- Compressor: 0 / −12 / −20 dBFS in → −7.994 / −12.501 / −20.003 dBFS out.
- Attack window: −8.34 dB. Release: −5.3 dB at 50 ms, −0.03 dB at 0.6 s.
- Subwoofer HP: 30 Hz ×0.869, 10 Hz ×0.181. No-sub HP: 80 Hz −0.02 dB, 20 Hz −25.3 dB.
- Virtual-bass harmonics at 50/75 Hz: 0.029 (≈ 1e-10 with a sub). Equal-loudness ratios: exactly 1.500 / 1.500 / 0.750.
- Every RF4 case lands at ≈ −1.30 dBTP.

If the true-peak meter test fails by a whole dB, check that `run(…)`'s trim callback really calls `takeTruePeak()` on quantum 188.

- [ ] **Step 9: Run both suites together**

Run: `npx vitest run tests/unit/dsp-perspective.test.ts tests/unit/dsp-output-stage.test.ts`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  40 passed (40)`.

- [ ] **Step 10: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.
- `process`, `tick` and the private `step` methods (including `BassChannel.step`) contain no `new`, array/object literals, closures, spread, template literals, `try` or `throw`. `configure()` calls `setupChannel` twice instead of looping over an array literal.
- `OutputStage`'s constructor allocates a probe `Upsampler4` and a `Float64Array` once, which is outside the hot path. T10's amendment-B1 rule therefore reports nothing for these files.

---

### Task 8: Analysis toolkit (`src/dsp/analysis.ts`) and WAV I/O (`tools/wav.ts`)

**Files:**
- Create: `src/dsp/analysis.ts`
- Create: `tools/wav.ts`
- Test: `tests/unit/dsp-analysis.test.ts`
- Test: `tests/unit/wav.test.ts`

**Interfaces:**
- Consumes:
  - T1 `src/dsp/util.ts`: `gainToDb(g: number): number` (−Infinity-safe: `g ≤ 0 → −200`).
  - T1 `src/dsp/oversample.ts`: `OS_FACTOR` (= 4), `OS_TAPS: Float64Array` (48 taps), `class Upsampler4 { reset(): void; push(x: number): void; readonly out: Float64Array }` (no constructor arguments).
- Produces (exact; T9, T10 and Phase 2b `tesbox-score` rely on these):
  - `fft(re: Float64Array, im: Float64Array): void` — in-place iterative radix-2, forward (e^(−i2πkn/N)), unnormalised; `RangeError` if the length is not a power of two or `re.length !== im.length`.
  - `hann(n: number): Float64Array` — symmetric Hann `w[i] = 0.5 − 0.5·cos(2πi/(n−1))`; `hann(1) = [1]`, `hann(0) = []`.
  - `orderSpectrum(signal: ArrayLike<number>, fs: number, rpm: number, maxOrder: number, step: number): Float64Array` — length `floor(maxOrder/step + 1e-9)`; index `i` ↔ order `(i + 1)·step` at `order·rpm/60` Hz; Hann-windowed Goertzel over the whole signal; a sine of amplitude A exactly on an order reads `A²/2`; entries at/above Nyquist are `0`.
  - `truePeakDbtp(signal: ArrayLike<number>): number` — max(|x|, |4× Upsampler4 outputs|) in dB, flushing the interpolator with `ceil(OS_TAPS.length / OS_FACTOR)` zeros; silence/empty → `−200`; any NaN sample → `NaN`.
  - `rmsDb(signal: ArrayLike<number>): number` — dB re amplitude 1 (a full-scale sine reads −3.01 dB); empty/silent → `−200`.
  - `bandEnergyDb(signal: ArrayLike<number>, fs: number, loHz: number, hiHz: number): number` — Hann-windowed, zero-padded FFT; energy of the bins whose centre lies in `[loHz, hiHz]`, in dB relative to a full-scale sine whose energy lies entirely in the band (in-band full-scale sine ≈ 0 dB; `bandEnergyDb(x, fs, 0, fs/2)` is the total); empty input or `hiHz < loHz` → `−200`.
  - `dominantOrders(spectrum: Float64Array, step: number, topN: number): number[]` — orders `(i + 1)·step` sorted by energy, descending; ties → lower order first; NaN entries sort last.
  - `writeWav(path: string, channels: Float32Array[], fs: number): void` — 32-bit IEEE float (format tag 3, 18-byte `fmt ` chunk + `fact` chunk), interleaved, creates missing parent directories; `RangeError` for no channels, unequal channel lengths, or a non-integer / ≤ 0 `fs`.
  - `readWav(path: string): { fs: number; channels: Float32Array[] }` — PCM 16/24/32-bit integer and 32-bit float, including `WAVE_FORMAT_EXTENSIBLE`; skips unknown (also odd-sized, padded) chunks; `Error` for non-RIFF files and unsupported encodings.

**Cross-task premises** (open each named file and confirm every bullet before coding; a mismatch is fixed in the owning task):
- T1 `src/dsp/util.ts` exports `gainToDb` and it returns exactly `-200` for `g <= 0` (several assertions use `toBe(-200)`).
- T1 `src/dsp/oversample.ts` exports `OS_FACTOR === 4`, `OS_TAPS` with `length === 48`, and `Upsampler4` with a no-argument constructor; after `push(x)`, `out[0..3]` hold the 4 interpolated output samples for that input, and the passband gain is ≈ 1 (Σ OS_TAPS ≈ 4), so an fs/8 sine reads within ±0.15 dB of its true peak.
- Phase 0 T1: `tsconfig.json` includes `src`, `tests`, `tools` with `types: ["vite/client", "node"]` and `noUncheckedIndexedAccess: true`; Vitest runs `tests/unit/**/*.test.ts` in the `node` environment.
- `src/dsp/analysis.ts` contains only module-level functions (no class methods), allocates freely and is never imported by the audio-thread code, so T10's hot-path lint rule (which matches class methods only) does not apply to it.

- [ ] **Step 1: Write the failing analysis test**

Create `tests/unit/dsp-analysis.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  bandEnergyDb,
  dominantOrders,
  fft,
  hann,
  orderSpectrum,
  rmsDb,
  truePeakDbtp,
} from '../../src/dsp/analysis';

const FS = 48000;

function sine(freq: number, amp: number, seconds: number, phase = 0, fs = FS): Float64Array {
  const n = Math.round(seconds * fs);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return x;
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
}

describe('fft', () => {
  it('transforms a unit impulse to a flat spectrum', () => {
    const re = new Float64Array(16);
    const im = new Float64Array(16);
    re[0] = 1;
    fft(re, im);
    for (let k = 0; k < 16; k++) {
      expect(at(re, k)).toBeCloseTo(1, 12);
      expect(at(im, k)).toBeCloseTo(0, 12);
    }
  });

  it('matches a naive DFT on pseudo-random data, and is reusable across calls', () => {
    for (const n of [8, 64]) {
      const re = new Float64Array(n);
      const im = new Float64Array(n);
      const x = new Float64Array(n);
      let s = 12345;
      for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) % 2147483648;
        x[i] = s / 2147483648 - 0.5;
        re[i] = at(x, i);
      }
      fft(re, im);
      for (let k = 0; k < n; k++) {
        let dr = 0;
        let di = 0;
        for (let t = 0; t < n; t++) {
          dr += at(x, t) * Math.cos((-2 * Math.PI * k * t) / n);
          di += at(x, t) * Math.sin((-2 * Math.PI * k * t) / n);
        }
        expect(Math.abs(at(re, k) - dr)).toBeLessThan(1e-9);
        expect(Math.abs(at(im, k) - di)).toBeLessThan(1e-9);
      }
    }
  });

  it('puts a bin-centred sine at |X_k| = N/2', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
    fft(re, im);
    expect(Math.hypot(at(re, 5), at(im, 5))).toBeCloseTo(16, 9);
    expect(Math.hypot(at(re, 4), at(im, 4))).toBeLessThan(1e-9);
  });

  it('rejects non-power-of-two and mismatched lengths', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow(RangeError);
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(RangeError);
  });
});

describe('hann', () => {
  it('is the symmetric Hann window', () => {
    const w = hann(5);
    expect(Array.from(w).map((v) => Number(v.toFixed(12)))).toEqual([0, 0.5, 1, 0.5, 0]);
    expect(Array.from(hann(1))).toEqual([1]);
    expect(hann(0).length).toBe(0);
  });
});

describe('orderSpectrum', () => {
  it('reads A²/2 at the matching order and ~0 elsewhere (step ½)', () => {
    // 3000 rpm → 50 Hz crank; order 2 → 100 Hz.
    const x = sine(100, 0.5, 1);
    const spec = orderSpectrum(x, FS, 3000, 12, 0.5);
    expect(spec.length).toBe(24);
    expect(at(spec, 3)).toBeCloseTo(0.125, 3); // index 3 = order 2
    expect(at(spec, 1)).toBeLessThan(1e-9); // order 1
    expect(at(spec, 4)).toBeLessThan(1e-9); // order 2.5
  });

  it('handles ⅓-order steps without losing the last order to rounding', () => {
    const spec = orderSpectrum(sine((6000 / 60) * (4 / 3), 1, 1), FS, 6000, 12, 1 / 3);
    expect(spec.length).toBe(36);
    expect(dominantOrders(spec, 1 / 3, 1)[0]).toBeCloseTo(4 / 3, 9);
  });

  it('returns zeros for empty input and for orders at/above Nyquist', () => {
    expect(Array.from(orderSpectrum(new Float64Array(0), FS, 3000, 4, 1))).toEqual([0, 0, 0, 0]);
    const spec = orderSpectrum(sine(1000, 1, 0.1), FS, 600000, 4, 1); // order 3 = 30 kHz > Nyquist
    expect(at(spec, 2)).toBe(0);
    expect(at(spec, 3)).toBe(0);
  });
});

describe('dominantOrders', () => {
  it('sorts by energy, ties to the lower order, NaN last', () => {
    const spec = Float64Array.from([1, 5, 3, 5, Number.NaN]);
    expect(dominantOrders(spec, 0.5, 3)).toEqual([1, 2, 1.5]);
    expect(dominantOrders(spec, 0.5, 10)).toEqual([1, 2, 1.5, 0.5, 2.5]);
    expect(dominantOrders(spec, 0.5, 0)).toEqual([]);
  });
});

describe('truePeakDbtp', () => {
  it('finds the inter-sample peak a sample-peak meter misses', () => {
    // fs/8 sine with π/8 phase: sample peak = sin(3π/8) = −0.69 dB, true peak = 0 dB.
    const x = sine(FS / 8, 1, 0.05, Math.PI / 8);
    let samplePeak = 0;
    for (let i = 0; i < x.length; i++) samplePeak = Math.max(samplePeak, Math.abs(at(x, i)));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-0.688, 2);
    const tp = truePeakDbtp(x);
    expect(tp).toBeGreaterThan(-0.15);
    expect(tp).toBeLessThan(0.15);
  });

  it('is never below the sample peak, −200 for silence, NaN for NaN input', () => {
    const x = Float64Array.from([0, 0.25, -0.5, 0.1]);
    expect(truePeakDbtp(x)).toBeGreaterThanOrEqual(20 * Math.log10(0.5) - 1e-12);
    expect(truePeakDbtp(new Float32Array(64))).toBe(-200);
    expect(truePeakDbtp([])).toBe(-200);
    expect(truePeakDbtp([0, Number.NaN, 0])).toBeNaN();
  });
});

describe('rmsDb', () => {
  it('reads a full-scale sine at −3.01 dB and silence at −200', () => {
    expect(rmsDb(sine(997, 1, 1))).toBeCloseTo(-3.0103, 3);
    expect(rmsDb(new Float32Array(100))).toBe(-200);
    expect(rmsDb([])).toBe(-200);
  });
});

describe('bandEnergyDb', () => {
  it('reads a full-scale in-band sine at 0 dB and rejects out-of-band energy', () => {
    const x = sine(1000, 1, 1);
    expect(bandEnergyDb(x, FS, 500, 2000)).toBeCloseTo(0, 1);
    expect(bandEnergyDb(x, FS, 5000, 10000)).toBeLessThan(-100);
  });

  it('measures band ratios of a two-tone signal', () => {
    const a = sine(1000, 1, 1);
    const b = sine(5000, 0.1, 1);
    const x = new Float64Array(a.length);
    for (let i = 0; i < x.length; i++) x[i] = at(a, i) + at(b, i);
    const total = bandEnergyDb(x, FS, 0, FS / 2);
    expect(total).toBeCloseTo(10 * Math.log10(1.01), 1);
    expect(bandEnergyDb(x, FS, 4000, 6000) - total).toBeCloseTo(-20.04, 1);
  });

  it('returns −200 for empty input or an inverted band', () => {
    expect(bandEnergyDb([], FS, 0, 1000)).toBe(-200);
    expect(bandEnergyDb(sine(1000, 1, 0.1), FS, 2000, 1000)).toBe(-200);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/dsp-analysis.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/dsp/analysis' imported from …/tests/unit/dsp-analysis.test.ts` (Test Files 1 failed, no tests).

- [ ] **Step 3: Implement `src/dsp/analysis.ts`**

Create `src/dsp/analysis.ts`:

```ts
/**
 * Offline signal analysis for tests and tools (spec §11.3, §14). Allocates freely — never call from
 * the audio thread. Pure functions; no imports from sim/data/ui/DOM.
 */
import { OS_FACTOR, OS_TAPS, Upsampler4 } from './oversample';
import { gainToDb } from './util';

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** In-place iterative radix-2 complex FFT (forward, e^(−i2πkn/N), unnormalised). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (im.length !== n) throw new RangeError('fft: re and im must have the same length');
  if (!isPowerOfTwo(n)) throw new RangeError(`fft: length ${n} is not a power of two`);
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = (-2 * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(step * k);
      const wi = Math.sin(step * k);
      for (let a = k; a < n; a += len) {
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
      }
    }
  }
}

/** Symmetric Hann window: w[i] = 0.5 − 0.5·cos(2πi/(n−1)); n = 1 → [1]. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** |X(ω)|² of an already-windowed signal at `cyclesPerSample` via the Goertzel recursion. */
function goertzelPower(x: Float64Array, cyclesPerSample: number): number {
  const coeff = 2 * Math.cos(2 * Math.PI * cyclesPerSample);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = (x[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Energy (linear power) at orders k·step for k = 1..floor(maxOrder/step), base frequency rpm/60;
 * Hann-windowed Goertzel over the whole signal. Normalised so that a sine of amplitude A exactly at
 * an order's frequency yields A²/2 (its mean power) in that entry. Entries whose frequency is at or
 * above Nyquist are 0. Index i holds order (i + 1)·step.
 */
export function orderSpectrum(
  signal: ArrayLike<number>,
  fs: number,
  rpm: number,
  maxOrder: number,
  step: number,
): Float64Array {
  const count = step > 0 ? Math.max(0, Math.floor(maxOrder / step + 1e-9)) : 0;
  const out = new Float64Array(count);
  const n = signal.length;
  if (n === 0 || count === 0) return out;
  const w = hann(n);
  const xw = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i] ?? 0;
    wsum += wi;
    xw[i] = (signal[i] ?? 0) * wi;
  }
  const norm = 2 / (wsum * wsum);
  const base = rpm / 60;
  for (let k = 1; k <= count; k++) {
    const f = k * step * base;
    out[k - 1] = f > 0 && f < fs / 2 ? goertzelPower(xw, f / fs) * norm : 0;
  }
  return out;
}

/** True peak in dBTP: max of |x| and of the 4× (Upsampler4) interpolated samples; NaN if any sample is NaN. */
export function truePeakDbtp(signal: ArrayLike<number>): number {
  const up = new Upsampler4();
  up.reset();
  const n = signal.length;
  const tail = Math.ceil(OS_TAPS.length / OS_FACTOR);
  let peak = 0;
  for (let i = 0; i < n + tail; i++) {
    const x = i < n ? (signal[i] ?? 0) : 0;
    if (x !== x) return Number.NaN;
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    up.push(x);
    for (let j = 0; j < OS_FACTOR; j++) {
      const v = Math.abs(up.out[j] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return gainToDb(peak);
}

/** RMS level in dB re amplitude 1 (a full-scale sine reads −3.01 dB); empty/silent → −200. */
export function rmsDb(signal: ArrayLike<number>): number {
  const n = signal.length;
  if (n === 0) return gainToDb(0);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = signal[i] ?? 0;
    s += x * x;
  }
  return gainToDb(Math.sqrt(s / n));
}

/**
 * Energy in [loHz, hiHz] (inclusive bin centres) of the Hann-windowed, zero-padded FFT, in dB relative
 * to a full-scale sine (amplitude 1) whose energy lies entirely inside the band. Silence → −200.
 */
export function bandEnergyDb(signal: ArrayLike<number>, fs: number, loHz: number, hiHz: number): number {
  const len = signal.length;
  if (len === 0 || !(hiHz >= loHz)) return gainToDb(0);
  let n = 1;
  while (n < len) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(len);
  let w2 = 0;
  for (let i = 0; i < len; i++) {
    const wi = w[i] ?? 0;
    re[i] = (signal[i] ?? 0) * wi;
    w2 += wi * wi;
  }
  if (w2 === 0) return gainToDb(0);
  fft(re, im);
  const half = n >> 1;
  const df = fs / n;
  let e = 0;
  for (let k = 0; k <= half; k++) {
    const f = k * df;
    if (f < loHz || f > hiHz) continue;
    const r = re[k] ?? 0;
    const q = im[k] ?? 0;
    const p = r * r + q * q;
    e += k === 0 || k === half ? p : 2 * p;
  }
  const ref = (n * w2) / 2;
  return gainToDb(Math.sqrt(e / ref));
}

/** The topN orders ((index + 1)·step) sorted by energy, descending; ties → lower order first; NaN sorts last. */
export function dominantOrders(spectrum: Float64Array, step: number, topN: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < spectrum.length; i++) idx.push(i);
  const val = (i: number): number => {
    const v = spectrum[i] ?? 0;
    return v === v ? v : Number.NEGATIVE_INFINITY;
  };
  idx.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (vb > va) return 1;
    if (vb < va) return -1;
    return a - b;
  });
  return idx.slice(0, Math.max(0, Math.floor(topN))).map((i) => (i + 1) * step);
}
```

Notes: the Goertzel power is normalised by `2 / (Σw)²`, so a windowed sine of amplitude A on an order reads A²/2 (its mean power). `bandEnergyDb` uses Parseval: a full-scale sine's one-sided windowed energy is `N·Σw²/2`, which is the 0 dB reference, so ratios between two bands of the same signal are exact power ratios.

- [ ] **Step 4: Run the analysis test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-analysis.test.ts`
Expected: PASS (15 tests). If only the fs/8 true-peak case fails, check the T1 premise on the `Upsampler4` passband gain (Σ OS_TAPS ≈ 4) before touching this file.

- [ ] **Step 5: Write the failing WAV test**

Create `tests/unit/wav.test.ts` (it hand-assembles WAV files so the reader is tested independently of the writer):

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readWav, writeWav } from '../../tools/wav';

const dir = mkdtempSync(join(tmpdir(), 'tesbox-wav-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface BuildOpts {
  tag: number;
  nch: number;
  fs: number;
  bits: number;
  data: Buffer;
  extensibleSubTag?: number;
  preChunk?: Buffer;
}

/** Hand-assembles a WAV file so the reader is tested independently of the writer. */
function buildWav(o: BuildOpts): Buffer {
  const blockAlign = o.nch * (o.bits / 8);
  const fmt = Buffer.alloc(o.extensibleSubTag === undefined ? 16 : 40);
  fmt.writeUInt16LE(o.extensibleSubTag === undefined ? o.tag : 0xfffe, 0);
  fmt.writeUInt16LE(o.nch, 2);
  fmt.writeUInt32LE(o.fs, 4);
  fmt.writeUInt32LE(o.fs * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(o.bits, 14);
  if (o.extensibleSubTag !== undefined) {
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(o.bits, 18); // valid bits
    fmt.writeUInt32LE(0, 20); // channel mask
    fmt.writeUInt16LE(o.extensibleSubTag, 24); // SubFormat GUID (first 2 bytes = format tag)
  }
  const chunk = (id: string, body: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    o.preChunk ?? Buffer.alloc(0),
    chunk('data', o.data),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function file(name: string, content: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('writeWav / readWav', () => {
  it('round-trips 32-bit float stereo bit-exactly and creates the output directory', () => {
    const l = Float32Array.from([0, 0.5, -1, 0.123456789, 1e-8]);
    const r = Float32Array.from([1, -0.5, 0.25, -0.75, 0]);
    const p = join(dir, 'nested', 'deeper', 'rt.wav');
    writeWav(p, [l, r], 48000);
    const raw = readFileSync(p);
    expect(raw.toString('ascii', 0, 4)).toBe('RIFF');
    expect(raw.readUInt32LE(4)).toBe(raw.length - 8);
    expect(raw.readUInt16LE(20)).toBe(3); // WAVE_FORMAT_IEEE_FLOAT
    const back = readWav(p);
    expect(back.fs).toBe(48000);
    expect(back.channels.length).toBe(2);
    expect(Array.from(back.channels[0] ?? [])).toEqual(Array.from(l));
    expect(Array.from(back.channels[1] ?? [])).toEqual(Array.from(r));
  });

  it('writes a mono file that reads back with the same length', () => {
    const p = join(dir, 'mono.wav');
    writeWav(p, [new Float32Array(1000).fill(0.25)], 44100);
    const back = readWav(p);
    expect(back.fs).toBe(44100);
    expect(back.channels[0]?.length).toBe(1000);
    expect(back.channels[0]?.[999]).toBe(0.25);
  });

  it('rejects mismatched channel lengths, no channels, and bad sample rates', () => {
    const p = join(dir, 'bad.wav');
    expect(() => writeWav(p, [new Float32Array(2), new Float32Array(3)], 48000)).toThrow(RangeError);
    expect(() => writeWav(p, [], 48000)).toThrow(RangeError);
    expect(() => writeWav(p, [new Float32Array(2)], 0)).toThrow(RangeError);
    expect(() => writeWav(p, [new Float32Array(2)], 44100.5)).toThrow(RangeError);
  });

  it('reads 16-bit PCM, skipping an odd-sized chunk before data', () => {
    const data = Buffer.alloc(6);
    data.writeInt16LE(-32768, 0);
    data.writeInt16LE(0, 2);
    data.writeInt16LE(16384, 4);
    const list = Buffer.alloc(8 + 3 + 1);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(3, 4); // odd size → one pad byte follows
    const p = file('pcm16.wav', buildWav({ tag: 1, nch: 1, fs: 22050, bits: 16, data, preChunk: list }));
    const w = readWav(p);
    expect(w.fs).toBe(22050);
    expect(Array.from(w.channels[0] ?? [])).toEqual([-1, 0, 0.5]);
  });

  it('reads interleaved 24-bit PCM stereo', () => {
    const data = Buffer.alloc(12);
    data.writeIntLE(4194304, 0, 3); // L0 = 0.5
    data.writeIntLE(-8388608, 3, 3); // R0 = −1
    data.writeIntLE(-4194304, 6, 3); // L1 = −0.5
    data.writeIntLE(0, 9, 3); // R1 = 0
    const w = readWav(file('pcm24.wav', buildWav({ tag: 1, nch: 2, fs: 48000, bits: 24, data })));
    expect(Array.from(w.channels[0] ?? [])).toEqual([0.5, -0.5]);
    expect(Array.from(w.channels[1] ?? [])).toEqual([-1, 0]);
  });

  it('reads 32-bit integer PCM and WAVE_FORMAT_EXTENSIBLE', () => {
    const d32 = Buffer.alloc(8);
    d32.writeInt32LE(1073741824, 0);
    d32.writeInt32LE(-2147483648, 4);
    expect(Array.from(readWav(file('pcm32.wav', buildWav({ tag: 1, nch: 1, fs: 48000, bits: 32, data: d32 }))).channels[0] ?? [])).toEqual([0.5, -1]);
    const d24 = Buffer.alloc(3);
    d24.writeIntLE(-4194304, 0, 3);
    const ext = readWav(file('ext24.wav', buildWav({ tag: 1, nch: 1, fs: 96000, bits: 24, data: d24, extensibleSubTag: 1 })));
    expect(ext.fs).toBe(96000);
    expect(Array.from(ext.channels[0] ?? [])).toEqual([-0.5]);
  });

  it('rejects non-RIFF files and unsupported encodings', () => {
    expect(() => readWav(file('junk.wav', Buffer.from('not a wav file at all')))).toThrow(/RIFF/);
    const p8 = file('pcm8.wav', buildWav({ tag: 1, nch: 1, fs: 8000, bits: 8, data: Buffer.from([128, 255]) }));
    expect(() => readWav(p8)).toThrow(/unsupported/);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run tests/unit/wav.test.ts`
Expected: FAIL — `Error: Cannot find module '../../tools/wav' imported from …/tests/unit/wav.test.ts`.

- [ ] **Step 7: Implement `tools/wav.ts`**

Create `tools/wav.ts`:

```ts
/**
 * Minimal WAV I/O for the render/score CLIs (Node only).
 * writeWav: 32-bit IEEE float (format tag 3, 18-byte fmt chunk, fact chunk), interleaved.
 * readWav: PCM 16/24/32-bit integer and 32-bit float, incl. WAVE_FORMAT_EXTENSIBLE; skips unknown chunks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const HEADER_BYTES = 12 + (8 + 18) + (8 + 4) + 8;

export function writeWav(path: string, channels: Float32Array[], fs: number): void {
  const nch = channels.length;
  const first = channels[0];
  if (first === undefined || nch > 0xffff) throw new RangeError('writeWav: need 1..65535 channels');
  const frames = first.length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new RangeError('writeWav: all channels must have the same length');
  }
  if (!Number.isInteger(fs) || fs <= 0) throw new RangeError(`writeWav: invalid sample rate ${fs}`);
  const blockAlign = nch * 4;
  const dataBytes = frames * blockAlign;
  if (HEADER_BYTES + dataBytes > 0xffffffff) throw new RangeError('writeWav: file exceeds 4 GiB');
  const buf = Buffer.alloc(HEADER_BYTES + dataBytes);
  let o = 0;
  buf.write('RIFF', o, 'ascii');
  buf.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, o + 4);
  buf.write('WAVE', o + 8, 'ascii');
  o += 12;
  buf.write('fmt ', o, 'ascii');
  buf.writeUInt32LE(18, o + 4);
  buf.writeUInt16LE(WAVE_FORMAT_IEEE_FLOAT, o + 8);
  buf.writeUInt16LE(nch, o + 10);
  buf.writeUInt32LE(fs, o + 12);
  buf.writeUInt32LE(fs * blockAlign, o + 16);
  buf.writeUInt16LE(blockAlign, o + 20);
  buf.writeUInt16LE(32, o + 22);
  buf.writeUInt16LE(0, o + 24); // cbSize
  o += 26;
  buf.write('fact', o, 'ascii');
  buf.writeUInt32LE(4, o + 4);
  buf.writeUInt32LE(frames, o + 8);
  o += 12;
  buf.write('data', o, 'ascii');
  buf.writeUInt32LE(dataBytes, o + 4);
  o += 8;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < nch; c++) {
      buf.writeFloatLE(channels[c]?.[f] ?? 0, o);
      o += 4;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

interface Fmt {
  tag: number;
  nch: number;
  fs: number;
  blockAlign: number;
  bits: number;
}

export function readWav(path: string): { fs: number; channels: Float32Array[] } {
  const b = readFileSync(path);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`readWav: ${path} is not a RIFF/WAVE file`);
  }
  let fmt: Fmt | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > b.length) throw new Error(`readWav: ${path} has a truncated fmt chunk`);
      let tag = b.readUInt16LE(body);
      if (tag === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40) throw new Error(`readWav: ${path} has a truncated WAVE_FORMAT_EXTENSIBLE fmt chunk`);
        tag = b.readUInt16LE(body + 24); // first two bytes of the SubFormat GUID
      }
      fmt = {
        tag,
        nch: b.readUInt16LE(body + 2),
        fs: b.readUInt32LE(body + 4),
        blockAlign: b.readUInt16LE(body + 12),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, b.length - body);
    }
    off = body + size + (size & 1);
  }
  if (fmt === null) throw new Error(`readWav: ${path} has no fmt chunk`);
  if (dataOff < 0) throw new Error(`readWav: ${path} has no data chunk`);
  const { tag, nch, fs, blockAlign, bits } = fmt;
  const supported =
    (tag === WAVE_FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32)) ||
    (tag === WAVE_FORMAT_IEEE_FLOAT && bits === 32);
  if (!supported) throw new Error(`readWav: ${path}: unsupported format tag ${tag} with ${bits} bits`);
  const bytes = bits / 8;
  if (nch < 1 || blockAlign < nch * bytes) throw new Error(`readWav: ${path}: inconsistent fmt chunk`);
  const frames = Math.floor(dataLen / blockAlign);
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c++) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = dataOff + f * blockAlign;
    for (let c = 0; c < nch; c++) {
      const p = base + c * bytes;
      let v: number;
      if (tag === WAVE_FORMAT_IEEE_FLOAT) v = b.readFloatLE(p);
      else if (bits === 16) v = b.readInt16LE(p) / 32768;
      else if (bits === 24) v = b.readIntLE(p, 3) / 8388608;
      else v = b.readInt32LE(p) / 2147483648;
      const ch = channels[c];
      if (ch !== undefined) ch[f] = v;
    }
  }
  return { fs, channels };
}
```

- [ ] **Step 8: Run the WAV test and confirm it passes**

Run: `npx vitest run tests/unit/wav.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no output besides the npm script banners.

---

### Task 9: `TesboxDspCore` (`src/dsp/dsp-core.ts`) and the DSP invariant suite

**Files:**
- Create: `src/dsp/dsp-core.ts`
- Create: `tests/unit/helpers/dsp-harness.ts` (shared test support for the DSP and tool tests — not a test file; Vitest only collects `*.test.ts`)
- Test: `tests/unit/dsp-core.test.ts` (behaviour + Review Focus RF1, RF2)
- Test: `tests/unit/dsp-invariants.test.ts` (contract invariants 1–10)

**Interfaces:**
- Consumes (exact contract signatures):
  - `src/contracts.ts`: `MAX_COMBUSTION`, `MAX_SAMPLE_RATE`, `QUANTUM`, `SPEED_OF_SOUND_COLD`, `SPEED_OF_SOUND_MAX`; types `DspControl`, `DspCore`, `DspStats`, `EngineDef`, `OutputConfig`, `Perspective`, `Tier`.
  - T1 `src/dsp/util.ts`: `clamp(x, lo, hi): number`, `smoothstep(e0, e1, x): number`, `gainToDb(g): number`; `class Rng { constructor(seed?: number); next(): number; bipolar(): number }` (tests only).
  - T3 `src/dsp/exhaust.ts`: `new ExhaustNetwork(fs)`, `configure(def: EngineDef, tier: Tier): void`, `setGasSpeeds(header, collector, muffler): void`, `setValve(open01): void`, `setTurbineAttenuation(x01): void`, `tick(headerIn: Float64Array, popIn: number): void`, `readonly outlet: number`, `energy(): number`, `reset(): void`.
  - T4 `src/dsp/combustion.ts`: `new CombustionSource(fs)`, `configure(spec, voicing, seed): void`, public fields `skipMask: number` and `skipIsIgnition: boolean` (amendment B4), `tick(rpm, load, combustionGain, exhaustOut: Float64Array, intakeGate: Float64Array): number`, `takeIgnitionCutPops(): number`, `reset(): void`.
  - T5 `src/dsp/rpm-state.ts`: `new RpmState(fs)`, `configure(spec): void`, `tick(ctl: DspControl, nowS: number): void`, `readonly rpm: number`, `readonly cut: boolean`, `readonly cutIsIgnition: boolean`, `readonly falling: boolean`, `reset(rpm?: number): void`.
  - T6: `new IntakeLayer(fs)`, `configure(voicing, seed)`, `tick(gateSum, throttle01): number`, `reset()`; `new MechanicalLayer(fs)`, `configure(spec, voicing, seed)`, `tick(ignitionImpulse, rpm): number`, `reset()`; `new ForcedInduction(fs)`, `configure(spec, voicing, seed)`, `tick(rpm, load): number`, `readonly boost: number`, `whineHz(rpm): number`, `reset()`; `new OverrunLayer(fs)`, `configure(spec, voicing, seed)`, `tick(regime, rpm, falling, valveOpen01, modeFactor, ignitionCutPops): void`, `readonly popInject: number`, `readonly airflow: number`, `reset()`.
  - T7: `new PerspectiveMixer(fs)`, `configure(voicing)`, `setPerspective(p: Perspective)`, `tick(exhaust, intake, block, fi, airflow): void`, `readonly l`, `readonly r`, `reset()`; `new OutputStage(fs)`, `configure(out: OutputConfig)`, `beginQuantum(trimDb, frames)`, `process(l, r): void`, `readonly l`, `readonly r`, `takeTruePeak(): number`, `readonly gainReductionDb: number`, `reset()`.
  - T8 `src/dsp/analysis.ts` (tests only): `fft`, `hann`, `orderSpectrum`, `dominantOrders`, `truePeakDbtp`, `rmsDb`, `bandEnergyDb`.
- Produces:
  - `export class TesboxDspCore implements DspCore`:
    - `constructor(fs: number, seed = 1)` — allocates every module and buffer; `RangeError` unless `0 < fs ≤ MAX_SAMPLE_RATE`.
    - `configure(def: EngineDef, output: OutputConfig, tier: Tier): void` — never allocates on success; first calls `assertEngineFits(def, fs)` (throws `RangeError` before touching any state). Before the first `render()`: applies immediately, then a 50 ms fade-in. While running: if `def` (by reference), `tier`, `output.subwoofer` or `output.hpCornerHz` differ from the applied config → 300 ms fade-out, apply at the end of the quantum in which the fade reaches 0, 300 ms fade-in; a further `configure()` during the fade-out retargets the queued swap (last request wins); requesting the applied config again cancels the swap and fades back in. `output.volumeTrimDb` (clamped to [−24, +6]) always applies immediately (OutputStage ramps it per quantum) — a trim-only change never fades.
    - `render(ctl: DspControl, outL: Float32Array, outR: Float32Array, frames: number, nowS: number): void` — writes silence before the first configure; `frames > 128` is processed in 128-frame blocks (bit-identical to separate calls); writes at most `min(frames, outL.length, outR.length)` frames.
    - `get stats(): DspStats` (satisfies `readonly stats`) — refreshes one shared object in place; `truePeakDbtp` is read-and-reset (`OutputStage.takeTruePeak()` on every read = "max since last read"), so callers read `stats` once per snapshot.
    - `forceHot(): void` — test hook: gas speeds snap to their hot target for the current load at the next quantum, and warm-up is held at 1 from then on.
    - `readonly exhaustBus: Float32Array` — length `QUANTUM`; the last block's `ExhaustNetwork.outlet` per sample (pre-perspective, pre-bass, pre-fade).
  - `export function assertEngineFits(def: EngineDef, fs: number): void` — `RangeError` unless 1 ≤ `combustion.length` ≤ `MAX_COMBUSTION`, `headersM.length === combustion.length`, 1–4 muffler sections, and every section length lies in `[4·SPEED_OF_SOUND_MAX/fs, max]` with max header 1.5, collector 1.0, mid-pipe 3.0, muffler section 0.8, tailpipe 1.2 m (contract capacity limits, B3).
  - `export const CONFIG_FADE_S = 0.3; export const RECOVERY_FADE_S = 0.05;`
  - Decisions the contract leaves open (all in `dsp-core.ts`): ignition off fades combustion/layer excitation to 0 over 0.3 s and the whole pre-OutputStage mix over 1.5 s (the exhaust rings out); ignition on ramps both up in 20 ms. `OverrunLayer` modeFactor: comfort 1, sport 2. The valve stays 0 when `voicing.exhaust.valve.fitted === false`. Turbine attenuation = √`ForcedInduction.boost` (shaft speed, since turbo boost = shaft²). Gas speeds snap to the control's target after every (re)configure and non-finite reset, then slew with τ = 3 s. Overrun eligibility uses the sanitised `ctl.rpm`.
  - Skip masks (amendments B4/B5): while `RpmState.cut`, a cut with `ctl.limiter && !ctl.shift.active` is a limiter cut — `skipMask` = all entries for `*-hard`, `allMask & 0x5555` (entries 0, 2, 4, …) for `*-soft`, `skipIsIgnition = limiter type starts with 'ignition'`; any other cut is a shift cut — all entries, `skipIsIgnition = RpmState.cutIsIgnition`. Every `takeIgnitionCutPops()` result goes to `OverrunLayer.tick`.
  - White-box names read by the tests through `internals()` (TS-private, present at runtime): `def`, `combustion`, `exhaust`, `overrun`, `rpmState`, `gasHeader`, `gasCollector`, `gasMuffler`, `regime`, `valve`, `lastCombustionGain`.
  - `tests/unit/helpers/dsp-harness.ts` (T10's tests import `FIXTURE_IDS`, `loadFixture`, `makeCtl`, `allFinite` from it): `FS`, `FIXTURE_IDS`, `loadFixture(id)`, `OUT_SUB`, `makeCtl(rpm, load, over?)` (app defaults: valve `auto`, cabin, comfort, warm, engaged, gear 3), `CoreHarness` (`core`, `tS`, `run(seconds, ctl, before?)`), `Rendered`, `HarnessOpts`, `CoreInternals`, `internals(core)`, `slice`, `peakAbs`, `peakDb`, `maxStep`, `allFinite`, `bitIdentical`, `countBufferConstructions(onConstruct)`.

**Cross-task premises** (open each file and confirm every bullet before coding; a mismatch is fixed in the owning task, not by bending this code):
- T1 fixtures `tests/fixtures/engines/{i4-test,i5-test,i6-test,v8-crossplane-test,v8-flatplane-test,v8-sc-test,flat4-uel-test,rotary-test}.json` exist as full `EngineDef`s with those `id`s; `i5-test` has 5 entries (soft mask `0b10101`); the turbo fixtures (`i4`, `i5`, `flat4-uel`, `rotary`) and `v8-sc-test` have non-null `voicing.forcedInduction`; `v8-sc-test` is a roots supercharger; every fixture has `voicing.overrun.fuelCutResumeRpm < 5000` and `rpm.limiter.rpm ≤ 9800`; per amendment B8 the even-fire fixtures (`i4`, `i6`, `v8-flatplane`) use equal `headersM` for every entry (invariant 2's even-fire branch depends on it).
- T1 `smoothstep(e0, e1, x)` is the cubic `t²(3 − 2t)` with `t = clamp((x − e0)/(e1 − e0), 0, 1)` (a test expects `smoothstep(−0.08, 0.02, −0.03) = 0.5` → regime 0.5).
- T3 `ExhaustNetwork`: `outlet` is valid right after `tick()`; `energy()` is finite for finite state and becomes NaN when NaN is fed through `tick()` (the recovery test poisons it that way); `configure()`/`reset()` never allocate; impulse energy decays monotonically per 50 ms window to ≤ −120 dB within 2 s for every fixture × tier × valve {0, 1} × speeds {343, 700/560/460} (invariant 7 drives the network directly).
- T4 `CombustionSource`: `skipMask` and `skipIsIgnition` are plain public fields (B4) that the tests read back; any skipped firing suppresses its blowdown pulse and ignition impulse, and only skips with `skipIsIgnition` are counted by `takeIgnitionCutPops()`; `tick` tolerates `rpm = 0` (RF2 ramps rpm to 0) without NaN.
- T5 `RpmState`: `reset(rpm)` sets `rpm` immediately; while `ctl.limiter` the `cut` flag is true for the whole cut phase (B5) with 8–20 cut→fire transitions per second and no cut > 100 ms; during `ctl.shift.active` with `u < 0.4`, `cut === true` and `cutIsIgnition` is true for `dct`/`pdk`/`amt`, false for `manual`/`tc-auto`.
- T6: `ForcedInduction.boost ∈ [0, 1]` (> 0 for `v8-sc-test` at 4000 rpm, load 1); `IntakeLayer` is silent at `throttle01 = 0`; `OverrunLayer.tick` is an ordinary prototype method (one test wraps it on the instance to count the pops it receives).
- T7 `PerspectiveMixer.setPerspective` starts a 300 ms crossfade (the first call after construct/configure/reset may snap), so the core calls it only when `ctl.perspective` changes and again after every reset; the cabin forced-induction gain is `dbToGain(voicing.forcedInduction.cabinGainDb)` without clamping (invariant 5 mutes it with −200 dB in a copy). `OutputStage`: `beginQuantum` once per block before `process`; output is always finite (NaN guard + NaN-safe clip) and ≤ 0.8913; true peak ≤ −1.0 dBTP (B9 limiter target −1.3 dBTP); `takeTruePeak()` returns the max since the previous call and resets; `gainReductionDb` is finite; `configure()`/`reset()` are safe while the input is silent; with the input held at exactly 0 the stage (incl. the NLD virtual bass, whose shaper output must scale to 0 with its envelope) decays below −90 dBFS within 0.45 s.
- Every module `configure()` only sets parameters and clears state (no `new`) — RF1 counts typed-array/ArrayBuffer constructions during engine and tier swaps and expects 0.
- T8 `analysis.ts` behaves as its Produces list states (order index `i` ↔ order `(i + 1)·step`; `bandEnergyDb` ratios are power ratios).

- [ ] **Step 1: Create the shared test harness**

Create `tests/unit/helpers/dsp-harness.ts`:

```ts
/** Shared helpers for the DSP and tool tests (not a test file: Vitest only collects files ending in .test.ts). */
import { readFileSync } from 'node:fs';
import { QUANTUM, type DspControl, type EngineDef, type OutputConfig, type Tier } from '../../../src/contracts';
import { gainToDb } from '../../../src/dsp/util';
import { TesboxDspCore } from '../../../src/dsp/dsp-core';
import type { CombustionSource } from '../../../src/dsp/combustion';
import type { ExhaustNetwork } from '../../../src/dsp/exhaust';
import type { OverrunLayer } from '../../../src/dsp/overrun';
import type { RpmState } from '../../../src/dsp/rpm-state';

export const FS = 48000;

export const FIXTURE_IDS = [
  'i4-test',
  'i5-test',
  'i6-test',
  'v8-crossplane-test',
  'v8-flatplane-test',
  'v8-sc-test',
  'flat4-uel-test',
  'rotary-test',
] as const;

export function loadFixture(id: string): EngineDef {
  const url = new URL(`../../fixtures/engines/${id}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as EngineDef;
}

export const OUT_SUB: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 };

/** Steady control with the app defaults: ignition on, warm, engaged, valve auto, cabin, comfort. */
export function makeCtl(rpm: number, load: number, over: Partial<DspControl> = {}): DspControl {
  return {
    rpm,
    load,
    gear: 3,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: rpm, toRpm: rpm, t0: 0, durationS: 0.1 },
    ignitionOn: true,
    runTimeS: 600,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
    ...over,
  };
}

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  exhaust: Float32Array;
}

export interface HarnessOpts {
  tier?: Tier;
  seed?: number;
  /** forceHot() after configure (default true). */
  hot?: boolean;
  output?: OutputConfig;
}

/** Drives one core in whole quanta; consecutive run() calls continue the same timeline. */
export class CoreHarness {
  readonly core: TesboxDspCore;
  private q = 0;
  private readonly l = new Float32Array(QUANTUM);
  private readonly r = new Float32Array(QUANTUM);

  constructor(def: EngineDef, opts: HarnessOpts = {}) {
    this.core = new TesboxDspCore(FS, opts.seed ?? 1);
    this.core.configure(def, opts.output ?? OUT_SUB, opts.tier ?? 'full');
    if (opts.hot ?? true) this.core.forceHot();
  }

  /** Time (s) of the next quantum. */
  get tS(): number {
    return (this.q * QUANTUM) / FS;
  }

  /** Renders round(seconds·FS/QUANTUM) quanta; `before` runs before each quantum with that quantum's start time. */
  run(seconds: number, ctl: DspControl, before?: (tS: number) => void): Rendered {
    const quanta = Math.round((seconds * FS) / QUANTUM);
    const out: Rendered = {
      left: new Float32Array(quanta * QUANTUM),
      right: new Float32Array(quanta * QUANTUM),
      exhaust: new Float32Array(quanta * QUANTUM),
    };
    for (let i = 0; i < quanta; i++) {
      const t = this.tS;
      before?.(t);
      this.core.render(ctl, this.l, this.r, QUANTUM, t);
      out.left.set(this.l, i * QUANTUM);
      out.right.set(this.r, i * QUANTUM);
      out.exhaust.set(this.core.exhaustBus, i * QUANTUM);
      this.q++;
    }
    return out;
  }
}

/** White-box view of TesboxDspCore's private members (TS-private only; present at runtime). */
export interface CoreInternals {
  def: EngineDef | null;
  combustion: CombustionSource;
  exhaust: ExhaustNetwork;
  overrun: OverrunLayer;
  rpmState: RpmState;
  gasHeader: number;
  gasCollector: number;
  gasMuffler: number;
  regime: number;
  valve: number;
  lastCombustionGain: number;
}

export function internals(core: TesboxDspCore): CoreInternals {
  return core as unknown as CoreInternals;
}

export function slice(sig: Float32Array, fromS: number, toS: number): Float32Array {
  return sig.subarray(Math.round(fromS * FS), Math.round(toS * FS));
}

export function peakAbs(sig: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < sig.length; i++) p = Math.max(p, Math.abs(sig[i] ?? 0));
  return p;
}

export function peakDb(sig: ArrayLike<number>): number {
  return gainToDb(peakAbs(sig));
}

/** Largest |x[n] − x[n−1]|. */
export function maxStep(sig: ArrayLike<number>): number {
  let m = 0;
  for (let i = 1; i < sig.length; i++) m = Math.max(m, Math.abs((sig[i] ?? 0) - (sig[i - 1] ?? 0)));
  return m;
}

export function allFinite(sig: ArrayLike<number>): boolean {
  for (let i = 0; i < sig.length; i++) if (!Number.isFinite(sig[i] ?? Number.NaN)) return false;
  return true;
}

export function bitIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

const TYPED_CTORS = [
  'ArrayBuffer',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
] as const;

/**
 * Counts `new` on every typed-array / ArrayBuffer constructor while installed (global proxies).
 * Returns an uninstall function. Keep test-side allocation out of the counted window.
 */
export function countBufferConstructions(onConstruct: (name: string) => void): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = TYPED_CTORS.map((name) => g[name]);
  for (const name of TYPED_CTORS) {
    const ctor = g[name] as abstract new (...args: never[]) => object;
    g[name] = new Proxy(ctor, {
      construct(target, args, newTarget) {
        onConstruct(name);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
  }
  return () => {
    TYPED_CTORS.forEach((name, i) => {
      g[name] = saved[i];
    });
  };
}
```

- [ ] **Step 2: Write the failing core test (behaviour, RF1, RF2)**

Create `tests/unit/dsp-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION, QUANTUM, type EngineDef, type OutputConfig } from '../../src/contracts';
import { rmsDb } from '../../src/dsp/analysis';
import { TesboxDspCore, assertEngineFits } from '../../src/dsp/dsp-core';
import {
  CoreHarness,
  FS,
  OUT_SUB,
  allFinite,
  bitIdentical,
  countBufferConstructions,
  internals,
  loadFixture,
  makeCtl,
  maxStep,
  peakAbs,
  peakDb,
  slice,
} from './helpers/dsp-harness';

/** Lowest RMS (dB) over consecutive 10 ms windows. */
function minWindowRmsDb(sig: Float32Array): number {
  const w = Math.round(0.01 * FS);
  let m = Infinity;
  for (let i = 0; i + w <= sig.length; i += w) m = Math.min(m, rmsDb(sig.subarray(i, i + w)));
  return m;
}

describe('TesboxDspCore basics', () => {
  it('outputs silence before configure and rejects sample rates outside (0, 48000]', () => {
    const core = new TesboxDspCore(FS);
    const l = new Float32Array(QUANTUM).fill(1);
    const r = new Float32Array(QUANTUM).fill(1);
    core.render(makeCtl(3000, 0.5), l, r, QUANTUM, 0);
    expect(peakAbs(l)).toBe(0);
    expect(peakAbs(r)).toBe(0);
    expect(() => new TesboxDspCore(96000)).toThrow(RangeError);
    expect(() => new TesboxDspCore(0)).toThrow(RangeError);
  });

  it('configure() rejects engines the capacity cannot hold, before touching any state', () => {
    const base = loadFixture('i4-test');
    const bad: [string, (d: EngineDef) => void][] = [
      ['more than MAX_COMBUSTION entries', (d) => {
        d.spec.combustion = Array.from({ length: MAX_COMBUSTION + 1 }, (_, i) => ({ angleDeg: i * 40, bank: 0 }));
        d.voicing.headersM = d.spec.combustion.map(() => 0.6);
      }],
      ['headersM count ≠ combustion count', (d) => void d.voicing.headersM.pop()],
      ['header > 1.5 m', (d) => void (d.voicing.headersM[0] = 1.6)],
      ['collector > 1.0 m', (d) => void (d.voicing.collectors.forEach((c) => (c.lengthM = 1.1)))],
      ['mid-pipe > 3.0 m', (d) => void (d.voicing.exhaust.midPipeM = 3.1)],
      ['no muffler section', (d) => void (d.voicing.exhaust.mufflerSectionsM = [])],
      ['5 muffler sections', (d) => void (d.voicing.exhaust.mufflerSectionsM = [0.2, 0.2, 0.2, 0.2, 0.2])],
      ['muffler section > 0.8 m', (d) => void (d.voicing.exhaust.mufflerSectionsM[0] = 0.9)],
      ['tailpipe > 1.2 m', (d) => void (d.voicing.exhaust.tailpipeM = 1.3)],
      ['section < 4 samples at 700 m/s', (d) => void (d.voicing.exhaust.tailpipeM = 0.05)],
      ['NaN length', (d) => void (d.voicing.exhaust.midPipeM = Number.NaN)],
    ];
    for (const [label, mutate] of bad) {
      const d = structuredClone(base);
      mutate(d);
      expect(() => assertEngineFits(d, FS), label).toThrow(RangeError);
      expect(() => new TesboxDspCore(FS).configure(d, OUT_SUB, 'full'), label).toThrow(RangeError);
    }
    expect(() => assertEngineFits(base, FS)).not.toThrow();

    // A running core keeps playing its engine when a bad swap is requested (no fade-out starts).
    const h = new CoreHarness(base);
    const ctl = makeCtl(3000, 0.5);
    h.run(0.3, ctl);
    const broken = structuredClone(base);
    broken.voicing.exhaust.tailpipeM = 5;
    expect(() => h.core.configure(broken, OUT_SUB, 'full')).toThrow(RangeError);
    const after = h.run(0.5, ctl);
    expect(internals(h.core).def).toBe(base);
    expect(minWindowRmsDb(after.left)).toBeGreaterThan(-60);
  });

  it('renders finite, audible stereo and a live exhaust bus', () => {
    const h = new CoreHarness(loadFixture('i4-test'));
    const out = h.run(1, makeCtl(3000, 0.5));
    expect(allFinite(out.left) && allFinite(out.right) && allFinite(out.exhaust)).toBe(true);
    expect(rmsDb(slice(out.left, 0.5, 1))).toBeGreaterThan(-60);
    expect(rmsDb(slice(out.right, 0.5, 1))).toBeGreaterThan(-60);
    expect(rmsDb(slice(out.exhaust, 0.5, 1))).toBeGreaterThan(-80);
    expect(peakAbs(out.left)).toBeLessThanOrEqual(0.8913);
  });

  it('splits frames > 128 into quanta exactly like separate 128-frame calls', () => {
    const def = loadFixture('v8-crossplane-test');
    const ctl = makeCtl(4000, 0.6);
    const a = new TesboxDspCore(FS, 7);
    const b = new TesboxDspCore(FS, 7);
    a.configure(def, OUT_SUB, 'full');
    b.configure(def, OUT_SUB, 'full');
    const n = 3 * QUANTUM;
    const al = new Float32Array(n);
    const ar = new Float32Array(n);
    const bl = new Float32Array(n);
    const br = new Float32Array(n);
    const ql = new Float32Array(QUANTUM);
    const qr = new Float32Array(QUANTUM);
    for (let block = 0; block < 20; block++) {
      const t = block * n * (1 / FS);
      a.render(ctl, al, ar, n, t);
      for (let q = 0; q < 3; q++) {
        b.render(ctl, ql, qr, QUANTUM, t + q * QUANTUM * (1 / FS));
        bl.set(ql, q * QUANTUM);
        br.set(qr, q * QUANTUM);
      }
      expect(bitIdentical(al, bl) && bitIdentical(ar, br)).toBe(true);
    }
  });
});

describe('TesboxDspCore configure / fades', () => {
  it('RF1: engine change, then tier change, while rendering → 300 ms fades, no NaN, no buffer allocation, no step > 0.1 FS', { timeout: 60_000 }, () => {
    const v8 = loadFixture('v8-crossplane-test');
    const i4 = loadFixture('i4-test');
    const out: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: -6 };
    const core = new TesboxDspCore(FS, 1);
    core.configure(v8, out, 'full');
    core.forceHot();
    const ctl = makeCtl(2000, 0.3);
    const quanta = Math.round((4 * FS) / QUANTUM);
    const qEngine = Math.round((1 * FS) / QUANTUM); // t = 1.0 s
    const qTier = Math.round((2 * FS) / QUANTUM); // t = 2.0 s
    const left = new Float32Array(quanta * QUANTUM);
    const right = new Float32Array(quanta * QUANTUM);
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    let constructed = 0;
    let uninstall: (() => void) | null = null;
    try {
      for (let q = 0; q < quanta; q++) {
        if (q === qEngine) {
          uninstall = countBufferConstructions(() => {
            constructed++;
          });
          core.configure(i4, out, 'full');
        }
        if (q === qTier) core.configure(i4, out, 'lite');
        core.render(ctl, l, r, QUANTUM, (q * QUANTUM) / FS);
        left.set(l, q * QUANTUM);
        right.set(r, q * QUANTUM);
      }
    } finally {
      uninstall?.();
    }
    expect(constructed).toBe(0);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(core.stats.nonFiniteResets).toBe(0);
    expect(maxStep(left)).toBeLessThanOrEqual(0.1);
    expect(maxStep(right)).toBeLessThanOrEqual(0.1);
    const steadyV8 = rmsDb(slice(left, 0.6, 1.0));
    expect(steadyV8).toBeGreaterThan(-50);
    for (const t0 of [1, 2]) {
      // fade-out reaches 0 at t0 + 0.3 s; the swap is applied at the end of that quantum
      expect(rmsDb(slice(left, t0 + 0.26, t0 + 0.29))).toBeLessThan(steadyV8 - 6);
      // fade gain ≤ 0.004 here: < 0.05 even if the pre-OutputStage peak runs at +20 dBFS; a missing fade reads ≫ 0.05
      expect(peakAbs(slice(left, t0 + 0.2995, t0 + 0.3025))).toBeLessThan(0.05);
    }
    const steadyI4 = rmsDb(slice(left, 1.7, 2.0));
    expect(steadyI4).toBeGreaterThan(-50);
    expect(rmsDb(slice(left, 1.31, 1.34))).toBeLessThan(steadyI4 - 6); // fading in, not stepping in
    expect(rmsDb(slice(left, 3.0, 4.0))).toBeGreaterThan(-50); // lite tier audible
    expect(internals(core).def).toBe(i4);
  });

  it('retargets a queued swap (last request wins) and cancels it when the applied engine is requested again', { timeout: 30_000 }, () => {
    const v8 = loadFixture('v8-crossplane-test');
    const i4 = loadFixture('i4-test');
    const i6 = loadFixture('i6-test');
    const h = new CoreHarness(v8);
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    h.run(1, ctl);
    h.core.configure(i4, OUT_SUB, 'full');
    h.run(0.1, ctl);
    h.core.configure(i6, OUT_SUB, 'full'); // still fading out → retarget
    h.run(0.6, ctl);
    expect(internals(h.core).def).toBe(i6);
    const steady = h.run(0.3, ctl);
    h.core.configure(v8, OUT_SUB, 'full');
    const down = h.run(0.15, ctl); // fade gain 1 → 0.5
    h.core.configure(i6, OUT_SUB, 'full'); // back to the applied engine → cancel, fade back in
    const up = h.run(0.4, ctl);
    expect(internals(h.core).def).toBe(i6);
    const ref = rmsDb(steady.left);
    expect(minWindowRmsDb(down.left)).toBeGreaterThan(ref - 12);
    expect(minWindowRmsDb(up.left)).toBeGreaterThan(ref - 12);
  });

  it('applies a trim-only configure immediately, without a fade', { timeout: 30_000 }, () => {
    const def = loadFixture('v8-crossplane-test');
    const h = new CoreHarness(def);
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    const before = h.run(1, ctl);
    h.core.configure(def, { ...OUT_SUB, volumeTrimDb: -12 }, 'full');
    const after = h.run(0.6, ctl);
    expect(minWindowRmsDb(after.left)).toBeGreaterThan(-50);
    expect(rmsDb(slice(after.left, 0.3, 0.6))).toBeLessThan(rmsDb(slice(before.left, 0.5, 1)) - 3);
  });
});

describe('TesboxDspCore ignition', () => {
  const OUT_NO_SUB: OutputConfig = { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 };

  it('RF2: ignition off → < −90 dBFS within 2 s, no NaN; ignition on restores sound', { timeout: 30_000 }, () => {
    const h = new CoreHarness(loadFixture('i4-test'), { output: OUT_NO_SUB });
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    const on = h.run(1, ctl);
    expect(rmsDb(slice(on.left, 0.5, 1))).toBeGreaterThan(-50);
    const tOff = h.tS;
    ctl.ignitionOn = false;
    ctl.load = 0;
    ctl.driveline = 'clutch-open';
    const off = h.run(2, ctl, (t) => {
      ctl.rpm = Math.max(0, 3000 * (1 - (t - tOff))); // SimCore: rpm → 0 over 1 s
    });
    expect(allFinite(off.left) && allFinite(off.right)).toBe(true);
    expect(peakDb(slice(off.left, 1.95, 2.0))).toBeLessThan(-90);
    expect(peakDb(slice(off.right, 1.95, 2.0))).toBeLessThan(-90);
    ctl.ignitionOn = true;
    ctl.rpm = 900;
    ctl.load = 0.2;
    ctl.driveline = 'engaged';
    const back = h.run(1, ctl);
    expect(allFinite(back.left)).toBe(true);
    expect(rmsDb(slice(back.left, 0.5, 1))).toBeGreaterThan(-60);
    expect(h.core.stats.nonFiniteResets).toBe(0);
  });

  it('RF2: ignition off with rpm and load held (adversarial control) is still silent within 2 s', { timeout: 30_000 }, () => {
    const h = new CoreHarness(loadFixture('v8-sc-test'), { output: OUT_NO_SUB });
    const ctl = makeCtl(4000, 1, { perspective: 'outside', valve: 'open' });
    h.run(1, ctl);
    ctl.ignitionOn = false;
    const off = h.run(2, ctl);
    expect(allFinite(off.left)).toBe(true);
    expect(peakDb(slice(off.left, 1.95, 2.0))).toBeLessThan(-90);
    expect(peakDb(slice(off.right, 1.95, 2.0))).toBeLessThan(-90);
  });
});

describe('TesboxDspCore robustness and control', () => {
  it('recovers from non-finite module state: full reset, counter, 50 ms fade-in', () => {
    const h = new CoreHarness(loadFixture('v8-crossplane-test'));
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    h.run(0.5, ctl);
    internals(h.core).exhaust.tick(new Float64Array(MAX_COMBUSTION).fill(Number.NaN), Number.NaN);
    const hit = h.run(QUANTUM / FS, ctl);
    expect(allFinite(hit.left) && allFinite(hit.right)).toBe(true);
    expect(h.core.stats.nonFiniteResets).toBe(1);
    const after = h.run(0.6, ctl);
    expect(allFinite(after.left) && allFinite(after.right)).toBe(true);
    const settled = peakAbs(slice(after.left, 0.3, 0.6));
    expect(rmsDb(slice(after.left, 0.3, 0.6))).toBeGreaterThan(-50);
    expect(peakAbs(after.left.subarray(0, 64))).toBeLessThan(0.5 * settled); // fade gain ≤ 0.027 in the first 64 samples
    expect(h.core.stats.nonFiniteResets).toBe(1);
  });

  it('sanitises non-finite control values instead of resetting', () => {
    const h = new CoreHarness(loadFixture('i6-test'));
    const ctl = makeCtl(Number.NaN, Number.POSITIVE_INFINITY, { runTimeS: Number.NaN });
    ctl.shift = { active: true, up: true, fromRpm: Number.NaN, toRpm: 3000, t0: 0, durationS: 0 };
    const out = h.run(0.2, ctl);
    expect(allFinite(out.left) && allFinite(out.right)).toBe(true);
    expect(h.core.stats.nonFiniteResets).toBe(0);
  });

  it('reports stats; the true peak is read-and-reset', () => {
    const h = new CoreHarness(loadFixture('v8-sc-test'));
    h.run(1, makeCtl(4000, 1, { perspective: 'outside' }));
    const s = h.core.stats;
    expect(s.nonFiniteResets).toBe(0);
    expect(s.boost).toBeGreaterThan(0);
    expect(s.boost).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.limiterGainReductionDb)).toBe(true);
    const tp1 = s.truePeakDbtp;
    expect(tp1).toBeGreaterThan(-60);
    expect(tp1).toBeLessThanOrEqual(-1 + 1e-3);
    const tp2 = h.core.stats.truePeakDbtp;
    expect(tp2).toBeLessThan(tp1);
  });

  it('forceHot snaps gas speeds to the hot target for the current load; otherwise they slew with τ = 3 s', () => {
    const def = loadFixture('i6-test');
    const hot = new CoreHarness(def);
    hot.run(QUANTUM / FS, makeCtl(3000, 0.5));
    const heat = 0.6 + 0.4 * 0.5;
    expect(internals(hot.core).gasHeader).toBeCloseTo(343 + 357 * heat, 9);
    expect(internals(hot.core).gasCollector).toBeCloseTo(343 + 217 * heat, 9);
    expect(internals(hot.core).gasMuffler).toBeCloseTo(343 + 117 * heat, 9);
    const cold = new CoreHarness(def, { hot: false });
    cold.run(1, makeCtl(3000, 0.5, { warm: false, runTimeS: 0 }));
    expect(internals(cold.core).gasHeader).toBeCloseTo(343, 9);
    cold.run(3, makeCtl(3000, 0.5, { warm: true }));
    expect(internals(cold.core).gasHeader).toBeCloseTo(343 + 357 * heat * (1 - Math.exp(-1)), 6);
  });

  it('crossfades combustion ↔ overrun only when eligible, with the idle floor otherwise', () => {
    const h = new CoreHarness(loadFixture('v8-crossplane-test'));
    const ctl = makeCtl(5000, 0.5);
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBe(0);
    ctl.load = -0.6;
    h.run(0.04, ctl); // 1920 samples of a 3840-sample (80 ms) slew
    expect(internals(h.core).regime).toBeCloseTo(0.5, 9);
    h.run(0.1, ctl);
    expect(internals(h.core).regime).toBe(1);
    expect(internals(h.core).lastCombustionGain).toBe(0);
    ctl.load = -0.03; // smoothstep(−0.08, 0.02, −0.03) = 0.5
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBeCloseTo(0.5, 9);
    expect(internals(h.core).lastCombustionGain).toBeCloseTo(0.5, 9);
    ctl.load = -0.6;
    ctl.driveline = 'clutch-open'; // not eligible → regime 0, full combustion gain
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBe(0);
    expect(internals(h.core).lastCombustionGain).toBe(1);
  });

  it('slews the exhaust valve over 200 ms per mode and keeps an unfitted valve shut', () => {
    const def = structuredClone(loadFixture('v8-crossplane-test'));
    def.voicing.exhaust.valve.fitted = true;
    const h = new CoreHarness(def);
    const ctl = makeCtl(2000, 0.2, { valve: 'open' });
    h.run(0.1, ctl); // 38 quanta
    expect(internals(h.core).valve).toBeCloseTo((38 * QUANTUM) / (0.2 * FS), 9);
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.valve = 'auto'; // comfort, 2000 rpm → closed
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(0, 9);
    ctl.driveMode = 'sport';
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.driveMode = 'comfort';
    ctl.rpm = 4000;
    ctl.load = 0.5;
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.valve = 'closed';
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(0, 9);
    const shut = structuredClone(def);
    shut.voicing.exhaust.valve.fitted = false;
    const h2 = new CoreHarness(shut);
    h2.run(0.3, makeCtl(5000, 1, { valve: 'open' }));
    expect(internals(h2.core).valve).toBe(0);
  });

  it('B5 skip masks: hard limiter and shift cuts skip every entry, soft limiter skips entries 0, 2, 4, …', () => {
    const types = ['fuel-hard', 'ignition-hard', 'fuel-soft', 'ignition-soft'] as const;
    for (const type of types) {
      const def = structuredClone(loadFixture('i5-test'));
      def.spec.rpm.limiter.type = type;
      const all = (1 << def.spec.combustion.length) - 1; // 0b11111
      const expected = type.endsWith('soft') ? all & 0x5555 : all; // soft: 0b10101
      const h = new CoreHarness(def);
      const ctl = makeCtl(def.spec.rpm.limiter.rpm, 1, { limiter: true });
      const masks = new Set<number>();
      const ignitionFlags = new Set<boolean>();
      h.run(1, ctl, () => {
        const c = internals(h.core).combustion;
        masks.add(c.skipMask);
        if (c.skipMask !== 0) ignitionFlags.add(c.skipIsIgnition);
      });
      expect([...masks].sort((a, b) => a - b), type).toEqual([0, expected]);
      expect([...ignitionFlags], type).toEqual([type.startsWith('ignition')]);
    }
    for (const [gearbox, ignition] of [['dct', true], ['manual', false]] as const) {
      const def = structuredClone(loadFixture('i4-test'));
      def.spec.rpm.limiter.type = 'ignition-soft'; // a shift cut ignores the soft limiter mask
      def.spec.gearbox.type = gearbox;
      const h = new CoreHarness(def);
      const ctl = makeCtl(6000, 1);
      h.run(0.2, ctl);
      ctl.shift = { active: true, up: true, fromRpm: 6000, toRpm: 4200, t0: h.tS, durationS: 0.25 };
      const masks = new Set<number>();
      const ignitionFlags = new Set<boolean>();
      h.run(0.09, ctl, () => {
        const c = internals(h.core).combustion;
        masks.add(c.skipMask);
        if (c.skipMask !== 0) ignitionFlags.add(c.skipIsIgnition);
      });
      masks.delete(0);
      expect([...masks], gearbox).toEqual([(1 << def.spec.combustion.length) - 1]);
      expect([...ignitionFlags], gearbox).toEqual([ignition]);
    }
  });

  it('feeds ignition-cut pops from CombustionSource into OverrunLayer (ignition cuts only)', () => {
    for (const [type, expectPops] of [['ignition-hard', true], ['fuel-hard', false]] as const) {
      const def = structuredClone(loadFixture('v8-crossplane-test'));
      def.spec.rpm.limiter.type = type;
      const h = new CoreHarness(def);
      const overrun = internals(h.core).overrun;
      const original = overrun.tick.bind(overrun);
      let pops = 0;
      overrun.tick = (regime, rpm, falling, valveOpen01, modeFactor, ignitionCutPops) => {
        pops += ignitionCutPops;
        original(regime, rpm, falling, valveOpen01, modeFactor, ignitionCutPops);
      };
      h.run(1, makeCtl(def.spec.rpm.limiter.rpm, 1, { limiter: true }));
      if (expectPops) expect(pops, type).toBeGreaterThan(0);
      else expect(pops, type).toBe(0);
    }
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/unit/dsp-core.test.ts`
Expected: FAIL — `Error: Cannot find module '../../src/dsp/dsp-core' imported from …/tests/unit/dsp-core.test.ts` (Test Files 1 failed, no tests).

- [ ] **Step 4: Implement `src/dsp/dsp-core.ts`**

Create `src/dsp/dsp-core.ts`:

```ts
/**
 * TesboxDspCore — the full synthesis chain behind the DspCore contract (spec §4.4, §5.3).
 *
 * Per block (≤ 128 frames): sanitise the control, update gas speeds / valve / perspective / trim.
 * Per sample: RpmState → skip mask (B5) → CombustionSource → layers → ExhaustNetwork →
 * PerspectiveMixer → (fade × ignition mix gain) → OutputStage. After each block: non-finite check
 * (full reset + 50 ms fade-in) and the deferred engine/tier/bass swap behind a 300 ms fade.
 *
 * Everything is allocated in the constructor. `configure()`, `render()` and everything they call
 * never allocate (spec §4.4; enforced by the hot-path lint rule and tools/check-alloc.ts).
 */
import {
  MAX_COMBUSTION,
  MAX_SAMPLE_RATE,
  QUANTUM,
  SPEED_OF_SOUND_COLD,
  SPEED_OF_SOUND_MAX,
  type DspControl,
  type DspCore,
  type DspStats,
  type EngineDef,
  type OutputConfig,
  type Perspective,
  type Tier,
} from '../contracts';
import { CombustionSource } from './combustion';
import { ExhaustNetwork } from './exhaust';
import { ForcedInduction } from './forced';
import { IntakeLayer } from './intake';
import { MechanicalLayer } from './mechanical';
import { OutputStage } from './output-stage';
import { OverrunLayer } from './overrun';
import { PerspectiveMixer } from './perspective';
import { RpmState } from './rpm-state';
import { clamp, smoothstep } from './util';

/** Engine / tier / bass changes while running: fade-out → apply → fade-in, each this long (s). */
export const CONFIG_FADE_S = 0.3;
/** Fade-in after the first configure and after a non-finite reset (s). */
export const RECOVERY_FADE_S = 0.05;

const GAS_TAU_S = 3;
const WARMUP_TAU_S = 120;
const HOT_HEADER_MPS = 700;
const HOT_COLLECTOR_MPS = 560;
const HOT_MUFFLER_MPS = 460;
const REGIME_SLEW_S = 0.08;
const VALVE_SLEW_S = 0.2;
const IDLE_FLOOR = 0.15;
/** Ignition on: excitation and mix ramp up over this (s). */
const IGNITION_RISE_S = 0.02;
/** Ignition off: combustion/layer excitation fades over this… */
const IGNITION_EXCITE_FALL_S = 0.3;
/** …and the whole pre-OutputStage mix (letting the exhaust ring out) over this, so the core is silent well within 2 s. */
const IGNITION_MIX_FALL_S = 1.5;
/** OverrunLayer modeFactor (contract leaves the value open): comfort 1, sport 2. */
const SPORT_CRACKLE_FACTOR = 2;
const COMFORT_VALVE_RPM = 3500;
const COMFORT_VALVE_LOAD = 0.4;
const MAX_RPM = 30000;
const TRIM_MIN_DB = -24;
const TRIM_MAX_DB = 6;
const MIN_SHIFT_S = 0.001;
/** Soft limiter (B5): entries 0, 2, 4, … are cut. */
const SOFT_CUT_BITS = 0x5555;

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Distinct, decorrelated module seeds from the core seed (golden-ratio increment). */
function deriveSeed(seed: number, k: number): number {
  return (seed ^ Math.imul(k, 0x9e3779b9)) >>> 0;
}

function copyOutput(src: OutputConfig, dst: OutputConfig, trimDb: number): void {
  dst.subwoofer = src.subwoofer;
  dst.hpCornerHz = src.hpCornerHz;
  dst.volumeTrimDb = trimDb;
}

/** Contract capacity limits (m): header 1.5, collector 1.0, mid-pipe 3.0, muffler section 0.8, tailpipe 1.2. */
const MAX_HEADER_M = 1.5;
const MAX_COLLECTOR_M = 1.0;
const MAX_MID_PIPE_M = 3.0;
const MAX_MUFFLER_SECTION_M = 0.8;
const MAX_TAILPIPE_M = 1.2;
const MAX_MUFFLER_SECTIONS = 4;

/** Throws unless minM ≤ lengthM ≤ maxM; `index` ≥ 0 names an array element. Builds a message only on failure (configure never allocates). */
function checkLength(name: string, index: number, lengthM: number, minM: number, maxM: number): void {
  if (!(lengthM >= minM && lengthM <= maxM)) {
    const where = index >= 0 ? `${name}[${index}]` : name;
    throw new RangeError(`TesboxDspCore.configure: ${where} = ${lengthM} m is outside [${minM.toFixed(4)}, ${maxM}] m`);
  }
}

/**
 * Rejects an engine the constructor-sized buffers cannot hold (phase 2a contract: capacity limits,
 * ≥ 4-sample sections at SPEED_OF_SOUND_MAX), so a bad definition throws from configure() — never
 * later from inside render() when a deferred swap is applied.
 */
export function assertEngineFits(def: EngineDef, fs: number): void {
  const n = def.spec.combustion.length;
  if (n < 1 || n > MAX_COMBUSTION) {
    throw new RangeError(`TesboxDspCore.configure: combustion.length must be 1..${MAX_COMBUSTION}, got ${n}`);
  }
  const v = def.voicing;
  if (v.headersM.length !== n) {
    throw new RangeError(`TesboxDspCore.configure: headersM has ${v.headersM.length} entries for ${n} combustion entries`);
  }
  const minM = (4 * SPEED_OF_SOUND_MAX) / fs;
  for (let i = 0; i < n; i++) checkLength('headersM', i, v.headersM[i] ?? Number.NaN, minM, MAX_HEADER_M);
  for (let i = 0; i < v.collectors.length; i++) {
    checkLength('collectors.lengthM', i, v.collectors[i]?.lengthM ?? Number.NaN, minM, MAX_COLLECTOR_M);
  }
  const ex = v.exhaust;
  checkLength('exhaust.midPipeM', -1, ex.midPipeM, minM, MAX_MID_PIPE_M);
  const sections = ex.mufflerSectionsM.length;
  if (sections < 1 || sections > MAX_MUFFLER_SECTIONS) {
    throw new RangeError(`TesboxDspCore.configure: mufflerSectionsM must have 1..${MAX_MUFFLER_SECTIONS} entries, got ${sections}`);
  }
  for (let i = 0; i < sections; i++) {
    checkLength('exhaust.mufflerSectionsM', i, ex.mufflerSectionsM[i] ?? Number.NaN, minM, MAX_MUFFLER_SECTION_M);
  }
  checkLength('exhaust.tailpipeM', -1, ex.tailpipeM, minM, MAX_TAILPIPE_M);
}

export class TesboxDspCore implements DspCore {
  /** Test hook: the last block's exhaust bus (ExhaustNetwork.outlet per sample, first `n` entries), before perspective/bass/fade. */
  readonly exhaustBus = new Float32Array(QUANTUM);

  private readonly fs: number;
  private readonly invFs: number;
  private readonly seed: number;

  private readonly rpmState: RpmState;
  private readonly combustion: CombustionSource;
  private readonly exhaust: ExhaustNetwork;
  private readonly intake: IntakeLayer;
  private readonly mechanical: MechanicalLayer;
  private readonly forced: ForcedInduction;
  private readonly overrun: OverrunLayer;
  private readonly perspective: PerspectiveMixer;
  private readonly output: OutputStage;

  private readonly exhaustIn = new Float64Array(MAX_COMBUSTION);
  private readonly intakeGate = new Float64Array(MAX_COMBUSTION);
  private readonly ctlSafe: DspControl;
  private readonly outCfg: OutputConfig;
  private readonly pendingOut: OutputConfig;
  private readonly statsObj: DspStats;

  // per-sample step sizes (constant for this fs)
  private readonly regimeStep: number;
  private readonly ignRiseStep: number;
  private readonly ignExciteFallStep: number;
  private readonly ignMixFallStep: number;
  private readonly configFadeStep: number;
  private readonly recoveryFadeStep: number;

  // applied configuration
  private def: EngineDef | null = null;
  private tier: Tier = 'full';
  private count = 0;
  private allMask = 0;
  private softMask = 0;
  private limiterSoft = false;
  private limiterIgnition = false;
  private isTurbo = false;
  private valveFitted = false;
  private fuelCutResumeRpm = 0;
  private trimDb = 0;

  // deferred swap
  private pending = false;
  private pendingDef: EngineDef | null = null;
  private pendingTier: Tier = 'full';

  // running state
  private started = false;
  private needRpmSeed = true;
  private appliedPerspective: Perspective | null = null;
  private hot = false;
  private snapGas = false;
  private gasHeader = SPEED_OF_SOUND_COLD;
  private gasCollector = SPEED_OF_SOUND_COLD;
  private gasMuffler = SPEED_OF_SOUND_COLD;
  private regime = 0;
  private valve = 0;
  private ign = 0;
  private ignMix = 0;
  private lastCombustionGain = 0;
  private fadeGain = 0;
  private fadeTarget = 0;
  private fadeInStep = 0;
  private fadeOutStep = 0;
  private nonFiniteResets = 0;

  constructor(fs: number, seed = 1) {
    if (!(fs > 0) || fs > MAX_SAMPLE_RATE) {
      throw new RangeError(`TesboxDspCore: fs must be in (0, ${MAX_SAMPLE_RATE}], got ${fs}`);
    }
    this.fs = fs;
    this.invFs = 1 / fs;
    this.seed = seed >>> 0;
    this.rpmState = new RpmState(fs);
    this.combustion = new CombustionSource(fs);
    this.exhaust = new ExhaustNetwork(fs);
    this.intake = new IntakeLayer(fs);
    this.mechanical = new MechanicalLayer(fs);
    this.forced = new ForcedInduction(fs);
    this.overrun = new OverrunLayer(fs);
    this.perspective = new PerspectiveMixer(fs);
    this.output = new OutputStage(fs);
    this.ctlSafe = {
      rpm: 0,
      load: 0,
      gear: 0,
      driveline: 'clutch-open',
      limiter: false,
      shift: { active: false, up: true, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0.1 },
      ignitionOn: false,
      runTimeS: 0,
      valve: 'auto',
      perspective: 'cabin',
      driveMode: 'comfort',
      warm: false,
    };
    this.outCfg = { subwoofer: 'unsure', hpCornerHz: 40, volumeTrimDb: 0 };
    this.pendingOut = { subwoofer: 'unsure', hpCornerHz: 40, volumeTrimDb: 0 };
    this.statsObj = { nonFiniteResets: 0, boost: 0, limiterGainReductionDb: 0, truePeakDbtp: -200 };
    this.regimeStep = 1 / (REGIME_SLEW_S * fs);
    this.ignRiseStep = 1 / (IGNITION_RISE_S * fs);
    this.ignExciteFallStep = 1 / (IGNITION_EXCITE_FALL_S * fs);
    this.ignMixFallStep = 1 / (IGNITION_MIX_FALL_S * fs);
    this.configFadeStep = 1 / (CONFIG_FADE_S * fs);
    this.recoveryFadeStep = 1 / (RECOVERY_FADE_S * fs);
  }

  /**
   * Reading `stats` refreshes the shared object in place. `truePeakDbtp` is read-and-reset (the max
   * since the previous read of `stats`), so read `stats` once per snapshot and copy the fields you need.
   */
  get stats(): DspStats {
    const s = this.statsObj;
    s.nonFiniteResets = this.nonFiniteResets;
    s.boost = this.forced.boost;
    s.limiterGainReductionDb = this.output.gainReductionDb;
    s.truePeakDbtp = this.output.takeTruePeak();
    return s;
  }

  /** Test hook: jump the gas speeds to their hot steady state for the current load and keep the engine fully warm. */
  forceHot(): void {
    this.hot = true;
    this.snapGas = true;
  }

  configure(def: EngineDef, output: OutputConfig, tier: Tier): void {
    assertEngineFits(def, this.fs);
    this.trimDb = clamp(finiteOr(output.volumeTrimDb, 0), TRIM_MIN_DB, TRIM_MAX_DB);
    if (this.def === null || !this.started) {
      // Nothing audible yet: apply immediately, then a short fade-in.
      copyOutput(output, this.outCfg, this.trimDb);
      this.pending = false;
      this.pendingDef = null;
      this.applyConfig(def, tier);
      this.fadeGain = 0;
      this.fadeTarget = 1;
      this.fadeInStep = this.recoveryFadeStep;
      return;
    }
    this.outCfg.volumeTrimDb = this.trimDb;
    this.pendingOut.volumeTrimDb = this.trimDb;
    const sameAsApplied =
      def === this.def &&
      tier === this.tier &&
      output.subwoofer === this.outCfg.subwoofer &&
      output.hpCornerHz === this.outCfg.hpCornerHz;
    if (sameAsApplied) {
      // Trim-only change (OutputStage ramps it per quantum) or a cancelled swap: no fade needed.
      if (this.pending) {
        this.pending = false;
        this.pendingDef = null;
        this.fadeTarget = 1;
        this.fadeInStep = this.configFadeStep;
      }
      return;
    }
    this.pendingDef = def;
    this.pendingTier = tier;
    copyOutput(output, this.pendingOut, this.trimDb);
    this.pending = true;
    this.fadeTarget = 0;
    this.fadeOutStep = this.configFadeStep;
  }

  render(ctl: DspControl, outL: Float32Array, outR: Float32Array, frames: number, nowS: number): void {
    let total = frames | 0;
    if (total > outL.length) total = outL.length;
    if (total > outR.length) total = outR.length;
    if (total <= 0) return;
    if (this.def === null) {
      for (let i = 0; i < total; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      return;
    }
    this.started = true;
    let off = 0;
    while (off < total) {
      const n = total - off > QUANTUM ? QUANTUM : total - off;
      this.step(ctl, outL, outR, off, n, nowS + off * this.invFs);
      off += n;
    }
  }

  /** One block of n ≤ QUANTUM frames written at outL/outR[off…]; t0 = time of its first frame. */
  private step(ctl: DspControl, outL: Float32Array, outR: Float32Array, off: number, n: number, t0: number): void {
    this.readControl(ctl);
    const c = this.ctlSafe;
    if (this.needRpmSeed) {
      this.rpmState.reset(c.rpm);
      this.needRpmSeed = false;
    }

    // ── per-quantum control (contract "DspCore per-quantum control") ──
    const load = c.load;
    const throttle = load > 0 ? load : 0;
    const eligible = c.ignitionOn && c.rpm > this.fuelCutResumeRpm && c.driveline === 'engaged';
    const regimeTarget = eligible ? 1 - smoothstep(-0.08, 0.02, load) : 0;
    const floor = eligible ? 0 : IDLE_FLOOR;

    const warmup = this.hot || c.warm ? 1 : 1 - Math.exp(-c.runTimeS / WARMUP_TAU_S);
    const heat = warmup * (0.6 + 0.4 * throttle);
    const tHeader = SPEED_OF_SOUND_COLD + (HOT_HEADER_MPS - SPEED_OF_SOUND_COLD) * heat;
    const tCollector = SPEED_OF_SOUND_COLD + (HOT_COLLECTOR_MPS - SPEED_OF_SOUND_COLD) * heat;
    const tMuffler = SPEED_OF_SOUND_COLD + (HOT_MUFFLER_MPS - SPEED_OF_SOUND_COLD) * heat;
    if (this.snapGas) {
      this.gasHeader = tHeader;
      this.gasCollector = tCollector;
      this.gasMuffler = tMuffler;
      this.snapGas = false;
    } else {
      const k = 1 - Math.exp(-n / (GAS_TAU_S * this.fs));
      this.gasHeader += (tHeader - this.gasHeader) * k;
      this.gasCollector += (tCollector - this.gasCollector) * k;
      this.gasMuffler += (tMuffler - this.gasMuffler) * k;
    }
    this.exhaust.setGasSpeeds(this.gasHeader, this.gasCollector, this.gasMuffler);

    let valveTarget = 0;
    if (this.valveFitted) {
      if (c.valve === 'open') valveTarget = 1;
      else if (c.valve === 'auto') {
        if (c.driveMode === 'sport') valveTarget = 1;
        else if (c.rpm > COMFORT_VALVE_RPM && load > COMFORT_VALVE_LOAD) valveTarget = 1;
      }
    }
    const valveStep = n / (VALVE_SLEW_S * this.fs);
    if (this.valve < valveTarget) this.valve = Math.min(valveTarget, this.valve + valveStep);
    else if (this.valve > valveTarget) this.valve = Math.max(valveTarget, this.valve - valveStep);
    this.exhaust.setValve(this.valve);
    if (this.isTurbo) this.exhaust.setTurbineAttenuation(Math.sqrt(clamp(this.forced.boost, 0, 1))); // shaft = √boost

    if (this.appliedPerspective !== c.perspective) {
      this.perspective.setPerspective(c.perspective);
      this.appliedPerspective = c.perspective;
    }
    this.output.beginQuantum(this.trimDb, n);

    const modeFactor = c.driveMode === 'sport' ? SPORT_CRACKLE_FACTOR : 1;
    const ignOn = c.ignitionOn;
    // B5: a cut while ctl.limiter is set (and no shift is active) is a limiter cut; otherwise a shift cut.
    const limiterCut = c.limiter && !c.shift.active;
    const cutMask = limiterCut && this.limiterSoft ? this.softMask : this.allMask;
    const count = this.count;
    const valve = this.valve;
    const bus = this.exhaustBus;
    let ign = this.ign;
    let ignMix = this.ignMix;
    let regime = this.regime;
    let fade = this.fadeGain;
    let acc = 0;

    // ── per-sample chain ──
    for (let i = 0; i < n; i++) {
      if (ignOn) {
        ign = ign + this.ignRiseStep > 1 ? 1 : ign + this.ignRiseStep;
        ignMix = ignMix + this.ignRiseStep > 1 ? 1 : ignMix + this.ignRiseStep;
      } else {
        ign = ign - this.ignExciteFallStep < 0 ? 0 : ign - this.ignExciteFallStep;
        ignMix = ignMix - this.ignMixFallStep < 0 ? 0 : ignMix - this.ignMixFallStep;
      }
      if (regime < regimeTarget) {
        regime += this.regimeStep;
        if (regime > regimeTarget) regime = regimeTarget;
      } else if (regime > regimeTarget) {
        regime -= this.regimeStep;
        if (regime < regimeTarget) regime = regimeTarget;
      }
      if (fade < this.fadeTarget) {
        fade += this.fadeInStep;
        if (fade > 1) fade = 1;
      } else if (fade > this.fadeTarget) {
        fade -= this.fadeOutStep;
        if (fade < 0) fade = 0;
      }

      this.rpmState.tick(c, t0 + i * this.invFs);
      const rpm = this.rpmState.rpm;
      if (this.rpmState.cut) {
        this.combustion.skipMask = cutMask;
        this.combustion.skipIsIgnition = limiterCut ? this.limiterIgnition : this.rpmState.cutIsIgnition;
      } else {
        this.combustion.skipMask = 0;
        this.combustion.skipIsIgnition = false;
      }

      let gain = 1 - regime;
      if (gain < floor) gain = floor;
      gain *= ign;
      this.lastCombustionGain = gain;
      const ignition = this.combustion.tick(rpm, load, gain, this.exhaustIn, this.intakeGate);
      const pops = this.combustion.takeIgnitionCutPops();

      let gateSum = 0;
      for (let k = 0; k < count; k++) gateSum += this.intakeGate[k] ?? 0;
      const intake = this.intake.tick(gateSum, throttle * ign);
      const block = this.mechanical.tick(ignition, rpm) * ign;
      const fi = this.forced.tick(rpm, load * ign) * ign;
      this.overrun.tick(regime, rpm, this.rpmState.falling, valve, modeFactor, pops);
      const pop = this.overrun.popInject * ign;
      const air = this.overrun.airflow * ign;

      this.exhaust.tick(this.exhaustIn, pop);
      const ex = this.exhaust.outlet;
      bus[i] = ex;

      this.perspective.tick(ex, intake, block, fi, air);
      const g = fade * ignMix;
      const pl = this.perspective.l;
      const pr = this.perspective.r;
      this.output.process(pl * g, pr * g);
      outL[off + i] = this.output.l;
      outR[off + i] = this.output.r;
      acc += ignition + intake + block + fi + pop + air + pl + pr;
    }

    this.ign = ign;
    this.ignMix = ignMix;
    this.regime = regime;
    this.fadeGain = fade;

    // ── once per quantum: non-finite guard, then the deferred swap ──
    if (!Number.isFinite(this.exhaust.energy() + acc + this.rpmState.rpm)) {
      this.recover();
    } else if (this.pending && fade === 0 && this.pendingDef !== null) {
      copyOutput(this.pendingOut, this.outCfg, this.pendingOut.volumeTrimDb);
      this.applyConfig(this.pendingDef, this.pendingTier);
      this.pending = false;
      this.pendingDef = null;
      this.fadeTarget = 1;
      this.fadeInStep = this.configFadeStep;
    }
  }

  /** Copies + sanitises the caller's control into ctlSafe (finite, clamped; never aliases caller objects). */
  private readControl(ctl: DspControl): void {
    const c = this.ctlSafe;
    c.rpm = clamp(finiteOr(ctl.rpm, 0), 0, MAX_RPM);
    c.load = clamp(finiteOr(ctl.load, 0), -1, 1);
    c.gear = finiteOr(ctl.gear, 0);
    c.driveline = ctl.driveline;
    c.limiter = ctl.limiter === true;
    c.ignitionOn = ctl.ignitionOn === true;
    c.runTimeS = Math.max(0, finiteOr(ctl.runTimeS, 0));
    c.valve = ctl.valve;
    c.perspective = ctl.perspective;
    c.driveMode = ctl.driveMode;
    c.warm = ctl.warm === true;
    const s = ctl.shift;
    const d = c.shift;
    d.active = s.active === true;
    d.up = s.up === true;
    d.fromRpm = clamp(finiteOr(s.fromRpm, c.rpm), 0, MAX_RPM);
    d.toRpm = clamp(finiteOr(s.toRpm, c.rpm), 0, MAX_RPM);
    d.t0 = finiteOr(s.t0, 0);
    d.durationS = Math.max(MIN_SHIFT_S, finiteOr(s.durationS, MIN_SHIFT_S));
  }

  private applyConfig(def: EngineDef, tier: Tier): void {
    const spec = def.spec;
    const voicing = def.voicing;
    this.exhaust.configure(def, tier); // first: the module most likely to reject a definition
    this.rpmState.configure(spec);
    this.combustion.configure(spec, voicing, deriveSeed(this.seed, 1));
    this.intake.configure(voicing, deriveSeed(this.seed, 2));
    this.mechanical.configure(spec, voicing, deriveSeed(this.seed, 3));
    this.forced.configure(spec, voicing, deriveSeed(this.seed, 4));
    this.overrun.configure(spec, voicing, deriveSeed(this.seed, 5));
    this.perspective.configure(voicing);
    this.output.configure(this.outCfg);
    this.def = def;
    this.tier = tier;
    this.count = spec.combustion.length;
    this.resetModules();
    this.allMask = (1 << this.count) - 1;
    this.softMask = this.allMask & SOFT_CUT_BITS;
    const lt = spec.rpm.limiter.type;
    this.limiterSoft = lt === 'ignition-soft' || lt === 'fuel-soft';
    this.limiterIgnition = lt === 'ignition-soft' || lt === 'ignition-hard';
    this.isTurbo = spec.aspiration.type === 'turbo';
    this.valveFitted = voicing.exhaust.valve.fitted;
    this.fuelCutResumeRpm = voicing.overrun.fuelCutResumeRpm;
  }

  private resetModules(): void {
    this.combustion.reset();
    this.exhaust.reset();
    this.intake.reset();
    this.mechanical.reset();
    this.forced.reset();
    this.overrun.reset();
    this.perspective.reset();
    this.output.reset();
    this.regime = 0;
    this.appliedPerspective = null;
    this.needRpmSeed = true;
    this.snapGas = true; // start at the thermal state the control implies (warm start → warm gas)
  }

  /** Non-finite state: full reset (applying a queued swap if any), then a 50 ms fade-in. */
  private recover(): void {
    this.nonFiniteResets++;
    if (this.pending && this.pendingDef !== null) {
      copyOutput(this.pendingOut, this.outCfg, this.pendingOut.volumeTrimDb);
      this.applyConfig(this.pendingDef, this.pendingTier);
      this.pending = false;
      this.pendingDef = null;
    } else {
      this.resetModules();
    }
    this.fadeGain = 0;
    this.fadeTarget = 1;
    this.fadeInStep = this.recoveryFadeStep;
  }
}
```

Why it is shaped this way:
- `render` and the private per-block `step` are hot-path names, so T10's lint rule checks them: no allocation syntax, and everything they call (`readControl`, `applyConfig`, `resetModules`, `recover`) only assigns fields. All per-sample state lives in fields or locals; the swap and the non-finite reset run once per block, after the sample loop.
- The fade gain multiplies the PerspectiveMixer output *before* `OutputStage.process`, so nothing follows the limiter (spec §5.3.12). A queued swap is applied at the end of the block in which the fade reached exactly 0; the OutputStage is reconfigured while its input is silent.
- `readControl` copies the caller's control into a preallocated object (finite, clamped), so NaN/Infinity from the caller can never reach module state, and a mutated caller object can never alias module state. Non-finite *module* state is caught once per block from `exhaust.energy()` plus a running sum of every layer output.
- `assertEngineFits` makes a bad engine throw from `configure()` in the caller's context; without it, a queued swap would throw from inside `render()` on the audio thread. `applyConfig` configures the exhaust first and records `def` last.

- [ ] **Step 5: Run the core test and confirm it passes**

Run: `npx vitest run tests/unit/dsp-core.test.ts`
Expected: PASS (17 tests, ≈ 5 s). If RF2 fails only at the `< −90 dBFS` assertions, check the T7 premise (OutputStage decays to < −90 dBFS within 0.45 s of silent input, virtual bass included); if the B5 test fails, check the T4/T5 premises on `skipIsIgnition` and `cut`.

- [ ] **Step 6: Write the invariant suite**

Create `tests/unit/dsp-invariants.test.ts`. Order energies come from `orderSpectrum` (index `i` ↔ order `(i + 1)·step`, step ½ for 4-stroke and ⅓ for rotary). "Sub-orders" are the grid orders that are neither integers nor multiples of the firing order (½-orders for 4-stroke; ⅓ and ⅔ orders for rotary); their energies are summed and compared with the single firing-order line. Invariant 7 drives `ExhaustNetwork` directly ("combustion disabled") over both tiers. Invariant 8 also switches engine, tier and bass mode every 1250 quanta through `configure()`, so the fade paths are fuzzed too.

```ts
/**
 * DSP invariants (phase 2a contract §"DSP invariant tests", spec §14). Unless a test states otherwise:
 * measured on TesboxDspCore.exhaustBus, seed 1, forceHot(), load 0.5, app-default control (valve auto,
 * comfort, cabin), steady rpm 2000/4000/6000 (≤ redline − 500), 1.5 s renders, first 0.5 s discarded.
 */
import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION, QUANTUM, type DspControl, type EngineDef, type OutputConfig, type Tier } from '../../src/contracts';
import { bandEnergyDb, dominantOrders, fft, hann, orderSpectrum, truePeakDbtp } from '../../src/dsp/analysis';
import { TesboxDspCore } from '../../src/dsp/dsp-core';
import { ExhaustNetwork } from '../../src/dsp/exhaust';
import { ForcedInduction } from '../../src/dsp/forced';
import { Rng } from '../../src/dsp/util';
import {
  CoreHarness,
  FIXTURE_IDS,
  FS,
  OUT_SUB,
  allFinite,
  bitIdentical,
  internals,
  loadFixture,
  makeCtl,
  slice,
} from './helpers/dsp-harness';

const MAX_ORDER = 12;
const RPMS = [2000, 4000, 6000] as const;
const UNEVEN = new Set<string>(['i5-test', 'v8-crossplane-test', 'v8-sc-test', 'flat4-uel-test', 'rotary-test']);
const EVEN = new Set<string>(['i4-test', 'i6-test', 'v8-flatplane-test']);
const HOT = { header: 700, collector: 560, muffler: 460 } as const;
const COLD = 343;

const defs = new Map<string, EngineDef>(FIXTURE_IDS.map((id) => [id, loadFixture(id)]));
function def(id: string): EngineDef {
  const d = defs.get(id);
  if (d === undefined) throw new Error(`unknown fixture ${id}`);
  return d;
}

/** Firing crank order: combustion.length × 360 / cycleDeg (I4 2, I5 2.5, I6 3, V8 4, rotary 2). */
function firingOrder(d: EngineDef): number {
  return (d.spec.combustion.length * 360) / d.spec.cycleDeg;
}
/** Cycle sub-order grid: ½ for 4-stroke, ⅓ for rotary. */
function orderStep(d: EngineDef): number {
  return 360 / d.spec.cycleDeg;
}
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
function rpmsFor(d: EngineDef): number[] {
  return RPMS.filter((r) => r <= d.spec.rpm.redline - 500);
}

/** Exhaust bus of a steady hot render at (rpm, load 0.5): 1.5 s, first 0.5 s discarded. Memoised. */
const steadyCache = new Map<string, Float32Array>();
function steadyExhaust(id: string, rpm: number): Float32Array {
  const key = `${id}@${rpm}`;
  const hit = steadyCache.get(key);
  if (hit) return hit;
  const out = new CoreHarness(def(id)).run(1.5, makeCtl(rpm, 0.5));
  const sig = slice(out.exhaust, 0.5, 1.5);
  steadyCache.set(key, sig);
  return sig;
}

/**
 * Sub-order energy re the firing order, in dB. Sub-orders = the cycle-grid orders k·step ≤ MAX_ORDER
 * that are neither integers nor multiples of the firing order (½ orders for 4-stroke, ⅓ and ⅔ orders
 * for rotary); their energies are summed and compared with the single firing-order line.
 */
function subOrderRatioDb(d: EngineDef, rpm: number): number {
  const step = orderStep(d);
  const fire = firingOrder(d);
  const spec = orderSpectrum(steadyExhaust(d.id, rpm), FS, rpm, MAX_ORDER, step);
  let sub = 0;
  let fireE = 0;
  for (let i = 0; i < spec.length; i++) {
    const order = (i + 1) * step;
    const e = spec[i] ?? 0;
    if (near(order, fire)) fireE = e;
    const isInteger = near(order, Math.round(order));
    const isFiringHarmonic = near(order / fire, Math.round(order / fire));
    if (!isInteger && !isFiringHarmonic) sub += e;
  }
  return 10 * Math.log10((sub + 1e-300) / (fireE + 1e-300));
}

/** Power spectrum (Hann, zero-padded to twice the next power of two) → bin spacing and |X_k|². */
function powerSpectrum(sig: Float32Array): { df: number; p: Float64Array } {
  let n = 1;
  while (n < sig.length) n <<= 1;
  n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(sig.length);
  for (let i = 0; i < sig.length; i++) re[i] = (sig[i] ?? 0) * (w[i] ?? 0);
  fft(re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k < p.length; k++) p[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
  return { df: FS / n, p };
}

describe('DSP invariants', () => {
  it('1. the firing order is among the top 3 orders at 2k/4k/6k rpm', { timeout: 120_000 }, () => {
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      for (const rpm of rpmsFor(d)) {
        const spec = orderSpectrum(steadyExhaust(id, rpm), FS, rpm, MAX_ORDER, orderStep(d));
        const top = dominantOrders(spec, orderStep(d), 3);
        expect(top.some((o) => near(o, firingOrder(d))), `${id} @ ${rpm}: top orders ${top.join(', ')}`).toBe(true);
      }
    }
  });

  it('2. sub-orders: uneven-fire/rotary ≥ firing − 30 dB; even-fire ≤ firing − 20 dB', { timeout: 120_000 }, () => {
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      expect(UNEVEN.has(id) !== EVEN.has(id), `${id} is classified exactly once`).toBe(true);
      for (const rpm of rpmsFor(d)) {
        const db = subOrderRatioDb(d, rpm);
        if (UNEVEN.has(id)) expect(db, `${id} @ ${rpm}`).toBeGreaterThanOrEqual(-30);
        else expect(db, `${id} @ ${rpm}`).toBeLessThanOrEqual(-20);
      }
    }
  });

  it('3. rotary: e-shaft order 2 is dominant', { timeout: 60_000 }, () => {
    const d = def('rotary-test');
    for (const rpm of rpmsFor(d)) {
      const spec = orderSpectrum(steadyExhaust('rotary-test', rpm), FS, rpm, MAX_ORDER, orderStep(d));
      expect(dominantOrders(spec, orderStep(d), 1)[0], `rotary @ ${rpm}`).toBeCloseTo(2, 6);
    }
  });

  it('4. supercharger: spectral peak within 0.5 % of whineHz(rpm) in a cabin render (full output)', { timeout: 60_000 }, () => {
    const d = def('v8-sc-test');
    const fi = new ForcedInduction(FS);
    fi.configure(d.spec, d.voicing, 1);
    const rpms = rpmsFor(d);
    expect(rpms.length).toBeGreaterThan(0);
    for (const rpm of rpms) {
      const f = fi.whineHz(rpm);
      expect(f).toBeGreaterThan(0);
      const out = new CoreHarness(d).run(1.5, makeCtl(rpm, 0.5, { perspective: 'cabin' }));
      const { df, p } = powerSpectrum(slice(out.left, 0.5, 1.5));
      const lo = Math.floor((0.97 * f) / df);
      const hi = Math.ceil((1.03 * f) / df);
      let best = lo;
      for (let k = lo; k <= hi; k++) if ((p[k] ?? 0) > (p[best] ?? 0)) best = k;
      expect(Math.abs(best * df - f) / f, `whine @ ${rpm}: peak ${(best * df).toFixed(1)} Hz vs ${f} Hz`).toBeLessThanOrEqual(0.005);
      const band = Array.from(p.subarray(lo, hi + 1)).sort((a, b) => a - b);
      const median = band[Math.floor(band.length / 2)] ?? 0;
      expect(10 * Math.log10((p[best] ?? 0) / (median + 1e-300)), `whine prominence @ ${rpm}`).toBeGreaterThan(10);
    }
  });

  it('5. turbo whistle detectable in cabin renders at load 1, 0.7·redline', { timeout: 120_000 }, () => {
    const turbo = FIXTURE_IDS.filter((id) => def(id).spec.aspiration.type === 'turbo');
    expect(turbo.length).toBeGreaterThan(0);
    for (const id of turbo) {
      const d = def(id);
      const ctl = makeCtl(0.7 * d.spec.rpm.redline, 1, { perspective: 'cabin' });
      const sig = slice(new CoreHarness(d).run(4, ctl).left, 3, 4); // 3 s spool-up, analyse the last 1 s
      const inBand = bandEnergyDb(sig, FS, 1000, 4000);
      expect(inBand - bandEnergyDb(sig, FS, 0, FS / 2), `${id}: 1–4 kHz re total`).toBeGreaterThanOrEqual(-45);
      // Discrimination: muting the forced-induction bus in the cabin must remove energy from the band.
      const muted = structuredClone(d);
      if (muted.voicing.forcedInduction) muted.voicing.forcedInduction.cabinGainDb = -200;
      const ref = slice(new CoreHarness(muted).run(4, ctl).left, 3, 4);
      expect(inBand - bandEnergyDb(ref, FS, 1000, 4000), `${id}: whistle contribution`).toBeGreaterThan(3);
    }
  });

  it('6. limiter held 2 s → 8–20 cut→fire transitions/s, no cut > 100 ms, cuts reach the combustion source', { timeout: 120_000 }, () => {
    const BLOCK = 16; // render in 16-frame blocks: rpmState.cut sampled every 0.33 ms
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      const core = new TesboxDspCore(FS, 1);
      core.configure(d, OUT_SUB, 'full');
      core.forceHot();
      const ctl = makeCtl(d.spec.rpm.limiter.rpm, 1);
      let b = 0;
      const settle = Math.round((0.3 * FS) / BLOCK);
      for (; b < settle; b++) core.render(ctl, l, r, BLOCK, (b * BLOCK) / FS);
      ctl.limiter = true;
      const hold = Math.round((2 * FS) / BLOCK);
      let transitions = 0;
      let run = 0;
      let longest = 0;
      let prevCut = false;
      let cutBlocks = 0;
      let cutsWithoutMask = 0;
      for (let k = 0; k < hold; k++, b++) {
        core.render(ctl, l, r, BLOCK, (b * BLOCK) / FS);
        const inner = internals(core);
        const cut = inner.rpmState.cut;
        if (cut) {
          cutBlocks++;
          if (inner.combustion.skipMask === 0) cutsWithoutMask++;
        }
        if (prevCut && !cut) transitions++;
        run = cut ? run + 1 : 0;
        longest = Math.max(longest, run);
        prevCut = cut;
      }
      const perSecond = transitions / 2;
      expect(perSecond, `${id}: cut→fire transitions/s`).toBeGreaterThanOrEqual(8);
      expect(perSecond, `${id}: cut→fire transitions/s`).toBeLessThanOrEqual(20);
      expect((longest * BLOCK) / FS, `${id}: longest cut (s)`).toBeLessThanOrEqual(0.1);
      expect(cutBlocks, `${id}: cut phases seen`).toBeGreaterThan(0);
      expect(cutsWithoutMask, `${id}: cut samples with skipMask 0`).toBe(0);
    }
  });

  it('7. passivity: header impulses decay monotonically (50 ms windows) to ≤ −120 dB within 2 s', { timeout: 120_000 }, () => {
    const win = Math.round(0.05 * FS);
    const every = Math.round(0.001 * FS);
    const hin = new Float64Array(MAX_COMBUSTION);
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      const net = new ExhaustNetwork(FS);
      for (const tier of ['full', 'lite'] as Tier[]) {
        for (const valve of [0, 1]) {
          for (const hot of [false, true]) {
            const label = `${id} ${tier} valve=${valve} ${hot ? 'hot' : 'cold'}`;
            net.configure(d, tier);
            net.reset();
            if (hot) net.setGasSpeeds(HOT.header, HOT.collector, HOT.muffler);
            else net.setGasSpeeds(COLD, COLD, COLD);
            net.setValve(valve);
            net.setTurbineAttenuation(hot ? 1 : 0);
            hin.fill(0);
            for (let i = 0; i < d.spec.combustion.length; i++) hin[i] = 1;
            net.tick(hin, 0);
            hin.fill(0);
            const e0 = net.energy();
            expect(e0, label).toBeGreaterThan(0);
            let prevMean = Number.POSITIVE_INFINITY;
            for (let w = 0; w < 40; w++) {
              let sum = 0;
              let cnt = 0;
              for (let s = 0; s < win; s++) {
                net.tick(hin, 0);
                if (s % every === every - 1) {
                  sum += net.energy();
                  cnt++;
                }
              }
              const mean = sum / cnt;
              expect(Number.isFinite(mean), label).toBe(true);
              expect(mean, `${label}: window ${w}`).toBeLessThanOrEqual(prevMean * (1 + 1e-12));
              prevMean = mean;
            }
            expect(10 * Math.log10(net.energy() / e0 + 1e-300), label).toBeLessThanOrEqual(-120);
          }
        }
      }
    }
  });

  it('8. fuzz: 10 000 random quanta → finite output, true peak ≤ −1.0 dBTP', { timeout: 300_000 }, () => {
    const rng = new Rng(2024);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)] as T;
    const core = new TesboxDspCore(FS, 3);
    const out: OutputConfig = { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 };
    let engine = def(FIXTURE_IDS[0]);
    let tier: Tier = 'full';
    core.configure(engine, out, tier);
    const ctl: DspControl = makeCtl(3000, 0.5);
    const total = 10_000;
    const left = new Float32Array(total * QUANTUM);
    const right = new Float32Array(total * QUANTUM);
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    for (let q = 0; q < total; q++) {
      const t = (q * QUANTUM) / FS;
      if (q % 1250 === 0 && q > 0) {
        engine = def(FIXTURE_IDS[(q / 1250) % FIXTURE_IDS.length] ?? FIXTURE_IDS[0]);
        tier = rng.next() < 0.5 ? 'full' : 'lite';
        out.subwoofer = pick(['yes', 'no', 'unsure'] as const);
        out.hpCornerHz = 30 + 30 * rng.next();
        core.configure(engine, out, tier);
      }
      if (rng.next() < 0.1) {
        ctl.rpm = rng.next() * 12000;
        ctl.load = rng.bipolar();
        ctl.limiter = rng.next() < 0.15;
        ctl.valve = pick(['auto', 'open', 'closed'] as const);
        ctl.perspective = pick(['cabin', 'outside'] as const);
        ctl.driveMode = pick(['comfort', 'sport'] as const);
        ctl.driveline = pick(['engaged', 'engaged', 'clutch-open', 'tc-stall', 'slipping'] as const);
        ctl.ignitionOn = rng.next() < 0.97;
        ctl.warm = rng.next() < 0.5;
        ctl.runTimeS = rng.next() * 600;
        if (rng.next() < 0.2) {
          out.volumeTrimDb = -24 + 30 * rng.next(); // trim −24 … +6 dB (trim-only configure: no fade)
          core.configure(engine, out, tier);
        }
      }
      if (!ctl.shift.active && rng.next() < 0.01) {
        ctl.shift = {
          active: true,
          up: rng.next() < 0.5,
          fromRpm: rng.next() * 12000,
          toRpm: rng.next() * 12000,
          t0: t,
          durationS: 0.05 + 0.55 * rng.next(),
        };
      } else if (ctl.shift.active && t > ctl.shift.t0 + ctl.shift.durationS) {
        ctl.shift = { ...ctl.shift, active: false };
      }
      core.render(ctl, l, r, QUANTUM, t);
      left.set(l, q * QUANTUM);
      right.set(r, q * QUANTUM);
    }
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(core.stats.nonFiniteResets).toBe(0);
    expect(truePeakDbtp(left)).toBeLessThanOrEqual(-1.0);
    expect(truePeakDbtp(right)).toBeLessThanOrEqual(-1.0);
  });

  it('9. at 9000 rpm, exhaust-bus energy above 16 kHz ≤ −60 dB re total', { timeout: 60_000 }, () => {
    const d = structuredClone(def('v8-flatplane-test'));
    d.spec.rpm.redline = 9500;
    d.spec.rpm.limiter.rpm = Math.max(d.spec.rpm.limiter.rpm, 9800);
    const sig = slice(new CoreHarness(d).run(1.5, makeCtl(9000, 0.5)).exhaust, 0.5, 1.5);
    expect(bandEnergyDb(sig, FS, 16000, FS / 2) - bandEnergyDb(sig, FS, 0, FS / 2)).toBeLessThanOrEqual(-60);
  });

  it('10. determinism: same seed → bit-identical output; different seed → different output', { timeout: 60_000 }, () => {
    const d = def('i5-test');
    const run = (seed: number): { l: Float32Array; r: Float32Array; e: Float32Array } => {
      const h = new CoreHarness(d, { seed });
      const ctl = makeCtl(2500, 0.4, { perspective: 'outside' });
      const a = h.run(0.5, ctl, (t) => {
        ctl.rpm = 2500 + 4000 * t;
        ctl.load = Math.sin(6 * t);
      });
      ctl.shift = { active: true, up: true, fromRpm: 4500, toRpm: 3200, t0: h.tS, durationS: 0.1 };
      const b = h.run(0.5, ctl);
      const l = new Float32Array(a.left.length + b.left.length);
      l.set(a.left);
      l.set(b.left, a.left.length);
      return { l, r: b.right, e: b.exhaust };
    };
    const x = run(11);
    const y = run(11);
    const z = run(12);
    expect(bitIdentical(x.l, y.l) && bitIdentical(x.r, y.r) && bitIdentical(x.e, y.e)).toBe(true);
    expect(bitIdentical(x.l, z.l)).toBe(false);
  });
});
```

- [ ] **Step 7: Run the invariant suite**

Run: `npx vitest run tests/unit/dsp-invariants.test.ts`
Expected: PASS (10 tests, ≈ 25 s). These are acceptance tests for T1–T9 together; they encode the contract and must not be weakened. A failure points to its owner:
- 1–3 (orders): fixture voicing (T1: lengths, pulse width), network resonances (T3), pulse shaping and per-face/per-cycle variation (T4). Planning measurements (exhaust bus, load 0.5, valve auto) failed only these cases. With an earlier T1–T7 draft: `flat4-uel-test` @ 6000 rpm (order 2 ranked 4th; half orders +5.6 dB re order 2) and `rotary-test` @ 2000 rpm (⅓/⅔ orders −37.9 dB re order 2, per-cycle jitter only). With the current T1–T5 drafts (`ROTARY_FACE_DEPTH` 0.1) plus the earlier T6/T7: `i6-test` @ 4000 rpm (top orders 6, 12, 9; half orders −17.4 dB), `flat4-uel-test` @ 6000 rpm (top orders 4, 3.5, 2.5; half orders +21.8 dB) and `rotary-test` @ 4000/6000 rpm (⅓ order dominant, +0.6/+8.9 dB re order 2). Tune the owning voicing/module until all three pass; never loosen the thresholds here.
- 4/5: T6 (whine order, whistle frequency/level) and T7 (cabin FI bus).
- 6: T5 (limiter bounce) and the B5 skip-mask wiring above.
- 7: T3 passivity. 8: whichever module produced the NaN (`nonFiniteResets` > 0) or T7's limiter. 9: T4 pulse bandwidth / T3 outlet. 10: a module that draws randomness outside its seeded `Rng`.

- [ ] **Step 8: Run every DSP test together**

Run: `npx vitest run tests/unit/dsp-*.test.ts`
Expected: PASS for every `dsp-*.test.ts` file of T1–T9 (no regressions from importing the modules together).

- [ ] **Step 9: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

---

### Task 10: Hot-path lint rule, render segments + `tesbox-render`, allocation gate, benchmark, clean-room log, phase verification

**Files:**
- Modify: `eslint.config.js` (append the hot-path block)
- Create: `tools/segments.ts`
- Create: `tools/render.ts`
- Create: `tools/check-alloc.ts`
- Create: `tools/bench-dsp.ts`
- Modify: `package.json` (scripts `render`, `check:alloc`, `bench:dsp`)
- Modify: `.gitignore` (add `renders/`)
- Modify: `docs/CLEAN_ROOM.md` (append the Phase 2a source log)
- Test: `tests/unit/eslint-hot-path.test.ts`
- Test: `tests/unit/segments.test.ts`
- Test: `tests/unit/render.test.ts`
- Test: `tests/unit/check-alloc.test.ts`
- Test: `tests/unit/bench-dsp.test.ts`
- Test: `tests/unit/clean-room.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `QUANTUM`, `MAX_SAMPLE_RATE`; types `DspControl`, `EngineDef`, `EngineSpec`, `Perspective`, `Tier`.
  - T8: `rmsDb(signal): number`, `truePeakDbtp(signal): number` (`src/dsp/analysis.ts`); `writeWav(path, channels: Float32Array[], fs): void`, `readWav(path): { fs; channels }` (`tools/wav.ts`).
  - T9: `new TesboxDspCore(fs, seed?)`, `configure(def, output, tier)`, `render(ctl, outL, outR, frames, nowS)`, `forceHot()`, `stats.nonFiniteResets`; harness `tests/unit/helpers/dsp-harness.ts`: `FIXTURE_IDS`, `loadFixture(id): EngineDef`, `makeCtl(rpm, load, over?): DspControl`, `allFinite(sig): boolean`.
- Produces:
  - `eslint.config.js`: a block for `src/dsp/**/*.ts` and `src/sim/**/*.ts` with `no-restricted-syntax` selector (amendment B1) `MethodDefinition[key.name=/^(tick|process|render|scatter|write|read[A-Za-z]*|step|push|accept|evaluate|update|next|request|input|out[A-Za-z]*)$/] > FunctionExpression > BlockStatement :matches(NewExpression, ArrayExpression, ObjectExpression, ArrowFunctionExpression, FunctionExpression, SpreadElement, TemplateLiteral, TryStatement, ThrowStatement)`, message `Hot path must not allocate (spec §4.4)`.
  - `tools/segments.ts`: `export interface Segment { name: string; durationS: number; ctl(t: number, base: DspControl): void }`; `export const SEGMENTS: Segment[]` = idle 5 s, cruise2k / cruise4k / cruise6k 4 s each (load 0.3, rpm capped at redline − 500), wotPull 12 s (idle → limiter at load 1, gears 1–min(4, gears), upshift ShiftState at every redline crossing, limiter held after ≈ 9 s), liftoff6k 6 s (0.5 s at load 0.3, then load −0.6 while rpm falls to idle + 200 by 5 s, then clutch open), limiterHold 4 s (limiter.rpm, load 1, `limiter: true`), autoShiftPull 10 s (load 0.6, upshifts at 0.65·redline, gears 1–min(4, gears)); `export function bindSegmentEngine(spec: EngineSpec): void` (required before any `ctl` call; `ctl` throws otherwise); `export function createBaseControl(spec: EngineSpec, perspective: Perspective = 'cabin'): DspControl` (warm, running, valve auto, comfort, idle in gear 1); `export const PROGRAM_S = 49`; `export function playSegments(t: number, base: DspControl): void` (all segments back-to-back, repeating, ShiftState.t0 converted to absolute time). `ctl` and `playSegments` never allocate.
  - `tools/render.ts`: `export const USAGE: string`; `export const MIN_FS = 28000`; `export const PREROLL_S = 0.5`; `export interface RenderOptions { engine: string; segments: string[]; perspective: Perspective; subwoofer: 'yes' | 'no'; outDir: string; fs: number }`; `export function parseArgs(argv: string[]): RenderOptions` (defaults: every segment, `cabin`, `yes`, `renders`, 48000; throws `Error` on bad input); `export function resolveEngine(arg: string, root?: string): string`; `export function loadEngine(path: string): EngineDef`; `export interface RenderedSegment { left: Float32Array; right: Float32Array; nonFiniteResets: number }`; `export function renderSegment(def, seg, opts: Pick<RenderOptions, 'perspective' | 'subwoofer' | 'fs'>): RenderedSegment`; `export function main(argv: string[]): number` (0, or 2 for usage errors). Output `<out>/<engine id>-<segment>-<perspective>.wav`.
  - `tools/check-alloc.ts`: `FS`, `WARM_QUANTA = 10_000`, `MEASURE_QUANTA = 100_000`, `PROFILE_QUANTA = 20_000`, `ENGINE_ID = 'v8-crossplane-test'`, `MAX_PAUSE_MS = 1.0`, `MAX_GC_FRACTION = 0.01`; `export interface GcSample { kind: number; durationMs: number }`; `export interface GcVerdict { minor; major; other; totalMs; maxPauseMs; fraction; ok; reasons: string[] }`; `export function gcVerdict(samples: readonly GcSample[], audioS: number): GcVerdict`; `export async function main(argv: string[]): Promise<number>` (0 pass, 1 gate failed, 2 not run with `--expose-gc`).
  - `tools/bench-dsp.ts`: `FS`, `WARM_S = 2`, `AUDIO_S = 20`, `FULL_FLOOR = 10` (amendment B6), `ENGINES = ['v8-crossplane-test', 'i5-test']`, `TIERS`; `export interface BenchRow { engine: string; tier: Tier; audioS: number; wallMs: number; factor: number }`; `export function measureRealtime(def: EngineDef, tier: Tier, audioS: number, warmS: number): BenchRow`; `export function formatTable(rows: readonly BenchRow[]): string`; `export function slowFullRows(rows: readonly BenchRow[], floor?: number): BenchRow[]`; `export function main(): number`.
  - npm scripts: `"render": "tsx tools/render.ts"`, `"check:alloc": "node --expose-gc --import tsx tools/check-alloc.ts"` (amendment B2: default V8 flags and semispace), `"bench:dsp": "tsx tools/bench-dsp.ts"`.

**Cross-task premises** (open each file and confirm every bullet before coding):
- Phase 0 T1 `eslint.config.js` is the flat config `export default defineConfig(globalIgnores([...]), js.configs.recommended, tseslint.configs.recommended)` (imports from `@eslint/js`, `eslint/config`, `typescript-eslint`). If its contents differ, keep them and append this task's block as the **last** argument of `defineConfig(...)`.
- Phase 0 T1 `package.json` has the Phase 0 scripts and `tsx` as a devDependency; Node ≥ 22.12 (GC `PerformanceEntry` objects carry `detail.kind`; `node:inspector/promises` exists). Phase 0 T1 `.gitignore` exists and does not yet list `renders/`.
- Phase 0 T12 `docs/CLEAN_ROOM.md` exists with a `## Policy` heading; Phase 0's `tests/unit/repo-files.test.ts` scans it for IPv4-like literals (the appended log contains none).
- T8 and T9 exports exactly as listed under Consumes; `TesboxDspCore.render` accepts negative `nowS` (the render pre-roll runs at t < 0).
- T1 fixtures: every fixture has ≥ 1 `overallRatios` entry, `gearbox.shiftTimeS > 0`, and `idle + 200 < min(6000, redline − 500) ≤ limiter.rpm`.
- Every hot-path method in `src/dsp/**` (T1–T9) and `src/sim/**` (Phase 1, whose contract requires the same rule) is free of allocation syntax; a violation reported by `npm run lint` is fixed in the owning file, never by disabling the rule.
- `src/dsp/` contains exactly the modules of the Phase 2a file map; `tests/unit/clean-room.test.ts` requires a row for every `src/dsp/*.ts`, so a helper module added by another task needs its own row.

- [ ] **Step 1: Write the failing hot-path lint test**

Create `tests/unit/eslint-hot-path.test.ts`. It lints a probe class at virtual paths under `src/dsp`, `src/sim` and `src/ui`; the clean `tick` (line 4), `ticker` (not a hot name) and `configure` must not be flagged:

```ts
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MESSAGE = 'Hot path must not allocate (spec §4.4)';

const PROBE = `export class Probe {
  private y = 0;
  private readonly buf = new Float32Array(4);
  tick(x: number): number { this.y += x; return this.y; }
  process(x: number): number { const a = [x]; return a[0] ?? 0; }
  readLagrange(d: number): number { return new Float32Array(1)[0] ?? d; }
  render(): number { const f = (): number => this.y; return f(); }
  outLeft(): string { return \`\${this.y}\`; }
  step(): void { try { this.y = 1; } catch { this.y = 0; } }
  write(x: number): void { if (x > 1) throw new RangeError('x'); }
  scatter(a: number[]): number { return Math.max(...a); }
  push(): number { const o = { a: this.y }; return o.a; }
  update(): number { return [1, 2].reduce(function (s, v) { return s + v; }, this.y); }
  ticker(): number[] { return [this.y]; }
  configure(): void { this.buf.fill(0); const tmp = new Float64Array(2); void tmp; }
}
`;

function lineOf(needle: string): number {
  return PROBE.split('\n').findIndex((l) => l.includes(needle)) + 1;
}

async function hotPathLines(filePath: string): Promise<number[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(PROBE, { filePath });
  if (result === undefined) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  const hits = result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  for (const m of hits) expect(m.message).toBe(MESSAGE);
  return [...new Set(hits.map((m) => m.line))].sort((a, b) => a - b);
}

describe('eslint hot-path allocation rule', () => {
  it('flags allocation inside hot-path method bodies in src/dsp and nothing else', { timeout: 30_000 }, async () => {
    const expected = ['process(x', 'readLagrange', 'render()', 'outLeft', 'step()', 'write(x', 'scatter', 'push()', 'update()']
      .map(lineOf)
      .sort((a, b) => a - b);
    expect(await hotPathLines('src/dsp/__hot_path_probe__.ts')).toEqual(expected);
  });

  it('applies to src/sim as well', { timeout: 30_000 }, async () => {
    expect((await hotPathLines('src/sim/__hot_path_probe__.ts')).length).toBe(9);
  });

  it('does not apply outside src/dsp and src/sim', { timeout: 30_000 }, async () => {
    expect(await hotPathLines('src/ui/__hot_path_probe__.ts')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/eslint-hot-path.test.ts`
Expected: FAIL (2 of 3) — `AssertionError: expected [] to deeply equal [ 5, 6, 7, 8, 9, 10, 11, 12, 13 ]` and `AssertionError: expected +0 to be 9`; the `src/ui` case passes.

- [ ] **Step 3: Add the hot-path rule to `eslint.config.js`**

Add the two constants below the imports and append the block as the last argument of `defineConfig(...)`. The selector is amendment B1's (`> FunctionExpression > BlockStatement` anchors the match inside the method body; without it the method's own FunctionExpression matches and every hot method is flagged). With Phase 0's config the whole file then reads:

```js
// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Spec §4.4 / phase 2a contract B1: hot-path methods in src/dsp and src/sim must not allocate. */
const HOT_PATH_METHOD =
  'MethodDefinition[key.name=/^(tick|process|render|scatter|write|read[A-Za-z]*|step|push|accept|evaluate|update|next|request|input|out[A-Za-z]*)$/]';
const ALLOCATING =
  'NewExpression, ArrayExpression, ObjectExpression, ArrowFunctionExpression, FunctionExpression, SpreadElement, TemplateLiteral, TryStatement, ThrowStatement';

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'public/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/dsp/**/*.ts', 'src/sim/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `${HOT_PATH_METHOD} > FunctionExpression > BlockStatement :matches(${ALLOCATING})`,
          message: 'Hot path must not allocate (spec §4.4)',
        },
      ],
    },
  },
);
```

- [ ] **Step 4: Run the lint test and confirm it passes**

Run: `npx vitest run tests/unit/eslint-hot-path.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint the whole repository under the new rule**

Run: `npm run lint`
Expected: exit 0. Any `Hot path must not allocate (spec §4.4)` error is real allocation in that module's hot path (T1–T9 or Phase 1 `src/sim`): fix it in the owning file (preallocate in the constructor, write results to fields); do not disable the rule.

- [ ] **Step 6: Write the failing segments test**

Create `tests/unit/segments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DspControl, EngineSpec } from '../../src/contracts';
import { PROGRAM_S, SEGMENTS, bindSegmentEngine, createBaseControl, playSegments, type Segment } from '../../tools/segments';
import { FIXTURE_IDS, loadFixture, makeCtl } from './helpers/dsp-harness';

function seg(name: string): Segment {
  const s = SEGMENTS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no segment ${name}`);
  return s;
}

interface Sample {
  t: number;
  rpm: number;
  load: number;
  gear: number;
  limiter: boolean;
  driveline: DspControl['driveline'];
  shift: DspControl['shift'];
}

function sampleSegment(s: Segment, dt = 0.001): Sample[] {
  const base = makeCtl(0, 0);
  const out: Sample[] = [];
  for (let t = 0; t < s.durationS; t += dt) {
    s.ctl(t, base);
    out.push({ t, rpm: base.rpm, load: base.load, gear: base.gear, limiter: base.limiter, driveline: base.driveline, shift: { ...base.shift } });
  }
  return out;
}

function shiftEvents(samples: Sample[]): DspControl['shift'][] {
  const ev: DspControl['shift'][] = [];
  for (const s of samples) {
    if (s.shift.active && !ev.some((e) => e.t0 === s.shift.t0)) ev.push(s.shift);
  }
  return ev;
}

describe('segments', () => {
  it('throws before an engine is bound', () => {
    expect(() => seg('idle').ctl(0, makeCtl(0, 0))).toThrow(/bindSegmentEngine/);
  });

  it('defines exactly the contract segments and durations', () => {
    expect(SEGMENTS.map((s) => [s.name, s.durationS])).toEqual([
      ['idle', 5],
      ['cruise2k', 4],
      ['cruise4k', 4],
      ['cruise6k', 4],
      ['wotPull', 12],
      ['liftoff6k', 6],
      ['limiterHold', 4],
      ['autoShiftPull', 10],
    ]);
    expect(PROGRAM_S).toBe(49);
  });

  it('createBaseControl: warm, running, app defaults, idle in gear 1', () => {
    const spec = loadFixture('i6-test').spec;
    expect(createBaseControl(spec, 'outside')).toEqual({
      rpm: spec.rpm.idle,
      load: 0,
      gear: 1,
      driveline: 'engaged',
      limiter: false,
      shift: { active: false, up: true, fromRpm: spec.rpm.idle, toRpm: spec.rpm.idle, t0: 0, durationS: spec.gearbox.shiftTimeS },
      ignitionOn: true,
      runTimeS: 600,
      valve: 'auto',
      perspective: 'outside',
      driveMode: 'comfort',
      warm: true,
    });
    expect(createBaseControl(spec).perspective).toBe('cabin');
  });

  for (const id of FIXTURE_IDS) {
    it(`produces bounded, consistent control for ${id}`, () => {
      const spec: EngineSpec = loadFixture(id).spec;
      bindSegmentEngine(spec);
      const ratios = spec.gearbox.overallRatios;
      const bad: string[] = [];
      for (const s of SEGMENTS) {
        for (const x of sampleSegment(s)) {
          const ok =
            Number.isFinite(x.rpm) &&
            x.rpm > 0 &&
            x.rpm <= spec.rpm.limiter.rpm + 1e-9 &&
            x.load >= -1 &&
            x.load <= 1 &&
            x.gear >= 1 &&
            x.gear <= ratios.length &&
            (!x.shift.active || x.shift.durationS === spec.gearbox.shiftTimeS);
          if (!ok) bad.push(`${s.name} t=${x.t.toFixed(3)} rpm=${x.rpm} load=${x.load} gear=${x.gear}`);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);

      expect(sampleSegment(seg('idle')).every((x) => x.rpm === spec.rpm.idle && x.driveline === 'clutch-open')).toBe(true);
      const c6 = sampleSegment(seg('cruise6k'));
      expect(c6.every((x) => x.rpm === Math.min(6000, spec.rpm.redline - 500) && x.load === 0.3)).toBe(true);
      expect(sampleSegment(seg('limiterHold')).every((x) => x.limiter && x.rpm === spec.rpm.limiter.rpm && x.load === 1)).toBe(true);

      const g = Math.min(4, ratios.length);
      const wot = sampleSegment(seg('wotPull'));
      const wotShifts = shiftEvents(wot);
      expect(wotShifts.length).toBe(g - 1);
      wotShifts.forEach((e, i) => {
        expect(e.fromRpm).toBeCloseTo(spec.rpm.redline, 9);
        expect(e.toRpm).toBeCloseTo((spec.rpm.redline * (ratios[i + 1] ?? 0)) / (ratios[i] ?? 1), 9);
      });
      expect(wot[0]?.rpm).toBeCloseTo(spec.rpm.idle, 9);
      expect(wot.filter((x) => x.t >= 11).every((x) => x.limiter && x.rpm === spec.rpm.limiter.rpm)).toBe(true);
      expect(wot.filter((x) => x.t < 8.9).some((x) => x.limiter)).toBe(false);
      let maxJump = 0;
      for (let i = 1; i < wot.length; i++) {
        const a = wot[i - 1];
        const b = wot[i];
        if (a && b && !a.shift.active && !b.shift.active && a.gear === b.gear) maxJump = Math.max(maxJump, Math.abs(b.rpm - a.rpm));
      }
      expect(maxJump).toBeLessThan(10); // ≤ 10 rpm per ms within a gear: continuous climb

      const lift = sampleSegment(seg('liftoff6k'));
      expect(lift.find((x) => x.t >= 1)?.load).toBe(-0.6);
      expect((lift.find((x) => x.t >= 1)?.rpm ?? 0) > (lift.find((x) => x.t >= 4)?.rpm ?? Infinity)).toBe(true);
      expect(lift.find((x) => x.t >= 5.5)?.driveline).toBe('clutch-open');

      const auto = sampleSegment(seg('autoShiftPull'));
      const autoShifts = shiftEvents(auto);
      expect(autoShifts.length).toBe(g - 1);
      autoShifts.forEach((e) => expect(e.fromRpm).toBeCloseTo(0.65 * spec.rpm.redline, 9));
      expect(Math.max(...auto.map((x) => x.gear))).toBe(g);
      expect(auto.every((x) => x.load === 0.6 && !x.limiter)).toBe(true);
    });
  }

  it('playSegments plays the segments back-to-back on an absolute timeline and repeats', () => {
    const spec = loadFixture('v8-crossplane-test').spec;
    bindSegmentEngine(spec);
    const viaProgram = createBaseControl(spec);
    const direct = createBaseControl(spec);
    let start = 0;
    for (const s of SEGMENTS) {
      for (const local of [0, 0.37 * s.durationS, s.durationS - 0.01]) {
        for (const cycle of [0, 1]) {
          const t = cycle * PROGRAM_S + start + local;
          playSegments(t, viaProgram);
          s.ctl(local, direct);
          const label = `${s.name} @ ${local.toFixed(2)} (cycle ${cycle})`;
          expect(viaProgram.rpm, label).toBeCloseTo(direct.rpm, 6);
          expect(viaProgram.load, label).toBe(direct.load);
          expect(viaProgram.gear, label).toBe(direct.gear);
          expect(viaProgram.limiter, label).toBe(direct.limiter);
          expect(viaProgram.driveline, label).toBe(direct.driveline);
          expect(viaProgram.shift.active, label).toBe(direct.shift.active);
          if (direct.shift.active) expect(viaProgram.shift.t0, label).toBeCloseTo(direct.shift.t0 + start + cycle * PROGRAM_S, 6);
        }
      }
      start += s.durationS;
    }
  });
});
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `npx vitest run tests/unit/segments.test.ts`
Expected: FAIL — `Error: Cannot find module '../../tools/segments' imported from …/tests/unit/segments.test.ts`.

- [ ] **Step 8: Implement `tools/segments.ts`**

Phase 2a has no SimCore (it runs in parallel with Phase 1 and must not import `src/sim`), so the segments are kinematic profiles: in a pull, the rpm climb rate in gear g is proportional to its overall ratio (constant vehicle acceleration), scaled so the climbs plus `shiftTimeS` per upshift end at 9 s (WOT) or 8 s (auto). Each upshift is a ShiftState from the shift rpm to `shiftRpm·r(g+1)/r(g)`; DspCore's RpmState follows its own trajectory during the shift. Create `tools/segments.ts`:

```ts
/**
 * Fixed render segments for tesbox-render / tesbox-score (spec §11.1). Each segment mutates a
 * DspControl in place for segment-relative time t (s); pass the same t as render()'s nowS so
 * ShiftState.t0 values line up. Segments need engine numbers (idle, redline, limiter, ratios, shift
 * time): call bindSegmentEngine(spec) before using SEGMENTS. Phase 2a has no SimCore, so rpm
 * trajectories are simple kinematic profiles (constant vehicle acceleration per gear).
 * Segment ctl() and playSegments() never allocate (tools/check-alloc.ts drives them per quantum).
 */
import type { DspControl, EngineSpec, Perspective } from '../src/contracts';

export interface Segment {
  name: string;
  durationS: number;
  ctl(t: number, base: DspControl): void;
}

interface Phase {
  t0: number;
  t1: number;
  gear: number;
  rpm0: number;
  rpm1: number;
  /** True for shift phases: ShiftState {fromRpm, toRpm = rpm0, t0} is active while t ∈ [t0, t1). */
  shift: boolean;
  fromRpm: number;
  limiter: boolean;
}

interface Bound {
  idle: number;
  redline: number;
  limiterRpm: number;
  shiftTimeS: number;
  wot: Phase[];
  auto: Phase[];
}

let bound: Bound | null = null;

function engine(): Bound {
  if (bound === null) throw new Error('segments: call bindSegmentEngine(spec) before using SEGMENTS');
  return bound;
}

/**
 * Pull through gears 1..G (G = min(gears, ratios)): rpm climbs from `startRpm` in gear 1, upshifts at
 * `shiftRpm` (each a ShiftState of spec.gearbox.shiftTimeS), climbs in gear G to `finalRpm`, then
 * holds (limiter flag set when `limiter`). Climb rate in gear g ∝ ratio g (constant vehicle
 * acceleration), scaled so that the climbs plus the shifts end at `climbS`.
 */
function buildPull(
  spec: EngineSpec,
  gears: number,
  startRpm: number,
  shiftRpm: number,
  finalRpm: number,
  climbS: number,
  totalS: number,
  limiter: boolean,
): Phase[] {
  const ratios = spec.gearbox.overallRatios;
  const g = Math.max(1, Math.min(gears, ratios.length));
  const r = (gear: number): number => ratios[gear - 1] ?? 1;
  const r1 = r(1);
  const shiftS = spec.gearbox.shiftTimeS;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let gear = 1; gear <= g; gear++) {
    starts.push(gear === 1 ? startRpm : (shiftRpm * r(gear)) / r(gear - 1));
    ends.push(gear === g ? finalRpm : shiftRpm);
  }
  let weighted = 0; // Σ (end − start) · r1 / r_g  →  climb time = weighted / rate1
  for (let gear = 1; gear <= g; gear++) {
    weighted += (((ends[gear - 1] ?? 0) - (starts[gear - 1] ?? 0)) * r1) / r(gear);
  }
  const rate1 = weighted / Math.max(0.5, climbS - (g - 1) * shiftS);
  const phases: Phase[] = [];
  let t = 0;
  for (let gear = 1; gear <= g; gear++) {
    const s = starts[gear - 1] ?? 0;
    const e = ends[gear - 1] ?? 0;
    const dur = (e - s) / ((rate1 * r(gear)) / r1);
    phases.push({ t0: t, t1: t + dur, gear, rpm0: s, rpm1: e, shift: false, fromRpm: s, limiter: false });
    t += dur;
    if (gear < g) {
      const to = starts[gear] ?? 0;
      phases.push({ t0: t, t1: t + shiftS, gear: gear + 1, rpm0: to, rpm1: to, shift: true, fromRpm: e, limiter: false });
      t += shiftS;
    }
  }
  phases.push({ t0: t, t1: Math.max(t, totalS), gear: g, rpm0: finalRpm, rpm1: finalRpm, shift: false, fromRpm: finalRpm, limiter });
  return phases;
}

/** Binds SEGMENTS to an engine (idle, redline, limiter, ratios, shift time). */
export function bindSegmentEngine(spec: EngineSpec): void {
  const idle = spec.rpm.idle;
  const redline = spec.rpm.redline;
  const limiterRpm = spec.rpm.limiter.rpm;
  bound = {
    idle,
    redline,
    limiterRpm,
    shiftTimeS: spec.gearbox.shiftTimeS,
    wot: buildPull(spec, 4, idle, redline, limiterRpm, 9, 12, true),
    auto: buildPull(spec, 4, idle, 0.65 * redline, 0.65 * redline, 8, 10, false),
  };
}

/** A warm, running control with the app defaults (valve auto, comfort), idling in gear 1. */
export function createBaseControl(spec: EngineSpec, perspective: Perspective = 'cabin'): DspControl {
  return {
    rpm: spec.rpm.idle,
    load: 0,
    gear: 1,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: spec.rpm.idle, toRpm: spec.rpm.idle, t0: 0, durationS: spec.gearbox.shiftTimeS },
    ignitionOn: true,
    runTimeS: 600,
    valve: 'auto',
    perspective,
    driveMode: 'comfort',
    warm: true,
  };
}

function steady(base: DspControl, rpm: number, load: number, gear: number): void {
  base.rpm = rpm;
  base.load = load;
  base.gear = gear;
  base.driveline = 'engaged';
  base.limiter = false;
  base.shift.active = false;
}

function cruiseRpm(target: number): number {
  return Math.min(target, engine().redline - 500);
}

function followPull(phases: Phase[], t: number, base: DspControl, load: number): void {
  const b = engine();
  let ph = phases[phases.length - 1];
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p !== undefined && t < p.t1) {
      ph = p;
      break;
    }
  }
  if (ph === undefined) return;
  const u = ph.t1 > ph.t0 ? Math.min(1, Math.max(0, (t - ph.t0) / (ph.t1 - ph.t0))) : 1;
  base.rpm = ph.rpm0 + (ph.rpm1 - ph.rpm0) * u;
  base.load = load;
  base.gear = ph.gear;
  base.driveline = 'engaged';
  base.limiter = ph.limiter;
  const s = base.shift;
  if (ph.shift) {
    s.active = true;
    s.up = true;
    s.fromRpm = ph.fromRpm;
    s.toRpm = ph.rpm0;
    s.t0 = ph.t0;
    s.durationS = b.shiftTimeS;
  } else {
    s.active = false;
  }
}

export const SEGMENTS: Segment[] = [
  {
    name: 'idle',
    durationS: 5,
    ctl(_t, base) {
      steady(base, engine().idle, 0, 1);
      base.driveline = 'clutch-open';
    },
  },
  {
    name: 'cruise2k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(2000), 0.3, 3);
    },
  },
  {
    name: 'cruise4k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(4000), 0.3, 3);
    },
  },
  {
    name: 'cruise6k',
    durationS: 4,
    ctl(_t, base) {
      steady(base, cruiseRpm(6000), 0.3, 3);
    },
  },
  {
    name: 'wotPull',
    durationS: 12,
    ctl(t, base) {
      followPull(engine().wot, t, base, 1);
    },
  },
  {
    name: 'liftoff6k',
    durationS: 6,
    ctl(t, base) {
      const b = engine();
      const start = cruiseRpm(6000);
      const end = b.idle + 200;
      if (t < 0.5) {
        steady(base, start, 0.3, 3);
      } else if (t < 5) {
        steady(base, start + ((end - start) * (t - 0.5)) / 4.5, -0.6, 3);
      } else {
        steady(base, end, 0, 3);
        base.driveline = 'clutch-open';
      }
    },
  },
  {
    name: 'limiterHold',
    durationS: 4,
    ctl(_t, base) {
      steady(base, engine().limiterRpm, 1, 3);
      base.limiter = true;
    },
  },
  {
    name: 'autoShiftPull',
    durationS: 10,
    ctl(t, base) {
      followPull(engine().auto, t, base, 0.6);
    },
  },
];

/** Total length of one pass through SEGMENTS (s). */
export const PROGRAM_S = SEGMENTS.reduce((s, seg) => s + seg.durationS, 0);

/**
 * Plays every segment back-to-back, repeating, on one absolute timeline: t (s) → control, with
 * ShiftState.t0 converted to absolute time (render with nowS = t). Allocation-free.
 */
export function playSegments(t: number, base: DspControl): void {
  const cycleStart = Math.floor(t / PROGRAM_S) * PROGRAM_S;
  let start = cycleStart;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const seg = SEGMENTS[i];
    if (seg === undefined) continue;
    if (t < start + seg.durationS || i === SEGMENTS.length - 1) {
      seg.ctl(t - start, base);
      if (base.shift.active) base.shift.t0 += start;
      return;
    }
    start += seg.durationS;
  }
}
```

- [ ] **Step 9: Run the segments test and confirm it passes**

Run: `npx vitest run tests/unit/segments.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 10: Write the failing render test**

Create `tests/unit/render.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmsDb, truePeakDbtp } from '../../src/dsp/analysis';
import { SEGMENTS } from '../../tools/segments';
import { MIN_FS, loadEngine, main, parseArgs, renderSegment, resolveEngine } from '../../tools/render';
import { readWav } from '../../tools/wav';
import { allFinite } from './helpers/dsp-harness';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tesbox-render-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tesbox-render argument parsing', () => {
  it('applies defaults', () => {
    expect(parseArgs(['i4-test'])).toEqual({
      engine: 'i4-test',
      segments: SEGMENTS.map((s) => s.name),
      perspective: 'cabin',
      subwoofer: 'yes',
      outDir: 'renders',
      fs: 48000,
    });
  });

  it('parses every option', () => {
    expect(
      parseArgs(['--segments', 'idle,wotPull', 'v8-sc-test', '--perspective', 'outside', '--subwoofer', 'no', '--out', 'x/y', '--fs', '44100']),
    ).toEqual({ engine: 'v8-sc-test', segments: ['idle', 'wotPull'], perspective: 'outside', subwoofer: 'no', outDir: 'x/y', fs: 44100 });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs([])).toThrow(/missing/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected/);
    expect(() => parseArgs(['a', '--segments', 'idle,nope'])).toThrow(/nope/);
    expect(() => parseArgs(['a', '--perspective', 'roof'])).toThrow(/perspective/);
    expect(() => parseArgs(['a', '--subwoofer', 'unsure'])).toThrow(/subwoofer/);
    expect(() => parseArgs(['a', '--fs', '96000'])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs', String(MIN_FS - 1)])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs', '44100.5'])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--loud'])).toThrow(/unknown option/);
  });
});

describe('tesbox-render engine resolution', () => {
  it('falls back to tests/fixtures/engines for ids not in src/data/engines', () => {
    expect(resolveEngine('i4-test', ROOT)).toBe(join(ROOT, 'tests/fixtures/engines/i4-test.json'));
  });

  it('accepts explicit JSON paths and rejects unknown or unsafe ids', () => {
    const p = join(ROOT, 'tests/fixtures/engines/i6-test.json');
    expect(resolveEngine(p, ROOT)).toBe(p);
    expect(() => resolveEngine('no-such-engine', ROOT)).toThrow(/not found/);
    expect(() => resolveEngine('..', ROOT)).toThrow(/invalid engine id/);
    expect(() => resolveEngine(join(dir, 'missing.json'), ROOT)).toThrow(/not found/);
    expect(loadEngine(p).id).toBe('i6-test');
  });
});

describe('tesbox-render rendering', () => {
  it('renders a segment to finite, level-safe stereo of the exact duration', { timeout: 30_000 }, () => {
    const def = loadEngine(resolveEngine('i4-test', ROOT));
    const seg = SEGMENTS.find((s) => s.name === 'cruise2k');
    if (!seg) throw new Error('cruise2k missing');
    const { left, right, nonFiniteResets } = renderSegment(def, seg, { perspective: 'cabin', subwoofer: 'yes', fs: 48000 });
    expect(left.length).toBe(4 * 48000);
    expect(right.length).toBe(4 * 48000);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(nonFiniteResets).toBe(0);
    expect(truePeakDbtp(left)).toBeLessThanOrEqual(-1.0);
    expect(truePeakDbtp(right)).toBeLessThanOrEqual(-1.0);
    // the pre-roll removes the start-up fade: the first 100 ms are already at the steady level
    const steady = rmsDb(left.subarray(48000));
    expect(steady).toBeGreaterThan(-60);
    expect(rmsDb(left.subarray(0, 4800))).toBeGreaterThan(steady - 6);
  });

  it('main() writes one WAV per requested segment', { timeout: 60_000 }, () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['i4-test', '--segments', 'idle,limiterHold', '--out', dir, '--perspective', 'outside'])).toBe(0);
    } finally {
      log.mockRestore();
    }
    for (const [name, seconds] of [['idle', 5], ['limiterHold', 4]] as const) {
      const p = join(dir, `i4-test-${name}-outside.wav`);
      expect(existsSync(p)).toBe(true);
      const w = readWav(p);
      expect(w.fs).toBe(48000);
      expect(w.channels.length).toBe(2);
      expect(w.channels[0]?.length).toBe(seconds * 48000);
    }
  });

  it('main() returns 2 with usage on bad arguments', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['--fs', '1'])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('usage:'));
    } finally {
      err.mockRestore();
    }
  });
});
```

- [ ] **Step 11: Run it and confirm it fails**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: FAIL — `Error: Cannot find module '../../tools/render' imported from …/tests/unit/render.test.ts`.

- [ ] **Step 12: Implement `tools/render.ts`**

Each segment renders on a fresh core (Full tier, seed 1, `forceHot()`, trim 0 dB) after a discarded 0.5 s pre-roll at the segment's t = 0 control, so the WAV starts at steady state rather than with the start-up fades and empty pipes. The CLI runs only when the file is the process entry point, so tests and the other tools can import it. Create `tools/render.ts`:

```ts
/**
 * tesbox-render (spec §11.1): renders DspCore through fixed segments to 32-bit float WAVs.
 *
 *   tsx tools/render.ts <engine-id-or-json-path> [--segments a,b] [--perspective cabin|outside]
 *                       [--subwoofer yes|no] [--out renders/] [--fs 48000]
 *
 * An engine id resolves src/data/engines/<id>.json if present, else tests/fixtures/engines/<id>.json.
 * Output: <out>/<engine id>-<segment>-<perspective>.wav (renders/ is gitignored).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SAMPLE_RATE, QUANTUM, type EngineDef, type Perspective } from '../src/contracts';
import { rmsDb, truePeakDbtp } from '../src/dsp/analysis';
import { TesboxDspCore } from '../src/dsp/dsp-core';
import { SEGMENTS, bindSegmentEngine, createBaseControl, type Segment } from './segments';
import { writeWav } from './wav';

export const USAGE =
  'usage: tsx tools/render.ts <engine-id-or-json-path> [--segments a,b] [--perspective cabin|outside] [--subwoofer yes|no] [--out renders/] [--fs 48000]';

/** ExhaustNetwork may reject sample rates below this (phase 2a contract B3). */
export const MIN_FS = 28000;
/** Discarded lead-in rendered with the segment's t = 0 control (start-up fades and empty pipes). */
export const PREROLL_S = 0.5;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface RenderOptions {
  engine: string;
  segments: string[];
  perspective: Perspective;
  subwoofer: 'yes' | 'no';
  outDir: string;
  fs: number;
}

export function parseArgs(argv: string[]): RenderOptions {
  const o: RenderOptions = {
    engine: '',
    segments: SEGMENTS.map((s) => s.name),
    perspective: 'cabin',
    subwoofer: 'yes',
    outDir: 'renders',
    fs: 48000,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--segments') {
      const names = value(i, a).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const valid = SEGMENTS.map((s) => s.name);
      const unknown = names.filter((n) => !valid.includes(n));
      if (names.length === 0 || unknown.length > 0) {
        throw new Error(`unknown segment(s) ${unknown.join(', ') || '(none)'}; valid: ${valid.join(', ')}`);
      }
      o.segments = names;
      i++;
    } else if (a === '--perspective') {
      const v = value(i, a);
      if (v !== 'cabin' && v !== 'outside') throw new Error(`--perspective must be cabin|outside, got ${v}`);
      o.perspective = v;
      i++;
    } else if (a === '--subwoofer') {
      const v = value(i, a);
      if (v !== 'yes' && v !== 'no') throw new Error(`--subwoofer must be yes|no, got ${v}`);
      o.subwoofer = v;
      i++;
    } else if (a === '--out') {
      o.outDir = value(i, a);
      i++;
    } else if (a === '--fs') {
      const v = Number(value(i, a));
      if (!Number.isInteger(v) || v < MIN_FS || v > MAX_SAMPLE_RATE) {
        throw new Error(`--fs must be an integer in [${MIN_FS}, ${MAX_SAMPLE_RATE}]`);
      }
      o.fs = v;
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else if (o.engine === '') {
      o.engine = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  if (o.engine === '') throw new Error('missing <engine-id-or-json-path>');
  return o;
}

/** Path of the engine JSON for an id (src/data/engines first, then tests/fixtures/engines) or an explicit .json path. */
export function resolveEngine(arg: string, root: string = REPO_ROOT): string {
  if (arg.endsWith('.json') || arg.includes('/') || arg.includes('\\')) {
    const p = resolve(arg);
    if (!existsSync(p)) throw new Error(`engine file not found: ${p}`);
    return p;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(arg)) throw new Error(`invalid engine id "${arg}" (kebab-case expected)`);
  for (const dir of ['src/data/engines', 'tests/fixtures/engines']) {
    const p = join(root, dir, `${arg}.json`);
    if (existsSync(p)) return p;
  }
  throw new Error(`engine "${arg}" not found in src/data/engines or tests/fixtures/engines`);
}

export function loadEngine(path: string): EngineDef {
  const def = JSON.parse(readFileSync(path, 'utf8')) as EngineDef;
  if (typeof def.id !== 'string' || !Array.isArray(def.spec?.combustion) || typeof def.voicing !== 'object') {
    throw new Error(`${path} is not an EngineDef`);
  }
  return def;
}

export interface RenderedSegment {
  left: Float32Array;
  right: Float32Array;
  nonFiniteResets: number;
}

/** Renders one segment: Full tier, seed 1, warm engine at hot steady state, valve auto, comfort, trim 0 dB. */
export function renderSegment(
  def: EngineDef,
  seg: Segment,
  opts: Pick<RenderOptions, 'perspective' | 'subwoofer' | 'fs'>,
): RenderedSegment {
  const fs = opts.fs;
  bindSegmentEngine(def.spec);
  const core = new TesboxDspCore(fs, 1);
  core.configure(def, { subwoofer: opts.subwoofer, hpCornerHz: 40, volumeTrimDb: 0 }, 'full');
  core.forceHot();
  const base = createBaseControl(def.spec, opts.perspective);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  const pre = Math.round((PREROLL_S * fs) / QUANTUM);
  seg.ctl(0, base);
  for (let q = 0; q < pre; q++) core.render(base, l, r, QUANTUM, ((q - pre) * QUANTUM) / fs);
  const frames = Math.round(seg.durationS * fs);
  const quanta = Math.ceil(frames / QUANTUM);
  const left = new Float32Array(quanta * QUANTUM);
  const right = new Float32Array(quanta * QUANTUM);
  for (let q = 0; q < quanta; q++) {
    const t = (q * QUANTUM) / fs;
    seg.ctl(t, base);
    base.runTimeS = 600 + t;
    core.render(base, l, r, QUANTUM, t);
    left.set(l, q * QUANTUM);
    right.set(r, q * QUANTUM);
  }
  return { left: left.subarray(0, frames), right: right.subarray(0, frames), nonFiniteResets: core.stats.nonFiniteResets };
}

/** CLI entry; returns the process exit code (2 = usage error). */
export function main(argv: string[]): number {
  let opts: RenderOptions;
  let def: EngineDef;
  try {
    opts = parseArgs(argv);
    def = loadEngine(resolveEngine(opts.engine));
  } catch (e) {
    console.error(`tesbox-render: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  for (const name of opts.segments) {
    const seg = SEGMENTS.find((s) => s.name === name);
    if (seg === undefined) continue;
    const { left, right, nonFiniteResets } = renderSegment(def, seg, opts);
    const path = join(opts.outDir, `${def.id}-${seg.name}-${opts.perspective}.wav`);
    writeWav(path, [left, right], opts.fs);
    const tp = Math.max(truePeakDbtp(left), truePeakDbtp(right));
    console.log(
      `wrote ${path}  ${seg.durationS} s  true peak ${tp.toFixed(2)} dBTP  RMS ${rmsDb(left).toFixed(1)} dB  non-finite resets ${nonFiniteResets}`,
    );
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 13: Run the render test and confirm it passes**

Run: `npx vitest run tests/unit/render.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 14: Add the npm scripts and ignore `renders/`**

Run:

```bash
npm pkg set scripts.render="tsx tools/render.ts" "scripts.check:alloc=node --expose-gc --import tsx tools/check-alloc.ts" "scripts.bench:dsp=tsx tools/bench-dsp.ts"
grep -qxF 'renders/' .gitignore || printf '\n# tesbox-render output (local listening only)\nrenders/\n' >> .gitignore
npm pkg get scripts.render scripts.check:alloc scripts.bench:dsp
```

Expected: the last command prints the three scripts exactly as set; `.gitignore` contains one `renders/` line.

- [ ] **Step 15: Smoke-test the render CLI**

Run: `npm run render -- v8-crossplane-test --segments idle,wotPull --out renders/ ; npm run render -- nope; echo "exit=$?"; git status --short --ignored renders`
Expected: two lines `wrote renders/v8-crossplane-test-idle-cabin.wav  5 s  true peak … dBTP  RMS … dB  non-finite resets 0` and `wrote renders/v8-crossplane-test-wotPull-cabin.wav  12 s  …` with both true peaks ≤ −1.00 dBTP (planning run: −28.1 and −2.4 dBTP); then `tesbox-render: engine "nope" not found in src/data/engines or tests/fixtures/engines`, the usage line and `exit=2`; git reports `!! renders/` (ignored). Listen to `renders/v8-crossplane-test-wotPull-cabin.wav`: shifts, then limiter bounce from ≈ 9 s.

- [ ] **Step 16: Write the failing check-alloc test**

Create `tests/unit/check-alloc.test.ts` (it tests the pure B2 verdict; the measurement itself runs in Step 20):

```ts
import { constants } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { MAX_GC_FRACTION, MAX_PAUSE_MS, gcVerdict, main } from '../../tools/check-alloc';

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
const INCREMENTAL = constants.NODE_PERFORMANCE_GC_INCREMENTAL;

describe('check-alloc gcVerdict (amendment B2)', () => {
  it('uses the contract thresholds', () => {
    expect(MAX_PAUSE_MS).toBe(1.0);
    expect(MAX_GC_FRACTION).toBe(0.01);
  });

  it('passes with many short minor GCs well under 1 % of the audio time', () => {
    const samples = Array.from({ length: 600 }, () => ({ kind: MINOR, durationMs: 0.3 }));
    const v = gcVerdict(samples, 266.67);
    expect(v).toMatchObject({ minor: 600, major: 0, other: 0, ok: true, reasons: [] });
    expect(v.totalMs).toBeCloseTo(180, 9);
    expect(v.maxPauseMs).toBe(0.3);
    expect(v.fraction).toBeCloseTo(180 / 266670, 12);
  });

  it('passes with no GC at all, and treats exactly 1.0 ms as within budget', () => {
    expect(gcVerdict([], 10).ok).toBe(true);
    expect(gcVerdict([{ kind: MINOR, durationMs: 1.0 }], 10).ok).toBe(true);
  });

  it('fails on any single pause above 1.0 ms, whatever its kind', () => {
    for (const kind of [MINOR, MAJOR, INCREMENTAL]) {
      const v = gcVerdict([{ kind, durationMs: 0.2 }, { kind, durationMs: 1.0001 }], 266.67);
      expect(v.ok).toBe(false);
      expect(v.reasons.join()).toMatch(/longest GC pause/);
    }
    expect(gcVerdict([{ kind: MAJOR, durationMs: 0.5 }, { kind: INCREMENTAL, durationMs: 0.1 }], 1)).toMatchObject({ major: 1, other: 1 });
  });

  it('fails when total GC time exceeds 1 % of the audio duration', () => {
    const samples = Array.from({ length: 101 }, () => ({ kind: MINOR, durationMs: 0.99 })); // 99.99 ms
    expect(gcVerdict(samples, 10).ok).toBe(true); // budget 100 ms
    const over = gcVerdict([...samples, { kind: MINOR, durationMs: 0.5 }], 10);
    expect(over.ok).toBe(false);
    expect(over.reasons.join()).toMatch(/total GC time/);
  });

  it('main() refuses to run without --expose-gc', async () => {
    const g = globalThis as { gc?: unknown };
    const saved = g.gc;
    delete g.gc;
    try {
      expect(await main([])).toBe(2);
    } finally {
      if (saved !== undefined) g.gc = saved;
    }
  });
});
```

- [ ] **Step 17: Run it and confirm it fails**

Run: `npx vitest run tests/unit/check-alloc.test.ts`
Expected: FAIL — `Error: Cannot find module '../../tools/check-alloc' imported from …/tests/unit/check-alloc.test.ts`.

- [ ] **Step 18: Implement `tools/check-alloc.ts`**

Amendment B2 replaces "any minor GC → exit 1": V8 boxes doubles that cross non-inlined calls, so with scalar per-sample APIs minor GCs are expected; the gate is pause time. The tool renders on one core with `playSegments` (every segment back-to-back), forces one GC after the warm-up, observes `gc` performance entries only inside the measured window (yielding every 1000 quanta so the observer drains), and prints the three longest pauses with their kind (1 minor, 4 major, 8 incremental). Create `tools/check-alloc.ts`:

```ts
/**
 * Allocation / GC-pause gate (spec §14 "Allocation"; phase 2a contract T10 + amendment B2).
 *
 *   node --expose-gc --import tsx tools/check-alloc.ts [--profile]      (npm run check:alloc)
 *
 * Default V8 flags and semispace. Renders 10 000 warm-up quanta, then 100 000 measured quanta of
 * v8-crossplane-test (Full tier) driven by every render segment back-to-back (idle, cruise, WOT pull
 * with shifts, lift-off overrun, limiter, auto shifts). V8 boxes doubles that cross non-inlined calls,
 * so minor GCs are expected and only reported; the gate fails (exit 1) if any single GC pause exceeds
 * 1.0 ms or the total GC time exceeds 1 % of the rendered audio duration. `--profile` then prints the
 * top allocation sites of 20 000 further quanta (sampling heap profiler, incl. collected objects).
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
/** B2: fail if any single GC pause is longer than this (ms)… */
export const MAX_PAUSE_MS = 1.0;
/** …or if total GC time exceeds this fraction of the rendered audio duration. */
export const MAX_GC_FRACTION = 0.01;

export interface GcSample {
  /** perf_hooks constants.NODE_PERFORMANCE_GC_* (minor 1, major 4, incremental 8, weak callbacks 16). */
  kind: number;
  durationMs: number;
}

export interface GcVerdict {
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

function nextTurn(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Top allocation sites (bytes) of `run()` via the sampling heap profiler, including collected objects. */
async function profileAllocations(run: () => void): Promise<[string, number][]> {
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  // The include* flags are newer than @types/node's StartSamplingParameterType; a variable skips the excess-property check.
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
  gc(); // start the measured window with an empty young generation
  await nextTurn();

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

  const audioS = MEASURE_QUANTA * dt;
  const wallS = (windowEnd - windowStart) / 1000;
  const v = gcVerdict(samples, audioS);
  const longest = [...samples].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  console.log(
    `check-alloc: ${ENGINE_ID} (Full), ${MEASURE_QUANTA} quanta = ${audioS.toFixed(1)} s of audio after ${WARM_QUANTA} warm-up quanta`,
  );
  console.log(`  render wall time  ${(wallS * 1000).toFixed(0)} ms (${(audioS / wallS).toFixed(1)}× realtime)`);
  console.log(`  GC events         minor ${v.minor}, major ${v.major}, other ${v.other}`);
  console.log(
    `  GC time           total ${v.totalMs.toFixed(1)} ms (${(v.fraction * 100).toFixed(3)} % of audio; budget ${MAX_GC_FRACTION * 100} %), longest pause ${v.maxPauseMs.toFixed(3)} ms (budget ${MAX_PAUSE_MS} ms)`,
  );
  console.log(`  longest pauses    ${longest.map((s) => `${s.durationMs.toFixed(3)} ms (kind ${s.kind})`).join(', ') || 'none'}`);
  console.log(`  non-finite resets ${core.stats.nonFiniteResets}`);

  if (argv.includes('--profile')) {
    const top = await profileAllocations(() => renderQuanta(PROFILE_QUANTA));
    console.log(`\nTop allocation sites over ${PROFILE_QUANTA} quanta (sampled bytes):`);
    for (const [site, bytes] of top) console.log(`${String(bytes).padStart(12)}  ${site}`);
  }

  if (!v.ok) {
    console.error(`check-alloc: FAIL — ${v.reasons.join('; ')} (run with --profile to find the allocation sites)`);
    return 1;
  }
  console.log('check-alloc: OK');
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 19: Run the check-alloc test and confirm it passes**

Run: `npx vitest run tests/unit/check-alloc.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 20: Run the allocation gate**

Run: `npm run check:alloc`
Expected: exit 0 and output of this shape (≈ 20–25 s):

```text
check-alloc: v8-crossplane-test (Full), 100000 quanta = 266.7 s of audio after 10000 warm-up quanta
  render wall time  … ms (…× realtime)
  GC events         minor …, major …, other …
  GC time           total … ms (… % of audio; budget 1 %), longest pause … ms (budget 1 ms)
  longest pauses    … ms (kind …), … ms (kind …), … ms (kind …)
  non-finite resets 0
check-alloc: OK
```

If it exits 1, run `npm run check:alloc -- --profile`: the allocation table names the functions that box doubles. Fix them in the owning module (B2: pass per-sample values through fields or typed arrays; keep small helpers small enough for TurboFan to inline), not by relaxing the gate or adding V8 flags. A single kind-4 (major) pause above 1 ms comes from old-space growth by promoted boxes and disappears when the allocation rate drops. Planning measurement with an earlier reference implementation of T1–T7 plus this T9 (this sandbox): minor 604, major 1, total 156 ms (0.058 % of audio), longest pause 1.89 ms (kind 4) → FAIL on the pause criterion only; sampled allocation ≈ 128 B/sample in `Biquad.process` return values, ≈ 119 B/sample inside `OutputStage`, ≈ 40 B/sample in `TesboxDspCore.step`. With the current T1–T5 drafts plus the earlier T6/T7 drafts: longest pause 2.58 ms (kind 4), total 151 ms → same verdict.

- [ ] **Step 21: Write the failing benchmark test**

Create `tests/unit/bench-dsp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FULL_FLOOR, formatTable, measureRealtime, slowFullRows, type BenchRow } from '../../tools/bench-dsp';
import { loadFixture } from './helpers/dsp-harness';

const row = (tier: 'full' | 'lite', factor: number): BenchRow => ({ engine: 'x', tier, audioS: 20, wallMs: 1000, factor });

describe('bench-dsp', () => {
  it('fails only Full rows below the 10× floor (amendment B6)', () => {
    expect(FULL_FLOOR).toBe(10);
    expect(slowFullRows([row('full', 10), row('full', 55), row('lite', 3)])).toEqual([]);
    expect(slowFullRows([row('full', 9.99), row('lite', 9)])).toEqual([row('full', 9.99)]);
    expect(slowFullRows([row('full', Number.NaN)])).toHaveLength(1);
  });

  it('formats a markdown table with one line per row', () => {
    const table = formatTable([row('full', 42.42), row('lite', 80)]);
    expect(table).toContain('| engine | tier | audio (s) | wall (ms) | × realtime |');
    expect(table).toContain('| x | full | 20.0 | 1000 | 42.4 |');
    expect(table).toContain('| x | lite | 20.0 | 1000 | 80.0 |');
  });

  it('measures a positive, finite realtime factor', { timeout: 30_000 }, () => {
    const r = measureRealtime(loadFixture('i5-test'), 'lite', 0.2, 0.05);
    expect(r.engine).toBe('i5-test');
    expect(r.tier).toBe('lite');
    expect(r.audioS).toBeCloseTo(0.2, 2);
    expect(Number.isFinite(r.factor) && r.factor > 0).toBe(true);
  });
});
```

- [ ] **Step 22: Run it and confirm it fails**

Run: `npx vitest run tests/unit/bench-dsp.test.ts`
Expected: FAIL — `Error: Cannot find module '../../tools/bench-dsp' imported from …/tests/unit/bench-dsp.test.ts`.

- [ ] **Step 23: Implement `tools/bench-dsp.ts`**

Create `tools/bench-dsp.ts`:

```ts
/**
 * DSP realtime-factor benchmark (spec §14 "Performance"; phase 2a contract T10 + amendment B6).
 *
 *   tsx tools/bench-dsp.ts        (npm run bench:dsp)
 *
 * Full and Lite tiers on two fixtures, each driven by every render segment back-to-back. Prints a
 * markdown table (also appended to $GITHUB_STEP_SUMMARY when set). Report-only, except exit 1 when a
 * Full row renders slower than 10× realtime (generous CI floor; the in-car budget comes from the
 * Phase 0 probe's headroom benchmark, not from here).
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
export const AUDIO_S = 20;
/** B6: Full tier must render at least this many times faster than realtime. */
export const FULL_FLOOR = 10;
export const ENGINES = ['v8-crossplane-test', 'i5-test'] as const;
export const TIERS: readonly Tier[] = ['full', 'lite'];

export interface BenchRow {
  engine: string;
  tier: Tier;
  audioS: number;
  wallMs: number;
  /** audio seconds rendered per wall-clock second */
  factor: number;
}

/** Renders `warmS` (untimed) then `audioS` (timed) seconds of the segment program; returns the realtime factor. */
export function measureRealtime(def: EngineDef, tier: Tier, audioS: number, warmS: number): BenchRow {
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
  const t0 = performance.now();
  run(quanta);
  const wallMs = performance.now() - t0;
  const renderedS = quanta * dt;
  return { engine: def.id, tier, audioS: renderedS, wallMs, factor: renderedS / (wallMs / 1000) };
}

export function formatTable(rows: readonly BenchRow[]): string {
  return [
    `### DSP realtime factor (fs ${FS}, node ${process.version})`,
    '',
    '| engine | tier | audio (s) | wall (ms) | × realtime |',
    '|---|---|---:|---:|---:|',
    ...rows.map((r) => `| ${r.engine} | ${r.tier} | ${r.audioS.toFixed(1)} | ${r.wallMs.toFixed(0)} | ${r.factor.toFixed(1)} |`),
    '',
  ].join('\n');
}

/** Full-tier rows below the floor (the only failing condition). */
export function slowFullRows(rows: readonly BenchRow[], floor: number = FULL_FLOOR): BenchRow[] {
  return rows.filter((r) => r.tier === 'full' && !(r.factor >= floor));
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
    console.error(`bench-dsp: FAIL — Full tier below ${FULL_FLOOR}× realtime: ${slow.map((r) => r.engine).join(', ')}`);
    return 1;
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = main();
}
```

- [ ] **Step 24: Run the benchmark test and confirm it passes**

Run: `npx vitest run tests/unit/bench-dsp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 25: Run the benchmark**

Run: `npm run bench:dsp; echo "exit=$?"`
Expected: a markdown table with four rows (`v8-crossplane-test` and `i5-test` × `full`/`lite`) and `exit=0`; exit 1 only if a Full row is below 10× realtime (B6). Planning runs on this sandbox: v8-crossplane-test full 12.8×, lite 16.6×; i5-test full 14.6×, lite 16.6× (earlier T1–T7 drafts); full 11.1× / 12.4× with the current T1–T5 drafts — close to the floor, so watch it. If Full is below 10×, profile the hot modules (`node --cpu-prof --import tsx tools/bench-dsp.ts`) before considering any contract change.

- [ ] **Step 26: Write the failing clean-room log test**

Create `tests/unit/clean-room.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const doc = readFileSync(new URL('docs/CLEAN_ROOM.md', root), 'utf8');

/** The "## Phase 2a source log" section, up to the next level-2 heading. */
function phase2aSection(): string {
  const start = doc.indexOf('## Phase 2a source log');
  if (start < 0) return '';
  const next = doc.indexOf('\n## ', start + 1);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
}

describe('docs/CLEAN_ROOM.md — Phase 2a source log', () => {
  it('has the Phase 2a section after the binding policy', () => {
    expect(doc.indexOf('## Policy')).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf('## Phase 2a source log')).toBeGreaterThan(doc.indexOf('## Policy'));
  });

  it('logs every src/dsp module and every Phase 2a tool', () => {
    const section = phase2aSection();
    const modules = readdirSync(new URL('src/dsp/', root))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/dsp/${f}`);
    expect(modules.length).toBeGreaterThan(0);
    const tools = ['tools/wav.ts', 'tools/segments.ts', 'tools/render.ts', 'tools/check-alloc.ts', 'tools/bench-dsp.ts'];
    for (const path of [...modules, ...tools]) expect(section, path).toContain(`\`${path}\``);
  });

  it('cites every source the phase 2a contract requires', () => {
    const section = phase2aSection();
    for (const source of [
      'Baldan',
      'Farnell',
      'Doerfler & Wyse',
      'Physical Audio Signal Processing',
      'Bristow-Johnson',
      'Larsen & R. M. Aarts',
      'ITU-R BS.1770',
      'Kaiser',
    ]) {
      expect(section, source).toContain(source);
    }
  });
});
```

- [ ] **Step 27: Run it and confirm it fails**

Run: `npx vitest run tests/unit/clean-room.test.ts`
Expected: FAIL (3 of 3) — `AssertionError: expected -1 to be greater than 280` (no Phase 2a section yet; 280 stands for the offset of `## Policy` in your file), then `AssertionError: src/dsp/analysis.ts: expected '' to contain …` and `AssertionError: Baldan: expected '' to contain 'Baldan'` (the section is empty).

- [ ] **Step 28: Append the Phase 2a source log to `docs/CLEAN_ROOM.md`**

Before appending, run `ls src/dsp` and confirm the files match the table's rows (add a row for any extra module, naming its algorithm and source). Then run:

```bash
cat >> docs/CLEAN_ROOM.md <<'MD'

## Phase 2a source log (DspCore + render tools)

All modules below are written from the cited papers, standards and books (methods only) or from first
principles. No code was copied from any source; nothing from the sources excluded by the policy above
was read.

| Module | Algorithm | Source |
|---|---|---|
| `src/dsp/util.ts` | Flush-to-zero of tiny recursive states, dB conversions, smoothstep, one-pole smoother y += k·(x − y), slew limiter; mulberry32 32-bit PRNG with a Box–Muller Gaussian (cached pair) | First principles; mulberry32 (T. Ettinger, 2017; reimplemented from its published description); G. E. P. Box & M. E. Muller, "A Note on the Generation of Random Normal Deviates", *Ann. Math. Statist.* 29(2), 1958 |
| `src/dsp/biquad.ts` | Biquad low-/high-/band-pass (constant 0 dB peak), shelves and peaking EQ, Direct Form I with float64 state; 4th-order Butterworth as two cascaded biquads (Q 0.5412, 1.3066) | R. Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients" (Audio EQ Cookbook, W3C Note); S. Butterworth, "On the Theory of Filter Amplifiers", *Experimental Wireless & the Wireless Engineer* 7, 1930 |
| `src/dsp/oversample.ts` | 4× polyphase interpolator: 48-tap windowed-sinc low-pass, Kaiser window β = 8, cutoff 0.45·fs | J. F. Kaiser, "Nonrecursive digital filter design using the I0-sinh window function", *Proc. IEEE ISCAS*, 1974; ITU-R BS.1770 Annex 2 (true-peak estimation by oversampling) |
| `src/dsp/delay.ts` | Fractional delay line with linear and 3rd-order Lagrange interpolation | T. I. Laakso, V. Välimäki, M. Karjalainen, U. K. Laine, "Splitting the unit delay", *IEEE Signal Processing Magazine* 13(1), 1996; J. O. Smith III, *Physical Audio Signal Processing*, W3K Publishing, 2010 |
| `src/dsp/waveguide.ts`, `src/dsp/junction.ts` | Bidirectional digital-waveguide tube section with one-pole wall loss (\|H\| ≤ 1); lossless N-port parallel scattering junction pJ = 2·Σ(Yᵢ·pᵢ⁺)/Σ(Yᵢ), pᵢ⁻ = pJ − pᵢ⁺; terminations by reflection coefficient | J. O. Smith III, *Physical Audio Signal Processing*, W3K Publishing, 2010 (digital waveguides, scattering junctions, passivity) |
| `src/dsp/exhaust.ts` | Passive exhaust network: headers → per-bank collectors → turbine 2-port → mid-pipe → side-branch muffler chambers → tailpipe → open end; gas-temperature-dependent speed of sound c = √(γRT); valve bypass as a convex combination of passive scattering matrices; radiation as a first-order high-pass (differentiator) outside every loop | S. Baldan, H. Lachambre, S. Delle Monache, P. Boussard, "Physically informed car engine sound synthesis for virtual and augmented environments", IEEE SIVE 2015 (methods only); J. O. Smith III, *Physical Audio Signal Processing* (passivity); first principles |
| `src/dsp/combustion.ts` | Double-precision crank-angle clock over cycleDeg (720 four-stroke, 1080 rotary), firing scheduler, blowdown pulse E(φ) = (1 − e^(−αφ))²·e^(−βφ)·taper(φ) with load-dependent sharpness and time-to-peak clamp, cycle-to-cycle timing/amplitude jitter, cycle asymmetry, per-entry DC blocker, intake gates, ignition impulses, skip masks | Baldan et al., SIVE 2015 (methods only); Doerfler & Wyse, PTR, arXiv 2603.07584 / 2603.09391 (pulse shaping and regime gating, paper only — CC BY-NC code and dataset not used); Bodden & Belschner, Inter-noise 2014 (cycle-to-cycle variation) |
| `src/dsp/rpm-state.ts` | One-pole rpm tracking, prescribed shift trajectory (cut window + cosine ease), rev-limiter cut/fire bounce | First principles (spec §5.3.7, §8.6) |
| `src/dsp/intake.ts`, `src/dsp/mechanical.ts` | Intake roar: noise band-passed at the Helmholtz frequency, gated by the intake windows and throttle; block thump (ignition impulses → 250 Hz low-pass); valvetrain ticks (decaying noise bursts → 3 kHz band-pass) | A. Farnell, *Designing Sound*, MIT Press 2010, engine chapter (text only; the Pd patches are not used); Baldan et al., SIVE 2015 |
| `src/dsp/forced.ts` | Turbo shaft-speed lag, whistle sines and band-passed whoosh ∝ boost, blow-off burst / compressor flutter on lift; supercharger whine order = pulleyRatio·gearRatio·(roots ? 2·lobes : lobes) | First principles; Farnell, *Designing Sound* (methods only) |
| `src/dsp/overrun.ts` | Overrun pops as a Poisson process (exponential inter-arrival times) with a decaying rate, raised-cosine-shaped bounded impulses injected into the exhaust; airflow noise | First principles; Doerfler & Wyse (combustion/overrun regime gating, methods only) |
| `src/dsp/perspective.ts` | Cabin (4th-order Butterworth low-pass, separate forced-induction bus) vs outside mix; mono-compatible ±0.08 mid/side decorrelation via a 0.7 ms delay | First principles; Audio EQ Cookbook (filters) |
| `src/dsp/output-stage.ts` | Trim ramp, NaN guard, DC blocker, bass management (4th-order Butterworth high-pass or 22 Hz infrasonic high-pass), NLD virtual bass (Chebyshev T2 + T3 on the envelope-normalised removed band), linked soft-knee compressor, look-ahead true-peak limiter with 4× oversampled detection, hard clip | E. Larsen & R. M. Aarts, "Reproducing low-pitched signals through small loudspeakers", *J. Audio Eng. Soc.* 50(3), 2002; D. Giannoulis, M. Massberg, J. D. Reiss, "Digital Dynamic Range Compressor Design — A Tutorial and Analysis", *J. Audio Eng. Soc.* 60(6), 2012 (soft-knee gain computer); ITU-R BS.1770 Annex 2 (true peak) |
| `src/dsp/analysis.ts` | In-place radix-2 FFT, symmetric Hann window, Hann-windowed Goertzel order spectrum, true peak via the shared 4× upsampler, RMS and band energy (Parseval) | J. W. Cooley & J. W. Tukey, "An algorithm for the machine calculation of complex Fourier series", *Math. Comp.* 19, 1965; G. Goertzel, "An Algorithm for the Evaluation of Finite Trigonometric Series", *Amer. Math. Monthly* 65(1), 1958; F. J. Harris, "On the use of windows for harmonic analysis with the discrete Fourier transform", *Proc. IEEE* 66(1), 1978; ITU-R BS.1770 Annex 2 |
| `src/dsp/dsp-core.ts` | Per-quantum control (gas-speed slews, regime crossfade, valve), per-sample chain, configure fades, non-finite reset | First principles (spec §5.3) |
| `tools/wav.ts` | RIFF/WAVE writer (32-bit IEEE float with `fact` chunk) and reader (16/24/32-bit PCM, 32-bit float, WAVE_FORMAT_EXTENSIBLE) | Microsoft & IBM, *Multimedia Programming Interface and Data Specifications 1.0*, 1991; Microsoft, WAVEFORMATEXTENSIBLE documentation |
| `tools/segments.ts`, `tools/render.ts` | Render segments (kinematic rpm profiles, constant vehicle acceleration per gear) and the `tesbox-render` CLI | First principles (spec §11.1) |
| `tools/check-alloc.ts`, `tools/bench-dsp.ts` | GC-pause gate from `perf_hooks` GC entries; realtime-factor benchmark | Node.js `perf_hooks` and `inspector` documentation; first principles |
MD
```

- [ ] **Step 29: Run the clean-room log test and confirm it passes**

Run: `npx vitest run tests/unit/clean-room.test.ts tests/unit/repo-files.test.ts`
Expected: PASS (3 tests in `clean-room.test.ts`, plus Phase 0's repo-files test unchanged — its privacy scan finds no IP literals in the appended text).

- [ ] **Step 30: Full phase verification**

Run, in order:

```bash
npm run verify
npm run check:alloc
npm run bench:dsp
npm run render -- i5-test --segments liftoff6k,limiterHold --perspective outside --subwoofer no --out renders/
```

Expected: `npm run verify` (lint, typecheck, the whole Vitest suite incl. every `dsp-*.test.ts` and the invariants, `vite build`, Playwright e2e) exits 0; `check:alloc` prints `check-alloc: OK`; `bench:dsp` exits 0; the render prints two `wrote …` lines with true peaks ≤ −1.00 dBTP and `non-finite resets 0`. The whole Vitest suite should stay well inside the CI budget (≈ 30 s locally for Phase 2a's files). Do not commit here — Phase 2a lands as one verified commit after this step.

- [ ] **Step 31: Lint and typecheck (final gate)**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0.

---
