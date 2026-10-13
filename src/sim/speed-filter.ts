import { DEFAULT_SIM_TUNING, F } from '../contracts';
import type { FixMsg, SimTuning } from '../contracts';
import { haversineM } from '../platform/geo';

/** Fixes older than this on receipt are rejected (spec §8.2 step 1). */
const MAX_AGE_S = 3;
/** A fix must be newer than the posterior time by more than this (out-of-order / cached repeat). */
const MIN_ADVANCE_S = 0.05;
/** Initial posterior variances for [s, v, a]. */
const P0_S = 25;
const P0_V = 25;
const P0_A = 4;
/** Speed measurement noise floor (m/s) and accuracy factor. */
const RV_FLOOR = 0.3;
const RV_PER_ACC = 0.05;
/**
 * Zero-speed rule (contract A2): a reported 0 is a measurement iff the fix-to-fix displacement
 * d1 < ZERO_STILL_M; a "moving zero" iff d1 ≥ ZERO_MOVING_M and the previous interval d0 ≥ ZERO_MOVING_M;
 * ZERO_LATCH_COUNT consecutive moving zeros latch SPEED_UNUSABLE.
 */
const ZERO_STILL_M = 3;
const ZERO_MOVING_M = 8;
const ZERO_LATCH_COUNT = 3;
/** Standstill position deadband (contract A3): below DEADBAND_V (m/s), d1 < DEADBAND_ACC_FRAC·accuracy adds 0. */
const DEADBAND_V = 1.5;
const DEADBAND_ACC_FRAC = 0.4;
/** Standstill hysteresis (m/s). */
const STILL_ENTER = 0.5;
const STILL_LEAVE = 1.0;
/**
 * A fix more than REINIT_GAP_S after tK re-seeds the state instead of predicting across the gap: over
 * minutes to hours q·Δ⁵/20 reaches 1e16 m² and the (non-Joseph) update loses P's positive
 * semi-definiteness. The re-seed keeps s on s_meas and gives v a wide prior (the next fixes set it).
 */
const REINIT_GAP_S = 60;
const P0_V_REINIT = 1e4;
/** Arrival-gap thresholds (s). */
const PREDICT_AFTER_S = 2;
const LOST_AFTER_S = 20;
const LOST_EASE_S = 10;

/**
 * Single 3-state Kalman filter on [s, v, a] with optional position and speed measurements
 * (spec §8.2, phase-1 contract). Posterior is kept at the last fix time tK; the output is a
 * saturating prediction to nowS + outputLatencyS that is never written back.
 * accept()/evaluate() never allocate.
 */
export class SpeedFilter {
  private q = DEFAULT_SIM_TUNING.kalmanQ;
  private tauA = DEFAULT_SIM_TUNING.tauA;
  private outLatS = DEFAULT_SIM_TUNING.outputLatencyS;

  /** Posterior state [s, v, a] at tK. */
  private readonly x = new Float64Array(3);
  /** Posterior covariance, row-major 3×3. */
  private readonly P = new Float64Array(9);
  private tK = Number.NEGATIVE_INFINITY;
  private lastArrivalS = Number.NEGATIVE_INFINITY;
  private prevLat = 0;
  private prevLon = 0;
  private sMeas = 0;
  /** Raw displacement of the previous fix-to-fix interval (A2's d0); NaN before the first interval. */
  private prevDispM = Number.NaN;

  private zeroMovingCount = 0;
  private speedUnusable = false;
  private standstill = true;
  private hidden = false;

  private _hasFix = false;
  private _v = 0;
  private _a = 0;
  private _flags: number = F.GPS_LOST | F.STANDSTILL;
  private _accepted = 0;
  private _rejected = 0;

  constructor(tuning?: SimTuning) {
    this.configure(tuning ?? DEFAULT_SIM_TUNING);
    this.reset();
  }

  /** Copies tuning numbers; keeps the filter state (safe mid-drive). */
  configure(tuning: SimTuning): void {
    this.q = tuning.kalmanQ;
    this.tauA = tuning.tauA;
    this.outLatS = tuning.outputLatencyS;
  }

  /** Clears state, counters and the SPEED_UNUSABLE latch. Does not change the hidden flag. */
  reset(): void {
    this.x.fill(0);
    this.P.fill(0);
    this.tK = Number.NEGATIVE_INFINITY;
    this.lastArrivalS = Number.NEGATIVE_INFINITY;
    this.prevLat = 0;
    this.prevLon = 0;
    this.sMeas = 0;
    this.prevDispM = Number.NaN;
    this.zeroMovingCount = 0;
    this.speedUnusable = false;
    this.standstill = true;
    this._hasFix = false;
    this._v = 0;
    this._a = 0;
    this._flags = F.GPS_LOST | F.STANDSTILL | (this.hidden ? F.HIDDEN_HOLD : 0);
    this._accepted = 0;
    this._rejected = 0;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this._flags |= F.HIDDEN_HOLD;
    else this._flags &= ~F.HIDDEN_HOLD;
  }

