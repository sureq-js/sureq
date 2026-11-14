import { describe, expect, it } from 'vitest';
import { StoreRequestError } from '../../src/errors/catalog.js';
import { defineCapabilities } from '../../src/store/capabilities.js';
import type { JobState } from '../../src/store/contract.js';
import { canMove, effective } from '../../src/store/memory/transitions.js';
import {
  checkAdd, checkClaim, checkComplete, checkFail, checkId, checkIdRequest, checkList, checkNamespace, checkPaused, checkScope, checkSweep,
  checkUpdate,
} from '../../src/store/memory/validate.js';

const limits = defineCapabilities({}).limits;
const job = (over: Record<string, unknown> = {}) => ({ id: 'a', data: '{}', formatVersion: 1, maxAttempts: 3, ...over });
const add = (over: Record<string, unknown> = {}, opts?: unknown) => () => checkAdd([job(over)], opts, limits);
const list = (over: Record<string, unknown> = {}) => () => checkList({ state: 'waiting', offset: 0, limit: 10, order: 'asc', ...over });
const update = (over: Record<string, unknown> = {}) => () => checkUpdate({ id: 'a', expectedRev: 1, patch: { priority: 1 }, ...over });
const claim = (over: Record<string, unknown> = {}) => () =>
  checkClaim({ workerId: 'w', limit: 1, leaseMs: 1000, claimId: 'c', ...over }, limits);
const complete = (over: Record<string, unknown> = {}) => () => checkComplete({ id: 'a', token: 1, result: null, ...over });
const fail = (over: Record<string, unknown> = {}) => () => checkFail({ id: 'a', token: 1, error: 'e', ...over });

const rejects = (fn: () => void, op: string) => {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(StoreRequestError);
  expect((caught as StoreRequestError).operation).toBe(op);
};

