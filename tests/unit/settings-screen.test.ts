import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../../src/app/settings';
import type { MediaAction } from '../../src/audio/engine-audio';
import { TESLAS } from '../../src/data/catalogue';
import type { WheelTestState } from '../../src/input/media-shift';
import { InputLog } from '../../src/ui/diagnostics';
import {
  SettingsHeader,
  accelChoice,
  bassSummary,
  resetPatch,
  runWheelTest,
  stepLatency,
  stepTrim,
  tierMessage,
  wheelTestPatch,
  type SettingsHeaderProps,
} from '../../src/ui/settings-screen';
import { STR } from '../../src/ui/strings';
import { button, buttonTexts, click, isDisabled, renderTree } from './helpers/vnode-tree';

const RECORD = TESLAS.find((r) => r.id === 'model3-highland-lr-awd');
if (RECORD === undefined) throw new Error('fixture record missing');

function settingsWith(over: Partial<Settings> = {}): Settings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: RECORD?.id ?? null, noticesSeen: true, ...over });
}

// ───────────────────────────── steppers ─────────────────────────────

describe('stepTrim — volume trim buttons', () => {
  it('steps whole decibels inside −24 … +6 dB', () => {
    expect(stepTrim(0, 1)).toBe(1);
    expect(stepTrim(-3, -1)).toBe(-4);
    expect(stepTrim(6, 1)).toBe(6);
    expect(stepTrim(-24, -1)).toBe(-24);
  });

  it('snaps a fractional trim to whole decibels', () => {
    expect(stepTrim(-2.4, 1)).toBe(-1);
    expect(stepTrim(5.6, 1)).toBe(6);
  });
});

describe('stepLatency — GPS latency buttons', () => {
  it('steps 0.1 s inside 0 … 2.5 s without float drift', () => {
    expect(stepLatency(1, 0.1)).toBe(1.1);
    expect(stepLatency(0.3, -0.1)).toBe(0.2);
    expect(stepLatency(2.5, 0.1)).toBe(2.5);
    expect(stepLatency(0, -0.1)).toBe(0);
    expect(stepLatency(0.7, 0.1)).toBe(0.8); // 0.7 + 0.1 = 0.7999999999999999 in binary
  });
});

// ───────────────────────────── reset and results ─────────────────────────────

describe('resetPatch — Reset all', () => {
  it('returns every preference to its default', () => {
    const custom = settingsWith({
      engineId: 'v8-na-50',
      volumeTrimDb: -9,
      units: 'kmh',
      source: 'demo',
      gamepadSwap: true,
      wheelShift: { tested: true, works: true, enabled: true },
      manualWarningSeen: true,
    });
    const r = resetPatch(custom);
    expect(r.teslaId).toBeNull();
    expect(r.noticesSeen).toBe(false);
    expect(r.engineId).toBe('i5-turbo-25');
    expect(r.volumeTrimDb).toBe(0);
    expect(r.units).toBe('mph');
    expect(r.source).toBe('gps');
    expect(r.gamepadSwap).toBe(false);
    expect(r.wheelShift).toEqual({ tested: false, works: false, enabled: false });
    expect(r.manualWarningSeen).toBe(false);
  });

  it('keeps the engine state that is not a preference: warm-start time and Lite next start', () => {
    const r = resetPatch(settingsWith({ engineWarmAt: 1_760_000_000_000, liteNextStart: true }));
    expect(r.engineWarmAt).toBe(1_760_000_000_000);
    expect(r.liteNextStart).toBe(true);
  });
});

describe('wheelTestPatch', () => {
  it('stores a passing test as tested + works + enabled, a failing one as tested only', () => {
    expect(wheelTestPatch(true)).toEqual({ wheelShift: { tested: true, works: true, enabled: true } });
    expect(wheelTestPatch(false)).toEqual({ wheelShift: { tested: true, works: false, enabled: false } });
  });
});

describe('tierMessage — Quality applied live (spec §5.7: forced behind a fade)', () => {
  it('posts a forced tier while the engine is on', () => {
    expect(tierMessage('lite', 'running')).toEqual({ type: 'tier', value: 'lite' });
    expect(tierMessage('full', 'interrupted')).toEqual({ type: 'tier', value: 'full' });
    expect(tierMessage('full', 'starting')).toEqual({ type: 'tier', value: 'full' });
  });

  it('posts nothing for Auto (decided at the next start) or with the engine off', () => {
    expect(tierMessage('auto', 'running')).toBeNull();
    expect(tierMessage('lite', 'off')).toBeNull();
    expect(tierMessage('full', 'error')).toBeNull();
  });
});

// ───────────────────────────── summaries ─────────────────────────────

describe('accelChoice', () => {
  it("offers the record's modes with the quickest selected by default", () => {
    const names = RECORD?.accelModes.map((m) => m.name) ?? [];
    const quickest = names[names.length - 1];
    expect(accelChoice(RECORD ?? null, null)).toEqual({ options: names, selected: quickest });
    expect(accelChoice(RECORD ?? null, names[0] ?? null).selected).toBe(names[0]);
  });

  it('has nothing to offer without a catalogue record', () => {
    expect(accelChoice(null, null)).toEqual({ options: [], selected: null });
  });
});

