import { type Project, type Thread, type WorkspaceId, type WorkspaceState } from "@gram/contracts";
import { ghApi, Proc } from "@gram/git";
import { projectRepo } from "../git/repo-reach.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { forThread } from "../embedding/gh-thread.ts";
import { githubRelayed } from "../embedding/github-relay.ts";
import { asBackground, GhBudget } from "../github/budget.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { BranchHeads } from "./branch-heads.ts";

const MAIN_WATCH_INTERVAL = Duration.minutes(5);

const RUNS_READ = 50;

const NAMED_MAX = 8;

const RestRun = Schema.Struct({
  id: Schema.Int,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head_sha: Schema.String,
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type MainRun = typeof RestRun.Type;

const decodeRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(RestRun) })),
);
const decodeCompare = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      commits: Schema.Array(
        Schema.Struct({
          sha: Schema.String,
          commit: Schema.Struct({ message: Schema.String }),
        }),
      ),
    }),
  ),
);
const decodePulls = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ number: Schema.Int }))),
);

const NEUTRAL = new Set(["cancelled", "skipped", "neutral", "stale"]);
const RED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** One commit of the branch as its runs judge it, newest first. */
export interface CommitVerdict {
  readonly sha: string;
  /** `pending` while any of its runs is unfinished and none has failed. */
  readonly verdict: "green" | "red" | "pending";
  /** The runs that failed it, for a red one. */
  readonly failed: ReadonlyArray<{ readonly name: string; readonly url?: string | undefined }>;
}

/**
 * The branch's commits as their runs judge them, newest first by the latest run each has. A commit
 * is red once any run on it failed, pending while one is unfinished, green when the rest passed; a
 * commit whose runs were all cancelled or skipped isn't judged at all.
 */
export const commitVerdicts = (runs: ReadonlyArray<MainRun>): ReadonlyArray<CommitVerdict> => {
  const bySha = new Map<string, { latest: string; runs: Array<MainRun> }>();
  for (const run of runs) {
    const at = run.created_at ?? "";
    const entry = bySha.get(run.head_sha);
    if (entry === undefined) bySha.set(run.head_sha, { latest: at, runs: [run] });
    else {
      entry.runs.push(run);
      if (at > entry.latest) entry.latest = at;
    }
  }
  const judged: Array<CommitVerdict & { readonly latest: string }> = [];
  for (const [sha, { latest, runs: own }] of bySha) {
    const failed = own.filter((run) => RED.has(run.conclusion ?? ""));
    const unfinished = own.some((run) => (run.status ?? "completed") !== "completed");
    const decided = own.filter(
      (run) => (run.status ?? "completed") === "completed" && !NEUTRAL.has(run.conclusion ?? ""),
    );
    const verdict =
      failed.length > 0 ? "red" : unfinished ? "pending" : decided.length > 0 ? "green" : undefined;
    if (verdict === undefined) continue;
    judged.push({
      sha,
      latest,
      verdict,
      failed: failed.map((run) => ({
        name: run.name ?? `run ${run.id}`,
        url: run.html_url ?? undefined,
      })),
    });
  }
  return judged
    .toSorted((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0))
    .map((each) => ({ sha: each.sha, verdict: each.verdict, failed: each.failed }));
};

/** What a look found the branch to be: its newest decided commit, and the green one before it. */
export interface BranchReading {
  readonly newest?: CommitVerdict | undefined;
  /** The newest green commit older than `newest`, for a red one. */
  readonly lastGreen?: string | undefined;
}

export const readBranch = (verdicts: ReadonlyArray<CommitVerdict>): BranchReading => {
  const decided = verdicts.filter((each) => each.verdict !== "pending");
  const newest = decided[0];
  if (newest === undefined || newest.verdict === "green") return { newest };
  return { newest, lastGreen: decided.find((each) => each.verdict === "green")?.sha };
};

/** The pull request a squash or merge commit names: `title (#12)`, or `Merge pull request #12`. */
export const prNumberOfMessage = (message: string): number | undefined => {
  const first = message.split("\n")[0] ?? "";
  const squash = /\(#(\d+)\)\s*$/.exec(first);
  if (squash !== null) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+)\b/.exec(first);
  return merge === null ? undefined : Number(merge[1]);
};

