import type { OutputRoute } from '../contracts';
import type { Features, Mcu, ViewportInfo } from '../platform/detect';
import type { AudioProbeState, BenchResult } from './audio';
import type { GpsModeSummary } from './gps-stats';
import type { InputCounts, MotionReport } from './inputs';
import type { EventLog, LogEntry } from './log';
import type { StorageReport } from './storage-probe';

export interface RouteObservation {
  miniplayer: 'yes' | 'no' | '?';
  survivesMinimise: 'yes' | 'no' | '?';
  wheelTilt: 'yes' | 'no' | '?';
  music: 'paused' | 'mixed' | '?';
  hiddenClockRatio: number | null;
}

/** Statistics-only probe export (spec §10.2 Diagnostics QR). Never contains coordinates. */
export interface ProbeSummary {
  v: 1;
  sha: string;
  /** ISO timestamp. */
  at: string;
  env: { ua: string; viewport: ViewportInfo; webgl: string | null; mcu: Mcu; features: Features };
  audio: (AudioProbeState & { bench: BenchResult[]; headroomK: number | null }) | null;
  routes: Partial<Record<OutputRoute, RouteObservation>>;
  gps: GpsModeSummary[];
  motion: MotionReport | null;
  storage: StorageReport | null;
  inputs: InputCounts;
  notes: Record<string, string>;
  /** Last ≤ 40 log entries formatted "t=12.3s kind detail", GPS fix lines excluded. */
  logTail: string[];
}

export const FORBIDDEN_KEYS: readonly string[] = Object.freeze([
  'lat',
  'lon',
  'latitude',
  'longitude',
  'coords',
  'position',
]);

const FORBIDDEN = new Set(FORBIDDEN_KEYS);
const LOG_TAIL = 40;

/** One log entry as text: "t=12.3s kind detail". Shared by the QR log tail and the probe page's log view. */
export function formatEntry(e: LogEntry): string {
  return `t=${(e.tMs / 1000).toFixed(1)}s ${e.kind} ${e.detail}`;
}

/**
 * GpsRunner's per-fix line (`gps` `fix age=…`). A GPS run logs about one per second, which would
 * push every audio, visibility and error event out of the 40-line tail; GpsStats summarises fixes.
 */
function isGpsFix(e: LogEntry): boolean {
  return e.kind === 'gps' && e.detail.startsWith('fix ');
}

/**
 * Throws if any own enumerable key at any depth matches FORBIDDEN_KEYS (case-insensitive).
 * The message names the JSON path, e.g. `$.gps[0].lat`. Cycles are visited once.
 */
export function assertNoCoordinates(value: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null || ArrayBuffer.isView(node)) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (FORBIDDEN.has(key.toLowerCase())) {
        throw new Error(`Probe summary contains forbidden coordinate key at ${childPath}`);
      }
      walk(child, childPath);
    }
  };
  walk(value, '$');
}

/** Assembles the export: adds `v: 1` and the formatted log tail (no GPS fix lines), then enforces the privacy guard. */
export function buildSummary(parts: Omit<ProbeSummary, 'v' | 'logTail'>, log: EventLog): ProbeSummary {
  const summary: ProbeSummary = {
    v: 1,
    sha: parts.sha,
    at: parts.at,
    env: parts.env,
    audio: parts.audio,
    routes: parts.routes,
    gps: parts.gps,
    motion: parts.motion,
    storage: parts.storage,
    inputs: parts.inputs,
    notes: parts.notes,
    logTail: log
      .entries()
      .filter((e) => !isGpsFix(e))
      .slice(-LOG_TAIL)
      .map(formatEntry),
  };
  assertNoCoordinates(summary);
  return summary;
}
