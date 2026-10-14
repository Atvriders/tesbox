/**
 * Drive (phase-3 contract T8; spec §7, §10.2 item 4, §13): the canvas tach (src/ui/tach.ts) with the
 * gear and speed in its centre, the load bar, `−` / `+` paddles on the edges, the Auto|Manual,
 * Comfort|Sport and Valves toggles, the status dot (GPS / audio / headroom; hold 700 ms for
 * Diagnostics) and the Settings button (parked only). Overlays: **Start engine** while audio is off,
 * starting or failed (with Garage, Settings and Diagnostics, since it covers the side buttons), **Tap
 * to resume** while it is interrupted (EngineAudio.recover inside the tap), the one-time Manual
 * warning (parked only) and the location-blocked banner with **Use Demo**.
 *
 * Inputs (spec §7): paddles (pointerdown), keyboard E/Q/V/P and W/S/Space, gamepad, and the
 * steering-wheel tilt as Media Session actions or MediaTrack keys (opt-in, deduped) — all posted
 * through the shell and logged for Diagnostics. Mode inputs go through Shell.post, which stores them
 * as settings (the shell forwards them to the worklet).
 *
 * Glance-safe rendering: the ~30 Hz snapshot never re-renders the component — gear and speed are
 * signal-bound text nodes, the load bar and the gear flash are written through refs, and the tach
 * polls the snapshot from its own frame loop.
 */
import { useComputed, useSignalEffect } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { F, S, type EngineDef, type GearboxMode, type ValveMode } from '../contracts';
import { MPS_TO_UNITS, type Settings, type Units } from '../app/settings';
import * as store from '../app/store';
import type { AudioStatus, GpsStatus } from '../app/store';
import { attachGamepad, type GamepadHost } from '../input/gamepad';
import { attachKeyboard, type KeyTarget } from '../input/keyboard';
import { MEDIA_KEY, MediaShift, TILT_KEYS, mediaKeyCode } from '../input/media-shift';
import { bindPaddle, type ShiftDir } from '../input/paddles';
import type { ScreenProps, Shell } from './app';
import { inputLog, openDiagnostics, type InputLog, type InputSource } from './diagnostics';
import { STR } from './strings';
import { DEFAULT_TACH_PALETTE, detectedMcu, mountTach, type TachPalette } from './tach';

// ───────────────────────────── Readouts ─────────────────────────────

/** Gear readout: N before ignition (gear 0), the gear number after, a dash for anything else. */
export function gearLabel(gear: number): string {
  if (gear === 0) return STR.drive.neutral;
  return Number.isInteger(gear) && gear > 0 ? String(gear) : STR.drive.none;
}

/** Whole mph / km/h; null without a speed. */
export function speedValue(mps: number, units: Units): number | null {
  if (!Number.isFinite(mps)) return null;
  return Math.round(Math.max(0, mps) * MPS_TO_UNITS[units]);
}

/** Overrun (engine braking) shows on the bar below this load. */
const OVERRUN_BELOW = -0.02;

/** The load bar: throttle fills it; overrun (load < 0) fills it too, marked as overrun. */
export function loadLevel(load: number): { fraction: number; overrun: boolean } {
  if (!Number.isFinite(load)) return { fraction: 0, overrun: false };
  return { fraction: Math.min(Math.abs(load), 1), overrun: load < OVERRUN_BELOW };
}

// ───────────────────────────── Status dot ─────────────────────────────

export type StatusLevel = 'off' | 'ok' | 'warn' | 'bad';
export type StatusReason =
  | 'engineOff'
  | 'audioError'
  | 'interrupted'
  | 'starting'
  | 'gpsMissing'
  | 'gpsDenied'
  | 'gpsWaiting'
  | 'gpsUnavailable'
  | 'gpsLost'
  | 'predicting'
  | 'overload'
  | 'liteNext';

export interface StatusInput {
  audio: AudioStatus;
  source: Settings['source'];
  gps: GpsStatus;
  /** Latest snapshot flags (read only while running). */
  flags: number;
  liteNextStart: boolean;
}

const BAD: ReadonlySet<StatusReason> = new Set<StatusReason>(['audioError', 'gpsMissing', 'gpsDenied', 'gpsLost', 'overload']);

/**
 * The status dot: audio first (error red, interrupted / starting amber, off grey); while running, GPS
 * when it is the speed source (blocked / missing / lost red, waiting / unavailable / dropout amber)
 * and headroom (overload red, "Lite next start" amber, spec §5.7). The latched position-only path
 * (Intel speed 0) is normal operation, not a warning.
 */
