/**
 * Engine scoring against reference clips (phase 2b contract "Comparison and scoring" as amended by D3, D6 and D8;
 * spec §11.3). Environment-free (Node + browser); analysis code may allocate.
 *
 * - renderVsRef: per metric, the mean over every (render clip, ref clip) pair of the same kind and perspective of
 *   compareClips' value, null values left out (null when no pair defines it).
 * - refVsRef: the same over the distinct (unordered) pairs of ref clips of the same kind and perspective — the
 *   achievable ceiling, since two recordings of the real car never match each other perfectly either.
 * - gate: per metric, 'pass' iff renderVsRef ≥ GATE_RATIO (0.8) × refVsRef; 'n/a' when either is null.
 * - composite: the geometric mean of the non-null renderVsRef metrics (compositeScore).
 * - discrimination: the composite of the render against each other engine's refs (renderVsRef-style, the same
 *   metric rules); passes iff the composite against its own refs is strictly higher than every other engine's.
 *   Only engines with refs take part (the scored engine itself is never an "other"); an engine whose refs share
 *   no comparable pair with the render is listed with composite null and does not vote. null when the own
 *   composite is null or no other engine votes. As the contract has one ownComposite, it spans every slot
 *   (kind + perspective) the render shares with its own refs, while each other composite spans only the slots
 *   that engine's refs cover: refs covering different slots (or metrics, e.g. overrun is liftoff-only) can flip
 *   the verdict either way.
 * - unscored: fewer than MIN_REFS (2) refs (spec §11.3: two clips of the car define the ceiling).
 *
 * Refs are segments: the contract's flat ClipFeatures[] carries no clip identity, so `unscored` counts segments
 * and refVsRef pairs any two ref segments of a slot, two cut from one recording included. A caller that knows
 * the clips (tools/score.ts) counts clips itself. When no slot holds a comparable pair of refs, every refVsRef
 * metric is null and every gate 'n/a' even with unscored false: there is no ceiling to gate against, which is
 * not a pass.
 *
 * refVsRef follows the contract literally: it spans every slot holding a comparable pair of refs, whether or not
 * that slot has a render, let alone a comparable render pair. Since amendment D6 a steady pair (idle, cruise,
 * limiter) is comparable with one common 500 rpm bin, so the score CLI's constant-rpm idle and cruise renders score
 * against the refs that share their bin — but two steady refs of a slot also pair with each other when they share a
 * bin that no render holds (refs cruising at 3000 rpm against renders at 2000 / 4000 / 6000 rpm, or idling elsewhere
 * than the render). Refs of a kind no render has (limiter) pair with each other too (the score CLI reports those as
 * unmatched and keeps them out). Such a pair moves the ceiling of every metric it defines while renderVsRef stays
 * the same, so a gate verdict can depend on which speeds the refs cruise at. Restricting the ceiling to the slots
 * renderVsRef covers would need a contract amendment.
 *
 * Amendments D3 and D8: for a naturally aspirated engine (spec.aspiration.type 'na') fiLine and fiPresence are null
 * in every comparison — render vs ref, ref vs ref and discrimination (compareOptionsFor) — so their gates are 'n/a'
 * and they never enter a composite. For a forced-induction engine fiPresence compares, on wot and cruise pairs, the
 * share p of frames carrying an FI line bin by bin (compare.ts): renderVsRef averages the render/ref pairs' values,
 * refVsRef the ref pairs' (how alike two recordings of the car are in p), gated and composited like every other
 * metric. The aspiration comes from `opts.aspiration`, else from the engine's starter-garage record
 * (src/data/engines); scoring an engine outside the garage (a test fixture, a candidate) without it throws rather
 * than guessing.
 */
import type { AspirationType } from '../contracts';
import { ENGINES } from '../data/engines';
import { METRIC_NAMES, compareClips, compositeScore, type CompareOptions, type MetricName, type PairScore } from './compare';
import type { ClipFeatures } from './features';

export type GateResult = 'pass' | 'fail' | 'n/a';

export interface EngineScore {
  engineId: string;
  /** Mean over (render segment, matching ref segment) pairs. */
  renderVsRef: Record<MetricName, number | null>;
  /** Mean over distinct ref pairs of the same kind + perspective. */
  refVsRef: Record<MetricName, number | null>;
  /** pass iff renderVsRef ≥ 0.8 × refVsRef (n/a if either null). */
  gate: Record<MetricName, GateResult>;
  /** Composite over renderVsRef. */
  composite: number | null;
  discrimination: { ownComposite: number | null; others: { engineId: string; composite: number | null }[]; pass: boolean | null };
  /** True when fewer than 2 refs exist (spec §11.3); refs are segments here (see the module comment). */
  unscored: boolean;
}

export interface ScoreOptions {
  /**
   * spec.aspiration.type of the scored engine (amendments D3, D8: 'na' → fiLine and fiPresence n/a). Default: the
   * starter-garage record of `engineId`; required for any other engine id.
   */
  aspiration?: AspirationType;
}

