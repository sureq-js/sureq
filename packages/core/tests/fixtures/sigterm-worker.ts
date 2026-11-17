// Run in a child process by the SIGTERM regression test. The child owns its MemoryStore (one cannot be
// shared across processes) and reports the store's final state to the parent over IPC.
import { MemoryStore, Queue } from '../../src/index.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const store = new MemoryStore();
const queue = new Queue('sig', {
  store,
  logger: silent,
  signals: ['SIGTERM'],
  shutdownTimeout: Number(process.env['SHUTDOWN_TIMEOUT_MS']),
  shutdownAbortGrace: Number(process.env['SHUTDOWN_GRACE_MS']),
});

// When the signal arrived, so the child can time its own close.
let signalledAt = 0;
const signalled = new Promise<void>((r) => process.once('SIGTERM', () => {
  signalledAt = performance.now();
  r();
}));
// `quick` finishes 100 ms after the signal, well within shutdownTimeout.
const quick = async () => {
  await signalled;
  await new Promise((r) => setTimeout(r, 100));
  return 'done';
};
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));
const NAMES = ['quick', 'cooperative', 'stubborn', 'idle', 'idle'];
const batched = process.env['BATCH'] === '1';

// With BATCH=1 the same five jobs run unnamed through processBatch: one running batch (quick completes early,
// then the handler ignores the abort like `stubborn`) and one held batch of the two `idle` jobs, flushed by the
// signal and given back when its handler stops at the abort.
const worker = batched
  ? queue.processBatch(async (batch, ctx) => {
    const first = batch.jobs[0]!;
    if ((first.data as { name: string }).name === 'idle') return untilAborted(ctx.signal);
    await quick();
    await ctx.complete(first, 'done');
    return new Promise<never>(() => {});
  }, { batchSize: 3, batchDelay: '1h', concurrency: 2, autorun: false })
  : queue.process(
    {
      quick,
      cooperative: (_job, ctx) => untilAborted(ctx.signal),
      stubborn: () => new Promise(() => {}),
      idle: () => 'never runs',
    },
    { concurrency: 3, autorun: false },
  );

let active = 0;
worker.on('active', () => {
  if (++active === 3) {
    // The idle jobs are held (batch mode) once the next claim returns.
    const ready = (): unknown => (!batched || (worker as { batch?: { held: number } }).batch!.held === 2 ? process.send!({ type: 'ready' }) : setTimeout(ready, 10));
    ready();
  }
});

queue.on('closed', async () => {
  // measured in the child: the parent's clock also counts process start-up and IPC under load
  const closeMs = performance.now() - signalledAt;
  const scope = queue.internals.scope;
  const jobs = store.dump().jobs.map((j) => ({
    name: j.name ?? (JSON.parse(j.data as string) as { name: string }).name, state: j.state, attempt: j.attempt, crashCount: j.crashCount, leased: j.lease !== null,
  }));
  const counts = await store.counts(scope);
  process.send!({ type: 'closed', jobs, counts, closeMs }, () => process.exit(0));
});

for (const name of NAMES) await queue.add(batched ? { name } : null, batched ? {} : { name });
await worker.run();
