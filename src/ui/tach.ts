/**
 * Drive tachometer (phase-3 contract T8; spec §3, §5.7, §10.2 item 4): a canvas-2D dial with a 270°
 * sweep (0 rpm bottom-left, clockwise), numbered every 1000 rpm, a redline arc, a shift light that
 * comes on at 0.95 × redline and a needle that follows the worklet snapshots' rpm.
 *
 * Intel MCU2 (weak GPU, memory pressure): the backing store stays at 1 × CSS pixels and the dial is
 * redrawn at most 30 times a second; elsewhere it follows devicePixelRatio (≤ 2×) at the display rate.
 * The rules follow the detected MCU whatever the audio tier (spec §5.7). The static face (ticks,
 * numbers, redline arc) is drawn once per size or engine into an offscreen canvas and blitted, so a
 * frame costs one image copy plus the needle; a frame whose needle and lamp have not moved is skipped.
 *
 * Geometry and the frame cap are pure functions (tests/unit/tach.test.ts); mountTach() runs the
 * requestAnimationFrame loop against an injectable window.
 */
import { getWebglRenderer, parseMcu, type Mcu } from '../platform/detect';

/** The shift light comes on at this fraction of the redline (contract T8). */
export const SHIFT_LIGHT_FRACTION = 0.95;
/** Intel MCU2 frame cap (spec §3). */
export const INTEL_MAX_FPS = 30;
/** Backing-store cap elsewhere: sharper than this is invisible on a gauge and costs fill rate. */
export const MAX_BACKING_SCALE = 2;
/** Canvas angle (clockwise from 3 o'clock) of 0 rpm: bottom-left. */
export const SWEEP_START = 0.75 * Math.PI;
/** 270° of sweep: full scale ends bottom-right. */
export const SWEEP = 1.5 * Math.PI;

/** Space kept between the dial and its box, CSS px. */
const DIAL_PAD_PX = 4;
/** The dial reaches r above its centre and r·sin 45° below (the open bottom of a 270° sweep). */
const DIAL_HEIGHT_PER_R = 1 + Math.SQRT1_2;
/** Needle smoothing time constant: the ~30 Hz snapshots become continuous motion. */
const NEEDLE_TAU_MS = 50;
/** rAF timestamps jitter; a frame this early still counts as on time. */
const GATE_TOLERANCE_MS = 4;
/** Needle moves smaller than this (rpm) are not worth a redraw. */
const REDRAW_MIN_RPM = 0.5;

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

// ───────────────────────────── Scale and angles ─────────────────────────────

export interface TachScale {
  /** Full scale: the first thousand at least 500 rpm above the redline or limiter. */
  maxRpm: number;
  redline: number;
  majorStepRpm: number;
  minorStepRpm: number;
}

export function tachScale(redline: number, limiterRpm: number): TachScale {
  const top = Math.max(finiteOr(redline, 0), finiteOr(limiterRpm, 0)) + 500;
  return { maxRpm: Math.max(1000, 1000 * Math.ceil(top / 1000)), redline, majorStepRpm: 1000, minorStepRpm: 500 };
}

/** Canvas angle of `rpm`, pinned to the sweep; a non-finite rpm rests at 0. */
export function rpmToAngle(rpm: number, maxRpm: number): number {
  const f = rpm / maxRpm;
  const pinned = Number.isFinite(f) ? Math.min(Math.max(f, 0), 1) : 0;
  return SWEEP_START + SWEEP * pinned;
}

export function shiftLightOn(rpm: number, redline: number): boolean {
  return rpm >= SHIFT_LIGHT_FRACTION * redline;
}

export interface Tick {
  rpm: number;
  angle: number;
  major: boolean;
  /** Thousands ("0" … "9") on major ticks, null on minor ones. */
  label: string | null;
  /** In the redline zone. */
  red: boolean;
}

