import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  GPS_LATENCY_RANGE_S,
  HP_CORNER_RANGE_HZ,
  NOT_LISTED_MASS_RANGE_KG,
  NOT_LISTED_ZERO_TO_100_RANGE_S,
  SETTINGS_KEY,
  VOLUME_TRIM_RANGE_DB,
  loadSettings,
  needsFirstRun,
  sanitizeSettings,
  saveSettings,
  teslaParamsFor,
  type Settings,
} from '../../src/app/settings';
import { DEFAULT_OUTPUT, DEFAULT_SIM_TUNING } from '../../src/contracts';
import { TESLAS, notListedParams, resolveTeslaParams } from '../../src/data/catalogue';
import { ENGINES, getEngine } from '../../src/data/engines';

/** Minimal in-memory Storage (same shape as tests/unit/storage.test.ts) with failure switches. */
class FakeStorage {
  readonly map = new Map<string, string>();
  throwOnSet = false;
  throwOnGet = false;
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.throwOnGet) throw new DOMException('denied', 'SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const STORED_KEY = 'tesbox.v1.settings';
const HIGHLAND_LR = 'model3-highland-lr-awd'; // accelModes Chill | Standard, subwooferDefault true

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fake });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function storeRaw(json: string): void {
  fake.map.set(STORED_KEY, json);
}
function store(value: unknown): void {
  storeRaw(JSON.stringify(value));
}

/** Every field differs from its default, so a field falling back to its default is observable. */
const CUSTOM: Settings = {
  v: 1,
  teslaId: HIGHLAND_LR,
  notListed: null,
  accelMode: 'Chill',
  mcu2Retrofit: false,
  subwoofer: 'yes',
  hpCornerHz: 45,
  engineId: 'v8-na-50',
  gearboxMode: 'manual',
  driveMode: 'sport',
  valve: 'open',
  perspective: 'outside',
  volumeTrimDb: -6.5,
  source: 'demo',
  tierPref: 'lite',
  liteNextStart: true,
  gpsMethod: 'watch',
  highAccuracy: true,
  gpsLatencyS: 1.4,
  outputRoute: 'media-element',
  gamepadSwap: true,
  wheelShift: { tested: true, works: true, enabled: true },
  engineWarmAt: 1_760_000_000_000,
  units: 'kmh',
  noticesSeen: true,
  manualWarningSeen: true,
};

const NOT_LISTED = { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } as const;

/** The string-union fields, validated by own-property lookup in a member table. */
const ENUM_FIELDS = [
  'subwoofer',
  'gearboxMode',
  'driveMode',
  'valve',
  'perspective',
  'source',
  'tierPref',
  'gpsMethod',
  'outputRoute',
  'units',
] as const satisfies readonly (keyof Settings)[];
/** Names every object inherits: never members of a union (an `in` lookup would accept them). */
const PROTOTYPE_NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

/** [field, invalid value] rows: each is stored over CUSTOM, so only that field may change. */
const INVALID: [keyof Settings, unknown][] = [
  ['mcu2Retrofit', 'yes'],
  ['mcu2Retrofit', 1],
  ['accelMode', 'Plaid'], // not a mode of the selected Highland LR
  ['accelMode', 7],
  ['subwoofer', 'maybe'],
  ['subwoofer', true],
  ['hpCornerHz', 29.9],
  ['hpCornerHz', 60.1],
  ['hpCornerHz', '45'],
  ['hpCornerHz', null],
  ['engineId', 'v9-imaginary'],
  ['engineId', 3],
  ['engineId', 'toString'],
  ['gearboxMode', 'sequential'],
  ['driveMode', 'track'],
  ['valve', 'half'],
  ['perspective', 'roof'],
  ['volumeTrimDb', -24.1],
  ['volumeTrimDb', 6.1],
  ['volumeTrimDb', '0'],
  ['volumeTrimDb', false],
  ['source', 'replay'], // a SpeedSourceKind, but never a user-selectable source
  ['source', 'GPS'],
  ['tierPref', 'ultra'],
  ['liteNextStart', 'true'],
  ['liteNextStart', 1],
  ['gpsMethod', 'push'],
  ['highAccuracy', 'yes'],
  ['gpsLatencyS', -0.1],
  ['gpsLatencyS', 2.6],
  ['gpsLatencyS', '1'],
  ['outputRoute', 'bluetooth'],
  ['gamepadSwap', 0],
  ['wheelShift', 'yes'],
  ['wheelShift', null],
  ['wheelShift', [true, true, true]],
  ['engineWarmAt', -1],
  ['engineWarmAt', '1760000000000'],
  ['engineWarmAt', true],
  ['units', 'knots'],
  ['noticesSeen', 'true'],
  ['manualWarningSeen', 1],
  ...ENUM_FIELDS.flatMap((field) => PROTOTYPE_NAMES.map((name): [keyof Settings, unknown] => [field, name])),
];

