import { signal } from '@preact/signals';
import { describe, expect, it } from 'vitest';
import { F, S, STATE_LEN } from '../../src/contracts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/app/settings';
import * as store from '../../src/app/store';
import type { AudioState } from '../../src/app/store';
import type { EngineAudioDiagnostics } from '../../src/audio/engine-audio';
import type { ViewportInfo } from '../../src/platform/detect';
import {
  INPUT_LOG_SIZE,
  InputLog,
  SessionStats,
  buildDiagSummary,
  decodeFlags,
  diagnosticsPanels,
  diagnosticsReturn,
  formatInputEvent,
  openDiagnostics,
  qrScale,
  sessionStats,
  startSessionStats,
  type DiagPanel,
  type DiagSummaryParts,
  type DiagViewParts,
} from '../../src/ui/diagnostics';
import { STR } from '../../src/ui/strings';

/** A worklet snapshot with `over` applied (benchK 1, busyFrac 0.2 by default). */
function snap(over: Partial<Record<keyof typeof S, number>> = {}): Float64Array {
  const b = new Float64Array(STATE_LEN);
  b[S.benchK] = 1;
  b[S.busyFrac] = 0.2;
  for (const [k, v] of Object.entries(over)) b[S[k as keyof typeof S]] = v;
  return b;
}

// ───────────────────────────── input log ─────────────────────────────

describe('InputLog', () => {
  it('keeps the newest 40 events, oldest first', () => {
    expect(INPUT_LOG_SIZE).toBe(40);
    const log = new InputLog();
    for (let i = 0; i < 45; i++) log.push('key', `k${i}`, i * 100);
    const e = log.entries();
    expect(e).toHaveLength(40);
    expect(e[0]).toEqual({ tMs: 500, source: 'key', detail: 'k5' });
    expect(e[39]).toEqual({ tMs: 4400, source: 'key', detail: 'k44' });
  });

  it('notifies subscribers on every push until they unsubscribe', () => {
    const log = new InputLog();
    let calls = 0;
    const off = log.subscribe(() => calls++);
    log.push('paddle', 'up', 1);
    log.push('media', 'nexttrack: up', 2);
    off();
    log.push('gamepad', 'RB: up', 3);
    expect(calls).toBe(2);
  });

  it('formats an event as "t=<s>s <source> <detail>"', () => {
    expect(formatInputEvent({ tMs: 12345, source: 'media', detail: 'nexttrack: up' })).toBe('t=12.3s media nexttrack: up');
    expect(formatInputEvent({ tMs: 0, source: 'paddle', detail: 'down' })).toBe('t=0.0s paddle down');
  });
});

// ───────────────────────────── flags ─────────────────────────────

describe('decodeFlags', () => {
  it('names the set bits in bit order', () => {
    expect(decodeFlags(F.GPS_LOST | F.LIMITER | F.SHIFT_REFUSED)).toEqual(['GPS_LOST', 'LIMITER', 'SHIFT_REFUSED']);
    expect(decodeFlags(F.OVERLOAD | F.PREDICTING)).toEqual(['PREDICTING', 'OVERLOAD']);
  });

  it('is empty for no flags or an unusable value', () => {
    expect(decodeFlags(0)).toEqual([]);
    expect(decodeFlags(Number.NaN)).toEqual([]);
  });
});

// ───────────────────────────── session counters ─────────────────────────────

