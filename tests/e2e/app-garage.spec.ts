/**
 * Garage Preview (contract T7, spec §10.2 item 3): Preview selects the engine, starts it from the tap,
 * revs it live on the keyboard speed source for 1.5 s, lifts and brakes, and puts the selected speed
 * source back; the engine keeps running until Stop engine.
 */
import { PICKED, S, STR, expect, test } from './app-fixtures';

const ENGINE = 'v8-na-50';

test('Preview starts the engine from the tap, revs it on the keyboard source, then restores the source', async ({ app, page }) => {
  await app.open(PICKED); // speed source GPS; location denied, so the browser counts as parked
  const card = page.locator(`article[data-engine="${ENGINE}"]`);
  const preview = card.locator('[data-action="preview"]');
  await expect(preview).toHaveText(STR.actions.preview);
  await preview.click();
  await expect(card).toHaveAttribute('aria-current', 'true'); // selected at once
  await expect(preview).toHaveText(STR.garage.previewing);
  for (const other of await page.locator(`article[data-engine]:not([data-engine="${ENGINE}"]) [data-action="preview"]`).all()) {
    await expect(other).toBeDisabled(); // one preview at a time
  }

  // The rev: keyboard source, full throttle for 1.5 s, then lift and brake, then the GPS source back.
  await expect(preview).toHaveText(STR.actions.preview, { timeout: 20_000 });
  const posted = await app.posted();
  expect(posted.find((m) => m.type === 'engine')).toEqual({ type: 'engine', id: ENGINE });
  const sequence = posted.filter((m) => m.type === 'source' || m.type === 'pedal');
  expect(sequence.slice(-5)).toEqual([
    { type: 'source', value: 'keyboard' },
    { type: 'pedal', throttle: 1, brake: 0 },
    { type: 'pedal', throttle: 0, brake: 1 },
    { type: 'source', value: 'gps' },
    { type: 'pedal', throttle: 0, brake: 0 },
  ]);
  const running = (await app.states()).filter((s) => (s[S.gear] ?? 0) >= 1);
  const rpms = running.map((s) => s[S.rpm] ?? 0);
  expect(Math.max(...rpms) - Math.min(...rpms), 'the rev').toBeGreaterThan(1500);
  expect((await app.stored())?.engineId).toBe(ENGINE);
  expect((await app.stored())?.source).toBe('gps'); // the preview never changes the setting

  // The engine keeps running after a preview; Stop engine stops it.
  const stop = page.getByRole('button', { name: STR.actions.stopEngine });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 10_000 });
  expect((await app.posted('ignition')).at(-1)).toEqual({ type: 'ignition', on: false });
});
