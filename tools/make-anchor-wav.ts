/**
 * Generates public/probe/anchor.wav for the "direct + anchor" output route (spec §6.4): a looping,
 * near-silent FILE source > 5 s long that keeps the browser's media session alive.
 *
 * Format: RIFF/WAVE, PCM, 8 kHz, mono, 16-bit, 10 s. Content: deterministic triangular (TPDF)
 * noise, DC removed, scaled to −60 dBFS RMS, where dBFS = 20·log10(rms / 32768).
 * Noise (not digital silence) so that a player which ignores all-zero audio still treats it as
 * audible. PRNG: xorshift32 (Marsaglia 2003, "Xorshift RNGs", J. Stat. Softw. 8(14)).
 *
 * Run: npm run gen:anchor   (the committed file must equal this output; a unit test checks it)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AnchorOptions {
  seconds: number;
  sampleRate: number;
  rmsDbfs: number;
  seed: number;
}

export const ANCHOR_DEFAULTS: AnchorOptions = { seconds: 10, sampleRate: 8000, rmsDbfs: -60, seed: 0x5eed7e5b };

export const ANCHOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../public/probe/anchor.wav');

/** xorshift32 → uniform in [0, 1). Seed 0 is replaced by 1 (0 is a fixed point). */
function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s / 4294967296;
  };
}

/** Deterministic 16-bit noise samples at exactly `rmsDbfs` (before integer rounding). */
export function anchorSamples(opts: AnchorOptions = ANCHOR_DEFAULTS): Int16Array {
  const n = Math.round(opts.seconds * opts.sampleRate);
  const rnd = xorshift32(opts.seed);
  const x = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = rnd() + rnd() - 1; // triangular on (−1, 1)
    x[i] = v;
    mean += v;
  }
  mean = n > 0 ? mean / n : 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = (x[i] ?? 0) - mean;
    x[i] = v;
    sumSq += v * v;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const gain = rms > 0 ? (Math.pow(10, opts.rmsDbfs / 20) * 32768) / rms : 0;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * gain)));
  }
  return out;
}

/** Canonical 44-byte-header PCM WAV (little-endian), mono 16-bit. */
export function encodeWav16Mono(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const dv = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // channels
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate = rate × blockAlign
  dv.setUint16(32, 2, true); // block align = channels × 2 bytes
  dv.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return bytes;
}

export function makeAnchorWav(opts: AnchorOptions = ANCHOR_DEFAULTS): Uint8Array {
  return encodeWav16Mono(anchorSamples(opts), opts.sampleRate);
}

function main(): void {
  const bytes = makeAnchorWav();
  mkdirSync(dirname(ANCHOR_PATH), { recursive: true });
  writeFileSync(ANCHOR_PATH, bytes);
  console.log(`wrote ${ANCHOR_PATH} (${bytes.length} bytes)`);
}

// Run only when executed directly (tsx tools/make-anchor-wav.ts), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main();
