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
