import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmsDb, truePeakDbtp } from '../../src/dsp/analysis';
import { SEGMENTS } from '../../tools/segments';
import { MIN_FS, loadEngine, main, parseArgs, renderSegment, resolveEngine } from '../../tools/render';
import { readWav } from '../../tools/wav';
import { allFinite } from './helpers/dsp-harness';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tesbox-render-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tesbox-render argument parsing', () => {
  it('applies defaults', () => {
    expect(parseArgs(['i4-test'])).toEqual({
      engine: 'i4-test',
      segments: SEGMENTS.map((s) => s.name),
      perspective: 'cabin',
      subwoofer: 'yes',
      outDir: 'renders',
      fs: 48000,
    });
  });

  it('parses every option', () => {
    expect(
      parseArgs(['--segments', 'idle,wotPull', 'v8-sc-test', '--perspective', 'outside', '--subwoofer', 'no', '--out', 'x/y', '--fs', '44100']),
    ).toEqual({ engine: 'v8-sc-test', segments: ['idle', 'wotPull'], perspective: 'outside', subwoofer: 'no', outDir: 'x/y', fs: 44100 });
  });

  it('rejects bad input', () => {
    expect(() => parseArgs([])).toThrow(/missing/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/unexpected/);
    expect(() => parseArgs(['a', '--segments', 'idle,nope'])).toThrow(/nope/);
    expect(() => parseArgs(['a', '--perspective', 'roof'])).toThrow(/perspective/);
    expect(() => parseArgs(['a', '--subwoofer', 'unsure'])).toThrow(/subwoofer/);
    expect(() => parseArgs(['a', '--fs', '96000'])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs', String(MIN_FS - 1)])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs', '44100.5'])).toThrow(/fs/);
    expect(() => parseArgs(['a', '--fs'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--loud'])).toThrow(/unknown option/);
  });
});

describe('tesbox-render engine resolution', () => {
  it('falls back to tests/fixtures/engines for ids not in src/data/engines', () => {
    expect(resolveEngine('i4-test', ROOT)).toBe(join(ROOT, 'tests/fixtures/engines/i4-test.json'));
  });

  it('accepts explicit JSON paths and rejects unknown or unsafe ids', () => {
    const p = join(ROOT, 'tests/fixtures/engines/i6-test.json');
    expect(resolveEngine(p, ROOT)).toBe(p);
    expect(() => resolveEngine('no-such-engine', ROOT)).toThrow(/not found/);
    expect(() => resolveEngine('..', ROOT)).toThrow(/invalid engine id/);
    expect(() => resolveEngine(join(dir, 'missing.json'), ROOT)).toThrow(/not found/);
    expect(loadEngine(p).id).toBe('i6-test');
  });
});

describe('tesbox-render rendering', () => {
  it('renders a segment to finite, level-safe stereo of the exact duration', { timeout: 30_000 }, () => {
    const def = loadEngine(resolveEngine('i4-test', ROOT));
    const seg = SEGMENTS.find((s) => s.name === 'cruise2k');
    if (!seg) throw new Error('cruise2k missing');
    const { left, right, nonFiniteResets } = renderSegment(def, seg, { perspective: 'cabin', subwoofer: 'yes', fs: 48000 });
    expect(left.length).toBe(4 * 48000);
    expect(right.length).toBe(4 * 48000);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(nonFiniteResets).toBe(0);
    expect(truePeakDbtp(left)).toBeLessThanOrEqual(-1.0);
    expect(truePeakDbtp(right)).toBeLessThanOrEqual(-1.0);
    // the pre-roll removes the start-up fade: the first 100 ms are already at the steady level
    const steady = rmsDb(left.subarray(48000));
    expect(steady).toBeGreaterThan(-60);
    expect(rmsDb(left.subarray(0, 4800))).toBeGreaterThan(steady - 6);
  });

  it('every segment stays ≤ −1.0 dBTP at maximum trim (+6 dB; spec §1.3c, amendment B16)', { timeout: 120_000 }, () => {
    const def = loadEngine(resolveEngine('v8-flatplane-test', ROOT));
    const opts = { perspective: 'outside', subwoofer: 'no', fs: 48000 } as const;
    let loudestDbtp = Number.NEGATIVE_INFINITY;
    let idleRmsAtMaxTrim = Number.NaN;
    for (const seg of SEGMENTS) {
      const { left, right, nonFiniteResets } = renderSegment(def, seg, { ...opts, trimDb: 6 });
      expect(left.length, seg.name).toBe(Math.round(seg.durationS * 48000));
      expect(allFinite(left) && allFinite(right), seg.name).toBe(true);
      expect(nonFiniteResets, seg.name).toBe(0);
      const tp = Math.max(truePeakDbtp(left), truePeakDbtp(right));
      expect(tp, seg.name).toBeLessThanOrEqual(-1.0);
      loudestDbtp = Math.max(loudestDbtp, tp);
      if (seg.name === 'idle') idleRmsAtMaxTrim = rmsDb(left);
    }
    // The +6 dB trim is really applied: idle (below the compressor and limiter) comes out ≈ 6 dB louder
    // than at 0 dB trim (planning run: −26.4 vs −32.4 dB). Every segment is already ≤ −1.3 dBTP at
    // 0 dB, so the true-peak bound alone could not tell whether the trim was honoured.
    const idle = SEGMENTS.find((s) => s.name === 'idle');
    if (!idle) throw new Error('idle missing');
    const idleRmsAtZeroTrim = rmsDb(renderSegment(def, idle, { ...opts, trimDb: 0 }).left);
    expect(idleRmsAtMaxTrim - idleRmsAtZeroTrim).toBeGreaterThan(5);
    // …and the loudest segment reaches the limiter ceiling (B9 target −1.3 dBTP), so the bound above is
    // exercised at the ceiling rather than far below it.
    expect(loudestDbtp).toBeGreaterThanOrEqual(-1.5);
  });

  it('main() writes one WAV per requested segment', { timeout: 60_000 }, () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(main(['i4-test', '--segments', 'idle,limiterHold', '--out', dir, '--perspective', 'outside'])).toBe(0);
    } finally {
      log.mockRestore();
    }
    for (const [name, seconds] of [['idle', 5], ['limiterHold', 4]] as const) {
      const p = join(dir, `i4-test-${name}-outside.wav`);
      expect(existsSync(p)).toBe(true);
      const w = readWav(p);
      expect(w.fs).toBe(48000);
      expect(w.channels.length).toBe(2);
      expect(w.channels[0]?.length).toBe(seconds * 48000);
    }
  });

  it('main() returns 2 with usage on bad arguments', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(main(['--fs', '1'])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('usage:'));
    } finally {
      err.mockRestore();
    }
  });
});
