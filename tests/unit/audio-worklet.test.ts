import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { ProbeToWorklet, WorkletToProbe } from '../../src/probe/audio-protocol';

const SR = 48000;

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly sent: WorkletToProbe[] = [];
  postMessage(m: unknown): void {
    this.sent.push(structuredClone(m) as WorkletToProbe); // real ports clone too
  }
  send(msg: ProbeToWorklet): void {
    this.onmessage?.({ data: msg });
  }
  reports(): Extract<WorkletToProbe, { type: 'report' }>[] {
    return this.sent.filter((m): m is Extract<WorkletToProbe, { type: 'report' }> => m.type === 'report');
  }
}

class FakeAudioWorkletProcessor {
  readonly port = new FakePort();
}

interface Proc {
  readonly port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

const registered: { name: string; ctor: (new () => Proc) | null } = { name: '', ctor: null };
let audioTime = 0;

beforeAll(async () => {
  // AudioWorkletGlobalScope stand-ins must exist before the module evaluates.
  vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (name: string, ctor: new () => Proc) => {
    registered.name = name;
    registered.ctor = ctor;
  });
  vi.stubGlobal('sampleRate', SR);
  Object.defineProperty(globalThis, 'currentTime', { get: () => audioTime, configurable: true });
  await import('../../src/probe/audio-worklet');
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'currentTime');
});

function make(): Proc {
  if (registered.ctor === null) throw new Error('processor was not registered');
  return new registered.ctor();
}

/** Runs `quanta` process() calls of `frames` each; returns the concatenated channels. */
function render(p: Proc, quanta: number, frames = 128): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(quanta * frames);
  const right = new Float32Array(quanta * frames);
  for (let q = 0; q < quanta; q++) {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    expect(p.process([], [[l, r]])).toBe(true);
    left.set(l, q * frames);
    right.set(r, q * frames);
    audioTime += frames / SR;
  }
  return { left, right };
}

function peak(x: Float32Array): number {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

/** Counts upward crossings of half the peak (one per pulse). */
function onsets(x: Float32Array): number {
  const thr = peak(x) / 2;
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] ?? 0) < thr && (x[i] ?? 0) >= thr) n++;
  return n;
}

const ONE_SECOND = SR / 128; // 375 quanta

