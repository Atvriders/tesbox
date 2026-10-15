import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT, type EngineDef, type EngineVoicing, type TeslaRecord } from '../../src/contracts';
import {
  DEFAULT_SETTINGS,
  HP_CORNER_RANGE_HZ,
  NOT_LISTED_MASS_RANGE_KG,
  NOT_LISTED_ZERO_TO_100_RANGE_S,
  sanitizeSettings,
  type Settings,
} from '../../src/app/settings';
import { TESLAS } from '../../src/data/catalogue';
import { ENGINES, getEngine } from '../../src/data/engines';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import {
  BASS_SWEEP_HZ,
  BASS_SWEEP_LEVEL_DB,
  BASS_SWEEP_STEP_MS,
  ENGINE_SETS,
  carAnswersOf,
  carChoicePatch,
  carSummary,
  engineGroups,
  engineSpecLine,
  engineSpecParts,
  formatYears,
  garageSpecLine,
  generationsOf,
  isMcu1Era,
  parseNotListed,
  quickestMode,
  selectedAccelMode,
  subwooferGuess,
  teslaById,
  teslaModels,
  trimsOf,
  voicingBadge,
  yearSpan,
} from '../../src/ui/picker';
import { STR } from '../../src/ui/strings';

/** Valid settings: the defaults plus `over`, through the same validation the store applies. */
function settingsWith(over: Partial<Settings> = {}): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...over });
}

