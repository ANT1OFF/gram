import { InvalidState, LOCAL_HOST_ID, sessionHostOf } from "@gram/contracts";
import { isInside, tryRealPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { join, resolve } from "node:path";
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
import { openerFenced } from "../../platform/opener.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

const NOT_ATTACHED = "That file isn't attached to this thread";

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
        const thread = Option.getOrUndefined(yield* store.getThread(threadId).pipe(Effect.option));
        const confined =
          openerFenced(config) || (thread !== undefined && sessionHostOf(thread) !== LOCAL_HOST_ID);
        const own = join(attachmentsDir(config.dataDir), threadId);
        if (confined && !isInside(resolve(own), resolve(path)))
          return yield* new InvalidState({ message: NOT_ATTACHED });
        const stored = yield* store.messagesWithParts(threadId, ["file", "data-tool-image"]);
        const messages = [...stored, ...(yield* runtimes.liveMessages(threadId))];
        const key = attachmentKey(config.dataDir, threadId, path);
        if (key !== undefined && referencedAttachments(messages).has(resolve(path))) {
          yield* objects.fetch(key, resolve(path));
        }
        if (confined) {
          const [root, real] = yield* Effect.promise(() =>
            Promise.all([tryRealPath(own), tryRealPath(resolve(path))]),
          );
          if (root === undefined || real === undefined || !isInside(root, real))
            return yield* new InvalidState({ message: NOT_ATTACHED });
        }
        return yield* readThreadAttachment(messages, path);
      }),
  } satisfies Partial<Handlers>;
});