describe('bassSummary', () => {
  it('shows the high-pass corner without a subwoofer and full range with one', () => {
    expect(bassSummary(settingsWith({ subwoofer: 'no', hpCornerHz: 45 }))).toBe('High-pass at 45 Hz');
    expect(bassSummary(settingsWith({ subwoofer: 'unsure', hpCornerHz: 40 }))).toBe('High-pass at 40 Hz');
    expect(bassSummary(settingsWith({ subwoofer: 'yes', hpCornerHz: 50 }))).toBe('Full range (subwoofer)');
  });
});

// ───────────────────────────── header ─────────────────────────────

describe('SettingsHeader — the whole screen is read-only unless parked', () => {
  function header(over: Partial<SettingsHeaderProps> = {}): { tree: ReturnType<typeof renderTree>; calls: string[] } {
    const calls: string[] = [];
    const props: SettingsHeaderProps = {
      engineOn: true,
      parked: true,
      onStop: () => void calls.push('stop'),
      onDiagnostics: () => void calls.push('diagnostics'),
      onDrive: () => void calls.push('drive'),
      ...over,
    };
    return { tree: renderTree(h(SettingsHeader, props)), calls };
  }

  it('offers Stop engine only while the engine is on', () => {
    expect(buttonTexts(header().tree)).toEqual([STR.actions.stopEngine, STR.actions.diagnostics, STR.actions.drive]);
    expect(buttonTexts(header({ engineOn: false }).tree)).toEqual([STR.actions.diagnostics, STR.actions.drive]);
  });

  it('stops the engine when parked', () => {
    const { tree, calls } = header();
    click(button(tree, STR.actions.stopEngine));
    expect(calls).toEqual(['stop']);
  });

  it('locks Stop engine while moving; Diagnostics and Drive only navigate and stay open', () => {
    const { tree, calls } = header({ parked: false });
    expect(isDisabled(button(tree, STR.actions.stopEngine))).toBe(true);
    click(button(tree, STR.actions.diagnostics));
    click(button(tree, STR.actions.drive));
    expect(calls).toEqual(['diagnostics', 'drive']);
  });
});

// ───────────────────────────── steering-wheel test ─────────────────────────────

type Listener = (e: unknown) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  key(code: string, repeat = false): void {
    for (const fn of [...(this.listeners.get('keydown') ?? [])]) fn({ type: 'keydown', code, key: code, repeat });
  }
}

interface WheelHarness {
  win: FakeTarget;
  media: Set<(a: MediaAction) => void>;
  updates: [WheelTestState, number][];
  done: boolean[];
  log: InputLog;
  cancel: () => void;
  action(a: MediaAction): void;
}

function startWheel(): WheelHarness {
  const h = { win: new FakeTarget(), media: new Set(), updates: [], done: [], log: new InputLog() } as unknown as WheelHarness;
  h.cancel = runWheelTest({
    onMediaAction: (l) => {
      h.media.add(l);
      return () => h.media.delete(l);
    },
    keyTarget: h.win as unknown as Parameters<typeof runWheelTest>[0]['keyTarget'],
    now: () => Date.now(),
    onUpdate: (state, remainingS) => h.updates.push([state, remainingS]),
    onDone: (works) => h.done.push(works),
    log: h.log,
  });
  h.action = (a) => {
    for (const l of [...h.media]) l(a);
  };
  return h;
}

describe('runWheelTest — Settings → Test steering-wheel shifting (spec §7.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a right tilt, then a left tilt, and passes when both arrive', () => {
    const h = startWheel();
    expect(h.updates[0]).toEqual(['waitRight', 10]);
    vi.advanceTimersByTime(3000);
    h.action('nexttrack');
    expect(h.updates.at(-1)?.[0]).toBe('waitLeft');
    vi.advanceTimersByTime(2000);
    h.action('previoustrack');
    expect(h.done).toEqual([true]);
    expect(h.log.entries().map((e) => `${e.source} ${e.detail}`)).toEqual([
      'media nexttrack: wheel test',
      'media previoustrack: wheel test',
    ]);
  });

  it('accepts the MediaTrack keys too, ignoring held-key repeats', () => {
    const h = startWheel();
    h.win.key('MediaTrackNext');
    h.win.key('MediaTrackPrevious', true);
    expect(h.done).toEqual([]);
    h.win.key('MediaTrackPrevious');
    expect(h.done).toEqual([true]);
  });

  it('ignores the wrong direction and presses', () => {
    const h = startWheel();
    h.action('previoustrack');
    h.action('play');
    h.action('pause');
    expect(h.updates.at(-1)?.[0]).toBe('waitRight');
    expect(h.done).toEqual([]);
  });

  it('fails when a tilt does not come within 10 s, counting the seconds down', () => {
    const h = startWheel();
    vi.advanceTimersByTime(4000);
    expect(h.updates.at(-1)).toEqual(['waitRight', 6]);
    vi.advanceTimersByTime(6500);
    expect(h.done).toEqual([false]);
  });

  it('cleans up when done: no listeners, no timer, no second result', () => {
    const h = startWheel();
    h.action('nexttrack');
    h.action('previoustrack');
    const updates = h.updates.length;
    vi.advanceTimersByTime(30_000);
    h.action('nexttrack');
    expect(h.done).toEqual([true]);
    expect(h.updates).toHaveLength(updates);
    expect(h.media.size).toBe(0);
    expect(h.win.count()).toBe(0);
  });

  it('can be cancelled without a result', () => {
    const h = startWheel();
    h.cancel();
    vi.advanceTimersByTime(30_000);
    h.action('nexttrack');
    expect(h.done).toEqual([]);
    expect(h.media.size).toBe(0);
    expect(h.win.count()).toBe(0);
  });
});
