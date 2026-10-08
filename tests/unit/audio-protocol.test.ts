import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  PROBE_GAIN_DB,
  PROBE_PROCESSOR,
  PROBE_TONE_HZ,
  type ProbeToWorklet,
  type WorkletToProbe,
} from '../../src/probe/audio-protocol';

describe('audio-protocol', () => {
  it('names the processor and default tone exactly as the contract says', () => {
    expect(PROBE_PROCESSOR).toBe('tesbox-probe');
    expect(PROBE_TONE_HZ).toBe(55);
    expect(PROBE_GAIN_DB).toBe(-18);
  });

  it('message unions are discriminated by type', () => {
    expectTypeOf<ProbeToWorklet['type']>().toEqualTypeOf<'config' | 'ping'>();
    expectTypeOf<WorkletToProbe['type']>().toEqualTypeOf<'report' | 'pong'>();
    expectTypeOf<Extract<WorkletToProbe, { type: 'report' }>>().toEqualTypeOf<{
      type: 'report';
      quanta: number;
      perfInWorklet: boolean;
      busyMs: number;
      windowMs: number;
      sampleRate: number;
      currentTime: number;
    }>();
  });
});
