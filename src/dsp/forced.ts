import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, dbToGain, flush, Rng, smoothstep } from './util';

/** Whistle sine amplitude at boost 1 (single voice) at whistleDb = 0 (phase 2a amendment B18 scales it). */
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
 * and 2·f1 at −12 dB, × boost × dbToGain(whistleDb), amendment B18) + whoosh (4–12 kHz noise × boost²) +
 * BOV / flutter on lift.
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
  /** WHISTLE_AMP × dbToGain(voicing.forcedInduction.whistleDb) (B18: the whistle alone). */
  private whistleAmp = WHISTLE_AMP;
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
    this.whistleAmp = WHISTLE_AMP;
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
      this.whistleAmp = WHISTLE_AMP * dbToGain(fi.whistleDb);
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
      whistle *= this.whistleAmp * boost;
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
