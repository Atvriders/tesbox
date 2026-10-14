/**
 * Phase-3 acceptance 5 (contract T9; spec §3, §7.1, §10.1): at the Tesla layouts — 773×601 @1.53
 * (in-motion / split view, the design target), 1255×758 @1.53 (parked), 1306×735 @1.96 (16"),
 * 1410×833 @1.56 and 2200×1300 @1.0 (S/X) — every button, paddle, toggle and input is at least
 * minTouchCssPx(devicePixelRatio) in both dimensions (≥ 22 mm on any panel), no screen scrolls
 * sideways, and Drive fits the window without scrolling, every control inside it.
 */
import type { Page } from '@playwright/test';
import { minTouchCssPx } from '../../src/contracts';
import { PICKED, STR, TESLA_ID, expect, test, type AppHarness } from './app-fixtures';

const VIEWPORTS = [
  { width: 773, height: 601, dpr: 1.53 },
  { width: 1255, height: 758, dpr: 1.53 },
  { width: 1306, height: 735, dpr: 1.96 },
  { width: 1410, height: 833, dpr: 1.56 },
  { width: 2200, height: 1300, dpr: 1.0 },
] as const;

interface Box {
  what: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every rendered control of the page: buttons, inputs and selects (also those under an overlay). */
async function controls(page: Page): Promise<Box[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="button"]')]
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const r = el.getBoundingClientRect();
        const what = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
        return { what, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );
}

/** Controls of the current screen smaller than the touch minimum, as "what w×h". */
async function undersized(page: Page, min: number): Promise<string[]> {
  return (await controls(page))
    .filter((b) => b.w < min - 0.01 || b.h < min - 0.01)
    .map((b) => `${b.what} ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
}

async function scrollSize(page: Page): Promise<{ sw: number; sh: number; cw: number; ch: number }> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return { sw: d.scrollWidth, sh: d.scrollHeight, cw: d.clientWidth, ch: d.clientHeight };
  });
}

/** The screen's controls are all ≥ min and nothing scrolls sideways. */
async function checkScreen(app: AppHarness, screen: string, min: number): Promise<void> {
  const page = app.page;
  await expect(app.screen()).toHaveAttribute('data-screen', screen);
  expect(await undersized(page, min), `${screen}: controls under ${min} CSS px`).toEqual([]);
  const s = await scrollSize(page);
  expect(s.sw, `${screen}: no horizontal scroll`).toBeLessThanOrEqual(s.cw);
}

/** Drive: no scroll either way, and every control (and the readouts) inside the window. */
async function checkDriveFits(app: AppHarness, min: number, label: string): Promise<void> {
  const page = app.page;
  await checkScreen(app, 'drive', min);
  const s = await scrollSize(page);
  expect(s.sh, `${label}: Drive does not scroll`).toBeLessThanOrEqual(s.ch);
  const win = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const outside = (await controls(page))
    .filter((b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > win.w + 0.5 || b.y + b.h > win.h + 0.5)
    .map((b) => `${b.what} at ${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.w.toFixed(0)}×${b.h.toFixed(0)}`);
  expect(outside, `${label}: controls outside the window`).toEqual([]);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}×${vp.height} @${vp.dpr}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });

    test(`touch targets ≥ ${minTouchCssPx(vp.dpr)} CSS px, no sideways scroll, Drive fits`, async ({ app, page }) => {
      await app.open();
      const dpr = await page.evaluate(() => devicePixelRatio); // a float32: 1.53 reads 1.5299999713897705
      expect(dpr).toBeCloseTo(vp.dpr, 5);
      const min = minTouchCssPx(dpr);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--touch').trim())).toBe(`${min}px`);
      await checkScreen(app, 'first-run', min); // the notices
      await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
      await checkScreen(app, 'first-run', min); // the model choices

      await app.open(PICKED); // speed source GPS, location denied: the Start overlay carries the banner
      await checkScreen(app, 'garage', min);
      await page.locator('article[data-engine] [data-action="drive"]').first().click();
      const overlay = page.getByRole('dialog', { name: STR.actions.startEngine });
      await expect(overlay.getByRole('alert')).toBeVisible();
      await checkDriveFits(app, min, 'Start overlay with the location banner');

      await overlay.getByRole('button', { name: STR.actions.useDemo }).click();
      await app.startEngine();
      await checkDriveFits(app, min, 'running');
      for (const readout of [app.gear(), page.getByLabel(STR.drive.speedLabel)]) {
        const box = await readout.boundingBox();
        expect(box, 'readout rendered').not.toBeNull();
        if (box !== null) {
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
        }
      }

      await page.getByTestId('drive-settings').click();
      await page.getByRole('button', { name: STR.settingsUi.showAdvanced }).click();
      await checkScreen(app, 'settings', min);
      await page.getByRole('button', { name: STR.actions.diagnostics, exact: true }).click();
      await checkScreen(app, 'diagnostics', min);

      // The picker again (Settings → Change Tesla): the trims and the six bass-sweep steps in one row.
      await page.getByRole('button', { name: STR.actions.back, exact: true }).click();
      await page.getByRole('button', { name: STR.settingsUi.changeTesla }).click();
      await page.locator('[data-model="Model 3"]').click();
      await page.locator('[data-generation="Highland (2023–)"]').click();
      await checkScreen(app, 'first-run', min); // the trims
      await page.locator(`[data-tesla="${TESLA_ID}"]`).click();
      await page.locator('[data-subwoofer="unsure"]').click();
      await expect(page.locator('[data-screen="first-run"]')).toHaveAttribute('data-step', 'bass');
      await checkScreen(app, 'first-run', min);
      const steps = await page.locator('[data-hz]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
      expect(new Set(steps).size, 'the six steps share one row').toBe(1);
    });
  });
}
