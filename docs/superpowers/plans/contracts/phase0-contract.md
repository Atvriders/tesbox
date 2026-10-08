# Phase 0 Contract — In-car probe + pipeline (LOCKED)

Authoritative for every Phase 0 task. Formulas/types here beat prose anywhere else. Spec:
`docs/superpowers/specs/2026-10-06-tesbox-design.md` (§3, §6.4, §12, §15 Phase 0, §16). Shared
types: `src/contracts.ts` (exists; do not modify in Phase 0 except to import from it).

## Toolchain (exact)

- Node ≥ 22.12 locally (sandbox has v24) and `node:22-alpine` in Docker/CI.
- devDependencies (caret ranges): `vite ^8.3.3`, `vitest ^5.0.3`, `typescript ~6.0.3`,
  `@playwright/test ^1.63.0`, `jsqr ^1.4.0` (tests only), `tsx ^4.23.15`, `@types/node ^24`,
  `eslint ^10.12.0`, `typescript-eslint ^8.71.1`, `@eslint/js ^10`.
- No runtime dependencies in Phase 0 (Preact arrives in Phase 3).
- `package.json`: `"name": "tesbox"`, `"private": true`, `"type": "module"`, `"license": "MIT"`,
  `"engines": { "node": ">=22.12" }`. Scripts:
  - `dev`: `vite`
  - `build`: `vite build`
  - `preview`: `vite preview --port 4173 --strictPort`
  - `typecheck`: `tsc --noEmit -p tsconfig.json`
  - `lint`: `eslint .`
  - `test`: `vitest run`
  - `test:e2e`: `playwright test`
  - `gen:anchor`: `tsx tools/make-anchor-wav.ts`
  - `verify`: `npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e`
- `tsconfig.json`: `strict: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: Bundler`,
  `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `noUncheckedIndexedAccess: true`, `noEmit: true`,
  `isolatedModules: true`, `types: ["vite/client", "node"]`; include `src`, `tests`, `tools`,
  `deploy`, `*.config.ts`, `probe`.
- Vite (`vite.config.ts`): multi-page input `{ main: 'index.html', probe: 'probe/index.html' }`
  (use `build.rollupOptions.input`; if Vite 8 warns it is deprecated, use `build.rolldownOptions`
  — whichever the installed version accepts without warning), `build.assetsInlineLimit: 0`,
  `define: { __BUILD_SHA__: JSON.stringify(sha) }`, plugins: `versionPlugin(sha)` (emits
  `version.json`) and `headersPlugin()` (preview server headers). Vitest config lives in the same
  file under `test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' }`.
- SHA resolution (`deploy/build-sha.ts`, exported `resolveBuildSha(env = process.env): string`):
  `env.GITHUB_SHA?.slice(0, 7)` → else `git rev-parse --short HEAD` (execSync, stderr ignored) →
  else `'dev'`.
- ESLint flat config (`eslint.config.js`): `@eslint/js` recommended + `typescript-eslint`
  recommended; ignore `dist`, `node_modules`, `test-results`, `playwright-report`, `public`.

## File map (Phase 0 creates exactly these; one responsibility each)

