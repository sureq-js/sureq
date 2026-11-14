import assert from 'node:assert/strict';
import type { AddOutcome, JobRecord, NewJob, Scope } from '@sureq/core';
import { newId, type TestEnv } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { claimed, get, listAll, oneJob, rejectsRequest, STATES, sweepReq, together } from './util.js';

/** Add one job and return its outcome. */
export async function addOne(env: TestEnv, s: Scope, over: Partial<NewJob> = {}, opts?: { atomic?: boolean }): Promise<AddOutcome> {
  const [out] = await env.store.add(s, [env.job(over)], opts);
  assert.ok(out, 'one outcome per input');
  return out;
}

/** The record of an `added` outcome. */
export function addedJob(out: AddOutcome | undefined): JobRecord {
  assert.equal(out?.status, 'added', 'the job is added');
  return (out as { job: JobRecord }).job;
}

/** The fields of a `duplicate` outcome, with the job's id. */
export function dup(out: AddOutcome | undefined): { action: string; by: string; existingState: string; id: string } {
  assert.equal(out?.status, 'duplicate', 'the add is a duplicate');
  const d = out as Extract<AddOutcome, { status: 'duplicate' }>;
  return { action: d.action, by: d.by, existingState: d.existingState, id: d.job.id };
}

/** `counts` per state equals the `list` totals per state. */
export async function countsMatchList(env: TestEnv, s: Scope): Promise<Record<string, number>> {
  const counts = await env.store.counts(s);
  for (const state of STATES) assert.equal((await listAll(env.store, s, state)).length, counts[state], `counts.${state} equals the list total`);
  return { ...counts };
}

/** Claim the job `id` and finish it by `route`. */
async function finish(env: TestEnv, s: Scope, id: string, route: 'completed' | 'failed' | 'cancelled'): Promise<void> {
  if (route === 'cancelled') {
    assert.equal((await env.store.cancel(s, { id })).ok, true);
    return;
  }
  const { jobs } = await env.claim(s);
  assert.equal(jobs[0]?.id, id);
  const token = jobs[0]!.token;
  if (route === 'completed') assert.equal((await env.store.complete(s, { id, token, result: null })).ok, true);
  else assert.equal((await env.store.fail(s, { id, token, error: 'e' })).ok, true);
}

