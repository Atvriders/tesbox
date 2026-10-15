/**
 * PNG plots for the score CLI (phase 2b contract T4, spec §11.3). Node only.
 *
 * encodePng: in-house PNG writer (RFC 2083) — signature, IHDR (8-bit RGBA, no interlace), IDAT
 * (scanlines with filter type 0, compressed into a zlib stream (RFC 1950) by node:zlib deflateSync,
 * split into chunks of at most IDAT_CHUNK bytes), IEND; chunk CRCs from the table-driven CRC-32 below.
 * spectrogramPng: log-frequency spectrogram of a signal. orderPlotPng: order profiles of several clips in one 500 rpm
 * bin, the one with the most frames common to the render and the references (amendment D7, orderPlotBin). Both draw
 * on a shared dark-theme raster with a 5×7 bitmap font.
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

/**
 * Figure colours (dark theme, shared by both plots). Text inks keep WCAG contrast ≥ 4.5:1 on background and panel:
 * text (primary) ≈ 12:1, dim (secondary) ≈ 5:1; grid is a recessive hairline one step off the panel.
 */
export const PLOT_COLORS = {
  background: [22, 22, 26],
  panel: [32, 32, 38],
  grid: [54, 54, 62],
  frame: [124, 124, 136],
  text: [214, 214, 220],
  dim: [144, 144, 154],
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
  /** Frequency labels end at this x (right-aligned), each vertically centred on its tick row. */
  freqLabelRight: number;
  /** Top row of the time labels (their x: spectrogramTimeLabels); the ticks hang 3·scale px below the plot frame. */
  timeLabelTop: number;
  /** Colour-bar (dB) labels start at this x, each vertically centred on its tick row. */
  dbLabelX: number;
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
  const colorbar = { x: plot.x + plot.w + 4 * s, y: plot.y, w: 5 * s, h: plot.h };
  return {
    scale: s,
    plot,
    colorbar,
    freqLabelRight: plot.x - 1 - 5 * s,
    timeLabelTop: plot.y + plot.h + 1 + 5 * s,
    dbLabelX: colorbar.x + colorbar.w + 1 + 3 * s,
  };
}

/** One tick of a spectrogram's time axis and its label. */
export interface TimeLabel {
  /** Time of the tick (s). */
  t: number;
  /** Column of the tick. */
  tickX: number;
  /** t with the step's decimals and "S" for seconds. */
  text: string;
  /** Left edge of the label. */
  x: number;
}

/** Least gap between neighbouring time labels, in text-scale units: one character cell. */
const TIME_LABEL_GAP = GLYPH_ADVANCE;

/** Time labels at t = k·step up to durationS: the first starts at its tick, the others are centred on theirs. */
function timeLabelsAt(durationS: number, step: number, layout: SpectrogramLayout, width: number): TimeLabel[] {
  const { scale: s, plot } = layout;
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const ticks = durationS > 0 ? Math.floor(durationS / step + 1e-9) : 0;
  const labels: TimeLabel[] = [];
  for (let k = 0; k <= ticks; k++) {
    const t = k * step;
    const tickX = plot.x + (durationS > 0 ? Math.round((t / durationS) * plot.w) : 0);
    const text = `${t.toFixed(decimals)}S`;
    const w = textWidth(text, s);
    labels.push({ t, tickX, text, x: k === 0 ? tickX : Math.min(width - w, tickX - Math.floor(w / 2)) });
  }
  return labels;
}

/**
 * Time axis of a width × height spectrogram of a durationS-second signal: ticks at plot.x + round(t/durationS · plot.w)
 * for t = k·step up to the duration, each labelled t with the step's decimals and "S". The first label starts at its
 * tick, the others are centred on theirs (moved left where they would leave the figure). The step is the smallest
 * 1-2-5 × 10ⁿ value whose labels all clear their neighbours by a character cell (6·scale px), measured on the labels
 * themselves, so short clips with long labels get a coarser step. Throws RangeError for a negative or non-finite
 * duration, or an invalid size (spectrogramLayout).
 */
