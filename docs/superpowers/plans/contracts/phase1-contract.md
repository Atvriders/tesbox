# Phase 1 Contract — Contracts + data spec + SimCore (LOCKED)

Authoritative for every Phase 1 task. Formulas/types here beat prose elsewhere. Spec §4.2–4.5, §5.1–5.2,
§5.5, §8, §9, §14 (Vehicle + Data rows), §15 Phase 1. Shared types and constants: `src/contracts.ts`
(LOCKED — import, never redefine; if a change is truly needed, stop and report it). Phase 0 provides
the toolchain (`package.json`, Vitest, ESLint, `src/platform/geo.ts` with
`haversineM(lat1, lon1, lat2, lon2): number`, R = 6371008.8 m).

## Global rules

- **Hot paths never allocate.** Methods named `step`, `accept`, `evaluate`, `update`, `tick`,
  `next`, `request` in `src/sim/**` must not contain `new`, array/object literals, closures,
  spread, template literals, `try`/`throw`. (Phase 2a adds the ESLint rule enforcing this for
  `src/sim/**` and `src/dsp/**`; write code that already complies.) Allocate in constructors /
  `configure()` only. Outputs are fields mutated in place.
- Time is worklet seconds (`nowS`). Steps are one quantum: `dtS = 128 / sampleRate` (tests use
  48 kHz → 0.0026667 s unless stated).
- Gears are 1-based. `overallRatios[gear - 1]`. Gear 0 = neutral (only before/while cranking).
- Stateful logic gets **multi-call tests** (≥ 2 consecutive steps/fixes), never single-call only.
- Devdependency added in Phase 1: `ajv ^8.20.0` (schema validation in tests/tools only).

## File map

| Path | Responsibility | Task |
|---|---|---|
| `src/sim/tyre.ts` | tyre parsing, rolling circumference, wheel rpm | T1 |
| `src/sim/epa.ts` | EPA Target coefficient conversion | T1 |
| `src/sim/speed-filter.ts` | 3-state Kalman, prediction, standstill, dropout, speed-unusable latch, hidden hold | T2 |
| `src/sim/replay.ts` | `ReplayTrace` type + `ReplayFeeder` | T3 |
| `tools/make-synthetic-replay.ts`, `tests/fixtures/replay/*.json` | synthetic GPS traces with ground truth | T3 |
| `tools/gpx-to-replay.ts` | phone GPX → replay JSON (positions stripped) | T3 |
| `src/sim/load.ts` | road force, max force, load estimator | T4 |
| `src/sim/shift-map.ts` | shift-map construction + invariants | T5 |
| `src/sim/gearbox.ts` | auto/manual gearbox state machine | T5 |
| `src/sim/driveline.ts` | launch, clutch disengage, torque converter, idle | T6 |
| `src/sim/demo.ts` | demo profile, demo driver, pedal physics | T7 |
| `src/sim/sim-core.ts` | `TesboxSimCore implements SimCore` | T8 |
| `src/data/schema/engine.schema.json`, `tesla.schema.json`, `roadload.schema.json` | JSON Schemas (draft 2020-12) | T9 |
| `src/data/voicing-defaults.ts` | `defaultVoicing(spec)` | T9 |
| `src/data/engines/<id>.json` (15), `src/data/engines/index.ts` | engine definitions | T9 (index + 1 example), T10 (all 15) |
| `src/data/raw/roadload-src.json` | EPA rows in original units + provenance | T11 |
| `src/data/teslas.json`, `src/data/roadload.json`, `src/data/tesla-params.json` | catalogue (last two generated) | T11 |
| `tools/build-catalogue.ts` | converts road load, fits params, writes generated files; `--check` mode | T11 |
| `src/data/catalogue.ts` | catalogue access + `resolveTeslaParams` + `notListedParams` | T11 |
| `docs/CLEAN_ROOM.md` | append Phase 1 algorithm/data sources | T12 |
| `tests/unit/<module>.test.ts` | one file per module | each |

