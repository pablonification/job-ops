/**
 * A small counting semaphore. One process-wide instance protects the Claude
 * subscription from bursts (the pipeline scores several jobs at once, and each
 * Agent SDK call spawns its own Claude Code process).
 *
 * The limiter only counts in-flight calls; it holds no tenant data.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<{
    grant: () => void;
    cancel: () => void;
  }> = [];

  constructor(private readonly getLimit: () => number) {}

  /** Number of calls currently holding a slot. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of calls waiting for a slot. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  /**
   * Wait for a slot. Resolves with a release function that must be called
   * exactly once. Rejects with `onAbort()` if the signal aborts while waiting.
   */
  acquire(signal?: AbortSignal, onAbort?: () => Error): Promise<() => void> {
    const makeAbortError = () =>
      onAbort ? onAbort() : new Error("Aborted while waiting for a slot.");
    if (signal?.aborted) {
      return Promise.reject(makeAbortError());
    }
    if (this.active < this.limit()) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", abortListener);
          this.active += 1;
          resolve(this.createRelease());
        },
        cancel: () => {
          reject(makeAbortError());
        },
      };
      const abortListener = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.cancel();
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      this.waiters.push(waiter);
    });
  }

  private limit(): number {
    const value = Math.floor(this.getLimit());
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limit()) {
      const next = this.waiters.shift();
      next?.grant();
    }
  }
}
