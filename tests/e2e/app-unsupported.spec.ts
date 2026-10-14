/**
 * Phase-3 acceptance 6 (contract T9; spec §6.5, §10.2 item 1): a browser without AudioWorkletNode (or
 * without AudioContext) gets the static Unsupported block with the reason — shown by both the classic
 * public/unsupported.js and the module entry — and no app.
 */
import { STR, expect, test } from './app-fixtures';

for (const [global, reason] of [
  ['AudioWorkletNode', STR.unsupported.noAudioWorklet],
  ['AudioContext', STR.unsupported.noAudioContext],
] as const) {
  test(`${global} deleted before load → #unsupported with the reason, no app`, async ({ app, page }) => {
    await page.addInitScript((name) => {
      const w = window as unknown as Record<string, unknown>;
      delete w[name];
      if (name === 'AudioContext') delete w.webkitAudioContext;
    }, global);
    await app.open();
    const box = page.locator('#unsupported');
    await expect(box).toBeVisible();
    await expect(page.locator('#unsupported-reason')).toHaveText(reason);
    await expect(box).toContainText('Not affiliated with Tesla, Inc.');
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.locator('#app > *')).toHaveCount(0); // the module never mounted the app
  });
}

test('a supported browser hides #unsupported once the app has booted', async ({ app, page }) => {
  await app.open();
  await expect(app.screen()).toHaveAttribute('data-screen', 'first-run');
  await expect(page.locator('#unsupported')).toBeHidden();
});
