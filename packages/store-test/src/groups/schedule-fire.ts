import assert from 'node:assert/strict';
import type { FireScheduleRequest, FireScheduleResult, NewSchedule, ScheduleRecord, Scope, Store } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { GroupApi } from './types.js';
import { claimed, fireJob, get, rejectsRequest, scheduleInput, STATES, ZERO_COUNTS } from './util.js';

/** Put a new schedule `k` and return the stored record. */
async function put(env: TestEnv, s: Scope, over: Partial<NewSchedule> = {}, key = 'k'): Promise<ScheduleRecord> {
  const res = await env.store.putSchedule(s, { schedule: scheduleInput(key, over), expectedRev: null });
  assert.ok(res.ok, `schedule ${key} is created`);
  return res.schedule;
}

/** A tick fire of `rec` at its stored `nextRunAt`, moving it to `nextRunAt`. */
const tick = (rec: ScheduleRecord, nextRunAt: number, over: Partial<FireScheduleRequest> = {}): FireScheduleRequest => ({
  key: rec.key, expectedRev: rec.rev, mode: 'tick', nextRunAt, job: fireJob(rec.key, rec.nextRunAt), ...over,
});

/** A backlog fire of `rec`'s oldest queued tick. */
const backlog = (rec: ScheduleRecord): FireScheduleRequest => ({
  key: rec.key, expectedRev: rec.rev, mode: 'backlog', job: fireJob(rec.key, rec.queuedTicks[0]!),
});

async function jobCount(store: Store, s: Scope): Promise<number> {
  const counts = await store.counts(s);
  return STATES.reduce((n, st) => n + counts[st], 0);
}

function outcome<K extends FireScheduleResult['outcome']>(res: FireScheduleResult, want: K): Extract<FireScheduleResult, { outcome: K }> {
  assert.equal(res.outcome, want);
  return res as Extract<FireScheduleResult, { outcome: K }>;
}

const schedule = async (env: TestEnv, s: Scope, key = 'k'): Promise<ScheduleRecord> => {
  const rec = await env.store.getSchedule(s, { key });
  assert.ok(rec, `schedule ${key} exists`);
  return rec;
};

