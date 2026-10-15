/**
 * Tesbox shared contracts — AUTHORITATIVE.
 *
 * Every module imports cross-module types and constants from here. If prose anywhere (plans,
 * comments) disagrees with a type or formula in this file, this file wins.
 *
 * Units: SI everywhere (m, s, m/s, m/s², N, W, kg, Hz, rpm for engine speed, dB for gains).
 * Time: simulation time is the AudioWorklet `currentTime` domain, in seconds (spec §4.3).
 * Gears: 1-based (gear 1 = first gear). `overallRatios[gear - 1]`.
 * Load: [-1, 1]; > 0 = throttle fraction of the selected Tesla's available force; < 0 = overrun.
 */

// ───────────────────────────── Enumerations ─────────────────────────────

export type ValveMode = 'auto' | 'open' | 'closed';
export type Perspective = 'cabin' | 'outside';
export type GearboxMode = 'auto' | 'manual';
export type DriveMode = 'comfort' | 'sport';
export type SpeedSourceKind = 'gps' | 'demo' | 'keyboard' | 'replay';
export type Tier = 'full' | 'lite';
export type Subwoofer = 'yes' | 'no' | 'unsure';
export type OutputRoute = 'direct' | 'media-element' | 'direct-anchor';
export type EngineSet = 'euro' | 'jdm' | 'american' | 'exotic';
export type GearboxType = 'dct' | 'pdk' | 'tc-auto' | 'manual' | 'amt';
export type LimiterType = 'ignition-hard' | 'ignition-soft' | 'fuel-hard' | 'fuel-soft';
export type AspirationType = 'na' | 'turbo' | 'supercharger';
export type TurboLayout = 'single' | 'parallel' | 'sequential';
export type SuperchargerKind = 'roots' | 'twin-screw';
export type LiftEvent = 'bov' | 'flutter';
export type Driveline = 'engaged' | 'clutch-open' | 'tc-stall' | 'slipping';

// ───────────────────────────── Engine definition (spec §5.2) ─────────────────────────────

export interface CombustionEntry {
  /** Crank (4-stroke) or eccentric-shaft (rotary) angle in degrees, in [0, cycleDeg). */
  angleDeg: number;
  /** Exhaust bank index (0-based); collectors reference banks. */
  bank: number;
}

export interface EngineSpec {
  layout: {
    type: 'inline' | 'v' | 'flat' | 'rotary';
    /** 0 for inline/rotary, 180 for flat, V angle otherwise. */
    bankAngleDeg: number;
    /** V8 crank type; 'n/a' for everything else. */
    crank: 'cross-plane' | 'flat-plane' | 'n/a';
    displacementL: number;
  };
  /** 720 for 4-stroke, 1080 for rotary (spec §5.1). */
  cycleDeg: 720 | 1080;
  /** One entry per cylinder (4-stroke) or per rotor face (rotary). Max MAX_COMBUSTION. */
  combustion: CombustionEntry[];
  rpm: {
    idle: number;
    redline: number;
    limiter: { type: LimiterType; rpm: number; hysteresisRpm: number };
  };
  aspiration: {
    type: AspirationType;
    turbo: { count: number; layout: TurboLayout } | null;
    supercharger: {
      kind: SuperchargerKind;
      /** Crank pulley → blower pulley ratio (blower turns faster when > 1). */
      pulleyRatio: number;
      /** Internal gear step-up (twin-screw), 1 if none. */
      gearRatio: number;
      /** Roots: lobes per rotor. Twin-screw: male rotor lobes. */
      lobes: number;
    } | null;
  };
  gearbox: {
    type: GearboxType;
    /** Gear ratio × applicable final drive, gear 1 first. Strictly descending. */
    overallRatios: number[];
    /** ISO tyre code of the DRIVEN axle, e.g. "265/30R19" (front tyre for transverse/Haldex AWD). */
    drivenTyre: string;
    /** Authoritative shift duration in seconds. */
    shiftTimeS: number;
    /** Required iff type === 'tc-auto'. lockupTurbineRpm is TURBINE rpm. couplingSR in [0.80, 0.95]. */
    tc: { stallRpmWot: number; lockupTurbineRpm: number; couplingSR: number } | null;
  };
  /** Per field group: at least one source URL or document citation each. */
  sources: {
    layout: string[];
    combustion: string[];
    rpm: string[];
    aspiration: string[];
    gearbox: string[];
  };
}

