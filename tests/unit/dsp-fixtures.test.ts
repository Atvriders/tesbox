import { describe, expect, it } from 'vitest';
import type { EngineDef, GearboxType, LiftEvent, LimiterType } from '../../src/contracts';
import { MAX_COMBUSTION, firingHz } from '../../src/contracts';
import { FIXTURE_IDS, loadFixture } from './helpers/fixtures';

type FixtureId = (typeof FIXTURE_IDS)[number];

const DEFS = FIXTURE_IDS.map((id) => [id, loadFixture(id)] as const);

/** Exact key sets of every object level of EngineDef (catches missing and misspelt fields). */
const KEYS: Record<string, string[]> = {
  '': ['id', 'name', 'inspiredBy', 'set', 'notes', 'spec', 'voicing'],
  spec: ['layout', 'cycleDeg', 'combustion', 'rpm', 'aspiration', 'gearbox', 'sources'],
  'spec.layout': ['type', 'bankAngleDeg', 'crank', 'displacementL'],
  'spec.rpm': ['idle', 'redline', 'limiter'],
  'spec.rpm.limiter': ['type', 'rpm', 'hysteresisRpm'],
  'spec.aspiration': ['type', 'turbo', 'supercharger'],
  'spec.gearbox': ['type', 'overallRatios', 'drivenTyre', 'shiftTimeS', 'tc'],
  'spec.sources': ['layout', 'combustion', 'rpm', 'aspiration', 'gearbox'],
  voicing: [
    'pulse', 'headersM', 'collectors', 'turbine', 'exhaust', 'intake', 'forcedInduction',
    'mechanical', 'overrun', 'cabin', 'launchRpm', 'estimated',
  ],
  'voicing.pulse': ['widthDeg', 'alpha', 'beta', 'evoOffsetDeg', 'cycleAsymmetry'],
  'voicing.exhaust': ['midPipeM', 'mufflerSectionsM', 'mufflerAction', 'tailpipeM', 'valve'],
  'voicing.exhaust.valve': ['fitted', 'openGainDb'],
  'voicing.intake': ['runnerM', 'helmholtzHz', 'gain'],
  'voicing.mechanical': ['blockGain', 'valvetrainGain'],
  'voicing.overrun': ['crackleRate', 'fuelCutResumeRpm'],
  'voicing.cabin': ['lowpassHz'],
};

function at(root: unknown, path: string): unknown {
  return path === '' ? root : path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root);
}

/** Cylinder numbers (entry index + 1) in firing order. */
function firingOrder(def: EngineDef): number[] {
  return def.spec.combustion
    .map((c, i) => ({ a: c.angleDeg, cyl: i + 1 }))
    .sort((x, y) => x.a - y.a)
    .map((x) => x.cyl);
}

/** Sorted firing angles of one bank. */
function bankAngles(def: EngineDef, bank: number): number[] {
  return def.spec.combustion.filter((c) => c.bank === bank).map((c) => c.angleDeg).sort((a, b) => a - b);
}

function gaps(sorted: number[], cycle: number): number[] {
  return sorted.map((a, i) => ((sorted[(i + 1) % sorted.length] ?? 0) - a + cycle) % cycle || cycle);
}

/** One row of the Task 1 fixture table (plan "Interfaces"), entry order = cylinder / rotor-face order. */
interface TableRow {
  angles: number[];
  banks: number[];
  rpm: [idle: number, redline: number, limiter: LimiterType, limiterRpm: number, hysteresisRpm: number];
  widthDeg: number;
  headersM: number[];
  collectors: { banks: number[]; lengthM: number }[];
  mufflerSections: number;
  /** Valve open gain in dB, or null when no valve is fitted. */
  valveDb: number | null;
  gearbox: [type: GearboxType, gears: number];
  /** Turbine [reflection, lpHz] (turbo engines only). */
  turbine: [reflection: number, lpHz: number] | null;
  lift: LiftEvent | null;
}

