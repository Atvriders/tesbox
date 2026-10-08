import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  drawQr,
  encodeQr,
  encodeQrWithMask,
  qrByteCapacityL,
  qrPenalty,
  reedSolomonEcc,
  type QrMatrix,
} from '../../src/platform/qr';

/** Renders a matrix to RGBA pixels (black on white, light quiet zone) for jsQR. */
function toImage(m: QrMatrix, scale = 3, quiet = 4) {
  const width = (m.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.modules[y * m.size + x] !== 1) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const p = (((y + quiet) * scale + sy) * width + (x + quiet) * scale + sx) * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
        }
      }
    }
  }
  return { data, width };
}

function decode(m: QrMatrix) {
  const { data, width } = toImage(m);
  const result = jsQR(data, width, width, { inversionAttempts: 'dontInvert' });
  if (!result) throw new Error(`jsQR could not decode a ${m.size}×${m.size} symbol`);
  return result;
}

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** Deterministic ASCII filler of exactly n bytes. */
function ascii(n: number, seed = 0): string {
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(33 + ((i * 7 + seed * 13) % 94));
  return out;
}

const versionOf = (m: QrMatrix): number => (m.size - 17) / 4;

// Byte-mode capacities at level L, versions 1–40 (ISO/IEC 18004 Table 7).
const CAPACITY_L = [
  17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431,
  2563, 2699, 2809, 2953,
];

describe('qrByteCapacityL', () => {
  it('matches the ISO byte-mode capacity table for every version', () => {
    const computed = Array.from({ length: 40 }, (_, i) => qrByteCapacityL(i + 1));
    expect(computed).toEqual(CAPACITY_L);
  });

  it('rejects versions outside 1–40', () => {
    expect(() => qrByteCapacityL(0)).toThrow(RangeError);
    expect(() => qrByteCapacityL(41)).toThrow(RangeError);
    expect(() => qrByteCapacityL(1.5)).toThrow(RangeError);
  });
});

// Independent GF(256) arithmetic for the syndrome check (does not reuse the module's tables).
function gfMulRef(a: number, b: number): number {
  let product = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) product ^= a;
    b >>= 1;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return product;
}

