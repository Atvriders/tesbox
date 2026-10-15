/**
 * tesbox-score (spec §11.3; phase 2b contract "Score CLI (T5)" with amendments D3 and D4): measures an engine's
 * renders against real recordings of the inspiring car (lab-refs/, local only — never committed or shipped).
 *
 *   tsx tools/score.ts <engine-id> [--refs lab-refs] [--out renders/score] [--gate]
 *
 * 1. References: every <refs>/<engine-id>/<clip>.json sidecar with its <clip>.wav (48 kHz mono, docs/SOUND_LAB.md).
 *    A segment's rpm is its explicit keyframes (linear, never extrapolated), or the pitch track of src/lab/pitch.ts
 *    inside its rpmHint where rpm is "auto" (amendment D4: idle/cruise/limiter hints at most ±15 % around their
 *    centre, wot/liftoff a [low, high] range; unvoiced and low-confidence frames are skipped, confidentTrack). A
 *    segment that cannot be used — a non-finite sample in its span included — is reported with the reason, never
 *    silently dropped, and never aborts the run.
 * 2. Renders: idle, cruise2k/4k/6k, wotPull, liftoff6k (Full tier, tools/render.ts renderSegment, subwoofer on, mono
 *    (L + R)/2) in each perspective that has references, with known rpm: the segment control re-evaluated per
 *    quantum, as the render evaluates it, through the DSP's own RpmState (40 ms tracking lag, shift trajectory).
 *    Only the part of each segment that is in its reference kind is analysed: wotPull without its gear changes and
 *    limiter hold, liftoff6k only its closed-throttle fall in gear (the way docs/SOUND_LAB.md cuts reference
 *    segments).
 * 3. Features (src/lab/features.ts) of every clip through one lens — the scored engine's sub-order step and firing
 *    order — so render, own and other engines' references are measured alike. One ClipFeatures per recording and
 *    kind (a clip's segments of one kind are merged), so ref-vs-ref pairs are independent recordings (spec §11.3:
 *    "the two clips of the same car define the achievable ceiling"). Scored by src/lab/score.ts scoreEngine, the
 *    other engines' references feeding discrimination; fiLine and fiPresence are n/a for naturally aspirated engines
 *    (D3, D8), and steady segments compare over one common 500 rpm bin, sweeps over two (D6).
 * 4. Output in <out>/<engine-id>/ (a previous run's report and plots there are removed first): report.json
 *    (EngineScore, verdict, per-pair details — exactly the pairs the EngineScore averages — and the order plots'
 *    series), report.md, spectrogram-<clip>-<kind><n>.png per used reference segment (n counts the clip's segments
 *    of that kind), spectrogram-render-<segment>-<perspective>.png per render, orders-<perspective>.png (one series
 *    per clip and kind, labelled "<kind> <clip>" / "<kind> render", in the 500 rpm bin with the most frames common to
 *    the render and the references of that perspective, ties to the lower rpm — amendment D7, tools/png.ts
 *    orderPlotBin; the figure's title and legend and report.md name the bin, and report.md lists the series without
 *    frames there, which draw no curve). Deterministic: no clock, no host paths; the same inputs give byte-identical
 *    files.
 *
 * Exit code: 0; 1 (EXIT_GATE_FAILED) with --gate when a metric gate or discrimination fails on a scored engine;
 * 2 (EXIT_USAGE) on usage errors; 3 (EXIT_ERROR) when the run itself fails (e.g. an unwritable --out) — never 1.
 * An engine with fewer than 2 usable reference clips (none at all included) is unscored and exits 0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUANTUM, type DspControl, type EngineDef, type EngineSpec, type Perspective } from '../src/contracts';
import { RpmState } from '../src/dsp/rpm-state';
import { METRIC_NAMES, compareClips, type MetricName, type PairScore } from '../src/lab/compare';
import { clipFeatures, type ClipFeatures, type FrameFeatures } from '../src/lab/features';
import {
  SEGMENT_KINDS,
  STEADY_HINT_MAX,
  STEADY_KINDS,
  interpolateRpm,
  trackOptionsForEngine,
  trackOptionsForSegment,
  trackRpm,
  type RpmTrack,
  type SegmentKind,
} from '../src/lab/pitch';
import { compareOptionsFor, scoreEngine, type EngineScore } from '../src/lab/score';
import { ORDER_PLOT, orderPlotBin, orderPlotPng, orderProfile, spectrogramPng, type OrderSeries, type OrderSeriesRole } from './png';
import { PREROLL_S, loadEngine, renderSegment, resolveEngine } from './render';
import { SEGMENTS, bindSegmentEngine, createBaseControl, type Segment } from './segments';
import { readWav } from './wav';

export const USAGE = 'usage: tsx tools/score.ts <engine-id> [--refs lab-refs] [--out renders/score] [--gate]';
export const DEFAULT_REFS = 'lab-refs';
export const DEFAULT_OUT = 'renders/score';
/** Exit codes besides 0: a failed --gate verdict, a usage error, a run that failed (never read as a verdict). */
export const EXIT_GATE_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 3;
/** Render sample rate (the reference library is 48 kHz). */
export const FS = 48000;
/** Usable reference clips an engine needs to be scored (spec §11.2/§11.3: ≥ 2 independent clips). */
export const MIN_REF_CLIPS = 2;

// ───────────────────────────── arguments ─────────────────────────────

export interface ScoreCliOptions {
  engine: string;
  refsDir: string;
  outDir: string;
  gate: boolean;
}

