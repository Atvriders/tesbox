/**
 * Test-only fixtures for the Phase 1 drivetrain / SimCore tests (not collected as a test file).
 * The engines are FICTIONAL round-number specs (not any real car's data) so the vehicle tests do not
 * depend on the sourced engine catalogue; `shift-map.test.ts` additionally sweeps the real
 * catalogue once it exists.
 */
import type { EngineSpec, EngineVoicing, TeslaParams } from '../../src/contracts';

/** One render quantum at 48 kHz (phase-1 contract: tests use 48 kHz). */
export const DT = 128 / 48000;

function sources(): EngineSpec['sources'] {
  const s = ['test fixture (fictional)'];
  return { layout: s, combustion: s, rpm: s, aspiration: s, gearbox: s };
}

/** 2.0 turbo inline-4, 7-speed DCT, 245/40R18 (C = 1.990526 m). */
export const DCT7_SPEC: EngineSpec = {
  layout: { type: 'inline', bankAngleDeg: 0, crank: 'n/a', displacementL: 2.0 },
  cycleDeg: 720,
  combustion: [
    { angleDeg: 0, bank: 0 },
    { angleDeg: 180, bank: 0 },
    { angleDeg: 360, bank: 0 },
    { angleDeg: 540, bank: 0 },
  ],
  rpm: { idle: 800, redline: 7000, limiter: { type: 'ignition-soft', rpm: 7200, hysteresisRpm: 150 } },
  aspiration: { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null },
  gearbox: {
    type: 'dct',
    overallRatios: [13.5, 8.6, 6.1, 4.7, 3.8, 3.15, 2.7],
    drivenTyre: '245/40R18',
    shiftTimeS: 0.1,
    tc: null,
  },
  sources: sources(),
};

/** 6.2 supercharged V8, 8-speed torque-converter automatic, 275/40R20. */
export const TC8_SPEC: EngineSpec = {
  layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 6.2 },
  cycleDeg: 720,
  combustion: [0, 90, 180, 270, 360, 450, 540, 630].map((angleDeg, i) => ({ angleDeg, bank: i % 2 })),
  rpm: { idle: 650, redline: 6200, limiter: { type: 'fuel-soft', rpm: 6400, hysteresisRpm: 200 } },
  aspiration: {
    type: 'supercharger',
    turbo: null,
    supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 },
  },
  gearbox: {
    type: 'tc-auto',
    overallRatios: [17.0, 11.3, 8.2, 6.5, 5.3, 4.4, 3.6, 2.85],
    drivenTyre: '275/40R20',
    shiftTimeS: 0.2,
    tc: { stallRpmWot: 2600, lockupTurbineRpm: 1300, couplingSR: 0.88 },
  },
  sources: sources(),
};

/** 5.0 NA V8, 6-speed manual, 255/40R19, hard fuel-cut limiter at redline. */
export const MANUAL6_SPEC: EngineSpec = {
  layout: { type: 'v', bankAngleDeg: 90, crank: 'cross-plane', displacementL: 5.0 },
  cycleDeg: 720,
  combustion: [0, 90, 180, 270, 360, 450, 540, 630].map((angleDeg, i) => ({ angleDeg, bank: i % 2 })),
  rpm: { idle: 750, redline: 7500, limiter: { type: 'fuel-hard', rpm: 7500, hysteresisRpm: 250 } },
  aspiration: { type: 'na', turbo: null, supercharger: null },
  gearbox: {
    type: 'manual',
    overallRatios: [13.2, 8.9, 6.6, 5.0, 4.0, 3.15],
    drivenTyre: '255/40R19',
    shiftTimeS: 0.3,
    tc: null,
  },
  sources: sources(),
};

export const FIXTURE_SPECS: readonly (readonly [string, EngineSpec])[] = [
  ['DCT7', DCT7_SPEC],
  ['TC8', TC8_SPEC],
  ['MANUAL6', MANUAL6_SPEC],
];

/** Minimal complete voicing; only launchRpm and overrun.fuelCutResumeRpm matter to SimCore. */
export function testVoicing(spec: EngineSpec, launchRpm: number): EngineVoicing {
  return {
    pulse: { widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 },
    headersM: spec.combustion.map(() => 0.6),
    collectors: [{ banks: [0], lengthM: 0.35 }],
    turbine: null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    },
    intake: { runnerM: 0.3, helmholtzHz: 140, gain: 0.4 },
    forcedInduction: null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: spec.rpm.idle + 500 },
    cabin: { lowpassHz: 600, leakDb: -30 },
    launchRpm,
    estimated: true,
  };
}

/** launchRpm per the phase-1 default rule: NA 0.55·redline, turbo/supercharged 0.45·redline. */
export const DCT7_VOICING = testVoicing(DCT7_SPEC, 0.45 * 7000);
export const TC8_VOICING = testVoicing(TC8_SPEC, 0.45 * 6200);
export const MANUAL6_VOICING = testVoicing(MANUAL6_SPEC, 0.55 * 7500);

/** A mid-size dual-motor sedan (fictional round numbers): ~4.2 s 0–100 km/h class. */
export const MID_TESLA: TeslaParams = {
  massKg: 1900,
  roadLoad: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  fTracN: 14000,
  pEffW: 250000,
  eta: 0.9,
  modeFactor: 1,
};

/** Speed (m/s) at which `gear` (1-based) turns `rpm` with circumference `c` (inverse of wheelRpm). */
export function speedFor(spec: EngineSpec, c: number, gear: number, rpm: number): number {
  const r = spec.gearbox.overallRatios[gear - 1];
  if (r === undefined) throw new Error(`no gear ${gear}`);
  return (rpm * c) / (r * 60);
}
