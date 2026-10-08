/** ≈ estimated Full-tier DSP cost per sample (spec §5.7): multiply-adds the benchmark burns per frame at k = 1. */
export const WORK_OPS_PER_SAMPLE = 400;

/** Power of two so `index & STATE_MASK` keeps every access in bounds. */
const STATE_LEN = 64;
const STATE_MASK = STATE_LEN - 1;

/**
 * Synthetic DSP load for the headroom benchmark. Each op is one multiply-add on a serial
 * dependency chain (like a cascade of IIR filters), so the JIT can neither vectorise nor drop it.
 * Numerically closed: with every state value in (0, 1], x = 0.5·x + s stays in (0, 2) and the
 * state written back (0.5·x) stays in (0, 1) — no overflow, NaN or subnormals, ever.
 * Allocation-free after construction (safe inside AudioWorkletProcessor.process).
 */
export class WorkKernel {
  private readonly state: Float64Array;
  private carry = 0;

  constructor() {
    this.state = new Float64Array(STATE_LEN);
    for (let i = 0; i < STATE_LEN; i++) this.state[i] = (i + 1) / STATE_LEN;
  }

  /** Performs k × WORK_OPS_PER_SAMPLE multiply-adds per frame; returns a checksum (finite, in (0, 2)). */
  run(frames: number, k: number): number {
    const s = this.state;
    const n = frames * k;
    let x = this.carry;
    for (let f = 0; f < n; f++) {
      for (let i = 0; i < WORK_OPS_PER_SAMPLE; i++) {
        x = x * 0.5 + s[i & STATE_MASK]!; // masked index is always in bounds
      }
      s[f & STATE_MASK] = x * 0.5;
    }
    this.carry = x;
    return x;
  }
}
