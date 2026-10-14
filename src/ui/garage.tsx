/**
 * Garage (phase-3 contract T7; spec §10.2 item 3): the engines as cards grouped Euro / JDM / American /
 * Exotic — title, "inspired by" subtitle, spec line (layout, displacement, aspiration, redline) — each
 * with Preview and Drive. The disclaimer is the shell footer under the screen (src/ui/app.tsx).
 *
 * - Drive selects the engine and opens Drive (whose Start overlay starts it).
 * - Preview selects the engine and has the shell start it from the tap (a user gesture: shell.startEngine
 *   creates the AudioContext before its first await; it leaves a running engine as it is, recovers an
 *   interrupted one, and restarts one still fading out after Stop engine once the stop has finished),
 *   waits until the audio runs and the engine is out of its crank (src/ui/wait.ts engineReady: a fresh
 *   snapshot in gear, the tier benchmark over), then pulses the throttle for 1.5 s on the keyboard speed
 *   source — a live-rendered rev — lifts and brakes, and puts the selected speed source back (Shell.post
 *   sends the source switch raw, so the settings keep theirs). A running engine that changes first
 *   finishes DspCore's engine swap: the old engine fades out, then the new one fades in. One preview at
 *   a time, and only while parked (a rev on the keyboard source would replace the GPS-driven sound while
 *   moving). The engine keeps running after a preview; Stop engine in the header stops it.
 * - Leaving the screen, Drive and Stop engine end a preview at once: pedal released, source restored. So
 *   does audio that stops running before the pulse (stopped, failed or interrupted).
 *
 * GarageModel holds the preview state (signals; runs in Node with fakes); GarageView renders without
 * hooks; Garage is the routed screen that wires both to the store and the shell.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '../app/settings';
import * as store from '../app/store';
import type { AudioState, Screen } from '../app/store';
import { ENGINES } from '../data/engines';
import type { ScreenProps, Shell } from './app';
import { engineGroups, engineSpecLine } from './picker';
import { STR } from './strings';
import { engineReady } from './wait';

/** The throttle pulse (contract T7). */
export const PREVIEW_PULSE_MS = 1500;
/** Then lift and brake for this long (a keyboard-source car stops; the rpm falls back to idle). */
export const PREVIEW_BRAKE_MS = 1500;
/**
 * DspCore swaps the engine of a running core behind a fade-out, then fades the new engine in, each
 * CONFIG_FADE_S long (src/dsp/dsp-core.ts). A copy in ms, so the main-thread bundle does not pull in the
 * DSP; the unit tests pin the two together.
 */
export const DSP_CONFIG_FADE_MS = 300;
/** A running engine that was just switched first finishes that whole swap (fade-out, then fade-in), plus a margin. */
export const PREVIEW_SWAP_MS = 2 * DSP_CONFIG_FADE_MS + 50;

/** What the garage uses: the store's signals and actions, and the shell. */
export interface GarageDeps {
  settings: ReadonlySignal<Settings>;
  parked: ReadonlySignal<boolean>;
  audio: ReadonlySignal<AudioState>;
  snapshot: ReadonlySignal<Float64Array>;
  updateSettings(patch: Partial<Settings>): unknown;
  go(screen: Screen): void;
  shell: Pick<Shell, 'startEngine' | 'stopEngine' | 'post'>;
}

export class GarageModel {
  /** Engine id of the preview in progress, or null. */
  readonly previewing = signal<string | null>(null);
  /** Bumped whenever a preview ends: a wait or timer of an older one does nothing. */
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The worklet was switched to the keyboard source for the pulse. */
  private sourceSwitched = false;
  /** A pedal other than released was sent. */
  private pedalDown = false;
  /** This garage's Stop engine until it has settled: EngineAudio still reports 'running' through its stop fade. */
  private stopping: Promise<void> | null = null;

  constructor(readonly deps: GarageDeps) {}

  /** Call it from the tap: the shell starts the engine (a user gesture) when it is not running. */
  preview(engineId: string): void {
    const d = this.deps;
    if (this.previewing.peek() !== null || !d.parked.peek() || !ENGINES.some((e) => e.id === engineId)) return;
    // An engine fading out after Stop engine is not running: the shell restarts it once the stop is over.
    const running = this.stopping === null && d.audio.peek().state === 'running';
    const swapped = running && d.settings.peek().engineId !== engineId;
    d.updateSettings({ engineId }); // a start picks it up; a running engine swaps behind its fade
    const run = ++this.run;
    this.previewing.value = engineId;
    // startEngine starts what needs starting (at once, inside the tap; a running engine stays as it is).
    void engineReady(d, () => d.shell.startEngine(), running)
      .then((ready) => {
        if (run !== this.run) return; // ended meanwhile
        if (!ready) this.previewing.value = null;
        else if (swapped) this.timer = setTimeout(() => this.pulse(run), PREVIEW_SWAP_MS);
        else this.pulse(run);
      })
      .catch(() => {
        if (run === this.run) this.endPreview(); // never left 'previewing'
      });
  }

