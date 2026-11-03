/**
 * `ciStuck`: a hosted CI job of a PR or an Actions run sits queued, with no runner, past its
 * minutes; or a run waits for a maintainer to approve it, as a fork's does, so no CI runs at all.
 *
 * GitHub is read through `CiJobs`, gently. A PR's checks come from `Pr.checks`, the one small
 * GraphQL read the PR monitors share: one read made in the last minute is reused, and a read in
 * the cache's few seconds answers every wake on the PR. Only when a PR has no Actions check at all
 * is the REST API asked whether a run awaits approval (one call, and one more for the PR's head
 * when any run does). A run's jobs are one REST call; the run itself is read only once nothing of
 * it is in flight, to tell an approval from a finish. All of it is paced to the background share
 * of the allowance, and an unreachable `gh` is "couldn't tell", never a finding.
 */
import {
  AppToolError,
  CI_STUCK_DEFAULT_MINUTES,
  type CiStuckCondition,
  type WakeConditionSeen,
} from "@gram/contracts";
import { ghApi, Pr, Proc } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asBackground, GhBudget } from "../github/budget.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { folderOf } from "./condition-folders.ts";
import type { ConditionLook, WakeConditionSource } from "./conditions.ts";

/** A job sitting queued: `since` is when GitHub queued it, when it says. */
export interface QueuedJob {
  /** Stable for one attempt of one job: its id, else its name. */
  readonly key: string;
  readonly name: string;
  readonly url: string;
  /** Epoch ms. */
  readonly since?: number | undefined;
}

/** What GitHub says of a PR's or a run's CI now. */
export interface CiState {
  readonly queued: ReadonlyArray<QueuedJob>;
  /** A run that waits for a maintainer's approval before any job runs. */
  readonly approval?: { readonly name: string; readonly url: string } | undefined;
  /** A run only: it completed, with this conclusion. */
  readonly completed?: string | undefined;
}

export interface CiJobsShape {
  /** `undefined` when GitHub couldn't be read (offline, logged out, out of allowance). */
  readonly pr: (cwd: string, repo: string, number: number) => Effect.Effect<CiState | undefined>;
  /** `null` when GitHub has no such run. */
  readonly run: (
    cwd: string,
    repo: string,
    runId: number,
  ) => Effect.Effect<CiState | null | undefined>;
}

export class CiJobs extends Context.Service<CiJobs, CiJobsShape>()("@gram/server/CiJobs") {}

/** How old a PR's checks, read by anyone, may be and still answer a look. */
const PR_CHECKS_REUSE_MS = 60_000;
/** How long one run's read answers for the other wakes on it. */
const RUN_READ_REUSE_MS = 20_000;

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const RestJob = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.String,
  created_at: NullableString,
  started_at: NullableString,
  html_url: NullableString,
});
const RestRun = Schema.Struct({
  id: Schema.Number,
  name: NullableString,
  status: Schema.NullOr(Schema.String),
  conclusion: NullableString,
  html_url: NullableString,
  head_sha: NullableString,
});
const decodeJobs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ jobs: Schema.Array(RestJob) })),
);
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(RestRun));
const decodeRuns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ workflow_runs: Schema.Array(RestRun) })),
);
const decodePull = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) })),
);

/** GitHub has no such run. */
const GONE = /not found|HTTP 404/i;

