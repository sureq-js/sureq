import type { JobRecord, StatsResult } from '../store/contract.js';
import { Counter, labelKey, type MetricSample, type NameLabels } from './catalogue.js';
import { platform } from '../platform/index.js';

/** How an attempt ended, as the metrics count it (not the store's attempt outcome). */
export type ObservedOutcome = 'completed' | 'failed' | 'retried' | 'cancelled' | 'crashed';

const MINUTE_MS = 60_000;

/** Observations per label set, with cumulative bucket counts on read. */
class Histogram {
  readonly #metric: string;
  readonly #buckets: readonly number[];
  readonly #values = new Map<string, { labels: Record<string, string>; count: number; sum: number; per: number[] }>();

  constructor(metric: string, buckets: readonly number[]) {
    this.#metric = metric;
    this.#buckets = buckets;
  }

  observe(labels: Record<string, string>, v: number): void {
    const key = labelKey(labels);
    let h = this.#values.get(key);
    if (!h) this.#values.set(key, (h = { labels: { ...labels }, count: 0, sum: 0, per: this.#buckets.map(() => 0) }));
    h.count++;
    h.sum += v;
    const i = this.#buckets.findIndex((le) => v <= le);
    if (i >= 0) h.per[i]!++;
  }

  samples(): MetricSample[] {
    return [...this.#values.values()].map(({ labels, count, sum, per }) => {
      let acc = 0;
      const buckets = this.#buckets.map((le, i) => ({ le, count: (acc += per[i]!) }));
      return { name: this.#metric, labels: { ...labels }, count, sum, buckets };
    });
  }
}

/** One minute of attempt ends, per name label. */
type Slot = { minute: number; byName: Map<string, { completed: number; failed: number; finished: number; peak: number }> };

/**
 * This pod's worker-side metrics: counters and histograms since the pod started, and the success ratio,
 * throughput and peak over a sliding window of 1-minute buckets on the pod's monotonic clock.
 */
export class PodMetrics {
  readonly #base: { namespace: string; queue: string };
  readonly #names: NameLabels;
  readonly #now: () => number;
  readonly #startedAt: number;
  /** Buckets kept besides the current one: the window is covered whatever the current minute's progress. */
  readonly #slots: number;
  readonly #ring: Slot[] = [];
  /** Every name label that ended an attempt, so peak and throughput stay present (as 0) after the window empties. */
  readonly #seen = new Set<string>();
  readonly #finished = new Counter('sureq_jobs_finished_total');
  readonly #crashed = new Counter('sureq_jobs_crashed_total');
  readonly #retried = new Counter('sureq_attempts_retried_total');
  readonly #wait: Histogram;
  readonly #processing: Histogram;
  readonly #held: Histogram;

  constructor(opts: { base: { namespace: string; queue: string }; windowMs: number; buckets: readonly number[]; names: NameLabels; now?: () => number }) {
    this.#base = opts.base;
    this.#names = opts.names;
    this.#now = opts.now ?? (() => platform.monotonicMs());
    this.#startedAt = this.#now();
    this.#slots = Math.ceil(opts.windowMs / MINUTE_MS);
    this.#wait = new Histogram('sureq_job_wait_seconds', opts.buckets);
    this.#processing = new Histogram('sureq_job_processing_seconds', opts.buckets);
    this.#held = new Histogram('sureq_batch_held_seconds', opts.buckets);
  }

  #labels(rec: JobRecord): Record<string, string> {
    return { ...this.#base, name: this.#names.label(rec.name) };
  }

  /** A claimed attempt: one wait observation, due time to claim in store time. */
  attemptStarted(rec: JobRecord): void {
    if (rec.startedAt === null) return;
    this.#wait.observe(this.#labels(rec), Math.max(0, rec.startedAt - rec.runAt) / 1000);
  }

  /** A batch job's handler started `heldMs` after its claim. */
  observeHeld(rec: JobRecord, heldMs: number): void {
    this.#held.observe(this.#labels(rec), Math.max(0, heldMs) / 1000);
  }

