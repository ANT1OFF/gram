import * as Effect from "effect/Effect";

import { WorkspaceOutputs } from "../../outputs/workspace-outputs.ts";
import type { Handlers } from "./common.ts";

/** `workspace.outputs`: the Files view's pages of what the workspace's threads produced. */
export const outputHandlers = Effect.gen(function* () {
  const outputs = yield* WorkspaceOutputs;
  return {
    "workspace.outputs": ({ workspaceId, kind, cursor, limit }) =>
      outputs.list(workspaceId, { kind, cursor, limit }),
  } satisfies Partial<Handlers>;
});
