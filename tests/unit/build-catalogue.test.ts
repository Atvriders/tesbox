import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { G, type TeslaRecord } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';
import {
  accelTimeS,
  buildCatalogue,
  cataloguePaths,
  checkCatalogue,
  fitParams,
  main,
  normalisedMassKg,
  REPO_ROOT,
  roadLoadFromSrc,
  serialize,
  targetSpeedMps,
  targetTimeS,
  type DerivedRoadLoadSrc,
  type EpaRoadLoadSrc,
  type RoadLoadSrc,
} from '../../tools/build-catalogue';

const EPA_M3P: EpaRoadLoadSrc = {
  ref: 'fixture-m3p',
  kind: 'epa',
  modelYear: 2026,
  testCarRow: 'Model 3 Performance AWD',
  ratedHp: 510,
  etwLb: 4250,
  target: { A_lbf: 36.82, B_lbf_per_mph: 0.1386, C_lbf_per_mph2: 0.01545 },
  file: 'https://www.epa.gov/system/files/documents/2026-01/26-testcar-2026-01-21.xlsx',
};

const DERIVED: DerivedRoadLoadSrc = {
  ref: 'fixture-derived',
  kind: 'derived',
  cdA_m2: 0.6,
  crr: 0.009,
  massKg: 2000,
  sources: ['fixture'],
};

function record(overrides: Partial<TeslaRecord>): TeslaRecord {
  return {
    id: 'fixture-car',
    model: 'Model 3',
    generation: 'Fixture',
    years: [2024, 2026],
    trim: 'Fixture',
    markets: ['US'],
    massKg: 1800,
    massBasis: 'us-curb',
    peakPowerKw: 300,
    accel: { seconds: 4.2, basis: '0-60mph', rolloutSubtracted: false },
    accelModes: [
      { name: 'Chill', factor: 0.5 },
      { name: 'Standard', factor: 1 },
    ],
    roadLoadRef: 'fixture-m3p',
    subwooferDefault: true,
    mcu: ['amd'],
    supported: true,
    sources: { mass: ['f'], power: ['f'], accel: ['f'], audio: ['f'] },
    ...overrides,
  };
}

const RL = roadLoadFromSrc(EPA_M3P);

describe('roadLoadFromSrc', () => {
  it('converts EPA Target coefficients with epaToSi (hand-checked M3 Performance row)', () => {
    const si = epaToSi(EPA_M3P.target);
    expect(RL.A_N).toBeCloseTo(si.A_N, 2);
    expect(RL.B_Nps_m).toBeCloseTo(si.B_Nps_m, 4);
    expect(RL.C_Ns2_m2).toBeCloseTo(si.C_Ns2_m2, 5);
    // 36.82 lbf × 4.448222 = 163.78 N; 0.1386 × 9.9504 = 1.3791 N·s/m; 0.01545 × 22.2583 = 0.34389 N·s²/m²
    expect(RL).toMatchObject({ ref: 'fixture-m3p', A_N: 163.78, B_Nps_m: 1.3791, C_Ns2_m2: 0.34389 });
    expect(RL.source.startsWith('EPA 2026 Test Car List: Tesla Model 3 Performance AWD')).toBe(true);
  });

  it('derives A = Crr·m·G, B = 0, C = ½·ρ·CdA for derived rows', () => {
    const rl = roadLoadFromSrc(DERIVED);
    expect(rl.A_N).toBeCloseTo(0.009 * 2000 * G, 2);
    expect(rl.B_Nps_m).toBe(0);
    expect(rl.C_Ns2_m2).toBeCloseTo(0.5 * 1.2041 * 0.6, 5);
    expect(rl.source.startsWith('derived: CdA=0.6 m², Crr=0.009')).toBe(true);
  });
});

describe('fit inputs', () => {
  it('adds the 75 kg occupant only to us-curb masses', () => {
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'us-curb' }))).toBe(1875);
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'eu-unladen-incl-driver' }))).toBe(1800);
    expect(normalisedMassKg(record({ massKg: 1800, massBasis: 'test-weight' }))).toBe(1800);
  });

  it('maps the accel basis to the target speed and adds 0.25 s for subtracted rollout', () => {
    expect(targetSpeedMps('0-60mph')).toBe(26.8224);
    expect(targetSpeedMps('0-100kmh')).toBe(27.7778);
    expect(targetTimeS({ seconds: 2.9, basis: '0-60mph', rolloutSubtracted: true })).toBeCloseTo(3.15, 12);
    expect(targetTimeS({ seconds: 3.5, basis: '0-100kmh', rolloutSubtracted: false })).toBe(3.5);
  });
});

describe('accelTimeS', () => {
  const NO_ROAD = { A_N: 0, B_Nps_m: 0, C_Ns2_m2: 0 };

  it('matches the closed form for constant force and no road load', () => {
    // 5000 N on 1000 kg = 5 m/s² → 26.8224 / 5 = 5.36448 s
    expect(accelTimeS(1000, NO_ROAD, 5000, 1e12, 26.8224)).toBeCloseTo(5.36448, 6);
  });

  it('is slower when power-limited and Infinity when the car cannot reach the target', () => {
    const tractionOnly = accelTimeS(1000, NO_ROAD, 5000, 1e12, 26.8224);
    expect(accelTimeS(1000, NO_ROAD, 5000, 60000, 26.8224)).toBeGreaterThan(tractionOnly);
    expect(accelTimeS(1000, { A_N: 6000, B_Nps_m: 0, C_Ns2_m2: 0 }, 5000, 1e12, 26.8224)).toBe(Infinity);
  });
});

