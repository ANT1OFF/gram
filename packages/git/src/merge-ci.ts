import { currentBaseOf, type ChecksRollup, type PrStatus } from "@gram/contracts";
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
      laneJobs: Schema.optionalKey(
        Schema.Struct({
          static: Schema.optionalKey(Names),
          tests: Schema.optionalKey(Names),
          macos: Schema.optionalKey(Names),
          package: Schema.optionalKey(Names),
          e2e: Schema.optionalKey(Names),
        }),
      ),
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
    return object === null
      ? undefined
      : Schema.decodeUnknownSync(Policy)(JSON.parse(String(record(object)["text"])));
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameRepo = (value: unknown, repo: string) =>
  typeof value === "string" && value.toLowerCase() === repo.toLowerCase();

/**
 * Whether `run` is provably `badge`'s own: run from a head in `repo` itself, and for a
 * `pull_request` run, triggered for this PR and no other. A fork's PR, or a second PR from the same
 * branch, can reuse the commit and branch name; a run either of them could own is nobody's evidence.
 */
export const runIsPrs = (run: Record<string, unknown>, repo: string, badge: PrStatus): boolean => {
  const headRepo = run["head_repository"];
  if (!isRecord(headRepo) || !sameRepo(headRepo["full_name"], repo)) return false;
  if (run["event"] === "push") return true;
  const prs = run["pull_requests"];
  if (!Array.isArray(prs) || prs.length !== 1) return false;
  const pr: unknown = prs[0];
  if (!isRecord(pr) || pr["number"] !== badge.number) return false;
  const prBase = pr["base"];
  if (!isRecord(prBase)) return false;
  const baseRepo = prBase["repo"];
  if (!isRecord(baseRepo) || !sameRepo(repoOf(baseRepo), repo)) return false;
  return badge.baseRef === undefined || prBase["ref"] === badge.baseRef;
};

const repoOf = (repository: Record<string, unknown>): string | undefined => {
  const url = repository["url"];
  if (typeof url !== "string") return undefined;
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
  return match?.[1];
};

