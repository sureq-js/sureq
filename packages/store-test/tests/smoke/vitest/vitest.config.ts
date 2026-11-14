import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@sureq/core': fileURLToPath(new URL('../../../../core/src/index.ts', import.meta.url)) } },
  test: { include: ['smoke.test.ts'], globals: true },
});
