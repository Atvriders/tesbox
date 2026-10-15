/**
 * Phase-4 acceptance, contract T5 cases 1–3 (spec §1.1 goal 3, §12): the built app relaunches without a
 * connection through its service worker, and the Demo engine starts there — worklet and anchor sound
 * from the precache; a running engine keeps playing when the connection drops (the anchor plays from
 * memory, a blob: URL); and a browser without service workers still runs the app online, with Diagnostics
 * reporting the worker as unsupported. The harness (app-fixtures.ts) fails each test on a CSP violation,
 * a page error or an unexpected console error.
 */
import type { Page } from '@playwright/test';
import { DEFAULT_ENGINE, PICKED, S, STR, expect, test, type AppHarness } from './app-fixtures';

/** Chromium's console line for a page request that failed because the browser is offline. */
const OFFLINE_REQUEST = /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/;

async function toDrive(app: AppHarness): Promise<void> {
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await app.page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
}

/** The registration's active worker once installed (its precache complete): script and scope paths. */
async function activeWorker(page: Page): Promise<{ script: string; scope: string }> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { script: new URL(reg.active?.scriptURL ?? '/none').pathname, scope: new URL(reg.scope).pathname };
  });
}

/** Path of the worker controlling the page, or null. */
async function controller(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const c = navigator.serviceWorker.controller;
    return c === null ? null : new URL(c.scriptURL).pathname;
  });
}

/** Whether a page fetch of `path` gets any answer: 'online', or 'offline' when the request fails. */
async function reach(page: Page, path: string): Promise<'online' | 'offline'> {
  return page.evaluate((p) => fetch(p, { cache: 'no-store' }).then(() => 'online' as const, () => 'offline' as const), path);
}

test('offline relaunch: registered on the first visit, controlled on the second, then the shell and the Demo engine run offline', async ({
  app,
  page,
  context,
}) => {
  await app.open({ ...PICKED, source: 'demo' });
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  // First visit: the app worker (scope /) registers after load and installs the precached build.
  expect(await activeWorker(page)).toEqual({ script: '/sw.js', scope: '/' });

  // Second visit: the page is controlled by it.
  await page.reload();
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  expect(await controller(page)).toBe('/sw.js');

  // No connection at all: the boot's version check fails (and shows no banner) — its console line is expected.
  app.allowedConsole.push(OFFLINE_REQUEST);
  await context.setOffline(true);
  await page.reload();
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await expect(page.locator('#build-sha')).toContainText('Build ');
  expect(await controller(page)).toBe('/sw.js');
  // The page itself came out of the worker's Cache Storage (Navigation Timing `deliveryType`) …
  const delivery = await page.evaluate(
    () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & { deliveryType?: string }).deliveryType,
  );
  expect(delivery).toBe('cache-storage');
  // … and the network is really gone: the worker leaves /version.json to the network, which fails.
  expect(await reach(page, '/version.json')).toBe('offline');

  // The Demo engine starts: the worklet module and the anchor sound come from the precache.
  await toDrive(app);
  await app.startEngine();
  await app.waitForState((s) => (s[S.speedMps] ?? 0) > 2, 20_000, 'the demo drives the car offline');
  await expect(page.getByRole('button', { name: STR.update.banner })).toBeHidden();
});

test('a running engine survives losing the connection: snapshots keep arriving and the anchor plays from memory', async ({
  app,
  page,
  context,
}) => {
  // The anchor <audio> is never attached to the document: record every media element the page plays.
  await page.addInitScript(() => {
    const played: HTMLMediaElement[] = [];
    (window as unknown as { __tbxPlayed: HTMLMediaElement[] }).__tbxPlayed = played;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
      played.push(this);
      return play.call(this);
    };
  });
  const anchor = (): Promise<{ src: string; paused: boolean; loop: boolean } | null> =>
    page.evaluate(() => {
      const el = (window as unknown as { __tbxPlayed: HTMLMediaElement[] }).__tbxPlayed.at(-1);
      return el === undefined ? null : { src: el.src, paused: el.paused, loop: el.loop };
    });

  await app.open({ ...PICKED, source: 'demo' }); // output route: direct + anchor (the default)
  await toDrive(app);
  await app.startEngine();
  await app.waitForState((s) => (s[S.speedMps] ?? 0) > 2, 20_000, 'the demo drives the car');
  await expect.poll(async () => (await anchor())?.src ?? '', { message: 'the anchor loop plays from a blob: URL' }).toMatch(/^blob:/);

  app.allowedConsole.push(OFFLINE_REQUEST); // the failed request of the offline check just below
  await context.setOffline(true);
  expect(await reach(page, '/version.json')).toBe('offline');
  const t0 = (await app.lastState())?.[S.time] ?? Number.NaN;
  let count = await app.stateCount();
  for (let second = 1; second <= 5; second++) {
    await page.waitForTimeout(1000);
    const next = await app.stateCount();
    expect(next - count, `snapshots in offline second ${second} (~30 per second)`).toBeGreaterThan(15);
    count = next;
  }
  const t1 = (await app.lastState())?.[S.time] ?? Number.NaN;
  expect(t1 - t0, 'worklet seconds rendered while offline').toBeGreaterThan(4);

  const a = await anchor();
  expect(a?.src).toMatch(/^blob:/);
  expect(a?.loop).toBe(true);
  expect(a?.paused).toBe(false);
  await expect(page.getByRole('button', { name: STR.actions.tapToResume })).toBeHidden();
  await expect(page.getByRole('dialog', { name: STR.actions.startEngine })).toBeHidden();
});

test.describe('in a browser without service workers', () => {
  test.use({ serviceWorkers: 'block' });

  test('the app runs online and Diagnostics shows "service worker: unsupported"', async ({ app, page }) => {
    await app.open({ ...PICKED, source: 'demo' });
    await toDrive(app);
    await app.startEngine();
    await app.waitForState((s) => (s[S.speedMps] ?? 0) > 2, 20_000, 'the demo drives the car');
    expect(await controller(page)).toBeNull();

    await app.longPress(page.getByRole('button', { name: new RegExp(STR.drive.statusHold) }));
    await expect(app.screen()).toHaveAttribute('data-screen', 'diagnostics');
    const swRow = page.locator('dt', { hasText: new RegExp(`^${STR.diag.f.serviceWorker}$`) }).locator('xpath=following-sibling::dd[1]');
    await expect(swRow).toHaveText(STR.diag.swStates.unsupported);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });
});