const latestRuns = (cwd: string, repo: string, badge: ExactBadge) =>
  Effect.gen(function* () {
    const head = badge.headRefOid;
    const runsOut = yield* ghApi(cwd, [
      `repos/${repo}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`,
    ]);
    if (runsOut.status !== 0 || runsOut.truncated)
      throw new Error("Merge CI workflow lookup failed");
    const runs = list(json(runsOut.stdout), "workflow_runs").filter(
      (run) =>
        run["head_sha"] === head &&
        run["head_branch"] === badge.headRef &&
        (run["event"] === "push" || run["event"] === "pull_request") &&
        runIsPrs(run, repo, badge),
    );
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

const runJobs = (cwd: string, repo: string, run: Record<string, unknown>) =>
  Effect.gen(function* () {
    const jobsOut = yield* ghApi(cwd, [
      `repos/${repo}/actions/runs/${run["id"]}/attempts/${run["run_attempt"]}/jobs?per_page=100`,
    ]);
    if (jobsOut.status !== 0 || jobsOut.truncated) throw new Error("Merge CI jobs lookup failed");
    return list(json(jobsOut.stdout), "jobs");
  });

type DeclaredPolicy = typeof Policy.Type;

const verifyAgainst = (
  cwd: string,
  repo: string,
  badge: ExactBadge,
  policy: DeclaredPolicy | undefined,
) =>
  Effect.gen(function* () {
    if (policy === undefined && badge.requiredChecks !== undefined) return "passing" as const;
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
    const latest = yield* latestRuns(cwd, repo, badge);
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
      const fullSucceeded = workflow.jobs.every((name) => {
        const matches = jobs.filter((job) => job["name"] === name);
        return (
          matches.length > 0 &&
          matches.every((job) => job["status"] === "completed" && job["conclusion"] === "success")
        );
      });
      const laneJobs = "laneJobs" in workflow ? workflow.laneJobs : undefined;
      const declared = CI_LANES.flatMap((lane) => laneJobs?.[lane] ?? []);
      if (new Set(declared).size !== declared.length)
        throw new Error("Merge CI policy names a job in more than one lane");
      const needed = new Set(
        lanes === "docs" ? [] : [...lanes].flatMap((lane) => laneJobs?.[lane] ?? []),
      );
      const unneeded = new Set(
        lanes === "docs"
          ? []
          : CI_LANES.filter((lane) => !lanes.has(lane))
              .flatMap((lane) => laneJobs?.[lane] ?? [])
              .filter((name) => !needed.has(name)),
      );
      let requiredJobs: ReadonlyArray<string> = workflow.jobs.filter((name) => !unneeded.has(name));
      if (docs && !fullSucceeded && "docsJobs" in workflow && workflow.docsJobs !== undefined) {
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
  });

export const verifyMergeCi = (cwd: string, repo: string, badge: PrStatus) =>
  Effect.gen(function* () {
    if (!exact(badge)) throw new Error("Merge CI needs the exact base, head and branch");
    const policy = yield* readPolicy(cwd, repo, currentBaseOf(badge) ?? badge.baseRefOid);
    return yield* verifyAgainst(cwd, repo, badge, policy);
  }).pipe(Effect.catchDefect((error) => Effect.fail(new Error(String(error)))));

const confirmUnmoved = (cwd: string, repo: string, badge: ExactBadge) =>
  Effect.gen(function* () {
    const prOut = yield* ghApi(cwd, [`repos/${repo}/pulls/${badge.number}`]);
    if (prOut.status !== 0 || prOut.truncated)
      throw new Error("Merge CI PR freshness lookup failed");
    const pr = json(prOut.stdout);
    const prHead = record(pr["head"]);
    const prBase = record(pr["base"]);
    if (
      pr["number"] !== badge.number ||
      pr["state"] !== "open" ||
      prHead["sha"] !== badge.headRefOid ||
      prHead["ref"] !== badge.headRef ||
      badge.baseRef === undefined ||
      prBase["ref"] !== badge.baseRef
    )
      throw new Error("Merge CI PR head or base branch changed");
    const tipOut = yield* ghApi(cwd, [
      `repos/${repo}/commits/${encodeURIComponent(`heads/${badge.baseRef}`)}`,
    ]);
    if (tipOut.status !== 0 || tipOut.truncated) throw new Error("Merge CI base tip lookup failed");
    if (json(tipOut.stdout)["sha"] !== (currentBaseOf(badge) ?? badge.baseRefOid))
      throw new Error("Merge CI base moved during its verification");
  });

/**
 * The CI the base branch's tip declares, on exactly `badge`'s head, with no other evidence in its
 * place: neither GitHub's check contexts nor a local check. `declared: false` when the base
 * declares none, which never qualifies a merge that needs a declaration. A pass is confirmed
 * against a last read of the PR and its base's tip: a retarget, a push or a moved base refuses it.
 */
export const verifyDeclaredMergeCi = (cwd: string, repo: string, badge: PrStatus) =>
  Effect.gen(function* () {
    if (!exact(badge)) throw new Error("Merge CI needs the exact base, head and branch");
    const policy = yield* readPolicy(cwd, repo, currentBaseOf(badge) ?? badge.baseRefOid);
    if (policy === undefined) return { declared: false } as const;
    const checks = yield* verifyAgainst(cwd, repo, badge, policy);
    if (checks === "passing") yield* confirmUnmoved(cwd, repo, badge);
    return { declared: true, checks } as const;
  }).pipe(Effect.catchDefect((error) => Effect.fail(new Error(String(error)))));

const verifyAlwaysJobs = (cwd: string, repo: string, badge: PrStatus) =>
  Effect.gen(function* () {
    if (!exact(badge)) throw new Error("Merge CI needs the exact base, head and branch");
    const policy = yield* readPolicy(cwd, repo, currentBaseOf(badge) ?? badge.baseRefOid);
    const declared = (policy?.workflows ?? []).filter(
      (workflow) => (workflow.alwaysJobs?.length ?? 0) > 0,
    );
    if (declared.length === 0) return undefined;
    const latest = yield* latestRuns(cwd, repo, badge);
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

/**
 * `badge` with the CI evidence its merge launch needs. With `declaredCi`, the base's declared CI
 * alone: `mergeCiDeclared` says whether the base declares any, and `mergeChecks` is pending if not.
 * Otherwise as `mergeCiForLaunch` reads it.
 */
export const withLaunchCi = (
  cwd: string,
  repo: string,
  badge: PrStatus,
  options: {
    readonly localCheckHead?: string | undefined;
    readonly declaredCi?: boolean | undefined;
  },
) =>
  Effect.gen(function* () {
    if (options.declaredCi === true) {
      const declared = yield* verifyDeclaredMergeCi(cwd, repo, badge);
      return {
        ...badge,
        mergeChecks: declared.declared ? declared.checks : "pending",
        mergeCiDeclared: declared.declared,
      } satisfies PrStatus;
    }
    const mergeChecks = yield* mergeCiForLaunch(cwd, repo, badge, options.localCheckHead);
    return mergeChecks === undefined ? badge : { ...badge, mergeChecks };
  });
