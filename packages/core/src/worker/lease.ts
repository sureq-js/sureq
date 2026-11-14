import { isObliterating } from '../admin/obliterate.js';
import { JobCancelledError, LeaseLostError } from '../errors/catalog.js';
import type { ErrorSource } from '../events/types.js';
import type { StoreClient } from '../store/client.js';
import type { FencedRejection, JobRecord, Scope } from '../store/contract.js';
import { platform, type Timer } from '../platform/index.js';

type Reason = LeaseLostError['reason'];
type LeaseView = { owner: string; token: number; expiresAt: number };

/**
 * Why the store refused an attempt's write: `'cancelled'` only when it said `not-active` and the job reads
 * as cancelled. Anything else, a missing record or a failing read, is a lost lease.
 */
export async function lossReason(client: StoreClient, scope: Scope, jobId: string, rejection: FencedRejection): Promise<'cancelled' | 'lost'> {
  if (rejection.reason !== 'not-active') return 'lost';
  try {
    return (await client.call('get', scope, jobId))?.state === 'cancelled' ? 'cancelled' : 'lost';
  } catch {
    return 'lost';
  }
}

/** What a LeaseKeeper needs from its worker. */
export interface LeaseHost {
  readonly client: StoreClient;
  readonly scope: Scope;
  report(e: unknown, source: ErrorSource, operation: string, jobId?: string): void;
  /** A lease was lost; the worker emits `leaseLost`. Called once per attempt. */
  onLost(e: { job: JobRecord; token: number; reason: Reason }): void;
  /** The attempt was discarded because its job was cancelled. Called once per attempt. */
  onCancelled?(job: JobRecord): void;
  /** A held lease's `started` renew succeeded at store time `now`. */
  onStarted?(job: JobRecord, now: number): void;
}

interface Entry {
  readonly job: JobRecord;
  readonly abort: AbortController;
  readonly token: number;
  readonly leaseMs: number;
  /** The heartbeat interval: a third of this job's lease. */
  readonly interval: number;
  lease: LeaseView;
  /** Local lease deadline on the pod's monotonic clock. */
  deadline: number;
  lastSentAt: number;
  lastOkAt: number;
  heartbeat: Timer | undefined;
  expiry: Timer | undefined;
  /** Heartbeat stopped (handler ended or untracked): a late renew outcome is ignored. */
  stopped: boolean;
  lost: boolean;
  /** A renew threw and none has succeeded since: report only the first. */
  outage: boolean;
  /** A renew is out; the next one waits for its answer. */
  renewing: boolean;
  /** The handler of a held lease started: renews carry `started` (and the batch id) until one succeeds. */
  start: { batchId: string | undefined; waiters: Array<(ok: boolean) => void> } | undefined;
}

/**
 * Keeps the leases of a worker's running jobs alive: one self-rescheduling heartbeat and one local
 * deadline per attempt, both on the pod's monotonic clock. Renewals of one attempt never overlap.
 * An attempt is a job id plus its fencing token; the id-only methods act on the job's newest attempt.
 */
export class LeaseKeeper {
  readonly #host: LeaseHost;
  readonly #leaseMsFor: (name: string | null) => number;
  readonly #random: () => number;
  readonly #now: () => number;
  /** Job id → its tracked attempts, oldest first (more than one only while a stale handler still runs). */
  readonly #entries = new Map<string, Entry[]>();

  constructor(host: LeaseHost, opts: { leaseMsFor(name: string | null): number; random?: () => number; now?: () => number }) {
    this.#host = host;
    this.#leaseMsFor = (name) => opts.leaseMsFor(name);
    this.#random = opts.random ?? Math.random;
    this.#now = opts.now ?? (() => platform.monotonicMs());
  }

