import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import { firingHz, MAX_COMBUSTION, type EngineDef } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import { parseTyre, rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';
import { schemaErrors, tunedEngines, tunedLine, voicingInvariantFailures } from '../../tools/tune';

const MPH_IN_MPS = 0.44704;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

/** Cylinder (or rotor-face) count implied by the engine id: "i5-…" → 5, "v8-…" → 8, "flat6-…" → 6, twin rotary → 6 faces. */
function expectedCombustionCount(id: string): number {
  if (id.startsWith('rotary-twin-')) return 6;
  const m = /^(?:i|v|flat)(\d+)-/.exec(id);
  if (m === null || m[1] === undefined) throw new Error(`cannot infer cylinder count from id "${id}"`);
  return Number(m[1]);
}

function bankCounts(e: EngineDef): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of e.spec.combustion) counts.set(c.bank, (counts.get(c.bank) ?? 0) + 1);
  return counts;
}

/**
 * EPA Test Car List N/V (engine rpm per mph) checks, ±2.5 %. `gear` is 1-based; EPA reports
 * top gear unless the manufacturer chose the 1:1 gear (40 CFR 86.1803-01) — screen such rows out.
 * Screened out (documented in the engine's notes): v10-na-48 — the EPA 2012 LFA row (axle 3.42,
 * N/V 34.4) omits the 1.259 front counter gear that Lexus's own per-gear speed table includes.
 * flat6-na-40 — the EPA 911 GT3 rows (MY2022-2024) are the 992.1 (PDK axle 4.19, N/V 43.0; manual
 * 3.76/3.96); the modelled 992.2 PDK uses Porsche's 8 %-shorter 4.54 axle (computed 46.47 rpm/mph;
 * 43.0 x 4.54/4.19 = 46.59, -0.3 %) and has no EPA row yet (MY2025/2026 lists of 2026-01-21).
 * i4-turbo-20 — the EPA MY2022-2026 GTI 7-speed rows (axle 3.13/3.12 = Final II, N/V 26.7/26.6)
 * equal 7th x Final II on the 225/40R18 tyre's unloaded nominal circumference (26.59 rpm/mph). The
 * rolling-circumference model gives 27.41 (+2.7 / +3.0 %). This is VW's N/V convention, not a ratio
 * conflict.
 * v8-twinturbo-40 — the EPA 2023-2026 RS 6 Avant rows (axle 3.2, N/V 25.0) equal 8th x axle on the
 * unloaded 285/30R22 circumference; the model gives 25.91 (+3.6 %), and the MY2021-2022 RS7 rows for
 * the same powertrain file 26.3, so neither is used.
 */
const EPA_NV: { id: string; nv: number; gear: number; doc: string }[] = [
  {
    id: 'i5-turbo-25',
    nv: 29.2,
    gear: 7,
    doc: 'EPA 2024 Test Car List, Audi RS 3: axle 3.45, N/V 29.2; 7th 0.630 x 3.450, front tyre 265/30ZR19',
  },
  {
    id: 'v8-na-50',
    nv: 28.3,
    gear: 6,
    doc: 'EPA 2024 Test Car List, Ford Mustang (450 hp) 6-speed manual: axle 3.55, N/V 28.3; 6th 0.622 x 3.55, rear tyre 255/45R18',
  },
  {
    id: 'v10-na-52',
    nv: 42.8,
    gear: 7,
    doc: 'EPA 2016 Test Car List, Lamborghini Huracan (610 hp, 7-speed AWD): axle 3.94, N/V 42.8; 7th 0.841 x 3.938 (Audi R8 V10 GT RWD eTD 11/18/2022), rear tyre 305/30R20',
  },
  {
    id: 'i6-twinturbo-30',
    nv: 34.4,
    gear: 6,
    doc: 'EPA 1997 Test Car List, Toyota Supra 6-speed manual (M6-2, 320 hp): axle 3.13, N/V 34.4 (1998 list 34.4; 1994-1995 lists 34.5); 6th 0.793 x 3.133, rear tyre 255/40ZR17',
  },
  {
    id: 'flat4-turbo-25',
    nv: 39.5,
    gear: 6,
    doc: 'EPA 2021 Test Car List, Subaru WRX STI (2.5 L, 310 hp, 6-speed manual, test vehicle MBF-ZV741): axle 3.9, N/V 39.5; 6th 0.756 x 3.900, tyre 245/35R19 (same front and rear)',
  },
  {
    id: 'v6-twinturbo-38',
    nv: 36.5,
    gear: 6,
    doc: 'EPA 2024 Test Car List, Nissan GT-R Premium (565 hp, 6-gear automated manual): axle 3.7, N/V 36.5; 6th 0.796 x 3.700, rear tyre 285/35ZRF20 (run-flat, modelled as 285/35ZR20)',
  },
  {
    id: 'v8-na-62',
    nv: 22.0,
    gear: 8,
    doc: 'EPA 2025 Test Car List, Chevrolet Corvette (495 hp) 8-speed DCT, Z51 (test vehicle 621RYV2244; same row in MY2022-2024): axle 5.17, N/V 22.0; 8th 0.329 x 5.17, rear tyre 305/30ZR20',
  },
  {
    id: 'v8-sc-62',
    nv: 21.1,
    gear: 8,
    doc: 'EPA 2015 Test Car List, Dodge Challenger SRT8 (707 hp SRT Hellcat) 8-speed automatic: axle 2.62, N/V 21.1 (row unchanged MY2015-2023); 8th 0.67 x 2.62, rear tyre 275/40ZR20',
  },
  {
    id: 'v12-na-65',
    nv: 36.2,
    gear: 7,
    doc: 'EPA 2018 Test Car List, Ferrari 812 Superfast (F 140 GA, 7-speed automated manual DCT): axle 4.37, N/V 36.2 (same MY2019-2021); 7th 0.70 x 4.375, rear tyre 315/35ZR20',
  },
  {
    id: 'v8-flatplane-45',
    nv: 43.5,
    gear: 7,
    doc: 'EPA 2015 Test Car List, Ferrari 458 Italia Spyder (F136FB, 7-speed DCT; identical row MY2010-2015): axle 5.14, N/V 43.5; 7th 0.693 x 5.143, rear tyre 295/35ZR20',
  },
];

