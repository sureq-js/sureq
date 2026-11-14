import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalError, StoreFormatError, StoreRequestError } from '../../src/errors/catalog.js';
import type { JobRecord, ListRequest, Scope } from '../../src/store/contract.js';
import { SCOPE, ZERO, claimReq, expectConsistent, fakeClock, newJob, openStore } from '../helpers/store.js';

const ids = (recs: JobRecord[]) => recs.map((r) => r.id);
const waiting = (over: Partial<ListRequest> = {}): ListRequest => ({ state: 'waiting', offset: 0, limit: 1000, order: 'asc', ...over });
const added = (outcome: unknown) => (outcome as { job: JobRecord }).job;

afterEach(() => vi.restoreAllMocks());

describe('memstore (add, get, list, counts)', () => {
  const RECORD_KEYS = [
    'formatVersion', 'namespace', 'queue', 'id', 'name', 'data', 'dataVersion', 'state', 'priority', 'seq', 'runAt', 'attempt',
    'maxAttempts', 'crashCount', 'lease', 'token', 'lastFinal', 'result', 'error', 'backoff', 'timeout', 'idempotencyKey', 'workerId',
    'uniqueWhile', 'singletonKey', 'singletonHeld', 'rev', 'createdAt', 'startedAt', 'finishedAt', 'deadLetter', 'retainUntil', 'keep',
    'progress', 'batchProgress', 'redriveCount', 'lastError', 'attemptsTruncated', 'scheduleKey', 'scheduledFor', 'cancelReason',
  ].sort();

  it('memstore: add stores a record with formatVersion 1 and all _core fields', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    const [out] = await store.add(SCOPE, [newJob({ id: 'a', maxAttempts: 5 })]);
    expect(out!.status).toBe('added');
    const job = added(out);
    expect(Object.keys(job).sort()).toEqual(RECORD_KEYS);
    expect(RECORD_KEYS).toHaveLength(41);
    expect(job).toEqual({
      formatVersion: 1, namespace: 'n', queue: 'q', id: 'a', name: null, data: '{"n":1}', dataVersion: null, state: 'waiting',
      priority: 0, seq: 1, runAt: 1000, attempt: 0, maxAttempts: 5, crashCount: 0, lease: null, token: 0, lastFinal: null,
      result: null, error: null, backoff: null, timeout: null, idempotencyKey: null, workerId: null, uniqueWhile: 'pending', singletonKey: null,
      singletonHeld: false, rev: 1, createdAt: 1000, startedAt: null, finishedAt: null, deadLetter: null, retainUntil: null, keep: null,
      progress: null, batchProgress: null, redriveCount: 0, lastError: null, attemptsTruncated: 0, scheduleKey: null, scheduledFor: null,
      cancelReason: null,
    });
    expect(await store.get(SCOPE, 'a')).toEqual(job);
  });

  it('contract: add returns one outcome per input in order', async () => {
    const store = await openStore();
    const out = await store.add(SCOPE, [newJob({ id: 'x' }), newJob({ id: 'y' }), newJob({ id: 'z' })]);
    expect(out.map((o) => o.status)).toEqual(['added', 'added', 'added']);
    expect(out.map((o) => added(o).id)).toEqual(['x', 'y', 'z']);
    expect(await store.add(SCOPE, [])).toEqual([]);
  });

  it('memstore: without a clock option the store reads Date.now once per operation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = await openStore();
    now.mockClear();
    const [d] = await store.add(SCOPE, [newJob({ delayMs: 100 })]);
    expect(added(d)).toMatchObject({ runAt: 1100, createdAt: 1000 });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('contract: add delayMs and runAt are resolved on store time', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    const [d, r, past] = await store.add(SCOPE, [newJob({ delayMs: 100 }), newJob({ runAt: 5000 }), newJob({ runAt: 10 })]);
    expect(added(d)).toMatchObject({ runAt: 1100, state: 'delayed', createdAt: 1000 });
    expect(added(r)).toMatchObject({ runAt: 5000, state: 'delayed' });
    expect(added(past)).toMatchObject({ runAt: 10, state: 'waiting' });
  });

  it('contract: payload round-trips byte-exact for ascii, unicode, empty string and Uint8Array', async () => {
    const store = await openStore();
    const payloads = ['abc', 'héllo 日本 \u{1F600} \uD800', '', new Uint8Array([0, 255, 1])];
    for (const [i, p] of payloads.entries()) await store.add(SCOPE, [newJob({ id: `p${i}`, data: p, backoff: p })]);
    for (const [i, p] of payloads.entries()) {
      const rec = (await store.get(SCOPE, `p${i}`))!;
      expect(rec.data).toEqual(p);
      expect(rec.backoff).toEqual(p);
      expect(rec.data.constructor).toBe(p.constructor);
    }
  });

  it('contract: returned records are copies', async () => {
    const store = await openStore();
    const [out] = await store.add(SCOPE, [newJob({ id: 'c' })]);
    added(out).priority = 99;
    expect((await store.get(SCOPE, 'c'))!.priority).toBe(0);
  });

  it('memstore: dump returns a deep copy', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'd' })]);
    await store.ensureNamespaceMeta({ namespace: 'n' }, { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: 'x' });
    const snap = store.dump();
    snap.jobs[0]!.priority = 50;
    snap.meta['n']!.updatedAt = -1;
    snap.tombstones.push({} as never);
    const again = store.dump();
    expect(again.jobs[0]!.priority).toBe(0);
    expect(again.meta['n']!.updatedAt).not.toBe(-1);
    expect(again.tombstones).toEqual([]);
  });

  it('contract: seq is strictly increasing per scope and first:true goes below all', async () => {
    const store = await openStore();
    const seqs = async (scope: Scope, jobs: Parameters<typeof store.add>[1]) => (await store.add(scope, jobs)).map((o) => added(o).seq);
    expect(await seqs(SCOPE, [newJob(), newJob()])).toEqual([1, 2]);
    expect(await seqs(SCOPE, [newJob({ first: true })])).toEqual([-1]);
    expect(await seqs(SCOPE, [newJob({ first: true })])).toEqual([-2]);
    expect(await seqs(SCOPE, [newJob()])).toEqual([3]);
    const other = { namespace: 'n', queue: 'other' };
    expect(await seqs(other, [newJob({ first: true }), newJob({ first: true }), newJob({ first: true })])).toEqual([-1, -2, -3]);
  });

  it('memstore: concurrent adds produce unique increasing seq', async () => {
    const store = await openStore();
    const client = (n: number) => Array.from({ length: n }, () => store.add(SCOPE, [newJob()]).then(([o]) => added(o).seq));
    const [a, b] = await Promise.all([Promise.all(client(1000)), Promise.all(client(1000))]);
    for (const seqs of [a, b]) for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(new Set([...a, ...b])).toEqual(new Set(Array.from({ length: 2000 }, (_, i) => i + 1)));
  });

  it('memstore: a reused id moves the finished record to its history key, seen only by dump', async () => {
    const store = await openStore();
    const old = added((await store.add(SCOPE, [newJob({ id: 'x', first: true })]))[0]);
    await store.cancel(SCOPE, { id: 'x' });
    await store.add(SCOPE, [newJob({ id: 'x' })]);
    const ids = store.dump().jobs.map((j) => j.id).sort();
    expect(ids).toEqual(['x', `x#${old!.seq}`]);
    expect(old!.seq).toBeLessThan(0);
    expect(await store.get(SCOPE, `x#${old!.seq}`)).toBeNull();
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 1 });
  });

  it('bulk: atomic add with a rejected duplicate at any position writes nothing, also undoing replaces and id moves', async () => {
    for (let k = 0; k < 5; k++) {
      for (const atomic of [false, true]) {
        const store = await openStore();
        await store.add(SCOPE, [newJob({ id: 'taken', data: '"a"' }), newJob({ id: 'done' })]);
        await store.cancel(SCOPE, { id: 'done' });
        const before = store.dump();
        const batch = Array.from({ length: 5 }, (_, i) => newJob({ id: i === k ? 'taken' : `b${i}`, onDuplicate: 'reject' }));
        // an earlier replace and an id reuse in the same call must be undone too
        const out = await store.add(SCOPE, [newJob({ id: 'taken', data: '"b"', onDuplicate: 'replace' }), newJob({ id: 'done' }), ...batch], { atomic });
        const statuses = out.map((o) => (o.status === 'duplicate' ? o.action : o.status));
        if (atomic) {
          expect(statuses).toEqual(statuses.map((_, i) => (i === k + 2 ? 'rejected' : 'not-applied')));
          expect(store.dump()).toEqual(before);
        } else {
          expect(statuses).toEqual(['replaced', 'added', ...batch.map((_, i) => (i === k ? 'rejected' : 'added'))]);
        }
      }
    }
    const failing = await openStore({
      faults: {
        before: (op) => {
          if (op === 'add') throw new TypeError('down');
        },
      },
    });
    await expect(failing.add(SCOPE, Array.from({ length: 5 }, () => newJob()), { atomic: true })).rejects.toThrow('down');
    expect(failing.dump().jobs).toEqual([]);
  });

  it('contract: unknown scope returns empty results and no error', async () => {
    const store = await openStore();
    const nowhere = { namespace: 'none', queue: 'none' };
    expect(await store.get(nowhere, 'x')).toBeNull();
    expect(await store.list(nowhere, waiting())).toEqual([]);
    expect(await store.counts(nowhere)).toEqual(ZERO);
  });

  it("memstore: two queue instances on one store see each other's jobs", async () => {
    const store = await openStore();
    const pod1 = { add: (id: string) => store.add(SCOPE, [newJob({ id })]) };
    const pod2 = { get: (id: string) => store.get(SCOPE, id), counts: () => store.counts(SCOPE) };
    await pod1.add('shared');
    expect((await pod2.get('shared'))!.id).toBe('shared');
    expect((await pod2.counts()).waiting).toBe(1);
  });

  it('contract: due delayed job is reported as waiting by get, list and counts', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'd', delayMs: 100 })]);
    expect(ids(await store.list(SCOPE, waiting({ state: 'delayed' })))).toEqual(['d']);
    c.t = 1100;
    expect((await store.get(SCOPE, 'd'))!.state).toBe('waiting');
    c.t = 1200;
    expect(ids(await store.list(SCOPE, waiting()))).toEqual(['d']);
    expect(await store.list(SCOPE, waiting({ state: 'delayed' }))).toEqual([]);
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 1 });
  });

  it('store: clock going backwards is clamped and delayed jobs still become due', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'late', delayMs: 100 })]);
    c.t = 500;
    expect((await store.counts(SCOPE)).delayed).toBe(1);
    const [o] = await store.add(SCOPE, [newJob({ id: 'now' })]);
    expect(added(o).createdAt).toBe(1000);
    c.t = 1200;
    expect((await store.counts(SCOPE)).waiting).toBe(2);
  });

  it('memstore: promotion of a due delayed job does not change rev, so update with the rev just read succeeds', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'd', delayMs: 100 })]);
    expect((await store.get(SCOPE, 'd'))!.rev).toBe(1);
    c.t = 1100;
    expect(await store.get(SCOPE, 'd')).toMatchObject({ state: 'waiting', rev: 1 });
    expect(store.dump().jobs[0]).toMatchObject({ state: 'waiting', rev: 1 });
  });

  it('contract: list pages by seq asc and desc', async () => {
    const store = await openStore();
    await store.add(SCOPE, Array.from({ length: 25 }, (_, i) => newJob({ id: `l${i}` })));
    for (const order of ['asc', 'desc'] as const) {
      const pages: string[] = [];
      for (let offset = 0; offset < 30; offset += 10) pages.push(...ids(await store.list(SCOPE, waiting({ offset, limit: 10, order }))));
      const expected = Array.from({ length: 25 }, (_, i) => `l${i}`);
      expect(pages).toEqual(order === 'asc' ? expected : expected.reverse());
    }
    expect(ids(await store.list(SCOPE, waiting({ offset: 20, limit: 10 })))).toHaveLength(5);
  });

  it('memstore: list orders by runAt, seq, with null startedAt first', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [
      newJob({ id: 'd1', delayMs: 300 }), newJob({ id: 'd2', delayMs: 100 }), newJob({ id: 'd3', delayMs: 100 }), newJob({ id: 'w' }),
    ]);
    const delayed = (over: Partial<ListRequest>) => store.list(SCOPE, waiting({ state: 'delayed', ...over }));
    expect(ids(await delayed({ orderBy: 'runAt' }))).toEqual(['d2', 'd3', 'd1']);
    expect(ids(await delayed({ orderBy: 'runAt', order: 'desc' }))).toEqual(['d1', 'd3', 'd2']);
    expect(ids(await delayed({ orderBy: 'runAt', offset: 1, limit: 1 }))).toEqual(['d3']);
    expect(ids(await delayed({}))).toEqual(['d1', 'd2', 'd3']);
    store.unsafeMutate(SCOPE, 'd1', { state: 'waiting', runAt: 1000 });
    expect(ids(await store.list(SCOPE, waiting({ orderBy: 'startedAt' })))).toEqual(['d1', 'w']);
  });

  it('memstore: list and get reject a record with a broken format stamp and return a newer one', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'bad' }), newJob({ id: 'new' })]);
    store.unsafeMutate(SCOPE, 'new', { formatVersion: 2 });
    expect((await store.get(SCOPE, 'new'))?.formatVersion).toBe(2);
    store.unsafeMutate(SCOPE, 'bad', { formatVersion: 0 });
    await expect(store.get(SCOPE, 'bad')).rejects.toMatchObject({ name: StoreFormatError.name, reason: 'missing' });
    await expect(store.list(SCOPE, waiting())).rejects.toBeInstanceOf(StoreFormatError);
  });

  it('memstore: add rejects delayMs that overflows the safe integer range', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await expect(store.add(SCOPE, [newJob(), newJob({ delayMs: Number.MAX_SAFE_INTEGER - 999 })])).rejects.toBeInstanceOf(StoreRequestError);
    expect(await store.counts(SCOPE)).toEqual(ZERO);
    const [o] = await store.add(SCOPE, [newJob({ delayMs: Number.MAX_SAFE_INTEGER - 1000 })]);
    expect(added(o).runAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('contract: invalid arguments throw StoreRequestError before any change', async () => {
    const store = await openStore();
    await expect(store.add({ namespace: '', queue: 'q' }, [newJob()])).rejects.toBeInstanceOf(StoreRequestError);
    await expect(store.add(SCOPE, [newJob({ id: '' })])).rejects.toBeInstanceOf(StoreRequestError);
    await expect(store.get(SCOPE, '')).rejects.toBeInstanceOf(StoreRequestError);
    await expect(store.list(SCOPE, waiting({ limit: 0 }))).rejects.toBeInstanceOf(StoreRequestError);
    expect(store.dump()).toEqual({ meta: {}, jobs: [], attempts: [], tombstones: [], schedules: [] });
  });
});

