import assert from 'node:assert/strict';
import { newId } from '../harness.js';
import type { ConformanceGroup } from './types.js';
import { get, oneJob, together } from './util.js';

type Ids = { ids: number[] };
/** The part of a core queue the merge test drives. */
interface CoreQueue {
  add(data: Ids, opts: { id: string; onDuplicate: (e: { data: Ids }, i: Ids) => Ids }): Promise<unknown>;
  getJob(id: string): Promise<{ data: Ids } | null>;
  getCounts(): Promise<Record<string, number>>;
  remove(id: string): Promise<boolean>;
  close(): Promise<void>;
}
const WRITERS = 50;

export const mergeGroup: ConformanceGroup = {
  name: 'merge',
  mode: 'fake',
  register(t) {
    t.test('merge: conditional write fails when rev changed', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { data: '"a"' });
      assert.equal((await env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { priority: 3 } })).ok, true);
      const res = await env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { data: '"b"' } });
      assert.deepEqual(res, { ok: false, reason: 'conflict' });
      assert.equal((await get(env, s, job!.id)).data, '"a"');
    });

    t.test('merge: conditional write fails when job became active', async (env) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { data: '"a"' });
      oneJob(await env.claim(s));
      // a stale rev too: not-editable is checked before conflict
      const res = await env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { data: '"b"' } });
      assert.deepEqual(res, { ok: false, reason: 'not-editable' });
      assert.equal((await get(env, s, job!.id)).data, '"a"');
    });

    t.race('merge: merge racing a claim never half-applies', async (env, i) => {
      const s = env.scope();
      const [job] = await env.addJobs(s, 1, { data: '"old"' });
      const write = () => env.store.update(s, { id: job!.id, expectedRev: job!.rev, patch: { data: '"new"' } });
      const [res, upd] = await together(i % 2 === 1, () => env.claim(s), write);
      const claimedJob = oneJob(res);
      if (upd.ok) assert.equal(claimedJob.data, '"new"', 'the claim sees the merged data');
      else {
        assert.equal(upd.reason, 'not-editable');
        assert.equal(claimedJob.data, '"old"');
      }
    });

    t.race(
      'merge: 50 concurrent merges into one waiting job keep every payload',
      async (env) => {
        // a scope of this test, so the harness cleans up whatever a failed run leaves behind
        const s = env.scope();
        const queues = (await env.pods(WRITERS)).map((p) => env.core!(p, s) as CoreQueue);
        try {
          const id = newId();
          await queues[0]!.add({ ids: [] }, { id, onDuplicate: (e) => e.data });
          const union = (e: { data: Ids }, i: Ids): Ids => ({ ids: [...e.data.ids, ...i.ids] });
          const settled = await Promise.allSettled(queues.map((q, n) => q.add({ ids: [n] }, { id, onDuplicate: union })));
          const ids = (await queues[0]!.getJob(id))?.data.ids ?? [];
          assert.ok(ids.length > 1, 'more than one merge landed');
          for (const [n, s] of settled.entries()) {
            if (s.status === 'fulfilled') assert.equal(ids.filter((x) => x === n).length, 1, `resolved add ${n} is merged exactly once`);
            else {
              assert.equal((s.reason as { code?: unknown }).code, 'MERGE_CONFLICT', 'a merge that gives up says so');
              assert.ok(!ids.includes(n), `rejected add ${n} left nothing behind`);
            }
          }
          const counts = await queues[0]!.getCounts();
          assert.equal(counts['waiting']! + counts['delayed']!, 1, 'exactly one job');
          await queues[0]!.remove(id);
        } finally {
          await Promise.all(queues.map((q) => q.close()));
        }
      },
      { core: true },
    );
  },
};
