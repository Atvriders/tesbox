/**
 * Touch paddles (spec §7.1, phase 3 contract "Input"): the guaranteed shift input. A paddle fires
 * on `pointerdown` — never `click`, which waits for the finger to lift and can be lost to a
 * gesture — so a tap shifts at once.
 */

/** Shift direction: +1 = upshift, −1 = downshift. */
export type ShiftDir = 1 | -1;

/**
 * Added to every bound paddle. The app stylesheet gives it `touch-action: manipulation` (no
 * double-tap-zoom delay); the CSP forbids inline styles, so the rule lives in CSS, keyed on this.
 */
export const PADDLE_CLASS = 'paddle';

/** Present for PADDLE_FLASH_MS after each press: the visual acknowledgement of the tap. */
export const PADDLE_FLASH_CLASS = 'paddle-flash';
export const PADDLE_FLASH_MS = 150;

/**
 * Makes `el` a shift paddle: every pointerdown with the primary button (any touch contact,
 * second fingers included, or a left-click/pen tip) calls `onShift(dir)` and flashes the paddle.
 * Returns the unbind function: removes the listener, ends a running flash and removes the paddle
 * class if this call added it. Safe to call more than once.
 */
export function bindPaddle(el: HTMLElement, dir: ShiftDir, onShift: (dir: ShiftDir) => void): () => void {
  const addedClass = !el.classList.contains(PADDLE_CLASS);
  el.classList.add(PADDLE_CLASS);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const endFlash = (): void => {
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = null;
    el.classList.remove(PADDLE_FLASH_CLASS);
  };

  const onPointerDown = (ev: Event): void => {
    // Touch and pen contacts report button 0; > 0 is a middle/secondary mouse button.
    if ((ev as PointerEvent).button > 0) return;
    if (flashTimer !== null) clearTimeout(flashTimer);
    el.classList.add(PADDLE_FLASH_CLASS);
    flashTimer = setTimeout(endFlash, PADDLE_FLASH_MS);
    onShift(dir);
  };

  el.addEventListener('pointerdown', onPointerDown);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    el.removeEventListener('pointerdown', onPointerDown);
    endFlash();
    if (addedClass) el.classList.remove(PADDLE_CLASS);
  };
}
