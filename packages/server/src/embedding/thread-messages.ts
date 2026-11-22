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
import {
  asThreadOwner,
  mayReachThread,
  NOT_YOUR_MACHINE,
  ownersOf,
  RoutedFor,
} from "../host/ownership.ts";
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
const KEY = /^[A-Za-z0-9_-]{1,128}$/;
const PERSON = /^[A-Za-z0-9_.:@|-]{1,200}$/;

const sendRpc = [...ThreadRpcs.requests.values()].find((rpc) => rpc._tag === "thread.send")!;

const personOf = (value: unknown): Actor | string => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "`person` is the person the platform signed in, with their `id`";
  const { id, name } = value as Record<string, unknown>;
  if (typeof id !== "string" || !PERSON.test(id)) return "`person.id` is a person's id";
  if (name !== undefined && (typeof name !== "string" || name.trim() === "" || name.length > 200))
    return "`person.name` is 1 to 200 characters";
  return { id, name: typeof name === "string" ? name.trim() : id, role: "member" };
};

/**
 * Whom a message or a stop is sent for: `person`, the default, for the person who wrote it, so a
 * thread on a machine started for someone else refuses it; `thread`, for the thread's own machine's
 * owner, as its agent's tool calls are, while it is still shown and recorded as the person's. The
 * platform asks for `thread` where it lets more people than the machine's own write in a thread (a
 * shared agent's, on a machine started for no person) and has decided this person may.
 */
export type SentFor = "person" | "thread";

const sentForOf = (value: unknown): SentFor | string =>
  value === undefined || value === "person"
    ? "person"
    : value === "thread"
      ? "thread"
      : "`for` is `person` or `thread`";

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

    const asPerson = <A, E>(
      person: Actor,
      threadId: ThreadId,
      action: string,
      payload: Record<string, unknown>,
      effect: Effect.Effect<A, E>,
      sentFor: SentFor = "person",
    ): Effect.Effect<A | "not-yours", E> =>
      Effect.gen(function* () {
        if (!(yield* mayReachThread(store.getThread, ownerOf, threadId)))
          return "not-yours" as const;
        if (!readerMay({ subject: person.id }, readableByOf(threadId))) return "not-yours" as const;
        const result = yield* effect;
        yield* store.appendActorEvents(actorEventsOf(person, action, payload, Date.now(), result));
        return result;
      }).pipe(
        Effect.provideService(ActingPerson, person.id),
        sentFor === "thread"
          ? asThreadOwner(store.getThread, ownerOf, threadId)
          : Effect.provideService(RoutedFor, { person: person.id }),
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
        const sentFor = sentForOf(body?.["for"]);
        if (sentFor !== "person" && sentFor !== "thread") return refusal(400, sentFor);
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
        const deliver =
          mode === "queue"
            ? runtimes.send(id, input)
            : runtimes
                .steer(id, input, mode === "interrupt" ? { interrupt: true } : undefined)
                .pipe(
                  Effect.as({ queued: false }),
                  Effect.catchTag("InvalidState", () => runtimes.send(id, input)),
                );
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
          sentFor,
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
        const sentFor = sentForOf(body?.["for"]);
        if (sentFor !== "person" && sentFor !== "thread") return refusal(400, sentFor);
        const id = threadId as ThreadId;
        if (Option.isNone(yield* store.getThread(id).pipe(Effect.option)))
          return refusal(404, "there is no such thread");
        return yield* asPerson(
          person,
          id,
          "thread.interrupt",
          { threadId: id },
          runtimes.interrupt(id, { endLimitWait: true }),
          sentFor,
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
