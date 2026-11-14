import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dist = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/**
 * Run `code` in a fresh child against the built output, with `Queue` and `MemoryStore` in scope. The test
 * code's own timers are unref'd, so only SureQ's timers can keep the child alive.
 */
function child(code: string): { out: string; status: number | null; signal: string | null } {
  const src = `import { Queue, MemoryStore } from ${JSON.stringify(dist)};\nconst silent = { debug() {}, info() {}, warn() {}, error() {} };\n${code}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 20_000 });
  if (r.stderr) console.error(r.stderr);
  return { out: r.stdout, status: r.status, signal: r.signal };
}

describe('runtime: timers and the process', { timeout: 60_000 }, () => {
  it('runtime: an idle Queue without worker or scheduler does not keep the process alive', () => {
    const r = child(`
      const q = new Queue('q', { logger: silent });
      await q.add({ n: 1 });
      await q.health();
      console.log('added');`);
    expect(r).toEqual({ out: 'added\n', status: 0, signal: null });
  });

  it('runtime: a running worker keeps the process alive and a closed one lets it exit', () => {
    const r = child(`
      const q = new Queue('q', { logger: silent });
      const w = q.process(async () => {});
      setTimeout(() => console.log('still alive'), 300).unref();
      setTimeout(() => void w.close().then(() => console.log('closed')), 500).unref();`);
    expect(r).toEqual({ out: 'still alive\nclosed\n', status: 0, signal: null });
  });

  it("runtime: sweeper, retention, registry heartbeat and alert timers are unref'd", () => {
    const r = child(`
      const refd = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;
      const q = new Queue('q', {
        logger: silent, retention: { interval: '1s' }, alerts: { interval: '1s', depth: { above: 1000 } },
      });
      await q.add({});
      console.log('queue', refd());
      const w = q.process(async () => {}, { sweepInterval: '500ms', heartbeatInterval: '1s' });
      setTimeout(() => {
        // Once the sweeper, heartbeat and alerts have all run, only the poll loop's wait and the scheduler loop are ref'd.
        console.log('worker', refd());
        void w.close();
      }, 1500).unref();`);
    expect(r).toEqual({ out: 'queue 0\nworker 2\n', status: 0, signal: null });
  });

  it('runtime: a pending add with a never-settling filter keeps the process alive until the filter timeout', () => {
    const r = child(`
      const q = new Queue('q', { logger: silent, filter: () => new Promise(() => {}), filterTimeoutMs: 300 });
      await q.add({}).catch((e) => console.log(e.code));`);
    expect(r).toEqual({ out: 'FILTER_ERROR\n', status: 0, signal: null });
  });

  it('runtime: health() against a store whose now() hangs keeps the process alive until its timeout', () => {
    const r = child(`
      const inner = new MemoryStore();
      let hang = false;
      const store = new Proxy(inner, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== 'function') return v;
          if (prop === 'now') return (...args) => (hang ? new Promise(() => {}) : v.apply(target, args));
          return v.bind(target);
        },
      });
      const q = new Queue('q', { logger: silent, store });
      await q.add({});
      hang = true;
      const h = await q.health({ timeoutMs: 300 });
      console.log('health', h.store.ok);`);
    expect(r).toEqual({ out: 'health false\n', status: 0, signal: null });
  });

  it("runtime: reconnect backoff with a pending add is ref'd", () => {
    const r = child(`
      const inner = new MemoryStore();
      let down = false;
      const store = new Proxy(inner, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if (typeof v !== 'function') return v;
          if (prop === 'subscribe' || prop === 'close') return v.bind(target);
          return (...args) => (down ? Promise.reject(new TypeError('down')) : v.apply(target, args));
        },
      });
      const q = new Queue('q', { logger: silent, store, onDisconnected: 'wait', maxWait: '60s', reconnect: { initialDelay: 50, maxDelay: 100 } });
      await q.add({});
      down = true;
      setTimeout(() => (down = false), 300).unref();
      const { job } = await q.add({});
      console.log('added', typeof job.id);`);
    expect(r).toEqual({ out: 'added string\n', status: 0, signal: null });
  });
});
