/**
 * Settings (phase-3 contract T8; spec §7.2, §9.3, §10.2 item 5, §13): volume trim, listening position,
 * speed units, acceleration mode, Tesla / subwoofer / bass sweep (re-runs the picker), speed source,
 * quality, the steering-wheel shifting test, gamepad swap and Advanced (GPS method, high accuracy,
 * output route, GPS latency, reset all). The whole screen is read-only unless parked: every setting
 * sits in one `<fieldset disabled>`, and the header's Stop engine is locked with it.
 */
import { useComputed } from '@preact/signals';
import type { Ref, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { MainToWorklet, OutputRoute, TeslaRecord } from '../contracts';
import {
  DEFAULT_SETTINGS,
  GPS_LATENCY_RANGE_S,
  VOLUME_TRIM_RANGE_DB,
  type Settings,
  type TierPref,
} from '../app/settings';
import * as store from '../app/store';
import type { AudioStatus } from '../app/store';
import type { MediaAction } from '../audio/engine-audio';
import type { KeyTarget } from '../input/keyboard';
import { TILT_KEYS, WheelTest, mediaKeyCode, type WheelTestState } from '../input/media-shift';
import type { ScreenProps, Shell } from './app';
import { inputLog, openDiagnostics, type InputLog } from './diagnostics';
import { bindLongPress } from './drive';
import { carSummary } from './picker';
import { STR } from './strings';

// ───────────────────────────── Steppers ─────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Volume trim −/+ : whole dB inside VOLUME_TRIM_RANGE_DB. */
export function stepTrim(current: number, delta: number): number {
  return clamp(Math.round(current + delta), VOLUME_TRIM_RANGE_DB.min, VOLUME_TRIM_RANGE_DB.max);
}

/** GPS latency −/+ : 0.1 s steps inside GPS_LATENCY_RANGE_S, rounded so 0.7 + 0.1 is 0.8. */
export function stepLatency(current: number, delta: number): number {
  return clamp(Math.round((current + delta) * 10) / 10, GPS_LATENCY_RANGE_S.min, GPS_LATENCY_RANGE_S.max);
}

// ───────────────────────────── Results and summaries ─────────────────────────────

/**
 * Reset all: every preference back to its default (so first run follows). The warm-start time and
 * "Lite next start" describe the engine, not a preference, and are kept.
 */
export function resetPatch(current: Settings): Settings {
  return {
    ...DEFAULT_SETTINGS,
    wheelShift: { ...DEFAULT_SETTINGS.wheelShift },
    engineWarmAt: current.engineWarmAt,
    liteNextStart: current.liteNextStart,
  };
}

/** The stored wheel-test result (spec §7.2): a pass also enables wheel shifting. */
export function wheelTestPatch(works: boolean): Pick<Settings, 'wheelShift'> {
  return { wheelShift: { tested: true, works, enabled: works } };
}

/**
 * Quality picked in Settings: a forced tier is applied to the running engine at once (behind the
 * DSP's fade, spec §5.7); Auto is decided at the next start. Nothing is sent with the engine off.
 */
export function tierMessage(pref: TierPref, audio: AudioStatus): MainToWorklet | null {
  if (pref === 'auto' || audio === 'off' || audio === 'error') return null;
  return { type: 'tier', value: pref };
}

/** Acceleration-mode choices of the selected record; null (quickest) shows as its last mode. */
export function accelChoice(record: TeslaRecord | null, accelMode: string | null): { options: string[]; selected: string | null } {
  if (record === null) return { options: [], selected: null };
  const options = record.accelModes.map((m) => m.name);
  const selected = accelMode !== null && options.includes(accelMode) ? accelMode : (options[options.length - 1] ?? null);
  return { options, selected };
}

export function bassSummary(s: Settings): string {
  return s.subwoofer === 'yes' ? STR.settingsUi.bassFull : STR.settingsUi.bassValue(s.hpCornerHz);
}

// ───────────────────────────── Steering-wheel test ─────────────────────────────

export interface WheelTestDeps {
  onMediaAction(listener: (action: MediaAction) => void): () => void;
  /** MediaTrack keys (window). */
  keyTarget: KeyTarget;
  /** Monotonic ms. */
  now(): number;
  /** State and whole seconds left in the current step, after every change and on each tick. */
  onUpdate(state: WheelTestState, remainingS: number): void;
  /** Once, when both tilts arrived (true) or a step ran out (false). */
  onDone(works: boolean): void;
  log?: Pick<InputLog, 'push'>;
}

/** Countdown / timeout check period. */
const WHEEL_TICK_MS = 250;

/**
 * Runs the WheelTest state machine (src/input/media-shift.ts) against the Media Session actions and
 * MediaTrack keys: "Tilt the LEFT scroll wheel to the RIGHT now", then to the left, 10 s each.
 * Returns the cancel function (no result is reported after it).
 */
export function runWheelTest(d: WheelTestDeps): () => void {
  const test = new WheelTest();
  let finished = false;

  const report = (): void => {
    if (finished) return;
    const t = d.now();
    d.onUpdate(test.state, Math.ceil(test.remainingS(t)));
    if (test.state === 'done') {
      cleanup();
      d.onDone(test.works === true);
    }
  };

  const logged = (input: string): string => STR.diag.log.via(input, STR.diag.log.wheelTest);
  const offMedia = d.onMediaAction((action) => {
    d.log?.push('media', logged(action));
    test.onAction(action, d.now());
    report();
  });
  const onKey = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const code = mediaKeyCode(e);
    if (e.repeat || !TILT_KEYS.has(code)) return;
    d.log?.push('key', logged(code));
    test.onKey(code, d.now());
    report();
  };
  d.keyTarget.addEventListener('keydown', onKey);
  const timer = setInterval(() => {
    test.tick(d.now());
    report();
  }, WHEEL_TICK_MS);

  function cleanup(): void {
    finished = true;
    clearInterval(timer);
    offMedia();
    d.keyTarget.removeEventListener('keydown', onKey);
  }

  test.start(d.now());
  report();
  return () => {
    if (finished) return;
    cleanup();
    test.cancel();
  };
}

