import { readFileSync } from 'node:fs';
import { transform } from 'lightningcss';
import { describe, expect, it } from 'vitest';
import { PADDLE_CLASS, PADDLE_FLASH_CLASS } from '../../src/input/paddles';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('src/ui/theme.css');

/** CSS text with comments removed. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(cssCode);
  if (m === null) throw new Error(`theme.css has no rule "${selector}"`);
  return m[1] ?? '';
}

/**
 * theme.css as `vite build` ships it: Vite 8 minifies CSS with Lightning CSS for its default
 * 'baseline-widely-available' targets (chrome111 edge111 firefox114 safari16.4 ios16.4, encoded
 * major << 16 | minor << 8 as Vite's convertTargets does). The minifier keeps only the last of two
 * same-property declarations in one rule, so a source-level fallback check alone proves nothing.
 */
function shippedCss(): string {
  const v = (major: number, minor = 0): number => (major << 16) | (minor << 8);
  const targets = { chrome: v(111), edge: v(111), firefox: v(114), safari: v(16, 4), ios_saf: v(16, 4) };
  const { code } = transform({ filename: 'theme.css', code: new TextEncoder().encode(css), minify: true, targets });
  return new TextDecoder().decode(code);
}

/** Declarations of the minified rule whose selector list is exactly `selector`. */
function shippedRule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})${esc}\\{([^}]*)\\}`).exec(shippedCss());
  if (m === null) throw new Error(`the shipped CSS has no rule "${selector}"`);
  return m[1] ?? '';
}

describe('index.html (app shell)', () => {
  it('loads the classic Unsupported check twice (nomodule + defer) before the module entry, nothing inline', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((m) => m[0].slice(0, m[0].indexOf('>') + 1))).toEqual([
      '<script nomodule src="/unsupported.js">',
      '<script defer src="/unsupported.js">',
      '<script type="module" src="/src/main.ts">',
    ]);
    for (const m of scripts) expect(m[1]?.trim()).toBe('');
  });

  it('is CSP-clean: no inline styles or handlers, one external stylesheet', () => {
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect([...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map((m) => m[0])).toEqual([
      '<link rel="stylesheet" href="/src/ui/theme.css" />',
    ]);
  });

  it('forces the dark scheme and a device-width viewport', () => {
    expect(html).toContain('<meta name="color-scheme" content="dark" />');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
  });

  it('ships the static Unsupported markup visible by default, with a reason slot and the disclaimer', () => {
    const open = /<div id="unsupported"[^>]*>/.exec(html)?.[0];
    expect(open).toBe('<div id="unsupported" role="alert">');
    const start = html.indexOf(open ?? '');
    const block = html.slice(start, html.indexOf('</div>', start));
    expect(block).toContain('<p id="unsupported-reason"></p>');
    expect(block).toContain('MCU1');
    expect(block).toContain('Not affiliated with Tesla, Inc.');
  });

  it('mounts the app into <main id="app"> after the Unsupported block', () => {
    expect(html).toContain('<main id="app"></main>');
    expect(html.indexOf('id="app"')).toBeGreaterThan(html.indexOf('id="unsupported"'));
  });
});

describe('src/ui/theme.css', () => {
  it('forces the dark theme without prefers-color-scheme (spec §3: media queries are unreliable in the car)', () => {
    expect(rule(':root')).toContain('color-scheme: dark;');
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).not.toMatch(/@media[^{]*(pointer|hover)/);
  });

  it('makes [hidden] win over every display rule', () => {
    expect(rule('[hidden]')).toContain('display: none !important;');
  });

  it('sizes touch targets from the runtime --touch variable (minTouchCssPx)', () => {
    expect(rule(':root')).toMatch(/--touch: \d+px;/);
    expect(rule('button')).toContain('min-height: var(--touch);');
    expect(rule('button')).toContain('min-width: var(--touch);');
    expect(rule('button')).toContain('touch-action: manipulation;');
  });

  it('gives bound paddles touch-action: manipulation and a visible flash (src/input/paddles.ts relies on it)', () => {
    expect(rule(`.${PADDLE_CLASS}`)).toContain('touch-action: manipulation;');
    expect(rule(`.${PADDLE_CLASS}.${PADDLE_FLASH_CLASS}`)).toMatch(/background: /);
  });

  it('styles the Unsupported block with literal colours (old WebKit has no custom properties), as shipped', () => {
    const box = rule('#unsupported');
    expect(box).toMatch(/background: #[0-9a-f]{3,6};/);
    expect(box).toMatch(/color: #[0-9a-f]{3,6};/);
    expect(box).not.toContain('var(');
    const shipped = shippedRule('#unsupported');
    expect(shipped).toContain('background:#11161d');
    expect(shipped).toContain('color:#eef2f6');
    expect(shipped).toContain('#ff4a3d');
    expect(shipped).not.toContain('var(');
  });

  it('keeps the page around it dark on old WebKit: literal colours on <html> in a rule of their own, which survive minification', () => {
    const page = rule('html');
    expect(page).toContain('background: #06080b;');
    expect(page).toContain('color: #eef2f6;');
    expect(page).not.toContain('var(');
    const shipped = shippedRule('html');
    expect(shipped).toContain('background:#06080b');
    expect(shipped).toContain('color:#eef2f6');
    expect(shipped).not.toContain('var(');
    // The themed values live on <body>, where a browser without custom properties drops them.
    expect(rule('body')).toContain('background: var(--ink);');
    expect(rule('body')).toContain('color: var(--dial);');
  });

  it('loads no fonts, images or other files (offline, CSP self-only, no brand fonts)', () => {
    expect(css).not.toMatch(/@import|@font-face|url\(/);
  });
});

describe('TSX toolchain (contract: no @preact/preset-vite, no Babel)', () => {
  it('compiles JSX with the automatic runtime from preact', () => {
    const { compilerOptions } = JSON.parse(read('tsconfig.json')) as { compilerOptions: Record<string, unknown> };
    expect(compilerOptions.jsx).toBe('react-jsx');
    expect(compilerOptions.jsxImportSource).toBe('preact');
  });

  it('adds no JSX plugin or Babel to the build', () => {
    const pkg = read('package.json');
    expect(pkg).not.toMatch(/preset-vite|babel/i);
    expect(read('vite.config.ts')).not.toMatch(/preset-vite|babel/i);
  });
});

describe('src/main.ts', () => {
  it('hands the live window and root element to trackTouchSize (its behaviour: tests/unit/ui-app.test.ts)', () => {
    expect(read('src/main.ts')).toContain('trackTouchSize(window, document.documentElement)');
  });
});
