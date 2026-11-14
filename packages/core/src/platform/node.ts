import { createHash } from 'node:crypto';
import { constants, hostname } from 'node:os';
import type { Platform, Timer } from './types.js';

// a runtime whose setTimeout returns a number has no ref/unref; then they are no-ops
type Handle = ReturnType<typeof setTimeout> & { ref?: () => unknown; unref?: () => unknown };

// A class, not an object of closures: a store call arms one of these every time.
class NodeTimer implements Timer {
  readonly #h: Handle;
  constructor(h: Handle) {
    this.#h = h;
  }
  cancel(): void {
    clearTimeout(this.#h);
  }
  ref(): void {
    this.#h.ref?.();
  }
  unref(): void {
    this.#h.unref?.();
  }
}

export const nodePlatform: Platform = {
  name: 'node',
  monotonicMs: () => performance.now(),
  setTimer(fn, ms, opts) {
    const timer = new NodeTimer(setTimeout(fn, ms));
    if (opts?.ref !== true) timer.unref();
    return timer;
  },
  defer: (fn) => void setImmediate(fn),
  randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  sha256Hex: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
  onSignal(signal, fn) {
    process.on(signal, fn);
    return () => void process.off(signal, fn);
  },
  signalNames: () => Object.keys(constants.signals),
  exit: (code) => process.exit(code),
  hostname: () => hostname(),
  pid: () => process.pid,
};
