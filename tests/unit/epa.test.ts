import { describe, expect, it } from 'vitest';
import { EPA_TO_SI } from '../../src/contracts';
import { epaToSi } from '../../src/sim/epa';

const LBF_N = 4.4482216152605; // exact definition of the pound-force
const MPH_MPS = 0.44704; // exact definition of the mile per hour

describe('epaToSi', () => {
  it('multiplies each coefficient by the contract constant', () => {
    expect(epaToSi({ A_lbf: 1, B_lbf_per_mph: 1, C_lbf_per_mph2: 1 })).toEqual({
      A_N: EPA_TO_SI.A,
      B_Nps_m: EPA_TO_SI.B,
      C_Ns2_m2: EPA_TO_SI.C,
    });
  });

  it('keeps a negative B coefficient negative', () => {
    const si = epaToSi({ A_lbf: 30, B_lbf_per_mph: -0.12, C_lbf_per_mph2: 0.017 });
    expect(si.B_Nps_m).toBeCloseTo(-0.12 * 9.9504, 9);
    expect(si.B_Nps_m).toBeLessThan(0);
  });

  it('agrees with the exact unit definitions to 1e-5 relative', () => {
    expect(EPA_TO_SI.A / LBF_N).toBeCloseTo(1, 5);
    expect(EPA_TO_SI.B / (LBF_N / MPH_MPS)).toBeCloseTo(1, 5);
    expect(EPA_TO_SI.C / (LBF_N / (MPH_MPS * MPH_MPS))).toBeCloseTo(1, 5);
  });

  it('reproduces a hand-computed road-load force at 100 km/h (illustrative coefficients)', () => {
    // Illustrative EPA Target row (not a real vehicle): A 30 lbf, B 0.2 lbf/mph, C 0.015 lbf/mph².
    // 100 km/h = 27.7778 m/s = 62.1371 mph
    // F = 30 + 0.2·62.1371 + 0.015·62.1371² = 30 + 12.4274 + 57.9152 = 100.3426 lbf = 446.35 N
    const t = { A_lbf: 30, B_lbf_per_mph: 0.2, C_lbf_per_mph2: 0.015 };
    const si = epaToSi(t);
    const v = 100 / 3.6;
    const fSi = si.A_N + si.B_Nps_m * v + si.C_Ns2_m2 * v * v;
    const mph = v / MPH_MPS;
    const fImperialN = (t.A_lbf + t.B_lbf_per_mph * mph + t.C_lbf_per_mph2 * mph * mph) * LBF_N;
    expect(fSi / fImperialN).toBeCloseTo(1, 5);
    expect(fSi).toBeCloseTo(446.35, 1);
  });
});
