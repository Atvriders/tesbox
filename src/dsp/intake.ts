import type { EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { clamp, Rng, Slew } from './util';

/** Contract: band-pass Q at `voicing.intake.helmholtzHz`. */
export const INTAKE_Q = 2;
/** Layer RMS at gate envelope 1, throttle 1 and `voicing.intake.gain` = 1 (≈ −12 dBFS). */
export const INTAKE_RMS = 0.25;
/** Throttle de-zipper: linear slew, full 0 → 1 travel in 20 ms; reaches exactly 0 (true silence). */
export const INTAKE_THROTTLE_SLEW_PER_S = 50;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x1a7a3e5;

/**
 * Intake roar (spec §5.3.6): band-passed noise × intake-gate envelope × throttle × gain.
 * `gateSum` is Σ CombustionSource.intakeGate[i]; it is normalised by 3 / entryCount so the
 * cycle-mean envelope of a 4-stroke (240° windows in 720°) is ≈ 1 for any cylinder count.
 * Throttle is de-zipped by a linear 20 ms slew, so the output reaches exactly 0 within 20 ms of
 * `throttle01 = 0` (amendment B12: click-free, replaces "silent when throttle01 = 0" literally).
 */
export class IntakeLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly bp = new Biquad();
  private readonly throttle = new Slew();
  private seedValue = 1;
  private noiseScale = 0;
  private gain = 0;
  private gateNorm = 1;
  private inGate = 0;
  private inThrottle = 0;
  private y = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.throttle.setRate(INTAKE_THROTTLE_SLEW_PER_S, fs);
  }

  /** Sets parameters and clears state (no allocation). */
  configure(voicing: EngineVoicing, seed: number): void {
    const f0 = clamp(voicing.intake.helmholtzHz, 20, 0.45 * this.fs);
    this.bp.bandpass(f0, INTAKE_Q, this.fs);
    // RBJ constant-0-dB-peak band-pass passes a white-noise power fraction ≈ π·f0/(Q·fs);
    // uniform noise in [−1, 1) has variance 1/3.
    this.noiseScale = INTAKE_RMS / Math.sqrt(((1 / 3) * Math.PI * f0) / (INTAKE_Q * this.fs));
    this.gain = voicing.intake.gain;
    this.gateNorm = 3 / Math.max(1, voicing.headersM.length);
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. Tiny wrapper so callers inline it; per-sample doubles cross into step() via fields. */
  tick(gateSum: number, throttle01: number): number {
    this.inGate = gateSum;
    this.inThrottle = throttle01;
    this.step();
    return this.y;
  }

  /** Restores the post-configure state (same noise sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.bp.reset();
    this.throttle.reset(0);
    this.y = 0;
  }

  private step(): void {
    const t = this.throttle.process(clamp(this.inThrottle, 0, 1));
    const band = this.bp.process(this.rng.bipolar() * this.noiseScale);
    this.y = t > 0 ? band * this.inGate * this.gateNorm * t * this.gain : 0;
  }
}
