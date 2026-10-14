import { describe, expect, it } from 'vitest';
import {
  FrameGate,
  backingScale,
  fitDial,
  minFrameIntervalMs,
  mountTach,
  rpmToAngle,
  shiftLightOn,
  smoothRpm,
  tachScale,
  tachTicks,
  type TachWindow,
} from '../../src/ui/tach';

const PI = Math.PI;

// ───────────────────────────── scale and angles ─────────────────────────────

describe('tachScale — dial range from the engine', () => {
  it('ends on the first thousand at least 500 rpm above the redline or limiter', () => {
    expect(tachScale(7000, 7100).maxRpm).toBe(8000); // i5 turbo: limiter 7100 → 7600 → 8000
    expect(tachScale(9000, 9200).maxRpm).toBe(10000); // flat-plane V8: 9700 → 10000
    expect(tachScale(6200, 6200).maxRpm).toBe(7000); // supercharged V8: 6700 → 7000
    expect(tachScale(7500, 7500).maxRpm).toBe(8000); // exactly 8000 is enough
    expect(tachScale(8000, 8000).maxRpm).toBe(9000); // rotary
    expect(tachScale(7400, 7600).maxRpm).toBe(9000); // a limiter above the redline still fits on the dial
  });

  it('keeps the redline and numbers every 1000 rpm with 500 rpm minor ticks', () => {
    const s = tachScale(7000, 7100);
    expect(s.redline).toBe(7000);
    expect(s.majorStepRpm).toBe(1000);
    expect(s.minorStepRpm).toBe(500);
  });
});

describe('rpmToAngle — 270° sweep, 0 rpm at bottom-left, clockwise', () => {
  it('maps 0, half and full scale to 135°, 270° (straight up) and 405°', () => {
    expect(rpmToAngle(0, 8000)).toBeCloseTo(0.75 * PI, 12);
    expect(rpmToAngle(4000, 8000)).toBeCloseTo(1.5 * PI, 12);
    expect(rpmToAngle(8000, 8000)).toBeCloseTo(2.25 * PI, 12);
    expect(rpmToAngle(2000, 8000)).toBeCloseTo(1.125 * PI, 12);
  });

  it('pins below zero, above full scale and on non-finite rpm', () => {
    expect(rpmToAngle(-300, 8000)).toBeCloseTo(0.75 * PI, 12);
    expect(rpmToAngle(12000, 8000)).toBeCloseTo(2.25 * PI, 12);
    expect(rpmToAngle(Number.NaN, 8000)).toBeCloseTo(0.75 * PI, 12);
    expect(rpmToAngle(Number.POSITIVE_INFINITY, 8000)).toBeCloseTo(0.75 * PI, 12);
  });
});

describe('shiftLightOn — at 0.95 × redline', () => {
  it('lights from 95 % of the redline up', () => {
    expect(shiftLightOn(6649, 7000)).toBe(false);
    expect(shiftLightOn(6650, 7000)).toBe(true);
    expect(shiftLightOn(7300, 7000)).toBe(true);
    expect(shiftLightOn(8549, 9000)).toBe(false);
    expect(shiftLightOn(8550, 9000)).toBe(true);
  });

  it('stays dark without a usable rpm', () => {
    expect(shiftLightOn(Number.NaN, 7000)).toBe(false);
    expect(shiftLightOn(0, 7000)).toBe(false);
  });
});

describe('tachTicks', () => {
  it('numbers every thousand (in thousands), minor ticks between, red from the redline', () => {
    const ticks = tachTicks(tachScale(7000, 7100)); // 0 … 8000
    expect(ticks.map((t) => t.rpm)).toEqual([
      0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000,
    ]);
    expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === null)).toBe(true);
    expect(ticks.filter((t) => t.red).map((t) => t.rpm)).toEqual([7000, 7500, 8000]);
    expect(ticks[0]?.angle).toBeCloseTo(0.75 * PI, 12);
    expect(ticks[16]?.angle).toBeCloseTo(2.25 * PI, 12);
  });

  it('marks the redline zone from a redline between ticks', () => {
    const ticks = tachTicks(tachScale(6200, 6200)); // 0 … 7000
    expect(ticks.filter((t) => t.red).map((t) => t.rpm)).toEqual([6500, 7000]);
  });
});

