/**
 * Phase 2b T1 — RPM tracking (src/lab/pitch.ts; phase 2b contract "Pitch / RPM tracking (T1)" as amended by D1 —
 * clamped per-bin contrast, fixed-band 20 Hz – 2 kHz emission normalisation, no silent fallback — and by D4, whose
 * acceptance supersedes D1.4's). Pinned first on synthetic harmonic engine signals whose rpm is known exactly, then
 * accepted per D4 over every cell the score CLI actually uses, each tracked with the contract's default options
 * through the score CLI's entry point trackOptionsForSegment:
 *  - the D4 synthetic idle stacks (firing harmonics 2..8 only, every amplitude law flat … h^−2) inside ±7 % and
 *    ±15 % hints;
 *  - Phase 2a DSP renders (tools/render.ts renderSegment over tools/segments.ts) of the five fixture engines with
 *    known rpm, cabin / outside × subwoofer 'yes' / 'no': the steady kinds (D4(1): idle, cruise2k/4k/6k, and the
 *    limiter-hold and pre-lift stretches tracked on their own) inside ±7 % and ±15 % hints around the expected rpm,
 *    and the sweeps (D4(2): wotPull, liftoff6k, and the last-gear-top and 2nd-upshift stretches) with their range hint
 *    and with none (the engine's idle..limiter).
 * Every cell must be never confidently wrong — each frame at confidence ≥ 0.5 within ±6 % of the true rpm — with a
 * median |error| ≤ 2 % over its voiced frames (D4(3)). Unvoiced frames are allowed: each cell's are reported as a test
 * annotation (shown by the verbose reporter, and with any failure), not gated, except a voiced share ≥ 0.4 on the
 * non-rotary wot cells (D4(4)). Frames whose rendered rpm varies by > 3 % within the analysis window (limiter bounce,
 * gear changes, fast ramps; D1.4) are left out of the median and the voiced share and counted in the test titles; at
 * confidence ≥ 0.5 they must still lie within ±6 % of their window's rendered rpm range. Wide idle..limiter searches
 * of idle segments are out of scope (D4(5); pitch.ts Limits), and the score CLI cannot request them: steady kinds
 * need a hint no wider than ±15 % (D4(1), trackOptionsForSegment), while trackRpm itself stays generic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { QUANTUM, type EngineDef, type Perspective } from '../../src/contracts';
import { RpmState } from '../../src/dsp/rpm-state';
import { Rng } from '../../src/dsp/util';
import {
  DEFAULT_HOP_S,
  DEFAULT_MAX_SLEW_RPM_PER_S,
  DEFAULT_WIN_S,
  RPM_GRID_STEP,
  SEGMENT_KINDS,
  STEADY_HINT_MAX,
  STEADY_KINDS,
  decimate,
  interpolateRpm,
  trackOptionsForEngine,
  trackOptionsForSegment,
  trackRpm,
  type RpmTrack,
  type SegmentKind,
  type TrackOptions,
} from '../../src/lab/pitch';
import { PREROLL_S, renderSegment } from '../../tools/render';
import { SEGMENTS, bindSegmentEngine, createBaseControl, type Segment } from '../../tools/segments';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;

/** One spectral line of a synthetic engine signal: `amp`·cos(2π·order·crankCycles + phase). */
type Line = readonly [order: number, amp: number];

/**
 * Phase-continuous synthetic engine signal: the crank phase integrates rpm(t)/60, and every line sits at a
 * fixed order of it (so a ramp moves all lines together, exactly like an engine). Optional seeded white noise.
 */
function engineSignal(durS: number, rpmAt: (tS: number) => number, lines: readonly Line[], noiseRms = 0, seed = 1): Float64Array {
  const n = Math.round(durS * FS);
  const x = new Float64Array(n);
  const rng = new Rng(seed);
  let cycles = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    lines.forEach(([order, amp], j) => {
      v += amp * Math.cos(2 * Math.PI * order * cycles + 0.9 * j);
    });
    x[i] = v + (noiseRms > 0 ? noiseRms * rng.gauss() : 0);
    cycles += rpmAt(i / FS) / 60 / FS;
  }
  return x;
}

/** Firing harmonics h·F (h = from..count) with amplitude h^−law (default 1/h), plus optional extra lines. */
function firingLines(firingsPerRev: number, count: number, extra: readonly Line[] = [], from = 1, law = 1): Line[] {
  const out: Line[] = [];
  for (let h = from; h <= count; h++) out.push([h * firingsPerRev, h ** -law]);
  return [...out, ...extra];
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  return n % 2 === 1 ? (s[(n - 1) / 2] ?? Number.NaN) : 0.5 * ((s[n / 2 - 1] ?? 0) + (s[n / 2] ?? 0));
}

/** Relative errors |est − true| / true of the voiced (non-NaN) frames, with the truth sampled at the frame centres. */
function relErrors(track: RpmTrack, truthAt: (tS: number) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < track.t.length; i++) {
    const est = track.rpm[i] ?? Number.NaN;
    if (Number.isNaN(est)) continue;
    const truth = truthAt(track.t[i] ?? 0);
    out.push(Math.abs(est - truth) / truth);
  }
  return out;
}

/** Number of unvoiced (NaN) frames. */
function unvoiced(track: RpmTrack): number {
  let n = 0;
  for (const r of track.rpm) if (Number.isNaN(r)) n++;
  return n;
}

/** An estimate whose ratio to the truth lies outside [0.94, 1.06] (D1.4's octave error, D4(3)'s ± 6 %). */
function isOctaveError(est: number, truth: number): boolean {
  const ratio = est / truth;
  return !(ratio >= 0.94 && ratio <= 1.06);
}

const I4: Pick<TrackOptions, 'firingsPerRev' | 'subOrderStep'> = { firingsPerRev: 2, subOrderStep: 0.5 };
const I5: Pick<TrackOptions, 'firingsPerRev' | 'subOrderStep'> = { firingsPerRev: 2.5, subOrderStep: 0.5 };
const V8: Pick<TrackOptions, 'firingsPerRev' | 'subOrderStep'> = { firingsPerRev: 4, subOrderStep: 0.5 };
const ROTARY: Pick<TrackOptions, 'firingsPerRev' | 'subOrderStep'> = { firingsPerRev: 2, subOrderStep: 1 / 3 };

