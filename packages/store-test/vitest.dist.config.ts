import { defineConfig } from 'vitest/config';

// Runs the built-package tests; fails if none are found.
export default defineConfig({ test: { include: ['tests/dist/**/*.test.ts'] } });
