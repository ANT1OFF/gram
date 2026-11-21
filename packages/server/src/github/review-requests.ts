import {
  reviewBotsOf,
  reviewRequestHolds,
  reviewRequestReady,
  reviewRequestsAwaitBot,
  reviewRequestsAwaitChecks,
  reviewRequestsDirectOnly,
  reviewRequestsHideBots,
  reviewRequestsMaxAgeDays,
  reviewRequestsOn,
  type OwnPr,
  type OwnPrs,
  type ReviewBot,
  type ReviewRequest,
  type ReviewRequests,
  type Settings,
} from "@gram/contracts";
import {
  detectRateLimit,
  fetchReviewRequestDetails,
  originOwnerRepo,
  Proc,
  reviewRequestKey,
  searchOwnPrs,
  searchReviewRequests,
  Tools,
  updatedSinceDate,
  type RateLimitSignal,
  type ReviewRequestDetails,
  type ReviewRequestsError,
  type ReviewRequestsSearch,
  type SearchedReviewRequest,
} from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { EventHub } from "../events/event-hub.ts";
import { AppActivity } from "../git/activity.ts";
import { GitServerConfig } from "../git/platform.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { asBackground } from "./budget.ts";
import { makePollBackoff, quotaMultiplier } from "./poll-backoff.ts";
import { GhQuota, windowHeadroom } from "./quota.ts";

const REVIEW_REQUESTS_INTERVAL = Duration.minutes(5);
const REVIEW_REQUESTS_THROTTLE = Duration.seconds(60);

/** What the poll reads from GitHub and git, behind a service so tests never reach `gh`. */
export class GhReviewRequests extends Context.Service<
  GhReviewRequests,
  {
    /** `gh` is installed and signed in. */
    readonly ready: Effect.Effect<boolean>;
    readonly search: (
      options: ReviewRequestsSearch,
    ) => Effect.Effect<ReadonlyArray<SearchedReviewRequest>, ReviewRequestsError>;
    /** The user's own open PRs, drafts included. */
    readonly searchOwn: Effect.Effect<ReadonlyArray<SearchedReviewRequest>, ReviewRequestsError>;
    /** Checks and review state by `reviewRequestKey`; a PR GitHub didn't answer for is missing. */
    readonly details: (
      prs: ReadonlyArray<SearchedReviewRequest>,
      bots: ReadonlyArray<ReviewBot>,
    ) => Effect.Effect<ReadonlyMap<string, ReviewRequestDetails>>;
    /** A project folder's origin as `owner/name`. */
    readonly originOf: (root: string) => Effect.Effect<string | undefined>;
  }
>()("@gram/server/GhReviewRequests") {
  static readonly layer = Layer.effect(
    GhReviewRequests,
    Effect.gen(function* () {
      const tools = yield* Tools;
      const proc = yield* Proc;
      return {
        ready: tools.ghReady,
        search: (options) => searchReviewRequests(options).pipe(Effect.provideService(Proc, proc)),
        searchOwn: searchOwnPrs.pipe(Effect.provideService(Proc, proc)),
        details: (prs, bots) =>
          fetchReviewRequestDetails(prs, bots).pipe(Effect.provideService(Proc, proc)),
        originOf: (root) => originOwnerRepo(root).pipe(Effect.provideService(Proc, proc)),
      };
    }),
  );
}

export class ReviewRequestsPoller extends Context.Service<
  ReviewRequestsPoller,
  {
    readonly current: Effect.Effect<ReviewRequests>;
    /** The user's own open PRs, found by the same poll. */
    readonly own: Effect.Effect<OwnPrs>;
    /** Each known project folder's origin, `owner/name`, as the poll last read it. */
    readonly projectOrigins: Effect.Effect<ReadonlyMap<string, string>>;
    /**
     * Polls now unless one ran within `REVIEW_REQUESTS_THROTTLE`; `force` skips the throttle, for a
     * changed setting. Does nothing while git sweeps are off.
     */
    readonly refresh: (options?: { readonly force?: boolean }) => Effect.Effect<void>;
    /** Polls now. */
    readonly poll: Effect.Effect<void>;
  }
>()("@gram/server/ReviewRequestsPoller") {}

const keyOf = reviewRequestKey;

