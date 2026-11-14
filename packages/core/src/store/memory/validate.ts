import { StoreRequestError } from '../../errors/catalog.js';
import type { StoreCapabilities } from '../capabilities.js';
import type {
  CancelRequest, ClaimRequest, CleanRequest, CompleteRequest, DeleteScheduleRequest, EnsureNamespaceMetaRequest, FailRequest, FireScheduleRequest, GetAttemptsRequest,
  HeartbeatWorkerRequest, ListRequest, ListSchedulesRequest, NamespaceScope, NewJob, ObliterateRequest, Payload, PutScheduleRequest, RedriveRequest,
  RegisterWorkerRequest, ReleaseRequest, RenewRequest, Scope, SetProgressRequest, SweepRequest, UpdateRequest,
} from '../contract.js';
import type { StoreOp } from './hooks.js';
import { STATES } from './transitions.js';

// Every check throws StoreRequestError before the store reads or writes anything.

const SCOPE_KEYS = ['namespace', 'queue'];
const NEW_JOB_KEYS = [
  'id', 'name', 'data', 'dataVersion', 'formatVersion', 'priority', 'first', 'delayMs', 'runAt', 'maxAttempts', 'backoff', 'timeout',
  'idempotencyKey', 'uniqueWhile', 'onDuplicate', 'singletonKey', 'defaulted', 'keep',
];
const DEFAULTED = ['priority', 'maxAttempts', 'backoff'];
const ADD_OPTS_KEYS = ['atomic'];
const LIST_KEYS = ['state', 'offset', 'limit', 'orderBy', 'order', 'deadLetter', 'name'];
const UPDATE_KEYS = ['id', 'expectedRev', 'patch'];
const PATCH_KEYS = ['data', 'priority', 'delayMs', 'runAt'];
const CLAIM_KEYS = ['workerId', 'limit', 'leaseMs', 'leaseMsByName', 'names', 'order', 'claimId', 'hold', 'maxFormat', 'history'];
const COMPLETE_KEYS = ['id', 'token', 'result', 'history', 'retention'];
const FAIL_KEYS = ['id', 'token', 'error', 'retryInMs', 'history', 'deadLetter', 'retention'];
const RENEW_KEYS = ['id', 'token', 'leaseMs', 'started', 'batchId'];
const SWEEP_KEYS = ['limit', 'maxCrashes', 'failError', 'poisonError', 'maxFormat', 'history', 'deadLetter', 'retention'];
const ENSURE_META_KEYS = ['current', 'minReadable', 'maxReadable', 'sureqVersion'];
const RELEASE_KEYS = ['id', 'token', 'delayMs', 'refundAttempt', 'handlerStarted', 'reason', 'history'];
const CANCEL_KEYS = ['id', 'history', 'retention'];
const GET_ATTEMPTS_KEYS = ['id', 'limit', 'cursor'];
const ORDER_BY = ['seq', 'runAt', 'startedAt', 'finishedAt', 'deadLetterAt'];
const REDRIVE_KEYS = ['ids', 'filter', 'resetAttempts', 'delayMs', 'priority', 'limit'];
const DEAD_LETTER_REASONS = ['exhausted', 'unrecoverable', 'retryRejected', 'crashLimit', 'legacy'];
/** The reasons core may send on `fail`; the store derives `crashLimit`, and `legacy` marks an absent field. */
const FAIL_REASONS = ['exhausted', 'unrecoverable', 'retryRejected'];
const SET_PROGRESS_KEYS = ['id', 'token', 'progress', 'field'];
const MAX_LIST_LIMIT = 1000;
const SCHEDULE_KEYS = [
  'formatVersion', 'key', 'kind', 'cron', 'tz', 'everyMs', 'anchorAt', 'template', 'overlap', 'maxQueued', 'paused', 'nextRunAt',
  'lastFiredFor', 'lastJobId', 'queuedTicks', 'runCount', 'definitionHash', 'definitionVersion',
];
const MAX_SCHEDULE_KEY_BYTES = 200;
const HISTORY_KEY = /#-?\d+$/;

