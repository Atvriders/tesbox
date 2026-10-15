# Phase 2c Contract — Sound Lab UI `/lab/` (LOCKED)

Authoritative for Phase 2c. Spec §11.4, §11.6, §15 (exit gate: e2e smoke for `/lab`). A desktop tool
for listening and hand-tuning voicings; never part of the in-car bundle or the app's offline cache.
Builds on the committed DSP (`src/dsp/**`), the engine schema and `src/data/voicing-defaults.ts`,
and the Phase 2b tooling (`tools/segments.ts`, `src/lab/*.ts` scoring modules — read, never modified).

## L1 — Page, build, serving

- `lab/index.html` is a third Vite input `lab` (beside `main` and `probe` in `vite.config.ts`); its
  code lives in `src/lab/ui/` (Preact TSX, same conventions as `src/ui/`). Page markup follows the
  probe page's CSP-compliant pattern (no inline script/style the CSP blocks).
- The app service worker's `PRECACHE` must contain no lab asset (it is computed from the `main`
  entry graph): verified on a real build.
- nginx (`nginx.conf`) and the `vite preview` headers module: `/lab` → relative 301 to `/lab/`
  exactly as `/probe` is handled; `= /lab/` and `= /lab/index.html` serve `/lab/index.html` with the
  same no-store + security-header include as the probe page. CSP unchanged.
- Audio: a lab-only AudioWorklet module `src/lab/ui/lab-worklet.ts` (processor `'tesbox-lab'`),
  loaded the way the app loads `src/audio/worklet.ts`. It hosts one `TesboxDspCore` and the app's
  output stage (`DEFAULT_OUTPUT`, the selected sub / no-sub preset); no SimCore. `src/contracts.ts`
  and the app worklet are not changed; the lab protocol is private (`src/lab/ui/protocol.ts`).
  `process()` follows the app worklet's allocation rule (one bounded allocation per meter post).

## L2 — Lab protocol

Main → worklet:

- `{ type: 'engine', def: EngineDef }` — `assertEngineFits(def, sampleRate)` first; on failure post
  `{ type: 'error', message }` and keep the previous engine; else `configure()` (the core's own
  config fade applies).
- `{ type: 'tier', value: Tier }`, `{ type: 'output', config: OutputConfig }`,
  `{ type: 'gain', db: number }` (monitor level −40…0 dB, default −12, applied after the stage).
- `{ type: 'manual', rpm, load, gear, valve, perspective, driveMode, warm }` — the DspControl
  rendered every quantum while no segment plays; rpm clamped to [idle, limiter] of the current spec,
  load to DspControl's documented range, gear to [1, gears].
- `{ type: 'event', ev: 'upshift' | 'downshift' | 'liftoff' | 'limiter' | 'ignition' }`:
  upshift → ShiftState from the current rpm to rpm·ratio[g+1]/ratio[g] at t0 = now, gear + 1 (no-op
  in top gear); downshift → rev-matched blip to rpm·ratio[g−1]/ratio[g] (clamped to the limiter),
  gear − 1 (no-op in 1st); liftoff → load 0 (overrun) until the next `manual`; limiter → toggles a
  hold at limiterRpm with `limiter: true`; ignition → toggles `ignitionOn` (on restarts `runTimeS`).
  The pure state transition lives in `src/lab/ui/lab-control.ts` (unit-tested; the worklet calls it).
- `{ type: 'segment', name: string | null }` — loops a `tools/segments.ts` segment (bound to the
  current spec) instead of manual control; `null` returns to manual.

Worklet → main: `{ type: 'ready' }`; `{ type: 'error', message }`; `{ type: 'meter', rmsDb, peakDb,
rpm, gear, limiter, boost, limiterGrDb, nonFiniteResets }` at ~20 Hz.

## L3 — UI

- Header: Start audio (user gesture; resumes a suspended context), engine selector (all 15, generic
  title + "inspired by" subtitle), perspective Cabin | Outside, tier Full | Lite, sub preset.
- Voicing panel generated from `src/data/schema/engine.schema.json` `$defs.voicing`: number → slider
  + number input over the schema range (no schema maximum → the T6 tunable range from the Phase 2b
  contract when listed, else [min, max(1, 4 × the engine's value)]); arrays → one control per
  element (length fixed); nullable objects (turbine, forcedInduction) editable only when present;
  booleans → checkbox; `estimated` not editable. Edits apply debounced (≤ 150 ms); a voicing that
  fails `assertEngineFits` in the page is flagged and not sent. "Reset to engine" (the shipped JSON)
  and "Reset to default voicing" (`defaultVoicing(spec)`).
- Drive panel: RPM slider (idle…limiter), load slider, gear select, valve / drive mode / warm,
  event buttons (Upshift, Downshift, Lift-off, Limiter, Ignition), segment select + Play / Stop.
  Keys: ↑/↓ rpm, W/S load, E/Q shift up/down, Space lift-off, L limiter.
- A/B: file picker (`audio/*`) → `decodeAudioData` in the page (the file never leaves the browser —
  no request carries it); looped playback; A/B toggle (button + `B` key) with a 30 ms crossfade;
  "Match level" normalises both sides by RMS (reference: whole-clip RMS; lab: the meter's RMS).
- Export: downloads `<engineId>.voicing.json` = `{ engineId, voicing }` (voicing schema-validated
  first, `estimated: true` always) plus a Copy button; Import: file → validate → apply.
- Meter: RMS / peak, limiter gain reduction, rpm, gear, boost, non-finite resets. Usable at 400 px
  (panels stack); built for desktop.

## L4 — Tests (test-first)

- Unit: `lab-control` transitions and clamps; voicing-field generation (ranges, arrays, nullable
  objects) for all 15 engines; export → import round trip and schema rejection; level-match math.
- `tests/e2e/lab.spec.ts` (exit gate): `/lab/` loads with 0 CSP violations; 15 engines listed;
  Start → `ready` → the meter is non-silent at 3000 rpm and stays finite; a voicing edit reconfigures
  without errors; Upshift changes the gear readout; a segment advances rpm; A/B with a generated
  1 s sine WAV toggles B and back with no request carrying the file; Export downloads JSON that
  validates and re-imports. Headers spec: `/lab` and `/lab/` behave like `/probe` and `/probe/`.
- Build check: `dist/lab/index.html` exists; `dist/sw.js` PRECACHE has no lab asset.

## L5 — Docs

`docs/SOUND_LAB.md` gains a "Lab UI" section: opening `/lab/`, the controls, A/B with a local clip,
export → paste the voicing into `src/data/engines/<id>.json`, and `estimated` stays `true` until the
user's listening sign-off.