const V8_XP_ANGLES = [0, 630, 270, 180, 450, 360, 540, 90];
const V8_XP_BANKS = [0, 1, 0, 1, 0, 1, 0, 1];

const TABLE: Record<FixtureId, TableRow> = {
  'i4-test': {
    angles: [0, 540, 180, 360], banks: [0, 0, 0, 0], rpm: [750, 6500, 'ignition-soft', 6600, 150], widthDeg: 55,
    headersM: [0.6, 0.6, 0.6, 0.6], collectors: [{ banks: [0], lengthM: 0.35 }], mufflerSections: 3, valveDb: 4,
    gearbox: ['dct', 7], turbine: [0.45, 1500], lift: 'bov',
  },
  'i5-test': {
    angles: [0, 144, 576, 288, 432], banks: [0, 0, 0, 0, 0], rpm: [850, 7000, 'ignition-soft', 7100, 150], widthDeg: 60,
    headersM: [0.62, 0.55, 0.7, 0.58, 0.66], collectors: [{ banks: [0], lengthM: 0.4 }], mufflerSections: 3, valveDb: 5,
    gearbox: ['dct', 7], turbine: [0.45, 1500], lift: 'flutter',
  },
  'i6-test': {
    angles: [0, 480, 240, 600, 120, 360], banks: [0, 0, 0, 1, 1, 1], rpm: [700, 7000, 'fuel-hard', 7100, 200], widthDeg: 50,
    headersM: [0.55, 0.55, 0.55, 0.55, 0.55, 0.55],
    collectors: [{ banks: [0], lengthM: 0.35 }, { banks: [1], lengthM: 0.35 }], mufflerSections: 4, valveDb: null,
    gearbox: ['manual', 6], turbine: null, lift: null,
  },
  'v8-crossplane-test': {
    angles: V8_XP_ANGLES, banks: V8_XP_BANKS, rpm: [650, 6600, 'fuel-hard', 6700, 250], widthDeg: 65,
    headersM: [0.58, 0.66, 0.62, 0.7, 0.66, 0.58, 0.7, 0.62],
    collectors: [{ banks: [0], lengthM: 0.4 }, { banks: [1], lengthM: 0.45 }], mufflerSections: 3, valveDb: 4,
    gearbox: ['tc-auto', 8], turbine: null, lift: null,
  },
  'v8-flatplane-test': {
    angles: [0, 540, 180, 360, 90, 630, 270, 450], banks: [0, 0, 0, 0, 1, 1, 1, 1],
    rpm: [900, 9000, 'ignition-hard', 9100, 150], widthDeg: 45, headersM: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    collectors: [{ banks: [0], lengthM: 0.3 }, { banks: [1], lengthM: 0.3 }], mufflerSections: 1, valveDb: 5,
    gearbox: ['dct', 7], turbine: null, lift: null,
  },
  'v8-sc-test': {
    angles: V8_XP_ANGLES, banks: V8_XP_BANKS, rpm: [750, 6500, 'fuel-soft', 6600, 250], widthDeg: 65,
    headersM: [0.6, 0.68, 0.64, 0.72, 0.68, 0.6, 0.72, 0.64],
    collectors: [{ banks: [0], lengthM: 0.42 }, { banks: [1], lengthM: 0.48 }], mufflerSections: 2, valveDb: 4,
    gearbox: ['tc-auto', 8], turbine: null, lift: 'bov',
  },
  'flat4-uel-test': {
    angles: [0, 360, 180, 540], banks: [0, 1, 0, 1], rpm: [750, 6700, 'fuel-hard', 6800, 300], widthDeg: 70,
    headersM: [0.45, 0.75, 0.45, 0.75], collectors: [{ banks: [0, 1], lengthM: 0.6 }], mufflerSections: 3, valveDb: null,
    gearbox: ['manual', 6], turbine: [0.5, 1400], lift: 'bov',
  },
  'rotary-test': {
    angles: [0, 360, 720, 180, 540, 900], banks: [0, 0, 0, 1, 1, 1], rpm: [800, 8000, 'fuel-hard', 8200, 200], widthDeg: 260,
    headersM: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], collectors: [{ banks: [0, 1], lengthM: 0.3 }], mufflerSections: 2, valveDb: null,
    gearbox: ['manual', 6], turbine: [0.4, 1600], lift: 'bov',
  },
};