export function tachTicks(s: TachScale): Tick[] {
  const ticks: Tick[] = [];
  for (let rpm = 0; rpm <= s.maxRpm; rpm += s.minorStepRpm) {
    const major = rpm % s.majorStepRpm === 0;
    ticks.push({
      rpm,
      angle: rpmToAngle(rpm, s.maxRpm),
      major,
      label: major ? String(rpm / 1000) : null,
      red: rpm >= s.redline,
    });
  }
  return ticks;
}

// ───────────────────────────── Layout ─────────────────────────────

export interface DialFit {
  cx: number;
  cy: number;
  /** Outer radius; 0 when the box has no room. */
  r: number;
}

/** The largest 270° dial inside a `width` × `height` CSS-px box, centred both ways. */
export function fitDial(width: number, height: number): DialFit {
  const w = width - 2 * DIAL_PAD_PX;
  const h = height - 2 * DIAL_PAD_PX;
  const r = Math.max(0, Math.min(w / 2, h / DIAL_HEIGHT_PER_R));
  return { cx: width / 2, cy: DIAL_PAD_PX + r + (h - r * DIAL_HEIGHT_PER_R) / 2, r };
}

// ───────────────────────────── Intel rules and the frame cap ─────────────────────────────

/** Backing-store pixels per CSS pixel: 1 on Intel, else the device pixel ratio (1 … MAX_BACKING_SCALE). */
export function backingScale(mcu: Mcu, dpr: number): number {
  if (mcu === 'intel') return 1;
  const ratio = Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  return Math.min(ratio, MAX_BACKING_SCALE);
}

/** Shortest time between two redraws: 1/30 s on Intel, none elsewhere. */
export function minFrameIntervalMs(mcu: Mcu): number {
  return mcu === 'intel' ? 1000 / INTEL_MAX_FPS : 0;
}

/**
 * Decides which requestAnimationFrame callbacks redraw. Each draw books the next slot one interval
 * after the previous slot (not after the frame), so jittery 60 Hz frames still give exactly every
 * other frame and no display rate averages above the cap; a frame up to GATE_TOLERANCE_MS early is
 * on time. After a stall (hidden tab) the schedule restarts from that frame — no catch-up burst.
 */
export class FrameGate {
  private due = Number.NEGATIVE_INFINITY;
  private readonly tolerance: number;

  constructor(private readonly intervalMs: number) {
    this.tolerance = Math.min(GATE_TOLERANCE_MS, intervalMs * 0.15);
  }

  shouldDraw(nowMs: number): boolean {
    if (!(this.intervalMs > 0)) return true;
    if (nowMs < this.due - this.tolerance) return false;
    this.due = nowMs - this.due > this.intervalMs ? nowMs + this.intervalMs : this.due + this.intervalMs;
    return true;
  }
}

/** One-pole step of the shown rpm toward the target over `dtMs` (τ = 50 ms). */
export function smoothRpm(shown: number, target: number, dtMs: number): number {
  if (!Number.isFinite(target)) return shown;
  if (!Number.isFinite(shown)) return target;
  if (!(dtMs > 0)) return shown;
  return shown + (target - shown) * (1 - Math.exp(-dtMs / NEEDLE_TAU_MS));
}

let mcuCache: Mcu | null = null;

/**
 * The MCU guess the canvas rules follow, detected once per page from the WebGL renderer string (a
 * throwaway context, released at once — GPU memory is scarce on MCU2).
 */
export function detectedMcu(): Mcu {
  mcuCache ??= parseMcu(getWebglRenderer());
  return mcuCache;
}

// ───────────────────────────── Drawing ─────────────────────────────

/** Colours; src/ui/drive.tsx passes the theme's custom properties. */
export interface TachPalette {
  track: string;
  dial: string;
  dim: string;
  sweep: string;
  redline: string;
  shift: string;
  lampOff: string;
}

/** The theme.css values, used when the page has none. */
export const DEFAULT_TACH_PALETTE: TachPalette = {
  track: '#2b3440',
  dial: '#eef2f6',
  dim: '#8d99a7',
  sweep: '#ffb21f',
  redline: '#ff4a3d',
  shift: '#3ddc84',
  lampOff: '#1a212b',
};

