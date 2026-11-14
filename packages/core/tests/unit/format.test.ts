import { describe, expect, expectTypeOf, it } from 'vitest';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { SCOPE as scope, added, claimReq, newJob as job, openStore } from '../helpers/store.js';
import { FORMAT_VERSION, RECORD_KINDS, stamp, parseRecord, type RecordKind } from '../../src/store/memory/format.js';
import { rng } from '../helpers/pods.js';
import { StoreFormatError } from '../../src/errors/catalog.js';

const formatErr = (fn: () => unknown): StoreFormatError => {
  try {
    fn();
  } catch (e) {
    return e as StoreFormatError;
  }
  throw new TypeError('expected a throw');
};

describe('fmtver', () => {
  it('fmtver: FORMAT_VERSION is exposed read-only', () => {
    expect(FORMAT_VERSION).toBe(1);
    expectTypeOf(FORMAT_VERSION).toEqualTypeOf<1>();
  });

  it('fmtver: all record kinds are stamped', () => {
    for (const k of RECORD_KINDS) expect(stamp(k, {}).formatVersion).toBe(1);
    expect([...RECORD_KINDS]).toEqual(['job', 'attempt', 'schedule', 'settings', 'meta']);
    // Adding a kind without updating this map fails typecheck.
    const exhaustive: Record<RecordKind, true> = { job: true, attempt: true, schedule: true, settings: true, meta: true };
    expect(Object.keys(exhaustive)).toHaveLength(RECORD_KINDS.length);
  });

  it('fmtver: unknown newer version throws StoreFormatError with reason too-new, found and supported', () => {
    const e = formatErr(() => parseRecord('job', { id: 'a', formatVersion: 2 }));
    expect(e).toBeInstanceOf(StoreFormatError);
    expect([e.code, e.reason, e.found, e.supported, e.recordKind, e.recordId]).toEqual(['STORE_FORMAT_UNSUPPORTED', 'too-new', 2, 1, 'job', 'a']);
    expect(e.message).toBe('Record was written by a newer SureQ (format 2); this version reads up to 1. Upgrade sureq.');
  });

  it.each([
    ['absent', { id: 'a' }],
    ['null', { id: 'a', formatVersion: null }],
    ['string', { id: 'a', formatVersion: '1' }],
    ['fraction', { id: 'a', formatVersion: 1.5 }],
    ['zero', { id: 'a', formatVersion: 0 }],
    ['negative', { id: 'a', formatVersion: -1 }],
    ['NaN', { id: 'a', formatVersion: NaN }],
    ['boolean', { id: 'a', formatVersion: true }],
  ])('fmtver: missing or invalid version throws StoreFormatError with reason missing and found null (%s)', (_label, raw) => {
    const e = formatErr(() => parseRecord('job', raw));
    expect([e.reason, e.found]).toEqual(['missing', null]);
  });

  it('fmtver: a non-object record is missing', () => {
    expect(formatErr(() => parseRecord('job', null)).reason).toBe('missing');
    expect(formatErr(() => parseRecord('job', 'x')).reason).toBe('missing');
  });

  it('fmtver: reader registry upgrades an older version in memory without writing', () => {
    const raw = Object.freeze({ id: 'r', formatVersion: 1 });
    const before = structuredClone(raw);
    const up = parseRecord<Record<string, unknown>>('job', raw, {
      current: 2,
      readers: { 1: (r) => ({ ...r, formatVersion: 2, upgraded: true }), 2: (r) => r },
    });
    expect(up).toMatchObject({ upgraded: true, formatVersion: 2 });
    expect(raw).toEqual(before);
    const e = formatErr(() => parseRecord('job', raw, { current: 2, readers: { 2: (r) => r } }));
    expect([e.reason, e.found, e.supported]).toEqual(['too-old', 1, 2]);
  });

  it('fmtver: unknown extra fields survive', () => {
    const raw = { id: 'x', formatVersion: 1, future: { a: 1 } };
    const out = parseRecord('job', raw);
    expect(out).toBe(raw);
    expect((out as typeof raw).future).toEqual({ a: 1 });
  });

  it('fmtver: meta record is written once per namespace', async () => {
    let t = 123;
    const store = await openStore({ clock: () => t });
    const support = { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: 'a' };
    expect(await store.ensureNamespaceMeta({ namespace: 'n' }, support)).toEqual({ formatVersion: 1, created: true, raised: false });
    t = 456;
    expect(await store.ensureNamespaceMeta({ namespace: 'n' }, { ...support, sureqVersion: 'b' })).toEqual({ formatVersion: 1, created: false, raised: false });
    expect(store.dump().meta).toEqual({ n: { formatVersion: 1, createdBy: 'a', lastRaisedBy: 'a', updatedAt: 123 } });
  });
});

