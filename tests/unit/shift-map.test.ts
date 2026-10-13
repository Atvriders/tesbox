import { describe, expect, it } from 'vitest';
import type { DriveMode, EngineDef, EngineSpec } from '../../src/contracts';
import { buildShiftMap } from '../../src/sim/shift-map';
import { DCT7_SPEC, FIXTURE_SPECS } from '../helpers/sim-fixtures';

const MODES: readonly DriveMode[] = ['comfort', 'sport'];
const LOADS = [-1, -0.3, 0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.5];

/**
 * Real engines: every src/data/engines/*.json present when the suite runs (Tasks 9–10 write them
 * before, during or after this task; with none present only the fixtures are swept).
 */
const ENGINE_JSON = import.meta.glob<EngineDef>('../../src/data/engines/*.json', { eager: true, import: 'default' });
const ALL_SPECS: readonly (readonly [string, EngineSpec])[] = [
  ...FIXTURE_SPECS,
  ...Object.values(ENGINE_JSON).map((d) => [d.id, d.spec] as const),
];

function ratio(spec: EngineSpec, gear: number): number {
  const r = spec.gearbox.overallRatios[gear - 1];
  if (r === undefined) throw new Error(`no gear ${gear}`);
  return r;
}

describe('buildShiftMap — DCT7 fixture, hand-computed values', () => {
  const comfort = buildShiftMap(DCT7_SPEC, 'comfort');
  const sport = buildShiftMap(DCT7_SPEC, 'sport');

  it('exposes gears and the coast-down rpm per mode', () => {
    expect(comfort.gears).toBe(7);
    expect(sport.gears).toBe(7);
    expect(comfort.coastDownRpm).toBe(1200);
    expect(sport.coastDownRpm).toBe(1500);
  });

  it('upshift at load 0 is the larger of 0.25·redline and the coast-down floor (comfort)', () => {
    // floor(n) = (1200 + 300) / (r[n+1]/r[n]); 0.25·7000 = 1750
    expect(comfort.upshiftRpm(1, 0)).toBeCloseTo(1500 / (8.6 / 13.5), 9); // 2354.65
    expect(comfort.upshiftRpm(1, 0)).toBeCloseTo(2354.65, 2);
    expect(comfort.upshiftRpm(2, 0)).toBeCloseTo(2114.75, 2);
    expect(comfort.upshiftRpm(3, 0)).toBeCloseTo(1946.81, 2);
    expect(comfort.upshiftRpm(6, 0)).toBeCloseTo(1750, 6); // floor 1750 == 0.25·redline
  });

  it('upshift interpolates with load^1.3 (comfort 0.25→0.90, sport 0.30→0.97 of redline)', () => {
    expect(comfort.upshiftRpm(3, 1)).toBeCloseTo(0.9 * 7000, 9);
    expect(sport.upshiftRpm(3, 1)).toBeCloseTo(0.97 * 7000, 9);
    expect(comfort.upshiftRpm(3, 0.5)).toBeCloseTo((0.25 + 0.65 * Math.pow(0.5, 1.3)) * 7000, 9); // 3597.87
    expect(comfort.upshiftRpm(3, 0.5)).toBeCloseTo(3597.87, 1);
    expect(sport.upshiftRpm(3, 0.5)).toBeCloseTo((0.3 + 0.67 * Math.pow(0.5, 1.3)) * 7000, 9);
    expect(sport.upshiftRpm(1, 0)).toBeCloseTo(1800 / (8.6 / 13.5), 9); // sport floor (1500 + 300)
  });

  it('clamps load to [0, 1] and treats NaN as 0', () => {
    expect(comfort.upshiftRpm(3, -0.7)).toBe(comfort.upshiftRpm(3, 0));
    expect(comfort.upshiftRpm(3, 1.7)).toBe(comfort.upshiftRpm(3, 1));
    expect(comfort.upshiftRpm(3, Number.NaN)).toBe(comfort.upshiftRpm(3, 0));
  });

  it('top gear never upshifts; gear 1 never downshifts; out-of-range gears are inert', () => {
    expect(comfort.upshiftRpm(7, 1)).toBe(Infinity);
    expect(comfort.kickdownMaxRpm(7, 1)).toBe(Infinity);
    expect(comfort.downshiftRpm(1, 1)).toBe(0);
    expect(comfort.upshiftRpm(0, 0.5)).toBe(Infinity);
    expect(comfort.downshiftRpm(0, 0.5)).toBe(0);
    expect(comfort.downshiftRpm(8, 0.5)).toBe(0);
  });

  it('downshift = upshift(n − 1) · r[n]/r[n−1] · (1 − h), h comfort 0.25 / sport 0.15', () => {
    expect(comfort.downshiftRpm(2, 0)).toBeCloseTo(1500 * 0.75, 9); // floor-bound: (1200+300)·0.75
    expect(comfort.downshiftRpm(2, 1)).toBeCloseTo(6300 * (8.6 / 13.5) * 0.75, 9); // 3010
    expect(comfort.downshiftRpm(2, 1)).toBeCloseTo(3010, 6);
    expect(sport.downshiftRpm(2, 0)).toBeCloseTo(1800 * 0.85, 9); // 1530
    expect(sport.downshiftRpm(5, 0.6)).toBeCloseTo(sport.upshiftRpm(4, 0.6) * (3.8 / 4.7) * 0.85, 9);
  });

  it('kickdownMaxRpm = upshiftRpm − 300', () => {
    expect(comfort.kickdownMaxRpm(3, 1)).toBeCloseTo(6000, 9);
    expect(sport.kickdownMaxRpm(2, 0.95)).toBeCloseTo(sport.upshiftRpm(2, 0.95) - 300, 9);
  });
});

