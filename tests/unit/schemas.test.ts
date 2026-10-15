import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { EngineDef, RoadLoadRecord, TeslaRecord } from '../../src/contracts';
import engineSchema from '../../src/data/schema/engine.schema.json';
import roadloadSchema from '../../src/data/schema/roadload.schema.json';
import teslaSchema from '../../src/data/schema/tesla.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);
const validateTeslas = ajv.compile(teslaSchema);
const validateRoadload = ajv.compile(roadloadSchema);

/** Deep clone + mutate helper so each negative case starts from a valid document. */
function mutate<T>(base: T, fn: (draft: T) => void): T {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
}

const ENGINE: EngineDef = {
  id: 'fixture-v8',
  name: 'Fixture V8',
  inspiredBy: 'Fixture',
  set: 'american',
  notes: 'fixture',
  spec: {
    layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 5 },
    cycleDeg: 720,
    combustion: [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })),
    rpm: { idle: 700, redline: 7500, limiter: { type: 'fuel-soft', rpm: 7500, hysteresisRpm: 150 } },
    aspiration: { type: 'na', turbo: null, supercharger: null },
    gearbox: { type: 'manual', overallRatios: [11.5, 7.5, 5.0, 3.55, 2.9, 2.2], drivenTyre: '255/45R18', shiftTimeS: 0.3, tc: null },
    sources: { layout: ['a'], combustion: ['b'], rpm: ['c'], aspiration: ['d'], gearbox: ['e'] },
  },
  voicing: {
    pulse: { widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1, cylinderSpreadDb: 0 },
    headersM: [0.55, 0.55, 0.6, 0.6, 0.65, 0.65, 0.7, 0.7],
    collectors: [
      { banks: [0], lengthM: 0.35 },
      { banks: [1], lengthM: 0.35 },
    ],
    turbine: null,
    exhaust: { midPipeM: 1.4, mufflerSectionsM: [0.21, 0.34, 0.47], mufflerAction: 0.6, tailpipeM: 0.5, valve: { fitted: true, openGainDb: 4 } },
    intake: { runnerM: 0.3, helmholtzHz: 160, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: 1200 },
    cabin: { lowpassHz: 600, leakDb: -30, boomHz: 100, boomDb: 0 },
    launchRpm: 4125,
    estimated: true,
  },
};

const TESLA: TeslaRecord = {
  id: 'fixture-tesla',
  model: 'Model 3',
  generation: 'Fixture',
  years: [2024, 2026],
  trim: 'Fixture',
  markets: ['US', 'EU'],
  massKg: 1828,
  massBasis: 'us-curb',
  peakPowerKw: 296,
  accel: { seconds: 4.2, basis: '0-60mph', rolloutSubtracted: false },
  accelModes: [
    { name: 'Chill', factor: 0.5 },
    { name: 'Standard', factor: 1 },
  ],
  roadLoadRef: 'fixture-ref',
  subwooferDefault: true,
  mcu: ['amd'],
  supported: true,
  sources: { mass: ['m'], power: ['p'], accel: ['a'], audio: ['s'] },
};

const ROAD: RoadLoadRecord = {
  ref: 'fixture-ref',
  A_N: 137.81,
  B_Nps_m: 1.5881,
  C_Ns2_m2: 0.31384,
  source: 'EPA 2026 Test Car List: Tesla Model 3 Long Range AWD-E',
};

