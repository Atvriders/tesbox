import type { EngineVoicing, Perspective } from '../contracts';
import { BUTTER4_Q, Biquad, Cascade } from './biquad';
import { clamp, dbToGain, smoothstep } from './util';

/** Contract: perspective changes crossfade over 300 ms. */
export const PERSPECTIVE_XFADE_S = 0.3;
/** Cabin: block weighted below ≈ 250 Hz (2nd-order Butterworth LP). */
export const CABIN_BLOCK_LP_HZ = 250;
/** Cabin: forced-induction bus through a 2nd-order Butterworth LP at 2.8 kHz × dbToGain(cabinGainDb). */
export const CABIN_FI_LP_HZ = 2800;
/** cabinGainDb used when the voicing has no forcedInduction block. */
export const DEFAULT_CABIN_FI_GAIN_DB = -14;
/** Outside weights (contract). */
export const OUTSIDE_INTAKE = 0.7;
export const OUTSIDE_BLOCK = 0.3;
/** Stereo decorrelation: l = m + STEREO_WIDTH·d, r = m − STEREO_WIDTH·d, d = m delayed STEREO_DELAY_S. */
export const STEREO_WIDTH = 0.08;
export const STEREO_DELAY_S = 0.0007;

/**
 * Listening-point mix (spec §5.3.11). Both perspectives are computed every sample (filters stay
 * warm) and crossfaded with a 300 ms linear ramp shaped by smoothstep; a new target reverses the
 * ramp from where it is, so rapid toggling never steps. Mono-compatible stereo: l + r = 2m.
 */
export class PerspectiveMixer {
  private readonly fs: number;
  private readonly cabinLp = new Cascade(2);
  private readonly blockLp = new Biquad();
  private readonly fiLp = new Biquad();
  private readonly delay: Float64Array;
  private readonly delayN: number;
  private readonly xfadeStep: number;
  private dPos = 0;
  private fiGain = 1;
  /** Crossfade position: 0 = cabin, 1 = outside. */
  private w = 0;
  private target = 0;
  private inE = 0;
  private inI = 0;
  private inB = 0;
  private inF = 0;
  private inA = 0;
  private outL = 0;
  private outR = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.delayN = Math.max(1, Math.round(STEREO_DELAY_S * fs));
    this.delay = new Float64Array(this.delayN);
    this.xfadeStep = 1 / (PERSPECTIVE_XFADE_S * fs);
  }

  /** Sets parameters, snaps the crossfade to the current target and clears state (no allocation). */
  configure(voicing: EngineVoicing): void {
    const fc = clamp(voicing.cabin.lowpassHz, 20, 0.45 * this.fs);
    this.cabinLp.stage(0).lowpass(fc, BUTTER4_Q[0], this.fs);
    this.cabinLp.stage(1).lowpass(fc, BUTTER4_Q[1], this.fs);
    this.blockLp.lowpass(CABIN_BLOCK_LP_HZ, Math.SQRT1_2, this.fs);
    this.fiLp.lowpass(Math.min(CABIN_FI_LP_HZ, 0.45 * this.fs), Math.SQRT1_2, this.fs);
    const fi = voicing.forcedInduction;
    this.fiGain = dbToGain(fi === null ? DEFAULT_CABIN_FI_GAIN_DB : fi.cabinGainDb);
    this.reset();
  }

  /** Target perspective; repeated calls with the same value are no-ops. Default 'cabin'. */
  setPerspective(p: Perspective): void {
    this.target = p === 'outside' ? 1 : 0;
  }

  /** Per sample. Results in `l` / `r`. */
  tick(exhaust: number, intake: number, block: number, fi: number, airflow: number): void {
    this.inE = exhaust;
    this.inI = intake;
    this.inB = block;
    this.inF = fi;
    this.inA = airflow;
    this.step();
  }

  get l(): number {
    return this.outL;
  }

  get r(): number {
    return this.outR;
  }

  /** Clears filter/delay state and snaps the crossfade to the target. */
  reset(): void {
    this.cabinLp.reset();
    this.blockLp.reset();
    this.fiLp.reset();
    this.delay.fill(0);
    this.dPos = 0;
    this.w = this.target;
    this.outL = 0;
    this.outR = 0;
  }

  private step(): void {
    const e = this.inE;
    const a = this.inA;
    const i = this.inI;
    const cabin =
      this.cabinLp.process(e + a + i) + this.blockLp.process(this.inB) + this.fiGain * this.fiLp.process(this.inF);
    const outside = e + a + OUTSIDE_INTAKE * i + OUTSIDE_BLOCK * this.inB + this.inF;

    const t = this.target;
    let w = this.w;
    if (w < t) {
      w += this.xfadeStep;
      if (w > t) w = t;
    } else if (w > t) {
      w -= this.xfadeStep;
      if (w < t) w = t;
    }
    this.w = w;
    const s = smoothstep(0, 1, w);
    const m = s === 0 ? cabin : s === 1 ? outside : cabin + s * (outside - cabin);

    const d = this.delay[this.dPos] ?? 0;
    this.delay[this.dPos] = m;
    this.dPos = this.dPos + 1 === this.delayN ? 0 : this.dPos + 1;
    this.outL = m + STEREO_WIDTH * d;
    this.outR = m - STEREO_WIDTH * d;
  }
}