const encoder = new TextEncoder();
type Fields = Record<string, unknown>;

export function bad(op: StoreOp, message: string): never {
  throw new StoreRequestError(message, { operation: op });
}

/** A plain object whose keys are all in `allowed`; a key set to `undefined` counts as absent. */
function fields(op: StoreOp, what: string, v: unknown, allowed: readonly string[]): asserts v is Fields {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(op, `${what} must be an object`);
  for (const [key, value] of Object.entries(v)) if (value !== undefined && !allowed.includes(key)) bad(op, `unknown field ${what}.${key}`);
}

function int(op: StoreOp, name: string, v: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) {
    bad(op, `${name} must be an integer from ${min} to ${max}`);
  }
}

const isPayload = (v: unknown): v is Payload => typeof v === 'string' || v instanceof Uint8Array;

function payload(op: StoreOp, name: string, v: unknown, nullable: boolean): void {
  if (!isPayload(v) && !(nullable && v === null)) bad(op, `${name} must be a string or Uint8Array${nullable ? ' or null' : ''}`);
}

function oneOf(op: StoreOp, name: string, v: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(v)) bad(op, `${name} must be one of ${allowed.join(', ')}`);
}

function optional(v: unknown, check: () => void): void {
  if (v !== undefined) check();
}

function optionalString(op: StoreOp, name: string, v: unknown): void {
  if (v !== undefined && v !== null && typeof v !== 'string') bad(op, `${name} must be a string or null`);
}

/** A safe integer number of milliseconds, at least `min`. */
export function checkDuration(op: StoreOp, name: string, v: unknown, min: number): asserts v is number {
  int(op, name, v, min);
}

export function checkScope(op: StoreOp, scope: unknown): asserts scope is Scope {
  fields(op, 'scope', scope, SCOPE_KEYS);
  for (const key of SCOPE_KEYS) {
    if (typeof scope[key] !== 'string' || scope[key] === '') bad(op, `scope.${key} must be a non-empty string`);
  }
}

/** A non-empty string, at most `maxIdBytes` UTF-8 bytes when given. */
export function checkId(op: StoreOp, id: unknown, maxIdBytes?: number, name = 'id'): asserts id is string {
  if (typeof id !== 'string' || id === '') bad(op, `${name} must be a non-empty string`);
  if (maxIdBytes !== undefined && encoder.encode(id).length > maxIdBytes) bad(op, `${name} must be at most ${maxIdBytes} UTF-8 bytes`);
}

function checkNewJob(job: unknown, maxIdBytes: number, op: StoreOp = 'add'): void {
  fields(op, 'job', job, NEW_JOB_KEYS);
  checkId(op, job['id'], maxIdBytes);
  // `id#<seq>` is the key a superseded record moves to, so a new job may not take one
  if (HISTORY_KEY.test(job['id'] as string)) bad(op, 'id must not end in "#" and digits');
  optionalString(op, 'name', job['name']);
  payload(op, 'data', job['data'], false);
  if (job['dataVersion'] !== undefined && job['dataVersion'] !== null) int(op, 'dataVersion', job['dataVersion']);
  int(op, 'formatVersion', job['formatVersion'], 1);
  optional(job['priority'], () => int(op, 'priority', job['priority']));
  optional(job['first'], () => oneOf(op, 'first', job['first'], [true, false]));
  optional(job['delayMs'], () => checkDuration(op, 'delayMs', job['delayMs'], 0));
  optional(job['runAt'], () => int(op, 'runAt', job['runAt'], 0));
  if (job['delayMs'] !== undefined && job['runAt'] !== undefined) bad(op, 'delayMs and runAt cannot both be set');
  int(op, 'maxAttempts', job['maxAttempts'], 1);
  optional(job['backoff'], () => payload(op, 'backoff', job['backoff'], true));
  optional(job['timeout'], () => payload(op, 'timeout', job['timeout'], true));
  optional(job['keep'], () => payload(op, 'keep', job['keep'], true));
  optionalString(op, 'idempotencyKey', job['idempotencyKey']);
  optional(job['uniqueWhile'], () => oneOf(op, 'uniqueWhile', job['uniqueWhile'], ['pending', 'retained']));
  optional(job['onDuplicate'], () => oneOf(op, 'onDuplicate', job['onDuplicate'], ['ignore', 'replace', 'reject']));
  const key = job['singletonKey'];
  if (key !== undefined && key !== null) checkId(op, key, maxIdBytes, 'singletonKey');
  const defaulted = job['defaulted'];
  if (defaulted !== undefined && (!Array.isArray(defaulted) || !defaulted.every((f) => DEFAULTED.includes(f)))) {
    bad(op, `defaulted must be an array of ${DEFAULTED.join(', ')}`);
  }
}