export function spectrogramTimeLabels(durationS: number, width: number, height: number): TimeLabel[] {
  const layout = spectrogramLayout(width, height);
  if (!(durationS >= 0) || !Number.isFinite(durationS)) {
    throw new RangeError(`spectrogramTimeLabels: duration must be finite and ≥ 0, got ${durationS}`);
  }
  const { scale: s, plot } = layout;
  const gap = TIME_LABEL_GAP * s;
  const clears = (labels: TimeLabel[]): boolean =>
    labels.every((l, k) => {
      const prev = labels[k - 1];
      return prev === undefined || l.x >= prev.x + textWidth(prev.text, s) + gap;
    });
  // No step can clear with ticks closer than the narrowest label ("0S") plus the gap; from there, 1-2-5 steps up until
  // the labels clear (at the latest when the step exceeds the duration and only the 0 label is left).
  let step = niceStep(((textWidth('0S', s) + gap) / plot.w) * durationS);
  for (;;) {
    const labels = timeLabelsAt(durationS, step, layout, width);
    if (clears(labels)) return labels;
    step = niceStep(step * 1.5);
  }
}

/**
 * Short-time spectrum on log-frequency rows. Row r (0 = top) covers [minHz·R^(1−(r+1)/rows), minHz·R^(1−r/rows))
 * with R = maxHz/minHz and holds the loudest FFT bin inside it (linear interpolation in dB at the row's
 * centre frequency where the row is narrower than a bin), so a tone keeps its level at every frequency.
 * Column c is the window centred on sample round((c + 0.5)/cols · n), moved inward where it would run off the
 * signal: it starts at 0 at the latest and ends at n at the earliest, so a window never sees the step into
 * zero padding (whose broadband splatter would smear the first and last half-window of every clip that does
 * not start and end in silence) and the edge columns repeat the edge windows. Only a signal shorter than the
 * window is zero-padded, every window then holding all of it. The signal's mean is removed first so a DC
 * offset cannot leak into the lowest rows. Rows whose centre is at or above Nyquist have no data.
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
  // Window starts stay in [0, n − size] (or in [n − size, 0] for a signal shorter than the window).
  const startLo = Math.min(0, n - size);
  const startHi = Math.max(0, n - size);
  for (let c = 0; c < cols; c++) {
    const start = Math.min(startHi, Math.max(startLo, Math.round(((c + 0.5) / cols) * n) - half));
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
  const layout = spectrogramLayout(width, height);
  const { scale: s, plot, colorbar } = layout;
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
  const labelRight = layout.freqLabelRight;
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

  // Time axis (spectrogramTimeLabels): each label under a 3-unit tick that hangs below the plot frame.
  const tickTop = plot.y + plot.h + 1;
  for (const l of spectrogramTimeLabels(x.length / fs, width, height)) {
    cv.fillRect(l.tickX, tickTop, 1, 3 * s, PLOT_COLORS.frame);
    cv.text(l.x, layout.timeLabelTop, l.text, PLOT_COLORS.text, s);
  }

  // Colour bar: dB re the loudest cell.
  const barRight = colorbar.x + colorbar.w + 1;
  let lastBottom = Number.NEGATIVE_INFINITY;
  for (const level of COLORBAR_TICKS_DB) {
    const y = colorbar.y + Math.round((-level / range) * (colorbar.h - 1));
    cv.fillRect(barRight, y, 2 * s, 1, PLOT_COLORS.frame);
    const top = y - Math.floor(glyphH / 2);
    if (top < lastBottom + s) continue;
    cv.text(layout.dbLabelX, top, `${level}`, PLOT_COLORS.text, s);
    lastBottom = top + glyphH;
  }
  cv.text(layout.dbLabelX, 2 * s, 'DB', PLOT_COLORS.text, s);
  return cv.png();
}

// ───────────────────────────── Order plot ─────────────────────────────

/**
 * Order-plot defaults: figure size; binRpm, the width of the rpm bins, centred on its multiples as src/lab/compare.ts
 * bins frames (RPM_BIN; the bin of c rpm holds [c − binRpm/2, c + binRpm/2)) — which bin is plotted is chosen per
 * figure (orderPlotBin, amendment D7); the order axis 0 … maxOrder (orderAmp entry i is order (i + 1)·step for
 * i < floor(maxOrder/step), as in FrameFeatures.orderAmp); the level axis from 0 dB (each series' strongest order) down
 * to −rangeDb; maxSeries, the most series drawn, one per categorical colour (never cycled) — the legend counts any
 * further series.
 */
