import { describe, expect, it } from 'vitest';
import type { EngineVoicing, Perspective } from '../../src/contracts';
import { dbToGain } from '../../src/dsp/util';
import { PerspectiveMixer } from '../../src/dsp/perspective';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;
const DELAY_N = Math.round(0.0007 * FS); // 34 samples

function voicing(cabinGainDb: number | null = -14, lowpassHz = 600): EngineVoicing {
  const v = loadFixture('i4-test').voicing;
  v.cabin = { lowpassHz };
  v.forcedInduction =
    cabinGainDb === null ? null : { spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb };
  return v;
}

function mixer(p: Perspective, v: EngineVoicing = voicing()): PerspectiveMixer {
  const m = new PerspectiveMixer(FS);
  m.setPerspective(p);
  m.configure(v); // snaps the crossfade to the target
  return m;
}

/** Inputs as a function of the sample index. */
type Src = (i: number) => [number, number, number, number, number];

function render(m: PerspectiveMixer, n: number, src: Src, onSample?: (i: number) => void): { l: Float64Array; r: Float64Array } {
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    onSample?.(i);
    const [e, it, b, f, a] = src(i);
    m.tick(e, it, b, f, a);
    l[i] = m.l;
    r[i] = m.r;
  }
  return { l, r };
}

const dc: Src = () => [0.1, 0.2, 0.3, 0.05, 0.02];
const sine = (f: number, amp: number) => (i: number) => amp * Math.sin((2 * Math.PI * f * i) / FS);

