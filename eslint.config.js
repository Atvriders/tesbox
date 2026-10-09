// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Spec §4.4 / phase 2a contract B1 + B17: hot-path methods in src/dsp and src/sim must not allocate. */
const HOT_PATH_METHOD =
  'MethodDefinition[key.name=/^(tick|process|render|scatter|write|read[A-Za-z]*|step|push|accept|evaluate|update|next|request|input[A-Za-z]*|out[A-Za-z]*)$/]';
const ALLOCATING =
  'NewExpression, ArrayExpression, ObjectExpression, ArrowFunctionExpression, FunctionExpression, SpreadElement, TemplateLiteral, TryStatement, ThrowStatement';

export default defineConfig(
  globalIgnores(['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'public/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/dsp/**/*.ts', 'src/sim/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // `> FunctionExpression > BlockStatement` anchors the match inside the method body (B1).
          selector: `${HOT_PATH_METHOD} > FunctionExpression > BlockStatement :matches(${ALLOCATING})`,
          message: 'Hot path must not allocate (spec §4.4)',
        },
      ],
    },
  },
);
