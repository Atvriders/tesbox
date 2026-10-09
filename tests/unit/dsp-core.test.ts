import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION, MAX_SAMPLE_RATE, QUANTUM, type EngineDef, type OutputConfig } from '../../src/contracts';
import { rmsDb } from '../../src/dsp/analysis';
import { MIN_SAMPLE_RATE, TesboxDspCore, assertEngineFits } from '../../src/dsp/dsp-core';
import {
  CoreHarness,
  FS,
  OUT_SUB,
  allFinite,
  bitIdentical,
  countBufferConstructions,
  internals,
  loadFixture,
  makeCtl,
  maxStep,
  peakAbs,
  peakDb,
  slice,
} from './helpers/dsp-harness';

/** Lowest RMS (dB) over consecutive 10 ms windows. */
function minWindowRmsDb(sig: Float32Array): number {
  const w = Math.round(0.01 * FS);
  let m = Infinity;
  for (let i = 0; i + w <= sig.length; i += w) m = Math.min(m, rmsDb(sig.subarray(i, i + w)));
  return m;
}

/** PerspectiveMixer crossfade position (T7's private `w`): 0 = cabin, 1 = outside. */
function mixPosition(core: TesboxDspCore): number {
  return (internals(core).perspective as unknown as { w: number }).w;
}

