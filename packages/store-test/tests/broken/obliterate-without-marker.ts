import { MemoryStore, type ObliterateRequest, type ObliterateResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

const STATES = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'] as const;

// Obliterates through public calls and never sets a marker, so adds, claims and sweeps go on between pages.
class ObliterateWithoutMarker extends MemoryStore {
  override async obliterate(scope: Scope, req: ObliterateRequest): Promise<ObliterateResult> {
    let removed = 0;
    for (const state of STATES) {
      for (const rec of await this.list(scope, { state, offset: 0, limit: 1000, order: 'asc' })) {
        if (removed === req.limit) return { removed, done: false };
        if (rec.state === 'active') await this.cancel(scope, { id: rec.id });
        await this.remove(scope, { id: rec.id });
        removed++;
      }
    }
    return { removed, done: true };
  }
}

export const obliterateWithoutMarker = inject('obliterateWithoutMarker', ['obliterate'], ['admin: obliterate marker blocks add and claim'], ObliterateWithoutMarker);
