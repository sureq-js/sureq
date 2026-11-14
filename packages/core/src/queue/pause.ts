/** `local`: one worker's own flag. `global`: the queue's flag in the store, shared by every pod. */
export type PauseScope = 'local' | 'global';

/** Payload of `paused` and `resumed`. `source` is `self` when this instance made the change, `observed` when it learned it from the store. */
export interface PauseEvent {
  /** `'local'`: this worker only. `'global'`: the whole queue. */
  scope: PauseScope;
  /** The queue name. */
  queue: string;
  /** Set on a worker's events. */
  workerId?: string;
  /** `'self'` for this object's own call; `'observed'` when it learned the change from the store. */
  source: 'self' | 'observed';
  /** Wall-clock ms when emitted; informational. */
  at: number;
}

/** A paused flag that reports each change once; the value is stored before the callback runs. */
export class PauseFlag {
  #value = false;
  readonly #onChange: (paused: boolean, source: 'self' | 'observed') => void;

  constructor(onChange: (paused: boolean, source: 'self' | 'observed') => void) {
    this.#onChange = onChange;
  }

  get value(): boolean {
    return this.#value;
  }

  /** True when the value changed; `source: null` changes it silently. */
  set(paused: boolean, source: 'self' | 'observed' | null): boolean {
    if (this.#value === paused) return false;
    this.#value = paused;
    if (source !== null) this.#onChange(paused, source);
    return true;
  }
}
