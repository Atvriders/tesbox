import { describe, expect, it } from 'vitest';
import type { EngineDef, EngineVoicing } from '../../src/contracts';
import { ENGINES, getEngine } from '../../src/data/engines';
import { defaultVoicing } from '../../src/data/voicing-defaults';
import { isTunedVoicing, voicingStatus } from '../../src/data/voicing-status';

/** `e` with another voicing. */
const withVoicing = (e: EngineDef, voicing: EngineVoicing): EngineDef => ({ ...e, voicing });

/** A deep copy with every object's keys in reverse order (JSON files may list them in any order). */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)]),
    );
  }
  return v;
}

// A turbo engine: its default voicing has a turbine, forced induction and several headers.
const BASE = getEngine('i5-turbo-25');
const DEFAULT = (): EngineVoicing => defaultVoicing(BASE.spec);

describe('isTunedVoicing — is the voicing other than defaultVoicing(spec)? (phase-4 contract T4)', () => {
  it('the default voicing is not tuned, whatever the key order', () => {
    expect(isTunedVoicing(withVoicing(BASE, DEFAULT()))).toBe(false);
    expect(isTunedVoicing(withVoicing(BASE, reverseKeys(DEFAULT()) as EngineVoicing))).toBe(false);
  });

  it('any changed parameter is tuned: nested, in an array, an array length, null instead of a block', () => {
    const d = DEFAULT();
    const variants: EngineVoicing[] = [
      { ...d, pulse: { ...d.pulse, alpha: d.pulse.alpha + 0.5 } },
      { ...d, headersM: d.headersM.map((m, i) => (i === 0 ? m + 0.01 : m)) },
      { ...d, headersM: d.headersM.slice(1) },
      { ...d, exhaust: { ...d.exhaust, mufflerSectionsM: [...d.exhaust.mufflerSectionsM].reverse() } },
      { ...d, turbine: null },
      { ...d, cabin: { ...d.cabin, lowpassHz: d.cabin.lowpassHz + 50 } },
      { ...d, launchRpm: d.launchRpm + 1 },
    ];
    for (const v of variants) expect(isTunedVoicing(withVoicing(BASE, v)), JSON.stringify(v)).toBe(true);
  });

  it('the sign-off flag alone is not tuning', () => {
    expect(isTunedVoicing(withVoicing(BASE, { ...DEFAULT(), estimated: false }))).toBe(false);
  });

  it('agrees with the comparison tests/unit/engines.test.ts makes for every catalogue engine', () => {
    for (const e of ENGINES) {
      const sameAsDefault = JSON.stringify(canonical(e.voicing)) === JSON.stringify(canonical(defaultVoicing(e.spec)));
      expect(isTunedVoicing(e), e.id).toBe(!sameAsDefault);
    }
  });
});

describe('voicingStatus — default → tuned → signed off', () => {
  it('estimated and untouched is "default"; estimated and changed is "tuned"; estimated false is "signed-off"', () => {
    const d = DEFAULT();
    const tuned: EngineVoicing = { ...d, cabin: { ...d.cabin, lowpassHz: 700 } };
    expect(voicingStatus(withVoicing(BASE, d))).toBe('default');
    expect(voicingStatus(withVoicing(BASE, tuned))).toBe('tuned');
    expect(voicingStatus(withVoicing(BASE, { ...tuned, estimated: false }))).toBe('signed-off');
    expect(voicingStatus(withVoicing(BASE, { ...d, estimated: false }))).toBe('signed-off');
  });
});

/** Canonical form for the cross-check above: keys sorted at every level, the sign-off flag left out. */
function canonical(v: unknown, top = true): unknown {
  if (Array.isArray(v)) return v.map((x) => canonical(x, false));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !(top && k === 'estimated'))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x, false)]),
    );
  }
  return v;
}
