import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { STR } from '../../src/ui/strings';

const code = readFileSync(new URL('../../public/unsupported.js', import.meta.url), 'utf8');

class FakeEl {
  hidden: boolean;
  textContent = '';
  constructor(hidden = false) {
    this.hidden = hidden;
  }
  removeAttribute(name: string): void {
    if (name === 'hidden') this.hidden = false;
  }
}

interface Env {
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  /** ES-module support, as `'noModule' in <script>` reports it. */
  modules?: boolean;
  /** Markup present in the page (default: all three). */
  ids?: string[];
}

/** Runs public/unsupported.js the way a classic <script> would, against a fake window/document. */
function run(env: Env): { box: FakeEl; reason: FakeEl; app: FakeEl } {
  // As main.ts leaves them on a supported browser: the static block hidden, the app shown.
  const els: Record<string, FakeEl> = {
    unsupported: new FakeEl(true),
    'unsupported-reason': new FakeEl(),
    app: new FakeEl(),
  };
  const present = new Set(env.ids ?? Object.keys(els));
  const document = {
    getElementById: (id: string): FakeEl | null => (present.has(id) ? (els[id] ?? null) : null),
    createElement: (): object => (env.modules === false ? {} : { noModule: false }),
  };
  const window: Record<string, unknown> = { document };
  if ('AudioContext' in env) window.AudioContext = env.AudioContext;
  if ('AudioWorkletNode' in env) window.AudioWorkletNode = env.AudioWorkletNode;
  runInNewContext(code, { window, document });
  return { box: els.unsupported as FakeEl, reason: els['unsupported-reason'] as FakeEl, app: els.app as FakeEl };
}

const ctor = function AudioThing(): void {};
const FULL: Env = { AudioContext: ctor, AudioWorkletNode: ctor, modules: true };

describe('public/unsupported.js', () => {
  it('is an ES5 classic script (MCU1 QtCarBrowser has no ES2015)', () => {
    expect(() => parse(code, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow();
  });

  it('leaves a supported browser alone', () => {
    const { box, reason, app } = run(FULL);
    expect(box.hidden).toBe(true);
    expect(reason.textContent).toBe('');
    expect(app.hidden).toBe(false);
  });

  it('reveals #unsupported with the reason and hides #app when AudioWorkletNode is missing', () => {
    const { box, reason, app } = run({ AudioContext: ctor, modules: true });
    expect(box.hidden).toBe(false);
    expect(reason.textContent).toBe(STR.unsupported.noAudioWorklet);
    expect(app.hidden).toBe(true);
  });

  it('reveals it when AudioContext is missing', () => {
    const { box, reason } = run({ AudioWorkletNode: ctor, modules: true });
    expect(box.hidden).toBe(false);
    expect(reason.textContent).toBe(STR.unsupported.noAudioContext);
  });

  it('reveals it when ES modules are missing (the nomodule copy), naming modules first', () => {
    const { box, reason } = run({ modules: false });
    expect(box.hidden).toBe(false);
    expect(reason.textContent).toBe(STR.unsupported.noModules);
  });

  it('never throws when the markup is missing', () => {
    expect(() => run({ modules: false, ids: [] })).not.toThrow();
    expect(() => run({ modules: false, ids: ['unsupported'] })).not.toThrow();
    expect(run({ modules: false, ids: ['unsupported'] }).box.hidden).toBe(false);
  });

  it('defines no globals', () => {
    const window: Record<string, unknown> = {};
    const document = { getElementById: (): null => null, createElement: (): object => ({}) };
    const ctx: Record<string, unknown> = { window, document };
    runInNewContext(code, ctx);
    expect(Object.keys(ctx).sort()).toEqual(['document', 'window']);
    expect(Object.keys(window)).toEqual([]);
  });
});
