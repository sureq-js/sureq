import type { ConfigIssue } from '../errors/catalog.js';
import { validate, type Schema } from '../util/validate.js';
import { cronIssue, nextCronMatch, parseCron, type CronSpec } from './cron.js';
import { everyIssue, nextEveryOccurrence, parseEvery } from './interval.js';
import { tzIssue } from './zone.js';

/** When a schedule fires: a 5-field cron expression in an IANA zone (default `'UTC'`), or a fixed period. */
export type ScheduleTiming = { cron: string; tz?: string; every?: never } | { every: number | string; cron?: never; tz?: never };

/** A validated timing. */
export type Timing = { kind: 'cron'; cron: string; tz: string; spec: CronSpec } | { kind: 'every'; everyMs: number };

type Input = { cron?: unknown; tz?: unknown; every?: unknown };

/** Validate a timing; for a cron, it must have an occurrence after `nowMs`. Throws one InvalidOptionError with every issue. */
export function parseTiming(scope: string, input: unknown, nowMs: number): Timing {
  const schema: Schema<Input> = {
    fields: { cron: { kind: 'unknown' }, tz: { kind: 'unknown' }, every: { kind: 'unknown' } },
    check: ({ cron, tz, every }, add) => {
      if (cron === undefined && every === undefined) {
        add({ path: 'cron', code: 'missing_option', message: 'give either cron or every' });
        return;
      }
      if (cron !== undefined && every !== undefined) add({ path: 'every', code: 'conflict', message: 'give either cron or every, not both' });
      if (tz !== undefined && every !== undefined) add({ path: 'tz', code: 'conflict', message: 'tz applies only to cron' });
      const issues = (cron !== undefined ? [cronIssue(cron), tz === undefined ? undefined : tzIssue(tz)] : [everyIssue(every)])
        .filter((i): i is ConfigIssue => i !== undefined);
      issues.forEach(add);
      if (issues.length === 0 && cron !== undefined && every === undefined && nextCronMatch(parseCron(cron as string), (tz as string | undefined) ?? 'UTC', nowMs) === null) {
        add({ path: 'cron', code: 'invalid_value', reason: 'no-occurrence', message: 'no date matches within 9 years' });
      }
    },
  };
  const v = validate(scope, input, schema);
  if (v.every !== undefined) return { kind: 'every', everyMs: parseEvery(v.every as number | string) };
  const cron = v.cron as string;
  return { kind: 'cron', cron, tz: (v.tz as string | undefined) ?? 'UTC', spec: parseCron(cron) };
}

/** The first tick after `afterMs`; `anchorAt` places an `every` grid. Null when a cron has no match within 9 years. */
export function nextOccurrence(t: Timing, anchorAt: number, afterMs: number): number | null {
  return t.kind === 'cron' ? nextCronMatch(t.spec, t.tz, afterMs) : nextEveryOccurrence(t.everyMs, anchorAt, afterMs);
}

/** Up to `n` strictly increasing ticks after `afterMs`; fewer only when a cron runs out of matches. */
export function upcoming(t: Timing, anchorAt: number, afterMs: number, n: number): number[] {
  const out: number[] = [];
  for (let after = afterMs; out.length < n; ) {
    const next = nextOccurrence(t, anchorAt, after);
    if (next === null) break;
    out.push((after = next));
  }
  return out;
}
