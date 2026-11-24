import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The gzipped size the minified producer bundle may reach: the measured size plus 10 % at 1.0.0-rc.1 (36 519).
 * 1.0.2 measured 36 399; the 1.0.3 merge, reconnect, logger and serializeError fixes add 278 bytes (36 677), so the
 * budget was raised to 36 864, leaving little headroom: re-measure before the next raise.
 */
export const PRODUCER_BUDGET_BYTES = 36_864;

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
/** Worker-side modules the producer entry must never pull in. */
const FORBIDDEN = [
  'src/worker/', 'src/queue/queue.ts', 'src/scheduler/scheduler.ts', 'src/worker/batch.ts', 'src/metrics/metrics.ts', 'src/metrics/alerts.ts',
  'src/registry/heartbeat.ts', 'src/registry/skew.ts', 'src/format/watch.ts', 'src/store/memory/memory-store.ts', 'src/retention/cleaner.ts',
];

let inputs: string[] = [];
let gzipped = 0;

beforeAll(async () => {
  const r = await build({
    entryPoints: [fileURLToPath(new URL('../../src/producer.ts', import.meta.url))],
    bundle: true, minify: true, format: 'esm', platform: 'node', target: 'node22', write: false, metafile: true, logLevel: 'silent', absWorkingDir: packageRoot,
  });
  inputs = Object.keys(r.metafile.inputs).sort();
  gzipped = gzipSync(r.outputFiles[0]!.contents).length;
  if (process.env['SUREQ_PRINT_BUNDLE'] === '1') {
    const parts = Object.values(r.metafile.outputs)[0]!.inputs;
    const share = Object.entries(parts).filter(([f]) => f.startsWith('src/scheduler/')).reduce((n, [, v]) => n + v.bytesInOutput, 0);
    console.log(`producer bundle: ${gzipped} bytes gzipped (budget ${PRODUCER_BUDGET_BYTES}); src/scheduler/ ${share} bytes minified\n${inputs.join('\n')}`);
  }
}, 60_000);

describe('producer bundle', () => {
  it('producer: entry point module graph does not import worker, sweeper, scheduler loop or batching modules, and does import the cron parser', () => {
    expect(inputs.filter((f) => FORBIDDEN.some((p) => f.startsWith(p)))).toEqual([]);
    expect(inputs).toEqual(expect.arrayContaining(['src/scheduler/cron.ts', 'src/scheduler/interval.ts']));
  });

  it('producer: bundle size stays under the budget', () => {
    expect(gzipped, `producer bundle is ${gzipped} bytes gzipped`).toBeLessThanOrEqual(PRODUCER_BUDGET_BYTES);
  });
});
