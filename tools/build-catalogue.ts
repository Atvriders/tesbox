/**
 * Tesla catalogue builder (phase-1 contract, T11).
 *
 *   npx tsx tools/build-catalogue.ts           → writes src/data/roadload.json + src/data/tesla-params.json
 *   npx tsx tools/build-catalogue.ts --check   → exit 1 if regenerating would change either file
 *
 * Road load: EPA *Target* coefficients (lbf, lbf/mph, lbf/mph²) → SI via epaToSi, or a documented
 * CdA/Crr derivation. Params: normalised mass + forward-simulated fit of F_trac / P_eff to the
 * published acceleration time (spec §8.5).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { ETA_DRIVETRAIN, G, OCCUPANT_KG, type RoadLoadRecord, type TeslaParams, type TeslaRecord } from '../src/contracts';
import { epaToSi, type EpaTarget } from '../src/sim/epa';
import { maxForceN, roadForceN } from '../src/sim/load';

// ───────────────────────────── Input / output types ─────────────────────────────

export interface EpaRoadLoadSrc {
  ref: string;
  kind: 'epa';
  /** Model year of the EPA Test Car List file the row comes from. */
  modelYear: number;
  /** "Represented Test Veh Model" exactly as in the EPA file, e.g. "Model 3 Long Range AWD-E". */
  testCarRow: string;
  ratedHp: number;
  etwLb: number;
  /** Target (not Set) coefficients, original units. */
  target: EpaTarget;
  /** URL of the EPA xlsx/csv the row was read from. */
  file: string;
  note?: string;
}

export interface DerivedRoadLoadSrc {
  ref: string;
  kind: 'derived';
  cdA_m2: number;
  crr: number;
  /** Mass the rolling-resistance term is computed for (kg). */
  massKg: number;
  sources: string[];
  note?: string;
}

export type RoadLoadSrc = EpaRoadLoadSrc | DerivedRoadLoadSrc;

export interface FittedParams {
  massKg: number;
  fTracN: number;
  pEffW: number;
}

export interface FitResult extends FittedParams {
  /** false when even F_trac = 1.3·m·G (contract A7) with P_eff = 3·peak cannot reach the published time. */
  reached: boolean;
  /** Simulated 0→target time with the returned (rounded) params, seconds. */
  achievedS: number;
  targetS: number;
}

export interface CatalogueBuild {
  roadload: RoadLoadRecord[];
  params: Record<string, FittedParams>;
  warnings: string[];
}

// ───────────────────────────── Constants ─────────────────────────────

/** Dry air at 20 °C, 101.325 kPa (kg/m³) — used only for `derived` road load. */
export const AIR_DENSITY_KG_M3 = 1.2041;
export const FIT_DT_S = 0.005;
export const FIT_TOLERANCE_S = 0.01;
export const ROLLOUT_S = 0.25;
export const MPH60_MPS = 26.8224;
export const KMH100_MPS = 27.7778;
const MAX_SIM_S = 60;

// ───────────────────────────── Road load ─────────────────────────────

function round(x: number, decimals: number): number {
  const k = 10 ** decimals;
  return Math.round(x * k) / k;
}

export function roadLoadFromSrc(src: RoadLoadSrc): RoadLoadRecord {
  if (src.kind === 'epa') {
    const si = epaToSi(src.target);
    return {
      ref: src.ref,
      A_N: round(si.A_N, 2),
      B_Nps_m: round(si.B_Nps_m, 4),
      C_Ns2_m2: round(si.C_Ns2_m2, 5),
      source:
        `EPA ${src.modelYear} Test Car List: Tesla ${src.testCarRow} ` +
        `(${src.ratedHp} hp, ETW ${src.etwLb} lb; A ${src.target.A_lbf} lbf, B ${src.target.B_lbf_per_mph} lbf/mph, ` +
        `C ${src.target.C_lbf_per_mph2} lbf/mph²)${src.note ? ` — ${src.note}` : ''}`,
    };
  }
  return {
    ref: src.ref,
    A_N: round(src.crr * src.massKg * G, 2),
    B_Nps_m: 0,
    C_Ns2_m2: round(0.5 * AIR_DENSITY_KG_M3 * src.cdA_m2, 5),
    source:
      `derived: CdA=${src.cdA_m2} m², Crr=${src.crr}, m=${src.massKg} kg, rho=${AIR_DENSITY_KG_M3} kg/m³ ` +
      `(${src.sources.join('; ')})${src.note ? ` — ${src.note}` : ''}`,
  };
}

