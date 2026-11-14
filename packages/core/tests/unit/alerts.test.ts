import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from '../../src/errors/catalog.js';
import type { ErrorEvent } from '../../src/events/types.js';
import type { AlertEvent } from '../../src/metrics/alerts.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import type { StatsResult, Store } from '../../src/store/contract.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { useFakeTime } from '../helpers/fake-time.js';
import { silent } from '../helpers/harness.js';
import { killClaim } from '../helpers/pods.js';
import { poll } from '../helpers/poll.js';
import { K1, NEW, OLD, podOn } from '../helpers/releases.js';
import { live } from '../helpers/pods.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
  vi.useRealTimers();
  await Promise.all(queues.splice(0).map((q) => q.close({ timeoutMs: 100 })));
});

const run = { ...poll(10), random: () => 0.5, sweepInterval: 3_600_000, acknowledgeVolatileStore: true };

type Over = Parameters<typeof spyStore>[1];
/** Queue `a` on a spied store with a hand-driven clock and `alerts.interval` 1 s; every `alert` and `error` is recorded. */
function world(alerts: QueueOptions['alerts'], o: { queue?: QueueOptions; over?: (raw: MemoryStore) => Over } = {}) {
  useFakeTime();
  const clock = { now: 1_000_000 };
  const raw = new MemoryStore({ clock: () => clock.now });
  const spy = spyStore(raw, o.over?.(raw));
  const q = new Queue('a', { logger: silent, ...o.queue, alerts: { interval: '1s', ...alerts }, store: spy.store });
  queues.push(q);
  const events: AlertEvent[] = [];
  const errors: ErrorEvent[] = [];
  q.on('alert', (e) => void events.push(e));
  q.on('error', (e) => void errors.push(e));
  const tick = (n = 1) => vi.advanceTimersByTimeAsync(1000 * n);
  const ops = (op: string) => spy.calls.filter((c) => c.op === op).length;
  return { raw, store: spy.store as Store, clock, q, events, errors, tick, ops, scope: q.internals.scope };
}

const base = { namespace: 'default', queue: 'a' };

describe('alert options', () => {
  it('alerts: invalid rules throw InvalidOptionError', () => {
    const pathsOf = (alerts: unknown) => {
      try {
        new Queue('a', { logger: silent, alerts: alerts as NonNullable<QueueOptions['alerts']> });
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidOptionError);
        return (e as InvalidOptionError).issues.map((i) => i.path);
      }
      return [];
    };
    expect(pathsOf({ depth: { above: 0 } })).toEqual(['alerts.depth.above']);
    expect(pathsOf({ depth: { above: 10, resolveBelow: 11 } })).toEqual(['alerts.depth.resolveBelow']);
    expect(pathsOf({ depth: {} })).toEqual(['alerts.depth.above']);
    expect(pathsOf({ age: { aboveMs: -1 } })).toEqual(['alerts.age.aboveMs']);
    expect(pathsOf({ age: { aboveMs: 10, resolveBelowMs: 20 } })).toEqual(['alerts.age.resolveBelowMs']);
    expect(pathsOf({ failureRate: { above: 1.5 } })).toEqual(['alerts.failureRate.above']);
    expect(pathsOf({ failureRate: { above: 0 } })).toEqual(['alerts.failureRate.above']);
    expect(pathsOf({ failureRate: { above: 0.5, resolveBelow: 0.6 } })).toEqual(['alerts.failureRate.resolveBelow']);
    expect(pathsOf({ failureRate: { above: 0.5, minJobs: 0 } })).toEqual(['alerts.failureRate.minJobs']);
    expect(pathsOf({ interval: '500ms' })).toEqual(['alerts.interval']);
    expect(pathsOf(5)).toEqual(['alerts']);
    try {
      new Queue('a', { logger: silent, alerts: { depht: { above: 1 } } as NonNullable<QueueOptions['alerts']> });
      expect.unreachable();
    } catch (e) {
      expect((e as InvalidOptionError).issues).toEqual([expect.objectContaining({ path: 'alerts.depht', code: 'unknown_option', suggestion: 'depth' })]);
    }
    const q = new Queue('a', { logger: silent, alerts: { depth: { above: 5 }, age: { aboveMs: 100 }, failureRate: { above: 0.5 } } });
    expect(q.internals.alerts).toEqual({
      intervalMs: 15_000, depth: { above: 5, resolveBelow: 5 }, age: { aboveMs: 100, resolveBelowMs: 100 }, failureRate: { above: 0.5, resolveBelow: 0.5, minJobs: 10 },
    });
    void q.close();
  });
});

