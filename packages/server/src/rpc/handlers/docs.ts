import * as Effect from "effect/Effect";

import { Docs } from "../../docs/docs.ts";
import type { Handlers } from "./common.ts";

/** `docs.*`: the doc pane's list, reads and the user's saves of a workspace's docs. */
export const docHandlers = Effect.gen(function* () {
  const docs = yield* Docs;
  return {
    "docs.list": ({ workspaceId }) =>
      docs.list(workspaceId).pipe(Effect.map((list) => ({ docs: list }))),
    "docs.read": ({ workspaceId, id }) => docs.read(workspaceId, id),
    "docs.save": ({ workspaceId, id, content, revision }) =>
      docs.save(workspaceId, id, content, revision),
  } satisfies Partial<Handlers>;
});