describe('SessionStats', () => {
  it('counts each overload episode once', () => {
    const st = new SessionStats();
    let t = 10;
    const push = (flags: number): void => st.pushSnapshot(snap({ time: (t += 0.4), flags }));
    push(0);
    push(F.OVERLOAD);
    push(F.OVERLOAD);
    push(0);
    push(F.OVERLOAD | F.LIMITER);
    expect(st.counters().overloadEvents).toBe(2);
  });

  it('ignores overload caused by the start-up benchmark, also while its busy windows drain', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 0.5, benchK: 4 }));
    st.pushSnapshot(snap({ time: 1.0, benchK: 8, flags: F.OVERLOAD }));
    st.pushSnapshot(snap({ time: 1.6, benchK: 1, flags: 0 }));
    st.pushSnapshot(snap({ time: 2.4, benchK: 1, flags: F.OVERLOAD })); // windows filled during k = 8
    st.pushSnapshot(snap({ time: 3.0, benchK: 1, flags: 0 }));
    expect(st.counters().overloadEvents).toBe(0);
    st.pushSnapshot(snap({ time: 6.0, benchK: 1, flags: F.OVERLOAD })); // well after the benchmark
    expect(st.counters().overloadEvents).toBe(1);
  });

  it('counts an overload that rose during the benchmark grace and is still up after it, once', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 1.0, benchK: 8, flags: F.OVERLOAD }));
    let t = 1.0;
    for (let i = 0; i < 20; i++) st.pushSnapshot(snap({ time: (t += 0.4), flags: F.OVERLOAD })); // grace ends at 4.0 s
    expect(st.counters().overloadEvents).toBe(1);
    for (let i = 0; i < 20; i++) st.pushSnapshot(snap({ time: (t += 0.4), flags: F.OVERLOAD }));
    expect(st.counters().overloadEvents).toBe(1);
  });

  it('ignores a benchmark overload that clears within the grace', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 1.0, benchK: 8, flags: F.OVERLOAD }));
    st.pushSnapshot(snap({ time: 2.0, flags: F.OVERLOAD }));
    st.pushSnapshot(snap({ time: 3.9, flags: 0 }));
    st.pushSnapshot(snap({ time: 4.5, flags: 0 }));
    expect(st.counters().overloadEvents).toBe(0);
  });

  it('counts overload in a rebuilt worklet at once: its clock restarted, it runs no benchmark', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 1.5, benchK: 8 }));
    st.pushSnapshot(snap({ time: 20, flags: 0 }));
    st.pushSnapshot(snap({ time: 0.3, flags: F.OVERLOAD })); // recover() rebuilt the context
    expect(st.counters().overloadEvents).toBe(1);
  });

  it('sums non-finite resets across rebuilt worklets (whose counters and clocks restart)', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 5, nonFiniteResets: 1 }));
    st.pushSnapshot(snap({ time: 6, nonFiniteResets: 3 }));
    st.pushSnapshot(snap({ time: 0.1, nonFiniteResets: 0 })); // recover() rebuilt the context
    st.pushSnapshot(snap({ time: 0.5, nonFiniteResets: 2 }));
    expect(st.counters().nonFiniteResets).toBe(5);
  });

  it('records the highest busy fraction outside the benchmark', () => {
    const st = new SessionStats();
    st.pushSnapshot(snap({ time: 1, benchK: 8, busyFrac: 0.95 }));
    st.pushSnapshot(snap({ time: 9, busyFrac: 0.31 }));
    st.pushSnapshot(snap({ time: 10, busyFrac: Number.NaN }));
    st.pushSnapshot(snap({ time: 11, busyFrac: 0.27 }));
    expect(st.counters().maxBusyFrac).toBeCloseTo(0.31, 12);
    expect(new SessionStats().counters().maxBusyFrac).toBeNull();
  });

  it('counts audio that stopped without the user (interrupted) and audio errors, per transition', () => {
    const st = new SessionStats();
    for (const s of ['off', 'starting', 'running', 'interrupted', 'interrupted', 'running', 'interrupted', 'error', 'off'] as const) {
      st.pushAudio(s);
    }
    expect(st.counters().interruptions).toBe(2);
    expect(st.counters().audioErrors).toBe(1);
  });

  it('startSessionStats feeds a SessionStats from the snapshot and audio signals until stopped', () => {
    const snapshot = signal<Float64Array>(snap({ time: 1 }));
    const audio = signal<AudioState>({ state: 'off', route: 'direct-anchor', tier: null });
    const st = new SessionStats();
    const stop = startSessionStats(snapshot, audio, st);
    snapshot.value = snap({ time: 5, flags: F.OVERLOAD });
    audio.value = { state: 'interrupted', route: 'direct-anchor', tier: 'full' };
    stop();
    snapshot.value = snap({ time: 6 });
    snapshot.value = snap({ time: 7, flags: F.OVERLOAD });
    expect(st.counters()).toMatchObject({ overloadEvents: 1, interruptions: 1 });
  });

  it('the app-wide counters follow the store from load', () => {
    const before = sessionStats.counters().interruptions;
    store.audio.value = { state: 'interrupted', route: 'direct-anchor', tier: 'lite' };
    store.audio.value = { state: 'off', route: 'direct-anchor', tier: 'lite' };
    expect(sessionStats.counters().interruptions).toBe(before + 1);
  });
});

// ───────────────────────────── QR summary ─────────────────────────────