  /** Start keeping a claimed job's lease. `claim.sentAt` is the monotonic time just before the claim left. */
  track(job: JobRecord, abort: AbortController, claim: { now: number; sentAt: number }): void {
    const lease = job.lease!;
    const attempts = this.#entries.get(job.id) ?? [];
    // A repeat of a tracked attempt, or an older one, is not tracked: the running attempts stay as they are.
    if (attempts.some((e) => e.token >= lease.token)) return;
    // The renew length is this job's configured lease, not what remains of it (a recovered claim may be part spent).
    const leaseMs = this.#leaseMsFor(job.name);
    const entry: Entry = {
      job, abort, token: lease.token, leaseMs, interval: leaseMs / 3,
      lease: Object.freeze({ owner: lease.owner, token: lease.token, expiresAt: lease.expiresAt }),
      deadline: claim.sentAt + (lease.expiresAt - claim.now),
      lastSentAt: claim.sentAt, lastOkAt: claim.sentAt,
      heartbeat: undefined, expiry: undefined, stopped: false, lost: false, outage: false, renewing: false, start: undefined,
    };
    // The store handed the job out again under a newer token: an older attempt's lease is gone.
    for (const old of attempts) this.#lose(old, 'superseded');
    attempts.push(entry);
    this.#entries.set(job.id, attempts);
    this.#armExpiry(entry);
    this.#schedule(entry);
  }

