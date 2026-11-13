import {
  BrowserViewRpcs,
  InvalidState,
  type BrowserViewEvent,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { PanePort } from "../../browser/pane-port.ts";
import { createBrowserViews, type BrowserViews } from "../../browser/views.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { logDefects, type Handlers } from "./common.ts";

/** How many events wait for a slow client: older ones go, and the page's state is sent again. */
const BUFFERED = 16;

/**
 * `browserView.*`: the page a thread's agent drives in the server's own browser, for a client with
 * no Preview pane to draw it. A member's calls only (`actor-guard.ts`): what is typed here goes
 * into a page.
 */
const browserViewHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  // Absent in handler-only test layers; without a browser host there is nothing to watch.
  const port = Option.getOrUndefined(yield* Effect.serviceOption(PanePort))?.view;
  const views = port === undefined ? undefined : createBrowserViews(port);
  const none = new InvalidState({ message: "This server runs no browser of its own." });
  /** The views, once the thread is known to exist. */
  const viewsFor = (
    threadId: ThreadId,
  ): Effect.Effect<BrowserViews, InvalidState | ThreadNotFound> =>
    views === undefined ? Effect.fail(none) : store.getThread(threadId).pipe(Effect.as(views));
  return {
    "browserView.subscribe": ({ threadId }) =>
      Stream.unwrap(
        viewsFor(threadId).pipe(
          Effect.map((live) =>
            Stream.callback<BrowserViewEvent>(
              (queue) =>
                Effect.acquireRelease(
                  Effect.sync(() =>
                    live.watch(threadId, (event) => void Queue.offerUnsafe(queue, event)),
                  ),
                  (end) => Effect.sync(end),
                ),
              { bufferSize: BUFFERED, strategy: "sliding" },
            ),
          ),
        ),
      ),
    "browserView.input": ({ threadId, inputs }) =>
      viewsFor(threadId).pipe(Effect.map((live) => live.input(threadId, inputs))),
    "browserView.control": ({ threadId, op }) =>
      viewsFor(threadId).pipe(Effect.map((live) => live.control(threadId, op))),
  } satisfies Partial<Handlers>;
});

/** The `browserView.*` group's handler layer. */
export const BrowserViewHandlersLive = BrowserViewRpcs.toLayer(
  Effect.map(browserViewHandlers, (handlers) =>
    BrowserViewRpcs.of(logDefects(BrowserViewRpcs, handlers)),
  ),
);
