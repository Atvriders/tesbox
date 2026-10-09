/**
 * Minimal WAV I/O for the render/score CLIs (Node only).
 * writeWav: 32-bit IEEE float (format tag 3, 18-byte fmt chunk, fact chunk), interleaved.
 * readWav: PCM 16/24/32-bit integer and 32-bit float, incl. WAVE_FORMAT_EXTENSIBLE; skips unknown chunks.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const HEADER_BYTES = 12 + (8 + 18) + (8 + 4) + 8;

export function writeWav(path: string, channels: Float32Array[], fs: number): void {
  const nch = channels.length;
  const first = channels[0];
  // blockAlign = 4·nch is a 16-bit fmt field: at most 16383 channels.
  if (first === undefined || nch * 4 > 0xffff) throw new RangeError('writeWav: need 1..16383 channels');
  const frames = first.length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new RangeError('writeWav: all channels must have the same length');
  }
  if (!Number.isInteger(fs) || fs <= 0) throw new RangeError(`writeWav: invalid sample rate ${fs}`);
  const blockAlign = nch * 4;
  // The byte rate fs·blockAlign is a 32-bit fmt field (this also bounds fs itself).
  if (fs * blockAlign > 0xffffffff) throw new RangeError('writeWav: byte rate exceeds 32 bits');
  const dataBytes = frames * blockAlign;
  if (HEADER_BYTES + dataBytes > 0xffffffff) throw new RangeError('writeWav: file exceeds 4 GiB');
  const buf = Buffer.alloc(HEADER_BYTES + dataBytes);
  let o = 0;
  buf.write('RIFF', o, 'ascii');
  buf.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, o + 4);
  buf.write('WAVE', o + 8, 'ascii');
  o += 12;
  buf.write('fmt ', o, 'ascii');
  buf.writeUInt32LE(18, o + 4);
  buf.writeUInt16LE(WAVE_FORMAT_IEEE_FLOAT, o + 8);
  buf.writeUInt16LE(nch, o + 10);
  buf.writeUInt32LE(fs, o + 12);
  buf.writeUInt32LE(fs * blockAlign, o + 16);
  buf.writeUInt16LE(blockAlign, o + 20);
  buf.writeUInt16LE(32, o + 22);
  buf.writeUInt16LE(0, o + 24); // cbSize
  o += 26;
  buf.write('fact', o, 'ascii');
  buf.writeUInt32LE(4, o + 4);
  buf.writeUInt32LE(frames, o + 8);
  o += 12;
  buf.write('data', o, 'ascii');
  buf.writeUInt32LE(dataBytes, o + 4);
  o += 8;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < nch; c++) {
      buf.writeFloatLE(channels[c]?.[f] ?? 0, o);
      o += 4;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

interface Fmt {
  tag: number;
  nch: number;
  fs: number;
  blockAlign: number;
  bits: number;
}

export function readWav(path: string): { fs: number; channels: Float32Array[] } {
  const b = readFileSync(path);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`readWav: ${path} is not a RIFF/WAVE file`);
  }
  let fmt: Fmt | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > b.length) throw new Error(`readWav: ${path} has a truncated fmt chunk`);
      let tag = b.readUInt16LE(body);
      if (tag === WAVE_FORMAT_EXTENSIBLE) {
        if (size < 40) throw new Error(`readWav: ${path} has a truncated WAVE_FORMAT_EXTENSIBLE fmt chunk`);
        tag = b.readUInt16LE(body + 24); // first two bytes of the SubFormat GUID
      }
      fmt = {
        tag,
        nch: b.readUInt16LE(body + 2),
        fs: b.readUInt32LE(body + 4),
        blockAlign: b.readUInt16LE(body + 12),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, b.length - body);
    }
    off = body + size + (size & 1);
  }
  if (fmt === null) throw new Error(`readWav: ${path} has no fmt chunk`);
  if (dataOff < 0) throw new Error(`readWav: ${path} has no data chunk`);
  const { tag, nch, fs, blockAlign, bits } = fmt;
  const supported =
    (tag === WAVE_FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32)) ||
    (tag === WAVE_FORMAT_IEEE_FLOAT && bits === 32);
  if (!supported) throw new Error(`readWav: ${path}: unsupported format tag ${tag} with ${bits} bits`);
  const bytes = bits / 8;
  if (nch < 1 || blockAlign < nch * bytes) throw new Error(`readWav: ${path}: inconsistent fmt chunk`);
  const frames = Math.floor(dataLen / blockAlign);
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c++) channels.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = dataOff + f * blockAlign;
    for (let c = 0; c < nch; c++) {
      const p = base + c * bytes;
      let v: number;
      if (tag === WAVE_FORMAT_IEEE_FLOAT) v = b.readFloatLE(p);
      else if (bits === 16) v = b.readInt16LE(p) / 32768;
      else if (bits === 24) v = b.readIntLE(p, 3) / 8388608;
      else v = b.readInt32LE(p) / 2147483648;
      const ch = channels[c];
      if (ch !== undefined) ch[f] = v;
    }
  }
  return { fs, channels };
}