export const ORDER_PLOT = { width: 960, height: 540, binRpm: 500, maxOrder: 12, rangeDb: 60, maxSeries: 8 } as const;
const ORDER_PLOT_MIN_WIDTH = 400;
const ORDER_PLOT_MIN_HEIGHT = 240;
/** Level gridline spacing (dB). */
const LEVEL_GRID_DB = 10;
/** Order-axis label spacings, tried in turn until neighbouring labels clear each other. */
const ORDER_LABEL_STEPS = [1, 2, 3, 4, 6, 12];
/** Legend text per row, in character cells: the label, a space, then the right-aligned frame count. */
const LEGEND_CHARS = 20;
/** Legend key (a line through the series marker) width, in text-scale units. */
const LEGEND_KEY_W = 14;
/** Data marks, in px: line width, marker size (odd, so it has a centre pixel), surface ring around each marker. */
const LINE_PX = 2;
const MARKER_PX = 9;
const MARKER_RING_PX = 2;
/** Gap between the panel edge and the data area, so edge markers and their rings stay on the panel. */
const DATA_INSET = (MARKER_PX - 1) / 2 + MARKER_RING_PX;

/**
 * Series colours in their fixed slot order (blue, orange, aqua, yellow, magenta, green, violet, red): the dark-surface
 * steps of an 8-hue categorical palette, validated on PLOT_COLORS.panel and .background for the OKLCH lightness band
 * and chroma floor, adjacent-pair separation under simulated protanopia/deuteranopia (OKLab ΔE ≥ 8) and in normal
 * vision (ΔE ≥ 15), and ≥ 3:1 contrast. Series i always takes slot i, so it keeps its colour whatever the others hold.
 */
export const SERIES_COLORS: readonly Rgb[] = [
  [57, 135, 229],
  [217, 89, 38],
  [25, 158, 112],
  [201, 133, 0],
  [213, 81, 129],
  [0, 131, 0],
  [144, 133, 233],
  [230, 103, 103],
];

/**
 * Series markers: 9×9 dot matrices drawn for this project ("#" = ink), one shape per colour slot — square, disk,
 * triangle up, diamond, triangle down, plus, cross, hollow square — so a series is never told apart by colour alone.
 */
const MARKER_ROWS = [
  '.........|.#######.|.#######.|.#######.|.#######.|.#######.|.#######.|.#######.|.........',
  '...###...|.#######.|.#######.|#########|#########|#########|.#######.|.#######.|...###...',
  '....#....|...###...|...###...|..#####..|..#####..|.#######.|.#######.|#########|#########',
  '....#....|...###...|..#####..|.#######.|#########|.#######.|..#####..|...###...|....#....',
  '#########|#########|.#######.|.#######.|..#####..|..#####..|...###...|...###...|....#....',
  '...###...|...###...|...###...|#########|#########|#########|...###...|...###...|...###...',
  '##.....##|###...###|.###.###.|..#####..|...###...|..#####..|.###.###.|###...###|##.....##',
  '#########|#########|##.....##|##.....##|##.....##|##.....##|##.....##|#########|#########',
];

interface Marker {
  /** Ink cells as [dx, dy] offsets from the centre. */
  ink: [number, number][];
  /** Ring cells: within MARKER_RING_PX (Euclidean) of an ink cell, not ink themselves. */
  ring: [number, number][];
}

const MARKERS = MARKER_ROWS.map((spec, slot): Marker => {
  const rows = spec.split('|');
  if (rows.length !== MARKER_PX || rows.some((r) => r.length !== MARKER_PX || !/^[.#]+$/.test(r))) {
    throw new Error(`png: malformed marker ${slot}`);
  }
  const c = (MARKER_PX - 1) / 2;
  const ink: [number, number][] = [];
  rows.forEach((r, y) => {
    for (let x = 0; x < MARKER_PX; x++) if (r[x] === '#') ink.push([x - c, y - c]);
  });
  const isInk = new Set(ink.map(([x, y]) => `${x},${y}`));
  const ring = new Map<string, [number, number]>();
  const R = MARKER_RING_PX;
  for (const [x, y] of ink) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const key = `${x + dx},${y + dy}`;
        if (dx * dx + dy * dy <= R * R && !isInk.has(key)) ring.set(key, [x + dx, y + dy]);
      }
    }
  }
  return { ink, ring: [...ring.values()] };
});

