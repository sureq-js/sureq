import { InvalidOptionError, type ConfigIssue } from '../errors/catalog.js';
import { validate, type Schema } from '../util/validate.js';

/** A log level, lowest to highest. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Structured fields of one log line, such as `{ queue, jobId }`. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Anything with these four methods can be SureQ's logger. */
export interface Logger {
  /** Log `msg` at `debug` level with optional fields. */
  debug(msg: string, fields?: LogFields): void;
  /** Log `msg` at `info` level with optional fields. */
  info(msg: string, fields?: LogFields): void;
  /** Log `msg` at `warn` level with optional fields. */
  warn(msg: string, fields?: LogFields): void;
  /** Log `msg` at `error` level with optional fields. */
  error(msg: string, fields?: LogFields): void;
}

/** The pino call shape: fields first, message second. Matched structurally; pino is not a dependency. */
export interface PinoLike {
  /** Pino's `debug(obj, msg)` call shape. */
  debug(obj: object, msg?: string): void;
  /** Pino's `info(obj, msg)` call shape. */
  info(obj: object, msg?: string): void;
  /** Pino's `warn(obj, msg)` call shape. */
  warn(obj: object, msg?: string): void;
  /** Pino's `error(obj, msg)` call shape. */
  error(obj: object, msg?: string): void;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const;

const consoleSchema: Schema<{ level: LogLevel | 'silent' }> = {
  fields: { level: { kind: 'enum', values: ['debug', 'info', 'warn', 'error', 'silent'], default: 'warn' } },
};

/**
 * Logger that writes to `console.*`, dropping messages below `level` (default `warn`). An unknown level or option
 * is an InvalidOptionError.
 */
export function consoleLogger(opts: { level?: LogLevel | 'silent' } = {}): Logger {
  const min = RANK[validate('consoleLogger', opts, consoleSchema).level];
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      if (RANK[level] < min) return;
      if (fields === undefined) console[level](msg);
      else console[level](msg, fields);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Adapt a pino (or pino-compatible) logger. */
export function pinoLogger(pino: PinoLike): Logger {
  return {
    debug: (msg, fields) => pino.debug(fields ?? {}, msg),
    info: (msg, fields) => pino.info(fields ?? {}, msg),
    warn: (msg, fields) => pino.warn(fields ?? {}, msg),
    error: (msg, fields) => pino.error(fields ?? {}, msg),
  };
}

const NOOP: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Resolve the `logger` option. The returned wrapper never throws and never awaits: a logger
 * failure must not break processing or become an unhandled rejection.
 */
export function createLogger(opt: Logger | false | undefined, level?: LogLevel): Logger {
  if (opt === false) return NOOP;
  const target = opt ?? consoleLogger({ level: level ?? 'warn' });
  const issues: ConfigIssue[] = LEVELS.filter((m) => typeof (target as unknown as Record<string, unknown>)[m] !== 'function').map((m) => ({
    path: `logger.${m}`,
    code: 'invalid_type',
    message: 'expected function',
    expected: 'function',
  }));
  if (issues.length > 0) throw new InvalidOptionError('Logger', issues);
  const safe =
    (m: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      try {
        const r: unknown = (target[m] as (msg: string, fields?: LogFields) => unknown).call(target, msg, fields);
        if (r !== null && typeof r === 'object' && typeof (r as { catch?: unknown }).catch === 'function') {
          (r as Promise<unknown>).catch(() => {});
        }
      } catch {
        // A failing logger is ignored; logging about it could fail the same way.
      }
    };
  return { debug: safe('debug'), info: safe('info'), warn: safe('warn'), error: safe('error') };
}

/** The only log messages SureQ emits; their levels are fixed here and nowhere else. */
export type LogEvent = 'sureq error';

export const LOG_LEVELS: Readonly<Record<LogEvent, LogLevel>> = Object.freeze({
  'sureq error': 'error',
});

/** Fields that may reach a log line. Job data, results, meta, error props and causes never do. */
const ALLOWED = new Set([
  'queue', 'namespace', 'jobId', 'jobName', 'workerId', 'state', 'attempt', 'maxAttempts',
  'delayMs', 'durationMs', 'priority', 'concurrency', 'reason', 'source', 'operation',
]);
const STRING_MAX = 1024;

const flat = (v: unknown): string | number | boolean | null | undefined => {
  if (typeof v === 'string') return v.length > STRING_MAX ? v.slice(0, STRING_MAX) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  return undefined;
};

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}

/** Log one SureQ event with allow-listed, flat fields. Never throws. */
export function logEvent(
  logger: Logger,
  event: LogEvent,
  input: Record<string, unknown>,
): void {
  try {
    const level = LOG_LEVELS[event];
    const fields: LogFields = {};
    for (const key of Object.keys(input)) {
      if (!ALLOWED.has(key)) continue;
      const v = flat(input[key]);
      if (v !== undefined) fields[key] = v;
    }
    const err = input['error'] as ErrorLike | undefined;
    if (err && typeof err === 'object') {
      const [name, code, message] = [flat(err.name), flat(err.code), flat(err.message)];
      if (name !== undefined) fields['errorName'] = name;
      if (code !== undefined) fields['errorCode'] = code;
      if (message !== undefined) fields['errorMessage'] = message;
      if (level === 'error' && typeof err.stack === 'string') fields['stack'] = err.stack;
    }
    logger[level](event, fields);
  } catch {
    // Logging must never break processing.
  }
}
