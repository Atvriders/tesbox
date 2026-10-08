# Tesbox

Tesbox is a free, self-hosted web app for a Tesla's built-in touchscreen browser. It synthesizes a
combustion-engine sound in real time from GPS speed, a real gearbox model and your own Tesla's
performance, and plays it through the cabin speakers. No accounts, no analytics: nothing leaves
the car.

> **Status: Phase 0 — in-car probe.** This build ships the probe page (`/probe/`) that measures
> what the car's browser can do (audio, output routes, steering-wheel events, GPS, storage) before
> the engine sound is built. The main page is a placeholder.

**Not affiliated with or endorsed by Tesla, Inc. or any car manufacturer.** Engine sounds are
synthesized impressions, not recordings of the named cars. Cabin sound only — keep it below
sirens, and never operate the touchscreen while driving.

## Run it

Tesbox is a static site in a public Docker image (`ghcr.io/atvriders/tesbox`, amd64 + arm64,
non-root nginx on port 8080).

```sh
docker compose up -d   # uses docker-compose.yml from this repo
```

You must serve it from **your own public HTTPS domain**, e.g. `https://tesbox.example.com`, via a
reverse proxy or tunnel that forwards to port 8080:

- geolocation and AudioWorklet only work in a secure (HTTPS) context;
- the car's browser cannot reach private LAN addresses.

`docker-compose.yml` publishes port 8080 on `127.0.0.1` only, for a proxy or tunnel on the same
host; its comment shows how to publish it for a proxy on another machine.

The car needs Wi-Fi, a phone hotspot or Premium Connectivity for the first load.

## In the car (Phase 0)

1. Note the build: open `https://tesbox.example.com/version.json` and copy `sha`.
2. In the car's browser open `https://tesbox.example.com/probe/?b=<sha>` (the `b` parameter
   defeats the browser's long-lived HTML cache; keep the trailing slash after `probe`).
3. Follow [`docs/IN_CAR_CHECKLIST.md`](docs/IN_CAR_CHECKLIST.md): parked steps first, driving
   steps only by a passenger, then **Show QR** and scan the codes with a phone.

## Develop

Requires Node ≥ 22.12.

```sh
npm ci
npm run dev          # Vite dev server
npm test             # unit tests (Vitest)
npm run test:e2e     # Playwright: builds, runs `vite preview` with the production headers
npm run verify       # lint + typecheck + unit + build + e2e
npm run gen:anchor   # regenerate public/probe/anchor.wav (deterministic)
```

Header checks (`tests/e2e/headers.spec.ts`) run only against a container:
`E2E_BASE_URL=http://localhost:8080 npx playwright test`.

## Releases (GitHub Actions)

Every push to `master` runs lint, typecheck, unit tests and build, then builds the image, runs it
and runs Playwright against it; only if everything is green it pushes
`ghcr.io/atvriders/tesbox:latest` and `:<commit sha>` for amd64 and arm64. Pull requests run the
same checks without publishing.

The image carries the `org.opencontainers.image.source` label of this repository, so the GHCR
package is linked to the public repository and inherits its visibility. Verify once with an
anonymous `docker pull ghcr.io/atvriders/tesbox:latest`.

**Forks:** publish under your own lower-case `ghcr.io/<owner>/tesbox` (`.github/workflows/ci.yml`,
`docker-compose.yml`) and point the source label (`Dockerfile`, `ci.yml`) at your repository. If
the first push still leaves the package *private*, make it public once under the package's
settings and verify with an anonymous `docker pull`.

## Clean room and licence

Tesbox is implemented from papers, standards and first principles (plus one MIT-licensed
adaptation, the QR encoder, attributed in `NOTICES`); see
[`docs/CLEAN_ROOM.md`](docs/CLEAN_ROOM.md). MIT licence ([`LICENSE`](LICENSE)); attributions in
[`NOTICES`](NOTICES).
