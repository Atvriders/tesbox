/**
 * App state (phase-3 contract T2): the @preact/signals store shared by the shell and the screens.
 *
 * Settings change only through `updateSettings` (validated, then persisted): `settings` is exported
 * read-only. The live signals — `snapshot`, `audio`, `gps`, `toast` — are written by the shell from
 * EngineAudio / GpsSource callbacks; the shell also forwards engine / Tesla / output / mode changes
 * to EngineAudio (T1).
 */
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import { S, STATE_LEN, type EngineDef, type OutputRoute, type TeslaParams, type TeslaRecord, type Tier } from '../contracts';
import { TESLAS } from '../data/catalogue';
import { getEngine } from '../data/engines';
import type { SwRegisterResult } from '../platform/sw-register';
import { loadSettings, needsFirstRun, sanitizeSettings, saveSettings, teslaParamsFor, type Settings } from './settings';

export type Screen = 'first-run' | 'garage' | 'drive' | 'settings' | 'diagnostics';

export type AudioStatus = 'off' | 'starting' | 'running' | 'interrupted' | 'error';
export interface AudioState {
  state: AudioStatus;
  route: OutputRoute;
  /** Chosen at Start (spec §5.7); null until audio has started once. */
  tier: Tier | null;
  message?: string;
}

export type GpsStatus = 'off' | 'waiting' | 'ok' | 'denied' | 'unavailable';
export interface GpsState {
  /** 'off' = geolocation absent or not running. */
  status: GpsStatus;
  /** Real-GPS estimate from GpsSource.parked(): last fix < 3 s old and speed < 5 km/h. */
  parked: boolean;
  fixAgeS: number | null;
}

const initial = loadSettings();

/** Written only by updateSettings. */
const settingsState = signal<Settings>(initial);

/** The current settings, read-only: change them with updateSettings (it validates and persists). */
export const settings: ReadonlySignal<Settings> = settingsState;

/** First load: first-run until a Tesla is chosen and the notices are seen, else the garage (no audio yet). */
export const screen = signal<Screen>(needsFirstRun(initial) ? 'first-run' : 'garage');

/** Latest worklet state snapshot (S.* indices); replaced (never mutated) at the ~30 Hz post rate. */
export const snapshot = signal<Float64Array>(emptySnapshot());

export const audio = signal<AudioState>({ state: 'off', route: initial.outputRoute, tier: null });

export const gps = signal<GpsState>({ status: 'off', parked: false, fixAgeS: null });

/** Transient message for the shell to show, or null. */
export const toast = signal<string | null>(null);

/** A newer build is available (phase-4 contract): a waiting service worker, or a stale page (`remote` = deployed SHA). */
export interface UpdateState {
  kind: 'sw' | 'stale';
  remote?: string;
}

/** Set by src/main.ts when a new service-worker version waits (and by the version check, T3); the update banner reads it. */
export const update = signal<UpdateState | null>(null);

/** Outcome of the app service-worker registration (src/main.ts), for Diagnostics; 'pending' until it has run. */
export const swStatus = signal<SwRegisterResult | 'pending'>('pending');

export const engine = computed<EngineDef>(() => getEngine(settings.value.engineId));

export const tesla = computed<TeslaRecord | null>(() => {
  const id = settings.value.teslaId;
  return id === null ? null : (TESLAS.find((r) => r.id === id) ?? null);
});

// The same object is returned while the resolved numbers are unchanged, so `teslaParams` does not
// notify on unrelated edits (volume, units, an ignored notListed, …) and the shell does not re-send
// the Tesla to the worklet — reconfiguring the cores — on every settings change.
let paramsMemo: TeslaParams | null = null;
let paramsMemoJson = 'null';

export const teslaParams = computed<TeslaParams | null>(() => {
  const next = teslaParamsFor(settings.value);
  const json = JSON.stringify(next);
  if (json !== paramsMemoJson) {
    paramsMemo = next;
    paramsMemoJson = json;
  }
  return paramsMemo;
});

/**
 * Contract (global rules): parked = geolocation available AND last accepted fix < 3 s old AND
 * real-GPS speed < 5 km/h, whatever the selected source — that estimate is `gps.parked`. Without
 * geolocation (status 'off': no API / not running; 'denied': no permission) parked = true. A
 * running GPS that is failing ('unavailable', e.g. a tunnel) keeps the estimate, so it stays locked.
 */
export const parked = computed<boolean>(() => {
  const g = gps.value;
  return g.status === 'off' || g.status === 'denied' || g.parked;
});

/**
 * Merges `patch`, validates the result field by field and persists it. An invalid or undefined patch
 * field keeps its current value — never the default: a volume step past the −24 dB floor stays at
 * −24 dB instead of jumping to 0 dB (spec §13). null still clears a nullable field, and a mode the
 * selected Tesla lacks becomes null (quickest). Subscribers are notified only when something
 * changed. Returns false when the settings could not be persisted (they still apply in memory).
 */
export function updateSettings(patch: Partial<Settings>): boolean {
  const current = settingsState.peek();
  const next = sanitizeSettings({ ...current, ...patch }, current);
  if (JSON.stringify(next) !== JSON.stringify(current)) settingsState.value = next;
  return saveSettings(next);
}

export function go(next: Screen): void {
  screen.value = next;
}

function emptySnapshot(): Float64Array {
  const buf = new Float64Array(STATE_LEN);
  buf[S.busyFrac] = NaN; // unknown until the worklet reports
  return buf;
}
