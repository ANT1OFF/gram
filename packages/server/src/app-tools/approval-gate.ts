import { AppToolError, type AppToolDescriptor, type ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ApprovalReach } from "../runtime/answer-reach.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { AskedDespiteAutonomy } from "./definition.ts";

/**
 * Raises the approval card; fails closed on rejection or runtime cancellation. `reach` is who may
 * approve it (`ApprovalReach`), which every caller names.
 */
export interface ApprovalGate {
  approve(
    threadId: ThreadId,
    descriptor: AppToolDescriptor,
    input: unknown,
    description: string | undefined,
    forced: boolean | undefined,
    claims: ReviewWriteClaims | undefined,
    why: AskedDespiteAutonomy | undefined,
    title: string | undefined,
    reach: ApprovalReach,
  ): Effect.Effect<void, AppToolError>;
}

/** What a review tool checked about its call (`babysit/review-tools.ts`); never read on a forced card. */
export interface ReviewWriteClaims {
  /**
   * The call writes only to the calling worker's own PR, at an autonomy that leaves PR work to the
   * worker's mode (`workerOwnPrFollowsMode`). Honoured for `OWN_PR_REVIEW_TOOLS` alone.
   */
  readonly workerOwnPr?: boolean | undefined;
  /**
   * The call answers a thread a configured review bot started, on the user's open PR that this
   * thread follows in its checkout's repo, from a plain thread or a worker at `publish` or `full`.
   * Honoured for `REVIEW_BOT_THREAD_TOOLS` alone.
   */
  readonly reviewBotThread?: boolean | undefined;
}

/**
 * The review tools that write only to the calling thread's own pull request
 * (`babysit/review-tools.ts`): the one exception to asking a worker on every call.
 */
export const OWN_PR_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  "pr_reply_to_thread",
  "pr_resolve_thread",
  "pr_request_rereview",
]);

/** The review tools that never ask outside Ask mode when they answer the review bot's own thread. */
export const REVIEW_BOT_THREAD_TOOLS: ReadonlySet<string> = new Set([
  "pr_reply_to_thread",
  "pr_resolve_thread",
]);

/** `text` as a card shows it: no hidden reordering or control characters. */
export const plainCardText = (text: string): string =>
  text
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, "")
    .replace(/\p{Cc}+/gu, " ");

/**
 * Cards raised through `ThreadRuntimes`, for every agent's app tools: this gate is the one that
 * asks about them, Claude's included (`forSession`), and it asks every agent alike. A *crossThread*
 * tool allowed for the session isn't asked again while that agent session lives, and a plain thread
 * in `bypassPermissions` isn't asked for a class's card, since the mode promises no prompts.
 *
 * A `forced` card, one a tool asked for about this call (its own `needsApproval` or `alwaysAsks`),
 * is asked in every mode, Bypass included, and for the one call only: the tool has said this call
 * is not one the mode or an earlier answer covers.
 *
 * An orchestrator or a worker is asked in every mode, and for the one call only. Codex under the
 * outward gate has no Auto (`hasAuto`), so such a thread *starts* in `bypassPermissions`, and in any
 * mode Codex's automatic reviewer never sees these cards: skipped there, a spawn over the charter's cap
 * and a message to somebody else's thread would go unasked, and an answer remembered for the
 * session would turn "one worker more" into a standing grant for a thread nobody watches.
 *
 * The one exception is a worker's review write on its own PR (`OWN_PR_REVIEW_TOOLS`) when its
 * workspace's autonomy is `publish` or `full`, which leave pushing and PR work free: none of
 * the above is in a reply on its own PR, so the thread's mode decides, as for a plain thread. It
 * rests on the tool's own check that the PR is the worker's (`workerOwnPr`), not on the role.
 *
 * Answering the review bot (`REVIEW_BOT_THREAD_TOOLS` with `reviewBotThread`) never asks a plain
 * thread or a worker outside `default` (Ask) mode, not for a declined blocker or an unfixed resolve
 * either. Ask mode, which the user picked in order to be asked, keeps the review tools' own rules,
 * babysit's cover included. The tool vouches for
 * the thread, the PR and a worker's autonomy; the gate adds the mode, and never lets an
 * orchestrator or a dream claim it.
 */
