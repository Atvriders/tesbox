import { expect, test } from '@playwright/test';

// This Chromium exposes DeviceMotionEvent.requestPermission(): without these it answers "denied".
test.use({ permissions: ['accelerometer', 'gyroscope'] });

test('?motionSeconds sets the Probe motion window, clamped to 5–120 s (C8.4)', async ({ page }) => {
  for (const [raw, seconds] of [['2', 5], ['300', 120], ['45', 45], ['soon', 5]] as const) {
    await page.goto(`/probe/?motionSeconds=${raw}`);
    await expect(page.locator('#motion-run'), raw).toHaveText(`Probe motion (${seconds} s)`);
  }
  await page.goto('/probe/');
  await expect(page.locator('#motion-run')).toHaveText('Probe motion (5 s)');
});

test('Probe motion exports per-axis ranges and the reported sensor interval (C8.4)', async ({ page }) => {
  await page.goto('/probe/?motionSeconds=5');
  await page.locator('#motion-run').click();
  await expect(page.locator('#motion-result')).toHaveText('listening for 5 s…');
  // The probe listens only once requestPermission() has resolved: send the two samples every 100 ms
  // for 2 s, well inside the 5 s window (repeats change neither the ranges nor the mean interval).
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const send = (): void => {
          for (const [x, y, z] of [
            [0.5, -0.25, 0.1],
            [-1.5, 0.75, 0],
          ] as const) {
            window.dispatchEvent(
              new DeviceMotionEvent('devicemotion', {
                acceleration: { x, y, z },
                accelerationIncludingGravity: { x, y: y + 9.81, z },
                interval: 16,
              }),
            );
          }
        };
        const timer = setInterval(send, 100);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 2000);
      }),
  );
  await expect(page.locator('#motion-result')).toContainText('available=true', { timeout: 10_000 });

  await page.locator('#qr-show').click();
  const summary = JSON.parse((await page.locator('#summary-json').textContent()) ?? 'null') as {
    motion: { accelRange: unknown; axes: unknown } | null;
    notes: Record<string, string>;
  };
  expect(summary.motion?.axes).toEqual({
    acc: { x: [-1.5, 0.5], y: [-0.25, 0.75], z: [0, 0.1] },
    accG: { x: [-1.5, 0.5], y: [9.56, 10.56], z: [0, 0.1] },
    intervalMs: 16,
  });
  expect(summary.motion?.accelRange).toEqual([-1.5, 0.75]);
  // Every run is also kept as a note, so the parked baseline's axes survive a later driving run.
  expect(summary.notes['motion.1']).toContain('acc=x:-1.5..0.5,y:-0.25..0.75,z:0..0.1');
  expect(summary.notes['motion.1']).toContain('accG=x:-1.5..0.5,y:9.56..10.56,z:0..0.1');
  expect(summary.notes['motion.1']).toContain('interval=16');
});