describe('MemoryStore format', () => {
  const claim = async (store: MemoryStore) => (await store.claim(scope, claimReq({ workerId: 'w', limit: 10, maxFormat: 1 }))).jobs;
  const allVersioned = (store: MemoryStore) => {
    const snap = store.dump();
    for (const j of snap.jobs) expect(j.formatVersion, j.id).toBe(1);
    for (const m of Object.values(snap.meta)) expect(m.formatVersion).toBe(1);
  };
  const err = JSON.stringify({ v: 1, name: 'E', message: 'x' });

  it('fmtver: every record created by add, claim, complete and fail carries formatVersion 1', async () => {
    const store = await openStore();
    await store.add(scope, [job({ id: 'a' }), job({ id: 'b' })]);
    allVersioned(store);
    const [a] = (await store.claim(scope, claimReq({ workerId: 'w', limit: 1 }))).jobs;
    allVersioned(store);
    await store.complete(scope, { id: 'a', token: a!.token, result: null });
    allVersioned(store);
    const [b] = await claim(store);
    await store.fail(scope, { id: b!.id, token: b!.token, error: err, retryInMs: 10 });
    allVersioned(store);
  });

  it('fmtver: addBulk stamps every record', async () => {
    const store = await openStore();
    const out = await store.add(scope, Array.from({ length: 50 }, () => job()));
    expect(added(out).every((r) => r.formatVersion === 1)).toBe(true);
    expect(store.dump().jobs).toHaveLength(50);
    allVersioned(store);
  });

  it('fmtver: ordinary updates do not change formatVersion', async () => {
    let t = 1000;
    const store = await openStore({ clock: () => t });
    await store.add(scope, [job({ id: 'u', delayMs: 5 })]);
    t = 2000;
    const [u] = await claim(store);
    await store.fail(scope, { id: 'u', token: u!.token, error: err, retryInMs: 0 });
    const [u2] = await claim(store);
    await store.complete(scope, { id: 'u', token: u2!.token, result: null });
    const rec = (await store.get(scope, 'u'))!;
    expect(rec.formatVersion).toBe(1);
    expect(rec.rev).toBeGreaterThan(3);
  });

  it('fmtver: claim skips a corrupt record and claims the rest', async () => {
    const store = await openStore();
    await store.add(scope, [job({ id: 'c1' }), job({ id: 'c2' }), job({ id: 'c3' }), job({ id: 'c4' }), job({ id: 'c5' })]);
    store.unsafeMutate(scope, 'c2', { formatVersion: 2 });
    store.unsafeMutate(scope, 'c4', { formatVersion: '1' });
    expect((await claim(store)).map((r) => r.id)).toEqual(['c1', 'c3', 'c5']);
    const left = store.dump().jobs.filter((j) => j.id === 'c2' || j.id === 'c4');
    expect(left.map((j) => [j.id, j.formatVersion, j.state, j.rev])).toEqual([['c2', 2, 'waiting', 1], ['c4', '1', 'waiting', 1]]);
    expect(await claim(store)).toEqual([]);
    expect((await store.get(scope, 'c2'))?.formatVersion).toBe(2);
    await expect(store.get(scope, 'c4')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('fmtver: meta record is written once per namespace (store)', async () => {
    let t = 500;
    const store = await openStore({ clock: () => t });
    const support = { current: 1, minReadable: 1, maxReadable: 1, sureqVersion: 'x' };
    await store.add({ namespace: 'n', queue: 'a' }, [job()]);
    expect(store.dump().meta).toEqual({});
    for (const namespace of ['n', 'm']) await store.ensureNamespaceMeta({ namespace }, support);
    t = 9000;
    for (const namespace of ['n', 'm']) await store.ensureNamespaceMeta({ namespace }, support);
    await store.add({ namespace: 'n', queue: 'b' }, [job()]);
    const meta = store.dump().meta;
    expect(Object.keys(meta).sort()).toEqual(['m', 'n']);
    expect([meta['n']!.updatedAt, meta['m']!.updatedAt]).toEqual([500, 500]);
  });

  it('fmtver: regression every record carries formatVersion', async () => {
    const rnd = rng(7);
    let t = 1000;
    const store = await openStore({ clock: () => t });
    const active: Array<{ id: string; token: number }> = [];
    for (let i = 0; i < 500; i++) {
      const r = rnd();
      if (r < 0.4) await store.add(scope, [job({ delayMs: rnd() < 0.3 ? 20 : 0 })]);
      else if (r < 0.6) active.push(...(await claim(store)).map((x) => ({ id: x.id, token: x.token })));
      else if (r < 0.8 && active.length) await store.complete(scope, { ...active.pop()!, result: null });
      else if (active.length) await store.fail(scope, { ...active.pop()!, error: err, ...(rnd() < 0.5 && { retryInMs: 5 }) });
      t += 3;
    }
    allVersioned(store);
  });
});
