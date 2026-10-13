import { EPA_TO_SI } from '../contracts';

/** EPA Test Car List *Target* road-load coefficients in their published units (spec §8.5). */
export interface EpaTarget {
  A_lbf: number;
  B_lbf_per_mph: number;
  C_lbf_per_mph2: number;
}

/** Converts EPA Target A/B/C (lbf, lbf/mph, lbf/mph²) to SI (N, N·s/m, N·s²/m²). Negative B allowed. */
export function epaToSi(t: EpaTarget): { A_N: number; B_Nps_m: number; C_Ns2_m2: number } {
  return {
    A_N: t.A_lbf * EPA_TO_SI.A,
    B_Nps_m: t.B_lbf_per_mph * EPA_TO_SI.B,
    C_Ns2_m2: t.C_lbf_per_mph2 * EPA_TO_SI.C,
  };
}