export function checkAdd(jobs: unknown, opts: unknown, limits: StoreCapabilities['limits']): asserts jobs is NewJob[] {
  if (opts !== undefined) {
    fields('add', 'opts', opts, ADD_OPTS_KEYS);
    optional(opts['atomic'], () => oneOf('add', 'atomic', opts['atomic'], [true, false]));
  }
  if (!Array.isArray(jobs)) bad('add', 'jobs must be an array');
  for (const job of jobs) checkNewJob(job, limits.maxIdBytes);
}

export function checkList(req: unknown): asserts req is ListRequest {
  fields('list', 'request', req, LIST_KEYS);
  oneOf('list', 'state', req['state'], STATES);
  int('list', 'offset', req['offset'], 0);
  int('list', 'limit', req['limit'], 1, MAX_LIST_LIMIT);
  optional(req['orderBy'], () => oneOf('list', 'orderBy', req['orderBy'], ORDER_BY));
  oneOf('list', 'order', req['order'], ['asc', 'desc']);
  optional(req['deadLetter'], () => {
    checkDeadLetterFilter('list', 'deadLetter', req['deadLetter']);
    if (req['state'] !== 'failed') bad('list', 'deadLetter needs state failed');
  });
  if (req['orderBy'] === 'deadLetterAt' && req['deadLetter'] === undefined) bad('list', 'orderBy deadLetterAt needs the deadLetter filter');
  optionalString('list', 'name', req['name']);
}

/** `{ reason?, olderThanMs? }`: dead letters of one reason, at least `olderThanMs` old. */
function checkDeadLetterFilter(op: StoreOp, what: string, v: unknown): void {
  fields(op, what, v, ['reason', 'olderThanMs']);
  optional(v['reason'], () => oneOf(op, `${what}.reason`, v['reason'], DEAD_LETTER_REASONS));
  optional(v['olderThanMs'], () => checkDuration(op, `${what}.olderThanMs`, v['olderThanMs'], 0));
}

/** The `deadLetter` field of `fail` (`reason?`, `keepMs?`) or `sweep` (`keepMs?` only): absent, `false` or an object. */
function checkDeadLetterExt(op: 'fail' | 'sweep', v: unknown): void {
  if (v === undefined || v === false) return;
  fields(op, 'deadLetter', v, op === 'fail' ? ['reason', 'keepMs'] : ['keepMs']);
  optional(v['reason'], () => oneOf(op, 'deadLetter.reason', v['reason'], FAIL_REASONS));
  optional(v['keepMs'], () => checkDuration(op, 'deadLetter.keepMs', v['keepMs'], 0));
}

