// The Linux build of `release:rc --stable`, as two calls around the Mac build: `startLinuxBuild`
// dispatches .github/workflows/release-linux.yml on main for the release commit (right after the
// preconditions showed HEAD is origin/main), and `collectLinuxBuild` waits for that run, downloads
// its artifact, checks every file and each attestation, and copies the files into the release's
// assets. Uploading is the release tool's own `gh release create`, with your login: the workflow
// never writes to a release.
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
  runProblems,
  verifyAttestations,
} from "./linux-lib.mjs";

const RUN_FIELDS = "databaseId,displayTitle,headSha,headBranch,event,status,conclusion";
const VIEW_FIELDS =
  "databaseId,displayTitle,headSha,headBranch,event,status,conclusion,url,workflowDatabaseId,jobs";

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

/**
 * Waits for the dispatched run, then downloads and checks what it built into `into` and copies the
 * two packages and LINUX-BUILD.json into `assets`. Throws, with nothing copied, on any problem.
 * Returns `{ runId, runUrl, files, attestations }`.
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
  },
) {
  const { repo, version, sha, nonce, dryRun } = build;
  const workflow = json(
    gh(["api", `repos/${repo}/actions/workflows/release-linux.yml`]),
    `reading ${LINUX_WORKFLOW}`,
  );
  if (workflow.path !== LINUX_WORKFLOW) throw new Error(`the workflow is ${workflow.path}`);

  let run;
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
    run = matchRun(list, { version, sha, nonce });
    if (run) break;
    if (now() > appearBy) throw new Error(`the dispatched Linux build (${nonce}) never appeared`);
    await sleep(pollMs);
  }
  say(`  linux build: run ${run.databaseId}`);

  let view;
  const finishBy = now() + finishMs;
  for (;;) {
    view = json(
      gh(["run", "view", String(run.databaseId), "--repo", repo, "--json", VIEW_FIELDS]),
      "reading the Linux build's run",
    );
    if (view.status === "completed") break;
    if (now() > finishBy) throw new Error(`the Linux build ${view.url} didn't finish in time`);
    await sleep(pollMs);
  }
  const problems = runProblems(view, { sha, workflowId: workflow.id, dryRun });
  if (problems.length) throw new Error(`the Linux build ${view.url}: ${problems.join("; ")}`);

  mkdirSync(into, { recursive: true });
  if (readdirSync(into).length) throw new Error(`${into} isn't empty`);
  const download = gh([
    "run",
    "download",
    String(run.databaseId),
    "--repo",
    repo,
    "--name",
    LINUX_ARTIFACT,
    "--dir",
    into,
  ]);
  if (download.status !== 0)
    throw new Error(`downloading the Linux build: ${(download.stderr || download.stdout).trim()}`);
  const checked = await checkLinuxBuild(into, {
    version,
    sourceCommit: sha,
    runId: run.databaseId,
  });
  if (checked.problems.length)
    throw new Error(`the Linux build ${view.url}: ${checked.problems.join("; ")}`);
  let attestations = [];
  if (!dryRun) {
    const verified = verifyAttestations(gh, checked.files, { dir: into, repo, sourceCommit: sha });
    if (verified.problems.length) throw new Error(verified.problems.join("; "));
    attestations = verified.verified;
  }
  for (const name of [...checked.files.map((file) => file.name), LINUX_BUILD_INFO])
    copyFileSync(join(into, name), join(assets, name));
  return { runId: run.databaseId, runUrl: view.url, files: checked.files, attestations };
}