/**
 * Manufacturer "maximum speed in each gear" tables, ±2.5 % (same rolling-circumference model as
 * the N/V check). `rpm` is the engine speed the manufacturer's table refers to. A gear whose
 * published figure is the car's (drag-limited) top speed is not listed.
 */
const MAKER_GEAR_SPEEDS: { id: string; rpm: number; mphByGear: number[]; doc: string }[] = [
  {
    id: 'v10-na-48',
    rpm: 9000,
    mphByGear: [52, 76, 104, 136, 172],
    doc: 'Lexus UK media, GAZOO Racing Lexus LFA (20 June 2012), maximum permissible speed in gears 1-5 at the 9,000 rpm maximum engine speed; 6th (202 mph) is the top speed and is not used',
  },
];

/** Spec §5.5 garage: exact ids, order, set, title and "inspired by" subtitle. */
const GARAGE: { id: string; set: EngineDef['set']; name: string; inspiredBy: string }[] = [
  { id: 'i5-turbo-25', set: 'euro', name: '2.5 Turbo Inline-5', inspiredBy: 'Audi RS 3 (8Y)' },
  { id: 'flat6-na-40', set: 'euro', name: '4.0 Flat-Six NA', inspiredBy: 'Porsche 911 GT3 (992)' },
  { id: 'v10-na-52', set: 'euro', name: '5.2 V10 NA', inspiredBy: 'Lamborghini Huracán' },
  { id: 'i4-turbo-20', set: 'euro', name: '2.0 Turbo Inline-4', inspiredBy: 'VW Golf GTI (Mk8)' },
  { id: 'i6-twinturbo-30', set: 'jdm', name: '3.0 Twin-Turbo Inline-6', inspiredBy: 'Toyota Supra (A80, 2JZ-GTE)' },
  { id: 'rotary-twin-13', set: 'jdm', name: '1.3 Twin-Rotor Turbo Rotary', inspiredBy: 'Mazda RX-7 (FD, 13B-REW)' },
  { id: 'flat4-turbo-25', set: 'jdm', name: '2.5 Turbo Flat-Four', inspiredBy: 'Subaru WRX STI (EJ257)' },
  { id: 'v6-twinturbo-38', set: 'jdm', name: '3.8 Twin-Turbo V6', inspiredBy: 'Nissan GT-R (R35, VR38DETT)' },
  { id: 'v8-na-50', set: 'american', name: '5.0 V8 NA', inspiredBy: 'Ford Mustang GT (Coyote)' },
  { id: 'v8-na-62', set: 'american', name: '6.2 Small-Block V8 NA', inspiredBy: 'Chevrolet Corvette (C8, LT2)' },
  { id: 'v8-sc-62', set: 'american', name: '6.2 Supercharged V8', inspiredBy: 'Dodge Challenger SRT Hellcat' },
  { id: 'v12-na-65', set: 'exotic', name: '6.5 V12 NA', inspiredBy: 'Ferrari 812 Superfast' },
  { id: 'v8-flatplane-45', set: 'exotic', name: '4.5 Flat-Plane V8', inspiredBy: 'Ferrari 458 Italia' },
  { id: 'v10-na-48', set: 'exotic', name: '4.8 V10 NA', inspiredBy: 'Lexus LFA' },
  { id: 'v8-twinturbo-40', set: 'exotic', name: '4.0 Twin-Turbo V8', inspiredBy: 'Audi RS 6 Avant (C8)' },
];

