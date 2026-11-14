import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PauseEvent } from '../../src/queue/pause.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
});

describe('regression: pause events', () => {
  it('regression: pause and resume emit events and isPaused reflects them', async () => {
    const store = new MemoryStore();
    const a = new Queue('r', { store, logger: silent, notify: false, ...poll(20) });
    const b = new Queue('r', { store, logger: silent, notify: false, ...poll(20) });
    queues.push(a, b);
    const ran = vi.fn();
    const w = b.process(ran);
    const seen: string[] = [];
    const tag = (who: string) => (e: PauseEvent) => void seen.push(`${who}:${e.scope}:${e.source}`);
    for (const [who, em] of [['a', a], ['b', b]] as const) {
      em.on('paused', tag(`${who}+`));
      em.on('resumed', tag(`${who}-`));
    }
    w.on('paused', tag('w+'));
    w.on('resumed', tag('w-'));
    await w.pause();
    expect([w.isPaused(), w.isPaused('local'), b.isPaused()]).toEqual([true, true, false]);
    await a.pause();
    await a.add(1);
    w.resume();
    await vi.waitFor(() => expect(b.isPaused()).toBe(true));
    expect([w.isPaused(), w.isPaused('global')]).toEqual([true, true]);
    expect(ran).not.toHaveBeenCalled();
    await a.resume();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
    expect([a.isPaused(), b.isPaused(), w.isPaused()]).toEqual([false, false, false]);
    expect(seen).toEqual([
      'w+:local:self', 'a+:global:self', 'w-:local:self', 'b+:global:observed', 'w+:global:observed',
      'a-:global:self', 'b-:global:observed', 'w-:global:observed',
    ]);
  });
});
