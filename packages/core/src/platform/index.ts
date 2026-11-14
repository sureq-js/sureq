import { UnsupportedRuntimeError } from '../errors/catalog.js';
import { nodePlatform } from './node.js';
import type { Platform } from './types.js';

export type { Platform, Timer } from './types.js';

/** Longest wait one timer can take (about 24.8 days); Node fires a longer one after 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The platform for the runtime these globals belong to. */
export function detectPlatform(g: typeof globalThis): Platform {
  if (typeof (g as { process?: { versions?: { node?: unknown } } }).process?.versions?.node !== 'string') {
    throw new UnsupportedRuntimeError();
  }
  return nodePlatform;
}

let active: Platform | undefined;
const current = (): Platform => (active ??= detectPlatform(globalThis));

/** Test hook: every later platform call goes to `p`; `undefined` detects the runtime again. */
export function setPlatformForTest(p: Platform | undefined): void {
  active = p;
}

/** The runtime's platform, detected at first use, so a test can set its own before any. */
export const platform: Platform = {
  get name() {
    return current().name;
  },
  monotonicMs: () => current().monotonicMs(),
  setTimer: (fn, ms, opts) => current().setTimer(fn, ms, opts),
  defer: (fn) => current().defer(fn),
  randomBytes: (n) => current().randomBytes(n),
  sha256Hex: (text) => current().sha256Hex(text),
  onSignal: (signal, fn) => current().onSignal(signal, fn),
  signalNames: () => current().signalNames(),
  exit: (code) => current().exit(code),
  hostname: () => current().hostname(),
  pid: () => current().pid(),
};
