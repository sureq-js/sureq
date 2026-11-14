import type { Queue } from '../../src/queue/queue.js';
import type { NewJob, Scope, Store } from '../../src/store/contract.js';
import { newJob } from './store.js';

export { newJob };

/** Add `count` jobs straight into a queue's scope, bypassing `queue.add`. Returns their ids. */
export async function seed(queue: Queue, count = 1, over: Partial<NewJob> = {}): Promise<string[]> {
  const jobs = Array.from({ length: count }, () => newJob({ data: '{}', ...over }));
  await queue.internals.client.call('add', queue.internals.scope, jobs);
  return jobs.map((j) => j.id);
}

/** The minimal store surface the isolation checks use. */
export type IsolationStore = Pick<Store, 'add' | 'get' | 'counts' | 'claim' | 'remove'>;

/** A deliberately broken store that ignores the namespace (every scope collapses to namespace 'x'). */
export class NamespaceBlindStore implements IsolationStore {
  constructor(private readonly inner: IsolationStore) {}
  #blind = (s: Scope): Scope => ({ namespace: 'x', queue: s.queue });
  add: IsolationStore['add'] = (s, jobs) => this.inner.add(this.#blind(s), jobs);
  get: IsolationStore['get'] = (s, id) => this.inner.get(this.#blind(s), id);
  counts: IsolationStore['counts'] = (s) => this.inner.counts(this.#blind(s));
  claim: IsolationStore['claim'] = (s, req) => this.inner.claim(this.#blind(s), req);
  remove: IsolationStore['remove'] = (s, req) => this.inner.remove(this.#blind(s), req);
}