/**
 * The compareClips options every comparison of an engine with this aspiration uses (amendments D3, D8): the
 * forced-induction metrics fiLine and fiPresence are scored for turbo and supercharged engines and are n/a for
 * naturally aspirated ones. Callers that list pairs themselves (tools/score.ts) use it to match scoreEngine.
 */
export function compareOptionsFor(aspiration: AspirationType): CompareOptions {
  const forcedInduction = aspiration !== 'na';
  return { fiLine: forcedInduction, fiPresence: forcedInduction };
}

/** A metric passes when renderVsRef ≥ GATE_RATIO × refVsRef (spec §11.3). */
export const GATE_RATIO = 0.8;
/** An engine with fewer refs (ClipFeatures segments; see the module comment) than this is unscored (spec §11.3). */
export const MIN_REFS = 2;

/** Gate of one metric: 'pass' iff renderVsRef ≥ GATE_RATIO × refVsRef, 'n/a' when either is null. */
export function metricGate(renderVsRef: number | null, refVsRef: number | null): GateResult {
  if (renderVsRef === null || refVsRef === null) return 'n/a';
  return renderVsRef >= GATE_RATIO * refVsRef ? 'pass' : 'fail';
}

function aspirationOf(engineId: string, opts: ScoreOptions): AspirationType {
  if (opts.aspiration !== undefined) return opts.aspiration;
  const def = ENGINES.find((e) => e.id === engineId);
  if (def === undefined) {
    throw new RangeError(
      `scoreEngine: "${engineId}" is not a starter-garage engine; pass opts.aspiration (its spec.aspiration.type, amendment D3)`,
    );
  }
  return def.spec.aspiration.type;
}

function sameSlot(a: ClipFeatures, b: ClipFeatures): boolean {
  return a.kind === b.kind && a.perspective === b.perspective;
}

/** Per metric, the mean of the pairs' non-null values (null when none); keys in METRIC_NAMES order. */
function meanMetrics(pairs: PairScore[]): Record<MetricName, number | null> {
  const out = {} as Record<MetricName, number | null>;
  for (const m of METRIC_NAMES) {
    let s = 0;
    let n = 0;
    for (const p of pairs) {
      const v = p.metrics[m];
      if (v === null) continue;
      s += v;
      n++;
    }
    out[m] = n > 0 ? s / n : null;
  }
  return out;
}

/** Metric means of every (render, ref) pair of the same kind and perspective. */
function versus(render: ClipFeatures[], refs: ClipFeatures[], compare: CompareOptions): Record<MetricName, number | null> {
  const pairs: PairScore[] = [];
  for (const r of render) for (const f of refs) if (sameSlot(r, f)) pairs.push(compareClips(r, f, compare));
  return meanMetrics(pairs);
}

/** Metric means of the distinct pairs of refs of the same kind and perspective. */
function amongRefs(refs: ClipFeatures[], compare: CompareOptions): Record<MetricName, number | null> {
  const pairs: PairScore[] = [];
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      const a = refs[i];
      const b = refs[j];
      if (a !== undefined && b !== undefined && sameSlot(a, b)) pairs.push(compareClips(a, b, compare));
    }
  }
  return meanMetrics(pairs);
}

/**
 * Scores the render segments of `engineId` against its ref clips and, for discrimination, against the ref clips
 * of the other engines in `otherRefs` (keyed by engine id). See the module comment; `opts.aspiration` is needed
 * for engines outside the starter garage (RangeError otherwise).
 */
export function scoreEngine(
  engineId: string,
  render: ClipFeatures[],
  refs: ClipFeatures[],
  otherRefs: Record<string, ClipFeatures[]>,
  opts: ScoreOptions = {},
): EngineScore {
  const compare = compareOptionsFor(aspirationOf(engineId, opts));
  const renderVsRef = versus(render, refs, compare);
  const refVsRef = amongRefs(refs, compare);
  const gate = {} as Record<MetricName, GateResult>;
  for (const m of METRIC_NAMES) gate[m] = metricGate(renderVsRef[m], refVsRef[m]);
  const composite = compositeScore(renderVsRef);
  const others = Object.keys(otherRefs)
    .filter((id) => id !== engineId && (otherRefs[id]?.length ?? 0) > 0)
    .sort()
    .map((id) => ({ engineId: id, composite: compositeScore(versus(render, otherRefs[id] ?? [], compare)) }));
  let pass: boolean | null = null;
  if (composite !== null) {
    for (const o of others) {
      if (o.composite === null) continue;
      pass = (pass ?? true) && composite > o.composite;
    }
  }
  return {
    engineId,
    renderVsRef,
    refVsRef,
    gate,
    composite,
    discrimination: { ownComposite: composite, others, pass },
    unscored: refs.length < MIN_REFS,
  };
}
