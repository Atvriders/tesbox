/**
 * Diagnostics (phase-3 contract T8; spec §1.3 b, §10.2 item 6): live worklet snapshot fields with the
 * flags decoded, GPS status and fix age, audio state / tier / route / latencies, overload and recovery
 * counters, MCU guess, dpr and viewport, and the last 40 input events. **Show QR** exports a
 * statistics-only JSON summary — never coordinates: fields are picked one by one and the result must
 * pass `assertNoCoordinates` (src/probe/summary.ts) — split by `chunkText` and drawn by `drawQr`.
 *
 * The input log and the session counters are app-wide singletons: the counters follow the store from
 * the moment this module loads (the shell imports it at boot), so overloads, interruptions and DSP
 * resets are counted whichever screen is up; Drive (src/ui/drive.tsx) logs every input it acts on.
 * This screen only logs (media keys, Media Session actions, gamepad presses) — it never shifts.
 */
import { effect, type ReadonlySignal } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { F, S, type OutputRoute } from '../contracts';
import { MPS_TO_UNITS, type Settings } from '../app/settings';
import * as store from '../app/store';
import type { AudioState, AudioStatus, GpsState, Screen } from '../app/store';
import type { EngineAudioDiagnostics, MediaAction } from '../audio/engine-audio';
import { attachGamepad, type GamepadHost } from '../input/gamepad';
import type { KeyTarget } from '../input/keyboard';
import { MEDIA_KEY, mediaKeyCode } from '../input/media-shift';
import { BUILD_SHA } from '../platform/build-info';
import { viewportInfo, type Mcu, type ViewportInfo } from '../platform/detect';
import { chunkText, drawQr, encodeQr } from '../platform/qr';
import { assertNoCoordinates } from '../probe/summary';
import type { ScreenProps } from './app';
import { STR } from './strings';
import { detectedMcu } from './tach';

// ───────────────────────────── Input log ─────────────────────────────

export type InputSource = 'paddle' | 'key' | 'gamepad' | 'media';

export interface InputEvent {
  /** performance.now() at the event, ms. */
  tMs: number;
  source: InputSource;
  detail: string;
}

/** Contract T8: Diagnostics shows the last 40 input events. */
export const INPUT_LOG_SIZE = 40;

