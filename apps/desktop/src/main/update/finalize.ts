// Update-specific completion: ordinary quit's forced-recovery policy cannot authorize it.
const UPDATE_NATIVE_DEADLINE_MS = 10_000;
export interface UpdateFinalization {
  readonly speech: () => Promise<void>;
  readonly models: () => Promise<void>;
  readonly windows: () => void;
}
export function createUpdateFinalizer() {
  let controller: AbortController | undefined;
  const pending = new Set<Promise<void>>();
  return {
    active: () => controller !== undefined,
    cancel() {
      controller?.abort();
    },
    /** Track actual shutdown, not a timeout/abort race that merely stopped waiting for it. */
    own(work: () => Promise<void>): Promise<void> {
      if (!controller || controller.signal.aborted)
        throw new Error("Update cancelled before shutdown step");
      const completion = work();
      pending.add(completion);
      void completion.then(
        () => pending.delete(completion),
        () => pending.delete(completion),
      );
      return completion;
    },
    async settle() {
      await waitForUpdateRecovery(Promise.allSettled(pending));
    },
    /** Called only after server/window restoration. */
    recovered() {
      if (pending.size > 0) return;
      controller = undefined;
    },
    async run(work: (signal: AbortSignal) => Promise<void>) {
      if (controller) throw new Error("An update transaction is already active");
      controller = new AbortController();
      const own = controller;
      try {
        await work(own.signal);
      } catch (error) {
        own.abort();
        throw error;
      }
    },
  };
}

/** Rejects on the actual step/overall bounds; a late completion cannot arm a cancelled attempt. */
export async function finalizeUpdateNative(options: UpdateFinalization, signal: AbortSignal) {
  if (signal.aborted) throw new Error("Update cancelled during native finalization");
  let overall: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Update cancelled during native finalization"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    overall = setTimeout(
      () => reject(new Error("Update native finalization deadline exceeded")),
      UPDATE_NATIVE_DEADLINE_MS,
    );
  });
  try {
    for (const [name, run] of [
      ["speech", options.speech],
      ["speech models", options.models],
    ] as const) {
      if (signal.aborted) throw new Error("Update cancelled during native finalization");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          run(),
          stopped,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Update ${name} did not complete within 3000 ms`)),
              3_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (signal.aborted) throw new Error("Update cancelled before window persistence");
    options.windows();
  } finally {
    clearTimeout(overall);
    signal.removeEventListener("abort", abort);
  }
}

/** A closed store is replaced only after its successful close has actually settled. */
export function createUpdateModelScope<T extends { close(): Promise<void> }>(
  open: () => Promise<T>,
) {
  let store = open();
  let closing: Promise<void> | undefined;
  let settled = false;
  let succeeded = false;
  let suspended = false;
  return {
    owned: () => store,
    current: () =>
      suspended
        ? Promise.reject(new Error("Voice model store unavailable during update recovery"))
        : store,
    close() {
      suspended = true;
      closing ??= store.then((value) => value.close());
      void closing.then(
        () => {
          settled = true;
          succeeded = true;
        },
        () => {
          settled = true;
        },
      );
      return closing;
    },
    async restore() {
      if (closing && !settled) await waitForUpdateRecovery(closing);
      if (closing && (!settled || !succeeded)) {
        throw new Error(
          settled
            ? "Previous speech model scope close failed"
            : "Previous speech model scope is still closing",
        );
      }
      if (closing) {
        store = open();
        closing = undefined;
        settled = false;
        succeeded = false;
      }
      await waitForUpdateRecovery(store);
      suspended = false;
    },
  };
}

/** Recovery never authorizes an install and remains bounded while waiting for measured closure. */
export async function waitForUpdateRecovery(completion: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native recovery completion was not observed within 3000 ms")),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
