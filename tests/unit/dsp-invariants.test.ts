/**
 * DSP invariants (phase 2a contract §"DSP invariant tests", spec §14). Unless a test states otherwise:
 * measured on TesboxDspCore.exhaustBus, seed 1, forceHot(), load 0.5, app-default control (valve auto,
 * comfort, cabin), steady rpm 2000/4000/6000 (≤ redline − 500), 1.5 s renders, first 0.5 s discarded.
 */
import { describe, expect, it } from 'vitest';
import { MAX_COMBUSTION, QUANTUM, type DspControl, type EngineDef, type OutputConfig, type Tier } from '../../src/contracts';
import { bandEnergyDb, dominantOrders, fft, hann, orderSpectrum, truePeakDbtp } from '../../src/dsp/analysis';
import { DEFAULT_OUTSIDE_FI_DB, DEFAULT_WHISTLE_DB } from '../../src/data/voicing-defaults';
import { TesboxDspCore } from '../../src/dsp/dsp-core';
import { ExhaustNetwork } from '../../src/dsp/exhaust';
import { ForcedInduction } from '../../src/dsp/forced';
import { Rng } from '../../src/dsp/util';
import {
  CoreHarness,
  FIXTURE_IDS,
  FS,
  OUT_SUB,
  allFinite,
  bitIdentical,
  internals,
  loadFixture,
  makeCtl,
  slice,
} from './helpers/dsp-harness';

const MAX_ORDER = 12;
const RPMS = [2000, 4000, 6000] as const;
const UNEVEN = new Set<string>(['i5-test', 'v8-crossplane-test', 'v8-sc-test', 'flat4-uel-test', 'rotary-test']);
const EVEN = new Set<string>(['i4-test', 'i6-test', 'v8-flatplane-test']);
const HOT = { header: 700, collector: 560, muffler: 460 } as const;
const COLD = 343;

const defs = new Map<string, EngineDef>(FIXTURE_IDS.map((id) => [id, loadFixture(id)]));
function def(id: string): EngineDef {
  const d = defs.get(id);
  if (d === undefined) throw new Error(`unknown fixture ${id}`);
  return d;
}

/** Firing crank order: combustion.length × 360 / cycleDeg (I4 2, I5 2.5, I6 3, V8 4, rotary 2). */
function firingOrder(d: EngineDef): number {
  return (d.spec.combustion.length * 360) / d.spec.cycleDeg;
}
/** Cycle sub-order grid: ½ for 4-stroke, ⅓ for rotary. */
function orderStep(d: EngineDef): number {
  return 360 / d.spec.cycleDeg;
}
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
function rpmsFor(d: EngineDef): number[] {
  return RPMS.filter((r) => r <= d.spec.rpm.redline - 500);
}

/** Exhaust bus of a steady hot render at (rpm, load 0.5): 1.5 s, first 0.5 s discarded. Memoised. */
const steadyCache = new Map<string, Float32Array>();
function steadyExhaust(id: string, rpm: number): Float32Array {
  const key = `${id}@${rpm}`;
  const hit = steadyCache.get(key);
  if (hit) return hit;
  const out = new CoreHarness(def(id)).run(1.5, makeCtl(rpm, 0.5));
  const sig = slice(out.exhaust, 0.5, 1.5);
  steadyCache.set(key, sig);
  return sig;
}

/**
 * Sub-order energy re the firing order, in dB. Sub-orders = the cycle-grid orders k·step ≤ MAX_ORDER
 * that are neither integers nor multiples of the firing order (½ orders for 4-stroke, ⅓ and ⅔ orders
 * for rotary); their energies are summed and compared with the single firing-order line.
 */
function subOrderRatioDb(d: EngineDef, rpm: number): number {
  const step = orderStep(d);
  const fire = firingOrder(d);
  const spec = orderSpectrum(steadyExhaust(d.id, rpm), FS, rpm, MAX_ORDER, step);
  let sub = 0;
  let fireE = 0;
  for (let i = 0; i < spec.length; i++) {
    const order = (i + 1) * step;
    const e = spec[i] ?? 0;
    if (near(order, fire)) fireE = e;
    const isInteger = near(order, Math.round(order));
    const isFiringHarmonic = near(order / fire, Math.round(order / fire));
    if (!isInteger && !isFiringHarmonic) sub += e;
  }
  return 10 * Math.log10((sub + 1e-300) / (fireE + 1e-300));
}

