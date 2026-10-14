import { signal } from '@preact/signals';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S, STATE_LEN, type MainToWorklet } from '../../src/contracts';
import { DEFAULT_SETTINGS, NOT_LISTED_MASS_RANGE_KG, NOT_LISTED_ZERO_TO_100_RANGE_S, sanitizeSettings, type Settings } from '../../src/app/settings';
import type { AudioState, AudioStatus, Screen } from '../../src/app/store';
import { FirstRunFlow, FirstRunView, type FirstRunDeps } from '../../src/ui/first-run';
import { BASS_SWEEP_HZ, BASS_SWEEP_LEVEL_DB, BASS_SWEEP_STEP_MS } from '../../src/ui/picker';
import { STR } from '../../src/ui/strings';
import { AUDIO_START_WAIT_MS, ENGINE_SETTLE_WAIT_MS } from '../../src/ui/wait';
import {
  button,
  buttonTexts,
  byAttr,
  byType,
  click,
  findAll,
  input,
  isDisabled,
  only,
  renderTree,
  submit,
  textOf,
} from './helpers/vnode-tree';

const OFF: AudioState = { state: 'off', route: 'direct-anchor', tier: null };
const HIGHLAND = 'Highland (2023–)';
const HIGHLAND_LR = 'model3-highland-lr-awd'; // subwooferDefault true, accelModes Chill | Standard
const HIGHLAND_RWD = 'model3-highland-rwd'; // subwooferDefault false

function settingsWith(over: Partial<Settings> = {}): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...over });
}

/** A worklet snapshot: the engine in `gear` (0 while cranking or off), the DSP rendered `benchK`× per quantum. */
function snap(gear: number, benchK = 1): Float64Array {
  const b = new Float64Array(STATE_LEN);
  b[S.gear] = gear;
  b[S.benchK] = benchK;
  return b;
}

interface HarnessOptions {
  parked?: boolean;
  /** The audio when the flow opens (default off); 'running' comes with the engine in gear. */
  audio?: AudioStatus;
  /** startEngine stays pending (audio 'starting') until resolveStart(). */
  manualStart?: boolean;
  /** startEngine's result when not manual (false → audio 'error'). */
  startOk?: boolean;
  /** startEngine rejects (the shell promises never to; a regression must not leave the sweep stuck). */
  startRejects?: boolean;
  /** A started engine stays in its crank (gear 0) until the test reports otherwise; by default it is in gear at once. */
  cranks?: boolean;
}

