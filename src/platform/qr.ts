/*!
 * In-house QR Code encoder after ISO/IEC 18004: byte mode, error-correction level L,
 * versions 1–40, all eight data masks scored with penalty rules N1–N4. Layout, BCH,
 * Reed–Solomon, codeword-placement and mask-selection code adapted from Project Nayuki's
 * "QR Code generator library" (TypeScript), Copyright (c) Project Nayuki, MIT License,
 * https://www.nayuki.io/page/qr-code-generator-library (full notice in NOTICES). Used only
 * for the statistics-only diagnostics export, never on an audio path, so clarity beats speed
 * here.
 * @license MIT — Copyright (c) Project Nayuki. (MIT License)
 */

export interface QrMatrix {
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** size × size, row-major, 1 = dark. */
  modules: Uint8Array;
}

/** EC codewords per block, level L, versions 1–40 (ISO/IEC 18004 Table 9). */
const ECC_PER_BLOCK_L = [
  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
  26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
];

/** Number of EC blocks, level L, versions 1–40 (ISO/IEC 18004 Table 9). */
const ECC_BLOCKS_L = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14,
  15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
];

function tableAt(table: readonly number[], version: number): number {
  const v = table[version - 1];
  if (v === undefined) throw new RangeError(`QR version out of range: ${version}`);
  return v;
}

/**
 * Modules left for data + EC after all function patterns, derived from the symbol layout:
 * size² − 3 finders with separators (3 × 64) − format info and dark module (31) − timing
 * (2 × (size − 16)) = (16v + 128)v + 64; minus alignment patterns 25(n² − 3) less the
 * 10(n − 2) modules they share with the timing lines, n = ⌊v/7⌋ + 2 (v ≥ 2); minus version
 * info 2 × 18 (v ≥ 7).
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    result -= (25 * n - 10) * n - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewordsL(version: number): number {
  return (
    totalCodewords(version) - tableAt(ECC_PER_BLOCK_L, version) * tableAt(ECC_BLOCKS_L, version)
  );
}

function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Largest UTF-8 byte payload that fits a version-`version` level-L symbol in byte mode. */
export function qrByteCapacityL(version: number): number {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new RangeError(`QR version out of range: ${version}`);
  }
  return Math.floor((dataCodewordsL(version) * 8 - 4 - countBits(version)) / 8);
}

// ───────────────────────────── GF(256) and Reed–Solomon ─────────────────────────────

/** GF(2⁸) with the QR primitive polynomial x⁸ + x⁴ + x³ + x² + 1 (0x11D), generator α = 2. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

const generatorCache = new Map<number, Uint8Array>();

/** g(x) = Π_{i=0}^{degree−1} (x − αⁱ), coefficients highest power first (leading 1 included). */
function generatorPoly(degree: number): Uint8Array {
  const cached = generatorCache.get(degree);
  if (cached) return cached;
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) {
    const root = GF_EXP[i] ?? 0;
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      const c = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ c;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(c, root);
    }
    poly = next;
  }
  generatorCache.set(degree, poly);
  return poly;
}

/** Reed–Solomon EC codewords: remainder of data(x) · x^eccLen divided by g(x). */
export function reedSolomonEcc(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = generatorPoly(eccLen);
  const rem = new Uint8Array(eccLen);
  for (const byte of data) {
    const factor = byte ^ (rem[0] ?? 0);
    rem.copyWithin(0, 1);
    rem[eccLen - 1] = 0;
    for (let j = 0; j < eccLen; j++) rem[j] = (rem[j] ?? 0) ^ gfMul(gen[j + 1] ?? 0, factor);
  }
  return rem;
}

// ───────────────────────────── Symbol constants ─────────────────────────────

/** Byte-mode capacity of version 40-L. */
const MAX_BYTES = 2953;

/** Format-information EC level bits: L = 01. */
const ECL_BITS_L = 1;

/**
 * Never emitted: jsQR ≤ 1.4.0 (our e2e decoder, also inside some web scanner apps) has version
 * 23's alignment centres as 6/30/54/74/102 instead of ISO's 6/30/54/78/102 and cannot read it.
 * Payloads that would fit version 23 use version 24.
 */
const SKIPPED_VERSION = 23;

// ───────────────────────────── Data codewords ─────────────────────────────

function encodeDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewordsL(version);
  const out = new Uint8Array(capacity);
  let bitLen = 0;
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) {
      if ((value >>> i) & 1) {
        const index = bitLen >>> 3;
        out[index] = (out[index] ?? 0) | (0x80 >>> (bitLen & 7));
      }
      bitLen++;
    }
  };
  put(0b0100, 4); // byte-mode indicator
  put(bytes.length, countBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bitLen)); // terminator
  let index = Math.ceil(bitLen / 8); // zero bits up to the byte boundary are already in `out`
  for (let pad = 0xec; index < capacity; index++, pad ^= 0xec ^ 0x11) out[index] = pad;
  return out;
}

