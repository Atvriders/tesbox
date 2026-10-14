import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S, STATE_LEN } from '../../src/contracts';
import type { AudioState, AudioStatus } from '../../src/app/store';
import { BENCH_KS, BENCH_STEP_MS } from '../../src/audio/engine-audio';
import { CRANK_SETTLE_END_S } from '../../src/sim/sim-core';
import {
  AUDIO_START_WAIT_MS,
  ENGINE_SETTLE_WAIT_MS,
  audioReady,
  engineReady,
  engineSettled,
  waitFor,
  waitForSignal,
} from '../../src/ui/wait';

/** A worklet snapshot: the engine in `gear` (0 while cranking, stopping or off), the DSP rendered `benchK`× per quantum. */
function snap(gear: number, benchK = 1): Float64Array {
  const b = new Float64Array(STATE_LEN);
  b[S.gear] = gear;
  b[S.benchK] = benchK;
  return b;
}

const audioIn = (state: AudioStatus): AudioState => ({ state, route: 'direct-anchor', tier: null });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('waitFor / waitForSignal', () => {
  it('resolves true at once when the value already passes', async () => {
    await expect(waitForSignal(signal(3), (v) => (v > 2 ? true : null), 1000)).resolves.toBe(true);
    await expect(waitFor(() => true, 1000)).resolves.toBe(true);
  });

  it('resolves when a later value passes or fails, and stops listening', async () => {
    const s = signal(0);
    let calls = 0;
    const ok = waitForSignal(s, (v) => (calls++, v === 2 ? true : v < 0 ? false : null), 1000);
    s.value = 1;
    s.value = 2;
    await expect(ok).resolves.toBe(true);
    const seen = calls;
    s.value = 3;
    expect(calls).toBe(seen);
    const bad = waitForSignal(s, (v) => (v < 0 ? false : null), 1000);
    s.value = -1;
    await expect(bad).resolves.toBe(false);
  });

  it('resolves false after the timeout', async () => {
    const s = signal(0);
    const p = waitForSignal(s, () => null, 500);
    vi.advanceTimersByTime(499);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).resolves.toBe(false);
  });

  it('waitFor re-evaluates when any signal its verdict read changes', async () => {
    const a = signal(0);
    const b = signal(0);
    const p = waitFor(() => (a.value > 0 && b.value > 0 ? true : null), 1000);
    a.value = 1;
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    b.value = 1;
    await expect(p).resolves.toBe(true);
  });
});

describe('audioReady', () => {
  it('running → yes; stopped or failed → no; starting or interrupted → keep waiting', () => {
    expect(audioReady(audioIn('running'))).toBe(true);
    expect(audioReady(audioIn('off'))).toBe(false);
    expect(audioReady(audioIn('error'))).toBe(false);
    expect(audioReady(audioIn('starting'))).toBeNull();
    expect(audioReady(audioIn('interrupted'))).toBeNull();
  });
});

describe('engineSettled', () => {
  it('needs the engine in gear: out of its crank (SimCore reports gear 0 while cranking and stopping)', () => {
    expect(engineSettled(snap(0))).toBe(false);
    expect(engineSettled(snap(1))).toBe(true);
    expect(engineSettled(snap(4))).toBe(true);
    expect(engineSettled(new Float64Array(STATE_LEN))).toBe(false); // the store's empty snapshot
  });

  it('and no tier-benchmark step rendering the DSP more than once per quantum (0 = not reported)', () => {
    for (const k of [2, 4, 8]) expect(engineSettled(snap(1, k)), `k = ${k}`).toBe(false);
    expect(engineSettled(snap(1, 1))).toBe(true);
    expect(engineSettled(snap(1, 0))).toBe(true);
  });

  it('the 2.5 s crank outlasts the whole tier benchmark EngineAudio runs inside it', () => {
    expect(CRANK_SETTLE_END_S * 1000).toBeGreaterThan(BENCH_KS.length * BENCH_STEP_MS);
    expect(ENGINE_SETTLE_WAIT_MS).toBeGreaterThan(CRANK_SETTLE_END_S * 1000);
  });
});

