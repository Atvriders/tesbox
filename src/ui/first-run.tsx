/**
 * First run — "Which Tesla?" (phase-3 contract T7; spec §9.3, §10.2 item 2).
 *
 * - The five notices, until seen: one OK stores `settings.noticesSeen`.
 * - The picker: Model → generation (with years) → trim → MCU2 retrofit (MCU1-era only) → subwoofer
 *   yes / no / not sure (the trim's best guess pre-selected and labelled) → bass sweep (parked only) →
 *   acceleration mode (from `accelModes`). A step with a single option answers itself; Back retraces
 *   the steps that were shown. "Not listed" (parked only) takes the 0–100 km/h time, mass and body in
 *   place of model → trim, then asks the subwoofer question and offers the sweep (there are no modes).
 * - Every answer is stored as it is given. Another car resets the per-car answers to its own starting
 *   point (src/ui/picker.ts carChoicePatch). The end opens the garage. Opened again once a Tesla is
 *   chosen and the notices are seen — the Settings "re-run picker" — it starts at the model step with
 *   the current car marked and returns to Settings; Cancel first puts the car and its answers back as
 *   they were when the re-run opened (src/ui/picker.ts carAnswersOf), in one update.
 * - Bass sweep: Play tones starts the engine from the tap (shell.startEngine: the AudioContext is
 *   created inside the gesture), waits until the audio runs and the engine is out of its 2.5 s crank —
 *   EngineAudio's tier benchmark runs inside the crank, and a benchmark step that overloads underruns
 *   the output (src/ui/wait.ts engineReady) — then posts `testTone` 30/35/40/45/50/60 Hz at −18 dB for
 *   1.5 s each — the worklet plays the sine in place of the engine, through an output stage without the
 *   bass-management high-pass — and `hz: null` after the last step. The engine keeps running afterwards
 *   (as after a garage Preview). Once the tones have played, tapping a step stores it as `hpCornerHz`;
 *   Skip keeps the current corner (40 Hz on a first run). Moving off, losing the audio, Back and
 *   leaving the screen end the tone at once.
 *
 * FirstRunFlow holds the state and the actions (signals; runs in Node with fakes); FirstRunView renders
 * it without hooks; FirstRun is the routed screen that wires both to the store and the shell.
 */
import { batch, computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Subwoofer } from '../contracts';
import {
  NOT_LISTED_MASS_RANGE_KG,
  NOT_LISTED_ZERO_TO_100_RANGE_S,
  needsFirstRun,
  type NotListed,
  type Settings,
} from '../app/settings';
import * as store from '../app/store';
import type { AudioState, Screen } from '../app/store';
import type { ScreenProps, Shell } from './app';
import {
  BASS_SWEEP_HZ,
  BASS_SWEEP_LEVEL_DB,
  BASS_SWEEP_STEP_MS,
  carAnswersOf,
  carChoicePatch,
  carSummary,
  formatYears,
  generationsOf,
  isMcu1Era,
  parseNotListed,
  selectedAccelMode,
  subwooferGuess,
  teslaById,
  teslaModels,
  trimsOf,
  type CarAnswers,
  type CarChoice,
  type TeslaModel,
} from './picker';
import { STR } from './strings';
import { engineReady } from './wait';

export type FirstRunStep =
  | 'notices'
  | 'model'
  | 'generation'
  | 'trim'
  | 'retrofit'
  | 'mcu1'
  | 'notListed'
  | 'subwoofer'
  | 'bass'
  | 'accel';

export type SweepPhase = 'idle' | 'starting' | 'playing' | 'done' | 'failed';

export interface SweepState {
  phase: SweepPhase;
  /** Index into BASS_SWEEP_HZ of the step playing; null unless playing. */
  index: number | null;
  /** The tones have played on this visit of the step: the steps can be picked. */
  heard: boolean;
}

/** The "not listed" form as typed. */
export interface NotListedDraft {
  zeroTo100: string;
  mass: string;
  body: NotListed['body'];
  /** The last Continue was refused (outside the bounds); cleared by the next edit. */
  invalid: boolean;
}

/** What the flow uses: the store's signals and actions, and the shell. */
export interface FirstRunDeps {
  settings: ReadonlySignal<Settings>;
  parked: ReadonlySignal<boolean>;
  audio: ReadonlySignal<AudioState>;
  /** The worklet's state snapshots: the first tone waits until the engine is out of its crank. */
  snapshot: ReadonlySignal<Float64Array>;
  updateSettings(patch: Partial<Settings>): unknown;
  go(screen: Screen): void;
  shell: Pick<Shell, 'startEngine' | 'post'>;
}

