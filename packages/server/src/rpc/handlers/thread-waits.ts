import { InvalidState, NotFound, plainWaitText, waitTitleOf, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HelperScheduler } from "../../helper/scheduler.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ThreadWaits } from "../../waits/service.ts";
import type { Handlers } from "./common.ts";

const waitsFull = (threadId: ThreadId) => (full: { readonly open: number }) =>
  Effect.fail(
    new InvalidState({
      message: `${full.open} items already wait on you; mark one done first`,
      threadId,
    }),
  );

/**
 * `thread.resolveWait`, `thread.keepWait` and `thread.addWait`: what the user does to a thread's
 * Waiting on you. Done, Dismiss (not done, with why) and Undo resolve or reopen an item; the agent
 * hears of each with the next message.
 */
export const threadWaitHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const waits = yield* ThreadWaits;
  const helper = Option.getOrUndefined(yield* Effect.serviceOption(HelperScheduler));
  const waitEvent = (event: "kept" | "dismissed" | "restored") =>
    helper === undefined ? Effect.void : helper.recordEvent("wait", event);

  return {
    "thread.resolveWait": ({ threadId, id, undo, dismiss, note }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const why = note === undefined ? "" : plainWaitText(note);
        const { item, changed } = yield* waits
          .resolve(
            threadId,
            id,
            undo === true
              ? undefined
              : {
                  by: "user",
                  at: Date.now(),
                  ...(dismiss === true ? { ending: "dismissed" as const } : {}),
                  ...(dismiss === true && why !== "" ? { note: why } : {}),
                },
          )
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        if (changed && item.suggested === true) {
          yield* waitEvent(undo === true ? "restored" : "dismissed");
        }
        return item;
      }),
    "thread.keepWait": ({ threadId, id }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const item = yield* waits
          .keep(threadId, id)
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        yield* waitEvent("kept");
        return item;
      }),
    "thread.addWait": ({ threadId, messageId, kind, title }) =>
      Effect.gen(function* () {
        yield* store.getThread(threadId);
        const message = yield* store.getMessage(threadId, messageId);
        if (message === undefined) {
          return yield* new NotFound({
            entity: "message",
            id: messageId,
            message: "That message isn't saved yet; try again once the reply has finished.",
          });
        }
        const named =
          title === undefined
            ? waitTitleOf(
                message.parts
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join("\n"),
              )
            : plainWaitText(title);
        if (named === undefined || named === "") {
          return yield* new InvalidState({
            message: "That message has no text to name the item by; give it a title.",
            threadId,
          });
        }
        const { item } = yield* waits
          .put(threadId, { kind: kind ?? "draft", title: named, anchor: messageId }, "user")
          .pipe(Effect.catchTag("WaitsFull", waitsFull(threadId)));
        return item;
      }),
  } satisfies Partial<Handlers>;
});
