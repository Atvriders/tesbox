/**
 * The Sound Lab page state (phase-2c contract L3), held in signals and run in Node by the unit tests against a
 * fake of the audio port (src/lab/ui/lab-audio.ts is the real one).
 *
 * - Voicing: edits change the draft at once and apply debounced (APPLY_DEBOUNCE_MS ≤ 150 ms). A voicing that
 *   fails the in-page check (schema, then assertEngineFits at the context's rate) is flagged with its field and
 *   not sent; one equal to the last sent is not sent again. "Reset to engine" = the shipped JSON, "Reset to
 *   default voicing" = defaultVoicing(spec). A refusal relayed by the worklet is flagged the same way.
 * - Engine, tier, sub preset (DEFAULT_OUTPUT or subwoofer 'yes') and monitor level are posted as they change.
 * - Drive: the page keeps a LabControl mirror — the worklet's own transitions — so its rpm / gear follow a
 *   shift at once and the next manual control never undoes it. Lift-off also drops the page's load to 0, so
 *   the throttle stays closed (through ↑/↓ as well) until the user raises it. Events and segments need running
 *   audio; an event the mirror finds to be a no-op (top gear, 1st, segment playing) is not posted.
 * - A/B: the clip is decoded in the page (the file never leaves the browser) and loops on the B side; A/B
 *   crossfades in 30 ms. Match level: reference by its whole-clip RMS, lab by the meter's RMS over the last
 *   second (src/lab/ui/level.ts). The monitor level applies to both sides.
 * - Export / Import: src/lab/ui/voicing-io.ts; an import is validated completely before it is applied.
 */
