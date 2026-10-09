import { describe, expect, it } from 'vitest';
import type { EngineDef, Tier } from '../../src/contracts';
import { SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_MAX } from '../../src/contracts';
import { Biquad } from '../../src/dsp/biquad';
import { ExhaustNetwork } from '../../src/dsp/exhaust';
import { terminationReflect } from '../../src/dsp/junction';
import { Slew, type OnePole } from '../../src/dsp/util';
import { Waveguide } from '../../src/dsp/waveguide';
import { FIXTURE_IDS, loadFixture } from './helpers/fixtures';

const FS = 48000;
const TIERS: Tier[] = ['full', 'lite'];
const HOT: [number, number, number] = [700, 560, 460];
const COLD: [number, number, number] = [SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD];

function network(id: string, tier: Tier, speeds: [number, number, number] = HOT, valve = 0): ExhaustNetwork {
  return networkOf(loadFixture(id), tier, speeds, valve);
}

function networkOf(def: EngineDef, tier: Tier, speeds: [number, number, number] = HOT, valve = 0): ExhaustNetwork {
  const ex = new ExhaustNetwork(FS);
  ex.configure(def, tier);
  ex.setGasSpeeds(...speeds);
  ex.setValve(valve);
  ex.reset(); // snaps the internal valve smoothing to the target
  return ex;
}

/**
 * v8-crossplane-test as a twin-turbo V8, with the topology defaultVoicing gives every turbo V8: one
 * collector per bank, each with its own turbine 2-port (B11). 4 entries per collector → Y_collector
 * 2.5, Y_mid 3.
 */
function twinTurboV8(): EngineDef {
  const def = loadFixture('v8-crossplane-test');
  def.spec.aspiration = { type: 'turbo', turbo: { count: 2, layout: 'parallel' }, supercharger: null };
  def.voicing.turbine = { reflection: 0.45, lpHz: 1500 };
  return def;
}

/**
 * Impulse-decay passivity: a unit pulse into every header, then energy() every `step` samples (≈ 1 ms,
 * chosen to divide the 50 ms window: 35 samples at 44.1 kHz). The 50 ms window maxima never rise
 * and the energy falls 120 dB below the first window's maximum within 2 s.
 */
function expectImpulseDecay(ex: ExhaustNetwork, fs: number, label: string): void {
  const win = Math.round(0.05 * fs);
  let step = Math.floor(fs / 1000);
  while (win % step !== 0) step--;
  const hin = new Float64Array(16);
  const windowMax: number[] = [];
  let current = 0;
  let reached = false;
  for (let n = 0; n < 2 * fs && !reached; n++) {
    hin.fill(n === 0 ? 1 : 0);
    ex.tick(hin, 0);
    if ((n + 1) % step !== 0) continue;
    const e = ex.energy();
    expect(Number.isFinite(e), label).toBe(true);
    current = Math.max(current, e);
    if ((n + 1) % win === 0) {
      windowMax.push(current);
      if (e <= 1e-12 * (windowMax[0] ?? 0)) reached = true;
      current = 0;
    }
  }
  expect(reached, label).toBe(true);
  for (let w = 1; w < windowMax.length; w++) {
    expect(windowMax[w], label).toBeLessThanOrEqual((windowMax[w - 1] ?? 0) * (1 + 1e-9));
  }
}

/** Raised-cosine blowdown pulses (amplitude 1, widthDeg) at each entry's angle + 140°, steady rpm. */
function pulseTrain(def: EngineDef, rpm: number): (n: number, out: Float64Array) => void {
  const cycle = def.spec.cycleDeg;
  const width = def.voicing.pulse.widthDeg;
  const degPerSample = (rpm * 6) / FS;
  const starts = def.spec.combustion.map((c) => c.angleDeg + 140);
  return (n, out) => {
    const theta = (n * degPerSample) % cycle;
    starts.forEach((s, i) => {
      const phi = ((((theta - s) % cycle) + cycle) % cycle) / width;
      out[i] = phi < 1 ? 0.5 * (1 - Math.cos(2 * Math.PI * phi)) : 0;
    });
  };
}

interface Trace {
  out: Float64Array;
  energyMax: number;
  maxJump: number;
  finite: boolean;
}

/** Runs a pulse train for n samples; valveAt(n) is called every sample (the caller's slewed valve). */
function drive(ex: ExhaustNetwork, def: EngineDef, n: number, valveAt: (i: number) => number, rpm = 3000): Trace {
  const gen = pulseTrain(def, rpm);
  const hin = new Float64Array(16);
  const out = new Float64Array(n);
  let energyMax = 0;
  let maxJump = 0;
  let finite = true;
  for (let i = 0; i < n; i++) {
    ex.setValve(valveAt(i));
    gen(i, hin);
    ex.tick(hin, 0);
    const y = ex.outlet;
    out[i] = y;
    if (!Number.isFinite(y)) finite = false;
    if (i > 0) maxJump = Math.max(maxJump, Math.abs(y - (out[i - 1] ?? 0)));
    if (i % 48 === 47) {
      const e = ex.energy();
      if (!Number.isFinite(e)) finite = false;
      energyMax = Math.max(energyMax, e);
    }
  }
  return { out, energyMax, maxJump, finite };
}

function rms(x: Float64Array, from: number): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / (x.length - from));
}

/** |DFT| of x at f (Hz), Goertzel recurrence. */
function magAt(x: Float64Array, f: number): number {
  const w = (2 * Math.PI * f) / FS;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < x.length; n++) {
    const s0 = (x[n] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2));
}

