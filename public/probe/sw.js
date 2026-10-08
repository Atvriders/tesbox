/* Tesbox probe service worker (served at /probe/sw.js, scope /probe/).
 *
 * Deliberately minimal: it exists only so the probe can test whether a service worker can be
 * registered in the car and whether control survives drives and sleep (spec §16 Q8). It has no
 * fetch handler, so it can never serve a stale probe page.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
