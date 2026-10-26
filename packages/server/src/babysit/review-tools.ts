import {
  AppToolError,
  reviewBotsOf,
  samePr,
  type AppToolDescriptor,
  type PrReview,
  type ReviewBot,
  type ReviewThread,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { isBotLogin, originOwnerRepo, Proc, repoFromPrUrl } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  defineAppTool,
  failed,
  OWN_PR_AUDIENCE,
  refuseOrchestratorPr,
} from "../app-tools/definition.ts";
import {
  AppToolRegistry,
  makeApprovalGate,
  type ReviewWriteClaims,
} from "../app-tools/registry.ts";
import { GitRefresh } from "../git/platform.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { PrReviews } from "../git/review.ts";
import { workerOwnPrFollowsMode } from "../orchestration/rules.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { isBlockerSeverity, pickBot } from "./rules.ts";
import { Babysit, type PrTarget } from "./service.ts";
import { makeKeyedLock } from "../git/keyed-lock.ts";

const COMMENT_LIMIT = 2000;

const reviewThread = (tool: string, review: PrReview, id: string) => {
  const thread = review.threads.find((t) => t.id === id);
  return thread === undefined
    ? Effect.fail(new AppToolError({ tool, message: `unknown review thread ${id}` }))
    : Effect.succeed(thread);
};

const trimmed = (body: string) =>
  body.length > COMMENT_LIMIT ? `${body.slice(0, COMMENT_LIMIT)}…` : body;

const threadView = (thread: ReviewThread) => ({
  id: thread.id,
  path: thread.path,
  ...(thread.line === undefined ? {} : { line: thread.line }),
  severity: thread.severity,
  byBot: thread.byBot,
  isResolved: thread.isResolved,
  isOutdated: thread.isOutdated,
  comments: thread.comments.map((comment) => ({
    id: comment.id,
    author: comment.author,
    body: trimmed(comment.body),
  })),
});

/** Whether a configured review bot wrote the thread's first comment, as `ReviewThread.byBot` reads it. */
const startedByReviewBot = (bots: ReadonlyArray<ReviewBot>, target: ReviewThread) => {
  const first = target.comments[0];
  return first !== undefined && isBotLogin(bots, first.author);
};

const sameRepo = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

const isWorker = (thread: Thread) => thread.role === undefined && thread.spawnedBy !== undefined;

/** An orchestrator, a worker or a dream: the threads the gate asks on every call (`makeApprovalGate`). */
const isMarked = (thread: Thread) => thread.role !== undefined || thread.spawnedBy !== undefined;

/**
 * Babysit mode covers writes on the user's own open PR while it's watching. `auto` mode counts the
 * same: the agent could post the same comment with `gh` there, unasked and without the fix
 * bookkeeping these tools keep. Only a plain thread is covered, and a worker where `workerOwnPr`
 * holds: an orchestrator skipping the card here would never reach the gate that asks it every call.
 */
const covered = (thread: Thread, review: PrReview, workerOwnPr: boolean) =>
  (!isMarked(thread) || workerOwnPr) &&
  (thread.babysit?.phase === "watching" || thread.mode === "auto") &&
  review.pr?.viewerDidAuthor === true &&
  review.pr.state === "OPEN";

/**
 * The card for a reply or resolve: what it does and why this call asks. `undefined`, leaving the
 * tool's description, for a call the bot-thread claim spares a card.
 */
const cardText = (
  action: string,
  found: PrTarget,
  target: ReviewThread,
  refusal: string | undefined,
) => {
  const why =
    refusal ?? (found.thread.mode === "default" ? "this thread is in Ask mode" : undefined);
  const where = `${target.path}${target.line === undefined ? "" : `:${target.line}`}`;
  return why === undefined
    ? undefined
    : `${action} on ${where} of ${found.bound.repo}#${found.bound.number}. Asked because ${why}.`;
};