describe('trackRpm — synthetic harmonic engine signals', () => {
  const geometries = [
    ['I4', I4],
    ['I5', I5],
    ['V8', V8],
    ['rotary', ROTARY],
  ] as const;

  it.each(geometries)('recovers a steady %s at 3000 rpm to within 0.5 % in every frame', (_name, geo) => {
    const x = engineSignal(2, () => 3000, firingLines(geo.firingsPerRev, 6));
    const tr = trackRpm(x, FS, { ...geo, rpmMin: 700, rpmMax: 7000 });
    expect(tr.t.length).toBeGreaterThan(80);
    expect(unvoiced(tr)).toBe(0);
    expect(Math.max(...relErrors(tr, () => 3000))).toBeLessThanOrEqual(0.005);
  });

  it.each(geometries)('follows a %s ramp 1000 → 5000 rpm (2000 rpm/s) with no octave error', (_name, geo) => {
    const rpmAt = (t: number): number => 1000 + 2000 * Math.min(2, t);
    const x = engineSignal(2.2, rpmAt, firingLines(geo.firingsPerRev, 6));
    const tr = trackRpm(x, FS, { ...geo, rpmMin: 700, rpmMax: 7000 });
    expect(unvoiced(tr)).toBe(0);
    const err = relErrors(tr, rpmAt);
    expect(median(err)).toBeLessThanOrEqual(0.01);
    expect(Math.max(...err)).toBeLessThanOrEqual(0.05);
  });

  it('is not pulled an octave up when the 2nd firing harmonic is twice as strong as the fundamental', () => {
    // I4 at 2500 rpm: order 2 = 83 Hz at 0.5, order 4 = 167 Hz at 1.0 (a typical exhaust-resonance boost).
    const lines: Line[] = [[2, 0.5], [4, 1], [6, 0.4], [8, 0.25], [10, 0.15]];
    const tr = trackRpm(engineSignal(2, () => 2500, lines), FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    expect(unvoiced(tr)).toBe(0);
    expect(median(relErrors(tr, () => 2500))).toBeLessThanOrEqual(0.005);
    for (const r of tr.rpm) expect(isOctaveError(r, 2500)).toBe(false);
  });

  it('is not pulled an octave down by strong half-firing and cycle orders (cross-plane V8 rumble)', () => {
    // V8 at 4000 rpm: firing order 4 dominant, order 2 at 0.45 of it, plus orders 1, 3 and the half orders.
    const lines = firingLines(4, 5, [[2, 0.45], [1, 0.2], [3, 0.3], [0.5, 0.1], [1.5, 0.1], [2.5, 0.15], [3.5, 0.15]]);
    const tr = trackRpm(engineSignal(2, () => 4000, lines), FS, { ...V8, rpmMin: 650, rpmMax: 7000 });
    expect(unvoiced(tr)).toBe(0);
    expect(median(relErrors(tr, () => 4000))).toBeLessThanOrEqual(0.005);
    for (const r of tr.rpm) expect(isOctaveError(r, 4000)).toBe(false);
  });

  it('locks a rotary onto its 2nd e-shaft order despite strong ⅓-order sidebands', () => {
    // Rotary at 6000 rpm: order 2 with sidebands at 5/3 and 7/3 at 0.6 of it, plus weaker ⅓ orders.
    const lines = firingLines(2, 4, [[5 / 3, 0.6], [7 / 3, 0.6], [1 / 3, 0.15], [2 / 3, 0.2], [4 / 3, 0.25], [11 / 3, 0.2], [13 / 3, 0.2]]);
    const tr = trackRpm(engineSignal(2, () => 6000, lines), FS, { ...ROTARY, rpmMin: 800, rpmMax: 8200 });
    expect(unvoiced(tr)).toBe(0);
    expect(median(relErrors(tr, () => 6000))).toBeLessThanOrEqual(0.005);
    for (const r of tr.rpm) expect(isOctaveError(r, 6000)).toBe(false);
  });

  it('only the sub-order bins tell 4500 rpm from 9000 rpm: half-order lines over even firing harmonics', () => {
    // V8 at 4500 rpm (crank 75 Hz; sub-order spacing 37.5 Hz = 4.5 / winS, so the sub-order term has full
    // weight at both candidates). Firing orders 8, 16, 24, 32 only (the even firing harmonics, amplitude 1/h):
    // that is exactly the firing comb of a V8 at 9000 rpm, which the harmonic term alone prefers (its weight-1
    // tooth sits on the strongest line). Half-order lines at orders 0.5–3.5 are sub-orders of 4500 rpm only —
    // 9000 rpm's sub-order bins fall on the integer orders 1–7, where there is nothing.
    const even: Line[] = [[8, 1 / 2], [16, 1 / 4], [24, 1 / 6], [32, 1 / 8]];
    const half: Line[] = [[0.5, 0.25], [1.5, 0.25], [2.5, 0.25], [3.5, 0.25]];
    const o: TrackOptions = { ...V8, rpmMin: 650, rpmMax: 9500 };
    const comb = trackRpm(engineSignal(2, () => 4500, even), FS, o);
    expect(unvoiced(comb)).toBe(0);
    for (const r of comb.rpm) expect(Math.abs(r / 9000 - 1)).toBeLessThanOrEqual(0.005); // a V8 at 9000 rpm
    const withHalf = trackRpm(engineSignal(2, () => 4500, [...even, ...half]), FS, o);
    expect(unvoiced(withHalf)).toBe(0);
    for (const r of withHalf.rpm) expect(Math.abs(r / 4500 - 1)).toBeLessThanOrEqual(0.005);
  });

  it('stays within 1 % in broadband white noise at 0 dB SNR', () => {
    const clean = firingLines(4, 6);
    let power = 0;
    for (const [, a] of clean) power += (a * a) / 2;
    const tr = trackRpm(engineSignal(2, () => 4000, clean, Math.sqrt(power), 11), FS, { ...V8, rpmMin: 650, rpmMax: 7000 });
    expect(unvoiced(tr)).toBeLessThanOrEqual(0.05 * tr.t.length);
    expect(median(relErrors(tr, () => 4000))).toBeLessThanOrEqual(0.01);
  });

  it('reports no rpm (NaN, confidence 0) where the engine is absent, and tracks it on both sides of the gap', () => {
    // 1 s engine at 3500 rpm, 1 s white noise only, 1 s engine at 3500 rpm.
    const engine = engineSignal(3, () => 3500, firingLines(2, 6));
    const rng = new Rng(5);
    const x = new Float64Array(engine.length);
    for (let i = 0; i < x.length; i++) {
      const inGap = i >= FS && i < 2 * FS;
      x[i] = (inGap ? 0 : (engine[i] ?? 0)) + 0.05 * rng.gauss();
    }
    const tr = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    const half = DEFAULT_WIN_S / 2;
    let gapFrames = 0;
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i] ?? 0;
      const r = tr.rpm[i] ?? Number.NaN;
      if (t - half >= 1 && t + half <= 2) {
        // The whole window is noise: no candidate clears the voicing floor (D1.3).
        gapFrames++;
        expect(r, `t = ${t.toFixed(2)} s`).toBeNaN();
        expect(tr.confidence[i], `t = ${t.toFixed(2)} s`).toBe(0);
      } else if (t + half <= 1 || t - half >= 2) {
        expect(Math.abs(r / 3500 - 1), `t = ${t.toFixed(2)} s`).toBeLessThanOrEqual(0.01);
      }
    }
    expect(gapFrames).toBeGreaterThan(30);
  });

  it('reads NaN, not a carried-over rpm, where an unrelated comb masks the engine for a moment', () => {
    // I4 at 6000 rpm; for 0.3 s the engine drops 30 dB under a strong unrelated harmonic stack (30 Hz × 1..8, an
    // I4 comb at 900 rpm, e.g. a horn or fan). Those frames carry evidence, but not for any rpm the path can
    // reach and leave again within 0.3 s at 6000 rpm/s, and the engine's own comb is below the voicing floor:
    // the tracked rpm there is unsupported, so it is not reported.
    const n = Math.round(2.3 * FS);
    const masked = (t: number): boolean => t >= 1 && t < 1.3;
    const x = new Float64Array(n);
    const rng = new Rng(7);
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += ((masked(t) ? 0.03 : 1) / h) * Math.cos(2 * Math.PI * h * 200 * t + 0.9 * h);
      if (masked(t)) for (let h = 1; h <= 8; h++) v += (1 / h) * Math.cos(2 * Math.PI * h * 30 * t + 0.4 * h);
      x[i] = v + 0.01 * rng.gauss();
    }
    const tr = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    const half = DEFAULT_WIN_S / 2;
    let inside = 0;
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i] ?? 0;
      const r = tr.rpm[i] ?? Number.NaN;
      if (t - half >= 1 && t + half <= 1.3) {
        inside++;
        expect(r, `t = ${t.toFixed(2)} s`).toBeNaN();
      } else if (t + half <= 1 || t - half >= 1.3) {
        expect(Math.abs(r / 6000 - 1), `t = ${t.toFixed(2)} s`).toBeLessThanOrEqual(0.005);
      }
    }
    expect(inside).toBeGreaterThan(5);
  });

  it('a wide slew bound does not make the path jumpier: brief unrelated combs over a steady engine do not capture it', () => {
    // I4 at 6000 rpm throughout; every 0.4 s an 80 ms burst of a stronger I4-like comb at 4000 rpm. At 60 000 rpm/s
    // the path could jump to each burst, but the transition cost per rpm does not shrink with the bound.
    const n = 3 * FS;
    const x = new Float64Array(n);
    const rng = new Rng(3);
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      const burst = t % 0.4 >= 0.2 && t % 0.4 < 0.28;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += (1 / h) * Math.cos(2 * Math.PI * h * 200 * t + 0.9 * h);
      if (burst) for (let h = 1; h <= 8; h++) v += (2 / h) * Math.cos(2 * Math.PI * h * (400 / 3) * t + 0.4 * h);
      x[i] = v + 0.01 * rng.gauss();
    }
    const tr = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000, maxSlewRpmPerS: 60_000 });
    expect(unvoiced(tr)).toBeLessThanOrEqual(0.05 * tr.t.length);
    for (const r of tr.rpm) if (!Number.isNaN(r)) expect(Math.abs(r / 6000 - 1)).toBeLessThanOrEqual(0.005);
  });

  it('returns all NaN with zero confidence for a segment without an engine (no silent fallback to rpmMin)', () => {
    const rng = new Rng(9);
    const noise = new Float64Array(2 * FS);
    for (let i = 0; i < noise.length; i++) noise[i] = rng.gauss();
    for (const [name, x] of [
      ['white noise', noise],
      ['silence', new Float64Array(FS)],
    ] as const) {
      for (const [geoName, geo] of geometries) {
        const tr = trackRpm(x, FS, { ...geo, rpmMin: 700, rpmMax: 7000 });
        expect(tr.t.length).toBeGreaterThan(0);
        expect(unvoiced(tr), `${name} ${geoName}`).toBe(tr.t.length);
        for (const c of tr.confidence) expect(c).toBe(0);
      }
    }
  });

  it('voices and tracks a frame independently of the search range (fixed-band emission normalisation, D1.2)', () => {
    // An engine fading out into noise: the frames near the end drop below the voicing floor. A narrow range
    // and a wide one around the truth decide the same frames (an odd window length keeps both at full rate).
    const n = 3 * FS;
    const engine = engineSignal(3, () => 3000, firingLines(2, 6));
    const rng = new Rng(21);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = (engine[i] ?? 0) * Math.max(0, 1 - i / n) ** 3 + 0.02 * rng.gauss();
    const wide = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000, winS: 0.1201 });
    const narrow = trackRpm(x, FS, { ...I4, rpmMin: 2800, rpmMax: 3200, winS: 0.1201 });
    expect(unvoiced(wide)).toBeGreaterThan(10);
    expect(unvoiced(wide)).toBeLessThan(wide.t.length - 10);
    expect(narrow.rpm).toEqual(wide.rpm);
  });
});

