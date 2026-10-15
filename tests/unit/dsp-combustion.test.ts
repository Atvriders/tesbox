import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION } from '../../src/contracts';
import type { EngineSpec, EngineVoicing } from '../../src/contracts';
import {
  ALPHA_FLOOR,
  CombustionSource,
  DC_BLOCK_HZ,
  RPM_CEIL,
  ROTARY_FACE_DEPTH,
  clampAlpha,
  cylinderSpreadPattern,
  peakFraction,
  pulsePeak,
  pulseShape,
} from '../../src/dsp/combustion';
import { dbToGain } from '../../src/dsp/util';

const FS = 48000;

/** Typed read for noUncheckedIndexedAccess: throws instead of returning undefined. */
function at<T>(xs: ArrayLike<T>, i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`index ${i} out of range (length ${xs.length})`);
  return v;
}

interface PulseOpts {
  widthDeg?: number;
  alpha?: number;
  beta?: number;
  evoOffsetDeg?: number;
  cycleAsymmetry?: number;
  cylinderSpreadDb?: number;
}

function makeEngine(angles: number[], cycleDeg: 720 | 1080 = 720, pulse: PulseOpts = {}): { spec: EngineSpec; voicing: EngineVoicing } {
  const spec: EngineSpec = {
    layout: { type: cycleDeg === 1080 ? 'rotary' : 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2 },
    cycleDeg,
    combustion: angles.map((angleDeg) => ({ angleDeg, bank: 0 })),
    rpm: { idle: 800, redline: 7000, limiter: { type: 'ignition-hard', rpm: 7100, hysteresisRpm: 150 } },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: {
      type: 'manual',
      overallRatios: [13.1, 8.4, 6.1, 4.8, 4.0, 3.4],
      drivenTyre: '225/40R18',
      shiftTimeS: 0.3,
      tc: null,
    },
    sources: { layout: ['test'], combustion: ['test'], rpm: ['test'], aspiration: ['test'], gearbox: ['test'] },
  };
  const voicing: EngineVoicing = {
    pulse: {
      widthDeg: pulse.widthDeg ?? 60,
      alpha: pulse.alpha ?? 9,
      beta: pulse.beta ?? 4,
      evoOffsetDeg: pulse.evoOffsetDeg ?? 140,
      cycleAsymmetry: pulse.cycleAsymmetry ?? 0,
      cylinderSpreadDb: pulse.cylinderSpreadDb ?? 0,
    },
    headersM: angles.map(() => 0.6),
    collectors: [{ banks: [0], lengthM: 0.35 }],
    turbine: null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: false, openGainDb: 0 },
    },
    intake: { runnerM: 0.3, helmholtzHz: 140, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: 1300 },
    cabin: { lowpassHz: 600, leakDb: -30, boomHz: 100, boomDb: 0 },
    launchRpm: 3000,
    estimated: true,
  };
  return { spec, voicing };
}

function makeSource(angles: number[], cycleDeg: 720 | 1080 = 720, pulse: PulseOpts = {}, seed = 1): CombustionSource {
  const { spec, voicing } = makeEngine(angles, cycleDeg, pulse);
  const src = new CombustionSource(FS);
  src.configure(spec, voicing, seed);
  return src;
}

interface Capture {
  ex: Float64Array[];
  gate: Float64Array[];
  ign: Float64Array;
  crank: Float64Array;
}

interface RenderOpts {
  rpm: number | ((k: number) => number);
  load?: number;
  gain?: number;
  mask?: (k: number) => number;
  ignitionCut?: boolean;
}

/** Ticks `samples` times and records every entry's outputs, the ignition sum and the crank angle. */
function render(src: CombustionSource, entries: number, samples: number, o: RenderOpts): Capture {
  const exOut = new Float64Array(MAX_COMBUSTION);
  const gateOut = new Float64Array(MAX_COMBUSTION);
  const ex = Array.from({ length: entries }, () => new Float64Array(samples));
  const gate = Array.from({ length: entries }, () => new Float64Array(samples));
  const ign = new Float64Array(samples);
  const crank = new Float64Array(samples);
  const rpmOf = o.rpm;
  for (let k = 0; k < samples; k++) {
    src.skipMask = o.mask ? o.mask(k) : 0;
    src.skipIsIgnition = o.ignitionCut ?? false;
    const rpm = typeof rpmOf === 'number' ? rpmOf : rpmOf(k);
    ign[k] = src.tick(rpm, o.load ?? 0.5, o.gain ?? 1, exOut, gateOut);
    crank[k] = src.crankDeg;
    for (let i = 0; i < entries; i++) {
      at(ex, i)[k] = at(exOut, i);
      at(gate, i)[k] = at(gateOut, i);
    }
  }
  return { ex, gate, ign, crank };
}

