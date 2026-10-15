/**
 * Vite preview-server headers that mirror nginx.conf, so local e2e runs (no Docker) see the same
 * CSP and caching rules as the container (spec §12). Dev server (`vite`) is deliberately untouched.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { IMMUTABLE, NO_STORE_PATHS, SECURITY_HEADERS } from './csp.ts';

/** Mirrors nginx.conf: /assets/ immutable; NO_STORE_PATHS and extension-less (SPA/HTML) paths no-store; other files no-cache. */
export function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) return IMMUTABLE;
  if (NO_STORE_PATHS.includes(pathname)) return 'no-store';
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.includes('.') ? 'no-cache' : 'no-store';
}

/** All headers for a request URL (query string ignored). */
export function headersFor(url: string): Record<string, string> {
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  return { ...SECURITY_HEADERS, 'Cache-Control': cacheControlFor(pathname) };
}

/**
 * Sets `headers` and pins them: later setHeader() calls for the same names (e.g. Vite's own
 * `Cache-Control: no-cache` on HTML) are ignored, so nginx and preview agree.
 */
function pinHeaders(res: ServerResponse, headers: Record<string, string>): void {
  const owned = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
    owned.add(name.toLowerCase());
  }
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) =>
    owned.has(name.toLowerCase()) ? res : setHeader(name, value)) as ServerResponse['setHeader'];
}

/** Pages that resolve relative to their directory: the bare path redirects to it, as nginx does. */
const SLASH_REDIRECTS: readonly string[] = ['/probe', '/lab'];

/** Connect middleware: pins headers; redirects /probe → /probe/ and /lab → /lab/ like nginx (relative Location). */
export function headersMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const pathname = q === -1 ? url : url.slice(0, q);
  const search = q === -1 ? '' : url.slice(q);
  pinHeaders(res, headersFor(url));
  if (SLASH_REDIRECTS.includes(pathname)) {
    res.statusCode = 301;
    res.setHeader('Location', `${pathname}/${search}`);
    res.end();
    return;
  }
  next();
}

export function headersPlugin(): Plugin {
  return {
    name: 'tesbox-headers',
    configurePreviewServer(server) {
      // Registered directly (not via a returned post-hook) so it runs before Vite's static middleware.
      server.middlewares.use(headersMiddleware);
    },
  };
}