describe('trackRpm — output shape and contract options', () => {
  const x = engineSignal(1.5, (t) => 2000 + 1000 * t, firingLines(2, 6));

  it('emits frame-centre times on the default hop and window, rpm on the 10 rpm grid, confidence in [0, 1]', () => {
    const tr = trackRpm(x, FS, { ...I4, rpmMin: 705, rpmMax: 7000 });
    const winN = Math.round(DEFAULT_WIN_S * FS);
    const hopN = Math.round(DEFAULT_HOP_S * FS);
    expect(tr.hopS).toBe(hopN / FS);
    expect(tr.t.length).toBe(Math.floor((x.length - winN) / hopN) + 1);
    expect(tr.rpm.length).toBe(tr.t.length);
    expect(tr.confidence.length).toBe(tr.t.length);
    expect(tr.t[0]).toBeCloseTo((winN - 1) / 2 / FS, 12);
    expect((tr.t[1] ?? 0) - (tr.t[0] ?? 0)).toBeCloseTo(tr.hopS, 12);
    expect(unvoiced(tr)).toBe(0);
    let maxConf = 0;
    for (let i = 0; i < tr.t.length; i++) {
      const r = tr.rpm[i] ?? 0;
      expect((r - 705) / RPM_GRID_STEP).toBeCloseTo(Math.round((r - 705) / RPM_GRID_STEP), 9);
      expect(r).toBeGreaterThanOrEqual(705);
      expect(r).toBeLessThanOrEqual(7000);
      const c = tr.confidence[i] ?? -1;
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
      maxConf = Math.max(maxConf, c);
    }
    expect(maxConf).toBe(1);
  });

  it('never moves faster than maxSlewRpmPerS between frames (default, custom, and exactly one grid step per hop)', () => {
    // An instantaneous 6000 → 3000 rpm step, which the path may only follow at the Viterbi slew limit.
    const step = engineSignal(1.5, (t) => (t < 0.75 ? 6000 : 3000), firingLines(2, 6));
    for (const maxSlew of [undefined, 2000, RPM_GRID_STEP / DEFAULT_HOP_S]) {
      const tr = trackRpm(step, FS, { ...I4, rpmMin: 700, rpmMax: 7000, maxSlewRpmPerS: maxSlew });
      const limit = (maxSlew ?? DEFAULT_MAX_SLEW_RPM_PER_S) * tr.hopS + 1e-9;
      let last = -1;
      for (let i = 0; i < tr.rpm.length; i++) {
        if (Number.isNaN(tr.rpm[i] ?? Number.NaN)) continue;
        if (last >= 0) expect(Math.abs((tr.rpm[i] ?? 0) - (tr.rpm[last] ?? 0))).toBeLessThanOrEqual(limit * (i - last));
        last = i;
      }
      expect(last).toBeGreaterThan(0);
    }
  });

  it('follows a fast drop once the window has passed it when maxSlewRpmPerS allows (a gear change)', () => {
    // 6000 → 3000 rpm in one sample: at 60 000 rpm/s the path may move 1200 rpm per 20 ms hop.
    const step = engineSignal(1.5, (t) => (t < 0.75 ? 6000 : 3000), firingLines(2, 6));
    const tr = trackRpm(step, FS, { ...I4, rpmMin: 700, rpmMax: 7000, maxSlewRpmPerS: 60_000 });
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i] ?? 0;
      const want = t - DEFAULT_WIN_S / 2 >= 0.75 ? 3000 : t + DEFAULT_WIN_S / 2 < 0.75 ? 6000 : Number.NaN;
      if (Number.isNaN(want)) continue;
      expect(Math.abs((tr.rpm[i] ?? 0) / want - 1), `t = ${t.toFixed(2)} s`).toBeLessThanOrEqual(0.005);
    }
  });

  it('honours custom hopS and winS', () => {
    const tr = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000, hopS: 0.05, winS: 0.2 });
    expect(tr.hopS).toBe(0.05);
    expect(tr.t.length).toBe(Math.floor((x.length - 0.2 * FS) / (0.05 * FS)) + 1);
    expect(tr.t[0]).toBeCloseTo((0.2 * FS - 1) / 2 / FS, 12);
    expect(unvoiced(tr)).toBe(0);
    expect(median(relErrors(tr, (t) => 2000 + 1000 * t))).toBeLessThanOrEqual(0.01);
  });

  it('is deterministic: identical inputs give bit-identical tracks', () => {
    const a = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    const b = trackRpm(Float32Array.from(x), FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    const c = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    expect(c).toEqual(a);
    // Any ArrayLike works: a plain array of the same values gives the same track …
    expect(trackRpm(Array.from(x), FS, { ...I4, rpmMin: 700, rpmMax: 7000 })).toEqual(a);
    // … and Float32 input differs from Float64 only by rounding, which leaves the path unchanged.
    expect(b.rpm).toEqual(a.rpm);
  });

  it('returns an empty track for signals shorter than one window', () => {
    const short = trackRpm(new Float64Array(1000), FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    expect(short.t.length).toBe(0);
    expect(short.rpm.length).toBe(0);
    expect(short.confidence.length).toBe(0);
  });

  it('rejects invalid options and non-finite samples', () => {
    const ok: TrackOptions = { ...I4, rpmMin: 700, rpmMax: 7000 };
    const bad: Partial<TrackOptions>[] = [
      { firingsPerRev: 0 },
      { firingsPerRev: Number.NaN },
      { subOrderStep: 0 },
      { subOrderStep: 3 },
      { rpmMin: 0 },
      { rpmMin: 8000 },
      { rpmMax: Number.POSITIVE_INFINITY },
      { hopS: 0 },
      { winS: -1 },
      { maxSlewRpmPerS: 0 },
    ];
    for (const b of bad) expect(() => trackRpm(x, FS, { ...ok, ...b }), JSON.stringify(b)).toThrow(RangeError);
    // Below one RPM_GRID_STEP per hop the slew limit cannot be represented on the candidate grid:
    // 100 rpm/s × 20 ms = 2 rpm per frame, and the default 6000 rpm/s × 1 ms = 6 rpm per frame.
    for (const b of [{ maxSlewRpmPerS: 100 }, { hopS: 0.001 }]) {
      expect(() => trackRpm(x, FS, { ...ok, ...b }), JSON.stringify(b)).toThrow(/one grid step per frame/);
    }
    expect(() => trackRpm(x, 0, ok)).toThrow(RangeError);
    const nan = Float64Array.from(x);
    nan[100] = Number.NaN;
    expect(() => trackRpm(nan, FS, ok)).toThrow(RangeError);
  });
});

