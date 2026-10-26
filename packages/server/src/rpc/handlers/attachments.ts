import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  attachmentsDir,
  makeAttachments,
  readThreadAttachment,
} from "../../attachments/attachments.ts";
import { ServerConfig } from "../../config.ts";
import { EventHub, isThreadRemoved } from "../../events/event-hub.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/**
 * `attachment.upload`: pasted and dropped files, stored per thread and deleted with the thread, and
 * `attachment.read`, which serves one back for the transcript's inline previews.
 */
export const attachmentHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hub = yield* EventHub;
  const config = yield* ServerConfig;
  const runtimes = yield* ThreadRuntimes;

  const attachments = yield* makeAttachments({
    dir: attachmentsDir(config.dataDir),
    threadExists: (threadId) => Effect.asVoid(store.getThread(threadId)),
    closedThreads: hub
      .internalEvents(isThreadRemoved, "attachment cleanup")
      .pipe(Stream.map((event) => event.threadId)),
  });

  return {
    "attachment.upload": (request) => attachments.upload(request),

    "attachment.read": ({ threadId, path }) =>
      Effect.gen(function* () {
        const stored = yield* store.listMessages(threadId);
        return yield* readThreadAttachment(
          [...stored, ...(yield* runtimes.liveMessages(threadId))],
          path,
        );
      }),
  } satisfies Partial<Handlers>;
});
