/**
 * Phase 5 contract P0b: with the P0b voicing fields at their neutral defaults — pulse.cylinderSpreadDb 0 dB and
 * cabin.boomDb 0 dB (phase 2a amendments B20, B21) — every garage engine renders bit-identically to Tesbox 1.3.0.
 *
 * tests/fixtures/render-identity-1.3.0.json holds the SHA-256 of every score render (tests/helpers/render-hash.ts:
 * the six RENDER_PLAN segments × cabin and outside, as tools/score.ts renders them) computed by the 1.3.0 code. An
 * engine re-tuned since (P0b: v8-sc-62, flat4-turbo-25, i4-turbo-20) is rendered with the 1.3.0 voicing stored next
 * to its hashes (the new fields added at their neutral defaults); every other engine renders its shipped voicing,
 * which must still hold the neutral defaults. The renders run in worker threads, one engine per thread.
 *
 * Bit-exact hashes hold only on the JavaScript engine that made them (Math.sin/exp/pow may differ in the last bit
 * between V8 versions; CI runs Node 22, the fixture was made on Node 24): on the fixture's runtime the hashes must
 * match exactly, on any other runtime every render's per-channel RMS must match the fixture's within 1e-6.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import { workerExecArgv } from '../../tools/tune';
import fixture from '../fixtures/render-identity-1.3.0.json';
import { HASH_PERSPECTIVES, HASH_SEGMENTS, type EngineHashes, type EnginePrints, type EngineRms } from '../helpers/render-hash';

interface FixtureEntry {
  hashes: EngineHashes;
  rms: EngineRms;
  /** The 1.3.0 voicing of an engine re-tuned since, with the P0b fields at their neutral defaults. */
  voicing?: EngineVoicing;
}

const FIXTURE = fixture as unknown as { runtime: { node: string; v8: string }; engines: Record<string, FixtureEntry> };
/** The hashes are exact only on the runtime that made them; elsewhere the RMS decides. */
const SAME_RUNTIME = process.versions.v8 === FIXTURE.runtime.v8;
const RMS_TOLERANCE = 1e-6;
const WORKER_URL = new URL('../helpers/render-hash-worker.ts', import.meta.url);

/** The engines as 1.3.0 rendered them: the stored 1.3.0 voicing where there is one, else the shipped voicing. */
const DEFS: EngineDef[] = ENGINES.map((e) => {
  const stored = FIXTURE.engines[e.id]?.voicing;
  return stored === undefined ? e : { ...e, voicing: stored };
});

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

async function hashAll(defs: readonly EngineDef[], threads: number): Promise<Map<string, EnginePrints>> {
  const out = new Map<string, EnginePrints>();
  const queue = [...defs];
  const run = async (): Promise<void> => {
    for (let def = queue.shift(); def !== undefined; def = queue.shift()) out.set(def.id, await hashInWorker(def));
  };
  await Promise.all(Array.from({ length: threads }, run));
  return out;
}

describe('render identity at the neutral P0b defaults (phase 5 contract P0b)', () => {
  let prints = new Map<string, EnginePrints>();

  beforeAll(async () => {
    prints = await hashAll(DEFS, Math.max(1, Math.min(DEFS.length, availableParallelism() - 1)));
  }, 600_000);

  it('the fixture covers the fifteen garage engines × the six score segments × both perspectives', () => {
    expect(Object.keys(FIXTURE.engines).sort()).toEqual(ENGINES.map((e) => e.id).sort());
    expect(HASH_SEGMENTS).toEqual(['idle', 'cruise2k', 'cruise4k', 'cruise6k', 'wotPull', 'liftoff6k']);
    for (const [id, entry] of Object.entries(FIXTURE.engines)) {
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
  });

  it.each(DEFS.map((d) => [d.id] as const))('%s renders as Tesbox 1.3.0 did (bit-identical on the fixture runtime)', (id) => {
    const got = prints.get(id);
    const want = FIXTURE.engines[id];
    if (SAME_RUNTIME) {
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
  });

  it('every engine (and every stored 1.3.0 voicing) holds the neutral P0b defaults: no spread, boom 100 Hz at 0 dB', () => {
    for (const def of DEFS) {
      const v = def.voicing;
      expect([v.pulse.cylinderSpreadDb, v.cabin.boomHz, v.cabin.boomDb], def.id).toEqual([0, 100, 0]);
    }
  });
});
