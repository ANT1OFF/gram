import { ComposerRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { assistHandlers } from "../../helper/handler.ts";
import { attachmentHandlers } from "./attachments.ts";
import { logDefects } from "./common.ts";
import { draftStashHandlers } from "./draft-stash.ts";
import { promptHistoryHandlers } from "./prompt-history.ts";

/** The composer group's handler layer: attachments, stashed drafts, prompt history, the helper. */
export const ComposerHandlersLive = ComposerRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* attachmentHandlers),
      ...(yield* draftStashHandlers),
      ...(yield* promptHistoryHandlers),
      ...(yield* assistHandlers),
    };
    return ComposerRpcs.of(logDefects(ComposerRpcs, handlers));
  }),
);
