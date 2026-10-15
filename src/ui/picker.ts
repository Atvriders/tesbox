/**
 * Pure data helpers of the first-run Tesla picker and the garage (phase-3 contract T7; spec §9.3,
 * §10.2): catalogue navigation (Model → generation → trim), MCU1 detection, the per-car answers a new
 * choice resets (and a cancelled re-run puts back), the "not listed" form, the bass-sweep steps, the
 * garage groups and spec lines. No DOM, no Preact, no signals or timers (the screens' waits live in
 * src/ui/wait.ts): everything here is unit-tested in Node against the real catalogue and engines
 * (tests/unit/picker.test.ts).
 */
import { DEFAULT_OUTPUT, type EngineDef, type EngineSet, type Subwoofer, type TeslaRecord } from '../contracts';
import { NOT_LISTED_MASS_RANGE_KG, NOT_LISTED_ZERO_TO_100_RANGE_S, type NotListed, type Settings } from '../app/settings';
import { TESLAS } from '../data/catalogue';
import { ENGINES } from '../data/engines';
import { voicingStatus } from '../data/voicing-status';
import { STR } from './strings';

// ───────────────────────────── Catalogue navigation ─────────────────────────────

export type TeslaModel = TeslaRecord['model'];

/** One generation of a model, as the picker offers it. */
export interface GenerationOption {
  generation: string;
  /** Model years its trims cover: [first, last]. */
  years: [number, number];
  /** Its trims, in catalogue order. */
  trims: TeslaRecord[];
}

/** The models, in catalogue order. */
export function teslaModels(records: readonly TeslaRecord[] = TESLAS): TeslaModel[] {
  const models: TeslaModel[] = [];
  for (const r of records) if (!models.includes(r.model)) models.push(r.model);
  return models;
}

/** The generations of `model`, in catalogue order, each with the model years its trims cover. */
export function generationsOf(model: TeslaModel, records: readonly TeslaRecord[] = TESLAS): GenerationOption[] {
  const byGeneration = new Map<string, TeslaRecord[]>();
  for (const r of records) {
    if (r.model !== model) continue;
    const trims = byGeneration.get(r.generation);
    if (trims === undefined) byGeneration.set(r.generation, [r]);
    else trims.push(r);
  }
  return [...byGeneration].map(([generation, trims]) => ({ generation, years: yearSpan(trims), trims }));
}

/** The trims of one generation, in catalogue order (empty for an unknown one). */
export function trimsOf(model: TeslaModel, generation: string, records: readonly TeslaRecord[] = TESLAS): TeslaRecord[] {
  return records.filter((r) => r.model === model && r.generation === generation);
}

/** First and last model year of `records` (non-empty). */
export function yearSpan(records: readonly TeslaRecord[]): [number, number] {
  let first = Infinity;
  let last = -Infinity;
  for (const r of records) {
    first = Math.min(first, r.years[0]);
    last = Math.max(last, r.years[1]);
  }
  return [first, last];
}

/** "2023–2026", or "2019" for a single year. */
export function formatYears(years: readonly [number, number]): string {
  return years[0] === years[1] ? String(years[0]) : `${years[0]}–${years[1]}`;
}

export function teslaById(id: string | null, records: readonly TeslaRecord[] = TESLAS): TeslaRecord | null {
  return id === null ? null : (records.find((r) => r.id === id) ?? null);
}

/**
 * An MCU1-era configuration (spec §9.1): built with the Tegra media computer, whose browser cannot run
 * Tesbox, so the record is unsupported unless the car had the MCU2 retrofit — the picker asks.
 */
export function isMcu1Era(r: TeslaRecord): boolean {
  return !r.supported || r.mcu.includes('tegra');
}

// ───────────────────────────── Per-car answers ─────────────────────────────

/** The subwoofer step's pre-selection, labelled a best guess (spec §9.2 `subwooferDefault`). */
export function subwooferGuess(r: TeslaRecord): Subwoofer {
  return r.subwooferDefault ? 'yes' : 'no';
}

