import {
  AppToolError,
  effectiveCheckout,
  LOCAL_HOST_ID,
  sessionHostOf,
  type ThreadId,
} from "@gram/contracts";
import { realPathOrOwned } from "@gram/git";
import * as Effect from "effect/Effect";
import { relative } from "node:path";
import type { WorkspaceOutputsShape } from "../outputs/workspace-outputs.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { EvidencePathError, writeEvidence } from "./evidence.ts";

/**
 * Where the browser tools save evidence: `checkoutOf` is the thread's checkout on this disk, and
 * `saveEvidence` writes a capture inside it, listing it with `outputs` when given.
 */
export const evidenceSaver = (
  store: Pick<ThreadStoreShape, "getThread">,
  outputs: Pick<WorkspaceOutputsShape, "record"> | undefined,
) => {
  /**
   * The thread's checkout, where evidence files go, on this disk: a thread whose session runs on
   * another machine has its folder there, and the same path here is this machine's own.
   */
  const checkoutOf = (tool: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* store
        .getThread(threadId)
        .pipe(
          Effect.mapError(() => new AppToolError({ tool, message: `unknown thread ${threadId}` })),
        );
      if (sessionHostOf(thread) !== LOCAL_HOST_ID)
        return yield* new AppToolError({
          tool,
          message:
            "This thread runs on another machine, and evidence is saved only for threads on the machine Gram itself runs on.",
        });
      return effectiveCheckout(thread).path;
    });

  /**
   * Writes evidence inside the checkout; the path as the agent would name it, relative. A failed
   * write names only the path the agent gave, never what this disk said about it.
   */
  const saveEvidence = (
    tool: string,
    threadId: ThreadId,
    path: string,
    base64: string,
    extension: ".png" | ".gif",
  ) =>
    Effect.gen(function* () {
      const root = yield* checkoutOf(tool, threadId);
      const written = yield* Effect.tryPromise({
        try: () => writeEvidence(root, path, Buffer.from(base64, "base64"), extension),
        catch: (error) =>
          new AppToolError({
            tool,
            message: error instanceof EvidencePathError ? error.message : `Couldn't write ${path}.`,
          }),
      });
      if (outputs !== undefined)
        yield* outputs.record(threadId, { path: written, source: "evidence" });
      return relative(yield* Effect.promise(() => realPathOrOwned(root)), written);
    });

  return { checkoutOf, saveEvidence };
};