/** Power spectrum (Hann, zero-padded to twice the next power of two) → bin spacing and |X_k|². */
function powerSpectrum(sig: Float32Array): { df: number; p: Float64Array } {
  let n = 1;
  while (n < sig.length) n <<= 1;
  n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(sig.length);
  for (let i = 0; i < sig.length; i++) re[i] = (sig[i] ?? 0) * (w[i] ?? 0);
  fft(re, im);
  const p = new Float64Array(n / 2 + 1);
  for (let k = 0; k < p.length; k++) p[k] = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
  return { df: FS / n, p };
}

describe('DSP invariants', () => {
  it('1. the firing order is among the top 3 orders at 2k/4k/6k rpm', { timeout: 120_000 }, () => {
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      for (const rpm of rpmsFor(d)) {
        const spec = orderSpectrum(steadyExhaust(id, rpm), FS, rpm, MAX_ORDER, orderStep(d));
        const top = dominantOrders(spec, orderStep(d), 3);
        expect(top.some((o) => near(o, firingOrder(d))), `${id} @ ${rpm}: top orders ${top.join(', ')}`).toBe(true);
      }
    }
  });

  it('2. sub-orders: uneven-fire/rotary ≥ firing − 30 dB; even-fire ≤ firing − 20 dB', { timeout: 120_000 }, () => {
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      expect(UNEVEN.has(id) !== EVEN.has(id), `${id} is classified exactly once`).toBe(true);
      for (const rpm of rpmsFor(d)) {
        const db = subOrderRatioDb(d, rpm);
        if (UNEVEN.has(id)) expect(db, `${id} @ ${rpm}`).toBeGreaterThanOrEqual(-30);
        else expect(db, `${id} @ ${rpm}`).toBeLessThanOrEqual(-20);
      }
    }
  });

  it('3. rotary: e-shaft order 2 is dominant', { timeout: 60_000 }, () => {
    const d = def('rotary-test');
    for (const rpm of rpmsFor(d)) {
      const spec = orderSpectrum(steadyExhaust('rotary-test', rpm), FS, rpm, MAX_ORDER, orderStep(d));
      expect(dominantOrders(spec, orderStep(d), 1)[0], `rotary @ ${rpm}`).toBeCloseTo(2, 6);
    }
  });

  it('4. supercharger: spectral peak within 0.5 % of whineHz(rpm) in a cabin render (full output)', { timeout: 60_000 }, () => {
    const d = def('v8-sc-test');
    const fi = new ForcedInduction(FS);
    fi.configure(d.spec, d.voicing, 1);
    const rpms = rpmsFor(d);
    expect(rpms.length).toBeGreaterThan(0);
    for (const rpm of rpms) {
      const f = fi.whineHz(rpm);
      expect(f).toBeGreaterThan(0);
      const out = new CoreHarness(d).run(1.5, makeCtl(rpm, 0.5, { perspective: 'cabin' }));
      const { df, p } = powerSpectrum(slice(out.left, 0.5, 1.5));
      const lo = Math.floor((0.97 * f) / df);
      const hi = Math.ceil((1.03 * f) / df);
      let best = lo;
      for (let k = lo; k <= hi; k++) if ((p[k] ?? 0) > (p[best] ?? 0)) best = k;
      expect(Math.abs(best * df - f) / f, `whine @ ${rpm}: peak ${(best * df).toFixed(1)} Hz vs ${f} Hz`).toBeLessThanOrEqual(0.005);
      const band = Array.from(p.subarray(lo, hi + 1)).sort((a, b) => a - b);
      const median = band[Math.floor(band.length / 2)] ?? 0;
      expect(10 * Math.log10((p[best] ?? 0) / (median + 1e-300)), `whine prominence @ ${rpm}`).toBeGreaterThan(10);
    }
  });

  it('5. turbo whistle (B18): detectable and on the shaft frequency at whistleDb 0; below the engine at the default levels', { timeout: 120_000 }, () => {
    const turbo = FIXTURE_IDS.filter((id) => def(id).spec.aspiration.type === 'turbo');
    expect(turbo.length).toBeGreaterThan(0);
    type Fi = NonNullable<EngineDef['voicing']['forcedInduction']>;
    const withFi = (d: EngineDef, patch: Partial<Fi>): EngineDef => {
      const c = structuredClone(d);
      if (c.voicing.forcedInduction !== null) Object.assign(c.voicing.forcedInduction, patch);
      return c;
    };
    const band = (sig: Float32Array): number => bandEnergyDb(sig, FS, 1000, 4000);
    for (const id of turbo) {
      const d = def(id);
      const rpm = 0.7 * d.spec.rpm.redline;
      // (a) at the Phase 2a level (whistleDb 0) the line is detectable in the cabin and sits on the shaft's f1
      const cabin = makeCtl(rpm, 1, { perspective: 'cabin' });
      const h = new CoreHarness(withFi(d, { whistleDb: 0 }));
      const sig = slice(h.run(5, cabin).left, 4, 5); // 4 s spool-up, analyse the last 1 s
      expect(band(sig) - bandEnergyDb(sig, FS, 0, FS / 2), `${id}: 1–4 kHz re total`).toBeGreaterThanOrEqual(-45);
      // Discrimination: muting the forced-induction bus in the cabin, or the whistle alone, removes energy from the band.
      const muted = slice(new CoreHarness(withFi(d, { whistleDb: 0, cabinGainDb: -200 })).run(5, cabin).left, 4, 5);
      expect(band(sig) - band(muted), `${id}: forced-induction contribution`).toBeGreaterThan(3);
      const noWhistle = slice(new CoreHarness(withFi(d, { whistleDb: -400 })).run(5, cabin).left, 4, 5);
      expect(band(sig) - band(noWhistle), `${id}: whistle contribution`).toBeGreaterThan(3);
      const f1 = 1000 + 3000 * Math.sqrt(h.core.stats.boost);
      const { df, p } = powerSpectrum(sig);
      let best = Math.ceil(1000 / df);
      for (let k = best; k <= Math.floor(4000 / df); k++) if ((p[k] ?? 0) > (p[best] ?? 0)) best = k;
      const off = Math.min(Math.abs(best * df - f1), Math.abs(best * df - 0.88 * f1)) / f1; // 0.88·f1: sequential voice 2
      expect(off, `${id}: band peak ${(best * df).toFixed(0)} Hz vs f1 ${f1.toFixed(0)} Hz`).toBeLessThan(0.01);
      // (b) at the default levels (whistleDb −36, outsideGainDb −30; the fixtures keep the Phase 2a levels, 0 dB)
      // the whistle sits below the engine in both perspectives: removing it changes the 1–4 kHz band by < 1 dB (the
      // recordings show no whistle line; at whistleDb 0 it adds > 3 dB in the cabin, as (a) asserts).
      expect([DEFAULT_WHISTLE_DB, DEFAULT_OUTSIDE_FI_DB]).toEqual([-36, -30]);
      const defaults = withFi(d, { whistleDb: DEFAULT_WHISTLE_DB, outsideGainDb: DEFAULT_OUTSIDE_FI_DB });
      for (const perspective of ['cabin', 'outside'] as const) {
        const ctl = makeCtl(rpm, 1, { perspective });
        const at = slice(new CoreHarness(defaults).run(5, ctl).left, 4, 5);
        const without = slice(new CoreHarness(withFi(defaults, { whistleDb: -400 })).run(5, ctl).left, 4, 5);
        expect(band(at) - band(without), `${id} ${perspective}: whistle contribution at the defaults`).toBeLessThan(1);
      }
    }
  });

  it('6. limiter held 2 s → 8–20 cut→fire transitions/s, no cut > 100 ms, cuts reach the combustion source', { timeout: 120_000 }, () => {
    const BLOCK = 16; // render in 16-frame blocks: rpmState.cut sampled every 0.33 ms
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      const core = new TesboxDspCore(FS, 1);
      core.configure(d, OUT_SUB, 'full');
      core.forceHot();
      const ctl = makeCtl(d.spec.rpm.limiter.rpm, 1);
      let b = 0;
      const settle = Math.round((0.3 * FS) / BLOCK);
      for (; b < settle; b++) core.render(ctl, l, r, BLOCK, (b * BLOCK) / FS);
      ctl.limiter = true;
      const hold = Math.round((2 * FS) / BLOCK);
      let transitions = 0;
      let run = 0;
      let longest = 0;
      let prevCut = false;
      let cutBlocks = 0;
      let cutsWithoutMask = 0;
      for (let k = 0; k < hold; k++, b++) {
        core.render(ctl, l, r, BLOCK, (b * BLOCK) / FS);
        const inner = internals(core);
        const cut = inner.rpmState.cut;
        if (cut) {
          cutBlocks++;
          if (inner.combustion.skipMask === 0) cutsWithoutMask++;
        }
        if (prevCut && !cut) transitions++;
        run = cut ? run + 1 : 0;
        longest = Math.max(longest, run);
        prevCut = cut;
      }
      const perSecond = transitions / 2;
      expect(perSecond, `${id}: cut→fire transitions/s`).toBeGreaterThanOrEqual(8);
      expect(perSecond, `${id}: cut→fire transitions/s`).toBeLessThanOrEqual(20);
      expect((longest * BLOCK) / FS, `${id}: longest cut (s)`).toBeLessThanOrEqual(0.1);
      expect(cutBlocks, `${id}: cut phases seen`).toBeGreaterThan(0);
      expect(cutsWithoutMask, `${id}: cut samples with skipMask 0`).toBe(0);
    }
  });

  it('7. passivity: header impulses decay monotonically (50 ms windows) to ≤ −120 dB within 2 s', { timeout: 120_000 }, () => {
    const win = Math.round(0.05 * FS);
    const every = Math.round(0.001 * FS);
    const hin = new Float64Array(MAX_COMBUSTION);
    for (const id of FIXTURE_IDS) {
      const d = def(id);
      const net = new ExhaustNetwork(FS);
      for (const tier of ['full', 'lite'] as Tier[]) {
        for (const valve of [0, 1]) {
          for (const hot of [false, true]) {
            const label = `${id} ${tier} valve=${valve} ${hot ? 'hot' : 'cold'}`;
            // static operating point: speeds, valve and attenuation first, then reset() snaps the valve smoothing
            net.configure(d, tier);
            if (hot) net.setGasSpeeds(HOT.header, HOT.collector, HOT.muffler);
            else net.setGasSpeeds(COLD, COLD, COLD);
            net.setValve(valve);
            net.setTurbineAttenuation(hot ? 1 : 0);
            net.reset();
            hin.fill(0);
            for (let i = 0; i < d.spec.combustion.length; i++) hin[i] = 1;
            net.tick(hin, 0);
            hin.fill(0);
            const e0 = net.energy();
            expect(e0, label).toBeGreaterThan(0);
            let prevMean = Number.POSITIVE_INFINITY;
            for (let w = 0; w < 40; w++) {
              let sum = 0;
              let cnt = 0;
              for (let s = 0; s < win; s++) {
                net.tick(hin, 0);
                if (s % every === every - 1) {
                  sum += net.energy();
                  cnt++;
                }
              }
              const mean = sum / cnt;
              expect(Number.isFinite(mean), label).toBe(true);
              expect(mean, `${label}: window ${w}`).toBeLessThanOrEqual(prevMean * (1 + 1e-12));
              prevMean = mean;
            }
            expect(10 * Math.log10(net.energy() / e0 + 1e-300), label).toBeLessThanOrEqual(-120);
          }
        }
      }
    }
  });

  it('8. fuzz: 10 000 random quanta → finite output, true peak ≤ −1.0 dBTP', { timeout: 300_000 }, () => {
    const rng = new Rng(2024);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)] as T;
    const core = new TesboxDspCore(FS, 3);
    const out: OutputConfig = { subwoofer: 'no', hpCornerHz: 40, volumeTrimDb: 0 };
    let engine = def(FIXTURE_IDS[0]);
    let tier: Tier = 'full';
    core.configure(engine, out, tier);
    const ctl: DspControl = makeCtl(3000, 0.5);
    const total = 10_000;
    const left = new Float32Array(total * QUANTUM);
    const right = new Float32Array(total * QUANTUM);
    const l = new Float32Array(QUANTUM);
    const r = new Float32Array(QUANTUM);
    for (let q = 0; q < total; q++) {
      const t = (q * QUANTUM) / FS;
      if (q % 1250 === 0 && q > 0) {
        engine = def(FIXTURE_IDS[(q / 1250) % FIXTURE_IDS.length] ?? FIXTURE_IDS[0]);
        tier = rng.next() < 0.5 ? 'full' : 'lite';
        out.subwoofer = pick(['yes', 'no', 'unsure'] as const);
        out.hpCornerHz = 30 + 30 * rng.next();
        core.configure(engine, out, tier);
      }
      if (rng.next() < 0.1) {
        ctl.rpm = rng.next() * 12000;
        ctl.load = rng.bipolar();
        ctl.limiter = rng.next() < 0.15;
        ctl.valve = pick(['auto', 'open', 'closed'] as const);
        ctl.perspective = pick(['cabin', 'outside'] as const);
        ctl.driveMode = pick(['comfort', 'sport'] as const);
        ctl.driveline = pick(['engaged', 'engaged', 'clutch-open', 'tc-stall', 'slipping'] as const);
        ctl.ignitionOn = rng.next() < 0.97;
        ctl.warm = rng.next() < 0.5;
        ctl.runTimeS = rng.next() * 600;
        if (rng.next() < 0.2) {
          out.volumeTrimDb = -24 + 30 * rng.next(); // trim −24 … +6 dB (trim-only configure: no fade)
          core.configure(engine, out, tier);
        }
      }
      if (!ctl.shift.active && rng.next() < 0.01) {
        ctl.shift = {
          active: true,
          up: rng.next() < 0.5,
          fromRpm: rng.next() * 12000,
          toRpm: rng.next() * 12000,
          t0: t,
          durationS: 0.05 + 0.55 * rng.next(),
        };
      } else if (ctl.shift.active && t > ctl.shift.t0 + ctl.shift.durationS) {
        ctl.shift = { ...ctl.shift, active: false };
      }
      core.render(ctl, l, r, QUANTUM, t);
      left.set(l, q * QUANTUM);
      right.set(r, q * QUANTUM);
    }
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(core.stats.nonFiniteResets).toBe(0);
    expect(truePeakDbtp(left)).toBeLessThanOrEqual(-1.0);
    expect(truePeakDbtp(right)).toBeLessThanOrEqual(-1.0);
  });

  it('9. at 9000 rpm, exhaust-bus energy above 16 kHz ≤ −60 dB re total', { timeout: 60_000 }, () => {
    const d = structuredClone(def('v8-flatplane-test'));
    d.spec.rpm.redline = 9500;
    d.spec.rpm.limiter.rpm = Math.max(d.spec.rpm.limiter.rpm, 9800);
    const sig = slice(new CoreHarness(d).run(1.5, makeCtl(9000, 0.5)).exhaust, 0.5, 1.5);
    expect(bandEnergyDb(sig, FS, 16000, FS / 2) - bandEnergyDb(sig, FS, 0, FS / 2)).toBeLessThanOrEqual(-60);
  });

  it('10. determinism: same seed → bit-identical output; different seed → different output', { timeout: 60_000 }, () => {
    const d = def('i5-test');
    const run = (seed: number): { l: Float32Array; r: Float32Array; e: Float32Array } => {
      const h = new CoreHarness(d, { seed });
      const ctl = makeCtl(2500, 0.4, { perspective: 'outside' });
      const a = h.run(0.5, ctl, (t) => {
        ctl.rpm = 2500 + 4000 * t;
        ctl.load = Math.sin(6 * t);
      });
      ctl.shift = { active: true, up: true, fromRpm: 4500, toRpm: 3200, t0: h.tS, durationS: 0.1 };
      const b = h.run(0.5, ctl);
      const l = new Float32Array(a.left.length + b.left.length);
      l.set(a.left);
      l.set(b.left, a.left.length);
      return { l, r: b.right, e: b.exhaust };
    };
    const x = run(11);
    const y = run(11);
    const z = run(12);
    expect(bitIdentical(x.l, y.l) && bitIdentical(x.r, y.r) && bitIdentical(x.e, y.e)).toBe(true);
    expect(bitIdentical(x.l, z.l)).toBe(false);
  });
});
