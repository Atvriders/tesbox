# Phase 4 Contract — Offline/PWA, update flow, hardening, v1 release (LOCKED)

Authoritative for every Phase 4 task. Spec §1.1 goal 3, §6.5, §10.1, §12, §13, §15 Phase 4.
Builds on committed Phases 0–3 (app shell `src/ui/app.tsx`, `src/audio/engine-audio.ts`,
`src/platform/build-info.ts`, nginx/CSP, CI). Tasks are implemented test-first from this contract,
then reviewed. Phase 4 lands as one verified commit + the `v1.0.0` tag/release.

## T1 — App service worker (`deploy/sw-plugin.ts`, generated `dist/sw.js`, `src/platform/sw-register.ts`)

- A Vite plugin (build only) emits `sw.js` at the site root from a template in
  `deploy/sw-template.js` with two injected constants: `CACHE = 'tesbox-' + <build sha>` and
  `PRECACHE = [...]` = every emitted file of the **main** entry graph (index.html, its JS/CSS chunks
  incl. the worklet asset) + `/probe/anchor.wav` + `/version.json` — **not** the probe page.
- Strategy: `install` → `cache.addAll(PRECACHE)` then `skipWaiting()` is **not** called
  automatically (the page decides); `activate` → delete every `tesbox-*` cache except `CACHE`, then
  `clients.claim()`; `fetch` (GET, same-origin only): navigation requests → network-first with a
  3 s timeout, fallback to cached `/index.html`; `/assets/*` → cache-first; `/version.json` →
  network only (never cached responses served); everything else → network, fallback cache.
- `sw-register.ts`: `registerAppSw(onUpdateReady: () => void): Promise<'registered'|'unsupported'|'failed'>`
  registers `/sw.js` (scope `/`) when `'serviceWorker' in navigator`, detects a waiting worker
  (`registration.waiting` or `updatefound` → installed while a controller exists) and calls
  `onUpdateReady`; `applyUpdate()` posts `{ type: 'SKIP_WAITING' }` to the waiting worker and
  reloads on `controllerchange`. The probe's own `/probe/sw.js` (scope `/probe/`) is untouched.
- nginx already serves `/sw.js` with `no-store`; the CSP needs no change.

## T2 — Session preload + offline robustness (`src/audio/engine-audio.ts`, `src/ui/app.tsx`)

- At Start, `EngineAudio` fetches the anchor WAV once and uses a `blob:` URL for the anchor
  `<audio>` (CSP `media-src 'self' blob:` already allows it), so a running session needs no network.
- Engines and the Tesla catalogue must be in the eagerly loaded JS (verify the build: no lazy chunk
  for `src/data/**`); the worklet module is fetched once at Start (`addModule`) and kept.
- Network loss while running never stops audio (no fetches on the audio path).

## T3 — Update + stale-build UX (`src/ui/app.tsx`, `src/ui/strings.ts`)

- On boot and every 30 min: `checkVersion()`; a stale build or a waiting SW sets
  `store.update = { kind: 'sw' | 'stale', remote?: string }`.
- The banner "Update available — tap to reload" is shown **only when the engine is off and the car
  is parked** (spec §12); tapping calls `applyUpdate()` (SW) or reloads with `?b=<remote sha>`
  (stale HTML cache). Never interrupts a running engine.

## T4 — Garage voicing state, docs, notices, release (`src/ui/garage.tsx`, docs, NOTICES, CHANGELOG)

- Garage cards show a **"Beta voicing"** badge when `voicing.estimated === true` (default or
  machine-tuned, not yet signed off by the user) and no badge when signed off. Tuned-but-unsigned
  pilots additionally show "Tuned" in their spec line.
- `NOTICES`: add shipped runtime dependencies `preact` (MIT) and `@preact/signals` (MIT) with
  copyright lines; dev-only list unchanged.
- `README.md`: what it is; disclaimer; self-host (compose, public HTTPS domain/tunnel, placeholder
  `https://tesbox.example.com`); first run in the car (pick your Tesla, bass sweep, garage, Start);
  steering-wheel shifting test; Demo/Keyboard sources for desk use; offline notes; privacy (no
  telemetry, no coordinates leave the car); Sound Lab pointer; known limitations (idles when
  minimised; replaces music; GPS lag).
- `docs/IN_CAR_CHECKLIST.md`: app section — 10-min drive gate (Phase 3) and 30-min drive gate
  (Phase 4: Diagnostics counters at 0, export via QR), each step parked vs driving.
- `CHANGELOG.md` with `## 1.0.0 — <date>` summarising Phases 0–4 and listing the engines and their
  voicing status.
- `docs/CLEAN_ROOM.md`: append Phase 3/4 rows (Preact MIT; service-worker caching from the
  Service Worker spec; no third-party code copied).
- Release: after the Phase 4 commit is green in CI, the orchestrator tags `v1.0.0` and creates a
  GitHub release (notes = CHANGELOG 1.0.0 section) via the API. The GHCR image for that commit is
  additionally tagged `v1.0.0` by CI on tag push (add `tags: [ 'v*' ]` trigger and a `type=ref,event=tag`
  style tag in the publish job — pinned actions unchanged).

## T5 — E2E (`tests/e2e/app-offline.spec.ts`, `tests/e2e/app-update.spec.ts`)

1. With the built app served by `vite preview`: first visit registers the SW; second visit is
   controlled; `context.setOffline(true)` → reload → app shell renders and Demo engine starts.
2. Engine running → go offline → snapshots keep arriving for 5 s; anchor audio element keeps a
   `blob:` src.
3. `serviceWorkers: 'block'` → app works online; Diagnostics shows "service worker: unsupported".
4. Update: serve a changed `version.json` (route interception) → banner appears only after the
   engine stops and the fake GPS reports parked; tapping reloads with `?b=`.
5. All Phase 0 and Phase 3 e2e still pass; CSP violations = 0.

Waves: W1 T1, T2, T4 (docs part) → W2 T3, T5 → release.

## Amendments (2026-10-14, authoritative — override anything above)

- **E1 (T1 fetch strategy):** cache-first applies only to `/assets/*` URLs in `PRECACHE`; any other
  `/assets/*` request (probe or lab chunks) is left to the browser (no `respondWith`), never cached.
  Reason: the app worker (scope `/`) also controls `/probe/` and `/lab/` pages; caching their chunks
  bloated the app cache and served them from it.
- **E2 (probe Q8 evidence):** the probe's "Page controlled at load" is true only when the controlling
  worker's script path ends in `/probe/sw.js`; a "Controlling worker at load" row shows the path
  (never the origin). Reason: on a first `/probe/` visit after using the app, `/sw.js` controls the
  page and was a false positive for spec §16 Q8.
- **E3 (T1 navigations, with phase 2c):** navigations to the Sound Lab (`/lab`, `/lab/…`) are left to
  the browser like the probe's — the lab is its own page and must never get the app shell offline.
