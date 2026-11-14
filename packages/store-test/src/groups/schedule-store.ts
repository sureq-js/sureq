import assert from 'node:assert/strict';
import type { ScheduleRecord, Scope } from '@sureq/core';
import type { TestEnv } from '../harness.js';
import type { GroupApi } from './types.js';
import { rejectsRequest, scheduleInput } from './util.js';

/** Put a new schedule and return the stored record. */
async function created(env: TestEnv, s: Scope, key: string): Promise<ScheduleRecord> {
  const res = await env.store.putSchedule(s, { schedule: scheduleInput(key), expectedRev: null });
  assert.ok(res.ok, `schedule ${key} is created`);
  return res.schedule;
}

/** Every key of a scope's schedules, `limit` per page. */
async function pages(env: TestEnv, s: Scope, limit: number): Promise<string[][]> {
  const out: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await env.store.listSchedules(s, { limit, ...(cursor !== undefined && { cursor }) });
    out.push(page.schedules.map((r) => r.key));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

export function registerScheduleStore(t: GroupApi): void {
  t.test('schedule-store: put with expectedRev null creates and a second put with null fails exists', async (env) => {
    const s = env.scope();
    const now = await env.store.now();
    const first = await created(env, s, 'k');
    assert.deepEqual(first, { ...scheduleInput('k'), namespace: s.namespace, queue: s.queue, rev: 1, createdAt: now, updatedAt: now });
    const again = await env.store.putSchedule(s, { schedule: scheduleInput('k', { paused: true }), expectedRev: null });
    assert.deepEqual(again, { ok: false, reason: 'exists' });
    assert.deepEqual(await env.store.getSchedule(s, { key: 'k' }), first);
  }, { fakeClock: true });

  t.test('schedule-store: put with stale rev fails conflict and changes nothing', async (env) => {
    const s = env.scope();
    const first = await created(env, s, 'k');
    await env.elapse(10);
    const now = await env.store.now();
    const second = await env.store.putSchedule(s, { schedule: scheduleInput('k', { paused: true }), expectedRev: 1 });
    assert.ok(second.ok, 'the matching rev applies');
    assert.deepEqual([second.schedule.rev, second.schedule.paused, second.schedule.createdAt, second.schedule.updatedAt], [2, true, first.createdAt, now]);
    const stale = await env.store.putSchedule(s, { schedule: scheduleInput('k', { runCount: 9 }), expectedRev: 1 });
    assert.deepEqual(stale, { ok: false, reason: 'conflict' });
    assert.deepEqual(await env.store.getSchedule(s, { key: 'k' }), second.schedule);
    assert.deepEqual(await env.store.putSchedule(s, { schedule: scheduleInput('missing'), expectedRev: 7 }), { ok: false, reason: 'conflict' });
    assert.equal(await env.store.getSchedule(s, { key: 'missing' }), null);
  }, { fakeClock: true });

  t.test('schedule-store: list returns schedules in key order with cursor', async (env) => {
    const s = env.scope();
    const other = env.scope();
    for (const key of ['c', 'a', 'e', 'b', 'd']) await created(env, s, key);
    await created(env, other, 'aa');
    assert.deepEqual(await pages(env, s, 2), [['a', 'b'], ['c', 'd'], ['e']]);
    const first = await env.store.listSchedules(s, { limit: 2 });
    assert.equal(first.nextCursor !== null, true, 'a full page has a cursor');
    await created(env, s, 'aa');
    const rest = await env.store.listSchedules(s, { cursor: first.nextCursor!, limit: 10 });
    assert.deepEqual(rest.schedules.map((r) => r.key), ['c', 'd', 'e'], 'a key before the cursor is not on later pages');
    assert.equal(rest.nextCursor, null);
    for (const r of rest.schedules) assert.deepEqual([r.namespace, r.queue], [s.namespace, s.queue]);
  });

  t.test('schedule-store: delete honours expectedRev and reports a missing key', async (env) => {
    const s = env.scope();
    const rec = await created(env, s, 'k');
    assert.deepEqual(await env.store.deleteSchedule(s, { key: 'k', expectedRev: 2 }), { deleted: false, reason: 'conflict' });
    assert.deepEqual(await env.store.getSchedule(s, { key: 'k' }), rec);
    assert.deepEqual(await env.store.deleteSchedule(s, { key: 'k', expectedRev: 1 }), { deleted: true });
    assert.deepEqual(await env.store.deleteSchedule(s, { key: 'k', expectedRev: 1 }), { deleted: false, reason: 'not-found' });
    await created(env, s, 'k2');
    await env.store.putSchedule(s, { schedule: scheduleInput('k2', { paused: true }), expectedRev: 1 });
    assert.deepEqual(await env.store.deleteSchedule(s, { key: 'k2' }), { deleted: true }, 'without expectedRev any rev is deleted');
    assert.equal(await env.store.getSchedule(s, { key: 'k2' }), null);
    assert.deepEqual(await env.store.deleteSchedule(s, { key: 'k2' }), { deleted: false, reason: 'not-found' });
    assert.equal((await created(env, s, 'k')).rev, 1, 'a deleted key can be created again');
  });

  t.test('schedule-store: unknown or invalid schedule fields are refused before any write', async (env) => {
    const s = env.scope();
    const put = (schedule: unknown) => env.store.putSchedule(s, { schedule, expectedRev: null } as never);
    const input = scheduleInput('k');
    await rejectsRequest(put({ ...input, extra: 1 }), 'an unknown field');
    await rejectsRequest(put({ ...input, firstJob: { id: 'x' } }), 'firstJob is not part of this contract');
    await rejectsRequest(put({ ...input, template: { ...input.template, extra: 1 } }), 'an unknown template field');
    await rejectsRequest(put({ ...input, key: '' }), 'an empty key');
    await rejectsRequest(put({ ...input, key: 'x'.repeat(201) }), 'a 201-byte key');
    await rejectsRequest(put({ ...input, maxQueued: 0 }), 'maxQueued 0');
    await rejectsRequest(put({ ...input, template: { ...input.template, name: '' } }), 'an empty template name');
    await rejectsRequest(put({ ...input, everyMs: undefined }), 'kind every without everyMs');
    await rejectsRequest(put({ ...input, kind: 'cron' }), 'kind cron without cron');
    await rejectsRequest(env.store.listSchedules(s, { limit: 0 }), 'limit 0');
    assert.deepEqual(await env.store.listSchedules(s, { limit: 10 }), { schedules: [], nextCursor: null });
  });
}
