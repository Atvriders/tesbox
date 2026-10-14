/**
 * Desktop keyboard (spec §7.4, phase 3 contract "Input"): `E` upshift, `Q` downshift, `V` cycle
 * valves, `P` toggle perspective — whatever the speed source; `W` throttle, `S` brake, `Space`
 * brake-to-stop — only while the Keyboard source is selected.
 *
 * Keys are matched on `KeyboardEvent.code` (the physical position, so W/S/Q/E keep their WASD
 * layout on any keyboard); `key` is only consulted when an event carries no code.
 */
import type { ShiftDir } from './paddles';

/** Discrete actions shared by the keyboard and the gamepad. */
export interface ActionHandlers {
  /** +1 upshift, −1 downshift. */
  shift(dir: ShiftDir): void;
  /** Advance the valve mode (the Drive toggle's Auto → Open → Closed order). */
  cycleValve(): void;
  /** Cabin ↔ Outside. */
  togglePerspective(): void;
}

export interface KeyboardHandlers extends ActionHandlers {
  /** New pedal positions (0..1 each) whenever W/S/Space change them; post as `{ type: 'pedal' }`. */
  pedal(throttle: number, brake: number): void;
  /** True while the Keyboard speed source is selected; W/S/Space are ignored otherwise. */
  keyboardSource(): boolean;
}

/** Pedal positions the keys produce. Any brake overrides the throttle (brake-override). */
export const KEY_THROTTLE = 1; // W
export const KEY_BRAKE = 0.5; // S: ≈ 0.4 g in PedalPhysics
export const KEY_STOP_BRAKE = 1; // Space: brake-to-stop, ≈ 0.8 g

/** Where the listeners go — pass `window` (its `blur` means the page lost keyboard focus). */
export type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

type Action = 'up' | 'down' | 'valve' | 'perspective';
type Pedal = 'throttle' | 'brake' | 'stop';
type Binding = Action | Pedal;

const BY_CODE: ReadonlyMap<string, Binding> = new Map<string, Binding>([
  ['KeyE', 'up'],
  ['KeyQ', 'down'],
  ['KeyV', 'valve'],
  ['KeyP', 'perspective'],
  ['KeyW', 'throttle'],
  ['KeyS', 'brake'],
  ['Space', 'stop'],
]);

/** Fallback for events without a code (synthetic events, some virtual keyboards). */
const BY_KEY: ReadonlyMap<string, Binding> = new Map<string, Binding>([
  ['e', 'up'],
  ['q', 'down'],
  ['v', 'valve'],
  ['p', 'perspective'],
  ['w', 'throttle'],
  ['s', 'brake'],
  [' ', 'stop'],
  ['spacebar', 'stop'],
]);

function binding(e: KeyboardEvent): Binding | null {
  if (e.code !== '' && e.code !== 'Unidentified') return BY_CODE.get(e.code) ?? null;
  return BY_KEY.get(e.key.toLowerCase()) ?? null;
}

function isPedal(b: Binding): b is Pedal {
  return b === 'throttle' || b === 'brake' || b === 'stop';
}

/** Text fields, selects and contenteditable keep their keys (e.g. 'e' is valid in a number field). */
function isEditable(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Listens for keydown/keyup/blur on `target`. E/Q/V/P act once per press (auto-repeat ignored);
 * W/S/Space are tracked as held keys and `pedal` is called only when the resulting positions
 * change. Keys with Ctrl/Meta/Alt (browser shortcuts), IME composition and keys typed into
 * editable elements are left alone; handled keys have their default prevented (no page scroll,
 * no activation of a focused button by Space). Releases are always honoured, even after the
 * source changed; losing window focus and detaching release every held pedal key.
 * Returns the detach function.
 */
export function attachKeyboard(target: KeyTarget, handlers: KeyboardHandlers): () => void {
  const held = new Set<Pedal>();
  let throttle = 0;
  let brake = 0;

  const updatePedals = (): void => {
    const b = held.has('stop') ? KEY_STOP_BRAKE : held.has('brake') ? KEY_BRAKE : 0;
    const t = b > 0 ? 0 : held.has('throttle') ? KEY_THROTTLE : 0;
    if (t === throttle && b === brake) return;
    throttle = t;
    brake = b;
    handlers.pedal(t, b);
  };

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isEditable(e.target)) return;
    const b = binding(e);
    if (b === null) return;
    if (isPedal(b)) {
      if (!handlers.keyboardSource()) return;
      e.preventDefault();
      held.add(b);
      updatePedals();
      return;
    }
    e.preventDefault();
    if (e.repeat) return;
    if (b === 'up') handlers.shift(1);
    else if (b === 'down') handlers.shift(-1);
    else if (b === 'valve') handlers.cycleValve();
    else handlers.togglePerspective();
  };

  const onKeyUp = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const b = binding(e);
    if (b === null || !isPedal(b) || !held.has(b)) return;
    e.preventDefault();
    held.delete(b);
    updatePedals();
  };

  const releaseAll = (): void => {
    held.clear();
    updatePedals();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', releaseAll);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', releaseAll);
    releaseAll();
  };
}
