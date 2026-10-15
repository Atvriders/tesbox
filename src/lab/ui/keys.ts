/**
 * Sound Lab keyboard (phase-2c contract L3): ↑/↓ rpm, W/S load, E/Q shift up/down, Space lift-off, L limiter,
 * B A/B. Like the app (src/input/keyboard.ts), keys match on `KeyboardEvent.code` — the physical position, so
 * W/S/Q/E keep their place on any layout — and on `key` only when an event carries no code.
 *
 * A shortcut never takes a key a focused control needs: text entry (number and text inputs, selects, text
 * areas, contenteditable) keeps every key, and a focused slider keeps its arrow keys. Buttons and checkboxes
 * take the shortcuts; the page stops their own Space activation (src/lab/ui/main.tsx).
 */
import type { LabEvent } from './protocol';

/** rpm per ↑/↓ press and load per W/S press (auto-repeat sweeps). */
export const RPM_KEY_STEP = 100;
export const LOAD_KEY_STEP = 0.05;

export type KeyCommand =
  | { kind: 'rpm'; delta: number }
  | { kind: 'load'; delta: number }
  | { kind: 'event'; ev: LabEvent }
  | { kind: 'ab' };

const BY_CODE: ReadonlyMap<string, KeyCommand> = new Map<string, KeyCommand>([
  ['ArrowUp', { kind: 'rpm', delta: RPM_KEY_STEP }],
  ['ArrowDown', { kind: 'rpm', delta: -RPM_KEY_STEP }],
  ['KeyW', { kind: 'load', delta: LOAD_KEY_STEP }],
  ['KeyS', { kind: 'load', delta: -LOAD_KEY_STEP }],
  ['KeyE', { kind: 'event', ev: 'upshift' }],
  ['KeyQ', { kind: 'event', ev: 'downshift' }],
  ['Space', { kind: 'event', ev: 'liftoff' }],
  ['KeyL', { kind: 'event', ev: 'limiter' }],
  ['KeyB', { kind: 'ab' }],
]);

/** Fallback for events without a code (synthetic events, some virtual keyboards). */
const BY_KEY: ReadonlyMap<string, string> = new Map([
  ['arrowup', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['w', 'KeyW'],
  ['s', 'KeyS'],
  ['e', 'KeyE'],
  ['q', 'KeyQ'],
  [' ', 'Space'],
  ['spacebar', 'Space'],
  ['l', 'KeyL'],
  ['b', 'KeyB'],
]);

export function keyCommand(code: string, key: string): KeyCommand | null {
  if (code !== '' && code !== 'Unidentified') return BY_CODE.get(code) ?? null;
  const mapped = BY_KEY.get(key.toLowerCase());
  return mapped === undefined ? null : (BY_CODE.get(mapped) ?? null);
}

/** What kind of element has the focus: text entry, a slider, a button-like toggle, or anything else. */
export type TargetKind = 'text' | 'range' | 'toggle' | 'other';

export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

export function targetKind(t: KeyTargetLike | null): TargetKind {
  if (t === null) return 'other';
  if (t.isContentEditable === true) return 'text';
  switch (t.tagName) {
    case 'TEXTAREA':
    case 'SELECT':
      return 'text';
    case 'BUTTON':
      return 'toggle';
    case 'INPUT': {
      const type = (t.type ?? 'text').toLowerCase();
      if (type === 'range') return 'range';
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset') return 'toggle';
      return 'text';
    }
    default:
      return 'other';
  }
}

export function shortcutApplies(cmd: KeyCommand, kind: TargetKind): boolean {
  if (kind === 'text') return false;
  if (kind === 'range' && cmd.kind === 'rpm') return false; // ↑/↓ move the focused slider
  return true;
}