describe('trackOptionsForEngine / interpolateRpm', () => {
  it('derives the firing order and sub-order step from the spec (contracts.firingHz basis), idle..limiter range', () => {
    const v8 = loadFixture('v8-crossplane-test').spec;
    expect(trackOptionsForEngine(v8)).toEqual({ firingsPerRev: 4, subOrderStep: 0.5, rpmMin: 650, rpmMax: 6700 });
    const rotary = loadFixture('rotary-test').spec;
    const o = trackOptionsForEngine(rotary, [2500, 7000]);
    expect(o.firingsPerRev).toBeCloseTo(2, 12);
    expect(o.subOrderStep).toBeCloseTo(1 / 3, 12);
    expect([o.rpmMin, o.rpmMax]).toEqual([2500, 7000]);
    expect(trackOptionsForEngine(loadFixture('i5-test').spec).firingsPerRev).toBe(2.5);
  });

  it('interpolates linearly between frame centres and clamps outside them', () => {
    const tr: RpmTrack = { hopS: 0.02, t: Float64Array.of(0.06, 0.08, 0.1), rpm: Float64Array.of(1000, 2000, 2000), confidence: Float64Array.of(1, 1, 1) };
    expect(interpolateRpm(tr, 0)).toBe(1000);
    expect(interpolateRpm(tr, 0.07)).toBeCloseTo(1500, 9);
    expect(interpolateRpm(tr, 0.09)).toBeCloseTo(2000, 9);
    expect(interpolateRpm(tr, 5)).toBe(2000);
    expect(interpolateRpm({ ...tr, t: new Float64Array(0), rpm: new Float64Array(0), confidence: new Float64Array(0) }, 1)).toBeNaN();
    // A NaN time is corrupt input: it stays visible instead of reading as the first frame's rpm.
    expect(interpolateRpm(tr, Number.NaN)).toBeNaN();
  });

  it('is NaN next to an unvoiced frame and exact at a voiced frame centre (callers skip unvoiced stretches)', () => {
    const tr: RpmTrack = {
      hopS: 0.02,
      t: Float64Array.of(0.06, 0.08, 0.1, 0.12),
      rpm: Float64Array.of(1000, Number.NaN, 2000, 3000),
      confidence: Float64Array.of(1, 0, 1, 1),
    };
    expect(interpolateRpm(tr, 0.06)).toBe(1000);
    expect(interpolateRpm(tr, 0.07)).toBeNaN();
    expect(interpolateRpm(tr, 0.08)).toBeNaN();
    expect(interpolateRpm(tr, 0.09)).toBeNaN();
    expect(interpolateRpm(tr, 0.1)).toBe(2000);
    expect(interpolateRpm(tr, 0.11)).toBeCloseTo(2500, 9);
    expect(interpolateRpm({ ...tr, rpm: Float64Array.of(Number.NaN, 1000, 1000, 1000) }, 0)).toBeNaN();
  });
});

describe("trackOptionsForSegment — the score CLI's tracking request for an \"auto\" sidecar segment (D4(1), D4(2))", () => {
  const spec = loadFixture('i4-test').spec; // idle 750 rpm, limiter 6600 rpm
  const steady = ['idle', 'cruise', 'limiter'] as const;

  it('knows the contract segment kinds, and idle, cruise and limiter as the steady ones', () => {
    expect([...SEGMENT_KINDS].sort()).toEqual(['cruise', 'idle', 'liftoff', 'limiter', 'wot']);
    expect([...STEADY_KINDS].sort()).toEqual([...steady].sort());
    expect(STEADY_HINT_MAX).toBe(0.15);
  });

  it('refuses (RangeError) a steady-kind request without an rpmHint or with one wider than ±15 % around its centre', () => {
    for (const kind of steady) {
      expect(() => trackOptionsForSegment(spec, kind), `${kind}, no hint`).toThrow(RangeError);
      for (const hint of [
        [750, 6600], // the engine's idle..limiter: the D4(5) case that can lock at 2–3 ×
        [600, 900], // ±20 % around 750
        [0.85 * 750, 1.151 * 750], // just over ±15 %
        [3400, 4700], // ±16 % around 4050: the bound is relative to the hint's own centre
      ] as const) {
        expect(() => trackOptionsForSegment(spec, kind, hint), `${kind} [${hint.join(', ')}]`).toThrow(/±15 %/);
      }
    }
  });

  it('passes steady hints up to ±15 % around their centre through as the search range, wherever they lie', () => {
    for (const kind of steady) {
      for (const hint of [
        [0.85 * 750, 1.15 * 750], // exactly ±15 %
        [650, 850], // T7's rounded ±7 % idle hint
        [0.93 * 4000, 1.07 * 4000],
        [3400, 4600], // ±15 % around 4000, far from the idle
        [6600, 6600], // a single candidate
      ] as const) {
        expect(trackOptionsForSegment(spec, kind, hint), `${kind} [${hint.join(', ')}]`).toEqual(trackOptionsForEngine(spec, hint));
      }
    }
  });

  it('lets a sweep (wot, liftoff) use any range hint, and the engine idle..limiter without one (Viterbi continuity, D4(2))', () => {
    for (const kind of ['wot', 'liftoff'] as const) {
      expect(trackOptionsForSegment(spec, kind, [2500, 7000])).toEqual(trackOptionsForEngine(spec, [2500, 7000]));
      expect(trackOptionsForSegment(spec, kind)).toEqual(trackOptionsForEngine(spec));
    }
  });

  it('rejects unknown kinds and malformed hints (sidecars are untrusted JSON)', () => {
    expect(() => trackOptionsForSegment(spec, 'launch' as SegmentKind, [700, 800])).toThrow(RangeError);
    for (const kind of ['idle', 'wot'] as const) {
      for (const hint of [
        [800, 700],
        [0, 800],
        [-700, 800],
        [700, Number.NaN],
        [Number.NaN, 800],
        [700, Number.POSITIVE_INFINITY],
      ] as const) {
        expect(() => trackOptionsForSegment(spec, kind, hint), `${kind} [${hint.join(', ')}]`).toThrow(RangeError);
      }
    }
  });

  it('trackRpm itself stays generic: no segment kinds, any range (the refusal is the score CLI\'s, above)', () => {
    // An I4 idle stack searched over idle..limiter, the request trackOptionsForSegment refuses for an idle segment.
    const x = engineSignal(1, () => 750, firingLines(2, 8));
    const tr = trackRpm(x, FS, trackOptionsForEngine(spec));
    expect(tr.t.length).toBe(Math.floor((x.length - Math.round(DEFAULT_WIN_S * FS)) / Math.round(DEFAULT_HOP_S * FS)) + 1);
  });
});

