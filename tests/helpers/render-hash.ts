/**
 * SHA-256 of a score render (phase 5 contract P0b: with the P0b voicing fields at their neutral defaults every
 * render is bit-identical to Tesbox 1.3.0). The render is tools/render.ts renderSegment exactly as tools/score.ts
 * renderClip calls it — a fresh Full-tier core, seed 1, subwoofer 'yes', 48 kHz — over one of the score CLI's
 * RENDER_PLAN segments; the hash covers the left then the right Float32 channel (raw bytes, in sample order).
 */
import { createHash } from 'node:crypto';
import type { EngineDef, Perspective } from '../../src/contracts';
import { renderSegment } from '../../tools/render';
import { FS, RENDER_PLAN } from '../../tools/score';
import { SEGMENTS } from '../../tools/segments';

/** The score CLI's render segments (idle, cruise2k, cruise4k, cruise6k, wotPull, liftoff6k). */
export const HASH_SEGMENTS: readonly string[] = RENDER_PLAN.map((p) => p.segment);
export const HASH_PERSPECTIVES: readonly Perspective[] = ['cabin', 'outside'];

/** Segment → perspective → hex SHA-256. */
export type EngineHashes = Record<string, Record<string, string>>;

export function renderHash(def: EngineDef, segment: string, perspective: Perspective): string {
  const seg = SEGMENTS.find((s) => s.name === segment);
  if (seg === undefined) throw new Error(`render-hash: tools/segments.ts has no segment ${segment}`);
  const { left, right } = renderSegment(def, seg, { perspective, subwoofer: 'yes', fs: FS });
  const h = createHash('sha256');
  h.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
  h.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  return h.digest('hex');
}

/** Every score segment × both perspectives of one engine. */
export function engineHashes(def: EngineDef): EngineHashes {
  const out: EngineHashes = {};
  for (const segment of HASH_SEGMENTS) {
    const row: Record<string, string> = {};
    for (const p of HASH_PERSPECTIVES) row[p] = renderHash(def, segment, p);
    out[segment] = row;
  }
  return out;
}
