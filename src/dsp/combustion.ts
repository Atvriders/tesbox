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
 * Per-cylinder level (phase 2a amendment B20): entry k's firing amplitude — its blowdown pulse and its ignition
 * impulse alike — carries the fixed factor dbToGain(cylinderSpreadDb · cylinderSpreadPattern(k, n)), set at configure
 * (exactly 1 at cylinderSpreadDb 0, so the tick is unchanged).
 *
 * `tick` is a hot path (spec §4.4): no allocation; all state is capacity-sized in the constructor.
 */
import { MAX_COMBUSTION } from '../contracts';
import type { EngineSpec, EngineVoicing } from '../contracts';
import { clamp, dbToGain, flush, Rng } from './util';

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
/** voicing.pulse.cylinderSpreadDb ceiling (engine.schema.json; phase 2a amendment B20). */
export const CYLINDER_SPREAD_MAX_DB = 6;

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

/**
 * Phase 2a amendment B20: the fixed per-cylinder combustion-level pattern, in units of voicing.pulse.cylinderSpreadDb —
 * cylinder (combustion entry) k of n: +1 for k = 0, −1/(n − 1) for every other k; 0 for a single cylinder and for k
 * outside 0 … n − 1. Zero mean in dB across the cylinders. One cylinder deviates and the others share the opposite
 * offset, so the firing train is g₁ × the even train plus (g₀ − g₁) × one cylinder's own train (g = the cylinders'
 * gains), whose lines are equally strong at every multiple of the cycle rate (½ order; ⅓ e-shaft order for a
 * rotary): every non-firing order gains the same level whatever the firing order or the layout — for an even-firing
 * engine |non-firing| / |firing| = (g₀ − g₁) / (g₀ + (n − 1)·g₁), −11.2 dB for an I4 at 6 dB. Allocation-free.
 */
export function cylinderSpreadPattern(k: number, n: number): number {
  if (!(n >= 2) || !(k >= 0) || k >= n) return 0;
  return k === 0 ? 1 : -1 / (n - 1);
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
  /** Fixed per-entry level: the rotary face signature × the B20 cylinder spread (1 for a 4-stroke without spread). */
  private readonly levelScale = new Float64Array(MAX_COMBUSTION);
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
    const spread = clamp(finiteOr(p.cylinderSpreadDb, 0), 0, CYLINDER_SPREAD_MAX_DB);
    for (let i = 0; i < MAX_COMBUSTION; i++) {
      const entry = spec.combustion[i];
      const a = entry === undefined ? 0 : wrapDeg(finiteOr(entry.angleDeg, 0), cycle);
      this.angle[i] = a;
      this.gateOrigin[i] = wrapDeg(a + gateStart - INTAKE_EDGE_DEG / 2, cycle);
      const face = rotary ? 1 + ROTARY_FACE_DEPTH * Math.cos((2 * Math.PI * a) / cycle) : 1;
      // B20: no spread leaves the factor out entirely, so a voicing at 0 dB renders bit-identically to one without it.
      this.levelScale[i] = spread > 0 ? face * dbToGain(spread * cylinderSpreadPattern(i, n)) : face;
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
          const amp = level * jitter * (odd ? this.asymOdd : this.asymEven) * (this.levelScale[i] ?? 1) * gain;
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
