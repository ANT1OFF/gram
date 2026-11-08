/**
 * What an event routine (`WorkspaceRoutine.on`) watches: one look at a source says which
 * occurrences are there now, each with the key that makes it one. The engine (`routines.ts`) keeps
 * the keys it delivered, so it is the engine, not the source, that tells a new one from an old one.
 * See docs/design/event-routines-sources.md for why these four.
 *
 * Every look goes through the user's own `gh` or npm, as background work held to the background
 * share of the allowance (`github/budget.ts`), or reads a list Gram already polls:
 *
 * - `reviewRequested`: the review-request poll's list (no call of its own), with the user's holds
 *   (await checks, await the review bot) applied, so a PR fires once it is ready to review.
 * - `prReady`: one GraphQL read of the project's repo's open PRs (one point).
 * - `ciFailed`: one REST read of the branch's latest Actions runs.
 * - `releasePublished`: the package's releases, read at most every six hours and kept.
 *
 * What a look carries from GitHub or a registry (titles, logins, workflow names, tags) is data: the
 * brief fences it as untrusted (`routineEventBlock`).
 */
import {
  RELEASE_MIN_AGE_DAYS,
  reviewRequestHolds,
  reviewRequestReady,
  reviewRequestsOn,
  type ReleasePublishedCondition,
  type RoutineEvent,
  type RoutineTrigger,
} from "@gram/contracts";
import { ghApi, originOwnerRepo, Proc, Tools } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { compareVersions } from "../agent-runtime/policy.ts";
import { DAY_MS } from "../zone-time.ts";
import { asBackground, GhBudget } from "../github/budget.ts";
import { ReviewRequestsPoller } from "../github/review-requests.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { BranchHeads } from "../wakes/branch-heads.ts";
import {
  RELEASE_BACKOFF_MAX_MS,
  RELEASE_READ_EVERY_MS,
  releaseDue,
} from "../wakes/condition-sources.ts";
import { type UpstreamRelease, UpstreamReleases } from "../wakes/upstream-releases.ts";

/** What a look is given beside the trigger. */
export interface EventLookContext {
  /** The routine's project folder, for a source that reads its repo; absent when it has none. */
  readonly projectRoot: string | undefined;
  /** What the last look left to compare against (a release routine's last version). */
  readonly baseline: string | undefined;
}

/**
 * What one look found: the occurrences there now (and the baseline to keep), why it can't look
 * (said to the user), or `undefined` when it couldn't tell this time (offline, out of allowance,
 * not polled yet), which changes nothing.
 */
export type EventLook =
  | {
      readonly items: ReadonlyArray<RoutineEvent>;
      readonly baseline?: string | undefined;
      /**
       * What was looked at, when the trigger doesn't say it alone: a PR or CI routine's resolved
       * repository (and branch). The engine seeds afresh when it differs from the seeded one.
       */
      readonly target?: string | undefined;
    }
  | { readonly problem: string }
  | undefined;

export interface RoutineEventSourcesShape {
  readonly look: (on: RoutineTrigger, context: EventLookContext) => Effect.Effect<EventLook>;
}

export class RoutineEventSources extends Context.Service<
  RoutineEventSources,
  RoutineEventSourcesShape
>()("@gram/server/RoutineEventSources") {}

