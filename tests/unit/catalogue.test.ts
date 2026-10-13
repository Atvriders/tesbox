import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { ETA_DRIVETRAIN, type TeslaParams, type TeslaRecord } from '../../src/contracts';
import { notListedParams, resolveTeslaParams, ROADLOAD, TESLAS } from '../../src/data/catalogue';
import roadloadSchema from '../../src/data/schema/roadload.schema.json';
import teslaSchema from '../../src/data/schema/tesla.schema.json';
import paramsJson from '../../src/data/tesla-params.json';
import { DEMO_PROFILE, DemoDriver, PedalPhysics, type PedalCommand } from '../../src/sim/demo';
import { rawLoad } from '../../src/sim/load';
import { accelTimeS, fitParams, FIT_DT_S, targetSpeedMps, targetTimeS } from '../../tools/build-catalogue';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const KMH = 1 / 3.6;

/** Every Model S/X/3/Y/Y L/Cybertruck generation + trim since 2012 (plan T11 coverage table). */
const EXPECTED_IDS: string[] = [
  'models-2012-40',
  'models-2012-60',
  'models-2012-85',
  'models-2012-p85',
  'models-2012-p85plus',
  'models-2012-70',
  'models-2012-70d',
  'models-2012-85d',
  'models-2012-p85d',
  'models-2012-90d',
  'models-2012-p90d',
  'models-2016-60',
  'models-2016-60d',
  'models-2016-75',
  'models-2016-75d',
  'models-2016-90d',
  'models-2016-p90d',
  'models-2016-100d',
  'models-2016-p100d',
  'models-2018-75d',
  'models-2018-100d',
  'models-2018-p100d',
  'models-2018-standard-range',
  'models-2018-long-range',
  'models-2018-performance',
  'models-2018-long-range-plus',
  'models-2021-long-range',
  'models-2021-plaid',
  'models-2021-standard-range',
  'modelx-2015-60d',
  'modelx-2015-75d',
  'modelx-2015-90d',
  'modelx-2015-p90d',
  'modelx-2015-100d',
  'modelx-2015-p100d',
  'modelx-2018-75d',
  'modelx-2018-100d',
  'modelx-2018-p100d',
  'modelx-2018-standard-range',
  'modelx-2018-long-range',
  'modelx-2018-performance',
  'modelx-2018-long-range-plus',
  'modelx-2021-long-range',
  'modelx-2021-plaid',
  // 2023 software-limited Long Range (US), found by the Phase 1 research (plan T11 Step 21 rule:
  // table, teslas.json and EXPECTED_IDS change together).
  'modelx-2021-standard-range',
  'model3-2017-lr-rwd',
  'model3-2017-mid-range',
  'model3-2017-standard-range',
  'model3-2017-sr-plus',
  'model3-2017-rwd',
  'model3-2017-lr-awd',
  'model3-2017-performance',
  'model3-highland-rwd',
  'model3-highland-lr-rwd',
  'model3-highland-lr-awd',
  'model3-highland-performance',
  'model3-highland-standard',
  'modely-2020-lr-awd',
  'modely-2020-performance',
  'modely-2020-sr-rwd',
  'modely-2020-awd',
  'modely-2020-rwd',
  'modely-2020-lr-rwd',
  'modely-juniper-rwd-eu',
  'modely-juniper-standard-rwd',
  'modely-juniper-standard-awd',
  'modely-juniper-lr-rwd',
  'modely-juniper-lr-awd',
  'modely-juniper-performance',
  'modelyl-2025-awd',
  'cybertruck-awd',
  'cybertruck-cyberbeast',
  'cybertruck-lr-rwd',
];

function paramsWith(p: TeslaParams, patch: Partial<TeslaParams>): TeslaParams {
  return { ...p, ...patch, roadLoad: { ...(patch.roadLoad ?? p.roadLoad) } };
}

/** One DEMO_PROFILE loop driven through PedalPhysics with params p; returns (v, a) samples. */
function demoTrajectory(p: TeslaParams, dtS: number): { v: number; a: number }[] {
  const driver = new DemoDriver();
  const physics = new PedalPhysics();
  const pedal: PedalCommand = { throttle: 0, brake: 0 };
  driver.reset();
  physics.configure(p);
  physics.reset();
  const last = DEMO_PROFILE[DEMO_PROFILE.length - 1];
  const loopS = last === undefined ? 0 : last.t;
  const out: { v: number; a: number }[] = [];
  for (let t = 0; t < loopS; t += dtS) {
    driver.step(dtS, pedal);
    physics.step(pedal.throttle, pedal.brake, dtS);
    out.push({ v: physics.v, a: physics.a });
  }
  return out;
}