describe('decimation (speed only: same window, same bin spacing, smaller FFT)', () => {
  /** Interior samples of decimate(cos(2π·f·t), d) and the input at the kept instants m·d (filter edges excluded). */
  function tone(f: number, d: number): { y: Float64Array; ref: Float64Array } {
    const n = Math.round(0.5 * FS);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.cos((2 * Math.PI * f * i) / FS);
    const y = decimate(x, d);
    expect(y.length).toBe(Math.ceil(n / d));
    const edge = 40; // > the 14-sample filter half-length in output samples
    const out = y.subarray(edge, y.length - edge);
    const ref = new Float64Array(out.length);
    for (let m = 0; m < out.length; m++) ref[m] = x[(m + edge) * d] ?? 0;
    return { y: out, ref };
  }

  it.each([2, 4, 8, 16])('d = %i: zero-phase and flat to 0.4·fs/d, ≥ 70 dB down from 0.6·fs/d', (d) => {
    const fsOut = FS / d;
    for (const f of [0.05 * fsOut, 0.2 * fsOut, 0.4 * fsOut]) {
      const { y, ref } = tone(f, d);
      let err = 0;
      for (let m = 0; m < y.length; m++) err = Math.max(err, Math.abs((y[m] ?? 0) - (ref[m] ?? 0)));
      expect(err, `passband ${f.toFixed(0)} Hz`).toBeLessThanOrEqual(0.002); // gain within ±0.02 dB, no delay (measured 2e-4)
    }
    for (const f of [0.6 * fsOut, 0.75 * fsOut, 0.95 * fsOut, 1.4 * fsOut]) {
      const { y } = tone(f, d);
      let peak = 0;
      for (const v of y) peak = Math.max(peak, Math.abs(v));
      expect(peak, `stopband ${f.toFixed(0)} Hz`).toBeLessThanOrEqual(10 ** (-70 / 20)); // measured −75.5 dB
    }
  });

  it('rejects a decimation factor that is not a positive integer (d = 1 is the identity)', () => {
    const rng = new Rng(2);
    const x = new Float64Array(100);
    for (let i = 0; i < x.length; i++) x[i] = rng.gauss();
    for (const d of [0, -2, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decimate(x, d), String(d)).toThrow(RangeError);
    }
    const y = decimate(x, 1);
    expect(y.length).toBe(x.length);
    for (let i = 0; i < x.length; i++) expect(y[i]).toBeCloseTo(x[i] ?? 0, 12);
  });

  it('the decimated analysis matches the full-rate one (an odd window length disables decimation)', () => {
    // Decimation needs a window and hop divisible by 2·d: 5760 samples (0.12 s) are decimated, 5765 (0.1201 s)
    // are not. A strong 5.8 kHz tone above the analysed band folds into it unless the anti-alias filter removes it.
    const rpmAt = (t: number): number => 1500 + 2000 * Math.min(2, t);
    const x = engineSignal(2.2, rpmAt, firingLines(2, 6, [[1, 0.3], [3, 0.2]]), 0.2, 4);
    for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) + 3 * Math.cos((2 * Math.PI * 5800 * i) / FS);
    const decimated = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000 });
    const fullRate = trackRpm(x, FS, { ...I4, rpmMin: 700, rpmMax: 7000, winS: 0.1201 });
    const n = Math.min(decimated.t.length, fullRate.t.length);
    expect(n).toBeGreaterThan(100);
    let equal = 0;
    for (let i = 0; i < n; i++) {
      const a = decimated.rpm[i] ?? Number.NaN;
      const b = fullRate.rpm[i] ?? Number.NaN;
      expect(Number.isNaN(a), `frame ${i}`).toBe(Number.isNaN(b));
      if (Number.isNaN(a)) continue;
      if (a === b) equal++;
      expect(Math.abs(a - b), `frame ${i}`).toBeLessThanOrEqual(RPM_GRID_STEP);
    }
    expect(equal / n).toBeGreaterThanOrEqual(0.99);
    expect(unvoiced(fullRate)).toBe(0);
    expect(median(relErrors(fullRate, rpmAt))).toBeLessThanOrEqual(0.01);
  });
});

// ───────────────────────────── D4 acceptance: never confidently wrong ─────────────────────────────

/** D4(3): every frame at confidence ≥ CONFIDENT … */
const CONFIDENT = 0.5;
/** … lies within ± this fraction of the true rpm (a frame excluded per D1.4: of its window's rendered rpm range). */
const MAX_CONFIDENT_ERROR = 0.06;
/** D4(3): median |error| / truth over a cell's voiced (scored) frames. */
const MAX_MEDIAN_ERROR = 0.02;
/** D4(4): voiced-share floor of the non-rotary wot cells; nothing else gates unvoiced frames. */
const WOT_VOICED_FLOOR = 0.4;

/** The rendered rpm range [min, max] within one analysis window. */
interface Window {
  min: number;
  max: number;
}

/** D1.4: frames whose rendered rpm varies by more than this within the analysis window are excluded (and counted). */
const MAX_WINDOW_VARIATION = 0.03;
const isExcluded = (w: Window): boolean => !(w.max - w.min <= MAX_WINDOW_VARIATION * w.min);

/** D4(3) evaluation of one tracked cell; the caller asserts (expectD4) and reports (reportLine). */
interface Verdict {
  label: string;
  frames: number;
  /** D1.4-excluded frames: out of the median and the voiced share, still checked at confidence ≥ CONFIDENT. */
  excluded: number;
  /** Voiced frames among the others: every one of them is scored. */
  voiced: number;
  /** Median |error| / truth over the scored frames; NaN when none is voiced. */
  median: number;
  /** Frames at confidence ≥ CONFIDENT … */
  confident: number;
  /** … the largest |error| / truth among them (an excluded frame's: to its window's range; 0 when there are none) … */
  maxConfidentError: number;
  /** … and those more than MAX_CONFIDENT_ERROR off. */
  confidentlyWrong: string[];
}

/**
 * Scores `tr` frame by frame: `windows[i]` is the rendered rpm range within frame i's analysis window (D1.4 exclusion)
 * and `truthAt(i)` the true rpm at its centre. `t0` (s) only shifts the times in the messages.
 */
