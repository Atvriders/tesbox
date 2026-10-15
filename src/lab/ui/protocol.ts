/**
 * The Sound Lab's private worklet protocol (phase-2c contract L2): the page (src/lab/ui/lab-audio.ts) ↔ the
 * 'tesbox-lab' AudioWorkletProcessor (src/lab/ui/lab-worklet.ts). It is not part of src/contracts.ts: the app
 * never speaks it, and the app worklet never hears it.
 *
 * Main → worklet:
 * - `engine` — assertEngineFits(def, sampleRate) first; a failure posts `error` and keeps the previous engine,
 *   otherwise TesboxDspCore.configure() (the core's own 300 ms config fade applies).
 * - `tier`, `output` — reconfigure the core with the current engine.
 * - `gain` — monitor level, MONITOR_MIN_DB…MONITOR_MAX_DB (default MONITOR_DEFAULT_DB), applied after the stage.
 * - `manual` — the DspControl rendered while no segment plays (clamped by src/lab/ui/lab-control.ts).
 * - `event` — upshift / downshift / liftoff / limiter / ignition (transitions in lab-control.ts).
 * - `segment` — loops a tools/segments.ts segment instead of manual control; `null` returns to manual.
 *
 * Worklet → main: `ready` once, `error`, and `meter` at about METER_HZ.
 */
import type { DriveMode, EngineDef, OutputConfig, Perspective, Tier, ValveMode } from '../../contracts';

/** registerProcessor name of src/lab/ui/lab-worklet.ts. */
export const LAB_PROCESSOR = 'tesbox-lab';

/** Monitor level range and default (dB), applied after the output stage. */
export const MONITOR_MIN_DB = -40;
export const MONITOR_MAX_DB = 0;
export const MONITOR_DEFAULT_DB = -12;

/** Meter messages per second (approximately: one every round(fs / (METER_HZ · 128)) quanta). */
export const METER_HZ = 20;

export type LabEvent = 'upshift' | 'downshift' | 'liftoff' | 'limiter' | 'ignition';
export const LAB_EVENTS: readonly LabEvent[] = ['upshift', 'downshift', 'liftoff', 'limiter', 'ignition'];

/** What the page controls directly; the worklet renders it every quantum while no segment plays. */
export interface ManualControl {
  rpm: number;
  load: number;
  gear: number;
  valve: ValveMode;
  perspective: Perspective;
  driveMode: DriveMode;
  warm: boolean;
}

export type ManualMsg = { type: 'manual' } & ManualControl;

export type MainToLab =
  | { type: 'engine'; def: EngineDef }
  | { type: 'tier'; value: Tier }
  | { type: 'output'; config: OutputConfig }
  | { type: 'gain'; db: number }
  | ManualMsg
  | { type: 'event'; ev: LabEvent }
  | { type: 'segment'; name: string | null };

/**
 * Levels describe the output stage's output, before the monitor gain: rmsDb over the meter window (both
 * channels), peakDb = the stage's true peak (dBTP) over the window, limiterGrDb = the largest true-peak
 * limiter gain reduction in the window. rpm / gear / limiter are the control the core rendered last.
 * Silence reads −200 dB.
 */
export interface MeterMsg {
  type: 'meter';
  rmsDb: number;
  peakDb: number;
  rpm: number;
  gear: number;
  limiter: boolean;
  boost: number;
  limiterGrDb: number;
  nonFiniteResets: number;
}

export type LabToMain = { type: 'ready' } | { type: 'error'; message: string } | MeterMsg;