/** The newest INPUT_LOG_SIZE input events; subscribers hear every push. */
export class InputLog {
  private readonly items: InputEvent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly capacity = INPUT_LOG_SIZE) {}

  push(source: InputSource, detail: string, tMs: number = performance.now()): void {
    this.items.push({ tMs, source, detail });
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    for (const fn of [...this.listeners]) fn();
  }

  /** Oldest first (copies). */
  entries(): InputEvent[] {
    return this.items.map((e) => ({ ...e }));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/** The app's input log: Drive logs every input, Diagnostics and the wheel test add what they see. */
export const inputLog = new InputLog();

export function formatInputEvent(e: InputEvent): string {
  return STR.diag.inputEvent((e.tMs / 1000).toFixed(1), e.source, e.detail);
}

// ───────────────────────────── Flags ─────────────────────────────

const FLAG_NAMES = (Object.entries(F) as [keyof typeof F, number][]).sort((a, b) => a[1] - b[1]);

/** Names of the F bits set in `flags`, lowest bit first. */
export function decodeFlags(flags: number): string[] {
  if (!Number.isFinite(flags)) return [];
  return FLAG_NAMES.filter(([, bit]) => (flags & bit) !== 0).map(([name]) => name);
}

// ───────────────────────────── Session counters ─────────────────────────────

export interface SessionCounters {
  /** F.OVERLOAD episodes outside the start-up benchmark (spec §1.3 b). */
  overloadEvents: number;
  /** Audio that stopped without the user asking ('interrupted'). */
  interruptions: number;
  /** Audio failures ('error'). */
  audioErrors: number;
  /** DSP non-finite resets, summed over every worklet of the session (a rebuild restarts its counter). */
  nonFiniteResets: number;
  snapshots: number;
  /** Highest worklet busy fraction outside the benchmark; null until one is known. */
  maxBusyFrac: number | null;
}

/**
 * Worklet seconds after the last benchmark snapshot (k > 1) during which overload is the benchmark's:
 * the worklet's OVERLOAD needs two ~1 s busy windows, which may still hold k = 4 / 8 load.
 */
const BENCH_GRACE_S = 3;

/** Accumulates the session counters from snapshots and audio states. */
export class SessionStats {
  private c: SessionCounters = {
    overloadEvents: 0,
    interruptions: 0,
    audioErrors: 0,
    nonFiniteResets: 0,
    snapshots: 0,
    maxBusyFrac: null,
  };
  private lastT = Number.NEGATIVE_INFINITY;
  private lastBenchT = Number.NEGATIVE_INFINITY;
  private lastResets = 0;
  private overloaded = false;
  private audio: AudioStatus | null = null;

  pushSnapshot(buf: Float64Array): void {
    const t = buf[S.time] ?? Number.NaN;
    if (t < this.lastT) {
      // A rebuilt worklet (recover()): its clock and counters start again.
      this.lastBenchT = Number.NEGATIVE_INFINITY;
      this.lastResets = 0;
      this.overloaded = false;
    }
    if (Number.isFinite(t)) this.lastT = t;
    this.c.snapshots++;

    const resets = buf[S.nonFiniteResets] ?? 0;
    if (Number.isFinite(resets)) {
      this.c.nonFiniteResets += resets >= this.lastResets ? resets - this.lastResets : resets;
      this.lastResets = resets;
    }

    const bench = (buf[S.benchK] ?? 1) > 1;
    if (bench) this.lastBenchT = t;
    const benchLoad = bench || !(t - this.lastBenchT > BENCH_GRACE_S);
    const overload = ((buf[S.flags] ?? 0) & F.OVERLOAD) !== 0;
    if (overload && !this.overloaded && !benchLoad) this.c.overloadEvents++;
    // Overload inside the grace is not remembered as seen: one still up when the grace ends counts once.
    this.overloaded = overload && !benchLoad;

    const busy = buf[S.busyFrac] ?? Number.NaN;
    if (!benchLoad && Number.isFinite(busy)) this.c.maxBusyFrac = Math.max(this.c.maxBusyFrac ?? 0, busy);
  }

  pushAudio(state: AudioStatus): void {
    if (state === this.audio) return;
    this.audio = state;
    if (state === 'interrupted') this.c.interruptions++;
    else if (state === 'error') this.c.audioErrors++;
  }

  counters(): SessionCounters {
    return { ...this.c };
  }
}

/** Feeds `stats` from the snapshot and audio signals; returns the stop function. */
export function startSessionStats(
  snapshot: ReadonlySignal<Float64Array>,
  audio: ReadonlySignal<AudioState>,
  stats: SessionStats,
): () => void {
  const stopSnap = effect(() => stats.pushSnapshot(snapshot.value));
  const stopAudio = effect(() => stats.pushAudio(audio.value.state));
  return () => {
    stopSnap();
    stopAudio();
  };
}

/** The session's counters, collected from load (spec §1.3 b: read via the Diagnostics QR after a drive). */
export const sessionStats = new SessionStats();
startSessionStats(store.snapshot, store.audio, sessionStats);

// ───────────────────────────── Navigation ─────────────────────────────

let returnTo: Screen = 'drive';

/** Opens Diagnostics from `from` (Drive's status dot, Settings); Back returns there. */
export function openDiagnostics(from: Screen): void {
  returnTo = from === 'diagnostics' ? returnTo : from;
  store.go('diagnostics');
}

export function diagnosticsReturn(): Screen {
  return returnTo;
}

// ───────────────────────────── QR summary ─────────────────────────────

export interface DiagSummaryParts {
  sha: string;
  /** ISO time. */
  at: string;
  env: { ua: string; mcu: Mcu; viewport: ViewportInfo };
  settings: Settings;
  audio: AudioState;
  audioDiag: EngineAudioDiagnostics;
  gps: GpsState;
  snapshot: Float64Array;
  counters: SessionCounters;
  inputs: readonly InputEvent[];
}

export interface DiagSummary {
  v: 1;
  sha: string;
  at: string;
  env: { ua: string; mcu: Mcu; viewport: ViewportInfo };
  settings: {
    engineId: string;
    teslaId: string | null;
    notListed: boolean;
    subwoofer: string;
    hpCornerHz: number;
    volumeTrimDb: number;
    source: string;
    tierPref: string;
    liteNextStart: boolean;
    gearboxMode: string;
    driveMode: string;
    valve: string;
    perspective: string;
    gpsMethod: string;
    highAccuracy: boolean;
    gpsLatencyS: number;
    outputRoute: OutputRoute;
    gamepadSwap: boolean;
    wheelShift: { tested: boolean; works: boolean; enabled: boolean };
  };
  audio: {
    state: AudioStatus;
    route: OutputRoute;
    tier: string | null;
    message: string | null;
    contextState: string;
    sampleRate: number | null;
    baseLatencyS: number | null;
    outputLatencyS: number | null;
    latencyHint: string | null;
    recoveries: { resumeOk: number; resumeFail: number; recreate: number };
    headroomK: number | null;
    bench: { k: number; ratio: number | null; overloaded: boolean | null; busyFrac: number | null }[];
  };
  gps: { status: string; parked: boolean; fixAgeS: number | null };
  snapshot: {
    time: number | null;
    rpm: number | null;
    gear: number | null;
    speedMps: number | null;
    load: number | null;
    throttle: number | null;
    boost: number | null;
    busyFrac: number | null;
    tier: 'full' | 'lite';
    benchK: number | null;
    fixesAccepted: number | null;
    fixesRejected: number | null;
    nonFiniteResets: number | null;
    flags: string[];
  };
  counters: SessionCounters;
  /** Last ≤ 40 input events, formatted. */
  inputs: string[];
}

/** `x` rounded to `digits` decimals; null when unknown (JSON has no NaN). */
function num(x: number | null | undefined, digits = 0): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * The statistics-only export. Every field is picked explicitly, so nothing a part happens to carry
 * leaks into it; `assertNoCoordinates` then refuses the whole export if a coordinate key got in anyway.
 */
export function buildDiagSummary(p: DiagSummaryParts): DiagSummary {
  const s = p.settings;
  const b = p.snapshot;
  const at = (i: number): number | undefined => b[i];
  const d = p.audioDiag;
  const summary: DiagSummary = {
    v: 1,
    sha: p.sha,
    at: p.at,
    env: { ua: p.env.ua, mcu: p.env.mcu, viewport: { ...p.env.viewport } },
    settings: {
      engineId: s.engineId,
      teslaId: s.teslaId,
      notListed: s.notListed !== null,
      subwoofer: s.subwoofer,
      hpCornerHz: s.hpCornerHz,
      volumeTrimDb: s.volumeTrimDb,
      source: s.source,
      tierPref: s.tierPref,
      liteNextStart: s.liteNextStart,
      gearboxMode: s.gearboxMode,
      driveMode: s.driveMode,
      valve: s.valve,
      perspective: s.perspective,
      gpsMethod: s.gpsMethod,
      highAccuracy: s.highAccuracy,
      gpsLatencyS: s.gpsLatencyS,
      outputRoute: s.outputRoute,
      gamepadSwap: s.gamepadSwap,
      wheelShift: { tested: s.wheelShift.tested, works: s.wheelShift.works, enabled: s.wheelShift.enabled },
    },
    audio: {
      state: p.audio.state,
      route: p.audio.route,
      tier: p.audio.tier,
      message: p.audio.message ?? null,
      contextState: d.contextState,
      sampleRate: d.sampleRate,
      baseLatencyS: num(d.baseLatencyS, 4),
      outputLatencyS: num(d.outputLatencyS, 4),
      latencyHint: d.latencyHint,
      recoveries: { resumeOk: d.recoveries.resumeOk, resumeFail: d.recoveries.resumeFail, recreate: d.recoveries.recreate },
      headroomK: d.bench?.headroomK ?? null,
      bench: (d.bench?.steps ?? []).map((st) => ({
        k: st.k,
        ratio: num(st.ratio, 3),
        overloaded: st.overloaded,
        busyFrac: num(st.busyFrac, 3),
      })),
    },
    gps: { status: p.gps.status, parked: p.gps.parked, fixAgeS: num(p.gps.fixAgeS, 2) },
    snapshot: {
      time: num(at(S.time), 2),
      rpm: num(at(S.rpm)),
      gear: num(at(S.gear)),
      speedMps: num(at(S.speedMps), 2),
      load: num(at(S.load), 3),
      throttle: num(at(S.throttle), 3),
      boost: num(at(S.boost), 3),
      busyFrac: num(at(S.busyFrac), 3),
      tier: at(S.tier) === 1 ? 'lite' : 'full',
      benchK: num(at(S.benchK)),
      fixesAccepted: num(at(S.fixesAccepted)),
      fixesRejected: num(at(S.fixesRejected)),
      nonFiniteResets: num(at(S.nonFiniteResets)),
      flags: decodeFlags(at(S.flags) ?? 0),
    },
    counters: { ...p.counters, maxBusyFrac: num(p.counters.maxBusyFrac, 3) },
    inputs: p.inputs.slice(-INPUT_LOG_SIZE).map(formatInputEvent),
  };
  assertNoCoordinates(summary);
  return summary;
}

const QR_QUIET_MODULES = 4;

/** Pixels per QR module so the symbol and its quiet zone fit `availPx`: 2 … 8. */
export function qrScale(modules: number, availPx: number): number {
  const fit = Math.floor(availPx / (modules + 2 * QR_QUIET_MODULES));
  return Math.min(8, Math.max(2, fit));
}

// ───────────────────────────── Panels ─────────────────────────────

/** What the panels show: the export's parts without its time and input log, plus the parked state. */
export type DiagViewParts = Omit<DiagSummaryParts, 'at' | 'inputs'> & { parked: boolean };

export interface DiagPanel {
  title: string;
  rows: [label: string, value: string][];
}

/** `x` with `digits` decimals, through a STR.diag unit formatter when given; a dash when unknown. */
function show(x: number | null | undefined, digits = 0, unit?: (v: string) => string): string {
  if (typeof x !== 'number' || !Number.isFinite(x)) return STR.diag.none;
  const v = x.toFixed(digits);
  return unit === undefined ? v : unit(v);
}

function yesNo(b: boolean): string {
  return b ? STR.diag.yes : STR.diag.no;
}

/** The Diagnostics panels as label / value text (the input log is listed on its own). */
export function diagnosticsPanels(p: DiagViewParts): DiagPanel[] {
  const at = (i: number): number => p.snapshot[i] ?? Number.NaN;
  const f = STR.diag.f;
  const d = p.audioDiag;
  const r = d.recoveries;
  const c = p.counters;
  const vp = p.env.viewport;
  const flags = decodeFlags(at(S.flags));
  const units = p.settings.units;
  const inUnits = (v: string): string => STR.diag.inUnits(v, STR.units[units]);
  return [
    {
      title: STR.diag.engine,
      rows: [
        [f.time, show(at(S.time), 2, STR.diag.seconds)],
        [f.rpm, show(at(S.rpm))],
        [f.gear, show(at(S.gear))],
        [
          f.speed,
          STR.diag.speedBoth(show(at(S.speedMps), 2, STR.diag.mps), show(at(S.speedMps) * MPS_TO_UNITS[units], 0, inUnits)),
        ],
        [f.load, show(at(S.load), 3)],
        [f.throttle, show(at(S.throttle), 3)],
        [f.boost, show(at(S.boost), 3)],
        [f.flags, flags.length > 0 ? flags.join(', ') : STR.diag.none],
        [f.busy, show(at(S.busyFrac) * 100, 0, STR.diag.percent)],
        [f.tier, at(S.tier) === 1 ? STR.modes.tier.lite : STR.modes.tier.full],
        [f.benchK, show(at(S.benchK))],
        [f.fixes, STR.diag.fixesValue(show(at(S.fixesAccepted)), show(at(S.fixesRejected)))],
        [f.resets, show(at(S.nonFiniteResets))],
      ],
    },
    {
      title: STR.diag.gps,
      rows: [
        [f.gpsStatus, STR.gpsStates[p.gps.status]],
        [f.fixAge, show(p.gps.fixAgeS, 1, STR.diag.seconds)],
        [f.parked, yesNo(p.parked)],
        [f.source, STR.modes.source[p.settings.source]],
        [f.speedUnusable, yesNo((at(S.flags) & F.SPEED_UNUSABLE) !== 0)],
      ],
    },
    {
      title: STR.diag.audio,
      rows: [
        [f.audioState, STR.audioStates[p.audio.state]],
        [f.route, STR.settingsUi.routes[p.audio.route]],
        [f.tier, p.audio.tier === null ? STR.diag.none : STR.modes.tier[p.audio.tier]],
        [f.context, d.contextState],
        [f.sampleRate, show(d.sampleRate, 0, STR.diag.hz)],
        [f.baseLatency, show((d.baseLatencyS ?? Number.NaN) * 1000, 0, STR.diag.ms)],
        [f.outputLatency, show((d.outputLatencyS ?? Number.NaN) * 1000, 0, STR.diag.ms)],
        [f.latencyHint, d.latencyHint ?? STR.diag.none],
        [f.headroom, show(d.bench?.headroomK)],
        [f.recoveries, STR.diag.recoveriesValue(r.resumeOk, r.resumeFail, r.recreate)],
      ],
    },
    {
      title: STR.diag.counters,
      rows: [
        [f.overloads, String(c.overloadEvents)],
        [f.interruptions, String(c.interruptions)],
        [f.audioErrors, String(c.audioErrors)],
        [f.resetsSession, String(c.nonFiniteResets)],
        [f.maxBusy, show((c.maxBusyFrac ?? Number.NaN) * 100, 0, STR.diag.percent)],
        [f.snapshots, String(c.snapshots)],
        [f.liteNext, yesNo(p.settings.liteNextStart)],
      ],
    },
    {
      title: STR.diag.platform,
      rows: [
        [f.mcu, p.env.mcu],
        [f.dpr, show(vp.dpr, 2)],
        [f.viewport, STR.diag.size(vp.inner[0], vp.inner[1])],
        [f.visual, vp.visual === null ? STR.diag.none : STR.diag.size(Math.round(vp.visual[0]), Math.round(vp.visual[1]))],
        [f.screen, STR.diag.size(vp.screen[0], vp.screen[1])],
        [f.touch, String(vp.maxTouchPoints)],
        [f.build, p.sha],
      ],
    },
  ];
}

// ───────────────────────────── Log-only listeners ─────────────────────────────

export interface InputLoggerDeps {
  keyTarget: KeyTarget;
  gamepadHost: GamepadHost | null;
  onMediaAction(listener: (action: MediaAction) => void): () => void;
  log: Pick<InputLog, 'push'>;
}

/** Logs media keys, Media Session actions and gamepad presses without acting on them. Returns the detach function. */
export function attachInputLogger(d: InputLoggerDeps): () => void {
  const onKey = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const code = mediaKeyCode(e);
    if (!e.repeat && MEDIA_KEY.test(code)) d.log.push('key', code);
  };
  d.keyTarget.addEventListener('keydown', onKey);
  const offMedia = d.onMediaAction((action) => d.log.push('media', action));
  const pad = STR.diag.log.pad;
  const offPad =
    d.gamepadHost === null
      ? (): void => {}
      : attachGamepad(d.gamepadHost, {
          shift: (dir) => d.log.push('gamepad', dir > 0 ? pad.up : pad.down),
          cycleValve: () => d.log.push('gamepad', pad.valve),
          togglePerspective: () => d.log.push('gamepad', pad.perspective),
        });
  return () => {
    d.keyTarget.removeEventListener('keydown', onKey);
    offMedia();
    offPad();
  };
}

