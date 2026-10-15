/* Tesbox app service worker, served as /sw.js with scope / (phase-4 contract T1, spec §12).
 *
 * Template: deploy/sw-plugin.ts replaces the marker line below with `CACHE` ('tesbox-<build sha>') and
 * `PRECACHE` (the app page's files + /probe/anchor.wav + /version.json) and emits the result as /sw.js.
 * Written from the Service Worker and Cache Storage specifications; no third-party code.
 *
 * - install: precache the build, all or nothing. No skipWaiting() here: a new version waits until the page
 *   applies it (src/platform/sw-register.ts posts SKIP_WAITING), so it never swaps under a running engine.
 * - activate: delete the older builds' tesbox-* caches (never the probe's 'tesbox-probe' persistence
 *   check), then claim the open pages.
 * - fetch, same-origin GET only:
 *   - /version.json: network only — the stale-build check must never see a cached answer;
 *   - navigations: network first with a 3 s timeout, else the cached /index.html; the probe page
 *     (/probe, /probe/…) and the Sound Lab (/lab, /lab/…) are left alone: the probe has its own /probe/sw.js,
 *     and neither must ever get the app shell;
 *   - /assets/* of this build (in PRECACHE): cache first (content-hashed, immutable); a fetched 200 is kept;
 *     any other /assets/* file is left to the network and never cached: scope / also covers /probe/, so
 *     this worker controls a probe page until the probe's own worker is registered and sees the requests
 *     for the probe's chunk and CSS, which are not part of the app;
 *   - everything else: network, else the cached copy.
 *   Both fallbacks also cover a 5xx (a proxy or tunnel answering for a server that is down), so the car
 *   still relaunches from the cache when only the self-hosted server is unreachable.
 */
/* global self, caches, fetch, URL, setTimeout, clearTimeout, CACHE, PRECACHE */
// @inject CACHE PRECACHE

/** The probe's Cache Storage persistence check (src/probe/storage-probe.ts), not an app build. */
const PROBE_CACHE = 'tesbox-probe';
/** Pages under this worker's scope that are not the app (phase-4 contract T1, phase-2c contract L1). */
const OWN_PAGES = ['/probe', '/lab'];
const SHELL = '/index.html';
const NAVIGATION_TIMEOUT_MS = 3000;
/** The root-relative paths of this build's files: the only /assets/* the worker serves from its cache. */
const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('tesbox-') && name !== CACHE && name !== PROBE_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/version.json') return;
  if (request.mode === 'navigate') {
    // The probe and the Sound Lab are their own pages: never the app shell (or a cached copy of it).
    if (OWN_PAGES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;
    event.respondWith(networkFirst(request, SHELL, NAVIGATION_TIMEOUT_MS));
  } else if (url.pathname.startsWith('/assets/')) {
    if (!PRECACHED.has(url.pathname)) return; // another page's file (the probe's): the network's, uncached
    event.respondWith(cacheFirst(request, event));
  } else {
    event.respondWith(networkFirst(request, request));
  }
});

/** This build's cached copy (no cache is created by looking; a proxy's Vary header never causes a miss). */
function cachedCopy(request) {
  return caches.match(request, { cacheName: CACHE, ignoreVary: true });
}

/**
 * The network's answer; on a network error, a 5xx or no answer within `timeoutMs` (when given), the
 * cached copy of `fallback`. With nothing cached: the network's own answer or error after all.
 */
async function networkFirst(request, fallback, timeoutMs) {
  const network = fetch(request);
  network.catch(() => undefined); // a failure is handled below, never reported as unhandled
  let timer;
  const deadline = new Promise((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(resolve, timeoutMs, null);
  });
  const response = await Promise.race([network, deadline]).catch(() => null);
  clearTimeout(timer);
  if (response !== null && response.status < 500) return response;
  return (await cachedCopy(fallback)) || response || network;
}

/** Hashed build output: the cached copy, else the network's (a 200 is kept for next time). */
async function cacheFirst(request, event) {
  const hit = await cachedCopy(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200) {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
  }
  return response;
}