/** A flow over fake store signals and a fake shell; updateSettings validates like the store does. */
function harness(over: Partial<Settings> = {}, o: HarnessOptions = {}) {
  const settings = signal(settingsWith(over));
  const parked = signal(o.parked ?? true);
  const audio = signal<AudioState>({ ...OFF, state: o.audio ?? 'off' });
  const snapshot = signal(snap(o.audio === 'running' ? 1 : 0));
  const posted: MainToWorklet[] = [];
  const screens: Screen[] = [];
  const patches: Partial<Settings>[] = [];
  let starts = 0;
  let resolveStart: (ok: boolean) => void = () => {};
  const deps: FirstRunDeps = {
    settings,
    parked,
    audio,
    snapshot,
    updateSettings: (patch) => {
      patches.push(patch);
      const cur = settings.peek();
      settings.value = sanitizeSettings({ ...cur, ...patch }, cur);
      return true;
    },
    go: (s) => void screens.push(s),
    shell: {
      startEngine: () => {
        starts++;
        if (audio.peek().state === 'running') return Promise.resolve(true);
        if (o.startRejects) return Promise.reject(new Error('boom'));
        audio.value = { ...audio.peek(), state: 'starting' };
        if (o.manualStart) return new Promise<boolean>((r) => (resolveStart = r));
        const ok = o.startOk ?? true;
        audio.value = { ...audio.peek(), state: ok ? 'running' : 'error' };
        if (ok && !o.cranks) snapshot.value = snap(1); // out of its crank at once
        return Promise.resolve(ok);
      },
      post: (m) => void posted.push(m),
    },
  };
  const flow = new FirstRunFlow(deps);
  return {
    flow,
    settings,
    parked,
    audio,
    snapshot,
    posted,
    screens,
    patches,
    view: () => renderTree(h(FirstRunView, { flow })),
    starts: () => starts,
    resolveStart: (ok: boolean) => resolveStart(ok),
    /** The audio runs and the engine is in gear (a fresh snapshot). */
    runInGear: () => {
      audio.value = { ...audio.peek(), state: 'running' };
      snapshot.value = snap(1);
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** The hz of every testTone posted, in order (null = tone off). */
function tones(posted: readonly MainToWorklet[]): (number | null)[] {
  return posted.flatMap((m) => (m.type === 'testTone' ? [m.hz] : []));
}

const attrs = (els: { props: Record<string, unknown> }[], name: string): unknown[] => els.map((e) => e.props[name]);

/** Picks Model 3 → Highland → `trim` and answers the subwoofer question. */
function toBass(t: Harness, trim = HIGHLAND_LR): void {
  t.flow.chooseModel('Model 3');
  t.flow.chooseGeneration(HIGHLAND);
  t.flow.chooseTrim(trim);
  t.flow.chooseSubwoofer('no');
  expect(t.flow.step.value).toBe('bass');
}

describe('FirstRunFlow: notices (spec §10.2 item 2)', () => {
  it('opens on the five notices until they are seen; one OK stores noticesSeen and opens the model step', () => {
    const t = harness();
    expect(t.flow.step.value).toBe('notices');
    const v = t.view();
    expect(only(v, byType('section')).props['data-step']).toBe('notices');
    expect(findAll(v, byType('li')).map((li) => textOf(li.children))).toEqual([...STR.notices]);
    expect(buttonTexts(v)).toEqual([STR.actions.ok]);
    click(button(v, STR.actions.ok));
    expect(t.settings.value.noticesSeen).toBe(true);
    expect(t.flow.step.value).toBe('model');
    expect(t.flow.canGoBack.value).toBe(false); // the notices are not a step to return to
    expect(buttonTexts(t.view())).not.toContain(STR.actions.back);
  });

  it('starts at the model step once the notices were seen', () => {
    const t = harness({ noticesSeen: true });
    expect(t.flow.step.value).toBe('model');
    expect(t.flow.rerun).toBe(false);
    expect(buttonTexts(t.view())).not.toContain(STR.firstRun.cancel);
  });
});

describe('FirstRunFlow: Tesla picker (spec §9.3)', () => {
  it('Model 3 → Highland → Long Range AWD stores the car with its best guesses and asks about the subwoofer', () => {
    const t = harness({ noticesSeen: true });
    let v = t.view();
    expect(attrs(findAll(v, byAttr('data-model')), 'data-model')).toEqual([
      'Model S',
      'Model X',
      'Model 3',
      'Model Y',
      'Model Y L',
      'Cybertruck',
      'not-listed',
    ]);
    click(only(v, byAttr('data-model', 'Model 3')));
    expect(t.flow.step.value).toBe('generation');

    v = t.view();
    const gens = findAll(v, byAttr('data-generation'));
    expect(attrs(gens, 'data-generation')).toEqual(['2017–2023 (original)', HIGHLAND]);
    expect(gens.map((g) => textOf(findAll(g, byType('small'))))).toEqual(['2017–2023', '2023–2026']);
    click(only(v, byAttr('data-generation', HIGHLAND)));
    expect(t.flow.step.value).toBe('trim');

    v = t.view();
    expect(attrs(findAll(v, byAttr('data-tesla')), 'data-tesla')).toEqual([
      'model3-highland-rwd',
      'model3-highland-lr-rwd',
      HIGHLAND_LR,
      'model3-highland-performance',
      'model3-highland-standard',
    ]);
    const lr = only(v, byAttr('data-tesla', HIGHLAND_LR));
    expect(textOf(lr.children)).toBe('Long Range AWD / Premium AWD2023–2026');
    click(lr);
    expect(t.settings.value).toMatchObject({
      teslaId: HIGHLAND_LR,
      notListed: null,
      subwoofer: 'yes',
      hpCornerHz: 40,
      accelMode: null,
      mcu2Retrofit: null,
    });
    expect(t.flow.step.value).toBe('subwoofer');
  });

  it('skips a step that has one option, and Back retraces only the steps shown', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseModel('Cybertruck'); // one generation
    expect(t.flow.step.value).toBe('trim');
    expect(t.flow.generation.value).toBe('2023– (first generation)');
    click(button(t.view(), STR.actions.back));
    expect(t.flow.step.value).toBe('model');

    t.flow.chooseModel('Model Y L'); // one generation, one trim
    expect(t.flow.step.value).toBe('subwoofer');
    expect(t.settings.value.teslaId).toBe('modelyl-2025-awd');
    t.flow.back();
    expect(t.flow.step.value).toBe('model');
    expect(t.flow.canGoBack.value).toBe(false);
  });

  it('asks MCU1-era cars about the MCU2 retrofit; No explains and still lets the setup finish', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseModel('Model S');
    t.flow.chooseGeneration('2012–2016 (original, MCU1)');
    t.flow.chooseTrim('models-2012-85');
    expect(t.flow.step.value).toBe('retrofit');
    click(button(t.view(), STR.firstRun.retrofitYes));
    expect(t.settings.value.mcu2Retrofit).toBe(true);
    expect(t.flow.step.value).toBe('subwoofer');

    t.flow.back();
    expect(t.flow.step.value).toBe('retrofit');
    click(button(t.view(), STR.firstRun.retrofitNo));
    expect(t.settings.value.mcu2Retrofit).toBe(false);
    expect(t.flow.step.value).toBe('mcu1');
    expect(textOf(t.view())).toContain(STR.firstRun.mcu1Blocked);
    click(button(t.view(), STR.firstRun.continueAnyway));
    expect(t.flow.step.value).toBe('subwoofer');
  });

  it('does not ask MCU2-era and later cars about the retrofit', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseModel('Model S');
    t.flow.chooseGeneration('2018–2021 (MCU2)');
    t.flow.chooseTrim('models-2018-75d');
    expect(t.flow.step.value).toBe('subwoofer');
    expect(t.settings.value.mcu2Retrofit).toBeNull();
  });

  it('pre-selects the subwoofer best guess, labels it, and moves on to the bass sweep', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseModel('Model 3');
    t.flow.chooseGeneration(HIGHLAND);
    t.flow.chooseTrim(HIGHLAND_RWD);
    const v = t.view();
    const choices = findAll(v, byAttr('data-subwoofer'));
    expect(attrs(choices, 'data-subwoofer')).toEqual(['yes', 'no', 'unsure']);
    expect(attrs(choices, 'aria-pressed')).toEqual([false, true, false]);
    expect(choices.map((c) => textOf(c.children))).toEqual([
      STR.modes.subwoofer.yes,
      `${STR.modes.subwoofer.no}${STR.firstRun.bestGuess}`,
      STR.modes.subwoofer.unsure,
    ]);
    expect(textOf(v)).toContain('Model 3 · Highland (2023–) · RWD');
    click(only(v, byAttr('data-subwoofer', 'unsure')));
    expect(t.settings.value.subwoofer).toBe('unsure');
    expect(t.flow.step.value).toBe('bass');
  });

  it('ends with the acceleration mode (the quickest pre-selected) and opens the garage', () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.skipSweep();
    expect(t.flow.step.value).toBe('accel');
    const v = t.view();
    const modes = findAll(v, byAttr('data-mode'));
    expect(attrs(modes, 'data-mode')).toEqual(['Chill', 'Standard']);
    expect(attrs(modes, 'aria-pressed')).toEqual([false, true]);
    click(only(v, byAttr('data-mode', 'Chill')));
    expect(t.settings.value.accelMode).toBe('Chill');
    expect(t.screens).toEqual(['garage']);
  });

  it('skips the mode step for a car with a single mode', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseModel('Model S');
    t.flow.chooseGeneration('2012–2016 (original, MCU1)');
    t.flow.chooseTrim('models-2012-40'); // accelModes: Standard only
    t.flow.answerRetrofit(true);
    t.flow.chooseSubwoofer('no');
    t.flow.skipSweep();
    expect(t.screens).toEqual(['garage']);
    expect(t.settings.value).toMatchObject({ teslaId: 'models-2012-40', accelMode: null, mcu2Retrofit: true });
  });

  it('a whole first run leaves settings that no longer need the first run', () => {
    const t = harness();
    t.flow.ackNotices();
    toBass(t);
    t.flow.skipSweep();
    t.flow.chooseAccel('Standard');
    expect(t.settings.value).toMatchObject({ noticesSeen: true, teslaId: HIGHLAND_LR, subwoofer: 'no', accelMode: 'Standard' });
    expect(t.screens).toEqual(['garage']);
  });
});

