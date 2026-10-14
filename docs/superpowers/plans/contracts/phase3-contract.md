# Phase 3 Contract — The Tesbox app: UI, worklet integration, input, audio lifecycle (LOCKED)

Authoritative for every Phase 3 task; formulas/types here beat prose elsewhere. Spec §4.2–4.6, §6,
§7, §8.1, §9.3, §10, §13, §15 Phase 3. Shared types: `src/contracts.ts` (LOCKED; Phase 3 adds only
the `testTone` InputMsg, already present). Builds on committed Phases 0, 1, 2a (`src/sim`,
`src/data`, `src/dsp`, `src/platform`, probe). Execution model: tasks are implemented test-first
directly from this contract, then reviewed. The probe stays at `/probe/`; the app replaces the
placeholder at `/`.

## Global rules

- **Runtime deps:** `preact@^11`, `@preact/signals@^2` (already installed by the orchestrator —
  never run npm install). TSX via `tsconfig` `"jsx": "react-jsx"`, `"jsxImportSource": "preact"`;
  Vite 8's built-in transformer must honour it — if it does not, set
  `oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } }` in `vite.config.ts`. **No
  @preact/preset-vite, no Babel.** Tests: Vitest (node env) for logic modules; Playwright for UI.
- **CSP unchanged** (no inline script/style; styles via CSS files; dynamic styles via CSSOM only).
- **Units:** speed shown in mph by default (`settings.units`), km/h selectable.
- **Glance-safe UI** (spec §10, §13): touch targets ≥ `minTouchCssPx(devicePixelRatio)`; dark theme
  forced; no text entry while moving; "parked" = geolocation available AND last accepted fix < 3 s
  old AND real-GPS speed < 5 km/h (independent of the selected source); without geolocation
  (desktop) "parked" = true.
- **Privacy:** no coordinates leave the GPS module except inside `FixMsg` posted to the worklet;
  diagnostics/QR export statistics only (reuse `assertNoCoordinates` from `src/probe/summary.ts`).
- Strings live in `src/ui/strings.ts` (English).
- No per-task commits — Phase 3 lands as one verified commit.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `tsconfig.json` (jsx), `vite.config.ts` (only if oxc fallback needed), `index.html` (nomodule + classic check script tags), `public/unsupported.js`, `src/main.ts`, `src/ui/app.tsx`, `src/ui/theme.css`, `src/ui/strings.ts` | app shell, router, unsupported fallback | T1 |
| `src/app/settings.ts`, `src/app/store.ts` | persisted settings + signals store + derived selections | T2 |
| `src/audio/worklet.ts` | `registerProcessor('tesbox', TesboxProcessor)` hosting SimCore + DspCore | T3 |
| `src/platform/drift.ts` (moved from `src/probe/drift.ts`; probe imports updated), `src/audio/engine-audio.ts` | main-thread audio controller | T4 |
| `src/audio/gps-source.ts` | production GPS poller + parked estimate | T5 |
| `src/input/{paddles,keyboard,gamepad,media-shift}.ts` | inputs | T6 |
| `src/ui/first-run.tsx`, `src/ui/picker.ts` (pure data helpers), `src/ui/garage.tsx` | first run + Tesla picker + bass sweep, garage | T7 |
| `src/ui/drive.tsx`, `src/ui/tach.ts`, `src/ui/settings-screen.tsx`, `src/ui/diagnostics.tsx` | drive, settings, diagnostics | T8 |
| `tests/e2e/app-*.spec.ts`, `README.md`, `docs/IN_CAR_CHECKLIST.md` (app section), `docs/CLEAN_ROOM.md` (append) | e2e + docs + verification | T9 |
| `tests/unit/<module>.test.ts` | one per logic module | each |

Waves: **W1** T1, T2, T3, T4, T5, T6 → **W2** T7, T8 → **W3** T9.

## Settings (T2) — `src/app/settings.ts`

