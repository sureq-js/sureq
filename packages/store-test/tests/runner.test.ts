import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { detectRunner } from '../src/runner.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runner', () => {
  it('suite: runner is detected from the environment', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_TEST_CONTEXT', '');
    let err: unknown;
    try {
      detectRunner();
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'INVALID_OPTION', issues: [{ path: 'runner' }] });

    const calls: string[] = [];
    vi.stubGlobal('jest', {});
    vi.stubGlobal('describe', (n: string) => calls.push(`describe ${n}`));
    vi.stubGlobal('it', (n: string) => calls.push(`it ${n}`));
    vi.stubGlobal('beforeAll', () => calls.push('beforeAll'));
    vi.stubGlobal('afterAll', () => calls.push('afterAll'));
    const r = detectRunner();
    r.describe('d', () => {});
    r.it('t', () => {});
    r.before(() => {});
    r.after(() => {});
    expect(calls).toEqual(['describe d', 'it t', 'beforeAll', 'afterAll']);
  });

  it('suite: jest is detected as it really runs: JEST_WORKER_ID and the hook globals, no global jest object', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_TEST_CONTEXT', '');
    vi.stubEnv('JEST_WORKER_ID', '1');
    // jest injects `jest` into each test file's scope, not onto globalThis
    vi.stubGlobal('jest', undefined);
    const calls: string[] = [];
    vi.stubGlobal('describe', (n: string) => calls.push(`describe ${n}`));
    vi.stubGlobal('it', (n: string) => calls.push(`it ${n}`));
    vi.stubGlobal('beforeAll', () => calls.push('beforeAll'));
    vi.stubGlobal('afterAll', () => calls.push('afterAll'));
    const r = detectRunner();
    r.describe('d', () => {});
    r.it('t', () => {});
    r.before(() => {});
    r.after(() => {});
    expect(calls).toEqual(['describe d', 'it t', 'beforeAll', 'afterAll']);
  });

  it('suite: fake clock advances and rejects bad input', () => {
    const c = new FakeClock(5);
    expect(c.now()).toBe(5);
    c.advance(10);
    expect(c.now()).toBe(15);
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advance(1.5)).toThrow(RangeError);
    expect(new FakeClock().now()).toBe(1_700_000_000_000);
  });
});