describe('TesboxDspCore basics', () => {
  it('outputs silence before configure and rejects sample rates outside [28000, 48000] by name', () => {
    const core = new TesboxDspCore(FS);
    const l = new Float32Array(QUANTUM).fill(1);
    const r = new Float32Array(QUANTUM).fill(1);
    core.render(makeCtl(3000, 0.5), l, r, QUANTUM, 0);
    expect(peakAbs(l)).toBe(0);
    expect(peakAbs(r)).toBe(0);
    expect(MIN_SAMPLE_RATE).toBe(28000);
    for (const fs of [96000, MAX_SAMPLE_RATE + 1, 0, -48000, 22050, MIN_SAMPLE_RATE - 1, Number.NaN]) {
      // the core itself rejects the rate (amendment B3), not a nested module with its own message
      expect(() => new TesboxDspCore(fs), String(fs)).toThrow(RangeError);
      expect(() => new TesboxDspCore(fs), String(fs)).toThrow(/^TesboxDspCore: fs/);
    }
    expect(() => new TesboxDspCore(MIN_SAMPLE_RATE)).not.toThrow();
    expect(() => new TesboxDspCore(MAX_SAMPLE_RATE)).not.toThrow();
  });

  it('configure() rejects engines the core cannot run, before touching any state', { timeout: 30_000 }, () => {
    const base = loadFixture('i4-test');
    const bad: [string, (d: EngineDef) => void][] = [
      ['more than MAX_COMBUSTION entries', (d) => {
        d.spec.combustion = Array.from({ length: MAX_COMBUSTION + 1 }, (_, i) => ({ angleDeg: i * 40, bank: 0 }));
        d.voicing.headersM = d.spec.combustion.map(() => 0.6);
      }],
      ['headersM count ≠ combustion count', (d) => void d.voicing.headersM.pop()],
      ['header > 1.5 m', (d) => void (d.voicing.headersM[0] = 1.6)],
      ['collector > 1.0 m', (d) => void (d.voicing.collectors.forEach((c) => (c.lengthM = 1.1)))],
      ['mid-pipe > 3.0 m', (d) => void (d.voicing.exhaust.midPipeM = 3.1)],
      ['no muffler section', (d) => void (d.voicing.exhaust.mufflerSectionsM = [])],
      ['5 muffler sections', (d) => void (d.voicing.exhaust.mufflerSectionsM = [0.2, 0.2, 0.2, 0.2, 0.2])],
      ['muffler section > 0.8 m', (d) => void (d.voicing.exhaust.mufflerSectionsM[0] = 0.9)],
      ['tailpipe > 1.2 m', (d) => void (d.voicing.exhaust.tailpipeM = 1.3)],
      ['section < 4 samples at 700 m/s', (d) => void (d.voicing.exhaust.tailpipeM = 0.05)],
      ['NaN length', (d) => void (d.voicing.exhaust.midPipeM = Number.NaN)],
      ['bank 16 (outside 0…15)', (d) => void (d.spec.combustion[1] = { angleDeg: 540, bank: 16 })],
      ['bank 20 (outside 0…15)', (d) => void (d.spec.combustion[1] = { angleDeg: 540, bank: 20 })],
      ['negative bank', (d) => void (d.spec.combustion[1] = { angleDeg: 540, bank: -1 })],
      ['non-integer bank', (d) => void (d.spec.combustion[1] = { angleDeg: 540, bank: 1.5 })],
      ['no collector', (d) => void (d.voicing.collectors = [])],
      ['9 collectors', (d) => void (d.voicing.collectors = Array.from({ length: 9 }, () => ({ banks: [0], lengthM: 0.3 })))],
      // runtime data that bypassed the types (e.g. JSON posted to the worklet)
      ['length given as a string', (d) => void ((d.voicing.exhaust as unknown as Record<string, unknown>).tailpipeM = '0.5')],
      ['collector without a banks list', (d) => void delete (d.voicing.collectors[0] as { banks?: number[] }).banks],
      ['missing limiter block', (d) => void delete (d.spec.rpm as { limiter?: unknown }).limiter],
      ['missing forcedInduction (turbo)', (d) => void delete (d.voicing as { forcedInduction?: unknown }).forcedInduction],
      ['missing cabin block', (d) => void delete (d.voicing as { cabin?: unknown }).cabin],
    ];
    const defs = bad.map(([label, mutate]) => {
      const d = structuredClone(base);
      mutate(d);
      return [label, d] as const;
    });
    for (const [label, d] of defs) {
      expect(() => assertEngineFits(d, FS), label).toThrow(RangeError);
      expect(() => new TesboxDspCore(FS).configure(d, OUT_SUB, 'full'), label).toThrow(RangeError);
    }
    expect(() => assertEngineFits(base, FS)).not.toThrow();

    // A running core keeps playing its engine when a bad swap is requested: no fade-out starts and no
    // queued swap can throw later from inside render() (0.35 s > the 300 ms fade-out).
    const h = new CoreHarness(base);
    const ctl = makeCtl(3000, 0.5);
    h.run(0.3, ctl);
    const broken = structuredClone(base);
    broken.voicing.exhaust.tailpipeM = 5;
    expect(() => h.core.configure(broken, OUT_SUB, 'full')).toThrow(RangeError);
    const after = h.run(0.5, ctl);
    expect(internals(h.core).def).toBe(base);
    expect(minWindowRmsDb(after.left)).toBeGreaterThan(-60);
    for (const [label, d] of defs) {
      expect(() => h.core.configure(d, OUT_SUB, 'full'), label).toThrow(RangeError);
      expect(() => h.run(0.35, ctl), label).not.toThrow();
      expect(internals(h.core).def, label).toBe(base);
    }
    expect(minWindowRmsDb(h.run(0.2, ctl).left)).toBeGreaterThan(-60);
  });

  it('renders finite, audible stereo and a live exhaust bus', () => {
    const h = new CoreHarness(loadFixture('i4-test'));
    const out = h.run(1, makeCtl(3000, 0.5));
    expect(allFinite(out.left) && allFinite(out.right) && allFinite(out.exhaust)).toBe(true);
    expect(rmsDb(slice(out.left, 0.5, 1))).toBeGreaterThan(-60);
    expect(rmsDb(slice(out.right, 0.5, 1))).toBeGreaterThan(-60);
    expect(rmsDb(slice(out.exhaust, 0.5, 1))).toBeGreaterThan(-80);
    expect(peakAbs(out.left)).toBeLessThanOrEqual(0.8913);
  });

  it('splits frames > 128 into quanta exactly like separate 128-frame calls', () => {
    const def = loadFixture('v8-crossplane-test');
    const ctl = makeCtl(4000, 0.6);
    const a = new TesboxDspCore(FS, 7);
    const b = new TesboxDspCore(FS, 7);
    a.configure(def, OUT_SUB, 'full');
    b.configure(def, OUT_SUB, 'full');
    const n = 3 * QUANTUM;
    const al = new Float32Array(n);
    const ar = new Float32Array(n);
    const bl = new Float32Array(n);
    const br = new Float32Array(n);
    const ql = new Float32Array(QUANTUM);
    const qr = new Float32Array(QUANTUM);
    for (let block = 0; block < 20; block++) {
      const t = block * n * (1 / FS);
      a.render(ctl, al, ar, n, t);
      for (let q = 0; q < 3; q++) {
        b.render(ctl, ql, qr, QUANTUM, t + q * QUANTUM * (1 / FS));
        bl.set(ql, q * QUANTUM);
        br.set(qr, q * QUANTUM);
      }
      expect(bitIdentical(al, bl) && bitIdentical(ar, br)).toBe(true);
    }
  });
});

