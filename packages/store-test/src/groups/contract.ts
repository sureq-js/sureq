import { registerContractDedup } from './contract-dedup.js';
import { registerContractRecords } from './contract-records.js';
import { registerContractWrites } from './contract-writes.js';
import type { ConformanceGroup } from './types.js';

export const contractGroup: ConformanceGroup = {
  name: 'contract',
  mode: 'fake',
  register(t) {
    registerContractRecords(t);
    registerContractWrites(t);
    registerContractDedup(t);
  },
};
