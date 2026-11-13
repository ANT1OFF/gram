import { InvalidState, PageRpcs, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { pageEntryOf } from "../../pages/entry.ts";
import { PageFiles } from "../../pages/page-files.ts";
import { Pages } from "../../pages/pages.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { logDefects, type Handlers } from "./common.ts";

/**
 * `pages.*`: the Pages tab's list and the user's pin, show and unpin. These are the user's alone:
 * no agent tool reaches them, and no viewer may call them (`actor-guard.ts`).
 */
export const pageHandlers = Effect.gen(function* () {
  const pages = yield* Pages;
  const store = yield* ThreadStore;
  // Absent in handler-only test layers, which serve no page.
  const files = Option.getOrUndefined(yield* Effect.serviceOption(PageFiles));
  const threadOf = (threadId: ThreadId) =>
    store
      .getThread(threadId)
      .pipe(
        Effect.catchTag("ThreadNotFound", () =>
          Effect.fail(new InvalidState({ message: "This thread no longer exists", threadId })),
        ),
      );
  return {
    "pages.list": ({ workspaceId }) =>
      pages.list(workspaceId).pipe(Effect.map((list) => ({ pages: list }))),
    "pages.pin": ({ threadId, path }) =>
      Effect.gen(function* () {
        const thread = yield* threadOf(threadId);
        if (thread.workspaceId === undefined) {
          return yield* new InvalidState({
            message: "Pages belong to a workspace, and this thread isn't in one",
          });
        }
        const entry = yield* pageEntryOf(thread, path);
        return yield* pages.pin({
          workspaceId: thread.workspaceId,
          by: { threadId, title: thread.title },
          entry,
        });
      }),
    "pages.open": ({ workspaceId, id }) =>
      Effect.gen(function* () {
        if (files === undefined) {
          return yield* new InvalidState({ message: "Pages aren't served here" });
        }
        const shown = yield* pages.shown(workspaceId, id);
        return { url: yield* files.urlFor(shown.folder, shown.entry), version: shown.version };
      }),
    "pages.showOffer": ({ workspaceId, id, version }) => pages.showOffer(workspaceId, id, version),
    "pages.unpin": ({ workspaceId, id }) => pages.unpin(workspaceId, id),
  } satisfies Partial<Handlers>;
});

/** The pages group's handler layer. */
export const PageHandlersLive = PageRpcs.toLayer(
  Effect.gen(function* () {
    return PageRpcs.of(logDefects(PageRpcs, yield* pageHandlers));
  }),
);
