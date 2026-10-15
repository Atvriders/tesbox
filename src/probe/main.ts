/**
 * Tesbox in-car probe page (spec §15 Phase 0, §16). Wiring and display only: every measurement
 * lives in the imported probe modules. Coordinates never reach this file's output (summary.ts
 * enforces it with assertNoCoordinates).
 */
import { minTouchCssPx, type OutputRoute } from '../contracts';
import { BUILD_SHA, checkVersion } from '../platform/build-info';
import { detectFeatures, getWebglRenderer, parseMcu, viewportInfo, type Features } from '../platform/detect';
import { chunkText, drawQr, encodeQr } from '../platform/qr';
import { AudioProbe, type AudioProbeState, type BenchResult } from './audio';
import { PROBE_TONE_HZ } from './audio-protocol';
import workletUrl from './audio-worklet.ts?worker&url';
import { GPS_MODES, GpsRunner, modeName, type GpsMode } from './gps';
import type { GpsModeSummary } from './gps-stats';
import { InputProbe, type AxisRanges, type MotionReport } from './inputs';
import { errText, EventLog, type LogEntry } from './log';
import { runStorageProbe, type StorageReport } from './storage-probe';
import { buildSummary, formatEntry, type ProbeSummary, type RouteObservation } from './summary';

// ───────────────────────────── Constants & query params ─────────────────────────────

const ANCHOR_URL = '/probe/anchor.wav';
const ROUTES: readonly OutputRoute[] = ['direct', 'media-element', 'direct-anchor'];
const HINTS: readonly ('balanced' | 'playback')[] = ['balanced', 'playback'];
const LOG_VIEW_SIZE = 30;
const VIEWPORT_HISTORY_MAX = 64; // distinct sizes kept: bounds the QR export if the window is dragged around

const params = new URLSearchParams(location.search);
const quickBench = params.get('quickbench') === '1';
const BENCH_KS = quickBench ? [1, 2] : [1, 2, 4, 8, 16];
const BENCH_SECONDS = quickBench ? 1 : 3;
const gpsSeconds = parseGpsSeconds(params.get('gpsSeconds'));
const motionSeconds = parseMotionSeconds(params.get('motionSeconds'));
// `b` is a cache-buster only (spec §12) and deliberately ignored.

function parseGpsSeconds(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3600 ? n : 60;
}

/** Probe-motion window, clamped to 5–120 s (default 5): a lone driver starts a long one while stopped, then pulls away. */
function parseMotionSeconds(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(120, Math.max(5, Math.round(n))) : 5;
}

// ───────────────────────────── DOM helpers ─────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`probe markup is missing #${id}`);
  return node as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function setKv(dl: HTMLElement, rows: readonly (readonly [string, string])[]): void {
  const nodes: HTMLElement[] = [];
  for (const [k, v] of rows) nodes.push(make('dt', k), make('dd', v));
  dl.replaceChildren(...nodes);
}

function tbody(tableId: string): HTMLTableSectionElement {
  const body = el<HTMLTableElement>(tableId).tBodies[0];
  if (body === undefined) throw new Error(`#${tableId} has no <tbody>`);
  return body;
}

function fmtNum(v: number | null, digits = 0): string {
  return v === null ? '—' : v.toFixed(digits);
}

function fmtPct(v: number): string {
  return `${v.toFixed(0)}%`;
}

// ───────────────────────────── Shared state ─────────────────────────────

const log = new EventLog();
const features: Features = detectFeatures();
const webgl = getWebglRenderer();
const mcu = parseMcu(webgl);
const inputs = new InputProbe(log);
const gpsRunner = 'geolocation' in navigator ? new GpsRunner(navigator.geolocation, log) : null;

type AudioPhase = 'idle' | 'starting' | 'running' | 'busy';
/** One AudioProbe per page visit: recoveries survive Stop/Start (start() after stop() rebuilds). */
let audio: AudioProbe | null = null;
let audioPhase: AudioPhase = 'idle';
let bench: BenchResult[] = [];
let headroomK: number | null = null;
/** Snapshot taken at the last Stop audio: stop() resets the live snapshot to state 'none'. */
let lastAudioState: AudioProbeState | null = null;
/** Pitch step state: the probe tone toggles an octave, 55 ↔ 110 Hz (AudioProbe keeps it across rebuilds). */
let toneHz = PROBE_TONE_HZ;
/** Failed audio controls (start/resume/recreate/benchmark/stop/route) logged here; AudioProbe counts its own errors. */
let audioControlErrors = 0;

