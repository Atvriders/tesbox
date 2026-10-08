import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANCHOR_DEFAULTS, ANCHOR_PATH, anchorSamples, encodeWav16Mono, makeAnchorWav } from '../../tools/make-anchor-wav';

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function stats(s: Int16Array): { rmsDbfs: number; peakDbfs: number; mean: number } {
  let sumSq = 0;
  let peak = 0;
  let sum = 0;
  for (const v of s) {
    sumSq += v * v;
    sum += v;
    peak = Math.max(peak, Math.abs(v));
  }
  return {
    rmsDbfs: 20 * Math.log10(Math.sqrt(sumSq / s.length) / 32768),
    peakDbfs: 20 * Math.log10(peak / 32768),
    mean: sum / s.length,
  };
}

describe('make-anchor-wav', () => {
  it('writes a canonical PCM header: 8 kHz, mono, 16-bit, 10 s', () => {
    const wav = makeAnchorWav();
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.length).toBe(44 + 10 * 8000 * 2);
    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(dv.getUint32(4, true)).toBe(wav.length - 8);
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(dv.getUint32(16, true)).toBe(16);
    expect(dv.getUint16(20, true)).toBe(1);
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint32(24, true)).toBe(8000);
    expect(dv.getUint32(28, true)).toBe(16000);
    expect(dv.getUint16(32, true)).toBe(2);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 4)).toBe('data');
    expect(dv.getUint32(40, true)).toBe(160000);
  });

  it('is longer than 5 s (spec §6.4 anchor requirement)', () => {
    const s = anchorSamples();
    expect(s.length / ANCHOR_DEFAULTS.sampleRate).toBe(10);
  });

  it('is low-level noise at −60 dBFS RMS (±0.5 dB), peaks below −40 dBFS, no DC', () => {
    const s = stats(anchorSamples());
    expect(Math.abs(s.rmsDbfs + 60)).toBeLessThan(0.5);
    expect(s.peakDbfs).toBeLessThan(-40);
    expect(Math.abs(s.mean)).toBeLessThan(0.5);
  });

  it('is not digital silence and not a constant pattern', () => {
    const s = anchorSamples();
    expect(new Set(s).size).toBeGreaterThan(50);
  });

  it('is deterministic: identical bytes on every call, different with another seed', () => {
    const a = Buffer.from(makeAnchorWav());
    expect(a.equals(Buffer.from(makeAnchorWav()))).toBe(true);
    expect(a.equals(Buffer.from(makeAnchorWav({ ...ANCHOR_DEFAULTS, seed: 1 })))).toBe(false);
  });

  it('encodes sample values little-endian after the header', () => {
    const wav = encodeWav16Mono(Int16Array.from([1, -2, 32767, -32768]), 8000);
    const dv = new DataView(wav.buffer);
    expect([dv.getInt16(44, true), dv.getInt16(46, true), dv.getInt16(48, true), dv.getInt16(50, true)]).toEqual([
      1, -2, 32767, -32768,
    ]);
  });

  it('the committed public/probe/anchor.wav equals the generator output (run npm run gen:anchor)', () => {
    expect(existsSync(ANCHOR_PATH)).toBe(true);
    expect(readFileSync(ANCHOR_PATH).equals(Buffer.from(makeAnchorWav()))).toBe(true);
  });
});