/** Splits data into the version's blocks, appends each block's EC, interleaves (ISO 7.6). */
function interleaveWithEcc(data: Uint8Array, version: number): Uint8Array {
  const numBlocks = tableAt(ECC_BLOCKS_L, version);
  const eccLen = tableAt(ECC_PER_BLOCK_L, version);
  const total = totalCodewords(version);
  const numShort = numBlocks - (total % numBlocks);
  const shortDataLen = Math.floor(total / numBlocks) - eccLen;
  const blocks: Uint8Array[] = [];
  const eccs: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = shortDataLen + (b < numShort ? 0 : 1);
    const block = data.subarray(offset, offset + len);
    offset += len;
    blocks.push(block);
    eccs.push(reedSolomonEcc(block, eccLen));
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = 0; i <= shortDataLen; i++) {
    for (const block of blocks) {
      const v = block[i];
      if (v !== undefined) out[o++] = v;
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (const ecc of eccs) out[o++] = ecc[i] ?? 0;
  }
  return out;
}

// ───────────────────────────── Matrix construction ─────────────────────────────

class Grid {
  readonly size: number;
  readonly modules: Uint8Array;
  /** 1 where a function pattern lives (never masked, never holds data). */
  readonly isFunction: Uint8Array;
  constructor(size: number) {
    this.size = size;
    this.modules = new Uint8Array(size * size);
    this.isFunction = new Uint8Array(size * size);
  }
  setFunction(x: number, y: number, dark: boolean): void {
    const i = y * this.size + x;
    this.modules[i] = dark ? 1 : 0;
    this.isFunction[i] = 1;
  }
}

function bit(value: number, i: number): boolean {
  return ((value >>> i) & 1) !== 0;
}

/** Alignment-pattern centre coordinates (ISO Annex E): first 6, last size − 7, even spacing. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < n; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      g.setFunction(x, y, ring !== 2 && ring !== 4); // ring 4 = separator
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      g.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 15-bit format information: (ECL, mask) + BCH(15,5) remainder, XOR 0x5412 (ISO 7.9). */
function formatBits(mask: number): number {
  const data = (ECL_BITS_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function drawFormatBits(g: Grid, mask: number): void {
  const bits = formatBits(mask);
  const size = g.size;
  // Copy 1, around the top-left finder.
  for (let i = 0; i <= 5; i++) g.setFunction(8, i, bit(bits, i));
  g.setFunction(8, 7, bit(bits, 6));
  g.setFunction(8, 8, bit(bits, 7));
  g.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.setFunction(14 - i, 8, bit(bits, i));
  // Copy 2, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) g.setFunction(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.setFunction(8, size - 15 + i, bit(bits, i));
  g.setFunction(8, size - 8, true); // the always-dark module
}

/** 18-bit version information: version + BCH(18,6) remainder (ISO 7.10), versions ≥ 7 only. */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFunction(a, b, bit(bits, i));
    g.setFunction(b, a, bit(bits, i));
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const size = g.size;
  for (let i = 0; i < size; i++) {
    g.setFunction(6, i, i % 2 === 0);
    g.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, size - 4, 3);
  drawFinder(g, 3, size - 4);
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  pos.forEach((y, i) => {
    pos.forEach((x, j) => {
      const overlapsFinder =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!overlapsFinder) drawAlignment(g, x, y);
    });
  });
  drawFormatBits(g, 0); // reserves the format area; redrawn once the mask is chosen
  drawVersion(g, version);
}

/** Places codeword bits in the two-module-wide zigzag from the bottom-right corner (ISO 7.7.3). */
function placeCodewords(g: Grid, codewords: Uint8Array): void {
  const size = g.size;
  const totalBits = codewords.length * 8;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const index = y * size + x;
        if (g.isFunction[index] === 1) continue;
        if (i < totalBits) {
          g.modules[index] = ((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1;
          i++;
        } // else: remainder bit, left light (0) before masking
      }
    }
  }
  if (i !== totalBits) throw new Error(`QR placement mismatch: ${i} of ${totalBits} bits placed`);
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError(`QR mask out of range: ${mask}`);
  }
}

/** XORs the mask into every non-function module; applying it twice restores the grid. */
function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      const index = y * g.size + x;
      if (g.isFunction[index] === 0 && maskHit(mask, x, y)) {
        g.modules[index] = (g.modules[index] ?? 0) ^ 1;
      }
    }
  }
}

