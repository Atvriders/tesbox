# Phase 2a Contract — DspCore + render CLI (LOCKED)

Authoritative for every Phase 2a task. Formulas/types here beat prose elsewhere. Spec §4.4, §5
(all), §14 (DSP invariants / Allocation / Performance rows), §15 Phase 2a. Shared types:
`src/contracts.ts` (LOCKED). Phase 2a runs **in parallel with Phase 1**: it must not import from
`src/sim/**` or `src/data/**` (except JSON Schemas are not needed); it uses its own test fixture
engines. Phase 0 provides the toolchain.

## Global rules

- **Zero allocation in hot paths.** Methods named `tick`, `process`, `render`, `scatter`, `write`,
  `read*`, `step`, `push` in `src/dsp/**` (and `src/sim/**`) contain no `new`, array/object
  literals, arrow/function expressions, spread, template literals, `try`, `throw`. T10 adds the
  ESLint `no-restricted-syntax` rule enforcing exactly this and `tools/check-alloc.ts`.
- **Capacity-sized construction:** every class allocates its buffers in the constructor for worst
  case (`MAX_COMBUSTION` = 16 entries, `fs ≤ MAX_SAMPLE_RATE` 48 kHz, delays sized for
  `SPEED_OF_SOUND_MAX` 700 m/s × the max lengths below). `configure()` only sets parameters and
  clears state — never allocates. Max lengths: header 1.5 m, collector 1.0 m, turbine element n/a,
  mid-pipe 3.0 m, muffler section 0.8 m, tailpipe 1.2 m, intake runner 0.6 m.
- **Numerics:** recursive state in `Float64Array` or class number fields; flush |y| < 1e-20 → 0 in
  every recursive update (`flush()`); delay lines may be `Float32Array`.
- **Passivity:** every in-loop filter |H| ≤ 1 (unity-DC one-poles, Lagrange/linear interpolation);
  every junction is the N-port parallel scattering junction below; **no gain > 1 inside any loop**;
  valve open gain, `mufflerAction`, pop injection gains apply only at the outlet tap / injection
  points outside loops; time-varying reflections and speeds are slew-limited by the caller.
- **Determinism:** all randomness from `Rng` seeded in `configure` (seed param, default 1).
- Sample rate `fs` is a constructor argument (worklet `sampleRate`); tests use 48000 unless stated.
- No imports from `src/sim/**`, `src/data/**`, `src/ui/**`, DOM or Web Audio types in `src/dsp/**`.
- Stateful logic gets multi-call tests.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `src/dsp/util.ts` | `flush`, `clamp`, `dbToGain`, `gainToDb`, `smoothstep`, `Rng`, `OnePole`, `Slew` | T1 |
| `src/dsp/biquad.ts` | RBJ biquads + Butterworth cascades | T1 |
| `src/dsp/oversample.ts` | 4× polyphase upsampler (shared by limiter + analysis) | T1 |
| `tests/fixtures/engines/*.json` | 8 full `EngineDef` fixtures | T1 |
| `src/dsp/delay.ts` | fractional delay line | T2 |
| `src/dsp/waveguide.ts` | bidirectional tube section | T2 |
| `src/dsp/junction.ts` | N-port scattering junction | T2 |
| `src/dsp/exhaust.ts` | exhaust network (headers→collectors→turbine→mid→mufflers→tail, valve) | T3 |
| `src/dsp/combustion.ts` | crank clock, firing scheduler, pulse voices, intake gates, ignition impulses | T4 |
| `src/dsp/rpm-state.ts` | DSP-side rpm: tracking, limiter bounce, shift trajectory, cut decisions | T5 |
| `src/dsp/intake.ts`, `src/dsp/mechanical.ts`, `src/dsp/forced.ts`, `src/dsp/overrun.ts` | layers | T6 |
| `src/dsp/perspective.ts`, `src/dsp/output-stage.ts` | listening-point mix; trim→NaN guard→DC→bass mgmt→compressor→true-peak limiter→clip | T7 |
| `src/dsp/analysis.ts`, `tools/wav.ts` | FFT, order spectrum, true peak, band energy; WAV I/O | T8 |
| `src/dsp/dsp-core.ts` | `TesboxDspCore implements DspCore` | T9 |
| `tools/render.ts`, `tools/segments.ts` | `tesbox-render` CLI + segment definitions | T10 |
| `tools/check-alloc.ts`, `tools/bench-dsp.ts`, `eslint.config.js` (modify) | allocation + perf + lint rule | T10 |
| `tests/unit/dsp-*.test.ts` | one file per module (`dsp-util.test.ts`, …); invariants in `dsp-invariants.test.ts` | each |

## APIs (exact)