// ───────────────────────────── layout ─────────────────────────────

describe('fitDial — the largest 270° dial in the box', () => {
  /** The dial reaches r above the centre and r·sin 45° below it (the open bottom). */
  function insideBox(w: number, h: number): void {
    const { cx, cy, r } = fitDial(w, h);
    expect(r).toBeGreaterThan(0);
    expect(cx - r).toBeGreaterThanOrEqual(0);
    expect(cx + r).toBeLessThanOrEqual(w);
    expect(cy - r).toBeGreaterThanOrEqual(0);
    expect(cy + r * Math.SQRT1_2).toBeLessThanOrEqual(h + 1e-9);
  }

  it('is width-limited in a tall box: radius = half the width less 4 px padding, centred', () => {
    const d = fitDial(400, 1000);
    expect(d.r).toBeCloseTo(196, 9);
    expect(d.cx).toBeCloseTo(200, 9);
    insideBox(400, 1000);
  });

  it('is height-limited in a wide box: fills the height, centred horizontally', () => {
    const d = fitDial(1000, 350);
    expect(d.r).toBeCloseTo(342 / (1 + Math.SQRT1_2), 9); // 200.34
    expect(d.cx).toBeCloseTo(500, 9);
    expect(d.cy - d.r).toBeCloseTo(4, 9);
    insideBox(1000, 350);
  });

  it('fits the Drive dial boxes of the target viewports', () => {
    for (const [w, h] of [
      [533, 451],
      [980, 608],
      [1736, 1093],
      [300, 120],
    ] as const) {
      insideBox(w, h);
    }
  });

  it('collapses to nothing in a box without room', () => {
    expect(fitDial(0, 300).r).toBe(0);
    expect(fitDial(6, 6).r).toBe(0);
  });
});

// ───────────────────────────── Intel rules (spec §3, §5.7) ─────────────────────────────

describe('backingScale — canvas backing store per CSS px', () => {
  it('is 1× on an Intel MCU whatever the zoom', () => {
    expect(backingScale('intel', 1.53)).toBe(1);
    expect(backingScale('intel', 2)).toBe(1);
  });

  it('follows the device pixel ratio elsewhere, capped at 2×', () => {
    expect(backingScale('amd', 1.53)).toBe(1.53);
    expect(backingScale('unknown', 1.96)).toBe(1.96);
    expect(backingScale('amd', 3)).toBe(2);
  });

  it('treats a missing, zero or below-1 ratio as 1', () => {
    expect(backingScale('amd', Number.NaN)).toBe(1);
    expect(backingScale('amd', 0)).toBe(1);
    expect(backingScale('unknown', 0.5)).toBe(1);
  });
});

describe('minFrameIntervalMs — frame cap', () => {
  it('caps an Intel MCU at 30 fps and leaves the others uncapped', () => {
    expect(minFrameIntervalMs('intel')).toBeCloseTo(1000 / 30, 9);
    expect(minFrameIntervalMs('amd')).toBe(0);
    expect(minFrameIntervalMs('unknown')).toBe(0);
  });
});

/** Frame timestamps at `hz` for `seconds`, optionally jittered by ±jitterMs (seeded, deterministic). */
function frames(hz: number, seconds: number, jitterMs = 0): number[] {
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: number[] = [];
  const n = Math.round(hz * seconds);
  for (let k = 0; k < n; k++) out.push((k * 1000) / hz + (jitterMs > 0 ? (rand() * 2 - 1) * jitterMs : 0));
  return out;
}

function drawnFrames(gate: FrameGate, times: readonly number[]): number[] {
  return times.filter((t) => gate.shouldDraw(t));
}