/** The quickest acceleration mode: the record's last (factor 1.0). */
export function quickestMode(r: TeslaRecord): string {
  return r.accelModes[r.accelModes.length - 1]?.name ?? '';
}

/** The acceleration mode in effect for `r`: the stored one when `r` has it, else the quickest (settings null). */
export function selectedAccelMode(s: Settings, r: TeslaRecord): string {
  const stored = r.accelModes.find((m) => m.name === s.accelMode);
  return stored === undefined ? quickestMode(r) : stored.name;
}

/** What the picker chose: a catalogue record or a "not listed" entry. */
export type CarChoice = { teslaId: string } | { notListed: NotListed };

/** Choosing this would keep the same car (the same record, or "not listed" again with edited numbers). */
export function sameCar(s: Settings, c: CarChoice): boolean {
  return 'teslaId' in c ? s.teslaId === c.teslaId : s.teslaId === null && s.notListed !== null;
}

/**
 * The settings patch for a car choice. The other answers belong to the car — its subwoofer, the bass
 * sweep's corner (set per car, spec §5.6), the acceleration mode and the MCU2 retrofit — so choosing
 * another car resets them to that car's starting point: the subwoofer best guess ("not sure" for a car
 * that is not listed, spec §9.1), 40 Hz, quickest and not asked yet. The same car keeps them.
 */
export function carChoicePatch(s: Settings, c: CarChoice): Partial<Settings> {
  const choice: Partial<Settings> =
    'teslaId' in c ? { teslaId: c.teslaId, notListed: null } : { teslaId: null, notListed: { ...c.notListed } };
  if (sameCar(s, c)) return choice;
  const record = 'teslaId' in c ? teslaById(c.teslaId) : null;
  return {
    ...choice,
    accelMode: null,
    mcu2Retrofit: null,
    subwoofer: record === null ? 'unsure' : subwooferGuess(record),
    hpCornerHz: DEFAULT_OUTPUT.hpCornerHz,
  };
}

/** The settings the picker answers: the car and the answers that belong to it. */
export type CarAnswers = Pick<Settings, 'teslaId' | 'notListed' | 'subwoofer' | 'hpCornerHz' | 'accelMode' | 'mcu2Retrofit'>;

/**
 * Everything the picker can change in `s` (a copy): the car, and the answers carChoicePatch resets with
 * it. A cancelled re-run puts them back in one patch, so the mode is validated against its own car.
 */
export function carAnswersOf(s: Settings): CarAnswers {
  return {
    teslaId: s.teslaId,
    notListed: s.notListed === null ? null : { ...s.notListed },
    subwoofer: s.subwoofer,
    hpCornerHz: s.hpCornerHz,
    accelMode: s.accelMode,
    mcu2Retrofit: s.mcu2Retrofit,
  };
}

