import {
  RELEASE_MIN_AGE_DAYS,
  reviewRequestHolds,
  reviewRequestReady,
  reviewRequestsOn,
  type ReleasePublishedCondition,
  type Project,
  type RoutineTriggerState,
  type ThreadId,
  type Workspace,
  type RoutineEvent,
  type RoutineTrigger,
} from "@gram/contracts";
import { ghApi, Proc, Tools } from "@gram/git";
import { forThreadIf } from "../embedding/gh-thread.ts";
import { githubRelayed } from "../embedding/github-relay.ts";
import { projectRepo } from "../git/repo-reach.ts";
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
  /**
   * The project's GitHub repo, by the origin it was added with (`Project.originIdentity`), never
   * the one its git config names now; absent when it has none.
   */
  readonly projectRepo?: string | undefined;
  /** What the last look left to compare against (a release routine's last version). */
  readonly baseline: string | undefined;
  /**
   * The repos of the workspace's projects, by their recorded origins: behind a GitHub route
   * (`githubRelayed`), the only ones a routine's look reads by name (`triggerRepo`).
   */
  readonly workspaceRepos?: ReadonlyArray<string> | undefined;
  /** The thread the look reads GitHub for: its workspace's orchestrator, absent while it has none. */
  readonly reader?: ThreadId | undefined;
}

/**
 * The look context of `routine` in `workspace`: its project's folder and repo (none once the
 * project is no longer one of the workspace's), and the workspace's projects' repos.
 */
export const lookContextOf = (
  workspace: Pick<Workspace, "projectIds" | "homeProjectId" | "orchestratorThreadId">,
  routine: {
    readonly project?: string | undefined;
    readonly trigger?: RoutineTriggerState | undefined;
  },
  all: ReadonlyArray<Project>,
): EventLookContext => {
  const projects = all.filter((each) => workspace.projectIds.includes(each.id));
  const id = routine.project ?? workspace.homeProjectId;
  const project = projects.find((each) => each.id === id);
  return {
    projectRoot: project?.root,
    projectRepo: project === undefined ? undefined : projectRepo(project),
    baseline: routine.trigger?.baseline,
    workspaceRepos: projects.flatMap((each) => projectRepo(each) ?? []),
    reader: workspace.orchestratorThreadId,
  };
};

/**
 * Why a routine's look reads nothing on GitHub (behind a route, `relayed`): it names a repository
 * none of its workspace's projects recorded as its origin.
 */
export const outsideWorkspace = (
  on: RoutineTrigger,
  context: Pick<EventLookContext, "workspaceRepos">,
  relayed: boolean,
): string | undefined => {
  const named = triggerRepo(on);
  if (named === undefined || !relayed) return undefined;
  const reachable = (context.workspaceRepos ?? []).map((repo) => repo.toLowerCase());
  return reachable.includes(named.toLowerCase())
    ? undefined
    : `${named} isn't the repository of a project of this workspace, so Gram doesn't read it here.`;
};

/** The GitHub repository a routine's event reads by name, if it names one. */
export const triggerRepo = (on: RoutineTrigger | undefined): string | undefined =>
  on === undefined
    ? undefined
    : on.event === "reviewRequested"
      ? on.repo
      : on.event === "releasePublished" && on.source === "github"
        ? on.name
        : undefined;

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
      return Duration.minutes(5);
    case "prReady":
    case "ciFailed":
      return Duration.minutes(10);
    case "releasePublished":
      return Duration.hours(1);
  }
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
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

    const api = (cwd: string, resource: "core" | "graphql", args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit(resource, "background")).allowed) return undefined;
        return yield* ghApi(cwd, args).pipe(
          provide,
          asBackground,
          Effect.orElseSucceed(() => undefined),
        );
      });

    const repoOf = (projectRoot: string | undefined, repo: string | undefined) =>
      Effect.gen(function* () {
        if (projectRoot === undefined) {
          return { problem: "Its project is no longer one of the workspace's." } as const;
        }
        if (!(yield* tools.ghReady)) {
          return { problem: "GitHub's gh isn't installed or signed in on this computer." } as const;
        }
        if (repo === undefined) {
          return { problem: "Its project has no GitHub origin to watch." } as const;
        }
        return { repo } as const;
      });

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
        const outside = outsideWorkspace(on, context, githubRelayed());
        if (outside !== undefined) return { problem: outside };
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
            const found = yield* repoOf(context.projectRoot, context.projectRepo);
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
            const found = yield* repoOf(context.projectRoot, context.projectRepo);
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
      }).pipe(forThreadIf(context.reader));

    return RoutineEventSources.of({ look });
  }),
);
