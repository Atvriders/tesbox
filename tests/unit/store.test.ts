import type { ReadonlySignal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Settings } from '../../src/app/settings';
import { S, STATE_LEN } from '../../src/contracts';

/** Minimal in-memory Storage with a quota-failure switch. */
class FakeStorage {
  readonly map = new Map<string, string>();
  throwOnSet = false;
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
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
const HIGHLAND_LR = 'model3-highland-lr-awd'; // accelModes Chill | Standard
const NOT_LISTED = { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } as const;

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let fake: FakeStorage;
const disposers: (() => void)[] = [];

beforeEach(() => {
  fake = new FakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fake });
});

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

/**
 * The store loads settings when it is first imported, so each test seeds storage (a raw string is
 * stored as-is, anything else as JSON) and imports a fresh module graph. Every module the
 * assertions compare against comes from that same graph.
 */
async function freshStore(seed?: unknown) {
  if (seed !== undefined) fake.map.set(STORED_KEY, typeof seed === 'string' ? seed : JSON.stringify(seed));
  vi.resetModules();
  const store = await import('../../src/app/store');
  const settingsModule = await import('../../src/app/settings');
  const catalogue = await import('../../src/data/catalogue');
  const engines = await import('../../src/data/engines');
  const signals = await import('@preact/signals');
  /** Runs `read` in an effect and records every value it sees (the first run included). */
  function track<T>(read: () => T): T[] {
    const seen: T[] = [];
    disposers.push(signals.effect(() => void seen.push(read())));
    return seen;
  }
  return { ...store, settingsModule, catalogue, engines, track };
}

describe('boot', () => {
  it('starts from defaults on the first-run screen when nothing is stored, without writing storage', async () => {
    const { settings, screen, settingsModule } = await freshStore();
    expect(settings.value).toEqual(settingsModule.DEFAULT_SETTINGS);
    expect(settings.value).not.toBe(settingsModule.DEFAULT_SETTINGS);
    expect(screen.value).toBe('first-run');
    expect(fake.map.has(STORED_KEY)).toBe(false);
  });

  it('restores persisted settings and opens the garage once a Tesla is chosen and the notices are seen', async () => {
    const seed = { teslaId: HIGHLAND_LR, accelMode: 'Chill', noticesSeen: true, units: 'kmh', engineId: 'v8-na-50' };
    const { settings, screen, settingsModule } = await freshStore(seed);
    expect(settings.value).toEqual(settingsModule.sanitizeSettings(seed));
    expect(settings.value).toMatchObject(seed);
    expect(screen.value).toBe('garage');
  });

  it('stays on first-run until the notices are seen', async () => {
    const { screen } = await freshStore({ teslaId: HIGHLAND_LR, noticesSeen: false });
    expect(screen.value).toBe('first-run');
  });

  it('counts a "not listed" Tesla as chosen', async () => {
    const { screen } = await freshStore({ notListed: NOT_LISTED, noticesSeen: true });
    expect(screen.value).toBe('garage');
  });

  it('boots with defaults from corrupt storage (acceptance 3)', async () => {
    const { settings, screen, settingsModule } = await freshStore('{"teslaId": "model3-highland-lr-awd", ');
    expect(settings.value).toEqual(settingsModule.DEFAULT_SETTINGS);
    expect(screen.value).toBe('first-run');
  });

  it('boots with defaults when site data is blocked', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const { settings, settingsModule, updateSettings } = await freshStore();
    expect(settings.value).toEqual(settingsModule.DEFAULT_SETTINGS);
    expect(updateSettings({ units: 'kmh' })).toBe(false);
    expect(settings.value.units).toBe('kmh');
  });

  it('initialises the live signals', async () => {
    const { snapshot, audio, gps, toast } = await freshStore({ outputRoute: 'direct' });
    expect(snapshot.value).toBeInstanceOf(Float64Array);
    expect(snapshot.value).toHaveLength(STATE_LEN);
    expect(Number.isNaN(snapshot.value[S.busyFrac])).toBe(true); // contract: NaN if unknown
    expect([...snapshot.value].filter((_, i) => i !== S.busyFrac).every((x) => x === 0)).toBe(true);
    expect(audio.value).toEqual({ state: 'off', route: 'direct', tier: null });
    expect(gps.value).toEqual({ status: 'off', parked: false, fixAgeS: null });
    expect(toast.value).toBeNull();
  });

  it('reports the default output route before audio starts', async () => {
    const { audio } = await freshStore();
    expect(audio.value.route).toBe('direct-anchor');
  });
});

