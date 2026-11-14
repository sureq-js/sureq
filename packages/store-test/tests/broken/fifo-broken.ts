import { MemoryStore, type ClaimRequest, type ClaimResult, type Scope } from '@sureq/core';
import { inject } from './inject.js';

// claim ignores seq order within a priority.
class FifoBroken extends MemoryStore {
  override async claim(scope: Scope, req: ClaimRequest): Promise<ClaimResult> {
    return super.claim(scope, { ...req, order: 'lifo' });
  }
}

export const fifoBroken = inject('fifoBroken', ['claim'], ['claim: orders by priority desc then seq asc'], FifoBroken);