const information = (details: ReviewRequestDetails | undefined) => ({
  ...(details?.labelsCount === undefined ? {} : { labelsCount: details.labelsCount }),
  ...(details?.labels === undefined ? {} : { labels: details.labels }),
  ...(details?.additions === undefined ? {} : { additions: details.additions }),
  ...(details?.deletions === undefined ? {} : { deletions: details.deletions }),
  ...(details?.updatedAt === undefined ? {} : { informationAt: details.updatedAt }),
  ...(details?.stale === true ? { informationStale: true, detailsStale: true } : {}),
});

const listed = (
  searched: SearchedReviewRequest,
  details: ReviewRequestDetails | undefined,
  projectRoot: string | undefined,
): ReviewRequest => {
  const { headOid: _headOid, ...request } = listedOwn(searched, details, projectRoot);
  return { ...request, author: searched.author };
};

const listedOwn = (
  searched: SearchedReviewRequest,
  details: ReviewRequestDetails | undefined,
  projectRoot: string | undefined,
): OwnPr => {
  const { repo, number, title, url, createdAt } = searched;
  const read =
    details?.updatedAt !== undefined && details.updatedAt.localeCompare(searched.updatedAt) >= 0
      ? { updatedAt: details.updatedAt, isDraft: details.isDraft ?? searched.isDraft }
      : { updatedAt: searched.updatedAt, isDraft: searched.isDraft };
  return {
    repo,
    number,
    title,
    url,
    ...read,
    author: searched.author,
    isBot: searched.isBot,
    ...information(details),
    ...(details?.updatedAt === undefined ? {} : { detailsAt: details.updatedAt }),
    ...(details?.headOid === undefined ? {} : { headOid: details.headOid }),
    ...(createdAt === "" ? {} : { createdAt }),
    ...(details?.headRef === undefined ? {} : { headRef: details.headRef }),
    ...(details?.mergeState === undefined ? {} : { mergeState: details.mergeState }),
    ...(details === undefined ? {} : { checks: details.checks }),
    ...(details?.reviewDecision === undefined ? {} : { reviewDecision: details.reviewDecision }),
    ...(details?.bot === undefined ? {} : { bot: details.bot }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
};

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);

const carried = (
  found: ReadonlyArray<SearchedReviewRequest>,
  fresh: ReadonlyMap<string, ReviewRequestDetails>,
  last: ReadonlyMap<string, ReviewRequestDetails>,
): ReadonlyMap<string, ReviewRequestDetails> =>
  new Map(
    found.flatMap((pr) => {
      const key = keyOf(pr);
      const held = last.get(key);
      const details = fresh.get(key) ?? (held === undefined ? undefined : { ...held, stale: true });
      return details === undefined ? [] : [[key, details] as const];
    }),
  );

type RequestsSearch =
  | { readonly kind: "off" }
  | { readonly kind: "signedOut" }
  | { readonly kind: "failed" }
  | { readonly kind: "found"; readonly found: ReadonlyArray<SearchedReviewRequest> };

/**
 * Polls `gh search prs` for the user's review requests every `interval`, and on `refresh` at most once per
 * `throttle`. The same poll searches for the user's own open PRs, so the Open PRs list costs one
 * search more per poll and no loop of its own, and both lists' details share the same documents.
 * Open PRs never notify, and are listed whether or not review requests are on. The first successful poll only seeds the list; later ones notify once per PR that
 * wasn't in the previous result, or, with a hold set (`reviewRequestReady`), once it is ready. A
 * held PR is listed all the while, and one that is held when the list is seeded still notifies
 * when it becomes ready, since that is news the seed never gave. Without `gh` or signed out, nothing
 * runs and nothing is shown; with the setting off, only the own-PR search runs. Nothing polls while
 * git sweeps are off (`sweepInterval` undefined, as in tests).
 */
export const makeReviewRequestsPoller = (
  options: { readonly interval?: Duration.Duration; readonly throttle?: Duration.Duration } = {},
) =>
  Layer.effect(
    ReviewRequestsPoller,
    Effect.gen(function* () {
      const source = yield* GhReviewRequests;
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const gitConfig = yield* GitServerConfig;
      const quota = yield* Effect.serviceOption(GhQuota);
      const activity = yield* Effect.serviceOption(AppActivity);
      const interval = options.interval ?? REVIEW_REQUESTS_INTERVAL;
      const throttle = Duration.toMillis(options.throttle ?? REVIEW_REQUESTS_THROTTLE);
      const lock = yield* Semaphore.make(1);
      const origins = new Map<string, string | undefined>();
      const backoff = yield* makePollBackoff("reviewRequests", interval);

      let state: ReviewRequests = { requests: [] };
      let own: OwnPrs = { prs: [] };
      let notified: ReadonlySet<string> | undefined;
      let lastPollAt: number | undefined;
      let lastFilters: string | undefined;
      let lastHolds: string | undefined;
      let held: ReadonlySet<string> = new Set();
      let quiet: ReadonlySet<string> = new Set();
      let refusals = 0;
      let lastSignal: RateLimitSignal | undefined;
      let lastDetails: ReadonlyMap<string, ReviewRequestDetails> = new Map();
      let lastOwnDetails: ReadonlyMap<string, ReviewRequestDetails> = new Map();

      const projectsByRepo = Effect.gen(function* () {
        const byRepo = new Map<string, string>();
        for (const project of yield* store.listProjects) {
          if (origins.get(project.root) === undefined) {
            origins.set(project.root, yield* source.originOf(project.root));
          }
          const origin = origins.get(project.root);
          if (origin !== undefined && !byRepo.has(origin.toLowerCase())) {
            byRepo.set(origin.toLowerCase(), project.root);
          }
        }
        return byRepo;
      });

      const countRefusal = (error: ReviewRequestsError) =>
        Effect.sync(() => {
          const signal = detectRateLimit(error.message);
          if (signal === undefined) return;
          refusals += 1;
          lastSignal = signal;
        });

      const replace = (next: ReviewRequests) =>
        Effect.gen(function* () {
          const changed = JSON.stringify(next.requests) !== JSON.stringify(state.requests);
          state = next;
          if (changed) yield* hub.publish({ type: "reviewRequests.changed" });
        });

      const replaceOwn = (next: OwnPrs) =>
        Effect.gen(function* () {
          const changed = JSON.stringify(next.prs) !== JSON.stringify(own.prs);
          own = next;
          if (changed) yield* hub.publish({ type: "openPrs.changed" });
        });

      const searchRequests = (settings: Settings, ready: boolean): Effect.Effect<RequestsSearch> =>
        Effect.gen(function* () {
          if (!reviewRequestsOn(settings)) return { kind: "off" };
          const directOnly = reviewRequestsDirectOnly(settings);
          const hideBots = reviewRequestsHideBots(settings);
          const maxAgeDays = reviewRequestsMaxAgeDays(settings);
          const filters = JSON.stringify([directOnly, hideBots, maxAgeDays ?? null]);
          if (lastFilters !== undefined && lastFilters !== filters) notified = undefined;
          lastFilters = filters;
          if (!ready) return { kind: "signedOut" };
          const updatedSince =
            maxAgeDays === undefined
              ? undefined
              : updatedSinceDate(maxAgeDays, yield* Clock.currentTimeMillis);
          const result = yield* source
            .search({ directOnly, updatedSince })
            .pipe(Effect.tapError(countRefusal), Effect.option);
          if (result._tag === "None") return { kind: "failed" };
          return {
            kind: "found",
            found: hideBots ? result.value.filter((r) => !r.isBot) : result.value,
          };
        });

      const settleRequests = (settings: Settings, requests: ReadonlyArray<ReviewRequest>) =>
        Effect.gen(function* () {
          const holdsKey = JSON.stringify([
            reviewRequestsAwaitChecks(settings),
            reviewRequestsAwaitBot(settings),
            settings.notifications.reviewBotRepos ?? null,
          ]);
          const ready = (r: ReviewRequest) =>
            reviewRequestReady(r, reviewRequestHolds(settings, r.repo));
          const holdsChanged = lastHolds !== undefined && lastHolds !== holdsKey;
          lastHolds = holdsKey;
          const rearmed = new Set(
            holdsChanged ? requests.filter((r) => quiet.has(keyOf(r)) && !ready(r)).map(keyOf) : [],
          );
          const before =
            notified === undefined
              ? undefined
              : new Set([...notified].filter((key) => !rearmed.has(key)));
          const due = requests.filter((r) => before?.has(keyOf(r)) !== true && ready(r));
          const released = holdsChanged ? held : undefined;
          const added =
            before === undefined ? [] : due.filter((r) => released?.has(keyOf(r)) !== true);
          notified = new Set(
            [...requests.filter((r) => before?.has(keyOf(r)) === true), ...due].map(keyOf),
          );
          const settled = notified;
          held = new Set(requests.map(keyOf).filter((key) => !settled.has(key)));
          quiet = new Set(
            requests
              .map(keyOf)
              .filter(
                (key) =>
                  settled.has(key) &&
                  (released?.has(key) === true || (quiet.has(key) && !rearmed.has(key))),
              ),
          );
          yield* replace({ requests, checkedAt: yield* Clock.currentTimeMillis });
          for (const request of added) {
            yield* hub.publish({
              type: "notify",
              kind: "needsInput",
              title: `Review requested: ${request.repo}#${request.number} ${request.title}`,
              ...(request.author === "" ? {} : { body: `From ${request.author}` }),
            });
          }
        });

      const poll = lock.withPermits(1)(
        Effect.gen(function* () {
          lastPollAt = yield* Clock.currentTimeMillis;
          const settings = yield* store.getSettings;
          const ready = yield* source.ready;
          const searched = yield* searchRequests(settings, ready);
          const mine = ready
            ? yield* source.searchOwn.pipe(Effect.tapError(countRefusal), Effect.option)
            : undefined;
          const found = searched.kind === "found" ? searched.found : [];
          const owned = mine?._tag === "Some" ? mine.value : [];
          const both = [...found, ...owned];
          const bots = reviewBotsOf(settings);
          const fresh: ReadonlyMap<string, ReviewRequestDetails> =
            both.length === 0 ? new Map() : yield* source.details(both, bots);
          const byRepo = both.length === 0 ? new Map<string, string>() : yield* projectsByRepo;
          const projectOf = (pr: SearchedReviewRequest) => byRepo.get(pr.repo.toLowerCase());

          switch (searched.kind) {
            case "off":
              notified = undefined;
              lastFilters = undefined;
              yield* replace({ requests: [] });
              break;
            case "signedOut":
              yield* replace({ requests: [] });
              break;
            case "failed":
              break;
            case "found": {
              lastDetails = carried(found, fresh, lastDetails);
              const requests = found
                .map((r) => listed(r, lastDetails.get(keyOf(r)), projectOf(r)))
                .toSorted(newestFirst);
              yield* settleRequests(settings, requests);
            }
          }

          if (mine === undefined) yield* replaceOwn({ prs: [] });
          else if (mine._tag === "Some") {
            lastOwnDetails = carried(owned, fresh, lastOwnDetails);
            const prs = owned
              .map((pr) => listedOwn(pr, lastOwnDetails.get(keyOf(pr)), projectOf(pr)))
              .toSorted(newestFirst);
            yield* replaceOwn({ prs, checkedAt: yield* Clock.currentTimeMillis });
          }
        }),
      );

      const refresh = ({ force = false }: { readonly force?: boolean } = {}) =>
        Effect.gen(function* () {
          if (gitConfig.sweepInterval === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          const throttled = lastPollAt !== undefined && now - lastPollAt < throttle;
          if (throttled && !force) return;
          if (!force && (yield* backoff.consecutive) > 0) return;
          yield* force ? poll : asBackground(poll);
        });

      let counted = 0;

      const nextDelay = Effect.gen(function* () {
        if (refusals > counted) {
          counted = refusals;
          return yield* backoff.limited(lastSignal);
        }
        const snapshot = Option.isNone(quota) ? undefined : yield* quota.value.current();
        const level = Option.isNone(activity) ? "active" : yield* activity.value.level;
        const thin = quotaMultiplier(windowHeadroom(snapshot?.search));
        return yield* backoff.recovered(thin * (level === "active" ? 1 : 2));
      });

      if (gitConfig.sweepInterval !== undefined) {
        yield* Effect.gen(function* () {
          if (Option.isSome(activity)) yield* activity.value.awaitActive;
          yield* poll;
          yield* Effect.sleep(yield* nextDelay);
        }).pipe(asBackground, Effect.forever, Effect.forkScoped);
      }

      return {
        current: Effect.sync(() => state),
        own: Effect.sync(() => own),
        projectOrigins: Effect.sync(
          () =>
            new Map(
              [...origins].flatMap(([root, origin]) =>
                origin === undefined ? [] : [[root, origin] as const],
              ),
            ),
        ),
        refresh,
        poll,
      };
    }),
  );

export const ReviewRequestsLive = makeReviewRequestsPoller().pipe(
  Layer.provide(GhReviewRequests.layer),
);
