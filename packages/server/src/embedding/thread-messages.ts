// `POST /embed/v1/thread-messages` and `POST /embed/v1/thread-interrupt`: a person's message into
// one thread, and stopping its turn, asked for by the platform the server is embedded in on behalf
// of a person it signed in. It is how a person's own API or MCP client writes in a thread without a
// browser: the platform decided that the person may, and names them.
//
//   thread-messages  { "threadId", "person": { "id", "name"? }, "text", "key", "mode"?,
//                      "conversation"?: { "id", "label"? } }
//     → 200 { "queued": false }                 sent now, or steered into the running turn
//       200 { "queued": true }                  a turn was running: it waits behind it
//   thread-interrupt { "threadId", "person": { "id", "name"? } }
//     → 200 { "interrupted": true }
//   thread-fresh-session { "threadId", "person": { "id", "name"? }, "checkpoint"?, "model"? }
//     → 200 { "started": true }                 an orchestrator's fresh session is under way, or
//                                               any other thread's, on `model`
//   thread-resume-machine-lost { "threadId", "person": { "id", "name"? } }
//     → 200 { "resumed": true }                 the conversation a lost machine cut off goes on
//   each → 404 no such thread, 409 { "error" } one that can't take it now, 400 a body that isn't one
//
// An orchestrator's fresh session (`orchestrator.handoff`, the web app's Fresh session) replaces
// its agent session, with memory, charter and ledger as the bridge. Any other thread's needs a
// `model` and is its menu's Start fresh in… (`thread.startFreshOn`): a new session on that model in
// the same thread, which reads the recent turns; `checkpoint` doesn't apply to it.
// `checkpoint` (default true) has the orchestrator save to memory first; false is a hard cut.
// `model` (a `ModelRef`) opens the fresh session on it, and it becomes the workspace's orchestrator
// model: the way onto a model the running session can't carry over to.
//
// A resume after a lost machine is the web app's Resume worker (`thread.resumeAfterMachineLost`):
// the same conversation is told what was cut off, and opens again once the machine is back. It is
// refused (409) for a thread whose last turn a lost machine didn't end.
//
// The message is the person's, exactly as one they typed in the web app: the same receipt, so a
// `key` sent again is one message (`thread.send`'s `clientMessageId`), the same record of who
// acted, and the same rule for a machine started for one person, which only that person reaches.
// `mode` is `queue` (the default, `thread.send`), `steer` (into the running turn, cancelling
// nothing) or `interrupt` (the turn stops and the agent answers this); a steer on a thread with no
// turn it can take it in is sent as `queue` would.
//
// `conversation` names the host's own conversation the message came from (a chat thread, say):
// the transcript shows where it came from, the agent is told so it can `reply` there, and the
// thread owns the conversation unless another open thread does (`conversations.ts`).
//
// The platform is trusted to say who the person is, as it is when it starts a thread for one
// (`/threads/from-profile`'s `startedBy`): it proves itself with the embed token, never a cookie.

import { readableByOf, readerMay } from "./readable-by.ts";
import {
  type ConversationRef,
  conversationRefProblem,
  ModelRef,
  ThreadRpcs,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { Conversations } from "./conversations.ts";
import { Orchestration } from "../orchestration/service.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mayReachThread, NOT_YOUR_MACHINE, ownersOf, RoutedFor } from "../host/ownership.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import type { Actor } from "../http/fronted-identity.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { actorEventsOf } from "../rpc/actor-guard.ts";
import { resumeAfterMachineLost } from "../runtime/machine-lost.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { answer, EmbedInbound, refusal, type EmbedAnswer } from "./inbound.ts";
import { ActingPerson } from "./person.ts";

/** The longest message, as the platform's own API takes it. */
export const THREAD_MESSAGE_MAX = 20_000;

export const THREAD_MESSAGE_MODES = ["queue", "steer", "interrupt"] as const;
export type ThreadMessageMode = (typeof THREAD_MESSAGE_MODES)[number];

const THREAD = /^[A-Za-z0-9_.:-]{1,200}$/;
/** As `thread.send`'s `clientMessageId`. */
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const PERSON = /^[A-Za-z0-9_.:@|-]{1,200}$/;

const sendRpc = [...ThreadRpcs.requests.values()].find((rpc) => rpc._tag === "thread.send")!;

/** The person a call names, or why the body doesn't name one. */
const personOf = (value: unknown): Actor | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "`person` is the person the platform signed in, with their `id`";
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !PERSON.test(id)) return "`person.id` is a person's id";
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 200))
    return "`person.name` is 1 to 200 characters";
  return { id, name: typeof name === "string" ? name.trim() : id, role: "member" };
};