/** Exactly one of `ids` (at most `limit`, each a non-empty string) and `filter`; `limit` 1 to 1000. */
export function checkRedrive(req: unknown): asserts req is RedriveRequest {
  const op = 'redrive';
  fields(op, 'request', req, REDRIVE_KEYS);
  int(op, 'limit', req['limit'], 1, MAX_LIST_LIMIT);
  const { ids, filter } = req;
  if ((ids === undefined) === (filter === undefined)) bad(op, 'exactly one of ids and filter must be set');
  if (ids !== undefined) {
    if (!Array.isArray(ids)) bad(op, 'ids must be an array');
    for (const id of ids) checkId(op, id);
    if (ids.length > (req['limit'] as number)) bad(op, 'ids must have at most limit entries');
  } else checkDeadLetterFilter(op, 'filter', filter);
  optional(req['resetAttempts'], () => oneOf(op, 'resetAttempts', req['resetAttempts'], [true, false]));
  optional(req['delayMs'], () => checkDuration(op, 'delayMs', req['delayMs'], 0));
  optional(req['priority'], () => int(op, 'priority', req['priority']));
}

const CLEANABLE = ['completed', 'failed', 'cancelled', 'waiting', 'delayed'];
/** The largest page an admin call may ask for. */
const MAX_ADMIN_LIMIT = 5000;

/**
 * `state` one of the cleanable states, `olderThanMs` >= 0, `limit` 1 to 5000; `keepLast` (>= 0) or `retainExpired`, only
 * for a finished state; `name` or `excludeNames` (strings).
 */
export function checkClean(req: unknown): asserts req is CleanRequest {
  const op = 'clean';
  fields(op, 'request', req, ['state', 'olderThanMs', 'keepLast', 'retainExpired', 'name', 'excludeNames', 'limit']);
  oneOf(op, 'state', req['state'], CLEANABLE);
  optional(req['olderThanMs'], () => checkDuration(op, 'olderThanMs', req['olderThanMs'], 0));
  optional(req['keepLast'], () => int(op, 'keepLast', req['keepLast'], 0));
  optional(req['retainExpired'], () => oneOf(op, 'retainExpired', req['retainExpired'], [true, false]));
  optionalString(op, 'name', req['name']);
  const excluded = req['excludeNames'];
  if (excluded !== undefined && (!Array.isArray(excluded) || !excluded.every((n) => typeof n === 'string'))) bad(op, 'excludeNames must be an array of strings');
  if (req['name'] !== undefined && excluded !== undefined) bad(op, 'name and excludeNames cannot both be set');
  if (req['keepLast'] !== undefined && req['retainExpired'] === true) bad(op, 'keepLast and retainExpired cannot both be set');
  if ((req['keepLast'] !== undefined || req['retainExpired'] === true) && (req['state'] === 'waiting' || req['state'] === 'delayed')) {
    bad(op, 'keepLast and retainExpired need a finished state');
  }
  int(op, 'limit', req['limit'], 1, MAX_ADMIN_LIMIT);
}

export function checkObliterate(req: unknown): asserts req is ObliterateRequest {
  const op = 'obliterate';
  fields(op, 'request', req, ['force', 'limit']);
  optional(req['force'], () => oneOf(op, 'force', req['force'], [true, false]));
  int(op, 'limit', req['limit'], 1, MAX_ADMIN_LIMIT);
}

export function checkUpdate(req: unknown): asserts req is UpdateRequest {
  const op = 'update';
  fields(op, 'request', req, UPDATE_KEYS);
  checkId(op, req['id']);
  int(op, 'expectedRev', req['expectedRev'], 1);
  const patch = req['patch'];
  fields(op, 'patch', patch, PATCH_KEYS);
  if (Object.keys(patch).length === 0) bad(op, 'patch must set at least one field');
  optional(patch['data'], () => payload(op, 'data', patch['data'], false));
  optional(patch['priority'], () => int(op, 'priority', patch['priority']));
  optional(patch['delayMs'], () => checkDuration(op, 'delayMs', patch['delayMs'], 0));
  optional(patch['runAt'], () => int(op, 'runAt', patch['runAt'], 0));
  if (patch['delayMs'] !== undefined && patch['runAt'] !== undefined) bad(op, 'delayMs and runAt cannot both be set');
}