export function parseArgs(argv: string[]): ScoreCliOptions {
  const o: ScoreCliOptions = { engine: '', refsDir: DEFAULT_REFS, outDir: DEFAULT_OUT, gate: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--refs') {
      o.refsDir = value(i, a);
      i++;
    } else if (a === '--out') {
      o.outDir = value(i, a);
      i++;
    } else if (a === '--gate') {
      o.gate = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else if (o.engine === '') {
      o.engine = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  if (o.engine === '') throw new Error('missing <engine-id>');
  return o;
}

// ───────────────────────────── segment kinds and the render program ─────────────────────────────

/**
 * Tracked frames below this confidence are skipped like unvoiced ones: amendment D4.3 bounds the error of frames
 * with confidence ≥ 0.5 only (±6 %), so lower-confidence frames could carry an octave error into the features.
 */
export const MIN_TRACK_CONFIDENCE = 0.5;
/** A segment may end this far (s) past the end of its recording (rounding of hand-written spans). */
const SPAN_TOLERANCE_S = 1e-3;

export interface RenderPlanEntry {
  /** tools/segments.ts segment name. */
  segment: string;
  /** Reference kind the segment is compared with. */
  kind: SegmentKind;
  /** True while the control (as the render evaluates it, per quantum) is in that kind. */
  scored(ctl: DspControl): boolean;
}

const always = (): boolean => true;

/** The contract's render segments and the reference kind of each. */
export const RENDER_PLAN: readonly RenderPlanEntry[] = [
  { segment: 'idle', kind: 'idle', scored: always },
  { segment: 'cruise2k', kind: 'cruise', scored: always },
  { segment: 'cruise4k', kind: 'cruise', scored: always },
  { segment: 'cruise6k', kind: 'cruise', scored: always },
  // A reference wot segment is one gear's pull (docs/SOUND_LAB.md): no gear change, no limiter bounce.
  { segment: 'wotPull', kind: 'wot', scored: (c) => !c.shift.active && !c.limiter },
  // A reference liftoff is closed throttle in gear: not the part-load lead-in nor the clutch-open idle tail.
  { segment: 'liftoff6k', kind: 'liftoff', scored: (c) => c.load < 0 && c.driveline === 'engaged' },
];

const RENDERED_KINDS: ReadonlySet<string> = new Set(RENDER_PLAN.map((p) => p.kind));

// ───────────────────────────── sidecar segments ─────────────────────────────

export type Keyframes = [number, number][];

export interface RefSegment {
  kind: SegmentKind;
  startS: number;
  endS: number;
  rpm: 'auto' | Keyframes;
  /** The search range of an "auto" segment; null for keyframed segments (a hint next to keyframes is unused). */
  rpmHint: [number, number] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Half-width of an rpm hint relative to its centre: [850, 1150] → 0.15 (±15 %). */
export function hintHalfWidth(hint: readonly [number, number]): number {
  return (hint[1] - hint[0]) / (hint[1] + hint[0]);
}

function parseKeyframes(raw: unknown[]): Keyframes | string {
  if (raw.length === 0) return 'rpm keyframes must be a non-empty [[tS, rpm], …] list';
  const kf: Keyframes = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!Array.isArray(e) || e.length !== 2 || !isFiniteNumber(e[0]) || !isFiniteNumber(e[1]) || e[0] < 0 || !(e[1] > 0)) {
      return `rpm keyframe ${i} must be [tS ≥ 0, rpm > 0]`;
    }
    const prev = kf[kf.length - 1];
    if (prev !== undefined && !(e[0] > prev[0])) return `rpm keyframe times must be strictly increasing (keyframe ${i})`;
    kf.push([e[0], e[1]]);
  }
  return kf;
}

/**
 * Validates one sidecar segment against a recording of `durationS` seconds. Returns the segment, or the reason it
 * cannot be used: unknown kind, a span outside the recording, malformed rpm keyframes, or an "auto" segment
 * without a usable hint — every "auto" segment needs rpmHint [low, high] with 0 < low < high (the tracker only
 * runs inside sidecar hints, amendment D4), and for idle/cruise/limiter it may span at most ±15 % (D4.1).
 */
export function validateSegment(raw: unknown, durationS: number): RefSegment | string {
  if (!isRecord(raw)) return 'segment is not an object';
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(SEGMENT_KINDS as readonly string[]).includes(kind)) {
    return `unknown kind ${JSON.stringify(kind)} (expected ${SEGMENT_KINDS.join(' | ')})`;
  }
  const k = kind as SegmentKind;
  const { startS, endS } = raw;
  if (!isFiniteNumber(startS) || !isFiniteNumber(endS) || !(startS < endS)) return 'needs finite startS < endS (seconds)';
  if (startS < 0 || endS > durationS + SPAN_TOLERANCE_S) {
    return `span ${startS}–${endS} s lies outside the ${durationS.toFixed(3)} s recording`;
  }
  if (raw.rpm === 'auto') {
    if (raw.rpmHint === undefined || raw.rpmHint === null) {
      return `${k} segment with "auto" rpm needs an rpmHint [low, high] to track inside (amendment D4)`;
    }
    const h = raw.rpmHint;
    if (!Array.isArray(h) || h.length !== 2 || !isFiniteNumber(h[0]) || !isFiniteNumber(h[1]) || !(h[0] > 0) || !(h[1] > h[0])) {
      return 'rpmHint must be [low, high] with 0 < low < high';
    }
    const hint: [number, number] = [h[0], h[1]];
    // the rule of trackOptionsForSegment (src/lab/pitch.ts), checked here to report the reason before tracking
    if (STEADY_KINDS.includes(k) && hint[1] - hint[0] > STEADY_HINT_MAX * (hint[0] + hint[1]) * (1 + 1e-9)) {
      const w = hintHalfWidth(hint);
      const centre = Math.round((hint[0] + hint[1]) / 2);
      return (
        `rpmHint [${hint[0]}, ${hint[1]}] spans ±${(100 * w).toFixed(1)} % around ${centre} rpm; ` +
        `${k} segments with "auto" rpm need a hint no wider than ±15 % (amendment D4)`
      );
    }
    return { kind: k, startS, endS, rpm: 'auto', rpmHint: hint };
  }
  if (!Array.isArray(raw.rpm)) return 'rpm must be "auto" or keyframes [[tS, rpm], …]';
  const kf = parseKeyframes(raw.rpm);
  if (typeof kf === 'string') return kf;
  return { kind: k, startS, endS, rpm: kf, rpmHint: null };
}

/**
 * rpm at segment time `tS` from keyframes [[tS, rpm], …]: linear between keyframes, NaN outside the keyframed span
 * (never extrapolated; frames there are skipped); a single keyframe is a constant rpm.
 */
export function keyframeRpm(kf: readonly (readonly [number, number])[], tS: number): number {
  const first = kf[0];
  const last = kf[kf.length - 1];
  if (first === undefined || last === undefined || Number.isNaN(tS)) return Number.NaN;
  if (kf.length === 1) return first[1];
  if (tS < first[0] || tS > last[0]) return Number.NaN;
  let lo = 0;
  let hi = kf.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((kf[mid]?.[0] ?? Number.NaN) <= tS) lo = mid;
    else hi = mid;
  }
  const [t0, r0] = kf[lo] ?? first;
  const [t1, r1] = kf[hi] ?? last;
  return t1 > t0 ? r0 + ((r1 - r0) * (tS - t0)) / (t1 - t0) : r0;
}

// ───────────────────────────── analysis lens ─────────────────────────────

/** The order grid every clip of one scoring run is analysed on: the scored engine's sub-order step and firing order. */
export interface Lens {
  step: number;
  firingsPerRev: number;
}

