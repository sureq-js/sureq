import { StoreFormatError } from '../../errors/catalog.js';

/** The record layout this release writes. */
export const FORMAT_VERSION = 1 as const;

export const RECORD_KINDS = ['job', 'attempt', 'schedule', 'settings', 'meta'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Mark a new record with the current format version. */
export function stamp<T extends object>(_kind: RecordKind, fields: T): T & { formatVersion: 1 } {
  return { ...fields, formatVersion: FORMAT_VERSION };
}

/** Upgraders by the version they read. Version 1 is read as is. */
export type Readers = Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>;
const BUILT_IN_READERS: Readers = { 1: (raw) => raw };

/**
 * Check a stored record's format version. Version 1 returns the same object, unknown
 * fields intact; an older version with a reader is upgraded in memory only; anything else throws
 * StoreFormatError. `opts` exists only so tests can simulate a later release.
 */
export function parseRecord<T>(kind: RecordKind, raw: unknown, opts: { current?: number; readers?: Readers } = {}): T {
  const current = opts.current ?? FORMAT_VERSION;
  const readers = opts.readers ?? BUILT_IN_READERS;
  const v = checkStamp(kind, raw, current);
  const base = errorBase(kind, raw, current);
  if (v > current) throw new StoreFormatError({ reason: 'too-new', found: v, ...base });
  const reader = readers[v];
  if (!reader) throw new StoreFormatError({ reason: 'too-old', found: v, ...base });
  return reader(raw as Record<string, unknown>) as T;
}

/** The record's format version when it is a structurally valid stamp (an integer from 1); else StoreFormatError `missing`. */
export function checkStamp(kind: RecordKind, raw: unknown, supported: number = FORMAT_VERSION): number {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['formatVersion'] : undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new StoreFormatError({ reason: 'missing', found: null, ...errorBase(kind, raw, supported) });
  }
  return v;
}

function errorBase(kind: RecordKind, raw: unknown, supported: number): { supported: number; recordKind: RecordKind; recordId?: string } {
  const id = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['id'] : undefined;
  return { supported, recordKind: kind, ...(typeof id === 'string' && { recordId: id }) };
}
