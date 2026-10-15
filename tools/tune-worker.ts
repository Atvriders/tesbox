/**
 * A tesbox-tune worker thread (phase 5 contract P1; started by tools/tune.ts workerEvaluator, never run directly).
 *
 * At start-up it receives the tuning problem once (workerData, TuneWorkerInit: the engine, its references and their
 * features, the other engines' references, the render targets by segment name, the caller's modules), imports the
 * modules (their `segments` join tools/segments.ts SEGMENTS, their `renderPlan` entries the plans a target may name),
 * and builds the same candidateEvaluator the tuner uses in-thread. Then it answers each TuneWorkerTask — one candidate
 * voicing — with a TuneWorkerReply: the CandidateResult, or the error the evaluation threw.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { RENDER_PLAN, type RenderPlanEntry } from './score';
import { SEGMENTS, type Segment } from './segments';
import { candidateEvaluator, type RenderTarget, type TuneWorkerInit, type TuneWorkerReply, type TuneWorkerTask } from './tune';

const port = parentPort;
if (port === null) throw new Error('tools/tune-worker.ts runs as a worker thread of tools/tune.ts (workerEvaluator)');
const init = workerData as TuneWorkerInit;

const plans: RenderPlanEntry[] = [...RENDER_PLAN];
for (const url of init.modules) {
  const mod = (await import(url)) as { segments?: Segment[]; renderPlan?: RenderPlanEntry[] };
  for (const s of mod.segments ?? []) if (!SEGMENTS.some((x) => x.name === s.name)) SEGMENTS.push(s);
  plans.push(...(mod.renderPlan ?? []));
}
const targets: RenderTarget[] = init.targets.map((t) => {
  const plan = plans.find((p) => p.segment === t.segment && p.kind === t.kind);
  if (plan === undefined) throw new Error(`tuning worker: no render plan for segment ${t.segment} (kind ${t.kind})`);
  return { plan, perspective: t.perspective };
});
const evaluate = candidateEvaluator({ def: init.def, refs: init.refs, otherRefs: init.otherRefs, targets });

port.on('message', (task: TuneWorkerTask) => {
  let reply: TuneWorkerReply;
  try {
    reply = { id: task.id, result: evaluate(task.voicing) };
  } catch (e) {
    reply = { id: task.id, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  }
  port.postMessage(reply);
});
