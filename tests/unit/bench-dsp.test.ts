import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_S,
  ENGINES,
  FULL_FLOOR,
  FULL_TARGET,
  TIERS,
  WARM_S,
  WINDOWS,
  formatTable,
  measureRealtime,
  rowFromWindows,
  slowFullRows,
} from '../../tools/bench-dsp';
import { PROGRAM_S } from '../../tools/segments';
import { loadFixture } from './helpers/dsp-harness';

const row = (tier: 'full' | 'lite', ...factors: number[]) => rowFromWindows('x', tier, 20, factors);

describe('bench-dsp', () => {
  it('runs in the CI test job after the unit tests, next to the allocation gate (amendment B16)', () => {
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const test = ci.slice(ci.indexOf('\n  test:\n'), ci.indexOf('\n  e2e:\n'));
    expect(test).toContain('\n      - run: npm test\n      - run: npm run bench:dsp\n      - run: npm run check:alloc\n');
    expect(ci.match(/npm run bench:dsp/g)).toHaveLength(1);
    expect(ci.match(/npm run check:alloc/g)).toHaveLength(1);
  });

  it('benchmarks Full and Lite on two fixtures over three windows that cover the whole segment program', () => {
    expect(ENGINES).toEqual(['v8-crossplane-test', 'i5-test']);
    expect(TIERS).toEqual(['full', 'lite']);
    expect(WINDOWS).toBe(3);
    expect(AUDIO_S).toBe(20);
    expect(WARM_S).toBe(2);
    // the timed span (program seconds 2–62) holds a full program cycle, so every segment is timed in full
    expect(WINDOWS * AUDIO_S).toBeGreaterThanOrEqual(PROGRAM_S);
  });

  it('fails only Full rows below the 5× CI floor (amendment B6, revised)', () => {
    expect(FULL_FLOOR).toBe(5);
    expect(FULL_TARGET).toBe(10);
    expect(slowFullRows([row('full', 5), row('full', 55), row('lite', 3)])).toEqual([]);
    expect(slowFullRows([row('full', 4.99), row('lite', 4)])).toEqual([row('full', 4.99)]);
    expect(slowFullRows([row('full', Number.NaN)])).toHaveLength(1);
  });

  it('gates on the fastest of the timed windows and reports the median', () => {
    const pass = row('full', 4.5, 5.2, 4.8);
    expect(pass).toEqual({ engine: 'x', tier: 'full', audioS: 20, factors: [4.5, 5.2, 4.8], bestFactor: 5.2, medianFactor: 4.8 });
    expect(slowFullRows([pass])).toEqual([]);
    const fail = row('full', 4.5, 4.9, 4.7);
    expect(fail).toMatchObject({ bestFactor: 4.9, medianFactor: 4.7 });
    expect(slowFullRows([fail])).toEqual([fail]);
    expect(row('lite', 12, 11, 13, 10).medianFactor).toBe(11.5); // even count: mean of the middle two
    // a broken measurement (no window, or a NaN window) fails rather than passing on the other windows
    expect(slowFullRows([row('full'), row('full', 12, Number.NaN, 11)])).toHaveLength(2);
  });

  it('formats a markdown table with the best, the median and every window', () => {
    const table = formatTable([row('full', 41, 42.42, 40), row('lite', 80)]);
    expect(table).toContain('| engine | tier | audio (s) | × realtime, best | × realtime, median | windows |');
    expect(table).toContain('| x | full | 3 × 20.0 | 42.4 | 41.0 | 41.0, 42.4, 40.0 |');
    expect(table).toContain('| x | lite | 1 × 20.0 | 80.0 | 80.0 | 80.0 |');
  });

  it('measures three positive, finite windows and keeps the fastest', { timeout: 30_000 }, () => {
    const r = measureRealtime(loadFixture('i5-test'), 'lite', 0.2, 0.05);
    expect(r.engine).toBe('i5-test');
    expect(r.tier).toBe('lite');
    expect(r.audioS).toBeCloseTo(0.2, 2);
    expect(r.factors).toHaveLength(WINDOWS);
    expect(r.factors.every((f) => Number.isFinite(f) && f > 0)).toBe(true);
    expect(r.bestFactor).toBe(Math.max(...r.factors));
  });
});