const invalid: Array<[string, string, () => void]> = [
  ['scope missing', 'get', () => checkScope('get', undefined)],
  ['scope empty namespace', 'get', () => checkScope('get', { namespace: '', queue: 'q' })],
  ['scope empty queue', 'get', () => checkScope('get', { namespace: 'n', queue: '' })],
  ['scope extra key', 'get', () => checkScope('get', { namespace: 'n', queue: 'q', x: 1 })],
  ['add jobs not an array', 'add', () => checkAdd('x', undefined, limits)],
  ['add element not an object', 'add', () => checkAdd([null], undefined, limits)],
  ['add empty id', 'add', add({ id: '' })],
  ['add id of 256 bytes', 'add', add({ id: 'a'.repeat(256) })],
  ['add id of 256 bytes in two-byte chars', 'add', add({ id: 'é'.repeat(128) })],
  ['add delayMs -1', 'add', add({ delayMs: -1 })],
  ['add delayMs 1.5', 'add', add({ delayMs: 1.5 })],
  ['add delayMs NaN', 'add', add({ delayMs: Number.NaN })],
  ['add delayMs 2 ** 53', 'add', add({ delayMs: 2 ** 53 })],
  ['add runAt 1.5', 'add', add({ runAt: 1.5 })],
  ['add maxAttempts 0', 'add', add({ maxAttempts: 0 })],
  ['add maxAttempts 1.5', 'add', add({ maxAttempts: 1.5 })],
  ['add priority 1.5', 'add', add({ priority: 1.5 })],
  ['add first not a boolean', 'add', add({ first: 'x' })],
  ['add data a number', 'add', add({ data: 5 })],
  ['add backoff a number', 'add', add({ backoff: 5 })],
  ['add uniqueWhile bogus', 'add', add({ uniqueWhile: 'x' })],
  ['add onDuplicate bogus', 'add', add({ onDuplicate: 'x' })],
  ['add formatVersion 0', 'add', add({ formatVersion: 0 })],
  ['add name a number', 'add', add({ name: 1 })],
  ['add singletonKey empty', 'add', add({ singletonKey: '' })],
  ['add atomic not a boolean', 'add', add({}, { atomic: 'y' })],
  ['add opts not an object', 'add', add({}, 'y')],
  ['list state bogus', 'list', list({ state: 'bogus' })],
  ['list offset -1', 'list', list({ offset: -1 })],
  ['list limit 0', 'list', list({ limit: 0 })],
  ['list limit 1001', 'list', list({ limit: 1001 })],
  ['list order missing', 'list', list({ order: undefined })],
  ['list orderBy id', 'list', list({ orderBy: 'id' })],
  ['update expectedRev 0', 'update', update({ expectedRev: 0 })],
  ['update expectedRev 1.5', 'update', update({ expectedRev: 1.5 })],
  ['update empty patch', 'update', update({ patch: {} })],
  ['update patch delayMs and runAt', 'update', update({ patch: { delayMs: 1, runAt: 5 } })],
  ['update patch priority 1.5', 'update', update({ patch: { priority: 1.5 } })],
  ['update patch data a number', 'update', update({ patch: { data: 1 } })],
  ['cancel empty id', 'cancel', () => checkIdRequest('cancel', { id: '' })],
  ['remove empty id', 'remove', () => checkIdRequest('remove', { id: '' })],
  ['claim limit 0', 'claim', claim({ limit: 0 })],
  ['claim limit 1001', 'claim', claim({ limit: 1001 })],
  ['claim limit 1.5', 'claim', claim({ limit: 1.5 })],
  ['claim leaseMs 0', 'claim', claim({ leaseMs: 0 })],
  ['claim leaseMsByName 0', 'claim', claim({ leaseMsByName: { a: 0 } })],
  ['claim names a string', 'claim', claim({ names: 'a' })],
  ['claim order bogus', 'claim', claim({ order: 'x' })],
  ['claim empty workerId', 'claim', claim({ workerId: '' })],
  ['claim empty claimId', 'claim', claim({ claimId: '' })],
  ['complete token -1', 'complete', complete({ token: -1 })],
  ['complete token 1.5', 'complete', complete({ token: 1.5 })],
  ['complete token a string', 'complete', complete({ token: '1' })],
  ['complete result missing', 'complete', complete({ result: undefined })],
  ['fail error missing', 'fail', fail({ error: undefined })],
  ['fail retryInMs -1', 'fail', fail({ retryInMs: -1 })],
  ['fail retryInMs 1.5', 'fail', fail({ retryInMs: 1.5 })],
  ['pause flag not a boolean', 'setPaused', () => checkPaused('yes')],
];

