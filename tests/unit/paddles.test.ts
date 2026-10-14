import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPaddle, PADDLE_CLASS, PADDLE_FLASH_CLASS } from '../../src/input/paddles';

type Listener = (e: unknown) => void;

/** The slice of HTMLElement that bindPaddle touches: classList and event listeners. */
class FakeElement {
  private readonly classes: Set<string>;
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly classList = {
    add: (...names: string[]): void => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]): void => names.forEach((n) => this.classes.delete(n)),
    contains: (name: string): boolean => this.classes.has(name),
  };

  constructor(initial: string[] = []) {
    this.classes = new Set(initial);
  }

  get el(): HTMLElement {
    return this as unknown as HTMLElement;
  }

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

  dispatch(type: string, init: object = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...init });
  }
}

/** A touch contact as Chromium reports it on pointerdown (primary button 0, buttons bitmask 1). */
function touch(over: object = {}): object {
  return { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, ...over };
}

let shifts: number[];
const record = (dir: 1 | -1): void => {
  shifts.push(dir);
};

beforeEach(() => {
  vi.useFakeTimers();
  shifts = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bindPaddle — shifting', () => {
  it('shifts in its own direction on every pointerdown', () => {
    const plus = new FakeElement();
    const minus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    bindPaddle(minus.el, -1, record);
    plus.dispatch('pointerdown', touch());
    plus.dispatch('pointerdown', touch());
    minus.dispatch('pointerdown', touch());
    expect(shifts).toEqual([1, 1, -1]);
  });

  it('fires on pointerdown only: click, pointerup, mousedown and touchstart do not shift', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    for (const type of ['click', 'pointerup', 'mousedown', 'touchstart']) plus.dispatch(type, touch());
    expect(shifts).toEqual([]);
    expect(plus.count('click')).toBe(0);
  });

  it('counts a second finger (non-primary pointer) and primary-button mouse and pen presses', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    plus.dispatch('pointerdown', touch({ pointerId: 2, isPrimary: false }));
    plus.dispatch('pointerdown', touch({ pointerType: 'mouse' }));
    plus.dispatch('pointerdown', touch({ pointerType: 'pen' }));
    expect(shifts).toEqual([1, 1, 1]);
  });

  it('ignores the middle and secondary mouse buttons', () => {
    const minus = new FakeElement();
    bindPaddle(minus.el, -1, record);
    minus.dispatch('pointerdown', touch({ pointerType: 'mouse', button: 1, buttons: 4 }));
    minus.dispatch('pointerdown', touch({ pointerType: 'mouse', button: 2, buttons: 2 }));
    expect(shifts).toEqual([]);
  });
});

describe('bindPaddle — classes', () => {
  it('adds the paddle class (touch-action: manipulation lives in the stylesheet) when bound', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    expect(plus.classList.contains(PADDLE_CLASS)).toBe(true);
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(false);
  });

  it('flashes for 150 ms after a press', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    plus.dispatch('pointerdown', touch());
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(149);
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(false);
  });

  it('a press during a flash restarts the 150 ms window', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    plus.dispatch('pointerdown', touch());
    vi.advanceTimersByTime(100);
    plus.dispatch('pointerdown', touch());
    vi.advanceTimersByTime(149); // 249 ms after the first press, 149 ms after the second
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(false);
  });

  it('an ignored secondary-button press does not flash', () => {
    const plus = new FakeElement();
    bindPaddle(plus.el, 1, record);
    plus.dispatch('pointerdown', touch({ pointerType: 'mouse', button: 2, buttons: 2 }));
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(false);
  });
});

describe('bindPaddle — unbind', () => {
  it('stops shifting, ends a running flash and removes the classes it added', () => {
    const plus = new FakeElement();
    const unbind = bindPaddle(plus.el, 1, record);
    plus.dispatch('pointerdown', touch());
    unbind();
    expect(plus.count('pointerdown')).toBe(0);
    expect(plus.classList.contains(PADDLE_FLASH_CLASS)).toBe(false);
    expect(plus.classList.contains(PADDLE_CLASS)).toBe(false);
    plus.dispatch('pointerdown', touch());
    expect(shifts).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a paddle class the element already carried before binding', () => {
    const plus = new FakeElement([PADDLE_CLASS, 'edge-right']);
    const unbind = bindPaddle(plus.el, 1, record);
    unbind();
    expect(plus.classList.contains(PADDLE_CLASS)).toBe(true);
    expect(plus.classList.contains('edge-right')).toBe(true);
  });

  it('a stale unbind called again after re-binding leaves the new binding intact', () => {
    const plus = new FakeElement();
    const first = bindPaddle(plus.el, 1, record);
    first();
    bindPaddle(plus.el, 1, record);
    first();
    expect(plus.classList.contains(PADDLE_CLASS)).toBe(true);
    plus.dispatch('pointerdown', touch());
    expect(shifts).toEqual([1]);
  });
});