describe('ExhaustNetwork: construction and configuration', () => {
  it('rejects sample rates below 28 kHz and accepts common rates', () => {
    expect(() => new ExhaustNetwork(22050)).toThrow(RangeError);
    expect(() => new ExhaustNetwork(NaN)).toThrow(RangeError);
    for (const fs of [44100, 48000, 96000]) {
      const ex = new ExhaustNetwork(fs);
      ex.configure(loadFixture('v8-crossplane-test'), 'full');
      ex.setGasSpeeds(SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD, SPEED_OF_SOUND_COLD); // longest delays fit
      ex.tick(new Float64Array(16).fill(1), 0);
      expect(Number.isFinite(ex.energy())).toBe(true);
    }
  });

  it('is inert before configure()', () => {
    const ex = new ExhaustNetwork(FS);
    ex.setGasSpeeds(...HOT);
    ex.setValve(1);
    ex.tick(new Float64Array(16).fill(1), 1);
    expect(ex.outlet).toBe(0);
    expect(ex.collectorTap).toBe(0);
    expect(ex.energy()).toBe(0);
  });

  it.each(FIXTURE_IDS)('%s configures for both tiers and produces finite sound', (id) => {
    for (const tier of TIERS) {
      const ex = network(id, tier);
      const t = drive(ex, loadFixture(id), 4800, () => 0);
      expect(t.finite).toBe(true);
      expect(rms(t.out, 2400)).toBeGreaterThan(1e-3);
    }
  });

  it('rejects unrepresentable definitions with RangeError and keeps the previous engine', () => {
    const good = loadFixture('i4-test');
    const ex = new ExhaustNetwork(FS);
    ex.configure(good, 'full');
    const bad: EngineDef[] = [];
    const shortHeaders = loadFixture('i4-test');
    shortHeaders.voicing.headersM = [0.6, 0.6];
    bad.push(shortHeaders);
    const noMuffler = loadFixture('i4-test');
    noMuffler.voicing.exhaust.mufflerSectionsM = [];
    bad.push(noMuffler);
    const badBank = loadFixture('i4-test');
    badBank.spec.combustion[1] = { angleDeg: 540, bank: -1 };
    bad.push(badBank);
    const noCollector = loadFixture('i4-test');
    noCollector.voicing.collectors = [];
    bad.push(noCollector);
    for (const def of bad) expect(() => ex.configure(def, 'full')).toThrow(RangeError);
    // every other rule the contract lists, each alone on an otherwise valid i4
    const rules: [string, (d: EngineDef) => void][] = [
      ['no combustion entry', (d) => (d.spec.combustion = [])],
      [
        '17 combustion entries',
        (d) => {
          d.spec.combustion = Array.from({ length: 17 }, (_, i) => ({ angleDeg: i * 40, bank: 0 }));
          d.voicing.headersM = new Array<number>(17).fill(0.6);
        },
      ],
      ['a zero header length', (d) => (d.voicing.headersM[0] = 0)],
      ['a NaN header length', (d) => (d.voicing.headersM[2] = Number.NaN)],
      ['bank 16', (d) => (d.spec.combustion[0] = { angleDeg: 0, bank: 16 })],
      ['a fractional bank', (d) => (d.spec.combustion[0] = { angleDeg: 0, bank: 0.5 })],
      ['9 collectors', (d) => (d.voicing.collectors = Array.from({ length: 9 }, () => ({ banks: [0], lengthM: 0.35 })))],
      ['a zero collector length', (d) => (d.voicing.collectors = [{ banks: [0], lengthM: 0 }])],
      ['a zero mid-pipe', (d) => (d.voicing.exhaust.midPipeM = 0)],
      ['a negative tailpipe', (d) => (d.voicing.exhaust.tailpipeM = -0.5)],
      ['a NaN muffler section', (d) => (d.voicing.exhaust.mufflerSectionsM[1] = Number.NaN)],
    ];
    for (const [rule, change] of rules) {
      const def = loadFixture('i4-test');
      change(def);
      expect(() => ex.configure(def, 'full'), rule).toThrow(RangeError);
    }
    // still the i4 network: bit-identical to a fresh one
    const ref = new ExhaustNetwork(FS);
    ref.configure(good, 'full');
    const a = drive(ex, good, 2000, () => 0);
    const b = drive(ref, good, 2000, () => 0);
    expect(Array.from(a.out)).toEqual(Array.from(b.out));
  });

  it('configure() starts from valve 0, turbine attenuation 0, cold speeds and cleared state whatever came before', () => {
    const def = loadFixture('i4-test'); // turbo with a fitted valve
    const ex = network('i4-test', 'full', HOT, 1);
    ex.setTurbineAttenuation(1);
    drive(ex, def, 2400, () => 1); // leaves wave and filter state behind
    ex.configure(def, 'full');
    const ref = new ExhaustNetwork(FS);
    ref.configure(def, 'full');
    const gen = pulseTrain(def, 3000);
    const hin = new Float64Array(16);
    const a: number[] = [];
    const b: number[] = [];
    for (let n = 0; n < 4800; n++) {
      if (n === 2400) {
        // a stale cached speed would turn this into a no-op on one of the two
        ex.setGasSpeeds(...HOT);
        ref.setGasSpeeds(...HOT);
      }
      gen(n, hin);
      ex.tick(hin, 0);
      ref.tick(hin, 0);
      a.push(ex.outlet);
      b.push(ref.outlet);
    }
    expect(a).toEqual(b);
  });
});

describe('ExhaustNetwork: passivity (impulse decay)', () => {
  it.each(FIXTURE_IDS)('%s: every tier × valve {0,1} × speeds {cold, hot} decays monotonically to −120 dB within 2 s', (id) => {
    for (const tier of TIERS) {
      for (const valve of [0, 1]) {
        for (const speeds of [COLD, HOT]) {
          expectImpulseDecay(network(id, tier, speeds, valve), FS, `${id} ${tier} valve=${valve} c=${speeds[0]}`);
        }
      }
    }
  });

  it('twin-turbo v8-crossplane-test (one turbine 2-port per collector, B11): every tier × valve {0,1} × speeds {cold, hot} decays monotonically to −120 dB within 2 s', () => {
    for (const tier of TIERS) {
      for (const valve of [0, 1]) {
        for (const speeds of [COLD, HOT]) {
          const label = `twin-turbo v8 ${tier} valve=${valve} c=${speeds[0]}`;
          expectImpulseDecay(networkOf(twinTurboV8(), tier, speeds, valve), FS, label);
        }
      }
    }
  });
});