| Path | Responsibility | Task |
|---|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `.gitignore`, `.dockerignore` | tooling | T1 |
| `index.html` | app shell placeholder + static Unsupported markup | T1 |
| `src/main.ts` | placeholder boot: hides `#unsupported`, shows "Tesbox — under construction. Open /probe/" + SHA | T1 |
| `src/env.d.ts` | `declare const __BUILD_SHA__: string;` + `/// <reference types="vite/client" />` | T1 |
| `src/types/audioworklet.d.ts` | globals for AudioWorkletGlobalScope (`AudioWorkletProcessor`, `registerProcessor`, `currentTime`, `sampleRate`) | T1 |
| `deploy/build-sha.ts`, `deploy/version-plugin.ts` | SHA + `version.json` emission | T1 |
| `src/platform/build-info.ts` | `BUILD_SHA`, `checkVersion()` | T1 |
| `src/platform/storage.ts` | safe localStorage wrapper | T2 |
| `src/platform/detect.ts` | feature detection, MCU guess, viewport | T2 |
| `src/platform/qr.ts` | in-house QR encoder + canvas draw + text chunking | T3 |
| `src/probe/log.ts` | event log ring buffer | T4 |
| `src/probe/summary.ts` | `ProbeSummary` assembly + privacy guard | T4 |
| `src/platform/geo.ts` | `haversineM` (shared with Phase 1 SimCore) | T5 |
| `src/probe/gps-stats.ts` | pure GPS statistics | T5 |
| `src/probe/gps.ts` | geolocation runner (poll/watch × highAccuracy) + crash marker | T5 |
| `src/probe/work.ts` | synthetic DSP work kernel | T6 |
| `src/probe/audio-protocol.ts` | probe ↔ worklet message types | T6 |
| `src/probe/audio-worklet.ts` | `registerProcessor('tesbox-probe', …)` | T6 |
| `src/probe/drift.ts` | pure audio-clock drift monitor | T6 |
| `src/probe/audio.ts` | AudioContext lifecycle, 3 routes, Media Session, benchmark, recovery, hidden-clock check | T7 |
| `src/probe/inputs.ts` | Media Session/keys/wheel/gamepad/DeviceMotion/visibility logging | T8 |
| `src/probe/storage-probe.ts` | SW registration, Cache Storage round-trip, persistence report | T9 |
| `public/probe/sw.js` | minimal probe service worker | T9 |
| `tools/make-anchor-wav.ts`, `public/probe/anchor.wav` | 10 s near-silent anchor file (committed) | T9 |
| `probe/index.html`, `src/probe/main.ts`, `src/probe/probe.css` | probe page UI + wiring | T10 |
| `deploy/csp.ts`, `deploy/headers-plugin.ts` | CSP/header rules + Vite preview headers | T11 |
| `nginx.conf`, `Dockerfile`, `docker-compose.yml` | container | T11 |
| `playwright.config.ts`, `tests/e2e/*.spec.ts` | e2e | T12 |
| `.github/workflows/ci.yml` | CI | T12 |
| `docs/IN_CAR_CHECKLIST.md`, `docs/CLEAN_ROOM.md`, `README.md`, `NOTICES`, `LICENSE` | docs | T12 |
| `tests/unit/*.test.ts` | unit tests (one file per module, named `<module>.test.ts`) | each task |

## Module APIs (exact)

