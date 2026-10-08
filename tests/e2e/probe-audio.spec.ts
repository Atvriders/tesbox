import { expect, test, type Page } from '@playwright/test';

const ROUTES = ['direct', 'media-element', 'direct-anchor'] as const;

async function quanta(page: Page): Promise<number> {
  return Number((await page.locator('#audio-quanta').textContent()) ?? '0');
}

test('Start audio runs the worklet, every route keeps it running, quick benchmark finishes', async ({ page }) => {
  await page.goto('/probe/?quickbench=1');
  await page.locator('#audio-start').click();
  // Contract: Start audio → worklet quanta > 0 within 3 s (planning measured 0.6–2.3 s from the click).
  await expect.poll(() => quanta(page), { timeout: 3_000 }).toBeGreaterThan(0);
  await expect(page.locator('#audio-state')).toHaveText('running');

  for (const route of ROUTES) {
    await page.locator(`input[name="route"][value="${route}"]`).check();
    await expect(page.locator('#audio-route')).toHaveText(route);
    const before = await quanta(page);
    await expect.poll(() => quanta(page), { timeout: 3_000 }).toBeGreaterThan(before);
  }

  await page.locator('#audio-bench').click();
  await expect(page.locator('#bench-results tbody tr')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('#bench-status')).toContainText('headroom k =');
});

test('observation buttons record answers for the selected route', async ({ page }) => {
  await page.goto('/probe/');
  await page.locator('input[name="route"][value="media-element"]').check();
  await expect(page.locator('#obs-route')).toHaveText('media-element');
  const yes = page.locator('#observations button[data-q="miniplayer"][data-v="yes"]');
  await yes.click();
  await expect(yes).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#observations button[data-q="miniplayer"][data-v="no"]')).toHaveAttribute('aria-pressed', 'false');
});

test('export keeps both latencyHint benchmark legs, per-route latency and the snapshot taken at Stop', async ({ page }) => {
  await page.goto('/probe/?quickbench=1');
  for (const hint of ['balanced', 'playback'] as const) {
    await page.locator(`input[name="latency"][value="${hint}"]`).check();
    await page.locator('#audio-start').click();
    await expect(page.locator('#audio-state')).toHaveText('running');
    await page.locator('#audio-bench').click();
    await expect(page.locator('#bench-status')).toContainText('headroom k =', { timeout: 15_000 });
    await page.locator('#audio-stop').click();
    await expect(page.locator('#audio-state')).toHaveText('none');
  }
  await page.locator('#qr-show').click();
  const summary = JSON.parse((await page.locator('#summary-json').textContent()) ?? 'null') as {
    audio: { state: string; latencyHint: string; bench: unknown[] } | null;
    notes: Record<string, string>;
  };
  expect(Object.keys(summary.notes)).toEqual(
    expect.arrayContaining(['bench.balanced', 'bench.playback', 'latency.direct-anchor']),
  );
  // Recorded only once Chromium has measured the output latency (it reads 0 right after start).
  expect(summary.notes['latency.direct-anchor']).not.toMatch(/ out=0 /);
  expect(summary.audio?.state).toBe('running'); // stop() empties the live snapshot; the export uses the one taken at Stop
  expect(summary.audio?.latencyHint).toBe('playback');
  expect(summary.audio?.bench).toHaveLength(2);
  // C8.2: audio events since load (two clean start/stop cycles: no pauses, no errors).
  expect(summary.notes['audio.events']).toMatch(/^stateChanges=\d+ elementPauses=0 errors=0$/);
});

test('a failed Start audio is counted in the exported audio.events (C8.2)', async ({ page }) => {
  await page.addInitScript(() => {
    // A car browser whose AudioContext constructor throws: only the page itself logs the failure.
    window.AudioContext = class {
      constructor() {
        throw new DOMException('no output device', 'NotSupportedError');
      }
    } as unknown as typeof AudioContext;
  });
  await page.goto('/probe/');
  await page.locator('#audio-start').click();
  await expect(page.locator('#audio-status')).toHaveText('audio start: NotSupportedError: no output device');
  await page.locator('#qr-show').click();
  const summary = JSON.parse((await page.locator('#summary-json').textContent()) ?? 'null') as {
    notes: Record<string, string>;
  };
  expect(summary.notes['audio.events']).toBe('stateChanges=0 elementPauses=0 errors=1');
});
