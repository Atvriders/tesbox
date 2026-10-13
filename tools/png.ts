/**
 * PNG plots for the score CLI (phase 2b contract T4, spec §11.3). Node only.
 *
 * encodePng: in-house PNG writer (RFC 2083) — signature, IHDR (8-bit RGBA, no interlace), IDAT
 * (scanlines with filter type 0, compressed into a zlib stream (RFC 1950) by node:zlib deflateSync,
 * split into chunks of at most IDAT_CHUNK bytes), IEND; chunk CRCs from the table-driven CRC-32 below.
 */
import { deflateSync } from 'node:zlib';
import { fft, hann } from '../src/dsp/analysis';

// ───────────────────────────── CRC-32 (RFC 2083 §3.4) ─────────────────────────────

/** CRC-32 lookup table for the reflected polynomial 0xEDB88320 (x³²+x²⁶+…+x+1, ISO 3309 / ITU-T V.42). */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG chunks use it: register preset to all ones, result complemented (RFC 2083 §3.4). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────────────────────────── PNG encoder (RFC 2083) ─────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Width and height are 1 … 2³¹ − 1 (RFC 2083 §4.1.1). */
const PNG_MAX_DIM = 0x7fffffff;
/** IDAT payload per chunk; any size up to 2³¹ − 1 is valid, smaller chunks keep every length field small. */
export const IDAT_CHUNK = 1 << 16;

/** Writes one chunk (length, type, data, CRC over type + data) at `off`; returns the offset after it. */
function writeChunk(out: Uint8Array, view: DataView, off: number, type: string, data: Uint8Array): number {
  view.setUint32(off, data.length);
  for (let i = 0; i < 4; i++) out[off + 4 + i] = type.charCodeAt(i);
  out.set(data, off + 8);
  view.setUint32(off + 8 + data.length, crc32(out.subarray(off + 4, off + 8 + data.length)));
  return off + 12 + data.length;
}

/** 8-bit RGBA, non-interlaced PNG of a width × height image (`rgba` row-major, 4 bytes per pixel). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const validDim = (d: number): boolean => Number.isInteger(d) && d >= 1 && d <= PNG_MAX_DIM;
  if (!validDim(width) || !validDim(height)) throw new RangeError(`encodePng: invalid size ${width}×${height}`);
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new RangeError(`encodePng: expected ${stride * height} RGBA bytes for ${width}×${height}, got ${rgba.length}`);
  }
  // Each scanline is a filter-type byte (0 = None) followed by the row's bytes (RFC 2083 §6).
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = deflateSync(raw);

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression method: deflate
  ihdr[11] = 0; // filter method: adaptive (five filter types)
  ihdr[12] = 0; // interlace method: none

  const idatChunks = Math.max(1, Math.ceil(z.length / IDAT_CHUNK));
  const out = new Uint8Array(PNG_SIGNATURE.length + (12 + ihdr.length) + idatChunks * 12 + z.length + 12);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let off = writeChunk(out, view, PNG_SIGNATURE.length, 'IHDR', ihdr);
  for (let i = 0; i < idatChunks; i++) {
    off = writeChunk(out, view, off, 'IDAT', z.subarray(i * IDAT_CHUNK, (i + 1) * IDAT_CHUNK));
  }
  writeChunk(out, view, off, 'IEND', new Uint8Array(0));
  return out;
}

// ───────────────────────────── Colours ─────────────────────────────

export type Rgb = readonly [number, number, number];

/** CIE L*a*b* (D65 white) → linear-light sRGB: CIE 15:2004 inverse, then the IEC 61966-2-1 XYZ→RGB matrix. */
function labToLinearSrgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const finv = (f: number): number => (f > 6 / 29 ? f * f * f : 3 * (6 / 29) ** 2 * (f - 4 / 29));
  const x = 0.95047 * finv(fy + a / 500);
  const y = finv(fy);
  const z = 1.08883 * finv(fy - b / 200);
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
}

/** Linear-light sRGB component → 8-bit code through the IEC 61966-2-1 transfer function. */
function srgbByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(255 * Math.min(1, Math.max(0, v)));
}