describe('fixture engines (tests/fixtures/engines)', () => {
  it.each(DEFS)('%s is a complete EngineDef with exactly the contract fields', (id, def) => {
    expect(def.id).toBe(id);
    for (const [path, keys] of Object.entries(KEYS)) {
      expect(Object.keys(at(def, path) as object).sort(), path).toEqual([...keys].sort());
    }
    for (const c of def.spec.combustion) expect(Object.keys(c).sort()).toEqual(['angleDeg', 'bank']);
    for (const c of def.voicing.collectors) expect(Object.keys(c).sort()).toEqual(['banks', 'lengthM']);
    for (const g of Object.values(def.spec.sources)) expect(g).toEqual(['fixture']);
    expect(def.voicing.estimated).toBe(true);
  });

  it.each(DEFS)('%s has valid combustion entries, rpm, gearbox and voicing ranges', (_id, def) => {
    const s = def.spec;
    const v = def.voicing;
    const n = s.combustion.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(MAX_COMBUSTION);
    const angles = s.combustion.map((c) => c.angleDeg);
    expect(new Set(angles).size).toBe(n);
    for (const c of s.combustion) {
      expect(c.angleDeg).toBeGreaterThanOrEqual(0);
      expect(c.angleDeg).toBeLessThan(s.cycleDeg);
      expect(Number.isInteger(c.bank) && c.bank >= 0).toBe(true);
    }
    expect(s.rpm.idle).toBeGreaterThanOrEqual(500);
    expect(s.rpm.idle).toBeLessThanOrEqual(1200);
    expect(s.rpm.redline).toBeGreaterThanOrEqual(6500); // invariants run steady 6000 rpm ≤ redline − 500
    expect(s.rpm.redline).toBeLessThanOrEqual(10000);
    expect(s.rpm.limiter.rpm).toBeGreaterThanOrEqual(s.rpm.redline);
    expect(s.rpm.limiter.hysteresisRpm).toBeGreaterThanOrEqual(50);
    expect(s.rpm.limiter.hysteresisRpm).toBeLessThanOrEqual(600);
    const r = s.gearbox.overallRatios;
    expect(r.length).toBeGreaterThanOrEqual(6);
    expect(r.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeLessThan(r[i - 1] ?? 0);
    expect(s.gearbox.drivenTyre).toMatch(/^\d{3}\/\d{2}R\d{2}$/);
    expect(s.gearbox.shiftTimeS).toBeGreaterThanOrEqual(0.05);
    expect(s.gearbox.shiftTimeS).toBeLessThanOrEqual(0.6);
    if (s.gearbox.type === 'tc-auto') {
      expect(s.gearbox.tc).not.toBeNull();
      expect(s.gearbox.tc?.couplingSR).toBeGreaterThanOrEqual(0.8);
      expect(s.gearbox.tc?.couplingSR).toBeLessThanOrEqual(0.95);
    } else {
      expect(s.gearbox.tc).toBeNull();
    }
    // voicing
    expect(v.headersM).toHaveLength(n);
    for (const h of v.headersM) expect(h > 0 && h <= 1.5).toBe(true);
    const banks = new Set(s.combustion.map((c) => c.bank));
    const covered = new Set(v.collectors.flatMap((c) => c.banks));
    for (const b of banks) expect(covered.has(b)).toBe(true);
    for (const c of v.collectors) expect(c.lengthM > 0 && c.lengthM <= 1.0).toBe(true);
    expect(v.exhaust.midPipeM > 0 && v.exhaust.midPipeM <= 3.0).toBe(true);
    expect(v.exhaust.mufflerSectionsM.length).toBeGreaterThanOrEqual(1);
    expect(v.exhaust.mufflerSectionsM.length).toBeLessThanOrEqual(4);
    for (const m of v.exhaust.mufflerSectionsM) expect(m > 0 && m <= 0.8).toBe(true);
    expect(v.exhaust.tailpipeM > 0 && v.exhaust.tailpipeM <= 1.2).toBe(true);
    expect(v.exhaust.mufflerAction).toBeGreaterThanOrEqual(0);
    expect(v.exhaust.mufflerAction).toBeLessThanOrEqual(1);
    expect(v.intake.runnerM > 0 && v.intake.runnerM <= 0.6).toBe(true);
    const maxWidth = s.cycleDeg === 1080 ? 300 : 90;
    expect(v.pulse.widthDeg).toBeGreaterThanOrEqual(40);
    expect(v.pulse.widthDeg).toBeLessThanOrEqual(maxWidth);
    expect(v.pulse.alpha).toBeGreaterThan(0);
    expect(v.pulse.beta).toBeGreaterThan(0);
    expect(v.pulse.cycleAsymmetry).toBeGreaterThanOrEqual(0);
    expect(v.pulse.cycleAsymmetry).toBeLessThanOrEqual(1);
    expect(v.overrun.fuelCutResumeRpm).toBeGreaterThan(s.rpm.idle);
    expect(v.launchRpm).toBeGreaterThan(s.rpm.idle);
    expect(v.launchRpm).toBeLessThan(s.rpm.redline);
    // aspiration ↔ turbine / forced induction consistency
    const t = s.aspiration.type;
    expect(s.aspiration.turbo !== null).toBe(t === 'turbo');
    expect(s.aspiration.supercharger !== null).toBe(t === 'supercharger');
    expect(v.turbine !== null).toBe(t === 'turbo');
    expect(v.forcedInduction !== null).toBe(t !== 'na');
    if (v.forcedInduction) {
      expect(v.forcedInduction.cabinGainDb).toBeGreaterThanOrEqual(-20);
      expect(v.forcedInduction.cabinGainDb).toBeLessThanOrEqual(-10);
    }
  });

  it('encodes the contract firing orders and layouts', () => {
    const def = Object.fromEntries(DEFS) as Record<FixtureId, EngineDef>;
    expect(firingOrder(def['i4-test'])).toEqual([1, 3, 4, 2]);
    expect(firingOrder(def['i5-test'])).toEqual([1, 2, 4, 5, 3]);
    expect(firingOrder(def['i6-test'])).toEqual([1, 5, 3, 6, 2, 4]);
    expect(firingOrder(def['v8-crossplane-test'])).toEqual([1, 8, 4, 3, 6, 5, 7, 2]);
    expect(firingOrder(def['v8-sc-test'])).toEqual([1, 8, 4, 3, 6, 5, 7, 2]);
    expect(firingOrder(def['v8-flatplane-test'])).toEqual([1, 5, 3, 7, 4, 8, 2, 6]);
    expect(firingOrder(def['flat4-uel-test'])).toEqual([1, 3, 2, 4]);
    // even overall spacing = cycleDeg / n everywhere (I5 144°, rotary 180°)
    const even: [string, number][] = [
      ['i4-test', 180], ['i5-test', 144], ['i6-test', 120], ['v8-crossplane-test', 90],
      ['v8-flatplane-test', 90], ['v8-sc-test', 90], ['flat4-uel-test', 180], ['rotary-test', 180],
    ];
    for (const [id, gap] of even) {
      const d = loadFixture(id);
      const all = d.spec.combustion.map((c) => c.angleDeg).sort((a, b) => a - b);
      expect(gaps(all, d.spec.cycleDeg), id).toEqual(all.map(() => gap));
    }
    // cross-plane banks fire unevenly (270/180/90/180), flat-plane banks evenly (180)
    const xp = def['v8-crossplane-test'];
    expect(gaps(bankAngles(xp, 0), 720)).toEqual([270, 180, 90, 180]);
    expect(gaps(bankAngles(xp, 1), 720)).toEqual([90, 180, 270, 180]);
    const fp = def['v8-flatplane-test'];
    expect(gaps(bankAngles(fp, 0), 720)).toEqual([180, 180, 180, 180]);
    expect(gaps(bankAngles(fp, 1), 720)).toEqual([180, 180, 180, 180]);
    // rotary: 1080° cycle, rotor faces 0/360/720 (bank 0) and 180/540/900 (bank 1), sequential twin turbo
    const ro = def['rotary-test'];
    expect(ro.spec.cycleDeg).toBe(1080);
    expect(ro.spec.layout.type).toBe('rotary');
    expect(bankAngles(ro, 0)).toEqual([0, 360, 720]);
    expect(bankAngles(ro, 1)).toEqual([180, 540, 900]);
    expect(ro.spec.aspiration.turbo).toEqual({ count: 2, layout: 'sequential' });
    expect(ro.spec.gearbox.type).toBe('manual');
    // supercharger: roots, pulley 2.4, 4 lobes, gear 1 → whine order 19.2
    const sc = def['v8-sc-test'].spec.aspiration.supercharger;
    expect(sc).toEqual({ kind: 'roots', pulleyRatio: 2.4, gearRatio: 1, lobes: 4 });
    expect(def['v8-sc-test'].spec.gearbox.type).toBe('tc-auto');
    // boxer: unequal 0.45 / 0.75 headers, bank 0 short and bank 1 long
    const f4 = def['flat4-uel-test'];
    expect(f4.spec.layout.bankAngleDeg).toBe(180);
    f4.spec.combustion.forEach((c, i) => expect(f4.voicing.headersM[i]).toBe(c.bank === 0 ? 0.45 : 0.75));
    // aspiration / gearbox per contract
    expect(def['i4-test'].spec.aspiration.type).toBe('turbo');
    expect(def['i4-test'].spec.gearbox.type).toBe('dct');
    expect(def['i5-test'].spec.gearbox.type).toBe('dct');
    expect(def['i6-test'].spec.aspiration.type).toBe('na');
    expect(def['i6-test'].spec.gearbox.type).toBe('manual');
    expect(def['v8-crossplane-test'].spec.gearbox.type).toBe('tc-auto');
    expect(def['v8-flatplane-test'].spec.gearbox.type).toBe('dct');
    expect(def['flat4-uel-test'].spec.gearbox.type).toBe('manual');
  });

  it('matches the Task 1 fixture table, including the audited exhaust re-voicing', () => {
    for (const [id, d] of DEFS) {
      const row = TABLE[id];
      const s = d.spec;
      const v = d.voicing;
      expect(s.combustion.map((c) => c.angleDeg), id).toEqual(row.angles);
      expect(s.combustion.map((c) => c.bank), id).toEqual(row.banks);
      const [idle, redline, limiter, limiterRpm, hysteresisRpm] = row.rpm;
      expect(s.rpm, id).toEqual({ idle, redline, limiter: { type: limiter, rpm: limiterRpm, hysteresisRpm } });
      expect(v.pulse.widthDeg, id).toBe(row.widthDeg);
      expect(v.headersM, id).toEqual(row.headersM);
      expect(v.collectors, id).toEqual(row.collectors);
      expect(v.exhaust.mufflerSectionsM, id).toHaveLength(row.mufflerSections);
      expect(v.exhaust.valve.fitted, id).toBe(row.valveDb !== null);
      if (row.valveDb !== null) expect(v.exhaust.valve.openGainDb, id).toBe(row.valveDb);
      expect([s.gearbox.type, s.gearbox.overallRatios.length], id).toEqual(row.gearbox);
      expect(v.turbine && [v.turbine.reflection, v.turbine.lpHz], id).toEqual(row.turbine);
      expect(v.forcedInduction?.lift ?? null, id).toBe(row.lift);
    }
    const def = (id: FixtureId): EngineDef => loadFixture(id);
    // single turbos, torque-converter data, the blower's forced-induction voicing
    for (const id of ['i4-test', 'i5-test', 'flat4-uel-test'] as const) {
      expect(def(id).spec.aspiration.turbo, id).toEqual({ count: 1, layout: 'single' });
    }
    expect(def('v8-crossplane-test').spec.gearbox.tc).toEqual({ stallRpmWot: 2400, lockupTurbineRpm: 1300, couplingSR: 0.88 });
    expect(def('v8-sc-test').spec.gearbox.tc).toEqual({ stallRpmWot: 2600, lockupTurbineRpm: 1400, couplingSR: 0.86 });
    expect(def('v8-sc-test').voicing.forcedInduction).toEqual({
      spoolTimeS: 0.05, maxShaftKrpm: 15, lift: 'bov', cabinGainDb: -12,
    });
    // cycleAsymmetry 0.05 for the even-fire fixtures
    for (const id of ['i4-test', 'i6-test', 'v8-flatplane-test'] as const) {
      expect(def(id).voicing.pulse.cycleAsymmetry, id).toBe(0.05);
    }
    // Audited re-voicing (Phase 2a known issues, T01): i6 last muffler 0.56 → 0.62 m, flat4 last
    // muffler 0.48 → 0.62 m and collector 0.3 → 0.6 m (table above), rotary mid-pipe 1.6 → 2.2 m.
    // The audit verified T9's invariants 1–3 with exactly this exhaust geometry (i6 firing order 3
    // clear of a muffler-branch notch at 4000 rpm; flat4 and rotary order 2 dominant), so the whole
    // geometry of these three fixtures is pinned: re-tune it only together with the invariant suite.
    const exhaust = (id: FixtureId) => {
      const e = def(id).voicing.exhaust;
      return { midPipeM: e.midPipeM, mufflerSectionsM: e.mufflerSectionsM, tailpipeM: e.tailpipeM };
    };
    expect(exhaust('i6-test')).toEqual({ midPipeM: 1.3, mufflerSectionsM: [0.2, 0.32, 0.44, 0.62], tailpipeM: 0.5 });
    expect(exhaust('flat4-uel-test')).toEqual({ midPipeM: 1.5, mufflerSectionsM: [0.22, 0.35, 0.62], tailpipeM: 0.5 });
    expect(exhaust('rotary-test')).toEqual({ midPipeM: 2.2, mufflerSectionsM: [0.25, 0.4], tailpipeM: 0.55 });
  });

  it('even-fire fixtures use equal headers (amendment B8); uneven-fire ones do not', () => {
    for (const id of ['i4-test', 'i6-test', 'v8-flatplane-test']) {
      expect(new Set(loadFixture(id).voicing.headersM).size, id).toBe(1);
    }
    for (const id of ['i5-test', 'v8-crossplane-test', 'v8-sc-test', 'flat4-uel-test']) {
      expect(new Set(loadFixture(id).voicing.headersM).size, id).toBeGreaterThan(1);
    }
  });

  it('agrees with the shared firingHz formula', () => {
    const fire = (id: string, rpm: number) => {
      const d = loadFixture(id);
      return firingHz(rpm, d.spec.combustion.length, d.spec.cycleDeg);
    };
    expect(fire('i4-test', 6000)).toBeCloseTo(200, 9);
    expect(fire('i5-test', 6000)).toBeCloseTo(250, 9);
    expect(fire('i6-test', 6000)).toBeCloseTo(300, 9);
    expect(fire('v8-crossplane-test', 6000)).toBeCloseTo(400, 9);
    expect(fire('rotary-test', 6000)).toBeCloseTo(200, 9);
  });
});
