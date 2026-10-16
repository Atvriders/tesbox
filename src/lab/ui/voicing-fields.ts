/**
 * The Sound Lab's voicing controls, generated from engine.schema.json `$defs.voicing` (phase-2c contract L3):
 *
 * - number → slider + number input over the schema range. Without a schema maximum: the Phase 2b T6 tunable
 *   range when T6 lists the field, else [min, max(1, 4 × the engine's value)]. Ranges come from the engine's
 *   shipped voicing (`base`), so they stay put while a draft value moves, and widen to hold that value when it
 *   lies outside (a slider must never clamp what the engine ships). Slider step ≈ range / 1000 (1 for integers).
 * - arrays → one control per element (the length is fixed);
 * - nullable objects (turbine, forcedInduction) → their fields when present, else one non-editable 'absent'
 *   entry;
 * - booleans → checkbox; `estimated` is shown but not editable (only the user's sign-off flips it);
 * - string enums → a select.
 *
 * Each top-level object or array is a group; the top-level scalars (launchRpm, estimated) share 'general'.
 * Keys read like JSON paths (`collectors[0].lengthM`) — the vocabulary of src/data/engines/<id>.json.
 */
import type { EngineVoicing } from '../../contracts';
import engineSchema from '../../data/schema/engine.schema.json';
import { joinPath, type JsonSchema } from './schema';

export const VOICING_SCHEMA: JsonSchema = engineSchema.$defs.voicing;

export type Path = readonly (string | number)[];

interface FieldBase {
  /** `pulse.alpha`, `headersM[2]`, `collectors[0].banks[1]`. */
  key: string;
  path: Path;
  /** The key relative to its group (`alpha`, `[2]`, `[0].banks[1]`). */
  label: string;
}

export interface NumberField extends FieldBase {
  kind: 'number';
  unit: string;
  min: number;
  max: number;
  step: number;
  integer: boolean;
  value: number;
}

export interface BooleanField extends FieldBase {
  kind: 'boolean';
  value: boolean;
  editable: boolean;
}

export interface EnumField extends FieldBase {
  kind: 'enum';
  options: readonly string[];
  value: string;
}

/** A nullable object that is null: shown, not editable. */
export interface AbsentField extends FieldBase {
  kind: 'absent';
}

export type VoicingField = NumberField | BooleanField | EnumField | AbsentField;

export interface FieldGroup {
  /** The top-level voicing property, or 'general' for the top-level scalars. */
  key: string;
  fields: VoicingField[];
}

/**
 * Phase 2b contract T6 tunable ranges (as amended by D9, D10 and D11) of single voicing fields (`[]` = any element), used
 * only where the schema sets no maximum (today pulse.alpha and pulse.beta). pulse.widthDeg is left out: its T6
 * range depends on the engine (rotary or not), and the schema bounds it anyway.
 */
export const T6_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'pulse.alpha': [3, 20],
  'pulse.beta': [1, 10],
  'pulse.cycleAsymmetry': [0, 0.5],
  'pulse.cylinderSpreadDb': [0, 6],
  'collectors[].lengthM': [0.1, 1.0],
  'exhaust.midPipeM': [0.6, 3.0],
  'exhaust.mufflerAction': [0, 1],
  'exhaust.tailpipeM': [0.2, 1.2],
  'intake.helmholtzHz': [60, 300],
  'intake.gain': [0, 1],
  'mechanical.blockGain': [0, 1],
  'mechanical.valvetrainGain': [0, 1],
  'cabin.lowpassHz': [200, 2000],
  'cabin.leakDb': [-60, -10],
  'overrun.cutPulseDb': [-60, 0],
  'cabin.boomHz': [40, 400],
  'cabin.boomDb': [-12, 12],
  'forcedInduction.cabinGainDb': [-24, -6],
  'forcedInduction.whistleDb': [-60, 0],
  'forcedInduction.outsideGainDb': [-60, 0],
};

