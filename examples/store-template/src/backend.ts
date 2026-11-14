// The toy backend: the only file you replace when you copy this template.
//
// A real adapter talks to a database here. This one keeps jobs in a Map and appends every committed
// transaction to a JSON-lines file, so it is durable but NOT meant for production: one process, one
// writer, and the whole data set lives in memory.
//
// The store (store.ts) needs only two things from a backend: `transact`, a single-writer critical
// section, and `serverNow`, the clock of whoever owns the data.
import { existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { StoreError, type JobRecord, type JobState, type ScheduleRecord, type Scope, type StoredAttempt, type StoreMeta, type WorkerRecord } from '@sureq/core';

/** The last finalising write of a job that was deleted; a repeated write still gets its answer. */
export interface Tombstone {
  token: number;
  kind: 'complete' | 'fail' | 'release';
  state: JobState;
  runAt?: number;
  expiresAt: number;
}

/** How `scan` orders its result. `queue` is claim order: priority high to low, then `seq`. */
export type ScanOrder =
  | { by: 'queue'; dir: 'fifo' | 'lifo' }
  | { by: 'seq' | 'runAt' | 'startedAt' | 'finishedAt' | 'token' | 'leaseExpiresAt' | 'deadLetterAt'; dir: 'asc' | 'desc' };

/** What `scan` selects. Every field is optional; the result is ordered, then paged. */
export interface ScanFilter {
  state?: JobState;
  /** Only jobs with one of these names (`null` is the unnamed job). */
  names?: ReadonlyArray<string | null>;
  /** Only the job that currently holds this singleton key. */
  holdsKey?: string;
  /** Only jobs whose `runAt` is at or before this instant. */
  runAtAtMost?: number;
  /** Only active jobs whose lease expires at or before this instant. */
  leaseExpiresAtAtMost?: number;
  /** Only the jobs one claim call took. */
  claim?: { owner: string; claimId: string };
  /** Only jobs whose `formatVersion` is at most this. */
  formatAtMost?: number;
  /** Only dead letters (jobs with a `deadLetter` marker), of this reason, marked at or before `atAtMost`. */
  deadLetter?: { reason?: string; atAtMost?: number };
  /** Also the history records (`id#seq`) that match; the store asks this only together with `deadLetter`. */
  history?: true;
  order?: ScanOrder;
  offset?: number;
  limit?: number;
}

/**
 * What `scanSchedules` selects: keys after `afterKey`; with `dueAtMost`, only schedules with `nextRunAt <= dueAtMost`
 * or a queued tick; with `paused: false`, only running ones; in `order` (default key), at most `limit`.
 */
export interface ScheduleScan {
  afterKey?: string;
  dueAtMost?: number;
  paused?: false;
  order?: 'key' | 'nextRunAt';
  limit?: number;
}

/**
 * Everything the store may do to the data inside one transaction. Records go in and out as copies, so the
 * store can edit what it reads and nothing it holds can change the backend behind its back.
 */
export interface Tx {
  get(scope: Scope, id: string): JobRecord | undefined;
  put(scope: Scope, rec: JobRecord): void;
  delete(scope: Scope, id: string): void;
  // REPLACE-ME: scan is a filtered, ordered, paged read: SQL SELECT with ORDER BY and LIMIT on an index, Redis a sorted set per state, Mongo find().sort().limit() on a compound index.
  scan(scope: Scope, filter: ScanFilter): JobRecord[];
  // REPLACE-ME: the three counters never go back, even after deletes: SQL a SEQUENCE per queue, Redis INCR on one key per queue, Mongo findOneAndUpdate with $inc on a counters document.
  nextSeq(scope: Scope): number;
  lowSeq(scope: Scope): number;
  nextToken(scope: Scope): number;
  // REPLACE-ME: history is a side table only getAttempts reads: SQL a job_history table, Redis a separate hash per queue, Mongo a separate collection.
  /** Store a finished record under its history key `id#seq`; the job's attempt rows move with it. */
  putHistory(scope: Scope, rec: JobRecord): void;
  getHistory(scope: Scope, id: string): JobRecord | undefined;
  /** Every history record of the scope (copies), for the ones `clean` deletes. */
  scanHistory(scope: Scope): JobRecord[];
  /** Delete one history record with its attempt rows. */
  deleteHistory(scope: Scope, id: string): void;
  // REPLACE-ME: attempt rows are their own records written in the job's transaction: SQL an attempts table keyed (namespace, queue, job_id, token), Redis a list per job inside the script, Mongo an array on the job or a side collection in the same transaction.
  /** A job's attempt rows by token, empty when it has none. */
  getAttempts(scope: Scope, jobId: string): StoredAttempt[];
  /** Replace a job's attempt rows; `null` deletes them. */
  setAttempts(scope: Scope, jobId: string, rows: StoredAttempt[] | null): void;
  getFlag(scope: Scope, flag: Flag): boolean;
  setFlag(scope: Scope, flag: Flag, value: boolean): void;
  // REPLACE-ME: dropping a queue's history is one statement: SQL DELETE FROM job_history WHERE ns = $1 AND queue = $2, Redis DEL the history hash, Mongo deleteMany on the history collection.
  /** Delete every history record of the scope, with its attempt rows. */
  clearHistory(scope: Scope): void;
  // REPLACE-ME: tombstones expire by themselves: SQL a side table you purge by expires_at, Redis SET with EXPIRE, Mongo a TTL index.
  putTombstone(key: string, t: Tombstone): void;
  getTombstone(key: string): Tombstone | undefined;
  getSchedule(scope: Scope, key: string): ScheduleRecord | undefined;
  putSchedule(scope: Scope, rec: ScheduleRecord): void;
  deleteSchedule(scope: Scope, key: string): void;
  scanSchedules(scope: Scope, scan: ScheduleScan): ScheduleRecord[];
  // REPLACE-ME: one format record per namespace: SQL a sureq_meta table keyed by namespace, Redis one hash per namespace, Mongo one document per namespace in a meta collection.
  getMeta(namespace: string): StoreMeta | undefined;
  putMeta(namespace: string, meta: StoreMeta): void;
  // REPLACE-ME: worker records live per namespace: SQL a workers table keyed (namespace, worker_id) with an index on last_heartbeat_at, Redis a hash per namespace plus a sorted set by heartbeat (or a key per worker with a TTL), Mongo a collection with a TTL index on lastHeartbeatAt.
  getWorker(namespace: string, workerId: string): WorkerRecord | undefined;
  putWorker(namespace: string, rec: WorkerRecord): void;
  deleteWorker(namespace: string, workerId: string): void;
  scanWorkers(namespace: string): WorkerRecord[];
}

/** The queue's flags: `paused`, and `obliterating` while an obliterate is under way. */
export type Flag = 'paused' | 'obliterating';

/** What the store needs from its database. */
export interface TemplateBackend {
  // REPLACE-ME: transact runs fn as one isolated unit that commits when fn resolves and rolls back when it throws: SQL BEGIN/COMMIT with row locks (FOR UPDATE SKIP LOCKED), Redis MULTI or a Lua script, Mongo a multi-document transaction.
  transact<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T>;
  // REPLACE-ME: serverNow is the database's own clock, never this process's: SQL SELECT now(), Redis TIME, Mongo $$NOW.
  serverNow(): number;
}

interface ScopeData {
  jobs: Map<string, JobRecord>;
  /** Finished records whose id was reused, under `id#seq`; kept out of every scan. */
  history: Map<string, JobRecord>;
  /** Attempt rows per job id (live or history key), ordered by token. */
  attempts: Map<string, StoredAttempt[]>;
  seq: number;
  low: number;
  token: number;
  paused: boolean;
  obliterating: boolean;
  schedules: Map<string, ScheduleRecord>;
}

/** One journal entry. A committed transaction is one line holding its entries. */
type Entry =
  | ['put', string, JobRecord]
  | ['del', string, string]
  | ['counter', string, 'seq' | 'low' | 'token', number]
  | ['hist', string, JobRecord]
  | ['att', string, string, StoredAttempt[] | null]
  | [Flag, string, boolean]
  | ['unhist', string]
  | ['delhist', string, string]
  | ['tomb', string, Tombstone]
  | ['sched', string, ScheduleRecord]
  | ['unsched', string, string]
  | ['meta', string, StoreMeta]
  | ['wput', string, WorkerRecord]
  | ['wdel', string, string];

const scopeKey = (s: Scope): string => `${s.namespace}\u0000${s.queue}`;
const sleepOneTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// JSON has no byte arrays: write them as base64 and read them back, so a reopened store returns the same data.
const replacer = (_k: string, v: unknown): unknown => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v);
const reviver = (_k: string, v: unknown): unknown =>
  typeof v === 'object' && v !== null && '$bytes' in v ? new Uint8Array(Buffer.from(String((v as { $bytes: unknown }).$bytes), 'base64')) : v;