describe('FrameGate', () => {
  const cap30 = 1000 / 30;

  it('draws every frame when uncapped', () => {
    expect(drawnFrames(new FrameGate(0), frames(60, 1))).toHaveLength(60);
    expect(drawnFrames(new FrameGate(0), frames(144, 1))).toHaveLength(144);
  });

  it('draws every other frame of a 60 Hz display at the 30 fps cap', () => {
    const t = frames(60, 1);
    const drawn = drawnFrames(new FrameGate(cap30), t);
    expect(drawn).toHaveLength(30);
    expect(drawn).toEqual(t.filter((_, k) => k % 2 === 0));
  });

  it('holds 30 fps on a jittery 60 Hz clock without dropping to 20 fps or drawing two frames in a row', () => {
    const t = frames(60, 10, 1);
    const gate = new FrameGate(cap30);
    const drawnIdx = t.map((x) => gate.shouldDraw(x)).flatMap((d, k) => (d ? [k] : []));
    expect(drawnIdx.length).toBeGreaterThanOrEqual(299);
    expect(drawnIdx.length).toBeLessThanOrEqual(301);
    for (let i = 1; i < drawnIdx.length; i++) expect((drawnIdx[i] ?? 0) - (drawnIdx[i - 1] ?? 0)).toBeGreaterThan(1);
  });

  it('never averages above 30 fps on a 120 or 144 Hz display', () => {
    expect(drawnFrames(new FrameGate(cap30), frames(120, 10)).length).toBeLessThanOrEqual(301);
    const fast = drawnFrames(new FrameGate(cap30), frames(144, 10));
    expect(fast.length).toBeLessThanOrEqual(301);
    expect(fast.length).toBeGreaterThanOrEqual(295);
  });

  it('draws every frame of a display that is already at 30 Hz or slower', () => {
    expect(drawnFrames(new FrameGate(cap30), frames(30, 2))).toHaveLength(60);
    expect(drawnFrames(new FrameGate(cap30), frames(20, 2))).toHaveLength(40);
  });

  it('does not burst after a stall (hidden tab): one draw, then the normal cadence', () => {
    const gate = new FrameGate(cap30);
    expect(drawnFrames(gate, [0, 1000 / 60, 1000, 1000 + 1000 / 60, 1000 + 2000 / 60, 1000 + 3000 / 60])).toEqual([
      0,
      1000,
      1000 + 2000 / 60,
    ]);
  });
});

describe('smoothRpm — needle follows the ~30 Hz snapshots smoothly (τ = 50 ms)', () => {
  it('moves 63 % of the way in one time constant', () => {
    expect(smoothRpm(0, 1000, 50)).toBeCloseTo(632.1, 1);
    expect(smoothRpm(3000, 2000, 50)).toBeCloseTo(2367.9, 1);
  });

  it('holds without elapsed time and arrives after a long gap', () => {
    expect(smoothRpm(1200, 4000, 0)).toBe(1200);
    expect(smoothRpm(1200, 4000, 2000)).toBeCloseTo(4000, 6);
  });

  it('jumps to the target from an unknown value and holds on an unknown target', () => {
    expect(smoothRpm(Number.NaN, 2500, 16)).toBe(2500);
    expect(smoothRpm(1800, Number.NaN, 16)).toBe(1800);
  });
});

// ───────────────────────────── mountTach (rAF loop) ─────────────────────────────

