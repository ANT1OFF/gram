// The Linux build of a stable release, as calls around the Mac build: `startLinuxBuild`
// dispatches .github/workflows/release-linux.yml on main for the release commit (right after the
// preconditions showed HEAD is origin/main), or `adoptLinuxBuild` takes a run already dispatched
// for it; `collectLinuxBuild` waits for that run, reruns its failed jobs when allowed, downloads
// its artifact, checks every file and each attestation, and copies the files into the release's
// assets. Uploading is the release tool's own, with your login: the workflow never writes to a
// release.
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  LINUX_ARTIFACT,
  LINUX_BUILD_INFO,
  LINUX_REPO,
  LINUX_WORKFLOW,
  checkLinuxBuild,
  dispatchArgs,
  matchRun,
  rerunArgs,
  runNonce,
  runProblems,
  verifyAttestations,
} from "./linux-lib.mjs";

const RUN_FIELDS = "databaseId,displayTitle,headSha,headBranch,event,status,conclusion";
const VIEW_FIELDS =
  "databaseId,displayTitle,headSha,headBranch,event,status,conclusion,url,workflowDatabaseId,jobs,attempt";

/** How long a dispatched run may take to show up, and then to finish. */
export const RUN_APPEAR_MS = 10 * 60_000;
export const RUN_FINISH_MS = 90 * 60_000;
export const POLL_MS = 20_000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dispatches the Linux build of `version` from `sha`. Returns what `collectLinuxBuild` needs to
 * find the run again: the nonce its run name carries and when it was asked for.
 */
export function startLinuxBuild({
  gh,
  repo = LINUX_REPO,
  version,
  sha,
  dryRun = false,
  now = Date.now,
}) {
  const nonce = randomBytes(8).toString("hex");
  const r = gh(dispatchArgs({ repo, version, sha, nonce, dryRun }));
  if (r.status !== 0)
    throw new Error(`dispatching ${LINUX_WORKFLOW}: ${(r.stderr || r.stdout).trim()}`);
  return { repo, version, sha, nonce, dryRun, requestedAt: now() };
}

const json = (r, what) => {
  if (r.status !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout);
};

/** A Linux build that didn't come through, naming the run (when one was found) to retry or adopt. */
export class LinuxBuildError extends Error {
  constructor(message, { runId, runUrl } = {}) {
    super(message);
    this.runId = runId;
    this.runUrl = runUrl;
  }
}

const releaseWorkflow = (gh, repo) => {
  const workflow = json(
    gh(["api", `repos/${repo}/actions/workflows/release-linux.yml`]),
    `reading ${LINUX_WORKFLOW}`,
  );
  if (workflow.path !== LINUX_WORKFLOW) throw new Error(`the workflow is ${workflow.path}`);
  return workflow;
};

/**
 * Takes run `runId`, already dispatched for `version` from `sha`, in place of a new dispatch: it
 * must be the release workflow's dispatch on main at `sha`, named as the tooling names one. Whether
 * it ran, failed or is still going is `collectLinuxBuild`'s to find out. A dry run's has no
 * attestation, which `collectLinuxBuild` then refuses.
 */
export function adoptLinuxBuild({ gh, repo = LINUX_REPO, version, sha, runId, now = Date.now }) {
  if (!/^\d+$/.test(String(runId))) throw new Error(`Not a run id: ${runId}`);
  const workflow = releaseWorkflow(gh, repo);
  const view = json(
    gh(["run", "view", String(runId), "--repo", repo, "--json", VIEW_FIELDS]),
    `reading the Linux build's run ${runId}`,
  );
  const nonce = runNonce(view.displayTitle, version);
  const problems = [];
  if (!nonce) problems.push(`it is named "${view.displayTitle}", not as a ${version} release`);
  if (view.event !== "workflow_dispatch") problems.push(`it is a ${view.event} run`);
  if (view.headBranch !== "main") problems.push(`it ran on ${view.headBranch}`);
  if (view.headSha !== sha) problems.push(`it ran at ${view.headSha}, not ${sha}`);
  if (view.workflowDatabaseId !== workflow.id) problems.push(`it isn't ${LINUX_WORKFLOW}'s`);
  if (problems.length)
    throw new Error(`run ${runId} isn't this release's Linux build: ${problems.join("; ")}`);
  return { repo, version, sha, nonce, dryRun: false, runId: view.databaseId, requestedAt: now() };
}

