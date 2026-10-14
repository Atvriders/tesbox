/**
 * Waiting on the store (phase-3 contract T7): the effect- and timer-based helpers the first-run bass
 * sweep and the garage Preview share. Both start the engine from a tap (shell.startEngine creates the
 * AudioContext inside the gesture) and hold their sound check until the engine has settled: the audio
 * runs and the engine is past its 2.5 s ignition / crank sequence (spec §5.3). EngineAudio runs the
 * tier benchmark inside that crank (spec §5.7: the DSP rendered up to 8× per quantum), and a step that
 * overloads underruns the output — not something to play a bass-sweep tone or a rev into.
 * No DOM; unit-tested in Node (tests/unit/wait.test.ts).
 */
import { effect, type ReadonlySignal } from '@preact/signals';
import { S } from '../contracts';
import type { AudioState } from '../app/store';

/** A started engine's audio runs within this, or the waiting screen gives up. */
export const AUDIO_START_WAIT_MS = 5000;
/**
 * … and the engine then settles within this: the 2.5 s crank (SimCore CRANK_SETTLE_END_S, on the worklet
 * clock), which holds the 2 s tier benchmark (EngineAudio BENCH_KS × BENCH_STEP_MS), plus the output
 * device's start-up — the worklet clock can start well after the context reports 'running' (≈ 1.2 s in
 * headless Chromium) — with margin.
 */
export const ENGINE_SETTLE_WAIT_MS = 8000;

/**
 * Resolves true as soon as `verdict()` is true (at once if it already is), false when it is false or
 * `timeoutMs` passes; null means "keep waiting". The verdict runs in an effect: it is evaluated again
 * whenever a signal it read changes. Stops listening once settled.
 */
export function waitFor(verdict: () => boolean | null, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let dispose: (() => void) | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dispose?.();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    dispose = effect(() => {
      const v = verdict();
      if (v !== null) finish(v);
    });
    if (settled) dispose(); // settled during the effect's first run, before `dispose` was assigned
  });
}

/** waitFor over one signal: `verdict(sig.value)`. */
export function waitForSignal<T>(
  sig: ReadonlySignal<T>,
  verdict: (value: T) => boolean | null,
  timeoutMs: number,
): Promise<boolean> {
  return waitFor(() => verdict(sig.value), timeoutMs);
}

/** Ready for sound: running → yes; failed or stopped → no; starting / interrupted → keep waiting. */
export function audioReady(a: AudioState): boolean | null {
  if (a.state === 'running') return true;
  return a.state === 'error' || a.state === 'off' ? false : null;
}

/**
 * The engine has settled: it runs in gear — SimCore reports gear 0 before ignition, while it cranks and
 * while it stops — and the worklet renders the DSP once per quantum (S.benchK ≤ 1, 0 before the first
 * report): no tier-benchmark step is in progress, e.g. one restarted after an interruption.
 */
export function engineSettled(buf: Float64Array): boolean {
  return (buf[S.gear] ?? 0) >= 1 && (buf[S.benchK] ?? 0) <= 1;
}

/** The store signals engineReady reads. */
export interface EngineSignals {
  audio: ReadonlySignal<AudioState>;
  snapshot: ReadonlySignal<Float64Array>;
}

/**
 * Call it from the tap: it calls `start` (the shell's startEngine) at once, inside the gesture. Resolves
 * true once the engine is ready for a sound check — `start` resolved true, the audio runs (within
 * AUDIO_START_WAIT_MS) and the engine has settled (within ENGINE_SETTLE_WAIT_MS): judged by the latest
 * snapshot that arrived after the tap, or at once when none has and the engine was `running` and settled
 * at the tap. A snapshot from before the tap says nothing about an engine that was off, interrupted or
 * stopping then. Resolves false when any of that fails, or as soon as the audio stops running (stopped,
 * failed, interrupted) while the engine settles; rejects only when `start` does.
 *
 * `running`: the engine ran at the tap — by default, the audio was 'running'. A caller that has just
 * stopped the engine passes false: EngineAudio reports 'running' until its stop fade is over.
 */
export function engineReady(
  s: EngineSignals,
  start: () => Promise<boolean>,
  running: boolean = s.audio.peek().state === 'running',
): Promise<boolean> {
  const since = s.snapshot.peek();
  const settledAtTap = running && engineSettled(since);
  return start().then(async (ok) => {
    if (!ok || !(await waitForSignal(s.audio, audioReady, AUDIO_START_WAIT_MS))) return false;
    return waitFor(() => {
      const state = s.audio.value.state;
      if (state !== 'starting' && state !== 'running') return false;
      const buf = s.snapshot.value;
      const settled = buf === since ? settledAtTap : engineSettled(buf);
      return settled ? true : null;
    }, ENGINE_SETTLE_WAIT_MS);
  });
}