/** How often a routine on `on` looks. */
export const pollEveryOf = (on: RoutineTrigger): Duration.Duration => {
  switch (on.event) {
    case "reviewRequested":
      // The review-request poll's own pace: a look reads its list.
      return Duration.minutes(5);
    case "prReady":
    case "ciFailed":
      return Duration.minutes(10);
    case "releasePublished":
      // Reads are kept six hours; looks over them see a release cross its age within the hour.
      return Duration.hours(1);
  }
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** An event, its outside text clipped to what the state keeps. */
const eventOf = (event: {
  readonly key: string;
  readonly at: number;
  readonly ref: string;
  readonly title?: string | undefined;
  readonly by?: string | undefined;
  readonly url?: string | undefined;
  readonly detail?: string | undefined;
}): RoutineEvent => ({
  key: clip(event.key, 300),
  at: event.at,
  ref: clip(event.ref, 300),
  ...(event.title === undefined || event.title === "" ? {} : { title: clip(event.title, 300) }),
  ...(event.by === undefined || event.by === "" ? {} : { by: clip(event.by, 100) }),
  ...(event.url === undefined || event.url === "" ? {} : { url: clip(event.url, 500) }),
  ...(event.detail === undefined ? {} : { detail: clip(event.detail, 300) }),
});

// ── prReady ────────────────────────────────────────────────────────────────────────────────────

export const READY_PRS_QUERY =
  "query($o:String!,$n:String!){repository(owner:$o,name:$n){pullRequests(states:OPEN,first:50," +
  "orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url isDraft headRefOid " +
  "author{kind:__typename login}}}}}";

const decodeReadyPrs = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequests: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  number: Schema.Number,
                  title: Schema.String,
                  url: Schema.String,
                  isDraft: Schema.Boolean,
                  headRefOid: Schema.String,
                  author: Schema.NullOr(
                    Schema.Struct({ kind: Schema.String, login: Schema.String }),
                  ),
                }),
              ),
            }),
          }),
        ),
      }),
    }),
  ),
);

/** The PRs ready for review in a GraphQL answer, bots' aside; `null` for no such repo. */
export const readyPrsOf = (
  body: string,
  repo: string,
  now: number,
): ReadonlyArray<RoutineEvent> | null | undefined => {
  const decoded = Option.getOrUndefined(decodeReadyPrs(body));
  if (decoded === undefined) return undefined;
  const repository = decoded.data.repository;
  if (repository === null) return null;
  return repository.pullRequests.nodes
    .filter((pr) => !pr.isDraft && pr.author?.kind !== "Bot")
    .map((pr) =>
      eventOf({
        key: `${repo.toLowerCase()}#${pr.number}`,
        at: now,
        ref: `${repo}#${pr.number}`,
        title: pr.title,
        by: pr.author?.login,
        url: pr.url,
        detail: `head ${pr.headRefOid.slice(0, 7)}`,
      }),
    );
};

// ── ciFailed ───────────────────────────────────────────────────────────────────────────────────

const decodeRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      workflow_runs: Schema.Array(
        Schema.Struct({
          id: Schema.Number,
          name: Schema.NullOr(Schema.String),
          head_sha: Schema.String,
          status: Schema.NullOr(Schema.String),
          conclusion: Schema.NullOr(Schema.String),
          html_url: Schema.String,
          created_at: Schema.String,
          event: Schema.String,
        }),
      ),
    }),
  ),
);

/** A completed run's conclusion that turns the branch red. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
/** Runs of a PR aren't the branch's own, even when the PR's head branch has the same name. */
const NOT_THE_BRANCH = new Set(["pull_request", "pull_request_target"]);

/**
 * The branch's red commit in an Actions runs answer: the newest commit with a completed run,
 * when one of its completed runs failed; none when it is green or nothing completed yet; `null`
 * when the branch has no runs at all (a mistyped branch, or a repository without Actions).
 */
export const ciFailureOf = (
  body: string,
  repo: string,
  branch: string,
  now: number,
): ReadonlyArray<RoutineEvent> | null | undefined => {
  const decoded = Option.getOrUndefined(decodeRuns(body));
  if (decoded === undefined) return undefined;
  if (decoded.workflow_runs.length === 0) return null;
  const runs = decoded.workflow_runs
    .filter((run) => !NOT_THE_BRANCH.has(run.event) && run.status === "completed")
    .toSorted((a, b) => b.created_at.localeCompare(a.created_at));
  const sha = runs[0]?.head_sha;
  if (sha === undefined) return [];
  const ofCommit = runs.filter((run) => run.head_sha === sha);
  const failed = ofCommit.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion));
  if (failed.length === 0) return [];
  return [
    eventOf({
      key: `${repo.toLowerCase()}@${sha}`,
      at: now,
      ref: `${repo}@${sha.slice(0, 7)}`,
      title: [...new Set(failed.map((run) => run.name ?? `run ${run.id}`))].join(", "),
      url: failed[0]!.html_url,
      detail: `${failed.length} of ${ofCommit.length} completed runs failed on ${branch}`,
    }),
  ];
};