function judge(label: string, tr: RpmTrack, windows: readonly Window[], truthAt: (i: number) => number, t0 = 0): Verdict {
  expect(windows.length, `${label}: one window per frame`).toBe(tr.t.length);
  let excluded = 0;
  let confident = 0;
  let maxConfidentError = 0;
  const errors: number[] = [];
  const confidentlyWrong: string[] = [];
  for (let i = 0; i < tr.t.length; i++) {
    const w = windows[i] ?? { min: Number.NaN, max: Number.NaN };
    const got = tr.rpm[i] ?? Number.NaN;
    const out = isExcluded(w);
    if (out) excluded++;
    if (Number.isNaN(got)) continue;
    let error: number;
    let truth: string;
    if (out) {
      error = got < w.min ? (w.min - got) / w.min : got > w.max ? (got - w.max) / w.max : 0;
      truth = `${w.min.toFixed(0)}–${w.max.toFixed(0)}`;
    } else {
      const want = truthAt(i);
      error = Math.abs(got - want) / want;
      truth = want.toFixed(0);
      errors.push(error);
    }
    const conf = tr.confidence[i] ?? 0;
    if (conf >= CONFIDENT) {
      confident++;
      maxConfidentError = Math.max(maxConfidentError, error);
      if (!(error <= MAX_CONFIDENT_ERROR)) {
        const at = (t0 + (tr.t[i] ?? 0)).toFixed(2);
        confidentlyWrong.push(`${at} s: ${got.toFixed(0)} rpm at confidence ${conf.toFixed(2)} vs ${truth}`);
      }
    }
  }
  return {
    label,
    frames: tr.t.length,
    excluded,
    voiced: errors.length,
    median: median(errors),
    confident,
    maxConfidentError,
    confidentlyWrong,
  };
}

/** A percentage with two decimals, for the reports; '—' for NaN. */
const pct = (v: number): string => (Number.isNaN(v) ? '—' : `${(100 * v).toFixed(2)} %`);
/** A whole-number percentage of a fraction, for titles: whole(0.07) = '7'. */
const whole = (f: number): string => (100 * f).toFixed(0);

/** D4(3) — never confidently wrong, median |error| ≤ 2 % over the voiced frames — and, given, the D4(4) voiced-share floor. */
function expectD4(v: Verdict, voicedFloor?: number): void {
  const wrong = `${v.label}: frames at confidence ≥ ${CONFIDENT} more than ±${whole(MAX_CONFIDENT_ERROR)} % off the true rpm`;
  expect.soft(v.confidentlyWrong, wrong).toEqual([]);
  if (v.voiced > 0) expect.soft(v.median, `${v.label}: median |error| over the voiced frames`).toBeLessThanOrEqual(MAX_MEDIAN_ERROR);
  if (voicedFloor !== undefined) {
    expect.soft(v.frames, `${v.label}: frames left after the exclusion`).toBeGreaterThan(v.excluded);
    expect.soft(v.voiced / (v.frames - v.excluded), `${v.label}: voiced share`).toBeGreaterThanOrEqual(voicedFloor);
  }
}

/** D4(4): what a cell left unvoiced, with its accuracy, for the test annotations. */
function reportLine(v: Verdict): string {
  const scored = v.frames - v.excluded;
  const excluded = v.excluded > 0 ? ` (${v.excluded} more excluded)` : '';
  const confident = `${v.confident} frames at confidence ≥ ${CONFIDENT}, largest |error| ${pct(v.maxConfidentError)}`;
  return `${v.label}: ${scored - v.voiced} of ${scored} frames unvoiced${excluded}; median |error| ${pct(v.median)}; ${confident}`;
}

/** The test context's annotate (Vitest). */
type Annotate = (message: string, type?: string) => Promise<unknown>;

/**
 * Reports every verdict of a test (D4(4): unvoiced frames are reported, not gated) before any of them is asserted: once a
 * soft assertion has failed, Vitest refuses further annotations of the test, so a failing test still lists every cell.
 */
async function reportAll(verdicts: readonly Verdict[], annotate: Annotate): Promise<void> {
  for (const v of verdicts) await annotate(reportLine(v), 'voicing');
}

/** D4(1) / D4(3): steady segments are tracked inside hints of ± these fractions around the expected rpm. */
const STEADY_HINTS = [0.07, 0.15] as const;
const around = (expected: number, p: number): [number, number] => [(1 - p) * expected, (1 + p) * expected];

// D4(3) synthetic stacks: firing harmonics 2..8 only (no fundamental) at a fixture engine's idle, for every amplitude law
// from flat to h^−2, tracked as idle segments inside ±7 % and ±15 % hints. Measured: every frame voiced and within 8.5 rpm
// of the idle (less than one grid step), also with the hint centre moved from 14 % below to 14 % above the truth in 2 %
// steps (wherever the truth stays inside the hint).
const IDLE_STACKS = [
  ['I4', 'i4-test'],
  ['I5', 'i5-test'],
  ['V8', 'v8-crossplane-test'],
] as const;
/** Amplitude laws h^−law of the stack's firing harmonics 2..8, from flat (0) to steep (2). */
const STACK_LAWS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const lawLabel = (law: number): string => (law === 0 ? 'flat' : `h^−${law}`);
/**
 * Hint centres, as multiples of the true rpm, of the ±p stack hints: centred, and with the truth about a quarter of the
 * hint's width from either edge — a hint "around the expected rpm" (D4(1)) need not centre the truth.
 */
const hintCentres = (p: number): readonly number[] => [1, 1 - p / 2, 1 + p / 2];

describe('trackRpm — D4 synthetic idle stacks inside ±7 % / ±15 % hints (firing harmonics 2..8 only, no fundamental)', () => {
  for (const [stack, id] of IDLE_STACKS) {
    for (const p of STEADY_HINTS) {
      it(
        `${stack} at the ${id} idle, ±${whole(p)} % hints centred and with the truth about a quarter of the hint from either edge, ` +
          `amplitude laws ${STACK_LAWS.map(lawLabel).join(', ')}: never confidently wrong, median |error| ≤ 2 %`,
        async ({ annotate }) => {
          const spec = loadFixture(id).spec;
          const idle = spec.rpm.idle;
          const geo = trackOptionsForEngine(spec);
          const verdicts: Verdict[] = [];
          for (const law of STACK_LAWS) {
            const x = engineSignal(3, () => idle, firingLines(geo.firingsPerRev, 8, [], 2, law));
            for (const centre of hintCentres(p)) {
              const hint = around(centre * idle, p);
              const tr = trackRpm(x, FS, trackOptionsForSegment(spec, 'idle', hint));
              const windows = Array.from(tr.t, () => ({ min: idle, max: idle }));
              verdicts.push(judge(`${stack} ${lawLabel(law)} [${hint.map((r) => r.toFixed(1)).join(', ')}]`, tr, windows, () => idle));
            }
          }
          await reportAll(verdicts, annotate);
          for (const v of verdicts) expectD4(v);
        },
      );
    }
  }
});

// ───────────────────────────── D4 acceptance on Phase 2a DSP renders with known rpm ─────────────────────────────

/** The rpm the DSP actually rendered, per sample: seg.ctl re-evaluated per quantum through the DSP's own
 * RpmState (τ = 40 ms tracking, shift trajectory, limiter bounce), driven exactly as renderSegment drives
 * DspCore (pre-roll at the t = 0 control, then one control evaluation per quantum). */
function renderedRpm(def: EngineDef, seg: Segment, perspective: Perspective, frames: number): Float64Array {
  bindSegmentEngine(def.spec);
  const base = createBaseControl(def.spec, perspective);
  const rs = new RpmState(FS);
  rs.configure(def.spec);
  seg.ctl(0, base);
  rs.reset(base.rpm);
  const pre = Math.round((PREROLL_S * FS) / QUANTUM);
  for (let q = 0; q < pre; q++) {
    const t0 = ((q - pre) * QUANTUM) / FS;
    for (let i = 0; i < QUANTUM; i++) rs.tick(base, t0 + i / FS);
  }
  const out = new Float64Array(frames);
  for (let q = 0; q * QUANTUM < frames; q++) {
    const t0 = (q * QUANTUM) / FS;
    seg.ctl(t0, base);
    for (let i = 0; i < QUANTUM && q * QUANTUM + i < frames; i++) {
      rs.tick(base, t0 + i / FS);
      out[q * QUANTUM + i] = rs.rpm;
    }
  }
  return out;
}

