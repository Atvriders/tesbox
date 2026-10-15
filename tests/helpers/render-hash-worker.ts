/**
 * A worker thread of tests/unit/render-identity.test.ts: hashes one engine's score renders (render-hash.ts
 * engineHashes) and posts them back, so the fifteen engines render in parallel.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { EngineDef } from '../../src/contracts';
import { engineHashes } from './render-hash';

if (parentPort === null) throw new Error('tests/helpers/render-hash-worker.ts runs as a worker thread of render-identity.test.ts');
parentPort.postMessage(engineHashes(workerData as EngineDef));
