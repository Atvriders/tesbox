import { computed, signal } from '@preact/signals';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S, STATE_LEN, type MainToWorklet } from '../../src/contracts';
import { DEFAULT_SETTINGS, sanitizeSettings, teslaParamsFor, type Settings } from '../../src/app/settings';
import type { AudioState, AudioStatus, Screen } from '../../src/app/store';
import type { EngineAudioCallbacks, EngineAudioDiagnostics, EngineAudioStart } from '../../src/audio/engine-audio';
import { ENGINES, getEngine } from '../../src/data/engines';
import { CONFIG_FADE_S } from '../../src/dsp/dsp-core';
import { createShell, type ShellAudio } from '../../src/ui/app';
import {
  DSP_CONFIG_FADE_MS,
  GarageModel,
  GarageView,
  PREVIEW_BRAKE_MS,
  PREVIEW_PULSE_MS,
  PREVIEW_SWAP_MS,
  type GarageDeps,
} from '../../src/ui/garage';
import { voicingStatus } from '../../src/data/voicing-status';
import { garageSpecLine } from '../../src/ui/picker';
import { STR } from '../../src/ui/strings';
import { ENGINE_SETTLE_WAIT_MS } from '../../src/ui/wait';
import { button, buttonTexts, byAttr, byType, click, findAll, isDisabled, only, renderTree, textOf, type HostNode } from './helpers/vnode-tree';

const TESLA = 'model3-highland-lr-awd';

/** A snapshot with the engine in `gear` (0 while cranking, stopping or off). */
function snap(gear: number): Float64Array {
  const b = new Float64Array(STATE_LEN);
  b[S.gear] = gear;
  return b;
}

interface HarnessOptions {
  parked?: boolean;
  audio?: AudioStatus;
  startOk?: boolean;
  /** startEngine rejects (the shell promises never to; a regression must not leave Preview stuck). */
  startRejects?: boolean;
}

function harness(over: Partial<Settings> = {}, o: HarnessOptions = {}) {
  const settings = signal(sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: TESLA, noticesSeen: true, ...over }));
  const parked = signal(o.parked ?? true);
  const audio = signal<AudioState>({ state: o.audio ?? 'off', route: 'direct-anchor', tier: null });
  const snapshot = signal(snap(o.audio === 'running' ? 1 : 0));
  const posted: MainToWorklet[] = [];
  const screens: Screen[] = [];
  const startedWith: string[] = [];
  let stops = 0;
  const deps: GarageDeps = {
    settings,
    parked,
    audio,
    snapshot,
    updateSettings: (patch) => {
      const cur = settings.peek();
      settings.value = sanitizeSettings({ ...cur, ...patch }, cur);
      return true;
    },
    go: (s) => void screens.push(s),
    shell: {
      startEngine: () => {
        if (audio.peek().state === 'running') return Promise.resolve(true); // nothing to start
        startedWith.push(settings.peek().engineId);
        if (o.startRejects) return Promise.reject(new Error('boom'));
        const ok = o.startOk ?? true;
        audio.value = { ...audio.peek(), state: ok ? 'running' : 'error' };
        return Promise.resolve(ok);
      },
      stopEngine: () => {
        stops++;
        audio.value = { ...audio.peek(), state: 'off' };
        return Promise.resolve();
      },
      post: (m) => void posted.push(m),
    },
  };
  const garage = new GarageModel(deps);
  return {
    garage,
    settings,
    parked,
    audio,
    snapshot,
    posted,
    screens,
    startedWith,
    stops: () => stops,
    view: () => renderTree(h(GarageView, { garage })),
  };
}

const NO_DIAGNOSTICS: EngineAudioDiagnostics = {
  contextState: 'none',
  sampleRate: null,
  baseLatencyS: null,
  outputLatencyS: null,
  latencyHint: null,
  recoveries: { resumeOk: 0, resumeFail: 0, recreate: 0 },
  bench: null,
};

/**
 * EngineAudio stand-in for the real shell: a start reports 'starting' then 'running' at once; a stop
 * keeps reporting 'running' through its fade (EngineAudio STOP_FADE_MS) until endFade(), then 'off'.
 */
