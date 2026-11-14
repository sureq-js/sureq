import assert from 'node:assert/strict';
import type { ClaimRequest, JobRecord, JobState, NewJob, NewSchedule, ObliterateResult, Scope, Store, SweepRequest } from '@sureq/core';
import type { TestEnv } from '../harness.js';

/** Every method of the store contract, `subscribe` aside. */
export const CONTRACT_METHODS = [
  'open', 'close', 'now', 'add', 'claim', 'renew', 'complete', 'fail', 'release', 'sweep', 'cancel', 'remove', 'update', 'get', 'list', 'counts',
  'setPaused', 'isPaused', 'stats', 'getAttempts', 'clean', 'obliterate', 'redrive', 'setProgress', 'registerWorker', 'heartbeatWorker',
  'unregisterWorker', 'listWorkers', 'purgeWorkers', 'ensureNamespaceMeta', 'getNamespaceMeta', 'putSchedule', 'getSchedule',
  'listSchedules', 'deleteSchedule', 'listDueSchedules', 'fireSchedule',
] as const satisfies readonly (keyof Store)[];
// Fails to compile when the contract gains a method this list does not have.
type Unlisted = Exclude<keyof Store, 'contractVersion' | 'capabilities' | 'subscribe' | (typeof CONTRACT_METHODS)[number]>;
const _complete: [Unlisted] extends [never] ? true : false = true;
void _complete;

export const STATES: readonly JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
export const ZERO_COUNTS = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, cancelled: 0, blocked: 0 };

const hasCode = (code: string) => (e: unknown): boolean => (e as { code?: unknown } | null)?.code === code;

/** Rejects with `StoreRequestError` (checked by its stable code, so a second copy of core still matches). */
export const rejectsRequest = (p: Promise<unknown>, message?: string): Promise<void> => assert.rejects(p, hasCode('STORE_BAD_REQUEST'), message);
export const rejectsCapability = (p: Promise<unknown>): Promise<void> => assert.rejects(p, hasCode('UNSUPPORTED_CAPABILITY'));

/** The sweep request the suite uses unless a test needs other values. */
export const sweepReq = (over: Partial<SweepRequest> = {}): SweepRequest => ({
  limit: 100,
  maxCrashes: 3,
  failError: 'stalled',
  poisonError: 'poison',
  ...over,
});

/** A valid schedule to put: every minute, nothing fired yet. */
export const scheduleInput = (key: string, over: Partial<NewSchedule> = {}): NewSchedule => ({
  formatVersion: 1,
  key,
  kind: 'every',
  everyMs: 60_000,
  anchorAt: 0,
  template: { name: null, data: '{}', opts: {} },
  overlap: 'skip',
  maxQueued: 10,
  paused: false,
  nextRunAt: 60_000,
  lastFiredFor: null,
  lastJobId: null,
  queuedTicks: [],
  runCount: 0,
  definitionHash: 'h',
  definitionVersion: 0,
  ...over,
});

/** The job a schedule fire inserts for `key` at the tick `scheduledFor`. */
export const fireJob = (key: string, scheduledFor: number): NewJob => ({
  id: `sched:${key}:${scheduledFor}`, data: '{}', formatVersion: 1, maxAttempts: 1, runAt: scheduledFor, onDuplicate: 'ignore',
});

/** Add one job and claim it; the scope must hold no other waiting job. */
export async function claimed(
  env: TestEnv,
  scope: Scope,
  over: Partial<NewJob> = {},
  claim: Partial<ClaimRequest> = {},
): Promise<{ job: JobRecord; token: number; now: number }> {
  const [added] = await env.addJobs(scope, 1, over);
  const res = await env.claim(scope, claim);
  const job = res.jobs[0];
  assert.equal(job?.id, added!.id, 'the added job is claimed');
  return { job: job!, token: job!.token, now: res.now };
}

export async function get(env: TestEnv, scope: Scope, id: string): Promise<JobRecord> {
  const rec = await env.store.get(scope, id);
  assert.ok(rec, `job ${id} exists`);
  return rec;
}

/** Every job in one state, through `list` pages. */
export async function listAll(store: Store, scope: Scope, state: JobState, page = 500): Promise<JobRecord[]> {
  const out: JobRecord[] = [];
  for (let offset = 0; ; offset += page) {
    const jobs = await store.list(scope, { state, offset, limit: page, order: 'asc' });
    out.push(...jobs);
    if (jobs.length < page) return out;
  }
}

/** Claim from every pod at once, in rounds, until nothing is left; fails on the first job claimed twice. */
export async function claimAll(pods: Store[], scope: Scope, limit: number, leaseMs: number): Promise<string[]> {
  const seen = new Set<string>();
  let n = 0;
  for (;;) {
    const rounds = await Promise.all(
      pods.map((p, i) => p.claim(scope, { workerId: `w${i}`, limit, leaseMs, claimId: `c${i}-${n++}` })),
    );
    const got = rounds.flatMap((r) => r.jobs.map((j) => j.id));
    if (got.length === 0) return [...seen];
    for (const id of got) {
      assert.ok(!seen.has(id), `job ${id} was claimed twice`);
      seen.add(id);
    }
  }
}

export function assertUnique(ids: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    assert.ok(!seen.has(id), `${what}: ${id} returned twice`);
    seen.add(id);
  }
}

/** Poll `check` (a real wait) until it is true or `ms` passed. */
export async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** Start `a` and `b` together; `swap` starts `b` first. Results come back as `[a, b]` either way. */
export async function together<A, B>(swap: boolean, a: () => Promise<A>, b: () => Promise<B>): Promise<[A, B]> {
  if (!swap) return Promise.all([a(), b()]);
  const [rb, ra] = await Promise.all([b(), a()]);
  return [ra, rb];
}

/** The first job of a claim, which must have returned one. */
export function oneJob(res: { jobs: JobRecord[] }): JobRecord {
  const job = res.jobs[0];
  assert.ok(job, 'the claim returns a job');
  return job;
}

/** Obliterate in pages of `limit` until done; the first call may force, the rest never do (the marker carries on). */
export async function obliterateAll(store: Store, s: Scope, force = true, limit = 100): Promise<number> {
  let removed = 0;
  for (let i = 0; i < 100; i++) {
    const res: ObliterateResult = await store.obliterate(s, { ...(force && i === 0 && { force: true }), limit });
    removed += res.removed;
    if (res.done) return removed;
  }
  assert.fail('obliterate never reports done');
}

/** Delete job `id` by cancel and remove, by cancel and clean, or by a forced obliterate of the whole queue. */
export async function deleteJob(env: TestEnv, s: Scope, id: string, how: 'remove' | 'clean' | 'obliterate'): Promise<void> {
  if (how === 'obliterate') return void (await obliterateAll(env.store, s));
  assert.equal((await env.store.cancel(s, { id })).ok, true, `${how}: the job is cancelled first`);
  if (how === 'remove') assert.equal((await env.store.remove(s, { id })).removed, true);
  else assert.equal((await env.store.clean(s, { state: 'cancelled', limit: 100 })).removed, 1);
  assert.equal(await env.store.get(s, id), null, `${how} deleted the job`);
}