describe('reedSolomonEcc', () => {
  it('reproduces the published 1-M "HELLO WORLD" example', () => {
    const data = Uint8Array.of(
      32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
    );
    expect(Array.from(reedSolomonEcc(data, 10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  it.each([7, 10, 18, 22, 26, 30])(
    'yields a codeword with zero syndromes at α^0..α^%i−1',
    (eccLen) => {
      const data = Uint8Array.from({ length: 50 }, (_, i) => (i * 37 + eccLen) & 0xff);
      const codeword = [...data, ...reedSolomonEcc(data, eccLen)];
      let alphaI = 1;
      for (let i = 0; i < eccLen; i++) {
        let acc = 0; // Horner evaluation, highest power first
        for (const c of codeword) acc = gfMulRef(acc, alphaI) ^ c;
        expect(acc).toBe(0);
        alphaI = gfMulRef(alphaI, 2);
      }
    },
  );
});

describe('encodeQr', () => {
  it('encodes a short string as version 1 and decodes back', () => {
    const m = encodeQr('TBX 1/1\n{"v":1}');
    expect(m.size).toBe(21);
    expect(m.modules.length).toBe(21 * 21);
    expect(m.modules.every((v) => v === 0 || v === 1)).toBe(true);
    expect(decode(m).data).toBe('TBX 1/1\n{"v":1}');
  });

  it('encodes UTF-8 text as bytes', () => {
    const text = 'Tesbox — 2.5 Turbo Inline-5 ✓ 🚗';
    const result = decode(encodeQr(text));
    expect(result.binaryData).toEqual(utf8(text));
    expect(result.data).toBe(text);
  });

  it('encodes the empty string', () => {
    const result = decode(encodeQr(''));
    expect(result.binaryData).toEqual([]);
  });

  it('picks the smallest version and switches exactly at capacity', () => {
    expect(versionOf(encodeQr(ascii(17)))).toBe(1);
    expect(versionOf(encodeQr(ascii(18)))).toBe(2);
    expect(versionOf(encodeQr(ascii(230)))).toBe(9);
    expect(versionOf(encodeQr(ascii(231)))).toBe(10);
  });

  it('round-trips a full-capacity payload at every version 1–40 through jsQR', () => {
    for (let version = 1; version <= 40; version++) {
      const text = ascii(qrByteCapacityL(version), version);
      const m = encodeQr(text);
      const expected = version === 23 ? 24 : version; // version 23 is never emitted
      expect(versionOf(m)).toBe(expected);
      const result = decode(m);
      expect(result.version).toBe(expected);
      expect(result.data).toBe(text);
    }
  }, 60_000);

  it('skips version 23: payloads in its range use version 24', () => {
    expect(versionOf(encodeQr(ascii(1003)))).toBe(22);
    expect(versionOf(encodeQr(ascii(1004)))).toBe(24);
    expect(versionOf(encodeQr(ascii(1091)))).toBe(24);
    expect(versionOf(encodeQr(ascii(1092)))).toBe(24);
  });

  // Alignment centres per ISO/IEC 18004 Annex E; each must hold a 5×5 dark/light/dark pattern.
  it.each([
    [2, [6, 18]],
    [7, [6, 22, 38]],
    [22, [6, 26, 50, 74, 98]],
    [24, [6, 28, 54, 80, 106]],
    [32, [6, 34, 60, 86, 112, 138]],
    [40, [6, 30, 58, 86, 114, 142, 170]],
  ])('places version %i alignment patterns at %j', (version, centres) => {
    const m = encodeQr(ascii(qrByteCapacityL(version)));
    expect(versionOf(m)).toBe(version);
    const at = (x: number, y: number) => m.modules[y * m.size + x];
    const last = centres.length - 1;
    centres.forEach((cy, i) => {
      centres.forEach((cx, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            expect(at(cx + dx, cy + dy)).toBe(ring === 1 ? 0 : 1);
          }
        }
      });
    });
  });

  it('accepts exactly 2953 bytes and throws RangeError above', () => {
    expect(versionOf(encodeQr(ascii(2953)))).toBe(40);
    expect(() => encodeQr(ascii(2954))).toThrow(RangeError);
    expect(() => encodeQr('é'.repeat(1477))).toThrow(RangeError); // 2954 UTF-8 bytes
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('decodes with forced mask %i (version 1 and 7)', (mask) => {
    for (const text of [ascii(15, mask), ascii(150, mask)]) {
      expect(decode(encodeQrWithMask(text, mask)).data).toBe(text);
    }
  });

  it('rejects an out-of-range forced mask', () => {
    expect(() => encodeQrWithMask('x', 8)).toThrow(RangeError);
    expect(() => encodeQrWithMask('x', -1)).toThrow(RangeError);
  });

  it('chooses a mask with the minimum penalty', () => {
    for (const text of ['hello', ascii(100), ascii(400, 3)]) {
      const chosen = qrPenalty(encodeQr(text));
      for (let mask = 0; mask < 8; mask++) {
        expect(chosen).toBeLessThanOrEqual(qrPenalty(encodeQrWithMask(text, mask)));
      }
    }
  });

  it('writes the published format bits for level L, mask 0', () => {
    const m = encodeQrWithMask('x', 0);
    // Copy 1 bits 14..9 sit in row 8, columns 0..5; bit 8 at (7,8); bit 7 at (8,8).
    const row8 = (x: number) => m.modules[8 * m.size + x];
    const col8 = (y: number) => m.modules[y * m.size + 8];
    const bits = [
      row8(0), row8(1), row8(2), row8(3), row8(4), row8(5), row8(7), col8(8),
      col8(7), col8(5), col8(4), col8(3), col8(2), col8(1), col8(0),
    ].join('');
    expect(bits).toBe('111011111000100');
  });

  it('writes the published version-7 information block', () => {
    const m = encodeQr(ascii(150));
    expect(m.size).toBe(45);
    // Bottom-left block: bit i at column ⌊i/3⌋, row size−11+(i mod 3); bit 0 = LSB.
    let value = 0;
    for (let i = 17; i >= 0; i--) {
      const row = m.size - 11 + (i % 3);
      value = (value << 1) | (m.modules[row * m.size + Math.floor(i / 3)] ?? 0);
    }
    expect(value).toBe(0b000111110010010100);
  });
});

describe('qrPenalty', () => {
  const matrix = (rows: string[]): QrMatrix => ({
    size: rows.length,
    modules: Uint8Array.from(rows.join('').split(''), Number),
  });

  it('scores an all-light 5×5 symbol: N1 30 + N2 48 + N4 90', () => {
    expect(qrPenalty(matrix(['00000', '00000', '00000', '00000', '00000']))).toBe(168);
  });

  it('scores a 5×5 checkerboard as 0', () => {
    expect(qrPenalty(matrix(['10101', '01010', '10101', '01010', '10101']))).toBe(0);
  });

  // 11×11 checkerboard: no runs ≥ 5, no 2×2 blocks, 61/121 dark → penalty 0. Replacing row 0
  // keeps every row run ≤ 4, every column run ≤ 2, no 2×2 block and N4 = 0, so any change
  // comes from N3 alone.
  const board = Array.from({ length: 11 }, (_, i) =>
    i % 2 === 0 ? '10101010101' : '01010101010',
  );
  const withRow0 = (row0: string): QrMatrix => matrix([row0, ...board.slice(1)]);

  it('scores the 11×11 checkerboard as 0', () => {
    expect(qrPenalty(matrix(board))).toBe(0);
  });

  // 13×13 variant: wide enough to put a DARK module on the far side of the pattern, so the
  // "preceded OR followed by four light modules" rule is distinguishable from "AND".
  const board13 = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? '1010101010101' : '0101010101010'));
  const withRow0of13 = (row0: string): QrMatrix => matrix([row0, ...board13.slice(1)]);

  it('adds N3 = 40 for 1:1:3:1:1 followed by four light modules (dark module before it)', () => {
    expect(qrPenalty(withRow0of13('1101110100001'))).toBe(40);
  });

  it('adds N3 = 40 for 1:1:3:1:1 preceded by four light modules (dark module after it)', () => {
    expect(qrPenalty(withRow0of13('1000010111011'))).toBe(40);
  });

  it('adds no N3 when neither side has four light modules', () => {
    expect(qrPenalty(withRow0('11011101111'))).toBe(0);
  });
});

describe('chunkText', () => {
  const body = (chunk: string): string => chunk.slice(chunk.indexOf('\n') + 1);

  it('returns one chunk with the TBX 1/1 header for short text', () => {
    expect(chunkText('{"v":1}')).toEqual(['TBX 1/1\n{"v":1}']);
  });

  it('returns one empty chunk for empty text', () => {
    expect(chunkText('')).toEqual(['TBX 1/1\n']);
  });

  it('splits by UTF-8 bytes without breaking code points', () => {
    const text = 'ab€😀c'.repeat(7); // 1+1+3+4+1 = 10 bytes per repeat
    const chunks = chunkText(text, 8);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.startsWith(`TBX ${i + 1}/${chunks.length}\n`)).toBe(true);
      expect(new TextEncoder().encode(body(chunk)).length).toBeLessThanOrEqual(8);
      expect(body(chunk)).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
    }
    expect(chunks.map(body).join('')).toBe(text);
  });

  it('fills every chunk but the last to within one code point of maxBytes', () => {
    const chunks = chunkText('ab€😀c'.repeat(7), 8);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(new TextEncoder().encode(body(chunk)).length).toBeGreaterThan(8 - 4);
    }
  });

  it('rejects a maxBytes that cannot hold every code point', () => {
    expect(() => chunkText('x', 3)).toThrow(RangeError);
    expect(() => chunkText('x', 10.5)).toThrow(RangeError);
  });

  it('RF4: text larger than one QR → several chunks that each encode, decode and reassemble', () => {
    const record = { k: 'mediasession', detail: 'nexttrack — wheel tilt ✓', t: 12.3 };
    const text = JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ ...record, i })));
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(2953);
    expect(() => encodeQr(text)).toThrow(RangeError);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    const decoded = chunks.map((chunk, i) => {
      const result = decode(encodeQr(chunk));
      expect(result.data).toBe(chunk);
      expect(result.data.startsWith(`TBX ${i + 1}/${chunks.length}\n`)).toBe(true);
      return result.data;
    });
    expect(decoded.map(body).join('')).toBe(text);
    expect(JSON.parse(decoded.map(body).join(''))).toHaveLength(120);
  });
});