import { batch, computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { DEFAULT_OUTPUT, type DriveMode, type EngineDef, type EngineVoicing, type OutputConfig, type Perspective, type Tier, type ValveMode } from '../../contracts';
import { ENGINES } from '../../data/engines';
import { defaultVoicing } from '../../data/voicing-defaults';
import { SEGMENTS } from '../../../tools/segments';
import type { KeyCommand } from './keys';
import { LabControl } from './lab-control';
import { ampToDb, matchLevels, powerMeanDb, type LevelMatch } from './level';
import {
  MONITOR_DEFAULT_DB,
  MONITOR_MAX_DB,
  MONITOR_MIN_DB,
  type LabEvent,
  type LabToMain,
  type MainToLab,
  type ManualControl,
  type MeterMsg,
} from './protocol';
import { setIn, type Path } from './voicing-fields';
import { coreProblem, exportVoicing, importVoicing, voicingProblems, type ExportResult, type Problem } from './voicing-io';

export type AudioRun = 'off' | 'starting' | 'running' | 'suspended' | 'error';
export type AbSide = 'A' | 'B';
export type SubPreset = 'no-sub' | 'sub';
/** applied: the draft is what the worklet plays; pending: waiting for the debounce; flagged: not sent. */
export type ApplyState = 'applied' | 'pending' | 'flagged';

/** The app's output stage presets: DEFAULT_OUTPUT (bass-managed, as without a sub) or a subwoofer. */
export const SUB_PRESETS: Readonly<Record<SubPreset, OutputConfig>> = {
  'no-sub': DEFAULT_OUTPUT,
  sub: { ...DEFAULT_OUTPUT, subwoofer: 'yes' },
};

export const APPLY_DEBOUNCE_MS = 120;
/** A/B crossfade (contract: 30 ms). */
export const CROSSFADE_S = 0.03;
/** Meter readings averaged for Match level: about the last second at ~20 Hz. */
export const MATCH_READINGS = 20;
/** Sample rate of the in-page check before the AudioContext exists (Chromium's usual desktop rate). */
export const DEFAULT_FS = 48000;
export const DEFAULT_SEGMENT = 'wotPull';

export const SEGMENT_LIST: readonly { name: string; durationS: number }[] = SEGMENTS.map((s) => ({ name: s.name, durationS: s.durationS }));

export interface DriveState {
  manual: ManualControl;
  liftoff: boolean;
  limiterHold: boolean;
  ignitionOn: boolean;
  segment: string | null;
}

export interface RefInfo {
  name: string;
  durationS: number;
  sampleRate: number;
  channels: number;
  /** Whole-clip RMS. */
  rmsDb: number;
}

/** What the audio port reports about a decoded clip (rms linear, every channel). */
export interface RefDecoded {
  durationS: number;
  sampleRate: number;
  channels: number;
  rms: number;
}

/** Linear gains of the A/B graph: the reference match gain, the lab match gain and the monitor level (reference side). */
export interface LabLevels {
  refGain: number;
  labGain: number;
  monitorGain: number;
}

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export interface LabAudioEvents {
  onMessage(msg: LabToMain): void;
  onState(state: AudioRun, message?: string): void;
}

/** The page's audio graph (src/lab/ui/lab-audio.ts). */
export interface LabAudioPort {
  /** The AudioContext's rate once it exists, else null. */
  readonly sampleRate: number | null;
  /**
   * Must be called from a user gesture: creates the AudioContext synchronously (or resumes a suspended one),
   * loads the lab worklet, posts `initial()` first — read when the node exists — and connects A and B.
   */
  start(initial: () => readonly MainToLab[], events: LabAudioEvents): Promise<void>;
  /** To the worklet; dropped while no node exists (Start sends the current state). */
  post(msg: MainToLab): void;
  /** Decodes a local file in the page and loops it on the B side. */
  loadReference(bytes: ArrayBuffer): Promise<RefDecoded>;
  setAb(side: AbSide, fadeS: number): void;
  setLevels(levels: LabLevels): void;
}

export interface LabDeps {
  audio: LabAudioPort;
  /** Offers `text` as a download named `fileName`. */
  saveFile(fileName: string, text: string): void;
  copyText(text: string): Promise<void>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function keyOf(def: EngineDef): string {
  return `${def.id}\n${JSON.stringify(def.voicing)}`;
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function problemText(problems: readonly Problem[]): string {
  return problems.map((p) => p.message).join('; ');
}

function signedDb(db: number): string {
  return `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;
}

export class LabModel {
  readonly engineId: Signal<string>;
  readonly engine: ReadonlySignal<EngineDef>;
  readonly draft: Signal<EngineVoicing>;
  readonly problems = signal<Problem[]>([]);
  readonly applyState = signal<ApplyState>('applied');
  readonly tier = signal<Tier>('full');
  readonly sub = signal<SubPreset>('no-sub');
  readonly monitorDb = signal(MONITOR_DEFAULT_DB);
  readonly drive: Signal<DriveState>;
  readonly segmentChoice = signal(DEFAULT_SEGMENT);
  readonly audioState = signal<AudioRun>('off');
  readonly audioMessage = signal<string | null>(null);
  /** The worklet posted 'ready'. */
  readonly ready = signal(false);
  readonly sampleRate = signal<number | null>(null);
  readonly meter = signal<MeterMsg | null>(null);
  readonly workletError = signal<string | null>(null);
  readonly ref = signal<RefInfo | null>(null);
  readonly refLoading = signal(false);
  readonly ab = signal<AbSide>('A');
  readonly match = signal<LevelMatch | null>(null);
  readonly notice = signal<Notice | null>(null);
  /** Key of the voicing number input being typed in: the view leaves its text alone meanwhile. */
  readonly editing = signal<string | null>(null);
  /** Audio runs and the worklet is ready: events, segments and Match level work. */
  readonly canDrive: ReadonlySignal<boolean>;
  readonly canCompare: ReadonlySignal<boolean>;
  readonly exportPreview: ReadonlySignal<ExportResult>;

  private control = new LabControl();
  /** The last definition that passed the in-page check: what Start sends. */
  private applied: EngineDef;
  private appliedKey: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readings: number[] = [];

  constructor(
    private readonly deps: LabDeps,
    engineId: string = ENGINES[0]?.id ?? '',
  ) {
    const engine = ENGINES.find((e) => e.id === engineId) ?? ENGINES[0];
    if (engine === undefined) throw new Error('no engines');
    this.engineId = signal(engine.id);
    this.engine = computed(() => ENGINES.find((e) => e.id === this.engineId.value) ?? engine);
    this.draft = signal(structuredClone(engine.voicing));
    this.control.configure(engine.spec);
    this.drive = signal(this.driveSnapshot());
    this.applied = engine;
    this.appliedKey = keyOf(engine);
    this.canDrive = computed(() => this.audioState.value === 'running' && this.ready.value);
    this.canCompare = computed(() => this.ref.value !== null);
    this.exportPreview = computed(() => exportVoicing(this.engineId.value, this.draft.value));
  }

  // ── audio ──

  /** From the Start audio tap: builds the audio graph, or resumes a suspended context. */
  start(): Promise<void> {
    const st = this.audioState.peek();
    if (st === 'starting' || st === 'running') return Promise.resolve();
    if (st !== 'suspended') {
      this.resetMirror();
      this.readings = [];
      batch(() => {
        this.ready.value = false;
        this.meter.value = null;
        this.workletError.value = null;
      });
    }
    batch(() => {
      this.audioState.value = 'starting';
      this.audioMessage.value = null;
    });
    const events: LabAudioEvents = {
      onMessage: (m) => this.onMessage(m),
      onState: (s, message) => this.onAudioState(s, message),
    };
    let started: Promise<void>;
    try {
      started = this.deps.audio.start(() => this.initialMessages(), events);
    } catch (e) {
      this.onAudioState('error', errText(e));
      return Promise.resolve();
    }
    return started.then(
      () => {
        this.sampleRate.value = this.deps.audio.sampleRate;
      },
      (e: unknown) => this.onAudioState('error', errText(e)),
    );
  }

  private initialMessages(): MainToLab[] {
    return [
      { type: 'engine', def: this.applied },
      { type: 'tier', value: this.tier.peek() },
      { type: 'output', config: SUB_PRESETS[this.sub.peek()] },
      { type: 'gain', db: this.monitorDb.peek() },
      { type: 'manual', ...this.control.manual },
    ];
  }

  private onAudioState(state: AudioRun, message?: string): void {
    batch(() => {
      this.audioState.value = state;
      this.audioMessage.value = message ?? null;
      this.sampleRate.value = this.deps.audio.sampleRate;
      if (state === 'error') this.ready.value = false;
    });
    if (state === 'error') this.resetMirror();
  }

  private onMessage(m: LabToMain): void {
    if (m.type === 'ready') {
      this.ready.value = true;
    } else if (m.type === 'meter') {
      this.meter.value = m;
      this.readings.push(m.rmsDb);
      if (this.readings.length > MATCH_READINGS) this.readings.shift();
    } else if (m.type === 'error') {
      if (m.message.startsWith('engine: ')) {
        // The worklet kept its previous engine: flag the draft, and send the next valid one even if equal.
        this.appliedKey = '';
        batch(() => {
          this.problems.value = [coreProblem(m.message.slice('engine: '.length))];
          this.applyState.value = 'flagged';
        });
      } else {
        this.workletError.value = m.message;
      }
    }
  }

  /** A fresh worklet starts with no lift-off, no limiter hold, ignition on and no segment. */
  private resetMirror(): void {
    const manual = { ...this.control.manual };
    this.control = new LabControl();
    this.control.configure(this.engine.peek().spec);
    this.control.setManual(manual);
    this.syncDrive();
  }

  private fs(): number {
    return this.deps.audio.sampleRate ?? DEFAULT_FS;
  }

  // ── engine, voicing ──

  selectEngine(id: string): void {
    if (id === this.engineId.peek()) return;
    const engine = ENGINES.find((e) => e.id === id);
    if (engine === undefined) return;
    this.cancelApply();
    this.control.configure(engine.spec);
    batch(() => {
      this.engineId.value = engine.id;
      this.draft.value = structuredClone(engine.voicing);
      this.problems.value = [];
      this.applyState.value = 'applied';
      this.syncDrive();
    });
    this.applied = engine;
    this.appliedKey = keyOf(engine);
    this.deps.audio.post({ type: 'engine', def: engine });
  }

  editField(path: Path, value: number | boolean | string): void {
    this.draft.value = setIn(this.draft.peek(), path, value);
    this.scheduleApply();
  }

  resetToEngine(): void {
    this.draft.value = structuredClone(this.engine.peek().voicing);
    this.scheduleApply();
  }

  resetToDefault(): void {
    this.draft.value = defaultVoicing(this.engine.peek().spec);
    this.scheduleApply();
  }

  private scheduleApply(): void {
    this.cancelApply();
    this.applyState.value = 'pending';
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.applyNow();
    }, APPLY_DEBOUNCE_MS);
  }

  private cancelApply(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private applyNow(): void {
    this.cancelApply();
    const def: EngineDef = { ...this.engine.peek(), voicing: this.draft.peek() };
    const problems = voicingProblems(def, this.fs());
    batch(() => {
      this.problems.value = problems;
      this.applyState.value = problems.length > 0 ? 'flagged' : 'applied';
    });
    if (problems.length > 0) return;
    const key = keyOf(def);
    if (key === this.appliedKey) return;
    this.applied = def;
    this.appliedKey = key;
    this.deps.audio.post({ type: 'engine', def });
  }

  setTier(value: Tier): void {
    this.tier.value = value;
    this.deps.audio.post({ type: 'tier', value });
  }

  setSub(preset: SubPreset): void {
    this.sub.value = preset;
    this.deps.audio.post({ type: 'output', config: SUB_PRESETS[preset] });
  }

  setMonitor(db: number): void {
    if (!Number.isFinite(db)) return;
    const v = Math.min(MONITOR_MAX_DB, Math.max(MONITOR_MIN_DB, db));
    this.monitorDb.value = v;
    this.deps.audio.post({ type: 'gain', db: v });
    this.applyLevels();
  }

  // ── drive ──

  setRpm(rpm: number): void {
    this.updateManual({ rpm });
  }

  setLoad(load: number): void {
    this.updateManual({ load });
  }

  setGear(gear: number): void {
    this.updateManual({ gear });
  }

  setValve(valve: ValveMode): void {
    this.updateManual({ valve });
  }

  setDriveMode(driveMode: DriveMode): void {
    this.updateManual({ driveMode });
  }

  setWarm(warm: boolean): void {
    this.updateManual({ warm });
  }

  setPerspective(perspective: Perspective): void {
    this.updateManual({ perspective });
  }

  private updateManual(patch: Partial<ManualControl>): void {
    this.control.setManual({ ...this.control.manual, ...patch });
    this.syncDrive();
    this.deps.audio.post({ type: 'manual', ...this.control.manual });
  }

  fire(ev: LabEvent): void {
    if (!this.canDrive.peek()) return;
    if (!this.control.event(ev, 0)) return;
    // The page's pedal follows a lift-off: load 0 stays (through ↑/↓ too) until the user raises it.
    if (ev === 'liftoff') this.control.manual.load = 0;
    this.syncDrive();
    this.deps.audio.post({ type: 'event', ev });
  }

  playSegment(): void {
    if (!this.canDrive.peek()) return;
    const name = this.segmentChoice.peek();
    try {
      this.control.setSegment(name, 0);
    } catch {
      return;
    }
    this.syncDrive();
    this.deps.audio.post({ type: 'segment', name });
  }

  stopSegment(): void {
    if (this.control.segmentName === null) return;
    this.control.setSegment(null, 0);
    this.syncDrive();
    this.deps.audio.post({ type: 'segment', name: null });
  }

  /** A keyboard shortcut (src/lab/ui/keys.ts); `repeat` = auto-repeat of a held key. */
  key(cmd: KeyCommand, repeat: boolean): void {
    switch (cmd.kind) {
      case 'rpm':
        this.setRpm(this.control.manual.rpm + cmd.delta);
        return;
      case 'load':
        this.setLoad(Math.round((this.control.manual.load + cmd.delta) * 1000) / 1000);
        return;
      case 'event':
        if (!repeat) this.fire(cmd.ev);
        return;
      case 'ab':
        if (!repeat) this.toggleAb();
        return;
    }
  }

  private driveSnapshot(): DriveState {
    const c = this.control;
    return { manual: { ...c.manual }, liftoff: c.liftoff, limiterHold: c.limiterHold, ignitionOn: c.ignitionOn, segment: c.segmentName };
  }

  private syncDrive(): void {
    this.drive.value = this.driveSnapshot();
  }

  // ── A/B ──

  async loadReference(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
    this.refLoading.value = true;
    try {
      const d = await this.deps.audio.loadReference(await file.arrayBuffer());
      batch(() => {
        this.ref.value = { name: file.name, durationS: d.durationS, sampleRate: d.sampleRate, channels: d.channels, rmsDb: ampToDb(d.rms) };
        this.match.value = null;
        this.notice.value = { kind: 'info', text: `Loaded ${file.name}. It loops on side B; nothing is uploaded.` };
      });
      this.applyLevels();
    } catch (e) {
      this.notice.value = { kind: 'error', text: `Could not decode ${file.name}: ${errText(e)}` };
    } finally {
      this.refLoading.value = false;
    }
  }

  toggleAb(): void {
    if (this.ref.peek() === null) return;
    const side: AbSide = this.ab.peek() === 'A' ? 'B' : 'A';
    this.ab.value = side;
    this.deps.audio.setAb(side, CROSSFADE_S);
  }

  matchLevel(): void {
    const ref = this.ref.peek();
    if (ref === null) return;
    const m = matchLevels(ref.rmsDb, powerMeanDb(this.readings));
    if (m === null) {
      this.notice.value = { kind: 'error', text: 'Nothing to match yet: start the audio and let the engine run for a second.' };
      return;
    }
    this.match.value = m;
    this.applyLevels();
    this.notice.value = { kind: 'info', text: `Levels matched: reference ${signedDb(m.refGainDb)}, lab ${signedDb(m.labGainDb)}.` };
  }

  private applyLevels(): void {
    const m = this.match.peek();
    this.deps.audio.setLevels({
      refGain: dbToGain(m?.refGainDb ?? 0),
      labGain: dbToGain(m?.labGainDb ?? 0),
      monitorGain: dbToGain(this.monitorDb.peek()),
    });
  }

  // ── export / import ──

  exportFile(): void {
    const r = exportVoicing(this.engineId.peek(), this.draft.peek());
    if (!r.ok) {
      this.notice.value = { kind: 'error', text: `Export refused: ${problemText(r.problems)}` };
      return;
    }
    this.deps.saveFile(r.fileName, r.text);
    this.notice.value = { kind: 'info', text: `Exported ${r.fileName}.` };
  }

  async copyExport(): Promise<void> {
    const r = exportVoicing(this.engineId.peek(), this.draft.peek());
    if (!r.ok) {
      this.notice.value = { kind: 'error', text: `Export refused: ${problemText(r.problems)}` };
      return;
    }
    try {
      await this.deps.copyText(r.text);
      this.notice.value = { kind: 'info', text: 'Copied the voicing JSON.' };
    } catch (e) {
      this.notice.value = { kind: 'error', text: `Copy failed (${errText(e)}). Select the JSON below and copy it.` };
    }
  }

  async importFile(file: { name: string; text(): Promise<string> }): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      this.notice.value = { kind: 'error', text: `Could not read ${file.name}: ${errText(e)}` };
      return;
    }
    this.importText(text, file.name);
  }

  /** Validates `text` completely; applies it (switching engine when it names another) only when it passes. */
  importText(text: string, name: string): boolean {
    const r = importVoicing(text, ENGINES, this.fs());
    if (!r.ok) {
      this.notice.value = { kind: 'error', text: `Import refused (${name}): ${problemText(r.problems)}` };
      return false;
    }
    this.selectEngine(r.engine.id);
    this.draft.value = structuredClone(r.voicing);
    this.applyNow();
    this.notice.value = { kind: 'info', text: `Imported ${name} for ${r.engine.name}.` };
    return true;
  }
}