describe('TesboxDspCore configure / fades', () => {
  it('RF1: engine change, then tier change, while rendering → 300 ms fades, no NaN, no buffer allocation, no step > 0.1 FS', { timeout: 60_000 }, () => {
    const v8 = loadFixture('v8-crossplane-test');
    const i4 = loadFixture('i4-test');
    const out: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: -6 };
    const core = new TesboxDspCore(FS, 1);
    core.configure(v8, out, 'full');
    core.forceHot();
    const ctl = makeCtl(2000, 0.3);
    const quanta = Math.round((4 * FS) / QUANTUM);
    const qEngine = Math.round((1 * FS) / QUANTUM); // t = 1.0 s
    const qTier = Math.round((2 * FS) / QUANTUM); // t = 2.0 s
    const left = new Float32Array(quanta * QUANTUM);
    const right = new Float32Array(quanta * QUANTUM);
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    let constructed = 0;
    let uninstall: (() => void) | null = null;
    try {
      for (let q = 0; q < quanta; q++) {
        if (q === qEngine) {
          uninstall = countBufferConstructions(() => {
            constructed++;
          });
          core.configure(i4, out, 'full');
        }
        if (q === qTier) core.configure(i4, out, 'lite');
        core.render(ctl, l, r, QUANTUM, (q * QUANTUM) / FS);
        left.set(l, q * QUANTUM);
        right.set(r, q * QUANTUM);
      }
    } finally {
      uninstall?.();
    }
    expect(constructed).toBe(0);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(core.stats.nonFiniteResets).toBe(0);
    expect(maxStep(left)).toBeLessThanOrEqual(0.1);
    expect(maxStep(right)).toBeLessThanOrEqual(0.1);
    const steadyV8 = rmsDb(slice(left, 0.6, 1.0));
    expect(steadyV8).toBeGreaterThan(-50);
    for (const t0 of [1, 2]) {
      // fade-out reaches 0 at t0 + 0.3 s; the swap is applied at the end of that quantum
      expect(rmsDb(slice(left, t0 + 0.26, t0 + 0.29))).toBeLessThan(steadyV8 - 6);
      // fade gain ≤ 0.0066 here (the window opens 72 look-ahead samples before the fade ends): < 0.05 for
      // pre-OutputStage peaks up to ≈ +17 dBFS; a missing fade reads ≫ 0.05
      expect(peakAbs(slice(left, t0 + 0.2995, t0 + 0.3025))).toBeLessThan(0.05);
    }
    const steadyI4 = rmsDb(slice(left, 1.7, 2.0));
    expect(steadyI4).toBeGreaterThan(-50);
    expect(rmsDb(slice(left, 1.31, 1.34))).toBeLessThan(steadyI4 - 6); // fading in, not stepping in
    expect(rmsDb(slice(left, 3.0, 4.0))).toBeGreaterThan(-50); // lite tier audible
    expect(internals(core).def).toBe(i4);
  });

  it('retargets a queued swap (last request wins) and cancels it when the applied engine is requested again', { timeout: 30_000 }, () => {
    const v8 = loadFixture('v8-crossplane-test');
    const i4 = loadFixture('i4-test');
    const i6 = loadFixture('i6-test');
    const h = new CoreHarness(v8);
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    h.run(1, ctl);
    h.core.configure(i4, OUT_SUB, 'full');
    h.run(0.1, ctl);
    h.core.configure(i6, OUT_SUB, 'full'); // still fading out → retarget
    h.run(0.6, ctl);
    expect(internals(h.core).def).toBe(i6);
    const steady = h.run(0.3, ctl);
    h.core.configure(v8, OUT_SUB, 'full');
    const down = h.run(0.15, ctl); // fade gain 1 → 0.5
    h.core.configure(i6, OUT_SUB, 'full'); // back to the applied engine → cancel, fade back in
    const up = h.run(0.4, ctl);
    expect(internals(h.core).def).toBe(i6);
    const ref = rmsDb(steady.left);
    expect(minWindowRmsDb(down.left)).toBeGreaterThan(ref - 12);
    expect(minWindowRmsDb(up.left)).toBeGreaterThan(ref - 12);
  });

  it('applies a trim-only configure immediately, without a fade', { timeout: 30_000 }, () => {
    const def = loadFixture('v8-crossplane-test');
    const h = new CoreHarness(def);
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    const before = h.run(1, ctl);
    h.core.configure(def, { ...OUT_SUB, volumeTrimDb: -12 }, 'full');
    const after = h.run(0.6, ctl);
    expect(minWindowRmsDb(after.left)).toBeGreaterThan(-50);
    expect(rmsDb(slice(after.left, 0.3, 0.6))).toBeLessThan(rmsDb(slice(before.left, 0.5, 1)) - 3);
  });

  it('snaps the first perspective after configure or a reset, and crossfades later changes over 300 ms', { timeout: 30_000 }, () => {
    const h = new CoreHarness(loadFixture('i4-test'));
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    h.run(QUANTUM / FS, ctl);
    expect(mixPosition(h.core)).toBe(1); // not a fade-in from the mixer's default 'cabin'
    ctl.perspective = 'cabin';
    h.run(QUANTUM / FS, ctl);
    expect(mixPosition(h.core)).toBeCloseTo(1 - QUANTUM / (0.3 * FS), 9);
    h.run(0.3, ctl);
    expect(mixPosition(h.core)).toBe(0);

    // non-finite reset at the end of the next quantum; the control switches to 'outside' right after it
    internals(h.core).exhaust.tick(new Float64Array(MAX_COMBUSTION).fill(Number.NaN), Number.NaN);
    h.run(QUANTUM / FS, ctl);
    expect(h.core.stats.nonFiniteResets).toBe(1);
    ctl.perspective = 'outside';
    h.run(QUANTUM / FS, ctl);
    expect(mixPosition(h.core)).toBe(1);

    // deferred engine swap; the control switches to 'cabin' on the first quantum after it is applied
    const i6 = loadFixture('i6-test');
    h.core.configure(i6, OUT_SUB, 'full');
    for (let q = 0; q < 200 && internals(h.core).def !== i6; q++) h.run(QUANTUM / FS, ctl);
    expect(internals(h.core).def).toBe(i6);
    ctl.perspective = 'cabin';
    h.run(QUANTUM / FS, ctl);
    expect(mixPosition(h.core)).toBe(0);
  });
});