```ts
export type Units = 'mph' | 'kmh';
export type TierPref = 'auto' | 'full' | 'lite';
export interface NotListed { zeroTo100S: number; massKg: number; body: 'sedan' | 'suv' | 'truck' }
export interface Settings {
  v: 1;
  teslaId: string | null;          // TeslaRecord.id, or null when notListed is used / not chosen yet
  notListed: NotListed | null;
  accelMode: string | null;        // accelModes[].name; null = quickest
  mcu2Retrofit: boolean | null;    // asked only for MCU1-era records
  subwoofer: Subwoofer;            // default from record.subwooferDefault ? 'yes' : 'no'; 'unsure' if skipped
  hpCornerHz: number;              // 30–60, default 40 (bass sweep result)
  engineId: string;                // default 'i5-turbo-25'
  gearboxMode: GearboxMode; driveMode: DriveMode; valve: ValveMode; perspective: Perspective;
  volumeTrimDb: number;            // −24 … +6, default 0
  source: 'gps' | 'demo' | 'keyboard';
  tierPref: TierPref; liteNextStart: boolean;
  gpsMethod: 'poll' | 'watch'; highAccuracy: boolean; gpsLatencyS: number;
  outputRoute: OutputRoute;        // default 'direct-anchor' (spec §6.4)
  gamepadSwap: boolean;
  wheelShift: { tested: boolean; works: boolean; enabled: boolean };
  engineWarmAt: number | null;     // epoch ms of the last engine stop (warm start if < 30 min)
  units: Units;                    // default 'mph'
  noticesSeen: boolean; manualWarningSeen: boolean;
}
export const DEFAULT_SETTINGS: Settings;
export const SETTINGS_KEY = 'settings';            // stored as tesbox.v1.settings via src/platform/storage.ts
export function loadSettings(): Settings;           // per-field validation: invalid/missing field → default; never throws
export function saveSettings(s: Settings): boolean;
export function teslaParamsFor(s: Settings): TeslaParams | null; // resolveTeslaParams / notListedParams; null if unset
export function needsFirstRun(s: Settings): boolean; // no Tesla chosen (teslaId and notListed both null) or !noticesSeen
```

## Store (T2) — `src/app/store.ts`

Signals (`@preact/signals`): `settings`, `screen` (`'first-run' | 'garage' | 'drive' | 'settings' |
'diagnostics'`), `snapshot` (`Float64Array(STATE_LEN)` copy, updated ≤ 30 Hz), `audio` (`{ state:
'off'|'starting'|'running'|'interrupted'|'error'; route; tier; message? }`), `gps` (`{ status:
'off'|'waiting'|'ok'|'denied'|'unavailable'; parked: boolean; fixAgeS: number|null }`), `toast`.
Derived: `engine = computed(() => getEngine(settings.value.engineId))`, `tesla`, `teslaParams`,
`parked`. Actions: `updateSettings(patch)` (persists), `go(screen)`. Engine/tesla/output/mode
changes are forwarded to `EngineAudio` by the shell (T1 wires `effect`s).

## Worklet processor (T3) — `src/audio/worklet.ts`

Processor name `'tesbox'`; node options `{ numberOfInputs: 0, numberOfOutputs: 1,
outputChannelCount: [2] }`. Constructor allocates `TesboxSimCore`, `TesboxDspCore(sampleRate)`, a
test-tone `OutputStage` configured `{ subwoofer: 'yes', hpCornerHz: 40, volumeTrimDb: 0 }`, a
`DspControl` object and a `Float64Array(STATE_LEN)` snapshot buffer. Messages (`MainToWorklet`):

- `engine` → keep def; `tesla` → keep params; `tuning` → keep; when engine+tesla are known:
  `sim.configure(def.spec, def.voicing, params, tuning)` and `dsp.configure(def, output, tier)`.
- `output` / `tier` → `dsp.configure(currentDef, output, tier)` (trim-only changes apply without a
  fade, per DspCore).
- `source` → `sim.setSource`; `warm` → `ctl.warm`.
- Input messages → `sim.pushInput(msg, currentTime)`; additionally `valve`, `perspective`,
  `driveMode` update `ctl`; `volume` → dsp output trim; `bench {k}` → render k−1 extra times into a
  scratch buffer each quantum (k clamped 1–16); `testTone` → tone path (sine at hz, peak
  `dbToGain(levelDb)`, 50 ms raised-cosine fade in/out, through the tone OutputStage) replacing the
  engine output while active; `ignition` → sim.
- `fix` → `sim.pushFix(msg, currentTime)`.
`process()`: if not configured → silence; else `sim.step(currentTime, 128/sampleRate)`, copy
`sim.out` → `ctl` (rpm, load, gear, driveline, limiter, shift, ignitionOn, runTimeS), `dsp.render`.
Every 12 quanta post `{ type: 'state', buf }` (fresh copy) with S.* fields (busyFrac from Date.now
busy-ms over ~1 s windows; `F.OVERLOAD` set when busyFrac > 0.8 for 2 windows). Exceptions are
caught per message and posted as `{ type: 'error', message }`; `process` always returns true and
never throws (outputs silence on error). Unit tests run the processor in Node via a shim
(`globalThis.AudioWorkletProcessor` with a `MessageChannel` port, `registerProcessor` capture,
`sampleRate`/`currentTime` globals).

## Audio controller (T4) — `src/audio/engine-audio.ts`