## APIs (exact)

```ts
// src/sim/tyre.ts
export interface Tyre { widthMm: number; aspectPct: number; rimIn: number }
export function parseTyre(code: string): Tyre;           // "265/30R19", "265/30 R19", "265/30ZR19", "P245/45R18"; throws Error on anything else
export function rollingCircumferenceM(code: string): number; // π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97
export function wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number; // speed / C × ratio × 60

// src/sim/epa.ts
export interface EpaTarget { A_lbf: number; B_lbf_per_mph: number; C_lbf_per_mph2: number }
export function epaToSi(t: EpaTarget): { A_N: number; B_Nps_m: number; C_Ns2_m2: number }; // × EPA_TO_SI from contracts

// src/sim/speed-filter.ts
export class SpeedFilter {
  constructor(tuning?: SimTuning);                 // default DEFAULT_SIM_TUNING
  configure(tuning: SimTuning): void;
  reset(): void;
  accept(fix: FixMsg, nowS: number): boolean;      // §8.2 steps 1–3
  evaluate(nowS: number): void;                    // §8.2 steps 4–6 → v, a, flags
  setHidden(hidden: boolean): void;
  readonly v: number;              // m/s, ≥ 0, prediction to nowS + outputLatencyS
  readonly a: number;              // m/s², decays with prediction (a_k · e^(−τ/τa))
  readonly flags: number;          // subset of F: GPS_LOST | STANDSTILL | PREDICTING | SPEED_UNUSABLE | HIDDEN_HOLD
  readonly fixesAccepted: number;
  readonly fixesRejected: number;
  readonly hasFix: boolean;
}
```

SpeedFilter rules (authoritative numbers):

- `tFix = nowS − fix.ageS`. Reject if `fix.ageS > 3`, or `tFix ≤ tK + 0.05` (out of order /
  duplicate cached fix), or non-finite lat/lon, or accuracy ≤ 0 / non-finite.
- State `x = [s, v, a]` (posterior at `tK`), covariance `P` (3×3, Float64Array(9)). First accepted
  fix: `s = 0`, `v = usable speed ?? 0`, `a = 0`, `P = diag(25, 25, 4)`.
- Position measurement each accepted fix after the first: `s_meas = s_meas_prev +
  haversineM(prev, cur)` with `R_s = (accuracyM / 2)²`, H = [1 0 0].
- Speed measurement when usable: `R_v = max(0.3, 0.05 · accuracyM)²`, H = [0 1 0]. `speedMps`
  null / NaN / non-finite / < 0 → missing. `speedMps === 0` usable only if displacement over the
  last 3–5 s (ring buffer of the last 16 accepted fixes: arrival time + s_meas) is < 5 m; if it is
  > 20 m over the last 5 s the zero is ignored and `zeroMovingCount++`; latch `SPEED_UNUSABLE`
  when `zeroMovingCount ≥ 2` (session-long; `reset()` clears).
- Predict from `tK` to `tFix` (Δ = tFix − tK): `F = [[1,Δ,Δ²/2],[0,1,Δ],[0,0,1]]`, white-jerk
  `Q = q·[[Δ⁵/20, Δ⁴/8, Δ³/6],[Δ⁴/8, Δ³/3, Δ²/2],[Δ³/6, Δ²/2, Δ]]`, `q = tuning.kalmanQ`. Then
  sequential scalar updates (position, then speed). Joseph form not required; symmetrise P after
  each update.
- Output (evaluate): `τ = (nowS + outputLatencyS) − tK` (≥ 0); `v = max(0, v_k + a_k·τa·(1 −
  e^(−τ/τa)))`; `a = a_k·e^(−τ/τa)`.
- Standstill: enter when output v < 0.5, leave when > 1.0; while standstill output v = 0, a = 0;
  on entry the posterior `a := 0` (and `P[a,a] := 1`).