export const makeApprovalGate = (
  runtimes: ThreadRuntimesShape,
  store: Pick<ThreadStoreShape, "getThread">,
): ApprovalGate => {
  const allowedForSession = new WeakMap<object, Set<string>>();
  return {
    approve: (
      threadId,
      descriptor,
      input,
      description,
      forced = false,
      claims = {},
      why,
      title,
      reach,
    ) =>
      Effect.gen(function* () {
        const { name } = descriptor;
        const because = why === undefined ? "" : ` It needed the user: ${why.agent}`;
        const thread = yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
        const answersBot =
          !forced &&
          claims.reviewBotThread === true &&
          REVIEW_BOT_THREAD_TOOLS.has(name) &&
          thread !== undefined &&
          thread.role === undefined &&
          thread.mode !== "default";
        if (answersBot) return;
        const ownPr =
          claims.workerOwnPr === true &&
          OWN_PR_REVIEW_TOOLS.has(name) &&
          thread?.role === undefined &&
          thread?.spawnedBy !== undefined;
        const once =
          forced || (!ownPr && (thread?.role !== undefined || thread?.spawnedBy !== undefined));
        if (thread?.mode === "bypassPermissions" && !once) return;
        const remembers = descriptor.class === "crossThread" && !once;
        const session = remembers
          ? yield* runtimes.session(threadId).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const allowed = session === undefined ? undefined : allowedForSession.get(session);
        if (allowed?.has(name) === true) return;
        const answer = yield* runtimes
          .requestApproval(threadId, reach, {
            toolName: `mcp__gram__${name}`,
            displayName: name,
            input: Predicate.isObject(input) ? input : {},
            description: plainCardText(description ?? descriptor.description),
            ...(title === undefined ? {} : { title: plainCardText(title).slice(0, 120) }),
            ...(why === undefined
              ? {}
              : { decisionReason: plainCardText(why.user), autonomyNote: plainCardText(why.tag) }),
            suggestions: [],
            scopes: descriptor.class === "outward" || once ? ["once"] : ["once", "session"],
          })
          .pipe(
            Effect.catchTag("ThreadNotFound", () =>
              Effect.gen(function* () {
                return yield* new AppToolError({
                  tool: name,
                  message: `Gram did not execute ${name}: approval unavailable for thread ${threadId}.${because}`,
                  approvalRequired: true,
                  approvalResolution: {
                    origin: "runtime",
                    reason: "approval-unavailable",
                    threadId,
                    resolvedAt: yield* Clock.currentTimeMillis,
                  },
                });
              }),
            ),
          );
        if (answer.decision !== "allow") {
          const resolution = answer.resolution ?? {
            origin: "unknown" as const,
            reason: "approval-denied",
            threadId,
            resolvedAt: yield* Clock.currentTimeMillis,
            ...(thread === undefined ? {} : { permissionMode: thread.mode }),
          };
          const userRejected = resolution.origin === "user" && resolution.reason === "rejected";
          return yield* new AppToolError({
            tool: name,
            message: userRejected
              ? `The user declined ${name}.${because}`
              : `Gram did not execute ${name}: approval ${resolution.origin === "runtime" ? "cancelled by the runtime" : "denied without decision provenance"} (${resolution.reason}).${resolution.requestId === undefined ? "" : ` Request ${resolution.requestId}.`} Check the thread's current state before retrying.${because}`,
            approvalRequired: true,
            approvalResolution: resolution,
          });
        }
        if (session !== undefined && answer.scope !== "once") {
          allowedForSession.set(session, (allowed ?? new Set()).add(name));
        }
      }),
  };
};
