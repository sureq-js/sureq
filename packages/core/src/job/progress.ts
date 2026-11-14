import type { StoredProgress } from '../store/contract.js';
import { payloadText } from './job.js';

/** The object form of `ctx.progress`: any serializable object. */
export type ProgressObject = Record<string, unknown>;

/** Stored progress as a reader sees it; `percent`, `etaMs` and `etaAt` come from store times only. */
export type JobProgress =
  | {
    kind: 'counter'; n: number; total: number | null; message: string | null;
    percent: number | null; etaMs: number | null; etaAt: number | null; updatedAt: number;
  }
  | { kind: 'object'; value: ProgressObject; updatedAt: number };

type Encoded =
  | { kind: 'counter'; n: number; total: number | null; message: string | null; baseAt?: number }
  | { kind: 'object'; value: ProgressObject };

/**
 * Stored progress with its ETA, from the whole attempt's rate: `elapsed * (total - n) / n`, where elapsed runs
 * from `baseAt` (a batch's earliest start) or the attempt's `startedAt` to the write. Unreadable values give null.
 */
export function deriveProgress(stored: StoredProgress | null, startedAt: number | null, deserialize: (s: string) => unknown): JobProgress | null {
  if (!stored) return null;
  let p: Encoded;
  try {
    p = deserialize(payloadText(stored.value)) as Encoded;
  } catch {
    return null;
  }
  const { updatedAt } = stored;
  if (p?.kind === 'object') return { kind: 'object', value: p.value, updatedAt };
  if (p?.kind !== 'counter') return null;
  const { n, total, message } = p;
  const base = p.baseAt ?? startedAt;
  const elapsed = base === null ? 0 : updatedAt - base;
  let etaMs: number | null = null;
  if (total !== null && n > 0) etaMs = n >= total ? 0 : elapsed <= 0 ? null : Math.round((elapsed * (total - n)) / n);
  const percent = total === null ? null : Math.min(100, (100 * n) / total);
  return { kind: 'counter', n, total, message, percent, etaMs, etaAt: etaMs === null ? null : updatedAt + etaMs, updatedAt };
}
