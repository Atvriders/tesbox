import { expect, test } from '@playwright/test';
import { CSP, IMMUTABLE, NO_STORE, NO_STORE_PATHS } from '../../deploy/csp';

// Header assertions target the nginx container (CI sets E2E_BASE_URL); vite preview is not nginx.
test.skip(!process.env.E2E_BASE_URL, 'set E2E_BASE_URL to a running container to check headers');

test('CSP and security headers on / and /probe/', async ({ request }) => {
  for (const path of ['/', '/probe/']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    expect(h['content-security-policy'], path).toBe(CSP);
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBe('no-referrer');
  }
});

test('no-store, no-transform on every NO_STORE_PATH', async ({ request }) => {
  for (const path of NO_STORE_PATHS) {
    const res = await request.get(path);
    expect(res.headers()['cache-control'], path).toBe(NO_STORE);
  }
});

test('hashed assets are immutable and served as JavaScript', async ({ request }) => {
  const html = await (await request.get('/index.html')).text();
  const asset = /\/assets\/[^"']+\.js/.exec(html)?.[0];
  expect(asset, 'an /assets/*.js reference in index.html').toBeDefined();
  const res = await request.get(asset ?? '');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe(IMMUTABLE);
  expect(res.headers()['content-type']).toContain('javascript');
});

test('/probe redirects to /probe/ with a relative Location', async ({ request }) => {
  const res = await request.get('/probe?b=test', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers()['location']).toBe('/probe/?b=test');
});

// The Sound Lab page is served exactly like the probe page (phase-2c contract L1); NO_STORE_PATHS lists it too.
test('/lab/ carries the CSP and security headers, no-store, and serves the lab page', async ({ request }) => {
  const res = await request.get('/lab/');
  expect(res.status()).toBe(200);
  const h = res.headers();
  expect(h['content-security-policy']).toBe(CSP);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cache-control']).toBe(NO_STORE);
  expect(await res.text()).toContain('<title>Tesbox Sound Lab</title>');
});

test('/lab redirects to /lab/ with a relative Location', async ({ request }) => {
  const res = await request.get('/lab?b=test', { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers()['location']).toBe('/lab/?b=test');
});
