/* eslint-disable @typescript-eslint/no-empty-object-type -- Jsonify maps Map and Set to {} */
import { expectTypeOf, test } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import type { AddResult, Job, Schedule, Worker } from '../../src/index.js';

type Reminder = { sendAt: Date; tags: Set<string> };

test('jsonify-read: the handler reads job data as JSON gives it back (the dev.to report)', () => {
  const q = new Queue<Reminder>('q');
  void q.add({ sendAt: new Date(), tags: new Set(['vip']) });
  q.process(async (job) => {
    expectTypeOf(job.data).toEqualTypeOf<{ sendAt: string; tags: {} }>();
    // @ts-expect-error sendAt is stored as an ISO string, which has no getTime
    job.data.sendAt.getTime();
    void new Date(job.data.sendAt);
  });
});

test('jsonify-read: results read back in the job, the completed events and getJob', async () => {
  const q = new Queue<{ n: number }, { at: Date }>('q');
  const worker = q.process(async () => ({ at: new Date() }));
  q.on('completed', ({ result, job }) => {
    expectTypeOf(result).toEqualTypeOf<{ at: string }>();
    expectTypeOf(job.result).toEqualTypeOf<{ at: string } | null | undefined>();
  });
  worker.on('completed', ({ result }) => {
    expectTypeOf(result).toEqualTypeOf<{ at: string }>();
  });
  const job = await q.getJob('id');
  expectTypeOf(job!.result).toEqualTypeOf<{ at: string } | null | undefined>();
  expectTypeOf(job!.data).toEqualTypeOf<{ n: number }>();
});

test('jsonify-read: the filter and onDuplicate see the stored data; a merge may return the original type', () => {
  const q = new Queue<{ at: Date }>('q', {
    filter: (data) => {
      expectTypeOf(data.at).toEqualTypeOf<string>();
      return true;
    },
  });
  void q.add({ at: new Date() }, {
    id: 'x',
    onDuplicate: (existing, incoming) => {
      expectTypeOf(existing.data.at).toEqualTypeOf<string>();
      expectTypeOf(incoming.at).toEqualTypeOf<string>();
      return { at: new Date() };
    },
  });
});

test('jsonify-read: a schedule takes the original type and reads back its JSON', async () => {
  const q = new Queue<{ at: Date }>('q');
  const { schedule } = await q.upsertSchedule('k', { every: '1m', template: { data: { at: new Date() } } });
  expectTypeOf(schedule.template.data.at).toEqualTypeOf<string>();
});

test('jsonify-read: named jobs read their data and results as JSON', () => {
  const q = new Queue<unknown, unknown, { send: { data: { at: Date }; result: { d: Date } } }>('q');
  q.process({
    send: async (job) => {
      expectTypeOf(job.data.at).toEqualTypeOf<string>();
      return { d: new Date() };
    },
  });
});

test('jsonify-read: D inferred from the filter is unchanged', () => {
  const q = new Queue('q', { filter: (d: { n: number }) => d.n > 0 });
  q.process(async (job) => {
    expectTypeOf(job.data).toEqualTypeOf<{ n: number }>();
  });
});

test('jsonify-read: typed jobs, results, workers and schedules stay assignable to their defaults', async () => {
  const q = new Queue<{ at: Date }, { ok: boolean }>('q');
  const job = (await q.getJob('id'))!;
  const asDefault: Job = job;
  const generic = <D, R>(j: Job<D, R>): Job => j;
  const added: AddResult = await q.add({ at: new Date() });
  const worker: Worker = q.process(async () => ({ ok: true }));
  const { schedule } = await q.upsertSchedule('k', { every: '1m', template: { data: { at: new Date() } } });
  const sched: Schedule = schedule;
  void [asDefault, generic(job), added, worker, sched];
});

test('jsonify-read: a queue of a recursive JSON type passes job.data on as that type', () => {
  type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
  type Evt = { type: string; payload: Json; extra: unknown };
  const q = new Queue<Evt>('q');
  const handle = (e: Evt): string => e.type;
  q.process(async (job) => {
    const j: Json = job.data.payload;
    void [j, handle(job.data)];
  });
});
