import type { EngineSpec, EngineVoicing } from '../contracts';

/** Header lengths for the generic rule span [HEADER_MIN_M, HEADER_MIN_M + HEADER_SPAN_M). */
const HEADER_MIN_M = 0.55;
const HEADER_SPAN_M = 0.15;
/** Deliberately unequal header pair for flat 4-cylinders (boxer rumble). */
const FLAT4_SHORT_M = 0.45;
const FLAT4_LONG_M = 0.75;
/** Golden-ratio low-discrepancy step: deterministic, well-spread lengths. */
const GOLDEN_FRACTION = 0.6180339887498949;
const COLLECTOR_M = 0.35;
const ROTARY_FACES_PER_ROTOR = 3;

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Cylinders for 4-strokes; rotors (not faces) for rotaries — the EPA "cylinders and rotors" convention. */
function cylinderCount(spec: EngineSpec): number {
  return spec.layout.type === 'rotary'
    ? spec.combustion.length / ROTARY_FACES_PER_ROTOR
    : spec.combustion.length;
}

/**
 * One length per combustion entry, keyed by the entry's ordinal position within its bank
 * (rotaries: by rotor, so the three faces of one rotor share their port's header). Using the
 * within-bank ordinal makes V and flat engines bank-symmetric by construction.
 */
function headerLengths(spec: EngineSpec): number[] {
  const flat4 = spec.layout.type === 'flat' && spec.combustion.length === 4;
  const rotary = spec.layout.type === 'rotary';
  const seenPerBank = new Map<number, number>();
  const rotorOrdinal = new Map<number, number>();
  const out: number[] = [];
  for (const entry of spec.combustion) {
    let ordinal: number;
    if (rotary) {
      const rotorOffset = Math.round(entry.angleDeg % 360);
      const known = rotorOrdinal.get(rotorOffset);
      if (known === undefined) {
        ordinal = rotorOrdinal.size;
        rotorOrdinal.set(rotorOffset, ordinal);
      } else {
        ordinal = known;
      }
    } else {
      ordinal = seenPerBank.get(entry.bank) ?? 0;
      seenPerBank.set(entry.bank, ordinal + 1);
    }
    if (flat4) {
      out.push(ordinal % 2 === 0 ? FLAT4_SHORT_M : FLAT4_LONG_M);
    } else {
      out.push(round3(HEADER_MIN_M + HEADER_SPAN_M * ((ordinal * GOLDEN_FRACTION) % 1)));
    }
  }
  return out;
}

/**
 * Deterministic starting voicing for an engine spec (phase-1 contract "defaultVoicing").
 * Every call returns fresh objects; `estimated` is always true until Sound Lab sign-off.
 */
export function defaultVoicing(spec: EngineSpec): EngineVoicing {
  const asp = spec.aspiration.type;
  const turbo = asp === 'turbo';
  const forced = asp === 'turbo' || asp === 'supercharger';
  const banks = [...new Set(spec.combustion.map((c) => c.bank))].sort((a, b) => a - b);
  return {
    pulse: {
      widthDeg: spec.layout.type === 'rotary' ? 260 : 60,
      alpha: 9,
      beta: 4,
      evoOffsetDeg: 140,
      cycleAsymmetry: 0.1,
    },
    headersM: headerLengths(spec),
    collectors: banks.map((b) => ({ banks: [b], lengthM: COLLECTOR_M })),
    turbine: turbo ? { reflection: 0.45, lpHz: 1500 } : null,
    exhaust: {
      midPipeM: 1.4,
      mufflerSectionsM: [0.21, 0.34, 0.47],
      mufflerAction: 0.6,
      tailpipeM: 0.5,
      valve: { fitted: true, openGainDb: 4 },
    },
    intake: {
      runnerM: 0.3,
      helmholtzHz: 120 + (20 * cylinderCount(spec)) / 4,
      gain: 0.4,
    },
    forcedInduction: forced
      ? { spoolTimeS: turbo ? 0.6 : 0.05, maxShaftKrpm: 180, lift: 'bov', cabinGainDb: -14 }
      : null,
    mechanical: { blockGain: 0.3, valvetrainGain: 0.1 },
    overrun: { crackleRate: 0.5, fuelCutResumeRpm: spec.rpm.idle + 500 },
    cabin: { lowpassHz: 600 },
    launchRpm: Math.round((forced ? 0.45 : 0.55) * spec.rpm.redline),
    estimated: true,
  };
}