export function checkIdRequest(op: 'cancel' | 'remove', req: unknown): asserts req is { id: string } {
  fields(op, 'request', req, ['id']);
  checkId(op, req['id']);
}

export function checkStats(req: unknown): asserts req is Record<string, never> {
  fields('stats', 'request', req, []);
}

export function checkCancel(req: unknown): asserts req is CancelRequest {
  fields('cancel', 'request', req, CANCEL_KEYS);
  checkId('cancel', req['id']);
  checkHistory('cancel', req['history'], false);
  checkRetention('cancel', req['retention']);
}

/** The `retention` field of a finishing write: absent, or an object with `discard: true` or `retainMs` (>= 0), not both. */
function checkRetention(op: StoreOp, v: unknown): void {
  if (v === undefined) return;
  fields(op, 'retention', v, ['discard', 'retainMs']);
  optional(v['discard'], () => oneOf(op, 'retention.discard', v['discard'], [true]));
  optional(v['retainMs'], () => checkDuration(op, 'retention.retainMs', v['retainMs'], 0));
  if (v['discard'] !== undefined && v['retainMs'] !== undefined) bad(op, 'retention.discard and retention.retainMs cannot both be set');
}

/** `history`: absent, `false`, or `{ max?: integer >= 1 }`; on claim also `host?: string | null`. */
export function checkHistory(op: StoreOp, v: unknown, claim: boolean): void {
  if (v === undefined || v === false) return;
  fields(op, 'history', v, claim ? ['max', 'host'] : ['max']);
  optional(v['max'], () => int(op, 'history.max', v['max'], 1));
  optionalString(op, 'history.host', v['host']);
}

/** `cursor` is the decimal token of the last record a page returned. */
export function checkGetAttempts(req: unknown): asserts req is GetAttemptsRequest {
  const op = 'getAttempts';
  fields(op, 'request', req, GET_ATTEMPTS_KEYS);
  checkId(op, req['id']);
  optional(req['limit'], () => int(op, 'limit', req['limit'], 1, MAX_LIST_LIMIT));
  const cursor = req['cursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
    bad(op, 'cursor must be a decimal token');
  }
}

export function checkPaused(paused: unknown): asserts paused is boolean {
  if (typeof paused !== 'boolean') bad('setPaused', 'paused must be a boolean');
}

export function checkClaim(req: unknown, limits: StoreCapabilities['limits']): asserts req is ClaimRequest {
  const op = 'claim';
  fields(op, 'request', req, CLAIM_KEYS);
  checkId(op, req['workerId'], undefined, 'workerId');
  checkId(op, req['claimId'], undefined, 'claimId');
  int(op, 'limit', req['limit'], 1, limits.maxClaimLimit);
  checkDuration(op, 'leaseMs', req['leaseMs'], 1);
  const byName = req['leaseMsByName'];
  if (byName !== undefined) {
    if (typeof byName !== 'object' || byName === null || Array.isArray(byName)) bad(op, 'leaseMsByName must be an object');
    for (const [name, ms] of Object.entries(byName)) checkDuration(op, `leaseMsByName.${name}`, ms, 1);
  }
  const names = req['names'];
  if (names !== undefined && (!Array.isArray(names) || !names.every((n) => n === null || typeof n === 'string'))) {
    bad(op, 'names must be an array of strings or null');
  }
  optional(req['order'], () => oneOf(op, 'order', req['order'], ['fifo', 'lifo']));
  optional(req['maxFormat'], () => int(op, 'maxFormat', req['maxFormat'], 1));
  checkHistory(op, req['history'], true);
  optional(req['hold'], () => oneOf(op, 'hold', req['hold'], [true, false]));
}

function checkFenced(op: StoreOp, req: unknown, allowed: readonly string[]): asserts req is Fields {
  fields(op, 'request', req, allowed);
  checkId(op, req['id']);
  int(op, 'token', req['token'], 0);
}

