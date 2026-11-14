import type { SureQError } from '../errors/base.js';
import { InternalError, WorkerClosedError } from '../errors/catalog.js';
import type { StoreClient } from '../store/client.js';
import type { ReleaseRequest, Scope } from '../store/contract.js';
import { finalize, transient, type FinalizeCtx } from './finalize.js';
import { platform } from '../platform/index.js';

/** A worker's lifecycle; pausing is a flag on `running`, not a state. */
export type WorkerState = 'created' | 'running' | 'stopping' | 'stopped';

/** `created -> running -> stopping -> stopped`; `created` may go straight to `stopping`. */
export class Lifecycle {
  #state: WorkerState = 'created';

  get state(): WorkerState {
    return this.#state;
  }

  /** `created -> running`; a no-op while running. */
  start(): void {
    if (this.#state === 'stopping' || this.#state === 'stopped') throw new WorkerClosedError('worker is closed; create a new one');
    this.#state = 'running';
  }

  /** Enter `stopping`; true only for the call that did it. */
  beginStop(): boolean {
    if (this.#state === 'stopping' || this.#state === 'stopped') return false;
    this.#state = 'stopping';
    return true;
  }

  finish(): void {
    if (this.#state !== 'stopping') throw new InternalError(`invalid worker state change from ${this.#state} to stopped`);
    this.#state = 'stopped';
  }
}

/** `rejected`: the lease was already gone (the sweeper owns the job), which is not an error. */
export type ReleaseOutcome = 'released' | 'rejected' | 'unconfirmed';

/**
 * Give a held job back with a fenced `release`, through the same bounded retry as `complete` and
 * `fail`: an unknown outcome is repeated with the same request until `deadline`. `report` gets the
 * unconfirmed outcome; `raised` gets a store error that retrying cannot fix.
 */
export async function releaseLease(
  client: StoreClient,
  scope: Scope,
  req: ReleaseRequest,
  ctx: Omit<FinalizeCtx, 'operation' | 'jobId'> & { raised(e: SureQError): void },
): Promise<ReleaseOutcome> {
  const { raised, ...rest } = ctx;
  const r = await finalize(() => client.call('release', scope, req), {
    ...rest,
    operation: 'release',
    jobId: req.id,
    report: (e) => (transient(e) ? ctx.report(e) : raised(e)),
  });
  if ('unconfirmed' in r) return 'unconfirmed';
  return r.ok ? 'released' : 'rejected';
}

/**
 * Listen for `signals`: the first delivery of any of them calls `close`, a later one calls `exit(1)`
 * without waiting for release (a last resort). Returns the function that removes the listeners.
 */
export function installSignals(signals: readonly string[], close: () => void, exit: (code: number) => void = (code) => platform.exit(code)): () => void {
  let deliveries = 0;
  const onSignal = () => (++deliveries === 1 ? close() : exit(1));
  const offs: Array<() => void> = [];
  const remove = () => {
    for (const off of offs.splice(0)) off();
  };
  try {
    for (const s of signals) offs.push(platform.onSignal(s, onSignal));
  } catch (e) {
    // all or nothing: a signal Node cannot listen for leaves no listener behind
    remove();
    throw e;
  }
  return remove;
}
