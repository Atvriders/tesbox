/**
 * Steering-wheel shifting through the media session (spec §6.2, §7.2; phase 3 contract "Input").
 * Tilting the left scroll wheel may reach the page as a Media Session `nexttrack`/`previoustrack`
 * action, a `MediaTrackNext`/`MediaTrackPrevious` keydown, or both for one tilt: tilt right = next
 * = upshift, tilt left = previous = downshift. Pressing the wheel (play/pause) is never a shift.
 *
 * Both classes are clock-free: callers pass `nowMs` from one monotonic clock (performance.now())
 * for keys and actions alike, and skip `KeyboardEvent.repeat` keydowns (a held key is one tilt).
 */

export type MediaShiftDir = 'up' | 'down';

/** A key and an action of the same direction this close together (inclusive) are one tilt. */
export const MEDIA_DEDUPE_MS = 900;

/** The keydowns of a wheel tilt (`code`, or `key` without one): what `handleKey` / `onKey` take as tilts. */
export const TILT_KEYS: ReadonlySet<string> = new Set(['MediaTrackNext', 'MediaTrackPrevious']);

/** Media and volume keys — what a steering wheel or a remote may send; worth logging for Diagnostics. */
export const MEDIA_KEY = /^(Media|AudioVolume)/;

/** A keydown's name for the media-key handlers: its `code`, or its `key` when it has no usable code. */
export function mediaKeyCode(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  return e.code !== '' && e.code !== 'Unidentified' ? e.code : e.key;
}

function actionDir(action: string): MediaShiftDir | null {
  if (action === 'nexttrack') return 'up';
  if (action === 'previoustrack') return 'down';
  return null;
}

function keyDir(code: string): MediaShiftDir | null {
  if (code === 'MediaTrackNext') return 'up';
  if (code === 'MediaTrackPrevious') return 'down';
  return null;
}

/** Drops the timestamps more than MEDIA_DEDUPE_MS away from nowMs (either side), in place. */
function prune(times: number[], nowMs: number): void {
  let kept = 0;
  for (const t of times) if (Math.abs(nowMs - t) <= MEDIA_DEDUPE_MS) times[kept++] = t;
  times.length = kept;
}

/**
 * Turns wheel tilts into shift directions. Dedupe (spec §6.2): one key and one action of the
 * same direction within MEDIA_DEDUPE_MS count once — each counted input can absorb at most one
 * input of the other kind, so two quick tilts each delivered twice still shift twice — while
 * repeats from a single source are never suppressed.
 */
export class MediaShift {
  /** Opt-in (Settings → wheel shifting, after a passing WheelTest); while false nothing shifts. */
  enabled: boolean;

  /** Counted inputs not yet paired with one of the other kind, oldest first. */
  private readonly unpaired: Record<MediaShiftDir, { key: number[]; action: number[] }> = {
    up: { key: [], action: [] },
    down: { key: [], action: [] },
  };

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  /** A Media Session action (`nexttrack` → 'up', `previoustrack` → 'down'; anything else → null). */
  handleAction(action: string, nowMs: number): MediaShiftDir | null {
    return this.handle(actionDir(action), 'action', nowMs);
  }

  /** A keydown `code` or `key` (`MediaTrackNext` → 'up', `MediaTrackPrevious` → 'down'; else null). */
  handleKey(code: string, nowMs: number): MediaShiftDir | null {
    return this.handle(keyDir(code), 'key', nowMs);
  }

  private handle(dir: MediaShiftDir | null, source: 'key' | 'action', nowMs: number): MediaShiftDir | null {
    if (!this.enabled || dir === null) return null;
    const lists = this.unpaired[dir];
    const own = lists[source];
    const other = source === 'key' ? lists.action : lists.key;
    prune(own, nowMs);
    prune(other, nowMs);
    if (other.length > 0) {
      other.shift(); // the second delivery of a tilt that already shifted
      return null;
    }
    own.push(nowMs);
    return dir;
  }
}

export type WheelTestState = 'idle' | 'waitRight' | 'waitLeft' | 'done';

/** Time allowed for each tilt of the steering-wheel test (inclusive). */
export const WHEEL_TEST_STEP_MS = 10_000;

/**
 * The steering-wheel shifting test (spec §7.2), as a state machine:
 * `idle → waitRight (10 s) → waitLeft (10 s) → done(works)`. "Tilt the LEFT scroll wheel to the
 * RIGHT now" waits for `nexttrack`/`MediaTrackNext`, then the reverse for `previoustrack`/
 * `MediaTrackPrevious`. Inputs of the wrong direction, presses (play/pause) and the second
 * delivery of a tilt are ignored; a step that runs out → done with works = false. Timeouts are
 * applied by every call, so call `tick(nowMs)` periodically (e.g. 4 Hz for the countdown) to
 * notice one without input.
 */
export class WheelTest {
  private current: WheelTestState = 'idle';
  private result: boolean | null = null;
  private stepStartMs = 0;

  get state(): WheelTestState {
    return this.current;
  }

  /** null until done; then whether both tilts arrived in time. */
  get works(): boolean | null {
    return this.result;
  }

  /** Starts (or restarts) the test: waiting for the right tilt. */
  start(nowMs: number): void {
    this.current = 'waitRight';
    this.result = null;
    this.stepStartMs = nowMs;
  }

  /** Abandons the test without a result. */
  cancel(): void {
    this.current = 'idle';
    this.result = null;
  }

  onAction(action: string, nowMs: number): WheelTestState {
    return this.input(actionDir(action), nowMs);
  }

  onKey(code: string, nowMs: number): WheelTestState {
    return this.input(keyDir(code), nowMs);
  }

  tick(nowMs: number): WheelTestState {
    this.expire(nowMs);
    return this.current;
  }

  /** Seconds left in the current step; 0 when not waiting. */
  remainingS(nowMs: number): number {
    if (this.current !== 'waitRight' && this.current !== 'waitLeft') return 0;
    return Math.max(0, (this.stepStartMs + WHEEL_TEST_STEP_MS - nowMs) / 1000);
  }

  private expire(nowMs: number): void {
    const waiting = this.current === 'waitRight' || this.current === 'waitLeft';
    if (waiting && nowMs - this.stepStartMs > WHEEL_TEST_STEP_MS) this.finish(false);
  }

  private input(dir: MediaShiftDir | null, nowMs: number): WheelTestState {
    this.expire(nowMs);
    if (this.current === 'waitRight' && dir === 'up') {
      this.current = 'waitLeft';
      this.stepStartMs = nowMs;
    } else if (this.current === 'waitLeft' && dir === 'down') {
      this.finish(true);
    }
    return this.current;
  }

  private finish(works: boolean): void {
    this.current = 'done';
    this.result = works;
  }
}