describe('memstore (update, remove, cancel, pause)', () => {
  it('contract: update applies on matching rev, conflict on stale rev, not-editable when active', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'u' }), newJob({ id: 'done' })]);
    const res = await store.update(SCOPE, { id: 'u', expectedRev: 1, patch: { data: 'new', priority: 3 } });
    expect(res).toMatchObject({ ok: true, job: { id: 'u', data: 'new', priority: 3, rev: 2, seq: 1 } });
    expect(await store.update(SCOPE, { id: 'u', expectedRev: 1, patch: { priority: 4 } })).toEqual({ ok: false, reason: 'conflict' });
    expect(await store.update(SCOPE, { id: 'nope', expectedRev: 1, patch: { priority: 4 } })).toEqual({ ok: false, reason: 'not-found' });
    store.unsafeMutate(SCOPE, 'done', { state: 'completed' });
    expect(await store.update(SCOPE, { id: 'done', expectedRev: 7, patch: { priority: 4 } })).toEqual({ ok: false, reason: 'not-editable' });
    expect((await store.get(SCOPE, 'u'))!).toMatchObject({ priority: 3, rev: 2 });
  });

  it('memstore: promotion of a due delayed job does not change rev, so update with the rev just read succeeds (update half)', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'd', delayMs: 100 })]);
    const before = (await store.get(SCOPE, 'd'))!;
    c.t = 1100;
    const res = await store.update(SCOPE, { id: 'd', expectedRev: before.rev, patch: { data: 'x' } });
    expect(res).toMatchObject({ ok: true, job: { state: 'waiting', rev: 2 } });
  });

  it('memstore: update of priority re-buckets a waiting job', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    await store.update(SCOPE, { id: 'a', expectedRev: 1, patch: { priority: 5 } });
    expect(store.dump().jobs.find((j) => j.id === 'a')).toMatchObject({ priority: 5, rev: 2 });
    await store.update(SCOPE, { id: 'b', expectedRev: 1, patch: { priority: 5 } });
    expect(ids(await store.list(SCOPE, waiting()))).toEqual(['a', 'b']);
  });

  it('memstore: update of delayMs or runAt re-derives the state both ways', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'w' }), newJob({ id: 'd', delayMs: 9000 }), newJob({ id: 'r', delayMs: 9000 })]);
    expect(await store.update(SCOPE, { id: 'w', expectedRev: 1, patch: { delayMs: 500 } })).toMatchObject({
      ok: true, job: { state: 'delayed', runAt: 1500 },
    });
    expect(await store.update(SCOPE, { id: 'd', expectedRev: 1, patch: { delayMs: 0 } })).toMatchObject({
      ok: true, job: { state: 'waiting', runAt: 1000 },
    });
    expect(await store.update(SCOPE, { id: 'r', expectedRev: 1, patch: { runAt: 10 } })).toMatchObject({
      ok: true, job: { state: 'waiting', runAt: 10 },
    });
    const bytes = new Uint8Array([0, 200]);
    await store.update(SCOPE, { id: 'r', expectedRev: 2, patch: { data: bytes } });
    bytes[0] = 1;
    expect((await store.get(SCOPE, 'r'))!.data).toEqual(new Uint8Array([0, 200]));
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 2, delayed: 1 });
    c.t = 1500;
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 3 });
    expect(ids(await store.list(SCOPE, waiting()))).toEqual(['w', 'd', 'r']);
  });

  it('memstore: update rejects a delayMs that overflows the safe integer range', async () => {
    const store = await openStore({ clock: fakeClock(1000).clock });
    await store.add(SCOPE, [newJob({ id: 'o' })]);
    await expect(store.update(SCOPE, { id: 'o', expectedRev: 1, patch: { delayMs: Number.MAX_SAFE_INTEGER } })).rejects.toBeInstanceOf(
      StoreRequestError,
    );
    expect((await store.get(SCOPE, 'o'))!).toMatchObject({ rev: 1, state: 'waiting' });
  });

  it('contract: remove deletes non-active jobs and refuses active', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'w' }), newJob({ id: 'd', delayMs: 5000 }), newJob({ id: 'c' })]);
    store.unsafeMutate(SCOPE, 'c', { state: 'completed' });
    expect(await store.remove(SCOPE, { id: 'w' })).toEqual({ removed: true, previousState: 'waiting' });
    expect(await store.remove(SCOPE, { id: 'd' })).toEqual({ removed: true, previousState: 'delayed' });
    expect(await store.remove(SCOPE, { id: 'c' })).toEqual({ removed: true, previousState: 'completed' });
    expect(await store.remove(SCOPE, { id: 'w' })).toEqual({ removed: false, reason: 'not-found' });
    expect(await store.counts(SCOPE)).toEqual(ZERO);
    expect(store.dump().jobs).toEqual([]);
  });

  it('memstore: remove frees the id and never reuses a seq', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' })]);
    await store.remove(SCOPE, { id: 'b' });
    const [again] = await store.add(SCOPE, [newJob({ id: 'b' })]);
    expect(added(again).seq).toBe(3);
  });

  it('contract: first true after deleting the lowest job still gets a seq below every seq ever issued', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'low', first: true })]);
    await store.remove(SCOPE, { id: 'low' });
    const [o] = await store.add(SCOPE, [newJob({ first: true })]);
    expect(added(o).seq).toBe(-2);
  });

  it('memstore: remove leaves a tombstone only for a job that was finalised', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock, finalsTtl: 1000 });
    await store.add(SCOPE, [newJob({ id: 'f' }), newJob({ id: 'never' })]);
    const [f] = (await store.claim(SCOPE, claimReq({ limit: 1 }))).jobs;
    await store.complete(SCOPE, { id: 'f', token: f!.token, result: null });
    await store.remove(SCOPE, { id: 'never' });
    await store.remove(SCOPE, { id: 'f' });
    expect(store.dump().tombstones).toEqual([
      { namespace: 'n', queue: 'q', id: 'f', seq: 1, token: 1, outcome: { kind: 'complete', state: 'completed' }, expiresAt: 2000 },
    ]);
    const snap = store.dump();
    snap.tombstones[0]!.token = 99;
    expect(store.dump().tombstones[0]!.token).toBe(1);

    c.t = 1500;
    await store.add(SCOPE, [newJob({ id: 'f' }), newJob({ id: 'g' })]);
    const [f2, g] = (await store.claim(SCOPE, claimReq())).jobs;
    await store.fail(SCOPE, { id: 'g', token: g!.token, error: 'e' });
    await store.complete(SCOPE, { id: 'f', token: f2!.token, result: null });
    await store.remove(SCOPE, { id: 'g' });
    await store.remove(SCOPE, { id: 'f' });
    expect(store.dump().tombstones.map((t) => [t.id, t.token, t.expiresAt])).toEqual([
      ['g', g!.token, 2500],
      ['f', f2!.token, 2500],
    ]);
    c.t = 2499;
    await store.now();
    expect(store.dump().tombstones).toHaveLength(2);
    c.t = 2500;
    await store.now();
    expect(store.dump().tombstones).toEqual([]);
  });

  it('memstore: unsafeMutate re-indexes without bumping rev', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'm' })]);
    const seen = async () => ({ counts: await store.counts(SCOPE), waiting: ids(await store.list(SCOPE, waiting())) });

    store.unsafeMutate(SCOPE, 'm', { state: 'delayed', runAt: 5000 });
    expect(await seen()).toEqual({ counts: { ...ZERO, delayed: 1 }, waiting: [] });
    store.unsafeMutate(SCOPE, 'm', { state: 'waiting' });
    store.unsafeMutate(SCOPE, 'm', { state: 'waiting' });
    expect(await seen()).toEqual({ counts: { ...ZERO, waiting: 1 }, waiting: ['m'] });
    c.t = 6000;
    expect((await seen()).counts).toEqual({ ...ZERO, waiting: 1 });
    const lease = { owner: 'w', token: 3, expiresAt: 9000, claimId: 'c' };
    store.unsafeMutate(SCOPE, 'm', { state: 'active', lease, token: 3 });
    store.unsafeMutate(SCOPE, 'm', { state: 'active', lease, token: 3 });
    expect(await seen()).toEqual({ counts: { ...ZERO, active: 1 }, waiting: [] });
    store.unsafeMutate(SCOPE, 'm', { lease: { ...lease, expiresAt: 10 } });
    expect(store.dump().jobs[0]).toMatchObject({ state: 'active', token: 3, rev: 1, lease: { expiresAt: 10 } });
    store.unsafeMutate(SCOPE, 'none', { state: 'waiting' });
    expect(() => store.unsafeMutate(SCOPE, 'm', { data: 'x' })).toThrow(InternalError);
  });

  it('fmtver: unknown extra fields survive complete, fail and update', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'c' }), newJob({ id: 'f' }), newJob({ id: 'g' }), newJob({ id: 'u' })]);
    for (const id of ['c', 'f', 'g', 'u']) store.unsafeMutate(SCOPE, id, { futureField: { v: 2 } });
    const [c, f, g] = (await store.claim(SCOPE, claimReq({ limit: 3 }))).jobs;
    await store.complete(SCOPE, { id: 'c', token: c!.token, result: null });
    await store.fail(SCOPE, { id: 'f', token: f!.token, error: '{}', retryInMs: 10 });
    await store.fail(SCOPE, { id: 'g', token: g!.token, error: '{}' });
    expect(await store.get(SCOPE, 'g')).toMatchObject({ state: 'failed' });
    const u = (await store.get(SCOPE, 'u'))!;
    expect(await store.update(SCOPE, { id: 'u', expectedRev: u.rev, patch: { priority: 1 } })).toMatchObject({ ok: true, job: { futureField: { v: 2 } } });
    for (const id of ['c', 'f', 'g', 'u']) expect(await store.get(SCOPE, id), id).toMatchObject({ futureField: { v: 2 } });
  });

  it('cancel: waiting and delayed jobs become cancelled and never run', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    await store.add(SCOPE, [newJob({ id: 'w' }), newJob({ id: 'd', delayMs: 100 })]);
    c.t = 1050;
    expect(await store.cancel(SCOPE, { id: 'w' })).toEqual({ ok: true, previousState: 'waiting' });
    expect(await store.cancel(SCOPE, { id: 'd' })).toEqual({ ok: true, previousState: 'delayed' });
    for (const id of ['w', 'd']) {
      expect(await store.get(SCOPE, id)).toMatchObject({ state: 'cancelled', finishedAt: 1050, lease: null, rev: 2 });
    }
    c.t = 2000;
    expect(await store.list(SCOPE, waiting())).toEqual([]);
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, cancelled: 2 });
  });

  it('cancel: terminal job returns already-terminal with its state', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' })]);
    await store.cancel(SCOPE, { id: 'a' });
    expect(await store.cancel(SCOPE, { id: 'a' })).toEqual({ ok: false, reason: 'already-terminal', state: 'cancelled' });
    expect((await store.get(SCOPE, 'a'))!.rev).toBe(2);
  });

  it('cancel: unknown id returns not-found', async () => {
    const store = await openStore();
    expect(await store.cancel(SCOPE, { id: 'x' })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('cancel: counts move atomically between states', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' }), newJob({ id: 'c', delayMs: 100 })]);
    const before = await store.counts(SCOPE);
    await store.cancel(SCOPE, { id: 'a' });
    expect(await store.counts(SCOPE)).toEqual({ ...before, waiting: before.waiting - 1, cancelled: 1 });
  });

  it('gpause: setPaused persists and changed flag is correct', async () => {
    const store = await openStore();
    expect(await store.isPaused(SCOPE)).toBe(false);
    expect(await store.setPaused(SCOPE, true)).toEqual({ changed: true });
    expect(await store.setPaused(SCOPE, true)).toEqual({ changed: false });
    expect(await store.isPaused(SCOPE)).toBe(true);
    expect(await store.setPaused(SCOPE, false)).toEqual({ changed: true });
    expect(await store.isPaused(SCOPE)).toBe(false);
    await expect(store.setPaused(SCOPE, 'yes' as unknown as boolean)).rejects.toBeInstanceOf(StoreRequestError);
  });

  it('gpause: flag is per queue and namespace', async () => {
    const store = await openStore();
    await store.setPaused(SCOPE, true);
    expect(await store.isPaused({ namespace: 'n', queue: 'other' })).toBe(false);
    expect(await store.isPaused({ namespace: 'other', queue: 'q' })).toBe(false);
    expect(await store.isPaused(SCOPE)).toBe(true);
  });

  it('contract: blocked is a subset of waiting and equals waiting while paused', async () => {
    const store = await openStore();
    await store.add(SCOPE, [newJob({ id: 'a' }), newJob({ id: 'b' }), newJob({ id: 'd', delayMs: 100 })]);
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 2, delayed: 1, blocked: 0 });
    await store.setPaused(SCOPE, true);
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 2, delayed: 1, blocked: 2 });
    await store.add(SCOPE, [newJob({ id: 'p' })]);
    expect(await store.update(SCOPE, { id: 'a', expectedRev: 1, patch: { priority: 2 } })).toMatchObject({ ok: true });
    expect(await store.cancel(SCOPE, { id: 'b' })).toMatchObject({ ok: true });
    expect(await store.remove(SCOPE, { id: 'd' })).toMatchObject({ removed: true });
    expect(await store.counts(SCOPE)).toEqual({ ...ZERO, waiting: 2, cancelled: 1, blocked: 2 });
  });

  it('contract: counts equal list totals per state after a mixed workload', async () => {
    const { c, clock } = fakeClock(1000);
    const store = await openStore({ clock });
    let seed = 42;
    const rnd = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n);
    const known: string[] = [];
    const active: Array<{ id: string; token: number }> = [];
    for (let op = 1; op <= 200; op++) {
      const id = known[rnd(Math.max(known.length, 1))] ?? 'missing';
      switch (rnd(8)) {
        case 0: {
          const job = newJob(rnd(2) ? { delayMs: rnd(500) } : { priority: rnd(3) });
          known.push(job.id);
          await store.add(SCOPE, [job]);
          break;
        }
        case 1: {
          const rec = await store.get(SCOPE, id);
          if (rec) await store.update(SCOPE, { id, expectedRev: rec.rev, patch: rnd(2) ? { delayMs: rnd(300) } : { priority: rnd(4) } });
          break;
        }
        case 2:
          await store.cancel(SCOPE, { id });
          break;
        case 3:
          await store.remove(SCOPE, { id });
          break;
        case 4:
          for (const j of (await store.claim(SCOPE, claimReq({ limit: 2 }))).jobs) active.push({ id: j.id, token: j.token });
          break;
        case 5: {
          const a = active.splice(rnd(Math.max(active.length, 1)), 1)[0];
          if (a) await store.complete(SCOPE, { ...a, result: null });
          break;
        }
        case 6: {
          const a = active.splice(rnd(Math.max(active.length, 1)), 1)[0];
          if (a) await store.fail(SCOPE, { ...a, error: 'e', ...(rnd(2) ? { retryInMs: rnd(100) } : {}) });
          break;
        }
        default:
          c.t += rnd(200);
      }
      if (op % 50 === 0) await expectConsistent(store);
    }
  });
});