const IDLE_SWEEP: SweepState = Object.freeze({ phase: 'idle', index: null, heard: false });
const SUBWOOFERS: readonly Subwoofer[] = ['yes', 'no', 'unsure'];
const BODIES: readonly NotListed['body'][] = ['sedan', 'suv', 'truck'];

export class FirstRunFlow {
  readonly step: Signal<FirstRunStep>;
  /** The model and generation being browsed (set by the picker steps, or by the chosen trim). */
  readonly model = signal<TeslaModel | null>(null);
  readonly generation = signal<string | null>(null);
  readonly sweep = signal<SweepState>(IDLE_SWEEP);
  readonly draft: Signal<NotListedDraft>;
  /** Opened with a Tesla chosen and the notices seen (Settings "re-run picker"): Cancel and the end return there. */
  readonly rerun: boolean;
  /** A re-run's car and answers as it opened: Cancel puts them back. Null on a first run. */
  private readonly original: CarAnswers | null;
  /** The steps shown before the current one (Back pops). */
  private readonly history = signal<readonly FirstRunStep[]>([]);
  readonly canGoBack: ReadonlySignal<boolean> = computed(() => this.history.value.length > 0);
  /** Bumped whenever the sweep stops: a step or start in flight for an older run does nothing. */
  private sweepRun = 0;
  private toneTimer: ReturnType<typeof setTimeout> | undefined;
  private toneOn = false;
  private readonly stopWatch: () => void;

  constructor(readonly deps: FirstRunDeps) {
    const s = deps.settings.peek();
    this.rerun = !needsFirstRun(s);
    this.original = this.rerun ? carAnswersOf(s) : null;
    this.step = signal<FirstRunStep>(s.noticesSeen ? 'model' : 'notices');
    const nl = s.notListed;
    this.draft = signal<NotListedDraft>({
      zeroTo100: nl === null ? '' : String(nl.zeroTo100S),
      mass: nl === null ? '' : String(nl.massKg),
      body: nl?.body ?? 'sedan',
      invalid: false,
    });
    // The tones play only while parked and while the audio runs.
    this.stopWatch = effect(() => {
      const parked = deps.parked.value;
      const running = deps.audio.value.state === 'running';
      if ((!parked || !running) && this.sweep.peek().phase === 'playing') this.failSweep();
    });
  }

  ackNotices(): void {
    if (this.step.peek() !== 'notices') return;
    this.deps.updateSettings({ noticesSeen: true });
    this.step.value = 'model'; // not a step Back returns to
  }

  chooseModel(model: TeslaModel): void {
    const gens = generationsOf(model);
    if (gens.length === 0) return;
    this.model.value = model;
    const [first] = gens;
    if (gens.length === 1 && first !== undefined) this.chooseGeneration(first.generation);
    else this.advance('generation');
  }

  chooseGeneration(generation: string): void {
    const model = this.model.peek();
    if (model === null) return;
    const trims = trimsOf(model, generation);
    if (trims.length === 0) return;
    this.generation.value = generation;
    const [first] = trims;
    if (trims.length === 1 && first !== undefined) this.chooseTrim(first.id);
    else this.advance('trim');
  }

  chooseTrim(id: string): void {
    const r = teslaById(id);
    if (r === null) return;
    batch(() => {
      this.model.value = r.model;
      this.generation.value = r.generation;
    });
    this.commitCar({ teslaId: r.id });
    this.advance(isMcu1Era(r) ? 'retrofit' : 'subwoofer');
  }

  answerRetrofit(hasMcu2: boolean): void {
    this.deps.updateSettings({ mcu2Retrofit: hasMcu2 });
    this.advance(hasMcu2 ? 'subwoofer' : 'mcu1');
  }

  /** An MCU1 car without the retrofit: finish the setup anyway (e.g. to use Tesbox on another device). */
  continueWithoutMcu2(): void {
    this.advance('subwoofer');
  }

  /** "Not listed": parked only (text entry, spec §9.1, §10.1). */
  chooseNotListed(): void {
    if (!this.deps.parked.peek()) return;
    this.advance('notListed');
  }

  editDraft(patch: Partial<Omit<NotListedDraft, 'invalid'>>): void {
    if (!this.deps.parked.peek()) return;
    this.draft.value = { ...this.draft.peek(), ...patch, invalid: false };
  }

