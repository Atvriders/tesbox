/**
 * Exhaust network, passive by construction (spec §5.3.4; Phase 2a contract topology + amendments
 * B3, B7, B10, B11). Digital waveguides (Smith, "Physical Audio Signal Processing") joined by
 * lossless N-port parallel junctions:
 *
 *   cylinder (r = +0.7) → header → collector junction (that collector's headers + collector tube)
 *   → collector → [turbo: turbine 2-port → 1-sample link] → merge junction (collectors + mid-pipe)
 *   → mid-pipe → muffler junction (mid-pipe, tailpipe, N side-branch chambers closed at r = +0.9;
 *     valve bypass blends in a lossless mid↔tail straight-through) → tailpipe → open end
 *     (r = −0.85 through a 1.5 kHz one-pole; exit wave p⁺ − p⁻)
 *   → outlet, outside every loop: 20 Hz first-order HP → 2 kHz first-order shelf → open gain.
 *
 * Topology (amendment B11): one header→collector junction, collector tube and turbine 2-port per
 * `voicing.collectors` entry, joining the headers of every bank that entry lists (a bank belongs to
 * the first collector listing it; unlisted banks join collector 0). This equals the contract's
 * per-bank wording when each collector lists one bank; the merge junction joins every collector and
 * the mid-pipe.
 *
 * Energy bookkeeping uses admittance-weighted rail energy: every junction conserves it; terminations,
 * rail filters, interpolators, the turbine 2-port and the valve bypass can only lose it.
 */
import type { EngineDef, Tier } from '../contracts';
import { MAX_COMBUSTION, MAX_SAMPLE_RATE, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_MAX } from '../contracts';
import { Biquad } from './biquad';
import { Junction } from './junction';
import { dbToGain } from './util';
import { MIN_DELAY_SAMPLES, Waveguide } from './waveguide';

const MIN_EXHAUST_FS = 28000;
const MAX_COLLECTORS = 8;
const MAX_MUFFLER_CHAMBERS = 4;
const LITE_MUFFLER_CHAMBERS = 2;
/** Contract max lengths (m); longer voicing values are clamped. */
const EXHAUST_MAX_LENGTH_M = {
  header: 1.5,
  collector: 1.0,
  midPipe: 3.0,
  mufflerSection: 0.8,
  tailpipe: 1.2,
} as const;
const HEADER_END_REFLECTION = 0.7;
const CHAMBER_END_REFLECTION = 0.9;
const OPEN_END_REFLECTION = -0.85;
const OPEN_END_LP_HZ = 1500;
/** Bypass weight a = BYPASS_MAX · valve (amendment B7). */
const BYPASS_MAX = 0.7;
const OUTLET_HP_HZ = 20;
const OUTLET_SHELF_HZ = 2000;
/** Outlet shelf gain in dB = VALVE_BRIGHTEN_DB·v − CLOSED_SHELF_CUT_DB·mufflerAction·(1 − v). */
const VALVE_BRIGHTEN_DB = 4;
const CLOSED_SHELF_CUT_DB = 6;
/** Internal anti-zipper slew on the valve value (full range in 20 ms) on top of the caller's slew. */
const VALVE_SMOOTH_S = 0.02;

/** Rail wall-loss corners (Hz) per section group. */
const LOSS_HZ = { header: 9000, collector: 7000, midPipe: 6000, chamber: 4000, tailpipe: 6000 } as const;
/** Header (and Lite unit) admittance per merged header; collector = 0.5·(headers + 1); mid = tail = 0.6·Σ collectors. */
const COLLECTOR_Y_PER_HEADER = 0.5;
const PIPE_Y_FRACTION = 0.6;
/** Side-branch admittance = Y_mid·(CHAMBER_Y_BASE + CHAMBER_Y_ACTION·mufflerAction·(1 − valve)). */
const CHAMBER_Y_BASE = 0.6;
const CHAMBER_Y_ACTION = 0.4;

function invalid(msg: string): never {
  throw new RangeError(`ExhaustNetwork.configure: ${msg}`);
}

