import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const doc = readFileSync(new URL('docs/CLEAN_ROOM.md', root), 'utf8');

/** The "## Phase 2a source log" section, up to the next level-2 heading. */
function phase2aSection(): string {
  const start = doc.indexOf('## Phase 2a source log');
  if (start < 0) return '';
  const next = doc.indexOf('\n## ', start + 1);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
}

describe('docs/CLEAN_ROOM.md — Phase 2a source log', () => {
  it('has the Phase 2a section after the binding policy', () => {
    expect(doc.indexOf('## Policy')).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf('## Phase 2a source log')).toBeGreaterThan(doc.indexOf('## Policy'));
  });

  it('logs every src/dsp module and every Phase 2a tool', () => {
    const section = phase2aSection();
    const modules = readdirSync(new URL('src/dsp/', root))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/dsp/${f}`);
    expect(modules.length).toBeGreaterThan(0);
    const tools = ['tools/wav.ts', 'tools/segments.ts', 'tools/render.ts', 'tools/check-alloc.ts', 'tools/bench-dsp.ts'];
    for (const path of [...modules, ...tools]) expect(section, path).toContain(`\`${path}\``);
  });

  it('cites every source the phase 2a contract requires', () => {
    const section = phase2aSection();
    for (const source of [
      'Baldan',
      'Farnell',
      'Doerfler & Wyse',
      'Physical Audio Signal Processing',
      'Bristow-Johnson',
      'Larsen & R. M. Aarts',
      'ITU-R BS.1770',
      'Kaiser',
      'Giannoulis',
    ]) {
      expect(section, source).toContain(source);
    }
  });
});