class FadingAudio implements ShellAudio {
  readonly starts: EngineAudioStart[] = [];
  readonly posted: MainToWorklet[] = [];
  private finishFade: (() => void) | null = null;
  constructor(private readonly cb: EngineAudioCallbacks) {}
  get diagnostics(): EngineAudioDiagnostics {
    return NO_DIAGNOSTICS;
  }
  start(init: EngineAudioStart): Promise<void> {
    this.starts.push(init);
    this.report('starting');
    this.report('running');
    return Promise.resolve();
  }
  post(msg: MainToWorklet): void {
    this.posted.push(msg);
  }
  setRoute(): Promise<void> {
    return Promise.resolve();
  }
  recover(): Promise<boolean> {
    return Promise.resolve(true);
  }
  setVisibility(): void {}
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.finishFade = () => {
        this.finishFade = null;
        this.report('off');
        resolve();
      };
    });
  }
  endFade(): void {
    this.finishFade?.();
  }
  private report(state: AudioStatus): void {
    this.cb.onState({ state, route: 'direct-anchor', tier: null });
  }
}

/** The garage on the real shell (src/ui/app.tsx createShell) over FadingAudio. */
function withShell(over: Partial<Settings> = {}) {
  const settings = signal(sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: TESLA, noticesSeen: true, ...over }));
  const audio = signal<AudioState>({ state: 'off', route: 'direct-anchor', tier: null });
  const snapshot = signal(snap(0));
  const updateSettings = (patch: Partial<Settings>): boolean => {
    const cur = settings.peek();
    settings.value = sanitizeSettings({ ...cur, ...patch }, cur);
    return true;
  };
  let fake: FadingAudio | null = null;
  const made = createShell({
    settings,
    engine: computed(() => getEngine(settings.value.engineId)),
    teslaParams: computed(() => teslaParamsFor(settings.value)),
    audio,
    snapshot,
    toast: signal<string | null>(null),
    updateSettings,
    createAudio: (cb) => (fake = new FadingAudio(cb)),
    mcu: () => 'amd',
  });
  if (fake === null) throw new Error('createShell did not create the audio controller');
  const garage = new GarageModel({ settings, parked: signal(true), audio, snapshot, updateSettings, go: () => {}, shell: made.shell });
  return { garage, shell: made.shell, dispose: made.dispose, fake: fake as FadingAudio, audio, snapshot };
}

/** What a Preview sends: the speed-source switch and the pedal. */
const previewInputs = (posted: readonly MainToWorklet[]): MainToWorklet[] =>
  posted.filter((m) => m.type === 'pedal' || m.type === 'source');

function card(nodes: ReturnType<ReturnType<typeof harness>['view']>, id: string): HostNode {
  return only(nodes, byAttr('data-engine', id), `card ${id}`);
}

const keyboard: MainToWorklet = { type: 'source', value: 'keyboard' };
const pedal = (throttle: number, brake: number): MainToWorklet => ({ type: 'pedal', throttle, brake });