// ───────────────────────────── Parameter fit ─────────────────────────────

/** `us-curb` lacks an occupant → +75 kg; EU unladen already includes the driver; test weight as-is. */
export function normalisedMassKg(r: TeslaRecord): number {
  return r.massBasis === 'us-curb' ? r.massKg + OCCUPANT_KG : r.massKg;
}

export function targetSpeedMps(basis: TeslaRecord['accel']['basis']): number {
  return basis === '0-60mph' ? MPH60_MPS : KMH100_MPS;
}

/** Published time, plus the 1-ft rollout the manufacturer subtracted (applies to either basis). */
export function targetTimeS(accel: TeslaRecord['accel']): number {
  return accel.seconds + (accel.rolloutSubtracted ? ROLLOUT_S : 0);
}

/**
 * Forward Euler, dt = FIT_DT_S: m·dv/dt = min(F_trac, η·P_eff/max(v, 1)) − F_road(v), evaluated with
 * Task 4's runtime force model (`maxForceN` at modeFactor 1, `roadForceN`) so the fit and the
 * simulation can never drift apart. Returns the (linearly interpolated) time at which v reaches
 * targetMps, or Infinity.
 */
export function accelTimeS(
  massKg: number,
  rl: Pick<RoadLoadRecord, 'A_N' | 'B_Nps_m' | 'C_Ns2_m2'>,
  fTracN: number,
  pEffW: number,
  targetMps: number,
): number {
  const p: TeslaParams = {
    massKg,
    roadLoad: { A_N: rl.A_N, B_Nps_m: rl.B_Nps_m, C_Ns2_m2: rl.C_Ns2_m2 },
    fTracN,
    pEffW,
    eta: ETA_DRIVETRAIN,
    modeFactor: 1,
  };
  let v = 0;
  let t = 0;
  while (t < MAX_SIM_S) {
    const a = (maxForceN(p, v) - roadForceN(p, v)) / massKg;
    if (a <= 0) return Infinity;
    const vNext = v + a * FIT_DT_S;
    if (vNext >= targetMps) return t + (FIT_DT_S * (targetMps - v)) / (vNext - v);
    v = vNext;
    t += FIT_DT_S;
  }
  return Infinity;
}

/** Bisection on a parameter whose time decreases as it grows; returns the smallest x with time(x) ≤ target. */
function bisectDecreasing(time: (x: number) => number, targetS: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200 && b - a > 1e-9 * b; i++) {
    const mid = 0.5 * (a + b);
    if (time(mid) > targetS) a = mid;
    else b = mid;
  }
  return b;
}

export function fitParams(r: TeslaRecord, rl: Pick<RoadLoadRecord, 'A_N' | 'B_Nps_m' | 'C_Ns2_m2'>): FitResult {
  const m = normalisedMassKg(r);
  const vT = targetSpeedMps(r.accel.basis);
  const tT = targetTimeS(r.accel);
  const peakW = r.peakPowerKw * 1000;
  const fLo = 0.3 * m * G;
  const fHi = 1.3 * m * G; // contract A7: F_trac ∈ [0.3, 1.3]·m·G
  const finish = (fTracN: number, pEffW: number, reached: boolean): FitResult => {
    const f = round(fTracN, 1);
    const p = Math.round(pEffW);
    return { massKg: m, fTracN: f, pEffW: p, reached, achievedS: accelTimeS(m, rl, f, p, vT), targetS: tT };
  };

  if (accelTimeS(m, rl, fLo, peakW, vT) < tT - FIT_TOLERANCE_S) {
    throw new Error(
      `${r.id}: even F_trac = 0.3·m·G reaches ${vT} m/s faster than the published ${tT.toFixed(2)} s — check accel/mass/power data`,
    );
  }
  if (accelTimeS(m, rl, fHi, peakW, vT) <= tT) {
    const f = bisectDecreasing((x) => accelTimeS(m, rl, x, peakW, vT), tT, fLo, fHi);
    return finish(f, peakW, true);
  }
  const pLo = 0.5 * peakW;
  const pHi = 3 * peakW;
  if (accelTimeS(m, rl, fHi, pHi, vT) > tT) {
    // Traction cap 1.3·m·G cannot reproduce the time even with 3× power (no catalogue record expected):
    // keep the cap and the published power so the high-speed force stays realistic.
    return finish(fHi, peakW, false);
  }
  const p = bisectDecreasing((x) => accelTimeS(m, rl, fHi, x, vT), tT, pLo, pHi);
  return finish(fHi, p, true);
}

