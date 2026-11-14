import assert from 'node:assert/strict';
import { STORE_CONTRACT_VERSION, type JobRecord, type JobState, type NewJob, type Store } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { GroupApi } from './types.js';
import { claimed, CONTRACT_METHODS, deleteJob, eventually, get, listAll, rejectsCapability, rejectsRequest, STATES, sweepReq, ZERO_COUNTS, oneJob } from './util.js';

const counts = async (store: Store, ...args: Parameters<Store['counts']>) => ({ ...(await store.counts(...args)) });

/** add, claim and fail with a retry, then a reopened store object must show the same job. */
export async function acknowledgedWritesSurviveReopen(env: TestEnv): Promise<void> {
  const s = env.scope();
  const jobs = await env.addJobs(s, 14);
  const job = oneJob(await env.claim(s));
  const { token } = job;
  const failed = await env.store.fail(s, { id: job.id, token, error: 'boom', retryInMs: 60_000 });
  assert.equal(failed.ok, true);
  const before = await get(env, s, job.id);
  const s2 = await env.reopen();
  await s2.open();
  const after = await s2.get(s, job.id);
  assert.ok(after, 'the job survives reopen');
  assert.deepEqual(
    { state: after.state, attempt: after.attempt, crashCount: after.crashCount, error: after.error, rev: after.rev },
    { state: before.state, attempt: before.attempt, crashCount: before.crashCount, error: before.error, rev: before.rev },
  );
  for (const j of jobs) assert.ok(await s2.get(s, j.id), `added job ${j.id} survives reopen`);
}