export function checkComplete(req: unknown): asserts req is CompleteRequest {
  checkFenced('complete', req, COMPLETE_KEYS);
  payload('complete', 'result', req['result'], true);
  checkHistory('complete', req['history'], false);
  checkRetention('complete', req['retention']);
}

export function checkFail(req: unknown): asserts req is FailRequest {
  checkFenced('fail', req, FAIL_KEYS);
  payload('fail', 'error', req['error'], false);
  optional(req['retryInMs'], () => checkDuration('fail', 'retryInMs', req['retryInMs'], 0));
  checkHistory('fail', req['history'], false);
  checkDeadLetterExt('fail', req['deadLetter']);
  checkRetention('fail', req['retention']);
}

export function checkRenew(req: unknown): asserts req is RenewRequest {
  checkFenced('renew', req, RENEW_KEYS);
  checkDuration('renew', 'leaseMs', req['leaseMs'], 1);
  optional(req['started'], () => oneOf('renew', 'started', req['started'], [true, false]));
  if (req['batchId'] !== undefined) {
    checkId('renew', req['batchId'], undefined, 'batchId');
    if (req['started'] !== true) bad('renew', 'batchId needs started: true');
  }
}

export function checkSetProgress(req: unknown): asserts req is SetProgressRequest {
  checkFenced('setProgress', req, SET_PROGRESS_KEYS);
  payload('setProgress', 'progress', req['progress'], false);
  optional(req['field'], () => oneOf('setProgress', 'field', req['field'], ['progress', 'batchProgress']));
}

export function checkRelease(req: unknown): asserts req is ReleaseRequest {
  const op = 'release';
  checkFenced(op, req, RELEASE_KEYS);
  optional(req['delayMs'], () => checkDuration(op, 'delayMs', req['delayMs'], 0));
  oneOf(op, 'refundAttempt', req['refundAttempt'], [true, false]);
  oneOf(op, 'handlerStarted', req['handlerStarted'], [true, false]);
  optional(req['reason'], () => oneOf(op, 'reason', req['reason'], ['shutdown', 'pause']));
  checkHistory(op, req['history'], false);
}

export function checkSweep(req: unknown, limits: StoreCapabilities['limits']): asserts req is SweepRequest {
  const op = 'sweep';
  fields(op, 'request', req, SWEEP_KEYS);
  int(op, 'limit', req['limit'], 1, limits.maxClaimLimit);
  int(op, 'maxCrashes', req['maxCrashes'], 1);
  payload(op, 'failError', req['failError'], false);
  payload(op, 'poisonError', req['poisonError'], false);
  optional(req['maxFormat'], () => int(op, 'maxFormat', req['maxFormat'], 1));
  checkHistory(op, req['history'], false);
  checkDeadLetterExt(op, req['deadLetter']);
  checkRetention(op, req['retention']);
}

export function checkNamespace(op: StoreOp, ns: unknown): asserts ns is NamespaceScope {
  fields(op, 'scope', ns, ['namespace']);
  if (typeof ns['namespace'] !== 'string' || ns['namespace'] === '') bad(op, 'scope.namespace must be a non-empty string');
}

/** Format versions are integers from 1 with `minReadable <= current <= maxReadable`. */
export function checkEnsureMeta(req: unknown): asserts req is EnsureNamespaceMetaRequest {
  const op = 'ensureNamespaceMeta';
  fields(op, 'request', req, ENSURE_META_KEYS);
  for (const key of ['current', 'minReadable', 'maxReadable']) int(op, key, req[key], 1);
  const { current, minReadable, maxReadable } = req as unknown as EnsureNamespaceMetaRequest;
  if (minReadable > current || current > maxReadable) bad(op, 'versions must satisfy minReadable <= current <= maxReadable');
  checkId(op, req['sureqVersion'], undefined, 'sureqVersion');
}