const msOf = (iso: string | null | undefined): number | undefined => {
  if (iso == null) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

const awaitsApproval = (run: typeof RestRun.Type) =>
  run.status === "action_required" || run.conclusion === "action_required";

export const CiJobsLive = Layer.effect(
  CiJobs,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const budget = yield* GhBudget;
    const prs = yield* Pr;
    const runReads = new Map<
      string,
      { readonly at: number; readonly state: CiState | null | undefined }
    >();

    const api = (cwd: string, path: string) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit("core", "background")).allowed) return undefined;
        return yield* ghApi(cwd, [path]).pipe(
          Effect.provideService(Proc, proc),
          asBackground,
          Effect.orElseSucceed(() => undefined),
        );
      });

    const readRun = (cwd: string, repo: string, runId: number) =>
      Effect.gen(function* () {
        const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
        const out = yield* api(cwd, `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
        if (out === undefined) return undefined;
        if (out.status !== 0) return GONE.test(out.stderr) ? null : undefined;
        const jobs = Option.getOrUndefined(decodeJobs(out.stdout))?.jobs;
        if (jobs === undefined) return undefined;
        const queued = jobs
          .filter((job) => job.status === "queued")
          .map((job): QueuedJob => ({
            key: String(job.id),
            name: job.name,
            url: job.html_url ?? runUrl,
            since: msOf(job.created_at ?? job.started_at),
          }));
        if (jobs.some((job) => job.status !== "completed")) return { queued };
        // Nothing in flight: the run says whether it waits for an approval or is over.
        const view = yield* api(cwd, `repos/${repo}/actions/runs/${runId}`);
        if (view === undefined) return undefined;
        if (view.status !== 0) return GONE.test(view.stderr) ? null : undefined;
        const run = Option.getOrUndefined(decodeRun(view.stdout));
        if (run === undefined) return undefined;
        const name = run.name ?? `run ${runId}`;
        if (awaitsApproval(run)) return { queued, approval: { name, url: run.html_url ?? runUrl } };
        if (run.status === "completed") return { queued, completed: run.conclusion ?? "done" };
        return { queued };
      });

    const run: CiJobsShape["run"] = (cwd, repo, runId) =>
      Effect.gen(function* () {
        const key = `${repo.toLowerCase()}#${runId}`;
        const now = yield* Clock.currentTimeMillis;
        const kept = runReads.get(key);
        if (kept !== undefined && now - kept.at < RUN_READ_REUSE_MS) return kept.state;
        const state = yield* readRun(cwd, repo, runId);
        for (const [k, read] of runReads)
          if (now - read.at >= RUN_READ_REUSE_MS) runReads.delete(k);
        if (state !== undefined) runReads.set(key, { at: now, state });
        return state;
      });

    /** A fork's run waiting for approval has no check on the PR: asked of the REST API instead. */
    const approvalFor = (cwd: string, repo: string, number: number) =>
      Effect.gen(function* () {
        const listed = yield* api(
          cwd,
          `repos/${repo}/actions/runs?status=action_required&per_page=20`,
        );
        if (listed === undefined || listed.status !== 0) return undefined;
        const runs = Option.getOrUndefined(decodeRuns(listed.stdout))?.workflow_runs ?? [];
        if (runs.length === 0) return undefined;
        const pull = yield* api(cwd, `repos/${repo}/pulls/${number}`);
        if (pull === undefined || pull.status !== 0) return undefined;
        const head = Option.getOrUndefined(decodePull(pull.stdout))?.head.sha;
        const waiting = runs.find((r) => r.head_sha === head && awaitsApproval(r));
        if (head === undefined || waiting === undefined) return undefined;
        return {
          name: waiting.name ?? `run ${waiting.id}`,
          url: waiting.html_url ?? `https://github.com/${repo}/actions/runs/${waiting.id}`,
        };
      });

    const pr: CiJobsShape["pr"] = (cwd, repo, number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const seen = yield* prs.seenChecks(repo, number);
        let checks =
          seen !== undefined && now - seen.at < PR_CHECKS_REUSE_MS ? seen.checks : undefined;
        if (checks === undefined) {
          if (!(yield* budget.admit("graphql", "background")).allowed) return undefined;
          const read = yield* prs.checks(cwd, number, repo).pipe(asBackground, Effect.option);
          if (Option.isNone(read)) return undefined;
          checks = read.value;
        }
        const actions = checks.filter((check) => check.runId !== undefined);
        const approval = actions.find(
          (check) => check.conclusion?.toUpperCase() === "ACTION_REQUIRED",
        );
        if (approval !== undefined) {
          return { queued: [], approval: { name: approval.name, url: approval.link } };
        }
        if (actions.length === 0) {
          const waiting = yield* approvalFor(cwd, repo, number);
          return waiting === undefined ? { queued: [] } : { queued: [], approval: waiting };
        }
        const queued = actions
          .filter((check) => check.phase === "queued")
          .map((check): QueuedJob => ({
            key: /\/job\/(\d+)/.exec(check.link)?.[1] ?? check.name,
            name: check.name,
            url: check.link,
            since: msOf(check.startedAt),
          }));
        return { queued };
      });

    return CiJobs.of({ pr, run });
  }),
);

const refuse = (message: string) => new AppToolError({ tool: "schedule_wake", message });

const met = (facts: Readonly<Record<string, string>>): ConditionLook => ({ met: true, facts });

/**
 * One look at `state` for `spec`: met by a run awaiting approval, by a job queued its minutes, or,
 * for a run, by its finishing, which ends the wait too and says so. Not met, the queued jobs GitHub
 * gave no time for keep when this side first saw them, so a restart doesn't restart their count.
 */