  submitNotListed(): void {
    if (this.step.peek() !== 'notListed' || !this.deps.parked.peek()) return;
    const d = this.draft.peek();
    const notListed = parseNotListed(d.zeroTo100, d.mass, d.body);
    if (notListed === null) {
      this.draft.value = { ...d, invalid: true };
      return;
    }
    this.commitCar({ notListed });
    this.advance('subwoofer');
  }

  chooseSubwoofer(value: Subwoofer): void {
    this.deps.updateSettings({ subwoofer: value });
    this.advance('bass');
  }

  /** Play tones / Play again. Call it from the tap: it starts the engine (a user gesture) when needed. */
  playSweep(): void {
    const s = this.sweep.peek();
    if (this.step.peek() !== 'bass' || !this.deps.parked.peek() || s.phase === 'starting' || s.phase === 'playing') return;
    const run = ++this.sweepRun;
    this.sweep.value = { phase: 'starting', index: null, heard: s.heard };
    // The 'starting' phase lasts until the audio runs and the engine is out of its crank (the tier
    // benchmark inside the crank may underrun the output while a step is being judged).
    void engineReady(this.deps, () => this.deps.shell.startEngine()) // starts synchronously, inside the tap
      .then((ready) => {
        if (run !== this.sweepRun) return; // stopped meanwhile
        if (ready) this.playStep(run, 0);
        else this.failSweep();
      })
      .catch(() => {
        if (run === this.sweepRun) this.failSweep(); // never left 'starting'
      });
  }

  /** The lowest step that played cleanly → hpCornerHz. */
  pickCorner(hz: number): void {
    if (this.step.peek() !== 'bass' || !this.sweep.peek().heard || !BASS_SWEEP_HZ.includes(hz)) return;
    this.stopTone();
    this.deps.updateSettings({ hpCornerHz: hz });
    this.afterSweep();
  }

  /** Keeps the current corner (the 40 Hz default on a first run). */
  skipSweep(): void {
    if (this.step.peek() !== 'bass') return;
    this.stopTone();
    this.afterSweep();
  }

  chooseAccel(name: string): void {
    this.deps.updateSettings({ accelMode: name });
    this.finish();
  }

  back(): void {
    const h = this.history.peek();
    const prev = h[h.length - 1];
    if (prev === undefined) return;
    this.stopTone();
    batch(() => {
      this.history.value = h.slice(0, -1);
      this.show(prev);
    });
  }

  /**
   * Re-run only: puts the car and its answers back as they were when the re-run opened — every answer
   * was stored as it was given, and another car reset the rest — then returns to Settings. One patch,
   * so the original car's mode is validated against that car.
   */
  cancel(): void {
    const original = this.original;
    if (!this.rerun || original === null) return;
    this.stopTone();
    this.deps.updateSettings({ ...original });
    this.deps.go('settings');
  }

  /** The screen is going away: the tone stops, the parked/audio watch ends, and a start still in flight plays nothing. */
  dispose(): void {
    this.stopTone();
    this.stopWatch();
  }

  private commitCar(choice: CarChoice): void {
    this.deps.updateSettings(carChoicePatch(this.deps.settings.peek(), choice));
  }

  private advance(next: FirstRunStep): void {
    batch(() => {
      this.history.value = [...this.history.peek(), this.step.peek()];
      this.show(next);
    });
  }

  private show(step: FirstRunStep): void {
    if (step === 'bass') this.sweep.value = IDLE_SWEEP; // every visit starts a fresh sweep
    this.step.value = step;
  }

  /** The acceleration mode when the car has a choice of modes, else the end. */
  private afterSweep(): void {
    const r = teslaById(this.deps.settings.peek().teslaId);
    if (r !== null && r.accelModes.length > 1) this.advance('accel');
    else this.finish();
  }

  private finish(): void {
    this.stopTone();
    this.deps.go(this.rerun ? 'settings' : 'garage');
  }

  private playStep(run: number, i: number): void {
    if (run !== this.sweepRun) return;
    const hz = BASS_SWEEP_HZ[i];
    if (hz === undefined) {
      this.stopTone();
      this.sweep.value = { phase: 'done', index: null, heard: true };
      return;
    }
    if (!this.deps.parked.peek() || this.deps.audio.peek().state !== 'running') {
      this.failSweep();
      return;
    }
    this.toneOn = true;
    this.deps.shell.post({ type: 'testTone', hz, levelDb: BASS_SWEEP_LEVEL_DB });
    this.sweep.value = { phase: 'playing', index: i, heard: true };
    this.toneTimer = setTimeout(() => this.playStep(run, i + 1), BASS_SWEEP_STEP_MS);
  }

