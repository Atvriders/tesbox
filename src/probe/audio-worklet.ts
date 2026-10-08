import { QUANTUM } from '../contracts';
import { PROBE_GAIN_DB, PROBE_PROCESSOR, PROBE_TONE_HZ, type ProbeToWorklet, type WorkletToProbe } from './audio-protocol';
import { WorkKernel } from './work';

const PULSE_S = 0.002; // raised-cosine pulse length
const LOWPASS_HZ = 2000; // one-pole corner
const REPORT_INTERVAL_S = 0.25; // audio time between reports
const MAX_K = 64;
const MIN_TONE_HZ = 1;
const MAX_TONE_HZ = 1000;
const MIN_GAIN_DB = -120;
const DENORMAL_FLUSH = 1e-20;

const PERF_IN_WORKLET = typeof performance !== 'undefined' && typeof performance.now === 'function';
const clockMs: () => number = PERF_IN_WORKLET ? () => performance.now() : () => Date.now();

type ReportMsg = Extract<WorkletToProbe, { type: 'report' }>;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

class TesboxProbeProcessor extends AudioWorkletProcessor {
  private readonly kernel = new WorkKernel();
  private readonly lpCoeff = 1 - Math.exp((-2 * Math.PI * LOWPASS_HZ) / sampleRate);
  private readonly reportFrames = Math.max(1, Math.round(sampleRate * REPORT_INTERVAL_S));
  /** Reused for every report: process() must not allocate. postMessage clones it. */
  private readonly report: ReportMsg = {
    type: 'report',
    quanta: 0,
    perfInWorklet: PERF_IN_WORKLET,
    busyMs: 0,
    windowMs: 0,
    sampleRate,
    currentTime: 0,
  };
  private k = 1;
  private toneHz = PROBE_TONE_HZ;
  private gain = 10 ** (PROBE_GAIN_DB / 20);
  private phase = 0; // position in the tone period, [0, 1)
  private lp = 0; // one-pole state
  private quanta = 0;
  private framesInWindow = 0;
  private busyMs = 0;
  private checksum = 0; // keeps the kernel result observable

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ProbeToWorklet>) => this.onMessage(e.data);
  }

  private onMessage(msg: ProbeToWorklet): void {
    if (typeof msg !== 'object' || msg === null) return;
    if (msg.type === 'config') {
      if (Number.isFinite(msg.k)) this.k = clamp(Math.round(msg.k), 0, MAX_K);
      if (Number.isFinite(msg.toneHz)) this.toneHz = clamp(msg.toneHz, MIN_TONE_HZ, MAX_TONE_HZ);
      // +∞ is ignored like NaN; −∞ means "silent" and clamps to −120 dB.
      if (Number.isFinite(msg.gainDb) || msg.gainDb === -Infinity) this.gain = 10 ** (clamp(msg.gainDb, MIN_GAIN_DB, 0) / 20);
    } else if (msg.type === 'ping') {
      const pong: WorkletToProbe = { type: 'pong', id: msg.id, currentTime };
      this.port.postMessage(pong);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const t0 = clockMs();
    const out = outputs[0];
    const left = out !== undefined ? out[0] : undefined;
    const right = out !== undefined ? out[1] : undefined;
    const frames = left !== undefined ? left.length : QUANTUM;

    if (left !== undefined) {
      const inc = this.toneHz / sampleRate;
      const duty = Math.min(1, PULSE_S * this.toneHz); // pulse length as a fraction of the period
      const w = (2 * Math.PI) / duty;
      const a = this.lpCoeff;
      const g = this.gain;
      let phase = this.phase;
      let y = this.lp;
      for (let i = 0; i < frames; i++) {
        const x = phase < duty ? 0.5 - 0.5 * Math.cos(phase * w) : 0;
        y += a * (x - y);
        if (y < DENORMAL_FLUSH && y > -DENORMAL_FLUSH) y = 0;
        const v = y * g;
        left[i] = v;
        if (right !== undefined) right[i] = v;
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
      this.phase = phase;
      this.lp = y;
    }

    this.checksum = this.kernel.run(frames, this.k);
    this.busyMs += clockMs() - t0;
    this.quanta++;
    this.framesInWindow += frames;
    if (this.framesInWindow >= this.reportFrames) {
      const r = this.report;
      r.quanta = this.quanta;
      r.busyMs = this.busyMs;
      r.windowMs = (this.framesInWindow / sampleRate) * 1000;
      r.currentTime = currentTime;
      this.port.postMessage(r);
      this.busyMs = 0;
      this.framesInWindow = 0;
    }
    return true;
  }
}

registerProcessor(PROBE_PROCESSOR, TesboxProbeProcessor);
