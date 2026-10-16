/**
 * Phase 5 contracts P0b and P0c: with the P0b and P0c voicing fields at their neutral defaults — pulse.cylinderSpreadDb
 * 0 dB, cabin.boomDb 0 dB (phase 2a amendments B20, B21, B22) and overrun.cutPulseDb −60 dB (B23) — every garage
 * engine renders bit-identically to Tesbox 1.3.0, and the three engines re-tuned in P0b render their 1.4.0 voicings
 * bit-identically to Tesbox 1.4.0.
 *
 * tests/fixtures/render-identity-1.3.0.json holds the SHA-256 of every score render (tests/helpers/render-hash.ts:
 * the six RENDER_PLAN segments × cabin and outside, as tools/score.ts renders them) computed by the 1.3.0 code. An
 * engine re-tuned since (P0b: v8-sc-62, flat4-turbo-25, i4-turbo-20) is rendered with the 1.3.0 voicing stored next
 * to its hashes (the new fields added at their neutral defaults); every other engine renders its shipped voicing,
 * which must still hold the neutral defaults. tests/fixtures/render-identity-1.4.0.json holds the hashes the 1.4.0 code
 * computed for the three P0b re-tunes at their 1.4.0 voicings, which cover the boom's boost path (v8-sc-62 at +11.5 dB,
 * i4-turbo-20 at +3 dB): v8-sc-62, not re-tuned since, renders its shipped voicing; flat4-turbo-25 and i4-turbo-20,
 * re-tuned in P0c, their stored 1.4.0 voicings (with overrun.cutPulseDb at its neutral −60). The renders run in
 * worker threads, one engine per thread.
 *
 * Bit-exact hashes hold only on the JavaScript engine that made them (Math.sin/exp/pow may differ in the last bit
 * between V8 versions; CI runs Node 22, the fixtures were made on Node 24): on a fixture's runtime the hashes must
 * match exactly, on any other runtime every render's per-channel RMS must match the fixture's within 1e-6.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import { workerExecArgv } from '../../tools/tune';
import fixture130 from '../fixtures/render-identity-1.3.0.json';
import fixture140 from '../fixtures/render-identity-1.4.0.json';
import { HASH_PERSPECTIVES, HASH_SEGMENTS, type EngineHashes, type EnginePrints, type EngineRms } from '../helpers/render-hash';

interface FixtureEntry {
  hashes: EngineHashes;
  rms: EngineRms;
  /** The voicing of an engine re-tuned since the fixture's version, with the later fields at their neutral defaults. */
  voicing?: EngineVoicing;
}

interface Fixture {
  runtime: { node: string; v8: string };
  engines: Record<string, FixtureEntry>;
}

const F130 = fixture130 as unknown as Fixture;
const F140 = fixture140 as unknown as Fixture;
const RMS_TOLERANCE = 1e-6;
const WORKER_URL = new URL('../helpers/render-hash-worker.ts', import.meta.url);
/** The engines re-tuned in phase 5 P0b (1.4.0), and those of them re-tuned again in P0c. */
const P0B_RETUNED = ['flat4-turbo-25', 'i4-turbo-20', 'v8-sc-62'];
const P0C_RETUNED = ['flat4-turbo-25', 'i4-turbo-20'];

/** The fixture's engines as its version rendered them: the stored voicing where there is one, else the shipped voicing. */
function defsOf(f: Fixture): EngineDef[] {
  return ENGINES.filter((e) => f.engines[e.id] !== undefined).map((e) => {
    const stored = f.engines[e.id]?.voicing;
    return stored === undefined ? e : { ...e, voicing: stored };
  });
}

const DEFS_130 = defsOf(F130);
const DEFS_140 = defsOf(F140);

function hashInWorker(def: EngineDef): Promise<EnginePrints> {
  const execArgv = workerExecArgv();
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, execArgv === undefined ? { workerData: def } : { workerData: def, execArgv });
    worker.once('message', (h: EnginePrints) => resolve(h));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`the render-hash worker for ${def.id} exited with code ${code}`));
    });
  });
}

/** Fingerprints every [key, def] job on `threads` worker threads. */
async function hashAll(jobs: readonly (readonly [string, EngineDef])[], threads: number): Promise<Map<string, EnginePrints>> {
  const out = new Map<string, EnginePrints>();
  const queue = [...jobs];
  const run = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) out.set(job[0], await hashInWorker(job[1]));
  };
  await Promise.all(Array.from({ length: threads }, run));
  return out;
}