/** Ink mask of the marker of colour slot `slot` (0 … maxSeries − 1): 9×9, row-major, 1 = ink. A fresh copy. */
export function markerMask(slot: number): Uint8Array {
  const marker = Number.isInteger(slot) ? MARKERS[slot] : undefined;
  if (marker === undefined) throw new RangeError(`markerMask: no marker for slot ${slot}`);
  const c = (MARKER_PX - 1) / 2;
  const mask = new Uint8Array(MARKER_PX * MARKER_PX);
  for (const [x, y] of marker.ink) mask[(y + c) * MARKER_PX + x + c] = 1;
  return mask;
}

/** Marker of slot `slot` centred on (cx, cy): its ring in the colour of the surface beneath, then its ink. */
function drawMarker(cv: Canvas, slot: number, cx: number, cy: number, c: Rgb, surface: Rgb): void {
  const marker = MARKERS[slot];
  if (marker === undefined) return;
  for (const [dx, dy] of marker.ring) cv.set(cx + dx, cy + dy, surface);
  for (const [dx, dy] of marker.ink) cv.set(cx + dx, cy + dy, c);
}

/** Which side of the comparison an order-plot series is (amendment D7): the render, or a reference recording. */
export type OrderSeriesRole = 'render' | 'reference';

/** One order-plot series: per frame its rpm and orderAmp row (FrameFeatures.rpm and .orderAmp). */
export interface OrderSeries {
  label: string;
  rpm: ArrayLike<number>;
  orderAmp: ArrayLike<ArrayLike<number>>;
  /** The render or a reference (orderPlotBin compares the two); without a role a series only counts toward the fallback. */
  role?: OrderSeriesRole;
}

/** A series' order profile at the plotted rpm bin. */
export interface OrderProfile {
  /** Frames whose rpm lies in the bin. */
  frames: number;
  /** Order of each entry: (i + 1)·step. */
  orders: number[];
  /**
   * Mean orderAmp of those frames in dB re its largest entry (0 dB; −Infinity where the mean is 0); empty when no
   * frame is in the bin or all of them are silent.
   */
  levelDb: number[];
}

/** Number of plotted orders k·step, k = 1 … floor(maxOrder/step) (the count orderSpectrum produces). */
function orderCount(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError(`order plot: step must be finite and > 0, got ${step}`);
  const n = Math.floor(ORDER_PLOT.maxOrder / step + 1e-9);
  if (n < 1) throw new RangeError(`order plot: step ${step} leaves no order up to ${ORDER_PLOT.maxOrder}`);
  return n;
}

/**
 * Index k of the rpm bin holding a frame of `rpm` — bin k holds [k·binRpm − binRpm/2, k·binRpm + binRpm/2), the
 * formula of src/lab/compare.ts binIndex — or null for a frame without an rpm > 0, which (as in the scoring) is in no
 * bin. Bin choice (orderPlotBin) and profile (orderProfile) both go through here, so they count the same frames.
 */
function rpmBinIndex(rpm: number): number | null {
  return rpm > 0 ? Math.floor((rpm + ORDER_PLOT.binRpm / 2) / ORDER_PLOT.binRpm) : null;
}

/**
 * Order profile of `series` in the 500 rpm bin centred on `binRpm` (a multiple of ORDER_PLOT.binRpm, else
 * RangeError; null: no bin, no frame is in it): the arithmetic mean of the orderAmp rows of the frames in the bin —
 * the mean the orderProfile metric compares — in dB re its strongest order. Every frame is validated, in the bin or
 * not (RangeError): one finite rpm per row, floor(maxOrder/step) entries per row, finite non-negative amplitudes.
 */
