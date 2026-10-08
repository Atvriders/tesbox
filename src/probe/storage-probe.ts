/**
 * Storage persistence probe (spec §12, §16 Q8): localStorage visit counter, Cache Storage
 * round-trip and Service Worker registration.
 *
 * runStorageProbe() NEVER rejects: every unavailable API or thrown error becomes a false flag
 * plus a message in `error` ("; "-joined, one entry per failing part).
 */
import { getJSON, setJSON, storageAvailable } from '../platform/storage';
import { errText, withTimeout } from './log';

export interface StorageReport {
  localStorage: boolean;
  /** Visits including this one (0 when localStorage is unusable). */
  visits: number;
  /** ISO time of the first recorded visit (this visit on first run). */
  firstSeen: string | null;
  /** ISO time of the PREVIOUS visit (null on the first visit). */
  lastSeen: string | null;
  cacheStorage: boolean;
  /** true = an entry written by an earlier visit was found; null = Cache Storage unusable. */
  cachePersisted: boolean | null;
  /** Age of that earlier entry in seconds (0.1 s resolution), null if none/unreadable. */
  cacheAgeS: number | null;
  swSupported: boolean;
  swRegistered: boolean;
  /** This page load was already controlled by a service worker (i.e. it survived from a previous visit). */
  swControlled: boolean;
  error?: string;
}

const VISITS_KEY = 'probe.visits';
const FIRST_SEEN_KEY = 'probe.firstSeen';
const LAST_SEEN_KEY = 'probe.lastSeen';
const CACHE_NAME = 'tesbox-probe';
const PERSIST_KEY = '__persist';
const STEP_TIMEOUT_MS = 5000;

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function probeLocalStorage(r: StorageReport, nowIso: string, errors: string[]): void {
  if (!storageAvailable()) {
    errors.push('localStorage: unavailable');
    return;
  }
  const prevVisits = getJSON<unknown>(VISITS_KEY, 0);
  const prevFirst = getJSON<unknown>(FIRST_SEEN_KEY, null);
  const prevLast = getJSON<unknown>(LAST_SEEN_KEY, null);
  r.visits = (isCount(prevVisits) ? prevVisits : 0) + 1;
  r.firstSeen = typeof prevFirst === 'string' ? prevFirst : nowIso;
  r.lastSeen = typeof prevLast === 'string' ? prevLast : null;
  const written =
    setJSON(VISITS_KEY, r.visits) && setJSON(FIRST_SEEN_KEY, r.firstSeen) && setJSON(LAST_SEEN_KEY, nowIso);
  if (!written) {
    errors.push('localStorage: write failed');
    return;
  }
  r.localStorage = true;
}

async function readAgeS(res: Response, nowMs: number): Promise<number | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('ts' in body)) return null;
    const ts = (body as { ts: unknown }).ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || !Number.isFinite(nowMs)) return null;
    return Math.round((nowMs - ts) / 100) / 10;
  } catch {
    return null; // corrupt entry: it still persisted, but its age is unknown
  }
}

async function probeCacheStorage(r: StorageReport, nowIso: string, errors: string[]): Promise<void> {
  // Reading `caches` itself throws SecurityError in sandboxed/opaque-origin contexts.
  const cacheStorage = (globalThis as { caches?: CacheStorage }).caches;
  if (cacheStorage === undefined) {
    errors.push('cacheStorage: unavailable');
    return;
  }
  const nowMs = Date.parse(nowIso);
  const cache = await withTimeout(cacheStorage.open(CACHE_NAME), STEP_TIMEOUT_MS, 'caches.open');
  const previous = await withTimeout(cache.match(PERSIST_KEY), STEP_TIMEOUT_MS, 'cache.match');
  r.cachePersisted = previous !== undefined;
  r.cacheAgeS = previous === undefined ? null : await readAgeS(previous, nowMs);
  const body = JSON.stringify({ ts: nowMs });
  await withTimeout(
    cache.put(PERSIST_KEY, new Response(body, { headers: { 'Content-Type': 'application/json' } })),
    STEP_TIMEOUT_MS,
    'cache.put',
  );
  r.cacheStorage = true;
}

async function probeServiceWorker(r: StorageReport, errors: string[]): Promise<void> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const container: ServiceWorkerContainer | undefined = nav?.serviceWorker;
  if (!container) {
    errors.push('serviceWorker: unsupported');
    return;
  }
  r.swSupported = true;
  r.swControlled = Boolean(container.controller);
  // Relative to the probe page (/probe/): script /probe/sw.js, scope /probe/.
  await withTimeout(container.register('./sw.js', { scope: './' }), STEP_TIMEOUT_MS, 'serviceWorker.register');
  r.swRegistered = true;
}

export async function runStorageProbe(nowIso: string = new Date().toISOString()): Promise<StorageReport> {
  const report: StorageReport = {
    localStorage: false,
    visits: 0,
    firstSeen: null,
    lastSeen: null,
    cacheStorage: false,
    cachePersisted: null,
    cacheAgeS: null,
    swSupported: false,
    swRegistered: false,
    swControlled: false,
  };
  const errors: string[] = [];
  try {
    probeLocalStorage(report, nowIso, errors);
  } catch (e) {
    report.localStorage = false;
    errors.push(`localStorage: ${errText(e)}`);
  }
  try {
    await probeCacheStorage(report, nowIso, errors);
  } catch (e) {
    report.cacheStorage = false;
    errors.push(`cacheStorage: ${errText(e)}`);
  }
  try {
    await probeServiceWorker(report, errors);
  } catch (e) {
    report.swRegistered = false;
    errors.push(`serviceWorker: ${errText(e)}`);
  }
  if (errors.length > 0) report.error = errors.join('; ');
  return report;
}
