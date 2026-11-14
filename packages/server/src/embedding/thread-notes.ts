// `POST /embed/v1/thread-notes`: a note for one thread from the platform the server is embedded
// in, which the thread's agent takes as a turn of its own once the thread is free, as it takes any
// other server-authored input. It is how the platform wakes a thread at rest for something that
// happened outside it, such as an answer given somewhere else to what the agent was waiting on.
//
//   { "threadId": "...", "key": "...", "text": "..." }
//   →  200 { "delivered": true }                      the agent took it
//      202 { "delivered": false, "queued": true }     it waits for the thread to be free
//      404 / 409 { "error": "..." }                    no such thread, or one that can't take it
//
// `key` names the note to the caller. A note sent again with a key that is waiting replaces
// nothing and is still waiting; one with a key already delivered by this process answers
// `delivered` again, so a caller that retries until it hears `delivered` sends it once. Neither is
// kept past the process: a note that was waiting when the server stopped is lost, and the caller,
// which never heard `delivered`, sends it again to the server that starts.
//
// The note is shown to the agent as the platform's words, never as a person's: it grants nothing,
// and an agent that is asked to do something by it decides as it would on any other input.

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ThreadId } from "@gram/contracts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { SystemDeliveryFailure } from "../runtime/system-delivery.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";

/** The longest note. */
export const THREAD_NOTE_MAX = 4000;

/** How long a call waits for the agent to take its note before it answers `queued`. */
export const THREAD_NOTE_WAIT = Duration.seconds(20);

/** How many delivered keys are remembered, so a retry isn't sent twice. */
const REMEMBERED = 1000;

const KEY = /^[A-Za-z0-9_.:@-]{1,200}$/;
const THREAD = /^[A-Za-z0-9_.:-]{1,200}$/;

/** What the agent reads: the note, said to be the platform's. */
export const threadNoteInput = (text: string) => ({
  text: `A note from the app this workspace runs in. It is not from a person in this thread.\n\n${text}`,
});

type Outcome = { readonly delivered: true } | { readonly failed: SystemDeliveryFailure };

/** Serves `thread-notes`; provides nothing. */
export const ThreadNotesInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    /** Keys waiting for the agent, each with the outcome a call may wait on. */
    const waiting = new Map<string, Deferred.Deferred<Outcome>>();
    /** Keys delivered, oldest first. */
    const delivered = new Set<string>();
    const remember = (key: string) => {
      delivered.add(key);
      if (delivered.size > REMEMBERED) delivered.delete(delivered.values().next().value!);
    };

    const respond = (outcome: Option.Option<Outcome>) => {
      if (Option.isNone(outcome)) return answer({ delivered: false, queued: true }, 202);
      return "delivered" in outcome.value
        ? answer({ delivered: true })
        : refusal(409, `the thread didn't take the note (${outcome.value.failed})`);
    };

    yield* inbound.route("POST", "thread-notes", (body) =>
      Effect.gen(function* () {
        const threadId = body?.["threadId"];
        const key = body?.["key"];
        const text = body?.["text"];
        if (typeof threadId !== "string" || !THREAD.test(threadId))
          return refusal(400, "`threadId` is a thread's id");
        if (typeof key !== "string" || !KEY.test(key)) return refusal(400, "`key` is a note's key");
        if (typeof text !== "string" || text.trim() === "" || text.length > THREAD_NOTE_MAX)
          return refusal(400, `\`text\` is 1 to ${THREAD_NOTE_MAX} characters`);
        if (delivered.has(key)) return answer({ delivered: true });
        const already = waiting.get(key);
        if (already !== undefined)
          return respond(
            yield* Deferred.await(already).pipe(Effect.timeoutOption(THREAD_NOTE_WAIT)),
          );

        const id = threadId as ThreadId;
        const thread = yield* store.getThread(id).pipe(Effect.option);
        if (Option.isNone(thread)) return refusal(404, "there is no such thread");

        const outcome = yield* Deferred.make<Outcome>();
        waiting.set(key, outcome);
        const settle = (result: Outcome) =>
          Effect.sync(() => {
            if (waiting.get(key) === outcome) waiting.delete(key);
            if ("delivered" in result) remember(key);
          }).pipe(Effect.andThen(Deferred.succeed(outcome, result)), Effect.asVoid);
        const asked = yield* runtimes
          .requestSystemDelivery(id, `embed-note:${key}`, {
            build: () => Effect.succeed(threadNoteInput(text)),
            accepted: () => settle({ delivered: true }),
            failed: (_turnId, reason) => settle({ failed: reason }),
          })
          .pipe(Effect.option);
        if (Option.isNone(asked)) {
          waiting.delete(key);
          return refusal(404, "there is no such thread");
        }
        return respond(yield* Deferred.await(outcome).pipe(Effect.timeoutOption(THREAD_NOTE_WAIT)));
      }),
    );
  }),
);