describe('FirstRunFlow: not listed (spec §9.1, parked only)', () => {
  it('takes the 0–100 time, mass and body, starts at subwoofer not sure, and ends after the bass sweep', () => {
    const t = harness({ noticesSeen: true });
    click(only(t.view(), byAttr('data-model', 'not-listed')));
    expect(t.flow.step.value).toBe('notListed');
    input(only(t.view(), byAttr('name', 'zeroTo100')), '6.1');
    input(only(t.view(), byAttr('name', 'mass')), '1900');
    click(only(t.view(), byAttr('data-body', 'suv')));
    expect(submit(only(t.view(), byType('form')))).toBe(true); // never a page submit
    expect(t.settings.value).toMatchObject({
      teslaId: null,
      notListed: { zeroTo100S: 6.1, massKg: 1900, body: 'suv' },
      subwoofer: 'unsure',
      hpCornerHz: 40,
    });
    expect(t.flow.step.value).toBe('subwoofer');
    const v = t.view();
    expect(attrs(findAll(v, byAttr('data-subwoofer')), 'aria-pressed')).toEqual([false, false, true]);
    expect(textOf(v)).not.toContain(STR.firstRun.bestGuess);
    expect(textOf(v)).toContain('Not listed · 0–100 km/h in 6.1 s · 1900 kg · SUV');
    t.flow.chooseSubwoofer('unsure');
    t.flow.skipSweep();
    expect(t.screens).toEqual(['garage']); // no acceleration modes to choose from
  });

  it('refuses numbers outside the bounds and says which bounds', () => {
    const t = harness({ noticesSeen: true });
    t.flow.chooseNotListed();
    input(only(t.view(), byAttr('name', 'zeroTo100')), '0.9');
    input(only(t.view(), byAttr('name', 'mass')), '1900');
    submit(only(t.view(), byType('form')));
    expect(t.flow.step.value).toBe('notListed');
    expect(t.settings.value.notListed).toBeNull();
    const msg = STR.firstRun.notListedInvalid(NOT_LISTED_ZERO_TO_100_RANGE_S, NOT_LISTED_MASS_RANGE_KG);
    expect(textOf(t.view())).toContain(msg);
    input(only(t.view(), byAttr('name', 'zeroTo100')), '5');
    expect(textOf(t.view())).not.toContain(msg); // editing clears the message
  });

  it('is locked while moving: no form to open, and an open form takes no input', () => {
    const t = harness({ noticesSeen: true }, { parked: false });
    const nl = only(t.view(), byAttr('data-model', 'not-listed'));
    expect(isDisabled(nl)).toBe(true);
    expect(textOf(nl.children)).toContain(STR.parkedOnly);
    t.flow.chooseNotListed();
    expect(t.flow.step.value).toBe('model');

    t.parked.value = true;
    t.flow.chooseNotListed();
    input(only(t.view(), byAttr('name', 'zeroTo100')), '6');
    input(only(t.view(), byAttr('name', 'mass')), '2000');
    t.parked.value = false;
    const v = t.view();
    for (const el of findAll(v, byType('input'))) expect(isDisabled(el)).toBe(true);
    expect(isDisabled(button(v, STR.firstRun.continue))).toBe(true);
    t.flow.submitNotListed();
    expect(t.settings.value.notListed).toBeNull();
    expect(t.flow.step.value).toBe('notListed');
  });
});