export function driveStatus(i: StatusInput): { level: StatusLevel; reasons: StatusReason[] } {
  if (i.audio === 'error') return { level: 'bad', reasons: ['audioError'] };
  if (i.audio === 'off') return { level: 'off', reasons: ['engineOff'] };
  if (i.audio === 'interrupted') return { level: 'warn', reasons: ['interrupted'] };
  if (i.audio === 'starting') return { level: 'warn', reasons: ['starting'] };
  const reasons: StatusReason[] = [];
  const flags = Number.isFinite(i.flags) ? i.flags : 0;
  if (i.source === 'gps') {
    if (i.gps === 'off') reasons.push('gpsMissing');
    else if (i.gps === 'denied') reasons.push('gpsDenied');
    else if (i.gps === 'waiting') reasons.push('gpsWaiting');
    else if (i.gps === 'unavailable') reasons.push('gpsUnavailable');
    if (flags & F.GPS_LOST) reasons.push('gpsLost');
    if (flags & F.PREDICTING) reasons.push('predicting');
  }
  if (flags & F.OVERLOAD) reasons.push('overload');
  if (i.liteNextStart) reasons.push('liteNext');
  const level: StatusLevel = reasons.some((r) => BAD.has(r)) ? 'bad' : reasons.length > 0 ? 'warn' : 'ok';
  return { level, reasons };
}

/** Rising edges of the flags the gear readout flashes on. */
export function flagEdges(prev: number, next: number): { shifting: boolean; refused: boolean } {
  const p = Number.isFinite(prev) ? prev : 0;
  const n = Number.isFinite(next) ? next : 0;
  const rose = (bit: number): boolean => (n & bit) !== 0 && (p & bit) === 0;
  return { shifting: rose(F.SHIFTING), refused: rose(F.SHIFT_REFUSED) };
}

// ───────────────────────────── Toggles ─────────────────────────────

const VALVE_ORDER: readonly ValveMode[] = ['auto', 'open', 'closed'];

/** The Valves toggle (and the V key / gamepad A): Auto → Open → Closed → Auto. */
export function nextValve(v: ValveMode): ValveMode {
  return VALVE_ORDER[(VALVE_ORDER.indexOf(v) + 1) % VALVE_ORDER.length] ?? 'auto';
}

/**
 * Tapping the Auto|Manual toggle: back to Auto at any time; Manual once the one-time warning has been
 * seen; otherwise the warning first ('warn'), which can only be shown parked ('locked' while moving).
 */
export function gearboxTap(i: { current: GearboxMode; warningSeen: boolean; parked: boolean }): GearboxMode | 'warn' | 'locked' {
  if (i.current === 'manual') return 'auto';
  if (i.warningSeen) return 'manual';
  return i.parked ? 'warn' : 'locked';
}

// ───────────────────────────── Long press ─────────────────────────────

/** Hold time of the status dot → Diagnostics (contract T8). */
export const LONG_PRESS_MS = 700;

/**
 * Calls `onFire` once a pointer has been held on `el` for `ms`; released, cancelled or left earlier
 * it does nothing. Suppresses the touch context menu. Returns the unbind function.
 */
export function bindLongPress(el: HTMLElement, onFire: () => void, ms = LONG_PRESS_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const down = (ev: Event): void => {
    if ((ev as PointerEvent).button > 0) return;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      onFire();
    }, ms);
  };
  const noMenu = (ev: Event): void => ev.preventDefault();
  const ends = ['pointerup', 'pointercancel', 'pointerleave'] as const;
  el.addEventListener('pointerdown', down);
  for (const t of ends) el.addEventListener(t, cancel);
  el.addEventListener('contextmenu', noMenu);
  return () => {
    cancel();
    el.removeEventListener('pointerdown', down);
    for (const t of ends) el.removeEventListener(t, cancel);
    el.removeEventListener('contextmenu', noMenu);
  };
}

// ───────────────────────────── Inputs ─────────────────────────────

export interface DriveInputDeps {
  shell: Pick<Shell, 'post' | 'recover' | 'onMediaAction'>;
  /** Current settings (valve / perspective to toggle from, source, wheel shifting, gamepad swap). */
  settings(): Settings;
  audio(): AudioStatus;
  /** Keyboard and media keys (window). */
  keyTarget: KeyTarget;
  /** Gamepad polling host (window); null for none. */
  gamepadHost: GamepadHost | null;
  log: Pick<InputLog, 'push'>;
  /** Monotonic ms for the media dedupe (performance.now). */
  now?: () => number;
}