/** Exact hashes on the fixture's runtime; elsewhere every render's per-channel RMS within RMS_TOLERANCE. */
function expectSameRenders(f: Fixture, id: string, got: EnginePrints | undefined): void {
  const want = f.engines[id];
  if (process.versions.v8 === f.runtime.v8) {
    expect(got?.hashes).toEqual(want?.hashes);
    return;
  }
  for (const s of HASH_SEGMENTS) {
    for (const p of HASH_PERSPECTIVES) {
      const [l, r] = got?.rms[s]?.[p] ?? [Number.NaN, Number.NaN];
      const [wl, wr] = want?.rms[s]?.[p] ?? [Number.NaN, Number.NaN];
      expect(Math.abs(l - wl), `${id} ${s} ${p} left RMS ${l} vs ${wl}`).toBeLessThanOrEqual(RMS_TOLERANCE * wl);
      expect(Math.abs(r - wr), `${id} ${s} ${p} right RMS ${r} vs ${wr}`).toBeLessThanOrEqual(RMS_TOLERANCE * wr);
    }
  }
}

function expectWellFormed(f: Fixture): void {
  expect(HASH_SEGMENTS).toEqual(['idle', 'cruise2k', 'cruise4k', 'cruise6k', 'wotPull', 'liftoff6k']);
  for (const [id, entry] of Object.entries(f.engines)) {
    expect(Object.keys(entry.hashes), id).toEqual([...HASH_SEGMENTS]);
    for (const s of HASH_SEGMENTS) {
      const row = entry.hashes[s] ?? {};
      expect(Object.keys(row), `${id} ${s}`).toEqual([...HASH_PERSPECTIVES]);
      for (const h of Object.values(row)) expect(h, `${id} ${s}`).toMatch(/^[0-9a-f]{64}$/);
      for (const p of HASH_PERSPECTIVES) {
        const rms = entry.rms[s]?.[p] ?? [];
        expect(rms, `${id} ${s} ${p}`).toHaveLength(2);
        for (const v of rms) expect(Number.isFinite(v) && v > 0, `${id} ${s} ${p} rms ${v}`).toBe(true);
      }
    }
  }
}

let prints130 = new Map<string, EnginePrints>();
let prints140 = new Map<string, EnginePrints>();

beforeAll(async () => {
  const jobs = [...DEFS_130.map((d) => [`1.3.0 ${d.id}`, d] as const), ...DEFS_140.map((d) => [`1.4.0 ${d.id}`, d] as const)];
  const all = await hashAll(jobs, Math.max(1, Math.min(jobs.length, availableParallelism() - 1)));
  prints130 = new Map(DEFS_130.map((d) => [d.id, all.get(`1.3.0 ${d.id}`) as EnginePrints]));
  prints140 = new Map(DEFS_140.map((d) => [d.id, all.get(`1.4.0 ${d.id}`) as EnginePrints]));
}, 600_000);

describe('render identity at the neutral P0b/P0c defaults: Tesbox 1.3.0 (phase 5 contracts P0b, P0c)', () => {
  it('the fixture covers the fifteen garage engines × the six score segments × both perspectives', () => {
    expect(Object.keys(F130.engines).sort()).toEqual(ENGINES.map((e) => e.id).sort());
    expect(Object.entries(F130.engines).filter(([, e]) => e.voicing !== undefined).map(([id]) => id).sort()).toEqual(P0B_RETUNED);
    expectWellFormed(F130);
  });

  it.each(DEFS_130.map((d) => [d.id] as const))('%s renders as Tesbox 1.3.0 did (bit-identical on the fixture runtime)', (id) => {
    expectSameRenders(F130, id, prints130.get(id));
  });

  it('every engine (and every stored 1.3.0 voicing) holds the neutral defaults: no spread, boom 100 Hz at 0 dB, no cut pulses', () => {
    for (const def of DEFS_130) {
      const v = def.voicing;
      expect([v.pulse.cylinderSpreadDb, v.cabin.boomHz, v.cabin.boomDb, v.overrun.cutPulseDb], def.id).toEqual([0, 100, 0, -60]);
    }
  });
});

describe('render identity of the P0b re-tunes at the neutral P0c default: Tesbox 1.4.0 (phase 5 contract P0c)', () => {
  it('the fixture covers the three P0b re-tunes × the six score segments × both perspectives', () => {
    expect(Object.keys(F140.engines).sort()).toEqual(P0B_RETUNED);
    expect(Object.entries(F140.engines).filter(([, e]) => e.voicing !== undefined).map(([id]) => id).sort()).toEqual(P0C_RETUNED);
    expectWellFormed(F140);
  });

  it.each(DEFS_140.map((d) => [d.id] as const))('%s renders its 1.4.0 voicing as Tesbox 1.4.0 did (bit-identical on the fixture runtime)', (id) => {
    expectSameRenders(F140, id, prints140.get(id));
  });

  it('the 1.4.0 voicings hold no cut pulses (−60 dB), and v8-sc-62 keeps its 1.4.0 boost (143 Hz, +11.5 dB)', () => {
    for (const def of DEFS_140) expect(def.voicing.overrun.cutPulseDb, def.id).toBe(-60);
    const sc = DEFS_140.find((d) => d.id === 'v8-sc-62');
    expect([sc?.voicing.cabin.boomHz, sc?.voicing.cabin.boomDb]).toEqual([143, 11.5]);
  });
});
