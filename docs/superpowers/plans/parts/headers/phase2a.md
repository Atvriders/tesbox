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
