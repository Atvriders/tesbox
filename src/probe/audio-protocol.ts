/** Name passed to registerProcessor() in the worklet and to new AudioWorkletNode() on the main thread. */
export const PROBE_PROCESSOR = 'tesbox-probe';
/** Default probe tone (contract: 55 Hz pulse train at −18 dB). */
export const PROBE_TONE_HZ = 55;
export const PROBE_GAIN_DB = -18;

export type ProbeToWorklet =
  | { type: 'config'; k: number; toneHz: number; gainDb: number }
  | { type: 'ping'; id: number };

export type WorkletToProbe =
  | {
      type: 'report';
      quanta: number;
      perfInWorklet: boolean;
      busyMs: number;
      windowMs: number;
      sampleRate: number;
      currentTime: number;
    } // every ~250 ms of audio time
  | { type: 'pong'; id: number; currentTime: number };
