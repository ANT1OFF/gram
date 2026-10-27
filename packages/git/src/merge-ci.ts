// Launch-only evidence beyond registered check contexts. Read the policy from the PR's base
// commit: a feature branch cannot erase its own merge conditions. No local file or cached badge
// is authority, and Actions jobs are read from the selected run attempt, not another head/run.
import type { ChecksRollup, PrStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ghApi, git } from "./exec.ts";
import { CI_LANES, ciDiffArgs, ciLanes, DOCUMENTATION_POLICY } from "./ci-policy.ts";

const Names = Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100));
const Policy = Schema.Struct({
  documentationPolicy: Schema.optionalKey(Schema.Literal(DOCUMENTATION_POLICY)),
  workflows: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isPattern(/^\.github\/workflows\/[\w.-]+\.ya?ml$/)),
      event: Schema.Literals(["pull_request", "push"]),
      jobs: Schema.Array(Schema.NonEmptyString).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(100),
      ),
      docsJobs: Schema.optionalKey(
        Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
      ),
      // Each lane's jobs (see ci-policy.ts): a lane the diff can't affect needs none of them.
      laneJobs: Schema.optionalKey(
        Schema.Struct({
          static: Schema.optionalKey(Names),
          tests: Schema.optionalKey(Names),
          package: Schema.optionalKey(Names),
          e2e: Schema.optionalKey(Names),
        }),
      ),
      // Jobs a passing local check doesn't stand in for: verified on the exact head even then.
      alwaysJobs: Schema.optionalKey(
        Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100)),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
const POLICY_QUERY =
  "query($o:String!,$n:String!,$ref:String!){repository(owner:$o,name:$n){object(expression:$ref){__typename ... on Blob{text}}}}";
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid GitHub CI response");
  return value as Record<string, unknown>;
};
const list = (body: Record<string, unknown>, key: string) => {
  const nodes = body[key];
  // Bounded request: a truncated connection must never qualify a merge.
  if (!Array.isArray(nodes) || body["total_count"] !== nodes.length || nodes.length > 100)
    throw new Error("Incomplete GitHub CI response");
  return nodes.map(record);
};
const json = (text: string) => record(JSON.parse(text));
const jobIdentityMatches = (
  job: Record<string, unknown>,
  run: Record<string, unknown>,
  head: string,
) =>
  job["head_sha"] === head &&
  job["run_id"] === run["id"] &&
  job["run_attempt"] === run["run_attempt"];
const SOURCE_STEP =
  /^docs-source \[base=([a-f0-9]{40}) head=([a-f0-9]{40}) merge=([a-f0-9]{40})\]$/;

type ExactBadge = PrStatus & { baseRefOid: string; headRefOid: string; headRef: string };
const exact = (badge: PrStatus): badge is ExactBadge =>
  !!badge.baseRefOid &&
  !!badge.headRefOid &&
  /^[a-f0-9]{40}$/.test(badge.baseRefOid) &&
  /^[a-f0-9]{40}$/.test(badge.headRefOid) &&
  !!badge.headRef &&
  Number.isSafeInteger(badge.number) &&
  badge.number > 0;

/** The base commit's declaration, or `undefined` when it has none. */
const readPolicy = (cwd: string, repo: string, baseRefOid: string) =>
  Effect.gen(function* () {
    const slash = repo.indexOf("/");
    const policyOut = yield* ghApi(cwd, [
      "graphql",
      "-f",
      `query=${POLICY_QUERY}`,
      "-f",
      `o=${repo.slice(0, slash)}`,
      "-f",
      `n=${repo.slice(slash + 1)}`,
      "-f",
      `ref=${baseRefOid}:.gram/merge-ci.json`,
    ]);
    if (policyOut.status !== 0 || policyOut.truncated)
      throw new Error("Merge CI policy lookup failed");
    const policyBody = json(policyOut.stdout);
    if (policyBody["errors"] !== undefined) throw new Error("Merge CI policy lookup failed");
    const object = record(record(policyBody["data"])["repository"])["object"];
    // Only a real null from GitHub means no declaration. Errors/malformed/missing data refuse.
    return object === null
      ? undefined
      : Schema.decodeUnknownSync(Policy)(JSON.parse(String(record(object)["text"])));
  });

