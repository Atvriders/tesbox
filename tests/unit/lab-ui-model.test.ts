/**
 * src/lab/ui/model.ts (phase-2c contract L3): the Sound Lab page state — voicing edits applied debounced
 * (≤ 150 ms) and only when the in-page check passes, resets, engine selection, the drive controls and events
 * (mirrored with the worklet's own transitions), segments, keys, A/B with level matching, export / import —
 * run in Node against a fake of the page's audio port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OUTPUT, type EngineVoicing } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import {
  APPLY_DEBOUNCE_MS,
  LabModel,
  type AbSide,
  type LabAudioEvents,
  type LabAudioPort,
  type LabLevels,
  type RefDecoded,
} from '../../src/lab/ui/model';
import type { LabToMain, MainToLab, MeterMsg } from '../../src/lab/ui/protocol';

const I5 = getEngine('i5-turbo-25');

class FakeAudio implements LabAudioPort {
  sampleRate: number | null = null;
  readonly posted: MainToLab[] = [];
  readonly starts: MainToLab[][] = [];
  readonly ab: [AbSide, number][] = [];
  readonly levels: LabLevels[] = [];
  readonly decodedBytes: number[] = [];
  events: LabAudioEvents | null = null;
  decoded: RefDecoded = { durationS: 1, sampleRate: 48000, channels: 1, rms: 0.1 };
  failDecode: Error | null = null;

  start(initial: () => readonly MainToLab[], events: LabAudioEvents): Promise<void> {
    this.starts.push(structuredClone([...initial()]));
    this.events = events;
    this.sampleRate = 48000;
    events.onState('running');
    events.onMessage({ type: 'ready' });
    return Promise.resolve();
  }

  post(msg: MainToLab): void {
    this.posted.push(structuredClone(msg));
  }

  loadReference(bytes: ArrayBuffer): Promise<RefDecoded> {
    this.decodedBytes.push(bytes.byteLength);
    return this.failDecode === null ? Promise.resolve(this.decoded) : Promise.reject(this.failDecode);
  }

  setAb(side: AbSide, fadeS: number): void {
    this.ab.push([side, fadeS]);
  }

  setLevels(levels: LabLevels): void {
    this.levels.push({ ...levels });
  }

  /** Messages of one type, in order. */
  of<T extends MainToLab['type']>(type: T): Extract<MainToLab, { type: T }>[] {
    return this.posted.filter((m): m is Extract<MainToLab, { type: T }> => m.type === type);
  }

  send(msg: LabToMain): void {
    this.events?.onMessage(msg);
  }
}

function meter(rmsDb: number, over: Partial<MeterMsg> = {}): MeterMsg {
  return { type: 'meter', rmsDb, peakDb: rmsDb + 10, rpm: 3000, gear: 1, limiter: false, boost: 0, limiterGrDb: 0, nonFiniteResets: 0, ...over };
}

function harness() {
  const audio = new FakeAudio();
  const saved: { fileName: string; text: string }[] = [];
  const copied: string[] = [];
  const model = new LabModel({
    audio,
    saveFile: (fileName, text) => saved.push({ fileName, text }),
    copyText: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
  });
  return { model, audio, saved, copied };
}

async function started() {
  const h = harness();
  await h.model.start();
  h.audio.posted.length = 0;
  return h;
}

