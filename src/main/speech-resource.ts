// One inference/runtime-maintenance slot. Awaiters can cancel without taking the slot.
export class SpeechResource {
  private held = false;
  private waiting: {
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    abort: () => void;
  }[] = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.held) {
      this.held = true;
      return this.releaseOnce();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        abort: () => {
          this.waiting = this.waiting.filter((item) => item !== entry);
          reject(Error("Cancelled"));
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }
  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        next.resolve(this.releaseOnce());
      } else this.held = false;
    };
  }
  async use<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }
}
