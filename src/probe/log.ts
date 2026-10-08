export type LogKind =
  | 'mediasession'
  | 'key'
  | 'wheel'
  | 'gamepad'
  | 'visibility'
  | 'audio'
  | 'gps'
  | 'motion'
  | 'storage'
  | 'note'
  | 'error';

export interface LogEntry {
  /** performance.now() at push, ms. */
  tMs: number;
  kind: LogKind;
  detail: string;
}

/**
 * Fixed-capacity ring buffer of probe events. Keeps the newest `capacity` entries, counts every
 * push ever made (per kind and in total), and notifies subscribers synchronously on each push.
 * Main-thread only; entries are frozen so subscribers and readers can share them safely.
 */
export class EventLog {
  private readonly capacity: number;
  private readonly buffer: (LogEntry | undefined)[];
  private head = 0; // index the next push writes to
  private size = 0;
  private total = 0;
  private readonly totals = new Map<LogKind, number>();
  private readonly subscribers = new Set<(e: LogEntry) => void>();

  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventLog capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buffer = new Array<LogEntry | undefined>(capacity).fill(undefined);
  }

  push(kind: LogKind, detail: string, tMs: number = performance.now()): void {
    const entry: LogEntry = Object.freeze({ tMs, kind, detail });
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this.total++;
    this.totals.set(kind, (this.totals.get(kind) ?? 0) + 1);
    for (const fn of Array.from(this.subscribers)) {
      try {
        fn(entry);
      } catch (err) {
        // A broken UI subscriber must not stop logging or starve the other subscribers.
        console.error('EventLog subscriber failed', err);
      }
    }
  }

  /** Retained entries, oldest → newest. */
  entries(): LogEntry[] {
    const out: LogEntry[] = [];
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const entry = this.buffer[(start + i) % this.capacity];
      if (entry) out.push(entry);
    }
    return out;
  }

  /** Number of entries ever pushed (of `kind`, or of every kind), including evicted ones. */
  count(kind?: LogKind): number {
    return kind === undefined ? this.total : (this.totals.get(kind) ?? 0);
  }

  /** Calls `fn` for every later push; returns the unsubscribe function. */
  subscribe(fn: (e: LogEntry) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}

/** Uniform error text for log details: "<Name>: <message>", or just the message for a plain Error. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

/**
 * Rejects with `Error('<label> timed out after <ms> ms')` if `p` has not settled within `ms`, so a
 * hung browser promise cannot stall the caller; otherwise settles exactly like `p` (a rejection
 * value is passed through unchanged — `errText` formats any value).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
