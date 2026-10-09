/** Shared helpers for the DSP and tool tests (not a test file: Vitest only collects files ending in .test.ts). */
import { QUANTUM, type DspControl, type EngineDef, type OutputConfig, type Tier } from '../../../src/contracts';
import { gainToDb } from '../../../src/dsp/util';
import { TesboxDspCore } from '../../../src/dsp/dsp-core';
import type { CombustionSource } from '../../../src/dsp/combustion';
import type { ExhaustNetwork } from '../../../src/dsp/exhaust';
import type { OverrunLayer } from '../../../src/dsp/overrun';
import type { PerspectiveMixer } from '../../../src/dsp/perspective';
import type { RpmState } from '../../../src/dsp/rpm-state';

export { FIXTURE_IDS, loadFixture } from './fixtures';

export const FS = 48000;

export const OUT_SUB: OutputConfig = { subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 };

/** Steady control with the app defaults: ignition on, warm, engaged, valve auto, cabin, comfort. */
export function makeCtl(rpm: number, load: number, over: Partial<DspControl> = {}): DspControl {
  return {
    rpm,
    load,
    gear: 3,
    driveline: 'engaged',
    limiter: false,
    shift: { active: false, up: true, fromRpm: rpm, toRpm: rpm, t0: 0, durationS: 0.1 },
    ignitionOn: true,
    runTimeS: 600,
    valve: 'auto',
    perspective: 'cabin',
    driveMode: 'comfort',
    warm: true,
    ...over,
  };
}

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  exhaust: Float32Array;
}

export interface HarnessOpts {
  tier?: Tier;
  seed?: number;
  /** forceHot() after configure (default true). */
  hot?: boolean;
  output?: OutputConfig;
}

/** Drives one core in whole quanta; consecutive run() calls continue the same timeline. */
export class CoreHarness {
  readonly core: TesboxDspCore;
  private q = 0;
  private readonly l = new Float32Array(QUANTUM);
  private readonly r = new Float32Array(QUANTUM);

  constructor(def: EngineDef, opts: HarnessOpts = {}) {
    this.core = new TesboxDspCore(FS, opts.seed ?? 1);
    this.core.configure(def, opts.output ?? OUT_SUB, opts.tier ?? 'full');
    if (opts.hot ?? true) this.core.forceHot();
  }

  /** Time (s) of the next quantum. */
  get tS(): number {
    return (this.q * QUANTUM) / FS;
  }

  /** Renders round(seconds·FS/QUANTUM) quanta; `before` runs before each quantum with that quantum's start time. */
  run(seconds: number, ctl: DspControl, before?: (tS: number) => void): Rendered {
    const quanta = Math.round((seconds * FS) / QUANTUM);
    const out: Rendered = {
      left: new Float32Array(quanta * QUANTUM),
      right: new Float32Array(quanta * QUANTUM),
      exhaust: new Float32Array(quanta * QUANTUM),
    };
    for (let i = 0; i < quanta; i++) {
      const t = this.tS;
      before?.(t);
      this.core.render(ctl, this.l, this.r, QUANTUM, t);
      out.left.set(this.l, i * QUANTUM);
      out.right.set(this.r, i * QUANTUM);
      out.exhaust.set(this.core.exhaustBus, i * QUANTUM);
      this.q++;
    }
    return out;
  }
}

/** White-box view of TesboxDspCore's private members (TS-private only; present at runtime). */
export interface CoreInternals {
  def: EngineDef | null;
  combustion: CombustionSource;
  exhaust: ExhaustNetwork;
  overrun: OverrunLayer;
  perspective: PerspectiveMixer;
  rpmState: RpmState;
  gasHeader: number;
  gasCollector: number;
  gasMuffler: number;
  regime: number;
  valve: number;
  lastCombustionGain: number;
  /** Config / recovery fade gain applied before the OutputStage (0 … 1). */
  fadeGain: number;
}

export function internals(core: TesboxDspCore): CoreInternals {
  return core as unknown as CoreInternals;
}

export function slice(sig: Float32Array, fromS: number, toS: number): Float32Array {
  return sig.subarray(Math.round(fromS * FS), Math.round(toS * FS));
}

export function peakAbs(sig: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < sig.length; i++) p = Math.max(p, Math.abs(sig[i] ?? 0));
  return p;
}

export function peakDb(sig: ArrayLike<number>): number {
  return gainToDb(peakAbs(sig));
}

/** Largest |x[n] − x[n−1]|. */
export function maxStep(sig: ArrayLike<number>): number {
  let m = 0;
  for (let i = 1; i < sig.length; i++) m = Math.max(m, Math.abs((sig[i] ?? 0) - (sig[i - 1] ?? 0)));
  return m;
}

export function allFinite(sig: ArrayLike<number>): boolean {
  for (let i = 0; i < sig.length; i++) if (!Number.isFinite(sig[i] ?? Number.NaN)) return false;
  return true;
}

export function bitIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

const TYPED_CTORS = [
  'ArrayBuffer',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
] as const;

/**
 * Counts `new` on every typed-array / ArrayBuffer constructor while installed (global proxies).
 * Returns an uninstall function. Keep test-side allocation out of the counted window.
 */
export function countBufferConstructions(onConstruct: (name: string) => void): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = TYPED_CTORS.map((name) => g[name]);
  for (const name of TYPED_CTORS) {
    const ctor = g[name] as abstract new (...args: never[]) => object;
    g[name] = new Proxy(ctor, {
      construct(target, args, newTarget) {
        onConstruct(name);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
  }
  return () => {
    TYPED_CTORS.forEach((name, i) => {
      g[name] = saved[i];
    });
  };
}
