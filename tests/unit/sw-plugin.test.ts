import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig, Rolldown } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { precacheList, renderSw, swPlugin } from '../../deploy/sw-plugin';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

// ── Bundle fixtures: the shape Vite 8 hands a post plugin's generateBundle (checked against a real build). ──

interface ChunkOpts {
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}

function chunk(fileName: string, name: string, o: ChunkOpts = {}): Rolldown.OutputChunk {
  return {
    type: 'chunk',
    fileName,
    name,
    code: '',
    isEntry: o.isEntry ?? false,
    isDynamicEntry: o.isDynamicEntry ?? false,
    facadeModuleId: o.facadeModuleId ?? null,
    imports: o.imports ?? [],
    dynamicImports: o.dynamicImports ?? [],
    exports: [],
    modules: {},
    moduleIds: [],
    viteMetadata: { importedCss: new Set(o.css ?? []), importedAssets: new Set(o.assets ?? []), __modules: {} },
  } as unknown as Rolldown.OutputChunk;
}

function asset(fileName: string, source = '', assets: string[] = []): Rolldown.OutputAsset {
  return {
    type: 'asset',
    fileName,
    names: [],
    originalFileNames: [],
    source,
    viteMetadata: { importedCss: new Set(), importedAssets: new Set(assets) },
  } as unknown as Rolldown.OutputAsset;
}

function bundleOf(...items: (Rolldown.OutputChunk | Rolldown.OutputAsset)[]): Rolldown.OutputBundle {
  return Object.fromEntries(items.map((item) => [item.fileName, item])) as Rolldown.OutputBundle;
}

/** As Vite emits it: entry script, modulepreload of the shared chunk, stylesheet, the public ES5 check script. */
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:," />
    <title>Tesbox</title>
    <script type="module" crossorigin src="/assets/main-AAA.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/summary-BBB.js">
    <link rel="stylesheet" crossorigin href="/assets/main-CCC.css">
  </head>
  <body>
    <main id="app"></main>
    <p>Diagnostics for your car: <a href="/probe/">the in-car probe</a></p>
    <script nomodule src="/unsupported.js"></script>
    <script defer src="/unsupported.js"></script>
  </body>
</html>
`;

const PROBE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" href="data:," />
    <script type="module" crossorigin src="/assets/probe-HHH.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/summary-BBB.js">
    <link rel="stylesheet" crossorigin href="/assets/probe-III.css">
  </head>
  <body></body>
</html>
`;

/** Two HTML entries sharing a chunk; the app also has a lazy chunk whose CSS pulls in a font. */
function appAndProbeBundle(): Rolldown.OutputBundle {
  return bundleOf(
    chunk('assets/main-AAA.js', 'main', {
      isEntry: true,
      facadeModuleId: '/repo/index.html',
      imports: ['assets/summary-BBB.js'],
      dynamicImports: ['assets/lazy-DDD.js'],
      css: ['assets/main-CCC.css'],
      assets: ['assets/worklet-EEE.js'],
    }),
    chunk('assets/probe-HHH.js', 'probe', {
      isEntry: true,
      facadeModuleId: '/repo/probe/index.html',
      imports: ['assets/summary-BBB.js'],
      css: ['assets/probe-III.css'],
      assets: ['assets/audio-worklet-JJJ.js'],
    }),
    chunk('assets/summary-BBB.js', 'summary'),
    chunk('assets/lazy-DDD.js', 'lazy', { isDynamicEntry: true, imports: ['assets/summary-BBB.js'], css: ['assets/lazy-FFF.css'] }),
    asset('assets/lazy-FFF.css', '', ['assets/font-GGG.woff2']),
    asset('assets/font-GGG.woff2'),
    asset('assets/worklet-EEE.js'),
    asset('assets/audio-worklet-JJJ.js'),
    asset('assets/main-CCC.css'),
    asset('assets/probe-III.css'),
    asset('version.json', '{"sha":"abc1234","builtAt":"2026-01-02T03:04:05.000Z"}\n'),
    asset('index.html', INDEX_HTML),
    asset('probe/index.html', PROBE_HTML),
  );
}

describe('precacheList', () => {
  it('is index.html with its whole module graph, the anchor loop and version.json — nothing of the probe page (not even when linked)', () => {
    expect(precacheList(appAndProbeBundle())).toEqual([
      '/assets/font-GGG.woff2',
      '/assets/lazy-DDD.js',
      '/assets/lazy-FFF.css',
      '/assets/main-AAA.js',
      '/assets/main-CCC.css',
      '/assets/summary-BBB.js',
      '/assets/worklet-EEE.js',
      '/index.html',
      '/probe/anchor.wav',
      '/unsupported.js',
      '/version.json',
    ]);
  });

  it('refuses a bundle without the app page (the plugin must run after Vite emits the HTML)', () => {
    const bundle = appAndProbeBundle();
    delete bundle['index.html'];
    expect(() => precacheList(bundle)).toThrow(/index\.html/);
  });
});

describe('renderSw', () => {
  const template = '/* head */\n// @inject CACHE PRECACHE\nself.addEventListener("install", () => {});\n';

  it('replaces the marker line with CACHE = tesbox-<sha> and the PRECACHE list', () => {
    expect(renderSw(template, 'abc1234', ['/index.html', '/assets/a.js'])).toBe(
      '/* head */\n' +
        'const CACHE = "tesbox-abc1234";\n' +
        'const PRECACHE = [\n  "/index.html",\n  "/assets/a.js"\n];\n' +
        'self.addEventListener("install", () => {});\n',
    );
  });

  it('refuses a template without exactly one marker line', () => {
    expect(() => renderSw('/* head */\nbody();\n', 'abc1234', [])).toThrow(/marker/);
    expect(() => renderSw(`${template}// @inject CACHE PRECACHE\n`, 'abc1234', [])).toThrow(/marker/);
  });
});