describe('engineReady (start from the tap, then wait for the audio and the end of the crank)', () => {
  /** Store stand-ins: the audio state and the latest snapshot. */
  function engine(state: AudioStatus = 'off', buf: Float64Array = snap(0)) {
    const audio = signal(audioIn(state));
    const snapshot = signal(buf);
    return {
      audio,
      snapshot,
      set: (s: AudioStatus) => {
        audio.value = audioIn(s);
      },
    };
  }

  /** Records whether the promise settled, and how. */
  function track(p: Promise<boolean>) {
    const r: { value: boolean | undefined; error: unknown } = { value: undefined, error: undefined };
    p.then(
      (v) => (r.value = v),
      (e: unknown) => (r.error = e),
    );
    return r;
  }

  it('calls start at once (inside the tap), then resolves at the first fresh snapshot in gear', async () => {
    const e = engine();
    let starts = 0;
    const r = track(
      engineReady(e, () => {
        starts++;
        e.set('starting');
        return Promise.resolve(true);
      }),
    );
    expect(starts).toBe(1); // synchronously
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined(); // audio still starting
    e.set('running');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined(); // cranking: nothing in gear yet
    e.snapshot.value = snap(0, 4); // the crank, with the tier benchmark at k = 4
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined();
    e.snapshot.value = snap(1, 8); // in gear, but a benchmark step still renders the DSP 8×
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined();
    e.snapshot.value = snap(1, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe(true);
  });

  it('an engine running settled at the tap is ready at once (start still asked, a no-op)', async () => {
    const e = engine('running', snap(2));
    let starts = 0;
    const r = track(
      engineReady(e, () => {
        starts++;
        return Promise.resolve(true);
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(1);
    expect(r.value).toBe(true);
  });

  it('running: false at the tap (a stop is fading out) waits for a fresh snapshot instead', async () => {
    const e = engine('running', snap(2));
    const r = track(engineReady(e, () => Promise.resolve(true), false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.value).toBeUndefined();
    e.snapshot.value = snap(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe(true);
  });

  it('judges by the latest snapshot once one arrived after the tap (a queued restart took a while)', async () => {
    const e = engine('running', snap(2)); // in gear at the tap…
    let release: (ok: boolean) => void = () => {};
    const r = track(engineReady(e, () => new Promise<boolean>((res) => (release = res))));
    e.snapshot.value = snap(0); // …but the engine stops, and a new one cranks
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined();
    e.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe(true);
  });

  it('a snapshot from before the tap does not count (an interrupted engine is rebuilt and cranks again)', async () => {
    const e = engine('interrupted', snap(3));
    const r = track(
      engineReady(e, () => {
        e.set('running');
        return Promise.resolve(true);
      }),
    );
    await vi.advanceTimersByTimeAsync(ENGINE_SETTLE_WAIT_MS - 1);
    expect(r.value).toBeUndefined();
    e.snapshot.value = snap(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBe(true);
  });

  it('false when the start fails, when the audio fails or never runs, or when the engine never settles', async () => {
    const refused = engine();
    const r1 = track(engineReady(refused, () => Promise.resolve(false)));
    await vi.advanceTimersByTimeAsync(0);
    expect(r1.value).toBe(false);

    const failed = engine();
    const r2 = track(engineReady(failed, () => Promise.resolve(true)));
    failed.set('error');
    await vi.advanceTimersByTimeAsync(0);
    expect(r2.value).toBe(false);

    const stuck = engine('starting');
    const r3 = track(engineReady(stuck, () => Promise.resolve(true)));
    await vi.advanceTimersByTimeAsync(AUDIO_START_WAIT_MS - 1);
    expect(r3.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r3.value).toBe(false);

    const cranking = engine('running');
    const r4 = track(engineReady(cranking, () => Promise.resolve(true), false));
    await vi.advanceTimersByTimeAsync(ENGINE_SETTLE_WAIT_MS - 1);
    expect(r4.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r4.value).toBe(false);
  });

  it('gives up at once when the audio stops running while the engine settles', async () => {
    for (const next of ['off', 'error', 'interrupted'] as const) {
      const e = engine('running');
      const r = track(engineReady(e, () => Promise.resolve(true), false));
      await vi.advanceTimersByTimeAsync(500);
      expect(r.value, next).toBeUndefined();
      e.set(next);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.value, next).toBe(false);
    }
  });

  it('rejects only when start rejects', async () => {
    const e = engine();
    const r = track(engineReady(e, () => Promise.reject(new Error('boom'))));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeInstanceOf(Error);
  });
});
