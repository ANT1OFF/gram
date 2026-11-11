// The decision hook: before an outward action (a spawn, a push, opening or merging a pull request,
// a connector's call), ask a configured endpoint, which answers allow, refuse or ask a person.
//
// Off unless an endpoint is configured (`ServerConfigShape.decisionHook`) and hosted features are
// on in the settings. It is asked where the server already hears of the action: the approval an
// agent session raises for a command or a connector call (`runtime/hooked-requests.ts`), the app
// tools that spawn and merge (`app-tools/registry.ts`), and the app's own push and pull request
// calls. It sees what those see and no more: like the outward gate, it is no boundary against a
// push made by a route Gram can't read. What must hold against an agent is enforced where the
// credentials are.
//
// Every failure is a refusal: an endpoint that is down, slow or answers something else never lets
// an action through, and never hands the choice to a person the endpoint didn't name.

import {
  type DecisionAction,
  type DecisionApproval,
  type DecisionAssignee,
  DecisionRequest,
  DecisionResponse,
  EMBEDDING_WIRE_VERSION,
  embeddingOn,
  type EmbeddingActor,
  type Thread,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { ENDPOINT_UNUSABLE, type EndpointConfig, ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { postJson } from "./endpoint.ts";
import { EventSink } from "./event-sink.ts";
import { ActingPerson } from "./person.ts";

/** How long the endpoint has to answer before the action is refused. */
export const DECISION_TIMEOUT_MS = 10_000;

/** The parts of a thread a decision is asked with. */
export type DecisionSubject = Pick<Thread, "id" | "role" | "workspaceId" | "spawnedBy">;

export interface DecisionQuestion {
  readonly action: DecisionAction;
  readonly initiator: "agent" | "person";
  readonly thread: DecisionSubject;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Set on the second call, after a person approved what the first call answered `ask` to. */
  readonly approval?: DecisionApproval;
}

export interface Decided {
  /** The call's id, as the endpoint and the event sink saw it. */
  readonly id: string;
  readonly decision: "allow" | "refuse" | "ask";
  readonly reason?: string;
  readonly assignees?: ReadonlyArray<DecisionAssignee>;
  readonly title?: string;
}

export interface DecisionHookShape {
  /** Whether anything is asked: an endpoint is configured and hosted features are on. */
  readonly enabled: Effect.Effect<boolean>;
  /** Asks about one action. Never fails: what can't be asked is refused, with why. */
  decide(question: DecisionQuestion): Effect.Effect<Decided>;
}

/** What the endpoint being unreachable, slow or unreadable is said as. */
export const DECISION_UNAVAILABLE =
  "The decision endpoint could not be asked, so this was refused.";

/** A refusal as a person and an agent read it. */
export const refusalText = (action: DecisionAction, reason: string | undefined): string =>
  `Refused by policy (${action})${reason === undefined || reason.trim() === "" ? "." : `: ${reason.trim()}`}`;

const threadOf = (thread: DecisionSubject): DecisionRequest["thread"] => ({
  id: thread.id,
  ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
  role:
    thread.role === "orchestrator"
      ? "orchestrator"
      : thread.spawnedBy !== undefined
        ? "worker"
        : "plain",
  ...(thread.spawnedBy === undefined ? {} : { spawnedByThreadId: thread.spawnedBy.threadId }),
});

const actorOf = (question: DecisionQuestion, person: string | undefined): EmbeddingActor =>
  question.initiator === "person"
    ? { kind: "person", ...(person === undefined ? {} : { id: person }) }
    : { kind: "thread", id: question.thread.id };

const decodeResponse = Schema.decodeUnknownOption(DecisionResponse);
const encodeRequest = Schema.encodeSync(DecisionRequest);

/** The hook over one endpoint, which `on` turns on and off. */
export const makeDecisionHook = (
  endpoint: EndpointConfig,
  on: Effect.Effect<boolean>,
  record: (decided: Decided, request: DecisionRequest) => Effect.Effect<void> = () => Effect.void,
  timeoutMs: number = DECISION_TIMEOUT_MS,
): DecisionHookShape => ({
  enabled: on,
  decide: (question) =>
    Effect.gen(function* () {
      // The signed-in person this call is made for, when there is one: the one who pressed the
      // button, or the one who approved the card on the second call.
      const person = yield* ActingPerson;
      const approval =
        question.approval === undefined ||
        question.approval.answeredBy !== undefined ||
        person === undefined
          ? question.approval
          : { ...question.approval, answeredBy: person };
      const request: DecisionRequest = {
        v: EMBEDDING_WIRE_VERSION,
        id: randomUUID(),
        at: yield* Clock.currentTimeMillis,
        action: question.action,
        initiator: question.initiator,
        actor: actorOf(question, person),
        thread: threadOf(question.thread),
        detail: question.detail,
        ...(approval === undefined ? {} : { approval }),
      };
      const answer = yield* postJson(endpoint, encodeRequest(request), timeoutMs).pipe(
        Effect.map((body) => decodeResponse(body)),
        Effect.catch((error) =>
          Effect.logWarning("decision hook: the endpoint could not be asked").pipe(
            Effect.annotateLogs({ action: question.action, reason: error.message }),
            Effect.as(Option.none<DecisionResponse>()),
          ),
        ),
      );
      const decided: Decided = Option.match(answer, {
        onNone: () => ({
          id: request.id,
          decision: "refuse" as const,
          reason: DECISION_UNAVAILABLE,
        }),
        onSome: (response) => ({
          id: request.id,
          decision: response.decision,
          ...(response.reason === undefined ? {} : { reason: response.reason }),
          ...(response.assignees === undefined ? {} : { assignees: response.assignees }),
          ...(response.title === undefined ? {} : { title: response.title }),
        }),
      });
      yield* record(decided, request);
      return decided;
    }),
});

export class DecisionHook extends Context.Service<DecisionHook, DecisionHookShape>()(
  "@gram/server/DecisionHook",
) {
  /** Nothing is asked and everything is allowed: what a server with no endpoint runs. */
  static readonly off: DecisionHookShape = {
    enabled: Effect.succeed(false),
    decide: () => Effect.succeed({ id: "", decision: "allow" }),
  };

  /** From the server's config and settings; `off` with no endpoint configured. */
  static readonly layer: Layer.Layer<DecisionHook, never, ServerConfig | ThreadStore> =
    Layer.effect(
      DecisionHook,
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        if (config.decisionHook === undefined) return DecisionHook.off;
        const store = yield* ThreadStore;
        if (config.decisionHook === ENDPOINT_UNUSABLE) {
          // A hook that was asked for and can't be reached refuses, as an endpoint that is down
          // does: allowing everything because of a typing mistake would be the wrong way to fail.
          yield* Effect.logError(
            "decision hook: GRAM_DECISION_HOOK_URL or its token can't be used; refusing every action it would be asked about",
          );
          return {
            enabled: store.getSettings.pipe(Effect.map(embeddingOn)),
            decide: () =>
              Effect.succeed({ id: "", decision: "refuse", reason: DECISION_UNAVAILABLE }),
          } satisfies DecisionHookShape;
        }
        const sink = yield* Effect.serviceOption(EventSink);
        return makeDecisionHook(
          config.decisionHook,
          store.getSettings.pipe(Effect.map(embeddingOn)),
          (decided, request) =>
            Option.isNone(sink)
              ? Effect.void
              : sink.value.record({
                  type: "decision",
                  threadId: request.thread.id,
                  ...(request.thread.workspaceId === undefined
                    ? {}
                    : { workspaceId: request.thread.workspaceId }),
                  actor: request.actor,
                  data: {
                    id: decided.id,
                    action: request.action,
                    decision: decided.decision,
                    ...(decided.reason === undefined ? {} : { reason: decided.reason }),
                    ...(request.approval === undefined ? {} : { approval: request.approval }),
                  },
                }),
        );
      }),
    );
}

/**
 * The hook when it is on, for a caller that asks only then. `undefined` leaves the caller doing
 * exactly what it did before the hook existed.
 */
export const activeDecisionHook: Effect.Effect<DecisionHookShape | undefined> = Effect.gen(
  function* () {
    const hook = yield* Effect.serviceOption(DecisionHook);
    if (Option.isNone(hook)) return undefined;
    return (yield* hook.value.enabled) ? hook.value : undefined;
  },
);