export interface DriveInputs {
  /** A shift from `source` (the paddles call this). */
  shift(dir: ShiftDir, source: InputSource): void;
  detach(): void;
}

/** Input-log vocabulary (Diagnostics shows the log and exports it in the QR). */
const LOG = STR.diag.log;

function shiftWord(dir: ShiftDir): string {
  return dir > 0 ? LOG.shiftUp : LOG.shiftDown;
}

/** "<input>: <what it did>" when the input is named (a key), else what it did. */
function logLine(input: string | undefined, what: string): string {
  return input === undefined ? what : LOG.via(input, what);
}

/**
 * Wires the keyboard (E/Q/V/P any source, W/S/Space on the Keyboard source), the gamepad and the
 * steering-wheel tilt (Media Session next/previous and MediaTrack keys, through MediaShift: opt-in,
 * key + action within 900 ms count once) to the shell, logging every input. While audio is
 * interrupted, a media action (other than pause) or tilt key recovers audio instead — it grants
 * activation (spec §6.3). Play / pause never shift.
 */
export function attachDriveInputs(d: DriveInputDeps): DriveInputs {
  const now = d.now ?? ((): number => performance.now());
  const media = new MediaShift();

  const shift = (dir: ShiftDir, source: InputSource, detail = shiftWord(dir)): void => {
    d.log.push(source, detail);
    d.shell.post({ type: dir > 0 ? 'shiftUp' : 'shiftDown' });
  };
  /** `key`: the keyboard key that did it, logged in front of the action. */
  const cycleValve = (source: InputSource, key?: string): void => {
    const mode = nextValve(d.settings().valve);
    d.log.push(source, logLine(key, LOG.valves(mode)));
    d.shell.post({ type: 'valve', mode });
  };
  const togglePerspective = (source: InputSource, key?: string): void => {
    const value = d.settings().perspective === 'cabin' ? 'outside' : 'cabin';
    d.log.push(source, logLine(key, LOG.perspective(value)));
    d.shell.post({ type: 'perspective', value });
  };

  /** A tilt (action or key): recover while interrupted, else a shift when enabled and not a duplicate. */
  const tilt = (name: string, source: InputSource, handle: (nowMs: number) => 'up' | 'down' | null): void => {
    if (d.audio() === 'interrupted') {
      d.log.push(source, LOG.via(name, LOG.resume));
      void d.shell.recover();
      return;
    }
    media.enabled = d.settings().wheelShift.enabled;
    const dir = handle(now());
    if (dir !== null) shift(dir === 'up' ? 1 : -1, source, LOG.via(name, shiftWord(dir === 'up' ? 1 : -1)));
    else d.log.push(source, LOG.via(name, media.enabled ? LOG.duplicate : LOG.wheelOff));
  };

  const offKeys = attachKeyboard(d.keyTarget, {
    shift: (dir) => shift(dir, 'key', LOG.via(dir > 0 ? LOG.keys.up : LOG.keys.down, shiftWord(dir))),
    cycleValve: () => cycleValve('key', LOG.keys.valve),
    togglePerspective: () => togglePerspective('key', LOG.keys.perspective),
    pedal: (throttle, brake) => {
      d.log.push('key', LOG.pedal(throttle, brake));
      d.shell.post({ type: 'pedal', throttle, brake });
    },
    keyboardSource: () => d.settings().source === 'keyboard',
  });

  const onMediaKey = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const code = mediaKeyCode(e);
    if (e.repeat || !MEDIA_KEY.test(code)) return;
    if (TILT_KEYS.has(code)) tilt(code, 'key', (t) => media.handleKey(code, t));
    else d.log.push('key', code);
  };
  d.keyTarget.addEventListener('keydown', onMediaKey);

  const offMedia = d.shell.onMediaAction((action) => {
    if (action === 'nexttrack' || action === 'previoustrack') {
      tilt(action, 'media', (t) => media.handleAction(action, t));
    } else if (action === 'play' && d.audio() === 'interrupted') {
      d.log.push('media', LOG.via(action, LOG.resume));
      void d.shell.recover();
    } else {
      d.log.push('media', action);
    }
  });

  const offPad =
    d.gamepadHost === null
      ? (): void => {}
      : attachGamepad(
          d.gamepadHost,
          {
            shift: (dir) => shift(dir, 'gamepad'),
            cycleValve: () => cycleValve('gamepad'),
            togglePerspective: () => togglePerspective('gamepad'),
          },
          { swap: () => d.settings().gamepadSwap },
        );

  let attached = true;
  return {
    shift: (dir, source) => shift(dir, source),
    detach: () => {
      if (!attached) return;
      attached = false;
      offKeys();
      d.keyTarget.removeEventListener('keydown', onMediaKey);
      offMedia();
      offPad();
    },
  };
}

