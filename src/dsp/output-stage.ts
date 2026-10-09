import { DEFAULT_OUTPUT } from '../contracts';
import type { OutputConfig } from '../contracts';
import { BUTTER4_Q, Biquad, Cascade } from './biquad';
import { OS_TAPS, Upsampler4 } from './oversample';
import { clamp, dbToGain, flush, gainToDb } from './util';

/** Final NaN-safe hard clip (contract: −1 dBTP = 0.8913). Nothing follows it. */
export const OUTPUT_CEILING = 0.8913;
/** Internal true-peak limiter target (amendment B9), leaving 0.3 dB for the clip and measurement. */
export const LIMITER_TARGET_DBTP = -1.3;
/** Limiter look-ahead: the whole stage delays audio by round(LIMITER_LOOKAHEAD_S · fs) samples. */
export const LIMITER_LOOKAHEAD_S = 0.0015;
export const LIMITER_RELEASE_S = 0.05;
/** Compressor (contract): linked stereo, soft knee 6 dB, −12 dBFS, 3:1, 5 ms / 120 ms. No make-up gain. */
export const COMP_THRESHOLD_DB = -12;
export const COMP_RATIO = 3;
export const COMP_KNEE_DB = 6;
export const COMP_ATTACK_S = 0.005;
export const COMP_RELEASE_S = 0.12;
/** First-order DC blocker corner (not combustion.ts's per-pulse DC_BLOCK_HZ = 10). */
export const OUTPUT_DC_BLOCK_HZ = 5;
/** Subwoofer 'yes': 2nd-order infrasonic high-pass only. */
export const SUB_HP_HZ = 22;
/** No-sub high-pass corner range (contract: 30–60 Hz). */
export const HP_CORNER_MIN_HZ = 30;
export const HP_CORNER_MAX_HZ = 60;
/** trimDb is clamped to this range (the UI uses −24…+6; lower values are accepted so callers can fade). */
export const TRIM_MIN_DB = -120;
export const TRIM_MAX_DB = 6;
/** NaN guard: non-finite or |x| above this after trim → 0 and nonFiniteCount++. */
export const NAN_GUARD_LIMIT = 1e6;
/** Virtual-bass envelope follower: instant attack, exponential release. */
export const VB_ENV_RELEASE_S = 0.1;

/** Below this envelope the virtual-bass shaper is idle (avoids 0/0). */
const VB_ENV_MIN = 1e-9;
/** Limiter release snaps to the held gain once within this distance (else rounding stalls at 1 − 1e-13). */
const LIM_SNAP = 1e-12;
/** Upsampler4 detection of the interval after audio sample m happens at push m + 6 (group delay 5.875). */
const DETECT_LAG = 6;
const DB_TO_LN = Math.LN10 / 20;

/** One channel of DC blocker + bass management. Per-sample values pass through the `x` field. */
class BassChannel {
  /** In: trimmed, NaN-guarded sample. Out: after DC blocker and bass management. */
  x = 0;
  /** Parameters (set by OutputStage.configure / beginQuantum). */
  sub = true;
  dcR = 0;
  envRel = 0;
  vbGain = 0;
  readonly subHp = new Biquad();
  readonly hp4 = new Cascade(2);
  readonly lp4 = new Cascade(2);
  readonly vbHp = new Cascade(2);
  readonly vbLp = new Biquad();
  private dcX1 = 0;
  private dcY1 = 0;
  private env = 0;

  reset(): void {
    this.subHp.reset();
    this.hp4.reset();
    this.lp4.reset();
    this.vbHp.reset();
    this.vbLp.reset();
    this.dcX1 = 0;
    this.dcY1 = 0;
    this.env = 0;
    this.x = 0;
  }

  step(): void {
    const x = this.x;
    // DC blocker: y = x − x[n−1] + R·y[n−1].
    const dc = flush(x - this.dcX1 + this.dcR * this.dcY1);
    this.dcX1 = x;
    this.dcY1 = dc;
    if (this.sub) {
      this.x = this.subHp.process(dc);
      return;
    }
    // No sub: 4th-order Butterworth HP at the corner + NLD virtual bass (Larsen & Aarts 2002):
    // removed band (4th-order LP at the corner) normalised by its envelope → Chebyshev T2 + T3
    // (2nd + 3rd harmonics of a unit sinusoid) → band-pass corner…4·corner (4th-order HP at the
    // corner, so envelope-error leakage of the sub-corner fundamental is cut 24 dB/oct, + 2nd-order
    // LP at 4·corner) → × envelope × gain.
    const hp = this.hp4.process(dc);
    const band = this.lp4.process(dc);
    const mag = band < 0 ? -band : band;
    this.env = mag > this.env ? mag : flush(this.env * this.envRel);
    let h = 0;
    if (this.env > VB_ENV_MIN) {
      const u = clamp(band / this.env, -1, 1);
      h = 2 * u * u - 1 + (4 * u * u * u - 3 * u);
    }
    const vb = this.vbLp.process(this.vbHp.process(h));
    this.x = hp + vb * this.env * this.vbGain;
  }
}

