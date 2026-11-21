import { reconcileOpenPrs, reviewRequestsDirectOnly, reviewRequestsOn } from "@gram/contracts";
import { readableOnly } from "../embedding/readable-by.ts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GitStatePublisher, type GitStatePublisherShape } from "../git/publisher.ts";
import { inReachOnly } from "../git/reach-filter.ts";
import { refuseOutOfReach } from "../git/repo-reach.ts";
import { ReviewRequestsPoller } from "../github/review-requests.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { defineAppTool } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

/**
 * `list_review_requests`: the pull requests waiting on the user's review, as the sidebar's Review
 * requests list holds them. It reads the poll's cached result, and `refresh` asks the poll to run
 * under its own throttle, so a call never adds a GitHub search of its own. Nothing here writes: a
 * review on someone else's PR is the user's to post, so an agent offers a chip at most.
 */
export const listReviewRequestsTool = (
  poller: Pick<ReviewRequestsPoller["Service"], "current" | "refresh">,
  store: ThreadStore["Service"],
  proc: Proc["Service"],
) =>
  defineAppTool({
    descriptor: {
      name: "list_review_requests",
      class: "read",
      description:
        "List the open pull requests that ask for the user's review, from Gram's cached Review requests list: repo, number, title, author, URL, when it was updated, its checks, review decision, the review bot's verdict, and projectRoot when a known project can check it out. repo keeps one owner/name. refresh asks for a new poll, which is throttled, so the list may not change at once. Read only: never approve, request changes or comment on these PRs as the user. To help with one, read its diff and offer a spawn_task chip such as \"Pre-review #123\", or hand the user a draft with send_file.",
    },
    input: Schema.Struct({
      /** `owner/name`; every repository when absent. */
      repo: Schema.optionalKey(Schema.String),
      refresh: Schema.optionalKey(Schema.Boolean),
    }),
    handle: (threadId, { repo, refresh }) =>
      Effect.gen(function* () {
        // A repository named is checked first, so a refused one asks for no poll either.
        yield* refuseOutOfReach("list_review_requests", store, threadId, { repos: [repo] });
        if (refresh === true) yield* poller.refresh();
        const settings = yield* store.getSettings;
        const { checkedAt, ...current } = yield* poller.current;
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        const requests = yield* inReachOnly(
          store,
          Option.getOrUndefined(thread),
          current.requests,
          (request) => request.repo,
        );
        const wanted = repo?.toLowerCase();
        return {
          // Off in Settings → Notifications, nothing is polled and the list is always empty.
          enabled: reviewRequestsOn(settings),
          directOnly: reviewRequestsDirectOnly(settings),
          ...(checkedAt === undefined ? {} : { checkedAt: new Date(checkedAt).toISOString() }),
          requests:
            wanted === undefined
              ? requests
              : requests.filter((request) => request.repo.toLowerCase() === wanted),
        };
      }).pipe(Effect.provideService(Proc, proc)),
  });

/**
 * `list_open_prs`: the sidebar's Open PRs list, reconciled the same way (`reconcileOpenPrs`) from
 * the poll's cached result and the threads' live git states, so it holds what the sidebar does:
 * open PRs bound to a thread but authored by someone else, a PR a newer badge says merged gone,
 * and each with the thread that owns it. Like `list_review_requests` it never searches itself.
 */
export const listOpenPrsTool = (
  poller: Pick<ReviewRequestsPoller["Service"], "own" | "projectOrigins" | "refresh">,
  store: ThreadStore["Service"],
  git: Pick<GitStatePublisherShape, "stateForThread">,
  proc: Proc["Service"],
) =>
  defineAppTool({
    descriptor: {
      name: "list_open_prs",
      class: "read",
      description:
        "List the user's open pull requests, drafts included, as Gram's Open PRs list holds them: the ones they authored, and open PRs bound to one of their threads though someone else authored them. For each: repo, number, title, URL, isDraft, when it was updated, its head branch, merge state (CLEAN, BLOCKED, BEHIND, DIRTY for conflicts…), checks, review decision, the review bot's verdict, and threadId and threadTitle when a Gram thread owns it (bound to it, or on its head branch). repo keeps one owner/name. refresh asks for a new poll, which is throttled, so the list may not change at once. Read only: to act on one, use the PR tools in the thread that owns it, or send_message to that thread.",
    },
    input: Schema.Struct({
      /** `owner/name`; every repository when absent. */
      repo: Schema.optionalKey(Schema.String),
      refresh: Schema.optionalKey(Schema.Boolean),
    }),
    handle: (threadId, { repo, refresh }) =>
      Effect.gen(function* () {
        yield* refuseOutOfReach("list_open_prs", store, threadId, { repos: [repo] });
        if (refresh === true) yield* poller.refresh();
        const { prs, checkedAt } = yield* poller.own;
        const caller = Option.getOrUndefined(yield* store.getThread(threadId).pipe(Effect.option));
        const origins = yield* poller.projectOrigins;
        const roots = new Map((yield* store.listProjects).map((p) => [p.id, p.root]));
        // No thread the caller's reader may not see owns one here (`embedding/readable-by.ts`).
        const threads = yield* readableOnly(yield* store.listThreads, (thread) => thread);
        const titles = new Map(threads.map((thread) => [thread.id, thread.title]));
        const live = yield* Effect.forEach(threads, (thread) =>
          Effect.map(git.stateForThread(thread), (state) => {
            const root = roots.get(thread.projectId);
            return {
              thread,
              git: state,
              origin: root === undefined ? undefined : origins.get(root),
            };
          }),
        );
        const wanted = repo?.toLowerCase();
        return {
          ...(checkedAt === undefined ? {} : { checkedAt: new Date(checkedAt).toISOString() }),
          prs: (yield* inReachOnly(store, caller, reconcileOpenPrs(prs, live), (pr) => pr.repo))
            .filter((pr) => wanted === undefined || pr.repo.toLowerCase() === wanted)
            .map(({ owner, ...pr }) =>
              owner === undefined
                ? pr
                : { ...pr, threadId: owner, threadTitle: titles.get(owner) ?? "" },
            ),
        };
      }).pipe(Effect.provideService(Proc, proc)),
  });

/** Registers `list_review_requests` and `list_open_prs` over the review-request poll. */
export const ReviewRequestAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const poller = yield* ReviewRequestsPoller;
    const store = yield* ThreadStore;
    const proc = yield* Proc;
    yield* registry.register([
      listReviewRequestsTool(poller, store, proc),
      listOpenPrsTool(poller, store, yield* GitStatePublisher, proc),
    ]);
  }),
);
