# Tesbox security headers — included by EVERY location in nginx.conf, because nginx drops all
# inherited add_header directives in a location that declares its own add_header.
# Values must equal SECURITY_HEADERS in deploy/csp.ts (enforced by tests/unit/csp.test.ts).
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "geolocation=(self), camera=(), microphone=()" always;
