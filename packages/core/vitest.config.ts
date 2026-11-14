import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// SUREQ_TARGET picks what the public specifiers `@sureq/core` and `@sureq/core/producer` resolve to,
// so the same public suite can run against source, built ESM or built CJS.
const target = process.env['SUREQ_TARGET'] ?? 'src';
const entries = ({
  src: ['src/index.ts', 'src/producer.ts'], esm: ['dist/index.js', 'dist/producer.js'], cjs: ['dist/index.cjs', 'dist/producer.cjs'],
} as Record<string, [main: string, producer: string]>)[target];
if (!entries) throw new TypeError(`SUREQ_TARGET must be src, esm or cjs (got ${target})`);
const file = (f: string) => fileURLToPath(new URL(f, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sureq\/core\/producer$/, replacement: file(entries[1]) },
      { find: /^@sureq\/core$/, replacement: file(entries[0]) },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/build.ts'],
    typecheck: { enabled: false, include: ['tests/types/**/*.test-d.ts'] },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
