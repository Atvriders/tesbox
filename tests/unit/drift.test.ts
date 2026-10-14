import { describe, it, expect } from 'vitest';
import { DriftMonitor, type DriftWindow } from '../../src/platform/drift';

/** Feeds samples every 100 ms for `seconds`, the audio clock running at `rate` × wall time. */
function feed(m: DriftMonitor, from: { ctx: number; perf: number }, seconds: number, rate: number): DriftWindow[] {
  const out: DriftWindow[] = [];
  for (let i = 0; i < seconds * 10; i++) {
    from.perf += 100;
    from.ctx += (0.1 * rate);
    const w = m.push({ contextTimeS: from.ctx, perfMs: from.perf });
    if (w) out.push(w);
  }
  return out;
}

describe('DriftMonitor', () => {
  it('returns null until a full window has elapsed, then ratio ≈ 1 for a healthy clock', () => {
    const m = new DriftMonitor();
    expect(m.push({ contextTimeS: 1, perfMs: 5000 })).toBeNull(); // window start
    expect(m.push({ contextTimeS: 1.5, perfMs: 5500 })).toBeNull();
    const w = m.push({ contextTimeS: 2, perfMs: 6000 });
    expect(w?.ratio).toBeCloseTo(1, 12);
    expect(w?.overloaded).toBe(false);
    expect(m.overloaded).toBe(false);
  });

  it('ignores samples with contextTimeS === 0 or non-finite values', () => {
    const m = new DriftMonitor();
    expect(m.push({ contextTimeS: 0, perfMs: 0 })).toBeNull();
    expect(m.push({ contextTimeS: 0, perfMs: 2000 })).toBeNull();
    expect(m.push({ contextTimeS: Number.NaN, perfMs: 2500 })).toBeNull();
    expect(m.push({ contextTimeS: 0.5, perfMs: 3000 })).toBeNull(); // first valid sample starts the window
    expect(m.push({ contextTimeS: 1.5, perfMs: 4000 })?.ratio).toBeCloseTo(1, 12);
  });

  it('computes ratio = Δctx·1000/Δperf and flags a single slow window', () => {
    const m = new DriftMonitor();
    m.push({ contextTimeS: 10, perfMs: 0 });
    const w = m.push({ contextTimeS: 10.95, perfMs: 1000 });
    expect(w?.ratio).toBeCloseTo(0.95, 12);
    expect(w?.overloaded).toBe(true);
    expect(m.overloaded).toBe(false); // one window is not sustained overload
  });

  it('becomes overloaded after 2 consecutive slow windows and latches until reset()', () => {
    const m = new DriftMonitor();
    const clock = { ctx: 1, perf: 0 };
    m.push({ contextTimeS: clock.ctx, perfMs: clock.perf });
    const slow = feed(m, clock, 2, 0.9);
    expect(slow.map((w) => w.overloaded)).toEqual([true, true]);
    expect(m.overloaded).toBe(true);
    const healthy = feed(m, clock, 2, 1);
    expect(healthy.map((w) => w.overloaded)).toEqual([false, false]);
    expect(m.overloaded).toBe(true); // latched
    m.reset();
    expect(m.overloaded).toBe(false);
  });

  it('a healthy window between slow ones resets the consecutive count', () => {
    const m = new DriftMonitor();
    const clock = { ctx: 1, perf: 0 };
    m.push({ contextTimeS: clock.ctx, perfMs: clock.perf });
    feed(m, clock, 1, 0.9);
    feed(m, clock, 1, 1);
    feed(m, clock, 1, 0.9);
    expect(m.overloaded).toBe(false);
    feed(m, clock, 1, 0.9);
    expect(m.overloaded).toBe(true);
  });

  it('treats exactly the threshold as healthy and honours custom window/threshold', () => {
    // Binary-exact values so the boundary is tested without rounding noise.
    const m = new DriftMonitor(500, 0.875);
    m.push({ contextTimeS: 2, perfMs: 0 });
    expect(m.push({ contextTimeS: 2.4375, perfMs: 500 })?.overloaded).toBe(false); // ratio 0.875 is not < 0.875
    expect(m.push({ contextTimeS: 2.8125, perfMs: 1000 })?.overloaded).toBe(true); // ratio 0.75
  });

  it('restarts the window when the context clock goes backwards (new AudioContext)', () => {
    const m = new DriftMonitor();
    m.push({ contextTimeS: 50, perfMs: 0 });
    expect(m.push({ contextTimeS: 0.2, perfMs: 600 })).toBeNull(); // new context: fresh start
    const w = m.push({ contextTimeS: 1.2, perfMs: 1600 });
    expect(w?.ratio).toBeCloseTo(1, 12);
  });

  it('a context-clock jump (new AudioContext) clears the consecutive slow-window count', () => {
    const m = new DriftMonitor();
    const clock = { ctx: 1, perf: 0 };
    m.push({ contextTimeS: clock.ctx, perfMs: clock.perf });
    feed(m, clock, 1, 0.9); // one slow window on the old context
    clock.ctx = 0.1; // new context: its clock restarts near 0
    m.push({ contextTimeS: clock.ctx, perfMs: clock.perf });
    feed(m, clock, 1, 0.9); // one slow window on the new context
    expect(m.overloaded).toBe(false);
  });

  it('after reset() the next sample starts a new window', () => {
    const m = new DriftMonitor();
    m.push({ contextTimeS: 1, perfMs: 0 });
    m.reset();
    expect(m.push({ contextTimeS: 5, perfMs: 2000 })).toBeNull();
    expect(m.push({ contextTimeS: 6, perfMs: 3000 })?.ratio).toBeCloseTo(1, 12);
  });
});
