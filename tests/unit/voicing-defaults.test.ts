import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import type { CombustionEntry, EngineDef, EngineSpec } from '../../src/contracts';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import engineSchema from '../../src/data/schema/engine.schema.json';

const SRC = { layout: ['s'], combustion: ['s'], rpm: ['s'], aspiration: ['s'], gearbox: ['s'] };

function makeSpec(
  layoutType: EngineSpec['layout']['type'],
  combustion: CombustionEntry[],
  aspiration: EngineSpec['aspiration'],
  idle = 800,
  redline = 7000,
): EngineSpec {
  return {
    layout: {
      type: layoutType,
      bankAngleDeg: layoutType === 'v' ? 90 : layoutType === 'flat' ? 180 : 0,
      crank: 'n/a',
      displacementL: 2,
    },
    cycleDeg: layoutType === 'rotary' ? 1080 : 720,
    combustion,
    rpm: { idle, redline, limiter: { type: 'ignition-soft', rpm: redline + 100, hysteresisRpm: 150 } },
    aspiration,
    gearbox: { type: 'dct', overallRatios: [14, 9, 6, 4.5], drivenTyre: '245/40R18', shiftTimeS: 0.1, tc: null },
    sources: SRC,
  };
}

const NA: EngineSpec['aspiration'] = { type: 'na', turbo: null, supercharger: null };
const TURBO: EngineSpec['aspiration'] = { type: 'turbo', turbo: { count: 1, layout: 'single' }, supercharger: null };
const SC: EngineSpec['aspiration'] = {
  type: 'supercharger',
  turbo: null,
  supercharger: { kind: 'twin-screw', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 },
};

const I5 = makeSpec('inline', [0, 144, 288, 432, 576].map((a) => ({ angleDeg: a, bank: 0 })), TURBO, 850, 7000);
const V8 = makeSpec(
  'v',
  [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })),
  NA,
  700,
  7500,
);
const FLAT4 = makeSpec('flat', [0, 0, 1, 1].map((bank, i) => ({ angleDeg: i * 180, bank })), TURBO);
const ROTARY = makeSpec('rotary', [0, 180, 360, 540, 720, 900].map((a) => ({ angleDeg: a, bank: 0 })), TURBO, 750, 8000);
const V8SC = makeSpec('v', [0, 1, 0, 1, 1, 0, 1, 0].map((bank, i) => ({ angleDeg: i * 90, bank })), SC, 700, 6200);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEngine = ajv.compile(engineSchema);

describe('defaultVoicing', () => {
  it('is deterministic and returns fresh objects on every call', () => {
    const a = defaultVoicing(V8);
    const b = defaultVoicing(V8);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.headersM).not.toBe(b.headersM);
    a.headersM[0] = 99;
    expect(defaultVoicing(V8).headersM[0]).not.toBe(99);
  });

  it('gives one header per combustion entry, 0.55–0.70 m, not all equal', () => {
    for (const spec of [I5, V8, V8SC]) {
      const h = defaultVoicing(spec).headersM;
      expect(h).toHaveLength(spec.combustion.length);
      for (const x of h) {
        expect(x).toBeGreaterThanOrEqual(0.55);
        expect(x).toBeLessThanOrEqual(0.7);
      }
      expect(new Set(h).size).toBeGreaterThan(1);
    }
  });

  it('is bank-symmetric for V engines', () => {
    const v = defaultVoicing(V8);
    const bank = (b: number): number[] =>
      V8.combustion.flatMap((c, i) => (c.bank === b ? [v.headersM[i] ?? NaN] : [])).sort((x, y) => x - y);
    expect(bank(0)).toEqual(bank(1));
  });

  it('uses deliberately unequal 0.45/0.75 pairs for flat 4-cylinders', () => {
    const h = defaultVoicing(FLAT4).headersM;
    expect(h).toEqual([0.45, 0.75, 0.45, 0.75]);
  });

  it('gives the three faces of one rotor the same header (rotary)', () => {
    const h = defaultVoicing(ROTARY).headersM;
    expect(h).toHaveLength(6);
    expect(h[0]).toBe(h[2]);
    expect(h[2]).toBe(h[4]);
    expect(h[1]).toBe(h[3]);
    expect(h[3]).toBe(h[5]);
    expect(h[0]).not.toBe(h[1]);
  });

  it('builds one 0.35 m collector per bank, banks ascending', () => {
    expect(defaultVoicing(I5).collectors).toEqual([{ banks: [0], lengthM: 0.35 }]);
    expect(defaultVoicing(V8).collectors).toEqual([
      { banks: [0], lengthM: 0.35 },
      { banks: [1], lengthM: 0.35 },
    ]);
  });

  it('adds a turbine only for turbo engines', () => {
    expect(defaultVoicing(I5).turbine).toEqual({ reflection: 0.45, lpHz: 1500 });
    expect(defaultVoicing(V8).turbine).toBeNull();
    expect(defaultVoicing(V8SC).turbine).toBeNull();
  });

  it('sets forced induction for turbo and supercharger only, whistle −36 dB and outside −30 dB (B18)', () => {
    expect(defaultVoicing(I5).forcedInduction).toEqual({
      spoolTimeS: 0.6, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14, whistleDb: -36, outsideGainDb: -30,
    });
    expect(defaultVoicing(V8SC).forcedInduction).toEqual({
      spoolTimeS: 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14, whistleDb: -36, outsideGainDb: -30,
    });
    expect(defaultVoicing(V8).forcedInduction).toBeNull();
  });

  it('uses the contract constants for exhaust, intake, mechanical, overrun, cabin and pulse', () => {
    const v = defaultVoicing(I5);
    expect(v.exhaust).toEqual({
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    });
    expect(v.intake).toEqual({ runnerM: 0.3, helmholtzHz: 145, gain: 0.4 });
    expect(defaultVoicing(V8).intake.helmholtzHz).toBe(160);
    expect(defaultVoicing(ROTARY).intake.helmholtzHz).toBe(130);
    expect(v.mechanical).toEqual({ blockGain: 0.3, valvetrainGain: 0.1 });
    expect(v.overrun).toEqual({ crackleRate: 0.5, fuelCutResumeRpm: 1350 });
    expect(v.cabin).toEqual({ lowpassHz: 600, leakDb: -30 }); // B19 high-frequency leak
    expect(v.pulse).toEqual({ widthDeg: 60, alpha: 9, beta: 4, evoOffsetDeg: 140, cycleAsymmetry: 0.1 });
    expect(defaultVoicing(ROTARY).pulse.widthDeg).toBe(260);
    expect(v.estimated).toBe(true);
  });

  it('derives launchRpm from redline: NA 0.55, turbo/supercharger 0.45', () => {
    expect(defaultVoicing(V8).launchRpm).toBe(4125);
    expect(defaultVoicing(I5).launchRpm).toBe(3150);
    expect(defaultVoicing(V8SC).launchRpm).toBe(2790);
  });

  it('produces voicings that validate against engine.schema.json', () => {
    for (const [i, spec] of [I5, V8, FLAT4, ROTARY, V8SC].entries()) {
      const def: EngineDef = {
        id: `fixture-${i}`,
        name: 'Fixture',
        inspiredBy: 'Fixture',
        set: 'euro',
        notes: 'fixture',
        spec: {
          ...spec,
          layout: { ...spec.layout, crank: spec.layout.type === 'v' ? 'cross-plane' : 'n/a' },
        },
        voicing: defaultVoicing(spec),
      };
      const ok = validateEngine(def);
      expect(validateEngine.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});
