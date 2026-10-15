/**
 * The generated app service worker (deploy/sw-template.js rendered by deploy/sw-plugin.ts), evaluated in
 * Node against an in-memory Cache Storage and a scripted network (phase-4 contract T1 strategies).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSw } from '../../deploy/sw-plugin';

const ORIGIN = 'https://tesbox.example.com';
const CACHE = 'tesbox-abc1234';
const PRECACHE = [
  '/assets/main-AAA.js',
  '/assets/worklet-EEE.js',
  '/index.html',
  '/probe/anchor.wav',
  '/unsupported.js',
  '/version.json',
];
const SOURCE = renderSw(
  readFileSync(new URL('../../deploy/sw-template.js', import.meta.url), 'utf8'),
  'abc1234',
  PRECACHE,
);

/** What the worker reads of a Request (a navigation Request cannot be constructed outside a browser). */
interface Req {
  url: string;
  method: string;
  mode: string;
}

const get = (path: string, mode = 'cors'): Req => ({ url: new URL(path, ORIGIN).href, method: 'GET', mode });
const navigate = (path: string): Req => get(path, 'navigate');
const keyOf = (req: Req | string): string => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;

/** A response whose origin a test can read without consuming the body. */
const tagged = (tag: string, status = 200): Response => new Response('', { status, headers: { 'x-tag': tag } });
const tagOf = (res: Response): string | null => res.headers.get('x-tag');

type Route = (req: Req) => Response | Promise<Response>;

/** One Cache: keyed by absolute URL like the real one (relative URLs resolve against the worker's origin). */
class FakeCache {
  readonly entries = new Map<string, Response>();
  constructor(private readonly network: (req: Req) => Promise<Response>) {}
  match(req: Req | string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(keyOf(req)));
  }
  put(req: Req | string, res: Response): Promise<void> {
    this.entries.set(keyOf(req), res);
    return Promise.resolve();
  }
  /** All or nothing: one failed fetch or non-OK response rejects and stores nothing. */
  async addAll(urls: string[]): Promise<void> {
    const got = await Promise.all(
      urls.map(async (url) => {
        const res = await this.network(get(url));
        if (!res.ok) throw new TypeError(`addAll: ${url} answered ${res.status}`);
        return [keyOf(url), res] as const;
      }),
    );
    for (const [key, res] of got) this.entries.set(key, res);
  }
}

interface Worker {
  listeners: Map<string, (event: unknown) => void>;
  stores: Map<string, FakeCache>;
  routes: Map<string, Route>;
  fetch: ReturnType<typeof vi.fn<(req: Req) => Promise<Response>>>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
  /** Cache deletions and the clients.claim() call, in order. */
  log: string[];
  setOffline(offline: boolean): void;
}

