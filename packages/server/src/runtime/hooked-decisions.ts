import type { AgentSession } from "@gram/agents";
import type { PendingRequest, RequestId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  DECISION_UNAVAILABLE,
  refusalForAgent,
  refusalText,
  type Decided,
  type DecisionHookShape,
} from "../embedding/decision-hook.ts";
import type { EventSinkShape } from "../embedding/event-sink.ts";
import {
  type DecidingRequest,
  hookedKey,
  type HookedRequests,
  type RequestAction,
} from "../embedding/hooked-requests.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { locked, type Runtime } from "./runtime-state.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;

const sameAsk = (card: PendingRequest, request: PendingRequest): boolean => {
  if (card.shown === undefined) return false;
  const { shown: _shown, ...asked } = card;
  const { shown: _given, ...again } = request;
  const { decisionReason: _reason, ...shownCard } = asked as typeof asked & {
    readonly decisionReason?: string;
  };
  const { decisionReason: _again, ...plain } = again as typeof again & {
    readonly decisionReason?: string;
  };
  return JSON.stringify(canonical(shownCard)) === JSON.stringify(canonical(plain));
};

/** What raising a card, and putting a request to the hook, go through. */
export interface HookedDecisionsDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly hooked: HookedRequests;
  readonly eventSink: EventSinkShape | undefined;
  readonly setStatus: TurnLifecycle["setStatus"];
}

export const makeHookedDecisions = ({
  store,
  hub,
  hooked,
  eventSink,
  setStatus,
}: HookedDecisionsDeps) => {
  const raiseCard = (rt: Runtime, asked: PendingRequest) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const request: PendingRequest = { ...asked, shown: randomUUID() };
      yield* store.putRequest(rt.threadId, request, now);
      yield* hub.publish({ type: "thread.request", threadId: rt.threadId, request });
      yield* setStatus(rt, request.kind === "question" ? "needsInput" : "needsApproval");
    });

  const decideRequest = (
    rt: Runtime,
    asking: AgentSession | undefined,
    hook: DecisionHookShape,
    deciding: DecidingRequest,
    actions: ReadonlyArray<RequestAction>,
  ) =>
    Effect.gen(function* () {
      const request = deciding.request;
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.option);
      let refused:
        | { readonly action: RequestAction["action"]; readonly decided: Decided }
        | undefined;
      let asked: Decided | undefined;
      const answers: Array<RequestAction & { readonly decided: Decided }> = [];
      if (Option.isNone(thread)) {
        refused = {
          action: actions[0]!.action,
          decided: { id: "", decision: "refuse", reason: DECISION_UNAVAILABLE },
        };
      } else {
        for (const each of actions) {
          const decided = yield* hook.decide({ ...each, initiator: "agent", thread: thread.value });
          if (decided.decision === "refuse") {
            refused = { action: each.action, decided };
            break;
          }
          answers.push({ ...each, decided });
          if (decided.decision === "ask") asked ??= decided;
        }
      }
      yield* locked(
        rt,
        Effect.gen(function* () {
          const key = hookedKey(rt.threadId, request.id);
          if (hooked.deciding.get(key) !== deciding) return;
          hooked.deciding.delete(key);
          const session = rt.session;
          if (session === undefined || (asking !== undefined && session !== asking)) return;
          const refusal =
            refused === undefined ? undefined : refusalText(refused.action, refused.decided.reason);
          const forAgent =
            refused === undefined
              ? undefined
              : refusalForAgent(refused.action, refused.decided.reason);
          if (refused !== undefined || asked === undefined) {
            const delivered = yield* session
              .respond(
                request.id,
                forAgent === undefined
                  ? { kind: "approval", decision: "allow", scope: "once" }
                  : { kind: "approval", decision: "deny", scope: "once", message: forAgent },
              )
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.succeed(false)),
              );
            if (delivered) {
              if (refusal !== undefined) {
                yield* hub.publish({
                  type: "notify",
                  kind: "info",
                  title: refusal,
                  threadId: rt.threadId,
                });
              }
              if (rt.turn !== undefined && (yield* store.listRequests(rt.threadId)).length === 0) {
                yield* setStatus(rt, "running");
              }
              return;
            }
          }
          const basis = asked ?? refused?.decided ?? answers[0]?.decided;
          if (basis === undefined) return;
          const again = answers.filter((each) => each.decided.decision === "ask");
          hooked.asked.set(hookedKey(rt.threadId, request.id), {
            threadId: rt.threadId,
            actions:
              asked !== undefined && refused === undefined && again.length > 0
                ? again.map(({ decided, ...each }) => ({ ...each, decisionId: decided.id }))
                : actions.map((each) => ({
                    ...each,
                    decisionId:
                      answers.find((a) => a.action === each.action)?.decided.id ?? basis.id,
                  })),
          });
          if (eventSink !== undefined) {
            yield* eventSink.noteAsk(
              request.id,
              {
                decisionId: basis.id,
                ...(basis.assignees === undefined ? {} : { assignees: basis.assignees }),
                ...(basis.title === undefined ? {} : { title: basis.title }),
              },
              rt.threadId,
            );
          }
          const why = refusal ?? basis.reason;
          yield* raiseCard(rt, {
            ...request,
            ...(why === undefined || why.trim() === "" ? {} : { decisionReason: why }),
          });
        }),
      );
    });

  const replaceAsked = (rt: Runtime, requestId: RequestId) =>
    Effect.gen(function* () {
      const key = hookedKey(rt.threadId, requestId);
      hooked.asked.delete(key);
      const replaced = hooked.deciding.delete(key);
      const takenDown = yield* store.removeRequest(rt.threadId, requestId);
      if (takenDown) {
        yield* hub.publish({ type: "thread.requestResolved", threadId: rt.threadId, requestId });
      }
      if (replaced || takenDown) {
        yield* Effect.logWarning("an agent asked again under an id already in hand").pipe(
          Effect.annotateLogs({ threadId: rt.threadId, requestId }),
        );
      }
      return key;
    });

  const replayed = (rt: Runtime, request: PendingRequest) =>
    Effect.gen(function* () {
      if (hooked.deciding.has(hookedKey(rt.threadId, request.id))) return false;
      const card = (yield* store.listRequests(rt.threadId)).find((each) => each.id === request.id);
      return card !== undefined && sameAsk(card, request);
    });

  return { raiseCard, decideRequest, replaceAsked, replayed };
};