const gpsSummaries: GpsModeSummary[] = [];
/** Live counters of the GPS run in progress; `errors` counts the runner's `error code=<n>` lines only. */
let gpsLive: { mode: string; fixes: number; errors: number; endsAtMs: number } | null = null;

let motion: MotionReport | null = null;
let motionRuns = 0;
let storage: StorageReport | null = null;
const notes: Record<string, string> = {};
const routes: Partial<Record<OutputRoute, RouteObservation>> = {};
const routesUsed = new Set<OutputRoute>();
const viewportsSeen = new Set<string>();

let qrPage = 0;
let qrCount = 0;

function fail(what: string, e: unknown, statusId?: string): void {
  const msg = `${what}: ${errText(e)}`;
  log.push('error', msg);
  if (statusId !== undefined) el(statusId).textContent = msg;
}

/** A failed audio control: logged like any failure and counted for the export's `audio.events` note. */
function audioFail(what: string, e: unknown, statusId: string): void {
  audioControlErrors++;
  fail(what, e, statusId);
}

// ───────────────────────────── Touch sizing & environment ─────────────────────────────

function applyTouchSize(): void {
  document.documentElement.style.setProperty('--touch', `${minTouchCssPx(window.devicePixelRatio || 1)}px`);
}

/**
 * Viewport history (C8.3), on load and on every resize: each distinct size is logged and kept as
 * note `viewport.<n>`, so the export shows the layouts the car used (parked vs in motion, split view).
 */
function recordViewport(): void {
  const size = `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`;
  if (viewportsSeen.has(size) || viewportsSeen.size >= VIEWPORT_HISTORY_MAX) return;
  viewportsSeen.add(size);
  notes[`viewport.${viewportsSeen.size}`] = size;
  log.push('note', `viewport ${size}`);
}

function renderEnv(): void {
  const vp = viewportInfo();
  setKv(el('env-kv'), [
    ['User agent', navigator.userAgent],
    ['devicePixelRatio', String(vp.dpr)],
    ['screen', `${vp.screen[0]}×${vp.screen[1]}`],
    ['inner', `${vp.inner[0]}×${vp.inner[1]}`],
    ['visualViewport', vp.visual === null ? 'n/a' : `${Math.round(vp.visual[0])}×${Math.round(vp.visual[1])}`],
    ['maxTouchPoints', String(vp.maxTouchPoints)],
    ['WebGL renderer', webgl ?? 'unavailable'],
    ['MCU guess', mcu],
    ['Min touch target', `${minTouchCssPx(vp.dpr || 1)} CSS px`],
  ]);
}

function renderFeatures(): void {
  const rows = Object.entries(features).map(([name, ok]) => {
    const tr = make('tr');
    tr.append(make('td', name), make('td', ok ? 'yes' : 'no', ok ? 'yes' : 'no'));
    return tr;
  });
  tbody('env-features').replaceChildren(...rows);
}

// ───────────────────────────── Build ─────────────────────────────

async function initBuild(): Promise<void> {
  el('build-sha').textContent = BUILD_SHA;
  const status = el('build-status');
  const v = await checkVersion();
  if (v.error !== undefined) {
    status.textContent = `Version check failed: ${v.error}`;
    notes.version = 'check-failed';
    return;
  }
  if (v.stale && v.remote !== null) {
    const link = make('a', `?b=${v.remote}`);
    link.href = `?b=${encodeURIComponent(v.remote)}`;
    status.replaceChildren('Stale build — reload with ', link);
    notes.version = `stale; server has ${v.remote}`;
    return;
  }
  status.textContent = 'Up to date';
  notes.version = 'up-to-date';
}

// ───────────────────────────── Audio ─────────────────────────────

function checkedValue<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
  const match = allowed.find((a) => a === value);
  return match ?? fallback;
}

const selectedRoute = (): OutputRoute => checkedValue('route', ROUTES, 'direct-anchor');
const selectedHint = (): 'balanced' | 'playback' => checkedValue('latency', HINTS, 'balanced');

