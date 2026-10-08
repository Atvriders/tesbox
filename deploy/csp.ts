/**
 * Single source of truth for Tesbox HTTP response headers (spec §12).
 * Consumers: deploy/headers-plugin.ts (vite preview), deploy/security-headers.inc + nginx.conf
 * (container; kept identical by tests/unit/csp.test.ts) and tests/e2e/headers.spec.ts.
 */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'";

/** Paths that must never be cached (the Tesla browser caches HTML indefinitely, spec §3). */
export const NO_STORE_PATHS = [
  '/',
  '/index.html',
  '/sw.js',
  '/version.json',
  '/probe/',
  '/probe/index.html',
  '/probe/sw.js',
];

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};

/** Cache-Control for content-hashed build output under /assets/. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
