/** A pending timer from `Platform.setTimer`. */
export interface Timer {
  cancel(): void;
  ref(): void;
  unref(): void;
}

/** The runtime services core needs, so no other module touches runtime globals or built-in modules. */
export interface Platform {
  name: 'node' | 'bun' | 'deno';
  /** Milliseconds from an arbitrary origin; never goes backwards. */
  monotonicMs(): number;
  /** Runs `fn` once after `ms`. Unref'd unless `ref: true`, so it never holds the process open by itself. */
  setTimer(fn: () => void, ms: number, opts?: { ref?: boolean }): Timer;
  /** Runs `fn` on a later macrotask turn, after pending I/O and timers get a chance, with no delay clamp. */
  defer(fn: () => void): void;
  randomBytes(n: number): Uint8Array;
  /** Synchronous SHA-256 of the text's UTF-8 bytes, as lowercase hex. */
  sha256Hex(text: string): string;
  /** Listens for a process signal; returns the unsubscribe. */
  onSignal(signal: string, fn: () => void): () => void;
  /** The signal names `onSignal` accepts on this runtime. */
  signalNames(): readonly string[];
  /** Ends the process with `code`. */
  exit(code: number): void;
  hostname(): string;
  pid(): number;
}
