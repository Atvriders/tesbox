import type { EngineSpec, EngineVoicing } from '../contracts';
import { Biquad } from './biquad';
import { flush, Rng } from './util';

/** Contract: block = ignition impulses → LP 250 Hz (Q 0.7) × blockGain. */
export const BLOCK_LP_HZ = 250;
export const BLOCK_Q = 0.7;
/** Contract: valvetrain bursts through a band-pass at 3 kHz. */
export const VALVETRAIN_BP_HZ = 3000;
export const VALVETRAIN_Q = 1.5;
/** "2 ms decaying" burst: exponential envelope that is −40 dB after 2 ms. */
export const VALVETRAIN_BURST_S = 0.002;
/** Per-event amplitude variation of the valvetrain tick: uniform in [1 − x, 1 + x]. */
export const VALVETRAIN_AMP_JITTER = 0.2;
/** Decorrelates this layer's noise from other layers configured with the same seed. */
const SEED_SALT = 0x2b3c4d5;

/**
 * Mechanical layer (spec §5.3.6): block vibration from ignition impulses and valvetrain tick
 * (noise bursts at rpm/120 × combustion count per second through a 3 kHz band-pass).
 * A unit ignition impulse yields a block thump peaking at ≈ 0.45·blockGain, independent of fs.
 * Valvetrain bursts have random peaks: per burst at 48 kHz, median ≈ 0.22·valvetrainGain, p90 ≈ 0.33,
 * and ≈ 0.5 at most over ~1000 bursts.
 */
export class MechanicalLayer {
  private readonly fs: number;
  private readonly rng = new Rng();
  private readonly blockLp = new Biquad();
  private readonly valveBp = new Biquad();
  /** A 1-sample impulse has area 1/fs; × fs/(2π·250) makes the thump amplitude fs-independent. */
  private readonly blockNorm: number;
  private readonly burstDecay: number;
  private seedValue = 1;
  private blockGain = 0;
  private valveGain = 0;
  /** Valve events per second per rpm = combustion count / 120. */
  private eventsPerRpm = 0;
  private phase = 0;
  private env = 0;
  private inImpulse = 0;
  private inRpm = 0;
  private y = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.blockLp.lowpass(BLOCK_LP_HZ, BLOCK_Q, fs);
    this.valveBp.bandpass(Math.min(VALVETRAIN_BP_HZ, 0.45 * fs), VALVETRAIN_Q, fs);
    this.blockNorm = fs / (2 * Math.PI * BLOCK_LP_HZ);
    this.burstDecay = Math.pow(10, -2 / (VALVETRAIN_BURST_S * fs));
  }

  /** Sets parameters and clears state (no allocation). */
  configure(spec: EngineSpec, voicing: EngineVoicing, seed: number): void {
    this.blockGain = voicing.mechanical.blockGain;
    this.valveGain = voicing.mechanical.valvetrainGain;
    this.eventsPerRpm = spec.combustion.length / 120;
    this.seedValue = seed;
    this.reset();
  }

  /** Per sample. `ignitionImpulse` = CombustionSource.tick() return value. */
  tick(ignitionImpulse: number, rpm: number): number {
    this.inImpulse = ignitionImpulse;
    this.inRpm = rpm;
    this.step();
    return this.y;
  }

  /** Restores the post-configure state (same noise sequence). */
  reset(): void {
    this.rng.seed((this.seedValue ^ SEED_SALT) >>> 0);
    this.blockLp.reset();
    this.valveBp.reset();
    this.phase = 0;
    this.env = 0;
    this.y = 0;
  }

  private step(): void {
    const block = this.blockLp.process(this.inImpulse * this.blockNorm) * this.blockGain;
    const rate = this.inRpm > 0 ? this.inRpm * this.eventsPerRpm : 0;
    this.phase += rate / this.fs;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      this.env = 1 + VALVETRAIN_AMP_JITTER * this.rng.bipolar();
    }
    const burst = this.valveBp.process(this.rng.bipolar() * this.env);
    this.env = flush(this.env * this.burstDecay);
    this.y = block + burst * this.valveGain;
  }
}
