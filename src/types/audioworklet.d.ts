/**
 * Ambient globals of AudioWorkletGlobalScope (the TypeScript DOM lib does not ship them).
 * They are visible to the whole program; only code that runs inside an AudioWorklet module
 * may touch them at runtime.
 */

/** Base class every processor extends; `port` talks to the AudioWorkletNode on the main thread. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

/** What `registerProcessor` requires of a processor instance. */
interface AudioWorkletProcessorImpl extends AudioWorkletProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

type AudioWorkletProcessorConstructor = new (
  options: AudioWorkletNodeOptions,
) => AudioWorkletProcessorImpl;

declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;

/** Context time in seconds of the current render quantum. */
declare const currentTime: number;
/** Sample rate of the owning BaseAudioContext, in Hz. */
declare const sampleRate: number;