export function lensOf(spec: EngineSpec): Lens {
  const o = trackOptionsForEngine(spec);
  return { step: o.subOrderStep, firingsPerRev: o.firingsPerRev };
}

function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (first === undefined) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0) / channels.length;
  return out;
}

// ───────────────────────────── renders with known rpm ─────────────────────────────

export interface RenderTimeline {
  /** rpm the DSP rendered, per sample. */
  rpm: Float64Array;
  /** 1 where the sample belongs to the segment's reference kind (plan.scored and no shift trajectory running). */
  scored: Uint8Array;
}

/**
 * Per-sample rpm of renderSegment(def, seg, …) and which samples are in the plan's kind: the segment control is
 * evaluated per quantum exactly as renderSegment evaluates it (pre-roll at the t = 0 control, then one evaluation per
 * quantum) and fed to the DSP's own RpmState, sample by sample.
 */
export function renderTimeline(
  spec: EngineSpec,
  seg: Segment,
  plan: RenderPlanEntry,
  perspective: Perspective,
  frames: number,
  fs: number,
): RenderTimeline {
  bindSegmentEngine(spec);
  const base = createBaseControl(spec, perspective);
  const rs = new RpmState(fs);
  rs.configure(spec);
  seg.ctl(0, base);
  rs.reset(base.rpm);
  const pre = Math.round((PREROLL_S * fs) / QUANTUM);
  for (let q = 0; q < pre; q++) {
    const t0 = ((q - pre) * QUANTUM) / fs;
    for (let i = 0; i < QUANTUM; i++) rs.tick(base, t0 + i / fs);
  }
  const rpm = new Float64Array(frames);
  const scored = new Uint8Array(frames);
  for (let q = 0; q * QUANTUM < frames; q++) {
    const t0 = (q * QUANTUM) / fs;
    seg.ctl(t0, base);
    const inKind = plan.scored(base);
    for (let i = 0; i < QUANTUM && q * QUANTUM + i < frames; i++) {
      rs.tick(base, t0 + i / fs);
      const k = q * QUANTUM + i;
      rpm[k] = rs.rpm;
      scored[k] = inKind && !rs.shifting ? 1 : 0;
    }
  }
  return { rpm, scored };
}

export interface RenderReport {
  perspective: Perspective;
  segment: string;
  kind: SegmentKind;
  durationS: number;
  /** The analysed span [from, to) (s): first to last sample in the kind; samples out of kind inside it are skipped. */
  spanS: [number, number];
  frames: number;
  nonFiniteResets: number;
  plot: string | null;
}

export interface RenderedClip {
  report: RenderReport;
  features: ClipFeatures;
}

/** Renders one plan entry and extracts its features with the known rpm; writes its spectrogram into `plotDir`. */
export function renderClip(def: EngineDef, plan: RenderPlanEntry, perspective: Perspective, lens: Lens, plotDir?: string): RenderedClip {
  const seg = SEGMENTS.find((s) => s.name === plan.segment);
  if (seg === undefined) throw new Error(`score: tools/segments.ts has no segment ${plan.segment}`);
  const { left, right, nonFiniteResets } = renderSegment(def, seg, { perspective, subwoofer: 'yes', fs: FS });
  const mono = downmix([left, right]);
  const tl = renderTimeline(def.spec, seg, plan, perspective, mono.length, FS);
  const first = tl.scored.indexOf(1);
  const last = tl.scored.lastIndexOf(1);
  const from = first < 0 ? 0 : first;
  const to = first < 0 ? 0 : last + 1;
  const rpmAt = (tS: number): number => {
    const x = from + tS * FS;
    const k0 = Math.floor(x);
    const k1 = Math.min(k0 + 1, to - 1);
    if (!(k0 >= from) || k0 >= to || tl.scored[k0] !== 1 || tl.scored[k1] !== 1) return Number.NaN;
    const r0 = tl.rpm[k0] ?? Number.NaN;
    return r0 + ((tl.rpm[k1] ?? Number.NaN) - r0) * (x - k0);
  };
  const features = clipFeatures(mono.subarray(from, to), FS, rpmAt, lens.step, plan.kind, perspective, lens.firingsPerRev);
  let plot: string | null = null;
  if (plotDir !== undefined) {
    plot = `spectrogram-render-${plan.segment}-${perspective}.png`;
    writeFileSync(join(plotDir, plot), spectrogramPng(mono, FS));
  }
  return {
    report: {
      perspective,
      segment: plan.segment,
      kind: plan.kind,
      durationS: seg.durationS,
      spanS: [from / FS, to / FS],
      frames: features.frames.length,
      nonFiniteResets,
      plot,
    },
    features,
  };
}

// ───────────────────────────── reference clips ─────────────────────────────

export interface SegmentReport {
  /** Position in the sidecar's segments list. */
  index: number;
  kind: string | null;
  startS: number | null;
  endS: number | null;
  rpm: 'keyframes' | 'auto' | null;
  rpmHint: [number, number] | null;
  /** Feature frames the segment contributes. */
  frames: number;
  /** "auto" only: share of tracked frames that are voiced, and voiced with confidence ≥ MIN_TRACK_CONFIDENCE. */
  voicedShare: number | null;
  confidentShare: number | null;
  /** used; rejected (reason says why); unmatched (valid, but no render segment of its kind to compare with). */
  status: 'used' | 'rejected' | 'unmatched';
  reason: string | null;
  plot: string | null;
}

export interface ClipReport {
  clipId: string;
  perspective: Perspective | null;
  fs: number | null;
  durationS: number | null;
  /** used when at least one segment is used. */
  status: 'used' | 'rejected';
  reason: string | null;
  segments: SegmentReport[];
}

export interface RefClip {
  report: ClipReport;
  /** One ClipFeatures per kind with used segments (SEGMENT_KINDS order); the segments of a kind merged. */
  features: ClipFeatures[];
}