const ENGINES = ['i4-test', 'i5-test', 'v8-crossplane-test', 'v8-flatplane-test', 'rotary-test'] as const;
type EngineId = (typeof ENGINES)[number];
/**
 * The fixture segments (tools/segments.ts) tracked whole, and the sidecar kind each stands for. The limiter kind is the
 * 'limiter hold' stretch of wotPull below, which costs no render of its own: the limiterHold segment (on the limiter at
 * full load as well, one gear lower) measured alike — voiced shares within 0.07 of the stretch's, nothing off by > 6 %.
 */
const SEGMENT_KIND = {
  idle: 'idle',
  cruise2k: 'cruise',
  cruise4k: 'cruise',
  cruise6k: 'cruise',
  wotPull: 'wot',
  liftoff6k: 'liftoff',
} as const satisfies Record<string, SegmentKind>;
type SegmentName = keyof typeof SEGMENT_KIND;
const SEGMENT_NAMES = Object.keys(SEGMENT_KIND) as SegmentName[];
/**
 * Short stretches of the segments, each tracked on its own like T7's short sidecar segments, and the kind each stands
 * for: a held rpm on the limiter and at part load, a rising one and a gear-changing one (see stretchSpan).
 */
const STRETCH_KIND = {
  'limiter hold': 'limiter',
  'pre-lift': 'cruise',
  'last-gear top': 'wot',
  '2nd upshift': 'wot',
} as const satisfies Record<string, SegmentKind>;
type StretchName = keyof typeof STRETCH_KIND;
const STRETCH_NAMES = Object.keys(STRETCH_KIND) as StretchName[];
const PERSPECTIVES = ['cabin', 'outside'] as const;
const SUBWOOFERS = ['yes', 'no'] as const;

/**
 * A cell's search range (D4): a steady kind ±7 % or ±15 % around its expected rpm (the centre of its rendered range,
 * D4(1)); a sweep its range hint [0.93 · min, 1.07 · max] of the rendered rpm (T7's rule) or none, which searches the
 * engine's idle..limiter (D4(2)).
 */
type Range = '±7 %' | '±15 %' | 'range hint' | 'idle..limiter';
const isSteady = (kind: SegmentKind): boolean => kind === 'idle' || kind === 'cruise' || kind === 'limiter';
const rangesOf = (kind: SegmentKind): readonly Range[] => (isSteady(kind) ? ['±7 %', '±15 %'] : ['range hint', 'idle..limiter']);

function hintOf(range: Range, lo: number, hi: number): [number, number] | undefined {
  switch (range) {
    case '±7 %':
      return around((lo + hi) / 2, STEADY_HINTS[0]);
    case '±15 %':
      return around((lo + hi) / 2, STEADY_HINTS[1]);
    case 'range hint':
      return [0.93 * lo, 1.07 * hi];
    case 'idle..limiter':
      return undefined;
  }
}

/** One D4 acceptance cell: a fixture render (or a stretch of it) of one kind, tracked over one search range. */
interface Cell {
  id: EngineId;
  name: SegmentName;
  /** A stretch of the segment, tracked on its own; absent: the whole segment. */
  stretch?: StretchName;
  kind: SegmentKind;
  perspective: Perspective;
  subwoofer: (typeof SUBWOOFERS)[number];
  range: Range;
}

/** The 8 cells of a segment or stretch: cabin / outside × subwoofer 'yes' / 'no' × its kind's two ranges. */
function cellsOf(id: EngineId, name: SegmentName, stretch?: StretchName): Cell[] {
  const kind = stretch === undefined ? SEGMENT_KIND[name] : STRETCH_KIND[stretch];
  return PERSPECTIVES.flatMap((perspective) =>
    SUBWOOFERS.flatMap((subwoofer) => rangesOf(kind).map((range) => ({ id, name, stretch, kind, perspective, subwoofer, range }))),
  );
}

/** D4(4): the voiced-share floor of a cell — WOT_VOICED_FLOOR on the non-rotary wot cells, none elsewhere. */
const floorOf = (c: Cell): number | undefined => (c.kind === 'wot' && c.id !== 'rotary-test' ? WOT_VOICED_FLOOR : undefined);

function segmentNamed(name: SegmentName): Segment {
  const seg = SEGMENTS.find((s) => s.name === name);
  if (seg === undefined) throw new Error(`segment ${name} missing`);
  return seg;
}

const spans = new Map<string, { name: SegmentName; t0: number; t1: number }>();

/**
 * The segment a stretch belongs to and its span [t0, t1) (s), read off the segment's own control per quantum (as
 * the render evaluates it): 'limiter hold' = wotPull from the limiter phase to the end; 'last-gear top' = the last
 * second of the last gear's climb into it; '2nd upshift' = the second around the start of the 2nd upshift;
 * 'pre-lift' = liftoff6k before the lift (steady 6000 rpm at part load).
 */
function stretchSpan(id: EngineId, stretch: StretchName): { name: SegmentName; t0: number; t1: number } {
  const key = `${id} ${stretch}`;
  const hit = spans.get(key);
  if (hit !== undefined) return hit;
  const spec = loadFixture(id).spec;
  bindSegmentEngine(spec);
  const name: SegmentName = stretch === 'pre-lift' ? 'liftoff6k' : 'wotPull';
  const seg = segmentNamed(name);
  const base = createBaseControl(spec);
  const shifts: number[] = [];
  let limiterFrom = Number.NaN;
  let liftAt = Number.NaN;
  let shifting = false;
  for (let q = 0; q * QUANTUM < seg.durationS * FS; q++) {
    const t = (q * QUANTUM) / FS;
    seg.ctl(t, base);
    if (base.shift.active && !shifting) shifts.push(t);
    shifting = base.shift.active;
    if (base.limiter && Number.isNaN(limiterFrom)) limiterFrom = t;
    if (base.load < 0 && Number.isNaN(liftAt)) liftAt = t;
  }
  const upshift = shifts[1] ?? Number.NaN;
  const span =
    stretch === 'limiter hold'
      ? { name, t0: limiterFrom, t1: seg.durationS }
      : stretch === 'last-gear top'
        ? { name, t0: limiterFrom - 1, t1: limiterFrom }
        : stretch === '2nd upshift'
          ? { name, t0: upshift - 0.5, t1: upshift + 0.5 }
          : { name, t0: 0, t1: liftAt };
  if (!(span.t0 >= 0 && span.t1 > span.t0 + DEFAULT_WIN_S && span.t1 <= seg.durationS)) {
    throw new Error(`${key}: bad stretch span ${span.t0}..${span.t1} s`);
  }
  spans.set(key, span);
  return span;
}

/** Sample range [a, b) of a segment (or of one of its stretches) within the segment's render. */
function samplesOf(id: EngineId, stretch: StretchName | undefined, length: number): [number, number] {
  if (stretch === undefined) return [0, length];
  const { t0, t1 } = stretchSpan(id, stretch);
  return [Math.round(t0 * FS), Math.round(t1 * FS)];
}