function setAudioPhase(phase: AudioPhase): void {
  audioPhase = phase;
  const running = phase === 'running';
  el<HTMLButtonElement>('audio-start').disabled = phase !== 'idle';
  el<HTMLButtonElement>('audio-resume').disabled = !running;
  el<HTMLButtonElement>('audio-recreate').disabled = !running;
  el<HTMLButtonElement>('audio-bench').disabled = !running;
  el<HTMLButtonElement>('audio-tone').disabled = !running;
  el<HTMLButtonElement>('audio-stop').disabled = !(running || phase === 'busy');
}

/** Phase once a benchmark/recreate settles: a Stop pressed during it, or a failed rebuild, leaves no context. */
function settledPhase(probe: AudioProbe): AudioPhase {
  return probe.snapshot.state === 'none' ? 'idle' : 'running';
}

function renderAudio(): void {
  const s = audio?.snapshot ?? null;
  // Context latency of the running route (spec §6.4), recorded once Chromium has measured it:
  // outputLatency reads 0 until the output device has produced timing data (≈ 1 s after Start).
  // Context-level (the same for every route of one context); media-element's extra <audio>
  // buffering is judged by ear with Pitch step (checklist 2.3b).
  if (s !== null && s.state === 'running' && s.route !== null && s.outputLatency !== null && s.outputLatency > 0) {
    notes[`latency.${s.route}`] = `base=${s.baseLatency ?? 'n/a'} out=${s.outputLatency} hint=${s.latencyHint}`;
  }
  el('audio-state').textContent = s === null ? 'none' : s.state;
  el('audio-route').textContent = s?.route ?? '—';
  el('audio-quanta').textContent = String(s?.quanta ?? 0);
  el('audio-hidden-ratio').textContent = fmtNum(audio?.hiddenClockRatio ?? null, 3);
  const r = audio?.lastWorkletReport ?? null;
  const busy = r === null || r.windowMs <= 0 ? 'n/a' : `${((r.busyMs / r.windowMs) * 100).toFixed(1)}%`;
  el('audio-report').textContent =
    r === null
      ? '—'
      : `quanta=${r.quanta} busy=${busy} window=${r.windowMs.toFixed(0)} ms ctxTime=${r.currentTime.toFixed(2)} s perfInWorklet=${r.perfInWorklet}`;
  el('audio-snapshot').textContent = s === null ? '' : JSON.stringify(s, null, 1);
}

function renderBench(): void {
  const rows = bench.map((r) => {
    const tr = make('tr');
    tr.append(
      make('td', String(r.k)),
      make('td', r.ratio.toFixed(4)),
      make('td', r.overloaded ? 'yes' : 'no', r.overloaded ? 'no' : 'yes'),
      make('td', r.busyFrac === null ? 'n/a' : fmtPct(r.busyFrac * 100)),
    );
    return tr;
  });
  tbody('bench-results').replaceChildren(...rows);
  el('bench-status').textContent = headroomK === null ? 'not run' : `Done: headroom k = ${headroomK}`;
}

function startAudio(): void {
  const route = selectedRoute();
  const hint = selectedHint();
  let probe: AudioProbe;
  try {
    probe = audio ?? new AudioProbe(log, workletUrl, ANCHOR_URL); // one instance per page: recoveries + bench survive Stop/Start
  } catch (e) {
    audioFail('audio', e, 'audio-status');
    return;
  }
  audio = probe;
  setAudioPhase('starting');
  el('audio-status').textContent = 'starting…';
  // With no AudioProbe operation pending (always the case here: Start is enabled only while idle),
  // start() runs synchronously up to its first await, i.e. inside this click (user activation).
  probe.start(route, hint).then(
    () => {
      routesUsed.add(route);
      setAudioPhase('running');
      el('audio-status').textContent = `running (${route}, ${hint})`;
      if (selectedRoute() !== route) onRouteChange(); // radio changed while starting
    },
    (e: unknown) => {
      probe.stop().catch(() => undefined); // clears any half-built state, Media Session and listeners
      setAudioPhase('idle');
      audioFail('audio start', e, 'audio-status');
    },
  );
}

function resumeAudio(): void {
  const probe = audio;
  if (probe === null) return;
  probe.resume().then(
    (ok) => {
      el('audio-status').textContent = ok ? 'resume ok' : 'resume failed — try Recreate';
    },
    (e: unknown) => audioFail('audio resume', e, 'audio-status'),
  );
}