const VIEWPORT: ViewportInfo = { dpr: 1.53, screen: [1183, 920], inner: [773, 601], visual: [773, 601], maxTouchPoints: 10 };

const AUDIO_DIAG: EngineAudioDiagnostics = {
  contextState: 'running',
  sampleRate: 48000,
  baseLatencyS: 0.01,
  outputLatencyS: 0.099,
  latencyHint: 'balanced',
  recoveries: { resumeOk: 1, resumeFail: 0, recreate: 2 },
  bench: { headroomK: 8, steps: [{ k: 1, ratio: 1, overloaded: false, busyFrac: 0.1 }] },
};

function parts(over: Partial<DiagSummaryParts> = {}): DiagSummaryParts {
  return {
    sha: 'abc1234',
    at: '2026-10-14T12:00:00.000Z',
    env: { ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', mcu: 'amd', viewport: VIEWPORT },
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, teslaId: 'model3-highland-lr-awd', noticesSeen: true, source: 'demo' }),
    audio: { state: 'running', route: 'direct-anchor', tier: 'full' },
    audioDiag: AUDIO_DIAG,
    gps: { status: 'ok', parked: true, fixAgeS: 1.234 },
    snapshot: snap({ time: 42.5, rpm: 3456.7, gear: 3, speedMps: 17.123, load: 0.4567, flags: F.SHIFTING | F.SPEED_UNUSABLE, fixesAccepted: 30, fixesRejected: 2 }),
    counters: { overloadEvents: 1, interruptions: 0, audioErrors: 0, nonFiniteResets: 0, snapshots: 900, maxBusyFrac: 0.3 },
    inputs: [
      { tMs: 1000, source: 'paddle', detail: 'up' },
      { tMs: 2500, source: 'media', detail: 'nexttrack: up' },
    ],
    ...over,
  };
}

describe('buildDiagSummary', () => {
  it('reports statistics: snapshot fields (rounded), decoded flags, audio, GPS status and counters', () => {
    const s = buildDiagSummary(parts());
    expect(s.v).toBe(1);
    expect(s.sha).toBe('abc1234');
    expect(s.snapshot).toMatchObject({ rpm: 3457, gear: 3, speedMps: 17.12, load: 0.457, fixesAccepted: 30, fixesRejected: 2 });
    expect(s.snapshot.flags).toEqual(['SHIFTING', 'SPEED_UNUSABLE']);
    expect(s.audio).toMatchObject({ state: 'running', route: 'direct-anchor', tier: 'full', outputLatencyS: 0.099 });
    expect(s.audio.recoveries).toEqual({ resumeOk: 1, resumeFail: 0, recreate: 2 });
    expect(s.gps).toEqual({ status: 'ok', parked: true, fixAgeS: 1.23 });
    expect(s.counters.overloadEvents).toBe(1);
    expect(s.inputs).toEqual(['t=1.0s paddle up', 't=2.5s media nexttrack: up']);
    expect(s.settings).toMatchObject({ engineId: 'i5-turbo-25', source: 'demo', teslaId: 'model3-highland-lr-awd', notListed: false });
  });

  it('carries no coordinate keys and no unlisted fields of its parts', () => {
    const leaky = { ...parts().settings, lat: 52.1, lon: 4.3 } as unknown as DiagSummaryParts['settings'];
    const json = JSON.stringify(buildDiagSummary(parts({ settings: leaky })));
    expect(json).not.toMatch(/"(lat|lon|latitude|longitude|coords|position)"/i);
    expect(json).not.toContain('52.1');
  });

  it('refuses to export when a coordinate key reaches it (assertNoCoordinates guard)', () => {
    const viewport = { ...VIEWPORT, coords: { latitude: 1 } } as unknown as ViewportInfo;
    expect(() => buildDiagSummary(parts({ env: { ua: 'x', mcu: 'intel', viewport } }))).toThrow(/coord/);
  });

  it('turns unknown numbers into null (JSON has no NaN)', () => {
    const s = buildDiagSummary(parts({ snapshot: snap({ busyFrac: Number.NaN }), gps: { status: 'off', parked: false, fixAgeS: null } }));
    expect(s.snapshot.busyFrac).toBeNull();
    expect(s.gps.fixAgeS).toBeNull();
  });
});

