/**
 * Sound Lab e2e smoke (`/lab/`, phase-2c contract L4 — the Phase 2c exit gate): the page loads with zero CSP
 * violations and lists the 15 engines; Start → ready → a non-silent, finite meter at 3000 rpm; a voicing edit
 * reconfigures without errors; Upshift changes the gear readout; a segment advances rpm; A/B with a generated
 * 1 s sine WAV toggles B and back with no request carrying the file; Export downloads JSON that validates and
 * re-imports.
 *
 * Every test runs with an init script that watches for CSP violations, records what the page posts to the
 * 'tesbox-lab' worklet, and taps an AnalyserNode beside every connection to the audio output (the A/B check
 * reads what is actually played). CSP violations, page errors and console errors fail the test.
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js'; // Playwright loads specs as native ESM: the subpath needs its extension
import { expect, test as base, type Page } from '@playwright/test';
import { LAB_STR } from '../../src/lab/ui/strings';

interface Reading {
  hz: number | null;
  spread: number | null;
  rms: number;
}

interface LabTap {
  posted: { type: string; [k: string]: unknown }[];
  readings: Reading[];
}

interface TapWindow {
  __labTap?: LabTap;
  __labCsp?: (violation: string) => void;
}

/** Serialised into the page: self-contained. */
function installLabTap(): void {
  const w = window as unknown as TapWindow & Record<string, unknown>;
  const tap: LabTap = { posted: [], readings: [] };
  w.__labTap = tap;
  document.addEventListener('securitypolicyviolation', (e) => {
    w.__labCsp?.(`${e.violatedDirective} blocked ${e.blockedURI}`);
  });

  const Native = w.AudioWorkletNode as typeof AudioWorkletNode | undefined;
  if (typeof Native !== 'function') return;
  class TappedNode extends Native {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options);
      if (name !== 'tesbox-lab') return;
      const port = this.port;
      const post = port.postMessage.bind(port) as (m: unknown) => void;
      port.postMessage = ((m: unknown) => {
        tap.posted.push(JSON.parse(JSON.stringify(m)) as LabTap['posted'][number]);
        post(m);
      }) as MessagePort['postMessage'];
    }
  }
  w.AudioWorkletNode = TappedNode;

  let analyser: AnalyserNode | null = null;
  const nativeConnect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]): unknown {
    const result = nativeConnect.apply(this, args);
    if (args[0] instanceof AudioDestinationNode) {
      if (analyser === null || analyser.context !== this.context) {
        analyser = this.context.createAnalyser();
        analyser.fftSize = 32768;
      }
      nativeConnect.call(this, analyser); // hears what the output hears
    }
    return result;
  } as typeof AudioNode.prototype.connect;
  const buf = new Float32Array(32768);
  setInterval(() => {
    const an = analyser;
    if (an === null) return;
    an.getFloatTimeDomainData(buf);
    const n = Math.round(0.25 * an.context.sampleRate);
    const ups: number[] = [];
    let sumSq = 0;
    for (let i = buf.length - n; i < buf.length; i++) {
      const x = buf[i] ?? 0;
      const prev = buf[i - 1] ?? 0;
      sumSq += x * x;
      if (prev < 0 && x >= 0) ups.push(i - 1 + prev / (prev - x));
    }
    let hz: number | null = null;
    let spread: number | null = null;
    if (ups.length >= 3) {
      const periods: number[] = [];
      for (let k = 1; k < ups.length; k++) periods.push((ups[k] ?? 0) - (ups[k - 1] ?? 0));
      const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
      spread = Math.max(...periods.map((p) => Math.abs(p - mean))) / mean;
      hz = an.context.sampleRate / mean;
    }
    tap.readings.push({ hz, spread, rms: Math.sqrt(sumSq / n) });
    if (tap.readings.length > 600) tap.readings.splice(0, 100);
  }, 100);
}

const test = base.extend<{ lab: Page }>({
  lab: async ({ page }, use) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await page.exposeFunction('__labCsp', (violation: string) => problems.push(`CSP violation: ${violation}`));
    await page.addInitScript(installLabTap);
    await page.goto('/lab/');
    await use(page);
    expect(problems, 'CSP violations, page errors and console errors').toEqual([]);
  },
});