- Dropout (arrival-based, `lastArrivalS` = nowS of last accepted fix): `nowS − lastArrivalS > 2`
  → `PREDICTING`; `> 20` → `GPS_LOST` and output v *= `max(0, 1 − (nowS − lastArrivalS − 20)/10)`.
  Before the first fix: `GPS_LOST` set, v = 0.
- Hidden: `setHidden(true)` sets `HIDDEN_HOLD` (filter keeps its state; fixes still accepted if they
  arrive); `false` clears it.

```ts
// src/sim/replay.ts
export interface ReplayFix { t: number; sAlongM: number; speedMps: number | null; accuracyM: number; ageS?: number }
export interface ReplayTrace {
  meta: { name: string; cadenceS: number; latencyS: number; source: 'synthetic' | 'gpx'; notes?: string };
  fixes: ReplayFix[];              // t = delivery time (s from trace start), ascending
  truth?: { t: number; v: number }[]; // ground-truth speed (synthetic traces only)
}
export const METRES_PER_DEG_LON_AT_EQUATOR = 111319.49;
export class ReplayFeeder {
  constructor(trace: ReplayTrace);
  reset(): void;
  /** Fills `out` with the next fix if its t ≤ nowS and returns true; else false. Fake position: lat 0, lon = sAlongM / 111319.49. ageS = fix.ageS ?? meta.latencyS. */
  next(nowS: number, out: FixMsg): boolean;
}
```

Synthetic traces (`tools/make-synthetic-replay.ts`, deterministic seed, written to
`tests/fixtures/replay/`): `city-amd.json` (stop-go, speed present), `highway-amd.json` (0→130
km/h, cruise, lift-off), `intel-zero-speed.json` (speed always 0 while moving), `intel-null-speed.json`
(speed null), `tunnel-dropout.json` (35 s gap), `stoplight-jitter.json` (stationary with ±4 m
position noise and speed 0–0.4), `stale-duplicates.json` (repeated cached fixes, ages up to 10 s),
`step-response.json` (speed steps 0→20→20→10 m/s held 15 s, for criterion (a)). Cadence 1.0 s,
latency 1.0 s, accuracy 4–8 m, position noise σ = accuracy/2, speed noise σ = 0.15 m/s.

`tools/gpx-to-replay.ts <in.gpx> <out.json> [--latency 1.0] [--cadence 1.0] [--null-rate 0]`:
parses `<trkpt lat lon><time>` (and `<speed>` extension if present), computes cumulative distance,
re-samples to the cadence, writes `ReplayTrace` with **no lat/lon**.

```ts
// src/sim/load.ts
export function roadForceN(p: TeslaParams, v: number): number;  // A + B·v + C·v²
export function maxForceN(p: TeslaParams, v: number): number;   // modeFactor · min(fTracN, eta·pEffW / max(v, 1))
export function rawLoad(p: TeslaParams, v: number, a: number): number;
//   F = massKg·a + roadForceN(p, v); F ≥ 0 → clamp(F / maxForceN(p, v), 0, 1); else max(F / (massKg·0.25·G), −1)
export class LoadEstimator {
  configure(p: TeslaParams): void;
  reset(): void;
  /** One-pole τ = 0.2 s then deadband ±0.03 (|x| < 0.03 → 0). loadRate = d(load)/dt of the filtered value (1/s). */
  update(v: number, a: number, dtS: number): number;
  readonly load: number;
  readonly loadRate: number;
}

// src/sim/shift-map.ts
export interface ShiftMap {
  readonly gears: number;
  readonly coastDownRpm: number;                     // comfort 1200, sport 1500
  upshiftRpm(gear: number, load: number): number;    // Infinity for top gear
  downshiftRpm(gear: number, load: number): number;  // engine rpm IN `gear` below which to go to gear−1; 0 for gear 1
  kickdownMaxRpm(gear: number, load: number): number; // upshiftRpm(gear, load) − 300
}
export function buildShiftMap(spec: EngineSpec, mode: DriveMode): ShiftMap;
```