function exportedFile(engineId: string, voicing: EngineVoicing): string {
  return JSON.stringify({ engineId, voicing: { ...voicing, estimated: true } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LabModel: start-up', () => {
  it('opens on the first engine with its shipped voicing, idling in 1st', () => {
    const { model } = harness();
    expect(model.engineId.value).toBe(ENGINES[0]?.id);
    expect(model.draft.value).toEqual(ENGINES[0]?.voicing);
    expect(model.drive.value.manual).toMatchObject({ rpm: ENGINES[0]?.spec.rpm.idle, gear: 1, load: 0, perspective: 'cabin', warm: true });
    expect(model.audioState.value).toBe('off');
  });

  it('Start posts the engine, tier, output, monitor level and manual control before anything else', async () => {
    const { model, audio } = harness();
    model.setRpm(3000);
    await model.start();
    const initial = audio.starts[0] ?? [];
    expect(initial.map((m) => m.type)).toEqual(['engine', 'tier', 'output', 'gain', 'manual']);
    expect(initial[0]).toMatchObject({ type: 'engine', def: { id: I5.id, voicing: I5.voicing } });
    expect(initial.slice(1, 4)).toEqual([
      { type: 'tier', value: 'full' },
      { type: 'output', config: DEFAULT_OUTPUT },
      { type: 'gain', db: -12 },
    ]);
    expect(initial[4]).toMatchObject({ type: 'manual', rpm: 3000, gear: 1 });
    expect(model.audioState.value).toBe('running');
    expect(model.ready.value).toBe(true);
  });

  it('a second Start while running does nothing', async () => {
    const { model, audio } = await started();
    await model.start();
    expect(audio.starts).toHaveLength(1);
  });
});

describe('LabModel: voicing edits', () => {
  it(`applies once, ${APPLY_DEBOUNCE_MS} ms after the last edit (≤ 150 ms)`, async () => {
    expect(APPLY_DEBOUNCE_MS).toBeLessThanOrEqual(150);
    const { model, audio } = await started();
    model.editField(['pulse', 'alpha'], 12);
    vi.advanceTimersByTime(50);
    model.editField(['pulse', 'alpha'], 13);
    expect(model.draft.value.pulse.alpha).toBe(13);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS - 1);
    expect(audio.of('engine')).toHaveLength(0);
    expect(model.applyState.value).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(audio.of('engine').map((m) => m.def.voicing.pulse.alpha)).toEqual([13]);
    expect(model.applyState.value).toBe('applied');
  });

  it('flags a voicing the core would refuse (2 m header) and sends nothing until it is fixed', async () => {
    const { model, audio } = await started();
    model.editField(['headersM', 0], 2);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(model.applyState.value).toBe('flagged');
    expect(model.problems.value.map((p) => p.key)).toEqual(['headersM[0]']);
    expect(audio.of('engine')).toHaveLength(0);
    model.editField(['headersM', 0], 0.6);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(model.problems.value).toEqual([]);
    expect(audio.of('engine').map((m) => m.def.voicing.headersM[0])).toEqual([0.6]);
  });

  it('flags a schema violation and sends nothing', async () => {
    const { model, audio } = await started();
    model.editField(['intake', 'gain'], 1.5);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(model.problems.value.map((p) => p.key)).toEqual(['intake.gain']);
    expect(audio.of('engine')).toHaveLength(0);
  });

  it('Reset to default voicing applies defaultVoicing(spec); Reset to engine restores the shipped voicing', async () => {
    const { model, audio } = await started();
    model.editField(['cabin', 'lowpassHz'], 900);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    model.resetToDefault();
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(model.draft.value).toEqual(defaultVoicing(I5.spec));
    model.editField(['cabin', 'lowpassHz'], 950);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    model.resetToEngine();
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(model.draft.value).toEqual(I5.voicing);
    expect(audio.of('engine').map((m) => m.def.voicing.cabin.lowpassHz)).toEqual([900, 600, 950, I5.voicing.cabin.lowpassHz]);
  });

  it('does not re-send a voicing that did not change', async () => {
    const { model, audio } = await started();
    model.editField(['pulse', 'alpha'], 12);
    model.editField(['pulse', 'alpha'], I5.voicing.pulse.alpha);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(audio.of('engine')).toHaveLength(0);
  });

  it('shows a worklet refusal of an engine on the voicing panel', async () => {
    const { model, audio } = await started();
    audio.send({ type: 'error', message: 'engine: TesboxDspCore.configure: headersM[0] = 1.6 m is outside [0.0635, 1.5] m' });
    expect(model.applyState.value).toBe('flagged');
    expect(model.problems.value).toEqual([{ key: 'headersM[0]', message: 'headersM[0] = 1.6 m is outside [0.0635, 1.5] m' }]);
  });
});

describe('LabModel: engine and output', () => {
  it('selecting an engine sends it at once, loads its voicing and re-clamps the drive', async () => {
    const { model, audio } = await started();
    model.setRpm(7000); // within the five-cylinder's 7100 limiter
    const v8 = getEngine('v8-na-62'); // limiter 6600
    model.selectEngine(v8.id);
    expect(audio.of('engine').map((m) => m.def.id)).toEqual([v8.id]);
    expect(model.draft.value).toEqual(v8.voicing);
    expect(model.drive.value.manual.rpm).toBe(6600);
  });

  it('tier, sub preset and monitor level are posted; the monitor level also scales the reference', async () => {
    const { model, audio } = await started();
    model.setTier('lite');
    model.setSub('sub');
    model.setSub('no-sub');
    model.setMonitor(-20);
    model.setMonitor(-55);
    expect(audio.of('tier')).toEqual([{ type: 'tier', value: 'lite' }]);
    expect(audio.of('output').map((m) => m.config.subwoofer)).toEqual(['yes', DEFAULT_OUTPUT.subwoofer]);
    expect(audio.of('gain')).toEqual([
      { type: 'gain', db: -20 },
      { type: 'gain', db: -40 },
    ]);
    expect(audio.levels.at(-1)?.monitorGain).toBeCloseTo(0.01, 12); // −40 dB
  });
});

