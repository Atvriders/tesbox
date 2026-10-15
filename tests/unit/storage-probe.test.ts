import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for src/platform/storage.ts (same contract: prefix handled inside, try/catch).
const mem = vi.hoisted(() => ({
  store: new Map<string, string>(),
  available: true,
  throwOnRead: false,
  failWrites: false,
}));

vi.mock('../../src/platform/storage', () => ({
  storageAvailable: (): boolean => mem.available,
  getJSON<T>(key: string, fallback: T): T {
    if (mem.throwOnRead) throw new Error('boom');
    const raw = mem.store.get(key);
    return raw === undefined ? fallback : (JSON.parse(raw) as T);
  },
  setJSON(key: string, value: unknown): boolean {
    if (mem.failWrites) return false;
    mem.store.set(key, JSON.stringify(value));
    return true;
  },
  remove(key: string): void {
    mem.store.delete(key);
  },
}));

import { runStorageProbe } from '../../src/probe/storage-probe';

interface FakeCacheOptions {
  failOpen?: boolean;
  failPut?: boolean;
  hangOpen?: boolean;
}

function installCaches(opts: FakeCacheOptions = {}) {
  const store = new Map<string, string>();
  const opened: string[] = [];
  const cache = {
    match: async (key: string): Promise<Response | undefined> => {
      const body = store.get(key);
      return body === undefined ? undefined : new Response(body);
    },
    put: async (key: string, res: Response): Promise<void> => {
      if (opts.failPut) throw new DOMException('quota', 'QuotaExceededError');
      store.set(key, await res.text());
    },
  };
  const caches = {
    open: (name: string): Promise<typeof cache> => {
      opened.push(name);
      if (opts.hangOpen) return new Promise(() => undefined);
      if (opts.failOpen) return Promise.reject(new DOMException('denied', 'SecurityError'));
      return Promise.resolve(cache);
    },
  };
  vi.stubGlobal('caches', caches);
  return { store, opened };
}

/** The parts of a ServiceWorker the probe reads off `navigator.serviceWorker.controller`. */
interface FakeController {
  scriptURL: string;
  state: string;
}

function installNavigator(
  sw: { controller?: FakeController | null; register?: (url: string, o: object) => Promise<unknown> } | null,
) {
  const register = vi.fn(sw?.register ?? (async () => ({ scope: '/probe/' })));
  const nav = sw === null ? { userAgent: 'test' } : { userAgent: 'test', serviceWorker: { controller: sw.controller ?? null, register } };
  vi.stubGlobal('navigator', nav);
  return { register };
}

/** An active worker of the self-hosted origin whose script is at `path`. */
const activeWorker = (path: string): FakeController => ({
  scriptURL: `https://tesbox.example.com${path}`,
  state: 'activated',
});

const T0 = '2026-10-06T10:00:00.000Z';
const T1 = '2026-10-06T10:01:30.000Z'; // +90 s
const T2 = '2026-10-07T08:00:00.000Z';