```ts
// src/platform/build-info.ts
export const BUILD_SHA: string;                         // = __BUILD_SHA__
export interface VersionCheck { local: string; remote: string | null; stale: boolean; error?: string }
export function checkVersion(fetchFn?: typeof fetch, url?: string): Promise<VersionCheck>;
// fetches url (default new URL('/version.json', location.origin).href) with { cache: 'no-store' };
// stale = remote !== null && remote !== local. Network/parse failure → remote null, stale false, error set.

// deploy/version-plugin.ts
export function versionPlugin(sha: string): import('vite').Plugin;  // emits version.json {"sha","builtAt"}
export function makeVersionJson(sha: string, builtAt: string): string; // pure, used by plugin + test

// src/platform/storage.ts  (prefix "tesbox.v1.")
export function storageAvailable(): boolean;
export function getJSON<T>(key: string, fallback: T): T;   // try/catch; corrupt → fallback
export function setJSON(key: string, value: unknown): boolean;
export function remove(key: string): void;

// src/platform/detect.ts
export type Mcu = 'intel' | 'amd' | 'unknown';
export function parseMcu(renderer: string | null): Mcu;
//   /intel|mesa dri intel|hd graphics|apollolake|apl/i → 'intel'; /amd|radeon|raven|vega|picasso|ryzen/i → 'amd'
export function getWebglRenderer(): string | null;          // WEBGL_debug_renderer_info, null if unavailable
export interface Features { audioWorklet: boolean; serviceWorker: boolean; cacheStorage: boolean;
  mediaSession: boolean; gamepad: boolean; deviceMotion: boolean; geolocation: boolean;
  crossOriginIsolated: boolean; fullscreen: boolean; esModules: true; webgl: boolean;
  outputTimestamp: boolean; mediaStreamDestination: boolean }
export function detectFeatures(): Features;
export interface ViewportInfo { dpr: number; screen: [number, number]; inner: [number, number];
  visual: [number, number] | null; maxTouchPoints: number }
export function viewportInfo(): ViewportInfo;
// minTouchCssPx comes from src/contracts.ts (do not re-implement)

// src/platform/qr.ts  (ISO/IEC 18004: byte mode, ECC level L, versions 1–40, all 8 masks, penalty rules N1–N4)
export interface QrMatrix { size: number; modules: Uint8Array }   // size×size, 1 = dark, row-major
export function encodeQr(text: string): QrMatrix;                 // UTF-8 bytes; throws RangeError if > 2953 bytes
export function chunkText(text: string, maxBytes?: number): string[]; // default 1100; each chunk prefixed "TBX i/n\n"
export function drawQr(canvas: HTMLCanvasElement, m: QrMatrix, scale?: number, quiet?: number): void; // default scale 6, quiet 4

// src/probe/log.ts
export type LogKind = 'mediasession' | 'key' | 'wheel' | 'gamepad' | 'visibility' | 'audio' | 'gps' | 'motion' | 'storage' | 'note' | 'error';
export interface LogEntry { tMs: number; kind: LogKind; detail: string }   // tMs = performance.now() at push
export class EventLog {
  constructor(capacity?: number);                   // default 500, ring buffer
  push(kind: LogKind, detail: string, tMs?: number): void;
  entries(): LogEntry[];                            // oldest → newest
  count(kind?: LogKind): number;                    // total ever pushed (not just retained)
  subscribe(fn: (e: LogEntry) => void): () => void; // returns unsubscribe
}

// src/probe/gps-stats.ts
export interface GpsFix { arrivalPerfMs: number; arrivalEpochMs: number; timestampMs: number;
  lat: number; lon: number; accuracyM: number; speedMps: number | null; altitudeM: number | null; hidden: boolean }
export interface GpsModeSummary { mode: string; durationS: number; fixes: number;
  errors: { permission: number; unavailable: number; timeout: number };
  intervalMedianMs: number | null; intervalP95Ms: number | null; ageMedianMs: number | null; ageP95Ms: number | null;
  staleOver3sPct: number; duplicatePct: number; speedNullPct: number; speedZeroPct: number;
  speedZeroWhileMovingPct: number; accuracyMedianM: number | null; altitudePresentPct: number;
  fixesWhileHidden: number; maxSpeedMps: number | null; crashedPreviously: boolean }
// haversineM is imported from src/platform/geo.ts:
//   export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number; // R = 6371008.8 m
export class GpsStats {
  constructor(mode: string);
  add(fix: GpsFix): void;
  addError(code: 1 | 2 | 3): void;
  summary(durationS: number, crashedPreviously: boolean): GpsModeSummary;
}
// Definitions: interval = consecutive arrivalPerfMs deltas; age = arrivalEpochMs − timestampMs;
// stale = age > 3000; duplicate = same (timestampMs, lat, lon) as the previous fix;
// speedZeroWhileMoving = speedMps === 0 while haversine displacement from the fix ≥ 5 s earlier
// (nearest earlier fix with arrival ≤ now − 5000) is > 20 m; percentages are of `fixes`, 0 when fixes = 0;
// medians/p95 via nearest-rank on sorted arrays, null when empty.

// src/probe/gps.ts
export interface GpsMode { method: 'poll' | 'watch'; highAccuracy: boolean }
export const GPS_MODES: GpsMode[];   // poll/false, poll/true, watch/false, watch/true (this order)
export function modeName(m: GpsMode): string;  // e.g. "poll-hiacc-off"
export const CRASH_KEY = 'probe.gpsRun';       // storage key (prefix added by storage.ts)
export class GpsRunner {
  constructor(geo: Geolocation, log: EventLog, now?: () => number /* performance.now */);
  readonly running: boolean;
  /** Writes crash marker {mode, startedAt}, runs for durationS, clears marker, resolves summary. */
  run(mode: GpsMode, durationS: number, isHidden?: () => boolean): Promise<GpsModeSummary>;
  stop(): void;
  static previousCrash(): { mode: string; startedAt: string } | null;  // reads + clears marker
}
// poll: exactly one getCurrentPosition in flight; options {enableHighAccuracy, timeout: 2000, maximumAge: 0};
// next request when the previous settles, but not sooner than 1000 ms after the previous request started.
// watch: watchPosition with {enableHighAccuracy, timeout: 2000, maximumAge: 0}; clearWatch on stop.
// Coordinates are kept only inside GpsStats; never logged (log detail = "fix age=…ms acc=…m speed=…").

// src/probe/work.ts
export const WORK_OPS_PER_SAMPLE = 400;   // ≈ estimated Full-tier DSP cost per sample (spec §5.7)
export class WorkKernel {
  constructor();                            // allocates Float64Array(64) state once
  run(frames: number, k: number): number;   // performs k × 400 multiply-adds per frame; returns a checksum
}

// src/probe/audio-protocol.ts
export type ProbeToWorklet =
  | { type: 'config'; k: number; toneHz: number; gainDb: number }
  | { type: 'ping'; id: number };
export type WorkletToProbe =
  | { type: 'report'; quanta: number; perfInWorklet: boolean; busyMs: number; windowMs: number;
      sampleRate: number; currentTime: number }          // every ~250 ms of audio time
  | { type: 'pong'; id: number; currentTime: number };

// src/probe/audio-worklet.ts — registerProcessor('tesbox-probe', class …)
// Output: stereo pulse-train tone at toneHz (default 55 Hz, gainDb default −18): a 2 ms raised-cosine
// pulse per period, low-passed by a one-pole at 2 kHz. Runs WorkKernel.run(frames, k) each quantum.
// busyMs measured with performance.now() if typeof performance !== 'undefined', else Date.now();
// perfInWorklet = (typeof performance !== 'undefined' && typeof performance.now === 'function').
// Node options used by the main thread: { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }.

// src/probe/drift.ts
export interface DriftSample { contextTimeS: number; perfMs: number }
export interface DriftWindow { ratio: number; overloaded: boolean }
export class DriftMonitor {
  constructor(windowMs?: number /* 1000 */, threshold?: number /* 0.98 */);
  /** Feed getOutputTimestamp() pairs (~every 100 ms). Returns a window result each time ≥ windowMs elapsed, else null. */
  push(s: DriftSample): DriftWindow | null;
  /** True after ≥ 2 consecutive windows with ratio < threshold. */
  readonly overloaded: boolean;
  reset(): void;
}
// ratio = Δ(contextTimeS)·1000 / Δ(perfMs) over the window. Samples where contextTimeS === 0 are ignored.

// src/probe/audio.ts
import type { OutputRoute } from '../contracts';
export interface BenchResult { k: number; ratio: number; overloaded: boolean; busyFrac: number | null }
export interface AudioProbeState { state: AudioContextState | 'none'; sampleRate: number | null;
  baseLatency: number | null; outputLatency: number | null; latencyHint: 'balanced' | 'playback';
  route: OutputRoute | null; perfInWorklet: boolean | null; quanta: number; recoveries: { resumeOk: number; resumeFail: number; recreate: number } }
export class AudioProbe {
  constructor(log: EventLog, workletUrl: string, anchorUrl: string);
  /** MUST be called from a click handler. Creates the context, adds the module, connects the route, registers Media Session. */
  start(route: OutputRoute, latencyHint: 'balanced' | 'playback'): Promise<void>;
  setRoute(route: OutputRoute): Promise<void>;     // reconnects without recreating the context
  setK(k: number): void;
  /** Runs each k for secondsEach using DriftMonitor + worklet busy reports; returns all results; headroomK = largest k not overloaded (0 if k=1 overloaded). */
  benchmark(ks?: number[] /* [1,2,4,8,16] */, secondsEach?: number /* 3 */): Promise<{ results: BenchResult[]; headroomK: number }>;
  resume(): Promise<boolean>;                       // from a tap; logs result
  recreate(): Promise<void>;                        // close + new context inside the tap; re-adds module, route, session
  /** Ratio of audio-clock advance to wall time across the last hidden period, null if never hidden. */
  readonly hiddenClockRatio: number | null;
  readonly snapshot: AudioProbeState;
  stop(): Promise<void>;
}
// Routes (spec §6.4): 'direct' = node→destination; 'media-element' = node→MediaStreamAudioDestinationNode→
// <audio>.srcObject.play(); 'direct-anchor' = node→destination + <audio src=anchorUrl loop> .play().
// Media Session on every route: metadata {title:'Tesbox probe', artist:'Tesbox'}, playbackState='playing',
// handlers play/pause/stop/nexttrack/previoustrack/seekbackward/seekforward → log('mediasession', action).
// statechange → log('audio', state). Never call suspend().

// src/probe/inputs.ts
export interface InputCounts { mediaSession: Record<string, number>; keys: string[]; wheel: number;
  gamepads: string[]; visibilityChanges: number }
export interface MotionReport { available: boolean; permission: 'granted' | 'denied' | 'not-required' | 'error';
  events: number; rateHz: number | null; accelRange: [number, number] | null }
export class InputProbe {
  constructor(log: EventLog, target?: Window);
  attach(): void;          // keydown/keyup (key, code, keyCode), wheel (deltaX/Y, deltaMode), visibilitychange, gamepad polling via rAF
  detach(): void;
  readonly counts: InputCounts;
  /** Listens to devicemotion for durationMs (requests permission if DeviceMotionEvent.requestPermission exists). Never uses deviceorientation. */
  probeMotion(durationMs?: number /* 5000 */): Promise<MotionReport>;
}

// src/probe/storage-probe.ts
export interface StorageReport { localStorage: boolean; visits: number; firstSeen: string | null; lastSeen: string | null;
  cacheStorage: boolean; cachePersisted: boolean | null; cacheAgeS: number | null;
  swSupported: boolean; swRegistered: boolean; swControlled: boolean; error?: string }
export function runStorageProbe(nowIso?: string): Promise<StorageReport>;
// localStorage keys (via storage.ts): 'probe.visits' (number), 'probe.firstSeen', 'probe.lastSeen'.
// Cache: caches.open('tesbox-probe') → match('__persist') (previous visit) → put('__persist', new Response(JSON {ts})).
// SW: navigator.serviceWorker.register('./sw.js', { scope: './' }) relative to /probe/.

// src/probe/summary.ts
export interface RouteObservation { miniplayer: 'yes' | 'no' | '?'; survivesMinimise: 'yes' | 'no' | '?';
  wheelTilt: 'yes' | 'no' | '?'; music: 'paused' | 'mixed' | '?'; hiddenClockRatio: number | null }
export interface ProbeSummary {
  v: 1; sha: string; at: string;                       // at = ISO timestamp
  env: { ua: string; viewport: ViewportInfo; webgl: string | null; mcu: Mcu; features: Features };
  audio: (AudioProbeState & { bench: BenchResult[]; headroomK: number | null }) | null;
  routes: Partial<Record<OutputRoute, RouteObservation>>;
  gps: GpsModeSummary[];
  motion: MotionReport | null;
  storage: StorageReport | null;
  inputs: InputCounts;
  notes: Record<string, string>;
  logTail: string[];                                   // last ≤ 40 entries formatted "t=12.3s kind detail"
}
export function buildSummary(parts: Omit<ProbeSummary, 'v' | 'logTail'>, log: EventLog): ProbeSummary;
export const FORBIDDEN_KEYS: readonly string[];        // ['lat','lon','latitude','longitude','coords','position']
export function assertNoCoordinates(value: unknown): void; // throws Error naming the path if any key in FORBIDDEN_KEYS appears at any depth
// buildSummary calls assertNoCoordinates before returning.
```