Shift-map formulas: `frac(load) = lo + (hi − lo)·clamp(load, 0, 1)^1.3` with Sport `lo 0.30, hi 0.97`,
Comfort `lo 0.25, hi 0.90`; `upshiftRpm(n) = max(frac·redline, (coastDownRpm + 300) / (r[n+1]/r[n]))`
(r = overallRatios, 1-based gear n uses r[n−1]; formula uses ratio of next to current);
hysteresis `h` Comfort 0.25 / Sport 0.15; `downshiftRpm(n, load) = upshiftRpm(n−1, load) ·
(r[n]/r[n−1]) · (1 − h)` with 1-based indexing as above, i.e. the speed at which n−1→n upshifted,
reduced by h, expressed as rpm in gear n. Invariant (unit-tested for every fixture/engine and both
modes): `downshiftRpm(n+1, load) < upshiftRpm(n, load) · r[n+1]/r[n]` and after any upshift the
new-gear rpm ≥ coastDownRpm + 300 − 1.

```ts
// src/sim/gearbox.ts
export class Gearbox {
  configure(spec: EngineSpec, circumferenceM: number, mode: GearboxMode, drive: DriveMode): void;
  setMode(mode: GearboxMode): void;
  setDriveMode(drive: DriveMode): void;
  /** Paddle/wheel/keyboard request; applied on the next step. dir: +1 up, −1 down. */
  request(dir: number): void;
  step(nowS: number, v: number, load: number, loadRate: number, predicting: boolean, standstill: boolean, clutchOpen: boolean): void;
  rpmInGear(gear: number, v: number): number;
  readonly gear: number;            // 1..gears
  readonly shift: ShiftState;       // mutated in place
  readonly flags: number;           // F.SHIFTING | F.MANUAL_OVERRIDE | F.SHIFT_REFUSED
}
```

Gearbox rules: shift duration = `spec.gearbox.shiftTimeS`; a shift sets `shift = {active: true, up,
fromRpm: rpmInGear(old), toRpm: rpmInGear(new), t0: nowS, durationS}` and changes `gear`
immediately; `active` clears at `t0 + durationS`; no new shift while active. **Auto:** upshift when
`rpmInGear(gear) ≥ upshiftRpm(gear, load)` and not `predicting`; min time in gear 1.5 s since the
previous shift ended applies when `load < 0.8` (part-load) or `load ≤ 0` (coast) — at `load ≥ 0.8`
an upshift is allowed 0.2 s after the previous shift ended; downshift when `rpmInGear(gear) <
downshiftRpm(gear, load)`; kickdown when `load > 0.9 && loadRate > 2`: lowest gear `g ≥ gear − 2`
with `rpmInGear(g) ≤ kickdownMaxRpm(g, load)`; standstill → gear 1 (no shift event). Paddle in
Auto → perform the shift (if legal), set `MANUAL_OVERRIDE` for 8 s during which auto-upshifts are
suspended (auto-downshift below coastDownRpm still applies). **Manual:** requests only; downshift
refused if `rpmInGear(gear − 1) > spec.rpm.redline` → `SHIFT_REFUSED` for 0.5 s; auto-downshift
when `rpmInGear(gear) < 1100` (anti-lug) unless `clutchOpen`; standstill → gear 1. Upshift
request at top gear / downshift at gear 1 → ignored (no flag).

```ts
// src/sim/driveline.ts
export class DrivelineModel {
  configure(spec: EngineSpec, voicing: EngineVoicing, seed?: number): void;
  reset(): void;
  setWarm(warm: boolean): void;
  /** runTimeS = seconds since ignition on. */
  step(nowS: number, dtS: number, rpmWheel: number, load: number, gear: number, standstill: boolean, runTimeS: number): void;
  readonly rpm: number;              // engine rpm (pre-limiter)
  readonly state: Driveline;         // 'engaged' | 'clutch-open' | 'tc-stall' | 'slipping'
}
```

