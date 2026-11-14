import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devDocsRoot, hasDevDocs } from '../helpers/dev-docs.js';
import { QUEUE_EVENT_NAMES, WORKER_EVENT_NAMES } from '../../src/events/types.js';

describe('events (registry)', () => {
  it('events: the registry emits exactly added active completed retrying failed drained leaseLost stalled storeDisconnected storeReconnected error duplicate closing closed paused resumed cancelled rejected progress degraded versionSkew schedulePaused scheduleResumed scheduleDeleted scheduleFired scheduleSkipped scheduleQueued deadLettered redriven alert cleaned obliterated', () => {
    expect([...QUEUE_EVENT_NAMES]).toEqual([
      'added', 'active', 'completed', 'retrying', 'failed', 'drained', 'leaseLost', 'stalled', 'storeDisconnected', 'storeReconnected', 'error',
      'duplicate', 'closing', 'closed', 'paused', 'resumed', 'cancelled', 'rejected', 'progress', 'degraded', 'versionSkew', 'schedulePaused',
      'scheduleResumed', 'scheduleDeleted', 'scheduleFired', 'scheduleSkipped', 'scheduleQueued', 'deadLettered', 'redriven', 'alert', 'cleaned',
      'obliterated',
    ]);
    expect([...WORKER_EVENT_NAMES]).toEqual(['active', 'completed', 'retrying', 'failed', 'deadLettered', 'drained', 'leaseLost', 'error', 'closing', 'closed', 'paused', 'resumed', 'progress']);
  });

  it.runIf(hasDevDocs)('events: registry table matches the typed event map', () => {
    const doc = readFileSync(join(devDocsRoot, 'docs/features/J2-local-events.md'), 'utf8');
    // A row may name several events: "| `a`, `b` | ...".
    const names = (release: string) =>
      [...doc.matchAll(new RegExp(`^\\|((?: ?\`\\w+\`,?)+) \\|.*\\| ${release} \\|\\s*$`, 'gm'))].flatMap((m) => [...m[1]!.matchAll(/`(\w+)`/g)].map((n) => n[1]!));
    // Exactly the events of the built releases are emitted.
    expect([...QUEUE_EVENT_NAMES].sort()).toEqual([...new Set(names('0\\.[123]'))].sort());
  });
});
