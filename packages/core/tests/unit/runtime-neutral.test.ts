import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { setPlatformForTest, type Platform } from '../../src/platform/index.js';
import { nodePlatform } from '../../src/platform/node.js';
import { Queue } from '../../src/queue/queue.js';
import { silent } from '../helpers/harness.js';
import { uuidv7 } from '../../src/util/uuidv7.js';

const coreSrc = fileURLToPath(new URL('../../src', import.meta.url));

/** Every `.ts` file under `dir`, except those under `platform/`. */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.split(/[\\/]/).includes('platform'))
    .map((f) => join(dir, f));
}

describe('runtime: core needs only the platform', () => {
  it('runtime: all timers go through platform.setTimer', () => {
    const hits = sources(coreSrc).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        /\b(setTimeout|setInterval|clearTimeout|clearInterval)\(|performance\.now\(/.test(line) ? [`${relative(coreSrc, file)}:${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });

  it('runtime: no node: import outside src/platform in source', () => {
    const hits = sources(coreSrc).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        /\bfrom\s+['"]node:|\b(?:import|require)\(\s*['"]node:/.test(line) ? [`${relative(coreSrc, file)}:${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
  });

  it('runtime: signals are registered only via platform.onSignal', async () => {
    const hits = sources(coreSrc).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        /\bprocess\.(?:on|once|addListener|prependListener)\(/.test(line) ? [`${relative(coreSrc, file)}:${i + 1}: ${line.trim()}`] : []));
    expect(hits).toEqual([]);
    // a worker on a queue with signals listens through the platform, and not on the process directly
    const registered: string[] = [];
    let removed = 0;
    setPlatformForTest({ ...nodePlatform, onSignal: (signal) => (registered.push(signal), () => void removed++) });
    const before = process.listenerCount('SIGTERM');
    try {
      const q = new Queue('q', { logger: silent, signals: ['SIGTERM', 'SIGINT'] });
      q.process(() => 1, { autorun: false });
      expect(registered).toEqual(['SIGTERM', 'SIGINT']);
      expect(process.listenerCount('SIGTERM')).toBe(before);
      await q.close();
      expect(removed).toBe(2);
    } finally {
      setPlatformForTest(undefined);
    }
  });

  it('runtime: UUIDv7 ids are generated without node:crypto', () => {
    expect(readFileSync(join(coreSrc, 'util/uuidv7.ts'), 'utf8')).not.toMatch(/from 'node:/);
    for (let i = 0; i < 100; i++) {
      const id = uuidv7();
      expect(id).toHaveLength(36);
      expect(id[14]).toBe('7');
    }
  });

  it('runtime: core suite passes with Buffer, process and require stubbed away', async () => {
    // setImmediate is stubbed away too. Core is bundled from source with every node: built-in replaced by an empty module; the stub platform
    // is set before the rest of core is evaluated.
    const entry = `
      import { setPlatformForTest } from ${JSON.stringify(join(coreSrc, 'platform/index.ts'))};
      setPlatformForTest(globalThis.stubPlatform);
      globalThis.core = import(${JSON.stringify(join(coreSrc, 'index.ts'))});`;
    const out = await build({
      stdin: { contents: entry, resolveDir: coreSrc, loader: 'ts' },
      bundle: true, write: false, format: 'iife', platform: 'neutral', logLevel: 'silent',
      plugins: [{
        name: 'no-node-builtins',
        setup(b) {
          b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
        },
      }],
    });
    const stubPlatform: Platform = {
      name: 'node',
      monotonicMs: () => performance.now(),
      setTimer(fn, ms, opts) {
        const h = setTimeout(fn, ms);
        if (opts?.ref !== true) h.unref();
        return { cancel: () => clearTimeout(h), ref: () => void h.ref(), unref: () => void h.unref() };
      },
      defer: (fn) => void setImmediate(fn),
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      sha256Hex: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
      onSignal: () => () => {},
      hostname: () => 'stub-host',
      pid: () => 1,
      exit: () => {},
      signalNames: () => ['SIGINT', 'SIGTERM'],
    };
    const ctx = vm.createContext({
      stubPlatform, console, AbortController, AbortSignal, EventTarget, Event, DOMException, TextEncoder, TextDecoder,
      queueMicrotask, structuredClone,
    });
    expect(vm.runInContext('[typeof Buffer, typeof process, typeof require, typeof setTimeout, typeof performance, typeof setImmediate]', ctx)).toEqual(
      ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
    );
    vm.runInContext(out.outputFiles[0]!.text, ctx);
    type Core = typeof import('../../src/index.js');
    const { Queue } = await (ctx['core'] as Promise<Core>);
    const errors: unknown[] = [];
    const q = new Queue<{ n: number }, number>('q', {
      logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => void errors.push(args) },
    });
    try {
      const done = new Promise<unknown>((r) => q.on('completed', (e) => r(e.result)));
      q.process(async (job) => job.data.n + 1);
      const { job } = await q.add({ n: 41 });
      expect(job.id).toHaveLength(36);
      expect(await done).toBe(42);
      expect((await q.getJob(job.id))?.state).toBe('completed');
      // the worker loop keeps running after the first job; a missing runtime API surfaces here
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toEqual([]);
    } finally {
      await q.close();
    }
  });
});