// ───────────────────────────── Build ─────────────────────────────

export function buildCatalogue(teslas: TeslaRecord[], src: RoadLoadSrc[]): CatalogueBuild {
  const byRef = new Map<string, RoadLoadRecord>();
  for (const s of src) {
    if (byRef.has(s.ref)) throw new Error(`roadload-src.json: duplicate ref "${s.ref}"`);
    byRef.set(s.ref, roadLoadFromSrc(s));
  }
  const ids = new Set<string>();
  const params: Record<string, FittedParams> = {};
  const warnings: string[] = [];
  for (const r of teslas) {
    if (ids.has(r.id)) throw new Error(`teslas.json: duplicate id "${r.id}"`);
    ids.add(r.id);
    const rl = byRef.get(r.roadLoadRef);
    if (rl === undefined) throw new Error(`teslas.json: ${r.id} roadLoadRef "${r.roadLoadRef}" not in roadload-src.json`);
    const fit = fitParams(r, rl);
    if (!fit.reached) {
      warnings.push(
        `${r.id}: published ${fit.targetS.toFixed(2)} s needs more than F_trac = 1.3·m·G; ` +
          `kept the cap (best ${fit.achievedS.toFixed(2)} s) and P_eff = peak`,
      );
    } else if (Math.abs(fit.achievedS - fit.targetS) > FIT_TOLERANCE_S) {
      throw new Error(`${r.id}: fit missed the target (${fit.achievedS.toFixed(3)} s vs ${fit.targetS.toFixed(3)} s)`);
    }
    params[r.id] = { massKg: fit.massKg, fTracN: fit.fTracN, pEffW: fit.pEffW };
  }
  const roadload = [...byRef.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { roadload, params, warnings };
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ───────────────────────────── Files ─────────────────────────────

export interface CataloguePaths {
  teslas: string;
  src: string;
  roadload: string;
  params: string;
  teslaSchema: string;
  roadloadSchema: string;
}

export function cataloguePaths(rootDir: string): CataloguePaths {
  const data = join(rootDir, 'src', 'data');
  return {
    teslas: join(data, 'teslas.json'),
    src: join(data, 'raw', 'roadload-src.json'),
    roadload: join(data, 'roadload.json'),
    params: join(data, 'tesla-params.json'),
    teslaSchema: join(data, 'schema', 'tesla.schema.json'),
    roadloadSchema: join(data, 'schema', 'roadload.schema.json'),
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function assertValid(schemaPath: string, data: unknown, label: string): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(readJson(schemaPath) as object);
  if (!validate(data)) {
    throw new Error(`${label} fails ${schemaPath}:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`);
  }
}

/** Builds the generated files in memory. Keys are absolute output paths. */
export function generate(rootDir: string): { files: Record<string, string>; warnings: string[] } {
  const paths = cataloguePaths(rootDir);
  const teslasJson = readJson(paths.teslas);
  assertValid(paths.teslaSchema, teslasJson, 'teslas.json');
  const srcJson = readJson(paths.src);
  if (!Array.isArray(srcJson)) throw new Error('roadload-src.json must be an array');
  const built = buildCatalogue(teslasJson as TeslaRecord[], srcJson as RoadLoadSrc[]);
  assertValid(paths.roadloadSchema, built.roadload, 'generated roadload.json');
  return {
    files: { [paths.roadload]: serialize(built.roadload), [paths.params]: serialize(built.params) },
    warnings: built.warnings,
  };
}

/** Paths whose committed content differs from a fresh build (missing files count as stale). */
export function checkCatalogue(rootDir: string): string[] {
  const { files } = generate(rootDir);
  const stale: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    let current: string | null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) stale.push(path);
  }
  return stale;
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function main(argv: string[], rootDir: string = REPO_ROOT): number {
  if (argv.includes('--check')) {
    const stale = checkCatalogue(rootDir);
    if (stale.length > 0) {
      console.error(`Catalogue out of date (run: npx tsx tools/build-catalogue.ts):\n  ${stale.join('\n  ')}`);
      return 1;
    }
    console.log('Catalogue up to date.');
    return 0;
  }
  const { files, warnings } = generate(rootDir);
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