/** A 2D context that only counts calls; every method is a no-op. */
function countingContext(): { ctx: CanvasRenderingContext2D; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in t) return t[key];
      return () => {
        calls.set(key, (calls.get(key) ?? 0) + 1);
        if (key === 'measureText') return { width: 10 };
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return { addColorStop: () => {} };
        return undefined;
      };
    },
    set(t, key, value) {
      if (typeof key === 'string') t[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

interface FakeCanvas {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  getContext(kind: string): CanvasRenderingContext2D | null;
  ownerDocument: { createElement(tag: string): FakeCanvas };
}

function fakeCanvas(w: number, h: number): { canvas: FakeCanvas; main: Map<string, number> } {
  const mainCtx = countingContext();
  const mk = (ctx: CanvasRenderingContext2D): FakeCanvas => ({
    clientWidth: w,
    clientHeight: h,
    width: 300,
    height: 150,
    getContext: (kind) => (kind === '2d' ? ctx : null),
    ownerDocument: { createElement: () => mk(countingContext().ctx) },
  });
  return { canvas: mk(mainCtx.ctx), main: mainCtx.calls };
}

class FakeWindow implements TachWindow {
  devicePixelRatio = 1.53;
  private next = 1;
  readonly callbacks = new Map<number, FrameRequestCallback>();
  cancelled: number[] = [];

  requestAnimationFrame(cb: FrameRequestCallback): number {
    const id = this.next++;
    this.callbacks.set(id, cb);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.cancelled.push(id);
    this.callbacks.delete(id);
  }

  /** Runs the pending frame callbacks at `t`. */
  frame(t: number): void {
    const due = [...this.callbacks.entries()];
    this.callbacks.clear();
    for (const [, cb] of due) cb(t);
  }
}

const MODEL = { redline: 7000, limiterRpm: 7100 };

describe('mountTach', () => {
  it('sizes the backing store 1× on Intel and by the device pixel ratio elsewhere', () => {
    const win = new FakeWindow();
    const intel = fakeCanvas(400, 300);
    const stopIntel = mountTach(intel.canvas as unknown as HTMLCanvasElement, { mcu: 'intel', rpm: () => 3000, model: () => MODEL, win });
    win.frame(0);
    expect([intel.canvas.width, intel.canvas.height]).toEqual([400, 300]);
    stopIntel();

    const amd = fakeCanvas(400, 300);
    const stopAmd = mountTach(amd.canvas as unknown as HTMLCanvasElement, { mcu: 'amd', rpm: () => 3000, model: () => MODEL, win });
    win.frame(1000);
    expect([amd.canvas.width, amd.canvas.height]).toEqual([612, 459]);
    stopAmd();
  });

  it('redraws at most 30 times a second on Intel and every frame elsewhere while the needle moves', () => {
    for (const [mcu, expected] of [
      ['intel', 30],
      ['amd', 60],
    ] as const) {
      const win = new FakeWindow();
      const { canvas, main } = fakeCanvas(400, 300);
      let rpm = 1000;
      const stop = mountTach(canvas as unknown as HTMLCanvasElement, { mcu, rpm: () => (rpm += 40), model: () => MODEL, win });
      for (const t of frames(60, 1)) win.frame(t);
      expect(main.get('clearRect') ?? 0).toBe(expected);
      stop();
    }
  });

  it('stops redrawing once the needle has settled', () => {
    const win = new FakeWindow();
    const { canvas, main } = fakeCanvas(400, 300);
    mountTach(canvas as unknown as HTMLCanvasElement, { mcu: 'amd', rpm: () => 2000, model: () => MODEL, win });
    for (const t of frames(60, 3)) win.frame(t);
    const settled = main.get('clearRect') ?? 0;
    for (const t of frames(60, 1)) win.frame(3000 + t);
    expect(main.get('clearRect') ?? 0).toBe(settled);
  });

  it('redraws when the engine (scale) changes or the box is resized', () => {
    const win = new FakeWindow();
    const { canvas, main } = fakeCanvas(400, 300);
    let model = MODEL;
    mountTach(canvas as unknown as HTMLCanvasElement, { mcu: 'amd', rpm: () => 2000, model: () => model, win });
    for (const t of frames(60, 3)) win.frame(t);
    const before = main.get('clearRect') ?? 0;
    model = { redline: 9000, limiterRpm: 9200 };
    win.frame(3100);
    expect(main.get('clearRect') ?? 0).toBe(before + 1);
    canvas.clientWidth = 500;
    win.frame(3200);
    expect(main.get('clearRect') ?? 0).toBe(before + 2);
    expect(canvas.width).toBe(765);
  });

  it('stops the frame loop when disposed', () => {
    const win = new FakeWindow();
    const { canvas } = fakeCanvas(400, 300);
    const stop = mountTach(canvas as unknown as HTMLCanvasElement, { mcu: 'amd', rpm: () => 2000, model: () => MODEL, win });
    win.frame(0);
    stop();
    expect(win.callbacks.size).toBe(0);
    expect(win.cancelled).toHaveLength(1);
  });

  it('survives a canvas without a 2D context (nothing drawn, no throw)', () => {
    const win = new FakeWindow();
    const { canvas } = fakeCanvas(400, 300);
    canvas.getContext = () => null;
    const stop = mountTach(canvas as unknown as HTMLCanvasElement, { mcu: 'amd', rpm: () => 2000, model: () => MODEL, win });
    expect(() => win.frame(0)).not.toThrow();
    stop();
  });
});