/** Colormap lightness: CIE L* rises linearly with t from the first to the second value. */
const CMAP_LIGHTNESS = [2, 96] as const;
/** CIELAB hue angle in degrees along t: blue-violet (285°) → magenta → red → orange → yellow (455° ≡ 95°). */
const CMAP_HUE = [285, 455] as const;
/** Chroma cap; below it each entry takes the largest chroma sRGB can show at its lightness and hue. */
const CMAP_MAX_CHROMA = 70;

/**
 * 256-entry perceptual colormap (RGB triplets). Lightness is linear in t, so equal dB steps read as equal
 * brightness steps; the hue sweep adds discrimination. Out-of-gamut colours are mapped by reducing chroma
 * at constant L* and hue (bisection), which keeps the lightness ramp exact.
 */
const COLORMAP_LUT = ((): Uint8Array => {
  const lut = new Uint8Array(256 * 3);
  const inGamut = (rgb: readonly number[]): boolean => rgb.every((v) => v >= -1e-9 && v <= 1 + 1e-9);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const l = CMAP_LIGHTNESS[0] + (CMAP_LIGHTNESS[1] - CMAP_LIGHTNESS[0]) * t;
    const h = ((CMAP_HUE[0] + (CMAP_HUE[1] - CMAP_HUE[0]) * t) * Math.PI) / 180;
    const at = (chroma: number): [number, number, number] => labToLinearSrgb(l, chroma * Math.cos(h), chroma * Math.sin(h));
    let lo = 0; // chroma 0 is a grey of lightness l, always inside the gamut
    let hi = CMAP_MAX_CHROMA;
    if (inGamut(at(hi))) lo = hi;
    else {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (inGamut(at(mid))) lo = mid;
        else hi = mid;
      }
    }
    const rgb = at(lo);
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = srgbByte(rgb[ch] ?? 0);
  }
  return lut;
})();

/** Colour of the perceptual colormap at t ∈ [0, 1] (clamped; NaN → the t = 0 colour). */
export function colormap(t: number): [number, number, number] {
  const i = t > 0 ? Math.min(255, Math.round(t * 255)) : 0;
  return [COLORMAP_LUT[i * 3] ?? 0, COLORMAP_LUT[i * 3 + 1] ?? 0, COLORMAP_LUT[i * 3 + 2] ?? 0];
}

// ───────────────────────────── 5×7 bitmap font ─────────────────────────────

const GLYPH_W = 5;
const GLYPH_H = 7;
/** Horizontal advance per character: the glyph plus one blank column. */
const GLYPH_ADVANCE = 6;

/**
 * Upper-case printable ASCII as 5×7 dot matrices drawn for this project, rows top to bottom separated by
 * "|" ("#" = dot). Lower case is folded to upper case; anything else draws as "?".
 */
const GLYPH_ROWS: Record<string, string> = {
  ' ': '.....|.....|.....|.....|.....|.....|.....',
  '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '"': '.#.#.|.#.#.|.#.#.|.....|.....|.....|.....',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  '$': '..#..|.####|#.#..|.###.|..#.#|####.|..#..',
  '%': '##...|##..#|...#.|..#..|.#...|#..##|...##',
  '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#',
  "'": '..#..|..#..|..#..|.....|.....|.....|.....',
  '(': '...#.|..#..|.#...|.#...|.#...|..#..|...#.',
  ')': '.#...|..#..|...#.|...#.|...#.|..#..|.#...',
  '*': '.....|..#..|#.#.#|.###.|#.#.#|..#..|.....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  ',': '.....|.....|.....|.....|.##..|..#..|.#...',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '/': '.....|....#|...#.|..#..|.#...|#....|.....',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '#####|...#.|..#..|...#.|....#|#...#|.###.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
  ';': '.....|.##..|.##..|.....|.##..|..#..|.#...',
  '<': '...#.|..#..|.#...|#....|.#...|..#..|...#.',
  '=': '.....|.....|#####|.....|#####|.....|.....',
  '>': '.#...|..#..|...#.|....#|...#.|..#..|.#...',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  '@': '.###.|#...#|....#|.##.#|#.#.#|#.#.#|.###.',
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '###..|#..#.|#...#|#...#|#...#|#..#.|###..',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '[': '.###.|.#...|.#...|.#...|.#...|.#...|.###.',
  '\\': '.....|#....|.#...|..#..|...#.|....#|.....',
  ']': '.###.|...#.|...#.|...#.|...#.|...#.|.###.',
  '^': '..#..|.#.#.|#...#|.....|.....|.....|.....',
  _: '.....|.....|.....|.....|.....|.....|#####',
  '`': '.#...|..#..|...#.|.....|.....|.....|.....',
  '{': '...#.|..#..|..#..|.#...|..#..|..#..|...#.',
  '|': '..#..|..#..|..#..|..#..|..#..|..#..|..#..',
  '}': '.#...|..#..|..#..|...#.|..#..|..#..|.#...',
  '~': '.....|.....|.#...|#.#.#|...#.|.....|.....',
};

