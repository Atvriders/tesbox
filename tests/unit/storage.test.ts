import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJSON, remove, setJSON, storageAvailable } from '../../src/platform/storage';

/** Minimal in-memory Storage; flags make individual methods throw like a real browser can. */
class FakeStorage {
  readonly map = new Map<string, string>();
  throwOnSet = false;
  throwOnGet = false;
  throwOnRemove = false;
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.throwOnGet) throw new DOMException('denied', 'SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    if (this.throwOnRemove) throw new DOMException('denied', 'SecurityError');
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function installValue(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value });
}

function installThrowingGetter(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('storage with a working localStorage', () => {
  let fake: FakeStorage;
  beforeEach(() => {
    fake = new FakeStorage();
    installValue(fake);
  });

  it('reports available and leaves no probe key behind', () => {
    expect(storageAvailable()).toBe(true);
    expect(fake.length).toBe(0);
  });

  it('round-trips JSON under the tesbox.v1. prefix', () => {
    expect(setJSON('probe.visits', 3)).toBe(true);
    expect(fake.map.get('tesbox.v1.probe.visits')).toBe('3');
    expect(getJSON('probe.visits', 0)).toBe(3);
    expect(setJSON('obj', { a: [1, 2], b: 'x' })).toBe(true);
    expect(getJSON('obj', { a: [] as number[], b: '' })).toEqual({ a: [1, 2], b: 'x' });
  });

  it('returns the fallback for a missing key', () => {
    expect(getJSON('missing', 'fb')).toBe('fb');
  });

  it('returns the fallback for corrupt JSON', () => {
    fake.map.set('tesbox.v1.bad', '{not json');
    expect(getJSON('bad', 7)).toBe(7);
  });

  it('returns the fallback when the stored type does not match the fallback type', () => {
    fake.map.set('tesbox.v1.n', '"seven"');
    fake.map.set('tesbox.v1.arr', '{"a":1}');
    fake.map.set('tesbox.v1.obj', 'null');
    expect(getJSON('n', 7)).toBe(7);
    expect(getJSON<number[]>('arr', [])).toEqual([]);
    expect(getJSON('obj', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns any stored JSON when the fallback is null', () => {
    setJSON('crash', { mode: 'poll-hiacc-off', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(getJSON<{ mode: string; startedAt: string } | null>('crash', null)).toEqual({
      mode: 'poll-hiacc-off',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('refuses values JSON cannot represent', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(setJSON('cyclic', cyclic)).toBe(false);
    expect(setJSON('undef', undefined)).toBe(false);
    expect(setJSON('big', 10n)).toBe(false);
    expect(fake.length).toBe(0);
  });

  it('removes a key', () => {
    setJSON('k', 1);
    remove('k');
    expect(fake.map.has('tesbox.v1.k')).toBe(false);
    expect(getJSON('k', 0)).toBe(0);
  });

  it('keeps working across calls after a transient quota failure', () => {
    fake.throwOnSet = true;
    expect(setJSON('k', 1)).toBe(false);
    expect(storageAvailable()).toBe(false);
    fake.throwOnSet = false;
    expect(setJSON('k', 2)).toBe(true);
    expect(getJSON('k', 0)).toBe(2);
    expect(storageAvailable()).toBe(true);
  });
});

describe('RF5: storage that throws never throws to the caller', () => {
  it('handles a localStorage getter that throws', () => {
    installThrowingGetter();
    expect(() => storageAvailable()).not.toThrow();
    expect(storageAvailable()).toBe(false);
    expect(getJSON('k', 'fallback')).toBe('fallback');
    expect(setJSON('k', 1)).toBe(false);
    expect(() => remove('k')).not.toThrow();
  });

  it('handles setItem (and removeItem) that throw', () => {
    const fake = new FakeStorage();
    fake.throwOnSet = true;
    fake.throwOnRemove = true;
    installValue(fake);
    expect(storageAvailable()).toBe(false);
    expect(getJSON('k', { ok: true })).toEqual({ ok: true });
    expect(setJSON('k', 1)).toBe(false);
    expect(() => remove('k')).not.toThrow();
  });

  it('handles getItem that throws', () => {
    const fake = new FakeStorage();
    fake.throwOnGet = true;
    installValue(fake);
    expect(getJSON('k', 5)).toBe(5);
  });

  it('handles localStorage being absent', () => {
    installValue(undefined);
    expect(storageAvailable()).toBe(false);
    expect(getJSON('k', 1)).toBe(1);
    expect(setJSON('k', 1)).toBe(false);
    expect(() => remove('k')).not.toThrow();
  });
});
