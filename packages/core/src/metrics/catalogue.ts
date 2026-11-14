import type { StatsResult } from '../store/contract.js';
import { JOB_STATES } from '../util/job-states.js';

/** How a metric's value behaves. */
export type MetricType = 'gauge' | 'counter' | 'histogram';
/** The unit of a metric's value. */
export type MetricUnit = 'jobs' | 'seconds' | 'ratio' | 'jobs_per_second';
/** One metric in the catalogue, as `describeMetrics()` lists it. */
export interface MetricDescriptor {
  /** The metric name, such as `'sureq_jobs'`. */
  name: string;
  /** Gauge, counter or histogram. */
  type: MetricType;
  /** The unit of its value. */
  unit: MetricUnit;
  /** Label names: `namespace` and `queue` first, then the metric's own. */
  labels: string[];
  /** One line on what it measures. */
  help: string;
}
/** A gauge or counter value, or a histogram with cumulative bucket counts (`+Inf` is `count`). */
export type MetricSample =
  | { name: string; labels: Record<string, string>; value: number }
  | { name: string; labels: Record<string, string>; count: number; sum: number; buckets: { le: number; count: number }[] };
/** What `queue.metrics()` returns: `at` is store time; `scope` says which metrics are cluster-wide and which this pod's. */
export interface MetricsSnapshot {
  /** Store time of the read. */
  at: number;
  /** For each metric name: `'cluster'` (read from the store, the same on every pod) or `'pod'` (this pod since it started). */
  scope: Record<string, 'cluster' | 'pod'>;
  /** The values. */
  samples: MetricSample[];
}

type Row = [name: string, type: MetricType, unit: MetricUnit, labels: string[], scope: 'cluster' | 'pod', help: string];
const CATALOGUE: readonly Row[] = [
  ['sureq_jobs', 'gauge', 'jobs', ['state'], 'cluster', 'Jobs in each state, read from the store.'],
  ['sureq_jobs_added_total', 'counter', 'jobs', ['name'], 'pod', 'Jobs this pod added.'],
  ['sureq_jobs_finished_total', 'counter', 'jobs', ['name', 'outcome'], 'pod', 'Jobs this pod finished, by outcome.'],
  ['sureq_jobs_crashed_total', 'counter', 'jobs', ['name'], 'pod', 'Attempts whose lease expired and this pod swept.'],
  ['sureq_attempts_retried_total', 'counter', 'jobs', ['name'], 'pod', 'Failed attempts this pod scheduled for a retry.'],
  ['sureq_job_wait_seconds', 'histogram', 'seconds', ['name'], 'pod', 'Time from due to claimed, per attempt, in store time.'],
  ['sureq_job_processing_seconds', 'histogram', 'seconds', ['name', 'outcome'], 'pod', 'Time from claimed to the attempt end, in store time.'],
  ['sureq_job_processing_peak_seconds', 'gauge', 'seconds', ['name'], 'pod', 'Longest processing time of attempts ended in the window.'],
  ['sureq_success_ratio', 'gauge', 'ratio', ['name'], 'pod', 'completed / (completed + failed) over the window; absent without finished jobs.'],
  ['sureq_throughput_per_second', 'gauge', 'jobs_per_second', ['name'], 'pod', 'Jobs finished in the window per second.'],
  ['sureq_oldest_waiting_age_seconds', 'gauge', 'seconds', [], 'cluster', 'Age of the oldest waiting job that is not blocked; 0 when none.'],
  ['sureq_alert_firing', 'gauge', 'ratio', ['type'], 'pod', '1 while the alert fires on this pod, else 0; only configured rules.'],
  ['sureq_jobs_rejected_total', 'counter', 'jobs', ['name'], 'pod', 'Adds the queue filter rejected on this pod.'],
  ['sureq_batch_held_seconds', 'histogram', 'seconds', ['name'], 'pod', 'Time a batch job was held before its handler started.'],
];

/** Every metric SureQ reports, in catalogue order; fresh copies. */
export function describeMetrics(): MetricDescriptor[] {
  return CATALOGUE.map(([name, type, unit, labels, , help]) => ({ name, type, unit, labels: ['namespace', 'queue', ...labels], help }));
}

export const SCOPES: Readonly<Record<string, 'cluster' | 'pod'>> = Object.freeze(Object.fromEntries(CATALOGUE.map((r) => [r[0], r[4]])));

export const DEFAULT_BUCKETS: readonly number[] = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800]);

export const OTHER_NAME = '__other__';

/** The `name` label: a job name as is, `''` for unnamed jobs, `__other__` once `max` distinct names were seen (warned once). */
export class NameLabels {
  readonly #max: number;
  readonly #warn: (msg: string) => void;
  readonly #seen = new Set<string>();
  #warned = false;

  constructor(max: number, warn: (msg: string) => void) {
    this.#max = max;
    this.#warn = warn;
  }

  label(name: string | null): string {
    const n = name ?? '';
    if (this.#seen.has(n)) return n;
    if (this.#seen.size < this.#max) {
      this.#seen.add(n);
      return n;
    }
    if (!this.#warned) {
      this.#warned = true;
      this.#warn(`more than ${this.#max} job names (metrics.maxNameLabels); further names are reported as ${OTHER_NAME}`);
    }
    return OTHER_NAME;
  }
}

/** Label values in a fixed order, as one map key. */
export const labelKey = (labels: Record<string, string>): string => JSON.stringify(Object.values(labels));

/** A monotonic counter per label set. */
export class Counter {
  readonly #metric: string;
  readonly #values = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(metric: string) {
    this.#metric = metric;
  }

  inc(labels: Record<string, string>, by = 1): void {
    const key = labelKey(labels);
    const v = this.#values.get(key);
    if (v) v.value += by;
    else this.#values.set(key, { labels: { ...labels }, value: by });
  }

  samples(): MetricSample[] {
    return [...this.#values.values()].map(({ labels, value }) => ({ name: this.#metric, labels: { ...labels }, value }));
  }
}

/** The samples read from the store: one `sureq_jobs` per state and the oldest waiting age. */
export function storeSamples(base: { namespace: string; queue: string }, stats: StatsResult): MetricSample[] {
  const { counts, oldestWaitingRunAt, now } = stats;
  const jobs = JOB_STATES.map((state) => ({ name: 'sureq_jobs', labels: { ...base, state }, value: counts[state] }));
  const age = oldestWaitingRunAt === null ? 0 : Math.max(0, now - oldestWaitingRunAt) / 1000;
  return [...jobs, { name: 'sureq_oldest_waiting_age_seconds', labels: { ...base }, value: age }];
}