```ts
export interface EngineAudioCallbacks {
  onState(s: AudioState): void; onSnapshot(buf: Float64Array): void;
  onMediaAction(action: 'play' | 'pause' | 'nexttrack' | 'previoustrack'): void; onError(msg: string): void;
}
export class EngineAudio {
  constructor(cb: EngineAudioCallbacks, opts?: { workletUrl?: string; anchorUrl?: string });
  /** MUST be called from a click/pointerup handler. */
  start(init: { route: OutputRoute; latencyHint: 'balanced' | 'playback'; messages: MainToWorklet[];
    tierPref: TierPref; mcu: Mcu; engineName: string }): Promise<void>;
  post(msg: MainToWorklet): void;
  setRoute(route: OutputRoute): Promise<void>;
  /** From the Tap-to-resume tap: resume(); if state is 'interrupted', resume rejects, or not running within 500 ms → close + recreate inside the tap, replay last config + ignition. */
  recover(): Promise<boolean>;
  setVisibility(hidden: boolean): void;   // posts { type: 'visibility' }
  stop(): Promise<void>;                  // ignition off, fade, close
  readonly state: AudioState;
}
```
Start sequence: create `AudioContext({ latencyHint })`, `addModule(workletUrl)` (from
`./worklet.ts?worker&url`), node, route (direct | media-element via MediaStreamAudioDestinationNode
→ `<audio>` | direct-anchor: destination + looping `<audio src=/probe/anchor.wav>`), Media Session
(metadata `{ title: engineName, artist: 'Tesbox' }`, `playbackState = 'playing'`, handlers for
play/pause/nexttrack/previoustrack → `onMediaAction`), post `messages` (engine, tesla, output,
source, tuning with `outputLatencyS = ctx.outputLatency || 0.1`, tier, warm), then `ignition on`.
**Tier (spec §5.7):** `tierPref` 'full'/'lite' forced; 'auto' → Intel MCU → lite; otherwise during
the 2.5 s crank post `bench` k = 1, 2, 4, 8 for ~0.5 s each, watch `DriftMonitor` (moved to
`src/platform/drift.ts`) and the worklet busyFrac; Full iff k = 4 runs without overload; post the
chosen `tier`, `bench {k:1}`. `statechange` → `onState`; never call `suspend()`. Unit tests with
fake AudioContext/AudioWorkletNode/Media Session (pattern of `tests/unit/audio.test.ts`).

## GPS source (T5) — `src/audio/gps-source.ts`

```ts
export class GpsSource {
  constructor(geo: Geolocation | undefined, onFix: (f: FixMsg) => void, onStatus: (s: GpsStatus) => void, now?: () => number);
  start(o: { method: 'poll' | 'watch'; highAccuracy: boolean; latencyS: number }): void;
  stop(): void;
  /** Real-GPS parked estimate (spec §10.1). */
  parked(nowMs?: number): boolean;
}
```
Poll: one `getCurrentPosition` in flight, `{ enableHighAccuracy, timeout: 2000, maximumAge: 0 }`,
next request ≥ 1000 ms after the previous started. Watch: `watchPosition` same options. Drop
identical (timestamp, lat, lon) repeats; `ageS = (Date.now() − timestamp)/1000 + latencyS`; post
`FixMsg` with `speedMps = coords.speed` if finite else null, `altitudeM`. Status: permission denied
→ `'denied'` (stops polling), position unavailable/timeout → `'unavailable'` while failing, first
fix → `'ok'`. `parked()`: last fix arrived < 3 s ago AND speed estimate < 5 km/h, where the
estimate is `coords.speed` when finite and > 0, else haversine displacement over the last ≥ 2 s of
fixes / elapsed time (handles Intel speed-0 reporting). Runs whenever geolocation is permitted,
even when the selected source is demo/keyboard (parked lock). Tests with a fake Geolocation.

## Input (T6) — `src/input/*`

- `paddles.ts`: `bindPaddle(el: HTMLElement, dir: 1 | -1, onShift: (dir) => void): () => void` —
  `pointerdown` (not click), `touch-action: manipulation` via class, visual flash class 150 ms.
- `keyboard.ts`: `attachKeyboard(target, handlers)`: `E` up, `Q` down, `V` cycle valves, `P` toggle
  perspective — any source; `W`/`S`/`Space` → pedal throttle/brake (keyboard source only); ignore
  auto-repeat for E/Q.
- `gamepad.ts`: rAF polling with a 20 ms timing guard; R1/RB (5) up, L1/LB (4) down, A (0) valves,
  B (1) perspective; `swap` flips A/B and X/Y; edge-triggered.
- `media-shift.ts`: `class MediaShift { enabled; handleAction(a, nowMs): 'up'|'down'|null; handleKey(code, nowMs) }`
  — `nexttrack`/`MediaTrackNext` → up, `previoustrack`/`MediaTrackPrevious` → down; a key and an
  action of the same direction within 900 ms count once; same-source repeats are not suppressed;
  `play`/`pause` never shift. `class WheelTest` state machine: `idle → waitRight (10 s) →
  waitLeft (10 s) → done(works)`; `onAction/onKey` advance; timeout → done(false).