```ts
// src/dsp/util.ts
export function flush(x: number): number;                       // |x| < 1e-20 → 0
export function clamp(x: number, lo: number, hi: number): number;
export function dbToGain(db: number): number;
export function gainToDb(g: number): number;                    // −Infinity-safe: g ≤ 0 → −200
export function smoothstep(e0: number, e1: number, x: number): number;
export class Rng { constructor(seed?: number); seed(s: number): void; next(): number /*[0,1)*/; bipolar(): number /*[-1,1)*/; gauss(): number }  // mulberry32 + Box–Muller (cached pair)
export class OnePole {                                          // y += k·(x − y), unity DC gain
  setTau(tauS: number, fs: number): void; setCutoff(hz: number, fs: number): void;
  process(x: number): number; reset(v?: number): void; readonly y: number;
}
export class Slew { setRate(unitsPerS: number, fs: number): void; process(target: number): number; reset(v: number): void; readonly y: number }

// src/dsp/biquad.ts  (RBJ Audio-EQ-Cookbook, Direct Form I, Float64 state, flush on state)
export class Biquad {
  lowpass(f: number, q: number, fs: number): void; highpass(f: number, q: number, fs: number): void;
  bandpass(f: number, q: number, fs: number): void;  // constant 0 dB peak gain
  lowShelf(f: number, gainDb: number, fs: number): void; highShelf(f: number, gainDb: number, fs: number): void;
  peaking(f: number, q: number, gainDb: number, fs: number): void;
  process(x: number): number; reset(): void;
}
export const BUTTER4_Q: readonly [number, number];   // [0.5411961, 1.3065630]
export class Cascade { constructor(stages: number); stage(i: number): Biquad; process(x: number): number; reset(): void }

// src/dsp/oversample.ts
export const OS_FACTOR = 4;
export const OS_TAPS: Float64Array;                  // 48-tap windowed-sinc lowpass (Kaiser β=8), cutoff 0.45·fs_in, normalised for 4× upsampling
export class Upsampler4 { reset(): void; push(x: number): void; readonly out: Float64Array /* length 4, the 4 upsampled samples for the last push */ }

// src/dsp/delay.ts
export class FracDelay {
  constructor(capacity: number);                     // samples; Float32Array ring
  write(x: number): void;
  /** delay in samples from the most recently written sample; Lagrange-3 (requires 1 ≤ d ≤ capacity − 3). */
  readLagrange(d: number): number;
  readLinear(d: number): number;                     // requires 0 ≤ d ≤ capacity − 2
  clear(): void;
  readonly capacity: number;
}

// src/dsp/waveguide.ts  — tube section of length L: right-going rail and left-going rail, each a FracDelay.
export class Waveguide {
  constructor(capacitySamples: number);
  /** delaySamples = lengthM / cMps · fs; asserts (throws in configure only) delaySamples ≥ 4. lossHz = one-pole LP in each rail (|H| ≤ 1). */
  configure(lengthM: number, cMps: number, fs: number, lossHz: number): void;
  setSpeed(cMps: number): void;                      // recomputes delay; caller slew-limits
  /** Per sample, call outRight()/outLeft() first (waves arriving at the B end / A end), then input(rightIn at A, leftIn at B). */
  outRight(): number;
  outLeft(): number;
  input(rightIn: number, leftIn: number): void;
  clear(): void;
  readonly delaySamples: number;
  energy(): number;                                  // Σ squares of both rails' stored samples (for tests/NaN checks)
}

// src/dsp/junction.ts — lossless parallel junction of N tubes with admittances Y_i ∝ area:
//   pJ = 2·Σ(Y_i·p_i⁺)/Σ(Y_i);  p_i⁻ = pJ − p_i⁺   (p⁺ incoming, p⁻ outgoing)
export class Junction {
  constructor(maxPorts: number);
  configure(admittances: ArrayLike<number>, n: number): void;
  scatter(incoming: Float64Array, outgoing: Float64Array): void;
  readonly ports: number;
}
export function terminationReflect(x: number, r: number): number; // r ∈ (−1, 1): open end ≈ −0.9 (plus LP in caller), closed ≈ +0.95

// src/dsp/exhaust.ts
export class ExhaustNetwork {
  constructor(fs: number);
  configure(def: EngineDef, tier: Tier): void;
  /** Speeds of sound per section group (m/s), slew-limited by caller (τ 2–5 s). */
  setGasSpeeds(header: number, collector: number, muffler: number): void;
  setValve(open01: number): void;                    // 0 closed … 1 open, caller slews (150–300 ms)
  setTurbineAttenuation(x01: number): void;          // rises with shaft speed
  /** headerIn[i] = blowdown pulse for combustion entry i this sample (Lite: summed per bank internally). popIn = injected at collector/outlet. */
  tick(headerIn: Float64Array, popIn: number): void;
  readonly outlet: number;                           // radiated pressure: tailpipe exit wave → first-order HP ≈ 20 Hz (differentiator), × valve/outlet gain (outside loops)
  readonly collectorTap: number;
  energy(): number;
  reset(): void;
}
```

