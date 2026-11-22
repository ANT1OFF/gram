import type { ThreadId } from "@gram/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  DECISION_UNAVAILABLE,
  DecisionHook,
  refusalText,
  type DecisionHookShape,
  type DecisionQuestion,
} from "./decision-hook.ts";

/** An action the decision hook, or the person it sent it to, did not let through. */
export class ActionRefused extends Data.TaggedError("ActionRefused")<{
  readonly message: string;
}> {}

/** The card a person sees when the hook answers `ask`. */
export interface ActionCard {
  /** The tool's name as the card and the logs have it, `mcp__gram__merge_when_ready`. */
  readonly toolName: string;
  readonly displayName: string;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Lets an action through, or refuses it. Answers whether the hook decided it (`true`: asked, and
 * allowed or approved), or let it through unasked (`false`: no hook, or one that is off).
 */
export type ActionGuard = (
  threadId: ThreadId,
  question: Pick<DecisionQuestion, "action" | "initiator" | "detail">,
  card: Effect.Effect<ActionCard>,
) => Effect.Effect<boolean, ActionRefused>;

export interface ActionGuardDeps {
  /** `undefined` where no hook is configured: the guard then lets everything through unasked. */
  readonly hook: DecisionHookShape | undefined;
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly runtimes: Pick<ThreadRuntimesShape, "requestApproval">;
}

/**
 * How many cards one action raises at most: the hook asks again when someone it doesn't name
 * answered, so an answer from anyone else neither lets the action through nor ends it.
 */
export const CARDS_PER_ACTION = 5;

/** Why an action is refused once its cards are spent with no answer the hook takes. */
export const ASKED_TOO_OFTEN =
  "It was answered too many times by people who may not approve it, so it was not done.";

export const makeActionGuard =
  ({ hook, store, runtimes }: ActionGuardDeps): ActionGuard =>
  (threadId, question, card) =>
    Effect.gen(function* () {
      if (hook === undefined || !(yield* hook.enabled)) return false;
      const unavailable = new ActionRefused({
        message: refusalText(question.action, DECISION_UNAVAILABLE),
      });
      const thread = yield* store.getThread(threadId).pipe(Effect.mapError(() => unavailable));
      const first = yield* hook.decide({ ...question, thread });
      if (first.decision === "allow") return true;
      if (first.decision === "refuse") {
        return yield* new ActionRefused({ message: refusalText(question.action, first.reason) });
      }
      const shown = yield* card;
      let asking = first;
      for (let round = 0; round < CARDS_PER_ACTION; round++) {
        const answer = yield* runtimes
          .requestApproval(
            threadId,
            {
              toolName: shown.toolName,
              displayName: shown.displayName,
              input: { ...shown.input },
              description: asking.title ?? shown.description,
              ...(asking.reason === undefined || asking.reason.trim() === ""
                ? {}
                : { decisionReason: asking.reason }),
              suggestions: [],
              scopes: ["once"],
            },
            {
              decisionId: asking.id,
              ...(asking.assignees === undefined ? {} : { assignees: asking.assignees }),
              ...(asking.title === undefined ? {} : { title: asking.title }),
            },
          )
          .pipe(Effect.mapError(() => unavailable));
        const notApproved = new ActionRefused({
          message: `Not approved (${question.action})${answer.message === undefined ? "." : `: ${answer.message}`}`,
        });
        if (answer.decision !== "allow" && answer.answeredBy === undefined)
          return yield* notApproved;
        const second = yield* hook.decide({
          ...question,
          thread,
          approval: {
            decisionId: asking.id,
            askId: answer.resolution?.requestId ?? "",
            ...(answer.answeredBy === undefined ? {} : { answeredBy: answer.answeredBy }),
          },
        });
        if (second.decision === "ask") {
          asking = second;
          continue;
        }
        if (answer.decision !== "allow") return yield* notApproved;
        if (second.decision !== "allow") {
          return yield* new ActionRefused({
            message: refusalText(
              question.action,
              second.reason ?? "The approval was not accepted.",
            ),
          });
        }
        return true;
      }
      return yield* new ActionRefused({ message: refusalText(question.action, ASKED_TOO_OFTEN) });
    });

/** The guard over the server's own hook, store and runtimes, for the handlers that act for a person. */
export const actionGuard: Effect.Effect<ActionGuard, never, ThreadStore | ThreadRuntimes> =
  Effect.gen(function* () {
    return makeActionGuard({
      hook: Option.getOrUndefined(yield* Effect.serviceOption(DecisionHook)),
      store: yield* ThreadStore,
      runtimes: yield* ThreadRuntimes,
    });
  });