describe('catalogue data', () => {
  it('teslas.json validates against tesla.schema.json', () => {
    const validate = ajv.compile(teslaSchema);
    const ok = validate(TESLAS);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('roadload.json validates against roadload.schema.json and has unique refs', () => {
    const validate = ajv.compile(roadloadSchema);
    const ok = validate(ROADLOAD);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(new Set(ROADLOAD.map((r) => r.ref)).size).toBe(ROADLOAD.length);
  });

  it('covers exactly the planned generation/trim list', () => {
    expect([...TESLAS.map((r) => r.id)].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('has unique ids, a resolvable roadLoadRef and fitted params for every record', () => {
    expect(new Set(TESLAS.map((r) => r.id)).size).toBe(TESLAS.length);
    const refs = new Set(ROADLOAD.map((r) => r.ref));
    for (const r of TESLAS) expect(refs.has(r.roadLoadRef), `${r.id} → ${r.roadLoadRef}`).toBe(true);
    expect(Object.keys(paramsJson).sort()).toEqual(TESLAS.map((r) => r.id).sort());
  });

  it.each(TESLAS.map((r) => [r.id, r] as const))('%s: modes, years and MCU flags are consistent', (_id, r: TeslaRecord) => {
    const factors = r.accelModes.map((m) => m.factor);
    expect(factors[factors.length - 1]).toBe(1);
    for (let i = 1; i < factors.length; i++) expect(factors[i]).toBeGreaterThan(factors[i - 1] ?? Infinity);
    expect(new Set(r.accelModes.map((m) => m.name)).size).toBe(r.accelModes.length);
    expect(r.years[0]).toBeLessThanOrEqual(r.years[1]);
    expect(r.supported).toBe(!r.mcu.includes('tegra'));
  });
});

describe('resolveTeslaParams', () => {
  it('defaults to the last (quickest) mode and resolves road load + fitted params', () => {
    const id = 'model3-highland-performance';
    const p = resolveTeslaParams(id);
    const rec = TESLAS.find((r) => r.id === id);
    const rl = ROADLOAD.find((x) => x.ref === rec?.roadLoadRef);
    expect(p.modeFactor).toBe(1);
    expect(p.eta).toBe(ETA_DRIVETRAIN);
    expect(p.roadLoad).toEqual({ A_N: rl?.A_N, B_Nps_m: rl?.B_Nps_m, C_Ns2_m2: rl?.C_Ns2_m2 });
    expect(p.massKg).toBe((paramsJson as Record<string, { massKg: number }>)[id]?.massKg);
    expect(resolveTeslaParams(id, 'Chill').modeFactor).toBe(0.5);
  });

  it('throws on unknown records and modes', () => {
    expect(() => resolveTeslaParams('no-such-tesla')).toThrow(/Unknown Tesla record/);
    expect(() => resolveTeslaParams('model3-highland-performance', 'Ludicrous')).toThrow(/no acceleration mode/);
  });

  it.each(TESLAS.map((r) => [r.id] as const))('%s: every mode resolves to finite, positive params', (id) => {
    const rec = TESLAS.find((r) => r.id === id);
    for (const m of rec?.accelModes ?? []) {
      const p = resolveTeslaParams(id, m.name);
      for (const x of [p.massKg, p.fTracN, p.pEffW, p.modeFactor, p.roadLoad.A_N, p.roadLoad.C_Ns2_m2]) {
        expect(Number.isFinite(x) && x > 0).toBe(true);
      }
    }
  });
});

describe('notListedParams', () => {
  it('uses the generic road load per body and F_trac = m·(27.7778/t)·1.25 with no power term', () => {
    expect(notListedParams(5, 2000, 'sedan')).toEqual({
      massKg: 2000,
      roadLoad: { A_N: 130, B_Nps_m: 1, C_Ns2_m2: 0.4 },
      fTracN: 2000 * (27.7778 / 5) * 1.25,
      pEffW: 1e9,
      eta: 0.9,
      modeFactor: 1,
    });
    expect(notListedParams(5, 2000, 'suv').roadLoad).toEqual({ A_N: 160, B_Nps_m: 1.5, C_Ns2_m2: 0.48 });
    expect(notListedParams(5, 2000, 'truck').roadLoad).toEqual({ A_N: 220, B_Nps_m: 2, C_Ns2_m2: 0.62 });
  });

  it('rejects non-positive or non-finite inputs', () => {
    expect(() => notListedParams(0, 2000, 'sedan')).toThrow(RangeError);
    expect(() => notListedParams(5, Number.NaN, 'suv')).toThrow(RangeError);
  });
});

describe('load estimation per catalogue record (spec §8.5)', () => {
  it.each(TESLAS.map((r) => [r.id, r] as const))(
    '%s: WOT gives rawLoad ≥ 0.95 over 10–130 km/h, ≤ 0.75 at 0.6× that acceleration, and reproduces the fitted time',
    (id, rec: TeslaRecord) => {
      const p = resolveTeslaParams(id);
      const vTarget = targetSpeedMps(rec.accel.basis);
      // Same forward-Euler step as tools/build-catalogue.ts, so the two force models can be compared exactly.
      const dt = FIT_DT_S;
      let v = 0;
      let t = 0;
      let tTarget = Infinity;
      let samples = 0;
      while (t < 120 && v < 130 * KMH) {
        // WOT acceleration from the contract's force model, written out here independently of
        // src/sim/load.ts (which rawLoad and the builder use), so rawLoad ≥ 0.95 checks load.ts.
        const drive = p.modeFactor * Math.min(p.fTracN, (ETA_DRIVETRAIN * p.pEffW) / Math.max(v, 1));
        const road = p.roadLoad.A_N + p.roadLoad.B_Nps_m * v + p.roadLoad.C_Ns2_m2 * v * v;
        const a = (drive - road) / p.massKg;
        if (v >= 10 * KMH) {
          samples++;
          expect(rawLoad(p, v, a), `v=${(v / KMH).toFixed(1)} km/h`).toBeGreaterThanOrEqual(0.95);
          expect(rawLoad(p, v, 0.6 * a), `v=${(v / KMH).toFixed(1)} km/h`).toBeLessThanOrEqual(0.75);
        }
        const vNext = v + a * dt;
        if (tTarget === Infinity && vNext >= vTarget) tTarget = t + (dt * (vTarget - v)) / (vNext - v);
        v = vNext;
        t += dt;
      }
      expect(v).toBeGreaterThanOrEqual(130 * KMH);
      expect(samples).toBeGreaterThan(10);
      // The independent force model with the resolved runtime params must reproduce the builder's simulation…
      expect(Math.abs(tTarget - accelTimeS(p.massKg, p.roadLoad, p.fTracN, p.pEffW, vTarget))).toBeLessThanOrEqual(0.01);
      // …and therefore the published time (except a fit the builder reported as unreachable).
      const fit = fitParams(rec, p.roadLoad);
      if (fit.reached) expect(Math.abs(tTarget - targetTimeS(rec.accel))).toBeLessThanOrEqual(0.02);
      else expect(tTarget).toBeGreaterThan(targetTimeS(rec.accel));
    },
  );

  it.each(TESLAS.map((r) => [r.id] as const))(
    '%s: ±20 % road load / ±10 % mass change load by < 0.05 (mean |Δ|) over one DEMO_PROFILE loop',
    (id) => {
      const base = resolveTeslaParams(id);
      const rl = base.roadLoad;
      const road = (k: number): Partial<TeslaParams> => ({
        roadLoad: { A_N: rl.A_N * k, B_Nps_m: rl.B_Nps_m * k, C_Ns2_m2: rl.C_Ns2_m2 * k },
      });
      const variants = [
        paramsWith(base, road(0.8)),
        paramsWith(base, road(1.2)),
        paramsWith(base, { massKg: base.massKg * 0.9 }),
        paramsWith(base, { massKg: base.massKg * 1.1 }),
      ];
      const trajectory = demoTrajectory(base, 0.01);
      expect(trajectory.length).toBeGreaterThan(1000);
      for (const pv of variants) {
        let sum = 0;
        for (const s of trajectory) sum += Math.abs(rawLoad(pv, s.v, s.a) - rawLoad(base, s.v, s.a));
        expect(sum / trajectory.length).toBeLessThan(0.05);
      }
    },
  );
});