/** Inverts the per-entry DC blocker y = g·(x − x₁) + R·y₁ (g = (1 + R)/2) to recover the raw pulse train. */
function undc(y: Float64Array): Float64Array {
  const r = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) / FS);
  const g = (1 + r) / 2;
  const x = new Float64Array(y.length);
  let xPrev = 0;
  let yPrev = 0;
  for (let k = 0; k < y.length; k++) {
    const yk = at(y, k);
    const xk = xPrev + (yk - r * yPrev) / g;
    x[k] = xk;
    xPrev = xk;
    yPrev = yk;
  }
  return x;
}

interface Pulse {
  start: number;
  peakIndex: number;
  peak: number;
  length: number;
}

/** Contiguous runs of the recovered pulse train above `eps`. */
function pulses(x: Float64Array, eps = 1e-9): Pulse[] {
  const out: Pulse[] = [];
  let k = 0;
  while (k < x.length) {
    if (at(x, k) > eps) {
      const start = k;
      let peakIndex = k;
      while (k < x.length && at(x, k) > eps) {
        if (at(x, k) > at(x, peakIndex)) peakIndex = k;
        k++;
      }
      out.push({ start, peakIndex, peak: at(x, peakIndex), length: k - start });
    } else {
      k++;
    }
  }
  return out;
}

function firings(ign: Float64Array): number[] {
  const idx: number[] = [];
  for (let k = 0; k < ign.length; k++) if (at(ign, k) !== 0) idx.push(k);
  return idx;
}

function allFinite(xs: ArrayLike<number>): boolean {
  for (let k = 0; k < xs.length; k++) if (!Number.isFinite(at(xs, k))) return false;
  return true;
}

function allZero(xs: ArrayLike<number>): boolean {
  for (let k = 0; k < xs.length; k++) if (at(xs, k) !== 0) return false;
  return true;
}

function level(load: number): number {
  return 0.15 + 0.85 * Math.pow(Math.max(load, 0), 0.7);
}

/** |DFT|² of x at frequency hz (Hann window). */
function lineEnergy(x: Float64Array, hz: number): number {
  let re = 0;
  let im = 0;
  const n = x.length;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    const ph = (2 * Math.PI * hz * k) / FS;
    re += w * at(x, k) * Math.cos(ph);
    im -= w * at(x, k) * Math.sin(ph);
  }
  return re * re + im * im;
}

describe('pulse helpers', () => {
  it('pulseShape is 0 outside (0, 1) and for NaN, quadratic at onset, zero-slope at the end, continuous at the taper', () => {
    expect(pulseShape(0, 9, 4)).toBe(0);
    expect(pulseShape(-0.1, 9, 4)).toBe(0);
    expect(pulseShape(1, 9, 4)).toBe(0);
    expect(pulseShape(1.2, 9, 4)).toBe(0);
    expect(pulseShape(Number.NaN, 9, 4)).toBe(0);
    // onset ≈ (αφ)²: 10× smaller φ → ≈ 100× smaller E (C¹ onset)
    expect(pulseShape(1e-4, 9, 4) / pulseShape(1e-3, 9, 4)).toBeCloseTo(0.01, 3);
    // end ≈ (1 − φ)² (cos² taper): E(1) = 0 with zero slope
    expect(pulseShape(1 - 1e-4, 9, 4) / pulseShape(1 - 1e-3, 9, 4)).toBeLessThan(0.011);
    expect(Math.abs(pulseShape(0.75 + 1e-9, 9, 4) - pulseShape(0.75 - 1e-9, 9, 4))).toBeLessThan(1e-8);
  });

  it('pulseShape matches (1 − e^(−αφ))²·e^(−βφ) before the taper and adds the cos² taper after 0.75', () => {
    expect(pulseShape(0.3, 9, 4)).toBeCloseTo(Math.pow(1 - Math.exp(-2.7), 2) * Math.exp(-1.2), 14);
    const phi = 0.9;
    const taper = Math.pow(Math.cos((Math.PI / 2) * ((phi - 0.75) / 0.25)), 2);
    expect(pulseShape(phi, 9, 4)).toBeCloseTo(Math.pow(1 - Math.exp(-9 * phi), 2) * Math.exp(-4 * phi) * taper, 14);
  });

  it('pulsePeak is the true maximum (closed-form and tapered branches)', () => {
    const cases: [number, number][] = [
      [9, 4],
      [40, 4],
      [2, 1],
      [1, 0.5], // untapered peak beyond 0.75 → golden-section branch
      [0.2, 0.05],
      [ALPHA_FLOOR, 4],
      [200, 30],
    ];
    for (const [alpha, beta] of cases) {
      const peak = pulsePeak(alpha, beta);
      expect(peak).toBeGreaterThan(0);
      let max = 0;
      const steps = 200000;
      for (let k = 1; k < steps; k++) max = Math.max(max, pulseShape(k / steps, alpha, beta));
      expect(max / peak).toBeLessThanOrEqual(1 + 1e-9);
      expect(max / peak).toBeGreaterThan(1 - 1e-6);
    }
  });

  it('peakFraction is ln((α + β)/β)/α, decreasing in α, → 1/β as α → 0', () => {
    expect(peakFraction(9, 4)).toBeCloseTo(Math.log((9 + 4) / 4) / 9, 14);
    expect(peakFraction(20, 4)).toBeLessThan(peakFraction(10, 4));
    expect(peakFraction(1e-9, 4)).toBeCloseTo(0.25, 6);
  });

  it('clampAlpha passes valid α through, returns the largest valid α otherwise, ALPHA_FLOOR when unattainable', () => {
    expect(clampAlpha(9, 4, 0.01)).toBe(9);
    expect(clampAlpha(9, 4, 0)).toBe(9); // rpm 0 → minFrac 0 → no clamp
    const a = clampAlpha(52, 4, 0.15);
    expect(a).toBeLessThan(52);
    expect(peakFraction(a, 4)).toBeGreaterThanOrEqual(0.15);
    expect(peakFraction(a * (1 + 1e-6), 4)).toBeLessThan(0.15);
    expect(clampAlpha(9, 4, 0.3)).toBe(ALPHA_FLOOR); // even α → 0 peaks before 0.25 of the width
  });
});

