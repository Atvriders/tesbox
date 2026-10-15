import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../src/app/store';
import {
  BUILD_PARAM,
  UPDATE_CHECK_INTERVAL_MS,
  applyUpdateState,
  nextUpdate,
  startUpdateChecks,
  withBuildParam,
  withoutBuildParam,
  type UpdateActions,
} from '../../src/app/update-check';
import type { VersionCheck } from '../../src/platform/build-info';

const LOCAL = 'abc1234';
const REMOTE = 'def5678';

const stale = (remote = REMOTE): VersionCheck => ({ local: LOCAL, remote, stale: true });
const current: VersionCheck = { local: LOCAL, remote: LOCAL, stale: false };
const failed: VersionCheck = { local: LOCAL, remote: null, stale: false, error: 'HTTP 503' };
const SW: UpdateState = { kind: 'sw' };

describe('nextUpdate — what one version check does to store.update (phase-4 contract T3)', () => {
  it('a deployed build that differs marks the page stale, with the deployed SHA', () => {
    expect(nextUpdate(null, stale())).toEqual({ kind: 'stale', remote: REMOTE });
  });

  it('a waiting service worker wins: an sw update is never replaced or cleared by a check', () => {
    for (const check of [stale(), current, failed]) expect(nextUpdate(SW, check)).toBe(SW);
  });

  it('a failed check changes nothing (offline, a 5xx, a broken version.json): no banner from an error', () => {
    expect(nextUpdate(null, failed)).toBeNull();
    const mark: UpdateState = { kind: 'stale', remote: REMOTE };
    expect(nextUpdate(mark, failed)).toBe(mark);
    // checkVersion never reports stale with an error, but a remote is required to act on one anyway.
    expect(nextUpdate(null, { local: LOCAL, remote: null, stale: true })).toBeNull();
  });

  it('a check that finds this build deployed again clears a stale mark (the deploy was rolled back)', () => {
    expect(nextUpdate({ kind: 'stale', remote: REMOTE }, current)).toBeNull();
    expect(nextUpdate(null, current)).toBeNull();
  });

  it('keeps the same object for the same remote (no needless banner re-render); a newer deploy replaces it', () => {
    const mark: UpdateState = { kind: 'stale', remote: REMOTE };
    expect(nextUpdate(mark, stale())).toBe(mark);
    expect(nextUpdate(mark, stale('0123abc'))).toEqual({ kind: 'stale', remote: '0123abc' });
  });
});