  /**
   * A held lease's handler starts: renew now with `started` (after a renew already out), and keep sending it
   * until one succeeds. True on that success; false once the attempt is lost, discarded or untracked.
   */
  markStarted(id: string, token: number, batchId?: string): Promise<boolean> {
    const entry = this.#find(id, token);
    if (!entry || entry.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const asked = entry.start !== undefined;
      entry.start ??= { batchId, waiters: [] };
      entry.start.waiters.push(resolve);
      if (asked || entry.renewing) return;
      entry.heartbeat?.cancel();
      void this.#renew(entry);
    });
  }

  /** Stop renewing (the handler ended); the entry, its lease view and deadline stay until `untrack`. */
  stopHeartbeat(id: string, token?: number): void {
    const entry = this.#find(id, token);
    if (entry) this.#halt(entry);
  }

  untrack(id: string, token?: number): void {
    const entry = this.#find(id, token);
    if (!entry) return;
    this.#halt(entry);
    const rest = this.#entries.get(id)!.filter((e) => e !== entry);
    if (rest.length > 0) this.#entries.set(id, rest);
    else this.#entries.delete(id);
  }

  /** The lease is gone: abort the handler and report it, once per attempt. */
  lost(id: string, reason: Reason, token?: number): void {
    const entry = this.#find(id, token);
    if (entry) this.#lose(entry, reason);
  }

  /** The job was cancelled: abort the handler with `reason` and drop its outcome, with no `onLost`. False when not tracked or already lost. */
  discard(id: string, reason: Error, token?: number): boolean {
    const entry = this.#find(id, token);
    if (!entry || entry.lost) return false;
    entry.lost = true;
    this.#halt(entry);
    entry.abort.abort(reason);
    this.#host.onCancelled?.(entry.job);
    return true;
  }

  isLost(id: string, token?: number): boolean {
    return this.#find(id, token)?.lost ?? false;
  }

  /** Local lease deadline on the pod's monotonic clock. */
  deadline(id: string, token?: number): number | undefined {
    return this.#find(id, token)?.deadline;
  }

  /** The lease as of the last successful renewal (or the claim). */
  lease(id: string, token?: number): LeaseView | undefined {
    return this.#find(id, token)?.lease;
  }

  /** Renewal lag of the jobs still heartbeating; a job is late when its lag exceeds twice its interval. */
  renewals(): { onTime: boolean; lateJobs: number; worstLagMs: number } {
    const now = this.#now();
    let lateJobs = 0;
    let worstLagMs = 0;
    for (const e of [...this.#entries.values()].flat()) {
      if (e.stopped) continue;
      const lag = now - e.lastOkAt;
      if (lag > 2 * e.interval) lateJobs++;
      worstLagMs = Math.max(worstLagMs, lag);
    }
    return { onTime: lateJobs === 0, lateJobs, worstLagMs };
  }

  /** Clear every timer (the worker closed). */
  stop(): void {
    for (const e of [...this.#entries.values()].flat()) this.#halt(e);
    this.#entries.clear();
  }

  /** The attempt with this token, or the job's newest attempt when no token is given. */
  #find(id: string, token?: number): Entry | undefined {
    const attempts = this.#entries.get(id);
    return token === undefined ? attempts?.at(-1) : attempts?.find((e) => e.token === token);
  }

  #lose(entry: Entry, reason: Reason): void {
    if (entry.lost) return;
    entry.lost = true;
    this.#halt(entry);
    this.#abortWith(entry, reason);
    this.#host.onLost({ job: entry.job, token: entry.token, reason });
  }

  #abortWith(entry: Entry, reason: Reason): void {
    entry.abort.abort(new LeaseLostError({ jobId: entry.job.id, token: entry.token, reason }));
  }

  #halt(entry: Entry): void {
    entry.stopped = true;
    this.#started(entry, false);
    entry.heartbeat?.cancel();
    entry.expiry?.cancel();
    entry.heartbeat = entry.expiry = undefined;
  }

  #started(entry: Entry, ok: boolean): void {
    const waiters = entry.start?.waiters ?? [];
    entry.start = undefined;
    for (const w of waiters) w(ok);
  }

  #armExpiry(entry: Entry): void {
    entry.expiry?.cancel();
    // Ref'd too: while a renewal is out no heartbeat timer is armed.
    entry.expiry = platform.setTimer(() => this.#lose(entry, 'expired'), Math.max(0, entry.deadline - this.#now()), { ref: true });
  }

  /** Next renew: one jittered interval after the previous send. */
  #schedule(entry: Entry): void {
    const wait = entry.interval * (1 + 0.1 * (2 * this.#random() - 1)) - (this.#now() - entry.lastSentAt);
    this.#arm(entry, Math.max(0, wait));
  }

  /** Ref'd: an active job's renewal holds the process open. */
  #arm(entry: Entry, ms: number): void {
    entry.heartbeat = platform.setTimer(() => void this.#renew(entry), ms, { ref: true });
  }

  async #renew(entry: Entry): Promise<void> {
    entry.heartbeat = undefined;
    const { id } = entry.job;
    const sentAt = this.#now();
    entry.lastSentAt = sentAt;
    const start = entry.start;
    const req = { id, token: entry.token, leaseMs: entry.leaseMs, ...(start && { started: true, ...(start.batchId !== undefined && { batchId: start.batchId }) }) };
    let res;
    entry.renewing = true;
    try {
      res = await this.#host.client.call('renew', this.#host.scope, req);
    } catch (e) {
      entry.renewing = false;
      if (entry.stopped) return;
      // an obliterating queue refuses a starting renew; the fence ends the attempt, so there is nothing to report
      if (!entry.outage && !(start && isObliterating(e))) this.#host.report(e, 'store', 'renew', id);
      entry.outage = true;
      this.#arm(entry, Math.min(1000, entry.leaseMs / 6));
      return;
    }
    entry.renewing = false;
    if (entry.stopped) return;
    if (!res.ok) {
      // The store has answered: the local deadline no longer decides, so it cannot fire during the read below.
      entry.expiry?.cancel();
      entry.expiry = undefined;
      const why = await lossReason(this.#host.client, this.#host.scope, id, res);
      // The handler ended meanwhile: its finalising write meets the same refusal and decides.
      if (entry.stopped) return;
      if (why === 'cancelled') this.discard(id, new JobCancelledError({ jobId: id }), entry.token);
      else this.#lose(entry, res.reason);
      return;
    }
    entry.outage = false;
    entry.deadline = sentAt + (res.expiresAt - res.now);
    entry.lease = Object.freeze({ ...entry.lease, expiresAt: res.expiresAt });
    entry.lastOkAt = sentAt;
    this.#armExpiry(entry);
    if (start) {
      this.#host.onStarted?.(entry.job, res.now);
      this.#started(entry, true);
    }
    // A start asked for while this renew was out goes now.
    if (entry.start) void this.#renew(entry);
    else this.#schedule(entry);
  }
}