describe('updateSettings', () => {
  it('merges a patch, persists the result and returns true', async () => {
    const { settings, updateSettings, settingsModule } = await freshStore();
    expect(updateSettings({ units: 'kmh', volumeTrimDb: -3 })).toBe(true);
    expect(settings.value).toEqual({ ...settingsModule.DEFAULT_SETTINGS, units: 'kmh', volumeTrimDb: -3 });
    expect(JSON.parse(fake.map.get(STORED_KEY) ?? 'null')).toEqual(settings.value);
    expect(settingsModule.loadSettings()).toEqual(settings.value);
  });

  it('validates each patch field, keeping the current value of an invalid one (never the default)', async () => {
    const { settings, updateSettings, engine } = await freshStore({ engineId: 'v8-na-50', hpCornerHz: 45 });
    updateSettings({ engineId: 'v9-imaginary', hpCornerHz: 99 });
    expect(settings.value.engineId).toBe('v8-na-50');
    expect(settings.value.hpCornerHz).toBe(45);
    expect(engine.value.id).toBe('v8-na-50');
  });

  it('a volume step past the −24 dB floor or +6 dB ceiling stays there: no jump to 0 dB (spec §13)', async () => {
    const { settings, updateSettings, settingsModule } = await freshStore({ volumeTrimDb: -24 });
    expect(updateSettings({ volumeTrimDb: -25 })).toBe(true);
    expect(settings.value.volumeTrimDb).toBe(-24);
    expect(settingsModule.loadSettings().volumeTrimDb).toBe(-24);
    updateSettings({ volumeTrimDb: 6 });
    updateSettings({ volumeTrimDb: 7 });
    expect(settings.value.volumeTrimDb).toBe(6);
  });

  it.each([
    ['gpsLatencyS', 1.8, 2.6],
    ['gpsLatencyS', 1.8, -0.1],
    ['hpCornerHz', 55, 61],
    ['hpCornerHz', 55, Number.NaN],
    ['volumeTrimDb', -9, Number.POSITIVE_INFINITY],
  ] as const)('an out-of-range %s (%s → %s) keeps the current value', async (field, current, bad) => {
    const { settings, updateSettings, settingsModule } = await freshStore({ [field]: current });
    expect(settings.value[field]).toBe(current);
    updateSettings({ [field]: bad });
    expect(settings.value[field]).toBe(current);
    expect(settingsModule.loadSettings()[field]).toBe(current);
  });

  it('ignores explicit-undefined patch fields (Partial<Settings> allows them)', async () => {
    const seed = { engineId: 'v8-na-50', units: 'kmh', teslaId: HIGHLAND_LR, accelMode: 'Chill', engineWarmAt: 1_760_000_000_000 };
    const { settings, updateSettings, track } = await freshStore(seed);
    const before = settings.value;
    const seen = track(() => settings.value);
    const patch = { engineId: undefined, units: undefined, teslaId: undefined, accelMode: undefined, engineWarmAt: undefined };
    expect(updateSettings({ ...patch, wheelShift: undefined, notListed: undefined })).toBe(true);
    expect(settings.value).toBe(before);
    expect(settings.value).toMatchObject(seed);
    expect(seen).toHaveLength(1); // nothing changed, so nothing was notified
  });

  it('keeps the current Tesla and mode for an unknown teslaId or a mode the Tesla lacks', async () => {
    const { settings, updateSettings, teslaParams, catalogue } = await freshStore({ teslaId: HIGHLAND_LR, accelMode: 'Chill' });
    updateSettings({ teslaId: 'model9-imaginary' });
    expect(settings.value).toMatchObject({ teslaId: HIGHLAND_LR, accelMode: 'Chill' });
    updateSettings({ accelMode: 'Plaid' });
    expect(settings.value.accelMode).toBe('Chill');
    expect(teslaParams.value).toEqual(catalogue.resolveTeslaParams(HIGHLAND_LR, 'Chill'));
  });

  it('still clears the nullable fields with an explicit null', async () => {
    const seed = { teslaId: HIGHLAND_LR, accelMode: 'Chill', mcu2Retrofit: true, engineWarmAt: 1_760_000_000_000 };
    const { settings, updateSettings } = await freshStore(seed);
    updateSettings({ accelMode: null, mcu2Retrofit: null, engineWarmAt: null });
    expect(settings.value).toMatchObject({ teslaId: HIGHLAND_LR, accelMode: null, mcu2Retrofit: null, engineWarmAt: null });
    updateSettings({ teslaId: null, notListed: { ...NOT_LISTED } });
    expect(settings.value).toMatchObject({ teslaId: null, notListed: NOT_LISTED });
    updateSettings({ notListed: null });
    expect(settings.value.notListed).toBeNull();
  });

  it('drops an acceleration mode the newly selected Tesla does not have', async () => {
    vi.resetModules();
    const { TESLAS } = await import('../../src/data/catalogue');
    const plaid = TESLAS.find((r) => r.accelModes.some((m) => m.name === 'Plaid'));
    if (plaid === undefined) throw new Error('catalogue has no Plaid-mode record');
    const { settings, updateSettings, teslaParams } = await freshStore({ teslaId: plaid.id, accelMode: 'Plaid' });
    expect(settings.value.accelMode).toBe('Plaid');
    updateSettings({ teslaId: HIGHLAND_LR });
    expect(settings.value.accelMode).toBeNull();
    expect(teslaParams.value?.modeFactor).toBe(1); // quickest Highland LR mode
  });

  it('keeps the change in memory when persisting fails', async () => {
    const { settings, updateSettings } = await freshStore();
    fake.throwOnSet = true;
    expect(updateSettings({ units: 'kmh' })).toBe(false);
    expect(settings.value.units).toBe('kmh');
    expect(fake.map.has(STORED_KEY)).toBe(false);
  });

  it('does not notify subscribers when nothing changes', async () => {
    const { settings, updateSettings, track } = await freshStore({ units: 'kmh' });
    const seen = track(() => settings.value);
    expect(updateSettings({ units: 'kmh' })).toBe(true);
    expect(updateSettings({})).toBe(true);
    expect(seen).toHaveLength(1);
    updateSettings({ units: 'mph' });
    expect(seen).toHaveLength(2);
  });
});

