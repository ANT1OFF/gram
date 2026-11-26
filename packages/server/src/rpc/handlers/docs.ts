import * as Effect from "effect/Effect";

import { archiveDocsOlderThan, markDocOpened } from "../../docs/docs-sweep.ts";
import { Docs } from "../../docs/docs.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/**
 * `docs.*`: the doc pane's list, reads, the user's saves and opens of a workspace's docs, and the
 * Storage page's "Archive docs older than…".
 */
export const docHandlers = Effect.gen(function* () {
  const docs = yield* Docs;
  const store = yield* ThreadStore;
  return {
    "docs.list": ({ workspaceId }) =>
      docs.list(workspaceId).pipe(Effect.map((list) => ({ docs: list }))),
    "docs.read": ({ workspaceId, id }) => docs.read(workspaceId, id),
    "docs.save": ({ workspaceId, id, content, revision }) =>
      docs.save(workspaceId, id, content, revision),
    "docs.opened": ({ workspaceId, id }) => markDocOpened(docs, workspaceId, id),
    "docs.archiveOlderThan": ({ days }) =>
      archiveDocsOlderThan(docs, store, days).pipe(Effect.map((archived) => ({ archived }))),
  } satisfies Partial<Handlers>;
});
