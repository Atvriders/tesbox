/**
 * The Sound Lab's audio graph on the main thread (phase-2c contract L1/L3), the real LabAudioPort.
 *
 * - start() runs from the Start audio tap: it creates the AudioContext synchronously, before any await (the
 *   user gesture), at the device rate when TesboxDspCore can run it (28–48 kHz), else a resampled 48 kHz
 *   context — as src/audio/engine-audio.ts does. Then it adds the lab worklet module, loaded the way the app
 *   loads its own (`./lab-worklet.ts?worker&url`), creates the 'tesbox-lab' node, posts `initial()` first and
 *   resumes the context (waiting at most 1 s, then reporting it as it is). A start while the context exists
 *   resumes it. A failure leaves nothing behind.
 * - A/B: lab node → match gain → A gain → output; reference clip (an AudioBufferSourceNode, looped) → match ×
 *   monitor gain → B gain → output. setAb() crossfades the A and B gains linearly over `fadeS` from now.
 * - loadReference(): decodeAudioData in the page — with the live context, or an OfflineAudioContext before
 *   Start; the file is never sent anywhere — then loops it on the B side (replacing a playing clip).
 * Level changes glide with a 10 ms time constant; the first build sets them outright.
 */
import { MAX_SAMPLE_RATE } from '../../contracts';
import { MIN_SAMPLE_RATE } from '../../dsp/dsp-core';
import labWorkletUrl from './lab-worklet.ts?worker&url';
import { clipRms } from './level';
import type { AbSide, AudioRun, LabAudioEvents, LabAudioPort, LabLevels, RefDecoded } from './model';
import { LAB_PROCESSOR, MONITOR_DEFAULT_DB, type LabToMain, type MainToLab } from './protocol';

const NODE_OPTIONS: AudioWorkletNodeOptions = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] };
/** A hung module fetch must not leave the page in 'starting' forever. */
const ADD_MODULE_TIMEOUT_MS = 10_000;
/** resume() can stay pending (no user activation): after this the context is reported as it is (suspended). */
const RESUME_TIMEOUT_MS = 1000;
const LEVEL_TAU_S = 0.01;
/** Rate of the decode-only context used before Start (decodeAudioData resamples to it; playback resamples again). */
const DECODE_RATE = 48000;

/** The Web Audio constructors and the worklet URL (injected by the unit tests). */
export interface LabAudioEnv {
  AudioContext: typeof AudioContext;
  AudioWorkletNode: typeof AudioWorkletNode;
  OfflineAudioContext: typeof OfflineAudioContext;
  workletUrl: string;
}

interface Graph {
  ctx: AudioContext;
  node: AudioWorkletNode;
  labMatch: GainNode;
  labAb: GainNode;
  refGain: GainNode;
  refAb: GainNode;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  return String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

/** Waits for `p` at most `ms`; never rejects (a rejection or a timeout just ends the wait). */
function settle(p: Promise<unknown>, ms: number): Promise<void> {
  return withTimeout(p, ms, 'settle').then(
    () => undefined,
    () => undefined,
  );
}

function isLabMessage(data: unknown): data is LabToMain {
  if (typeof data !== 'object' || data === null) return false;
  const t = (data as { type?: unknown }).type;
  return t === 'ready' || t === 'error' || t === 'meter';
}

function mapState(s: AudioContextState | 'interrupted'): AudioRun {
  if (s === 'running') return 'running';
  if (s === 'closed') return 'error';
  return 'suspended';
}

export class LabAudio implements LabAudioPort {
  private readonly env: LabAudioEnv;
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private refBuffer: AudioBuffer | null = null;
  private refSource: AudioBufferSourceNode | null = null;
  private side: AbSide = 'A';
  private levels: LabLevels = { refGain: 1, labGain: 1, monitorGain: 10 ** (MONITOR_DEFAULT_DB / 20) };

  constructor(env: Partial<LabAudioEnv> = {}) {
    this.env = {
      AudioContext: env.AudioContext ?? globalThis.AudioContext,
      AudioWorkletNode: env.AudioWorkletNode ?? globalThis.AudioWorkletNode,
      OfflineAudioContext: env.OfflineAudioContext ?? globalThis.OfflineAudioContext,
      workletUrl: env.workletUrl ?? labWorkletUrl,
    };
  }

  get sampleRate(): number | null {
    return this.ctx === null ? null : this.ctx.sampleRate;
  }

  start(initial: () => readonly MainToLab[], events: LabAudioEvents): Promise<void> {
    const existing = this.ctx;
    if (existing !== null) {
      if (existing.state === 'running') {
        events.onState('running');
        return Promise.resolve();
      }
      return settle(existing.resume(), RESUME_TIMEOUT_MS).then(() => events.onState(mapState(existing.state)));
    }
    const ctx = this.createContext(); // synchronously: still inside the tap
    this.ctx = ctx;
    events.onState('starting');
    return this.build(ctx, initial, events);
  }

