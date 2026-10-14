/**
 * Persisted user settings (phase-3 contract T2, spec §10.3), stored as `tesbox.v1.settings` through
 * src/platform/storage.ts. Every field is validated on its own when loaded: a missing or invalid
 * field takes its default and the other fields survive, so corrupt, older or hand-edited data never
 * crashes the app and never loses more than the broken field. The store's updateSettings validates
 * patches the same way, except that a bad patch field keeps its current value (sanitizeSettings'
 * fallback) instead of resetting to the default.
 */
import {
  DEFAULT_OUTPUT,
  DEFAULT_SIM_TUNING,
  type DriveMode,
  type GearboxMode,
  type OutputRoute,
  type Perspective,
  type Subwoofer,
  type TeslaParams,
  type TeslaRecord,
  type ValveMode,
} from '../contracts';
import { TESLAS, notListedParams, resolveTeslaParams } from '../data/catalogue';
import { ENGINES } from '../data/engines';
import { getJSON, setJSON } from '../platform/storage';

export type Units = 'mph' | 'kmh';
/** Metres per second → `units`, for the speed readouts (Drive, Diagnostics). */
export const MPS_TO_UNITS: Readonly<Record<Units, number>> = { mph: 3600 / 1609.344, kmh: 3.6 };
export type TierPref = 'auto' | 'full' | 'lite';
/** A Tesla missing from the catalogue (spec §9.1), entered on the picker's parked-only form. */
export interface NotListed {
  /** 0–100 km/h time, within NOT_LISTED_ZERO_TO_100_RANGE_S. */
  zeroTo100S: number;
  /** Within NOT_LISTED_MASS_RANGE_KG. */
  massKg: number;
  body: 'sedan' | 'suv' | 'truck';
}

export interface Settings {
  v: 1;
  /** TeslaRecord.id, or null when notListed is used / not chosen yet. */
  teslaId: string | null;
  notListed: NotListed | null;
  /** accelModes[].name of the selected record; null = quickest. */
  accelMode: string | null;
  /** Asked only for MCU1-era records. */
  mcu2Retrofit: boolean | null;
  /** Picker default from record.subwooferDefault ? 'yes' : 'no'; 'unsure' if skipped. */
  subwoofer: Subwoofer;
  /** No-sub high-pass corner from the bass sweep (spec §5.6, §9.3). */
  hpCornerHz: number;
  engineId: string;
  gearboxMode: GearboxMode;
  driveMode: DriveMode;
  valve: ValveMode;
  perspective: Perspective;
  volumeTrimDb: number;
  source: 'gps' | 'demo' | 'keyboard';
  tierPref: TierPref;
  liteNextStart: boolean;
  gpsMethod: 'poll' | 'watch';
  highAccuracy: boolean;
  gpsLatencyS: number;
  outputRoute: OutputRoute;
  gamepadSwap: boolean;
  wheelShift: { tested: boolean; works: boolean; enabled: boolean };
  /** Epoch ms of the last engine stop (the next start is warm if < 30 min later). */
  engineWarmAt: number | null;
  units: Units;
  noticesSeen: boolean;
  manualWarningSeen: boolean;
}

/**
 * Valid ranges (inclusive). A value outside one is invalid: it loads as the default, and in an
 * updateSettings patch it leaves the current value unchanged. Screens bound their inputs with these.
 */
export const HP_CORNER_RANGE_HZ = { min: 30, max: 60 } as const;
export const VOLUME_TRIM_RANGE_DB = { min: -24, max: 6 } as const;
/**
 * gpsLatencyS is added to every fix's age, and the speed filter rejects fixes older than 3 s
 * (src/sim/speed-filter.ts MAX_AGE_S), so a calibration at or near 3 s would discard every fix.
 */
export const GPS_LATENCY_RANGE_S = { min: 0, max: 2.5 } as const;
/**
 * "Not listed" form bounds. They hold every catalogue Tesla with a wide margin (1.99–6.8 s,
 * 1612–3113 kg) and keep notListedParams finite: a corrupt 1e308 kg or 1e-320 s entry would make the
 * traction force infinite and the simulated load NaN. An entry outside them is rejected as a whole.
 */
export const NOT_LISTED_ZERO_TO_100_RANGE_S = { min: 1.5, max: 30 } as const;
export const NOT_LISTED_MASS_RANGE_KG = { min: 500, max: 5000 } as const;

