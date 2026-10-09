import { describe, expect, it } from 'vitest';
import type { DspControl, EngineSpec } from '../../src/contracts';
import { PROGRAM_S, SEGMENTS, bindSegmentEngine, createBaseControl, playSegments, type Segment } from '../../tools/segments';
import { FIXTURE_IDS, loadFixture, makeCtl } from './helpers/dsp-harness';

function seg(name: string): Segment {
  const s = SEGMENTS.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no segment ${name}`);
  return s;
}

interface Sample {
  t: number;
  rpm: number;
  load: number;
  gear: number;
  limiter: boolean;
  driveline: DspControl['driveline'];
  shift: DspControl['shift'];
}

function sampleSegment(s: Segment, dt = 0.001): Sample[] {
  const base = makeCtl(0, 0);
  const out: Sample[] = [];
  for (let t = 0; t < s.durationS; t += dt) {
    s.ctl(t, base);
    out.push({ t, rpm: base.rpm, load: base.load, gear: base.gear, limiter: base.limiter, driveline: base.driveline, shift: { ...base.shift } });
  }
  return out;
}

function shiftEvents(samples: Sample[]): DspControl['shift'][] {
  const ev: DspControl['shift'][] = [];
  for (const s of samples) {
    if (s.shift.active && !ev.some((e) => e.t0 === s.shift.t0)) ev.push(s.shift);
  }
  return ev;
}

describe('segments', () => {
  it('throws before an engine is bound', () => {
    expect(() => seg('idle').ctl(0, makeCtl(0, 0))).toThrow(/bindSegmentEngine/);
  });

  it('defines exactly the contract segments and durations', () => {
    expect(SEGMENTS.map((s) => [s.name, s.durationS])).toEqual([
      ['idle', 5],
      ['cruise2k', 4],
      ['cruise4k', 4],
      ['cruise6k', 4],
      ['wotPull', 12],
      ['liftoff6k', 6],
      ['limiterHold', 4],
      ['autoShiftPull', 10],
    ]);
    expect(PROGRAM_S).toBe(49);
  });

  it('createBaseControl: warm, running, app defaults, idle in gear 1', () => {
    const spec = loadFixture('i6-test').spec;
    expect(createBaseControl(spec, 'outside')).toEqual({
      rpm: spec.rpm.idle,
      load: 0,
      gear: 1,
      driveline: 'engaged',
      limiter: false,
      shift: { active: false, up: true, fromRpm: spec.rpm.idle, toRpm: spec.rpm.idle, t0: 0, durationS: spec.gearbox.shiftTimeS },
      ignitionOn: true,
      runTimeS: 600,
      valve: 'auto',
      perspective: 'outside',
      driveMode: 'comfort',
      warm: true,
    });
    expect(createBaseControl(spec).perspective).toBe('cabin');
  });

  for (const id of FIXTURE_IDS) {
    it(`produces bounded, consistent control for ${id}`, () => {
      const spec: EngineSpec = loadFixture(id).spec;
      bindSegmentEngine(spec);
      const ratios = spec.gearbox.overallRatios;
      const bad: string[] = [];
      for (const s of SEGMENTS) {
        for (const x of sampleSegment(s)) {
          const ok =
            Number.isFinite(x.rpm) &&
            x.rpm > 0 &&
            x.rpm <= spec.rpm.limiter.rpm + 1e-9 &&
            x.load >= -1 &&
            x.load <= 1 &&
            x.gear >= 1 &&
            x.gear <= ratios.length &&
            (!x.shift.active || x.shift.durationS === spec.gearbox.shiftTimeS);
          if (!ok) bad.push(`${s.name} t=${x.t.toFixed(3)} rpm=${x.rpm} load=${x.load} gear=${x.gear}`);
        }
      }
      expect(bad.slice(0, 5)).toEqual([]);

      expect(sampleSegment(seg('idle')).every((x) => x.rpm === spec.rpm.idle && x.driveline === 'clutch-open')).toBe(true);
      const c6 = sampleSegment(seg('cruise6k'));
      expect(c6.every((x) => x.rpm === Math.min(6000, spec.rpm.redline - 500) && x.load === 0.3)).toBe(true);
      expect(sampleSegment(seg('limiterHold')).every((x) => x.limiter && x.rpm === spec.rpm.limiter.rpm && x.load === 1)).toBe(true);

      const g = Math.min(4, ratios.length);
      const wot = sampleSegment(seg('wotPull'));
      const wotShifts = shiftEvents(wot);
      expect(wotShifts.length).toBe(g - 1);
      wotShifts.forEach((e, i) => {
        expect(e.fromRpm).toBeCloseTo(spec.rpm.redline, 9);
        expect(e.toRpm).toBeCloseTo((spec.rpm.redline * (ratios[i + 1] ?? 0)) / (ratios[i] ?? 1), 9);
      });
      expect(wot[0]?.rpm).toBeCloseTo(spec.rpm.idle, 9);
      expect(wot.filter((x) => x.t >= 11).every((x) => x.limiter && x.rpm === spec.rpm.limiter.rpm)).toBe(true);
      expect(wot.filter((x) => x.t < 8.9).some((x) => x.limiter)).toBe(false);
      let maxJump = 0;
      for (let i = 1; i < wot.length; i++) {
        const a = wot[i - 1];
        const b = wot[i];
        if (a && b && !a.shift.active && !b.shift.active && a.gear === b.gear) maxJump = Math.max(maxJump, Math.abs(b.rpm - a.rpm));
      }
      expect(maxJump).toBeLessThan(10); // ≤ 10 rpm per ms within a gear: continuous climb

      const lift = sampleSegment(seg('liftoff6k'));
      expect(lift.find((x) => x.t >= 1)?.load).toBe(-0.6);
      expect((lift.find((x) => x.t >= 1)?.rpm ?? 0) > (lift.find((x) => x.t >= 4)?.rpm ?? Infinity)).toBe(true);
      expect(lift.find((x) => x.t >= 5.5)?.driveline).toBe('clutch-open');

      const auto = sampleSegment(seg('autoShiftPull'));
      const autoShifts = shiftEvents(auto);
      expect(autoShifts.length).toBe(g - 1);
      autoShifts.forEach((e) => expect(e.fromRpm).toBeCloseTo(0.65 * spec.rpm.redline, 9));
      expect(Math.max(...auto.map((x) => x.gear))).toBe(g);
      expect(auto.every((x) => x.load === 0.6 && !x.limiter)).toBe(true);
    });
  }

  it('playSegments plays the segments back-to-back on an absolute timeline and repeats', () => {
    const spec = loadFixture('v8-crossplane-test').spec;
    bindSegmentEngine(spec);
    const viaProgram = createBaseControl(spec);
    const direct = createBaseControl(spec);
    let start = 0;
    for (const s of SEGMENTS) {
      for (const local of [0, 0.37 * s.durationS, s.durationS - 0.01]) {
        for (const cycle of [0, 1]) {
          const t = cycle * PROGRAM_S + start + local;
          playSegments(t, viaProgram);
          s.ctl(local, direct);
          const label = `${s.name} @ ${local.toFixed(2)} (cycle ${cycle})`;
          expect(viaProgram.rpm, label).toBeCloseTo(direct.rpm, 6);
          expect(viaProgram.load, label).toBe(direct.load);
          expect(viaProgram.gear, label).toBe(direct.gear);
          expect(viaProgram.limiter, label).toBe(direct.limiter);
          expect(viaProgram.driveline, label).toBe(direct.driveline);
          expect(viaProgram.shift.active, label).toBe(direct.shift.active);
          if (direct.shift.active) expect(viaProgram.shift.t0, label).toBeCloseTo(direct.shift.t0 + start + cycle * PROGRAM_S, 6);
        }
      }
      start += s.durationS;
    }
  });
});
