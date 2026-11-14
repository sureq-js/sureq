import { platform } from '../platform/index.js';

/** Uniform random number in [0, 1) from the platform CSPRNG. */
function cryptoRandom(): number {
  const b = platform.randomBytes(4);
  return new DataView(b.buffer, b.byteOffset, 4).getUint32(0) / 0x1_0000_0000;
}

// Monotonic state, changed only inside calls (no work at import time).
let lastMs = -1;
let counter = 0;

const hex = (n: number, digits: number): string => n.toString(16).padStart(digits, '0');

/**
 * RFC 9562 UUIDv7 whose ids sort in creation order within this process, even for many ids in
 * one millisecond or a clock that steps back: a 12-bit counter lives in `rand_a`.
 */
export function uuidv7(now: number = Date.now(), random: () => number = cryptoRandom): string {
  let ms = Math.max(now, lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) {
      ms++;
      counter = 0;
    }
  } else {
    counter = Math.floor(random() * 0x800); // start in the lower half so the counter can climb
  }
  lastMs = ms;

  const time = hex(ms, 12);
  const randB = Array.from({ length: 8 }, () => Math.floor(random() * 256));
  randB[0] = (randB[0]! & 0x3f) | 0x80; // variant 10
  const b = randB.map((x) => hex(x, 2)).join('');
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(counter, 3)}-${b.slice(0, 4)}-${b.slice(4, 16)}`;
}