## Probe page (T10) behaviour

Sections (each a `<section>` with an `<h2>` and a stable `id`):

1. `#build` — SHA, `checkVersion()` result ("Up to date" / "Stale build — reload with ?b=<remote sha>").
2. `#env` — viewport, dpr, WebGL renderer, MCU guess, feature table.
3. `#audio` — latencyHint radio (balanced/playback), route radio (3 routes), **Start audio**
   (click), **Resume**, **Recreate**, **Benchmark** (full: [1,2,4,8,16]×3 s; e2e uses
   `?quickbench=1` → [1,2]×1 s), live readout of `snapshot` + last report; per-route observation
   button groups for miniplayer / survivesMinimise / wheelTilt / music (yes/no/? and
   paused/mixed/?).
4. `#gps` — mode list with **Run 60 s** per mode (e2e uses `?gpsSeconds=4`), live fix counter,
   table of summaries; banner if `GpsRunner.previousCrash()` returned a mode.
5. `#inputs` — live event log (last 30), counts, **Probe motion (5 s)**.
6. `#storage` — storage report (runs on load).
7. `#export` — **Show QR**: `buildSummary` → `JSON.stringify` → `chunkText` → one canvas per chunk
   with "QR i/n" captions; also a `<pre>` with the JSON.

All buttons ≥ `minTouchCssPx(devicePixelRatio)` tall. Dark theme forced in `probe.css` (no
`prefers-color-scheme` reliance). Query params: `quickbench=1`, `gpsSeconds=<n>`, `b=<sha>` (ignored,
cache-buster only).