  private failSweep(): void {
    const heard = this.sweep.peek().heard;
    this.stopTone();
    this.sweep.value = { phase: 'failed', index: null, heard };
  }

  /** Ends the current run: no further step, and the tone (if on) fades out. */
  private stopTone(): void {
    this.sweepRun++;
    clearTimeout(this.toneTimer);
    this.toneTimer = undefined;
    if (!this.toneOn) return;
    this.toneOn = false;
    this.deps.shell.post({ type: 'testTone', hz: null, levelDb: BASS_SWEEP_LEVEL_DB });
  }
}

// ───────────────────────────── View (hook-free) ─────────────────────────────

interface FlowProps {
  flow: FirstRunFlow;
}

export function FirstRunView({ flow }: FlowProps): VNode {
  const step = flow.step.value;
  return (
    <section class="screen first-run" data-screen="first-run" data-step={step}>
      <header class="screen-header">
        {flow.canGoBack.value ? (
          <button type="button" class="btn-quiet" onClick={() => flow.back()}>
            {STR.actions.back}
          </button>
        ) : null}
        <h1>{STR.screens['first-run']}</h1>
        {flow.rerun ? (
          <button type="button" class="btn-quiet" onClick={() => flow.cancel()}>
            {STR.firstRun.cancel}
          </button>
        ) : null}
      </header>
      <StepView flow={flow} step={step} />
    </section>
  );
}

function StepView({ flow, step }: FlowProps & { step: FirstRunStep }): VNode | null {
  switch (step) {
    case 'notices':
      return <Notices flow={flow} />;
    case 'model':
      return <ModelStep flow={flow} />;
    case 'generation':
      return <GenerationStep flow={flow} />;
    case 'trim':
      return <TrimStep flow={flow} />;
    case 'retrofit':
      return <RetrofitStep flow={flow} />;
    case 'mcu1':
      return <Mcu1Step flow={flow} />;
    case 'notListed':
      return <NotListedStep flow={flow} />;
    case 'subwoofer':
      return <SubwooferStep flow={flow} />;
    case 'bass':
      return <BassStep flow={flow} />;
    case 'accel':
      return <AccelStep flow={flow} />;
  }
}

function Notices({ flow }: FlowProps): VNode {
  return (
    <div class="panel group">
      <h2>{STR.firstRun.noticesTitle}</h2>
      <ol class="notice-list">
        {STR.notices.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ol>
      <div class="row">
        <button type="button" class="btn-primary" onClick={() => flow.ackNotices()}>
          {STR.actions.ok}
        </button>
      </div>
    </div>
  );
}

/** The chosen car in one line, for orientation on the later steps. */
function CarLine({ settings }: { settings: Settings }): VNode | null {
  const summary = carSummary(settings);
  return summary === null ? null : <p class="muted">{summary}</p>;
}

function ModelStep({ flow }: FlowProps): VNode {
  const s = flow.deps.settings.value;
  const parked = flow.deps.parked.value;
  const current = teslaById(s.teslaId)?.model ?? null;
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.model}</h2>
      <div class="choices">
        {teslaModels().map((m) => (
          <button
            type="button"
            class="choice"
            key={m}
            data-model={m}
            aria-pressed={m === current}
            onClick={() => flow.chooseModel(m)}
          >
            {m}
          </button>
        ))}
        <button
          type="button"
          class="choice"
          data-model="not-listed"
          aria-pressed={s.teslaId === null && s.notListed !== null}
          disabled={!parked}
          onClick={() => flow.chooseNotListed()}
        >
          {STR.firstRun.notListed}
          <small>{parked ? STR.firstRun.notListedHint : STR.parkedOnly}</small>
        </button>
      </div>
    </div>
  );
}