/** A decimal typed with either separator; '' and anything else that is not a plain number give NaN. */
function parseDecimal(text: string): number {
  const t = text.trim().replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

function within(x: number, range: { readonly min: number; readonly max: number }): boolean {
  return x >= range.min && x <= range.max; // false for NaN
}

/** The "not listed" form's entry, or null unless both numbers lie within the settings bounds. */
export function parseNotListed(zeroTo100: string, mass: string, body: NotListed['body']): NotListed | null {
  const zeroTo100S = parseDecimal(zeroTo100);
  const massKg = parseDecimal(mass);
  if (!within(zeroTo100S, NOT_LISTED_ZERO_TO_100_RANGE_S) || !within(massKg, NOT_LISTED_MASS_RANGE_KG)) return null;
  return { zeroTo100S, massKg, body };
}

/** "Model 3 · Highland (2023–) · Long Range AWD / Premium AWD", the "not listed" numbers, or null. */
export function carSummary(s: Settings): string | null {
  const r = teslaById(s.teslaId);
  if (r !== null) return [r.model, r.generation, r.trim].join(' · ');
  const nl = s.notListed;
  return nl === null ? null : STR.firstRun.notListedSummary(nl.zeroTo100S, nl.massKg, STR.firstRun.bodies[nl.body]);
}

// ───────────────────────────── Bass sweep (spec §9.3) ─────────────────────────────

/** Sweep steps, low to high; the lowest step that plays cleanly becomes `hpCornerHz`. */
export const BASS_SWEEP_HZ: readonly number[] = Object.freeze([30, 35, 40, 45, 50, 60]);
export const BASS_SWEEP_STEP_MS = 1500;
/** The fixed, conservative sine peak of every step (the testTone `levelDb`). */
export const BASS_SWEEP_LEVEL_DB = -18;

// ───────────────────────────── Garage (spec §10.2 item 3) ─────────────────────────────

/** Garage group order. */
export const ENGINE_SETS: readonly EngineSet[] = Object.freeze(['euro', 'jdm', 'american', 'exotic'] as const);

/** The engines by set, in ENGINE_SETS order (empty groups left out), keeping the garage order in each. */
export function engineGroups(engines: readonly EngineDef[] = ENGINES): { set: EngineSet; engines: EngineDef[] }[] {
  return ENGINE_SETS.map((set) => ({ set, engines: engines.filter((e) => e.set === set) })).filter(
    (g) => g.engines.length > 0,
  );
}

/** A rotary's combustion entries are its rotor faces: three per rotor. */
const FACES_PER_ROTOR = 3;

function layoutLabel(def: EngineDef): string {
  const { layout, combustion } = def.spec;
  const n = combustion.length;
  const label = STR.garage.layout;
  switch (layout.type) {
    case 'inline':
      return label.inline(n);
    case 'flat':
      return label.flat(n);
    case 'rotary':
      return label.rotary(Math.round(n / FACES_PER_ROTOR));
    case 'v':
      return layout.crank === 'n/a' ? label.v(n, layout.bankAngleDeg) : label.vCrank(n, layout.bankAngleDeg, layout.crank);
  }
}

function aspirationLabel(def: EngineDef): string {
  const a = def.spec.aspiration;
  const label = STR.garage.aspiration;
  if (a.type === 'na') return label.na;
  if (a.type === 'supercharger') return label.supercharged;
  const count = a.turbo?.count ?? 1;
  if (count <= 1) return label.turbo;
  if (count === 2) return a.turbo?.layout === 'sequential' ? label.sequentialTwinTurbo : label.twinTurbo;
  return label.turbos(count);
}

/** 7000 → "7,000". */
function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The card's spec facts: layout, displacement, aspiration, redline ("Inline-5", "2.5 L", "Turbo", "7,000 rpm redline"). */
export function engineSpecParts(def: EngineDef): string[] {
  return [
    layoutLabel(def),
    STR.garage.displacement(def.spec.layout.displacementL.toFixed(1)),
    aspirationLabel(def),
    STR.garage.redline(thousands(def.spec.rpm.redline)),
  ];
}

const NBSP = '\u00a0';
/** U+2011 NON-BREAKING HYPHEN: drawn like "-", but not a line-break point. */
const NBHY = '\u2011';

/**
 * The card's spec line, "Inline-5 · 2.5 L · Turbo · 7,000 rpm redline", with no-break spaces and
 * non-breaking hyphens inside each fact and a no-break space before each "·", so a narrow card wraps it
 * only after a "·" (never "Sequential twin-" | "turbo").
 */
export function engineSpecLine(def: EngineDef): string {
  return engineSpecParts(def)
    .map((part) => part.replace(/ /g, NBSP).replace(/-/g, NBHY))
    .join(`${NBSP}· `);
}

/**
 * The card's badge (phase-4 contract T4): "Beta voicing" while the voicing is an estimate — the default,
 * or tuned against reference recordings — until the user's listening sign-off sets `estimated` to false;
 * then none.
 */
export function voicingBadge(def: EngineDef): string | null {
  return def.voicing.estimated ? STR.garage.betaVoicing : null;
}

/** The card's spec line: engineSpecLine, plus "Tuned" while a tuned voicing waits for the sign-off (T4). */
export function garageSpecLine(def: EngineDef): string {
  const line = engineSpecLine(def);
  return voicingStatus(def) === 'tuned' ? `${line}${NBSP}· ${STR.garage.tuned}` : line;
}