describe('alert evaluation', () => {
  it('alerts: depth fires once on crossing and resolves once below resolveBelow', async () => {
    const w = world({ depth: { above: 5, resolveBelow: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await w.q.add(i)).job.id);
    await w.tick();
    expect(w.events).toEqual([{ type: 'depth', status: 'firing', value: 5, threshold: 5, ...base, at: w.clock.now }]);
    const firing = (await w.q.metrics()).samples.filter((s) => s.name === 'sureq_alert_firing');
    expect(firing).toEqual([{ name: 'sureq_alert_firing', labels: { ...base, type: 'depth' }, value: 1 }]);
    for (let i = 0; i < 3; i++) ids.push((await w.q.add(i)).job.id);
    await w.tick(3);
    expect(w.events).toHaveLength(1);
    for (const id of ids.splice(0, 6)) await w.q.remove(id);
    await w.tick();
    expect(w.events).toHaveLength(1);
    await w.q.remove(ids.shift()!);
    await w.tick();
    expect(w.events[1]).toEqual({ type: 'depth', status: 'resolved', value: 1, threshold: 2, ...base, at: w.clock.now });
    expect((await w.q.metrics()).samples.filter((s) => s.name === 'sureq_alert_firing').map((s) => 'value' in s && s.value)).toEqual([0]);
  });

  it('alerts: age fires and resolves', async () => {
    const w = world({ age: { aboveMs: 10_000 } });
    const { job } = await w.q.add(1);
    w.clock.now += 10_000;
    await w.tick();
    expect(w.events).toEqual([{ type: 'age', status: 'firing', value: 10, threshold: 10, ...base, at: w.clock.now }]);
    await w.q.remove(job.id);
    await w.tick();
    expect(w.events[1]).toMatchObject({ type: 'age', status: 'resolved', value: 0, threshold: 10 });
  });

  it('alerts: failureRate needs minJobs before firing', async () => {
    const w = world({ failureRate: { above: 0.5, minJobs: 4 } });
    w.q.process((job) => (job.data === 'bad' ? Promise.reject(new Error('no')) : 'ok'), run);
    const runAll = async (data: string, n: number) => {
      for (let i = 0; i < n; i++) await w.q.add(data, { maxAttempts: 1 });
      await vi.advanceTimersByTimeAsync(100);
    };
    await runAll('bad', 3);
    await w.tick();
    expect(w.events).toEqual([]);
    await runAll('bad', 1);
    await w.tick();
    expect(w.events).toEqual([expect.objectContaining({ type: 'failureRate', status: 'firing', value: 1, threshold: 0.5 })]);
    await runAll('good', 4);
    await w.tick();
    expect(w.events).toHaveLength(1);
    await runAll('good', 2);
    await w.tick();
    expect(w.events[1]).toMatchObject({ type: 'failureRate', status: 'resolved', value: 4 / 10, threshold: 0.5 });
  });

  it('alerts: no repeat events while the condition holds', async () => {
    const w = world({ depth: { above: 1 } });
    await w.q.add(1);
    await w.tick(10);
    expect(w.events).toHaveLength(1);
    expect(w.ops('stats')).toBe(10);
  });

  it('alerts: store error skips evaluation without changing state', async () => {
    let fail = false;
    const w = world({ depth: { above: 1 } }, {
      over: (raw) => ({
        stats: (scope, req) => {
          if (!fail) return raw.stats(scope, req);
          fail = false;
          return Promise.reject(new Error('stats down'));
        },
      }),
    });
    const { job } = await w.q.add(1);
    await w.tick();
    expect(w.q.getAlerts()).toHaveLength(1);
    fail = true;
    await w.q.remove(job.id);
    await w.tick();
    expect(w.errors).toEqual([expect.objectContaining({ source: 'store', context: expect.objectContaining({ operation: 'stats' }) })]);
    expect(w.events).toHaveLength(1);
    expect(w.q.getAlerts()).toEqual([w.events[0]]);
    await w.tick();
    expect(w.events.map((e) => e.status)).toEqual(['firing', 'resolved']);
  });

  it('alerts: a stats outage is reported once and again after a success', async () => {
    let fail = true;
    const w = world({ depth: { above: 1 } }, {
      over: (raw) => ({ stats: (scope, req) => (fail ? Promise.reject(new Error('stats down')) : raw.stats(scope, req)) }),
    });
    await w.tick(3);
    expect(w.errors).toHaveLength(1);
    fail = false;
    await w.tick();
    fail = true;
    await w.tick(2);
    expect(w.errors).toHaveLength(2);
  });

  it('alerts: throwing listener does not stop evaluation', async () => {
    const w = world({ depth: { above: 1 } });
    const second: string[] = [];
    w.q.on('alert', () => {
      throw new Error('listener bug');
    });
    w.q.on('alert', (e) => void second.push(e.status));
    const { job } = await w.q.add(1);
    await w.tick();
    await w.q.remove(job.id);
    await w.tick();
    expect(second).toEqual(['firing', 'resolved']);
    expect(w.errors.filter((e) => e.source === 'listener').length).toBeGreaterThan(0);
  });

  it('alerts: getAlerts and health list firing alerts', async () => {
    const w = world({ depth: { above: 1 } });
    await w.q.ready();
    const { job } = await w.q.add(1);
    await w.tick();
    const from = { now: w.ops('now'), stats: w.ops('stats') };
    const r = await w.q.health();
    expect(r.alerts).toEqual(w.q.getAlerts());
    expect(r.alerts).toEqual([expect.objectContaining({ type: 'depth', status: 'firing' })]);
    expect(r).toMatchObject({ status: 'degraded', live: true, ready: true });
    expect({ now: w.ops('now') - from.now, stats: w.ops('stats') - from.stats }).toEqual({ now: 1, stats: 0 });
    await w.q.remove(job.id);
    await w.tick();
    expect(await w.q.health()).toMatchObject({ alerts: [], status: 'ok' });
  });

  it('alerts: close stops evaluation and a late stats answer fires nothing', async () => {
    let open!: () => void;
    let gated = false;
    const w = world({ depth: { above: 1 } }, {
      queue: { shutdownTimeout: 1000, shutdownAbortGrace: 500 },
      over: (raw) => ({
        stats: async (scope, req) => {
          if (gated) await new Promise<void>((r) => (open = r));
          return raw.stats(scope, req);
        },
      }),
    });
    await w.q.add(1);
    gated = true;
    await w.tick();
    const t0 = performance.now();
    let closedAt: number | undefined;
    const closing = w.q.close().then(() => (closedAt = performance.now()));
    await vi.advanceTimersByTimeAsync(3000);
    await closing;
    expect(closedAt! - t0).toBeLessThanOrEqual(1000 + 500 + 1000);
    open();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.events).toEqual([]);
  });

  it('alerts: a queue with no workers evaluates when alerts are set', async () => {
    const w = world({ age: { aboveMs: 60_000 } });
    await w.tick(3);
    expect(w.ops('stats')).toBe(3);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    queues.splice(0);
    const closed = w.q.close();
    await vi.advanceTimersByTimeAsync(100);
    await closed;
    expect(vi.getTimerCount()).toBe(0);
    await w.tick(3);
    expect(w.ops('stats')).toBe(3);
  });

  it('alerts: a pod refused by the store format evaluates nothing', async () => {
    const w = world({ depth: { above: 1 } });
    // the namespace was written by a newer release this pod cannot read
    await w.raw.open();
    await w.raw.ensureNamespaceMeta({ namespace: 'default' }, NEW);
    await w.tick(3);
    expect(w.events).toEqual([]);
    expect(w.ops('stats')).toBe(0);
    expect(w.errors).toHaveLength(1);
  });

  it('age: blocked jobs (paused queue, dependency, ordered key) are ignored by the oldest waiting age', async () => {
    const w = world({ age: { aboveMs: 1000 } });
    for (let i = 0; i < 3; i++) await w.q.add(i);
    w.clock.now += 60_000;
    await w.q.pause();
    expect(await w.q.getOldestWaitingAge()).toBeNull();
    expect((await w.q.metrics()).samples.find((s) => s.name === 'sureq_oldest_waiting_age_seconds')).toMatchObject({ value: 0 });
    await w.tick(10);
    expect(w.events).toEqual([]);
    await w.q.resume();
    await w.tick();
    expect(w.events).toEqual([expect.objectContaining({ type: 'age', status: 'firing', value: 60 })]);
  });
});