## Headers (T11) — `deploy/csp.ts` is the single source

```ts
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
export const NO_STORE_PATHS = ['/', '/index.html', '/sw.js', '/version.json', '/probe/', '/probe/index.html', '/probe/sw.js'];
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()' };
export const IMMUTABLE = 'public, max-age=31536000, immutable';
```

nginx (`nginxinc/nginx-unprivileged:alpine`, listens 8080, non-root): every `location` includes
the same security headers (nginx `add_header` does not inherit into locations that declare their
own) — use an `include /etc/nginx/conf.d/security-headers.inc;` written by the Dockerfile from
the repo file `deploy/security-headers.inc`. `/assets/` → `Cache-Control: IMMUTABLE`; NO_STORE_PATHS
→ `Cache-Control: no-store`; `types { application/javascript mjs; application/manifest+json webmanifest; application/wasm wasm; }`
added; gzip on for text types; SPA fallback `try_files $uri $uri/ /index.html`. A unit test reads
`nginx.conf` and `deploy/security-headers.inc` and asserts they contain `CSP` verbatim and every
NO_STORE_PATH. `HEALTHCHECK` uses `wget -qO- http://127.0.0.1:8080/version.json`.

Dockerfile: `FROM --platform=$BUILDPLATFORM node:22-alpine AS build` (`ARG GITHUB_SHA`, `ENV
GITHUB_SHA=$GITHUB_SHA`, `npm ci`, `npm run build`) → `FROM nginxinc/nginx-unprivileged:alpine`,
copy `nginx.conf` to `/etc/nginx/conf.d/default.conf`, security include, `dist/` to
`/usr/share/nginx/html`, `EXPOSE 8080`.