export function orderProfile(series: OrderSeries, step: number, binRpm: number | null): OrderProfile {
  const n = orderCount(step);
  const bin = binRpm === null ? null : binRpm / ORDER_PLOT.binRpm;
  if (bin !== null && !Number.isInteger(bin)) {
    throw new RangeError(`order plot: bin centre ${binRpm} rpm is not a multiple of ${ORDER_PLOT.binRpm} rpm`);
  }
  const { label, rpm, orderAmp } = series;
  if (rpm.length !== orderAmp.length) {
    throw new RangeError(`order plot: series "${label}" has ${rpm.length} rpm values for ${orderAmp.length} orderAmp rows`);
  }
  const sum = new Float64Array(n);
  let frames = 0;
  for (let f = 0; f < rpm.length; f++) {
    const r = rpm[f] ?? Number.NaN;
    const row = orderAmp[f];
    if (!Number.isFinite(r)) throw new RangeError(`order plot: series "${label}" frame ${f} has rpm ${r}`);
    if (row === undefined || row.length !== n) {
      throw new RangeError(`order plot: series "${label}" frame ${f} has ${row?.length ?? 0} orders; step ${step} gives ${n}`);
    }
    for (let i = 0; i < n; i++) {
      const a = row[i] ?? Number.NaN;
      if (!(a >= 0) || !Number.isFinite(a)) {
        throw new RangeError(`order plot: series "${label}" frame ${f} has amplitude ${a} at order ${(i + 1) * step}`);
      }
    }
    if (bin === null || rpmBinIndex(r) !== bin) continue;
    frames++;
    for (let i = 0; i < n; i++) sum[i] = (sum[i] ?? 0) + (row[i] ?? 0);
  }
  let max = 0;
  for (const v of sum) max = Math.max(max, v);
  return {
    frames,
    orders: Array.from({ length: n }, (_, i) => (i + 1) * step),
    levelDb: max > 0 ? Array.from(sum, (v) => 20 * Math.log10(v / max)) : [],
  };
}

/** The rpm bin an order plot shows (amendment D7, orderPlotBin). */
export interface OrderBin {
  /** Centre, a multiple of ORDER_PLOT.binRpm. */
  rpm: number;
  /** The bin is [lo, hi) = [rpm − binRpm/2, rpm + binRpm/2). */
  lo: number;
  hi: number;
  /** Frames in the bin of the render series and of the reference series. */
  renderFrames: number;
  referenceFrames: number;
  /**
   * Frames common to the render and the references: min(renderFrames, referenceFrames), the count D7 maximises; 0
   * when no bin holds both (the bin is then the fallback).
   */
  commonFrames: number;
  /** Frames in the bin of every series, with or without a role. */
  frames: number;
}

/**
 * The bin an order plot shows (amendment D7): of the 500 rpm bins (centred on multiples of ORDER_PLOT.binRpm, as the
 * scoring bins frames), the one with the most frames common to the render and the references — per bin the smaller of
 * the render series' and the reference series' frame counts, the frames the two sides can be matched on one to one —
 * ties going to the lower rpm. When no bin holds both (no render or no reference series, or no overlap), the bin with
 * the most frames of all series, ties again to the lower rpm. Every series counts, drawn or not; a frame without an
 * rpm > 0 is in no bin. null when no series has a frame in any bin. Throws RangeError on a non-finite rpm.
 */
export function orderPlotBin(series: readonly OrderSeries[]): OrderBin | null {
  const counts = new Map<number, { render: number; reference: number; all: number }>();
  for (const s of series) {
    for (let f = 0; f < s.rpm.length; f++) {
      const r = s.rpm[f] ?? Number.NaN;
      if (!Number.isFinite(r)) throw new RangeError(`order plot: series "${s.label}" frame ${f} has rpm ${r}`);
      const k = rpmBinIndex(r);
      if (k === null) continue;
      const c = counts.get(k) ?? { render: 0, reference: 0, all: 0 };
      c.all++;
      if (s.role === 'render') c.render++;
      else if (s.role === 'reference') c.reference++;
      counts.set(k, c);
    }
  }
  // Ascending bins with a strict ">" keep the lower rpm on ties.
  const bins = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const pick = (score: (c: { render: number; reference: number; all: number }) => number): number | null => {
    let best: number | null = null;
    let bestScore = 0;
    for (const [k, c] of bins) {
      const v = score(c);
      if (v > bestScore) {
        best = k;
        bestScore = v;
      }
    }
    return best;
  };
  const k = pick((c) => Math.min(c.render, c.reference)) ?? pick((c) => c.all);
  const c = k === null ? undefined : counts.get(k);
  if (k === null || c === undefined) return null;
  const w = ORDER_PLOT.binRpm;
  return {
    rpm: k * w,
    lo: k * w - w / 2,
    hi: k * w + w / 2,
    renderFrames: c.render,
    referenceFrames: c.reference,
    commonFrames: Math.min(c.render, c.reference),
    frames: c.all,
  };
}