function recreateAudio(): void {
  const probe = audio;
  if (probe === null) return;
  setAudioPhase('busy');
  el('audio-status').textContent = 'recreating…';
  // Called inside the tap: with no AudioProbe operation pending, recreate() builds the new AudioContext
  // synchronously, before its first await; a queued recreate relies on Chromium's sticky user activation.
  probe.recreate().then(
    () => {
      setAudioPhase(settledPhase(probe));
      el('audio-status').textContent = 'recreated';
    },
    (e: unknown) => {
      setAudioPhase(settledPhase(probe));
      audioFail('audio recreate', e, 'audio-status');
    },
  );
}

function runBenchmark(): void {
  const probe = audio;
  if (probe === null) return;
  setAudioPhase('busy');
  el('bench-status').textContent = `running k = ${BENCH_KS.join(', ')} × ${BENCH_SECONDS} s…`;
  probe.benchmark(BENCH_KS, BENCH_SECONDS).then(
    (r) => {
      bench = r.results;
      headroomK = r.headroomK;
      // One note per latencyHint, so both legs of the Intel A/B reach the QR (bench/headroomK keep only the latest).
      const s = probe.snapshot;
      notes[`bench.${s.latencyHint}`] =
        `${r.results.map((b) => `k${b.k}=${b.ratio}${b.overloaded ? '!' : ''}`).join(' ')} headroomK=${r.headroomK}` +
        ` busy=${r.results.map((b) => b.busyFrac ?? 'n/a').join(',')}` +
        ` sr=${s.sampleRate ?? 'n/a'} baseLat=${s.baseLatency ?? 'n/a'} outLat=${s.outputLatency ?? 'n/a'} perfInWorklet=${String(s.perfInWorklet)}`;
      setAudioPhase(settledPhase(probe)); // a Stop pressed during the benchmark leaves no context
      renderBench(); // AudioProbe.benchmark() already logged `bench headroomK=<k>` — no second entry here
    },
    (e: unknown) => {
      setAudioPhase(settledPhase(probe)); // e.g. Stop during the benchmark: back to idle, Start re-enabled
      audioFail('benchmark', e, 'bench-status');
    },
  );
}

function stopAudio(): void {
  const probe = audio;
  if (probe === null) return;
  const s = probe.snapshot;
  if (s.state !== 'none') lastAudioState = s; // the export keeps this after stop() resets the snapshot
  probe.stop().then(
    () => {
      setAudioPhase('idle');
      el('audio-status').textContent = 'stopped';
    },
    (e: unknown) => {
      setAudioPhase('idle');
      audioFail('audio stop', e, 'audio-status');
    },
  );
}

function onRouteChange(): void {
  const route = selectedRoute();
  renderObservations();
  const probe = audio;
  if (probe === null || (audioPhase !== 'running' && audioPhase !== 'busy')) return;
  probe.setRoute(route).then(
    () => {
      routesUsed.add(route);
      el('audio-status').textContent = `running (${route})`;
    },
    (e: unknown) => audioFail(`route ${route}`, e, 'audio-status'),
  );
}

/** Pitch step: an audible tap stimulus; the tester judges the tap → pitch-change delay of each route (checklist 2.3b). */
function stepTone(): void {
  const probe = audio;
  if (probe === null) return;
  toneHz = toneHz === PROBE_TONE_HZ ? PROBE_TONE_HZ * 2 : PROBE_TONE_HZ;
  probe.setTone(toneHz);
  log.push('note', `tone ${toneHz} Hz on ${probe.snapshot.route ?? selectedRoute()}`);
}

/**
 * Attributes a hidden-period audio-clock ratio to the active route, exactly when AudioProbe measured
 * a fresh one: it pushes `audio` `hidden <s>s clock ratio=…` right after updating hiddenClockRatio,
 * and pushes nothing for a hidden period it could not measure (so no stale ratio is copied).
 */
function onHiddenRatioLogged(e: LogEntry): void {
  const probe = audio;
  if (e.kind !== 'audio' || !e.detail.startsWith('hidden ') || probe === null) return;
  const route = probe.snapshot.route;
  const ratio = probe.hiddenClockRatio;
  if (route === null || ratio === null) return;
  observationFor(route).hiddenClockRatio = ratio;
  routesUsed.add(route);
  renderObservations();
}