describe('tesbox-probe worklet', () => {
  it("registers as 'tesbox-probe'", () => {
    expect(registered.name).toBe('tesbox-probe');
  });

  it('renders an identical stereo 55 Hz pulse train at −18 dB by default', () => {
    const { left, right } = render(make(), ONE_SECOND);
    expect(right).toEqual(left);
    expect(onsets(left)).toBeGreaterThanOrEqual(54);
    expect(onsets(left)).toBeLessThanOrEqual(56);
    const p = peak(left);
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThanOrEqual(10 ** (-18 / 20) + 1e-6);
    expect(left.every(Number.isFinite)).toBe(true);
  });

  it('each pulse is ~2 ms long: the signal has decayed to silence well before the next period', () => {
    const { left } = render(make(), ONE_SECOND);
    const period = SR / 55;
    for (let i = 0; i < left.length; i++) {
      const tInPeriodMs = ((i % period) / SR) * 1000;
      if (tInPeriodMs > 4 && tInPeriodMs < 17) expect(Math.abs(left[i] ?? 1)).toBeLessThan(1e-6);
    }
    // Lower bound too: a raised cosine is above half its peak for half its length (2 ms → 1 ms = 48 samples).
    const half = peak(left) / 2;
    const aboveHalf = left.filter((v) => v >= half).length / onsets(left);
    expect(aboveHalf).toBeGreaterThan(40); // measured 48.5 at 2 ms; 24.8 at 1 ms, 72.4 at 3 ms
    expect(aboveHalf).toBeLessThan(56);
  });

  it('flushes the low-pass state to exactly 0 between widely spaced pulses (no subnormals)', () => {
    const p = make();
    p.port.send({ type: 'config', k: 1, toneHz: 1, gainDb: -18 });
    const { left } = render(p, ONE_SECOND);
    expect(left[SR / 2]).toBe(0);
    // Without the flush the decaying tail stays non-zero (float32 subnormals) until sample ~470.
    expect(left.subarray(300, SR / 2).every((v) => v === 0)).toBe(true);
  });

  it('applies config: toneHz and gainDb', () => {
    const p = make();
    p.port.send({ type: 'config', k: 1, toneHz: 110, gainDb: -6 });
    const { left } = render(p, ONE_SECOND);
    expect(onsets(left)).toBeGreaterThanOrEqual(109);
    expect(onsets(left)).toBeLessThanOrEqual(111);
    const ref = render(make(), ONE_SECOND).left;
    expect(peak(left) / peak(ref)).toBeCloseTo(10 ** (12 / 20), 1);
  });

  it('clamps config: k to at most 64 and gainDb to at most 0 dB', () => {
    // Bounded on purpose: an unclamped k = 1e9 would hang the worker in one synchronous loop
    // (Vitest's timeout cannot fire), whereas an unclamped k = 256 costs ~4× and still finishes.
    const control = make();
    control.port.send({ type: 'config', k: 64, toneHz: 55, gainDb: -18 });
    render(control, 20); // JIT warm-up
    const t0 = performance.now();
    render(control, 20);
    const t64 = performance.now() - t0;
    const p = make();
    p.port.send({ type: 'config', k: 256, toneHz: 55, gainDb: 60 });
    const t1 = performance.now();
    const { left } = render(p, 20);
    const t256 = performance.now() - t1;
    expect(t256 / t64).toBeLessThan(2); // clamped: ≈ 1 (measured 0.98–1.00); unclamped: ≈ 3.7
    expect(peak(left)).toBeGreaterThan(0.5);
    expect(peak(left)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('clamps toneHz to [1, 1000] Hz', () => {
    const hi = make();
    hi.port.send({ type: 'config', k: 1, toneHz: 1e6, gainDb: -18 });
    const n = onsets(render(hi, ONE_SECOND).left);
    expect(n).toBeGreaterThanOrEqual(990);
    expect(n).toBeLessThanOrEqual(1001);
  });

  it('ignores non-finite config values', () => {
    const p = make();
    p.port.send({ type: 'config', k: Number.NaN, toneHz: Number.NaN, gainDb: Number.NaN });
    expect(render(p, 50).left).toEqual(render(make(), 50).left);
  });

  it('ignores +∞ gainDb and clamps −∞ gainDb to −120 dB', () => {
    const p = make();
    p.port.send({ type: 'config', k: 1, toneHz: 55, gainDb: Number.POSITIVE_INFINITY });
    expect(render(p, 50).left).toEqual(render(make(), 50).left);
    const q = make();
    q.port.send({ type: 'config', k: 1, toneHz: 55, gainDb: Number.NEGATIVE_INFINITY });
    expect(peak(render(q, 50).left)).toBeLessThan(1e-6);
  });

  it('keeps phase and filter state across calls (one 256-frame call ≡ two 128-frame calls)', () => {
    const one = render(make(), 3, 256).left;
    const two = render(make(), 6, 128).left;
    expect(two).toEqual(one);
  });

  it('posts a report every ~250 ms of audio time with cumulative quanta', () => {
    const p = make();
    render(p, 376);
    const reports = p.port.reports();
    expect(reports.map((r) => r.quanta)).toEqual([94, 188, 282, 376]);
    for (const r of reports) {
      expect(r.windowMs).toBeCloseTo((94 * 128 * 1000) / SR, 9);
      expect(r.sampleRate).toBe(SR);
      expect(r.perfInWorklet).toBe(true); // Node exposes performance.now
      expect(r.busyMs).toBeGreaterThanOrEqual(0);
    }
    expect(reports[1]!.currentTime).toBeGreaterThan(reports[0]!.currentTime);
  });

  it('busy time grows with k (the work kernel runs k × per quantum)', () => {
    const idle = make();
    idle.port.send({ type: 'config', k: 0, toneHz: 55, gainDb: -18 });
    render(idle, 94);
    const heavy = make();
    heavy.port.send({ type: 'config', k: 16, toneHz: 55, gainDb: -18 });
    render(heavy, 94);
    const idleBusy = idle.port.reports()[0]!.busyMs;
    const heavyBusy = heavy.port.reports()[0]!.busyMs;
    expect(heavyBusy).toBeGreaterThan(idleBusy * 5);
  });

  it('answers ping with pong carrying the id and currentTime', () => {
    const p = make();
    audioTime = 12.5;
    p.port.send({ type: 'ping', id: 7 });
    expect(p.port.sent).toContainEqual({ type: 'pong', id: 7, currentTime: 12.5 });
  });

  it('survives a missing output bus and always returns true', () => {
    const p = make();
    expect(p.process([], [])).toBe(true);
    expect(p.process([], [[]])).toBe(true);
  });
});
