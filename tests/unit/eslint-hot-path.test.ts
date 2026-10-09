import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MESSAGE = 'Hot path must not allocate (spec §4.4)';

// Amendments B1 (selector anchored inside the method body) and B17 (`input[A-Za-z]*`, e.g. inputPair).
// Each flagged method holds exactly one allocating construct — process: array, readLagrange: new,
// render: arrow, outLeft: template, step: try, write: throw, scatter: spread, push: object,
// update: function expression (inputPair: array, for the B17 name) — so dropping any construct from
// the selector changes the flagged lines. Field initialisers (buf, err) are not hot paths.
const PROBE = `export class Probe {
  private y = 0;
  private readonly buf = new Float32Array(4);
  private readonly err = new RangeError('x');
  tick(x: number): number { this.y += x; return this.y; }
  process(x: number): number { const a = [x]; return a[0] ?? 0; }
  readLagrange(d: number): number { return new Float32Array(1)[0] ?? d; }
  render(): number { const f = (): number => this.y; return f(); }
  outLeft(): string { return \`\${this.y}\`; }
  step(): void { try { this.y = 1; } catch { this.y = 0; } }
  write(x: number): void { if (x > 1) throw this.err; }
  scatter(a: number[]): number { return Math.max(...a); }
  push(): number { const o = { a: this.y }; return o.a; }
  update(): number { const f = function (): number { return 1; }; return f(); }
  inputPair(a: number, b: number): number { return [a, b].length; }
  ticker(): number[] { return [this.y]; }
  configure(): void { this.buf.fill(0); const tmp = new Float64Array(2); void tmp; }
}
`;

function lineOf(needle: string): number {
  return PROBE.split('\n').findIndex((l) => l.includes(needle)) + 1;
}

async function hotPathLines(filePath: string): Promise<number[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(PROBE, { filePath });
  if (result === undefined) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  const hits = result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  for (const m of hits) expect(m.message).toBe(MESSAGE);
  return [...new Set(hits.map((m) => m.line))].sort((a, b) => a - b);
}

describe('eslint hot-path allocation rule', () => {
  it('flags allocation inside hot-path method bodies in src/dsp and nothing else', { timeout: 30_000 }, async () => {
    const expected = ['process(x', 'readLagrange', 'render()', 'outLeft', 'step()', 'write(x', 'scatter', 'push()', 'update()', 'inputPair']
      .map(lineOf)
      .sort((a, b) => a - b);
    expect(await hotPathLines('src/dsp/__hot_path_probe__.ts')).toEqual(expected);
  });

  it('applies to src/sim as well', { timeout: 30_000 }, async () => {
    expect((await hotPathLines('src/sim/__hot_path_probe__.ts')).length).toBe(10);
  });

  it('does not apply outside src/dsp and src/sim', { timeout: 30_000 }, async () => {
    expect(await hotPathLines('src/ui/__hot_path_probe__.ts')).toEqual([]);
  });
});
