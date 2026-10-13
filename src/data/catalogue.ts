import { ETA_DRIVETRAIN, type RoadLoadRecord, type TeslaParams, type TeslaRecord } from '../contracts';
import roadloadJson from './roadload.json';
import paramsJson from './tesla-params.json';
import teslasJson from './teslas.json';

/** JSON imports widen literal unions to string; tesla/roadload schemas (tests + build tool) are the real guard. */
export const TESLAS: TeslaRecord[] = teslasJson as unknown as TeslaRecord[];
export const ROADLOAD: RoadLoadRecord[] = roadloadJson as unknown as RoadLoadRecord[];

/** Fitted at build time by tools/build-catalogue.ts (never edit by hand). */
const PARAMS = paramsJson as unknown as Record<string, { massKg: number; fTracN: number; pEffW: number }>;

/** "Not listed" road load (N, N·s/m, N·s²/m²) per body style (phase-1 contract). */
const NOT_LISTED_ROAD: Record<'sedan' | 'suv' | 'truck', TeslaParams['roadLoad']> = {
  sedan: { A_N: 130, B_Nps_m: 1.0, C_Ns2_m2: 0.4 },
  suv: { A_N: 160, B_Nps_m: 1.5, C_Ns2_m2: 0.48 },
  truck: { A_N: 220, B_Nps_m: 2.0, C_Ns2_m2: 0.62 },
};
/** "No power term": large enough that η·P/v never binds below ~300 km/h. */
const NOT_LISTED_PEFF_W = 1e9;
const KMH100_MPS = 27.7778;

export function resolveTeslaParams(recordId: string, modeName?: string): TeslaParams {
  const record = TESLAS.find((r) => r.id === recordId);
  if (record === undefined) throw new Error(`Unknown Tesla record "${recordId}"`);
  const mode =
    modeName === undefined
      ? record.accelModes[record.accelModes.length - 1]
      : record.accelModes.find((m) => m.name === modeName);
  if (mode === undefined) throw new Error(`Tesla record "${recordId}" has no acceleration mode "${modeName ?? '(default)'}"`);
  const rl = ROADLOAD.find((x) => x.ref === record.roadLoadRef);
  if (rl === undefined) throw new Error(`Tesla record "${recordId}": roadLoadRef "${record.roadLoadRef}" not found`);
  const fitted = PARAMS[recordId];
  if (fitted === undefined) throw new Error(`Tesla record "${recordId}" has no fitted params (run tools/build-catalogue.ts)`);
  return {
    massKg: fitted.massKg,
    roadLoad: { A_N: rl.A_N, B_Nps_m: rl.B_Nps_m, C_Ns2_m2: rl.C_Ns2_m2 },
    fTracN: fitted.fTracN,
    pEffW: fitted.pEffW,
    eta: ETA_DRIVETRAIN,
    modeFactor: mode.factor,
  };
}

/** Params for a Tesla that is not in the catalogue (user enters 0–100 km/h time and mass, parked). */
export function notListedParams(zeroTo100S: number, massKg: number, body: 'sedan' | 'suv' | 'truck'): TeslaParams {
  if (!(Number.isFinite(zeroTo100S) && zeroTo100S > 0)) throw new RangeError(`zeroTo100S must be > 0, got ${zeroTo100S}`);
  if (!(Number.isFinite(massKg) && massKg > 0)) throw new RangeError(`massKg must be > 0, got ${massKg}`);
  const road = NOT_LISTED_ROAD[body];
  return {
    massKg,
    roadLoad: { A_N: road.A_N, B_Nps_m: road.B_Nps_m, C_Ns2_m2: road.C_Ns2_m2 },
    fTracN: massKg * (KMH100_MPS / zeroTo100S) * 1.25,
    pEffW: NOT_LISTED_PEFF_W,
    eta: ETA_DRIVETRAIN,
    modeFactor: 1,
  };
}
