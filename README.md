# Tesbox

Tesbox is a free, self-hosted web app for a Tesla's built-in touchscreen browser. It synthesizes a
combustion-engine sound in real time from GPS speed, a real gearbox model and your own Tesla's
performance, and plays it through the cabin speakers. No accounts, no analytics: nothing leaves
the car.

> **Status: Phase 3 — app alpha.** The app at `/` is complete: first run (which Tesla, subwoofer,
> bass sweep), a garage of 15 engines, Drive with paddles and the steering-wheel tilt, Settings and
> Diagnostics. The engine voicings are still first estimates until each is tuned in the Sound Lab
> and signed off by ear. The in-car probe from Phase 0 stays at `/probe/`. Offline relaunch and
> update prompts come in Phase 4.

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

The car needs Wi-Fi, a phone hotspot or Premium Connectivity for the first load; an engine that
is already running keeps playing without a connection.

## In the car

1. Note the build: open `https://tesbox.example.com/version.json` and copy `sha`.
2. In the car's browser open `https://tesbox.example.com/?b=<sha>` (the `b` parameter defeats the
   browser's long-lived HTML cache).
3. **First run** (parked): read the five notices and tap OK, then pick your Tesla — model,
   generation, trim (cars built with the first media computer are asked about the MCU2 upgrade).
   Answer the subwoofer question (the trim's best guess is pre-selected).
4. **Bass sweep** (parked): set the car's volume where you usually listen, tap **Play tones** and
   listen to six low tones from 30 Hz to 60 Hz; tap the lowest one that sounded clean, without
   rattle or buzz. It sets where the door speakers stop getting bass. **Skip** keeps 40 Hz.
5. Pick the acceleration mode your car is set to (Chill, Standard, …).
6. **Garage:** **Preview** revs an engine for a moment (parked); **Drive** takes it out.
7. **Drive:** tap **Start engine** (the browser plays sound only after a tap) and allow location
   when asked. The engine follows the GPS speed; Auto shifts for you. `−` / `+` on the screen edges
   shift (Manual, or a temporary override in Auto); the toggles switch Auto|Manual, Comfort|Sport
   and the exhaust valves. Hold the status dot for Diagnostics. Settings open only while parked.
8. If the sound stops (another app took the audio, or the browser was minimised), tap **Tap to
   resume**.

The in-car test steps — parked setup and a 10-minute drive with a Diagnostics QR export — are in
[`docs/IN_CAR_CHECKLIST.md`](docs/IN_CAR_CHECKLIST.md) (section 8 onwards; sections 0–7 are the
Phase 0 probe).

### Steering-wheel shifting (optional)

Tilting the left scroll wheel may reach the browser as "next / previous track". To try it: parked,
with the engine running, open **Settings → Controls → Test steering-wheel shifting**, then tilt the
LEFT scroll wheel to the RIGHT, then to the LEFT, within 10 s each (tilt only — never press it). If
both arrive, wheel shifting is switched on: tilt right shifts up, tilt left shifts down. If not, it
stays off and the screen paddles remain. Pressing the wheel is never used.

### At a desk: Demo and Keyboard

Without a car, choose **Settings → Speed → Speed source**: **Demo** drives a scripted loop (pull
away, cruise, full-throttle pull, lift-off, braking); **Keyboard** lets you drive with `W`
(throttle), `S` (brake) and `Space` (brake to a stop). With any source, `E` / `Q` shift up / down,
`V` cycles the valves and `P` switches the listening position (Cabin / Outside). The location
banner's **Use Demo** button switches to Demo too. A desktop browser without location access counts
as parked, so every screen is available. A gamepad works as well: RB / LB shift, A valves,
B position (swap A/B in Settings).

### Known limitations

- **It replaces your music.** The browser is its own media source: the car's music pauses while
  Tesbox plays.
- **It idles when minimised.** The browser stops location updates for a hidden page and the car may
  stop its audio: with the map full screen or the camera up, the engine holds at idle or stops.
  Back on screen, tap **Tap to resume** if it stopped.
- **GPS lag.** Fixes arrive about once a second and about a second late; the simulation predicts
  between fixes, but sharp speed changes still reach the engine a second or two late — more on
  MCU2 (Intel) cars, whose browser reports no usable GPS speed, only positions.
- Settings, the bass sweep, Preview and the Manual-mode warning are only available while parked.

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

The app e2e specs (`tests/e2e/app-*.spec.ts`) drive the real app in Chromium: first run with the
bass sweep (the tones are checked at the worklet's output), Drive in Demo with paddles, keys and a
simulated Media Session tilt, settings persistence, a fake GPS at 20 m/s, the five Tesla screen
layouts and the Unsupported fallback, all with zero CSP violations.

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
adaptation, the QR encoder); its user interface uses the MIT-licensed Preact and Preact Signals
libraries. All are attributed in `NOTICES`; see [`docs/CLEAN_ROOM.md`](docs/CLEAN_ROOM.md). MIT
licence ([`LICENSE`](LICENSE)); attributions in [`NOTICES`](NOTICES).