/** A schedule key: non-empty, at most 200 UTF-8 bytes. */
export function checkScheduleKey(op: StoreOp, req: unknown, allowed: readonly string[] = ['key']): asserts req is { key: string } {
  fields(op, 'request', req, allowed);
  checkId(op, req['key'], MAX_SCHEDULE_KEY_BYTES, 'key');
}

function nullable(v: unknown, check: () => void): void {
  if (v !== null) check();
}

export function checkPutSchedule(req: unknown): asserts req is PutScheduleRequest {
  const op = 'putSchedule';
  fields(op, 'request', req, ['schedule', 'expectedRev']);
  nullable(req['expectedRev'], () => int(op, 'expectedRev', req['expectedRev'], 1));
  const s = req['schedule'];
  fields(op, 'schedule', s, SCHEDULE_KEYS);
  checkId(op, s['key'], MAX_SCHEDULE_KEY_BYTES, 'key');
  int(op, 'formatVersion', s['formatVersion'], 1);
  oneOf(op, 'kind', s['kind'], ['cron', 'every']);
  if (s['kind'] === 'cron' ? s['cron'] === undefined : s['everyMs'] === undefined) bad(op, `kind ${String(s['kind'])} needs ${s['kind'] === 'cron' ? 'cron' : 'everyMs'}`);
  for (const name of ['cron', 'tz']) optional(s[name], () => checkId(op, s[name], undefined, name));
  optional(s['everyMs'], () => int(op, 'everyMs', s['everyMs'], 1));
  optional(s['anchorAt'], () => int(op, 'anchorAt', s['anchorAt'], 0));
  const t = s['template'];
  fields(op, 'template', t, ['name', 'data', 'opts']);
  nullable(t['name'], () => checkId(op, t['name'], undefined, 'template.name'));
  payload(op, 'template.data', t['data'], false);
  fields(op, 'template.opts', t['opts'], Object.keys(t['opts'] ?? {}));
  oneOf(op, 'overlap', s['overlap'], ['skip', 'queue', 'allow']);
  int(op, 'maxQueued', s['maxQueued'], 1, 1000);
  oneOf(op, 'paused', s['paused'], [true, false]);
  int(op, 'nextRunAt', s['nextRunAt'], 0);
  nullable(s['lastFiredFor'], () => int(op, 'lastFiredFor', s['lastFiredFor'], 0));
  nullable(s['lastJobId'], () => checkId(op, s['lastJobId'], undefined, 'lastJobId'));
  const ticks = s['queuedTicks'];
  if (!Array.isArray(ticks) || !ticks.every((n) => Number.isSafeInteger(n))) bad(op, 'queuedTicks must be an array of integers');
  int(op, 'runCount', s['runCount'], 0);
  checkId(op, s['definitionHash'], undefined, 'definitionHash');
  int(op, 'definitionVersion', s['definitionVersion'], 0);
}

export function checkListSchedules(req: unknown): asserts req is ListSchedulesRequest {
  const op = 'listSchedules';
  fields(op, 'request', req, ['cursor', 'limit']);
  optional(req['cursor'], () => checkId(op, req['cursor'], undefined, 'cursor'));
  int(op, 'limit', req['limit'], 1, MAX_LIST_LIMIT);
}

export function checkDeleteSchedule(req: unknown): asserts req is DeleteScheduleRequest {
  const op = 'deleteSchedule';
  checkScheduleKey(op, req, ['key', 'expectedRev']);
  optional((req as Fields)['expectedRev'], () => int(op, 'expectedRev', (req as Fields)['expectedRev'], 1));
}

export function checkListDue(req: unknown): asserts req is { limit: number } {
  fields('listDueSchedules', 'request', req, ['limit']);
  int('listDueSchedules', 'limit', req['limit'], 1, MAX_LIST_LIMIT);
}