describe('LabModel: drive', () => {
  it('drive controls post the clamped manual control', async () => {
    const { model, audio } = await started();
    model.setRpm(99999);
    model.setLoad(-3);
    model.setGear(4);
    model.setValve('open');
    model.setDriveMode('sport');
    model.setWarm(false);
    model.setPerspective('outside');
    expect(audio.of('manual').at(-1)).toEqual({
      type: 'manual',
      rpm: 7100,
      load: -1,
      gear: 4,
      valve: 'open',
      perspective: 'outside',
      driveMode: 'sport',
      warm: false,
    });
  });

  it('Upshift posts the event and moves the page gear and rpm with it', async () => {
    const { model, audio } = await started();
    model.setRpm(4000);
    model.fire('upshift');
    expect(audio.of('event')).toEqual([{ type: 'event', ev: 'upshift' }]);
    const [r1, r2] = I5.spec.gearbox.overallRatios as [number, number];
    expect(model.drive.value.manual.gear).toBe(2);
    expect(model.drive.value.manual.rpm).toBeCloseTo((4000 * r2) / r1, 9);
    model.setLoad(0.3);
    expect(audio.of('manual').at(-1)).toMatchObject({ gear: 2, load: 0.3 });
  });

  it('Lift-off posts the event; the page load drops to 0 and stays there', async () => {
    const { model, audio } = await started();
    model.setLoad(0.8);
    model.fire('liftoff');
    expect(audio.of('event')).toEqual([{ type: 'event', ev: 'liftoff' }]);
    expect(model.drive.value).toMatchObject({ liftoff: true, manual: { load: 0 } });
    model.setRpm(5000);
    expect(audio.of('manual').at(-1)).toMatchObject({ rpm: 5000, load: 0 });
    expect(model.drive.value.liftoff).toBe(false);
  });

  it('Limiter and Ignition toggle', async () => {
    const { model } = await started();
    model.fire('limiter');
    model.fire('ignition');
    expect(model.drive.value).toMatchObject({ limiterHold: true, ignitionOn: false });
    model.fire('limiter');
    model.fire('ignition');
    expect(model.drive.value).toMatchObject({ limiterHold: false, ignitionOn: true });
  });

  it('posts no event before audio runs, nor one that would change nothing', async () => {
    const h = harness();
    h.model.fire('upshift');
    expect(h.audio.posted).toEqual([]);
    await h.model.start();
    h.model.setGear(7);
    h.audio.posted.length = 0;
    h.model.fire('upshift'); // top gear
    expect(h.audio.posted).toEqual([]);
  });

  it('plays and stops a segment; shifts wait while it plays', async () => {
    const { model, audio } = await started();
    model.segmentChoice.value = 'cruise4k';
    model.playSegment();
    expect(model.drive.value.segment).toBe('cruise4k');
    model.fire('upshift');
    model.stopSegment();
    expect(audio.posted).toEqual([
      { type: 'segment', name: 'cruise4k' },
      { type: 'segment', name: null },
    ]);
    expect(model.drive.value.segment).toBeNull();
  });

  it('keys drive the same actions; held E or B act once', async () => {
    const { model, audio } = await started();
    await model.loadReference({ name: 'ref.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    model.key({ kind: 'rpm', delta: 100 }, false);
    model.key({ kind: 'rpm', delta: 100 }, true);
    expect(model.drive.value.manual.rpm).toBe(I5.spec.rpm.idle + 200);
    model.key({ kind: 'load', delta: 0.05 }, false);
    model.key({ kind: 'load', delta: 0.05 }, true);
    model.key({ kind: 'load', delta: 0.05 }, true);
    expect(model.drive.value.manual.load).toBe(0.15);
    model.key({ kind: 'event', ev: 'upshift' }, false);
    model.key({ kind: 'event', ev: 'upshift' }, true);
    expect(audio.of('event')).toEqual([{ type: 'event', ev: 'upshift' }]);
    model.key({ kind: 'ab' }, false);
    model.key({ kind: 'ab' }, true);
    expect(audio.ab).toEqual([['B', 0.03]]);
  });
});

describe('LabModel: A/B', () => {
  it('loads a local clip, crossfades A ⇄ B in 30 ms', async () => {
    const { model, audio } = await started();
    expect(model.canCompare.value).toBe(false);
    await model.loadReference({ name: 'clip.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(44)) });
    expect(audio.decodedBytes).toEqual([44]);
    expect(model.ref.value).toEqual({ name: 'clip.wav', durationS: 1, sampleRate: 48000, channels: 1, rmsDb: -20 });
    model.toggleAb();
    expect(model.ab.value).toBe('B');
    model.toggleAb();
    expect(audio.ab).toEqual([
      ['B', 0.03],
      ['A', 0.03],
    ]);
  });

  it('reports a clip it cannot decode and keeps the previous one', async () => {
    const { model, audio } = await started();
    await model.loadReference({ name: 'a.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
    audio.failDecode = new Error('EncodingError: Unable to decode audio data');
    await model.loadReference({ name: 'b.txt', arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
    expect(model.ref.value?.name).toBe('a.wav');
    expect(model.notice.value).toMatchObject({ kind: 'error' });
    expect(model.notice.value?.text).toContain('b.txt');
  });

  it('Match level brings the louder side down to the quieter: reference −20 dB, lab meter −26 dB', async () => {
    const { model, audio } = await started();
    await model.loadReference({ name: 'clip.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    for (let i = 0; i < 25; i++) audio.send(meter(-26));
    model.matchLevel();
    expect(model.match.value).toEqual({ refGainDb: -6, labGainDb: 0 });
    const last = audio.levels.at(-1);
    expect(last?.refGain).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(last?.labGain).toBe(1);
    expect(last?.monitorGain).toBeCloseTo(10 ** (-12 / 20), 12);
  });

  it('refuses to match a silent lab', async () => {
    const { model, audio } = await started();
    await model.loadReference({ name: 'clip.wav', arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    audio.send(meter(-200));
    model.matchLevel();
    expect(model.match.value).toBeNull();
    expect(model.notice.value?.kind).toBe('error');
  });
});

describe('LabModel: export and import', () => {
  it('Export downloads <engineId>.voicing.json with estimated: true; Copy copies the same text', async () => {
    const { model, saved, copied } = await started();
    model.editField(['pulse', 'alpha'], 11);
    model.exportFile();
    await model.copyExport();
    expect(saved.map((s) => s.fileName)).toEqual(['i5-turbo-25.voicing.json']);
    const file = JSON.parse(saved[0]?.text ?? '{}') as { engineId: string; voicing: EngineVoicing };
    expect(file.engineId).toBe('i5-turbo-25');
    expect(file.voicing.pulse.alpha).toBe(11);
    expect(file.voicing.estimated).toBe(true);
    expect(copied).toEqual([saved[0]?.text]);
  });

  it('Import applies a valid file at once, switching to its engine', async () => {
    const { model, audio } = await started();
    const v8 = getEngine('v8-na-50');
    const voicing = { ...v8.voicing, cabin: { lowpassHz: 750 } };
    await model.importFile({ name: 'v8.voicing.json', text: () => Promise.resolve(exportedFile(v8.id, voicing)) });
    expect(model.engineId.value).toBe(v8.id);
    expect(model.draft.value.cabin.lowpassHz).toBe(750);
    expect(audio.of('engine').at(-1)?.def.voicing.cabin.lowpassHz).toBe(750);
    expect(model.notice.value?.kind).toBe('info');
  });

  it('Import refuses an invalid file and changes nothing', async () => {
    const { model, audio } = await started();
    model.editField(['pulse', 'alpha'], 11);
    const bad = exportedFile(I5.id, { ...I5.voicing, launchRpm: 50 });
    await model.importFile({ name: 'bad.json', text: () => Promise.resolve(bad) });
    expect(model.draft.value.pulse.alpha).toBe(11);
    expect(model.notice.value?.kind).toBe('error');
    expect(model.notice.value?.text).toMatch(/launchRpm/);
    vi.advanceTimersByTime(APPLY_DEBOUNCE_MS);
    expect(audio.of('engine').map((m) => m.def.voicing.pulse.alpha)).toEqual([11]);
  });
});

describe('LabModel: meter', () => {
  it('shows the latest meter message', async () => {
    const { model, audio } = await started();
    audio.send(meter(-23, { rpm: 4500, gear: 3 }));
    expect(model.meter.value).toMatchObject({ rmsDb: -23, rpm: 4500, gear: 3 });
  });
});
