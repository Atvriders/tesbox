import { G } from '../contracts';
import type { TeslaParams } from '../contracts';

/** Load low-pass time constant (s) and deadband (spec §8.5: 150–300 ms low-pass + small deadband). */
const LOAD_TAU_S = 0.2;
const LOAD_DEADBAND = 0.03;
/** Deceleration that maps to load −1 (fraction of g). */
const OVERRUN_FULL_G = 0.25;

/** F_road(v) = A + B·v + C·v² (N). B may be negative. */
export function roadForceN(p: TeslaParams, v: number): number {
  const r = p.roadLoad;
  return r.A_N + r.B_Nps_m * v + r.C_Ns2_m2 * v * v;
}

/** F_max(v) = modeFactor · min(fTracN, eta·pEffW / max(v, 1)) (N). */
export function maxForceN(p: TeslaParams, v: number): number {
  return p.modeFactor * Math.min(p.fTracN, (p.eta * p.pEffW) / Math.max(v, 1));
}

/**
 * F = massKg·a + roadForceN(p, v); F ≥ 0 → clamp(F / maxForceN(p, v), 0, 1);
 * else max(F / (massKg·0.25·G), −1). NaN when v or a is non-finite (±Infinity included, so an
 * upstream fault can never read as a clamped ±1). Allocation-free.
 */
export function rawLoad(p: TeslaParams, v: number, a: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(a)) return Number.NaN;
  const f = p.massKg * a + roadForceN(p, v);
  if (f >= 0) return Math.min(1, Math.max(0, f / maxForceN(p, v)));
  return Math.max(f / (p.massKg * OVERRUN_FULL_G * G), -1);
}

/** Low-passed engine load in [−1, 1] for the selected Tesla (spec §8.5). update() never allocates. */
export class LoadEstimator {
  private params: TeslaParams | null = null;
  /** One-pole state (pre-deadband). */
  private y = 0;
  private _load = 0;
  private _loadRate = 0;

  /** Selects the Tesla. Keeps the filter state so a mid-drive change does not jump. */
  configure(p: TeslaParams): void {
    this.params = p;
  }

  reset(): void {
    this.y = 0;
    this._load = 0;
    this._loadRate = 0;
  }

  /**
   * One-pole τ = 0.2 s then deadband ±0.03 (|x| < 0.03 → 0). loadRate = d(load)/dt of the filtered
   * value (1/s), i.e. of the one-pole output before the deadband. Returns the new load. Before
   * configure() or with dtS ≤ 0 nothing changes; a NaN raw load (non-finite v/a) is treated as 0.
   */
  update(v: number, a: number, dtS: number): number {
    const p = this.params;
    if (p === null || !(dtS > 0)) return this._load;
    const raw = rawLoad(p, v, a);
    const x = raw === raw ? raw : 0;
    const prev = this.y;
    const y = prev + (x - prev) * (1 - Math.exp(-dtS / LOAD_TAU_S));
    this.y = y;
    this._loadRate = (y - prev) / dtS;
    this._load = Math.abs(y) < LOAD_DEADBAND ? 0 : y;
    return this._load;
  }

  get load(): number {
    return this._load;
  }

  get loadRate(): number {
    return this._loadRate;
  }
}
