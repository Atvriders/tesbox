/**
 * Phase-4 acceptance, contract T5 case 4 (spec §10.1, §12): a newer deployed build — /version.json
 * answered by route interception with another SHA — puts up "Update available — tap to reload" only
 * while the engine is off and the fake GPS says the car is parked (the Settings lock's parked rule),
 * never over a running engine; the tap reloads the page with ?b=<that SHA>, and the app removes the
 * parameter from the address bar again once loaded. At the 773×601 @1.53 design layout the banner is
 * a full touch target and, on Drive, floats clear of the Start engine button.
 *
 * Service workers are blocked: page.route does not see requests a service worker makes, and the worker
 * has its own update path (a waiting worker), covered by unit tests. Fake positions only, around 0, 0.
 */
import type { Locator, Page } from '@playwright/test';
import { minTouchCssPx } from '../../src/contracts';
import { DEFAULT_ENGINE, PICKED, STR, expect, test } from './app-fixtures';

const DPR = 1.53;

test.use({
  serviceWorkers: 'block',
  permissions: ['geolocation'],
  viewport: { width: 773, height: 601 },
  deviceScaleFactor: DPR,
});

/** The "deployed" build the routed version.json reports. */
const REMOTE = 'c0ffee1';

function banner(page: Page): Locator {
  return page.getByRole('button', { name: STR.update.banner });
}

/** Hidden now and still hidden a moment later (it would show within a render of the state that allows it). */
async function staysHidden(page: Page): Promise<void> {
  await expect(banner(page)).toBeHidden();
  await page.waitForTimeout(1500);
  await expect(banner(page)).toBeHidden();
}

test('the update banner waits for engine off + parked, and its tap reloads with ?b=<remote sha>', async ({ app, page, request }) => {
  const local = ((await (await request.get('/version.json')).json()) as { sha: string }).sha;
  expect(local, 'the routed build must differ from the served one').not.toBe(REMOTE);
  let checks = 0;
  await page.route('**/version.json', async (route) => {
    if (route.request().resourceType() === 'fetch') checks++;
    await route.fulfill({ json: { sha: REMOTE, builtAt: '2026-10-14T00:00:00.000Z' }, headers: { 'Cache-Control': 'no-store' } });
  });

  // Moving, engine off: the boot check finds the newer build, but no banner while moving.
  const gps = await app.fakeGps();
  await gps.drive(20);
  await app.open({ ...PICKED, source: 'demo' });
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await expect.poll(() => checks, { message: 'the boot version check' }).toBeGreaterThan(0);
  await expect(page.getByText(STR.garage.previewParkedOnly)).toBeVisible({ timeout: 10_000 });
  await staysHidden(page);

  // Engine running (moving, then parked): never over a running engine.
  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await app.startEngine();
  await staysHidden(page);
  await gps.drive(0);
  const driveSettings = page.getByTestId('drive-settings');
  await expect(driveSettings).toBeEnabled({ timeout: 10_000 }); // parked: Settings unlock
  await staysHidden(page);

  // Engine stopped while parked: the banner appears.
  await driveSettings.click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
  await page.getByRole('button', { name: STR.actions.stopEngine, exact: true }).click();
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });
  await expect(banner(page)).toHaveText(STR.update.banner);

  // Moving again (engine still off): it goes away, and comes back once the GPS reports parked.
  await gps.drive(20);
  await expect(page.getByText(STR.readOnlyWhileMoving)).toBeVisible({ timeout: 10_000 });
  await expect(banner(page)).toBeHidden();
  await gps.drive(0);
  await expect(banner(page)).toBeVisible({ timeout: 10_000 });

  // A full touch target (spec §7.1) — on Drive too, where it floats above the Start overlay, clear of Start.
  const min = minTouchCssPx(DPR);
  const box = await banner(page).boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(min - 0.01);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(min - 0.01);
  await page.getByRole('button', { name: STR.actions.drive, exact: true }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
  await expect(banner(page)).toBeVisible();
  const start = page.getByRole('button', { name: STR.actions.startEngine, exact: true });
  await expect(start).toBeVisible();
  const b = await banner(page).boundingBox();
  const s = await start.boundingBox();
  if (b === null || s === null) throw new Error('banner or Start engine not rendered');
  expect(b.height).toBeGreaterThanOrEqual(min - 0.01);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height, 'the banner ends above Start engine').toBeLessThanOrEqual(s.y);
  const scroll = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }));
  expect(scroll.sh, 'Drive still fits the window').toBeLessThanOrEqual(scroll.ch);

  // The tap: a reload of this page with ?b=<remote sha> (location.replace), then a clean address bar.
  const reload = page.waitForRequest(
    (r) => r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).searchParams.get('b') === REMOTE,
  );
  await banner(page).click();
  const nav = await reload;
  expect(new URL(nav.url()).pathname).toBe('/');
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage'); // the engine was stopped: no Drive reopen
  await expect.poll(() => new URL(page.url()).search, { message: 'boot strips ?b= from the address bar' }).toBe('');
  expect(new URL(page.url()).pathname).toBe('/');
});
