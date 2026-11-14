import assert from 'node:assert/strict';
import { newId } from '../harness.js';
import { addOne, addedJob, dup } from './dedup.js';
import type { GroupApi } from './types.js';
import { get, oneJob } from './util.js';

export function registerContractDedup(t: GroupApi): void {
  t.test(
    'contract: add atomic with a rejected duplicate writes nothing',
    async (env) => {
      const s = env.scope();
      const held = addedJob(await addOne(env, s));
      const before = { ...(await env.store.counts(s)) };
      const [x, z] = [newId(), newId()];
      const out = await env.store.add(s, [env.job({ id: x }), env.job({ id: held.id, onDuplicate: 'reject' }), env.job({ id: z })], { atomic: true });
      assert.deepEqual(out.map((o) => o.status), ['not-applied', 'duplicate', 'not-applied']);
      assert.equal(dup(out[1]).action, 'rejected');
      assert.deepEqual({ ...(await env.store.counts(s)) }, before);
      assert.equal(await env.store.get(s, x), null);
      assert.equal(await env.store.get(s, z), null);
      const ok = await env.store.add(s, [env.job({ id: x }), env.job({ id: held.id }), env.job({ id: z })], { atomic: true });
      assert.deepEqual(ok.map((o) => o.status), ['added', 'duplicate', 'added']);
      assert.equal(dup(ok[1]).action, 'ignored');
    },
    { requires: 'transactions' },
  );

  t.test("contract: replace overwrites only specified fields, never lowers maxAttempts below attempt and keeps a retry job's runAt", async (env) => {
    const s = env.scope();
    const first = addedJob(await addOne(env, s, { priority: 9, maxAttempts: 5, name: 'n1', timeout: '{"timeoutMs":1000}' }));
    const replace = { id: first.id, onDuplicate: 'replace' as const };
    await addOne(env, s, { ...replace, data: '"two"', maxAttempts: 3, defaulted: ['maxAttempts'] });
    let rec = await get(env, s, first.id);
    assert.deepEqual(
      [rec.data, rec.priority, rec.maxAttempts, rec.name, rec.timeout], ['"two"', 9, 5, 'n1', '{"timeoutMs":1000}'], 'unset and defaulted fields keep their values',
    );
    await addOne(env, s, { ...replace, timeout: '{"graceMs":0}' });
    assert.deepEqual(JSON.parse((await get(env, s, first.id)).timeout as string), { timeoutMs: 1000, graceMs: 0 }, 'a set timeout overrides only its own sub-fields');
    await addOne(env, s, { ...replace, timeout: null });
    assert.equal((await get(env, s, first.id)).timeout, null, 'a null timeout clears it');
    await addOne(env, s, { ...replace, name: null });
    assert.equal((await get(env, s, first.id)).name, null, 'null is a value');
    // two attempts: the first retries at once, the second waits 5 s
    let job = oneJob(await env.claim(s));
    await env.store.fail(s, { id: job.id, token: job.token, error: 'e', retryInMs: 0 });
    job = oneJob(await env.claim(s));
    const failed = await env.store.fail(s, { id: job.id, token: job.token, error: 'e', retryInMs: 5000 });
    assert.ok(failed.ok && failed.state === 'delayed');
    const retryAt = failed.runAt!;
    await addOne(env, s, { ...replace, maxAttempts: 1 });
    rec = await get(env, s, first.id);
    assert.deepEqual([rec.maxAttempts, rec.attempt], [2, 2], 'maxAttempts is raised to the attempts already used');
    assert.deepEqual([rec.state, rec.runAt], ['delayed', retryAt], 'a retry job keeps its runAt');
    const t0 = await env.store.now();
    await addOne(env, s, { ...replace, delayMs: 100 });
    const at = (await get(env, s, first.id)).runAt;
    assert.ok(at >= t0 + 100 && at <= (await env.store.now()) + 100, 'a delay on the replace sets a new runAt');
    const w = addedJob(await addOne(env, s));
    await addOne(env, s, { id: w.id, onDuplicate: 'replace', delayMs: 1000 });
    assert.equal((await get(env, s, w.id)).state, 'delayed', 'a waiting job given a delay becomes delayed');
  });

  t.test('contract: replace with a singletonKey held by another job is refused and writes nothing', async (env) => {
    const s = env.scope();
    const a = addedJob(await addOne(env, s, { singletonKey: 'k1' }));
    const b = addedJob(await addOne(env, s, { singletonKey: 'k2' }));
    const out = await addOne(env, s, { id: b.id, singletonKey: 'k1', data: '"x"', priority: 5, onDuplicate: 'replace' });
    assert.deepEqual(dup(out), { action: 'ignored', by: 'singletonKey', existingState: 'waiting', id: a.id });
    assert.deepEqual(await get(env, s, b.id), b);
    assert.deepEqual(await get(env, s, a.id), a);
  });

  t.test('contract: returning job meets a newer singleton holder, is requeued with singletonHeld false and is never dropped', async (env) => {
    const s = env.scope();
    const a = addedJob(await addOne(env, s, { singletonKey: 'k' }));
    const claimedA = oneJob(await env.claim(s));
    const b = addedJob(await addOne(env, s, { singletonKey: 'k' }));
    assert.equal(b.singletonHeld, true, 'the key was free while A ran');
    const res = await env.store.fail(s, { id: a.id, token: claimedA.token, error: 'e', retryInMs: 1000 });
    assert.ok(res.ok && res.state === 'delayed', 'A is requeued for its retry');
    const recA = await get(env, s, a.id);
    assert.deepEqual([recA.state, recA.singletonHeld], ['delayed', false]);
    assert.equal((await get(env, s, b.id)).singletonHeld, true);
    const counts = await env.store.counts(s);
    assert.deepEqual([counts.waiting, counts.delayed], [1, 1], 'both jobs exist');
  });
}