// ───────────────────────────── Route observations ─────────────────────────────

type YesNoKey = 'miniplayer' | 'survivesMinimise' | 'wheelTilt';
type ObsKey = YesNoKey | 'music';

const QUESTIONS: readonly { key: ObsKey; label: string; options: readonly string[] }[] = [
  { key: 'miniplayer', label: 'Miniplayer shows Tesbox while the browser is minimised?', options: ['yes', 'no', '?'] },
  { key: 'survivesMinimise', label: 'Tone keeps playing while minimised?', options: ['yes', 'no', '?'] },
  { key: 'wheelTilt', label: 'Left scroll-wheel tilt logged as nexttrack/previoustrack or MediaTrack key?', options: ['yes', 'no', '?'] },
  { key: 'music', label: 'Your music when Tesbox audio started:', options: ['paused', 'mixed', '?'] },
];

function observationFor(route: OutputRoute): RouteObservation {
  const existing = routes[route];
  if (existing !== undefined) return existing;
  const created: RouteObservation = { miniplayer: '?', survivesMinimise: '?', wheelTilt: '?', music: '?', hiddenClockRatio: null };
  routes[route] = created;
  return created;
}

function setObservation(o: RouteObservation, key: ObsKey, value: string): void {
  if (key === 'music') {
    if (value === 'paused' || value === 'mixed' || value === '?') o.music = value;
    return;
  }
  if (value === 'yes' || value === 'no' || value === '?') o[key] = value;
}

function isObsKey(v: string | undefined): v is ObsKey {
  return QUESTIONS.some((q) => q.key === v);
}

function renderObservations(): void {
  const route = selectedRoute();
  el('obs-route').textContent = route;
  const current = routes[route];
  const rows = QUESTIONS.map((q) => {
    const row = make('div', undefined, 'obs-row');
    const buttons = make('div', undefined, 'buttons');
    for (const option of q.options) {
      const b = make('button', option);
      b.type = 'button';
      b.dataset.q = q.key;
      b.dataset.v = option;
      b.setAttribute('aria-pressed', String(current !== undefined && current[q.key] === option));
      buttons.append(b);
    }
    row.append(make('span', q.label), buttons);
    return row;
  });
  const ratio = current?.hiddenClockRatio ?? null;
  const ratioLine = make('p', `Hidden clock ratio for this route: ${fmtNum(ratio, 3)}`, 'muted');
  el('observations').replaceChildren(...rows, ratioLine);
}

function onObservationClick(ev: Event): void {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>('button[data-q]');
  const key = button?.dataset.q;
  const value = button?.dataset.v;
  if (button === null || !isObsKey(key) || value === undefined) return;
  const route = selectedRoute();
  setObservation(observationFor(route), key, value);
  routesUsed.add(route);
  log.push('note', `${route} ${key}=${value}`);
  renderObservations();
}

// ───────────────────────────── GPS ─────────────────────────────

function setGpsButtons(running: boolean): void {
  for (const b of el('gps-modes').querySelectorAll<HTMLButtonElement>('button')) b.disabled = running || gpsRunner === null;
  el<HTMLButtonElement>('gps-stop').disabled = !running;
}

function renderGpsLive(): void {
  const live = gpsLive;
  if (gpsRunner === null) {
    el('gps-live').textContent = 'Geolocation API unavailable';
    return;
  }
  if (live === null) {
    el('gps-live').textContent = 'idle';
    return;
  }
  const left = Math.max(0, Math.ceil((live.endsAtMs - performance.now()) / 1000));
  el('gps-live').textContent = `${live.mode}: ${live.fixes} fixes, ${live.errors} errors, ${left} s left`;
}

