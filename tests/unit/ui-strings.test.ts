import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STR } from '../../src/ui/strings';

/** The design spec with every whitespace run collapsed (quoted strings wrap across lines there). */
const spec = readFileSync(new URL('../../docs/superpowers/specs/2026-10-06-tesbox-design.md', import.meta.url), 'utf8').replace(
  /\s+/g,
  ' ',
);

/** Every plain string in a nested strings object (formatter functions are skipped). */
function allText(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(allText);
  if (node !== null && typeof node === 'object') return Object.values(node).flatMap(allText);
  return [];
}

describe('src/ui/strings.ts', () => {
  it('carries the five first-run notices verbatim from spec §10.2 item 2', () => {
    expect(STR.notices).toEqual([
      'Tesbox replaces your music while it runs',
      'Keep Tesbox on screen — it idles when minimised',
      'Cabin sound only — keep it below sirens',
      'First load needs Wi-Fi, hotspot or Premium Connectivity',
      'Not affiliated with Tesla, Inc. or any car maker',
    ]);
    for (const n of STR.notices) expect(spec, n).toContain(`"${n}"`);
  });

  it('carries the spec §13 disclaimer verbatim', () => {
    expect(STR.disclaimer).toBe(
      'Not affiliated with or endorsed by Tesla, Inc. or any car manufacturer. Engine sounds are synthesized impressions, not recordings of the named cars.',
    );
    expect(spec).toContain(`"${STR.disclaimer}"`);
  });

  it('carries the update banner verbatim from spec §12 (phase-4 contract T3)', () => {
    expect(STR.update.banner).toBe('Update available — tap to reload');
    expect(spec).toContain(`"${STR.update.banner}"`);
  });

  it('names every screen of the router', () => {
    expect(Object.keys(STR.screens).sort()).toEqual(['diagnostics', 'drive', 'first-run', 'garage', 'settings']);
    for (const title of Object.values(STR.screens)) expect(title.length).toBeGreaterThan(0);
  });

  it('labels the build with its SHA', () => {
    expect(STR.build('abc1234')).toBe('Build abc1234');
  });

  it('explains each unsupported reason and a boot failure', () => {
    expect(STR.unsupported.noAudioContext).toMatch(/AudioContext/);
    expect(STR.unsupported.noAudioWorklet).toMatch(/AudioWorklet/);
    expect(STR.unsupported.noModules).toMatch(/modules/);
    expect(STR.unsupported.bootFailed('boom')).toContain('boom');
  });

  it('warns about touchscreen use before Manual is first enabled (spec §10.2 item 4)', () => {
    expect(STR.manualWarning).toContain('StVO §23(1a)');
    expect(STR.manualWarning).toMatch(/own risk/);
  });

  it('labels the engine groups, units and audio states', () => {
    expect(STR.engineSets).toEqual({ euro: 'Euro', jdm: 'JDM', american: 'American', exotic: 'Exotic' });
    expect(STR.units).toEqual({ mph: 'mph', kmh: 'km/h' });
    expect(Object.keys(STR.audioStates).sort()).toEqual(['error', 'interrupted', 'off', 'running', 'starting']);
  });

  it('is plain, trimmed English with no emoji or leftover placeholders', () => {
    const text = allText(STR);
    expect(text.length).toBeGreaterThan(30);
    for (const s of text) {
      expect(s.length, JSON.stringify(s)).toBeGreaterThan(0);
      expect(s.trim(), JSON.stringify(s)).toBe(s);
      expect(s, s).not.toMatch(/TODO|FIXME|\{\{|\$\{/);
      expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
