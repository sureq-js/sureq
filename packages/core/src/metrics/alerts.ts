import type { Logger } from '../logger/logger.js';
import type { StatsResult } from '../store/contract.js';
import type { MetricSample } from './catalogue.js';
import { platform, type Timer } from '../platform/index.js';

/** What an alert rule watches: queue depth, waiting age, or failure rate. */
export type AlertType = 'depth' | 'age' | 'failureRate';
/** One alert change: depth in jobs, age in seconds, failureRate as a ratio; `at` is the store time of the read. */
export interface AlertEvent {
  /** The rule that changed. */
  type: AlertType;
  /** Whether it started firing or resolved. */
  status: 'firing' | 'resolved';
  /** The value read: jobs, seconds, or a ratio. */
  value: number;
  /** The level crossed, in the same unit; seconds for `age`. */
  threshold: number;
  /** The namespace. */
  namespace: string;
  /** The queue name. */
  queue: string;
  /** Store time of the read. */
  at: number;
}
/** Threshold rules, each with its own resolve level (default: its fire level). */
export interface AlertRules {
  /** Waiting jobs. */
  depth?: { above: number; resolveBelow?: number };
  /** Age of the oldest waiting job that is not blocked, in ms. */
  age?: { aboveMs: number; resolveBelowMs?: number };
  /** `failed / (completed + failed)` over this pod's metrics window, once at least `minJobs` (default 10) finished. */
  failureRate?: { above: number; resolveBelow?: number; minJobs?: number };
}
export interface ResolvedAlerts {
  intervalMs: number;
  depth?: { above: number; resolveBelow: number };
  age?: { aboveMs: number; resolveBelowMs: number };
  failureRate?: { above: number; resolveBelow: number; minJobs: number };
}

export interface AlertHost {
  stats(): Promise<StatsResult>;
  window(): { completed: number; failed: number };
  emit(e: AlertEvent): void;
  report(e: unknown): void;
  /** Evaluate nothing now (the pod is degraded). */
  skip(): boolean;
  logger: Logger;
  base: { namespace: string; queue: string };
}

/** A rule as evaluated: its value from one read, and the levels in the event's unit; `undefined` value means no data. */
type Rule = { type: AlertType; above: number; below: number; value(s: StatsResult, w: { completed: number; failed: number }): number | undefined };

/** Evaluates this pod's alert rules every interval, edge-triggered: one `firing` on crossing, one `resolved` below the resolve level. */
export class AlertEvaluator {
  readonly #host: AlertHost;
  readonly #intervalMs: number;
  readonly #rules: Rule[] = [];
  readonly #firing = new Map<AlertType, AlertEvent>();
  #timer: Timer | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  /** A stats read failed and none has succeeded since: report only the first. */
  #outage = false;

  constructor(host: AlertHost, rules: ResolvedAlerts) {
    this.#host = host;
    this.#intervalMs = rules.intervalMs;
    const { depth, age, failureRate } = rules;
    if (depth) this.#rules.push({ type: 'depth', above: depth.above, below: depth.resolveBelow, value: (s) => s.counts.waiting });
    if (age) {
      this.#rules.push({
        type: 'age', above: age.aboveMs / 1000, below: age.resolveBelowMs / 1000,
        value: (s) => (s.oldestWaitingRunAt === null ? 0 : Math.max(0, s.now - s.oldestWaitingRunAt) / 1000),
      });
    }
    if (failureRate) {
      this.#rules.push({
        type: 'failureRate', above: failureRate.above, below: failureRate.resolveBelow,
        value: (_, w) => (w.completed + w.failed < failureRate.minJobs ? undefined : w.failed / (w.completed + w.failed)),
      });
    }
  }

  start(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = platform.setTimer(() => {
      this.#running = this.evaluate().finally(() => {
        this.#running = undefined;
        this.#timer = undefined;
        this.start();
      });
    }, this.#intervalMs);
  }

  /** No evaluation after this; resolves once one in flight has ended. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer?.cancel();
    await this.#running;
  }

  /** One evaluation: one stats read, one window read. Never rejects; a failed read changes nothing. */
  async evaluate(): Promise<void> {
    if (this.#stopped || this.#host.skip()) return;
    let stats: StatsResult;
    try {
      stats = await this.#host.stats();
    } catch (e) {
      if (!this.#stopped && !this.#outage) this.#host.report(e);
      this.#outage = true;
      return;
    }
    this.#outage = false;
    if (this.#stopped) return;
    const window = this.#host.window();
    for (const rule of this.#rules) {
      const value = rule.value(stats, window);
      if (value === undefined) continue;
      const firing = this.#firing.has(rule.type);
      if (!firing && value >= rule.above) this.#change(rule, 'firing', value, rule.above, stats.now);
      else if (firing && value < rule.below) this.#change(rule, 'resolved', value, rule.below, stats.now);
    }
  }

  #change(rule: Rule, status: AlertEvent['status'], value: number, threshold: number, at: number): void {
    const e: AlertEvent = { type: rule.type, status, value, threshold, ...this.#host.base, at };
    if (status === 'firing') this.#firing.set(rule.type, e);
    else this.#firing.delete(rule.type);
    const fields = { queue: this.#host.base.queue, type: rule.type, value, threshold };
    if (status === 'firing') this.#host.logger.warn(`alert ${rule.type} firing`, fields);
    else this.#host.logger.info(`alert ${rule.type} resolved`, fields);
    this.#host.emit({ ...e });
  }

  firing(): AlertEvent[] {
    return [...this.#firing.values()].map((e) => ({ ...e }));
  }

  /** One `sureq_alert_firing` per configured rule. */
  samples(): MetricSample[] {
    return this.#rules.map((r) => ({ name: 'sureq_alert_firing', labels: { ...this.#host.base, type: r.type }, value: this.#firing.has(r.type) ? 1 : 0 }));
  }
}