function renderGpsResults(): void {
  const rows = gpsSummaries.map((s) => {
    const tr = make('tr');
    tr.dataset.mode = s.mode;
    tr.dataset.fixes = String(s.fixes);
    const cells = [
      s.mode,
      String(s.durationS),
      String(s.fixes),
      `${s.errors.permission}/${s.errors.unavailable}/${s.errors.timeout}`,
      `${fmtNum(s.intervalMedianMs)}/${fmtNum(s.intervalP95Ms)}`,
      `${fmtNum(s.ageMedianMs)}/${fmtNum(s.ageP95Ms)}`,
      fmtPct(s.staleOver3sPct),
      fmtPct(s.duplicatePct),
      fmtPct(s.speedNullPct),
      fmtPct(s.speedZeroPct),
      fmtPct(s.speedZeroWhileMovingPct),
      fmtNum(s.accuracyMedianM, 1),
      fmtPct(s.altitudePresentPct),
      String(s.fixesWhileHidden),
      fmtNum(s.maxSpeedMps, 1),
      s.crashedPreviously ? 'yes' : 'no',
    ];
    tr.append(...cells.map((c) => make('td', c)));
    return tr;
  });
  tbody('gps-results').replaceChildren(...rows);
}

function runGps(mode: GpsMode): void {
  const runner = gpsRunner;
  if (runner === null || runner.running) return;
  const name = modeName(mode);
  gpsLive = { mode: name, fixes: 0, errors: 0, endsAtMs: performance.now() + gpsSeconds * 1000 };
  setGpsButtons(true);
  renderGpsLive();
  runner
    .run(mode, gpsSeconds) // T5's default isHidden reads document.visibilityState
    .then(
      (s) => {
        gpsSummaries.push(s); // T5 already flags the first run of a mode whose crash marker previousCrash() consumed
        renderGpsResults();
      },
      (e: unknown) => fail(`gps ${name}`, e, 'gps-live'),
    )
    .finally(() => {
      gpsLive = null;
      setGpsButtons(false);
      renderGpsLive();
    });
}

function initGps(): void {
  el('gps-seconds').textContent = String(gpsSeconds);
  const crash = GpsRunner.previousCrash();
  if (crash !== null) {
    const banner = el('gps-crash');
    banner.textContent = `The previous ${crash.mode} run (started ${crash.startedAt}) never finished — the page crashed or was reloaded during it.`;
    banner.hidden = false;
    notes.gpsCrash = `${crash.mode} started ${crash.startedAt}`;
    log.push('gps', `previous run did not finish: ${crash.mode}`);
  }
  const items = GPS_MODES.map((mode) => {
    const name = modeName(mode);
    const li = make('li');
    const b = make('button', `Run ${gpsSeconds} s — ${name}`);
    b.type = 'button';
    b.id = `gps-run-${name}`;
    b.addEventListener('click', () => runGps(mode));
    li.append(b);
    return li;
  });
  el('gps-modes').replaceChildren(...items);
  el('gps-stop').addEventListener('click', () => gpsRunner?.stop());
  // GpsRunner logs `fix …` per fix and `error code=<n>` per failed request; its own `run … start/end`
  // lines are neither, so they do not inflate the live counters.
  log.subscribe((e) => {
    if (e.kind !== 'gps' || gpsLive === null) return;
    if (e.detail.startsWith('fix')) gpsLive.fixes++;
    else if (e.detail.startsWith('error')) gpsLive.errors++;
  });
  setGpsButtons(false);
  renderGpsLive();
}

// ───────────────────────────── Inputs & event log ─────────────────────────────

let logRenderPending = false;

function renderLog(): void {
  logRenderPending = false;
  const items = log
    .entries()
    .slice(-LOG_VIEW_SIZE)
    .reverse()
    .map((e) => make('li', formatEntry(e)));
  el('log-view').replaceChildren(...items);
}

function scheduleLogRender(): void {
  if (logRenderPending) return;
  logRenderPending = true;
  window.setTimeout(renderLog, 100);
}

function renderInputCounts(): void {
  const c = inputs.counts;
  const media = Object.entries(c.mediaSession)
    .map(([action, n]) => `${action}×${n}`)
    .join(', ');
  setKv(el('input-counts'), [
    ['Media Session', media || 'none'],
    ['Keys', c.keys.length > 0 ? c.keys.join(', ') : 'none'],
    ['Wheel events', String(c.wheel)],
    ['Gamepads', c.gamepads.length > 0 ? c.gamepads.join(', ') : 'none'],
    ['Visibility changes', String(c.visibilityChanges)],
    ['Log events', String(log.count())],
  ]);
}

