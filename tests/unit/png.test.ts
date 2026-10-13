import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  PLOT_COLORS,
  SPECTROGRAM,
  colormap,
  crc32,
  encodePng,
  spectrogramLayout,
  spectrogramPng,
  textMask,
  type PlotRect,
} from '../../tools/png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  type: string;
  data: Uint8Array;
}

interface Decoded {
  width: number;
  height: number;
  chunks: Chunk[];
  filters: number[];
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Independent PNG decoder (RFC 2083) for 8-bit RGBA, non-interlaced images: checks the signature,
 * every chunk CRC with node:zlib's crc32, the IHDR fields, inflates the concatenated IDAT data with
 * node:zlib and undoes all five scanline filter types.
 */
function decodePng(png: Uint8Array): Decoded {
  expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let off = 8;
  while (off < png.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    expect(off + 12 + len, `${type} chunk fits`).toBeLessThanOrEqual(png.length);
    expect(view.getUint32(off + 8 + len), `${type} CRC`).toBe(zlibCrc32(png.subarray(off + 4, off + 8 + len)));
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  expect(off).toBe(png.length);
  const types = chunks.map((c) => c.type);
  expect(types[0]).toBe('IHDR');
  expect(types[types.length - 1]).toBe('IEND');
  expect(chunks[chunks.length - 1]?.data.length).toBe(0);
  const idat = chunks.filter((c) => c.type === 'IDAT');
  expect(idat.length).toBeGreaterThan(0);
  // IDAT chunks are consecutive (RFC 2083 §4.1.3).
  const firstIdat = types.indexOf('IDAT');
  expect(types.slice(firstIdat, firstIdat + idat.length).every((t) => t === 'IDAT')).toBe(true);

  const ihdr = chunks[0]?.data ?? new Uint8Array(0);
  expect(ihdr.length).toBe(13);
  const hv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]); // 8-bit, RGBA, deflate, adaptive filtering, no interlace

  const raw = inflateSync(Buffer.concat(idat.map((c) => c.data)));
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const rgba = new Uint8Array(height * stride);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? -1;
    filters.push(filter);
    for (let i = 0; i < stride; i++) {
      const f = raw[y * (stride + 1) + 1 + i] ?? 0;
      const a = i >= 4 ? (rgba[y * stride + i - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + i] ?? 0) : 0;
      const c = i >= 4 && y > 0 ? (rgba[(y - 1) * stride + i - 4] ?? 0) : 0;
      let v: number;
      if (filter === 0) v = f;
      else if (filter === 1) v = f + a;
      else if (filter === 2) v = f + b;
      else if (filter === 3) v = f + Math.floor((a + b) / 2);
      else if (filter === 4) v = f + paeth(a, b, c);
      else throw new Error(`invalid filter type ${filter} on row ${y}`);
      rgba[y * stride + i] = v & 0xff;
    }
  }
  return { width, height, chunks, filters, rgba };
}

/** Deterministic pseudo-random bytes (xorshift32), so failures reproduce. */
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

describe('crc32', () => {
  it('matches the CRC-32 check value and the empty input', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    // The constant CRC of every PNG's IEND chunk (type bytes only).
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });

  it('agrees with node:zlib crc32 on arbitrary data', () => {
    for (const n of [1, 3, 255, 4096]) {
      const bytes = noise(n, n * 7919);
      expect(crc32(bytes), `n=${n}`).toBe(zlibCrc32(bytes));
    }
  });
});

