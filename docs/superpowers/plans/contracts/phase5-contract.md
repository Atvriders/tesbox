# Phase 5 Contract — Tuner v2 and the remaining 12 engines (LOCKED)

Authoritative for Phase 5. Spec §11.6, §15 Phase 5 ("one engine per unit: voicing via Lab loop; per
engine: data tests + invariants + gates/unscored + sign-off; each shippable on its own"). Builds on
the Phase 2b tooling (`tools/score.ts`, `tools/tune.ts`, `src/lab/*`) and its amendments D1–D8.

## P1 — Tuner v2 (`tools/tune.ts`)

Motivation (measured on the pilots, 2026-10-15): bounded Nelder–Mead over the 16-parameter vector
stalls on the rugged composite (i5-turbo-25: no improvement after the initial simplex in 145
renders) and evaluates one 6–7 s candidate at a time (120 iterations ≈ 2–3 h per engine).

- **Parallel evaluation.** `--workers N` (default `min(16, availableParallelism() − 2)`, ≥ 1):
  candidates are evaluated in `worker_threads`; each worker loads the references and their
  features once. Results are identical for every N: candidate generation never depends on
  evaluation order, and every reduction runs in candidate-index order. `best.json` is
  byte-identical for `--workers 1` and `--workers 4` with the same seed.
- **Strategy.** `--strategy cmaes|nm`, default `cmaes`. `nm` is the Phase 2b search, unchanged
  (its tests stay). `cmaes` = (μ/μ_w, λ)-CMA-ES with cumulative step-size adaptation, rank-one and
  rank-μ covariance updates, default population λ = 4 + ⌊3 ln n⌋, σ₀ = 0.25 on the normalised
  [0,1]ⁿ box, initial mean = the current voicing's normalised vector — implemented from N. Hansen,
  "The CMA Evolution Strategy: A Tutorial" (arXiv:1604.00772). Box handling: a candidate is
  evaluated at its clamp into [0,1]ⁿ and its objective gets + 10·‖x − clamp(x)‖² (the tutorial's
  boundary penalty, simplified). Stop at `--iterations` generations (default 60), σ < 1e-3, or 15
  generations without a best-objective improvement ≥ 1e-4. Seeded (the existing `--seed`).
- **Polish.** After either strategy: a coordinate pattern search from the best point, steps 0.05 →
  0.025 → 0.0125 (normalised), both directions of every coordinate evaluated in parallel per sweep,
  best move taken, until no move improves at the finest step or 8 sweeps.
- Objective, `assertEngineFits` on every candidate, the early stop when no rpm bin is comparable,
  output (`renders/tune/<id>/best.json`: voicing + score + log with generation, σ, best objective),
  `--apply` (`applyVoicing`, `estimated: true`) are unchanged.
- Tests (test-first; each must fail on a plausible broken implementation): CMA-ES on analytic
  objectives (sphere and rotated ellipsoid in 6-D, an optimum on the box edge) reaches the target
  within a stated evaluation budget; determinism across worker counts; the existing detuned-fixture
  recovery test also passes with `cmaes` (composite +0.1, main parameters within 20 % of range);
  the tune test file stays ≤ 120 s.
- `docs/CLEAN_ROOM.md`: the CMA-ES source row.

## P0 — Sound-fidelity fixes (from the 2026-10-15 gap analysis of the tuned pilots)

Evidence (scratch analysis of the three pilots, every number reproduced with the repo's own scoring):
the renders' turbo whistle is 33–36 dB louder than anything the recordings show, and
`forcedInduction.cabinGainDb` scales whistle and whoosh together (still detected at −70 dB), while the
outside mix has no turbo level at all; the 4th-order cabin low-pass near 600 Hz leaves 1.5–3 kHz
15–20 dB below the recordings, whose 0.8–2.5 kHz band is 41–83 % engine harmonics; both banks of the
V8s are voiced identically (same header lengths per bank position, equal collectors), which cancels
the half-orders that lead real cross-plane and flat-plane recordings by 15–20 dB.

- **P0.1 (DSP, phase 2a amendment B18):** a whistle-only level `forcedInduction.whistleDb`
  (−60…0 dB relative to the current whistle, default −36) and an outside turbo level
  `forcedInduction.outsideGainDb` (−60…0 dB, default −30); `cabinGainDb` keeps scaling the whoosh.
  Any invariant that requires an audible whistle is restated against the new level with the
  evidence above.
- **P0.2 (DSP, B19):** the cabin transfer becomes a 2nd-order low-pass plus a high-frequency leak
  `cabin.leakDb` (−60…−10 dB, default −30) so the cabin keeps the engine's upper harmonics.
- **P0.3 (tuner vector):** per-bank header scale (two parameters where the layout has two banks),
  per-collector `lengthM`, `cabin.lowpassHz` 200–2000, `mechanical.valvetrainGain` 0–1, plus the new
  `whistleDb`, `outsideGainDb`, `leakDb` — all inside the schema ranges.
- Defaults change for every engine (`defaultVoicing`), so untuned engines change sound too; DSP
  invariants, allocation and true-peak tests stay green; the pilots are re-tuned afterwards.
- Deferred (measured, mixed or needs more data): engine pulses during overrun (fuel-cut floor);
  scoring the gate's ceiling and the render over the same slots with ≥ 3 recordings per gated slot;
  harmonic-only tilt/centroid (a re-scoping that would need a separate broadband check).

## P2 — Engine unit (×12)

Per engine, in this order: references per `docs/SOUND_LAB.md` (≥ 2 independent cabin and ≥ 2
independent outside clips; fewer → `unscored`: invariants + listening only) → `score` baseline →
`tune --apply` → `score --gate` → `docs/sound-scores.md` entry exactly as the pilots' (refs, baseline
and tuned per metric, gates, discrimination, the structural cause of any gate it cannot pass,
`Tuned voicing: <id>`, `Sign-off: pending — …`) → previews (`idle`, `cruise4k`, `wotPull`,
`liftoff6k`, cabin + outside, default vs tuned, MP3 192 kbps) on the private listening page.
Gates are never loosened. Discrimination is checked against every tuned engine with references.

## P3 — Releases

Engines land in batches; each batch is one verified commit (isolated-copy verification as before),
a CHANGELOG `1.x.0` section and a `v1.x.0` tag + GitHub release. The user's sign-off flips
`voicing.estimated` to `false` (the garage badge disappears) in the next batch commit.
