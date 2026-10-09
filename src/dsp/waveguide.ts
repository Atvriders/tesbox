/**
 * Bidirectional digital waveguide tube section (Smith, "Physical Audio Signal Processing"):
 * a right-going rail (written at end A, read at end B) and a left-going rail (written at B, read
 * at A), each a FracDelay of delaySamples = lengthM / cMps · fs read with 3rd-order Lagrange
 * interpolation, preceded by a unity-DC one-pole low-pass (wall loss, |H| ≤ 1).
 */
import { SPEED_OF_SOUND_MAX } from '../contracts';
import { FracDelay } from './delay';
import { OnePole } from './util';

/** Lagrange-3 order + 1: the shortest allowed section, asserted at SPEED_OF_SOUND_MAX (amendment B3). */
export const MIN_DELAY_SAMPLES = 4;

export class Waveguide {
  private readonly right: FracDelay;
  private readonly left: FracDelay;
  private readonly lpR = new OnePole();
  private readonly lpL = new OnePole();
  private readonly maxDelay: number;
  private lengthM = 0;
  private fs = 0;
  private d = MIN_DELAY_SAMPLES;
  /** Read position: a sample written d samples ago is "the most recent" minus (d − 1). */
  private readD = MIN_DELAY_SAMPLES - 1;

  /** Until configure() the section is a lossless MIN_DELAY_SAMPLES delay (reported and actual delay agree). */
  constructor(capacitySamples: number) {
    this.right = new FracDelay(capacitySamples);
    this.left = new FracDelay(capacitySamples);
    this.maxDelay = capacitySamples - 2;
    this.setDelay(MIN_DELAY_SAMPLES);
  }

  get delaySamples(): number {
    return this.d;
  }

  /**
   * Sets length, speed, sample rate and wall loss, and clears the state. Throws RangeError for
   * non-positive/non-finite arguments, a section shorter than 4 samples at SPEED_OF_SOUND_MAX, or a
   * delay that does not fit the capacity (delaySamples must be ≤ capacity − 2).
   * lossHz ≤ 0 or ≥ fs/2 → lossless rails.
   */
  configure(lengthM: number, cMps: number, fs: number, lossHz: number): void {
    if (!(lengthM > 0) || !(cMps > 0) || !(fs > 0) || !Number.isFinite(lengthM * cMps * fs)) {
      throw new RangeError(`Waveguide.configure: bad arguments L=${lengthM} c=${cMps} fs=${fs}`);
    }
    const dAtMax = (lengthM / SPEED_OF_SOUND_MAX) * fs;
    if (dAtMax < MIN_DELAY_SAMPLES) {
      throw new RangeError(
        `Waveguide.configure: ${lengthM} m is ${dAtMax.toFixed(2)} samples at ${SPEED_OF_SOUND_MAX} m/s (< ${MIN_DELAY_SAMPLES})`,
      );
    }
    const d = (lengthM / cMps) * fs;
    if (d < MIN_DELAY_SAMPLES || d > this.maxDelay) {
      throw new RangeError(
        `Waveguide.configure: delay ${d.toFixed(2)} samples outside [${MIN_DELAY_SAMPLES}, ${this.maxDelay}]`,
      );
    }
    this.lengthM = lengthM;
    this.fs = fs;
    this.setDelay(d);
    if (lossHz > 0 && lossHz < fs / 2) {
      this.lpR.setCutoff(lossHz, fs);
      this.lpL.setCutoff(lossHz, fs);
    } else {
      this.lpR.setTau(0, fs);
      this.lpL.setTau(0, fs);
    }
    this.clear();
  }

  /** New speed of sound (caller slew-limits). The delay is clamped into [4, capacity − 2]; c ≤ 0/NaN is ignored. */
  setSpeed(cMps: number): void {
    if (!(cMps > 0)) return;
    let d = (this.lengthM / cMps) * this.fs;
    if (d < MIN_DELAY_SAMPLES) d = MIN_DELAY_SAMPLES;
    else if (d > this.maxDelay) d = this.maxDelay;
    this.setDelay(d);
  }

  /** Wave arriving at end B (right-going rail). Call before input() each sample. */
  outRight(): number {
    return this.right.readLagrangeFixed();
  }

  /** Wave arriving at end A (left-going rail). Call before input() each sample. */
  outLeft(): number {
    return this.left.readLagrangeFixed();
  }

  /** rightIn enters at end A, leftIn at end B (each through its rail's loss filter). */
  input(rightIn: number, leftIn: number): void {
    this.right.write(this.lpR.process(rightIn));
    this.left.write(this.lpL.process(leftIn));
  }

  /**
   * Boxing-free form of outRight()/outLeft() for hot loops (amendment B2):
   * dst[j] = wave arriving at B, dst[j + 1] = wave arriving at A.
   */
  outPair(dst: Float64Array, j: number): void {
    dst[j] = this.right.readLagrangeFixed();
    dst[j + 1] = this.left.readLagrangeFixed();
  }

  /** Boxing-free form of input(): rightIn = src[j] (enters at A), leftIn = src[j + 1] (enters at B). */
  inputPair(src: Float64Array, j: number): void {
    this.right.write(this.lpR.process(src[j]!));
    this.left.write(this.lpL.process(src[j + 1]!));
  }

  clear(): void {
    this.right.clear();
    this.left.clear();
    this.lpR.reset();
    this.lpL.reset();
  }

  /** A wave written now is read back (d − 1) samples after the next write, i.e. d samples later. */
  private setDelay(d: number): void {
    this.d = d;
    this.readD = d - 1;
    this.right.setLagrangeDelay(this.readD);
    this.left.setLagrangeDelay(this.readD);
  }

  /**
   * Σ squares of both rails' live samples: the ⌊delaySamples − 1⌋ + 3 newest of each rail, i.e. every
   * sample a future read can still touch. Around a reflection it swings up to ≈ 2× (the 4-tap read
   * kernel still holds samples already re-emitted), and how high that peak gets depends on how the
   * pulse lines up with the sample grid (up to ≈ 0.6 % from one round trip to the next). So maxima
   * over round-trip windows are a valid passivity check only with wall loss or |r| ≤ 0.95; for
   * lossless rails with |r| near 1 use the envelope 2·r^(2·max(j − 1, 0)) after j = ⌊t/delaySamples⌋
   * reflections.
   */
  energy(): number {
    const n = Math.floor(this.readD) + 3;
    return this.right.sumSquares(n) + this.left.sumSquares(n);
  }
}