describe('TesboxDspCore ignition', () => {
  const OUT_NO_SUB: OutputConfig = { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 };

  it('RF2: ignition off → < −90 dBFS within 2 s, no NaN; ignition on restores sound', { timeout: 30_000 }, () => {
    const h = new CoreHarness(loadFixture('i4-test'), { output: OUT_NO_SUB });
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    const on = h.run(1, ctl);
    expect(rmsDb(slice(on.left, 0.5, 1))).toBeGreaterThan(-50);
    const tOff = h.tS;
    ctl.ignitionOn = false;
    ctl.load = 0;
    ctl.driveline = 'clutch-open';
    const off = h.run(2, ctl, (t) => {
      ctl.rpm = Math.max(0, 3000 * (1 - (t - tOff))); // SimCore: rpm → 0 over 1 s
    });
    expect(allFinite(off.left) && allFinite(off.right)).toBe(true);
    expect(peakDb(slice(off.left, 1.95, 2.0))).toBeLessThan(-90);
    expect(peakDb(slice(off.right, 1.95, 2.0))).toBeLessThan(-90);
    ctl.ignitionOn = true;
    ctl.rpm = 900;
    ctl.load = 0.2;
    ctl.driveline = 'engaged';
    const back = h.run(1, ctl);
    expect(allFinite(back.left)).toBe(true);
    expect(rmsDb(slice(back.left, 0.5, 1))).toBeGreaterThan(-60);
    expect(h.core.stats.nonFiniteResets).toBe(0);
  });

  it('RF2: ignition off with rpm and load held (adversarial control) is still silent within 2 s', { timeout: 30_000 }, () => {
    const h = new CoreHarness(loadFixture('v8-sc-test'), { output: OUT_NO_SUB });
    const ctl = makeCtl(4000, 1, { perspective: 'outside', valve: 'open' });
    h.run(1, ctl);
    ctl.ignitionOn = false;
    const off = h.run(2, ctl);
    expect(allFinite(off.left)).toBe(true);
    expect(peakDb(slice(off.left, 1.95, 2.0))).toBeLessThan(-90);
    expect(peakDb(slice(off.right, 1.95, 2.0))).toBeLessThan(-90);
  });
});