/**
 * Waits for the dispatched (or adopted) run, then downloads and checks what it built into `into`
 * and copies the two packages and LINUX-BUILD.json into `assets`. A run that ends without success
 * gets its failed jobs rerun up to `reruns` times (`gh run rerun --failed`), on the same commit.
 * Throws a LinuxBuildError, with nothing copied, on any problem. Returns
 * `{ runId, runUrl, attempt, files, attestations }`.
 */
export async function collectLinuxBuild(
  build,
  {
    gh,
    into,
    assets,
    say = () => {},
    sleep = sleepFor,
    now = Date.now,
    appearMs = RUN_APPEAR_MS,
    finishMs = RUN_FINISH_MS,
    pollMs = POLL_MS,
    reruns = 0,
  },
) {
  const { repo, version, sha, nonce, dryRun } = build;
  const workflow = releaseWorkflow(gh, repo);

  let runId = build.runId;
  if (runId === undefined) {
    const appearBy = now() + appearMs;
    for (;;) {
      const list = json(
        gh([
          "run",
          "list",
          "--repo",
          repo,
          "--workflow",
          "release-linux.yml",
          "--event",
          "workflow_dispatch",
          "--branch",
          "main",
          "--limit",
          "50",
          "--json",
          RUN_FIELDS,
        ]),
        "listing the Linux build's runs",
      );
      const run = matchRun(list, { version, sha, nonce });
      if (run) {
        runId = run.databaseId;
        break;
      }
      if (now() > appearBy)
        throw new LinuxBuildError(`the dispatched Linux build (${nonce}) never appeared`);
      await sleep(pollMs);
    }
  }
  say(`  linux build: run ${runId}`);

  const viewRun = () =>
    json(
      gh(["run", "view", String(runId), "--repo", repo, "--json", VIEW_FIELDS]),
      "reading the Linux build's run",
    );
  let view;
  let runUrl;
  let left = reruns;
  let after = 0;
  const finishBy = now() + finishMs;
  for (;;) {
    view = viewRun();
    runUrl = view.url;
    // Right after a rerun, the run may still read as the attempt that failed.
    if (view.status === "completed" && (view.attempt ?? 1) > after) {
      if (view.conclusion === "success" || left === 0) break;
      left--;
      after = view.attempt ?? 1;
      say(`  linux build: run ${runId} ended ${view.conclusion}; rerunning its failed jobs`);
      const rerun = gh(rerunArgs({ repo, runId }));
      if (rerun.status !== 0)
        throw new LinuxBuildError(
          `rerunning the Linux build ${runUrl}: ${(rerun.stderr || rerun.stdout).trim()}`,
          { runId, runUrl },
        );
    }
    if (now() > finishBy)
      throw new LinuxBuildError(`the Linux build ${runUrl} didn't finish in time`, {
        runId,
        runUrl,
      });
    await sleep(pollMs);
  }
  const stopWith = (message) => {
    throw new LinuxBuildError(message, { runId, runUrl });
  };
  const problems = runProblems(view, { sha, workflowId: workflow.id, dryRun });
  if (problems.length) stopWith(`the Linux build ${runUrl}: ${problems.join("; ")}`);

  mkdirSync(into, { recursive: true });
  if (readdirSync(into).length) stopWith(`${into} isn't empty`);
  const download = gh([
    "run",
    "download",
    String(runId),
    "--repo",
    repo,
    "--name",
    LINUX_ARTIFACT,
    "--dir",
    into,
  ]);
  if (download.status !== 0)
    stopWith(`downloading the Linux build: ${(download.stderr || download.stdout).trim()}`);
  const checked = await checkLinuxBuild(into, { version, sourceCommit: sha, runId });
  if (checked.problems.length)
    stopWith(`the Linux build ${runUrl}: ${checked.problems.join("; ")}`);
  let attestations = [];
  if (!dryRun) {
    const verified = verifyAttestations(gh, checked.files, { dir: into, repo, sourceCommit: sha });
    if (verified.problems.length) stopWith(verified.problems.join("; "));
    attestations = verified.verified;
  }
  for (const name of [...checked.files.map((file) => file.name), LINUX_BUILD_INFO])
    copyFileSync(join(into, name), join(assets, name));
  return { runId, runUrl, attempt: view.attempt ?? 1, files: checked.files, attestations };
}
