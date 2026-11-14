// Run in a child process by the chaos test: one pod whose store is the parent's MemoryStore, reached over IPC
// behind a fault layer that delays calls, fails some, and stalls some forever (before or after the store saw them).
// The parent kills the process with SIGKILL at any moment.
import { MemoryStore, Queue, type Store } from '../../src/index.js';

type Data = { kind: 'work' | 'fail'; ms: number };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

// Only for the contract version and capabilities, which are plain properties the parent cannot send per call.
const ref = new MemoryStore();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;
process.on('message', (m: Reply) => {
  const p = pending.get(m.id);
  pending.delete(m.id);
  if (m.ok) p?.resolve(m.value);
  else p?.reject(new Error(m.error));
});
process.on('disconnect', () => process.exit(0));
const rpc = (method: string, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send!({ id, method, args });
  });

// 32-bit integer arithmetic, so the generator stays exact
let s = Number(process.env['SEED']);
const random = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 2 ** 31;
// each injected fault is reported at once, so a process killed later has already counted its faults
const injected = (fault: 'error' | 'stallBefore' | 'stallAfter') => void process.send!({ type: 'fault', fault });
const never = () => new Promise<never>(() => {});
const faulty = async (method: string, args: unknown[]): Promise<unknown> => {
  await new Promise((r) => setTimeout(r, Math.floor(random() * 30)));
  const r = random();
  if (r < 0.03) {
    injected('error');
    throw new Error('ECONNRESET');
  }
  if (r < 0.04) {
    injected('stallBefore');
    return never();
  }
  const call = rpc(method, args);
  if (r < 0.05) {
    injected('stallAfter');
    call.catch(() => {});
    return never();
  }
  return call;
};
const store = new Proxy(ref, {
  get(target, key) {
    if (key === 'contractVersion' || key === 'capabilities') return Reflect.get(target, key);
    if (key === 'open' || key === 'close') return async () => {};
    // no wake-ups across processes: the pod polls
    if (key === 'subscribe' || typeof key !== 'string' || typeof Reflect.get(target, key) !== 'function') return undefined;
    return (...args: unknown[]) => faulty(key, args);
  },
}) as Store;

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const queue = new Queue<Data>('ipc', {
  store,
  logger: silent,
  leaseDuration: 1000,
  maxCrashes: 5,
  pollMin: 20,
  pollMax: 100,
  storeCallTimeout: 300,
  retention: { completed: true, failed: true },
});
const worker = queue.process(async (job) => {
  await new Promise((r) => setTimeout(r, job.data.ms));
  if (job.data.kind === 'fail') throw new Error('always fails');
  return job.attempt;
}, { concurrency: 10, sweepInterval: 500 });
worker.on('active', ({ job }) => void process.send!({ type: 'active', id: job.id }));
worker.on('completed', ({ job }) => void process.send!({ type: 'completed', id: job.id }));
worker.on('failed', ({ job }) => void process.send!({ type: 'failed', id: job.id }));
