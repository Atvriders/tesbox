/**
 * Phase-2c contract L1 / L4 build check: the production build serves /lab/index.html, and the app service
 * worker's PRECACHE (computed from the `main` entry graph by deploy/sw-plugin.ts) holds no file that only the lab
 * page loads — the lab is a desktop tool, never part of the app's offline cache. The project is built in memory
 * (`write: false`) with its own vite.config.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BUILD_TIMEOUT_MS = 60_000;

type Item = Rolldown.OutputChunk | Rolldown.OutputAsset;

function text(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

/** Every bundle file `page` loads: its src/href references, then chunks' imports, CSS, assets and /assets/ URLs in code. */
function graphOf(items: ReadonlyMap<string, Item>, page: string): Set<string> {
  const html = items.get(page);
  if (html?.type !== 'asset') throw new Error(`${page} is not in the build`);
  const seen = new Set<string>([page]);
  const queue: string[] = [];
  const add = (f: string): void => {
    if (!seen.has(f)) {
      seen.add(f);
      queue.push(f);
    }
  };
  for (const m of text(html.source).matchAll(/\s(?:src|href)="\/([^"?#]+)"/g)) add(m[1] ?? '');
  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    const item = items.get(f);
    if (item === undefined) continue;
    if (item.type === 'chunk') {
      item.imports.forEach(add);
      item.dynamicImports.forEach(add);
      for (const m of item.code.matchAll(/["'`/](assets\/[\w.-]+\.(?:js|css|wav))/g)) add(m[1] ?? '');
    }
    const meta = (item as { viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> } }).viteMetadata;
    meta?.importedCss?.forEach(add);
    meta?.importedAssets?.forEach(add);
  }
  return seen;
}

describe('the production build and the Sound Lab', () => {
  let outDir = '';
  const items = new Map<string, Item>();

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'tesbox-lab-build-')); // never written: write is false
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await build({
        root: ROOT,
        configFile: resolve(ROOT, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir, write: false },
      });
      const outputs = Array.isArray(result) ? result : 'output' in result ? [result] : [];
      for (const { output } of outputs) for (const item of output) items.set(item.fileName, item);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    if (outDir !== '') rmSync(outDir, { recursive: true, force: true });
  });

  it('emits lab/index.html loading its own entry, stylesheet and the tesbox-lab worklet', () => {
    const lab = graphOf(items, 'lab/index.html');
    const files = [...lab];
    expect(files.some((f) => /^assets\/lab-[\w-]+\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^assets\/lab-[\w-]+\.css$/.test(f))).toBe(true);
    const worklet = files.find((f) => /^assets\/lab-worklet-[\w-]+\.js$/.test(f));
    expect(worklet).toBeDefined();
    const code = text((items.get(worklet ?? '') as Rolldown.OutputAsset | undefined)?.source ?? '');
    expect(code).toContain('tesbox-lab'); // registerProcessor name
  });

  it("keeps every lab-only file (and the lab page) out of the app service worker's PRECACHE", () => {
    const sw = items.get('sw.js');
    expect(sw?.type).toBe('asset');
    const m = /const PRECACHE = (\[[\s\S]*?\]);/.exec(text((sw as Rolldown.OutputAsset).source));
    expect(m).not.toBeNull();
    const precache = JSON.parse(m?.[1] ?? '[]') as string[];
    expect(precache).toContain('/index.html'); // the list is the app's
    const main = graphOf(items, 'index.html');
    const labOnly = [...graphOf(items, 'lab/index.html')].filter((f) => !main.has(f));
    expect(labOnly).toContain('lab/index.html');
    expect(labOnly.length).toBeGreaterThanOrEqual(4); // page, entry chunk, stylesheet, worklet
    expect(precache.filter((url) => labOnly.includes(url.slice(1)))).toEqual([]);
    expect(precache.filter((url) => /lab/.test(url))).toEqual([]);
  });
});