Driveline rules (spec §8.4): idle `= spec.rpm.idle + wander(±20 rpm, 0.5 Hz deterministic) +
coldIdle`, coldIdle = 300 rpm for `runTimeS < 45` when not warm, ramping to 0 over 45→60 s.
**Clutch types** (`dct|pdk|manual|amt`): clutch open when `rpmWheel < 1.05·idleBase` (re-engage
above `1.15·idleBase`) → `rpm = idle`, state `clutch-open`; launch from standstill: timer starts when
`load > 0.1` first occurs after standstill; while slipping `rpm = max(rpmWheel, idle + max(load,0)·
(voicing.launchRpm − idle)·taper(t))` with `taper(t) = 1` for t < 0.5 s then linear → 0 at 1.0 s;
lock (state `engaged`, `rpm = rpmWheel`) only when `rpmWheel ≥ max(1.05·idleBase, rpmSlip − 50)`.
**TC** (`tc-auto`): `SR = lerp(0.97, tc.couplingSR, max(load,0))`; `stall = lerp(idle,
tc.stallRpmWot, clamp(load,0,1))`; unlocked `rpm = ((rpmWheel/SR)^4 + stall^4)^(1/4)` (state
`tc-stall` when rpmWheel/SR < stall else `slipping`); lock-up when gear ≥ 2 and turbine rpm
(rpmWheel) > `tc.lockupTurbineRpm` and load < 0.9 → slip ramps to 0 over 0.4 s (state `engaged`);
unlock on load > 0.9 (kickdown) or turbine rpm < lockupTurbineRpm − 200 → slip ramps back over 0.4 s.
Output rpm is continuous (no steps > 50 rpm per quantum except via shift trajectories).

```ts
// src/sim/demo.ts
export interface PedalCommand { throttle: number; brake: number }
export const DEMO_PROFILE: readonly { t: number; throttle: number; brake: number }[]; // keyframes, loops; ~70 s
export class DemoDriver { reset(): void; step(dtS: number, out: PedalCommand): void } // linear interpolation, loops
export class PedalPhysics {
  configure(p: TeslaParams): void;
  reset(): void;
  /** a = (throttle·maxForceN − roadForceN − brake·massKg·0.8·G)/massKg, v clamped ≥ 0 (road force zero at v = 0). */
  step(throttle: number, brake: number, dtS: number): void;
  readonly v: number;
  readonly a: number;
}
```

DEMO_PROFILE keyframes (seconds → throttle, brake): 0→(0,0) idle 3 s; 3→(0.35,0) pull-away to
~50 km/h; 15→(1,0) WOT through gears to ~140 km/h; 30→(0.15,0) cruise; 40→(0,0) lift-off/overrun;
48→(0,0.5) braking; 58→(0,0) stop; 64 loop. (Implementer may tune numbers; profile must contain
idle, WOT, cruise, lift-off, braking, stop.)

```ts
// src/sim/sim-core.ts
export class TesboxSimCore implements SimCore { constructor(); /* SimCore members */ }
```

SimCore rules: `configure` computes circumference from `spec.gearbox.drivenTyre`, configures every
sub-model; sources: `gps`/`replay` → SpeedFilter(v, a, flags); `demo` → DemoDriver + PedalPhysics;
`keyboard` → last `pedal` InputMsg + PedalPhysics (standstill for demo/keyboard: v < 0.3).
`ignition {on:true}` → `ignitionOn`, `runTimeS` from 0; crank sequence: 0–0.6 s rpm ramps to 250
(gear 0), 0.6–1.0 s flare to idle + 800, 1.0–2.5 s settle to idle, gear 1 after 2.5 s;
`{on:false}` → rpm decays to 0 over 1.0 s, gear 0. Per step: wheel rpm in current gear → driveline
→ target rpm; if `target ≥ spec.rpm.limiter.rpm` → `out.rpm = limiter.rpm`, `out.limiter = true`.
`out.flags` = filter flags | gearbox flags | LIMITER | SHIFTING | CLUTCH_OPEN (driveline
'clutch-open') | OVERRUN (`load < −0.05 && rpm > voicing.overrun.fuelCutResumeRpm && driveline ===
'engaged'`). HIDDEN_HOLD (gps/replay source): out.rpm → idle, out.load → 0, driveline
'clutch-open', gear held. Input msgs `shiftUp/shiftDown` → `gearbox.request`; `gearboxMode`,
`driveMode`, `visibility` handled; others ignored by SimCore.