beforeEach(() => {
  mem.store.clear();
  mem.available = true;
  mem.throwOnRead = false;
  mem.failWrites = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('runStorageProbe', () => {
  it('first visit: counts 1, writes the cache marker and registers ./sw.js with scope ./', async () => {
    const { opened, store } = installCaches();
    const { register } = installNavigator({});
    const r = await runStorageProbe(T0);
    expect(r).toEqual({
      localStorage: true,
      visits: 1,
      firstSeen: T0,
      lastSeen: null,
      cacheStorage: true,
      cachePersisted: false,
      cacheAgeS: null,
      swSupported: true,
      swRegistered: true,
      swControlled: false,
      controllerScript: null,
    });
    expect(opened).toEqual(['tesbox-probe']);
    expect(JSON.parse(store.get('__persist') ?? 'null')).toEqual({ ts: Date.parse(T0) });
    expect(register).toHaveBeenCalledWith('./sw.js', { scope: './' });
    expect(mem.store.get('probe.visits')).toBe('1');
    expect(mem.store.get('probe.lastSeen')).toBe(JSON.stringify(T0));
  });

  it('later visits: counter grows, firstSeen sticks, lastSeen is the previous visit, cache age measured', async () => {
    installCaches();
    installNavigator({});
    await runStorageProbe(T0);
    const second = await runStorageProbe(T1);
    expect(second.visits).toBe(2);
    expect(second.firstSeen).toBe(T0);
    expect(second.lastSeen).toBe(T0);
    expect(second.cachePersisted).toBe(true);
    expect(second.cacheAgeS).toBe(90);
    const third = await runStorageProbe(T2);
    expect(third.visits).toBe(3);
    expect(third.firstSeen).toBe(T0);
    expect(third.lastSeen).toBe(T1);
    expect(third.cacheAgeS).toBe((Date.parse(T2) - Date.parse(T1)) / 1000);
    expect(third.error).toBeUndefined();
  });

  // Q8 evidence: only the probe's own worker surviving from an earlier visit counts. The app's /sw.js
  // (scope /) also covers /probe/, so it controls a first-ever probe visit made after using the app.
  describe("swControlled: the page load was controlled by the probe's own /probe/sw.js", () => {
    it('no controller → false, controllerScript null', async () => {
      installCaches();
      installNavigator({ controller: null });
      const r = await runStorageProbe(T0);
      expect(r.swControlled).toBe(false);
      expect(r.controllerScript).toBeNull();
    });

    it('controlled by /probe/sw.js → true; only the script path is recorded, never the host', async () => {
      installCaches();
      installNavigator({ controller: activeWorker('/probe/sw.js') });
      const r = await runStorageProbe(T0);
      expect(r.swControlled).toBe(true);
      expect(r.controllerScript).toBe('/probe/sw.js');
      expect(JSON.stringify(r)).not.toContain('tesbox.example.com');
    });

    it("controlled by the app's /sw.js → false (not the probe's worker), and the probe still registers its own", async () => {
      installCaches();
      const { register } = installNavigator({ controller: activeWorker('/sw.js') });
      const r = await runStorageProbe(T0);
      expect(r.swControlled).toBe(false);
      expect(r.controllerScript).toBe('/sw.js');
      expect(r.swRegistered).toBe(true);
      expect(register).toHaveBeenCalledWith('./sw.js', { scope: './' });
      expect(r.error).toBeUndefined();
    });
  });

  it('treats corrupt stored values as absent', async () => {
    installCaches();
    installNavigator({});
    mem.store.set('probe.visits', JSON.stringify('lots'));
    mem.store.set('probe.firstSeen', JSON.stringify(5));
    mem.store.set('probe.lastSeen', JSON.stringify({}));
    const r = await runStorageProbe(T0);
    expect(r.visits).toBe(1);
    expect(r.firstSeen).toBe(T0);
    expect(r.lastSeen).toBeNull();
  });

  it('a corrupt cache entry still counts as persisted, with unknown age', async () => {
    const { store } = installCaches();
    installNavigator({});
    store.set('__persist', 'not json');
    const r = await runStorageProbe(T0);
    expect(r.cachePersisted).toBe(true);
    expect(r.cacheAgeS).toBeNull();
    expect(r.cacheStorage).toBe(true);
  });

  // RF5: unavailable or throwing storage → false flags + error string, never a rejection.
  it('RF5: localStorage unavailable → localStorage false, error set, other probes still run', async () => {
    installCaches();
    installNavigator({});
    mem.available = false;
    const r = await runStorageProbe(T0);
    expect(r.localStorage).toBe(false);
    expect(r.visits).toBe(0);
    expect(r.firstSeen).toBeNull();
    expect(r.error).toContain('localStorage: unavailable');
    expect(r.cacheStorage).toBe(true);
    expect(r.swRegistered).toBe(true);
  });

  it('RF5: localStorage throwing → resolves with localStorage false and the error message', async () => {
    installCaches();
    installNavigator({});
    mem.throwOnRead = true;
    const r = await runStorageProbe(T0);
    expect(r.localStorage).toBe(false);
    expect(r.error).toContain('localStorage: boom');
  });

  it('RF5: localStorage writes failing → localStorage false', async () => {
    installCaches();
    installNavigator({});
    mem.failWrites = true;
    const r = await runStorageProbe(T0);
    expect(r.localStorage).toBe(false);
    expect(r.error).toContain('localStorage: write failed');
  });

  it('RF5: Cache Storage missing → cacheStorage false, cachePersisted null', async () => {
    installNavigator({});
    const r = await runStorageProbe(T0);
    expect(r.cacheStorage).toBe(false);
    expect(r.cachePersisted).toBeNull();
    expect(r.cacheAgeS).toBeNull();
    expect(r.error).toContain('cacheStorage: unavailable');
  });

  it('RF5: caches.open rejecting → resolves with cacheStorage false and the DOMException name', async () => {
    installCaches({ failOpen: true });
    installNavigator({});
    const r = await runStorageProbe(T0);
    expect(r.cacheStorage).toBe(false);
    expect(r.cachePersisted).toBeNull();
    expect(r.error).toContain('cacheStorage: SecurityError: denied');
  });

  it('RF5: reading `caches` throwing (sandboxed context) → resolves', async () => {
    installNavigator({});
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new DOMException('Cache storage is disabled', 'SecurityError');
      },
    });
    try {
      const r = await runStorageProbe(T0);
      expect(r.cacheStorage).toBe(false);
      expect(r.error).toContain('cacheStorage: SecurityError');
    } finally {
      delete (globalThis as { caches?: unknown }).caches;
    }
  });

  it('RF5: cache.put failing → cacheStorage false but the read result is kept', async () => {
    installCaches({ failPut: true });
    installNavigator({});
    const r = await runStorageProbe(T0);
    expect(r.cacheStorage).toBe(false);
    expect(r.cachePersisted).toBe(false);
    expect(r.error).toContain('QuotaExceededError');
  });

  it('a hung caches.open times out after 5 s instead of hanging the probe', async () => {
    vi.useFakeTimers();
    installCaches({ hangOpen: true });
    installNavigator({});
    const pending = runStorageProbe(T0);
    await vi.advanceTimersByTimeAsync(5000);
    const r = await pending;
    expect(r.cacheStorage).toBe(false);
    expect(r.error).toContain('caches.open timed out after 5000 ms');
    expect(r.swRegistered).toBe(true);
  });

  it('service worker unsupported → swSupported false with an error entry', async () => {
    installCaches();
    installNavigator(null);
    const r = await runStorageProbe(T0);
    expect(r.swSupported).toBe(false);
    expect(r.swRegistered).toBe(false);
    expect(r.swControlled).toBe(false);
    expect(r.controllerScript).toBeNull();
    expect(r.error).toContain('serviceWorker: unsupported');
  });

  it('service worker registration rejecting → swRegistered false, message kept', async () => {
    installCaches();
    installNavigator({ register: () => Promise.reject(new TypeError('bad MIME type')) });
    const r = await runStorageProbe(T0);
    expect(r.swSupported).toBe(true);
    expect(r.swRegistered).toBe(false);
    expect(r.error).toContain('serviceWorker: TypeError: bad MIME type');
  });

  it('RF5: everything broken at once still resolves (never rejects)', async () => {
    mem.throwOnRead = true;
    installCaches({ failOpen: true });
    installNavigator({ register: () => Promise.reject(new Error('nope')) });
    await expect(runStorageProbe(T0)).resolves.toMatchObject({
      localStorage: false,
      cacheStorage: false,
      swRegistered: false,
    });
  });
});

describe('public/probe/sw.js', () => {
  type Listener = (event: { waitUntil(p: Promise<unknown>): void }) => void;

  it('skips waiting on install, claims clients on activate, and never intercepts fetches', async () => {
    const src = readFileSync(new URL('../../public/probe/sw.js', import.meta.url), 'utf8');
    const listeners = new Map<string, Listener>();
    const self = {
      addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
      skipWaiting: vi.fn(() => Promise.resolve()),
      clients: { claim: vi.fn(() => Promise.resolve()) },
    };
    new Function('self', src)(self);
    expect([...listeners.keys()].sort()).toEqual(['activate', 'install']);
    const waited: Promise<unknown>[] = [];
    const event = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    listeners.get('install')?.(event);
    listeners.get('activate')?.(event);
    await Promise.all(waited);
    expect(self.skipWaiting).toHaveBeenCalledTimes(1);
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
    expect(waited).toHaveLength(2);
  });
});
