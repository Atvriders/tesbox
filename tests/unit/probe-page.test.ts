import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const html = read('probe/index.html');
const css = read('src/probe/probe.css');
const main = read('src/probe/main.ts');

const SECTIONS = ['build', 'env', 'audio', 'gps', 'inputs', 'storage', 'export'];

describe('probe/index.html', () => {
  it('has the seven contract sections in order, each a <section id> with an <h2>', () => {
    const ids = [...html.matchAll(/<section id="([a-z-]+)">\s*<h2>/g)].map((m) => m[1]);
    expect(ids).toEqual(SECTIONS);
  });

  it('is CSP-clean: one external module script, no inline scripts/styles/handlers', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="module" src="/src/probe/main.ts">']);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(html).toContain('<link rel="stylesheet" href="/src/probe/probe.css" />');
  });

  it('offers both latencyHint values and all three output routes', () => {
    const radios = (name: string) => [...html.matchAll(new RegExp(`name="${name}" value="([a-z-]+)"`, 'g'))].map((m) => m[1]);
    expect(radios('latency')).toEqual(['balanced', 'playback']);
    expect(radios('route')).toEqual(['direct', 'media-element', 'direct-anchor']);
  });

  it('contains every element id that main.ts looks up', () => {
    const used = new Set([...main.matchAll(/\bel(?:<[A-Za-z]+>)?\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
    used.add('bench-results');
    used.add('gps-results');
    used.add('env-features');
    expect(used.size).toBeGreaterThan(30);
    for (const id of used) expect(html, `#${id}`).toContain(`id="${id}"`);
  });

  it('carries the non-affiliation footer', () => {
    expect(html).toContain('Not affiliated with Tesla, Inc.');
  });
});

describe('src/probe/probe.css', () => {
  it('forces the dark theme without prefers-color-scheme', () => {
    expect(css).toContain('color-scheme: dark;');
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('sizes buttons, choices and selects from the runtime --touch variable', () => {
    expect(css).toMatch(/button \{[^}]*min-height: var\(--touch\);/);
    expect(css).toMatch(/\.choice \{[^}]*min-height: var\(--touch\);/);
    expect(css).toMatch(/select \{[^}]*min-height: var\(--touch\);/);
    expect(main).toContain("setProperty('--touch', `${minTouchCssPx(");
  });
});