Exhaust topology (Full): per combustion entry a header `Waveguide` (length `headersM[i]`, header
speed) → per bank a `Junction` joining that bank's headers + its collector tube → collector
`Waveguide` (collector speed) → turbo engines: turbine element per bank (partial reflection
`turbine.reflection`, transmitted wave through a 2-pole LP at `turbine.lpHz`, attenuated by
`(1 − 0.5·attenuation)`; all |gain| ≤ 1) → merge `Junction` (banks + mid-pipe) → mid-pipe
`Waveguide` (muffler speed) → muffler `Junction` joining mid-pipe, tailpipe and N side-branch
muffler chambers (each a `Waveguide` closed at the far end, r = +0.9; branch admittance =
`0.6 + 0.4·mufflerAction·(1 − valve)`, normalised so admittances only redistribute energy) →
tailpipe `Waveguide` → open end (reflection −0.85 through a one-pole LP at 1.5 kHz; transmitted part
= exit wave). Valve open adds a bypass: the tailpipe's input is `lerp(mufflerJunctionOut,
midPipeOut, 0.7·valve)` (convex combination, passive) and the outlet high-shelf brightens by up to
+4 dB *after* the loop. Header-end reflection at the cylinder: r = +0.7 (closed valve). Lite: 2
muffler chambers; one header waveguide per bank (inputs of that bank summed), length = mean of
that bank's headers.

```ts
// src/dsp/combustion.ts
export class CombustionSource {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  /** Must be called once per sample BEFORE tick; bit i set ⇒ entry i's next blowdown is skipped (limiter/shift cut). */
  skipMask: number;
  /** Advance crank by rpm·6/fs degrees (rpm·360/60/fs). Writes each entry's exhaust pulse sample into exhaustOut[i] and intake gate (0..1) into intakeGate[i]. Returns the ignition impulse sum (for the block layer). */
  tick(rpm: number, load: number, combustionGain: number, exhaustOut: Float64Array, intakeGate: Float64Array): number;
  /** Count of skipped firings with ignition-cut type since last read (consumed by overrun pops). */
  takeIgnitionCutPops(): number;
  readonly crankDeg: number;                         // [0, cycleDeg)
  reset(): void;
}
```

Combustion rules (spec §5.1, §5.3.1–5.3.3): entry i fires (ignition) at `angleDeg_i`; its blowdown
voice starts at `(angleDeg_i + evoOffsetDeg) mod cycleDeg` with per-cycle timing jitter ±1° (uniform)
and amplitude jitter ±5 % (uniform); `cycleAsymmetry` scales odd-cycle amplitudes by `1 + 0.5·asym`
and even by `1 − 0.5·asym`. Pulse φ ∈ [0,1] over `widthDeg` crank degrees: `E(φ) = (1 −
e^(−αφ))²·e^(−βφ)·taper(φ)`, `taper = 1` for φ ≤ 0.75 else `cos²(π/2·(φ − 0.75)/0.25)`;
normalise E so its peak is 1 (precompute peak per α,β). Amplitude `= (0.15 + 0.85·g)·jitter·combustionGain`,
`g = max(load, 0)^0.7`; effective α = `alpha·(0.7 + 0.6·max(load,0))`, clamped so time-to-peak
`ln((α+β)/β)/α · widthSamples ≥ 4` where `widthSamples = widthDeg / (rpm·6/fs)`. A per-entry DC
blocker (one-pole HP at 10 Hz) follows each pulse output. Intake gate for entry i is 1 within
`angle + 360 + [−10, 230]°` (4-stroke) or `angle + [60, 300]°` (rotary), smoothed with 10° raised
cosine edges. Ignition impulse: a 1-sample-wide unit impulse × amplitude at the firing angle
(not skipped by fuel-cut, skipped by ignition-cut). Rotary: `cycleDeg` 1080, pulses up to 300°.

```ts
// src/dsp/rpm-state.ts
export class RpmState {
  constructor(fs: number);
  configure(spec: EngineSpec): void;
  /** Per sample. Tracks ctl.rpm via one-pole τ = 40 ms; follows the shift trajectory while ctl.shift.active; runs the limiter bounce while ctl.limiter. */
  tick(ctl: DspControl, nowS: number): void;
  readonly rpm: number;
  readonly cut: boolean;          // combustion cut this sample (limiter cut phase or shift cut window)
  readonly cutIsIgnition: boolean;
  readonly falling: boolean;      // rpm decreasing over the last ~20 ms
  reset(rpm?: number): void;
}
```

RpmState rules: shift trajectory (spec §8.6): for `u = (nowS − t0)/durationS ∈ [0,1]`: cut window
`u < 0.4` (cut = true, cutIsIgnition = true for dct/pdk/amt "fart", false otherwise — RpmState gets
the gearbox type from `spec`); rpm = `fromRpm` for u < 0.3, then cosine ease to `toRpm` over u ∈
[0.3, 1]; afterwards resumes one-pole tracking from `toRpm`. Limiter: while `ctl.limiter`, local
bounce: phase "cut" → rpm falls at `hysteresisRpm / 0.05 s` until `limiter.rpm − hysteresisRpm`,
then phase "fire" → rpm rises at the same rate to `limiter.rpm`, repeat (hard types cut all; soft
types: `cut` only on every other combustion, signalled by `cut` toggling at 2× the firing rate —
CombustionSource receives skipMask = all bits for hard, alternating half for soft). Test: with
`ctl.limiter` held true for 2 s, the number of cut→fire transitions per second is 8–20 and the
longest continuous cut ≤ 100 ms.

```ts
// src/dsp/intake.ts
export class IntakeLayer { constructor(fs: number); configure(voicing: EngineVoicing, seed: number): void; tick(gateSum: number, throttle01: number): number; reset(): void }
// band-passed noise (Biquad bandpass at helmholtzHz, Q 2) × gate envelope × throttle × gain; silent when throttle01 = 0.