describe('FirstRunFlow: re-run from Settings', () => {
  const CURRENT: Partial<Settings> = {
    noticesSeen: true,
    teslaId: HIGHLAND_LR,
    subwoofer: 'no',
    hpCornerHz: 50,
    accelMode: 'Chill',
  };

  it('starts at the model step with the current car marked; Cancel returns to Settings', () => {
    const t = harness(CURRENT);
    expect(t.flow.rerun).toBe(true);
    expect(t.flow.step.value).toBe('model');
    const v = t.view();
    expect(attrs(findAll(v, byAttr('aria-pressed', 'true')), 'data-model')).toEqual(['Model 3']);
    click(button(v, STR.firstRun.cancel));
    expect(t.screens).toEqual(['settings']);
  });

  it('the same car again keeps its answers, shown pre-selected; the end returns to Settings', () => {
    const t = harness(CURRENT);
    t.flow.chooseModel('Model 3');
    expect(attrs(findAll(t.view(), byAttr('aria-pressed', 'true')), 'data-generation')).toEqual([HIGHLAND]);
    t.flow.chooseGeneration(HIGHLAND);
    expect(attrs(findAll(t.view(), byAttr('aria-pressed', 'true')), 'data-tesla')).toEqual([HIGHLAND_LR]);
    t.flow.chooseTrim(HIGHLAND_LR);
    expect(t.settings.value).toMatchObject({ subwoofer: 'no', hpCornerHz: 50, accelMode: 'Chill' });
    const v = t.view();
    expect(attrs(findAll(v, byAttr('data-subwoofer')), 'aria-pressed')).toEqual([false, true, false]);
    expect(textOf(only(v, byAttr('data-subwoofer', 'yes')).children)).toContain(STR.firstRun.bestGuess);
    t.flow.chooseSubwoofer('no');
    expect(textOf(t.view())).toContain(STR.firstRun.bassCurrent(50));
    t.flow.skipSweep();
    expect(t.settings.value.hpCornerHz).toBe(50);
    expect(attrs(findAll(t.view(), byAttr('data-mode')), 'aria-pressed')).toEqual([true, false]);
    t.flow.chooseAccel('Chill');
    expect(t.screens).toEqual(['settings']);
  });

  it('another car starts from its own best guesses', () => {
    const t = harness(CURRENT);
    t.flow.chooseModel('Model 3');
    t.flow.chooseGeneration(HIGHLAND);
    t.flow.chooseTrim(HIGHLAND_RWD);
    expect(t.settings.value).toMatchObject({ teslaId: HIGHLAND_RWD, subwoofer: 'no', hpCornerHz: 40, accelMode: null });
  });

  it('Cancel puts the car and all its answers back as they were, in one update', () => {
    const t = harness(CURRENT);
    const before = t.settings.value;
    t.flow.chooseModel('Model 3');
    t.flow.chooseGeneration(HIGHLAND);
    t.flow.chooseTrim(HIGHLAND_RWD); // stored as it is given, with the RWD's own starting point
    t.flow.chooseSubwoofer('yes');
    expect(t.settings.value).toMatchObject({ teslaId: HIGHLAND_RWD, subwoofer: 'yes', hpCornerHz: 40, accelMode: null });
    t.patches.length = 0;
    click(button(t.view(), STR.firstRun.cancel));
    expect(t.settings.value).toEqual(before); // hpCornerHz 50 (a parked-only measurement) and Chill again
    expect(t.patches).toHaveLength(1); // one patch: the mode is validated against the original car
    expect(t.screens).toEqual(['settings']);
  });

  it('Cancel also undoes a car chosen in one tap, an MCU2 answer and a car that is not listed', () => {
    const oneTap = harness(CURRENT);
    const before = oneTap.settings.value;
    oneTap.flow.chooseModel('Model Y L'); // one generation, one trim: chosen and stored at once
    expect(oneTap.settings.value.teslaId).toBe('modelyl-2025-awd');
    oneTap.flow.cancel();
    expect(oneTap.settings.value).toEqual(before);

    const mcu1 = harness({ noticesSeen: true, teslaId: 'models-2012-85', mcu2Retrofit: true, subwoofer: 'yes' });
    const mcu1Before = mcu1.settings.value;
    mcu1.flow.chooseModel('Model S');
    mcu1.flow.chooseGeneration('2012–2016 (original, MCU1)');
    mcu1.flow.chooseTrim('models-2012-85'); // the same car: its answers are kept…
    mcu1.flow.answerRetrofit(false); // …and then changed
    mcu1.flow.cancel();
    expect(mcu1.settings.value).toEqual(mcu1Before);

    const listed = harness(CURRENT);
    const listedBefore = listed.settings.value;
    listed.flow.chooseNotListed();
    input(only(listed.view(), byAttr('name', 'zeroTo100')), '6.1');
    input(only(listed.view(), byAttr('name', 'mass')), '1900');
    submit(only(listed.view(), byType('form')));
    expect(listed.settings.value).toMatchObject({ teslaId: null, notListed: { zeroTo100S: 6.1, massKg: 1900 } });
    listed.flow.cancel();
    expect(listed.settings.value).toEqual(listedBefore);

    const nl = { zeroTo100S: 6.1, massKg: 1900, body: 'suv' } as const;
    const fromNotListed = harness({ noticesSeen: true, notListed: nl, subwoofer: 'no', hpCornerHz: 55 });
    const nlBefore = fromNotListed.settings.value;
    fromNotListed.flow.chooseModel('Cybertruck');
    fromNotListed.flow.chooseTrim('cybertruck-awd');
    expect(fromNotListed.settings.value).toMatchObject({ teslaId: 'cybertruck-awd', notListed: null });
    fromNotListed.flow.cancel();
    expect(fromNotListed.settings.value).toEqual(nlBefore);
  });

  it('Cancel mid-sweep ends the tone before the answers go back', async () => {
    vi.useFakeTimers();
    try {
      const t = harness(CURRENT);
      const before = t.settings.value;
      toBass(t, HIGHLAND_RWD);
      t.flow.playSweep();
      await vi.advanceTimersByTimeAsync(0);
      expect(tones(t.posted)).toEqual([30]);
      t.flow.cancel();
      expect(tones(t.posted)).toEqual([30, null]);
      expect(t.settings.value).toEqual(before);
      await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS * 10);
      expect(tones(t.posted)).toEqual([30, null]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FirstRunFlow: bass sweep (spec §9.3, parked only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the engine from the tap, then plays 30…60 Hz at −18 dB for 1.5 s each and ends the tone', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    let v = t.view();
    expect(findAll(v, byAttr('data-hz')).map(isDisabled)).toEqual([true, true, true, true, true, true]);
    click(button(v, STR.firstRun.playTones));
    expect(t.starts()).toBe(1); // synchronously, inside the tap
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([{ type: 'testTone', hz: 30, levelDb: BASS_SWEEP_LEVEL_DB }]);
    expect(t.flow.sweep.value).toEqual({ phase: 'playing', index: 0, heard: true });
    v = t.view();
    expect(only(v, byType('section')).props['data-step']).toBe('bass');
    expect(attrs(findAll(v, byAttr('aria-current', 'true')), 'data-hz')).toEqual([30]);
    // The playing step stands out (amber, the theme's one emphasised action); the status sits in the Play row.
    expect(attrs(findAll(v, byAttr('data-hz')), 'class')).toEqual(['btn-primary', undefined, undefined, undefined, undefined, undefined]);
    const status = only(v, byAttr('role', 'status'));
    expect(textOf(status)).toBe(STR.firstRun.playing(30, 1, 6));
    expect(findAll(v, (el) => el.children.includes(status)).flatMap((row) => findAll(row, byType('button'))).map((b) => textOf(b.children))).toEqual([
      STR.firstRun.playTones,
      STR.actions.skip,
    ]);
    for (let i = 1; i < BASS_SWEEP_HZ.length; i++) {
      await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS - 1);
      expect(tones(t.posted)).toEqual(BASS_SWEEP_HZ.slice(0, i));
      await vi.advanceTimersByTimeAsync(1);
      expect(tones(t.posted)).toEqual(BASS_SWEEP_HZ.slice(0, i + 1));
    }
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    expect(tones(t.posted)).toEqual([...BASS_SWEEP_HZ, null]);
    for (const m of t.posted) expect(m).toMatchObject({ type: 'testTone', levelDb: -18 });
    expect(t.flow.sweep.value).toEqual({ phase: 'done', index: null, heard: true });
    v = t.view();
    expect(findAll(v, byAttr('data-hz')).map(isDisabled)).toEqual([false, false, false, false, false, false]);
    expect(findAll(v, byAttr('aria-current', 'true'))).toEqual([]);
    expect(attrs(findAll(v, byAttr('data-hz')), 'class').every((c) => c === undefined)).toBe(true);
    expect(textOf(only(v, byAttr('role', 'status')))).toBe(STR.firstRun.bassCurrent(40));
    expect(buttonTexts(v)).toContain(STR.firstRun.playAgain);
    expect(t.starts()).toBe(1);
  });

  it('stores the tapped step as hpCornerHz, stops the tone and plays no further steps', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS * 3); // 45 Hz playing
    expect(tones(t.posted)).toEqual([30, 35, 40, 45]);
    click(only(t.view(), byAttr('data-hz', 45)));
    expect(t.settings.value.hpCornerHz).toBe(45);
    expect(tones(t.posted)).toEqual([30, 35, 40, 45, null]);
    expect(t.flow.step.value).toBe('accel');
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS * 10);
    expect(tones(t.posted)).toEqual([30, 35, 40, 45, null]);
  });

  it('takes a step only once the tones have played, and only a step of the sweep', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.pickCorner(45); // nothing heard yet
    expect(t.flow.step.value).toBe('bass');
    expect(t.settings.value.hpCornerHz).toBe(40);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    t.flow.pickCorner(33); // not a step
    expect(t.flow.step.value).toBe('bass');
    expect(t.settings.value.hpCornerHz).toBe(40);
    t.flow.pickCorner(60);
    expect(t.settings.value.hpCornerHz).toBe(60);
    expect(t.flow.step.value).toBe('accel');
  });

  it('Skip keeps the current corner (40 Hz on a first run) without any audio', () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    expect(textOf(t.view())).toContain(STR.firstRun.bassCurrent(40));
    click(button(t.view(), STR.actions.skip));
    expect(t.settings.value.hpCornerHz).toBe(40);
    expect(t.flow.step.value).toBe('accel');
    expect(t.starts()).toBe(0);
    expect(t.posted).toEqual([]);
  });

  it('plays only while parked', () => {
    const t = harness({ noticesSeen: true }, { parked: false });
    toBass(t);
    const v = t.view();
    expect(isDisabled(button(v, STR.firstRun.playTones))).toBe(true);
    expect(isDisabled(button(v, STR.actions.skip))).toBe(false);
    expect(textOf(v)).toContain(STR.parkedOnly);
    t.flow.playSweep();
    expect(t.starts()).toBe(0);
  });

  it('stops the tone when the car moves off mid-sweep', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    t.parked.value = false;
    expect(tones(t.posted)).toEqual([30, 35, null]);
    expect(t.flow.sweep.value).toEqual({ phase: 'failed', index: null, heard: true });
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS * 10);
    expect(tones(t.posted)).toEqual([30, 35, null]);
  });

  it('stops when the audio is interrupted mid-sweep, and Play again recovers from the tap', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    t.audio.value = { ...t.audio.peek(), state: 'interrupted' };
    expect(tones(t.posted)).toEqual([30, null]);
    expect(t.flow.sweep.value.phase).toBe('failed');
    expect(textOf(t.view())).toContain(STR.firstRun.toneFailed);
    t.audio.value = { ...t.audio.peek(), state: 'running' };
    click(button(t.view(), STR.firstRun.playAgain));
    expect(t.starts()).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(t.posted)).toEqual([30, null, 30]);
  });

  it('reports a start that failed and plays nothing', async () => {
    const t = harness({ noticesSeen: true }, { startOk: false });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]);
    expect(t.flow.sweep.value.phase).toBe('failed');
    expect(textOf(t.view())).toContain(STR.firstRun.toneFailed);
    expect(findAll(t.view(), byAttr('data-hz')).every(isDisabled)).toBe(true); // nothing was heard
  });

  it('a start that rejects ends in the failed state, not stuck starting', async () => {
    const t = harness({ noticesSeen: true }, { startRejects: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.flow.sweep.value.phase).toBe('failed');
    expect(t.posted).toEqual([]);
  });

  it('waits for the audio to run before the first tone, and gives up after AUDIO_START_WAIT_MS', async () => {
    const t = harness({ noticesSeen: true }, { manualStart: true });
    toBass(t);
    t.flow.playSweep();
    expect(t.flow.sweep.value.phase).toBe('starting');
    expect(isDisabled(button(t.view(), STR.firstRun.startingAudio))).toBe(true);
    t.flow.playSweep(); // a second tap while starting changes nothing
    expect(t.starts()).toBe(1);
    t.resolveStart(true); // started, but the context is not running yet
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted).toEqual([]);
    t.runInGear();
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(t.posted)).toEqual([30]);

    const late = harness({ noticesSeen: true }, { manualStart: true });
    toBass(late);
    late.flow.playSweep();
    late.resolveStart(true);
    await vi.advanceTimersByTimeAsync(AUDIO_START_WAIT_MS);
    expect(late.flow.sweep.value.phase).toBe('failed');
    late.runInGear();
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    expect(late.posted).toEqual([]);
  });

  it('holds the first tone until the engine is out of its crank, which the tier benchmark runs inside', async () => {
    const t = harness({ noticesSeen: true }, { cranks: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.audio.value.state).toBe('running');
    expect(t.posted).toEqual([]);
    expect(t.flow.sweep.value.phase).toBe('starting');
    expect(isDisabled(button(t.view(), STR.firstRun.startingAudio))).toBe(true); // still "Starting audio…"
    t.snapshot.value = snap(0, 4); // cranking; the benchmark renders the DSP 4× per quantum
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.posted).toEqual([]);
    t.snapshot.value = snap(1, 1); // in gear, one DSP pass again
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(t.posted)).toEqual([30]);
    expect(t.flow.sweep.value).toEqual({ phase: 'playing', index: 0, heard: true });
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    expect(tones(t.posted)).toEqual([30, 35]); // each step still lasts 1.5 s from the first tone
  });

  it('fails when the engine does not leave its crank in time, and at once when the audio stops meanwhile', async () => {
    const t = harness({ noticesSeen: true }, { cranks: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(ENGINE_SETTLE_WAIT_MS - 1);
    expect(t.flow.sweep.value.phase).toBe('starting');
    await vi.advanceTimersByTimeAsync(1);
    expect(t.flow.sweep.value.phase).toBe('failed');
    t.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    expect(t.posted).toEqual([]);

    const cut = harness({ noticesSeen: true }, { cranks: true });
    toBass(cut);
    cut.flow.playSweep();
    await vi.advanceTimersByTimeAsync(500);
    cut.audio.value = { ...cut.audio.peek(), state: 'interrupted' };
    await vi.advanceTimersByTimeAsync(0);
    expect(cut.flow.sweep.value.phase).toBe('failed');
    expect(textOf(cut.view())).toContain(STR.firstRun.toneFailed);
    expect(cut.posted).toEqual([]);
  });

  it('an engine already running in gear plays at once; one rebuilt from the tap waits for its crank', async () => {
    const t = harness({ noticesSeen: true }, { audio: 'running', cranks: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(t.posted)).toEqual([30]);

    const r = harness({ noticesSeen: true }, { audio: 'interrupted', cranks: true });
    r.snapshot.value = snap(3); // its last report before the interruption
    toBass(r);
    r.flow.playSweep(); // the shell recovers from the tap: a rebuilt engine cranks again
    await vi.advanceTimersByTimeAsync(0);
    expect(r.audio.value.state).toBe('running');
    expect(r.posted).toEqual([]); // the stored snapshot is from before the tap
    r.snapshot.value = snap(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.posted).toEqual([]);
    r.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(r.posted)).toEqual([30]);
  });

  it('a tap while playing does not restart the sweep', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(tones(t.posted)).toEqual([30, 35]);
    expect(t.starts()).toBe(1);
  });

  it('Back and leaving the screen stop the tone', async () => {
    const t = harness({ noticesSeen: true });
    toBass(t);
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    t.flow.back();
    expect(t.flow.step.value).toBe('subwoofer');
    expect(tones(t.posted)).toEqual([30, null]);

    t.flow.chooseSubwoofer('no');
    expect(t.flow.sweep.value).toEqual({ phase: 'idle', index: null, heard: false }); // a fresh sweep
    t.flow.playSweep();
    await vi.advanceTimersByTimeAsync(0);
    t.flow.dispose();
    expect(tones(t.posted)).toEqual([30, null, 30, null]);
    await vi.advanceTimersByTimeAsync(BASS_SWEEP_STEP_MS * 10);
    t.parked.value = false;
    expect(tones(t.posted)).toEqual([30, null, 30, null]);
  });
});
