import { describe, expect, it } from 'vitest';
import { parseTyre, rollingCircumferenceM, wheelRpm } from '../../src/sim/tyre';

describe('parseTyre', () => {
  it('parses the plain ISO form', () => {
    expect(parseTyre('265/30R19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
  });

  it('accepts a space before R, a Z speed marker and a P prefix', () => {
    expect(parseTyre('265/30 R19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
    expect(parseTyre('265/30ZR19')).toEqual({ widthMm: 265, aspectPct: 30, rimIn: 19 });
    expect(parseTyre('P245/45R18')).toEqual({ widthMm: 245, aspectPct: 45, rimIn: 18 });
  });

  it.each([
    '',
    '265/30R',
    '265-30R19',
    '265/30R19 91Y',
    ' 265/30R19',
    '265/30r19',
    '265/30D19',
    '31x10.50R15',
    '265/30R19.5',
    '000/30R19',
    '265/00R19',
    '265/30R00',
  ])('throws on %j', (code) => {
    expect(() => parseTyre(code)).toThrow(Error);
  });
});

describe('rollingCircumferenceM', () => {
  it('matches the hand-computed value for 265/30R19', () => {
    // diameter = 2·265·0.30 + 19·25.4 = 159 + 482.6 = 641.6 mm
    // C = π·0.6416·0.97 = 1.955176… m
    expect(rollingCircumferenceM('265/30R19')).toBeCloseTo(Math.PI * 0.6416 * 0.97, 12);
    expect(rollingCircumferenceM('265/30R19')).toBeCloseTo(1.955176, 6);
  });

  it('is identical for every accepted spelling of the same size', () => {
    const c = rollingCircumferenceM('245/45R18');
    expect(rollingCircumferenceM('245/45 R18')).toBe(c);
    expect(rollingCircumferenceM('245/45ZR18')).toBe(c);
    expect(rollingCircumferenceM('P245/45R18')).toBe(c);
  });

  it('propagates parse errors', () => {
    expect(() => rollingCircumferenceM('not a tyre')).toThrow(Error);
  });
});

describe('wheelRpm', () => {
  it('is speed / C × ratio × 60', () => {
    expect(wheelRpm(30, 3, 2)).toBeCloseTo(2700, 12);
    expect(wheelRpm(0, 3, 2)).toBe(0);
  });

  it('gives the expected N/V for a known tyre and overall ratio', () => {
    // 1 mph = 0.44704 m/s; 265/30R19 with an overall ratio of 2.5 → rpm per mph
    const c = rollingCircumferenceM('265/30R19');
    const nv = wheelRpm(0.44704, 2.5, c);
    expect(nv).toBeCloseTo((0.44704 / c) * 2.5 * 60, 12);
    expect(nv).toBeCloseTo(34.2966, 3);
  });

  it('scales linearly with speed and ratio', () => {
    const c = rollingCircumferenceM('225/40R18');
    expect(wheelRpm(20, 4, c)).toBeCloseTo(2 * wheelRpm(10, 4, c), 9);
    expect(wheelRpm(20, 4, c)).toBeCloseTo(2 * wheelRpm(20, 2, c), 9);
  });
});
