/**
 * src/lab/ui/schema.ts: the page's own validator for engine.schema.json `$defs.voicing` (Ajv compiles schemas
 * with `new Function`, which the CSP forbids, so the page cannot use it). Ajv is the oracle here: both accept
 * every shipped voicing and both reject each broken one, and the page reports the broken field's path.
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import type { EngineVoicing } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { validateSchema } from '../../src/lab/ui/schema';
import { VOICING_SCHEMA } from '../../src/lab/ui/voicing-fields';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const ajvVoicing = ajv.compile(engineSchema.$defs.voicing);

function clone(v: EngineVoicing): Record<string, unknown> {
  return structuredClone(v) as unknown as Record<string, unknown>;
}

const turbo = ENGINES.find((e) => e.spec.aspiration.type === 'turbo')?.voicing as EngineVoicing;

/** [what, mutation, the path the page must report]. */
const BROKEN: [string, (v: Record<string, unknown>) => void, string][] = [
  ['alpha at its exclusive minimum', (v) => ((v.pulse as Record<string, unknown>).alpha = 0), 'pulse.alpha'],
  ['widthDeg below 40', (v) => ((v.pulse as Record<string, unknown>).widthDeg = 30), 'pulse.widthDeg'],
  ['headersM with one entry', (v) => (v.headersM = [0.5]), 'headersM'],
  ['a header that is a string', (v) => ((v.headersM as unknown[])[0] = 'x'), 'headersM[0]'],
  ['a collector without banks', (v) => (((v.collectors as Record<string, unknown>[])[0] as Record<string, unknown>).banks = []), 'collectors[0].banks'],
  ['a fractional bank', (v) => (((v.collectors as Record<string, unknown>[])[0] as Record<string, unknown>).banks = [1.5]), 'collectors[0].banks[0]'],
  ['a turbine without lpHz', (v) => (v.turbine = { reflection: 0.5 }), 'turbine.lpHz'],
  ['a turbine that is a string', (v) => (v.turbine = 'yes'), 'turbine'],
  ['an unknown lift event', (v) => ((v.forcedInduction as Record<string, unknown>).lift = 'whoosh'), 'forcedInduction.lift'],
  ['five muffler sections', (v) => ((v.exhaust as Record<string, unknown>).mufflerSectionsM = [0.2, 0.2, 0.2, 0.2, 0.2]), 'exhaust.mufflerSectionsM'],
  ['an unknown property', (v) => (v.foo = 1), 'foo'],
  ['estimated as a string', (v) => (v.estimated = 'true'), 'estimated'],
  ['no cabin', (v) => delete v.cabin, 'cabin'],
  ['cabinGainDb above −10', (v) => ((v.forcedInduction as Record<string, unknown>).cabinGainDb = -5), 'forcedInduction.cabinGainDb'],
];

describe('validateSchema against $defs.voicing', () => {
  it('accepts every shipped voicing, as Ajv does', () => {
    for (const e of ENGINES) {
      expect(ajvVoicing(e.voicing), e.id).toBe(true);
      expect(validateSchema(VOICING_SCHEMA, e.voicing), e.id).toEqual([]);
    }
  });

  for (const [what, mutate, path] of BROKEN) {
    it(`rejects ${what} at ${path}, as Ajv does`, () => {
      const v = clone(turbo);
      mutate(v);
      expect(ajvVoicing(v)).toBe(false);
      const errors = validateSchema(VOICING_SCHEMA, v);
      expect(errors.map((e) => e.path)).toContain(path);
      for (const e of errors) expect(e.message.length).toBeGreaterThan(0);
    });
  }

  it('rejects numbers that are not finite (JSON cannot carry them, a draft can)', () => {
    const v = clone(turbo);
    v.launchRpm = Number.NaN;
    expect(validateSchema(VOICING_SCHEMA, v).map((e) => e.path)).toEqual(['launchRpm']);
  });

  it('refuses a schema keyword it does not implement instead of ignoring it', () => {
    expect(() => validateSchema({ type: 'string', pattern: '^a$' }, 'a')).toThrow(/pattern/);
  });
});