describe('encodePng', () => {
  it('writes signature, IHDR, IDAT, IEND with valid CRCs and round-trips a 2×2 image exactly', () => {
    // red, green / blue, half-transparent white
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
    const png = encodePng(2, 2, rgba);
    expect(png).toBeInstanceOf(Uint8Array);
    const d = decodePng(png);
    expect(d.width).toBe(2);
    expect(d.height).toBe(2);
    expect(d.chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([...d.rgba]).toEqual([...rgba]);
  });

  it('round-trips non-square noise images whose deflated data spans several IDAT chunks', () => {
    for (const [w, h] of [
      [1, 1],
      [7, 3],
      [3, 7],
      [181, 191],
    ] as const) {
      const rgba = noise(w * h * 4, w * 131 + h);
      const d = decodePng(encodePng(w, h, rgba));
      expect([d.width, d.height]).toEqual([w, h]);
      expect(d.filters.every((f) => f >= 0 && f <= 4)).toBe(true);
      expect(Buffer.from(d.rgba).equals(Buffer.from(rgba)), `${w}×${h}`).toBe(true);
    }
    // 181×191 RGBA noise is incompressible (~138 KB): the encoder splits it over several IDAT chunks.
    const big = decodePng(encodePng(181, 191, noise(181 * 191 * 4, 181 * 131 + 191)));
    expect(big.chunks.filter((c) => c.type === 'IDAT').length).toBeGreaterThan(1);
  });

  it('is deterministic', () => {
    const rgba = noise(16 * 9 * 4, 42);
    expect(Buffer.from(encodePng(16, 9, rgba)).equals(Buffer.from(encodePng(16, 9, rgba)))).toBe(true);
  });

  it('rejects invalid sizes and buffers', () => {
    expect(() => encodePng(0, 1, new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodePng(1, 0, new Uint8Array(0))).toThrow(RangeError);
    expect(() => encodePng(-1, 1, new Uint8Array(4))).toThrow(RangeError);
    expect(() => encodePng(1.5, 2, new Uint8Array(12))).toThrow(RangeError);
    expect(() => encodePng(Number.NaN, 1, new Uint8Array(4))).toThrow(RangeError);
    expect(() => encodePng(2 ** 31, 1, new Uint8Array(4))).toThrow(RangeError);
    expect(() => encodePng(2, 2, new Uint8Array(15))).toThrow(RangeError);
    expect(() => encodePng(2, 2, new Uint8Array(17))).toThrow(RangeError);
  });
});

/** CIE L* of an 8-bit sRGB colour (IEC 61966-2-1 decoding, Rec. 709 luminance weights). */
function lightness(rgb: readonly number[]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(rgb[0] ?? 0) + 0.7152 * lin(rgb[1] ?? 0) + 0.0722 * lin(rgb[2] ?? 0);
  return y > (6 / 29) ** 3 ? 116 * Math.cbrt(y) - 16 : (29 / 3) ** 3 * y;
}

describe('colormap (perceptual)', () => {
  const entries = Array.from({ length: 256 }, (_, i) => colormap(i / 255));
  const lstar = entries.map(lightness);

  it('runs from near black to a bright colour with lightness linear in t (±1 L*)', () => {
    const l0 = lstar[0] ?? Number.NaN;
    const l1 = lstar[255] ?? Number.NaN;
    expect(l0).toBeLessThan(6);
    expect(l1).toBeGreaterThan(90);
    for (let i = 0; i < 256; i++) expect(Math.abs((lstar[i] ?? 0) - (l0 + ((l1 - l0) * i) / 255)), `i=${i}`).toBeLessThan(1);
    for (let i = 4; i < 256; i += 4) expect(lstar[i] ?? 0, `i=${i}`).toBeGreaterThan(lstar[i - 4] ?? 0);
  });

  it('is chromatic in the middle (a hue sweep, not a grey ramp)', () => {
    for (const t of [0.25, 0.5, 0.75]) {
      const c = colormap(t);
      expect(Math.max(...c) - Math.min(...c), `t=${t}`).toBeGreaterThan(60);
    }
    // hue moves: the quarter and three-quarter colours differ in their dominant channel
    const q = colormap(0.25);
    const tq = colormap(0.75);
    expect(q.indexOf(Math.max(...q))).not.toBe(tq.indexOf(Math.max(...tq)));
  });

  it('clamps t to [0, 1] and maps NaN to the floor colour', () => {
    expect(colormap(-1)).toEqual(colormap(0));
    expect(colormap(2)).toEqual(colormap(1));
    expect(colormap(Number.NaN)).toEqual(colormap(0));
    for (const c of entries) for (const v of c) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
  });
});

describe('textMask (5×7 bitmap font)', () => {
  const rows = (m: { width: number; height: number; mask: Uint8Array }): string[] =>
    Array.from({ length: m.height }, (_, y) =>
      Array.from(m.mask.subarray(y * m.width, (y + 1) * m.width), (v) => (v ? '#' : '.')).join(''),
    );

  it('draws a glyph as 5×7 dots', () => {
    const one = textMask('1');
    expect([one.width, one.height]).toEqual([5, 7]);
    expect(rows(one)).toEqual(['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.']);
  });

  it('advances 6 columns per character and scales every dot to a scale×scale block', () => {
    const ab = textMask('AB', 2);
    expect([ab.width, ab.height]).toEqual([22, 14]);
    const r = rows(ab);
    for (const row of r) expect(row.slice(10, 12)).toBe('..'); // the inter-character column
    const a1 = textMask('A');
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 10; x++) {
        expect(ab.mask[y * 22 + x], `(${x},${y})`).toBe(a1.mask[Math.floor(y / 2) * 5 + Math.floor(x / 2)]);
      }
    }
    expect(textMask('')).toEqual({ width: 0, height: 7, mask: new Uint8Array(0) });
  });

  it('folds lower case to upper case and draws unknown characters as "?"', () => {
    expect(textMask('rs3-onboard-a')).toEqual(textMask('RS3-ONBOARD-A'));
    expect(textMask('é')).toEqual(textMask('?'));
    expect(textMask('\u{1F600}')).toEqual(textMask('?')); // one cell per code point
  });

  it('covers printable ASCII with distinct glyphs', () => {
    const seen = new Map<string, string>();
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code);
      if (ch >= 'a' && ch <= 'z') continue;
      const key = textMask(ch).mask.join('');
      if (ch !== '?') expect(key, `"${ch}" has its own glyph`).not.toBe(textMask('?').mask.join(''));
      expect(seen.get(key), `"${ch}" duplicates "${seen.get(key)}"`).toBeUndefined();
      seen.set(key, ch);
    }
    expect(seen.size).toBe(69);
  });

  it('rejects non-integer or non-positive scales', () => {
    expect(() => textMask('A', 0)).toThrow(RangeError);
    expect(() => textMask('A', 1.5)).toThrow(RangeError);
  });
});