  get v(): number {
    return this._v;
  }
  get a(): number {
    return this._a;
  }
  get flags(): number {
    return this._flags;
  }
  get fixesAccepted(): number {
    return this._accepted;
  }
  get fixesRejected(): number {
    return this._rejected;
  }
  get hasFix(): boolean {
    return this._hasFix;
  }

  /** §8.2 steps 1–3. Returns true if the fix was accepted. Never retains `fix`. */
  accept(fix: FixMsg, nowS: number): boolean {
    const ageS = fix.ageS;
    const acc = fix.accuracyM;
    if (
      !Number.isFinite(ageS) ||
      ageS > MAX_AGE_S ||
      !Number.isFinite(fix.lat) ||
      !Number.isFinite(fix.lon) ||
      !Number.isFinite(acc) ||
      acc <= 0
    ) {
      this._rejected++;
      return false;
    }
    const tFix = nowS - ageS;
    // Out of order / cached repeat. A non-finite tFix (NaN or ±Infinity nowS) is rejected too: NaN would
    // turn this guard off for the session and +Infinity would lock out every later fix.
    if (!Number.isFinite(tFix) || tFix <= this.tK + MIN_ADVANCE_S) {
      this._rejected++;
      return false;
    }

    const sp = fix.speedMps;
    // null / NaN / ±Infinity / negative → missing.
    const speedPresent = sp !== null && Number.isFinite(sp) && sp >= 0;

    if (!this._hasFix) {
      this.x[0] = 0;
      // Only construction and reset() lead here and both clear the latch, so the check is defensive.
      this.x[1] = speedPresent && !this.speedUnusable ? sp : 0;
      this.x[2] = 0;
      this.P.fill(0);
      this.P[0] = P0_S;
      this.P[4] = P0_V;
      this.P[8] = P0_A;
      this.sMeas = 0;
      this.prevDispM = Number.NaN;
      this.prevLat = fix.lat;
      this.prevLon = fix.lon;
      this.tK = tFix;
      this.lastArrivalS = nowS;
      this._hasFix = true;
      this._accepted++;
      return true;
    }

    // Raw fix-to-fix displacement d1 (A2 and A3 use it before the deadband) and the previous one, d0.
    const d1 = haversineM(this.prevLat, this.prevLon, fix.lat, fix.lon);
    const d0 = this.prevDispM;
    this.prevDispM = d1;
    this.prevLat = fix.lat;
    this.prevLon = fix.lon;

    // Zero-speed rule (A2).
    let speedUsable = speedPresent && !this.speedUnusable;
    let movingZero = false;
    if (speedUsable && sp === 0) {
      speedUsable = d1 < ZERO_STILL_M;
      movingZero = !speedUsable && d1 >= ZERO_MOVING_M && d0 >= ZERO_MOVING_M;
    }
    if (movingZero) {
      this.zeroMovingCount++;
      if (this.zeroMovingCount >= ZERO_LATCH_COUNT) this.speedUnusable = true;
    } else {
      this.zeroMovingCount = 0;
    }

    // Position measurement: cumulative haversine distance along the accepted fixes, with the A3
    // standstill deadband (this._v is the last evaluate() output).
    if (!(this._v < DEADBAND_V && d1 < DEADBAND_ACC_FRAC * acc)) this.sMeas += d1;

    const gapS = tFix - this.tK;
    if (gapS > REINIT_GAP_S) {
      this.x[0] = this.sMeas;
      this.x[1] = speedUsable && sp !== null ? sp : 0;
      this.x[2] = 0;
      this.P.fill(0);
      this.P[0] = P0_S;
      this.P[4] = P0_V_REINIT;
      this.P[8] = P0_A;
    } else {
      this.predict(gapS);
    }
    const halfAcc = acc / 2;
    this.scalarUpdate(0, this.sMeas, halfAcc * halfAcc);
    if (speedUsable && sp !== null) {
      const sigmaV = Math.max(RV_FLOOR, RV_PER_ACC * acc);
      this.scalarUpdate(1, sp, sigmaV * sigmaV);
    }

    this.tK = tFix;
    this.lastArrivalS = nowS;
    this._accepted++;
    return true;
  }