// ───────────────────────────── Screen ─────────────────────────────

/** Diagnostics re-renders at this rate (the snapshot itself arrives at ~30 Hz). */
const REFRESH_MS = 250;

function Rows({ rows }: { rows: DiagPanel['rows'] }): VNode {
  return (
    <dl class="kv diag-kv">
      {rows.map(([k, v]) => [<dt key={`${k}-k`}>{k}</dt>, <dd key={`${k}-v`}>{v}</dd>])}
    </dl>
  );
}

function Panel({ title, rows }: DiagPanel): VNode {
  return (
    <section class="panel group diag-panel">
      <h2>{title}</h2>
      <Rows rows={rows} />
    </section>
  );
}

interface QrState {
  chunks: string[];
  page: number;
  bytes: number;
}

function QrModal({ qr, onPage, onClose }: { qr: QrState; onPage(page: number): void; onClose(): void }): VNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const chunk = qr.chunks[qr.page] ?? '';
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    try {
      const m = encodeQr(chunk);
      const avail = Math.min(window.innerWidth - 64, window.innerHeight - 240);
      drawQr(el, m, qrScale(m.size, avail), QR_QUIET_MODULES);
      setError(null);
    } catch (err) {
      setError(STR.diag.qrFailed(err instanceof Error ? err.message : String(err)));
    }
  }, [chunk]);
  const n = qr.chunks.length;
  return (
    <div class="modal" role="dialog" aria-modal="true" aria-label={STR.diag.qrTitle}>
      <div class="panel">
        <h2>{STR.diag.qrPage(qr.page + 1, n)}</h2>
        <canvas ref={canvas} class="qr" aria-label={STR.diag.qrPage(qr.page + 1, n)} />
        <p class="muted">{error ?? STR.diag.qrHelp(qr.bytes, n)}</p>
        <div class="row">
          <button type="button" disabled={qr.page <= 0} onClick={() => onPage(qr.page - 1)}>
            {STR.diag.prev}
          </button>
          <button type="button" disabled={qr.page >= n - 1} onClick={() => onPage(qr.page + 1)}>
            {STR.diag.next}
          </button>
          <button type="button" class="btn-primary" onClick={onClose}>
            {STR.diag.close}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DiagnosticsScreen({ shell }: ScreenProps): VNode {
  const [, setTick] = useState(0);
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    const offLog = inputLog.subscribe(() => setTick((t) => t + 1));
    const offInputs = attachInputLogger({
      keyTarget: window,
      gamepadHost: window,
      onMediaAction: (l) => shell.onMediaAction(l),
      log: inputLog,
    });
    return () => {
      clearInterval(id);
      offLog();
      offInputs();
    };
  }, [shell]);

  const view: DiagViewParts = {
    sha: BUILD_SHA,
    env: { ua: navigator.userAgent, mcu: detectedMcu(), viewport: viewportInfo() },
    settings: store.settings.peek(),
    audio: store.audio.peek(),
    audioDiag: shell.diagnostics(),
    gps: store.gps.peek(),
    parked: store.parked.peek(),
    snapshot: store.snapshot.peek(),
    counters: sessionStats.counters(),
  };
  const events = inputLog.entries().reverse();

  const showQr = (): void => {
    try {
      const summary = buildDiagSummary({ ...view, at: new Date().toISOString(), inputs: inputLog.entries() });
      const json = JSON.stringify(summary);
      setQr({ chunks: chunkText(json), page: 0, bytes: new TextEncoder().encode(json).length });
      setQrError(null);
    } catch (err) {
      setQrError(STR.diag.qrFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <section class="screen" data-screen="diagnostics">
      <header class="screen-header">
        <h1>{STR.screens.diagnostics}</h1>
        <button type="button" onClick={() => store.go(diagnosticsReturn())}>
          {STR.actions.back}
        </button>
        <button type="button" class="btn-primary" onClick={showQr}>
          {STR.actions.showQr}
        </button>
      </header>
      {qrError === null ? null : (
        <p class="banner bad" role="alert">
          {qrError}
        </p>
      )}
      <div class="cards">
        {diagnosticsPanels(view).map((panel) => (
          <Panel key={panel.title} title={panel.title} rows={panel.rows} />
        ))}
        <section class="panel group diag-panel">
          <h2>{STR.diag.inputs}</h2>
          {events.length === 0 ? (
            <p class="muted">{STR.diag.noInputs}</p>
          ) : (
            <ol class="diag-log">
              {events.map((e, i) => (
                <li key={`${e.tMs}-${i}`}>{formatInputEvent(e)}</li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {qr === null ? null : (
        <QrModal qr={qr} onPage={(page) => setQr({ ...qr, page })} onClose={() => setQr(null)} />
      )}
    </section>
  );
}