// src/dsp/mechanical.ts
export class MechanicalLayer { constructor(fs: number); configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void; tick(ignitionImpulse: number, rpm: number): number; reset(): void }
// block: ignition impulses → Biquad LP 250 Hz (Q 0.7) × blockGain; valvetrain: noise bursts (2 ms decaying) at rate rpm/120 × combustion count, through BP 3 kHz, × valvetrainGain.

// src/dsp/forced.ts
export class ForcedInduction {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  tick(rpm: number, load: number): number;          // returns the forced-induction bus sample (pre-perspective)
  readonly boost: number;                            // 0..1
  /** Supercharger whine frequency in Hz for the given rpm (0 if none) — used by tests. */
  whineHz(rpm: number): number;
  reset(): void;
}
// turbo: shaft target = clamp(load,0,1)·clamp((rpm − 0.25·redline)/(0.5·redline), 0, 1); shaft follows with τ = spoolTimeS (rise) / 0.6·spoolTimeS (fall);
// boost = shaft²; whistle = sines at f1 = 1000 + 3000·shaft Hz and 2·f1 (−12 dB) × boost; whoosh = noise BP 4–12 kHz × boost²;
// on lift (load drops below 0.1 while boost > 0.4): 'bov' → BP noise burst at 2.5 kHz, attack 5 ms, decay 0.5 s; 'flutter' → whoosh AM at 14 Hz decaying over 0.8 s.
// supercharger: whineOrder = pulleyRatio·gearRatio·(roots ? 2·lobes : lobes); whineHz = rpm/60·whineOrder; level ∝ boost where boost = clamp(load,0,1)·(rpm/redline); no lag.
// parallel/sequential turbos: sequential → second whistle voice enters above 0.55·redline.

// src/dsp/overrun.ts
export class OverrunLayer {
  constructor(fs: number);
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void;
  /** regime = 0 combustion … 1 overrun (already smoothstepped + slewed by caller). */
  tick(regime: number, rpm: number, falling: boolean, valveOpen01: number, modeFactor: number, ignitionCutPops: number): void;
  readonly popInject: number;      // impulse for ExhaustNetwork.tick(popIn)
  readonly airflow: number;        // overrun airflow noise (perspective-mixed with exhaust)
  reset(): void;
}
// pops: Poisson with rate λ = crackleRate·4·(valveOpen ? 2.5 : 1)·modeFactor·regime (events/s) while falling, decaying ×e^(−t/1.5 s) since overrun start;
// each pop = bounded impulse (amplitude 0.3–1.0 random) shaped by a 1 ms raised cosine; ignitionCutPops add immediate pops.
// airflow: noise LP 1.2 kHz × regime × (rpm/redline).

// src/dsp/perspective.ts
export class PerspectiveMixer {
  constructor(fs: number);
  configure(voicing: EngineVoicing): void;
  setPerspective(p: Perspective): void;              // 300 ms crossfade
  tick(exhaust: number, intake: number, block: number, fi: number, airflow: number): void;
  readonly l: number; readonly r: number;
  reset(): void;
}
// cabin: (exhaust + airflow + intake) → 4th-order Butterworth LP at cabin.lowpassHz; + block (LP 250) ×1.0; + fi → 2nd-order LP 2.8 kHz × dbToGain(cabinGainDb).
// outside: exhaust + airflow full band + intake ×0.7 + block ×0.3 + fi ×1.0.
// stereo: l = m + 0.08·d, r = m − 0.08·d where d is m through a 0.7 ms delay (decorrelation; mono-compatible).

// src/dsp/output-stage.ts
export class OutputStage {
  constructor(fs: number);
  configure(out: OutputConfig): void;                // bass mode from subwoofer; hp corner from hpCornerHz (30–60, clamped)
  beginQuantum(trimDb: number, frames: number): void; // linear trim ramp across the quantum from the previous value
  process(l: number, r: number): void;
  readonly l: number; readonly r: number;
  readonly truePeakDbtp: number;                     // max since takeTruePeak()
  takeTruePeak(): number;
  readonly gainReductionDb: number;
  nonFiniteCount: number;
  reset(): void;
}
// chain per channel: trim → NaN guard (!(x===x) || |x|>1e6 → 0, nonFiniteCount++) → DC blocker (HP 5 Hz)
// → bass: subwoofer 'yes' → 2nd-order HP 22 Hz; 'no'|'unsure' → 4th-order Butterworth HP at hpCorner + NLD virtual bass
//    (removed band = 4th-order LP at hpCorner; shaper y = 2x² − 1 term (T2) + 4x³ − 3x (T3) on the band normalised by its envelope;
//     BP hpCorner…4·hpCorner; scaled by envelope; gain 0.5·(1 − clamp((trimDb + 12)/18, 0, 1)·0.5)) summed with HP output
// → compressor (linked stereo, soft knee 6 dB, threshold −12 dBFS, ratio 3, attack 5 ms, release 120 ms)
// → true-peak limiter (linked, look-ahead 1.5 ms, 4× Upsampler4 peak detection, ceiling −1 dBTP = 0.8913, release 50 ms)
// → NaN-safe hard clip at 0.8913.  No gain stage after the limiter.

