import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@sureq/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/dist/**', 'tests/smoke/**', '**/node_modules/**'],
    coverage: { provider: 'v8', include: ['src/**'], thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 } },
  },
});
