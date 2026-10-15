/**
 * App service-worker registration and update hand-off (phase-4 contract T1, spec §12).
 *
 * registerAppSw() registers /sw.js (scope /, emitted by deploy/sw-plugin.ts) where the browser has service
 * workers, and calls onUpdateReady when a new version is installed and waiting: already waiting at
 * registration, or installed later while a worker controls this page (the very first install is not an
 * update). The worker never activates a new version by itself; applyUpdate() — from the update banner,
 * shown only parked with the engine off (phase-4 T3) — asks the waiting worker to skip waiting and reloads
 * once it controls the page. The probe registers its own /probe/sw.js (scope /probe/, which wins over / for
 * probe pages once registered). Until then this worker controls a probe page too, but leaves its navigations
 * and its non-precached assets to the network; the probe only counts control by its own worker (Q8).
 */

export type SwRegisterResult = 'registered' | 'unsupported' | 'failed';

/** The parts of a ServiceWorker the updater uses. */
interface SwWorker {
  readonly state: string;
  postMessage(message: unknown): void;
  addEventListener(type: 'statechange', listener: () => void): void;
}

/** The parts of a ServiceWorkerRegistration the updater uses. */
interface SwRegistration {
  readonly waiting: SwWorker | null;
  readonly installing: SwWorker | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
}

/** The parts of navigator.serviceWorker the updater uses. */
interface SwContainer {
  readonly controller: object | null;
  register(scriptUrl: string, options: { scope: string }): Promise<SwRegistration | undefined>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

/** What the updater needs of the page. */
export interface SwHost {
  /** No `serviceWorker` property = unsupported (an old browser, an insecure context). */
  readonly navigator: object;
  reload(): void;
}

export interface SwUpdater {
  register(onUpdateReady: () => void): Promise<SwRegisterResult>;
  applyUpdate(): void;
}

const SCRIPT_URL = '/sw.js';
const SCOPE = '/';
/** applyUpdate reloads by then even if the new worker never takes control (e.g. it became redundant). */
const APPLY_FALLBACK_MS = 5000;

export function createSwUpdater(host: SwHost): SwUpdater {
  let container: SwContainer | null = null;
  let registration: SwRegistration | null = null;
  let applying = false;
  let reloading = false;

  const reload = (): void => {
    if (reloading) return;
    reloading = true;
    host.reload();
  };

  return {
    async register(onUpdateReady) {
      try {
        if (!('serviceWorker' in host.navigator)) return 'unsupported';
        const sw = (host.navigator as { serviceWorker: SwContainer }).serviceWorker;
        const reg = await sw.register(SCRIPT_URL, { scope: SCOPE });
        // A stubbed register() resolves without a registration (Playwright `serviceWorkers: 'block'`).
        if (!reg) return 'unsupported';
        container = sw;
        registration = reg;
        // Only the update this page asked for reloads it: never the first install's clients.claim(), nor
        // an update applied from another tab while this one may be driving.
        sw.addEventListener('controllerchange', () => {
          if (applying) reload();
        });
        const followed = new Set<SwWorker>();
        const follow = (worker: SwWorker | null): void => {
          if (worker === null || followed.has(worker)) return;
          followed.add(worker);
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && sw.controller !== null) onUpdateReady();
          });
        };
        if (reg.waiting !== null) onUpdateReady();
        follow(reg.installing); // an install already under way: its updatefound may have fired already
        reg.addEventListener('updatefound', () => follow(reg.installing));
        return 'registered';
      } catch {
        return 'failed';
      }
    },

    applyUpdate() {
      const waiting = registration?.waiting ?? null;
      if (container === null || waiting === null) {
        reload(); // nothing waiting any more: another tab already activated the new version
        return;
      }
      applying = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
      setTimeout(reload, APPLY_FALLBACK_MS);
    },
  };
}

let shared: SwUpdater | null = null;

/** The page's updater: the browser's navigator and location.reload(). */
function pageUpdater(): SwUpdater {
  shared ??= createSwUpdater({
    navigator: typeof navigator === 'undefined' ? {} : navigator,
    reload: () => location.reload(),
  });
  return shared;
}

/** Registers the app service worker; onUpdateReady runs whenever a new version is waiting. Never rejects. */
export function registerAppSw(onUpdateReady: () => void): Promise<SwRegisterResult> {
  return pageUpdater().register(onUpdateReady);
}

/** Activates the waiting version and reloads into it (call only when parked with the engine off). */
export function applyUpdate(): void {
  pageUpdater().applyUpdate();
}

/** The parts of `window` afterLoad uses. */
export interface LoadTarget {
  readonly document: { readonly readyState: DocumentReadyState };
  addEventListener(type: 'load', listener: () => void, options: { once: boolean }): void;
}

/**
 * Runs `run` once the page has finished loading (at once if it already has). Registering the worker then
 * lets its precache reuse the HTTP cache instead of competing with the app's first load (spec §12).
 */
export function afterLoad(page: LoadTarget, run: () => void): void {
  if (page.document.readyState === 'complete') run();
  else page.addEventListener('load', run, { once: true });
}
