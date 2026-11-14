// The per-namespace format record. It lets pods of different SureQ releases share one store: a pod reads the
// format the namespace is written in, and refuses or stops when it cannot read it.
import type { EnsureNamespaceMetaRequest, EnsureNamespaceMetaResult, NamespaceScope, StoreMeta } from '@sureq/core';
import type { TemplateBackend } from './backend.js';
import { bad, check, int, text } from './check.js';

const NAMESPACE = { namespace: text };

/*
 * SUREQ-CONTRACT: ensureNamespaceMeta
 * WHY: the read, the compare and the write are one transaction, so two pods starting together create one record.
 * WHY: absent → create at `current`; `minReadable <= f < current` → raise to `current`; anything else writes nothing.
 * WHY: the version is never lowered, and a pod that cannot read the stored format never writes it.
 */
/** `ready` is the store's open check; it runs again inside the transaction, so a call queued before close is refused. */
export function ensureNamespaceMeta(backend: TemplateBackend, ready: () => void, ns: NamespaceScope, req: EnsureNamespaceMetaRequest): Promise<EnsureNamespaceMetaResult> {
  const op = 'ensureNamespaceMeta';
  check(op, 'scope', ns, NAMESPACE, ['namespace']);
  check(op, 'request', req, { current: int(1), minReadable: int(1), maxReadable: int(1), sureqVersion: text }, ['current', 'minReadable', 'maxReadable', 'sureqVersion']);
  if (req.minReadable > req.current || req.current > req.maxReadable) bad(op, 'versions must satisfy minReadable <= current <= maxReadable');
  // REPLACE-ME: one conditional upsert: SQL INSERT ... ON CONFLICT DO UPDATE ... WHERE format_version < $current AND format_version >= $minReadable, Redis a Lua script on one hash, Mongo findOneAndUpdate with upsert and a filter.
  return backend.transact((tx) => {
    ready();
    const now = backend.serverNow();
    const meta = tx.getMeta(ns.namespace);
    if (!meta) {
      tx.putMeta(ns.namespace, { formatVersion: req.current, createdBy: req.sureqVersion, lastRaisedBy: req.sureqVersion, updatedAt: now });
      return { formatVersion: req.current, created: true, raised: false };
    }
    const raised = meta.formatVersion >= req.minReadable && meta.formatVersion < req.current;
    if (raised) tx.putMeta(ns.namespace, { ...meta, formatVersion: req.current, lastRaisedBy: req.sureqVersion, updatedAt: now });
    return { formatVersion: raised ? req.current : meta.formatVersion, created: false, raised };
  });
}

/*
 * SUREQ-CONTRACT: getNamespaceMeta
 * WHY: one consistent read of the record, or null when no pod has created it yet.
 */
export function getNamespaceMeta(backend: TemplateBackend, ready: () => void, ns: NamespaceScope): Promise<StoreMeta | null> {
  check('getNamespaceMeta', 'scope', ns, NAMESPACE, ['namespace']);
  return backend.transact((tx) => (ready(), tx.getMeta(ns.namespace) ?? null));
}