## Screens (T7, T8)

- **Shell (T1):** `<App/>` renders by `screen`; first load → `first-run` if `needsFirstRun`, else
  `garage` (if no audio yet) / `drive`. `#unsupported` (static, in index.html) is hidden by the
  module on successful boot; `public/unsupported.js` (classic, ES5, loaded with `defer`) shows it if
  `AudioContext`/`AudioWorkletNode` are missing; `<script nomodule>` also reveals it.
- **First run (T7):** notices (spec §10.2 item 2, all five lines, one "OK" → `noticesSeen`); picker:
  Model → generation (with years) → trim → MCU2 retrofit (MCU1-era only) → subwoofer yes/no/not sure
  (pre-selected from `subwooferDefault`, labelled "best guess") → **bass sweep** (parked only:
  testTone at 30/35/40/45/50/60 Hz, 1.5 s each, level −18 dB; user taps the lowest step that played
  cleanly → `hpCornerHz`; Skip keeps 40) → acceleration mode (from `accelModes`). "Not listed" form
  (parked only): 0–100 s, mass kg, body. `picker.ts` pure helpers (models list, generations,
  trims, MCU1 detection) are unit-tested against the catalogue.
- **Garage (T7):** cards grouped Euro / JDM / American / Exotic: `name`, "inspired by
  `inspiredBy`", spec line (layout, displacement, aspiration, redline); **Preview** (starts audio
  if needed — gesture — then a 1.5 s keyboard pedal pulse on the selected engine) and **Drive**.
  Footer disclaimer.
- **Drive (T8):** canvas tach (`tach.ts`: redline arc, shift light at 0.95·redline, needle from
  snapshot rpm; backing store 1× and ≤ 30 fps when MCU = intel), large gear (flash on SHIFTING,
  red flash on SHIFT_REFUSED), speed (units), load bar, `−`/`+` paddles on the edges, toggles
  Auto|Manual (first enable → one-time manual warning modal, parked only), Comfort|Sport, Valves
  Auto|Open|Closed; status dot (GPS/audio/headroom colours; long-press 700 ms → Diagnostics);
  **Start engine** overlay when audio off; **Tap to resume** overlay when interrupted (calls
  `recover()`); Settings button enabled only when parked.
- **Settings (T8):** volume trim, perspective, units, acceleration mode, Tesla & subwoofer & bass
  sweep (re-run picker), source GPS|Demo|Keyboard, quality Auto|Full|Lite, steering-wheel test
  (WheelTest UI), gamepad swap, Advanced (GPS method, high accuracy, output route, gpsLatencyS,
  reset all) — the whole screen is read-only unless parked.
- **Diagnostics (T8):** live snapshot fields, flags decoded, GPS status/fix age, audio state, tier,
  route, outputLatency, overload/recovery counters, MCU guess, dpr/viewport, last 40 input events;
  **Show QR**: statistics-only JSON (no coordinates; `assertNoCoordinates`) via `chunkText` +
  `drawQr`.
- **Engine warm:** on stop save `engineWarmAt = Date.now()`; on start post `warm` = (now −
  engineWarmAt < 30 min) or GPS speed > 0.
- Visibility: `document.visibilitychange` → `EngineAudio.setVisibility`.
- Gamepad/keyboard/paddles/media → `post(shiftUp|shiftDown|valve|perspective|pedal)`.

## Acceptance (T9 e2e, Playwright, Chromium)

1. First run: notices → picker (Model 3 Highland → Long Range AWD) → subwoofer → bass sweep (tone
   steps observed via worklet state) → accel mode → garage shows 15 cards in 4 groups.
2. Drive in Demo: Start engine → snapshots arrive; rpm and gear change over the demo loop; `+`/`−`
   paddles and `E`/`Q` shift in Manual; a simulated Media Session `nexttrack` shifts when wheel
   shifting is enabled.
3. Settings persist across reload; corrupt localStorage → defaults, no crash.
4. Geolocation denied → banner + "Use Demo" works; Settings locked while "moving" (fake
   geolocation at 20 m/s), unlocked when parked.
5. Viewports 773×601 @1.53, 1255×758 @1.53, 1306×735 @1.96, 1410×833 @1.56, 2200×1300 @1.0:
   paddles/toggles/buttons ≥ `minTouchCssPx`, no horizontal scroll, Drive fits without scrolling.
6. Unsupported: with `AudioWorkletNode` deleted before load → `#unsupported` visible.
7. Probe still loads at `/probe/`; all Phase 0 e2e still pass; CSP: zero violations.