/** The latest run of each workflow and event on exactly `head` of `branch`. */
const latestRuns = (cwd: string, repo: string, head: string, branch: string) =>
  Effect.gen(function* () {
    const runsOut = yield* ghApi(cwd, [
      `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`,
    ]);
    if (runsOut.status !== 0 || runsOut.truncated)
      throw new Error("Merge CI workflow lookup failed");
    const runs = list(json(runsOut.stdout), "workflow_runs").filter(
      (run) =>
        run["head_sha"] === head &&
        run["head_branch"] === branch &&
        (run["event"] === "push" || run["event"] === "pull_request"),
    );
    // Keep the latest execution of each workflow/event. A rerun updates this same run's attempt;
    // an old green run cannot hide a newer queued/red execution on the identical commit.
    const latest = new Map<string, Record<string, unknown>>();
    for (const run of runs) {
      if (
        typeof run["path"] !== "string" ||
        !Number.isSafeInteger(run["id"]) ||
        !Number.isSafeInteger(run["run_attempt"])
      )
        throw new Error("Invalid GitHub workflow identity");
      const key = `${run["path"]}|${run["event"]}`;
      const old = latest.get(key);
      if (old === undefined || Number(run["id"]) > Number(old["id"])) latest.set(key, run);
    }
    return latest;
  });

/** The jobs of `run`'s own attempt. */
const runJobs = (cwd: string, repo: string, run: Record<string, unknown>) =>
  Effect.gen(function* () {
    const jobsOut = yield* ghApi(cwd, [
      `repos/${repo}/actions/runs/${run["id"]}/attempts/${run["run_attempt"]}/jobs?per_page=100`,
    ]);
    if (jobsOut.status !== 0 || jobsOut.truncated) throw new Error("Merge CI jobs lookup failed");
    return list(json(jobsOut.stdout), "jobs");
  });

