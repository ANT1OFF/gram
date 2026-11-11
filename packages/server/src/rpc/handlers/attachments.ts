import { tryRealPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { resolve } from "node:path";
import {
  attachmentsDir,
  makeAttachments,
  readThreadAttachment,
  referencedAttachments,
} from "../../attachments/attachments.ts";
import { attachmentKey, ObjectStore } from "../../embedding/object-store.ts";
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
  const objects = yield* ObjectStore;

  const attachments = yield* makeAttachments({
    dir: attachmentsDir(config.dataDir),
    threadExists: (threadId) => Effect.asVoid(store.getThread(threadId)),
    closedThreads: hub
      .internalEvents(isThreadRemoved, "attachment cleanup")
      .pipe(Stream.map((event) => event.threadId)),
  });

  return {
    "attachment.upload": (request) =>
      attachments.upload(request).pipe(
        // Sent to the object store now rather than at its next walk; a draft's once it is adopted.
        Effect.tap((attachment) =>
          Effect.gen(function* () {
            const key =
              request.threadId === undefined
                ? undefined
                : attachmentKey(config.dataDir, request.threadId, attachment.path);
            if (key === undefined) return;
            const real = yield* Effect.promise(() => tryRealPath(attachment.path));
            if (real !== undefined) yield* objects.put(key, real);
          }),
        ),
      ),

    "attachment.read": ({ threadId, path }) =>
      Effect.gen(function* () {
        // Only a `file` or stored tool-image part can name an attachment, so only those decode.
        const stored = yield* store.messagesWithParts(threadId, ["file", "data-tool-image"]);
        const messages = [...stored, ...(yield* runtimes.liveMessages(threadId))];
        // On a disk that never held it, one of the thread's own attachments comes back from the
        // object store first. Only a path the thread's messages name is ever asked for.
        const key = attachmentKey(config.dataDir, threadId, path);
        if (key !== undefined && referencedAttachments(messages).has(resolve(path))) {
          yield* objects.fetch(key, resolve(path));
        }
        return yield* readThreadAttachment(messages, path);
      }),
  } satisfies Partial<Handlers>;
});
