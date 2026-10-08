/**
 * Safe localStorage wrapper (spec §10.3). Every key is namespaced "tesbox.v1." and every access
 * is wrapped in try/catch: the `localStorage` getter itself throws when site data is blocked,
 * and setItem throws when the quota is exhausted. Nothing here ever throws.
 */
const PREFIX = 'tesbox.v1.';
const PROBE_KEY = `${PREFIX}__probe__`;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when a write + remove round-trip succeeds right now. */
export function storageAvailable(): boolean {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(PROBE_KEY, '1');
    s.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads and parses `tesbox.v1.<key>`. Missing, unparseable or type-mismatched values (a value
 * whose typeof / array-ness differs from a non-null `fallback`) return `fallback`.
 */
export function getJSON<T>(key: string, fallback: T): T {
  const s = store();
  if (!s) return fallback;
  try {
    const raw = s.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (fallback !== null && fallback !== undefined) {
      if (typeof parsed !== typeof fallback) return fallback;
      if (Array.isArray(parsed) !== Array.isArray(fallback)) return fallback;
      if (typeof fallback === 'object' && parsed === null) return fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** Stores JSON under `tesbox.v1.<key>`. False when storage is unavailable, full, or the value is not serialisable. */
export function setJSON(key: string, value: unknown): boolean {
  const s = store();
  if (!s) return false;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return false;
    s.setItem(PREFIX + key, json);
    return true;
  } catch {
    return false;
  }
}

/** Removes `tesbox.v1.<key>`; silently does nothing when storage is unavailable. */
export function remove(key: string): void {
  try {
    store()?.removeItem(PREFIX + key);
  } catch {
    // storage unavailable: nothing to remove
  }
}