## Data (T9–T11)

- JSON Schemas mirror `EngineDef`, `TeslaRecord`, `RoadLoadRecord` exactly (required everything,
  `additionalProperties: false`), with ranges: idle 500–1200, redline 4000–10000, limiter.rpm ≥
  redline, hysteresis 50–600, overallRatios length 4–10 strictly descending (checked in test, not
  schema), angles 0 ≤ a < cycleDeg (test), combustion length 2–16, shiftTimeS 0.05–0.6,
  couplingSR 0.8–0.95, accel seconds 1.5–20, massKg 1000–4500, peakPowerKw 50–1200, factor 0.2–1.
- `defaultVoicing(spec)`: deterministic; headers 0.55–0.70 m varying per entry (bank-symmetric for V
  engines, deliberately unequal 0.45/0.75 pairs for `flat` 4-cylinders), one collector per bank
  (0.35 m), turbine `{reflection 0.45, lpHz 1500}` iff turbo, mid 1.4 m, mufflers [0.21, 0.34, 0.47],
  mufflerAction 0.6, tail 0.5, valve `{fitted: true, openGainDb: 4}`, intake `{runnerM 0.3,
  helmholtzHz 120 + 20·cylinders/4, gain 0.4}`, forcedInduction iff turbo/supercharger `{spoolTimeS
  turbo 0.6 | sc 0.05, maxShaftKrpm 180, lift turbo 'bov' | sc 'bov', cabinGainDb −14}`, mechanical
  `{0.3, 0.1}`, overrun `{crackleRate 0.5, fuelCutResumeRpm idle + 500}`, cabin `{lowpassHz 600}`,
  pulse `{widthDeg 60 (rotary 260), alpha 9, beta 4, evoOffsetDeg 140, cycleAsymmetry 0.1}`,
  launchRpm `NA: 0.55·redline, turbo/sc: 0.45·redline`, `estimated: true`.
- The 15 engine ids (exact): euro `i5-turbo-25`, `flat6-na-40`, `v10-na-52`, `i4-turbo-20`; jdm
  `i6-twinturbo-30`, `rotary-twin-13`, `flat4-turbo-25`, `v6-twinturbo-38`; american `v8-na-50`,
  `v8-na-62`, `v8-sc-62`; exotic `v12-na-65`, `v8-flatplane-45`, `v10-na-48`, `v8-twinturbo-40`.
  Titles/inspiredBy per spec §5.5. `src/data/engines/index.ts` exports `ENGINES: EngineDef[]` (static
  JSON imports, ordered as listed) and `getEngine(id: string): EngineDef` (throws on unknown).
- Engine `spec` data: every field group sourced from primary/public documents (manufacturer press
  kits/brochures/spec sheets, homologation, EPA filings, Wikipedia as a last resort); no bulk
  extraction from a single specs database; NEVER anything from rupteur.app or repos referencing it.
  Firing angles from the published firing order and crank geometry. Variant choices + caveats in
  `notes`. Engines whose ratios cannot be primary-sourced: choose a documented variant and say so.