function record(id: string): TeslaRecord {
  const r = TESLAS.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no catalogue record ${id}`);
  return r;
}

const MODEL3_GENS = ['2017–2023 (original)', 'Highland (2023–)'];

describe('picker: catalogue navigation (Model → generation → trim)', () => {
  it('lists the six models in catalogue order', () => {
    expect(teslaModels()).toEqual(['Model S', 'Model X', 'Model 3', 'Model Y', 'Model Y L', 'Cybertruck']);
  });

  it('lists each generation of a model once, in catalogue order, with the model years its trims cover', () => {
    const gens = generationsOf('Model 3');
    expect(gens.map((g) => g.generation)).toEqual(MODEL3_GENS);
    expect(gens.map((g) => g.years)).toEqual([
      [2017, 2023],
      [2023, 2026],
    ]);
    expect(generationsOf('Model S').map((g) => g.generation)).toEqual([
      '2012–2016 (original, MCU1)',
      '2016–2018 facelift (MCU1)',
      '2018–2021 (MCU2)',
      '2021– (Palladium)',
    ]);
    expect(generationsOf('Model S')[0]?.years).toEqual([2012, 2016]);
    expect(generationsOf('Cybertruck').map((g) => g.generation)).toEqual(['2023– (first generation)']);
    expect(generationsOf('Model Y L')).toHaveLength(1);
  });

  it('lists the trims of one generation in catalogue order', () => {
    expect(trimsOf('Model 3', 'Highland (2023–)').map((r) => r.id)).toEqual([
      'model3-highland-rwd',
      'model3-highland-lr-rwd',
      'model3-highland-lr-awd',
      'model3-highland-performance',
      'model3-highland-standard',
    ]);
    expect(trimsOf('Model Y L', 'Model Y L (2025–)').map((r) => r.id)).toEqual(['modelyl-2025-awd']);
    expect(trimsOf('Model 3', 'no such generation')).toEqual([]);
    // A generation's trims are exactly the records the generation option carries.
    for (const g of generationsOf('Model X')) expect(trimsOf('Model X', g.generation)).toEqual(g.trims);
  });

  it('reaches every one of the 73 catalogue records through exactly one model → generation → trim path', () => {
    const reached = teslaModels().flatMap((m) => generationsOf(m).flatMap((g) => trimsOf(m, g.generation)));
    expect(reached).toHaveLength(73);
    expect(new Set(reached.map((r) => r.id)).size).toBe(73);
    expect(new Set(reached)).toEqual(new Set(TESLAS));
  });

  it('formats model years as a span, or one year', () => {
    expect(formatYears([2023, 2026])).toBe('2023–2026');
    expect(formatYears([2019, 2019])).toBe('2019');
    expect(yearSpan([record('models-2018-75d'), record('models-2018-long-range-plus')])).toEqual([2018, 2021]);
  });

  it('finds a record by id, or null', () => {
    expect(teslaById('model3-highland-lr-awd')?.trim).toBe('Long Range AWD / Premium AWD');
    expect(teslaById('nope')).toBeNull();
    expect(teslaById(null)).toBeNull();
  });
});

describe('picker: MCU1 detection', () => {
  it('flags exactly the MCU1-era configurations (Tegra MCU, not supported without an MCU2 retrofit)', () => {
    const mcu1 = TESLAS.filter(isMcu1Era).map((r) => r.id);
    expect(mcu1).toHaveLength(25);
    expect(mcu1).toContain('models-2012-85');
    expect(mcu1).toContain('models-2016-p100d');
    expect(mcu1).toContain('modelx-2015-p90d');
    for (const id of ['models-2018-75d', 'models-2021-plaid', 'model3-2017-lr-awd', 'cybertruck-awd']) {
      expect(isMcu1Era(record(id)), id).toBe(false);
    }
    for (const r of TESLAS) {
      expect(isMcu1Era(r), r.id).toBe(!r.supported);
      if (isMcu1Era(r)) expect(r.generation, r.id).toContain('MCU1');
    }
  });

  it('keeps each generation entirely MCU1-era or entirely not', () => {
    for (const m of teslaModels()) {
      for (const g of generationsOf(m)) {
        expect(new Set(g.trims.map(isMcu1Era)).size, `${m} ${g.generation}`).toBe(1);
      }
    }
  });
});

describe('picker: per-car answers', () => {
  it("guesses the subwoofer from the record's default", () => {
    expect(subwooferGuess(record('model3-highland-lr-awd'))).toBe('yes');
    expect(subwooferGuess(record('model3-highland-rwd'))).toBe('no');
  });

  it("names the quickest mode (the record's last) and the mode in effect", () => {
    expect(quickestMode(record('models-2018-p100d'))).toBe('Ludicrous+');
    expect(quickestMode(record('model3-highland-lr-awd'))).toBe('Standard');
    const r = record('model3-highland-lr-awd');
    expect(selectedAccelMode(settingsWith({ teslaId: r.id }), r)).toBe('Standard');
    expect(selectedAccelMode(settingsWith({ teslaId: r.id, accelMode: 'Chill' }), r)).toBe('Chill');
  });

  it('choosing another car resets the per-car answers to its best guesses', () => {
    const current = settingsWith({ teslaId: 'model3-highland-rwd', subwoofer: 'no', hpCornerHz: 55, accelMode: 'Chill' });
    expect(carChoicePatch(current, { teslaId: 'model3-highland-lr-awd' })).toEqual({
      teslaId: 'model3-highland-lr-awd',
      notListed: null,
      accelMode: null,
      mcu2Retrofit: null,
      subwoofer: 'yes',
      hpCornerHz: DEFAULT_OUTPUT.hpCornerHz,
    });
    // From nothing chosen (first run): the same reset.
    expect(carChoicePatch(settingsWith(), { teslaId: 'model3-highland-rwd' })).toMatchObject({
      teslaId: 'model3-highland-rwd',
      subwoofer: 'no',
      hpCornerHz: 40,
    });
  });

  it('choosing the same car again keeps its answers', () => {
    const current = settingsWith({ teslaId: 'model3-highland-rwd', subwoofer: 'yes', hpCornerHz: 55, accelMode: 'Chill' });
    expect(carChoicePatch(current, { teslaId: 'model3-highland-rwd' })).toEqual({ teslaId: 'model3-highland-rwd', notListed: null });
  });

  it('a "not listed" car starts at subwoofer not sure; editing its numbers keeps the answers', () => {
    const nl = { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } as const;
    const fromRecord = settingsWith({ teslaId: 'model3-highland-rwd', hpCornerHz: 55 });
    expect(carChoicePatch(fromRecord, { notListed: nl })).toEqual({
      teslaId: null,
      notListed: nl,
      accelMode: null,
      mcu2Retrofit: null,
      subwoofer: 'unsure',
      hpCornerHz: 40,
    });
    const fromNotListed = settingsWith({ notListed: { ...nl, massKg: 2000 }, subwoofer: 'no', hpCornerHz: 50 });
    expect(carChoicePatch(fromNotListed, { notListed: nl })).toEqual({ teslaId: null, notListed: nl });
  });

  it('names everything the picker can change, so a cancelled re-run can put it back', () => {
    const current = settingsWith({
      teslaId: 'model3-highland-lr-awd',
      subwoofer: 'no',
      hpCornerHz: 55,
      accelMode: 'Chill',
      volumeTrimDb: -6,
    });
    const answers = carAnswersOf(current);
    expect(answers).toEqual({
      teslaId: 'model3-highland-lr-awd',
      notListed: null,
      subwoofer: 'no',
      hpCornerHz: 55,
      accelMode: 'Chill',
      mcu2Retrofit: null,
    });
    // Every field a car choice changes is among them …
    const choices = [{ teslaId: 'model3-highland-rwd' }, { notListed: { zeroTo100S: 6, massKg: 2000, body: 'suv' } }] as const;
    for (const c of choices) {
      for (const key of Object.keys(carChoicePatch(current, c))) expect(Object.keys(answers), key).toContain(key);
    }
    // … and put back in one patch over another car's starting point, they validate to the settings they came from.
    const other = sanitizeSettings({ ...current, ...carChoicePatch(current, { teslaId: 'model3-highland-rwd' }) }, current);
    expect(other.accelMode).toBeNull();
    expect(sanitizeSettings({ ...other, ...answers }, other)).toEqual(current);
    // A copy: the "not listed" entry is not shared with the settings it came from.
    const nl = settingsWith({ notListed: { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } });
    expect(carAnswersOf(nl).notListed).toEqual(nl.notListed);
    expect(carAnswersOf(nl).notListed).not.toBe(nl.notListed);
  });

  it('parses the "not listed" form within the settings bounds', () => {
    expect(parseNotListed('6.1', '1900', 'suv')).toEqual({ zeroTo100S: 6.1, massKg: 1900, body: 'suv' });
    expect(parseNotListed(' 4,5 ', '2100', 'sedan')).toEqual({ zeroTo100S: 4.5, massKg: 2100, body: 'sedan' });
    expect(parseNotListed(String(NOT_LISTED_ZERO_TO_100_RANGE_S.min), String(NOT_LISTED_MASS_RANGE_KG.max), 'truck')).not.toBeNull();
    for (const [t, m] of [
      ['', '1900'],
      ['6.1', ''],
      ['abc', '1900'],
      ['1.4', '1900'],
      ['31', '1900'],
      ['6.1', '499'],
      ['6.1', '5001'],
      ['6.1', 'Infinity'],
      ['NaN', '1900'],
    ]) {
      expect(parseNotListed(t ?? '', m ?? '', 'sedan'), `${t} / ${m}`).toBeNull();
    }
  });

  it('summarises the chosen car', () => {
    expect(carSummary(settingsWith({ teslaId: 'model3-highland-lr-awd' }))).toBe(
      'Model 3 · Highland (2023–) · Long Range AWD / Premium AWD',
    );
    expect(carSummary(settingsWith({ notListed: { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } }))).toBe(
      'Not listed · 0–100 km/h in 6.1 s · 1900 kg · SUV',
    );
    expect(carSummary(settingsWith())).toBeNull();
  });
});

describe('picker: bass sweep (spec §9.3)', () => {
  it('steps through 30/35/40/45/50/60 Hz, 1.5 s each, at −18 dB', () => {
    expect(BASS_SWEEP_HZ).toEqual([30, 35, 40, 45, 50, 60]);
    expect(BASS_SWEEP_STEP_MS).toBe(1500);
    expect(BASS_SWEEP_LEVEL_DB).toBe(-18);
  });

  it('offers only corners the settings accept, including the 40 Hz default', () => {
    for (const hz of BASS_SWEEP_HZ) {
      expect(hz).toBeGreaterThanOrEqual(HP_CORNER_RANGE_HZ.min);
      expect(hz).toBeLessThanOrEqual(HP_CORNER_RANGE_HZ.max);
      expect(sanitizeSettings({ ...DEFAULT_SETTINGS, hpCornerHz: hz }).hpCornerHz).toBe(hz);
    }
    expect(BASS_SWEEP_HZ).toContain(DEFAULT_OUTPUT.hpCornerHz);
  });
});

describe('picker: garage', () => {
  it('groups the 15 engines Euro / JDM / American / Exotic, keeping the garage order inside each group', () => {
    expect(ENGINE_SETS).toEqual(['euro', 'jdm', 'american', 'exotic']);
    const groups = engineGroups();
    expect(groups.map((g) => g.set)).toEqual(['euro', 'jdm', 'american', 'exotic']);
    expect(groups.map((g) => g.engines.length)).toEqual([4, 4, 3, 4]);
    expect(groups.flatMap((g) => g.engines)).toEqual(ENGINES);
    for (const g of groups) for (const e of g.engines) expect(e.set).toBe(g.set);
  });

  it('describes an engine by layout, displacement, aspiration and redline', () => {
    const line = (id: string): string => engineSpecParts(getEngine(id)).join(' · ');
    expect(line('i5-turbo-25')).toBe('Inline-5 · 2.5 L · Turbo · 7,000 rpm redline');
    expect(line('flat6-na-40')).toBe('Flat-6 · 4.0 L · Naturally aspirated · 9,000 rpm redline');
    expect(line('rotary-twin-13')).toBe('2-rotor rotary · 1.3 L · Sequential twin-turbo · 8,000 rpm redline');
    expect(line('v6-twinturbo-38')).toBe('60° V6 · 3.8 L · Twin-turbo · 7,100 rpm redline');
    expect(line('v8-flatplane-45')).toBe('90° flat-plane V8 · 4.5 L · Naturally aspirated · 9,000 rpm redline');
    expect(line('v8-sc-62')).toBe('90° cross-plane V8 · 6.2 L · Supercharged · 6,200 rpm redline');
    expect(line('v10-na-48')).toBe('72° V10 · 4.8 L · Naturally aspirated · 9,000 rpm redline');
  });

  it('keeps each fact of the spec line together: a card wraps it only between facts', () => {
    for (const e of ENGINES) {
      const parts = engineSpecParts(e);
      const line = engineSpecLine(e);
      expect(line.replace(/\u00a0/g, ' ').replace(/\u2011/g, '-'), e.id).toBe(parts.join(' · '));
      expect(line.split(' '), e.id).toHaveLength(parts.length); // the only breakable spaces follow a "·"
      expect(line, e.id).not.toContain('-'); // a hyphen is a break point too: U+2011 (non-breaking) instead
      expect(line, e.id).toBe(parts.map((p) => p.replace(/ /g, '\u00a0').replace(/-/g, '\u2011')).join('\u00a0· '));
    }
    // The facts with hyphens ("Inline-5", "Flat-6", "2-rotor", "cross-plane", "twin-turbo") are covered.
    const hyphenated = ENGINES.filter((e) => engineSpecParts(e).some((p) => p.includes('-'))).map((e) => e.id);
    expect(hyphenated).toEqual(expect.arrayContaining(['i5-turbo-25', 'flat6-na-40', 'rotary-twin-13', 'v8-sc-62', 'v6-twinturbo-38']));
    expect(engineSpecLine(getEngine('rotary-twin-13'))).toBe(
      '2\u2011rotor\u00a0rotary\u00a0· 1.3\u00a0L\u00a0· Sequential\u00a0twin\u2011turbo\u00a0· 8,000\u00a0rpm\u00a0redline',
    );
  });

  it("agrees with every engine's title on the displacement", () => {
    for (const e of ENGINES) {
      const litres = e.name.split(' ')[0];
      const line = engineSpecParts(e).join(' · ');
      expect(line, e.id).toContain(`· ${litres} L ·`);
      expect(line, e.id).toMatch(/^\S.* · \d\.\d L · .+ · \d,\d{3} rpm redline$/);
    }
  });

  it('shows the voicing status (phase-4 contract T4): "Beta voicing" until signed off, "Tuned" while a tuned voicing awaits it', () => {
    expect(STR.garage.betaVoicing).toBe('Beta voicing');
    expect(STR.garage.tuned).toBe('Tuned');
    const base = getEngine('v8-na-50');
    const d = defaultVoicing(base.spec);
    const def = (voicing: EngineVoicing): EngineDef => ({ ...base, voicing });
    const tuned: EngineVoicing = { ...d, cabin: { ...d.cabin, lowpassHz: d.cabin.lowpassHz + 100 } };
    // Default voicing, estimated: the badge, the plain spec line.
    expect(voicingBadge(def(d))).toBe(STR.garage.betaVoicing);
    expect(garageSpecLine(def(d))).toBe(engineSpecLine(base));
    // Tuned against references (tools/tune.ts keeps estimated true): the badge and "Tuned", after a no-break "·".
    expect(voicingBadge(def(tuned))).toBe(STR.garage.betaVoicing);
    expect(garageSpecLine(def(tuned))).toBe(`${engineSpecLine(base)}\u00a0· ${STR.garage.tuned}`);
    // Signed off by the user (estimated false): neither.
    expect(voicingBadge(def({ ...tuned, estimated: false }))).toBeNull();
    expect(garageSpecLine(def({ ...tuned, estimated: false }))).toBe(engineSpecLine(base));
  });
});
