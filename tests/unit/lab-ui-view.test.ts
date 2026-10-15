/**
 * src/lab/ui/view.tsx (phase-2c contract L3): the Sound Lab page rendered in Node (hook-free views,
 * tests/unit/helpers/vnode-tree.ts) over a real LabModel with a fake audio port.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGINES, getEngine } from '../../src/data/engines';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import { APPLY_DEBOUNCE_MS, LabModel, type LabAudioEvents, type LabAudioPort } from '../../src/lab/ui/model';
import type { MainToLab, MeterMsg } from '../../src/lab/ui/protocol';
import { LAB_STR } from '../../src/lab/ui/strings';
import { LabView } from '../../src/lab/ui/view';
import { button, byAttr, byType, click, findAll, input, isDisabled, only, renderTree, textOf, type HostNode } from './helpers/vnode-tree';

class FakeAudio implements LabAudioPort {
  sampleRate: number | null = null;
  readonly posted: MainToLab[] = [];
  events: LabAudioEvents | null = null;
  start(initial: () => readonly MainToLab[], events: LabAudioEvents): Promise<void> {
    initial();
    this.events = events;
    this.sampleRate = 48000;
    events.onState('running');
    events.onMessage({ type: 'ready' });
    return Promise.resolve();
  }
  post(msg: MainToLab): void {
    this.posted.push(msg);
  }
  loadReference() {
    return Promise.resolve({ durationS: 1, sampleRate: 48000, channels: 1, rms: 0.1 });
  }
  setAb(): void {}
  setLevels(): void {}
}

function setup(engineId?: string) {
  const audio = new FakeAudio();
  const model = new LabModel({ audio, saveFile: () => undefined, copyText: () => Promise.resolve() }, engineId);
  const view = () => renderTree(h(LabView, { model }));
  return { audio, model, view };
}

/** The section (panel) whose heading text is `title`. */
function panel(tree: ReturnType<typeof renderTree>, title: string): HostNode {
  return only(
    tree,
    (el) => el.type === 'section' && findAll(el.children, (x) => x.type === 'h2' && textOf(x.children) === title).length === 1,
    `panel "${title}"`,
  );
}

function fieldset(section: HostNode, legend: string): HostNode {
  return only(
    section.children,
    (el) => el.type === 'fieldset' && findAll(el.children, (x) => x.type === 'legend' && textOf(x.children) === legend).length === 1,
    `fieldset "${legend}"`,
  );
}

function inputs(n: HostNode, type: string): HostNode[] {
  return findAll(n.children, (el) => el.type === 'input' && el.props.type === type);
}

function byLabel(tree: ReturnType<typeof renderTree>, label: string): HostNode {
  return only(tree, byAttr('aria-label', label), `aria-label "${label}"`);
}

