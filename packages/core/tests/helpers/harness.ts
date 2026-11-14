import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { Queue } from '../../src/queue/queue.js';
import type { QueueOptions } from '../../src/queue/options.js';

export const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A queue on its own MemoryStore with a hand-driven store clock. */
export function harness(opts: { queue?: QueueOptions } = {}) {
  const clock = {
    now: 1_000_000,
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const raw = new MemoryStore({ clock: () => clock.now });
  const queue = new Queue('h', { logger: silent, ...opts.queue, store: raw });
  return { raw, queue, clock };
}

type Emitter = { on(event: string, fn: (payload: unknown) => void): unknown; once(event: string, fn: (payload: unknown) => void): unknown };

/** Resolve with the next payload of `event` from a Queue or Worker. */
export function next<P = Record<string, unknown>>(emitter: object, event: string): Promise<P> {
  return new Promise<P>((r) => (emitter as Emitter).once(event, (p) => r(p as P)));
}

/** Resolve after `n` payloads of `event`, with all of them. */
export function collect<P = Record<string, unknown>>(emitter: object, event: string, n: number): Promise<P[]> {
  const seen: P[] = [];
  return new Promise<P[]>((r) => (emitter as Emitter).on(event, (p) => void (seen.push(p as P) === n && r(seen))));
}
