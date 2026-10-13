/** ISO metric tyre code parsing and rolling geometry (spec §8.3). */

export interface Tyre {
  widthMm: number;
  aspectPct: number;
  rimIn: number;
}

/**
 * Accepted forms: "265/30R19", "265/30 R19", "265/30ZR19", "P245/45R18" (optional "P" prefix,
 * optional single space before the construction letter, optional "Z" speed marker, radial "R").
 * Anything else (load index, lowercase, inch sizes, half-inch rims, whitespace padding) throws.
 */
const TYRE_CODE = /^P?(\d{3})\/(\d{2})( ?)(Z?)R(\d{2})$/;

/** Dynamic rolling radius factor: loaded/rolling circumference ≈ 0.97 × unloaded (spec §8.3). */
const ROLLING_FACTOR = 0.97;

export function parseTyre(code: string): Tyre {
  const m = TYRE_CODE.exec(code);
  if (m === null) {
    throw new Error(`Unrecognised tyre code "${code}" (expected e.g. 265/30R19)`);
  }
  const widthMm = Number(m[1]);
  const aspectPct = Number(m[2]);
  const rimIn = Number(m[5]);
  if (!(widthMm > 0 && aspectPct > 0 && rimIn > 0)) {
    throw new Error(`Tyre code "${code}" has a zero dimension`);
  }
  return { widthMm, aspectPct, rimIn };
}

/** C_dyn = π × (2·w·ar/100 + rim·25.4) / 1000 × 0.97, metres. */
export function rollingCircumferenceM(code: string): number {
  const t = parseTyre(code);
  const diameterMm = (2 * t.widthMm * t.aspectPct) / 100 + t.rimIn * 25.4;
  return ((Math.PI * diameterMm) / 1000) * ROLLING_FACTOR;
}

/** Engine-side rpm for a road speed: speed / C × overallRatio × 60. Allocation-free. */
export function wheelRpm(speedMps: number, overallRatio: number, circumferenceM: number): number {
  return (speedMps / circumferenceM) * overallRatio * 60;
}