export interface OrderPlotLayout {
  /** Text scale (glyph dot size in px). */
  scale: number;
  /** Panel: the plot's background rectangle; gridlines span it. */
  plot: PlotRect;
  /**
   * Data area inside the panel: order o at column data.x + round(o/maxOrder · (data.w − 1)); level L dB at row
   * data.y + round(clamp(−L/rangeDb, 0, 1) · (data.h − 1)).
   */
  data: PlotRect;
  /**
   * Legend column right of the panel: a header row (the plotted rpm bin at legend.x over the series, FRAMES
   * right-aligned over their frame counts), then row i + 1 for series i (i < maxSeries), then, when there are more
   * series, a row counting them.
   */
  legend: PlotRect;
  /** Height of one legend row (px). */
  legendRowH: number;
  /** Series labels (and the count of series not shown) start at this x in their legend row; the key sits left of it. */
  legendLabelX: number;
  /** Top row of the title, which starts at plot.x. */
  titleTop: number;
  /** Level labels end at this x (right-aligned), each vertically centred on its gridline row. */
  levelLabelRight: number;
  /** Top row of the order labels, each horizontally centred on its gridline column. */
  orderLabelTop: number;
}

/** Figure geometry of a width × height order plot (throws RangeError below 400 × 240 or for non-integers). */
export function orderPlotLayout(width: number, height: number): OrderPlotLayout {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < ORDER_PLOT_MIN_WIDTH || height < ORDER_PLOT_MIN_HEIGHT) {
    throw new RangeError(
      `orderPlotPng: size must be integers ≥ ${ORDER_PLOT_MIN_WIDTH}×${ORDER_PLOT_MIN_HEIGHT}, got ${width}×${height}`,
    );
  }
  const s = textScaleFor(width, height);
  const legendW = (LEGEND_KEY_W + 4) * s + (LEGEND_CHARS * GLYPH_ADVANCE - 1) * s;
  const plot = { x: 24 * s, y: 25 * s, w: width - 40 * s - legendW, h: height - 40 * s };
  const data = { x: plot.x + DATA_INSET, y: plot.y + DATA_INSET, w: plot.w - 2 * DATA_INSET, h: plot.h - 2 * DATA_INSET };
  const legend = { x: plot.x + plot.w + 12 * s, y: plot.y, w: legendW, h: plot.h };
  return {
    scale: s,
    plot,
    data,
    legend,
    legendRowH: 11 * s,
    legendLabelX: legend.x + (LEGEND_KEY_W + 4) * s,
    titleTop: 3 * s,
    levelLabelRight: plot.x - 1 - 5 * s,
    orderLabelTop: plot.y + plot.h + 5 * s,
  };
}

/**
 * `text` in at most `cells` character cells: when too long, its middle becomes "..." so both the start and the
 * end survive (clip names tend to differ at the end, e.g. "…-onboard-a" / "…-onboard-b").
 */
function fitText(text: string, cells: number): string {
  const chars = [...text];
  if (chars.length <= cells) return text;
  const keep = Math.max(0, cells - 3);
  const tail = Math.floor(keep / 2);
  return `${chars.slice(0, keep - tail).join('')}...${tail > 0 ? chars.slice(-tail).join('') : ''}`;
}

