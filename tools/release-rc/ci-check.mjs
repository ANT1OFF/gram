// The release check taken from main's CI instead of rerun on this Mac. `release:rc` runs install,
// scaffold, docs, release metadata and static here either way; the Vitest suite is the part
// that took six to eleven minutes on a shared Mac, and main's push run of
// .github/workflows/check.yml already ran it on the exact release commit, on Linux and on macOS.
// So when that run exists, the release takes it as the evidence once it has concluded success on
// that commit with every job it runs on a main push succeeded (only the docs-only lane, which a
// main push never selects, may skip), `check static` and every shard of `check tests` and
// `macos tests` among them. The run, its attempt and each job's result go into BUILD-INFO.json;
// nothing is skipped without that record.
//
// Everything that runs a process takes it as `gh(args) → { status, stdout, stderr }`, so the
// tests drive these against a synthetic `gh`.

/** The workflow whose main push runs count. */
export const CHECK_WORKFLOW = ".github/workflows/check.yml";

/**
 * The lanes that stand in for the local check: `check static` and every shard of the two Vitest
 * lanes. A name `<lane> i/n` is a shard; all of 1..n must be there.
 */
export const CHECK_LANES = ["check static", "check tests", "macos tests"];

const RUN_FIELDS = "databaseId,headSha,headBranch,event,status,conclusion,createdAt";
const VIEW_FIELDS =
  "databaseId,headSha,headBranch,event,status,conclusion,url,workflowDatabaseId,attempt,jobs";

/**
 * The jobs a main push may skip: `docs` runs only for a docs-only pull request. Any other job
 * that didn't succeed refuses the run.
 */
export const SKIPPABLE_JOBS = new Set(["docs"]);

/** How long the run may take to finish once release:rc reaches it. */
export const CI_FINISH_MS = 60 * 60_000;
export const CI_POLL_MS = 20_000;

const BAD = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Main's check run on the release commit failed, or isn't one: the release must not go on. */
export class CheckRunRefused extends Error {}

const json = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
};

/** The newest push run of `list` (gh run list --json …) on main at `sha`, or undefined. */
export function pickCheckRun(list, sha) {
  return list
    .filter((run) => run.event === "push" && run.headBranch === "main" && run.headSha === sha)
    .toSorted((a, b) => b.databaseId - a.databaseId)[0];
}

/**
 * What a run (`gh run view --json …`) says about the release check on `sha`:
 * `{ problems, pending, jobs }`. `problems` refuse it outright: not main's push run of the check
 * workflow at `sha`, a job that failed or was cancelled, a required job skipped, a lane or shard
 * missing, or a finished run that didn't conclude success. `pending` names what still runs: the
 * jobs not done, or the run itself. `jobs` are every job with its result, once the run concluded
 * success and nothing refuses it.
 */
export function checkRunState(view, { sha, workflowId }) {
  const problems = [];
  if (view.event !== "push") problems.push(`it is a ${view.event} run`);
  if (view.headBranch !== "main") problems.push(`it ran on ${view.headBranch}`);
  if (view.headSha !== sha) problems.push(`it ran at ${view.headSha}`);
  if (view.workflowDatabaseId !== workflowId)
    problems.push(
      `it is workflow ${view.workflowDatabaseId}, not ${CHECK_WORKFLOW} (${workflowId})`,
    );
  const done = view.status === "completed";
  const jobs = view.jobs ?? [];
  const pending = [];
  for (const job of jobs) {
    if (BAD.has(job.conclusion)) problems.push(`its job "${job.name}" ended ${job.conclusion}`);
    else if (job.status !== "completed") pending.push(job.name);
    else if (job.conclusion === "skipped" && SKIPPABLE_JOBS.has(job.name)) continue;
    else if (job.conclusion !== "success")
      problems.push(`its job "${job.name}" is ${job.conclusion || job.status}`);
  }
  if (done && view.conclusion !== "success")
    problems.push(`it ended ${view.conclusion || "without a conclusion"}`);
  if (!done && !pending.length) pending.push("the run");
  for (const lane of CHECK_LANES) {
    const own = jobs.filter((job) => job.name === lane || job.name.startsWith(`${lane} `));
    if (own.length === 0) {
      if (done) problems.push(`it has no "${lane}" job`);
      else if (!pending.includes(lane)) pending.push(lane);
      continue;
    }
    const shards = own.map((job) => /^(\d+)\/(\d+)$/.exec(job.name.slice(lane.length + 1)));
    if (lane === "check static") {
      if (own.length !== 1 || own[0].name !== lane)
        problems.push(`its "${lane}" jobs are named ${own.map((job) => job.name).join(", ")}`);
    } else if (shards.includes(null))
      problems.push(`its "${lane}" jobs are named ${own.map((job) => job.name).join(", ")}`);
    else {
      const total = Number(shards[0][2]);
      const seen = shards.map((m) => Number(m[1])).toSorted((a, b) => a - b);
      if (
        shards.some((m) => Number(m[2]) !== total) ||
        JSON.stringify(seen) !== JSON.stringify(Array.from({ length: total }, (_, i) => i + 1))
      )
        problems.push(`its "${lane}" shards are ${own.map((job) => job.name).join(", ")}`);
    }
  }
  if (problems.length) return { problems, pending: [], jobs: [] };
  if (pending.length) return { problems, pending, jobs: [] };
  return {
    problems,
    pending,
    jobs: jobs.map(({ name, conclusion }) => ({ name, conclusion })),
  };
}

