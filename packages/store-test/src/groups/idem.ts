import assert from 'node:assert/strict';
import { addOne, addedJob } from './dedup.js';
import type { ConformanceGroup } from './types.js';
import { deleteJob, get, listAll, oneJob } from './util.js';

export const idemGroup: ConformanceGroup = {
  name: 'idem',
  mode: 'fake',
  register(t) {
    t.test('idem: store round-trips idempotencyKey and exposes seq', async (env) => {
      const s = env.scope();
      const keyed = addedJob(await addOne(env, s, { idempotencyKey: 'charge:o1' }));
      const plain = addedJob(await addOne(env, s));
      assert.equal(keyed.idempotencyKey, 'charge:o1');
      assert.equal((await get(env, s, keyed.id)).idempotencyKey, 'charge:o1');
      assert.deepEqual((await listAll(env.store, s, 'waiting')).map((j) => j.idempotencyKey), ['charge:o1', null]);
      assert.equal(oneJob(await env.claim(s)).idempotencyKey, 'charge:o1');
      assert.equal((await get(env, s, plain.id)).idempotencyKey, null);
      assert.ok(Number.isInteger(keyed.seq) && Number.isInteger(plain.seq));
    });

    t.test('idem: seq is never reused after remove, clean or first true, so the default key stays unique', async (env) => {
      const s = env.scope();
      const seqs: number[] = [];
      const add = async (over = {}) => {
        const job = addedJob(await addOne(env, s, over));
        seqs.push(job.seq);
        return job;
      };
      const a = await add();
      const b = await add();
      await env.store.remove(s, { id: b.id });
      const c = await add();
      assert.ok(c.seq > b.seq, 'a removed job does not give back its seq');
      await env.store.remove(s, { id: a.id });
      const f = await add({ first: true });
      assert.ok(seqs.slice(0, -1).every((n) => f.seq < n), 'a first job takes a seq below every seq issued');
      const g = await add({ first: true });
      assert.ok(g.seq < f.seq);
      const { jobs } = await env.claim(s, { limit: 10 });
      for (const j of jobs) await env.store.complete(s, { id: j.id, token: j.token, result: null });
      const again = await add({ id: c.id });
      assert.ok(again.seq > c.seq, 'a reused pending id gets a new seq');
      await deleteJob(env, s, again.id, 'clean');
      const cleaned = await add({ id: again.id });
      assert.ok(cleaned.seq > again.seq, 'a cleaned job does not give back its seq');
      assert.equal(new Set(seqs).size, seqs.length, 'every seq is distinct');
    });
  },
};