describe('CombustionSource: clock, firing, amplitude', () => {
  it('rejects bad sample rates and combustion counts outside 1–16', () => {
    expect(() => new CombustionSource(0)).toThrow(RangeError);
    expect(() => new CombustionSource(Number.NaN)).toThrow(RangeError);
    expect(() => new CombustionSource(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    const src = new CombustionSource(FS);
    const tooMany = makeEngine(Array.from({ length: MAX_COMBUSTION + 1 }, (_, i) => i * 40));
    expect(() => src.configure(tooMany.spec, tooMany.voicing, 1)).toThrow(RangeError);
    const none = makeEngine([]);
    expect(() => src.configure(none.spec, none.voicing, 1)).toThrow(RangeError);
  });

  it('advances the crank by rpm·6/fs per tick and wraps into [0, cycleDeg)', () => {
    const src = makeSource([0, 180, 360, 540]);
    const exOut = new Float64Array(MAX_COMBUSTION);
    const gateOut = new Float64Array(MAX_COMBUSTION);
    let expected = 0;
    for (let k = 0; k < 5000; k++) {
      src.tick(3000, 0.5, 1, exOut, gateOut); // 0.375°/sample, exact in binary
      expected = (expected + 0.375) % 720;
      expect(src.crankDeg).toBe(expected);
    }
    const rotary = makeSource([0, 360, 720], 1080, { widthDeg: 300 });
    for (let k = 0; k < 4000; k++) rotary.tick(5000, 0.5, 1, exOut, gateOut); // 0.625°/sample
    expect(rotary.crankDeg).toBeGreaterThanOrEqual(0);
    expect(rotary.crankDeg).toBeLessThan(1080);
    expect(rotary.crankDeg).toBeCloseTo((4000 * 0.625) % 1080, 6);
  });

  it('fires every entry once per cycle at its angle (I4 at 3000 rpm: 100 firings/s)', () => {
    const angles = [0, 180, 360, 540];
    const cap = render(makeSource(angles), 4, FS, { rpm: 3000 });
    const idx = firings(cap.ign);
    expect(idx.length).toBe(100);
    for (const k of idx) {
      const end = at(cap.crank, k);
      // the firing angle lies in [end − d, end) ⇒ (end − angle) mod 720 ∈ (0, d]
      const hit = angles.some((a) => {
        const past = (((end - a) % 720) + 720) % 720;
        return past > 0 && past <= 0.375 + 1e-9;
      });
      expect(hit).toBe(true);
    }
  });

  it('scales amplitude by (0.15 + 0.85·max(load, 0)^0.7)·combustionGain with ±5 % uniform jitter', () => {
    const cases: [number, number][] = [
      [0.5, 0.8],
      [1, 1],
      [-0.4, 0.6],
      [0, 0.15],
    ];
    for (const [load, gain] of cases) {
      const cap = render(makeSource([0, 180, 360, 540]), 4, FS, { rpm: 3000, load, gain });
      const amps = firings(cap.ign).map((k) => at(cap.ign, k));
      const base = level(load) * gain;
      expect(amps.length).toBe(100);
      for (const a of amps) {
        expect(a).toBeGreaterThanOrEqual(0.95 * base - 1e-12);
        expect(a).toBeLessThanOrEqual(1.05 * base + 1e-12);
      }
      expect(Math.max(...amps) - Math.min(...amps)).toBeGreaterThan(0.05 * base); // jitter present
    }
  });

  it('alternates cycle amplitudes by 1 − 0.5·asym (even, first) and 1 + 0.5·asym (odd)', () => {
    const cap = render(makeSource([0], 720, { cycleAsymmetry: 1 }), 1, FS, { rpm: 3000 });
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(amps.length).toBe(25);
    for (let c = 0; c < amps.length; c++) {
      const scale = c % 2 === 0 ? 0.5 : 1.5;
      expect(at(amps, c)).toBeGreaterThanOrEqual(level(0.5) * scale * 0.95 - 1e-12);
      expect(at(amps, c)).toBeLessThanOrEqual(level(0.5) * scale * 1.05 + 1e-12);
    }
  });

  it('rotary faces carry a fixed 1 + depth·cos(2π·angle/1080) signature → ⅓-order sidebands', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const src = makeSource(angles, 1080, { widthDeg: 300, evoOffsetDeg: 200 });
    const cycles = 60;
    const cap = render(src, 6, cycles * 2880, { rpm: 3000 }); // 0.375°/sample → 2880 samples per 1080°
    const idx = firings(cap.ign);
    expect(idx.length).toBe(6 * cycles);
    const sums = new Map<number, { sum: number; count: number }>();
    for (const k of idx) {
      const end = at(cap.crank, k);
      const face = angles.find((a) => {
        const past = (((end - a) % 1080) + 1080) % 1080;
        return past > 0 && past <= 0.375 + 1e-9;
      });
      expect(face).toBeDefined();
      const key = face ?? -1;
      const s = sums.get(key) ?? { sum: 0, count: 0 };
      s.sum += at(cap.ign, k);
      s.count += 1;
      sums.set(key, s);
    }
    for (const a of angles) {
      const s = sums.get(a);
      expect(s?.count).toBe(cycles);
      const mean = (s?.sum ?? 0) / cycles;
      const expected = level(0.5) * (1 + ROTARY_FACE_DEPTH * Math.cos((2 * Math.PI * a) / 1080));
      expect(Math.abs(mean / expected - 1)).toBeLessThan(0.025); // faces differ by 5–10 %
    }
    // ignition train: firing line at order 2 (100 Hz at 3000 rpm), sidebands at orders 5/3 and 7/3
    const order = 50; // e-shaft Hz
    const main = lineEnergy(cap.ign, 2 * order);
    for (const side of [5 / 3, 7 / 3]) {
      const db = 10 * Math.log10(lineEnergy(cap.ign, side * order) / main);
      expect(db).toBeGreaterThan(-30);
      expect(db).toBeLessThan(-20);
    }
  });
});

describe('CombustionSource: per-cylinder combustion-level spread (phase 2a amendment B20)', () => {
  it('cylinderSpreadPattern: cylinder 1 at +1, every other cylinder at −1/(n − 1) — zero mean in dB; 0 for a single cylinder', () => {
    expect(cylinderSpreadPattern(0, 1)).toBe(0);
    for (let n = 2; n <= MAX_COMBUSTION; n++) {
      const p = Array.from({ length: n }, (_, k) => cylinderSpreadPattern(k, n));
      expect(p[0], `n ${n}`).toBe(1);
      for (let k = 1; k < n; k++) expect(at(p, k), `n ${n}, cylinder ${k + 1}`).toBe(-1 / (n - 1));
      expect(Math.abs(p.reduce((s, x) => s + x, 0)), `n ${n}`).toBeLessThan(1e-12);
    }
    // no such cylinder: no scale
    expect(cylinderSpreadPattern(4, 4)).toBe(0);
    expect(cylinderSpreadPattern(-1, 4)).toBe(0);
  });

  it("scales cylinder k's firings — blowdown pulse and ignition impulse alike — by dbToGain(cylinderSpreadDb·pattern(k))", () => {
    const angles = [0, 180, 360, 540];
    const flat = render(makeSource(angles), 4, FS, { rpm: 3000 });
    const spread = render(makeSource(angles, 720, { cylinderSpreadDb: 6 }), 4, FS, { rpm: 3000 });
    // same seed, same jitter draws: every sample of entry i is the unspread one × the entry's fixed gain
    for (let i = 0; i < 4; i++) {
      const g = dbToGain(6 * cylinderSpreadPattern(i, 4));
      const a = at(spread.ex, i);
      const b = at(flat.ex, i);
      let peak = 0;
      let err = 0;
      for (let k = 0; k < FS; k++) {
        err = Math.max(err, Math.abs(at(a, k) - g * at(b, k)));
        peak = Math.max(peak, Math.abs(at(b, k)));
      }
      expect(peak, `entry ${i}`).toBeGreaterThan(0.1);
      expect(err, `entry ${i}`).toBeLessThan(1e-12);
    }
    const idx = firings(flat.ign);
    expect(idx.length).toBe(100);
    expect(firings(spread.ign)).toEqual(idx);
    for (const k of idx) {
      const cylinder = Math.floor(at(flat.crank, k) / 180); // a firing at angle a ends its tick at crank ∈ (a, a + d]
      expect(at(spread.ign, k) / at(flat.ign, k), `tick ${k}`).toBeCloseTo(dbToGain(6 * cylinderSpreadPattern(cylinder, 4)), 12);
    }
    // cylinder 1 at +6 dB, the other three at −2 dB: zero mean in dB
    expect(6 * cylinderSpreadPattern(0, 4)).toBe(6);
    expect(6 * cylinderSpreadPattern(3, 4)).toBeCloseTo(-2, 12);
  });

  it('creates the half orders directly: every non-firing order of an I4 at the level the pattern predicts, none without spread', () => {
    const angles = [0, 180, 360, 540];
    const crankHz = 50; // 3000 rpm
    for (const spreadDb of [0, 2, 6]) {
      const cap = render(makeSource(angles, 720, { cylinderSpreadDb: spreadDb }), 4, 2 * FS, { rpm: 3000 });
      const fire = lineEnergy(cap.ign, 2 * crankHz);
      // the ignition train Σ g_k δ at the four firing positions: |half order| / |firing order| = |g₀ − g₁| / (g₀ + 3·g₁)
      const g0 = dbToGain(spreadDb);
      const g1 = dbToGain(-spreadDb / 3);
      const want = 20 * Math.log10(Math.abs(g0 - g1) / (g0 + 3 * g1));
      for (const order of [0.5, 1, 1.5, 2.5, 3, 3.5]) {
        const db = 10 * Math.log10(lineEnergy(cap.ign, order * crankHz) / fire);
        if (spreadDb === 0) expect(db, `order ${order}`).toBeLessThan(-25);
        else expect(Math.abs(db - want), `${spreadDb} dB spread, order ${order}: ${db.toFixed(2)} vs ${want.toFixed(2)} dB`).toBeLessThan(1);
      }
    }
  });
});

describe('CombustionSource: blowdown pulses', () => {
  it('emits one peak-normalised pulse per firing, widthDeg long, starting evoOffsetDeg ± 1° after ignition', () => {
    const samples = 30 * 5760; // 30 cycles at 1000 rpm (0.125°/sample, 5760 samples per 720°)
    const cap = render(makeSource([0]), 1, samples, { rpm: 1000, load: 0.5 });
    const x = undc(at(cap.ex, 0));
    const ps = pulses(x);
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(ps.length).toBe(30);
    const onsets: number[] = [];
    ps.forEach((p, c) => {
      expect(p.peak / at(amps, c)).toBeGreaterThan(1 - 1e-4);
      expect(p.peak / at(amps, c)).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.length).toBeGreaterThanOrEqual(470); // 60° / 0.125° = 480 samples (cos² tail below eps)
      expect(p.length).toBeLessThanOrEqual(481);
      const startEnd = at(cap.crank, p.start); // crank at the end of the pulse's first tick
      onsets.push(startEnd);
      expect(startEnd).toBeGreaterThan(139); // 140 − 1° jitter
      expect(startEnd).toBeLessThanOrEqual(141 + 2 * 0.125);
    });
    expect(Math.max(...onsets) - Math.min(...onsets)).toBeGreaterThan(1); // timing jitter present
    let minX = 0;
    for (let k = 0; k < x.length; k++) minX = Math.min(minX, at(x, k));
    expect(minX).toBeGreaterThan(-1e-9); // the raw pulses are one-sided
  });

  it('sharpens α with load: α_eff = α·(0.7 + 0.6·load) sets the time-to-peak', () => {
    for (const load of [0, 1]) {
      const cap = render(makeSource([0]), 1, 6 * 5760, { rpm: 1000, load });
      const ps = pulses(undc(at(cap.ex, 0)));
      expect(ps.length).toBe(6);
      const aEff = 9 * (0.7 + 0.6 * load);
      const phiPeak = Math.log1p((2 * aEff) / 4) / aEff; // peak of the squared form
      for (const p of ps) expect(Math.abs(p.peakIndex - p.start - phiPeak * 480)).toBeLessThanOrEqual(2);
    }
  });

  it('blocks DC per entry (10 Hz high-pass) and outputs exactly 0 before the first blowdown', () => {
    const cap = render(makeSource([0, 180, 360, 540]), 4, 2 * FS, { rpm: 3000, load: 0.8 });
    for (let i = 0; i < 4; i++) {
      const y = at(cap.ex, i);
      expect(at(y, 0)).toBe(0);
      const x = undc(y);
      let sumY = 0;
      let sumX = 0;
      for (let k = FS; k < 2 * FS; k++) {
        sumY += at(y, k);
        sumX += at(x, k);
      }
      expect(Math.abs(sumY / FS)).toBeLessThan(2e-3);
      expect(sumX / FS).toBeGreaterThan(0.02);
    }
  });

  it('writes 0 to the outputs of unused entries', () => {
    const src = makeSource([0, 360]);
    const exOut = new Float64Array(MAX_COMBUSTION).fill(7);
    const gateOut = new Float64Array(MAX_COMBUSTION).fill(7);
    src.tick(3000, 0.5, 1, exOut, gateOut);
    for (let i = 2; i < MAX_COMBUSTION; i++) {
      expect(at(exOut, i)).toBe(0);
      expect(at(gateOut, i)).toBe(0);
    }
  });

  it('is deterministic per seed and reset() replays the post-configure state bit-identically', () => {
    const opts: RenderOpts = { rpm: (k) => 1500 + k * 0.1, load: 0.6 };
    const a = makeSource([0, 180, 360, 540], 720, {}, 7);
    const first = render(a, 4, FS / 2, opts);
    a.reset();
    const again = render(a, 4, FS / 2, opts);
    const twin = render(makeSource([0, 180, 360, 540], 720, {}, 7), 4, FS / 2, opts);
    const other = render(makeSource([0, 180, 360, 540], 720, {}, 8), 4, FS / 2, opts);
    expect(again.ign).toEqual(first.ign);
    expect(twin.ign).toEqual(first.ign);
    expect(at(again.ex, 2)).toEqual(at(first.ex, 2));
    expect(at(twin.ex, 2)).toEqual(at(first.ex, 2));
    expect(other.ign).not.toEqual(first.ign);
  });
});

