import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { assertNoCoordinates } from '../../src/probe/summary';

interface CanvasImage {
  width: number;
  height: number;
  b64: string;
}

/** Text of the QR code in an RGBA image (UTF-8 bytes decoded), or an error naming `what`. */
function qrText({ width, height, b64 }: CanvasImage, what: string): string {
  const code = jsQR(new Uint8ClampedArray(Buffer.from(b64, 'base64')), width, height);
  if (code === null) throw new Error(`${what} did not decode`);
  return new TextDecoder().decode(Uint8Array.from(code.binaryData));
}

async function exportedSummary(page: Page): Promise<{ notes: Record<string, string>; logTail: string[] }> {
  return JSON.parse((await page.locator('#summary-json').textContent()) ?? 'null') as {
    notes: Record<string, string>;
    logTail: string[];
  };
}

test('Show QR: every page decodes, chunks reassemble to the summary JSON, no coordinates', async ({ page }) => {
  await page.goto('/probe/');
  await expect(page.locator('#storage-report')).toContainText('Visits');
  await page.locator('#qr-show').click();
  const canvases = page.locator('#qr-list canvas');
  await expect(canvases.first()).toBeVisible();
  await expect(page.locator('#qr-list figcaption').first()).toHaveText(/^QR 1\/\d+$/);

  const images: CanvasImage[] = await canvases.evaluateAll((nodes) =>
    nodes.map((node) => {
      const canvas = node as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('canvas has no 2d context');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { width: canvas.width, height: canvas.height, b64: btoa(binary) };
    }),
  );
  expect(images.length).toBeGreaterThanOrEqual(1);

  const texts = images.map((image, i) => qrText(image, `QR ${i + 1}`));
  expect(texts[0]?.startsWith('TBX 1/')).toBe(true);

  const parts = texts.map((t) => {
    const m = /^TBX (\d+)\/(\d+)\n/.exec(t);
    if (m === null) throw new Error(`missing TBX header: ${t.slice(0, 20)}`);
    return { i: Number(m[1]), n: Number(m[2]), body: t.slice(m[0].length) };
  });
  expect(parts.map((p) => p.i)).toEqual(parts.map((_, i) => i + 1));
  expect(new Set(parts.map((p) => p.n))).toEqual(new Set([parts.length]));

  const summary = JSON.parse(parts.map((p) => p.body).join('')) as { v: number };
  expect(summary.v).toBe(1);
  expect(() => assertNoCoordinates(summary)).not.toThrow(); // T4's guard: case-insensitive, any depth
  expect(summary).toEqual(JSON.parse((await page.locator('#summary-json').textContent()) ?? 'null'));

  if (parts.length > 1) {
    await page.locator('#qr-next').click();
    await expect(page.locator('#qr-list figure').nth(1)).toBeVisible();
    await expect(page.locator('#qr-list figure').first()).toBeHidden();
  }
});

test('every distinct viewport is logged and exported as notes viewport.<n> (C8.3)', async ({ page }) => {
  const resizeTo = async (width: number, height: number): Promise<void> => {
    await page.setViewportSize({ width, height });
    // Resize events fire in the next rendering update, before its animation-frame callbacks.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await page.setViewportSize({ width: 1255, height: 758 }); // parked layout
  await page.goto('/probe/');
  await resizeTo(773, 601); // in-motion layout
  await expect(page.locator('#log-view')).toContainText('note viewport 773x601@1');
  await resizeTo(1255, 758); // seen before: no new entry
  await resizeTo(1000, 700);
  await expect(page.locator('#log-view')).toContainText('note viewport 1000x700@1');

  await page.locator('#qr-show').click();
  const summary = await exportedSummary(page);
  expect(Object.entries(summary.notes).filter(([k]) => k.startsWith('viewport.'))).toEqual([
    ['viewport.1', '1255x758@1'],
    ['viewport.2', '773x601@1'],
    ['viewport.3', '1000x700@1'],
  ]);
  expect(summary.logTail.filter((l) => l.includes(' note viewport ')).map((l) => l.replace(/^t=[\d.]+s /, ''))).toEqual([
    'note viewport 1255x758@1',
    'note viewport 773x601@1',
    'note viewport 1000x700@1',
  ]);
});

test.describe('in-motion layout: 773×601 CSS px at dpr 1.53 (spec §3)', () => {
  test.use({ viewport: { width: 773, height: 601 }, deviceScaleFactor: 1.53 });

  test('a QR code fits the viewport whole and decodes as rendered on screen (C8.1)', async ({ page }) => {
    await page.goto('/probe/');
    await expect(page.locator('#storage-report')).toContainText('Visits');
    await page.locator('#qr-show').click();
    const canvas = page.locator('#qr-list figure:not([hidden]) canvas');
    await expect(canvas).toBeVisible();
    // Scrolled to the middle of the window (where Playwright's minimal scroll would leave it depends on the page above).
    await canvas.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('the QR canvas is not rendered');
    expect(box.width).toBeCloseTo(box.height, 0); // scaled down, not stretched
    expect(box.height).toBeGreaterThan(500); // still as large as the window allows
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(773);
    expect(box.y + box.height).toBeLessThanOrEqual(601);

    // What the phone camera sees: the canvas's on-screen pixels at the car's device pixel ratio.
    const shot = await canvas.screenshot();
    const rendered: CanvasImage = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`; // CSP img-src allows data:
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      if (ctx === null) throw new Error('canvas has no 2d context');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let binary = '';
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { width: c.width, height: c.height, b64: btoa(binary) };
    }, shot.toString('base64'));
    expect(rendered.width).toBeGreaterThan(box.width); // device pixels, not CSS pixels
    expect(qrText(rendered, 'the on-screen QR').startsWith('TBX 1/')).toBe(true);
  });
});