- Tesla catalogue (`teslas.json`): every Model S/X/3/Y/Y L/Cybertruck generation + trim sold in US/EU
  since 2012 (MCU1-only configurations `supported: false`), plus nothing else (Not listed is code).
  `roadload-src.json`: per `ref` the EPA Target A/B/C (lbf units), model year, rated hp, test car
  row description, or `derived` CdA/Crr with sources. `build-catalogue.ts` writes `roadload.json`
  (SI via `epaToSi`) and `tesla-params.json` (`Record<id, { massKg; fTracN; pEffW }>`), and in
  `--check` mode exits non-zero if regenerating would change either file.
- Param fit (`build-catalogue.ts`): `massKg` normalised (`us-curb` +75 kg; others as-is). Target
  time from `accel` (0-60 mph target speed 26.8224 m/s, +0.25 s if `rolloutSubtracted`; 0-100 km/h
  27.7778 m/s). Simulate `m·dv/dt = min(F_trac, η·P_eff/max(v,1)) − F_road(v)` with dt = 0.005 s.
  Start `P_eff = peakPowerKw·1000`; bisection on `F_trac ∈ [0.3, 1.1]·m·G` to match the time within
  0.01 s; if even 1.1·m·G is too slow, fix F_trac = 1.1·m·G and bisect P_eff ∈ [0.5, 3]·peak.
- `src/data/catalogue.ts`:
  ```ts
  export const TESLAS: TeslaRecord[]; export const ROADLOAD: RoadLoadRecord[];
  export function resolveTeslaParams(recordId: string, modeName?: string): TeslaParams; // default = last (quickest) mode
  export function notListedParams(zeroTo100S: number, massKg: number, body: 'sedan' | 'suv' | 'truck'): TeslaParams;
  // Not listed: road load sedan {A 130, B 1.0, C 0.40}, suv {A 160, B 1.5, C 0.48}, truck {A 220, B 2.0, C 0.62} (N, N·s/m, N·s²/m²);
  // fTracN = massKg·(27.7778/zeroTo100S)·1.25; pEffW = Infinity-equivalent 1e9 (no power term); eta 0.9; modeFactor 1.
  ```
- Tests: every engine + Tesla validates (ajv); combustion angles distinct within [0, cycleDeg) and
  count matches layout; ratios strictly descending; each spec field group has ≥ 1 source; every
  `roadLoadRef` resolves; `build-catalogue --check` passes; WOT simulation per Tesla record (each
  accel mode at factor 1) gives `rawLoad ≥ 0.95` across 10–130 km/h (or up to the car's top speed if
  lower) and `≤ 0.75` at 0.6× that acceleration; ±20 % road load / ±10 % mass changes load by < 0.05
  over DEMO_PROFILE; EPA N/V check (±2.5 %) for engines with a published N/V (test documents tyre +
  axle ratio used); `firingHz` sanity (I4 at 6000 rpm = 200 Hz; 13B at 6000 = 200 Hz; V8 at 6000 =
  400 Hz).

## Criterion (a) test (T3)

`tests/unit/criterion-a.test.ts`: feed `step-response.json` through `ReplayFeeder` →
`SpeedFilter` at dt = 128/48000; for each truth step, measure time from the step to the filter
output reaching 63 % of the step; assert p95 ≤ `latencyS + cadenceS + 0.2` (= 2.2 s). Run it twice:
with speeds present, and with every `speedMps` nulled (position-only path). Spec §1.3(a) requires
the same bound on both paths; if the position path misses it, tune `kalmanQ` / `R_s` within the
contract's formulas and report the achieved numbers — do not loosen the bound.

## Conventions

As Phase 0 (one test file per module, no per-task commits; Phase 1 lands as one verified commit).
No real coordinates anywhere; GPX inputs are never committed.

## Amendments (2026-10-06, authoritative — override anything above)

- **A1 Criterion (a):** speed path p95 ≤ `latencyS + cadenceS + 0.2` (2.2 s); position-only path
  p95 ≤ `latencyS + 2·cadenceS` (3.0 s) — 1 Hz position-only tracking cannot physically reach 2.2 s
  (measured 2.75 s at q = 2). Spec §1.3(a) amended accordingly.