describe('engine catalogue', () => {
  it('has unique ids and names', () => {
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
    expect(new Set(ENGINES.map((e) => e.name)).size).toBe(ENGINES.length);
  });

  it('getEngine returns the catalogue object and throws on unknown ids', () => {
    for (const e of ENGINES) expect(getEngine(e.id)).toBe(e);
    expect(() => getEngine('no-such-engine')).toThrow(/Unknown engine id/);
  });
});

describe.each(ENGINES.map((e) => [e.id, e] as const))('engine %s', (_id, e) => {
  it('validates against engine.schema.json', () => {
    const ok = validateEngine(e);
    expect(validateEngine.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('has the combustion count its layout implies', () => {
    expect(e.spec.combustion.length).toBe(expectedCombustionCount(e.id));
    expect(e.spec.combustion.length).toBeLessThanOrEqual(MAX_COMBUSTION);
  });

  it('has distinct combustion angles within [0, cycleDeg)', () => {
    const angles = e.spec.combustion.map((c) => c.angleDeg);
    expect(new Set(angles).size).toBe(angles.length);
    for (const a of angles) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(e.spec.cycleDeg);
    }
  });

  it('has a self-consistent layout, cycle and bank assignment', () => {
    const { layout } = e.spec;
    const counts = bankCounts(e);
    if (layout.type === 'rotary') {
      expect(e.spec.cycleDeg).toBe(1080);
      expect(e.spec.combustion.length % 3).toBe(0);
    } else {
      expect(e.spec.cycleDeg).toBe(720);
    }
    if (layout.type === 'inline' || layout.type === 'rotary') {
      expect(layout.bankAngleDeg).toBe(0);
      expect([...counts.keys()]).toEqual([0]);
    } else {
      if (layout.type === 'flat') expect(layout.bankAngleDeg).toBe(180);
      else {
        expect(layout.bankAngleDeg).toBeGreaterThan(0);
        expect(layout.bankAngleDeg).toBeLessThan(180);
      }
      expect([...counts.keys()].sort()).toEqual([0, 1]);
      expect(counts.get(0)).toBe(counts.get(1));
    }
    const isV8 = layout.type === 'v' && e.spec.combustion.length === 8;
    if (isV8) expect(['cross-plane', 'flat-plane']).toContain(layout.crank);
    else expect(layout.crank).toBe('n/a');
  });

  it('has idle < redline <= limiter rpm', () => {
    expect(e.spec.rpm.idle).toBeLessThan(e.spec.rpm.redline);
    expect(e.spec.rpm.limiter.rpm).toBeGreaterThanOrEqual(e.spec.rpm.redline);
  });

  it('has strictly descending overall ratios', () => {
    const r = e.spec.gearbox.overallRatios;
    for (let i = 1; i < r.length; i++) {
      expect(r[i]).toBeLessThan(r[i - 1] ?? -Infinity);
    }
  });

  it('has a parseable driven tyre and a torque converter iff tc-auto', () => {
    expect(() => parseTyre(e.spec.gearbox.drivenTyre)).not.toThrow();
    expect(e.spec.gearbox.tc === null).toBe(e.spec.gearbox.type !== 'tc-auto');
  });

  it('has at least one source per spec field group, and notes', () => {
    for (const group of ['layout', 'combustion', 'rpm', 'aspiration', 'gearbox'] as const) {
      expect(e.spec.sources[group].length).toBeGreaterThan(0);
      for (const s of e.spec.sources[group]) expect(s.trim().length).toBeGreaterThan(0);
    }
    expect(e.notes.trim().length).toBeGreaterThan(0);
  });

  it('has aspiration blocks matching the aspiration type', () => {
    const a = e.spec.aspiration;
    expect(a.turbo !== null).toBe(a.type === 'turbo');
    expect(a.supercharger !== null).toBe(a.type === 'supercharger');
  });

  it('has a voicing consistent with its spec', () => {
    const v = e.voicing;
    expect(v.headersM).toHaveLength(e.spec.combustion.length);
    const collectorBanks = v.collectors.flatMap((c) => c.banks).sort();
    expect(collectorBanks).toEqual([...bankCounts(e).keys()].sort());
    expect(v.turbine !== null).toBe(e.spec.aspiration.type === 'turbo');
    expect(v.forcedInduction !== null).toBe(e.spec.aspiration.type !== 'na');
    expect(v.overrun.fuelCutResumeRpm).toBeGreaterThan(e.spec.rpm.idle);
    expect(v.launchRpm).toBeLessThan(e.spec.rpm.redline);
  });
});

/**
 * Engines whose voicing was tuned against reference recordings (tools/tune.ts --apply), each recorded in
 * docs/sound-scores.md with a `Tuned voicing: <engine-id>` line (phase 2b contract T6).
 */
const TUNED_ENGINES = tunedEngines();

describe('voicing: untuned engines keep defaultVoicing, tuned ones keep the DSP invariants (phase 2b T6)', () => {
  it('records only garage engines as tuned', () => {
    const ids = ENGINES.map((e) => e.id);
    for (const id of TUNED_ENGINES) expect(ids, `docs/sound-scores.md: "${tunedLine(id)}"`).toContain(id);
  });

  for (const e of ENGINES) {
    if (TUNED_ENGINES.has(e.id)) {
      it(`${e.id} is tuned: it passes the schema and the DSP invariants`, { timeout: 120_000 }, () => {
        expect(schemaErrors(e)).toEqual([]);
        expect(voicingInvariantFailures(e)).toEqual([]);
      });
    } else {
      it(`${e.id} is untuned: its voicing equals defaultVoicing(spec)`, () => {
        expect(e.voicing, `a voicing tuned with tools/tune.ts --apply is recorded in docs/sound-scores.md as "${tunedLine(e.id)}"`).toEqual(
          defaultVoicing(e.spec),
        );
      });
    }
  }
});

describe('EPA N/V cross-check (±2.5 %)', () => {
  it.each(EPA_NV.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const e = getEngine(row.id);
    const ratio = e.spec.gearbox.overallRatios[row.gear - 1];
    expect(ratio, `gear ${row.gear} exists`).toBeDefined();
    const nv = wheelRpm(MPH_IN_MPS, ratio ?? NaN, rollingCircumferenceM(e.spec.gearbox.drivenTyre));
    expect(Math.abs(nv / row.nv - 1), `${row.doc}: computed ${nv.toFixed(2)}`).toBeLessThanOrEqual(0.025);
  });
});

describe('manufacturer speed-per-gear cross-check (±2.5 %)', () => {
  it.each(MAKER_GEAR_SPEEDS.map((row) => [row.id, row] as const))('%s', (_id, row) => {
    const e = getEngine(row.id);
    const circumferenceM = rollingCircumferenceM(e.spec.gearbox.drivenTyre);
    row.mphByGear.forEach((mph, i) => {
      const ratio = e.spec.gearbox.overallRatios[i];
      expect(ratio, `gear ${i + 1} exists`).toBeDefined();
      // wheelRpm is linear in speed: speed at `rpm` = rpm / (engine rpm at 1 m/s).
      const mphAtRpm = row.rpm / wheelRpm(1, ratio ?? NaN, circumferenceM) / MPH_IN_MPS;
      expect(Math.abs(mphAtRpm / mph - 1), `${row.doc}: gear ${i + 1} computed ${mphAtRpm.toFixed(1)} mph`).toBeLessThanOrEqual(0.025);
    });
  });
});

describe('garage (spec §5.5)', () => {
  it('lists exactly the 15 engines, in order, with set, title and subtitle', () => {
    expect(ENGINES.map((e) => ({ id: e.id, set: e.set, name: e.name, inspiredBy: e.inspiredBy }))).toEqual(GARAGE);
  });

  it('has the contract firing-frequency sanity values', () => {
    const hz = (id: string, rpm: number): number => {
      const s = getEngine(id).spec;
      return firingHz(rpm, s.combustion.length, s.cycleDeg);
    };
    expect(hz('i4-turbo-20', 6000)).toBeCloseTo(200, 9);
    expect(hz('rotary-twin-13', 6000)).toBeCloseTo(200, 9);
    expect(hz('v8-na-50', 6000)).toBeCloseTo(400, 9);
  });
});