function positive(x: unknown): boolean {
  return typeof x === 'number' && x > 0 && x < Infinity;
}

/** Throws RangeError for definitions the network cannot represent. Checks everything before any state changes. */
function validate(def: EngineDef): void {
  const comb = def.spec.combustion;
  const v = def.voicing;
  if (comb.length < 1 || comb.length > MAX_COMBUSTION) invalid(`${comb.length} combustion entries (1…${MAX_COMBUSTION})`);
  if (v.headersM.length < comb.length) invalid(`headersM has ${v.headersM.length} entries for ${comb.length} combustion entries`);
  for (let i = 0; i < comb.length; i++) {
    const b = comb[i]?.bank;
    if (b === undefined || !Number.isInteger(b) || b < 0 || b >= MAX_COMBUSTION) invalid(`entry ${i} bank ${b}`);
    if (!positive(v.headersM[i])) invalid(`headersM[${i}] = ${v.headersM[i]}`);
  }
  if (v.collectors.length < 1 || v.collectors.length > MAX_COLLECTORS) invalid(`${v.collectors.length} collectors (1…${MAX_COLLECTORS})`);
  for (let c = 0; c < v.collectors.length; c++) {
    if (!positive(v.collectors[c]?.lengthM)) invalid(`collectors[${c}].lengthM`);
  }
  const m = v.exhaust.mufflerSectionsM;
  if (m.length < 1) invalid('no muffler section');
  for (let k = 0; k < m.length && k < MAX_MUFFLER_CHAMBERS; k++) if (!positive(m[k])) invalid(`mufflerSectionsM[${k}]`);
  if (!positive(v.exhaust.midPipeM)) invalid('midPipeM');
  if (!positive(v.exhaust.tailpipeM)) invalid('tailpipeM');
}

export class ExhaustNetwork {
  private readonly fs: number;
  private readonly minLen: number;

  // ── sections (capacity-sized at SPEED_OF_SOUND_COLD and max(fs, MAX_SAMPLE_RATE), amendment B3) ──
  private readonly headers: Waveguide[] = [];
  private readonly colls: Waveguide[] = [];
  private readonly chambers: Waveguide[] = [];
  private readonly mid: Waveguide;
  private readonly tail: Waveguide;
  private readonly collJ: Junction[] = [];
  private readonly merge: Junction;
  private readonly muff: Junction;
  private readonly turbDown: Biquad[] = [];
  private readonly turbUp: Biquad[] = [];

