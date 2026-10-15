import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveBuildSha } from './deploy/build-sha.ts';
import { headersPlugin } from './deploy/headers-plugin.ts';
import { swPlugin } from './deploy/sw-plugin.ts';
import { versionPlugin } from './deploy/version-plugin.ts';

const sha = resolveBuildSha();

/** Absolute path of a page next to this config, so builds work from any working directory. */
const page = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify(sha) },
  build: {
    // Every asset stays a real file (spec §4.1): nothing is inlined as a data: URI.
    assetsInlineLimit: 0,
    // Chromium 140+ supports <link rel=modulepreload> natively; without this Vite injects its
    // MIT-licensed polyfill into the entry chunk, and NOTICES / CLEAN_ROOM list the attributed QR
    // encoder adaptation (src/platform/qr.ts) as the only third-party code that ships.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      // The Sound Lab (/lab/, phase-2c contract L1) is a third page; sw-plugin precaches only main's graph.
      input: { main: page('./index.html'), probe: page('./probe/index.html'), lab: page('./lab/index.html') },
      // Keep `/*!` / `@license` comments (the MIT attribution of the QR encoder adapted in
      // src/platform/qr.ts) in the minified bundle; Vite 8.3 strips them by default when minifying.
      output: { comments: { legal: true } },
    },
  },
  // swPlugin emits the app service worker /sw.js (phase-4 contract T1); the probe keeps its own /probe/sw.js.
  plugins: [versionPlugin(sha), headersPlugin(), swPlugin(sha)],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
