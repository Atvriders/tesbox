/**
 * src/lab/ui/level.ts (phase-2c contract L3 "Match level"): both A/B sides normalised by RMS — the reference by
 * its whole-clip RMS, the lab by the meter's RMS — to the quieter of the two, so neither side is boosted.
 */
import { describe, expect, it } from 'vitest';
import { clipRms, matchLevels, powerMeanDb } from '../../src/lab/ui/level';

describe('clipRms (whole clip, every channel)', () => {
  it('is 1/√2 for a full-scale sine', () => {
    const fs = 48000;
    const x = new Float32Array(fs);
    for (let i = 0; i < fs; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / fs);
    expect(clipRms([x])).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('averages the power of all samples of all channels', () => {
    expect(clipRms([[1, -1, 1, -1]])).toBe(1);
    expect(clipRms([[1, 1], [0, 0]])).toBeCloseTo(Math.SQRT1_2, 12); // √(2 / 4)
    expect(clipRms([[0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]])).toBe(0.5);
  });

  it('is 0 for nothing at all', () => {
    expect(clipRms([])).toBe(0);
    expect(clipRms([new Float32Array(0)])).toBe(0);
  });
});

describe('powerMeanDb (the meter readings of the last second)', () => {
  it('averages power, not decibels', () => {
    expect(powerMeanDb([-20, -20])).toBeCloseTo(-20, 12);
    expect(powerMeanDb([-20, -30])).toBeCloseTo(10 * Math.log10((0.01 + 0.001) / 2), 12); // −22.596 dB
  });

  it('reads −200 dB (silence) for no readings', () => {
    expect(powerMeanDb([])).toBe(-200);
    expect(powerMeanDb([-200, -200])).toBeLessThan(-190);
  });
});

describe('matchLevels', () => {
  it('turns the louder side down to the quieter one', () => {
    expect(matchLevels(-20, -26)).toEqual({ refGainDb: -6, labGainDb: 0 });
    expect(matchLevels(-30, -18)).toEqual({ refGainDb: 0, labGainDb: -12 });
    expect(matchLevels(-24, -24)).toEqual({ refGainDb: 0, labGainDb: 0 });
  });

  it('leaves both sides at the same RMS', () => {
    for (const [ref, lab] of [
      [-14.5, -31.25],
      [-40, -12],
    ] as const) {
      const m = matchLevels(ref, lab);
      expect(m).not.toBeNull();
      if (m === null) continue;
      expect(ref + m.refGainDb).toBeCloseTo(lab + m.labGainDb, 12);
      expect(Math.max(m.refGainDb, m.labGainDb)).toBe(0);
    }
  });

  it('refuses to match against silence or a non-finite level', () => {
    expect(matchLevels(-95, -20)).toBeNull();
    expect(matchLevels(-20, -120)).toBeNull();
    expect(matchLevels(Number.NaN, -20)).toBeNull();
    expect(matchLevels(-20, Number.NEGATIVE_INFINITY)).toBeNull();
  });
});