describe('buildShiftMap — rejects malformed gearboxes', () => {
  const withRatios = (overallRatios: number[]): EngineSpec => ({
    ...DCT7_SPEC,
    gearbox: { ...DCT7_SPEC.gearbox, overallRatios },
  });

  // The leading-Infinity and single-NaN cases pass the strictly-descending check, so only the
  // non-finite check rejects them (else upshiftRpm/downshiftRpm return Infinity/NaN).
  it.each([
    [[]],
    [[3, 3]],
    [[2, 3]],
    [[3, 0]],
    [[3, Number.NaN]],
    [[3, -1]],
    [[Number.POSITIVE_INFINITY, 3]],
    [[Number.NaN]],
  ])('throws on %o', (r) => {
    expect(() => buildShiftMap(withRatios(r), 'comfort')).toThrow(Error);
  });

  it('throws on a non-positive redline', () => {
    expect(() => buildShiftMap({ ...DCT7_SPEC, rpm: { ...DCT7_SPEC.rpm, redline: 0 } }, 'sport')).toThrow(Error);
  });
});

describe.each(ALL_SPECS.map(([name, spec]) => [name, spec] as const))('shift-map invariants: %s', (_name, spec) => {
  it.each(MODES.map((m) => [m] as const))('%s', (mode) => {
    const map = buildShiftMap(spec, mode);
    const n = map.gears;
    expect(n).toBe(spec.gearbox.overallRatios.length);
    for (const load of LOADS) {
      for (let g = 1; g < n; g++) {
        const step = ratio(spec, g + 1) / ratio(spec, g);
        const up = map.upshiftRpm(g, load);
        const landed = up * step; // rpm in g + 1 right after the upshift
        // contract invariant 1: the next gear's downshift point sits below the landing rpm (no hunting)
        expect(map.downshiftRpm(g + 1, load), `g${g + 1} load ${load}`).toBeLessThan(landed);
        // contract invariant 2: after any upshift the new gear turns ≥ coastDownRpm + 300 − 1
        expect(landed, `g${g}→${g + 1} load ${load}`).toBeGreaterThanOrEqual(map.coastDownRpm + 300 - 1);
        // the schedule never asks for an upshift beyond the rev limiter
        expect(up, `g${g} load ${load}`).toBeLessThan(spec.rpm.limiter.rpm);
        // a map downshift into g never over-revs g
        expect(map.downshiftRpm(g + 1, load) / step, `g${g + 1}→${g} load ${load}`).toBeLessThan(spec.rpm.redline);
        expect(map.kickdownMaxRpm(g, load)).toBeCloseTo(up - 300, 9);
      }
      expect(map.upshiftRpm(n, load)).toBe(Infinity);
      expect(map.downshiftRpm(1, load)).toBe(0);
    }
    // upshift rpm never decreases with load
    for (let g = 1; g < n; g++) {
      let prev = -Infinity;
      for (const load of LOADS) {
        const up = map.upshiftRpm(g, load);
        expect(up).toBeGreaterThanOrEqual(prev);
        prev = up;
      }
    }
  });
});