function GenerationStep({ flow }: FlowProps): VNode | null {
  const model = flow.model.value;
  if (model === null) return null;
  const current = teslaById(flow.deps.settings.value.teslaId);
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.generation}</h2>
      <p class="muted">{model}</p>
      <div class="choices">
        {generationsOf(model).map((g) => (
          <button
            type="button"
            class="choice"
            key={g.generation}
            data-generation={g.generation}
            aria-pressed={current?.model === model && current.generation === g.generation}
            onClick={() => flow.chooseGeneration(g.generation)}
          >
            {g.generation}
            <small>{formatYears(g.years)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function TrimStep({ flow }: FlowProps): VNode | null {
  const model = flow.model.value;
  const generation = flow.generation.value;
  if (model === null || generation === null) return null;
  const teslaId = flow.deps.settings.value.teslaId;
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.trim}</h2>
      <p class="muted">{[model, generation].join(' · ')}</p>
      <div class="choices">
        {trimsOf(model, generation).map((r) => (
          <button
            type="button"
            class="choice"
            key={r.id}
            data-tesla={r.id}
            aria-pressed={r.id === teslaId}
            onClick={() => flow.chooseTrim(r.id)}
          >
            {r.trim}
            <small>{formatYears(r.years)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function RetrofitStep({ flow }: FlowProps): VNode {
  const s = flow.deps.settings.value;
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.retrofit}</h2>
      <CarLine settings={s} />
      <p class="muted">{STR.firstRun.retrofitHint}</p>
      <div class="choices">
        <button
          type="button"
          class="choice"
          data-retrofit="yes"
          aria-pressed={s.mcu2Retrofit === true}
          onClick={() => flow.answerRetrofit(true)}
        >
          {STR.firstRun.retrofitYes}
        </button>
        <button
          type="button"
          class="choice"
          data-retrofit="no"
          aria-pressed={s.mcu2Retrofit === false}
          onClick={() => flow.answerRetrofit(false)}
        >
          {STR.firstRun.retrofitNo}
        </button>
      </div>
    </div>
  );
}

function Mcu1Step({ flow }: FlowProps): VNode {
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.mcu1}</h2>
      <div class="banner bad" role="alert">
        <p>{STR.firstRun.mcu1Blocked}</p>
      </div>
      <div class="row">
        <button type="button" onClick={() => flow.continueWithoutMcu2()}>
          {STR.firstRun.continueAnyway}
        </button>
      </div>
    </div>
  );
}

function NotListedStep({ flow }: FlowProps): VNode {
  const d = flow.draft.value;
  const parked = flow.deps.parked.value;
  const seconds = NOT_LISTED_ZERO_TO_100_RANGE_S;
  const kg = NOT_LISTED_MASS_RANGE_KG;
  return (
    <form
      class="group"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        flow.submitNotListed();
      }}
    >
      <h2>{STR.firstRun.steps.notListed}</h2>
      {parked ? null : (
        <div class="banner">
          <p>{STR.parkedOnly}</p>
        </div>
      )}
      <label class="field">
        <span>{STR.firstRun.zeroTo100Label}</span>
        <input
          type="number"
          name="zeroTo100"
          inputMode="decimal"
          min={seconds.min}
          max={seconds.max}
          step="0.1"
          value={d.zeroTo100}
          disabled={!parked}
          onInput={(e) => flow.editDraft({ zeroTo100: e.currentTarget.value })}
        />
      </label>
      <label class="field">
        <span>{STR.firstRun.massLabel}</span>
        <input
          type="number"
          name="mass"
          inputMode="numeric"
          min={kg.min}
          max={kg.max}
          step="1"
          value={d.mass}
          disabled={!parked}
          onInput={(e) => flow.editDraft({ mass: e.currentTarget.value })}
        />
      </label>
      <div class="field">
        <span>{STR.firstRun.bodyLabel}</span>
        <div class="seg" role="group" aria-label={STR.firstRun.bodyLabel}>
          {BODIES.map((b) => (
            <button
              type="button"
              key={b}
              data-body={b}
              aria-pressed={d.body === b}
              disabled={!parked}
              onClick={() => flow.editDraft({ body: b })}
            >
              {STR.firstRun.bodies[b]}
            </button>
          ))}
        </div>
      </div>
      {d.invalid ? (
        <div class="banner bad" role="alert">
          <p>{STR.firstRun.notListedInvalid(seconds, kg)}</p>
        </div>
      ) : null}
      <div class="row">
        <button type="submit" class="btn-primary" disabled={!parked}>
          {STR.firstRun.continue}
        </button>
      </div>
    </form>
  );
}

function SubwooferStep({ flow }: FlowProps): VNode {
  const s = flow.deps.settings.value;
  const record = teslaById(s.teslaId);
  const guess = record === null ? null : subwooferGuess(record);
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.subwoofer}</h2>
      <CarLine settings={s} />
      {guess === null ? null : <p>{STR.firstRun.subwooferGuessHint}</p>}
      <p class="muted">{STR.firstRun.subwooferHint}</p>
      <div class="choices">
        {SUBWOOFERS.map((v) => (
          <button
            type="button"
            class="choice"
            key={v}
            data-subwoofer={v}
            aria-pressed={s.subwoofer === v}
            onClick={() => flow.chooseSubwoofer(v)}
          >
            {STR.modes.subwoofer[v]}
            {v === guess ? <small>{STR.firstRun.bestGuess}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function BassStep({ flow }: FlowProps): VNode {
  const sweep = flow.sweep.value;
  const parked = flow.deps.parked.value;
  const corner = flow.deps.settings.value.hpCornerHz;
  const busy = sweep.phase === 'starting' || sweep.phase === 'playing';
  const index = sweep.index;
  const playingHz = index === null ? null : (BASS_SWEEP_HZ[index] ?? null);
  const playLabel =
    sweep.phase === 'starting'
      ? STR.firstRun.startingAudio
      : sweep.heard && sweep.phase !== 'playing'
        ? STR.firstRun.playAgain
        : STR.firstRun.playTones;
  // One live status line beside Play / Skip: the step playing, else what Skip keeps.
  const status =
    index === null || playingHz === null
      ? STR.firstRun.bassCurrent(corner)
      : STR.firstRun.playing(playingHz, index + 1, BASS_SWEEP_HZ.length);
  // The six steps share one row (each ≥ the touch size) so all of them stay in view on the 773 × 601
  // panel while the tones play; the step playing is the emphasised (amber) one.
  return (
    <div class="group" data-sweep={sweep.phase}>
      <h2>{STR.firstRun.steps.bass}</h2>
      <p>{STR.firstRun.bassIntro}</p>
      <div class="row">
        <button type="button" class="btn-primary" disabled={!parked || busy} onClick={() => flow.playSweep()}>
          {playLabel}
        </button>
        <button type="button" onClick={() => flow.skipSweep()}>
          {STR.actions.skip}
        </button>
        <p role="status">{status}</p>
      </div>
      {parked ? null : (
        <div class="banner">
          <p>{STR.parkedOnly}</p>
        </div>
      )}
      {sweep.phase === 'failed' ? (
        <div class="banner bad" role="alert">
          <p>{STR.firstRun.toneFailed}</p>
        </div>
      ) : null}
      <div class="row" role="group" aria-label={STR.firstRun.steps.bass}>
        {BASS_SWEEP_HZ.map((hz) => (
          <button
            type="button"
            class={hz === playingHz ? 'btn-primary' : undefined}
            key={hz}
            data-hz={hz}
            aria-current={hz === playingHz ? 'true' : undefined}
            disabled={!sweep.heard}
            onClick={() => flow.pickCorner(hz)}
          >
            {STR.firstRun.hz(hz)}
          </button>
        ))}
      </div>
    </div>
  );
}

function AccelStep({ flow }: FlowProps): VNode | null {
  const s = flow.deps.settings.value;
  const record = teslaById(s.teslaId);
  if (record === null) return null;
  const selected = selectedAccelMode(s, record);
  return (
    <div class="group">
      <h2>{STR.firstRun.steps.accel}</h2>
      <CarLine settings={s} />
      <p class="muted">{STR.firstRun.accelHint}</p>
      <div class="choices">
        {record.accelModes.map((m) => (
          <button
            type="button"
            class="choice"
            key={m.name}
            data-mode={m.name}
            aria-pressed={m.name === selected}
            onClick={() => flow.chooseAccel(m.name)}
          >
            {m.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── Routed screen ─────────────────────────────

/** The 'first-run' route: one flow per visit, wired to the store and the shell; disposed on leaving. */
export function FirstRun({ shell }: ScreenProps): VNode {
  const [flow] = useState(
    () =>
      new FirstRunFlow({
        settings: store.settings,
        parked: store.parked,
        audio: store.audio,
        snapshot: store.snapshot,
        updateSettings: store.updateSettings,
        go: store.go,
        shell,
      }),
  );
  useEffect(() => () => flow.dispose(), [flow]);
  const step = flow.step.value;
  useEffect(() => {
    globalThis.scrollTo?.(0, 0); // each step starts at its top (a long trim list may have scrolled)
  }, [step]);
  return <FirstRunView flow={flow} />;
}