describe('engine.schema.json', () => {
  it('accepts a complete EngineDef', () => {
    expect(validateEngine(ENGINE)).toBe(true);
  });

  it.each<[string, (e: EngineDef) => void]>([
    ['an extra top-level property', (e) => Object.assign(e, { extra: 1 })],
    ['a missing voicing', (e) => Reflect.deleteProperty(e, 'voicing')],
    ['idle below 500', (e) => (e.spec.rpm.idle = 400)],
    ['redline above 10000', (e) => (e.spec.rpm.redline = 10500)],
    ['hysteresis above 600', (e) => (e.spec.rpm.limiter.hysteresisRpm = 700)],
    ['a single combustion entry', (e) => (e.spec.combustion = [{ angleDeg: 0, bank: 0 }])],
    ['17 combustion entries', (e) => (e.spec.combustion = Array.from({ length: 17 }, (_, i) => ({ angleDeg: i * 40, bank: 0 })))],
    ['3 gears', (e) => (e.spec.gearbox.overallRatios = [10, 6, 4])],
    ['shiftTimeS above 0.6', (e) => (e.spec.gearbox.shiftTimeS = 0.7)],
    ['a torque converter on a manual', (e) => (e.spec.gearbox.tc = { stallRpmWot: 2500, lockupTurbineRpm: 1500, couplingSR: 0.9 })],
    ['tc-auto without a torque converter', (e) => (e.spec.gearbox.type = 'tc-auto')],
    ['couplingSR outside 0.80–0.95', (e) => {
      e.spec.gearbox.type = 'tc-auto';
      e.spec.gearbox.tc = { stallRpmWot: 2500, lockupTurbineRpm: 1500, couplingSR: 0.97 };
    }],
    ['turbo aspiration without a turbo block', (e) => (e.spec.aspiration.type = 'turbo')],
    ['an empty source group', (e) => (e.spec.sources.rpm = [])],
    ['an unparseable tyre code', (e) => (e.spec.gearbox.drivenTyre = '255-45-18')],
    ['an unknown engine set', (e) => Object.assign(e, { set: 'british' })],
    ['cabinGainDb above -10', (e) => {
      e.spec.aspiration = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
      e.voicing.forcedInduction = { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -5, whistleDb: -36, outsideGainDb: -30 };
    }],
    ['whistleDb above 0', (e) => {
      e.spec.aspiration = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
      e.voicing.forcedInduction = { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14, whistleDb: 1, outsideGainDb: -30 };
    }],
    ['outsideGainDb below -60', (e) => {
      e.spec.aspiration = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
      e.voicing.forcedInduction = { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14, whistleDb: -36, outsideGainDb: -61 };
    }],
    ['a forced-induction block without the B18 levels', (e) => {
      e.spec.aspiration = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
      Object.assign(e.voicing, { forcedInduction: { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 } });
    }],
    ['cabin leakDb above -10', (e) => (e.voicing.cabin.leakDb = -9)],
    ['cabin leakDb below -60', (e) => (e.voicing.cabin.leakDb = -61)],
    ['a cabin without leakDb', (e) => Object.assign(e.voicing, { cabin: { lowpassHz: 600, boomHz: 100, boomDb: 0 } })],
    ['cylinderSpreadDb above 6', (e) => (e.voicing.pulse.cylinderSpreadDb = 6.1)],
    ['cylinderSpreadDb below 0', (e) => (e.voicing.pulse.cylinderSpreadDb = -0.1)],
    ['a pulse without cylinderSpreadDb', (e) => Object.assign(e.voicing, { pulse: { widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 } })],
    ['cabin boomHz below 40', (e) => (e.voicing.cabin.boomHz = 39)],
    ['cabin boomHz above 200', (e) => (e.voicing.cabin.boomHz = 201)],
    ['cabin boomDb below 0', (e) => (e.voicing.cabin.boomDb = -0.5)],
    ['cabin boomDb above 12', (e) => (e.voicing.cabin.boomDb = 12.5)],
    ['a cabin without the boom', (e) => Object.assign(e.voicing, { cabin: { lowpassHz: 600, leakDb: -30 } })],
  ])('rejects %s', (_label, fn) => {
    expect(validateEngine(mutate(ENGINE, fn))).toBe(false);
  });

  it('accepts a supercharged tc-auto engine with valid blocks', () => {
    const sc = mutate(ENGINE, (e) => {
      e.spec.aspiration = { type: 'supercharger', turbo: null, supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 } };
      e.spec.gearbox.type = 'tc-auto';
      e.spec.gearbox.tc = { stallRpmWot: 2800, lockupTurbineRpm: 1400, couplingSR: 0.9 };
      e.voicing.forcedInduction = { spoolTimeS: 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14, whistleDb: -36, outsideGainDb: -30 };
    });
    expect(validateEngine(sc)).toBe(true);
  });
});

describe('tesla.schema.json (array of TeslaRecord)', () => {
  it('accepts a valid catalogue array', () => {
    expect(validateTeslas([TESLA])).toBe(true);
  });

  it.each<[string, (r: TeslaRecord) => void]>([
    ['an extra property', (r) => Object.assign(r, { notes: 'x' })],
    ['massKg below 1000', (r) => (r.massKg = 900)],
    ['peakPowerKw above 1200', (r) => (r.peakPowerKw = 1300)],
    ['accel seconds below 1.5', (r) => (r.accel.seconds = 1.2)],
    ['a 3-element years tuple', (r) => Object.assign(r, { years: [2020, 2021, 2022] })],
    ['an unknown market', (r) => Object.assign(r, { markets: ['UK'] })],
    ['an unknown model', (r) => Object.assign(r, { model: 'Roadster' })],
    ['a mode factor below 0.2', (r) => (r.accelModes = [{ name: 'Chill', factor: 0.1 }])],
    ['no acceleration modes', (r) => (r.accelModes = [])],
    ['an unknown MCU', (r) => Object.assign(r, { mcu: ['arm'] })],
    ['a missing audio source', (r) => Reflect.deleteProperty(r.sources, 'audio')],
  ])('rejects %s', (_label, fn) => {
    expect(validateTeslas([mutate(TESLA, fn)])).toBe(false);
  });

  it('rejects an empty catalogue and a bare record', () => {
    expect(validateTeslas([])).toBe(false);
    expect(validateTeslas(TESLA)).toBe(false);
  });
});

describe('roadload.schema.json (array of RoadLoadRecord)', () => {
  it('accepts EPA and derived records, including a negative B', () => {
    const derived: RoadLoadRecord = { ref: 'd', A_N: 170, B_Nps_m: 0, C_Ns2_m2: 0.36, source: 'derived: CdA=0.6 m², Crr=0.009' };
    expect(validateRoadload([ROAD, derived, { ...ROAD, ref: 'neg', B_Nps_m: -1.53 }])).toBe(true);
  });

  it.each<[string, Partial<RoadLoadRecord> & Record<string, unknown>]>([
    ['C below 0.1', { C_Ns2_m2: 0.05 }],
    ['A above 500', { A_N: 600 }],
    ['a source without the EPA/derived prefix', { source: 'some website' }],
    ['an extra property', { extra: true }],
  ])('rejects %s', (_label, patch) => {
    expect(validateRoadload([{ ...ROAD, ...patch }])).toBe(false);
  });
});