export const verifyMergeCi = (cwd: string, repo: string, badge: PrStatus) =>
  Effect.gen(function* () {
    if (!exact(badge)) throw new Error("Merge CI needs the exact base, head and branch");
    const policy = yield* readPolicy(cwd, repo, badge.baseRefOid);
    if (policy === undefined && badge.requiredChecks !== undefined) return "passing" as const;
    // Independently reproduce the classification. A workflow's skipped checks or reported output
    // is never authority. Missing local commit objects/output limits conservatively require full.
    const lanes =
      policy?.documentationPolicy === DOCUMENTATION_POLICY
        ? yield* git(cwd, ciDiffArgs(badge.baseRefOid, badge.headRefOid)).pipe(
            Effect.map((out) =>
              out.status === 0 && !out.truncated ? ciLanes(out.stdout) : new Set(CI_LANES),
            ),
            Effect.catchDefect(() => Effect.succeed(new Set(CI_LANES))),
            Effect.orElseSucceed(() => new Set(CI_LANES)),
          )
        : new Set(CI_LANES);
    const docs = lanes === "docs";
    const latest = yield* latestRuns(cwd, repo, badge.headRefOid, badge.headRef);
    const required =
      policy?.workflows ??
      [...latest.values()].map((run) => ({
        path: String(run["path"]),
        event: String(run["event"]),
        jobs: [] as string[],
      }));
    let result: ChecksRollup = required.length === 0 ? "none" : "passing";
    let usedDocs = false;
    for (const workflow of required) {
      const run = latest.get(`${workflow.path}|${workflow.event}`);
      if (run === undefined || run["status"] !== "completed") {
        result = "pending";
        continue;
      }
      if (run["conclusion"] !== "success") return "failing" as const;
      if (workflow.jobs.length === 0) continue;
      const jobs = yield* runJobs(cwd, repo, run);
      // Full application qualification is sufficient even when the classifier conservatively
      // fell back to full for prose (e.g. missing objects). Validate its identities below as usual.
      const fullSucceeded = workflow.jobs.every((name) => {
        const matches = jobs.filter((job) => job["name"] === name);
        return (
          matches.length > 0 &&
          matches.every((job) => job["status"] === "completed" && job["conclusion"] === "success")
        );
      });
      // A lane the diff can't affect, by this reproduction, not by what the run chose, needs none
      // of its jobs: skipped, or shown under a skipped matrix's unexpanded name. Its run still had
      // to succeed above, which its own qualification job decides.
      const unneeded = new Set(
        lanes === "docs"
          ? []
          : CI_LANES.filter((lane) => !lanes.has(lane)).flatMap(
              (lane) => ("laneJobs" in workflow ? workflow.laneJobs?.[lane] : undefined) ?? [],
            ),
      );
      let requiredJobs: ReadonlyArray<string> = workflow.jobs.filter((name) => !unneeded.has(name));
      if (docs && !fullSucceeded && "docsJobs" in workflow && workflow.docsJobs !== undefined) {
        // The success of this exact job/attempt must contain immutable event-source proof. Mutable
        // run.pull_requests associations cannot establish what its checkout actually tested.
        const matches = jobs.filter((job) => job["name"] === "docs");
        const job = matches[0];
        if (
          !workflow.docsJobs.includes("docs") ||
          matches.length !== 1 ||
          job === undefined ||
          !Number.isSafeInteger(job["id"]) ||
          Number(job["id"]) <= 0 ||
          jobs.filter((candidate) => candidate["id"] === job["id"]).length !== 1 ||
          !jobIdentityMatches(job, run, badge.headRefOid) ||
          job["status"] !== "completed" ||
          job["conclusion"] !== "success"
        )
          throw new Error("Merge CI docs job proof is missing or invalid");
        if (!Array.isArray(job["steps"]) || job["steps"].length > 100)
          throw new Error("Merge CI docs source proof is missing");
        const steps = job["steps"].map(record);
        const sourceSteps = steps.filter((step) => String(step["name"]).startsWith("docs-source"));
        const step = sourceSteps[0];
        const source = step === undefined ? null : SOURCE_STEP.exec(String(step["name"]));
        if (
          sourceSteps.length !== 1 ||
          step === undefined ||
          source === null ||
          source[1] !== badge.baseRefOid ||
          source[2] !== badge.headRefOid ||
          !Number.isSafeInteger(step["number"]) ||
          Number(step["number"]) <= 0 ||
          steps.filter((candidate) => candidate["number"] === step["number"]).length !== 1 ||
          step["status"] !== "completed" ||
          step["conclusion"] !== "success"
        )
          throw new Error("Merge CI docs source differs from the current base/head");
        const commitOut = yield* ghApi(cwd, [`repos/${repo}/git/commits/${source[3]}`]);
        if (commitOut.status !== 0 || commitOut.truncated)
          throw new Error("Merge CI docs merge source lookup failed");
        const commit = json(commitOut.stdout);
        const parents = commit["parents"];
        if (
          commit["sha"] !== source[3] ||
          !Array.isArray(parents) ||
          parents.length !== 2 ||
          record(parents[0])["sha"] !== badge.baseRefOid ||
          record(parents[1])["sha"] !== badge.headRefOid
        )
          throw new Error("Merge CI docs merge parents differ from the current base/head");
        requiredJobs = workflow.docsJobs;
        usedDocs = true;
      }
      for (const name of requiredJobs) {
        const matches = jobs.filter((job) => job["name"] === name);
        if (matches.length === 0) {
          result = "pending";
          continue;
        }
        for (const job of matches) {
          if (!jobIdentityMatches(job, run, badge.headRefOid))
            throw new Error("Merge CI job identity mismatch");
          if (job["status"] !== "completed") result = "pending";
          else if (job["conclusion"] !== "success") return "failing" as const;
        }
      }
    }
    if (usedDocs && result === "passing") {
      // Re-read at the launch boundary after proof/job lookups. --match-head-commit pins only the
      // head; do not claim an atomic base lock across this read and GitHub's eventual merge.
      const freshOut = yield* ghApi(cwd, [`repos/${repo}/pulls/${badge.number}`]);
      if (freshOut.status !== 0 || freshOut.truncated)
        throw new Error("Merge CI docs PR freshness lookup failed");
      const fresh = json(freshOut.stdout);
      const freshHead = record(fresh["head"]);
      const headRepo = record(freshHead["repo"])["full_name"];
      if (
        fresh["number"] !== badge.number ||
        fresh["state"] !== "open" ||
        record(fresh["base"])["sha"] !== badge.baseRefOid ||
        freshHead["sha"] !== badge.headRefOid ||
        freshHead["ref"] !== badge.headRef ||
        typeof headRepo !== "string" ||
        headRepo.toLowerCase() !== repo.toLowerCase()
      )
        throw new Error("Merge CI docs PR base/head or repository changed");
    }
    return result;
  }).pipe(Effect.catchDefect((error) => Effect.fail(new Error(String(error)))));