export interface ToyBackendOptions {
  /** The journal file. Without it the data lives in memory only (and `durable` would be a lie). */
  journalFile?: string;
  /** Tests inject a fake clock here; by default the server clock is this process's clock. */
  clock?: { now(): number };
}

export class ToyBackend implements TemplateBackend {
  readonly #scopes = new Map<string, ScopeData>();
  readonly #tombstones = new Map<string, Tombstone>();
  readonly #meta = new Map<string, StoreMeta>();
  /** Worker records per namespace, by worker id. */
  readonly #workers = new Map<string, Map<string, WorkerRecord>>();
  readonly #file: string | undefined;
  readonly #clock: () => number;
  #last = -Infinity;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(opts: ToyBackendOptions = {}) {
    this.#file = opts.journalFile;
    // The default is captured here, once, so the callers' later changes to the global clock cannot reach the store.
    const injected = opts.clock;
    this.#clock = injected ? () => injected.now() : Date.now;
    if (this.#file !== undefined && existsSync(this.#file)) this.#replay(this.#file);
  }

  /** Integer milliseconds that never go backwards, even if the clock underneath does. */
  serverNow(): number {
    this.#last = Math.max(this.#last, Math.floor(this.#clock()));
    return this.#last;
  }

  /**
   * One transaction at a time (a promise chain is the single-writer lock). Writes apply to the live data while
   * an undo list records how to reverse them; a throw runs the undo list, so nothing half-done stays. A commit
   * appends the redo entries to the journal before the caller hears back. The toy guarantees the
   * write reached the operating system, not the disk: there is no fsync, so a power cut can lose it.
   */
  transact<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    const turn = this.#tail.then(() => this.#run(fn));
    this.#tail = turn.catch(() => undefined);
    return turn;
  }

  async #run<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    // Yield once so concurrent callers really interleave; a race test that never yields proves nothing.
    await sleepOneTurn();
    const redo: Entry[] = [];
    const undo: Array<() => void> = [];
    const rollback = (): void => {
      for (const step of undo.reverse()) step();
    };
    try {
      const result = await fn(this.#tx(redo, undo));
      // REPLACE-ME: a real commit is durable before it is acknowledged: SQL COMMIT with synchronous_commit on (the WAL is fsynced), Redis appendfsync always, Mongo writeConcern j: true.
      if (redo.length > 0 && this.#file !== undefined) await appendFile(this.#file, `${JSON.stringify(redo, replacer)}\n`);
      return result;
    } catch (err) {
      rollback();
      throw err;
    }
  }

  #data(scope: Scope): ScopeData {
    const key = scopeKey(scope);
    let data = this.#scopes.get(key);
    if (!data) this.#scopes.set(key, (data = { jobs: new Map(), history: new Map(), attempts: new Map(), seq: 0, low: 0, token: 0, paused: false, obliterating: false, schedules: new Map() }));
    return data;
  }

  #workersOf(namespace: string): Map<string, WorkerRecord> {
    let table = this.#workers.get(namespace);
    if (!table) this.#workers.set(namespace, (table = new Map()));
    return table;
  }

  #tx(redo: Entry[], undo: Array<() => void>): Tx {
    const counter = (scope: Scope, name: 'seq' | 'low' | 'token', next: (n: number) => number): number => {
      const data = this.#data(scope);
      const before = data[name];
      data[name] = next(before);
      undo.push(() => void (data[name] = before));
      redo.push(['counter', scopeKey(scope), name, data[name]]);
      return data[name];
    };
    const setAttempts = (scope: Scope, jobId: string, rows: StoredAttempt[] | null): void => {
      const attempts = this.#data(scope).attempts;
      const before = attempts.get(jobId);
      if (rows) attempts.set(jobId, structuredClone(rows));
      else attempts.delete(jobId);
      undo.push(() => void (before ? attempts.set(jobId, before) : attempts.delete(jobId)));
      redo.push(['att', scopeKey(scope), jobId, rows]);
    };
    return {
      get: (scope, id) => {
        const rec = this.#data(scope).jobs.get(id);
        return rec && structuredClone(rec);
      },
      put: (scope, rec) => {
        const jobs = this.#data(scope).jobs;
        const before = jobs.get(rec.id);
        jobs.set(rec.id, structuredClone(rec));
        undo.push(() => void (before ? jobs.set(rec.id, before) : jobs.delete(rec.id)));
        redo.push(['put', scopeKey(scope), rec]);
      },
      delete: (scope, id) => {
        const jobs = this.#data(scope).jobs;
        const before = jobs.get(id);
        if (!before) return;
        jobs.delete(id);
        undo.push(() => void jobs.set(id, before));
        redo.push(['del', scopeKey(scope), id]);
      },
      scan: (scope, filter) => this.#scan(scope, filter),
      nextSeq: (scope) => counter(scope, 'seq', (n) => n + 1),
      lowSeq: (scope) => counter(scope, 'low', (n) => n - 1),
      nextToken: (scope) => counter(scope, 'token', (n) => n + 1),
      putHistory: (scope, rec) => {
        const history = this.#data(scope).history;
        history.set(rec.id, structuredClone(rec));
        undo.push(() => void history.delete(rec.id));
        redo.push(['hist', scopeKey(scope), rec]);
        const from = rec.id.slice(0, rec.id.lastIndexOf('#'));
        const rows = this.#data(scope).attempts.get(from);
        if (rows) {
          setAttempts(scope, rec.id, rows);
          setAttempts(scope, from, null);
        }
      },
      getHistory: (scope, id) => {
        const rec = this.#data(scope).history.get(id);
        return rec && structuredClone(rec);
      },
      scanHistory: (scope) => [...this.#data(scope).history.values()].map((rec) => structuredClone(rec)),
      deleteHistory: (scope, id) => {
        const { history } = this.#data(scope);
        const before = history.get(id);
        if (!before) return;
        history.delete(id);
        undo.push(() => void history.set(id, before));
        redo.push(['delhist', scopeKey(scope), id]);
        setAttempts(scope, id, null);
      },
      getAttempts: (scope, jobId) => structuredClone(this.#data(scope).attempts.get(jobId) ?? []),
      setAttempts,
      getFlag: (scope, flag) => this.#data(scope)[flag],
      setFlag: (scope, flag, value) => {
        const data = this.#data(scope);
        const before = data[flag];
        data[flag] = value;
        undo.push(() => void (data[flag] = before));
        redo.push([flag, scopeKey(scope), value]);
      },
      clearHistory: (scope) => {
        const data = this.#data(scope);
        const { history, attempts } = data;
        const rows = [...history.keys()].map((id) => [id, attempts.get(id)] as const);
        for (const [id] of rows) attempts.delete(id);
        data.history = new Map();
        undo.push(() => {
          data.history = history;
          for (const [id, r] of rows) if (r) attempts.set(id, r);
        });
        redo.push(['unhist', scopeKey(scope)]);
      },
      putTombstone: (key, t) => {
        const before = this.#tombstones.get(key);
        this.#tombstones.set(key, { ...t });
        undo.push(() => void (before ? this.#tombstones.set(key, before) : this.#tombstones.delete(key)));
        redo.push(['tomb', key, t]);
      },
      getTombstone: (key) => {
        const t = this.#tombstones.get(key);
        return t && { ...t };
      },
      getSchedule: (scope, key) => {
        const rec = this.#data(scope).schedules.get(key);
        return rec && structuredClone(rec);
      },
      putSchedule: (scope, rec) => {
        const schedules = this.#data(scope).schedules;
        const before = schedules.get(rec.key);
        schedules.set(rec.key, structuredClone(rec));
        undo.push(() => void (before ? schedules.set(rec.key, before) : schedules.delete(rec.key)));
        redo.push(['sched', scopeKey(scope), rec]);
      },
      deleteSchedule: (scope, key) => {
        const schedules = this.#data(scope).schedules;
        const before = schedules.get(key);
        if (!before) return;
        schedules.delete(key);
        undo.push(() => void schedules.set(key, before));
        redo.push(['unsched', scopeKey(scope), key]);
      },
      scanSchedules: (scope, { afterKey, dueAtMost, paused, order = 'key', limit }) =>
        [...this.#data(scope).schedules.values()]
          .filter((rec) => afterKey === undefined || rec.key > afterKey)
          .filter((rec) => dueAtMost === undefined || rec.nextRunAt <= dueAtMost || rec.queuedTicks.length > 0)
          .filter((rec) => paused === undefined || !rec.paused)
          .sort((a, b) => (order === 'nextRunAt' && a.nextRunAt !== b.nextRunAt ? a.nextRunAt - b.nextRunAt : a.key < b.key ? -1 : 1))
          .slice(0, limit)
          .map((rec) => structuredClone(rec)),
      getMeta: (ns) => {
        const meta = this.#meta.get(ns);
        return meta && { ...meta };
      },
      putMeta: (ns, meta) => {
        const before = this.#meta.get(ns);
        this.#meta.set(ns, { ...meta });
        undo.push(() => void (before ? this.#meta.set(ns, before) : this.#meta.delete(ns)));
        redo.push(['meta', ns, meta]);
      },
      getWorker: (ns, workerId) => {
        const rec = this.#workersOf(ns).get(workerId);
        return rec && structuredClone(rec);
      },
      putWorker: (ns, rec) => {
        const table = this.#workersOf(ns);
        const before = table.get(rec.workerId);
        table.set(rec.workerId, structuredClone(rec));
        undo.push(() => void (before ? table.set(rec.workerId, before) : table.delete(rec.workerId)));
        redo.push(['wput', ns, rec]);
      },
      deleteWorker: (ns, workerId) => {
        const table = this.#workersOf(ns);
        const before = table.get(workerId);
        if (!before) return;
        table.delete(workerId);
        undo.push(() => void table.set(workerId, before));
        redo.push(['wdel', ns, workerId]);
      },
      scanWorkers: (ns) => [...this.#workersOf(ns).values()].map((rec) => structuredClone(rec)),
    };
  }

  // REPLACE-ME: this reads every job of the queue; a database answers from an index instead (SQL a partial index per state, Redis a sorted set, Mongo a compound index).
  #scan(scope: Scope, f: ScanFilter): JobRecord[] {
    const hits: JobRecord[] = [];
    const data = this.#data(scope);
    for (const rec of f.history ? [...data.jobs.values(), ...data.history.values()] : data.jobs.values()) {
      if (f.state !== undefined && rec.state !== f.state) continue;
      if (f.names && !f.names.includes(rec.name)) continue;
      if (f.holdsKey !== undefined && !(rec.singletonHeld && rec.singletonKey === f.holdsKey)) continue;
      if (f.runAtAtMost !== undefined && rec.runAt > f.runAtAtMost) continue;
      if (f.leaseExpiresAtAtMost !== undefined && !(rec.lease && rec.lease.expiresAt <= f.leaseExpiresAtAtMost)) continue;
      if (f.claim && !(rec.lease && rec.lease.owner === f.claim.owner && rec.lease.claimId === f.claim.claimId)) continue;
      if (f.formatAtMost !== undefined && rec.formatVersion > f.formatAtMost) continue;
      const dl = f.deadLetter;
      if (dl && !(rec.deadLetter && (dl.reason === undefined || rec.deadLetter.reason === dl.reason) && (dl.atAtMost === undefined || rec.deadLetter.at <= dl.atAtMost))) continue;
      hits.push(rec);
    }
    const order = f.order ?? { by: 'seq', dir: 'asc' };
    if (order.by === 'queue') {
      const fifo = order.dir === 'fifo' ? 1 : -1;
      hits.sort((a, b) => b.priority - a.priority || fifo * (a.seq - b.seq));
    } else {
      const dir = order.dir === 'asc' ? 1 : -1;
      const by = order.by;
      const value = (r: JobRecord): number => (by === 'leaseExpiresAt' ? r.lease?.expiresAt : by === 'deadLetterAt' ? r.deadLetter?.at : r[by]) ?? -Infinity;
      hits.sort((a, b) => dir * (value(a) - value(b) || a.seq - b.seq));
    }
    const start = f.offset ?? 0;
    return hits.slice(start, f.limit === undefined ? undefined : start + f.limit).map((rec) => structuredClone(rec));
  }

  /**
   * Rebuild the data from the journal. Only a torn last line (a crash mid-append) is dropped, since nothing after it
   * was acknowledged; an unreadable line in the middle means lost acknowledged writes, so it fails loudly.
   */
  #replay(file: string): void {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    for (const [i, line] of lines.entries()) {
      let entries: Entry[];
      try {
        entries = JSON.parse(line, reviver) as Entry[];
      } catch (err) {
        if (i === lines.length - 1) break;
        throw new StoreError(`journal ${file} is corrupt at line ${i + 1}`, { operation: 'replay', retryable: false, outcomeUnknown: false, cause: err });
      }
      for (const entry of entries) this.#apply(entry);
    }
  }

  #apply(entry: Entry): void {
    const data = (key: string): ScopeData => {
      const [namespace = '', queue = ''] = key.split('\u0000');
      return this.#data({ namespace, queue });
    };
    switch (entry[0]) {
      case 'put':
        data(entry[1]).jobs.set(entry[2].id, entry[2]);
        break;
      case 'del':
        data(entry[1]).jobs.delete(entry[2]);
        break;
      case 'hist':
        data(entry[1]).history.set(entry[2].id, entry[2]);
        break;
      case 'att':
        if (entry[3]) data(entry[1]).attempts.set(entry[2], entry[3]);
        else data(entry[1]).attempts.delete(entry[2]);
        break;
      case 'counter':
        data(entry[1])[entry[2]] = entry[3];
        break;
      case 'paused':
      case 'obliterating':
        data(entry[1])[entry[0]] = entry[2];
        break;
      case 'delhist':
        data(entry[1]).history.delete(entry[2]);
        break;
      case 'unhist': {
        const d = data(entry[1]);
        for (const id of d.history.keys()) d.attempts.delete(id);
        d.history = new Map();
        break;
      }
      case 'tomb':
        this.#tombstones.set(entry[1], entry[2]);
        break;
      case 'sched':
        data(entry[1]).schedules.set(entry[2].key, entry[2]);
        break;
      case 'unsched':
        data(entry[1]).schedules.delete(entry[2]);
        break;
      case 'meta':
        this.#meta.set(entry[1], entry[2]);
        break;
      case 'wput':
        this.#workersOf(entry[1]).set(entry[2].workerId, entry[2]);
        break;
      case 'wdel':
        this.#workersOf(entry[1]).delete(entry[2]);
        break;
    }
  }
}
