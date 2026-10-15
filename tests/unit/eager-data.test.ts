/**
 * Phase-4 contract T2 (spec §12 in-memory preload): every engine and the Tesla catalogue ship in the JS the
 * app entry loads eagerly — never in a lazy import() chunk or in an asset fetched by URL at run time — so they
 * are in memory from boot and a session keeps them through a tunnel, with or without a service worker.
 *
 * The app is built in memory (`write: false`: nothing is written) with the project's own vite.config.ts and
 * the emitted chunks are inspected. A fixture build first shows that the inspection sees a lazy data module.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig, type Plugin, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DATA_DIR = `${ROOT}/src/data/`;
/** A real build: generous for a loaded CI runner (it takes well under a second locally). */
const BUILD_TIMEOUT_MS = 60_000;

interface DataPlacement {
  /** Data module → rendered JS length, for modules in the entry chunk's static import closure (loaded with the page). */
  eager: Map<string, number>;
  /** Data modules in a chunk that no entry imports statically: only an import() loads it. */
  lazy: string[];
  /** Data files emitted as assets: fetched by URL at run time. */
  assets: string[];
}

/** `vite build` in memory, with NODE_ENV=production as `npm run build` has it (Vitest sets 'test'). */
async function buildInMemory(config: InlineConfig): Promise<Rolldown.RolldownOutput[]> {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await build({ ...config, logLevel: 'silent', build: { ...config.build, write: false } });
    if (Array.isArray(result)) return result;
    if ('output' in result) return [result];
    throw new Error('vite build returned a watcher');
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}

/** Where the build put the modules under `dataDir`, as seen from the one entry chunk `isEntryChunk` picks. */
function placeData(
  outputs: readonly Rolldown.RolldownOutput[],
  isEntryChunk: (chunk: Rolldown.OutputChunk) => boolean,
  dataDir: string,
): DataPlacement {
  const chunks = new Map<string, Rolldown.OutputChunk>();
  const assets: Rolldown.OutputAsset[] = [];
  for (const { output } of outputs) {
    for (const item of output) {
      if (item.type === 'chunk') chunks.set(item.fileName, item);
      else assets.push(item);
    }
  }
  /** File names of `from` and of every chunk they import statically, transitively. */
  const staticClosure = (from: readonly Rolldown.OutputChunk[]): Set<string> => {
    const seen = new Set<string>();
    const queue = from.map((c) => c.fileName);
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      const chunk = chunks.get(name);
      if (chunk === undefined || seen.has(name)) continue;
      seen.add(name);
      queue.push(...chunk.imports);
    }
    return seen;
  };
  const all = [...chunks.values()];
  const entry = all.filter(isEntryChunk);
  if (entry.length !== 1) throw new Error(`expected one entry chunk, found ${entry.length}`);
  const eagerChunks = staticClosure(entry);
  const loadedByAnEntry = staticClosure(all.filter((c) => c.isEntry));
  const isData = (file: string): boolean => file.startsWith(dataDir);
  const placement: DataPlacement = { eager: new Map(), lazy: [], assets: [] };
  for (const chunk of all) {
    for (const id of chunk.moduleIds) {
      const file = id.replace(/^\0/, '').split('?')[0] ?? id;
      if (!isData(file)) continue;
      if (eagerChunks.has(chunk.fileName)) placement.eager.set(file, chunk.modules[id]?.renderedLength ?? 0);
      else if (!loadedByAnEntry.has(chunk.fileName)) placement.lazy.push(`${file} → ${chunk.fileName}`);
    }
  }
  for (const asset of assets) {
    for (const f of asset.originalFileNames) if (isData(resolve(ROOT, f))) placement.assets.push(`${f} → ${asset.fileName}`);
  }
  return placement;
}

/** In-memory fixture: an entry importing one data module statically and one through import(). */
const FIXTURE = '/tesbox-eager-data-fixture';
const FIXTURE_FILES: Record<string, string> = {
  [`${FIXTURE}/main.js`]: [
    "import eager from './src/data/eager.json';",
    'console.log(eager.v);',
    "setTimeout(() => import('./src/data/lazy.json').then((m) => console.log(m.default.v)), 0);",
  ].join('\n'),
  [`${FIXTURE}/src/data/eager.json`]: '{ "v": 1 }',
  [`${FIXTURE}/src/data/lazy.json`]: '{ "v": 2 }',
};

function fixturePlugin(): Plugin {
  return {
    name: 'eager-data-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      const id =
        source.startsWith('./') && importer !== undefined
          ? `${importer.slice(0, importer.lastIndexOf('/'))}/${source.slice(2)}`
          : source;
      return id in FIXTURE_FILES ? id : null;
    },
    load(id) {
      return FIXTURE_FILES[id] ?? null;
    },
  };
}

describe('the data placement check', () => {
  it('sees a fixture build: a statically imported data module is eager, one behind import() is lazy', async () => {
    const fixture = placeData(
      await buildInMemory({
        configFile: false,
        root: ROOT,
        plugins: [fixturePlugin()],
        build: { rolldownOptions: { input: { main: `${FIXTURE}/main.js` } } },
      }),
      (c) => c.isEntry,
      `${FIXTURE}/src/data/`,
    );
    expect([...fixture.eager.keys()]).toEqual([`${FIXTURE}/src/data/eager.json`]);
    expect(fixture.lazy).toEqual([expect.stringMatching(/^\/tesbox-eager-data-fixture\/src\/data\/lazy\.json → /)]);
  }, BUILD_TIMEOUT_MS);
});

describe('the app build keeps src/data eager (phase-4 contract T2)', () => {
  let outDir = '';
  let app: DataPlacement;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'tesbox-eager-data-')); // never written: write is false
    const outputs = await buildInMemory({ root: ROOT, configFile: resolve(ROOT, 'vite.config.ts'), build: { outDir } });
    app = placeData(outputs, (c) => c.facadeModuleId === resolve(ROOT, 'index.html'), DATA_DIR);
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
  });

  it('every engine JSON, the engine list and the Tesla catalogue ship in the JS the app entry loads eagerly', () => {
    const engineJson = readdirSync(`${DATA_DIR}engines`).filter((f) => f.endsWith('.json'));
    expect(engineJson).not.toHaveLength(0);
    const expected = [
      ...engineJson.map((f) => `engines/${f}`),
      'engines/index.ts',
      'catalogue.ts',
      'teslas.json',
      'roadload.json',
      'tesla-params.json',
    ].map((rel) => `${DATA_DIR}${rel}`);
    expect(expected.filter((file) => !((app.eager.get(file) ?? 0) > 0))).toEqual([]);
  });

  it('no src/data module is in a lazy import() chunk or in an asset fetched at run time', () => {
    expect(app.lazy).toEqual([]);
    expect(app.assets).toEqual([]);
  });
});