describe('memory store request validation', () => {
  it.each(invalid)('contract: invalid arguments throw StoreRequestError before any change (%s)', (_label, op, fn) => {
    rejects(fn, op);
  });

  it('contract: add with delayMs and runAt together throws StoreRequestError', () => {
    rejects(add({ delayMs: 10, runAt: 5000 }), 'add');
  });

  it.each(['hold', 'history', 'retention'])('contract: unknown request fields are rejected (%s)', (key) => {
    rejects(add({ [key]: 1 }), 'add');
    rejects(claim({ [key]: 1 }), 'claim');
    rejects(update({ patch: { priority: 1, [key]: 1 } }), 'update');
    rejects(update({ [key]: 1 }), 'update');
    rejects(list({ [key]: 1 }), 'list');
    rejects(() => checkIdRequest('cancel', { id: 'a', [key]: 1 }), 'cancel');
    rejects(() => checkIdRequest('remove', { id: 'a', [key]: 1 }), 'remove');
    rejects(complete({ [key]: 1 }), 'complete');
    rejects(fail({ [key]: 1 }), 'fail');
  });

  it('contract: maxFormat on claim and sweep is an integer from 1', () => {
    const sweep = (over: Record<string, unknown>) => () => checkSweep({ limit: 1, maxCrashes: 1, failError: 'f', poisonError: 'p', ...over }, limits);
    expect(claim({ maxFormat: 1 })).not.toThrow();
    expect(sweep({ maxFormat: 3 })).not.toThrow();
    for (const v of [0, 1.5, '1', null]) {
      rejects(claim({ maxFormat: v }), 'claim');
      rejects(sweep({ maxFormat: v }), 'sweep');
    }
    rejects(() => checkNamespace('getNamespaceMeta', { namespace: '' }), 'getNamespaceMeta');
    rejects(() => checkNamespace('getNamespaceMeta', { namespace: 'n', queue: 'q' }), 'getNamespaceMeta');
  });

  it('contract: dataVersion is not a patchable field', () => {
    rejects(update({ patch: { dataVersion: 2 } }), 'update');
  });

  it('memstore: id limit counts UTF-8 bytes', () => {
    expect(() => checkId('get', 'a'.repeat(255), 255)).not.toThrow();
    expect(() => checkId('get', 'é'.repeat(127) + 'a', 255)).not.toThrow();
    rejects(() => checkId('get', 'a'.repeat(256), 255), 'get');
    rejects(() => checkId('get', 'é'.repeat(127) + 'ab', 255), 'get');
    expect(() => checkId('get', 'a'.repeat(300))).not.toThrow();
    rejects(() => checkId('get', 5), 'get');
  });

  it('memstore: valid minimal requests pass every check', () => {
    expect(() => checkScope('get', { namespace: 'n', queue: 'q' })).not.toThrow();
    expect(() => checkAdd([], undefined, limits)).not.toThrow();
    expect(add()).not.toThrow();
    expect(add({ delayMs: 0 }, { atomic: true })).not.toThrow();
    expect(add({ runAt: 0, name: null, priority: -3, first: true, dataVersion: null, backoff: null })).not.toThrow();
    expect(
      add({
        data: new Uint8Array([1]), backoff: new Uint8Array([2]), name: 'x', dataVersion: 2, idempotencyKey: 'k',
        uniqueWhile: 'retained', onDuplicate: 'ignore', singletonKey: 's',
      }),
    ).not.toThrow();
    expect(list()).not.toThrow();
    expect(list({ state: 'completed', orderBy: 'finishedAt', order: 'desc', limit: 1000 })).not.toThrow();
    expect(update()).not.toThrow();
    expect(update({ patch: { data: new Uint8Array(0), delayMs: 0 } })).not.toThrow();
    expect(() => checkIdRequest('cancel', { id: 'a' })).not.toThrow();
    expect(claim({ names: [] })).not.toThrow();
    expect(claim({ names: [null, 'a'], order: 'lifo', leaseMsByName: { a: 1 }, limit: 1000 })).not.toThrow();
    expect(complete()).not.toThrow();
    expect(complete({ token: 0, result: new Uint8Array([1]) })).not.toThrow();
    expect(fail({ retryInMs: 0 })).not.toThrow();
    expect(fail({ error: new Uint8Array(0) })).not.toThrow();
    expect(() => checkPaused(false)).not.toThrow();
  });

  it('memstore: transition table', () => {
    const states: JobState[] = ['waiting', 'delayed', 'active', 'completed', 'failed', 'cancelled'];
    const allowed = new Set([
      'delayed>waiting', 'delayed>cancelled',
      'waiting>active', 'waiting>delayed', 'waiting>cancelled',
      'active>completed', 'active>failed', 'active>delayed', 'active>waiting', 'active>cancelled',
      'failed>waiting', 'failed>delayed',
    ]);
    let checked = 0;
    for (const from of states) {
      for (const to of states) {
        expect.soft(canMove(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
        checked++;
      }
    }
    expect(checked).toBe(36);
    expect(effective({ state: 'delayed', runAt: 100 }, 99)).toBe('delayed');
    expect(effective({ state: 'delayed', runAt: 100 }, 100)).toBe('waiting');
    expect(effective({ state: 'active', runAt: 100 }, 200)).toBe('active');
  });
});
