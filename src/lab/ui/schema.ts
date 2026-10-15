/**
 * A small JSON Schema validator for the subset engine.schema.json `$defs.voicing` uses (type, enum, const,
 * properties / required / additionalProperties, items / minItems / maxItems, minimum / maximum /
 * exclusiveMinimum / exclusiveMaximum, minLength / maxLength, anyOf). The Sound Lab page needs its own: Ajv
 * compiles schemas into generated functions, which the CSP (`script-src 'self'`, no eval) forbids.
 * tests/unit/lab-ui-schema.test.ts keeps it in agreement with Ajv on the voicing schema.
 *
 * A keyword outside the subset throws instead of being ignored, so a schema change can never make the page
 * accept what the schema rejects. Numbers must be finite (JSON cannot carry NaN or Infinity; a draft can).
 * Paths read like the field keys of src/lab/ui/voicing-fields.ts: `pulse.alpha`, `collectors[0].banks[1]`.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

export interface SchemaError {
  /** Where: `pulse.alpha`, `headersM[3]`; '' for the value itself. */
  path: string;
  message: string;
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'anyOf',
]);
/** Annotations: no effect on validity. */
const ANNOTATIONS: ReadonlySet<string> = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples']);

export function validateSchema(schema: JsonSchema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  check(schema, value, '', errors);
  return errors;
}

/** `a` + `b` → `a.b`; `a` + 2 → `a[2]`. */
export function joinPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function own(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function matchesType(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'null':
      return v === null;
    case 'boolean':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'string':
      return typeof v === 'string';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v);
    default:
      throw new Error(`schema: unsupported type ${JSON.stringify(type)}`);
  }
}

function typesOf(schema: JsonSchema): unknown[] | null {
  const t = schema.type;
  if (t === undefined) return null;
  return Array.isArray(t) ? t : [t];
}

function show(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : String(v);
}

function check(schema: JsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`schema: unsupported keyword "${k}" at ${path || '(root)'}`);
  }
  const at = (message: string): void => {
    errors.push({ path, message });
  };

  const types = typesOf(schema);
  if (types !== null && !types.some((t) => matchesType(t, value))) {
    at(`must be ${types.join(' or ')}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x: unknown) => x === value)) {
    at(`must be one of ${schema.enum.map(show).join(', ')}`);
  }
  if (own(schema, 'const') && schema.const !== value) at(`must be ${show(schema.const)}`);

  if (typeof value === 'number') {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
    if (typeof minimum === 'number' && !(value >= minimum)) at(`must be ≥ ${minimum}`);
    if (typeof maximum === 'number' && !(value <= maximum)) at(`must be ≤ ${maximum}`);
    if (typeof exclusiveMinimum === 'number' && !(value > exclusiveMinimum)) at(`must be > ${exclusiveMinimum}`);
    if (typeof exclusiveMaximum === 'number' && !(value < exclusiveMaximum)) at(`must be < ${exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) at(`must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) at(`must have at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) at(`must have at least ${schema.minItems} entries`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) at(`must have at most ${schema.maxItems} entries`);
    if (isObject(schema.items)) {
      const items = schema.items;
      value.forEach((x, i) => check(items, x, joinPath(path, i), errors));
    }
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (typeof r === 'string' && !own(value, r)) errors.push({ path: joinPath(path, r), message: 'is required' });
      }
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = own(props, k) ? props[k] : undefined;
      if (isObject(sub)) check(sub, v, joinPath(path, k), errors);
      else if (schema.additionalProperties === false) errors.push({ path: joinPath(path, k), message: 'is not allowed' });
      else if (isObject(schema.additionalProperties)) check(schema.additionalProperties, v, joinPath(path, k), errors);
    }
  }
  if (Array.isArray(schema.anyOf)) checkAnyOf(schema.anyOf as JsonSchema[], value, path, errors);
}

/**
 * Valid when one branch is. Otherwise the errors of the branch whose type takes the value (a nullable
 * object holding an object reports what is wrong inside it), else one "must be A or B" error.
 */
function checkAnyOf(branches: readonly JsonSchema[], value: unknown, path: string, errors: SchemaError[]): void {
  let typed: SchemaError[] | null = null;
  for (const b of branches) {
    const e: SchemaError[] = [];
    check(b, value, path, e);
    if (e.length === 0) return;
    const types = typesOf(b);
    if (typed === null && types !== null && types.some((t) => matchesType(t, value))) typed = e;
  }
  if (typed !== null) {
    errors.push(...typed);
    return;
  }
  const names = branches.flatMap((b) => typesOf(b) ?? []);
  errors.push({ path, message: names.length > 0 ? `must be ${names.join(' or ')}` : 'matches no allowed form' });
}
