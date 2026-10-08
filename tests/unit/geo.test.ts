import { describe, it, expect } from 'vitest';
import { haversineM } from '../../src/platform/geo';

const R = 6371008.8;
const ONE_DEG_M = (R * Math.PI) / 180; // 111195.08 m

describe('haversineM', () => {
  it('is 0 for identical points', () => {
    expect(haversineM(0, 0, 0, 0)).toBe(0);
    expect(haversineM(0.25, -0.5, 0.25, -0.5)).toBe(0);
  });

  it('gives R·Δφ for a pure latitude step', () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo(ONE_DEG_M, 3);
  });

  it('gives R·Δλ for a longitude step on the equator', () => {
    expect(haversineM(0, 0, 0, 1)).toBeCloseTo(ONE_DEG_M, 3);
  });

  it('shrinks longitude steps by cos(latitude)', () => {
    // 1e-4° of longitude at 60° latitude: R·Δλ·cos 60° = 5.5598 m
    expect(haversineM(60, 0, 60, 0.0001)).toBeCloseTo((ONE_DEG_M / 10000) * 0.5, 4);
  });

  it('is accurate for sub-metre steps (no cancellation)', () => {
    // 1e-6° of latitude = 0.111195 m
    expect(haversineM(0, 0, 1e-6, 0)).toBeCloseTo(ONE_DEG_M * 1e-6, 6);
  });

  it('is symmetric', () => {
    expect(haversineM(0.1, 0.2, -0.3, 0.4)).toBeCloseTo(haversineM(-0.3, 0.4, 0.1, 0.2), 9);
  });

  it('returns π·R for antipodal points and never NaN', () => {
    const d = haversineM(0, 0, 0, 180);
    expect(Number.isNaN(d)).toBe(false);
    expect(d).toBeCloseTo(Math.PI * R, 0);
    expect(haversineM(90, 0, -90, 0)).toBeCloseTo(Math.PI * R, 0);
  });
});