type GenerateBundle = (this: unknown, options: unknown, bundle: Rolldown.OutputBundle, isWrite: boolean) => void;

function hook<T>(h: unknown): T {
  const fn = typeof h === 'function' ? h : (h as { handler?: unknown } | undefined)?.handler;
  if (typeof fn !== 'function') throw new Error('missing hook');
  return fn as T;
}

function runPlugin(plugin: Plugin, bundle: Rolldown.OutputBundle, publicDir: string) {
  hook<(config: Partial<ResolvedConfig>) => void>(plugin.configResolved).call(plugin, { publicDir });
  const emitted: unknown[] = [];
  const context = {
    emitFile: vi.fn((file: unknown) => {
      emitted.push(file);
      return 'ref';
    }),
    error: (message: string): never => {
      throw new Error(message);
    },
  };
  hook<GenerateBundle>(plugin.generateBundle).call(context, {}, bundle, false);
  return emitted;
}

describe('swPlugin', () => {
  it('runs at build time only, after Vite has emitted the HTML pages', () => {
    const plugin = swPlugin('abc1234');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
  });

  it('emits sw.js at the site root from deploy/sw-template.js with the build constants', () => {
    const emitted = runPlugin(swPlugin('abc1234'), appAndProbeBundle(), PUBLIC_DIR);
    expect(emitted).toHaveLength(1);
    const file = emitted[0] as { type: string; fileName: string; source: string };
    expect(file.type).toBe('asset');
    expect(file.fileName).toBe('sw.js');
    expect(file.source).toContain('\nconst CACHE = "tesbox-abc1234";\n');
    expect(file.source).toContain('  "/assets/worklet-EEE.js",\n');
    // Everything else is the template, verbatim around its marker line.
    const [before, after, ...extra] = readFileSync(join(ROOT, 'deploy/sw-template.js'), 'utf8').split(
      '\n// @inject CACHE PRECACHE\n',
    );
    expect(extra).toEqual([]);
    expect(file.source.startsWith(`${before}\n`)).toBe(true);
    expect(file.source.endsWith(`\n${after}`)).toBe(true);
  });

  it('fails the build when a precached file is neither emitted nor in public/', () => {
    const bundle = appAndProbeBundle();
    bundle['index.html'] = asset('index.html', INDEX_HTML.replace('/unsupported.js', '/gone.js'));
    expect(() => runPlugin(swPlugin('abc1234'), bundle, PUBLIC_DIR)).toThrow('/gone.js');
    // public/ is where /unsupported.js and /probe/anchor.wav come from: without it they are missing too.
    expect(() => runPlugin(swPlugin('abc1234'), appAndProbeBundle(), '')).toThrow('/probe/anchor.wav');
  });
});

describe('the production build (vite.config.ts)', () => {
  it('emits sw.js precaching the app page graph incl. the engine worklet, the anchor loop and version.json — never the probe page', async () => {
    const { build } = await import('vite');
    const result = await build({
      root: ROOT,
      configFile: join(ROOT, 'vite.config.ts'),
      logLevel: 'silent',
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const files = new Map(outputs.flatMap((o) => o.output).map((f) => [f.fileName, f]));
    const text = (name: string): string => {
      const f = files.get(name);
      if (f === undefined) throw new Error(`${name} not emitted`);
      return f.type === 'asset' ? String(f.source) : f.code;
    };

    const sw = text('sw.js');
    const { sha } = JSON.parse(text('version.json')) as { sha: string };
    expect(sw).toContain(`\nconst CACHE = ${JSON.stringify(`tesbox-${sha}`)};\n`);
    const precache = JSON.parse(/\nconst PRECACHE = (\[[^\]]*\]);\n/.exec(sw)?.[1] ?? 'null') as string[];

    // index.html and every file its script/link tags load: the entry chunk, the modulepreloaded shared
    // chunk, the CSS, unsupported.js.
    const loaded = [...text('index.html').matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(loaded.length).toBeGreaterThanOrEqual(3);
    expect(precache).toEqual(expect.arrayContaining(['/index.html', ...loaded]));

    // The engine worklet (`./worklet.ts?worker&url`) is referenced only from the app entry chunk's code.
    const entry = [...files.values()].find((f) => f.type === 'chunk' && f.isEntry && f.name === 'main');
    const worklets = precache.filter((u) => /^\/assets\/worklet-[\w-]+\.js$/.test(u));
    expect(worklets).toHaveLength(1);
    expect(entry?.type === 'chunk' ? entry.code : '').toContain(worklets[0]?.slice(1));

    // Requested at runtime outside the graph.
    expect(precache).toEqual(expect.arrayContaining(['/probe/anchor.wav', '/version.json']));

    // Never the probe page, its own chunk/CSS or its tone worklet.
    expect(precache.filter((u) => u.startsWith('/probe/') && u !== '/probe/anchor.wav')).toEqual([]);
    expect(precache.filter((u) => /^\/assets\/(probe|audio-worklet)-/.test(u))).toEqual([]);

    // Every entry is served: an emitted file or a public/ file (cache.addAll fails on a single 404).
    for (const u of precache) expect(files.has(u.slice(1)) || existsSync(join(PUBLIC_DIR, u)), u).toBe(true);
  }, 60_000);
});
