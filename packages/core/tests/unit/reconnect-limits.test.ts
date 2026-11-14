import { describe, expect, it } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { clientFor } from '../../src/store/client.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { outageStore } from '../helpers/outage.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real timers: Node runs a timer longer than 2^31 - 1 ms after 1 ms, which fake timers need not copy.
describe('reconnect: delays past the timer limit', () => {
  it('reconnect: a probe delay longer than the timer limit waits instead of probing every millisecond', async () => {
    const { store, ctl } = outageStore(new MemoryStore());
    const client = clientFor(store);
    client.configure({ initialDelayMs: 2 ** 31, maxDelayMs: 2 ** 32, factor: 2, jitter: 0.2, random: () => 1 });
    const q = new Queue('r', { store, logger: silent });
    await q.ready();
    ctl.down = true;
    await q.getCounts().catch(() => {});
    expect(q.connectionState).toBe('reconnecting');
    ctl.calls.length = 0;
    await sleep(100);
    expect(ctl.calls.filter((c) => c.op === 'now' || c.op === 'open')).toEqual([]);
    await q.close({ timeoutMs: 0 });
  });

  it('reconnect: initialDelay and maxDelay above the timer limit are refused', () => {
    const make = (reconnect: object) => () => new Queue('r', { store: new MemoryStore(), logger: silent, reconnect });
    expect(make({ maxDelay: 2 ** 31 })).toThrow(expect.objectContaining({ code: 'INVALID_OPTION', issues: [expect.objectContaining({ path: 'reconnect.maxDelay', code: 'out_of_range' })] }));
    expect(make({ initialDelay: 2 ** 31, maxDelay: 2 ** 31 })).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
    expect(make({ maxDelay: 2 ** 31 - 1 })).not.toThrow();
  });
});
