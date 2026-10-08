import { expect, test } from '@playwright/test';

// Fake positions only: a straight line north from 0,0 (spec: no real coordinates anywhere).
test.use({ permissions: ['geolocation'], geolocation: { latitude: 0, longitude: 0, accuracy: 5 } });

test('a 4 s poll run collects fixes and shows a summary row', async ({ page, context }) => {
  await page.goto('/probe/?gpsSeconds=4');
  await expect(page.locator('#gps-seconds')).toHaveText('4');
  await page.locator('#gps-run-poll-hiacc-off').click();
  await expect(page.locator('#gps-live')).toContainText('poll-hiacc-off');

  for (let i = 1; i <= 10; i++) {
    await page.waitForTimeout(500);
    await context.setGeolocation({ latitude: i * 0.0001, longitude: 0, accuracy: 5 });
  }

  const row = page.locator('#gps-results tbody tr[data-mode="poll-hiacc-off"]');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  expect(Number(await row.getAttribute('data-fixes'))).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#gps-live')).toHaveText('idle');
});

test('a reload during a GPS run shows the crash banner once (RF2)', async ({ page }) => {
  await page.goto('/probe/?gpsSeconds=60');
  await page.locator('#gps-run-watch-hiacc-on').click();
  await expect(page.locator('#gps-live')).toContainText('watch-hiacc-on');
  await page.reload(); // the run never finishes: its crash marker stays in localStorage
  await expect(page.locator('#gps-crash')).toBeVisible();
  await expect(page.locator('#gps-crash')).toContainText('watch-hiacc-on');
  await page.reload(); // previousCrash() consumed the marker on the previous load
  await expect(page.locator('#gps-crash')).toBeHidden();
});