const GLYPHS = ((): Map<string, Uint8Array> => {
  const glyphs = new Map<string, Uint8Array>();
  for (const [ch, spec] of Object.entries(GLYPH_ROWS)) {
    const rows = spec.split('|');
    if (rows.length !== GLYPH_H || rows.some((r) => !/^[.#]{5}$/.test(r))) {
      throw new Error(`png: malformed glyph ${JSON.stringify(ch)}`);
    }
    const dots = new Uint8Array(GLYPH_W * GLYPH_H);
    rows.forEach((r, y) => {
      for (let x = 0; x < GLYPH_W; x++) dots[y * GLYPH_W + x] = r[x] === '#' ? 1 : 0;
    });
    glyphs.set(ch, dots);
  }
  return glyphs;
})();
const FALLBACK_GLYPH = GLYPHS.get('?') ?? new Uint8Array(GLYPH_W * GLYPH_H);

function glyphFor(ch: string): Uint8Array {
  const code = ch.codePointAt(0) ?? 0;
  const key = code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : ch;
  return GLYPHS.get(key) ?? FALLBACK_GLYPH;
}

/** Number of character cells (code points) in a text. */
function textLength(text: string): number {
  return [...text].length;
}

/** Pixel width of a text at `scale`: 6 columns per character, without the trailing blank column. */
function textWidth(text: string, scale: number): number {
  const n = textLength(text);
  return n === 0 ? 0 : (n * GLYPH_ADVANCE - 1) * scale;
}

/**
 * Renders `text` with the 5×7 font: a width × height mask (1 = ink), each dot a scale × scale block,
 * characters 6·scale px apart, height 7·scale.
 */
export function textMask(text: string, scale = 1): { width: number; height: number; mask: Uint8Array } {
  if (!Number.isInteger(scale) || scale < 1) throw new RangeError(`textMask: invalid scale ${scale}`);
  const chars = [...text];
  const width = textWidth(text, scale);
  const height = GLYPH_H * scale;
  const mask = new Uint8Array(width * height);
  chars.forEach((ch, i) => {
    const dots = glyphFor(ch);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (dots[gy * GLYPH_W + gx] !== 1) continue;
        const x0 = (i * GLYPH_ADVANCE + gx) * scale;
        for (let sy = 0; sy < scale; sy++) {
          const row = (gy * scale + sy) * width;
          mask.fill(1, row + x0, row + x0 + scale);
        }
      }
    }
  });
  return { width, height, mask };
}

// ───────────────────────────── Canvas ─────────────────────────────

export interface PlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Figure colours (dark theme, shared by both plots). */
export const PLOT_COLORS = {
  background: [22, 22, 26],
  panel: [32, 32, 38],
  grid: [54, 54, 62],
  frame: [124, 124, 136],
  text: [214, 214, 220],
  dim: [118, 118, 128],
  noData: [64, 64, 72],
} as const satisfies Record<string, Rgb>;