export function registerContractRecords(t: GroupApi): void {
  t.test('contract: store exposes integer contractVersion and frozen capabilities', async (env) => {
    assert.ok(Number.isInteger(env.store.contractVersion));
    assert.ok(Object.isFrozen(env.store.capabilities));
    assert.ok(Object.isFrozen(env.store.capabilities.limits));
  });

  t.test('contract: store has a function for every method of the contract it declares', async (env) => {
    assert.equal(env.store.contractVersion, STORE_CONTRACT_VERSION);
    const store = env.store as unknown as Record<string, unknown>;
    for (const m of CONTRACT_METHODS) assert.equal(typeof store[m], 'function', `${m} is a function`);
  });

  t.test('contract: cancel sets cancelReason user and other records keep null', async (env) => {
    const s = env.scope();
    const done = await claimed(env, s);
    assert.equal((await env.store.complete(s, { id: done.job.id, token: done.token, result: null })).ok, true);
    const failed = await claimed(env, s);
    assert.equal((await env.store.fail(s, { id: failed.job.id, token: failed.token, error: 'boom' })).ok, true);
    const active = (await claimed(env, s)).job;
    const [waiting] = await env.addJobs(s, 1);
    const [delayed] = await env.addJobs(s, 1, { delayMs: 60_000 });
    for (const job of [waiting!, delayed!, active]) assert.equal((await env.store.cancel(s, { id: job.id })).ok, true, `cancel ${job.id}`);
    for (const job of [waiting!, delayed!, active]) {
      const rec = await get(env, s, job.id);
      assert.deepEqual([rec.state, rec.cancelReason], ['cancelled', 'user'], `${job.id} is cancelled by the user`);
    }
    const [fresh] = await env.addJobs(s, 1);
    assert.equal(fresh!.cancelReason, null, 'a fresh add has no cancelReason');
    for (const id of [fresh!.id, done.job.id, failed.job.id]) assert.equal((await get(env, s, id)).cancelReason, null, `${id} keeps null`);
  });

  t.test('contract: open and close are idempotent', async (env) => {
    const store = await env.freshStore();
    await store.open();
    await store.open();
    await store.close();
    await store.close();
  });

  t.test('contract: calls before open or after close throw StoreRequestError', async (env) => {
    const store = await env.freshStore();
    const s = env.scope();
    await store.open();
    await store.close();
    await rejectsRequest(store.add(s, [env.job()]), 'add after close');
    await rejectsRequest(store.get(s, 'x'), 'get after close');
    await store.open();
    assert.equal((await store.add(s, [env.job()])).length, 1, 'open again serves calls');
    await store.close();
  });

  t.test('contract: unknown scope returns empty results and no error', async (env) => {
    const s = env.scope();
    assert.equal(await env.store.get(s, 'nope'), null);
    assert.deepEqual(await env.store.list(s, { state: 'waiting', offset: 0, limit: 10, order: 'asc' }), []);
    assert.deepEqual(await counts(env.store, s), ZERO_COUNTS);
    assert.deepEqual((await env.claim(s)).jobs, []);
  });

  t.test('contract: namespaces are isolated', async (env) => {
    const a = env.scope('q');
    const b = env.scope('q', 'other');
    assert.notEqual(a.namespace, b.namespace);
    await isolated(env, a, b);
  });

  t.test('contract: queues are isolated within a namespace', async (env) => {
    await isolated(env, env.scope('q1'), env.scope('q2'));
  });

  t.test('contract: payload round-trips byte-exact for ascii, unicode, empty string and Uint8Array', async (env) => {
    const s = env.scope();
    const payloads = ['abc', 'héllo 日本 🚀', '', Uint8Array.of(0, 255, 1)];
    const added = await env.store.add(s, payloads.map((data) => env.job({ data })));
    for (const [i, o] of added.entries()) {
      assert.equal(o.status, 'added');
      const rec = await get(env, s, (o as { job: JobRecord }).job.id);
      const want = payloads[i]!;
      if (want instanceof Uint8Array) {
        assert.ok(rec.data instanceof Uint8Array, 'Uint8Array stays Uint8Array');
        assert.deepEqual([...rec.data], [...want]);
      } else {
        assert.equal(rec.data, want);
      }
    }
  });

  t.test('contract: returned records are copies', async (env) => {
    const s = env.scope();
    const data = Uint8Array.of(1, 2, 3);
    const backoff = Uint8Array.of(4, 5);
    const [fromAdd] = await env.addJobs(s, 1, { data, backoff });
    data[0] = 9;
    backoff[0] = 9;
    const fromList = await env.store.list(s, { state: 'waiting', offset: 0, limit: 1, order: 'asc' });
    const fromClaim = (await env.claim(s)).jobs;
    const snapshot = await get(env, s, fromAdd!.id);
    assert.deepEqual([...(snapshot.data as Uint8Array)], [1, 2, 3], 'the stored data is a copy of the input');
    assert.deepEqual([...(snapshot.backoff as Uint8Array)], [4, 5], 'the stored backoff is a copy of the input');
    const fromGet = await get(env, s, fromAdd!.id);
    for (const rec of [fromAdd!, fromGet, ...fromList, ...fromClaim]) {
      assert.equal(Object.isFrozen(rec), false, 'returned records are not frozen');
      (rec.data as Uint8Array)[1] = 7;
      rec.priority = 99;
      rec.state = 'failed';
      if (rec.lease) rec.lease.owner = 'someone else';
    }
    assert.deepEqual(await get(env, s, fromAdd!.id), snapshot);
  });

  t.test('contract: add stores the timeout payload and get returns it unchanged', async (env) => {
    const s = env.scope();
    const [withTimeout] = await env.addJobs(s, 1, { timeout: '{"timeoutMs":5}' });
    const [without] = await env.addJobs(s, 1);
    assert.equal((await get(env, s, withTimeout!.id)).timeout, '{"timeoutMs":5}');
    assert.equal((await get(env, s, without!.id)).timeout, null);
  });

  t.test('contract: seq is strictly increasing per scope and first:true goes below all', async (env) => {
    const s = env.scope();
    const jobs = [...(await env.addJobs(s, 1)), ...(await env.addJobs(s, 1)), ...(await env.addJobs(s, 1))];
    const seqs = jobs.map((j) => j.seq);
    assert.ok(seqs[0]! < seqs[1]! && seqs[1]! < seqs[2]!, `seq ascending: ${seqs.join(', ')}`);
    const [first] = await env.addJobs(s, 1, { first: true });
    assert.ok(first!.seq < Math.min(...seqs), 'first: true gets a seq below every other');
  });

  t.test('contract: rev increments by exactly one per mutation and not on reads or rejections', async (env) => {
    const s = env.scope();
    const [job] = await env.addJobs(s, 1);
    assert.equal(job!.rev, 1);
    await env.store.list(s, { state: 'waiting', offset: 0, limit: 10, order: 'asc' });
    await env.store.counts(s);
    assert.equal((await get(env, s, job!.id)).rev, 1, 'reads leave rev');
    const rejected = await env.store.complete(s, { id: job!.id, token: 999, result: null });
    assert.equal(rejected.ok, false);
    assert.equal((await get(env, s, job!.id)).rev, 1, 'a rejected write leaves rev');
    const up = await env.store.update(s, { id: job!.id, expectedRev: 1, patch: { priority: 5 } });
    assert.ok(up.ok);
    assert.equal(up.job.rev, 2);
    assert.equal((await get(env, s, job!.id)).rev, 2);
  });

  t.test('contract: add returns one outcome per input in order', async (env) => {
    const s = env.scope();
    const inputs = Array.from({ length: 20 }, (_, i) => env.job({ name: `n${i}` }));
    const out = await env.store.add(s, inputs);
    assert.equal(out.length, inputs.length);
    for (const [i, o] of out.entries()) {
      assert.equal(o.status, 'added', `outcome ${i} is added`);
      const { job } = o as { job: JobRecord };
      assert.equal(job.id, inputs[i]!.id);
      assert.equal(job.name, `n${i}`);
      assert.deepEqual(await env.store.get(s, job.id), job, `outcome ${i} is what was stored`);
    }
    assert.equal((await env.store.counts(s)).waiting, inputs.length);
  });

  t.test('contract: add delayMs and runAt are resolved on store time', async (env) => {
    const s = env.scope();
    const [delayed] = await env.addJobs(s, 1, { delayMs: 5000 });
    assert.equal(delayed!.runAt - delayed!.createdAt, 5000);
    assert.equal(delayed!.state, 'delayed');
    const abs = (await env.store.now()) + 60_000;
    const [at] = await env.addJobs(s, 1, { runAt: abs });
    assert.equal(at!.runAt, abs);
    assert.equal(at!.state, 'delayed');
  });

  t.test('contract: add with delayMs and runAt together throws StoreRequestError', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 1);
    const before = await counts(env.store, s);
    await rejectsRequest(env.store.add(s, [env.job({ delayMs: 10, runAt: (await env.store.now()) + 10 })]));
    assert.deepEqual(await counts(env.store, s), before);
  });

  t.test(
    'contract: add atomic without transactions throws CapabilityError',
    async (env) => {
      const s = env.scope();
      await rejectsCapability(env.store.add(s, [env.job(), env.job()], { atomic: true }));
      assert.deepEqual(await counts(env.store, s), ZERO_COUNTS);
    },
    { absent: 'transactions' },
  );

  t.test('contract: first true after deleting the lowest job still gets a seq below every seq ever issued', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 2);
    const [low] = await env.addJobs(s, 1, { first: true });
    assert.equal((await env.store.remove(s, { id: low!.id })).removed, true);
    const [next] = await env.addJobs(s, 1, { first: true });
    assert.ok(next!.seq < low!.seq, `seq ${next!.seq} is below the removed ${low!.seq}`);
  });

  t.test('contract: seq and token are never reused after remove, clean or forced obliterate', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 1);
    const id = env.job().id;
    const { job, token } = await claimedById(env, s, id);
    assert.equal((await env.store.cancel(s, { id })).ok, true);
    assert.equal((await env.store.remove(s, { id })).removed, true);
    const [again] = await env.addJobs(s, 1, { id });
    const seqs = (await listAll(env.store, s, 'waiting')).map((j) => j.seq);
    assert.notEqual(again!.seq, job.seq, 'seq is not reused');
    assert.equal(new Set(seqs).size, seqs.length, 'seqs are unique');
    assert.ok(again!.seq > job.seq, 'a new seq is above every earlier one');
    const res = await env.claim(s, { limit: 10 });
    const reclaimed = res.jobs.find((j) => j.id === id);
    assert.ok(reclaimed, 'the re-added id is claimable');
    assert.ok(reclaimed.token > token, `token ${reclaimed.token} is above the removed job's ${token}`);
    let last = reclaimed;
    for (const how of ['clean', 'obliterate'] as const) {
      await deleteJob(env, s, id, how);
      const [readded] = await env.addJobs(s, 1, { id });
      assert.ok(readded!.seq > last.seq, `${how}: a new seq is above the deleted job's`);
      const next = (await env.claim(s, { limit: 10 })).jobs.find((j) => j.id === id);
      assert.ok(next && next.token > last.token, `${how}: a new token is above the deleted job's`);
      last = next;
    }
  });

  t.test('contract: list orderBy runAt, startedAt, finishedAt and seq with stable pages', async (env) => {
    const s = env.scope();
    const delays = [3000, 1000, 2000, 2000, 5000, 4000];
    const jobs = await Promise.all(delays.map(async (delayMs) => (await env.addJobs(s, 1, { delayMs }))[0]!));
    const byRunAt = [...jobs].sort((a, b) => a.runAt - b.runAt || a.seq - b.seq).map((j) => j.id);
    await checkOrder(env, s, 'delayed', 'runAt', byRunAt);
    await env.elapse(6000);
    const started: string[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const res = await env.claim(s);
      started.push(oneJob(res).id);
      await env.elapse(10);
    }
    await checkOrder(env, s, 'active', 'startedAt', started);
    const finished: string[] = [];
    for (const id of [...started].reverse()) {
      const rec = await get(env, s, id);
      assert.equal((await env.store.complete(s, { id, token: rec.token, result: null })).ok, true);
      finished.push(id);
      await env.elapse(10);
    }
    await checkOrder(env, s, 'completed', 'finishedAt', finished);
    await checkOrder(env, s, 'completed', 'seq', [...jobs].sort((a, b) => a.seq - b.seq).map((j) => j.id));
  });

  t.test('contract: list pages by seq asc and desc', async (env) => {
    const s = env.scope();
    const ids = (await env.addJobs(s, 7)).sort((a, b) => a.seq - b.seq).map((j) => j.id);
    for (const order of ['asc', 'desc'] as const) {
      const pages: string[] = [];
      for (const offset of [0, 3, 6]) {
        const page = await env.store.list(s, { state: 'waiting', offset, limit: 3, order });
        assert.equal(page.length, offset === 6 ? 1 : 3);
        pages.push(...page.map((j) => j.id));
      }
      assert.deepEqual(pages, order === 'asc' ? ids : [...ids].reverse());
    }
  });

  t.test('contract: due delayed job is reported as waiting by get, list and counts', async (env) => {
    const s = env.scope();
    const [job] = await env.addJobs(s, 1, { delayMs: 1000 });
    const seen = async (): Promise<string[]> => {
      const c = await env.store.counts(s);
      const listed = (await listAll(env.store, s, 'waiting')).length === 1 ? 'waiting' : (await listAll(env.store, s, 'delayed')).length === 1 ? 'delayed' : 'none';
      return [(await get(env, s, job!.id)).state, c.waiting === 1 ? 'waiting' : c.delayed === 1 ? 'delayed' : 'none', listed];
    };
    assert.deepEqual(await seen(), ['delayed', 'delayed', 'delayed']);
    await env.elapse(env.clock ? 999 : 500);
    assert.deepEqual(await seen(), ['delayed', 'delayed', 'delayed'], 'not due before runAt');
    await env.elapse(env.clock ? 1 : 600);
    assert.deepEqual(await seen(), ['waiting', 'waiting', 'waiting'], 'due at runAt');
    assert.equal((await get(env, s, job!.id)).seq, job!.seq, 'promotion keeps seq');
  });

  t.test('contract: a request field set to undefined counts as absent', async (env) => {
    const s = env.scope();
    // a caller that builds requests with optional fields left undefined must not be refused for them
    const [added] = await env.store.add(s, [{ ...env.job(), later: undefined } as NewJob], { atomic: undefined } as never);
    assert.equal(added!.status, 'added');
    const { jobs } = await env.store.claim(s, { workerId: 'w1', claimId: 'c1', limit: 1, leaseMs: env.leaseMs, later: undefined } as never);
    assert.equal(jobs.length, 1);
    assert.ok((await env.store.complete(s, { id: jobs[0]!.id, token: jobs[0]!.token, result: null, later: undefined } as never)).ok);
    assert.equal((await env.store.list(s, { state: 'completed', offset: 0, limit: 10, order: 'asc', later: undefined } as never)).length, 1);
    await rejectsRequest(env.store.add(s, [{ ...env.job(), later: 1 } as NewJob]), 'a field with a value is still refused');
  });

  t.test('contract: counts equal list totals per state after a mixed workload', async (env) => {
    const s = env.scope();
    const jobs = await env.addJobs(s, 10);
    await env.addJobs(s, 2, { delayMs: 60_000 });
    const res = await env.claim(s, { limit: 3 });
    assert.equal(res.jobs.length, 3);
    const [a, b] = res.jobs;
    assert.equal((await env.store.complete(s, { id: a!.id, token: a!.token, result: 'r' })).ok, true);
    assert.equal((await env.store.fail(s, { id: b!.id, token: b!.token, error: 'e' })).ok, true);
    const waiting = jobs.find((j) => !res.jobs.some((c) => c.id === j.id))!;
    assert.equal((await env.store.cancel(s, { id: waiting.id })).ok, true);
    const c = await counts(env.store, s);
    assert.deepEqual(c, { waiting: 6, delayed: 2, active: 1, completed: 1, failed: 1, cancelled: 1, blocked: 0 });
    for (const state of STATES) assert.equal((await listAll(env.store, s, state)).length, c[state], `${state}: counts equals list`);
  });

  t.test('contract: blocked is a subset of waiting and equals waiting while paused', async (env) => {
    const s = env.scope();
    await env.addJobs(s, 3);
    await env.addJobs(s, 1, { delayMs: 60_000 });
    const before = await env.store.counts(s);
    assert.equal(before.blocked, 0);
    await env.store.setPaused(s, true);
    const paused = await env.store.counts(s);
    assert.equal(paused.blocked, paused.waiting);
    assert.equal(paused.waiting, 3);
    const sum = STATES.reduce((n, st) => n + paused[st], 0);
    assert.equal(sum, 4, 'blocked is not counted on top of the six states');
    await env.store.setPaused(s, false);
  });

  t.test('contract: invalid arguments throw StoreRequestError before any change', async (env) => {
    const s = env.scope();
    const [waiting] = await env.addJobs(s, 1);
    const { job: active, token } = await claimedById(env, s, env.job().id);
    const snap = async () => ({ c: await counts(env.store, s), w: await get(env, s, waiting!.id), a: await get(env, s, active.id) });
    const before = await snap();
    const claim = { workerId: 'w1', claimId: 'c', limit: 1, leaseMs: env.leaseMs };
    const bad: [string, () => Promise<unknown>][] = [
      ['claim limit 0', () => env.store.claim(s, { ...claim, limit: 0 })],
      ['claim limit 1.5', () => env.store.claim(s, { ...claim, limit: 1.5 })],
      ['claim leaseMs 0', () => env.store.claim(s, { ...claim, leaseMs: 0 })],
      ['add maxAttempts 0', () => env.store.add(s, [env.job({ maxAttempts: 0 })])],
      ['list limit 0', () => env.store.list(s, { state: 'waiting', offset: 0, limit: 0, order: 'asc' })],
      ['sweep maxCrashes 0', () => env.store.sweep(s, sweepReq({ maxCrashes: 0 }))],
      [
        'release negative delayMs',
        () => env.store.release(s, { id: active.id, token, delayMs: -1, refundAttempt: false, handlerStarted: true }),
      ],
    ];
    for (const [what, call] of bad) await rejectsRequest(call(), what);
    assert.deepEqual(await snap(), before);
  });

  t.test(
    'contract: subscribe delivers a wake on add and unsubscribe stops it',
    async (env) => {
      const s = env.scope();
      let wakes = 0;
      const unsubscribe = await env.store.subscribe!(s, () => void wakes++);
      await env.addJobs(s, 1);
      assert.ok(await eventually(() => wakes >= 1, 2000 * env.timeScale), 'a wake arrives after add');
      await unsubscribe();
      const seen = wakes;
      await env.addJobs(s, 1);
      await eventually(() => false, 100 * env.timeScale);
      assert.equal(wakes, seen, 'no wake after unsubscribe');
    },
    { requires: 'notify' },
  );

  t.test('contract: acknowledged writes survive reopen', acknowledgedWritesSurviveReopen, { requires: 'durable' });
}