/**
 * The review-bot app tools. Reads run freely. A reply to or resolve of a thread
 * a configured review bot started, on the user's open PR in this checkout's repo, never asks
 * outside `default` (Ask) mode unless a worker at `supervised` autonomy makes it
 * (`botThreadRefusal`); in Ask mode the rules below decide, babysit included. Every other write raises an outward card on every call, except the calls babysit or `auto` mode covers;
 * declining a blocker still asks there. `bypassPermissions` never asks. A worker follows the same
 * rules on its own PR when its workspace's autonomy is `publish` or `full`, and is asked on every
 * call otherwise, as an orchestrator always is.
 */
export const ReviewAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const reviews = yield* PrReviews;
    const babysit = yield* Babysit;
    const refreshes = yield* GitRefresh;
    const publisher = yield* GitStatePublisher;
    const proc = yield* Proc;
    const gate = makeApprovalGate(runtimes, store);
    /**
     * One `pr_request_rereview` at a time per thread, from the claim to the post. Without it a
     * claiming call that fails could roll back over a carded call that posted meanwhile, and the
     * head would get another uncarded request.
     */
    const rereviewLocks = makeKeyedLock<ThreadId>();

    /** Records `head` as requested, on the thread so a restart keeps it; `false` if it already was. */
    const claimRereview = (threadId: ThreadId, head: string) =>
      Effect.gen(function* () {
        let claim: { readonly previous: string | undefined } | undefined;
        yield* runtimes
          .updateThread(threadId, (t) => {
            if (t.rereviewRequestedOn === head) return t;
            claim = { previous: t.rereviewRequestedOn };
            return { ...t, rereviewRequestedOn: head };
          })
          .pipe(Effect.ignore);
        return claim;
      });

    const releaseRereview = (threadId: ThreadId, head: string, previous: string | undefined) =>
      runtimes
        .updateThread(threadId, (t) => {
          if (t.rereviewRequestedOn !== head) return t;
          const { rereviewRequestedOn: _, ...rest } = t;
          return previous === undefined ? rest : { ...rest, rereviewRequestedOn: previous };
        })
        .pipe(Effect.ignore);

    const load = (tool: string, threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.mapError(failed(tool)));
        yield* refuseOrchestratorPr(tool, thread);
        const found = yield* babysit.target(threadId).pipe(Effect.mapError(failed(tool)));
        if (found === undefined) {
          return yield* new AppToolError({
            tool,
            message: "No pull request found for this branch; bind one with pr_bind.",
          });
        }
        const bots = reviewBotsOf(yield* store.getSettings);
        const review = yield* reviews
          .fetch(found.cwd, found.bound.repo, found.bound.number, bots)
          .pipe(Effect.mapError(failed(tool)));
        if (!review.available) {
          return yield* new AppToolError({ tool, message: "gh is missing or logged out." });
        }
        return { ...found, bots, review };
      });

    /** Whether a worker's workspace leaves its PR work to its mode (`workerOwnPrFollowsMode`). */
    const followsMode = (thread: Thread) =>
      Effect.gen(function* () {
        const state =
          thread.workspaceId === undefined
            ? undefined
            : yield* store
                .getWorkspace(thread.workspaceId)
                .pipe(Effect.orElseSucceed(() => undefined));
        return workerOwnPrFollowsMode({
          thread,
          workspace: state?.workspace,
          charter: state?.charter,
        });
      });

    /**
     * Whether a worker's write here is on its own PR at an autonomy that frees PR work
     * (`workerOwnPrFollowsMode`). `pr_bind` lets a thread bind any PR, so the bound one counts only
     * when it is the PR its own branch opened, in the same repo, and the user's and open; a doubt
     * is a card. `false` for any thread that isn't a worker.
     */
    const workerOwnPr = (found: PrTarget, review: PrReview) =>
      Effect.gen(function* () {
        const { thread, bound, badge } = found;
        if (!isWorker(thread)) return false;
        const own =
          badge?.number === bound.number &&
          sameRepo(repoFromPrUrl(badge.url), bound.repo) &&
          review.pr?.number === bound.number &&
          review.pr.viewerDidAuthor === true &&
          review.pr.state === "OPEN";
        return own && (yield* followsMode(thread));
      }).pipe(Effect.catchCause(() => Effect.succeed(false)));

    /**
     * Why a reply to or resolve of `target` isn't answering the review bot, or `undefined` when it
     * is. Agents answer the bot many times a PR, and a card on each was noise that stalled
     * unattended workers, so answering the bot never asks outside Ask mode, which the gate checks
     * (decided 2026-09-25). `pr_bind` takes any PR, so the PR must be the thread's main one (its
     * bound PR, else its branch's), in its checkout's repo, the user's and open; `reviewThread` has already held the thread to it.
     * Unlike `workerOwnPr`, the branch needn't have opened it: a worker may open a follow-up PR
     * from a second worktree and bind it. A worker at `supervised` is refused, as is an
     * orchestrator or a dream, which are asked on every call. A doubt is a refusal.
     */
    const botThreadRefusal = (
      found: PrTarget,
      review: PrReview,
      bots: ReadonlyArray<ReviewBot>,
      target: ReviewThread,
    ) =>
      Effect.gen(function* () {
        const { thread, bound, badge, cwd } = found;
        if (thread.role !== undefined) return "orchestrators and dreams are asked on every call";
        if (!startedByReviewBot(bots, target)) return "a person started this review thread";
        const followed =
          (thread.boundPr !== undefined && samePr(thread.boundPr, bound)) || badge !== undefined;
        const origin = yield* originOwnerRepo(cwd).pipe(Effect.provideService(Proc, proc));
        const inCheckoutRepo =
          sameRepo(origin, bound.repo) ||
          (badge !== undefined && sameRepo(repoFromPrUrl(badge.url), bound.repo));
        const pr = review.pr;
        const usersOpenPr =
          pr?.number === bound.number &&
          sameRepo(repoFromPrUrl(pr.url), bound.repo) &&
          pr.viewerDidAuthor === true &&
          pr.state === "OPEN";
        if (!(followed && inCheckoutRepo && usersOpenPr)) {
          return "the pull request isn't the user's open PR in this checkout's repo";
        }
        if (isWorker(thread) && !(yield* followsMode(thread))) {
          return "this worker's workspace autonomy isn't publish or full";
        }
        return undefined;
      }).pipe(Effect.catchCause(() => Effect.succeed("Gram couldn't check this call")));

    const card = (
      threadId: ThreadId,
      descriptor: AppToolDescriptor,
      input: unknown,
      claims: ReviewWriteClaims,
      description?: string,
    ) =>
      gate.approve(
        threadId,
        { ...descriptor, class: "outward" },
        input,
        description,
        false,
        claims,
      );

    const prReviewState = defineAppTool({
      descriptor: {
        name: "pr_review_state",
        class: "read",
        description:
          "The review bot's state on a thread's pull request: verdict on head, unresolved finding counts, whether a round is running, merge state, and babysit progress. This thread's unless threadId names another.",
      },
      input: Schema.Struct({
        refresh: Schema.optionalKey(Schema.Boolean),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, { refresh = false, threadId = caller }) =>
        Effect.gen(function* () {
          const { thread, cwd, review } = yield* load("pr_review_state", threadId as ThreadId);
          if (refresh) yield* refreshes.request(cwd, true);
          if (review.pr !== undefined) yield* publisher.reconcile(thread, review.pr);
          return {
            ...(review.pr === undefined ? {} : { pr: review.pr }),
            ...(review.state === undefined ? {} : { review: review.state }),
            ...(review.latestReview === undefined ? {} : { latestReview: review.latestReview }),
            ...(thread.babysit === undefined ? {} : { babysit: thread.babysit }),
          };
        }),
    });

    const prReviewThreads = defineAppTool({
      descriptor: {
        name: "pr_review_threads",
        class: "read",
        description:
          "Review threads on this thread's pull request with their severity, file and comments. Unresolved only unless includeResolved.",
      },
      input: Schema.Struct({ includeResolved: Schema.optionalKey(Schema.Boolean) }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, { includeResolved = false }) =>
        load("pr_review_threads", threadId).pipe(
          Effect.map(({ review }) => ({
            threads: review.threads.filter((t) => includeResolved || !t.isResolved).map(threadView),
          })),
        ),
    });

    const replyDescriptor: AppToolDescriptor = {
      name: "pr_reply_to_thread",
      class: "outwardGated",
      description:
        "Reply on a review thread of this thread's pull request. After pushing a fix, reply \"Fixed in <sha>: …\"; in babysit mode that resolves the thread. On a thread the review bot started, on the user's open PR in this checkout's repo, it never asks outside Ask mode, unless you are a worker at supervised autonomy. On a person's thread, and in Ask mode, it asks unless the mode is bypass, or babysit or auto on the user's open PR, where a reply that declines a blocker still asks; a worker is asked there unless the PR is its branch's own and its autonomy is publish or full.",
    };
    const prReplyToThread = defineAppTool({
      descriptor: replyDescriptor,
      audience: OWN_PR_AUDIENCE,
      input: Schema.Struct({ reviewThreadId: Schema.NonEmptyString, body: Schema.NonEmptyString }),
      handle: (threadId, input) =>
        Effect.gen(function* () {
          const tool = replyDescriptor.name;
          const found = yield* load(tool, threadId);
          const { thread, cwd, bots, review } = found;
          const target = yield* reviewThread(tool, review, input.reviewThreadId);
          const fix = yield* babysit.pushedFix(cwd, input.body, review.pr?.headRefOid);
          const declinesBlocker = isBlockerSeverity(target.severity) && fix === undefined;
          const ownPr = yield* workerOwnPr(found, review);
          const refusal = yield* botThreadRefusal(found, review, bots, target);
          if (!covered(thread, review, ownPr) || declinesBlocker) {
            yield* card(
              threadId,
              replyDescriptor,
              input,
              { workerOwnPr: ownPr, reviewBotThread: refusal === undefined },
              cardText("Reply to the review thread", found, target, refusal),
            );
          }
          const comment = yield* reviews
            .reply(cwd, target.id, input.body)
            .pipe(Effect.mapError(failed(tool)));
          const { resolved } = yield* babysit.recordReply(threadId, target.id, fix);
          yield* refreshes.request(cwd, true);
          return { comment: { id: comment.id, url: comment.url }, resolved };
        }),
    });

    const resolveDescriptor: AppToolDescriptor = {
      name: "pr_resolve_thread",
      class: "outwardGated",
      description:
        "Resolve a review thread on this thread's pull request. On a thread the review bot started, on the user's open PR in this checkout's repo, it never asks outside Ask mode, unless you are a worker at supervised autonomy. On a person's thread, and in Ask mode, it asks unless the mode is bypass, or babysit or auto on the user's open PR and a reply on the thread cites a pushed fix; a worker is asked there unless the PR is its branch's own and its autonomy is publish or full.",
    };
    const prResolveThread = defineAppTool({
      descriptor: resolveDescriptor,
      audience: OWN_PR_AUDIENCE,
      input: Schema.Struct({ reviewThreadId: Schema.NonEmptyString }),
      handle: (threadId, input) =>
        Effect.gen(function* () {
          const tool = resolveDescriptor.name;
          const found = yield* load(tool, threadId);
          const { thread, cwd, bots, review } = found;
          const target = yield* reviewThread(tool, review, input.reviewThreadId);
          let fix: string | undefined;
          for (const comment of target.comments) {
            if (fix !== undefined) break;
            fix = yield* babysit.pushedFix(cwd, comment.body, review.pr?.headRefOid);
          }
          const ownPr = yield* workerOwnPr(found, review);
          const refusal = yield* botThreadRefusal(found, review, bots, target);
          if (!covered(thread, review, ownPr) || fix === undefined) {
            yield* card(
              threadId,
              resolveDescriptor,
              input,
              { workerOwnPr: ownPr, reviewBotThread: refusal === undefined },
              cardText("Resolve the review thread", found, target, refusal),
            );
          }
          yield* reviews.resolve(cwd, target.id).pipe(Effect.mapError(failed(tool)));
          if (fix !== undefined) yield* babysit.recordResolved(threadId, target.id);
          yield* refreshes.request(cwd, true);
          return { resolved: true };
        }),
    });

    const rereviewDescriptor: AppToolDescriptor = {
      name: "pr_request_rereview",
      class: "outwardGated",
      description:
        "Ask the review bot to review this thread's pull request again by posting its re-review command. The user approves it unless babysit or auto mode is on and the head has no verdict yet; bypass mode never asks. A worker is asked on every call, except on its own PR when its workspace's autonomy is publish or full, where these rules apply.",
    };
    const prRequestRereview = defineAppTool({
      descriptor: rereviewDescriptor,
      audience: OWN_PR_AUDIENCE,
      input: Schema.Struct({ note: Schema.optionalKey(Schema.String) }),
      handle: (threadId, { note }) =>
        Effect.gen(function* () {
          const tool = rereviewDescriptor.name;
          const found = yield* load(tool, threadId);
          const { thread, cwd, bound, bots, review } = found;
          const bot = pickBot(bots, review.state?.bots ?? []);
          if (bot === undefined) {
            return yield* new AppToolError({
              tool,
              message: "No review bot is configured (settings.reviewBots).",
            });
          }
          const head = review.pr?.headRefOid;
          const quiet =
            head !== undefined &&
            review.state?.verdictOnHead === undefined &&
            review.state?.roundInFlight !== true &&
            thread.babysit?.rereviewRequestedOn !== head;
          const ownPr = yield* workerOwnPr(found, review);
          const extra = note?.trim() ?? "";
          const body = extra === "" ? bot.rereviewCommand : `${bot.rereviewCommand}\n\n${extra}`;
          // The head is recorded before the post, so a crash between the two costs a card rather
          // than allowing a second uncarded request. Only a covered, quiet call may skip the card
          // on the strength of it; every other call asks and records the head all the same.
          //
          // The claim is an acquire, which can't be interrupted, so its release is in place by the
          // time anything can stop the call. It runs on every exit but success, an interrupted HTTP
          // MCP request included: a request that never went out mustn't cost the head its uncarded
          // one.
          yield* Effect.acquireUseRelease(
            head === undefined ? Effect.succeed(undefined) : claimRereview(threadId, head),
            (claim) =>
              Effect.gen(function* () {
                if (!(covered(thread, review, ownPr) && quiet && claim !== undefined)) {
                  yield* card(threadId, rereviewDescriptor, { note }, { workerOwnPr: ownPr });
                }
                yield* reviews
                  .comment(cwd, bound.repo, bound.number, body)
                  .pipe(Effect.mapError(failed(tool)));
              }),
            (claim, exit) =>
              Exit.isSuccess(exit) || claim === undefined || head === undefined
                ? Effect.void
                : releaseRereview(threadId, head, claim.previous),
          ).pipe((effect) => rereviewLocks.withLock(threadId, effect));
          if (head !== undefined) yield* babysit.recordRereview(threadId, head);
          yield* refreshes.request(cwd, true, { expectChange: true });
          return { command: bot.rereviewCommand };
        }),
    });

    const prReviewMonitor = defineAppTool({
      descriptor: {
        name: "pr_review_monitor",
        class: "self",
        description:
          "Watch the review bot and reviewers on this thread's pull request. After each bot round, verdict or merge-state change, Gram sends one review update into this thread with the open findings and failing checks, and when a person approves or requests changes, a separate update with their review: mid-turn while you work where the agent supports it, otherwise once you're idle, a newer one replacing any still waiting. Binds the branch's PR if none is bound.",
      },
      input: Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
      audience: OWN_PR_AUDIENCE,
      handle: (threadId, { enabled = true }) =>
        babysit.setReviewMonitor(threadId, enabled).pipe(
          Effect.map((bound) => ({
            reviewMonitor: enabled,
            ...(bound === undefined ? {} : { bound }),
          })),
          Effect.mapError(failed("pr_review_monitor")),
        ),
    });

    yield* registry.register([
      prReviewState,
      prReviewThreads,
      prReplyToThread,
      prResolveThread,
      prRequestRereview,
      prReviewMonitor,
    ]);
  }),
);