// ───────────────────────────── Penalty (ISO 7.8.3) ─────────────────────────────

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;
const FINDER_CORE = [1, 0, 1, 1, 1, 0, 1];

/** N1 (runs ≥ 5) and N3 (1:1:3:1:1 with 4 light modules before or after) along one line. */
function linePenalty(read: (i: number) => number, size: number): number {
  let score = 0;
  let runColor = -1;
  let runLength = 0;
  for (let i = 0; i < size; i++) {
    const c = read(i);
    if (c === runColor) {
      runLength++;
    } else {
      if (runLength >= 5) score += N1 + (runLength - 5);
      runColor = c;
      runLength = 1;
    }
  }
  if (runLength >= 5) score += N1 + (runLength - 5);

  const lightAt = (i: number): boolean => i < 0 || i >= size || read(i) === 0; // quiet zone is light
  for (let p = 0; p + 7 <= size; p++) {
    let core = true;
    for (let k = 0; k < 7 && core; k++) core = read(p + k) === FINDER_CORE[k];
    if (!core) continue;
    let before = true;
    let after = true;
    for (let k = 1; k <= 4; k++) {
      before &&= lightAt(p - k);
      after &&= lightAt(p + 6 + k);
    }
    if (before || after) score += N3;
  }
  return score;
}

/** Total ISO penalty N1 + N2 + N3 + N4 of a finished symbol (lower is better). */
export function qrPenalty(m: QrMatrix): number {
  const { size, modules } = m;
  const at = (x: number, y: number): number => modules[y * size + x] ?? 0;
  let score = 0;
  for (let a = 0; a < size; a++) {
    score += linePenalty((i) => at(i, a), size); // row a
    score += linePenalty((i) => at(a, i), size); // column a
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += N2;
    }
  }
  let dark = 0;
  for (const v of modules) dark += v;
  const total = size * size;
  const k = Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score + k * N4;
}

// ───────────────────────────── Public API ─────────────────────────────

function utf8(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_BYTES) {
    throw new RangeError(`QR payload is ${bytes.length} bytes; the maximum is ${MAX_BYTES}`);
  }
  return bytes;
}

function buildGrid(bytes: Uint8Array): Grid {
  let version = 1;
  while (qrByteCapacityL(version) < bytes.length || version === SKIPPED_VERSION) version++;
  const grid = new Grid(version * 4 + 17);
  drawFunctionPatterns(grid, version);
  placeCodewords(grid, interleaveWithEcc(encodeDataCodewords(bytes, version), version));
  return grid;
}

function finish(grid: Grid, mask: number): QrMatrix {
  applyMask(grid, mask);
  drawFormatBits(grid, mask);
  return { size: grid.size, modules: grid.modules };
}

/**
 * Encodes `text` (UTF-8, byte mode, ECC L) in the smallest version that fits (version 23 is
 * skipped, see SKIPPED_VERSION), choosing the lowest-penalty mask. Throws RangeError above
 * 2953 bytes.
 */
export function encodeQr(text: string): QrMatrix {
  const grid = buildGrid(utf8(text));
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, mask);
    const score = qrPenalty({ size: grid.size, modules: grid.modules });
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
    applyMask(grid, mask); // undo
  }
  return finish(grid, bestMask);
}

/** Test hook: like encodeQr but with a forced mask (0–7). Not for application code. */
export function encodeQrWithMask(text: string, mask: number): QrMatrix {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new RangeError(`QR mask out of range: ${mask}`);
  }
  return finish(buildGrid(utf8(text)), mask);
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3; // includes lone surrogates, which encode as U+FFFD
  return 4;
}

/**
 * Splits `text` into chunks whose payload is at most `maxBytes` UTF-8 bytes, never inside a
 * code point, each prefixed "TBX i/n\n" (i is 1-based). Reassemble by dropping each chunk's
 * first line and concatenating in order. Empty text yields one empty chunk.
 */
export function chunkText(text: string, maxBytes = 1100): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError(`maxBytes must be an integer ≥ 4, got ${maxBytes}`);
  }
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of text) {
    const n = utf8Length(ch.codePointAt(0) ?? 0);
    if (currentBytes + n > maxBytes) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += n;
  }
  if (current !== '' || parts.length === 0) parts.push(current);
  return parts.map((part, i) => `TBX ${i + 1}/${parts.length}\n${part}`);
}

/** Draws the symbol black-on-white with a light quiet zone; sets the canvas backing size. */
export function drawQr(canvas: HTMLCanvasElement, m: QrMatrix, scale = 6, quiet = 4): void {
  const px = (m.size + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.modules[y * m.size + x] === 1) {
        ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  }
}
