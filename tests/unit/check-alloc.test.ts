import { constants } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_GC_FRACTION,
  MAX_PAUSE_MS,
  MAX_WINDOWS,
  MEASURE_QUANTA,
  WARM_QUANTA,
  gateOk,
  gcVerdict,
  main,
  measureWindows,
  type GcVerdict,
} from '../../tools/check-alloc';

const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
const INCREMENTAL = constants.NODE_PERFORMANCE_GC_INCREMENTAL;

describe('check-alloc gcVerdict (amendment B2, revised 2026-10-07)', () => {
  it('uses the contract thresholds and window', () => {
    expect(MAX_PAUSE_MS).toBe(4.0);
    expect(MAX_GC_FRACTION).toBe(0.01);
    expect(WARM_QUANTA).toBe(10_000);
    expect(MEASURE_QUANTA).toBe(100_000);
    expect(MAX_WINDOWS).toBe(3);
  });

  it('passes with many short minor GCs well under 1 % of the audio time', () => {
    const samples = Array.from({ length: 600 }, () => ({ kind: MINOR, durationMs: 0.3 }));
    const v = gcVerdict(samples, 266.67);
    expect(v).toMatchObject({ minor: 600, major: 0, other: 0, ok: true, reasons: [] });
    expect(v.totalMs).toBeCloseTo(180, 9);
    expect(v.maxPauseMs).toBe(0.3);
    expect(v.fraction).toBeCloseTo(180 / 266670, 12);
  });

  it('tolerates the 1–2 ms scavenges that the revision accepts (output buffering absorbs them)', () => {
    const v = gcVerdict([{ kind: MINOR, durationMs: 1.13 }, { kind: MINOR, durationMs: 2.03 }, { kind: MAJOR, durationMs: 2.58 }], 266.67);
    expect(v).toMatchObject({ minor: 2, major: 1, other: 0, ok: true, reasons: [] });
    expect(v.maxPauseMs).toBe(2.58);
  });

  it('passes with no GC at all, and treats exactly 4.0 ms as within budget', () => {
    expect(gcVerdict([], 10)).toMatchObject({ minor: 0, major: 0, other: 0, totalMs: 0, maxPauseMs: 0, fraction: 0, ok: true });
    expect(gcVerdict([{ kind: MINOR, durationMs: 4.0 }], 10).ok).toBe(true);
  });

  it('fails on any single pause above 4.0 ms, whatever its kind', () => {
    for (const kind of [MINOR, MAJOR, INCREMENTAL]) {
      const v = gcVerdict([{ kind, durationMs: 0.2 }, { kind, durationMs: 4.0001 }], 266.67);
      expect(v.ok).toBe(false);
      expect(v.reasons.join()).toMatch(/longest GC pause/);
    }
    expect(gcVerdict([{ kind: MAJOR, durationMs: 0.5 }, { kind: INCREMENTAL, durationMs: 0.1 }], 1)).toMatchObject({ major: 1, other: 1 });
  });

  it('fails when total GC time exceeds 1 % of the audio duration', () => {
    const samples = Array.from({ length: 101 }, () => ({ kind: MINOR, durationMs: 0.99 })); // 99.99 ms
    expect(gcVerdict(samples, 10).ok).toBe(true); // budget 100 ms
    const over = gcVerdict([...samples, { kind: MINOR, durationMs: 0.5 }], 10);
    expect(over.ok).toBe(false);
    expect(over.reasons.join()).toMatch(/total GC time/);
  });

  it('fails when no audio was rendered', () => {
    expect(gcVerdict([], 0).ok).toBe(false);
  });
});

describe('check-alloc gate over up to three windows (scheduling noise only lengthens a pause)', () => {
  const within: GcVerdict = gcVerdict([{ kind: MINOR, durationMs: 1.2 }], 266.67);
  const noisy: GcVerdict = gcVerdict([{ kind: MINOR, durationMs: 4.235 }], 266.67);
  const heavy: GcVerdict = gcVerdict([{ kind: MINOR, durationMs: 0.5 }], 0.01); // 5 % of the audio time

  it('passes when any window is within budget and fails only when every window fails', () => {
    expect(within.ok && !noisy.ok && !heavy.ok).toBe(true);
    expect(gateOk([noisy, noisy, noisy])).toBe(false);
    expect(gateOk([noisy, heavy, noisy])).toBe(false);
    expect(gateOk([noisy, within])).toBe(true);
    expect(gateOk([noisy, noisy, within])).toBe(true);
    expect(gateOk([within])).toBe(true);
    expect(gateOk([])).toBe(false);
  });

  it('measures windows in order, stops at the first within budget, and never exceeds the maximum', async () => {
    const run = async (verdicts: GcVerdict[]): Promise<{ result: GcVerdict[]; calls: number[] }> => {
      const calls: number[] = [];
      const result = await measureWindows(async (index) => {
        calls.push(index);
        return verdicts[index] ?? noisy;
      });
      return { result, calls };
    };
    expect(await run([within, noisy, noisy])).toEqual({ result: [within], calls: [0] });
    expect(await run([noisy, within, noisy])).toEqual({ result: [noisy, within], calls: [0, 1] });
    expect(await run([noisy, noisy, within])).toEqual({ result: [noisy, noisy, within], calls: [0, 1, 2] });
    expect(await run([noisy, noisy, noisy, within])).toEqual({ result: [noisy, noisy, noisy], calls: [0, 1, 2] });
    expect(gateOk((await run([noisy, noisy, noisy, within])).result)).toBe(false);
  });
});

describe('check-alloc main', () => {
  it('main() refuses to run without --expose-gc', async () => {
    const g = globalThis as { gc?: unknown };
    const saved = g.gc;
    delete g.gc;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(2);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('--expose-gc'));
    } finally {
      err.mockRestore();
      if (saved !== undefined) g.gc = saved;
    }
  });
});