describe('CombustionSource: skipMask, cut type, pops (amendment B4)', () => {
  it('ignition cut: skipped firings emit no pulse and no impulse, and each counts one pop', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    expect(firings(cap.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) expect(allZero(at(cap.ex, i))).toBe(true);
    expect(src.takeIgnitionCutPops()).toBe(100);
    expect(src.takeIgnitionCutPops()).toBe(0); // consumed
    const resumed = render(src, 4, FS / 2, { rpm: 3000 });
    expect(firings(resumed.ign).length).toBe(50);
    expect(src.takeIgnitionCutPops()).toBe(0);
  });

  it('fuel cut (skipIsIgnition false): skipped firings emit no pulse, no impulse and no pops', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0xffff, ignitionCut: false });
    expect(firings(cap.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) expect(allZero(at(cap.ex, i))).toBe(true);
    expect(src.takeIgnitionCutPops()).toBe(0);
  });

  it('an alternating mask skips only the masked entries', () => {
    const src = makeSource([0, 180, 360, 540]);
    const cap = render(src, 4, FS, { rpm: 3000, mask: () => 0b0101, ignitionCut: true });
    expect(allZero(at(cap.ex, 0))).toBe(true);
    expect(allZero(at(cap.ex, 2))).toBe(true);
    expect(pulses(undc(at(cap.ex, 1))).length).toBe(25);
    expect(pulses(undc(at(cap.ex, 3))).length).toBe(25);
    expect(firings(cap.ign).length).toBe(50);
    expect(src.takeIgnitionCutPops()).toBe(50);
  });

  it('samples the mask at the firing angle: a firing already made still blows down', () => {
    // one entry at 0° and 3000 rpm: ignition on tick 0, blowdown ≈ 140°/0.375° ≈ 373 ticks later
    const late = makeSource([0]);
    const capLate = render(late, 1, 1920, { rpm: 3000, mask: (k) => (k >= 10 && k < 600 ? 1 : 0), ignitionCut: true });
    expect(pulses(undc(at(capLate.ex, 0))).length).toBe(1);
    expect(late.takeIgnitionCutPops()).toBe(0);
    const onTime = makeSource([0]);
    const capOn = render(onTime, 1, 1920, { rpm: 3000, mask: (k) => (k === 0 ? 1 : 0), ignitionCut: true });
    expect(allZero(at(capOn.ex, 0))).toBe(true);
    expect(onTime.takeIgnitionCutPops()).toBe(1);
  });

  it('reset() clears skipMask, skipIsIgnition and the pop counter', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, 4800, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    src.skipMask = 0xffff;
    src.skipIsIgnition = true;
    src.reset();
    expect(src.skipMask).toBe(0);
    expect(src.skipIsIgnition).toBe(false);
    expect(src.takeIgnitionCutPops()).toBe(0);
    expect(src.crankDeg).toBe(0);
  });
});

