/**
 * SHA-256 of a score render (phase 5 contract P0b: with the P0b voicing fields at their neutral defaults every
 * render is bit-identical to Tesbox 1.3.0). The render is tools/render.ts renderSegment exactly as tools/score.ts
 * renderClip calls it — a fresh Full-tier core, seed 1, subwoofer 'yes', 48 kHz — over one of the score CLI's
 * RENDER_PLAN segments; the hash covers the left then the right Float32 channel (raw bytes, in sample order).
 * Each render also carries its per-channel RMS: bit-exact hashes only hold on the JavaScript engine that made
 * them (Math.sin/exp/pow may differ in the last bit between V8 versions), so another runtime compares the RMS.
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
/** Segment → perspective → [left RMS, right RMS]. */
export type EngineRms = Record<string, Record<string, [number, number]>>;

export interface EnginePrints {
  hashes: EngineHashes;
  rms: EngineRms;
}

function rmsOf(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (x[i] ?? 0) * (x[i] ?? 0);
  return x.length === 0 ? 0 : Math.sqrt(sum / x.length);
}

function renderPrint(def: EngineDef, segment: string, perspective: Perspective): { hash: string; rms: [number, number] } {
  const seg = SEGMENTS.find((s) => s.name === segment);
  if (seg === undefined) throw new Error(`render-hash: tools/segments.ts has no segment ${segment}`);
  const { left, right } = renderSegment(def, seg, { perspective, subwoofer: 'yes', fs: FS });
  const h = createHash('sha256');
  h.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
  h.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  return { hash: h.digest('hex'), rms: [rmsOf(left), rmsOf(right)] };
}

export function renderHash(def: EngineDef, segment: string, perspective: Perspective): string {
  return renderPrint(def, segment, perspective).hash;
}

/** Every score segment × both perspectives of one engine: hashes and RMS. */
export function enginePrints(def: EngineDef): EnginePrints {
  const hashes: EngineHashes = {};
  const rms: EngineRms = {};
  for (const segment of HASH_SEGMENTS) {
    const hRow: Record<string, string> = {};
    const rRow: Record<string, [number, number]> = {};
    for (const p of HASH_PERSPECTIVES) {
      const f = renderPrint(def, segment, p);
      hRow[p] = f.hash;
      rRow[p] = f.rms;
    }
    hashes[segment] = hRow;
    rms[segment] = rRow;
  }
  return { hashes, rms };
}

/** Every score segment × both perspectives of one engine. */
export function engineHashes(def: EngineDef): EngineHashes {
  return enginePrints(def).hashes;
}
