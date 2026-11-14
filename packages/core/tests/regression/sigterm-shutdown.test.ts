import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('../fixtures/sigterm-worker.ts', import.meta.url));

type Report = { name: string; state: string; attempt: number; crashCount: number; leased: boolean };
type Message = { type: 'ready' } | { type: 'closed'; jobs: Report[]; counts: Record<string, number>; closeMs: number };

describe('regression: shutdown on a real signal', () => {
  // Run twice: plain handlers, and the same jobs through processBatch (a held batch flushed by the signal, a running one).
  it('regression: SIGTERM leaves no lease held and active jobs finish or are released within shutdownTimeout', async () => {
    for (const batch of ['', '1']) await sigterm(batch);
  }, 120_000);
});

const TIMEOUT_MS = 300;
const GRACE_MS = 100;
/** Close may take one more second for the last releases to answer; the margin covers a busy machine. */
const CLOSE_BOUND_MS = TIMEOUT_MS + GRACE_MS + 1000 + 500;

/** Fork the fixture, signal it once every handler runs, and check the final store state it reports. */
async function sigterm(batch: string): Promise<void> {
  const child = fork(fixture, [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, SHUTDOWN_TIMEOUT_MS: String(TIMEOUT_MS), SHUTDOWN_GRACE_MS: String(GRACE_MS), BATCH: batch },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  // a child that never reports is killed, and its exit fails the test instead of hanging the run
  const guard = setTimeout(() => child.kill('SIGKILL'), 50_000);
  const closed = new Promise<Extract<Message, { type: 'closed' }>>((resolve, reject) => {
    child.on('exit', (code, signal) => reject(new Error(`child exited (${code ?? signal}) before reporting`)));
    child.on('message', (m: Message) => {
      if (m.type === 'ready') {
        child.kill('SIGTERM');
      } else resolve(m);
    });
  });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  let report: Extract<Message, { type: 'closed' }>;
  try {
    report = await closed;
    expect(await exited).toBe(0);
  } finally {
    // never leave the child behind, whatever failed
    clearTimeout(guard);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  // the child times its own close, from the signal to the queue's closed event
  expect(report.closeMs, `BATCH=${batch}`).toBeGreaterThan(TIMEOUT_MS);
  expect(report.closeMs, `BATCH=${batch}`).toBeLessThan(CLOSE_BOUND_MS);
  expect(report.counts['active'], `BATCH=${batch}`).toBe(0);
  // read from the store after the queue closed: no job of any kind still holds a lease
  expect(report.jobs.filter((j) => j.leased), `BATCH=${batch}`).toEqual([]);
  const byName = (name: string) => report.jobs.filter((j) => j.name === name);
  expect(byName('quick')).toEqual([expect.objectContaining({ state: 'completed' })]);
  for (const name of ['cooperative', 'stubborn']) {
    expect(byName(name), name).toEqual([{ name, state: 'waiting', attempt: 0, crashCount: 0, leased: false }]);
  }
  expect(byName('idle')).toEqual([
    expect.objectContaining({ state: 'waiting', attempt: 0 }),
    expect.objectContaining({ state: 'waiting', attempt: 0 }),
  ]);
}
