/**
 * Phase-3 acceptance 7 (contract T9): the probe still loads at /probe/ next to the app, and every app
 * screen — first run, garage, Drive, Settings, Diagnostics and its QR — renders with zero CSP violations
 * and no page or console errors (the harness checks both after each test). Also spec §6.5: an audio start
 * that fails stays on screen with the error and a Try again.
 */
import { DEFAULT_ENGINE, PICKED, STR, TESLA_ID, expect, test } from './app-fixtures';

test('the probe still loads at /probe/ beside the app', async ({ app, page }) => {
  await app.open();
  await expect(app.screen()).toHaveAttribute('data-screen', 'first-run');
  await page.goto('/probe/');
  for (const id of ['build', 'env', 'audio', 'gps', 'inputs', 'storage', 'export']) {
    await expect(page.locator(`section#${id} > h2`)).toBeVisible();
  }
  await expect(page.locator('#storage-report')).toContainText('Visits');
  await page.goto('/');
  await expect(app.screen()).toHaveAttribute('data-screen', 'first-run');
});

test('every screen renders CSP-clean: first run → garage → Drive → Settings → Diagnostics → QR', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#build-sha')).toContainText('Build ');
  await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
  await page.locator('[data-model="Model 3"]').click();
  await page.locator('[data-generation="Highland (2023–)"]').click();
  await page.locator(`[data-tesla="${TESLA_ID}"]`).click();
  await page.locator('[data-subwoofer="yes"]').click();
  await page.getByRole('button', { name: STR.actions.skip }).click();
  await page.locator('[data-mode="Standard"]').click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');

  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
  await expect(page.locator('#build-sha')).toBeHidden(); // Drive is full-screen: no footer
  await page.getByRole('alert').getByRole('button', { name: STR.actions.useDemo }).click();
  await app.startEngine();

  await page.getByTestId('drive-settings').click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
  await page.getByRole('button', { name: STR.settingsUi.showAdvanced }).click();
  await expect(page.getByRole('button', { name: STR.settingsUi.reset })).toBeVisible();
  // Spec §10.2 item 6: holding the Settings title opens Diagnostics too.
  await app.longPress(page.getByRole('heading', { name: STR.screens.settings, level: 1 }));
  await expect(app.screen()).toHaveAttribute('data-screen', 'diagnostics');
  for (const panel of [STR.diag.engine, STR.diag.gps, STR.diag.audio, STR.diag.counters, STR.diag.platform, STR.diag.inputs]) {
    await expect(page.getByRole('heading', { name: panel, exact: true, level: 2 })).toBeVisible();
  }
  await expect(page.getByText(STR.audioStates.running, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: STR.actions.showQr }).click();
  const modal = page.getByRole('dialog', { name: STR.diag.qrTitle });
  await expect(modal.getByRole('heading', { level: 2 })).toHaveText(/^QR 1\/\d+$/);
  await expect(modal.locator('canvas')).toBeVisible();
  await modal.getByRole('button', { name: STR.diag.close }).click();
  await page.getByRole('button', { name: STR.actions.back, exact: true }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'settings');
  await page.getByRole('button', { name: STR.actions.drive, exact: true }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'drive');
});

test('an audio start that fails stays on screen with the error and Try again (spec §6.5)', async ({ app, page }) => {
  await page.addInitScript(() => {
    // A car browser whose AudioContext constructor throws (no output device); AudioWorkletNode stays.
    window.AudioContext = class {
      constructor() {
        throw new DOMException('no output device', 'NotSupportedError');
      }
    } as unknown as typeof AudioContext;
  });
  await app.open({ ...PICKED, source: 'demo' });
  await page.locator(`article[data-engine="${DEFAULT_ENGINE}"] [data-action="drive"]`).click();
  await page.getByRole('button', { name: STR.actions.startEngine, exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: STR.audioFailed('NotSupportedError: no output device') });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: STR.actions.tryAgain })).toBeVisible();
  await expect(page.getByRole('dialog', { name: STR.actions.startEngine })).toBeVisible(); // Start engine is still offered
  await page.locator('[data-screen="drive"]').getByRole('button', { name: STR.drive.garage }).click();
  await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
  await expect(alert).toBeVisible(); // over every screen until the next start
});
