import { isObliterating } from '../admin/obliterate.js';
import { StoreFormatError } from '../errors/catalog.js';
import type { StoreClient } from '../store/client.js';
import type { CleanRequest, Scope } from '../store/contract.js';
import type { Outcome, Policy, ResolvedRetention } from './policy.js';

/** What a cleanup pass needs from its queue. */
export interface RetentionHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  readonly retention: ResolvedRetention;
  /** True once the pass should end early (its sweeper is stopping); checked before every store call. */
  readonly stopping?: () => boolean;
}

/**
 * Store calls one expiry policy (the age pages of one state) may make in one pass. A pass is bounded, so it never holds
 * the sweeper tick (or a close waiting for it) for long; a backlog left over goes on at the next tick.
 */
export const MAX_PAGES_PER_POLICY = 10;

const STATES: readonly Outcome[] = ['completed', 'failed', 'cancelled'];
const ageOf = (p: Policy | undefined): number | undefined => (typeof p === 'object' ? p.ageMs : undefined);
const countOf = (p: Policy | undefined): number | undefined => (typeof p === 'object' ? p.count : undefined);

/**
 * One cleanup pass over the finished states. Per state: jobs whose `retainUntil` passed, up to `MAX_PAGES_PER_POLICY`
 * pages (a job a previous-release pod finished ages from `finishedAt` by the queue's age for that state); then one page per
 * count policy, by name for `byName` counts and for every other name together, sparing jobs inside the result grace.
 * Counts are therefore approximate by up to `pageSize`. Dead letters and `retained` jobs are never counted. `more` is true
 * when the page cap or a stop left expired jobs behind.
 */
export async function runRetentionPass(host: RetentionHost): Promise<{ removed: number; more: boolean }> {
  const { client, scope, retention: cfg } = host;
  const stopping = (): boolean => host.stopping?.() === true;
  const clean = async (req: CleanRequest) => client.call('clean', scope, req);
  let removed = 0;
  let more = false;
  for (const state of STATES) {
    if (stopping()) return { removed, more: true };
    const own = Object.keys(cfg.byName).filter((name) => cfg.byName[name]![state] !== undefined);
    const others = own.length > 0 ? { excludeNames: own } : {};
    const ageMs = ageOf(cfg[state]);
    for (let pages = 0; ; pages++) {
      if (pages === MAX_PAGES_PER_POLICY || stopping()) {
        more = true;
        break;
      }
      const page = await clean({ state, retainExpired: true, ...(ageMs !== undefined && { olderThanMs: ageMs }), ...others, limit: cfg.pageSize });
      removed += page.removed;
      if (!page.remaining || page.removed === 0) break;
    }
    const counts: Array<[number | undefined, Pick<CleanRequest, 'name' | 'excludeNames'>]> = [
      ...own.map((name): [number | undefined, { name: string }] => [countOf(cfg.byName[name]![state]), { name }]),
      [countOf(cfg[state]), others],
    ];
    for (const [keepLast, names] of counts) {
      if (keepLast === undefined) continue;
      if (stopping()) return { removed, more: true };
      removed += (await clean({ state, keepLast, ...names, olderThanMs: cfg.resultGraceMs, limit: cfg.pageSize })).removed;
    }
  }
  return { removed, more };
}

/**
 * Runs a pass from the sweeper tick when `intervalMs` of store time has passed since the last one that finished (the
 * first tick runs one), or at once when the last pass left a backlog. Never rejects; a store failure is reported once per
 * outage, and the next tick tries again.
 */
export class RetentionCleaner {
  readonly #host: RetentionHost;
  readonly #report: (e: unknown) => void;
  #lastRunAt: number | undefined;
  #failing = false;
  #backlog = false;

  constructor(host: RetentionHost, report: (e: unknown) => void) {
    this.#host = host;
    this.#report = report;
  }

  /** `now` is the store time of the tick. */
  async maybeRun(now: number): Promise<void> {
    if (!this.#backlog && this.#lastRunAt !== undefined && now - this.#lastRunAt < this.#host.retention.intervalMs) return;
    try {
      this.#backlog = (await runRetentionPass(this.#host)).more;
      this.#lastRunAt = now;
      this.#failing = false;
    } catch (e) {
      // An obliterating queue is going away, and a refused format is reported once, by the worker.
      if (isObliterating(e) || (e instanceof StoreFormatError && e.recordKind === 'meta') || this.#failing) return;
      this.#failing = true;
      this.#report(e);
    }
  }
}