function boot(): Worker {
  const listeners = new Map<string, (event: unknown) => void>();
  const routes = new Map<string, Route>();
  const log: string[] = [];
  let offline = false;
  const fetch = vi.fn(async (req: Req): Promise<Response> => {
    if (offline) throw new TypeError('Failed to fetch');
    const route = routes.get(new URL(req.url).pathname);
    return route === undefined ? tagged('network 404', 404) : route(req);
  });
  const stores = new Map<string, FakeCache>();
  const caches = {
    open(name: string): Promise<FakeCache> {
      let cache = stores.get(name);
      if (cache === undefined) {
        cache = new FakeCache(fetch);
        stores.set(name, cache);
      }
      return Promise.resolve(cache);
    },
    keys: (): Promise<string[]> => Promise.resolve([...stores.keys()]),
    /** MultiCacheQueryOptions.cacheName: only that cache (undefined when it does not exist), else all. */
    match(req: Req | string, opts: { cacheName?: string } = {}): Promise<Response | undefined> {
      const names = opts.cacheName === undefined ? [...stores.keys()] : [opts.cacheName];
      for (const name of names) {
        const hit = stores.get(name)?.entries.get(keyOf(req));
        if (hit !== undefined) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
    delete(name: string): Promise<boolean> {
      log.push(`delete ${name}`);
      return Promise.resolve(stores.delete(name));
    },
  };
  const skipWaiting = vi.fn(() => Promise.resolve());
  const claim = vi.fn(() => {
    log.push('claim');
    return Promise.resolve();
  });
  const self = {
    location: new URL('/sw.js', ORIGIN),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting,
    clients: { claim },
  };
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetch);
  return { listeners, stores, routes, fetch, skipWaiting, claim, log, setOffline: (v) => (offline = v) };
}

/** Dispatches an extendable event and waits for its waitUntil promises; returns how many there were. */
async function extendable(w: Worker, type: string, fields: Record<string, unknown> = {}): Promise<number> {
  const waits: Promise<unknown>[] = [];
  w.listeners.get(type)?.({ ...fields, waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  return waits.length;
}

/** Every precached path is served by the network, tagged 'precache <path>'. */
function serveBuild(w: Worker): void {
  for (const path of PRECACHE) w.routes.set(path, () => tagged(`precache ${path}`));
}

async function installed(): Promise<Worker> {
  const w = boot();
  serveBuild(w);
  await extendable(w, 'install');
  return w;
}

interface Dispatched {
  /** What the worker passed to respondWith — undefined when it left the request to the browser. */
  response: Promise<Response> | undefined;
  waits: Promise<unknown>[];
}

function dispatchFetch(w: Worker, request: Req): Dispatched {
  const out: Dispatched = { response: undefined, waits: [] };
  w.listeners.get('fetch')?.({
    request,
    respondWith: (r: Response | Promise<Response>) => {
      out.response = Promise.resolve(r);
    },
    waitUntil: (p: Promise<unknown>) => out.waits.push(p),
  });
  return out;
}

async function respond(w: Worker, request: Req): Promise<Response> {
  const { response, waits } = dispatchFetch(w, request);
  if (response === undefined) throw new Error(`${request.url} was not answered by the worker`);
  const res = await response;
  await Promise.all(waits);
  return res;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('install', () => {
  it('precaches every PRECACHE file into tesbox-<sha> and leaves skipping the wait to the page', async () => {
    const w = await installed();
    expect([...w.stores.keys()]).toEqual([CACHE]);
    expect([...(w.stores.get(CACHE)?.entries.keys() ?? [])].sort()).toEqual(PRECACHE.map((p) => ORIGIN + p));
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });

  it('fails when one precached file cannot be fetched, so no half-filled build is ever installed', async () => {
    const w = boot();
    serveBuild(w);
    w.routes.delete('/assets/worklet-EEE.js');
    await expect(extendable(w, 'install')).rejects.toThrow('/assets/worklet-EEE.js');
    expect(w.stores.get(CACHE)?.entries.size ?? 0).toBe(0);
  });
});

describe('activate', () => {
  it("deletes the older tesbox-* caches (never the probe's) and only then claims the open pages", async () => {
    const w = boot();
    for (const name of ['tesbox-0ld0000', 'other-site-cache', 'tesbox-probe', CACHE, 'tesbox-dev']) {
      w.stores.set(name, new FakeCache(w.fetch));
    }
    expect(await extendable(w, 'activate')).toBe(1);
    expect([...w.stores.keys()].sort()).toEqual(['other-site-cache', CACHE, 'tesbox-probe'].sort());
    expect(w.log).toEqual(['delete tesbox-0ld0000', 'delete tesbox-dev', 'claim']);
  });
});

describe('message', () => {
  it('SKIP_WAITING activates the waiting worker; any other message does not', async () => {
    const w = boot();
    await extendable(w, 'message', { data: { type: 'HELLO' } });
    await extendable(w, 'message', { data: null });
    expect(w.skipWaiting).not.toHaveBeenCalled();
    await extendable(w, 'message', { data: { type: 'SKIP_WAITING' } });
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('fetch: left to the browser', () => {
  it('non-GET, cross-origin, probe-page and lab-page requests', async () => {
    const w = await installed();
    // Control: the same requests as plain same-origin app GETs are answered by the worker (a path that only
    // starts with "lab" is an app route).
    expect(dispatchFetch(w, get('/assets/main-AAA.js')).response).toBeDefined();
    expect(dispatchFetch(w, navigate('/')).response).toBeDefined();
    expect(dispatchFetch(w, navigate('/labs')).response).toBeDefined();
    for (const request of [
      { ...get('/assets/main-AAA.js'), method: 'POST' },
      get('https://elsewhere.example/assets/main-AAA.js'),
      navigate('https://elsewhere.example/'),
      navigate('/probe/'),
      navigate('/probe'),
      navigate('/probe/index.html?b=abc1234'),
      // The Sound Lab (phase-2c contract): its own page, never the app shell from this worker's cache.
      navigate('/lab/'),
      navigate('/lab'),
      navigate('/lab/index.html?b=abc1234'),
    ]) {
      expect(dispatchFetch(w, request).response, `${request.method} ${request.url} ${request.mode}`).toBeUndefined();
    }
  });

  it('/version.json goes to the network only, never answered from the cache that holds it', async () => {
    const w = await installed();
    expect(w.stores.get(CACHE)?.entries.has(`${ORIGIN}/version.json`)).toBe(true);
    w.setOffline(true);
    expect(dispatchFetch(w, get('/version.json')).response).toBeUndefined();
    expect(dispatchFetch(w, get('/version.json?b=abc1234')).response).toBeUndefined();
    expect(dispatchFetch(w, navigate('/version.json')).response).toBeUndefined();
  });
});

describe('fetch: navigations — network first, cached /index.html as fallback', () => {
  it('online: the network page, not the cached shell', async () => {
    const w = await installed();
    w.routes.set('/garage', () => tagged('network /garage'));
    const request = navigate('/garage');
    expect(tagOf(await respond(w, request))).toBe('network /garage');
    expect(w.fetch).toHaveBeenLastCalledWith(request);
  });

  it('offline: the cached shell for every app path', async () => {
    const w = await installed();
    w.setOffline(true);
    // /lab is the Sound Lab's own page (left to the browser); /labs is just another app path.
    for (const path of ['/', '/index.html', '/labs', '/garage', '/?b=abc1234']) {
      expect(tagOf(await respond(w, navigate(path))), path).toBe('precache /index.html');
    }
  });

  it('no answer within 3 s: the cached shell at 3 s, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await installed();
    w.routes.set('/', () => new Promise<Response>(() => undefined)); // the tunnel never answers
    const { response } = dispatchFetch(w, navigate('/'));
    let served: Response | null = null;
    void response?.then((res) => (served = res));
    await vi.advanceTimersByTimeAsync(2999);
    expect(served).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(served).not.toBeNull();
    expect(tagOf(served as unknown as Response)).toBe('precache /index.html');
  });

  it('a slow answer inside 3 s: the network page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const w = await installed();
    w.routes.set(
      '/',
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(tagged('network /')), 2900)),
    );
    const { response } = dispatchFetch(w, navigate('/'));
    let served: Response | null = null;
    void response?.then((res) => (served = res));
    await vi.advanceTimersByTimeAsync(2900);
    expect(tagOf(served as unknown as Response)).toBe('network /');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tagOf(served as unknown as Response)).toBe('network /');
  });

  it('a 5xx from the server or tunnel: the cached shell; a 4xx is passed on', async () => {
    const w = await installed();
    w.routes.set('/', () => tagged('network 502', 502));
    expect(tagOf(await respond(w, navigate('/')))).toBe('precache /index.html');
    w.routes.set('/', () => tagged('network 403', 403));
    expect(tagOf(await respond(w, navigate('/')))).toBe('network 403');
  });

  it('offline before anything was cached: the network error', async () => {
    const w = boot(); // never installed
    w.setOffline(true);
    await expect(respond(w, navigate('/'))).rejects.toThrow('Failed to fetch');
  });
});

describe("fetch: /assets/* — cache first for this build's precached files only", () => {
  it('a cached asset never touches the network', async () => {
    const w = await installed();
    w.fetch.mockClear();
    expect(tagOf(await respond(w, get('/assets/worklet-EEE.js')))).toBe('precache /assets/worklet-EEE.js');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('a precached asset missing from the cache comes from the network and is kept again (only a 200)', async () => {
    const w = await installed();
    const appCache = w.stores.get(CACHE);
    appCache?.entries.delete(`${ORIGIN}/assets/main-AAA.js`); // evicted
    w.routes.set('/assets/main-AAA.js', () => tagged('network main'));
    expect(tagOf(await respond(w, get('/assets/main-AAA.js')))).toBe('network main');
    w.setOffline(true);
    expect(tagOf(await respond(w, get('/assets/main-AAA.js')))).toBe('network main');

    w.setOffline(false);
    appCache?.entries.delete(`${ORIGIN}/assets/worklet-EEE.js`);
    w.routes.delete('/assets/worklet-EEE.js');
    await expect(respond(w, get('/assets/worklet-EEE.js')).then(tagOf)).resolves.toBe('network 404');
    expect(appCache?.entries.has(`${ORIGIN}/assets/worklet-EEE.js`)).toBe(false);
    w.routes.set('/assets/worklet-EEE.js', () => tagged('network worklet, back again'));
    expect(tagOf(await respond(w, get('/assets/worklet-EEE.js')))).toBe('network worklet, back again');
    expect(tagOf(appCache?.entries.get(`${ORIGIN}/assets/worklet-EEE.js`) as Response)).toBe(
      'network worklet, back again',
    );
  });

  // Scope / covers /probe/: until the probe registers its own /probe/sw.js, this worker controls a probe
  // page and sees the requests for its hashed chunk and CSS, which are not part of the app's build graph.
  it("the probe page's chunk and CSS (any non-precached /assets/* file): left to the network, never served from or kept in the app cache", async () => {
    const w = await installed();
    const appCache = w.stores.get(CACHE);
    const probeFiles = ['/assets/probe-HHH.js', '/assets/probe-III.css'];
    for (const path of probeFiles) w.routes.set(path, () => tagged(`network ${path}`));
    w.fetch.mockClear();
    for (const path of probeFiles) {
      const { response, waits } = dispatchFetch(w, get(path));
      expect(response, path).toBeUndefined(); // the browser fetches it from the network itself
      expect(waits, path).toHaveLength(0);
    }
    expect(w.fetch).not.toHaveBeenCalled();
    expect([...w.stores.keys()]).toEqual([CACHE]);
    expect([...(appCache?.entries.keys() ?? [])].sort()).toEqual(PRECACHE.map((p) => ORIGIN + p));

    // Not served from the app cache even when a copy is in it, online or offline.
    await appCache?.put(get('/assets/probe-HHH.js'), tagged('app-cached probe chunk'));
    expect(dispatchFetch(w, get('/assets/probe-HHH.js')).response).toBeUndefined();
    w.setOffline(true);
    expect(dispatchFetch(w, get('/assets/probe-HHH.js')).response).toBeUndefined();
  });
});

describe('fetch: everything else — network, cache as fallback', () => {
  it('online: the network copy even when a cached one exists', async () => {
    const w = await installed();
    w.routes.set('/unsupported.js', () => tagged('network /unsupported.js'));
    expect(tagOf(await respond(w, get('/unsupported.js')))).toBe('network /unsupported.js');
  });

  it('offline or a 5xx: the cached copy; offline and never cached: the network error', async () => {
    const w = await installed();
    w.routes.set('/probe/anchor.wav', () => tagged('network 503', 503));
    expect(tagOf(await respond(w, get('/probe/anchor.wav')))).toBe('precache /probe/anchor.wav');
    w.setOffline(true);
    expect(tagOf(await respond(w, get('/probe/anchor.wav')))).toBe('precache /probe/anchor.wav');
    await expect(respond(w, get('/NOTICES.txt'))).rejects.toThrow('Failed to fetch');
  });
});