const defaults: Settings = {
  v: 1,
  teslaId: null,
  notListed: null,
  accelMode: null,
  mcu2Retrofit: null,
  subwoofer: DEFAULT_OUTPUT.subwoofer, // 'unsure'
  hpCornerHz: DEFAULT_OUTPUT.hpCornerHz, // 40
  engineId: 'i5-turbo-25',
  gearboxMode: 'auto', // spec §13: Auto is the default
  driveMode: 'comfort',
  valve: 'auto',
  perspective: 'cabin', // spec §5.3.11
  volumeTrimDb: DEFAULT_OUTPUT.volumeTrimDb, // 0
  source: 'gps',
  tierPref: 'auto',
  liteNextStart: false,
  gpsMethod: 'poll', // spec §3/§8.1: getCurrentPosition polling, high accuracy off
  highAccuracy: false,
  gpsLatencyS: DEFAULT_SIM_TUNING.gpsLatencyS, // 1.0
  outputRoute: 'direct-anchor', // spec §6.4
  gamepadSwap: false,
  wheelShift: { tested: false, works: false, enabled: false },
  engineWarmAt: null,
  units: 'mph',
  noticesSeen: false,
  manualWarningSeen: false,
};
Object.freeze(defaults.wheelShift);

/** Deeply frozen; loadSettings / sanitizeSettings always return fresh objects. */
export const DEFAULT_SETTINGS: Settings = Object.freeze(defaults);

/** Stored as `tesbox.v1.settings` via src/platform/storage.ts. */
export const SETTINGS_KEY = 'settings';

// Exhaustive member tables: adding a member to a union without listing it here is a compile error.
const SUBWOOFERS: Record<Subwoofer, true> = { yes: true, no: true, unsure: true };
const GEARBOX_MODES: Record<GearboxMode, true> = { auto: true, manual: true };
const DRIVE_MODES: Record<DriveMode, true> = { comfort: true, sport: true };
const VALVE_MODES: Record<ValveMode, true> = { auto: true, open: true, closed: true };
const PERSPECTIVES: Record<Perspective, true> = { cabin: true, outside: true };
const SOURCES: Record<Settings['source'], true> = { gps: true, demo: true, keyboard: true };
const TIER_PREFS: Record<TierPref, true> = { auto: true, full: true, lite: true };
const GPS_METHODS: Record<Settings['gpsMethod'], true> = { poll: true, watch: true };
const OUTPUT_ROUTES: Record<OutputRoute, true> = { direct: true, 'media-element': true, 'direct-anchor': true };
const UNITS: Record<Units, true> = { mph: true, kmh: true };
const BODIES: Record<NotListed['body'], true> = { sedan: true, suv: true, truck: true };

type Raw = Readonly<Record<string, unknown>>;

