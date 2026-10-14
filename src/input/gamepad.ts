/**
 * Gamepad (spec §7.3, phase 3 contract "Input"): `navigator.getGamepads()` polled from
 * requestAnimationFrame behind a 20 ms timing guard. Standard mapping: R1/RB (5) upshift, L1/LB
 * (4) downshift, A (0) valves, B (1) perspective. `swap` exchanges A↔B and X↔Y for pads labelled
 * Nintendo-style ("TESLA VIRTUAL GAMEPAD" included). Edge-triggered: a press acts once.
 *
 * Chromium exposes a pad only after one of its buttons is pressed; the state a pad has when it is
 * first seen (and after a reconnect or a different device in the same slot) is its baseline, so
 * that wake-up press — or a button already held when Drive opens — does not act.
 */
import type { ActionHandlers } from './keyboard';

/** Minimum interval between two getGamepads() polls; rAF frames inside it are skipped. */
export const GAMEPAD_POLL_GUARD_MS = 20;

/** W3C "standard" mapping indices of the buttons Tesbox uses. */
export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5 } as const;

/** The parts of `window` the poller needs (pass `window`). */
export interface GamepadHost {
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  readonly navigator: { getGamepads?: () => (Gamepad | null)[] };
}

export interface GamepadOptions {
  /** Read on every poll (Settings → gamepad swap): true exchanges A↔B and X↔Y. */
  swap?: () => boolean;
}

/** Physical buttons 0–5 are tracked; with swap on, physical button i acts as SWAPPED[i]. */
const TRACKED = 6;
const SWAPPED: readonly number[] = [1, 0, 3, 2, 4, 5];

interface PadState {
  id: string;
  pressed: boolean[];
  /** Poll generation in which the pad was last seen (stale states are dropped). */
  seen: number;
}

/**
 * Starts polling and calls `handlers` on each new press. Does nothing where the Gamepad API is
 * missing; stops for good if getGamepads() throws (e.g. blocked by Permissions-Policy). The next
 * frame is requested before polling, so a throwing handler cannot end the loop, and a button's
 * state is recorded before its handler runs, so a failed press is not retried.
 * Returns the detach function.
 */
export function attachGamepad(host: GamepadHost, handlers: ActionHandlers, opts: GamepadOptions = {}): () => void {
  const nav = host.navigator;
  if (typeof nav.getGamepads !== 'function') return () => {};
  const swap = opts.swap ?? ((): boolean => false);
  const pads = new Map<number, PadState>();
  let active = true;
  let rafId: number | null = null;
  let lastPollMs = -Infinity;
  let generation = 0;

  const act = (logical: number): void => {
    if (logical === PAD_BUTTON.RB) handlers.shift(1);
    else if (logical === PAD_BUTTON.LB) handlers.shift(-1);
    else if (logical === PAD_BUTTON.A) handlers.cycleValve();
    else if (logical === PAD_BUTTON.B) handlers.togglePerspective();
  };

  /** False when getGamepads() threw. */
  const poll = (): boolean => {
    let list: readonly (Gamepad | null)[];
    try {
      list = nav.getGamepads?.() ?? [];
    } catch {
      return false;
    }
    generation++;
    const swapped = swap();
    for (const pad of list) {
      if (!pad || pad.connected === false) continue;
      let state = pads.get(pad.index);
      let fresh = false;
      if (state === undefined || state.id !== pad.id) {
        fresh = true; // new pad, reconnect or another device in this slot: record a baseline
        state = { id: pad.id, pressed: new Array<boolean>(TRACKED).fill(false), seen: generation };
        pads.set(pad.index, state);
      }
      state.seen = generation;
      for (let i = 0; i < TRACKED; i++) {
        const now = pad.buttons[i]?.pressed === true;
        const was = state.pressed[i] === true;
        state.pressed[i] = now;
        if (fresh || !now || was) continue;
        act(swapped ? (SWAPPED[i] ?? i) : i);
        if (!active) return true;
      }
    }
    for (const [index, state] of pads) if (state.seen !== generation) pads.delete(index);
    return true;
  };

  const stop = (): void => {
    active = false;
    if (rafId !== null) host.cancelAnimationFrame(rafId);
    rafId = null;
    pads.clear();
  };

  const frame = (ts: number): void => {
    if (!active) return;
    rafId = host.requestAnimationFrame(frame);
    if (ts - lastPollMs < GAMEPAD_POLL_GUARD_MS) return;
    lastPollMs = ts;
    if (!poll()) stop();
  };

  rafId = host.requestAnimationFrame(frame);
  return stop;
}