describe('CombustionSource: intake gates', () => {
  /** Position of `crank` relative to the nominal window start, in [0, cycle). */
  function relTo(crank: number, start: number, cycle: number): number {
    return (((crank - start) % cycle) + cycle) % cycle;
  }

  it('4-stroke gate: 1 over angle + 360 + [−10, 230]° with 10° raised-cosine edges centred on the boundaries', () => {
    // angles 10 and 250 put both nominal boundaries (angle + 350, angle + 590) on the 0.375° crank grid
    for (const angle of [10, 250]) {
      const cap = render(makeSource([angle]), 1, 3 * 1920, { rpm: 3000 }); // 3 cycles
      const g = at(cap.gate, 0);
      let sum = 0;
      let boundaryHits = 0;
      for (let k = 0; k < g.length; k++) {
        const v = at(g, k);
        const r = relTo(at(cap.crank, k), angle + 350, 720);
        sum += v;
        if (r >= 5 && r < 235) expect(v).toBe(1);
        else if (r >= 245 && r < 715) expect(v).toBe(0);
        else {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        if (Math.abs(r - 0) < 1e-9 || Math.abs(r - 240) < 1e-9) {
          boundaryHits++;
          expect(v).toBeCloseTo(0.5, 12);
        }
      }
      expect(sum / g.length).toBeCloseTo(240 / 720, 3); // area = window length
      expect(boundaryHits).toBe(6); // 3 cycles × 2 nominal boundaries
    }
  });

  it('rotary gate: 1 over angle + [60, 300]°, independent of the skip mask', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const pulse: PulseOpts = { widthDeg: 300, evoOffsetDeg: 200 };
    const cap = render(makeSource(angles, 1080, pulse), 6, 2 * 2880, { rpm: 3000 });
    angles.forEach((angle, i) => {
      const g = at(cap.gate, i);
      let sum = 0;
      for (let k = 0; k < g.length; k++) {
        const r = relTo(at(cap.crank, k), angle + 60, 1080);
        sum += at(g, k);
        if (r >= 5 && r < 235) expect(at(g, k)).toBe(1);
        else if (r >= 245 && r < 1075) expect(at(g, k)).toBe(0);
      }
      expect(sum / g.length).toBeCloseTo(240 / 1080, 3);
    });
    const masked = render(makeSource(angles, 1080, pulse), 6, 2 * 2880, { rpm: 3000, mask: () => 0xffff, ignitionCut: true });
    for (let i = 0; i < 6; i++) expect(at(masked.gate, i)).toEqual(at(cap.gate, i));
  });
});

