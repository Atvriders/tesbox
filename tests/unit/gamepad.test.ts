import { beforeEach, describe, expect, it } from 'vitest';
import { attachGamepad, type GamepadHost } from '../../src/input/gamepad';
import type { ActionHandlers } from '../../src/input/keyboard';

/** One entry of Gamepad.buttons. */
interface FakeButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

/** A Gamepad as Chromium reports a "standard"-mapping pad: 17 buttons, 4 axes. */
interface FakePad {
  id: string;
  index: number;
  connected: boolean;
  mapping: 'standard' | '';
  timestamp: number;
  axes: number[];
  buttons: FakeButton[];
}

const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const A = 0;
const B = 1;
const LB = 4;
const RB = 5;

function makePad(index = 0, id = XBOX): FakePad {
  return {
    id,
    index,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}

function setButton(pad: FakePad, i: number, pressed: boolean): void {
  pad.buttons[i] = { pressed, touched: pressed, value: pressed ? 1 : 0 };
}

/** window stand-in: an rAF queue run by hand and navigator.getGamepads. */
class FakeHost {
  pads: (FakePad | null)[] = [];
  polls = 0;
  private readonly frames = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  readonly navigator: { getGamepads?: () => (Gamepad | null)[] } = {
    getGamepads: () => {
      this.polls++;
      return this.pads as unknown as (Gamepad | null)[];
    },
  };

  requestAnimationFrame(cb: FrameRequestCallback): number {
    const id = this.nextId++;
    this.frames.set(id, cb);
    return id;
  }

  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }

  pending(): number {
    return this.frames.size;
  }

  /** Runs every pending frame callback with the rAF timestamp `ts` (ms). */
  frame(ts: number): void {
    const cbs = [...this.frames.values()];
    this.frames.clear();
    for (const cb of cbs) cb(ts);
  }
}

let host: FakeHost;
let calls: string[];
let nowMs: number;

const handlers: ActionHandlers = {
  shift: (dir) => calls.push(`shift ${dir}`),
  cycleValve: () => calls.push('valve'),
  togglePerspective: () => calls.push('perspective'),
};

/** One frame 25 ms after the previous one: always past the 20 ms guard, so it polls. */
function poll(): void {
  nowMs += 25;
  host.frame(nowMs);
}

function attach(swap?: () => boolean): () => void {
  return attachGamepad(host as GamepadHost, handlers, swap === undefined ? undefined : { swap });
}

beforeEach(() => {
  host = new FakeHost();
  calls = [];
  nowMs = 1000;
});

describe('attachGamepad — polling', () => {
  it('does nothing where the Gamepad API is missing', () => {
    host.navigator.getGamepads = undefined;
    const detach = attach();
    expect(host.pending()).toBe(0);
    expect(() => detach()).not.toThrow();
  });

  it('polls from requestAnimationFrame at most once per 20 ms', () => {
    attach();
    for (const ts of [1000, 1010, 1019.9, 1020, 1030, 1045]) host.frame(ts);
    expect(host.polls).toBe(3); // at 1000, 1020 and 1045
  });

  it('keeps itself scheduled on every frame, skipped ones included, until detached', () => {
    const detach = attach();
    expect(host.pending()).toBe(1);
    host.frame(1000);
    expect(host.pending()).toBe(1);
    host.frame(1005); // inside the guard: no poll, still rescheduled
    expect(host.pending()).toBe(1);
    detach();
    expect(host.pending()).toBe(0);
    host.frame(1100);
    expect(host.polls).toBe(1);
  });

  it('stops polling for good when getGamepads throws (feature blocked)', () => {
    host.navigator.getGamepads = () => {
      throw new Error('SecurityError');
    };
    attach();
    expect(() => host.frame(1000)).not.toThrow();
    expect(host.pending()).toBe(0);
  });
});

