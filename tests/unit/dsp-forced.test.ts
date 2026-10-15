import { describe, expect, it } from 'vitest';
import type { EngineDef, LiftEvent, TurboLayout } from '../../src/contracts';
import { Biquad } from '../../src/dsp/biquad';
import { ForcedInduction, WHINE_AMP, WHISTLE_AMP } from '../../src/dsp/forced';
import { loadFixture } from './helpers/fixtures';

const FS = 48000;

function configured(def: EngineDef, seed = 1): ForcedInduction {
  const fi = new ForcedInduction(FS);
  fi.configure(def.spec, def.voicing, seed);
  return fi;
}

/**
 * Turbo test engine: i4-test with redline 6000 and the given turbo layout / lift / spool. whistleDb defaults to 0 dB
 * (the Phase 2a whistle level, amendment B18), so the whistle tests below measure WHISTLE_AMP × boost.
 */
function turboDef(lift: LiftEvent = 'bov', layout: TurboLayout = 'single', spoolTimeS = 0.5, whistleDb = 0): EngineDef {
  const def = loadFixture('i4-test');
  def.spec.rpm.redline = 6000;
  def.spec.aspiration = { type: 'turbo', turbo: { count: layout === 'single' ? 1 : 2, layout }, supercharger: null };
  def.voicing.forcedInduction = { spoolTimeS, maxShaftKrpm: 180, lift, cabinGainDb: -14, whistleDb, outsideGainDb: -30 };
  return def;
}

/** v8-sc-test (roots, pulleyRatio 2.4, gearRatio 1, 4 lobes) with redline 6000. */
function scDef(whistleDb?: number): EngineDef {
  const def = loadFixture('v8-sc-test');
  def.spec.rpm.redline = 6000;
  if (whistleDb !== undefined && def.voicing.forcedInduction !== null) def.voicing.forcedInduction.whistleDb = whistleDb;
  return def;
}

function render(fi: ForcedInduction, n: number, rpm: number, load: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = fi.tick(rpm, load);
  return y;
}

