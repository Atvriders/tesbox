/**
 * Update and stale-build check (phase-4 contract T3, spec §12).
 *
 * At boot and every UPDATE_CHECK_INTERVAL_MS the deployed build's SHA is read from /version.json
 * (`checkVersion`, fetched with `cache: 'no-store'`; it never throws). A different SHA means this page
 * is a stale build — the car's browser keeps HTML for a long time — and sets `store.update` to
 * `{ kind: 'stale', remote }`, unless a waiting service worker already set `{ kind: 'sw' }`, which wins:
 * applying it reloads into the new build anyway. A failed check (offline, a 5xx, a broken file) changes
 * nothing, so it never shows a banner; a check that finds this build deployed again clears a stale mark.
 *
 * The banner (src/ui/app.tsx UpdateBanner) shows only with the engine off and the car parked. Its tap,
 * `applyUpdateState`, activates the waiting worker, or replaces the page with `?b=<remote>` — a URL the
 * browser has not cached — and boot (src/main.ts) strips that parameter from the address bar again.
 *
 * Pure: the signal, the check, the timer and the page actions are passed in (unit-tested in Node).
 */
import type { Signal } from '@preact/signals';
import type { VersionCheck } from '../platform/build-info';
import type { UpdateState } from './store';

/** Contract T3: "On boot and every 30 min". */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** The cache-busting query parameter of a reload into a newer build (spec §12: links as `…/?b=<sha>`). */
export const BUILD_PARAM = 'b';

/** What one version check does to the update state. */
export function nextUpdate(current: UpdateState | null, check: VersionCheck): UpdateState | null {
  if (current?.kind === 'sw') return current; // a waiting worker wins
  if (check.error !== undefined || check.remote === null) return current; // nothing learned
  if (!check.stale) return null; // this build is the deployed one (again)
  return current?.remote === check.remote ? current : { kind: 'stale', remote: check.remote };
}

export interface UpdateCheckDeps {
  /** `store.update`. */
  update: Signal<UpdateState | null>;
  /** `checkVersion` (src/platform/build-info.ts). */
  check(): Promise<VersionCheck>;
  /** Defaults to the global timers. */
  setInterval?(run: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
}

/** Checks now and every UPDATE_CHECK_INTERVAL_MS until the returned stop function is called. */
export function startUpdateChecks(d: UpdateCheckDeps): () => void {
  const every = d.setInterval ?? ((run: () => void, ms: number): unknown => setInterval(run, ms));
  const clear = d.clearInterval ?? ((id: unknown): void => clearInterval(id as ReturnType<typeof setInterval>));
  let started = 0;
  let applied = 0;
  let stopped = false;
  const run = (): void => {
    const seq = ++started;
    d.check().then(
      (result) => {
        // An older request that answers late never undoes a newer answer.
        if (stopped || seq < applied) return;
        applied = seq;
        d.update.value = nextUpdate(d.update.peek(), result);
      },
      () => undefined, // checkVersion never rejects; a check that did changes nothing
    );
  };
  run();
  const id = every(run, UPDATE_CHECK_INTERVAL_MS);
  return () => {
    stopped = true;
    clear(id);
  };
}

/** `href` with `?b=<sha>` (replacing any `b`), keeping its path, other parameters and hash. */
export function withBuildParam(href: string, sha: string): string {
  const url = new URL(href);
  url.searchParams.set(BUILD_PARAM, sha);
  return url.href;
}

/** `href` without its `b` parameter (and without an empty `?`), or null when it has none. */
export function withoutBuildParam(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(BUILD_PARAM)) return null;
  url.searchParams.delete(BUILD_PARAM);
  return url.href;
}

/** What the banner tap needs of the page (src/main.ts: location and sw-register's applyUpdate). */
export interface UpdateActions {
  /** The current address, read at tap time. */
  href(): string;
  /** Activates the waiting service worker and reloads into it (src/platform/sw-register.ts applyUpdate). */
  applySw(): void;
  /** location.replace: the reload adds no history entry. */
  replace(url: string): void;
  reload(): void;
}

/** The banner tap: apply the waiting worker, or reload the stale page past its cached HTML with `?b=<remote>`. */
export function applyUpdateState(u: UpdateState, page: UpdateActions): void {
  if (u.kind === 'sw') page.applySw();
  else if (u.remote !== undefined && u.remote !== '') page.replace(withBuildParam(page.href(), u.remote));
  else page.reload();
}
