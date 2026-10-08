import { afterEach, describe, expect, it, vi } from 'vitest';
import { errText, EventLog, withTimeout, type LogEntry } from '../../src/probe/log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventLog', () => {
  it('stores entries oldest → newest with the given timestamps', () => {
    const log = new EventLog();
    log.push('note', 'a', 10);
    log.push('key', 'b', 20);
    expect(log.entries()).toEqual([
      { tMs: 10, kind: 'note', detail: 'a' },
      { tMs: 20, kind: 'key', detail: 'b' },
    ]);
  });

  it('stamps entries with performance.now() by default', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1234.5);
    const log = new EventLog();
    log.push('audio', 'running');
    expect(log.entries()[0]?.tMs).toBe(1234.5);
  });

  it('keeps only the newest `capacity` entries across many pushes, in order', () => {
    const log = new EventLog(3);
    for (let i = 1; i <= 7; i++) log.push('note', `n${i}`, i);
    expect(log.entries().map((e) => e.detail)).toEqual(['n5', 'n6', 'n7']);
    log.push('note', 'n8', 8);
    expect(log.entries().map((e) => e.detail)).toEqual(['n6', 'n7', 'n8']);
  });

  it('returns a partial buffer before it wraps', () => {
    const log = new EventLog(5);
    log.push('note', 'only', 1);
    expect(log.entries().map((e) => e.detail)).toEqual(['only']);
    expect(new EventLog(5).entries()).toEqual([]);
  });

  it('defaults to capacity 500', () => {
    const log = new EventLog();
    for (let i = 0; i < 501; i++) log.push('note', `n${i}`, i);
    const entries = log.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.detail).toBe('n1');
    expect(entries[499]?.detail).toBe('n500');
  });

  it('counts every push ever made, per kind and in total, including evicted ones', () => {
    const log = new EventLog(2);
    log.push('key', 'a', 1);
    log.push('key', 'b', 2);
    log.push('wheel', 'c', 3);
    log.push('key', 'd', 4);
    expect(log.count()).toBe(4);
    expect(log.count('key')).toBe(3);
    expect(log.count('wheel')).toBe(1);
    expect(log.count('gps')).toBe(0);
    expect(log.entries()).toHaveLength(2);
  });

  it('returns frozen entries that callers cannot corrupt', () => {
    const log = new EventLog();
    log.push('note', 'x', 1);
    const [entry] = log.entries();
    expect(Object.isFrozen(entry)).toBe(true);
    const copy = log.entries();
    copy.pop();
    expect(log.entries()).toHaveLength(1);
  });

  it('notifies subscribers on every push until they unsubscribe', () => {
    const log = new EventLog();
    const seen: LogEntry[] = [];
    const unsubscribe = log.subscribe((e) => seen.push(e));
    log.push('gamepad', 'connected', 1);
    log.push('visibility', 'hidden', 2);
    unsubscribe();
    log.push('visibility', 'visible', 3);
    expect(seen.map((e) => e.detail)).toEqual(['connected', 'hidden']);
    unsubscribe(); // idempotent
  });

  it('lets a subscriber unsubscribe itself during a notification', () => {
    const log = new EventLog();
    const calls: string[] = [];
    const off = log.subscribe(() => {
      calls.push('once');
      off();
    });
    log.subscribe((e) => calls.push(e.detail));
    log.push('note', 'a', 1);
    log.push('note', 'b', 2);
    expect(calls).toEqual(['once', 'a', 'b']);
  });

  it('keeps logging and notifying when a subscriber throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = new EventLog();
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error('ui broke');
    });
    log.subscribe((e) => seen.push(e.detail));
    expect(() => log.push('error', 'boom', 1)).not.toThrow();
    expect(seen).toEqual(['boom']);
    expect(log.count('error')).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects capacity %s', (capacity) => {
    expect(() => new EventLog(capacity)).toThrow(RangeError);
  });
});

describe('errText', () => {
  it('prefixes the error name except for a plain Error, and stringifies non-errors', () => {
    expect(errText(new Error('boom'))).toBe('boom');
    expect(errText(new TypeError('bad MIME type'))).toBe('TypeError: bad MIME type');
    expect(errText(new DOMException('denied', 'SecurityError'))).toBe('SecurityError: denied');
    expect(errText('plain')).toBe('plain');
    expect(errText(42)).toBe('42');
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('settles like p and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7);
    const err = new TypeError('boom');
    await expect(withTimeout(Promise.reject(err), 1000, 'x')).rejects.toBe(err);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with "<label> timed out after <ms> ms" when p never settles', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => undefined), 500, 'caches.open');
    const done = expect(p).rejects.toThrow('caches.open timed out after 500 ms');
    await vi.advanceTimersByTimeAsync(500);
    await done;
  });
});