/**
 * Order plot (contract T4, amendment D7): each series' order profile (orderProfile) in the bin orderPlotBin picks —
 * the 500 rpm bin with the most frames common to the render and the reference series, ties to the lower rpm — with
 * order on x (0 … 12), level in dB re the series' strongest order on y (0 … −60 dB; lower levels and silent orders sit
 * on the axis floor), as a 2 px line through a marker at every order. Series i takes colour and marker slot i; series
 * 0 is drawn on top. The title names the bin ("ORDERS AT 4500 RPM (4250-4750)"), followed by NO COMMON BIN in
 * secondary ink when the series have roles but no bin holds both render and reference frames (the bin is then
 * orderPlotBin's fallback), or reads ORDERS (NO FRAMES) when no series has a frame. The legend's header row repeats
 * the bin ("4250-4750 RPM", NO RPM BIN without one) over the series and FRAMES over the counts; below it each series
 * drawn with its key, its label and the number of frames averaged (0 when none is in the bin, SILENT when they are all
 * zero); the data area reads NO DATA when no series drawn has a profile. Only the first maxSeries series are drawn
 * (there is one colour and marker per slot), though all of them count toward the bin; a last legend row, "+N MORE NOT
 * SHOWN" in secondary ink at legendLabelX, counts the others. Throws RangeError for an invalid step or size, or an
 * invalid series (see orderProfile, orderPlotBin) — drawn or not.
 */
