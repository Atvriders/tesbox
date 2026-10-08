/** Mean Earth radius (IUGG R1), metres. */
const EARTH_RADIUS_M = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in metres between two WGS84 points (haversine formula, spherical Earth).
 * Allocation-free: safe to call from SimCore's per-fix path (Phase 1).
 */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const sinHalfDLat = Math.sin(((lat2 - lat1) * DEG_TO_RAD) / 2);
  const sinHalfDLon = Math.sin(((lon2 - lon1) * DEG_TO_RAD) / 2);
  const h =
    sinHalfDLat * sinHalfDLat +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * sinHalfDLon * sinHalfDLon;
  // Rounding can push h a hair above 1 for antipodal points; asin(>1) would be NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}
