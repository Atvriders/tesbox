import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP, IMMUTABLE, NO_STORE_PATHS, SECURITY_HEADERS } from '../../deploy/csp';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const INCLUDE = 'include /etc/nginx/conf.d/security-headers.inc;';

/** nginx.conf `location` blocks (this config never nests braces inside a location). */
function locationBlocks(conf: string): { head: string; body: string }[] {
  const blocks: { head: string; body: string }[] = [];
  const re = /^\s*location\s+([^{\n]+)\{([^}]*)\}/gm;
  for (let m = re.exec(conf); m !== null; m = re.exec(conf)) {
    blocks.push({ head: (m[1] ?? '').trim(), body: m[2] ?? '' });
  }
  return blocks;
}

describe('deploy/csp.ts', () => {
  it('locks the CSP: self-only, no inline/eval, no third parties, blob: media for the media-element route, no form targets', () => {
    expect(CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
    );
    expect(CSP).not.toMatch(/unsafe-|https?:|\*/);
  });

  it('exposes the security header set and cache constants', () => {
    expect(SECURITY_HEADERS).toEqual({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    });
    expect(IMMUTABLE).toBe('public, max-age=31536000, immutable');
    expect(NO_STORE_PATHS).toEqual(['/', '/index.html', '/sw.js', '/version.json', '/probe/', '/probe/index.html', '/probe/sw.js']);
  });
});

describe('deploy/security-headers.inc', () => {
  it('contains exactly one `add_header … always;` line per SECURITY_HEADERS entry, values verbatim', () => {
    const lines = read('deploy/security-headers.inc')
      .split('\n')
      .filter((l) => l.startsWith('add_header'));
    expect(lines).toEqual(Object.entries(SECURITY_HEADERS).map(([k, v]) => `add_header ${k} "${v}" always;`));
  });
});

describe('nginx.conf', () => {
  const conf = (): string => read('nginx.conf');
  const blocks = (): { head: string; body: string }[] => locationBlocks(conf());

  it('nginx.conf + security-headers.inc together carry the CSP verbatim and every NO_STORE_PATH', () => {
    const both = conf() + read('deploy/security-headers.inc');
    expect(both).toContain(CSP);
    for (const p of NO_STORE_PATHS) expect(conf()).toContain(`location = ${p} {`);
  });

  it('every location includes the security headers (add_header is not inherited)', () => {
    const all = blocks();
    expect(all.length).toBeGreaterThanOrEqual(NO_STORE_PATHS.length + 3);
    for (const b of all) expect(b.body, `location ${b.head}`).toContain(INCLUDE);
  });

  it('NO_STORE_PATHS send no-store (also on 404), /assets/ is immutable but not on errors', () => {
    const all = blocks();
    for (const p of NO_STORE_PATHS) {
      const block = all.find((b) => b.head === `= ${p}`);
      expect(block?.body, p).toContain('add_header Cache-Control "no-store" always;');
    }
    const assets = all.find((b) => b.head === '/assets/');
    expect(assets?.body).toContain(`add_header Cache-Control "${IMMUTABLE}";`);
  });

  it('serves on 8080 with relative redirects, MIME additions, gzip and the SPA fallback', () => {
    const c = conf();
    const all = blocks();
    expect(c).toMatch(/listen 8080;/);
    expect(c).toContain('absolute_redirect off;');
    expect(c).toContain('include /etc/nginx/mime.types;');
    for (const t of ['application/javascript mjs;', 'application/manifest+json webmanifest;', 'audio/wav wav;']) {
      expect(c).toContain(t);
    }
    // nginx's own mime.types already maps wasm: redeclaring it logs a "duplicate extension" warning (C8.6).
    expect(c).not.toContain('application/wasm wasm;');
    expect(c).toContain('gzip on;');
    expect(c).toMatch(/gzip_types[^;]*application\/javascript/);
    expect(all.find((b) => b.head === '/')?.body).toContain('try_files $uri $uri/ /index.html;');
    expect(all.find((b) => b.head === '= /probe')?.body).toContain('return 301 /probe/$is_args$args;');
  });
});

describe('Dockerfile and docker-compose.yml', () => {
  it('builds on the build platform and serves dist from non-root nginx with the include installed', () => {
    const df = read('Dockerfile');
    for (const line of [
      'FROM --platform=$BUILDPLATFORM node:22-alpine AS build',
      'ARG GITHUB_SHA',
      'ENV GITHUB_SHA=$GITHUB_SHA',
      'RUN npm ci',
      'RUN npm run build',
      'FROM nginxinc/nginx-unprivileged:alpine',
      'COPY nginx.conf /etc/nginx/conf.d/default.conf',
      'COPY deploy/security-headers.inc /etc/nginx/conf.d/security-headers.inc',
      'COPY --from=build /app/dist /usr/share/nginx/html',
      'EXPOSE 8080',
      'wget -qO- http://127.0.0.1:8080/version.json',
    ]) {
      expect(df).toContain(line);
    }
  });

  it('labels the runtime image with its source repo, so the GHCR package inherits public visibility (amendment C6)', () => {
    const df = read('Dockerfile');
    // A LABEL in the build stage would not reach the published image: it must follow the runtime FROM.
    const runtime = df.slice(df.indexOf('FROM nginxinc/nginx-unprivileged:alpine'));
    expect(runtime).toContain('LABEL org.opencontainers.image.source="https://github.com/Atvriders/tesbox"');
  });

  it('compose pulls the public GHCR image and uses the placeholder domain only', () => {
    const compose = read('docker-compose.yml');
    expect(compose).toContain('image: ghcr.io/atvriders/tesbox:latest');
    expect(compose).toContain('https://tesbox.example.com');
  });

  it('compose publishes 8080 on loopback only by default, with a comment on exposing it to a remote proxy (C8.9)', () => {
    const compose = read('docker-compose.yml');
    const active = compose.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(active.filter((l) => /^\s+- "[\d.:]+"$/.test(l)).map((l) => l.trim())).toEqual(['- "127.0.0.1:8080:8080"']);
    const ports = compose.slice(compose.indexOf('    ports:'));
    expect(ports).toMatch(/^ {4}ports:\n(?: {6}#.*\n)+ {6}- "127\.0\.0\.1:8080:8080"\n/);
  });
});
