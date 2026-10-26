import type { GramRpcs } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Stream from "effect/Stream";

import { resubscribing, type ConnectionControl } from "./connection";

/** The Effect RPC client over the whole `GramRpcs` surface. */
type GramClient = RpcClient.FromGroup<typeof GramRpcs, RpcClientError>;

/** What a domain's RPC factory builds its slice of the `Api` from. */
export interface RpcContext {
  readonly client: GramClient;
  /** The socket's state; feeds resubscribe through it when the socket drops. */
  readonly connection: ConnectionControl;
}

/** Runs an RPC call, rejecting with the contract's tagged error itself rather than a wrapper. */
/** `signal` interrupts the call, and with it the server's handler. */
export async function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, signal === undefined ? undefined : { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Adapts a Stream to an AsyncIterable that interrupts the stream (and the server fiber) on abort. */
export async function* iterate<A, E>(
  stream: Stream.Stream<A, E>,
  signal: AbortSignal,
): AsyncGenerator<A> {
  const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
  const aborted = new Promise<IteratorResult<A>>((resolve) => {
    if (signal.aborted) resolve({ done: true, value: undefined });
    signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
      once: true,
    });
  });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}

/** Errors that reopening a stream can't mend: its subject is gone, or this server doesn't serve it. */
const FINAL_TAGS: readonly unknown[] = ["NotFound", "NotImplemented"];

/**
 * `resubscribing` for a stream whose subject can go away: a `NotFound` ends it for good instead of
 * counting as a dropped connection, which would hold the reconnect banner up over a removed
 * workspace. The same for a server that doesn't serve the stream at all.
 */
export async function* untilGone<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  monitor: Parameters<typeof resubscribing>[1],
  signal: AbortSignal,
  /** Errors for the consumer: thrown to it rather than retried as a dropped connection. */
  final?: (error: unknown) => boolean,
): AsyncGenerator<T> {
  const gone = new AbortController();
  const either = AbortSignal.any([signal, gone.signal]);
  yield* resubscribing(
    async function* (s) {
      try {
        yield* open(s);
      } catch (error) {
        if (!FINAL_TAGS.includes((error as { _tag?: unknown } | null)?._tag)) throw error;
        gone.abort();
      }
    },
    monitor,
    either,
    final === undefined ? {} : { final },
  );
}
