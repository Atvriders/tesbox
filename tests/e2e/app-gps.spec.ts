/**
 * Phase-3 acceptance 4 (contract T9; spec §6.5, §10.1): geolocation denied → the blocking banner with
 * **Use Demo**, which works; Settings locked while the real GPS says the car moves (a fake GPS at 20 m/s)
 * and unlocked once it is parked again, whatever the selected speed source. Also the privacy rule end to
 * end: with fixes flowing to the worklet, the Diagnostics QR export carries statistics only.
 *
 * Fake positions only, around 0, 0 (spec: no real coordinates anywhere).
 */
import jsQR from 'jsqr';
import { assertNoCoordinates } from '../../src/probe/summary';
import { DEFAULT_ENGINE, PICKED, S, STR, expect, test, type AppHarness } from './app-fixtures';

async function toDrive(app: AppHarness): Promise<void> {
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await app.page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
}

function statusDot(app: AppHarness) {
  return app.page.getByRole('button', { name: new RegExp(STR.drive.statusHold) });
}

test('geolocation denied: the blocking banner offers Use Demo, which drives the engine', async ({ app, page }) => {
  await app.open(PICKED); // speed source GPS (the default); this browser denies the permission
  await toDrive(app);
  const overlay = page.getByRole('dialog', { name: STR.actions.startEngine });
  await expect(overlay.getByRole('alert')).toContainText(STR.geoDenied);
  await expect(overlay).toContainText(STR.modes.source.gps);

  // Started anyway on GPS: the banner stays on top of Drive and the status dot names the problem.
  await page.getByRole('button', { name: STR.actions.startEngine, exact: true }).click();
  await expect(overlay).toBeHidden({ timeout: 15_000 });
  const banner = page.getByRole('alert').filter({ hasText: STR.geoDenied });
  await expect(banner).toBeVisible();
  await expect(statusDot(app)).toHaveAttribute('data-level', 'bad');
  await expect(statusDot(app)).toHaveAttribute('aria-label', new RegExp(STR.drive.reasons.gpsDenied));
  // The first worklet snapshot can follow 'running' by about a second (the audio device starting up).
  const first = await app.waitForState(() => true, 10_000, 'a first worklet snapshot');
  expect(first[S.speedMps]).toBe(0);

  await banner.getByRole('button', { name: STR.actions.useDemo }).click();
  await expect(banner).toBeHidden();
  expect((await app.stored())?.source).toBe('demo');
  await expect.poll(async () => (await app.posted('source')).at(-1)).toEqual({ type: 'source', value: 'demo' });
  await app.waitForState((s) => (s[S.speedMps] ?? 0) > 2, 20_000, 'the demo drives the car');
  await expect(statusDot(app)).not.toHaveAttribute('aria-label', new RegExp(STR.drive.reasons.gpsDenied));
  await expect(page.getByLabel(STR.drive.speedLabel)).toHaveText(new RegExp(`^[1-9]\\d*\\s*${STR.units.mph}$`));
});