describe('DEFAULT_SETTINGS', () => {
  it('holds the phase-3 contract defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      v: 1,
      teslaId: null,
      notListed: null,
      accelMode: null,
      mcu2Retrofit: null,
      subwoofer: 'unsure',
      hpCornerHz: 40,
      engineId: 'i5-turbo-25',
      gearboxMode: 'auto',
      driveMode: 'comfort',
      valve: 'auto',
      perspective: 'cabin',
      volumeTrimDb: 0,
      source: 'gps',
      tierPref: 'auto',
      liteNextStart: false,
      gpsMethod: 'poll',
      highAccuracy: false,
      gpsLatencyS: 1,
      outputRoute: 'direct-anchor',
      gamepadSwap: false,
      wheelShift: { tested: false, works: false, enabled: false },
      engineWarmAt: null,
      units: 'mph',
      noticesSeen: false,
      manualWarningSeen: false,
    } satisfies Settings);
  });

  it('agrees with the shared contract defaults and resolves its engine', () => {
    expect(DEFAULT_SETTINGS.gpsLatencyS).toBe(DEFAULT_SIM_TUNING.gpsLatencyS);
    expect(DEFAULT_SETTINGS.subwoofer).toBe(DEFAULT_OUTPUT.subwoofer);
    expect(DEFAULT_SETTINGS.hpCornerHz).toBe(DEFAULT_OUTPUT.hpCornerHz);
    expect(DEFAULT_SETTINGS.volumeTrimDb).toBe(DEFAULT_OUTPUT.volumeTrimDb);
    expect(getEngine(DEFAULT_SETTINGS.engineId).id).toBe('i5-turbo-25');
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.wheelShift)).toBe(true);
  });

  it('is itself valid (sanitising it changes nothing)', () => {
    expect(sanitizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('saveSettings / loadSettings', () => {
  it('stores under tesbox.v1.settings and round-trips every field', () => {
    expect(SETTINGS_KEY).toBe('settings');
    expect(saveSettings(CUSTOM)).toBe(true);
    expect(JSON.parse(fake.map.get(STORED_KEY) ?? 'null')).toEqual(CUSTOM);
    expect(loadSettings()).toEqual(CUSTOM);
  });

  it('round-trips a "not listed" Tesla', () => {
    const s: Settings = { ...CUSTOM, teslaId: null, accelMode: null, notListed: { ...NOT_LISTED } };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh, mutable object that shares nothing with DEFAULT_SETTINGS', () => {
    const a = loadSettings();
    const b = loadSettings();
    expect(a).not.toBe(DEFAULT_SETTINGS);
    expect(a).not.toBe(b);
    expect(a.wheelShift).not.toBe(DEFAULT_SETTINGS.wheelShift);
    expect(() => {
      a.wheelShift.enabled = true;
      a.units = 'kmh';
    }).not.toThrow();
    expect(DEFAULT_SETTINGS.wheelShift.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.units).toBe('mph');

    store({ ...CUSTOM, notListed: { ...NOT_LISTED }, teslaId: null, accelMode: null });
    const c = loadSettings();
    const d = loadSettings();
    expect(c.notListed).toEqual(NOT_LISTED);
    expect(c.notListed).not.toBe(d.notListed);
  });

  it('returns false from saveSettings when storage is full or missing', () => {
    fake.throwOnSet = true;
    expect(saveSettings(CUSTOM)).toBe(false);
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(saveSettings(CUSTOM)).toBe(false);
  });
});

describe('loadSettings never throws and falls back to defaults (spec §10.3, acceptance 3)', () => {
  it.each([
    ['corrupt JSON', '{"units": "kmh",'],
    ['empty string', ''],
    ['an array', '[1, 2, 3]'],
    ['a string', '"settings"'],
    ['a number', '42'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('stored value is %s', (_label, raw) => {
    storeRaw(raw);
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when localStorage is absent', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when the localStorage getter throws (site data blocked)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('when getItem throws', () => {
    store(CUSTOM);
    fake.throwOnGet = true;
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores __proto__ keys and does not pollute prototypes', () => {
    storeRaw('{"__proto__": {"polluted": true, "units": "kmh"}, "units": "kmh"}');
    const s = loadSettings();
    expect(s.units).toBe('kmh');
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
    expect('polluted' in s).toBe(false);
    expect('polluted' in {}).toBe(false);
  });
});

describe('per-field validation: an invalid or missing field takes its default, valid fields survive', () => {
  // Each row stores CUSTOM with one field replaced; that field must come back as its default and
  // every other field must come back unchanged.
  it.each(INVALID)('%s = %j', (field, bad) => {
    store({ ...CUSTOM, [field]: bad });
    const loaded = loadSettings();
    expect(loaded[field]).toEqual(DEFAULT_SETTINGS[field]);
    expect({ ...loaded, [field]: CUSTOM[field] }).toEqual(CUSTOM);
  });

  it.each(Object.keys(CUSTOM) as (keyof Settings)[])('missing %s', (field) => {
    const partial: Record<string, unknown> = { ...CUSTOM };
    delete partial[field];
    store(partial);
    const loaded = loadSettings();
    // Without a Tesla there is no acceleration mode to keep.
    const expected: Settings = field === 'teslaId' ? { ...CUSTOM, teslaId: null, accelMode: null } : CUSTOM;
    expect(loaded).toEqual({ ...expected, [field]: DEFAULT_SETTINGS[field] });
  });

  it('fills every missing field of a partial object', () => {
    store({ units: 'kmh', noticesSeen: true });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, units: 'kmh', noticesSeen: true });
  });

  it('rejects non-finite numbers that JSON.parse can produce (1e999 → Infinity)', () => {
    storeRaw('{"hpCornerHz": 1e999, "volumeTrimDb": -1e999, "gpsLatencyS": 1e999, "engineWarmAt": 1e999}');
    const s = loadSettings();
    expect(s.hpCornerHz).toBe(40);
    expect(s.volumeTrimDb).toBe(0);
    expect(s.gpsLatencyS).toBe(1);
    expect(s.engineWarmAt).toBeNull();
  });

  it('accepts the inclusive ends of every numeric range', () => {
    store({
      hpCornerHz: HP_CORNER_RANGE_HZ.min,
      volumeTrimDb: VOLUME_TRIM_RANGE_DB.min,
      gpsLatencyS: GPS_LATENCY_RANGE_S.min,
      engineWarmAt: 0,
    });
    expect(loadSettings()).toMatchObject({ hpCornerHz: 30, volumeTrimDb: -24, gpsLatencyS: 0, engineWarmAt: 0 });
    store({
      hpCornerHz: HP_CORNER_RANGE_HZ.max,
      volumeTrimDb: VOLUME_TRIM_RANGE_DB.max,
      gpsLatencyS: GPS_LATENCY_RANGE_S.max,
    });
    expect(loadSettings()).toMatchObject({ hpCornerHz: 60, volumeTrimDb: 6, gpsLatencyS: 2.5 });
  });

  it('keeps gpsLatencyS below the speed filter 3 s stale-fix cutoff', () => {
    expect(GPS_LATENCY_RANGE_S.max).toBeLessThan(3);
  });

  it('always reports schema version 1 and drops unknown fields', () => {
    store({ ...CUSTOM, v: 2, extra: 'x', wheelShift: { ...CUSTOM.wheelShift, extra: 1 } });
    const s = loadSettings();
    expect(s).toEqual(CUSTOM);
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(s.wheelShift).sort()).toEqual(['enabled', 'tested', 'works']);
  });

  it('validates wheelShift sub-fields independently', () => {
    store({ ...CUSTOM, wheelShift: { tested: true, works: 'yes', enabled: true } });
    expect(loadSettings().wheelShift).toEqual({ tested: true, works: false, enabled: true });
    store({ ...CUSTOM, wheelShift: {} });
    expect(loadSettings().wheelShift).toEqual({ tested: false, works: false, enabled: false });
  });

  it('accepts every engine id in the garage', () => {
    for (const e of ENGINES) {
      store({ engineId: e.id });
      expect(loadSettings().engineId).toBe(e.id);
    }
  });
});

describe('Tesla selection validation', () => {
  it('drops an unknown or non-string teslaId and the acceleration mode that went with it', () => {
    for (const bad of ['model9-imaginary', 42, {}, true]) {
      store({ ...CUSTOM, teslaId: bad });
      expect(loadSettings()).toEqual({ ...CUSTOM, teslaId: null, accelMode: null });
    }
  });

  it('keeps accelMode only when it names a mode of the selected record', () => {
    store({ ...CUSTOM, accelMode: 'Standard' });
    expect(loadSettings().accelMode).toBe('Standard');
    store({ ...CUSTOM, accelMode: 'Plaid' }); // not a Highland LR mode
    expect(loadSettings().accelMode).toBeNull();
    store({ ...CUSTOM, accelMode: 7 });
    expect(loadSettings().accelMode).toBeNull();
    store({ ...CUSTOM, teslaId: null, accelMode: 'Chill' }); // no record, no modes
    expect(loadSettings().accelMode).toBeNull();
  });

  it('accepts every catalogue record with each of its acceleration modes', () => {
    for (const r of TESLAS) {
      for (const m of r.accelModes) {
        const s = sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: r.id, accelMode: m.name });
        expect(s.teslaId).toBe(r.id);
        expect(s.accelMode).toBe(m.name);
        expect(teslaParamsFor(s)?.modeFactor).toBe(m.factor);
      }
    }
  });

  it('keeps a valid "not listed" entry and rejects an invalid one as a whole', () => {
    store({ ...CUSTOM, teslaId: null, accelMode: null, notListed: NOT_LISTED });
    expect(loadSettings().notListed).toEqual(NOT_LISTED);
    const bad: unknown[] = [
      { ...NOT_LISTED, zeroTo100S: 0 },
      { ...NOT_LISTED, zeroTo100S: -4 },
      { ...NOT_LISTED, zeroTo100S: '6.1' },
      { ...NOT_LISTED, massKg: 0 },
      { ...NOT_LISTED, massKg: null },
      { ...NOT_LISTED, body: 'van' },
      ...PROTOTYPE_NAMES.map((body) => ({ ...NOT_LISTED, body })),
      { zeroTo100S: 6.1, massKg: 1900 },
      'suv',
      [6.1, 1900, 'suv'],
    ];
    for (const notListed of bad) {
      store({ ...CUSTOM, teslaId: null, accelMode: null, notListed });
      expect(loadSettings().notListed).toBeNull();
    }
    storeRaw('{"notListed": {"zeroTo100S": 1e999, "massKg": 1900, "body": "suv"}}');
    expect(loadSettings().notListed).toBeNull();
  });

  it('rejects a "not listed" entry outside the plausible ranges (spec §10.3: corrupt → defaults)', () => {
    const bad = [
      { ...NOT_LISTED, zeroTo100S: 1.49 },
      { ...NOT_LISTED, zeroTo100S: 30.01 },
      { ...NOT_LISTED, zeroTo100S: 1e-320 }, // denormal: 1/x overflows to Infinity
      { ...NOT_LISTED, massKg: 499 },
      { ...NOT_LISTED, massKg: 5001 },
      { ...NOT_LISTED, massKg: 1e308 },
    ];
    for (const notListed of bad) {
      store({ ...CUSTOM, teslaId: null, accelMode: null, notListed });
      expect(loadSettings().notListed).toBeNull();
    }
  });

  it('loads a hand-edited huge mass as no Tesla: first run again, and no Infinity reaches the sim', () => {
    storeRaw('{"noticesSeen":true,"notListed":{"zeroTo100S":5,"massKg":1e308,"body":"sedan"}}');
    const s = loadSettings();
    expect(s.notListed).toBeNull();
    expect(needsFirstRun(s)).toBe(true);
    expect(teslaParamsFor(s)).toBeNull();
  });

  it('accepts the inclusive ends of the "not listed" ranges, which give finite simulation numbers', () => {
    const t = NOT_LISTED_ZERO_TO_100_RANGE_S;
    const m = NOT_LISTED_MASS_RANGE_KG;
    expect([t.min, t.max, m.min, m.max]).toEqual([1.5, 30, 500, 5000]);
    for (const [zeroTo100S, massKg] of [
      [t.min, m.min],
      [t.min, m.max],
      [t.max, m.min],
      [t.max, m.max],
    ] as const) {
      const notListed = { zeroTo100S, massKg, body: 'truck' } as const;
      store({ ...CUSTOM, teslaId: null, accelMode: null, notListed });
      const s = loadSettings();
      expect(s.notListed).toEqual(notListed);
      const p = teslaParamsFor(s);
      expect(p).not.toBeNull();
      const numbers = [p?.massKg, p?.fTracN, p?.pEffW, p?.eta, p?.modeFactor, ...Object.values(p?.roadLoad ?? {})];
      expect(numbers.every((x) => typeof x === 'number' && Number.isFinite(x))).toBe(true);
    }
  });

  it('the "not listed" ranges hold every catalogue Tesla', () => {
    for (const r of TESLAS) {
      expect(r.massKg).toBeGreaterThanOrEqual(NOT_LISTED_MASS_RANGE_KG.min);
      expect(r.massKg).toBeLessThanOrEqual(NOT_LISTED_MASS_RANGE_KG.max);
      expect(r.accel.seconds).toBeGreaterThanOrEqual(NOT_LISTED_ZERO_TO_100_RANGE_S.min);
      expect(r.accel.seconds).toBeLessThanOrEqual(NOT_LISTED_ZERO_TO_100_RANGE_S.max);
    }
  });

  it('accepts mcu2Retrofit true, false and null', () => {
    for (const v of [true, false, null]) {
      store({ ...CUSTOM, mcu2Retrofit: v });
      expect(loadSettings().mcu2Retrofit).toBe(v);
    }
  });
});

describe('sanitizeSettings', () => {
  it('is idempotent and keeps a valid object unchanged', () => {
    expect(sanitizeSettings(CUSTOM)).toEqual(CUSTOM);
    const once = sanitizeSettings({ ...CUSTOM, hpCornerHz: 99, teslaId: 'nope' });
    expect(sanitizeSettings(once)).toEqual(once);
  });

  it('returns defaults for non-objects', () => {
    for (const raw of [undefined, null, 1, 'x', [], true]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('sanitizeSettings with a fallback (updateSettings passes the current settings)', () => {
  it.each(INVALID)('%s = %j keeps the fallback value, not the default', (field, bad) => {
    expect(sanitizeSettings({ ...CUSTOM, [field]: bad }, CUSTOM)).toEqual(CUSTOM);
  });

  it.each(Object.keys(CUSTOM) as (keyof Settings)[])('missing or undefined %s keeps the fallback value', (field) => {
    const partial: Record<string, unknown> = { ...CUSTOM };
    delete partial[field];
    expect(sanitizeSettings(partial, CUSTOM)).toEqual(CUSTOM);
    expect(sanitizeSettings({ ...CUSTOM, [field]: undefined }, CUSTOM)).toEqual(CUSTOM);
  });

  it('takes every field from the fallback for a non-object', () => {
    for (const raw of [undefined, null, 1, 'x', [], true]) expect(sanitizeSettings(raw, CUSTOM)).toEqual(CUSTOM);
  });

  it('keeps the fallback Tesla, and its acceleration mode, for an unknown teslaId', () => {
    for (const bad of ['model9-imaginary', 42, {}, true, 'toString']) {
      expect(sanitizeSettings({ ...CUSTOM, teslaId: bad }, CUSTOM)).toEqual(CUSTOM);
    }
  });

  it('accepts null for every nullable field, so a patch can still clear it', () => {
    expect(sanitizeSettings({ ...CUSTOM, teslaId: null }, CUSTOM)).toEqual({ ...CUSTOM, teslaId: null, accelMode: null });
    expect(sanitizeSettings({ ...CUSTOM, accelMode: null }, CUSTOM)).toEqual({ ...CUSTOM, accelMode: null });
    expect(sanitizeSettings({ ...CUSTOM, mcu2Retrofit: null }, CUSTOM)).toEqual({ ...CUSTOM, mcu2Retrofit: null });
    expect(sanitizeSettings({ ...CUSTOM, engineWarmAt: null }, CUSTOM)).toEqual({ ...CUSTOM, engineWarmAt: null });
    const notListed: Settings = { ...CUSTOM, teslaId: null, accelMode: null, notListed: { ...NOT_LISTED } };
    expect(sanitizeSettings({ ...notListed, notListed: null }, notListed)).toEqual({ ...notListed, notListed: null });
  });

  it('drops an acceleration mode the newly selected Tesla lacks, even though the fallback had it', () => {
    const plaid = TESLAS.find((r) => r.accelModes.some((m) => m.name === 'Plaid'));
    if (plaid === undefined) throw new Error('catalogue has no Plaid-mode record');
    const current = sanitizeSettings({ ...CUSTOM, teslaId: plaid.id, accelMode: 'Plaid' });
    expect(current.accelMode).toBe('Plaid');
    expect(sanitizeSettings({ ...current, teslaId: HIGHLAND_LR }, current).accelMode).toBeNull();
    expect(sanitizeSettings({ ...current, teslaId: HIGHLAND_LR, accelMode: 'Bogus' }, current).accelMode).toBeNull();
    expect(sanitizeSettings({ ...current, teslaId: HIGHLAND_LR, accelMode: 'Chill' }, current).accelMode).toBe('Chill');
  });

  it('keeps each invalid or missing wheelShift sub-field from the fallback', () => {
    expect(sanitizeSettings({ ...CUSTOM, wheelShift: { enabled: false } }, CUSTOM).wheelShift).toEqual({
      tested: true,
      works: true,
      enabled: false,
    });
    expect(sanitizeSettings({ ...CUSTOM, wheelShift: { tested: 'no', works: false } }, CUSTOM).wheelShift).toEqual({
      tested: true,
      works: false,
      enabled: true,
    });
  });

  it('validates the fallback as well, so the result is always valid', () => {
    const broken = { ...CUSTOM, engineId: 'v9-imaginary', hpCornerHz: 99, units: 'knots' } as unknown as Settings;
    expect(sanitizeSettings({}, broken)).toEqual({ ...CUSTOM, engineId: 'i5-turbo-25', hpCornerHz: 40, units: 'mph' });
    expect(sanitizeSettings({ volumeTrimDb: -25 }, broken).volumeTrimDb).toBe(CUSTOM.volumeTrimDb);
    expect(sanitizeSettings({}, null as unknown as Settings)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ units: 'kmh' }, 'x' as unknown as Settings)).toEqual({ ...DEFAULT_SETTINGS, units: 'kmh' });
  });

  it('returns a fresh object that shares nothing with the fallback', () => {
    const fallback: Settings = { ...CUSTOM, teslaId: null, accelMode: null, notListed: { ...NOT_LISTED } };
    const s = sanitizeSettings({}, fallback);
    expect(s).toEqual(fallback);
    expect(s).not.toBe(fallback);
    expect(s.wheelShift).not.toBe(fallback.wheelShift);
    expect(s.notListed).not.toBe(fallback.notListed);
  });

  it('still falls back to the defaults without one (what loadSettings does)', () => {
    expect(sanitizeSettings({ ...CUSTOM, volumeTrimDb: -25 })).toEqual({ ...CUSTOM, volumeTrimDb: 0 });
  });
});

describe('teslaParamsFor', () => {
  it('is null while no Tesla is chosen', () => {
    expect(teslaParamsFor(DEFAULT_SETTINGS)).toBeNull();
  });

  it('resolves a catalogue record with the quickest mode when accelMode is null', () => {
    const s = { ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR };
    expect(teslaParamsFor(s)).toEqual(resolveTeslaParams(HIGHLAND_LR));
    expect(teslaParamsFor(s)?.modeFactor).toBe(1);
  });

  it('applies the selected acceleration mode', () => {
    const s = { ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR, accelMode: 'Chill' };
    expect(teslaParamsFor(s)).toEqual(resolveTeslaParams(HIGHLAND_LR, 'Chill'));
    expect(teslaParamsFor(s)?.modeFactor).toBe(0.5);
  });

  it('falls back to the quickest mode instead of throwing on a stale accelMode', () => {
    const s = { ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR, accelMode: 'Plaid' };
    expect(() => teslaParamsFor(s)).not.toThrow();
    expect(teslaParamsFor(s)).toEqual(resolveTeslaParams(HIGHLAND_LR));
  });

  it('uses notListedParams for a "not listed" Tesla', () => {
    const s = { ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED } };
    expect(teslaParamsFor(s)).toEqual(notListedParams(6.1, 1900, 'suv'));
  });

  it('prefers the catalogue record when both are set (teslaId is null whenever notListed is in use)', () => {
    const s = { ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR, notListed: { ...NOT_LISTED } };
    expect(teslaParamsFor(s)).toEqual(resolveTeslaParams(HIGHLAND_LR));
  });

  it('never throws on an unsanitised object', () => {
    const unknownId = { ...DEFAULT_SETTINGS, teslaId: 'model9-imaginary' };
    expect(teslaParamsFor(unknownId)).toBeNull();
    expect(teslaParamsFor({ ...unknownId, notListed: { ...NOT_LISTED } })).toEqual(notListedParams(6.1, 1900, 'suv'));
    const badNotListed = { ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED, zeroTo100S: 0 } };
    expect(() => teslaParamsFor(badNotListed)).not.toThrow();
    expect(teslaParamsFor(badNotListed)).toBeNull();
    const badBody = { ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED, body: 'van' } } as unknown as Settings;
    expect(teslaParamsFor(badBody)).toBeNull();
  });

  it('is null for an out-of-range "not listed" entry instead of an infinite traction force', () => {
    expect(teslaParamsFor({ ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED, massKg: 1e308 } })).toBeNull();
    expect(teslaParamsFor({ ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED, zeroTo100S: 1e-320 } })).toBeNull();
  });
});

describe('needsFirstRun', () => {
  it('is true until a Tesla is chosen and the notices are seen', () => {
    expect(needsFirstRun(DEFAULT_SETTINGS)).toBe(true);
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, noticesSeen: true })).toBe(true);
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR })).toBe(true);
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED } })).toBe(true);
  });

  it('is false with a catalogue or "not listed" Tesla and the notices seen', () => {
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, teslaId: HIGHLAND_LR, noticesSeen: true })).toBe(false);
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, notListed: { ...NOT_LISTED }, noticesSeen: true })).toBe(false);
  });

  it('treats an unknown teslaId (unsanitised) as no Tesla chosen', () => {
    expect(needsFirstRun({ ...DEFAULT_SETTINGS, teslaId: 'model9-imaginary', noticesSeen: true })).toBe(true);
  });

  it('treats an out-of-range "not listed" entry (unsanitised) as no Tesla chosen', () => {
    const huge = { ...DEFAULT_SETTINGS, noticesSeen: true, notListed: { zeroTo100S: 5, massKg: 1e308, body: 'sedan' } } as const;
    expect(needsFirstRun(huge)).toBe(true);
  });
});
