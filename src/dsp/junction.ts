/**
 * Lossless parallel N-port scattering junction of acoustic tubes (Smith, "Physical Audio Signal
 * Processing", lossless scattering junctions). Admittances Y_i ∝ cross-section area:
 *   pJ = 2·Σ(Y_i·p_i⁺)/Σ(Y_i);  p_i⁻ = pJ − p_i⁺   (p⁺ incoming, p⁻ outgoing)
 * Power is conserved exactly: Σ Y_i·(p_i⁻)² = Σ Y_i·(p_i⁺)².
 */

/** Largest |r| terminationReflect allows (keeps every termination strictly lossy). */
export const MAX_REFLECTION = 0.999;

export class Junction {
  private readonly y: Float64Array;
  private n = 0;
  private twoOverSum = 0;

  constructor(maxPorts: number) {
    if (!Number.isInteger(maxPorts) || maxPorts < 1) {
      throw new RangeError(`Junction maxPorts must be a positive integer, got ${maxPorts}`);
    }
    this.y = new Float64Array(maxPorts);
  }

  /** Number of active ports (0 until configured). */
  get ports(): number {
    return this.n;
  }

  /** Copies admittances[0..n−1] (each finite and > 0). Never allocates; safe to call per sample. */
  configure(admittances: ArrayLike<number>, n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > this.y.length) {
      throw new RangeError(`Junction port count ${n} outside [1, ${this.y.length}]`);
    }
    if (admittances.length < n) {
      throw new RangeError(`Junction needs ${n} admittances, got ${admittances.length}`);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = admittances[i];
      if (v === undefined || !(v > 0) || v === Infinity) {
        throw new RangeError(`Junction admittance ${i} must be finite and > 0, got ${v}`);
      }
      sum += v;
    }
    for (let i = 0; i < n; i++) this.y[i] = admittances[i] ?? 0;
    this.n = n;
    this.twoOverSum = 2 / sum;
  }

  /** Reads incoming[0..n−1] and writes outgoing[0..n−1] (the two arrays may not alias). */
  scatter(incoming: Float64Array, outgoing: Float64Array): void {
    const n = this.n;
    const y = this.y;
    let acc = 0;
    for (let i = 0; i < n; i++) acc += y[i]! * incoming[i]!;
    const pJ = acc * this.twoOverSum;
    for (let i = 0; i < n; i++) outgoing[i] = pJ - incoming[i]!;
  }
}

/**
 * Reflected wave at a tube termination: r·x with r clamped into [−0.999, 0.999].
 * Open end ≈ −0.9 (the caller adds a low-pass), closed end ≈ +0.95.
 */
export function terminationReflect(x: number, r: number): number {
  const rr = r > MAX_REFLECTION ? MAX_REFLECTION : r < -MAX_REFLECTION ? -MAX_REFLECTION : r;
  return rr * x;
}