export interface EngineVoicing {
  pulse: {
    widthDeg: number; // 40–90 (4-stroke), up to 300 (rotary)
    alpha: number; // onset sharpness, > 0
    beta: number; // decay, > 0
    evoOffsetDeg: number; // exhaust-valve-opening offset after firing, default 140
    cycleAsymmetry: number; // 0–1 growl
  };
  /** Header length per combustion entry (same order as spec.combustion), metres. */
  headersM: number[];
  collectors: { banks: number[]; lengthM: number }[];
  /** Turbo engines only (null for NA/supercharged). */
  turbine: { reflection: number; lpHz: number } | null;
  exhaust: {
    midPipeM: number;
    mufflerSectionsM: number[]; // 1–4 sections (Lite uses the first 2)
    mufflerAction: number; // 0–1, applied at outlet tap only (never in-loop gain > 1)
    tailpipeM: number;
    valve: { fitted: boolean; openGainDb: number };
  };
  intake: { runnerM: number; helmholtzHz: number; gain: number };
  forcedInduction: {
    spoolTimeS: number;
    maxShaftKrpm: number;
    lift: LiftEvent;
    /** Cabin level of the whole forced-induction bus (whistle, whoosh, lift events, supercharger whine). */
    cabinGainDb: number; // −20 … −10
    /** Turbo whistle only, relative to the Phase 2a whistle (phase 2a amendment B18); default −36. */
    whistleDb: number; // −60 … 0
    /** Outside level of the whole forced-induction bus (B18; Phase 2a mixed it at 0 dB); default −30. */
    outsideGainDb: number; // −60 … 0
  } | null;
  mechanical: { blockGain: number; valvetrainGain: number };
  overrun: { crackleRate: number; fuelCutResumeRpm: number };
  /**
   * Cabin transfer (phase 2a amendment B19): a 2nd-order Butterworth low-pass at lowpassHz (200–2000) plus a
   * high-frequency leak at leakDb (−60 … −10, default −30) that keeps the engine's upper harmonics.
   */
  cabin: { lowpassHz: number; leakDb: number };
  /** Clutch/DCT launch target rpm (voicing, not manufacturer data). */
  launchRpm: number;
  /** true until tuned and signed off in the Sound Lab. */
  estimated: boolean;
}

export interface EngineDef {
  id: string; // kebab-case, unique, e.g. "i5-turbo-25"
  name: string; // generic title, e.g. "2.5 Turbo Inline-5"
  inspiredBy: string; // subtitle only, e.g. "Audi RS 3"
  set: EngineSet;
  notes: string;
  spec: EngineSpec;
  voicing: EngineVoicing;
}

// ───────────────────────────── Tesla catalogue (spec §9.2) ─────────────────────────────

export interface TeslaRecord {
  id: string; // unique, e.g. "model3-highland-lr-awd"
  model: 'Model S' | 'Model X' | 'Model 3' | 'Model Y' | 'Model Y L' | 'Cybertruck';
  generation: string;
  years: [number, number];
  trim: string;
  markets: ('US' | 'EU' | 'CN' | 'other')[];
  massKg: number;
  massBasis: 'us-curb' | 'eu-unladen-incl-driver' | 'test-weight';
  peakPowerKw: number;
  accel: { seconds: number; basis: '0-60mph' | '0-100kmh'; rolloutSubtracted: boolean };
  accelModes: { name: string; factor: number }[]; // last entry = quickest mode, factor 1.0
  roadLoadRef: string; // key into roadload.json
  subwooferDefault: boolean;
  mcu: ('intel' | 'amd' | 'tegra')[]; // possible values; runtime detection is authoritative
  supported: boolean; // false for MCU1-only configurations
  sources: { mass: string[]; power: string[]; accel: string[]; audio: string[] };
}

export interface RoadLoadRecord {
  ref: string;
  /** SI, converted from EPA *Target* coefficients at catalogue build time. */
  A_N: number;
  B_Nps_m: number; // may be negative
  C_Ns2_m2: number;
  source: string; // "EPA <year> Test Car List: <row>" or "derived: CdA=…, Crr=…"
}

/** Resolved numbers the simulation needs for the selected Tesla (computed by tools at build time). */
export interface TeslaParams {
  massKg: number; // normalised mass incl. 75 kg occupant where the basis lacks one
  roadLoad: { A_N: number; B_Nps_m: number; C_Ns2_m2: number };
  fTracN: number; // traction-limited max force
  pEffW: number; // effective wheel power
  eta: number; // 0.90
  modeFactor: number; // selected accelMode factor
}