/** Per-axis ranges as "x:-1.2..0.5,y:…,z:…" (m/s²), "n/a" when the vector was not reported on every axis. */
function fmtAxes(a: AxisRanges | null): string {
  return a === null ? 'n/a' : `x:${a.x.join('..')},y:${a.y.join('..')},z:${a.z.join('..')}`;
}

function renderMotion(r: MotionReport): void {
  const range = r.accelRange === null ? 'n/a' : `${r.accelRange[0].toFixed(2)}…${r.accelRange[1].toFixed(2)} m/s²`;
  el('motion-result').textContent =
    `available=${r.available} permission=${r.permission} events=${r.events} rate=${fmtNum(r.rateHz, 1)} Hz range=${range}` +
    ` acc=${fmtAxes(r.axes.acc)} accG=${fmtAxes(r.axes.accG)} interval=${fmtNum(r.axes.intervalMs, 1)} ms`;
}

function probeMotion(): void {
  const b = el<HTMLButtonElement>('motion-run');
  b.disabled = true;
  el('motion-result').textContent = `listening for ${motionSeconds} s…`;
  // Called synchronously in the click: DeviceMotionEvent.requestPermission needs user activation.
  inputs.probeMotion(motionSeconds * 1000).then(
    (r) => {
      motion = r; // the summary's `motion` is the latest run; every run is also kept as a note
      notes[`motion.${++motionRuns}`] =
        `available=${r.available} permission=${r.permission} events=${r.events} rate=${r.rateHz ?? 'n/a'} range=${r.accelRange?.join('..') ?? 'n/a'}` +
        ` acc=${fmtAxes(r.axes.acc)} accG=${fmtAxes(r.axes.accG)} interval=${r.axes.intervalMs ?? 'n/a'}`;
      renderMotion(r);
      b.disabled = false;
    },
    (e: unknown) => {
      b.disabled = false;
      fail('motion', e, 'motion-result');
    },
  );
}

// ───────────────────────────── Storage ─────────────────────────────

function renderStorage(r: StorageReport): void {
  setKv(el('storage-report'), [
    ['localStorage', String(r.localStorage)],
    ['Visits', String(r.visits)],
    ['First seen', r.firstSeen ?? '—'],
    ['Previous visit', r.lastSeen ?? '—'],
    ['Cache Storage', String(r.cacheStorage)],
    ['Cache entry from earlier visit', r.cachePersisted === null ? 'n/a' : String(r.cachePersisted)],
    ['Cache entry age', r.cacheAgeS === null ? '—' : `${r.cacheAgeS} s`],
    ['Service worker supported', String(r.swSupported)],
    ['Service worker registered', String(r.swRegistered)],
    // By the probe's own /probe/sw.js; the next row names whichever worker it was (the app's /sw.js also covers /probe/).
    ['Page controlled at load', String(r.swControlled)],
    ['Controlling worker at load', r.controllerScript ?? 'none'],
    ['Errors', r.error ?? 'none'],
  ]);
}

function initStorage(): void {
  runStorageProbe().then(
    (r) => {
      storage = r;
      renderStorage(r);
      log.push(
        'storage',
        `localStorage=${r.localStorage} visits=${r.visits} cache=${r.cacheStorage} persisted=${String(r.cachePersisted)} sw=${r.swRegistered} controlled=${r.swControlled} controller=${r.controllerScript ?? 'none'}`,
      );
    },
    (e: unknown) => fail('storage', e),
  );
}

// ───────────────────────────── Export (QR) ─────────────────────────────

function selectValue(id: string): string {
  return el<HTMLSelectElement>(id).value;
}

