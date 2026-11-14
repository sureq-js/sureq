/* eslint-disable @typescript-eslint/no-require-imports -- jest loads CommonJS test files by default */
// Runs against the built packages: npm run build -w @sureq/core -w @sureq/store-test first.
const { join } = require('node:path');
const { MemoryStore } = require('@sureq/core');
const { runStoreConformance } = require('@sureq/store-test');

runStoreConformance({
  name: 'smoke-jest',
  createStore: async () => {
    const store = new MemoryStore();
    return { store, cleanup: () => store.close() };
  },
  skip: ['contract', 'capabilities', 'claim', 'lease', 'lease-config', 'fencing', 'sweep', 'poison', 'release', 'cancel', 'gpause', 'clock'],
  report: join(process.env.SMOKE_REPORT_DIR, 'jest.json'),
});