/** Add a job with this id and a name of its own, and claim exactly it. */
async function claimedById(env: TestEnv, s: ReturnType<TestEnv['scope']>, id: string) {
  await env.store.add(s, [env.job({ id, name: `only-${id}` })]);
  const res = await env.claim(s, { names: [`only-${id}`] });
  const job = res.jobs[0];
  assert.equal(job?.id, id);
  return { job: job!, token: job!.token };
}

async function isolated(env: TestEnv, a: ReturnType<TestEnv['scope']>, b: ReturnType<TestEnv['scope']>): Promise<void> {
  const shared: NewJob = env.job();
  await env.store.add(a, [shared, env.job()]);
  await env.store.add(b, [{ ...shared, data: 'b' }]);
  const onlyA = (await env.addJobs(a, 1))[0]!;
  assert.equal((await env.store.counts(a)).waiting, 3);
  assert.equal((await env.store.counts(b)).waiting, 1);
  assert.equal((await get(env, b, shared.id)).data, 'b');
  assert.equal((await get(env, a, shared.id)).data, '{}');
  assert.equal(await env.store.get(b, onlyA.id), null);
  await env.store.setPaused(a, true);
  assert.equal(await env.store.isPaused(b), false);
  assert.equal((await env.claim(b)).jobs.length, 1, 'b claims while a is paused');
  await env.store.setPaused(a, false);
}

async function checkOrder(env: TestEnv, s: ReturnType<TestEnv['scope']>, state: JobState, orderBy: 'runAt' | 'startedAt' | 'finishedAt' | 'seq', asc: string[]) {
  for (const order of ['asc', 'desc'] as const) {
    const want = order === 'asc' ? asc : [...asc].reverse();
    const full = (await env.store.list(s, { state, offset: 0, limit: 100, orderBy, order })).map((j) => j.id);
    assert.deepEqual(full, want, `${state} by ${orderBy} ${order}`);
    const pages: string[] = [];
    for (let offset = 0; offset < asc.length; offset += 2) {
      pages.push(...(await env.store.list(s, { state, offset, limit: 2, orderBy, order })).map((j) => j.id));
    }
    assert.deepEqual(pages, want, `${state} by ${orderBy} ${order} in pages of 2`);
  }
}