/** The rendered rpm range [min, max] within each analysis window (default window and hop) over `rpm`. */
function windowRanges(rpm: Float64Array): Window[] {
  const winN = Math.round(DEFAULT_WIN_S * FS);
  const hopN = Math.round(DEFAULT_HOP_S * FS);
  const out: Window[] = [];
  for (let start = 0; start + winN <= rpm.length; start += hopN) {
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (let s = start; s < start + winN; s++) {
      const v = rpm[s] ?? Number.NaN;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    out.push({ min, max });
  }
  return out;
}

/**
 * Frames and D1.4-excluded frames of a segment or stretch, from the rendered rpm alone (the same in all its cells), at
 * collection time so the test titles carry them; each tested cell must agree.
 */
function exclusionOf(id: EngineId, name: SegmentName, stretch?: StretchName): { frames: number; excluded: number } {
  const seg = segmentNamed(name);
  const length = Math.round(seg.durationS * FS);
  const truth = renderedRpm(loadFixture(id), seg, 'cabin', length);
  const [a, b] = samplesOf(id, stretch, length);
  const windows = windowRanges(truth.subarray(a, b));
  return { frames: windows.length, excluded: windows.filter(isExcluded).length };
}

interface Rendered {
  signal: Float32Array;
  /** The rpm the DSP rendered, per sample. */
  truth: Float64Array;
}

const renders = new Map<string, Rendered>();

/** Renders `name` (Full tier, seed 1, 48 kHz) once per engine, perspective and subwoofer setting. */
function rendered(id: EngineId, name: SegmentName, perspective: Perspective, subwoofer: 'yes' | 'no'): Rendered {
  const key = `${id} ${name} ${perspective} ${subwoofer}`;
  const hit = renders.get(key);
  if (hit !== undefined) return hit;
  const def = loadFixture(id);
  const seg = segmentNamed(name);
  const { left } = renderSegment(def, seg, { perspective, subwoofer, fs: FS });
  const out: Rendered = { signal: left, truth: renderedRpm(def, seg, perspective, left.length) };
  renders.set(key, out);
  return out;
}

/** Tracks one cell through the score CLI's entry point (trackOptionsForSegment) and judges it against the rendered rpm. */
function trackCell(c: Cell): Verdict {
  const r = rendered(c.id, c.name, c.perspective, c.subwoofer);
  const [a, b] = samplesOf(c.id, c.stretch, r.signal.length);
  const signal = r.signal.subarray(a, b);
  const truth = r.truth.subarray(a, b);
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const v of truth) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const hint = hintOf(c.range, lo, hi);
  const tr = trackRpm(signal, FS, trackOptionsForSegment(loadFixture(c.id).spec, c.kind, hint));
  const t0 = a / FS;
  const where = c.stretch === undefined ? c.name : `${c.stretch} (${c.name} ${t0.toFixed(2)} s on)`;
  const range = hint === undefined ? 'idle..limiter' : `${c.range} [${hint.map((v) => v.toFixed(0)).join(', ')}]`;
  const label = `${c.id} ${where} ${c.perspective} subwoofer ${c.subwoofer} ${range}`;
  return judge(label, tr, windowRanges(truth), (i) => truth[Math.round((tr.t[i] ?? 0) * FS)] ?? Number.NaN, t0);
}

/**
 * Tracks, reports and asserts every cell of a segment or stretch. Its exclusion count must be the one in its test title,
 * and a whole segment's is bounded: none on an idle or a cruise (steady rpm), ≤ 70 % of the frames on a sweep. A
 * stretch's is not bounded: a limiter bounce may exclude every frame.
 */
async function checkCells(cells: readonly Cell[], excluded: number, annotate: Annotate): Promise<void> {
  const tracked = cells.map((c) => ({ c, v: trackCell(c) }));
  await reportAll(tracked.map(({ v }) => v), annotate);
  for (const { c, v } of tracked) {
    expect.soft(v.excluded, `${v.label}: excluded frames`).toBe(excluded);
    if (c.stretch === undefined && (c.kind === 'idle' || c.kind === 'cruise')) expect.soft(v.excluded, `${v.label}: excluded frames`).toBe(0);
    if (c.stretch === undefined && !isSteady(c.kind)) expect.soft(v.excluded, `${v.label}: excluded frames`).toBeLessThanOrEqual(0.7 * v.frames);
    expectD4(v, floorOf(c));
  }
}

/** The D4 checks in a test title. */
function checksOf(cells: readonly Cell[]): string {
  const floored = cells.some((c) => floorOf(c) !== undefined);
  const floor = floored ? `, voiced share ≥ ${WOT_VOICED_FLOOR}` : '';
  return (
    `never confidently wrong (confidence ≥ ${CONFIDENT} ⇒ within ±${whole(MAX_CONFIDENT_ERROR)} %), ` +
    `median |error| ≤ ${whole(MAX_MEDIAN_ERROR)} % over the voiced frames${floor}`
  );
}

const cellsText = (kind: SegmentKind): string => `all 8 cells (cabin/outside × subwoofer yes/no × ${rangesOf(kind).join(' / ')})`;

describe('trackRpm — Phase 2a DSP renders of the fixture engines (D4 acceptance)', () => {
  for (const id of ENGINES) {
    describe(id, () => {
      // One engine's renders at a time (≈ 80 MB): the stretches below reuse its wotPull and liftoff6k renders.
      afterAll(() => {
        for (const key of [...renders.keys()]) if (key.startsWith(`${id} `)) renders.delete(key);
      });

      for (const name of SEGMENT_NAMES) {
        const cells = cellsOf(id, name);
        const kind = SEGMENT_KIND[name];
        const { frames, excluded } = exclusionOf(id, name);
        it(
          `${id} ${name} (${kind}): ${checksOf(cells)} in ${cellsText(kind)}; ` +
            `${excluded} of ${frames} frames excluded per cell (rendered rpm varies > 3 % within the window)`,
          { timeout: 120_000 },
          async ({ annotate }) => {
            await checkCells(cells, excluded, annotate);
          },
        );
      }

      // Short stretches tracked on their own (T7's short sidecar segments): a held, a rising and a gear-changing rpm.
      for (const stretch of STRETCH_NAMES) {
        const kind = STRETCH_KIND[stretch];
        const { name, t0, t1 } = stretchSpan(id, stretch);
        const cells = cellsOf(id, name, stretch);
        const { frames, excluded } = exclusionOf(id, name, stretch);
        const exclusion =
          excluded === frames
            ? `all ${frames} frames excluded (limiter bounce), so only the confident ones are checked, against their window's rpm range`
            : `${excluded} of ${frames} frames excluded per cell`;
        it(
          `${id} ${stretch} (${kind}; ${name} ${t0.toFixed(2)}–${t1.toFixed(2)} s on its own): ` +
            `${checksOf(cells)} in ${cellsText(kind)}; ${exclusion}`,
          { timeout: 120_000 },
          async ({ annotate }) => {
            await checkCells(cells, excluded, annotate);
          },
        );
      }

      if (id === 'i4-test') {
        const title = 'tracks i4-test idle inside T7 sidecar hints, the truth off the range edges (regression: no rpmMin fallback)';
        it(title, { timeout: 60_000 }, () => {
          // T7's hint rule [⌊0.93·750/50⌋·50, ⌈1.07·750/50⌉·50] = [650, 850], and a tighter [700, 800]: every frame is
          // voiced, within one grid step of 750 rpm, and the two ranges give the same track (D1.2).
          const spec = loadFixture('i4-test').spec;
          for (const perspective of PERSPECTIVES) {
            for (const subwoofer of SUBWOOFERS) {
              const { signal } = rendered('i4-test', 'idle', perspective, subwoofer);
              const wide = trackRpm(signal, FS, trackOptionsForSegment(spec, 'idle', [650, 850]));
              const tight = trackRpm(signal, FS, trackOptionsForSegment(spec, 'idle', [700, 800]));
              const label = `${perspective} subwoofer ${subwoofer}`;
              expect(unvoiced(wide), label).toBe(0);
              expect(Math.max(...relErrors(wide, () => 750)), label).toBeLessThanOrEqual(RPM_GRID_STEP / 750 + 1e-9);
              expect(tight.rpm, label).toEqual(wide.rpm);
            }
          }
        });
      }
    });
  }
});
