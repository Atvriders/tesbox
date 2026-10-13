# Tesbox Phase 1 — Contracts, Data Spec + SimCore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the environment-free vehicle simulation (GPS speed filter, load estimator, gearbox, driveline, demo physics, `TesboxSimCore`) and the sourced data layer (15 engine specs, full Tesla catalogue with fitted parameters), all unit-tested.

**Architecture:** Pure TypeScript in `src/sim/` and `src/data/`, zero-allocation hot paths, driven per audio quantum in worklet time; data validated by JSON Schema (ajv) and generated parameters checked by `tools/build-catalogue.ts --check`.

**Tech Stack:** TypeScript 6.0, Vitest 5, ajv 8, tsx.

**Spec:** `docs/superpowers/specs/2026-10-06-tesbox-design.md` (§4.2–4.5, §5.1–5.2, §5.5, §8, §9, §14, §15 Phase 1)

## Global Constraints

The locked contract `docs/superpowers/plans/contracts/phase1-contract.md` (including **Amendments A1–A9**) and `src/contracts.ts` are part of every task's requirements. Key lines:

- Hot-path methods never allocate; outputs are fields mutated in place; stateful logic has multi-call tests.
- Gears 1-based; time in worklet seconds; SI units.
- Criterion (a): speed path p95 ≤ 2.2 s, position-only path p95 ≤ 3.0 s (A1).
- Data: every engine `spec` field group sourced; nothing from rupteur.app or repos referencing it.
- No per-task commits — Phase 1 lands as one verified commit.
- Every deviation from, extension of, or proposed amendment to the locked contract is listed under **Concerns** below; report that list to the contract owner before execution.

## Review Focus

1. Out-of-order or repeated cached fix → rejected, v does not move. (Task 2)
2. Intel trace with speed 0 while moving → SPEED_UNUSABLE latches (A2) and v tracks truth via position. (Tasks 2, 3)
3. 35 s tunnel → PREDICTING after 2 s, no snap to 0, GPS_LOST after 20 s, eased to 0 by 30 s. (Task 2)
4. Paddle spam during an active shift → ignored until it completes; no overlapping shifts. (Task 5)
5. Source switch demo↔gps mid-run → rpm never jumps > 50 rpm/quantum except via shift/limiter. (Task 8)

## Execution order (dependency waves)

W1: Tasks 1, 2 → W2: Tasks 3, 4, 5, 9 → W3: Tasks 6, 7, 10 (research, parallel per engine — Task 10 Step 8) → W4: Tasks 8, 11 (research + tool; its Steps 13–21 run one after another — Task 11 Step 12) → W5: Task 12.

Every task's imports and premises point to an earlier wave: Task 3 needs Task 2's filter; Task 4's test needs Task 1's `epa.ts`; Tasks 6 and 7 need Task 5's `tests/helpers/sim-fixtures.ts`, and Task 7 Task 4's `load.ts`; Task 9 needs Task 1's `tyre.ts`; Task 10 needs Task 9 and runs Task 5's `shift-map.test.ts`; Task 11 needs Task 7's `demo.ts`; Task 8 needs Tasks 1–7 and runs after all 15 engine JSONs exist. Strictly sequential execution (Tasks 1 → 12) is also valid.

Parallel tasks share the working tree:
- Inside a wave, each implementer verifies only with `npx vitest run <the test files named in its own steps>`. The whole-project `npm run lint && npm run typecheck` steps (and Task 5 Step 2's `tsc`) run once, after every task of the wave is done; a TS2307 (or lint error) that points at another in-flight task's file is not this task's failure.
- Run Task 9 Step 1 (`npm install --save-dev ajv@^8.20.0`) before the other tasks of W2 start: it rewrites `node_modules`, which the others' Vitest/ESLint runs read (ESLint depends on ajv too, and hoisting can move it).
- Equivalent alternative: give each parallel task its own git worktree and merge at the end of the wave.

## Concerns (contract deviations — report to the contract owner before execution)

The contract is LOCKED. Each item below either proposes an amendment (not implemented until approved) or is a deviation/extension the plan implements; an item the owner rejects is changed in its task before that task runs. Tasks cite these items as "plan header Concerns PCn".

Proposed amendments (need approval; the plan code does NOT implement them):
- **PC1 — GPS-path load (proposed A10; Tasks 2, 8).** SimCore feeds `LoadEstimator` the filter output `a = a_k·e^(−τ/τa)` with `τ = nowS + outputLatencyS − tK` ≥ fix age + 0.1 s (≈ 1.1 s when a fix arrives, ≈ 2.1 s just before the next one), so on gps/replay only 3–16 % of the estimated acceleration reaches `rawLoad`. Measured with the plan code on `highway-amd` (DCT7, MID_TESLA): max `out.load` 0.19 during the 3.3 → 2 m/s² pull (true ≈ 0.46), auto upshifts at 2 000–3 400 rpm with load ≤ 0.09, min load ≥ 0 and no OVERRUN quantum on the 36 → 30 m/s lift-off (true ≈ −0.12). On real GPS the A4 kickdown, the WOT schedule (load ≥ 0.8) and overrun therefore never happen — against spec §1.1 goal 1, §5.3.3/§5.3.9, §8.5, §8.6. Options, both measured on the same run and both keeping every existing speed-filter and sim-core test green: (a) `SpeedFilter.aLoad` = `standstill ? 0 : a_k·e^(−max(0, nowS − lastArrivalS)/τa)` (posterior acceleration decayed from the fix ARRIVAL, set allocation-free in `evaluate`) → max load 0.557, min −0.093, 335 OVERRUN quanta; (b) `SpeedFilter.aPost` = the posterior `x[2]` at tK (0 while standstill) → max 0.832, min −0.251, 3 318 OVERRUN quanta. Once approved: add the getter with a multi-call test (Task 2), use it instead of `filter.a` on gps/replay (Task 8 Step 5), and add a Task 8 `highway-amd` test — max `out.load` over 4–16 s > 0.35 and at least one OVERRUN quantum over 48–57 s (measured: 0.438 and 317 quanta with option (a), 0.131 and 0 with the plan code).
- **PC2 — Torque-converter unlock on the A4 kickdown (Task 6).** The contract unlocks the converter at `load > 0.9` ("kickdown"), but A4 moved the gearbox kickdown to `load > 0.6 && loadRate > 1.2`, so kickdowns at load 0.6–0.9 happen with the converter locked (no flare). Proposal: `DrivelineModel` sets a `kickdownHold` when the gear drops while load > 0.6 (cleared at load ≤ 0.6), which clears the lock-up command and blocks re-lock; TC8 test: locked in 4th at load 0.3, then a 3rd-gear step at load 0.7 leaves `engaged` with the rpm ramping to the unlocked curve over 0.4 s.

Deviations and extensions the plan implements (approve, or send back to the task):
- **PC3 — Task 2:** a fix measured more than 60 s after `tK` re-seeds the state (`s = s_meas`, `v` = usable speed or 0, `a = 0`, `P = diag(25, 1e4, 4)`) instead of the contract's prediction across the gap; over hours `q·Δ⁵/20` reaches ~1e16 m² and the non-Joseph update made `P` non-PSD (`P[0] = −256 m²` after a 2 h gap, position-only).
- **PC4 — Task 5:** `Gearbox.reset()` beyond the contract (SimCore calls it at ignition on/off).
- **PC5 — Task 5:** Auto over-speed skip-shift: when the current gear turns ≥ redline (never while predicting, in Manual or during an override), ONE upshift straight to the lowest gear below its own upshift point (or the top gear), without the minimum time in gear — the contract applies the 1.5 s minimum whenever load < 0.8 and implies one gear per upshift. With one gear per shift the RF3 tunnel exit drove the engine to ≈ 6 500 rpm in 2nd and needed 8 s (1.6 s per gear) to reach 7th.
- **PC6 — Task 5:** the Auto paddle override suspends the map downshift and kickdown as well as auto-upshifts; only the coast-down (anti-lug) downshift still applies.
- **PC7 — Task 5:** paddle legality is identical in Auto and Manual (an over-rev downshift is refused with `SHIFT_REFUSED`, no override).
- **PC8 — Task 6:** idle wander `20·(0.7·sin(2π·0.5·t + φ₁) + 0.3·sin(2π·0.21·t + φ₂))` adds a 0.21 Hz component (contract: 0.5 Hz).
- **PC9 — Task 6:** a launch is re-armed whenever load ≤ 0.1 or the clutch opens (contract: "first … after standstill"); a launch the wheels never catch returns to `clutch-open` (the timer never forces lock).
- **PC10 — Task 7:** the DEMO_PROFILE lift-off uses brake 0.1 (regen stand-in): with the contract's force balance a throttle-0 coast reads load exactly 0, so its "lift-off/overrun" phase could never produce overrun.
- **PC11 — Task 8:** GPS-health bits (`GPS_LOST | PREDICTING | SPEED_UNUSABLE`) are reported whatever the source (demo/keyboard included); members beyond the `SimCore` interface: `setWarm`, `setTuning`, `fixesAccepted`, `fixesRejected`; a shift start snaps `out.rpm` only in the shift's physical direction (else it slews).
- **PC12 — Task 11:** rollout `+0.25 s` whenever `rolloutSubtracted`, for either accel basis (the contract names it with the 0–60 mph target); a fit that misses the published time even at `F_trac = 1.3·m·G` and 3× peak power keeps `F_trac = 1.3·m·G`, `P_eff` = peak and warns instead of throwing (not covered by the contract).
- **PC13 — Task 12:** the one-line `NOTICES` edit (Ajv) is outside the Phase 1 file map.

---

### Task 1: Tyre geometry and EPA road-load conversion

**Files:**
- Create: `src/sim/tyre.ts`
- Create: `src/sim/epa.ts`
- Test: `tests/unit/tyre.test.ts`
- Test: `tests/unit/epa.test.ts`

**Interfaces:**
- Consumes:
  - `EPA_TO_SI` from `src/contracts.ts`: `{ A: 4.448222, B: 9.9504, C: 22.2583 } as const`.
- Produces:
  - `src/sim/tyre.ts`:
    - `export interface Tyre { widthMm: number; aspectPct: number; rimIn: number }`
    - `export function parseTyre(code: string): Tyre` — accepts exactly an optional `P`, 3-digit width, `/`, 2-digit aspect, an optional single space, an optional `Z`, `R`, 2-digit rim (`"265/30R19"`, `"265/30 R19"`, `"265/30ZR19"`, `"P245/45R18"`); throws `Error` on anything else (load index / speed rating suffix such as `"265/30R19 91Y"`, lowercase, half-inch rims, padding, zero dimensions).
    - `export function rollingCircumferenceM(code: string): number` — `π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97` metres; throws via `parseTyre`. Call at configure time only (allocates).
    - `export function wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number` — `speed / C × ratio × 60`; pure arithmetic, allocation-free, no guards (safe in `step`).
  - `src/sim/epa.ts`:
    - `export interface EpaTarget { A_lbf: number; B_lbf_per_mph: number; C_lbf_per_mph2: number }`
    - `export function epaToSi(t: EpaTarget): { A_N: number; B_Nps_m: number; C_Ns2_m2: number }` — multiplies by `EPA_TO_SI.A/B/C`; negative B stays negative; returns a new object (build/configure time only).

**Cross-task premises:**
- Phase 0 T1 toolchain exists: open `vite.config.ts` and confirm Vitest `test.include` is `['tests/unit/**/*.test.ts']` with `environment: 'node'`; open `tsconfig.json` and confirm `strict`, `noUncheckedIndexedAccess`, `isolatedModules`, `types: ["vite/client", "node"]` and that `src` and `tests` are included; open `package.json` and confirm the `lint` and `typecheck` scripts.
- Open `src/contracts.ts` and confirm `EPA_TO_SI` is exactly `{ A: 4.448222, B: 9.9504, C: 22.2583 }` (the EPA test checks these against the exact lbf and mph definitions to 1e-5).
- Later tasks call these names exactly: T5/T8 (`rollingCircumferenceM` at configure, `wheelRpm` per step), T10 (EPA N/V data test), T11 (`epaToSi` in `tools/build-catalogue.ts`), T4 (`tests/unit/load.test.ts` imports `epaToSi`). T9/T10 engine `drivenTyre` strings must use one of the accepted spellings (no load index or speed rating).

- [ ] **Step 1: Write the failing tyre test**

Create `tests/unit/tyre.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTyre, rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';

describe('parseTyre', () => {
  it('parses the plain ISO form', () => {
    expect(parseTyre('265/30R19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
  });

  it('accepts a space before R, a Z speed marker and a P prefix', () => {
    expect(parseTyre('265/30 R19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
    expect(parseTyre('265/30ZR19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
    expect(parseTyre('P245/45R18')).toEqual({ widthMm: 245, aspectPct: 45, rimIn: 18 });
  });

  it.each([
    '',
    '265/30R',
    '265-30R19',
    '265/30R19 91Y',
    ' 265/30R19',
    '265/30r19',
    '265/30D19',
    '31x10.50R15',
    '265/30R19.5',
    '000/30R19',
    '265/00R19',
    '265/30R00',
  ])('throws on %j', (code) => {
    expect(() => parseTyre(code)).toThrow(Error);
  });
});

describe('rollingCircumferenceM', () => {
  it('matches the hand-computed value for 265/30R19', () => {
    // diameter = 2·265·0.30 + 19·25.4 = 159 + 482.6 = 641.6 mm
    // C = π·0.6416·0.97 = 1.955176… m
    expect(rollingCircumferenceM('265/30R19')).toBeCloseTo(Math.PI * 0.6416 * 0.97, 12);
    expect(rollingCircumferenceM('265/30R19')).toBeCloseTo(1.955176, 6);
  });

  it('is identical for every accepted spelling of the same size', () => {
    const c = rollingCircumferenceM('245/45R18');
    expect(rollingCircumferenceM('245/45 R18')).toBe(c);
    expect(rollingCircumferenceM('245/45ZR18')).toBe(c);
    expect(rollingCircumferenceM('P245/45R18')).toBe(c);
  });

  it('propagates parse errors', () => {
    expect(() => rollingCircumferenceM('not a tyre')).toThrow(Error);
  });
});

describe('wheelRpm', () => {
  it('is speed / C × ratio × 60', () => {
    expect(wheelRpm(30, 3, 2)).toBeCloseTo(2700, 12);
    expect(wheelRpm(0, 3, 2)).toBe(0);
  });

  it('gives the expected N/V for a known tyre and overall ratio', () => {
    // 1 mph = 0.44704 m/s; 265/30R19 with an overall ratio of 2.5 → rpm per mph
    const c = rollingCircumferenceM('265/30R19');
    const nv = wheelRpm(0.44704, 2.5, c);
    expect(nv).toBeCloseTo((0.44704 / c) * 2.5 * 60, 12);
    expect(nv).toBeCloseTo(34.2966, 3);
  });

  it('scales linearly with speed and ratio', () => {
    const c = rollingCircumferenceM('225/40R18');
    expect(wheelRpm(20, 4, c)).toBeCloseTo(2 * wheelRpm(10, 4, c), 9);
    expect(wheelRpm(20, 4, c)).toBeCloseTo(2 * wheelRpm(20, 2, c), 9);
  });
});
```

- [ ] **Step 2: Run the tyre test to see it fail**

```bash
npx vitest run tests/unit/tyre.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/tyre' imported from …/tests/unit/tyre.test.ts` (suite fails to load, 0 tests run).

- [ ] **Step 3: Implement `src/sim/tyre.ts`**

```ts
/** ISO metric tyre code parsing and rolling geometry (spec §8.3). */

export interface Tyre {
  widthMm: number;
  aspectPct: number;
  rimIn: number;
}

/**
 * Accepted forms: "265/30R19", "265/30 R19", "265/30ZR19", "P245/45R18" (optional "P" prefix,
 * optional single space before the construction letter, optional "Z" speed marker, radial "R").
 * Anything else (load index, lowercase, inch sizes, half-inch rims, whitespace padding) throws.
 */
const TYRE_CODE = /^P?(\d{3})\/(\d{2})( ?)(Z?)R(\d{2})$/;

/** Dynamic rolling radius factor: loaded/rolling circumference ≈ 0.97 × unloaded (spec §8.3). */
const ROLLING_FACTOR = 0.97;

export function parseTyre(code: string): Tyre {
  const m = TYRE_CODE.exec(code);
  if (m === null) {
    throw new Error(`Unrecognised tyre code "${code}" (expected e.g. 265/30R19)`);
  }
  const widthMm = Number(m[1]);
  const aspectPct = Number(m[2]);
  const rimIn = Number(m[5]);
  if (!(widthMm > 0 && aspectPct > 0 && rimIn > 0)) {
    throw new Error(`Tyre code "${code}" has a zero dimension`);
  }
  return { widthMm, aspectPct, rimIn };
}

/** C_dyn = π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97, metres. */
export function rollingCircumferenceM(code: string): number {
  const t = parseTyre(code);
  const diameterMm = (2 * t.widthMm * t.aspectPct) / 100 + t.rimIn * 25.4;
  return ((Math.PI * diameterMm) / 1000) * ROLLING_FACTOR;
}

/** Engine-side rpm for a road speed: speed / C × overallRatio × 60. Allocation-free. */
export function wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number {
  return (speedMps / circumferenceM) * overallRatio * 60;
}
```

- [ ] **Step 4: Run the tyre test to see it pass**

```bash
npx vitest run tests/unit/tyre.test.ts
```

Expected: PASS — `Tests  20 passed (20)`.

- [ ] **Step 5: Write the failing EPA test**

Create `tests/unit/epa.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EPA_TO_SI } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';

const LBF_N = 4.4482216152605; // exact definition of the pound-force
const MPH_MPS = 0.44704; // exact definition of the mile per hour

describe('epaToSi', () => {
  it('multiplies each coefficient by the contract constant', () => {
    expect(epaToSi({ A_lbf: 1, B_lbf_per_mph: 1, C_lbf_per_mph2: 1 })).toEqual({
      A_N: EPA_TO_SI.A,
      B_Nps_m: EPA_TO_SI.B,
      C_Ns2_m2: EPA_TO_SI.C,
    });
  });

  it('keeps a negative B coefficient negative', () => {
    const si = epaToSi({ A_lbf: 30, B_lbf_per_mph: -0.12, C_lbf_per_mph2: 0.017 });
    expect(si.B_Nps_m).toBeCloseTo(-0.12 * 9.9504, 9);
    expect(si.B_Nps_m).toBeLessThan(0);
  });

  it('agrees with the exact unit definitions to 1e-5 relative', () => {
    expect(EPA_TO_SI.A / LBF_N).toBeCloseTo(1, 5);
    expect(EPA_TO_SI.B / (LBF_N / MPH_MPS)).toBeCloseTo(1, 5);
    expect(EPA_TO_SI.C / (LBF_N / (MPH_MPS * MPH_MPS))).toBeCloseTo(1, 5);
  });

  it('reproduces a hand-computed road-load force at 100 km/h (illustrative coefficients)', () => {
    // Illustrative EPA Target row (not a real vehicle): A 30 lbf, B 0.2 lbf/mph, C 0.015 lbf/mph².
    // 100 km/h = 27.7778 m/s = 62.1371 mph
    // F = 30 + 0.2·62.1371 + 0.015·62.1371² = 30 + 12.4274 + 57.9152 = 100.3426 lbf = 446.35 N
    const t = { A_lbf: 30, B_lbf_per_mph: 0.2, C_lbf_per_mph2: 0.015 };
    const si = epaToSi(t);
    const v = 100 / 3.6;
    const fSi = si.A_N + si.B_Nps_m * v + si.C_Ns2_m2 * v * v;
    const mph = v / MPH_MPS;
    const fImperialN = (t.A_lbf + t.B_lbf_per_mph * mph + t.C_lbf_per_mph2 * mph * mph) * LBF_N;
    expect(fSi / fImperialN).toBeCloseTo(1, 5);
    expect(fSi).toBeCloseTo(446.35, 1);
  });
});
```

- [ ] **Step 6: Run the EPA test to see it fail**

```bash
npx vitest run tests/unit/epa.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/epa' imported from …/tests/unit/epa.test.ts`.

- [ ] **Step 7: Implement `src/sim/epa.ts`**

```ts
import { EPA_TO_SI } from '../contracts';

/** EPA Test Car List *Target* road-load coefficients in their published units (spec §8.5). */
export interface EpaTarget {
  A_lbf: number;
  B_lbf_per_mph: number;
  C_lbf_per_mph2: number;
}

/** Converts EPA Target A/B/C (lbf, lbf/mph, lbf/mph²) to SI (N, N·s/m, N·s²/m²). Negative B allowed. */
export function epaToSi(t: EpaTarget): { A_N: number; B_Nps_m: number; C_Ns2_m2: number } {
  return {
    A_N: t.A_lbf * EPA_TO_SI.A,
    B_Nps_m: t.B_lbf_per_mph * EPA_TO_SI.B,
    C_Ns2_m2: t.C_lbf_per_mph2 * EPA_TO_SI.C,
  };
}
```

- [ ] **Step 8: Run both tests to see them pass**

```bash
npx vitest run tests/unit/tyre.test.ts tests/unit/epa.test.ts
```

Expected: PASS — `Test Files  2 passed (2)`, `Tests  24 passed (24)`.

- [ ] **Step 9: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both commands exit 0 and print no diagnostics (only the npm script banners). (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 2: SpeedFilter — 3-state Kalman with prediction, standstill, dropout and speed-unusable latch

**Files:**
- Create: `src/sim/speed-filter.ts`
- Test: `tests/unit/speed-filter.test.ts`

**Interfaces:**
- Consumes:
  - `haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number` from `src/platform/geo.ts` (Phase 0 T5, R = 6371008.8 m).
  - From `src/contracts.ts`: `F`, `DEFAULT_SIM_TUNING`, `type FixMsg`, `type SimTuning`.
- Produces (`src/sim/speed-filter.ts`):
  - `export class SpeedFilter` with exactly these public members:
    - `constructor(tuning?: SimTuning)` — default `DEFAULT_SIM_TUNING`; allocates its `Float64Array`s once.
    - `configure(tuning: SimTuning): void` — copies `kalmanQ`, `tauA`, `outputLatencyS`; keeps the filter state (`gpsLatencyS` is unused here: `fix.ageS` already includes it).
    - `reset(): void` — clears state, `hasFix`, `fixesAccepted`, `fixesRejected` and the SPEED_UNUSABLE latch; keeps the hidden flag.
    - `accept(fix: FixMsg, nowS: number): boolean` — spec §8.2 steps 1–3; never retains `fix` (callers may reuse one `FixMsg` object).
    - `evaluate(nowS: number): void` — §8.2 steps 4–6; updates `v`, `a`, `flags`.
    - `setHidden(hidden: boolean): void` — sets/clears `F.HIDDEN_HOLD` immediately (also re-applied by every `evaluate`).
    - read-only getters `v: number` (m/s, ≥ 0), `a: number` (m/s²), `flags: number`, `fixesAccepted: number`, `fixesRejected: number`, `hasFix: boolean`.
  - Observable behaviour later tasks rely on: before the first fix `flags === F.GPS_LOST | F.STANDSTILL` (| `HIDDEN_HOLD` when hidden) and `v = a = 0`; while standing `STANDSTILL` is set and `v = a = 0`; `PREDICTING` stays set while `GPS_LOST`; a reported speed 0 follows contract A2 (`SPEED_UNUSABLE` latches on the 3rd consecutive moving zero); position jitter below `0.4·accuracyM` per fix is ignored while `v < 1.5 m/s` (A3); a fix measured more than 60 s after the previous accepted one re-seeds the state instead of predicting across the gap (plan header Concerns PC3); `accept`/`evaluate` never allocate.

**Cross-task premises:**
- Open `src/platform/geo.ts` (Phase 0 T5) and confirm the argument order `(lat1, lon1, lat2, lon2)`, R = 6371008.8 m, and that it is pure `Math` (no allocation). The tests place fake fixes on the equator at `lon = s / (6371008.8·π/180)` so that haversine distances equal `s`; a different R breaks the tight tracking assertions.
- Open `src/contracts.ts` and confirm `DEFAULT_SIM_TUNING = { gpsLatencyS: 1.0, kalmanQ: 2, tauA: 0.6, outputLatencyS: 0.1 }` and the `F` bit values; the tests use `tauA` and the 0.1 s output latency numerically (e.g. `e^(−1.1/0.6)`).
- Open `docs/superpowers/plans/contracts/phase1-contract.md` § Amendments: A2 (zero-speed rule) and A3 (standstill position deadband) override the contract body's 3–5 s window rule; this task implements A2/A3, not the superseded rule.
- T3 (replay fixtures, criterion (a)) asserts numbers measured against exactly this implementation; T8 (SimCore) consumes `configure`, `accept`, `evaluate`, `setHidden`, `v`, `a`, `flags`, and forwards `fixesAccepted`/`fixesRejected` as getters.
- Phase 2a adds an ESLint rule banning `new`, array/object literals, closures, spread, template literals and `try`/`throw` inside `step|accept|evaluate|update|tick|next|request` in `src/sim/**`; this file already complies (its private helpers too) — keep it that way.

- [ ] **Step 1: Write the failing test, part 1 (helpers, lifecycle, accept/reject, RF1)**

Create `tests/unit/speed-filter.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING, F } from '../../src/contracts';
import type { FixMsg } from '../../src/contracts';
import { SpeedFilter } from '../../src/sim/speed-filter';

/** Metres per degree of longitude on the equator for haversineM's R = 6371008.8 m (exact distances). */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

function fixAt(sM: number, speedMps: number | null, ageS = 1, accuracyM = 5): FixMsg {
  return { type: 'fix', ageS, speedMps, lat: 0, lon: sM / M_PER_DEG, accuracyM, altitudeM: null };
}

/**
 * Feeds noise-free fixes measured at integer seconds k = k0..k1 (arrival k + 1, ageS 1) for a truth
 * position function and speed reading, at the given accuracy. Returns the arrival time of the last fix.
 */
function feed(
  f: SpeedFilter,
  k0: number,
  k1: number,
  posAt: (t: number) => number,
  speedAt: (t: number) => number | null,
  accuracyM = 5,
): number {
  let arrival = 0;
  for (let k = k0; k <= k1; k++) {
    arrival = k + 1;
    expect(f.accept(fixAt(posAt(k), speedAt(k), 1, accuracyM), arrival)).toBe(true);
    f.evaluate(arrival);
  }
  return arrival;
}

describe('SpeedFilter — before the first fix', () => {
  it('reports GPS_LOST | STANDSTILL with v = a = 0 on every evaluate', () => {
    const f = new SpeedFilter();
    for (const now of [0, 1, 50]) {
      f.evaluate(now);
      expect(f.v).toBe(0);
      expect(f.a).toBe(0);
      expect(f.flags).toBe(F.GPS_LOST | F.STANDSTILL);
      expect(f.hasFix).toBe(false);
    }
    expect(f.fixesAccepted).toBe(0);
    expect(f.fixesRejected).toBe(0);
  });
});

describe('SpeedFilter — first fix', () => {
  it('initialises v from a usable speed and leaves standstill', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, 12), 10)).toBe(true);
    f.evaluate(10);
    expect(f.hasFix).toBe(true);
    expect(f.fixesAccepted).toBe(1);
    expect(f.v).toBeCloseTo(12, 12);
    expect(f.a).toBe(0);
    expect(f.flags & (F.GPS_LOST | F.STANDSTILL | F.PREDICTING)).toBe(0);
  });

  it('initialises v = 0 when speed is missing and stays in standstill', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, null), 10)).toBe(true);
    f.evaluate(10.5);
    expect(f.v).toBe(0);
    expect(f.flags).toBe(F.STANDSTILL);
  });
});

describe('SpeedFilter — accept/reject (§8.2 step 1)', () => {
  it.each<[string, Partial<FixMsg>]>([
    ['age > 3 s', { ageS: 3.01 }],
    ['non-finite age', { ageS: Number.NaN }],
    ['NaN lat', { lat: Number.NaN }],
    ['infinite lon', { lon: Number.POSITIVE_INFINITY }],
    ['zero accuracy', { accuracyM: 0 }],
    ['negative accuracy', { accuracyM: -3 }],
    ['NaN accuracy', { accuracyM: Number.NaN }],
  ])('rejects a fix with %s and counts it', (_label, patch) => {
    const f = new SpeedFilter();
    expect(f.accept({ ...fixAt(0, 10), ...patch }, 5)).toBe(false);
    expect(f.accept({ ...fixAt(0, 10), ...patch }, 6)).toBe(false);
    expect(f.fixesRejected).toBe(2);
    expect(f.fixesAccepted).toBe(0);
    expect(f.hasFix).toBe(false);
  });

  it('accepts age exactly 3 s', () => {
    const f = new SpeedFilter();
    expect(f.accept(fixAt(0, 10, 3), 5)).toBe(true);
  });

  it('RF1: rejects out-of-order and repeated cached fixes without moving v or the dropout timer', () => {
    const test = new SpeedFilter();
    const control = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    const spd = () => 15;
    feed(test, 0, 4, pos, spd); // last accepted: measured 4, arrived 5 → tK = 4
    feed(control, 0, 4, pos, spd);

    // Out of order: measured 3.5, delivered 5.5 (tFix 3.5 < tK).
    expect(test.accept(fixAt(pos(3.5), 15, 2.0), 5.5)).toBe(false);
    // Repeated cached fix: the measurement from t = 4 again, now 1.6 s old (tFix = tK).
    expect(test.accept(fixAt(pos(4), 15, 1.6), 5.6)).toBe(false);
    // Within 0.05 s of tK (tFix = 4.04).
    expect(test.accept(fixAt(pos(4.04), 15, 1.66), 5.7)).toBe(false);
    // A wild position in a rejected fix must not leak into the state.
    expect(test.accept(fixAt(99999, 80, 1.7), 5.7)).toBe(false);

    expect(test.fixesRejected).toBe(4);
    expect(test.fixesAccepted).toBe(control.fixesAccepted);
    for (const now of [5.7, 6.5, 7.1]) {
      test.evaluate(now);
      control.evaluate(now);
      expect(test.v).toBe(control.v);
      expect(test.a).toBe(control.a);
      expect(test.flags).toBe(control.flags);
    }
    // Last ACCEPTED arrival was 5.0 → PREDICTING after 7.0 although rejected fixes arrived at 5.5–5.7.
    expect(test.flags & F.PREDICTING).toBe(F.PREDICTING);

    // The next genuine fix (measured 6.0, delivered 7.2) is accepted again.
    expect(test.accept(fixAt(pos(6), 15, 1.2), 7.2)).toBe(true);
  });
});
```

- [ ] **Step 2: Append part 2 (tracking, prediction, zero-speed rule A2 incl. RF2, standstill deadband A3)**

Append to the end of `tests/unit/speed-filter.test.ts`, after one blank line:

```ts
describe('SpeedFilter — tracking', () => {
  it('tracks a constant speed exactly with speed measurements present', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 12, (t) => 20 * t, () => 20);
    f.evaluate(arrival);
    expect(f.v).toBeCloseTo(20, 2);
    expect(Math.abs(f.a)).toBeLessThan(0.02);
    expect(f.flags).toBe(0);
  });

  it('tracks a constant speed from positions alone (speed null)', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 20, (t) => 15 * t, () => null);
    f.evaluate(arrival);
    expect(Math.abs(f.v - 15)).toBeLessThan(0.3);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('treats speed %s exactly like a missing speed', (bad) => {
    const test = new SpeedFilter();
    const control = new SpeedFilter();
    feed(test, 0, 8, (t) => 10 * t, (t) => (t === 0 ? 10 : bad));
    feed(control, 0, 8, (t) => 10 * t, (t) => (t === 0 ? 10 : null));
    test.evaluate(9.3);
    control.evaluate(9.3);
    expect(test.v).toBe(control.v);
    expect(test.a).toBe(control.a);
  });

  it('predicts with saturating acceleration: v(∞) − v(τ) = τa·a(τ) and a decays', () => {
    const f = new SpeedFilter();
    // Constant 2 m/s² from 4 m/s, speed present, noise-free.
    const arrival = feed(f, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    f.evaluate(arrival);
    const v1 = f.v;
    const a1 = f.a;
    // τ = 0.1 s output latency + 1 s fix age → a = a_k·e^(−1.1/0.6) with a_k ≈ 2 m/s².
    expect(a1).toBeCloseTo(2 * Math.exp(-1.1 / DEFAULT_SIM_TUNING.tauA), 2);
    let prev = v1;
    for (let now = arrival; now <= arrival + 1.9; now += 0.1) {
      f.evaluate(now);
      expect(f.v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f.v;
    }
    f.evaluate(arrival + 15); // τ ≫ τa (PREDICTING, not lost)
    expect(f.flags & F.GPS_LOST).toBe(0);
    expect(f.a).toBeLessThan(1e-9);
    expect(f.v - v1).toBeCloseTo(DEFAULT_SIM_TUNING.tauA * a1, 9);
  });

  it('honours outputLatencyS from configure() without resetting the state', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    f.evaluate(arrival);
    const vDefault = f.v;
    f.configure({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.6 });
    expect(f.hasFix).toBe(true);
    f.evaluate(arrival);
    expect(f.v).toBeGreaterThan(vDefault);
    // Same as evaluating 0.5 s later with the default latency.
    const g = new SpeedFilter();
    feed(g, 0, 12, (t) => 4 * t + t * t, (t) => 4 + 2 * t);
    g.evaluate(arrival + 0.5);
    expect(f.v).toBeCloseTo(g.v, 12);
  });
});

describe('SpeedFilter — zero speed (§8.2 step 2, contract A2)', () => {
  it('A2: a zero with d1 < 3 m is a measurement at once and pulls v into standstill', () => {
    const zero = new SpeedFilter();
    const none = new SpeedFilter();
    // Creeping at 2.5 m/s with the speed reported, then the receiver reports 0 (d1 = 2.5 m < 3 m).
    feed(zero, 0, 3, (t) => 2.5 * t, () => 2.5);
    feed(none, 0, 3, (t) => 2.5 * t, () => 2.5);
    feed(zero, 4, 4, (t) => 2.5 * t, () => 0);
    feed(none, 4, 4, (t) => 2.5 * t, () => null);
    expect(zero.v).toBeLessThan(none.v); // used on the very first zero: no history window needed
    feed(zero, 5, 12, (t) => 2.5 * t, () => 0);
    feed(none, 5, 12, (t) => 2.5 * t, () => null);
    expect(zero.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(zero.v).toBe(0);
    expect(zero.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(none.flags & F.STANDSTILL).toBe(0);
    expect(Math.abs(none.v - 2.5)).toBeLessThan(0.3);
  });

  it('RF2: latches SPEED_UNUSABLE on the 3rd consecutive moving zero (d1, d0 ≥ 8 m) and then tracks via position', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    // k = 1 has no previous interval (d0 undefined) → ignored, not counted; k = 2, 3 count 1, 2.
    feed(f, 0, 3, pos, () => 0);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 4, 4, pos, () => 0); // k = 4: third consecutive moving zero → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);

    // Session-long: later genuine speeds are ignored (identical to a speed-null control).
    const control = new SpeedFilter();
    feed(control, 0, 4, pos, () => 0);
    feed(f, 5, 24, pos, () => 15);
    feed(control, 5, 24, pos, () => null);
    f.evaluate(25.5);
    control.evaluate(25.5);
    expect(f.v).toBe(control.v);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
    expect(Math.abs(f.v - 15)).toBeLessThan(0.3);

    f.reset();
    f.evaluate(30);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(f.fixesAccepted).toBe(0);
  });

  it('A2: a usable (non-zero) speed between moving zeros resets the count', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 15 * t;
    feed(f, 0, 3, pos, () => 0); // count 2
    feed(f, 4, 4, pos, () => 15); // not a moving zero → count 0
    feed(f, 5, 6, pos, () => 0); // count 1, 2
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 7, 7, pos, () => 0); // count 3 → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
  });

  it('A2: a zero over a short interval (d1 < 8 m) resets the count, and the next zero needs d0 ≥ 8 m too', () => {
    const f = new SpeedFilter();
    // 15 m/fix, except a 5 m interval from k = 3 to k = 4.
    const pos = (t: number) => (t <= 3 ? 15 * t : 15 * t - 10);
    feed(f, 0, 3, pos, () => 0); // count 2
    feed(f, 4, 4, pos, () => 0); // d1 = 5 m → ignored without counting → count 0
    feed(f, 5, 5, pos, () => 0); // d1 = 15 m but d0 = 5 m → not a moving zero → count 0
    feed(f, 6, 7, pos, () => 0); // count 1, 2
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    feed(f, 8, 8, pos, () => 0); // count 3 → latch
    expect(f.flags & F.SPEED_UNUSABLE).toBe(F.SPEED_UNUSABLE);
  });

  it('A2: zeros with 3 m ≤ d1 < 8 m are ignored without counting; v tracks 5 m/s via position', () => {
    const f = new SpeedFilter();
    const arrival = feed(f, 0, 30, (t) => 5 * t, () => 0);
    f.evaluate(arrival);
    expect(f.flags & F.SPEED_UNUSABLE).toBe(0);
    expect(Math.abs(f.v - 5)).toBeLessThan(0.3);
  });
});

describe('SpeedFilter — standstill position deadband (contract A3)', () => {
  it('below 1.5 m/s a fix-to-fix displacement < 0.4·accuracy adds nothing to s_meas; real creep still moves v', () => {
    const jitter = (t: number): number => (t % 2 === 0 ? 0.9 : -0.9); // |d1| = 1.8 m every fix
    const dead = new SpeedFilter(); // accuracy 5 m → threshold 2.0 m → every step suppressed
    const live = new SpeedFilter(); // accuracy 4 m → threshold 1.6 m → 1.8 m/s of fake travel
    for (let k = 0; k <= 30; k++) {
      feed(dead, k, k, jitter, () => null, 5);
      expect(dead.flags & F.STANDSTILL).toBe(F.STANDSTILL);
      expect(dead.v).toBe(0);
    }
    feed(live, 0, 30, jitter, () => null, 4);
    expect(live.flags & F.STANDSTILL).toBe(0);

    const creep = new SpeedFilter(); // 3 m/fix ≥ 2.0 m → counted although v starts at 0
    const arrival = feed(creep, 0, 30, (t) => 3 * t, () => null, 5);
    creep.evaluate(arrival);
    expect(creep.flags & F.STANDSTILL).toBe(0);
    expect(Math.abs(creep.v - 3)).toBeLessThan(0.3);
  });
});
```

- [ ] **Step 3: Append part 3 (standstill hysteresis, dropout incl. RF3, long fix gaps, hidden/reset/configure)**

Append to the end of `tests/unit/speed-filter.test.ts`, after one blank line:

```ts
describe('SpeedFilter — standstill hysteresis (§8.2 step 5)', () => {
  it('enters below 0.5 m/s, leaves above 1.0 m/s, and outputs v = a = 0 while standing', () => {
    const f = new SpeedFilter();
    let s = 0;
    let speed = 0.8;
    let arrival = 1;
    /** Ramps the true speed to `target` by ≤ 0.05 m/s per fix (no deceleration transients), then holds. */
    const drive = (target: number, holdFixes: number): void => {
      let held = 0;
      while (held < holdFixes) {
        if (Math.abs(target - speed) <= 0.05) {
          speed = target;
          held++;
        } else {
          speed += target > speed ? 0.05 : -0.05;
        }
        f.accept(fixAt(s, speed), arrival);
        f.evaluate(arrival);
        s += speed;
        arrival++;
      }
    };
    drive(0.8, 6); // starts in standstill; 0.8 < 1.0 → stays
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(f.v).toBe(0);
    expect(f.a).toBe(0);
    drive(1.4, 4); // > 1.0 → leaves
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(f.v).toBeCloseTo(1.4, 1);
    drive(0.7, 6); // between 0.5 and 1.0 → stays moving
    expect(f.flags & F.STANDSTILL).toBe(0);
    expect(f.v).toBeCloseTo(0.7, 1);
    drive(0.2, 4); // < 0.5 → enters
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(f.v).toBe(0);
    expect(f.a).toBe(0);
  });
});

describe('SpeedFilter — dropout (§8.2 step 6)', () => {
  it('RF3: 35 s tunnel → PREDICTING after 2 s, no snap, GPS_LOST after 20 s, eased to 0 by 30 s, recovers', () => {
    const f = new SpeedFilter();
    const pos = (t: number) => 25 * t;
    const last = feed(f, 0, 19, pos, () => 25); // last arrival 20.0
    expect(last).toBe(20);
    const at = (gap: number): void => f.evaluate(last + gap);

    at(1.5);
    expect(f.flags & (F.PREDICTING | F.GPS_LOST)).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
    at(2.5);
    expect(f.flags & F.PREDICTING).toBe(F.PREDICTING);
    expect(f.flags & F.GPS_LOST).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
    at(19.9);
    expect(f.flags & F.GPS_LOST).toBe(0);
    const before = f.v;
    expect(before).toBeCloseTo(25, 1);

    // Ease: continuous at 20 s, monotonically non-increasing, linear to 0 at 30 s.
    let prev = before;
    for (let gap = 20.0; gap <= 30.0001; gap += 128 / 48000) {
      at(gap);
      expect(f.v).toBeLessThanOrEqual(prev + 1e-9);
      prev = f.v;
    }
    at(20.01);
    expect(f.flags & (F.GPS_LOST | F.PREDICTING)).toBe(F.GPS_LOST | F.PREDICTING);
    expect(Math.abs(f.v - before)).toBeLessThan(0.05);
    at(25);
    expect(f.v).toBeCloseTo(before * 0.5, 1);
    at(30);
    expect(f.v).toBe(0);
    expect(f.flags & F.STANDSTILL).toBe(F.STANDSTILL);
    at(34.9);
    expect(f.v).toBe(0);

    // Exit: measured at 54 (35 s after the last measurement), arrives 55.
    expect(f.accept(fixAt(pos(54), 25), last + 35)).toBe(true);
    at(35);
    expect(f.flags & (F.GPS_LOST | F.PREDICTING | F.STANDSTILL)).toBe(0);
    expect(f.v).toBeCloseTo(25, 1);
  });

  it('saturates the prediction while accelerating into a gap (Δv ≤ a·τa)', () => {
    const f = new SpeedFilter();
    const last = feed(f, 0, 12, (t) => 5 * t + 0.5 * t * t, (t) => 5 + t); // 1 m/s²
    f.evaluate(last);
    const v0 = f.v;
    const a0 = f.a;
    for (const gap of [3, 8, 15, 19.9]) {
      f.evaluate(last + gap);
      expect(f.v).toBeLessThanOrEqual(v0 + a0 * DEFAULT_SIM_TUNING.tauA + 1e-9);
      expect(f.v).toBeGreaterThanOrEqual(v0);
    }
  });
});

describe('SpeedFilter — long fix gaps', () => {
  it.each([
    ['speed present', 30],
    ['position only', null],
  ] as const)('a gap of hours (%s) re-seeds instead of predicting: P keeps a non-negative diagonal, v recovers by the 2nd fix', (_label, speed) => {
    const f = new SpeedFilter();
    const P = (f as unknown as { readonly P: Float64Array }).P; // white-box: the posterior covariance
    feed(f, 0, 20, (t) => 15 * t, () => (speed === null ? null : 15)); // 21 fixes at 15 m/s, last measured at 20 s
    const resumeS = 20 + 7200; // e.g. Tesbox minimised for two hours while driving (no geolocation while hidden)
    for (let k = 0; k < 10; k++) {
      const tMeas = resumeS + k;
      expect(f.accept(fixAt(300 + 30 * (tMeas - 20), speed), tMeas + 1)).toBe(true);
      f.evaluate(tMeas + 1);
      for (const i of [0, 4, 8]) expect(P[i], `P[${i}] after resumed fix ${k + 1}`).toBeGreaterThanOrEqual(0);
      if (k >= 1) expect(Math.abs(f.v - 30), `v after resumed fix ${k + 1}`).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('SpeedFilter — hidden hold, reset, configure', () => {
  it('sets HIDDEN_HOLD while hidden, keeps accepting fixes, and clears it when visible', () => {
    const f = new SpeedFilter();
    feed(f, 0, 3, (t) => 10 * t, () => 10);
    f.setHidden(true);
    expect(f.flags & F.HIDDEN_HOLD).toBe(F.HIDDEN_HOLD);
    expect(f.accept(fixAt(40, 10), 5)).toBe(true);
    f.evaluate(5);
    expect(f.flags & F.HIDDEN_HOLD).toBe(F.HIDDEN_HOLD);
    expect(f.v).toBeCloseTo(10, 1);
    f.setHidden(false);
    expect(f.flags & F.HIDDEN_HOLD).toBe(0);
    f.evaluate(5.1);
    expect(f.flags & F.HIDDEN_HOLD).toBe(0);
  });

  it('reset() clears state and counters but keeps the hidden flag', () => {
    const f = new SpeedFilter();
    feed(f, 0, 3, (t) => 10 * t, () => 10);
    f.accept(fixAt(0, 10, 9), 6); // rejected
    f.setHidden(true);
    f.reset();
    expect(f.hasFix).toBe(false);
    expect(f.fixesAccepted).toBe(0);
    expect(f.fixesRejected).toBe(0);
    f.evaluate(7);
    expect(f.flags).toBe(F.GPS_LOST | F.STANDSTILL | F.HIDDEN_HOLD);
    // A fix older than the previous session's tK is accepted after reset.
    expect(f.accept(fixAt(0, 3), 1.5)).toBe(true);
  });

  it('uses the constructor tuning (kalmanQ changes the position-only response)', () => {
    const slow = new SpeedFilter({ ...DEFAULT_SIM_TUNING, kalmanQ: 0.5 });
    const fast = new SpeedFilter({ ...DEFAULT_SIM_TUNING, kalmanQ: 50 });
    const pos = (t: number) => (t < 5 ? 0 : 20 * (t - 5));
    feed(slow, 0, 6, pos, () => null);
    feed(fast, 0, 6, pos, () => null);
    slow.evaluate(7);
    fast.evaluate(7);
    expect(fast.v).toBeGreaterThan(slow.v);
  });
});
```

- [ ] **Step 4: Run the test to see it fail**

```bash
npx vitest run tests/unit/speed-filter.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/speed-filter' imported from …/tests/unit/speed-filter.test.ts`.

- [ ] **Step 5: Implement `src/sim/speed-filter.ts`**

Contract interpretations encoded below (keep them): the zero-speed rule is contract amendment A2 (it replaces the 3–5 s ring-buffer window of the contract body) — `d1` is the raw haversine displacement from the previous accepted fix (before the A3 deadband) and `d0` the previous interval's `d1` (`NaN` for the first interval, so the first interval is never a moving zero); a `speedMps === 0` fix is a usable measurement iff `d1 < 3 m`, a "moving zero" iff `d1 ≥ 8 m && d0 ≥ 8 m` (ignored, `zeroMovingCount++`), otherwise ignored without counting; every fix that is not a moving zero (any speed, missing speed, or another zero) resets `zeroMovingCount` to 0, and `SPEED_UNUSABLE` latches at 3 consecutive moving zeros (session-long; `reset()` clears); the standstill deadband is amendment A3 — while the last `evaluate()` output `v < 1.5 m/s`, a `d1 < 0.4·accuracyM` adds 0 to `s_meas` (the fix still becomes the previous position); a non-finite `ageS` is rejected like `ageS > 3`; on standstill entry the posterior `a := 0` and its covariance row/column becomes `[0, 0, 1]` (cross terms zeroed so `P` stays positive semi-definite); a first fix reporting speed 0 initialises `v = 0`; a fix more than `REINIT_GAP_S = 60` s after `tK` re-seeds the state (`s = s_meas`, `v` = the usable speed or 0, `a = 0`, `P = diag(25, 1e4, 4)`) instead of predicting across the gap, then takes the normal measurement updates — over hours the white-jerk `q·Δ⁵/20` reaches ~1e16 m² and the non-Joseph update loses `P`'s positive semi-definiteness (measured: `P[0] = −256 m²` after a 2 h gap, position-only). This re-seed deviates from the contract's "predict from tK to tFix" for that edge case and is listed in the plan header's Concerns section (PC3).

```ts
import { DEFAULT_SIM_TUNING, F } from '../contracts';
import type { FixMsg, SimTuning } from '../contracts';
import { haversineM } from '../platform/geo';

/** Fixes older than this on receipt are rejected (spec §8.2 step 1). */
const MAX_AGE_S = 3;
/** A fix must be newer than the posterior time by more than this (out-of-order / cached repeat). */
const MIN_ADVANCE_S = 0.05;
/** Initial posterior variances for [s, v, a]. */
const P0_S = 25;
const P0_V = 25;
const P0_A = 4;
/** Speed measurement noise floor (m/s) and accuracy factor. */
const RV_FLOOR = 0.3;
const RV_PER_ACC = 0.05;
/**
 * Zero-speed rule (contract A2): a reported 0 is a measurement iff the fix-to-fix displacement
 * d1 < ZERO_STILL_M; a "moving zero" iff d1 ≥ ZERO_MOVING_M and the previous interval d0 ≥ ZERO_MOVING_M;
 * ZERO_LATCH_COUNT consecutive moving zeros latch SPEED_UNUSABLE.
 */
const ZERO_STILL_M = 3;
const ZERO_MOVING_M = 8;
const ZERO_LATCH_COUNT = 3;
/** Standstill position deadband (contract A3): below DEADBAND_V (m/s), d1 < DEADBAND_ACC_FRAC·accuracy adds 0. */
const DEADBAND_V = 1.5;
const DEADBAND_ACC_FRAC = 0.4;
/** Standstill hysteresis (m/s). */
const STILL_ENTER = 0.5;
const STILL_LEAVE = 1.0;
/**
 * A fix more than REINIT_GAP_S after tK re-seeds the state instead of predicting across the gap: over
 * minutes to hours q·Δ⁵/20 reaches 1e16 m² and the (non-Joseph) update loses P's positive
 * semi-definiteness. The re-seed keeps s on s_meas and gives v a wide prior (the next fixes set it).
 */
const REINIT_GAP_S = 60;
const P0_V_REINIT = 1e4;
/** Arrival-gap thresholds (s). */
const PREDICT_AFTER_S = 2;
const LOST_AFTER_S = 20;
const LOST_EASE_S = 10;

/**
 * Single 3-state Kalman filter on [s, v, a] with optional position and speed measurements
 * (spec §8.2, phase-1 contract). Posterior is kept at the last fix time tK; the output is a
 * saturating prediction to nowS + outputLatencyS that is never written back.
 * accept()/evaluate() never allocate.
 */
export class SpeedFilter {
  private q = DEFAULT_SIM_TUNING.kalmanQ;
  private tauA = DEFAULT_SIM_TUNING.tauA;
  private outLatS = DEFAULT_SIM_TUNING.outputLatencyS;

  /** Posterior state [s, v, a] at tK. */
  private readonly x = new Float64Array(3);
  /** Posterior covariance, row-major 3×3. */
  private readonly P = new Float64Array(9);
  private tK = Number.NEGATIVE_INFINITY;
  private lastArrivalS = Number.NEGATIVE_INFINITY;
  private prevLat = 0;
  private prevLon = 0;
  private sMeas = 0;
  /** Raw displacement of the previous fix-to-fix interval (A2's d0); NaN before the first interval. */
  private prevDispM = Number.NaN;

  private zeroMovingCount = 0;
  private speedUnusable = false;
  private standstill = true;
  private hidden = false;

  private _hasFix = false;
  private _v = 0;
  private _a = 0;
  private _flags: number = F.GPS_LOST | F.STANDSTILL;
  private _accepted = 0;
  private _rejected = 0;

  constructor(tuning?: SimTuning) {
    this.configure(tuning ?? DEFAULT_SIM_TUNING);
    this.reset();
  }

  /** Copies tuning numbers; keeps the filter state (safe mid-drive). */
  configure(tuning: SimTuning): void {
    this.q = tuning.kalmanQ;
    this.tauA = tuning.tauA;
    this.outLatS = tuning.outputLatencyS;
  }

  /** Clears state, counters and the SPEED_UNUSABLE latch. Does not change the hidden flag. */
  reset(): void {
    this.x.fill(0);
    this.P.fill(0);
    this.tK = Number.NEGATIVE_INFINITY;
    this.lastArrivalS = Number.NEGATIVE_INFINITY;
    this.prevLat = 0;
    this.prevLon = 0;
    this.sMeas = 0;
    this.prevDispM = Number.NaN;
    this.zeroMovingCount = 0;
    this.speedUnusable = false;
    this.standstill = true;
    this._hasFix = false;
    this._v = 0;
    this._a = 0;
    this._flags = F.GPS_LOST | F.STANDSTILL | (this.hidden ? F.HIDDEN_HOLD : 0);
    this._accepted = 0;
    this._rejected = 0;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this._flags |= F.HIDDEN_HOLD;
    else this._flags &= ~F.HIDDEN_HOLD;
  }

  get v(): number {
    return this._v;
  }
  get a(): number {
    return this._a;
  }
  get flags(): number {
    return this._flags;
  }
  get fixesAccepted(): number {
    return this._accepted;
  }
  get fixesRejected(): number {
    return this._rejected;
  }
  get hasFix(): boolean {
    return this._hasFix;
  }

  /** §8.2 steps 1–3. Returns true if the fix was accepted. Never retains `fix`. */
  accept(fix: FixMsg, nowS: number): boolean {
    const ageS = fix.ageS;
    const acc = fix.accuracyM;
    if (
      !Number.isFinite(ageS) ||
      ageS > MAX_AGE_S ||
      !Number.isFinite(fix.lat) ||
      !Number.isFinite(fix.lon) ||
      !Number.isFinite(acc) ||
      acc <= 0
    ) {
      this._rejected++;
      return false;
    }
    const tFix = nowS - ageS;
    if (tFix <= this.tK + MIN_ADVANCE_S) {
      this._rejected++;
      return false;
    }

    const sp = fix.speedMps;
    // null / NaN / ±Infinity / negative → missing.
    const speedPresent = sp !== null && Number.isFinite(sp) && sp >= 0;

    if (!this._hasFix) {
      this.x[0] = 0;
      this.x[1] = speedPresent && !this.speedUnusable ? sp : 0;
      this.x[2] = 0;
      this.P.fill(0);
      this.P[0] = P0_S;
      this.P[4] = P0_V;
      this.P[8] = P0_A;
      this.sMeas = 0;
      this.prevDispM = Number.NaN;
      this.prevLat = fix.lat;
      this.prevLon = fix.lon;
      this.tK = tFix;
      this.lastArrivalS = nowS;
      this._hasFix = true;
      this._accepted++;
      return true;
    }

    // Raw fix-to-fix displacement d1 (A2 and A3 use it before the deadband) and the previous one, d0.
    const d1 = haversineM(this.prevLat, this.prevLon, fix.lat, fix.lon);
    const d0 = this.prevDispM;
    this.prevDispM = d1;
    this.prevLat = fix.lat;
    this.prevLon = fix.lon;

    // Zero-speed rule (A2).
    let speedUsable = speedPresent && !this.speedUnusable;
    let movingZero = false;
    if (speedUsable && sp === 0) {
      speedUsable = d1 < ZERO_STILL_M;
      movingZero = !speedUsable && d1 >= ZERO_MOVING_M && d0 >= ZERO_MOVING_M;
    }
    if (movingZero) {
      this.zeroMovingCount++;
      if (this.zeroMovingCount >= ZERO_LATCH_COUNT) this.speedUnusable = true;
    } else {
      this.zeroMovingCount = 0;
    }

    // Position measurement: cumulative haversine distance along the accepted fixes, with the A3
    // standstill deadband (this._v is the last evaluate() output).
    if (!(this._v < DEADBAND_V && d1 < DEADBAND_ACC_FRAC * acc)) this.sMeas += d1;

    const gapS = tFix - this.tK;
    if (gapS > REINIT_GAP_S) {
      this.x[0] = this.sMeas;
      this.x[1] = speedUsable && sp !== null ? sp : 0;
      this.x[2] = 0;
      this.P.fill(0);
      this.P[0] = P0_S;
      this.P[4] = P0_V_REINIT;
      this.P[8] = P0_A;
    } else {
      this.predict(gapS);
    }
    const halfAcc = acc / 2;
    this.scalarUpdate(0, this.sMeas, halfAcc * halfAcc);
    if (speedUsable && sp !== null) {
      const sigmaV = Math.max(RV_FLOOR, RV_PER_ACC * acc);
      this.scalarUpdate(1, sp, sigmaV * sigmaV);
    }

    this.tK = tFix;
    this.lastArrivalS = nowS;
    this._accepted++;
    return true;
  }

  /** §8.2 steps 4–6: output v, a and flags for nowS. Never allocates. */
  evaluate(nowS: number): void {
    let flags = this.hidden ? F.HIDDEN_HOLD : 0;
    if (this.speedUnusable) flags |= F.SPEED_UNUSABLE;

    if (!this._hasFix) {
      this.standstill = true;
      this._v = 0;
      this._a = 0;
      this._flags = flags | F.GPS_LOST | F.STANDSTILL;
      return;
    }

    const tau = Math.max(0, nowS + this.outLatS - this.tK);
    const decay = Math.exp(-tau / this.tauA);
    const vk = this.x[1] ?? 0;
    const ak = this.x[2] ?? 0;
    let v = Math.max(0, vk + ak * this.tauA * (1 - decay));
    let a = ak * decay;

    const gap = nowS - this.lastArrivalS;
    if (gap > PREDICT_AFTER_S) flags |= F.PREDICTING;
    if (gap > LOST_AFTER_S) {
      flags |= F.GPS_LOST;
      v *= Math.max(0, 1 - (gap - LOST_AFTER_S) / LOST_EASE_S);
    }

    if (this.standstill) {
      if (v > STILL_LEAVE) this.standstill = false;
    } else if (v < STILL_ENTER) {
      this.standstill = true;
      // Reset the posterior acceleration; its covariance row/column becomes [0, 0, 1].
      this.x[2] = 0;
      this.P[2] = 0;
      this.P[5] = 0;
      this.P[6] = 0;
      this.P[7] = 0;
      this.P[8] = 1;
    }
    if (this.standstill) {
      v = 0;
      a = 0;
      flags |= F.STANDSTILL;
    }

    this._v = v;
    this._a = a;
    this._flags = flags;
  }

  /** x ← F x, P ← F P Fᵀ + Q (white jerk), for a step of d seconds. */
  private predict(d: number): void {
    const x = this.x;
    const P = this.P;
    const h = 0.5 * d * d;
    const s = x[0] ?? 0;
    const v = x[1] ?? 0;
    const a = x[2] ?? 0;
    x[0] = s + v * d + a * h;
    x[1] = v + a * d;

    const p00 = P[0] ?? 0;
    const p01 = P[1] ?? 0;
    const p02 = P[2] ?? 0;
    const p11 = P[4] ?? 0;
    const p12 = P[5] ?? 0;
    const p22 = P[8] ?? 0;
    // Rows of F·P.
    const r00 = p00 + d * p01 + h * p02;
    const r01 = p01 + d * p11 + h * p12;
    const r02 = p02 + d * p12 + h * p22;
    const r11 = p11 + d * p12;
    const r12 = p12 + d * p22;
    // (F·P)·Fᵀ.
    const n00 = r00 + d * r01 + h * r02;
    const n01 = r01 + d * r02;
    const n02 = r02;
    const n11 = r11 + d * r12;
    const n12 = r12;
    const n22 = p22;

    const q = this.q;
    const d2 = d * d;
    const d3 = d2 * d;
    const d4 = d3 * d;
    const d5 = d4 * d;
    P[0] = n00 + (q * d5) / 20;
    P[1] = n01 + (q * d4) / 8;
    P[2] = n02 + (q * d3) / 6;
    P[4] = n11 + (q * d3) / 3;
    P[5] = n12 + (q * d2) / 2;
    P[8] = n22 + q * d;
    P[3] = P[1] ?? 0;
    P[6] = P[2] ?? 0;
    P[7] = P[5] ?? 0;
  }

  /** Scalar update with H = e_i and variance r; symmetrises P afterwards. */
  private scalarUpdate(i: number, z: number, r: number): void {
    const x = this.x;
    const P = this.P;
    const c0 = P[i] ?? 0; // P[0][i]
    const c1 = P[3 + i] ?? 0; // P[1][i]
    const c2 = P[6 + i] ?? 0; // P[2][i]
    const sInv = 1 / ((P[4 * i] ?? 0) + r);
    const y = z - (x[i] ?? 0);
    x[0] = (x[0] ?? 0) + c0 * sInv * y;
    x[1] = (x[1] ?? 0) + c1 * sInv * y;
    x[2] = (x[2] ?? 0) + c2 * sInv * y;
    P[0] = (P[0] ?? 0) - c0 * c0 * sInv;
    P[1] = (P[1] ?? 0) - c0 * c1 * sInv;
    P[2] = (P[2] ?? 0) - c0 * c2 * sInv;
    P[3] = (P[3] ?? 0) - c1 * c0 * sInv;
    P[4] = (P[4] ?? 0) - c1 * c1 * sInv;
    P[5] = (P[5] ?? 0) - c1 * c2 * sInv;
    P[6] = (P[6] ?? 0) - c2 * c0 * sInv;
    P[7] = (P[7] ?? 0) - c2 * c1 * sInv;
    P[8] = (P[8] ?? 0) - c2 * c2 * sInv;
    const s01 = 0.5 * ((P[1] ?? 0) + (P[3] ?? 0));
    const s02 = 0.5 * ((P[2] ?? 0) + (P[6] ?? 0));
    const s12 = 0.5 * ((P[5] ?? 0) + (P[7] ?? 0));
    P[1] = s01;
    P[3] = s01;
    P[2] = s02;
    P[6] = s02;
    P[5] = s12;
    P[7] = s12;
  }
}
```

- [ ] **Step 6: Run the test to see it pass**

```bash
npx vitest run tests/unit/speed-filter.test.ts
```

Expected: PASS — `Tests  33 passed (33)` (includes RF1, RF2 — latch on the 3rd consecutive moving zero per contract A2 — RF3, the A3 deadband, and the two long-gap re-seed cases).

- [ ] **Step 7: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both commands exit 0 and print no diagnostics (only the npm script banners). (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 3: ReplayFeeder, synthetic GPS fixtures, GPX converter and criterion (a)

**Files:**
- Create: `src/sim/replay.ts`
- Create: `tools/make-synthetic-replay.ts`
- Create (generated by `tools/make-synthetic-replay.ts`, committed): `tests/fixtures/replay/city-amd.json`, `tests/fixtures/replay/highway-amd.json`, `tests/fixtures/replay/intel-zero-speed.json`, `tests/fixtures/replay/intel-null-speed.json`, `tests/fixtures/replay/tunnel-dropout.json`, `tests/fixtures/replay/stoplight-jitter.json`, `tests/fixtures/replay/stale-duplicates.json`, `tests/fixtures/replay/step-response.json`
- Create: `tools/gpx-to-replay.ts`
- Create: `tests/helpers/replay-harness.ts` (test-only helper, not collected as a test)
- Modify: `.gitignore` (append `*.gpx` — GPX inputs carry real positions and are never committed)
- Test: `tests/unit/replay.test.ts`
- Test: `tests/unit/make-synthetic-replay.test.ts`
- Test: `tests/unit/gpx-to-replay.test.ts`
- Test: `tests/unit/criterion-a.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `new SpeedFilter(tuning?: SimTuning)`, `accept(fix: FixMsg, nowS: number): boolean`, `evaluate(nowS: number): void`, getters `v`, `flags`, `fixesAccepted`, `fixesRejected`.
  - `haversineM(lat1, lon1, lat2, lon2): number` from `src/platform/geo.ts` (Phase 0 T5).
  - From `src/contracts.ts`: `type FixMsg`, `type SimTuning`, `DEFAULT_SIM_TUNING`, `F`, `QUANTUM`.
- Produces:
  - `src/sim/replay.ts` (exactly the contract): `export interface ReplayFix { t: number; sAlongM: number; speedMps: number | null; accuracyM: number; ageS?: number }`; `export interface ReplayTrace { meta: { name: string; cadenceS: number; latencyS: number; source: 'synthetic' | 'gpx'; notes?: string }; fixes: ReplayFix[]; truth?: { t: number; v: number }[] }`; `export const METRES_PER_DEG_LON_AT_EQUATOR = 111319.49`; `export class ReplayFeeder { constructor(trace: ReplayTrace); reset(): void; next(nowS: number, out: FixMsg): boolean }` — `next` delivers at most one due fix per call (callers loop `while (feeder.next(nowS, fix)) filter.accept(fix, nowS)`), writes `type 'fix'`, `lat 0`, `lon = sAlongM / 111319.49`, `ageS = fix.ageS ?? meta.latencyS`, `speedMps`, `accuracyM`, `altitudeM null`; allocation-free; leaves `out` untouched when it returns false.
  - `tools/make-synthetic-replay.ts`: `CADENCE_S = 1`, `LATENCY_S = 1`, `SPEED_NOISE_SD = 0.15`, `POS_NOISE_TAU_S = 60`, `FIXTURE_DIR`, `type Knot = readonly [t: number, v: number]`, `mulberry32(seed: number): () => number`, `gaussian(rand: () => number): number`, `knotsFrom(v0: number, segments: readonly (readonly [number, number])[]): Knot[]`, `speedAt(knots: readonly Knot[], t: number): number`, `distanceAt(knots: readonly Knot[], t: number): number`, `type SpeedMode`, `interface TraceSpec`, `makeTrace(spec: TraceSpec): ReplayTrace`, `withStaleDuplicates(base: ReplayTrace): ReplayTrace`, `stepResponseKnots(steps: number): { knots: Knot[]; durationS: number }`, `buildAllTraces(): ReplayTrace[]`, `serialiseTrace(trace: ReplayTrace): string`, `round(x: number, dp: number): number` (no `-0`; also used by `tools/gpx-to-replay.ts`), `main(rootDir: string): void`. Run: `npx tsx tools/make-synthetic-replay.ts`.
  - `tools/gpx-to-replay.ts`: `interface GpxPoint { tS; lat; lon; speedMps: number | null }`, `interface GpxOptions { name; latencyS; cadenceS; nullRate }`, `GPX_ACCURACY_M = 5`, `MAX_INTERP_GAP_S = 5`, `parseGpx(xml: string): GpxPoint[]`, `gpxToReplay(points: readonly GpxPoint[], opts: GpxOptions): ReplayTrace`, `main(argv: readonly string[]): number`. CLI: `npx tsx tools/gpx-to-replay.ts <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]` (output has no lat/lon and no absolute time).
  - `tests/helpers/replay-harness.ts` (usable by later tasks' tests, not part of the contract): `DT_S`, `FIXTURE_NAMES`, `fixturePath(name): URL`, `loadTrace(name): ReplayTrace`, `interface ReplayRun { v: Float64Array; flags: Int32Array; accepted: number; rejected: number }`, `runTrace(trace, tuning?, tailS?): ReplayRun`, `idx(t): number`, `knotsOf(trace): Knot[]`, `truthAt(knots, t): number`, `settled(knots, t, windowS): boolean`, `stepsOf(trace): { t; from; to }[]`, `percentile(values, p): number`.
  - Fixtures (deterministic; `truth` = piecewise-linear knots, equal consecutive `t` = instantaneous step): city-amd 101 fixes (stop-go, braking ≤ 1.2 m/s²), highway-amd 78 (0→130 km/h, cruise, lift-off), intel-zero-speed 70 (speed always 0), intel-null-speed 70 (speed null), tunnel-dropout 49 (arrivals 20.0 s → 55.0 s), stoplight-jitter 91 (Gauss–Markov wander plus white σ = 1 m per contract A9, clamped ±4 m; speed 0–0.4), stale-duplicates 73 (52 acceptable + 21 cached/stale/out-of-order, `ageS` on every fix, ages up to 10 s), step-response 467 (20 steps: 0→20 then 20→10/10→20; step phase sweeps 0.05…0.95 s of the fix grid).

**Cross-task premises:**
- Task 2 is complete and green, implementing contract amendments A2 (zero-speed rule) and A3 (standstill position deadband): run `npx vitest run tests/unit/speed-filter.test.ts` first. The fixture assertions here were measured against exactly that implementation (e.g. intel-zero latch at 13.000 s — three consecutive moving zeros, asserted within [12, 13.5] s; stoplight-jitter never leaves standstill, and with its speeds nulled the A3 deadband holds standstill for 77.7 % of quanta (34.0 % without A3); stale-duplicates 52 accepted / 21 rejected; criterion speed-path p95 1.950 s ≤ 2.2 s and position-path p95 2.750 s ≤ 3.0 s per amendment A1).
- Contract amendment A9: every fixture's position noise is Gauss–Markov with σ = accuracy/2 (τ = 60 s); only `stoplight-jitter` adds a white σ = 1 m component.
- `haversineM` as described in Task 2 (gpx-to-replay distances; `replay.test.ts` documents the 0.112 % difference between `METRES_PER_DEG_LON_AT_EQUATOR` and haversine's R).
- Phase 0: `tsx` is a devDependency (tools run with `npx tsx`); Node ≥ 22.12 (`node:util` `parseArgs`); `tsconfig.json` includes `tools` and `tests` with `types` containing `node`; ESLint's flat config covers `tools/` and `tests/`; `.gitignore` exists; Vitest `include` is `tests/unit/**/*.test.ts`, so `tests/helpers/replay-harness.ts` is never collected as a test file. Open the files and confirm.
- Fixture determinism relies on V8's `Math` functions (identical in Node 22 and 24). `make-synthetic-replay.test.ts` fails if a committed fixture differs from regeneration — always regenerate with the tool, never hand-edit fixtures.

- [ ] **Step 1: Write the failing ReplayFeeder test (interim file; replaced in Step 11)**

Create `tests/unit/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FixMsg } from '../../src/contracts';
import { haversineM } from '../../src/platform/geo';
import { METRES_PER_DEG_LON_AT_EQUATOR, ReplayFeeder } from '../../src/sim/replay';
import type { ReplayTrace } from '../../src/sim/replay';

const TINY: ReplayTrace = {
  meta: { name: 'tiny', cadenceS: 1, latencyS: 0.8, source: 'synthetic' },
  fixes: [
    { t: 1, sAlongM: 0, speedMps: 3, accuracyM: 5 },
    { t: 2, sAlongM: 111.31949, speedMps: null, accuracyM: 6 },
    { t: 2, sAlongM: 222.63898, speedMps: 0, accuracyM: 7, ageS: 2.5 },
  ],
};

function blankFix(): FixMsg {
  return { type: 'fix', ageS: -1, speedMps: -1, lat: 9, lon: 9, accuracyM: -1, altitudeM: 123 };
}

describe('ReplayFeeder', () => {
  it('delivers fixes in order once their t ≤ nowS, one per call, as fake equator positions', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    expect(feeder.next(0.999, out)).toBe(false);
    expect(out.ageS).toBe(-1); // untouched when nothing is due

    expect(feeder.next(1, out)).toBe(true);
    expect(out).toEqual({ type: 'fix', ageS: 0.8, speedMps: 3, lat: 0, lon: 0, accuracyM: 5, altitudeM: null });
    expect(feeder.next(1.5, out)).toBe(false);

    expect(feeder.next(2.5, out)).toBe(true);
    expect(out.lon).toBeCloseTo(111.31949 / METRES_PER_DEG_LON_AT_EQUATOR, 15);
    expect(out.speedMps).toBeNull();
    expect(out.ageS).toBe(0.8); // meta.latencyS default
    expect(feeder.next(2.5, out)).toBe(true); // second fix with the same t, same call time
    expect(out.ageS).toBe(2.5); // per-fix override
    expect(out.speedMps).toBe(0);
    expect(out.accuracyM).toBe(7);
    expect(feeder.next(2.5, out)).toBe(false);
    expect(feeder.next(1e9, out)).toBe(false); // exhausted
  });

  it('reset() rewinds to the first fix', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    while (feeder.next(10, out)) {
      /* drain */
    }
    feeder.reset();
    expect(feeder.next(1, out)).toBe(true);
    expect(out.speedMps).toBe(3);
  });

  it('fake positions are 1° = 111319.49 m; haversine (R = 6371008.8 m) reads them 0.112 % short', () => {
    expect(METRES_PER_DEG_LON_AT_EQUATOR).toBe(111319.49);
    const d = haversineM(0, 0, 0, 1000 / METRES_PER_DEG_LON_AT_EQUATOR);
    expect(d / 1000).toBeCloseTo((6371008.8 * Math.PI) / 180 / METRES_PER_DEG_LON_AT_EQUATOR, 9);
    expect(d / 1000).toBeCloseTo(0.998882, 6);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx vitest run tests/unit/replay.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/replay' imported from …/tests/unit/replay.test.ts`.

- [ ] **Step 3: Implement `src/sim/replay.ts`**

```ts
import type { FixMsg } from '../contracts';

/** One recorded/synthetic GPS fix. `t` = delivery time in seconds from trace start. */
export interface ReplayFix {
  t: number;
  sAlongM: number;
  speedMps: number | null;
  accuracyM: number;
  ageS?: number;
}

export interface ReplayTrace {
  meta: { name: string; cadenceS: number; latencyS: number; source: 'synthetic' | 'gpx'; notes?: string };
  fixes: ReplayFix[]; // t = delivery time (s from trace start), ascending
  truth?: { t: number; v: number }[]; // ground-truth speed (synthetic traces only)
}

/** Fake positions lie on the equator: lon = sAlongM / this. */
export const METRES_PER_DEG_LON_AT_EQUATOR = 111319.49;

/** Feeds a ReplayTrace into the FixMsg path as fake equator positions (no real coordinates). */
export class ReplayFeeder {
  private readonly trace: ReplayTrace;
  private index = 0;

  constructor(trace: ReplayTrace) {
    this.trace = trace;
  }

  reset(): void {
    this.index = 0;
  }

  /** Fills `out` with the next fix if its t ≤ nowS and returns true; else false. Fake position: lat 0, lon = sAlongM / 111319.49. ageS = fix.ageS ?? meta.latencyS. */
  next(nowS: number, out: FixMsg): boolean {
    const f = this.trace.fixes[this.index];
    if (f === undefined || f.t > nowS) return false;
    this.index++;
    out.type = 'fix';
    out.ageS = f.ageS ?? this.trace.meta.latencyS;
    out.speedMps = f.speedMps;
    out.lat = 0;
    out.lon = f.sAlongM / METRES_PER_DEG_LON_AT_EQUATOR;
    out.accuracyM = f.accuracyM;
    out.altitudeM = null;
    return true;
  }
}
```

- [ ] **Step 4: Run it to see it pass**

```bash
npx vitest run tests/unit/replay.test.ts
```

Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Create the test harness `tests/helpers/replay-harness.ts`**

(It imports `speedAt` from the generator written in Step 8; nothing imports the harness until Step 6.)

```ts
/** Test-only harness: runs ReplayTrace fixtures through ReplayFeeder → SpeedFilter per audio quantum. */
import { readFileSync } from 'node:fs';
import { DEFAULT_SIM_TUNING, QUANTUM } from '../../src/contracts';
import type { FixMsg, SimTuning } from '../../src/contracts';
import { ReplayFeeder } from '../../src/sim/replay';
import type { ReplayTrace } from '../../src/sim/replay';
import { SpeedFilter } from '../../src/sim/speed-filter';
import { speedAt } from '../../tools/make-synthetic-replay';
import type { Knot } from '../../tools/make-synthetic-replay';

export const DT_S = QUANTUM / 48000;

export const FIXTURE_NAMES = [
  'city-amd',
  'highway-amd',
  'intel-zero-speed',
  'intel-null-speed',
  'tunnel-dropout',
  'stoplight-jitter',
  'stale-duplicates',
  'step-response',
] as const;

export function fixturePath(name: string): URL {
  return new URL(`../fixtures/replay/${name}.json`, import.meta.url);
}

export function loadTrace(name: string): ReplayTrace {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as ReplayTrace;
}

export interface ReplayRun {
  /** nowS of quantum i is i·DT_S. */
  v: Float64Array;
  flags: Int32Array;
  accepted: number;
  rejected: number;
}

/** Steps a fresh SpeedFilter every quantum from 0 to the last fix time + tailS. */
export function runTrace(trace: ReplayTrace, tuning: SimTuning = DEFAULT_SIM_TUNING, tailS = 3): ReplayRun {
  const lastT = trace.fixes[trace.fixes.length - 1]?.t ?? 0;
  const n = Math.ceil((lastT + tailS) / DT_S) + 1;
  const v = new Float64Array(n);
  const flags = new Int32Array(n);
  const feeder = new ReplayFeeder(trace);
  const filter = new SpeedFilter(tuning);
  const fix: FixMsg = { type: 'fix', ageS: 0, speedMps: null, lat: 0, lon: 0, accuracyM: 1, altitudeM: null };
  for (let i = 0; i < n; i++) {
    const nowS = i * DT_S;
    while (feeder.next(nowS, fix)) filter.accept(fix, nowS);
    filter.evaluate(nowS);
    v[i] = filter.v;
    flags[i] = filter.flags;
  }
  return { v, flags, accepted: filter.fixesAccepted, rejected: filter.fixesRejected };
}

/** Index of the first quantum with nowS ≥ t. */
export function idx(t: number): number {
  return Math.ceil(t / DT_S - 1e-9);
}

export function knotsOf(trace: ReplayTrace): Knot[] {
  return (trace.truth ?? []).map((p) => [p.t, p.v] as const);
}

/** True speed at t (piecewise linear, right-continuous at steps). */
export function truthAt(knots: readonly Knot[], t: number): number {
  return speedAt(knots, t);
}

/** True when the truth speed has been exactly constant over [t − windowS, t]. */
export function settled(knots: readonly Knot[], t: number, windowS: number): boolean {
  if (t < windowS) return false;
  for (const [tk] of knots) if (tk > t - windowS && tk <= t) return false;
  return truthAt(knots, t - windowS) === truthAt(knots, t);
}

/** Instantaneous steps in the truth (two knots with equal t and different v). */
export function stepsOf(trace: ReplayTrace): { t: number; from: number; to: number }[] {
  const truth = trace.truth ?? [];
  const steps: { t: number; from: number; to: number }[] = [];
  for (let i = 1; i < truth.length; i++) {
    const a = truth[i - 1];
    const b = truth[i];
    if (a !== undefined && b !== undefined && a.t === b.t && a.v !== b.v) steps.push({ t: a.t, from: a.v, to: b.v });
  }
  return steps;
}

/** Nearest-rank percentile (p in (0, 100]). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}
```

- [ ] **Step 6: Write the failing generator test**

Create `tests/unit/make-synthetic-replay.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAllTraces,
  distanceAt,
  gaussian,
  knotsFrom,
  mulberry32,
  serialiseTrace,
  speedAt,
  stepResponseKnots,
} from '../../tools/make-synthetic-replay';
import { FIXTURE_NAMES, fixturePath } from '../helpers/replay-harness';

describe('PRNG', () => {
  it('mulberry32 is deterministic per seed and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a(), a()];
    expect([b(), b(), b(), b()]).toEqual(seqA);
    expect(c()).not.toBe(seqA[0]);
    for (const x of seqA) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('gaussian has mean ≈ 0 and sd ≈ 1', () => {
    const r = mulberry32(7);
    let s = 0;
    let s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = gaussian(r);
      s += g;
      s2 += g * g;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(s2 / n - (s / n) ** 2) - 1)).toBeLessThan(0.03);
  });
});

describe('truth profiles', () => {
  const ramp = knotsFrom(0, [[10, 10], [5, 10], [0, 4]]); // 0→10 over 10 s, hold 5 s, step to 4

  it('knotsFrom accumulates segment durations', () => {
    expect(ramp).toEqual([[0, 0], [10, 10], [15, 10], [15, 4]]);
  });

  it('speedAt interpolates, is right-continuous at steps, and holds after the last knot', () => {
    expect(speedAt(ramp, 5)).toBe(5);
    expect(speedAt(ramp, 12)).toBe(10);
    expect(speedAt(ramp, 14.999)).toBe(10);
    expect(speedAt(ramp, 15)).toBe(4);
    expect(speedAt(ramp, 100)).toBe(4);
  });

  it('distanceAt integrates exactly (trapezoids, zero-width steps, linear extension)', () => {
    expect(distanceAt(ramp, 0)).toBe(0);
    expect(distanceAt(ramp, 4)).toBeCloseTo(8, 12); // ∫0^4 t dt
    expect(distanceAt(ramp, 10)).toBeCloseTo(50, 12);
    expect(distanceAt(ramp, 15)).toBeCloseTo(100, 12);
    expect(distanceAt(ramp, 20)).toBeCloseTo(120, 12);
  });

  it('stepResponseKnots: 20 steps 0→20→20→10…, phases sweep the fix grid, never back to 0', () => {
    const { knots, durationS } = stepResponseKnots(20);
    const steps = knots.filter((k, i) => i > 0 && k[0] === knots[i - 1]?.[0]);
    expect(steps).toHaveLength(20);
    expect(steps[0]).toEqual([15.05, 20]);
    expect(new Set(steps.map((k) => Math.round((k[0] % 1) * 100))).size).toBe(10);
    expect(knots.slice(2).every((k) => k[1] === 10 || k[1] === 20)).toBe(true); // after the first step
    expect(durationS).toBeGreaterThan(steps[steps.length - 1]?.[0] ?? 0);
  });
});

describe('fixtures', () => {
  it('builds the eight traces in the documented order, deterministically', () => {
    const a = buildAllTraces();
    expect(a.map((t) => t.meta.name)).toEqual([...FIXTURE_NAMES]);
    expect(JSON.stringify(buildAllTraces())).toBe(JSON.stringify(a));
  });

  it('serialiseTrace round-trips through JSON.parse', () => {
    for (const trace of buildAllTraces()) expect(JSON.parse(serialiseTrace(trace))).toEqual(trace);
  });

  it.each(FIXTURE_NAMES)('committed %s.json is exactly what the generator writes', (name) => {
    const trace = buildAllTraces().find((t) => t.meta.name === name);
    expect(trace).toBeDefined();
    if (trace === undefined) return;
    expect(readFileSync(fixturePath(name), 'utf8')).toBe(serialiseTrace(trace));
  });

  /** Lag-1 autocorrelation of the position error (sAlongM − true distance at the measurement time). */
  function lag1(name: string): number {
    const tr = buildAllTraces().find((t) => t.meta.name === name);
    const knots = (tr?.truth ?? []).map((p) => [p.t, p.v] as const);
    const s = (tr?.fixes ?? []).map((f) => f.sAlongM - distanceAt(knots, f.t - (tr?.meta.latencyS ?? 0)));
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < s.length; i++) {
      const d = (s[i] ?? 0) - mean;
      den += d * d;
      if (i > 0) num += d * ((s[i - 1] ?? 0) - mean);
    }
    return num / den;
  }

  it('position noise is time-correlated (Gauss–Markov), not white', () => {
    expect(lag1('intel-null-speed')).toBeGreaterThan(0.8);
    expect(lag1('city-amd')).toBeGreaterThan(0.8);
  });

  it('stoplight-jitter adds the white σ = 1 m component (contract A9): visibly less correlated', () => {
    expect(lag1('stoplight-jitter')).toBeLessThan(0.8);
    expect(lag1('stoplight-jitter')).toBeLessThan(lag1('intel-null-speed') - 0.1);
  });
});
```

- [ ] **Step 7: Run it to see it fail**

```bash
npx vitest run tests/unit/make-synthetic-replay.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../tools/make-synthetic-replay' imported from …` (from the test or from `tests/helpers/replay-harness.ts`).

- [ ] **Step 8: Implement `tools/make-synthetic-replay.ts`**

Noise model (contract A9, documented in the file header): position noise is first-order Gauss–Markov with stationary σ = accuracy/2 and a 60 s correlation time (white 1 Hz noise would make the contract's cumulative-distance position measurement read several m/s at standstill — the reason for contract amendment A9); `stoplight-jitter` additionally carries a white component σ = 1 m (`posWhiteSigmaM`), which exercises Task 2's A3 standstill deadband (with the trace's 0–0.4 m/s readings — its zeros usable under the A2 rule — the speed measurements already hold standstill; the replay test also runs it with every speed nulled, where only A3 keeps the filter mostly in standstill). The step-response trace never returns to 0 m/s so that criterion (a) is not confounded by the zero-speed latch.

```ts
/**
 * Deterministic synthetic GPS replay traces with ground truth (phase-1 contract, T3).
 *
 *   npx tsx tools/make-synthetic-replay.ts            # writes tests/fixtures/replay/*.json
 *
 * Model: fixes are measured every CADENCE_S on a fixed grid and delivered LATENCY_S later.
 * Accuracy wanders slowly in [4, 8] m. Position noise is a first-order Gauss–Markov process with
 * stationary σ = accuracy/2 and correlation time POS_NOISE_TAU_S (GNSS position error is
 * time-correlated; white 1 Hz noise is not what receivers output) — contract A9. The
 * stoplight-jitter trace adds a white component σ = 1 m on top (A9; it exercises the A3 standstill
 * deadband). Speed noise is white, σ = 0.15 m/s, clamped ≥ 0. Positions are 1-D distances along a
 * fake straight line; no coordinates exist anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReplayFix, ReplayTrace } from '../src/sim/replay';

export const CADENCE_S = 1.0;
export const LATENCY_S = 1.0;
export const SPEED_NOISE_SD = 0.15;
export const POS_NOISE_TAU_S = 60;
export const FIXTURE_DIR = 'tests/fixtures/replay';

/** Ground-truth speed as a piecewise-linear function: knots [t, v]; equal t = instantaneous step. */
export type Knot = readonly [t: number, v: number];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller (one value per call; deterministic for a given rand). */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const w = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

/** Builds knots from a start speed and segments [durationS, endSpeed] (linear ramps; 0 duration = step). */
export function knotsFrom(v0: number, segments: readonly (readonly [number, number])[]): Knot[] {
  const knots: Knot[] = [[0, v0]];
  let t = 0;
  for (const [dur, vEnd] of segments) {
    t += dur;
    knots.push([t, vEnd]);
  }
  return knots;
}

/** Truth speed at t (right-continuous at steps); constant beyond the last knot. */
export function speedAt(knots: readonly Knot[], t: number): number {
  let v = knots[0]?.[1] ?? 0;
  for (let i = 1; i < knots.length; i++) {
    const k0 = knots[i - 1];
    const k1 = knots[i];
    if (k0 === undefined || k1 === undefined) break;
    if (t < k1[0]) {
      const span = k1[0] - k0[0];
      return span > 0 ? k0[1] + ((k1[1] - k0[1]) * (t - k0[0])) / span : k0[1];
    }
    v = k1[1];
  }
  return v;
}

/** Exact distance travelled from 0 to t (integral of the piecewise-linear speed). */
export function distanceAt(knots: readonly Knot[], t: number): number {
  let s = 0;
  for (let i = 1; i < knots.length; i++) {
    const k0 = knots[i - 1];
    const k1 = knots[i];
    if (k0 === undefined || k1 === undefined) break;
    if (t <= k0[0]) return s;
    const tEnd = Math.min(t, k1[0]);
    const span = k1[0] - k0[0];
    if (span > 0) {
      const vEnd = k0[1] + ((k1[1] - k0[1]) * (tEnd - k0[0])) / span;
      s += ((k0[1] + vEnd) / 2) * (tEnd - k0[0]);
    }
    if (t <= k1[0]) return s;
  }
  const last = knots[knots.length - 1];
  if (last !== undefined && t > last[0]) s += last[1] * (t - last[0]);
  return s;
}

/** Rounds to `dp` decimals without producing "-0" (shared with tools/gpx-to-replay.ts). */
export function round(x: number, dp: number): number {
  const m = 10 ** dp;
  const r = Math.round(x * m) / m;
  return r === 0 ? 0 : r; // no "-0" in JSON
}

export type SpeedMode = 'present' | 'zero' | 'null';

export interface TraceSpec {
  name: string;
  notes: string;
  seed: number;
  knots: Knot[];
  durationS: number;
  speed: SpeedMode;
  /** Measurement-time windows [from, to) with no fixes (tunnels). */
  gaps?: readonly (readonly [number, number])[];
  /** Additional WHITE position-noise σ (m) on top of the Gauss–Markov component (contract A9: stoplight). */
  posWhiteSigmaM?: number;
  /** Hard clamp on |position noise| (m). */
  posClampM?: number;
  /** Speed reading generator overriding truth + noise (stoplight). */
  speedReading?: (rand: () => number) => number;
}

/** Generates one trace on the standard grid (measured k·CADENCE_S, delivered + LATENCY_S). */
export function makeTrace(spec: TraceSpec): ReplayTrace {
  const rand = mulberry32(spec.seed);
  const rho = Math.exp(-CADENCE_S / POS_NOISE_TAU_S);
  const drive = Math.sqrt(1 - rho * rho);
  const accPhase = rand() * 2 * Math.PI;
  let u = gaussian(rand);
  const fixes: ReplayFix[] = [];
  for (let k = 0; k * CADENCE_S <= spec.durationS; k++) {
    const tm = k * CADENCE_S;
    u = rho * u + drive * gaussian(rand);
    const accuracyM = round(6 + 2 * Math.sin((2 * Math.PI * k) / 97 + accPhase), 1);
    const speedNoise = gaussian(rand);
    // Drawn on every grid slot (also inside gaps) when the spec has a white component, so the
    // pattern is deterministic and traces without one keep their random sequence.
    const white = spec.posWhiteSigmaM !== undefined ? spec.posWhiteSigmaM * gaussian(rand) : 0;
    const inGap = (spec.gaps ?? []).some(([a, b]) => tm >= a && tm < b);
    if (inGap) continue;
    let noise = u * (accuracyM / 2) + white;
    if (spec.posClampM !== undefined) noise = Math.max(-spec.posClampM, Math.min(spec.posClampM, noise));
    const vTrue = speedAt(spec.knots, tm);
    let speedMps: number | null;
    if (spec.speed === 'null') speedMps = null;
    else if (spec.speed === 'zero') speedMps = 0;
    else if (spec.speedReading !== undefined) speedMps = round(spec.speedReading(rand), 2);
    else speedMps = round(Math.max(0, vTrue + SPEED_NOISE_SD * speedNoise), 2);
    fixes.push({
      t: round(tm + LATENCY_S, 3),
      sAlongM: round(distanceAt(spec.knots, tm) + noise, 2),
      speedMps,
      accuracyM,
    });
  }
  // Truth covers the whole replay window: up to the last delivery (durationS + LATENCY_S).
  const truthEnd = spec.durationS + LATENCY_S;
  const truth: { t: number; v: number }[] = spec.knots
    .filter(([t]) => t <= truthEnd)
    .map(([t, v]) => ({ t: round(t, 3), v: round(v, 3) }));
  const lastT = truth[truth.length - 1]?.t ?? 0;
  if (lastT < truthEnd) truth.push({ t: round(truthEnd, 3), v: round(speedAt(spec.knots, truthEnd), 3) });
  return {
    meta: { name: spec.name, cadenceS: CADENCE_S, latencyS: LATENCY_S, source: 'synthetic', notes: spec.notes },
    fixes,
    truth,
  };
}

/** Repeated/cached and stale deliveries layered onto a clean trace (Tesla repeats cached fixes). */
export function withStaleDuplicates(base: ReplayTrace): ReplayTrace {
  const out: ReplayFix[] = [];
  base.fixes.forEach((f, i) => {
    if (i >= 20 && i < 30) {
      // GPS freeze: the fix measured at i = 20 is re-delivered every second, ageing 1 → 10 s.
      const frozen = base.fixes[20];
      if (frozen === undefined) return;
      out.push({ ...frozen, t: f.t, ageS: round(LATENCY_S + (i - 20) * CADENCE_S, 3) });
      return;
    }
    out.push({ ...f, ageS: LATENCY_S });
    if (i === base.fixes.length - 1) return; // nothing after the last regular delivery
    if (i % 7 === 3) {
      // Cached repeat 0.5 s later: same measurement, older by 0.5 s → same tFix.
      out.push({ ...f, t: round(f.t + 0.5, 3), ageS: round(LATENCY_S + 0.5, 3) });
    }
    if (i % 11 === 5) {
      // Out-of-order straggler: measured 0.6 s before this fix, delivered 0.3 s after it.
      out.push({ ...f, t: round(f.t + 0.3, 3), ageS: round(LATENCY_S + 0.3 + 0.6, 3) });
    }
  });
  out.sort((x, y) => x.t - y.t);
  return { ...base, fixes: out };
}

/**
 * Criterion (a) truth: 0 for 15 s, then the cycle 20 → 20 → 10 m/s (each level held ≈15 s), i.e.
 * 0→20→20→10→20→20→10… Step instants walk through the fix phase in 0.1 s increments. The speed
 * never returns to 0, so the zero-speed rule is not exercised here (see stoplight/intel traces).
 */
export function stepResponseKnots(steps: number): { knots: Knot[]; durationS: number } {
  const cycle = [20, 20, 10];
  const knots: Knot[] = [[0, 0]];
  let prev = 0;
  let made = 0;
  let slot = 1;
  while (made < steps) {
    const level = cycle[(slot - 1) % cycle.length] ?? 0;
    if (level !== prev) {
      const tStep = 15 * slot + 0.05 + 0.1 * (made % 10);
      knots.push([tStep, prev], [tStep, level]);
      prev = level;
      made++;
    }
    slot++;
  }
  return { knots, durationS: 15 * slot + 1 };
}

const CITY: Knot[] = knotsFrom(0, [
  [5, 0], [6, 13.9], [12, 13.9], [12, 0], [8, 0],
  [5, 11], [10, 11], [3, 5], [6, 5], [4, 14], [8, 14], [12, 0], [10, 0],
]);
const HIGHWAY: Knot[] = knotsFrom(0, [[3, 0], [6, 20], [8, 36.11], [30, 36.11], [10, 30], [20, 30]]);
const INTEL: Knot[] = knotsFrom(0, [[5, 0], [8, 20], [20, 20], [7, 0], [8, 0], [6, 15], [15, 15]]);
const TUNNEL: Knot[] = knotsFrom(0, [[2, 0], [10, 25], [70, 25]]);
const STOPLIGHT: Knot[] = [[0, 0]];

export function buildAllTraces(): ReplayTrace[] {
  const step = stepResponseKnots(20);
  return [
    makeTrace({ name: 'city-amd', notes: 'stop-go city driving, coords.speed present (AMD)', seed: 101, knots: CITY, durationS: 100, speed: 'present' }),
    makeTrace({ name: 'highway-amd', notes: '0→130 km/h, cruise, lift-off to 108 km/h, speed present', seed: 102, knots: HIGHWAY, durationS: 77, speed: 'present' }),
    makeTrace({ name: 'intel-zero-speed', notes: 'Intel MCU2: coords.speed always 0 while moving', seed: 103, knots: INTEL, durationS: 69, speed: 'zero' }),
    makeTrace({ name: 'intel-null-speed', notes: 'coords.speed always null (position-only path)', seed: 104, knots: INTEL, durationS: 69, speed: 'null' }),
    makeTrace({ name: 'tunnel-dropout', notes: '25 m/s cruise with a 35 s fix-arrival gap (tunnel)', seed: 105, knots: TUNNEL, durationS: 82, speed: 'present', gaps: [[20, 54]] }),
    makeTrace({
      name: 'stoplight-jitter', notes: 'stationary; Gauss–Markov wander plus white σ = 1 m (A9), clamped to ±4 m; speed 0–0.4 m/s', seed: 106, knots: STOPLIGHT,
      durationS: 90, speed: 'present', posWhiteSigmaM: 1, posClampM: 4,
      speedReading: (rand) => Math.min(0.4, Math.max(0, 0.2 * gaussian(rand))),
    }),
    withStaleDuplicates(makeTrace({ name: 'stale-duplicates', notes: 'cached repeats, a 10 s freeze (ages 1–10 s) and out-of-order stragglers', seed: 107, knots: CITY, durationS: 60, speed: 'present' })),
    makeTrace({ name: 'step-response', notes: 'speed steps 0→20→20→10 m/s held 15 s, step phase sweeps the fix grid (criterion a)', seed: 108, knots: step.knots, durationS: step.durationS, speed: 'present' }),
  ];
}

/** Stable JSON: one fix / truth point per line (reviewable diffs). */
export function serialiseTrace(trace: ReplayTrace): string {
  const lines: string[] = ['{', `"meta": ${JSON.stringify(trace.meta)},`, '"fixes": ['];
  trace.fixes.forEach((f, i) => lines.push(JSON.stringify(f) + (i < trace.fixes.length - 1 ? ',' : '')));
  const truth = trace.truth;
  if (truth === undefined) {
    lines.push(']');
  } else {
    lines.push('],', '"truth": [');
    truth.forEach((p, i) => lines.push(JSON.stringify(p) + (i < truth.length - 1 ? ',' : '')));
    lines.push(']');
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

export function main(rootDir: string): void {
  const dir = join(rootDir, FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  for (const trace of buildAllTraces()) {
    writeFileSync(join(dir, `${trace.meta.name}.json`), serialiseTrace(trace));
    console.log(`wrote ${FIXTURE_DIR}/${trace.meta.name}.json (${trace.fixes.length} fixes)`);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
```

- [ ] **Step 9: Generate the fixtures**

```bash
npx tsx tools/make-synthetic-replay.ts && sha256sum tests/fixtures/replay/*.json
```

Expected output (the hashes are a cross-check; the Step 10 test is authoritative):

```text
wrote tests/fixtures/replay/city-amd.json (101 fixes)
wrote tests/fixtures/replay/highway-amd.json (78 fixes)
wrote tests/fixtures/replay/intel-zero-speed.json (70 fixes)
wrote tests/fixtures/replay/intel-null-speed.json (70 fixes)
wrote tests/fixtures/replay/tunnel-dropout.json (49 fixes)
wrote tests/fixtures/replay/stoplight-jitter.json (91 fixes)
wrote tests/fixtures/replay/stale-duplicates.json (73 fixes)
wrote tests/fixtures/replay/step-response.json (467 fixes)
9fd0482c4030592f22c869cc76aa3fbd306848c1f99d0eb9bd8704c0f6e77401  city-amd.json
644ffcc5da427c386a1216392261b9063677afc72b729c1389cf0972d7d31e95  highway-amd.json
3573a595cd60470f618b9ddf981aead6a07e80c6c5b43bb2e4a0fb487f1c3057  intel-null-speed.json
ad4ac072b9e7698b6837bf64ff4e1c55ebde3462556502bec0ae5a9dff70e5f7  intel-zero-speed.json
5cf00b4f077b85d012a53d5707d6466b8d773dbec7a73d2c3531960de905796e  stale-duplicates.json
b9709ae6f0cca0aa52dcea3ff50ffa42cb75af76effc6305f3832ba7da5be840  step-response.json
26a361456dbb7007857357510d676f511ec06b226492d14450b621c94d899692  stoplight-jitter.json
b1049fd30d1679a339d8c3b927bb24eb1ee3af13f9c0786d544944c8b822a255  tunnel-dropout.json
```

If the hashes differ, `diff` your `tools/make-synthetic-replay.ts` against Step 8 before continuing.

- [ ] **Step 10: Run the generator test to see it pass**

```bash
npx vitest run tests/unit/make-synthetic-replay.test.ts
```

Expected: PASS — `Tests  18 passed (18)`.

- [ ] **Step 11: Replace `tests/unit/replay.test.ts` with the full version (feeder + fixture structure + SpeedFilter on fixtures, incl. RF2 and RF3)**

Overwrite `tests/unit/replay.test.ts` with:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { F } from '../../src/contracts';
import type { FixMsg } from '../../src/contracts';
import { haversineM } from '../../src/platform/geo';
import { METRES_PER_DEG_LON_AT_EQUATOR, ReplayFeeder } from '../../src/sim/replay';
import type { ReplayTrace } from '../../src/sim/replay';
import {
  DT_S,
  FIXTURE_NAMES,
  fixturePath,
  idx,
  knotsOf,
  loadTrace,
  runTrace,
  settled,
  stepsOf,
  truthAt,
} from '../helpers/replay-harness';

const TINY: ReplayTrace = {
  meta: { name: 'tiny', cadenceS: 1, latencyS: 0.8, source: 'synthetic' },
  fixes: [
    { t: 1, sAlongM: 0, speedMps: 3, accuracyM: 5 },
    { t: 2, sAlongM: 111.31949, speedMps: null, accuracyM: 6 },
    { t: 2, sAlongM: 222.63898, speedMps: 0, accuracyM: 7, ageS: 2.5 },
  ],
};

function blankFix(): FixMsg {
  return { type: 'fix', ageS: -1, speedMps: -1, lat: 9, lon: 9, accuracyM: -1, altitudeM: 123 };
}

describe('ReplayFeeder', () => {
  it('delivers fixes in order once their t ≤ nowS, one per call, as fake equator positions', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    expect(feeder.next(0.999, out)).toBe(false);
    expect(out.ageS).toBe(-1); // untouched when nothing is due

    expect(feeder.next(1, out)).toBe(true);
    expect(out).toEqual({ type: 'fix', ageS: 0.8, speedMps: 3, lat: 0, lon: 0, accuracyM: 5, altitudeM: null });
    expect(feeder.next(1.5, out)).toBe(false);

    expect(feeder.next(2.5, out)).toBe(true);
    expect(out.lon).toBeCloseTo(111.31949 / METRES_PER_DEG_LON_AT_EQUATOR, 15);
    expect(out.speedMps).toBeNull();
    expect(out.ageS).toBe(0.8); // meta.latencyS default
    expect(feeder.next(2.5, out)).toBe(true); // second fix with the same t, same call time
    expect(out.ageS).toBe(2.5); // per-fix override
    expect(out.speedMps).toBe(0);
    expect(out.accuracyM).toBe(7);
    expect(feeder.next(2.5, out)).toBe(false);
    expect(feeder.next(1e9, out)).toBe(false); // exhausted
  });

  it('reset() rewinds to the first fix', () => {
    const feeder = new ReplayFeeder(TINY);
    const out = blankFix();
    while (feeder.next(10, out)) {
      /* drain */
    }
    feeder.reset();
    expect(feeder.next(1, out)).toBe(true);
    expect(out.speedMps).toBe(3);
  });

  it('fake positions are 1° = 111319.49 m; haversine (R = 6371008.8 m) reads them 0.112 % short', () => {
    expect(METRES_PER_DEG_LON_AT_EQUATOR).toBe(111319.49);
    const d = haversineM(0, 0, 0, 1000 / METRES_PER_DEG_LON_AT_EQUATOR);
    expect(d / 1000).toBeCloseTo((6371008.8 * Math.PI) / 180 / METRES_PER_DEG_LON_AT_EQUATOR, 9);
    expect(d / 1000).toBeCloseTo(0.998882, 6);
  });
});

describe('synthetic replay fixtures — structure', () => {
  it.each(FIXTURE_NAMES)('%s is a well-formed synthetic trace without coordinates', (name) => {
    const text = readFileSync(fixturePath(name), 'utf8');
    expect(text).not.toMatch(/"(lat|lon|latitude|longitude)"/);
    const trace = loadTrace(name);
    expect(trace.meta).toMatchObject({ name, cadenceS: 1, latencyS: 1, source: 'synthetic' });
    expect(trace.fixes.length).toBeGreaterThan(40);
    let prevT = -Infinity;
    for (const f of trace.fixes) {
      expect(f.t).toBeGreaterThanOrEqual(prevT);
      prevT = f.t;
      expect(f.accuracyM).toBeGreaterThanOrEqual(4);
      expect(f.accuracyM).toBeLessThanOrEqual(8);
      expect(Number.isFinite(f.sAlongM)).toBe(true);
      if (f.speedMps !== null) expect(f.speedMps).toBeGreaterThanOrEqual(0);
    }
    const truth = trace.truth ?? [];
    expect(truth.length).toBeGreaterThan(0);
    for (let i = 1; i < truth.length; i++) expect(truth[i]?.t ?? 0).toBeGreaterThanOrEqual(truth[i - 1]?.t ?? 0);
    expect(truth[truth.length - 1]?.t ?? 0).toBeGreaterThanOrEqual(prevT);
  });

  it('encodes each scenario', () => {
    expect(loadTrace('intel-zero-speed').fixes.every((f) => f.speedMps === 0)).toBe(true);
    expect(loadTrace('intel-null-speed').fixes.every((f) => f.speedMps === null)).toBe(true);
    expect(loadTrace('stoplight-jitter').truth?.every((p) => p.v === 0)).toBe(true);
    const stop = loadTrace('stoplight-jitter').fixes;
    expect(Math.max(...stop.map((f) => Math.abs(f.sAlongM)))).toBeLessThanOrEqual(4);
    expect(Math.max(...stop.map((f) => f.speedMps ?? 0))).toBeLessThanOrEqual(0.4);
    expect(stop.some((f) => f.speedMps === 0)).toBe(true);

    const tunnel = loadTrace('tunnel-dropout').fixes;
    const gaps = tunnel.slice(1).map((f, i) => f.t - (tunnel[i]?.t ?? 0));
    expect(Math.max(...gaps)).toBe(35);

    const stale = loadTrace('stale-duplicates').fixes;
    expect(Math.max(...stale.map((f) => f.ageS ?? 0))).toBe(10);
    expect(stale.every((f) => f.ageS !== undefined)).toBe(true);

    expect(stepsOf(loadTrace('step-response'))).toHaveLength(20);
  });
});

describe('SpeedFilter on synthetic replay fixtures', () => {
  /** Max |v − truth| while moving and count of non-standstill quanta at stops, over settled windows. */
  function settledErrors(name: string, windowS = 6): { moveErr: number; stopBad: number; samples: number } {
    const trace = loadTrace(name);
    const run = runTrace(trace);
    const knots = knotsOf(trace);
    let moveErr = 0;
    let stopBad = 0;
    let samples = 0;
    for (let i = 0; i < run.v.length; i++) {
      const t = i * DT_S;
      const flags = run.flags[i] ?? 0;
      if (flags & F.PREDICTING || !settled(knots, t, windowS)) continue;
      samples++;
      const vTrue = truthAt(knots, t);
      const v = run.v[i] ?? Number.NaN;
      if (vTrue > 0) moveErr = Math.max(moveErr, Math.abs(v - vTrue));
      else if (!(flags & F.STANDSTILL) || v !== 0) stopBad++;
    }
    return { moveErr, stopBad, samples };
  }

  function everLatched(name: string): boolean {
    return runTrace(loadTrace(name)).flags.some((fl) => (fl & F.SPEED_UNUSABLE) !== 0);
  }

  it('city-amd: tracks within 1.0 m/s when settled, stands still at stops, never latches SPEED_UNUSABLE', () => {
    const e = settledErrors('city-amd');
    expect(e.samples).toBeGreaterThan(5000);
    expect(e.moveErr).toBeLessThanOrEqual(1.0);
    expect(e.stopBad).toBe(0);
    expect(everLatched('city-amd')).toBe(false);
  });

  it('highway-amd: tracks within 1.0 m/s when settled and never exceeds 130 km/h by more than 2.5 m/s', () => {
    const e = settledErrors('highway-amd');
    expect(e.moveErr).toBeLessThanOrEqual(1.0);
    const run = runTrace(loadTrace('highway-amd'));
    expect(run.v.reduce((m, x) => Math.max(m, x), 0)).toBeLessThanOrEqual(36.11 + 2.5);
  });

  it('RF2 intel-zero-speed: SPEED_UNUSABLE latches once moving and v tracks the truth via position', () => {
    const run = runTrace(loadTrace('intel-zero-speed'));
    const first = run.flags.findIndex((fl) => (fl & F.SPEED_UNUSABLE) !== 0);
    expect(first).toBeGreaterThan(0);
    const latchS = first * DT_S;
    // Car pulls away at 5 s (2.5 m/s²): fix-to-fix steps reach 8 m at the fix measured at 9 s, so
    // three consecutive moving zeros (d1, d0 ≥ 8 m, contract A2) end with the fix measured at 12 s,
    // which arrives at 13.0 s → latch.
    expect(latchS).toBeGreaterThanOrEqual(12);
    expect(latchS).toBeLessThanOrEqual(13.5);
    expect(run.flags.slice(first).every((fl) => (fl & F.SPEED_UNUSABLE) !== 0)).toBe(true); // session-long
    const e = settledErrors('intel-zero-speed');
    expect(e.moveErr).toBeLessThanOrEqual(1.5);
    expect(e.stopBad).toBe(0);
  });

  it('intel-null-speed: null speed never latches; position path tracks within 1.5 m/s when settled', () => {
    expect(everLatched('intel-null-speed')).toBe(false);
    const e = settledErrors('intel-null-speed');
    expect(e.moveErr).toBeLessThanOrEqual(1.5);
    expect(e.stopBad).toBe(0);
  });

  it('RF3 tunnel-dropout: predicting after 2 s, no snap, GPS_LOST after 20 s, 0 by 30 s, recovers', () => {
    const run = runTrace(loadTrace('tunnel-dropout'));
    const at = (t: number): { v: number; flags: number } => ({ v: run.v[idx(t)] ?? NaN, flags: run.flags[idx(t)] ?? 0 });
    // Last fix before the tunnel arrives at 20.0 s; the next at 55.0 s.
    expect(at(21.9).flags & (F.PREDICTING | F.GPS_LOST)).toBe(0);
    expect(at(22.1).flags & F.PREDICTING).toBe(F.PREDICTING);
    expect(at(22.1).v).toBeCloseTo(25, 0);
    expect(at(39.9).flags & F.GPS_LOST).toBe(0);
    const held = at(39.9).v;
    expect(Math.abs(held - 25)).toBeLessThanOrEqual(1);
    expect(at(40.1).flags & F.GPS_LOST).toBe(F.GPS_LOST);
    expect(Math.abs(at(40.01).v - at(39.99).v)).toBeLessThan(0.05); // no snap at the 20 s boundary
    expect(at(45).v).toBeCloseTo(held * 0.5, 1);
    for (let t = 50; t < 55; t += 0.25) {
      expect(at(t).v).toBe(0);
      expect(at(t).flags & (F.GPS_LOST | F.STANDSTILL)).toBe(F.GPS_LOST | F.STANDSTILL);
    }
    for (let i = idx(40); i < idx(50); i++) expect(run.v[i + 1] ?? 0).toBeLessThanOrEqual((run.v[i] ?? 0) + 1e-9); // ease is monotonic
    expect(at(55).flags & (F.GPS_LOST | F.PREDICTING | F.STANDSTILL)).toBe(0);
    expect(Math.abs(at(55).v - 25)).toBeLessThanOrEqual(1);
    expect(Math.abs(at(58).v - 25)).toBeLessThanOrEqual(1);
  });

  it('stoplight-jitter: ±4 m wander (Gauss–Markov + white σ = 1 m, A9) and 0–0.4 m/s readings never leave standstill', () => {
    const trace = loadTrace('stoplight-jitter');
    const run = runTrace(trace);
    expect(run.accepted).toBe(91);
    expect(run.rejected).toBe(0);
    for (let i = idx(1); i < run.v.length; i++) {
      expect(run.v[i]).toBe(0);
      expect((run.flags[i] ?? 0) & (F.STANDSTILL | F.SPEED_UNUSABLE)).toBe(F.STANDSTILL);
    }
    // Position-only at the same stop (speeds nulled): the A3 deadband keeps the filter in standstill
    // most of the time although some noise steps exceed 0.4·accuracy (measured 77.7 % of quanta;
    // 34.0 % without the deadband).
    const posOnly = runTrace({ ...trace, fixes: trace.fixes.map((f) => ({ ...f, speedMps: null })) });
    let still = 0;
    for (const fl of posOnly.flags) if (fl & F.STANDSTILL) still++;
    expect(still / posOnly.flags.length).toBeGreaterThan(0.7);
  });

  it('stale-duplicates: rejects 21 repeats/stale/out-of-order fixes, holds v through the freeze, recovers', () => {
    const run = runTrace(loadTrace('stale-duplicates'));
    expect(run.accepted).toBe(52);
    expect(run.rejected).toBe(21); // 9 freeze repeats + 8 cached repeats + 4 stragglers
    // Freeze: last accepted arrival 21.0 s; repeats of that fix (ages 2–10 s) arrive 22–30 s.
    expect((run.flags[idx(22.9)] ?? 0) & F.PREDICTING).toBe(0);
    expect((run.flags[idx(23.1)] ?? 0) & F.PREDICTING).toBe(F.PREDICTING);
    expect((run.flags[idx(30.9)] ?? 0) & F.PREDICTING).toBe(F.PREDICTING);
    for (let t = 21; t <= 30.9; t += 0.1) {
      const v = run.v[idx(t)] ?? 0;
      expect(v).toBeGreaterThan(13);
      expect(v).toBeLessThan(15);
    }
    expect((run.flags[idx(31)] ?? 0) & F.PREDICTING).toBe(0);
    const knots = knotsOf(loadTrace('stale-duplicates'));
    expect(Math.abs((run.v[idx(31)] ?? 0) - truthAt(knots, 31))).toBeLessThanOrEqual(1.5);
    expect((run.flags[idx(37)] ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(settledErrors('stale-duplicates').moveErr).toBeLessThanOrEqual(1.0);
  });
});

/** Recorded fixtures: tools/gpx-to-replay.ts output (`meta.source: 'gpx'`) committed next to the synthetic ones. */
const RECORDED = readdirSync(new URL('../fixtures/replay/', import.meta.url))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.slice(0, -'.json'.length))
  .filter((name) => loadTrace(name).meta.source === 'gpx');

describe('recorded (gpx) replay fixtures — spec §15 exit gate', () => {
  if (RECORDED.length === 0) {
    it.skip('no recorded fixture committed yet (record a phone GPX, convert with tools/gpx-to-replay.ts, commit only the JSON)', () => {});
  } else {
    it.each(RECORDED)("%s: position-free; the filter output stays finite and its peak matches the trace's own speeds", (name) => {
      const text = readFileSync(fixturePath(name), 'utf8');
      expect(text).not.toMatch(/"(lat|lon|latitude|longitude|time)"/);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no absolute timestamps
      const trace = loadTrace(name);
      expect(trace.fixes.length).toBeGreaterThan(1);
      for (let i = 1; i < trace.fixes.length; i++) expect(trace.fixes[i]?.t ?? 0).toBeGreaterThanOrEqual(trace.fixes[i - 1]?.t ?? 0);
      const run = runTrace(trace);
      expect(run.accepted).toBeGreaterThan(0);
      for (const v of run.v) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(70);
      }
      // Plausibility against the trace's own positions (catches a filter stuck at 0 or running away):
      // vRef = the highest mean speed over 5 fix intervals (5 s at 1 Hz; measurement time t − ageS).
      // Bounds calibrated on the synthetic fixtures with speeds present and nulled: peak / vRef is
      // 0.93–1.49 (prediction overshoot after accelerations and speed steps). Skipped only for a trace
      // with fewer than 6 fixes or one that never moves (vRef < 3 m/s: GNSS jitter at a stop).
      const fixes = trace.fixes;
      const tMeas = (i: number): number => (fixes[i]?.t ?? 0) - (fixes[i]?.ageS ?? trace.meta.latencyS);
      let vRef = 0;
      for (let i = 0; i + 5 < fixes.length; i++) {
        const dt = tMeas(i + 5) - tMeas(i);
        if (dt > 0) vRef = Math.max(vRef, ((fixes[i + 5]?.sAlongM ?? 0) - (fixes[i]?.sAlongM ?? 0)) / dt);
      }
      if (fixes.length >= 6 && vRef >= 3) {
        const vMax = run.v.reduce((m, x) => Math.max(m, x), 0);
        expect(vMax, `filter peak vs 5-interval reference ${vRef.toFixed(2)} m/s`).toBeGreaterThanOrEqual(0.8 * vRef - 1);
        expect(vMax, `filter peak vs 5-interval reference ${vRef.toFixed(2)} m/s`).toBeLessThanOrEqual(1.5 * vRef + 4);
      }
    });
  }
});
```

- [ ] **Step 12: Run the replay tests**

```bash
npx vitest run tests/unit/replay.test.ts
```

Expected: PASS — `Tests  19 passed | 1 skipped (20)` (the skipped test is the recorded-fixture placeholder: no `meta.source: 'gpx'` fixture is committed yet — Task 12 reports that exit-gate item; once one is committed it runs instead). These exercise the already-implemented Task 2 filter on the new fixtures, so they pass on the first run. A failure means the generator or filter deviates from this plan: do not change thresholds — diff `tools/make-synthetic-replay.ts` against Step 8 and `src/sim/speed-filter.ts` against Task 2.

- [ ] **Step 13: Write the criterion (a) test**

Create `tests/unit/criterion-a.test.ts`. It asserts the bounds of contract amendment A1 (spec §1.3(a) as amended): the speed path p95 ≤ `latencyS + cadenceS + 0.2` (2.2 s) and the position-only path p95 ≤ `latencyS + 2·cadenceS` (3.0 s — 1 Hz position-only tracking cannot physically reach 2.2 s). Both are plain assertions; neither bound may be loosened.

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING } from '../../src/contracts';
import type { ReplayTrace } from '../../src/sim/replay';
import { DT_S, loadTrace, percentile, runTrace, stepsOf } from '../helpers/replay-harness';

/**
 * Spec §1.3(a) as amended by contract A1: p95 time from a true-speed step to 63 % of the response
 * ≤ fix lag + one fix interval + 0.2 s on the coords.speed path, and ≤ fix lag + two fix intervals
 * on the position-only path. ReplayFeeder → SpeedFilter at dt = 128/48000 with the shipped
 * DEFAULT_SIM_TUNING.
 */
const trace = loadTrace('step-response');
const BOUND_S = trace.meta.latencyS + trace.meta.cadenceS + 0.2;
const POSITION_BOUND_S = trace.meta.latencyS + 2 * trace.meta.cadenceS;
const positionOnly: ReplayTrace = { ...trace, fixes: trace.fixes.map((f) => ({ ...f, speedMps: null })) };

/** Seconds from each truth step until the filter output first reaches 63 % of that step. */
function responseTimes(tr: ReplayTrace): number[] {
  const run = runTrace(tr, DEFAULT_SIM_TUNING);
  return stepsOf(tr).map((step) => {
    const target = step.from + 0.63 * (step.to - step.from);
    const rising = step.to > step.from;
    for (let i = Math.ceil(step.t / DT_S); i < run.v.length; i++) {
      const v = run.v[i] ?? Number.NaN;
      if (rising ? v >= target : v <= target) return i * DT_S - step.t;
    }
    return Number.POSITIVE_INFINITY;
  });
}

describe('criterion (a) — speed path p95 ≤ latency + cadence + 0.2 s; position path p95 ≤ latency + 2·cadence (A1)', () => {
  it('uses the 2.2 s / 3.0 s bounds of the synthetic GPS model (1 s lag, 1 s cadence)', () => {
    expect(BOUND_S).toBeCloseTo(2.2, 12);
    expect(POSITION_BOUND_S).toBeCloseTo(3.0, 12);
    expect(stepsOf(trace)).toHaveLength(20);
  });

  it('speed path (coords.speed present) meets latency + cadence + 0.2 s', () => {
    const p95 = percentile(responseTimes(trace), 95);
    console.info(`criterion (a) speed path: p95 = ${p95.toFixed(3)} s (bound ${BOUND_S.toFixed(1)} s)`);
    expect(p95).toBeLessThanOrEqual(BOUND_S);
  });

  it('position path (every speedMps null) meets latency + 2·cadence (contract A1)', () => {
    const p95 = percentile(responseTimes(positionOnly), 95);
    console.info(`criterion (a) position path: p95 = ${p95.toFixed(3)} s (bound ${POSITION_BOUND_S.toFixed(1)} s)`);
    expect(p95).toBeLessThanOrEqual(POSITION_BOUND_S);
  });
});
```

- [ ] **Step 14: Run the criterion (a) test**

```bash
npx vitest run tests/unit/criterion-a.test.ts --reporter=verbose
```

Expected: `Tests  3 passed (3)`, with stdout lines `criterion (a) speed path: p95 = 1.950 s (bound 2.2 s)` and `criterion (a) position path: p95 = 2.750 s (bound 3.0 s)`. Report both numbers in the phase hand-off. A failure of either assertion is a Phase 1 bug — never raise either bound.

- [ ] **Step 15: Write the failing GPX converter test**

Create `tests/unit/gpx-to-replay.test.ts` (fake positions on the equator only):

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayTrace } from '../../src/sim/replay';
import { GPX_ACCURACY_M, gpxToReplay, main, MAX_INTERP_GAP_S, parseGpx } from '../../tools/gpx-to-replay';
import type { GpxPoint } from '../../tools/gpx-to-replay';

/** Degrees of longitude per metre on the equator for haversineM's R (fake positions only). */
const DEG_PER_M = 180 / (6371008.8 * Math.PI);
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Fake track: lat 0, moving east at `speed` m/s, one point per second; optional speed element. */
function gpx(seconds: number, speed: number, speedTag: 'none' | 'plain' | 'garmin' = 'plain', skip: number[] = []): string {
  const pts: string[] = [];
  for (let i = 0; i < seconds; i++) {
    if (skip.includes(i)) continue;
    const time = new Date(T0 + i * 1000).toISOString();
    const lon = (speed * i * DEG_PER_M).toFixed(9);
    const sp =
      speedTag === 'plain'
        ? `<speed>${speed}</speed>`
        : speedTag === 'garmin'
          ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:speed>${speed}</gpxtpx:speed></gpxtpx:TrackPointExtension></extensions>`
          : '';
    pts.push(i % 2 === 0 ? `<trkpt lat="0" lon="${lon}"><time>${time}</time>${sp}</trkpt>` : `<trkpt lon='${lon}' lat='0'>\n  <ele>12</ele>\n  <time>${time}</time>${sp}\n</trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts.join('\n')}</trkseg></trk></gpx>`;
}

describe('parseGpx', () => {
  it('reads lat/lon in either order and quote style, time, and plain or namespaced speed', () => {
    const plain = parseGpx(gpx(3, 10, 'plain'));
    expect(plain).toHaveLength(3);
    expect(plain[0]).toEqual({ tS: T0 / 1000, lat: 0, lon: 0, speedMps: 10 });
    expect(plain[1]?.lon).toBeCloseTo(10 * DEG_PER_M, 9);
    expect(parseGpx(gpx(3, 7, 'garmin')).map((p) => p.speedMps)).toEqual([7, 7, 7]);
    expect(parseGpx(gpx(3, 7, 'none')).map((p) => p.speedMps)).toEqual([null, null, null]);
  });

  it('skips points without time or with bad numbers, sorts by time and drops repeated timestamps', () => {
    const t = (s: number) => new Date(T0 + s * 1000).toISOString();
    const xml = [
      `<trkpt lat="0" lon="0.0002"><time>${t(2)}</time></trkpt>`,
      `<trkpt lat="0" lon="0"><time>${t(0)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0001"><time>${t(1)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.00011"><time>${t(1)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0003"></trkpt>`,
      `<trkpt lat="x" lon="0.0004"><time>${t(4)}</time></trkpt>`,
      `<trkpt lat="0" lon="0.0005"><time>not a date</time></trkpt>`,
      `<trkpt lat="0" lon="0.0006"><time>${t(6)}</time><speed>-1</speed></trkpt>`,
    ].join('');
    const pts = parseGpx(xml);
    expect(pts.map((p) => p.tS - T0 / 1000)).toEqual([0, 1, 2, 6]);
    expect(pts[3]?.speedMps).toBeNull();
  });
});

describe('gpxToReplay', () => {
  const opts = { name: 'drive', latencyS: 1, cadenceS: 1, nullRate: 0 };

  it('re-samples cumulative distance to the cadence with t relative to the first point + latency', () => {
    const trace = gpxToReplay(parseGpx(gpx(11, 10)), { ...opts, cadenceS: 0.5, latencyS: 0.8 });
    expect(trace.meta).toMatchObject({ name: 'drive', cadenceS: 0.5, latencyS: 0.8, source: 'gpx' });
    expect(trace.truth).toBeUndefined();
    expect(trace.fixes).toHaveLength(21);
    trace.fixes.forEach((f, k) => {
      expect(f.t).toBeCloseTo(0.8 + 0.5 * k, 9);
      expect(f.sAlongM).toBeCloseTo(5 * k, 1);
      expect(f.speedMps).toBe(10);
      expect(f.accuracyM).toBe(GPX_ACCURACY_M);
      expect(f.ageS).toBeUndefined();
    });
  });

  it('keeps raw gaps longer than MAX_INTERP_GAP_S as gaps', () => {
    const missing = [3, 4, 5, 6, 7, 8]; // 2 → 9 is a 7 s gap
    expect(9 - 2).toBeGreaterThan(MAX_INTERP_GAP_S);
    const trace = gpxToReplay(parseGpx(gpx(15, 10, 'plain', missing)), opts);
    const ts = trace.fixes.map((f) => f.t - 1);
    expect(ts).toEqual([0, 1, 2, 9, 10, 11, 12, 13, 14]);
    expect(trace.fixes[3]?.sAlongM).toBeCloseTo(90, 1);
  });

  it('nulls speeds at the requested rate, deterministically', () => {
    const pts = parseGpx(gpx(201, 10));
    expect(gpxToReplay(pts, { ...opts, nullRate: 1 }).fixes.every((f) => f.speedMps === null)).toBe(true);
    const half = gpxToReplay(pts, { ...opts, nullRate: 0.5 });
    const nulls = half.fixes.filter((f) => f.speedMps === null).length;
    expect(nulls).toBeGreaterThan(70);
    expect(nulls).toBeLessThan(130);
    expect(gpxToReplay(pts, { ...opts, nullRate: 0.5 })).toEqual(half);
  });

  it('rejects unusable input and options', () => {
    const one: GpxPoint[] = [{ tS: 0, lat: 0, lon: 0, speedMps: null }];
    expect(() => gpxToReplay(one, opts)).toThrow(/at least 2/);
    const two = parseGpx(gpx(2, 1));
    expect(() => gpxToReplay(two, { ...opts, cadenceS: 0 })).toThrow(/cadence/);
    expect(() => gpxToReplay(two, { ...opts, latencyS: -1 })).toThrow(/latency/);
    expect(() => gpxToReplay(two, { ...opts, nullRate: 1.5 })).toThrow(/null-rate/);
  });
});

describe('gpx-to-replay CLI', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
    vi.restoreAllMocks();
  });

  it('writes a position-free ReplayTrace JSON and returns 0', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'tesbox-gpx-'));
    const input = join(dir, 'in.gpx');
    const output = join(dir, 'my-drive.json');
    writeFileSync(input, gpx(6, 12));
    expect(main([input, output, '--latency', '1.2', '--cadence', '1', '--null-rate', '0'])).toBe(0);
    const text = readFileSync(output, 'utf8');
    expect(text).not.toMatch(/"(lat|lon|time)"/);
    expect(text).not.toContain('2026-');
    const trace = JSON.parse(text) as ReplayTrace;
    expect(trace.meta.name).toBe('my-drive');
    expect(trace.meta.latencyS).toBe(1.2);
    expect(trace.fixes).toHaveLength(6);
    expect(trace.fixes[5]?.sAlongM).toBeCloseTo(60, 1);
  });

  it('returns 1 with a message on bad arguments', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main(['only-one-arg.gpx'])).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/^usage: gpx-to-replay/));
    // A real, readable input: the failure must come from the --cadence validation, not from the file.
    dir = mkdtempSync(join(tmpdir(), 'tesbox-gpx-'));
    const input = join(dir, 'in.gpx');
    writeFileSync(input, gpx(3, 5));
    expect(main([input, join(dir, 'o.json'), '--cadence', 'fast'])).toBe(1);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/--cadence must be a number/));
    expect(err).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 16: Run it to see it fail**

```bash
npx vitest run tests/unit/gpx-to-replay.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../tools/gpx-to-replay' imported from …/tests/unit/gpx-to-replay.test.ts`.

- [ ] **Step 17: Implement `tools/gpx-to-replay.ts`**

```ts
/**
 * Phone GPX log → ReplayTrace JSON with positions stripped (phase-1 contract, T3).
 *
 *   npx tsx tools/gpx-to-replay.ts <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]
 *
 * Parses <trkpt lat lon><time> (and a <speed> / <ns:speed> element if present), computes the
 * cumulative haversine distance, re-samples to the cadence (linear interpolation; raw gaps longer
 * than MAX_INTERP_GAP_S stay gaps), and writes fixes {t, sAlongM, speedMps, accuracyM} with t
 * relative to the first track point. No latitude, longitude or absolute time is written.
 * GPX inputs contain real positions: never commit them (.gitignore has *.gpx).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { haversineM } from '../src/platform/geo';
import type { ReplayFix, ReplayTrace } from '../src/sim/replay';
import { mulberry32, round, serialiseTrace } from './make-synthetic-replay';

export interface GpxPoint {
  /** Epoch seconds (only used for differences; never written). */
  tS: number;
  lat: number;
  lon: number;
  speedMps: number | null;
}

export interface GpxOptions {
  name: string;
  latencyS: number;
  cadenceS: number;
  /** Fraction of output fixes whose speed is replaced by null (deterministic PRNG). */
  nullRate: number;
}

/** GPX has no standard accuracy field; replay fixes get a constant, typical phone value. */
export const GPX_ACCURACY_M = 5;
/** Raw track gaps longer than this are not interpolated across (keeps real dropouts). */
export const MAX_INTERP_GAP_S = 5;
const NULL_RATE_SEED = 0x7e5b0c;

const TRKPT = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const LAT = /\blat\s*=\s*["']([^"']+)["']/;
const LON = /\blon\s*=\s*["']([^"']+)["']/;
const TIME = /<time>\s*([^<]+?)\s*<\/time>/;
const SPEED = /<(?:[\w-]+:)?speed>\s*([^<]+?)\s*<\/(?:[\w-]+:)?speed>/;

/** Extracts timed track points, sorted by time, dropping points without a valid time/position and repeated timestamps. */
export function parseGpx(xml: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const m of xml.matchAll(TRKPT)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const lat = Number(LAT.exec(attrs)?.[1]);
    const lon = Number(LON.exec(attrs)?.[1]);
    const timeText = TIME.exec(body)?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || timeText === undefined) continue;
    const tMs = Date.parse(timeText);
    if (!Number.isFinite(tMs)) continue;
    const speedText = SPEED.exec(body)?.[1];
    const speed = speedText === undefined ? Number.NaN : Number(speedText);
    points.push({ tS: tMs / 1000, lat, lon, speedMps: Number.isFinite(speed) && speed >= 0 ? speed : null });
  }
  points.sort((a, b) => a.tS - b.tS);
  return points.filter((p, i) => i === 0 || p.tS > (points[i - 1]?.tS ?? Number.NEGATIVE_INFINITY));
}

/** Re-samples timed points to the cadence and builds a position-free ReplayTrace. */
export function gpxToReplay(points: readonly GpxPoint[], opts: GpxOptions): ReplayTrace {
  if (points.length < 2) throw new Error('GPX needs at least 2 timed track points');
  if (!(opts.cadenceS > 0)) throw new Error('cadence must be > 0');
  if (!(opts.latencyS >= 0)) throw new Error('latency must be ≥ 0');
  if (!(opts.nullRate >= 0 && opts.nullRate <= 1)) throw new Error('null-rate must be in [0, 1]');

  const dist: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) throw new Error('unreachable: point index');
    dist.push((dist[i - 1] ?? 0) + haversineM(a.lat, a.lon, b.lat, b.lon));
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) throw new Error('unreachable: empty points');
  const rand = mulberry32(NULL_RATE_SEED);
  const fixes: ReplayFix[] = [];
  let j = 0;
  for (let k = 0; first.tS + k * opts.cadenceS <= last.tS + 1e-9; k++) {
    const tm = first.tS + k * opts.cadenceS;
    while (j < points.length - 2 && (points[j + 1]?.tS ?? Number.POSITIVE_INFINITY) < tm) j++;
    const p0 = points[j];
    const p1 = points[j + 1];
    if (p0 === undefined || p1 === undefined) break;
    const span = p1.tS - p0.tS;
    const nullDraw = rand(); // drawn for every grid slot so the pattern is independent of gaps
    const onSample = Math.abs(tm - p0.tS) < 1e-6 || Math.abs(tm - p1.tS) < 1e-6;
    if (span > MAX_INTERP_GAP_S && !onSample) continue;
    const f = span > 0 ? Math.min(1, Math.max(0, (tm - p0.tS) / span)) : 0;
    const s = (dist[j] ?? 0) + f * ((dist[j + 1] ?? 0) - (dist[j] ?? 0));
    let speedMps: number | null = null;
    if (p0.speedMps !== null && p1.speedMps !== null) {
      speedMps = round(p0.speedMps + f * (p1.speedMps - p0.speedMps), 2);
    }
    if (nullDraw < opts.nullRate) speedMps = null;
    fixes.push({
      t: round(tm - first.tS + opts.latencyS, 3),
      sAlongM: round(s, 2),
      speedMps,
      accuracyM: GPX_ACCURACY_M,
    });
  }

  return {
    meta: {
      name: opts.name,
      cadenceS: opts.cadenceS,
      latencyS: opts.latencyS,
      source: 'gpx',
      notes: `converted from GPX by tools/gpx-to-replay.ts; positions stripped; accuracy fixed at ${GPX_ACCURACY_M} m; null-rate ${opts.nullRate}`,
    },
    fixes,
  };
}

function parseNumberOption(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${label} must be a number, got "${value}"`);
  return n;
}

/** CLI entry; returns the process exit code. */
export function main(argv: readonly string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        latency: { type: 'string' },
        cadence: { type: 'string' },
        'null-rate': { type: 'string' },
      },
    });
    const [input, output] = positionals;
    if (input === undefined || output === undefined || positionals.length !== 2) {
      throw new Error('usage: gpx-to-replay <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]');
    }
    // Options are validated before any file is read.
    const latencyS = parseNumberOption(values.latency, 1.0, 'latency');
    const cadenceS = parseNumberOption(values.cadence, 1.0, 'cadence');
    const nullRate = parseNumberOption(values['null-rate'], 0, 'null-rate');
    const trace = gpxToReplay(parseGpx(readFileSync(input, 'utf8')), {
      name: basename(output, '.json'),
      latencyS,
      cadenceS,
      nullRate,
    });
    writeFileSync(output, serialiseTrace(trace));
    console.log(`wrote ${output} (${trace.fixes.length} fixes, no positions)`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 18: Run it to see it pass**

```bash
npx vitest run tests/unit/gpx-to-replay.test.ts
```

Expected: PASS — `Tests  8 passed (8)`.

- [ ] **Step 19: Keep GPX logs out of git**

```bash
grep -qxF '*.gpx' .gitignore || printf '\n# Phone GPX logs contain real positions: never commit them\n*.gpx\n' >> .gitignore
tail -n 2 .gitignore
```

Expected: the last two lines are `# Phone GPX logs contain real positions: never commit them` and `*.gpx`.

- [ ] **Step 20: Smoke-test both CLIs under tsx**

```bash
npx tsx tools/gpx-to-replay.ts; echo "exit=$?"
sha256sum tests/fixtures/replay/*.json > fixtures.sha256 && npx tsx tools/make-synthetic-replay.ts > /dev/null && sha256sum -c --quiet fixtures.sha256 && rm fixtures.sha256 && echo idempotent
```

Expected: `usage: gpx-to-replay <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]`, then `exit=1`, then `idempotent` (regenerating the fixtures reproduces them byte for byte; the temporary `fixtures.sha256` is removed).

- [ ] **Step 21: Run every Task 3 test together**

```bash
npx vitest run tests/unit/replay.test.ts tests/unit/make-synthetic-replay.test.ts tests/unit/gpx-to-replay.test.ts tests/unit/criterion-a.test.ts
```

Expected: `Test Files  4 passed (4)`, `Tests  48 passed | 1 skipped (49)` (the skip is the recorded-fixture placeholder of Step 11).

- [ ] **Step 22: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both commands exit 0 and print no diagnostics (only the npm script banners). (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 4: Road force, maximum force and the LoadEstimator

**Files:**
- Create: `src/sim/load.ts`
- Test: `tests/unit/load.test.ts`

**Interfaces:**
- Consumes:
  - From `src/contracts.ts`: `G` (9.80665), `QUANTUM` (128, test only), `type TeslaParams`.
  - Task 1: `epaToSi(t: EpaTarget)` from `src/sim/epa.ts` (test only, for the hand-computed EPA row).
- Produces (`src/sim/load.ts`):
  - `export function roadForceN(p: TeslaParams, v: number): number` — `A + B·v + C·v²` (B may be negative; returns `A` at v = 0).
  - `export function maxForceN(p: TeslaParams, v: number): number` — `modeFactor · min(fTracN, eta·pEffW / max(v, 1))`.
  - `export function rawLoad(p: TeslaParams, v: number, a: number): number` — `F = massKg·a + roadForceN(p, v)`; `F ≥ 0 → clamp(F / maxForceN(p, v), 0, 1)`, else `max(F / (massKg·0.25·G), −1)`; NaN for non-finite v/a.
  - `export class LoadEstimator` (default constructor): `configure(p: TeslaParams): void` (keeps the filter state), `reset(): void`, `update(v: number, a: number, dtS: number): number` (one-pole τ = 0.2 s then deadband ±0.03; returns the new `load`), read-only getters `load: number` and `loadRate: number` (1/s, derivative of the pre-deadband one-pole output). Before `configure()` and for `dtS ≤ 0`, `update` changes nothing and returns the current load (0 initially); a NaN raw load is treated as 0. All four are allocation-free.

**Cross-task premises:**
- Open `src/contracts.ts` and confirm `TeslaParams = { massKg; roadLoad: { A_N; B_Nps_m; C_Ns2_m2 }; fTracN; pEffW; eta; modeFactor }`, `G = 9.80665`, `QUANTUM = 128`.
- Task 1 is complete: `src/sim/epa.ts` exports `epaToSi` (imported by `tests/unit/load.test.ts`).
- Consumers: T7 `PedalPhysics` (`roadForceN`, `maxForceN`), T8 SimCore (`LoadEstimator.update` per quantum, then `load` / `loadRate`), T11 (`rawLoad` in the WOT and sensitivity data tests). T5's Gearbox kickdown uses contract amendment A4 (`load > 0.6 && loadRate > 1.2`), which this one-pole can reach: `loadRate = (raw − y)/τ` (per quantum ≈ that), so on a step to raw load 1 it is ≈ 2 /s when `y` crosses 0.6 (the A4 test below pins this). With τ = 0.2 s, `loadRate ≤ (1 − load)/τ`, i.e. ≤ 0.5 /s once `load > 0.9` — the reason the superseded trigger `load > 0.9 && loadRate > 2` could never fire (the bound test below documents it). Implement τ exactly as the contract says.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/load.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { G, QUANTUM } from '../../src/contracts';
import type { TeslaParams } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';
import { LoadEstimator, maxForceN, rawLoad, roadForceN } from '../../src/sim/load';

/** Illustrative params (not a catalogue record): 2000 kg, 12 kN traction, 300 kW, η 0.9. */
const P: TeslaParams = {
  massKg: 2000,
  roadLoad: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  fTracN: 12000,
  pEffW: 300000,
  eta: 0.9,
  modeFactor: 1,
};
const DT = QUANTUM / 48000;
const KMH100 = 100 / 3.6;

/** Acceleration that produces exactly `load` (≥ 0) at speed v. */
function accelFor(p: TeslaParams, v: number, load: number): number {
  return (load * maxForceN(p, v) - roadForceN(p, v)) / p.massKg;
}

describe('roadForceN', () => {
  it('is A + B·v + C·v²', () => {
    expect(roadForceN(P, 0)).toBe(130);
    // 130 + 27.7778 + 0.4·771.605 = 466.42 N
    expect(roadForceN(P, KMH100)).toBeCloseTo(130 + KMH100 + 0.4 * KMH100 * KMH100, 9);
    expect(roadForceN(P, KMH100)).toBeCloseTo(466.42, 2);
  });

  it('allows a negative B coefficient', () => {
    const p = { ...P, roadLoad: { A_N: 150, B_Nps_m: -2, C_Ns2_m2: 0.45 } };
    expect(roadForceN(p, 10)).toBeCloseTo(150 - 20 + 45, 12);
  });

  it('matches a hand-computed EPA Target row at 100 km/h (illustrative coefficients)', () => {
    // A 30 lbf, B 0.2 lbf/mph, C 0.015 lbf/mph² → at 62.1371 mph: 100.3426 lbf = 446.35 N
    const p = { ...P, roadLoad: epaToSi({ A_lbf: 30, B_lbf_per_mph: 0.2, C_lbf_per_mph2: 0.015 }) };
    expect(roadForceN(p, KMH100)).toBeCloseTo(446.35, 1);
  });
});

describe('maxForceN', () => {
  it('is traction-limited below the crossover and power-limited above it', () => {
    const crossover = (P.eta * P.pEffW) / P.fTracN; // 22.5 m/s
    expect(maxForceN(P, 5)).toBe(12000);
    expect(maxForceN(P, crossover)).toBeCloseTo(12000, 9);
    expect(maxForceN(P, 40)).toBeCloseTo((0.9 * 300000) / 40, 9);
  });

  it('uses max(v, 1) so standstill is finite', () => {
    const weak = { ...P, fTracN: 1e7 };
    expect(maxForceN(weak, 0)).toBeCloseTo(0.9 * 300000, 6);
    expect(maxForceN(weak, 0.5)).toBe(maxForceN(weak, 0));
  });

  it('scales by modeFactor', () => {
    expect(maxForceN({ ...P, modeFactor: 0.5 }, 30)).toBeCloseTo(0.5 * maxForceN(P, 30), 9);
  });
});

describe('rawLoad', () => {
  it('is 1 at full available force, proportional below, clamped above', () => {
    expect(rawLoad(P, 20, accelFor(P, 20, 1))).toBeCloseTo(1, 12);
    expect(rawLoad(P, 20, accelFor(P, 20, 0.5))).toBeCloseTo(0.5, 12);
    expect(rawLoad(P, 20, 50)).toBe(1);
  });

  it('matches closed-form physics for steady acceleration and cruise', () => {
    // a = 1.5 m/s² at 15 m/s: (2000·1.5 + 130 + 15 + 90) / min(12000, 18000) = 0.269583…
    expect(rawLoad(P, 15, 1.5)).toBeCloseTo(3235 / 12000, 12);
    // cruise at 30 m/s: (130 + 30 + 360) / min(12000, 9000) = 0.057777…
    expect(rawLoad(P, 30, 0)).toBeCloseTo(520 / 9000, 12);
  });

  it('maps deceleration to negative load against 0.25 g, floored at −1', () => {
    // a = −1 at 20 m/s: (−2000 + 310) / (2000·0.25·G) = −0.344669…
    expect(rawLoad(P, 20, -1)).toBeCloseTo(-1690 / (2000 * 0.25 * G), 12);
    expect(rawLoad(P, 20, -8)).toBe(-1);
  });

  it('returns NaN for non-finite speed (the estimator guards it)', () => {
    expect(rawLoad(P, Number.NaN, 0)).toBeNaN();
  });
});

describe('LoadEstimator', () => {
  function make(): LoadEstimator {
    const e = new LoadEstimator();
    e.configure(P);
    return e;
  }

  it('returns 0 and stays inert before configure()', () => {
    const e = new LoadEstimator();
    expect(e.update(20, 3, DT)).toBe(0);
    expect(e.update(20, 3, DT)).toBe(0);
    expect(e.load).toBe(0);
    expect(e.loadRate).toBe(0);
  });

  it('one-pole τ = 0.2 s: 63.2 % after 0.2 s, settles to the raw load', () => {
    const e = make();
    const raw = rawLoad(P, 15, 1.5);
    for (let i = 0; i < 75; i++) e.update(15, 1.5, DT); // 75 × 128/48000 = 0.2 s
    expect(e.load).toBeCloseTo(raw * (1 - Math.exp(-1)), 9);
    for (let i = 0; i < 750; i++) e.update(15, 1.5, DT);
    expect(e.load).toBeCloseTo(raw, 4); // 2.2 s = 11 τ → residual e^(−11)·raw ≈ 5e−6
    expect(Math.abs(e.loadRate)).toBeLessThan(1e-4);
  });

  it('applies the ±0.03 deadband to the output only', () => {
    const e = make();
    // cruise at 10 m/s: raw = 180 / 12000 = 0.015 → inside the deadband forever
    for (let i = 0; i < 1000; i++) expect(e.update(10, 0, DT)).toBe(0);
    // gentle decel: raw ≈ −0.0183 → still 0
    for (let i = 0; i < 1000; i++) expect(e.update(10, -0.135, DT)).toBe(0);
  });

  it('passes the filtered value once |y| ≥ 0.03', () => {
    const e = make();
    const out: number[] = [];
    for (let i = 0; i < 40; i++) out.push(e.update(20, accelFor(P, 20, 0.5), DT));
    const firstNonZero = out.findIndex((x) => x !== 0);
    expect(firstNonZero).toBeGreaterThan(0);
    expect(out[firstNonZero]).toBeGreaterThanOrEqual(0.03);
    expect(out[firstNonZero - 1]).toBe(0);
  });

  it('loadRate is the derivative of the pre-deadband filtered value', () => {
    const e = make();
    const a = accelFor(P, 20, 0.8);
    const raw = rawLoad(P, 20, a);
    let y = 0;
    const alpha = 1 - Math.exp(-DT / 0.2);
    for (let i = 0; i < 20; i++) {
      e.update(20, a, DT);
      const next = y + (raw - y) * alpha;
      expect(e.loadRate).toBeCloseTo((next - y) / DT, 9); // non-zero even while the output is in the deadband
      y = next;
    }
    // Lift-off: rate turns negative.
    e.update(20, -1, DT);
    expect(e.loadRate).toBeLessThan(0);
  });

  it('loadRate ≤ (1 − previous load)/τ — at most ≈ 0.5 /s once load > 0.9 (one-pole bound)', () => {
    const e = make();
    const a = accelFor(P, 10, 1); // raw load exactly 1
    let prev = 0;
    let maxRateAbove09 = 0;
    for (let i = 0; i < 1000; i++) {
      e.update(10, a, DT);
      expect(e.loadRate).toBeLessThanOrEqual((1 - prev) / 0.2 + 1e-9);
      if (e.load > 0.9) maxRateAbove09 = Math.max(maxRateAbove09, e.loadRate);
      prev = e.load;
    }
    expect(e.load).toBeCloseTo(1, 4);
    expect(maxRateAbove09).toBeGreaterThan(0.45);
    expect(maxRateAbove09).toBeLessThanOrEqual(0.51); // (1 − 0.9)/0.2 + one quantum of slack
  });

  it('reaches the A4 kickdown trigger: on a step to raw load 1, loadRate > 1.2 /s when load first exceeds 0.6', () => {
    const e = make();
    const a = accelFor(P, 10, 1); // raw load exactly 1, from rest
    let crossed = false;
    for (let i = 0; i < 1000 && !crossed; i++) {
      e.update(10, a, DT);
      if (e.load > 0.6) {
        crossed = true;
        expect(e.loadRate).toBeGreaterThan(1.2);
        expect(e.loadRate).toBeCloseTo(2, 1); // ≈ (1 − 0.6)/0.2 (measured 2.006 /s)
      }
    }
    expect(crossed).toBe(true);
  });

  it('treats a NaN raw load as 0 and never outputs NaN', () => {
    const e = make();
    for (let i = 0; i < 200; i++) e.update(20, accelFor(P, 20, 0.6), DT);
    const before = e.load;
    e.update(Number.NaN, Number.NaN, DT);
    expect(Number.isFinite(e.load)).toBe(true);
    expect(e.load).toBeLessThan(before);
    expect(Number.isFinite(e.loadRate)).toBe(true);
  });

  it('ignores dtS ≤ 0', () => {
    const e = make();
    for (let i = 0; i < 100; i++) e.update(20, 2, DT);
    const load = e.load;
    const rate = e.loadRate;
    expect(e.update(20, -5, 0)).toBe(load);
    expect(e.update(20, -5, -DT)).toBe(load);
    expect(e.loadRate).toBe(rate);
  });

  it('reset() zeroes the state; configure() alone keeps it', () => {
    const e = make();
    for (let i = 0; i < 300; i++) e.update(20, 2, DT);
    const held = e.load;
    expect(held).toBeGreaterThan(0.3);
    e.configure({ ...P, modeFactor: 0.5 });
    expect(e.load).toBe(held);
    e.reset();
    expect(e.load).toBe(0);
    expect(e.loadRate).toBe(0);
    e.update(10, 0, DT);
    expect(e.load).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
npx vitest run tests/unit/load.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/load' imported from …/tests/unit/load.test.ts`.

- [ ] **Step 3: Implement `src/sim/load.ts`**

```ts
import { G } from '../contracts';
import type { TeslaParams } from '../contracts';

/** Load low-pass time constant (s) and deadband (spec §8.5: 150–300 ms low-pass + small deadband). */
const LOAD_TAU_S = 0.2;
const LOAD_DEADBAND = 0.03;
/** Deceleration that maps to load −1 (fraction of g). */
const OVERRUN_FULL_G = 0.25;

/** F_road(v) = A + B·v + C·v² (N). B may be negative. */
export function roadForceN(p: TeslaParams, v: number): number {
  const r = p.roadLoad;
  return r.A_N + r.B_Nps_m * v + r.C_Ns2_m2 * v * v;
}

/** F_max(v) = modeFactor · min(fTracN, eta·pEffW / max(v, 1)) (N). */
export function maxForceN(p: TeslaParams, v: number): number {
  return p.modeFactor * Math.min(p.fTracN, (p.eta * p.pEffW) / Math.max(v, 1));
}

/**
 * F = massKg·a + roadForceN(p, v); F ≥ 0 → clamp(F / maxForceN(p, v), 0, 1);
 * else max(F / (massKg·0.25·G), −1). Allocation-free.
 */
export function rawLoad(p: TeslaParams, v: number, a: number): number {
  const f = p.massKg * a + roadForceN(p, v);
  if (f >= 0) return Math.min(1, Math.max(0, f / maxForceN(p, v)));
  return Math.max(f / (p.massKg * OVERRUN_FULL_G * G), -1);
}

/** Low-passed engine load in [−1, 1] for the selected Tesla (spec §8.5). update() never allocates. */
export class LoadEstimator {
  private params: TeslaParams | null = null;
  /** One-pole state (pre-deadband). */
  private y = 0;
  private _load = 0;
  private _loadRate = 0;

  /** Selects the Tesla. Keeps the filter state so a mid-drive change does not jump. */
  configure(p: TeslaParams): void {
    this.params = p;
  }

  reset(): void {
    this.y = 0;
    this._load = 0;
    this._loadRate = 0;
  }

  /**
   * One-pole τ = 0.2 s then deadband ±0.03 (|x| < 0.03 → 0). loadRate = d(load)/dt of the filtered
   * value (1/s), i.e. of the one-pole output before the deadband. Returns the new load. Before
   * configure() or with dtS ≤ 0 nothing changes; a NaN raw load (non-finite v/a) is treated as 0.
   */
  update(v: number, a: number, dtS: number): number {
    const p = this.params;
    if (p === null || !(dtS > 0)) return this._load;
    const raw = rawLoad(p, v, a);
    const x = raw === raw ? raw : 0;
    const prev = this.y;
    const y = prev + (x - prev) * (1 - Math.exp(-dtS / LOAD_TAU_S));
    this.y = y;
    this._loadRate = (y - prev) / dtS;
    this._load = Math.abs(y) < LOAD_DEADBAND ? 0 : y;
    return this._load;
  }

  get load(): number {
    return this._load;
  }

  get loadRate(): number {
    return this._loadRate;
  }
}
```

- [ ] **Step 4: Run it to see it pass**

```bash
npx vitest run tests/unit/load.test.ts
```

Expected: PASS — `Tests  20 passed (20)`.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both commands exit 0 and print no diagnostics (only the npm script banners). (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 5: Shift map and Gearbox state machine

**Files:**
- Create: `tests/helpers/sim-fixtures.ts` (test-only helper shared by Tasks 5–8, not collected as a test file — same pattern as Task 3's `tests/helpers/replay-harness.ts`)
- Create: `src/sim/shift-map.ts`
- Create: `src/sim/gearbox.ts`
- Test: `tests/unit/shift-map.test.ts`
- Test: `tests/unit/gearbox.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `type DriveMode`, `type EngineDef`, `type EngineSpec`, `type EngineVoicing`, `type GearboxMode`, `type ShiftState`, `type TeslaParams`, `F` (`SHIFTING` 1<<4, `MANUAL_OVERRIDE` 1<<10, `SHIFT_REFUSED` 1<<11).
  - Task 1 `src/sim/tyre.ts`: `wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number` (`speed / C × ratio × 60`, allocation-free; used in `Gearbox.rpmInGear`), `rollingCircumferenceM(code: string): number` (tests only).
- Produces:
  - `src/sim/shift-map.ts` (exactly the contract):
    - `export interface ShiftMap { readonly gears: number; readonly coastDownRpm: number; upshiftRpm(gear: number, load: number): number; downshiftRpm(gear: number, load: number): number; kickdownMaxRpm(gear: number, load: number): number }` — `upshiftRpm` is `Infinity` for the top gear (and for gear < 1), `downshiftRpm` is `0` for gear 1 (and for gears that do not exist), `kickdownMaxRpm = upshiftRpm − 300`; load is clamped to [0, 1] (NaN → 0); all three are allocation-free.
    - `export function buildShiftMap(spec: EngineSpec, mode: DriveMode): ShiftMap` — configure-time only; throws `Error` for empty / non-finite / non-positive / not strictly descending `overallRatios` or `rpm.redline ≤ 0`.
  - `src/sim/gearbox.ts`:
    - `export class Gearbox` with the contract members `configure(spec: EngineSpec, circumferenceM: number, mode: GearboxMode, drive: DriveMode): void` (throws `Error` on a non-positive/non-finite circumference; resets to gear 1), `setMode(mode: GearboxMode): void` (also ends an Auto paddle override), `setDriveMode(drive: DriveMode): void`, `request(dir: number): void` (+1 / −1; 0 and NaN ignored), `step(nowS: number, v: number, load: number, loadRate: number, predicting: boolean, standstill: boolean, clutchOpen: boolean): void`, `rpmInGear(gear: number, v: number): number` (0 for gears that do not exist), getters `gear: number`, `flags: number`, and the field `readonly shift: ShiftState` (one object for the instance's lifetime, mutated in place).
    - Beyond the contract: `reset(): void` — gear 1, no shift in flight, pending request dropped, timers and flags cleared, configuration kept (Task 8 calls it at ignition on/off).
    - Exported constants: `MANUAL_OVERRIDE_S = 8`, `SHIFT_REFUSED_S = 0.5`, `ANTI_LUG_RPM = 1100`, `MIN_TIME_IN_GEAR_S = 1.5`, `WOT_UPSHIFT_DELAY_S = 0.2`, `WOT_UPSHIFT_LOAD = 0.8`, `KICKDOWN_LOAD = 0.6`, `KICKDOWN_LOAD_RATE = 1.2` (contract A4).
    - Observable behaviour Task 8 relies on: on the step a shift starts, `shift.active === true` and `shift.t0 === nowS` (the `nowS` passed to that `step`) and `gear` already holds the new gear; `shift.active` clears on the first step with `nowS ≥ t0 + durationS`; a request that reaches a step while a shift is in flight is **dropped** (never queued); `standstill` sets gear 1 without a shift event; `request`/`step` never allocate.
  - `tests/helpers/sim-fixtures.ts` (used by Tasks 5–8): `DT` (= 128/48000), fictional engines `DCT7_SPEC` (7-speed DCT, idle 800, redline 7000, limiter 7200, ratios [13.5, 8.6, 6.1, 4.7, 3.8, 3.15, 2.7], 245/40R18, shift 0.1 s), `TC8_SPEC` (8-speed tc-auto, idle 650, redline 6200, limiter 6400, tc {stallRpmWot 2600, lockupTurbineRpm 1300, couplingSR 0.88}, 0.2 s), `MANUAL6_SPEC` (6-speed manual, idle 750, redline = limiter 7500, 0.3 s), `FIXTURE_SPECS`, `testVoicing(spec, launchRpm): EngineVoicing`, `DCT7_VOICING` (launch 3150), `TC8_VOICING` (2790), `MANUAL6_VOICING` (4125), `MID_TESLA: TeslaParams` (1900 kg, A 130 / B 1.0 / C 0.40, fTrac 14 000 N, pEff 250 kW, eta 0.9, modeFactor 1), `speedFor(spec, c, gear, rpm): number`.

**Cross-task premises:** (open each named file and confirm before coding)
- Task 1 `src/sim/tyre.ts`: `wheelRpm` is exactly `(speedMps / circumferenceM) * overallRatio * 60` and `rollingCircumferenceM('245/40R18')` = π·(196 + 457.2)/1000·0.97 ≈ 1.990540 m (the hand-computed gearbox expectations use these).
- Phase 0 `vite.config.ts`: Vitest `test.include` is `['tests/unit/**/*.test.ts']` (so `tests/helpers/*.ts` is never collected) and `environment: 'node'`.
- Phase 0 `tsconfig.json`: `include` contains `tests`; `types` contains `"vite/client"` — `shift-map.test.ts` uses `import.meta.glob<EngineDef>(…, { eager: true, import: 'default' })`, typed by `vite/client` and executed by Vitest's Vite transform. If `npm run typecheck` reports `Property 'glob' does not exist on type 'ImportMeta'`, the Phase 0 `types` entry is missing — restore it per the Phase 0 contract; do not add a local declaration.
- Tasks 9–10 write `src/data/engines/*.json` before, during or after this task (Task 9 runs in the same wave, plan header). `shift-map.test.ts` sweeps every engine JSON present when it runs: 20 tests with none, +2 per engine (22 with Task 9's `i5-turbo-25`, 50 with all 15). Nothing else in `src/data/engines/` may be a `.json` file other than a complete `EngineDef` (Task 10's research agents write each engine file once, complete — Task 10 Step 8 rule 9).
- Contract amendment A4: kickdown fires when `load > 0.6 && loadRate > 1.2` (reachable from Task 4's `LoadEstimator` with τ = 0.2 s; the superseded `load > 0.9 && loadRate > 2` never could). The target-gear rule is unchanged. The unit tests inject `load`/`loadRate` directly; Task 8 shows the trigger firing through SimCore at the demo WOT tip-in (its DCT7 test tells the kickdown from a map downshift with `buildShiftMap(…).downshiftRpm`).
- Hot-path rule (contract global rules; Phase 2a ESLint rule; Task 12 audit): `request` and `step` — and the private helpers they call — contain no `new`, array/object literals, closures, spread, template literals, `try`/`throw`. Keep it that way.

Behaviour decisions made explicit here (all listed in the plan header's Concerns section, PC5–PC7; `reset()` beyond the contract is PC4):
- Auto paddle override (8 s): auto-upshifts **and** the load-map downshift / kickdown are suspended; only the coast-down anti-lug downshift (`rpm < coastDownRpm`) still applies — otherwise a deliberate early paddle upshift would be undone on the next quantum by the map.
- Auto over-speed skip-shift: when the current gear already turns ≥ `spec.rpm.redline` (never while `predicting`, never in Manual or during an override), the box makes ONE upshift straight to the lowest gear that is below its own upshift point for the current load (or the top gear), without the minimum-time-in-gear wait. After GPS re-acquisition at speed (standstill had forced gear 1) or a demo → GPS switch at speed, a one-gear-per-shift climb would rev the engine to the limiter for 1.5 s per gear (measured with a one-gear rule at the RF3 tunnel exit: ≈ 6 500 rpm in 2nd, 7th only 8 s later).
- Paddle legality is the same in both modes: upshift in top gear / downshift in gear 1 ignored without a flag; downshift refused (`SHIFT_REFUSED` for 0.5 s, no override) when `rpmInGear(gear − 1) > redline`.

- [ ] **Step 1: Create the shared vehicle-test fixtures**

Create `tests/helpers/sim-fixtures.ts`:

```ts
/**
 * Test-only fixtures for the Phase 1 drivetrain / SimCore tests (not collected as a test file).
 * The engines are FICTIONAL round-number specs (not any real car's data) so the vehicle tests do not
 * depend on the sourced engine catalogue; `shift-map.test.ts` additionally sweeps the real
 * catalogue once it exists.
 */
import type { EngineSpec, EngineVoicing, TeslaParams } from '../../src/contracts';

/** One render quantum at 48 kHz (phase-1 contract: tests use 48 kHz). */
export const DT = 128 / 48000;

function sources(): EngineSpec['sources'] {
  const s = ['test fixture (fictional)'];
  return { layout: s, combustion: s, rpm: s, aspiration: s, gearbox: s };
}

/** 2.0 turbo inline-4, 7-speed DCT, 245/40R18 (C = 1.990540 m). */
export const DCT7_SPEC: EngineSpec = {
  layout: { type: 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2.0 },
  cycleDeg: 720,
  combustion: [
    { angleDeg: 0, bank: 0 },
    { angleDeg: 180, bank: 0 },
    { angleDeg: 360, bank: 0 },
    { angleDeg: 540, bank: 0 },
  ],
  rpm: { idle: 800, redline: 7000, limiter: { type: 'ignition-soft', rpm: 7200, hysteresisRpm: 150 } },
  aspiration: { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null },
  gearbox: {
    type: 'dct',
    overallRatios: [13.5, 8.6, 6.1, 4.7, 3.8, 3.15, 2.7],
    drivenTyre: '245/40R18',
    shiftTimeS: 0.1,
    tc: null,
  },
  sources: sources(),
};

/** 6.2 supercharged V8, 8-speed torque-converter automatic, 275/40R20. */
export const TC8_SPEC: EngineSpec = {
  layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 6.2 },
  cycleDeg: 720,
  combustion: [0, 90, 180, 270, 360, 450, 540, 630].map((angleDeg, i) => ({ angleDeg, bank: i % 2 })),
  rpm: { idle: 650, redline: 6200, limiter: { type: 'fuel-soft', rpm: 6400, hysteresisRpm: 200 } },
  aspiration: {
    type: 'supercharger',
    turbo: null,
    supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 },
  },
  gearbox: {
    type: 'tc-auto',
    overallRatios: [17.0, 11.3, 8.2, 6.5, 5.3, 4.4, 3.6, 2.85],
    drivenTyre: '275/40R20',
    shiftTimeS: 0.2,
    tc: { stallRpmWot: 2600, lockupTurbineRpm: 1300, couplingSR: 0.88 },
  },
  sources: sources(),
};

/** 5.0 NA V8, 6-speed manual, 255/40R19, hard fuel-cut limiter at redline. */
export const MANUAL6_SPEC: EngineSpec = {
  layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 5.0 },
  cycleDeg: 720,
  combustion: [0, 90, 180, 270, 360, 450, 540, 630].map((angleDeg, i) => ({ angleDeg, bank: i % 2 })),
  rpm: { idle: 750, redline: 7500, limiter: { type: 'fuel-hard', rpm: 7500, hysteresisRpm: 250 } },
  aspiration: { type: 'na', turbo: null, supercharger: null },
  gearbox: {
    type: 'manual',
    overallRatios: [13.2, 8.9, 6.6, 5.0, 4.0, 3.15],
    drivenTyre: '255/40R19',
    shiftTimeS: 0.3,
    tc: null,
  },
  sources: sources(),
};

export const FIXTURE_SPECS: readonly (readonly [string, EngineSpec])[] = [
  ['DCT7', DCT7_SPEC],
  ['TC8', TC8_SPEC],
  ['MANUAL6', MANUAL6_SPEC],
];

/** Minimal complete voicing; only launchRpm and overrun.fuelCutResumeRpm matter to SimCore. */
export function testVoicing(spec: EngineSpec, launchRpm: number): EngineVoicing {
  return {
    pulse: { widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 },
    headersM: spec.combustion.map(() => 0.6),
    collectors: [{ banks: [0], lengthM: 0.35 }],
    turbine: null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    },
    intake: { runnerM: 0.3, helmholtzHz: 140, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: spec.rpm.idle + 500 },
    cabin: { lowpassHz: 600 },
    launchRpm,
    estimated: true,
  };
}

/** launchRpm per the phase-1 default rule: NA 0.55·redline, turbo/supercharged 0.45·redline. */
export const DCT7_VOICING = testVoicing(DCT7_SPEC, 0.45 * 7000);
export const TC8_VOICING = testVoicing(TC8_SPEC, 0.45 * 6200);
export const MANUAL6_VOICING = testVoicing(MANUAL6_SPEC, 0.55 * 7500);

/** A mid-size dual-motor sedan (fictional round numbers): ~4.2 s 0–100 km/h class. */
export const MID_TESLA: TeslaParams = {
  massKg: 1900,
  roadLoad: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  fTracN: 14000,
  pEffW: 250000,
  eta: 0.9,
  modeFactor: 1,
};

/** Speed (m/s) at which `gear` (1-based) turns `rpm` with circumference `c` (inverse of wheelRpm). */
export function speedFor(spec: EngineSpec, c: number, gear: number, rpm: number): number {
  const r = spec.gearbox.overallRatios[gear - 1];
  if (r === undefined) throw new Error(`no gear ${gear}`);
  return (rpm * c) / (r * 60);
}
```

- [ ] **Step 2: Typecheck the helper**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: exit 0, no output (the helper imports only types from `src/contracts.ts`). In a parallel wave (plan header, Execution order) other tasks' in-flight test files may make `tsc` report TS2307 for modules they have not written yet — those are not this task's failure; no error may name `tests/helpers/sim-fixtures.ts`.

- [ ] **Step 3: Write the failing shift-map test**

Create `tests/unit/shift-map.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DriveMode, EngineDef, EngineSpec } from '../../src/contracts';
import { buildShiftMap } from '../../src/sim/shift-map';
import { DCT7_SPEC, FIXTURE_SPECS } from '../helpers/sim-fixtures';

const MODES: readonly DriveMode[] = ['comfort', 'sport'];
const LOADS = [-1, -0.3, 0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.5];

/**
 * Real engines: every src/data/engines/*.json present when the suite runs (Tasks 9–10 write them
 * before, during or after this task; with none present only the fixtures are swept).
 */
const ENGINE_JSON = import.meta.glob<EngineDef>('../../src/data/engines/*.json', { eager: true, import: 'default' });
const ALL_SPECS: readonly (readonly [string, EngineSpec])[] = [
  ...FIXTURE_SPECS,
  ...Object.values(ENGINE_JSON).map((d) => [d.id, d.spec] as const),
];

function ratio(spec: EngineSpec, gear: number): number {
  const r = spec.gearbox.overallRatios[gear - 1];
  if (r === undefined) throw new Error(`no gear ${gear}`);
  return r;
}

describe('buildShiftMap — DCT7 fixture, hand-computed values', () => {
  const comfort = buildShiftMap(DCT7_SPEC, 'comfort');
  const sport = buildShiftMap(DCT7_SPEC, 'sport');

  it('exposes gears and the coast-down rpm per mode', () => {
    expect(comfort.gears).toBe(7);
    expect(sport.gears).toBe(7);
    expect(comfort.coastDownRpm).toBe(1200);
    expect(sport.coastDownRpm).toBe(1500);
  });

  it('upshift at load 0 is the larger of 0.25·redline and the coast-down floor (comfort)', () => {
    // floor(n) = (1200 + 300) / (r[n+1]/r[n]); 0.25·7000 = 1750
    expect(comfort.upshiftRpm(1, 0)).toBeCloseTo(1500 / (8.6 / 13.5), 9); // 2354.65
    expect(comfort.upshiftRpm(1, 0)).toBeCloseTo(2354.65, 2);
    expect(comfort.upshiftRpm(2, 0)).toBeCloseTo(2114.75, 2);
    expect(comfort.upshiftRpm(3, 0)).toBeCloseTo(1946.81, 2);
    expect(comfort.upshiftRpm(6, 0)).toBeCloseTo(1750, 6); // floor 1750 == 0.25·redline
  });

  it('upshift interpolates with load^1.3 (comfort 0.25→0.90, sport 0.30→0.97 of redline)', () => {
    expect(comfort.upshiftRpm(3, 1)).toBeCloseTo(0.9 * 7000, 9);
    expect(sport.upshiftRpm(3, 1)).toBeCloseTo(0.97 * 7000, 9);
    expect(comfort.upshiftRpm(3, 0.5)).toBeCloseTo((0.25 + 0.65 * Math.pow(0.5, 1.3)) * 7000, 9); // 3597.87
    expect(comfort.upshiftRpm(3, 0.5)).toBeCloseTo(3597.87, 1);
    expect(sport.upshiftRpm(3, 0.5)).toBeCloseTo((0.3 + 0.67 * Math.pow(0.5, 1.3)) * 7000, 9);
    expect(sport.upshiftRpm(1, 0)).toBeCloseTo(1800 / (8.6 / 13.5), 9); // sport floor (1500 + 300)
  });

  it('clamps load to [0, 1] and treats NaN as 0', () => {
    expect(comfort.upshiftRpm(3, -0.7)).toBe(comfort.upshiftRpm(3, 0));
    expect(comfort.upshiftRpm(3, 1.7)).toBe(comfort.upshiftRpm(3, 1));
    expect(comfort.upshiftRpm(3, Number.NaN)).toBe(comfort.upshiftRpm(3, 0));
  });

  it('top gear never upshifts; gear 1 never downshifts; out-of-range gears are inert', () => {
    expect(comfort.upshiftRpm(7, 1)).toBe(Infinity);
    expect(comfort.kickdownMaxRpm(7, 1)).toBe(Infinity);
    expect(comfort.downshiftRpm(1, 1)).toBe(0);
    expect(comfort.upshiftRpm(0, 0.5)).toBe(Infinity);
    expect(comfort.downshiftRpm(0, 0.5)).toBe(0);
    expect(comfort.downshiftRpm(8, 0.5)).toBe(0);
  });

  it('downshift = upshift(n − 1) · r[n]/r[n−1] · (1 − h), h comfort 0.25 / sport 0.15', () => {
    expect(comfort.downshiftRpm(2, 0)).toBeCloseTo(1500 * 0.75, 9); // floor-bound: (1200+300)·0.75
    expect(comfort.downshiftRpm(2, 1)).toBeCloseTo(6300 * (8.6 / 13.5) * 0.75, 9); // 3010
    expect(comfort.downshiftRpm(2, 1)).toBeCloseTo(3010, 6);
    expect(sport.downshiftRpm(2, 0)).toBeCloseTo(1800 * 0.85, 9); // 1530
    expect(sport.downshiftRpm(5, 0.6)).toBeCloseTo(sport.upshiftRpm(4, 0.6) * (3.8 / 4.7) * 0.85, 9);
  });

  it('kickdownMaxRpm = upshiftRpm − 300', () => {
    expect(comfort.kickdownMaxRpm(3, 1)).toBeCloseTo(6000, 9);
    expect(sport.kickdownMaxRpm(2, 0.95)).toBeCloseTo(sport.upshiftRpm(2, 0.95) - 300, 9);
  });
});

describe('buildShiftMap — rejects malformed gearboxes', () => {
  const withRatios = (overallRatios: number[]): EngineSpec => ({
    ...DCT7_SPEC,
    gearbox: { ...DCT7_SPEC.gearbox, overallRatios },
  });

  it.each([[[]], [[3, 3]], [[2, 3]], [[3, 0]], [[3, Number.NaN]], [[3, -1]]])('throws on %j', (r) => {
    expect(() => buildShiftMap(withRatios(r), 'comfort')).toThrow(Error);
  });

  it('throws on a non-positive redline', () => {
    expect(() => buildShiftMap({ ...DCT7_SPEC, rpm: { ...DCT7_SPEC.rpm, redline: 0 } }, 'sport')).toThrow(Error);
  });
});

describe.each(ALL_SPECS.map(([name, spec]) => [name, spec] as const))('shift-map invariants: %s', (_name, spec) => {
  it.each(MODES.map((m) => [m] as const))('%s', (mode) => {
    const map = buildShiftMap(spec, mode);
    const n = map.gears;
    expect(n).toBe(spec.gearbox.overallRatios.length);
    for (const load of LOADS) {
      for (let g = 1; g < n; g++) {
        const step = ratio(spec, g + 1) / ratio(spec, g);
        const up = map.upshiftRpm(g, load);
        const landed = up * step; // rpm in g + 1 right after the upshift
        // contract invariant 1: the next gear's downshift point sits below the landing rpm (no hunting)
        expect(map.downshiftRpm(g + 1, load), `g${g + 1} load ${load}`).toBeLessThan(landed);
        // contract invariant 2: after any upshift the new gear turns ≥ coastDownRpm + 300 − 1
        expect(landed, `g${g}→${g + 1} load ${load}`).toBeGreaterThanOrEqual(map.coastDownRpm + 300 - 1);
        // the schedule never asks for an upshift beyond the rev limiter
        expect(up, `g${g} load ${load}`).toBeLessThan(spec.rpm.limiter.rpm);
        // a map downshift into g never over-revs g
        expect(map.downshiftRpm(g + 1, load) / step, `g${g + 1}→${g} load ${load}`).toBeLessThan(spec.rpm.redline);
        expect(map.kickdownMaxRpm(g, load)).toBeCloseTo(up - 300, 9);
      }
      expect(map.upshiftRpm(n, load)).toBe(Infinity);
      expect(map.downshiftRpm(1, load)).toBe(0);
    }
    // upshift rpm never decreases with load
    for (let g = 1; g < n; g++) {
      let prev = -Infinity;
      for (const load of LOADS) {
        const up = map.upshiftRpm(g, load);
        expect(up).toBeGreaterThanOrEqual(prev);
        prev = up;
      }
    }
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx vitest run tests/unit/shift-map.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/shift-map' imported from …/tests/unit/shift-map.test.ts`; `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 5: Implement `src/sim/shift-map.ts`**

```ts
import type { DriveMode, EngineSpec } from '../contracts';

/**
 * Automatic shift schedule for one engine + drive mode (spec §8.6, phase-1 contract).
 * Gears are 1-based; all rpm values are ENGINE rpm in the named gear.
 */
export interface ShiftMap {
  readonly gears: number;
  /** Comfort 1200, Sport 1500. */
  readonly coastDownRpm: number;
  /** Engine rpm in `gear` at or above which to go to gear + 1. Infinity for the top gear. */
  upshiftRpm(gear: number, load: number): number;
  /** Engine rpm IN `gear` below which to go to gear − 1. 0 for gear 1. */
  downshiftRpm(gear: number, load: number): number;
  /** upshiftRpm(gear, load) − 300: highest rpm a kickdown may land on in `gear`. */
  kickdownMaxRpm(gear: number, load: number): number;
}

interface ModeParams {
  /** frac(load) = lo + (hi − lo)·clamp(load, 0, 1)^1.3 (fraction of redline). */
  lo: number;
  hi: number;
  /** Downshift hysteresis h. */
  h: number;
  coastDownRpm: number;
}

const MODE_PARAMS: Readonly<Record<DriveMode, ModeParams>> = {
  comfort: { lo: 0.25, hi: 0.9, h: 0.25, coastDownRpm: 1200 },
  sport: { lo: 0.3, hi: 0.97, h: 0.15, coastDownRpm: 1500 },
};

const LOAD_EXPONENT = 1.3;
/** After an upshift the new gear must turn at least coastDownRpm + 300. */
const UPSHIFT_FLOOR_MARGIN_RPM = 300;
const KICKDOWN_MARGIN_RPM = 300;

class FormulaShiftMap implements ShiftMap {
  readonly gears: number;
  readonly coastDownRpm: number;
  private readonly ratios: Float64Array;
  private readonly redline: number;
  private readonly lo: number;
  private readonly hi: number;
  private readonly h: number;

  constructor(ratios: Float64Array, redline: number, p: ModeParams) {
    this.ratios = ratios;
    this.gears = ratios.length;
    this.redline = redline;
    this.lo = p.lo;
    this.hi = p.hi;
    this.h = p.h;
    this.coastDownRpm = p.coastDownRpm;
  }

  /** lo + (hi − lo)·clamp(load, 0, 1)^1.3; NaN load counts as 0. */
  private frac(load: number): number {
    const x = load > 0 ? (load < 1 ? load : 1) : 0;
    return this.lo + (this.hi - this.lo) * Math.pow(x, LOAD_EXPONENT);
  }

  upshiftRpm(gear: number, load: number): number {
    // 1-based gear n uses r[n] = ratios[n − 1]; the floor uses the ratio of next to current gear.
    const rn = this.ratios[gear - 1];
    const rNext = this.ratios[gear];
    if (rn === undefined || rNext === undefined) return Infinity;
    return Math.max(this.frac(load) * this.redline, (this.coastDownRpm + UPSHIFT_FLOOR_MARGIN_RPM) / (rNext / rn));
  }

  downshiftRpm(gear: number, load: number): number {
    const rn = this.ratios[gear - 1];
    const rPrev = this.ratios[gear - 2];
    if (rn === undefined || rPrev === undefined) return 0;
    // Speed at which (gear − 1) → gear upshifted, reduced by h, expressed as rpm in `gear`.
    return this.upshiftRpm(gear - 1, load) * (rn / rPrev) * (1 - this.h);
  }

  kickdownMaxRpm(gear: number, load: number): number {
    return this.upshiftRpm(gear, load) - KICKDOWN_MARGIN_RPM;
  }
}

/**
 * Builds the shift map for `spec` in `mode`. Configure-time only (allocates). Throws Error when the
 * ratios are empty, non-finite, non-positive or not strictly descending, or the redline is not > 0.
 */
export function buildShiftMap(spec: EngineSpec, mode: DriveMode): ShiftMap {
  const src = spec.gearbox.overallRatios;
  if (src.length === 0) throw new Error('overallRatios is empty');
  const ratios = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    if (r === undefined || !Number.isFinite(r) || r <= 0) throw new Error(`overallRatios[${i}] must be a positive number`);
    const prev = i > 0 ? ratios[i - 1] : undefined;
    if (prev !== undefined && !(r < prev)) throw new Error('overallRatios must be strictly descending');
    ratios[i] = r;
  }
  const redline = spec.rpm.redline;
  if (!(redline > 0)) throw new Error('rpm.redline must be > 0');
  return new FormulaShiftMap(ratios, redline, MODE_PARAMS[mode]);
}
```

- [ ] **Step 6: Run it to see it pass**

```bash
npx vitest run tests/unit/shift-map.test.ts
```

Expected: PASS — 20 tests + 2 per engine JSON present (`Tests  20 passed (20)` with none, 22 with Task 9's `i5-turbo-25`, 50 with all 15). A failure in a `shift-map invariants: <engine id>` row is that engine's data problem (Tasks 9–10), not this task's: report it to the owning task.

- [ ] **Step 7: Write the failing gearbox test, part 1 (helpers, basics, Manual incl. RF4)**

Create `tests/unit/gearbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { F } from '../../src/contracts';
import type { DriveMode, GearboxMode } from '../../src/contracts';
import { Gearbox } from '../../src/sim/gearbox';
import { buildShiftMap } from '../../src/sim/shift-map';
import { rollingCircumferenceM } from '../../src/sim/tyre';
import { DCT7_SPEC, DT, speedFor } from '../helpers/sim-fixtures';

// DCT7: ratios [13.5, 8.6, 6.1, 4.7, 3.8, 3.15, 2.7], redline 7000, shiftTimeS 0.1, 245/40R18.
const C = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
const COMFORT = buildShiftMap(DCT7_SPEC, 'comfort');
const SPORT = buildShiftMap(DCT7_SPEC, 'sport');
const SHIFT_S = DCT7_SPEC.gearbox.shiftTimeS;

/** Road speed at which `gear` turns `rpm`. */
const vAt = (gear: number, rpm: number): number => speedFor(DCT7_SPEC, C, gear, rpm);

function make(mode: GearboxMode = 'auto', drive: DriveMode = 'comfort'): Gearbox {
  const gb = new Gearbox();
  gb.configure(DCT7_SPEC, C, mode, drive);
  return gb;
}

interface In {
  v: number;
  load?: number;
  loadRate?: number;
  predicting?: boolean;
  standstill?: boolean;
  clutchOpen?: boolean;
}

/** One quantum at time t. */
function stepAt(gb: Gearbox, t: number, i: In): void {
  gb.step(t, i.v, i.load ?? 0, i.loadRate ?? 0, i.predicting ?? false, i.standstill ?? false, i.clutchOpen ?? false);
}

/** n quanta starting at t with constant inputs; returns the time of the next quantum. */
function stepN(gb: Gearbox, t: number, n: number, i: In): number {
  for (let k = 0; k < n; k++) stepAt(gb, t + k * DT, i);
  return t + n * DT;
}

/** Manual paddle-up to `gear` at constant speed v (each shift allowed to complete); returns the time. */
function climbTo(gb: Gearbox, gear: number, t: number, v: number): number {
  let now = t;
  while (gb.gear < gear) {
    gb.request(+1);
    now = stepN(gb, now, Math.ceil(SHIFT_S / DT) + 1, { v });
  }
  return now;
}

interface ShiftEvent {
  t0: number;
  from: number;
  to: number;
}

describe('Gearbox — basics', () => {
  it('starts in gear 1 with no shift in flight and no flags', () => {
    const gb = make();
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
  });

  it('rpmInGear = v / C × ratio × 60, and 0 for gears that do not exist', () => {
    const gb = make();
    expect(gb.rpmInGear(3, 20)).toBeCloseTo((20 / C) * 6.1 * 60, 9);
    expect(gb.rpmInGear(7, 40)).toBeCloseTo((40 / C) * 2.7 * 60, 9);
    expect(gb.rpmInGear(0, 20)).toBe(0);
    expect(gb.rpmInGear(8, 20)).toBe(0);
  });

  it('configure rejects a non-positive or non-finite circumference', () => {
    expect(() => new Gearbox().configure(DCT7_SPEC, 0, 'auto', 'comfort')).toThrow(Error);
    expect(() => new Gearbox().configure(DCT7_SPEC, Number.NaN, 'auto', 'comfort')).toThrow(Error);
    expect(() => new Gearbox().configure(DCT7_SPEC, Infinity, 'auto', 'comfort')).toThrow(Error);
  });

  it('does nothing before configure()', () => {
    const gb = new Gearbox();
    gb.request(+1);
    stepAt(gb, 0, { v: 30 });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
  });

  it('reset() returns to gear 1 and clears the shift, the pending request and every flag', () => {
    const gb = make('manual');
    const v = vAt(2, 6000);
    let t = climbTo(gb, 3, 0, v);
    gb.request(-1); // gear 2 would turn 6000·8.6/6.1 > redline → refused
    stepAt(gb, t, { v: vAt(3, 6000) });
    expect(gb.flags & F.SHIFT_REFUSED).toBe(F.SHIFT_REFUSED);
    gb.request(+1);
    gb.reset();
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    t += DT;
    stepAt(gb, t, { v: vAt(1, 3000) });
    expect(gb.gear).toBe(1); // the pending +1 was dropped by reset()
  });
});

describe('Gearbox — Manual', () => {
  it('applies a request on the next step, changes gear immediately and fills the shift trajectory', () => {
    const gb = make('manual');
    const v = vAt(1, 3000);
    stepAt(gb, 0, { v });
    gb.request(+1);
    expect(gb.gear).toBe(1); // not before the next step
    stepAt(gb, 0.5, { v });
    expect(gb.gear).toBe(2);
    expect(gb.shift).toEqual({
      active: true,
      up: true,
      fromRpm: gb.rpmInGear(1, v),
      toRpm: gb.rpmInGear(2, v),
      t0: 0.5,
      durationS: SHIFT_S,
    });
    expect(gb.shift.fromRpm).toBeCloseTo(3000, 6);
    expect(gb.shift.toRpm).toBeCloseTo((3000 * 8.6) / 13.5, 6);
    expect(gb.flags).toBe(F.SHIFTING);
  });

  it('keeps SHIFTING exactly until t0 + durationS (multi-step)', () => {
    const gb = make('manual');
    const v = vAt(1, 3000);
    gb.request(+1);
    let activeSteps = 0;
    for (let k = 0; k < 60; k++) {
      stepAt(gb, k * DT, { v });
      if (gb.shift.active) {
        activeSteps++;
        expect(gb.flags & F.SHIFTING).toBe(F.SHIFTING);
        expect(k * DT).toBeLessThan(SHIFT_S);
      } else {
        expect(gb.flags & F.SHIFTING).toBe(0);
        expect(k * DT).toBeGreaterThanOrEqual(SHIFT_S);
      }
    }
    expect(activeSteps).toBe(Math.ceil(SHIFT_S / DT)); // 38 quanta at 48 kHz
  });

  it('RF4: paddle spam during an active shift is ignored until it completes; shifts never overlap', () => {
    const gb = make('manual');
    const v = vAt(2, 4000); // gears 1 … 7 all turn between 1100 rpm and redline at this speed
    let t = climbTo(gb, 2, 0, v);
    const pattern = [+1, +1, +1, -1, +1, -1, -1, +1];
    /** Spams one request before EVERY quantum (also while a shift is in flight); returns the shift events. */
    const spam = (quanta: number, dirAt: (k: number) => number): ShiftEvent[] => {
      const events: ShiftEvent[] = [];
      let lastT0 = gb.shift.t0;
      for (let k = 0; k < quanta; k++) {
        gb.request(dirAt(k));
        const before = gb.gear;
        const inFlight = gb.shift.active && t < gb.shift.t0 + gb.shift.durationS;
        stepAt(gb, t, { v });
        if (gb.shift.t0 !== lastT0) {
          expect(inFlight, `new shift at t=${t.toFixed(4)} while one was in flight`).toBe(false);
          expect(Math.abs(gb.gear - before)).toBe(1);
          events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
          lastT0 = gb.shift.t0;
        } else {
          expect(gb.gear).toBe(before); // no gear change without a shift event
        }
        t += DT;
      }
      for (let i = 1; i < events.length; i++) {
        const a = events[i - 1];
        const b = events[i];
        if (a !== undefined && b !== undefined) expect(b.t0).toBeGreaterThanOrEqual(a.t0 + SHIFT_S); // no overlap
      }
      return events;
    };

    // Phase A: only up-requests → 2→3→…→7, each next shift on the first quantum after the previous ended
    const a = spam(1200, () => +1);
    expect(a.map((e) => e.to)).toEqual([3, 4, 5, 6, 7]);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      if (prev !== undefined && cur !== undefined) expect(cur.t0 - (prev.t0 + SHIFT_S)).toBeLessThan(DT);
    }
    expect(gb.gear).toBe(7);
    expect(gb.flags & F.SHIFT_REFUSED).toBe(0); // up-requests in top gear are ignored silently

    // Phase B: mixed up/down spam → still never overlapping, one gear per shift. In 7th (or 1st) the
    // pattern can repeat an illegal direction up to 4 quanta in a row (indices 7, 0, 1, 2 are all +1),
    // so the next legal request comes at most 4 quanta (+ the sub-quantum shift-end offset) later.
    const b = spam(1200, (k) => pattern[k % pattern.length] ?? 1);
    expect(b.length).toBeGreaterThan(8);
    for (let i = 1; i < b.length; i++) {
      const prev = b[i - 1];
      const cur = b[i];
      if (prev !== undefined && cur !== undefined) expect(cur.t0 - (prev.t0 + SHIFT_S)).toBeLessThan(5 * DT);
    }
  });

  it('RF4: a single request made while a shift is in flight is dropped, not deferred', () => {
    const gb = make('manual');
    const v = vAt(2, 4000);
    gb.request(+1);
    stepAt(gb, 0, { v });
    expect(gb.gear).toBe(2);
    let t = DT;
    for (let k = 1; k < 400; k++, t += DT) {
      if (k === 10) gb.request(+1); // mid-shift (shift lasts 38 quanta)
      stepAt(gb, t, { v });
    }
    expect(gb.gear).toBe(2);
    gb.request(+1); // after completion it works again
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
  });

  it('RF4 in Auto: paddle spam during a shift is dropped, never queued, never overlapping', () => {
    const gb = make('auto');
    const v = vAt(3, 3000);
    let t = 0;
    const starts: number[] = [];
    let lastT0 = Number.NaN;
    for (let k = 0; k < 600; k++) {
      gb.request(k % 2 === 0 ? +1 : -1);
      stepAt(gb, t, { v, load: 0.3 });
      if (gb.shift.active && gb.shift.t0 !== lastT0) {
        const prev = starts[starts.length - 1];
        if (prev !== undefined) expect(gb.shift.t0).toBeGreaterThanOrEqual(prev + SHIFT_S);
        starts.push(gb.shift.t0);
        lastT0 = gb.shift.t0;
      }
      t += DT;
    }
    expect(starts.length).toBeGreaterThan(5);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
  });

  it('ignores an upshift request in top gear and a downshift request in gear 1 (no flag)', () => {
    const gb = make('manual');
    gb.request(-1);
    let t = stepN(gb, 0, 2, { v: vAt(1, 2000) });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    const v = vAt(7, 2000);
    t = climbTo(gb, 7, t, v);
    gb.request(+1);
    stepN(gb, t, 2, { v });
    expect(gb.gear).toBe(7);
    expect(gb.flags).toBe(0);
  });

  it('refuses a downshift that would exceed redline: SHIFT_REFUSED for 0.5 s, gear kept', () => {
    const gb = make('manual');
    const v = vAt(3, 5000); // gear 2 would turn 5000·8.6/6.1 = 7049 > 7000
    let t = climbTo(gb, 3, 0, v);
    expect(gb.rpmInGear(2, v)).toBeGreaterThan(7000);
    gb.request(-1);
    const tReq = t;
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(F.SHIFT_REFUSED);
    for (t += DT; t < tReq + 0.7; t += DT) {
      stepAt(gb, t, { v });
      expect(gb.flags & F.SHIFT_REFUSED, `t − tReq = ${(t - tReq).toFixed(4)}`).toBe(t < tReq + 0.5 ? F.SHIFT_REFUSED : 0);
    }
    const slower = vAt(3, 4500); // gear 2 = 6344 rpm → allowed
    gb.request(-1);
    stepAt(gb, t, { v: slower });
    expect(gb.gear).toBe(2);
    expect(gb.shift.up).toBe(false);
  });

  it('anti-lug: below 1100 rpm it downshifts one gear per shift unless the clutch is open', () => {
    const gb = make('manual');
    let t = climbTo(gb, 4, 0, vAt(4, 2000));
    const lugging = vAt(4, 1000);
    t = stepN(gb, t, 50, { v: lugging, clutchOpen: true });
    expect(gb.gear).toBe(4);
    stepAt(gb, t, { v: lugging });
    expect(gb.gear).toBe(3); // 1000·6.1/4.7 = 1298 rpm in 3rd → stays
    expect(gb.shift.up).toBe(false);
    t = stepN(gb, t + DT, 200, { v: lugging });
    expect(gb.gear).toBe(3);
    // keep slowing: 3rd < 1100 → 2nd; 2nd < 1100 → 1st; never below 1st
    const seen: number[] = [];
    for (let v = lugging; v > 0.5; v -= 0.002) {
      stepAt(gb, t, { v });
      if (seen[seen.length - 1] !== gb.gear) seen.push(gb.gear);
      t += DT;
    }
    expect(seen).toEqual([3, 2, 1]);
  });

  it('never upshifts by itself, even past redline', () => {
    const gb = make('manual');
    stepN(gb, 0, 1000, { v: vAt(1, 8000), load: 1 });
    expect(gb.gear).toBe(1);
  });

  it('standstill forces gear 1 without a shift event and drops a pending request', () => {
    const gb = make('manual');
    let t = climbTo(gb, 4, 0, vAt(4, 2500));
    gb.request(+1);
    stepAt(gb, t, { v: 0, standstill: true });
    expect(gb.gear).toBe(1);
    expect(gb.shift.active).toBe(false);
    expect(gb.flags).toBe(0);
    t += DT;
    stepAt(gb, t, { v: vAt(1, 2000) });
    expect(gb.gear).toBe(1);
  });
});
```

- [ ] **Step 8: Append part 2 (Auto: upshift points, predicting, minimum time in gear, coast-down, kickdown, paddle override, over-speed skip-shift, WOT run; rev-match)**

Append to `tests/unit/gearbox.test.ts` (after one blank line):

```ts
describe('Gearbox — Auto', () => {
  it('upshifts when rpm reaches upshiftRpm(gear, load) and lands at the predicted rpm', () => {
    const gb = make('auto');
    const up = COMFORT.upshiftRpm(1, 0.5); // 3597.87
    stepN(gb, 0, 10, { v: vAt(1, up - 5), load: 0.5 });
    expect(gb.gear).toBe(1);
    stepAt(gb, 10 * DT, { v: vAt(1, up + 1), load: 0.5 });
    expect(gb.gear).toBe(2);
    expect(gb.shift.up).toBe(true);
    expect(gb.shift.fromRpm).toBeCloseTo(up + 1, 6);
    expect(gb.shift.toRpm).toBeCloseTo(((up + 1) * 8.6) / 13.5, 6);
  });

  it('never auto-upshifts while predicting', () => {
    const gb = make('auto');
    const v = vAt(1, 5000);
    const t = stepN(gb, 0, 400, { v, load: 0.5, predicting: true });
    expect(gb.gear).toBe(1);
    stepAt(gb, t, { v, load: 0.5 });
    expect(gb.gear).toBe(2);
  });

  it.each([
    ['part load 0.5', 0.5, 1.5],
    ['coast −0.3', -0.3, 1.5],
    ['WOT 0.9', 0.9, 0.2],
  ])('%s: next upshift waits %s s after the previous shift ended', (_name, load, gapS) => {
    const gb = make('auto');
    const v1 = vAt(1, COMFORT.upshiftRpm(1, load) + 10);
    stepAt(gb, 0, { v: v1, load });
    expect(gb.gear).toBe(2);
    const ended = 0 + SHIFT_S;
    // now hold a speed at which gear 2 is above its upshift point (below redline, above downshift)
    const v2 = vAt(2, Math.max(COMFORT.upshiftRpm(2, load) + 10, 2600));
    expect(gb.rpmInGear(2, v2)).toBeLessThan(7000);
    let t = DT;
    let upAt = Number.NaN;
    for (; t < 3; t += DT) {
      stepAt(gb, t, { v: v2, load });
      if (gb.gear === 3) {
        upAt = t;
        break;
      }
    }
    expect(upAt - ended).toBeGreaterThanOrEqual(gapS);
    expect(upAt - ended).toBeLessThan(gapS + DT + 1e-9);
  });

  it('coasting down: one gear per shift at downshiftRpm, no hunting, ends in gear 1', () => {
    const gb = make('manual');
    // 1700 rpm in 5th sits inside the hysteresis band (downshift 1125 < 1700 < upshift 1809.5 at load 0)
    let t = climbTo(gb, 5, 0, vAt(5, 1700));
    gb.setMode('auto');
    const events: ShiftEvent[] = [];
    let lastT0 = gb.shift.t0;
    let v = vAt(5, 1700);
    for (; v > 0.3; v -= 1.0 * DT) {
      const before = gb.gear;
      const rpmBefore = gb.rpmInGear(before, v);
      stepAt(gb, t, { v, load: 0 });
      if (gb.shift.t0 !== lastT0) {
        expect(gb.gear).toBe(before - 1); // only downshifts, one gear at a time
        expect(rpmBefore).toBeLessThan(COMFORT.downshiftRpm(before, 0));
        expect(rpmBefore).toBeGreaterThan(COMFORT.downshiftRpm(before, 0) - 5);
        events.push({ t0: gb.shift.t0, from: before, to: gb.gear });
        lastT0 = gb.shift.t0;
      }
      t += DT;
    }
    expect(events.map((e) => e.to)).toEqual([4, 3, 2, 1]);
    expect(gb.gear).toBe(1);
  });

  it('kickdown picks the lowest gear ≥ gear − 2 that lands ≤ upshiftRpm − 300', () => {
    const cases: [rpm5: number, expected: number][] = [
      [2000, 3], // 3rd = 3210 ≤ 5706 → two gears down
      [3800, 4], // 3rd = 6100 > 5706, 4th = 4700 ≤ 5706 → one gear down
      [4700, 5], // 4th = 5813 > 5706 → no kickdown (and no map downshift at 4700)
    ];
    for (const [rpm5, expected] of cases) {
      const gb = make('manual');
      const v = vAt(5, rpm5);
      const t = climbTo(gb, 5, 0, v);
      gb.setMode('auto');
      stepAt(gb, t, { v, load: 0.95, loadRate: 3 });
      expect(gb.gear, `rpm5=${rpm5}`).toBe(expected);
    }
    expect(COMFORT.kickdownMaxRpm(3, 0.95)).toBeCloseTo(5706.5, 0);
  });

  it('no kickdown when the load rises slowly (loadRate ≤ 1.2): only the one-gear map downshift', () => {
    const gb = make('manual');
    const v = vAt(5, 2000);
    const t = climbTo(gb, 5, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, load: 0.95, loadRate: 1 });
    expect(gb.gear).toBe(4);
  });

  it('kickdown from 2nd may drop to 1st', () => {
    const gb = make('manual');
    const v = vAt(2, 2500); // 1st = 3924 ≤ 5706
    const t = climbTo(gb, 2, 0, v);
    gb.setMode('auto');
    stepAt(gb, t, { v, load: 0.95, loadRate: 5 });
    expect(gb.gear).toBe(1);
  });

  it('A4: kickdown fires at load > 0.6 && loadRate > 1.2 (both thresholds needed)', () => {
    /** 5th at 2000 rpm, then one Auto step with the given load / loadRate; returns the new gear. */
    const at5 = (load: number, loadRate: number): number => {
      const gb = make('manual');
      const v = vAt(5, 2000);
      const t = climbTo(gb, 5, 0, v);
      gb.setMode('auto');
      stepAt(gb, t, { v, load, loadRate });
      return gb.gear;
    };
    // 3rd = 3210 ≤ kickdownMaxRpm(3, 0.65) → two gears down
    expect(COMFORT.kickdownMaxRpm(3, 0.65)).toBeGreaterThan(3210);
    expect(at5(0.65, 1.5)).toBe(3);
    expect(at5(0.7, 1.5)).toBe(3);
    // loadRate ≤ 1.2 → no kickdown, only the one-gear map downshift (downshiftRpm(5, 0.7) > 2000)
    expect(COMFORT.downshiftRpm(5, 0.7)).toBeGreaterThan(2000);
    expect(at5(0.7, 1.1)).toBe(4);
    // load ≤ 0.6 → no kickdown even with a fast rise: never the two-gear drop
    expect(at5(0.55, 1.5)).toBeGreaterThanOrEqual(4);
    expect(at5(0.55, 3)).toBeGreaterThanOrEqual(4);
  });

  it('paddle in Auto shifts, sets MANUAL_OVERRIDE for 8 s and suspends auto-upshifts meanwhile', () => {
    const gb = make('auto');
    let t = stepN(gb, 0, 10, { v: vAt(1, 2000), load: 0.2 });
    gb.request(+1);
    const tPaddle = t;
    stepAt(gb, t, { v: vAt(1, 2000), load: 0.2 });
    expect(gb.gear).toBe(2);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    const fast = vAt(2, 3000); // ≥ upshiftRpm(2, 0.2) = 2311 → would upshift without the override
    expect(3000).toBeGreaterThan(COMFORT.upshiftRpm(2, 0.2));
    let upAt = Number.NaN;
    for (t += DT; t < tPaddle + 9; t += DT) {
      stepAt(gb, t, { v: fast, load: 0.2 });
      const overriding = t < tPaddle + 8;
      expect(gb.flags & F.MANUAL_OVERRIDE).toBe(overriding ? F.MANUAL_OVERRIDE : 0);
      if (gb.gear === 3) {
        upAt = t;
        break;
      }
    }
    expect(upAt).toBeGreaterThanOrEqual(tPaddle + 8);
    expect(upAt).toBeLessThan(tPaddle + 8 + DT + 1e-9);
  });

  it('during the override the coast-down downshift still applies', () => {
    const gb = make('auto');
    const v = vAt(2, 1500); // 3rd would turn 1500·6.1/8.6 = 1064 < coastDownRpm 1200
    let t = stepN(gb, 0, 2, { v: vAt(1, 2000), load: 0.1 });
    gb.request(+1);
    t = stepN(gb, t, Math.ceil(SHIFT_S / DT) + 2, { v: vAt(1, 2000), load: 0.1 });
    expect(gb.gear).toBe(2);
    gb.request(+1); // the driver asks for 3rd at 1500 rpm
    stepAt(gb, t, { v, load: 0 });
    expect(gb.gear).toBe(3);
    stepN(gb, t + DT, Math.ceil(SHIFT_S / DT) + 2, { v, load: 0 });
    expect(gb.gear).toBe(2); // anti-lug back to 2nd, override still running
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
  });

  it('a refused paddle downshift in Auto raises SHIFT_REFUSED and no override', () => {
    const gb = make('manual');
    const v = vAt(3, 5000);
    const t = climbTo(gb, 3, 0, v);
    gb.setMode('auto');
    gb.request(-1);
    stepAt(gb, t, { v, load: 0.5 });
    expect(gb.gear).toBe(3);
    expect(gb.flags & F.SHIFT_REFUSED).toBe(F.SHIFT_REFUSED);
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);
  });

  it('setMode(manual) ends the override; setDriveMode(sport) moves the upshift point', () => {
    const gb = make('auto');
    gb.request(+1);
    stepAt(gb, 0, { v: vAt(1, 2000), load: 0.2 });
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(F.MANUAL_OVERRIDE);
    gb.setMode('manual');
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);
    stepAt(gb, DT, { v: vAt(2, 2000), load: 0.2 });
    expect(gb.flags & F.MANUAL_OVERRIDE).toBe(0);

    const comfort = make('auto', 'comfort');
    const sport = make('auto', 'sport');
    const v = vAt(1, 3800); // comfort upshifts at 3598 (load 0.5), sport at 4005
    expect(SPORT.upshiftRpm(1, 0.5)).toBeGreaterThan(3800);
    stepAt(comfort, 0, { v, load: 0.5 });
    stepAt(sport, 0, { v, load: 0.5 });
    expect(comfort.gear).toBe(2);
    expect(sport.gear).toBe(1);
    sport.setDriveMode('comfort');
    stepAt(sport, DT, { v, load: 0.5 });
    expect(sport.gear).toBe(2);
  });

  it('over-speed (rpm ≥ redline): one upshift straight to the map gear without the minimum time, then nothing more', () => {
    const gb = make('auto');
    const v = 30; // 1st 12207 rpm ≥ redline; 6th 2848 ≥ upshiftRpm(6, 0.3) = 2701; 7th (top) 2442
    stepAt(gb, 0, { v, load: 0.3 });
    expect(gb.gear).toBe(7);
    expect(gb.shift.active && gb.shift.up && gb.shift.t0 === 0).toBe(true);
    expect(gb.shift.fromRpm).toBeCloseTo(gb.rpmInGear(1, v), 6);
    expect(gb.shift.toRpm).toBeCloseTo(gb.rpmInGear(7, v), 6);
    stepN(gb, DT, Math.round(2 / DT), { v, load: 0.3 }); // 7th sits above its downshift point: no further shift
    expect(gb.gear).toBe(7);
    expect(gb.shift.t0).toBe(0);
  });

  it('WOT run: sequential upshifts at 0.9·redline, never overlapping, each landing ≥ coast-down + 300', () => {
    const gb = make('auto');
    const events: (ShiftEvent & { fromRpm: number; toRpm: number })[] = [];
    let lastT0 = Number.NaN;
    let v = 0.5;
    for (let t = 0; t < 40 && v < 80; t += DT) {
      stepAt(gb, t, { v, load: 1 });
      if (gb.shift.active && gb.shift.t0 !== lastT0) {
        events.push({ t0: gb.shift.t0, from: gb.gear - 1, to: gb.gear, fromRpm: gb.shift.fromRpm, toRpm: gb.shift.toRpm });
        lastT0 = gb.shift.t0;
      }
      v += 4 * DT;
    }
    expect(events.map((e) => e.to)).toEqual([2, 3, 4, 5, 6, 7]);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e === undefined) continue;
      expect(e.fromRpm).toBeGreaterThanOrEqual(0.9 * 7000);
      expect(e.fromRpm).toBeLessThan(0.9 * 7000 + 10);
      expect(e.toRpm).toBeGreaterThanOrEqual(COMFORT.coastDownRpm + 300 - 1);
      const prev = events[i - 1];
      if (prev !== undefined) expect(e.t0).toBeGreaterThanOrEqual(prev.t0 + SHIFT_S);
    }
  });
});

describe('Gearbox — rev-match (spec §14)', () => {
  it('a downshift trajectory rev-matches: toRpm is the lower gear rpm, above fromRpm', () => {
    const gb = make('manual');
    const v = vAt(4, 3000);
    const t = climbTo(gb, 4, 0, v);
    gb.request(-1);
    stepAt(gb, t, { v });
    expect(gb.gear).toBe(3);
    expect(gb.shift.up).toBe(false);
    expect(gb.shift.fromRpm).toBeCloseTo(3000, 6);
    expect(gb.shift.toRpm).toBeCloseTo((3000 * 6.1) / 4.7, 6);
    expect(gb.shift.toRpm).toBeGreaterThan(gb.shift.fromRpm);
  });
});
```

- [ ] **Step 9: Run it to see it fail**

```bash
npx vitest run tests/unit/gearbox.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/gearbox' imported from …/tests/unit/gearbox.test.ts`; `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 10: Implement `src/sim/gearbox.ts`**

```ts
import { F } from '../contracts';
import type { DriveMode, EngineSpec, GearboxMode, ShiftState } from '../contracts';
import { buildShiftMap, type ShiftMap } from './shift-map';
import { wheelRpm } from './tyre';

/** Auto-mode paddle override: auto-upshifts suspended for this long after a paddle shift (spec §7.1). */
export const MANUAL_OVERRIDE_S = 8;
/** SHIFT_REFUSED stays set this long after a refused (over-rev) downshift. */
export const SHIFT_REFUSED_S = 0.5;
/** Manual mode anti-lug: auto-downshift below this engine rpm unless the clutch is open. */
export const ANTI_LUG_RPM = 1100;
/** Auto: minimum time in gear after the previous shift ended, part-load (< 0.8) and coast upshifts. */
export const MIN_TIME_IN_GEAR_S = 1.5;
/** Auto: at load ≥ WOT_UPSHIFT_LOAD an upshift is allowed this long after the previous shift ended. */
export const WOT_UPSHIFT_DELAY_S = 0.2;
export const WOT_UPSHIFT_LOAD = 0.8;
/** Auto kickdown trigger (contract A4): load > 0.6 && loadRate > 1.2 /s. */
export const KICKDOWN_LOAD = 0.6;
export const KICKDOWN_LOAD_RATE = 1.2;

/**
 * Auto / manual gearbox state machine (spec §8.6, phase-1 contract). Gears are 1-based.
 * `request` and `step` never allocate; `configure` builds both drive-mode shift maps.
 *
 * Beyond the contract (plan header, Concerns PC4 and PC5):
 * - `reset()` returns to gear 1 with no shift in flight (SimCore calls it at ignition on).
 * - Auto over-speed skip-shift: when the current gear already turns ≥ redline (e.g. GPS re-acquired
 *   at speed after standstill forced gear 1), ONE upshift goes straight to the lowest gear below its
 *   own upshift point (or the top gear), without the minimum-time-in-gear wait — a one-gear-per-shift
 *   climb would rev to the limiter for 1.5 s per gear. Still never while `predicting`, never in
 *   Manual and never during a paddle override.
 */
export class Gearbox {
  /** Current/last shift trajectory, mutated in place (never replaced). */
  readonly shift: ShiftState = { active: false, up: false, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0 };

  private comfortMap: ShiftMap | null = null;
  private sportMap: ShiftMap | null = null;
  private map: ShiftMap | null = null;
  private ratios = new Float64Array(0);
  private circumferenceM = 1;
  private redline = 0;
  private shiftTimeS = 0;
  private gears = 0;
  private mode: GearboxMode = 'auto';
  private _gear = 1;
  private _flags = 0;
  /** Pending paddle request: +1, −1 or 0. Applied (or dropped) by the next step. */
  private pending = 0;
  private lastShiftEndS = -Infinity;
  private overrideUntilS = -Infinity;
  private refusedUntilS = -Infinity;

  /** Configure-time only (allocates). Resets to gear 1. Throws Error on a bad circumference or ratios. */
  configure(spec: EngineSpec, circumferenceM: number, mode: GearboxMode, drive: DriveMode): void {
    if (!(circumferenceM > 0) || !Number.isFinite(circumferenceM)) {
      throw new Error('circumferenceM must be a positive finite number');
    }
    this.comfortMap = buildShiftMap(spec, 'comfort');
    this.sportMap = buildShiftMap(spec, 'sport');
    this.ratios = Float64Array.from(spec.gearbox.overallRatios);
    this.gears = this.ratios.length;
    this.circumferenceM = circumferenceM;
    this.redline = spec.rpm.redline;
    this.shiftTimeS = spec.gearbox.shiftTimeS;
    this.mode = mode;
    this.setDriveMode(drive);
    this.reset();
  }

  /** Gear 1, no shift in flight, no pending request, all timers and flags cleared. Keeps the configuration. */
  reset(): void {
    const s = this.shift;
    s.active = false;
    s.up = false;
    s.fromRpm = 0;
    s.toRpm = 0;
    s.t0 = 0;
    s.durationS = 0;
    this._gear = 1;
    this._flags = 0;
    this.pending = 0;
    this.lastShiftEndS = -Infinity;
    this.overrideUntilS = -Infinity;
    this.refusedUntilS = -Infinity;
  }

  /** Switching mode ends any Auto paddle override (MANUAL_OVERRIDE clears now). */
  setMode(mode: GearboxMode): void {
    this.mode = mode;
    this.overrideUntilS = -Infinity;
    this._flags &= ~F.MANUAL_OVERRIDE;
  }

  setDriveMode(drive: DriveMode): void {
    this.map = drive === 'sport' ? this.sportMap : this.comfortMap;
  }

  /** Paddle/wheel/keyboard request; applied on the next step. dir: +1 up, −1 down (0/NaN ignored). */
  request(dir: number): void {
    if (dir > 0) this.pending = 1;
    else if (dir < 0) this.pending = -1;
  }

  step(
    nowS: number,
    v: number,
    load: number,
    loadRate: number,
    predicting: boolean,
    standstill: boolean,
    clutchOpen: boolean,
  ): void {
    const map = this.map;
    if (map === null) return;
    const s = this.shift;
    if (s.active && nowS >= s.t0 + s.durationS) s.active = false;
    const req = this.pending;
    this.pending = 0; // a request is applied by this step or dropped (never queued behind a shift)

    if (standstill) {
      this._gear = 1; // no shift event
    } else if (!s.active) {
      if (req !== 0) this.paddle(nowS, v, req);
      if (!s.active) {
        if (this.mode === 'manual') this.manualAuto(nowS, v, clutchOpen);
        else this.auto(nowS, v, load, loadRate, predicting, map);
      }
    }

    let f = 0;
    if (s.active) f |= F.SHIFTING;
    if (this.mode === 'auto' && nowS < this.overrideUntilS) f |= F.MANUAL_OVERRIDE;
    if (nowS < this.refusedUntilS) f |= F.SHIFT_REFUSED;
    this._flags = f;
  }

  /** Engine rpm the wheels impose in `gear` (1-based) at road speed v; 0 for a gear that does not exist. */
  rpmInGear(gear: number, v: number): number {
    const r = this.ratios[gear - 1];
    return r === undefined ? 0 : wheelRpm(v, r, this.circumferenceM);
  }

  get gear(): number {
    return this._gear;
  }

  get flags(): number {
    return this._flags;
  }

  /** Paddle in either mode: upshift at top / downshift at gear 1 ignored; over-rev downshift refused. */
  private paddle(nowS: number, v: number, dir: number): void {
    const g = this._gear;
    if (dir > 0) {
      if (g >= this.gears) return;
      this.begin(nowS, v, g + 1);
    } else {
      if (g <= 1) return;
      if (this.rpmInGear(g - 1, v) > this.redline) {
        this.refusedUntilS = nowS + SHIFT_REFUSED_S;
        return;
      }
      this.begin(nowS, v, g - 1);
    }
    if (this.mode === 'auto') this.overrideUntilS = nowS + MANUAL_OVERRIDE_S;
  }

  /** Manual mode: only the anti-lug downshift is automatic. */
  private manualAuto(nowS: number, v: number, clutchOpen: boolean): void {
    const g = this._gear;
    if (clutchOpen || g <= 1) return;
    if (this.rpmInGear(g, v) < ANTI_LUG_RPM && this.rpmInGear(g - 1, v) <= this.redline) this.begin(nowS, v, g - 1);
  }

  private auto(nowS: number, v: number, load: number, loadRate: number, predicting: boolean, map: ShiftMap): void {
    const g = this._gear;
    const rpm = this.rpmInGear(g, v);
    if (nowS < this.overrideUntilS) {
      // Paddle override: auto-upshifts (and map downshifts) suspended; the coast-down anti-lug still applies.
      if (g > 1 && rpm < map.coastDownRpm) this.begin(nowS, v, g - 1);
      return;
    }
    if (load > KICKDOWN_LOAD && loadRate > KICKDOWN_LOAD_RATE) {
      for (let k = g - 2 > 1 ? g - 2 : 1; k < g; k++) {
        if (this.rpmInGear(k, v) <= map.kickdownMaxRpm(k, load)) {
          this.begin(nowS, v, k);
          return;
        }
      }
    }
    if (g > 1 && rpm < map.downshiftRpm(g, load)) {
      this.begin(nowS, v, g - 1);
      return;
    }
    if (!predicting && g < this.gears && rpm >= map.upshiftRpm(g, load)) {
      if (rpm >= this.redline) {
        // Over-speed: one shift straight to the lowest gear below its own upshift point (or the top gear).
        let to = g + 1;
        while (to < this.gears && this.rpmInGear(to, v) >= map.upshiftRpm(to, load)) to++;
        this.begin(nowS, v, to);
        return;
      }
      const minGapS = load >= WOT_UPSHIFT_LOAD ? WOT_UPSHIFT_DELAY_S : MIN_TIME_IN_GEAR_S;
      if (nowS - this.lastShiftEndS >= minGapS) this.begin(nowS, v, g + 1);
    }
  }

  private begin(nowS: number, v: number, to: number): void {
    const s = this.shift;
    s.active = true;
    s.up = to > this._gear;
    s.fromRpm = this.rpmInGear(this._gear, v);
    s.toRpm = this.rpmInGear(to, v);
    s.t0 = nowS;
    s.durationS = this.shiftTimeS;
    this.lastShiftEndS = nowS + this.shiftTimeS;
    this._gear = to;
  }
}
```

- [ ] **Step 11: Run it to see it pass**

```bash
npx vitest run tests/unit/gearbox.test.ts
```

Expected: PASS — `Tests  32 passed (32)` (incl. the A4 kickdown-threshold test, the over-speed skip-shift and the spec §14 rev-match test). RF4 is covered by three tests: spam on every quantum in Manual (phase A up-only, phase B mixed) and in Auto never starts a shift while one is in flight, and a single mid-shift request is dropped, not deferred.

- [ ] **Step 12: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no diagnostics. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 6: DrivelineModel — idle, clutch disengage/launch, torque converter

**Files:**
- Create: `src/sim/driveline.ts`
- Test: `tests/unit/driveline.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `type Driveline` (`'engaged' | 'clutch-open' | 'tc-stall' | 'slipping'`), `type EngineSpec`, `type EngineVoicing`.
  - Task 1 `src/sim/tyre.ts` (tests only): `rollingCircumferenceM(code: string): number`, `wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number`.
  - Task 5 `tests/helpers/sim-fixtures.ts` (tests only): `DT`, `DCT7_SPEC`, `DCT7_VOICING`, `TC8_SPEC`, `TC8_VOICING`, `MANUAL6_SPEC`, `MANUAL6_VOICING`.
- Produces (`src/sim/driveline.ts`):
  - `export class DrivelineModel` with exactly the contract members: `configure(spec: EngineSpec, voicing: EngineVoicing, seed?: number): void` (default seed 1; throws `Error` for `type 'tc-auto'` with `tc === null`; calls `reset()`), `reset(): void` (idle, `clutch-open`, launch/lock-up state cleared; keeps configuration and the warm flag), `setWarm(warm: boolean): void`, `step(nowS: number, dtS: number, rpmWheel: number, load: number, gear: number, standstill: boolean, runTimeS: number): void`, getters `rpm: number` (engine rpm, pre-limiter) and `state: Driveline`.
  - Exported constants: `RPM_SLEW_RPM_PER_S = 18000` (48 rpm per quantum at 48 kHz; Task 8 uses it), `IDLE_WANDER_RPM = 20`, `IDLE_WANDER_HZ = 0.5`, `COLD_IDLE_RPM = 300`, `COLD_IDLE_HOLD_S = 45`, `COLD_IDLE_END_S = 60`, `CLUTCH_OPEN_FACTOR = 1.05`, `CLUTCH_CLOSE_FACTOR = 1.15`, `LAUNCH_LOAD = 0.1`, `LAUNCH_TAPER_START_S = 0.5`, `LAUNCH_TAPER_END_S = 1.0`, `LOCK_MARGIN_RPM = 50`, `TC_LOCK_RAMP_S = 0.4`, `TC_UNLOCK_HYSTERESIS_RPM = 200`, `TC_UNLOCK_LOAD = 0.9`, `TC_SR_LIGHT = 0.97`.
  - Observable behaviour Task 8 relies on: `gear < 1` = neutral (state `clutch-open`, rpm → idle incl. wander and cold idle) — SimCore uses it while cranking and in the hidden hold; the first `step` after `configure`/`reset` snaps to its target; afterwards `rpm` moves by at most `RPM_SLEW_RPM_PER_S·dtS` per step **except** on a step whose `gear` differs from the previous step's while both are ≥ 1 and `standstill` is false (a shift: snaps to the new gear's target); `step` never allocates and never returns a non-finite rpm.

**Cross-task premises:** (open each named file and confirm before coding)
- Task 5 `tests/helpers/sim-fixtures.ts` exists with the exports listed above; `TC8_SPEC.gearbox.tc` is `{ stallRpmWot: 2600, lockupTurbineRpm: 1300, couplingSR: 0.88 }`, idle 650; `DCT7` idle 800 with `DCT7_VOICING.launchRpm` 3150; `MANUAL6` idle 750 with launch 4125 (the numeric expectations below use these).
- Task 1 `wheelRpm`/`rollingCircumferenceM` as in Task 5's premises (used only by the stop-go continuity test).
- Task 8 (SimCore) feeds `rpmWheel = gearbox.rpmInGear(gear, v)`, the low-passed `load`, the gearbox `gear` (0 while cranking / hidden), the source's `standstill`, and `runTimeS` since ignition on.
- Hot-path rule: `step` and the private helpers it calls contain no `new`, literals, closures, spread, template literals, `try`/`throw` (Phase 2a ESLint rule, Task 12 audit).

Rules implemented (spec §8.4 + phase-1 contract) and the decisions made explicit here (listed in the plan header's Concerns section: PC8 wander, PC9 launch arming; PC2 proposes unlocking the converter on every A4 kickdown — not implemented until the contract owner approves it):
- `idleBase = spec.rpm.idle + coldIdle(runTimeS)`; `idle = idleBase + wander(nowS)`, wander = 20·(0.7·sin(2π·0.5·t + φ₁) + 0.3·sin(2π·0.21·t + φ₂)) (|w| ≤ 20 rpm, deterministic from the seed); coldIdle = 300 rpm for `runTimeS < 45` unless warm, linear to 0 at 60 s. The clutch thresholds use `idleBase` (so a cold-idling engine disengages at 1.05·(idle + cold idle)).
- Clutch types (`dct | pdk | manual | amt`): `engaged` → `clutch-open` when `rpmWheel < 1.05·idleBase`; `clutch-open` → `engaged` when `rpmWheel > 1.15·idleBase`; a launch (`slipping`) starts from `clutch-open` when `load > 0.1` and the launch is armed. Arming generalises "first after standstill": a launch is re-armed whenever `load ≤ 0.1` (the driver lifts — at a standstill the foot is off before the press) or the clutch opens; holding the throttle after a launch that timed out does not re-flare every second. While slipping `rpm = max(rpmWheel, idle + max(load,0)·(launchRpm − idle)·taper(t))`, taper 1 until 0.5 s then linear to 0 at 1.0 s; lock (`engaged`, `rpm = rpmWheel`) only when `rpmWheel ≥ max(1.05·idleBase, rpmSlip − 50)`; when the wheels never catch up (`rpmWheel < 1.05·idleBase` after the taper or once load ≤ 0.1) it returns to `clutch-open` — the timer never forces lock.
- Torque converter (`tc-auto`): `SR = lerp(0.97, couplingSR, clamp(load,0,1))`, `stall = lerp(idle, stallRpmWot, clamp(load,0,1))`, unlocked `rpm = ((rpmWheel/SR)^4 + stall^4)^(1/4)` (`tc-stall` when `rpmWheel/SR < stall`, else `slipping`); lock-up when gear ≥ 2, `rpmWheel > lockupTurbineRpm` and load < 0.9 (state `engaged`, slip ramps to 0 over 0.4 s); unlock when load > 0.9, `rpmWheel < lockupTurbineRpm − 200` or gear < 2 (slip ramps back over 0.4 s).
- Continuity: every target passes the 18 000 rpm/s slew limiter (no step > 48 rpm per quantum at 48 kHz), bypassed only for a shift (gear change while moving). This is what makes clutch re-engagement (an inherent `idle → 1.15·idle` jump), the last ≤ 50 rpm of launch slip, `setWarm(true)` during cold idle and upstream speed jumps continuous.

- [ ] **Step 1: Write the failing test, part 1 (probe helper, idle, clutch types)**

Create `tests/unit/driveline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Driveline, EngineSpec, EngineVoicing } from '../../src/contracts';
import { DrivelineModel, RPM_SLEW_RPM_PER_S } from '../../src/sim/driveline';
import { rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';
import {
  DCT7_SPEC,
  DCT7_VOICING,
  DT,
  MANUAL6_SPEC,
  MANUAL6_VOICING,
  TC8_SPEC,
  TC8_VOICING,
} from '../helpers/sim-fixtures';

const MAX_STEP = RPM_SLEW_RPM_PER_S * DT; // 48 rpm per quantum at 48 kHz

function make(spec: EngineSpec, voicing: EngineVoicing, warm = true, seed = 1): DrivelineModel {
  const d = new DrivelineModel();
  d.configure(spec, voicing, seed);
  d.setWarm(warm);
  return d;
}

interface In {
  rw: number;
  load?: number;
  gear?: number;
  standstill?: boolean;
  runTimeS?: number;
}

function stepAt(d: DrivelineModel, t: number, i: In): void {
  d.step(t, DT, i.rw, i.load ?? 0, i.gear ?? 1, i.standstill ?? false, i.runTimeS ?? 100);
}

/** Records rpm/state per quantum and asserts the 50-rpm continuity rule (gear changes while moving excepted). */
class Probe {
  readonly rpm: number[] = [];
  readonly states: Driveline[] = [];
  private prevRpm = Number.NaN;
  private prevGear = Number.NaN;

  constructor(private readonly d: DrivelineModel) {}

  step(t: number, i: In): void {
    stepAt(this.d, t, i);
    const r = this.d.rpm;
    const gear = i.gear ?? 1;
    const shift = gear !== this.prevGear && gear >= 1 && this.prevGear >= 1 && !(i.standstill ?? false);
    if (this.prevRpm === this.prevRpm && !shift) {
      expect(Math.abs(r - this.prevRpm), `t=${t.toFixed(4)}`).toBeLessThanOrEqual(50);
    }
    expect(Number.isFinite(r)).toBe(true);
    this.prevRpm = r;
    this.prevGear = gear;
    this.rpm.push(r);
    const last = this.states[this.states.length - 1];
    if (last !== this.d.state) this.states.push(this.d.state);
  }
}

describe('DrivelineModel — idle', () => {
  it('idles at spec idle ± 20 rpm with a deterministic wander', () => {
    const a = make(DCT7_SPEC, DCT7_VOICING);
    const b = make(DCT7_SPEC, DCT7_VOICING);
    const c = make(DCT7_SPEC, DCT7_VOICING, true, 99);
    let min = Infinity;
    let max = -Infinity;
    let differs = false;
    for (let k = 0; k < 7500; k++) {
      const t = k * DT; // 20 s
      for (const d of [a, b, c]) stepAt(d, t, { rw: 0, standstill: true });
      expect(a.rpm).toBe(b.rpm);
      if (a.rpm !== c.rpm) differs = true;
      expect(a.state).toBe('clutch-open');
      min = Math.min(min, a.rpm);
      max = Math.max(max, a.rpm);
    }
    expect(min).toBeGreaterThanOrEqual(800 - 20);
    expect(max).toBeLessThanOrEqual(800 + 20);
    expect(max - min).toBeGreaterThan(10);
    expect(differs).toBe(true);
  });

  it('cold idle: +300 rpm until 45 s, linear to 0 at 60 s; none when warm', () => {
    const cold = make(DCT7_SPEC, DCT7_VOICING, false);
    const warm = make(DCT7_SPEC, DCT7_VOICING, true);
    const p = new Probe(cold);
    const at: Record<string, number> = {};
    for (let k = 0; k * DT < 62; k++) {
      const t = k * DT;
      p.step(t, { rw: 0, standstill: true, runTimeS: t });
      stepAt(warm, t, { rw: 0, standstill: true, runTimeS: t });
      for (const mark of [10, 44, 52.5, 61]) if (at[mark] === undefined && t >= mark) at[mark] = cold.rpm;
      if (t >= 10 && t < 10 + DT) expect(Math.abs(warm.rpm - 800)).toBeLessThanOrEqual(20);
    }
    expect(Math.abs((at[10] ?? 0) - 1100)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[44] ?? 0) - 1100)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[52.5] ?? 0) - 950)).toBeLessThanOrEqual(20);
    expect(Math.abs((at[61] ?? 0) - 800)).toBeLessThanOrEqual(20);
  });

  it('gear 0 is neutral: clutch open at idle whatever the wheels and load do', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    for (let k = 0; k < 400; k++) stepAt(d, k * DT, { rw: 3000, load: 1, gear: 0 });
    expect(d.state).toBe('clutch-open');
    expect(Math.abs(d.rpm - 800)).toBeLessThanOrEqual(20);
  });
});

describe('DrivelineModel — clutch types', () => {
  it('opens below 1.05·idle and re-engages above 1.15·idle, continuously', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    let openedAt = Number.NaN;
    let closedAt = Number.NaN;
    for (let rw = 1500; rw > 500; rw -= 1) {
      p.step(t, { rw, gear: 2 });
      if (d.state === 'clutch-open' && openedAt !== openedAt) openedAt = rw;
      if (d.state === 'engaged' && rw < 1400) expect(d.rpm).toBeCloseTo(rw, 6);
      t += DT;
    }
    for (let rw = 500; rw < 1500; rw += 1) {
      p.step(t, { rw, gear: 2 });
      if (d.state === 'engaged' && closedAt !== closedAt) closedAt = rw;
      t += DT;
    }
    expect(openedAt).toBeLessThan(1.05 * 800);
    expect(openedAt).toBeGreaterThanOrEqual(1.05 * 800 - 1);
    expect(closedAt).toBeGreaterThan(1.15 * 800);
    expect(closedAt).toBeLessThanOrEqual(1.15 * 800 + 1);
    expect(p.states).toEqual(['engaged', 'clutch-open', 'engaged']);
    expect(d.rpm).toBeCloseTo(1499, 6);
  });

  it('launch flare: idle + load·(launchRpm − idle), flat to 0.5 s, tapering to idle at 1.0 s, never forcing lock', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 1; t += DT) p.step(t, { rw: 0, standstill: true });
    const t0 = t; // first quantum with load > 0.1
    const flare = 800 + 0.6 * (3150 - 800); // 2210 (± wander·0.4)
    const sample: Record<string, number> = {};
    for (; t < t0 + 3; t += DT) {
      p.step(t, { rw: 0, load: 0.6, standstill: true });
      for (const m of [0.4, 0.75, 1.2, 2.9]) if (sample[m] === undefined && t - t0 >= m) sample[m] = d.rpm;
      if (t - t0 < 1) expect(d.state).toBe('slipping');
    }
    expect(Math.abs((sample[0.4] ?? 0) - flare)).toBeLessThanOrEqual(10);
    expect(Math.abs((sample[0.75] ?? 0) - (800 + 0.6 * 2350 * 0.5))).toBeLessThanOrEqual(15);
    expect(Math.abs((sample[1.2] ?? 0) - 800)).toBeLessThanOrEqual(20);
    expect(Math.abs((sample[2.9] ?? 0) - 800)).toBeLessThanOrEqual(20); // holding the load does not re-flare
    expect(p.states).toEqual(['clutch-open', 'slipping', 'clutch-open']);
    // lift, then press again → a new launch
    for (let k = 0; k < 20; k++, t += DT) p.step(t, { rw: 0, load: 0, standstill: true });
    for (let k = 0; k < 150; k++, t += DT) p.step(t, { rw: 0, load: 0.6, standstill: true });
    expect(d.state).toBe('slipping');
    expect(d.rpm).toBeGreaterThan(2000);
  });

  it('launch locks once the wheels catch up: rw ≥ max(1.05·idle, slip − 50)', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.5; t += DT) p.step(t, { rw: 0, standstill: true });
    const t0 = t;
    let lockedAt = Number.NaN;
    for (; t < t0 + 2; t += DT) {
      const rw = 1000 * (t - t0); // wheels accelerate at 1000 rpm/s
      p.step(t, { rw, load: 0.5, standstill: rw < 100 });
      if (d.state === 'engaged' && lockedAt !== lockedAt) {
        lockedAt = t - t0;
        expect(Math.abs(d.rpm - rw)).toBeLessThanOrEqual(50); // the last ≤ 50 rpm of slip closes via the slew
      }
      if (t - t0 > lockedAt + 4 * DT) expect(d.rpm).toBeCloseTo(rw, 6); // then rpm = rpmWheel
    }
    // slip(t) = 800 + 0.5·2350·(1 − t)/0.5 in the taper → lock where 1000·t = slip − 50 ⇒ t ≈ 0.925 s
    expect(lockedAt).toBeGreaterThan(0.9);
    expect(lockedAt).toBeLessThan(0.95);
    expect(p.states).toEqual(['clutch-open', 'slipping', 'engaged']);
  });

  it('a gear change while moving snaps to the new wheel rpm; a gear change at standstill slews', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING);
    let t = 0;
    for (let k = 0; k < 10; k++, t += DT) stepAt(d, t, { rw: 5000, gear: 2, load: 0.5 });
    expect(d.state).toBe('engaged');
    expect(d.rpm).toBe(5000);
    stepAt(d, t, { rw: (5000 * 6.1) / 8.6, gear: 3, load: 0.5 });
    t += DT;
    expect(d.rpm).toBeCloseTo((5000 * 6.1) / 8.6, 9); // snapped (≈ 3547)
    for (let k = 0; k < 10; k++, t += DT) stepAt(d, t, { rw: 3000, gear: 3 });
    const before = d.rpm;
    stepAt(d, t, { rw: 0, gear: 1, standstill: true }); // standstill → gear 1 is not a shift
    expect(before - d.rpm).toBeCloseTo(MAX_STEP, 9);
    expect(d.state).toBe('clutch-open');
  });

  it('manual gearbox uses the same clutch model (NA launchRpm 0.55·redline)', () => {
    const d = make(MANUAL6_SPEC, MANUAL6_VOICING);
    let t = 0;
    for (; t < 0.5; t += DT) stepAt(d, t, { rw: 0, standstill: true });
    for (let k = 0; k < 120; k++, t += DT) stepAt(d, t, { rw: 0, load: 1, standstill: true });
    expect(d.state).toBe('slipping');
    expect(Math.abs(d.rpm - 4125)).toBeLessThanOrEqual(5); // 750 + 1·(4125 − 750) (wander × 0)
  });
});
```

- [ ] **Step 2: Append part 2 (torque converter, robustness, stop-go continuity per gearbox type)**

Append to `tests/unit/driveline.test.ts` (after one blank line):

```ts
describe('DrivelineModel — torque converter', () => {
  // TC8: idle 650, stallRpmWot 2600, lockupTurbineRpm 1300, couplingSR 0.88
  const unlocked = (rw: number, load: number, idle: number): number => {
    const l = Math.min(1, Math.max(0, load));
    const sr = 0.97 + (0.88 - 0.97) * l;
    const stall = idle + (2600 - idle) * l;
    return Math.pow(Math.pow(rw / sr, 4) + Math.pow(stall, 4), 0.25);
  };

  it('stalls at idle with no load and at stallRpmWot at full load (tc-stall)', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.5; t += DT) p.step(t, { rw: 0, standstill: true });
    expect(Math.abs(d.rpm - 650)).toBeLessThanOrEqual(20);
    expect(d.state).toBe('tc-stall');
    for (const end = t + 1; t < end; t += DT) p.step(t, { rw: 0, load: 1, standstill: true });
    expect(d.rpm).toBeCloseTo(2600, 6);
    expect(d.state).toBe('tc-stall');
  });

  it('follows ((rw/SR)^4 + stall^4)^(1/4) unlocked, reporting slipping once the pump outruns stall; no lock-up in 1st', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.3; t += DT) p.step(t, { rw: 0, load: 0.5, standstill: true });
    for (let rw = 0; rw < 3000; rw += 1.5, t += DT) {
      p.step(t, { rw, load: 0.5 });
      // wander moves stall by ≤ 0.5·20 rpm, the smooth max by no more than that
      expect(Math.abs(d.rpm - unlocked(rw, 0.5, 650))).toBeLessThanOrEqual(10.5);
      const pumpAboveStall = rw / 0.925 > 1625 + 10;
      const pumpBelowStall = rw / 0.925 < 1625 - 10;
      if (pumpAboveStall) expect(d.state).toBe('slipping');
      if (pumpBelowStall) expect(d.state).toBe('tc-stall');
    }
    expect(p.states).toEqual(['tc-stall', 'slipping']);
  });

  it('locks up in ≥ 2nd above lockupTurbineRpm at load < 0.9, slip ramping to zero over 0.4 s', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    const u = unlocked(2000, 0.3, 650); // ≈ 2179
    let mid = Number.NaN;
    for (let k = 0; k * DT < 0.6; k++, t += DT) {
      p.step(t, { rw: 2000, load: 0.3, gear: 2 });
      expect(d.state).toBe('engaged');
      if (mid !== mid && (k + 1) * DT >= 0.2) mid = d.rpm;
    }
    expect(Math.abs(mid - (u + 2000) / 2)).toBeLessThanOrEqual(5);
    expect(d.rpm).toBeCloseTo(2000, 9);
  });

  it('unlocks on kickdown (load > 0.9) and below lockupTurbineRpm − 200, ramping back over 0.4 s', () => {
    const d = make(TC8_SPEC, TC8_VOICING);
    const p = new Probe(d);
    let t = 0;
    for (; t < 0.6; t += DT) p.step(t, { rw: 2000, load: 0.3, gear: 2 });
    expect(d.rpm).toBeCloseTo(2000, 9);
    // kickdown load
    for (let k = 0; k * DT < 0.6; k++, t += DT) {
      p.step(t, { rw: 2000, load: 0.95, gear: 2 });
      expect(d.state).not.toBe('engaged');
    }
    expect(Math.abs(d.rpm - unlocked(2000, 0.95, 650))).toBeLessThanOrEqual(2);
    // back to part load → locks again
    for (let k = 0; k * DT < 0.6; k++, t += DT) p.step(t, { rw: 2000, load: 0.3, gear: 2 });
    expect(d.state).toBe('engaged');
    // turbine rpm hysteresis: stays locked down to 1100, unlocks below
    for (let rw = 2000; rw > 900; rw -= 1, t += DT) {
      p.step(t, { rw, load: 0.3, gear: 2 });
      if (rw > 1101) expect(d.state).toBe('engaged');
      if (rw < 1099) expect(d.state).not.toBe('engaged');
    }
  });
});

describe('DrivelineModel — robustness', () => {
  it('requires tc data for a tc-auto gearbox', () => {
    const bad: EngineSpec = { ...TC8_SPEC, gearbox: { ...TC8_SPEC.gearbox, tc: null } };
    expect(() => new DrivelineModel().configure(bad, TC8_VOICING)).toThrow(Error);
  });

  it('non-finite inputs never produce a non-finite rpm', () => {
    for (const [spec, voicing] of [
      [DCT7_SPEC, DCT7_VOICING],
      [TC8_SPEC, TC8_VOICING],
    ] as const) {
      const d = make(spec, voicing, false);
      d.step(0, DT, Number.NaN, Number.NaN, 2, false, Number.NaN);
      d.step(Number.NaN, Number.NaN, Infinity, -Infinity, 3, false, 5);
      d.step(DT, DT, 1500, Number.NaN, 2, false, -1);
      expect(Number.isFinite(d.rpm)).toBe(true);
    }
  });

  it('reset() returns to idle with the clutch open and keeps the warm flag', () => {
    const d = make(DCT7_SPEC, DCT7_VOICING, true);
    for (let k = 0; k < 100; k++) stepAt(d, k * DT, { rw: 4000, gear: 3, load: 0.5, runTimeS: 1 });
    expect(d.state).toBe('engaged');
    d.reset();
    expect(d.state).toBe('clutch-open');
    expect(d.rpm).toBe(800);
    stepAt(d, 1, { rw: 0, standstill: true, runTimeS: 1 });
    expect(Math.abs(d.rpm - 800)).toBeLessThanOrEqual(20); // warm: no cold idle
  });

  it.each([
    ['DCT7', DCT7_SPEC, DCT7_VOICING],
    ['TC8', TC8_SPEC, TC8_VOICING],
    ['MANUAL6', MANUAL6_SPEC, MANUAL6_VOICING],
  ] as const)('%s: stop-go drive is continuous (≤ 50 rpm/quantum except shifts) and never below idle', (_n, spec, voicing) => {
    const d = make(spec, voicing, false);
    const p = new Probe(d);
    const c = rollingCircumferenceM(spec.gearbox.drivenTyre);
    const ratios = spec.gearbox.overallRatios;
    const top = ratios.length;
    let gear = 1;
    let v = 0;
    let t = 0;
    const rwOf = (g: number): number => wheelRpm(v, ratios[g - 1] ?? 0, c);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let k = 0; k * DT < 2; k++, t += DT) p.step(t, { rw: 0, standstill: true, runTimeS: t });
      for (let k = 0; k * DT < 15; k++, t += DT) {
        v += 3 * DT;
        if (gear < top && rwOf(gear) > 0.8 * spec.rpm.redline) gear++;
        p.step(t, { rw: rwOf(gear), load: 0.7, gear, runTimeS: t });
      }
      for (; v > 0; t += DT) {
        v = Math.max(0, v - 2.5 * DT);
        if (gear > 1 && rwOf(gear) < 1.3 * spec.rpm.idle) gear--;
        const standstill = v < 0.3;
        if (standstill) gear = 1;
        p.step(t, { rw: rwOf(gear), load: -0.4, gear, standstill, runTimeS: t });
      }
    }
    const floor = spec.rpm.idle - 20 - 1e-9;
    for (const r of p.rpm) expect(r).toBeGreaterThanOrEqual(floor);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx vitest run tests/unit/driveline.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/driveline' imported from …/tests/unit/driveline.test.ts`; `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 4: Implement `src/sim/driveline.ts`**

```ts
import type { Driveline, EngineSpec, EngineVoicing } from '../contracts';

/**
 * Low-speed engine/road coupling (spec §8.4, phase-1 contract): idle (wander + cold idle), clutch
 * disengage/re-engage, clutch launch slip, torque converter with lock-up. Never stalls.
 *
 * Continuity: every target is passed through a slew limiter of RPM_SLEW_RPM_PER_S (48 rpm per
 * 128-frame quantum at 48 kHz) so state changes (clutch re-engage, launch flare, cold-idle end,
 * source switches upstream) never step the rpm by more than 50 rpm per quantum. The only bypass is
 * a gear change while moving (a shift: the DSP follows the shift trajectory instead).
 */

/** Maximum engine-rpm slew outside shifts: 18 000 rpm/s = 48 rpm per quantum at 48 kHz. */
export const RPM_SLEW_RPM_PER_S = 18000;
/** Idle wander amplitude bound (rpm) and main frequency (Hz). */
export const IDLE_WANDER_RPM = 20;
export const IDLE_WANDER_HZ = 0.5;
/** Cold idle: +300 rpm until 45 s after ignition, then a linear ramp to 0 at 60 s (unless warm). */
export const COLD_IDLE_RPM = 300;
export const COLD_IDLE_HOLD_S = 45;
export const COLD_IDLE_END_S = 60;
/** Clutch disengages below 1.05·idleBase wheel rpm and re-engages above 1.15·idleBase. */
export const CLUTCH_OPEN_FACTOR = 1.05;
export const CLUTCH_CLOSE_FACTOR = 1.15;
/** A launch starts when load exceeds this with the clutch open. */
export const LAUNCH_LOAD = 0.1;
/** Launch taper: 1 until 0.5 s, then linear to 0 at 1.0 s. */
export const LAUNCH_TAPER_START_S = 0.5;
export const LAUNCH_TAPER_END_S = 1.0;
/** Clutch locks once wheel rpm is within this of the slip target. */
export const LOCK_MARGIN_RPM = 50;
/** Torque converter: lock-up/unlock slip ramp time and unlock hysteresis. */
export const TC_LOCK_RAMP_S = 0.4;
export const TC_UNLOCK_HYSTERESIS_RPM = 200;
export const TC_UNLOCK_LOAD = 0.9;
/** Coupling speed ratio at zero load (turbine/pump). */
export const TC_SR_LIGHT = 0.97;

/** Deterministic phase in [0, 2π) from (seed, k) — integer hash, configure-time only. */
function seededPhase(seed: number, k: number): number {
  let x = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(k + 1, 0x85ebca6b)) | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 * Math.PI;
}

/** 1 for t < 0.5 s, linear to 0 at 1.0 s, 0 after (and for t = +Infinity: no launch running). */
function launchTaper(t: number): number {
  if (t < LAUNCH_TAPER_START_S) return 1;
  if (t >= LAUNCH_TAPER_END_S) return 0;
  return (LAUNCH_TAPER_END_S - t) / (LAUNCH_TAPER_END_S - LAUNCH_TAPER_START_S);
}

export class DrivelineModel {
  private configured = false;
  private idleSpec = 800;
  private launchRpm = 3000;
  private isTc = false;
  private tcStallWot = 0;
  private tcLockupRpm = 0;
  private tcCouplingSR = 0.9;
  private warm = false;
  private phase1 = 0;
  private phase2 = 0;

  private _rpm = 800;
  private _state: Driveline = 'clutch-open';
  /** False until the first step after configure/reset (that step snaps to its target). */
  private primed = false;
  private prevGear = 0;
  /** Clutch types: a launch may start (re-armed by load ≤ 0.1 or by the clutch opening). */
  private armed = true;
  private launchT0 = -Infinity;
  /** Torque converter: lock-up commanded, and the lock fraction 0 (open) … 1 (locked). */
  private lockCmd = false;
  private lock = 0;

  /** Configure-time only. Throws Error for a tc-auto gearbox without `tc` data. */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed = 1): void {
    const tc = spec.gearbox.tc;
    this.isTc = spec.gearbox.type === 'tc-auto';
    if (this.isTc) {
      if (tc === null) throw new Error('tc-auto gearbox requires gearbox.tc');
      this.tcStallWot = tc.stallRpmWot;
      this.tcLockupRpm = tc.lockupTurbineRpm;
      this.tcCouplingSR = tc.couplingSR;
    }
    this.idleSpec = spec.rpm.idle;
    this.launchRpm = voicing.launchRpm;
    this.phase1 = seededPhase(seed, 0);
    this.phase2 = seededPhase(seed, 1);
    this.configured = true;
    this.reset();
  }

  /** Back to idle / clutch open; keeps the configuration and the warm flag. */
  reset(): void {
    this._rpm = this.idleSpec;
    this._state = 'clutch-open';
    this.primed = false;
    this.prevGear = 0;
    this.armed = true;
    this.launchT0 = -Infinity;
    this.lockCmd = false;
    this.lock = 0;
  }

  /** Warm engine: no cold-idle elevation. */
  setWarm(warm: boolean): void {
    this.warm = warm;
  }

  /** runTimeS = seconds since ignition on. */
  step(
    nowS: number,
    dtS: number,
    rpmWheel: number,
    load: number,
    gear: number,
    standstill: boolean,
    runTimeS: number,
  ): void {
    if (!this.configured) return;
    const idleBase = this.idleSpec + this.coldIdle(runTimeS);
    const idle = idleBase + this.wander(nowS);
    const ld = load === load ? load : 0;
    const rw = rpmWheel > 0 && rpmWheel < Infinity ? rpmWheel : 0;

    let target: number;
    if (gear < 1) {
      // neutral (pre-ignition, cranking, hidden hold): engine at idle, nothing coupled
      this._state = 'clutch-open';
      this.armed = true;
      this.launchT0 = -Infinity;
      this.lockCmd = false;
      this.lock = 0;
      target = idle;
    } else if (this.isTc) {
      target = this.stepTc(dtS, rw, ld, gear, idle);
    } else {
      target = this.stepClutch(nowS, rw, ld, idle, idleBase);
    }

    const shifted = gear !== this.prevGear && gear >= 1 && this.prevGear >= 1 && !standstill;
    if (!this.primed || shifted) {
      this._rpm = target;
    } else {
      const maxStep = dtS > 0 ? RPM_SLEW_RPM_PER_S * dtS : 0;
      const d = target - this._rpm;
      this._rpm += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
    }
    this.primed = true;
    this.prevGear = gear;
  }

  /** Engine rpm (pre-limiter). */
  get rpm(): number {
    return this._rpm;
  }

  get state(): Driveline {
    return this._state;
  }

  private coldIdle(runTimeS: number): number {
    if (this.warm || !(runTimeS < COLD_IDLE_END_S)) return 0;
    if (runTimeS < COLD_IDLE_HOLD_S) return COLD_IDLE_RPM;
    return (COLD_IDLE_RPM * (COLD_IDLE_END_S - runTimeS)) / (COLD_IDLE_END_S - COLD_IDLE_HOLD_S);
  }

  /** Deterministic idle wander, |w| ≤ 20 rpm: 0.5 Hz main component + a slower 0.21 Hz drift. */
  private wander(nowS: number): number {
    const t = nowS === nowS ? nowS : 0;
    return (
      IDLE_WANDER_RPM *
      (0.7 * Math.sin(2 * Math.PI * IDLE_WANDER_HZ * t + this.phase1) + 0.3 * Math.sin(2 * Math.PI * 0.21 * t + this.phase2))
    );
  }

  /** dct | pdk | manual | amt. */
  private stepClutch(nowS: number, rw: number, load: number, idle: number, idleBase: number): number {
    const openBelow = CLUTCH_OPEN_FACTOR * idleBase;
    const closeAbove = CLUTCH_CLOSE_FACTOR * idleBase;
    if (load <= LAUNCH_LOAD) this.armed = true;
    let st = this._state;
    if (st === 'engaged' && rw < openBelow) {
      st = 'clutch-open';
      this.armed = true;
    }
    if (st === 'clutch-open') {
      if (this.armed && load > LAUNCH_LOAD) {
        st = 'slipping';
        this.launchT0 = nowS;
        this.armed = false;
      } else if (rw > closeAbove) {
        st = 'engaged';
      }
    }
    let target = idle;
    if (st === 'slipping') {
      const tLaunch = nowS - this.launchT0;
      const slip = idle + Math.max(load, 0) * (this.launchRpm - idle) * launchTaper(tLaunch);
      if (rw >= Math.max(openBelow, slip - LOCK_MARGIN_RPM)) {
        st = 'engaged';
      } else if (rw < openBelow && (tLaunch >= LAUNCH_TAPER_END_S || load <= LAUNCH_LOAD)) {
        st = 'clutch-open'; // launch over without the car taking up the drive: back to idle
      } else {
        target = Math.max(rw, slip);
      }
    }
    if (st === 'engaged') target = rw;
    this._state = st;
    return target;
  }

  /** tc-auto: smooth-max converter curve, lock-up from 2nd gear with a 0.4 s slip ramp. */
  private stepTc(dtS: number, rw: number, load: number, gear: number, idle: number): number {
    const l01 = load > 0 ? (load < 1 ? load : 1) : 0;
    const sr = TC_SR_LIGHT + (this.tcCouplingSR - TC_SR_LIGHT) * l01;
    const stall = idle + (this.tcStallWot - idle) * l01;
    const pump = rw / sr;
    const p2 = pump * pump;
    const s2 = stall * stall;
    const unlocked = Math.sqrt(Math.sqrt(p2 * p2 + s2 * s2));
    if (this.lockCmd) {
      if (load > TC_UNLOCK_LOAD || rw < this.tcLockupRpm - TC_UNLOCK_HYSTERESIS_RPM || gear < 2) this.lockCmd = false;
    } else if (gear >= 2 && rw > this.tcLockupRpm && load < TC_UNLOCK_LOAD) {
      this.lockCmd = true;
    }
    const rate = dtS > 0 ? dtS / TC_LOCK_RAMP_S : 0;
    this.lock = this.lockCmd ? Math.min(1, this.lock + rate) : Math.max(0, this.lock - rate);
    this._state = this.lockCmd ? 'engaged' : pump < stall ? 'tc-stall' : 'slipping';
    return unlocked + (rw - unlocked) * this.lock;
  }
}
```

- [ ] **Step 5: Run it to see it pass**

```bash
npx vitest run tests/unit/driveline.test.ts
```

Expected: PASS — `Tests  18 passed (18)` (≈ 2 s: the idle and cold-idle tests step 20 s and 62 s of quanta).

- [ ] **Step 6: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no diagnostics. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 7: Demo profile, DemoDriver and PedalPhysics

**Files:**
- Create: `src/sim/demo.ts`
- Test: `tests/unit/demo.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `G` (9.80665), `type TeslaParams`.
  - Task 4 `src/sim/load.ts`: `roadForceN(p: TeslaParams, v: number): number` (`A + B·v + C·v²`), `maxForceN(p: TeslaParams, v: number): number` (`modeFactor · min(fTracN, eta·pEffW / max(v, 1))`) — both allocation-free; `rawLoad(p: TeslaParams, v: number, a: number): number` (tests only).
  - Task 5 `tests/helpers/sim-fixtures.ts` (tests only): `DT`, `MID_TESLA`.
- Produces (`src/sim/demo.ts`, exactly the contract):
  - `export interface PedalCommand { throttle: number; brake: number }`
  - `export const DEMO_PROFILE: readonly { t: number; throttle: number; brake: number }[]` — 17 keyframes, t strictly increasing from 0; the LAST keyframe's `t` (64) is the loop length and equals the first keyframe's pedals (0, 0); throttle and brake are never non-zero together, also between keyframes. Phases: idle 0–3 s; pull-away 3–7 s (0.4) settling at 0.12 to ≈ 50 km/h; WOT 13.5–19.5 s; cruise 20.5–33 s (0.15); lift-off 33–34 s then regen stand-in brake 0.1 until 41 s; braking 0.6 from 42 to 56 s; stand still 56.5–64 s.
  - `export class DemoDriver { constructor(); reset(): void; step(dtS: number, out: PedalCommand): void }` — `step` writes the linearly interpolated pedals for the current profile time into `out`, then advances by `dtS` (wrapping modulo the loop length; `dtS ≤ 0` evaluates without advancing). Allocation-free after construction.
  - `export class PedalPhysics { configure(p: TeslaParams): void; reset(): void; step(throttle: number, brake: number, dtS: number): void; readonly v: number; readonly a: number }` — `a = (throttle·maxForceN − roadForceN − brake·massKg·0.8·G)/massKg` with road force 0 at v = 0, explicit (forward) Euler (`a` from the old `v`, then `v += a·dtS`), pedals clamped to [0, 1] (NaN → 0), `v ≥ 0`; when the clamp at v = 0 engages, `a` is the acceleration actually applied (Δv/dt), so a car held on the brake at rest reports `a = 0` (never −0). No-op before `configure` or for `dtS ≤ 0`. Allocation-free.

**Cross-task premises:** (open each named file and confirm before coding)
- Task 4 `src/sim/load.ts` exports `roadForceN`, `maxForceN`, `rawLoad` with the signatures above (`rawLoad`: F = m·a + F_road; F ≥ 0 → clamp(F/F_max, 0, 1) else max(F/(m·0.25·G), −1)).
- Task 5 `tests/helpers/sim-fixtures.ts`: `MID_TESLA` = 1900 kg, road load A 130 / B 1.0 / C 0.40, fTracN 14 000, pEffW 250 000, eta 0.9, modeFactor 1; `DT = 128/48000`.
- Task 11 (`tests/unit/catalogue.test.ts`) drives one loop with `DemoDriver.step(dtS, pedal)` then `PedalPhysics.step(pedal.throttle, pedal.brake, dtS)` for `t < DEMO_PROFILE[last].t` and computes the mean |Δ rawLoad| for ±20 % road load / ±10 % mass. With this profile the means are ≤ 0.017 for mid-size, quickest, heaviest and slow stand-ins (bound 0.05).
- Task 8 (SimCore) expects these phase windows: crank finished and idle at rest during 2.6–3.0 s, WOT 13.5–19.5 s, top gear at 32 s, lift-off regen 34–41 s (negative load → OVERRUN), braking 42–56 s, stationary from 56.5 s.
- Hot-path rule: `DemoDriver.step` and `PedalPhysics.step` contain no `new`, literals, closures, spread, template literals, `try`/`throw`.

Decision made explicit here (listed in the plan header's Concerns section, PC10): with the contract's force balance (no regen term) the estimated load equals the throttle whenever the brake is off, so a throttle-0 coast reads load exactly 0 and the profile's "lift-off/overrun" phase could never produce overrun. The lift-off therefore uses brake 0.1 (≈ 0.08 g, the Tesla's lift-off regen), giving load ≈ −0.32. Keyframe numbers were tuned with a forward simulation of mid-size, quickest (1.1 g traction, 760 kW), heaviest (3200 kg, C 0.62) and Chill-mode cars: ≈ 52 km/h after the pull-away and ≈ 143 km/h after WOT for the mid-size car, and every class is stationary before 56.5 s.

- [ ] **Step 1: Write the failing test, part 1 (profile shape, DemoDriver)**

Create `tests/unit/demo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { G } from '../../src/contracts';
import type { TeslaParams } from '../../src/contracts';
import { DEMO_PROFILE, DemoDriver, PedalPhysics, type PedalCommand } from '../../src/sim/demo';
import { maxForceN, rawLoad, roadForceN } from '../../src/sim/load';
import { DT, MID_TESLA } from '../helpers/sim-fixtures';

const KMH = 1 / 3.6;
const LOOP_S = DEMO_PROFILE[DEMO_PROFILE.length - 1]?.t ?? 0;

/** Fictional stand-ins for the extremes of the catalogue (quickest, heaviest, Chill mode). */
const QUICK: TeslaParams = {
  massKg: 2250,
  roadLoad: { A_N: 150, B_Nps_m: 1.2, C_Ns2_m2: 0.42 },
  fTracN: 1.1 * 2250 * G,
  pEffW: 760000,
  eta: 0.9,
  modeFactor: 1,
};
const HEAVY: TeslaParams = {
  massKg: 3200,
  roadLoad: { A_N: 220, B_Nps_m: 2.0, C_Ns2_m2: 0.62 },
  fTracN: 0.75 * 3200 * G,
  pEffW: 450000,
  eta: 0.9,
  modeFactor: 1,
};
const CHILL: TeslaParams = { ...HEAVY, modeFactor: 0.5 };

/** Pedals at profile time `time` (evaluate-then-advance: one jump, then a zero-length step). */
function pedalsAt(time: number): PedalCommand {
  const d = new DemoDriver();
  const out: PedalCommand = { throttle: -1, brake: -1 };
  d.step(time, out);
  d.step(0, out);
  return out;
}

/** True if some consecutive keyframe pair satisfies `pred` at both ends and spans ≥ minS; returns its start time. */
function heldFrom(pred: (th: number, br: number) => boolean, minS: number, after = -1): number {
  for (let i = 0; i + 1 < DEMO_PROFILE.length; i++) {
    const a = DEMO_PROFILE[i];
    const b = DEMO_PROFILE[i + 1];
    if (a === undefined || b === undefined || a.t <= after) continue;
    if (pred(a.throttle, a.brake) && pred(b.throttle, b.brake) && b.t - a.t >= minS) return a.t;
  }
  return Number.NaN;
}

describe('DEMO_PROFILE', () => {
  it('starts at rest at t = 0, has strictly increasing times and loops seamlessly at ~64 s', () => {
    const first = DEMO_PROFILE[0];
    const last = DEMO_PROFILE[DEMO_PROFILE.length - 1];
    expect(first).toEqual({ t: 0, throttle: 0, brake: 0 });
    expect(last?.throttle).toBe(0);
    expect(last?.brake).toBe(0);
    expect(LOOP_S).toBeGreaterThanOrEqual(60);
    expect(LOOP_S).toBeLessThanOrEqual(75);
    for (let i = 1; i < DEMO_PROFILE.length; i++) {
      expect(DEMO_PROFILE[i]?.t).toBeGreaterThan(DEMO_PROFILE[i - 1]?.t ?? Infinity);
    }
  });

  it('keeps both pedals in [0, 1] and never applies them together', () => {
    for (const k of DEMO_PROFILE) {
      expect(k.throttle).toBeGreaterThanOrEqual(0);
      expect(k.throttle).toBeLessThanOrEqual(1);
      expect(k.brake).toBeGreaterThanOrEqual(0);
      expect(k.brake).toBeLessThanOrEqual(1);
      expect(k.throttle * k.brake).toBe(0);
    }
  });

  it('contains idle → pull-away → WOT → cruise → lift-off → braking → stop, in that order', () => {
    const idle = heldFrom((th, br) => th === 0 && br === 0, 3);
    const pull = heldFrom((th) => th >= 0.3 && th < 1, 2, idle);
    const wot = heldFrom((th) => th === 1, 4, pull);
    const cruise = heldFrom((th) => th > 0 && th < 0.3, 10, wot);
    const lift = heldFrom((th, br) => th === 0 && br > 0 && br <= 0.15, 5, cruise); // lift-off regen
    const brake = heldFrom((th, br) => th === 0 && br >= 0.5, 10, lift);
    const stop = heldFrom((th, br) => th === 0 && br === 0, 5, brake);
    expect([idle, pull, wot, cruise, lift, brake, stop].every((x) => Number.isFinite(x))).toBe(true);
    expect(idle).toBe(0);
  });
});

describe('DemoDriver', () => {
  it('returns the t = 0 keyframe on the first step, then advances', () => {
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: -1, brake: -1 };
    d.step(DT, out);
    expect(out).toEqual({ throttle: 0, brake: 0 });
  });

  it('interpolates linearly between keyframes', () => {
    expect(pedalsAt(3.25).throttle).toBeCloseTo(0.2, 12); // (3, 0) → (3.5, 0.4)
    expect(pedalsAt(6.5).throttle).toBeCloseTo(0.26, 12); // (6, 0.4) → (7, 0.12)
    expect(pedalsAt(16).throttle).toBe(1);
    expect(pedalsAt(33.75)).toEqual({ throttle: 0, brake: 0.05 }); // (33.5, 0, 0) → (34, 0, 0.1)
    expect(pedalsAt(41.5).throttle).toBe(0); // (41, 0, 0.1) → (42, 0, 0.6)
    expect(pedalsAt(41.5).brake).toBeCloseTo(0.35, 12);
    expect(pedalsAt(49).brake).toBeCloseTo(0.6, 12);
  });

  it('loops: profile time loopS + x plays the same pedals as x; reset() restarts at idle', () => {
    for (const x of [1, 5, 16.25, 30, 49]) {
      const a = pedalsAt(x);
      const b = pedalsAt(LOOP_S + x);
      const c = pedalsAt(3 * LOOP_S + x);
      expect(b.throttle).toBeCloseTo(a.throttle, 9);
      expect(b.brake).toBeCloseTo(a.brake, 9);
      expect(c.throttle).toBeCloseTo(a.throttle, 9);
    }
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: 0, brake: 0 };
    d.step(16, out);
    d.step(0, out);
    expect(out.throttle).toBe(1);
    d.reset();
    d.step(DT, out);
    expect(out).toEqual({ throttle: 0, brake: 0 });
  });

  it('stepped per quantum over two loops, the pedal trace has no jumps (incl. the loop wrap)', () => {
    const d = new DemoDriver();
    const out: PedalCommand = { throttle: 0, brake: 0 };
    let prevTh = 0;
    let prevBr = 0;
    let sawWot = 0;
    for (let k = 0; k * DT < 2 * LOOP_S; k++) {
      d.step(DT, out);
      expect(Math.abs(out.throttle - prevTh)).toBeLessThan(0.01);
      expect(Math.abs(out.brake - prevBr)).toBeLessThan(0.01);
      expect(out.throttle * out.brake).toBe(0); // never both, also between keyframes
      if (out.throttle === 1) sawWot++;
      prevTh = out.throttle;
      prevBr = out.brake;
    }
    expect(sawWot).toBeGreaterThan(2 * Math.floor(4 / DT));
  });
});
```

- [ ] **Step 2: Append part 2 (PedalPhysics, profile driven through the physics)**

Append to `tests/unit/demo.test.ts` (after one blank line):

```ts
describe('PedalPhysics', () => {
  it('integrates a = (throttle·maxForceN − roadForceN − brake·m·0.8·G)/m step by step', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    let v = 0;
    for (let k = 0; k < 3000; k++) {
      const th = k < 1500 ? 0.7 : 0;
      const br = k >= 2500 ? 0.2 : 0;
      const fRoad = v > 0 ? roadForceN(MID_TESLA, v) : 0;
      const a = (th * maxForceN(MID_TESLA, v) - fRoad - br * MID_TESLA.massKg * 0.8 * G) / MID_TESLA.massKg;
      v = Math.max(0, v + a * DT);
      ph.step(th, br, DT);
      expect(ph.v).toBeCloseTo(v, 9);
      if (v > 0) expect(ph.a).toBeCloseTo(a, 9);
    }
    expect(ph.v).toBeGreaterThan(5);
  });

  it('has zero road force at rest: without throttle a stationary car stays put with a = 0', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    for (let k = 0; k < 100; k++) {
      ph.step(0, 0, DT);
      expect(ph.v).toBe(0);
      expect(ph.a).toBe(0);
    }
  });

  it('clamps at v = 0 when braking to a stop and reports the acceleration actually applied', () => {
    const ph = new PedalPhysics();
    ph.configure(MID_TESLA);
    for (let k = 0; k < 400; k++) ph.step(1, 0, DT);
    expect(ph.v).toBeGreaterThan(2);
    let stoppedSteps = 0;
    for (let k = 0; k < 2000; k++) {
      const before = ph.v;
      ph.step(0, 1, DT);
      expect(ph.v).toBeGreaterThanOrEqual(0);
      expect(ph.a).toBeCloseTo((ph.v - before) / DT, 6);
      if (ph.v === 0) {
        stoppedSteps++;
        if (before === 0) expect(ph.a).toBe(0); // held on the brake: no phantom −0.8 g
      }
    }
    expect(stoppedSteps).toBeGreaterThan(1000);
  });

  it('clamps pedals to [0, 1] (NaN → 0)', () => {
    const a = new PedalPhysics();
    const b = new PedalPhysics();
    a.configure(MID_TESLA);
    b.configure(MID_TESLA);
    for (let k = 0; k < 50; k++) {
      a.step(7, -3, DT);
      b.step(1, 0, DT);
    }
    expect(a.v).toBe(b.v);
    a.step(Number.NaN, Number.NaN, DT);
    b.step(0, 0, DT);
    expect(a.v).toBe(b.v);
  });

  it('does nothing before configure() or for dtS ≤ 0; reset() stops the car', () => {
    const ph = new PedalPhysics();
    ph.step(1, 0, DT);
    expect(ph.v).toBe(0);
    ph.configure(MID_TESLA);
    ph.step(1, 0, 0);
    ph.step(1, 0, -DT);
    ph.step(1, 0, Number.NaN);
    expect(ph.v).toBe(0);
    for (let k = 0; k < 100; k++) ph.step(1, 0, DT);
    expect(ph.v).toBeGreaterThan(0);
    ph.reset();
    expect(ph.v).toBe(0);
    expect(ph.a).toBe(0);
  });
});

describe('DEMO_PROFILE driven through PedalPhysics', () => {
  function drive(p: TeslaParams): { at: (t: number) => number; trace: { t: number; v: number; a: number; th: number; br: number }[] } {
    const d = new DemoDriver();
    const ph = new PedalPhysics();
    ph.configure(p);
    const pedal: PedalCommand = { throttle: 0, brake: 0 };
    const trace: { t: number; v: number; a: number; th: number; br: number }[] = [];
    for (let k = 0; k * DT < LOOP_S; k++) {
      d.step(DT, pedal);
      ph.step(pedal.throttle, pedal.brake, DT);
      trace.push({ t: (k + 1) * DT, v: ph.v, a: ph.a, th: pedal.throttle, br: pedal.brake });
    }
    const at = (t: number): number => trace[Math.min(trace.length - 1, Math.round(t / DT) - 1)]?.v ?? Number.NaN;
    return { at, trace };
  }

  it('mid-size car: ≈ 50 km/h after the pull-away, ≈ 140 km/h after WOT, then stops before the loop ends', () => {
    const { at, trace } = drive(MID_TESLA);
    expect(at(3)).toBe(0);
    expect(at(13) / KMH).toBeGreaterThan(45);
    expect(at(13) / KMH).toBeLessThan(60);
    expect(at(19.5) / KMH).toBeGreaterThan(130);
    expect(at(19.5) / KMH).toBeLessThan(155);
    expect(at(33) / KMH).toBeGreaterThan(130); // cruise holds speed
    expect(at(41)).toBeLessThan(at(33)); // lift-off decelerates
    expect(at(41)).toBeGreaterThan(25);
    for (const s of trace) {
      if (s.t > 34.5 && s.t < 41) expect(rawLoad(MID_TESLA, s.v, s.a)).toBeLessThan(-0.2); // overrun
    }
    for (const s of trace) if (s.t >= 56.5) expect(s.v).toBe(0);
    for (const s of trace) {
      if (s.br === 0 && s.v > 1) expect(Math.abs(rawLoad(MID_TESLA, s.v, s.a) - s.th)).toBeLessThan(0.01);
    }
  });

  it.each([
    ['quickest', QUICK],
    ['heaviest', HEAVY],
    ['heavy in Chill', CHILL],
  ] as const)('%s car: moving after the pull-away, stationary from 56.5 s to the loop end', (_n, p) => {
    const { at, trace } = drive(p);
    expect(at(13)).toBeGreaterThan(5);
    for (const s of trace) {
      expect(s.v).toBeGreaterThanOrEqual(0);
      if (s.t >= 56.5) expect(s.v).toBe(0);
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
npx vitest run tests/unit/demo.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/demo' imported from …/tests/unit/demo.test.ts`; `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 4: Implement `src/sim/demo.ts`**

```ts
import { G } from '../contracts';
import type { TeslaParams } from '../contracts';
import { maxForceN, roadForceN } from './load';

/** Pedal positions, 0..1 each. */
export interface PedalCommand {
  throttle: number;
  brake: number;
}

/**
 * Scripted demo drive (spec §8.7), linearly interpolated and looped. The LAST keyframe's `t` is the
 * loop length; it equals the first keyframe so the loop is seamless. Tuned so a mid-size dual-motor
 * car reaches ≈ 50 km/h after the pull-away and ≈ 140 km/h after the WOT pull, and every catalogue
 * class (incl. Chill mode, heavy trucks and the quickest cars) is stationary well before the loop
 * restarts. In this model the estimated load equals the throttle whenever the brake is off, so the
 * lift-off phase uses brake 0.1 to stand in for the Tesla's lift-off regen: that deceleration is
 * what makes the load negative (overrun), exactly as it does on the GPS path. Throttle and brake are
 * never non-zero together, also between keyframes.
 */
export const DEMO_PROFILE: readonly { t: number; throttle: number; brake: number }[] = [
  { t: 0, throttle: 0, brake: 0 }, // idle
  { t: 3, throttle: 0, brake: 0 },
  { t: 3.5, throttle: 0.4, brake: 0 }, // pull-away
  { t: 6, throttle: 0.4, brake: 0 },
  { t: 7, throttle: 0.12, brake: 0 }, // settle near 50 km/h
  { t: 13, throttle: 0.12, brake: 0 },
  { t: 13.5, throttle: 1, brake: 0 }, // WOT through the gears
  { t: 19.5, throttle: 1, brake: 0 },
  { t: 20.5, throttle: 0.15, brake: 0 }, // cruise
  { t: 33, throttle: 0.15, brake: 0 },
  { t: 33.5, throttle: 0, brake: 0 }, // lift-off / overrun …
  { t: 34, throttle: 0, brake: 0.1 }, // … with the Tesla's lift-off regen (≈ 0.08 g) → negative load
  { t: 41, throttle: 0, brake: 0.1 },
  { t: 42, throttle: 0, brake: 0.6 }, // braking to a stop
  { t: 56, throttle: 0, brake: 0.6 },
  { t: 56.5, throttle: 0, brake: 0 }, // stand still
  { t: 64, throttle: 0, brake: 0 }, // loop
];

/** Plays DEMO_PROFILE: zero-order evaluation at the start of each step, then time advances. */
export class DemoDriver {
  private readonly times: Float64Array;
  private readonly throttles: Float64Array;
  private readonly brakes: Float64Array;
  private readonly loopS: number;
  private t = 0;
  /** Index of the keyframe at or before `t` (segment start). */
  private seg = 0;

  constructor() {
    const n = DEMO_PROFILE.length;
    this.times = new Float64Array(n);
    this.throttles = new Float64Array(n);
    this.brakes = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = DEMO_PROFILE[i];
      if (k === undefined) continue;
      this.times[i] = k.t;
      this.throttles[i] = k.throttle;
      this.brakes[i] = k.brake;
    }
    this.loopS = this.times[n - 1] ?? 0;
  }

  reset(): void {
    this.t = 0;
    this.seg = 0;
  }

  /** Writes the pedals for the current profile time into `out`, then advances by dtS (looping). */
  step(dtS: number, out: PedalCommand): void {
    const times = this.times;
    const last = times.length - 1;
    while (this.seg < last - 1 && this.t >= (times[this.seg + 1] ?? Infinity)) this.seg++;
    const t0 = times[this.seg] ?? 0;
    const t1 = times[this.seg + 1] ?? t0;
    const u = t1 > t0 ? (this.t - t0) / (t1 - t0) : 0;
    const th0 = this.throttles[this.seg] ?? 0;
    const br0 = this.brakes[this.seg] ?? 0;
    out.throttle = th0 + ((this.throttles[this.seg + 1] ?? th0) - th0) * u;
    out.brake = br0 + ((this.brakes[this.seg + 1] ?? br0) - br0) * u;

    if (dtS > 0) {
      let t = this.t + dtS;
      if (t >= this.loopS) {
        t = this.loopS > 0 ? t - this.loopS * Math.floor(t / this.loopS) : 0;
        this.seg = 0;
      }
      this.t = t;
    }
  }
}

/**
 * Point-mass longitudinal physics for Demo/Keyboard (spec §8.7):
 * a = (throttle·maxForceN − roadForceN − brake·massKg·0.8·G)/massKg, v clamped ≥ 0, road force zero
 * at v = 0. When the clamp at v = 0 engages, `a` is the acceleration actually applied (Δv/dt), so a
 * car held on the brake at a stop reports a = 0.
 */
export class PedalPhysics {
  private p: TeslaParams | null = null;
  private _v = 0;
  private _a = 0;

  configure(p: TeslaParams): void {
    this.p = p;
  }

  reset(): void {
    this._v = 0;
    this._a = 0;
  }

  /** Explicit (forward) Euler over dtS: a from the current v, then v += a·dtS. Pedals are clamped to [0, 1] (NaN → 0). No-op before configure or for dtS ≤ 0. */
  step(throttle: number, brake: number, dtS: number): void {
    const p = this.p;
    if (p === null || !(dtS > 0)) return;
    const th = throttle > 0 ? (throttle < 1 ? throttle : 1) : 0;
    const br = brake > 0 ? (brake < 1 ? brake : 1) : 0;
    const v = this._v;
    const fRoad = v > 0 ? roadForceN(p, v) : 0;
    const a = (th * maxForceN(p, v) - fRoad - br * p.massKg * 0.8 * G) / p.massKg;
    const vNext = v + a * dtS;
    if (vNext > 0) {
      this._v = vNext;
      this._a = a;
    } else {
      this._v = 0;
      this._a = v > 0 ? -v / dtS : 0;
    }
  }

  get v(): number {
    return this._v;
  }

  get a(): number {
    return this._a;
  }
}
```

- [ ] **Step 5: Run it to see it pass**

```bash
npx vitest run tests/unit/demo.test.ts
```

Expected: PASS — `Tests  16 passed (16)`.

- [ ] **Step 6: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no diagnostics. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 8: TesboxSimCore — composition, ignition sequence, sources, limiter clamp, flags, hidden hold

**Files:**
- Create: `src/sim/sim-core.ts`
- Test: `tests/unit/sim-core.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `F`, `DEFAULT_SIM_TUNING` (tests), types `SimCore`, `SimOutput`, `SimTuning`, `SpeedSourceKind`, `FixMsg`, `InputMsg`, `EngineSpec`, `EngineVoicing`, `EngineDef` (tests), `TeslaParams`, `GearboxMode`, `DriveMode`, `Driveline`.
  - Task 1 `src/sim/tyre.ts`: `rollingCircumferenceM(code: string): number` (configure; throws on an unparseable code), `wheelRpm(…)` (tests).
  - Task 2 `src/sim/speed-filter.ts`: `new SpeedFilter()`, `configure(tuning: SimTuning): void`, `accept(fix: FixMsg, nowS: number): boolean`, `evaluate(nowS: number): void`, `setHidden(hidden: boolean): void`, getters `v`, `a`, `flags`, `fixesAccepted`, `fixesRejected` (the last two forwarded by SimCore's own getters).
  - Task 3 `src/sim/replay.ts` (tests only): `ReplayFeeder` (`constructor(trace: ReplayTrace)`, `next(nowS: number, out: FixMsg): boolean`); `tests/helpers/replay-harness.ts` (tests only): `loadTrace(name: string): ReplayTrace`; fixtures `tests/fixtures/replay/{highway-amd,tunnel-dropout,stale-duplicates,intel-zero-speed,intel-null-speed,stoplight-jitter,city-amd}.json`.
  - Task 4 `src/sim/load.ts`: `new LoadEstimator()`, `configure(p: TeslaParams): void`, `update(v: number, a: number, dtS: number): number`, getter `loadRate`.
  - Task 5 `src/sim/gearbox.ts`: `Gearbox` (`configure`, `reset`, `setMode`, `setDriveMode`, `request`, `step`, `rpmInGear`, `gear`, `flags`, `shift`); `src/sim/shift-map.ts` (tests only): `buildShiftMap(spec: EngineSpec, mode: DriveMode): ShiftMap` (`downshiftRpm` tells the A4 kickdown from a map downshift); `tests/helpers/sim-fixtures.ts`: `DT`, `DCT7_SPEC`, `DCT7_VOICING`, `TC8_SPEC`, `TC8_VOICING`, `MANUAL6_SPEC`, `MANUAL6_VOICING`, `MID_TESLA`.
  - Task 6 `src/sim/driveline.ts`: `DrivelineModel` (`configure(spec, voicing, seed?)`, `reset()`, `setWarm(warm)`, `step(nowS, dtS, rpmWheel, load, gear, standstill, runTimeS)`, `rpm`, `state`), `RPM_SLEW_RPM_PER_S`.
  - Task 7 `src/sim/demo.ts`: `DemoDriver` (`reset()`, `step(dtS, out)`), `PedalPhysics` (`configure(p)`, `reset()`, `step(throttle, brake, dtS)`, `v`, `a`), `type PedalCommand`, `DEMO_PROFILE` (tests: loop length).
- Produces (`src/sim/sim-core.ts`):
  - `export class TesboxSimCore implements SimCore` — `constructor()` (allocates every sub-model and `out`), `configure(engine: EngineSpec, voicing: EngineVoicing, tesla: TeslaParams, tuning: SimTuning): void`, `setSource(kind: SpeedSourceKind): void`, `pushFix(fix: FixMsg, nowS: number): boolean`, `pushInput(msg: InputMsg, nowS: number): void`, `step(nowS: number, dtS: number): void`, `readonly out: SimOutput` (one object, mutated in place; `out.shift` is SimCore's own object).
  - Beyond the `SimCore` interface: `setWarm(warm: boolean): void` (the `{ type: 'warm' }` ConfigMsg has no other path into SimCore; forwards to the driveline); `setTuning(tuning: SimTuning): void` (the worklet routes the `{ type: 'tuning' }` ConfigMsg here mid-drive: forwards to `SpeedFilter.configure`, which keeps the filter state — `configure()` would reset the gearbox to gear 1 and re-prime the driveline); read-only getters `fixesAccepted: number` and `fixesRejected: number` (forward the speed filter's counters for the StateSnapshot slots `S.fixesAccepted` / `S.fixesRejected` of `src/contracts.ts` and the spec §4.2 counters; `SimOutput` has no counter fields).
  - Exported constants: `CRANK_RAMP_END_S = 0.6`, `CRANK_RPM = 250`, `CRANK_FLARE_END_S = 1.0`, `CRANK_FLARE_RPM = 800`, `CRANK_SETTLE_END_S = 2.5`, `STOP_DECAY_S = 1.0`, `PEDAL_STANDSTILL_MPS = 0.3`, `DRIVELINE_SEED = 1`.
  - Observable behaviour for the worklet / DSP (Phase 2a+): before ignition `out.rpm = 0`, `out.gear = 0`; `out.ignitionOn` true from the `ignition {on:true}` message until `{on:false}`; `out.runTimeS = nowS − t(ignition on)`; `out.rpm` never moves more than `RPM_SLEW_RPM_PER_S·dtS` per step except on the step a shift starts — and then only in the shift's direction (an upshift never raises it, a downshift never lowers it; against that direction it slews) — and under the limiter clamp; `out.shift.fromRpm/toRpm` are ENGINE rpm (out.rpm just before / just after the shift), `out.shift.t0 === nowS` on that step; `step`, `pushFix`, `pushInput` never allocate.

**Cross-task premises:** (open each named file and confirm before coding)
- Task 2 `SpeedFilter`: before the first accepted fix `evaluate` yields `v = a = 0` and flags ⊇ `GPS_LOST | STANDSTILL`; `accept` returns false for `ageS > 3` and for `accuracyM ≤ 0`; `setHidden(true)` sets `HIDDEN_HOLD` immediately and every `evaluate` keeps it; dropout: `PREDICTING` after 2 s without an accepted arrival, `GPS_LOST` after 20 s with v eased to 0 over the next 10 s; standstill enters below 0.5 m/s and leaves above 1.0 m/s; `evaluate` may be called every quantum (allocation-free). Its `a` output is `a_k·e^(−τ/τa)` with τ ≥ fix age + output latency, and SimCore feeds exactly that `a` to the load estimator (contract SimCore rules). On the GPS path the load is therefore mostly road load (measured on `highway-amd`: max `out.load` 0.19 during the pull, no OVERRUN quantum on the lift-off) — a known contract-level gap reported as proposed amendment A10 in the plan header's Concerns section (PC1). Until the contract owner approves it, implement `a = this.filter.a` as below; the tests below assert nothing about GPS-path load or overrun.
- Task 3 fixtures (generated by `tools/make-synthetic-replay.ts`, never hand-edited): `highway-amd` truth 0 m/s to 3 s, 20 m/s at 9 s, 36.11 m/s from 17 to 47 s, 30 m/s from 57 to 78 s, speed present, 78 s; `tunnel-dropout` 25 m/s from 12 s, fix arrivals stop after 20.0 s and resume at 55.0 s, 83 s; the other five names exist. `ReplayFeeder.next` delivers at most one due fix per call (callers loop) and leaves `out` untouched when it returns false.
- Task 4 `LoadEstimator.update` returns the new low-passed load (τ 0.2 s, deadband ±0.03, NaN raw → 0) and `loadRate` is d(load)/dt (1/s).
- Task 5 `Gearbox`: `reset()` exists; `shift` is never replaced; on the step a shift starts `shift.active && shift.t0 === nowS`; requests reaching a step during a shift are dropped; standstill → gear 1 without a shift event; the Auto over-speed skip-shift as described in Task 5 (when the current gear turns ≥ redline — e.g. the first fix after a tunnel finds the box in gear 1 at 25 m/s — ONE upshift straight to the lowest gear below its own upshift point, or the top gear, with no minimum time in gear).
- Task 5 kickdown follows contract A4 (`load > 0.6 && loadRate > 1.2`) and fires at the demo WOT tip-in: measured with DCT7 Auto Comfort, the map downshift 4→3 at 13.43 s (load 0.56; 4th-gear rpm 2252 < `downshiftRpm(4, 0.56)` 2256) is followed by the A4 kickdown 3→2 at 13.53 s (load 0.72, loadRate 1.40; 3rd-gear rpm 3049 ≥ `downshiftRpm(3, 0.72)` 2513, so the map rule did not trigger it). The DCT7 test identifies the kickdown exactly that way (old-gear rpm still at/above the map downshift point for the load of that step; `out.load` is the load the gearbox saw). A kickdown may drop two gears (target `g ≥ gear − 2`), so the shift-start test allows that.
- Task 6 `DrivelineModel`: gear 0 = neutral idle (`clutch-open`); slew-limited output that snaps only on a gear change while moving; `RPM_SLEW_RPM_PER_S` exported; first step after `reset()` snaps to idle.
- Task 7 `DEMO_PROFILE` phase windows (Task 7 premises) and `PedalPhysics.a = 0` when held at rest.
- Task 12's audit allow-lists `src/sim/replay.ts` as NOT reachable from the runtime: `sim-core.ts` must not import it (only the test does). The Replay source reaches SimCore through `pushFix`, exactly like GPS.
- Hot-path rule: `step` (and every private helper it calls) contains no `new`, literals, closures, spread, template literals, `try`/`throw`.

Rules implemented (contract "SimCore rules" + spec §6.3, §8) and decisions made explicit here (the deviations and extensions are listed in the plan header's Concerns section, PC11):
- Per step: speed source → `LoadEstimator.update` → (running) `gearbox.step(…, clutchOpen = previous driveline state === 'clutch-open')` → `wheel rpm = gearbox.rpmInGear(gear, v)` → `driveline.step` → target rpm → continuity → limiter clamp (`target ≥ limiter.rpm` → `out.rpm = limiter.rpm`, `out.limiter = true`, `LIMITER`).
- Sources: `gps`/`replay` → filter `v`, `a`, flags; `demo` → `DemoDriver` + `PedalPhysics`; `keyboard` → last `pedal` message + `PedalPhysics`; demo/keyboard standstill = v < 0.3. The filter is evaluated every step and fixes always reach it, so its GPS-health bits (`GPS_LOST | PREDICTING | SPEED_UNUSABLE`) are reported whatever the source (status dot / Diagnostics describe the real GPS, spec §10); `STANDSTILL` follows the active source; `PREDICTING` suppresses auto-upshifts only on gps/replay. Switching to `demo` restarts the script from rest; `demo → keyboard` keeps the car rolling (other → keyboard starts at rest); switching to gps/replay keeps the live filter state.
- Ignition: `{on:true}` → crank 0–0.6 s linear to 250 rpm (gear 0), 0.6–1.0 s sine flare to idle + 800, 1.0–2.5 s smoothstep settle to idle (the driveline's live neutral idle incl. wander and cold idle, so the hand-over is seamless), gear 1 after 2.5 s (`gearbox.reset()` at ignition on); `{on:false}` → gear 0 at once, `out.rpm` decays from its current value to 0 over 1.0 s with a raised-cosine. Shift requests count only while running and not in the hidden hold.
- Hidden hold (gps/replay with `HIDDEN_HOLD`): gearbox not stepped (gear held), driveline stepped in neutral → rpm eases to idle at the slew rate (≤ 0.3 s from 6 000 rpm), `out.load = 0`, `out.driveline = 'clutch-open'`, `out.shift.active = false`.
- Flags: source flags | gearbox flags | `LIMITER` | `SHIFTING` (= `out.shift.active`) | `CLUTCH_OPEN` (`driveline === 'clutch-open'`) | `OVERRUN` (`out.load < −0.05 && out.rpm > voicing.overrun.fuelCutResumeRpm && driveline === 'engaged'`).
- Continuity (RF5): `out.rpm` slews at ≤ 18 000 rpm/s (48 rpm per quantum at 48 kHz) except on the step a shift starts (snap to the new gear — but only in the shift's physical direction: an upshift may only lower the rpm, a downshift only raise it; an upshift while the engine is still below the new gear's rpm, e.g. after a standstill or a source switch, slews up instead of jumping) and under the limiter clamp; `out.shift` carries engine rpm (equal to the gearbox's wheel-rpm values whenever the driveline is engaged and the rpm snaps; continuous for the DSP when slipping, in converter slip, on the limiter or when the shift slews).

- [ ] **Step 1: Write the failing test, part 1 (harness, continuity check, lifecycle)**

Create `tests/unit/sim-core.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING, F } from '../../src/contracts';
import type { Driveline, EngineDef, EngineSpec, EngineVoicing, FixMsg, InputMsg, SpeedSourceKind } from '../../src/contracts';
import { DEMO_PROFILE } from '../../src/sim/demo';
import { ReplayFeeder } from '../../src/sim/replay';
import { buildShiftMap } from '../../src/sim/shift-map';
import { TesboxSimCore } from '../../src/sim/sim-core';
import { rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';
import { loadTrace } from '../helpers/replay-harness';
import {
  DCT7_SPEC,
  DCT7_VOICING,
  DT,
  MANUAL6_SPEC,
  MANUAL6_VOICING,
  MID_TESLA,
  TC8_SPEC,
  TC8_VOICING,
} from '../helpers/sim-fixtures';

const LOOP_S = DEMO_PROFILE[DEMO_PROFILE.length - 1]?.t ?? 0;

/** Real engines present when the suite runs (all 15 once Tasks 9–10 are done). */
const ENGINE_JSON = import.meta.glob<EngineDef>('../../src/data/engines/*.json', { eager: true, import: 'default' });
const CATALOGUE = Object.values(ENGINE_JSON).map((d) => [d.id, d] as const);

interface Rec {
  t: number;
  rpm: number;
  gear: number;
  v: number;
  load: number;
  flags: number;
  limiter: boolean;
  driveline: Driveline;
  shiftStart: boolean;
  shiftActive: boolean;
  shiftUp: boolean;
  fromRpm: number;
  toRpm: number;
  ignitionOn: boolean;
  runTimeS: number;
}

/** Steps a TesboxSimCore per 128-frame quantum, feeding replay fixes, and records every output. */
class Harness {
  readonly core = new TesboxSimCore();
  readonly recs: Rec[] = [];
  t = 0;
  private feeder: ReplayFeeder | null = null;
  private feeding = true;
  private readonly fix: FixMsg = { type: 'fix', ageS: 0, speedMps: null, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };

  constructor(spec: EngineSpec = DCT7_SPEC, voicing: EngineVoicing = DCT7_VOICING, source: SpeedSourceKind = 'demo', warm = true) {
    this.core.configure(spec, voicing, MID_TESLA, DEFAULT_SIM_TUNING);
    this.core.setWarm(warm);
    this.core.setSource(source);
  }

  replay(name: string): this {
    this.feeder = new ReplayFeeder(loadTrace(name));
    return this;
  }

  /** Pause/resume fix delivery (the main thread gets no geolocation while hidden). */
  setFeeding(on: boolean): void {
    this.feeding = on;
  }

  input(msg: InputMsg): void {
    this.core.pushInput(msg, this.t);
  }

  /** Runs for `seconds`; returns the records produced. */
  run(seconds: number): Rec[] {
    const start = this.recs.length;
    const end = this.t + seconds - DT / 2;
    const o = this.core.out;
    while (this.t < end) {
      if (this.feeder !== null) {
        while (this.feeder.next(this.t, this.fix)) if (this.feeding) this.core.pushFix(this.fix, this.t);
      }
      this.core.step(this.t, DT);
      this.recs.push({
        t: this.t,
        rpm: o.rpm,
        gear: o.gear,
        v: o.speedMps,
        load: o.load,
        flags: o.flags,
        limiter: o.limiter,
        driveline: o.driveline,
        shiftStart: o.shift.active && o.shift.t0 === this.t,
        shiftActive: o.shift.active,
        shiftUp: o.shift.up,
        fromRpm: o.shift.fromRpm,
        toRpm: o.shift.toRpm,
        ignitionOn: o.ignitionOn,
        runTimeS: o.runTimeS,
      });
      this.t += DT;
    }
    return this.recs.slice(start);
  }

  /** First record at or after time t. */
  at(t: number): Rec {
    const r = this.recs.find((x) => x.t >= t - 1e-9);
    if (r === undefined) throw new Error(`no record at ${t}`);
    return r;
  }

  between(t0: number, t1: number): Rec[] {
    return this.recs.filter((r) => r.t >= t0 && r.t < t1);
  }
}

/**
 * RF5 / continuity rule: |Δ out.rpm| ≤ 50 per quantum except on the quantum a shift starts or while
 * the limiter clamp is (or just was) active; a shift start may move the rpm only in the shift's
 * physical direction (an upshift never raises it, a downshift never lowers it — beyond one slew step).
 * Returns the number of excepted quanta.
 */
function expectContinuous(recs: readonly Rec[]): number {
  let excepted = 0;
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1];
    const b = recs[i];
    if (a === undefined || b === undefined) continue;
    if (b.shiftStart) {
      expect(b.shiftUp ? b.toRpm <= b.fromRpm + 50 : b.toRpm >= b.fromRpm - 50, `shift direction at t=${b.t.toFixed(4)}`).toBe(true);
    }
    if (b.shiftStart || b.limiter || a.limiter) {
      excepted++;
      continue;
    }
    expect(Math.abs(b.rpm - a.rpm), `t=${b.t.toFixed(4)} ${a.rpm.toFixed(1)}→${b.rpm.toFixed(1)}`).toBeLessThanOrEqual(50);
  }
  return excepted;
}

const has = (r: Rec, bit: number): boolean => (r.flags & bit) !== 0;

describe('TesboxSimCore — lifecycle', () => {
  it('step() before configure() is a no-op', () => {
    const core = new TesboxSimCore();
    core.pushInput({ type: 'ignition', on: true }, 0);
    core.step(0, DT);
    core.step(DT, DT);
    expect(core.out.rpm).toBe(0);
    expect(core.out.gear).toBe(0);
    expect(core.out.flags).toBe(0);
  });

  it('before ignition: rpm 0, gear 0, clutch open; GPS flags pass through', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'gps');
    const recs = h.run(1);
    for (const r of recs) {
      expect(r.rpm).toBe(0);
      expect(r.gear).toBe(0);
      expect(r.ignitionOn).toBe(false);
      expect(r.runTimeS).toBe(0);
      expect(r.flags & (F.GPS_LOST | F.STANDSTILL | F.CLUTCH_OPEN)).toBe(F.GPS_LOST | F.STANDSTILL | F.CLUTCH_OPEN);
    }
  });

  it.each([
    ['warm', true, 800],
    ['cold', false, 1100],
  ] as const)('ignition on (%s): crank 0→250 rpm by 0.6 s, flare to idle + 800 at 1.0 s, settle to idle, gear 1 after 2.5 s', (_n, warm, idle) => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'gps', warm);
    h.run(0.5);
    const tOn = h.t;
    h.input({ type: 'ignition', on: true });
    const recs = h.run(4);
    expect(Math.abs(h.at(tOn + 0.3).rpm - 125)).toBeLessThanOrEqual(2); // first quantum at/after the mark
    expect(Math.abs(h.at(tOn + 0.6).rpm - 250)).toBeLessThanOrEqual(3);
    expect(Math.abs(h.at(tOn + 1.0).rpm - (idle + 800))).toBeLessThanOrEqual(25);
    expect(h.at(tOn + 1.75).rpm).toBeGreaterThan(idle + 200);
    expect(Math.abs(h.at(tOn + 2.49).rpm - idle)).toBeLessThanOrEqual(25);
    expect(Math.abs(h.at(tOn + 3.5).rpm - idle)).toBeLessThanOrEqual(25);
    for (const r of recs) {
      expect(r.ignitionOn).toBe(true);
      expect(r.runTimeS).toBeCloseTo(r.t - tOn, 9);
      expect(r.gear).toBe(r.t - tOn < 2.5 - 1e-9 ? 0 : 1);
      expect(r.driveline).toBe('clutch-open');
      expect(r.limiter).toBe(false);
    }
    expect(expectContinuous(recs)).toBe(0);
  });

  it('a shift request during the crank is dropped, not applied when the engine starts running (restart while rolling)', () => {
    // Rolling (demo source keeps driving with the engine off) and Manual: at the first running step the
    // gearbox is stepped without standstill, so a request queued during the crank would upshift to 2nd.
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(10);
    h.input({ type: 'ignition', on: false });
    h.run(1.5);
    h.input({ type: 'ignition', on: true });
    h.run(1);
    h.input({ type: 'shiftUp' }); // mid-crank
    const restart = h.run(1.6);
    const first = restart.find((r) => r.runTimeS >= 2.5 - 1e-9); // first running step
    expect(first?.v).toBeGreaterThan(5);
    expect(first?.gear).toBe(1);
  });

  it('ignition off: gear 0 at once, rpm decays smoothly to 0 over 1.0 s', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(16); // demo pull-away: engaged at speed
    const r0 = h.recs[h.recs.length - 1]?.rpm ?? 0;
    expect(r0).toBeGreaterThan(1500);
    const tOff = h.t;
    h.input({ type: 'ignition', on: false });
    const recs = h.run(1.5);
    for (const r of recs) {
      expect(r.gear).toBe(0);
      expect(r.ignitionOn).toBe(false);
      expect(r.limiter).toBe(false);
      expect(r.flags & F.SHIFTING).toBe(0);
    }
    for (let i = 1; i < recs.length; i++) expect(recs[i]?.rpm ?? 0).toBeLessThanOrEqual(recs[i - 1]?.rpm ?? 0);
    expect(h.at(tOff + 0.5).rpm).toBeCloseTo(r0 / 2, -2);
    expect(h.at(tOff + 1.0).rpm).toBe(0);
    expect(h.at(tOff + 1.4).rpm).toBe(0);
    expect(expectContinuous(recs)).toBe(0);
    // restart while still rolling: neutral during the crank, then gear 1 → the box upshifts as needed
    // (when 1st turns ≥ redline: one over-speed upshift straight to the map gear, Task 5)
    h.input({ type: 'ignition', on: true });
    const restart = h.run(4);
    const firstRunning = restart.find((r) => r.runTimeS >= 2.5 - 1e-9);
    expect(firstRunning?.gear === 1 || (firstRunning?.shiftStart === true && firstRunning.gear > 1)).toBe(true);
    for (const r of restart) {
      if (r.runTimeS < 2.5 - 1e-9) expect(r.gear).toBe(0);
      else expect(r.gear).toBeGreaterThanOrEqual(1);
    }
    expect(restart[restart.length - 1]?.gear).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Append part 2 (demo source over DEMO_PROFILE: DCT7 auto, shift trajectory, manual limiter, TC8)**

Append to `tests/unit/sim-core.test.ts` (after one blank line):

```ts
describe('TesboxSimCore — demo source over DEMO_PROFILE', () => {
  it('DCT7 Auto Comfort: launch → part-load upshifts → WOT pull → cruise in top → overrun → coast-down → stop, continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);

    // idle in gear 1 at rest once cranked
    for (const r of h.between(2.6, 3.0)) {
      expect(r.gear).toBe(1);
      expect(has(r, F.STANDSTILL) && has(r, F.CLUTCH_OPEN)).toBe(true);
      expect(Math.abs(r.rpm - 800)).toBeLessThanOrEqual(20);
    }
    // launch: slipping then engaged
    const pull = h.between(3.0, 13);
    expect(pull.some((r) => r.driveline === 'slipping')).toBe(true);
    expect(h.at(13).driveline).toBe('engaged');
    expect(h.at(13).gear).toBeGreaterThanOrEqual(3);
    // WOT tip-in: the rising load moves the downshift point above the current rpm → map downshift 4→3,
    // then the A4 kickdown (load > 0.6 && loadRate > 1.2, reachable through the LoadEstimator) → 3→2.
    // A downshift whose old-gear rpm was still at/above the map downshift point for the load of that step
    // (out.load = the load the gearbox saw) was not triggered by the map rule: it is the kickdown.
    const comfort = buildShiftMap(DCT7_SPEC, 'comfort');
    const tip = h.between(13.3, 14);
    const kickdowns = tip.filter((r, i) => {
      const p = tip[i - 1];
      if (p === undefined || !r.shiftStart || r.shiftUp) return false;
      const rpmOld = wheelRpm(r.v, DCT7_SPEC.gearbox.overallRatios[p.gear - 1] ?? 0, c);
      return rpmOld >= comfort.downshiftRpm(p.gear, r.load);
    });
    expect(kickdowns.length).toBeGreaterThanOrEqual(1);
    // WOT: upshifts at 0.9·redline (comfort), never the limiter
    const wot = h.between(13.5, 19.6);
    const wotUps = wot.filter((r) => r.shiftStart && r.shiftUp);
    expect(wotUps.length).toBeGreaterThanOrEqual(1);
    for (const r of wotUps) expect(r.fromRpm).toBeGreaterThan(0.89 * 7000);
    expect(Math.max(...wot.map((r) => r.rpm))).toBeLessThan(0.9 * 7000 + 20);
    expect(h.at(19.5).gear).toBeGreaterThan(h.at(13.5).gear - 2);
    // cruise: settles in top gear at low part-load rpm
    const cruise = h.at(32);
    expect(cruise.gear).toBe(7);
    expect(cruise.load).toBeCloseTo(0.15, 1);
    expect(cruise.rpm).toBeCloseTo(wheelRpm(cruise.v, 2.7, c), -1);
    // lift-off with regen: OVERRUN while engaged above fuelCutResumeRpm
    const lift = h.between(35, 41);
    expect(lift.filter((r) => has(r, F.OVERRUN)).length).toBeGreaterThan(lift.length * 0.9);
    // braking: one-gear coast downshifts, clutch opens near the stop, standstill → gear 1
    const brake = h.between(42, LOOP_S);
    const downs = brake.filter((r) => r.shiftStart);
    for (const r of downs) expect(r.shiftUp).toBe(false);
    expect(downs.length).toBeGreaterThanOrEqual(4);
    expect(brake.some((r) => has(r, F.CLUTCH_OPEN) && !has(r, F.STANDSTILL))).toBe(true);
    for (const r of h.between(57, LOOP_S)) {
      expect(r.gear).toBe(1);
      expect(r.v).toBe(0);
      expect(Math.abs(r.rpm - 800)).toBeLessThanOrEqual(20);
    }
    // global invariants
    for (const r of recs) {
      expect(r.limiter).toBe(false);
      expect(Number.isFinite(r.rpm)).toBe(true);
      expect(has(r, F.SHIFTING)).toBe(r.shiftActive);
      if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(780 - 1e-9); // never stalls
    }
    expect(expectContinuous(recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });

  it('a shift start carries the engine rpm before and after the shift', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(25);
    let checked = 0;
    for (let i = 1; i < h.recs.length; i++) {
      const prev = h.recs[i - 1];
      const r = h.recs[i];
      if (prev === undefined || r === undefined || !r.shiftStart) continue;
      expect(r.fromRpm).toBe(prev.rpm);
      expect(r.toRpm).toBe(r.rpm);
      // upshifts are one gear here (the over-speed skip-shift needs ≥ redline, which this run never reaches);
      // downshifts one gear (map) or up to two (A4 kickdown: g ≥ gear − 2)
      expect(r.shiftUp ? r.gear === prev.gear + 1 : r.gear < prev.gear && r.gear >= prev.gear - 2).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('Manual box without paddles: the WOT pull hits the limiter, clamped exactly at limiter.rpm', () => {
    const h = new Harness(MANUAL6_SPEC, MANUAL6_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    const recs = h.run(16);
    const lim = recs.filter((r) => r.limiter);
    expect(lim.length).toBeGreaterThan(100);
    for (const r of recs) {
      expect(r.rpm).toBeLessThanOrEqual(7500);
      if (r.limiter) {
        expect(r.rpm).toBe(7500);
        expect(has(r, F.LIMITER)).toBe(true);
      } else {
        expect(has(r, F.LIMITER)).toBe(false);
      }
    }
    expect(h.recs[h.recs.length - 1]?.gear).toBe(1);
    // a paddle upshift takes it off the limiter (2nd at ≈ 104 km/h turns ≈ 7385 rpm, so WOT reaches
    // the limiter again ≈ 0.15 s later)
    h.input({ type: 'shiftUp' });
    const after = h.run(0.5);
    expect(after[0]?.gear).toBe(2);
    expect(after[0]?.shiftStart).toBe(true);
    expect(after[0]?.limiter).toBe(false);
    expect(after[0]?.rpm).toBeLessThan(7500);
    expect(after[0]?.toRpm).toBe(after[0]?.rpm);
    expect(after[0]?.fromRpm).toBe(7500);
    expectContinuous(h.recs);
  });

  it('TC8 automatic: converter stall at rest, slip on launch, lock-up (engaged) when cruising', () => {
    const h = new Harness(TC8_SPEC, TC8_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    expect(h.at(3).driveline).toBe('tc-stall');
    expect(h.between(3.5, 8).some((r) => r.driveline === 'slipping')).toBe(true);
    expect(h.at(30).driveline).toBe('engaged');
    expect(h.at(30).gear).toBeGreaterThanOrEqual(6);
    expect(expectContinuous(recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });
});
```

- [ ] **Step 3: Append part 3 (GPS replay, hidden hold, setTuning, RF5 source switching, inputs, catalogue sweep)**

Append to `tests/unit/sim-core.test.ts` (after one blank line):

```ts
describe('TesboxSimCore — GPS replay source', () => {
  it('highway-amd: upshifts to top gear for the 130 km/h cruise and tracks speed in gear', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(78);
    const c = rollingCircumferenceM(DCT7_SPEC.gearbox.drivenTyre);
    const cruise = h.between(30, 46);
    for (const r of cruise) {
      expect(r.gear).toBe(7);
      expect(Math.abs(r.v - 36.11)).toBeLessThan(1.5);
      // engaged: rpm = wheel rpm, except the one quantum after a fix arrival moves v by > 48 rpm's worth
      expect(Math.abs(r.rpm - wheelRpm(r.v, 2.7, c))).toBeLessThanOrEqual(50);
    }
    // lift-off 36 → 30 m/s stays in top gear (2442 rpm at 30 m/s ≫ the 1125 rpm coast-down point)
    for (const r of h.between(48, 60)) expect(r.gear).toBe(7);
    for (const r of recs) {
      expect(r.load).toBeGreaterThanOrEqual(-1);
      expect(r.load).toBeLessThanOrEqual(1);
      expect(r.limiter).toBe(false);
      expect(has(r, F.PREDICTING)).toBe(false);
    }
    expect(expectContinuous(h.recs)).toBeLessThanOrEqual(recs.filter((r) => r.shiftStart).length);
  });

  it('tunnel-dropout: no upshift while predicting, GPS_LOST eases to a stop, recovery at the exit stays continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('tunnel-dropout');
    h.input({ type: 'ignition', on: true });
    const recs = h.run(83);
    const predicting = recs.filter((r) => has(r, F.PREDICTING));
    expect(predicting.length).toBeGreaterThan(0);
    for (const r of predicting) expect(r.shiftStart && r.shiftUp).toBe(false);
    expect(recs.some((r) => has(r, F.GPS_LOST))).toBe(true);
    // fix arrivals stop at 20 s: lost from 40 s, eased to 0 by 50 s → standstill in gear 1 at idle
    const lost = h.at(52);
    expect(lost.v).toBe(0);
    expect(lost.gear).toBe(1);
    expect(has(lost, F.GPS_LOST) && has(lost, F.STANDSTILL)).toBe(true);
    // after the tunnel (arrivals resume at 55 s) the car is back at 25 m/s in a sensible gear
    const back = h.at(80);
    expect(back.v).toBeGreaterThan(23);
    expect(back.gear).toBeGreaterThanOrEqual(5);
    expect(back.limiter).toBe(false);
    // the exit fix finds the box in gear 1 (standstill) at 25 m/s: one over-speed upshift straight to the
    // map gear while the engine slews up from idle — never a 1st/2nd-gear over-rev
    expect(h.at(55.5).gear).toBeGreaterThanOrEqual(6);
    expect(Math.max(...h.between(55, 58).map((r) => r.rpm))).toBeLessThan(3000);
    expect(expectContinuous(recs)).toBeLessThanOrEqual(
      recs.filter((r) => r.shiftStart).length + recs.filter((r) => r.limiter).length + 1,
    );
  });

  it('the other replay fixtures (stale/duplicate fixes, Intel zero/null speed, stoplight jitter, city stop-go) stay finite, continuous and above idle', () => {
    for (const name of ['stale-duplicates', 'intel-zero-speed', 'intel-null-speed', 'stoplight-jitter', 'city-amd']) {
      const h = new Harness(TC8_SPEC, TC8_VOICING, 'replay').replay(name);
      h.input({ type: 'ignition', on: true });
      const recs = h.run(60);
      for (const r of recs) {
        expect(Number.isFinite(r.rpm) && Number.isFinite(r.load) && Number.isFinite(r.v)).toBe(true);
        if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(650 - 20 - 1e-9);
      }
      expectContinuous(recs);
    }
  });

  it('hidden hold: rpm eases to idle, load 0, clutch open, gear held; tracking resumes when visible', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(35);
    const before = h.recs[h.recs.length - 1];
    expect(before?.gear).toBe(7);
    h.input({ type: 'visibility', hidden: true });
    h.setFeeding(false); // geolocation stops while hidden
    const hidden = h.run(5);
    h.input({ type: 'shiftDown' }); // ignored while held
    for (const r of hidden) {
      expect(r.gear).toBe(7);
      expect(r.load).toBe(0);
      expect(r.driveline).toBe('clutch-open');
      expect(has(r, F.HIDDEN_HOLD) && has(r, F.CLUTCH_OPEN)).toBe(true);
      expect(r.shiftActive).toBe(false);
      expect(has(r, F.OVERRUN)).toBe(false);
    }
    expect(Math.abs((hidden[Math.round(0.3 / DT)]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.input({ type: 'visibility', hidden: false });
    h.setFeeding(true);
    const visible = h.run(5);
    expect((visible[0]?.flags ?? F.HIDDEN_HOLD) & F.HIDDEN_HOLD).toBe(0);
    expect(visible.filter((r) => r.shiftStart && !r.shiftUp).length).toBe(0); // the hidden shiftDown was dropped
    const end = visible[visible.length - 1];
    expect(end?.gear).toBe(7);
    expect(end?.driveline).toBe('engaged');
    expect(Math.abs((end?.rpm ?? 0) - (before?.rpm ?? 0))).toBeLessThan(200);
    expect(expectContinuous(h.between(34, h.t))).toBe(0);
  });

  it('setTuning() applies a new SimTuning mid-drive without a reset: gear held, rpm continuous', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    const control = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    for (const x of [h, control]) {
      x.input({ type: 'ignition', on: true });
      x.run(35);
    }
    h.core.setTuning({ ...DEFAULT_SIM_TUNING, outputLatencyS: 0.2 });
    const after = h.run(1);
    control.run(1);
    for (const r of after) expect(r.gear).toBe(7);
    expect(expectContinuous(h.between(34, h.t))).toBe(0);
    // the filter now predicts 0.1 s further ahead (identical runs otherwise)
    expect(h.core.out.speedMps).not.toBe(control.core.out.speedMps);
  });

  it('demo source: GPS-health bits still describe the real GPS; STANDSTILL follows the demo car; no hidden hold', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    const start = h.run(10);
    for (const r of start) expect(has(r, F.GPS_LOST)).toBe(true); // no fix ever arrived
    expect(has(h.at(2.8), F.STANDSTILL)).toBe(true);
    expect(has(h.at(9), F.STANDSTILL)).toBe(false); // the demo car is moving
    h.input({ type: 'visibility', hidden: true });
    const recs = h.run(4);
    for (const r of recs) expect(has(r, F.HIDDEN_HOLD)).toBe(false);
    expect(recs[recs.length - 1]?.driveline).toBe('engaged');
    expect(recs[recs.length - 1]?.rpm).toBeGreaterThan(1200);
  });
});

describe('TesboxSimCore — RF5: source switching mid-run', () => {
  it('demo → gps (no fixes) → demo: out.rpm never jumps more than 50 rpm/quantum outside shift starts and the limiter', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(17); // mid-WOT, high rpm
    const high = h.recs[h.recs.length - 1]?.rpm ?? 0;
    expect(high).toBeGreaterThan(3500);
    h.core.setSource('gps'); // filter has never had a fix → v = 0, standstill
    const toGps = h.run(3);
    expect(toGps[0]?.rpm).toBeGreaterThanOrEqual(high - 50);
    expect(toGps[toGps.length - 1]?.gear).toBe(1);
    expect(Math.abs((toGps[toGps.length - 1]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.core.setSource('demo'); // demo restarts from rest at its idle
    h.run(20);
    expect(expectContinuous(h.recs)).toBeLessThanOrEqual(h.recs.filter((r) => r.shiftStart).length);
  });

  it('gps (130 km/h replay) → demo → gps at speed: same rule, including the over-speed recovery', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'replay').replay('highway-amd');
    h.input({ type: 'ignition', on: true });
    h.run(30);
    expect(h.recs[h.recs.length - 1]?.gear).toBe(7);
    const cruiseRpm = h.recs[h.recs.length - 1]?.rpm ?? 0;
    h.core.setSource('demo'); // demo car at rest → rpm eases to idle
    const toDemo = h.run(6); // demo idle 0–3 s, pull-away from 3.5 s
    expect(toDemo[0]?.rpm).toBeGreaterThanOrEqual(cruiseRpm - 50);
    expect(Math.abs((toDemo[Math.round(2 / DT)]?.rpm ?? 0) - 800)).toBeLessThanOrEqual(20);
    h.core.setSource('replay'); // back to the real car at ~130 km/h while the demo was in a low gear
    const back = h.run(12);
    expect(back.some((r) => r.shiftStart && r.shiftUp)).toBe(true);
    expect(back[back.length - 1]?.gear).toBe(7);
    const all = h.between(29, h.t);
    expect(expectContinuous(all)).toBeLessThanOrEqual(
      all.filter((r) => r.shiftStart).length + all.filter((r) => r.limiter).length + 1,
    );
  });

  it('demo → keyboard keeps the car rolling; keyboard pedals drive PedalPhysics; brake to standstill', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'ignition', on: true });
    h.run(12);
    const v0 = h.recs[h.recs.length - 1]?.v ?? 0;
    expect(v0).toBeGreaterThan(10);
    h.core.setSource('keyboard');
    const coast = h.run(1);
    expect(coast[0]?.v).toBeGreaterThan(v0 - 0.5); // no reset to 0
    h.input({ type: 'pedal', throttle: 1, brake: 0 });
    const acc = h.run(2);
    expect(acc[acc.length - 1]?.v ?? 0).toBeGreaterThan((coast[coast.length - 1]?.v ?? 0) + 5);
    h.input({ type: 'pedal', throttle: 0, brake: 1 });
    h.run(6);
    const stop = h.recs[h.recs.length - 1];
    expect(stop?.v).toBe(0);
    expect((stop?.flags ?? 0) & F.STANDSTILL).toBe(F.STANDSTILL);
    expect(stop?.gear).toBe(1);
    expectContinuous(h.recs);
  });
});

describe('TesboxSimCore — inputs', () => {
  it('shiftUp/shiftDown reach the gearbox; gearboxMode and driveMode are applied; other messages are ignored', () => {
    const h = new Harness(DCT7_SPEC, DCT7_VOICING, 'demo');
    h.input({ type: 'gearboxMode', value: 'manual' });
    h.input({ type: 'ignition', on: true });
    h.run(5); // pulling away in 1st
    h.input({ type: 'shiftUp' });
    const up = h.run(0.2);
    expect(up[0]?.gear).toBe(2);
    expect(up[0]?.shiftStart && up[0]?.shiftUp).toBe(true);
    h.input({ type: 'shiftDown' });
    expect(h.run(0.2)[0]?.gear).toBe(1);
    h.input({ type: 'gearboxMode', value: 'auto' });
    h.input({ type: 'driveMode', value: 'sport' });
    for (const msg of [
      { type: 'valve', mode: 'open' },
      { type: 'perspective', value: 'outside' },
      { type: 'volume', trimDb: -6 },
      { type: 'bench', k: 4 },
    ] as const) {
      h.input(msg);
    }
    h.run(8);
    expect(h.recs[h.recs.length - 1]?.gear).toBeGreaterThan(1); // auto took over again
  });

  it('pushFix returns the filter verdict whatever the source; the fix counters are forwarded', () => {
    const core = new TesboxSimCore();
    core.configure(DCT7_SPEC, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING);
    core.setSource('demo');
    const fix: FixMsg = { type: 'fix', ageS: 1, speedMps: 10, lat: 0, lon: 0, accuracyM: 5, altitudeM: null };
    expect(core.pushFix(fix, 10)).toBe(true);
    expect(core.pushFix({ ...fix, ageS: 5 }, 11)).toBe(false); // stale (> 3 s)
    expect(core.pushFix({ ...fix, accuracyM: 0 }, 12)).toBe(false);
    expect(core.fixesAccepted).toBe(1);
    expect(core.fixesRejected).toBe(2);
  });

  it('configure() rejects an unparseable driven tyre', () => {
    const bad: EngineSpec = { ...DCT7_SPEC, gearbox: { ...DCT7_SPEC.gearbox, drivenTyre: 'not a tyre' } };
    expect(() => new TesboxSimCore().configure(bad, DCT7_VOICING, MID_TESLA, DEFAULT_SIM_TUNING)).toThrow(Error);
  });
});

describe.each(CATALOGUE)('TesboxSimCore — catalogue engine %s over one DEMO_PROFILE loop', (_id, def) => {
  it.each([['auto'], ['manual']] as const)('%s: finite, continuous, never below idle, clamped at limiter.rpm', (mode) => {
    const h = new Harness(def.spec, def.voicing, 'demo');
    h.input({ type: 'gearboxMode', value: mode });
    h.input({ type: 'ignition', on: true });
    const recs = h.run(LOOP_S);
    const lim = def.spec.rpm.limiter.rpm;
    for (const r of recs) {
      expect(Number.isFinite(r.rpm) && Number.isFinite(r.load)).toBe(true);
      expect(r.rpm).toBeLessThanOrEqual(lim);
      if (r.limiter) expect(r.rpm).toBe(lim);
      if (r.t > 2.6) expect(r.rpm).toBeGreaterThanOrEqual(def.spec.rpm.idle - 20 - 1e-9);
    }
    if (mode === 'auto') expect(recs.reduce((m, r) => Math.max(m, r.gear), 0)).toBeGreaterThanOrEqual(4);
    expectContinuous(recs);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
npx vitest run tests/unit/sim-core.test.ts
```

Expected: FAIL — `Error: Cannot find module '../../src/sim/sim-core' imported from …/tests/unit/sim-core.test.ts`; `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 5: Implement `src/sim/sim-core.ts`**

```ts
import { F } from '../contracts';
import type {
  DriveMode,
  Driveline,
  EngineSpec,
  EngineVoicing,
  FixMsg,
  GearboxMode,
  InputMsg,
  SimCore,
  SimOutput,
  SimTuning,
  SpeedSourceKind,
  TeslaParams,
} from '../contracts';
import { DemoDriver, PedalPhysics, type PedalCommand } from './demo';
import { DrivelineModel, RPM_SLEW_RPM_PER_S } from './driveline';
import { Gearbox } from './gearbox';
import { LoadEstimator } from './load';
import { SpeedFilter } from './speed-filter';
import { rollingCircumferenceM } from './tyre';

/** Crank sequence (seconds since ignition on): ramp to 250 rpm, flare to idle + 800, settle to idle. */
export const CRANK_RAMP_END_S = 0.6;
export const CRANK_RPM = 250;
export const CRANK_FLARE_END_S = 1.0;
export const CRANK_FLARE_RPM = 800;
export const CRANK_SETTLE_END_S = 2.5;
/** Ignition off: rpm decays to 0 over this long. */
export const STOP_DECAY_S = 1.0;
/** Demo/keyboard sources are at standstill below this speed. */
export const PEDAL_STANDSTILL_MPS = 0.3;
/** Seed of the deterministic idle wander. */
export const DRIVELINE_SEED = 1;
/** GPS health bits: they describe the real GPS whatever the source (status dot, Diagnostics, spec §10). */
const GPS_HEALTH = F.GPS_LOST | F.PREDICTING | F.SPEED_UNUSABLE;

type Phase = 'off' | 'cranking' | 'running' | 'stopping';

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

/**
 * SimCore (spec §8, phase-1 contract): speed source → load → gearbox → driveline → target rpm →
 * limiter clamp, plus the ignition (crank/stop) sequence and the hidden hold. Environment-free.
 * `step`, `pushFix` and `pushInput` never allocate; everything is allocated in the constructor and
 * `configure`.
 *
 * Continuity (RF5): out.rpm moves by at most RPM_SLEW_RPM_PER_S·dtS (48 rpm per quantum at 48 kHz)
 * per step, except (a) on the step a shift starts, and only in the shift's physical direction (an
 * upshift may drop out.rpm to the new gear, a downshift may raise it; the DSP follows out.shift —
 * against that direction the rpm slews) and (b) while the limiter clamps it to limiter.rpm. Source
 * switches, the hidden hold, crank hand-over and ignition off therefore never step the rpm.
 *
 * out.shift carries ENGINE rpm: fromRpm = out.rpm before the shift, toRpm = out.rpm after it (equal to
 * the gearbox's wheel-rpm values whenever the driveline is engaged and the rpm snaps).
 */
export class TesboxSimCore implements SimCore {
  readonly out: SimOutput = {
    rpm: 0,
    gear: 0,
    speedMps: 0,
    accelMps2: 0,
    load: 0,
    driveline: 'clutch-open',
    limiter: false,
    flags: 0,
    shift: { active: false, up: false, fromRpm: 0, toRpm: 0, t0: 0, durationS: 0 },
    ignitionOn: false,
    runTimeS: 0,
  };

  private readonly filter = new SpeedFilter();
  private readonly loadEst = new LoadEstimator();
  private readonly gearbox = new Gearbox();
  private readonly driveline = new DrivelineModel();
  private readonly demo = new DemoDriver();
  private readonly physics = new PedalPhysics();
  private readonly pedal: PedalCommand = { throttle: 0, brake: 0 };

  private configured = false;
  private source: SpeedSourceKind = 'gps';
  private gearboxMode: GearboxMode = 'auto';
  private driveMode: DriveMode = 'comfort';
  private limiterRpm = Infinity;
  private fuelCutResumeRpm = Infinity;
  private keyThrottle = 0;
  private keyBrake = 0;

  private phase: Phase = 'off';
  private tOnS = 0;
  private tOffS = 0;
  private offFromRpm = 0;
  /** False until the first step after construction (that step sets out.rpm without slew). */
  private primed = false;
  private lastShiftT0 = Number.NaN;

  /** Configure-time only (allocates; throws Error on an invalid tyre code, gearbox or tc data). */
  configure(engine: EngineSpec, voicing: EngineVoicing, tesla: TeslaParams, tuning: SimTuning): void {
    const circumferenceM = rollingCircumferenceM(engine.gearbox.drivenTyre);
    this.gearbox.configure(engine, circumferenceM, this.gearboxMode, this.driveMode);
    this.driveline.configure(engine, voicing, DRIVELINE_SEED);
    this.filter.configure(tuning);
    this.loadEst.configure(tesla);
    this.physics.configure(tesla);
    this.limiterRpm = engine.rpm.limiter.rpm;
    this.fuelCutResumeRpm = voicing.overrun.fuelCutResumeRpm;
    this.lastShiftT0 = Number.NaN;
    this.out.shift.active = false;
    this.configured = true;
  }

  /** Engine starts warm (no cold-idle elevation) — the `warm` config message (spec §5.3.5). */
  setWarm(warm: boolean): void {
    this.driveline.setWarm(warm);
  }

  /**
   * A new SimTuning mid-drive (the `tuning` config message): forwarded to the speed filter, which keeps
   * its state. configure() is no substitute — it resets the gearbox to gear 1 and re-primes the driveline.
   */
  setTuning(tuning: SimTuning): void {
    this.filter.configure(tuning);
  }

  /** Fix counters for StateSnapshot S.fixesAccepted / S.fixesRejected (spec §4.2 counters). */
  get fixesAccepted(): number {
    return this.filter.fixesAccepted;
  }

  get fixesRejected(): number {
    return this.filter.fixesRejected;
  }

  setSource(kind: SpeedSourceKind): void {
    const prev = this.source;
    if (kind === prev) return;
    if (kind === 'demo') {
      // the demo script always starts from rest at its t = 0 idle
      this.demo.reset();
      this.physics.reset();
    } else if (kind === 'keyboard') {
      if (prev !== 'demo') this.physics.reset(); // demo → keyboard keeps the car rolling
      this.keyThrottle = 0;
      this.keyBrake = 0;
    }
    this.source = kind;
  }

  /** Fixes always reach the speed filter (whatever the source), so switching back to GPS is seamless. */
  pushFix(fix: FixMsg, nowS: number): boolean {
    return this.filter.accept(fix, nowS);
  }

  pushInput(msg: InputMsg, nowS: number): void {
    switch (msg.type) {
      case 'shiftUp':
        if (this.shiftable()) this.gearbox.request(1);
        break;
      case 'shiftDown':
        if (this.shiftable()) this.gearbox.request(-1);
        break;
      case 'pedal':
        this.keyThrottle = clamp01(msg.throttle);
        this.keyBrake = clamp01(msg.brake);
        break;
      case 'gearboxMode':
        this.gearboxMode = msg.value;
        this.gearbox.setMode(msg.value);
        break;
      case 'driveMode':
        this.driveMode = msg.value;
        this.gearbox.setDriveMode(msg.value);
        break;
      case 'visibility':
        this.filter.setHidden(msg.hidden);
        break;
      case 'ignition':
        if (msg.on) this.ignitionOn(nowS);
        else this.ignitionOff(nowS);
        break;
      default:
        break; // valve, perspective, volume, bench: worklet/DSP concerns
    }
  }

  step(nowS: number, dtS: number): void {
    if (!this.configured) return;
    const o = this.out;

    // 1. speed source (the filter is evaluated every step so its GPS-health bits stay current)
    this.filter.evaluate(nowS);
    let v: number;
    let a: number;
    let srcFlags: number;
    if (this.source === 'demo' || this.source === 'keyboard') {
      if (this.source === 'demo') {
        this.demo.step(dtS, this.pedal);
        this.physics.step(this.pedal.throttle, this.pedal.brake, dtS);
      } else {
        this.physics.step(this.keyThrottle, this.keyBrake, dtS);
      }
      v = this.physics.v;
      a = this.physics.a;
      // STANDSTILL follows the simulated car; no hidden hold for demo/keyboard
      srcFlags = (this.filter.flags & GPS_HEALTH) | (v < PEDAL_STANDSTILL_MPS ? F.STANDSTILL : 0);
    } else {
      v = this.filter.v;
      a = this.filter.a;
      srcFlags = this.filter.flags;
    }
    const gpsSource = this.source === 'gps' || this.source === 'replay';
    const standstill = (srcFlags & F.STANDSTILL) !== 0;
    const predicting = gpsSource && (srcFlags & F.PREDICTING) !== 0;
    const hidden = (srcFlags & F.HIDDEN_HOLD) !== 0;

    // 2. load
    const load = this.loadEst.update(v, a, dtS);
    const loadRate = this.loadEst.loadRate;

    // 3. ignition phase → target rpm
    if (this.phase === 'cranking' && nowS - this.tOnS >= CRANK_SETTLE_END_S) this.phase = 'running';
    if (this.phase === 'stopping' && nowS - this.tOffS >= STOP_DECAY_S) this.phase = 'off';
    const phase = this.phase;
    const runTimeS = phase === 'off' ? 0 : Math.max(0, nowS - this.tOnS);
    let target = 0;
    let gear = 0;
    let driveline: Driveline = 'clutch-open';
    let gearboxFlags = 0;
    let shiftStarted = false;
    const held = phase === 'running' && hidden;

    if (phase === 'cranking') {
      this.driveline.step(nowS, dtS, 0, load, 0, standstill, runTimeS);
      target = this.crankRpm(runTimeS, this.driveline.rpm);
    } else if (phase === 'running') {
      if (held) {
        // hidden hold: gear held (gearbox not stepped), engine eases to idle in neutral
        this.driveline.step(nowS, dtS, 0, load, 0, standstill, runTimeS);
        gear = this.gearbox.gear;
      } else {
        this.gearbox.step(nowS, v, load, loadRate, predicting, standstill, this.driveline.state === 'clutch-open');
        gear = this.gearbox.gear;
        const rw = this.gearbox.rpmInGear(gear, v);
        this.driveline.step(nowS, dtS, rw, load, gear, standstill, runTimeS);
        driveline = this.driveline.state;
        gearboxFlags = this.gearbox.flags;
        const gs = this.gearbox.shift;
        shiftStarted = gs.active && gs.t0 === nowS && gs.t0 !== this.lastShiftT0;
      }
      target = this.driveline.rpm;
    } else if (phase === 'stopping') {
      const u = (nowS - this.tOffS) / STOP_DECAY_S;
      target = this.offFromRpm * 0.5 * (1 + Math.cos(Math.PI * (u > 0 ? u : 0)));
    }

    // 4. continuity + limiter clamp. A shift start snaps the rpm only in the shift's physical direction
    // (an upshift lowers it, a downshift raises it); against that direction — e.g. an upshift while the
    // engine is still below the new gear's rpm after a standstill or a source switch — the rpm slews.
    const prevRpm = o.rpm;
    let rpm = target;
    const snap = shiftStarted && (this.gearbox.shift.up ? target <= prevRpm : target >= prevRpm);
    if (this.primed && !snap) {
      const maxStep = dtS > 0 ? RPM_SLEW_RPM_PER_S * dtS : 0;
      const d = target - prevRpm;
      rpm = prevRpm + (d > maxStep ? maxStep : d < -maxStep ? -maxStep : d);
    }
    let limiter = false;
    if (phase === 'running' && target >= this.limiterRpm) {
      rpm = this.limiterRpm;
      limiter = true;
    }
    this.primed = true;

    // 5. shift trajectory (engine rpm)
    const sh = o.shift;
    if (shiftStarted) {
      const gs = this.gearbox.shift;
      sh.active = true;
      sh.up = gs.up;
      sh.fromRpm = prevRpm;
      sh.toRpm = rpm;
      sh.t0 = gs.t0;
      sh.durationS = gs.durationS;
      this.lastShiftT0 = gs.t0;
    } else if (sh.active && (phase !== 'running' || held || nowS >= sh.t0 + sh.durationS)) {
      sh.active = false;
    }

    // 6. outputs
    const outLoad = held ? 0 : load;
    o.rpm = rpm;
    o.gear = gear;
    o.speedMps = v;
    o.accelMps2 = a;
    o.load = outLoad;
    o.driveline = driveline;
    o.limiter = limiter;
    o.ignitionOn = phase === 'cranking' || phase === 'running';
    o.runTimeS = runTimeS;
    let flags = srcFlags | gearboxFlags;
    if (limiter) flags |= F.LIMITER;
    if (sh.active) flags |= F.SHIFTING;
    else flags &= ~F.SHIFTING;
    if (driveline === 'clutch-open') flags |= F.CLUTCH_OPEN;
    if (outLoad < -0.05 && rpm > this.fuelCutResumeRpm && driveline === 'engaged') flags |= F.OVERRUN;
    o.flags = flags;
  }

  /** Shift requests count only while the engine runs in gear and is not in the hidden hold. */
  private shiftable(): boolean {
    if (this.phase !== 'running') return false;
    const gps = this.source === 'gps' || this.source === 'replay';
    return !(gps && (this.filter.flags & F.HIDDEN_HOLD) !== 0);
  }

  private ignitionOn(nowS: number): void {
    if (this.phase === 'cranking' || this.phase === 'running') return;
    this.phase = 'cranking';
    this.tOnS = nowS;
    this.gearbox.reset();
    this.driveline.reset();
  }

  private ignitionOff(nowS: number): void {
    if (this.phase === 'off' || this.phase === 'stopping') return;
    this.phase = 'stopping';
    this.tOffS = nowS;
    this.offFromRpm = this.out.rpm;
    this.gearbox.reset();
  }

  /** 0–0.6 s ramp to 250 rpm, 0.6–1.0 s flare to idle + 800, 1.0–2.5 s smoothstep settle to idle. */
  private crankRpm(t: number, idle: number): number {
    if (t < CRANK_RAMP_END_S) return (CRANK_RPM * t) / CRANK_RAMP_END_S;
    if (t < CRANK_FLARE_END_S) {
      const u = (t - CRANK_RAMP_END_S) / (CRANK_FLARE_END_S - CRANK_RAMP_END_S);
      return CRANK_RPM + (idle + CRANK_FLARE_RPM - CRANK_RPM) * Math.sin(0.5 * Math.PI * u);
    }
    const u = (t - CRANK_FLARE_END_S) / (CRANK_SETTLE_END_S - CRANK_FLARE_END_S);
    const s = u < 1 ? u * u * (3 - 2 * u) : 1;
    return idle + CRANK_FLARE_RPM * (1 - s);
  }
}
```

- [ ] **Step 6: Run it to see it pass**

```bash
npx vitest run tests/unit/sim-core.test.ts
```

Expected: PASS — `Tests  52 passed (52)` with all 15 engine JSONs (22 without any: the catalogue sweep adds 2 tests per engine JSON present; this task runs after Task 10, so all 15 exist), ≈ 5 s plus ≈ 1 s per engine JSON (≈ 20 s with all 15). A failure in a `catalogue engine <id>` row is that engine's data problem (Task 10): report it to the Task 10 owner, never loosen the assertions. If a GPS-replay expectation fails, first re-run `npx vitest run tests/unit/make-synthetic-replay.test.ts` to confirm the fixtures match Task 3's generator (the numbers above assume them), then debug SimCore — do not loosen the 50 rpm continuity bound.

- [ ] **Step 7: Run the whole drivetrain suite together**

```bash
npx vitest run tests/unit/shift-map.test.ts tests/unit/gearbox.test.ts tests/unit/driveline.test.ts tests/unit/demo.test.ts tests/unit/sim-core.test.ts
```

Expected: PASS — `Test Files  5 passed (5)`, `Tests  168 passed (168)` with all 15 engine JSONs (108 = shift-map 20 + gearbox 32 + driveline 18 + demo 16 + sim-core 22, plus 4 per engine JSON present: 2 shift-map invariants + 2 SimCore loops).

- [ ] **Step 8: Lint and typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0 with no diagnostics. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 9: JSON Schemas, schema tests, `defaultVoicing`, engine index + example engine `i5-turbo-25`

**Files:**
- Create: `src/data/schema/engine.schema.json`
- Create: `src/data/schema/tesla.schema.json`
- Create: `src/data/schema/roadload.schema.json`
- Create: `src/data/voicing-defaults.ts`
- Create: `src/data/engines/i5-turbo-25.json`
- Create: `src/data/engines/index.ts`
- Modify: `package.json`, `package-lock.json` (devDependency `ajv ^8.20.0`, via `npm install` only)
- Test: `tests/unit/schemas.test.ts`
- Test: `tests/unit/voicing-defaults.test.ts`
- Test: `tests/unit/engines.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `EngineDef`, `EngineSpec`, `EngineVoicing`, `CombustionEntry`, `TeslaRecord`, `RoadLoadRecord`, `MAX_COMBUSTION`.
  - `src/sim/tyre.ts` (Task 1): `parseTyre(code: string): Tyre`, `rollingCircumferenceM(code: string): number`, `wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number`.
  - `ajv` 8.20: `import Ajv2020 from 'ajv/dist/2020'` (draft 2020-12). Convention for every data test and tool in Phase 1: `new Ajv2020({ allErrors: true, strict: true })`, one `compile` per schema per ajv instance.
- Produces:
  - `src/data/voicing-defaults.ts`: `export function defaultVoicing(spec: EngineSpec): EngineVoicing` — deterministic, returns fresh objects on every call, `estimated: true`.
  - `src/data/engines/index.ts`: `export const ENGINES: EngineDef[]` (spec §5.5 order; this task ships only `i5-turbo-25`, Task 10 completes the 15) and `export function getEngine(id: string): EngineDef` (throws `Error('Unknown engine id "<id>"')`).
  - `src/data/schema/engine.schema.json` (`$id: "engine.schema.json"`): validates ONE `EngineDef`.
  - `src/data/schema/tesla.schema.json` (`$id: "tesla.schema.json"`): validates the WHOLE `teslas.json` array (`TeslaRecord[]`, `minItems: 1`).
  - `src/data/schema/roadload.schema.json` (`$id: "roadload.schema.json"`): validates the WHOLE generated `roadload.json` array (`RoadLoadRecord[]`, `minItems: 1`; `source` must start with `EPA <yyyy> Test Car List: ` or `derived: CdA=`).
  - `tests/unit/engines.test.ts` structure that Task 10 replaces/extends: `EPA_NV` table `{ id; nv; gear; doc }[]`, `expectedCombustionCount(id)`, per-engine `describe.each` named `engine <id>`.

**Cross-task premises:**
- Task 1 `src/sim/tyre.ts` exists with the contract signatures. Open it and confirm `parseTyre` accepts `"265/30ZR19"` (no space before `ZR`), `"255/45R18"` and `"225/50ZR16"`, and that `rollingCircumferenceM` is exactly π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97 (the EPA N/V check depends on it).
- Phase 0 `tsconfig.json` (TypeScript ~6.0, `moduleResolution: "Bundler"`, `strict`, `noUncheckedIndexedAccess`) resolves typed `*.json` imports without an explicit `resolveJsonModule` (verified with typescript 6.0.3). If `npm run typecheck` reports `Cannot find module './i5-turbo-25.json'` or suggests `--resolveJsonModule`, add `"resolveJsonModule": true` to `compilerOptions` and change nothing else.
- Phase 0 `vite.config.ts` has Vitest `include: ['tests/unit/**/*.test.ts']`, `environment: 'node'`.
- No other Phase 1 task runs `npm install`. Step 1 rewrites `node_modules` (ESLint depends on ajv too, and hoisting can move it), so it runs before the other tasks of this wave (Tasks 3, 4, 5) start — plan header, Execution order.
- Engine `spec` data rule (contract): every field group sourced from primary/public documents; nothing from rupteur.app or repos referencing it; idle rpm and limiter type/hysteresis are not published by Audi and are marked as estimates in `notes`.

- [ ] **Step 1: Install ajv (dev dependency for tests/tools only)**

```bash
npm install --save-dev ajv@^8.20.0
node -e "console.log(require('ajv/package.json').version)"
```

Expected: the second command prints `8.20.0` (or a later 8.x); `package.json` `devDependencies` contains `"ajv": "^8.20.0"`.

- [ ] **Step 2: Write the failing schema test**

Create `tests/unit/schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { EngineDef, RoadLoadRecord, TeslaRecord } from '../../src/contracts';
import engineSchema from '../../src/data/schema/engine.schema.json';
import roadloadSchema from '../../src/data/schema/roadload.schema.json';
import teslaSchema from '../../src/data/schema/tesla.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);
const validateTeslas = ajv.compile(teslaSchema);
const validateRoadload = ajv.compile(roadloadSchema);

/** Deep clone + mutate helper so each negative case starts from a valid document. */
function mutate<T>(base: T, fn: (draft: T) => void): T {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
}

const ENGINE: EngineDef = {
  id: 'fixture-v8',
  name: 'Fixture V8',
  inspiredBy: 'Fixture',
  set: 'american',
  notes: 'fixture',
  spec: {
    layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 5 },
    cycleDeg: 720,
    combustion: [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })),
    rpm: { idle: 700, redline: 7500, limiter: { type: 'fuel-soft', rpm: 7500, hysteresisRpm: 150 } },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: { type: 'manual', overallRatios: [11.5, 7.5, 5.0, 3.55, 2.9, 2.2], drivenTyre: '255/45R18', shiftTimeS: 0.3, tc: null },
    sources: { layout: ['a'], combustion: ['b'], rpm: ['c'], aspiration: ['d'], gearbox: ['e'] },
  },
  voicing: {
    pulse: { widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 },
    headersM: [0.55, 0.55, 0.6, 0.6, 0.65, 0.65, 0.7, 0.7],
    collectors: [
      { banks: [0], lengthM: 0.35 },
      { banks: [1], lengthM: 0.35 },
    ],
    turbine: null,
    exhaust: { midPipeM: 1.4, mufflerSectionsM: [0.21, 0.34, 0.47], mufflerAction: 0.6, tailpipeM: 0.5, valve: { fitted: true, openGainDb: 4 } },
    intake: { runnerM: 0.3, helmholtzHz: 160, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: 1200 },
    cabin: { lowpassHz: 600 },
    launchRpm: 4125,
    estimated: true,
  },
};

const TESLA: TeslaRecord = {
  id: 'fixture-tesla',
  model: 'Model 3',
  generation: 'Fixture',
  years: [2024, 2026],
  trim: 'Fixture',
  markets: ['US', 'EU'],
  massKg: 1828,
  massBasis: 'us-curb',
  peakPowerKw: 296,
  accel: { seconds: 4.2, basis: '0-60mph', rolloutSubtracted: false },
  accelModes: [
    { name: 'Chill', factor: 0.5 },
    { name: 'Standard', factor: 1 },
  ],
  roadLoadRef: 'fixture-ref',
  subwooferDefault: true,
  mcu: ['amd'],
  supported: true,
  sources: { mass: ['m'], power: ['p'], accel: ['a'], audio: ['s'] },
};

const ROAD: RoadLoadRecord = {
  ref: 'fixture-ref',
  A_N: 137.81,
  B_Nps_m: 1.5881,
  C_Ns2_m2: 0.31384,
  source: 'EPA 2026 Test Car List: Tesla Model 3 Long Range AWD-E',
};

describe('engine.schema.json', () => {
  it('accepts a complete EngineDef', () => {
    expect(validateEngine(ENGINE)).toBe(true);
  });

  it.each<[string, (e: EngineDef) => void]>([
    ['an extra top-level property', (e) => Object.assign(e, { extra: 1 })],
    ['a missing voicing', (e) => Reflect.deleteProperty(e, 'voicing')],
    ['idle below 500', (e) => (e.spec.rpm.idle = 400)],
    ['redline above 10000', (e) => (e.spec.rpm.redline = 10500)],
    ['hysteresis above 600', (e) => (e.spec.rpm.limiter.hysteresisRpm = 700)],
    ['a single combustion entry', (e) => (e.spec.combustion = [{ angleDeg: 0, bank: 0 }])],
    ['17 combustion entries', (e) => (e.spec.combustion = Array.from({ length: 17 }, (_, i) => ({ angleDeg: i * 40, bank: 0 })))],
    ['3 gears', (e) => (e.spec.gearbox.overallRatios = [10, 6, 4])],
    ['shiftTimeS above 0.6', (e) => (e.spec.gearbox.shiftTimeS = 0.7)],
    ['a torque converter on a manual', (e) => (e.spec.gearbox.tc = { stallRpmWot: 2500, lockupTurbineRpm: 1500, couplingSR: 0.9 })],
    ['tc-auto without a torque converter', (e) => (e.spec.gearbox.type = 'tc-auto')],
    ['couplingSR outside 0.80–0.95', (e) => {
      e.spec.gearbox.type = 'tc-auto';
      e.spec.gearbox.tc = { stallRpmWot: 2500, lockupTurbineRpm: 1500, couplingSR: 0.97 };
    }],
    ['turbo aspiration without a turbo block', (e) => (e.spec.aspiration.type = 'turbo')],
    ['an empty source group', (e) => (e.spec.sources.rpm = [])],
    ['an unparseable tyre code', (e) => (e.spec.gearbox.drivenTyre = '255-45-18')],
    ['an unknown engine set', (e) => Object.assign(e, { set: 'british' })],
    ['cabinGainDb above -10', (e) => {
      e.spec.aspiration = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
      e.voicing.forcedInduction = { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -5 };
    }],
  ])('rejects %s', (_label, fn) => {
    expect(validateEngine(mutate(ENGINE, fn))).toBe(false);
  });

  it('accepts a supercharged tc-auto engine with valid blocks', () => {
    const sc = mutate(ENGINE, (e) => {
      e.spec.aspiration = { type: 'supercharger', turbo: null, supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 } };
      e.spec.gearbox.type = 'tc-auto';
      e.spec.gearbox.tc = { stallRpmWot: 2800, lockupTurbineRpm: 1400, couplingSR: 0.9 };
      e.voicing.forcedInduction = { spoolTimeS: 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 };
    });
    expect(validateEngine(sc)).toBe(true);
  });
});

describe('tesla.schema.json (array of TeslaRecord)', () => {
  it('accepts a valid catalogue array', () => {
    expect(validateTeslas([TESLA])).toBe(true);
  });

  it.each<[string, (r: TeslaRecord) => void]>([
    ['an extra property', (r) => Object.assign(r, { notes: 'x' })],
    ['massKg below 1000', (r) => (r.massKg = 900)],
    ['peakPowerKw above 1200', (r) => (r.peakPowerKw = 1300)],
    ['accel seconds below 1.5', (r) => (r.accel.seconds = 1.2)],
    ['a 3-element years tuple', (r) => Object.assign(r, { years: [2020, 2021, 2022] })],
    ['an unknown market', (r) => Object.assign(r, { markets: ['UK'] })],
    ['an unknown model', (r) => Object.assign(r, { model: 'Roadster' })],
    ['a mode factor below 0.2', (r) => (r.accelModes = [{ name: 'Chill', factor: 0.1 }])],
    ['no acceleration modes', (r) => (r.accelModes = [])],
    ['an unknown MCU', (r) => Object.assign(r, { mcu: ['arm'] })],
    ['a missing audio source', (r) => Reflect.deleteProperty(r.sources, 'audio')],
  ])('rejects %s', (_label, fn) => {
    expect(validateTeslas([mutate(TESLA, fn)])).toBe(false);
  });

  it('rejects an empty catalogue and a bare record', () => {
    expect(validateTeslas([])).toBe(false);
    expect(validateTeslas(TESLA)).toBe(false);
  });
});

describe('roadload.schema.json (array of RoadLoadRecord)', () => {
  it('accepts EPA and derived records, including a negative B', () => {
    const derived: RoadLoadRecord = { ref: 'd', A_N: 170, B_Nps_m: 0, C_Ns2_m2: 0.36, source: 'derived: CdA=0.6 m², Crr=0.009' };
    expect(validateRoadload([ROAD, derived, { ...ROAD, ref: 'neg', B_Nps_m: -1.53 }])).toBe(true);
  });

  it.each<[string, Partial<RoadLoadRecord> & Record<string, unknown>]>([
    ['C below 0.1', { C_Ns2_m2: 0.05 }],
    ['A above 500', { A_N: 600 }],
    ['a source without the EPA/derived prefix', { source: 'some website' }],
    ['an extra property', { extra: true }],
  ])('rejects %s', (_label, patch) => {
    expect(validateRoadload([{ ...ROAD, ...patch }])).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/schemas.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/data/schema/engine.schema.json"` (the schemas do not exist yet).

- [ ] **Step 4: Create the engine schema**

Create `src/data/schema/engine.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "engine.schema.json",
  "title": "Tesbox EngineDef",
  "description": "Mirrors EngineDef in src/contracts.ts. Cross-field rules (limiter.rpm >= redline, strictly descending ratios, angles < cycleDeg, headersM length, turbine iff turbo) are checked in tests/unit/engines.test.ts.",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "name", "inspiredBy", "set", "notes", "spec", "voicing"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "name": { "type": "string", "minLength": 1 },
    "inspiredBy": { "type": "string", "minLength": 1 },
    "set": { "enum": ["euro", "jdm", "american", "exotic"] },
    "notes": { "type": "string", "minLength": 1 },
    "spec": { "$ref": "#/$defs/spec" },
    "voicing": { "$ref": "#/$defs/voicing" }
  },
  "$defs": {
    "sourceList": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    },
    "spec": {
      "type": "object",
      "additionalProperties": false,
      "required": ["layout", "cycleDeg", "combustion", "rpm", "aspiration", "gearbox", "sources"],
      "properties": {
        "layout": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "bankAngleDeg", "crank", "displacementL"],
          "properties": {
            "type": { "enum": ["inline", "v", "flat", "rotary"] },
            "bankAngleDeg": { "type": "number", "minimum": 0, "maximum": 180 },
            "crank": { "enum": ["cross-plane", "flat-plane", "n/a"] },
            "displacementL": { "type": "number", "exclusiveMinimum": 0, "maximum": 10 }
          }
        },
        "cycleDeg": { "enum": [720, 1080] },
        "combustion": {
          "type": "array",
          "minItems": 2,
          "maxItems": 16,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["angleDeg", "bank"],
            "properties": {
              "angleDeg": { "type": "number", "minimum": 0, "exclusiveMaximum": 1080 },
              "bank": { "type": "integer", "minimum": 0, "maximum": 3 }
            }
          }
        },
        "rpm": {
          "type": "object",
          "additionalProperties": false,
          "required": ["idle", "redline", "limiter"],
          "properties": {
            "idle": { "type": "number", "minimum": 500, "maximum": 1200 },
            "redline": { "type": "number", "minimum": 4000, "maximum": 10000 },
            "limiter": {
              "type": "object",
              "additionalProperties": false,
              "required": ["type", "rpm", "hysteresisRpm"],
              "properties": {
                "type": { "enum": ["ignition-hard", "ignition-soft", "fuel-hard", "fuel-soft"] },
                "rpm": { "type": "number", "minimum": 4000, "maximum": 10500 },
                "hysteresisRpm": { "type": "number", "minimum": 50, "maximum": 600 }
              }
            }
          }
        },
        "aspiration": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "turbo", "supercharger"],
          "properties": {
            "type": { "enum": ["na", "turbo", "supercharger"] },
            "turbo": {
              "anyOf": [
                { "type": "null" },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["count", "layout"],
                  "properties": {
                    "count": { "type": "integer", "minimum": 1, "maximum": 4 },
                    "layout": { "enum": ["single", "parallel", "sequential"] }
                  }
                }
              ]
            },
            "supercharger": {
              "anyOf": [
                { "type": "null" },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["kind", "pulleyRatio", "gearRatio", "lobes"],
                  "properties": {
                    "kind": { "enum": ["roots", "twin-screw"] },
                    "pulleyRatio": { "type": "number", "exclusiveMinimum": 0, "maximum": 5 },
                    "gearRatio": { "type": "number", "exclusiveMinimum": 0, "maximum": 5 },
                    "lobes": { "type": "integer", "minimum": 2, "maximum": 8 }
                  }
                }
              ]
            }
          },
          "allOf": [
            {
              "if": { "properties": { "type": { "const": "turbo" } } },
              "then": { "properties": { "turbo": { "type": "object" }, "supercharger": { "type": "null" } } }
            },
            {
              "if": { "properties": { "type": { "const": "supercharger" } } },
              "then": { "properties": { "turbo": { "type": "null" }, "supercharger": { "type": "object" } } }
            },
            {
              "if": { "properties": { "type": { "const": "na" } } },
              "then": { "properties": { "turbo": { "type": "null" }, "supercharger": { "type": "null" } } }
            }
          ]
        },
        "gearbox": {
          "type": "object",
          "additionalProperties": false,
          "required": ["type", "overallRatios", "drivenTyre", "shiftTimeS", "tc"],
          "properties": {
            "type": { "enum": ["dct", "pdk", "tc-auto", "manual", "amt"] },
            "overallRatios": {
              "type": "array",
              "minItems": 4,
              "maxItems": 10,
              "items": { "type": "number", "exclusiveMinimum": 0, "maximum": 40 }
            },
            "drivenTyre": { "type": "string", "pattern": "^P?[0-9]{3}/[0-9]{2} ?Z?R[0-9]{2}$" },
            "shiftTimeS": { "type": "number", "minimum": 0.05, "maximum": 0.6 },
            "tc": {
              "anyOf": [
                { "type": "null" },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["stallRpmWot", "lockupTurbineRpm", "couplingSR"],
                  "properties": {
                    "stallRpmWot": { "type": "number", "minimum": 1000, "maximum": 6000 },
                    "lockupTurbineRpm": { "type": "number", "minimum": 500, "maximum": 4000 },
                    "couplingSR": { "type": "number", "minimum": 0.8, "maximum": 0.95 }
                  }
                }
              ]
            }
          },
          "if": { "properties": { "type": { "const": "tc-auto" } } },
          "then": { "properties": { "tc": { "type": "object" } } },
          "else": { "properties": { "tc": { "type": "null" } } }
        },
        "sources": {
          "type": "object",
          "additionalProperties": false,
          "required": ["layout", "combustion", "rpm", "aspiration", "gearbox"],
          "properties": {
            "layout": { "$ref": "#/$defs/sourceList" },
            "combustion": { "$ref": "#/$defs/sourceList" },
            "rpm": { "$ref": "#/$defs/sourceList" },
            "aspiration": { "$ref": "#/$defs/sourceList" },
            "gearbox": { "$ref": "#/$defs/sourceList" }
          }
        }
      }
    },
    "voicing": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "pulse", "headersM", "collectors", "turbine", "exhaust", "intake",
        "forcedInduction", "mechanical", "overrun", "cabin", "launchRpm", "estimated"
      ],
      "properties": {
        "pulse": {
          "type": "object",
          "additionalProperties": false,
          "required": ["widthDeg", "alpha", "beta", "evoOffsetDeg", "cycleAsymmetry"],
          "properties": {
            "widthDeg": { "type": "number", "minimum": 40, "maximum": 300 },
            "alpha": { "type": "number", "exclusiveMinimum": 0 },
            "beta": { "type": "number", "exclusiveMinimum": 0 },
            "evoOffsetDeg": { "type": "number", "minimum": 0, "maximum": 360 },
            "cycleAsymmetry": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "headersM": {
          "type": "array",
          "minItems": 2,
          "maxItems": 16,
          "items": { "type": "number", "minimum": 0.1, "maximum": 3 }
        },
        "collectors": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["banks", "lengthM"],
            "properties": {
              "banks": {
                "type": "array",
                "minItems": 1,
                "items": { "type": "integer", "minimum": 0, "maximum": 3 }
              },
              "lengthM": { "type": "number", "minimum": 0.05, "maximum": 2 }
            }
          }
        },
        "turbine": {
          "anyOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["reflection", "lpHz"],
              "properties": {
                "reflection": { "type": "number", "minimum": 0, "maximum": 0.95 },
                "lpHz": { "type": "number", "minimum": 200, "maximum": 8000 }
              }
            }
          ]
        },
        "exhaust": {
          "type": "object",
          "additionalProperties": false,
          "required": ["midPipeM", "mufflerSectionsM", "mufflerAction", "tailpipeM", "valve"],
          "properties": {
            "midPipeM": { "type": "number", "minimum": 0.1, "maximum": 5 },
            "mufflerSectionsM": {
              "type": "array",
              "minItems": 1,
              "maxItems": 4,
              "items": { "type": "number", "minimum": 0.05, "maximum": 2 }
            },
            "mufflerAction": { "type": "number", "minimum": 0, "maximum": 1 },
            "tailpipeM": { "type": "number", "minimum": 0.05, "maximum": 3 },
            "valve": {
              "type": "object",
              "additionalProperties": false,
              "required": ["fitted", "openGainDb"],
              "properties": {
                "fitted": { "type": "boolean" },
                "openGainDb": { "type": "number", "minimum": 0, "maximum": 12 }
              }
            }
          }
        },
        "intake": {
          "type": "object",
          "additionalProperties": false,
          "required": ["runnerM", "helmholtzHz", "gain"],
          "properties": {
            "runnerM": { "type": "number", "minimum": 0.05, "maximum": 1 },
            "helmholtzHz": { "type": "number", "minimum": 20, "maximum": 1000 },
            "gain": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "forcedInduction": {
          "anyOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["spoolTimeS", "maxShaftKrpm", "lift", "cabinGainDb"],
              "properties": {
                "spoolTimeS": { "type": "number", "minimum": 0, "maximum": 5 },
                "maxShaftKrpm": { "type": "number", "minimum": 10, "maximum": 400 },
                "lift": { "enum": ["bov", "flutter"] },
                "cabinGainDb": { "type": "number", "minimum": -20, "maximum": -10 }
              }
            }
          ]
        },
        "mechanical": {
          "type": "object",
          "additionalProperties": false,
          "required": ["blockGain", "valvetrainGain"],
          "properties": {
            "blockGain": { "type": "number", "minimum": 0, "maximum": 1 },
            "valvetrainGain": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "overrun": {
          "type": "object",
          "additionalProperties": false,
          "required": ["crackleRate", "fuelCutResumeRpm"],
          "properties": {
            "crackleRate": { "type": "number", "minimum": 0, "maximum": 10 },
            "fuelCutResumeRpm": { "type": "number", "minimum": 500, "maximum": 6000 }
          }
        },
        "cabin": {
          "type": "object",
          "additionalProperties": false,
          "required": ["lowpassHz"],
          "properties": {
            "lowpassHz": { "type": "number", "minimum": 200, "maximum": 2000 }
          }
        },
        "launchRpm": { "type": "number", "minimum": 1000, "maximum": 10000 },
        "estimated": { "type": "boolean" }
      }
    }
  }
}
```

- [ ] **Step 5: Create the Tesla catalogue schema**

Create `src/data/schema/tesla.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tesla.schema.json",
  "title": "Tesbox Tesla catalogue (teslas.json)",
  "description": "Array of TeslaRecord (src/contracts.ts). Cross-field rules (unique ids, last accelMode factor 1, roadLoadRef resolves, supported/MCU1) are checked in tests/unit/catalogue.test.ts.",
  "type": "array",
  "minItems": 1,
  "items": { "$ref": "#/$defs/record" },
  "$defs": {
    "sourceList": {
      "type": "array",
      "minItems": 1,
      "items": { "type": "string", "minLength": 1 }
    },
    "record": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id", "model", "generation", "years", "trim", "markets", "massKg", "massBasis", "peakPowerKw",
        "accel", "accelModes", "roadLoadRef", "subwooferDefault", "mcu", "supported", "sources"
      ],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
        "model": { "enum": ["Model S", "Model X", "Model 3", "Model Y", "Model Y L", "Cybertruck"] },
        "generation": { "type": "string", "minLength": 1 },
        "years": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "prefixItems": [
            { "type": "integer", "minimum": 2012, "maximum": 2030 },
            { "type": "integer", "minimum": 2012, "maximum": 2030 }
          ],
          "items": false
        },
        "trim": { "type": "string", "minLength": 1 },
        "markets": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["US", "EU", "CN", "other"] }
        },
        "massKg": { "type": "number", "minimum": 1000, "maximum": 4500 },
        "massBasis": { "enum": ["us-curb", "eu-unladen-incl-driver", "test-weight"] },
        "peakPowerKw": { "type": "number", "minimum": 50, "maximum": 1200 },
        "accel": {
          "type": "object",
          "additionalProperties": false,
          "required": ["seconds", "basis", "rolloutSubtracted"],
          "properties": {
            "seconds": { "type": "number", "minimum": 1.5, "maximum": 20 },
            "basis": { "enum": ["0-60mph", "0-100kmh"] },
            "rolloutSubtracted": { "type": "boolean" }
          }
        },
        "accelModes": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "factor"],
            "properties": {
              "name": { "type": "string", "minLength": 1 },
              "factor": { "type": "number", "minimum": 0.2, "maximum": 1 }
            }
          }
        },
        "roadLoadRef": { "type": "string", "minLength": 1 },
        "subwooferDefault": { "type": "boolean" },
        "mcu": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["intel", "amd", "tegra"] }
        },
        "supported": { "type": "boolean" },
        "sources": {
          "type": "object",
          "additionalProperties": false,
          "required": ["mass", "power", "accel", "audio"],
          "properties": {
            "mass": { "$ref": "#/$defs/sourceList" },
            "power": { "$ref": "#/$defs/sourceList" },
            "accel": { "$ref": "#/$defs/sourceList" },
            "audio": { "$ref": "#/$defs/sourceList" }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 6: Create the road-load schema**

Create `src/data/schema/roadload.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "roadload.schema.json",
  "title": "Tesbox road-load table (roadload.json, generated)",
  "description": "Array of RoadLoadRecord (src/contracts.ts), SI units, written by tools/build-catalogue.ts. Unique refs are checked in tests.",
  "type": "array",
  "minItems": 1,
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["ref", "A_N", "B_Nps_m", "C_Ns2_m2", "source"],
    "properties": {
      "ref": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
      "A_N": { "type": "number", "minimum": 0, "maximum": 500 },
      "B_Nps_m": { "type": "number", "minimum": -20, "maximum": 20 },
      "C_Ns2_m2": { "type": "number", "minimum": 0.1, "maximum": 1.5 },
      "source": { "type": "string", "pattern": "^(EPA [0-9]{4} Test Car List: |derived: CdA=)" }
    }
  }
}
```

- [ ] **Step 7: Run the schema test to verify it passes**

Run: `npx vitest run tests/unit/schemas.test.ts`
Expected: PASS — 37 tests. If ajv throws `strict mode: …` while compiling, the schema has an unknown/ill-typed keyword: fix the schema text, never relax `strict: true`.

- [ ] **Step 8: Write the failing `defaultVoicing` test**

Create `tests/unit/voicing-defaults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { CombustionEntry, EngineDef, EngineSpec } from '../../src/contracts';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import engineSchema from '../../src/data/schema/engine.schema.json';

const SRC = { layout: ['s'], combustion: ['s'], rpm: ['s'], aspiration: ['s'], gearbox: ['s'] };

function makeSpec(
  layoutType: EngineSpec['layout']['type'],
  combustion: CombustionEntry[],
  aspiration: EngineSpec['aspiration'],
  idle = 800,
  redline = 7000,
): EngineSpec {
  return {
    layout: {
      type: layoutType,
      bankAngleDeg: layoutType === 'v' ? 90 : layoutType === 'flat' ? 180 : 0,
      crank: 'n/a',
      displacementL: 2,
    },
    cycleDeg: layoutType === 'rotary' ? 1080 : 720,
    combustion,
    rpm: { idle, redline, limiter: { type: 'ignition-soft', rpm: redline + 100, hysteresisRpm: 150 } },
    aspiration,
    gearbox: { type: 'dct', overallRatios: [14, 9, 6, 4.5], drivenTyre: '245/40R18', shiftTimeS: 0.1, tc: null },
    sources: SRC,
  };
}

const NA: EngineSpec['aspiration'] = { type: 'na', turbo: null, supercharger: null };
const TURBO: EngineSpec['aspiration'] = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
const SC: EngineSpec['aspiration'] = {
  type: 'supercharger',
  turbo: null,
  supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 },
};

const I5 = makeSpec('inline', [0, 144, 288, 432, 576].map((a) => ({ angleDeg: a, bank: 0 })), TURBO, 850, 7000);
const V8 = makeSpec(
  'v',
  [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })),
  NA,
  700,
  7500,
);
const FLAT4 = makeSpec('flat', [0, 0, 1, 1].map((bank, i) => ({ angleDeg: i * 180, bank })), TURBO);
const ROTARY = makeSpec('rotary', [0, 180, 360, 540, 720, 900].map((a) => ({ angleDeg: a, bank: 0 })), TURBO, 750, 8000);
const V8SC = makeSpec('v', [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })), SC, 700, 6200);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

describe('defaultVoicing', () => {
  it('is deterministic and returns fresh objects on every call', () => {
    const a = defaultVoicing(V8);
    const b = defaultVoicing(V8);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.headersM).not.toBe(b.headersM);
    a.headersM[0] = 99;
    expect(defaultVoicing(V8).headersM[0]).not.toBe(99);
  });

  it('gives one header per combustion entry, 0.55–0.70 m, not all equal', () => {
    for (const spec of [I5, V8, V8SC]) {
      const h = defaultVoicing(spec).headersM;
      expect(h).toHaveLength(spec.combustion.length);
      for (const x of h) {
        expect(x).toBeGreaterThanOrEqual(0.55);
        expect(x).toBeLessThanOrEqual(0.7);
      }
      expect(new Set(h).size).toBeGreaterThan(1);
    }
  });

  it('is bank-symmetric for V engines', () => {
    const v = defaultVoicing(V8);
    const bank = (b: number): number[] =>
      V8.combustion.flatMap((c, i) => (c.bank === b ? [v.headersM[i] ?? NaN] : [])).sort((x, y) => x - y);
    expect(bank(0)).toEqual(bank(1));
  });

  it('uses deliberately unequal 0.45/0.75 pairs for flat 4-cylinders', () => {
    const h = defaultVoicing(FLAT4).headersM;
    expect(h).toEqual([0.45, 0.75, 0.45, 0.75]);
  });

  it('gives the three faces of one rotor the same header (rotary)', () => {
    const h = defaultVoicing(ROTARY).headersM;
    expect(h).toHaveLength(6);
    expect(h[0]).toBe(h[2]);
    expect(h[2]).toBe(h[4]);
    expect(h[1]).toBe(h[3]);
    expect(h[3]).toBe(h[5]);
    expect(h[0]).not.toBe(h[1]);
  });

  it('builds one 0.35 m collector per bank, banks ascending', () => {
    expect(defaultVoicing(I5).collectors).toEqual([{ banks: [0], lengthM: 0.35 }]);
    expect(defaultVoicing(V8).collectors).toEqual([
      { banks: [0], lengthM: 0.35 },
      { banks: [1], lengthM: 0.35 },
    ]);
  });

  it('adds a turbine only for turbo engines', () => {
    expect(defaultVoicing(I5).turbine).toEqual({ reflection: 0.45, lpHz: 1500 });
    expect(defaultVoicing(V8).turbine).toBeNull();
    expect(defaultVoicing(V8SC).turbine).toBeNull();
  });

  it('sets forced induction for turbo and supercharger only', () => {
    expect(defaultVoicing(I5).forcedInduction).toEqual({ spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 });
    expect(defaultVoicing(V8SC).forcedInduction).toEqual({ spoolTimeS: 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 });
    expect(defaultVoicing(V8).forcedInduction).toBeNull();
  });

  it('uses the contract constants for exhaust, intake, mechanical, overrun, cabin and pulse', () => {
    const v = defaultVoicing(I5);
    expect(v.exhaust).toEqual({
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    });
    expect(v.intake).toEqual({ runnerM: 0.3, helmholtzHz: 145, gain: 0.4 });
    expect(defaultVoicing(V8).intake.helmholtzHz).toBe(160);
    expect(defaultVoicing(ROTARY).intake.helmholtzHz).toBe(130);
    expect(v.mechanical).toEqual({ blockGain: 0.3, valvetrainGain: 0.1 });
    expect(v.overrun).toEqual({ crackleRate: 0.5, fuelCutResumeRpm: 1350 });
    expect(v.cabin).toEqual({ lowpassHz: 600 });
    expect(v.pulse).toEqual({ widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 });
    expect(defaultVoicing(ROTARY).pulse.widthDeg).toBe(260);
    expect(v.estimated).toBe(true);
  });

  it('derives launchRpm from redline: NA 0.55, turbo/supercharger 0.45', () => {
    expect(defaultVoicing(V8).launchRpm).toBe(4125);
    expect(defaultVoicing(I5).launchRpm).toBe(3150);
    expect(defaultVoicing(V8SC).launchRpm).toBe(2790);
  });

  it('produces voicings that validate against engine.schema.json', () => {
    for (const [i, spec] of [I5, V8, FLAT4, ROTARY, V8SC].entries()) {
      const def: EngineDef = {
        id: `fixture-${i}`,
        name: 'Fixture',
        inspiredBy: 'Fixture',
        set: 'euro',
        notes: 'fixture',
        spec: {
          ...spec,
          layout: { ...spec.layout, crank: spec.layout.type === 'v' ? 'cross-plane' : 'n/a' },
        },
        voicing: defaultVoicing(spec),
      };
      const ok = validateEngine(def);
      expect(validateEngine.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npx vitest run tests/unit/voicing-defaults.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/data/voicing-defaults"`.

- [ ] **Step 10: Implement `defaultVoicing`**

Create `src/data/voicing-defaults.ts` (header rule: lengths keyed by the entry's ordinal within its bank — rotaries: by rotor — through a golden-ratio sequence, so they vary per entry inside 0.55–0.70 m and V/flat engines are bank-symmetric by construction; "cylinders" for the Helmholtz term counts rotors for rotaries, the EPA "cylinders and rotors" convention):

```ts
import type { EngineSpec, EngineVoicing } from '../contracts';

/** Header lengths for the generic rule span [HEADER_MIN_M, HEADER_MIN_M + HEADER_SPAN_M). */
const HEADER_MIN_M = 0.55;
const HEADER_SPAN_M = 0.15;
/** Deliberately unequal header pair for flat 4-cylinders (boxer rumble). */
const FLAT4_SHORT_M = 0.45;
const FLAT4_LONG_M = 0.75;
/** Golden-ratio low-discrepancy step: deterministic, well-spread lengths. */
const GOLDEN_FRACTION = 0.6180339887498949;
const COLLECTOR_M = 0.35;
const ROTARY_FACES_PER_ROTOR = 3;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Cylinders for 4-strokes; rotors (not faces) for rotaries — the EPA "cylinders and rotors" convention. */
function cylinderCount(spec: EngineSpec): number {
  return spec.layout.type === 'rotary'
    ? spec.combustion.length / ROTARY_FACES_PER_ROTOR
    : spec.combustion.length;
}

/**
 * One length per combustion entry, keyed by the entry's ordinal position within its bank
 * (rotaries: by rotor, so the three faces of one rotor share their port's header). Using the
 * within-bank ordinal makes V and flat engines bank-symmetric by construction.
 */
function headerLengths(spec: EngineSpec): number[] {
  const flat4 = spec.layout.type === 'flat' && spec.combustion.length === 4;
  const rotary = spec.layout.type === 'rotary';
  const seenPerBank = new Map<number, number>();
  const rotorOrdinal = new Map<number, number>();
  const out: number[] = [];
  for (const entry of spec.combustion) {
    let ordinal: number;
    if (rotary) {
      const rotorOffset = Math.round(entry.angleDeg % 360);
      const known = rotorOrdinal.get(rotorOffset);
      if (known === undefined) {
        ordinal = rotorOrdinal.size;
        rotorOrdinal.set(rotorOffset, ordinal);
      } else {
        ordinal = known;
      }
    } else {
      ordinal = seenPerBank.get(entry.bank) ?? 0;
      seenPerBank.set(entry.bank, ordinal + 1);
    }
    if (flat4) {
      out.push(ordinal % 2 === 0 ? FLAT4_SHORT_M : FLAT4_LONG_M);
    } else {
      out.push(round3(HEADER_MIN_M + HEADER_SPAN_M * ((ordinal * GOLDEN_FRACTION) % 1)));
    }
  }
  return out;
}

/**
 * Deterministic starting voicing for an engine spec (phase-1 contract "defaultVoicing").
 * Every call returns fresh objects; `estimated` is always true until Sound Lab sign-off.
 */
export function defaultVoicing(spec: EngineSpec): EngineVoicing {
  const asp = spec.aspiration.type;
  const turbo = asp === 'turbo';
  const forced = asp === 'turbo' || asp === 'supercharger';
  const banks = [...new Set(spec.combustion.map((c) => c.bank))].sort((a, b) => a - b);
  return {
    pulse: {
      widthDeg: spec.layout.type === 'rotary' ? 260 : 60,
      alpha: 9,
      beta: 4,
      evoOffsetDeg: 140,
      cycleAsymmetry: 0.1,
    },
    headersM: headerLengths(spec),
    collectors: banks.map((b) => ({ banks: [b], lengthM: COLLECTOR_M })),
    turbine: turbo ? { reflection: 0.45, lpHz: 1500 } : null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    },
    intake: {
      runnerM: 0.3,
      helmholtzHz: 120 + (20 * cylinderCount(spec)) / 4,
      gain: 0.4,
    },
    forcedInduction: forced
      ? { spoolTimeS: turbo ? 0.6 : 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 }
      : null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: spec.rpm.idle + 500 },
    cabin: { lowpassHz: 600 },
    launchRpm: Math.round((forced ? 0.45 : 0.55) * spec.rpm.redline),
    estimated: true,
  };
}
```

- [ ] **Step 11: Run the `defaultVoicing` test to verify it passes**

Run: `npx vitest run tests/unit/voicing-defaults.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 12: Write the failing engine-catalogue test**

Create `tests/unit/engines.test.ts` (generic per-engine checks run for every entry of `ENGINES`; Task 10 extends the file):

```ts
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { MAX_COMBUSTION, type EngineDef } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { parseTyre, rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';

const MPH_IN_MPS = 0.44704;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

/** Cylinder (or rotor-face) count implied by the engine id: "i5-…" → 5, "v8-…" → 8, "flat6-…" → 6, twin rotary → 6 faces. */
function expectedCombustionCount(id: string): number {
  if (id.startsWith('rotary-twin-')) return 6;
  const m = /^(?:i|v|flat)(\d+)-/.exec(id);
  if (m === null || m[1] === undefined) throw new Error(`cannot infer cylinder count from id "${id}"`);
  return Number(m[1]);
}

function bankCounts(e: EngineDef): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of e.spec.combustion) counts.set(c.bank, (counts.get(c.bank) ?? 0) + 1);
  return counts;
}

/**
 * EPA Test Car List N/V (engine rpm per mph) checks, ±2.5 %. `gear` is 1-based; EPA reports
 * top gear unless the manufacturer chose the 1:1 gear (40 CFR 86.1803-01) — screen such rows out.
 */
const EPA_NV: { id: string; nv: number; gear: number; doc: string }[] = [
  {
    id: 'i5-turbo-25',
    nv: 29.2,
    gear: 7,
    doc: 'EPA 2024 Test Car List, Audi RS 3: axle 3.45, N/V 29.2; 7th 0.630 x 3.450, front tyre 265/30ZR19',
  },
];

describe('engine catalogue', () => {
  it('has unique ids and names', () => {
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
    expect(new Set(ENGINES.map((e) => e.name)).size).toBe(ENGINES.length);
  });

  it('getEngine returns the catalogue object and throws on unknown ids', () => {
    for (const e of ENGINES) expect(getEngine(e.id)).toBe(e);
    expect(() => getEngine('no-such-engine')).toThrow(/Unknown engine id/);
  });
});

describe.each(ENGINES.map((e) => [e.id, e] as const))('engine %s', (_id, e) => {
  it('validates against engine.schema.json', () => {
    const ok = validateEngine(e);
    expect(validateEngine.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('has the combustion count its layout implies', () => {
    expect(e.spec.combustion.length).toBe(expectedCombustionCount(e.id));
    expect(e.spec.combustion.length).toBeLessThanOrEqual(MAX_COMBUSTION);
  });

  it('has distinct combustion angles within [0, cycleDeg)', () => {
    const angles = e.spec.combustion.map((c) => c.angleDeg);
    expect(new Set(angles).size).toBe(angles.length);
    for (const a of angles) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(e.spec.cycleDeg);
    }
  });

  it('has a self-consistent layout, cycle and bank assignment', () => {
    const { layout } = e.spec;
    const counts = bankCounts(e);
    if (layout.type === 'rotary') {
      expect(e.spec.cycleDeg).toBe(1080);
      expect(e.spec.combustion.length % 3).toBe(0);
    } else {
      expect(e.spec.cycleDeg).toBe(720);
    }
    if (layout.type === 'inline' || layout.type === 'rotary') {
      expect(layout.bankAngleDeg).toBe(0);
      expect([...counts.keys()]).toEqual([0]);
    } else {
      if (layout.type === 'flat') expect(layout.bankAngleDeg).toBe(180);
      else {
        expect(layout.bankAngleDeg).toBeGreaterThan(0);
        expect(layout.bankAngleDeg).toBeLessThan(180);
      }
      expect([...counts.keys()].sort()).toEqual([0, 1]);
      expect(counts.get(0)).toBe(counts.get(1));
    }
    const isV8 = layout.type === 'v' && e.spec.combustion.length === 8;
    if (isV8) expect(['cross-plane', 'flat-plane']).toContain(layout.crank);
    else expect(layout.crank).toBe('n/a');
  });

  it('has idle < redline <= limiter rpm', () => {
    expect(e.spec.rpm.idle).toBeLessThan(e.spec.rpm.redline);
    expect(e.spec.rpm.limiter.rpm).toBeGreaterThanOrEqual(e.spec.rpm.redline);
  });

  it('has strictly descending overall ratios', () => {
    const r = e.spec.gearbox.overallRatios;
    for (let i = 1; i < r.length; i++) {
      expect(r[i]).toBeLessThan(r[i - 1] ?? -Infinity);
    }
  });

  it('has a parseable driven tyre and a torque converter iff tc-auto', () => {
    expect(() => parseTyre(e.spec.gearbox.drivenTyre)).not.toThrow();
    expect(e.spec.gearbox.tc === null).toBe(e.spec.gearbox.type !== 'tc-auto');
  });

  it('has at least one source per spec field group, and notes', () => {
    for (const group of ['layout', 'combustion', 'rpm', 'aspiration', 'gearbox'] as const) {
      expect(e.spec.sources[group].length).toBeGreaterThan(0);
      for (const s of e.spec.sources[group]) expect(s.trim().length).toBeGreaterThan(0);
    }
    expect(e.notes.trim().length).toBeGreaterThan(0);
  });

  it('has aspiration blocks matching the aspiration type', () => {
    const a = e.spec.aspiration;
    expect(a.turbo !== null).toBe(a.type === 'turbo');
    expect(a.supercharger !== null).toBe(a.type === 'supercharger');
  });

  it('has a voicing consistent with its spec', () => {
    const v = e.voicing;
    expect(v.headersM).toHaveLength(e.spec.combustion.length);
    const collectorBanks = v.collectors.flatMap((c) => c.banks).sort();
    expect(collectorBanks).toEqual([...bankCounts(e).keys()].sort());
    expect(v.turbine !== null).toBe(e.spec.aspiration.type === 'turbo');
    expect(v.forcedInduction !== null).toBe(e.spec.aspiration.type !== 'na');
    expect(v.overrun.fuelCutResumeRpm).toBeGreaterThan(e.spec.rpm.idle);
    expect(v.launchRpm).toBeLessThan(e.spec.rpm.redline);
  });
});

describe('EPA N/V cross-check (±2.5 %)', () => {
  it.each(EPA_NV.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const e = getEngine(row.id);
    const ratio = e.spec.gearbox.overallRatios[row.gear - 1];
    expect(ratio, `gear ${row.gear} exists`).toBeDefined();
    const nv = wheelRpm(MPH_IN_MPS, ratio ?? NaN, rollingCircumferenceM(e.spec.gearbox.drivenTyre));
    expect(Math.abs(nv / row.nv - 1), `${row.doc}: computed ${nv.toFixed(2)}`).toBeLessThanOrEqual(0.025);
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npx vitest run tests/unit/engines.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/data/engines"`.

- [ ] **Step 14: Create the example engine `i5-turbo-25`**

Sources researched for this plan (all primary except where `notes` say otherwise; both PDFs were downloaded and their text checked while planning):
- Audi eTD RS 3 Sedan, Program for Germany, status 03/06/2026: inline-5, 2480 cc, 82.5 × 92.8 mm, 294 kW at 5600–7000 rpm, "Direct injection, lambda control, knock control, turbocharger, intercooler", 7-speed S tronic, ratios 3.560/2.530/1.680/1.020/0.790/0.760/0.630, "final drive ratio 1-2 / 2-3: 4.059 / -" (one final drive only), tyres 265/30 ZR 19 | 245/35 ZR 19.
- Audi Technical Data RS 3 Sportback 2.5 TFSI quattro S tronic (294 kW), Program for Germany, status January 2017 (same 7-speed S tronic, ratios 3.563/2.526/1.679/1.022/0.788/0.761/0.635): "Reverse gear / final drive ratio 2.789 / 4.059 (1st, 4th, 5th + reverse gear); 3.450 (2nd, 3rd, 6th + 7th gear)" — the primary source for the per-gear dual final-drive mapping that spec §8.3 asks for. The URL is an unaltered copy of Audi's PDF on a third-party host (autoprove.net); the `sources` line says so.
- Overall ratios (gear × applicable final drive, 4 decimals): 3.560×4.059 = 14.4500, 2.530×3.450 = 8.7285, 1.680×3.450 = 5.7960, 1.020×4.059 = 4.1402, 0.790×4.059 = 3.2066, 0.760×3.450 = 2.6220, 0.630×3.450 = 2.1735 (strictly descending; steps 1.66 → 1.21).
- EPA 2024 Test Car List, Audi RS 3: axle 3.45, N/V 29.2 → with the FRONT (driven, transverse quattro) tyre 265/30ZR19 the model gives 29.82 rpm/mph (+2.1 %, inside ±2.5 %).
- Firing order 1-2-4-5-3 (Audi MediaCenter), even 144° interval; combustion entries listed in firing order, one exhaust bank.
- The `voicing` block is exactly `defaultVoicing(spec)` (verified in Step 17).

Create `src/data/engines/i5-turbo-25.json`:

```json
{
  "id": "i5-turbo-25",
  "name": "2.5 Turbo Inline-5",
  "inspiredBy": "Audi RS 3 (8Y)",
  "set": "euro",
  "notes": "Variant: Audi RS 3 (8Y, 2.5 TFSI 294 kW, 7-speed S tronic wet DCT), data status Audi eTD 03/06/2026. Combustion entries are listed in firing order 1-2-4-5-3 (cylinder 1, 2, 4, 5, 3) at the even 720/5 = 144 deg interval; single exhaust bank. Gearbox: the 8Y eTD gives gear ratios 3.560/2.530/1.680/1.020/0.790/0.760/0.630 but only the 4.059 final drive; the per-gear dual final-drive mapping (4.059 for 1st, 4th, 5th and reverse; 3.450 for 2nd, 3rd, 6th, 7th) comes from Audi's own RS 3 Sportback 8V technical data (status January 2017), which uses the same 7-speed S tronic (8V ratios 3.563/2.526/1.679/1.022/0.788/0.761/0.635 agree with the 8Y two-decimal figures to within 0.005; the 8Y figures are used). Overall ratios = gear x applicable final drive. The EPA Test Car List (MY2023-2024 RS 3) lists axle 3.45 and N/V 29.2, consistent with 7th x 3.450. Driven tyre is the FRONT 265/30 ZR19 (transverse quattro: the gearbox final drive turns the front axle). Estimated (not published): idle 850 rpm, limiter type/rpm/hysteresis (ignition soft cut just above the 7,000 rpm end of the rated-power plateau), shift time 0.10 s (DCT default).",
  "spec": {
    "layout": {
      "type": "inline",
      "bankAngleDeg": 0,
      "crank": "n/a",
      "displacementL": 2.48
    },
    "cycleDeg": 720,
    "combustion": [
      {
        "angleDeg": 0,
        "bank": 0
      },
      {
        "angleDeg": 144,
        "bank": 0
      },
      {
        "angleDeg": 288,
        "bank": 0
      },
      {
        "angleDeg": 432,
        "bank": 0
      },
      {
        "angleDeg": 576,
        "bank": 0
      }
    ],
    "rpm": {
      "idle": 850,
      "redline": 7000,
      "limiter": {
        "type": "ignition-soft",
        "rpm": 7100,
        "hysteresisRpm": 150
      }
    },
    "aspiration": {
      "type": "turbo",
      "turbo": {
        "count": 1,
        "layout": "single"
      },
      "supercharger": null
    },
    "gearbox": {
      "type": "dct",
      "overallRatios": [
        14.45,
        8.7285,
        5.796,
        4.1402,
        3.2066,
        2.622,
        2.1735
      ],
      "drivenTyre": "265/30ZR19",
      "shiftTimeS": 0.1,
      "tc": null
    },
    "sources": {
      "layout": [
        "Audi AG, Technical data sheet Audi RS 3 Sedan, Program for Germany, status 03/06/2026 (Inline 5-cylinder; 2480 cc; 82.5 x 92.8 mm): https://uploads.audi-mediacenter.com/system/production/car_motorizations/1545/file_en/4fa19f9df51c551a54ddb969966dffefecb35555/eTD-Audi-RS3-Sedan_260306.pdf"
      ],
      "combustion": [
        "Audi MediaCenter, 'The engine: legendary five-cylinder' (firing order 1-2-4-5-3): https://www.audi-mediacenter.com/en/high-performance-redefined-audi-rs-3-sportback-and-rs-3-sedan-14310/the-engine-legendary-five-cylinder-14313",
        "Four-stroke even firing interval = 720 deg / 5 cylinders = 144 deg (first principles)"
      ],
      "rpm": [
        "Audi AG eTD RS 3 Sedan 03/06/2026 (max. power 294 kW at 5600-7000 rpm): https://uploads.audi-mediacenter.com/system/production/car_motorizations/1545/file_en/4fa19f9df51c551a54ddb969966dffefecb35555/eTD-Audi-RS3-Sedan_260306.pdf"
      ],
      "aspiration": [
        "Audi AG eTD RS 3 Sedan 03/06/2026 (mixture preparation: direct injection, turbocharger, intercooler): https://uploads.audi-mediacenter.com/system/production/car_motorizations/1545/file_en/4fa19f9df51c551a54ddb969966dffefecb35555/eTD-Audi-RS3-Sedan_260306.pdf"
      ],
      "gearbox": [
        "Audi AG eTD RS 3 Sedan 03/06/2026 (7-speed S tronic; gear ratios; final drive 4.059; tyres 265/30 ZR 19 | 245/35 ZR 19): https://uploads.audi-mediacenter.com/system/production/car_motorizations/1545/file_en/4fa19f9df51c551a54ddb969966dffefecb35555/eTD-Audi-RS3-Sedan_260306.pdf",
        "Audi AG, Technical Data Audi RS 3 Sportback 2.5 TFSI quattro S tronic (294 kW), Program for Germany, status January 2017 ('Reverse gear / final drive ratio 2.789 / 4.059 (1st, 4th, 5th + reverse gear); 3.450 (2nd, 3rd, 6th + 7th gear)'; unaltered copy of the Audi PDF hosted by autoprove.net): https://autoprove.net/wp-content/uploads/47869/84d34277e645571bae7ce626ef3f6281.pdf",
        "US EPA 2024 Test Car List, Audi RS 3 (axle ratio 3.45, N/V 29.2): https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx"
      ]
    }
  },
  "voicing": {
    "pulse": {
      "widthDeg": 60,
      "alpha": 9,
      "beta": 4,
      "evoOffsetDeg": 140,
      "cycleAsymmetry": 0.1
    },
    "headersM": [
      0.55,
      0.643,
      0.585,
      0.678,
      0.621
    ],
    "collectors": [
      {
        "banks": [
          0
        ],
        "lengthM": 0.35
      }
    ],
    "turbine": {
      "reflection": 0.45,
      "lpHz": 1500
    },
    "exhaust": {
      "midPipeM": 1.4,
      "mufflerSectionsM": [
        0.21,
        0.34,
        0.47
      ],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {
        "fitted": true,
        "openGainDb": 4
      }
    },
    "intake": {
      "runnerM": 0.3,
      "helmholtzHz": 145,
      "gain": 0.4
    },
    "forcedInduction": {
      "spoolTimeS": 0.6,
      "maxShaftKrpm": 180,
      "lift": "bov",
      "cabinGainDb": -14
    },
    "mechanical": {
      "blockGain": 0.3,
      "valvetrainGain": 0.1
    },
    "overrun": {
      "crackleRate": 0.5,
      "fuelCutResumeRpm": 1350
    },
    "cabin": {
      "lowpassHz": 600
    },
    "launchRpm": 3150,
    "estimated": true
  }
}
```

- [ ] **Step 15: Create the engine index**

Create `src/data/engines/index.ts`:

```ts
import type { EngineDef } from '../../contracts';
import i5Turbo25 from './i5-turbo-25.json';

/** JSON imports widen literal unions to string; engine.schema.json (tests) is the real guard. */
function def(json: unknown): EngineDef {
  return json as EngineDef;
}

/** Starter garage, in spec §5.5 order (Task 10 adds the other 14 engines). */
export const ENGINES: EngineDef[] = [def(i5Turbo25)];

export function getEngine(id: string): EngineDef {
  const found = ENGINES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`Unknown engine id "${id}"`);
  }
  return found;
}
```

- [ ] **Step 16: Run the engine test to verify it passes**

Run: `npx vitest run tests/unit/engines.test.ts`
Expected: PASS — 13 tests (2 catalogue + 10 for `engine i5-turbo-25` + 1 EPA N/V). The N/V check computes ≈ 29.82 rpm/mph vs EPA 29.2 (+2.1 %).

- [ ] **Step 17: Confirm the JSON voicing is exactly the generated default**

```bash
npx tsx -e "
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { defaultVoicing } from './src/data/voicing-defaults.ts';
const d = JSON.parse(readFileSync('src/data/engines/i5-turbo-25.json', 'utf8'));
console.log(isDeepStrictEqual(d.voicing, defaultVoicing(d.spec)));
"
```

Expected: prints `true`. (Voicing values are Sound Lab estimates; later tuning may diverge from the defaults, so this is an authoring check, not a unit test.)

- [ ] **Step 18: Run the three test files together, then lint and typecheck**

Run: `npx vitest run tests/unit/schemas.test.ts tests/unit/voicing-defaults.test.ts tests/unit/engines.test.ts`
Expected: PASS — 61 tests.

The engine sweeps in `tests/unit/shift-map.test.ts` and `tests/unit/sim-core.test.ts` (`i5-turbo-25` adds 2 tests to each) run in Task 8 Step 6/7 and Task 12 Step 9 (`npm run verify`); Task 5, in this task's wave, sweeps whatever engine JSON exists when it runs. A failure there for `i5-turbo-25` is a data problem: fix the engine data, never the assertions.

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no errors. (In a parallel wave this runs once, after every task of the wave is done — plan header, Execution order; a TS2307 for another in-flight task's file is not this task's failure.)

---

### Task 10: The remaining 14 engine definitions (data compilation), complete `ENGINES`, garage / N/V / gear-speed / firing tests

**Files:**
- Create: `src/data/engines/v8-na-50.json`, `src/data/engines/rotary-twin-13.json`, `src/data/engines/v10-na-48.json` (full JSON in this task, researched while planning)
- Create: `src/data/engines/flat6-na-40.json`, `src/data/engines/v10-na-52.json`, `src/data/engines/i4-turbo-20.json`, `src/data/engines/i6-twinturbo-30.json`, `src/data/engines/flat4-turbo-25.json`, `src/data/engines/v6-twinturbo-38.json`, `src/data/engines/v8-na-62.json`, `src/data/engines/v8-sc-62.json`, `src/data/engines/v12-na-65.json`, `src/data/engines/v8-flatplane-45.json`, `src/data/engines/v8-twinturbo-40.json` (compiled by research agents with the procedure in Step 8, one engine per step 9–19)
- Modify: `src/data/engines/index.ts`
- Modify / Test: `tests/unit/engines.test.ts`

**Interfaces:**
- Consumes:
  - Task 9: `defaultVoicing(spec: EngineSpec): EngineVoicing` (`src/data/voicing-defaults.ts`), `ENGINES: EngineDef[]` / `getEngine(id: string): EngineDef` (`src/data/engines/index.ts`), `src/data/schema/engine.schema.json`, the T9 `tests/unit/engines.test.ts` (replaced here by a superset).
  - `src/contracts.ts`: `EngineDef`, `MAX_COMBUSTION`, `firingHz(rpm: number, combustionCount: number, cycleDeg: number): number`.
  - Task 1 `src/sim/tyre.ts`: `parseTyre(code: string): Tyre`, `rollingCircumferenceM(code: string): number`, `wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number`.
- Produces:
  - `ENGINES` with exactly the 15 contract ids, in spec §5.5 order: `i5-turbo-25`, `flat6-na-40`, `v10-na-52`, `i4-turbo-20`, `i6-twinturbo-30`, `rotary-twin-13`, `flat4-turbo-25`, `v6-twinturbo-38`, `v8-na-50`, `v8-na-62`, `v8-sc-62`, `v12-na-65`, `v8-flatplane-45`, `v10-na-48`, `v8-twinturbo-40` — each with `name`/`inspiredBy`/`set` exactly as the `GARAGE` table in Step 1.
  - `getEngine(id)` for all 15 (used by SimCore tests, Phase 2 render/score CLIs, the Garage UI).
  - `tests/unit/engines.test.ts` tables `EPA_NV` (`{ id; nv; gear; doc }`) and `MAKER_GEAR_SPEEDS` (`{ id; rpm; mphByGear; doc }`), to which Step 20 appends the rows the research agents of Steps 9–19 report (agents never edit the test file — Step 8).

**Cross-task premises:**
- Task 9 is complete: open `src/data/engines/index.ts` and confirm the `def(json: unknown): EngineDef` helper and `ENGINES`/`getEngine` exist; open `tests/unit/engines.test.ts` and confirm it is the T9 version (13 tests for `i5-turbo-25`).
- `src/data/voicing-defaults.ts` exports `defaultVoicing` (the voicing generator command in Step 8 imports it with a `.ts` path through `tsx`).
- Task 5 is complete (wave W2, plan header): `tests/unit/shift-map.test.ts` sweeps every `src/data/engines/*.json` via `import.meta.glob` (`shift-map invariants: <id>`, two tests per engine); Step 8 rule 12 and Step 21 run it. Task 8's per-engine SimCore sweep runs later (wave W4).
- Task 1 `rollingCircumferenceM` = π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97, `wheelRpm(v, ratio, C)` = v / C × ratio × 60 (linear in `v`; the gear-speed test relies on it), and `parseTyre` accepts `"285/35ZR20"`-style codes (no space, `ZR`).
- `firingHz` from `src/contracts.ts` is `(rpm/60) × count × 360 / cycleDeg` (I4 at 6000 → 200 Hz; 13B at 6000 → 200 Hz; V8 at 6000 → 400 Hz).
- Clean-room rule: nothing from rupteur.app or any repo/app referencing it (e.g. github.com/UnendlessGit/juniper-sound-lab) may be fetched or read; do not bulk-copy any specs database — aggregators (auto-data, ultimatespecs, carfolio, ev-database, …) may only point you to a primary document, never be the cited source.
- Every EPA number quoted in Steps 1 and 9–19 was read from the EPA Test Car List files while planning (2026-10-06); still re-read the row before relying on it.

- [ ] **Step 1: Replace the engine test with the full-garage version**

Replace the whole content of `tests/unit/engines.test.ts` with (T9 content plus `firingHz`, the `v8-na-50` EPA row, the `MAKER_GEAR_SPEEDS` table and test, the `GARAGE` table and the garage/firing tests):

```ts
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { firingHz, MAX_COMBUSTION, type EngineDef } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { parseTyre, rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';

const MPH_IN_MPS = 0.44704;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

/** Cylinder (or rotor-face) count implied by the engine id: "i5-…" → 5, "v8-…" → 8, "flat6-…" → 6, twin rotary → 6 faces. */
function expectedCombustionCount(id: string): number {
  if (id.startsWith('rotary-twin-')) return 6;
  const m = /^(?:i|v|flat)(\d+)-/.exec(id);
  if (m === null || m[1] === undefined) throw new Error(`cannot infer cylinder count from id "${id}"`);
  return Number(m[1]);
}

function bankCounts(e: EngineDef): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of e.spec.combustion) counts.set(c.bank, (counts.get(c.bank) ?? 0) + 1);
  return counts;
}

/**
 * EPA Test Car List N/V (engine rpm per mph) checks, ±2.5 %. `gear` is 1-based; EPA reports
 * top gear unless the manufacturer chose the 1:1 gear (40 CFR 86.1803-01) — screen such rows out.
 * Screened out (documented in the engine's notes): v10-na-48 — the EPA 2012 LFA row (axle 3.42,
 * N/V 34.4) omits the 1.259 front counter gear that Lexus's own per-gear speed table includes.
 */
const EPA_NV: { id: string; nv: number; gear: number; doc: string }[] = [
  {
    id: 'i5-turbo-25',
    nv: 29.2,
    gear: 7,
    doc: 'EPA 2024 Test Car List, Audi RS 3: axle 3.45, N/V 29.2; 7th 0.630 x 3.450, front tyre 265/30ZR19',
  },
  {
    id: 'v8-na-50',
    nv: 28.3,
    gear: 6,
    doc: 'EPA 2024 Test Car List, Ford Mustang (450 hp) 6-speed manual: axle 3.55, N/V 28.3; 6th 0.622 x 3.55, rear tyre 255/45R18',
  },
];

/**
 * Manufacturer "maximum speed in each gear" tables, ±2.5 % (same rolling-circumference model as
 * the N/V check). `rpm` is the engine speed the manufacturer's table refers to. A gear whose
 * published figure is the car's (drag-limited) top speed is not listed.
 */
const MAKER_GEAR_SPEEDS: { id: string; rpm: number; mphByGear: number[]; doc: string }[] = [
  {
    id: 'v10-na-48',
    rpm: 9000,
    mphByGear: [52, 76, 104, 136, 172],
    doc: 'Lexus UK media, GAZOO Racing Lexus LFA (20 June 2012), maximum permissible speed in gears 1-5 at the 9,000 rpm maximum engine speed; 6th (202 mph) is the top speed and is not used',
  },
];

/** Spec §5.5 garage: exact ids, order, set, title and "inspired by" subtitle. */
const GARAGE: { id: string; set: EngineDef['set']; name: string; inspiredBy: string }[] = [
  { id: 'i5-turbo-25', set: 'euro', name: '2.5 Turbo Inline-5', inspiredBy: 'Audi RS 3 (8Y)' },
  { id: 'flat6-na-40', set: 'euro', name: '4.0 Flat-Six NA', inspiredBy: 'Porsche 911 GT3 (992)' },
  { id: 'v10-na-52', set: 'euro', name: '5.2 V10 NA', inspiredBy: 'Lamborghini Huracán' },
  { id: 'i4-turbo-20', set: 'euro', name: '2.0 Turbo Inline-4', inspiredBy: 'VW Golf GTI (Mk8)' },
  { id: 'i6-twinturbo-30', set: 'jdm', name: '3.0 Twin-Turbo Inline-6', inspiredBy: 'Toyota Supra (A80, 2JZ-GTE)' },
  { id: 'rotary-twin-13', set: 'jdm', name: '1.3 Twin-Rotor Turbo Rotary', inspiredBy: 'Mazda RX-7 (FD, 13B-REW)' },
  { id: 'flat4-turbo-25', set: 'jdm', name: '2.5 Turbo Flat-Four', inspiredBy: 'Subaru WRX STI (EJ257)' },
  { id: 'v6-twinturbo-38', set: 'jdm', name: '3.8 Twin-Turbo V6', inspiredBy: 'Nissan GT-R (R35, VR38DETT)' },
  { id: 'v8-na-50', set: 'american', name: '5.0 V8 NA', inspiredBy: 'Ford Mustang GT (Coyote)' },
  { id: 'v8-na-62', set: 'american', name: '6.2 Small-Block V8 NA', inspiredBy: 'Chevrolet Corvette (C8, LT2)' },
  { id: 'v8-sc-62', set: 'american', name: '6.2 Supercharged V8', inspiredBy: 'Dodge Challenger SRT Hellcat' },
  { id: 'v12-na-65', set: 'exotic', name: '6.5 V12 NA', inspiredBy: 'Ferrari 812 Superfast' },
  { id: 'v8-flatplane-45', set: 'exotic', name: '4.5 Flat-Plane V8', inspiredBy: 'Ferrari 458 Italia' },
  { id: 'v10-na-48', set: 'exotic', name: '4.8 V10 NA', inspiredBy: 'Lexus LFA' },
  { id: 'v8-twinturbo-40', set: 'exotic', name: '4.0 Twin-Turbo V8', inspiredBy: 'Audi RS 6 Avant (C8)' },
];

describe('engine catalogue', () => {
  it('has unique ids and names', () => {
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
    expect(new Set(ENGINES.map((e) => e.name)).size).toBe(ENGINES.length);
  });

  it('getEngine returns the catalogue object and throws on unknown ids', () => {
    for (const e of ENGINES) expect(getEngine(e.id)).toBe(e);
    expect(() => getEngine('no-such-engine')).toThrow(/Unknown engine id/);
  });
});

describe.each(ENGINES.map((e) => [e.id, e] as const))('engine %s', (_id, e) => {
  it('validates against engine.schema.json', () => {
    const ok = validateEngine(e);
    expect(validateEngine.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('has the combustion count its layout implies', () => {
    expect(e.spec.combustion.length).toBe(expectedCombustionCount(e.id));
    expect(e.spec.combustion.length).toBeLessThanOrEqual(MAX_COMBUSTION);
  });

  it('has distinct combustion angles within [0, cycleDeg)', () => {
    const angles = e.spec.combustion.map((c) => c.angleDeg);
    expect(new Set(angles).size).toBe(angles.length);
    for (const a of angles) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(e.spec.cycleDeg);
    }
  });

  it('has a self-consistent layout, cycle and bank assignment', () => {
    const { layout } = e.spec;
    const counts = bankCounts(e);
    if (layout.type === 'rotary') {
      expect(e.spec.cycleDeg).toBe(1080);
      expect(e.spec.combustion.length % 3).toBe(0);
    } else {
      expect(e.spec.cycleDeg).toBe(720);
    }
    if (layout.type === 'inline' || layout.type === 'rotary') {
      expect(layout.bankAngleDeg).toBe(0);
      expect([...counts.keys()]).toEqual([0]);
    } else {
      if (layout.type === 'flat') expect(layout.bankAngleDeg).toBe(180);
      else {
        expect(layout.bankAngleDeg).toBeGreaterThan(0);
        expect(layout.bankAngleDeg).toBeLessThan(180);
      }
      expect([...counts.keys()].sort()).toEqual([0, 1]);
      expect(counts.get(0)).toBe(counts.get(1));
    }
    const isV8 = layout.type === 'v' && e.spec.combustion.length === 8;
    if (isV8) expect(['cross-plane', 'flat-plane']).toContain(layout.crank);
    else expect(layout.crank).toBe('n/a');
  });

  it('has idle < redline <= limiter rpm', () => {
    expect(e.spec.rpm.idle).toBeLessThan(e.spec.rpm.redline);
    expect(e.spec.rpm.limiter.rpm).toBeGreaterThanOrEqual(e.spec.rpm.redline);
  });

  it('has strictly descending overall ratios', () => {
    const r = e.spec.gearbox.overallRatios;
    for (let i = 1; i < r.length; i++) {
      expect(r[i]).toBeLessThan(r[i - 1] ?? -Infinity);
    }
  });

  it('has a parseable driven tyre and a torque converter iff tc-auto', () => {
    expect(() => parseTyre(e.spec.gearbox.drivenTyre)).not.toThrow();
    expect(e.spec.gearbox.tc === null).toBe(e.spec.gearbox.type !== 'tc-auto');
  });

  it('has at least one source per spec field group, and notes', () => {
    for (const group of ['layout', 'combustion', 'rpm', 'aspiration', 'gearbox'] as const) {
      expect(e.spec.sources[group].length).toBeGreaterThan(0);
      for (const s of e.spec.sources[group]) expect(s.trim().length).toBeGreaterThan(0);
    }
    expect(e.notes.trim().length).toBeGreaterThan(0);
  });

  it('has aspiration blocks matching the aspiration type', () => {
    const a = e.spec.aspiration;
    expect(a.turbo !== null).toBe(a.type === 'turbo');
    expect(a.supercharger !== null).toBe(a.type === 'supercharger');
  });

  it('has a voicing consistent with its spec', () => {
    const v = e.voicing;
    expect(v.headersM).toHaveLength(e.spec.combustion.length);
    const collectorBanks = v.collectors.flatMap((c) => c.banks).sort();
    expect(collectorBanks).toEqual([...bankCounts(e).keys()].sort());
    expect(v.turbine !== null).toBe(e.spec.aspiration.type === 'turbo');
    expect(v.forcedInduction !== null).toBe(e.spec.aspiration.type !== 'na');
    expect(v.overrun.fuelCutResumeRpm).toBeGreaterThan(e.spec.rpm.idle);
    expect(v.launchRpm).toBeLessThan(e.spec.rpm.redline);
  });
});

describe('EPA N/V cross-check (±2.5 %)', () => {
  it.each(EPA_NV.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const e = getEngine(row.id);
    const ratio = e.spec.gearbox.overallRatios[row.gear - 1];
    expect(ratio, `gear ${row.gear} exists`).toBeDefined();
    const nv = wheelRpm(MPH_IN_MPS, ratio ?? NaN, rollingCircumferenceM(e.spec.gearbox.drivenTyre));
    expect(Math.abs(nv / row.nv - 1), `${row.doc}: computed ${nv.toFixed(2)}`).toBeLessThanOrEqual(0.025);
  });
});

describe('manufacturer speed-per-gear cross-check (±2.5 %)', () => {
  it.each(MAKER_GEAR_SPEEDS.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const e = getEngine(row.id);
    const circumferenceM = rollingCircumferenceM(e.spec.gearbox.drivenTyre);
    row.mphByGear.forEach((mph, i) => {
      const ratio = e.spec.gearbox.overallRatios[i];
      expect(ratio, `gear ${i + 1} exists`).toBeDefined();
      // wheelRpm is linear in speed: speed at `rpm` = rpm / (engine rpm at 1 m/s).
      const mphAtRpm = row.rpm / wheelRpm(1, ratio ?? NaN, circumferenceM) / MPH_IN_MPS;
      expect(Math.abs(mphAtRpm / mph - 1), `${row.doc}: gear ${i + 1} computed ${mphAtRpm.toFixed(1)} mph`).toBeLessThanOrEqual(0.025);
    });
  });
});

describe('garage (spec §5.5)', () => {
  it('lists exactly the 15 engines, in order, with set, title and subtitle', () => {
    expect(ENGINES.map((e) => ({ id: e.id, set: e.set, name: e.name, inspiredBy: e.inspiredBy }))).toEqual(GARAGE);
  });

  it('has the contract firing-frequency sanity values', () => {
    const hz = (id: string, rpm: number): number => {
      const s = getEngine(id).spec;
      return firingHz(rpm, s.combustion.length, s.cycleDeg);
    };
    expect(hz('i4-turbo-20', 6000)).toBeCloseTo(200, 9);
    expect(hz('rotary-twin-13', 6000)).toBeCloseTo(200, 9);
    expect(hz('v8-na-50', 6000)).toBeCloseTo(400, 9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/engines.test.ts`
Expected: FAIL — `4 failed | 13 passed (17)`: `EPA N/V cross-check (±2.5 %) > v8-na-50` and `manufacturer speed-per-gear cross-check (±2.5 %) > v10-na-48` (`Unknown engine id …`), `lists exactly the 15 engines…` (1 engine vs 15) and `has the contract firing-frequency sanity values` (`Unknown engine id "i4-turbo-20"`). The 13 T9 tests still pass.

- [ ] **Step 3: Create `v8-na-50` (researched for this plan)**

Variant: 2024+ Ford Mustang GT (S650, Gen 4 Coyote), standard Getrag MT-82 6-speed manual, 3.55 axle, standard 255/45R18 rear tyre. Firing order 1-5-4-8-6-3-7-2 (Ford 2014 Mustang workshop manual §303-07B; unchanged for Gen 4 per Haltech), Ford numbering right bank 1–4 = bank 0, left bank 5–8 = bank 1, cross-plane 90° intervals → per-bank pattern R-L-R-L-L-R-L-R. Overall ratios = 3.237/2.104/1.422/1.000/0.814/0.622 × 3.55. EPA MY2024 Mustang 6MT axle 3.55: N/V 28.3; model 28.30 (0.0 %). Voicing = `defaultVoicing(spec)`.

Create `src/data/engines/v8-na-50.json`:

```json
{
  "id": "v8-na-50",
  "name": "5.0 V8 NA",
  "inspiredBy": "Ford Mustang GT (Coyote)",
  "set": "american",
  "notes": "Variant: 2024+ Ford Mustang GT fastback (S650, Gen 4 5.0 Coyote, 5,038 cc) with the standard 6-speed manual (Getrag MT-82: 3.237/2.104/1.422/1.000/0.814/0.622) and the 3.55:1 limited-slip axle; the 10R80 automatic and the 3.15/3.73 axles are not modelled. Cross-plane 90-degree V8, Ford numbering: right (passenger) bank cylinders 1-4 = bank 0, left bank 5-8 = bank 1. Combustion entries are listed in firing order 1-5-4-8-6-3-7-2 at even 90-degree crank intervals, giving the uneven per-bank pattern R-L-R-L-L-R-L-R (bank 0 at 0/180/450/630). The firing order is taken from the 2014 (Gen 2) Mustang workshop manual and carried forward to Gen 4 per the Haltech Coyote reference (2011-on unchanged). Driven tyre is the standard GT rear 255/45R18 (the optional 255/40R19 has the same diameter within 0.1 mm). EPA MY2024 Mustang 6-speed manual, axle 3.55: N/V 28.3. Redline 7,500 rpm is from secondary press coverage (Ford's own figures give 480 hp at 7,150 rpm); limiter type/hysteresis, idle 700 rpm and the 0.30 s manual shift time are estimates.",
  "spec": {
    "layout": {
      "type": "v",
      "bankAngleDeg": 90,
      "crank": "cross-plane",
      "displacementL": 5.038
    },
    "cycleDeg": 720,
    "combustion": [
      {
        "angleDeg": 0,
        "bank": 0
      },
      {
        "angleDeg": 90,
        "bank": 1
      },
      {
        "angleDeg": 180,
        "bank": 0
      },
      {
        "angleDeg": 270,
        "bank": 1
      },
      {
        "angleDeg": 360,
        "bank": 1
      },
      {
        "angleDeg": 450,
        "bank": 0
      },
      {
        "angleDeg": 540,
        "bank": 1
      },
      {
        "angleDeg": 630,
        "bank": 0
      }
    ],
    "rpm": {
      "idle": 700,
      "redline": 7500,
      "limiter": {
        "type": "fuel-soft",
        "rpm": 7500,
        "hysteresisRpm": 150
      }
    },
    "aspiration": {
      "type": "na",
      "turbo": null,
      "supercharger": null
    },
    "gearbox": {
      "type": "manual",
      "overallRatios": [
        11.4914,
        7.4692,
        5.0481,
        3.55,
        2.8897,
        2.2081
      ],
      "drivenTyre": "255/45R18",
      "shiftTimeS": 0.3,
      "tc": null
    },
    "sources": {
      "layout": [
        "Ford Motor Co., 2024 Ford Mustang Preliminary Technical Specifications, 22 Sept 2022 (5.0-liter V8, 5,038 cc, 93 x 92.7 mm, DOHC Ti-VCT): https://ffperformance.co/wp-content/uploads/2023/04/2024-mustang-technical-specifications.pdf",
        "Ford Performance Parts, Gen 4 5.0L Coyote Dark Horse long block M-6006-M50DH (DOHC 32-valve V-8, forged crankshaft): https://performanceparts.ford.com/part/M-6006-M50DH",
        "Cross-plane crank: Wikipedia, Ford Modular engine (last resort): https://en.wikipedia.org/wiki/Ford_Modular_engine"
      ],
      "combustion": [
        "Ford 2014 Mustang Workshop Manual, Section 303-07B Engine Ignition 5.0L (4V), firing order 1-5-4-8-6-3-7-2: https://reichwein.it/manuals/Mustang_2014/Workshop_Manual_Wiring_Diagrams/Resources/Service_Manual/seb37b01.htm",
        "Haltech knowledge base, Coyote V8 5.0L (cylinders 1-4 passenger/right bank, 5-8 driver/left bank; firing order unchanged since 2011): https://support.haltech.com/portal/en/kb/articles/coyote-engine",
        "Cross-plane V8 even firing interval 720/8 = 90 deg (first principles)"
      ],
      "rpm": [
        "Ford Performance, Gen 4 Coyote crate engines (480 hp @ 7,150 rpm, 415 lb-ft @ 4,900 rpm): https://www.fordracing.com/articles/enthusiasts/media-room/2024/4/ford-performance-parts-gen-4-coyote-engines",
        "Ford Authority, 2024 Mustang GT power figures (7,500 rpm redline): https://fordauthority.com/2022/12/2024-ford-mustang-horsepower-figures-officially-revealed/"
      ],
      "aspiration": [
        "Ford 2024 Mustang Preliminary Technical Specifications (Induction: naturally aspirated with dual air boxes and throttle bodies): https://ffperformance.co/wp-content/uploads/2023/04/2024-mustang-technical-specifications.pdf"
      ],
      "gearbox": [
        "Ford 2024 Mustang Preliminary Technical Specifications (GT 6-speed manual Getrag MT-82 ratios; final drive 3.15:1 / 3.55:1; standard tyre 255/45R18): https://ffperformance.co/wp-content/uploads/2023/04/2024-mustang-technical-specifications.pdf",
        "US EPA 2024 Test Car List, Ford Mustang 5.0 L 6-speed manual (axle ratio 3.55, N/V 28.3): https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx"
      ]
    }
  },
  "voicing": {
    "pulse": {
      "widthDeg": 60,
      "alpha": 9,
      "beta": 4,
      "evoOffsetDeg": 140,
      "cycleAsymmetry": 0.1
    },
    "headersM": [
      0.55,
      0.55,
      0.643,
      0.643,
      0.585,
      0.585,
      0.678,
      0.678
    ],
    "collectors": [
      {
        "banks": [
          0
        ],
        "lengthM": 0.35
      },
      {
        "banks": [
          1
        ],
        "lengthM": 0.35
      }
    ],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.4,
      "mufflerSectionsM": [
        0.21,
        0.34,
        0.47
      ],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {
        "fitted": true,
        "openGainDb": 4
      }
    },
    "intake": {
      "runnerM": 0.3,
      "helmholtzHz": 160,
      "gain": 0.4
    },
    "forcedInduction": null,
    "mechanical": {
      "blockGain": 0.3,
      "valvetrainGain": 0.1
    },
    "overrun": {
      "crackleRate": 0.5,
      "fuelCutResumeRpm": 1200
    },
    "cabin": {
      "lowpassHz": 600
    },
    "launchRpm": 4125,
    "estimated": true
  }
}
```

- [ ] **Step 4: Create `rotary-twin-13` (researched for this plan)**

Variant: 1993 US Mazda RX-7 (FD), all numbers from Mazda Motor of America's 1993 RX-7 brochure (part no. 9999-92-020R-93, archived scan on archive.org, specifications page): 2-rotor 1,308 cc, sequential twin turbochargers, 255 hp at 6,500 rpm, 5-speed manual 3.48/2.02/1.39/1.00/0.72 with final drive 4.10, P225/50ZR16 (R-1), "9000-rpm tachometer with 8000-rpm redline". `cycleDeg` 1080: rotor 1 faces at 0/360/720, rotor 2 (180° e-shaft offset) at 180/540/900 → `firingHz(6000, 6, 1080)` = 200 Hz. Voicing = `defaultVoicing(spec)` (rotary pulse width 260°, one header length per rotor).

Create `src/data/engines/rotary-twin-13.json`:

```json
{
  "id": "rotary-twin-13",
  "name": "1.3 Twin-Rotor Turbo Rotary",
  "inspiredBy": "Mazda RX-7 (FD, 13B-REW)",
  "set": "jdm",
  "notes": "Variant: 1993 US-market Mazda RX-7 (FD, 13B-REW 1,308 cc, 255 hp at 6,500 rpm) with the 5-speed manual (3.48/2.02/1.39/1.00/0.72, final drive 4.10, as printed to two decimals in Mazda's brochure) on P225/50ZR16 tyres (R-1; base P225/50R16 is the same size). cycleDeg 1080 (eccentric-shaft degrees): each rotor face fires once per three e-shaft revolutions; rotor 1 faces at 0/360/720, rotor 2 offset 180 deg at 180/540/900, so firings fall every 180 deg (2 per e-shaft rev). Both rotors' exhaust ports are treated as one exhaust bank (they merge in the turbo manifold); revisit in the Sound Lab. Sequential twin turbochargers (primary from low rpm, secondary in the upper range). Redline 8,000 rpm (manual; 7,000 with the automatic). Estimated (not published in the sources used): idle 750 rpm, fuel-cut limiter at 8,000 rpm with 200 rpm hysteresis, manual shift time 0.30 s. No EPA N/V row is used: the 1993-1995 EPA test car files are PKZIP-imploded archives not read here.",
  "spec": {
    "layout": {
      "type": "rotary",
      "bankAngleDeg": 0,
      "crank": "n/a",
      "displacementL": 1.308
    },
    "cycleDeg": 1080,
    "combustion": [
      {
        "angleDeg": 0,
        "bank": 0
      },
      {
        "angleDeg": 180,
        "bank": 0
      },
      {
        "angleDeg": 360,
        "bank": 0
      },
      {
        "angleDeg": 540,
        "bank": 0
      },
      {
        "angleDeg": 720,
        "bank": 0
      },
      {
        "angleDeg": 900,
        "bank": 0
      }
    ],
    "rpm": {
      "idle": 750,
      "redline": 8000,
      "limiter": {
        "type": "fuel-hard",
        "rpm": 8000,
        "hysteresisRpm": 200
      }
    },
    "aspiration": {
      "type": "turbo",
      "turbo": {
        "count": 2,
        "layout": "sequential"
      },
      "supercharger": null
    },
    "gearbox": {
      "type": "manual",
      "overallRatios": [
        14.268,
        8.282,
        5.699,
        4.1,
        2.952
      ],
      "drivenTyre": "225/50ZR16",
      "shiftTimeS": 0.3,
      "tc": null
    },
    "sources": {
      "layout": [
        "Mazda Motor of America, 1993 Mazda RX-7 brochure, part no. 9999-92-020R-93, Specifications page (2-rotor inline rotary, 1308 cc): https://archive.org/details/1993-mazda-rx-7-brochure.-usa-9-1992.-part-no.-9999-92-020-r-93-01"
      ],
      "combustion": [
        "Wankel cycle: each rotor face completes one four-stroke cycle per three eccentric-shaft revolutions (1080 deg); two rotors phased 180 deg apart (first principles; Wikipedia, Wankel engine, last resort): https://en.wikipedia.org/wiki/Wankel_engine",
        "Mazda Motor of America, 1993 Mazda RX-7 brochure (2-rotor): https://archive.org/details/1993-mazda-rx-7-brochure.-usa-9-1992.-part-no.-9999-92-020-r-93-01"
      ],
      "rpm": [
        "Mazda Motor of America, 1993 Mazda RX-7 brochure, Interior Standard Features ('9000-rpm tachometer with 8000-rpm redline', footnote: 7000-rpm redline with automatic transmission): https://archive.org/details/1993-mazda-rx-7-brochure.-usa-9-1992.-part-no.-9999-92-020-r-93-01"
      ],
      "aspiration": [
        "Mazda Motor of America, 1993 Mazda RX-7 brochure ('Sequential twin turbochargers with air-to-air intercooler'): https://archive.org/details/1993-mazda-rx-7-brochure.-usa-9-1992.-part-no.-9999-92-020-r-93-01"
      ],
      "gearbox": [
        "Mazda Motor of America, 1993 Mazda RX-7 brochure, Transmission (manual 3.48/2.02/1.39/1.00/0.72, final drive 4.10) and Chassis (P225/50R16 91V; P225/50ZR16 R-1 Package): https://archive.org/details/1993-mazda-rx-7-brochure.-usa-9-1992.-part-no.-9999-92-020-r-93-01"
      ]
    }
  },
  "voicing": {
    "pulse": {
      "widthDeg": 260,
      "alpha": 9,
      "beta": 4,
      "evoOffsetDeg": 140,
      "cycleAsymmetry": 0.1
    },
    "headersM": [
      0.55,
      0.643,
      0.55,
      0.643,
      0.55,
      0.643
    ],
    "collectors": [
      {
        "banks": [
          0
        ],
        "lengthM": 0.35
      }
    ],
    "turbine": {
      "reflection": 0.45,
      "lpHz": 1500
    },
    "exhaust": {
      "midPipeM": 1.4,
      "mufflerSectionsM": [
        0.21,
        0.34,
        0.47
      ],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {
        "fitted": true,
        "openGainDb": 4
      }
    },
    "intake": {
      "runnerM": 0.3,
      "helmholtzHz": 130,
      "gain": 0.4
    },
    "forcedInduction": {
      "spoolTimeS": 0.6,
      "maxShaftKrpm": 180,
      "lift": "bov",
      "cabinGainDb": -14
    },
    "mechanical": {
      "blockGain": 0.3,
      "valvetrainGain": 0.1
    },
    "overrun": {
      "crackleRate": 0.5,
      "fuelCutResumeRpm": 1250
    },
    "cabin": {
      "lowpassHz": 600
    },
    "launchRpm": 3600,
    "estimated": true
  }
}
```

- [ ] **Step 5: Create `v10-na-48` (researched for this plan)**

Variant: Lexus LFA, all gearbox numbers from Lexus's own UK media release "GAZOO Racing Lexus LFA" (Toyota (GB) PLC, 20 June 2012), whose "LEXUS LFA TECHNICAL SPECIFICATIONS" table (road car: 265/35R20 + 305/30R20 tyres, 1,480–1,580 kg) lists: naturally aspirated 4,805 cc V10, 552 bhp at 8,700 rpm, max. engine speed 9,000 rpm, 6-speed ASG, **front counter gear ratio 1.259**, gear ratios 3.231/2.188/1.609/1.233/0.970/0.795, final drive 3.417, maximum permissible speed 52/76/104/136/172/202 mph in gears 1–6, "an upshift can be made in just 0.2 seconds". Planning finding: the counter gear is in series — overall = gear × 1.259 × 3.417 reproduces Lexus's per-gear speeds within 2.5 % (gear 1: 50.8 vs 52 mph), while gear × 3.417 alone would put gear 1 at 64 mph. The EPA 2012 LFA row (axle 3.42, N/V 34.4) matches gear × final drive WITHOUT the counter gear (model with it: 43.6), so it is screened out (comment above `EPA_NV`) and the `MAKER_GEAR_SPEEDS` row guards the ratios instead. 72° vee (Lexus UK Magazine) with even 72° firing (first principles), banks alternating. Voicing = `defaultVoicing(spec)`.

Create `src/data/engines/v10-na-48.json`:

```json
{
  "id": "v10-na-48",
  "name": "4.8 V10 NA",
  "inspiredBy": "Lexus LFA",
  "set": "exotic",
  "notes": "Variant: Lexus LFA (2010-2012, 1LR-GUE 4,805 cc, 412 kW / 552 bhp at 8,700 rpm, 9,000 rpm maximum engine speed) with the 6-speed ASG automated sequential gearbox, rear transaxle, on the standard rear 305/30ZR20 tyre (driven axle). Layout: 72-degree V10; with five common crankpins 72 degrees apart a 72-degree vee fires every 720/10 = 72 degrees, banks strictly alternating (first principles; the 72-degree angle is from Lexus, the even interval is derived - no Lexus document seen states the crankpin arrangement). Bank 0 = the bank whose cylinder fires first; Toyota's cylinder numbering is not needed for angle/bank data. Gearbox: Lexus UK's technical specifications list a FRONT COUNTER GEAR ratio of 1.259 in series with the gear ratios 3.231/2.188/1.609/1.233/0.970/0.795 and the 3.417 final drive, so overall ratio = gear x 1.259 x 3.417 (= gear x 4.302003). Lexus's own 'maximum permissible speed' per gear at the 9,000 rpm limit (52/76/104/136/172 mph in gears 1-5) is reproduced within 2.5 % only WITH the counter gear (without it gear 1 would reach 64 mph) - checked in tests/unit/engines.test.ts (MAKER_GEAR_SPEEDS). The EPA 2012 Test Car List row (axle 3.42, N/V 34.4) equals 6th x final drive WITHOUT the counter gear (model with counter gear: 43.6 rpm/mph), so it is screened out of the EPA N/V check as inconsistent with the manufacturer's gear-speed table. shiftTimeS 0.20 s = Lexus's quickest ASG upshift ('upshift speeds down to 0.2 seconds'; seven selectable shift speeds). Estimated (not published in the sources used): idle 900 rpm; limiter type fuel-soft at the published 9,000 rpm maximum engine speed with 150 rpm hysteresis.",
  "spec": {
    "layout": {
      "type": "v",
      "bankAngleDeg": 72,
      "crank": "n/a",
      "displacementL": 4.805
    },
    "cycleDeg": 720,
    "combustion": [
      {
        "angleDeg": 0,
        "bank": 0
      },
      {
        "angleDeg": 72,
        "bank": 1
      },
      {
        "angleDeg": 144,
        "bank": 0
      },
      {
        "angleDeg": 216,
        "bank": 1
      },
      {
        "angleDeg": 288,
        "bank": 0
      },
      {
        "angleDeg": 360,
        "bank": 1
      },
      {
        "angleDeg": 432,
        "bank": 0
      },
      {
        "angleDeg": 504,
        "bank": 1
      },
      {
        "angleDeg": 576,
        "bank": 0
      },
      {
        "angleDeg": 648,
        "bank": 1
      }
    ],
    "rpm": {
      "idle": 900,
      "redline": 9000,
      "limiter": {
        "type": "fuel-soft",
        "rpm": 9000,
        "hysteresisRpm": 150
      }
    },
    "aspiration": {
      "type": "na",
      "turbo": null,
      "supercharger": null
    },
    "gearbox": {
      "type": "amt",
      "overallRatios": [
        13.8998,
        9.4128,
        6.9219,
        5.3044,
        4.1729,
        3.4201
      ],
      "drivenTyre": "305/30ZR20",
      "shiftTimeS": 0.2,
      "tc": null
    },
    "sources": {
      "layout": [
        "Lexus UK media site (Toyota (GB) PLC), 'GAZOO Racing Lexus LFA', 20 June 2012, LEXUS LFA TECHNICAL SPECIFICATIONS (Engine type listed as '1LR-GSE' - Toyota's 2009 release names the engine 1LR-GUE; V10; 40-valve DOHC; 4,805 cc; 88.0 x 79.0 mm; 'naturally aspirated V10'): https://media.lexus.co.uk/gazoo-racing-lexus-lfa/",
        "Lexus UK Magazine (Toyota (GB) PLC), 'A closer look inside the Lexus LFA's V10' (archived 2021-05-11; 1LR-GUE; 'The 72 deg angle between each bank of cylinders ... optimum point for balancing the primary and secondary movements'): http://web.archive.org/web/20210511163932/https://mag.lexus.co.uk/a-closer-look-inside-the-lfas-v10/",
        "Toyota Motor Corporation, 'Lexus Debuts LFA', 21 Oct 2009, main specifications (1LR-GUE / 4,805 cc; V10 gasoline engine DOHC; 412 kW / 8,700 rpm): https://global.toyota/en/detail/308263"
      ],
      "combustion": [
        "Lexus UK Magazine (Toyota (GB) PLC), 'A closer look inside the Lexus LFA's V10' (72 deg bank angle): http://web.archive.org/web/20210511163932/https://mag.lexus.co.uk/a-closer-look-inside-the-lfas-v10/",
        "Four-stroke V10 with a 72 deg vee and common crankpins spaced 72 deg: firing every 720/10 = 72 deg, banks alternating (first principles)"
      ],
      "rpm": [
        "Lexus UK media site (Toyota (GB) PLC), 'GAZOO Racing Lexus LFA', 20 June 2012, technical specifications (Max. power 552 bhp @ 8,700 rpm; Max. engine speed 9,000 rpm; '9,000rpm red line'): https://media.lexus.co.uk/gazoo-racing-lexus-lfa/",
        "Toyota Motor Corporation, 'Lexus Debuts LFA', 21 Oct 2009 ('right up to the 9,000rpm redline'): https://global.toyota/en/detail/308263"
      ],
      "aspiration": [
        "Lexus UK media site (Toyota (GB) PLC), 'GAZOO Racing Lexus LFA', 20 June 2012 ('a bespoke, high-revving 552bhp 4.8-litre naturally aspirated V10 engine'): https://media.lexus.co.uk/gazoo-racing-lexus-lfa/"
      ],
      "gearbox": [
        "Lexus UK media site (Toyota (GB) PLC), 'GAZOO Racing Lexus LFA', 20 June 2012, technical specifications (6-speed Automated Sequential Gearbox; front counter gear ratio 1.259; gear ratios 3.231/2.188/1.609/1.233/0.970/0.795; final drive ratio 3.417; maximum permissible speed 52/76/104/136/172/202 mph in gears 1-6; tyres 265/35R20 95Y front, 305/30R20 99Y rear; 'an upshift can be made in just 0.2 seconds'): https://media.lexus.co.uk/gazoo-racing-lexus-lfa/",
        "Toyota Motor Corporation, 'Lexus Debuts LFA', 21 Oct 2009 (six-speed ASG, rear transaxle; 'upshift speeds down to 0.2 seconds'; tyres front 265/35ZR20 (95Y), rear 305/30ZR20 (99Y)): https://global.toyota/en/detail/308263",
        "US EPA 2012 Test Car List, Lexus LFA (axle ratio 3.42, N/V 34.4 - excludes the front counter gear; screened out, see notes): https://www.epa.gov/sites/default/files/2016-07/12tstcar.csv"
      ]
    }
  },
  "voicing": {
    "pulse": {
      "widthDeg": 60,
      "alpha": 9,
      "beta": 4,
      "evoOffsetDeg": 140,
      "cycleAsymmetry": 0.1
    },
    "headersM": [
      0.55,
      0.55,
      0.643,
      0.643,
      0.585,
      0.585,
      0.678,
      0.678,
      0.621,
      0.621
    ],
    "collectors": [
      {
        "banks": [
          0
        ],
        "lengthM": 0.35
      },
      {
        "banks": [
          1
        ],
        "lengthM": 0.35
      }
    ],
    "turbine": null,
    "exhaust": {
      "midPipeM": 1.4,
      "mufflerSectionsM": [
        0.21,
        0.34,
        0.47
      ],
      "mufflerAction": 0.6,
      "tailpipeM": 0.5,
      "valve": {
        "fitted": true,
        "openGainDb": 4
      }
    },
    "intake": {
      "runnerM": 0.3,
      "helmholtzHz": 170,
      "gain": 0.4
    },
    "forcedInduction": null,
    "mechanical": {
      "blockGain": 0.3,
      "valvetrainGain": 0.1
    },
    "overrun": {
      "crackleRate": 0.5,
      "fuelCutResumeRpm": 1400
    },
    "cabin": {
      "lowpassHz": 600
    },
    "launchRpm": 4950,
    "estimated": true
  }
}
```

- [ ] **Step 6: Add the three engines to the index (interim, §5.5 order)**

Replace `src/data/engines/index.ts` with:

```ts
import type { EngineDef } from '../../contracts';
import i5Turbo25 from './i5-turbo-25.json';
import rotaryTwin13 from './rotary-twin-13.json';
import v8Na50 from './v8-na-50.json';
import v10Na48 from './v10-na-48.json';

/** JSON imports widen literal unions to string; engine.schema.json (tests) is the real guard. */
function def(json: unknown): EngineDef {
  return json as EngineDef;
}

/** Starter garage, in spec §5.5 order (the remaining engines are inserted at their §5.5 positions). */
export const ENGINES: EngineDef[] = [def(i5Turbo25), def(rotaryTwin13), def(v8Na50), def(v10Na48)];

export function getEngine(id: string): EngineDef {
  const found = ENGINES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`Unknown engine id "${id}"`);
  }
  return found;
}
```

- [ ] **Step 7: Run the per-engine checks for the three new engines**

Run: `npx vitest run tests/unit/engines.test.ts -t "v8-na-50|rotary-twin-13|v10-na-48"`
Expected: PASS — `32 passed | 15 skipped (47)` (10 per engine, the `v8-na-50` N/V row: computed 28.30 vs EPA 28.3, and the `v10-na-48` gear-speed row: computed 50.8/75.1/102.1/133.2/169.3 mph vs 52/76/104/136/172). A full-file run fails only the garage-list and firing-frequency tests (`2 failed | 45 passed`), because the I4 and the other engines are not compiled yet.

- [ ] **Step 8: Read the engine compilation procedure (reference for Steps 9–19)**

Each of Steps 9–19 compiles ONE engine and is executed by a research agent following these rules exactly. The agents run in parallel (plan header, wave W3) in one shared working tree, so an agent writes exactly one repository file — its own `src/data/engines/<id>.json`, once and complete (rule 9) — and never edits a shared file (`src/data/engines/index.ts`, `tests/unit/engines.test.ts`). Everything else goes into the agent's report; the coordinator (the Task 10 implementer) merges the reports in Step 20 after every agent has finished.

1. **Variant.** Use the variant named in the step unless its gearbox data cannot be primary-sourced; then choose another documented variant of the same car/engine and say so in `notes` (contract rule). `name`, `inspiredBy`, `set` are fixed by the `GARAGE` table (spec §5.5) — never change them.
2. **Sources** (`spec.sources`, ≥ 1 per group `layout`, `combustion`, `rpm`, `aspiration`, `gearbox`). Format each entry `"<publisher>, <document and date> (<the facts it states>): <URL>"`. Order of preference: manufacturer technical data / press kit / brochure / owner's or workshop manual (archive.org scans and Wayback copies of manufacturer pages count as the manufacturer document), homologation/EPA filings, then Wikipedia as last resort (label it "(last resort)"). Derivations cite "(first principles)". Forbidden: rupteur.app and anything referencing it; bulk extraction from a specs database (aggregators may only lead you to the primary).
3. **Layout.** `type`; `bankAngleDeg` (0 inline/rotary, 180 flat, V angle otherwise); `crank` (`cross-plane`/`flat-plane` only for V8s, else `n/a`); `displacementL` = cc / 1000 (3 decimals).
4. **Combustion** (entries in FIRING ORDER, one per cylinder): angle of the k-th firing = sum of the preceding firing intervals; even fire → k·720/n. Shared-crankpin V engines alternate the bank angle and (144 − bank angle): a 90° V10 with common pins fires 90/54/90/54… → 0, 90, 144, 234, 288, 378, 432, 522, 576, 666. `bank` from the manufacturer's cylinder numbering (state in `notes` which bank is 0). Angles must be distinct and in [0, 720).
5. **RPM.** `redline` = manufacturer redline / max engine speed; `idle` = published value, else an estimate (650–900) flagged in `notes`; `limiter.rpm` ≥ redline (= published max engine speed if any), `limiter.type` and `hysteresisRpm` (100–200) are estimates unless documented — flag them.
6. **Aspiration.** `turbo: { count, layout: 'single' | 'parallel' | 'sequential' }` or `supercharger: { kind, pulleyRatio (crank → blower drive ratio), gearRatio (internal step-up, 1 if none), lobes (roots: lobes per rotor; twin-screw: male rotor lobes) }`; the other block `null`.
7. **Gearbox.** `overallRatios[i]` = gear i ratio × the final drive that gear uses × every other fixed gear stage in series (front counter / drop / transfer gears — e.g. the LFA's 1.259 front counter gear, Step 5), rounded to 4 decimals, strictly descending, forward gears only. Dual-final-drive DCTs (VW/Audi DQ-family, R8/Huracán) need the per-gear mapping from a primary document. `drivenTyre`: the axle the gearbox final drive turns — front for transverse FWD/Haldex AWD, rear for RWD and longitudinal AWD; write the ISO code without spaces (`"305/30ZR20"`). `shiftTimeS`: documented value, else type default DCT/PDK 0.10, TC auto 0.20, manual 0.30, AMT 0.20 (flag). `tc` only for `tc-auto`: `{ stallRpmWot (estimate 2200–3000), lockupTurbineRpm (estimate 1100–1500), couplingSR (0.88–0.92) }`, flagged as estimates.
8. **Notes.** Variant (car, model years, market, gearbox, axle, tyre), cylinder→bank mapping, every estimate, every conflict between sources, and any substitution.
9. **Voicing.** Draft the JSON with `spec` complete and no `voicing` key in your own scratch directory — never in `src/data/engines/` (the Task 5 and Task 8 `import.meta.glob` sweeps read every `*.json` there, and other agents run them). Then fill `voicing` with `defaultVoicing(spec)` and write `src/data/engines/<id>.json` once, complete (replace `<id>` and `<draft>`; the file is written under a temporary name outside the glob and renamed, so no reader ever sees a partial engine):

   ```bash
   ENGINE=<id> DRAFT=<draft> npx tsx -e "
   import { readFileSync, renameSync, writeFileSync } from 'node:fs';
   import { defaultVoicing } from './src/data/voicing-defaults.ts';
   const def = JSON.parse(readFileSync(process.env.DRAFT, 'utf8'));
   if (def.id !== process.env.ENGINE) throw new Error('draft id ' + def.id + ' is not ' + process.env.ENGINE);
   def.voicing = defaultVoicing(def.spec);
   const path = 'src/data/engines/' + process.env.ENGINE + '.json';
   writeFileSync(path + '.tmp', JSON.stringify(def, null, 2) + '\n');
   renameSync(path + '.tmp', path);
   console.log('engine written to ' + path);
   "
   ```

   To correct the data later, edit the draft and run the command again (never hand-edit the voicing).

10. **EPA N/V.** If the chosen variant matches a row of a US EPA Test Car List (same top gear and axle ratio), put the proposed `EPA_NV` row `{ id, nv, gear, doc }` in your report (`gear` = top gear; if only the 1:1 gear reproduces the row — 40 CFR 86.1803-01 allows it — use that gear and say so in `doc`). Do not edit `tests/unit/engines.test.ts`: the coordinator appends every reported row in Step 20. Lists: https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy (`*.xlsx` 2017–2026, `*tstcar.csv` 2000–2016; 1984–1999 are PKZIP-imploded zips — extract with `7z x` if available, otherwise skip and say so). Query a downloaded file (`pip install --user openpyxl` once for xlsx):

   ```bash
   python3 - FILE MAKE MODEL_REGEX <<'EOF'
   import csv, re, sys
   path, make, model_re = sys.argv[1], sys.argv[2].lower(), re.compile(sys.argv[3], re.I)
   if path.endswith('.csv'):
       rows = list(csv.DictReader(open(path, newline='', encoding='latin-1')))
   else:
       import openpyxl
       ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
       it = ws.iter_rows(values_only=True)
       header = [str(h).strip() if h is not None else '' for h in next(it)]
       rows = [dict(zip(header, r)) for r in it]
   cols = ['Model Year', 'Represented Test Veh Model', 'Test Vehicle ID', 'Rated Horsepower', '# of Gears',
           'Drive System Description', 'Equivalent Test Weight (lbs.)', 'Axle Ratio', 'N/V Ratio',
           'Target Coef A (lbf)', 'Target Coef B (lbf/mph)', 'Target Coef C (lbf/mph**2)']
   seen = set()
   for r in rows:
       r = {str(k).strip(): v for k, v in r.items() if k is not None}
       if make not in (str(r.get('Vehicle Manufacturer Name', '')) + ' ' + str(r.get('Represented Test Veh Make', ''))).lower(): continue
       if not model_re.search(str(r.get('Represented Test Veh Model', ''))): continue
       line = ' | '.join(str(r.get(c)) for c in cols)
       if line not in seen:
           seen.add(line)
           print(line)
   EOF
   ```

   The make filter checks both `Vehicle Manufacturer Name` and `Represented Test Veh Make` (some older files put the model name in the make column, e.g. the 2013 Model S rows). Compute your engine's N/V per gear (and, with `RPM` > 0, the speed per gear at that engine speed for rule 10b) with the same model as `tests/unit/engines.test.ts`:

   ```bash
   ENGINE=<id> RPM=0 npx tsx -e "
   import { readFileSync } from 'node:fs';
   import { rollingCircumferenceM, wheelRpm } from './src/sim/tyre.ts';
   const s = JSON.parse(readFileSync('src/data/engines/' + process.env.ENGINE + '.json', 'utf8')).spec;
   const c = rollingCircumferenceM(s.gearbox.drivenTyre);
   const rpm = Number(process.env.RPM ?? 0);
   s.gearbox.overallRatios.forEach((r, i) => {
     const nv = wheelRpm(0.44704, r, c);
     console.log('gear ' + (i + 1) + ': N/V ' + nv.toFixed(2) + ' rpm/mph' + (rpm > 0 ? ', ' + (rpm / nv).toFixed(1) + ' mph at ' + rpm + ' rpm' : ''));
   });
   "
   ```

   If the computed N/V misses ±2.5 %, first re-check the driven tyre, the final-drive mapping and any extra gear stage; never loosen the tolerance. If an EPA row contradicts a manufacturer per-gear speed table (rule 10b), the manufacturer table wins: leave the row out, say so in `notes` and in your report (the coordinator adds the line to the comment above `EPA_NV`, as done for `v10-na-48`).
10b. **Manufacturer speed per gear.** If a manufacturer document gives the maximum speed in each gear at a stated engine speed, put the proposed `MAKER_GEAR_SPEEDS` row `{ id, rpm, mphByGear, doc }` in your report (convert km/h to mph by ÷ 1.609344; omit a gear whose figure is the car's drag-limited top speed rather than its redline speed); check it first with the rule-10 command (`RPM=<rpm>`, ±2.5 % per gear). Do not edit `tests/unit/engines.test.ts`.
11. **Index.** Do not edit `src/data/engines/index.ts` — Step 20 writes the final index once every engine exists.
12. **Verify.** `npx vitest run tests/unit/shift-map.test.ts -t "<id>"` (it globs every engine JSON: the two `shift-map invariants: <id>` tests must pass), then validate your file against the engine schema:

   ```bash
   ENGINE=<id> npx tsx -e "
   import { readFileSync } from 'node:fs';
   import Ajv2020 from 'ajv/dist/2020';
   const schema = JSON.parse(readFileSync('src/data/schema/engine.schema.json', 'utf8'));
   const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
   const def = JSON.parse(readFileSync('src/data/engines/' + process.env.ENGINE + '.json', 'utf8'));
   console.log(validate(def) ? 'valid' : JSON.stringify(validate.errors, null, 2));
   "
   ```

   Expected: `valid`. Report: the engine id; the variant, estimates and source conflicts (as in `notes`); the proposed `EPA_NV` / `MAKER_GEAR_SPEEDS` rows, each with its `doc` and the computed value(s); any EPA row screened out and why. After all agents finish, the coordinator applies Step 20 (final index + the reported rows), runs Step 21 and returns any failure to the owning agent — who fixes the data (draft + rule 9 again), never the assertions.

- [ ] **Step 9: Compile `flat6-na-40` — "4.0 Flat-Six NA", inspired by Porsche 911 GT3 (992), set `euro`**

Variant: 992.2 GT3 with 7-speed PDK. Primary: Porsche technical data "911 GT3 PDK" (MY S, 10/2024) https://newsroom.porsche.com/dam/jcr:ca1882c7-1588-4a2e-995c-fe19ef1281fc/pag-911-gt3-pdk-en.pdf — expected content to verify (phase research, topic `drivetrain`): 3,996 cc, 375 kW at 8,500 rpm, max 9,000 rpm, PDK 3.75/2.38/1.72/1.34/1.11/0.96/0.84, rear axle 4.54, tyres 255/35 ZR20 | 315/30 ZR21 (driven: rear `315/30ZR21`). Layout `flat`, 180°, NA. Firing order 1-6-2-4-3-5 (verify in a Porsche document, plus Porsche's bank numbering: 1–3 one bank, 4–6 the other) → even 120°, banks alternate. Gearbox type `pdk`, `shiftTimeS` 0.10. EPA (read while planning, all 992.1): MY2024 "911 GT3 Touring" 7 gears, axle 4.19, N/V 43.0; MY2024 "911 GT3" 6 gears (manual), axle 3.96, N/V 43.0. Report an `EPA_NV` row only if the chosen variant uses that axle (e.g. switch to the 992.1 US PDK with a primary source for its ratios and 4.19 final drive: 0.84 × 4.19 on 315/30ZR21 gives 42.9); otherwise write in `notes` "EPA rows are for the 992.1 (axle 4.19 PDK / 3.96 manual); no N/V row". Then follow rules 9–12.

- [ ] **Step 10: Compile `v10-na-52` — "5.2 V10 NA", inspired by Lamborghini Huracán, set `euro`**

Firing intervals (the spec §5.5 open question) — settled while planning by a primary source: Audi MediaCenter, "The new Audi R8: updated dynamics for the high-performance sports car" → Engine (18 June 2019; the audi-mediacenter.com link now redirects to https://www.audi.com/en/the-new-audi-r8-updated-dynamics-for-the-high-performance-sports-car-11734/engine-11738): the 5.2 FSI "rods of the pistons on the opposite side engage with a shared crank pin, which results in alternating firing intervals of 54 and 90 degrees", "cylinder firing sequence of 1 – 6 – 5 – 10 – 2 – 7 – 3 – 8 – 4 – 9", "revs up to 8,700 rpm". Supporting (secondary): evo (2008) on the Gallardo LP560-4, which introduced this common-pin 5.2 (the earlier 5.0 used 18° split pins and even 72° firing). So: 90° V, odd fire 90/54 → angles 0, 90, 144, 234, 288, 378, 432, 522, 576, 666, banks alternating (Audi numbering: cylinders 1–5 = bank 0, 6–10 = bank 1; the firing sequence alternates banks). Cite the Audi page for `combustion` and a Lamborghini document (press kit / technical data: 5,204 cc V10, max power rpm, redline) confirming the Huracán uses the same 5.2 V10 for `layout`/`rpm`. Gear data: Lamborghini technical data for the Huracán (LP 610-4 / EVO, 7-speed LDF DCT) if it lists ratios and final drive(s) per gear; otherwise the documented variant = Audi R8 V10 (same 5.2 FSI and 7-speed S tronic family; say so in `notes`): Audi eTD R8 V10 Coupé quattro 419 kW lists OVERALL ratios 13.969/9.287/6.746/5.080/4.003/3.171/2.343 and tyres 245/35 R19 | 295/35 R19 — https://uploads.audi-mediacenter.com/system/production/car_motorizations/335/file_en/824cd6b831b620f3969a43e61549348b22b8d6e6/eTechnische_Daten_Audi_R8V10_Coupe_419kW.pdf; driven tyre rear (longitudinal AWD). Type `dct`, 0.10 s. EPA (read while planning): MY2024 "Huracan EVO Coupe" (AWD and RWD rows) 7 gears, axle 3.94, N/V 42.8 — compute with the chosen top gear; the R8 top gear (2.343 on 295/35R19) gives ≈ 29.9, i.e. no match → no `EPA_NV` row unless Huracán-specific ratios reproduce 42.8 within 2.5 % (say which in `notes`). Then rules 9–12.

- [ ] **Step 11: Compile `i4-turbo-20` — "2.0 Turbo Inline-4", inspired by VW Golf GTI (Mk8), set `euro`**

Engine: EA888 evo4 2.0 TSI, firing order 1-3-4-2 → 0/180/360/540, one bank, single turbo. Gearbox: 7-speed DSG (DQ381) — like the RS 3 it has TWO final drives: find a VW primary document (VW press-kit technical data, VW self-study programme for the DQ381) giving the per-gear mapping; driven tyre = front (FWD), e.g. `225/40R18` (use the standard tyre of the chosen variant). Type `dct`, 0.10 s ("DSG upshift fart" is the character to keep). If the per-gear mapping cannot be primary-sourced, use the documented variant 6-speed manual (type `manual`, single final drive) and say so. EPA (read while planning): MY2024 "GTI" 7 gears, axle 3.13, N/V 26.6; 6 gears (manual), axle 3.45, N/V 33.2. This engine provides the contract's I4 `firingHz` check (6000 rpm → 200 Hz). Then rules 9–12.

- [ ] **Step 12: Compile `i6-twinturbo-30` — "3.0 Twin-Turbo Inline-6", inspired by Toyota Supra (A80, 2JZ-GTE), set `jdm`**

Variant: US 1993–1998 Supra Turbo, 6-speed Getrag V160. Primary to find: Toyota Motor Sales USA Supra brochure (search archive.org, e.g. `https://archive.org/advancedsearch.php?q=supra+brochure+1994&fl[]=identifier&output=json` — the 1993 Mazda RX-7 brochure used in Step 4 came from the same kind of scan) or Toyota press material. Expected to verify: 2,997 cc 2JZ-GTE, sequential twin turbo (`count: 2, layout: 'sequential'`), 6MT 3.827/2.360/1.685/1.312/1.000/0.793, final drive 3.133 (US Turbo), rear tyre 255/40ZR17, redline 6,800. Firing order 1-5-3-6-2-4 → even 120°, one bank. Type `manual`, 0.30 s. EPA rows for 1993–1998 are in PKZIP-imploded archives (`93mftcl.zip` … `98tstcar.zip`): report an N/V row only if you can extract them. Then rules 9–12.

- [ ] **Step 13: Compile `flat4-turbo-25` — "2.5 Turbo Flat-Four", inspired by Subaru WRX STI (EJ257), set `jdm`**

Variant: US 2015–2021 WRX STI, 6-speed manual. Primary: Subaru of America press-release specifications / brochure. Expected to verify: 2,457 cc EJ257, single turbo, 6MT 3.636/2.375/1.761/1.346/0.971/0.756, final drive 3.900, tyres 245/35R19 for 2018+ (AWD, same front/rear: `245/35R19`), redline 6,700. Firing order 1-3-2-4 → 0/180/360/540; banks per Subaru numbering (verify which cylinders sit on each bank; with 1-3-2-4 two consecutive firings share a bank — that, plus the default unequal 0.45/0.75 headers, is the boxer rumble). Layout `flat`, 180°. Type `manual`, 0.30 s. EPA (read while planning): MY2021 "WRX STI" (310 hp, 6 gears; the drive-system field says "2-Wheel Drive, Front", an EPA data-entry quirk) axle 3.9, N/V 39.5 → report `{ id: 'flat4-turbo-25', nv: 39.5, gear: 6, … }` (model ≈ 39.67 on 245/35R19, +0.4 %). Then rules 9–12.

- [ ] **Step 14: Compile `v6-twinturbo-38` — "3.8 Twin-Turbo V6", inspired by Nissan GT-R (R35, VR38DETT), set `jdm`**

Variant: MY2017+ GT-R, GR6 6-speed DCT. Primary: Nissan press kit / NissanNews US specifications. Expected to verify: 3,799 cc, 60° V6, parallel twin turbo (`count: 2, layout: 'parallel'`), ratios 4.056/2.301/1.595/1.248/1.001/0.796, final drive 3.700, rear tyre `285/35ZR20` (rear transaxle, longitudinal AWD → rear), redline 7,000. Firing order 1-2-3-4-5-6 with odd/even cylinders on opposite banks (verify) → even 120°, banks alternate. Type `dct`, 0.10 s. EPA (read while planning): MY2021 and MY2024 "GT-R" (565 hp, 6 gears) axle 3.7, N/V 36.5 → report `{ id: 'v6-twinturbo-38', nv: 36.5, gear: 6, … }` (model ≈ 36.64, +0.4 %). Then rules 9–12.

- [ ] **Step 15: Compile `v8-na-62` — "6.2 Small-Block V8 NA", inspired by Chevrolet Corvette (C8, LT2), set `american`**

Variant: C8 Stingray (LT2), Tremec 8-speed DCT. Primary: GM/Chevrolet media specifications for the model year chosen (gear ratios and final drive; the base and Z51 final drives differ). Expected to verify: 6,162 cc pushrod cross-plane 90° V8, NA, rear tyre `305/30ZR20`, redline 6,600. GM Gen V firing order 1-8-7-2-6-5-4-3, GM numbering odd = left (driver) bank, even = right (verify) → 90° intervals. Type `dct`, 0.10 s. EPA (read while planning): MY2025 "CORVETTE" (495 hp, 8 gears): axle 5.17 → N/V 22.0, axle 4.89 → N/V 20.6 (MY2026: 4.89 → 20.6) — report the row matching the chosen final drive and top gear. Then rules 9–12.

- [ ] **Step 16: Compile `v8-sc-62` — "6.2 Supercharged V8", inspired by Dodge Challenger SRT Hellcat, set `american`**

Variant: 2015–2023 Challenger SRT Hellcat (707 hp, non-Widebody), TorqueFlite 8HP90 8-speed automatic. Primary: FCA/Stellantis media specifications. Expected to verify: 6,166 cc supercharged Hemi, 90° cross-plane; IHI 2.4 L twin-screw supercharger → `supercharger: { kind: 'twin-screw', pulleyRatio, gearRatio, lobes }` (drive ratio and male-rotor lobe count from SRT/IHI documents; if unpublished, estimate and flag); ratios 4.71/3.14/2.10/1.67/1.29/1.00/0.84/0.67, axle 2.62; rear tyre `275/40ZR20`; redline ≈ 6,200. Chrysler Hemi firing order 1-8-4-3-6-5-7-2, odd = left bank, even = right (verify) → 90°. Type `tc-auto`, 0.20 s, `tc` estimates flagged. EPA (read while planning; the 707-hp car is listed as "Challenger SRT8"): MY2021/MY2023 "Challenger SRT8" 707 hp, 8 gears, axle 2.62, N/V 21.1 (6-speed manual rows: axle 3.7, N/V 27.9–28.0; "Challenger SRT Widebody" 707 hp: 2.62, N/V 21.4) → report `{ id: 'v8-sc-62', nv: 21.1, gear: 8, … }` (model ≈ 21.22, +0.6 %). Then rules 9–12.

- [ ] **Step 17: Compile `v12-na-65` — "6.5 V12 NA", inspired by Ferrari 812 Superfast, set `exotic`**

Variant: 812 Superfast, 7-speed F1 DCT. Primary: Ferrari press kit / technical sheet (media.ferrari.com). Expected to verify: 6,496 cc F140 65° V12 NA, max 8,900 rpm, ratios and final drive from the press kit, rear tyre `315/35ZR20`. Even 60° firing; firing order and bank numbering from a Ferrari document (F140 family commonly 1-7-4-10-2-8-6-12-3-9-5-11 with 1–6 on one bank — verify) → banks alternate. Type `dct`, 0.10 s. EPA (read while planning): MY2021 "812 Superfast" (785 hp, 7 gears) axle 4.37, N/V 36.2 (screen the gear). Then rules 9–12.

- [ ] **Step 18: Compile `v8-flatplane-45` — "4.5 Flat-Plane V8", inspired by Ferrari 458 Italia, set `exotic`**

Variant: 458 Italia (2009–2015), 7-speed DCT. Primary: Ferrari 458 Italia press kit (2009). Expected to verify: 4,497 cc F136 FB 90° flat-plane V8 (`crank: 'flat-plane'`), redline 9,000, ratios + final drive from the press kit, rear tyre `295/35ZR20`. Flat-plane firing order 1-5-3-7-4-8-2-6 with Ferrari numbering (1–4 one bank, 5–8 the other — verify) → even 90°, banks strictly alternate. Type `dct`, 0.10 s. EPA (read while planning): MY2015 "458 Italia Spyder" (558 hp, 7 gears) axle 5.14, N/V 43.5 (screen: may be a non-top-gear report). Then rules 9–12.

- [ ] **Step 19: Compile `v8-twinturbo-40` — "4.0 Twin-Turbo V8", inspired by Audi RS 6 Avant (C8), set `exotic`**

Variant: RS 6 Avant (C8), 8-speed tiptronic (torque converter). Primary: Audi eTD for RS 6 Avant from audi-mediacenter.com (same document family as the RS 3 eTD). Expected to verify: 3,996 cc 4.0 TFSI, 90° cross-plane hot-V V8 with two turbochargers (`count: 2, layout: 'parallel'`), gear ratios + final drive, rear tyre (longitudinal quattro → rear; standard size of the chosen variant). Audi V8 firing order 1-5-4-8-6-3-7-2 with cylinders 1–4 on the right bank (verify) → 90°. Type `tc-auto`, 0.20 s, `tc` estimates flagged. EPA (read while planning): MY2024 "RS 6 Avant" (621 hp, 8 gears) axle 3.2, N/V 25.0 → report the row with gear 8 if the chosen final drive is 3.2. Then rules 9–12.

- [ ] **Step 20: Merge the research reports — final engine index and the reported N/V / gear-speed rows**

Run this step once, after every agent of Steps 9–19 has finished (the coordinator; no agent edits these two files). Replace `src/data/engines/index.ts` with:

```ts
import type { EngineDef } from '../../contracts';
import flat4Turbo25 from './flat4-turbo-25.json';
import flat6Na40 from './flat6-na-40.json';
import i4Turbo20 from './i4-turbo-20.json';
import i5Turbo25 from './i5-turbo-25.json';
import i6Twinturbo30 from './i6-twinturbo-30.json';
import rotaryTwin13 from './rotary-twin-13.json';
import v6Twinturbo38 from './v6-twinturbo-38.json';
import v8Flatplane45 from './v8-flatplane-45.json';
import v8Na50 from './v8-na-50.json';
import v8Na62 from './v8-na-62.json';
import v8Sc62 from './v8-sc-62.json';
import v8Twinturbo40 from './v8-twinturbo-40.json';
import v10Na48 from './v10-na-48.json';
import v10Na52 from './v10-na-52.json';
import v12Na65 from './v12-na-65.json';

/** JSON imports widen literal unions to string; engine.schema.json (tests) is the real guard. */
function def(json: unknown): EngineDef {
  return json as EngineDef;
}

/** Starter garage, in spec §5.5 order: euro, jdm, american, exotic. */
export const ENGINES: EngineDef[] = [
  def(i5Turbo25),
  def(flat6Na40),
  def(v10Na52),
  def(i4Turbo20),
  def(i6Twinturbo30),
  def(rotaryTwin13),
  def(flat4Turbo25),
  def(v6Twinturbo38),
  def(v8Na50),
  def(v8Na62),
  def(v8Sc62),
  def(v12Na65),
  def(v8Flatplane45),
  def(v10Na48),
  def(v8Twinturbo40),
];

export function getEngine(id: string): EngineDef {
  const found = ENGINES.find((e) => e.id === id);
  if (found === undefined) {
    throw new Error(`Unknown engine id "${id}"`);
  }
  return found;
}
```

Then append every row the agents reported to `EPA_NV` and `MAKER_GEAR_SPEEDS` in `tests/unit/engines.test.ts` (one object per row, with the agent's `doc`, in §5.5 engine order after the existing rows); for each EPA row an agent screened out, add one line to the comment above `EPA_NV` (as for `v10-na-48`).

- [ ] **Step 21: Run the complete engine test to verify everything passes**

Run: `npx vitest run tests/unit/engines.test.ts`
Expected: PASS — 2 catalogue tests + 150 per-engine tests (15 × 10) + one test per `EPA_NV` row (at least `i5-turbo-25`, `v8-na-50`, `flat4-turbo-25`, `v6-twinturbo-38`, `v8-sc-62`) + one test per `MAKER_GEAR_SPEEDS` row (at least `v10-na-48`) + 2 garage tests. Any failure → return it to the owning agent, who fixes the data (never the assertions).

Then run the Task 5 suite that sweeps every engine JSON via `import.meta.glob` (shift-map invariants in both drive modes): `npx vitest run tests/unit/shift-map.test.ts`
Expected: PASS — `Tests  50 passed (50)` (20 + 2 × 15). Any failure → the owning agent fixes the engine data, never the assertions. The SimCore per-engine sweep (one DEMO_PROFILE loop per engine in Auto and Manual: continuity, idle floor, limiter clamp; sim-core 52 = 22 + 2 × 15) runs in Task 8 Step 6, which follows this task.

- [ ] **Step 22: Confirm every engine's voicing equals the generated default**

```bash
npx tsx -e "
import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { defaultVoicing } from './src/data/voicing-defaults.ts';
const files = readdirSync('src/data/engines').filter((f) => f.endsWith('.json'));
const bad = files.filter((f) => {
  const d = JSON.parse(readFileSync('src/data/engines/' + f, 'utf8'));
  return !isDeepStrictEqual(d.voicing, defaultVoicing(d.spec));
});
console.log(files.length + ' engines, voicing mismatches: ' + JSON.stringify(bad));
"
```

Expected: `15 engines, voicing mismatches: []`.

- [ ] **Step 23: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no errors. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 11: Tesla catalogue — road-load sources, catalogue builder, catalogue access, full trim coverage

**Files:**
- Create: `tools/build-catalogue.ts`
- Create: `src/data/raw/roadload-src.json`
- Create: `src/data/teslas.json`
- Create (generated by the tool, committed): `src/data/roadload.json`, `src/data/tesla-params.json`
- Create: `src/data/catalogue.ts`
- Test: `tests/unit/build-catalogue.test.ts`
- Test: `tests/unit/catalogue.test.ts`

**Interfaces:**
- Consumes:
  - `src/contracts.ts`: `TeslaRecord`, `RoadLoadRecord`, `TeslaParams`, `G`, `OCCUPANT_KG`, `ETA_DRIVETRAIN`.
  - Task 1 `src/sim/epa.ts`: `interface EpaTarget { A_lbf: number; B_lbf_per_mph: number; C_lbf_per_mph2: number }`, `epaToSi(t: EpaTarget): { A_N: number; B_Nps_m: number; C_Ns2_m2: number }`.
  - Task 4 `src/sim/load.ts`: `roadForceN(p: TeslaParams, v: number): number`, `maxForceN(p: TeslaParams, v: number): number` (both used by `tools/build-catalogue.ts`'s `accelTimeS`), `rawLoad(p: TeslaParams, v: number, a: number): number` (catalogue test).
  - Task 7 `src/sim/demo.ts`: `DEMO_PROFILE: readonly { t: number; throttle: number; brake: number }[]`, `class DemoDriver { reset(): void; step(dtS: number, out: PedalCommand): void }`, `class PedalPhysics { configure(p: TeslaParams): void; reset(): void; step(throttle: number, brake: number, dtS: number): void; readonly v: number; readonly a: number }`, `interface PedalCommand { throttle: number; brake: number }`.
  - Task 9: `src/data/schema/tesla.schema.json` (whole `TeslaRecord[]` array), `src/data/schema/roadload.schema.json` (whole `RoadLoadRecord[]` array), ajv convention `new Ajv2020({ allErrors: true, strict: true })`.
- Produces:
  - `src/data/catalogue.ts`: `export const TESLAS: TeslaRecord[]`; `export const ROADLOAD: RoadLoadRecord[]`; `export function resolveTeslaParams(recordId: string, modeName?: string): TeslaParams` (default = LAST/quickest `accelModes` entry; throws `Error` on unknown record, unknown mode, unresolved ref or missing fitted params); `export function notListedParams(zeroTo100S: number, massKg: number, body: 'sedan' | 'suv' | 'truck'): TeslaParams` (throws `RangeError` on non-finite / ≤ 0 inputs).
  - `tools/build-catalogue.ts` (also imported by `tests/unit/build-catalogue.test.ts`): types `EpaRoadLoadSrc`, `DerivedRoadLoadSrc`, `RoadLoadSrc`, `FittedParams`, `FitResult`, `CatalogueBuild`, `CataloguePaths`; constants `AIR_DENSITY_KG_M3 = 1.2041`, `FIT_DT_S = 0.005`, `FIT_TOLERANCE_S = 0.01`, `ROLLOUT_S = 0.25`, `MPH60_MPS = 26.8224`, `KMH100_MPS = 27.7778`, `REPO_ROOT`; functions `roadLoadFromSrc(src): RoadLoadRecord`, `normalisedMassKg(r): number`, `targetSpeedMps(basis): number`, `targetTimeS(accel): number`, `accelTimeS(massKg, rl, fTracN, pEffW, targetMps): number`, `fitParams(r, rl): FitResult`, `buildCatalogue(teslas, src): CatalogueBuild`, `serialize(value): string`, `cataloguePaths(rootDir): CataloguePaths`, `generate(rootDir)`, `checkCatalogue(rootDir): string[]`, `main(argv, rootDir?): number`.
  - CLI: `npx tsx tools/build-catalogue.ts` (writes both generated files) and `npx tsx tools/build-catalogue.ts --check` (exit 1 and lists stale files if regenerating would change either file; exit 0 prints `Catalogue up to date.`).
  - `src/data/raw/roadload-src.json`: array of `RoadLoadSrc` — `{ ref, kind: 'epa', modelYear, testCarRow, ratedHp, etwLb, target: EpaTarget, file, note? }` or `{ ref, kind: 'derived', cdA_m2, crr, massKg, sources: string[], note? }`.
  - `src/data/tesla-params.json`: `Record<recordId, { massKg; fTracN; pEffW }>`; `src/data/roadload.json`: `RoadLoadRecord[]` sorted by `ref`.

Contract decisions made explicit here (the rollout rule and the unreachable-fit fallback are listed in the plan header's Concerns section, PC12; the other three restate amendments A5–A8):
- Rollout: `+0.25 s` whenever `rolloutSubtracted` is true, for either basis (Tesla EU also footnotes "mit abgezogenem Rollout" on 0–100 km/h figures).
- Traction bracket (contract A7): `F_trac ∈ [0.3, 1.3]·m·G` (Plaid needs ≈ 1.22 g). Unreachable fit (published time needs more than F_trac = 1.3·m·G even with 3× peak power): keep F_trac = 1.3·m·G and P_eff = peak, emit a warning, do not throw — no catalogue record is expected to be unreachable.
- WOT test "each accel mode at factor 1" is run on the quickest (factor 1) mode of every record; in Chill (0.5) a heavy slow truck legitimately exceeds 0.75 at 0.6× acceleration (Cybertruck RWD ≈ 0.754). The same run also asserts that the runtime force model reaches the target speed within 0.01 s of the builder's fit and within 0.02 s of the published time (a fit reported unreachable must instead be slower than published).
- Sensitivity "changes load by < 0.05 over DEMO_PROFILE" is asserted as the MEAN |Δload| over one profile loop: the per-sample maximum is inherently ≈ throttle × 10 % for a 10 % mass error (0.08–0.09 with real data, with or without re-fitting); means are ≤ 0.033 for every Highland/Juniper record and for extreme stand-ins (Plaid, Cyberbeast, Cybertruck RWD, 2013 S60, X P100D).
- Tesla EU "Leergewicht" equals the US curb mass (no driver), so EU-only figures use `massBasis: 'us-curb'` (+75 kg); the enum has no EU-curb value.

**Cross-task premises:**
- Task 1 `epaToSi` multiplies by `EPA_TO_SI` from `src/contracts.ts` (A 4.448222, B 9.9504, C 22.2583) and returns `{ A_N, B_Nps_m, C_Ns2_m2 }` — open `src/sim/epa.ts` and confirm field names.
- Task 4 `maxForceN = modeFactor · min(fTracN, eta·pEffW / max(v, 1))`, `roadForceN = A + B·v + C·v²`, `rawLoad` = clamp(F/maxForceN, 0, 1) for F ≥ 0 else max(F/(m·0.25·G), −1) — open `src/sim/load.ts` and confirm (the builder's `accelTimeS` integrates with `maxForceN`/`roadForceN`; the WOT test integrates the same contract formulas written out independently and compares to 0.01 s, and checks `rawLoad ≥ 0.95` along that run, so any deviation in `load.ts` shows up there).
- Task 7: the LAST `DEMO_PROFILE` keyframe's `t` is the loop length; `DemoDriver.step(dtS, out)` writes `out.throttle/out.brake`; after `PedalPhysics.step`, `.a` is the acceleration used for that step and `.v` ≥ 0 — open `src/sim/demo.ts` and confirm.
- Task 9 schemas validate whole arrays (`tesla.schema.json` → `teslas.json`, `roadload.schema.json` → `roadload.json`).
- `tsx` (Phase 0 devDependency) supports `node --import tsx <file.ts>` (used by the CLI test).
- Research rules: nothing from rupteur.app or any repo/app referencing it; no bulk extraction from a specs database (ev-database, evspecifications, auto-data … may only point to primary documents); Tesla pages are fetched as Wayback Machine snapshots (tesla.com returns 403 to scripts).

- [ ] **Step 1: Write the failing builder test**

Create `tests/unit/build-catalogue.test.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { G, type TeslaRecord } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';
import {
  accelTimeS,
  buildCatalogue,
  cataloguePaths,
  checkCatalogue,
  fitParams,
  main,
  normalisedMassKg,
  REPO_ROOT,
  roadLoadFromSrc,
  serialize,
  targetSpeedMps,
  targetTimeS,
  type DerivedRoadLoadSrc,
  type EpaRoadLoadSrc,
  type RoadLoadSrc,
} from '../../tools/build-catalogue';

const EPA_M3P: EpaRoadLoadSrc = {
  ref: 'fixture-m3p',
  kind: 'epa',
  modelYear: 2026,
  testCarRow: 'Model 3 Performance AWD',
  ratedHp: 510,
  etwLb: 4250,
  target: { A_lbf: 36.82, B_lbf_per_mph: 0.1386, C_lbf_per_mph2: 0.01545 },
  file: 'https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx',
};

const DERIVED: DerivedRoadLoadSrc = {
  ref: 'fixture-derived',
  kind: 'derived',
  cdA_m2: 0.6,
  crr: 0.009,
  massKg: 2000,
  sources: ['fixture'],
};

function record(overrides: Partial<TeslaRecord>): TeslaRecord {
  return {
    id: 'fixture-car',
    model: 'Model 3',
    generation: 'Fixture',
    years: [2024, 2026],
    trim: 'Fixture',
    markets: ['US'],
    massKg: 1800,
    massBasis: 'us-curb',
    peakPowerKw: 300,
    accel: { seconds: 4.2, basis: '0-60mph', rolloutSubtracted: false },
    accelModes: [
      { name: 'Chill', factor: 0.5 },
      { name: 'Standard', factor: 1 },
    ],
    roadLoadRef: 'fixture-m3p',
    subwooferDefault: true,
    mcu: ['amd'],
    supported: true,
    sources: { mass: ['f'], power: ['f'], accel: ['f'], audio: ['f'] },
    ...overrides,
  };
}

const RL = roadLoadFromSrc(EPA_M3P);

describe('roadLoadFromSrc', () => {
  it('converts EPA Target coefficients with epaToSi (hand-checked M3 Performance row)', () => {
    const si = epaToSi(EPA_M3P.target);
    expect(RL.A_N).toBeCloseTo(si.A_N, 2);
    expect(RL.B_Nps_m).toBeCloseTo(si.B_Nps_m, 4);
    expect(RL.C_Ns2_m2).toBeCloseTo(si.C_Ns2_m2, 5);
    // 36.82 lbf × 4.448222 = 163.78 N; 0.1386 × 9.9504 = 1.3791 N·s/m; 0.01545 × 22.2583 = 0.34389 N·s²/m²
    expect(RL).toMatchObject({ ref: 'fixture-m3p', A_N: 163.78, B_Nps_m: 1.3791, C_Ns2_m2: 0.34389 });
    expect(RL.source.startsWith('EPA 2026 Test Car List: Tesla Model 3 Performance AWD')).toBe(true);
  });

  it('derives A = Crr·m·G, B = 0, C = ½·ρ·CdA for derived rows', () => {
    const rl = roadLoadFromSrc(DERIVED);
    expect(rl.A_N).toBeCloseTo(0.009 * 2000 * G, 2);
    expect(rl.B_Nps_m).toBe(0);
    expect(rl.C_Ns2_m2).toBeCloseTo(0.5 * 1.2041 * 0.6, 5);
    expect(rl.source.startsWith('derived: CdA=0.6 m², Crr=0.009')).toBe(true);
  });
});

describe('fit inputs', () => {
  it('adds the 75 kg occupant only to us-curb masses', () => {
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'us-curb' }))).toBe(1875);
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'eu-unladen-incl-driver' }))).toBe(1800);
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'test-weight' }))).toBe(1800);
  });

  it('maps the accel basis to the target speed and adds 0.25 s for subtracted rollout', () => {
    expect(targetSpeedMps('0-60mph')).toBe(26.8224);
    expect(targetSpeedMps('0-100kmh')).toBe(27.7778);
    expect(targetTimeS({ seconds: 2.9, basis: '0-60mph', rolloutSubtracted: true })).toBeCloseTo(3.15, 12);
    expect(targetTimeS({ seconds: 3.5, basis: '0-100kmh', rolloutSubtracted: false })).toBe(3.5);
  });
});

describe('accelTimeS', () => {
  const NO_ROAD = { A_N: 0, B_Nps_m: 0, C_Ns2_m2: 0 };

  it('matches the closed form for constant force and no road load', () => {
    // 5000 N on 1000 kg = 5 m/s² → 26.8224 / 5 = 5.36448 s
    expect(accelTimeS(1000, NO_ROAD, 5000, 1e12, 26.8224)).toBeCloseTo(5.36448, 6);
  });

  it('is slower when power-limited and Infinity when the car cannot reach the target', () => {
    const tractionOnly = accelTimeS(1000, NO_ROAD, 5000, 1e12, 26.8224);
    expect(accelTimeS(1000, NO_ROAD, 5000, 60000, 26.8224)).toBeGreaterThan(tractionOnly);
    expect(accelTimeS(1000, { A_N: 6000, B_Nps_m: 0, C_Ns2_m2: 0 }, 5000, 1e12, 26.8224)).toBe(Infinity);
  });
});

describe('fitParams', () => {
  it('bisects F_trac to the published time when traction-limited (P_eff = peak)', () => {
    const r = record({});
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(true);
    expect(fit.massKg).toBe(1875);
    expect(fit.pEffW).toBe(300000);
    expect(fit.fTracN).toBeGreaterThan(0.3 * 1875 * G);
    expect(fit.fTracN).toBeLessThan(1.3 * 1875 * G);
    expect(Math.abs(fit.achievedS - 4.2)).toBeLessThanOrEqual(0.01);
  });

  it('fixes F_trac = 1.3·m·G and bisects P_eff when even the traction cap is too slow at peak power', () => {
    const r = record({ peakPowerKw: 150, accel: { seconds: 3.4, basis: '0-60mph', rolloutSubtracted: false } });
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(true);
    expect(fit.fTracN).toBeCloseTo(1.3 * 1875 * G, 1);
    expect(fit.pEffW).toBeGreaterThan(150000);
    expect(fit.pEffW).toBeLessThanOrEqual(450000);
    expect(Math.abs(fit.achievedS - 3.4)).toBeLessThanOrEqual(0.01);
  });

  it('keeps the cap and the published power when the time is unreachable (reached = false)', () => {
    // target 1.75 + 0.25 s rollout = 2.00 s; even 1.3·m·G with 3× power only reaches ≈ 2.13 s
    const r = record({ peakPowerKw: 760, accel: { seconds: 1.75, basis: '0-60mph', rolloutSubtracted: true } });
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(false);
    expect(fit.fTracN).toBeCloseTo(1.3 * 1875 * G, 1);
    expect(fit.pEffW).toBe(760000);
    expect(fit.achievedS).toBeGreaterThan(fit.targetS);
  });

  it('throws when even 0.3·m·G beats the published time (bad data)', () => {
    const r = record({ accel: { seconds: 15, basis: '0-60mph', rolloutSubtracted: false } });
    expect(() => fitParams(r, RL)).toThrow(/0\.3·m·G/);
  });
});

describe('buildCatalogue', () => {
  const SRC: RoadLoadSrc[] = [EPA_M3P, DERIVED];

  it('is deterministic and sorts road load by ref', () => {
    const teslas = [record({}), record({ id: 'fixture-b', roadLoadRef: 'fixture-derived' })];
    const a = buildCatalogue(teslas, SRC);
    const b = buildCatalogue(teslas, SRC);
    expect(serialize(a.roadload)).toBe(serialize(b.roadload));
    expect(serialize(a.params)).toBe(serialize(b.params));
    expect(a.roadload.map((x) => x.ref)).toEqual(['fixture-derived', 'fixture-m3p']);
    expect(Object.keys(a.params)).toEqual(['fixture-car', 'fixture-b']);
    expect(a.warnings).toEqual([]);
  });

  it('reports unreachable fits as warnings, not errors', () => {
    const r = record({ peakPowerKw: 760, accel: { seconds: 1.75, basis: '0-60mph', rolloutSubtracted: true } });
    const out = buildCatalogue([r], SRC);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/fixture-car/);
  });

  it('rejects duplicate refs, duplicate ids and unresolved roadLoadRefs', () => {
    expect(() => buildCatalogue([record({})], [EPA_M3P, EPA_M3P])).toThrow(/duplicate ref/);
    expect(() => buildCatalogue([record({}), record({})], SRC)).toThrow(/duplicate id/);
    expect(() => buildCatalogue([record({ roadLoadRef: 'nope' })], SRC)).toThrow(/not in roadload-src/);
  });
});

describe('generated files', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
    vi.restoreAllMocks();
  });

  it('are up to date (build-catalogue --check passes)', () => {
    expect(checkCatalogue(REPO_ROOT)).toEqual([]);
  });

  it('--check exits non-zero when a generated file is stale, and 0 after regenerating', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tmp = mkdtempSync(join(tmpdir(), 'tesbox-catalogue-'));
    const from = cataloguePaths(REPO_ROOT);
    const to = cataloguePaths(tmp);
    mkdirSync(join(tmp, 'src', 'data', 'raw'), { recursive: true });
    mkdirSync(join(tmp, 'src', 'data', 'schema'), { recursive: true });
    for (const key of ['teslas', 'src', 'roadload', 'params', 'teslaSchema', 'roadloadSchema'] as const) {
      copyFileSync(from[key], to[key]);
    }
    expect(main(['--check'], tmp)).toBe(0);
    writeFileSync(to.params, readFileSync(to.params, 'utf8').replace(/"pEffW": \d+/, '"pEffW": 1'));
    expect(checkCatalogue(tmp)).toEqual([to.params]);
    expect(main(['--check'], tmp)).toBe(1);
    expect(main([], tmp)).toBe(0);
    expect(main(['--check'], tmp)).toBe(0);
  });

  it('runs as a CLI: --check exits 0 on the committed catalogue', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'tools/build-catalogue.ts', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  }, 30000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/build-catalogue.test.ts`
Expected: FAIL — `Failed to resolve import "../../tools/build-catalogue"`.

- [ ] **Step 3: Implement the catalogue builder**

Create `tools/build-catalogue.ts`:

```ts
/**
 * Tesla catalogue builder (phase-1 contract, T11).
 *
 *   npx tsx tools/build-catalogue.ts           → writes src/data/roadload.json + src/data/tesla-params.json
 *   npx tsx tools/build-catalogue.ts --check   → exit 1 if regenerating would change either file
 *
 * Road load: EPA *Target* coefficients (lbf, lbf/mph, lbf/mph²) → SI via epaToSi, or a documented
 * CdA/Crr derivation. Params: normalised mass + forward-simulated fit of F_trac / P_eff to the
 * published acceleration time (spec §8.5).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { ETA_DRIVETRAIN, G, OCCUPANT_KG, type RoadLoadRecord, type TeslaParams, type TeslaRecord } from '../src/contracts';
import { epaToSi, type EpaTarget } from '../src/sim/epa';
import { maxForceN, roadForceN } from '../src/sim/load';

// ───────────────────────────── Input / output types ─────────────────────────────

export interface EpaRoadLoadSrc {
  ref: string;
  kind: 'epa';
  /** Model year of the EPA Test Car List file the row comes from. */
  modelYear: number;
  /** "Represented Test Veh Model" exactly as in the EPA file, e.g. "Model 3 Long Range AWD-E". */
  testCarRow: string;
  ratedHp: number;
  etwLb: number;
  /** Target (not Set) coefficients, original units. */
  target: EpaTarget;
  /** URL of the EPA xlsx/csv the row was read from. */
  file: string;
  note?: string;
}

export interface DerivedRoadLoadSrc {
  ref: string;
  kind: 'derived';
  cdA_m2: number;
  crr: number;
  /** Mass the rolling-resistance term is computed for (kg). */
  massKg: number;
  sources: string[];
  note?: string;
}

export type RoadLoadSrc = EpaRoadLoadSrc | DerivedRoadLoadSrc;

export interface FittedParams {
  massKg: number;
  fTracN: number;
  pEffW: number;
}

export interface FitResult extends FittedParams {
  /** false when even F_trac = 1.3·m·G (contract A7) with P_eff = 3·peak cannot reach the published time. */
  reached: boolean;
  /** Simulated 0→target time with the returned (rounded) params, seconds. */
  achievedS: number;
  targetS: number;
}

export interface CatalogueBuild {
  roadload: RoadLoadRecord[];
  params: Record<string, FittedParams>;
  warnings: string[];
}

// ───────────────────────────── Constants ─────────────────────────────

/** Dry air at 20 °C, 101.325 kPa (kg/m³) — used only for `derived` road load. */
export const AIR_DENSITY_KG_M3 = 1.2041;
export const FIT_DT_S = 0.005;
export const FIT_TOLERANCE_S = 0.01;
export const ROLLOUT_S = 0.25;
export const MPH60_MPS = 26.8224;
export const KMH100_MPS = 27.7778;
const MAX_SIM_S = 60;

// ───────────────────────────── Road load ─────────────────────────────

function round(x: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(x * k) / k;
}

export function roadLoadFromSrc(src: RoadLoadSrc): RoadLoadRecord {
  if (src.kind === 'epa') {
    const si = epaToSi(src.target);
    return {
      ref: src.ref,
      A_N: round(si.A_N, 2),
      B_Nps_m: round(si.B_Nps_m, 4),
      C_Ns2_m2: round(si.C_Ns2_m2, 5),
      source:
        `EPA ${src.modelYear} Test Car List: Tesla ${src.testCarRow} ` +
        `(${src.ratedHp} hp, ETW ${src.etwLb} lb; A ${src.target.A_lbf} lbf, B ${src.target.B_lbf_per_mph} lbf/mph, ` +
        `C ${src.target.C_lbf_per_mph2} lbf/mph²)${src.note ? ` — ${src.note}` : ''}`,
    };
  }
  return {
    ref: src.ref,
    A_N: round(src.crr * src.massKg * G, 2),
    B_Nps_m: 0,
    C_Ns2_m2: round(0.5 * AIR_DENSITY_KG_M3 * src.cdA_m2, 5),
    source:
      `derived: CdA=${src.cdA_m2} m², Crr=${src.crr}, m=${src.massKg} kg, rho=${AIR_DENSITY_KG_M3} kg/m³ ` +
      `(${src.sources.join('; ')})${src.note ? ` — ${src.note}` : ''}`,
  };
}

// ───────────────────────────── Parameter fit ─────────────────────────────

/** `us-curb` lacks an occupant → +75 kg; EU unladen already includes the driver; test weight as-is. */
export function normalisedMassKg(r: TeslaRecord): number {
  return r.massBasis === 'us-curb' ? r.massKg + OCCUPANT_KG : r.massKg;
}

export function targetSpeedMps(basis: TeslaRecord['accel']['basis']): number {
  return basis === '0-60mph' ? MPH60_MPS : KMH100_MPS;
}

/** Published time, plus the 1-ft rollout the manufacturer subtracted (applies to either basis). */
export function targetTimeS(accel: TeslaRecord['accel']): number {
  return accel.seconds + (accel.rolloutSubtracted ? ROLLOUT_S : 0);
}

/**
 * Forward Euler, dt = FIT_DT_S: m·dv/dt = min(F_trac, η·P_eff/max(v, 1)) − F_road(v), evaluated with
 * Task 4's runtime force model (`maxForceN` at modeFactor 1, `roadForceN`) so the fit and the
 * simulation can never drift apart. Returns the (linearly interpolated) time at which v reaches
 * targetMps, or Infinity.
 */
export function accelTimeS(
  massKg: number,
  rl: Pick<RoadLoadRecord, 'A_N' | 'B_Nps_m' | 'C_Ns2_m2'>,
  fTracN: number,
  pEffW: number,
  targetMps: number,
): number {
  const p: TeslaParams = {
    massKg,
    roadLoad: { A_N: rl.A_N, B_Nps_m: rl.B_Nps_m, C_Ns2_m2: rl.C_Ns2_m2 },
    fTracN,
    pEffW,
    eta: ETA_DRIVETRAIN,
    modeFactor: 1,
  };
  let v = 0;
  let t = 0;
  while (t < MAX_SIM_S) {
    const a = (maxForceN(p, v) - roadForceN(p, v)) / massKg;
    if (a <= 0) return Infinity;
    const vNext = v + a * FIT_DT_S;
    if (vNext >= targetMps) return t + (FIT_DT_S * (targetMps - v)) / (vNext - v);
    v = vNext;
    t += FIT_DT_S;
  }
  return Infinity;
}

/** Bisection on a parameter whose time decreases as it grows; returns the smallest x with time(x) ≤ target. */
function bisectDecreasing(time: (x: number) => number, targetS: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200 && b - a > 1e-9 * b; i++) {
    const mid = 0.5 * (a + b);
    if (time(mid) > targetS) a = mid;
    else b = mid;
  }
  return b;
}

export function fitParams(r: TeslaRecord, rl: Pick<RoadLoadRecord, 'A_N' | 'B_Nps_m' | 'C_Ns2_m2'>): FitResult {
  const m = normalisedMassKg(r);
  const vT = targetSpeedMps(r.accel.basis);
  const tT = targetTimeS(r.accel);
  const peakW = r.peakPowerKw * 1000;
  const fLo = 0.3 * m * G;
  const fHi = 1.3 * m * G; // contract A7: F_trac ∈ [0.3, 1.3]·m·G
  const finish = (fTracN: number, pEffW: number, reached: boolean): FitResult => {
    const f = round(fTracN, 1);
    const p = Math.round(pEffW);
    return { massKg: m, fTracN: f, pEffW: p, reached, achievedS: accelTimeS(m, rl, f, p, vT), targetS: tT };
  };

  if (accelTimeS(m, rl, fLo, peakW, vT) < tT - FIT_TOLERANCE_S) {
    throw new Error(
      `${r.id}: even F_trac = 0.3·m·G reaches ${vT} m/s faster than the published ${tT.toFixed(2)} s — check accel/mass/power data`,
    );
  }
  if (accelTimeS(m, rl, fHi, peakW, vT) <= tT) {
    const f = bisectDecreasing((x) => accelTimeS(m, rl, x, peakW, vT), tT, fLo, fHi);
    return finish(f, peakW, true);
  }
  const pLo = 0.5 * peakW;
  const pHi = 3 * peakW;
  if (accelTimeS(m, rl, fHi, pHi, vT) > tT) {
    // Traction cap 1.3·m·G cannot reproduce the time even with 3× power (no catalogue record expected):
    // keep the cap and the published power so the high-speed force stays realistic.
    return finish(fHi, peakW, false);
  }
  const p = bisectDecreasing((x) => accelTimeS(m, rl, fHi, x, vT), tT, pLo, pHi);
  return finish(fHi, p, true);
}

// ───────────────────────────── Build ─────────────────────────────

export function buildCatalogue(teslas: TeslaRecord[], src: RoadLoadSrc[]): CatalogueBuild {
  const byRef = new Map<string, RoadLoadRecord>();
  for (const s of src) {
    if (byRef.has(s.ref)) throw new Error(`roadload-src.json: duplicate ref "${s.ref}"`);
    byRef.set(s.ref, roadLoadFromSrc(s));
  }
  const ids = new Set<string>();
  const params: Record<string, FittedParams> = {};
  const warnings: string[] = [];
  for (const r of teslas) {
    if (ids.has(r.id)) throw new Error(`teslas.json: duplicate id "${r.id}"`);
    ids.add(r.id);
    const rl = byRef.get(r.roadLoadRef);
    if (rl === undefined) throw new Error(`teslas.json: ${r.id} roadLoadRef "${r.roadLoadRef}" not in roadload-src.json`);
    const fit = fitParams(r, rl);
    if (!fit.reached) {
      warnings.push(
        `${r.id}: published ${fit.targetS.toFixed(2)} s needs more than F_trac = 1.3·m·G; ` +
          `kept the cap (best ${fit.achievedS.toFixed(2)} s) and P_eff = peak`,
      );
    } else if (Math.abs(fit.achievedS - fit.targetS) > FIT_TOLERANCE_S) {
      throw new Error(`${r.id}: fit missed the target (${fit.achievedS.toFixed(3)} s vs ${fit.targetS.toFixed(3)} s)`);
    }
    params[r.id] = { massKg: fit.massKg, fTracN: fit.fTracN, pEffW: fit.pEffW };
  }
  const roadload = [...byRef.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { roadload, params, warnings };
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ───────────────────────────── Files ─────────────────────────────

export interface CataloguePaths {
  teslas: string;
  src: string;
  roadload: string;
  params: string;
  teslaSchema: string;
  roadloadSchema: string;
}

export function cataloguePaths(rootDir: string): CataloguePaths {
  const data = join(rootDir, 'src', 'data');
  return {
    teslas: join(data, 'teslas.json'),
    src: join(data, 'raw', 'roadload-src.json'),
    roadload: join(data, 'roadload.json'),
    params: join(data, 'tesla-params.json'),
    teslaSchema: join(data, 'schema', 'tesla.schema.json'),
    roadloadSchema: join(data, 'schema', 'roadload.schema.json'),
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function assertValid(schemaPath: string, data: unknown, label: string): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson(schemaPath) as object);
  if (!validate(data)) {
    throw new Error(`${label} fails ${schemaPath}:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

/** Builds the generated files in memory. Keys are absolute output paths. */
export function generate(rootDir: string): { files: Record<string, string>; warnings: string[] } {
  const paths = cataloguePaths(rootDir);
  const teslasJson = readJson(paths.teslas);
  assertValid(paths.teslaSchema, teslasJson, 'teslas.json');
  const srcJson = readJson(paths.src);
  if (!Array.isArray(srcJson)) throw new Error('roadload-src.json must be an array');
  const built = buildCatalogue(teslasJson as TeslaRecord[], srcJson as RoadLoadSrc[]);
  assertValid(paths.roadloadSchema, built.roadload, 'generated roadload.json');
  return {
    files: { [paths.roadload]: serialize(built.roadload), [paths.params]: serialize(built.params) },
    warnings: built.warnings,
  };
}

/** Paths whose committed content differs from a fresh build (missing files count as stale). */
export function checkCatalogue(rootDir: string): string[] {
  const { files } = generate(rootDir);
  const stale: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    let current: string | null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) stale.push(path);
  }
  return stale;
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function main(argv: string[], rootDir: string = REPO_ROOT): number {
  if (argv.includes('--check')) {
    const stale = checkCatalogue(rootDir);
    if (stale.length > 0) {
      console.error(`Catalogue out of date (run: npx tsx tools/build-catalogue.ts):\n  ${stale.join('\n  ')}`);
      return 1;
    }
    console.log('Catalogue up to date.');
    return 0;
  }
  const { files, warnings } = generate(rootDir);
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
```

- [ ] **Step 4: Create the road-load source table (Highland + Juniper rows, researched for this plan)**

All seven rows were read from the US EPA Test Car List files (Target coefficients, not Set). Juniper Performance, Juniper Standard RWD/AWD, the 2025 EU base Model Y and the Model Y L have no EPA row; they reference the closest same-body Juniper row (stated in the row `note` and in the record's sources).

Create `src/data/raw/roadload-src.json`:

```json
[
  {
    "ref": "model3-highland-rwd-2024",
    "kind": "epa",
    "modelYear": 2024,
    "testCarRow": "Model 3 RWD",
    "ratedHp": 257,
    "etwLb": 4250,
    "target": { "A_lbf": 27.02, "B_lbf_per_mph": 0.2873, "C_lbf_per_mph2": 0.0122 },
    "file": "https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx",
    "note": "EPA row lists the drive system as 4-Wheel Drive (data-entry error; the car is RWD); coefficients equal the Long Range RWD row"
  },
  {
    "ref": "model3-highland-lr-rwd-2024",
    "kind": "epa",
    "modelYear": 2024,
    "testCarRow": "Model 3 Long Range RWD",
    "ratedHp": 302,
    "etwLb": 4250,
    "target": { "A_lbf": 27.02, "B_lbf_per_mph": 0.2873, "C_lbf_per_mph2": 0.0122 },
    "file": "https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx"
  },
  {
    "ref": "model3-highland-lr-awd-2026",
    "kind": "epa",
    "modelYear": 2026,
    "testCarRow": "Model 3 Long Range AWD-E",
    "ratedHp": 397,
    "etwLb": 4250,
    "target": { "A_lbf": 30.98, "B_lbf_per_mph": 0.1596, "C_lbf_per_mph2": 0.0141 },
    "file": "https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx",
    "note": "same coefficients in the MY2024 and MY2025 files"
  },
  {
    "ref": "model3-highland-performance-2026",
    "kind": "epa",
    "modelYear": 2026,
    "testCarRow": "Model 3 Performance AWD",
    "ratedHp": 510,
    "etwLb": 4250,
    "target": { "A_lbf": 36.82, "B_lbf_per_mph": 0.1386, "C_lbf_per_mph2": 0.01545 },
    "file": "https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
  },
  {
    "ref": "model3-highland-standard-2026",
    "kind": "epa",
    "modelYear": 2026,
    "testCarRow": "Model 3 Standard RWD (18in Wheels)",
    "ratedHp": 305,
    "etwLb": 4000,
    "target": { "A_lbf": 27.99, "B_lbf_per_mph": 0.1172, "C_lbf_per_mph2": 0.01335 },
    "file": "https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
  },
  {
    "ref": "modely-juniper-lr-awd-2025",
    "kind": "epa",
    "modelYear": 2025,
    "testCarRow": "Model Y Long Range AWD",
    "ratedHp": 390,
    "etwLb": 4750,
    "target": { "A_lbf": 37.77, "B_lbf_per_mph": -0.1538, "C_lbf_per_mph2": 0.02044 },
    "file": "https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx",
    "note": "Juniper row (coefficients changed from the MY2024 file); also used as the closest proxy for Juniper Performance, Standard AWD and Model Y L, which have no EPA row"
  },
  {
    "ref": "modely-juniper-lr-rwd-2025",
    "kind": "epa",
    "modelYear": 2025,
    "testCarRow": "Model Y Long Range RWD",
    "ratedHp": 296,
    "etwLb": 4500,
    "target": { "A_lbf": 35.63, "B_lbf_per_mph": -0.1078, "C_lbf_per_mph2": 0.0192 },
    "file": "https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx",
    "note": "Juniper row; also used as the closest proxy for the Standard RWD and the 2025 EU base RWD, which have no EPA row"
  }
]
```

- [ ] **Step 5: Create the catalogue with the Highland, Juniper and Model Y L records (researched for this plan)**

Primary sources: Tesla US/DE spec pages (Wayback snapshots 2024-03-07, 2024-11-03, 2026-06-07 for `/model3`; 2026-02-14 for `/modely`; 2025-08-20 and 2026-02-17 for `/de_de/modely`), Tesla owner's manuals (Acceleration Modes pages: Model 3 "Chill", "Standard (Non-Performance vehicles)", "Insane (Performance vehicles)" → Performance: Chill / Insane; Model Y "Chill", "Standard (Non-Performance vehicles)", "Sport (Performance vehicles/Acceleration Boost package)", "Insane (Performance vehicles)" → Performance: Chill / Sport / Insane), EPA Test Car Lists (rated hp). Masses are US curb (lb × 0.45359237, rounded); powers are EPA rated hp × 0.7457 (1 decimal) or the stated proxy. Audio defaults follow the phase research (`docs/research/2026-10-05-platform-research.json`, topic `tesla-audio-specs`).

Create `src/data/teslas.json`:

```json
[
  {
    "id": "model3-highland-rwd",
    "model": "Model 3",
    "generation": "Highland (2023–)",
    "years": [
      2023,
      2025
    ],
    "trim": "RWD",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1765,
    "massBasis": "us-curb",
    "peakPowerKw": 191.6,
    "accel": {
      "seconds": 5.8,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "model3-highland-rwd-2024",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model 3 page, archived 2024-03-07 (Rear-Wheel Drive: Weight 3,891 lbs): http://web.archive.org/web/20240307031952/https://www.tesla.com/model3"
      ],
      "power": [
        "US EPA 2024 Test Car List, Tesla Model 3 RWD, rated 257 hp (191.6 kW): https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx"
      ],
      "accel": [
        "Tesla US Model 3 page, archived 2024-03-07 (5.8 s 0-60 mph): http://web.archive.org/web/20240307031952/https://www.tesla.com/model3",
        "Model 3 Owner's Manual, Acceleration Modes (Chill, Standard): http://web.archive.org/web/20250324231650/https://www.tesla.com/ownersmanual/model3/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "TotallyEV, Model 3 Highland RWD audio review (9 speakers, no subwoofer): https://totallyev.net/new-tesla-model-3-audio-review-standard-vs-long-range-sound/"
      ]
    }
  },
  {
    "id": "model3-highland-lr-rwd",
    "model": "Model 3",
    "generation": "Highland (2023–)",
    "years": [
      2024,
      2026
    ],
    "trim": "Long Range RWD / Premium RWD",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1765,
    "massBasis": "us-curb",
    "peakPowerKw": 225.2,
    "accel": {
      "seconds": 4.9,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "model3-highland-lr-rwd-2024",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model 3 page, archived 2024-11-03 (Long Range Rear-Wheel Drive: Weight (Curb Mass) 3,891 lbs; the 2026-06 page lists 3,759 lbs for Premium RWD): http://web.archive.org/web/20241103234008/https://www.tesla.com/model3"
      ],
      "power": [
        "US EPA 2024 Test Car List, Tesla Model 3 Long Range RWD, rated 302 hp (225.2 kW): https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx"
      ],
      "accel": [
        "Tesla US Model 3 page, archived 2024-11-03 (4.9 s 0-60 mph): http://web.archive.org/web/20241103234008/https://www.tesla.com/model3",
        "Model 3 Owner's Manual, Acceleration Modes: http://web.archive.org/web/20250324231650/https://www.tesla.com/ownersmanual/model3/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "TotallyEV, Model 3 Highland RWD audio review (9 speakers, no subwoofer): https://totallyev.net/new-tesla-model-3-audio-review-standard-vs-long-range-sound/",
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "model3-highland-lr-awd",
    "model": "Model 3",
    "generation": "Highland (2023–)",
    "years": [
      2023,
      2026
    ],
    "trim": "Long Range AWD / Premium AWD",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1828,
    "massBasis": "us-curb",
    "peakPowerKw": 296.0,
    "accel": {
      "seconds": 4.2,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "model3-highland-lr-awd-2026",
    "subwooferDefault": true,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model 3 page, archived 2026-06-07 (All-Wheel Drive: Weight (Curb Mass) 4,030 lbs; same on 2024-03-07): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3"
      ],
      "power": [
        "US EPA 2026 Test Car List, Tesla Model 3 Long Range AWD-E, rated 397 hp (296.0 kW): https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model 3 page, archived 2026-06-07 (4.2 s 0-60 mph): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3",
        "Model 3 Owner's Manual, Acceleration Modes: http://web.archive.org/web/20250324231650/https://www.tesla.com/ownersmanual/model3/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "TotallyEV, Model 3 Highland upgraded audio (17 speakers incl. 2 subwoofers): https://totallyev.net/new-tesla-model-3-audio-review-upgraded-to-17-speakers/",
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "model3-highland-performance",
    "model": "Model 3",
    "generation": "Highland (2023–)",
    "years": [
      2024,
      2026
    ],
    "trim": "Performance",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1839,
    "massBasis": "us-curb",
    "peakPowerKw": 380.3,
    "accel": {
      "seconds": 2.9,
      "basis": "0-60mph",
      "rolloutSubtracted": true
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Insane",
        "factor": 1
      }
    ],
    "roadLoadRef": "model3-highland-performance-2026",
    "subwooferDefault": true,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model 3 page, archived 2026-06-07 (Performance: Weight (Curb Mass) 4,054 lbs): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3"
      ],
      "power": [
        "US EPA 2026 Test Car List, Tesla Model 3 Performance AWD, rated 510 hp (380.3 kW): https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model 3 page, archived 2026-06-07 (2.9 s 0-60 mph, footnote: with rollout subtracted): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3",
        "Model 3 Owner's Manual, Acceleration Modes (Insane: Performance vehicles): http://web.archive.org/web/20250324231650/https://www.tesla.com/ownersmanual/model3/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "model3-highland-standard",
    "model": "Model 3",
    "generation": "Highland (2023–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Standard",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1705,
    "massBasis": "us-curb",
    "peakPowerKw": 227.4,
    "accel": {
      "seconds": 5.8,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "model3-highland-standard-2026",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model 3 page, archived 2026-06-07 (Model 3 Rear-Wheel Drive, Standard Range: Weight (Curb Mass) 3,759 lbs): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3"
      ],
      "power": [
        "US EPA 2026 Test Car List, Tesla Model 3 Standard RWD (18in Wheels), rated 305 hp (227.4 kW): https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model 3 page, archived 2026-06-07 (5.8 s 0-60 mph): http://web.archive.org/web/20260607145538/https://www.tesla.com/model3",
        "Model 3 Owner's Manual, Acceleration Modes: http://web.archive.org/web/20250324231650/https://www.tesla.com/ownersmanual/model3/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features",
        "TechCrunch, Standard Model 3/Y launch (7 speakers): https://techcrunch.com/2025/10/07/tesla-reveals-slightly-cheaper-standard-versions-of-the-model-3-and-model-y/"
      ]
    }
  },
  {
    "id": "modely-juniper-rwd-eu",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2025,
      2025
    ],
    "trim": "RWD (EU base, 2025)",
    "markets": [
      "EU"
    ],
    "massKg": 1928,
    "massBasis": "us-curb",
    "peakPowerKw": 220.7,
    "accel": {
      "seconds": 5.9,
      "basis": "0-100kmh",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-rwd-2025",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla Germany Model Y page, archived 2025-08-20 (Hinterradantrieb, Standard Reichweite: Gewicht (Leergewicht) 1.928 kg — curb mass without driver, so basis us-curb): http://web.archive.org/web/20250820145411/https://www.tesla.com/de_de/modely"
      ],
      "power": [
        "No published figure; proxy = US EPA 2025 Test Car List, Tesla Model Y Long Range RWD, rated 296 hp (220.7 kW), same rear drive unit: https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla Germany Model Y page, archived 2025-08-20 (0 - 100 km/h in 5,9 Sek.): http://web.archive.org/web/20250820145411/https://www.tesla.com/de_de/modely",
        "Model Y Owner's Manual, Acceleration Modes: http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "Drive Tesla Canada, Model Y RWD audio (9 speakers, subwoofer only on dual-motor/Performance; Premium RWD later gained a subwoofer in Europe): https://driveteslacanada.ca/?p=84137"
      ]
    }
  },
  {
    "id": "modely-juniper-standard-rwd",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Standard RWD",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1842,
    "massBasis": "us-curb",
    "peakPowerKw": 220.7,
    "accel": {
      "seconds": 6.8,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-rwd-2025",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model Y page, archived 2026-02-14 (Model Y Rear-Wheel Drive, Standard Range: Weight (Curb Mass) 4,061 lbs): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely"
      ],
      "power": [
        "No published figure; proxy = US EPA 2025 Test Car List, Tesla Model Y Long Range RWD, rated 296 hp (220.7 kW): https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model Y page, archived 2026-02-14 (6.8 s 0-60 mph): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely",
        "Model Y Owner's Manual, Acceleration Modes: http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features",
        "TechCrunch, Standard Model 3/Y launch (7 speakers): https://techcrunch.com/2025/10/07/tesla-reveals-slightly-cheaper-standard-versions-of-the-model-3-and-model-y/"
      ]
    }
  },
  {
    "id": "modely-juniper-standard-awd",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2026,
      2026
    ],
    "trim": "Standard AWD",
    "markets": [
      "US"
    ],
    "massKg": 1926,
    "massBasis": "us-curb",
    "peakPowerKw": 290.8,
    "accel": {
      "seconds": 4.6,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-awd-2025",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model Y page, archived 2026-02-14 (Model Y All-Wheel Drive, Standard Range: Weight (Curb Mass) 4,246 lbs): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely"
      ],
      "power": [
        "No published figure; proxy = US EPA 2025 Test Car List, Tesla Model Y Long Range AWD, rated 390 hp (290.8 kW): https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model Y page, archived 2026-02-14 (4.6 s 0-60 mph): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely",
        "Model Y Owner's Manual, Acceleration Modes: http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "modely-juniper-lr-rwd",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Long Range RWD / Premium RWD",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 1898,
    "massBasis": "us-curb",
    "peakPowerKw": 220.7,
    "accel": {
      "seconds": 5.4,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-rwd-2025",
    "subwooferDefault": false,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model Y page, archived 2026-02-14 (Premium Rear-Wheel Drive: Weight (Curb Mass) 4,184 lbs; DE 2025-08 Leergewicht 1.901 kg): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely"
      ],
      "power": [
        "US EPA 2025 Test Car List, Tesla Model Y Long Range RWD, rated 296 hp (220.7 kW): https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model Y page, archived 2026-02-14 (5.4 s 0-60 mph): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely",
        "Model Y Owner's Manual, Acceleration Modes: http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "Drive Tesla Canada, Model Y RWD audio (9 speakers, subwoofer only on dual-motor/Performance; Premium RWD later gained a subwoofer in Europe): https://driveteslacanada.ca/?p=84137",
        "Basenor, Model Y Premium LR RWD audio upgrade (subwoofer added on later builds): https://www.basenor.com/blogs/news/tesla-model-y-premium-lr-rwd-audio-upgrade-5-details-that-matter"
      ]
    }
  },
  {
    "id": "modely-juniper-lr-awd",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Long Range AWD / Premium AWD (incl. Launch Series)",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 2029,
    "massBasis": "us-curb",
    "peakPowerKw": 290.8,
    "accel": {
      "seconds": 4.6,
      "basis": "0-60mph",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-awd-2025",
    "subwooferDefault": true,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model Y page, archived 2026-02-14 (Premium All-Wheel Drive: Weight (Curb Mass) 4,473 lbs; DE Leergewicht 1.997 kg): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely"
      ],
      "power": [
        "US EPA 2025 Test Car List, Tesla Model Y Long Range AWD, rated 390 hp (290.8 kW): https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model Y page, archived 2026-02-14 (4.6 s 0-60 mph; DE: 0-100 km/h 4,8 s): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely",
        "Model Y Owner's Manual, Acceleration Modes: http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "modely-juniper-performance",
    "model": "Model Y",
    "generation": "Juniper (2025–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Performance",
    "markets": [
      "US",
      "EU"
    ],
    "massKg": 2026,
    "massBasis": "us-curb",
    "peakPowerKw": 380.3,
    "accel": {
      "seconds": 3.3,
      "basis": "0-60mph",
      "rolloutSubtracted": true
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Sport",
        "factor": 0.85
      },
      {
        "name": "Insane",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-awd-2025",
    "subwooferDefault": true,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Tesla US Model Y page, archived 2026-02-14 (Performance: Weight (Curb Mass) 4,466 lbs; DE Leergewicht 2.033 kg): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely"
      ],
      "power": [
        "No published figure (electrive.com 2025-08-29: Tesla does not state output); proxy = US EPA 2026 Test Car List, Tesla Model 3 Performance AWD, rated 510 hp (380.3 kW), same Performance drive units: https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx"
      ],
      "accel": [
        "Tesla US Model Y page, archived 2026-02-14 (3.3 s 0-60 mph, footnote: with rollout subtracted; DE 3,5 s 0-100 km/h mit abgezogenem Rollout): http://web.archive.org/web/20260214203759/https://www.tesla.com/modely",
        "Model Y Owner's Manual, Acceleration Modes (Sport, Insane: Performance vehicles): http://web.archive.org/web/20260421232336/https://www.tesla.com/ownersmanual/modely/en_us/GUID-8EAFF5D8-7209-45ED-A7E0-508FFA60C530.html — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "NotATeslaApp, Standard vs Premium Model 3/Y feature comparison (Standard: 7 speakers; Model 3 Premium AWD/Performance 15 + 2 subwoofers; Model Y Premium/Performance 15 + 1 subwoofer): https://www.notateslaapp.com/news/3211/tesla-launches-standard-model-3-and-model-y-comparison-of-features"
      ]
    }
  },
  {
    "id": "modelyl-2025-awd",
    "model": "Model Y L",
    "generation": "Model Y L (2025–)",
    "years": [
      2025,
      2026
    ],
    "trim": "Premium Long Range AWD (6-seat)",
    "markets": [
      "CN",
      "other"
    ],
    "massKg": 2088,
    "massBasis": "us-curb",
    "peakPowerKw": 340,
    "accel": {
      "seconds": 4.5,
      "basis": "0-100kmh",
      "rolloutSubtracted": false
    },
    "accelModes": [
      {
        "name": "Chill",
        "factor": 0.5
      },
      {
        "name": "Standard",
        "factor": 1
      }
    ],
    "roadLoadRef": "modely-juniper-lr-awd-2025",
    "subwooferDefault": true,
    "mcu": [
      "amd"
    ],
    "supported": true,
    "sources": {
      "mass": [
        "Wikipedia, Tesla Model Y (Model Y L curb weight 2,088 kg; last resort, citing CarNewsChina 2025-07-16): https://en.wikipedia.org/wiki/Tesla_Model_Y"
      ],
      "power": [
        "Wikipedia, Tesla Model Y (Model Y L: 142 kW front + 198 kW rear, 340 kW combined; citing Zecar 2026-03-13): https://en.wikipedia.org/wiki/Tesla_Model_Y"
      ],
      "accel": [
        "Wikipedia, Tesla Model Y (Model Y L China: 0-100 km/h 4.5 s): https://en.wikipedia.org/wiki/Tesla_Model_Y",
        "accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"
      ],
      "audio": [
        "Wikipedia, Tesla Model Y (Model Y L: 19 speakers, a subwoofer and two overhead speakers): https://en.wikipedia.org/wiki/Tesla_Model_Y"
      ]
    }
  }
]
```

- [ ] **Step 6: Generate the derived files**

Run: `npx tsx tools/build-catalogue.ts`
Expected output (paths absolute), no warnings:

```text
wrote <repo>/src/data/roadload.json
wrote <repo>/src/data/tesla-params.json
```

With exactly the Step 4/5 inputs the generated `src/data/tesla-params.json` must be:

```json
{
  "model3-highland-rwd": {
    "massKg": 1840,
    "fTracN": 9390.2,
    "pEffW": 191600
  },
  "model3-highland-lr-rwd": {
    "massKg": 1840,
    "fTracN": 11082.9,
    "pEffW": 225200
  },
  "model3-highland-lr-awd": {
    "massKg": 1903,
    "fTracN": 12796.8,
    "pEffW": 296000
  },
  "model3-highland-performance": {
    "massKg": 1914,
    "fTracN": 17369.3,
    "pEffW": 380300
  },
  "model3-highland-standard": {
    "massKg": 1780,
    "fTracN": 8493.7,
    "pEffW": 227400
  },
  "modely-juniper-rwd-eu": {
    "massKg": 2003,
    "fTracN": 10396.8,
    "pEffW": 220700
  },
  "modely-juniper-standard-rwd": {
    "massKg": 1917,
    "fTracN": 7821.1,
    "pEffW": 220700
  },
  "modely-juniper-standard-awd": {
    "massKg": 2001,
    "fTracN": 12241.2,
    "pEffW": 290800
  },
  "modely-juniper-lr-rwd": {
    "massKg": 1973,
    "fTracN": 10792.5,
    "pEffW": 220700
  },
  "modely-juniper-lr-awd": {
    "massKg": 2104,
    "fTracN": 13082,
    "pEffW": 290800
  },
  "modely-juniper-performance": {
    "massKg": 2101,
    "fTracN": 16739.9,
    "pEffW": 380300
  },
  "modelyl-2025-awd": {
    "massKg": 2163,
    "fTracN": 14025.4,
    "pEffW": 340000
  }
}
```

and `src/data/roadload.json` must be:

```json
[
  {
    "ref": "model3-highland-lr-awd-2026",
    "A_N": 137.81,
    "B_Nps_m": 1.5881,
    "C_Ns2_m2": 0.31384,
    "source": "EPA 2026 Test Car List: Tesla Model 3 Long Range AWD-E (397 hp, ETW 4250 lb; A 30.98 lbf, B 0.1596 lbf/mph, C 0.0141 lbf/mph²) — same coefficients in the MY2024 and MY2025 files"
  },
  {
    "ref": "model3-highland-lr-rwd-2024",
    "A_N": 120.19,
    "B_Nps_m": 2.8587,
    "C_Ns2_m2": 0.27155,
    "source": "EPA 2024 Test Car List: Tesla Model 3 Long Range RWD (302 hp, ETW 4250 lb; A 27.02 lbf, B 0.2873 lbf/mph, C 0.0122 lbf/mph²)"
  },
  {
    "ref": "model3-highland-performance-2026",
    "A_N": 163.78,
    "B_Nps_m": 1.3791,
    "C_Ns2_m2": 0.34389,
    "source": "EPA 2026 Test Car List: Tesla Model 3 Performance AWD (510 hp, ETW 4250 lb; A 36.82 lbf, B 0.1386 lbf/mph, C 0.01545 lbf/mph²)"
  },
  {
    "ref": "model3-highland-rwd-2024",
    "A_N": 120.19,
    "B_Nps_m": 2.8587,
    "C_Ns2_m2": 0.27155,
    "source": "EPA 2024 Test Car List: Tesla Model 3 RWD (257 hp, ETW 4250 lb; A 27.02 lbf, B 0.2873 lbf/mph, C 0.0122 lbf/mph²) — EPA row lists the drive system as 4-Wheel Drive (data-entry error; the car is RWD); coefficients equal the Long Range RWD row"
  },
  {
    "ref": "model3-highland-standard-2026",
    "A_N": 124.51,
    "B_Nps_m": 1.1662,
    "C_Ns2_m2": 0.29715,
    "source": "EPA 2026 Test Car List: Tesla Model 3 Standard RWD (18in Wheels) (305 hp, ETW 4000 lb; A 27.99 lbf, B 0.1172 lbf/mph, C 0.01335 lbf/mph²)"
  },
  {
    "ref": "modely-juniper-lr-awd-2025",
    "A_N": 168.01,
    "B_Nps_m": -1.5304,
    "C_Ns2_m2": 0.45496,
    "source": "EPA 2025 Test Car List: Tesla Model Y Long Range AWD (390 hp, ETW 4750 lb; A 37.77 lbf, B -0.1538 lbf/mph, C 0.02044 lbf/mph²) — Juniper row (coefficients changed from the MY2024 file); also used as the closest proxy for Juniper Performance, Standard AWD and Model Y L, which have no EPA row"
  },
  {
    "ref": "modely-juniper-lr-rwd-2025",
    "A_N": 158.49,
    "B_Nps_m": -1.0727,
    "C_Ns2_m2": 0.42736,
    "source": "EPA 2025 Test Car List: Tesla Model Y Long Range RWD (296 hp, ETW 4500 lb; A 35.63 lbf, B -0.1078 lbf/mph, C 0.0192 lbf/mph²) — Juniper row; also used as the closest proxy for the Standard RWD and the 2025 EU base RWD, which have no EPA row"
  }
]
```

(If any number differs, the builder or Task 1's `epaToSi` deviates from this plan — fix before continuing.)

- [ ] **Step 7: Run the builder test to verify it passes**

Run: `npx vitest run tests/unit/build-catalogue.test.ts`
Expected: PASS — 16 tests (includes `are up to date (build-catalogue --check passes)` and the CLI run).

- [ ] **Step 8: Write the failing catalogue test**

Create `tests/unit/catalogue.test.ts` (`EXPECTED_IDS` is the complete coverage list of Step 12; the WOT test uses each record's quickest mode, factor 1, integrates with the builder's own step `FIT_DT_S` using the contract's force model written out in the test — independent of `src/sim/load.ts`, so `rawLoad ≥ 0.95` actually checks `maxForceN`/`roadForceN` — and additionally checks that this reproduces the builder's simulated 0→target time with the resolved runtime params, so a drift between `src/sim/load.ts`, `resolveTeslaParams` and `tools/build-catalogue.ts` cannot go unnoticed):

```ts
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { ETA_DRIVETRAIN, type TeslaParams, type TeslaRecord } from '../../src/contracts';
import { notListedParams, resolveTeslaParams, ROADLOAD, TESLAS } from '../../src/data/catalogue';
import roadloadSchema from '../../src/data/schema/roadload.schema.json';
import teslaSchema from '../../src/data/schema/tesla.schema.json';
import paramsJson from '../../src/data/tesla-params.json';
import { DEMO_PROFILE, DemoDriver, PedalPhysics, type PedalCommand } from '../../src/sim/demo';
import { rawLoad } from '../../src/sim/load';
import { accelTimeS, fitParams, FIT_DT_S, targetSpeedMps, targetTimeS } from '../../tools/build-catalogue';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const KMH = 1 / 3.6;

/** Every Model S/X/3/Y/Y L/Cybertruck generation + trim since 2012 (plan T11 coverage table). */
const EXPECTED_IDS: string[] = [
  'models-2012-40',
  'models-2012-60',
  'models-2012-85',
  'models-2012-p85',
  'models-2012-p85plus',
  'models-2012-70',
  'models-2012-70d',
  'models-2012-85d',
  'models-2012-p85d',
  'models-2012-90d',
  'models-2012-p90d',
  'models-2016-60',
  'models-2016-60d',
  'models-2016-75',
  'models-2016-75d',
  'models-2016-90d',
  'models-2016-p90d',
  'models-2016-100d',
  'models-2016-p100d',
  'models-2018-75d',
  'models-2018-100d',
  'models-2018-p100d',
  'models-2018-standard-range',
  'models-2018-long-range',
  'models-2018-performance',
  'models-2018-long-range-plus',
  'models-2021-long-range',
  'models-2021-plaid',
  'models-2021-standard-range',
  'modelx-2015-60d',
  'modelx-2015-75d',
  'modelx-2015-90d',
  'modelx-2015-p90d',
  'modelx-2015-100d',
  'modelx-2015-p100d',
  'modelx-2018-75d',
  'modelx-2018-100d',
  'modelx-2018-p100d',
  'modelx-2018-standard-range',
  'modelx-2018-long-range',
  'modelx-2018-performance',
  'modelx-2018-long-range-plus',
  'modelx-2021-long-range',
  'modelx-2021-plaid',
  'model3-2017-lr-rwd',
  'model3-2017-mid-range',
  'model3-2017-standard-range',
  'model3-2017-sr-plus',
  'model3-2017-rwd',
  'model3-2017-lr-awd',
  'model3-2017-performance',
  'model3-highland-rwd',
  'model3-highland-lr-rwd',
  'model3-highland-lr-awd',
  'model3-highland-performance',
  'model3-highland-standard',
  'modely-2020-lr-awd',
  'modely-2020-performance',
  'modely-2020-sr-rwd',
  'modely-2020-awd',
  'modely-2020-rwd',
  'modely-2020-lr-rwd',
  'modely-juniper-rwd-eu',
  'modely-juniper-standard-rwd',
  'modely-juniper-standard-awd',
  'modely-juniper-lr-rwd',
  'modely-juniper-lr-awd',
  'modely-juniper-performance',
  'modelyl-2025-awd',
  'cybertruck-awd',
  'cybertruck-cyberbeast',
  'cybertruck-lr-rwd',
];

function paramsWith(p: TeslaParams, patch: Partial<TeslaParams>): TeslaParams {
  return { ...p, ...patch, roadLoad: { ...(patch.roadLoad ?? p.roadLoad) } };
}

/** One DEMO_PROFILE loop driven through PedalPhysics with params p; returns (v, a) samples. */
function demoTrajectory(p: TeslaParams, dtS: number): { v: number; a: number }[] {
  const driver = new DemoDriver();
  const physics = new PedalPhysics();
  const pedal: PedalCommand = { throttle: 0, brake: 0 };
  driver.reset();
  physics.configure(p);
  physics.reset();
  const last = DEMO_PROFILE[DEMO_PROFILE.length - 1];
  const loopS = last === undefined ? 0 : last.t;
  const out: { v: number; a: number }[] = [];
  for (let t = 0; t < loopS; t += dtS) {
    driver.step(dtS, pedal);
    physics.step(pedal.throttle, pedal.brake, dtS);
    out.push({ v: physics.v, a: physics.a });
  }
  return out;
}

describe('catalogue data', () => {
  it('teslas.json validates against tesla.schema.json', () => {
    const validate = ajv.compile(teslaSchema);
    const ok = validate(TESLAS);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('roadload.json validates against roadload.schema.json and has unique refs', () => {
    const validate = ajv.compile(roadloadSchema);
    const ok = validate(ROADLOAD);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(new Set(ROADLOAD.map((r) => r.ref)).size).toBe(ROADLOAD.length);
  });

  it('covers exactly the planned generation/trim list', () => {
    expect([...TESLAS.map((r) => r.id)].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('has unique ids, a resolvable roadLoadRef and fitted params for every record', () => {
    expect(new Set(TESLAS.map((r) => r.id)).size).toBe(TESLAS.length);
    const refs = new Set(ROADLOAD.map((r) => r.ref));
    for (const r of TESLAS) expect(refs.has(r.roadLoadRef), `${r.id} → ${r.roadLoadRef}`).toBe(true);
    expect(Object.keys(paramsJson).sort()).toEqual(TESLAS.map((r) => r.id).sort());
  });

  it.each(TESLAS.map((r) => [r.id, r] as const))('%s: modes, years and MCU flags are consistent', (_id, r: TeslaRecord) => {
    const factors = r.accelModes.map((m) => m.factor);
    expect(factors[factors.length - 1]).toBe(1);
    for (let i = 1; i < factors.length; i++) expect(factors[i]).toBeGreaterThan(factors[i - 1] ?? Infinity);
    expect(new Set(r.accelModes.map((m) => m.name)).size).toBe(r.accelModes.length);
    expect(r.years[0]).toBeLessThanOrEqual(r.years[1]);
    expect(r.supported).toBe(!r.mcu.includes('tegra'));
  });
});

describe('resolveTeslaParams', () => {
  it('defaults to the last (quickest) mode and resolves road load + fitted params', () => {
    const id = 'model3-highland-performance';
    const p = resolveTeslaParams(id);
    const rec = TESLAS.find((r) => r.id === id);
    const rl = ROADLOAD.find((x) => x.ref === rec?.roadLoadRef);
    expect(p.modeFactor).toBe(1);
    expect(p.eta).toBe(ETA_DRIVETRAIN);
    expect(p.roadLoad).toEqual({ A_N: rl?.A_N, B_Nps_m: rl?.B_Nps_m, C_Ns2_m2: rl?.C_Ns2_m2 });
    expect(p.massKg).toBe((paramsJson as Record<string, { massKg: number }>)[id]?.massKg);
    expect(resolveTeslaParams(id, 'Chill').modeFactor).toBe(0.5);
  });

  it('throws on unknown records and modes', () => {
    expect(() => resolveTeslaParams('no-such-tesla')).toThrow(/Unknown Tesla record/);
    expect(() => resolveTeslaParams('model3-highland-performance', 'Ludicrous')).toThrow(/no acceleration mode/);
  });

  it.each(TESLAS.map((r) => [r.id] as const))('%s: every mode resolves to finite, positive params', (id) => {
    const rec = TESLAS.find((r) => r.id === id);
    for (const m of rec?.accelModes ?? []) {
      const p = resolveTeslaParams(id, m.name);
      for (const x of [p.massKg, p.fTracN, p.pEffW, p.modeFactor, p.roadLoad.A_N, p.roadLoad.C_Ns2_m2]) {
        expect(Number.isFinite(x) && x > 0).toBe(true);
      }
    }
  });
});

describe('notListedParams', () => {
  it('uses the generic road load per body and F_trac = m·(27.7778/t)·1.25 with no power term', () => {
    expect(notListedParams(5, 2000, 'sedan')).toEqual({
      massKg: 2000,
      roadLoad: { A_N: 130, B_Nps_m: 1, C_Ns2_m2: 0.4 },
      fTracN: 2000 * (27.7778 / 5) * 1.25,
      pEffW: 1e9,
      eta: 0.9,
      modeFactor: 1,
    });
    expect(notListedParams(5, 2000, 'suv').roadLoad).toEqual({ A_N: 160, B_Nps_m: 1.5, C_Ns2_m2: 0.48 });
    expect(notListedParams(5, 2000, 'truck').roadLoad).toEqual({ A_N: 220, B_Nps_m: 2, C_Ns2_m2: 0.62 });
  });

  it('rejects non-positive or non-finite inputs', () => {
    expect(() => notListedParams(0, 2000, 'sedan')).toThrow(RangeError);
    expect(() => notListedParams(5, Number.NaN, 'suv')).toThrow(RangeError);
  });
});

describe('load estimation per catalogue record (spec §8.5)', () => {
  it.each(TESLAS.map((r) => [r.id, r] as const))(
    '%s: WOT gives rawLoad ≥ 0.95 over 10–130 km/h, ≤ 0.75 at 0.6× that acceleration, and reproduces the fitted time',
    (id, rec: TeslaRecord) => {
      const p = resolveTeslaParams(id);
      const vTarget = targetSpeedMps(rec.accel.basis);
      // Same forward-Euler step as tools/build-catalogue.ts, so the two force models can be compared exactly.
      const dt = FIT_DT_S;
      let v = 0;
      let t = 0;
      let tTarget = Infinity;
      let samples = 0;
      while (t < 120 && v < 130 * KMH) {
        // WOT acceleration from the contract's force model, written out here independently of
        // src/sim/load.ts (which rawLoad and the builder use), so rawLoad ≥ 0.95 checks load.ts.
        const drive = p.modeFactor * Math.min(p.fTracN, (ETA_DRIVETRAIN * p.pEffW) / Math.max(v, 1));
        const road = p.roadLoad.A_N + p.roadLoad.B_Nps_m * v + p.roadLoad.C_Ns2_m2 * v * v;
        const a = (drive - road) / p.massKg;
        if (v >= 10 * KMH) {
          samples++;
          expect(rawLoad(p, v, a), `v=${(v / KMH).toFixed(1)} km/h`).toBeGreaterThanOrEqual(0.95);
          expect(rawLoad(p, v, 0.6 * a), `v=${(v / KMH).toFixed(1)} km/h`).toBeLessThanOrEqual(0.75);
        }
        const vNext = v + a * dt;
        if (tTarget === Infinity && vNext >= vTarget) tTarget = t + (dt * (vTarget - v)) / (vNext - v);
        v = vNext;
        t += dt;
      }
      expect(v).toBeGreaterThanOrEqual(130 * KMH);
      expect(samples).toBeGreaterThan(10);
      // The independent force model with the resolved runtime params must reproduce the builder's simulation…
      expect(Math.abs(tTarget - accelTimeS(p.massKg, p.roadLoad, p.fTracN, p.pEffW, vTarget))).toBeLessThanOrEqual(0.01);
      // …and therefore the published time (except a fit the builder reported as unreachable).
      const fit = fitParams(rec, p.roadLoad);
      if (fit.reached) expect(Math.abs(tTarget - targetTimeS(rec.accel))).toBeLessThanOrEqual(0.02);
      else expect(tTarget).toBeGreaterThan(targetTimeS(rec.accel));
    },
  );

  it.each(TESLAS.map((r) => [r.id] as const))(
    '%s: ±20 % road load / ±10 % mass change load by < 0.05 (mean |Δ|) over one DEMO_PROFILE loop',
    (id) => {
      const base = resolveTeslaParams(id);
      const rl = base.roadLoad;
      const road = (k: number): Partial<TeslaParams> => ({
        roadLoad: { A_N: rl.A_N * k, B_Nps_m: rl.B_Nps_m * k, C_Ns2_m2: rl.C_Ns2_m2 * k },
      });
      const variants = [
        paramsWith(base, road(0.8)),
        paramsWith(base, road(1.2)),
        paramsWith(base, { massKg: base.massKg * 0.9 }),
        paramsWith(base, { massKg: base.massKg * 1.1 }),
      ];
      const trajectory = demoTrajectory(base, 0.01);
      expect(trajectory.length).toBeGreaterThan(1000);
      for (const pv of variants) {
        let sum = 0;
        for (const s of trajectory) sum += Math.abs(rawLoad(pv, s.v, s.a) - rawLoad(base, s.v, s.a));
        expect(sum / trajectory.length).toBeLessThan(0.05);
      }
    },
  );
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npx vitest run tests/unit/catalogue.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/data/catalogue"`.

- [ ] **Step 10: Implement catalogue access**

Create `src/data/catalogue.ts`:

```ts
import { ETA_DRIVETRAIN, type RoadLoadRecord, type TeslaParams, type TeslaRecord } from '../contracts';
import roadloadJson from './roadload.json';
import paramsJson from './tesla-params.json';
import teslasJson from './teslas.json';

/** JSON imports widen literal unions to string; tesla/roadload schemas (tests + build tool) are the real guard. */
export const TESLAS: TeslaRecord[] = teslasJson as unknown as TeslaRecord[];
export const ROADLOAD: RoadLoadRecord[] = roadloadJson as unknown as RoadLoadRecord[];

/** Fitted at build time by tools/build-catalogue.ts (never edit by hand). */
const PARAMS = paramsJson as unknown as Record<string, { massKg: number; fTracN: number; pEffW: number }>;

/** "Not listed" road load (N, N·s/m, N·s²/m²) per body style (phase-1 contract). */
const NOT_LISTED_ROAD: Record<'sedan' | 'suv' | 'truck', TeslaParams['roadLoad']> = {
  sedan: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  suv: { A_N: 160, B_Nps_m: 1.5, C_Ns2_m2: 0.48 },
  truck: { A_N: 220, B_Nps_m: 2.0, C_Ns2_m2: 0.62 },
};
/** "No power term": large enough that η·P/v never binds below ~300 km/h. */
const NOT_LISTED_PEFF_W = 1e9;
const KMH100_MPS = 27.7778;

export function resolveTeslaParams(recordId: string, modeName?: string): TeslaParams {
  const record = TESLAS.find((r) => r.id === recordId);
  if (record === undefined) throw new Error(`Unknown Tesla record "${recordId}"`);
  const mode =
    modeName === undefined
      ? record.accelModes[record.accelModes.length - 1]
      : record.accelModes.find((m) => m.name === modeName);
  if (mode === undefined) throw new Error(`Tesla record "${recordId}" has no acceleration mode "${modeName ?? '(default)'}"`);
  const rl = ROADLOAD.find((x) => x.ref === record.roadLoadRef);
  if (rl === undefined) throw new Error(`Tesla record "${recordId}": roadLoadRef "${record.roadLoadRef}" not found`);
  const fitted = PARAMS[recordId];
  if (fitted === undefined) throw new Error(`Tesla record "${recordId}" has no fitted params (run tools/build-catalogue.ts)`);
  return {
    massKg: fitted.massKg,
    roadLoad: { A_N: rl.A_N, B_Nps_m: rl.B_Nps_m, C_Ns2_m2: rl.C_Ns2_m2 },
    fTracN: fitted.fTracN,
    pEffW: fitted.pEffW,
    eta: ETA_DRIVETRAIN,
    modeFactor: mode.factor,
  };
}

/** Params for a Tesla that is not in the catalogue (user enters 0–100 km/h time and mass, parked). */
export function notListedParams(zeroTo100S: number, massKg: number, body: 'sedan' | 'suv' | 'truck'): TeslaParams {
  if (!(Number.isFinite(zeroTo100S) && zeroTo100S > 0)) throw new RangeError(`zeroTo100S must be > 0, got ${zeroTo100S}`);
  if (!(Number.isFinite(massKg) && massKg > 0)) throw new RangeError(`massKg must be > 0, got ${massKg}`);
  const road = NOT_LISTED_ROAD[body];
  return {
    massKg,
    roadLoad: { A_N: road.A_N, B_Nps_m: road.B_Nps_m, C_Ns2_m2: road.C_Ns2_m2 },
    fTracN: massKg * (KMH100_MPS / zeroTo100S) * 1.25,
    pEffW: NOT_LISTED_PEFF_W,
    eta: ETA_DRIVETRAIN,
    modeFactor: 1,
  };
}
```

- [ ] **Step 11: Run the catalogue test — only the coverage test may fail now**

Run: `npx vitest run tests/unit/catalogue.test.ts`
Expected: 55 passed, 1 failed — `covers exactly the planned generation/trim list` (60 of the 72 records are compiled in Steps 13–21). Every other test (schemas, refs, modes, resolve, Not-listed, WOT, sensitivity) passes for the 12 records.

- [ ] **Step 12: Read the coverage table and the research procedure (reference for Steps 13–21)**

**Coverage (72 records — must equal `EXPECTED_IDS`).** Every Model S, X, 3, Y, Y L and Cybertruck generation + trim sold in the US/EU since 2012 (Model Y L: CN/AU/NZ/PH only — included because spec §9.1 names it). Use the `model`, `generation`, `years`, `trim`, `markets`, `mcu`, `supported` values exactly as listed (verify years/markets while researching; if a primary source contradicts a row, correct the row here, in `teslas.json` and in `EXPECTED_IDS` together and report it; if research finds a US/EU trim that is missing — a distinct power/acceleration configuration sold to the public — add a row to all three the same way). The EPA column is the suggested road-load row (MY = file model year; Test Vehicle ID in brackets; A lbf / B lbf·mph⁻¹ / C lbf·mph⁻²) — verify it in the EPA file before copying.

| id | model | generation | years | trim | markets | mcu | supported | suggested EPA Target row (MY · row · rated hp · ETW lb · A/B/C) |
|---|---|---|---|---|---|---|---|---|
| `models-2012-40` | Model S | 2012–2016 (original, MCU1) | 2013–2013 | 40 | US | tegra, intel | false | 2013 · S1 (MS113-L1S) · 301 hp · 4750 · 39.846 / 0.14526 / 0.015889 — software-limited 60 kWh pack — share the 2013 S1 row |
| `models-2012-60` | Model S | 2012–2016 (original, MCU1) | 2013–2015 | 60 | US, EU | tegra, intel | false | 2013 · S1 (MS113-L1S) · 301 hp · 4750 · 39.846 / 0.14526 / 0.015889 |
| `models-2012-85` | Model S | 2012–2016 (original, MCU1) | 2012–2015 | 85 (incl. Signature) | US, EU | tegra, intel | false | 2013 · S2 (MS212-L1S) · 362 hp · 4750 · 39.846 / 0.14526 / 0.015889 |
| `models-2012-p85` | Model S | 2012–2016 (original, MCU1) | 2012–2014 | P85 (incl. Signature Performance) | US, EU | tegra, intel | false | 2012 · S3 (MS312-L1S) · 362 hp · 4500 · 43.62 / 0.1984 / 0.016085 — S2/S3 → 85/P85 mapping unverified: confirm via Test Vehicle ID / test group on fueleconomy.gov |
| `models-2012-p85plus` | Model S | 2012–2016 (original, MCU1) | 2013–2014 | P85+ | US, EU | tegra, intel | false | 2012 · S3 (MS312-L1S) · 362 hp · 4500 · 43.62 / 0.1984 / 0.016085 — same powertrain as P85 |
| `models-2012-70` | Model S | 2012–2016 (original, MCU1) | 2015–2016 | 70 | US, EU | tegra, intel | false | 2016 · 75R (DS216-L1S) · 376 hp · 5000 · 40.35 / 0.1324 / 0.01557 — proxy: no MY2015 single-motor 70 row; 2016 75R (same body, single motor) |
| `models-2012-70d` | Model S | 2012–2016 (original, MCU1) | 2015–2016 | 70D | US, EU | tegra, intel | false | 2015 · 70D (DS215-L2S) · 376 hp · 5000 · 36.23 / 0.1906 / 0.01746 |
| `models-2012-85d` | Model S | 2012–2016 (original, MCU1) | 2015–2016 | 85D | US, EU | tegra, intel | false | 2015 · 85D (DS315-L2S) · 376 hp · 5000 · 36.23 / 0.1906 / 0.01746 |
| `models-2012-p85d` | Model S | 2012–2016 (original, MCU1) | 2014–2015 | P85D | US, EU | tegra, intel | false | 2015 · P85D (DP315-L2S) · 449 hp · 5250 · 41.91 / 0.0257 / 0.01961 |
| `models-2012-90d` | Model S | 2012–2016 (original, MCU1) | 2015–2016 | 90D | US, EU | tegra, intel | false | 2016 · 90D (DS316-L2S) · 376 hp · 5000 · 39.24 / 0.1493 / 0.01514 |
| `models-2012-p90d` | Model S | 2012–2016 (original, MCU1) | 2015–2016 | P90D | US, EU | tegra, intel | false | 2016 · P90D (DP316-L2S) · 376 hp · 5250 · 41.51 / 0.2226 / 0.01403 |
| `models-2016-60` | Model S | 2016–2018 facelift (MCU1) | 2016–2017 | 60 | US, EU | tegra, intel | false | 2016 · 60R (MS116-L1S) · 376 hp · 5000 · 40.35 / 0.1324 / 0.01557 |
| `models-2016-60d` | Model S | 2016–2018 facelift (MCU1) | 2016–2017 | 60D | US, EU | tegra, intel | false | 2016 · 60D (DS116-L2S) · 376 hp · 5000 · 37.37 / 0.1842 / 0.01508 |
| `models-2016-75` | Model S | 2016–2018 facelift (MCU1) | 2016–2017 | 75 | US, EU | tegra, intel | false | 2016 · 75R (DS216-L1S) · 376 hp · 5000 · 40.35 / 0.1324 / 0.01557 |
| `models-2016-75d` | Model S | 2016–2018 facelift (MCU1) | 2016–2018 | 75D | US, EU | tegra, intel | false | 2016 · 75D (DS216-L2S) · 376 hp · 5000 · 37.37 / 0.1842 / 0.01508 |
| `models-2016-90d` | Model S | 2016–2018 facelift (MCU1) | 2016–2017 | 90D | US, EU | tegra, intel | false | 2016 · 90D (DS316-L2S) · 376 hp · 5000 · 39.24 / 0.1493 / 0.01514 |
| `models-2016-p90d` | Model S | 2016–2018 facelift (MCU1) | 2016–2016 | P90D | US, EU | tegra, intel | false | 2016 · P90D (DP316-L2S) · 376 hp · 5250 · 41.51 / 0.2226 / 0.01403 |
| `models-2016-100d` | Model S | 2016–2018 facelift (MCU1) | 2017–2018 | 100D | US, EU | tegra, intel | false | 2017 · 100D (DS417-172225) · 376 hp · 5250 · 40.52 / 0.1677 / 0.01614 |
| `models-2016-p100d` | Model S | 2016–2018 facelift (MCU1) | 2016–2018 | P100D | US, EU | tegra, intel | false | 2016 · P100D (DP416-L2S) · 376 hp · 5250 · 41.35 / 0.267 / 0.0137 |
| `models-2018-75d` | Model S | 2018–2021 (MCU2) | 2018–2019 | 75D | US, EU | intel | true | 2018 · 75D (DS216-L2S) · 376 hp · 5000 · 37.37 / 0.1842 / 0.01508 |
| `models-2018-100d` | Model S | 2018–2021 (MCU2) | 2018–2019 | 100D | US, EU | intel | true | 2018 · 100D (DS417-172225) · 376 hp · 5250 · 40.52 / 0.1677 / 0.01614 |
| `models-2018-p100d` | Model S | 2018–2021 (MCU2) | 2018–2019 | P100D | US, EU | intel | true | 2018 · P100D (DP416-L2S) · 376 hp · 5250 · 41.35 / 0.267 / 0.0137 |
| `models-2018-standard-range` | Model S | 2018–2021 (MCU2) | 2019–2019 | Standard Range | US, EU | intel | true | 2019 · Model S Standard Range (SD019-271490) · 534 hp · 5000 · 40.218 / 0.0604 / 0.01708 |
| `models-2018-long-range` | Model S | 2018–2021 (MCU2) | 2019–2020 | Long Range | US, EU | intel | true | 2019 · Model S Long Range (SD219-262105) · 398 hp · 5250 · 41.4 / 0.1592 / 0.01635 |
| `models-2018-performance` | Model S | 2018–2021 (MCU2) | 2019–2021 | Performance | US, EU | intel | true | 2020 · Model S Performance (19" Wheel) (SD219-295248) · 580 hp · 5250 · 53.9 / 0.03759 / 0.0161 — A = 53.9 lbf is high but is the EPA Target value |
| `models-2018-long-range-plus` | Model S | 2018–2021 (MCU2) | 2020–2021 | Long Range Plus | US, EU | intel | true | 2020 · Model S Long Range Plus (SD220-381503) · 534 hp · 5000 · 30.61 / 0.645 / 0.0094 |
| `models-2021-long-range` | Model S | 2021– (Palladium) | 2021–2026 | Long Range / All-Wheel Drive | US, EU | amd | true | 2026 · Model S Long Range (SD225-547476) · 658 hp · 4750 · 26.37 / 0.3082 / 0.0139 |
| `models-2021-plaid` | Model S | 2021– (Palladium) | 2021–2026 | Plaid | US, EU | amd | true | 2026 · Model S Plaid (ST326-549469) · 1006 hp · 5000 · 32.1 / 0.3202 / 0.01396 |
| `models-2021-standard-range` | Model S | 2021– (Palladium) | 2023–2023 | Standard Range | US | amd | true | 2023 · Model S Long Range (SD321-428324) · 662 hp · 4750 · 28.99 / 0.4592 / 0.0111 — software-limited Long Range; use its MY2023 row |
| `modelx-2015-60d` | Model X | 2015–2018 (MCU1) | 2016–2016 | 60D | US, EU | tegra, intel | false | 2016 · 60D (XB116-L2X) · 417 hp · 5500 · 37.68 / 0.0486 / 0.0214 |
| `modelx-2015-75d` | Model X | 2015–2018 (MCU1) | 2016–2018 | 75D | US, EU | tegra, intel | false | 2016 · 75D (XB216-L2X) · 417 hp · 5500 · 37.68 / 0.0486 / 0.0214 |
| `modelx-2015-90d` | Model X | 2015–2018 (MCU1) | 2015–2017 | 90D | US, EU | tegra, intel | false | 2016 · 90D (XB316-L2X) · 417 hp · 5500 · 37.68 / 0.0486 / 0.0214 |
| `modelx-2015-p90d` | Model X | 2015–2018 (MCU1) | 2015–2016 | P90D | US, EU | tegra, intel | false | 2016 · P100D (XP416-L2X) · 713 hp · 6000 · 46.87 / -0.0518 / 0.02166 — proxy: no P90D X row found; use P100D (same drive units/body) |
| `modelx-2015-100d` | Model X | 2015–2018 (MCU1) | 2017–2018 | 100D | US, EU | tegra, intel | false | 2017 · 100D (XB417-026625) · 517 hp · 6000 · 35.49 / 0.1972 / 0.02044 |
| `modelx-2015-p100d` | Model X | 2015–2018 (MCU1) | 2016–2018 | P100D | US, EU | tegra, intel | false | 2016 · P100D (XP416-L2X) · 713 hp · 6000 · 46.87 / -0.0518 / 0.02166 |
| `modelx-2018-75d` | Model X | 2018–2021 (MCU2) | 2018–2019 | 75D | US, EU | intel | true | 2018 · 75D (XB216-L2X) · 417 hp · 5500 · 37.68 / 0.0486 / 0.0214 |
| `modelx-2018-100d` | Model X | 2018–2021 (MCU2) | 2018–2019 | 100D | US, EU | intel | true | 2018 · 100D (XB417-026625) · 517 hp · 6000 · 35.49 / 0.1972 / 0.02044 |
| `modelx-2018-p100d` | Model X | 2018–2021 (MCU2) | 2018–2019 | P100D | US, EU | intel | true | 2018 · P100D (XP416-L2X) · 713 hp · 6000 · 46.87 / -0.0518 / 0.02166 |
| `modelx-2018-standard-range` | Model X | 2018–2021 (MCU2) | 2019–2019 | Standard Range | US, EU | intel | true | 2019 · Model X Standard Range (XD019-133320) · 534 hp · 5500 · 40.32 / 0.099 / 0.02136 |
| `modelx-2018-long-range` | Model X | 2018–2021 (MCU2) | 2019–2020 | Long Range | US, EU | intel | true | 2019 · Model X Long Range (XD219-126944) · 534 hp · 6000 · 42.36 / 0.1836 / 0.01982 |
| `modelx-2018-performance` | Model X | 2018–2021 (MCU2) | 2019–2021 | Performance | US, EU | intel | true | 2019 · Model X Performance (20" Wheels) (XD219-138648) · 778 hp · 6000 · 52.33 / -0.0052 / 0.02101 |
| `modelx-2018-long-range-plus` | Model X | 2018–2021 (MCU2) | 2020–2021 | Long Range Plus | US, EU | intel | true | 2020 · Model X Long Range Plus (XD220-234408) · 534 hp · 5500 · 40.32 / 0.1029 / 0.0192 |
| `modelx-2021-long-range` | Model X | 2021– (Palladium) | 2021–2026 | Long Range / All-Wheel Drive | US, EU | amd | true | 2026 · Model X (XD226-468565) · 666 hp · 5500 · 33.38 / 0.2674 / 0.01659 |
| `modelx-2021-plaid` | Model X | 2021– (Palladium) | 2021–2026 | Plaid | US, EU | amd | true | 2026 · Model X Plaid (XT326-469483) · 925 hp · 5500 · 31.45 / 0.3973 / 0.0162 |
| `model3-2017-lr-rwd` | Model 3 | 2017–2023 (original) | 2017–2019 | Long Range RWD | US | intel | true | 2018 · Long Range (3R217-R00012) · 258 hp · 4250 · 38.51 / -0.0811 / 0.0161 |
| `model3-2017-mid-range` | Model 3 | 2017–2023 (original) | 2018–2019 | Mid Range RWD | US | intel | true | 2019 · Mid Range RWD (3R118-101926) · 270 hp · 4250 · 36.91 / -0.113 / 0.01647 |
| `model3-2017-standard-range` | Model 3 | 2017–2023 (original) | 2019–2019 | Standard Range RWD | US | intel | true | 2019 · Model 3 Standard Range RWD (3R019-297396) · 282 hp · 3875 · 36.01 / -0.1289 / 0.01667 |
| `model3-2017-sr-plus` | Model 3 | 2017–2023 (original) | 2019–2021 | Standard Range Plus | US, EU | intel | true | 2020 · Model 3 Standard Range Plus RWD (3R020-429179) · 282 hp · 3875 · 29.62 / 0.2465 / 0.0112 |
| `model3-2017-rwd` | Model 3 | 2017–2023 (original) | 2021–2023 | RWD | US, EU | intel, amd | true | 2022 · Model 3 RWD (3R022-043763) · 257 hp · 4250 · 37.17 / 0.047 / 0.0144 |
| `model3-2017-lr-awd` | Model 3 | 2017–2023 (original) | 2018–2023 | Long Range AWD | US, EU | intel, amd | true | 2021 · Model 3 Long Range AWD (3D221-731644) · 393 hp · 4250 · 34.98 / 0.0867 / 0.0149 |
| `model3-2017-performance` | Model 3 | 2017–2023 (original) | 2018–2023 | Performance | US, EU | intel, amd | true | 2021 · Model 3 Performance AWD (3D221-731645) · 430 hp · 4250 · 49.01 / -0.2001 / 0.02 |
| `model3-highland-rwd` | Model 3 | Highland (2023–) | 2023–2025 | RWD | US, EU | amd | true | done in Steps 4–5 |
| `model3-highland-lr-rwd` | Model 3 | Highland (2023–) | 2024–2026 | Long Range RWD / Premium RWD | US, EU | amd | true | done in Steps 4–5 |
| `model3-highland-lr-awd` | Model 3 | Highland (2023–) | 2023–2026 | Long Range AWD / Premium AWD | US, EU | amd | true | done in Steps 4–5 |
| `model3-highland-performance` | Model 3 | Highland (2023–) | 2024–2026 | Performance | US, EU | amd | true | done in Steps 4–5 |
| `model3-highland-standard` | Model 3 | Highland (2023–) | 2025–2026 | Standard | US, EU | amd | true | done in Steps 4–5 |
| `modely-2020-lr-awd` | Model Y | 2020–2025 (original) | 2020–2025 | Long Range AWD | US, EU | intel, amd | true | 2024 · Model Y Long Range AWD (YD224-922405) · 390 hp · 4750 · 38.35 / 0.0677 / 0.0171 |
| `modely-2020-performance` | Model Y | 2020–2025 (original) | 2020–2025 | Performance | US, EU | intel, amd | true | 2024 · Model Y Performance AWD (YD224-970022) · 452 hp · 4750 · 39.409 / 0.2207 / 0.0169 |
| `modely-2020-sr-rwd` | Model Y | 2020–2025 (original) | 2021–2021 | Standard Range RWD | US | intel | true | 2021 · Model Y Standard Range RWD (YR121-033006) · 280 hp · 4250 · 25.02 / 0.4847 / 0.0121 |
| `modely-2020-awd` | Model Y | 2020–2025 (original) | 2022–2024 | AWD (Standard Range AWD) | US | amd | true | 2023 · Model Y AWD (YD122-000067) · 390 hp · 4750 · 34.26 / 0.3191 / 0.0142 |
| `modely-2020-rwd` | Model Y | 2020–2025 (original) | 2022–2025 | RWD | US, EU | amd | true | 2024 · Model Y RWD (YR124-944436) · 272 hp · 4500 · 36.35 / 0.0507 / 0.0178 |
| `modely-2020-lr-rwd` | Model Y | 2020–2025 (original) | 2024–2025 | Long Range RWD | US, EU | amd | true | 2024 · Model Y Long Range RWD (YR124-082300) · 296 hp · 4500 · 36.35 / 0.0507 / 0.0178 — same coefficients as the 2024 Model Y RWD row |
| `modely-juniper-rwd-eu` | Model Y | Juniper (2025–) | 2025–2025 | RWD (EU base, 2025) | EU | amd | true | done in Steps 4–5 |
| `modely-juniper-standard-rwd` | Model Y | Juniper (2025–) | 2025–2026 | Standard RWD | US, EU | amd | true | done in Steps 4–5 |
| `modely-juniper-standard-awd` | Model Y | Juniper (2025–) | 2026–2026 | Standard AWD | US | amd | true | done in Steps 4–5 |
| `modely-juniper-lr-rwd` | Model Y | Juniper (2025–) | 2025–2026 | Long Range RWD / Premium RWD | US, EU | amd | true | done in Steps 4–5 |
| `modely-juniper-lr-awd` | Model Y | Juniper (2025–) | 2025–2026 | Long Range AWD / Premium AWD (incl. Launch Series) | US, EU | amd | true | done in Steps 4–5 |
| `modely-juniper-performance` | Model Y | Juniper (2025–) | 2025–2026 | Performance | US, EU | amd | true | done in Steps 4–5 |
| `modelyl-2025-awd` | Model Y L | Model Y L (2025–) | 2025–2026 | Premium Long Range AWD (6-seat) | CN, other | amd | true | done in Steps 4–5 |
| `cybertruck-awd` | Cybertruck | 2023– (first generation) | 2023–2026 | AWD (incl. Foundation Series) | US, other | amd | true | 2026 · Cybertruck AWD (CD225-059245) · 621 hp · 7000 · 38.64 / 0.411 / 0.0265 |
| `cybertruck-cyberbeast` | Cybertruck | 2023– (first generation) | 2023–2026 | Cyberbeast (incl. Foundation Series) | US, other | amd | true | 2026 · Cybertruck AWD (CD225-059245) · 621 hp · 7000 · 38.64 / 0.411 / 0.0265 — proxy: no separate Cyberbeast row; AWD row (same body) |
| `cybertruck-lr-rwd` | Cybertruck | 2023– (first generation) | 2025–2025 | Long Range RWD | US, other | amd | true | 2025 · Cybertruck Long Range (CR125-00760) · 321 hp · 6500 · 32.17 / 0.2041 / 0.032 — MY2025 "Cybertruck Long Range", 2-Wheel Drive, Rear row |

EPA file URLs by model year: 2012–2016 `https://www.epa.gov/sites/default/files/2016-07/<yy>tstcar.csv` (yy = 12…16); 2017 `https://www.epa.gov/sites/default/files/2018-06/17tstcar-2018-05-30.xlsx`; 2018 `https://www.epa.gov/sites/default/files/2018-10/18tstcar-2018-10-24.xlsx`; 2019 `https://www.epa.gov/sites/default/files/2020-10/19tstcar-2020-10-02.xlsx`; 2020 `https://www.epa.gov/sites/default/files/2021-03/20tstcar-2021-03-02.xlsx`; 2021 `https://www.epa.gov/system/files/documents/2022-04/21-tstcar-2022-04-15.xlsx`; 2022 `https://www.epa.gov/system/files/documents/2023-06/22-testcar-2023-06-13.xlsx`; 2023 `https://www.epa.gov/system/files/documents/2024-05/23-testcar-2024-05-17_0.xlsx`; 2024 `https://www.epa.gov/system/files/documents/2025-05/24-testcar-2025-05.xlsx`; 2025 `https://www.epa.gov/system/files/documents/2026-01/25-testcar-2026-01-21.xlsx`; 2026 `https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx`. Query with the helper from Task 10 Step 8 rule 10 (make `tesla`, model regex e.g. `"^P100D$"`; the helper matches the make in `Vehicle Manufacturer Name` too — the 2013 file lists the S1/S2 rows with make `Model S`); in the 2012–2018 files the model column holds only the trim, so tell Model S from X by the Test Vehicle ID prefix (`MS`/`DS`/`DP`/`SD`/`ST` = Model S, `XB`/`XP`/`XD`/`XT` = Model X, `3R`/`3D` = Model 3, `YR`/`YD` = Model Y, `CR`/`CD` = Cybertruck).

**Per-record procedure (one research agent per step).** Steps 13–21 run one after another, never in parallel: each step appends to the shared `src/data/raw/roadload-src.json` and `src/data/teslas.json`, and rule 10 regenerates the shared `roadload.json` / `tesla-params.json` from them. If they must run in parallel, each agent returns its `teslas.json` records and `roadload-src.json` entries in its report without touching any shared file; the coordinator merges them, then runs rule 10 for those ids. For each id of the step:
1. **Road load.** Verify the suggested EPA row; append to `src/data/raw/roadload-src.json` an `epa` entry with `ref` = `<id>-<model year>` (or reuse an existing ref when two records share the identical row), `testCarRow` = the EPA model string verbatim, `ratedHp`, `etwLb`, `target` (Target A/B/C exactly as printed), `file` = the URL, and `note` for proxies/oddities. If no plausible row exists, use the closest same-body EPA row with a `note`, or a `derived` entry (`cdA_m2` = Tesla's published Cd × frontal area from a primary document, `crr` 0.009 unless documented, `massKg` = test mass, `sources`).
2. **Mass.** Tesla US curb weight for that trim and year (Tesla US spec page snapshot or the owner's manual "Specifications → Weights"); kg = lb × 0.45359237 rounded; `massBasis: 'us-curb'`. EU-only trims: Tesla EU "Leergewicht"/curb (excludes driver) → also `'us-curb'` and say so in the source; an EU CoC "mass in running order" (includes 75 kg driver) → `'eu-unladen-incl-driver'`.
3. **Power.** EPA rated hp of the record's own road-load row × 0.7457, 1 decimal (cite the EPA file). If the row is a proxy or absent: Tesla / EU homologation kW, else Wikipedia (last resort) — state it.
4. **Acceleration.** Tesla's published figure for that trim and year: US 0–60 mph (`'0-60mph'`) or EU 0–100 km/h (`'0-100kmh'`) for EU-only trims; `rolloutSubtracted` = true only if the page/footnote says "with rollout subtracted" (EU: "mit abgezogenem Rollout"). Use the quickest factory configuration of that trim (e.g. Ludicrous where standard).
5. **Modes.** Names from the owner's manual of that generation (Acceleration Modes page — list exactly the modes the manual gives that trim; e.g. Model S/X: Chill / Sport / Insane or Ludicrous or Plaid; Highland/Juniper Model 3/Y: Chill / Standard on non-Performance cars, while Performance replaces Standard: Model 3 Performance Chill / Insane, Model Y Performance Chill / Sport / Insane; Cybertruck: from its manual); factors Chill 0.5, a single intermediate mode 0.85, two intermediate modes 0.7 then 0.85 (in the manual's order), quickest 1.0 (strictly ascending, last = 1). Add the source line `"<manual page URL> — accelModes factors are Tesbox estimates (Chill 0.5, intermediate 0.85, top 1.0)"` (with two intermediate modes: `(Chill 0.5, intermediates 0.7 / 0.85, top 1.0)`).
6. **Audio.** `subwooferDefault` = the trim's standard audio has a subwoofer (Tesla spec pages, owner's manual, reputable audio reviews — e.g. Model S/X 2021+: 22 speakers incl. subwoofer; Model 3 2017–2023 SR/SR+/RWD: no subwoofer, LR/Performance: trunk subwoofer; Model Y pre-Juniper RWD built from Jan 2024: 7 speakers, no subwoofer; Cybertruck: 15 speakers incl. 2 subwoofers). When builds differ, pick the majority and cite both.
7. **MCU / supported.** Exactly as in the table: S/X built before March 2018 are MCU1 → `["tegra", "intel"]` (intel = MCU2 retrofit) and `supported: false`; S/X 2018–2021 `["intel"]`; Palladium, Cybertruck, Highland, Juniper, Y L `["amd"]`; Model 3/Y per row. The test enforces `supported === !mcu.includes('tegra')`.
8. **Sources.** ≥ 1 per group (`mass`, `power`, `accel`, `audio`), each `"<publisher>, <page/document and snapshot date> (<the fact>): <URL>"`.
9. **Wayback method** (tesla.com blocks scripts):

   ```bash
   # monthly snapshots of a page
   curl -sS "http://web.archive.org/cdx/search/cdx?url=tesla.com/models&from=2019&to=2021&output=json&filter=statuscode:200&collapse=timestamp:6"
   # raw snapshot (note the id_ suffix), decompress if needed, print visible text
   curl -sSL --compressed "http://web.archive.org/web/<timestamp>id_/https://www.tesla.com/models" -o page.html
   if gzip -t page.html 2>/dev/null; then gzip -dc page.html > page.tmp && mv page.tmp page.html; fi
   python3 - page.html <<'EOF'
   import html, re, sys
   s = open(sys.argv[1], encoding='utf-8', errors='replace').read()
   s = re.sub(r'<(script|style).*?</\1>', ' ', s, flags=re.S)
   print(' | '.join(l.strip() for l in html.unescape(re.sub(r'<[^>]+>', '\n', s)).split('\n') if l.strip()))
   EOF
   ```

   Cite the snapshot as `http://web.archive.org/web/<timestamp>/https://www.tesla.com/<page>`. Owner's manual pages: `https://www.tesla.com/ownersmanual/<model>/en_us/<GUID>.html` via the same CDX query.
10. **Rebuild and test** after each step: `npx tsx tools/build-catalogue.ts` (warnings: none expected — with the contract-A7 bracket of 1.3·m·G even the Plaid's ≈ 1.22 g fits; investigate any warning: data error first, then a genuinely unreachable figure to report) then `npx vitest run tests/unit/catalogue.test.ts -t "<id prefix>"` (e.g. `-t "models-2012-"`) → all tests for the new ids pass.

- [ ] **Step 13: Compile Model S 2012–2016 (original, MCU1) — 11 records**

Ids: `models-2012-40`, `models-2012-60`, `models-2012-85`, `models-2012-p85`, `models-2012-p85plus`, `models-2012-70`, `models-2012-70d`, `models-2012-85d`, `models-2012-p85d`, `models-2012-90d`, `models-2012-p90d`. Masses/0–60 from Tesla pages of 2012–2016 (Wayback `/models`, `/models/design`) or the 2012–2016 Model S owner's manual; P85D/P90D "Insane"/"Ludicrous" times as published (check rollout footnotes). Follow Step 12, then rebuild and run `npx vitest run tests/unit/catalogue.test.ts -t "models-2012-"`.

- [ ] **Step 14: Compile Model S 2016–2018 facelift (MCU1) — 8 records**

Ids: `models-2016-60`, `models-2016-60d`, `models-2016-75`, `models-2016-75d`, `models-2016-90d`, `models-2016-p90d`, `models-2016-100d`, `models-2016-p100d` (built April 2016 – March 2018, MCU1). Follow Step 12; test with `-t "models-2016-"`.

- [ ] **Step 15: Compile Model S 2018–2021 (MCU2) — 7 records**

Ids: `models-2018-75d`, `models-2018-100d`, `models-2018-p100d`, `models-2018-standard-range`, `models-2018-long-range`, `models-2018-performance`, `models-2018-long-range-plus` (Intel MCU2 from March 2018; "Raven" from April 2019). Follow Step 12; test with `-t "models-2018-"`.

- [ ] **Step 16: Compile Model S 2021– (Palladium) — 3 records**

Ids: `models-2021-long-range`, `models-2021-plaid`, `models-2021-standard-range` (2023 software-limited Long Range; US). Plaid: 0–60 1.99 s with rollout subtracted → fits within the contract-A7 bracket at F_trac ≈ 1.22·m·G (no warning). Follow Step 12; test with `-t "models-2021-"`.

- [ ] **Step 17: Compile Model X 2015–2018 (MCU1) — 6 records**

Ids: `modelx-2015-60d`, `modelx-2015-75d`, `modelx-2015-90d`, `modelx-2015-p90d`, `modelx-2015-100d`, `modelx-2015-p100d`. Follow Step 12; test with `-t "modelx-2015-"`.

- [ ] **Step 18: Compile Model X 2018–2021 (MCU2) and 2021– (Palladium) — 9 records**

Ids: `modelx-2018-75d`, `modelx-2018-100d`, `modelx-2018-p100d`, `modelx-2018-standard-range`, `modelx-2018-long-range`, `modelx-2018-performance`, `modelx-2018-long-range-plus`, `modelx-2021-long-range`, `modelx-2021-plaid`. Follow Step 12; test with `-t "modelx-20(18|21)-"`.

- [ ] **Step 19: Compile Model 3 2017–2023 (original) — 7 records**

Ids: `model3-2017-lr-rwd`, `model3-2017-mid-range`, `model3-2017-standard-range`, `model3-2017-sr-plus`, `model3-2017-rwd`, `model3-2017-lr-awd`, `model3-2017-performance` (Intel MCU until late 2021, AMD after; Tesla `/model3` snapshots 2017–2023 and the 2017–2023 Model 3 owner's manual `/ownersmanual/2017_2023_model3/en_us/`). Follow Step 12; test with `-t "model3-2017-"`.

- [ ] **Step 20: Compile Model Y 2020–2025 (original) — 6 records**

Ids: `modely-2020-lr-awd`, `modely-2020-performance`, `modely-2020-sr-rwd`, `modely-2020-awd`, `modely-2020-rwd`, `modely-2020-lr-rwd`. Note the 2025 EPA "Model Y Performance AWD" row is the carried-over pre-Juniper car (use it here, never for Juniper). Follow Step 12; test with `-t "modely-2020-"`.

- [ ] **Step 21: Compile Cybertruck — 3 records**

Ids: `cybertruck-awd`, `cybertruck-cyberbeast`, `cybertruck-lr-rwd` (Tesla `/cybertruck` snapshots; Cyberbeast 0–60 2.6 s with rollout subtracted). The EPA 2025/2026 files also list a "Cybertruck Long Range" All-Wheel-Drive configuration: if research shows it was a separately sold trim, add a row (`cybertruck-lr-awd`) to the coverage table, `teslas.json` and `EXPECTED_IDS` together; otherwise ignore it. Follow Step 12; test with `-t "cybertruck-"`.

- [ ] **Step 22: Regenerate, run both catalogue tests and the check mode**

Run: `npx tsx tools/build-catalogue.ts`
Expected: writes both files, no warnings.

Run: `npx vitest run tests/unit/catalogue.test.ts tests/unit/build-catalogue.test.ts`
Expected: PASS — all tests, including `covers exactly the planned generation/trim list`, the 72 × WOT and 72 × sensitivity tests, and `are up to date (build-catalogue --check passes)`.

Run: `npx tsx tools/build-catalogue.ts --check`
Expected: `Catalogue up to date.` and exit code 0.

- [ ] **Step 23: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no errors. (In a parallel wave this step runs once, after every task of the wave is done — plan header, Execution order; a TS2307 or lint error in another in-flight task's file is not this task's failure.)

---

### Task 12: Phase 1 clean-room log, NOTICES, wiring and hot-path audits, final verification

**Files:**
- Modify: `docs/CLEAN_ROOM.md` (append the Phase 1 source log)
- Modify: `NOTICES` (one line: Ajv in the development/test tools list — Phase 0's policy lists every test-only tool there; outside the Phase 1 file map, listed in the plan header's Concerns section, PC13)

**Interfaces:**
- Consumes: every Phase 1 module and data file of the phase contract file map — `src/sim/{tyre,epa,speed-filter,replay,load,shift-map,gearbox,driveline,demo,sim-core}.ts`, `src/data/{voicing-defaults,catalogue}.ts`, `src/data/engines/index.ts` + 15 engine JSONs, `src/data/{teslas,roadload,tesla-params}.json`, `src/data/raw/roadload-src.json`, `src/data/schema/*.json`, `tools/{build-catalogue,make-synthetic-replay,gpx-to-replay}.ts`, `tests/fixtures/replay/*.json`, `tests/unit/*.test.ts` (incl. `criterion-a.test.ts`); devDependency `typescript` (its compiler API parses `src/sim/**` in Step 6).
- Produces: no code API. Deliverables: the Phase 1 section of `docs/CLEAN_ROOM.md`, the Ajv line in `NOTICES`, and a green full verification (`npm run verify`, `build-catalogue --check`, both audits) that gates the single Phase 1 commit (made outside this plan).

**Cross-task premises:**
- Every Phase 1 task (1–11) is complete; each module in `src/sim/` and `src/data/` has its own `tests/unit/<module>.test.ts` (contract: one test file per module; `src/data/engines/index.ts` is covered by `tests/unit/engines.test.ts`), and each Phase 1 tool has `tests/unit/<tool>.test.ts` (`build-catalogue`, `make-synthetic-replay`, `gpx-to-replay`).
- `src/sim/sim-core.ts` (Task 8) imports — directly or transitively — `speed-filter`, `load`, `gearbox` (→ `shift-map`), `driveline`, `demo`, `tyre` (contract: "configure … configures every sub-model"); `src/data/catalogue.ts` imports the three catalogue JSONs; `tools/build-catalogue.ts` imports `src/sim/epa.ts`. Two Phase 1 modules are intentionally NOT on a runtime path and are allow-listed in the audit: `src/sim/replay.ts` (Replay feeder, used by `tests/unit/replay.test.ts` / `criterion-a.test.ts`; the worklet's Replay source arrives in a later phase) and `src/data/voicing-defaults.ts` (authoring helper that generated every engine `voicing`; used by tests and later by the Sound Lab). The audit fails if an allow-listed module becomes reachable, so the list cannot go stale.
- Phase 0 created `docs/CLEAN_ROOM.md` (headings `# Clean-room log`, `## Policy`, `## Phase 0 source log` with columns `| Module | Algorithm | Source |`, `## Planned sources …`, `## Patents checked …`) and `NOTICES` (a "Development and test tools (not shipped to users):" list containing the line `  TypeScript, Playwright — Apache-2.0`). Open both and confirm before editing.
- Phase 0 `tests/unit/repo-files.test.ts` scans `docs/CLEAN_ROOM.md` and `NOTICES` and allows no IPv4-like literal except `127.0.0.1`; it also requires `jsQR — Apache-2.0` and the non-affiliation line in `NOTICES`. The text added here contains no dotted quads and keeps those lines.
- `tools/make-synthetic-replay.ts` (Task 3) documents its PRNG and noise model in its header; Step 4 checks the clean-room wording against it.
- Hot-path rule (phase contract, global rules): methods `step`, `accept`, `evaluate`, `update`, `tick`, `next`, `request` in `src/sim/**` contain no `new`, array/object literals, closures, spread, template literals, `try`/`throw`. The rule covers the private helpers and functions they call as well (Tasks 2, 5, 8). Phase 2a adds the enforcing ESLint rule; Step 6 checks it now with the TypeScript parser on the hot methods and, transitively, every `src/sim` helper they call (exact syntax kinds, so `case x: {` blocks and type annotations such as `: { a: number }` are not false positives).
- Criterion (a) (`tests/unit/criterion-a.test.ts`, Task 3) asserts the contract-A1 bounds: speed path p95 ≤ latencyS + cadenceS + 0.2 (2.2 s) and position-only path p95 ≤ latencyS + 2·cadenceS (3.0 s); both are plain assertions (no `it.fails`).
- Spec §15's exit gate needs the vehicle + data tests green on synthetic AND recorded Replay fixtures: `tests/unit/replay.test.ts` (Task 3) runs every committed `tests/fixtures/replay/*.json` with `meta.source: 'gpx'` and shows a skipped placeholder test while there is none.

All commands run from the repository root.

- [ ] **Step 1: Run the clean-room and privacy greps**

```bash
grep -rniE "rupteur|juniper-sound-lab|unendless" src tools tests --exclude=repo-files.test.ts || echo "OK: no forbidden references"
grep -rlE '"(lat|lon|latitude|longitude)"[[:space:]]*:' tests/fixtures src/data || echo "OK: no coordinates in fixtures/data"
grep -rnE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" src tools tests --include=*.ts --include=*.json | grep -v "127\.0\.0\.1" || echo "OK: no IP-like literals"
{ git ls-files; git ls-files --others --exclude-standard; } | grep -iE "\.gpx$" && echo "STOP: GPX input present — delete it, never commit GPX" || echo "OK: no GPX files"
```

Expected: the four `OK:` lines. (`tests/unit/repo-files.test.ts` is excluded from the first grep because Phase 0's test asserts that `docs/CLEAN_ROOM.md` *mentions* rupteur.app and juniper-sound-lab.) Any hit → remove the reference / coordinate / address (fixtures carry `sAlongM` only; the README domain placeholder is `https://tesbox.example.com`).

- [ ] **Step 2: Append the Phase 1 source log to `docs/CLEAN_ROOM.md`**

Append exactly (after the last line of the file, separated by one blank line):

```markdown
## Phase 1 source log — vehicle model, catalogue data and tools

Policy check for this phase: nothing from rupteur.app, its repositories or any app or repo that references it (e.g. github.com/UnendlessGit/juniper-sound-lab) was fetched, opened or used. No GPL, non-commercial or unlicensed code (SDT, PTR code/dataset, sedicivalvole, Farnell's Pd patches) was read. Every algorithm below was implemented from the cited public documents or from first principles; every engine and Tesla number carries per-field-group sources in its JSON.

| Module | Algorithm | Source |
|---|---|---|
| `src/sim/tyre.ts` | ISO metric tyre code → unloaded diameter 2·w·ar/100 + rim·25.4 mm; rolling circumference π·D·0.97; engine rpm = v / C · overall ratio · 60 | ISO 4000-1 tyre designation; 0.97 dynamic-radius factor checked against US EPA Test Car List N/V values (docs/research/2026-10-05-platform-research.json, topic `drivetrain`) |
| `src/sim/epa.ts` | EPA Target coefficients lbf, lbf/mph, lbf/mph² → N, N·s/m, N·s²/m² | NIST SP 811 conversion factors (1 lbf = 4.448222 N, 1 mph = 0.44704 m/s); US EPA Test Car List column definitions |
| `src/sim/speed-filter.ts` | 3-state [s, v, a] Kalman filter with white-noise-jerk process noise, sequential scalar position/speed updates with a symmetrised covariance, saturating acceleration prediction to "now", standstill hysteresis with a position deadband, arrival-based dropout, re-seed after fix gaps longer than 60 s, zero-speed plausibility rule with a speed-unusable latch | R. E. Kalman, "A New Approach to Linear Filtering and Prediction Problems", *J. Basic Eng.* 82 (1960); Y. Bar-Shalom, X. R. Li, T. Kirubarajan, *Estimation with Applications to Tracking and Navigation*, Wiley 2001 (kinematic state models); W3C *Geolocation* (`coords.speed` semantics) |
| `src/sim/replay.ts`, `tools/make-synthetic-replay.ts`, `tools/gpx-to-replay.ts` | Deterministic synthetic GPS traces (mulberry32 PRNG, Gaussian noise via Box–Muller, first-order Gauss–Markov position noise; the stoplight trace adds a white component), GPX track parsing, cumulative haversine distance, resampling to a fixed cadence, positions stripped | TopoGrafix *GPX 1.1 Schema*; G. E. P. Box & M. E. Muller, "A Note on the Generation of Random Normal Deviates", *Ann. Math. Statist.* 29 (1958); first principles (haversine: Phase 0 row) |
| `src/sim/load.ts` | F = m·a + A + B·v + C·v²; F_max = modeFactor·min(F_trac, η·P/max(v, 1)); one-pole low-pass + deadband | Newton's second law; road-load equation of the EPA coast-down procedure (40 CFR Part 1066) |
| `src/sim/shift-map.ts`, `src/sim/gearbox.ts` | Load-dependent upshift curve, hysteresis downshift line, minimum time in gear with exemptions, over-speed skip upshift, kickdown, paddle override, over-rev refusal | Shift-schedule literature in docs/research (topic `drivetrain`): *J. Phys.: Conf. Ser.* 2601, 012016; US 4,967,611, US 5,685,799, US 5,669,850 (methods only) |
| `src/sim/driveline.ts` | Clutch-slip launch taper; torque-converter engine speed as the L4 smooth maximum of turbine-driven and stall rpm; lock-up slip ramps; cold-idle ramp | First principles; Schaeffler (LuK) symposium paper "Torque Converter" (lock-up practice) |
| `src/sim/demo.ts`, `src/sim/sim-core.ts` | Keyframed pedal profile (linear interpolation) → force → explicit Euler; crank/idle sequence; sub-model wiring | Newton's second law; first principles |
| `tools/build-catalogue.ts` | EPA Target → SI; derived road load A = Crr·m·g, C = ½·ρ·CdA (ρ = 1.2041 kg/m³); forward-Euler 0 → v_target simulation (dt 5 ms) with bisection on F_trac, then P_eff, to the published time | First principles (spec §8.5) |
| `src/data/voicing-defaults.ts` | Deterministic starting voicing; header lengths from a golden-ratio low-discrepancy sequence | First principles; constants from the phase contract |

| Data | Sources | Notes |
|---|---|---|
| Engine `spec` (15 JSONs) | Manufacturer technical data, press releases, brochures and workshop manuals (archive.org scans and Wayback copies count as the manufacturer document), US EPA Test Car Lists (axle ratio, N/V), Wikipedia only as labelled last resort | No bulk extraction from a specs database; variant choices, estimates (idle, limiter type/hysteresis, torque-converter data) and substitutions are stated in each `notes` |
| Engine `voicing` | `defaultVoicing` estimates, `estimated: true` | Tuned in the Sound Lab (Phases 2b and 5) |
| Tesla catalogue (`teslas.json`) | Tesla spec pages and owner's manuals via Internet Archive Wayback snapshots (URLs with timestamps), US EPA Test Car Lists 2012–2026 (rated hp), Wikipedia only where Tesla publishes nothing (stated per record) | `accelModes` factors are Tesbox estimates (Chill 0.5, intermediate 0.85 — 0.7 / 0.85 where a manual lists two intermediate modes — top 1.0) |
| Road load (`raw/roadload-src.json` → `roadload.json`) | US EPA Test Car Lists, Target (not Set) coefficients | US government public data; proxies and `derived` rows state their basis |
| Replay fixtures (`tests/fixtures/replay/*.json`) | Generated by `tools/make-synthetic-replay.ts` | No real coordinates; GPX inputs are never committed |

Third-party code added in Phase 1: Ajv 8 (MIT) for JSON Schema validation in tests and `tools/build-catalogue.ts` only — not shipped to users (listed in `NOTICES`).
```

- [ ] **Step 3: Add Ajv to `NOTICES`**

In `NOTICES`, directly below the line `  TypeScript, Playwright — Apache-2.0`, insert:

```text
  Ajv — MIT (JSON Schema validation in tests and tools/build-catalogue.ts only)
```

Then run: `npx vitest run tests/unit/repo-files.test.ts`
Expected: PASS (the Phase 0 doc/privacy checks still hold for the edited `docs/CLEAN_ROOM.md` and `NOTICES`).

- [ ] **Step 4: Check the appended wording against the code**

Open `tools/make-synthetic-replay.ts`, `src/sim/speed-filter.ts`, `src/sim/driveline.ts` and `src/sim/demo.ts`; confirm each "Algorithm" cell describes what the code does (the PRNG, Gaussian method and noise model named in the replay tool header; the L4 smooth maximum in the TC formula). If a cell differs from the implementation, edit the cell to match the code (never the code to match the cell). Then confirm `ajv` is only a devDependency:

```bash
node -e "const p=require('./package.json'); console.log(Boolean(p.devDependencies?.ajv), Boolean(p.dependencies?.ajv))"
```

Expected: `true false`.

- [ ] **Step 5: Run the wiring audit**

Every Phase 1 module and data file must be reachable from `TesboxSimCore`, the engine index, the catalogue or the catalogue tool (except the two allow-listed modules), and every Phase 1 module and tool must have its unit-test file:

```bash
node --input-type=module <<'EOF'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
const root = process.cwd();
// Runtime entry points of Phase 1: the simulation core, the two data indexes, and the catalogue build tool.
const ENTRIES = ['src/sim/sim-core.ts', 'src/data/engines/index.ts', 'src/data/catalogue.ts', 'tools/build-catalogue.ts'];
// Phase 1 modules intentionally not reachable from those entries (reasons: plan T12, cross-task premises).
const ALLOW = new Set(['src/sim/replay.ts', 'src/data/voicing-defaults.ts']);
// Phase 1 tools that must have their own unit-test file.
const TOOLS = ['tools/build-catalogue.ts', 'tools/make-synthetic-replay.ts', 'tools/gpx-to-replay.ts'];
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const resolveSpec = (fromFile, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`unresolved import "${spec}" in ${relative(root, fromFile)}`);
};
const seen = new Set();
const stack = ENTRIES.map((e) => resolve(root, e));
while (stack.length > 0) {
  const file = stack.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!file.endsWith('.ts')) continue;
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
    const dep = resolveSpec(file, m[1]);
    if (dep !== null) stack.push(dep);
  }
}
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const phase1 = [...walk(join(root, 'src/sim')), ...walk(join(root, 'src/data'))]
  .map((p) => relative(root, p))
  .filter((p) => p.endsWith('.ts') || (p.endsWith('.json') && !p.startsWith('src/data/schema/') && !p.startsWith('src/data/raw/')));
const unreachable = phase1.filter((p) => !seen.has(resolve(root, p)) && !ALLOW.has(p));
const staleAllow = [...ALLOW].filter((p) => seen.has(resolve(root, p)));
const tests = new Set(readdirSync(join(root, 'tests/unit')));
const untested = [...phase1.filter((p) => p.endsWith('.ts') && !p.endsWith('/index.ts')), ...TOOLS]
  .filter((p) => !tests.has(basename(p).replace(/\.ts$/, '.test.ts')));
console.log(`reachable files: ${seen.size}; phase-1 src files: ${phase1.length}`);
if (unreachable.length > 0) console.error(`NOT WIRED (unreachable from ${ENTRIES.join(', ')}):\n  ${unreachable.join('\n  ')}`);
if (staleAllow.length > 0) console.error(`ALLOW-LISTED BUT WIRED (remove from ALLOW):\n  ${staleAllow.join('\n  ')}`);
if (untested.length > 0) console.error(`NO UNIT TEST FILE (tests/unit/<module>.test.ts):\n  ${untested.join('\n  ')}`);
process.exit(unreachable.length + staleAllow.length + untested.length > 0 ? 1 : 0);
EOF
```

Expected: `reachable files: <n>; phase-1 src files: <m>` and exit code 0 (`echo $?` → `0`). For each `NOT WIRED` line: wire the module where the contract says it is used (e.g. SimCore must construct it) or delete dead code; for an engine JSON missing from `src/data/engines/index.ts`, add it there. For `ALLOW-LISTED BUT WIRED`: remove that path from `ALLOW` in this plan's command and re-run. For each `NO UNIT TEST FILE` line: the owning task missed its test — add it before continuing.

- [ ] **Step 6: Run the hot-path allocation audit**

The audit scans every hot method AND, transitively, everything it calls inside `src/sim/**` — private helpers and accessors reached through `this.<member>`, top-level functions called by name (e.g. `wheelRpm`, `maxForceN`), methods of any `src/sim` class called on another object (e.g. `map.upshiftRpm(…)`), and getters of any `src/sim` class read on another object (e.g. `this.filter.v`, `this.gearbox.gear`, `this.loadEst.loadRate`; both matched by name, a deliberate over-approximation) — because the rule covers the helpers too (Tasks 2, 5, 8 premises).

```bash
node --input-type=module <<'EOF'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
const root = process.cwd();
// Phase 1 contract, global rules: these method names in src/sim/** are hot paths.
const HOT = new Set(['step', 'accept', 'evaluate', 'update', 'tick', 'next', 'request']);
const BANNED = new Map([
  [ts.SyntaxKind.NewExpression, 'new'],
  [ts.SyntaxKind.ArrayLiteralExpression, 'array literal'],
  [ts.SyntaxKind.ObjectLiteralExpression, 'object literal'],
  [ts.SyntaxKind.ArrowFunction, 'closure'],
  [ts.SyntaxKind.FunctionExpression, 'closure'],
  [ts.SyntaxKind.FunctionDeclaration, 'closure'],
  [ts.SyntaxKind.SpreadElement, 'spread'],
  [ts.SyntaxKind.SpreadAssignment, 'spread'],
  [ts.SyntaxKind.TemplateExpression, 'template literal'],
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template literal'],
  [ts.SyntaxKind.TryStatement, 'try'],
  [ts.SyntaxKind.ThrowStatement, 'throw'],
]);
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
// Pass 1: every class member with a body and every top-level function in src/sim.
// A code unit: { label, body, sf, file, cls (class node or null) }.
const classMembers = new Map(); // class node → Map(name → unit)
const methodsByName = new Map(); // method name → units (any class), for calls on other objects
const accessorsByName = new Map(); // getter name → units (any class), for reads on other objects
const functions = new Map(); // top-level function name → unit
const hotUnits = [];
for (const file of walk(join(root, 'src/sim'))) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.body !== undefined) {
      functions.set(st.name.text, { label: st.name.text, body: st.body, sf, file, cls: null });
    }
  }
  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const members = new Map();
      const clsName = node.name?.text ?? '<class>';
      for (const m of node.members) {
        const callable = ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m);
        if (!callable || m.body === undefined || !ts.isIdentifier(m.name)) continue;
        const unit = { label: `${clsName}.${m.name.text}`, body: m.body, sf, file, cls: node };
        members.set(m.name.text, unit);
        if (ts.isGetAccessorDeclaration(m)) accessorsByName.set(m.name.text, [...(accessorsByName.get(m.name.text) ?? []), unit]);
        if (!ts.isMethodDeclaration(m)) continue; // setters: followed only through this.<name>
        methodsByName.set(m.name.text, [...(methodsByName.get(m.name.text) ?? []), unit]);
        if (HOT.has(m.name.text)) hotUnits.push(unit);
      }
      classMembers.set(node, members);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
// Pass 2: scan each hot method and, transitively, everything it calls inside src/sim:
// this.<member> of the same class, <fn>(…) top-level functions, <obj>.<method>(…) of any src/sim class,
// and <obj>.<getter> reads of any src/sim class (e.g. this.filter.v).
const problems = [];
const scanned = new Set();
const queue = hotUnits.map((u) => [u, u.label]);
while (queue.length > 0) {
  const [unit, via] = queue.shift();
  if (scanned.has(unit)) continue;
  scanned.add(unit);
  const { sf, file, cls } = unit;
  const where = unit.label === via ? `${unit.label}()` : `${unit.label}() via ${via}()`;
  const at = (node) => `${relative(root, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const scan = (node) => {
    const what = BANNED.get(node.kind);
    if (what !== undefined) problems.push(`${at(node)} ${where}: ${what}`);
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && cls !== null) {
      const callee = classMembers.get(cls)?.get(node.name.text);
      if (callee !== undefined) queue.push([callee, via]);
    } else if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (ts.isIdentifier(fn) && functions.has(fn.text)) queue.push([functions.get(fn.text), via]);
      if (ts.isPropertyAccessExpression(fn) && fn.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        for (const callee of methodsByName.get(fn.name.text) ?? []) queue.push([callee, via]);
      }
    } else if (ts.isPropertyAccessExpression(node) && node.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      for (const callee of accessorsByName.get(node.name.text) ?? []) queue.push([callee, via]);
    }
    ts.forEachChild(node, scan);
  };
  ts.forEachChild(unit.body, scan);
}
console.log(`hot methods checked: ${hotUnits.length}; code units scanned incl. called helpers: ${scanned.size}`);
if (problems.length > 0) {
  console.error(`Hot-path allocation violations (phase-1 contract, global rules):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('No allocations in src/sim hot paths.');
EOF
```

Expected: `hot methods checked: <n>; code units scanned incl. called helpers: <m>` with n ≥ 10 (`SpeedFilter.accept/evaluate`, `ReplayFeeder.next`, `LoadEstimator.update`, `Gearbox.request/step`, `DrivelineModel.step`, `DemoDriver.step`, `PedalPhysics.step`, `TesboxSimCore.step`) and m > n (42 with exactly this plan's code: the hot methods plus helpers such as `Gearbox.auto/paddle/manualAuto/begin`, `DrivelineModel.stepClutch/stepTc/wander/coldIdle`, `SpeedFilter.predict/scalarUpdate`, `TesboxSimCore.crankRpm`, the shift-map methods, `wheelRpm`, `roadForceN`, `maxForceN`, `rawLoad`, and getters read on other objects such as `SpeedFilter.v/a/flags`, `Gearbox.gear/flags`, `DrivelineModel.rpm/state`, `PedalPhysics.v/a`, `LoadEstimator.loadRate`), then `No allocations in src/sim hot paths.` (exit 0). Each reported violation (`<file>:<line> <unit>() via <hot method>(): <kind>`) must be fixed in the owning module (move the allocation to the constructor/`configure`, mutate output fields in place, replace a closure with a private method, replace a template-literal or `throw` with a numeric state/flag). If fewer than 10 hot methods are found, a task named a hot method differently from the contract — rename it to the contract name.

- [ ] **Step 7: Confirm the generated catalogue files are current**

Run: `npx tsx tools/build-catalogue.ts --check`
Expected: `Catalogue up to date.` (exit 0).

- [ ] **Step 8: Run criterion (a) and record the achieved numbers**

Run: `npx vitest run tests/unit/criterion-a.test.ts --reporter=verbose`
Expected: the file passes (`Tests  3 passed (3)`), and its log prints the achieved p95 for the speed path and for the null-speed (position-only) path (≈ 1.950 s against 2.2 s and ≈ 2.750 s against 3.0 s). Copy both values (and any `kalmanQ`/`R_s` tuning Task 3 applied) into the phase report. Both assertions must pass (no `it.fails`). Criterion (a) is met when they do; a failure is a Phase 1 bug — never loosen either bound.

Then check the recorded Replay fixture of the exit gate: `npx vitest run tests/unit/replay.test.ts --reporter=verbose` lists either one passing `recorded (gpx) replay fixtures` test per committed GPX-sourced fixture, or the skipped placeholder. If no gpx-sourced fixture is committed, report "recorded Replay fixture missing: user records a phone GPX on a drive, runs npx tsx tools/gpx-to-replay.ts, commits only the JSON" to the user as an open Phase 1 exit-gate item (spec §15); never commit the GPX itself.

- [ ] **Step 9: Run the full verification**

Run: `npm run verify`
Expected: lint, typecheck, the whole Vitest suite (Phase 0 + all Phase 1 unit tests), `vite build` and the Playwright e2e suite all pass, exit code 0.

- [ ] **Step 10: Review the working tree for the phase commit (do not commit)**

Run: `git status --short`
Expected: only paths from the phase-1 contract file map, plus `package.json`/`package-lock.json` (ajv), `docs/CLEAN_ROOM.md`, `NOTICES`, and any helper/`.gitignore` change a Phase 1 task declared in its own Files list; no `*.gpx`, no scratch files, no `test-results/` or `playwright-report/` (git-ignored). Remove anything else. The single verified Phase 1 commit is made after this task by the phase owner.

- [ ] **Step 11: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both exit 0 with no errors.

---
