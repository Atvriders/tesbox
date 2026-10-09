import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, flush, Rng } from './util';

/** Contract: λ = crackleRate·4·(valveOpen ? 2.5 : 1)·modeFactor·regime events/s, × e^(−t/1.5 s). */
export const POP_RATE_PER_CRACKLE = 4;
/** Valve factor at valveOpen01 = 1; interpolated linearly: 1 + (POP_VALVE_FACTOR − 1)·valveOpen01. */
export const POP_VALVE_FACTOR = 2.5;
export const POP_DECAY_TAU_S = 1.5;
/** Each pop: amplitude uniform in [POP_AMP_MIN, POP_AMP_MAX] × a raised-cosine window POP_LEN_S long. */
export const POP_LEN_S = 0.001;
export const POP_AMP_MIN = 0.3;
export const POP_AMP_MAX = 1.0;
/** Queued pops (Poisson arrivals during a pop + ignition-cut pops) are capped at this count. */
export const POP_MAX_PENDING = 8;
/** An overrun episode starts when regime rises above ENTER (decay timer restarts) and ends below EXIT. */
export const OVERRUN_ENTER = 0.1;
export const OVERRUN_EXIT = 0.02;
/** Airflow: noise → 2nd-order Butterworth LP at AIRFLOW_LP_HZ; RMS = AIRFLOW_RMS · regime · rpm/redline. */
export const AIRFLOW_LP_HZ = 1200;
export const AIRFLOW_RMS = 0.1;
/** rpm/redline is capped here so a wild rpm cannot blow the airflow level up. */
const AIRFLOW_RPM_CAP = 2;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x4d5e6f7;

/**
 * Overrun layer (spec §5.3.3, §5.3.9): Poisson exhaust pops while in overrun with rpm falling, plus
 * immediate pops for ignition-cut skipped firings; and overrun airflow noise.
 * Pops never overlap: each plays its full window, then ≥ 1 zero sample before the next queued pop.
 */
export class OverrunLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly lp = new Biquad();
  private readonly shape: Float64Array;
  private readonly popLen: number;
  private readonly decayStep: number;
  private readonly airScale: number;
  private seedValue = 1;
  private crackle = 0;
  private redline = 1;
  // state
  private inOverrun = false;
  private decay = 0;
  private pending = 0;
  private popPos = 0;
  private popAmp = 0;
  private gap = 0;
  private popOut = 0;
  private airOut = 0;
  private inRegime = 0;
  private inRpm = 0;
  private inFalling = false;
  private inValve = 0;
  private inMode = 1;
  private inCut = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.popLen = Math.max(2, Math.round(POP_LEN_S * fs));
    this.shape = new Float64Array(this.popLen);
    for (let k = 0; k < this.popLen; k++) {
      this.shape[k] = 0.5 * (1 - Math.cos((2 * Math.PI * (k + 0.5)) / this.popLen));
    }
    this.decayStep = Math.exp(-1 / (POP_DECAY_TAU_S * fs));
    const fc = Math.min(AIRFLOW_LP_HZ, 0.45 * fs);
    this.lp.lowpass(fc, Math.SQRT1_2, fs);
    // 2nd-order Butterworth LP noise bandwidth = fc·π/(2√2); uniform noise variance 1/3.
    this.airScale = AIRFLOW_RMS / Math.sqrt(((1 / 3) * 2 * ((Math.PI / (2 * Math.SQRT2)) * fc)) / fs);
    this.popPos = this.popLen;
  }

  /** Sets parameters and clears state (no allocation). */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    this.crackle = Math.max(0, voicing.overrun.crackleRate);
    this.redline = spec.rpm.redline > 0 ? spec.rpm.redline : 1;
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. regime = 0 combustion … 1 overrun (already smoothstepped + slewed by the caller). */
  tick(regime: number, rpm: number, falling: boolean, valveOpen01: number, modeFactor: number, ignitionCutPops: number): void {
    this.inRegime = regime;
    this.inRpm = rpm;
    this.inFalling = falling;
    this.inValve = valveOpen01;
    this.inMode = modeFactor;
    this.inCut = ignitionCutPops;
    this.step();
  }

  /** Pop impulse sample for ExhaustNetwork.tick(headerIn, popIn); 0 ≤ popInject ≤ 1. */
  get popInject(): number {
    return this.popOut;
  }

  /** Overrun airflow noise sample (perspective-mixed with the exhaust). */
  get airflow(): number {
    return this.airOut;
  }

  /** Restores the post-configure state (same random sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.lp.reset();
    this.inOverrun = false;
    this.decay = 0;
    this.pending = 0;
    this.popPos = this.popLen;
    this.popAmp = 0;
    this.gap = 0;
    this.popOut = 0;
    this.airOut = 0;
  }

  private step(): void {
    const regime = clamp(this.inRegime, 0, 1);

    // Overrun episode: the pop-rate decay restarts at each overrun start.
    if (!this.inOverrun) {
      if (regime > OVERRUN_ENTER) {
        this.inOverrun = true;
        this.decay = 1;
      }
    } else if (regime < OVERRUN_EXIT) {
      this.inOverrun = false;
      this.decay = 0;
    } else {
      this.decay = flush(this.decay * this.decayStep);
    }

    // Poisson arrivals: one uniform draw every sample, whether or not a pop can arrive.
    const u = this.rng.next();
    if (this.inOverrun && this.inFalling) {
      const valve = clamp(this.inValve, 0, 1);
      const mode = this.inMode > 0 ? this.inMode : 0;
      const lambda = this.crackle * POP_RATE_PER_CRACKLE * (1 + (POP_VALVE_FACTOR - 1) * valve) * mode * regime * this.decay;
      if (u < lambda / this.fs && this.pending < POP_MAX_PENDING) this.pending++;
    }
    if (this.inCut > 0) {
      this.pending = Math.min(POP_MAX_PENDING, this.pending + Math.floor(this.inCut));
    }

    // Pop playback: window, then a 1-sample gap, then the next queued pop.
    if (this.popPos < this.popLen) {
      this.popOut = this.popAmp * (this.shape[this.popPos] ?? 0);
      this.popPos++;
      if (this.popPos === this.popLen) this.gap = 1;
    } else if (this.gap > 0) {
      this.gap--;
      this.popOut = 0;
    } else if (this.pending > 0) {
      this.pending--;
      this.popAmp = POP_AMP_MIN + (POP_AMP_MAX - POP_AMP_MIN) * this.rng.next();
      this.popOut = this.popAmp * (this.shape[0] ?? 0);
      this.popPos = 1;
    } else {
      this.popOut = 0;
    }

    // Airflow noise.
    const n = this.lp.process(this.rng.bipolar() * this.airScale);
    const rpmFrac = clamp(this.inRpm / this.redline, 0, AIRFLOW_RPM_CAP);
    this.airOut = n * regime * rpmFrac;
  }
}
