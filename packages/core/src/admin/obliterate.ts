import { isSureQError } from '../errors/base.js';
import { InvalidOptionError, StoreError } from '../errors/catalog.js';
import { validate } from '../util/validate.js';
import { obliterateSchema } from './clean.js';
import type { AdminHost } from './redrive.js';

/** True for the store's refusal of a write to a queue that is being obliterated. */
export const isObliterating = (e: unknown): boolean => isSureQError(e) && e.code === 'QUEUE_OBLITERATING';

/** A pod older than the first release that honours the obliterating marker ignores it; a version string that does not parse counts as older. */
function beforeMarker(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 0 && minor < 3;
}

/**
 * `queue.obliterate`: delete the whole queue, `pageSize` jobs per store call, until the store reports it done. Refused
 * while the namespace was last raised by, or a registered worker runs, a release that ignores the marker (`force` does
 * not override that). Emits `obliterated` once, when done.
 */
export async function obliterateQueue(h: AdminHost, opts: unknown = {}): Promise<{ removed: number }> {
  const o = validate('obliterate', opts, obliterateSchema);
  const ns = { namespace: h.scope.namespace };
  const meta = await h.client.call('getNamespaceMeta', ns);
  const { workers } = await h.client.call('listWorkers', ns, {});
  const old = [...(meta ? [meta.lastRaisedBy] : []), ...workers.map((w) => w.sureqVersion)].filter(beforeMarker);
  if (old.length > 0) {
    throw new InvalidOptionError('obliterate', [{
      path: 'obliterate', code: 'invalid_value',
      message: `mixed-versions: a pod running ${old[0]} does not honour obliterate; finish the rolling upgrade first`,
    }]);
  }
  let removed = 0;
  for (;;) {
    const res = await h.client.call('obliterate', h.scope, { ...(o.force && { force: true }), limit: o.pageSize });
    removed += res.removed;
    if (res.done) break;
    // a page that removed nothing and is not done would repeat forever
    if (res.removed === 0) {
      throw new StoreError('obliterate removed nothing and is not done', { operation: 'obliterate', retryable: true, outcomeUnknown: false, details: { removed } });
    }
  }
  h.emit('obliterated', { removed });
  if (removed > 0) await h.jobsLeft();
  return { removed };
}