function collectSummary(): ProbeSummary {
  for (const r of routesUsed) observationFor(r);
  const allNotes: Record<string, string> = { ...notes };
  const model = selectValue('note-model');
  const musicResume = selectValue('note-music-resume');
  const anc = selectValue('note-anc');
  if (model !== '') allNotes.model = model;
  if (musicResume !== '') allNotes.musicResumesAfterStop = musicResume;
  if (anc !== '') allNotes.ancInterference = anc;
  // Counts since load (C8.2): they survive after the 40-line log tail has scrolled past the events.
  const ev = audio?.events ?? { stateChanges: 0, elementPauses: 0, errors: 0 };
  allNotes['audio.events'] =
    `stateChanges=${ev.stateChanges} elementPauses=${ev.elementPauses} errors=${ev.errors + audioControlErrors}`;
  // While audio is stopped the live snapshot is empty (state 'none'): export the one taken at the last Stop.
  const live = audio?.snapshot ?? null;
  const snap = live !== null && live.state === 'none' && lastAudioState !== null ? lastAudioState : live;
  return buildSummary(
    {
      sha: BUILD_SHA,
      at: new Date().toISOString(),
      env: { ua: navigator.userAgent, viewport: viewportInfo(), webgl, mcu, features },
      audio: snap === null ? null : { ...snap, bench: [...bench], headroomK },
      routes: { ...routes },
      gps: [...gpsSummaries],
      motion,
      storage,
      inputs: inputs.counts,
      notes: allNotes,
    },
    log,
  );
}

function showQrPage(page: number): void {
  qrPage = Math.min(Math.max(page, 0), Math.max(qrCount - 1, 0));
  const figures = el('qr-list').querySelectorAll<HTMLElement>('figure');
  figures.forEach((f, i) => {
    f.hidden = i !== qrPage;
  });
  el<HTMLButtonElement>('qr-prev').disabled = qrPage <= 0;
  el<HTMLButtonElement>('qr-next').disabled = qrPage >= qrCount - 1;
}

function showQr(): void {
  const status = el('qr-status');
  let summary: ProbeSummary;
  try {
    summary = collectSummary();
  } catch (e) {
    fail('export', e, 'qr-status');
    return;
  }
  const json = JSON.stringify(summary);
  el('summary-json').textContent = JSON.stringify(summary, null, 2);
  const chunks = chunkText(json);
  const figures: HTMLElement[] = [];
  try {
    chunks.forEach((chunk, i) => {
      const figure = make('figure', undefined, 'qr');
      const canvas = make('canvas');
      drawQr(canvas, encodeQr(chunk));
      figure.append(canvas, make('figcaption', `QR ${i + 1}/${chunks.length}`));
      figures.push(figure);
    });
  } catch (e) {
    fail('QR encode', e, 'qr-status');
    return;
  }
  el('qr-list').replaceChildren(...figures);
  qrCount = figures.length;
  showQrPage(0);
  const bytes = new TextEncoder().encode(json).length;
  status.textContent = `${bytes} bytes in ${qrCount} QR code(s). Scan every page with your phone, in order.`;
  log.push('note', `exported ${qrCount} QR code(s)`);
}

// ───────────────────────────── Boot ─────────────────────────────

function boot(): void {
  window.addEventListener('error', (e) => log.push('error', e.message || 'script error'));
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => log.push('error', `unhandled: ${errText(e.reason)}`));
  log.subscribe(scheduleLogRender);

  applyTouchSize();
  renderEnv();
  renderFeatures();
  recordViewport();
  window.addEventListener('resize', () => {
    applyTouchSize();
    renderEnv();
    recordViewport();
  });
  window.visualViewport?.addEventListener('resize', renderEnv);

  el('audio-start').addEventListener('click', startAudio);
  el('audio-resume').addEventListener('click', resumeAudio);
  el('audio-recreate').addEventListener('click', recreateAudio);
  el('audio-bench').addEventListener('click', runBenchmark);
  el('audio-tone').addEventListener('click', stepTone);
  el('audio-stop').addEventListener('click', stopAudio);
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="route"]')) {
    input.addEventListener('change', onRouteChange);
  }
  el('observations').addEventListener('click', onObservationClick);
  log.subscribe(onHiddenRatioLogged);
  setAudioPhase('idle');
  renderObservations();
  renderBench();

  initGps();

  inputs.attach();
  el('motion-seconds').textContent = String(motionSeconds);
  el('motion-run').addEventListener('click', probeMotion);

  el('qr-show').addEventListener('click', showQr);
  el('qr-prev').addEventListener('click', () => showQrPage(qrPage - 1));
  el('qr-next').addEventListener('click', () => showQrPage(qrPage + 1));

  window.setInterval(() => {
    renderAudio();
    renderInputCounts();
    renderGpsLive();
  }, 250);
  renderAudio();
  renderInputCounts();
  renderLog();

  initBuild().catch((e: unknown) => fail('version check', e, 'build-status'));
  initStorage();
}

boot();
