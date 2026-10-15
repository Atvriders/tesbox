# Tesbox

Tesbox is a free, self-hosted web app for a Tesla's built-in touchscreen browser. It synthesizes a
combustion-engine sound in real time from GPS speed, a real gearbox model and your own Tesla's
performance, and plays it through the cabin speakers. No accounts, no analytics: nothing leaves
the car.

> **Status: 1.0.0.** The app at `/`: first run (which Tesla, subwoofer, bass sweep), a garage of 15
> engines, Drive with paddles and the steering-wheel tilt, Settings and Diagnostics; offline
> relaunch after the first visit and an update prompt. Engines marked **Beta voicing** in the
> garage are still estimates until they are tuned in the Sound Lab and signed off by ear
> ([`CHANGELOG.md`](CHANGELOG.md) lists each engine's status). The in-car probe from Phase 0 stays
> at `/probe/`.

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
is already running keeps playing without a connection (see [Offline and updates](#offline-and-updates)).

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

The in-car test steps — parked setup, the 10-minute (Phase 3) and 30-minute (1.0) drives with a
Diagnostics QR export — are in [`docs/IN_CAR_CHECKLIST.md`](docs/IN_CAR_CHECKLIST.md) (section 8
onwards; sections 0–7 are the Phase 0 probe).

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

### Offline and updates

- **A running engine needs no network.** At Start, everything a session uses — the audio worklet,
  the engines, the Tesla catalogue and the anchor sound — is already in memory, so tunnels, car
  parks and dead zones never stop the sound.
- **Relaunch without a connection.** After the first visit a service worker keeps the app's files
  in the browser's cache, so the app opens again without a connection. Where the car's browser has
  no service workers (Diagnostics → Platform → *Service worker*: `unsupported`), opening the app
  needs a connection; a running engine still keeps playing.
- **Updates.** Tesbox checks for a newer build when it starts and every 30 minutes. When there is
  one, **Update available — tap to reload** appears at the top, but only while the engine is off
  and the car is parked; it never interrupts a running engine. The tap reloads into the new build
  with `?b=<sha>` in the address (past the browser's long-lived HTML cache); the app removes the
  parameter again once loaded.

### Privacy

No accounts, no analytics, no telemetry, no third-party requests (the Content-Security-Policy allows
only your own server). Your location is used inside the browser to follow your speed; coordinates
never leave the car. The app only downloads its own files and `version.json` from your server and
uploads nothing; settings stay in the browser's local storage. The Diagnostics QR export holds
statistics only, never coordinates, and you decide whether to scan it.

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
layouts, the Unsupported fallback, an offline relaunch through the service worker, a session that
loses its connection, a browser without service workers and the update banner, all with zero CSP
violations.

Header checks (`tests/e2e/headers.spec.ts`) run only against a container:
`E2E_BASE_URL=http://localhost:8080 npx playwright test`.

### Sound Lab

Claude cannot hear, so engines are voiced by measurement: `npm run render` renders an engine's test
segments to WAV, `npm run score` compares them with reference recordings of the inspiring car, and
`npm run tune` searches the voicing against those scores; the user's listening sign-off is the
final word. Reference recordings stay on your machine (`lab-refs/` is git-ignored) and are never
committed or shipped. The procedure is in [`docs/SOUND_LAB.md`](docs/SOUND_LAB.md).

The **Lab UI** at `/lab/` (desktop browser) plays any engine live: rpm, load and gear sliders,
upshift / downshift / lift-off / limiter / ignition events and the fixed test segments; a slider for
every voicing parameter; A/B against a recording you pick from your disk (decoded in the browser,
never uploaded); and Export / Import of a voicing as JSON.

## Releases (GitHub Actions)

Every push to `master` runs lint, typecheck, unit tests and build, then builds the image, runs it
and runs Playwright against it; only if everything is green it pushes
`ghcr.io/atvriders/tesbox:latest` and `:<commit sha>` for amd64 and arm64. Pull requests run the
same checks without publishing. A version tag (`v1.0.0`, …) runs the same pipeline and also
publishes that commit's image as `ghcr.io/atvriders/tesbox:<tag>`; the release notes are the
version's section of [`CHANGELOG.md`](CHANGELOG.md).

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