/** Hann windows by length, computed once: the frequency scans below reuse one window thousands of times. */
const hannCache = new Map<number, Float64Array>();
function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (w === undefined) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/** Amplitude of a stationary sinusoid at f (Hann-windowed Goertzel, exact for a pure tone). */
function toneAmp(x: Float64Array, f: number): number {
  const n = x.length;
  const w = hann(n);
  const c = 2 * Math.cos((2 * Math.PI * f) / FS);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = (x[i] ?? 0) * (w[i] ?? 0) + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (4 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

/** Mean Hann-windowed Goertzel power over 101 bins (2 Hz apart) centred on f0: a noise density free of tone leakage. */
function noiseDensity(x: Float64Array, f0: number): number {
  const n = x.length;
  const w = hann(n);
  let p = 0;
  for (let k = -50; k <= 50; k++) {
    const c = 2 * Math.cos((2 * Math.PI * (f0 + 2 * k)) / FS);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = (x[i] ?? 0) * (w[i] ?? 0) + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    p += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return p / 101;
}

/** Frequency of the strongest tone in [lo, hi], scanned in steps of `step` Hz. */
function peakFreq(x: Float64Array, lo: number, hi: number, step: number): number {
  let best = lo;
  let bestA = -1;
  for (let f = lo; f <= hi; f += step) {
    const a = toneAmp(x, f);
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  return best;
}

/** RMS through a band-pass (Q 4) at f0, measured over [from, to). */
function narrowRms(x: Float64Array, f0: number, from: number, to: number): number {
  const bp = new Biquad();
  bp.bandpass(f0, 4, FS);
  let s = 0;
  for (let i = 0; i < to; i++) {
    const v = bp.process(x[i] ?? 0);
    if (i >= from) s += v * v;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

function bandRms(x: Float64Array, lo: number, hi: number, from: number, to: number): number {
  const hp = new Biquad();
  const lp = new Biquad();
  hp.highpass(lo, Math.SQRT1_2, FS);
  lp.lowpass(hi, Math.SQRT1_2, FS);
  let s = 0;
  for (let i = 0; i < to; i++) {
    const v = lp.process(hp.process(x[i] ?? 0));
    if (i >= from) s += v * v;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

function rms(x: Float64Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

function maxAbs(x: Float64Array): number {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

function maxAbsDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) m = Math.max(m, Math.abs((a[i] ?? NaN) - (b[i] ?? NaN)));
  return m;
}

/**
 * bov − flutter of a same-seed turbo pair at rpm 6000, driven through `schedule` ([samples, load] steps).
 * The two instances are bit-identical until the first lift event. After it the difference is the
 * BOV − flutter terms alone (whistle and whoosh cancel up to rounding), and those depend only on the
 * lift events, not on the load in between.
 */
function liftPair(schedule: readonly (readonly [number, number])[], spoolTimeS: number, seed = 3): Float64Array {
  const bov = configured(turboDef('bov', 'single', spoolTimeS), seed);
  const flutter = configured(turboDef('flutter', 'single', spoolTimeS), seed);
  let total = 0;
  for (const [n] of schedule) total += n;
  const d = new Float64Array(total);
  let i = 0;
  for (const [n, load] of schedule) {
    for (let k = 0; k < n; k++) d[i++] = bov.tick(6000, load) - flutter.tick(6000, load);
  }
  return d;
}

describe('ForcedInduction — supercharger', () => {
  it('whineHz = rpm/60 × pulleyRatio × gearRatio × 2·lobes for roots (fixture order 19.2)', () => {
    const fi = configured(scDef());
    expect(fi.whineHz(6000)).toBeCloseTo(1920, 9);
    expect(fi.whineHz(3000)).toBeCloseTo(960, 9);
    expect(fi.whineHz(0)).toBe(0);
  });

  it('uses male-rotor lobes (no ×2) for twin-screw, and the gear step-up', () => {
    const def = scDef();
    def.spec.aspiration.supercharger = { kind: 'twin-screw', pulleyRatio: 2, gearRatio: 1.5, lobes: 3 };
    expect(configured(def).whineHz(4000)).toBeCloseTo(600, 9); // 4000/60 × 2 × 1.5 × 3
    def.spec.aspiration.supercharger = { kind: 'roots', pulleyRatio: 2.5, gearRatio: 1, lobes: 3 };
    expect(configured(def).whineHz(1200)).toBeCloseTo(300, 9); // 1200/60 × 2.5 × 1 × 6
  });

  it('whineHz is 0 for NA and turbo engines', () => {
    expect(configured(loadFixture('i6-test')).whineHz(5000)).toBe(0);
    expect(configured(turboDef()).whineHz(5000)).toBe(0);
  });

  it('boost = clamp(load,0,1)·rpm/redline with no lag', () => {
    const fi = configured(scDef());
    fi.tick(3000, 0.5);
    expect(fi.boost).toBeCloseTo(0.25, 12);
    fi.tick(3000, 2);
    expect(fi.boost).toBeCloseTo(0.5, 12);
    fi.tick(6000, 1);
    expect(fi.boost).toBeCloseTo(1, 12);
    fi.tick(3000, -1);
    expect(fi.boost).toBe(0);
  });

  it('puts its spectral peak within 0.5 % of whineHz with level ∝ boost', () => {
    const fi = configured(scDef());
    const full = render(fi, FS, 4000, 1);
    const w = fi.whineHz(4000); // 1280 Hz
    const f = peakFreq(full, 0.9 * w, 1.1 * w, 0.5);
    expect(Math.abs(f - w) / w).toBeLessThan(0.005);
    const boost = 4000 / 6000;
    expect(toneAmp(full, w)).toBeCloseTo(WHINE_AMP * boost, 2);
    fi.reset();
    const half = render(fi, FS, 4000, 0.5);
    expect(toneAmp(half, w) / toneAmp(full, w)).toBeCloseTo(0.5, 3);
  });

  it('is exactly silent at load 0', () => {
    const y = render(configured(scDef()), FS / 4, 5000, 0);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('ignores whistleDb (B18: the whistle level is the turbo whistle only)', () => {
    const run = (db: number): Float64Array => {
      const fi = configured(scDef(db));
      return Float64Array.from([...render(fi, FS / 4, 3000, 1), ...render(fi, FS / 4, 5000, 0.6)]);
    };
    const loud = run(0);
    expect(maxAbs(loud)).toBeGreaterThan(0.05);
    expect(Array.from(run(-60))).toEqual(Array.from(loud));
  });

  it('mutes whine tones above 0.45·fs instead of aliasing them', () => {
    // whineHz is linear in rpm (order 19.2), so these rpms put the tones above 0.45·fs = 21.6 kHz.
    const y = render(configured(scDef()), FS / 2, 40000, 1); // f = 12.8 kHz plays; 2·f = 25.6 kHz is muted
    expect(toneAmp(y, 12800)).toBeCloseTo(WHINE_AMP, 2);
    expect(toneAmp(y, FS - 25600)).toBeLessThan(1e-6); // 22.4 kHz, where an unmuted 2·f would alias
    const top = render(configured(scDef()), FS / 2, 70000, 1); // f = 22.4 kHz: both tones muted
    expect(top.every((v) => v === 0)).toBe(true);
  });
});

describe('ForcedInduction — turbo', () => {
  it('spools with τ = spoolTimeS and falls with τ = 0.6·spoolTimeS; boost = shaft² (multi-call)', () => {
    const fi = configured(turboDef('bov', 'single', 0.5));
    render(fi, FS / 2, 4500, 1); // target shaft = 1 · clamp((4500 − 1500)/3000) = 1
    expect(fi.boost).toBeCloseTo((1 - Math.exp(-1)) ** 2, 2);
    render(fi, (5 * FS) / 2, 4500, 1); // 3 s total
    expect(fi.boost).toBeGreaterThan(0.99);
    const shaftAtLift = Math.sqrt(fi.boost);
    render(fi, (3 * FS) / 10, 4500, 0); // 0.3 s = one falling τ
    expect(Math.sqrt(fi.boost)).toBeCloseTo(shaftAtLift * Math.exp(-1), 2);
  });

  it('targets shaft = load · clamp((rpm − 0.25·redline)/(0.5·redline), 0, 1)', () => {
    const fi = configured(turboDef('bov', 'single', 0.1));
    render(fi, FS, 3000, 0.8); // (3000 − 1500)/3000 = 0.5 → shaft 0.4
    expect(Math.sqrt(fi.boost)).toBeCloseTo(0.4, 4);
    render(fi, FS, 1400, 1); // below 0.25·redline → 0
    expect(fi.boost).toBeLessThan(1e-12);
  });

  it('is exactly silent below 0.25·redline from rest', () => {
    const y = render(configured(turboDef()), FS / 2, 1400, 1);
    expect(y.every((v) => v === 0)).toBe(true);
  });

  it('whistles at f1 = 1000 + 3000·shaft with 2·f1 at −12 dB, amplitude WHISTLE_AMP × boost', () => {
    const fi = configured(turboDef('bov', 'single', 0.2));
    render(fi, 3 * FS, 3750, 1); // target shaft 0.75 → f1 = 3250 Hz
    const shaft = Math.sqrt(fi.boost);
    const y = render(fi, FS, 3750, 1);
    const f1 = 1000 + 3000 * shaft;
    expect(Math.abs(peakFreq(y, 1000, 4500, 1) - f1)).toBeLessThan(0.005 * f1);
    const a1 = toneAmp(y, f1);
    expect(a1).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
    expect(20 * Math.log10(toneAmp(y, 2 * f1) / a1)).toBeCloseTo(-12, 0);
  });

  it('whistleDb (B18) scales the whistle alone: y(g) = y(−∞) + g·W, W = the f1 / 2·f1 whistle, whoosh and lift events untouched', () => {
    // spool at 3750 rpm (shaft → 0.75), then lift: whistle, whoosh and the BOV burst all sound
    const run = (db: number): Float64Array => {
      const fi = configured(turboDef('bov', 'single', 0.2, db));
      return Float64Array.from([...render(fi, 4 * FS, 3750, 1), ...render(fi, FS / 2, 3750, 0)]);
    };
    const full = run(0);
    const half = run(-20);
    const none = run(-400); // dbToGain(−400) = 1e-20: the whistle term is below double rounding of the rest
    const g = 10 ** (-20 / 20);
    let worst = 0;
    for (let i = 0; i < full.length; i++) {
      const want = (none[i] ?? 0) + g * ((full[i] ?? 0) - (none[i] ?? 0));
      worst = Math.max(worst, Math.abs((half[i] ?? 0) - want));
    }
    expect(worst).toBeLessThan(1e-12);
    // W is the whistle: at the steady shaft its lines carry WHISTLE_AMP × boost (and −12 dB at 2·f1) …
    const steady = (x: Float64Array): Float64Array => x.subarray(3 * FS, 4 * FS); // the shaft has settled
    const w = steady(full).map((v, i) => v - (steady(none)[i] ?? 0));
    const ref = configured(turboDef('bov', 'single', 0.2, 0));
    render(ref, 4 * FS, 3750, 1);
    const f1 = 1000 + 3000 * Math.sqrt(ref.boost);
    expect(toneAmp(w, f1)).toBeCloseTo(WHISTLE_AMP * ref.boost, 2);
    expect(20 * Math.log10(toneAmp(w, 2 * f1) / toneAmp(w, f1))).toBeCloseTo(-12, 0);
    // … and nothing else: the whoosh stays at full level without the whistle, and W holds no noise
    expect(bandRms(none, 8000, 12000, 3 * FS, 4 * FS)).toBeGreaterThan(1e-3);
    expect(noiseDensity(w, 10000) / noiseDensity(steady(none), 10000)).toBeLessThan(1e-10);
    // the default level (−36 dB) puts the line 36 dB down
    const quiet = run(-36);
    const wq = steady(quiet).map((v, i) => v - (steady(none)[i] ?? 0));
    expect(20 * Math.log10(toneAmp(wq, f1) / toneAmp(w, f1))).toBeCloseTo(-36, 3);
  });

  it('adds 4–12 kHz whoosh ∝ boost²', () => {
    // Same seed: both whoosh noise waveforms are identical up to scale, so the density ratio is exact.
    const fi = configured(turboDef('bov', 'single', 0.1));
    render(fi, FS, 6000, 1);
    const fullB = fi.boost;
    const yFull = render(fi, FS, 6000, 1);
    const fiHalf = configured(turboDef('bov', 'single', 0.1));
    render(fiHalf, FS, 6000, Math.SQRT1_2); // shaft → 1/√2 → boost 0.5
    const halfB = fiHalf.boost;
    const yHalf = render(fiHalf, FS, 6000, Math.SQRT1_2);
    const d10k = noiseDensity(yFull, 10000);
    expect(Math.sqrt(noiseDensity(yHalf, 10000) / d10k)).toBeCloseTo((halfB / fullB) ** 2, 3);
    expect(d10k).toBeGreaterThan(10 * noiseDensity(yFull, 1500));
    expect(d10k).toBeGreaterThan(3 * noiseDensity(yFull, 20000));
  });

  it('fires a 2.5 kHz BOV burst on lift above 0.4 boost, ∝ boost at lift, decaying within 0.5 s', () => {
    // Same seed and inputs: the 'bov' and 'flutter' instances are identical until the lift; their
    // difference afterwards is exactly BOV − flutter (whistle and whoosh cancel).
    const liftDiff = (spoolS: number): Float64Array => {
      const bov = configured(turboDef('bov'), 3);
      const flutter = configured(turboDef('flutter'), 3);
      const spoolN = Math.round(spoolS * FS);
      const d = new Float64Array(spoolN + FS);
      for (let i = 0; i < d.length; i++) {
        const load = i < spoolN ? 1 : 0;
        d[i] = bov.tick(6000, load) - flutter.tick(6000, load);
        if (i < spoolN && d[i] !== 0) throw new Error(`instances differ before the lift at ${i}`);
      }
      return d.subarray(spoolN);
    };
    const ms = FS / 1000;
    const full = liftDiff(3); // boost ≈ 1 at lift
    const early = narrowRms(full, 2500, 5 * ms, 60 * ms);
    expect(early).toBeGreaterThan(2 * narrowRms(full, 1000, 5 * ms, 60 * ms));
    expect(20 * Math.log10(narrowRms(full, 2500, 900 * ms, 1000 * ms) / early)).toBeLessThan(-40);
    const partial = liftDiff(0.6); // boost = (1 − e^(−1.2))² ≈ 0.49 at lift
    const ratio = narrowRms(partial, 2500, 5 * ms, 60 * ms) / early;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it('ramps the BOV burst in over 5 ms (linear attack)', () => {
    // Pooled over 8 seeds. In the first 1 ms the envelope is ≤ 0.2 of its peak, so that window's RMS is
    // ≈ 0.13 of the 4–5 ms window's (≈ 1 with an instant attack). The flutter term of the pair difference
    // is < 5 % of its peak this early.
    const ms = FS / 1000;
    let first = 0;
    let late = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const d = liftPair([[FS, 1], [10 * ms, 0]], 0.05, seed).subarray(FS);
      for (let i = 0; i < ms; i++) first += (d[i] ?? 0) ** 2;
      for (let i = 4 * ms; i < 5 * ms; i++) late += (d[i] ?? 0) ** 2;
    }
    expect(late).toBeGreaterThan(0);
    expect(Math.sqrt(first / late)).toBeLessThan(0.3);
  });

  it('decays the BOV burst by 60 dB per 0.5 s (−30 dB from the 100–150 ms window to 350–400 ms)', () => {
    // The 'bov' output alone: with spoolTimeS 0.05 the shaft falls with τ = 30 ms, so whistle and
    // whoosh are > 45 dB below the burst from 100 ms after the lift on.
    const ms = FS / 1000;
    const fi = configured(turboDef('bov', 'single', 0.05), 3);
    render(fi, FS, 6000, 1);
    const y = render(fi, 400 * ms, 6000, 0);
    const drop = 20 * Math.log10(rms(y, 350 * ms, 400 * ms) / rms(y, 100 * ms, 150 * ms));
    expect(drop).toBeGreaterThan(-32);
    expect(drop).toBeLessThan(-28);
  });

  it('does not fire BOV/flutter when lifting below 0.4 boost (outputs identical)', () => {
    const bov = configured(turboDef('bov'), 5);
    const flutter = configured(turboDef('flutter'), 5);
    for (let i = 0; i < FS; i++) {
      const load = i < Math.round(0.42 * FS) ? 1 : 0; // 0.42 s of spool → boost ≈ 0.32, just below 0.4
      expect(bov.tick(6000, load)).toBe(flutter.tick(6000, load));
    }
  });

  it('detects a lift when load drops below 0.1: 0.05 fires, holding 0.12 does not', () => {
    const below = liftPair([[3 * FS, 1], [FS / 2, 0.05]], 1); // boost ≈ 0.9 at the drop
    const above = liftPair([[3 * FS, 1], [FS / 2, 0.12]], 1);
    expect(maxAbs(below)).toBeGreaterThan(0.5);
    expect(above.every((v) => v === 0)).toBe(true); // no event: the pair stays bit-identical
  });

  it('re-arms only at load ≥ 0.2: a 10 ms blip to 0.15 mid-lift adds no event, one to 0.25 does', () => {
    // Boost is ≈ 0.66 during the blip, well above 0.4, so a detector that re-armed on the blip would
    // fire again when load falls back to 0.05 and change the pair difference from then on.
    const ms = FS / 1000;
    const plain = liftPair([[3 * FS, 1], [610 * ms, 0.05]], 1);
    const blip = (load: number): Float64Array =>
      liftPair([[3 * FS, 1], [100 * ms, 0.05], [10 * ms, load], [500 * ms, 0.05]], 1);
    const peak = maxAbs(plain);
    expect(peak).toBeGreaterThan(0.5); // the first lift fired
    expect(maxAbsDiff(blip(0.15), plain)).toBeLessThan(1e-9 * peak); // rounding only (≈ 1e-16 measured)
    expect(maxAbsDiff(blip(0.25), plain)).toBeGreaterThan(0.1 * peak);
  });

  it('fires again on the next full-boost lift after load returns to 1, and not on low-boost lifts (multi-call)', () => {
    const fi = configured(turboDef('bov', 'single', 0.1), 9);
    const ref = configured(turboDef('flutter', 'single', 0.1), 9);
    const run = (n: number, load: number): number => {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = fi.tick(6000, load) - ref.tick(6000, load);
        s += d * d;
      }
      return s;
    };
    run(FS, 1);
    const first = run(FS / 5, 0); // lift: event in both (bov vs flutter) → outputs differ
    expect(first).toBeGreaterThan(0);
    run(FS, 0); // let both decay
    // Boost stays ≤ 0.02 through these steps, so no lift can fire whatever the arming state
    // (the 0.1 / 0.2 thresholds are pinned by the two tests above).
    run(FS / 5, 0.15);
    run(FS, 0);
    const quiet = run(FS / 5, 0.05);
    expect(quiet).toBeLessThan(1e-12 * first);
    run(FS, 1); // re-arm + spool
    const second = run(FS / 5, 0);
    expect(second).toBeGreaterThan(0.1 * first);
  });

  it("modulates the whoosh at 14 Hz after lift with lift = 'flutter' (and not with 'bov')", () => {
    // RMS above 5 kHz in 10 ms windows centred on the AM peaks vs. the following AM nulls (cycles 2–6).
    const peakToNull = (lift: LiftEvent): number => {
      const fi = configured(turboDef(lift), 4);
      const spoolN = 3 * FS;
      const y = new Float64Array(spoolN + FS);
      for (let i = 0; i < y.length; i++) y[i] = fi.tick(6000, i < spoolN ? 1 : 0);
      const win = FS / 100;
      let peaks = 0;
      let nulls = 0;
      for (let k = 2; k <= 6; k++) {
        const pk = spoolN + Math.round(((k + 0.5) / 14) * FS);
        const nu = spoolN + Math.round(((k + 1) / 14) * FS);
        peaks += bandRms(y, 5000, 20000, pk - win / 2, pk + win / 2);
        nulls += bandRms(y, 5000, 20000, nu - win / 2, nu + win / 2);
      }
      return peaks / nulls;
    };
    expect(peakToNull('flutter')).toBeGreaterThan(3);
    expect(peakToNull('bov')).toBeLessThan(2);
  });

  it('sequential: the second whistle voice (0.88·f1) enters above 0.55·redline', () => {
    const fi = configured(turboDef('bov', 'sequential', 0.1));
    render(fi, FS, 3000, 1); // 0.5·redline → shaft 0.5 → f1 = 2500, voice 2 (2200 Hz) off
    let y = render(fi, FS, 3000, 1);
    expect(toneAmp(y, 2500)).toBeGreaterThan(0.05);
    expect(toneAmp(y, 0.88 * 2500)).toBeLessThan(1e-3);
    render(fi, FS, 4800, 1); // 0.8·redline → shaft 1 → f1 = 4000, voice 2 at 3520 Hz full
    y = render(fi, FS, 4800, 1);
    const f1 = 1000 + 3000 * Math.sqrt(fi.boost);
    expect(toneAmp(y, 0.88 * f1)).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
    expect(toneAmp(y, f1)).toBeCloseTo(WHISTLE_AMP * fi.boost, 2);
  });

  it('sequential: the second voice fades in over 0.55–0.65·redline (off at 0.54, half level at 0.6)', () => {
    /** Voice-2 amplitude at a steady rpm, relative to a full-level voice (WHISTLE_AMP × boost). */
    const voice2 = (rpm: number): number => {
      const fi = configured(turboDef('bov', 'sequential', 0.1));
      render(fi, FS, rpm, 1); // settle the shaft
      const y = render(fi, FS, rpm, 1);
      const f1 = 1000 + 3000 * Math.sqrt(fi.boost);
      return toneAmp(y, 0.88 * f1) / (WHISTLE_AMP * fi.boost);
    };
    expect(voice2(0.54 * 6000)).toBeLessThan(0.01);
    const mid = voice2(0.6 * 6000); // smoothstep(0.55, 0.65, 0.6) = 0.5
    expect(mid).toBeGreaterThan(0.45);
    expect(mid).toBeLessThan(0.55);
  });

  it('parallel: two half-level voices at f1 and 1.012·f1', () => {
    const fi = configured(turboDef('bov', 'parallel', 0.1));
    render(fi, 2 * FS, 6000, 1);
    const y = render(fi, FS, 6000, 1);
    const f1 = 1000 + 3000 * Math.sqrt(fi.boost);
    expect(toneAmp(y, f1)).toBeCloseTo(0.5 * WHISTLE_AMP * fi.boost, 2);
    expect(toneAmp(y, 1.012 * f1)).toBeCloseTo(0.5 * WHISTLE_AMP * fi.boost, 2);
  });
});

describe('ForcedInduction — common', () => {
  it('NA engines output exactly 0 with boost 0', () => {
    const fi = configured(loadFixture('i6-test'));
    for (let i = 0; i < 1000; i++) expect(fi.tick(7000, 1)).toBe(0);
    expect(fi.boost).toBe(0);
  });

  it('a turbo engine whose voicing.forcedInduction is null outputs exactly 0 with boost 0', () => {
    const def = turboDef();
    def.voicing.forcedInduction = null;
    const fi = configured(def);
    expect(render(fi, FS / 10, 6000, 1).every((v) => v === 0)).toBe(true);
    expect(fi.boost).toBe(0);
  });

  it('is deterministic per seed and reset() replays the sequence', () => {
    const fi = configured(turboDef('bov', 'single', 0.2), 17);
    const a = Array.from(render(fi, 6000, 5500, 1));
    fi.reset();
    expect(Array.from(render(fi, 6000, 5500, 1))).toEqual(a);
    expect(Array.from(render(configured(turboDef('bov', 'single', 0.2), 18), 6000, 5500, 1))).not.toEqual(a);
  });
});