  /** §8.2 steps 4–6: output v, a and flags for nowS. Never allocates. */
  evaluate(nowS: number): void {
    let flags = this.hidden ? F.HIDDEN_HOLD : 0;
    if (this.speedUnusable) flags |= F.SPEED_UNUSABLE;

    if (!this._hasFix) {
      // standstill is already true: construction and reset() set it; only evaluate() after a fix clears it.
      this._v = 0;
      this._a = 0;
      this._flags = flags | F.GPS_LOST | F.STANDSTILL;
      return;
    }

    const tau = Math.max(0, nowS + this.outLatS - this.tK);
    const decay = Math.exp(-tau / this.tauA);
    const vk = this.x[1] ?? 0;
    const ak = this.x[2] ?? 0;
    let v = Math.max(0, vk + ak * this.tauA * (1 - decay));
    let a = ak * decay;

    const gap = nowS - this.lastArrivalS;
    if (gap > PREDICT_AFTER_S) flags |= F.PREDICTING;
    if (gap > LOST_AFTER_S) {
      flags |= F.GPS_LOST;
      v *= Math.max(0, 1 - (gap - LOST_AFTER_S) / LOST_EASE_S);
    }

    if (this.standstill) {
      if (v > STILL_LEAVE) this.standstill = false;
    } else if (v < STILL_ENTER) {
      this.standstill = true;
      // Reset the posterior acceleration; its covariance row/column becomes [0, 0, 1].
      this.x[2] = 0;
      this.P[2] = 0;
      this.P[5] = 0;
      this.P[6] = 0;
      this.P[7] = 0;
      this.P[8] = 1;
    }
    if (this.standstill) {
      v = 0;
      a = 0;
      flags |= F.STANDSTILL;
    }

    this._v = v;
    this._a = a;
    this._flags = flags;
  }

  /** x ← F x, P ← F P Fᵀ + Q (white jerk), for a step of d seconds. */
  private predict(d: number): void {
    const x = this.x;
    const P = this.P;
    const h = 0.5 * d * d;
    const s = x[0] ?? 0;
    const v = x[1] ?? 0;
    const a = x[2] ?? 0;
    x[0] = s + v * d + a * h;
    x[1] = v + a * d;

    const p00 = P[0] ?? 0;
    const p01 = P[1] ?? 0;
    const p02 = P[2] ?? 0;
    const p11 = P[4] ?? 0;
    const p12 = P[5] ?? 0;
    const p22 = P[8] ?? 0;
    // Rows of F·P.
    const r00 = p00 + d * p01 + h * p02;
    const r01 = p01 + d * p11 + h * p12;
    const r02 = p02 + d * p12 + h * p22;
    const r11 = p11 + d * p12;
    const r12 = p12 + d * p22;
    // (F·P)·Fᵀ.
    const n00 = r00 + d * r01 + h * r02;
    const n01 = r01 + d * r02;
    const n02 = r02;
    const n11 = r11 + d * r12;
    const n12 = r12;
    const n22 = p22;

    const q = this.q;
    const d2 = d * d;
    const d3 = d2 * d;
    const d4 = d3 * d;
    const d5 = d4 * d;
    P[0] = n00 + (q * d5) / 20;
    P[1] = n01 + (q * d4) / 8;
    P[2] = n02 + (q * d3) / 6;
    P[4] = n11 + (q * d3) / 3;
    P[5] = n12 + (q * d2) / 2;
    P[8] = n22 + q * d;
    P[3] = P[1] ?? 0;
    P[6] = P[2] ?? 0;
    P[7] = P[5] ?? 0;
  }

  /** Scalar update with H = e_i and variance r; symmetrises P afterwards. */
  private scalarUpdate(i: number, z: number, r: number): void {
    const x = this.x;
    const P = this.P;
    const c0 = P[i] ?? 0; // P[0][i]
    const c1 = P[3 + i] ?? 0; // P[1][i]
    const c2 = P[6 + i] ?? 0; // P[2][i]
    const sInv = 1 / ((P[4 * i] ?? 0) + r);
    const y = z - (x[i] ?? 0);
    x[0] = (x[0] ?? 0) + c0 * sInv * y;
    x[1] = (x[1] ?? 0) + c1 * sInv * y;
    x[2] = (x[2] ?? 0) + c2 * sInv * y;
    P[0] = (P[0] ?? 0) - c0 * c0 * sInv;
    P[1] = (P[1] ?? 0) - c0 * c1 * sInv;
    P[2] = (P[2] ?? 0) - c0 * c2 * sInv;
    P[3] = (P[3] ?? 0) - c1 * c0 * sInv;
    P[4] = (P[4] ?? 0) - c1 * c1 * sInv;
    P[5] = (P[5] ?? 0) - c1 * c2 * sInv;
    P[6] = (P[6] ?? 0) - c2 * c0 * sInv;
    P[7] = (P[7] ?? 0) - c2 * c1 * sInv;
    P[8] = (P[8] ?? 0) - c2 * c2 * sInv;
    const s01 = 0.5 * ((P[1] ?? 0) + (P[3] ?? 0));
    const s02 = 0.5 * ((P[2] ?? 0) + (P[6] ?? 0));
    const s12 = 0.5 * ((P[5] ?? 0) + (P[7] ?? 0));
    P[1] = s01;
    P[3] = s01;
    P[2] = s02;
    P[6] = s02;
    P[5] = s12;
    P[7] = s12;
  }
}
