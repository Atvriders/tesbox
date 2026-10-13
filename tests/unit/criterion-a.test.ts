import { describe, expect, it } from 'vitest';
import { DEFAULT_SIM_TUNING } from '../../src/contracts';
import type { ReplayTrace } from '../../src/sim/replay';
import { DT_S, loadTrace, percentile, runTrace, stepsOf } from '../helpers/replay-harness';

/**
 * Spec §1.3(a) as amended by contract A1: p95 time from a true-speed step to 63 % of the response
 * ≤ fix lag + one fix interval + 0.2 s on the coords.speed path, and ≤ fix lag + two fix intervals
 * on the position-only path. ReplayFeeder → SpeedFilter at dt = 128/48000 with the shipped
 * DEFAULT_SIM_TUNING.
 */
const trace = loadTrace('step-response');
const BOUND_S = trace.meta.latencyS + trace.meta.cadenceS + 0.2;
const POSITION_BOUND_S = trace.meta.latencyS + 2 * trace.meta.cadenceS;
const positionOnly: ReplayTrace = { ...trace, fixes: trace.fixes.map((f) => ({ ...f, speedMps: null })) };

/** Seconds from each truth step until the filter output first reaches 63 % of that step. */
function responseTimes(tr: ReplayTrace): number[] {
  const run = runTrace(tr, DEFAULT_SIM_TUNING);
  return stepsOf(tr).map((step) => {
    const target = step.from + 0.63 * (step.to - step.from);
    const rising = step.to > step.from;
    for (let i = Math.ceil(step.t / DT_S); i < run.v.length; i++) {
      const v = run.v[i] ?? Number.NaN;
      if (rising ? v >= target : v <= target) return i * DT_S - step.t;
    }
    return Number.POSITIVE_INFINITY;
  });
}

describe('criterion (a) — speed path p95 ≤ latency + cadence + 0.2 s; position path p95 ≤ latency + 2·cadence (A1)', () => {
  it('uses the 2.2 s / 3.0 s bounds of the synthetic GPS model (1 s lag, 1 s cadence)', () => {
    expect(BOUND_S).toBeCloseTo(2.2, 12);
    expect(POSITION_BOUND_S).toBeCloseTo(3.0, 12);
    expect(stepsOf(trace)).toHaveLength(20);
  });

  it('speed path (coords.speed present) meets latency + cadence + 0.2 s', () => {
    const p95 = percentile(responseTimes(trace), 95);
    console.info(`criterion (a) speed path: p95 = ${p95.toFixed(3)} s (bound ${BOUND_S.toFixed(1)} s)`);
    expect(p95).toBeLessThanOrEqual(BOUND_S);
  });

  it('position path (every speedMps null) meets latency + 2·cadence (contract A1)', () => {
    const p95 = percentile(responseTimes(positionOnly), 95);
    console.info(`criterion (a) position path: p95 = ${p95.toFixed(3)} s (bound ${POSITION_BOUND_S.toFixed(1)} s)`);
    expect(p95).toBeLessThanOrEqual(POSITION_BOUND_S);
  });
});
