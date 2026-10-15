/**
 * src/lab/ui/voicing-fields.ts (phase-2c contract L3 "Voicing panel"): the controls generated from
 * engine.schema.json `$defs.voicing` — number ranges (schema range; no schema maximum → the Phase 2b T6 range
 * when listed, else [min, max(1, 4 × the engine's value)]), one control per array element, nullable objects
 * editable only when present, booleans as checkboxes, `estimated` read-only — for all 15 engines.
 */
import { describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import {
  getIn,
  setIn,
  voicingFields,
  type FieldGroup,
  type NumberField,
  type VoicingField,
} from '../../src/lab/ui/voicing-fields';

function all(groups: readonly FieldGroup[]): VoicingField[] {
  return groups.flatMap((g) => g.fields);
}

function byKey(groups: readonly FieldGroup[], key: string): VoicingField {
  const f = all(groups).find((x) => x.key === key);
  if (f === undefined) throw new Error(`no field ${key}`);
  return f;
}

function num(groups: readonly FieldGroup[], key: string): NumberField {
  const f = byKey(groups, key);
  if (f.kind !== 'number') throw new Error(`${key} is a ${f.kind} field`);
  return f;
}

/** Schema ranges of the scalar voicing numbers (engine.schema.json), and the T6 ranges of alpha / beta (no schema maximum). */
const SCALAR_RANGES: Record<string, [number, number]> = {
  'pulse.widthDeg': [40, 300],
  'pulse.alpha': [3, 20],
  'pulse.beta': [1, 10],
  'pulse.evoOffsetDeg': [0, 360],
  'pulse.cycleAsymmetry': [0, 1],
  'exhaust.midPipeM': [0.1, 5],
  'exhaust.mufflerAction': [0, 1],
  'exhaust.tailpipeM': [0.05, 3],
  'exhaust.valve.openGainDb': [0, 12],
  'intake.runnerM': [0.05, 1],
  'intake.helmholtzHz': [20, 1000],
  'intake.gain': [0, 1],
  'mechanical.blockGain': [0, 1],
  'mechanical.valvetrainGain': [0, 1],
  'overrun.crackleRate': [0, 10],
  'overrun.fuelCutResumeRpm': [500, 6000],
  'cabin.lowpassHz': [200, 2000],
  'cabin.leakDb': [-60, -10],
  launchRpm: [1000, 10000],
};

describe('voicingFields: all 15 engines', () => {
  it('covers the starter garage', () => {
    expect(ENGINES).toHaveLength(15);
  });

  for (const engine of ENGINES) {
    describe(engine.id, () => {
      const groups = voicingFields(engine.voicing);
      const v = engine.voicing;

      it('groups the voicing in schema order, the scalars last', () => {
        expect(groups.map((g) => g.key)).toEqual([
          'pulse',
          'headersM',
          'collectors',
          'turbine',
          'exhaust',
          'intake',
          'forcedInduction',
          'mechanical',
          'overrun',
          'cabin',
          'general',
        ]);
      });

      it('gives every scalar number its schema range (T6 for alpha and beta) and the engine value', () => {
        for (const [key, range] of Object.entries(SCALAR_RANGES)) {
          const f = num(groups, key);
          expect([f.min, f.max], key).toEqual(range);
        }
        expect(num(groups, 'pulse.alpha').value).toBe(v.pulse.alpha);
        expect(num(groups, 'exhaust.valve.openGainDb').value).toBe(v.exhaust.valve.openGainDb);
        expect(num(groups, 'launchRpm').value).toBe(v.launchRpm);
      });

      it('keeps every number inside its range', () => {
        for (const f of all(groups)) {
          if (f.kind !== 'number') continue;
          expect(f.min, f.key).toBeLessThan(f.max);
          expect(f.value, f.key).toBeGreaterThanOrEqual(f.min);
          expect(f.value, f.key).toBeLessThanOrEqual(f.max);
          expect(f.step, f.key).toBeGreaterThan(0);
        }
      });

      it('has one header control per combustion entry, one per muffler section, banks + length per collector', () => {
        const header = groups.find((g) => g.key === 'headersM')?.fields ?? [];
        expect(header).toHaveLength(engine.spec.combustion.length);
        expect(header.map((f) => (f as NumberField).value)).toEqual(v.headersM);
        for (const f of header) expect([(f as NumberField).min, (f as NumberField).max]).toEqual([0.1, 3]);
        const sections = all(groups).filter((f) => f.key.startsWith('exhaust.mufflerSectionsM['));
        expect(sections.map((f) => (f as NumberField).value)).toEqual(v.exhaust.mufflerSectionsM);
        const collectors = groups.find((g) => g.key === 'collectors')?.fields ?? [];
        expect(collectors).toHaveLength(v.collectors.reduce((n, c) => n + c.banks.length + 1, 0));
        const bank = num(groups, 'collectors[0].banks[0]');
        expect([bank.min, bank.max, bank.integer, bank.step]).toEqual([0, 3, true, 1]);
        expect([num(groups, 'collectors[0].lengthM').min, num(groups, 'collectors[0].lengthM').max]).toEqual([0.05, 2]);
      });

      it('makes turbine and forcedInduction editable only when present', () => {
        const turbine = groups.find((g) => g.key === 'turbine')?.fields ?? [];
        if (engine.spec.aspiration.type === 'turbo') {
          expect(turbine.map((f) => [f.key, f.kind])).toEqual([
            ['turbine.reflection', 'number'],
            ['turbine.lpHz', 'number'],
          ]);
          expect([num(groups, 'turbine.lpHz').min, num(groups, 'turbine.lpHz').max]).toEqual([200, 8000]);
        } else {
          expect(turbine.map((f) => [f.key, f.kind])).toEqual([['turbine', 'absent']]);
        }
        const fi = groups.find((g) => g.key === 'forcedInduction')?.fields ?? [];
        if (engine.spec.aspiration.type === 'na') {
          expect(fi.map((f) => [f.key, f.kind])).toEqual([['forcedInduction', 'absent']]);
        } else {
          expect(fi.map((f) => [f.key, f.kind])).toEqual([
            ['forcedInduction.spoolTimeS', 'number'],
            ['forcedInduction.maxShaftKrpm', 'number'],
            ['forcedInduction.lift', 'enum'],
            ['forcedInduction.cabinGainDb', 'number'],
            ['forcedInduction.whistleDb', 'number'],
            ['forcedInduction.outsideGainDb', 'number'],
          ]);
          const lift = byKey(groups, 'forcedInduction.lift');
          expect(lift.kind === 'enum' ? lift.options : null).toEqual(['bov', 'flutter']);
          const gain = num(groups, 'forcedInduction.cabinGainDb');
          expect([gain.min, gain.max]).toEqual([-20, -10]);
          // B18 levels: the schema ranges, dB units
          for (const key of ['forcedInduction.whistleDb', 'forcedInduction.outsideGainDb']) {
            const f = num(groups, key);
            expect([f.min, f.max, f.unit], key).toEqual([-60, 0, 'dB']);
          }
        }
      });

      it('shows booleans as checkboxes; estimated is not editable', () => {
        const fitted = byKey(groups, 'exhaust.valve.fitted');
        const estimated = byKey(groups, 'estimated');
        expect(fitted).toMatchObject({ kind: 'boolean', editable: true, value: v.exhaust.valve.fitted });
        expect(estimated).toMatchObject({ kind: 'boolean', editable: false, value: v.estimated });
      });
    });
  }
});

describe('voicingFields: ranges', () => {
  const base = ENGINES[0] as EngineDef;

  it('labels each control relative to its group, with a unit from the field name', () => {
    const groups = voicingFields(base.voicing);
    const cases: [string, string, string][] = [
      ['pulse.widthDeg', 'widthDeg', '°'],
      ['headersM[0]', '[0]', 'm'],
      ['collectors[0].lengthM', '[0].lengthM', 'm'],
      ['collectors[0].banks[0]', '[0].banks[0]', ''],
      ['exhaust.valve.openGainDb', 'valve.openGainDb', 'dB'],
      ['intake.helmholtzHz', 'helmholtzHz', 'Hz'],
      ['overrun.fuelCutResumeRpm', 'fuelCutResumeRpm', 'rpm'],
      ['launchRpm', 'launchRpm', 'rpm'],
    ];
    for (const [key, label, unit] of cases) expect([byKey(groups, key).label, (byKey(groups, key) as NumberField).unit], key).toEqual([label, unit]);
  });

  it('steps a slider in about a thousandth of its range (whole numbers for integers)', () => {
    const groups = voicingFields(base.voicing);
    expect(num(groups, 'pulse.alpha').step).toBe(0.01); // 17 / 1000 → 0.01
    expect(num(groups, 'pulse.widthDeg').step).toBe(0.1); // 260 / 1000 → 0.1
    expect(num(groups, 'intake.gain').step).toBe(0.001);
    expect(num(groups, 'launchRpm').step).toBe(1); // 9000 / 1000 → 1
  });

  it('widens a range that would not hold the engine value', () => {
    const voicing: EngineVoicing = { ...base.voicing, pulse: { ...base.voicing.pulse, alpha: 25, beta: 0.5 } };
    const groups = voicingFields(voicing);
    expect([num(groups, 'pulse.alpha').min, num(groups, 'pulse.alpha').max]).toEqual([3, 25]);
    expect([num(groups, 'pulse.beta').min, num(groups, 'pulse.beta').max]).toEqual([0.5, 10]);
  });

  it('no schema maximum and not in T6: [min, max(1, 4 × the engine value)], from the engine (base) voicing', () => {
    const schema = {
      type: 'object',
      properties: {
        foo: { type: 'number', minimum: 0.5 },
        bar: { type: 'number', exclusiveMinimum: 0 },
      },
    };
    const groups = voicingFields({ foo: 6, bar: 0.1 } as unknown as EngineVoicing, schema, { foo: 2, bar: 0.1 } as unknown as EngineVoicing);
    const foo = num(groups, 'foo');
    expect([foo.min, foo.max, foo.value]).toEqual([0.5, 8, 6]); // range from the base value 2; value from the draft
    expect([num(groups, 'bar').min, num(groups, 'bar').max]).toEqual([0, 1]); // max(1, 0.4) = 1
  });

  it('no schema maximum but listed in T6: the T6 range', () => {
    const schema = {
      type: 'object',
      properties: { exhaust: { type: 'object', properties: { midPipeM: { type: 'number', minimum: 0.1 } } } },
    };
    const groups = voicingFields({ exhaust: { midPipeM: 1.4 } } as unknown as EngineVoicing, schema);
    expect([num(groups, 'exhaust.midPipeM').min, num(groups, 'exhaust.midPipeM').max]).toEqual([0.6, 3]);
  });

  it('follows the draft structure: a turbine object added to an NA engine becomes editable', () => {
    const na = ENGINES.find((e) => e.spec.aspiration.type === 'na') as EngineDef;
    const draft = { ...na.voicing, turbine: { reflection: 0.3, lpHz: 900 } };
    const groups = voicingFields(draft, undefined, na.voicing);
    expect(num(groups, 'turbine.lpHz')).toMatchObject({ value: 900, min: 200, max: 8000 });
  });
});

describe('getIn / setIn', () => {
  const v = (ENGINES[0] as EngineDef).voicing;

  it('reads a path through objects and arrays', () => {
    expect(getIn(v, ['pulse', 'alpha'])).toBe(v.pulse.alpha);
    expect(getIn(v, ['headersM', 1])).toBe(v.headersM[1]);
    expect(getIn(v, ['collectors', 0, 'banks', 0])).toBe(v.collectors[0]?.banks[0]);
    expect(getIn(v, ['turbine', 'nope', 3])).toBeUndefined();
  });

  it('writes a copy along the path and shares everything else', () => {
    const next = setIn(v, ['collectors', 0, 'lengthM'], 0.42);
    expect(next.collectors[0]?.lengthM).toBe(0.42);
    expect(v.collectors[0]?.lengthM).not.toBe(0.42);
    expect(Array.isArray(next.collectors)).toBe(true);
    expect(next.collectors[0]?.banks).toBe(v.collectors[0]?.banks);
    expect(next.pulse).toBe(v.pulse);
    const h = setIn(v, ['headersM', 0], 0.9);
    expect(h.headersM).toEqual([0.9, ...v.headersM.slice(1)]);
    expect(v.headersM[0]).not.toBe(0.9);
  });
});