/** A merged pull request a note names, with the thread whose it was when one is known. */
export interface MergedSince {
  readonly number: number;
  readonly worker?: string | undefined;
}

const short = (sha: string) => sha.slice(0, 7);

const quoted = (title: string) => `"${title.replaceAll(/\s+/g, " ").slice(0, 80)}"`;

/** The note an orchestrator gets when a watched branch turns red. */
export const mainRedText = (input: {
  readonly repo: string;
  readonly branch: string;
  readonly red: CommitVerdict;
  readonly lastGreen?: string | undefined;
  /** The pull requests merged since it was green, oldest first; `undefined` when it couldn't be read. */
  readonly merged?: ReadonlyArray<MergedSince> | undefined;
}): string => {
  const failed = input.red.failed.slice(0, NAMED_MAX).map((run) => run.name);
  const moreFailed = input.red.failed.length - failed.length;
  const runs = `${failed.join(", ")}${moreFailed > 0 ? ` and ${moreFailed} more` : ""}`;
  const where = `${input.repo} ${input.branch} is red at ${short(input.red.sha)} (failed: ${runs})`;
  const url = input.red.failed[0]?.url;
  const since =
    input.lastGreen === undefined
      ? "No green commit is among its recent runs, so what broke it can't be narrowed down here."
      : input.merged === undefined || input.merged.length === 0
        ? `It was green at ${short(input.lastGreen)}; the pull requests merged since couldn't be read.`
        : `Merged since it was green at ${short(input.lastGreen)}: ${input.merged
            .slice(0, NAMED_MAX)
            .map(
              (pr) =>
                `${input.repo}#${pr.number}${pr.worker === undefined ? "" : ` (${quoted(pr.worker)})`}`,
            )
            .join(
              ", ",
            )}${input.merged.length > NAMED_MAX ? ` and ${input.merged.length - NAMED_MAX} more` : ""}.`;
  return `${where}.${url === undefined ? "" : ` ${url}`} ${since}`;
};

/** The note an orchestrator gets when a branch it was told is red is green again. */
export const mainGreenText = (input: {
  readonly repo: string;
  readonly branch: string;
  readonly sha: string;
}): string => `${input.repo} ${input.branch} is green again at ${short(input.sha)}.`;

export interface MainWatchShape {
  /** One look at every watched branch; the loop runs it, and tests call it. */
  readonly poll: Effect.Effect<void>;
}

export class MainWatch extends Context.Service<MainWatch, MainWatchShape>()(
  "@gram/server/MainWatch",
) {}

/** The interval a test or an embedder sets; absent is `MAIN_WATCH_INTERVAL`. */
export const MainWatchConfig = Context.Reference<{ readonly interval?: Duration.Duration }>(
  "@gram/server/MainWatchConfig",
  { defaultValue: () => ({}) },
);

/** Whether a workspace watches its repos' default branches. */
export const watchesDefaultBranch = (state: WorkspaceState): boolean =>
  state.charter.watchDefaultBranch === true && state.paused === undefined;

const ownerOf = (threads: ReadonlyArray<Thread>, repo: string, number: number) =>
  threads.find((thread) =>
    [thread.boundPr, ...(thread.extraPrs ?? [])].some(
      (pr) =>
        pr !== undefined && pr.number === number && pr.repo.toLowerCase() === repo.toLowerCase(),
    ),
  );

export const MainWatchLive = Layer.effect(
  MainWatch,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const budget = yield* GhBudget;
    const store = yield* ThreadStore;
    const orchestration = yield* Orchestration;
    const heads = yield* BranchHeads;
    const config = yield* MainWatchConfig;

    const toldRed = new Map<string, string>();
    const branches = new Map<string, string>();

    const api = (cwd: string, path: string) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit("core", "background")).allowed) return undefined;
        const out = yield* ghApi(cwd, [path]).pipe(
          Effect.provideService(Proc, proc),
          asBackground,
          Effect.orElseSucceed(() => undefined),
        );
        return out?.status === 0 ? out.stdout : undefined;
      });

    const mergedBetween = (cwd: string, repo: string, green: string, red: string) =>
      Effect.gen(function* () {
        const body = yield* api(cwd, `repos/${repo}/compare/${green}...${red}`);
        const compared = body === undefined ? Option.none() : decodeCompare(body);
        if (Option.isNone(compared)) return undefined;
        const numbers: Array<number> = [];
        for (const commit of compared.value.commits) {
          let number = prNumberOfMessage(commit.commit.message);
          if (number === undefined) {
            const pulls = yield* api(cwd, `repos/${repo}/commits/${commit.sha}/pulls`);
            const decoded = pulls === undefined ? Option.none() : decodePulls(pulls);
            number = Option.isSome(decoded) ? decoded.value[0]?.number : undefined;
          }
          if (number !== undefined && !numbers.includes(number)) numbers.push(number);
        }
        return numbers;
      });

    const look = (workspaceId: WorkspaceId, project: Project, threads: ReadonlyArray<Thread>) =>
      Effect.gen(function* () {
        const cwd = project.root;
        const repo = projectRepo(project);
        if (repo === undefined) return;
        let branch = branches.get(repo);
        if (branch === undefined) {
          branch = yield* heads.defaultBranch(cwd, repo);
          if (branch === undefined) return;
          branches.set(repo, branch);
        }
        const body = yield* api(
          cwd,
          `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=${RUNS_READ}`,
        );
        const runs = body === undefined ? Option.none() : decodeRuns(body);
        if (Option.isNone(runs)) return;
        const reading = readBranch(commitVerdicts(runs.value.workflow_runs));
        const key = `${workspaceId} ${repo.toLowerCase()}`;
        const newest = reading.newest;
        if (newest === undefined) return;
        if (newest.verdict === "green") {
          if (toldRed.has(key)) {
            toldRed.delete(key);
            yield* orchestration.addNote(
              workspaceId,
              mainGreenText({ repo, branch, sha: newest.sha }),
              `${repo} ${branch} is green again`,
              `main-green:${repo}:${newest.sha}`,
            );
          }
          return;
        }
        if (toldRed.get(key) === newest.sha) return;
        const numbers =
          reading.lastGreen === undefined
            ? undefined
            : yield* mergedBetween(cwd, repo, reading.lastGreen, newest.sha);
        const merged = numbers?.map((number): MergedSince => {
          const owner = ownerOf(threads, repo, number);
          return owner === undefined ? { number } : { number, worker: owner.title };
        });
        toldRed.set(key, newest.sha);
        yield* orchestration.addNote(
          workspaceId,
          mainRedText({ repo, branch, red: newest, lastGreen: reading.lastGreen, merged }),
          `${repo} ${branch} turned red`,
          `main-red:${repo}:${newest.sha}`,
        );
      });

    const poll: Effect.Effect<void> = Effect.gen(function* () {
      const watching = (yield* orchestration.listWorkspaces).filter(watchesDefaultBranch);
      if (watching.length === 0) return;
      const projects = new Map((yield* store.listProjects).map((p) => [p.id, p]));
      const threads = yield* store.listThreads;
      for (const state of watching) {
        const own = threads.filter((thread) => thread.workspaceId === state.workspace.id);
        const orchestrator = state.workspace.orchestratorThreadId;
        if (orchestrator === undefined && githubRelayed()) continue;
        const asOrchestrator = orchestrator === undefined ? Effect.asVoid : forThread(orchestrator);
        for (const projectId of state.workspace.projectIds) {
          const project = projects.get(projectId);
          if (project === undefined) continue;
          yield* asOrchestrator(look(state.workspace.id, project, own)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("default-branch watch couldn't look").pipe(
                Effect.annotateLogs({ project: project.name, cause: Cause.pretty(cause) }),
              ),
            ),
          );
        }
      }
    });

    const base = config.interval ?? MAIN_WATCH_INTERVAL;
    yield* Effect.gen(function* () {
      yield* Effect.sleep(yield* budget.paceBackground("core", base, 1));
      yield* poll;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("default-branch watch failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return MainWatch.of({ poll });
  }),
);
