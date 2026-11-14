import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sureq/core': src('../../packages/core/src/index.ts'),
      '@sureq/store-test': src('../../packages/store-test/src/index.ts'),
    },
  },
  // globals: the conformance suite finds the runner through them.
  // The real-time groups wait for real leases and take minutes, so the runner's own timeouts are raised;
  // the suite enforces its own limit per test.
  test: { include: ['tests/**/*.test.ts'], globals: true, testTimeout: 600_000, hookTimeout: 600_000 },
});