/** Opaque RGBA raster with clipped drawing primitives. */
class Canvas {
  readonly width: number;
  readonly height: number;
  readonly px: Uint8Array;

  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.px[i * 4] = background[0];
      this.px[i * 4 + 1] = background[1];
      this.px[i * 4 + 2] = background[2];
      this.px[i * 4 + 3] = 255;
    }
  }

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const o = (y * this.width + x) * 4;
    this.px[o] = c[0];
    this.px[o + 1] = c[1];
    this.px[o + 2] = c[2];
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.set(xx, yy, c);
    }
  }

  /** One-pixel outline just outside the rectangle `r`. */
  frame(r: PlotRect, c: Rgb): void {
    this.fillRect(r.x - 1, r.y - 1, r.w + 2, 1, c);
    this.fillRect(r.x - 1, r.y + r.h, r.w + 2, 1, c);
    this.fillRect(r.x - 1, r.y, 1, r.h, c);
    this.fillRect(r.x + r.w, r.y, 1, r.h, c);
  }

  /** Bresenham line between integer points with a square brush of `thickness` px. */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness: number): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const off = thickness >> 1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.fillRect(x - off, y - off, thickness, thickness, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Text with its top-left corner at (x, y). */
  text(x: number, y: number, text: string, c: Rgb, scale: number): void {
    const m = textMask(text, scale);
    for (let my = 0; my < m.height; my++) {
      for (let mx = 0; mx < m.width; mx++) if (m.mask[my * m.width + mx] === 1) this.set(x + mx, y + my, c);
    }
  }

  png(): Uint8Array {
    return encodePng(this.width, this.height, this.px);
  }
}

/** Text scale for a figure: 2 (10×14 px glyphs) from 640×360 up, else 1. */
function textScaleFor(width: number, height: number): number {
  return width >= 640 && height >= 360 ? 2 : 1;
}

/** Smallest 1-2-5 × 10ⁿ step that is ≥ `min`. */
function niceStep(min: number): number {
  if (!(min > 0) || !Number.isFinite(min)) return 1;
  const p = 10 ** Math.floor(Math.log10(min));
  for (const m of [1, 2, 5]) if (m * p >= min * (1 - 1e-9)) return m * p;
  return 10 * p;
}

// ───────────────────────────── Spectrogram ─────────────────────────────

/**
 * Spectrogram defaults: figure size, log-frequency axis minHz–maxHz, colour range (dB below the loudest
 * cell), and the analysis window: Hann over the power-of-two length nearest windowS seconds.
 */
export const SPECTROGRAM = { width: 960, height: 540, minHz: 20, maxHz: 12000, rangeDb: 80, windowS: 0.15 } as const;
const SPECTROGRAM_MIN_WIDTH = 128;
const SPECTROGRAM_MIN_HEIGHT = 64;
/** Level of an empty bin (power below 1e-100): far below any colour, never NaN. */
const DB_FLOOR = -1000;
const FREQ_TICKS_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const COLORBAR_TICKS_DB = [0, -20, -40, -60, -80];

export interface SpectrogramLayout {
  /** Text scale (glyph dot size in px). */
  scale: number;
  /** Data area: plot.w time columns × plot.h frequency rows. */
  plot: PlotRect;
  colorbar: PlotRect;
}

/** Figure geometry of a width × height spectrogram (throws RangeError below 128 × 64 or for non-integers). */
export function spectrogramLayout(width: number, height: number): SpectrogramLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < SPECTROGRAM_MIN_WIDTH || height < SPECTROGRAM_MIN_HEIGHT) {
    throw new RangeError(
      `spectrogramPng: size must be integers ≥ ${SPECTROGRAM_MIN_WIDTH}×${SPECTROGRAM_MIN_HEIGHT}, got ${width}×${height}`,
    );
  }
  const s = textScaleFor(width, height);
  const plot = { x: 24 * s, y: 15 * s, w: width - 54 * s, h: height - 30 * s };
  return { scale: s, plot, colorbar: { x: plot.x + plot.w + 4 * s, y: plot.y, w: 5 * s, h: plot.h } };
}

/**
 * Short-time spectrum on log-frequency rows. Row r (0 = top) covers [minHz·R^(1−(r+1)/rows), minHz·R^(1−r/rows))
 * with R = maxHz/minHz and holds the loudest FFT bin inside it (linear interpolation in dB at the row's
 * centre frequency where the row is narrower than a bin), so a tone keeps its level at every frequency.
 * Column c is the frame centred on sample round((c + 0.5)/cols · n), zero outside the signal. The signal's
 * mean is removed first so a DC offset cannot leak into the lowest rows. Rows whose centre is at or above
 * Nyquist have no data.
 */
