/** A push-based AsyncIterable that ends when closed or when `signal` aborts. */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

export function createChannel<T>(signal?: AbortSignal, onClose?: () => void): Channel<T> {
  const buffer: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    wake?.();
    onClose?.();
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();

  return {
    get closed() {
      return closed;
    },
    push(value) {
      if (closed) return;
      buffer.push(value);
      wake?.();
    },
    close,
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift()!;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        close();
      }
    },
  };
}