describe('CombustionSource: rotary (cycleDeg 1080)', () => {
  it('fires each face once per 1080° (2 firings per e-shaft rev) with pulses up to 300° long', () => {
    const angles = [0, 360, 720, 180, 540, 900];
    const src = makeSource(angles, 1080, { widthDeg: 300, evoOffsetDeg: 200 });
    const revs = 30; // 3000 rpm → 0.375°/sample → 960 samples per rev
    const cap = render(src, 6, revs * 960, { rpm: 3000 });
    expect(firings(cap.ign).length).toBe(2 * revs);
    for (let i = 0; i < 6; i++) {
      const ps = pulses(undc(at(cap.ex, i)));
      expect(ps.length).toBeGreaterThanOrEqual(9); // 10 cycles; the last may be cut off by the render end
      for (const p of ps.slice(0, -1)) {
        expect(p.length).toBeGreaterThanOrEqual(780); // 300° / 0.375° = 800 samples (tail below eps)
        expect(p.length).toBeLessThanOrEqual(801);
      }
    }
  });

  it('clamps 4-stroke pulses to 180° but lets rotary pulses reach 300°', () => {
    const four = render(makeSource([0], 720, { widthDeg: 300 }), 1, 2 * 1920, { rpm: 3000 });
    for (const p of pulses(undc(at(four.ex, 0)))) expect(p.length).toBeLessThanOrEqual(481); // 180° / 0.375°
  });
});