export const ETA_DRIVETRAIN = 0.9;
export const OCCUPANT_KG = 75;
export const G = 9.80665;

// ───────────────────────────── Output / audio config ─────────────────────────────

export interface OutputConfig {
  subwoofer: Subwoofer;
  /** No-sub high-pass corner, 30–60 Hz, default 40 (spec §5.6). Ignored when subwoofer === 'yes'. */
  hpCornerHz: number;
  volumeTrimDb: number; // −24 … +6, applied BEFORE the compressor
}

export interface SimTuning {
  gpsLatencyS: number; // default 1.0
  kalmanQ: number; // white-jerk spectral density, default 2 (m/s³)²/Hz
  tauA: number; // prediction saturation constant, default 0.6 s
  outputLatencyS: number; // default 0.1
}

export const DEFAULT_SIM_TUNING: SimTuning = {
  gpsLatencyS: 1.0,
  kalmanQ: 2,
  tauA: 0.6,
  outputLatencyS: 0.1,
};

export const DEFAULT_OUTPUT: OutputConfig = { subwoofer: 'unsure', hpCornerHz: 40, volumeTrimDb: 0 };

// ───────────────────────────── Messages: main → worklet ─────────────────────────────

/** Raw GPS fix (spec §4.3). ageS already includes gpsLatencyS. lat/lon never leave the device. */
export interface FixMsg {
  type: 'fix';
  ageS: number;
  speedMps: number | null;
  lat: number;
  lon: number;
  accuracyM: number;
  altitudeM: number | null;
}

export type InputMsg =
  | { type: 'shiftUp' }
  | { type: 'shiftDown' }
  | { type: 'pedal'; throttle: number; brake: number } // 0..1 each; keyboard/demo sources
  | { type: 'valve'; mode: ValveMode }
  | { type: 'perspective'; value: Perspective }
  | { type: 'gearboxMode'; value: GearboxMode }
  | { type: 'driveMode'; value: DriveMode }
  | { type: 'volume'; trimDb: number }
  | { type: 'visibility'; hidden: boolean }
  | { type: 'ignition'; on: boolean } // on → key-on/crank/idle sequence; off → engine stop
  | { type: 'bench'; k: number } // headroom benchmark: render DSP k× per quantum (1 = normal)
  // Phase 3 (spec §9.3 bass sweep): a sine at `hz` replaces the engine output, passed through an
  // output stage WITHOUT the bass-management high-pass (still compressor + true-peak limiter);
  // `hz: null` ends the tone (50 ms fades both ways). levelDb is the sine peak before the stage.
  | { type: 'testTone'; hz: number | null; levelDb: number };

export type ConfigMsg =
  | { type: 'engine'; def: EngineDef }
  | { type: 'tesla'; params: TeslaParams }
  | { type: 'output'; config: OutputConfig }
  | { type: 'source'; value: SpeedSourceKind }
  | { type: 'tier'; value: Tier }
  | { type: 'tuning'; value: SimTuning }
  | { type: 'warm'; warm: boolean }; // engine starts warm (spec §5.3.5)

export type MainToWorklet = FixMsg | InputMsg | ConfigMsg;

// ───────────────────────────── Messages: worklet → main ─────────────────────────────

/** Indices into the StateSnapshot Float64Array (spec §4.2). */
export const S = {
  time: 0, // worklet currentTime (s)
  rpm: 1,
  gear: 2,
  speedMps: 3,
  load: 4,
  flags: 5, // bitfield, see F
  boost: 6, // 0..1
  nonFiniteResets: 7,
  fixesAccepted: 8,
  fixesRejected: 9,
  busyFrac: 10, // windowed mean busy fraction of the quantum budget, NaN if unknown
  tier: 11, // 0 = full, 1 = lite
  benchK: 12,
  throttle: 13, // estimated throttle 0..1 (positive part of load)
} as const;
export const STATE_LEN = 14;