/** The answer to a failure the runtime names, in its own words. */
const failed = (error: { readonly _tag: string; readonly message?: string }): EmbedAnswer =>
  error._tag === "ThreadNotFound"
    ? refusal(404, "there is no such thread")
    : refusal(409, error.message ?? "the thread can't take that now");

/** Serves both paths; provides nothing. */
export const ThreadMessagesInboundLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const machines = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts))?.machines;
    const ownerOf = ownersOf(machines);
    const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
    const conversations = Option.getOrUndefined(yield* Effect.serviceOption(Conversations));

    /**
     * `effect` as `person`, for the thread: refused for a thread on a machine started for someone
     * else, and recorded as theirs once it has run, as the RPC guard records a person's call.
     */
    const asPerson = <A, E>(
      person: Actor,
      threadId: ThreadId,
      action: string,
      payload: Record<string, unknown>,
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A | "not-yours", E> =>
      Effect.gen(function* () {
        if (!(yield* mayReachThread(store.getThread, ownerOf, threadId)))
          return "not-yours" as const;
        // A thread readable by one person takes what is sent, interrupted or restarted for them
        // alone (`embedding/readable-by.ts`).
        if (!readerMay({ subject: person.id }, readableByOf(threadId))) return "not-yours" as const;
        const result = yield* effect;
        yield* store.appendActorEvents(actorEventsOf(person, action, payload, Date.now(), result));
        return result;
      }).pipe(
        Effect.provideService(ActingPerson, person.id),
        Effect.provideService(RoutedFor, { person: person.id }),
      );

    yield* inbound.route("POST", "thread-messages", (body) =>
      Effect.gen(function* () {
        const threadId = body?.["threadId"];
        const key = body?.["key"];
        const text = body?.["text"];
        const mode = body?.["mode"] ?? "queue";
        if (typeof threadId !== "string" || !THREAD.test(threadId))
          return refusal(400, "`threadId` is a thread's id");
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        if (typeof key !== "string" || !KEY.test(key))
          return refusal(400, "`key` is 1 to 128 letters, digits, `_` or `-`");
        if (typeof text !== "string" || text.trim() === "" || text.length > THREAD_MESSAGE_MAX)
          return refusal(400, `\`text\` is 1 to ${THREAD_MESSAGE_MAX} characters`);
        if (typeof mode !== "string" || !(THREAD_MESSAGE_MODES as readonly string[]).includes(mode))
          return refusal(400, "`mode` is `queue`, `steer` or `interrupt`");
        const given = body?.["conversation"];
        const problem = given === undefined ? undefined : conversationRefProblem(given);
        if (problem !== undefined) return refusal(400, problem);
        const conversation = given as ConversationRef | undefined;
        if (conversation !== undefined && conversations === undefined)
          return refusal(409, "this server keeps no conversations");
        const id = threadId as ThreadId;
        if (Option.isNone(yield* store.getThread(id).pipe(Effect.option)))
          return refusal(404, "there is no such thread");

        const input: UserInput = {
          text,
          ...(conversation === undefined
            ? {}
            : {
                conversation: {
                  id: conversation.id,
                  ...(conversation.label === undefined ? {} : { label: conversation.label.trim() }),
                },
              }),
        };
        // A steer the thread can't take now (no turn running, or an agent that can't) is sent.
        const deliver =
          mode === "queue"
            ? runtimes.send(id, input)
            : runtimes
                .steer(id, input, mode === "interrupt" ? { interrupt: true } : undefined)
                .pipe(
                  Effect.as({ queued: false }),
                  Effect.catchTag("InvalidState", () => runtimes.send(id, input)),
                );
        // One receipt per key, as the web app's: sent again, it answers what the first did.
        // The thread takes the conversation as the message goes in, and keeps it if it can't be
        // sent now: the host routed the conversation here.
        const received = store.messageReceipt(
          id,
          key,
          ["embed", mode, input],
          sendRpc.successSchema,
          sendRpc.errorSchema,
          input.conversation === undefined || conversations === undefined
            ? deliver
            : Effect.andThen(conversations.arrive(id, input.conversation), deliver),
        );
        const outcome = yield* asPerson(
          person,
          id,
          mode === "queue" ? "thread.send" : "thread.steer",
          { threadId: id, clientMessageId: key },
          received,
        ).pipe(
          Effect.map((result) =>
            result === "not-yours"
              ? refusal(409, NOT_YOUR_MACHINE)
              : answer({ queued: result.queued }),
          ),
          Effect.catch((error) => Effect.succeed(failed(error))),
        );
        return outcome;
      }),
    );

    yield* inbound.route("POST", "thread-interrupt", (body) =>
      Effect.gen(function* () {
        const threadId = body?.["threadId"];
        if (typeof threadId !== "string" || !THREAD.test(threadId))
          return refusal(400, "`threadId` is a thread's id");
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const id = threadId as ThreadId;
        if (Option.isNone(yield* store.getThread(id).pipe(Effect.option)))
          return refusal(404, "there is no such thread");
        return yield* asPerson(
          person,
          id,
          "thread.interrupt",
          { threadId: id },
          runtimes.interrupt(id, { endLimitWait: true }),
        ).pipe(
          Effect.map((result) =>
            result === "not-yours" ? refusal(409, NOT_YOUR_MACHINE) : answer({ interrupted: true }),
          ),
          Effect.catch((error) => Effect.succeed(failed(error))),
        );
      }),
    );

    yield* inbound.route("POST", "thread-fresh-session", (body) =>
      Effect.gen(function* () {
        const threadId = body?.["threadId"];
        if (typeof threadId !== "string" || !THREAD.test(threadId))
          return refusal(400, "`threadId` is a thread's id");
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const checkpoint = body?.["checkpoint"];
        if (checkpoint !== undefined && typeof checkpoint !== "boolean")
          return refusal(400, "`checkpoint` is true or false");
        const rawModel = body?.["model"];
        const model =
          rawModel === undefined
            ? undefined
            : Option.getOrUndefined(Schema.decodeUnknownOption(ModelRef)(rawModel));
        if (rawModel !== undefined && model === undefined)
          return refusal(400, "`model` is an agent and a model it lists");
        const id = threadId as ThreadId;
        const thread = Option.getOrUndefined(yield* store.getThread(id).pipe(Effect.option));
        if (thread === undefined) return refusal(404, "there is no such thread");
        // Any other thread starts fresh only onto a model, as its own menu does (`startFreshOn`).
        if (thread.role !== "orchestrator") {
          if (model === undefined)
            return refusal(
              409,
              "a thread that isn't an orchestrator starts fresh only on another model: name `model`",
            );
          return yield* asPerson(
            person,
            id,
            "thread.startFreshOn",
            { threadId: id, model },
            runtimes.startFreshOn(id, model),
          ).pipe(
            Effect.map((result) =>
              result === "not-yours" ? refusal(409, NOT_YOUR_MACHINE) : answer({ started: true }),
            ),
            Effect.catch((error) => Effect.succeed(failed(error))),
          );
        }
        if (thread.workspaceId === undefined)
          return refusal(409, "only a workspace's orchestrator starts a fresh session");
        if (orchestration === undefined) return refusal(409, "this server runs no orchestration");
        const workspaceId = thread.workspaceId;
        const holder = yield* store.getWorkspace(workspaceId).pipe(
          Effect.map((state) => state.workspace.orchestratorThreadId),
          Effect.orElseSucceed(() => undefined),
        );
        if (holder !== id)
          return refusal(409, "this thread no longer holds its workspace's orchestrator");
        return yield* asPerson(
          person,
          id,
          "orchestrator.handoff",
          {
            workspaceId,
            ...(checkpoint === undefined ? {} : { checkpoint }),
            ...(model === undefined ? {} : { model }),
          },
          orchestration.handoff(workspaceId, "user", model, {
            ...(checkpoint === undefined ? {} : { checkpoint }),
            ...(model === undefined ? {} : { fresh: true }),
          }),
        ).pipe(
          Effect.map((result) =>
            result === "not-yours" ? refusal(409, NOT_YOUR_MACHINE) : answer({ started: true }),
          ),
          Effect.catch((error) => Effect.succeed(failed(error))),
        );
      }),
    );

    yield* inbound.route("POST", "thread-resume-machine-lost", (body) =>
      Effect.gen(function* () {
        const threadId = body?.["threadId"];
        if (typeof threadId !== "string" || !THREAD.test(threadId))
          return refusal(400, "`threadId` is a thread's id");
        const person = personOf(body?.["person"]);
        if (typeof person === "string") return refusal(400, person);
        const id = threadId as ThreadId;
        if (Option.isNone(yield* store.getThread(id).pipe(Effect.option)))
          return refusal(404, "there is no such thread");
        return yield* asPerson(
          person,
          id,
          "thread.resumeAfterMachineLost",
          { threadId: id },
          resumeAfterMachineLost(store, runtimes, id),
        ).pipe(
          Effect.map((result) =>
            result === "not-yours"
              ? refusal(409, NOT_YOUR_MACHINE)
              : result
                ? answer({ resumed: true })
                : refusal(409, "this thread's last turn wasn't cut off by a lost machine"),
          ),
          Effect.catch((error) => Effect.succeed(failed(error))),
        );
      }),
    );
  }),
);