describe('Garage view (spec §10.2 item 3)', () => {
  it('shows the 15 engines as cards in four groups: Euro, JDM, American, Exotic', () => {
    const v = harness().view();
    expect(only(v, byAttr('data-screen')).props['data-screen']).toBe('garage');
    const groups = findAll(v, byAttr('data-set'));
    expect(groups.map((g) => g.props['data-set'])).toEqual(['euro', 'jdm', 'american', 'exotic']);
    expect(groups.map((g) => textOf(findAll(g, byType('h2'))))).toEqual(['Euro', 'JDM', 'American', 'Exotic']);
    expect(groups.map((g) => findAll(g, byAttr('data-engine')).length)).toEqual([4, 4, 3, 4]);
    expect(findAll(v, byAttr('data-engine')).map((c) => c.props['data-engine'])).toEqual(ENGINES.map((e) => e.id));
  });

  it('cards show the title, "inspired by" and the spec line, with Preview and Drive', () => {
    const c = card(harness().view(), 'i5-turbo-25');
    expect(c.type).toBe('article');
    expect(textOf(only(c, byType('h3')))).toBe('2.5 Turbo Inline-5');
    expect(textOf(only(c, byAttr('class', 'muted')))).toBe(STR.inspiredBy('Audi RS 3 (8Y)'));
    const spec = textOf(only(c, byAttr('class', 'spec')));
    expect(spec).toBe(garageSpecLine(getEngine('i5-turbo-25')));
    // A pilot engine: "· Tuned" follows once its tuned voicing is applied (until the user signs it off).
    expect(spec.replace(/\u00a0/g, ' ').replace(/\u2011/g, '-')).toMatch(/^Inline-5 · 2\.5 L · Turbo · 7,000 rpm redline( · Tuned)?$/);
    expect(buttonTexts(c)).toEqual([STR.actions.preview, STR.actions.drive]);
  });

  it('shows each voicing status (phase-4 contract T4): "Beta voicing" while estimated, "Tuned" while a tuned voicing awaits sign-off', () => {
    const v = harness().view();
    for (const e of ENGINES) {
      const c = card(v, e.id);
      const badges = findAll(c, byAttr('class', 'badge')).map((b) => textOf(b.children));
      expect(badges, e.id).toEqual(e.voicing.estimated ? [STR.garage.betaVoicing] : []);
      const spec = textOf(only(c, byAttr('class', 'spec')));
      expect(spec, e.id).toBe(garageSpecLine(e));
      expect(spec.endsWith(`\u00a0· ${STR.garage.tuned}`), e.id).toBe(voicingStatus(e) === 'tuned');
    }
  });

  it('marks the selected engine, whose Drive is the primary action', () => {
    const v = harness({ engineId: 'v8-na-50' }).view();
    expect(findAll(v, byAttr('aria-current', 'true')).map((c) => c.props['data-engine'])).toEqual(['v8-na-50']);
    const primaries = findAll(v, byAttr('class', 'btn-primary'));
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toBe(button(card(v, 'v8-na-50'), STR.actions.drive));
  });

  it('Drive selects the engine and opens Drive without starting anything', () => {
    const t = harness();
    click(button(card(t.view(), 'v8-na-50'), STR.actions.drive));
    expect(t.settings.value.engineId).toBe('v8-na-50');
    expect(t.screens).toEqual(['drive']);
    expect(t.startedWith).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  it('offers Stop engine only while the engine is on', () => {
    const t = harness();
    expect(buttonTexts(t.view())).not.toContain(STR.actions.stopEngine);
    for (const state of ['starting', 'running', 'interrupted'] as const) {
      t.audio.value = { ...t.audio.peek(), state };
      expect(buttonTexts(t.view())).toContain(STR.actions.stopEngine);
    }
    click(button(t.view(), STR.actions.stopEngine));
    expect(t.stops()).toBe(1);
    expect(buttonTexts(t.view())).not.toContain(STR.actions.stopEngine);
  });
});

describe('Garage Preview (contract T7: start if needed, then a 1.5 s keyboard pedal pulse)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('from engine off: selects the engine, starts it from the tap, waits out the crank, pulses, restores the source', async () => {
    const t = harness(); // source: GPS
    click(button(card(t.view(), 'v8-na-50'), STR.actions.preview));
    expect(t.startedWith).toEqual(['v8-na-50']); // selected first, started synchronously inside the tap
    expect(t.garage.previewing.value).toBe('v8-na-50');
    let v = t.view();
    expect(textOf(button(card(v, 'v8-na-50'), STR.garage.previewing).children)).toBe(STR.garage.previewing);
    expect(findAll(v, (el) => el.type === 'button' && el.props['data-action'] === 'preview').every(isDisabled)).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]); // still cranking
    t.snapshot.value = snap(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]);
    t.snapshot.value = snap(1); // running in gear
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([keyboard, pedal(1, 0)]);

    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS - 1);
    expect(t.posted).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.posted).toEqual([keyboard, pedal(1, 0), pedal(0, 1), { type: 'source', value: 'gps' }]);
    expect(t.garage.previewing.value).toBe('v8-na-50');
    await vi.advanceTimersByTimeAsync(PREVIEW_BRAKE_MS);
    expect(t.posted.at(-1)).toEqual(pedal(0, 0));
    expect(t.garage.previewing.value).toBeNull();
    v = t.view();
    expect(findAll(v, (el) => el.type === 'button' && el.props['data-action'] === 'preview').some(isDisabled)).toBe(false);
    expect(t.startedWith).toHaveLength(1);
  });

  it('with the engine running: pulses at once; another engine first waits out its crossfade', async () => {
    const t = harness({ source: 'demo' }, { audio: 'running' });
    t.garage.preview('i5-turbo-25'); // the selected engine
    await vi.advanceTimersByTimeAsync(0);
    expect(t.startedWith).toEqual([]);
    expect(t.posted).toEqual([keyboard, pedal(1, 0)]);
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + PREVIEW_BRAKE_MS);
    expect(t.posted.slice(2)).toEqual([pedal(0, 1), { type: 'source', value: 'demo' }, pedal(0, 0)]);

    t.posted.length = 0;
    t.garage.preview('v12-na-65');
    expect(t.settings.value.engineId).toBe('v12-na-65');
    await vi.advanceTimersByTimeAsync(PREVIEW_SWAP_MS - 1);
    expect(t.posted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.posted).toEqual([keyboard, pedal(1, 0)]);
  });

  it('on the keyboard source: no source switch, and it brakes to a stop after the pulse', async () => {
    const t = harness({ source: 'keyboard' }, { audio: 'running' });
    t.garage.preview('i5-turbo-25');
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + PREVIEW_BRAKE_MS);
    expect(t.posted).toEqual([pedal(1, 0), pedal(0, 1), pedal(0, 0)]);
  });

  it('only while parked, and one at a time', async () => {
    const moving = harness({}, { parked: false });
    const v = moving.view();
    expect(findAll(v, (el) => el.type === 'button' && el.props['data-action'] === 'preview').every(isDisabled)).toBe(true);
    expect(textOf(v)).toContain(STR.garage.previewParkedOnly);
    moving.garage.preview('v8-na-50');
    expect(moving.startedWith).toEqual([]);
    expect(moving.settings.value.engineId).toBe('i5-turbo-25');

    const t = harness({}, { audio: 'running' });
    t.garage.preview('i5-turbo-25');
    t.garage.preview('v8-na-50'); // ignored while the first runs
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + PREVIEW_BRAKE_MS + PREVIEW_SWAP_MS);
    expect(t.settings.value.engineId).toBe('i5-turbo-25');
    expect(t.posted.filter((m) => m.type === 'pedal' && m.throttle === 1)).toHaveLength(1);
  });

  it('leaving mid-pulse releases the pedal and restores the source at once', async () => {
    const t = harness({}, { audio: 'running' });
    t.garage.preview('i5-turbo-25');
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS / 2);
    t.garage.dispose();
    expect(t.posted).toEqual([keyboard, pedal(1, 0), pedal(0, 0), { type: 'source', value: 'gps' }]);
    expect(t.garage.previewing.value).toBeNull();
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + PREVIEW_BRAKE_MS);
    expect(t.posted).toHaveLength(4);
  });

  it('Drive mid-preview ends the preview first', async () => {
    const t = harness({}, { audio: 'running' });
    t.garage.preview('i5-turbo-25');
    await vi.advanceTimersByTimeAsync(0);
    click(button(card(t.view(), 'v8-na-50'), STR.actions.drive));
    expect(t.posted).toEqual([keyboard, pedal(1, 0), pedal(0, 0), { type: 'source', value: 'gps' }]);
    expect(t.settings.value.engineId).toBe('v8-na-50');
    expect(t.screens).toEqual(['drive']);
  });

  it('Stop engine mid-preview ends the preview and stops the engine', async () => {
    const t = harness({}, { audio: 'running' });
    t.garage.preview('i5-turbo-25');
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + 1); // braking, source restored
    click(button(t.view(), STR.actions.stopEngine));
    expect(t.posted).toEqual([keyboard, pedal(1, 0), pedal(0, 1), { type: 'source', value: 'gps' }, pedal(0, 0)]);
    expect(t.stops()).toBe(1);
    expect(t.garage.previewing.value).toBeNull();
  });

  it('after a restart, waits for a fresh in-gear snapshot (the stored one may be from before)', async () => {
    const t = harness({}, { audio: 'interrupted' });
    t.snapshot.value = snap(3); // last report of the engine before the interruption
    t.garage.preview('i5-turbo-25');
    expect(t.startedWith).toEqual(['i5-turbo-25']); // Tap to resume, from the tap
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]);
    t.snapshot.value = snap(0); // the rebuilt engine cranks
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]);
    t.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([keyboard, pedal(1, 0)]);
  });

  it('a start that fails ends the preview without touching the worklet', async () => {
    const t = harness({}, { startOk: false });
    t.garage.preview('v8-na-50');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.garage.previewing.value).toBeNull();
    expect(t.posted).toEqual([]);
  });

  it('a start that rejects ends the preview, buttons enabled again', async () => {
    const t = harness({}, { startRejects: true });
    t.garage.preview('v8-na-50');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.garage.previewing.value).toBeNull();
    expect(t.posted).toEqual([]);
    expect(findAll(t.view(), (el) => el.type === 'button' && el.props['data-action'] === 'preview').some(isDisabled)).toBe(false);
  });

  it('gives up when the engine never leaves the crank', async () => {
    const t = harness();
    t.garage.preview('v8-na-50');
    await vi.advanceTimersByTimeAsync(ENGINE_SETTLE_WAIT_MS);
    expect(t.garage.previewing.value).toBeNull();
    t.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS);
    expect(t.posted).toEqual([]);
  });

  it('ends at once when the audio stops running during the crank, instead of holding "Previewing…"', async () => {
    for (const state of ['off', 'error', 'interrupted'] as const) {
      const t = harness();
      t.garage.preview('v8-na-50');
      await vi.advanceTimersByTimeAsync(1000); // running, still cranking
      expect(t.garage.previewing.value, state).toBe('v8-na-50');
      t.audio.value = { ...t.audio.peek(), state };
      await vi.advanceTimersByTimeAsync(0);
      expect(t.garage.previewing.value, state).toBeNull();
      expect(findAll(t.view(), (el) => el.type === 'button' && el.props['data-action'] === 'preview').some(isDisabled), state).toBe(false);
      t.snapshot.value = snap(1);
      await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS);
      expect(t.posted, state).toEqual([]);
    }
  });

  it("a switched engine first finishes DspCore's whole swap: the old engine fades out, then the new one fades in", () => {
    expect(DSP_CONFIG_FADE_MS / 1000).toBe(CONFIG_FADE_S); // the main-thread copy is pinned to the DSP
    expect(PREVIEW_SWAP_MS).toBeGreaterThanOrEqual(2 * DSP_CONFIG_FADE_MS);
  });
});