// ───────────────────────────── Screen ─────────────────────────────

/** The theme's custom properties for the canvas (theme.css values when unset). */
function themePalette(): TachPalette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  const p = DEFAULT_TACH_PALETTE;
  return {
    track: v('--bezel', p.track),
    dial: v('--dial', p.dial),
    dim: v('--dim', p.dim),
    sweep: v('--amber', p.sweep),
    redline: v('--redline', p.redline),
    shift: v('--shift', p.shift),
    lampOff: v('--face-raised', p.lampOff),
  };
}

/**
 * Restarts the gear readout's one-shot flash. Both flash classes go first: left in place, the
 * `refused` rule (later in theme.css) would keep winning the cascade and a shift flash after a refused
 * downshift would never play.
 */
export function flashGear(el: HTMLElement, cls: 'shifting' | 'refused'): void {
  el.classList.remove('shifting', 'refused');
  void el.offsetWidth; // reflow, so re-adding the class restarts the animation
  el.classList.add(cls);
}

/** Paddles keep focus where it was: a press must not leave a focus ring on them (E / Q are the keyboard path). */
function keepFocus(e: MouseEvent): void {
  e.preventDefault();
}

function live(): boolean {
  return store.audio.peek().state === 'running';
}

export interface StartOverlayProps {
  engine: Pick<EngineDef, 'name' | 'inspiredBy'>;
  source: Settings['source'];
  audio: AudioStatus;
  parked: boolean;
  /** The location-blocked banner, in the overlay's flow; null for none. */
  banner: VNode | null;
  onStart(): void;
  onGarage(): void;
  onSettings(): void;
  onDiagnostics(): void;
}

/**
 * Start engine, over Drive while audio is off, starting or failed. It covers the status dot and the
 * Settings button, so it offers both ways out itself: Settings (parked only), where an output route the
 * car cannot use — every start fails — is changed back, and Diagnostics (spec §6.5, §10.2 item 6).
 */
export function StartOverlay(p: StartOverlayProps): VNode {
  const starting = p.audio === 'starting';
  return (
    <div class="overlay" role="dialog" aria-label={STR.actions.startEngine}>
      {p.banner}
      <h1>{p.engine.name}</h1>
      <p class="muted">
        {STR.inspiredBy(p.engine.inspiredBy)} · {STR.modes.source[p.source]}
      </p>
      <button type="button" class="btn-primary drive-start" disabled={starting} onClick={p.onStart}>
        {starting ? STR.drive.starting : STR.actions.startEngine}
      </button>
      <div class="row drive-start-more">
        <button type="button" class="btn-quiet" onClick={p.onGarage}>
          {STR.drive.garage}
        </button>
        <button type="button" class="btn-quiet" disabled={!p.parked} onClick={p.onSettings}>
          {STR.actions.settings}
        </button>
        <button type="button" class="btn-quiet" onClick={p.onDiagnostics}>
          {STR.actions.diagnostics}
        </button>
      </div>
    </div>
  );
}