describe('ExhaustNetwork: acoustics', () => {
  it('a single closed–open tube resonates at the quarter-wave frequencies c/4L, 3c/4L (not c/2L)', () => {
    for (const [L, c] of [
      [0.5, 343],
      [0.3, 700],
    ] as const) {
      const wg = new Waveguide(512);
      wg.configure(L, c, FS, 0);
      const y = new Float64Array(FS / 2);
      for (let n = 0; n < y.length; n++) {
        const atOpen = wg.outRight();
        const atClosed = wg.outLeft();
        const refl = terminationReflect(atOpen, -0.95);
        y[n] = atOpen - refl;
        wg.input((n === 0 ? 1 : 0) + terminationReflect(atClosed, 0.95), refl);
      }
      const f1 = c / (4 * L);
      const peakIn = (lo: number, hi: number) => {
        let best = 0;
        let bestF = 0;
        for (let f = lo; f <= hi; f += 0.1) {
          const m = magAt(y, f);
          if (m > best) {
            best = m;
            bestF = f;
          }
        }
        return { f: bestF, m: best };
      };
      const p1 = peakIn(0.8 * f1, 1.2 * f1);
      const p3 = peakIn(2.8 * f1, 3.2 * f1);
      expect(Math.abs(p1.f / f1 - 1)).toBeLessThan(0.005);
      expect(Math.abs(p3.f / (3 * f1) - 1)).toBeLessThan(0.005);
      expect(20 * Math.log10(magAt(y, 2 * f1) / p1.m)).toBeLessThan(-20);
    }
  });

  it('the first arrival at the outlet takes header + collector + mid-pipe + tailpipe travel time', () => {
    const def = loadFixture('i6-test'); // NA: no turbine link sample
    for (const [speeds, ch, cc, cm] of [
      [COLD, 343, 343, 343],
      [HOT, 700, 560, 460],
    ] as const) {
      const ex = network('i6-test', 'full', speeds);
      const hin = new Float64Array(16);
      const out: number[] = [];
      const tap: number[] = [];
      for (let n = 0; n < 1500; n++) {
        hin[0] = n === 0 ? 1 : 0;
        ex.tick(hin, 0);
        out.push(ex.outlet);
        tap.push(ex.collectorTap);
      }
      const v = def.voicing;
      const dHeader = ((v.headersM[0] ?? 0) / ch) * FS;
      const total =
        dHeader +
        ((v.collectors[0]?.lengthM ?? 0) / cc) * FS +
        (v.exhaust.midPipeM / cm) * FS +
        (v.exhaust.tailpipeM / cm) * FS;
      const peak = Math.max(...out.map(Math.abs));
      const first = out.findIndex((x) => Math.abs(x) > 1e-6 * peak);
      expect(Math.abs(first - total)).toBeLessThanOrEqual(6);
      let peakIdx = first;
      for (let i = first; i < first + 40; i++) if (Math.abs(out[i] ?? 0) > Math.abs(out[peakIdx] ?? 0)) peakIdx = i;
      expect(peakIdx - total).toBeGreaterThanOrEqual(-2);
      expect(peakIdx - total).toBeLessThanOrEqual(8);
      const firstTap = tap.findIndex((x) => Math.abs(x) > 1e-9);
      expect(Math.abs(firstTap - dHeader)).toBeLessThanOrEqual(3);
    }
  });

  it('opening a fitted valve makes the outlet louder, openGainDb acts outside the loop, an unfitted valve is ignored', () => {
    const v8 = loadFixture('v8-crossplane-test');
    const closed = drive(network('v8-crossplane-test', 'full', HOT, 0), v8, FS, () => 0);
    const open = drive(network('v8-crossplane-test', 'full', HOT, 1), v8, FS, () => 1);
    expect(20 * Math.log10(rms(open.out, FS / 2) / rms(closed.out, FS / 2))).toBeGreaterThan(3);
    // +6 dB more open gain scales the open-valve outlet exactly (an outlet-tap gain, never in a loop)
    const louder = loadFixture('v8-crossplane-test');
    louder.voicing.exhaust.valve.openGainDb += 6;
    const ex = new ExhaustNetwork(FS);
    ex.configure(louder, 'full');
    ex.setGasSpeeds(...HOT);
    ex.setValve(1);
    ex.reset();
    const boosted = drive(ex, louder, 4800, () => 1);
    const g = Math.pow(10, 6 / 20);
    for (let i = 0; i < 4800; i++) expect(boosted.out[i]).toBeCloseTo((open.out[i] ?? 0) * g, 12);
    const i6 = loadFixture('i6-test'); // valve.fitted = false
    const a = drive(network('i6-test', 'full', HOT, 0), i6, 4800, () => 0);
    const b = drive(network('i6-test', 'full', HOT, 1), i6, 4800, () => 1);
    expect(Array.from(b.out)).toEqual(Array.from(a.out));
  });

  it('turbine attenuation lowers a turbo engine and leaves an NA engine untouched', () => {
    const i4 = loadFixture('i4-test');
    const free = network('i4-test', 'full');
    const choked = network('i4-test', 'full');
    choked.setTurbineAttenuation(1);
    const a = drive(free, i4, FS / 2, () => 0);
    const b = drive(choked, i4, FS / 2, () => 0);
    expect(rms(b.out, FS / 4)).toBeLessThan(rms(a.out, FS / 4) * 0.9);
    const v8 = loadFixture('v8-crossplane-test');
    const na = network('v8-crossplane-test', 'full');
    na.setTurbineAttenuation(1);
    const c = drive(na, v8, 4800, () => 0);
    const d = drive(network('v8-crossplane-test', 'full'), v8, 4800, () => 0);
    expect(Array.from(c.out)).toEqual(Array.from(d.out));
  });

  it('gas speeds are clamped to [343, 700] m/s and NaN keeps the previous speeds', () => {
    const def = loadFixture('v8-flatplane-test');
    const ref = network('v8-flatplane-test', 'full', HOT);
    const clamped = network('v8-flatplane-test', 'full', [5000, 560, 460]);
    expect(Array.from(drive(clamped, def, 3000, () => 0).out)).toEqual(Array.from(drive(ref, def, 3000, () => 0).out));
    const low = network('v8-flatplane-test', 'full', [1, 1, 1]);
    const cold = network('v8-flatplane-test', 'full', COLD);
    expect(Array.from(drive(low, def, 3000, () => 0).out)).toEqual(Array.from(drive(cold, def, 3000, () => 0).out));
    const nan = network('v8-flatplane-test', 'full', HOT);
    nan.setGasSpeeds(NaN, NaN, NaN);
    const ref2 = network('v8-flatplane-test', 'full', HOT);
    expect(Array.from(drive(nan, def, 3000, () => 0).out)).toEqual(Array.from(drive(ref2, def, 3000, () => 0).out));
    expect(SPEED_OF_SOUND_MAX).toBe(700);
  });

  it('Lite sums the pulses of a bank (summing inputs is equivalent to one input carrying the sum)', () => {
    const a = network('v8-crossplane-test', 'lite');
    const b = network('v8-crossplane-test', 'lite');
    const hinA = new Float64Array(16);
    const hinB = new Float64Array(16);
    for (let n = 0; n < 3000; n++) {
      const x = n < 100 ? Math.sin(n * 0.05) : 0;
      hinA[0] = 0.5 * x; // entries 0 and 2 are both bank 0
      hinA[2] = 0.5 * x;
      hinB[0] = x;
      a.tick(hinA, 0);
      b.tick(hinB, 0);
      expect(a.outlet).toBe(b.outlet);
    }
  });

  it('pops injected at the collectors ring through the network; collectorTap follows the junctions', () => {
    const ex = network('i4-test', 'full');
    const hin = new Float64Array(16);
    let peak = 0;
    for (let n = 0; n < 4800; n++) {
      ex.tick(hin, n === 0 ? 1 : 0);
      peak = Math.max(peak, Math.abs(ex.outlet));
    }
    expect(peak).toBeGreaterThan(1e-3);
    expect(Number.isFinite(ex.energy())).toBe(true);
    const tapNet = network('i4-test', 'full');
    hin[0] = 1;
    tapNet.tick(hin, 0);
    expect(tapNet.collectorTap).toBe(0); // the pulse has not reached the junction yet
  });

  it('reset() clears every state so a replay is bit-identical (deterministic)', () => {
    const def = loadFixture('rotary-test');
    const ex = network('rotary-test', 'full');
    const first = drive(ex, def, 6000, () => 0);
    ex.reset();
    expect(ex.energy()).toBe(0);
    expect(ex.outlet).toBe(0);
    const second = drive(ex, def, 6000, () => 0);
    expect(Array.from(second.out)).toEqual(Array.from(first.out));
  });

  it('reset() keeps the valve target and the turbine attenuation: a replay equals a fresh network with the same settings', () => {
    const def = loadFixture('i4-test'); // turbo, valve fitted
    const ex = network('i4-test', 'full', HOT, 1);
    ex.setTurbineAttenuation(1);
    drive(ex, def, 2400, () => 1); // leaves wave and filter state behind
    ex.reset();
    const replay = drive(ex, def, 4800, () => 1);
    const fresh = network('i4-test', 'full', HOT, 1);
    fresh.setTurbineAttenuation(1);
    const ref = drive(fresh, def, 4800, () => 1);
    expect(rms(ref.out, 2400)).toBeGreaterThan(1e-3);
    expect(Array.from(replay.out)).toEqual(Array.from(ref.out));
  });

  it('tick() reads headerIn entries beyond the end of the array as 0', () => {
    const def = loadFixture('i4-test'); // 4 entries
    const short = network('i4-test', 'full');
    const long = network('i4-test', 'full');
    const gen = pulseTrain(def, 3000);
    const pulses = new Float64Array(16);
    const two = new Float64Array(2);
    const sixteen = new Float64Array(16); // entries 2 and 3 stay 0
    const a = new Float64Array(4800);
    const b = new Float64Array(4800);
    for (let n = 0; n < 4800; n++) {
      gen(n, pulses);
      two[0] = pulses[0] ?? 0;
      two[1] = pulses[1] ?? 0;
      sixteen[0] = two[0];
      sixteen[1] = two[1];
      short.tick(two, 0);
      long.tick(sixteen, 0);
      a[n] = short.outlet;
      b[n] = long.outlet;
    }
    expect(rms(b, 2400)).toBeGreaterThan(1e-3);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('a turbine exists only for turbo aspiration with turbine voicing: other engines ignore turbine voicing, a turbo engine without it sounds NA', () => {
    for (const id of ['v8-sc-test', 'i6-test'] as const) {
      const stock = loadFixture(id); // supercharged / NA
      expect(stock.spec.aspiration.type, id).not.toBe('turbo');
      const withTurbine = loadFixture(id);
      withTurbine.voicing.turbine = { reflection: 0.45, lpHz: 1500 };
      const ex = networkOf(withTurbine, 'full');
      ex.setTurbineAttenuation(1); // a stray turbine would also attenuate
      const a = drive(ex, withTurbine, 4800, () => 0);
      const b = drive(network(id, 'full'), stock, 4800, () => 0);
      expect(rms(b.out, 2400), id).toBeGreaterThan(1e-3);
      expect(Array.from(a.out), id).toEqual(Array.from(b.out));
    }
    const noTurbine = loadFixture('i4-test'); // turbo aspiration, no turbine voicing
    noTurbine.voicing.turbine = null;
    const na = loadFixture('i4-test');
    na.spec.aspiration = { type: 'na', turbo: null, supercharger: null };
    na.voicing.turbine = null;
    const ex = networkOf(noTurbine, 'full');
    ex.setTurbineAttenuation(1);
    const c = drive(ex, noTurbine, 4800, () => 0);
    const d = drive(networkOf(na, 'full'), na, 4800, () => 0);
    expect(Array.from(c.out)).toEqual(Array.from(d.out));
  });

  it('Lite equals Full wherever merging a bank is exact (one header length per bank, ≤ 2 muffler sections)', () => {
    // A Lite header (admittance = entry count, fed the bank's summed pulses ÷ entry count) carries the
    // sum of the Full headers' waves, so with equal lengths per bank and no chamber dropped the outlets
    // agree. (Where Lite drops chambers the level legitimately differs, so no level comparison there.)
    for (const id of ['rotary-test', 'v8-flatplane-test'] as const) {
      const def = loadFixture(id);
      expect(def.voicing.exhaust.mufflerSectionsM.length).toBeLessThanOrEqual(2);
      def.spec.combustion.forEach((c, i) => {
        const first = def.spec.combustion.findIndex((o) => o.bank === c.bank);
        expect(def.voicing.headersM[i]).toBe(def.voicing.headersM[first]);
      });
      for (const valve of [0, 1]) {
        const full = drive(network(id, 'full', HOT, valve), def, 9600, () => valve).out;
        const lite = drive(network(id, 'lite', HOT, valve), def, 9600, () => valve).out;
        let peak = 0;
        let maxDiff = 0;
        for (let i = 0; i < full.length; i++) {
          peak = Math.max(peak, Math.abs(full[i] ?? 0));
          maxDiff = Math.max(maxDiff, Math.abs((lite[i] ?? 0) - (full[i] ?? 0)));
        }
        const label = `${id} valve=${valve}`;
        expect(peak, label).toBeGreaterThan(0.05);
        expect(maxDiff, label).toBeLessThan(1e-6);
      }
    }
  });

  it('B11: an entry reaches the outlet through the collector that lists its bank (first arrival)', () => {
    const def = loadFixture('i6-test'); // NA; bank 0 = entries 0–2 on collectors[0], bank 1 = entries 3–5 on collectors[1]
    const v = def.voicing;
    const second = v.collectors[1];
    if (second === undefined) throw new Error('i6-test has two collectors');
    second.lengthM = 0.9; // collectors[0] stays 0.35 m: the two paths differ by ≈ 47 samples when hot
    for (const [entry, collector] of [
      [0, 0],
      [3, 1],
    ] as const) {
      const ex = networkOf(def, 'full', HOT);
      const hin = new Float64Array(16);
      const out: number[] = [];
      for (let n = 0; n < 1500; n++) {
        hin[entry] = n === 0 ? 1 : 0;
        ex.tick(hin, 0);
        out.push(ex.outlet);
      }
      const total =
        ((v.headersM[entry] ?? 0) / 700 +
          (v.collectors[collector]?.lengthM ?? 0) / 560 +
          (v.exhaust.midPipeM + v.exhaust.tailpipeM) / 460) *
        FS;
      const peak = Math.max(...out.map(Math.abs));
      const first = out.findIndex((x) => Math.abs(x) > 1e-6 * peak);
      expect(Math.abs(first - total), `entry ${entry}`).toBeLessThanOrEqual(6);
    }
  });
});

describe('ExhaustNetwork: RF5 valve toggling', () => {
  it.each([
    ['v8-crossplane-test', 'full', 0.2],
    ['v8-crossplane-test', 'full', 0.15],
    ['i4-test', 'lite', 0.2],
  ] as const)(
    '%s %s: valve toggled 0↔1 every 20 ms for 2 s through a %s s caller slew stays bounded and click-free',
    (id, tier, slewS) => {
      const def = loadFixture(id);
      const n = 2 * FS;
      const static0 = drive(network(id, tier, HOT, 0), def, n, () => 0);
      const static1 = drive(network(id, tier, HOT, 1), def, n, () => 1);
      const slew = new Slew();
      slew.setRate(1 / slewS, FS);
      slew.reset(0);
      const ex = network(id, tier, HOT, 0);
      const toggled = drive(ex, def, n, (i) => slew.process(Math.floor(i / 960) % 2 === 0 ? 1 : 0));
      expect(toggled.finite).toBe(true);
      const energyRef = Math.max(static0.energyMax, static1.energyMax);
      expect(toggled.energyMax).toBeLessThanOrEqual(1.25 * energyRef);
      const jumpRef = Math.max(static0.maxJump, static1.maxJump);
      expect(toggled.maxJump).toBeLessThanOrEqual(0.1); // full scale = 1.0
      expect(toggled.maxJump).toBeLessThanOrEqual(1.25 * jumpRef);
      // keep toggling without excitation: the network still decays (bounded, no self-oscillation)
      const hin = new Float64Array(16);
      let last = 0;
      for (let i = 0; i < FS; i++) {
        ex.setValve(slew.process(Math.floor((n + i) / 960) % 2 === 0 ? 1 : 0));
        ex.tick(hin, 0);
        last = ex.energy();
      }
      expect(last).toBeLessThan(1e-6 * energyRef);
    },
  );

  it('the internal anti-zipper smoothing keeps even an unslewed 0↔1 toggle click-free', () => {
    const def = loadFixture('v8-crossplane-test');
    const static1 = drive(network('v8-crossplane-test', 'full', HOT, 1), def, FS, () => 1);
    const raw = drive(network('v8-crossplane-test', 'full', HOT, 0), def, FS, (i) => (Math.floor(i / 960) % 2 === 0 ? 1 : 0));
    expect(raw.finite).toBe(true);
    expect(raw.maxJump).toBeLessThanOrEqual(0.1);
    expect(raw.maxJump).toBeLessThanOrEqual(1.25 * static1.maxJump);
  });
});

describe('ExhaustNetwork: contract constants (white-box)', () => {
  interface Rails { lpR: OnePole; lpL: OnePole }
  interface Inner {
    colls: Waveguide[];
    headers: Waveguide[];
    chambers: Waveguide[];
    mid: Waveguide;
    tail: Waveguide;
    openY: number;
    hpY: number;
    shY: number;
    nCh: number;
    nUnits: number;
    unitColl: Int32Array;
    unitY: Float64Array;
    collY: Float64Array;
    yMid: number;
    yCh: number;
    linkUp: Float64Array;
    linkDown: Float64Array;
    turbR: number;
    turbT: number;
    bypass: number;
    turbGain: number;
    shelfGain: number;
    outGain: number;
  }
  const inner = (ex: ExhaustNetwork): Inner => ex as unknown as Inner;
  /** A section's wall-loss one-poles: lpR feeds the rail written at end A, lpL the rail written at end B. */
  const rails = (wg: Waveguide | undefined): Rails => {
    if (wg === undefined) throw new Error('missing section');
    return wg as unknown as Rails;
  };
  /** One-pole coefficient 1 − e^(−2π·hz/fs) (rail wall loss, open end, outlet filters). */
  const kOf = (hz: number): number => 1 - Math.exp((-2 * Math.PI * hz) / FS);

  it('open end: reflection −0.85·LP1.5k(p⁺) back into the tailpipe (6 kHz wall loss), exit wave p⁺ − p⁻ (B10), then 20 Hz HP → 2 kHz shelf → open gain', () => {
    const ex = network('i6-test', 'full');
    const w = inner(ex);
    const tailRails = rails(w.tail);
    const k = 1 - Math.exp((-2 * Math.PI * 1500) / FS);
    const hpK = 1 - Math.exp((-2 * Math.PI * 20) / FS);
    const shK = 1 - Math.exp((-2 * Math.PI * 2000) / FS);
    const k6 = kOf(6000);
    const hin = new Float64Array(16);
    let maxAbs = 0;
    for (let n = 0; n < 4000; n++) {
      hin[0] = n < 40 ? 1 : 0;
      const pPlus = w.tail.outRight(); // wave arriving at the open end this sample (pure read)
      const lpPrev = w.openY;
      const hpPrev = w.hpY;
      const shPrev = w.shY;
      const tailPrev = tailRails.lpL.y;
      ex.tick(hin, 0);
      const lp = k * pPlus + (1 - k) * lpPrev;
      expect(tailRails.lpL.y).toBeCloseTo(k6 * (-0.85 * lp) + (1 - k6) * tailPrev, 12); // p⁻ enters at the open end
      const exit = pPlus + 0.85 * lp; // p⁺ − p⁻ with p⁻ = −0.85·lp
      const hp = exit - (hpK * exit + (1 - hpK) * hpPrev);
      const lo = shK * hp + (1 - shK) * shPrev;
      expect(ex.outlet).toBeCloseTo(w.outGain * (lo + w.shelfGain * (hp - lo)), 12);
      maxAbs = Math.max(maxAbs, Math.abs(ex.outlet));
    }
    expect(maxAbs).toBeGreaterThan(1e-3); // the check ran on real signal
  });

  it('closed ends: cylinder r = +0.7 into each header, chamber far end r = +0.9 (through each rail’s wall-loss one-pole)', () => {
    const ex = network('i6-test', 'full');
    const w = inner(ex);
    const h0 = w.headers[0];
    const c0 = w.chambers[0];
    if (h0 === undefined || c0 === undefined) throw new Error('missing sections');
    const hr = h0 as unknown as Rails;
    const cr = c0 as unknown as Rails;
    const kH = 1 - Math.exp((-2 * Math.PI * 9000) / FS);
    const kC = 1 - Math.exp((-2 * Math.PI * 4000) / FS);
    const hin = new Float64Array(16);
    let seenH = 0;
    let seenC = 0;
    for (let n = 0; n < 6000; n++) {
      const x = n < 40 ? 1 : 0;
      hin[0] = x;
      const atCylinder = h0.outLeft(); // left-going wave arriving at the cylinder end
      const atFarEnd = c0.outRight(); // right-going wave arriving at chamber 0's closed end
      const hPrev = hr.lpR.y;
      const cPrev = cr.lpL.y;
      ex.tick(hin, 0);
      expect(hr.lpR.y).toBeCloseTo(kH * (x + 0.7 * atCylinder) + (1 - kH) * hPrev, 12);
      expect(cr.lpL.y).toBeCloseTo(kC * (0.9 * atFarEnd) + (1 - kC) * cPrev, 12);
      if (Math.abs(atCylinder) > 1e-4) seenH++;
      if (Math.abs(atFarEnd) > 1e-4) seenC++;
    }
    expect(seenH).toBeGreaterThan(100);
    expect(seenC).toBeGreaterThan(100);
  });

  it('Lite keeps at most 2 chambers; B7 bypass weight 0.7·valve; turbine transmission × (1 − 0.5·attenuation), attenuation clamped into [0, 1] (NaN → 0)', () => {
    expect(inner(network('i6-test', 'full')).nCh).toBe(4);
    expect(inner(network('i6-test', 'lite')).nCh).toBe(2);
    expect(inner(network('v8-crossplane-test', 'full', HOT, 1)).bypass).toBeCloseTo(0.7, 12);
    expect(inner(network('v8-crossplane-test', 'full', HOT, 0.5)).bypass).toBeCloseTo(0.35, 12);
    const t = network('i4-test', 'full');
    t.setTurbineAttenuation(1);
    expect(inner(t).turbGain).toBe(0.5);
    t.setTurbineAttenuation(0.4);
    expect(inner(t).turbGain).toBeCloseTo(0.8, 12);
    t.setTurbineAttenuation(5); // unclamped this would be an in-loop gain of −1.5
    expect(inner(t).turbGain).toBe(0.5);
    t.setTurbineAttenuation(-1);
    expect(inner(t).turbGain).toBe(1);
    t.setTurbineAttenuation(0.4);
    t.setTurbineAttenuation(Number.NaN);
    expect(inner(t).turbGain).toBe(1);
  });

  it('a pop is split equally over the collectors (popIn / collectors into each collector tube)', () => {
    const ex = network('i6-test', 'full'); // 2 collectors, silent network
    const w = inner(ex);
    ex.tick(new Float64Array(16), 1);
    const k7 = 1 - Math.exp((-2 * Math.PI * 7000) / FS);
    for (const c of [0, 1]) {
      const wg = w.colls[c];
      if (wg === undefined) throw new Error('missing collector');
      expect((wg as unknown as Rails).lpR.y).toBeCloseTo(k7 * 0.5, 12);
    }
  });

  it('B11 topology: a bank joins the first collector that lists it (unlisted → collector 0); Full = one header per entry (Y 1), Lite = one per bank (Y = its entry count)', () => {
    const topology = (def: EngineDef, tier: Tier): { coll: number[]; y: number[] } => {
      const w = inner(networkOf(def, tier));
      return { coll: Array.from(w.unitColl.slice(0, w.nUnits)), y: Array.from(w.unitY.slice(0, w.nUnits)) };
    };
    const i6 = loadFixture('i6-test'); // banks [0, 0, 0, 1, 1, 1]; collectors list [0] and [1]
    expect(topology(i6, 'full')).toEqual({ coll: [0, 0, 0, 1, 1, 1], y: [1, 1, 1, 1, 1, 1] });
    expect(topology(i6, 'lite')).toEqual({ coll: [0, 1], y: [3, 3] });
    const overlap = loadFixture('i6-test');
    overlap.voicing.collectors = [
      { banks: [1], lengthM: 0.35 },
      { banks: [0, 1], lengthM: 0.35 },
    ];
    expect(topology(overlap, 'full').coll).toEqual([1, 1, 1, 0, 0, 0]); // bank 1 stays on collectors[0]
    const unlisted = loadFixture('i6-test');
    unlisted.voicing.collectors = [
      { banks: [1], lengthM: 0.35 },
      { banks: [2], lengthM: 0.35 },
    ];
    expect(topology(unlisted, 'full').coll).toEqual([0, 0, 0, 0, 0, 0]); // bank 0 is listed nowhere
    // one collector listing two banks joins both banks' headers (rotary-test: banks [0, 1])
    expect(topology(loadFixture('rotary-test'), 'lite')).toEqual({ coll: [0, 0], y: [3, 3] });
    expect(topology(loadFixture('v8-crossplane-test'), 'lite')).toEqual({ coll: [0, 1], y: [4, 4] });
  });

  it('admittances and valve laws: collector 0.5·(entries + 1), mid 0.6·Σ collectors, chamber Y_mid·(0.6 + 0.4·ma·(1 − v)), bypass 0.7·v, shelf 4·v − 6·ma·(1 − v) dB, open gain openGainDb·v', () => {
    // both V8s: 2 collectors × 4 entries → Y_collector 2.5, Y_mid 3; ma 0.5 / 0.4, open gain 4 / 5 dB
    for (const id of ['v8-crossplane-test', 'v8-flatplane-test'] as const) {
      const e = loadFixture(id).voicing.exhaust;
      for (const tier of TIERS) {
        for (const v of [0, 0.5, 1]) {
          const w = inner(network(id, tier, HOT, v));
          const label = `${id} ${tier} v=${v}`;
          expect(Array.from(w.collY.slice(0, 2)), label).toEqual([2.5, 2.5]);
          expect(w.yMid, label).toBeCloseTo(3, 12);
          expect(w.yCh, label).toBeCloseTo(3 * (0.6 + 0.4 * e.mufflerAction * (1 - v)), 12);
          expect(w.bypass, label).toBeCloseTo(0.7 * v, 12);
          expect(w.shelfGain, label).toBeCloseTo(10 ** ((4 * v - 6 * e.mufflerAction * (1 - v)) / 20), 12);
          expect(w.outGain, label).toBeCloseTo(10 ** ((e.valve.openGainDb * v) / 20), 12);
        }
      }
    }
    for (const [id, collY, yMid] of [
      ['i4-test', [2.5], 1.5], // 1 collector × 4 entries
      ['i6-test', [2, 2], 2.4], // 2 collectors × 3 entries
    ] as const) {
      const w = inner(network(id, 'full'));
      expect(Array.from(w.collY.slice(0, collY.length)), id).toEqual(collY);
      expect(w.yMid, id).toBeCloseTo(yMid, 12);
    }
  });

  it('setValve: target clamped (NaN → 0) and reached by a linear 20 ms internal slew that every valve law follows (multi-call)', () => {
    const def = loadFixture('v8-crossplane-test'); // ma 0.5, open gain 4 dB, Y_mid 3
    const e = def.voicing.exhaust;
    const ex = network('v8-crossplane-test', 'full', HOT, 0);
    const w = inner(ex);
    const hin = new Float64Array(16);
    const ticks = (count: number): void => {
      for (let i = 0; i < count; i++) ex.tick(hin, 0);
    };
    const lawsAt = (v: number, label: string): void => {
      expect(w.bypass, label).toBeCloseTo(0.7 * v, 9);
      expect(w.yCh, label).toBeCloseTo(3 * (0.6 + 0.4 * e.mufflerAction * (1 - v)), 9);
      expect(w.shelfGain, label).toBeCloseTo(10 ** ((4 * v - 6 * e.mufflerAction * (1 - v)) / 20), 9);
      expect(w.outGain, label).toBeCloseTo(10 ** ((e.valve.openGainDb * v) / 20), 9);
    };
    ex.setValve(7); // clamped to 1
    ticks(1);
    lawsAt(1 / 960, '1 sample'); // the full range takes 20 ms = 960 samples at 48 kHz
    ticks(479);
    lawsAt(0.5, '480 samples');
    ticks(479);
    expect(w.bypass).toBeLessThan(0.7); // 959 samples: not there yet
    ticks(1);
    lawsAt(1, '960 samples');
    ticks(960);
    lawsAt(1, 'held at the clamped target');
    ex.setValve(Number.NaN); // NaN → 0
    ticks(480);
    lawsAt(0.5, 'closing, 480 samples');
    ticks(480);
    lawsAt(0, 'closed');
  });

  it('merge junction (B11) joins every collector and the mid-pipe; 7 kHz collector and 6 kHz mid-pipe wall loss', () => {
    const def = loadFixture('i6-test'); // NA: the collectors meet the merge junction directly
    const ex = network('i6-test', 'full');
    const w = inner(ex);
    const yColl = 0.5 * (3 + 1); // 3 entries per collector
    const yMid = 0.6 * 2 * yColl;
    const k6 = kOf(6000);
    const k7 = kOf(7000);
    const c0 = rails(w.colls[0]);
    const c1 = rails(w.colls[1]);
    const mid = rails(w.mid);
    const gen = pulseTrain(def, 3000);
    const hin = new Float64Array(16);
    let seen0 = 0;
    let seen1 = 0;
    for (let n = 0; n < 2400; n++) {
      gen(n, hin);
      const a0 = w.colls[0]?.outRight() ?? Number.NaN; // collector waves arriving at the merge junction
      const a1 = w.colls[1]?.outRight() ?? Number.NaN;
      const m = w.mid.outLeft(); // mid-pipe wave arriving at the merge junction
      const prev0 = c0.lpL.y;
      const prev1 = c1.lpL.y;
      const prevMid = mid.lpR.y;
      ex.tick(hin, 0);
      const pJ = (2 * (yColl * a0 + yColl * a1 + yMid * m)) / (2 * yColl + yMid);
      expect(c0.lpL.y).toBeCloseTo(k7 * (pJ - a0) + (1 - k7) * prev0, 12);
      expect(c1.lpL.y).toBeCloseTo(k7 * (pJ - a1) + (1 - k7) * prev1, 12);
      expect(mid.lpR.y).toBeCloseTo(k6 * (pJ - m) + (1 - k6) * prevMid, 12);
      if (Math.abs(a0) > 1e-4) seen0++;
      if (Math.abs(a1) > 1e-4) seen1++;
    }
    expect(seen0).toBeGreaterThan(100);
    expect(seen1).toBeGreaterThan(100);
  });

  it('muffler junction with the valve bypass (B7): S = (1 − a)·S_junction + a·S_bypass, a = 0.7·v, Y_tail = Y_mid, chambers absorbed; 6 kHz mid/tail and 4 kHz chamber wall loss', () => {
    const def = loadFixture('v8-crossplane-test'); // valve fitted, 3 chambers, ma 0.5, Y_mid 3
    const e = def.voicing.exhaust;
    const nCh = e.mufflerSectionsM.length;
    const yMid = 3;
    const k4 = kOf(4000);
    const k6 = kOf(6000);
    for (const v of [0, 0.5, 1]) {
      const ex = network('v8-crossplane-test', 'full', HOT, v);
      const w = inner(ex);
      const yCh = yMid * (0.6 + 0.4 * e.mufflerAction * (1 - v));
      const a = 0.7 * v;
      const mid = rails(w.mid);
      const tail = rails(w.tail);
      const kIn = new Float64Array(nCh);
      const kPrev = new Float64Array(nCh);
      const gen = pulseTrain(def, 3000);
      const hin = new Float64Array(16);
      let seen = 0;
      for (let n = 0; n < 2400; n++) {
        gen(n, hin);
        const mR = w.mid.outRight(); // mid-pipe wave arriving at the muffler junction
        const tL = w.tail.outLeft(); // tailpipe wave arriving back at the muffler junction
        let acc = yMid * mR + yMid * tL;
        for (let k = 0; k < nCh; k++) {
          const x = w.chambers[k]?.outLeft() ?? Number.NaN; // chamber wave arriving at the junction
          kIn[k] = x;
          kPrev[k] = rails(w.chambers[k]).lpR.y;
          acc += yCh * x;
        }
        const midPrev = mid.lpL.y;
        const tailPrev = tail.lpR.y;
        ex.tick(hin, 0);
        const pJ = (2 * acc) / (2 * yMid + nCh * yCh);
        const label = `v=${v} n=${n}`;
        // tailpipe input = lerp(mufflerJunctionOut, midPipeOut, a); the mid-pipe gets the mirror image
        expect(tail.lpR.y, label).toBeCloseTo(k6 * ((1 - a) * (pJ - tL) + a * mR) + (1 - k6) * tailPrev, 12);
        expect(mid.lpL.y, label).toBeCloseTo(k6 * ((1 - a) * (pJ - mR) + a * tL) + (1 - k6) * midPrev, 12);
        for (let k = 0; k < nCh; k++) {
          const want = k4 * (1 - a) * (pJ - (kIn[k] ?? 0)) + (1 - k4) * (kPrev[k] ?? 0);
          expect(rails(w.chambers[k]).lpR.y, label).toBeCloseTo(want, 12);
        }
        if (Math.abs(mR) > 1e-4) seen++;
      }
      expect(seen, `v=${v}`).toBeGreaterThan(100);
    }
  });

  it('collectorTap is the mean junction pressure 2·ΣY·p⁺/ΣY of the collector junctions', () => {
    const def = loadFixture('i6-test'); // header Y 1, collector Y 0.5·(3 + 1) = 2; entries 0–2 → collectors[0], 3–5 → [1]
    const ex = network('i6-test', 'full');
    const w = inner(ex);
    const gen = pulseTrain(def, 3000);
    const hin = new Float64Array(16);
    let seen = 0;
    for (let n = 0; n < 2400; n++) {
      gen(n, hin);
      let sum = 0;
      for (let c = 0; c < 2; c++) {
        let acc = 2 * (w.colls[c]?.outLeft() ?? Number.NaN); // collector wave arriving at its junction
        for (let u = 3 * c; u < 3 * c + 3; u++) acc += w.headers[u]?.outRight() ?? Number.NaN; // header waves
        sum += (2 * acc) / (3 + 2);
      }
      ex.tick(hin, 0);
      expect(ex.collectorTap).toBeCloseTo(sum / 2, 12);
      if (Math.abs(sum) > 1e-4) seen++;
    }
    expect(seen).toBeGreaterThan(100);
  });

  it('turbine 2-port per collector (B11) diag(1, gG)·[[r, t], [t, −r]]·diag(1, gG): G = its own 2-pole Butterworth LP at lpHz both ways, g = 1 − 0.5·attenuation, r clamped to ±0.95', () => {
    for (const [name, def, nColl] of [
      ['i4-test', loadFixture('i4-test'), 1],
      ['twin-turbo v8', twinTurboV8(), 2],
    ] as const) {
      const tb = def.voicing.turbine;
      if (tb === null) throw new Error(`${name} has a turbine`);
      const ex = networkOf(def, 'full');
      ex.setTurbineAttenuation(0.6);
      const w = inner(ex);
      const r = tb.reflection;
      const t = Math.sqrt(1 - r * r);
      const g = 1 - 0.5 * 0.6;
      const k7 = kOf(7000);
      // a replica up/down low-pass pair per collector: no collector may share or skip another's filters
      const up = Array.from({ length: nColl }, () => new Biquad());
      const down = Array.from({ length: nColl }, () => new Biquad());
      for (const lp of [...up, ...down]) lp.lowpass(tb.lpHz, Math.SQRT1_2, FS);
      const a = new Float64Array(nColl);
      const b = new Float64Array(nColl);
      const prev = new Float64Array(nColl);
      const seen = new Array<number>(nColl).fill(0);
      const gen = pulseTrain(def, 3000);
      const hin = new Float64Array(16);
      for (let n = 0; n < 2400; n++) {
        gen(n, hin);
        for (let c = 0; c < nColl; c++) {
          const coll = w.colls[c];
          if (coll === undefined) throw new Error('missing collector');
          a[c] = coll.outRight(); // collector wave arriving at its turbine
          b[c] = g * (up[c]?.process(w.linkUp[c] ?? Number.NaN) ?? Number.NaN); // wave from the merge junction, through the turbine
          prev[c] = rails(coll).lpL.y;
        }
        ex.tick(hin, 0);
        for (let c = 0; c < nColl; c++) {
          const ac = a[c] ?? Number.NaN;
          const bc = b[c] ?? Number.NaN;
          const label = `${name} collector ${c} n=${n}`;
          const want = k7 * (r * ac + t * bc) + (1 - k7) * (prev[c] ?? Number.NaN);
          expect(rails(w.colls[c]).lpL.y, label).toBeCloseTo(want, 12); // back up the collector
          const onward = g * (down[c]?.process(t * ac - r * bc) ?? Number.NaN);
          expect(w.linkDown[c], label).toBeCloseTo(onward, 12); // on to the merge junction
          if (Math.abs(bc) > 1e-4) seen[c] = (seen[c] ?? 0) + 1;
        }
      }
      for (let c = 0; c < nColl; c++) expect(seen[c], `${name} collector ${c}`).toBeGreaterThan(100);
    }
    for (const [given, clamped] of [
      [0.99, 0.95],
      [-2, -0.95],
    ] as const) {
      const d = loadFixture('i4-test');
      if (d.voicing.turbine === null) throw new Error('i4-test has a turbine');
      d.voicing.turbine.reflection = given;
      const wc = inner(networkOf(d, 'full'));
      expect(wc.turbR).toBe(clamped);
      expect(wc.turbT).toBeCloseTo(Math.sqrt(1 - clamped * clamped), 12);
    }
  });

  it('turbo merge junction (B11): every collector joins it through its own 1-sample turbine link each way, plus the mid-pipe (6 kHz wall loss)', () => {
    const def = twinTurboV8(); // Y_collector 2.5 per collector, Y_mid 0.6·(2.5 + 2.5) = 3
    const ex = networkOf(def, 'full');
    ex.setTurbineAttenuation(0.3);
    const w = inner(ex);
    const yColl = 2.5;
    const yMid = 3;
    const k6 = kOf(6000);
    const mid = rails(w.mid);
    const gen = pulseTrain(def, 3000);
    const hin = new Float64Array(16);
    let seen = 0;
    for (let n = 0; n < 2400; n++) {
      gen(n, hin);
      const d0 = w.linkDown[0] ?? Number.NaN; // down-links written one sample ago: what the merge junction reads now
      const d1 = w.linkDown[1] ?? Number.NaN;
      const m = w.mid.outLeft(); // mid-pipe wave arriving at the merge junction
      const prevMid = mid.lpR.y;
      ex.tick(hin, 0);
      const pJ = (2 * (yColl * d0 + yColl * d1 + yMid * m)) / (2 * yColl + yMid);
      const label = `n=${n}`;
      expect(w.linkUp[0], label).toBeCloseTo(pJ - d0, 12); // each up-link carries its own port's outgoing wave
      expect(w.linkUp[1], label).toBeCloseTo(pJ - d1, 12);
      expect(mid.lpR.y, label).toBeCloseTo(k6 * (pJ - m) + (1 - k6) * prevMid, 12);
      if (Math.abs(d0 - d1) > 1e-4) seen++; // the two collectors carry different waves
    }
    expect(seen).toBeGreaterThan(100);
  });

  it('configure() leaves every section cold (343 m/s); setGasSpeeds: header → headers, collector → collectors, muffler → mid-pipe, chambers, tailpipe; a Lite header has its bank’s mean length', () => {
    const def = loadFixture('i6-test'); // 6 headers, 2 collectors, 4 chambers
    const v = def.voicing;
    const e = v.exhaust;
    const ex = new ExhaustNetwork(FS);
    ex.configure(def, 'full');
    const w = inner(ex);
    const delaysAt = (ch: number, cc: number, cm: number): void => {
      const label = `${ch}/${cc}/${cm} m/s`;
      for (let u = 0; u < 6; u++) {
        expect(w.headers[u]?.delaySamples, label).toBeCloseTo(((v.headersM[u] ?? Number.NaN) / ch) * FS, 9);
      }
      for (let c = 0; c < 2; c++) {
        expect(w.colls[c]?.delaySamples, label).toBeCloseTo(((v.collectors[c]?.lengthM ?? Number.NaN) / cc) * FS, 9);
      }
      expect(w.mid.delaySamples, label).toBeCloseTo((e.midPipeM / cm) * FS, 9);
      expect(w.tail.delaySamples, label).toBeCloseTo((e.tailpipeM / cm) * FS, 9);
      for (let k = 0; k < 4; k++) {
        expect(w.chambers[k]?.delaySamples, label).toBeCloseTo(((e.mufflerSectionsM[k] ?? Number.NaN) / cm) * FS, 9);
      }
    };
    delaysAt(343, 343, 343);
    ex.setGasSpeeds(...HOT);
    delaysAt(700, 560, 460);
    ex.setGasSpeeds(Number.NaN, 400, Number.NaN); // NaN keeps that group's speed
    delaysAt(700, 400, 460);
    // Lite: one header per bank with the bank's mean length (i5-test: one bank, five different lengths)
    const i5 = loadFixture('i5-test');
    const lengths = i5.voicing.headersM.slice(0, i5.spec.combustion.length);
    const lite = inner(networkOf(i5, 'lite'));
    expect(lite.nUnits).toBe(1);
    expect(lite.headers[0]?.delaySamples).toBeCloseTo((lengths.reduce((s, x) => s + x, 0) / lengths.length / 700) * FS, 9);
  });

  it.each([28000, 44100, 48000, 96000])(
    'at %i Hz lengths are clamped into [4.5 samples at 700 m/s, contract max], so schema-valid extremes configure without throwing, every delay fits its capacity (B3, cold and hot) and the network stays passive',
    (fs) => {
      const MAX_M = { header: 1.5, collector: 1.0, midPipe: 3.0, mufflerSection: 0.8, tailpipe: 1.2 }; // contract maxima
      const minM = (4.5 * 700) / fs;
      const clampM = (x: number, max: number): number => Math.min(Math.max(x, minM), max);
      // every section of i6-test (6 headers, 2 collectors, 4 muffler sections) set to one length per group
      const cases: [string, { h: number; c: number; m: number; t: number; k: number }][] = [
        ['schema maxima (all beyond the contract maxima)', { h: 3, c: 2, m: 5, t: 3, k: 2 }],
        ['schema minima (0.05 m is under 4.5 samples at 700 m/s below 63 kHz)', { h: 0.1, c: 0.05, m: 0.1, t: 0.05, k: 0.05 }],
        ['far below the minimum', { h: 1e-4, c: 1e-4, m: 1e-4, t: 1e-4, k: 1e-4 }],
      ];
      for (const [name, L] of cases) {
        const def = loadFixture('i6-test');
        const v = def.voicing;
        v.headersM = v.headersM.map(() => L.h);
        v.collectors = v.collectors.map((col) => ({ ...col, lengthM: L.c }));
        v.exhaust.midPipeM = L.m;
        v.exhaust.tailpipeM = L.t;
        v.exhaust.mufflerSectionsM = v.exhaust.mufflerSectionsM.map(() => L.k);
        for (const tier of TIERS) {
          const label = `${name}, ${tier}, ${fs} Hz`;
          const ex = new ExhaustNetwork(fs);
          ex.configure(loadFixture('i4-test'), 'full'); // a previous engine, as when switching engines
          expect(() => ex.configure(def, tier), label).not.toThrow();
          const w = inner(ex);
          expect(w.nUnits, label).toBe(tier === 'full' ? 6 : 2);
          expect(w.nCh, label).toBe(tier === 'full' ? 4 : 2);
          const delaysAt = (ch: number, cc: number, cm: number): void => {
            const at = `${label}, ${ch}/${cc}/${cm} m/s`;
            for (let u = 0; u < w.nUnits; u++) {
              expect(w.headers[u]?.delaySamples, at).toBeCloseTo((clampM(L.h, MAX_M.header) / ch) * fs, 9);
            }
            for (let c = 0; c < 2; c++) {
              expect(w.colls[c]?.delaySamples, at).toBeCloseTo((clampM(L.c, MAX_M.collector) / cc) * fs, 9);
            }
            expect(w.mid.delaySamples, at).toBeCloseTo((clampM(L.m, MAX_M.midPipe) / cm) * fs, 9);
            expect(w.tail.delaySamples, at).toBeCloseTo((clampM(L.t, MAX_M.tailpipe) / cm) * fs, 9);
            for (let k = 0; k < w.nCh; k++) {
              expect(w.chambers[k]?.delaySamples, at).toBeCloseTo((clampM(L.k, MAX_M.mufflerSection) / cm) * fs, 9);
            }
          };
          delaysAt(343, 343, 343);
          expectImpulseDecay(ex, fs, `${label}, cold`);
          ex.setGasSpeeds(...HOT);
          ex.reset();
          delaysAt(700, 560, 460);
          expectImpulseDecay(ex, fs, `${label}, hot`);
        }
      }
    },
  );
});