// ── releasePublished ───────────────────────────────────────────────────────────────────────────

/** The newest stable release, or `undefined` for none. */
const newestStable = (releases: ReadonlyArray<UpstreamRelease>) =>
  releases
    .filter((release) => !release.prerelease)
    .reduce<UpstreamRelease | undefined>(
      (best, each) =>
        best === undefined || compareVersions(each.version, best.version) > 0 ? each : best,
      undefined,
    );

/**
 * A release routine's look over the package's releases: at the first look (no `baseline`) the
 * newest stable one already `minAgeDays` old is the baseline, so a younger one still fires once it
 * is old enough; after it, the newest stable release past the baseline and at least `minAgeDays`
 * old, once, which becomes the baseline. A burst of releases is one event.
 */
export const releaseLookOf = (
  on: Extract<RoutineTrigger, { readonly event: "releasePublished" }>,
  releases: ReadonlyArray<UpstreamRelease>,
  baseline: string | undefined,
  now: number,
): Exclude<EventLook, undefined | { readonly problem: string }> => {
  const minAgeDays = on.minAgeDays ?? RELEASE_MIN_AGE_DAYS;
  if (baseline === undefined) {
    const old = releases.filter((release) => now - release.publishedAt >= minAgeDays * DAY_MS);
    return { items: [], baseline: newestStable(old)?.version ?? "0.0.0" };
  }
  const spec: ReleasePublishedCondition = {
    kind: "releasePublished",
    source: on.source,
    name: on.name,
    minAgeDays,
  };
  const due = releaseDue(spec, baseline, releases, now);
  if (due === undefined) return { items: [], baseline };
  return {
    items: [
      eventOf({
        key: `${on.source}:${on.name.toLowerCase()}@${due.version}`,
        at: now,
        ref: `${on.name} ${due.version}`,
        url: due.url,
        detail: `published ${new Date(due.publishedAt).toISOString().slice(0, 10)}, after ${baseline}`,
      }),
    ],
    baseline: due.version,
  };
};

// ── the live sources ───────────────────────────────────────────────────────────────────────────

/** GitHub has no such repo or branch, or this login can't see it. */
const NOT_FOUND = /not found|HTTP 404|Could not resolve to a Repository/i;