describe('drawQr', () => {
  /** Fake canvas whose 2D context paints fillRect calls into an RGBA buffer. */
  function fakeCanvas() {
    let pixels = new Uint8ClampedArray(0);
    const canvas = { width: 0, height: 0 };
    const ctx = {
      fillStyle: '#000000',
      fillRect(x: number, y: number, w: number, h: number) {
        if (pixels.length !== canvas.width * canvas.height * 4) {
          pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
        }
        const v = ctx.fillStyle === '#ffffff' ? 255 : 0;
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            const p = (yy * canvas.width + xx) * 4;
            pixels[p] = v;
            pixels[p + 1] = v;
            pixels[p + 2] = v;
            pixels[p + 3] = 255;
          }
        }
      },
    };
    const el = Object.assign(canvas, { getContext: (id: string) => (id === '2d' ? ctx : null) });
    return { el: el as unknown as HTMLCanvasElement, canvas, pixels: () => pixels };
  }

  it('sizes the canvas with the default scale 6 and quiet zone 4', () => {
    const { el, canvas } = fakeCanvas();
    drawQr(el, encodeQr('hello'));
    expect(canvas.width).toBe((21 + 8) * 6);
    expect(canvas.height).toBe((21 + 8) * 6);
  });

  it('paints a symbol that jsQR decodes', () => {
    const { el, canvas, pixels } = fakeCanvas();
    drawQr(el, encodeQr('TBX 1/2\n{"v":1,"sha":"abc1234"}'), 4, 4);
    const result = jsQR(pixels(), canvas.width, canvas.height);
    expect(result?.data).toBe('TBX 1/2\n{"v":1,"sha":"abc1234"}');
  });

  it('throws when the 2D context is unavailable', () => {
    const el = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => drawQr(el, encodeQr('x'))).toThrow('2D canvas context unavailable');
  });
});
