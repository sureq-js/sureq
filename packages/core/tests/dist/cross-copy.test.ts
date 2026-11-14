// Dual-package hazard: the built ESM and CJS copies loaded in one process. Runs on dist always.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type Pkg = typeof import('../../src/index.js');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('cross-copy brands', { timeout: 30_000 }, () => {
  it('pkg: error brand checks work across ESM and CJS copies', async () => {
    const esm = (await import('../../dist/index.js' as string)) as Pkg;
    const cjs = createRequire(import.meta.url)('../../dist/index.cjs') as Pkg;
    expect(esm.UnrecoverableError).not.toBe(cjs.UnrecoverableError);
    expect(esm.isSureQError(new cjs.UnrecoverableError('x'))).toBe(true);
    expect(cjs.isSureQError(new esm.UnrecoverableError('x'))).toBe(true);
    expect(esm.isUnrecoverable(new cjs.UnrecoverableError('x'))).toBe(true);
    const cjsStoreError = new cjs.StoreError('x', { operation: 'get', retryable: true, outcomeUnknown: false });
    expect(esm.isStoreError(cjsStoreError)).toBe(true);

    const q = new esm.Queue('copy', { logger: silent, defaultJobOptions: { backoff: 0 } });
    let calls = 0;
    const w = q.process(() => {
      calls++;
      throw new cjs.UnrecoverableError('from the other copy');
    }, { pollMin: 5, pollMax: 5, pollJitter: 0 });
    const failed = new Promise<{ reason: string }>((r) => w.once('failed', r as never));
    await q.add(1, { maxAttempts: 5 });
    expect((await failed).reason).toBe('unrecoverable');
    expect(calls).toBe(1);
    await q.close();

    // The two MemoryStore classes are distinct; a foreign-copy store is accepted by brand.
    expect(esm.MemoryStore).not.toBe(cjs.MemoryStore);
    const shared = new cjs.MemoryStore();
    const qe = new esm.Queue('mixed', { store: shared as never, logger: silent });
    await qe.add(1);
    expect((await qe.getCounts()).waiting).toBe(1);
    await qe.close();
  });
});