// ───────────────────────────── plot helpers ─────────────────────────────

function pixel(d: Decoded, x: number, y: number): [number, number, number] {
  const o = (y * d.width + x) * 4;
  return [d.rgba[o] ?? -1, d.rgba[o + 1] ?? -1, d.rgba[o + 2] ?? -1];
}

const same = (a: readonly number[], b: readonly number[]): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Colormap index of an RGB colour (lowest index on ties), −1 if the colour is not in the colormap. */
const CMAP_INDEX = new Map<string, number>();
for (let i = 255; i >= 0; i--) CMAP_INDEX.set(colormap(i / 255).join(','), i);
const cmapIndex = (rgb: readonly number[]): number => CMAP_INDEX.get(rgb.join(',')) ?? -1;

/** Count of pixels of colour `c` inside a rectangle (clipped to the image). */
function countColor(d: Decoded, c: readonly number[], x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(d.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(d.width, x1); x++) if (same(pixel(d, x, y), c)) n++;
  }
  return n;
}

function sine(fs: number, seconds: number, tones: { hz: number; amp: number }[]): Float32Array {
  const out = new Float32Array(Math.round(fs * seconds));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (const t of tones) v += t.amp * Math.sin((2 * Math.PI * t.hz * i) / fs);
    out[i] = v;
  }
  return out;
}

/** Documented row mapping: the row whose log-frequency band [lo, hi) contains f (0 = top). */
function rowOf(f: number, plot: PlotRect, maxHz: number = SPECTROGRAM.maxHz): number {
  const e = plot.h * (1 - Math.log(f / SPECTROGRAM.minHz) / Math.log(maxHz / SPECTROGRAM.minHz));
  return Math.min(plot.h - 1, Math.max(0, Math.floor(e)));
}

/** Colormap index of each plot row (0 = top) in plot column `col`. */
function columnIndices(d: Decoded, plot: PlotRect, col: number): number[] {
  return Array.from({ length: plot.h }, (_, r) => cmapIndex(pixel(d, plot.x + col, plot.y + r)));
}

