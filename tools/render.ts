/**
 * tesbox-render (spec §11.1): renders DspCore through fixed segments to 32-bit float WAVs.
 *
 *   tsx tools/render.ts <engine-id-or-json-path> [--segments a,b] [--perspective cabin|outside]
 *                       [--subwoofer yes|no] [--out renders/] [--fs 48000]
 *
 * An engine id resolves src/data/engines/<id>.json if present, else tests/fixtures/engines/<id>.json.
 * Output: <out>/<engine id>-<segment>-<perspective>.wav (renders/ is gitignored).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_SAMPLE_RATE, QUANTUM, type EngineDef, type Perspective } from '../src/contracts';
import { rmsDb, truePeakDbtp } from '../src/dsp/analysis';
import { MIN_SAMPLE_RATE, TesboxDspCore } from '../src/dsp/dsp-core';
import { SEGMENTS, bindSegmentEngine, createBaseControl, type Segment } from './segments';
import { writeWav } from './wav';

export const USAGE =
  'usage: tsx tools/render.ts <engine-id-or-json-path> [--segments a,b] [--perspective cabin|outside] [--subwoofer yes|no] [--out renders/] [--fs 48000]';

/** Lowest accepted --fs: TesboxDspCore / ExhaustNetwork reject sample rates below this (phase 2a contract B3). */
export const MIN_FS = MIN_SAMPLE_RATE;
/** Discarded lead-in rendered with the segment's t = 0 control (start-up fades and empty pipes). */
export const PREROLL_S = 0.5;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface RenderOptions {
  engine: string;
  segments: string[];
  perspective: Perspective;
  subwoofer: 'yes' | 'no';
  outDir: string;
  fs: number;
}

export function parseArgs(argv: string[]): RenderOptions {
  const o: RenderOptions = {
    engine: '',
    segments: SEGMENTS.map((s) => s.name),
    perspective: 'cabin',
    subwoofer: 'yes',
    outDir: 'renders',
    fs: 48000,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--segments') {
      const names = value(i, a)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const valid = SEGMENTS.map((s) => s.name);
      const unknown = names.filter((n) => !valid.includes(n));
      if (names.length === 0 || unknown.length > 0) {
        throw new Error(`unknown segment(s) ${unknown.join(', ') || '(none)'}; valid: ${valid.join(', ')}`);
      }
      o.segments = names;
      i++;
    } else if (a === '--perspective') {
      const v = value(i, a);
      if (v !== 'cabin' && v !== 'outside') throw new Error(`--perspective must be cabin|outside, got ${v}`);
      o.perspective = v;
      i++;
    } else if (a === '--subwoofer') {
      const v = value(i, a);
      if (v !== 'yes' && v !== 'no') throw new Error(`--subwoofer must be yes|no, got ${v}`);
      o.subwoofer = v;
      i++;
    } else if (a === '--out') {
      o.outDir = value(i, a);
      i++;
    } else if (a === '--fs') {
      const v = Number(value(i, a));
      if (!Number.isInteger(v) || v < MIN_FS || v > MAX_SAMPLE_RATE) {
        throw new Error(`--fs must be an integer in [${MIN_FS}, ${MAX_SAMPLE_RATE}]`);
      }
      o.fs = v;
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else if (o.engine === '') {
      o.engine = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  if (o.engine === '') throw new Error('missing <engine-id-or-json-path>');
  return o;
}

/** Path of the engine JSON for an id (src/data/engines first, then tests/fixtures/engines) or an explicit .json path. */
export function resolveEngine(arg: string, root: string = REPO_ROOT): string {
  if (arg.endsWith('.json') || arg.includes('/') || arg.includes('\\')) {
    const p = resolve(arg);
    if (!existsSync(p)) throw new Error(`engine file not found: ${p}`);
    return p;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(arg)) throw new Error(`invalid engine id "${arg}" (kebab-case expected)`);
  for (const dir of ['src/data/engines', 'tests/fixtures/engines']) {
    const p = join(root, dir, `${arg}.json`);
    if (existsSync(p)) return p;
  }
  throw new Error(`engine "${arg}" not found in src/data/engines or tests/fixtures/engines`);
}

export function loadEngine(path: string): EngineDef {
  const def = JSON.parse(readFileSync(path, 'utf8')) as EngineDef;
  if (typeof def.id !== 'string' || !Array.isArray(def.spec?.combustion) || typeof def.voicing !== 'object') {
    throw new Error(`${path} is not an EngineDef`);
  }
  return def;
}

export interface RenderedSegment {
  left: Float32Array;
  right: Float32Array;
  nonFiniteResets: number;
}

/**
 * Renders one segment on a fresh core: Full tier, seed 1, warm engine at hot steady state, valve auto,
 * comfort, volume trim `opts.trimDb` (default 0 dB; +6 dB is the maximum, spec §1.3c / amendment B16).
 */
export function renderSegment(
  def: EngineDef,
  seg: Segment,
  opts: Pick<RenderOptions, 'perspective' | 'subwoofer' | 'fs'> & { trimDb?: number },
): RenderedSegment {
  const fs = opts.fs;
  bindSegmentEngine(def.spec);
  const core = new TesboxDspCore(fs, 1);
  core.configure(def, { subwoofer: opts.subwoofer, hpCornerHz: 40, volumeTrimDb: opts.trimDb ?? 0 }, 'full');
  core.forceHot();
  const base = createBaseControl(def.spec, opts.perspective);
  const l = new Float32Array(QUANTUM);
  const r = new Float32Array(QUANTUM);
  const pre = Math.round((PREROLL_S * fs) / QUANTUM);
  seg.ctl(0, base);
  for (let q = 0; q < pre; q++) core.render(base, l, r, QUANTUM, ((q - pre) * QUANTUM) / fs);
  const frames = Math.round(seg.durationS * fs);
  const quanta = Math.ceil(frames / QUANTUM);
  const left = new Float32Array(quanta * QUANTUM);
  const right = new Float32Array(quanta * QUANTUM);
  for (let q = 0; q < quanta; q++) {
    const t = (q * QUANTUM) / fs;
    seg.ctl(t, base);
    base.runTimeS = 600 + t;
    core.render(base, l, r, QUANTUM, t);
    left.set(l, q * QUANTUM);
    right.set(r, q * QUANTUM);
  }
  return { left: left.subarray(0, frames), right: right.subarray(0, frames), nonFiniteResets: core.stats.nonFiniteResets };
}

/** CLI entry; returns the process exit code (2 = usage error). */
export function main(argv: string[]): number {
  let opts: RenderOptions;
  let def: EngineDef;
  try {
    opts = parseArgs(argv);
    def = loadEngine(resolveEngine(opts.engine));
  } catch (e) {
    console.error(`tesbox-render: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  for (const name of opts.segments) {
    const seg = SEGMENTS.find((s) => s.name === name);
    if (seg === undefined) continue;
    const { left, right, nonFiniteResets } = renderSegment(def, seg, opts);
    const path = join(opts.outDir, `${def.id}-${seg.name}-${opts.perspective}.wav`);
    writeWav(path, [left, right], opts.fs);
    const tp = Math.max(truePeakDbtp(left), truePeakDbtp(right));
    console.log(
      `wrote ${path}  ${seg.durationS} s  true peak ${tp.toFixed(2)} dBTP  RMS ${rmsDb(left).toFixed(1)} dB  non-finite resets ${nonFiniteResets}`,
    );
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  process.exitCode = main(process.argv.slice(2));
}
