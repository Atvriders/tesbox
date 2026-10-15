/**
 * src/lab/ui/voicing-io.ts (phase-2c contract L3 "Export" / "Import", L4): `<engineId>.voicing.json` =
 * `{ engineId, voicing }` — schema-validated, `estimated: true` always — round-trips through import, which
 * validates (shape, known engine, schema, assertEngineFits) before anything is applied; and the in-page check
 * that flags a voicing the DSP would refuse.
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import engineSchema from '../../src/data/schema/engine.schema.json';
import { exportVoicing, importVoicing, voicingProblems } from '../../src/lab/ui/voicing-io';

const FS = 48000;
const I5 = getEngine('i5-turbo-25');
const V8 = getEngine('v8-na-50');
const validVoicing = new Ajv2020({ allErrors: true, strict: true }).compile(engineSchema.$defs.voicing);

function exported(engineId: string, voicing: EngineVoicing): string {
  const r = exportVoicing(engineId, voicing);
  if (!r.ok) throw new Error(`export failed: ${r.problems.map((p) => p.message).join('; ')}`);
  return r.text;
}

describe('exportVoicing', () => {
  it('writes <engineId>.voicing.json = { engineId, voicing } that Ajv validates, estimated: true', () => {
    const r = exportVoicing(I5.id, { ...I5.voicing, estimated: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fileName).toBe('i5-turbo-25.voicing.json');
    const parsed = JSON.parse(r.text) as { engineId: string; voicing: EngineVoicing };
    expect(Object.keys(parsed)).toEqual(['engineId', 'voicing']);
    expect(parsed.engineId).toBe('i5-turbo-25');
    expect(parsed.voicing).toEqual({ ...I5.voicing, estimated: true });
    expect(validVoicing(parsed.voicing)).toBe(true);
  });

  it('does not touch the voicing it exports', () => {
    const v = { ...I5.voicing, estimated: false };
    exportVoicing(I5.id, v);
    expect(v.estimated).toBe(false);
  });

  it('refuses a voicing that fails the schema, naming the field', () => {
    const r = exportVoicing(I5.id, { ...I5.voicing, intake: { ...I5.voicing.intake, gain: 1.5 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.key)).toEqual(['intake.gain']);
  });
});

describe('importVoicing', () => {
  it('round-trips every engine through export', () => {
    for (const e of ENGINES) {
      const r = importVoicing(exported(e.id, e.voicing), ENGINES, FS);
      expect(r.ok, e.id).toBe(true);
      if (!r.ok) continue;
      expect(r.engine.id).toBe(e.id);
      expect(r.voicing).toEqual({ ...e.voicing, estimated: true });
    }
  });

  it('round-trips an edited voicing', () => {
    const edited = { ...V8.voicing, cabin: { lowpassHz: 750 }, headersM: V8.voicing.headersM.map((h) => h + 0.01) };
    const r = importVoicing(exported(V8.id, edited), ENGINES, FS);
    expect(r.ok && r.voicing).toEqual({ ...edited, estimated: true });
  });

  const REJECTED: [string, string, RegExp][] = [
    ['text that is not JSON', '{ engineId: ', /JSON/],
    ['a JSON array', '[]', /object/],
    ['a file without voicing', JSON.stringify({ engineId: I5.id }), /voicing/],
    ['a numeric engineId', JSON.stringify({ engineId: 5, voicing: I5.voicing }), /engineId/],
    ['an extra key', JSON.stringify({ engineId: I5.id, voicing: I5.voicing, spec: {} }), /spec/],
    ['an unknown engine', JSON.stringify({ engineId: 'w16-quad-80', voicing: I5.voicing }), /w16-quad-80/],
    ['a voicing that fails the schema', JSON.stringify({ engineId: I5.id, voicing: { ...I5.voicing, launchRpm: 50 } }), /launchRpm/],
    // The V8's eight headers on the five-cylinder: schema-valid, but the DSP refuses it.
    ['a voicing that does not fit the engine', JSON.stringify({ engineId: I5.id, voicing: V8.voicing }), /headersM/],
  ];
  for (const [what, text, message] of REJECTED) {
    it(`rejects ${what}`, () => {
      const r = importVoicing(text, ENGINES, FS);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problems.map((p) => p.message).join('\n')).toMatch(message);
    });
  }
});

describe('voicingProblems (the in-page check before anything is sent)', () => {
  const def = (voicing: EngineVoicing): EngineDef => ({ ...I5, voicing });

  it('passes every shipped engine', () => {
    for (const e of ENGINES) expect(voicingProblems(e, FS), e.id).toEqual([]);
  });

  it('flags a schema violation at its field', () => {
    const p = voicingProblems(def({ ...I5.voicing, intake: { ...I5.voicing.intake, gain: 1.5 } }), FS);
    expect(p.map((x) => x.key)).toEqual(['intake.gain']);
  });

  it('flags what assertEngineFits refuses, at its field: a 2 m header (schema allows 3 m, the core 1.5 m)', () => {
    const p = voicingProblems(def({ ...I5.voicing, headersM: [2, ...I5.voicing.headersM.slice(1)] }), FS);
    expect(p).toHaveLength(1);
    expect(p[0]?.key).toBe('headersM[0]');
    expect(p[0]?.message).toMatch(/headersM\[0\] = 2 m is outside/);
  });

  it('maps the core messages on muffler sections and collectors to their fields', () => {
    const muffler = voicingProblems(def({ ...I5.voicing, exhaust: { ...I5.voicing.exhaust, mufflerSectionsM: [0.21, 1.5] } }), FS);
    expect(muffler.map((x) => x.key)).toEqual(['exhaust.mufflerSectionsM[1]']);
    const collector = voicingProblems(def({ ...I5.voicing, collectors: [{ banks: [0], lengthM: 1.8 }] }), FS);
    expect(collector.map((x) => x.key)).toEqual(['collectors[0].lengthM']);
  });

  it('checks the length floor at the context rate (4 samples at 700 m/s: 0.0635 m at 44.1 kHz)', () => {
    const v = { ...I5.voicing, collectors: [{ banks: [0], lengthM: 0.06 }] };
    expect(voicingProblems(def(v), 48000)).toEqual([]);
    expect(voicingProblems(def(v), 44100).map((x) => x.key)).toEqual(['collectors[0].lengthM']);
  });
});