function logFrequencySpectrum(
  x: ArrayLike<number>,
  fs: number,
  cols: number,
  rows: number,
  maxHz: number,
): { db: Float64Array; hasData: Uint8Array; maxDb: number } {
  const n = x.length;
  const sig = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i] ?? 0;
    if (!Number.isFinite(v)) throw new RangeError(`spectrogramPng: non-finite sample ${v} at index ${i}`);
    sig[i] = v;
    sum += v;
  }
  const mean = n > 0 ? sum / n : 0;
  for (let i = 0; i < n; i++) sig[i] = (sig[i] ?? 0) - mean;

  const size = Math.max(16, 2 ** Math.round(Math.log2(SPECTROGRAM.windowS * fs)));
  const half = size / 2;
  const df = fs / size;
  const lnRatio = Math.log(maxHz / SPECTROGRAM.minHz);
  const edgeHz = (e: number): number => SPECTROGRAM.minHz * Math.exp(lnRatio * (1 - e / rows));
  const kLo = new Int32Array(rows);
  const kHi = new Int32Array(rows);
  const kCentre = new Float64Array(rows);
  const hasData = new Uint8Array(rows);
  let kNeed = 0;
  for (let r = 0; r < rows; r++) {
    const fc = edgeHz(r + 0.5);
    if (fc >= fs / 2) continue;
    hasData[r] = 1;
    const lo = Math.ceil(edgeHz(r + 1) / df);
    const hi = Math.min(half, Math.ceil(edgeHz(r) / df) - 1);
    kLo[r] = lo;
    kHi[r] = hi;
    kCentre[r] = fc / df;
    kNeed = Math.max(kNeed, lo <= hi ? hi : Math.floor(fc / df) + 1);
  }
  kNeed = Math.min(half, kNeed);

  const win = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const binDb = new Float64Array(kNeed + 1);
  const db = new Float64Array(rows * cols).fill(DB_FLOOR);
  let maxDb = DB_FLOOR;
  for (let c = 0; c < cols; c++) {
    const start = Math.round(((c + 0.5) / cols) * n) - half;
    for (let i = 0; i < size; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < n ? (sig[j] ?? 0) * (win[i] ?? 0) : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= kNeed; k++) {
      const p = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
      binDb[k] = p > 1e-100 ? 10 * Math.log10(p) : DB_FLOOR;
    }
    for (let r = 0; r < rows; r++) {
      if (hasData[r] !== 1) continue;
      const lo = kLo[r] ?? 0;
      const hi = kHi[r] ?? 0;
      let v = DB_FLOOR;
      if (lo <= hi) {
        for (let k = lo; k <= hi; k++) v = Math.max(v, binDb[k] ?? DB_FLOOR);
      } else {
        const kc = kCentre[r] ?? 0;
        const k0 = Math.floor(kc);
        const frac = kc - k0;
        v = (binDb[k0] ?? DB_FLOOR) * (1 - frac) + (binDb[k0 + 1] ?? DB_FLOOR) * frac;
      }
      db[r * cols + c] = v;
      if (v > maxDb) maxDb = v;
    }
  }
  return { db, hasData, maxDb };
}

/**
 * Spectrogram figure (contract T4): time on x, log frequency 20 Hz–maxHz (default 12 kHz) on y, colour =
 * level in dB re the loudest cell over an 80 dB range through the perceptual colormap (silence draws the
 * floor colour), with frequency/time/dB labels and a colour bar. Rows above Nyquist draw PLOT_COLORS.noData.
 * Throws RangeError on non-finite samples or invalid parameters.
 */