export function registerScheduleFire(t: GroupApi): void {
  t.test('schedule-fire: fire advances nextRunAt, bumps rev, and inserts the job atomically', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now });
    const res = outcome(await env.store.fireSchedule(s, tick(rec, now + 60_000)), 'fired');
    assert.equal(res.jobId, `sched:k:${now}`);
    const want = { ...rec, rev: rec.rev + 1, nextRunAt: now + 60_000, lastFiredFor: now, lastJobId: res.jobId, runCount: 1, updatedAt: now };
    assert.deepEqual(res.schedule, want);
    assert.deepEqual(await schedule(env, s), want);
    const job = await get(env, s, res.jobId);
    assert.deepEqual([job.state, job.scheduleKey, job.scheduledFor, job.runAt], ['waiting', 'k', now, now]);
  }, { fakeClock: true });

  t.test('schedule-fire: stale expectedRev returns conflict and changes nothing', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now - 1000 });
    assert.deepEqual(await env.store.fireSchedule(s, tick(rec, now + 60_000, { expectedRev: rec.rev + 1 })), { outcome: 'conflict' });
    assert.deepEqual(await schedule(env, s), rec);
    assert.deepEqual(await env.store.counts(s), ZERO_COUNTS);
  });

  t.test('schedule-fire: fire before store time reaches nextRunAt returns early', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now + 1000 });
    assert.deepEqual(await env.store.fireSchedule(s, tick(rec, now + 2000)), { outcome: 'early' });
    assert.deepEqual(await schedule(env, s), rec);
    assert.equal(await jobCount(env.store, s), 0);
    await env.elapse(1000);
    outcome(await env.store.fireSchedule(s, tick(rec, now + 2000)), 'fired');
  }, { fakeClock: true });

  t.test('schedule-fire: paused and deleted schedules return paused and gone', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now - 1000, paused: true });
    assert.deepEqual(await env.store.fireSchedule(s, tick(rec, now + 60_000)), { outcome: 'paused' });
    assert.deepEqual(await schedule(env, s), rec);
    await env.store.deleteSchedule(s, { key: 'k' });
    assert.deepEqual(await env.store.fireSchedule(s, tick(rec, now + 60_000)), { outcome: 'gone' });
    assert.equal(await jobCount(env.store, s), 0);
  });

  t.race('schedule-fire: concurrent fires on one tick, exactly one fired', async (env) => {
    const pods = await env.pods(env.concurrency);
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now - 1000 });
    const outs = await Promise.all(pods.map((p) => p.fireSchedule(s, tick(rec, now + 60_000))));
    assert.equal(outs.filter((o) => o.outcome === 'fired').length, 1, 'exactly one fire wins');
    for (const o of outs) if (o.outcome !== 'fired') assert.equal(o.outcome, 'conflict');
    assert.equal(await jobCount(env.store, s), 1);
    assert.equal((await schedule(env, s)).runCount, 1);
  });

  t.test('schedule-fire: failed job insert leaves the schedule unchanged', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now - 1000 });
    const req = tick(rec, now + 60_000);
    await rejectsRequest(env.store.fireSchedule(s, { ...req, job: { ...req.job, maxAttempts: 0 } }), 'maxAttempts 0');
    await rejectsRequest(env.store.fireSchedule(s, { ...req, job: fireJob('k', now) }), 'a job id for another tick');
    await rejectsRequest(env.store.fireSchedule(s, { ...req, job: fireJob('other', rec.nextRunAt) }), 'a job id for another key');
    await rejectsRequest(env.store.fireSchedule(s, { ...req, mode: 'backlog' }), 'nextRunAt in backlog mode');
    await rejectsRequest(env.store.fireSchedule(s, backlog(rec)), 'backlog mode with no queued tick');
    assert.deepEqual(await schedule(env, s), rec);
    assert.equal(await jobCount(env.store, s), 0);
  });

  t.test('schedule-fire: listDue uses store time and returns nextDueAt', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    await put(env, s, { nextRunAt: now + 2000 }, 'a');
    await put(env, s, { nextRunAt: now + 1000 }, 'b');
    await put(env, s, { nextRunAt: now, paused: true }, 'c');
    const first = await env.store.listDueSchedules(s, { limit: 10 });
    assert.deepEqual([first.due, first.nextDueAt, first.now], [[], now + 1000, now]);
    await env.elapse(2000);
    const later = await env.store.listDueSchedules(s, { limit: 10 });
    assert.deepEqual(later.due.map((r) => r.key), ['b', 'a']);
    assert.deepEqual(later.due[0], await schedule(env, s, 'b'));
    assert.deepEqual((await env.store.listDueSchedules(s, { limit: 1 })).due.map((r) => r.key), ['b']);
    const q = env.scope();
    await put(env, q, { nextRunAt: now + 600_000, queuedTicks: [5] }, 'd');
    assert.deepEqual((await env.store.listDueSchedules(q, { limit: 10 })).due.map((r) => r.key), ['d'], 'a queued tick is due');
    assert.deepEqual(await env.store.listDueSchedules(env.scope(), { limit: 10 }), { now: now + 2000, due: [], nextDueAt: null });
    await rejectsRequest(env.store.listDueSchedules(s, { limit: 0 }), 'limit 0');
    await rejectsRequest(env.store.listDueSchedules(s, { limit: 1001 }), 'limit 1001');
  }, { fakeClock: true });

  t.test('schedule-fire: expiry judged by store time with pod clock skewed ±1h', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now + 1000 });
    await env.skewPodClock(3_600_000, async () => {
      assert.deepEqual(await env.store.fireSchedule(s, tick(rec, now + 2000)), { outcome: 'early' });
      assert.deepEqual((await env.store.listDueSchedules(s, { limit: 10 })).due, []);
    });
    await env.skewPodClock(-3_600_000, async () => {
      await env.elapse(1000);
      assert.equal((await env.store.listDueSchedules(s, { limit: 10 })).due.length, 1);
      outcome(await env.store.fireSchedule(s, tick(rec, now + 2000)), 'fired');
    });
  }, { fakeClock: true });

  t.test('schedule-fire: skip policy inserts nothing and advances nextRunAt atomically', async (env) => {
    const routes = {
      waiting: async (s: Scope) => (await env.addJobs(s, 1))[0]!,
      delayed: async (s: Scope) => {
        const { job, token } = await claimed(env, s);
        await env.store.fail(s, { id: job.id, token, error: 'e', retryInMs: 600_000 });
        return job;
      },
      active: async (s: Scope) => (await claimed(env, s)).job,
    };
    for (const [state, make] of Object.entries(routes)) {
      const s = env.scope();
      const prev = await make(s);
      assert.equal((await get(env, s, prev.id)).state, state);
      const now = await env.store.now();
      const rec = await put(env, s, { nextRunAt: now - 2000, lastJobId: prev.id, runCount: 4 });
      const res = outcome(await env.store.fireSchedule(s, tick(rec, now - 1000)), 'skipped');
      assert.equal(res.reason, 'overlap', state);
      assert.deepEqual(res.schedule, { ...rec, nextRunAt: now - 1000, rev: rec.rev + 1, updatedAt: res.schedule.updatedAt }, state);
      assert.deepEqual(await schedule(env, s), res.schedule);
      assert.equal(await jobCount(env.store, s), 1, `${state}: no new job`);
      if (state === 'active') {
        await env.store.complete(s, { id: prev.id, token: (await get(env, s, prev.id)).token, result: null });
        outcome(await env.store.fireSchedule(s, tick(res.schedule, now)), 'fired');
      }
    }
  });

  t.test('schedule-fire: queue policy appends to queuedTicks atomically', async (env) => {
    const s = env.scope();
    const { job } = await claimed(env, s);
    const now = await env.store.now();
    let rec = await put(env, s, { nextRunAt: now - 3000, overlap: 'queue', maxQueued: 2, lastJobId: job.id });
    for (const [i, at] of [now - 3000, now - 2000].entries()) {
      rec = outcome(await env.store.fireSchedule(s, tick(rec, at + 1000)), 'queued').schedule;
      assert.deepEqual([rec.nextRunAt, rec.queuedTicks.at(-1), rec.queuedTicks.length], [at + 1000, at, i + 1]);
    }
    assert.deepEqual(rec.queuedTicks, [now - 3000, now - 2000]);
    const full = outcome(await env.store.fireSchedule(s, tick(rec, now)), 'skipped');
    assert.equal(full.reason, 'backlog-full');
    assert.deepEqual([full.schedule.queuedTicks, full.schedule.nextRunAt, full.schedule.rev], [rec.queuedTicks, now, rec.rev + 1]);
    assert.equal(await jobCount(env.store, s), 1);
  });

  t.test('schedule-fire: backlog mode fires the oldest queued tick or returns busy while the previous run is unfinished', async (env) => {
    const s = env.scope();
    const { job, token } = await claimed(env, s);
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now + 600_000, overlap: 'queue', lastJobId: job.id, queuedTicks: [now - 2000, now - 1000] });
    assert.deepEqual(await env.store.fireSchedule(s, backlog(rec)), { outcome: 'busy' });
    assert.deepEqual(await schedule(env, s), rec);
    await env.store.complete(s, { id: job.id, token, result: null });
    const res = outcome(await env.store.fireSchedule(s, backlog(rec)), 'fired');
    assert.equal(res.jobId, `sched:k:${now - 2000}`);
    assert.deepEqual([res.schedule.queuedTicks, res.schedule.nextRunAt, res.schedule.lastFiredFor], [[now - 1000], now + 600_000, now - 2000]);
    assert.deepEqual((await get(env, s, res.jobId)).scheduledFor, now - 2000);
    assert.deepEqual(await env.store.fireSchedule(s, backlog(res.schedule)), { outcome: 'busy' }, 'the new job is waiting');
  });

  t.test('schedule-fire: an existing fired job id still advances the schedule and reports fired', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now - 1000 });
    await env.store.add(s, [fireJob('k', now - 1000)]);
    const res = outcome(await env.store.fireSchedule(s, tick(rec, now + 60_000)), 'fired');
    assert.equal(res.jobId, `sched:k:${now - 1000}`);
    assert.deepEqual([res.schedule.nextRunAt, res.schedule.runCount, res.schedule.lastJobId], [now + 60_000, 1, res.jobId]);
    assert.equal(await jobCount(env.store, s), 1);
  });

  t.test('schedule-fire: a fired job with a singletonKey is refused and changes nothing', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const rec = await put(env, s, { nextRunAt: now });
    await rejectsRequest(env.store.fireSchedule(s, tick(rec, now + 60_000, { job: { ...fireJob(rec.key, now), singletonKey: 'one' } })));
    assert.deepEqual(await schedule(env, s), rec);
    assert.deepEqual(await env.store.counts(s), ZERO_COUNTS);
    outcome(await env.store.fireSchedule(s, tick(rec, now + 60_000, { job: { ...fireJob(rec.key, now), singletonKey: null } })), 'fired');
  }, { fakeClock: true });
}
