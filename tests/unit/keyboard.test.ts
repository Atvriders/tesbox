import { beforeEach, describe, expect, it } from 'vitest';
import { attachKeyboard, type KeyboardHandlers } from '../../src/input/keyboard';

type Listener = (e: unknown) => void;

/** window stand-in: just the listener registry attachKeyboard uses. */
class FakeWindow {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(e: { type: string }): void {
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
  }
}

/** The KeyboardEvent fields a key handler can read, as Chromium fills them on a US layout. */
class FakeKeyEvent {
  defaultPrevented = false;
  repeat = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  shiftKey = false;
  isComposing = false;
  target: object | null = { tagName: 'BODY', isContentEditable: false };

  constructor(
    readonly type: 'keydown' | 'keyup',
    readonly code: string,
    readonly key: string,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

const KEYS = {
  E: ['KeyE', 'e'],
  Q: ['KeyQ', 'q'],
  V: ['KeyV', 'v'],
  P: ['KeyP', 'p'],
  W: ['KeyW', 'w'],
  S: ['KeyS', 's'],
  Space: ['Space', ' '],
  A: ['KeyA', 'a'],
} as const;
type KeyName = keyof typeof KEYS;

let win: FakeWindow;
let calls: string[];
let keyboardSource: boolean;
let detach: () => void;

const handlers: KeyboardHandlers = {
  shift: (dir) => calls.push(`shift ${dir}`),
  cycleValve: () => calls.push('valve'),
  togglePerspective: () => calls.push('perspective'),
  pedal: (throttle, brake) => calls.push(`pedal ${throttle} ${brake}`),
  keyboardSource: () => keyboardSource,
};

function send(type: 'keydown' | 'keyup', name: KeyName, over: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  const [code, key] = KEYS[name];
  const e = Object.assign(new FakeKeyEvent(type, code, key), over);
  win.dispatch(e);
  return e;
}
const down = (name: KeyName, over: Partial<FakeKeyEvent> = {}): FakeKeyEvent => send('keydown', name, over);
const up = (name: KeyName, over: Partial<FakeKeyEvent> = {}): FakeKeyEvent => send('keyup', name, over);
function raw(type: 'keydown' | 'keyup', code: string, key: string): FakeKeyEvent {
  const e = new FakeKeyEvent(type, code, key);
  win.dispatch(e);
  return e;
}

beforeEach(() => {
  win = new FakeWindow();
  calls = [];
  keyboardSource = false;
  detach = attachKeyboard(win as unknown as Window, handlers);
});

describe('attachKeyboard — shifts, valves, perspective (any source)', () => {
  it.each([false, true])('E shifts up and Q shifts down (keyboard source selected: %s)', (selected) => {
    keyboardSource = selected;
    down('E');
    up('E');
    down('Q');
    up('Q');
    down('E');
    expect(calls).toEqual(['shift 1', 'shift -1', 'shift 1']);
  });

  it('V cycles the valves and P toggles the perspective in every source', () => {
    down('V');
    down('P');
    keyboardSource = true;
    down('V');
    down('P');
    expect(calls).toEqual(['valve', 'perspective', 'valve', 'perspective']);
  });

  it('ignores auto-repeat of E, Q, V and P (a held key acts once)', () => {
    down('E');
    down('E', { repeat: true });
    down('E', { repeat: true });
    down('Q', { repeat: true });
    down('V', { repeat: true });
    down('P', { repeat: true });
    expect(calls).toEqual(['shift 1']);
  });

  it('still acts with Shift held, but not with Ctrl, Meta or Alt (browser shortcuts)', () => {
    down('E', { shiftKey: true });
    const ctrl = down('Q', { ctrlKey: true });
    down('P', { metaKey: true });
    down('V', { altKey: true });
    expect(calls).toEqual(['shift 1']);
    expect(ctrl.defaultPrevented).toBe(false);
  });

  it('ignores keys typed into text fields and editable content, and IME composition', () => {
    for (const target of [
      { tagName: 'INPUT', isContentEditable: false },
      { tagName: 'TEXTAREA', isContentEditable: false },
      { tagName: 'SELECT', isContentEditable: false },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      down('E', { target });
      down('P', { target });
    }
    down('Q', { isComposing: true });
    expect(calls).toEqual([]);
    down('E', { target: { tagName: 'BUTTON', isContentEditable: false } });
    expect(calls).toEqual(['shift 1']);
  });

  it('acts on the physical key position, falling back to the key value when the code is missing', () => {
    raw('keydown', 'KeyQ', 'a'); // AZERTY: the key in the QWERTY "Q" position downshifts
    raw('keydown', 'KeyA', 'q'); // …and the key labelled Q elsewhere does nothing
    raw('keydown', '', 'E'); // no code (synthetic / virtual keyboard): use the key value, any case
    raw('keydown', 'Unidentified', 'p');
    expect(calls).toEqual(['shift -1', 'shift 1', 'perspective']);
  });

  it('unknown codes and key values do nothing, including object-property names', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(raw('keydown', name, '').defaultPrevented).toBe(false);
      expect(raw('keydown', '', name).defaultPrevented).toBe(false);
    }
    raw('keydown', 'Digit1', '1');
    expect(calls).toEqual([]);
  });

  it('prevents the default action of the keys it handles, and only those', () => {
    expect(down('E').defaultPrevented).toBe(true);
    expect(down('V').defaultPrevented).toBe(true);
    expect(down('A').defaultPrevented).toBe(false);
    expect(down('E', { target: { tagName: 'INPUT', isContentEditable: false } }).defaultPrevented).toBe(false);
  });
});

describe('attachKeyboard — pedals (keyboard source only)', () => {
  it('W, S and Space do nothing and keep their default action unless the keyboard source is selected', () => {
    const w = down('W');
    const space = down('Space');
    down('S');
    up('W');
    up('Space');
    up('S');
    expect(calls).toEqual([]);
    expect(w.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false); // e.g. Space still activates a focused button
  });

  it('W holds full throttle until released', () => {
    keyboardSource = true;
    const w = down('W');
    expect(calls).toEqual(['pedal 1 0']);
    expect(w.defaultPrevented).toBe(true);
    up('W');
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0']);
  });

  it('S brakes at half, Space brakes fully, and braking overrides the throttle', () => {
    keyboardSource = true;
    down('W');
    down('S');
    down('Space');
    up('Space');
    up('S');
    up('W');
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0.5', 'pedal 0 1', 'pedal 0 0.5', 'pedal 1 0', 'pedal 0 0']);
  });

  it('auto-repeat of a held pedal key sends nothing new but still blocks the default (no page scroll)', () => {
    keyboardSource = true;
    down('Space');
    const repeat = down('Space', { repeat: true });
    down('W', { repeat: true }); // W held too (its first keydown arrived as a repeat): Space still overrides
    expect(calls).toEqual(['pedal 0 1']);
    expect(repeat.defaultPrevented).toBe(true);
    up('Space');
    expect(calls).toEqual(['pedal 0 1', 'pedal 1 0']);
  });

  it('releasing a pedal key after the source changed still releases the pedal', () => {
    keyboardSource = true;
    down('W');
    keyboardSource = false;
    up('W');
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0']);
  });

  it('a release without a press seen here sends nothing', () => {
    down('W'); // pressed while another source was selected: not tracked
    keyboardSource = true;
    up('W');
    up('S');
    expect(calls).toEqual([]);
  });

  it('Ctrl+W never presses the throttle, but a held W released with Ctrl down is released', () => {
    keyboardSource = true;
    down('W', { ctrlKey: true });
    expect(calls).toEqual([]);
    down('W');
    up('W', { ctrlKey: true });
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0']);
  });

  it('pedal keys typed into a text field are ignored', () => {
    keyboardSource = true;
    down('W', { target: { tagName: 'INPUT', isContentEditable: false } });
    down('Space', { target: { tagName: 'TEXTAREA', isContentEditable: false } });
    expect(calls).toEqual([]);
  });

  it('losing window focus releases every held pedal key, once', () => {
    keyboardSource = true;
    down('W');
    down('S');
    win.dispatch({ type: 'blur' });
    win.dispatch({ type: 'blur' });
    up('W'); // the keyup arrives after focus returns: already released
    up('S');
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0.5', 'pedal 0 0']);
  });
});

describe('attachKeyboard — detach', () => {
  it('removes every listener and releases held pedals', () => {
    keyboardSource = true;
    down('W');
    detach();
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0']);
    for (const type of ['keydown', 'keyup', 'blur']) expect(win.count(type)).toBe(0);
    down('E');
    up('W');
    expect(calls).toEqual(['pedal 1 0', 'pedal 0 0']);
  });

  it('sends no pedal message when nothing was held', () => {
    keyboardSource = true;
    down('E');
    detach();
    expect(calls).toEqual(['shift 1']);
  });
});