export const judgeCiStuck = (
  spec: CiStuckCondition,
  state: CiState | null,
  seen: WakeConditionSeen | undefined,
  now: number,
): ConditionLook => {
  const base: Record<string, string> = {
    repo: spec.repo,
    ...(spec.pr === undefined ? {} : { pr: String(spec.pr) }),
    ...(spec.runId === undefined ? {} : { run: String(spec.runId) }),
  };
  if (state === null) return met({ ...base, outcome: "the run is gone" });
  if (state.approval !== undefined) {
    return met({
      ...base,
      job: state.approval.name,
      state: "awaits approval",
      url: state.approval.url,
    });
  }
  const minutes = spec.queuedMinutes ?? CI_STUCK_DEFAULT_MINUTES;
  const firstSeen: Record<string, string> = {};
  let oldest: { readonly job: QueuedJob; readonly since: number } | undefined;
  for (const job of state.queued) {
    const kept = seen?.[job.key] === undefined ? Number.NaN : Number(seen[job.key]);
    const since = job.since ?? (Number.isFinite(kept) ? kept : now);
    if (job.since === undefined) firstSeen[job.key] = String(since);
    if (oldest === undefined || since < oldest.since) oldest = { job, since };
  }
  if (oldest !== undefined && now - oldest.since >= minutes * 60_000) {
    const others = state.queued.length - 1;
    return met({
      ...base,
      job: oldest.job.name,
      queued: `${Math.floor((now - oldest.since) / 60_000)} min, no runner`,
      url: oldest.job.url,
      ...(others > 0 ? { alsoQueued: String(others) } : {}),
    });
  }
  if (state.completed !== undefined) {
    return met({ ...base, outcome: `the run completed (${state.completed}) with no job stuck` });
  }
  return { met: false, seen: firstSeen };
};

/** A met look's facts, as a refusal says them. */
const factsText = (facts: Readonly<Record<string, string>>) =>
  Object.entries(facts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

export const ciStuckSource = Effect.gen(function* () {
  const jobs = yield* CiJobs;
  const store = yield* ThreadStore;

  const read = (cwd: string, spec: CiStuckCondition) =>
    spec.runId !== undefined
      ? jobs.run(cwd, spec.repo, spec.runId)
      : spec.pr !== undefined
        ? jobs.pr(cwd, spec.repo, spec.pr)
        : Effect.succeed(undefined);

  const source: WakeConditionSource<"ciStuck"> = {
    kind: "ciStuck",
    pollEvery: Duration.minutes(2),
    debounce: Duration.minutes(1),
    arm: (caller, spec) =>
      Effect.gen(function* () {
        if (spec.pr !== undefined && spec.runId !== undefined) {
          return yield* refuse("Give one of `pr` and `runId`, not both.");
        }
        if (![spec.pr ?? 1, spec.runId ?? 1].every((n) => Number.isSafeInteger(n) && n > 0)) {
          return yield* refuse("`pr` and `runId` are whole numbers above 0.");
        }
        const minutes = spec.queuedMinutes ?? CI_STUCK_DEFAULT_MINUTES;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
          return yield* refuse("`queuedMinutes` is a whole number from 1 to 1440.");
        }
        const bound = caller.boundPr;
        const pr =
          spec.pr ??
          (spec.runId === undefined && bound?.repo.toLowerCase() === spec.repo.toLowerCase()
            ? bound.number
            : undefined);
        if (pr === undefined && spec.runId === undefined) {
          return yield* refuse(
            `Name the \`pr\` or the \`runId\`: you have no PR bound in ${spec.repo}.`,
          );
        }
        const filled: CiStuckCondition = {
          ...spec,
          queuedMinutes: minutes,
          ...(pr === undefined ? {} : { pr }),
        };
        const state = yield* read(yield* folderOf(caller), filled);
        if (state === null) return yield* refuse(`${spec.repo} has no run ${spec.runId}.`);
        // Unreadable now: the first look that reads it is the baseline.
        if (state === undefined) return { spec: filled };
        const look = judgeCiStuck(filled, state, undefined, yield* Clock.currentTimeMillis);
        if (look.met) return yield* refuse(`That is so already: ${factsText(look.facts)}.`);
        return { spec: filled, ...(look.seen === undefined ? {} : { seen: look.seen }) };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const waiter = yield* store.getThread(wake.threadId).pipe(Effect.option);
        if (Option.isNone(waiter)) return undefined;
        const state = yield* read(yield* folderOf(waiter.value), wake.spec);
        if (state === undefined) return undefined;
        return judgeCiStuck(wake.spec, state, wake.seen, yield* Clock.currentTimeMillis);
      }),
  };
  return source;
});
