/**
 * src/lab/ui/keys.ts (phase-2c contract L3): ↑/↓ rpm, W/S load, E/Q shift up/down, Space lift-off, L limiter,
 * B A/B — matched on the physical key (`code`, so W/S/Q/E keep their place on any layout), `key` only when an
 * event has no code — and never stolen from a control that needs the key itself.
 */
import { describe, expect, it } from 'vitest';
import { keyCommand, shortcutApplies, targetKind } from '../../src/lab/ui/keys';

describe('keyCommand', () => {
  it('maps the contract keys by code', () => {
    expect(keyCommand('ArrowUp', 'ArrowUp')).toEqual({ kind: 'rpm', delta: 100 });
    expect(keyCommand('ArrowDown', 'ArrowDown')).toEqual({ kind: 'rpm', delta: -100 });
    expect(keyCommand('KeyW', 'w')).toEqual({ kind: 'load', delta: 0.05 });
    expect(keyCommand('KeyS', 's')).toEqual({ kind: 'load', delta: -0.05 });
    expect(keyCommand('KeyE', 'e')).toEqual({ kind: 'event', ev: 'upshift' });
    expect(keyCommand('KeyQ', 'q')).toEqual({ kind: 'event', ev: 'downshift' });
    expect(keyCommand('Space', ' ')).toEqual({ kind: 'event', ev: 'liftoff' });
    expect(keyCommand('KeyL', 'l')).toEqual({ kind: 'event', ev: 'limiter' });
    expect(keyCommand('KeyB', 'b')).toEqual({ kind: 'ab' });
  });

  it('follows the physical position, not the character (AZERTY: the W key types z)', () => {
    expect(keyCommand('KeyW', 'z')).toEqual({ kind: 'load', delta: 0.05 });
    expect(keyCommand('KeyZ', 'w')).toBeNull();
  });

  it('falls back to the character when the event has no code', () => {
    expect(keyCommand('', 'E')).toEqual({ kind: 'event', ev: 'upshift' });
    expect(keyCommand('Unidentified', ' ')).toEqual({ kind: 'event', ev: 'liftoff' });
  });

  it('ignores every other key', () => {
    expect(keyCommand('KeyX', 'x')).toBeNull();
    expect(keyCommand('Enter', 'Enter')).toBeNull();
  });
});

describe('targetKind and shortcutApplies', () => {
  const up = { kind: 'rpm', delta: 100 } as const;
  const shift = { kind: 'event', ev: 'upshift' } as const;

  it('leaves text entry alone: number and text inputs, selects, text areas, contenteditable', () => {
    for (const t of [
      { tagName: 'INPUT', type: 'number' },
      { tagName: 'INPUT', type: 'text' },
      { tagName: 'SELECT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      expect(targetKind(t), JSON.stringify(t)).toBe('text');
      expect(shortcutApplies(shift, targetKind(t))).toBe(false);
    }
  });

  it('a focused slider keeps its arrow keys but not the letters', () => {
    const kind = targetKind({ tagName: 'INPUT', type: 'range' });
    expect(kind).toBe('range');
    expect(shortcutApplies(up, kind)).toBe(false);
    expect(shortcutApplies(shift, kind)).toBe(true);
  });

  it('buttons and checkboxes take every shortcut (the page stops their own Space activation)', () => {
    for (const t of [{ tagName: 'BUTTON' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'radio' }]) {
      expect(targetKind(t)).toBe('toggle');
      expect(shortcutApplies(up, 'toggle') && shortcutApplies(shift, 'toggle')).toBe(true);
    }
  });

  it('the page itself takes every shortcut', () => {
    expect(targetKind({ tagName: 'BODY' })).toBe('other');
    expect(targetKind(null)).toBe('other');
    expect(shortcutApplies(up, 'other')).toBe(true);
  });
});