describe('TesboxDspCore robustness and control', () => {
  it('recovers from non-finite module state: full reset, counter, 50 ms fade-in', () => {
    const h = new CoreHarness(loadFixture('v8-crossplane-test'));
    const ctl = makeCtl(3000, 0.5, { perspective: 'outside' });
    h.run(0.5, ctl);
    internals(h.core).exhaust.tick(new Float64Array(MAX_COMBUSTION).fill(Number.NaN), Number.NaN);
    const hit = h.run(QUANTUM / FS, ctl);
    expect(allFinite(hit.left) && allFinite(hit.right)).toBe(true);
    expect(h.core.stats.nonFiniteResets).toBe(1);
    expect(internals(h.core).fadeGain).toBe(0);
    h.run(QUANTUM / FS, ctl);
    expect(internals(h.core).fadeGain).toBeCloseTo(QUANTUM / (0.05 * FS), 9); // 50 ms ramp, not a jump to 1
    const after = h.run(0.6, ctl);
    expect(allFinite(after.left) && allFinite(after.right)).toBe(true);
    expect(rmsDb(slice(after.left, 0.3, 0.6))).toBeGreaterThan(-50);
    expect(internals(h.core).fadeGain).toBe(1);
    expect(h.core.stats.nonFiniteResets).toBe(1);
  });

  it('sanitises non-finite control values instead of resetting', () => {
    const h = new CoreHarness(loadFixture('i6-test'));
    const ctl = makeCtl(Number.NaN, Number.POSITIVE_INFINITY, { runTimeS: Number.NaN });
    ctl.shift = { active: true, up: true, fromRpm: Number.NaN, toRpm: 3000, t0: 0, durationS: 0 };
    const out = h.run(0.2, ctl);
    expect(allFinite(out.left) && allFinite(out.right)).toBe(true);
    expect(h.core.stats.nonFiniteResets).toBe(0);
  });

  it('reports stats; the true peak is read-and-reset', () => {
    const h = new CoreHarness(loadFixture('v8-sc-test'));
    h.run(1, makeCtl(4000, 1, { perspective: 'outside' }));
    const s = h.core.stats;
    expect(s.nonFiniteResets).toBe(0);
    expect(s.boost).toBeGreaterThan(0);
    expect(s.boost).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.limiterGainReductionDb)).toBe(true);
    const tp1 = s.truePeakDbtp;
    expect(tp1).toBeGreaterThan(-60);
    expect(tp1).toBeLessThanOrEqual(-1 + 1e-3);
    const tp2 = h.core.stats.truePeakDbtp;
    expect(tp2).toBeLessThan(tp1);
  });

  it('forceHot snaps gas speeds to the hot target for the current load; otherwise they slew with τ = 3 s', () => {
    const def = loadFixture('i6-test');
    const hot = new CoreHarness(def);
    hot.run(QUANTUM / FS, makeCtl(3000, 0.5));
    const heat = 0.6 + 0.4 * 0.5;
    expect(internals(hot.core).gasHeader).toBeCloseTo(343 + 357 * heat, 9);
    expect(internals(hot.core).gasCollector).toBeCloseTo(343 + 217 * heat, 9);
    expect(internals(hot.core).gasMuffler).toBeCloseTo(343 + 117 * heat, 9);
    // warm-up 1 − e^(−runTimeS / 120 s) when not warm: one time constant in
    const part = new CoreHarness(def, { hot: false });
    part.run(QUANTUM / FS, makeCtl(3000, 0.5, { warm: false, runTimeS: 120 }));
    expect(internals(part.core).gasHeader).toBeCloseTo(343 + 357 * heat * (1 - Math.exp(-1)), 9);
    const cold = new CoreHarness(def, { hot: false });
    cold.run(1, makeCtl(3000, 0.5, { warm: false, runTimeS: 0 }));
    expect(internals(cold.core).gasHeader).toBeCloseTo(343, 9);
    cold.run(3, makeCtl(3000, 0.5, { warm: true }));
    expect(internals(cold.core).gasHeader).toBeCloseTo(343 + 357 * heat * (1 - Math.exp(-1)), 6);
  });

  it('crossfades combustion ↔ overrun only when eligible, with the idle floor otherwise', () => {
    const def = loadFixture('v8-crossplane-test');
    const resume = def.voicing.overrun.fuelCutResumeRpm;
    expect(resume).toBeGreaterThan(1000);
    const h = new CoreHarness(def);
    const ctl = makeCtl(5000, 0.5);
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBe(0);
    ctl.load = -0.6;
    h.run(0.04, ctl); // 1920 samples of a 3840-sample (80 ms) slew
    expect(internals(h.core).regime).toBeCloseTo(0.5, 9);
    h.run(0.1, ctl);
    expect(internals(h.core).regime).toBe(1);
    expect(internals(h.core).lastCombustionGain).toBe(0);
    ctl.load = -0.03; // smoothstep(−0.08, 0.02, −0.03) = 0.5
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBeCloseTo(0.5, 9);
    expect(internals(h.core).lastCombustionGain).toBeCloseTo(0.5, 9);
    ctl.load = -0.6;
    h.run(0.2, ctl);
    expect(internals(h.core).lastCombustionGain).toBe(0);
    // not eligible (clutch open): regime slews back to 0 while the idle floor holds the gain at ≥ 0.15
    ctl.driveline = 'clutch-open';
    h.run(QUANTUM / FS, ctl); // regime ≈ 0.967 → 1 − regime ≈ 0.033 < 0.15
    expect(internals(h.core).lastCombustionGain).toBeCloseTo(0.15, 9);
    h.run(0.2, ctl);
    expect(internals(h.core).regime).toBe(0);
    expect(internals(h.core).lastCombustionGain).toBe(1);
    // not eligible (rpm ≤ fuelCutResumeRpm) although engaged and lifting
    ctl.driveline = 'engaged';
    ctl.rpm = 1000;
    h.run(0.3, ctl);
    expect(internals(h.core).regime).toBe(0);
    expect(internals(h.core).lastCombustionGain).toBe(1);
    // just above the resume rpm: eligible again
    ctl.rpm = resume + 100;
    h.run(0.3, ctl);
    expect(internals(h.core).regime).toBe(1);
    expect(internals(h.core).lastCombustionGain).toBe(0);
  });

  it('slews the exhaust valve over 200 ms per mode and keeps an unfitted valve shut', () => {
    const def = structuredClone(loadFixture('v8-crossplane-test'));
    def.voicing.exhaust.valve.fitted = true;
    const h = new CoreHarness(def);
    const ctl = makeCtl(2000, 0.2, { valve: 'open' });
    h.run(0.1, ctl); // 38 quanta
    expect(internals(h.core).valve).toBeCloseTo((38 * QUANTUM) / (0.2 * FS), 9);
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.valve = 'auto'; // comfort, 2000 rpm → closed
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(0, 9);
    ctl.driveMode = 'sport';
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.driveMode = 'comfort';
    ctl.rpm = 4000;
    ctl.load = 0.5;
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(1, 9);
    ctl.valve = 'closed';
    h.run(0.2, ctl);
    expect(internals(h.core).valve).toBeCloseTo(0, 9);
    const shut = structuredClone(def);
    shut.voicing.exhaust.valve.fitted = false;
    const h2 = new CoreHarness(shut);
    h2.run(0.3, makeCtl(5000, 1, { valve: 'open' }));
    expect(internals(h2.core).valve).toBe(0);
  });

  it('B5 skip masks: hard limiter and shift cuts skip every entry, soft limiter skips entries 0, 2, 4, …', () => {
    const types = ['fuel-hard', 'ignition-hard', 'fuel-soft', 'ignition-soft'] as const;
    for (const type of types) {
      const def = structuredClone(loadFixture('i5-test'));
      def.spec.rpm.limiter.type = type;
      const all = (1 << def.spec.combustion.length) - 1; // 0b11111
      const expected = type.endsWith('soft') ? all & 0x5555 : all; // soft: 0b10101
      const h = new CoreHarness(def);
      const ctl = makeCtl(def.spec.rpm.limiter.rpm, 1, { limiter: true });
      const masks = new Set<number>();
      const ignitionFlags = new Set<boolean>();
      h.run(1, ctl, () => {
        const c = internals(h.core).combustion;
        masks.add(c.skipMask);
        if (c.skipMask !== 0) ignitionFlags.add(c.skipIsIgnition);
      });
      expect([...masks].sort((a, b) => a - b), type).toEqual([0, expected]);
      expect([...ignitionFlags], type).toEqual([type.startsWith('ignition')]);
    }
    for (const [gearbox, ignition] of [['dct', true], ['manual', false]] as const) {
      const def = structuredClone(loadFixture('i4-test'));
      def.spec.rpm.limiter.type = 'ignition-soft'; // a shift cut ignores the soft limiter mask
      def.spec.gearbox.type = gearbox;
      const h = new CoreHarness(def);
      const ctl = makeCtl(6000, 1);
      h.run(0.2, ctl);
      ctl.shift = { active: true, up: true, fromRpm: 6000, toRpm: 4200, t0: h.tS, durationS: 0.25 };
      const masks = new Set<number>();
      const ignitionFlags = new Set<boolean>();
      h.run(0.09, ctl, () => {
        const c = internals(h.core).combustion;
        masks.add(c.skipMask);
        if (c.skipMask !== 0) ignitionFlags.add(c.skipIsIgnition);
      });
      masks.delete(0);
      expect([...masks], gearbox).toEqual([(1 << def.spec.combustion.length) - 1]);
      expect([...ignitionFlags], gearbox).toEqual([ignition]);
    }
  });

  it('B5: picks the limiter mask from RpmState, even while a finished shift is still flagged active', () => {
    const def = structuredClone(loadFixture('i5-test'));
    def.spec.rpm.limiter.type = 'ignition-soft';
    const soft = ((1 << def.spec.combustion.length) - 1) & 0x5555; // 0b10101
    const h = new CoreHarness(def);
    const ctl = makeCtl(def.spec.rpm.limiter.rpm, 1, { limiter: true });
    // u = (t − t0)/durationS ≥ 10 from the first sample: the shift is over, the flag merely lingers
    ctl.shift = { active: true, up: true, fromRpm: 5200, toRpm: 5200, t0: -1, durationS: 0.1 };
    const masks = new Set<number>();
    const ignitionFlags = new Set<boolean>();
    h.run(1, ctl, () => {
      const c = internals(h.core).combustion;
      masks.add(c.skipMask);
      if (c.skipMask !== 0) ignitionFlags.add(c.skipIsIgnition);
    });
    expect([...masks].sort((a, b) => a - b)).toEqual([0, soft]);
    expect([...ignitionFlags]).toEqual([true]);
  });

  it('feeds ignition-cut pops from CombustionSource into OverrunLayer (ignition cuts only)', () => {
    for (const [type, expectPops] of [['ignition-hard', true], ['fuel-hard', false]] as const) {
      const def = structuredClone(loadFixture('v8-crossplane-test'));
      def.spec.rpm.limiter.type = type;
      const h = new CoreHarness(def);
      const overrun = internals(h.core).overrun;
      const original = overrun.tick.bind(overrun);
      let pops = 0;
      overrun.tick = (regime, rpm, falling, valveOpen01, modeFactor, ignitionCutPops) => {
        pops += ignitionCutPops;
        original(regime, rpm, falling, valveOpen01, modeFactor, ignitionCutPops);
      };
      h.run(1, makeCtl(def.spec.rpm.limiter.rpm, 1, { limiter: true }));
      if (expectPops) expect(pops, type).toBeGreaterThan(0);
      else expect(pops, type).toBe(0);
    }
  });
});