/**
 * Output stage (spec §5.3.12, §5.6), always last: per channel trim → NaN guard → DC blocker → bass
 * management; then linked soft-knee compressor → linked 4×-oversampled look-ahead true-peak limiter
 * (target −1.3 dBTP) → NaN-safe hard clip at 0.8913. Latency = round(1.5 ms · fs) samples.
 *
 * Limiter: required gain g[k] = min(1, target / peak[k]) where peak[k] is the max of |x| and the 4
 * Upsampler4 outputs of both channels; min-hold over H = D + 2 samples; release one-pole (50 ms);
 * moving average over A = D − 8 samples; applied to audio delayed by D. This bounds the gain on
 * audio sample m by every g[k] for k ∈ [m − 1, m + 9], which covers both its own sample peak (k = m)
 * and the Upsampler4 detections of the intervals next to it (k ≈ m + 5…m + 7, group delay 5.875).
 * Quiet skip (exact): the Upsampler4 outputs depend on its last `upMem` inputs with gain ≤ upGain
 * (both measured from an impulse at construction). While every one of those inputs is ≤ target/upGain,
 * no output can exceed the target, so the required gain is exactly 1 and the pushes are skipped; the
 * stored history is replayed before the next loud sample, so the upsampler state is as if never skipped.
 * The true-peak meter reuses the detections: each is delayed to the moment its audio leaves the stage
 * and scaled by the gain applied then (≈ 0.1 dB). In quiet passages (below ≈ −5.3 dBFS after the
 * compressor) it reads the sample peak instead.
 */
export class OutputStage {
  /** Increments for every non-finite / > 1e6 sample caught by the guard or the final clip. Not cleared by reset(). */
  nonFiniteCount = 0;