describe('CombustionSource: robustness (RF2, RF3)', () => {
  it('RF2: rpm 0 from reset → no firings, no pulses, crank frozen; rpm 50 stays finite', () => {
    const src = makeSource([0, 180, 360, 540]);
    const stopped = render(src, 4, FS, { rpm: 0 });
    expect(src.crankDeg).toBe(0);
    expect(firings(stopped.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) {
      expect(allZero(at(stopped.ex, i))).toBe(true);
      expect(allFinite(at(stopped.gate, i))).toBe(true);
    }
    expect(src.takeIgnitionCutPops()).toBe(0);
    const slow = render(src, 4, 2.5 * FS, { rpm: 50 }); // 0.00625°/sample → 750° in 2.5 s
    expect(src.crankDeg).toBeCloseTo(750 - 720, 6);
    expect(firings(slow.ign).length).toBe(5); // 0, 180, 360, 540, 720 ≡ 0
    expect(allFinite(slow.ign)).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(allFinite(at(slow.ex, i))).toBe(true);
      expect(allFinite(at(slow.gate, i))).toBe(true);
    }
  });

  it('RF2: running → rpm 0 → crank frozen, no firings, outputs decay to 0 and stay finite; then 50 rpm', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, FS / 2, { rpm: 4000, load: 1 });
    const frozenAt = src.crankDeg;
    const hold = render(src, 4, FS / 2, { rpm: 0 });
    expect(src.crankDeg).toBe(frozenAt);
    expect(firings(hold.ign).length).toBe(0);
    for (let i = 0; i < 4; i++) {
      const y = at(hold.ex, i);
      expect(allFinite(y)).toBe(true);
      expect(Math.abs(at(y, y.length - 1))).toBeLessThan(1e-9);
    }
    const resumed = render(src, 4, FS / 2, { rpm: 50 });
    for (let i = 0; i < 4; i++) expect(allFinite(at(resumed.ex, i))).toBe(true);
  });

  it('RF2: NaN / negative / ±Infinity rpm and NaN load or gain never produce NaN or Infinity', () => {
    const src = makeSource([0, 180, 360, 540]);
    render(src, 4, 4800, { rpm: 3000 });
    const crank = src.crankDeg;
    const badRpm = [Number.NaN, -500, Number.NEGATIVE_INFINITY];
    const bad = render(src, 4, 4800, { rpm: (k) => at(badRpm, k % 3), load: Number.NaN, gain: Number.NaN });
    expect(src.crankDeg).toBe(crank);
    expect(allFinite(bad.ign)).toBe(true);
    for (let i = 0; i < 4; i++) expect(allFinite(at(bad.ex, i))).toBe(true);
    const fast = render(src, 4, 4800, { rpm: Number.POSITIVE_INFINITY, load: Number.NaN, gain: 1 });
    expect(src.crankDeg).toBeCloseTo((crank + 4800 * RPM_CEIL * (6 / FS)) % 720, 6);
    expect(allFinite(fast.ign)).toBe(true);
    for (let i = 0; i < 4; i++) expect(allFinite(at(fast.ex, i))).toBe(true);
  });

  it('RF3: 12000 rpm on a 9000-redline V8 stays finite and keeps time-to-peak ≥ 4 samples', () => {
    const angles = [0, 90, 180, 270, 360, 450, 540, 630];
    const { spec, voicing } = makeEngine(angles, 720, { widthDeg: 40, alpha: 40, beta: 4 });
    spec.rpm.redline = 9000;
    spec.rpm.limiter.rpm = 9100;
    const src = new CombustionSource(FS);
    src.configure(spec, voicing, 1);
    // 12000 rpm → 1.5°/sample → a 40° pulse spans 26.7 samples; unclamped α_eff = 52 would peak ≈ 1.7 samples in
    const cap = render(src, 8, 2 * FS, { rpm: 12000, load: 1 });
    const amps = firings(cap.ign).map((k) => at(cap.ign, k));
    expect(amps.length).toBe(1600);
    expect(allFinite(cap.ign)).toBe(true);
    const maxAmp = Math.max(...amps);
    expect(maxAmp).toBeLessThanOrEqual(1.05 + 1e-12);
    for (let i = 0; i < 8; i++) {
      const y = at(cap.ex, i);
      expect(allFinite(y)).toBe(true);
      const ps = pulses(undc(y));
      expect(ps.length).toBeGreaterThanOrEqual(199);
      for (const p of ps) {
        expect(p.peakIndex - p.start).toBeGreaterThanOrEqual(4);
        expect(p.peak).toBeLessThanOrEqual(maxAmp + 1e-9);
      }
    }
  });
});
