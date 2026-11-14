import tseslint from 'typescript-eslint';
import { builtinModules } from 'node:module';

const MEMORY_STORE_IMPORT_SEVERITY = 'error';
const nodePrefixPaths = builtinModules.map((name) => ({ name, message: `Use 'node:${name}'.` }));
const PLATFORM_ONLY = 'Node-only API: reach it through the platform layer (packages/core/src/platform).';
const nodeOnlyPattern = { group: ['node:*'], message: PLATFORM_ONLY };
const nodeOnlyGlobals = ['Buffer', 'process', 'require', 'setImmediate', '__dirname', '__filename'].map((name) => ({ name, message: PLATFORM_ONLY }));

export default tseslint.config(
  // docs-site is a separate app with its own toolchain (`npm run typecheck` there).
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.remember/**', 'docs-site/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Names starting with _ are deliberately unused (type-test probes, ignored parameters).
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/*/src/**/*.ts', 'examples/*/src/**/*.ts'],
    rules: {
      // No `any` anywhere in src, which covers every exported declaration.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Error']", message: 'Use a catalogued SureQError.' },
      ],
      // Node built-ins must use the node: prefix.
      'no-restricted-imports': ['error', { paths: nodePrefixPaths }],
    },
  },
  // Core is runtime-neutral: only the Node platform module touches Node built-ins and globals.
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/platform/node.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: nodePrefixPaths, patterns: [nodeOnlyPattern] }],
      'no-restricted-globals': ['error', ...nodeOnlyGlobals],
    },
  },
  // The memory store sees only the contract, capabilities, errors and util.
  {
    files: ['packages/core/src/store/memory/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        MEMORY_STORE_IMPORT_SEVERITY,
        {
          paths: [
            ...nodePrefixPaths,
            { name: '@sureq/core', message: 'The memory store may import only the contract, capabilities, errors and util.' },
          ],
          patterns: [
            nodeOnlyPattern,
            { regex: '^\\.\\./(?!\\.\\./|(contract|capabilities)\\.js$)', message: 'The memory store may import only ../contract.js and ../capabilities.js from the store folder.' },
            { regex: '^\\.\\./\\.\\./(?!(errors|util)/)', message: 'The memory store may import only ../../errors/** and ../../util/** from the rest of core.' },
          ],
        },
      ],
    },
  },
);