  private readonly fs: number;
  private readonly chL = new BassChannel();
  private readonly chR = new BassChannel();
  // trim
  private trimDb = 0;
  private trimGain = 1;
  private trimTarget = 1;
  private rampFrom = 1;
  private rampPos = 0;
  private rampFrames = 0;
  // compressor: smooth decoupled peak detector on the gain reduction (dB ≥ 0)
  private readonly compAtk: number;
  private readonly compRel: number;
  private readonly kneeLoLin: number;
  private compPeak = 0;
  private compGr = 0;
  // limiter
  private readonly upL = new Upsampler4();
  private readonly upR = new Upsampler4();
  private readonly lookahead: number;
  private readonly holdN: number;
  private readonly avgN: number;
  private readonly delayL: Float64Array;
  private readonly delayR: Float64Array;
  private readonly req: Float64Array;
  private readonly envRing: Float64Array;
  private readonly limRel: number;
  private readonly limCeil: number;
  private dPos = 0;
  private reqPos = 0;
  private reqBelow = 0;
  private envPos = 0;
  private envBelow = 0;
  private envSum = 0;
  private limEnv = 1;
  private limGain = 1;
  // quiet skip
  private readonly upMem: number;
  private readonly quietLevel: number;
  private readonly histL: Float64Array;
  private readonly histR: Float64Array;
  private histPos = 0;
  private loudLeft = 0;
  private upStale = false;
  // true-peak meter
  private readonly detRing: Float64Array;
  private detPos = 0;
  private tpMax = 0;
  // per-sample I/O
  private inL = 0;
  private inR = 0;
  private outL = 0;
  private outR = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.compAtk = Math.exp(-1 / (COMP_ATTACK_S * fs));
    this.compRel = Math.exp(-1 / (COMP_RELEASE_S * fs));
    this.kneeLoLin = dbToGain(COMP_THRESHOLD_DB - COMP_KNEE_DB / 2);
    this.lookahead = Math.max(1, Math.round(LIMITER_LOOKAHEAD_S * fs));
    this.holdN = this.lookahead + 2;
    this.avgN = Math.max(1, this.lookahead - 8);
    this.delayL = new Float64Array(this.lookahead);
    this.delayR = new Float64Array(this.lookahead);
    this.req = new Float64Array(this.holdN);
    this.envRing = new Float64Array(this.avgN);
    this.detRing = new Float64Array(Math.max(1, this.lookahead - DETECT_LAG));
    this.limRel = Math.exp(-1 / (LIMITER_RELEASE_S * fs));
    this.limCeil = dbToGain(LIMITER_TARGET_DBTP);
    // Measure the upsampler's memory and worst-case phase gain (Σ|taps| of the loudest phase) from
    // its impulse response, so the quiet skip holds for any polyphase arrangement of OS_TAPS.
    const probe = new Upsampler4();
    const phaseSum = new Float64Array(probe.out.length);
    let mem = 1;
    for (let j = 0; j < OS_TAPS.length; j++) {
      probe.push(j === 0 ? 1 : 0);
      for (let p = 0; p < probe.out.length; p++) {
        const v = Math.abs(probe.out[p] ?? 0);
        phaseSum[p] = (phaseSum[p] ?? 0) + v;
        if (v > 0) mem = j + 1;
      }
    }
    let upGain = 1;
    for (let p = 0; p < phaseSum.length; p++) upGain = Math.max(upGain, phaseSum[p] ?? 0);
    this.upMem = mem;
    this.quietLevel = this.limCeil / upGain;
    this.histL = new Float64Array(mem);
    this.histR = new Float64Array(mem);
    this.configure(DEFAULT_OUTPUT);
  }

  /** Bass mode from `subwoofer`; corner = clamp(hpCornerHz, 30, 60) (non-finite → 40); trim snaps to volumeTrimDb. Clears state. */
  configure(out: OutputConfig): void {
    const sub = out.subwoofer === 'yes';
    const corner = clamp(
      Number.isFinite(out.hpCornerHz) ? out.hpCornerHz : DEFAULT_OUTPUT.hpCornerHz,
      HP_CORNER_MIN_HZ,
      HP_CORNER_MAX_HZ,
    );
    this.setupChannel(this.chL, sub, corner);
    this.setupChannel(this.chR, sub, corner);
    const db = Number.isNaN(out.volumeTrimDb) ? 0 : clamp(out.volumeTrimDb, TRIM_MIN_DB, TRIM_MAX_DB);
    this.trimDb = db;
    this.trimTarget = dbToGain(db);
    this.trimGain = this.trimTarget;
    this.rampFrom = this.trimTarget;
    this.rampPos = 0;
    this.rampFrames = 0;
    this.applyVbGain();
    this.reset();
  }

  /** Call once per quantum before its process() calls: linear trim ramp from the current gain to trimDb, reaching it on sample `frames`. NaN keeps the previous trim. */
  beginQuantum(trimDb: number, frames: number): void {
    const db = Number.isNaN(trimDb) ? this.trimDb : clamp(trimDb, TRIM_MIN_DB, TRIM_MAX_DB);
    this.trimDb = db;
    this.rampFrom = this.trimGain;
    this.trimTarget = dbToGain(db);
    this.rampPos = 0;
    this.rampFrames = frames >= 1 ? Math.floor(frames) : 0;
    if (this.rampFrames === 0) this.trimGain = this.trimTarget;
    this.applyVbGain();
  }

  /** Per sample. Results in `l` / `r` (delayed by the look-ahead). */
  process(l: number, r: number): void {
    this.inL = l;
    this.inR = r;
    this.step();
  }

  get l(): number {
    return this.outL;
  }

  get r(): number {
    return this.outR;
  }

  /**
   * Max output true peak (dBTP) since the last takeTruePeak(); −200 when silent. 4× oversampled near
   * the ceiling. While the signal stays below the quiet-skip level (≈ −5.3 dBFS after the compressor)
   * it reports the output sample peak, which can read under the true peak (≈ 3 dB for an fs/4 tone at
   * 45°, at most ≈ 4 dB) but never hides an over: no 4× peak there can exceed −1.3 dBTP.
   */
  get truePeakDbtp(): number {
    return gainToDb(this.tpMax);
  }

  takeTruePeak(): number {
    const v = gainToDb(this.tpMax);
    this.tpMax = 0;
    return v;
  }

  /** Limiter gain reduction in dB at the last sample (≥ 0; 0 = no limiting). */
  get gainReductionDb(): number {
    return this.limGain < 1 ? -gainToDb(this.limGain) : 0;
  }

  /** Clears all signal state (filters, envelopes, look-ahead buffers, meters); completes any trim ramp. */
  reset(): void {
    this.chL.reset();
    this.chR.reset();
    this.trimGain = this.trimTarget;
    this.rampPos = this.rampFrames;
    this.compPeak = 0;
    this.compGr = 0;
    this.upL.reset();
    this.upR.reset();
    this.histL.fill(0);
    this.histR.fill(0);
    this.histPos = 0;
    this.loudLeft = 0;
    this.upStale = false;
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.req.fill(1);
    this.envRing.fill(1);
    this.detRing.fill(0);
    this.dPos = 0;
    this.reqPos = 0;
    this.reqBelow = 0;
    this.envPos = 0;
    this.envBelow = 0;
    this.envSum = this.avgN;
    this.detPos = 0;
    this.limEnv = 1;
    this.limGain = 1;
    this.tpMax = 0;
    this.outL = 0;
    this.outR = 0;
  }

  private setupChannel(ch: BassChannel, sub: boolean, corner: number): void {
    const fs = this.fs;
    ch.sub = sub;
    ch.dcR = Math.exp((-2 * Math.PI * OUTPUT_DC_BLOCK_HZ) / fs);
    ch.envRel = Math.exp(-1 / (VB_ENV_RELEASE_S * fs));
    ch.subHp.highpass(SUB_HP_HZ, Math.SQRT1_2, fs);
    ch.hp4.stage(0).highpass(corner, BUTTER4_Q[0], fs);
    ch.hp4.stage(1).highpass(corner, BUTTER4_Q[1], fs);
    ch.lp4.stage(0).lowpass(corner, BUTTER4_Q[0], fs);
    ch.lp4.stage(1).lowpass(corner, BUTTER4_Q[1], fs);
    ch.vbHp.stage(0).highpass(corner, BUTTER4_Q[0], fs);
    ch.vbHp.stage(1).highpass(corner, BUTTER4_Q[1], fs);
    ch.vbLp.lowpass(4 * corner, Math.SQRT1_2, fs);
  }

  /** Equal-loudness: virtual bass 0.5 at trim ≤ −12 dB, falling linearly to 0.25 at +6 dB. */
  private applyVbGain(): void {
    const g = 0.5 * (1 - clamp((this.trimDb + 12) / 18, 0, 1) * 0.5);
    this.chL.vbGain = g;
    this.chR.vbGain = g;
  }

  private step(): void {
    // 1. Trim: linear ramp across the quantum.
    if (this.rampPos < this.rampFrames) {
      this.rampPos++;
      this.trimGain =
        this.rampPos === this.rampFrames
          ? this.trimTarget
          : this.rampFrom + (this.trimTarget - this.rampFrom) * (this.rampPos / this.rampFrames);
    }
    const g = this.trimGain;

    // 2. NaN guard.
    let xl = this.inL * g;
    if (!(xl === xl) || xl > NAN_GUARD_LIMIT || xl < -NAN_GUARD_LIMIT) {
      xl = 0;
      this.nonFiniteCount++;
    }
    let xr = this.inR * g;
    if (!(xr === xr) || xr > NAN_GUARD_LIMIT || xr < -NAN_GUARD_LIMIT) {
      xr = 0;
      this.nonFiniteCount++;
    }

    // 3–4. DC blocker + bass management.
    const chL = this.chL;
    const chR = this.chR;
    chL.x = xl;
    chL.step();
    chR.x = xr;
    chR.step();
    const bl = chL.x;
    const br = chR.x;

    // 5. Compressor: linked peak level → soft-knee gain computer → smooth decoupled peak detector
    //    on the gain reduction (Giannoulis, Massberg & Reiss 2012): release stage, then attack stage.
    const al = bl < 0 ? -bl : bl;
    const ar = br < 0 ? -br : br;
    const lvl = al > ar ? al : ar;
    let red = 0;
    if (lvl > this.kneeLoLin) {
      const over = 20 * Math.log10(lvl) - COMP_THRESHOLD_DB;
      const slope = 1 - 1 / COMP_RATIO;
      if (over >= COMP_KNEE_DB / 2) {
        red = slope * over;
      } else {
        const t = over + COMP_KNEE_DB / 2;
        red = (slope * t * t) / (2 * COMP_KNEE_DB);
      }
    }
    const released = this.compRel * this.compPeak + (1 - this.compRel) * red;
    this.compPeak = flush(red > released ? red : released);
    this.compGr = flush(this.compAtk * this.compGr + (1 - this.compAtk) * this.compPeak);
    const cg = this.compGr === 0 ? 1 : Math.exp(-this.compGr * DB_TO_LN);
    const cl = bl * cg;
    const cr = br * cg;

    // 6. True-peak look-ahead limiter. Detection: sample peaks + 4× upsampled peaks, both channels.
    const acl = cl < 0 ? -cl : cl;
    const acr = cr < 0 ? -cr : cr;
    let peak = acl > acr ? acl : acr;
    this.histL[this.histPos] = cl;
    this.histR[this.histPos] = cr;
    this.histPos = this.histPos + 1 === this.upMem ? 0 : this.histPos + 1;
    if (peak > this.quietLevel) this.loudLeft = this.upMem;
    if (this.loudLeft > 0) {
      this.loudLeft--;
      if (this.upStale) {
        // Replay the previous upMem − 1 inputs (oldest first); histPos now points at the oldest.
        for (let j = 0; j < this.upMem - 1; j++) {
          const i = this.histPos + j < this.upMem ? this.histPos + j : this.histPos + j - this.upMem;
          this.upL.push(this.histL[i] ?? 0);
          this.upR.push(this.histR[i] ?? 0);
        }
        this.upStale = false;
      }
      this.upL.push(cl);
      this.upR.push(cr);
      const oL = this.upL.out;
      const oR = this.upR.out;
      for (let k = 0; k < oL.length; k++) {
        const a = oL[k] ?? 0;
        const b = oR[k] ?? 0;
        if (a > peak) peak = a;
        else if (-a > peak) peak = -a;
        if (b > peak) peak = b;
        else if (-b > peak) peak = -b;
      }
    } else {
      this.upStale = true;
    }
    // Min-hold of the required gain over holdN samples (loop only while some entry is < 1).
    const req = peak > this.limCeil ? this.limCeil / peak : 1;
    if ((this.req[this.reqPos] ?? 1) < 1) this.reqBelow--;
    if (req < 1) this.reqBelow++;
    this.req[this.reqPos] = req;
    this.reqPos = this.reqPos + 1 === this.holdN ? 0 : this.reqPos + 1;
    let held = 1;
    if (this.reqBelow > 0) {
      for (let i = 0; i < this.holdN; i++) {
        const v = this.req[i] ?? 1;
        if (v < held) held = v;
      }
    }
    // Release (50 ms one-pole toward the held gain; attack is instant).
    let env = held;
    if (held > this.limEnv) {
      const gap = (held - this.limEnv) * this.limRel;
      if (gap > LIM_SNAP) env = held - gap;
    }
    this.limEnv = env;
    // Moving average over avgN samples (running sum, recomputed exactly at every ring wrap).
    const oldEnv = this.envRing[this.envPos] ?? 1;
    if (oldEnv < 1) this.envBelow--;
    if (env < 1) this.envBelow++;
    this.envRing[this.envPos] = env;
    this.envSum += env - oldEnv;
    this.envPos = this.envPos + 1 === this.avgN ? 0 : this.envPos + 1;
    let lg = 1;
    if (this.envBelow > 0) {
      if (this.envPos === 0) {
        let s = 0;
        for (let i = 0; i < this.avgN; i++) s += this.envRing[i] ?? 1;
        this.envSum = s;
      }
      lg = this.envSum / this.avgN;
      if (lg > 1) lg = 1;
    } else {
      this.envSum = this.avgN;
    }
    this.limGain = lg;
    const dl = this.delayL[this.dPos] ?? 0;
    const dr = this.delayR[this.dPos] ?? 0;
    this.delayL[this.dPos] = cl;
    this.delayR[this.dPos] = cr;
    this.dPos = this.dPos + 1 === this.lookahead ? 0 : this.dPos + 1;

    // 7. NaN-safe hard clip. No gain stage follows.
    let yl = dl * lg;
    let yr = dr * lg;
    if (yl === yl) yl = yl > OUTPUT_CEILING ? OUTPUT_CEILING : yl < -OUTPUT_CEILING ? -OUTPUT_CEILING : yl;
    else {
      yl = 0;
      this.nonFiniteCount++;
    }
    if (yr === yr) yr = yr > OUTPUT_CEILING ? OUTPUT_CEILING : yr < -OUTPUT_CEILING ? -OUTPUT_CEILING : yr;
    else {
      yr = 0;
      this.nonFiniteCount++;
    }

    // True-peak meter: the detection made DETECT_LAG pushes after this sample entered, × gain now.
    const det = this.detRing[this.detPos] ?? 0;
    this.detRing[this.detPos] = peak;
    this.detPos = this.detPos + 1 === this.detRing.length ? 0 : this.detPos + 1;
    let tp = det * lg;
    const ayl = yl < 0 ? -yl : yl;
    const ayr = yr < 0 ? -yr : yr;
    if (ayl > tp) tp = ayl;
    if (ayr > tp) tp = ayr;
    if (tp > this.tpMax) this.tpMax = tp;
    this.outL = yl;
    this.outR = yr;
  }
}
