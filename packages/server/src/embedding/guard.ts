// The decision hook around an action the server itself takes for a thread: an app tool that
// spawns or merges, the app's own push and pull request calls. `allow` lets the action go on to
// whatever Gram would have asked anyway, `refuse` stops it with the reason, and `ask` puts a card
// on the thread and, once a person approves it, asks the hook again before anything happens.

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

export type ActionGuard = (
  threadId: ThreadId,
  question: Pick<DecisionQuestion, "action" | "initiator" | "detail">,
  /** Built only when the hook answers `ask`: with the hook off, nothing of it runs. */
  card: Effect.Effect<ActionCard>,
) => Effect.Effect<void, ActionRefused>;

export interface ActionGuardDeps {
  /** `undefined` where no hook is configured: the guard then lets everything through unasked. */
  readonly hook: DecisionHookShape | undefined;
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly runtimes: Pick<ThreadRuntimesShape, "requestApproval">;
}

export const makeActionGuard =
  ({ hook, store, runtimes }: ActionGuardDeps): ActionGuard =>
  (threadId, question, card) =>
    Effect.gen(function* () {
      if (hook === undefined || !(yield* hook.enabled)) return;
      const unavailable = new ActionRefused({
        message: refusalText(question.action, DECISION_UNAVAILABLE),
      });
      const thread = yield* store.getThread(threadId).pipe(Effect.mapError(() => unavailable));
      const first = yield* hook.decide({ ...question, thread });
      if (first.decision === "allow") return;
      if (first.decision === "refuse") {
        return yield* new ActionRefused({ message: refusalText(question.action, first.reason) });
      }
      const shown = yield* card;
      const answer = yield* runtimes
        .requestApproval(threadId, {
          toolName: shown.toolName,
          displayName: shown.displayName,
          input: { ...shown.input },
          description: first.title ?? shown.description,
          ...(first.reason === undefined || first.reason.trim() === ""
            ? {}
            : { decisionReason: first.reason }),
          suggestions: [],
          scopes: ["once"],
        })
        .pipe(Effect.mapError(() => unavailable));
      if (answer.decision !== "allow") {
        return yield* new ActionRefused({
          message: `Not approved (${question.action})${answer.message === undefined ? "." : `: ${answer.message}`}`,
        });
      }
      const second = yield* hook.decide({
        ...question,
        thread,
        approval: {
          decisionId: first.id,
          askId: answer.resolution?.requestId ?? "",
          // The card was answered in another call than this one: its person, not this call's.
          ...(answer.answeredBy === undefined ? {} : { answeredBy: answer.answeredBy }),
        },
      });
      if (second.decision !== "allow") {
        return yield* new ActionRefused({
          message: refusalText(question.action, second.reason ?? "The approval was not accepted."),
        });
      }
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
