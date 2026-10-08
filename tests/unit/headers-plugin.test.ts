import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { CSP, IMMUTABLE, NO_STORE_PATHS } from '../../deploy/csp';
import { cacheControlFor, headersFor, headersMiddleware, headersPlugin } from '../../deploy/headers-plugin';

function request(url: string): { req: IncomingMessage; res: ServerResponse } {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  return { req, res: new ServerResponse(req) };
}

describe('cacheControlFor (mirrors nginx.conf)', () => {
  it('no-store for every NO_STORE_PATH', () => {
    for (const p of NO_STORE_PATHS) expect(cacheControlFor(p), p).toBe('no-store');
  });

  it('immutable for hashed assets, no-cache for other files, no-store for extension-less SPA paths', () => {
    expect(cacheControlFor('/assets/index-AbC123.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('/probe/anchor.wav')).toBe('no-cache');
    expect(cacheControlFor('/lab')).toBe('no-store');
    expect(cacheControlFor('/probe')).toBe('no-store');
  });
});

describe('headersFor', () => {
  it('returns the security headers plus Cache-Control and ignores the query string', () => {
    const h = headersFor('/version.json?b=abc1234');
    expect(h['Content-Security-Policy']).toBe(CSP);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Permissions-Policy']).toBe('geolocation=(self), camera=(), microphone=()');
    expect(h['Cache-Control']).toBe('no-store');
  });
});

describe('headersMiddleware', () => {
  it('sets the headers, calls next, and pins them against later overrides (Vite sets no-cache on HTML)', () => {
    const { req, res } = request('/probe/');
    const next = vi.fn();
    headersMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getHeader('content-security-policy')).toBe(CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('content-security-policy', "default-src *");
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('content-security-policy')).toBe(CSP);
    res.setHeader('Content-Type', 'text/html');
    expect(res.getHeader('content-type')).toBe('text/html');
  });

  it('handles consecutive requests independently', () => {
    const a = request('/assets/app-1.js');
    const b = request('/index.html');
    headersMiddleware(a.req, a.res, () => undefined);
    headersMiddleware(b.req, b.res, () => undefined);
    expect(a.res.getHeader('cache-control')).toBe(IMMUTABLE);
    expect(b.res.getHeader('cache-control')).toBe('no-store');
    b.res.setHeader('Cache-Control', 'max-age=60');
    expect(b.res.getHeader('cache-control')).toBe('no-store');
    expect(a.res.getHeader('cache-control')).toBe(IMMUTABLE);
  });

  it('redirects /probe to /probe/ with a relative Location, keeping the query', () => {
    const { req, res } = request('/probe?b=abc1234');
    const next = vi.fn();
    headersMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(301);
    expect(res.getHeader('location')).toBe('/probe/?b=abc1234');
  });
});

describe('headersPlugin', () => {
  it('registers the middleware on the preview server only', () => {
    const plugin = headersPlugin();
    expect(plugin.name).toBe('tesbox-headers');
    expect(plugin.configureServer).toBeUndefined();
    const use = vi.fn();
    expect(typeof plugin.configurePreviewServer).toBe('function');
    const hook = plugin.configurePreviewServer as unknown as (server: { middlewares: { use: typeof use } }) => void;
    hook({ middlewares: { use } });
    expect(use).toHaveBeenCalledWith(headersMiddleware);
  });

  it('is wired into vite.config.ts', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toMatch(/import \{ headersPlugin \} from '\.\/deploy\/headers-plugin(\.ts)?';/);
    expect(config).toContain('headersPlugin()');
  });
});
