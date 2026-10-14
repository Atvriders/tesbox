/**
 * Phase-3 acceptance 1 (contract T9): first run — notices → picker (Model 3 Highland → Long Range AWD)
 * → subwoofer → bass sweep → acceleration mode → garage with 15 cards in 4 groups. The sweep's tone
 * steps are observed on the worklet side: the testTone messages it receives and the frequency of what it
 * actually plays.
 */
import { DEFAULT_ENGINE, TESLA_ID, expect, test, STR } from './app-fixtures';

const SWEEP_HZ = [30, 35, 40, 45, 50, 60];
const STEP_MS = 1500;
const LEVEL_DB = -18;

test.describe('first run', () => {
  test.use({ tone: true });

  test('notices → Model 3 Highland Long Range AWD → subwoofer → bass sweep → acceleration mode → garage', async ({ app, page }) => {
    await app.open();
    const firstRun = page.locator('[data-screen="first-run"]');
    await expect(firstRun).toHaveAttribute('data-step', 'notices');
    await expect(firstRun.getByRole('listitem')).toHaveText([...STR.notices]);
    await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
    await expect(firstRun).toHaveAttribute('data-step', 'model');
    expect((await app.stored())?.noticesSeen).toBe(true);

    // Picker: Model → generation (with years) → trim.
    await page.locator('[data-model="Model 3"]').click();
    await expect(firstRun).toHaveAttribute('data-step', 'generation');
    const highland = page.locator('[data-generation="Highland (2023–)"]');
    await expect(highland).toContainText('2023–');
    await highland.click();
    await expect(firstRun).toHaveAttribute('data-step', 'trim');
    const trim = page.locator(`[data-tesla="${TESLA_ID}"]`);
    await expect(trim).toContainText('Long Range AWD');
    await trim.click();

    // Subwoofer: the trim's best guess is pre-selected and labelled.
    await expect(firstRun).toHaveAttribute('data-step', 'subwoofer');
    const yes = page.locator('[data-subwoofer="yes"]');
    await expect(yes).toHaveAttribute('aria-pressed', 'true');
    await expect(yes).toContainText(STR.firstRun.bestGuess);
    await page.locator('[data-subwoofer="no"]').click();
    expect(await app.stored()).toMatchObject({ teslaId: TESLA_ID, subwoofer: 'no' });

    // Bass sweep: Play tones starts the engine from the tap, then six tones of 1.5 s each.
    await expect(firstRun).toHaveAttribute('data-step', 'bass');
    const sweep = page.locator('[data-sweep]');
    await expect(sweep).toHaveAttribute('data-sweep', 'idle');
    const steps = sweep.locator('[data-hz]');
    await expect(steps).toHaveCount(SWEEP_HZ.length);
    for (const step of await steps.all()) await expect(step).toBeDisabled(); // nothing heard yet
    await page.getByRole('button', { name: STR.firstRun.playTones }).click();
    await expect(sweep).toHaveAttribute('data-sweep', 'playing', { timeout: 15_000 });
    await expect(sweep.locator('[aria-current="true"]')).toHaveAttribute('data-hz', String(SWEEP_HZ[0]));
    await expect(sweep).toHaveAttribute('data-sweep', 'done', { timeout: 20_000 });
    for (const step of await steps.all()) await expect(step).toBeEnabled();

    // The worklet received the six steps at −18 dB, 1.5 s apart, then the end of the tone …
    const tap = await app.tap();
    const tones = tap.posted.filter((p) => p.msg.type === 'testTone');
    expect(tones.map((p) => p.msg.hz)).toEqual([...SWEEP_HZ, null]);
    for (const p of tones) expect(p.msg.levelDb).toBe(LEVEL_DB);
    for (let i = 1; i < tones.length; i++) {
      const gap = (tones[i]?.t ?? 0) - (tones[i - 1]?.t ?? 0);
      expect(gap, `step ${i}`).toBeGreaterThan(STEP_MS - 200);
      expect(gap, `step ${i}`).toBeLessThan(STEP_MS + 400);
    }
    // … and played each one: a clean sine at the step's frequency fills the middle of its 1.5 s.
    for (const [i, hz] of SWEEP_HZ.entries()) {
      const at = tones[i]?.t ?? 0;
      const readings = tap.tones.filter((r) => r.t >= at + 450 && r.t <= at + STEP_MS - 200);
      expect(readings.length, `${hz} Hz readings`).toBeGreaterThanOrEqual(5);
      const clean = readings.filter((r) => r.hz !== null && Math.abs(r.hz - hz) < 0.5 && (r.spread ?? 1) < 0.02);
      expect(clean.length, `${hz} Hz played: ${JSON.stringify(readings.map((r) => r.hz))}`).toBeGreaterThanOrEqual(
        readings.length - 1,
      );
    }

    // The lowest clean step becomes the high-pass corner; the running engine gets it at once.
    await sweep.locator('[data-hz="45"]').click();
    expect((await app.stored())?.hpCornerHz).toBe(45);
    await expect
      .poll(async () => (await app.posted('output')).at(-1))
      .toEqual({ type: 'output', config: { subwoofer: 'no', hpCornerHz: 45, volumeTrimDb: 0 } });

    // Acceleration mode: the car's modes, the quickest pre-selected.
    await expect(firstRun).toHaveAttribute('data-step', 'accel');
    const modes = firstRun.locator('[data-mode]');
    await expect(modes).toHaveText(['Chill', 'Standard']);
    await expect(page.locator('[data-mode="Standard"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-mode="Chill"]').click();

    // Garage: 15 engines in Euro / JDM / American / Exotic, each card with Preview and Drive.
    await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
    const groups = page.locator('section[data-set]');
    await expect(groups).toHaveCount(4);
    await expect(groups.getByRole('heading', { level: 2 })).toHaveText(['Euro', 'JDM', 'American', 'Exotic']);
    const cards = page.locator('article[data-engine]');
    await expect(cards).toHaveCount(15);
    for (const group of await groups.all()) expect(await group.locator('article[data-engine]').count()).toBeGreaterThan(0);
    for (const card of await cards.all()) {
      await expect(card.getByRole('heading', { level: 3 })).not.toBeEmpty();
      await expect(card).toContainText('inspired by ');
      await expect(card.locator('[data-action="preview"]')).toBeVisible();
      await expect(card.locator('[data-action="drive"]')).toBeVisible();
    }
    await expect(page.locator(`article[data-engine="${DEFAULT_ENGINE}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText(STR.disclaimer)).toBeVisible();

    expect(await app.stored()).toMatchObject({
      teslaId: TESLA_ID,
      subwoofer: 'no',
      hpCornerHz: 45,
      accelMode: 'Chill',
      noticesSeen: true,
    });
    // The sweep left the engine running (as a garage Preview does): Stop engine stops it.
    await page.getByRole('button', { name: STR.actions.stopEngine }).click();
    await expect(page.getByRole('button', { name: STR.actions.stopEngine })).toBeHidden({ timeout: 10_000 });
    expect((await app.posted('ignition')).at(-1)).toEqual({ type: 'ignition', on: false });
  });

  test('Back retraces the picker; Skip keeps the 40 Hz corner', async ({ app, page }) => {
    await app.open();
    const firstRun = page.locator('[data-screen="first-run"]');
    await page.getByRole('button', { name: STR.actions.ok, exact: true }).click();
    await page.locator('[data-model="Model 3"]').click();
    await page.locator('[data-generation="Highland (2023–)"]').click();
    await expect(firstRun).toHaveAttribute('data-step', 'trim');
    await page.getByRole('button', { name: STR.actions.back }).click();
    await expect(firstRun).toHaveAttribute('data-step', 'generation');
    await page.getByRole('button', { name: STR.actions.back }).click();
    await expect(firstRun).toHaveAttribute('data-step', 'model');
    await expect(page.getByRole('button', { name: STR.actions.back })).toBeHidden(); // the notices are not a step back

    await page.locator('[data-model="Model 3"]').click();
    await page.locator('[data-generation="Highland (2023–)"]').click();
    await page.locator(`[data-tesla="${TESLA_ID}"]`).click();
    await page.locator('[data-subwoofer="unsure"]').click();
    await expect(firstRun).toHaveAttribute('data-step', 'bass');
    await page.getByRole('button', { name: STR.actions.skip }).click();
    await expect(firstRun).toHaveAttribute('data-step', 'accel');
    await page.locator('[data-mode="Standard"]').click();
    await expect(app.screen()).toHaveAttribute('data-screen', 'garage');
    expect(await app.stored()).toMatchObject({ teslaId: TESLA_ID, subwoofer: 'unsure', hpCornerHz: 40, accelMode: 'Standard' });
    expect(await app.posted()).toEqual([]); // nothing started the engine
  });
});
