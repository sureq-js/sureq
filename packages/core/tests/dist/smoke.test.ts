import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PRODUCER_NAMES, PUBLIC_NAMES } from '../public-names.js';

// Runs against the built output in dist/ regardless of SUREQ_TARGET, in a fresh child process.
const run = (code: string): string =>
  execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
const expected = JSON.stringify([...PUBLIC_NAMES].sort()) + '\n';

describe('pkg', { timeout: 90_000 }, () => {
  it('pkg: ESM import resolves from dist', () => {
    expect(run(`import('./dist/index.js').then(m => console.log(JSON.stringify(Object.keys(m).sort())))`)).toBe(expected);
  });

  it('pkg: CJS require resolves from dist', () => {
    expect(run(`console.log(JSON.stringify(Object.keys(require('./dist/index.cjs')).sort()))`)).toBe(expected);
  });

  it('runtime: package exports resolve under both ESM import and CJS require', () => {
    // through the package name, so the exports map picks the file for each condition
    expect(run(`import('@sureq/core').then(m => console.log(typeof m.Queue, import.meta.resolve('@sureq/core').endsWith('/dist/index.js')))`)).toBe('function true\n');
    expect(run(`console.log(typeof require('@sureq/core').Queue, require.resolve('@sureq/core').endsWith('/dist/index.cjs'))`)).toBe('function true\n');
  });

  it('runtime: without a process global the package imports, and constructing a Queue or a Producer throws UnsupportedRuntimeError', () => {
    // the probe keeps its own handle on process to report, then removes the global before loading the package
    const probe = (load: string) => `
      const p = globalThis.process; delete globalThis.process;
      Promise.resolve().then(() => ${load}).then((m) => {
        const make = (f) => { try { f(); return 'no throw'; } catch (e) { return e instanceof m.UnsupportedRuntimeError ? e.code : String(e); } };
        const q = make(() => new m.Queue('q'));
        const pr = make(() => new m.Producer('q', { store: new m.MemoryStore() }));
        p.stdout.write('imported ' + q + ' ' + pr + '\\n');
      }, (e) => p.stdout.write('import failed ' + e.code + '\\n'));`;
    expect(run(probe(`import('./dist/index.js')`))).toBe('imported UNSUPPORTED_RUNTIME UNSUPPORTED_RUNTIME\n');
    expect(run(probe(`require('./dist/index.cjs')`))).toBe('imported UNSUPPORTED_RUNTIME UNSUPPORTED_RUNTIME\n');
  });

  it('pkg: importing sureq creates no timers, handles or process listeners', () => {
    const probe = `
      const snap = () => JSON.stringify([process.getActiveResourcesInfo(),
        ['uncaughtException','unhandledRejection','exit','beforeExit','SIGINT','SIGTERM'].map(e => process.listenerCount(e))]);
      const a = snap(); import('./dist/index.js').then(() => console.log(a === snap()));`;
    expect(run(probe)).toBe('true\n');
  });

  it('pkg: importing the producer entry creates no timers, handles or process listeners', () => {
    const probe = `
      const snap = () => JSON.stringify([process.getActiveResourcesInfo(),
        ['uncaughtException','unhandledRejection','exit','beforeExit','SIGINT','SIGTERM'].map(e => process.listenerCount(e))]);
      const a = snap(); import('./dist/producer.js').then((m) => console.log(a === snap(), JSON.stringify(Object.keys(m).sort())));`;
    expect(run(probe)).toBe(`true ${JSON.stringify([...PRODUCER_NAMES].sort())}\n`);
  });
});
