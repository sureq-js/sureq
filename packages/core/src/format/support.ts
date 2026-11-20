import { StoreFormatError } from '../errors/catalog.js';
import { parseRecord, type Readers } from '../store/memory/format.js';

/** The stored record formats one release writes and reads. */
export interface FormatSupport {
  /** The format this release writes. */
  current: number;
  /** The oldest format it reads. */
  minReadable: number;
  /** The newest format it reads. */
  maxReadable: number;
}

/** This build's format support. */
export const FORMAT_SUPPORT: Readonly<FormatSupport> = Object.freeze({ current: 1, minReadable: 1, maxReadable: 1 });

/** This build's version; a test keeps it equal to package.json. */
export const SUREQ_VERSION = '1.0.1';

const minorOf = (v: string): [number, number] | undefined => {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};

/** Same MAJOR and MINOR at most one apart (PATCH ignored), also before 1.0. */
export function isAdjacent(a: string, b: string): boolean {
  const [x, y] = [minorOf(a), minorOf(b)];
  return x !== undefined && y !== undefined && x[0] === y[0] && Math.abs(x[1] - y[1]) <= 1;
}

/** The workers whose release is not adjacent to `own`. */
export function findSkew(own: string, workers: { workerId: string; sureqVersion: string }[]): { workerId: string; sureqVersion: string }[] {
  return workers.filter((w) => !isAdjacent(own, w.sureqVersion));
}

/** The refusal for a namespace stored at format `f`, or null when this release reads it. */
export function metaError(f: number, s: FormatSupport, sureqVersion: string): StoreFormatError | null {
  if (f >= s.minReadable && f <= s.maxReadable) return null;
  return new StoreFormatError({
    reason: f > s.maxReadable ? 'too-new' : 'too-old', found: f, supported: s.maxReadable, recordKind: 'meta',
    storeFormat: f, minReadable: s.minReadable, maxReadable: s.maxReadable, sureqVersion,
  });
}

/** Throws StoreFormatError (`recordKind: 'job'`, with `recordId`) for a job record this release cannot read. */
export function checkReadable(rec: { formatVersion: unknown; id?: string }, s: FormatSupport): void {
  const readers: Readers = {};
  for (let v = s.minReadable; v <= s.maxReadable; v++) readers[v] = (raw) => raw;
  parseRecord('job', rec, { current: s.maxReadable, readers });
}