export interface RefLoadOptions {
  /** Analyse only clips of these perspectives (others are skipped without a report). */
  perspectives?: readonly Perspective[];
  /** Write a spectrogram of every used segment here. */
  plotDir?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The kind's merged features: frames in sidecar order; liftoff overrunRate = duration-weighted mean of the segments'. */
function mergeKind(kind: SegmentKind, perspective: Perspective, parts: { features: ClipFeatures; durationS: number }[]): ClipFeatures {
  let overrunRate: number | null = null;
  if (kind === 'liftoff') {
    let sum = 0;
    let weight = 0;
    for (const p of parts) {
      if (p.features.overrunRate === null) continue;
      sum += p.features.overrunRate * p.durationS;
      weight += p.durationS;
    }
    overrunRate = weight > 0 ? sum / weight : null;
  }
  return { kind, perspective, frames: parts.flatMap((p) => p.features.frames), overrunRate };
}

/** The frames of a pitch track a segment's features may use, and the counts its report shows. */
export interface ConfidentTrack {
  /** The track with the rpm of every unvoiced or low-confidence frame set to NaN (features skip those frames). */
  track: RpmTrack;
  /** Frames with a finite rpm. */
  voiced: number;
  /** Voiced frames with confidence ≥ MIN_TRACK_CONFIDENCE: the ones kept. */
  confident: number;
}

/**
 * Amendment D4(3)/(4): unvoiced frames (NaN) are skipped, and so are voiced frames below MIN_TRACK_CONFIDENCE (D4(3)
 * bounds the error of confident frames only); never a fallback value. Returns a new track; `track` is not modified.
 */
export function confidentTrack(track: RpmTrack): ConfidentTrack {
  const n = track.rpm.length;
  const rpm = new Float64Array(n);
  let voiced = 0;
  let confident = 0;
  for (let i = 0; i < n; i++) {
    const r = track.rpm[i] ?? Number.NaN;
    if (!Number.isFinite(r)) {
      rpm[i] = Number.NaN;
      continue;
    }
    voiced++;
    if ((track.confidence[i] ?? Number.NaN) >= MIN_TRACK_CONFIDENCE) {
      confident++;
      rpm[i] = r;
    } else {
      rpm[i] = Number.NaN;
    }
  }
  return { track: { hopS: track.hopS, t: track.t, rpm, confidence: track.confidence }, voiced, confident };
}

/** rpm source of one valid segment: keyframes, or the confident frames of the pitch track inside its hint. */
function segmentRpm(
  seg: RefSegment,
  slice: Float32Array,
  fs: number,
  trackSpec: EngineSpec | null,
  report: SegmentReport,
): ((tS: number) => number) | string {
  if (seg.rpm !== 'auto') {
    const kf = seg.rpm;
    return (tS) => keyframeRpm(kf, tS);
  }
  if (trackSpec === null) return 'cannot track "auto" rpm: no engine definition for this library directory';
  if (seg.rpmHint === null) return 'internal: "auto" segment without a hint';
  let track: RpmTrack;
  try {
    track = trackRpm(slice, fs, trackOptionsForSegment(trackSpec, seg.kind, seg.rpmHint));
  } catch (e) {
    return `rpm tracking failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const n = track.rpm.length;
  const used = confidentTrack(track);
  report.voicedShare = n > 0 ? used.voiced / n : 0;
  report.confidentShare = n > 0 ? used.confident / n : 0;
  return (tS) => interpolateRpm(used.track, tS);
}

/** Index of the first non-finite sample of `x`, or −1. */
function firstNonFinite(x: Float32Array): number {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i] ?? Number.NaN)) return i;
  return -1;
}

/** An error message with every occurrence of the file `path` replaced by its bare `name` (reports carry no host paths). */
function withoutPath(e: unknown, path: string, name: string): string {
  return (e instanceof Error ? e.message : String(e)).split(path).join(name);
}

/** Loads, validates and analyses one clip (null: skipped because of its perspective). */
function loadRefClip(engineDir: string, clipId: string, trackSpec: EngineSpec | null, lens: Lens, opts: RefLoadOptions): RefClip | null {
  const rejectClip = (reason: string, perspective: Perspective | null = null): RefClip => ({
    report: { clipId, perspective, fs: null, durationS: null, status: 'rejected', reason, segments: [] },
    features: [],
  });
  const sidePath = join(engineDir, `${clipId}.json`);
  let side: unknown;
  try {
    side = JSON.parse(readFileSync(sidePath, 'utf8'));
  } catch (e) {
    return rejectClip(`unreadable sidecar: ${withoutPath(e, sidePath, `${clipId}.json`)}`);
  }
  if (!isRecord(side)) return rejectClip('sidecar is not a JSON object');
  if (side.clipId !== undefined && side.clipId !== clipId) {
    return rejectClip(`sidecar clipId ${JSON.stringify(side.clipId)} does not match its file name`);
  }
  const perspective = side.perspective;
  if (perspective !== 'cabin' && perspective !== 'outside') {
    return rejectClip(`perspective must be "cabin" or "outside", got ${JSON.stringify(perspective)}`);
  }
  if (opts.perspectives !== undefined && !opts.perspectives.includes(perspective)) return null;
  if (!Array.isArray(side.segments)) return rejectClip('segments must be a list', perspective);
  const wavPath = join(engineDir, `${clipId}.wav`);
  if (!existsSync(wavPath)) return rejectClip(`missing ${clipId}.wav`, perspective);
  let fs: number;
  let mono: Float32Array;
  try {
    const w = readWav(wavPath);
    fs = w.fs;
    mono = downmix(w.channels);
  } catch (e) {
    return rejectClip(withoutPath(e, wavPath, `${clipId}.wav`), perspective);
  }
  if (!(fs > 0) || !Number.isFinite(fs)) return rejectClip(`${clipId}.wav declares a sample rate of ${fs} Hz`, perspective);
  const durationS = mono.length / fs;
  const segments: SegmentReport[] = [];
  const byKind = new Map<SegmentKind, { features: ClipFeatures; durationS: number }[]>();
  const ordinal = new Map<string, number>();
  for (let index = 0; index < side.segments.length; index++) {
    const raw: unknown = side.segments[index];
    const r = isRecord(raw) ? raw : {};
    const kindName = typeof r.kind === 'string' ? r.kind : null;
    const n = kindName === null ? 0 : (ordinal.get(kindName) ?? 0) + 1;
    if (kindName !== null) ordinal.set(kindName, n);
    const report: SegmentReport = {
      index,
      kind: kindName,
      startS: isFiniteNumber(r.startS) ? r.startS : null,
      endS: isFiniteNumber(r.endS) ? r.endS : null,
      rpm: r.rpm === 'auto' ? 'auto' : Array.isArray(r.rpm) ? 'keyframes' : null,
      rpmHint: null,
      frames: 0,
      voicedShare: null,
      confidentShare: null,
      status: 'rejected',
      reason: null,
      plot: null,
    };
    segments.push(report);
    const seg = validateSegment(raw, durationS);
    if (typeof seg === 'string') {
      report.reason = seg;
      continue;
    }
    report.rpmHint = seg.rpmHint;
    if (!RENDERED_KINDS.has(seg.kind)) {
      report.status = 'unmatched';
      report.reason = `no render segment of kind ${seg.kind} to compare with (rendered kinds: ${[...RENDERED_KINDS].join(', ')})`;
      continue;
    }
    const a = Math.max(0, Math.round(seg.startS * fs));
    const b = Math.min(mono.length, Math.round(seg.endS * fs));
    const slice = mono.subarray(a, b);
    // A corrupt (e.g. 32-bit float) recording costs the segments it touches, not the run.
    const bad = firstNonFinite(slice);
    if (bad >= 0) {
      report.reason = `non-finite sample (${String(slice[bad])}) at ${((a + bad) / fs).toFixed(4)} s of ${clipId}.wav`;
      continue;
    }
    const rpmAt = segmentRpm(seg, slice, fs, trackSpec, report);
    if (typeof rpmAt === 'string') {
      report.reason = rpmAt;
      continue;
    }
    let f: ClipFeatures;
    let png: Uint8Array | null = null;
    try {
      f = clipFeatures(slice, fs, rpmAt, lens.step, seg.kind, perspective, lens.firingsPerRev);
      if (f.frames.length > 0 && opts.plotDir !== undefined) png = spectrogramPng(slice, fs);
    } catch (e) {
      report.reason = `analysis failed: ${withoutPath(e, wavPath, `${clipId}.wav`)}`;
      continue;
    }
    if (f.frames.length === 0) {
      report.reason =
        seg.rpm === 'auto'
          ? `no 0.25 s frame with a confidently tracked rpm (voiced ${pct(report.voicedShare)}, confidence ≥ ${MIN_TRACK_CONFIDENCE} ${pct(report.confidentShare)})`
          : 'no analysable 0.25 s frame inside the keyframed span';
      continue;
    }
    report.status = 'used';
    report.frames = f.frames.length;
    const parts = byKind.get(seg.kind) ?? [];
    parts.push({ features: f, durationS: slice.length / fs });
    byKind.set(seg.kind, parts);
    if (opts.plotDir !== undefined && png !== null) {
      report.plot = `spectrogram-${clipId}-${seg.kind}${n}.png`;
      writeFileSync(join(opts.plotDir, report.plot), png);
    }
  }
  const features: ClipFeatures[] = [];
  for (const kind of SEGMENT_KINDS) {
    const parts = byKind.get(kind);
    if (parts !== undefined) features.push(mergeKind(kind, perspective, parts));
  }
  const used = features.length > 0;
  return {
    report: { clipId, perspective, fs, durationS, status: used ? 'used' : 'rejected', reason: used ? null : 'no usable segment', segments },
    features,
  };
}

/**
 * Every clip of one engine's library directory (sidecars in file-name order), analysed through `lens`; "auto" rpm is
 * tracked with `trackSpec` (the firing pattern of the recorded engine; null: "auto" segments are rejected). A missing
 * directory is an empty library.
 */
export function loadRefClips(engineDir: string, trackSpec: EngineSpec | null, lens: Lens, opts: RefLoadOptions = {}): RefClip[] {
  if (!isDirectory(engineDir)) return [];
  const clips: RefClip[] = [];
  for (const file of readdirSync(engineDir).filter((f) => f.endsWith('.json')).sort()) {
    const clip = loadRefClip(engineDir, file.slice(0, -'.json'.length), trackSpec, lens, opts);
    if (clip !== null) clips.push(clip);
  }
  return clips;
}

/** Engine directories of the library other than `exceptId`, sorted. */
function otherEngineIds(refsDir: string, exceptId: string): string[] {
  if (!isDirectory(refsDir)) return [];
  return readdirSync(refsDir)
    .filter((d) => d !== exceptId && isDirectory(join(refsDir, d)))
    .sort();
}

function specOf(engineId: string): EngineSpec | null {
  try {
    return loadEngine(resolveEngine(engineId)).spec;
  } catch {
    return null;
  }
}

// ───────────────────────────── scoring, verdict, report ─────────────────────────────

export interface Verdict {
  /** Fewer than MIN_REF_CLIPS usable clips (or scoreEngine says so): never fails. */
  unscored: boolean;
  passed: MetricName[];
  failed: MetricName[];
  discrimination: boolean | null;
  /** What --gate decides: unscored, or no failed metric gate and discrimination not failed. */
  pass: boolean;
}

export function verdictOf(score: EngineScore, refClips: number): Verdict {
  const unscored = score.unscored || refClips < MIN_REF_CLIPS;
  const passed = METRIC_NAMES.filter((m) => score.gate[m] === 'pass');
  const failed = METRIC_NAMES.filter((m) => score.gate[m] === 'fail');
  const discrimination = score.discrimination.pass;
  return { unscored, passed, failed, discrimination, pass: unscored || (failed.length === 0 && discrimination !== false) };
}

/** Process exit code: EXIT_GATE_FAILED (1) only with --gate on a failed verdict. */
export function exitCodeFor(verdict: Verdict, gate: boolean): number {
  return gate && !verdict.pass ? EXIT_GATE_FAILED : 0;
}

export interface PairDetail extends PairScore {
  kind: string;
  perspective: Perspective;
  /** Render label ("render <segment>") or clip id. */
  a: string;
  /** Clip id. */
  b: string;
}

export interface OtherPairDetail extends PairDetail {
  engineId: string;
}

/** One series of an order plot, as report.json and report.md list it. */
export interface OrderPlotSeriesReport {
  /** Legend label: "<kind> render" or "<kind> <clipId>" (kind first: the legend elides the middle of long labels). */
  label: string;
  kind: string;
  /** null for the render. */
  clipId: string | null;
  /** Frames in the plotted rpm bin; a series without any draws no curve. */
  frames: number;
  /** Drawn: one of the first ORDER_PLOT.maxSeries series (one colour and marker each); the legend counts the rest. */
  drawn: boolean;
}

export interface OrderPlotReport {
  file: string;
  perspective: Perspective;
  /**
   * The plotted 500 rpm bin [low, high) (amendment D7, tools/png.ts orderPlotBin): the one with the most frames common
   * to the render and the references of this perspective, ties to the lower rpm; null when no series has a frame.
   */
  rpmBin: [number, number] | null;
  /**
   * Frames in rpmBin of the render series and of the reference series; common = the smaller of the two, the count D7
   * maximises over the bins (0: no bin holds both, and rpmBin is the bin with the most frames instead).
   */
  frames: { render: number; reference: number; common: number };
  series: OrderPlotSeriesReport[];
}

export interface ScoreReport {
  engineId: string;
  name: string;
  inspiredBy: string;
  aspiration: string;
  lens: Lens;
  /** Usable own reference clips. */
  refClips: number;
  score: EngineScore;
  verdict: Verdict;
  refs: ClipReport[];
  otherRefs: { engineId: string; clips: ClipReport[] }[];
  renders: RenderReport[];
  /** Exactly the pairs the EngineScore averages (renderVsOther: per engine, its discrimination composite). */
  pairs: { renderVsRef: PairDetail[]; refVsRef: PairDetail[]; renderVsOther: OtherPairDetail[] };
  /** PNG file names in the engine's output directory. */
  plots: string[];
  /** The order plots' series, those with frames in the plotted bin first. */
  orderPlots: OrderPlotReport[];
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(100 * v).toFixed(0)} %`;
}

function fmt(v: number | null, digits = 3): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function pairRows(pairs: (PairDetail & { engineId?: string })[], withEngine: boolean): string[] {
  if (pairs.length === 0) return ['(none)'];
  const head = [...(withEngine ? ['engine'] : []), 'a', 'b', 'kind', 'perspective', 'bins', 'composite', ...METRIC_NAMES];
  const rows = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const p of pairs) {
    const cells = [
      ...(withEngine ? [p.engineId ?? ''] : []),
      p.a,
      p.b,
      p.kind,
      p.perspective,
      String(p.commonBins),
      fmt(p.composite),
      ...METRIC_NAMES.map((m) => fmt(p.metrics[m])),
    ];
    rows.push(`| ${cells.map(cell).join(' | ')} |`);
  }
  return rows;
}

/** The human-readable report (no clock, no host paths). */
export function reportMarkdown(r: ScoreReport): string {
  const s = r.score;
  const v = r.verdict;
  const L: string[] = [];
  L.push(`# tesbox-score: ${r.engineId}`, '');
  L.push(
    `${r.name}, inspired by ${r.inspiredBy}; aspiration ${r.aspiration}. Every clip is analysed on the scored engine's ` +
      `order grid (step ${fmt(r.lens.step, 4)}, firing order ${fmt(r.lens.firingsPerRev, 4)}).`,
    '',
  );
  if (v.unscored) {
    L.push(
      `**Unscored**: ${r.refClips} usable reference clip(s); scoring needs at least ${MIN_REF_CLIPS} independent clips ` +
        '(spec §11.3). Gates are not applied.',
    );
  } else {
    const why = [...(v.failed.length > 0 ? [`failed gates: ${v.failed.join(', ')}`] : []), ...(v.discrimination === false ? ['discrimination failed'] : [])];
    L.push(`**Gate: ${v.pass ? 'PASS' : 'FAIL'}**${why.length > 0 ? ` (${why.join('; ')})` : ''}.`);
    if (v.passed.length + v.failed.length === 0) L.push('', 'Warning: no metric gate could be evaluated (no comparable render/reference pair).');
  }
  L.push('', `Composite (render vs reference): ${fmt(s.composite)}`, '');
  L.push('## Metrics', '', '| metric | render vs ref | ref vs ref | 0.8 × ref vs ref | gate |', '|---|---|---|---|---|');
  for (const m of METRIC_NAMES) {
    const ref = s.refVsRef[m];
    L.push(`| ${m} | ${fmt(s.renderVsRef[m])} | ${fmt(ref)} | ${fmt(ref === null ? null : 0.8 * ref)} | ${s.gate[m]} |`);
  }
  const d = s.discrimination;
  L.push('', '## Discrimination', '', '| references of | composite |', '|---|---|', `| ${r.engineId} (own) | ${fmt(d.ownComposite)} |`);
  for (const o of d.others) L.push(`| ${o.engineId} | ${fmt(o.composite)} |`);
  L.push('', `Discrimination: ${d.pass === null ? 'n/a (no other engine has references)' : d.pass ? 'pass' : 'fail'}.`, '');
  L.push('## References', '');
  if (r.refs.length === 0) L.push('No reference clips.');
  for (const c of r.refs) {
    L.push(
      `### ${c.clipId} (${c.perspective ?? '?'}): ${c.status}${c.reason !== null ? ` — ${c.reason}` : ''}`,
      '',
      '| # | kind | span (s) | rpm | hint | frames | voiced | confident | status | reason |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const g of c.segments) {
      const span = g.startS !== null && g.endS !== null ? `${fmt(g.startS, 2)}–${fmt(g.endS, 2)}` : '—';
      const hint = g.rpmHint === null ? '—' : `${g.rpmHint[0]}–${g.rpmHint[1]}`;
      L.push(
        `| ${[g.index, g.kind ?? '?', span, g.rpm ?? '?', hint, g.frames, pct(g.voicedShare), pct(g.confidentShare), g.status, g.reason ?? ''].map((x) => cell(String(x))).join(' | ')} |`,
      );
    }
    L.push('');
  }
  if (r.otherRefs.length > 0) {
    L.push("## Other engines' references (discrimination)", '', '| engine | clip | perspective | status | segments used | reason |', '|---|---|---|---|---|---|');
    for (const o of r.otherRefs) {
      for (const c of o.clips) {
        const used = c.segments.filter((g) => g.status === 'used').length;
        L.push(`| ${[o.engineId, c.clipId, c.perspective ?? '?', c.status, `${used}/${c.segments.length}`, c.reason ?? ''].map(cell).join(' | ')} |`);
      }
    }
    L.push('');
  }
  L.push('## Renders', '');
  if (r.renders.length === 0) L.push('Nothing rendered: no perspective has references.');
  else L.push('| perspective | segment | kind | analysed span (s) | frames | non-finite resets |', '|---|---|---|---|---|---|');
  for (const x of r.renders) {
    L.push(`| ${x.perspective} | ${x.segment} | ${x.kind} | ${fmt(x.spanS[0], 2)}–${fmt(x.spanS[1], 2)} | ${x.frames} | ${x.nonFiniteResets} |`);
  }
  L.push('', '## Pairs', '', '### Render vs reference', '', ...pairRows(r.pairs.renderVsRef, false), '');
  L.push('### Reference vs reference', '', ...pairRows(r.pairs.refVsRef, false), '');
  L.push("### Render vs other engines' references", '', ...pairRows(r.pairs.renderVsOther, true), '');
  L.push('## Plots', '');
  if (r.plots.length === 0) L.push('(none)');
  for (const p of r.plots) L.push(`- \`${p}\``);
  for (const o of r.orderPlots) {
    const f = o.frames;
    L.push('', `### ${o.file} (${o.perspective})`, '');
    if (o.rpmBin === null) {
      L.push('No series of this perspective has a frame in any 500 rpm bin: the plot is empty.');
    } else if (f.common > 0) {
      L.push(
        `Order profiles in the ${o.rpmBin[0]}–${o.rpmBin[1]} rpm bin (amendment D7): of the 500 rpm bins, the one with ` +
          `the most frames common to the render and the references of this perspective — ${f.render} render and ` +
          `${f.reference} reference frames there, ${f.common} in common (the smaller count); ties go to the lower rpm.`,
      );
    } else {
      L.push(
        `Order profiles in the ${o.rpmBin[0]}–${o.rpmBin[1]} rpm bin. **No common bin**: no 500 rpm bin holds both render ` +
          'and reference frames of this perspective, so this plot compares nothing; it shows the bin with the most frames ' +
          `instead (amendment D7 fallback: ${f.render} render and ${f.reference} reference frames there; ties go to the lower rpm).`,
      );
    }
    L.push(
      '',
      `A series without frames in the bin draws no curve. Up to ${ORDER_PLOT.maxSeries} series are drawn, those with ` +
        'frames in the bin first.',
      '',
      '| series | frames in bin | plotted |',
      '|---|---|---|',
    );
    for (const s of o.series) {
      const plotted = !s.drawn ? `not drawn (${ORDER_PLOT.maxSeries} series at most)` : s.frames > 0 ? 'curve' : 'legend only';
      L.push(`| ${cell(s.label)} | ${s.frames} | ${plotted} |`);
    }
    if (o.rpmBin !== null && f.common > 0 && !o.series.some((s) => s.clipId !== null && s.drawn && s.frames > 0)) {
      L.push('', `**No reference curve**: no reference series drawn here has frames in ${o.rpmBin[0]}–${o.rpmBin[1]} rpm.`);
    }
  }
  return `${L.join('\n')}\n`;
}

/** Removes a previous run's report and plots (a segment rejected now must not keep its old plot; a failed run no report). */
function clearOldOutput(dir: string): void {
  for (const f of readdirSync(dir)) {
    if (f === 'report.json' || f === 'report.md' || /^(spectrogram|orders)-.*\.png$/.test(f)) rmSync(join(dir, f), { force: true });
  }
}

/** An order-plot series with what report.md says about it. */
export interface PlotSeries extends OrderSeries {
  /** The render's series are 'render', the reference clips' 'reference' (what orderPlotBin compares). */
  role: OrderSeriesRole;
  kind: string;
  /** null for the render. */
  clipId: string | null;
  /** Frames in the plotted rpm bin (orderPlotBin over the perspective's series, then orderProfile). */
  binFrames: number;
}

function seriesOf(kind: string, clipId: string | null, frames: readonly FrameFeatures[]): PlotSeries {
  return {
    label: `${kind} ${clipId ?? 'render'}`,
    rpm: frames.map((f) => f.rpm),
    orderAmp: frames.map((f) => f.orderAmp),
    role: clipId === null ? 'render' : 'reference',
    kind,
    clipId,
    binFrames: 0,
  };
}

/**
 * Order-plot series of one perspective, one per clip and kind (orderProfile compares like with like, so one curve
 * mixing a clip's wot and liftoff frames would mislead), labelled kind first ("wot render", "liftoff <clip>": the
 * legend shortens long labels by eliding their middle, which keeps a clip id's distinguishing end). The plotted bin is
 * orderPlotBin's over all of them (amendment D7: the 500 rpm bin with the most frames common to the render and the
 * references of the perspective; orderPlotPng picks the same one from the same series). Those with frames in that bin
 * come first, so they get the colour slots; within each group the render's kinds, then each reference clip's, kinds in
 * SEGMENT_KINDS order. Every series is kept: one without frames in the bin draws no curve but shows in the legend
 * (frame count 0) while slots remain, and report.md lists it.
 */
export function orderSeries(perspective: Perspective, renders: readonly RenderedClip[], refs: readonly RefClip[], step: number): PlotSeries[] {
  const all: PlotSeries[] = [];
  for (const kind of SEGMENT_KINDS) {
    const frames = renders.filter((r) => r.report.perspective === perspective && r.features.kind === kind).flatMap((r) => r.features.frames);
    if (frames.length > 0) all.push(seriesOf(kind, null, frames));
  }
  for (const c of refs) {
    if (c.report.perspective !== perspective) continue;
    for (const f of c.features) all.push(seriesOf(f.kind, c.report.clipId, f.frames));
  }
  const bin = orderPlotBin(all);
  for (const s of all) s.binFrames = orderProfile(s, step, bin?.rpm ?? null).frames;
  return [...all.filter((s) => s.binFrames > 0), ...all.filter((s) => s.binFrames === 0)];
}

/** Runs the whole scoring (see the module comment). Throws when the engine cannot be resolved. */
export function runScore(opts: ScoreCliOptions, log: (line: string) => void = (l) => console.log(l)): { exitCode: number; report: ScoreReport } {
  const def = loadEngine(resolveEngine(opts.engine));
  const lens = lensOf(def.spec);
  const outDir = join(opts.outDir, def.id);
  mkdirSync(outDir, { recursive: true });
  clearOldOutput(outDir);
  // amendments D3, D8: the pair details use scoreEngine's options (fiLine and fiPresence n/a for NA engines)
  const compareOpts = compareOptionsFor(def.spec.aspiration.type);

  const own = loadRefClips(join(opts.refsDir, def.id), def.spec, lens, { plotDir: outDir });
  const used = own.filter((c) => c.report.status === 'used');
  const perspectives = (['cabin', 'outside'] as const).filter((p) => used.some((c) => c.report.perspective === p));
  log(
    `tesbox-score ${def.id}: ${used.length} usable reference clip(s)` +
      (perspectives.length > 0 ? ` (${perspectives.map((p) => `${p} ${used.filter((c) => c.report.perspective === p).length}`).join(', ')})` : ''),
  );
  for (const c of own) {
    if (c.report.reason !== null) log(`  ${c.report.clipId}: ${c.report.reason}`);
    for (const g of c.report.segments) {
      if (g.status !== 'used') log(`  ${c.report.clipId} segment ${g.index} (${g.kind ?? '?'}): ${g.status}: ${g.reason ?? ''}`);
    }
  }

  const renders = perspectives.flatMap((p) =>
    RENDER_PLAN.map((plan) => {
      const r = renderClip(def, plan, p, lens, outDir);
      log(`  rendered ${p} ${plan.segment}: ${r.report.frames} frames`);
      return r;
    }),
  );

  const others = otherEngineIds(opts.refsDir, def.id).map((engineId) => ({
    engineId,
    clips: perspectives.length > 0 ? loadRefClips(join(opts.refsDir, engineId), specOf(engineId), lens, { perspectives }) : [],
  }));
  const otherRefs: Record<string, ClipFeatures[]> = {};
  for (const o of others) {
    const f = o.clips.flatMap((c) => c.features);
    if (f.length > 0) otherRefs[o.engineId] = f;
  }

  const raw = scoreEngine(
    def.id,
    renders.map((r) => r.features),
    used.flatMap((c) => c.features),
    otherRefs,
    { aspiration: def.spec.aspiration.type },
  );
  const score: EngineScore = { ...raw, unscored: raw.unscored || used.length < MIN_REF_CLIPS };
  const verdict = verdictOf(score, used.length);

  // Pair details: the very pairs scoreEngine averages — its flat ClipFeatures lists, paired the way it pairs them —
  // each labelled with its clip. One ClipFeatures per clip and kind keeps a recording from pairing with itself.
  const renderVsRef: PairDetail[] = [];
  const refVsRef: PairDetail[] = [];
  const renderVsOther: OtherPairDetail[] = [];
  const like = (x: ClipFeatures, y: ClipFeatures): boolean => x.kind === y.kind && x.perspective === y.perspective;
  const flat = (clips: readonly RefClip[]): { clipId: string; f: ClipFeatures }[] =>
    clips.flatMap((c) => c.features.map((f) => ({ clipId: c.report.clipId, f })));
  const ownFlat = flat(used);
  for (const r of renders) {
    for (const x of ownFlat) {
      if (like(r.features, x.f)) {
        renderVsRef.push({ kind: x.f.kind, perspective: x.f.perspective, a: `render ${r.report.segment}`, b: x.clipId, ...compareClips(r.features, x.f, compareOpts) });
      }
    }
  }
  for (let i = 0; i < ownFlat.length; i++) {
    for (let j = i + 1; j < ownFlat.length; j++) {
      const x = ownFlat[i];
      const y = ownFlat[j];
      if (x !== undefined && y !== undefined && like(x.f, y.f)) {
        refVsRef.push({ kind: x.f.kind, perspective: x.f.perspective, a: x.clipId, b: y.clipId, ...compareClips(x.f, y.f, compareOpts) });
      }
    }
  }
  for (const o of others) {
    const otherFlat = flat(o.clips);
    for (const r of renders) {
      for (const x of otherFlat) {
        if (like(r.features, x.f)) {
          renderVsOther.push({
            engineId: o.engineId,
            kind: x.f.kind,
            perspective: x.f.perspective,
            a: `render ${r.report.segment}`,
            b: x.clipId,
            ...compareClips(r.features, x.f, compareOpts),
          });
        }
      }
    }
  }

  const plots: string[] = [];
  for (const c of own) for (const g of c.report.segments) if (g.plot !== null) plots.push(g.plot);
  for (const r of renders) if (r.report.plot !== null) plots.push(r.report.plot);
  const orderPlots: OrderPlotReport[] = [];
  for (const p of perspectives) {
    const file = `orders-${p}.png`;
    const series = orderSeries(p, renders, used, lens.step);
    // amendment D7: the bin orderPlotPng draws (the same orderPlotBin over the same series)
    const bin = orderPlotBin(series);
    writeFileSync(join(outDir, file), orderPlotPng(series, lens.step));
    plots.push(file);
    const listed = series.map((s, i) => ({ label: s.label, kind: s.kind, clipId: s.clipId, frames: s.binFrames, drawn: i < ORDER_PLOT.maxSeries }));
    const rpmBin: [number, number] | null = bin === null ? null : [bin.lo, bin.hi];
    const frames = { render: bin?.renderFrames ?? 0, reference: bin?.referenceFrames ?? 0, common: bin?.commonFrames ?? 0 };
    orderPlots.push({ file, perspective: p, rpmBin, frames, series: listed });
    if (rpmBin === null) log(`  ${file}: no series has a frame (empty plot)`);
    else if (frames.common === 0) log(`  ${file}: no 500 rpm bin holds both render and reference frames; plotted ${rpmBin[0]}–${rpmBin[1]} rpm (see report.md)`);
    else log(`  ${file}: ${rpmBin[0]}–${rpmBin[1]} rpm bin (${frames.render} render, ${frames.reference} reference frames)`);
  }

  const report: ScoreReport = {
    engineId: def.id,
    name: def.name,
    inspiredBy: def.inspiredBy,
    aspiration: def.spec.aspiration.type,
    lens,
    refClips: used.length,
    score,
    verdict,
    refs: own.map((c) => c.report),
    otherRefs: others.filter((o) => o.clips.length > 0).map((o) => ({ engineId: o.engineId, clips: o.clips.map((c) => c.report) })),
    renders: renders.map((r) => r.report),
    pairs: { renderVsRef, refVsRef, renderVsOther },
    plots,
    orderPlots,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), reportMarkdown(report));
  log(`wrote ${join(outDir, 'report.json')}, report.md and ${plots.length} plot(s)`);
  if (verdict.unscored) {
    log(`${def.id}: unscored (${used.length} usable reference clip(s); ${MIN_REF_CLIPS} needed)`);
  } else {
    const na = METRIC_NAMES.length - verdict.passed.length - verdict.failed.length;
    const disc = verdict.discrimination === null ? 'n/a' : verdict.discrimination ? 'pass' : 'fail';
    log(
      `${def.id}: composite ${fmt(score.composite)}; gates ${verdict.passed.length} pass, ${verdict.failed.length} fail` +
        `${verdict.failed.length > 0 ? ` (${verdict.failed.join(', ')})` : ''}, ${na} n/a; discrimination ${disc} → ${verdict.pass ? 'PASS' : 'FAIL'}`,
    );
  }
  return { exitCode: exitCodeFor(verdict, opts.gate), report };
}

/**
 * CLI entry; returns the process exit code: runScore's (0, or EXIT_GATE_FAILED with --gate), EXIT_USAGE for bad
 * arguments or an unknown engine, EXIT_ERROR when the run itself throws (so a crash never reads as a gate verdict).
 */
export function main(argv: string[]): number {
  let opts: ScoreCliOptions;
  try {
    opts = parseArgs(argv);
    loadEngine(resolveEngine(opts.engine));
  } catch (e) {
    console.error(`tesbox-score: ${(e as Error).message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return runScore(opts).exitCode;
  } catch (e) {
    console.error(`tesbox-score: scoring ${opts.engine} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return EXIT_ERROR;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = main(process.argv.slice(2));
}