  post(msg: MainToLab): void {
    this.graph?.node.port.postMessage(msg);
  }

  async loadReference(bytes: ArrayBuffer): Promise<RefDecoded> {
    const decoder: BaseAudioContext = this.ctx ?? new this.env.OfflineAudioContext(1, 1, DECODE_RATE);
    const buffer = await decoder.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    this.refBuffer = buffer;
    if (this.graph !== null) this.playRef(this.graph);
    return { durationS: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, rms: clipRms(channels) };
  }

  setAb(side: AbSide, fadeS: number): void {
    this.side = side;
    const g = this.graph;
    if (g === null) return;
    const t = g.ctx.currentTime;
    ramp(g.labAb.gain, side === 'A' ? 1 : 0, t, fadeS);
    ramp(g.refAb.gain, side === 'B' ? 1 : 0, t, fadeS);
  }

  setLevels(levels: LabLevels): void {
    this.levels = { ...levels };
    const g = this.graph;
    if (g === null) return;
    const t = g.ctx.currentTime;
    glide(g.labMatch.gain, levels.labGain, t);
    glide(g.refGain.gain, levels.refGain * levels.monitorGain, t);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** At the device rate when the core runs there (28–48 kHz), else a resampled 48 kHz context instead. */
  private createContext(): AudioContext {
    const Ctx = this.env.AudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    const fs = ctx.sampleRate;
    if (fs >= MIN_SAMPLE_RATE && fs <= MAX_SAMPLE_RATE) return ctx;
    ctx.close().catch(() => undefined);
    return new Ctx({ latencyHint: 'interactive', sampleRate: MAX_SAMPLE_RATE });
  }

  private async build(ctx: AudioContext, initial: () => readonly MainToLab[], events: LabAudioEvents): Promise<void> {
    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
      await withTimeout(ctx.audioWorklet.addModule(this.env.workletUrl), ADD_MODULE_TIMEOUT_MS, 'addModule');
      if (this.ctx !== ctx) throw new Error('audio stopped during start');
      const node = new this.env.AudioWorkletNode(ctx, LAB_PROCESSOR, NODE_OPTIONS);
      const g: Graph = { ctx, node, labMatch: ctx.createGain(), labAb: ctx.createGain(), refGain: ctx.createGain(), refAb: ctx.createGain() };
      node.port.onmessage = (e: MessageEvent<unknown>) => {
        if (this.graph === g && isLabMessage(e.data)) events.onMessage(e.data);
      };
      node.onprocessorerror = () => {
        if (this.graph !== g) return;
        this.teardown();
        events.onState('error', 'the lab worklet failed (processorerror)');
      };
      ctx.onstatechange = () => {
        if (this.graph === g) events.onState(mapState(ctx.state));
      };
      node.connect(g.labMatch);
      g.labMatch.connect(g.labAb);
      g.labAb.connect(ctx.destination);
      g.refGain.connect(g.refAb);
      g.refAb.connect(ctx.destination);
      g.labMatch.gain.value = this.levels.labGain;
      g.refGain.gain.value = this.levels.refGain * this.levels.monitorGain;
      g.labAb.gain.value = this.side === 'A' ? 1 : 0;
      g.refAb.gain.value = this.side === 'B' ? 1 : 0;
      this.graph = g;
      for (const msg of initial()) node.port.postMessage(msg);
      if (this.refBuffer !== null) this.playRef(g);
      if (ctx.state !== 'running') await settle(ctx.resume(), RESUME_TIMEOUT_MS);
      events.onState(mapState(ctx.state));
    } catch (e) {
      if (this.ctx === ctx) this.teardown();
      events.onState('error', errText(e));
    }
  }

  private playRef(g: Graph): void {
    const buffer = this.refBuffer;
    if (buffer === null) return;
    this.stopRef();
    const src = g.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(g.refGain);
    src.start();
    this.refSource = src;
  }

  private stopRef(): void {
    const src = this.refSource;
    this.refSource = null;
    if (src === null) return;
    try {
      src.stop();
    } catch {
      // never started or already stopped
    }
    src.disconnect();
  }

  /** Disconnects and closes everything; the decoded clip, the A/B side and the levels are kept for the next build. */
  private teardown(): void {
    this.stopRef();
    const g = this.graph;
    this.graph = null;
    if (g !== null) {
      g.node.port.onmessage = null;
      g.node.onprocessorerror = null;
      g.node.disconnect();
      g.labAb.disconnect();
      g.refAb.disconnect();
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null) {
      ctx.onstatechange = null;
      if (ctx.state !== 'closed') ctx.close().catch(() => undefined);
    }
  }
}

/** Linear ramp from the current value to `target` over `s` seconds from `t`. */
function ramp(p: AudioParam, target: number, t: number, s: number): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(target, t + s);
}

function glide(p: AudioParam, target: number, t: number): void {
  p.cancelScheduledValues(t);
  p.setTargetAtTime(target, t, LEVEL_TAU_S);
}