test.describe('with location permitted', () => {
  test.use({ permissions: ['geolocation'] });

  test('Settings are locked while the GPS says 20 m/s and unlocked when parked, whatever the source', async ({ app, page }) => {
    const gps = await app.fakeGps();
    await app.open({ ...PICKED, source: 'demo' });
    const previewBanner = page.getByText(STR.garage.previewParkedOnly);
    await expect(previewBanner).toBeHidden({ timeout: 10_000 }); // parked: 2 s of fixes standing still

    await toDrive(app);
    const overlay = page.getByRole('dialog', { name: STR.actions.startEngine });
    const overlaySettings = overlay.getByRole('button', { name: STR.actions.settings });
    await expect(overlaySettings).toBeEnabled();
    await expect(page.getByTestId('drive-settings')).toBeEnabled();
    await overlaySettings.click();
    await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
    const body = page.locator('fieldset');
    const kmh = page.getByRole('group', { name: STR.settingsUi.units, exact: true }).getByRole('button', { name: STR.units.kmh });
    await expect(body).toHaveJSProperty('disabled', false);
    await expect(page.getByText(STR.readOnlyWhileMoving)).toBeHidden();

    // Moving: the whole screen turns read-only at the next fix.
    await gps.drive(20);
    await expect(page.getByText(STR.readOnlyWhileMoving)).toBeVisible({ timeout: 10_000 });
    await expect(body).toHaveJSProperty('disabled', true); // every setting inside is disabled with it
    await expect(kmh).toBeDisabled();
    // Drive (not locked) still navigates; its Settings buttons are locked, and so is the garage Preview.
    await page.getByRole('button', { name: STR.actions.drive, exact: true }).click();
    await expect(overlaySettings).toBeDisabled();
    await expect(page.getByTestId('drive-settings')).toBeDisabled();
    await overlay.getByRole('button', { name: STR.drive.garage }).click();
    await expect(previewBanner).toBeVisible();
    for (const preview of await page.locator('[data-action="preview"]').all()) await expect(preview).toBeDisabled();
    await toDrive(app);

    // Parked again (2 s standing still): unlocked.
    await gps.drive(0);
    await expect(overlaySettings).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId('drive-settings')).toBeEnabled();
    await overlaySettings.click();
    await expect(body).toHaveJSProperty('disabled', false);
    await expect(page.getByText(STR.readOnlyWhileMoving)).toBeHidden();
    await kmh.click();
    await expect(kmh).toHaveAttribute('aria-pressed', 'true');
    expect((await app.stored())?.units).toBe('kmh');
  });

  test('fixes reach the worklet; the Diagnostics QR export holds statistics only, never coordinates', async ({ app, page }) => {
    const gps = await app.fakeGps({ latitude: 0.0123456, longitude: 0.0654321 });
    await app.open(PICKED); // speed source GPS
    await toDrive(app);
    await app.startEngine();
    await gps.drive(3);
    await expect.poll(async () => (await app.posted('fix')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await app.waitForState((s) => (s[S.fixesAccepted] ?? 0) >= 2, 10_000, 'the worklet accepted fixes');

    await app.longPress(page.getByRole('button', { name: new RegExp(STR.drive.statusHold) }));
    await expect(app.screen()).toHaveAttribute('data-screen', 'diagnostics');
    await page.getByRole('button', { name: STR.actions.showQr }).click();
    const modal = page.getByRole('dialog', { name: STR.diag.qrTitle });
    const title = modal.getByRole('heading', { level: 2 });
    await expect(title).toHaveText(/^QR 1\/\d+$/);
    const pages = Number(/\/(\d+)$/.exec((await title.textContent()) ?? '')?.[1]);
    expect(pages).toBeGreaterThanOrEqual(1);

    const texts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      await expect(title).toHaveText(STR.diag.qrPage(i, pages));
      let text = '';
      await expect
        .poll(async () => {
          text = await decodeCanvas(modal.locator('canvas'));
          return text.startsWith(`TBX ${i}/${pages}\n`);
        })
        .toBe(true);
      texts.push(text.slice(text.indexOf('\n') + 1));
      if (i < pages) await modal.getByRole('button', { name: STR.diag.next }).click();
    }
    const json = texts.join('');
    const summary = JSON.parse(json) as {
      v: number;
      settings: { source: string };
      gps: { status: string };
      snapshot: { fixesAccepted: number | null };
      counters: { snapshots: number };
    };
    expect(summary.v).toBe(1);
    expect(() => assertNoCoordinates(summary)).not.toThrow();
    expect(json).not.toMatch(/0\.0123|0\.0654|\b123456\b|\b654321\b/); // the fake position, in any form
    expect(summary.settings.source).toBe('gps');
    expect(summary.gps.status).toBe('ok');
    expect(summary.snapshot.fixesAccepted).toBeGreaterThanOrEqual(2);
    expect(summary.counters.snapshots).toBeGreaterThan(0);
    await modal.getByRole('button', { name: STR.diag.close }).click();
    await expect(modal).toBeHidden();
  });
});

/** The QR code drawn on `canvas` (its backing store), decoded as UTF-8 text; '' when it does not decode. */
async function decodeCanvas(canvas: ReturnType<AppHarness['page']['locator']>): Promise<string> {
  const image = await canvas.evaluate((node) => {
    const c = node as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (ctx === null || c.width === 0) return null;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { width: c.width, height: c.height, b64: btoa(binary) };
  });
  if (image === null) return '';
  const code = jsQR(new Uint8ClampedArray(Buffer.from(image.b64, 'base64')), image.width, image.height);
  return code === null ? '' : new TextDecoder().decode(Uint8Array.from(code.binaryData));
}