function isRaw(x: unknown): x is Raw {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Own-property lookup, so "toString" / "__proto__" never count as members. */
function isMember<T extends string>(table: Record<T, true>, value: unknown): value is T {
  return typeof value === 'string' && Object.hasOwn(table, value);
}

function member<T extends string>(table: Record<T, true>, value: unknown, fallback: T): T {
  return isMember(table, value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

type Range = { readonly min: number; readonly max: number };

/** Finite range bounds also reject NaN and ±Infinity (JSON.parse turns 1e999 into Infinity). */
function isInRange(value: unknown, range: Range): value is number {
  return typeof value === 'number' && value >= range.min && value <= range.max;
}

function inRange(value: unknown, range: Range, fallback: number): number {
  return isInRange(value, range) ? value : fallback;
}

function findTesla(id: unknown): TeslaRecord | undefined {
  return typeof id === 'string' ? TESLAS.find((r) => r.id === id) : undefined;
}

/** A complete, plausible "not listed" entry (a fresh copy), else null. */
function validNotListed(x: unknown): NotListed | null {
  if (!isRaw(x)) return null;
  const { zeroTo100S, massKg, body } = x;
  if (
    !isInRange(zeroTo100S, NOT_LISTED_ZERO_TO_100_RANGE_S) ||
    !isInRange(massKg, NOT_LISTED_MASS_RANGE_KG) ||
    !isMember(BODIES, body)
  ) {
    return null;
  }
  return { zeroTo100S, massKg, body };
}

/** Each sub-field on its own: an invalid or missing one takes the fallback's. */
function validWheelShift(x: unknown, fallback: Settings['wheelShift']): Settings['wheelShift'] {
  const w: Raw = isRaw(x) ? x : {};
  return {
    tested: bool(w.tested, fallback.tested),
    works: bool(w.works, fallback.works),
    enabled: bool(w.enabled, fallback.enabled),
  };
}

/**
 * Turns any value into valid Settings, field by field: an invalid or missing (undefined) field takes
 * the fallback's value — DEFAULT_SETTINGS unless given; updateSettings passes the current settings,
 * so a bad patch field changes nothing. null is a valid value of the nullable fields (it clears
 * them). Unknown fields are dropped and `v` is always 1. Dependent field: accelMode survives only
 * when it names a mode of the selected catalogue record. The fallback is validated too, so the
 * result is always valid. Never throws; always returns a fresh object.
 */
export function sanitizeSettings(raw: unknown, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const r: Raw = isRaw(raw) ? raw : {};
  const d = fallback === DEFAULT_SETTINGS ? DEFAULT_SETTINGS : sanitizeSettings(fallback);
  const { accelMode, mcu2Retrofit, engineId, engineWarmAt: warmAt } = r;
  const tesla = r.teslaId === null ? undefined : (findTesla(r.teslaId) ?? findTesla(d.teslaId));
  /** null = quickest; a name only when the selected record has that mode. */
  const isMode = (m: unknown): m is string | null =>
    m === null || (typeof m === 'string' && tesla !== undefined && tesla.accelModes.some((x) => x.name === m));
  return {
    v: 1,
    teslaId: tesla?.id ?? null,
    notListed: r.notListed === null ? null : (validNotListed(r.notListed) ?? validNotListed(d.notListed)),
    accelMode: isMode(accelMode) ? accelMode : isMode(d.accelMode) ? d.accelMode : null,
    mcu2Retrofit: mcu2Retrofit === null || typeof mcu2Retrofit === 'boolean' ? mcu2Retrofit : d.mcu2Retrofit,
    subwoofer: member(SUBWOOFERS, r.subwoofer, d.subwoofer),
    hpCornerHz: inRange(r.hpCornerHz, HP_CORNER_RANGE_HZ, d.hpCornerHz),
    engineId: typeof engineId === 'string' && ENGINES.some((e) => e.id === engineId) ? engineId : d.engineId,
    gearboxMode: member(GEARBOX_MODES, r.gearboxMode, d.gearboxMode),
    driveMode: member(DRIVE_MODES, r.driveMode, d.driveMode),
    valve: member(VALVE_MODES, r.valve, d.valve),
    perspective: member(PERSPECTIVES, r.perspective, d.perspective),
    volumeTrimDb: inRange(r.volumeTrimDb, VOLUME_TRIM_RANGE_DB, d.volumeTrimDb),
    source: member(SOURCES, r.source, d.source),
    tierPref: member(TIER_PREFS, r.tierPref, d.tierPref),
    liteNextStart: bool(r.liteNextStart, d.liteNextStart),
    gpsMethod: member(GPS_METHODS, r.gpsMethod, d.gpsMethod),
    highAccuracy: bool(r.highAccuracy, d.highAccuracy),
    gpsLatencyS: inRange(r.gpsLatencyS, GPS_LATENCY_RANGE_S, d.gpsLatencyS),
    outputRoute: member(OUTPUT_ROUTES, r.outputRoute, d.outputRoute),
    gamepadSwap: bool(r.gamepadSwap, d.gamepadSwap),
    wheelShift: validWheelShift(r.wheelShift, d.wheelShift),
    engineWarmAt:
      warmAt === null || (typeof warmAt === 'number' && Number.isFinite(warmAt) && warmAt >= 0) ? warmAt : d.engineWarmAt,
    units: member(UNITS, r.units, d.units),
    noticesSeen: bool(r.noticesSeen, d.noticesSeen),
    manualWarningSeen: bool(r.manualWarningSeen, d.manualWarningSeen),
  };
}

/** Per-field validation: invalid/missing field → default. Never throws (storage errors → defaults). */
export function loadSettings(): Settings {
  return sanitizeSettings(getJSON<unknown>(SETTINGS_KEY, null));
}

/** False when storage is unavailable or full (the session keeps working from memory). */
export function saveSettings(s: Settings): boolean {
  return setJSON(SETTINGS_KEY, s);
}

/**
 * Simulation numbers for the chosen Tesla: resolveTeslaParams for a catalogue record (a stale
 * accelMode that the record lacks falls back to the quickest mode), notListedParams for a
 * "not listed" entry, null while nothing usable is chosen. A catalogue record takes precedence
 * (teslaId is null whenever notListed is in use). Never throws, even on unsanitised input.
 */
export function teslaParamsFor(s: Settings): TeslaParams | null {
  const record = findTesla(s.teslaId);
  if (record !== undefined) {
    const mode = record.accelModes.find((m) => m.name === s.accelMode);
    return resolveTeslaParams(record.id, mode?.name);
  }
  const nl = validNotListed(s.notListed);
  return nl === null ? null : notListedParams(nl.zeroTo100S, nl.massKg, nl.body);
}

/** No Tesla chosen (teslaId and notListed both null — or unusable) or the notices not yet seen. */
export function needsFirstRun(s: Settings): boolean {
  return !s.noticesSeen || (findTesla(s.teslaId) === undefined && validNotListed(s.notListed) === null);
}