## CI (T12) — `.github/workflows/ci.yml`

Trigger: push to `master`, pull_request. Permissions: `contents: read`, `packages: write`.
Jobs: `test` (node 22, `npm ci`, lint, typecheck, `npm test`, build) → `e2e` (buildx `--load`
amd64 image tagged `tesbox:ci` with `GITHUB_SHA` build-arg, `docker run -d -p 8080:8080`, wait for
`/version.json`, `npx playwright install --with-deps chromium`, `E2E_BASE_URL=http://localhost:8080
npx playwright test`, upload report on failure) → `publish` (only on push to master; login to
`ghcr.io` with `GITHUB_TOKEN`; `docker/build-push-action` platforms `linux/amd64,linux/arm64`, tags
`ghcr.io/atvriders/tesbox:latest` and `ghcr.io/atvriders/tesbox:${{ github.sha }}`, `cache-from/to:
type=gha`). Pin actions by major version (`actions/checkout@v4`, `actions/setup-node@v4`,
`docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`,
`docker/build-push-action@v6`, `actions/upload-artifact@v4`).

## Playwright (T12)

`playwright.config.ts`: Chromium only; `baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173'`;
`webServer` only when `E2E_BASE_URL` is unset: `npm run build && npm run preview`; launch args
`--autoplay-policy=no-user-gesture-required`. Specs:
`tests/e2e/shell.spec.ts` (index loads, `#unsupported` hidden after boot, SHA shown),
`tests/e2e/probe-audio.spec.ts` (Start audio → quanta > 0 within 3 s; switch to each route; quick
benchmark completes with 2 results), `tests/e2e/probe-gps.spec.ts` (grant geolocation,
`context.setGeolocation` stepped every 500 ms, `?gpsSeconds=4` poll run → summary fixes ≥ 2),
`tests/e2e/probe-qr.spec.ts` (Show QR → read first canvas `ImageData` → decode in Node with `jsqr` →
text starts with `TBX 1/` → after reassembling all chunks, JSON parses, `v === 1`, no forbidden
keys), `tests/e2e/headers.spec.ts` (`test.skip(!process.env.E2E_BASE_URL)`: CSP on `/` and
`/probe/`; `no-store` on every NO_STORE_PATH; `immutable` on one `/assets/*.js` found by parsing
`/index.html`; `content-type` of that asset contains `javascript`).

## Conventions

- Tests: Vitest, `describe`/`it`, one file per module `tests/unit/<module>.test.ts`; Node env; DOM
  pieces faked with minimal objects (no jsdom dependency).
