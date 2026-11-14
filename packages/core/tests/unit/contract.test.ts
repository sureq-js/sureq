import { describe, expect, it } from 'vitest';
import * as contract from '../../src/store/contract.js';
import * as pkg from '../../src/index.js';

describe('contract', () => {
  it('contract: STORE_CONTRACT_VERSION is 1 and the supported range is frozen [1, 1]', () => {
    expect(contract.STORE_CONTRACT_VERSION).toBe(1);
    expect(contract.SUPPORTED_CONTRACT_VERSIONS).toEqual([1, 1]);
    expect(Object.isFrozen(contract.SUPPORTED_CONTRACT_VERSIONS)).toBe(true);
    expect(pkg.STORE_CONTRACT_VERSION).toBe(1);
    expect(pkg.SUPPORTED_CONTRACT_VERSIONS).toBe(contract.SUPPORTED_CONTRACT_VERSIONS);
  });

  it('contract: the contract module exports only the two version constants at runtime', () => {
    expect(Object.keys(contract).sort()).toEqual(['STORE_CONTRACT_VERSION', 'SUPPORTED_CONTRACT_VERSIONS']);
  });
});