  // ── topology (Int32Array/Float64Array, filled by configure) ──
  private readonly entryUnit = new Int32Array(MAX_COMBUSTION);
  private readonly unitBank = new Int32Array(MAX_COMBUSTION);
  private readonly unitCount = new Int32Array(MAX_COMBUSTION);
  private readonly unitColl = new Int32Array(MAX_COMBUSTION);
  private readonly unitLen = new Float64Array(MAX_COMBUSTION);
  private readonly unitY = new Float64Array(MAX_COMBUSTION);
  /** 1 / entries per unit: a Lite unit (admittance = entry count) gets the bank's mean pulse, i.e. the same volume flow as Full. */
  private readonly unitInv = new Float64Array(MAX_COMBUSTION);
  private readonly bankUnit = new Int32Array(MAX_COMBUSTION);
  private readonly bankColl = new Int32Array(MAX_COMBUSTION);
  private readonly collUnits = new Int32Array(MAX_COMBUSTION);
  private readonly collStart = new Int32Array(MAX_COLLECTORS);
  private readonly collCount = new Int32Array(MAX_COLLECTORS);
  private readonly collFill = new Int32Array(MAX_COLLECTORS);
  private readonly collY = new Float64Array(MAX_COLLECTORS);
  private readonly jAdm = new Float64Array(MAX_COMBUSTION + 1);
  private readonly mergeAdm = new Float64Array(MAX_COLLECTORS + 1);
  private readonly muffAdm = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);

  // ── per-sample scratch: arrivals (…A) and inputs (…I) as [right, left] pairs per section ──
  private readonly unitIn = new Float64Array(MAX_COMBUSTION);
  private readonly hA = new Float64Array(2 * MAX_COMBUSTION);
  private readonly hI = new Float64Array(2 * MAX_COMBUSTION);
  private readonly cA = new Float64Array(2 * MAX_COLLECTORS);
  private readonly cI = new Float64Array(2 * MAX_COLLECTORS);
  private readonly kA = new Float64Array(2 * MAX_MUFFLER_CHAMBERS);
  private readonly kI = new Float64Array(2 * MAX_MUFFLER_CHAMBERS);
  /** mid-pipe at [0, 1], tailpipe at [2, 3]. */
  private readonly pA = new Float64Array(4);
  private readonly pI = new Float64Array(4);
  private readonly linkDown = new Float64Array(MAX_COLLECTORS);
  private readonly linkUp = new Float64Array(MAX_COLLECTORS);
  private readonly newDown = new Float64Array(MAX_COLLECTORS);
  private readonly jin = new Float64Array(MAX_COMBUSTION + 1);
  private readonly jout = new Float64Array(MAX_COMBUSTION + 1);
  private readonly mergeIn = new Float64Array(MAX_COLLECTORS + 1);
  private readonly mergeOut = new Float64Array(MAX_COLLECTORS + 1);
  private readonly muffIn = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);
  private readonly muffOut = new Float64Array(2 + MAX_MUFFLER_CHAMBERS);

  // ── parameters ──
  private configured = false;
  private nEntries = 0;
  private nUnits = 0;
  private nColl = 0;
  private nCh = 0;
  private turbo = false;
  private turbR = 0;
  private turbT = 1;
  private turbGain = 1;
  private yMid = 1;
  private yCh = 1;
  private valveFitted = false;
  private openGainDb = 0;
  private mufflerAction = 0;
  private valveTarget = 0;
  private vSmooth = 0;
  private readonly valveStep: number;
  private bypass = 0;
  private shelfGain = 1;
  private outGain = 1;
  private cH = SPEED_OF_SOUND_COLD;
  private cC = SPEED_OF_SOUND_COLD;
  private cM = SPEED_OF_SOUND_COLD;
  private outletV = 0;
  private tapV = 0;
  // one-pole coefficients/states kept inline in tick (no double crosses a call boundary, amendment B2)
  private readonly openK: number;
  private readonly openA: number;
  private openY = 0;
  private readonly hpK: number;
  private readonly hpA: number;
  private hpY = 0;
  private readonly shK: number;
  private readonly shA: number;
  private shY = 0;

  constructor(fs: number) {
    if (!(fs >= MIN_EXHAUST_FS) || !Number.isFinite(fs)) {
      throw new RangeError(`ExhaustNetwork needs fs ≥ ${MIN_EXHAUST_FS} Hz, got ${fs}`);
    }
    this.fs = fs;
    this.minLen = ((MIN_DELAY_SAMPLES + 0.5) * SPEED_OF_SOUND_MAX) / fs;
    const fsCap = Math.max(fs, MAX_SAMPLE_RATE);
    const cap = (lengthM: number): number => Math.ceil((lengthM / SPEED_OF_SOUND_COLD) * fsCap) + 4;
    for (let i = 0; i < MAX_COMBUSTION; i++) this.headers.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.header)));
    for (let c = 0; c < MAX_COLLECTORS; c++) {
      this.colls.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.collector)));
      this.collJ.push(new Junction(MAX_COMBUSTION + 1));
      this.turbDown.push(new Biquad());
      this.turbUp.push(new Biquad());
    }
    for (let k = 0; k < MAX_MUFFLER_CHAMBERS; k++) {
      this.chambers.push(new Waveguide(cap(EXHAUST_MAX_LENGTH_M.mufflerSection)));
    }
    this.mid = new Waveguide(cap(EXHAUST_MAX_LENGTH_M.midPipe));
    this.tail = new Waveguide(cap(EXHAUST_MAX_LENGTH_M.tailpipe));
    this.merge = new Junction(MAX_COLLECTORS + 1);
    this.muff = new Junction(2 + MAX_MUFFLER_CHAMBERS);
    this.openK = onePoleK(OPEN_END_LP_HZ, fs);
    this.openA = 1 - this.openK;
    this.hpK = onePoleK(OUTLET_HP_HZ, fs);
    this.hpA = 1 - this.hpK;
    this.shK = onePoleK(OUTLET_SHELF_HZ, fs);
    this.shA = 1 - this.shK;
    this.valveStep = 1 / (VALVE_SMOOTH_S * fs);
  }

  /** Radiated pressure: exit wave → 20 Hz HP → shelf → open gain (all after the loop). */
  get outlet(): number {
    return this.outletV;
  }

  /** Mean junction pressure (p⁺ + p⁻) of the header→collector junctions. */
  get collectorTap(): number {
    return this.tapV;
  }

  /**
   * Builds the topology for `def` (Full: one header per combustion entry, up to 4 chambers; Lite: one
   * header per bank fed by the bank's summed pulses with the bank's mean header length, ≤ 2 chambers).
   * Throws RangeError (leaving the previous engine intact) for unrepresentable definitions; otherwise
   * never allocates. Leaves the network cold (343 m/s), valve closed, turbine attenuation 0, state cleared.
   */
  configure(def: EngineDef, tier: Tier): void {
    validate(def);
    const spec = def.spec;
    const v = def.voicing;
    const fs = this.fs;
    const n = spec.combustion.length;
    const lite = tier === 'lite';
    const nColl = v.collectors.length;

    // bank → first collector that lists it (unlisted banks join collector 0); amendment B11
    this.bankColl.fill(-1);
    for (let c = 0; c < nColl; c++) {
      const col = v.collectors[c];
      if (col === undefined) continue;
      const banks = col.banks;
      for (let j = 0; j < banks.length; j++) {
        const b = banks[j] ?? -1;
        if (Number.isInteger(b) && b >= 0 && b < MAX_COMBUSTION && this.bankColl[b] === -1) this.bankColl[b] = c;
      }
    }

    // header units: Full = one per entry, Lite = one per bank (order of first appearance)
    let nUnits = 0;
    this.bankUnit.fill(-1);
    for (let i = 0; i < n; i++) {
      const b = spec.combustion[i]?.bank ?? 0;
      let u = i;
      if (lite) {
        u = this.bankUnit[b] ?? -1;
        if (u < 0) {
          u = nUnits;
          this.bankUnit[b] = u;
        }
      }
      if (u === nUnits) {
        nUnits++;
        this.unitBank[u] = b;
        this.unitCount[u] = 0;
        this.unitLen[u] = 0;
      }
      this.entryUnit[i] = u;
      this.unitCount[u] = (this.unitCount[u] ?? 0) + 1;
      this.unitLen[u] = (this.unitLen[u] ?? 0) + (v.headersM[i] ?? 0);
    }

    // group units by collector: each collector junction joins the headers of every bank it owns (B11)
    for (let c = 0; c < nColl; c++) {
      this.collCount[c] = 0;
      this.collY[c] = COLLECTOR_Y_PER_HEADER;
    }
    for (let u = 0; u < nUnits; u++) {
      const c = Math.max(this.bankColl[this.unitBank[u] ?? 0] ?? 0, 0);
      this.unitColl[u] = c;
      this.collCount[c] = (this.collCount[c] ?? 0) + 1;
      this.collY[c] = (this.collY[c] ?? 0) + COLLECTOR_Y_PER_HEADER * (this.unitCount[u] ?? 0);
      this.unitY[u] = this.unitCount[u] ?? 1;
      this.unitInv[u] = 1 / (this.unitCount[u] ?? 1);
    }
    let start = 0;
    for (let c = 0; c < nColl; c++) {
      this.collStart[c] = start;
      this.collFill[c] = start;
      start += this.collCount[c] ?? 0;
    }
    for (let u = 0; u < nUnits; u++) {
      const c = this.unitColl[u] ?? 0;
      const slot = this.collFill[c] ?? 0;
      this.collUnits[slot] = u;
      this.collFill[c] = slot + 1;
    }

    // waveguides, cold
    for (let u = 0; u < nUnits; u++) {
      const len = (this.unitLen[u] ?? 0) / (this.unitCount[u] ?? 1);
      this.headers[u]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.header), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.header);
    }
    let sumCollY = 0;
    for (let c = 0; c < nColl; c++) {
      const len = v.collectors[c]?.lengthM ?? 0;
      this.colls[c]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.collector), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.collector);
      sumCollY += this.collY[c] ?? 0;
    }
    this.mid.configure(this.len(v.exhaust.midPipeM, EXHAUST_MAX_LENGTH_M.midPipe), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.midPipe);
    this.tail.configure(this.len(v.exhaust.tailpipeM, EXHAUST_MAX_LENGTH_M.tailpipe), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.tailpipe);
    const nCh = Math.min(v.exhaust.mufflerSectionsM.length, lite ? LITE_MUFFLER_CHAMBERS : MAX_MUFFLER_CHAMBERS);
    for (let k = 0; k < nCh; k++) {
      const len = v.exhaust.mufflerSectionsM[k] ?? 0;
      this.chambers[k]!.configure(this.len(len, EXHAUST_MAX_LENGTH_M.mufflerSection), SPEED_OF_SOUND_COLD, fs, LOSS_HZ.chamber);
    }

    // junction admittances
    for (let c = 0; c < nColl; c++) {
      const s = this.collStart[c] ?? 0;
      const cnt = this.collCount[c] ?? 0;
      for (let j = 0; j < cnt; j++) this.jAdm[j] = this.unitY[this.collUnits[s + j] ?? 0] ?? 1;
      this.jAdm[cnt] = this.collY[c] ?? 1;
      this.collJ[c]!.configure(this.jAdm, cnt + 1);
      this.mergeAdm[c] = this.collY[c] ?? 1;
    }
    this.yMid = PIPE_Y_FRACTION * sumCollY;
    this.mergeAdm[nColl] = this.yMid;
    this.merge.configure(this.mergeAdm, nColl + 1);

    // turbine 2-port (turbo engines with turbine voicing only)
    const tb = v.turbine;
    this.turbo = spec.aspiration.type === 'turbo' && tb !== null;
    if (tb !== null && this.turbo) {
      const r = tb.reflection;
      this.turbR = r > 0 ? (r < 0.95 ? r : 0.95) : r < 0 ? (r > -0.95 ? r : -0.95) : 0;
      this.turbT = Math.sqrt(1 - this.turbR * this.turbR);
      for (let c = 0; c < nColl; c++) {
        this.turbDown[c]!.lowpass(tb.lpHz, Math.SQRT1_2, fs);
        this.turbUp[c]!.lowpass(tb.lpHz, Math.SQRT1_2, fs);
      }
    } else {
      this.turbR = 0;
      this.turbT = 1;
    }

    this.nEntries = n;
    this.nUnits = nUnits;
    this.nColl = nColl;
    this.nCh = nCh;
    this.valveFitted = v.exhaust.valve.fitted;
    this.openGainDb = Number.isFinite(v.exhaust.valve.openGainDb) ? v.exhaust.valve.openGainDb : 0;
    const ma = v.exhaust.mufflerAction;
    this.mufflerAction = ma > 0 ? (ma < 1 ? ma : 1) : 0;
    this.valveTarget = 0;
    this.turbGain = 1;
    this.cH = SPEED_OF_SOUND_COLD;
    this.cC = SPEED_OF_SOUND_COLD;
    this.cM = SPEED_OF_SOUND_COLD;
    this.configured = true;
    this.reset();
  }

  /** Speeds of sound (m/s) per group, clamped into [343, 700]; NaN keeps the previous value. Caller slews (τ 2–5 s). */
  setGasSpeeds(header: number, collector: number, muffler: number): void {
    const h = header === header ? clampSpeed(header) : this.cH;
    const c = collector === collector ? clampSpeed(collector) : this.cC;
    const m = muffler === muffler ? clampSpeed(muffler) : this.cM;
    if (h !== this.cH) {
      this.cH = h;
      for (let u = 0; u < this.nUnits; u++) this.headers[u]!.setSpeed(h);
    }
    if (c !== this.cC) {
      this.cC = c;
      for (let k = 0; k < this.nColl; k++) this.colls[k]!.setSpeed(c);
    }
    if (m !== this.cM) {
      this.cM = m;
      this.mid.setSpeed(m);
      this.tail.setSpeed(m);
      for (let k = 0; k < this.nCh; k++) this.chambers[k]!.setSpeed(m);
    }
  }

  /** 0 closed … 1 open (clamped; NaN → 0). Ignored when the voicing has no valve. Caller slews 150–300 ms. */
  setValve(open01: number): void {
    if (!this.valveFitted) return;
    this.valveTarget = open01 > 0 ? (open01 < 1 ? open01 : 1) : 0;
  }

  /** 0…1 (clamped; NaN → 0): transmitted turbine wave × (1 − 0.5·x). No effect without a turbine. */
  setTurbineAttenuation(x01: number): void {
    const a = x01 > 0 ? (x01 < 1 ? x01 : 1) : 0;
    this.turbGain = 1 - 0.5 * a;
  }

  tick(headerIn: Float64Array, popIn: number): void {
    if (!this.configured) return;
    // anti-zipper valve smoothing (inline Slew: no double crosses a call boundary, amendment B2)
    let v = this.vSmooth;
    const vt = this.valveTarget;
    if (v !== vt) {
      const st = this.valveStep;
      v = vt - v > st ? v + st : v - vt > st ? v - st : vt;
      this.vSmooth = v;
      this.applyValve(v);
    }

    const nUnits = this.nUnits;
    const nColl = this.nColl;
    const nCh = this.nCh;
    const headers = this.headers;
    const colls = this.colls;
    const chambers = this.chambers;
    const unitIn = this.unitIn;
    const hA = this.hA;
    const hI = this.hI;
    const cA = this.cA;
    const cI = this.cI;
    const kA = this.kA;
    const kI = this.kI;
    const pA = this.pA;
    const pI = this.pI;

    // 1. per-unit pulse inputs (Lite sums the entries of a bank; step 3 divides by the entry count)
    for (let u = 0; u < nUnits; u++) unitIn[u] = 0;
    const entryUnit = this.entryUnit;
    for (let i = 0; i < this.nEntries; i++) {
      const u = entryUnit[i]!;
      unitIn[u] = unitIn[u]! + (headerIn[i] ?? 0);
    }

    // 2. waves arriving at every section end: [2s] at end B, [2s + 1] at end A
    for (let u = 0; u < nUnits; u++) headers[u]!.outPair(hA, 2 * u);
    for (let c = 0; c < nColl; c++) colls[c]!.outPair(cA, 2 * c);
    this.mid.outPair(pA, 0);
    this.tail.outPair(pA, 2);
    for (let k = 0; k < nCh; k++) chambers[k]!.outPair(kA, 2 * k);
    const mR = pA[0]!; // mid-pipe wave arriving at the muffler junction
    const mL = pA[1]!; // mid-pipe wave arriving at the merge junction
    const tR = pA[2]!; // tailpipe wave arriving at the open end
    const tL = pA[3]!; // tailpipe wave arriving at the muffler junction

    // 3. cylinder ends (r = +0.7) and header → collector junctions (pops enter each collector)
    const unitInv = this.unitInv;
    for (let u = 0; u < nUnits; u++) hI[2 * u] = unitIn[u]! * unitInv[u]! + HEADER_END_REFLECTION * hA[2 * u + 1]!;
    const jin = this.jin;
    const jout = this.jout;
    const collUnits = this.collUnits;
    const popShare = popIn / nColl;
    let tap = 0;
    for (let c = 0; c < nColl; c++) {
      const s = this.collStart[c]!;
      const cnt = this.collCount[c]!;
      for (let j = 0; j < cnt; j++) jin[j] = hA[2 * collUnits[s + j]!]!;
      jin[cnt] = cA[2 * c + 1]!;
      this.collJ[c]!.scatter(jin, jout);
      for (let j = 0; j < cnt; j++) hI[2 * collUnits[s + j]! + 1] = jout[j]!;
      cI[2 * c] = jout[cnt]! + popShare;
      tap += jin[0]! + jout[0]!;
    }

    // 4. turbine 2-ports (diag(1, gG)·[[r, t], [t, −r]]·diag(1, gG), |G| ≤ 1) and the merge junction
    const mergeIn = this.mergeIn;
    const mergeOut = this.mergeOut;
    if (this.turbo) {
      const r = this.turbR;
      const t = this.turbT;
      const g = this.turbGain;
      const linkUp = this.linkUp;
      const linkDown = this.linkDown;
      const newDown = this.newDown;
      for (let c = 0; c < nColl; c++) {
        const a = cA[2 * c]!;
        const b = g * this.turbUp[c]!.process(linkUp[c]!);
        cI[2 * c + 1] = r * a + t * b;
        newDown[c] = g * this.turbDown[c]!.process(t * a - r * b);
        mergeIn[c] = linkDown[c]!;
      }
      mergeIn[nColl] = mL;
      this.merge.scatter(mergeIn, mergeOut);
      for (let c = 0; c < nColl; c++) {
        linkUp[c] = mergeOut[c]!;
        linkDown[c] = newDown[c]!;
      }
    } else {
      for (let c = 0; c < nColl; c++) mergeIn[c] = cA[2 * c]!;
      mergeIn[nColl] = mL;
      this.merge.scatter(mergeIn, mergeOut);
      for (let c = 0; c < nColl; c++) cI[2 * c + 1] = mergeOut[c]!;
    }
    pI[0] = mergeOut[nColl]!; // mid-pipe right-going input at the merge end

    // 5. muffler junction with the valve bypass: S = (1 − a)·S_junction + a·S_bypass (amendment B7)
    const muffIn = this.muffIn;
    const muffOut = this.muffOut;
    muffIn[0] = mR;
    muffIn[1] = tL;
    for (let k = 0; k < nCh; k++) muffIn[2 + k] = kA[2 * k + 1]!;
    this.muff.scatter(muffIn, muffOut);
    const a = this.bypass;
    const keep = 1 - a;
    pI[1] = keep * muffOut[0]! + a * tL; // mid-pipe left-going input
    pI[2] = keep * muffOut[1]! + a * mR; // tailpipe input = lerp(mufflerJunctionOut, midPipeOut, 0.7·valve)
    for (let k = 0; k < nCh; k++) {
      kI[2 * k] = keep * muffOut[2 + k]!; // chambers are absorbed by the bypass branch
      kI[2 * k + 1] = CHAMBER_END_REFLECTION * kA[2 * k]!; // closed far end
    }

    // 6. open end: reflection −0.85·LP1.5k(p⁺); exit wave p⁺ − p⁻ (amendment B10)
    let ol = this.openK * tR + this.openA * this.openY;
    if (ol < 1e-20 && ol > -1e-20) ol = 0;
    this.openY = ol;
    const refl = OPEN_END_REFLECTION * ol;
    pI[3] = refl;
    const exit = tR - refl;

    // 7. write every section
    for (let u = 0; u < nUnits; u++) headers[u]!.inputPair(hI, 2 * u);
    for (let c = 0; c < nColl; c++) colls[c]!.inputPair(cI, 2 * c);
    this.mid.inputPair(pI, 0);
    this.tail.inputPair(pI, 2);
    for (let k = 0; k < nCh; k++) chambers[k]!.inputPair(kI, 2 * k);

    // 8. radiation (outside every loop): 20 Hz first-order HP → first-order shelf at 2 kHz → open gain
    let lp = this.hpK * exit + this.hpA * this.hpY;
    if (lp < 1e-20 && lp > -1e-20) lp = 0;
    this.hpY = lp;
    const hp = exit - lp;
    let lo = this.shK * hp + this.shA * this.shY;
    if (lo < 1e-20 && lo > -1e-20) lo = 0;
    this.shY = lo;
    this.outletV = this.outGain * (lo + this.shelfGain * (hp - lo));
    this.tapV = tap / nColl;
  }

  /**
   * Admittance-weighted stored wave energy: Σ Y·rail energy of every section plus the turbine links.
   * Non-finite filter states outside the rails make it NaN (0·x term), for the per-quantum NaN check.
   */
  energy(): number {
    let e = 0;
    for (let u = 0; u < this.nUnits; u++) e += this.unitY[u]! * this.headers[u]!.energy();
    for (let c = 0; c < this.nColl; c++) {
      const up = this.linkUp[c]!;
      const down = this.linkDown[c]!;
      e += this.collY[c]! * (this.colls[c]!.energy() + up * up + down * down);
    }
    e += this.yMid * (this.mid.energy() + this.tail.energy());
    for (let k = 0; k < this.nCh; k++) e += this.yCh * this.chambers[k]!.energy();
    return e + 0 * (this.openY + this.hpY + this.shY + this.outletV);
  }

  /** Clears all wave and filter state; keeps topology, speeds, valve target and attenuation. */
  reset(): void {
    for (let u = 0; u < MAX_COMBUSTION; u++) this.headers[u]!.clear();
    for (let c = 0; c < MAX_COLLECTORS; c++) {
      this.colls[c]!.clear();
      this.turbDown[c]!.reset();
      this.turbUp[c]!.reset();
    }
    for (let k = 0; k < MAX_MUFFLER_CHAMBERS; k++) this.chambers[k]!.clear();
    this.mid.clear();
    this.tail.clear();
    this.linkUp.fill(0);
    this.linkDown.fill(0);
    this.newDown.fill(0);
    this.openY = 0;
    this.hpY = 0;
    this.shY = 0;
    this.vSmooth = this.valveTarget;
    if (this.configured) this.applyValve(this.valveTarget);
    this.outletV = 0;
    this.tapV = 0;
  }

  /** Length clamped into [4.5 samples at 700 m/s, contract max]. */
  private len(x: number, max: number): number {
    return x > this.minLen ? (x < max ? x : max) : this.minLen;
  }

  private applyValve(v: number): void {
    const yMid = this.yMid;
    this.yCh = yMid * (CHAMBER_Y_BASE + CHAMBER_Y_ACTION * this.mufflerAction * (1 - v));
    const adm = this.muffAdm;
    adm[0] = yMid;
    adm[1] = yMid; // Y_tail = Y_mid: the straight-through bypass is lossless (B7)
    for (let k = 0; k < this.nCh; k++) adm[2 + k] = this.yCh;
    this.muff.configure(adm, 2 + this.nCh);
    this.bypass = BYPASS_MAX * v;
    this.shelfGain = dbToGain(VALVE_BRIGHTEN_DB * v - CLOSED_SHELF_CUT_DB * this.mufflerAction * (1 - v));
    this.outGain = dbToGain(this.openGainDb * v);
  }
}

/** One-pole coefficient k = 1 − e^(−2π·hz/fs) (same law as OnePole.setCutoff). */
function onePoleK(hz: number, fs: number): number {
  return 1 - Math.exp((-2 * Math.PI * hz) / fs);
}

function clampSpeed(c: number): number {
  return c > SPEED_OF_SOUND_COLD ? (c < SPEED_OF_SOUND_MAX ? c : SPEED_OF_SOUND_MAX) : SPEED_OF_SOUND_COLD;
}
