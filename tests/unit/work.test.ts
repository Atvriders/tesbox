import { describe, it, expect } from 'vitest';
import { WORK_OPS_PER_SAMPLE, WorkKernel } from '../../src/probe/work';

describe('WorkKernel', () => {
  it('costs 400 multiply-adds per frame per k', () => {
    expect(WORK_OPS_PER_SAMPLE).toBe(400);
  });

  it('performs 400 serial multiply-adds per frame (checksum equals a reference loop)', () => {
    let x = 0;
    for (let i = 0; i < 400; i++) x = x * 0.5 + ((i & 63) + 1) / 64; // initial state s[i] = (i + 1) / 64
    expect(new WorkKernel().run(1, 1)).toBe(x);
  });

  it('returns a finite checksum in (0, 2) and is deterministic', () => {
    const a = new WorkKernel().run(128, 4);
    const b = new WorkKernel().run(128, 4);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(2);
    expect(b).toBe(a);
  });

  it('k multiplies the work: run(128, 2) ≡ two run(128, 1) calls (state carries across calls)', () => {
    const once = new WorkKernel().run(128, 2);
    const twice = new WorkKernel();
    twice.run(128, 1);
    expect(twice.run(128, 1)).toBe(once);
    expect(new WorkKernel().run(128, 1)).not.toBe(once);
  });

  it('does nothing for k = 0 or 0 frames', () => {
    const w = new WorkKernel();
    const first = w.run(128, 1);
    expect(w.run(128, 0)).toBe(first);
    expect(w.run(0, 16)).toBe(first);
    const fresh = new WorkKernel();
    fresh.run(128, 1);
    expect(w.run(128, 1)).toBe(fresh.run(128, 1)); // k = 0 calls left the state untouched
  });

  it('stays bounded and finite over a long run at k = 16 (no drift to NaN, ∞ or subnormals)', () => {
    const w = new WorkKernel();
    let c = 0;
    for (let q = 0; q < 50; q++) c = w.run(128, 16);
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThan(1e-3);
    expect(c).toBeLessThan(2);
  });
});
