import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStoreError, STORE_CONTRACT_VERSION, StoreError, type NewSchedule, type Scope, type Store } from '@sureq/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createTemplateStore, ToyBackend } from '../src/index.js';
import { PENDING } from '../src/pending.js';

const root = new URL('..', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const sources = (): string[] => readdirSync(new URL('src', root)).map((f) => `src/${f}`);

const METHODS = [
  'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get', 'list', 'counts',
  'setPaused', 'isPaused', 'stats', 'getAttempts', 'clean', 'obliterate', 'redrive', 'setProgress', 'registerWorker', 'heartbeatWorker',
  'unregisterWorker', 'listWorkers', 'purgeWorkers', 'ensureNamespaceMeta', 'getNamespaceMeta', 'putSchedule', 'getSchedule',
  'listSchedules', 'deleteSchedule', 'listDueSchedules', 'fireSchedule',
] as const satisfies readonly (keyof Store)[];
// Fails to compile when the contract gains a method this list does not have.
type Unlisted = Exclude<keyof Store, 'contractVersion' | 'capabilities' | 'subscribe' | (typeof METHODS)[number]>;
const _complete: [Unlisted] extends [never] ? true : false = true;
void _complete;

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function fresh(): Promise<{ file: string; open: () => Store }> {
  const dir = await mkdtemp(join(tmpdir(), 'store-template-unit-'));
  dirs.push(dir);
  const file = join(dir, 'journal.jsonl');
  return { file, open: () => createTemplateStore({ backend: new ToyBackend({ journalFile: file }) }) };
}

describe('template', () => {
  it('template: reopen restores all acknowledged writes from the snapshot', async () => {
    const { open } = await fresh();
    const store = open();
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'q' };
    const ids = Array.from({ length: 50 }, (_, i) => `job-${i}`);
    await store.add(s, ids.map((id) => ({ id, data: new Uint8Array([1, 2, 3]), formatVersion: 1, maxAttempts: 2 })));
    const claimed = await store.claim(s, { workerId: 'w', claimId: 'c1', limit: 25, leaseMs: 60_000 });
    for (const job of claimed.jobs.slice(0, 20)) await store.complete(s, { id: job.id, token: job.token, result: 'ok' });
    for (const job of claimed.jobs.slice(20)) await store.fail(s, { id: job.id, token: job.token, error: 'boom' });
    await store.setPaused(s, true);
    const lastToken = Math.max(...claimed.jobs.map((j) => j.token));
    const schedule = (key: string): NewSchedule => ({
      formatVersion: 1, key, kind: 'every', everyMs: 60_000, anchorAt: 0, template: { name: null, data: '{}', opts: {} }, overlap: 'skip', maxQueued: 10,
      paused: false, nextRunAt: 60_000, lastFiredFor: null, lastJobId: null, queuedTicks: [], runCount: 0, definitionHash: 'h', definitionVersion: 0,
    });
    for (const key of ['kept', 'gone']) await store.putSchedule(s, { schedule: schedule(key), expectedRev: null });
    await store.deleteSchedule(s, { key: 'gone' });

    const again = open();
    await again.open();
    expect(await again.counts(s)).toEqual(await store.counts(s));
    expect(await again.isPaused(s)).toBe(true);
    for (const state of ['waiting', 'completed', 'failed'] as const) {
      const req = { state, offset: 0, limit: 100, order: 'asc' } as const;
      expect(await again.list(s, req)).toEqual(await store.list(s, req));
    }
    expect((await again.get(s, ids[0]!))?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(await again.listSchedules(s, { limit: 10 })).toEqual(await store.listSchedules(s, { limit: 10 }));
    expect((await again.listSchedules(s, { limit: 10 })).schedules.map((r) => r.key)).toEqual(['kept']);
    await again.setPaused(s, false);
    const next = await again.claim(s, { workerId: 'w', claimId: 'c2', limit: 1, leaseMs: 60_000 });
    expect(next.jobs[0]!.token).toBeGreaterThan(lastToken);
  });

  it('template: a reused id moves the finished record to history, which survives reopen and no read sees', async () => {
    const { file, open } = await fresh();
    const store = open();
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'q' };
    await store.add(s, [{ id: 'a', data: '1', formatVersion: 1, maxAttempts: 1 }]);
    const job = (await store.claim(s, { workerId: 'w', claimId: 'c', limit: 1, leaseMs: 60_000 })).jobs[0]!;
    await store.complete(s, { id: 'a', token: job.token, result: null });
    await store.add(s, [{ id: 'a', data: '2', formatVersion: 1, maxAttempts: 1 }]);
    const history = `a#${job.seq}`;
    const check = async (st: Store): Promise<void> => {
      expect(await st.get(s, history)).toBeNull();
      expect(await st.list(s, { state: 'completed', offset: 0, limit: 10, order: 'asc' })).toEqual([]);
      expect(await st.counts(s)).toMatchObject({ completed: 0, waiting: 1 });
      // its attempt rows moved with it: only getAttempts reads the history key
      expect((await st.getAttempts(s, { id: history })).attempts.map((r) => [r.token, r.outcome])).toEqual([[job.token, 'completed']]);
      expect((await st.getAttempts(s, { id: 'a' })).attempts).toEqual([]);
    };
    await check(store);
    // the journal holds the moved record as one history entry
    expect(readFileSync(file, 'utf8')).toContain(`"hist"`);
    const again = open();
    await again.open();
    await check(again);
    expect(readFileSync(file, 'utf8')).toContain(history);
  });

  it('history: a renew with started and batchId records the batch and heldMs on the attempt row, and survives reopen', async () => {
    const { file } = await fresh();
    let t = 1000;
    const open = (): Store => createTemplateStore({ backend: new ToyBackend({ journalFile: file, clock: { now: () => t } }) });
    const store = open();
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'q' };
    await store.add(s, [{ id: 'a', data: '1', formatVersion: 1, maxAttempts: 1 }]);
    const job = (await store.claim(s, { workerId: 'w', claimId: 'c', limit: 1, leaseMs: 60_000 })).jobs[0]!;
    t = 1250;
    await expect(store.renew(s, { id: 'a', token: job.token, leaseMs: 60_000, batchId: 'b1' })).rejects.toMatchObject({ code: 'STORE_BAD_REQUEST' });
    expect(await store.renew(s, { id: 'a', token: job.token, leaseMs: 60_000, started: true, batchId: 'b1' })).toMatchObject({ ok: true, now: 1250 });
    const row = (await store.getAttempts(s, { id: 'a' })).attempts[0];
    expect(row).toMatchObject({ startedAt: 1000, lastRenewAt: 1250, batchId: 'b1', heldMs: 250, outcome: 'running' });
    const again = open();
    await again.open();
    expect((await again.getAttempts(s, { id: 'a' })).attempts).toEqual([row]);
  });

  it('template: namespace meta survives reopen and is never lowered', async () => {
    const { open } = await fresh();
    const store = open();
    await store.open();
    const ns = { namespace: 'ns' };
    expect(await store.ensureNamespaceMeta(ns, { current: 1, minReadable: 1, maxReadable: 2, sureqVersion: 'a' })).toMatchObject({ created: true });
    expect(await store.ensureNamespaceMeta(ns, { current: 2, minReadable: 1, maxReadable: 2, sureqVersion: 'b' })).toMatchObject({ raised: true });
    const again = open();
    await again.open();
    expect(await again.getNamespaceMeta(ns)).toEqual(await store.getNamespaceMeta(ns));
    expect(await again.ensureNamespaceMeta(ns, { current: 1, minReadable: 1, maxReadable: 2, sureqVersion: 'c' })).toEqual({
      formatVersion: 2, created: false, raised: false,
    });
    expect(await again.getNamespaceMeta(ns)).toMatchObject({ formatVersion: 2, createdBy: 'a', lastRaisedBy: 'b' });
  });

  it('template: a call queued before close is refused once the store is closed', async () => {
    const { open } = await fresh();
    const store = open();
    await store.open();
    const pending = store.add({ namespace: 'ns', queue: 'q' }, [{ id: 'x', data: '1', formatVersion: 1, maxAttempts: 1 }]);
    const closing = store.close();
    await expect(pending).rejects.toMatchObject({ code: 'STORE_BAD_REQUEST' });
    await closing;
  });

  it('template: replay drops a torn last line and refuses a corrupt middle line', async () => {
    const { file, open } = await fresh();
    const store = open();
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'q' };
    await store.add(s, [{ id: 'a', data: '1', formatVersion: 1, maxAttempts: 1 }]);
    appendFileSync(file, '[["put","bro');
    const again = open();
    await again.open();
    expect((await again.get(s, 'a'))?.id).toBe('a');
    appendFileSync(file, '\n[]\n');
    let err: unknown;
    try {
      open();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: 'STORE_ERROR', message: expect.stringMatching(/corrupt at line 2/), cause: expect.any(SyntaxError) });
  });

  it('template: a replace merges a stored timeout only when it is an object of integer fields', async () => {
    const store = createTemplateStore({ backend: new ToyBackend() });
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'q' };
    const replaced = async (id: string, stored: string, given: string) => {
      await store.add(s, [{ id, data: '1', formatVersion: 1, maxAttempts: 1, timeout: stored }]);
      await store.add(s, [{ id, data: '2', formatVersion: 1, maxAttempts: 1, timeout: given, onDuplicate: 'replace' }]);
      return (await store.get(s, id))?.timeout;
    };
    expect(await replaced('obj', '{"ms":1,"graceMs":2}', '{"ms":5}')).toBe('{"ms":5,"graceMs":2}');
    expect(await replaced('arr', '[1,2]', '{"ms":5}')).toBe('{"ms":5}');
    expect(await replaced('frac', '{"ms":1.5}', '{"graceMs":3}')).toBe('{"graceMs":3}');
    expect(await replaced('str', '"x"', '{"ms":5}')).toBe('{"ms":5}');
  });

  it('template: never calls Date.now outside the injected clock', () => {
    const forbidden = /Date\.now|new Date\(|performance\.now/;
    for (const file of ['src/store.ts', 'src/schedules.ts', 'src/workers.ts']) expect(forbidden.test(read(file)), file).toBe(false);
    const backend = read('src/backend.ts');
    expect(backend.match(/Date\.now/g)).toHaveLength(1);
    expect(backend).toMatch(/injected \? \(\) => injected\.now\(\) : Date\.now/);
    expect(/new Date\(|performance\.now/.test(backend)).toBe(false);
  });

  it('template: every contract method has a SUREQ-CONTRACT block comment', () => {
    const text = sources().map(read).join('\n');
    const tags = [...text.matchAll(/SUREQ-CONTRACT: (\w+)/g)].map((m) => m[1]!);
    const pending: readonly string[] = PENDING;
    expect([...tags].sort()).toEqual(METHODS.filter((m) => !pending.includes(m)).sort());
    for (const block of text.split('/*\n').slice(1)) {
      if (!block.includes('SUREQ-CONTRACT:')) continue;
      expect(block.split('*/')[0]).toMatch(/\bWHY: /);
    }
    const replaceMe = text.split('\n').filter((l) => l.includes('REPLACE-ME:'));
    expect(replaceMe.length).toBeGreaterThan(0);
    for (const line of replaceMe) for (const word of ['SQL', 'Redis', 'Mongo']) expect(line).toContain(word);
  });

  it('template: methods not built yet reject with StoreRequestError naming the operation', async () => {
    let t = 5000;
    const store = createTemplateStore({ backend: new ToyBackend({ clock: { now: () => t } }) });
    await store.open();
    await store.add({ namespace: 'n', queue: 'q' }, [{ id: 'a', data: '', formatVersion: 1, maxAttempts: 1 }]);
    const before = await store.get({ namespace: 'n', queue: 'q' }, 'a');
    t = 6000;
    for (const op of PENDING) {
      const call = store[op] as (scope: unknown, req: unknown) => Promise<unknown>;
      const e = await call.call(store, { namespace: 'n', queue: 'q' }, {}).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(isStoreError(e), op).toBe(true);
      expect(e, op).toMatchObject({ code: 'STORE_BAD_REQUEST', operation: op });
    }
    expect(await store.get({ namespace: 'n', queue: 'q' }, 'a')).toEqual(before);
  });

  it('template: implemented methods match the method list', () => {
    const store = createTemplateStore({ backend: new ToyBackend() }) as unknown as Record<string, unknown>;
    const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
    const functions = [...Object.getOwnPropertyNames(store), ...Object.getOwnPropertyNames(proto)].filter(
      (name) => name !== 'constructor' && typeof store[name] === 'function',
    );
    expect([...functions].sort()).toEqual([...METHODS].sort());
    expect(store['subscribe']).toBeUndefined();
  });

  it('template: contractVersion equals STORE_CONTRACT_VERSION', () => {
    const store = createTemplateStore({ backend: new ToyBackend() });
    expect(store.contractVersion).toBe(STORE_CONTRACT_VERSION);
    expect(Object.isFrozen(store.capabilities)).toBe(true);
    const on = Object.entries(store.capabilities).filter(([, v]) => v === true).map(([k]) => k);
    expect(on.sort()).toEqual(['durable', 'skipLocked', 'transactions']);
  });

  it('template: has no any and no runtime dependencies besides sureq', () => {
    for (const file of sources()) expect(read(file)).not.toMatch(/: any\b|as any\b|<any>|\bany\[\]/);
    const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
    expect(pkg['dependencies']).toBeUndefined();
    expect(Object.keys(pkg['peerDependencies'] as object)).toEqual(['@sureq/core']);
    expect(pkg['private']).toBe(true);
  });

  it('template: a job deleted longer than the tombstone lifetime after it finished leaves no tombstone', async () => {
    let t = 1_000_000;
    const store = createTemplateStore({ backend: new ToyBackend({ clock: { now: () => t } }) });
    await store.open();
    const s: Scope = { namespace: 'ns', queue: 'tombstones' };
    await store.add(s, ['old', 'new'].map((id) => ({ id, data: '{}', formatVersion: 1, maxAttempts: 1 })));
    const [a, b] = (await store.claim(s, { workerId: 'w', claimId: 'c', limit: 2, leaseMs: 3_600_000 })).jobs;
    await store.complete(s, { id: 'old', token: a!.token, result: null });
    t += 600_000;
    await store.complete(s, { id: 'new', token: b!.token, result: null });
    expect(await store.clean(s, { state: 'completed', olderThanMs: 0, limit: 10 })).toEqual({ removed: 2, remaining: false });
    expect(await store.complete(s, { id: 'old', token: a!.token, result: null })).toEqual({ ok: false, reason: 'not-active' });
    expect(await store.complete(s, { id: 'new', token: b!.token, result: null })).toMatchObject({ ok: true, repeated: true });
  });

  it('template: store.ts stays under 600 lines', () => {
    expect(read('src/store.ts').split('\n').length).toBeLessThan(600);
  });
});
