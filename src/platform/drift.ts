export interface DriftSample {
  contextTimeS: number;
  perfMs: number;
}

export interface DriftWindow {
  /** Δ(contextTimeS)·1000 / Δ(perfMs) over the window; ≈ 1 when the audio clock keeps up. */
  ratio: number;
  /** This window alone: ratio < threshold. */
  overloaded: boolean;
}

/**
 * Detects audio-thread overload from getOutputTimestamp() pairs: an overloaded context renders
 * fewer frames than wall time requires, so its clock advances slower than performance.now().
 */
export class DriftMonitor {
  private hasStart = false;
  private startCtxS = 0;
  private startPerfMs = 0;
  private consecutive = 0;
  private latched = false;

  constructor(
    private readonly windowMs = 1000,
    private readonly threshold = 0.98,
  ) {}

  /** True after ≥ 2 consecutive windows with ratio < threshold; stays true until reset(). */
  get overloaded(): boolean {
    return this.latched;
  }

  /** Feed getOutputTimestamp() pairs (~every 100 ms). Returns a window result each time ≥ windowMs elapsed, else null. */
  push(s: DriftSample): DriftWindow | null {
    if (s.contextTimeS === 0 || !Number.isFinite(s.contextTimeS) || !Number.isFinite(s.perfMs)) return null;
    if (!this.hasStart || s.contextTimeS < this.startCtxS || s.perfMs < this.startPerfMs) {
      // First sample, or a clock went backwards (new AudioContext): start a fresh window.
      if (this.hasStart) this.consecutive = 0;
      this.hasStart = true;
      this.startCtxS = s.contextTimeS;
      this.startPerfMs = s.perfMs;
      return null;
    }
    const elapsedMs = s.perfMs - this.startPerfMs;
    if (elapsedMs < this.windowMs) return null;
    const ratio = ((s.contextTimeS - this.startCtxS) * 1000) / elapsedMs;
    const overloaded = ratio < this.threshold;
    this.consecutive = overloaded ? this.consecutive + 1 : 0;
    if (this.consecutive >= 2) this.latched = true;
    this.startCtxS = s.contextTimeS;
    this.startPerfMs = s.perfMs;
    return { ratio, overloaded };
  }

  reset(): void {
    this.hasStart = false;
    this.consecutive = 0;
    this.latched = false;
  }
}
