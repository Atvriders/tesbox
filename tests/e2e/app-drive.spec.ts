/**
 * Phase-3 acceptance 2 (contract T9): Drive in Demo — Start engine → snapshots arrive; rpm and gear
 * change over the demo loop; `+` / `−` paddles and `E` / `Q` shift in Manual; a simulated Media Session
 * `nexttrack` shifts once wheel shifting is enabled (Settings → steering-wheel test, spec §7.2).
 *
 * Geolocation is not granted here, so the browser counts as parked (contract global rules) and the
 * demo drives the simulated car.
 */
import { F } from '../../src/contracts';
import { MEDIA_DEDUPE_MS } from '../../src/input/media-shift';
import { DEFAULT_ENGINE, PICKED, S, STR, expect, test, type AppHarness } from './app-fixtures';

const DEMO = { ...PICKED, source: 'demo' } as const;

/** Garage → Drive on the default engine's card. */
async function toDrive(app: AppHarness): Promise<void> {
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await app.page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
}

/** Waits until the worklet runs in `gear` with no shift in flight (a request during a shift is dropped, spec §8.6). */
async function settledIn(app: AppHarness, gear: number): Promise<void> {
  await expect(app.gear()).toHaveText(String(gear));
  await app.waitForState((s) => s[S.gear] === gear && ((s[S.flags] ?? 0) & F.SHIFTING) === 0, 5_000, `settled in gear ${gear}`);
}

/** The shift messages posted so far, as +1 / −1. */
async function shifts(app: AppHarness): Promise<number[]> {
  return (await app.posted()).filter((m) => m.type === 'shiftUp' || m.type === 'shiftDown').map((m) => (m.type === 'shiftUp' ? 1 : -1));
}

test('Drive in Demo: Start engine → snapshots arrive; rpm and gear change over the demo loop', async ({ app, page }) => {
  await app.open(DEMO);
  await toDrive(app);
  const overlay = page.getByRole('dialog', { name: STR.actions.startEngine });
  await expect(overlay).toContainText(STR.modes.source.demo);
  await expect(app.gear()).toHaveText(STR.drive.none);
  await app.startEngine();

  // The worklet got the start configuration and reports ~30 snapshots a second.
  expect(await app.posted()).toEqual(
    expect.arrayContaining([
      { type: 'engine', id: DEFAULT_ENGINE },
      { type: 'source', value: 'demo' },
      { type: 'gearboxMode', value: 'auto' },
      { type: 'ignition', on: true },
    ]),
  );
  const before = await app.stateCount();
  await page.waitForTimeout(1000);
  expect((await app.stateCount()) - before).toBeGreaterThanOrEqual(20);

  // The demo pulls away: Auto climbs the gears, the readouts follow.
  await app.waitForState((s) => (s[S.gear] ?? 0) >= 3, 30_000, 'Auto reaches 3rd gear on the demo loop');
  await expect(app.gear()).toHaveText(/^[2-7]$/);
  await expect(page.getByLabel(STR.drive.speedLabel)).toHaveText(new RegExp(`^[1-9]\\d*\\s*${STR.units.mph}$`));
  const running = (await app.states()).filter((s) => (s[S.gear] ?? 0) >= 1);
  const gears = new Set(running.map((s) => s[S.gear]));
  for (const g of [1, 2, 3]) expect(gears, `gear ${g} seen`).toContain(g);
  const rpms = running.map((s) => s[S.rpm] ?? 0);
  expect(Math.max(...rpms) - Math.min(...rpms), 'rpm swing').toBeGreaterThan(1000);
  expect(running.some((s) => ((s[S.flags] ?? 0) & F.SHIFTING) !== 0), 'a shift in flight was reported').toBe(true);

  // The mode toggles post to the worklet and persist.
  await app.driveReady();
  await page.getByRole('button', { name: `${STR.drive.driveMode}: ${STR.modes.drive.comfort}` }).click();
  await expect(page.getByRole('button', { name: `${STR.drive.driveMode}: ${STR.modes.drive.sport}` })).toBeVisible();
  await page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.auto}` }).click();
  await expect(page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.open}` })).toBeVisible();
  await page.keyboard.press('KeyV'); // V cycles the valves on to Closed
  await expect(page.getByRole('button', { name: `${STR.valvesLabel}: ${STR.modes.valve.closed}` })).toBeVisible();
  await page.keyboard.press('KeyP'); // P toggles the listening position
  await expect.poll(async () => (await app.stored())?.perspective).toBe('outside');
  expect(await app.stored()).toMatchObject({ driveMode: 'sport', valve: 'closed', perspective: 'outside' });
  expect(await app.posted()).toEqual(
    expect.arrayContaining([
      { type: 'driveMode', value: 'sport' },
      { type: 'valve', mode: 'open' },
      { type: 'valve', mode: 'closed' },
      { type: 'perspective', value: 'outside' },
    ]),
  );
});