/** A mono 16-bit PCM WAV: `seconds` of a sine at `hz` (an integer number of cycles loops seamlessly). */
function sineWav(hz: number, seconds: number, fs = 48000, amp = 0.5): Buffer {
  const n = Math.round(seconds * fs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / fs)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(fs, 24);
  head.writeUInt32LE(fs * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const meter = (page: Page) => page.locator('section.meter');

async function meterNumber(page: Page, attr: 'data-rms-db' | 'data-peak-db' | 'data-rpm'): Promise<number> {
  return Number((await meter(page).getAttribute(attr)) ?? Number.NaN);
}

/** Start audio and wait until the worklet is ready and the context runs. */
async function startAudio(page: Page): Promise<void> {
  await page.getByRole('button', { name: LAB_STR.start }).click();
  await expect(page.locator('.audio-status')).toHaveText(/^Running at /, { timeout: 15_000 });
  await expect(meter(page)).toHaveAttribute('data-rpm', /\d/, { timeout: 5_000 });
}

/** Types into a number box and commits it (Enter fires `change`). */
async function commitNumber(page: Page, name: string, value: string): Promise<void> {
  const box = page.getByRole('spinbutton', { name, exact: true });
  await box.fill(value);
  await box.press('Enter');
}

async function lastReading(page: Page): Promise<Reading | null> {
  return page.evaluate(() => (window as unknown as TapWindow).__labTap?.readings.at(-1) ?? null);
}

function isCleanTone(r: Reading | null, hz: number): boolean {
  return r !== null && r.hz !== null && r.spread !== null && Math.abs(r.hz - hz) < 5 && r.spread < 0.05;
}

test('/lab/ loads without CSP violations and lists the 15 engines', async ({ lab }) => {
  await expect(lab.getByRole('heading', { level: 1, name: LAB_STR.title })).toBeVisible();
  await expect(lab.locator('#engine option')).toHaveCount(15);
  await expect(lab.locator('#engine optgroup')).toHaveCount(4);
  for (const option of await lab.locator('#engine option').allTextContents()) expect(option).toMatch(/ \(inspired by .+\)$/);
  await expect(lab.locator('.inspired')).toHaveText(/^inspired by /);
  await expect(lab.getByRole('heading', { name: LAB_STR.voicing.title })).toBeVisible();
});

test('Start → ready → the meter is non-silent at 3000 rpm and stays finite', async ({ lab }) => {
  await startAudio(lab);
  await commitNumber(lab, LAB_STR.drive.rpm, '3000');
  await expect(meter(lab)).toHaveAttribute('data-rpm', '3000');
  await lab.waitForTimeout(800);
  const rms: number[] = [];
  const peaks: number[] = [];
  for (let i = 0; i < 10; i++) {
    rms.push(await meterNumber(lab, 'data-rms-db'));
    peaks.push(await meterNumber(lab, 'data-peak-db'));
    await lab.waitForTimeout(100);
  }
  for (const v of [...rms, ...peaks]) expect(Number.isFinite(v)).toBe(true);
  for (const v of rms) expect(v).toBeGreaterThan(-60);
  for (const v of peaks) expect(v).toBeLessThanOrEqual(-0.9); // the stage's −1 dBTP ceiling
});

test('a voicing edit reconfigures the engine without errors', async ({ lab }) => {
  await startAudio(lab);
  await commitNumber(lab, LAB_STR.drive.rpm, '3000');
  const shipped = Number(await lab.getByRole('spinbutton', { name: 'pulse.alpha', exact: true }).inputValue());
  const edited = shipped === 12 ? 13 : 12;
  await commitNumber(lab, 'pulse.alpha', String(edited));
  await expect(lab.locator('.apply-state')).toHaveText(LAB_STR.voicing.state.applied ?? '');
  await expect
    .poll(() =>
      lab.evaluate(() =>
        ((window as unknown as TapWindow).__labTap?.posted ?? [])
          .filter((m) => m.type === 'engine')
          .map((m) => (m.def as { voicing: { pulse: { alpha: number } } }).voicing.pulse.alpha),
      ),
    )
    .toEqual([shipped, edited]); // the start-up engine, then the edit
  await lab.waitForTimeout(1200); // the core's 300 ms fade-out / fade-in
  await expect(lab.locator('.worklet-error')).toHaveCount(0);
  await expect(lab.getByRole('alert')).toHaveCount(0);
  const rms = await meterNumber(lab, 'data-rms-db');
  expect(Number.isFinite(rms) && rms > -60).toBe(true);
});

test('Upshift changes the gear readout', async ({ lab }) => {
  await startAudio(lab);
  const gear = lab.getByRole('status', { name: LAB_STR.meter.gear });
  await expect(gear).toHaveText('1');
  await lab.getByRole('button', { name: LAB_STR.drive.upshift }).click();
  await expect(gear).toHaveText('2');
});

test('a segment advances rpm', async ({ lab }) => {
  await startAudio(lab);
  await lab.getByLabel(LAB_STR.drive.segment).selectOption('wotPull');
  await lab.getByRole('button', { name: LAB_STR.drive.play, exact: true }).click();
  await expect(lab.locator('.drive-state')).toHaveText(/^Looping wotPull/);
  const rpms: number[] = [];
  for (let i = 0; i < 20; i++) {
    rpms.push(await meterNumber(lab, 'data-rpm'));
    await lab.waitForTimeout(100);
  }
  expect(Math.max(...rpms) - Math.min(...rpms)).toBeGreaterThan(1000);
});

test('A/B with a generated 1 s sine WAV toggles B and back; no request carries the file', async ({ lab }) => {
  await startAudio(lab);
  const requests: { url: string; method: string; body: boolean }[] = [];
  lab.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postDataBuffer() !== null }));

  await lab.locator('input[type="file"][accept="audio/*"]').setInputFiles({
    name: 'sine-440.wav',
    mimeType: 'audio/wav',
    buffer: sineWav(440, 1),
  });
  await expect(lab.locator('.ref-info')).toHaveText(/^sine-440\.wav: 1\.00 s, /);

  const ab = lab.getByRole('button', { name: LAB_STR.compare.ab });
  await ab.click();
  await expect(ab).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => lastReading(lab).then((r) => isCleanTone(r, 440)), { timeout: 5_000 }).toBe(true);

  await lab.keyboard.press('b'); // the B key toggles back (focus is on the A/B button)
  await expect(ab).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => lastReading(lab).then((r) => r !== null && r.rms > 0.001 && !isCleanTone(r, 440)), { timeout: 5_000 }).toBe(true);

  expect(requests.filter((r) => r.method !== 'GET' || r.body)).toEqual([]);
  expect(requests.filter((r) => r.url.includes('sine-440'))).toEqual([]);
});