export const dedupGroup: ConformanceGroup = {
  name: 'dedup',
  mode: 'fake',
  register(t) {
    t.test('dedup: add with new id returns added true', async (env) => {
      const s = env.scope();
      const id = newId();
      assert.equal(addedJob(await addOne(env, s, { id })).id, id);
    });

    t.test('dedup: ignore returns existing job and added false', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { data: '"first"' }));
      const out = await addOne(env, s, { id: first.id, data: '"second"' });
      assert.deepEqual(dup(out), { action: 'ignored', by: 'id', existingState: 'waiting', id: first.id });
      const job = (out as { job: JobRecord }).job;
      assert.equal(job.rev, first.rev);
      assert.equal(job.data, '"first"');
      assert.equal((await get(env, s, first.id)).data, '"first"');
    });

    t.test('dedup: replace overwrites data of waiting job and keeps id, createdAt, attempt', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { data: '"first"' }));
      await env.elapse(10);
      const out = await addOne(env, s, { id: first.id, data: '"second"', onDuplicate: 'replace' });
      assert.equal(dup(out).action, 'replaced');
      const job = (out as { job: JobRecord }).job;
      assert.equal(job.data, '"second"');
      assert.deepEqual([job.id, job.createdAt, job.seq, job.attempt], [first.id, first.createdAt, first.seq, first.attempt]);
      assert.equal(job.rev, first.rev + 1);
      assert.deepEqual(await get(env, s, first.id), job);
    });

    t.test('dedup: finished pending id is reused with a fresh seq and a stale token of the old record is rejected', async (env) => {
      const s = env.scope();
      const { job: old, token } = await claimed(env, s);
      assert.equal((await env.store.complete(s, { id: old.id, token, result: null })).ok, true);
      const next = addedJob(await addOne(env, s, { id: old.id }));
      assert.ok(next.seq > old.seq, 'the new job has a fresh seq');
      assert.equal(next.attempt, 0);
      // A repeat of the old job's exact write answers from its tombstone (see contract-writes); any other write with
      // its token is refused and never touches the new job.
      const res = await env.store.fail(s, { id: old.id, token, error: 'late' });
      assert.equal(res.ok, false, 'a stale token of the old record is refused');
      assert.ok(!res.ok && (res.reason === 'superseded' || res.reason === 'not-active'));
      assert.equal((await get(env, s, old.id)).state, 'waiting');
    });

    t.test("dedup: a reused id's old record is kept out of get, list and counts", async (env) => {
      const s = env.scope();
      const { job: old, token } = await claimed(env, s);
      await env.store.complete(s, { id: old.id, token, result: null });
      const next = addedJob(await addOne(env, s, { id: old.id }));
      assert.equal((await get(env, s, old.id)).seq, next.seq);
      assert.equal(await env.store.get(s, `${old.id}#${old.seq}`), null);
      assert.deepEqual(await listAll(env.store, s, 'completed'), []);
      const counts = await countsMatchList(env, s);
      assert.equal(counts['completed'], 0);
      assert.equal(counts['waiting'], 1);
      const claim = await env.claim(s, { limit: 10 });
      assert.deepEqual(claim.jobs.map((j) => j.seq), [next.seq], 'claim returns only the live job');
      await env.elapse(env.leaseMs + 1);
      const swept = await env.store.sweep(s, sweepReq());
      assert.deepEqual(swept.swept.map((j) => j.id), [old.id]);
      assert.equal((await get(env, s, old.id)).seq, next.seq, 'sweep touched the live job only');
    });

    t.test('dedup: replace on active job behaves as ignore', async (env) => {
      const s = env.scope();
      const { job } = await claimed(env, s, { data: '"first"' });
      const out = await addOne(env, s, { id: job.id, data: '"second"', onDuplicate: 'replace' });
      assert.deepEqual(dup(out), { action: 'ignored', by: 'id', existingState: 'active', id: job.id });
      const now = await get(env, s, job.id);
      assert.equal(now.data, '"first"');
      assert.equal(now.rev, job.rev);
    });

    t.test('dedup: reject throws DuplicateJobError with existing state', async (env) => {
      const s = env.scope();
      const first = addedJob(await addOne(env, s, { delayMs: 60_000 }));
      const out = await addOne(env, s, { id: first.id, data: '"x"', onDuplicate: 'reject' });
      assert.deepEqual(dup(out), { action: 'rejected', by: 'id', existingState: 'delayed', id: first.id });
      assert.deepEqual(await get(env, s, first.id), first);
    });

    t.test('dedup: pending id is free again after completed, failed and cancelled', async (env) => {
      for (const route of ['completed', 'failed', 'cancelled'] as const) {
        const s = env.scope();
        const first = addedJob(await addOne(env, s, { maxAttempts: 1 }));
        await finish(env, s, first.id, route);
        const next = addedJob(await addOne(env, s, { id: first.id }));
        assert.ok(next.seq > first.seq, `${route}: the id is free again`);
        assert.equal(next.state, 'waiting');
      }
    });

    t.test('dedup: retained id stays taken after completed until removed', async (env) => {
      const s = env.scope();
      const { job, token } = await claimed(env, s, { uniqueWhile: 'retained' });
      await env.store.complete(s, { id: job.id, token, result: null });
      assert.deepEqual(dup(await addOne(env, s, { id: job.id })), { action: 'ignored', by: 'id', existingState: 'completed', id: job.id });
      assert.deepEqual(dup(await addOne(env, s, { id: job.id, uniqueWhile: 'pending' })).existingState, 'completed', 'the stored setting decides');
      assert.equal((await env.store.remove(s, { id: job.id })).removed, true);
      assert.equal(addedJob(await addOne(env, s, { id: job.id })).id, job.id);
    });

    t.race('dedup: concurrent adds of the same id create exactly one job', async (env) => {
      const pods = await env.pods(env.concurrency);
      const s = env.scope();
      const id = newId();
      const outs = (await Promise.all(pods.map((p) => p.add(s, [env.job({ id })])))).map((o) => o[0]!);
      assert.equal(outs.filter((o) => o.status === 'added').length, 1, 'exactly one add wins');
      for (const o of outs) if (o.status !== 'added') assert.equal(dup(o).action, 'ignored');
      const counts = await env.store.counts(s);
      assert.equal(STATES.reduce((n, st) => n + counts[st], 0), 1);
    });

    t.race('dedup: replace racing a claim never half-applies', async (env, i) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { data: '"old"', priority: 1 });
      const replace = () => env.store.add(s, [env.job({ id: job!.id, data: '"new"', priority: 7, onDuplicate: 'replace' })]);
      const [res, [out]] = await together(i % 2 === 1, () => env.claim(s), replace);
      const got = oneJob(res);
      // Either the replace landed first and the claim took the new job, or the job was active and the replace was ignored.
      const want = out!.status === 'duplicate' && out!.action === 'replaced' ? ['"new"', 7] : ['"old"', 1];
      assert.deepEqual([got.data, got.priority], want, 'the claimed job is wholly old or wholly new');
      const rec = await get(env, s, job!.id);
      assert.deepEqual([rec.state, rec.data, rec.priority], ['active', ...want], 'the stored job matches the claimed one');
    });

    t.test('dedup: in-call duplicates apply in order', async (env) => {
      const s = env.scope();
      const [a, b] = [newId(), newId()];
      const out = await env.store.add(s, [env.job({ id: a }), env.job({ id: a }), env.job({ id: b })]);
      assert.deepEqual(out.map((o) => o.status), ['added', 'duplicate', 'added']);
      assert.equal(dup(out[1]).action, 'ignored');
      const s2 = env.scope();
      const out2 = await env.store.add(s2, [env.job({ id: a }), env.job({ id: a, onDuplicate: 'reject' }), env.job({ id: b })]);
      assert.deepEqual(out2.map((o) => o.status), ['added', 'duplicate', 'added']);
      assert.equal(dup(out2[1]).action, 'rejected');
    });

    t.test('dedup: add refuses an id that ends in # and digits', async (env) => {
      const s = env.scope();
      // `id#<seq>` is where a superseded record goes, so a new job cannot take such an id
      for (const id of ['a#1', 'a#-3', '#12']) await rejectsRequest(env.store.add(s, [env.job({ id })]), id);
      await rejectsRequest(env.store.add(s, [env.job(), env.job({ id: 'b#7' })]), 'one bad id refuses the whole call');
      for (const state of STATES) assert.equal((await env.store.counts(s))[state], 0, `nothing was written (${state})`);
      const ok = await env.store.add(s, [env.job({ id: 'a#b' }), env.job({ id: 'a#1x' }), env.job({ id: 'a1#' })]);
      assert.deepEqual(ok.map((o) => o.status), ['added', 'added', 'added']);
    });
  },
};
