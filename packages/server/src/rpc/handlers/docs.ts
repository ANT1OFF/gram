import * as Effect from "effect/Effect";

import { archiveDocsOlderThan, markDocOpened } from "../../docs/docs-sweep.ts";
import { Docs } from "../../docs/docs.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/**
 * `docs.*`: the doc pane's lists (active and archived), reads, and the user's saves, opens,
 * archives and restores of a workspace's docs, and the Storage page's "Archive docs older than…".
 */
export const docHandlers = Effect.gen(function* () {
  const docs = yield* Docs;
  const store = yield* ThreadStore;
  return {
    "docs.list": ({ workspaceId }) =>
      Effect.all([docs.list(workspaceId), docs.counts(workspaceId)]).pipe(
        Effect.map(([list, counts]) => ({ docs: list, archived: counts.archived })),
      ),
    "docs.listArchived": ({ workspaceId }) =>
      docs.listArchived(workspaceId).pipe(Effect.map((list) => ({ docs: list }))),
    "docs.archive": ({ workspaceId, id }) => docs.archive(workspaceId, id, "user", "manual"),
    "docs.restore": ({ workspaceId, id }) => docs.restore(workspaceId, id, "user"),
    "docs.read": ({ workspaceId, id }) => docs.read(workspaceId, id),
    "docs.save": ({ workspaceId, id, content, revision }) =>
      docs.save(workspaceId, id, content, revision),
    "docs.opened": ({ workspaceId, id }) => markDocOpened(docs, workspaceId, id),
    "docs.archiveOlderThan": ({ days }) =>
      archiveDocsOlderThan(docs, store, days).pipe(Effect.map((archived) => ({ archived }))),
  } satisfies Partial<Handlers>;
});