describe('spectrogramPng', () => {
  const FS = 48000;
  const W = 320;
  const H = 160;
  const { plot } = spectrogramLayout(W, H);

  it('defaults to a 960×540 figure, 20 Hz–12 kHz, 80 dB range, all pixels opaque', () => {
    expect(SPECTROGRAM).toMatchObject({ width: 960, height: 540, minHz: 20, maxHz: 12000, rangeDb: 80 });
    const d = decodePng(spectrogramPng(sine(FS, 0.25, [{ hz: 440, amp: 0.5 }]), FS));
    expect([d.width, d.height]).toEqual([960, 540]);
    for (let i = 3; i < d.rgba.length; i += 4) if (d.rgba[i] !== 255) throw new Error(`alpha ${d.rgba[i]} at byte ${i}`);
  });

  it('draws a tone at full colour on its log-frequency row, distant rows at the floor colour', () => {
    const d = decodePng(spectrogramPng(sine(FS, 1, [{ hz: 1000, amp: 0.5 }]), FS, { width: W, height: H }));
    expect([d.width, d.height]).toEqual([W, H]);
    const mid = columnIndices(d, plot, Math.floor(plot.w / 2));
    expect(mid.every((i) => i >= 0)).toBe(true); // every plot pixel is a colormap colour
    const r1k = rowOf(1000, plot);
    expect(Math.max(...mid.slice(r1k - 1, r1k + 2))).toBeGreaterThanOrEqual(250);
    expect(mid[rowOf(100, plot)]).toBe(0);
    expect(mid[rowOf(5000, plot)]).toBe(0);
  });

  it('spaces tones by the logarithm of frequency (one decade = the same number of rows)', () => {
    const tones = [100, 1000, 10000];
    const d = decodePng(
      spectrogramPng(sine(FS, 1, tones.map((hz) => ({ hz, amp: 0.3 }))), FS, { width: W, height: H }),
    );
    const mid = columnIndices(d, plot, Math.floor(plot.w / 2));
    const rows = tones.map((f) => rowOf(f, plot));
    for (const r of rows) expect(Math.max(...mid.slice(r - 1, r + 2)), `row ${r}`).toBeGreaterThanOrEqual(240);
    // dark between the tones
    for (const f of [Math.sqrt(100 * 1000), Math.sqrt(1000 * 10000)]) expect(mid[rowOf(f, plot)], `${f} Hz`).toBeLessThan(100);
    const [r100 = 0, r1k = 0, r10k = 0] = rows;
    expect(Math.abs(r100 - r1k - (r1k - r10k))).toBeLessThanOrEqual(1);
  });

  it('maps time to columns: a tone that stops halfway leaves the right half at the floor colour', () => {
    const x = new Float32Array(2 * FS);
    x.set(sine(FS, 1, [{ hz: 1000, amp: 0.5 }]));
    const d = decodePng(spectrogramPng(x, FS, { width: W, height: H }));
    const r1k = rowOf(1000, plot);
    expect(Math.max(...columnIndices(d, plot, Math.floor(plot.w * 0.25)).slice(r1k - 1, r1k + 2))).toBeGreaterThanOrEqual(250);
    expect(columnIndices(d, plot, Math.floor(plot.w * 0.75)).every((i) => i === 0)).toBe(true);
  });

  it('renders silence and empty input at the floor colour', () => {
    for (const x of [new Float32Array(FS / 2), new Float32Array(0)]) {
      const d = decodePng(spectrogramPng(x, FS, { width: W, height: H }));
      expect(countColor(d, colormap(0), plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBe(plot.w * plot.h);
    }
  });

  it('puts maxHz at the top of the frequency axis', () => {
    const d = decodePng(spectrogramPng(sine(FS, 1, [{ hz: 1000, amp: 0.5 }]), FS, { width: W, height: H, maxHz: 2000 }));
    const mid = columnIndices(d, plot, Math.floor(plot.w / 2));
    const r = rowOf(1000, plot, 2000);
    expect(r).toBeLessThan(rowOf(1000, plot));
    expect(Math.max(...mid.slice(r - 1, r + 2))).toBeGreaterThanOrEqual(250);
    expect(mid[rowOf(1000, plot)]).toBe(0);
  });

  it('marks rows above Nyquist as no data and excludes them from the scale', () => {
    const fs = 8000;
    const d = decodePng(spectrogramPng(sine(fs, 1, [{ hz: 1000, amp: 0.5 }]), fs, { width: W, height: H }));
    const r6k = rowOf(6000, plot);
    expect(countColor(d, PLOT_COLORS.noData, plot.x, plot.y + r6k, plot.x + plot.w, plot.y + r6k + 1)).toBe(plot.w);
    const mid = columnIndices(d, plot, Math.floor(plot.w / 2));
    const r1k = rowOf(1000, plot);
    expect(Math.max(...mid.slice(r1k - 1, r1k + 2))).toBeGreaterThanOrEqual(250);
  });

  it('draws the colour bar from 0 dB (top) to −80 dB (bottom) and labels the axes', () => {
    const { colorbar } = spectrogramLayout(W, H);
    const d = decodePng(spectrogramPng(sine(FS, 1, [{ hz: 1000, amp: 0.5 }]), FS, { width: W, height: H }));
    for (let x = colorbar.x; x < colorbar.x + colorbar.w; x++) {
      expect(pixel(d, x, colorbar.y)).toEqual(colormap(1));
      expect(pixel(d, x, colorbar.y + colorbar.h - 1)).toEqual(colormap(0));
    }
    expect(colorbar.x).toBeGreaterThan(plot.x + plot.w);
    expect(colorbar.x + colorbar.w).toBeLessThan(W);
    expect(pixel(d, 0, 0)).toEqual([...PLOT_COLORS.background]);
    // frequency labels (left), time labels (below), dB labels (right of the colour bar)
    expect(countColor(d, PLOT_COLORS.text, 0, plot.y, plot.x - 1, plot.y + plot.h)).toBeGreaterThan(20);
    expect(countColor(d, PLOT_COLORS.text, plot.x, plot.y + plot.h + 1, plot.x + plot.w, H)).toBeGreaterThan(20);
    expect(countColor(d, PLOT_COLORS.text, colorbar.x + colorbar.w, plot.y, W, plot.y + plot.h)).toBeGreaterThan(20);
  });

  it('scales its text with the figure size', () => {
    expect(spectrogramLayout(W, H).scale).toBe(1);
    expect(spectrogramLayout(960, 540).scale).toBe(2);
    const big = spectrogramLayout(960, 540).plot;
    expect(big.x + big.w).toBeLessThan(960);
    expect(big.y + big.h).toBeLessThan(540);
  });

  it('is deterministic', () => {
    const x = sine(FS, 0.5, [{ hz: 300, amp: 0.4 }]);
    const a = spectrogramPng(x, FS, { width: W, height: H });
    expect(Buffer.from(a).equals(Buffer.from(spectrogramPng(x, FS, { width: W, height: H })))).toBe(true);
  });

  it('rejects non-finite samples and invalid parameters', () => {
    const x = sine(FS, 0.1, [{ hz: 440, amp: 0.5 }]);
    const bad = Float64Array.from(x);
    bad[100] = Number.NaN;
    expect(() => spectrogramPng(bad, FS, { width: W, height: H })).toThrow(RangeError);
    bad[100] = Number.POSITIVE_INFINITY;
    expect(() => spectrogramPng(bad, FS, { width: W, height: H })).toThrow(RangeError);
    for (const fs of [0, -48000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => spectrogramPng(x, fs, { width: W, height: H }), `fs=${fs}`).toThrow(RangeError);
    }
    for (const maxHz of [20, 10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => spectrogramPng(x, FS, { width: W, height: H, maxHz }), `maxHz=${maxHz}`).toThrow(RangeError);
    }
    for (const [width, height] of [
      [127, 160],
      [320, 63],
      [320.5, 160],
    ]) {
      expect(() => spectrogramPng(x, FS, { width, height }), `${width}×${height}`).toThrow(RangeError);
    }
  });
});
