/**
 * A push-based `AsyncIterable` that stays open until `end()`. Used as the SDK's streaming input so
 * the query outlives individual turns.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly buffer: Array<T> = [];
  private waiter: ((result: IteratorResult<T, undefined>) => void) | undefined;
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    this.done = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: () => {
        const value = this.buffer.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
