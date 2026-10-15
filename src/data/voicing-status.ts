/**
 * Voicing status of an engine (phase-4 contract T4): the garage shows "Beta voicing" until the user's
 * listening sign-off sets `voicing.estimated` to false (spec §11.6), and "Tuned" while a voicing tuned
 * against reference recordings (tools/tune.ts --apply) waits for that sign-off.
 *
 * "Tuned" means the voicing differs from `defaultVoicing(spec)` — the same function
 * tests/unit/engines.test.ts holds every untuned engine to — compared as JSON data (key order ignored),
 * leaving out the sign-off flag itself.
 */
import type { EngineDef } from '../contracts';
import { defaultVoicing } from './voicing-defaults';

export type VoicingStatus = 'default' | 'tuned' | 'signed-off';

/** Structural equality of JSON-like values: objects by their own keys in any order, arrays in order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every((k) => Object.hasOwn(rb, k) && sameJson(ra[k], rb[k]));
}

/** The voicing differs from defaultVoicing(spec) — `estimated` aside: the sign-off alone is no tuning. */
export function isTunedVoicing(def: EngineDef): boolean {
  return !sameJson({ ...def.voicing, estimated: true }, defaultVoicing(def.spec));
}

/** 'signed-off' once `estimated` is false; before that 'tuned' or 'default'. */
export function voicingStatus(def: EngineDef): VoicingStatus {
  if (!def.voicing.estimated) return 'signed-off';
  return isTunedVoicing(def) ? 'tuned' : 'default';
}