type Ctx = CanvasRenderingContext2D;

/** The shift lamp: a pill in the open bottom of the dial, below the speed readout. */
function lampPath(g: Ctx, d: DialFit): void {
  const w = 0.44 * d.r;
  const h = 0.08 * d.r;
  const x = d.cx - w / 2;
  const y = d.cy + 0.47 * d.r;
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, h / 2);
  else g.rect(x, y, w, h);
}

function arc(g: Ctx, d: DialFit, radius: number, from: number, to: number): void {
  g.beginPath();
  g.arc(d.cx, d.cy, radius, from, to);
  g.stroke();
}

/** Everything that changes only with the size or the engine. Coordinates in CSS px. */
function drawFace(g: Ctx, d: DialFit, s: TachScale, p: TachPalette, font: string, unitLabel: string): void {
  const { cx, cy, r } = d;
  const ring = 0.95 * r;
  g.lineCap = 'butt';
  g.lineWidth = 0.05 * r;
  g.strokeStyle = p.track;
  arc(g, d, ring, SWEEP_START, SWEEP_START + SWEEP);
  g.globalAlpha = 0.45;
  g.strokeStyle = p.redline;
  arc(g, d, ring, rpmToAngle(s.redline, s.maxRpm), SWEEP_START + SWEEP);
  g.globalAlpha = 1;

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 ${Math.max(10, 0.11 * r)}px ${font}`;
  for (const t of tachTicks(s)) {
    const cos = Math.cos(t.angle);
    const sin = Math.sin(t.angle);
    const inner = (t.major ? 0.8 : 0.85) * r;
    const outer = 0.9 * r;
    g.lineWidth = (t.major ? 0.022 : 0.012) * r;
    g.strokeStyle = t.red ? p.redline : t.major ? p.dial : p.dim;
    g.beginPath();
    g.moveTo(cx + inner * cos, cy + inner * sin);
    g.lineTo(cx + outer * cos, cy + outer * sin);
    g.stroke();
    if (t.label !== null) {
      g.fillStyle = t.red ? p.redline : p.dial;
      g.fillText(t.label, cx + 0.68 * r * cos, cy + 0.68 * r * sin);
    }
  }

  if (unitLabel !== '') {
    g.fillStyle = p.dim;
    g.font = `500 ${Math.max(9, 0.065 * r)}px ${font}`;
    g.fillText(unitLabel, cx, cy + 0.64 * r);
  }
  g.fillStyle = p.lampOff;
  lampPath(g, d);
  g.fill();
}

/** Sweep, needle and lamp for the shown rpm. */
function drawNeedle(g: Ctx, d: DialFit, s: TachScale, p: TachPalette, rpm: number, lamp: boolean): void {
  const { cx, cy, r } = d;
  const ring = 0.95 * r;
  const a = rpmToAngle(rpm, s.maxRpm);
  const red = rpmToAngle(s.redline, s.maxRpm);
  g.lineCap = 'butt';
  g.lineWidth = 0.05 * r;
  if (a > SWEEP_START) {
    g.strokeStyle = p.sweep;
    arc(g, d, ring, SWEEP_START, Math.min(a, red));
    if (a > red) {
      g.strokeStyle = p.redline;
      arc(g, d, ring, red, a);
    }
  }
  // The pointer runs from just outside the numbers to the rim, so it never hides the number it is on.
  g.lineCap = 'round';
  g.lineWidth = 0.04 * r;
  g.strokeStyle = p.dial;
  g.beginPath();
  g.moveTo(cx + 0.75 * r * Math.cos(a), cy + 0.75 * r * Math.sin(a));
  g.lineTo(cx + 0.99 * r * Math.cos(a), cy + 0.99 * r * Math.sin(a));
  g.stroke();
  if (lamp) {
    g.fillStyle = p.shift;
    lampPath(g, d);
    g.fill();
  }
}

// ───────────────────────────── The frame loop ─────────────────────────────

export interface TachModel {
  redline: number;
  limiterRpm: number;
}

/** The parts of `window` the loop uses. */
export interface TachWindow {
  readonly devicePixelRatio: number;
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface TachOptions {
  /** Detected MCU: Intel gets the 1× backing store and the 30 fps cap. */
  mcu: Mcu;
  /** The rpm to show now (0 while the engine is off); read on every drawn frame. */
  rpm(): number;
  /** The engine's redline and limiter; read on every drawn frame (an engine change re-scales the dial). */
  model(): TachModel;
  win?: TachWindow;
  palette?: Partial<TachPalette>;
  /** CSS font-family for the numbers. */
  font?: string;
  /** Caption under the numbers (STR.drive.tachUnit); none by default. */
  unitLabel?: string;
}

/** Starts drawing the tach into `canvas` (sized by CSS); returns the stop function. */
export function mountTach(canvas: HTMLCanvasElement, opts: TachOptions): () => void {
  const win: TachWindow = opts.win ?? window;
  const palette: TachPalette = { ...DEFAULT_TACH_PALETTE, ...opts.palette };
  const font = opts.font ?? 'system-ui, sans-serif';
  const unitLabel = opts.unitLabel ?? '';
  const gate = new FrameGate(minFrameIntervalMs(opts.mcu));
  const ctx = canvas.getContext('2d');
  let face: HTMLCanvasElement | null = null;
  let faceKey = '';
  let shown = Number.NaN;
  let lastT = Number.NaN;
  let drawnKey = '';
  let drawnRpm = Number.NaN;
  let drawnLamp = false;
  let handle = 0;
  let active = true;

  /** Redraws the offscreen face for `key`; null (draw the face on every frame) without a second canvas. */
  const faceFor = (key: string, bw: number, bh: number, scale: number, d: DialFit, s: TachScale): HTMLCanvasElement | null => {
    if (key === faceKey) return face;
    face ??= canvas.ownerDocument.createElement('canvas');
    face.width = bw;
    face.height = bh;
    const g = face.getContext('2d');
    if (g === null) {
      face = null;
      return null;
    }
    g.setTransform(scale, 0, 0, scale, 0, 0);
    drawFace(g, d, s, palette, font, unitLabel);
    faceKey = key;
    return face;
  };

  const draw = (t: number): void => {
    const dt = Number.isFinite(lastT) ? t - lastT : 0;
    lastT = t;
    shown = smoothRpm(shown, opts.rpm(), dt);
    if (ctx === null) return;
    const scale = backingScale(opts.mcu, win.devicePixelRatio);
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const bw = Math.round(cssW * scale);
    const bh = Math.round(cssH * scale);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      drawnKey = '';
    }
    const m = opts.model();
    const s = tachScale(m.redline, m.limiterRpm);
    const key = `${bw}x${bh}@${scale}:${s.maxRpm}:${s.redline}`;
    const rpm = finiteOr(shown, 0);
    const lamp = shiftLightOn(rpm, s.redline);
    if (key === drawnKey && Math.abs(rpm - drawnRpm) < REDRAW_MIN_RPM && lamp === drawnLamp) return;
    drawnKey = key;
    drawnRpm = rpm;
    drawnLamp = lamp;
    const d = fitDial(cssW, cssH);
    const cached = faceFor(key, bw, bh, scale, d, s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    if (d.r <= 0) return;
    if (cached !== null) ctx.drawImage(cached, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (cached === null) drawFace(ctx, d, s, palette, font, unitLabel);
    drawNeedle(ctx, d, s, palette, rpm, lamp);
  };

  const frame = (t: number): void => {
    if (!active) return;
    handle = win.requestAnimationFrame(frame);
    if (gate.shouldDraw(t)) draw(t);
  };

  handle = win.requestAnimationFrame(frame);
  return () => {
    if (!active) return;
    active = false;
    win.cancelAnimationFrame(handle);
  };
}
