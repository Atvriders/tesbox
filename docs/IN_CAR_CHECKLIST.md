# Tesbox in-car checklist (Phase 0 probe)

The probe page answers the open platform questions in spec §16 before any engine sound is built.
Results come back as QR codes (statistics only, never coordinates) and are committed as
`docs/research/probe-results-<date>.json` (an array: the interim export from step 3.3 plus the
final one from step 5.1; the next-day export from step 5.4 is appended in a follow-up commit).
Show QR with the browser full size, not split view: each code is drawn as large as the window
allows, and a larger code scans faster.

**Safety rule:** the driver never touches the screen while the car moves. Every "Driving" step is
either started while parked (and then just runs) or done by a passenger. Interactive steps are
marked **Parked**.

## 0. Before you go

1. Deploy the image behind your public HTTPS domain or tunnel (spec §16 Q3; the domain stays out
   of the repo — this file uses the placeholder `https://tesbox.example.com`). The car's browser
   needs HTTPS for geolocation and AudioWorklet and cannot reach private LAN addresses.
2. Check the deployed build: open `https://tesbox.example.com/version.json` on a phone and note
   the `sha` (7 characters).
3. In the car, open `https://tesbox.example.com/probe/?b=<sha>` (the `b` parameter only defeats
   the browser's HTML cache). Use the trailing slash.
4. First load needs Wi-Fi, a phone hotspot or Premium Connectivity.
5. Have a phone ready to scan QR codes, and some music on a car source (radio, streaming, USB).
6. Start a GPX logger app on a phone mounted in the car and keep it recording through section 4
   (start it while parked). The GPX file is kept local and never committed (it has real
   coordinates); it is the input for Phase 1 gpx-to-replay and the `gpsLatencyS` refinement
   (section 7).

## 1. Parked — environment, build, storage

| Step | Probe action | Record |
|---|---|---|
| 1.1 | **Build** section shows "Up to date" | If "Stale build", tap the `?b=…` link and start again |
| 1.2 | **Environment**: read dpr, viewport, WebGL renderer, MCU guess, feature table | Automatic (in the QR; every window size the page sees is kept as QR note `viewport.<n>`) |
| 1.3 | **Storage** runs on load: note *Visits*, *Cache entry from earlier visit*, *Page controlled at load* | Automatic |
| 1.4 | **Export → Notes**: choose the car model | Model |

## 2. Parked — audio, routes, wheel, music

Repeat 2.1–2.8 for each route: `direct`, `media-element`, `direct + anchor` (2.1 restarts your music if the previous pass paused it, and 2.2 stops the previous pass first, so each pass starts fresh and the *music* observation of 2.3 is recorded per route). Do 2.9 once, at the end of the last pass: the Notes select keeps a single answer, so note any per-route difference in the results commit.

| Step | Probe action | Record |
|---|---|---|
| 2.1 | Start your music on a car source (or restart it if it is no longer playing) | — |
| 2.2 | Pick the route, keep latencyHint `balanced`, tap **Start audio** (a low pulse plays). For the 2nd and 3rd route: if audio is still running, tap **Stop audio** first (Start stays disabled while audio runs), pick the route, then **Start audio** again, so the *music* question is answered for each route | Quanta counter rises; `perfInWorklet` in the readout |
| 2.3 | Did your music pause or keep playing underneath? | Observation *music*: paused / mixed |
| 2.3b | Tap **Pitch step** a few times (the pulse jumps 55 ↔ 110 Hz) and judge the delay between each tap and the pitch change on this route. Compare the three routes: `media-element` adds `<audio>` buffering that `outputLatency` does not show | Delay none / slight / obvious per route, noted in the results commit (the context latencies are kept automatically as QR note `latency.<route>`) |
| 2.4 | Minimise the browser (full-screen map or another app) for ~20 s | — |
| 2.5 | While minimised: is a Tesbox Miniplayer card visible? Does the pulse keep playing? | *miniplayer*, *survivesMinimise* |
| 2.6 | Return to the browser | *Hidden clock ratio* fills in automatically |
| 2.7 | Tilt the LEFT scroll wheel right, then left (tilt only — do not press) | *wheelTilt* = yes if the event log shows `nexttrack`/`previoustrack` or a `MediaTrack…` key |
| 2.8 | If audio stopped: tap **Resume**; if that fails, **Recreate** | Recovery counters (automatic) |
| 2.9 | Last pass only: tap **Stop audio**: does your music come back by itself? | Notes → *Music resumes after Stop audio* (one answer; per-route differences seen at earlier stops go in the results commit) |
| 2.10 | With navigation to a destination running on the map: **Start audio**, then **Benchmark** (about 15 s) | Headroom k (automatic; kept as QR note `bench.balanced`) |
| 2.11 | Intel MCU only: **Stop audio**, select latencyHint `playback`, **Start audio**, **Benchmark** again | outputLatency + headroom for the A/B (automatic; QR note `bench.playback`) |
| 2.12 | Model S/X only: listen for pumping or cancellation of the pulse (Active Road Noise Reduction). This is the parked half; the at-speed half is step 4.5 | Remember the answer; the note is set after the drive (step 4.5) |
| 2.13 | Optional: press steering-wheel buttons, press a paired gamepad's buttons | Logged automatically |

## 3. Parked — motion baseline, GPS while minimised

| Step | Probe action | Record |
|---|---|---|
| 3.1 | Tap **Probe motion** with the car stationary | events, rate, range and per-axis ranges (automatic; every run is kept as QR note `motion.<n>`) |
| 3.2 | **GPS**: tap **Run 60 s** for any one mode; during the run minimise the browser for ~15 s, then return before the run ends | *hidden fixes* column of that row (expected 0) |
| 3.3 | **Interim export:** tap **Show QR** and scan every page (**Next QR**) now, before driving | Parked results live only in the page's memory; a crash or reload while driving (section 4) wipes them |

## 4. Driving — passenger operates, driver only drives

If there is no passenger: after the interim export (3.3), reopen the probe with a longer GPS run
and motion window, e.g. `https://tesbox.example.com/probe/?b=<sha>&gpsSeconds=300&motionSeconds=60`,
start one GPS run while parked, then drive; do the other modes on later drives. Never tap the
screen while moving.

| Step | Probe action | Record |
|---|---|---|
| 4.1 | **GPS**: **Run 60 s** for `poll-hiacc-off`, then `poll-hiacc-on`, `watch-hiacc-off`, `watch-hiacc-on` (one at a time, on an open road with some stops) | Summary table rows (automatic) |
| 4.2 | If the page reloads or crashes during a run, reopen it | Crash banner + *crashed* column (automatic). Rows of runs finished before the crash are gone too: repeat those modes (or, passenger, take another interim **Show QR** after each finished run) |
| 4.3 | Passenger: tap **Probe motion** while the car accelerates moderately. Lone driver: with `&motionSeconds=60` in the URL (5–120 s), tap **Probe motion** while stopped, then pull away moderately within that window | events, rate, range and per-axis ranges (QR note `motion.<n>`) |
| 4.4 | Keep audio running on the best route during the drive and note any dropouts | Event log (automatic); context state changes, element pauses and audio errors are also counted in QR note `audio.events` |
| 4.5 | Model S/X only: at speed, listen for pumping or cancellation of the pulse (Active Road Noise Reduction acts on road noise, so this is the decisive half of 2.12) — listen only | Set Notes → *Road-noise cancellation interferes* after parking (yes if heard parked or at speed) |

## 5. After the drive — export

| Step | Probe action | Record |
|---|---|---|
| 5.1 | Parked: tap **Show QR** (browser full size); scan every page (**Next QR**) with the phone, in order | Each code starts `TBX i/n` |
| 5.2 | Reassemble each export separately (interim from 3.3 and final): strip the first line `TBX i/n` from each scan and concatenate in order | One JSON document per export |
| 5.3 | Commit both as `docs/research/probe-results-<date>.json` (an array of the exports; no coordinates) | — |
| 5.4 | Next day (after the car slept): open the probe again. Show QR and append the export in a follow-up commit | *Visits* +1, *Cache entry age* (shown in seconds; 3600 s = 1 h) roughly equals the time since the previous visit, *Page controlled at load* = true means persistence works |

## 6. Spec §16 questions → probe actions

| § 16 | Question | Answered by |
|---|---|---|
| Q1 | Approve the per-phase commit + push exception? | Not a probe question — answered by the user in conversation |
| Q2 | Reference clips: supplied, or fetched locally? | Not a probe question — answered by the user in conversation |
| Q3 | Which public HTTPS domain/tunnel hosts the probe? | Step 0.1 (kept out of the repo) |
| Q4 | Does left-wheel tilt reach `nexttrack`/`previoustrack` or `MediaTrack*` keys, per route/model/firmware? | Steps 2.7, 1.4 (model); firmware noted in the results commit message |
| Q5 | Which route keeps audio alive and shows the Miniplayer when minimised? Do fixes arrive while minimised? | Steps 2.4–2.6 per route; step 3.2 (*hidden fixes*) |
| Q6 | GPS cadence, fix age (measured delivery delay; provisional `gpsLatencyS` recorded per section 7), `coords.speed` null/zero rate, `watchPosition`/high-accuracy stability, altitude | Steps 4.1, 4.2 (interval, age, speed null/zero, zero-while-moving, accuracy, altitude, errors, crashes); step 0.6 (phone GPX log for the Phase 1 `gpsLatencyS` refinement) |
| Q7 | `performance.now` in the worklet; k× headroom with the map running; Intel `latencyHint` A/B | Steps 2.2 (`perfInWorklet`), 2.10, 2.11 |
| Q8 | Service Worker + Cache Storage available and persistent across drives/sleep? | Steps 1.3, 5.4 |
| Q9 | Does Tesbox replace or mix with the user's music? | Steps 2.3, 2.9 |
| Q10 | Is DeviceMotion exposed with plausible longitudinal acceleration? (never DeviceOrientation) | Steps 3.1, 4.3 |
| Q11 | (S/X only) Any interaction with Active Road Noise Reduction? | Steps 2.12, 4.5 |

## 7. Defaults recorded from the results (spec §15 Phase 0 exit gate)

After the results are committed, record in the spec: default output route, GPS method,
high-accuracy flag, Intel `latencyHint`, the median fix age (`ageMedianMs`) as the measured
delivery delay, and a provisional `gpsLatencyS` (keep the spec default 1.0 s unless the data show
otherwise; do not set it to the median age, because `ageS` already adds `Date.now() − timestamp`,
spec §4.3). Phase 1 refines `gpsLatencyS` against the phone GPX log from step 0.6.