export function orderPlotPng(
  series: readonly OrderSeries[],
  step: number,
  opts: { width?: number; height?: number } = {},
): Uint8Array {
  const width = opts.width ?? ORDER_PLOT.width;
  const height = opts.height ?? ORDER_PLOT.height;
  const layout = orderPlotLayout(width, height);
  const { scale: s, plot, data, legend, legendRowH } = layout;
  orderCount(step);
  const bin = orderPlotBin(series);
  // Every series is validated; the first maxSeries are drawn (one per colour slot) and the legend counts the rest.
  const profiles = series.map((ser) => orderProfile(ser, step, bin?.rpm ?? null)).slice(0, ORDER_PLOT.maxSeries);
  const notShown = series.length - profiles.length;
  const range = ORDER_PLOT.rangeDb;
  const xOf = (order: number): number => data.x + Math.round((order / ORDER_PLOT.maxOrder) * (data.w - 1));
  const yOf = (db: number): number => data.y + Math.round(Math.min(1, Math.max(0, -db / range)) * (data.h - 1));
  const colorOf = (k: number): Rgb => SERIES_COLORS[k] ?? PLOT_COLORS.text;

  const cv = new Canvas(width, height, PLOT_COLORS.background);
  cv.fillRect(plot.x, plot.y, plot.w, plot.h, PLOT_COLORS.panel);
  for (let db = 0; db >= -range; db -= LEVEL_GRID_DB) cv.fillRect(plot.x, yOf(db), plot.w, 1, PLOT_COLORS.grid);
  for (let o = 0; o <= ORDER_PLOT.maxOrder; o++) cv.fillRect(xOf(o), plot.y, 1, plot.h, PLOT_COLORS.grid);

  // Lines, then markers with panel-coloured rings; the last series first, so series 0 ends on top.
  const points = profiles.map((p) => p.levelDb.map((db, i): [number, number] => [xOf(p.orders[i] ?? 0), yOf(db)]));
  for (let k = points.length - 1; k >= 0; k--) {
    const pts = points[k] ?? [];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1] ?? [0, 0];
      const [x1, y1] = pts[i] ?? [0, 0];
      cv.line(x0, y0, x1, y1, colorOf(k), LINE_PX);
    }
  }
  for (let k = points.length - 1; k >= 0; k--) {
    for (const [x, y] of points[k] ?? []) drawMarker(cv, k, x, y, colorOf(k), PLOT_COLORS.panel);
  }
  const glyphH = GLYPH_H * s;
  if (profiles.every((p) => p.levelDb.length === 0)) {
    const msg = 'NO DATA';
    const mx = data.x + Math.floor((data.w - textWidth(msg, s)) / 2);
    cv.text(mx, data.y + Math.floor((data.h - glyphH) / 2), msg, PLOT_COLORS.dim, s);
  }

  // Level axis: a tick and label every 10 dB; above them the unit, read on as the level reference.
  const labelRight = layout.levelLabelRight;
  for (let db = 0; db >= -range; db -= LEVEL_GRID_DB) {
    const y = yOf(db);
    cv.fillRect(plot.x - 3 * s, y, 3 * s, 1, PLOT_COLORS.frame);
    cv.text(labelRight - textWidth(`${db}`, s), y - Math.floor(glyphH / 2), `${db}`, PLOT_COLORS.text, s);
  }
  const unitX = labelRight - textWidth('DB', s);
  cv.text(unitX, 13 * s, 'DB', PLOT_COLORS.text, s);
  cv.text(unitX + 3 * GLYPH_ADVANCE * s, 13 * s, 'RE STRONGEST ORDER OF EACH SERIES', PLOT_COLORS.dim, s);

  // Order axis: integer orders, labelled at the smallest spacing whose labels clear each other; title at its end.
  const perOrder = (data.w - 1) / ORDER_PLOT.maxOrder;
  const every = ORDER_LABEL_STEPS.find((k) => k * perOrder >= textWidth('12', s) + 4 * s) ?? ORDER_PLOT.maxOrder;
  const tickTop = plot.y + plot.h;
  for (let o = 0; o <= ORDER_PLOT.maxOrder; o += every) {
    const x = xOf(o);
    cv.fillRect(x, tickTop, 1, 3 * s, PLOT_COLORS.frame);
    cv.text(x - Math.floor(textWidth(`${o}`, s) / 2), layout.orderLabelTop, `${o}`, PLOT_COLORS.text, s);
  }
  cv.text(plot.x + plot.w + 8 * s, layout.orderLabelTop, 'ORDER', PLOT_COLORS.text, s);

  // Title: the plotted bin (amendment D7); a note when the series have sides but no bin holds both.
  const title = bin === null ? 'ORDERS (NO FRAMES)' : `ORDERS AT ${bin.rpm} RPM (${bin.lo}-${bin.hi})`;
  cv.text(plot.x, layout.titleTop, title, PLOT_COLORS.text, s);
  if (bin !== null && bin.commonFrames === 0 && series.some((ser) => ser.role !== undefined)) {
    cv.text(plot.x + (textLength(title) + 1) * GLYPH_ADVANCE * s, layout.titleTop, 'NO COMMON BIN', PLOT_COLORS.dim, s);
  }

  // Legend: a header (the bin over the series, FRAMES over the counts), then per series its key (line through the
  // marker), label and frame count.
  const right = legend.x + legend.w;
  if (series.length > 0) {
    const framesW = textWidth('FRAMES', s);
    // the bin label keeps a character cell clear of FRAMES
    const binCells = Math.floor((legend.w - framesW - GLYPH_ADVANCE * s + s) / (GLYPH_ADVANCE * s));
    const binLabel = bin === null ? 'NO RPM BIN' : `${bin.lo}-${bin.hi} RPM`;
    cv.text(legend.x, legend.y, fitText(binLabel, binCells), PLOT_COLORS.text, s);
    cv.text(right - framesW, legend.y, 'FRAMES', PLOT_COLORS.dim, s);
  }
  const keyW = LEGEND_KEY_W * s;
  profiles.forEach((p, k) => {
    const rowY = legend.y + (k + 1) * legendRowH;
    const cy = rowY + Math.floor(glyphH / 2);
    cv.line(legend.x, cy, legend.x + keyW - 1, cy, colorOf(k), LINE_PX);
    drawMarker(cv, k, legend.x + Math.floor(keyW / 2), cy, colorOf(k), PLOT_COLORS.background);
    const count = p.frames === 0 ? '0' : p.levelDb.length === 0 ? 'SILENT' : `${p.frames}`;
    const label = fitText(series[k]?.label ?? '', LEGEND_CHARS - 1 - [...count].length);
    cv.text(layout.legendLabelX, rowY, label, PLOT_COLORS.text, s);
    cv.text(right - textWidth(count, s), rowY, count, PLOT_COLORS.dim, s);
  });
  if (notShown > 0) {
    const note = fitText(`+${notShown} MORE NOT SHOWN`, LEGEND_CHARS);
    cv.text(layout.legendLabelX, legend.y + (profiles.length + 1) * legendRowH, note, PLOT_COLORS.dim, s);
  }
  return cv.png();
}
