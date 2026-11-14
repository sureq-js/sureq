// what a retryIf predicate costs. Run: npx tsx bench/retry-if-latency.ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateRetryIf } from '../src/retry/decide.js';
import type { Job } from '../src/job/job.js';

const CALLS = 1_000;
const BATCH = 100; // calls in flight at once, so the 500 ms case finishes in seconds
const job = { id: 'j', name: null, data: { n: 1 }, attempt: 1, maxAttempts: 3 } as unknown as Job;
const err = Object.assign(new TypeError('upstream'), { status: 503 });

const server = createServer((req, res) => {
  const ms = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('ms'));
  setTimeout(() => res.end('true'), ms);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;

async function measure(label: string, retryIf: (e: Error) => boolean | Promise<boolean>): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < CALLS; i += BATCH) {
    await Promise.all(
      Array.from({ length: BATCH }, async () => {
        const t = performance.now();
        await evaluateRetryIf(retryIf, err, job);
        times.push(performance.now() - t);
      }),
    );
  }
  times.sort((a, b) => a - b);
  const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(3);
  console.log(`${label} | ${p(0.5)} | ${p(0.99)}`);
}

console.log('predicate | p50 ms | p99 ms');
await measure('sync status check', (e) => (e as unknown as { status: number }).status >= 500);
for (const ms of [5, 500]) {
  await measure(`awaits HTTP ${ms} ms`, async () => (await (await fetch(`http://127.0.0.1:${port}/?ms=${ms}`)).text()) === 'true');
}
server.close();