/**
 * Finds main's push run of the check workflow at `sha`. Returns `{ workflowId, runId, url }`, or
 * undefined when there is none (yet). Throws CheckRunRefused when the one there already failed,
 * and a plain Error when GitHub couldn't be asked.
 */
export function findCheckRun({ gh, repo, sha }) {
  const workflow = json(
    gh(["api", `repos/${repo}/actions/workflows/check.yml`]),
    `reading ${CHECK_WORKFLOW}`,
  );
  if (workflow.path !== CHECK_WORKFLOW) throw new Error(`the workflow is ${workflow.path}`);
  const list = json(
    gh([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "check.yml",
      "--event",
      "push",
      "--branch",
      "main",
      "--commit",
      sha,
      "--limit",
      "20",
      "--json",
      RUN_FIELDS,
    ]),
    "listing main's check runs",
  );
  const run = pickCheckRun(list, sha);
  if (!run) return undefined;
  const view = viewRun(gh, repo, run.databaseId);
  const { problems } = checkRunState(view, { sha, workflowId: workflow.id });
  if (problems.length)
    throw new CheckRunRefused(`main's check run ${view.url}: ${problems.join("; ")}`);
  return { workflowId: workflow.id, runId: run.databaseId, url: view.url };
}

const viewRun = (gh, repo, runId) =>
  json(
    gh(["run", "view", String(runId), "--repo", repo, "--json", VIEW_FIELDS]),
    "reading main's check run",
  );

/**
 * Waits until the run has concluded success on `sha` with every required job succeeded, and
 * returns the evidence for BUILD-INFO.json:
 * `{ workflow, runId, runAttempt, url, event, branch, sourceCommit, conclusion, jobs }`.
 * Throws as soon as any job fails, or when the run doesn't finish in `finishMs`.
 */
export async function waitForCheckRun(
  { workflowId, runId },
  {
    gh,
    repo,
    sha,
    say = () => {},
    sleep = sleepFor,
    now = Date.now,
    finishMs = CI_FINISH_MS,
    pollMs = CI_POLL_MS,
  },
) {
  const finishBy = now() + finishMs;
  let said = false;
  for (;;) {
    const view = viewRun(gh, repo, runId);
    const { problems, pending, jobs } = checkRunState(view, { sha, workflowId });
    if (problems.length)
      throw new CheckRunRefused(`main's check run ${view.url}: ${problems.join("; ")}`);
    if (!pending.length)
      return {
        workflow: CHECK_WORKFLOW,
        runId: view.databaseId,
        runAttempt: view.attempt ?? 1,
        url: view.url,
        event: "push",
        branch: "main",
        sourceCommit: sha,
        conclusion: view.conclusion,
        jobs,
      };
    if (now() > finishBy)
      throw new Error(`main's check run ${view.url} still runs ${pending.join(", ")}`);
    if (!said) say(`  waiting for main's check run: ${pending.join(", ")}`);
    said = true;
    await sleep(pollMs);
  }
}

/** One line on what the CI evidence covered, for the logs and the draft's build notes. */
export const describeCheckRun = (evidence) => {
  const count = (lane) => evidence.jobs.filter((job) => job.name.startsWith(lane)).length;
  return (
    `main CI run ${evidence.runId} (attempt ${evidence.runAttempt}) concluded success at ` +
    `${evidence.sourceCommit.slice(0, 12)}: ${evidence.jobs.filter((job) => job.conclusion === "success").length} ` +
    `jobs passed, check static, ${count("check tests")} check tests and ${count("macos tests")} ` +
    "macos tests shards among them"
  );
};
