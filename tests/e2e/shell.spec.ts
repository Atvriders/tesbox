import { expect, test } from '@playwright/test';

test('index boots: #unsupported hidden, build SHA shown, no CSP violations', async ({ page, request }) => {
  const res = await request.get('/version.json');
  expect(res.ok()).toBe(true);
  const { sha } = (await res.json()) as { sha: string };
  expect(sha.length).toBeGreaterThan(0);

  const cspErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  await expect(page.locator('#unsupported')).toBeHidden();
  await expect(page.locator('body')).toContainText(sha);
  expect(cspErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('probe page loads all sections without CSP violations or page errors', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/probe/');
  for (const id of ['build', 'env', 'audio', 'gps', 'inputs', 'storage', 'export']) {
    await expect(page.locator(`section#${id} > h2`)).toBeVisible();
  }
  await expect(page.locator('#storage-report')).toContainText('Visits');
  expect(cspErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('probe still loads when localStorage and Cache Storage throw (RF5)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  // Sandboxed / storage-blocked contexts: both getters throw SecurityError.
  await page.addInitScript(() => {
    const deny = (): never => {
      throw new DOMException('denied', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: deny });
    Object.defineProperty(window, 'caches', { configurable: true, get: deny });
  });
  await page.goto('/probe/');
  await expect(page.locator('#storage-report')).toContainText('localStorage: unavailable');
  await expect(page.locator('#storage-report')).toContainText('cacheStorage: SecurityError');
  expect(pageErrors).toEqual([]);
});
