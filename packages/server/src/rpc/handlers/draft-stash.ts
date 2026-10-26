import { NotFound, type DraftStash, type ThreadId } from "@gram/contracts";
import { isPhysicallyInside, isStrictlyInside } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ServerConfig } from "../../config.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import type { Handlers } from "./common.ts";

/** `thread.stash.*`: drafts set aside with ⌘S, kept per thread across restarts. */
export const draftStashHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const config = yield* ServerConfig;

  /**
   * Deletes the files `gone` uploaded, once their rows are deleted. Only paths inside the thread's
   * attachments folder count, as written and through any link on the way, so an attachment dragged
   * from disk keeps its file and a link in the folder doesn't lead the delete out of it. A path another of
   * the thread's stashes still references, or that `keep` lists for the live draft, stays: a retried
   * `thread.stash.add` can leave two rows with the same uploads, and a lost reply can leave the
   * composer holding what it stashed.
   */
  const deleteUploads = (
    threadId: ThreadId,
    gone: ReadonlyArray<DraftStash>,
    keep: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      if (gone.every((stash) => stash.attachments.length === 0)) return;
      const remaining = yield* store.listStashes(threadId);
      const referenced = new Set([
        ...keep.map((path) => resolve(path)),
        ...remaining.flatMap((stash) => stash.attachments.map((a) => resolve(a.path))),
      ]);
      const folder = resolve(join(config.dataDir, "attachments", threadId));
      yield* Effect.tryPromise(async () => {
        for (const stash of gone) {
          for (const attachment of stash.attachments) {
            const path = resolve(attachment.path);
            if (
              isStrictlyInside(folder, path) &&
              !referenced.has(path) &&
              (await isPhysicallyInside(folder, dirname(path)))
            )
              await rm(path, { force: true });
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("couldn't delete a stashed draft's attachments").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
          ),
        ),
      );
    });

  return {
    "thread.stash.list": ({ threadId }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        return { stashes: yield* store.listStashes(threadId) };
      }),
    "thread.stash.add": ({ id, threadId, text, attachments }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const dropped = yield* store.putStash({
          id,
          threadId,
          text,
          attachments,
          createdAt: yield* Clock.currentTimeMillis,
        });
        yield* deleteUploads(threadId, dropped);
        // A retry returns the stash first stored under `id`; an id another thread holds is refused.
        const stored = (yield* store.listStashes(threadId)).find((stash) => stash.id === id);
        if (stored === undefined) return yield* new NotFound({ entity: "stash", id });
        return stored;
      }),
    "thread.stash.take": ({ threadId, stashId }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        return yield* store.takeStash(threadId, stashId);
      }),
    "thread.stash.remove": ({ threadId, stashId, keep }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const stash = yield* store.takeStash(threadId, stashId);
        yield* deleteUploads(threadId, [stash], keep);
      }),
  } satisfies Partial<Handlers>;
});
