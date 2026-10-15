/**
 * Build-only Vite plugin that emits the app service worker `/sw.js` (phase-4 contract T1, spec §12).
 *
 * The worker is deploy/sw-template.js with its marker line replaced by two constants:
 * - `CACHE` = `'tesbox-<build sha>'` — one Cache Storage cache per build;
 * - `PRECACHE` — index.html and its whole module graph (entry chunk, static and dynamic imports, their
 *   CSS and the assets they reference, the engine worklet included), the public files index.html loads
 *   (unsupported.js), plus /probe/anchor.wav (EngineAudio's anchor loop) and /version.json. The probe page
 *   (it keeps its own /probe/sw.js) and its chunk, CSS and worklet are never precached.
 *
 * It runs after Vite's build plugins (`enforce: 'post'`), so the HTML pages and version.json are already in
 * the bundle, and fails the build when a precached file would not be served: `cache.addAll` rejects on a
 * single 404 and the worker would then never install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, Rolldown } from 'vite';

/** The template line that renderSw replaces with the CACHE and PRECACHE constants. */
const MARKER = '// @inject CACHE PRECACHE';

/** Fetched by the app at runtime outside the bundled graph: the anchor loop and the version check. */
const RUNTIME_FILES = ['/probe/anchor.wav', '/version.json'];

function text(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

/**
 * Root-relative URLs the page loads — src/href of its script, link and media elements (not of links to
 * other pages) — without query or fragment; data: and other URLs are skipped.
 */
function pageRefs(html: string): string[] {
  const refs: string[] = [];
  for (const tag of html.matchAll(/<(?:script|link|img|source|audio|video)\b[^>]*>/gi)) {
    for (const m of tag[0].matchAll(/\s(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
      const url = m[1] ?? '';
      if (url.startsWith('/') && !url.startsWith('//')) refs.push(url.replace(/[?#].*$/, ''));
    }
  }
  return refs;
}

/**
 * Sorted root-relative URLs to precache: `page` (an HTML file of the bundle), every file it references,
 * every chunk reachable through static and dynamic imports from those, the CSS and assets each of them
 * imports, and RUNTIME_FILES. Files that are not in the bundle (public/ copies) are listed as referenced.
 */
export function precacheList(bundle: Rolldown.OutputBundle, page = 'index.html'): string[] {
  const html = bundle[page];
  if (html?.type !== 'asset') throw new Error(`sw-plugin: ${page} is not in the bundle`);
  const files = new Set<string>([page]);
  const queue: string[] = [];
  const add = (fileName: string): void => {
    if (files.has(fileName)) return;
    files.add(fileName);
    queue.push(fileName);
  };
  for (const ref of pageRefs(text(html.source))) add(ref.slice(1));
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const item = bundle[next];
    if (item === undefined) continue; // copied from public/
    if (item.type === 'chunk') {
      for (const f of item.imports) add(f);
      for (const f of item.dynamicImports) add(f);
    }
    for (const f of item.viteMetadata?.importedCss ?? []) add(f);
    for (const f of item.viteMetadata?.importedAssets ?? []) add(f);
  }
  return [...new Set([...[...files].map((f) => `/${f}`), ...RUNTIME_FILES])].sort();
}

/** The worker source: `template` with its single marker line replaced by the CACHE and PRECACHE constants. */
export function renderSw(template: string, sha: string, precache: readonly string[]): string {
  const lines = template.split('\n');
  const at = lines.findIndex((line) => line.trim() === MARKER);
  if (at === -1 || lines.slice(at + 1).some((line) => line.trim() === MARKER)) {
    throw new Error(`sw-plugin: the template needs exactly one "${MARKER}" marker line`);
  }
  lines.splice(
    at,
    1,
    `const CACHE = ${JSON.stringify(`tesbox-${sha}`)};`,
    `const PRECACHE = ${JSON.stringify(precache, null, 2)};`,
  );
  return lines.join('\n');
}

/** Emits `sw.js` (the app service worker, scope /) at the root of the build output. */
export function swPlugin(sha: string): Plugin {
  let publicDir = '';
  return {
    name: 'tesbox-sw',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const precache = precacheList(bundle);
      const missing = precache.filter(
        (url) => !(url.slice(1) in bundle) && !(publicDir !== '' && existsSync(join(publicDir, url))),
      );
      if (missing.length > 0) {
        this.error(`sw-plugin: precached files the build does not serve: ${missing.join(', ')}`);
      }
      const template = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderSw(template, sha, precache) });
    },
  };
}