- No real coordinates, hostnames or IPs in code, tests, fixtures or docs (use 0,0-based fake
  positions in tests; README domain placeholder `https://tesbox.example.com`).
- Each task ends by running its tests, then `npm run lint && npm run typecheck`. **No per-task git
  commits** — Phase 0 lands as one commit after full verification (user preference; phase-level
  commit + push approved).
- Copy rules: no Tesla logos/marks; text "Tesbox" plain; footer "Not affiliated with Tesla, Inc."

## Amendments (2026-10-06, authoritative)

- **C1** `vite.config.ts` imports `defineConfig` from `'vitest/config'` (the `test` key otherwise
  fails typecheck with TS2769 under Vite 8 / Vitest 5). Config imports of local TS files use the
  `.ts` extension with `allowImportingTsExtensions: true` in tsconfig (noEmit permits it).
- **C2** `build.rolldownOptions.input` (Vite 8.3 marks `rollupOptions` deprecated).
- **C3** Each agent/implementer uses its own scratch directory; never a shared one.
- **C4** nginx adds `audio/wav wav;` to its types (stock mime.types lacks it).
- **C5** `encodeQr` never emits version 23 (jsqr 1.4.0 mis-reads v23 alignment patterns); payloads
  that would need v23 use v24.
- **C6** The image carries `LABEL org.opencontainers.image.source="https://github.com/Atvriders/tesbox"`
  (Dockerfile) and the CI `docker/build-push-action` passes the same via `labels:` — with
  `GITHUB_TOKEN` publishing, the GHCR package then inherits the public repo's visibility (no manual
  toggle). CI also sets `org.opencontainers.image.revision=${{ github.sha }}`.
- **C7 (security review)** CI pins every action to a full commit SHA with the version as a comment,
  and permissions are least-privilege: workflow-level `permissions: { contents: read }`; only the
  `publish` job gets `permissions: { contents: read, packages: write }`. Pins (resolved 2026-10-07):
  - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0`
  - `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2`
  - `docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3.7.0`
  - `docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0`
  - `docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0`
  - `docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2`
  The `repo-files` unit test (if present) asserts every `uses:` line matches `@[0-9a-f]{40}`.
- **C8 (whole-phase review, 2026-10-08):**
  1. QR fits the in-motion viewport: `.qr canvas { max-width: 100%; max-height: calc(100svh - 24px); width: auto; height: auto; }`; checklist says "Show QR with the browser full size, not split view".
  2. `logTail` = the last 40 entries **excluding GPS fix lines** (`kind === 'gps'` with detail starting `fix `), so audio/visibility/error events survive in the export. `main.ts` also exports `notes['audio.events']` = counts of AudioContext state changes, `<audio>` element pauses and audio errors since load.
  3. Viewport history: on load and on every resize, each distinct `${innerWidth}x${innerHeight}@${devicePixelRatio}` is logged and recorded as `notes['viewport.<n>']` (n = 1, 2, …), so the in-motion layout is captured.
  4. `MotionReport` gains `axes: { acc: AxisRanges | null; accG: AxisRanges | null; intervalMs: number | null }` with `AxisRanges = { x: [number, number]; y: [number, number]; z: [number, number] }` (per-axis min/max for `acceleration` and `accelerationIncludingGravity`); `accelRange` stays. Query param `?motionSeconds=<n>` (clamped 5–120) sets the probe-motion duration so a lone driver can start it at a stop.
  5. Checklist: "Repeat 2.1–2.8" (not 2.2); step 5.4 (next-day storage check) adds "Show QR and append the export in a follow-up commit"; S/X noise-cancellation check also at speed (listen, then set the note after parking); step 4.2 (fixes while minimised) moved to parked; step 4.4 uses `?motionSeconds=`.
  6. nginx: remove `application/wasm wasm;` (nginx's built-in list already has it; duplicate warns) and its test assertion.
  7. CI publish job: `concurrency: { group: publish-${{ github.ref }}, cancel-in-progress: true }`.
  8. CSP adds `form-action 'none'` (in `deploy/csp.ts`, the single source; all header tests follow).
  9. `docker-compose.yml` binds `127.0.0.1:8080:8080` by default, with a comment explaining how to expose it when the proxy runs elsewhere.
