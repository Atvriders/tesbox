import { describe, expect, it } from 'vitest';
import type { OutputConfig, Subwoofer } from '../../src/contracts';
import { OutputStage, OUTPUT_CEILING } from '../../src/dsp/output-stage';
import { Upsampler4 } from '../../src/dsp/oversample';
import { dbToGain } from '../../src/dsp/util';

const FS = 48000;
const Q = 128;
const LOOKAHEAD = Math.round(0.0015 * FS); // 72 samples

function stage(subwoofer: Subwoofer = 'yes', hpCornerHz = 40, volumeTrimDb = 0, fs = FS): OutputStage {
  const s = new OutputStage(fs);
  const cfg: OutputConfig = { subwoofer, hpCornerHz, volumeTrimDb };
  s.configure(cfg);
  return s;
}

/** Runs a stereo signal through the stage in 128-frame quanta; trim per quantum (constant or a function of the quantum index). */
function run(
  s: OutputStage,
  n: number,
  srcL: (i: number) => number,
  srcR: (i: number) => number = srcL,
  trimDb: number | ((q: number) => number) = 0,
): { l: Float64Array; r: Float64Array } {
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let q = 0; q * Q < n; q++) {
    const frames = Math.min(Q, n - q * Q);
    s.beginQuantum(typeof trimDb === 'number' ? trimDb : trimDb(q), frames);
    for (let k = 0; k < frames; k++) {
      const i = q * Q + k;
      s.process(srcL(i), srcR(i));
      l[i] = s.l;
      r[i] = s.r;
    }
  }
  return { l, r };
}

/**
 * Independent 4× true peak (linear) of one channel over samples [from, end). The upsampler is fed
 * from index 0 so it is warm at `from`; no zero padding after the end (an abrupt cut would add a
 * Gibbs overshoot that is not in the signal).
 */
function truePeak(x: Float64Array, from = 0): number {
  const up = new Upsampler4();
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    up.push(v);
    if (i < from) continue;
    p = Math.max(p, Math.abs(v));
    for (const o of up.out) p = Math.max(p, Math.abs(o));
  }
  return p;
}