describe('attachGamepad — buttons', () => {
  it('maps RB to upshift, LB to downshift, A to valves and B to perspective', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll(); // the pad appears with nothing pressed
    for (const i of [RB, LB, A, B]) {
      setButton(pad, i, true);
      poll();
      setButton(pad, i, false);
      poll();
    }
    expect(calls).toEqual(['shift 1', 'shift -1', 'valve', 'perspective']);
  });

  it('acts once per press: a held button does not repeat', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll();
    setButton(pad, RB, true);
    poll();
    poll();
    poll();
    setButton(pad, RB, false);
    poll();
    setButton(pad, RB, true);
    poll();
    expect(calls).toEqual(['shift 1', 'shift 1']);
  });

  it('two buttons pressed between polls both act, in button order', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll();
    setButton(pad, B, true);
    setButton(pad, A, true);
    poll();
    expect(calls).toEqual(['valve', 'perspective']);
  });

  it('X, Y, the triggers, Select/Start, the stick clicks, the d-pad and Home do nothing', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll();
    for (let i = 2; i < 17; i++) if (i !== LB && i !== RB) setButton(pad, i, true);
    poll();
    expect(calls).toEqual([]);
  });

  it("a pad's first appearance is its baseline: the press that makes it visible does not act", () => {
    const pad = makePad();
    setButton(pad, RB, true);
    host.pads = [pad];
    attach();
    poll();
    poll();
    expect(calls).toEqual([]);
    setButton(pad, RB, false);
    poll();
    setButton(pad, RB, true);
    poll();
    expect(calls).toEqual(['shift 1']);
  });
});

describe('attachGamepad — swap', () => {
  it('swap exchanges A and B and leaves the bumpers alone', () => {
    const pad = makePad();
    host.pads = [pad];
    attach(() => true);
    poll();
    for (const i of [A, B, RB, LB]) {
      setButton(pad, i, true);
      poll();
      setButton(pad, i, false);
      poll();
    }
    expect(calls).toEqual(['perspective', 'valve', 'shift 1', 'shift -1']);
  });

  it('reads the swap setting on every poll', () => {
    let swap = false;
    const pad = makePad();
    host.pads = [pad];
    attach(() => swap);
    poll();
    setButton(pad, A, true);
    poll();
    setButton(pad, A, false);
    poll();
    swap = true;
    setButton(pad, A, true);
    poll();
    expect(calls).toEqual(['valve', 'perspective']);
  });
});

describe('attachGamepad — several pads, reconnects, failures', () => {
  it('tracks each pad on its own', () => {
    const p0 = makePad(0);
    const p1 = makePad(1, 'TESLA VIRTUAL GAMEPAD');
    host.pads = [p0, p1];
    attach();
    poll();
    setButton(p0, RB, true);
    setButton(p1, LB, true);
    poll();
    setButton(p1, LB, false);
    poll();
    setButton(p1, LB, true); // p0 still holds RB: only p1 acts
    poll();
    expect(calls).toEqual(['shift 1', 'shift -1', 'shift -1']);
  });

  it('a pad that disconnects and returns, or changes identity, starts from a new baseline', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll();
    setButton(pad, RB, true);
    poll(); // shift 1
    setButton(pad, RB, false);
    poll();
    host.pads = [null];
    poll();
    setButton(pad, RB, true);
    host.pads = [pad]; // back, made visible by an RB press: baseline, no second shift
    poll();
    const other = makePad(0, 'TESLA VIRTUAL GAMEPAD');
    setButton(other, LB, true);
    host.pads = [other]; // another device in the same slot, LB held as it appears
    poll();
    expect(calls).toEqual(['shift 1']);
    setButton(other, LB, false);
    poll();
    setButton(other, LB, true);
    poll();
    expect(calls).toEqual(['shift 1', 'shift -1']);
  });

  it('a pad reported as not connected counts as gone', () => {
    const pad = makePad();
    host.pads = [pad];
    attach();
    poll();
    pad.connected = false;
    setButton(pad, RB, true);
    poll();
    pad.connected = true; // reappears with RB held: baseline
    poll();
    expect(calls).toEqual([]);
  });

  it('a handler that throws neither stops the loop nor makes the press fire again', () => {
    const pad = makePad();
    host.pads = [pad];
    let fail = true;
    attachGamepad(host as GamepadHost, {
      ...handlers,
      shift: (dir) => {
        if (fail) {
          fail = false;
          throw new Error('handler bug');
        }
        calls.push(`shift ${dir}`);
      },
    });
    poll();
    setButton(pad, RB, true);
    expect(() => poll()).toThrow('handler bug');
    expect(host.pending()).toBe(1);
    poll(); // RB still held: no retry of the failed press
    setButton(pad, RB, false);
    poll();
    setButton(pad, RB, true);
    poll();
    expect(calls).toEqual(['shift 1']);
  });

  it('detaching from inside a handler stops the remaining actions of that poll', () => {
    const pad = makePad();
    host.pads = [pad];
    let detach = (): void => {};
    detach = attachGamepad(host as GamepadHost, {
      ...handlers,
      cycleValve: () => {
        calls.push('valve');
        detach();
      },
    });
    poll();
    setButton(pad, A, true);
    setButton(pad, B, true);
    poll();
    expect(calls).toEqual(['valve']);
    expect(host.pending()).toBe(0);
  });
});