// ───────────────────────────── Screen ─────────────────────────────

interface SegOption<T extends string> {
  value: T;
  label: string;
}

/** A labelled segmented choice: one big button per option, the current one aria-pressed. */
function Seg<T extends string>(props: {
  label: string;
  value: T | null;
  options: readonly SegOption<T>[];
  onChange(value: T): void;
}): VNode {
  return (
    <div class="field">
      <span class="seg-label">{props.label}</span>
      <div class="seg" role="group" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            type="button"
            key={o.value}
            aria-pressed={o.value === props.value ? 'true' : 'false'}
            onClick={() => {
              if (o.value !== props.value) props.onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Options in `order`, labelled from `labels` (whose keys fix the option type). */
function options<T extends string>(labels: Readonly<Record<T, string>>, order: readonly NoInfer<T>[]): SegOption<T>[] {
  return order.map((value) => ({ value, label: labels[value] }));
}

const ON_OFF = options({ on: STR.settingsUi.on, off: STR.settingsUi.off }, ['off', 'on']);
const ROUTES: readonly OutputRoute[] = ['direct-anchor', 'direct', 'media-element'];

/** A value with −/+ step buttons (and an optional slider). */
function Stepper(props: {
  label: string;
  value: string;
  less: string;
  more: string;
  onLess(): void;
  onMore(): void;
  slider?: { min: number; max: number; step: number; value: number; onInput(v: number): void };
}): VNode {
  const sl = props.slider;
  return (
    <div class="field">
      <span class="seg-label">{props.label}</span>
      <div class="row">
        <button type="button" aria-label={props.less} onClick={props.onLess}>
          {STR.drive.minus}
        </button>
        {sl === undefined ? null : (
          <input
            type="range"
            class="settings-slider"
            min={sl.min}
            max={sl.max}
            step={sl.step}
            value={sl.value}
            aria-label={props.label}
            onInput={(e) => sl.onInput(Number(e.currentTarget.value))}
          />
        )}
        <button type="button" aria-label={props.more} onClick={props.onMore}>
          {STR.drive.plus}
        </button>
        <output class="settings-value">{props.value}</output>
      </div>
    </div>
  );
}

interface WheelRun {
  state: WheelTestState;
  left: number;
}

/** Settings → Test steering-wheel shifting (spec §7.2), then the opt-in switch once it works. */
function WheelPanel({ shell, ws, running }: { shell: Shell; ws: Settings['wheelShift']; running: boolean }): VNode {
  const [run, setRun] = useState<WheelRun | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);

  const start = (): void => {
    cancel.current?.();
    cancel.current = runWheelTest({
      onMediaAction: (l) => shell.onMediaAction(l),
      keyTarget: window,
      now: () => performance.now(),
      onUpdate: (state, left) => setRun({ state, left }),
      onDone: (works) => {
        cancel.current = null;
        setRun(null);
        store.updateSettings(wheelTestPatch(works));
      },
      log: inputLog,
    });
  };
  const stop = (): void => {
    cancel.current?.();
    cancel.current = null;
    setRun(null);
  };

  if (run !== null && run.state !== 'done') {
    return (
      <div class="field">
        <span class="seg-label">{STR.settingsUi.wheel}</span>
        <div class="banner" role="status" aria-live="polite">
          <p class="wheel-prompt">{run.state === 'waitRight' ? STR.settingsUi.wheelRight : STR.settingsUi.wheelLeft}</p>
          <p class="muted">{STR.settingsUi.wheelSecondsLeft(run.left)}</p>
          <button type="button" onClick={stop}>
            {STR.settingsUi.wheelStop}
          </button>
        </div>
      </div>
    );
  }
  const result = !ws.tested ? STR.settingsUi.wheelUntested : ws.works ? STR.settingsUi.wheelWorks : STR.settingsUi.wheelFailed;
  return (
    <div class="field">
      <span class="seg-label">{STR.settingsUi.wheel}</span>
      <p>{result}</p>
      <div class="row">
        <button type="button" disabled={!running} onClick={start}>
          {STR.settingsUi.wheelTest}
        </button>
      </div>
      {running ? null : <p class="muted">{STR.settingsUi.wheelNeedsAudio}</p>}
      {ws.works ? (
        <Seg
          label={STR.settingsUi.wheelEnable}
          value={ws.enabled ? 'on' : 'off'}
          options={ON_OFF}
          onChange={(v) => store.updateSettings({ wheelShift: { ...ws, enabled: v === 'on' } })}
        />
      ) : null}
    </div>
  );
}

function ResetAll({ onReset }: { onReset(): void }): VNode {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <div class="row">
        <button type="button" class="btn-danger" onClick={() => setConfirming(true)}>
          {STR.settingsUi.reset}
        </button>
      </div>
    );
  }
  return (
    <div class="banner bad" role="alert">
      <p>{STR.settingsUi.resetConfirm}</p>
      <button type="button" class="btn-danger" onClick={onReset}>
        {STR.settingsUi.resetYes}
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        {STR.settingsUi.cancel}
      </button>
    </div>
  );
}

export interface SettingsHeaderProps {
  /** Started and not stopped: Stop engine is offered. */
  engineOn: boolean;
  parked: boolean;
  /** The title; holding it opens Diagnostics (spec §10.2 item 6). */
  titleRef?: Ref<HTMLHeadingElement>;
  onStop(): void;
  onDiagnostics(): void;
  onDrive(): void;
}

/**
 * Title and actions. Stop engine changes state, so it is locked while moving like every setting below
 * it; Diagnostics and Drive only navigate and stay open.
 */
export function SettingsHeader(p: SettingsHeaderProps): VNode {
  return (
    <header class="screen-header">
      <h1 ref={p.titleRef}>{STR.screens.settings}</h1>
      {p.engineOn ? (
        <button type="button" class="btn-danger" disabled={!p.parked} onClick={p.onStop}>
          {STR.actions.stopEngine}
        </button>
      ) : null}
      <button type="button" onClick={p.onDiagnostics}>
        {STR.actions.diagnostics}
      </button>
      <button type="button" class="btn-primary" onClick={p.onDrive}>
        {STR.actions.drive}
      </button>
    </header>
  );
}

export function SettingsScreen({ shell }: ScreenProps): VNode {
  const s = store.settings.value;
  const parked = store.parked.value;
  const record = store.tesla.value;
  const engine = store.engine.value;
  const audioState = useComputed(() => store.audio.value.state).value;
  const audioTier = useComputed(() => store.audio.value.tier).value;
  const [advanced, setAdvanced] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);

  // Spec §10.2 item 6: holding the title opens Diagnostics, as the status dot does on Drive.
  useEffect(() => (title.current === null ? undefined : bindLongPress(title.current, () => openDiagnostics('settings'))), []);

  const set = (patch: Partial<Settings>): void => {
    store.updateSettings(patch);
  };
  const engineOn = audioState !== 'off' && audioState !== 'error';
  const accel = accelChoice(record, s.accelMode);

  const setQuality = (tierPref: TierPref): void => {
    set({ tierPref });
    const msg = tierMessage(tierPref, store.audio.peek().state);
    if (msg !== null) shell.post(msg);
  };
  const resetAll = (): void => {
    if (engineOn) void shell.stopEngine();
    set(resetPatch(store.settings.peek()));
    store.go('first-run');
  };

  return (
    <section class="screen" data-screen="settings">
      <SettingsHeader
        engineOn={engineOn}
        parked={parked}
        titleRef={title}
        onStop={() => void shell.stopEngine()}
        onDiagnostics={() => openDiagnostics('settings')}
        onDrive={() => store.go('drive')}
      />

      {parked ? null : (
        <p class="banner" role="status">
          {STR.readOnlyWhileMoving}
        </p>
      )}

      <fieldset class="settings-body" disabled={!parked}>
        <section class="panel group">
          <h2>{STR.settingsUi.sound}</h2>
          <Stepper
            label={STR.settingsUi.volume}
            value={STR.settingsUi.volumeValue(s.volumeTrimDb)}
            less={STR.settingsUi.quieter}
            more={STR.settingsUi.louder}
            onLess={() => set({ volumeTrimDb: stepTrim(s.volumeTrimDb, -1) })}
            onMore={() => set({ volumeTrimDb: stepTrim(s.volumeTrimDb, 1) })}
            slider={{
              min: VOLUME_TRIM_RANGE_DB.min,
              max: VOLUME_TRIM_RANGE_DB.max,
              step: 1,
              value: s.volumeTrimDb,
              onInput: (v) => set({ volumeTrimDb: stepTrim(v, 0) }),
            }}
          />
          <Seg
            label={STR.settingsUi.perspective}
            value={s.perspective}
            options={options(STR.modes.perspective, ['cabin', 'outside'])}
            onChange={(perspective) => set({ perspective })}
          />
          <Seg
            label={STR.settingsUi.quality}
            value={s.tierPref}
            options={options(STR.modes.tier, ['auto', 'full', 'lite'])}
            onChange={setQuality}
          />
          {audioTier === null || !engineOn ? null : (
            <p class="muted">{STR.settingsUi.qualityRunning(STR.modes.tier[audioTier])}</p>
          )}
          {s.liteNextStart ? <p class="muted">{STR.settingsUi.liteNext}</p> : null}
        </section>

        <section class="panel group">
          <h2>{STR.settingsUi.car}</h2>
          <dl class="kv">
            <dt>{STR.settingsUi.tesla}</dt>
            <dd>{carSummary(s) ?? STR.settingsUi.noTesla}</dd>
            <dt>{STR.settingsUi.subwoofer}</dt>
            <dd>{STR.modes.subwoofer[s.subwoofer]}</dd>
            <dt>{STR.settingsUi.bass}</dt>
            <dd>{bassSummary(s)}</dd>
          </dl>
          <div class="row">
            <button type="button" onClick={() => store.go('first-run')}>
              {STR.settingsUi.changeTesla}
            </button>
          </div>
          {accel.options.length > 0 ? (
            <Seg
              label={STR.settingsUi.accelMode}
              value={accel.selected}
              options={accel.options.map((name) => ({ value: name, label: name }))}
              onChange={(accelMode) => set({ accelMode })}
            />
          ) : (
            <p class="muted">{STR.settingsUi.accelNotListed}</p>
          )}
        </section>

        <section class="panel group">
          <h2>{STR.settingsUi.speed}</h2>
          <Seg
            label={STR.settingsUi.source}
            value={s.source}
            options={options(STR.modes.source, ['gps', 'demo', 'keyboard'])}
            onChange={(source) => set({ source })}
          />
          <Seg label={STR.settingsUi.units} value={s.units} options={options(STR.units, ['mph', 'kmh'])} onChange={(units) => set({ units })} />
        </section>

        <section class="panel group">
          <h2>{STR.settingsUi.engine}</h2>
          <p>
            {engine.name} <span class="muted">{STR.inspiredBy(engine.inspiredBy)}</span>
          </p>
          <div class="row">
            <button type="button" onClick={() => store.go('garage')}>
              {STR.drive.garage}
            </button>
          </div>
        </section>

        <section class="panel group">
          <h2>{STR.settingsUi.controls}</h2>
          <WheelPanel shell={shell} ws={s.wheelShift} running={audioState === 'running'} />
          <Seg
            label={STR.settingsUi.gamepadSwap}
            value={s.gamepadSwap ? 'on' : 'off'}
            options={ON_OFF}
            onChange={(v) => set({ gamepadSwap: v === 'on' })}
          />
          <p class="muted">{STR.settingsUi.gamepadHint}</p>
        </section>

        <section class="panel group">
          <h2>{STR.settingsUi.advanced}</h2>
          <div class="row">
            <button type="button" aria-expanded={advanced ? 'true' : 'false'} onClick={() => setAdvanced(!advanced)}>
              {advanced ? STR.settingsUi.hideAdvanced : STR.settingsUi.showAdvanced}
            </button>
          </div>
          {advanced ? (
            <>
              <Seg
                label={STR.settingsUi.gpsMethod}
                value={s.gpsMethod}
                options={options(STR.settingsUi.gpsMethods, ['poll', 'watch'])}
                onChange={(gpsMethod) => set({ gpsMethod })}
              />
              <Seg
                label={STR.settingsUi.highAccuracy}
                value={s.highAccuracy ? 'on' : 'off'}
                options={ON_OFF}
                onChange={(v) => set({ highAccuracy: v === 'on' })}
              />
              <Seg
                label={STR.settingsUi.outputRoute}
                value={s.outputRoute}
                options={options(STR.settingsUi.routes, ROUTES)}
                onChange={(outputRoute) => set({ outputRoute })}
              />
              <Stepper
                label={STR.settingsUi.gpsLatency}
                value={STR.settingsUi.latencyValue(s.gpsLatencyS)}
                less={STR.settingsUi.less}
                more={STR.settingsUi.more}
                onLess={() => set({ gpsLatencyS: stepLatency(s.gpsLatencyS, -0.1) })}
                onMore={() => set({ gpsLatencyS: stepLatency(s.gpsLatencyS, 0.1) })}
              />
              <ResetAll onReset={resetAll} />
            </>
          ) : null}
        </section>
      </fieldset>
    </section>
  );
}