export const RoutineEventSourcesLive = Layer.effect(
  RoutineEventSources,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const poller = yield* ReviewRequestsPoller;
    const proc = yield* Proc;
    const tools = yield* Tools;
    const budget = yield* GhBudget;
    const heads = yield* BranchHeads;
    const upstream = yield* UpstreamReleases;
    const provide = Effect.provideService(Proc, proc);

    /** One `gh api` call as background work; `undefined` when the allowance or `gh` refused it. */
    const api = (cwd: string, resource: "core" | "graphql", args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit(resource, "background")).allowed) return undefined;
        return yield* ghApi(cwd, args).pipe(
          provide,
          asBackground,
          Effect.orElseSucceed(() => undefined),
        );
      });

    /** The routine's project's GitHub repo, or why there is none to watch. */
    const repoOf = (projectRoot: string | undefined) =>
      Effect.gen(function* () {
        if (projectRoot === undefined) {
          return { problem: "Its project is no longer one of the workspace's." } as const;
        }
        if (!(yield* tools.ghReady)) {
          return { problem: "GitHub's gh isn't installed or signed in on this computer." } as const;
        }
        const repo = yield* provide(originOwnerRepo(projectRoot));
        if (repo === undefined) {
          return { problem: "Its project has no GitHub origin to watch." } as const;
        }
        return { repo } as const;
      });

    /** Per package: the last answer that read, when, and when to ask again. */
    const releaseReads = new Map<
      string,
      {
        readonly list: ReadonlyArray<UpstreamRelease> | null | undefined;
        readonly nextAt: number;
        readonly failures: number;
      }
    >();
    const releasesOf = (source: "npm" | "github", name: string) =>
      Effect.gen(function* () {
        const key = `${source}\u0000${name.toLowerCase()}`;
        const now = yield* Clock.currentTimeMillis;
        const kept = releaseReads.get(key);
        if (kept !== undefined && now < kept.nextAt) return kept.list;
        const list = yield* upstream.list(source, name);
        if (list === undefined) {
          const failures = (kept?.failures ?? 0) + 1;
          const wait = Math.min(RELEASE_READ_EVERY_MS * 2 ** failures, RELEASE_BACKOFF_MAX_MS);
          releaseReads.set(key, { list: kept?.list, nextAt: now + wait, failures });
          return kept?.list;
        }
        releaseReads.set(key, { list, nextAt: now + RELEASE_READ_EVERY_MS, failures: 0 });
        return list;
      });

    const look: RoutineEventSourcesShape["look"] = (on, context) =>
      Effect.gen(function* (): Effect.fn.Return<EventLook> {
        const now = yield* Clock.currentTimeMillis;
        switch (on.event) {
          case "reviewRequested": {
            const settings = yield* store.getSettings;
            if (!reviewRequestsOn(settings)) {
              return {
                problem:
                  "Review requests are off in Settings → Notifications, so none are seen. Turn them on there.",
              };
            }
            const current = yield* poller.current;
            // Not polled yet, signed out, or refused: an empty list then isn't "none".
            if (current.checkedAt === undefined) {
              return (yield* tools.ghReady)
                ? undefined
                : { problem: "GitHub's gh isn't installed or signed in on this computer." };
            }
            const wanted = on.repo?.toLowerCase();
            return {
              items: current.requests
                .filter((request) => wanted === undefined || request.repo.toLowerCase() === wanted)
                .filter((request) =>
                  reviewRequestReady(request, reviewRequestHolds(settings, request.repo)),
                )
                .map((request) =>
                  eventOf({
                    key: `${request.repo.toLowerCase()}#${request.number}`,
                    at: now,
                    ref: `${request.repo}#${request.number}`,
                    title: request.title,
                    by: request.author,
                    url: request.url,
                  }),
                ),
            };
          }
          case "prReady": {
            const found = yield* repoOf(context.projectRoot);
            if (found.repo === undefined) return { problem: found.problem };
            const [owner, name] = found.repo.split("/");
            const out = yield* api(context.projectRoot!, "graphql", [
              "graphql",
              "-f",
              `query=${READY_PRS_QUERY}`,
              "-f",
              `o=${owner}`,
              "-f",
              `n=${name}`,
            ]);
            if (out === undefined) return undefined;
            const prs = readyPrsOf(out.stdout, found.repo, now);
            if (prs === null || (prs === undefined && NOT_FOUND.test(out.stderr))) {
              return { problem: `GitHub has no ${found.repo} that this login can see.` };
            }
            return prs === undefined ? undefined : { items: prs, target: found.repo.toLowerCase() };
          }
          case "ciFailed": {
            const found = yield* repoOf(context.projectRoot);
            if (found.repo === undefined) return { problem: found.problem };
            const cwd = context.projectRoot!;
            const branch = on.branch ?? (yield* heads.defaultBranch(cwd, found.repo));
            if (branch === undefined) return undefined;
            const out = yield* api(cwd, "core", [
              `repos/${found.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30&exclude_pull_requests=true`,
            ]);
            if (out === undefined) return undefined;
            if (out.status !== 0) {
              return NOT_FOUND.test(out.stderr)
                ? { problem: `GitHub has no ${found.repo} that this login can see.` }
                : undefined;
            }
            const items = ciFailureOf(out.stdout, found.repo, branch, now);
            if (items === null) {
              return {
                problem: `${found.repo} has no CI runs on ${branch}. Check the branch's name.`,
              };
            }
            return items === undefined
              ? undefined
              : { items, target: `${found.repo.toLowerCase()}@${branch}` };
          }
          case "releasePublished": {
            const list = yield* releasesOf(on.source, on.name);
            if (list === undefined) return undefined;
            if (list === null) {
              return {
                problem: `${on.source === "npm" ? "npm" : "GitHub"} has no ${on.name}.`,
              };
            }
            return releaseLookOf(on, list, context.baseline, now);
          }
        }
      });

    return RoutineEventSources.of({ look });
  }),
);