describe('fitParams', () => {
  it('bisects F_trac to the published time when traction-limited (P_eff = peak)', () => {
    const r = record({});
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(true);
    expect(fit.massKg).toBe(1875);
    expect(fit.pEffW).toBe(300000);
    expect(fit.fTracN).toBeGreaterThan(0.3 * 1875 * G);
    expect(fit.fTracN).toBeLessThan(1.3 * 1875 * G);
    expect(Math.abs(fit.achievedS - 4.2)).toBeLessThanOrEqual(0.01);
  });

  it('fixes F_trac = 1.3·m·G and bisects P_eff when even the traction cap is too slow at peak power', () => {
    const r = record({ peakPowerKw: 150, accel: { seconds: 3.4, basis: '0-60mph', rolloutSubtracted: false } });
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(true);
    expect(fit.fTracN).toBeCloseTo(1.3 * 1875 * G, 1);
    expect(fit.pEffW).toBeGreaterThan(150000);
    expect(fit.pEffW).toBeLessThanOrEqual(450000);
    expect(Math.abs(fit.achievedS - 3.4)).toBeLessThanOrEqual(0.01);
  });

  it('keeps the cap and the published power when the time is unreachable (reached = false)', () => {
    // target 1.75 + 0.25 s rollout = 2.00 s; even 1.3·m·G with 3× power only reaches ≈ 2.13 s
    const r = record({ peakPowerKw: 760, accel: { seconds: 1.75, basis: '0-60mph', rolloutSubtracted: true } });
    const fit = fitParams(r, RL);
    expect(fit.reached).toBe(false);
    expect(fit.fTracN).toBeCloseTo(1.3 * 1875 * G, 1);
    expect(fit.pEffW).toBe(760000);
    expect(fit.achievedS).toBeGreaterThan(fit.targetS);
  });

  it('throws when even 0.3·m·G beats the published time (bad data)', () => {
    const r = record({ accel: { seconds: 15, basis: '0-60mph', rolloutSubtracted: false } });
    expect(() => fitParams(r, RL)).toThrow(/0\.3·m·G/);
  });
});

describe('buildCatalogue', () => {
  const SRC: RoadLoadSrc[] = [EPA_M3P, DERIVED];

  it('is deterministic and sorts road load by ref', () => {
    const teslas = [record({}), record({ id: 'fixture-b', roadLoadRef: 'fixture-derived' })];
    const a = buildCatalogue(teslas, SRC);
    const b = buildCatalogue(teslas, SRC);
    expect(serialize(a.roadload)).toBe(serialize(b.roadload));
    expect(serialize(a.params)).toBe(serialize(b.params));
    expect(a.roadload.map((x) => x.ref)).toEqual(['fixture-derived', 'fixture-m3p']);
    expect(Object.keys(a.params)).toEqual(['fixture-car', 'fixture-b']);
    expect(a.warnings).toEqual([]);
  });

  it('reports unreachable fits as warnings, not errors', () => {
    const r = record({ peakPowerKw: 760, accel: { seconds: 1.75, basis: '0-60mph', rolloutSubtracted: true } });
    const out = buildCatalogue([r], SRC);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/fixture-car/);
  });

  it('rejects duplicate refs, duplicate ids and unresolved roadLoadRefs', () => {
    expect(() => buildCatalogue([record({})], [EPA_M3P, EPA_M3P])).toThrow(/duplicate ref/);
    expect(() => buildCatalogue([record({}), record({})], SRC)).toThrow(/duplicate id/);
    expect(() => buildCatalogue([record({ roadLoadRef: 'nope' })], SRC)).toThrow(/not in roadload-src/);
  });
});

describe('generated files', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
    vi.restoreAllMocks();
  });

  it('are up to date (build-catalogue --check passes)', () => {
    expect(checkCatalogue(REPO_ROOT)).toEqual([]);
  });

  it('--check exits non-zero when a generated file is stale, and 0 after regenerating', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tmp = mkdtempSync(join(tmpdir(), 'tesbox-catalogue-'));
    const from = cataloguePaths(REPO_ROOT);
    const to = cataloguePaths(tmp);
    mkdirSync(join(tmp, 'src', 'data', 'raw'), { recursive: true });
    mkdirSync(join(tmp, 'src', 'data', 'schema'), { recursive: true });
    for (const key of ['teslas', 'src', 'roadload', 'params', 'teslaSchema', 'roadloadSchema'] as const) {
      copyFileSync(from[key], to[key]);
    }
    expect(main(['--check'], tmp)).toBe(0);
    writeFileSync(to.params, readFileSync(to.params, 'utf8').replace(/"pEffW": \d+/, '"pEffW": 1'));
    expect(checkCatalogue(tmp)).toEqual([to.params]);
    expect(main(['--check'], tmp)).toBe(1);
    expect(main([], tmp)).toBe(0);
    expect(main(['--check'], tmp)).toBe(0);
  });

  it('runs as a CLI: --check exits 0 on the committed catalogue', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'tools/build-catalogue.ts', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  }, 30000);
});
