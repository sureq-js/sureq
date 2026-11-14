import { describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { NamespaceBlindStore, newJob, type IsolationStore } from '../helpers/seed.js';
import { claimReq as freshClaim, openStore } from '../helpers/store.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Every cross-namespace assertion, against any store. Throws when isolation is broken. */
async function isolationChecks(store: IsolationStore): Promise<void> {
  const a = { namespace: 'app', queue: 'q' };
  const b = { namespace: 'app2', queue: 'q' };
  await store.add(a, [newJob({ id: 'only-in-app' })]);
  expect(await store.get(b, 'only-in-app')).toBeNull();
  expect((await store.counts(b))['waiting']).toBe(0);
  expect((await store.claim(b, freshClaim())).jobs).toEqual([]);
  expect(await store.remove(b, { id: 'only-in-app' })).toEqual({ removed: false, reason: 'not-found' });
  await store.add(b, [newJob({ id: 'only-in-app2' })]);
  expect(await store.get(a, 'only-in-app2')).toBeNull();
  expect((await store.counts(a))['waiting']).toBe(1);
}

describe('ns (isolation)', () => {
  it('ns: jobs in one namespace are invisible to another with the same queue name', async () => {
    const store = await openStore();
    const q1 = new Queue('jobs', { store, namespace: 'tenant-a' });
    const q2 = new Queue('jobs', { store, namespace: 'tenant-b' });
    await store.add(q1.internals.scope, [newJob({ id: 'x1' })]);
    expect(await store.get(q2.internals.scope, 'x1')).toBeNull();
    expect((await store.counts(q2.internals.scope)).waiting).toBe(0);
  });

  it('ns: same job id can exist in two namespaces', async () => {
    const store = await openStore();
    const q1 = new Queue('jobs', { store, namespace: 'a' });
    const q2 = new Queue('jobs', { store, namespace: 'b' });
    await store.add(q1.internals.scope, [newJob({ id: 'same' })]);
    await store.add(q2.internals.scope, [newJob({ id: 'same' })]);
    expect(await store.get(q1.internals.scope, 'same')).not.toBeNull();
    expect(await store.get(q2.internals.scope, 'same')).not.toBeNull();
  });

  it('ns: counts, claim and remove never cross namespaces', async () => {
    await isolationChecks(await openStore());
  });

  it('ns: namespace that is a prefix of another does not leak', async () => {
    const store = await openStore();
    for (const [mine, other] of [['app', 'app2'], ['app2', 'app']] as const) {
      await store.add({ namespace: mine, queue: 'p' }, [newJob({ id: `in-${mine}` })]);
      expect(await store.get({ namespace: other, queue: 'p' }, `in-${mine}`)).toBeNull();
    }
  });

  it('ns: job record carries the namespace it was added under', async () => {
    const store = await openStore();
    const q = new Queue('jobs', { store, namespace: 'billing-prod', logger: silent });
    await store.add(q.internals.scope, [newJob({ id: 'b1' })]);
    expect((await store.get(q.internals.scope, 'b1'))!.namespace).toBe('billing-prod');
  });

  it('ns: broken store that ignores namespace fails the isolation tests', async () => {
    await expect(isolationChecks(new NamespaceBlindStore(await openStore()))).rejects.toThrow();
  });
});
