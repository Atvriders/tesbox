import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeVersionJson, versionPlugin } from '../../deploy/version-plugin';

describe('makeVersionJson', () => {
  it('serialises sha and builtAt as one JSON line', () => {
    const text = makeVersionJson('abc1234', '2026-01-02T03:04:05.000Z');
    expect(text).toBe('{"sha":"abc1234","builtAt":"2026-01-02T03:04:05.000Z"}\n');
    expect(JSON.parse(text)).toEqual({ sha: 'abc1234', builtAt: '2026-01-02T03:04:05.000Z' });
  });
});

describe('versionPlugin', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a build-only plugin', () => {
    const plugin = versionPlugin('abc1234');
    expect(plugin.name).toBe('tesbox-version');
    expect(plugin.apply).toBe('build');
  });

  it('emits version.json as an asset in generateBundle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    const emitted: unknown[] = [];
    const context = {
      emitFile(file: unknown): string {
        emitted.push(file);
        return 'ref';
      },
    };
    const hook = versionPlugin('abc1234').generateBundle;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    if (!fn) throw new Error('versionPlugin has no generateBundle hook');
    fn.call(context as never, {} as never, {} as never, false);
    expect(emitted).toEqual([
      {
        type: 'asset',
        fileName: 'version.json',
        source: makeVersionJson('abc1234', '2026-01-02T03:04:05.000Z'),
      },
    ]);
  });
});
