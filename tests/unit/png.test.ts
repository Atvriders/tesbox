import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RPM_BIN } from '../../src/lab/compare';
import {
  ORDER_PLOT,
  PLOT_COLORS,
  SERIES_COLORS,
  SPECTROGRAM,
  colormap,
  crc32,
  encodePng,
  markerMask,
  orderPlotBin,
  orderPlotLayout,
  orderPlotPng,
  orderProfile,
  spectrogramLayout,
  spectrogramPng,
  spectrogramTimeLabels,
  textMask,
  type OrderSeries,
  type PlotRect,
  type Rgb,
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

/** Map of a w×h box at (x0, y0): "#" where the pixel has colour `ink`, else "." (also off the image); a line per row. */
function inkMap(d: Decoded, ink: readonly number[], x0: number, y0: number, w: number, h: number): string {
  const lines: string[] = [];
  for (let y = y0; y < y0 + h; y++) {
    let line = '';
    for (let x = x0; x < x0 + w; x++) {
      line += x >= 0 && y >= 0 && x < d.width && y < d.height && same(pixel(d, x, y), ink) ? '#' : '.';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** inkMap of `text` rendered by textMask at `scale`, framed by `margin` blank px. */
function textInkMap(text: string, scale: number, margin: number): string {
  const m = textMask(text, scale);
  const lines: string[] = [];
  for (let y = -margin; y < m.height + margin; y++) {
    let line = '';
    for (let x = -margin; x < m.width + margin; x++) {
      const inside = x >= 0 && y >= 0 && x < m.width && y < m.height;
      line += inside && m.mask[y * m.width + x] === 1 ? '#' : '.';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Expects exactly `text` (textMask at `scale`) in colour `ink` with its top-left corner at (x, y), and no other pixel of that
 * colour within `margin` px around it.
 */
function expectText(d: Decoded, text: string, x: number, y: number, scale: number, ink: readonly number[], margin = scale): void {
  const m = textMask(text, scale);
  const got = inkMap(d, ink, x - margin, y - margin, m.width + 2 * margin, m.height + 2 * margin);
  expect(got, `"${text}" at (${x}, ${y})`).toBe(textInkMap(text, scale, margin));
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

/** Documented colour of a cell `db` dB re the loudest cell: colormap index round(255 · (1 + db/80)), the floor below −80 dB. */
function indexOfDb(db: number): number {
  return Math.min(255, Math.max(0, Math.round(255 * (1 + db / SPECTROGRAM.rangeDb))));
}

/** Documented analysis window length: the power of two nearest windowS seconds. */
function windowSize(fs: number): number {
  return 2 ** Math.round(Math.log2(SPECTROGRAM.windowS * fs));
}

describe('spectrogramPng', () => {
  const FS = 48000;
  const W = 320;
  const H = 160;
  const { plot } = spectrogramLayout(W, H);
  /** FFT bin spacing at FS: a tone at a multiple of DF sits on a bin centre (no scalloping loss). */
  const DF = FS / windowSize(FS);

  it('defaults to a 960×540 figure, 20 Hz–12 kHz, 80 dB range, all pixels opaque', () => {
    expect(SPECTROGRAM).toMatchObject({ width: 960, height: 540, minHz: 20, maxHz: 12000, rangeDb: 80 });
    expect(windowSize(FS)).toBe(8192);
    const d = decodePng(spectrogramPng(sine(FS, 0.25, [{ hz: 440, amp: 0.5 }]), FS));
    expect([d.width, d.height]).toEqual([960, 540]);
    for (let i = 3; i < d.rgba.length; i += 4) if (d.rgba[i] !== 255) throw new Error(`alpha ${d.rgba[i]} at byte ${i}`);
  });

  it('maps level to colour linearly over the 80 dB range its colour bar is labelled with', () => {
    // Bin-centred tones 0, −40, −70 and −90 dB re the loudest: each row's peak is exact.
    const tones = [
      { bin: 171, db: 0 }, // 1002 Hz
      { bin: 683, db: -40 }, // 4002 Hz
      { bin: 85, db: -70 }, // 498 Hz
      { bin: 1707, db: -90 }, // 10002 Hz: below the range, the floor colour
    ];
    const x = sine(FS, 1, tones.map((t) => ({ hz: t.bin * DF, amp: 0.5 * 10 ** (t.db / 20) })));
    const d = decodePng(spectrogramPng(x, FS, { width: W, height: H }));
    const mid = columnIndices(d, plot, Math.floor(plot.w / 2));
    for (const t of tones) {
      const r = rowOf(t.bin * DF, plot);
      expect(Math.max(...mid.slice(r - 1, r + 2)), `${t.db} dB`).toBeGreaterThanOrEqual(indexOfDb(t.db) - 2);
      expect(Math.max(...mid.slice(r - 1, r + 2)), `${t.db} dB`).toBeLessThanOrEqual(indexOfDb(t.db) + 2);
    }
    expect([0, -40, -70, -90].map(indexOfDb)).toEqual([255, 128, 32, 0]);
    // The colour bar shows those colours at its 0, −40 and −80 dB ticks.
    const { colorbar } = spectrogramLayout(W, H);
    for (const level of [0, -40, -80]) {
      const y = colorbar.y + Math.round((-level / SPECTROGRAM.rangeDb) * (colorbar.h - 1));
      expect(Math.abs(cmapIndex(pixel(d, colorbar.x, y)) - indexOfDb(level)), `${level} dB on the bar`).toBeLessThanOrEqual(2);
    }
  });

  it('labels frequencies, times and levels with the documented text at the documented places', () => {
    const L = spectrogramLayout(SPECTROGRAM.width, SPECTROGRAM.height);
    const { scale: s, plot: P, colorbar } = L;
    const d = decodePng(spectrogramPng(sine(FS, 4, [{ hz: 1000, amp: 0.5 }]), FS));
    const half = Math.floor(textMask('0', s).height / 2);
    // Frequency axis: a 3-unit tick left of the plot on the row holding f; the label right-aligned, centred on the tick.
    for (const [f, text] of [
      [20, '20'],
      [100, '100'],
      [1000, '1K'],
      [10000, '10K'],
    ] as const) {
      const y = P.y + rowOf(f, P);
      expect(countColor(d, PLOT_COLORS.frame, P.x - 1 - 3 * s, y, P.x - 1, y + 1), `${text} tick`).toBe(3 * s);
      expectText(d, text, L.freqLabelRight - textMask(text, s).width, y - half, s, PLOT_COLORS.text);
    }
    // Time axis of 4 s on 852 columns: ticks every 0.5 s at plot.x + round(t/4 · plot.w), 3 units below the frame.
    const tickRow = P.y + P.h + 1;
    const tickXs = Array.from({ length: 9 }, (_, k) => P.x + Math.round((k / 8) * P.w));
    for (let y = tickRow; y < tickRow + 3 * s; y++) expect(xsOfColor(d, PLOT_COLORS.frame, 0, y, d.width, y + 1)).toEqual(tickXs);
    // The first label starts at its tick, the others are centred on theirs.
    expectText(d, '0.0S', P.x, L.timeLabelTop, s, PLOT_COLORS.text);
    for (const [k, text] of [
      [2, '1.0S'],
      [5, '2.5S'],
      [8, '4.0S'],
    ] as const) {
      const tx = tickXs[k] ?? 0;
      expectText(d, text, tx - Math.floor(textMask(text, s).width / 2), L.timeLabelTop, s, PLOT_COLORS.text);
    }
    // Colour bar: dB re the loudest cell, 0 at the top to −80 at the bottom.
    for (const level of [0, -20, -40, -60, -80]) {
      const y = colorbar.y + Math.round((-level / SPECTROGRAM.rangeDb) * (colorbar.h - 1));
      expectText(d, `${level}`, L.dbLabelX, y - half, s, PLOT_COLORS.text);
    }
  });

  it("centres column c's window on sample round((c + 0.5)/cols · n): a tone burst fades in and out over one window", () => {
    const n = 4 * FS;
    const [on, off] = [1.5 * FS, 2.5 * FS];
    const hz = 171 * DF;
    const x = new Float64Array(n);
    for (let i = on; i < off; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / FS);
    const d = decodePng(spectrogramPng(x, FS, { width: W, height: H }));
    const r = rowOf(hz, plot);
    // The tone row of column c is the share of the Hann window's sum that overlaps the burst, in dB.
    const size = windowSize(FS);
    const win = Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
    const total = win.reduce((a, v) => a + v, 0);
    const got: number[] = [];
    const want: number[] = [];
    for (let c = 0; c < plot.w; c++) {
      const start = Math.min(n - size, Math.max(0, Math.round(((c + 0.5) / plot.w) * n) - size / 2));
      let part = 0;
      for (let i = Math.max(0, on - start); i < Math.min(size, off - start); i++) part += win[i] ?? 0;
      want.push(part > 0 ? indexOfDb(20 * Math.log10(part / total)) : 0);
      got.push(cmapIndex(pixel(d, plot.x + c, plot.y + r)));
    }
    // each fade spans most of a window (8192 samples ≈ 11 columns of 722 samples), centred on the onset/offset column
    expect(want.filter((i) => i > 0 && i < 255).length).toBeGreaterThanOrEqual(16);
    const worst = Math.max(...got.map((g, c) => Math.abs(g - (want[c] ?? 0))));
    expect(worst, `got ${got.join(',')}\nwant ${want.join(',')}`).toBeLessThanOrEqual(3);
  });

  it('keeps every window inside the signal: a steady tone stays clean up to the edges, where columns repeat the edge window', () => {
    const n = FS / 2;
    const d = decodePng(spectrogramPng(sine(FS, 0.5, [{ hz: 440, amp: 0.5 }]), FS, { width: W, height: H }));
    const r = rowOf(440, plot);
    // No zero-padding splatter: in every column the tone is at full colour and rows outside 250–800 Hz are at the floor.
    const off: string[] = [];
    for (let c = 0; c < plot.w; c++) {
      const col = columnIndices(d, plot, c);
      const tone = Math.max(...col.slice(r - 1, r + 2));
      if (tone < 250) off.push(`column ${c}: tone at ${tone}`);
      col.forEach((i, row) => {
        if ((row > rowOf(250, plot) || row < rowOf(800, plot)) && i !== 0) off.push(`column ${c}, row ${row}: ${i}`);
      });
    }
    expect(off.slice(0, 8), `${off.length} cells`).toEqual([]);
    // A window that would start before sample 0 starts at 0 and one that would end after sample n ends there: such
    // columns repeat the first or last column.
    const half = windowSize(FS) / 2;
    let edge = 0;
    for (let c = 0; c < plot.w; c++) {
      const centre = Math.round(((c + 0.5) / plot.w) * n);
      if (centre - half <= 0) expect(columnIndices(d, plot, c), `column ${c}`).toEqual(columnIndices(d, plot, 0));
      else if (centre + half >= n) expect(columnIndices(d, plot, c), `column ${c}`).toEqual(columnIndices(d, plot, plot.w - 1));
      else continue;
      edge++;
    }
    expect(edge).toBe(90); // 45 columns at each end: the 8192-sample window is a third of the 24000-sample signal
  });

  it('steps short clips’ time labels so they clear each other (the first label starts at its tick)', () => {
    // 0.5 s at 960×540 drew "0.00S" and "0.05S" run together; 0.01 s at 640×360 drew "0.000S0.002S".
    for (const [dur, w, h, step, texts] of [
      [0.5, 960, 540, 0.1, ['0.0S', '0.1S', '0.2S', '0.3S', '0.4S', '0.5S']],
      [0.01, 640, 360, 0.005, ['0.000S', '0.005S', '0.010S']],
    ] as const) {
      const L = spectrogramLayout(w, h);
      const { scale: s, plot: P } = L;
      const d = decodePng(spectrogramPng(sine(FS, dur, [{ hz: 1000, amp: 0.5 }]), FS, { width: w, height: h }));
      const glyphH = textMask('0', s).height;
      const band = new Array<string>(w * glyphH).fill('.');
      const ticks: number[] = [];
      texts.forEach((text, k) => {
        const tickX = P.x + Math.round(((k * step) / dur) * P.w);
        const m = textMask(text, s);
        const x0 = k === 0 ? tickX : Math.min(w - m.width, tickX - Math.floor(m.width / 2));
        for (let y = 0; y < m.height; y++) {
          for (let x = 0; x < m.width; x++) if (m.mask[y * m.width + x] === 1) band[y * w + x0 + x] = '#';
        }
        ticks.push(tickX);
      });
      const want = Array.from({ length: glyphH }, (_, y) => band.slice(y * w, (y + 1) * w).join('')).join('\n');
      expect(inkMap(d, PLOT_COLORS.text, 0, L.timeLabelTop, w, glyphH), `${dur} s at ${w}×${h}`).toBe(want);
      const tickRow = P.y + P.h + 1;
      expect(xsOfColor(d, PLOT_COLORS.frame, 0, tickRow, w, tickRow + 1), `${dur} s ticks`).toEqual(ticks);
    }
  });

  it('spectrogramTimeLabels: 1-2-5 steps up to the duration, labels inside the figure and a character cell apart', () => {
    for (const [w, h] of [
      [128, 64],
      [320, 160],
      [640, 360],
      [960, 540],
      [1920, 1080],
    ] as const) {
      const { scale: s, plot: P } = spectrogramLayout(w, h);
      for (const dur of [0, 0.001, 0.01, 0.0137, 0.05, 0.25, 0.5, 0.73, 1, 4, 12, 59.9, 100, 999, 12345]) {
        const at = `${dur} s at ${w}×${h}`;
        const labels = spectrogramTimeLabels(dur, w, h);
        const step = labels.length > 1 ? (labels[1]?.t ?? 0) : null;
        if (step !== null) {
          const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
          expect([1, 2, 5].some((m) => Math.abs(mantissa - m) < 1e-9), `${at}: step ${step}`).toBe(true);
          expect(labels.length, at).toBe(Math.floor(dur / step + 1e-9) + 1); // every tick up to the duration
        } else {
          expect(labels, at).toHaveLength(1);
        }
        const decimals = step === null ? 0 : Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        labels.forEach((l, k) => {
          const tw = textMask(l.text, s).width;
          expect(l.t, `${at} #${k}`).toBeCloseTo(k * (step ?? 0), 9);
          expect(l.tickX, `${at} #${k}`).toBe(P.x + (dur > 0 ? Math.round((l.t / dur) * P.w) : 0));
          if (step !== null) expect(l.text, `${at} #${k}`).toBe(`${l.t.toFixed(decimals)}S`);
          expect(l.x, `${at} #${k}`).toBe(k === 0 ? l.tickX : Math.min(w - tw, l.tickX - Math.floor(tw / 2)));
          expect(l.x, `${at} #${k}`).toBeGreaterThanOrEqual(0);
          expect(l.x + tw, `${at} #${k}`).toBeLessThanOrEqual(w);
          const prev = labels[k - 1];
          if (prev) expect(l.x - (prev.x + textMask(prev.text, s).width), `${at} gap before #${k}`).toBeGreaterThanOrEqual(6 * s);
        });
      }
    }
    expect(spectrogramTimeLabels(0, 320, 160)).toEqual([{ t: 0, tickX: plot.x, text: '0S', x: plot.x }]);
    // the 4 s default figure keeps its 0.5 s step
    expect(spectrogramTimeLabels(4, 960, 540).map((l) => l.text)).toEqual(
      ['0.0S', '0.5S', '1.0S', '1.5S', '2.0S', '2.5S', '3.0S', '3.5S', '4.0S'],
    );
    for (const dur of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => spectrogramTimeLabels(dur, 320, 160), `${dur} s`).toThrow(RangeError);
    }
  });

  it('removes the mean first: a large DC offset leaves the 20–30 Hz rows at the floor colour', () => {
    // DC 40 dB above the tone's spectral peak; its window leakage would light the lowest rows.
    const x = new Float64Array(FS);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 + 0.01 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const d = decodePng(spectrogramPng(x, FS, { width: W, height: H }));
    const r1k = rowOf(1000, plot);
    const lit: string[] = [];
    for (let c = 0; c < plot.w; c++) {
      const col = columnIndices(d, plot, c);
      if (Math.max(...col.slice(r1k - 1, r1k + 2)) < 250) lit.push(`column ${c}: tone below full colour`);
      for (let r = rowOf(30, plot); r <= rowOf(20, plot); r++) if (col[r] !== 0) lit.push(`column ${c}, row ${r}: ${col[r]}`);
    }
    expect(lit.slice(0, 8), `${lit.length} cells`).toEqual([]);
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

// ───────────────────────────── order plot ─────────────────────────────

/** Half-order grid of a 4-stroke engine: orderAmp entry i is order (i + 1)·0.5, i < floor(12 / 0.5). */
const STEP = 0.5;
const N_ORDERS = 24;

/** Series colour of slot i (an impossible colour if the slot is missing, so comparisons fail loudly). */
const color = (i: number): Rgb => SERIES_COLORS[i] ?? [-1, -1, -1];

/** Amplitude row on the `step` grid: `base` at every order except the listed { order: amplitude } peaks. */
function ampRow(base: number, peaks: Record<number, number> = {}, step = STEP): number[] {
  const row = Array.from({ length: Math.floor(12 / step + 1e-9) }, () => base);
  for (const [order, amp] of Object.entries(peaks)) row[Math.round(Number(order) / step) - 1] = amp;
  return row;
}

/** A series of `frames` identical frames at `rpm` (no role unless given). */
function flatSeries(label: string, amp: number[], frames = 3, rpm = 3000, role?: OrderSeries['role']): OrderSeries {
  return {
    label,
    rpm: Array.from({ length: frames }, () => rpm),
    orderAmp: Array.from({ length: frames }, () => [...amp]),
    ...(role === undefined ? {} : { role }),
  };
}

/** A series with one frame per rpm value, every frame the amplitude row `amp`. */
function framesAt(label: string, role: OrderSeries['role'], rpms: number[], amp: number[] = ampRow(1)): OrderSeries {
  return { label, ...(role === undefined ? {} : { role }), rpm: rpms, orderAmp: rpms.map(() => [...amp]) };
}

/** `n` copies of `rpm`. */
const times = (rpm: number, n: number): number[] => Array.from({ length: n }, () => rpm);

/** Documented mapping of the data area: order 0 … 12 → columns, 0 … −60 dB → rows (clamped to the axis). */
function xOfOrder(order: number, data: PlotRect): number {
  return data.x + Math.round((order / ORDER_PLOT.maxOrder) * (data.w - 1));
}
function yOfDb(db: number, data: PlotRect): number {
  return data.y + Math.round(Math.min(1, Math.max(0, -db / ORDER_PLOT.rangeDb)) * (data.h - 1));
}

/** WCAG 2 contrast ratio of two 8-bit sRGB colours. */
function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const lum = (c: readonly number[]): number => {
    const lin = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(c[0] ?? 0) + 0.7152 * lin(c[1] ?? 0) + 0.0722 * lin(c[2] ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** x of every pixel of colour `c` inside a rectangle. */
function xsOfColor(d: Decoded, c: readonly number[], x0: number, y0: number, x1: number, y1: number): number[] {
  const xs: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (same(pixel(d, x, y), c)) xs.push(x);
  return xs;
}

describe('orderProfile', () => {
  it('averages the amplitudes of the frames in the given 500 rpm bin (3000: [2750, 3250)) re the strongest order', () => {
    // no fixed bin any more (amendment D7): the caller names it; bins are the scoring's (src/lab/compare.ts)
    expect(ORDER_PLOT).toMatchObject({ binRpm: 500, maxOrder: 12, rangeDb: 60, maxSeries: 8 });
    expect(ORDER_PLOT).not.toHaveProperty('rpm');
    expect(ORDER_PLOT.binRpm).toBe(RPM_BIN);
    // In the bin: order 2 averages (2 + 0 + 1) / 3 = 1 (arithmetic mean of amplitudes, as the orderProfile
    // metric uses; RMS would give 1.29), order 1 is 0.1, order 0.5 is 0.01, order 12 is 0, the rest 0.001.
    const row = (a2: number): number[] => ampRow(0.001, { 0.5: 0.01, 1: 0.1, 2: a2, 12: 0 });
    const loud = ampRow(100); // a frame outside the bin would dominate every order
    const s: OrderSeries = {
      label: 'ref',
      rpm: [2000, 2750, 3000, 2749.9, 3249.9, 3250, 4000],
      orderAmp: [loud, row(2), row(0), loud, row(1), loud, loud],
    };
    const p = orderProfile(s, STEP, 3000);
    expect(p.frames).toBe(3);
    expect(p.orders).toEqual(Array.from({ length: N_ORDERS }, (_, i) => (i + 1) * STEP));
    expect(p.levelDb).toHaveLength(N_ORDERS);
    expect(p.levelDb[3]).toBe(0); // order 2
    expect(p.levelDb[1]).toBeCloseTo(-20, 9); // order 1
    expect(p.levelDb[0]).toBeCloseTo(-40, 9); // order 0.5
    expect(p.levelDb[5]).toBeCloseTo(-60, 9); // order 3
    expect(p.levelDb[23]).toBe(Number.NEGATIVE_INFINITY); // order 12: zero amplitude
    // the same series in other bins: [3250, 3750) holds the 3250 rpm frame, [3750, 4250) the 4000 rpm one
    expect(orderProfile(s, STEP, 3500).frames).toBe(1);
    expect(orderProfile(s, STEP, 4000).frames).toBe(1);
    expect(orderProfile(s, STEP, 4000).levelDb.every((db) => db === 0)).toBe(true);
    expect(orderProfile(s, STEP, 2500).frames).toBe(1); // 2749.9 rpm
  });

  it('uses order (i + 1)·step on the rotary third-order grid', () => {
    const amp = Array.from({ length: 36 }, (_, i) => (i === 5 ? 1 : 0.5));
    const p = orderProfile({ label: 'rotary', rpm: [3000], orderAmp: [amp] }, 1 / 3, 3000);
    expect(p.orders).toHaveLength(36);
    expect(p.orders[0]).toBeCloseTo(1 / 3, 12);
    expect(p.orders[35]).toBeCloseTo(12, 12);
    expect(p.levelDb[5]).toBe(0); // order 2
    expect(p.levelDb[0]).toBeCloseTo(20 * Math.log10(0.5), 9);
  });

  it('accepts typed arrays (FrameFeatures rows) as well as plain arrays', () => {
    const p = orderProfile(
      { label: 'typed', rpm: Float64Array.of(3100), orderAmp: [Float64Array.from(ampRow(0.1, { 2: 1 }))] },
      STEP,
      3000,
    );
    expect(p.frames).toBe(1);
    expect(p.levelDb[3]).toBe(0);
    expect(p.levelDb[0]).toBeCloseTo(-20, 9);
  });

  it('has no levels when no frame is in the bin, the bin is silent or there is no bin', () => {
    const none = orderProfile(flatSeries('idle', ampRow(1), 4, 800), STEP, 3000);
    expect(none.frames).toBe(0);
    expect(none.levelDb).toEqual([]);
    expect(none.orders).toHaveLength(N_ORDERS);
    const silent = orderProfile(flatSeries('gap', ampRow(0), 2), STEP, 3000);
    expect(silent.frames).toBe(2);
    expect(silent.levelDb).toEqual([]);
    expect(orderProfile({ label: 'empty', rpm: [], orderAmp: [] }, STEP, 3000).frames).toBe(0);
    // null: no bin (an order plot without frames), nothing is in it
    const noBin = orderProfile(flatSeries('ok', ampRow(1)), STEP, null);
    expect(noBin.frames).toBe(0);
    expect(noBin.levelDb).toEqual([]);
    expect(noBin.orders).toHaveLength(N_ORDERS);
  });

  it('puts a frame without an rpm > 0 in no bin, as the scoring does', () => {
    const s = framesAt('low', 'render', [0, -100, 100]);
    expect(orderProfile(s, STEP, 0).frames).toBe(1); // only 100 rpm, though [−250, 250) holds 0 and −100 too
  });

  it('rejects an invalid step or bin, mismatched lengths and non-finite or negative values in any frame', () => {
    const ok = flatSeries('ok', ampRow(1));
    for (const step of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 13]) {
      expect(() => orderProfile(ok, step, 3000), `step=${step}`).toThrow(RangeError);
    }
    // the bins are centred on multiples of 500 rpm
    for (const bin of [3100, 250, 3000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => orderProfile(ok, STEP, bin), `bin ${bin}`).toThrow(RangeError);
    }
    expect(() => orderProfile({ label: 'x', rpm: [3000, 3000], orderAmp: [ampRow(1)] }, STEP, 3000)).toThrow(RangeError);
    expect(() => orderProfile(flatSeries('x', ampRow(1).slice(1)), STEP, 3000)).toThrow(RangeError); // 23 rows for 24 orders
    expect(() => orderProfile(ok, 1 / 3, 3000)).toThrow(RangeError); // 24 orders where step 1/3 gives 36
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => orderProfile(flatSeries('x', ampRow(1, { 3: bad })), STEP, 3000), `amp ${bad}`).toThrow(RangeError);
      // validated outside the bin, and without a bin, too
      expect(() => orderProfile(flatSeries('x', ampRow(1, { 3: bad }), 1, 6000), STEP, 3000), `amp ${bad}`).toThrow(RangeError);
      expect(() => orderProfile(flatSeries('x', ampRow(1, { 3: bad })), STEP, null), `amp ${bad}`).toThrow(RangeError);
    }
    for (const rpm of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => orderProfile({ label: 'x', rpm: [rpm], orderAmp: [ampRow(1)] }, STEP, 3000), `rpm ${rpm}`).toThrow(RangeError);
    }
  });
});

describe('orderPlotBin (amendment D7)', () => {
  it('picks the 500 rpm bin with the most frames common to the render and the references: min(render, reference) per bin', () => {
    // render: 10 frames at 2000 rpm, 3 at 4500; references: 1 at 2000, 3 at 4500 (two clips), 9 at 6000.
    // Common: 2000 → min(10, 1) = 1, 4500 → min(3, 3) = 3, 6000 → 0. (The most frames in a bin both hold would be
    // 2000 with 11; the most frames in any bin 2000 too: neither is D7's count.)
    const series = [
      framesAt('cruise render', 'render', [...times(2000, 10), ...times(4500, 3)]),
      framesAt('wot ref-a', 'reference', [2100, 4400, 4600, ...times(6000, 9)]),
      framesAt('liftoff ref-b', 'reference', [4700]),
    ];
    expect(orderPlotBin(series)).toEqual({ rpm: 4500, lo: 4250, hi: 4750, renderFrames: 3, referenceFrames: 3, commonFrames: 3, frames: 6 });
  });

  it('breaks ties toward the lower rpm, whatever the order of series and frames', () => {
    const r = framesAt('r', 'render', [...times(5000, 2), ...times(3000, 2)]);
    const f = framesAt('f', 'reference', [...times(5000, 4), ...times(3000, 2)]);
    const want = { rpm: 3000, lo: 2750, hi: 3250, renderFrames: 2, referenceFrames: 2, commonFrames: 2, frames: 4 };
    expect(orderPlotBin([r, f])).toEqual(want);
    expect(orderPlotBin([f, r])).toEqual(want);
    const rev = (s: OrderSeries): OrderSeries => framesAt(s.label, s.role, Array.from(s.rpm).reverse());
    expect(orderPlotBin([rev(f), rev(r)])).toEqual(want);
  });

  it('bins frames as the scoring does: the bin of c rpm holds [c − 250, c + 250), and orderProfile counts the same frames', () => {
    const r = framesAt('r', 'render', [4250, 4749.999]);
    const f = framesAt('f', 'reference', [4249.999, 4250, 4749.999, 4750]);
    const bin = orderPlotBin([r, f]);
    expect(bin).toEqual({ rpm: 4500, lo: 4250, hi: 4750, renderFrames: 2, referenceFrames: 2, commonFrames: 2, frames: 4 });
    expect(orderProfile(f, STEP, bin?.rpm ?? null).frames).toBe(2);
    expect(orderProfile(f, STEP, 4000).frames).toBe(1);
    expect(orderProfile(f, STEP, 5000).frames).toBe(1);
  });

  it('counts every series, drawn or not', () => {
    // 8 render series at 3000 rpm take every colour slot; the 9th–11th (not drawn) hold the only common frames
    const series = [
      ...Array.from({ length: 8 }, (_, i) => framesAt(`render ${i}`, 'render', [3000])),
      framesAt('render 8', 'render', times(5000, 3)),
      framesAt('ref a', 'reference', times(5000, 3)),
      framesAt('ref b', 'reference', times(5000, 3)),
    ];
    expect(orderPlotBin(series)).toMatchObject({ rpm: 5000, renderFrames: 3, referenceFrames: 6, commonFrames: 3, frames: 9 });
  });

  it('falls back to the bin with the most frames (ties → the lower rpm) when no bin holds both', () => {
    // no overlap: render at 2000 rpm only, references at 6000 rpm only (a tie of 3 frames each)
    const apart = [framesAt('r', 'render', times(2000, 3)), framesAt('f', 'reference', times(6000, 3))];
    expect(orderPlotBin(apart)).toEqual({ rpm: 2000, lo: 1750, hi: 2250, renderFrames: 3, referenceFrames: 0, commonFrames: 0, frames: 3 });
    // only one side
    expect(orderPlotBin([framesAt('r', 'render', [...times(2000, 2), ...times(3000, 4)])])).toMatchObject({ rpm: 3000, commonFrames: 0, frames: 4 });
    // series without a role count only here
    const plain = [flatSeries('a', ampRow(1), 2, 800), flatSeries('b', ampRow(1), 3, 3000)];
    expect(orderPlotBin(plain)).toEqual({ rpm: 3000, lo: 2750, hi: 3250, renderFrames: 0, referenceFrames: 0, commonFrames: 0, frames: 3 });
  });

  it('is null when no series has a frame with an rpm > 0', () => {
    expect(orderPlotBin([])).toBeNull();
    expect(orderPlotBin([framesAt('none', 'render', [])])).toBeNull();
    expect(orderPlotBin([framesAt('stopped', 'reference', [0, -50])])).toBeNull();
  });

  it('rejects a non-finite rpm in any series', () => {
    for (const rpm of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => orderPlotBin([framesAt('r', 'render', [3000]), framesAt('x', undefined, [3000, rpm])]), `rpm ${rpm}`).toThrow(RangeError);
    }
  });
});

describe('markerMask', () => {
  it('gives each of the 8 colour slots its own symmetric 9×9 shape (identity never by colour alone)', () => {
    const masks = Array.from({ length: ORDER_PLOT.maxSeries }, (_, i) => markerMask(i));
    expect(new Set(masks.map((m) => m.join(''))).size).toBe(8);
    for (const [i, m] of masks.entries()) {
      expect(m, `slot ${i}`).toHaveLength(81);
      const ink = m.reduce((a, v) => a + v, 0);
      expect(ink, `slot ${i} ink`).toBeGreaterThanOrEqual(35);
      expect(ink, `slot ${i} ink`).toBeLessThanOrEqual(65);
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) expect(m[y * 9 + x], `slot ${i} (${x},${y})`).toBe(m[y * 9 + 8 - x]);
      }
    }
  });

  it('returns a copy and rejects slots outside 0…7', () => {
    markerMask(0).fill(0);
    expect(markerMask(0).some((v) => v === 1)).toBe(true);
    for (const slot of [-1, 8, 0.5, Number.NaN]) expect(() => markerMask(slot), `slot ${slot}`).toThrow(RangeError);
  });
});

describe('orderPlotPng', () => {
  const layout = orderPlotLayout(ORDER_PLOT.width, ORDER_PLOT.height);
  const { plot, data, legend, legendRowH, scale } = layout;
  /** Series 0: order 2 at 0 dB, everything else at −20 dB. */
  const render = (): OrderSeries => flatSeries('render', ampRow(0.1, { 2: 1 }));

  it('uses 8 categorical colours with ≥ 3:1 contrast on the panel and text inks with ≥ 4.5:1 on both surfaces', () => {
    expect(SERIES_COLORS).toHaveLength(ORDER_PLOT.maxSeries);
    expect(new Set(SERIES_COLORS.map((c) => c.join(','))).size).toBe(8);
    for (const c of SERIES_COLORS) {
      expect(contrastRatio(c, PLOT_COLORS.panel), `${c.join(',')}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c, PLOT_COLORS.background), `${c.join(',')}`).toBeGreaterThanOrEqual(3);
    }
    for (const ink of [PLOT_COLORS.text, PLOT_COLORS.dim]) {
      for (const surface of [PLOT_COLORS.background, PLOT_COLORS.panel]) {
        expect(contrastRatio(ink, surface), `${ink.join(',')} on ${surface.join(',')}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('defaults to an opaque 960×540 figure: panel, data area inside it, legend column to its right', () => {
    const d = decodePng(orderPlotPng([render()], STEP));
    expect([d.width, d.height]).toEqual([960, 540]);
    for (let i = 3; i < d.rgba.length; i += 4) if (d.rgba[i] !== 255) throw new Error(`alpha ${d.rgba[i]} at byte ${i}`);
    expect(scale).toBe(2);
    expect(data.x).toBeGreaterThan(plot.x);
    expect(data.y).toBeGreaterThan(plot.y);
    expect(data.x + data.w).toBeLessThan(plot.x + plot.w);
    expect(data.y + data.h).toBeLessThan(plot.y + plot.h);
    expect(legend.x).toBeGreaterThan(plot.x + plot.w);
    expect(legend.x + legend.w).toBeLessThanOrEqual(960);
    expect(pixel(d, 0, 0)).toEqual([...PLOT_COLORS.background]);
    // between gridlines and away from the series: bare panel
    expect(pixel(d, xOfOrder(0.25, data), yOfDb(-55, data))).toEqual([...PLOT_COLORS.panel]);
    // with data present, no secondary ink inside the data area (that is where NO DATA would be written)
    expect(countColor(d, PLOT_COLORS.dim, data.x, data.y, data.x + data.w, data.y + data.h)).toBe(0);
  });

  it('marks every order on the documented order/level grid, joined by a 2 px line', () => {
    const d = decodePng(orderPlotPng([flatSeries('render', ampRow(0.1, { 2: 1, 4: 0.01 }))], STEP));
    for (let i = 1; i <= N_ORDERS; i++) {
      const order = i * STEP;
      const db = order === 2 ? 0 : order === 4 ? -40 : -20;
      expect(pixel(d, xOfOrder(order, data), yOfDb(db, data)), `order ${order}`).toEqual([...color(0)]);
    }
    // halfway between orders 7 and 7.5 (no marker, no gridline) the line is level at −20 dB, 2 px thick
    const xm = Math.round((xOfOrder(7, data) + xOfOrder(7.5, data)) / 2);
    const rows: number[] = [];
    for (let y = plot.y; y < plot.y + plot.h; y++) if (same(pixel(d, xm, y), color(0))) rows.push(y);
    expect(rows).toHaveLength(2);
    for (const y of rows) expect(Math.abs(y - yOfDb(-20, data))).toBeLessThanOrEqual(1);
  });

  it('clamps levels below −60 dB and silent orders to the bottom of the level axis', () => {
    const d = decodePng(orderPlotPng([flatSeries('r', ampRow(1, { 3: 1e-6, 5: 0 }))], STEP));
    const bottom = data.y + data.h - 1;
    expect(yOfDb(-120, data)).toBe(bottom);
    expect(pixel(d, xOfOrder(3, data), bottom)).toEqual([...color(0)]); // −120 dB
    expect(pixel(d, xOfOrder(5, data), bottom)).toEqual([...color(0)]); // −∞ dB
    expect(pixel(d, xOfOrder(4, data), data.y)).toEqual([...color(0)]); // 0 dB
  });

  it('draws the slot marker with a 2 px panel-coloured ring that cuts lines and gridlines', () => {
    // order 3 at 0 dB, its neighbours at −60 dB: lines climb into the marker; gridlines cross it
    const d = decodePng(orderPlotPng([flatSeries('r', ampRow(0.001, { 3: 1 }))], STEP));
    const cx = xOfOrder(3, data);
    const cy = yOfDb(0, data);
    const m = markerMask(0);
    for (let y = -4; y <= 4; y++) {
      for (let x = -4; x <= 4; x++) {
        const want = m[(y + 4) * 9 + x + 4] === 1 ? color(0) : PLOT_COLORS.panel;
        expect(pixel(d, cx + x, cy + y), `(${x},${y})`).toEqual([...want]);
      }
    }
    // the ink reaches 3 px from the centre: the ring covers 4–5 px, the 0 dB and order-3 gridlines resume at 6 px
    expect(pixel(d, cx - 5, cy)).toEqual([...PLOT_COLORS.panel]);
    expect(pixel(d, cx - 6, cy)).toEqual([...PLOT_COLORS.grid]);
    expect(pixel(d, cx, cy - 5)).toEqual([...PLOT_COLORS.panel]);
    expect(pixel(d, cx, cy - 6)).toEqual([...PLOT_COLORS.grid]);
  });

  it('colours series by input position in the fixed slot order, draws series 0 on top, keys each in the legend', () => {
    const series = [
      render(),
      flatSeries('ref-a', ampRow(0.1, { 2: 1 })), // identical to series 0: hidden beneath it
      flatSeries('ref-b', ampRow(0.01, { 4: 1 })), // order 4 at 0 dB, the rest at −40 dB
    ];
    const d = decodePng(orderPlotPng(series, STEP));
    expect(pixel(d, xOfOrder(2, data), yOfDb(0, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(4, data), yOfDb(0, data))).toEqual([...color(2)]);
    expect(pixel(d, xOfOrder(6, data), yOfDb(-40, data))).toEqual([...color(2)]);
    expect(countColor(d, color(1), plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBe(0);
    expect(countColor(d, PLOT_COLORS.dim, legend.x, legend.y, legend.x + legend.w, legend.y + legendRowH)).toBeGreaterThan(20); // header
    for (let i = 0; i < series.length; i++) {
      const y0 = legend.y + (i + 1) * legendRowH;
      const keyXs = xsOfColor(d, color(i), legend.x, y0, legend.x + legend.w, y0 + legendRowH);
      const textXs = xsOfColor(d, PLOT_COLORS.text, legend.x, y0, legend.x + legend.w, y0 + legendRowH);
      expect(keyXs.length, `key ${i}`).toBeGreaterThan(30);
      expect(textXs.length, `label ${i}`).toBeGreaterThan(30);
      // the coloured key sits left of the label: text never wears the series colour
      expect(Math.max(...keyXs), `row ${i}`).toBeLessThan(Math.min(...textXs));
      // frame count, right-aligned in secondary ink
      expect(countColor(d, PLOT_COLORS.dim, legend.x, y0, legend.x + legend.w, y0 + legendRowH), `count ${i}`).toBeGreaterThan(5);
    }
  });

  it('keeps a series without frames in the bin in the legend and its slot colour for the next series', () => {
    // the plotted bin is 3000 rpm (the render and a reference meet there); the idle reference has no frame in it
    const series = [
      flatSeries('idle-only', ampRow(0.1, { 1: 1 }), 3, 800, 'reference'),
      flatSeries('render', ampRow(0.1, { 2: 1 }), 3, 3000, 'render'),
      flatSeries('ref', ampRow(0.1, { 5: 1 }), 2, 3000, 'reference'),
    ];
    const d = decodePng(orderPlotPng(series, STEP));
    expect(countColor(d, color(0), plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBe(0);
    expect(countColor(d, color(1), plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBeGreaterThan(200);
    expect(pixel(d, xOfOrder(2, data), yOfDb(0, data))).toEqual([...color(1)]);
    const y0 = legend.y + legendRowH;
    expect(countColor(d, color(0), legend.x, y0, legend.x + legend.w, y0 + legendRowH)).toBeGreaterThan(30);
    expect(countColor(d, PLOT_COLORS.text, legend.x, y0, legend.x + legend.w, y0 + legendRowH)).toBeGreaterThan(30);
  });

  it('writes NO DATA in the data area when nothing can be drawn', () => {
    // no series; a series without frames; a silent bin; frames without an rpm > 0 (in no bin)
    for (const series of [
      [],
      [flatSeries('none', ampRow(1), 0)],
      [flatSeries('gap', ampRow(0))],
      [flatSeries('stopped', ampRow(1), 2, 0, 'render')],
    ]) {
      const d = decodePng(orderPlotPng(series, STEP));
      expect(countColor(d, PLOT_COLORS.dim, data.x, data.y, data.x + data.w, data.y + data.h)).toBeGreaterThan(20);
      for (const c of SERIES_COLORS) expect(countColor(d, c, plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBe(0);
    }
  });

  it('labels the title, the level axis every 10 dB and the order axis at every integer order', () => {
    const d = decodePng(orderPlotPng([render()], STEP));
    // title (primary ink) and the dB reference note (secondary ink) above the panel; "DB" above the level labels
    expect(countColor(d, PLOT_COLORS.text, plot.x, 0, plot.x + plot.w, plot.y)).toBeGreaterThan(100);
    expect(countColor(d, PLOT_COLORS.dim, plot.x, 0, plot.x + plot.w, plot.y)).toBeGreaterThan(100);
    expect(countColor(d, PLOT_COLORS.text, 0, 0, plot.x, plot.y - 4 * scale)).toBeGreaterThan(20);
    for (let db = 0; db >= -ORDER_PLOT.rangeDb; db -= 10) {
      const y = yOfDb(db, data);
      expect(pixel(d, data.x + 3, y), `${db} dB gridline`).toEqual([...PLOT_COLORS.grid]);
      expect(countColor(d, PLOT_COLORS.text, 0, y - 4 * scale, plot.x, y + 4 * scale), `${db} dB label`).toBeGreaterThan(10);
    }
    for (let order = 0; order <= ORDER_PLOT.maxOrder; order++) {
      const x = xOfOrder(order, data);
      expect(pixel(d, x, plot.y + plot.h - 2), `order ${order} gridline`).toEqual([...PLOT_COLORS.grid]);
      expect(
        countColor(d, PLOT_COLORS.text, x - 6 * scale, plot.y + plot.h, x + 6 * scale, ORDER_PLOT.height),
        `order ${order} label`,
      ).toBeGreaterThan(10);
    }
    // the "ORDER" axis title at the end of the order axis
    expect(countColor(d, PLOT_COLORS.text, plot.x + plot.w + 8 * scale, plot.y + plot.h, 960, 540)).toBeGreaterThan(30);
  });

  it('writes the documented title, level labels and order labels at their anchors', () => {
    const d = decodePng(orderPlotPng([render()], STEP));
    const half = Math.floor(textMask('0', scale).height / 2);
    expectText(d, 'ORDERS AT 3000 RPM (2750-3250)', plot.x, layout.titleTop, scale, PLOT_COLORS.text);
    // level labels right-aligned at levelLabelRight, centred on their gridline
    for (const db of [0, -10, -30, -60]) {
      const text = `${db}`;
      expectText(d, text, layout.levelLabelRight - textMask(text, scale).width, yOfDb(db, data) - half, scale, PLOT_COLORS.text);
    }
    // order labels centred on their gridline
    for (const order of [0, 1, 6, 12]) {
      const text = `${order}`;
      const x = xOfOrder(order, data) - Math.floor(textMask(text, scale).width / 2);
      expectText(d, text, x, layout.orderLabelTop, scale, PLOT_COLORS.text);
    }
  });

  it('plots the D7 bin: every profile there, the bin in the title and in the legend header (amendment D7)', () => {
    // The render peaks at order 2 at 3000 rpm but at order 3 at 4500 rpm; the reference has frames at 4500 and
    // 6000 rpm only. The render and the reference meet at 4500 rpm (2 frames each), never at 3000.
    const a2 = ampRow(0.1, { 2: 1 });
    const a3 = ampRow(0.1, { 3: 1 });
    const a4 = ampRow(0.1, { 4: 1 });
    const series: OrderSeries[] = [
      { label: 'wot render', role: 'render', rpm: [3000, 3000, 3000, 4400, 4600], orderAmp: [a2, a2, a2, a3, a3] },
      { label: 'wot ref', role: 'reference', rpm: [4300, 4700, 6000], orderAmp: [a4, a4, a2] },
    ];
    const d = decodePng(orderPlotPng(series, STEP));
    // the profiles at 4500 rpm: render order 3 and reference order 4 at 0 dB, the render's order 2 at −20 dB
    expect(pixel(d, xOfOrder(3, data), yOfDb(0, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(2, data), yOfDb(-20, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(2, data), yOfDb(0, data))).not.toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(4, data), yOfDb(0, data))).toEqual([...color(1)]);
    expectText(d, 'ORDERS AT 4500 RPM (4250-4750)', plot.x, layout.titleTop, scale, PLOT_COLORS.text);
    // legend header: the bin (primary ink) over the series, FRAMES (secondary ink) over the right-aligned counts
    expectText(d, '4250-4750 RPM', legend.x, legend.y, scale, PLOT_COLORS.text);
    expectText(d, 'FRAMES', legend.x + legend.w - textMask('FRAMES', scale).width, legend.y, scale, PLOT_COLORS.dim);
    for (const row of [1, 2]) {
      const y0 = legend.y + row * legendRowH;
      expectText(d, '2', legend.x + legend.w - textMask('2', scale).width, y0, scale, PLOT_COLORS.dim);
    }
    // a series' frames outside the bin (the render's at 3000 rpm) change nothing
    const only = decodePng(orderPlotPng([{ ...series[0], rpm: [4400, 4600], orderAmp: [a3, a3] } as OrderSeries, series[1] as OrderSeries], STEP));
    const plotRows = (rgba: Uint8Array): Buffer => Buffer.from(rgba.subarray(plot.y * d.width * 4, (plot.y + plot.h) * d.width * 4));
    expect(plotRows(only.rgba).equals(plotRows(d.rgba))).toBe(true);
  });

  it('adds NO COMMON BIN to the title when no bin holds both render and reference frames', () => {
    // render at 2000 rpm, references at 6000 rpm, 3 frames each: the lower of the two fullest bins
    const series = [flatSeries('cruise render', ampRow(0.1, { 2: 1 }), 3, 2000, 'render'), flatSeries('wot ref', ampRow(0.1, { 4: 1 }), 3, 6000, 'reference')];
    const d = decodePng(orderPlotPng(series, STEP));
    const title = 'ORDERS AT 2000 RPM (1750-2250)';
    expectText(d, title, plot.x, layout.titleTop, scale, PLOT_COLORS.text);
    expectText(d, 'NO COMMON BIN', plot.x + (title.length + 1) * 6 * scale, layout.titleTop, scale, PLOT_COLORS.dim);
    expect(pixel(d, xOfOrder(2, data), yOfDb(0, data))).toEqual([...color(0)]);
    expectText(d, '1750-2250 RPM', legend.x, legend.y, scale, PLOT_COLORS.text);
    // series without a role have no render/reference sides: the fullest bin, no note
    const plain = decodePng(orderPlotPng([flatSeries('a', ampRow(0.1, { 2: 1 }), 3, 2000)], STEP));
    expect(countColor(plain, PLOT_COLORS.dim, plot.x, 0, plain.width, layout.titleTop + 8 * scale)).toBe(0);
  });

  it('titles a plot without frames ORDERS (NO FRAMES) and says NO RPM BIN in the legend header', () => {
    const d = decodePng(orderPlotPng([flatSeries('none', ampRow(1), 0, 3000, 'render')], STEP));
    expectText(d, 'ORDERS (NO FRAMES)', plot.x, layout.titleTop, scale, PLOT_COLORS.text);
    expectText(d, 'NO RPM BIN', legend.x, legend.y, scale, PLOT_COLORS.text);
    expect(countColor(d, PLOT_COLORS.dim, data.x, data.y, data.x + data.w, data.y + data.h)).toBeGreaterThan(20); // NO DATA
  });

  it('plots the rotary third-order grid', () => {
    const amp = Array.from({ length: 36 }, (_, i) => (i === 2 ? 1 : 0.1)); // order 1 at 0 dB, the rest at −20 dB
    const d = decodePng(orderPlotPng([{ label: 'rotary', rpm: [3000, 3000], orderAmp: [amp, amp] }], 1 / 3));
    expect(pixel(d, xOfOrder(1, data), yOfDb(0, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(1 / 3, data), yOfDb(-20, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(23 / 3, data), yOfDb(-20, data))).toEqual([...color(0)]);
    expect(pixel(d, xOfOrder(12, data), yOfDb(-20, data))).toEqual([...color(0)]);
  });

  it('fits 8 long-labelled series and the count of 2 more at the minimum sizes, truncating labels to the legend column', () => {
    for (const [w, h] of [
      [400, 240],
      [640, 360],
    ] as const) {
      const L = orderPlotLayout(w, h);
      expect(L.scale).toBe(w === 400 ? 1 : 2);
      const series = Array.from({ length: 10 }, (_, i) =>
        flatSeries(`a-very-long-reference-clip-name-${i}`, ampRow(0.1, { [i + 1]: 1 })),
      );
      const d = decodePng(orderPlotPng(series, STEP, { width: w, height: h }));
      expect([d.width, d.height]).toEqual([w, h]);
      // header, 8 series rows and the count row inside the legend column
      expect(L.legend.y + 10 * L.legendRowH).toBeLessThanOrEqual(L.plot.y + L.plot.h);
      for (let i = 0; i < 8; i++) {
        const y0 = L.legend.y + (i + 1) * L.legendRowH;
        expect(countColor(d, color(i), L.legend.x, y0, L.legend.x + L.legend.w, y0 + L.legendRowH), `${w}: key ${i}`).toBeGreaterThan(20);
        expect(countColor(d, PLOT_COLORS.text, L.legend.x, y0, L.legend.x + L.legend.w, y0 + L.legendRowH), `${w}: label ${i}`).toBeGreaterThan(20);
        expect(pixel(d, xOfOrder(i + 1, L.data), yOfDb(0, L.data)), `${w}: peak ${i}`).toEqual([...color(i)]);
      }
      expectText(d, '+2 MORE NOT SHOWN', L.legendLabelX, L.legend.y + 9 * L.legendRowH, L.scale, PLOT_COLORS.dim);
      // no text right of the legend column or below the figure's label rows
      expect(countColor(d, PLOT_COLORS.text, L.legend.x + L.legend.w, 0, w, h)).toBe(0);
      expect(countColor(d, PLOT_COLORS.dim, L.legend.x + L.legend.w, 0, w, h)).toBe(0);
    }
  });

  it('draws the first 8 of more series and counts the rest in a last legend row instead of failing', () => {
    // series i peaks at order i + 1; series 8–10 (orders 9–11) have no colour slot and are not drawn
    const series = Array.from({ length: 11 }, (_, i) => flatSeries(`s${i}`, ampRow(0.1, { [i + 1]: 1 })));
    const d = decodePng(orderPlotPng(series, STEP));
    for (let i = 0; i < 8; i++) expect(pixel(d, xOfOrder(i + 1, data), yOfDb(0, data)), `series ${i}`).toEqual([...color(i)]);
    for (const order of [9, 10, 11]) expect(pixel(d, xOfOrder(order, data), yOfDb(0, data)), `order ${order}`).toEqual([...PLOT_COLORS.grid]);
    expect(countColor(d, PLOT_COLORS.text, plot.x, plot.y, plot.x + plot.w, plot.y + plot.h)).toBe(0);
    // legend: header, series 0–7, then the count in secondary ink where a label would start; nothing below it
    for (let i = 0; i < 8; i++) {
      const y0 = legend.y + (i + 1) * legendRowH;
      expect(countColor(d, color(i), legend.x, y0, legend.x + legend.w, y0 + legendRowH), `key ${i}`).toBeGreaterThan(30);
    }
    const y9 = legend.y + 9 * legendRowH;
    expectText(d, '+3 MORE NOT SHOWN', layout.legendLabelX, y9, scale, PLOT_COLORS.dim);
    expect(countColor(d, PLOT_COLORS.dim, legend.x, y9, layout.legendLabelX - scale, y9 + legendRowH)).toBe(0);
    expect(countColor(d, PLOT_COLORS.text, legend.x, y9, legend.x + legend.w, legend.y + legend.h)).toBe(0);
    expect(countColor(d, PLOT_COLORS.dim, legend.x, y9 + legendRowH, legend.x + legend.w, legend.y + legend.h)).toBe(0);
    // the first 8 render exactly as they do alone (everything above the count row)
    const above = (rgba: Uint8Array): Buffer => Buffer.from(rgba.subarray(0, y9 * d.width * 4));
    expect(above(d.rgba).equals(above(decodePng(orderPlotPng(series.slice(0, 8), STEP)).rgba))).toBe(true);
    // series that are not drawn are still validated
    expect(() => orderPlotPng([...series, flatSeries('bad', ampRow(1).slice(1))], STEP)).toThrow(RangeError);
  });

  it('right-aligns each frame count: frames averaged, 0 for an empty bin, SILENT for an all-zero bin', () => {
    const series = [render(), flatSeries('idle', ampRow(1), 2, 800), flatSeries('gap', ampRow(0), 5)];
    const d = decodePng(orderPlotPng(series, STEP));
    for (const [row, count] of [
      [1, '3'],
      [2, '0'],
      [3, 'SILENT'],
    ] as const) {
      const m = textMask(count, scale);
      const x0 = legend.x + legend.w - m.width;
      const y0 = legend.y + row * legendRowH;
      let want = '';
      let got = '';
      for (let y = 0; y < m.height; y++) {
        for (let x = -2 * scale; x < m.width; x++) {
          want += x >= 0 && m.mask[y * m.width + x] === 1 ? '#' : '.';
          got += same(pixel(d, x0 + x, y0 + y), PLOT_COLORS.dim) ? '#' : '.';
        }
      }
      expect(got, `row ${row}: ${count}`).toBe(want);
    }
  });

  it('shortens long labels in the middle, keeping the end that tells clips apart', () => {
    const labels = ['mustang-gt-onboard-cabin-take-a', 'mustang-gt-onboard-cabin-take-b'];
    const d = decodePng(orderPlotPng(labels.map((l) => flatSeries(l, ampRow(0.1, { 2: 1 }))), STEP));
    const ink = (row: number): string => {
      const y0 = legend.y + row * legendRowH;
      let bits = '';
      for (let y = y0; y < y0 + legendRowH; y++) {
        for (let x = legend.x; x < legend.x + legend.w; x++) bits += same(pixel(d, x, y), PLOT_COLORS.text) ? '#' : '.';
      }
      return bits;
    };
    expect(ink(1)).toContain('#');
    expect(ink(1)).not.toBe(ink(2));
  });

  it('is deterministic', () => {
    const series = [render(), flatSeries('ref', ampRow(0.05, { 2.5: 1 }))];
    expect(Buffer.from(orderPlotPng(series, STEP)).equals(Buffer.from(orderPlotPng(series, STEP)))).toBe(true);
  });

  it('rejects an invalid step, invalid series and invalid sizes', () => {
    for (const step of [0, Number.NaN, 13]) expect(() => orderPlotPng([], step), `step=${step}`).toThrow(RangeError);
    expect(() => orderPlotPng([render(), flatSeries('short', ampRow(1).slice(2))], STEP)).toThrow(RangeError);
    for (const [width, height] of [
      [399, 240],
      [400, 239],
      [960.5, 540],
      [Number.NaN, 540],
    ]) {
      expect(() => orderPlotPng([render()], STEP, { width, height }), `${width}×${height}`).toThrow(RangeError);
      expect(() => orderPlotLayout(width ?? 0, height ?? 0), `${width}×${height}`).toThrow(RangeError);
    }
  });
});
