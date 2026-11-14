import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '../../src/events/types.js';
import type { PauseEvent } from '../../src/queue/pause.js';
import type { QueueOptions } from '../../src/queue/options.js';
import { Queue } from '../../src/queue/queue.js';
import { MemoryStore } from '../../src/store/memory/memory-store.js';
import { silent } from '../helpers/harness.js';
import { poll } from '../helpers/poll.js';
import { spyStore } from '../helpers/spy-store.js';

const queues: Queue[] = [];
afterEach(async () => {
  await Promise.allSettled(queues.splice(0).map((q) => q.close({ timeoutMs: 0 })));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL = 20;

function setup() {
  const store = new MemoryStore();
  const pod = (opts: QueueOptions = {}) => {
    const q = new Queue('e', { store, logger: silent, notify: false, ...poll(POLL), ...opts });
    queues.push(q);
    return q;
  };
  return { store, pod };
}

/** Every `paused`/`resumed` payload of an emitter, tagged with its name. */
function record(emitter: { on(e: 'paused' | 'resumed', fn: (p: PauseEvent) => void): unknown }) {
  const seen: Array<{ type: string } & PauseEvent> = [];
  emitter.on('paused', (p) => void seen.push({ type: 'paused', ...p }));
  emitter.on('resumed', (p) => void seen.push({ type: 'resumed', ...p }));
  return seen;
}

/** A pod whose next claim answer (its write already applied) can be held until released. */
function heldPod() {
  const inner = new MemoryStore();
  let held: { reached: () => void; gate: Promise<void> } | undefined;
  const { store } = spyStore(inner, {
    claim: async (sc, r) => {
      const res = await inner.claim(sc, r);
      const h = held;
      held = undefined;
      if (h) {
        h.reached();
        await h.gate;
      }
      return res;
    },
  });
  const q = new Queue('e', { store, logger: silent, notify: false, ...poll(POLL) });
  queues.push(q);
  const hold = () => {
    let reached!: () => void;
    let release!: () => void;
    const r = new Promise<void>((res) => (reached = res));
    held = { reached, gate: new Promise<void>((res) => (release = res)) };
    return { reached: r, release };
  };
  return { q, hold };
}

describe('pause-events', () => {
  it('pause-events: a claim answered across resume does not undo it', async () => {
    const { q, hold } = heldPod();
    await q.pause();
    await q.add(1);
    const ran = vi.fn();
    const w = q.process(ran, { autorun: false });
    const seen = record(q);
    const held = hold();
    void w.run();
    await held.reached;
    await q.resume();
    expect(q.isPaused()).toBe(false);
    held.release();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
    await sleep(POLL * 3);
    expect(seen.map((e) => [e.type, e.source])).toEqual([['resumed', 'self']]);
    expect(q.isPaused()).toBe(false);
  });

  it('pause-events: a claim answered across pause does not undo it', async () => {
    const { q, hold } = heldPod();
    await q.add(1);
    const w = q.process(() => {}, { autorun: false });
    const seen = record(q);
    const held = hold();
    void w.run();
    await held.reached;
    await q.pause();
    held.release();
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    await sleep(POLL * 3);
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'self']]);
    expect(q.isPaused()).toBe(true);
  });

  it('pause-events: worker.pause emits paused once with scope local and source self', async () => {
    const { pod } = setup();
    const q = pod();
    const w = q.process(() => {});
    const seen = record(w);
    const onQueue = record(q);
    await w.pause();
    expect(seen).toEqual([{ type: 'paused', scope: 'local', source: 'self', queue: 'e', workerId: w.id, at: expect.any(Number) }]);
    w.resume();
    expect(seen.map((e) => [e.type, e.scope, e.source])).toEqual([['paused', 'local', 'self'], ['resumed', 'local', 'self']]);
    expect(onQueue).toEqual([]);
  });

  it('pause-events: no-op pause and resume emit nothing', async () => {
    const { pod } = setup();
    const q = pod();
    const w = q.process(() => {});
    const sw = record(w);
    const sq = record(q);
    w.resume();
    await q.resume();
    await w.pause();
    await w.pause();
    await q.pause();
    await q.pause();
    expect(sw.map((e) => [e.type, e.scope])).toEqual([['paused', 'local'], ['paused', 'global']]);
    expect(sq.map((e) => [e.type, e.scope])).toEqual([['paused', 'global']]);
  });

  it('pause-events: queue.pause emits global paused on the queue and its workers in this pod', async () => {
    const { pod } = setup();
    const q = pod();
    const a = q.process({ a: () => {} });
    const b = q.process({ b: () => {} });
    const [sq, sa, sb] = [record(q), record(a), record(b)];
    await q.pause();
    expect(sq).toEqual([{ type: 'paused', scope: 'global', source: 'self', queue: 'e', at: expect.any(Number) }]);
    expect(sa).toEqual([{ type: 'paused', scope: 'global', source: 'self', queue: 'e', workerId: a.id, at: expect.any(Number) }]);
    expect(sb).toEqual([{ type: 'paused', scope: 'global', source: 'self', queue: 'e', workerId: b.id, at: expect.any(Number) }]);
  });

  it('pause-events: changed false emits nothing', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    await a.pause();
    const seen = record(b);
    expect(await b.pause()).toEqual({ changed: false });
    expect(seen).toEqual([]);
    expect(b.isPaused()).toBe(true);
  });

  it('pause-events: another pod observes global pause and emits paused with source observed', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    const w = b.process(() => {});
    const [sq, sw] = [record(b), record(w)];
    await a.pause();
    await a.add(1);
    await vi.waitFor(() => expect(sw).toHaveLength(1));
    await sleep(POLL * 3);
    expect(sq.map((e) => [e.type, e.scope, e.source])).toEqual([['paused', 'global', 'observed']]);
    expect(sw.map((e) => [e.type, e.scope, e.source, e.workerId])).toEqual([['paused', 'global', 'observed', w.id]]);
  });

  it('pause-events: another pod observes global resume and emits resumed with source observed', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    const ran = vi.fn();
    const w = b.process(ran);
    const seen = record(b);
    await a.pause();
    await a.add(1);
    await vi.waitFor(() => expect(b.isPaused()).toBe(true));
    await a.resume();
    await vi.waitFor(() => expect(ran).toHaveBeenCalledOnce());
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'observed'], ['resumed', 'observed']]);
    expect(w.isPaused()).toBe(false);
  });

  it('pause-events: a pod whose claims return nothing still observes the resume', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    b.process(() => {}, { pollMax: 100 });
    const seen = record(b);
    await a.pause();
    const { job } = await a.add(1);
    await vi.waitFor(() => expect(b.isPaused()).toBe(true));
    await a.remove(job.id);
    await a.resume();
    await vi.waitFor(() => expect(b.isPaused()).toBe(false));
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'observed'], ['resumed', 'observed']]);
  });

  it('pause-events: two observations of the same state emit one event', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    b.process(() => {});
    const seen = record(b);
    await a.pause();
    await a.add(1);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await b.pauseState();
    await b.pauseState();
    await sleep(POLL * 3);
    expect(seen).toHaveLength(1);
  });

  it('pause-events: first observation of an already paused queue emits one paused', async () => {
    const { pod } = setup();
    const a = pod();
    await a.pause();
    const b = pod();
    const seen = record(b);
    expect(await b.pauseState()).toEqual({ paused: true });
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'observed']]);
  });

  it('pause-events: first observation of an unpaused queue emits nothing', async () => {
    const { pod } = setup();
    const b = pod();
    b.process(() => {});
    const seen = record(b);
    expect(await b.pauseState()).toEqual({ paused: false });
    await b.add(1);
    await sleep(POLL * 3);
    expect(seen).toEqual([]);
  });

  it('pause-events: isPaused is true synchronously inside pause and false inside resume', async () => {
    const { pod } = setup();
    const q = pod();
    const w = q.process(() => {});
    const pausing = w.pause();
    expect(w.isPaused()).toBe(true);
    await pausing;
    w.resume();
    expect(w.isPaused()).toBe(false);
    // The global flag changes once the store has answered, before the call resolves.
    let seen: boolean | undefined;
    q.once('paused', () => void (seen = q.isPaused()));
    await q.pause();
    expect([seen, q.isPaused()]).toEqual([true, true]);
    await q.resume();
    expect(q.isPaused()).toBe(false);
  });

  it('pause-events: getter is updated before the event is emitted', async () => {
    const { pod } = setup();
    const q = pod();
    const w = q.process(() => {});
    const reads: Array<[string, boolean]> = [];
    w.on('paused', (e) => void reads.push([`w:${e.scope}`, w.isPaused(e.scope)]));
    w.on('resumed', (e) => void reads.push([`w:${e.scope}`, w.isPaused(e.scope)]));
    q.on('paused', () => void reads.push(['q', q.isPaused()]));
    q.on('resumed', () => void reads.push(['q', q.isPaused()]));
    await w.pause();
    w.resume();
    await q.pause();
    await q.resume();
    expect(reads).toEqual([['w:local', true], ['w:local', false], ['q', true], ['w:global', true], ['q', false], ['w:global', false]]);
  });

  it('pause-events: global resume with local pause keeps worker.isPaused true', async () => {
    const { pod } = setup();
    const q = pod();
    const w = q.process(() => {});
    await w.pause();
    await q.pause();
    await q.resume();
    expect([w.isPaused(), w.isPaused('local'), w.isPaused('global')]).toEqual([true, true, false]);
  });

  it('pause-events: throwing listener does not break pause or other listeners', async () => {
    const { pod } = setup();
    const q = pod();
    const errors: ErrorEvent[] = [];
    q.on('error', (e) => void errors.push(e));
    q.on('paused', () => {
      throw new TypeError('listener broke');
    });
    const second = vi.fn();
    q.on('paused', second);
    expect(await q.pause()).toEqual({ changed: true });
    expect(second).toHaveBeenCalledOnce();
    expect(errors).toEqual([expect.objectContaining({ source: 'listener' })]);
  });

  it('pause-events: no events after close begins', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const w = b.process(() => gate);
    const started = new Promise((r) => w.once('active', r));
    await b.add(1);
    await started;
    const [sq, sw] = [record(b), record(w)];
    const closing = b.close();
    await expect(b.pause()).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    await a.pause();
    expect(await b.pauseState()).toEqual({ paused: true });
    expect(() => w.resume()).toThrow();
    open();
    await closing;
    expect([sq, sw]).toEqual([[], []]);
  });

  it('pause-events: a claim sent after a self resume that finds the queue paused applies and emits paused observed', async () => {
    const { pod } = setup();
    const a = pod();
    const b = pod();
    await a.pause();
    await a.resume();
    const w = a.process(() => {});
    const seen = record(a);
    await b.pause();
    await a.add(1);
    await vi.waitFor(() => expect(a.isPaused()).toBe(true));
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'observed']]);
    expect(w.inFlight).toBe(0);
  });

  it('pause-events: a claim sent during a pause but ordered before it applies shows no phantom resume', async () => {
    const inner = new MemoryStore();
    const gate = () => {
      let open!: () => void;
      let reached!: () => void;
      const at = new Promise<void>((r) => (reached = r));
      return { at, reached, wait: new Promise<void>((r) => (open = r)), open };
    };
    let pausing: ReturnType<typeof gate> | undefined;
    let claiming: ReturnType<typeof gate> | undefined;
    const { store } = spyStore(inner, {
      // the pause waits before it applies, the claim after it applied
      setPaused: async (sc, p) => {
        const g = pausing;
        pausing = undefined;
        if (g) {
          g.reached();
          await g.wait;
        }
        return inner.setPaused(sc, p);
      },
      claim: async (sc, r) => {
        const res = await inner.claim(sc, r);
        const g = claiming;
        claiming = undefined;
        if (g) {
          g.reached();
          await g.wait;
        }
        return res;
      },
    });
    const q = new Queue('e', { store, logger: silent, notify: false, ...poll(POLL) });
    queues.push(q);
    await q.add(1);
    const w = q.process(() => {}, { autorun: false });
    const seen = record(q);
    pausing = gate();
    const p = pausing;
    const pause = q.pause();
    await p.at;
    claiming = gate();
    const c = claiming;
    void w.run();
    await c.at; // the store handed out the job before the pause applied
    p.open();
    await pause;
    c.open();
    await vi.waitFor(() => expect(w.inFlight).toBe(0));
    await sleep(POLL * 3);
    expect(seen.map((e) => [e.type, e.source])).toEqual([['paused', 'self']]);
    expect(q.isPaused()).toBe(true);
  });

  it('pause-events: pauseState answers the newer flag when its own read was overtaken', async () => {
    const inner = new MemoryStore();
    let held: { reached: () => void; gate: Promise<void> } | undefined;
    const { store } = spyStore(inner, {
      isPaused: async (sc) => {
        const res = await inner.isPaused(sc);
        const h = held;
        held = undefined;
        if (h) {
          h.reached();
          await h.gate;
        }
        return res;
      },
    });
    const q = new Queue('e', { store, logger: silent, notify: false });
    queues.push(q);
    await q.pause();
    let reached!: () => void;
    let release!: () => void;
    const r = new Promise<void>((res) => (reached = res));
    held = { reached, gate: new Promise<void>((res) => (release = res)) };
    const state = q.pauseState();
    await r;
    await q.resume();
    release();
    expect(await state).toEqual({ paused: false });
    expect(q.isPaused()).toBe(false);
  });
});