/** A controllable checkVersion: each call returns a promise the test settles. */
function checks() {
  const pending: { resolve(c: VersionCheck): void; reject(e: unknown): void }[] = [];
  return {
    pending,
    check: (): Promise<VersionCheck> =>
      new Promise<VersionCheck>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
}

/** An injected interval timer: the test fires it. */
function timer() {
  const t = {
    runs: [] as { fn: () => void; ms: number }[],
    cleared: [] as unknown[],
    setInterval: (fn: () => void, ms: number): unknown => {
      t.runs.push({ fn, ms });
      return `timer-${t.runs.length}`;
    },
    clearInterval: (id: unknown): void => {
      t.cleared.push(id);
    },
    fire: (): void => {
      for (const r of t.runs) r.fn();
    },
  };
  return t;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('startUpdateChecks — on boot and every 30 min', () => {
  it('checks at once, then every 30 minutes on the injected timer', async () => {
    const c = checks();
    const t = timer();
    const update = signal<UpdateState | null>(null);
    startUpdateChecks({ update, check: c.check, setInterval: t.setInterval, clearInterval: t.clearInterval });
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(c.pending).toHaveLength(1); // boot
    expect(t.runs.map((r) => r.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS]);
    c.pending[0]?.resolve(current);
    await flush();
    expect(update.value).toBeNull();
    t.fire();
    expect(c.pending).toHaveLength(2);
    c.pending[1]?.resolve(stale());
    await flush();
    expect(update.value).toEqual({ kind: 'stale', remote: REMOTE });
  });

  it('a stale result sets store.update unless a waiting worker already did (sw wins)', async () => {
    const c = checks();
    const t = timer();
    const update = signal<UpdateState | null>(null);
    startUpdateChecks({ update, check: c.check, setInterval: t.setInterval, clearInterval: t.clearInterval });
    update.value = SW; // src/main.ts: registerAppSw found a waiting worker while the check was in flight
    c.pending[0]?.resolve(stale());
    await flush();
    expect(update.value).toBe(SW);
    t.fire();
    c.pending[1]?.resolve(current);
    await flush();
    expect(update.value).toBe(SW);
  });

  it('a failed check leaves the state as it was and the next check still runs', async () => {
    const c = checks();
    const t = timer();
    const update = signal<UpdateState | null>(null);
    startUpdateChecks({ update, check: c.check, setInterval: t.setInterval, clearInterval: t.clearInterval });
    c.pending[0]?.resolve(stale());
    await flush();
    t.fire();
    c.pending[1]?.resolve(failed);
    await flush();
    expect(update.value).toEqual({ kind: 'stale', remote: REMOTE });
    t.fire();
    c.pending[2]?.reject(new Error('checkVersion broke its promise')); // never rejects by contract; harmless anyway
    await flush();
    expect(update.value).toEqual({ kind: 'stale', remote: REMOTE });
    t.fire();
    expect(c.pending).toHaveLength(4);
  });

  it('an older check that answers after a newer one is ignored (a slow request never undoes a newer answer)', async () => {
    const c = checks();
    const t = timer();
    const update = signal<UpdateState | null>(null);
    startUpdateChecks({ update, check: c.check, setInterval: t.setInterval, clearInterval: t.clearInterval });
    t.fire();
    c.pending[1]?.resolve(stale('0123abc'));
    await flush();
    c.pending[0]?.resolve(current); // the boot check, stuck for 30 min, answers last
    await flush();
    expect(update.value).toEqual({ kind: 'stale', remote: '0123abc' });
  });

  it('stop() clears the timer, and a check still in flight no longer writes', async () => {
    const c = checks();
    const t = timer();
    const update = signal<UpdateState | null>(null);
    const stop = startUpdateChecks({ update, check: c.check, setInterval: t.setInterval, clearInterval: t.clearInterval });
    stop();
    expect(t.cleared).toEqual(['timer-1']);
    c.pending[0]?.resolve(stale());
    await flush();
    expect(update.value).toBeNull();
  });
});

describe('the ?b=<sha> reload parameter (spec §12: links documented as …/?b=<sha>)', () => {
  it('withBuildParam sets b, keeping the path, other parameters and the hash', () => {
    expect(BUILD_PARAM).toBe('b');
    expect(withBuildParam('https://tesbox.example.com/', REMOTE)).toBe(`https://tesbox.example.com/?b=${REMOTE}`);
    expect(withBuildParam('https://tesbox.example.com/?x=1#top', REMOTE)).toBe(`https://tesbox.example.com/?x=1&b=${REMOTE}#top`);
    expect(withBuildParam(`https://tesbox.example.com/?b=${LOCAL}`, REMOTE)).toBe(`https://tesbox.example.com/?b=${REMOTE}`);
  });

  it('withoutBuildParam drops b (and an empty "?"), keeps the rest; null when there is no b', () => {
    expect(withoutBuildParam(`https://tesbox.example.com/?b=${REMOTE}`)).toBe('https://tesbox.example.com/');
    expect(withoutBuildParam(`https://tesbox.example.com/?x=1&b=${REMOTE}#top`)).toBe('https://tesbox.example.com/?x=1#top');
    expect(withoutBuildParam('https://tesbox.example.com/?x=1')).toBeNull();
    expect(withoutBuildParam('https://tesbox.example.com/')).toBeNull();
  });
});

describe('applyUpdateState — the banner tap', () => {
  function page(href = 'https://tesbox.example.com/') {
    const calls: string[] = [];
    let at = href;
    const actions: UpdateActions = {
      href: () => at,
      applySw: () => void calls.push('applySw'),
      replace: (url) => void calls.push(`replace ${url}`),
      reload: () => void calls.push('reload'),
    };
    return { actions, calls, moveTo: (url: string) => (at = url) };
  }

  it('a waiting worker: applyUpdate() (skip waiting, then reload into it)', () => {
    const p = page();
    applyUpdateState(SW, p.actions);
    expect(p.calls).toEqual(['applySw']);
  });

  it('a stale page: replaces the current URL with ?b=<remote>, past the cached HTML (no new history entry)', () => {
    const p = page();
    p.moveTo('https://tesbox.example.com/?x=1'); // read at tap time
    applyUpdateState({ kind: 'stale', remote: REMOTE }, p.actions);
    expect(p.calls).toEqual([`replace https://tesbox.example.com/?x=1&b=${REMOTE}`]);
  });

  it('a stale mark without a remote SHA just reloads', () => {
    const p = page();
    applyUpdateState({ kind: 'stale' }, p.actions);
    expect(p.calls).toEqual(['reload']);
  });
});
