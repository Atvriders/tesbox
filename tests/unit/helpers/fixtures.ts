/**
 * The Phase 2a fixture engines (tests/fixtures/engines/<id>.json), shared by every DSP and tool test.
 * Not a test file: Vitest only collects files ending in .test.ts.
 */
import { readFileSync } from 'node:fs';
import type { EngineDef } from '../../../src/contracts';

/** The eight fixture engine ids, in contract order. */
export const FIXTURE_IDS = [
  'i4-test',
  'i5-test',
  'i6-test',
  'v8-crossplane-test',
  'v8-flatplane-test',
  'v8-sc-test',
  'flat4-uel-test',
  'rotary-test',
] as const;

/** Parses tests/fixtures/engines/<id>.json afresh on every call, so callers may mutate the result. */
export function loadFixture(id: string): EngineDef {
  const url = new URL(`../../fixtures/engines/${id}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as EngineDef;
}