- **A2 Zero-speed rule (replaces the 3–5 s window rule):** let `d1` = haversine displacement from
  the previous accepted fix and `d0` = the previous interval's displacement. A `speedMps === 0`
  fix is: a usable measurement iff `d1 < 3 m`; "moving zero" iff `d1 ≥ 8 m && d0 ≥ 8 m` (ignored
  as a measurement, `zeroMovingCount++`); otherwise ignored without counting. Any non-moving-zero
  fix resets `zeroMovingCount` to 0. Latch `SPEED_UNUSABLE` when `zeroMovingCount ≥ 3`
  (consecutive). Rationale: the old 5 s window counted braking distance and latched on AMD cars
  after ordinary stops.
- **A3 Standstill position deadband:** when the filter output `v < 1.5 m/s`, a fix-to-fix
  displacement `< 0.4 · accuracyM` adds 0 to `s_meas` (suppresses noise-driven creep at stops).
- **A4 Kickdown trigger:** `load > 0.6 && loadRate > 1.2` (with τ = 0.2 s the old `load > 0.9 &&
  loadRate > 2` can never fire). Target gear rule unchanged.
- **A5 Load sensitivity test:** mean |Δload| over one DEMO_PROFILE loop < 0.05 (per-sample max is
  not meaningful).
- **A6 WOT load test** runs on each record's quickest accel mode (factor 1).
- **A7 Traction fit bound:** `F_trac ∈ [0.3, 1.3]·m·G` (Plaid needs ≈ 1.22 g).
- **A8 `massBasis: 'us-curb'`** means curb mass without driver, whether the source is US or EU.
- **A9 Fixture GNSS noise:** first-order Gauss–Markov, stationary σ = accuracy/2, τ = 60 s;
  `stoplight-jitter.json` additionally has a white component σ = 1 m (exercises A3).
- **A10 Kickdown and downshift spacing (2026-10-08; supersedes the A4 "applies on every quantum"
  reading):** measured over 3,060 pedal-step tip-ins (6 engines × 2 modes) the contract rules
  produced 2–3 back-to-back downshifts within 0.3 s ("stutter"), unlike a real DCT/automatic.
  (a) **Kickdown latch:** the A4 kickdown fires at most once per tip-in — it disarms when it fires
  and re-arms on the first quantum where the A4 trigger is false (any mode, shift in flight
  included); `reset()` re-arms it. (b) **Hold while rising:** load-map downshifts are suppressed while
  `loadRate > 1.2`. (c) **Spacing:** at `load > 0`, an Auto load-map downshift may start only
  ≥ 0.3 s after the previous Auto downshift ended. Measured: zero Auto downshift pairs within 0.3 s,
  one kickdown at the demo tip-in. Tests (gearbox.test.ts sweep through PedalPhysics +
  LoadEstimator): no two Auto downshifts start within 0.3 s; at most one kickdown per tip-in and
  each kickdown drops ≤ 2 gears. Task 8 identifies kickdowns by the A4 condition on that step (not
  by the load-map classifier) and its DCT7 demo expectation becomes a single kickdown at ≈ 13.45 s
  (Comfort 4→3, Sport 4→2).
- **A11 EPA N/V screening (2026-10-08):** when an engine's variant matches an EPA Test Car List row
  (same top gear and axle) but the computed N/V misses ±2.5 % after re-checking tyre, final-drive
  mapping and extra gear stages (e.g. the EPA test car ran a different tyre size), the row is
  screened out with a comment above `EPA_NV` stating the measured deviation; the tolerance is never
  loosened. A deviation > 4 % is treated as a data error and must be fixed. (Applied: i4-turbo-20
  +2.66–3.05 %, v8-twinturbo-40 +3.65 %.) Engines whose per-gear ratios or firing order come only
  from secondary sources stay, with the gap stated in `notes` (v12-na-65; v10-na-52 shares the
  Audi R8 V10 short gear set).