export function checkFire(req: unknown, limits: StoreCapabilities['limits']): asserts req is FireScheduleRequest {
  const op = 'fireSchedule';
  fields(op, 'request', req, ['key', 'expectedRev', 'mode', 'nextRunAt', 'job']);
  checkId(op, req['key'], MAX_SCHEDULE_KEY_BYTES, 'key');
  int(op, 'expectedRev', req['expectedRev'], 1);
  oneOf(op, 'mode', req['mode'], ['tick', 'backlog']);
  if (req['mode'] === 'tick') int(op, 'nextRunAt', req['nextRunAt'], 1);
  else if (req['nextRunAt'] !== undefined) bad(op, 'nextRunAt is only sent in tick mode');
  checkNewJob(req['job'], limits.maxIdBytes, op);
  const job = req['job'] as Fields;
  if (job['singletonKey'] !== undefined && job['singletonKey'] !== null) bad(op, 'a fired job takes no singletonKey');
}

const REGISTER_WORKER_KEYS = [
  'workerId', 'queues', 'names', 'concurrency', 'sureqVersion', 'formatVersion', 'heartbeatIntervalMs', 'host', 'pid', 'labels', 'scheduler',
];
const WORKER_STATUS = ['running', 'paused', 'draining'];

export function checkWorkerId(op: StoreOp, req: unknown): asserts req is { workerId: string } {
  fields(op, 'request', req, ['workerId']);
  checkId(op, req['workerId'], undefined, 'workerId');
}

export function checkRegisterWorker(req: unknown): asserts req is RegisterWorkerRequest {
  const op = 'registerWorker';
  fields(op, 'request', req, REGISTER_WORKER_KEYS);
  checkId(op, req['workerId'], undefined, 'workerId');
  const queues = req['queues'];
  if (!Array.isArray(queues) || !queues.every((q) => typeof q === 'string' && q !== '')) bad(op, 'queues must be an array of non-empty strings');
  const names = req['names'];
  if (names !== undefined && (!Array.isArray(names) || !names.every((n) => n === null || typeof n === 'string'))) {
    bad(op, 'names must be an array of strings or null');
  }
  int(op, 'concurrency', req['concurrency'], 1);
  checkId(op, req['sureqVersion'], undefined, 'sureqVersion');
  int(op, 'formatVersion', req['formatVersion'], 1);
  int(op, 'heartbeatIntervalMs', req['heartbeatIntervalMs'], 1);
  if (typeof req['host'] !== 'string') bad(op, 'host must be a string');
  nullable(req['pid'], () => int(op, 'pid', req['pid'], 0));
  const labels = req['labels'];
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels) || !Object.values(labels).every((v) => typeof v === 'string')) {
    bad(op, 'labels must be an object of strings');
  }
  oneOf(op, 'scheduler', req['scheduler'], [true, false]);
}

export function checkHeartbeatWorker(req: unknown): asserts req is HeartbeatWorkerRequest {
  const op = 'heartbeatWorker';
  fields(op, 'request', req, ['workerId', 'activeJobs', 'concurrency', 'status', 'scheduler']);
  checkId(op, req['workerId'], undefined, 'workerId');
  int(op, 'activeJobs', req['activeJobs'], 0);
  int(op, 'concurrency', req['concurrency'], 1);
  oneOf(op, 'status', req['status'], WORKER_STATUS);
  oneOf(op, 'scheduler', req['scheduler'], [true, false]);
}

export function checkListWorkers(req: unknown): asserts req is { queue?: string } {
  fields('listWorkers', 'request', req, ['queue']);
  optional(req['queue'], () => checkId('listWorkers', req['queue'], undefined, 'queue'));
}

export function checkPurgeWorkers(req: unknown): asserts req is { staleIntervals: number; limit: number } {
  fields('purgeWorkers', 'request', req, ['staleIntervals', 'limit']);
  int('purgeWorkers', 'staleIntervals', req['staleIntervals'], 0);
  int('purgeWorkers', 'limit', req['limit'], 1, MAX_LIST_LIMIT);
}