  /** An attempt ended; `endedAt` is the store time of the write that ended it, null for no processing sample. */
  attemptEnded(rec: JobRecord, outcome: ObservedOutcome, endedAt: number | null): void {
    const labels = this.#labels(rec);
    const name = labels['name']!;
    if (outcome === 'crashed') this.#crashed.inc(labels);
    else if (outcome === 'retried') this.#retried.inc(labels);
    else this.#finished.inc({ ...labels, outcome });
    const seconds = endedAt !== null && rec.startedAt !== null ? Math.max(0, endedAt - rec.startedAt) / 1000 : undefined;
    if (seconds !== undefined) this.#processing.observe({ ...labels, outcome: outcome === 'retried' ? 'failed' : outcome }, seconds);
    const finishes = outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled';
    if (seconds === undefined && !finishes) return;
    this.#seen.add(name);
    const slot = this.#slot();
    let s = slot.byName.get(name);
    if (!s) slot.byName.set(name, (s = { completed: 0, failed: 0, finished: 0, peak: 0 }));
    if (outcome === 'completed') s.completed++;
    if (outcome === 'failed') s.failed++;
    if (finishes) s.finished++;
    if (seconds !== undefined) s.peak = Math.max(s.peak, seconds);
  }

  #minute(): number {
    return Math.floor((this.#now() - this.#startedAt) / MINUTE_MS);
  }

  /** The current minute's bucket; buckets that left the window are dropped. */
  #slot(): Slot {
    const minute = this.#minute();
    this.#expire(minute);
    let last = this.#ring.at(-1);
    if (last?.minute !== minute) this.#ring.push((last = { minute, byName: new Map() }));
    return last;
  }

  #expire(minute: number): void {
    while (this.#ring.length > 0 && this.#ring[0]!.minute < minute - this.#slots) this.#ring.shift();
  }

  /** Job-finishing attempts in the window, every name together. */
  window(): { completed: number; failed: number } {
    this.#expire(this.#minute());
    let completed = 0;
    let failed = 0;
    for (const slot of this.#ring) {
      for (const s of slot.byName.values()) {
        completed += s.completed;
        failed += s.failed;
      }
    }
    return { completed, failed };
  }

  samples(): MetricSample[] {
    this.#expire(this.#minute());
    const sums = new Map<string, { completed: number; failed: number; finished: number; peak: number }>();
    for (const name of this.#seen) sums.set(name, { completed: 0, failed: 0, finished: 0, peak: 0 });
    for (const slot of this.#ring) {
      for (const [name, s] of slot.byName) {
        const t = sums.get(name)!;
        t.completed += s.completed;
        t.failed += s.failed;
        t.finished += s.finished;
        t.peak = Math.max(t.peak, s.peak);
      }
    }
    // The kept buckets cover the full minutes kept plus the current minute so far, never more than the uptime.
    const uptime = this.#now() - this.#startedAt;
    const covered = Math.min(uptime, this.#slots * MINUTE_MS + (uptime % MINUTE_MS));
    const divisor = Math.max(covered, 1000) / 1000;
    const windowed: MetricSample[] = [];
    for (const [name, t] of sums) {
      const labels = { ...this.#base, name };
      windowed.push({ name: 'sureq_job_processing_peak_seconds', labels, value: t.peak });
      if (t.completed + t.failed > 0) windowed.push({ name: 'sureq_success_ratio', labels: { ...labels }, value: t.completed / (t.completed + t.failed) });
      windowed.push({ name: 'sureq_throughput_per_second', labels: { ...labels }, value: t.finished / divisor });
    }
    return [
      ...this.#finished.samples(), ...this.#crashed.samples(), ...this.#retried.samples(),
      ...this.#wait.samples(), ...this.#processing.samples(), ...this.#held.samples(), ...windowed,
    ];
  }
}

/** The last `stats` read of a periodic tick; `health()` reads `latest` without a store call. */
export class StatsCache {
  latest: StatsResult | undefined;
  readonly #read: () => Promise<StatsResult>;
  /** Bumped by every reset: a read that started before one is out of date and is not kept. */
  #gen = 0;

  constructor(read: () => Promise<StatsResult>) {
    this.#read = read;
  }

  async refresh(): Promise<StatsResult> {
    const gen = this.#gen;
    const s = await this.#read();
    if (gen === this.#gen) this.latest = s;
    return s;
  }

  /** Jobs were removed: drop the cached read, and any read in flight with it. */
  reset(): void {
    this.#gen++;
    this.latest = undefined;
  }
}
