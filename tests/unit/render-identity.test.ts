/**
 * Phase 5 contract P0b: with the P0b voicing fields at their neutral defaults — pulse.cylinderSpreadDb 0 dB and
 * cabin.boomDb 0 dB (phase 2a amendments B20, B21) — every garage engine renders bit-identically to Tesbox 1.3.0.
 *
 * tests/fixtures/render-identity-1.3.0.json holds the SHA-256 of every score render (tests/helpers/render-hash.ts:
 * the six RENDER_PLAN segments × cabin and outside, as tools/score.ts renders them) computed by the 1.3.0 code. An
 * engine re-tuned since (P0b: v8-sc-62, flat4-turbo-25, i4-turbo-20) is rendered with the 1.3.0 voicing stored next
 * to its hashes (the new fields added at their neutral defaults); every other engine renders its shipped voicing,
 * which must still hold the neutral defaults. The renders run in worker threads, one engine per thread.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES } from '../../src/data/engines';
import { workerExecArgv } from '../../tools/tune';
import fixture from '../fixtures/render-identity-1.3.0.json';
import { HASH_PERSPECTIVES, HASH_SEGMENTS, type EngineHashes } from '../helpers/render-hash';

interface FixtureEntry {
  hashes: EngineHashes;
  /** The 1.3.0 voicing of an engine re-tuned since, with the P0b fields at their neutral defaults. */
  voicing?: EngineVoicing;
}

const FIXTURE = fixture as unknown as { engines: Record<string, FixtureEntry> };
const WORKER_URL = new URL('../helpers/render-hash-worker.ts', import.meta.url);

/** The engines as 1.3.0 rendered them: the stored 1.3.0 voicing where there is one, else the shipped voicing. */
const DEFS: EngineDef[] = ENGINES.map((e) => {
  const stored = FIXTURE.engines[e.id]?.voicing;
  return stored === undefined ? e : { ...e, voicing: stored };
});

function hashInWorker(def: EngineDef): Promise<EngineHashes> {
  const execArgv = workerExecArgv();
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, execArgv === undefined ? { workerData: def } : { workerData: def, execArgv });
    worker.once('message', (h: EngineHashes) => resolve(h));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`the render-hash worker for ${def.id} exited with code ${code}`));
    });
  });
}

async function hashAll(defs: readonly EngineDef[], threads: number): Promise<Map<string, EngineHashes>> {
  const out = new Map<string, EngineHashes>();
  const queue = [...defs];
  const run = async (): Promise<void> => {
    for (let def = queue.shift(); def !== undefined; def = queue.shift()) out.set(def.id, await hashInWorker(def));
  };
  await Promise.all(Array.from({ length: threads }, run));
  return out;
}

describe('render identity at the neutral P0b defaults (phase 5 contract P0b)', () => {
  let hashes = new Map<string, EngineHashes>();

  beforeAll(async () => {
    hashes = await hashAll(DEFS, Math.max(1, Math.min(DEFS.length, availableParallelism() - 1)));
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
      }
    }
  });

  it.each(DEFS.map((d) => [d.id] as const))('%s renders bit-identically to Tesbox 1.3.0', (id) => {
    expect(hashes.get(id)).toEqual(FIXTURE.engines[id]?.hashes);
  });

  it('every engine (and every stored 1.3.0 voicing) holds the neutral P0b defaults: no spread, boom 100 Hz at 0 dB', () => {
    for (const def of DEFS) {
      const v = def.voicing;
      expect([v.pulse.cylinderSpreadDb, v.cabin.boomHz, v.cabin.boomDb], def.id).toEqual([0, 100, 0]);
    }
  });
});