/** StateSnapshot flag bits. */
export const F = {
  GPS_LOST: 1 << 0,
  STANDSTILL: 1 << 1,
  PREDICTING: 1 << 2,
  LIMITER: 1 << 3,
  SHIFTING: 1 << 4,
  OVERRUN: 1 << 5,
  SPEED_UNUSABLE: 1 << 6,
  OVERLOAD: 1 << 7,
  HIDDEN_HOLD: 1 << 8,
  CLUTCH_OPEN: 1 << 9,
  MANUAL_OVERRIDE: 1 << 10, // Auto mode paddle override active (spec §7.1)
  SHIFT_REFUSED: 1 << 11, // last requested downshift refused (over-rev); cleared after 500 ms
} as const;

export type WorkletToMain =
  | { type: 'state'; buf: Float64Array } // length STATE_LEN, ~30 Hz
  | { type: 'ready' }
  | { type: 'error'; message: string };

// ───────────────────────────── Core interfaces ─────────────────────────────

/** Shift trajectory owned by SimCore, followed by DspCore (spec §8.6). */
export interface ShiftState {
  active: boolean;
  up: boolean;
  fromRpm: number;
  toRpm: number;
  t0: number; // worklet seconds
  durationS: number;
}

/** SimCore output, mutated in place each step (no allocation). */
export interface SimOutput {
  rpm: number; // target engine rpm (clamped to limiter.rpm while limiter is set)
  gear: number; // 1-based; 0 = neutral (pre-ignition only)
  speedMps: number;
  accelMps2: number;
  load: number; // [-1, 1], low-passed
  driveline: Driveline;
  limiter: boolean;
  flags: number; // F bits owned by SimCore (all except OVERLOAD, which the worklet sets)
  shift: ShiftState;
  ignitionOn: boolean;
  /** Seconds since ignition on (crank/idle sequence and warm-up use it). */
  runTimeS: number;
}

export interface SimCore {
  configure(engine: EngineSpec, voicing: EngineVoicing, tesla: TeslaParams, tuning: SimTuning): void;
  setSource(kind: SpeedSourceKind): void;
  /** nowS = worklet currentTime at receipt. Returns true if the fix was accepted. */
  pushFix(fix: FixMsg, nowS: number): boolean;
  pushInput(msg: InputMsg, nowS: number): void;
  /** Advance to nowS by dtS (one render quantum). Never allocates. */
  step(nowS: number, dtS: number): void;
  readonly out: SimOutput;
}

/** Per-quantum control the worklet hands to DspCore (copied from SimOutput + user settings). */
export interface DspControl {
  rpm: number;
  load: number;
  gear: number;
  driveline: Driveline;
  limiter: boolean;
  shift: ShiftState;
  ignitionOn: boolean;
  runTimeS: number;
  valve: ValveMode;
  perspective: Perspective;
  driveMode: DriveMode;
  warm: boolean;
}

export interface DspStats {
  nonFiniteResets: number;
  boost: number; // 0..1
  limiterGainReductionDb: number;
  truePeakDbtp: number; // max since last read
}

export interface DspCore {
  /** Capacity is allocated in the constructor; configure() never allocates (spec §4.4). */
  configure(def: EngineDef, output: OutputConfig, tier: Tier): void;
  /** Render `frames` samples (≤ 128) of stereo audio for the given control at time nowS. */
  render(ctl: DspControl, outL: Float32Array, outR: Float32Array, frames: number, nowS: number): void;
  readonly stats: DspStats;
}

// ───────────────────────────── Capacity constants (spec §4.4) ─────────────────────────────

export const MAX_COMBUSTION = 16;
export const MAX_SAMPLE_RATE = 48000;
export const QUANTUM = 128;
export const SPEED_OF_SOUND_COLD = 343; // m/s
export const SPEED_OF_SOUND_MAX = 700; // m/s (header at WOT)

// ───────────────────────────── Shared formulas (authoritative) ─────────────────────────────

/** Firing fundamental in Hz (spec §5.1). */
export function firingHz(rpm: number, combustionCount: number, cycleDeg: number): number {
  return (rpm / 60) * combustionCount * (360 / cycleDeg);
}

/** Minimum touch-target size in CSS px for ≥ 22 mm on any Tesla panel (spec §7.1). */
export function minTouchCssPx(devicePixelRatio: number): number {
  return Math.ceil(((22 / 25.4) * 190) / devicePixelRatio);
}

/** EPA Target coefficient conversions (lbf, lbf/mph, lbf/mph²) → SI (spec §8.5). */
export const EPA_TO_SI = { A: 4.448222, B: 9.9504, C: 22.2583 } as const;
