import { describe, expect, it } from 'vitest';
import { INTAKE_RMS, IntakeLayer } from '../../src/dsp/intake';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;

/** i4-test with the intake voicing under test (4 entries → gate sum 4/3 is envelope 1). */
function makeLayer(seed = 1, helmholtzHz = 140, gain = 0.4): IntakeLayer {
  const def = loadFixture('i4-test');
  def.voicing.intake = { runnerM: 0.3, helmholtzHz, gain };
  def.voicing.headersM = [0.6, 0.6, 0.6, 0.6];
  const layer = new IntakeLayer(FS);
  layer.configure(def.voicing, seed);
  return layer;
}

function render(layer: IntakeLayer, n: number, gateSum: number, throttle: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = layer.tick(gateSum, throttle);
  return out;
}

function rms(x: Float64Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Hann-windowed Goertzel power at f (relative units, same window for all calls). */
function tonePower(x: Float64Array, f: number, from: number): number {
  const n = x.length - from;
  const c = 2 * Math.cos((2 * Math.PI * f) / FS);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = (x[from + i] ?? 0) * w + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Mean power over 41 bins spaced 1 Hz around f (a noise-density estimate). */
function bandDensity(x: Float64Array, f: number, from: number): number {
  let p = 0;
  for (let k = -20; k <= 20; k++) p += tonePower(x, f + k, from);
  return p / 41;
}

describe('IntakeLayer', () => {
  it('is exactly silent at throttle 0 even with open intake gates', () => {
    const out = render(makeLayer(), FS, 4 / 3, 0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('is exactly silent whenever the gate sum is 0', () => {
    const out = render(makeLayer(), FS / 2, 0, 1);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('has RMS ≈ INTAKE_RMS × gain at full throttle with gate envelope 1 (I4 gate sum 4/3)', () => {
    const out = render(makeLayer(1, 140, 0.4), 2 * FS, 4 / 3, 1);
    const r = rms(out, FS / 4);
    expect(r).toBeGreaterThan(0.8 * INTAKE_RMS * 0.4);
    expect(r).toBeLessThan(1.2 * INTAKE_RMS * 0.4);
  });

  it('normalises the gate sum by 3 / header count: I6 gate sum 2 is envelope 1 too', () => {
    const def = loadFixture('i6-test');
    def.voicing.intake = { runnerM: 0.3, helmholtzHz: 140, gain: 0.4 };
    def.voicing.headersM = [0.55, 0.55, 0.55, 0.55, 0.55, 0.55];
    const layer = new IntakeLayer(FS);
    layer.configure(def.voicing, 2);
    const r = rms(render(layer, 2 * FS, 2, 1), FS / 4);
    expect(r).toBeGreaterThan(0.8 * INTAKE_RMS * 0.4);
    expect(r).toBeLessThan(1.2 * INTAKE_RMS * 0.4);
  });

  it('concentrates its energy around helmholtzHz (band-pass Q 2)', () => {
    const out = render(makeLayer(3, 140, 1), 2 * FS, 4 / 3, 1);
    const at = bandDensity(out, 140, FS / 4);
    expect(at).toBeGreaterThan(10 * bandDensity(out, 600, FS / 4));
    expect(at).toBeGreaterThan(100 * bandDensity(out, 2000, FS / 4));
    expect(at).toBeGreaterThan(10 * bandDensity(out, 40, FS / 4));
  });

  it('scales exactly with the gate envelope and with voicing gain (same seed)', () => {
    const a = render(makeLayer(5, 140, 0.4), 4800, 4 / 3, 1);
    const b = render(makeLayer(5, 140, 0.4), 4800, 2 / 3, 1);
    const c = render(makeLayer(5, 140, 0.8), 4800, 4 / 3, 1);
    for (let i = 0; i < 4800; i++) {
      expect(b[i] ?? NaN).toBeCloseTo(0.5 * (a[i] ?? NaN), 12);
      expect(c[i] ?? NaN).toBeCloseTo(2 * (a[i] ?? NaN), 12);
    }
  });

  it('de-zips throttle: 20 ms linear fade in, fade out to exact silence within 20 ms (B12, multi-call)', () => {
    const layer = makeLayer(7);
    const on = render(layer, FS / 5, 4 / 3, 1);
    const steady = rms(on, FS / 10);
    expect(rms(on, 0, 96)).toBeLessThan(0.25 * steady); // first 2 ms: still fading in
    const off = render(layer, FS / 2, 4 / 3, 0);
    expect(off[0]).not.toBe(0); // no instant cut on lift
    expect(rms(off, 0, 96)).toBeGreaterThan(0.5 * steady); // first 2 ms: still mostly there
    expect(off.subarray(FS / 50).every((v) => v === 0)).toBe(true); // exact silence from 20 ms on
    const again = render(layer, FS / 5, 4 / 3, 1); // re-open: sound returns
    expect(rms(again, FS / 10)).toBeGreaterThan(0.5 * steady);
  });

  it('fades out as an exact 20 ms linear ramp of the open-throttle signal (B12, seed-independent)', () => {
    // The noise sequence never depends on the inputs, so a twin held at throttle 1 is the reference.
    const layer = makeLayer(13);
    const twin = makeLayer(13);
    render(layer, FS / 10, 4 / 3, 1);
    render(twin, FS / 10, 4 / 3, 1);
    const off = render(layer, FS / 25, 4 / 3, 0);
    const open = render(twin, FS / 25, 4 / 3, 1);
    const n20 = FS / 50; // 20 ms
    for (let i = 0; i < n20; i++) {
      expect(off[i] ?? NaN).toBeCloseTo((open[i] ?? NaN) * (1 - (i + 1) / n20), 12);
    }
    expect(off.subarray(n20 - 1).every((v) => v === 0)).toBe(true);
  });

  it('is deterministic per seed, reset() replays the sequence, and seeds differ', () => {
    const layer = makeLayer(11);
    const first = render(layer, 2000, 1, 1);
    layer.reset();
    expect(Array.from(render(layer, 2000, 1, 1))).toEqual(Array.from(first));
    expect(Array.from(render(makeLayer(11), 2000, 1, 1))).toEqual(Array.from(first));
    expect(Array.from(render(makeLayer(12), 2000, 1, 1))).not.toEqual(Array.from(first));
  });
});
