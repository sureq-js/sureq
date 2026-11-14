import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '../../src/util/uuidv7.js';

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('uuidv7: has version 7, variant 10 and the given millisecond timestamp', () => {
    const id = uuidv7(1_700_000_000_000, () => 0.5);
    expect(id).toMatch(FORMAT);
    expect(parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });

  it('uuidv7: is deterministic for a fixed random', async () => {
    vi.resetModules();
    const a = (await import('../../src/util/uuidv7.js')).uuidv7(42_000, () => 0.25);
    vi.resetModules();
    const b = (await import('../../src/util/uuidv7.js')).uuidv7(42_000, () => 0.25);
    expect(a).toBe(b);
    expect(a).toMatch(FORMAT);
  });

  it('uuidv7: 1000 ids in a tight loop are strictly increasing', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7(5_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });

  it('uuidv7: a clock that goes backwards still sorts after the previous id', () => {
    const first = uuidv7(9_000_000);
    const second = uuidv7(1_000);
    expect(second > first).toBe(true);
    expect(second).toMatch(FORMAT);
  });

  it('uuidv7: defaults to the current time and crypto randomness', () => {
    const before = Date.now();
    const id = uuidv7();
    expect(parseInt(id.replace('-', '').slice(0, 12), 16)).toBeGreaterThanOrEqual(before);
    expect(id).toMatch(FORMAT);
  });
});