describe('health warnings', () => {
  it('health: dead letters above warnAbove add DEAD_LETTERS_HIGH from the last tick', async () => {
    const cases: Array<[NonNullable<QueueOptions['deadLetter']>, number, boolean]> = [[{ warnAbove: 2 }, 3, true], [{ warnAbove: 3 }, 3, false], [{ warnAbove: false }, 3, false], [false, 3, false]];
    for (const [deadLetter, n, warns] of cases) {
      useFakeTime();
      const clock = { now: 1_000_000 };
      const store = new MemoryStore({ clock: () => clock.now });
      const q = new Queue('d', { logger: silent, store, deadLetter });
      queues.push(q);
      for (let i = 0; i < n; i++) await q.add(i, { maxAttempts: 1 });
      const stats: StatsResult[] = [];
      const read = q.internals.statsCache;
      const refresh = read.refresh.bind(read);
      read.refresh = async () => {
        const s = await refresh();
        stats.push(s);
        return s;
      };
      q.process(() => Promise.reject(new Error('no')), { ...run, sweepInterval: 1000 });
      await vi.advanceTimersByTimeAsync(200);
      const before = await q.health();
      expect(before.warnings.map((x) => x.code)).not.toContain('DEAD_LETTERS_HIGH');
      await vi.advanceTimersByTimeAsync(1200);
      expect(stats.length, String(deadLetter)).toBeGreaterThan(0);
      const after = await q.health();
      const codes = after.warnings.map((x) => x.code);
      expect(codes.includes('DEAD_LETTERS_HIGH'), JSON.stringify(deadLetter)).toBe(warns);
      if (warns) {
        expect(after.status).toBe('degraded');
        expect(after.warnings.find((x) => x.code === 'DEAD_LETTERS_HIGH')!.message).toBe('3 dead letters, above deadLetter.warnAbove (2)');
      }
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await Promise.all(queues.splice(0).map((x) => x.close({ timeoutMs: 100 })));
    }
  });

  it('health: a sweeper with no finished tick in five intervals adds SWEEP_STALLED', async () => {
    let gated = false;
    let open = () => {};
    const w = world({ depth: { above: 1_000 } }, {
      over: (raw) => ({
        sweep: async (scope, req) => {
          if (gated) await new Promise<void>((r) => (open = r));
          return raw.sweep(scope, req);
        },
      }),
    });
    await w.q.ready();
    gated = true;
    w.q.process(() => 'ok', { ...run, sweepInterval: 1000 });
    await vi.advanceTimersByTimeAsync(4000);
    expect((await w.q.health()).warnings.map((x) => x.code)).not.toContain('SWEEP_STALLED');
    await vi.advanceTimersByTimeAsync(1500);
    const stalled = await w.q.health();
    expect(stalled.warnings).toContainEqual({ code: 'SWEEP_STALLED', message: 'the sweeper has not finished a tick in 5 x sweepInterval' });
    expect(stalled).toMatchObject({ status: 'degraded', live: true });
    gated = false;
    open();
    await vi.advanceTimersByTimeAsync(10);
    expect((await w.q.health()).warnings.map((x) => x.code)).not.toContain('SWEEP_STALLED');
  });

  it('health: a format-degraded pod does not add SWEEP_STALLED', async () => {
    useFakeTime();
    const store = new MemoryStore({ clock: () => Date.now() });
    await store.open();
    const old = podOn(store, OLD);
    queues.push(old);
    old.process(async () => 'ok', live);
    await vi.advanceTimersByTimeAsync(100);
    const next = podOn(store, K1);
    queues.push(next);
    await next.ready();
    await vi.advanceTimersByTimeAsync(60_000);
    const h = await old.health();
    expect(h.format.degraded).toBe(true);
    expect(h.warnings.map((x) => x.code)).toEqual(['STORE_FORMAT_AHEAD']);
  });

  it('health: a crashed job swept by this pod refreshes the cached stats', async () => {
    const w = world({ depth: { above: 1_000 } });
    await w.q.add(1, { name: 'work' });
    await killClaim(w.raw, 'a');
    w.q.process({ other: () => 1 }, { ...run, sweepInterval: 500 });
    await vi.advanceTimersByTimeAsync(700);
    expect(w.q.internals.statsCache.latest).toMatchObject({ counts: { active: 1 } });
  });
});