/** Not editable even though the schema allows it: flipped only by the user's listening sign-off. */
const READ_ONLY: ReadonlySet<string> = new Set(['estimated']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function pathKey(path: Path): string {
  return path.reduce<string>((acc, k) => joinPath(acc, k), '');
}

/** `collectors[1].lengthM` → `collectors[].lengthM`. */
function genericKey(key: string): string {
  return key.replace(/\[\d+\]/g, '[]');
}

/** Unit from a field name's suffix: widthDeg → °, lpHz → Hz, cabinGainDb → dB, launchRpm → rpm, …M → m, …S → s. */
function unitOf(name: string): string {
  if (/Deg$/.test(name)) return '°';
  if (/Hz$/.test(name)) return 'Hz';
  if (/Db$/.test(name)) return 'dB';
  if (/Krpm$/.test(name)) return 'krpm';
  if (/Rpm$/.test(name)) return 'rpm';
  if (/[a-z]M$/.test(name)) return 'm';
  if (/[a-z]S$/.test(name)) return 's';
  return '';
}

/** The object branch of `anyOf: [{ type: 'null' }, { type: 'object', … }]`, else null. */
function nullableObject(schema: JsonSchema): JsonSchema | null {
  if (!Array.isArray(schema.anyOf)) return null;
  const branches = schema.anyOf as JsonSchema[];
  const obj = branches.find((b) => b.type === 'object');
  return obj !== undefined && branches.some((b) => b.type === 'null') ? obj : null;
}

function isGroup(schema: JsonSchema): boolean {
  return schema.type === 'object' || schema.type === 'array' || nullableObject(schema) !== null;
}

export function getIn(root: unknown, path: Path): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** A copy of `root` with `value` at `path`: copies along the path, shares every other branch. */
export function setIn<T>(root: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  const [k, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    const i = k as number;
    copy[i] = setIn(root[i], rest, value);
    return copy as T;
  }
  const obj: Record<string, unknown> = isObject(root) ? root : {};
  const name = k as string;
  return { ...obj, [name]: setIn(obj[name], rest, value) } as T;
}

export function voicingFields(voicing: EngineVoicing, schema: JsonSchema = VOICING_SCHEMA, base: EngineVoicing = voicing): FieldGroup[] {
  const groups: FieldGroup[] = [];
  const general: VoicingField[] = [];
  const props = isObject(schema.properties) ? schema.properties : {};
  const root = voicing as unknown as Record<string, unknown>;
  for (const [name, sub] of Object.entries(props)) {
    if (!isObject(sub)) continue;
    if (isGroup(sub)) {
      const fields: VoicingField[] = [];
      walk(sub, root[name], [name], name, fields, base);
      groups.push({ key: name, fields });
    } else {
      walk(sub, root[name], [name], '', general, base);
    }
  }
  if (general.length > 0) groups.push({ key: 'general', fields: general });
  return groups;
}

function walk(schema: JsonSchema, value: unknown, path: Path, group: string, out: VoicingField[], base: EngineVoicing): void {
  const key = pathKey(path);
  const rel = group === '' ? key : key.slice(group.length).replace(/^\./, '');
  const label = rel === '' ? key : rel;
  const objectBranch = nullableObject(schema);
  if (objectBranch !== null) {
    if (isObject(value)) walk(objectBranch, value, path, group, out, base);
    else out.push({ kind: 'absent', key, path, label });
    return;
  }
  if (schema.type === 'object') {
    if (!isObject(value)) return;
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const [name, sub] of Object.entries(props)) {
      if (isObject(sub)) walk(sub, value[name], [...path, name], group, out, base);
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || !isObject(schema.items)) return;
    const items = schema.items;
    value.forEach((x, i) => walk(items, x, [...path, i], group, out, base));
    return;
  }
  if (Array.isArray(schema.enum) && typeof value === 'string') {
    out.push({ kind: 'enum', key, path, label, options: schema.enum.filter((x): x is string => typeof x === 'string'), value });
    return;
  }
  if (schema.type === 'boolean' && typeof value === 'boolean') {
    out.push({ kind: 'boolean', key, path, label, value, editable: !READ_ONLY.has(key) });
    return;
  }
  if ((schema.type === 'number' || schema.type === 'integer') && typeof value === 'number') {
    out.push(numberField(schema, value, path, key, label, base));
  }
}

function numberField(schema: JsonSchema, value: number, path: Path, key: string, label: string, base: EngineVoicing): NumberField {
  const integer = schema.type === 'integer';
  const ref = finiteNumber(getIn(base, path)) ?? (Number.isFinite(value) ? value : 0);
  const lo0 = finiteNumber(schema.minimum) ?? finiteNumber(schema.exclusiveMinimum);
  const hi0 = finiteNumber(schema.maximum) ?? finiteNumber(schema.exclusiveMaximum);
  let lo: number;
  let hi: number;
  const t6 = hi0 === undefined ? T6_RANGES[genericKey(key)] : undefined;
  if (t6 !== undefined) {
    [lo, hi] = t6;
  } else {
    lo = lo0 ?? Math.min(0, ref);
    hi = hi0 ?? Math.max(1, 4 * ref);
  }
  if (ref < lo) lo = ref;
  if (ref > hi) hi = ref;
  if (!(hi > lo)) hi = lo + 1;
  const step = integer ? 1 : 10 ** Math.floor(Math.log10((hi - lo) / 1000));
  const name = [...path].reverse().find((k): k is string => typeof k === 'string') ?? key;
  return { kind: 'number', key, path, label, unit: unitOf(name), min: lo, max: hi, step, integer, value };
}
