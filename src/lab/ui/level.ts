/**
 * Sound Lab A/B level matching (phase-2c contract L3 "Match level"): both sides are normalised by RMS — the
 * reference clip by its whole-clip RMS, the lab by the meter's RMS (the stage output, before the monitor
 * level) — to the quieter of the two. Gains are therefore ≤ 0 dB: matching never pushes either side towards
 * clipping. The monitor level then applies to both sides alike.
 */

/** A side at or below this RMS (or non-finite) cannot be matched: there is nothing to measure. */
export const SILENT_DB = -90;
/** dB reading of silence (matches the DSP's gainToDb floor). */
const FLOOR_DB = -200;

/** RMS over every sample of every channel (linear); 0 when there are no samples. */
export function clipRms(channels: readonly ArrayLike<number>[]): number {
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i] ?? 0;
      sum += x * x;
    }
    n += ch.length;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/** Linear amplitude → dB, floored at −200 dB. */
export function ampToDb(a: number): number {
  return a > 1e-10 ? 20 * Math.log10(a) : FLOOR_DB;
}

/** The level of several RMS readings taken together: the mean of their powers, in dB (−200 for none). */
export function powerMeanDb(readingsDb: readonly number[]): number {
  if (readingsDb.length === 0) return FLOOR_DB;
  let p = 0;
  for (const db of readingsDb) p += 10 ** (db / 10);
  p /= readingsDb.length;
  return p > 1e-20 ? 10 * Math.log10(p) : FLOOR_DB;
}

export interface LevelMatch {
  refGainDb: number;
  labGainDb: number;
}

/** Gains that bring both sides to the quieter side's RMS; null when either side is silent or not finite. */
export function matchLevels(refRmsDb: number, labRmsDb: number): LevelMatch | null {
  if (!Number.isFinite(refRmsDb) || !Number.isFinite(labRmsDb)) return null;
  if (refRmsDb <= SILENT_DB || labRmsDb <= SILENT_DB) return null;
  const target = Math.min(refRmsDb, labRmsDb);
  return { refGainDb: target - refRmsDb, labGainDb: target - labRmsDb };
}