// src/dsp/analysis.ts
export function fft(re: Float64Array, im: Float64Array): void;      // in-place radix-2, length power of 2
export function hann(n: number): Float64Array;
/** Energy (linear power) at orders k·step for k = 1..floor(maxOrder/step), base frequency rpm/60; Hann-windowed Goertzel over the whole signal. */
export function orderSpectrum(signal: ArrayLike<number>, fs: number, rpm: number, maxOrder: number, step: number): Float64Array;
export function truePeakDbtp(signal: ArrayLike<number>): number;    // via Upsampler4
export function rmsDb(signal: ArrayLike<number>): number;
export function bandEnergyDb(signal: ArrayLike<number>, fs: number, loHz: number, hiHz: number): number; // FFT-based, relative to full-scale sine
export function dominantOrders(spectrum: Float64Array, step: number, topN: number): number[]; // orders sorted by energy desc

// tools/wav.ts
export function writeWav(path: string, channels: Float32Array[], fs: number): void; // 32-bit float WAV
export function readWav(path: string): { fs: number; channels: Float32Array[] };    // 16/24/32-int and 32f

// src/dsp/dsp-core.ts
export class TesboxDspCore implements DspCore {
  constructor(fs: number, seed?: number);
  configure(def: EngineDef, output: OutputConfig, tier: Tier): void; // if already running: 300 ms fade-out → apply → fade-in (no allocation)
  render(ctl: DspControl, outL: Float32Array, outR: Float32Array, frames: number, nowS: number): void;
  readonly stats: DspStats;
  /** Test hooks (not used by the worklet). */
  forceHot(): void;                                   // gas speeds to hot steady state immediately
  readonly exhaustBus: Float32Array;                  // last quantum's exhaust bus BEFORE perspective/bass (for invariants)
}
```

DspCore per-quantum control (spec §5.3): gas speeds — targets: header `343 + (700−343)·heat`,
collector `343 + (560−343)·heat`, muffler `343 + (460−343)·heat` where `heat = warmup(runTimeS or
warm) · (0.6 + 0.4·max(load,0))`, slewed with τ = 3 s (warm-up time constant 120 s; `ctl.warm` →
warmup = 1); regime target = `overrunEligible ? 1 − smoothstep(−0.08, 0.02, load) : 0` where
`overrunEligible = rpm > fuelCutResumeRpm && driveline === 'engaged'`, slewed ≥ 80 ms;
combustionGain = `max(1 − regime, idleFloor)` with idleFloor = 0.15 whenever not overrunEligible;
valve target = `valve === 'open' ? 1 : valve === 'closed' ? 0 : auto(rpm, load, driveMode)` with
auto Comfort `rpm > 3500 && load > 0.4`, Sport always 1; slewed over 200 ms. Per sample: RpmState
→ CombustionSource (skipMask from RpmState.cut) → ExhaustNetwork → layers → PerspectiveMixer →
OutputStage. Once per quantum: if `!Number.isFinite(exhaust.energy() + layer states)` → full reset
of all modules incl. OutputStage, 50 ms fade-in, `stats.nonFiniteResets++`.

## Test fixtures (T1) — `tests/fixtures/engines/`

Eight complete `EngineDef` JSON files (spec + voicing, `estimated: true`, `sources` with
"fixture" placeholder strings — fixtures are exempt from sourcing): `i4-test` (I4 1-3-4-2, turbo,
dct), `i5-test` (I5 1-2-4-5-3, 144° spacing, turbo, dct), `i6-test` (I6 1-5-3-6-2-4, NA, manual),
`v8-crossplane-test` (90° V8 cross-plane, firing 1-8-4-3-6-5-7-2 with bank assignment, NA,
tc-auto with tc data), `v8-flatplane-test` (flat-plane V8, even 90° alternating banks, NA, dct),
`v8-sc-test` (cross-plane + roots supercharger pulleyRatio 2.4, lobes 4, gearRatio 1, tc-auto),
`flat4-uel-test` (boxer 4, unequal headers 0.45/0.75, turbo, manual), `rotary-test` (13B-like:
cycleDeg 1080, 6 faces at 0/360/720 and 180/540/900, turbo sequential, manual). Ratios: plausible
6–8 speed sets; tyres plausible.

## DSP invariant tests (T9, `tests/unit/dsp-invariants.test.ts`)

Measured on `exhaustBus` (before perspective/bass) unless stated, fixed seed, `forceHot()`, load
0.5, steady rpm 2000/4000/6000 (rpm ≤ redline − 500), 1.5 s renders, first 0.5 s discarded:

1. the firing crank order `combustion.length × 360 / cycleDeg` (I4 2, I5 2.5, I6 3, V8 4,
   rotary 2) is among the top 3 orders at all three rpms;
2. sub-order energy (½ orders for 4-stroke uneven-fire: i5, v8-crossplane, v8-sc, flat4-uel;
   ⅓ orders for rotary) ≥ firing order − 30 dB; for even-fire (i4, i6, v8-flatplane) half-order
   energy ≤ firing order − 20 dB;
3. rotary: crank order 2 dominant;
4. supercharger: spectral peak within 0.5 % of `whineHz(rpm)` in a **cabin** perspective render
   (full output);
5. turbo whistle line detectable in cabin render at load 1, rpm 0.7·redline (band 1–4 kHz energy ≥
   −45 dB re total);
6. limiter: render with ctl.limiter held 2 s → 8–20 bounces/s, no cut > 100 ms;
7. passivity: impulse into every header with combustion disabled, for every fixture × valve {0,1} ×
   gas speeds {343, hot}: total `energy()` decays monotonically (checked per 50 ms window) to
   ≤ −120 dB re initial within 2 s;
8. fuzz: 10 000 quanta with random ctl (rpm 0–12000, load −1…1, random shifts/limiter/valve/
   perspective/trim −24…+6 dB) → no NaN/Inf in output, `truePeakDbtp(output) ≤ −1.0`;
9. at 9000 rpm (v8-flatplane-test, redline raised in a copy to 9500) energy above 16 kHz ≤ −60 dB re
   total in the exhaust bus;
10. determinism: two renders in-process with the same seed are bit-identical.

## T10 tooling

- `tools/segments.ts`: `export interface Segment { name: string; durationS: number; ctl(t: number, base: DspControl): void }`
  and `SEGMENTS: Segment[]` = idle (5 s), cruise2k / cruise4k / cruise6k (4 s each, load 0.3),
  wotPull (idle → limiter with load 1, auto shifts every redline crossing, 12 s), liftoff6k (6000 →
  idle, load −0.6, 6 s), limiterHold (4 s), autoShiftPull (gears 1–4 with shift events, 10 s).
- `tools/render.ts`: `tsx tools/render.ts <engine-id-or-json-path> [--segments a,b] [--perspective cabin|outside] [--subwoofer yes|no] [--out renders/] [--fs 48000]` →
  one WAV per segment; engine id resolves `src/data/engines/<id>.json` if present else
  `tests/fixtures/engines/<id>.json`. `renders/` is gitignored.
- `tools/check-alloc.ts`: run with `node --expose-gc --max-semi-space-size=1 --import tsx tools/check-alloc.ts`;
  `PerformanceObserver` on `gc`; warm 10 000 renders, then 100 000 `render()` calls on
  `v8-crossplane-test`; exit 1 if any minor GC observed. npm script `check:alloc`.
- `tools/bench-dsp.ts`: realtime factor for Full and Lite on two fixtures; prints a markdown table;
  exits 1 only if Full < 20× realtime. npm script `bench:dsp`.
- `eslint.config.js`: add a block for `src/dsp/**/*.ts` and `src/sim/**/*.ts` with
  `no-restricted-syntax` selectors `MethodDefinition[key.name=/^(tick|process|render|scatter|write|read[A-Za-z]*|step|push|accept|evaluate|update|next|request|input|out[A-Za-z]*)$/] :matches(NewExpression, ArrayExpression, ObjectExpression, ArrowFunctionExpression, FunctionExpression, SpreadElement, TemplateLiteral, TryStatement, ThrowStatement)`
  with message "Hot path must not allocate (spec §4.4)".
- npm scripts added: `render`, `check:alloc`, `bench:dsp`.

## Conventions

As Phase 0. One verified commit for the phase. Sources of every algorithm logged in
`docs/CLEAN_ROOM.md` (T10 appends): Baldan 2015, Farnell 2010, Doerfler & Wyse 2026 (methods),
Smith "Physical Audio Signal Processing" (waveguides/junctions), RBJ cookbook, Larsen & Aarts 2002,
ITU-R BS.1770 (true peak), Kaiser window design.

## Amendments (2026-10-06, authoritative — override anything above)

- **B1 ESLint hot-path selector:** `MethodDefinition[key.name=/^(…same names…)$/] > FunctionExpression > BlockStatement :matches(NewExpression, ArrayExpression, ObjectExpression, ArrowFunctionExpression, FunctionExpression, SpreadElement, TemplateLiteral, TryStatement, ThrowStatement)` (the original selector matched every hot method's own FunctionExpression).
- **B2 Allocation gate (replaces "any minor GC → exit 1"):** V8 boxes doubles crossing non-inlined
  calls, so zero GCs is not achievable with scalar per-sample APIs. `tools/check-alloc.ts` runs
  with default V8 flags (plus `--expose-gc`) and default semispace, renders 100 000 quanta of
  `v8-crossplane-test` (Full) after 10 000 warm-up quanta, and **fails if any single GC pause
  > 1.0 ms or total GC time > 1 % of the rendered audio duration**; it also prints minor-GC count.
  Hot modules are encouraged to pass per-sample values through fields/typed arrays to avoid
  boxing; contract signatures stay as declared. The syntactic rule (B1) still bans allocation syntax.
- **B3 Capacity:** delay capacities are sized at `SPEED_OF_SOUND_COLD` (343 m/s) and
  `MAX_SAMPLE_RATE` (the longest delay is at the slowest speed); the ≥ 4-sample minimum is asserted
  at 700 m/s. ExhaustNetwork may reject fs < 28 kHz.
- **B4 Cut type:** `CombustionSource` gains `skipIsIgnition: boolean` (set by DspCore every sample
  next to `skipMask`, from `RpmState.cutIsIgnition`). Any skipped firing suppresses both its
  blowdown pulse and its ignition impulse; skipped firings with `skipIsIgnition` are counted for
  `takeIgnitionCutPops()`.
- **B5 Limiter hard/soft:** `RpmState.cut` is true for the whole cut phase for all limiter types;
  DspCore sets `skipMask` = all bits for `*-hard`, alternating entries (bits 0,2,4,…) for `*-soft`;
  `skipIsIgnition` = `type.startsWith('ignition')` during limiter cuts and `RpmState.cutIsIgnition`
  during shift cuts.
- **B6 Performance floor:** `bench:dsp` exits 1 only if Full < 10× realtime (report-only otherwise).
- **B7 Valve bypass:** passive formulation `S = (1 − a)·S_junction + a·S_bypass` on the muffler
  junction ports (mid↔tail straight-through with Y_mid = Y_tail, chambers absorbed) is
  authoritative; tailpipe input equals the stated lerp.
- **B8 Fixtures:** even-fire fixtures (`i4-test`, `i6-test`, `v8-flatplane-test`) use equal header
  lengths for every entry, so half-order energy comes only from jitter (invariant 2's even-fire
  branch stays meaningful).
- **B9 Limiter target:** internal limiter target −1.3 dBTP; final clip 0.8913; invariant 8 asserts
  `truePeakDbtp ≤ −1.0`.
- **B10 Open end:** the exit wave is the transmitted flow-like wave `p⁺ − p⁻` (keeps LF energy so
  the firing order dominates); radiation differentiator (≈ 20 Hz HP) follows.
- **B2 (revised 2026-10-07, supersedes B2 above):** measured with the plan's code: total GC ≈ 0.045 %
  of audio time but individual scavenges of 1.1–2.0 ms (boxed doubles across non-inlined per-sample
  calls). Audible risk depends on output buffering (Tesla browser outputLatency ≈ 99 ms average, i.e.
  many quanta buffered), so `check-alloc` **fails if any single GC pause > 4.0 ms or total GC time >
  1 % of rendered audio duration**, and prints the scavenge count and longest pause. The in-car
  Diagnostics overload/glitch counters are the real gate (spec §1.3b). If the car shows overload,
  the documented remedy is boxing-free block methods (`processBlock(buf: Float64Array, n)`) on the
  per-sample modules — Phase 4 hardening, not Phase 2a.
- **B11 Topology:** one header→collector Junction, collector Waveguide and turbine 2-port per
  `voicing.collectors` entry, joining the headers of every bank that entry lists (identical to
  per-bank when each collector lists one bank); the merge Junction joins all collectors + mid-pipe.
- **B12 IntakeLayer:** de-zips throttle with τ ≈ 20 ms and reaches exact silence (0) within 20 ms
  of `throttle01 = 0` (click-free; replaces "silent when throttle01 = 0" literally).
- **B13 Lite scope:** Lite reduces the exhaust only (≤ 2 muffler chambers, one header per bank);
  layers are tier-independent in Phase 2a. (Spec §5.7 "fewer noise bands" is deferred to Phase 4
  if the in-car headroom requires it.)
- **B14 truePeakDbtp:** no zero-flush after the signal (an abrupt step to 0 adds Gibbs overshoot not
  present in the signal); measure the 4× upsampled peak over the signal only.
- **B15 goldens:** `goldens:update` (spec §14) is deferred to Phase 2b, where the score CLI defines
  the reviewed numeric snapshots.
- **B16 CI:** Phase 2a T10 adds `- run: npm run bench:dsp` and `- run: npm run check:alloc` after
  `npm test` in the `test` job of `.github/workflows/ci.yml` (created by Phase 0 T12; plain `run:`
  steps, no new `uses:`). Also: `render.test.ts` asserts every segment ≤ −1.0 dBTP at +6 dB trim
  (spec §1.3c), with `renderSegment` accepting `trimDb`.
- **B17 ESLint hot-path names:** the B1 name list uses `input[A-Za-z]*` (not bare `input`) so
  `inputPair()` and similar per-sample methods are covered.
- **B6 (revised 2026-10-08, supersedes B6):** CI gate `FULL_FLOOR = 5×` realtime on the best of 3
  windows (catches gross regressions only); `FULL_TARGET = 10×` is the reported development target.
  Reason: on Node 22 (CI's version) the Full tier measured 10.1–11.1× best-of-3 on the dev host, so a
  10× gate flaked. In-car headroom is measured by the Phase 0 probe; raising DSP speed (boxing-free
  block paths, B2-revised remedy) is a Phase 4 hardening item.
- **B18 Forced-induction levels (2026-10-15, phase 5 contract P0.1):** `voicing.forcedInduction` gains
  `whistleDb` (−60 … 0 dB, default −36) and `outsideGainDb` (−60 … 0 dB, default −30), both required
  by the schema and set by `defaultVoicing`. `whistleDb` scales the turbo whistle voices alone, relative
  to the whistle above (`whistle × dbToGain(whistleDb)` inside `ForcedInduction`, so in both
  perspectives); the whoosh, the BOV / flutter events and a supercharger's whine ignore it.
  `cabinGainDb` keeps scaling the whole forced-induction bus (whistle, whoosh, lift events, whine) in
  the cabin; the outside mix becomes `… + fi × dbToGain(outsideGainDb)` (−30 dB when the voicing has
  no forcedInduction block). Evidence (2026-10-15 gap analysis of the tuned pilots, every number with
  the repo's own scoring): the `fiLine` detector found the render's whistle at ≈ 31 dB median
  prominence in 87 % of WOT frames above 4 500 rpm — 33–36 dB louder than anything the recordings
  show; `cabinGainDb` scaled whistle and whoosh together, so even −70 dB left it detected (61 %); the
  outside mix added the turbo at full level. Whistle-only −30 dB removed the line from the WOT frames,
  −40 dB gave fiPresence 0.966; the outside turbo needed about −36 to −42 dB.
  **Invariant 5 restated** (the old text required the whistle the recordings do not have): at
  `whistleDb = 0` the whistle line is detectable in the cabin render at load 1, rpm 0.7·redline
  (1–4 kHz energy ≥ −45 dB re total; muting the forced-induction bus, or the whistle alone, removes
  > 3 dB from the band) and the band's spectral peak lies within 1 % of the shaft's
  f1 = 1000 + 3000·shaft (or of the sequential voice at 0.88·f1); at the default levels (whistleDb
  −36, outsideGainDb −30) removing the whistle changes the 1–4 kHz band by < 1 dB in the cabin and in
  the outside render — the whistle sits below the engine (measured on the turbo fixtures: ≤ 0.06 dB).
  The DSP test fixtures (`tests/fixtures/engines/`) keep the Phase 2a levels (whistleDb 0,
  outsideGainDb 0), so the detector, tracker and scoring tests measure the signals they were written
  against; invariant 5 applies the defaults explicitly.
- **B19 Cabin transfer (2026-10-15, phase 5 contract P0.2; replaces "4th-order Butterworth LP at
  cabin.lowpassHz"):** the cabin's (exhaust + airflow + intake) path is one biquad, a 2nd-order
  Butterworth low-pass at `cabin.lowpassHz` (200–2000) plus a high-frequency leak `cabin.leakDb`
  (−60 … −10 dB, default −30; required by the schema, set by `defaultVoicing`):
  H(s) = (1 + √(2g)·s + g·s²) / (1 + √2·s + s²), s normalised to the corner, g = dbToGain(leakDb),
  bilinear transform prewarped at the corner (`Biquad.lowpassLeak(f, g, fs)`). Its squared magnitude
  (1 + g²Ω⁴) / (1 + Ω⁴) is the power sum of the Butterworth low-pass and the leak through the
  matching Butterworth high-pass, so the response falls 12 dB/octave above the corner and levels off
  at g (exactly g at Nyquist) without the notch a coherent `LP₂ + g·HP₂` cuts at fc/√g; minimum phase,
  unity at DC; g = 0 is `lowpass(fc, 1/√2)`. The cabin mix line of §APIs reads: cabin: (exhaust +
  airflow + intake) → this transfer; + block (LP 250) × 1.0; + fi → 2nd-order LP 2.8 kHz ×
  dbToGain(cabinGainDb); outside: exhaust + airflow full band + intake × 0.7 + block × 0.3 + fi ×
  dbToGain(outsideGainDb) (B18). Evidence: the 4th-order LP near 600 Hz left 1.5–3 kHz 15–20 dB below
  the recordings, whose 0.8–2.5 kHz band is 41–83 % engine harmonics; test renders with a 2nd-order LP
  at 2 kHz (+ valvetrain 1.0 and whistle −40 dB) passed every i5-turbo-25 gate (composite 0.511), and a
  −30 dB leak on v8-flatplane-45 gave 0.584. DSP invariants, allocation and true-peak gates unchanged.
  **Fixtures:** the DSP test fixtures keep their Phase 2a cabin passband — each `cabin.lowpassHz` moves
  to where this transfer's −1 dB point lies at the old 4th-order's (× (10^0.1 − 1)^(−1/8) ≈ 1.184:
  600 → 710 Hz …), with no leak (`leakDb` −60, the floor) — and the turbo fixtures' `cabinGainDb` goes
  to −10 dB (the schema maximum), so their whistle stays the strongest 1–4 kHz line over the brighter
  cabin engine. With the old corners and −30 dB the brighter cabin broke the Phase 2b acceptance cells
  written against the Phase 2a renders: a confidently-wrong half-rpm frame (confidence 0.56) in
  i4-test's 2nd upshift over idle..limiter (D4(3)), v8-flatplane-test's wotPull voiced share 0.39 < 0.4
  (D4(4)), and the same-engine fiPresence of i4-test's cruise4k (0.87 < 0.9; engine harmonics near
  the D5 detector's threshold); a fit at the −12 dB point (× 1/√2) kept the whistle tests but left
  v8-flatplane-test's cabin voiced share at 0.32.