/**
 * The declared `alwaysJobs` on exactly `badge`'s head: `undefined` when the base declares none. A
 * skipped job counts only once its whole run succeeded, as a lane that rightly skips it does.
 */
const verifyAlwaysJobs = (cwd: string, repo: string, badge: PrStatus) =>
  Effect.gen(function* () {
    if (!exact(badge)) throw new Error("Merge CI needs the exact base, head and branch");
    const policy = yield* readPolicy(cwd, repo, badge.baseRefOid);
    const declared = (policy?.workflows ?? []).filter(
      (workflow) => (workflow.alwaysJobs?.length ?? 0) > 0,
    );
    if (declared.length === 0) return undefined;
    const latest = yield* latestRuns(cwd, repo, badge.headRefOid, badge.headRef);
    let result: ChecksRollup = "passing";
    for (const workflow of declared) {
      const run = latest.get(`${workflow.path}|${workflow.event}`);
      if (run === undefined) {
        result = "pending";
        continue;
      }
      const done = run["status"] === "completed";
      const jobs = yield* runJobs(cwd, repo, run);
      for (const name of workflow.alwaysJobs ?? []) {
        const matches = jobs.filter((job) => job["name"] === name);
        if (matches.length === 0) {
          if (done) return "failing" as const;
          result = "pending";
          continue;
        }
        for (const job of matches) {
          if (!jobIdentityMatches(job, run, badge.headRefOid))
            throw new Error("Merge CI job identity mismatch");
          if (job["status"] !== "completed") result = "pending";
          else if (job["conclusion"] === "skipped") {
            if (!done) result = "pending";
            else if (run["conclusion"] !== "success") return "failing" as const;
          } else if (job["conclusion"] !== "success") return "failing" as const;
        }
      }
    }
    return result;
  }).pipe(Effect.catchDefect((error) => Effect.fail(new Error(String(error)))));

/**
 * The runner evidence a merge launch needs. A solo local check of exactly this head stands in for
 * the declared jobs, except those the base declares `alwaysJobs`; `undefined` when nothing is due.
 */
export const mergeCiForLaunch = (
  cwd: string,
  repo: string,
  badge: PrStatus,
  localCheckHead: string | undefined,
) =>
  localCheckHead !== undefined && localCheckHead === badge.headRefOid
    ? verifyAlwaysJobs(cwd, repo, badge)
    : verifyMergeCi(cwd, repo, badge);