export function DriveScreen({ shell }: ScreenProps): VNode {
  const s = store.settings.value;
  const parked = store.parked.value;
  const engine = store.engine.value;
  const audioState = useComputed(() => store.audio.value.state).value;
  const gpsStatus = useComputed(() => store.gps.value.status).value;
  const statusKey = useComputed(() => {
    const st = driveStatus({
      audio: store.audio.value.state,
      source: store.settings.value.source,
      gps: store.gps.value.status,
      flags: store.audio.value.state === 'running' ? (store.snapshot.value[S.flags] ?? 0) : 0,
      liteNextStart: store.settings.value.liteNextStart,
    });
    return `${st.level}|${st.reasons.join(',')}`;
  }).value;
  const [level = 'off', reasonList = ''] = statusKey.split('|') as [StatusLevel, string];

  const gearText = useComputed(() =>
    store.audio.value.state === 'running' ? gearLabel(store.snapshot.value[S.gear] ?? Number.NaN) : STR.drive.none,
  );
  const speedText = useComputed(() => {
    const v =
      store.audio.value.state === 'running'
        ? speedValue(store.snapshot.value[S.speedMps] ?? Number.NaN, store.settings.value.units)
        : null;
    return v === null ? STR.drive.none : String(v);
  });

  const [warning, setWarning] = useState(false);
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gear = useRef<HTMLDivElement>(null);
  const loadBar = useRef<HTMLDivElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const up = useRef<HTMLButtonElement>(null);
  const statusBtn = useRef<HTMLButtonElement>(null);
  const lastFlags = useRef(0);

  // Inputs, paddles and the status long-press, for as long as Drive is shown.
  useEffect(() => {
    const inputs = attachDriveInputs({
      shell,
      settings: () => store.settings.peek(),
      audio: () => store.audio.peek().state,
      keyTarget: window,
      gamepadHost: window,
      log: inputLog,
    });
    const offs: (() => void)[] = [inputs.detach];
    if (down.current) offs.push(bindPaddle(down.current, -1, (dir) => inputs.shift(dir, 'paddle')));
    if (up.current) offs.push(bindPaddle(up.current, 1, (dir) => inputs.shift(dir, 'paddle')));
    if (statusBtn.current) offs.push(bindLongPress(statusBtn.current, () => openDiagnostics('drive')));
    // Test hook (tests/e2e): effects run after paint, so an input sent as Drive appears could be lost;
    // the e2e specs wait for this before their first key, paddle or Media Session action.
    const section = root.current;
    section?.setAttribute('data-inputs', 'ready');
    return () => {
      section?.removeAttribute('data-inputs');
      for (const off of offs) off();
    };
  }, [shell]);

  // The tach polls the snapshot from its own frame loop (Intel: 1× backing store, ≤ 30 fps).
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return undefined;
    return mountTach(el, {
      mcu: detectedMcu(),
      rpm: () => (live() ? (store.snapshot.peek()[S.rpm] ?? 0) : 0),
      model: () => {
        const rpm = store.engine.peek().spec.rpm;
        return { redline: rpm.redline, limiterRpm: rpm.limiter.rpm };
      },
      palette: themePalette(),
      font: getComputedStyle(el).fontFamily,
      unitLabel: STR.drive.tachUnit,
    });
  }, []);

  // Load bar and gear flashes, written straight to the DOM at the snapshot rate.
  useSignalEffect(() => {
    const buf = store.snapshot.value;
    const running = store.audio.value.state === 'running';
    const bar = loadBar.current;
    if (bar !== null) {
      const l = running ? loadLevel(buf[S.load] ?? Number.NaN) : loadLevel(0);
      bar.style.setProperty('--load', l.fraction.toFixed(3));
      bar.classList.toggle('overrun', l.overrun);
    }
    const flags = running ? (buf[S.flags] ?? 0) : 0;
    const edge = flagEdges(lastFlags.current, flags);
    lastFlags.current = flags;
    const g = gear.current;
    if (g !== null && edge.refused) flashGear(g, 'refused');
    else if (g !== null && edge.shifting) flashGear(g, 'shifting');
  });

  const tapGearbox = (): void => {
    const next = gearboxTap({ current: s.gearboxMode, warningSeen: s.manualWarningSeen, parked });
    if (next === 'warn') setWarning(true);
    else if (next === 'locked') shell.toast(STR.parkedOnly);
    else shell.post({ type: 'gearboxMode', value: next });
  };
  const acceptManual = (): void => {
    setWarning(false);
    store.updateSettings({ manualWarningSeen: true, gearboxMode: 'manual' });
  };

  const reasons = reasonList === '' ? [] : (reasonList.split(',') as StatusReason[]);
  const statusLabel = [STR.drive.statusLevels[level], ...reasons.map((r) => STR.drive.reasons[r]), STR.drive.statusHold].join('. ');
  const gpsBlocked = s.source === 'gps' && (gpsStatus === 'denied' || gpsStatus === 'off');
  const engineOff = audioState === 'off' || audioState === 'error' || audioState === 'starting';
  // Location blocked (spec §6.5): in the Start overlay's flow while it is up, else fixed at the top.
  const gpsBanner = gpsBlocked ? (
    <div class={engineOff ? 'banner bad' : 'banner bad drive-alert'} role="alert">
      <p>{gpsStatus === 'denied' ? STR.geoDenied : STR.drive.gpsMissing}</p>
      <button type="button" class="btn-primary" onClick={() => store.updateSettings({ source: 'demo' })}>
        {STR.actions.useDemo}
      </button>
    </div>
  ) : null;

  return (
    <section class="drive" data-screen="drive" ref={root}>
      <div class="drive-side">
        <button type="button" class="drive-status" ref={statusBtn} aria-label={statusLabel} data-level={level}>
          <span class={level === 'off' ? 'status-dot' : `status-dot ${level}`} />
          <span class="drive-status-src">{STR.drive.sourceShort[s.source]}</span>
        </button>
        <button type="button" class="paddle paddle-down" ref={down} aria-label={STR.drive.shiftDown} onMouseDown={keepFocus}>
          {STR.drive.minus}
        </button>
      </div>

      <div class="cockpit">
        <div class="drive-bar">
          <button
            type="button"
            class="drive-toggle"
            aria-label={`${STR.drive.gearbox}: ${STR.modes.gearbox[s.gearboxMode]}`}
            data-value={s.gearboxMode}
            onClick={tapGearbox}
          >
            <small>{STR.drive.gearbox}</small>
            <span>{STR.modes.gearbox[s.gearboxMode]}</span>
          </button>
          <button
            type="button"
            class="drive-toggle"
            aria-label={`${STR.drive.driveMode}: ${STR.modes.drive[s.driveMode]}`}
            data-value={s.driveMode}
            onClick={() => shell.post({ type: 'driveMode', value: s.driveMode === 'comfort' ? 'sport' : 'comfort' })}
          >
            <small>{STR.drive.driveMode}</small>
            <span>{STR.modes.drive[s.driveMode]}</span>
          </button>
          <button
            type="button"
            class="drive-toggle"
            aria-label={`${STR.valvesLabel}: ${STR.modes.valve[s.valve]}`}
            data-value={s.valve}
            onClick={() => shell.post({ type: 'valve', mode: nextValve(s.valve) })}
          >
            <small>{STR.valvesLabel}</small>
            <span>{STR.modes.valve[s.valve]}</span>
          </button>
        </div>

        <div class="dial">
          <canvas class="tach" ref={canvas} aria-hidden="true" />
          <div class="readouts">
            <div class="gear" ref={gear} role="status" aria-label={STR.drive.gearLabel}>
              {gearText}
            </div>
            <div class="speed" aria-label={STR.drive.speedLabel}>
              {speedText}
              <small>{STR.units[s.units]}</small>
            </div>
          </div>
        </div>

        <div class="load-bar" ref={loadBar} role="presentation">
          <span />
        </div>
      </div>

      <div class="drive-side">
        <button
          type="button"
          class="drive-settings"
          data-testid="drive-settings"
          disabled={!parked}
          onClick={() => store.go('settings')}
        >
          {STR.actions.settings}
        </button>
        <button type="button" class="paddle paddle-up" ref={up} aria-label={STR.drive.shiftUp} onMouseDown={keepFocus}>
          {STR.drive.plus}
        </button>
      </div>

      {engineOff ? (
        <StartOverlay
          engine={engine}
          source={s.source}
          audio={audioState}
          parked={parked}
          banner={gpsBanner}
          onStart={() => void shell.startEngine()}
          onGarage={() => store.go('garage')}
          onSettings={() => store.go('settings')}
          onDiagnostics={() => openDiagnostics('drive')}
        />
      ) : null}

      {audioState === 'interrupted' ? (
        <button type="button" class="overlay drive-resume" onClick={() => void shell.recover()}>
          <strong>{STR.actions.tapToResume}</strong>
          <span class="muted">{STR.drive.resumeHint}</span>
        </button>
      ) : null}

      {engineOff ? null : gpsBanner}

      {warning ? (
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="manual-warning-title">
          <div class="panel">
            <h2 id="manual-warning-title">{STR.drive.manualTitle}</h2>
            <p>{STR.manualWarning}</p>
            {parked ? null : <p class="muted">{STR.parkedOnly}</p>}
            <div class="row">
              <button type="button" class="btn-primary" disabled={!parked} onClick={acceptManual}>
                {STR.drive.manualAccept}
              </button>
              <button type="button" onClick={() => setWarning(false)}>
                {STR.drive.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
