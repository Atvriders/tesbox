/**
 * Phase-3 acceptance 3 (contract T9; spec §10.3): settings persist across a reload (also a reload
 * mid-drive, spec §6.3); corrupt or unusable localStorage gives the defaults — field by field — and never
 * crashes the app (the harness fails a test on any page error).
 */
import type { Page } from '@playwright/test';
import { DEFAULT_ENGINE, PICKED, STR, TESLA_ID, expect, test, type AppHarness } from './app-fixtures';

const DEMO = { ...PICKED, source: 'demo' } as const;

/** The pick-one group labelled `group` on Settings. */
function seg(page: Page, group: string) {
  return page.getByRole('group', { name: group, exact: true });
}

async function choose(page: Page, group: string, option: string): Promise<void> {
  await seg(page, group).getByRole('button', { name: option, exact: true }).click();
  await expectChosen(page, group, option);
}

async function expectChosen(page: Page, group: string, option: string): Promise<void> {
  await expect(seg(page, group).getByRole('button', { name: option, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

/** The value shown next to a −/+ stepper (identified by its + button). */
function stepperValue(page: Page, moreLabel: string) {
  return page.getByRole('button', { name: moreLabel, exact: true }).locator('xpath=following-sibling::output');
}

/** Garage → Drive → the Start overlay's Settings (the engine is off). */
async function openSettings(app: AppHarness): Promise<void> {
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await app.page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await app.page.getByRole('dialog', { name: STR.actions.startEngine }).getByRole('button', { name: STR.actions.settings }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
}

test('settings persist across a reload', async ({ app, page }) => {
  const U = STR.settingsUi;
  await app.open(DEMO);
  await openSettings(app);
  await expect(page.locator('fieldset')).toHaveJSProperty('disabled', false); // parked (no geolocation permission)

  await page.getByRole('button', { name: U.louder, exact: true }).click();
  await page.getByRole('button', { name: U.louder, exact: true }).click();
  await expect(stepperValue(page, U.louder)).toHaveText(U.volumeValue(2));
  await choose(page, U.perspective, STR.modes.perspective.outside);
  await choose(page, U.quality, STR.modes.tier.lite);
  await choose(page, U.accelMode, 'Chill');
  await choose(page, U.source, STR.modes.source.keyboard);
  await choose(page, U.units, STR.units.kmh);
  await choose(page, U.gamepadSwap, U.on);
  await page.getByRole('button', { name: U.showAdvanced }).click();
  await choose(page, U.gpsMethod, U.gpsMethods.watch);
  await choose(page, U.highAccuracy, U.on);
  await choose(page, U.outputRoute, U.routes.direct);
  await page.getByRole('button', { name: U.more, exact: true }).click();
  await expect(stepperValue(page, U.more)).toHaveText(U.latencyValue(1.1));

  const expected = {
    teslaId: TESLA_ID,
    volumeTrimDb: 2,
    perspective: 'outside',
    tierPref: 'lite',
    accelMode: 'Chill',
    source: 'keyboard',
    units: 'kmh',
    gamepadSwap: true,
    gpsMethod: 'watch',
    highAccuracy: true,
    outputRoute: 'direct',
    gpsLatencyS: 1.1,
  };
  expect(await app.stored()).toMatchObject(expected);

  await page.reload();
  expect(await app.stored()).toMatchObject(expected);
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(page.getByRole('dialog', { name: STR.actions.startEngine })).toContainText(STR.modes.source.keyboard);
  await page.getByRole('dialog', { name: STR.actions.startEngine }).getByRole('button', { name: STR.actions.settings }).click();
  await expect(stepperValue(page, U.louder)).toHaveText(U.volumeValue(2));
  await expect(page.getByRole('slider', { name: U.volume })).toHaveValue('2');
  await expectChosen(page, U.perspective, STR.modes.perspective.outside);
  await expectChosen(page, U.quality, STR.modes.tier.lite);
  await expectChosen(page, U.accelMode, 'Chill');
  await expectChosen(page, U.source, STR.modes.source.keyboard);
  await expectChosen(page, U.units, STR.units.kmh);
  await expectChosen(page, U.gamepadSwap, U.on);
  await page.getByRole('button', { name: U.showAdvanced }).click();
  await expectChosen(page, U.gpsMethod, U.gpsMethods.watch);
  await expectChosen(page, U.highAccuracy, U.on);
  await expectChosen(page, U.outputRoute, U.routes.direct);
  await expect(stepperValue(page, U.more)).toHaveText(U.latencyValue(1.1));
});

test('a reload mid-drive reopens Drive with Start; the modes come back and the engine starts warm', async ({ app, page }) => {
  await app.open(DEMO);
  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await app.startEngine();
  await app.driveReady();
  await page.getByRole('button', { name: `${STR.drive.driveMode}: ${STR.modes.drive.comfort}` }).click();
  await page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.auto}` }).click();
  await expect(page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.open}` })).toBeVisible();
  expect((await app.posted('warm'))[0]).toEqual({ type: 'warm', warm: false }); // a cold first start

  await page.reload();
  // Spec §6.3: settings restored, Drive with Start at once (not the garage).
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
  await expect(page.getByRole('dialog', { name: STR.actions.startEngine })).toBeVisible();
  const stored = await app.stored();
  expect(stored).toMatchObject({ driveMode: 'sport', valve: 'open' });
  expect(stored?.engineWarmAt).toEqual(expect.any(Number)); // recorded when the page went away with the engine on
  await app.startEngine();
  await expect(page.getByRole('button', { name: `${STR.drive.driveMode}: ${STR.modes.drive.sport}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.open}` })).toBeVisible();
  expect(await app.posted()).toEqual(
    expect.arrayContaining([
      { type: 'driveMode', value: 'sport' },
      { type: 'valve', mode: 'open' },
      { type: 'warm', warm: true }, // stopped less than 30 min ago (spec §5.3.5)
    ]),
  );
});

test('corrupt localStorage: unreadable JSON and non-objects give the defaults (first run)', async ({ app, page }) => {
  for (const raw of ['{"v":1,"teslaId":', '[1,2,3]', 'null', '42', '"settings"', '']) {
    await app.open(raw);
    await expect(page.locator('[data-screen="first-run"]'), raw).toHaveAttribute('data-step', 'notices');
  }
  await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
  await expect(page.locator('[data-screen="first-run"]')).toHaveAttribute('data-step', 'model');
  expect(await app.stored()).toMatchObject({ v: 1, noticesSeen: true, teslaId: null, units: 'mph' }); // rewritten whole
});

test('corrupt localStorage: each invalid field takes its default, the valid ones survive', async ({ app, page }) => {
  await app.open(
    JSON.stringify({
      v: 1,
      teslaId: TESLA_ID,
      noticesSeen: true,
      source: 'demo',
      units: 'furlongs',
      volumeTrimDb: 99,
      engineId: 'no-such-engine',
      hpCornerHz: 'deep',
      valve: null,
      wheelShift: 'yes',
      gpsLatencyS: -3,
      outputRoute: { route: 'direct' },
      accelMode: 'Ludicrous',
    }),
  );
  // Tesla and notices survive: no first run; the unknown engine is the default one.
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await expect(page.locator(`article[data-engine="${DEFAULT_ENGINE}"]`)).toHaveAttribute('aria-current', 'true');
  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(page.getByRole('dialog', { name: STR.actions.startEngine })).toContainText(STR.modes.source.demo);
  await page.getByRole('dialog', { name: STR.actions.startEngine }).getByRole('button', { name: STR.actions.settings }).click();
  const U = STR.settingsUi;
  await expectChosen(page, U.units, STR.units.mph);
  await expect(stepperValue(page, U.louder)).toHaveText(U.volumeValue(0));
  await expect(page.getByText(U.bassValue(40))).toBeVisible();
  await expectChosen(page, U.accelMode, 'Standard'); // quickest
  await expectChosen(page, U.source, STR.modes.source.demo);
  await page.getByRole('button', { name: U.showAdvanced }).click();
  await expectChosen(page, U.outputRoute, U.routes['direct-anchor']);
  await expect(stepperValue(page, U.more)).toHaveText(U.latencyValue(1));
  await expect(page.getByText(U.wheelUntested)).toBeVisible();
});

test('localStorage blocked: the app still starts and runs from memory', async ({ app, page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await app.open();
  const firstRun = page.locator('[data-screen="first-run"]');
  await expect(firstRun).toHaveAttribute('data-step', 'notices');
  await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
  await page.locator('[data-model="Model 3"]').click();
  await page.locator('[data-generation="Highland (2023–)"]').click();
  await page.locator(`[data-tesla="${TESLA_ID}"]`).click();
  await expect(firstRun).toHaveAttribute('data-step', 'subwoofer');
  await expect(firstRun).toContainText('Model 3 · Highland (2023–) · Long Range AWD');
});