describe('settings signal', () => {
  it('is read-only outside the store: only updateSettings writes it (validated, then persisted)', async () => {
    const { settings, updateSettings } = await freshStore();
    // Compile-time (npm run typecheck): `settings.value = …` would skip validation and persistence.
    expectTypeOf(settings).toEqualTypeOf<ReadonlySignal<Settings>>();
    expect(updateSettings({ units: 'kmh' })).toBe(true);
    expect(settings.value.units).toBe('kmh');
    expect(JSON.parse(fake.map.get(STORED_KEY) ?? 'null')).toEqual(settings.value);
  });
});

describe('go', () => {
  it('switches the screen', async () => {
    const { screen, go } = await freshStore();
    for (const s of ['garage', 'drive', 'settings', 'diagnostics', 'first-run'] as const) {
      go(s);
      expect(screen.value).toBe(s);
    }
  });
});

describe('derived signals', () => {
  it('engine follows engineId and is the catalogue definition', async () => {
    const { engine, updateSettings, engines } = await freshStore();
    expect(engine.value).toBe(engines.getEngine('i5-turbo-25'));
    updateSettings({ engineId: 'v8-na-50' });
    expect(engine.value).toBe(engines.getEngine('v8-na-50'));
  });

  it('engine does not notify on unrelated changes', async () => {
    const { engine, updateSettings, track } = await freshStore();
    const seen = track(() => engine.value);
    updateSettings({ volumeTrimDb: -6, units: 'kmh' });
    expect(seen).toHaveLength(1);
    updateSettings({ engineId: 'flat6-na-40' });
    expect(seen.map((e) => e.id)).toEqual(['i5-turbo-25', 'flat6-na-40']);
  });

  it('tesla is the selected catalogue record, or null', async () => {
    const { tesla, updateSettings, catalogue } = await freshStore();
    expect(tesla.value).toBeNull();
    updateSettings({ teslaId: HIGHLAND_LR });
    expect(tesla.value).toBe(catalogue.TESLAS.find((r) => r.id === HIGHLAND_LR));
    updateSettings({ teslaId: null, notListed: { ...NOT_LISTED } });
    expect(tesla.value).toBeNull();
  });

  it('teslaParams follows the selection and the acceleration mode', async () => {
    const { teslaParams, updateSettings, catalogue } = await freshStore();
    expect(teslaParams.value).toBeNull();
    updateSettings({ teslaId: HIGHLAND_LR });
    expect(teslaParams.value).toEqual(catalogue.resolveTeslaParams(HIGHLAND_LR));
    updateSettings({ accelMode: 'Chill' });
    expect(teslaParams.value).toEqual(catalogue.resolveTeslaParams(HIGHLAND_LR, 'Chill'));
    updateSettings({ teslaId: null, accelMode: null, notListed: { ...NOT_LISTED } });
    expect(teslaParams.value).toEqual(catalogue.notListedParams(6.1, 1900, 'suv'));
  });

  it('teslaParams keeps its identity across unrelated changes (no needless re-send to the worklet)', async () => {
    const { teslaParams, updateSettings, track } = await freshStore({ teslaId: HIGHLAND_LR });
    const seen = track(() => teslaParams.value);
    updateSettings({ volumeTrimDb: -6 });
    updateSettings({ units: 'kmh', engineId: 'v8-na-50', subwoofer: 'no' });
    expect(seen).toHaveLength(1);
    updateSettings({ accelMode: 'Chill' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.modeFactor).toBe(0.5);
    updateSettings({ notListed: { ...NOT_LISTED } }); // ignored while a catalogue record is selected
    expect(seen).toHaveLength(2);
  });

  it.each([
    // [status, gps.parked (real-GPS estimate), derived parked]
    ['off', false, true], // no geolocation (desktop) → unlocked
    ['denied', false, true], // permission denied: still "without geolocation"
    ['waiting', false, false],
    ['ok', false, false],
    ['ok', true, true],
    ['unavailable', false, false], // dropout (tunnel): stays locked
    ['unavailable', true, true],
  ] as const)('parked: gps status %s with parked=%s → %s', async (status, gpsParked, expected) => {
    const { gps, parked } = await freshStore();
    gps.value = { status, parked: gpsParked, fixAgeS: status === 'ok' ? 0.4 : null };
    expect(parked.value).toBe(expected);
  });

  it('parked is true at boot (GPS not running yet) and follows the GPS estimate once running', async () => {
    const { gps, parked, track } = await freshStore();
    const seen = track(() => parked.value);
    gps.value = { status: 'ok', parked: false, fixAgeS: 0.5 };
    gps.value = { status: 'ok', parked: true, fixAgeS: 0.5 };
    expect(seen).toEqual([true, false, true]);
  });
});
