import type { Plugin } from 'vite';

/** Body of dist/version.json. Pure, so the plugin and the unit test share it. */
export function makeVersionJson(sha: string, builtAt: string): string {
  return `${JSON.stringify({ sha, builtAt })}\n`;
}

/** Emits `version.json` ({"sha","builtAt"}) at the root of the build output. */
export function versionPlugin(sha: string): Plugin {
  return {
    name: 'tesbox-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: makeVersionJson(sha, new Date().toISOString()),
      });
    },
  };
}
