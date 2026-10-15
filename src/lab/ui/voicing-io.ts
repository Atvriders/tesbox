/**
 * Sound Lab voicing checks, export and import (phase-2c contract L3):
 *
 * - voicingProblems(def, fs): what the page checks before it sends a voicing — engine.schema.json
 *   `$defs.voicing`, then assertEngineFits(def, fs) at the context's sample rate (the length floor is 4 samples
 *   at 700 m/s). Each problem names its field key where it has one, so the panel can flag the field.
 * - exportVoicing: `<engineId>.voicing.json` = `{ engineId, voicing }`, schema-validated, `estimated: true`
 *   always (only the user's listening sign-off flips it, by hand in src/data/engines/<id>.json).
 * - importVoicing: parse → `{ engineId, voicing }` and nothing else → a known engine → voicingProblems; only a
 *   file that passes everything is handed back to be applied.
 */
import type { EngineDef, EngineVoicing } from '../../contracts';
import { assertEngineFits } from '../../dsp/dsp-core';
import { validateSchema } from './schema';
import { VOICING_SCHEMA } from './voicing-fields';

export interface Problem {
  /** The voicing field (`headersM[0]`), or null when the problem is not about one field. */
  key: string | null;
  message: string;
}

export type ExportResult = { ok: true; fileName: string; text: string } | { ok: false; problems: Problem[] };

export type ImportResult = { ok: true; engine: EngineDef; voicing: EngineVoicing } | { ok: false; problems: Problem[] };

const FITS_PREFIX = 'TesboxDspCore.configure: ';
const FILE_KEYS: readonly string[] = ['engineId', 'voicing'];
const VOICING_KEYS: ReadonlySet<string> = new Set(
  Object.keys((VOICING_SCHEMA.properties ?? {}) as Record<string, unknown>),
);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Schema problems of a voicing, keyed by field path. */
export function schemaProblems(voicing: unknown): Problem[] {
  return validateSchema(VOICING_SCHEMA, voicing).map((e) => ({
    key: e.path === '' ? null : e.path,
    message: `${e.path === '' ? 'voicing' : e.path} ${e.message}`,
  }));
}

/**
 * The voicing field an assertEngineFits message is about: its leading path token, without a `voicing.`
 * prefix (`mufflerSectionsM` lives in `exhaust`); null for spec problems (`combustion…`, `def`, `spec…`).
 */
function fitsKey(message: string): string | null {
  const m = /^([A-Za-z_]\w*(?:\[\d+\])?(?:\.[A-Za-z_]\w*(?:\[\d+\])?)*)/.exec(message);
  if (m === null || m[1] === undefined) return null;
  let key = m[1].replace(/^voicing\./, '');
  if (key.startsWith('mufflerSectionsM')) key = `exhaust.${key}`;
  const top = /^[A-Za-z_]\w*/.exec(key)?.[0] ?? '';
  return VOICING_KEYS.has(top) ? key : null;
}

/** A problem from a TesboxDspCore.configure / assertEngineFits message (the worklet relays the same text). */
export function coreProblem(raw: string): Problem {
  const message = raw.startsWith(FITS_PREFIX) ? raw.slice(FITS_PREFIX.length) : raw;
  return { key: fitsKey(message), message };
}

/** What assertEngineFits refuses about `def` at sample rate `fs`, or null. */
export function fitsProblem(def: EngineDef, fs: number): Problem | null {
  try {
    assertEngineFits(def, fs);
    return null;
  } catch (e) {
    return coreProblem(errText(e));
  }
}

/** Schema problems first (assertEngineFits would trip over a malformed voicing), then the core's own check. */
export function voicingProblems(def: EngineDef, fs: number): Problem[] {
  const schema = schemaProblems(def.voicing);
  if (schema.length > 0) return schema;
  const fits = fitsProblem(def, fs);
  return fits === null ? [] : [fits];
}

export function exportVoicing(engineId: string, voicing: EngineVoicing): ExportResult {
  const v: EngineVoicing = { ...voicing, estimated: true };
  const problems = schemaProblems(v);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, fileName: `${engineId}.voicing.json`, text: `${JSON.stringify({ engineId, voicing: v }, null, 2)}\n` };
}

export function importVoicing(text: string, engines: readonly EngineDef[], fs: number): ImportResult {
  const fail = (message: string, key: string | null = null): ImportResult => ({ ok: false, problems: [{ key, message }] });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return fail(`Not JSON: ${errText(e)}`);
  }
  if (!isObject(data)) return fail('The file must hold one JSON object: { "engineId": …, "voicing": … }');
  const problems: Problem[] = [];
  for (const k of Object.keys(data)) {
    if (!FILE_KEYS.includes(k)) problems.push({ key: null, message: `Unexpected key "${k}": the file holds only engineId and voicing` });
  }
  if (typeof data.engineId !== 'string') problems.push({ key: null, message: 'engineId must be a string' });
  if (!Object.prototype.hasOwnProperty.call(data, 'voicing')) problems.push({ key: null, message: 'voicing is required' });
  if (problems.length > 0) return { ok: false, problems };
  const engine = engines.find((e) => e.id === data.engineId);
  if (engine === undefined) return fail(`Unknown engine "${String(data.engineId)}"`);
  const voicing = data.voicing as EngineVoicing;
  const found = voicingProblems({ ...engine, voicing }, fs);
  if (found.length > 0) return { ok: false, problems: found };
  return { ok: true, engine, voicing };
}
