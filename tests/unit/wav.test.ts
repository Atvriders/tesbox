import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readWav, writeWav } from '../../tools/wav';

const dir = mkdtempSync(join(tmpdir(), 'tesbox-wav-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface BuildOpts {
  tag: number;
  nch: number;
  fs: number;
  bits: number;
  data: Buffer;
  extensibleSubTag?: number;
  preChunk?: Buffer;
}

/** Hand-assembles a WAV file so the reader is tested independently of the writer. */
function buildWav(o: BuildOpts): Buffer {
  const blockAlign = o.nch * (o.bits / 8);
  const fmt = Buffer.alloc(o.extensibleSubTag === undefined ? 16 : 40);
  fmt.writeUInt16LE(o.extensibleSubTag === undefined ? o.tag : 0xfffe, 0);
  fmt.writeUInt16LE(o.nch, 2);
  fmt.writeUInt32LE(o.fs, 4);
  fmt.writeUInt32LE(o.fs * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(o.bits, 14);
  if (o.extensibleSubTag !== undefined) {
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(o.bits, 18); // valid bits
    fmt.writeUInt32LE(0, 20); // channel mask
    fmt.writeUInt16LE(o.extensibleSubTag, 24); // SubFormat GUID (first 2 bytes = format tag)
  }
  const chunk = (id: string, body: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    o.preChunk ?? Buffer.alloc(0),
    chunk('data', o.data),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function file(name: string, content: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('writeWav / readWav', () => {
  it('round-trips 32-bit float stereo bit-exactly and creates the output directory', () => {
    const l = Float32Array.from([0, 0.5, -1, 0.123456789, 1e-8]);
    const r = Float32Array.from([1, -0.5, 0.25, -0.75, 0]);
    const p = join(dir, 'nested', 'deeper', 'rt.wav');
    writeWav(p, [l, r], 48000);
    const raw = readFileSync(p);
    expect(raw.toString('ascii', 0, 4)).toBe('RIFF');
    expect(raw.readUInt32LE(4)).toBe(raw.length - 8);
    expect(raw.readUInt16LE(20)).toBe(3); // WAVE_FORMAT_IEEE_FLOAT
    const back = readWav(p);
    expect(back.fs).toBe(48000);
    expect(back.channels.length).toBe(2);
    expect(Array.from(back.channels[0] ?? [])).toEqual(Array.from(l));
    expect(Array.from(back.channels[1] ?? [])).toEqual(Array.from(r));
  });

  it('writes a mono file that reads back with the same length', () => {
    const p = join(dir, 'mono.wav');
    writeWav(p, [new Float32Array(1000).fill(0.25)], 44100);
    const back = readWav(p);
    expect(back.fs).toBe(44100);
    expect(back.channels[0]?.length).toBe(1000);
    expect(back.channels[0]?.[999]).toBe(0.25);
  });

  it('rejects mismatched channel lengths, no channels, and bad sample rates', () => {
    const p = join(dir, 'bad.wav');
    expect(() => writeWav(p, [new Float32Array(2), new Float32Array(3)], 48000)).toThrow(RangeError);
    expect(() => writeWav(p, [], 48000)).toThrow(RangeError);
    expect(() => writeWav(p, [new Float32Array(2)], 0)).toThrow(RangeError);
    expect(() => writeWav(p, [new Float32Array(2)], 44100.5)).toThrow(RangeError);
  });

  it('rejects channel counts and sample rates the 16/32-bit header fields cannot hold, with its own message', () => {
    const p = join(dir, 'wide.wav');
    const chans = (k: number): Float32Array[] => Array.from({ length: k }, () => new Float32Array(0));
    // blockAlign = 4·nch is a uint16: 16383 channels (65532 bytes) fit, 16384 do not
    const tooWide = (): void => writeWav(p, chans(16384), 48000);
    expect(tooWide).toThrow(RangeError);
    expect(tooWide).toThrow(/writeWav: need 1\.\.16383 channels/);
    // byte rate = fs·blockAlign is a uint32: 2^30 Hz × 4 bytes = 2^32 does not fit
    const tooFast = (): void => writeWav(p, [new Float32Array(1)], 2 ** 30);
    expect(tooFast).toThrow(RangeError);
    expect(tooFast).toThrow(/writeWav: byte rate exceeds 32 bits/);
    writeWav(p, chans(16383), 48000);
    const back = readWav(p);
    expect(back.channels.length).toBe(16383);
    expect(back.channels[16382]?.length).toBe(0);
  });

  it('reads 16-bit PCM, skipping an odd-sized chunk before data', () => {
    const data = Buffer.alloc(6);
    data.writeInt16LE(-32768, 0);
    data.writeInt16LE(0, 2);
    data.writeInt16LE(16384, 4);
    const list = Buffer.alloc(8 + 3 + 1);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(3, 4); // odd size → one pad byte follows
    const p = file('pcm16.wav', buildWav({ tag: 1, nch: 1, fs: 22050, bits: 16, data, preChunk: list }));
    const w = readWav(p);
    expect(w.fs).toBe(22050);
    expect(Array.from(w.channels[0] ?? [])).toEqual([-1, 0, 0.5]);
  });

  it('reads interleaved 24-bit PCM stereo', () => {
    const data = Buffer.alloc(12);
    data.writeIntLE(4194304, 0, 3); // L0 = 0.5
    data.writeIntLE(-8388608, 3, 3); // R0 = −1
    data.writeIntLE(-4194304, 6, 3); // L1 = −0.5
    data.writeIntLE(0, 9, 3); // R1 = 0
    const w = readWav(file('pcm24.wav', buildWav({ tag: 1, nch: 2, fs: 48000, bits: 24, data })));
    expect(Array.from(w.channels[0] ?? [])).toEqual([0.5, -0.5]);
    expect(Array.from(w.channels[1] ?? [])).toEqual([-1, 0]);
  });

  it('reads 32-bit integer PCM and WAVE_FORMAT_EXTENSIBLE', () => {
    const d32 = Buffer.alloc(8);
    d32.writeInt32LE(1073741824, 0);
    d32.writeInt32LE(-2147483648, 4);
    expect(Array.from(readWav(file('pcm32.wav', buildWav({ tag: 1, nch: 1, fs: 48000, bits: 32, data: d32 }))).channels[0] ?? [])).toEqual([0.5, -1]);
    const d24 = Buffer.alloc(3);
    d24.writeIntLE(-4194304, 0, 3);
    const ext = readWav(file('ext24.wav', buildWav({ tag: 1, nch: 1, fs: 96000, bits: 24, data: d24, extensibleSubTag: 1 })));
    expect(ext.fs).toBe(96000);
    expect(Array.from(ext.channels[0] ?? [])).toEqual([-0.5]);
  });

  it('rejects non-RIFF files and unsupported encodings', () => {
    expect(() => readWav(file('junk.wav', Buffer.from('not a wav file at all')))).toThrow(/RIFF/);
    const p8 = file('pcm8.wav', buildWav({ tag: 1, nch: 1, fs: 8000, bits: 8, data: Buffer.from([128, 255]) }));
    expect(() => readWav(p8)).toThrow(/unsupported/);
  });
});