function maxAbs(x: Float64Array, from = 0, to = x.length): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i] ?? 0));
  return p;
}

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel). */
function toneAmp(x: Float64Array, f: number, from: number, fs = FS): number {
  const n = x.length - from;
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[from + i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

const sine = (f: number, amp: number, fs = FS) => (i: number) => amp * Math.sin((2 * Math.PI * f * i) / fs);
const db = (g: number): number => 20 * Math.log10(g);

describe('OutputStage — trim, guard, latency', () => {
  it('delays by the 1.5 ms look-ahead and passes quiet audio at unity (sub mode)', () => {
    const { l } = run(stage('yes'), 400, (i) => (i === 0 ? 0.5 : 0));
    let at = -1;
    for (let i = 0; i < 400; i++) if (Math.abs(l[i] ?? 0) === maxAbs(l)) at = i;
    expect(at).toBe(LOOKAHEAD);
    expect(l[LOOKAHEAD]).toBeCloseTo(0.5, 2);
    expect(maxAbs(l, 0, LOOKAHEAD)).toBe(0);
  });

  it('ramps the trim linearly across the quantum, reaching the target on its last sample', () => {
    // Below the compressor knee the chain after the trim is linear time-invariant, so the trimmed
    // stage must equal a 0 dB stage fed with the input pre-multiplied by the expected ramp.
    const x = sine(3000, 0.01);
    const g6 = dbToGain(6);
    const gain = (i: number): number => (i < Q ? 1 : i < 2 * Q ? 1 + (g6 - 1) * ((i - Q + 1) / Q) : g6);
    const a = run(stage('yes'), 6 * Q, x, x, (q) => (q === 0 ? 0 : 6));
    const b = run(stage('yes'), 6 * Q, (i) => x(i) * gain(i));
    for (let i = 0; i < 6 * Q; i++) expect(a.l[i] ?? NaN).toBeCloseTo(b.l[i] ?? NaN, 12);
  });

  it('clamps trim to +6 dB and keeps the previous trim for NaN', () => {
    const x = sine(3000, 0.01);
    const ref = run(stage('yes', 40, 6), 4 * Q, x, x, 6);
    const hi = run(stage('yes', 40, 6), 4 * Q, x, x, 20);
    const nan = run(stage('yes', 40, 6), 4 * Q, x, x, (q) => (q === 0 ? 6 : NaN));
    expect(Array.from(hi.l)).toEqual(Array.from(ref.l));
    expect(Array.from(nan.l)).toEqual(Array.from(ref.l));
  });

  it('configure() snaps the trim to volumeTrimDb: the first quantum does not ramp', () => {
    const x = sine(3000, 0.01);
    const g6 = dbToGain(6);
    const a = run(stage('yes', 40, 6), 4 * Q, x, x, 6);
    const b = run(stage('yes', 40, 0), 4 * Q, (i) => x(i) * g6);
    for (let i = 0; i < 4 * Q; i++) expect(a.l[i] ?? NaN).toBeCloseTo(b.l[i] ?? NaN, 12);
  });

  it('reset() completes a trim ramp in progress', () => {
    const x = sine(3000, 0.01);
    const a = stage('yes', 40, 0);
    a.beginQuantum(6, Q);
    for (let i = 0; i < 10; i++) a.process(x(i), x(i)); // 10 samples into a 0 → +6 dB ramp
    a.reset();
    const b = stage('yes', 40, 6);
    for (let i = 0; i < 300; i++) {
      a.process(x(i), x(i));
      b.process(x(i), x(i));
      expect(a.l).toBeCloseTo(b.l, 12);
    }
  });

  it('guards NaN / ±Infinity / |x| > 1e6 per channel, counts them, and keeps running (multi-call)', () => {
    const s = stage('no');
    const bad = [NaN, Infinity, -Infinity, 2e6];
    const out = run(s, 4 * Q, (i) => (i < bad.length ? (bad[i] ?? 0) : 0.1 * Math.sin(i / 7)), () => 0);
    expect(s.nonFiniteCount).toBe(4);
    expect(out.l.every((v) => Number.isFinite(v))).toBe(true);
    run(s, Q, () => NaN, () => NaN);
    expect(s.nonFiniteCount).toBe(4 + 2 * Q);
    const after = run(s, FS / 2, sine(1000, 0.1));
    expect(after.l.every((v) => Number.isFinite(v))).toBe(true);
    expect(toneAmp(after.l, 1000, FS / 4)).toBeCloseTo(0.1, 2);
  });

  it('blocks DC in both bass modes', () => {
    for (const sub of ['yes', 'no'] as const) {
      const { l } = run(stage(sub), FS, () => 0.5);
      expect(maxAbs(l, FS / 2)).toBeLessThan(1e-3);
    }
  });
});

describe('OutputStage — bass management', () => {
  it("subwoofer 'yes': only a 22 Hz 2nd-order HP (30 Hz ≈ −1 dB, 10 Hz < −12 dB)", () => {
    const a30 = toneAmp(run(stage('yes'), 2 * FS, sine(30, 0.1)).l, 30, FS);
    expect(a30 / 0.1).toBeGreaterThan(0.84);
    expect(a30 / 0.1).toBeLessThan(0.95);
    const a10 = toneAmp(run(stage('yes'), 4 * FS, sine(10, 0.1)).l, 10, 2 * FS);
    expect(a10 / 0.1).toBeLessThan(0.25);
  });

  it("'no' / 'unsure': 4th-order HP at the corner (2×corner ≈ 0 dB, ½·corner ≈ −24 dB)", () => {
    for (const sub of ['no', 'unsure'] as const) {
      const a80 = toneAmp(run(stage(sub, 40), FS, sine(80, 0.1)).l, 80, FS / 2);
      expect(db(a80 / 0.1)).toBeCloseTo(0, 0);
      const a20 = toneAmp(run(stage(sub, 40), 2 * FS, sine(20, 0.1)).l, 20, FS);
      expect(db(a20 / 0.1)).toBeLessThan(-20);
    }
  });

  it('adds NLD virtual bass: 2nd + 3rd harmonics of the removed band (absent with a sub)', () => {
    const x = sine(25, 0.1);
    const noSub = run(stage('no', 40), 3 * FS, x).l;
    const sub = run(stage('yes'), 3 * FS, x).l;
    for (const h of [50, 75]) {
      expect(toneAmp(noSub, h, FS)).toBeGreaterThan(0.1 * 0.1);
      expect(toneAmp(sub, h, FS)).toBeLessThan(1e-5);
    }
  });

  it('scales virtual bass by 0.5·(1 − clamp((trimDb + 12)/18, 0, 1)·0.5) (equal loudness)', () => {
    const x = sine(25, 0.05);
    const h3 = (trimDb: number): number => toneAmp(run(stage('no', 40), 3 * FS, x, x, trimDb).l, 75, FS) / dbToGain(trimDb);
    const at0 = h3(0); // gain 1/3
    expect(h3(-12) / at0).toBeCloseTo(1.5, 1); // gain 0.5
    expect(h3(-20) / at0).toBeCloseTo(1.5, 1); // clamped at 0.5
    expect(h3(6) / at0).toBeCloseTo(0.75, 1); // gain 0.25
  });

  it('clamps hpCornerHz to 30–60 Hz and maps non-finite to 40 Hz', () => {
    const x = (i: number): number => 0.2 * Math.sin(i / 200) + 0.1 * Math.sin(i / 37);
    const same = (a: number, b: number): void => {
      expect(Array.from(run(stage('no', a), 4 * Q, x).l)).toEqual(Array.from(run(stage('no', b), 4 * Q, x).l));
    };
    same(100, 60);
    same(10, 30);
    same(NaN, 40);
  });
});

describe('OutputStage — dynamics', () => {
  it('compresses 3:1 above −12 dBFS with a 6 dB soft knee (linked, no make-up)', () => {
    const peakDb = (inDb: number): number => db(maxAbs(run(stage('yes'), FS, sine(1000, dbToGain(inDb))).l, FS / 2));
    expect(Math.abs(peakDb(0) + 8)).toBeLessThan(0.3); // −12 + 12/3
    expect(Math.abs(peakDb(-12) + 12.5)).toBeLessThan(0.2); // knee centre: −0.5 dB
    expect(Math.abs(peakDb(-20) + 20)).toBeLessThan(0.05); // below the knee: unity
    // Linked: a loud channel also turns the quiet one down by the same gain, from either side.
    const { r } = run(stage('yes'), FS, sine(1000, 1), sine(1000, 0.01));
    expect(Math.abs(db(maxAbs(r, FS / 2) / 0.01) + 8)).toBeLessThan(0.3);
    const { l } = run(stage('yes'), FS, sine(1000, 0.01), sine(1000, 1));
    expect(Math.abs(db(maxAbs(l, FS / 2) / 0.01) + 8)).toBeLessThan(0.3);
  });

  it('attacks in ≈ 5 ms and releases in ≈ 120 ms (multi-call)', () => {
    const s = stage('yes');
    run(s, FS / 2, sine(1000, 0.01));
    const loud = run(s, FS / 2, sine(1000, 1));
    expect(Math.abs(db(maxAbs(loud.l, (30 * FS) / 1000, (40 * FS) / 1000)) + 8)).toBeLessThan(1);
    const quiet = run(s, FS, sine(1000, 0.01));
    expect(db(maxAbs(quiet.l, FS / 20, FS / 20 + 100) / 0.01)).toBeLessThan(-3); // still recovering at 50 ms
    expect(Math.abs(db(maxAbs(quiet.l, (6 * FS) / 10, (7 * FS) / 10) / 0.01))).toBeLessThan(0.3); // recovered
  });

  it('reports limiter gain reduction and the output true peak; takeTruePeak() resets it', () => {
    // +26 dBFS after trim: the compressor alone leaves ≈ +0.7 dBFS, so the limiter must hold ≈ 2 dB.
    const s = stage('yes');
    run(s, FS / 2, sine(997, 10), sine(997, 10), 6);
    expect(s.gainReductionDb).toBeGreaterThan(1);
    const tp = s.takeTruePeak();
    expect(tp).toBeLessThanOrEqual(-1.0);
    expect(tp).toBeGreaterThan(-3);
    run(s, 2 * FS, () => 0); // the delayed tail of the loud passage comes out here
    expect(s.gainReductionDb).toBe(0);
    expect(s.takeTruePeak()).toBeLessThanOrEqual(-1.0);
    run(s, FS / 2, () => 0);
    expect(s.truePeakDbtp).toBeLessThan(-100);
  });

  it('releases the limiter with a 50 ms time constant once the look-ahead hold has passed (multi-call)', () => {
    const s = stage('yes', 40, 6);
    run(s, FS / 2, sine(997, 10), sine(997, 10), 6); // ≈ 2 dB of limiting, as above
    expect(s.gainReductionDb).toBeGreaterThan(1);
    const gain = (): number => dbToGain(-s.gainReductionDb);
    run(s, 0.025 * FS, () => 0, () => 0, 6); // far past the hold (D + 2 samples) and the average (D − 8)
    const g1 = gain();
    run(s, 0.05 * FS, () => 0, () => 0, 6);
    const g2 = gain();
    // One-pole release (the moving average of an exponential stays exponential): 1 − g falls by
    // e^(−Δt/τ), so Δt = 50 ms gives τ = Δt / ln((1 − g1)/(1 − g2)).
    expect(0.05 / Math.log((1 - g1) / (1 - g2))).toBeCloseTo(0.05, 3);
  });

  it('meters the output true peak to within 0.1 dB of an independent 4× measurement near the ceiling', () => {
    for (const [f, amp] of [
      [997, 10],
      [5000, 3],
      [15000, 10],
    ] as const) {
      const s = stage('yes', 40, 6);
      const half = 188; // quanta (≈ 0.5 s): the meter window is everything after it
      const { l, r } = run(
        s,
        2 * half * Q,
        sine(f, amp),
        sine(1.01 * f, amp),
        (q) => {
          if (q === half) s.takeTruePeak();
          return 6;
        },
      );
      const independent = db(Math.max(truePeak(l, half * Q), truePeak(r, half * Q)));
      expect(Math.abs(s.truePeakDbtp - independent)).toBeLessThan(0.1);
    }
  });

  it('meters inter-sample peaks that no sample reaches (fs/4 tone at 45°)', () => {
    // Every sample sits at ±0.707 of the true peak, so a sample-peak meter would read ≈ 3 dB low.
    const x = (i: number): number => 3 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const s = stage('yes', 40, 6);
    const half = 188;
    const { l, r } = run(s, 2 * half * Q, x, x, (q) => {
      if (q === half) s.takeTruePeak();
      return 6;
    });
    const independent = db(Math.max(truePeak(l, half * Q), truePeak(r, half * Q)));
    expect(db(Math.max(maxAbs(l, half * Q), maxAbs(r, half * Q)))).toBeLessThan(independent - 2);
    expect(Math.abs(s.truePeakDbtp - independent)).toBeLessThan(0.1);
  });

  it('quiet skip is exact: bit-identical to a stage that runs the 4× detector on every sample', () => {
    // Bursts plus isolated spikes: a wrong replay length or hold count changes the limiter gain somewhere.
    const srcL = (i: number): number =>
      i % 997 === 500 ? 5000 : (i % 2400 < 2160 ? 0.05 : 4) * Math.sin((2 * Math.PI * 3001 * i) / FS);
    const srcR = (i: number): number =>
      i % 1499 === 7 ? -8000 : (i % 1900 < 1500 ? 0.1 : -3) * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    for (const sub of ['yes', 'no'] as const) {
      const skipping = stage(sub, 40, 6);
      const always = stage(sub, 40, 6);
      // White-box: the quiet-skip threshold (≈ −5.3 dBFS). −1 makes every sample loud, so nothing is skipped.
      const skipInternals = skipping as unknown as { quietLevel: number };
      const alwaysInternals = always as unknown as { quietLevel: number };
      expect(skipInternals.quietLevel).toBeGreaterThan(0.2); // the quiet stretches below really are skipped
      alwaysInternals.quietLevel = -1;
      const a = run(skipping, FS, srcL, srcR, 6);
      const b = run(always, FS, srcL, srcR, 6);
      let mismatches = 0;
      for (let i = 0; i < FS; i++) if (a.l[i] !== b.l[i] || a.r[i] !== b.r[i]) mismatches++;
      expect(mismatches).toBe(0);
    }
  });

  it('reset() clears every buffer, envelope and meter', () => {
    const s = stage('no');
    run(s, FS / 4, sine(50, 1), sine(70, 1), 6);
    s.reset();
    expect(s.truePeakDbtp).toBe(-200);
    expect(s.gainReductionDb).toBe(0);
    const { l, r } = run(s, 1000, () => 0);
    expect(l.every((v) => v === 0) && r.every((v) => v === 0)).toBe(true);
  });
});

describe('OutputStage — RF4: true-peak ceiling at +6 dB trim', () => {
  const n = 2 * FS;
  const square = (f: number) => (i: number) => (Math.sin((2 * Math.PI * f * i) / FS) >= 0 ? 1 : -1);
  const squareish = (f: number) => (i: number) => Math.tanh(5 * Math.sin((2 * Math.PI * f * i) / FS)) / Math.tanh(5);
  const sweep = (f0: number, f1: number) => (i: number) => {
    const t = i / FS;
    const k = Math.log(f1 / f0) / (n / FS);
    return Math.sin(((2 * Math.PI * f0) / k) * (Math.exp(k * t) - 1));
  };
  const quarterFs45 = (i: number) => Math.sin((Math.PI / 2) * i + Math.PI / 4); // samples ±0.707, true peak 1
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const cases: [string, (i: number) => number, (i: number) => number][] = [
    ['naive full-scale square 441 Hz', square(441), square(441)],
    ['square-ish (tanh) 60 Hz, R inverted', squareish(60), (i) => -squareish(60)(i)],
    ['log sine sweep 20 Hz → 20 kHz', sweep(20, 20000), sweep(20, 20000)],
    ['log sine sweep 5 kHz → 23 kHz', sweep(5000, 23000), sweep(23000, 5000)],
    ['fs/4 tone at 45° (+3 dB inter-sample peaks)', quarterFs45, quarterFs45],
    ['full-scale white noise', () => noise(), () => noise()],
    // 45 ms quiet / 5 ms loud bursts: exercises the limiter's exact quiet-skip and history replay.
    ['quiet ↔ loud bursts', (i) => (i % 2400 < 2160 ? 0.05 : 4) * square(3001)(i), (i) => (i % 2400 < 2160 ? 0.05 : -4) * quarterFs45(i)],
  ];
  for (const sub of ['yes', 'no'] as const) {
    for (const [name, srcL, srcR] of cases) {
      it(`${name} (subwoofer ${sub}): ≤ −1.0 dBTP and no sample above 0.8913`, () => {
        const s = stage(sub, 40, 6);
        const { l, r } = run(s, n, srcL, srcR, 6);
        expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING);
        expect(maxAbs(r)).toBeLessThanOrEqual(OUTPUT_CEILING);
        const tp = db(Math.max(truePeak(l), truePeak(r)));
        expect(tp).toBeLessThanOrEqual(-1.0);
        // Not muted. Every case peaks at the −1.3 dBTP limiter target except the 20 Hz → 20 kHz
        // sweep, which is never limited: the compressor alone holds it at ≈ −5.9 dBTP (≈ −4.6 with
        // no sub). A muting or stuck limiter reads far lower.
        expect(tp).toBeGreaterThan(-9);
        expect(s.truePeakDbtp).toBeLessThanOrEqual(-1.0);
      });
    }
  }

  it('holds at 44.1 kHz too (sweep + square)', () => {
    const fs = 44100;
    const s = stage('no', 40, 6, fs);
    const src = (i: number): number => 0.5 * Math.sin((2 * Math.PI * 30 * i) / fs) + (Math.sin((2 * Math.PI * 3001 * i) / fs) >= 0 ? 0.5 : -0.5);
    const { l, r } = run(s, 2 * fs, src, (i) => Math.sin((2 * Math.PI * (200 + i / 10) * i) / fs), 6);
    expect(maxAbs(l)).toBeLessThanOrEqual(OUTPUT_CEILING);
    expect(db(Math.max(truePeak(l), truePeak(r)))).toBeLessThanOrEqual(-1.0);
  });
});
