import { vi } from 'vitest';

/** Fake timers with `performance` faked too, so `performance.now()` advances with `advanceTimersByTimeAsync`. */
export function useFakeTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date', 'performance'] });
}