export function spectrogramPng(
  x: ArrayLike<number>,
  fs: number,
  opts: { width?: number; height?: number; maxHz?: number } = {},
): Uint8Array {
  const width = opts.width ?? SPECTROGRAM.width;
  const height = opts.height ?? SPECTROGRAM.height;
  const maxHz = opts.maxHz ?? SPECTROGRAM.maxHz;
  if (!(fs > 0) || !Number.isFinite(fs)) throw new RangeError(`spectrogramPng: invalid sample rate ${fs}`);
  if (!(maxHz > SPECTROGRAM.minHz) || !Number.isFinite(maxHz)) {
    throw new RangeError(`spectrogramPng: maxHz must be finite and above ${SPECTROGRAM.minHz} Hz, got ${maxHz}`);
  }
  const { scale: s, plot, colorbar } = spectrogramLayout(width, height);
  const { db, hasData, maxDb } = logFrequencySpectrum(x, fs, plot.w, plot.h, maxHz);
  const range = SPECTROGRAM.rangeDb;
  const silent = maxDb <= DB_FLOOR;
  const cv = new Canvas(width, height, PLOT_COLORS.background);
  for (let r = 0; r < plot.h; r++) {
    for (let c = 0; c < plot.w; c++) {
      const v = db[r * plot.w + c] ?? DB_FLOOR;
      const color = hasData[r] !== 1 ? PLOT_COLORS.noData : colormap(silent ? 0 : (v - maxDb + range) / range);
      cv.set(plot.x + c, plot.y + r, color);
    }
  }
  cv.frame(plot, PLOT_COLORS.frame);
  for (let y = 0; y < colorbar.h; y++) {
    cv.fillRect(colorbar.x, colorbar.y + y, colorbar.w, 1, colormap(colorbar.h > 1 ? 1 - y / (colorbar.h - 1) : 1));
  }
  cv.frame(colorbar, PLOT_COLORS.frame);

  const glyphH = GLYPH_H * s;
  // Frequency axis: ticks on the row holding each frequency; labels bottom-up, skipping any that would overlap.
  const labelRight = plot.x - 1 - 5 * s;
  const lnRatio = Math.log(maxHz / SPECTROGRAM.minHz);
  let lastTop = Number.POSITIVE_INFINITY;
  for (const f of FREQ_TICKS_HZ) {
    if (f > maxHz) break;
    const e = plot.h * (1 - Math.log(f / SPECTROGRAM.minHz) / lnRatio);
    const y = plot.y + Math.min(plot.h - 1, Math.floor(e));
    cv.fillRect(plot.x - 1 - 3 * s, y, 3 * s, 1, PLOT_COLORS.frame);
    const label = f >= 1000 ? `${f / 1000}K` : `${f}`;
    const top = y - Math.floor(glyphH / 2);
    if (top + glyphH + s > lastTop) continue;
    cv.text(labelRight - textWidth(label, s), top, label, PLOT_COLORS.text, s);
    lastTop = top;
  }
  cv.text(labelRight - textWidth('HZ', s), 2 * s, 'HZ', PLOT_COLORS.text, s);

  // Time axis: 1-2-5 steps at least one label width apart; the first label starts at its tick.
  const dur = x.length / fs;
  const tickTop = plot.y + plot.h + 1;
  const step = niceStep(((textWidth('000.0S', s) + 6 * s) / plot.w) * dur);
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const ticks = dur > 0 ? Math.floor(dur / step + 1e-9) : 0;
  for (let k = 0; k <= ticks; k++) {
    const t = k * step;
    const tx = plot.x + (dur > 0 ? Math.round((t / dur) * plot.w) : 0);
    cv.fillRect(tx, tickTop, 1, 3 * s, PLOT_COLORS.frame);
    const label = `${t.toFixed(decimals)}S`;
    const w = textWidth(label, s);
    const lx = k === 0 ? tx : Math.min(width - w, tx - Math.floor(w / 2));
    cv.text(lx, tickTop + 5 * s, label, PLOT_COLORS.text, s);
  }

  // Colour bar: dB re the loudest cell.
  const barRight = colorbar.x + colorbar.w + 1;
  let lastBottom = Number.NEGATIVE_INFINITY;
  for (const level of COLORBAR_TICKS_DB) {
    const y = colorbar.y + Math.round((-level / range) * (colorbar.h - 1));
    cv.fillRect(barRight, y, 2 * s, 1, PLOT_COLORS.frame);
    const top = y - Math.floor(glyphH / 2);
    if (top < lastBottom + s) continue;
    cv.text(barRight + 3 * s, top, `${level}`, PLOT_COLORS.text, s);
    lastBottom = top + glyphH;
  }
  cv.text(barRight + 3 * s, 2 * s, 'DB', PLOT_COLORS.text, s);
  return cv.png();
}