describe('diagnosticsPanels — the screen as label/value text', () => {
  function view(over: Partial<DiagViewParts> = {}): DiagViewParts {
    return { ...parts(), parked: true, sw: 'registered', ...over };
  }
  const row = (panels: DiagPanel[], label: string): string | undefined =>
    panels.flatMap((p) => p.rows).find(([k]) => k === label)?.[1];

  it('has the engine, GPS, audio, counter and platform panels', () => {
    expect(diagnosticsPanels(view()).map((p) => p.title)).toEqual([
      STR.diag.engine,
      STR.diag.gps,
      STR.diag.audio,
      STR.diag.counters,
      STR.diag.platform,
    ]);
  });

  it('shows each value with its unit', () => {
    const p = diagnosticsPanels(view());
    expect(row(p, STR.diag.f.time)).toBe('42.50\u00a0s'); // a no-break space keeps each number with its unit
    expect(row(p, STR.diag.f.speed)).toBe('17.12\u00a0m/s · 38\u00a0mph');
    expect(row(p, STR.diag.f.busy)).toBe('20\u00a0%');
    expect(row(p, STR.diag.f.fixAge)).toBe('1.2\u00a0s');
    expect(row(p, STR.diag.f.parked)).toBe('yes');
    expect(row(p, STR.diag.f.sampleRate)).toBe('48000\u00a0Hz');
    expect(row(p, STR.diag.f.baseLatency)).toBe('10\u00a0ms');
    expect(row(p, STR.diag.f.outputLatency)).toBe('99\u00a0ms');
    expect(row(p, STR.diag.f.maxBusy)).toBe('30\u00a0%');
    expect(row(p, STR.diag.f.viewport)).toBe('773 × 601');
    expect(row(p, STR.diag.f.screen)).toBe('1183 × 920');
    expect(row(p, STR.diag.f.flags)).toBe('SHIFTING, SPEED_UNUSABLE');
    expect(row(p, STR.diag.f.fixes)).toBe('30\u00a0accepted, 2\u00a0rejected');
    expect(row(p, STR.diag.f.recoveries)).toBe('1\u00a0resumed, 0\u00a0failed, 2\u00a0rebuilt');
  });

  it('shows the app service worker registration outcome (phase-4 contract T5: "service worker: unsupported")', () => {
    for (const sw of ['pending', 'registered', 'unsupported', 'failed'] as const) {
      expect(row(diagnosticsPanels(view({ sw })), STR.diag.f.serviceWorker), sw).toBe(STR.diag.swStates[sw]);
    }
    expect(STR.diag.f.serviceWorker).toBe('Service worker');
    expect(STR.diag.swStates.unsupported).toBe('unsupported');
  });

  it('converts the speed to the display units, as Drive does', () => {
    const kmh = view({ settings: sanitizeSettings({ ...parts().settings, units: 'kmh' }) });
    expect(row(diagnosticsPanels(kmh), STR.diag.f.speed)).toBe('17.12\u00a0m/s · 62\u00a0km/h');
  });

  it('shows a dash for what is not known yet', () => {
    const p = diagnosticsPanels(
      view({ snapshot: snap({ busyFrac: Number.NaN, speedMps: Number.NaN }), gps: { status: 'off', parked: false, fixAgeS: null } }),
    );
    expect(row(p, STR.diag.f.busy)).toBe(STR.diag.none);
    expect(row(p, STR.diag.f.fixAge)).toBe(STR.diag.none);
    expect(row(p, STR.diag.f.speed)).toBe(`${STR.diag.none} · ${STR.diag.none}`);
    const noVisual = view({ env: { ...parts().env, viewport: { ...VIEWPORT, visual: null } } });
    expect(row(diagnosticsPanels(noVisual), STR.diag.f.visual)).toBe(STR.diag.none);
  });
});

describe('qrScale — module size that fits the screen', () => {
  it('fits a symbol plus its quiet zone into the available pixels, 2 … 8 px per module', () => {
    expect(qrScale(113, 440)).toBe(3); // version 24: 121 modules with the quiet zone
    expect(qrScale(21, 1000)).toBe(8);
    expect(qrScale(177, 200)).toBe(2);
  });
});

describe('openDiagnostics', () => {
  it('opens Diagnostics and remembers where Back returns to', () => {
    openDiagnostics('settings');
    expect(store.screen.value).toBe('diagnostics');
    expect(diagnosticsReturn()).toBe('settings');
    openDiagnostics('drive');
    expect(diagnosticsReturn()).toBe('drive');
  });
});