test('Manual: paddles and E / Q shift; Media Session nexttrack shifts only with wheel shifting enabled', async ({ app, page }) => {
  await app.open(DEMO);
  await toDrive(app);
  await app.startEngine();
  await app.driveReady();

  // First Manual: the one-time warning (parked only), then Manual.
  await page.getByRole('button', { name: `${STR.drive.gearbox}: ${STR.modes.gearbox.auto}` }).click();
  const warning = page.getByRole('dialog', { name: STR.drive.manualTitle });
  await expect(warning).toContainText(STR.manualWarning);
  await warning.getByRole('button', { name: STR.drive.manualAccept }).click();
  await expect(page.getByRole('button', { name: `${STR.drive.gearbox}: ${STR.modes.gearbox.manual}` })).toBeVisible();
  expect(await app.stored()).toMatchObject({ gearboxMode: 'manual', manualWarningSeen: true });
  expect((await app.posted('gearboxMode')).at(-1)).toEqual({ type: 'gearboxMode', value: 'manual' });

  // Manual holds 1st through the demo pull-away; shift once the car rolls.
  await app.waitForState((s) => (s[S.speedMps] ?? 0) > 7, 20_000, 'the demo car is rolling');
  await settledIn(app, 1);
  await page.getByRole('button', { name: STR.drive.shiftUp }).click(); // + paddle (pointerdown)
  await settledIn(app, 2);
  await page.keyboard.press('KeyE');
  await settledIn(app, 3);
  await page.keyboard.press('KeyQ');
  await settledIn(app, 2);
  await page.getByRole('button', { name: STR.drive.shiftDown }).click(); // − paddle
  await settledIn(app, 1);
  expect(await shifts(app)).toEqual([1, 1, -1, -1]);

  // Wheel shifting is off until the steering-wheel test passes: a tilt does not shift.
  await app.mediaAction('nexttrack');
  await page.waitForTimeout(500);
  await settledIn(app, 1);
  expect(await shifts(app)).toEqual([1, 1, -1, -1]);

  // Settings (parked) → Test steering-wheel shifting: tilt right, then left.
  await page.getByTestId('drive-settings').click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
  await page.getByRole('button', { name: STR.settingsUi.wheelTest }).click();
  await expect(page.getByText(STR.settingsUi.wheelRight)).toBeVisible();
  await app.mediaAction('nexttrack');
  await expect(page.getByText(STR.settingsUi.wheelLeft)).toBeVisible();
  await app.mediaAction('previoustrack');
  await expect(page.getByText(STR.settingsUi.wheelWorks)).toBeVisible();
  const wheelSwitch = page.getByRole('group', { name: STR.settingsUi.wheelEnable, exact: true });
  await expect(wheelSwitch.getByRole('button', { name: STR.settingsUi.on, exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await app.stored())?.wheelShift).toEqual({ tested: true, works: true, enabled: true });
  expect(await shifts(app)).toEqual([1, 1, -1, -1]); // the test itself never shifts

  // Back on Drive: tilt right = upshift. A MediaTrackNext key and a nexttrack action of one tilt count once.
  await page.getByRole('button', { name: STR.actions.drive, exact: true }).click();
  await app.driveReady();
  await settledIn(app, 1);
  await app.mediaAction('nexttrack');
  await settledIn(app, 2);
  await page.waitForTimeout(MEDIA_DEDUPE_MS + 300); // a new tilt, not a second delivery of that one
  await page.keyboard.press('MediaTrackNext');
  await app.mediaAction('nexttrack'); // the same tilt delivered twice (spec §6.2 dedupe, 900 ms)
  await settledIn(app, 3);
  await page.waitForTimeout(300);
  expect(await shifts(app)).toEqual([1, 1, -1, -1, 1, 1]);
  await expect(app.gear()).toHaveText('3');

  // Diagnostics (hold the status dot 700 ms) lists what every input did.
  await app.longPress(page.getByRole('button', { name: new RegExp(STR.drive.statusHold) }));
  await expect(app.screen()).toHaveAttribute('data-screen', 'diagnostics');
  const log = page.locator('section', { has: page.getByRole('heading', { name: STR.diag.inputs }) }).getByRole('listitem');
  const L = STR.diag.log;
  for (const line of [
    `paddle ${L.shiftUp}`,
    `key ${L.via(L.keys.up, L.shiftUp)}`,
    `key ${L.via(L.keys.down, L.shiftDown)}`,
    `paddle ${L.shiftDown}`,
    `media ${L.via('nexttrack', L.wheelOff)}`,
    `media ${L.via('nexttrack', L.wheelTest)}`,
    `media ${L.via('previoustrack', L.wheelTest)}`,
    `media ${L.via('nexttrack', L.shiftUp)}`,
    `key ${L.via('MediaTrackNext', L.shiftUp)}`,
    `media ${L.via('nexttrack', L.duplicate)}`,
  ]) {
    await expect(log.filter({ hasText: new RegExp(`^t=[\\d.]+s ${line}$`) }), line).toHaveCount(1);
  }
  await page.getByRole('button', { name: STR.actions.back, exact: true }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
});