/** The mono mix m = (l + r) / 2: the ±0.08·d decorrelation cancels, leaving the perspective mix itself. */
function mono({ l, r }: { l: Float64Array; r: Float64Array }): Float64Array {
  return l.map((v, i) => (v + (r[i] ?? 0)) / 2);
}

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel). */
function toneAmp(x: Float64Array, f: number, from: number): number {
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
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

describe('PerspectiveMixer', () => {
  it('outside: exhaust + airflow + 0.7·intake + 0.3·block + fi, full band', () => {
    const { l, r } = render(mixer('outside'), 1000, dc);
    const m = 0.1 + 0.02 + 0.7 * 0.2 + 0.3 * 0.3 + 0.05;
    expect(((l[999] ?? 0) + (r[999] ?? 0)) / 2).toBeCloseTo(m, 12);
    const e = sine(4000, 0.5);
    const hf = render(mixer('outside'), FS / 2, (i) => [e(i), 0, 0, 0, 0]);
    expect(toneAmp(hf.l, 4000, 0) + toneAmp(hf.r, 4000, 0)).toBeCloseTo(2 * 0.5, 2);
  });

  it('cabin: unity-DC low-passes + fi × dbToGain(cabinGainDb)', () => {
    const { l, r } = render(mixer('cabin'), FS / 2, dc);
    const m = 0.1 + 0.02 + 0.2 + 0.3 + dbToGain(-14) * 0.05;
    expect(((l[FS / 2 - 1] ?? 0) + (r[FS / 2 - 1] ?? 0)) / 2).toBeCloseTo(m, 9);
  });

  it('cabin: 4th-order LP at cabin.lowpassHz on exhaust/intake/airflow', () => {
    const e = sine(4000, 0.5);
    const hf = render(mixer('cabin'), FS / 2, (i) => [e(i), e(i), 0, 0, e(i)]);
    expect(toneAmp(hf.l, 4000, FS / 10)).toBeLessThan(1.5 * 0.0005 * 3 * 0.5); // (600/4000)^4 ≈ 5e-4
    const lo = sine(100, 0.5);
    const lf = render(mixer('cabin'), FS, (i) => [lo(i), 0, 0, 0, 0]);
    expect((toneAmp(lf.l, 100, FS / 4) + toneAmp(lf.r, 100, FS / 4)) / 2).toBeCloseTo(0.5, 2);
    // The corner follows the voicing: the two prewarped RBJ sections (Q = BUTTER4_Q) are exactly
    // −3 dB there, since Q₁·Q₂ = 1/√2.
    for (const fc of [400, 800]) {
      const x = sine(fc, 0.5);
      const at = render(mixer('cabin', voicing(-14, fc)), FS, (i) => [x(i), 0, 0, 0, 0]);
      expect(toneAmp(mono(at), fc, FS / 4) / 0.5).toBeCloseTo(Math.SQRT1_2, 3);
    }
  });

  it('cabin: block through a 250 Hz LP; forced induction through a 2.8 kHz LP at cabinGainDb', () => {
    const b = sine(2000, 0.5);
    const blk = render(mixer('cabin'), FS / 2, (i) => [0, 0, b(i), 0, 0]);
    expect(toneAmp(blk.l, 2000, FS / 10)).toBeLessThan(0.5 * 0.02); // ≈ (250/2000)² ≈ −36 dB
    const f = sine(1000, 1);
    const fi = render(mixer('cabin', voicing(-12)), FS / 2, (i) => [0, 0, 0, f(i), 0]);
    const amp = (toneAmp(fi.l, 1000, FS / 10) + toneAmp(fi.r, 1000, FS / 10)) / 2;
    const lp = 1 / Math.sqrt(1 + (1000 / 2800) ** 4);
    expect(amp / (dbToGain(-12) * lp)).toBeCloseTo(1, 1);
    // At 1 kHz the LP is within 1 % of unity; at its corner the prewarped RBJ LP (Q = 1/√2) is exactly −3 dB.
    const tone = sine(2800, 1);
    const corner = render(mixer('cabin', voicing(-12)), FS / 2, (i) => [0, 0, 0, tone(i), 0]);
    expect(toneAmp(mono(corner), 2800, FS / 10) / dbToGain(-12)).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('uses −14 dB for the cabin forced-induction gain when the voicing has none', () => {
    const { l, r } = render(mixer('cabin', voicing(null)), FS / 2, () => [0, 0, 0, 1, 0]);
    expect(((l[FS / 2 - 1] ?? 0) + (r[FS / 2 - 1] ?? 0)) / 2).toBeCloseTo(dbToGain(-14), 9);
  });

  it('stereo: l = m + 0.08·d, r = m − 0.08·d with d = m delayed 0.7 ms (mono-compatible)', () => {
    const { l, r } = render(mixer('outside'), 200, (i) => [i === 0 ? 1 : 0, 0, 0, 0, 0]);
    expect(l[0]).toBe(1);
    expect(r[0]).toBe(1);
    expect(l[DELAY_N]).toBeCloseTo(0.08, 15);
    expect(r[DELAY_N]).toBeCloseTo(-0.08, 15);
    for (let i = 1; i < 200; i++) if (i !== DELAY_N) expect(Math.abs(l[i] ?? 1)).toBe(0);
  });

  it('crossfades cabin → outside over 300 ms (smoothstep), then equals pure outside exactly', () => {
    const m = mixer('cabin');
    const ref = mixer('outside');
    const before = render(m, FS / 2, dc); // settle
    render(ref, FS / 2, dc);
    m.setPerspective('outside');
    const quarter = render(m, 0.075 * FS, dc);
    const mid = render(m, 0.075 * FS, dc);
    const cab = ((before.l[FS / 2 - 1] ?? 0) + (before.r[FS / 2 - 1] ?? 0)) / 2;
    const out = 0.1 + 0.02 + 0.7 * 0.2 + 0.3 * 0.3 + 0.05;
    // DC inputs, so m = cab + smoothstep(w)·(out − cab); (l + r)/2 = m whatever the delayed copy holds.
    // w = 3600/14400 = 0.25 → smoothstep 0.15625 (a linear fade would be at 0.25).
    const quarterM = ((quarter.l[0.075 * FS - 1] ?? 0) + (quarter.r[0.075 * FS - 1] ?? 0)) / 2;
    expect(quarterM).toBeCloseTo(cab + 0.15625 * (out - cab), 9);
    // w = 7200/14400 = 0.5 → smoothstep 0.5 → halfway.
    const midM = ((mid.l[0.075 * FS - 1] ?? 0) + (mid.r[0.075 * FS - 1] ?? 0)) / 2;
    expect(midM).toBeCloseTo((cab + out) / 2, 9);
    render(m, 0.15 * FS + DELAY_N, dc);
    render(ref, 0.3 * FS + DELAY_N, dc);
    const s = sine(330, 0.4);
    const after = render(m, 2000, (i) => [s(i), s(i + 7), 0.1, 0.2 * s(i), 0]);
    const pure = render(ref, 2000, (i) => [s(i), s(i + 7), 0.1, 0.2 * s(i), 0]);
    expect(Array.from(after.l)).toEqual(Array.from(pure.l));
    expect(Array.from(after.r)).toEqual(Array.from(pure.r));
  });

  it('repeating setPerspective with the same value does not restart the crossfade', () => {
    const m = mixer('cabin');
    const ref = mixer('outside');
    render(m, 1000, dc, () => m.setPerspective('outside'));
    render(ref, 1000, dc);
    render(m, 0.3 * FS, dc, () => m.setPerspective('outside'));
    render(ref, 0.3 * FS, dc);
    const a = render(m, 500, dc);
    const b = render(ref, 500, dc);
    expect(Array.from(a.l)).toEqual(Array.from(b.l));
  });

  it('RF5: toggling perspective every 50 ms crossfades without any step > 0.1 full scale', () => {
    const e = sine(80, 0.5);
    const blk = sine(50, 0.3);
    const f = sine(1000, 0.3);
    const src: Src = (i) => [e(i), 0.2 * e(i + 13), blk(i), f(i), 0.05 * e(i + 29)];
    // Sensitivity: the two perspectives differ by far more than 0.1, so a hard switch would step.
    const cab = render(mixer('cabin'), FS, src);
    const out = render(mixer('outside'), FS, src);
    let maxDiff = 0;
    for (let i = FS / 10; i < FS; i++) maxDiff = Math.max(maxDiff, Math.abs((cab.l[i] ?? 0) - (out.l[i] ?? 0)));
    expect(maxDiff).toBeGreaterThan(0.2);

    const m = mixer('cabin');
    const toggleEvery = 0.05 * FS;
    const { l, r } = render(m, 2 * FS, src, (i) => {
      if (i > 0 && i % toggleEvery === 0) m.setPerspective((i / toggleEvery) % 2 === 1 ? 'outside' : 'cabin');
    });
    let maxStep = 0;
    for (let i = 1; i < l.length; i++) {
      maxStep = Math.max(maxStep, Math.abs((l[i] ?? 0) - (l[i - 1] ?? 0)), Math.abs((r[i] ?? 0) - (r[i - 1] ?? 0)));
    }
    expect(maxStep).toBeLessThan(0.1);
  });

  it('reset() clears state and snaps the crossfade to the target', () => {
    const m = mixer('cabin');
    render(m, 1000, dc);
    m.setPerspective('outside');
    render(m, 100, dc);
    m.reset();
    const ref = mixer('outside');
    const a = render(m, 300, dc);
    const b = render(ref, 300, dc);
    expect(Array.from(a.l)).toEqual(Array.from(b.l));
    expect(Array.from(a.r)).toEqual(Array.from(b.r));
  });
});