test('Export downloads JSON that validates against the schema and re-imports', async ({ lab }) => {
  const engineId = await lab.locator('#engine').inputValue();
  const lowpass = lab.getByRole('spinbutton', { name: 'cabin.lowpassHz', exact: true });
  const shipped = await lowpass.inputValue();
  const edited = shipped === '750' ? '760' : '750';
  await commitNumber(lab, 'cabin.lowpassHz', edited);
  await expect(lowpass).toHaveValue(edited);

  const [download] = await Promise.all([lab.waitForEvent('download'), lab.getByRole('button', { name: LAB_STR.files.download }).click()]);
  expect(download.suggestedFilename()).toBe(`${engineId}.voicing.json`);
  const path = await download.path();
  const text = readFileSync(path, 'utf8');
  const file = JSON.parse(text) as { engineId: string; voicing: { cabin: { lowpassHz: number }; estimated: boolean } };
  expect(Object.keys(file)).toEqual(['engineId', 'voicing']);
  expect(file.engineId).toBe(engineId);
  expect(file.voicing.cabin.lowpassHz).toBe(Number(edited));
  expect(file.voicing.estimated).toBe(true);
  const schema = JSON.parse(readFileSync(new URL('../../src/data/schema/engine.schema.json', import.meta.url), 'utf8')) as {
    $defs: { voicing: object };
  };
  const validVoicing = new Ajv2020({ allErrors: true, strict: true }).compile(schema.$defs.voicing);
  expect(validVoicing(file.voicing), JSON.stringify(validVoicing.errors)).toBe(true);

  await lab.getByRole('button', { name: LAB_STR.voicing.resetEngine }).click();
  await expect(lowpass).toHaveValue(shipped);
  await lab.locator('input[type="file"][accept=".json,application/json"]').setInputFiles({
    name: `${engineId}.voicing.json`,
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(lowpass).toHaveValue(edited);
  await expect(lab.locator('.notice')).toHaveText(/^Imported /);
  await expect(lab.locator('.apply-state')).toHaveText(LAB_STR.voicing.state.applied ?? '');
});
