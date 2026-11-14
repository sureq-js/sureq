import { MemoryStore, type Scope, type StatsResult } from '@sureq/core';
import { inject, yieldToLoop } from './inject.js';

// Reads the counts, yields, then reads the oldest waiting job: the two halves can disagree.
class StatsNotAtomic extends MemoryStore {
  override async stats(scope: Scope, req: Record<string, never>): Promise<StatsResult> {
    const first = await super.stats(scope, req);
    await yieldToLoop();
    const second = await super.stats(scope, req);
    return { ...second, counts: first.counts };
  }
}

export const statsNotAtomic = inject('statsNotAtomic', ['stats'], ['age: stats returns counts and oldest runAt from one read'], StatsNotAtomic);
