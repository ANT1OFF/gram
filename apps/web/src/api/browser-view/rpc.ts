import type { BrowserViewEvent } from "@gram/contracts";
import { RpcClientError } from "effect/rpc/RpcClientError";

import { resubscribing } from "../connection";
import { iterate, run, type RpcContext } from "../rpc-client";
import type { BrowserViewApi, BrowserViewFeedEvent } from "./types";

/**
 * Anything the server itself answered: it runs no browser of its own, or is older than the view.
 * Only a lost connection is worth reopening for.
 */
const unavailable = (error: unknown) => !(error instanceof RpcClientError);

/** `BrowserViewApi` over the RPC client. */
export const browserViewRpc = ({ client, connection }: RpcContext): BrowserViewApi => ({
  browserViewFeed: (threadId, signal) =>
    resubscribing(
      (s) => dropping(iterate(client["browserView.subscribe"]({ threadId }), s), s),
      connection,
      signal,
      { final: unavailable },
    ),
  browserViewInput: (threadId, inputs) => run(client["browserView.input"]({ threadId, inputs })),
  browserViewControl: (threadId, op) => run(client["browserView.control"]({ threadId, op })),
});

/** `events`, and a `dropped` when they end other than by `signal` or for good. */
async function* dropping(
  events: AsyncIterable<BrowserViewEvent>,
  signal: AbortSignal,
): AsyncGenerator<BrowserViewFeedEvent> {
  try {
    yield* events;
  } catch (error) {
    if (!signal.aborted && !unavailable(error)) yield { type: "dropped" };
    throw error;
  }
  if (!signal.aborted) yield { type: "dropped" };
}