/** Calls an element's onChange like a committed edit (Enter or focus leaving a number box). */
function change(el: HostNode, value: string): void {
  const handler = el.props.onChange;
  if (typeof handler !== 'function') throw new Error(`${el.type} has no onChange`);
  (handler as (e: unknown) => void)({ currentTarget: { value }, target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('header', () => {
  it('lists the 15 engines in their four sets, each with its inspired-by subtitle', () => {
    const { view } = setup();
    const tree = view();
    const select = only(tree, (el) => el.type === 'select' && el.props.id === 'engine', 'engine select');
    expect(findAll(select.children, byType('optgroup')).map((g) => g.props.label)).toEqual(['Euro', 'JDM', 'American', 'Exotic']);
    const options = findAll(select.children, byType('option'));
    expect(options).toHaveLength(15);
    expect(options.map((o) => textOf(o.children)).sort()).toEqual(ENGINES.map((e) => `${e.name} (inspired by ${e.inspiredBy})`).sort());
    const first = ENGINES[0];
    expect(textOf(tree)).toContain(`inspired by ${first?.inspiredBy ?? ''}`);
  });

  it('switches the engine from the selector', () => {
    const { model, view } = setup();
    const select = only(view(), (el) => el.type === 'select' && el.props.id === 'engine');
    (select.props.onChange as (e: unknown) => void)({ currentTarget: { value: 'v8-na-50' } });
    expect(model.engineId.value).toBe('v8-na-50');
  });

  it('offers perspective, tier and bass as radio groups', () => {
    const { model, view } = setup();
    const radios = findAll(view(), (el) => el.type === 'input' && el.props.type === 'radio');
    expect(radios.map((r) => `${String(r.props.name)}:${String(r.props.value)}`)).toEqual([
      'perspective:cabin',
      'perspective:outside',
      'tier:full',
      'tier:lite',
      'bass:no-sub',
      'bass:sub',
    ]);
    const outside = radios[1] as HostNode;
    (outside.props.onChange as () => void)();
    expect(model.drive.value.manual.perspective).toBe('outside');
  });
});

describe('voicing panel', () => {
  it('has one fieldset per voicing group, a slider and a number box per number, from the schema', () => {
    const v8 = getEngine('v8-na-50');
    const { view } = setup(v8.id);
    const section = panel(view(), LAB_STR.voicing.title);
    const legends = findAll(section.children, byType('legend')).map((l) => textOf(l.children));
    expect(legends).toEqual(['pulse', 'headersM', 'collectors', 'turbine', 'exhaust', 'intake', 'forcedInduction', 'mechanical', 'overrun', 'cabin', 'general']);
    const headers = fieldset(section, 'headersM');
    expect(inputs(headers, 'range')).toHaveLength(8);
    expect(inputs(headers, 'number')).toHaveLength(8);
    const alphaSlider = byLabel(view(), 'pulse.alpha slider');
    expect([alphaSlider.props.min, alphaSlider.props.max]).toEqual([3, 20]);
  });

  it('shows a nullable object that is absent without controls', () => {
    const { view } = setup('v8-na-50');
    const section = panel(view(), LAB_STR.voicing.title);
    const turbine = fieldset(section, 'turbine');
    expect(findAll(turbine.children, byType('input'))).toHaveLength(0);
    expect(textOf(turbine.children)).toContain(LAB_STR.voicing.absent);
  });

  it('shows estimated as a disabled checkbox; other booleans are editable', () => {
    const { model, view } = setup();
    const estimated = byLabel(view(), 'estimated');
    expect([estimated.props.type, isDisabled(estimated)]).toEqual(['checkbox', true]);
    const fitted = byLabel(view(), 'exhaust.valve.fitted');
    expect(isDisabled(fitted)).toBe(false);
    (fitted.props.onChange as (e: unknown) => void)({ currentTarget: { checked: false } });
    expect(model.draft.value.exhaust.valve.fitted).toBe(false);
  });

  it('sends slider moves live, a number box on commit (Enter / leaving it), and select edits to the draft', () => {
    const { model, view } = setup('i5-turbo-25');
    change(byLabel(view(), 'pulse.alpha'), '12');
    expect(model.draft.value.pulse.alpha).toBe(12);
    input(byLabel(view(), 'pulse.alpha slider'), '13.5');
    expect(model.draft.value.pulse.alpha).toBe(13.5);
    change(byLabel(view(), 'pulse.alpha'), ''); // a cleared box changes nothing
    expect(model.draft.value.pulse.alpha).toBe(13.5);
    expect(byLabel(view(), 'pulse.alpha').props.onInput).toBeUndefined(); // typing alone applies nothing
    const lift = byLabel(view(), 'forcedInduction.lift');
    (lift.props.onChange as (e: unknown) => void)({ currentTarget: { value: 'flutter' } });
    expect(model.draft.value.forcedInduction?.lift).toBe('flutter');
  });

  it('leaves a number box alone while it is being typed in', () => {
    const { model, view } = setup();
    expect(byLabel(view(), 'pulse.alpha').props.value).toBe(String(model.draft.value.pulse.alpha));
    model.editing.value = 'pulse.alpha';
    const box = byLabel(view(), 'pulse.alpha');
    expect('value' in box.props).toBe(false);
    expect(box.props.defaultValue).toBe(String(model.draft.value.pulse.alpha));
  });

  it('flags a voicing the core would refuse: the reason, and the field', () => {
    const { model, view } = setup();
    model.editField(['headersM', 0], 2);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    const tree = view();
    const alert = only(tree, byAttr('role', 'alert'));
    expect(textOf(alert.children)).toContain('headersM[0] = 2 m is outside');
    expect(only(tree, byAttr('data-key', 'headersM[0]')).props['data-invalid']).toBe('true');
    expect(textOf(tree)).toContain(LAB_STR.voicing.state.flagged);
  });

  it('resets to the default voicing and back to the engine', () => {
    const { model, view } = setup();
    click(button(view(), LAB_STR.voicing.resetDefault));
    expect(model.draft.value).toEqual(defaultVoicing(model.engine.value.spec));
    model.editField(['cabin', 'lowpassHz'], 999);
    click(button(view(), LAB_STR.voicing.resetEngine));
    expect(model.draft.value).toEqual(model.engine.value.voicing);
  });
});

describe('drive and meter', () => {
  it('events, segments and Match level wait for running audio', async () => {
    const { model, view } = setup();
    const names = [LAB_STR.drive.upshift, LAB_STR.drive.downshift, LAB_STR.drive.liftoff, LAB_STR.drive.limiter, LAB_STR.drive.ignition, LAB_STR.drive.play];
    for (const n of names) expect(isDisabled(button(view(), n)), n).toBe(true);
    await model.start();
    for (const n of names) expect(isDisabled(button(view(), n)), n).toBe(false);
    click(button(view(), LAB_STR.drive.upshift));
    expect(model.drive.value.manual.gear).toBe(2);
  });

  it('the RPM and load boxes commit a typed value whole; their sliders move live', () => {
    const { model, view } = setup();
    expect(byLabel(view(), LAB_STR.drive.rpm).props.onInput).toBeUndefined(); // "3" of "3000" is never clamped to idle
    change(byLabel(view(), LAB_STR.drive.rpm), '3000');
    expect(model.drive.value.manual.rpm).toBe(3000);
    input(byLabel(view(), `${LAB_STR.drive.load} slider`), '0.4');
    expect(model.drive.value.manual.load).toBe(0.4);
    change(byLabel(view(), LAB_STR.drive.load), '-0.25');
    expect(model.drive.value.manual.load).toBe(-0.25);
  });

  it('a committed RPM beyond the limiter shows the clamped value in the box that is still focused', () => {
    const { model, view } = setup();
    const limiter = model.engine.value.spec.rpm.limiter.rpm;
    const box = byLabel(view(), LAB_STR.drive.rpm);
    const event = { currentTarget: { value: '99999' } };
    (box.props.onChange as (e: unknown) => void)(event);
    expect(model.drive.value.manual.rpm).toBe(limiter);
    expect(event.currentTarget.value).toBe(String(limiter));
  });

  it('shows the latest meter reading', async () => {
    const { audio, model, view } = setup();
    await model.start();
    const m: MeterMsg = { type: 'meter', rmsDb: -23.4, peakDb: -9.1, rpm: 4512, gear: 3, limiter: true, boost: 0.5, limiterGrDb: 1.25, nonFiniteResets: 0 };
    audio.events?.onMessage(m);
    const meter = panel(view(), LAB_STR.meter.title);
    expect(meter.props['data-rms-db']).toBe('-23.4');
    expect(meter.props['data-rpm']).toBe('4512');
    expect(textOf(byLabel(view(), LAB_STR.meter.gear).children)).toBe('3');
    expect(textOf(meter.children)).toContain('4512');
  });
});