  drive(engineId: string): void {
    this.endPreview();
    this.deps.updateSettings({ engineId });
    this.deps.go('drive');
  }

  stopEngine(): void {
    this.endPreview();
    const stopping = this.deps.shell.stopEngine();
    this.stopping = stopping;
    void stopping.then(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
  }

  /** The screen is going away. */
  dispose(): void {
    this.endPreview();
  }

  private pulse(run: number): void {
    if (run !== this.run) return;
    const d = this.deps;
    if (d.audio.peek().state !== 'running') {
      this.previewing.value = null;
      return;
    }
    if (d.settings.peek().source !== 'keyboard') {
      d.shell.post({ type: 'source', value: 'keyboard' });
      this.sourceSwitched = true;
    }
    d.shell.post({ type: 'pedal', throttle: 1, brake: 0 });
    this.pedalDown = true;
    this.timer = setTimeout(() => this.lift(run), PREVIEW_PULSE_MS);
  }

  private lift(run: number): void {
    if (run !== this.run) return;
    this.deps.shell.post({ type: 'pedal', throttle: 0, brake: 1 });
    this.restoreSource();
    this.timer = setTimeout(() => this.release(run), PREVIEW_BRAKE_MS);
  }

  private release(run: number): void {
    if (run !== this.run) return;
    this.releasePedal();
    this.previewing.value = null;
  }

  /** Ends a preview in progress at once: pedal released, the selected speed source back. */
  private endPreview(): void {
    this.run++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.releasePedal();
    this.restoreSource();
    this.previewing.value = null;
  }

  private releasePedal(): void {
    if (!this.pedalDown) return;
    this.pedalDown = false;
    this.deps.shell.post({ type: 'pedal', throttle: 0, brake: 0 });
  }

  private restoreSource(): void {
    if (!this.sourceSwitched) return;
    this.sourceSwitched = false;
    this.deps.shell.post({ type: 'source', value: this.deps.settings.peek().source });
  }
}

// ───────────────────────────── View (hook-free) ─────────────────────────────

export function GarageView({ garage }: { garage: GarageModel }): VNode {
  const d = garage.deps;
  const selected = d.settings.value.engineId;
  const parked = d.parked.value;
  const previewing = garage.previewing.value;
  const state = d.audio.value.state;
  const engineOn = state === 'starting' || state === 'running' || state === 'interrupted';
  return (
    <section class="screen garage" data-screen="garage">
      <header class="screen-header">
        <h1>{STR.screens.garage}</h1>
        {engineOn ? (
          <button type="button" class="btn-danger" onClick={() => garage.stopEngine()}>
            {STR.actions.stopEngine}
          </button>
        ) : null}
      </header>
      <p class="muted">{STR.garage.intro}</p>
      {parked ? null : (
        <div class="banner">
          <p>{STR.garage.previewParkedOnly}</p>
        </div>
      )}
      {engineGroups().map((g) => (
        <section class="group" key={g.set} data-set={g.set}>
          <h2>{STR.engineSets[g.set]}</h2>
          <div class="cards">
            {g.engines.map((e) => (
              <article class="card" key={e.id} data-engine={e.id} aria-current={e.id === selected ? 'true' : undefined}>
                <h3>{e.name}</h3>
                <p class="muted">{STR.inspiredBy(e.inspiredBy)}</p>
                <p class="spec">{engineSpecLine(e)}</p>
                <div class="row">
                  <button
                    type="button"
                    data-action="preview"
                    disabled={!parked || previewing !== null}
                    onClick={() => garage.preview(e.id)}
                  >
                    {previewing === e.id ? STR.garage.previewing : STR.actions.preview}
                  </button>
                  <button
                    type="button"
                    class={e.id === selected ? 'btn-primary' : undefined}
                    data-action="drive"
                    onClick={() => garage.drive(e.id)}
                  >
                    {STR.actions.drive}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

// ───────────────────────────── Routed screen ─────────────────────────────

/** The 'garage' route: one model per visit, wired to the store and the shell; disposed on leaving. */
export function Garage({ shell }: ScreenProps): VNode {
  const [garage] = useState(
    () =>
      new GarageModel({
        settings: store.settings,
        parked: store.parked,
        audio: store.audio,
        snapshot: store.snapshot,
        updateSettings: store.updateSettings,
        go: store.go,
        shell,
      }),
  );
  useEffect(() => () => garage.dispose(), [garage]);
  return <GarageView garage={garage} />;
}