describe('Garage Preview on the real shell (stop fade, queued restart)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Stop engine, then Preview during the stop fade: the shell restarts the engine and the pulse follows its crank', async () => {
    const t = withShell(); // source: GPS
    await t.shell.startEngine();
    expect(t.audio.value.state).toBe('running');
    t.snapshot.value = snap(2); // running in gear
    t.garage.stopEngine(); // EngineAudio fades out first and keeps reporting 'running'
    t.snapshot.value = snap(0); // the engine winds down (SimCore: gear 0 while stopping)
    await vi.advanceTimersByTimeAsync(300);
    expect(t.audio.value.state).toBe('running');

    t.garage.preview('v8-na-50');
    expect(t.garage.previewing.value).toBe('v8-na-50');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fake.starts).toHaveLength(1); // the restart waits for the end of the fade
    t.fake.endFade(); // 'off', then the shell's queued start
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fake.starts).toHaveLength(2);
    expect(t.fake.starts[1]?.engineName).toBe(getEngine('v8-na-50').name);
    expect(t.audio.value.state).toBe('running');
    expect(previewInputs(t.fake.posted)).toEqual([]); // the new engine cranks
    t.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(previewInputs(t.fake.posted)).toEqual([keyboard, pedal(1, 0)]);
    await vi.advanceTimersByTimeAsync(PREVIEW_PULSE_MS + PREVIEW_BRAKE_MS);
    expect(previewInputs(t.fake.posted)).toEqual([keyboard, pedal(1, 0), pedal(0, 1), { type: 'source', value: 'gps' }, pedal(0, 0)]);
    expect(t.garage.previewing.value).toBeNull();
    t.dispose();
  });

  it('a Stop tapped again during the queued restart cancels it and ends the preview', async () => {
    const t = withShell();
    await t.shell.startEngine();
    t.snapshot.value = snap(2);
    t.garage.stopEngine();
    t.snapshot.value = snap(0);
    t.garage.preview('v8-na-50');
    t.garage.stopEngine();
    expect(t.garage.previewing.value).toBeNull();
    t.fake.endFade();
    await vi.advanceTimersByTimeAsync(ENGINE_SETTLE_WAIT_MS);
    expect(t.fake.starts).toHaveLength(1);
    expect(previewInputs(t.fake.posted)).toEqual([]);
    t.dispose();
  });
});
