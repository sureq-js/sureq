import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { detectPlatform, platform } from '../../src/platform/index.js';
import { UnsupportedRuntimeError, isSureQError } from '../../src/index.js';

const entry = fileURLToPath(new URL('../../src/platform/index.ts', import.meta.url));

/** Run a snippet in a child that has `platform` in scope; returns its stdout once it exits. */
const child = (code: string): string =>
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { platform } from ${JSON.stringify(entry)};\n${code}`], {
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('platform (node)', () => {
  it("platform: setTimer is unref'd by default and ref'd when asked", () => {
    // an unref'd timer does not keep the child alive, so it exits before the timer fires
    expect(child(`platform.setTimer(() => console.log('fired'), 60_000);`)).toBe('');
    expect(child(`platform.setTimer(() => console.log('fired'), 10, { ref: true });`)).toBe('fired\n');
    expect(child(`platform.setTimer(() => console.log('fired'), 60_000, { ref: true }).unref();`)).toBe('');
    expect(child(`platform.setTimer(() => console.log('fired'), 10).ref();`)).toBe('fired\n');
    expect(child(`platform.setTimer(() => console.log('fired'), 10, { ref: true }).cancel();`)).toBe('');
  }, 60_000);

  it('platform: monotonicMs never goes backwards across 1000 reads', () => {
    let last = platform.monotonicMs();
    for (let i = 0; i < 1000; i++) {
      const now = platform.monotonicMs();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('platform: sha256Hex of "abc" equals ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', () => {
    expect(platform.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('platform: randomBytes(16) returns 16 bytes that differ between calls', () => {
    const a = platform.randomBytes(16);
    const b = platform.randomBytes(16);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.byteLength).toBe(16);
    expect(b.byteLength).toBe(16);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('platform: onSignal returns an unsubscribe that removes the listener', () => {
    const before = process.listenerCount('SIGUSR2');
    const off = platform.onSignal('SIGUSR2', () => {});
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
    off();
    expect(process.listenerCount('SIGUSR2')).toBe(before);
  });

  it('platform: defer runs the callback on a later turn, through the setImmediate global read at call time', async () => {
    const order: string[] = [];
    await new Promise<void>((done) => {
      platform.defer(() => {
        order.push('deferred');
        done();
      });
      order.push('sync');
    });
    expect(order).toEqual(['sync', 'deferred']);
    vi.useFakeTimers();
    try {
      let ran = false;
      platform.defer(() => (ran = true));
      expect(ran).toBe(false);
      vi.runAllTimers();
      expect(ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('platform: setTimer works where setTimeout returns a plain number', async () => {
    const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
    const handles = new Map<number, ReturnType<typeof setTimeout>>();
    vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => {
      const id = handles.size + 1;
      handles.set(id, real.set(fn, ms));
      return id;
    });
    vi.stubGlobal('clearTimeout', (id: number) => real.clear(handles.get(id)));
    let fired: Promise<void>;
    let cancelledRan = false;
    try {
      fired = new Promise<void>((done) => {
        const t = platform.setTimer(done, 1);
        t.ref();
        t.unref();
      });
      platform.setTimer(() => (cancelledRan = true), 1, { ref: true }).cancel();
    } finally {
      vi.unstubAllGlobals();
    }
    await fired;
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelledRan).toBe(false);
  });

  it('platform: hostname and pid come from the process', () => {
    expect(platform.name).toBe('node');
    expect(typeof platform.hostname()).toBe('string');
    expect(platform.pid()).toBe(process.pid);
  });

  it('runtime: UnsupportedRuntimeError when no process and no platform available', () => {
    const stub = {} as typeof globalThis;
    expect(() => detectPlatform(stub)).toThrow(UnsupportedRuntimeError);
    try {
      detectPlatform(stub);
    } catch (e) {
      expect(isSureQError(e)).toBe(true);
      expect((e as UnsupportedRuntimeError).code).toBe('UNSUPPORTED_RUNTIME');
    }
    expect(detectPlatform(globalThis).name).toBe('node');
  });
});
